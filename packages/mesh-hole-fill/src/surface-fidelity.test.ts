import { describe, expect, it } from 'vitest';
import { surfaceDistanceSet } from './surface-fidelity';
import type { Vec3 } from './surgery-mesh';

/**
 * REPAIR-CORE-05D — the allocation-free distance kernel must return, bit for bit, what the
 * tuple-based kernel it replaced returned (ranking and the fidelity ceiling depend on it).
 * The LEGACY code below is the REPAIR-CORE-05B implementation, verbatim.
 */
function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dotp = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const at = (o: Vec3, d: Vec3, t: number): Vec3 => [
    o[0] + d[0] * t,
    o[1] + d[1] * t,
    o[2] + d[2] * t,
  ];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dotp(ab, ap);
  const d2 = dotp(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dotp(ab, bp);
  const d4 = dotp(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dotp(ab, cp);
  const d6 = dotp(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return at(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denom = 1 / (va + vb + vc);
  return at(at(a, ab, vb * denom), ac, vc * denom);
}

/** A deterministic barycentric lattice with `n + 1` points per side. */
function samplePoints(t: readonly number[], n: number): Vec3[] {
  const a: Vec3 = [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
  const b: Vec3 = [t[3] ?? 0, t[4] ?? 0, t[5] ?? 0];
  const c: Vec3 = [t[6] ?? 0, t[7] ?? 0, t[8] ?? 0];
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= n - i; j += 1) {
      const u = i / n;
      const v = j / n;
      const w = 1 - u - v;
      out.push([
        a[0] * w + b[0] * u + c[0] * v,
        a[1] * w + b[1] * u + c[1] * v,
        a[2] * w + b[2] * u + c[2] * v,
      ]);
    }
  }
  return out;
}

function toVec(t: readonly number[], k: number): Vec3 {
  return [t[k * 3] ?? 0, t[k * 3 + 1] ?? 0, t[k * 3 + 2] ?? 0];
}

function legacyDistanceSet(
  from: readonly (readonly number[])[],
  to: readonly (readonly number[])[],
): number[] {
  const out: number[] = [];
  for (const t of from) {
    for (const p of samplePoints(t, 4)) {
      let best = Infinity;
      for (const u of to) {
        const q = closestPointOnTriangle(p, toVec(u, 0), toVec(u, 1), toVec(u, 2));
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < best) best = d;
      }
      out.push(best);
    }
  }
  return out;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function triangles(count: number, rnd: () => number, spread: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const t: number[] = [];
    const cx = rnd() * spread;
    const cy = rnd() * spread;
    const cz = rnd() * spread;
    const size = 10 ** (rnd() * 4 - 3);
    for (let k = 0; k < 3; k += 1)
      t.push(cx + (rnd() - 0.5) * size, cy + (rnd() - 0.5) * size, cz + (rnd() - 0.5) * size);
    out.push(t);
  }
  return out;
}

describe('surfaceDistanceSet', () => {
  it('reports an infinite distance when there is no target surface, as before', () => {
    const t = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    expect(surfaceDistanceSet([t], [])).toEqual(legacyDistanceSet([t], []));
  });

  it('is bit-identical to the REPAIR-CORE-05B kernel over random, degenerate and coincident triangles', () => {
    const rnd = lcg(2026);
    let compared = 0;
    for (let trial = 0; trial < 40; trial += 1) {
      const a = triangles(1 + Math.floor(rnd() * 8), rnd, trial % 2 === 0 ? 1 : 0.01);
      const b = triangles(1 + Math.floor(rnd() * 8), rnd, trial % 2 === 0 ? 1 : 0.01);
      // Degenerate (zero-area, collinear) and coincident cases exercise the edge branches.
      b.push([0, 0, 0, 1, 0, 0, 2, 0, 0], [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
      a.push(b[0] ?? [], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const fresh = surfaceDistanceSet(a, b);
      const old = legacyDistanceSet(a, b);
      expect(fresh.length).toBe(old.length);
      for (let i = 0; i < old.length; i += 1) {
        expect(Object.is(fresh[i], old[i])).toBe(true);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(3000);
  });
});
