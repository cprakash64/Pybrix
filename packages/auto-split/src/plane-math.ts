import type { Vec3 } from '@cadfixer/auto-split-contract';
import { CHECKPOINT_STRIDE, NO_CHECKPOINT, type Checkpoint } from './checkpoint';
import type { FaceFacts, NormalizedGeometry } from './geometry';

/**
 * Plane arithmetic in NORMALIZED coordinates: a plane is `normal . x = offset` with a unit normal.
 */
export interface NormalizedPlane {
  readonly normal: Vec3;
  readonly offset: number;
}

export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mid3 = (a: Vec3, b: Vec3): Vec3 => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
];

/** A plane with a unit normal, or null for a zero or non-finite one. */
export function normalizedPlane(normal: readonly number[], offset: number): NormalizedPlane | null {
  const [x, y, z] = [normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0];
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-6) || !Number.isFinite(length) || !Number.isFinite(offset)) return null;
  return { normal: [x / length, y / length, z / length], offset: offset / length };
}

/**
 * The total length of the cut the plane makes through the surface: the sum over faces it crosses of the
 * length of the crossing segment. A narrow neck or shoulder joint is where this is smallest, which is
 * why the human refinement slides a proposed plane along its normal to the local minimum.
 */
export function crossSectionLength(
  geometry: NormalizedGeometry,
  plane: NormalizedPlane,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): number {
  const { positions: p, indices: idx, faceCount } = geometry;
  const [nx, ny, nz] = plane.normal;
  let total = 0;
  for (let start = 0; start < faceCount; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(faceCount, start + CHECKPOINT_STRIDE);
    for (let f = start; f < end; f += 1) {
      const a = (idx[f * 3] ?? 0) * 3;
      const b = (idx[f * 3 + 1] ?? 0) * 3;
      const c = (idx[f * 3 + 2] ?? 0) * 3;
      const da = nx * (p[a] ?? 0) + ny * (p[a + 1] ?? 0) + nz * (p[a + 2] ?? 0) - plane.offset;
      const db = nx * (p[b] ?? 0) + ny * (p[b + 1] ?? 0) + nz * (p[b + 2] ?? 0) - plane.offset;
      const dc = nx * (p[c] ?? 0) + ny * (p[c + 1] ?? 0) + nz * (p[c + 2] ?? 0) - plane.offset;
      if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
      // The two edge crossings of the triangle, as points.
      const pts: [number, number, number][] = [];
      const edge = (i: number, j: number, di: number, dj: number): void => {
        if ((di > 0 && dj < 0) || (di < 0 && dj > 0)) {
          const t = di / (di - dj);
          pts.push([
            (p[i] ?? 0) + t * ((p[j] ?? 0) - (p[i] ?? 0)),
            (p[i + 1] ?? 0) + t * ((p[j + 1] ?? 0) - (p[i + 1] ?? 0)),
            (p[i + 2] ?? 0) + t * ((p[j + 2] ?? 0) - (p[i + 2] ?? 0)),
          ]);
        } else if (di === 0 && dj !== 0) {
          pts.push([p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0]);
        }
      };
      edge(a, b, da, db);
      edge(b, c, db, dc);
      edge(c, a, dc, da);
      if (pts.length >= 2) {
        const [u, v] = [pts[0], pts[1]] as [Vec3, Vec3];
        total += Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
      }
    }
  }
  return total;
}

export interface SideShares {
  /** The share of the surface area whose face centroid lies on the +normal side. */
  readonly positive: number;
}

export function sideShares(
  facts: FaceFacts,
  plane: NormalizedPlane,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): SideShares {
  let positive = 0;
  const [nx, ny, nz] = plane.normal;
  for (let start = 0; start < facts.areas.length; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(facts.areas.length, start + CHECKPOINT_STRIDE);
    for (let f = start; f < end; f += 1) {
      const d =
        nx * (facts.centroids[f * 3] ?? 0) +
        ny * (facts.centroids[f * 3 + 1] ?? 0) +
        nz * (facts.centroids[f * 3 + 2] ?? 0) -
        plane.offset;
      if (d >= 0) positive += facts.areas[f] ?? 0;
    }
  }
  return { positive: facts.totalArea > 0 ? positive / facts.totalArea : 0 };
}
