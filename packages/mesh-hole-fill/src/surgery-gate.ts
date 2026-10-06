import { AppendedFaceIndex } from './appended-face-index';
import { createCounters, FaceBvh, type BroadphaseBudget } from './bvh';
import type { PatchNarrowphase } from './contract';
import type { RepairWorkMeter } from './repair-work-budget';
import type { SurgeryAccept, SurgeryMesh } from './surgery-mesh';

/**
 * THE EXACT GATE FOR LOCAL REPAIR — the exact Geogram narrowphase applied to a local surgery's FINISHED candidate:
 * the added faces against every spatially relevant face of the live mesh with
 * the operation applied, and the removed faces against the same region as the
 * baseline. Enumeration is a broadphase over the source plus a side list for
 * faces earlier operations added, and it is audited against a brute-force scan of
 * every alive face on every call.
 */

const UNLIMITED: BroadphaseBudget = {
  maxNodeVisits: Number.MAX_SAFE_INTEGER,
  maxAabbTests: Number.MAX_SAFE_INTEGER,
  maxCandidates: Number.MAX_SAFE_INTEGER,
};

type Box = readonly [number, number, number, number, number, number];

/** Flat corner triples (9 numbers) for one face of a live mesh. */
export function liveCorners(mesh: SurgeryMesh, face: number): number[] {
  const out: number[] = [];
  for (const v of mesh.corners(face)) {
    out.push(mesh.pos[v * 3] ?? 0, mesh.pos[v * 3 + 1] ?? 0, mesh.pos[v * 3 + 2] ?? 0);
  }
  return out;
}

function boxOfCorners(c: readonly number[]): Box {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 3; k += 1) {
    for (let a = 0; a < 3; a += 1) {
      const x = c[k * 3 + a] ?? 0;
      if (x < (lo[a] ?? Infinity)) lo[a] = x;
      if (x > (hi[a] ?? -Infinity)) hi[a] = x;
    }
  }
  return [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0, hi[0] ?? 0, hi[1] ?? 0, hi[2] ?? 0];
}

function meets(a: Box, b: Box): boolean {
  return (
    a[0] <= b[3] && b[0] <= a[3] && a[1] <= b[4] && b[1] <= a[4] && a[2] <= b[5] && b[2] <= a[5]
  );
}

export interface PairClassification {
  /** Indices into `region` that are invalid against at least one patch face. */
  readonly invalidRegion: Set<number>;
  /** Invalid patch-vs-patch pairs. */
  readonly invalidPatchPatch: number;
  readonly tested: number;
  readonly complete: boolean;
}

/** Exact classification of every box-overlapping (patch, region) and (patch, patch) pair. */
/** REPAIR-CORE-05D: where the exact classification spends its time (module-wide totals). */
/**
 * REPAIR-CORE-05D-2: assigns a dense id to each DISTINCT coordinate triple, in order of first
 * appearance. This replaced a `Map` keyed by `${x},${y},${z}`: the string key was ~10 % of the
 * whole surgery on X12 and is the same equivalence relation, because `String(n)` is injective on
 * finite doubles and `x + 0` already folded -0 into +0. Here the key is the 64-bit pattern of the
 * three normalised doubles. Meshes are validated finite before they get here (a NaN would have
 * been one id under the string key and may be several under bit patterns).
 */
export class CoordinateInterner {
  private slots = new Int32Array(1024).fill(-1);
  private mask = 1023;
  private readonly scratch = new Float64Array(3);
  private readonly bits = new Uint32Array(this.scratch.buffer);
  /** x, y, z of every distinct triple, in id order. */
  public coords: number[] = [];

  private hash(): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < 6; i += 1) {
      h = Math.imul(h ^ (this.bits[i] ?? 0), 0x01000193);
      h ^= h >>> 15;
    }
    return h >>> 0;
  }

  private grow(): void {
    const old = this.slots;
    this.slots = new Int32Array(old.length * 2).fill(-1);
    this.mask = this.slots.length - 1;
    for (let id = 0; id < this.coords.length / 3; id += 1) {
      this.scratch[0] = this.coords[id * 3] ?? 0;
      this.scratch[1] = this.coords[id * 3 + 1] ?? 0;
      this.scratch[2] = this.coords[id * 3 + 2] ?? 0;
      let slot = this.hash() & this.mask;
      while ((this.slots[slot] ?? -1) !== -1) slot = (slot + 1) & this.mask;
      this.slots[slot] = id;
    }
  }

  public intern(x: number, y: number, z: number): number {
    this.scratch[0] = x + 0;
    this.scratch[1] = y + 0;
    this.scratch[2] = z + 0;
    let slot = this.hash() & this.mask;
    for (;;) {
      const id = this.slots[slot] ?? -1;
      if (id === -1) break;
      if (
        this.coords[id * 3] === this.scratch[0] &&
        this.coords[id * 3 + 1] === this.scratch[1] &&
        this.coords[id * 3 + 2] === this.scratch[2]
      ) {
        return id;
      }
      slot = (slot + 1) & this.mask;
    }
    const id = this.coords.length / 3;
    this.coords.push(this.scratch[0], this.scratch[1], this.scratch[2]);
    this.slots[slot] = id;
    if (this.coords.length / 3 > (this.mask + 1) / 2) this.grow();
    return id;
  }
}

