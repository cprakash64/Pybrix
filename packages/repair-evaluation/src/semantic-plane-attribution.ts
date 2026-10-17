import { requiredValue } from './semantic-invariant';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { digest, meshDigest } from './semantic-fixture';

/** Frozen prospectively: no geometric snapping; only relative floating point drift is clamped. */
export const FRACTION_TOLERANCE = 1e-10;
export interface SourcePlane {
  normal: readonly number[];
  origin: readonly number[];
}
export type SelectedSide = 'POSITIVE' | 'NEGATIVE';
export interface SourcePlaneAttribution {
  status:
    | 'WHOLE_FACE_EXACT'
    | 'FRACTIONAL_CLIPPED'
    | 'UNSUPPORTED_COPLANAR'
    | 'INVALID_SOURCE'
    | 'INVALID_PLANE';
  sourceHash: string;
  plane: SourcePlane | null;
  planeHash: string;
  operationId: string;
  selectedSide: SelectedSide;
  weights: number[] | null;
  complementWeights: number[] | null;
  selectedMass: number | null;
  selectedSurfaceArea: number | null;
  triangles: number;
  straddling: number;
  elapsedMs: number;
  /** Upper bound on live scratch coordinates, excluding returned O(N) weight arrays. */
  scratchCoordinateBound: number;
  reason?: string;
}
type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const area = (p: V[]): number => {
  const a = p[0];
  if (!a) return 0;
  let sum = 0;
  for (let i = 1; i + 1 < p.length; i++)
    sum += Math.hypot(...cross(sub(requiredValue(p[i]), a), sub(requiredValue(p[i + 1]), a))) / 2;
  return sum;
};
/** Clip in a translated triangle frame, retaining boundary vertices on both sides. */
function clip(p: V[], distances: number[], side: number): V[] {
  const out: V[] = [];
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length,
      a = requiredValue(p[i]),
      b = requiredValue(p[j]),
      da = requiredValue(distances[i]) * side,
      db = requiredValue(distances[j]) * side;
    if (da >= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return out;
}
/** Research only. Original source triangles, no output geometry or correspondence heuristics. */
export function attributeSourcePlane(
  mesh: CanonicalMesh,
  plane: SourcePlane | null,
  operationId: string,
  selectedSide: SelectedSide = 'POSITIVE',
  signal?: AbortSignal,
): SourcePlaneAttribution {
  const start = performance.now();
  const result: SourcePlaneAttribution = {
    status: 'INVALID_SOURCE',
    plane: plane ? { normal: [...plane.normal], origin: [...plane.origin] } : null,
    sourceHash: meshDigest(mesh),
    planeHash: digest(plane),
    operationId,
    selectedSide,
    weights: null,
    complementWeights: null,
    selectedMass: null,
    selectedSurfaceArea: null,
    triangles: mesh.indices.length / 3,
    straddling: 0,
    elapsedMs: 0,
    scratchCoordinateBound: 48,
  };
  const fail = (
    status: SourcePlaneAttribution['status'],
    reason: string,
  ): SourcePlaneAttribution => ({
    ...result,
    status,
    reason,
    elapsedMs: performance.now() - start,
  });
  if (
    plane?.normal.length !== 3 ||
    plane.origin.length !== 3 ||
    ![...plane.normal, ...plane.origin].every(Number.isFinite) ||
    !['POSITIVE', 'NEGATIVE'].includes(selectedSide)
  )
    return fail('INVALID_PLANE', 'INVALID_PLANE');
  const length = Math.hypot(...plane.normal);
  if (!Number.isFinite(length) || length === 0) return fail('INVALID_PLANE', 'INVALID_NORMAL');
  const normal = plane.normal.map((v) => v / length);
  if (mesh.indices.length === 0 || mesh.indices.length % 3 || mesh.positions.length % 3)
    return fail('INVALID_SOURCE', 'INVALID_ARRAY_LENGTH');
  const weights: number[] = [],
    complement: number[] = [];
  let mass = 0,
    surface = 0,
    complementMass = 0,
    coplanar = false;
  for (let face = 0; face < result.triangles; face++) {
    if ((face & 1023) === 0 && signal?.aborted) return fail('INVALID_SOURCE', 'ABORTED');
    const vertices: V[] = [];
    for (let k = 0; k < 3; k++) {
      const index = mesh.indices[face * 3 + k];
      if (
        index === undefined ||
        !Number.isInteger(index) ||
        index < 0 ||
        index * 3 + 2 >= mesh.positions.length
      )
        return fail('INVALID_SOURCE', 'INVALID_INDEX');
      const p: V = [
        requiredValue(mesh.positions[index * 3]),
        requiredValue(mesh.positions[index * 3 + 1]),
        requiredValue(mesh.positions[index * 3 + 2]),
      ];
      if (!p.every(Number.isFinite)) return fail('INVALID_SOURCE', 'NONFINITE_VERTEX');
      vertices.push(p);
    }
    const origin = requiredValue(vertices[0]);
    const local = vertices.map((p) => sub(p, origin));
    const originalArea = area(local);
    if (!Number.isFinite(originalArea) || originalArea <= 0)
      return fail('INVALID_SOURCE', 'ZERO_OR_INVALID_AREA');
    const distances = vertices.map((p) =>
      normal.reduce((s, n, a) => s + n * (requiredValue(p[a]) - requiredValue(plane.origin[a])), 0),
    );
    if (!distances.every(Number.isFinite)) return fail('INVALID_SOURCE', 'NONFINITE_DISTANCE');
    const min = Math.min(...distances),
      max = Math.max(...distances);
    if (min === 0 && max === 0) {
      coplanar = true;
      continue;
    }
    let positive: number, negative: number;
    if (min >= 0) {
      positive = 1;
      negative = 0;
    } else if (max <= 0) {
      positive = 0;
      negative = 1;
    } else {
      result.straddling++;
      positive = area(clip(local, distances, 1)) / originalArea;
      negative = area(clip(local, distances, -1)) / originalArea;
    }
    if (
      !Number.isFinite(positive) ||
      !Number.isFinite(negative) ||
      positive < -FRACTION_TOLERANCE ||
      negative < -FRACTION_TOLERANCE ||
      positive > 1 + FRACTION_TOLERANCE ||
      negative > 1 + FRACTION_TOLERANCE ||
      Math.abs(positive + negative - 1) > FRACTION_TOLERANCE
    )
      return fail('INVALID_SOURCE', 'FRACTION_CONSERVATION');
    positive = Math.max(0, Math.min(1, positive));
    negative = Math.max(0, Math.min(1, negative));
    const w = selectedSide === 'POSITIVE' ? positive : negative,
      c = selectedSide === 'POSITIVE' ? negative : positive;
    weights.push(w);
    complement.push(c);
    mass += w;
    complementMass += c;
    surface += w * originalArea;
  }
  if (coplanar) return fail('UNSUPPORTED_COPLANAR', 'COPLANAR_OWNERSHIP_UNPROVEN');
  if (Math.abs(mass + complementMass - result.triangles) > FRACTION_TOLERANCE * result.triangles)
    return fail('INVALID_SOURCE', 'AGGREGATE_CONSERVATION');
  return {
    ...result,
    status: result.straddling ? 'FRACTIONAL_CLIPPED' : 'WHOLE_FACE_EXACT',
    weights,
    complementWeights: complement,
    selectedMass: mass,
    selectedSurfaceArea: surface,
    elapsedMs: performance.now() - start,
  };
}
/** Face-count metric: area is used only to partition each individual face's unit mass. */
export function fractionalSourceAgreement(
  weights: readonly number[],
  target: readonly number[],
): { precision: number; recall: number } {
  const truth = new Set(target),
    selectedMass = weights.reduce((s, w) => s + w, 0);
  let overlap = 0;
  for (const face of truth) overlap += weights[face] ?? 0;
  return {
    precision: selectedMass ? overlap / selectedMass : 0,
    recall: truth.size ? overlap / truth.size : 0,
  };
}
