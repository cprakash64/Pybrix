import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { PatchNarrowphase } from './contract';
import { buildFanTopology, classifyPinch, planLocalRepair } from './pinch-topology';
import {
  runPinchSearch,
  type PinchOperation,
  type PinchProgress,
  type PinchSearchOptions,
} from './pinch-search';
import {
  createWorkMeter,
  RepairWorkPhase,
  type RepairWorkCounters,
  type RepairWorkMeter,
} from './repair-work-budget';
import { runResidualRepair, type WindingResolutionRecord } from './residual-repair';
import { createSurgeryGate, type GateStats } from './surgery-gate';
import {
  liveFanCount,
  SurgeryMesh,
  SurgeryRefusal,
  type SurgeryPatch,
  type SurgeryRefusalRecord,
} from './surgery-mesh';

/**
 * LOCAL REPAIR — the orchestration of the primary pinch search and the bounded residual phase
 * (REPAIR-CORE-06A). The only entry point the repair worker needs from this package.
 *
 *   1. find the pinched vertices (read-only, exact-coordinate topology);
 *   2. PRIMARY: the LS-A2 / LS-B search on every vertex it can separate by movement;
 *   3. RESIDUAL, only when the primary phase finished within its budget and refused something:
 *      component winding resolution and link retriangulation, then the unchanged primary search
 *      again on whatever is still refused;
 *   4. describe the result as a PATCH over the source mesh, in the source's own slot space.
 *
 * Both phases charge their OWN deterministic work meter. A meter that reaches its limit stops its
 * phase at a safe point; whatever was already installed is complete and validated, so the patch is
 * always a consistent candidate. A limit is a typed outcome, never an error.
 */

export const LocalRepairKind = {
  /** Every supported hard topology defect that was detected is repaired. */
  Complete: 'complete',
  /** Some defect class cannot safely be repaired (structure the engine does not handle). */
  PartialUnsupported: 'partial_unsupported',
  /** The automatic repair work budget was exhausted. */
  PartialLimit: 'partial_limit',
  /** Repairing what remains would require guessing geometric intent. */
  PartialAmbiguous: 'partial_ambiguous',
  /** No safe supported repair exists, so there is nothing to apply. */
  NoChange: 'no_change',
} as const;
export type LocalRepairKind = (typeof LocalRepairKind)[keyof typeof LocalRepairKind];

export interface LocalRepairLimits {
  /** Work units for the primary search; undefined = unmetered (measurement runs only). */
  readonly primary: number | undefined;
  /** Work units for the residual phase; undefined = unmetered (measurement runs only). */
  readonly residual: number | undefined;
}

export interface LocalRepairInput {
  readonly mesh: CanonicalMesh;
  /** The exact narrowphase. A fresh one is requested per classification and always ended. */
  readonly makeNarrowphase: () => PatchNarrowphase;
  readonly limits: LocalRepairLimits;
  /** Polled between sites and rounds; true stops the repair and returns `cancelled`. */
  readonly cancelled?: () => boolean;
  readonly onProgress?: (progress: LocalRepairProgress) => void;
  /** Brute-force audit of the broadphase on every gate call. Qualification only. */
  readonly audit?: boolean;
  /** Overrides for the search constants. Qualification only; the product passes none. */
  readonly search?: Omit<
    PinchSearchOptions,
    'accept' | 'meter' | 'cancelled' | 'onProgress' | 'acceptReads'
  >;
}

export interface LocalRepairProgress {
  readonly phase: 'topology' | 'primary' | 'residual';
  readonly attempted: number;
  readonly total: number;
  readonly repaired: number;
  /** Work units charged so far, by phase: lets a caller see the cost curve as it happens. */
  readonly primaryWorkUnits: number;
  readonly residualWorkUnits: number;
}

export interface WorkReport {
  readonly phase: RepairWorkPhase;
  readonly used: number;
  readonly limit: number | undefined;
  readonly counters: RepairWorkCounters;
}

export interface LocalRepairCounts {
  /** Pinched vertices the search can attempt (no non-manifold edge at them). */
  readonly eligible: number;
  /** Pinched vertices a non-manifold edge makes unseparable by movement: never attempted. */
  readonly unsupportedNonManifoldEdge: number;
  /** Distinct vertices no longer pinched after the repair. */
  readonly repaired: number;
  /** Eligible vertices still pinched. */
  readonly remaining: number;
  /** Remaining vertices never attempted because a limit stopped the run first. */
  readonly unattempted: number;
  readonly byClass: Readonly<Record<string, { eligible: number; repaired: number }>>;
  /** Why the remaining refused sites were refused, by the engine's own reason. */
  readonly remainingByReason: Readonly<Record<string, number>>;
}