/** The one-call-per-region-face classification: the oracle and the exact fallback. */
export function classifyTriangles(
  makeNarrowphase: () => PatchNarrowphase,
  region: readonly (readonly number[])[],
  patch: readonly (readonly number[])[],
  regionPairs: readonly (readonly [number, number])[],
): PairClassification {
  const interner = new CoordinateInterner();
  const triangles: number[] = [];
  const push = (t: readonly number[]): void => {
    for (let k = 0; k < 3; k += 1)
      triangles.push(interner.intern(t[k * 3] ?? 0, t[k * 3 + 1] ?? 0, t[k * 3 + 2] ?? 0));
  };
  for (const t of region) push(t);
  for (const t of patch) push(t);
  const coords = interner.coords;
  const narrowphase = makeNarrowphase();
  narrowphase.begin({
    positions: Float64Array.from(coords),
    triangles: Uint32Array.from(triangles),
    patchFaceStart: region.length,
    maxSamples: 1_000_000,
  });
  const invalidRegion = new Set<number>();
  let invalidPatchPatch = 0;
  let tested = 0;
  let complete = true;
  try {
    // REPAIR-CORE-05D: pairs that share a REGION face are classified in ONE kernel call. The
    // kernel treats pairs independently and returns summed counts, so "some pair of this region
    // face is invalid" and "the batch was complete" are the same facts the one-call-per-pair loop
    // produced; only the per-call overhead (about a dozen WebAssembly calls) is shared.
    const byRegion = new Map<number, number[]>();
    for (const [r, p] of regionPairs) {
      const list = byRegion.get(r);
      if (list === undefined) byRegion.set(r, [p]);
      else list.push(p);
    }
    for (const [r, patches] of byRegion) {
      const batch = new Uint32Array(patches.length * 2);
      patches.forEach((p, i) => {
        batch[i * 2] = region.length + p;
        batch[i * 2 + 1] = r;
      });
      const result = narrowphase.classify(batch, patches.length);
      tested += patches.length;
      if (!result.complete) complete = false;
      if (result.invalidPatchSourcePairs > 0 || result.invalidPatchPatchPairs > 0) {
        invalidRegion.add(r);
      }
    }
    const boxes = patch.map(boxOfCorners);
    const patchPairs: number[] = [];
    for (let a = 0; a < patch.length; a += 1) {
      for (let b = a + 1; b < patch.length; b += 1) {
        if (!meets(boxes[a] ?? [0, 0, 0, 0, 0, 0], boxes[b] ?? [0, 0, 0, 0, 0, 0])) continue;
        patchPairs.push(region.length + a, region.length + b);
      }
    }
    if (patchPairs.length > 0) {
      const count = patchPairs.length / 2;
      const result = narrowphase.classify(Uint32Array.from(patchPairs), count);
      tested += count;
      if (!result.complete) complete = false;
      // One invalid pair raises exactly one of the two counters, so their sum is the pair count.
      invalidPatchPatch += result.invalidPatchSourcePairs + result.invalidPatchPatchPairs;
    }
  } finally {
    narrowphase.end();
  }
  return { invalidRegion, invalidPatchPatch, tested, complete };
}

/**
 * REPAIR-CORE-05D-2: pairs handed to the kernel per call. Measured on 319 recorded queries from
 * D0, X12 and X11: throughput reaches its plateau at 32 pairs per call (515 ms against 596 ms for
 * one call per region face) and does not move up to the whole attempt in one call. 1,024 keeps the
 * uploaded pair buffer at 8 KiB while turning ~450 kernel calls per attempt into about two.
 */
export const CLASSIFY_PAIRS_PER_CALL = 1024;

