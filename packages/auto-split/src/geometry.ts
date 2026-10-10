import type { Vec3 } from '@cadfixer/auto-split-contract';

/**
 * A part's geometry in NORMALIZED coordinates: the bounding-box centre at the origin and the longest
 * side of the box equal to 1. A semantic answer speaks these coordinates, every render uses them, and
 * the plane that comes out of a suggestion is converted back to the part's own with `toSourcePoint`.
 *
 * Nothing here is authoritative geometry: it is a read-only working copy built from a part's canonical
 * buffers inside the worker, discarded when the operation ends.
 */
export interface NormalizedGeometry {
  /** Three Float32 per CORNER, normalized. */
  readonly positions: Float32Array;
  /** Three corner indices per face. */
  readonly indices: Uint32Array;
  readonly faceCount: number;
  /** The bounding-box centre in the part's own coordinates. */
  readonly center: Vec3;
  /** The longest bounding-box side in the part's own coordinates. */
  readonly scale: number;
  /** The bounding-sphere radius of the normalized model about the origin. */
  readonly radius: number;
  /** The bounding box's size along X, Y and Z, normalized (the longest is 1). */
  readonly extents: Vec3;
}

export class DegenerateGeometryError extends Error {
  public constructor() {
    super('The part has no extent to render.');
    this.name = 'DegenerateGeometryError';
  }
}

export function normalizeGeometry(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): NormalizedGeometry {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3)
    for (let a = 0; a < 3; a += 1) {
      const v = positions[i + a] ?? 0;
      if (v < (lo[a] ?? Infinity)) lo[a] = v;
      if (v > (hi[a] ?? -Infinity)) hi[a] = v;
    }
  const size: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const scale = Math.max(size[0], size[1], size[2]);
  if (!(scale > 0) || !Number.isFinite(scale)) throw new DegenerateGeometryError();
  const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const out = new Float32Array(positions.length);
  let max2 = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = ((positions[i] ?? 0) - center[0]) / scale;
    const y = ((positions[i + 1] ?? 0) - center[1]) / scale;
    const z = ((positions[i + 2] ?? 0) - center[2]) / scale;
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
    const d = x * x + y * y + z * z;
    if (d > max2) max2 = d;
  }
  const idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  return {
    positions: out,
    indices: idx,
    faceCount: Math.floor(idx.length / 3),
    center,
    scale,
    radius: Math.max(Math.sqrt(max2), 1e-9),
    extents: [size[0] / scale, size[1] / scale, size[2] / scale],
  };
}

/** A normalized point back in the part's own coordinates. */
export function toSourcePoint(geometry: NormalizedGeometry, point: Vec3): Vec3 {
  return [
    geometry.center[0] + geometry.scale * point[0],
    geometry.center[1] + geometry.scale * point[1],
    geometry.center[2] + geometry.scale * point[2],
  ];
}

export interface FaceFacts {
  /** Surface area of every face, normalized units squared. */
  readonly areas: Float64Array;
  /** Three Float64 per face: the centroid, normalized. */
  readonly centroids: Float64Array;
  readonly totalArea: number;
}

export function faceFacts(geometry: NormalizedGeometry): FaceFacts {
  const { positions: p, indices: idx, faceCount } = geometry;
  const areas = new Float64Array(faceCount);
  const centroids = new Float64Array(faceCount * 3);
  let total = 0;
  for (let f = 0; f < faceCount; f += 1) {
    const a = (idx[f * 3] ?? 0) * 3;
    const b = (idx[f * 3 + 1] ?? 0) * 3;
    const c = (idx[f * 3 + 2] ?? 0) * 3;
    const ux = (p[b] ?? 0) - (p[a] ?? 0);
    const uy = (p[b + 1] ?? 0) - (p[a + 1] ?? 0);
    const uz = (p[b + 2] ?? 0) - (p[a + 2] ?? 0);
    const vx = (p[c] ?? 0) - (p[a] ?? 0);
    const vy = (p[c + 1] ?? 0) - (p[a + 1] ?? 0);
    const vz = (p[c + 2] ?? 0) - (p[a + 2] ?? 0);
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    areas[f] = area;
    total += area;
    centroids[f * 3] = ((p[a] ?? 0) + (p[b] ?? 0) + (p[c] ?? 0)) / 3;
    centroids[f * 3 + 1] = ((p[a + 1] ?? 0) + (p[b + 1] ?? 0) + (p[c + 1] ?? 0)) / 3;
    centroids[f * 3 + 2] = ((p[a + 2] ?? 0) + (p[b + 2] ?? 0) + (p[c + 2] ?? 0)) / 3;
  }
  return { areas, centroids, totalArea: total };
}
