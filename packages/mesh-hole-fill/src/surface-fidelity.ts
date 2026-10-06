import type { SurgeryMesh, Vec3 } from './surgery-mesh';

/**
 * Bounded bidirectional surface-distance evidence for a local reconstruction
 * (REPAIR-CORE-05A measurement, hoisted here in REPAIR-CORE-05B so the A2 engine
 * can RANK candidates by the same machinery that REPORTS them). Pure arithmetic:
 * kernel-free, deterministic, reads dead faces too, since a tentative candidate's
 * removed faces are flagged dead but never erased.
 */

/** Flat corner coordinates (9 numbers) of one face of a live mesh, alive or not. */
export function faceCornerCoordinates(mesh: SurgeryMesh, face: number): number[] {
  const out: number[] = [];
  for (const v of mesh.corners(face)) {
    out.push(mesh.pos[v * 3] ?? 0, mesh.pos[v * 3 + 1] ?? 0, mesh.pos[v * 3 + 2] ?? 0);
  }
  return out;
}

export function triangleArea(t: readonly number[]): number {
  const ux = (t[3] ?? 0) - (t[0] ?? 0);
  const uy = (t[4] ?? 0) - (t[1] ?? 0);
  const uz = (t[5] ?? 0) - (t[2] ?? 0);
  const vx = (t[6] ?? 0) - (t[0] ?? 0);
  const vy = (t[7] ?? 0) - (t[1] ?? 0);
  const vz = (t[8] ?? 0) - (t[2] ?? 0);
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  // Same rule as the 05A qualification helpers, so reported numbers stay comparable.
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function toVec(t: readonly number[], k: number): Vec3 {
  return [t[k * 3] ?? 0, t[k * 3 + 1] ?? 0, t[k * 3 + 2] ?? 0];
}

/**
 * Distance from every lattice point of every `from` triangle to the nearest `to` triangle.
 * REPAIR-CORE-05D: written over flat scalars with no per-point allocation. The arithmetic is the
 * original's, operation for operation (same expressions, same order, same branches), so every
 * returned distance is bit-identical to the tuple-based version; a test holds the two together.
 */
export function surfaceDistanceSet(
  from: readonly (readonly number[])[],
  to: readonly (readonly number[])[],
): number[] {
  const out: number[] = [];
  const m = to.length;
  if (m === 0) {
    // No target surface: every lattice point is infinitely far, as the original reported.
    for (let i = 0; i < from.length * 15; i += 1) out.push(Infinity);
    return out;
  }
  // Per target triangle: a, ab = b - a, ac = c - a (what the original recomputed per point).
  const ta = new Float64Array(m * 3);
  const tb = new Float64Array(m * 3);
  const tc = new Float64Array(m * 3);
  const tab = new Float64Array(m * 3);
  const tac = new Float64Array(m * 3);
  // Per target triangle: its box, used only to SKIP triangles that provably cannot be nearer.
  const boxLo = new Float64Array(m * 3);
  const boxHi = new Float64Array(m * 3);
  for (let i = 0; i < m; i += 1) {
    const u = to[i] ?? [];
    for (let k = 0; k < 3; k += 1) {
      const a = u[k] ?? 0;
      const b = u[3 + k] ?? 0;
      const c = u[6 + k] ?? 0;
      ta[i * 3 + k] = a;
      tb[i * 3 + k] = b;
      tc[i * 3 + k] = c;
      tab[i * 3 + k] = b - a;
      tac[i * 3 + k] = c - a;
      boxLo[i * 3 + k] = Math.min(a, b, c);
      boxHi[i * 3 + k] = Math.max(a, b, c);
    }
  }
  const n = 4;
  let lastNearest = 0;
  for (const t of from) {
    const a0 = t[0] ?? 0;
    const a1 = t[1] ?? 0;
    const a2 = t[2] ?? 0;
    const b0 = t[3] ?? 0;
    const b1 = t[4] ?? 0;
    const b2 = t[5] ?? 0;
    const c0 = t[6] ?? 0;
    const c1 = t[7] ?? 0;
    const c2 = t[8] ?? 0;
    for (let i = 0; i <= n; i += 1) {
      for (let j = 0; j <= n - i; j += 1) {
        const u = i / n;
        const v = j / n;
        const w = 1 - u - v;
        const p0 = a0 * w + b0 * u + c0 * v;
        const p1 = a1 * w + b1 * u + c1 * v;
        const p2 = a2 * w + b2 * u + c2 * v;
        let best = Infinity;
        let bestSq = Infinity;
        // The triangle that was nearest to the previous lattice point is usually nearest again.
        // Visiting it first, then skipping every triangle whose BOX is provably farther than the
        // best distance found (with a relative slack of 1e-6, orders of magnitude above rounding),
        // cannot change the minimum: a skipped triangle's computed distance exceeds `best`, and
        // the minimum of a set of doubles does not depend on visiting order. Bit-identical.
        for (let step = -1; step < m; step += 1) {
          const q = step < 0 ? lastNearest : step;
          if (step >= 0 && q === lastNearest) continue;
          const o = q * 3;
          if (bestSq < Infinity) {
            const e0 = Math.max((boxLo[o] ?? 0) - p0, 0, p0 - (boxHi[o] ?? 0));
            const e1 = Math.max((boxLo[o + 1] ?? 0) - p1, 0, p1 - (boxHi[o + 1] ?? 0));
            const e2 = Math.max((boxLo[o + 2] ?? 0) - p2, 0, p2 - (boxHi[o + 2] ?? 0));
            if (e0 * e0 + e1 * e1 + e2 * e2 > bestSq * 1.000001) continue;
          }
          const d = closestDistance(p0, p1, p2, ta, tb, tc, tab, tac, o);
          if (d < best) {
            best = d;
            bestSq = d * d;
            lastNearest = q;
          }
        }
        out.push(best);
      }
    }
  }
  return out;
}

/**
 * Math.hypot(p - closest(p, triangle)), with the closest point found exactly as the original
 * `closestPointOnTriangle` found it, over scalars.
 */
function closestDistance(
  p0: number,
  p1: number,
  p2: number,
  ta: Float64Array,
  tb: Float64Array,
  tc: Float64Array,
  tab: Float64Array,
  tac: Float64Array,
  o: number,
): number {
  const a0 = ta[o] ?? 0;
  const a1 = ta[o + 1] ?? 0;
  const a2 = ta[o + 2] ?? 0;
  const ab0 = tab[o] ?? 0;
  const ab1 = tab[o + 1] ?? 0;
  const ab2 = tab[o + 2] ?? 0;
  const ac0 = tac[o] ?? 0;
  const ac1 = tac[o + 1] ?? 0;
  const ac2 = tac[o + 2] ?? 0;
  const ap0 = p0 - a0;
  const ap1 = p1 - a1;
  const ap2 = p2 - a2;
  const d1 = ab0 * ap0 + ab1 * ap1 + ab2 * ap2;
  const d2 = ac0 * ap0 + ac1 * ap1 + ac2 * ap2;
  let q0: number;
  let q1: number;
  let q2: number;
  if (d1 <= 0 && d2 <= 0) {
    q0 = a0;
    q1 = a1;
    q2 = a2;
    return Math.hypot(p0 - q0, p1 - q1, p2 - q2);
  }
  const b0 = tb[o] ?? 0;
  const b1 = tb[o + 1] ?? 0;
  const b2 = tb[o + 2] ?? 0;
  const bp0 = p0 - b0;
  const bp1 = p1 - b1;
  const bp2 = p2 - b2;
  const d3 = ab0 * bp0 + ab1 * bp1 + ab2 * bp2;
  const d4 = ac0 * bp0 + ac1 * bp1 + ac2 * bp2;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(p0 - b0, p1 - b1, p2 - b2);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    q0 = a0 + ab0 * t;
    q1 = a1 + ab1 * t;
    q2 = a2 + ab2 * t;
    return Math.hypot(p0 - q0, p1 - q1, p2 - q2);
  }
  const c0 = tc[o] ?? 0;
  const c1 = tc[o + 1] ?? 0;
  const c2 = tc[o + 2] ?? 0;
  const cp0 = p0 - c0;
  const cp1 = p1 - c1;
  const cp2 = p2 - c2;
  const d5 = ab0 * cp0 + ab1 * cp1 + ab2 * cp2;
  const d6 = ac0 * cp0 + ac1 * cp1 + ac2 * cp2;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(p0 - c0, p1 - c1, p2 - c2);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    q0 = a0 + ac0 * t;
    q1 = a1 + ac1 * t;
    q2 = a2 + ac2 * t;
    return Math.hypot(p0 - q0, p1 - q1, p2 - q2);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    q0 = b0 + (c0 - b0) * t;
    q1 = b1 + (c1 - b1) * t;
    q2 = b2 + (c2 - b2) * t;
    return Math.hypot(p0 - q0, p1 - q1, p2 - q2);
  }
  const denom = 1 / (va + vb + vc);
  const s0 = a0 + ab0 * (vb * denom);
  const s1 = a1 + ab1 * (vb * denom);
  const s2 = a2 + ab2 * (vb * denom);
  q0 = s0 + ac0 * (vc * denom);
  q1 = s1 + ac1 * (vc * denom);
  q2 = s2 + ac2 * (vc * denom);
  return Math.hypot(p0 - q0, p1 - q1, p2 - q2);
}