/**
 * REPAIR-CORE-05D-2: the same classification through the kernel's PER-PAIR output instead of one
 * call per region face. The kernel judges each pair on the two triangles alone, counts are
 * cumulative inside one begin/end, and every invalid pair is reported as (f1, f2, category) —
 * so one call over every pair says exactly which region faces are invalid, how many patch-patch
 * pairs are, and whether any pair could not be classified. `pairsPerCall` bounds each call (it is
 * measured, not assumed: see the kernel batch-size experiment); samples are read once at the end.
 * If the sample list was truncated the per-pair attribution is incomplete, and the legacy path
 * answers instead — an exact fallback, never an approximation.
 */
export function classifyTrianglesBatched(
  makeNarrowphase: () => PatchNarrowphase,
  region: readonly (readonly number[])[],
  patch: readonly (readonly number[])[],
  regionPairs: readonly (readonly [number, number])[],
  pairsPerCall = Number.MAX_SAFE_INTEGER,
): PairClassification {
  const interner = new CoordinateInterner();
  const triangles: number[] = [];
  const push = (t: readonly number[]): void => {
    for (let k = 0; k < 3; k += 1)
      triangles.push(interner.intern(t[k * 3] ?? 0, t[k * 3 + 1] ?? 0, t[k * 3 + 2] ?? 0));
  };
  for (const t of region) push(t);
  for (const t of patch) push(t);
  const narrowphase = makeNarrowphase();
  narrowphase.begin({
    positions: Float64Array.from(interner.coords),
    triangles: Uint32Array.from(triangles),
    patchFaceStart: region.length,
    maxSamples: 1_000_000,
  });
  // The pair list, in the order the per-region-face loop visited it.
  const byRegion = new Map<number, number[]>();
  for (const [r, p] of regionPairs) {
    const list = byRegion.get(r);
    if (list === undefined) byRegion.set(r, [p]);
    else list.push(p);
  }
  const flat: number[] = [];
  for (const [r, patches] of byRegion) for (const p of patches) flat.push(region.length + p, r);
  const boxes = patch.map(boxOfCorners);
  let patchPairCount = 0;
  const regionPairCount = flat.length / 2;
  for (let a = 0; a < patch.length; a += 1) {
    for (let b = a + 1; b < patch.length; b += 1) {
      if (!meets(boxes[a] ?? [0, 0, 0, 0, 0, 0], boxes[b] ?? [0, 0, 0, 0, 0, 0])) continue;
      flat.push(region.length + a, region.length + b);
      patchPairCount += 1;
    }
  }
  let complete = true;
  const sampleState = { truncated: false };
  const invalidRegion = new Set<number>();
  let invalidPatchPatch = 0;
  try {
    const total = flat.length / 2;
    for (let from = 0; from < total; from += pairsPerCall) {
      const count = Math.min(pairsPerCall, total - from);
      const result = narrowphase.classify(
        Uint32Array.from(flat.slice(from * 2, (from + count) * 2)),
        count,
      );
      if (!result.complete) complete = false;
    }
    const sampled = narrowphase.samples();
    sampleState.truncated = sampled.truncated;
    for (let i = 0; i < sampled.samples.length; i += 3) {
      const f1 = sampled.samples[i] ?? 0;
      if (f1 < region.length) invalidRegion.add(f1);
      else invalidPatchPatch += 1;
    }
  } finally {
    narrowphase.end();
  }
  if (sampleState.truncated) return classifyTriangles(makeNarrowphase, region, patch, regionPairs);
  return {
    invalidRegion,
    invalidPatchPatch,
    tested: regionPairCount + patchPairCount,
    complete,
  };
}

/** Counts the gate keeps for reporting and for the qualification audit. Never read back. */
export interface GateStats {
  operations: number;
  rejectedIntersection: number;
  rejectedIncomplete: number;
  rejectedEnumeration: number;
  bruteForcePairs: number;
  broadphasePairs: number;
  missedByBroadphase: number;
  testedPairs: number;
  enumerateCalls: number;
  patchFacesQueried: number;
  /** Loop iterations over faces appended by earlier operations (the side list). */
  sideListIterations: number;
  sideListBoxesBuilt: number;
  sideListLengthMax: number;
  bvhNodeVisits: number;
  bvhCandidates: number;
}

export interface SurgeryGate {
  readonly accept: SurgeryAccept;
  readonly stats: GateStats;
  /** Selects the meter the exact tests' pairs are charged to (the running phase's). */
  readonly useMeter: (meter: RepairWorkMeter | undefined) => void;
  /** The union of every box this gate queried since `reset`. */
  readonly reads: {
    readonly reset: () => void;
    readonly box: () => readonly [number, number, number, number, number, number] | undefined;
  };
}

