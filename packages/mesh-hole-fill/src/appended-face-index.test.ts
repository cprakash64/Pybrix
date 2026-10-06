import { describe, expect, it } from 'vitest';
import { AppendedFaceIndex } from './appended-face-index';

/**
 * REPAIR-CORE-05D — the incremental appended-face broadphase must answer exactly what the
 * linear scan it replaces answered: a SUPERSET generator whose exact-tested, ascending result
 * equals the brute-force result for every query, across rebuilds, dead faces and revivals.
 */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface World {
  positions: Float64Array;
  triangles: Int32Array;
  faces: number;
}

function world(faces: number, seed: number, scaleSpread: boolean): World {
  const rnd = lcg(seed);
  const positions = new Float64Array(faces * 9);
  const triangles = new Int32Array(faces * 3);
  for (let f = 0; f < faces; f += 1) {
    const cx = rnd() * 10;
    const cy = rnd() * 10;
    const cz = rnd() * 10;
    const size = scaleSpread ? 10 ** (rnd() * 4 - 3) : 0.2;
    for (let c = 0; c < 3; c += 1) {
      positions[(f * 3 + c) * 3] = cx + (rnd() - 0.5) * size;
      positions[(f * 3 + c) * 3 + 1] = cy + (rnd() - 0.5) * size;
      positions[(f * 3 + c) * 3 + 2] = cz + (rnd() - 0.5) * size;
      triangles[f * 3 + c] = f * 3 + c;
    }
  }
  return { positions, triangles, faces };
}

function boxOf(w: World, face: number): number[] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 3; c += 1) {
    const v = w.triangles[face * 3 + c] ?? 0;
    for (let a = 0; a < 3; a += 1) {
      const x = w.positions[v * 3 + a] ?? 0;
      lo[a] = Math.min(lo[a] ?? Infinity, x);
      hi[a] = Math.max(hi[a] ?? -Infinity, x);
    }
  }
  return [...lo, ...hi];
}

function meets(a: number[], b: number[]): boolean {
  return (
    (a[0] ?? 0) <= (b[3] ?? 0) &&
    (b[0] ?? 0) <= (a[3] ?? 0) &&
    (a[1] ?? 0) <= (b[4] ?? 0) &&
    (b[1] ?? 0) <= (a[4] ?? 0) &&
    (a[2] ?? 0) <= (b[5] ?? 0) &&
    (b[2] ?? 0) <= (a[5] ?? 0)
  );
}

describe('AppendedFaceIndex', () => {
  for (const spread of [false, true]) {
    it(`matches the brute-force scan for every query (${spread ? 'mixed' : 'uniform'} face sizes, several rebuilds)`, () => {
      const w = world(3000, spread ? 7 : 3, spread);
      const first = 100;
      const index = new AppendedFaceIndex(first, 256);
      const rnd = lcg(99);
      let missing = 0;
      for (let limit = first; limit <= w.faces; limit += 137) {
        index.sync(w.positions, w.triangles, limit);
        expect(index.covered).toBe(limit);
        for (let q = 0; q < 12; q += 1) {
          const cx = rnd() * 10;
          const cy = rnd() * 10;
          const cz = rnd() * 10;
          const r = 10 ** (rnd() * 2 - 2);
          const box = [cx - r, cy - r, cz - r, cx + r, cy + r, cz + r];
          const found: number[] = [];
          index.query(
            [box[0] ?? 0, box[1] ?? 0, box[2] ?? 0],
            [box[3] ?? 0, box[4] ?? 0, box[5] ?? 0],
            found,
          );
          expect(new Set(found).size).toBe(found.length);
          const got = found.filter((f) => meets(boxOf(w, f), box)).sort((a, b) => a - b);
          const truth: number[] = [];
          for (let f = first; f < limit; f += 1) if (meets(boxOf(w, f), box)) truth.push(f);
          if (got.length !== truth.length || got.some((f, i) => f !== truth[i])) missing += 1;
        }
      }
      expect(missing).toBe(0);
      expect(index.stats.rebuilds).toBeGreaterThan(3);
    });
  }

  it('indexes faces regardless of liveness, so a revived face is still found', () => {
    const w = world(40, 5, false);
    const index = new AppendedFaceIndex(0, 8);
    index.sync(w.positions, w.triangles, 40);
    const box = boxOf(w, 17);
    const found: number[] = [];
    index.query(
      [box[0] ?? 0, box[1] ?? 0, box[2] ?? 0],
      [box[3] ?? 0, box[4] ?? 0, box[5] ?? 0],
      found,
    );
    expect(found).toContain(17);
  });

  it('does a bounded amount of work per query: no scan over every appended face', () => {
    const w = world(6000, 11, false);
    const index = new AppendedFaceIndex(0, 256);
    index.sync(w.positions, w.triangles, 6000);
    const found: number[] = [];
    index.query([0, 0, 0], [0.5, 0.5, 0.5], found);
    // A small box returns a small, local candidate set (the linear scan visited all 6,000).
    expect(found.length).toBeLessThan(200);
  });
});