export interface WindingResolutionSummary {
  readonly vertex: number;
  readonly round: number;
  readonly outcome: WindingResolutionRecord['outcome'];
  readonly componentFaces: number;
  readonly seedFace: number;
  readonly flips: number;
}

export interface LocalRepairResidualReport {
  readonly ran: boolean;
  readonly skippedBecause: 'nothing-refused' | 'primary-limit' | 'cancelled' | undefined;
  readonly linkRetriangulations: number;
  readonly primaryAfterResidual: number;
  readonly windingResolutions: readonly WindingResolutionSummary[];
  readonly rounds: number;
}

export interface LocalRepairResult {
  readonly kind: LocalRepairKind;
  readonly cancelled: boolean;
  /** Undefined when nothing changed. Applies to `input.mesh`. */
  readonly patch: SurgeryPatch | undefined;
  readonly counts: LocalRepairCounts;
  readonly operations: readonly PinchOperation[];
  readonly residual: LocalRepairResidualReport;
  readonly work: { readonly primary: WorkReport; readonly residual: WorkReport };
  /** Which budget stopped the repair, when one did. */
  readonly limitReached: RepairWorkPhase | undefined;
  readonly gate: GateStats;
}

function report(meter: RepairWorkMeter): WorkReport {
  return {
    phase: meter.phase,
    used: meter.used(),
    limit: meter.limit,
    counters: meter.counters(),
  };
}

const AMBIGUOUS_REASONS: ReadonlySet<string> = new Set([
  SurgeryRefusal.Rejected,
  SurgeryRefusal.NoUsableDirection,
  SurgeryRefusal.RegionOverlap,
]);