export interface SurgeryGateOptions {
  /**
   * AUDIT MODE cross-checks the broadphase against a brute-force scan of every alive face on every
   * call and never reuses a baseline. PRODUCT MODE (the default) keeps the same spatial
   * enumeration and the same exact predicate and drops only that redundant scan: the verdict is a
   * function of (found pairs, kernel), neither of which the scan feeds, so the two modes produce
   * byte-identical geometry (checked on the qualification corpus).
   */
  readonly audit?: boolean;
}

/**
 * The injected acceptance gate. The region for a patch is every alive face that is neither removed
 * nor added by THIS operation; baseline and candidate are measured against the same region so the
 * comparison is like for like. A candidate is accepted only when it introduces no invalid pair
 * that the removed faces did not already have, and the exact test completed: an unclassifiable
 * pair FAILS the candidate.
 */
export function createSurgeryGate(
  makeNarrowphase: () => PatchNarrowphase,
  source: SurgeryMesh,
  options: SurgeryGateOptions = {},
): SurgeryGate {
  const audit = options.audit ?? false;
  // The meter the exact tests are charged to: the phase that is currently running.
  let currentMeter: RepairWorkMeter | undefined;
  const sourcePos = source.pos.slice(0, source.sourceVertexCount * 3);
  const sourceTri = Uint32Array.from(source.tri.subarray(0, source.sourceFaceCount * 3));
  const bvh = FaceBvh.build(sourcePos, sourceTri, 0, source.sourceFaceCount);
  // Faces appended by earlier operations are found through an incremental index instead of a walk
  // over every one of them.
  const sideIndex = new AppendedFaceIndex(source.sourceFaceCount);
  const stats: GateStats = {
    operations: 0,
    rejectedIntersection: 0,
    rejectedIncomplete: 0,
    rejectedEnumeration: 0,
    bruteForcePairs: 0,
    broadphasePairs: 0,
    missedByBroadphase: 0,
    testedPairs: 0,
    enumerateCalls: 0,
    patchFacesQueried: 0,
    sideListIterations: 0,
    sideListBoxesBuilt: 0,
    sideListLengthMax: 0,
    bvhNodeVisits: 0,
    bvhCandidates: 0,
  };

  const enumerate = (
    mesh: SurgeryMesh,
    patchFaces: readonly number[],
    skip: ReadonlySet<number>,
  ): {
    regionFaces: number[];
    pairs: [number, number][];
    brute: Set<string>;
    found: Set<string>;
  } => {
    // Faces below the first tentative face are committed history; index them (alive or not).
    let limit = mesh.faceCount;
    for (const f of skip) if (f < limit) limit = f;
    sideIndex.sync(mesh.pos, mesh.tri, limit);
    const patchBoxes = patchFaces.map((f) => boxOfCorners(liveCorners(mesh, f)));
    const regionIndex = new Map<number, number>();
    const regionFaces: number[] = [];
    const pairs: [number, number][] = [];
    const found = new Set<string>();
    const note = (face: number, p: number): void => {
      let r = regionIndex.get(face);
      if (r === undefined) {
        r = regionFaces.length;
        regionIndex.set(face, r);
        regionFaces.push(face);
      }
      pairs.push([r, p]);
      found.add(`${String(face)}|${String(p)}`);
    };
    const counters = createCounters();
    stats.enumerateCalls += 1;
    stats.sideListLengthMax = Math.max(
      stats.sideListLengthMax,
      mesh.faceCount - mesh.sourceFaceCount,
    );
    patchBoxes.forEach((b, p) => {
      stats.patchFacesQueried += 1;
      bvh.queryBox(
        [b[0], b[1], b[2]],
        [b[3], b[4], b[5]],
        (face) => {
          if (mesh.alive[face] === 1 && !skip.has(face)) note(face, p);
          return true;
        },
        counters,
        UNLIMITED,
      );
      const candidates: number[] = [];
      sideIndex.query([b[0], b[1], b[2]], [b[3], b[4], b[5]], candidates);
      candidates.sort((x, y) => x - y);
      for (const face of candidates) {
        stats.sideListIterations += 1;
        if (mesh.alive[face] !== 1 || skip.has(face)) continue;
        stats.sideListBoxesBuilt += 1;
        if (meets(boxOfCorners(liveCorners(mesh, face)), b)) note(face, p);
      }
    });
    // Brute force over EVERY alive face: the audit that proves the broadphase.
    const brute = new Set<string>();
    for (let face = 0; audit && face < mesh.faceCount; face += 1) {
      if (mesh.alive[face] !== 1 || skip.has(face)) continue;
      const fb = boxOfCorners(liveCorners(mesh, face));
      patchBoxes.forEach((b, p) => {
        if (meets(fb, b)) brute.add(`${String(face)}|${String(p)}`);
      });
    }
    stats.bvhNodeVisits += counters.nodeVisits;
    stats.bvhCandidates += counters.candidates;
    return { regionFaces, pairs, brute, found };
  };

  // The BASELINE half of the gate (the faces near the REMOVED faces, and their classification)
  // depends only on the mesh and the removed set, which every candidate of one site shares. It is
  // computed once per (removed set, committed history) and reused. Audit mode never reuses.
  let readBox: [number, number, number, number, number, number] | undefined;
  const growRead = (corners: readonly number[]): void => {
    const b = boxOfCorners(corners);
    if (readBox === undefined) readBox = [b[0], b[1], b[2], b[3], b[4], b[5]];
    else {
      for (let a = 0; a < 3; a += 1) {
        if ((b[a] ?? 0) < (readBox[a] ?? 0)) readBox[a] = b[a] ?? 0;
        if ((b[a + 3] ?? 0) > (readBox[a + 3] ?? 0)) readBox[a + 3] = b[a + 3] ?? 0;
      }
    }
  };
  let commits = 0;
  let cachedBaseline:
    { key: string; baseline: ReturnType<typeof enumerate>; before: PairClassification } | undefined;
  const accept: SurgeryAccept = ({ mesh, removedFaces, addedFaces }) => {
    stats.operations += 1;
    for (const f of removedFaces) growRead(liveCorners(mesh, f));
    for (const f of addedFaces) growRead(liveCorners(mesh, f));
    const skip = new Set<number>(addedFaces);
    const finish = (verdict: string | undefined): string | undefined => {
      if (verdict === undefined) commits += 1;
      return verdict;
    };
    let tentativeStart = mesh.faceCount;
    for (const f of skip) if (f < tentativeStart) tentativeStart = f;
    const key = audit
      ? undefined
      : `${removedFaces.join(',')}|${String(tentativeStart)}|${String(commits)}`;
    const reuse = key !== undefined && cachedBaseline?.key === key ? cachedBaseline : undefined;
    const baseline = reuse?.baseline ?? enumerate(mesh, removedFaces, skip);
    const candidate = enumerate(mesh, addedFaces, skip);
    for (const e of [baseline, candidate]) {
      stats.bruteForcePairs += e.brute.size;
      stats.broadphasePairs += e.found.size;
      let missed = 0;
      for (const k of e.brute) if (!e.found.has(k)) missed += 1;
      stats.missedByBroadphase += missed;
      if (missed > 0) {
        stats.rejectedEnumeration += 1;
        return finish('enumeration-incomplete');
      }
    }
    const classify = (
      e: ReturnType<typeof enumerate>,
      patchFaces: readonly number[],
    ): PairClassification =>
      classifyTrianglesBatched(
        makeNarrowphase,
        e.regionFaces.map((f) => liveCorners(mesh, f)),
        patchFaces.map((f) => liveCorners(mesh, f)),
        e.pairs,
        CLASSIFY_PAIRS_PER_CALL,
      );
    const before = reuse?.before ?? classify(baseline, removedFaces);
    if (key !== undefined && reuse === undefined) cachedBaseline = { key, baseline, before };
    const after = classify(candidate, addedFaces);
    stats.testedPairs += before.tested + after.tested;
    currentMeter?.chargePairs(before.tested + after.tested);
    if (!before.complete || !after.complete) {
      stats.rejectedIncomplete += 1;
      return finish('intersection-test-incomplete');
    }
    const beforeSet = new Set(baseline.regionFaces.filter((_, i) => before.invalidRegion.has(i)));
    let introduced = 0;
    for (const i of after.invalidRegion) {
      if (!beforeSet.has(candidate.regionFaces[i] ?? -1)) introduced += 1;
    }
    if (introduced > 0 || after.invalidPatchPatch > before.invalidPatchPatch) {
      stats.rejectedIntersection += 1;
      return finish('introduces-intersection');
    }
    return finish(undefined);
  };
  return {
    accept,
    stats,
    useMeter: (meter: RepairWorkMeter | undefined): void => {
      currentMeter = meter;
    },
    reads: {
      reset: (): void => {
        readBox = undefined;
      },
      box: () => readBox,
    },
  };
}