export interface DistanceStats {
  readonly max: number;
  readonly median: number;
  readonly p95: number;
}

function stats(values: readonly number[]): DistanceStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    max: sorted[sorted.length - 1] ?? 0,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  };
}

export interface SurfaceFidelity {
  readonly localEdgeMedian: number;
  readonly sourceAreaLocal: number;
  readonly repairedAreaLocal: number;
  readonly areaDelta: number;
  readonly boundsDelta: number;
  readonly forward: DistanceStats;
  readonly backward: DistanceStats;
  readonly maxDistance: number;
  readonly p95Distance: number;
  readonly maxDistanceOverLocalEdge: number;
  readonly p95OverLocalEdge: number;
}

/**
 * Source (removed) faces against repaired (added) faces and back, normalised by the
 * MEDIAN EDGE LENGTH OF THE REMOVED FACES. The normaliser is the same one 05A
 * reported, so a ceiling stated in local edges means the same thing in both.
 */
export function measureSurfaceFidelity(
  mesh: SurgeryMesh,
  removedFaces: readonly number[],
  addedFaces: readonly number[],
): SurfaceFidelity {
  const removed = removedFaces.map((f) => faceCornerCoordinates(mesh, f));
  const added = addedFaces.map((f) => faceCornerCoordinates(mesh, f));
  const forward = stats(surfaceDistanceSet(removed, added));
  const backward = stats(surfaceDistanceSet(added, removed));
  const edges: number[] = [];
  for (const t of removed) {
    for (let k = 0; k < 3; k += 1) {
      const a = toVec(t, k);
      const b = toVec(t, (k + 1) % 3);
      edges.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  edges.sort((a, b) => a - b);
  const localEdge = quantile(edges, 0.5);
  const sumArea = (ts: readonly (readonly number[])[]): number =>
    ts.reduce((s, t) => s + triangleArea(t), 0);
  const boundsOf = (ts: readonly (readonly number[])[]): number[] => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const t of ts) {
      for (let k = 0; k < 3; k += 1) {
        for (let a = 0; a < 3; a += 1) {
          const x = t[k * 3 + a] ?? 0;
          lo[a] = Math.min(lo[a] ?? Infinity, x);
          hi[a] = Math.max(hi[a] ?? -Infinity, x);
        }
      }
    }
    return [...lo, ...hi];
  };
  const b0 = boundsOf(removed);
  const b1 = boundsOf(added);
  let boundsDelta = 0;
  for (let i = 0; i < 6; i += 1) {
    boundsDelta = Math.max(boundsDelta, Math.abs((b0[i] ?? 0) - (b1[i] ?? 0)));
  }
  const sourceArea = sumArea(removed);
  const repairedArea = sumArea(added);
  const maxDistance = Math.max(forward.max, backward.max);
  const p95 = Math.max(forward.p95, backward.p95);
  return {
    localEdgeMedian: localEdge,
    sourceAreaLocal: sourceArea,
    repairedAreaLocal: repairedArea,
    areaDelta: repairedArea - sourceArea,
    boundsDelta,
    forward,
    backward,
    maxDistance,
    p95Distance: p95,
    maxDistanceOverLocalEdge: localEdge > 0 ? maxDistance / localEdge : 0,
    p95OverLocalEdge: localEdge > 0 ? p95 / localEdge : 0,
  };
}
