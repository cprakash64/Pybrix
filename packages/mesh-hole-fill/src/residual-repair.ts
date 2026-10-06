import { retriangulateSite, type RetriangulationResult } from './link-retriangulation';
import {
  resolveSearchConfig,
  runPinchSearch,
  type PinchOperation,
  type PinchSearchOptions,
} from './pinch-search';
import { WorkLimitReached, type RepairWorkMeter } from './repair-work-budget';
import {
  liveFanCount,
  SurgeryRefusal,
  type SurgeryAccept,
  type SurgeryMesh,
  type SurgeryRefusalRecord,
} from './surgery-mesh';
import { resolveComponentWinding, type WindingResolution } from './winding-resolution';

/**
 * THE RESIDUAL PHASE: bounded repair families, applied ONLY to sites the primary search has
 * already refused (REPAIR-CORE-05E, ported in REPAIR-CORE-06A).
 *
 * WHY A SEPARATE PHASE. The primary driver visits sites in vertex order and every commit changes
 * what the later sites see. A fallback inside that loop would let a refused site's repair alter
 * the neighbourhood of a site the primary search repairs a moment later, and a site accepted
 * today could then come out differently. Running the residual phase AFTER the primary search has
 * finished makes the guarantee structural: every operation the primary search made is already
 * committed before this function is called. (The residual phase may still REBUILD faces a primary
 * repair added, when a refused neighbour's star includes them; the invariant is that the FINAL
 * candidate is valid, not that every earlier patch is byte-identical forever.)
 *
 * ROUNDS. One round resolves winding for any refused chain site, tries link retriangulation on
 * each still-refused site (ascending vertex id), then hands everything still refused back to the
 * UNCHANGED primary search, because removing a fan or resolving a winding can make its own
 * reconstruction feasible. It stops when a round makes no operation, at `DEFAULT_RESIDUAL_ROUNDS`,
 * or when the residual work meter reaches its limit.
 */
export interface ResidualOperation {
  readonly vertex: number;
  readonly family: 'link-retriangulation' | 'primary-after-residual';
  readonly round: number;
  readonly removedFaces: readonly number[];
  readonly addedFaces: readonly number[];
  readonly retriangulation?: RetriangulationResult;
  readonly pinch?: PinchOperation;
}

/** A winding resolution is not a pinch repair: it reverses winding only, and is reported on its own. */
export interface WindingResolutionRecord extends WindingResolution {
  readonly vertex: number;
  readonly round: number;
}

export interface ResidualResult {
  readonly operations: readonly ResidualOperation[];
  readonly windingResolutions: readonly WindingResolutionRecord[];
  /** Sites still refused after the residual phase. */
  readonly refusals: readonly SurgeryRefusalRecord[];
  readonly rounds: number;
  /** Set when the residual work meter stopped the phase at a safe point. */
  readonly limit: WorkLimitReached | undefined;
  /** True when the caller's cancellation stopped the phase. */
  readonly cancelled: boolean;
}

export const DEFAULT_RESIDUAL_ROUNDS = 6;

export interface ResidualOptions {
  readonly search: PinchSearchOptions;
  readonly accept: SurgeryAccept;
  readonly meter?: RepairWorkMeter;
  readonly cancelled?: () => boolean;
  readonly maxRounds?: number;
}

export function runResidualRepair(
  mesh: SurgeryMesh,
  refused: readonly SurgeryRefusalRecord[],
  options: ResidualOptions,
): ResidualResult {
  const meter = options.meter;
  const cfg = resolveSearchConfig(options.search);
  const searchOptions: PinchSearchOptions = {
    ...options.search,
    accept: options.accept,
    ...(meter === undefined ? {} : { meter }),
    ...(options.cancelled === undefined ? {} : { cancelled: options.cancelled }),
  };
  const operations: ResidualOperation[] = [];
  const windingResolutions: WindingResolutionRecord[] = [];
  const resolvedComponents = new Set<number>();
  const remaining = new Map<number, SurgeryRefusalRecord>();
  for (const r of refused) remaining.set(r.vertex, r);
  let rounds = 0;
  let limit: WorkLimitReached | undefined;
  let cancelled = false;
  const maxRounds = options.maxRounds ?? DEFAULT_RESIDUAL_ROUNDS;
  try {
    for (let round = 1; round <= maxRounds && remaining.size > 0; round += 1) {
      rounds = round;
      let progress = 0;
      // Oriented-chain refusals first: a winding conflict at the vertex blocks every other family.
      for (const [vertex, record] of [...remaining.entries()].sort((a, b) => a[0] - b[0])) {
        if (record.reason !== SurgeryRefusal.InconsistentFan) continue;
        if (options.cancelled?.() === true) {
          cancelled = true;
          break;
        }
        const start = mesh.facesAt(vertex).find((f) => mesh.alive[f] === 1);
        if (start === undefined) continue;
        const resolution = resolveComponentWinding(mesh, start, undefined, meter);
        if (resolvedComponents.has(resolution.seedFace)) continue;
        windingResolutions.push({ ...resolution, vertex, round });
        resolvedComponents.add(resolution.seedFace);
        if (resolution.outcome === 'resolved') {
          for (const f of resolution.flips) mesh.flipFace(f);
          progress += 1;
        }
      }
      if (cancelled) break;
      for (const vertex of [...remaining.keys()].sort((a, b) => a - b)) {
        if (options.cancelled?.() === true) {
          cancelled = true;
          break;
        }
        if (liveFanCount(mesh, vertex) < 2) {
          remaining.delete(vertex);
          continue;
        }
        options.search.acceptReads?.reset();
        const r = retriangulateSite(mesh, vertex, cfg, options.accept, meter);
        if (!('fanIndices' in r)) continue;
        progress += 1;
        operations.push({
          vertex,
          family: 'link-retriangulation',
          round,
          removedFaces: r.removedFaces,
          addedFaces: r.addedFaces,
          retriangulation: r,
        });
        if (liveFanCount(mesh, vertex) < 2) remaining.delete(vertex);
      }
      if (cancelled || remaining.size === 0) break;
      // The primary search gets another look at everything still refused: the neighbourhoods moved.
      const again = runPinchSearch(mesh, [...remaining.keys()], searchOptions);
      for (const op of again.operations) {
        progress += 1;
        remaining.delete(op.vertex);
        operations.push({
          vertex: op.vertex,
          family: 'primary-after-residual',
          round,
          removedFaces: op.removedFaces,
          addedFaces: op.addedFaces,
          pinch: op,
        });
      }
      for (const r of again.refusals) remaining.set(r.vertex, r);
      if (again.cancelled) {
        cancelled = true;
        break;
      }
      if (again.limit !== undefined) {
        limit = again.limit;
        break;
      }
      if (progress === 0) break;
    }
  } catch (error) {
    // A limit raised between two reconstructions: the mesh is as it was, or holds only complete,
    // validated operations. Nothing here is half done.
    if (!(error instanceof WorkLimitReached)) throw error;
    limit = error;
  }
  return {
    operations,
    windingResolutions,
    refusals: [...remaining.values()],
    rounds,
    limit,
    cancelled,
  };
}
