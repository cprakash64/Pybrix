import {
  FaceBvh,
  createCounters,
  faceBoxOf,
  type BroadphaseBudget,
} from '@cadfixer/mesh-core/spatial';
import { DEFAULT_HOLE_FILL_LIMITS, type HoleFillLimits } from './limits';
import type { PatchNarrowphase } from './contract';
import type { LocalPatchProblem } from './local-region';

/**
 * PATCH-ATTRIBUTED INTERSECTION OVER A LOCAL REGION — REPAIR-CORE-02.
 *
 * The same question the per-opening engine asks — does any manufactured
 * triangle take part in an invalid intersection with the part or with another
 * manufactured triangle? — asked of the region `buildLocalPatchProblem`
 * collected, which provably holds every face such a pair could involve.
 *
 * THE SAME PREDICATE AND THE SAME SHAPE. The injected narrowphase is the
 * qualified Geogram kernel; pairs come from the same inclusive-overlap BVH,
 * stream through the same fixed 8,192-pair buffer, and are bounded by the same
 * node-visit, AABB-test, candidate and narrowphase budgets — now PER LOOP. Only
 * (patch × region) and (patch × patch) pairs are generated, so a crossing the
 * file already had can never be blamed on a fill.
 *
 * A VERDICT PER LOOP, and a loop is clean only when its scan was COMPLETE: a
 * pair the kernel could not classify, or a budget that stopped the scan early,
 * is never absorbed into a clean result.
 */

export interface LocalLoopVerdict {
  readonly complete: boolean;
  readonly budgetExceeded: boolean;
  readonly testedPairs: number;
  readonly invalidPatchSourcePairs: number;
  readonly invalidPatchPatchPairs: number;
}

const PAIR_BATCH = 8_192;

export function classifyLocalPatches(
  problem: LocalPatchProblem,
  narrowphase: PatchNarrowphase,
  limits: HoleFillLimits = DEFAULT_HOLE_FILL_LIMITS,
): readonly LocalLoopVerdict[] {
  const loopCount = problem.loopRanges.length / 2;
  if (loopCount === 0) return [];
  const totalFaces = problem.triangles.length / 3;

  const sourceTree = FaceBvh.build(
    problem.positions,
    problem.triangles,
    0,
    problem.sourceFaceCount,
  );
  const patchTree = FaceBvh.build(
    problem.positions,
    problem.triangles,
    problem.sourceFaceCount,
    totalFaces,
  );

  narrowphase.begin({
    positions: problem.positions,
    triangles: problem.triangles,
    patchFaceStart: problem.sourceFaceCount,
    maxSamples: limits.maxSamples,
  });

  const verdicts: LocalLoopVerdict[] = [];
  try {
    for (let loop = 0; loop < loopCount; loop += 1) {
      verdicts.push(
        classifyLoop(
          problem,
          narrowphase,
          limits,
          sourceTree,
          patchTree,
          problem.loopRanges[loop * 2] ?? 0,
          problem.loopRanges[loop * 2 + 1] ?? 0,
        ),
      );
    }
  } finally {
    narrowphase.end();
  }
  return verdicts;
}

function classifyLoop(
  problem: LocalPatchProblem,
  narrowphase: PatchNarrowphase,
  limits: HoleFillLimits,
  sourceTree: FaceBvh,
  patchTree: FaceBvh,
  start: number,
  end: number,
): LocalLoopVerdict {
  const counters = createCounters();
  const budget: BroadphaseBudget = {
    maxNodeVisits: limits.maxBvhNodeVisits,
    maxAabbTests: limits.maxAabbTests,
    maxCandidates: limits.maxBroadphaseCandidates,
  };
  const pairs = new Uint32Array(PAIR_BATCH * 2);
  let buffered = 0;
  const state = {
    complete: true,
    budgetExceeded: false,
    tested: 0,
    patchSource: 0,
    patchPatch: 0,
  };

  const flush = (): boolean => {
    if (buffered === 0) return true;
    const result = narrowphase.classify(pairs, buffered);
    buffered = 0;
    state.tested += result.testedPairs;
    state.patchSource += result.invalidPatchSourcePairs;
    state.patchPatch += result.invalidPatchPatchPairs;
    if (!result.complete) state.complete = false;
    if (state.tested > limits.maxNarrowphasePairs) {
      state.budgetExceeded = true;
      return false;
    }
    return true;
  };
  const emit = (a: number, b: number): boolean => {
    pairs[buffered * 2] = a;
    pairs[buffered * 2 + 1] = b;
    buffered += 1;
    return buffered < PAIR_BATCH ? true : flush();
  };

  for (let patch = start; patch < end && !state.budgetExceeded; patch += 1) {
    const box = faceBoxOf(problem.positions, problem.triangles, patch);
    const sourceOk = sourceTree.queryBox(
      box.lo,
      box.hi,
      (face) => emit(patch, face),
      counters,
      budget,
    );
    // Each patch/patch pair once, never a face with itself.
    const patchOk = sourceOk
      ? patchTree.queryBox(
          box.lo,
          box.hi,
          (face) => (face <= patch ? true : emit(patch, face)),
          counters,
          budget,
        )
      : false;
    if (!sourceOk || !patchOk) {
      state.budgetExceeded = true;
      break;
    }
  }
  if (!state.budgetExceeded) flush();

  return {
    complete: state.complete && !state.budgetExceeded,
    budgetExceeded: state.budgetExceeded,
    testedPairs: state.tested,
    invalidPatchSourcePairs: state.patchSource,
    invalidPatchPatchPairs: state.patchPatch,
  };
}
