import { describe, expect, it } from 'vitest';
import {
  boxesOverlap,
  createCounters,
  faceBoxOf,
  FaceBvh,
  type BroadphaseBudget,
} from './face-bvh';

/*
 * The budget the hole-fill engine runs this tree under (40,000,000 AABB tests, 20,000,000 node visits, 4,000,000
 * candidates). Restated here, with the same values the test used before the move, because mesh-core must not depend on
 * a feature package: the oracle comparisons below must never be truncated by a budget.
 */
const MAX_AABB_TESTS = 40_000_000;
const MAX_BVH_NODE_VISITS = 20_000_000;
const MAX_BROADPHASE_CANDIDATES = 4_000_000;

const GENEROUS: BroadphaseBudget = {
  maxNodeVisits: MAX_BVH_NODE_VISITS,
  maxAabbTests: MAX_AABB_TESTS,
  maxCandidates: MAX_BROADPHASE_CANDIDATES,
};

/**
 * A deterministic pseudo-random mesh of independent triangles.
 *
 * A LINEAR CONGRUENTIAL GENERATOR WITH A FIXED SEED, not `Math.random`: a
 * broadphase test that failed only on some runs would be untriageable, and a
 * corpus that changed between runs could not be a regression guard.
 */
function scatteredTriangles(
  count: number,
  seed = 1,
): {
  positions: Float64Array;
  triangles: Uint32Array;
} {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  const positions = new Float64Array(count * 9);
  const triangles = new Uint32Array(count * 3);
  for (let face = 0; face < count; face += 1) {
    const ox = next() * 20;
    const oy = next() * 20;
    const oz = next() * 20;
    for (let corner = 0; corner < 3; corner += 1) {
      const base = (face * 3 + corner) * 3;
      positions[base] = ox + next() * 3;
      positions[base + 1] = oy + next() * 3;
      positions[base + 2] = oz + next() * 3;
      triangles[face * 3 + corner] = face * 3 + corner;
    }
  }
  return { positions, triangles };
}

/** Every face whose box overlaps the query, by exhaustive comparison. */
function bruteForce(
  positions: Float64Array,
  triangles: Uint32Array,
  first: number,
  end: number,
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
): number[] {
  const found: number[] = [];
  for (let face = first; face < end; face += 1) {
    const box = faceBoxOf(positions, triangles, face);
    if (boxesOverlap(box.lo, box.hi, lo, hi)) found.push(face);
  }
  return found;
}