export function runLocalRepair(input: LocalRepairInput): LocalRepairResult {
  const { mesh } = input;
  const primaryMeter = createWorkMeter(RepairWorkPhase.Primary, input.limits.primary);
  const residualMeter = createWorkMeter(RepairWorkPhase.Residual, input.limits.residual);
  input.onProgress?.({
    phase: 'topology',
    attempted: 0,
    total: 0,
    repaired: 0,
    primaryWorkUnits: 0,
    residualWorkUnits: 0,
  });
  const topology = buildFanTopology(mesh, {
    poll: (): void => undefined,
  });
  const plan = planLocalRepair(topology);
  const classOf = new Map<number, string>();
  const targets: number[] = [];
  const eligibleByClass: Record<string, { eligible: number; repaired: number }> = {};
  for (const v of topology.pinched) {
    if (v.nonManifoldEdge) continue;
    const cls = classifyPinch(v, topology);
    classOf.set(v.vertex, cls);
    targets.push(v.vertex);
    const row = eligibleByClass[cls] ?? { eligible: 0, repaired: 0 };
    row.eligible += 1;
    eligibleByClass[cls] = row;
  }

  const live = SurgeryMesh.from(mesh);
  const gate = createSurgeryGate(input.makeNarrowphase, live, {
    audit: input.audit === true,
  });
  const search: PinchSearchOptions = {
    ...input.search,
    accept: gate.accept,
    acceptReads: gate.reads,
    ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
  };
  const emit =
    (phase: 'primary' | 'residual') =>
    (p: PinchProgress): void => {
      input.onProgress?.({
        phase,
        attempted: p.attempted,
        total: p.total,
        repaired: p.accepted,
        primaryWorkUnits: primaryMeter.used(),
        residualWorkUnits: residualMeter.used(),
      });
    };

  // PRIMARY.
  const primary = runPinchSearch(live, targets, {
    ...search,
    meter: primaryMeter,
    onProgress: emit('primary'),
  });
  const operations: PinchOperation[] = [...primary.operations];

  // RESIDUAL — only when the primary phase completed within budget and something is refused.
  let residualRan = false;
  let skippedBecause: LocalRepairResidualReport['skippedBecause'];
  let linkRetriangulations = 0;
  let primaryAfterResidual = 0;
  let windingResolutions: LocalRepairResidualReport['windingResolutions'] = [];
  let rounds = 0;
  let remaining: SurgeryRefusalRecord[] = [...primary.refusals];
  let limitReached: RepairWorkPhase | undefined;
  let cancelled = primary.cancelled;
  if (primary.limit !== undefined) {
    limitReached = RepairWorkPhase.Primary;
    skippedBecause = 'primary-limit';
  } else if (primary.cancelled) {
    skippedBecause = 'cancelled';
  } else if (primary.refusals.length === 0) {
    skippedBecause = 'nothing-refused';
  } else {
    residualRan = true;
    const residual = runResidualRepair(live, primary.refusals, {
      search,
      accept: gate.accept,
      meter: residualMeter,
      ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
    });
    remaining = [...residual.refusals];
    rounds = residual.rounds;
    cancelled = residual.cancelled;
    if (residual.limit !== undefined) limitReached = RepairWorkPhase.Residual;
    for (const op of residual.operations) {
      if (op.family === 'link-retriangulation') linkRetriangulations += 1;
      else primaryAfterResidual += 1;
      if (op.pinch !== undefined) operations.push(op.pinch);
    }
    windingResolutions = residual.windingResolutions.map((w) => ({
      vertex: w.vertex,
      round: w.round,
      outcome: w.outcome,
      componentFaces: w.componentFaces,
      seedFace: w.seedFace,
      flips: w.flips.length,
    }));
  }

  // What is still pinched, counted from the live mesh rather than inferred from records.
  const stillPinched = new Set<number>();
  for (const vertex of targets) if (liveFanCount(live, vertex) >= 2) stillPinched.add(vertex);
  const remainingByReason: Record<string, number> = {};
  const refusedVertices = new Set<number>();
  for (const r of remaining) {
    if (!stillPinched.has(r.vertex)) continue;
    refusedVertices.add(r.vertex);
    remainingByReason[r.reason] = (remainingByReason[r.reason] ?? 0) + 1;
  }
  const attemptedFirstPass = new Set<number>(primary.unattempted);
  let unattempted = 0;
  for (const vertex of stillPinched) {
    if (refusedVertices.has(vertex)) continue;
    if (attemptedFirstPass.has(vertex) || limitReached !== undefined || cancelled) unattempted += 1;
  }
  for (const vertex of targets) {
    if (stillPinched.has(vertex)) continue;
    const cls = classOf.get(vertex);
    if (cls !== undefined) {
      const row = eligibleByClass[cls];
      if (row !== undefined) row.repaired += 1;
    }
  }
  const remainingCount = stillPinched.size;
  const counts: LocalRepairCounts = {
    eligible: plan.eligible,
    unsupportedNonManifoldEdge: plan.unsupportedNonManifoldEdge,
    repaired: plan.eligible - remainingCount,
    remaining: remainingCount,
    unattempted,
    byClass: eligibleByClass,
    remainingByReason,
  };

  const patch = live.describePatch();
  const changed =
    patch.removedSourceFaces.length > 0 ||
    patch.flippedSourceFaces.length > 0 ||
    patch.appendedFaces.length > 0;

  let kind: LocalRepairKind;
  if (limitReached !== undefined) kind = LocalRepairKind.PartialLimit;
  else if (!changed) kind = LocalRepairKind.NoChange;
  else if (remainingCount === 0 && plan.unsupportedNonManifoldEdge === 0) {
    kind = LocalRepairKind.Complete;
  } else {
    const unsupported =
      plan.unsupportedNonManifoldEdge > 0 ||
      Object.keys(remainingByReason).some((reason) => !AMBIGUOUS_REASONS.has(reason));
    kind = unsupported ? LocalRepairKind.PartialUnsupported : LocalRepairKind.PartialAmbiguous;
  }
  input.onProgress?.({
    phase: residualRan ? 'residual' : 'primary',
    attempted: operations.length,
    total: plan.eligible,
    repaired: counts.repaired,
    primaryWorkUnits: primaryMeter.used(),
    residualWorkUnits: residualMeter.used(),
  });

  return {
    kind,
    cancelled,
    patch: changed ? patch : undefined,
    counts,
    operations,
    residual: {
      ran: residualRan,
      skippedBecause,
      linkRetriangulations,
      primaryAfterResidual,
      windingResolutions,
      rounds,
    },
    work: { primary: report(primaryMeter), residual: report(residualMeter) },
    limitReached,
    gate: gate.stats,
  };
}
