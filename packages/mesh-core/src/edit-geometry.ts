/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion, @typescript-eslint/prefer-for-of, @typescript-eslint/restrict-template-expressions */
import type { CanonicalMesh } from './mesh';
import type { PartTransform } from './document';
import { resourceLimitExceeded, throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import { EditRefusal, MAX_EDIT_REGION_TRIANGLES, MAX_EDIT_SOURCE_TRIANGLES } from './edit-limits';

/** Local geometric predicates never change topology's exact coordinate identity. */
export type EditVector = readonly [number, number, number];
export interface EditPlane {
  readonly origin: EditVector;
  readonly normal: EditVector;
}
export interface EditFrame extends EditPlane {
  readonly tangentU: EditVector;
  readonly tangentV: EditVector;
}
export interface SurfaceRegion {
  readonly seedTriangle: number;
  readonly triangleIds: readonly number[];
  readonly frame: EditFrame;
  readonly planarity: RegionPlanarity;
}
export type PlanarityKind = 'PLANAR' | 'NEAR_PLANAR' | 'NON_PLANAR';
export interface RegionPlanarity {
  readonly kind: PlanarityKind;
  readonly maxDistance: number;
  readonly maxNormalAngleRadians: number;
  readonly distanceTolerance: number;
  readonly angleToleranceRadians: number;
}
export interface RegionGrowthOptions {
  readonly maxNormalAngleRadians: number;
  readonly maxTriangles: number;
  readonly cancellation?: CancellationToken;
}

const sub = (a: EditVector, b: EditVector): EditVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: EditVector, b: EditVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: EditVector, b: EditVector): EditVector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: EditVector): number => Math.hypot(...a);
function unit(a: EditVector): EditVector {
  const n = length(a);
  if (!Number.isFinite(n) || n <= 1e-30)
    throw new Error('Editing frame has a degenerate direction.');
  return [a[0] / n, a[1] / n, a[2] / n];
}
function point(mesh: CanonicalMesh, index: number): EditVector {
  const at = index * 3,
    p = mesh.positions;
  const v: EditVector = [p[at] ?? NaN, p[at + 1] ?? NaN, p[at + 2] ?? NaN];
  if (!v.every(Number.isFinite)) throw new Error('Editing surface has a non-finite vertex.');
  return v;
}
function corners(
  mesh: CanonicalMesh,
  triangle: number,
): readonly [EditVector, EditVector, EditVector] {
  const at = triangle * 3,
    ids = mesh.indices;
  if (!Number.isSafeInteger(triangle) || triangle < 0 || at + 2 >= ids.length)
    throw new Error('Editing triangle is out of range.');
  return [
    point(mesh, ids[at] ?? -1),
    point(mesh, ids[at + 1] ?? -1),
    point(mesh, ids[at + 2] ?? -1),
  ];
}
export function triangleEditNormal(mesh: CanonicalMesh, triangle: number): EditVector {
  const [a, b, c] = corners(mesh, triangle);
  return unit(cross(sub(b, a), sub(c, a)));
}
/** `normal` points to the positive side; tolerance is explicit and operation-local. */
export function classifyEditPlane(
  plane: EditPlane,
  pointInWorld: EditVector,
  tolerance: number,
): -1 | 0 | 1 {
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new Error('Plane tolerance must be finite and nonnegative.');
  const distance = dot(sub(pointInWorld, plane.origin), unit(plane.normal));
  if (!Number.isFinite(distance)) throw new Error('Plane classification is non-finite.');
  return distance > tolerance ? 1 : distance < -tolerance ? -1 : 0;
}
/** Stable right-handed frame; coordinates and arithmetic remain Float64. */
export function createEditFrame(origin: EditVector, normal: EditVector): EditFrame {
  if (!origin.every(Number.isFinite)) throw new Error('Editing frame origin is non-finite.');
  const n = unit(normal);
  const axis: EditVector = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = unit(cross(axis, n));
  return { origin, normal: n, tangentU: u, tangentV: unit(cross(n, u)) };
}
/** Row-vector 3MF placement, retaining the mesh in part-local coordinates. */
export function transformEditPoint(p: EditVector, m: PartTransform): EditVector {
  return [
    p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9],
    p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10],
    p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11],
  ];
}
export function transformEditNormal(n: EditVector, m: PartTransform): EditVector {
  // Inverse transpose for a row-vector affine transform; cofactors suffice because
  // the final normal is normalized. Reflections retain the correct face orientation.
  const a = m[0],
    b = m[1],
    c = m[2],
    d = m[3],
    e = m[4],
    f = m[5],
    g = m[6],
    h = m[7],
    i = m[8];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-30)
    throw new Error('Part transform is singular.');
  const sign = Math.sign(determinant);
  return unit([
    (n[0] * (e * i - f * h) + n[1] * (c * h - b * i) + n[2] * (b * f - c * e)) * sign,
    (n[0] * (f * g - d * i) + n[1] * (a * i - c * g) + n[2] * (c * d - a * f)) * sign,
    (n[0] * (d * h - e * g) + n[1] * (b * g - a * h) + n[2] * (a * e - b * d)) * sign,
  ]);
}