describe('the patch-query broadphase', () => {
  it('finds EXACTLY what an all-pairs oracle finds, over a whole corpus', () => {
    /*
     * THE CHECK THAT MATTERS. A broadphase that MISSES a pair turns a defect
     * into a clean bill of health — the one failure this stage cannot have — so
     * the tree is validated against exhaustive comparison rather than against
     * an argument about median splits. This is the same validation `si_bvh.h`
     * was given during Stage 3C-1A-R1, for the same reason.
     */
    const { positions, triangles } = scatteredTriangles(400);
    const tree = FaceBvh.build(positions, triangles, 0, 400);

    for (let face = 0; face < 400; face += 1) {
      const box = faceBoxOf(positions, triangles, face);
      const seen: number[] = [];
      const complete = tree.queryBox(
        box.lo,
        box.hi,
        (hit) => {
          seen.push(hit);
          return true;
        },
        createCounters(),
        GENEROUS,
      );
      expect(complete).toBe(true);
      expect([...seen].sort((a, b) => a - b)).toEqual(
        bruteForce(positions, triangles, 0, 400, box.lo, box.hi),
      );
    }
  });

  it('keeps exact contact: a box touching on one plane is still a candidate', () => {
    /*
     * OVERLAP IS INCLUSIVE, exactly as `si_bvh.h` defines it. Shrinking this to
     * a strict inequality would silently discard every exact contact — which is
     * precisely the set of pairs a fill has to classify rather than assume
     * benign, because a patch shares its rim edge with the source by design.
     */
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 1, 1, 0]);
    const triangles = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const tree = FaceBvh.build(positions, triangles, 0, 1);
    const box = faceBoxOf(positions, triangles, 1);

    const seen: number[] = [];
    tree.queryBox(box.lo, box.hi, (hit) => (seen.push(hit), true), createCounters(), GENEROUS);
    expect(seen).toEqual([0]);
  });

  it('reports ABSOLUTE face ids when built over a sub-range', () => {
    // The patch tree covers `[sourceFaceCount, end)`, and the rest of the
    // engine addresses faces by their index in the whole candidate.
    const { positions, triangles } = scatteredTriangles(50);
    const tree = FaceBvh.build(positions, triangles, 30, 50);
    const box = faceBoxOf(positions, triangles, 35);
    const seen: number[] = [];
    tree.queryBox(box.lo, box.hi, (hit) => (seen.push(hit), true), createCounters(), GENEROUS);
    expect(seen).toContain(35);
    for (const face of seen) expect(face).toBeGreaterThanOrEqual(30);
  });

  it('STREAMS: a visitor that stops ends the traversal immediately', () => {
    const { positions, triangles } = scatteredTriangles(200);
    const tree = FaceBvh.build(positions, triangles, 0, 200);
    const box: [number, number, number] = [-1000, -1000, -1000];
    const far: [number, number, number] = [1000, 1000, 1000];

    let visits = 0;
    const complete = tree.queryBox(
      box,
      far,
      () => {
        visits += 1;
        return visits < 5;
      },
      createCounters(),
      GENEROUS,
    );
    expect(complete).toBe(false);
    expect(visits).toBe(5);
  });

  it('stops at the candidate ceiling rather than enumerating everything', () => {
    const { positions, triangles } = scatteredTriangles(300);
    const tree = FaceBvh.build(positions, triangles, 0, 300);
    const counters = createCounters();
    const complete = tree.queryBox(
      [-1000, -1000, -1000],
      [1000, 1000, 1000],
      () => true,
      counters,
      { ...GENEROUS, maxCandidates: 10 },
    );
    expect(complete).toBe(false);
    expect(counters.candidates).toBeLessThanOrEqual(11);
  });

  it('stops at the node-visit ceiling', () => {
    const { positions, triangles } = scatteredTriangles(300);
    const tree = FaceBvh.build(positions, triangles, 0, 300);
    const counters = createCounters();
    const complete = tree.queryBox(
      [-1000, -1000, -1000],
      [1000, 1000, 1000],
      () => true,
      counters,
      { ...GENEROUS, maxNodeVisits: 3 },
    );
    expect(complete).toBe(false);
    expect(counters.nodeVisits).toBeLessThanOrEqual(4);
  });

  it('is deterministic: the same query emits the same candidates in the same order', () => {
    const { positions, triangles } = scatteredTriangles(300, 7);
    const first = FaceBvh.build(positions, triangles, 0, 300);
    const second = FaceBvh.build(positions, triangles, 0, 300);
    const box = faceBoxOf(positions, triangles, 12);

    const collect = (tree: FaceBvh): number[] => {
      const out: number[] = [];
      tree.queryBox(box.lo, box.hi, (hit) => (out.push(hit), true), createCounters(), GENEROUS);
      return out;
    };
    expect(collect(second)).toEqual(collect(first));
    expect(collect(first)).toEqual(collect(first));
  });

  it('handles an empty range and a single face without special-casing callers', () => {
    const { positions, triangles } = scatteredTriangles(4);
    const empty = FaceBvh.build(positions, triangles, 2, 2);
    expect(empty.faceCount).toBe(0);
    expect(empty.queryBox([0, 0, 0], [1, 1, 1], () => true, createCounters(), GENEROUS)).toBe(true);

    const single = FaceBvh.build(positions, triangles, 1, 2);
    const box = faceBoxOf(positions, triangles, 1);
    const seen: number[] = [];
    single.queryBox(box.lo, box.hi, (hit) => (seen.push(hit), true), createCounters(), GENEROUS);
    expect(seen).toEqual([1]);
  });

  it('survives a pathological mesh where every box overlaps every other', () => {
    // The adversarial case: identical boxes defeat every spatial split, so the
    // tree degenerates to a linear scan. It must still terminate, still find
    // everything, and still respect its ceilings.
    const count = 64;
    const positions = new Float64Array(count * 9);
    const triangles = new Uint32Array(count * 3);
    for (let face = 0; face < count; face += 1) {
      positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0], face * 9);
      for (let corner = 0; corner < 3; corner += 1) {
        triangles[face * 3 + corner] = face * 3 + corner;
      }
    }
    const tree = FaceBvh.build(positions, triangles, 0, count);
    const box = faceBoxOf(positions, triangles, 0);
    const seen: number[] = [];
    const counters = createCounters();
    expect(tree.queryBox(box.lo, box.hi, (hit) => (seen.push(hit), true), counters, GENEROUS)).toBe(
      true,
    );
    expect(seen).toHaveLength(count);
    expect(counters.nodeVisits).toBeGreaterThan(0);
  });
});