/** Bounded edge-connected traversal. Adjacency uses exact stored coordinates. */
export function growEditRegion(
  mesh: CanonicalMesh,
  seedTriangle: number,
  options: RegionGrowthOptions,
): number[] {
  const faces = mesh.indices.length / 3;
  if (!Number.isSafeInteger(seedTriangle) || seedTriangle < 0 || seedTriangle >= faces)
    throw new Error('Seed triangle is out of range.');
  if (
    !Number.isSafeInteger(options.maxTriangles) ||
    options.maxTriangles < 1 ||
    options.maxTriangles > MAX_EDIT_REGION_TRIANGLES
  )
    throw new Error('Region triangle budget must be 1..100000.');
  if (
    !Number.isFinite(options.maxNormalAngleRadians) ||
    options.maxNormalAngleRadians < 0 ||
    options.maxNormalAngleRadians > Math.PI
  )
    throw new Error('Invalid normal-angle threshold.');
  // Refuse scanning an unbounded source even if the requested output is small.
  if (faces > MAX_EDIT_SOURCE_TRIANGLES)
    throw resourceLimitExceeded(
      `This part has ${String(faces)} triangles; a surface can be selected on a part of at most ${String(MAX_EDIT_SOURCE_TRIANGLES)}.`,
      {
        reason: EditRefusal.SourceTooLarge,
        metric: 'sourceTriangles',
        observed: faces,
        limit: MAX_EDIT_SOURCE_TRIANGLES,
      },
    );
  const edgeMap = new Map<string, number[]>();
  const key = (v: EditVector) => `${v[0]},${v[1]},${v[2]}`;
  for (let t = 0; t < faces; t++) {
    if ((t & 1023) === 0 && options.cancellation) throwIfCancelled(options.cancellation);
    const c = corners(mesh, t);
    for (let e = 0; e < 3; e++) {
      const a = key(c[e]!),
        b = key(c[(e + 1) % 3]!);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      const incident = edgeMap.get(edge);
      if (incident) incident.push(t);
      else edgeMap.set(edge, [t]);
    }
  }
  const seed = triangleEditNormal(mesh, seedTriangle),
    included = new Set<number>([seedTriangle]),
    queue = [seedTriangle];
  for (let at = 0; at < queue.length; at++) {
    if (options.cancellation) throwIfCancelled(options.cancellation);
    const c = corners(mesh, queue[at]!);
    for (let e = 0; e < 3; e++) {
      const a = key(c[e]!),
        b = key(c[(e + 1) % 3]!);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      for (const next of edgeMap.get(edge) ?? []) {
        if (included.has(next)) continue;
        const angle = Math.acos(
          Math.max(-1, Math.min(1, dot(seed, triangleEditNormal(mesh, next)))),
        );
        if (angle > options.maxNormalAngleRadians) continue;
        if (included.size >= options.maxTriangles)
          throw resourceLimitExceeded(
            `The selected surface has more than ${String(options.maxTriangles)} triangles, the most one selection can hold.`,
            {
              reason: EditRefusal.RegionTooLarge,
              metric: 'regionTriangles',
              limit: options.maxTriangles,
            },
          );
        included.add(next);
        queue.push(next);
      }
    }
  }
  return queue.sort((a, b) => a - b);
}
export function measureEditPlanarity(
  mesh: CanonicalMesh,
  triangles: readonly number[],
  frame: EditFrame,
  distanceTolerance: number,
  angleToleranceRadians: number,
): RegionPlanarity {
  if (triangles.length === 0 || triangles.length > 100_000)
    throw new Error('Region triangle count is outside 1..100000.');
  if (
    !Number.isFinite(distanceTolerance) ||
    distanceTolerance < 0 ||
    !Number.isFinite(angleToleranceRadians) ||
    angleToleranceRadians < 0
  )
    throw new Error('Invalid planarity tolerance.');
  let maxDistance = 0,
    maxAngle = 0;
  for (const t of triangles) {
    const normal = triangleEditNormal(mesh, t);
    maxAngle = Math.max(maxAngle, Math.acos(Math.max(-1, Math.min(1, dot(normal, frame.normal)))));
    for (const p of corners(mesh, t))
      maxDistance = Math.max(maxDistance, Math.abs(dot(sub(p, frame.origin), frame.normal)));
  }
  const kind: PlanarityKind =
    maxDistance <= distanceTolerance && maxAngle <= angleToleranceRadians
      ? 'PLANAR'
      : maxDistance <= distanceTolerance * 2 && maxAngle <= angleToleranceRadians * 2
        ? 'NEAR_PLANAR'
        : 'NON_PLANAR';
  return {
    kind,
    maxDistance,
    maxNormalAngleRadians: maxAngle,
    distanceTolerance,
    angleToleranceRadians,
  };
}
export function selectEditSurface(
  mesh: CanonicalMesh,
  seedTriangle: number,
  options: RegionGrowthOptions,
  distanceTolerance: number,
): SurfaceRegion {
  const triangleIds = growEditRegion(mesh, seedTriangle, options),
    origin = corners(mesh, seedTriangle)[0];
  const frame = createEditFrame(origin, triangleEditNormal(mesh, seedTriangle));
  return {
    seedTriangle,
    triangleIds,
    frame,
    planarity: measureEditPlanarity(
      mesh,
      triangleIds,
      frame,
      distanceTolerance,
      options.maxNormalAngleRadians,
    ),
  };
}
