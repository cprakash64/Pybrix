import {
  computeBounds,
  createIndexArray,
  createPositionArray,
  exactVertexKey,
  MAX_EDIT_REGION_TRIANGLES,
  selectEditSurface,
  type CanonicalMesh,
  type EditFrame,
  type EditVector,
  type SurfaceRegion,
} from '@cadfixer/mesh-core';
import {
  invalidState,
  resourceLimitExceeded,
  throwIfCancelled,
  type CancellationToken,
} from '@cadfixer/shared';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { runValidatedBoolean, type BooleanBackend } from './boolean-adapter';

export type TexturePattern = 'dots' | 'lines' | 'diamond';
export type TextureMode = 'emboss' | 'engrave';
export interface SurfaceTextureRequest {
  readonly seedTriangle: number;
  readonly pattern: TexturePattern;
  readonly mode: TextureMode;
  /** Dot diameter, or line/diamond width, in document units. */
  readonly featureSize: number;
  /** Centre-to-centre pitch in document units. */
  readonly spacing: number;
  readonly heightOrDepth: number;
  readonly rotationDegrees: number;
  readonly edgeMargin?: number;
}
export interface TexturePatternInstance {
  readonly localCenterU: number;
  readonly localCenterV: number;
  readonly orientationRadians: number;
  readonly width: number;
  readonly length: number;
  readonly kind: 'circle' | 'bar';
}
export interface SurfaceTextureLayout {
  readonly region: SurfaceRegion;
  readonly instances: readonly TexturePatternInstance[];
  readonly edgeMargin: number;
  readonly interfaceOverlap: number;
  readonly estimatedPrimitiveTriangles: number;
}
export interface SurfaceTextureResult {
  readonly mesh: CanonicalMesh;
  readonly pattern: TexturePattern;
  readonly mode: TextureMode;
  readonly elementCount: number;
  readonly sourceTriangleCount: number;
  readonly candidateTriangleCount: number;
  readonly planarity: SurfaceRegion['planarity'];
  readonly edgeMargin: number;
  readonly interfaceOverlap: number;
}

export const MAX_TEXTURE_ELEMENTS = 500;
export const MAX_TEXTURE_PRIMITIVE_TRIANGLES = 64_000;
const CIRCLE_SEGMENTS = 24;
const MAX_REGION_TRIANGLES = MAX_EDIT_REGION_TRIANGLES;
const NORMAL_ANGLE = (2 * Math.PI) / 180;

type Point2 = readonly [number, number];
interface ProjectedRegion {
  readonly triangles: readonly (readonly [Point2, Point2, Point2])[];
  readonly boundary: readonly { readonly a: Point2; readonly b: Point2 }[];
  readonly minU: number;
  readonly maxU: number;
  readonly minV: number;
  readonly maxV: number;
}
const add = (a: EditVector, b: EditVector): EditVector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: EditVector, s: number): EditVector => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: EditVector, b: EditVector): EditVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: EditVector, b: EditVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function vertex(mesh: CanonicalMesh, id: number): EditVector {
  const at = id * 3;
  return [mesh.positions[at] ?? NaN, mesh.positions[at + 1] ?? NaN, mesh.positions[at + 2] ?? NaN];
}
function local(frame: EditFrame, point: EditVector): Point2 {
  const relative = sub(point, frame.origin);
  return [dot(relative, frame.tangentU), dot(relative, frame.tangentV)];
}
function pointInTriangle(p: Point2, [a, b, c]: readonly [Point2, Point2, Point2]): boolean {
  const sign = (p1: Point2, p2: Point2, p3: Point2): number =>
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign(p, a, b),
    d2 = sign(p, b, c),
    d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function segmentDistance(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    squared = dx * dx + dy * dy;
  if (squared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / squared));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
/**
 * The selected region in the face's own plane: each triangle's corners and the BOUNDARY edges,
 * those used by exactly one triangle of the region.
 *
 * Whether two triangles share an edge is a question about EXACT STORED COORDINATES (ADR 0009),
 * never about vertex indices. An STL import is triangle soup, so every corner has its own index and
 * index pairs say no two triangles touch: every edge looked like a boundary, no element could keep
 * its margin from it, and an STL model could not be textured at all (TEXTURE-FIX-01, D1). Each
 * distinct vertex is identified once and edges are keyed by the two identities, so the cost
 * is the region's, not the part's.
 */
function projectedRegion(mesh: CanonicalMesh, region: SurfaceRegion): ProjectedRegion {
  const incidence = new Map<string, { count: number; a: Point2; b: Point2 }>();
  const identityOfVertex = new Map<number, number>();
  const identityOfPoint = new Map<string, number>();
  const identify = (vertexId: number): number => {
    const known = identityOfVertex.get(vertexId);
    if (known !== undefined) return known;
    const key = exactVertexKey(mesh.positions, vertexId);
    let identity = identityOfPoint.get(key);
    if (identity === undefined) {
      identity = identityOfPoint.size;
      identityOfPoint.set(key, identity);
    }
    identityOfVertex.set(vertexId, identity);
    return identity;
  };
  const triangles: [Point2, Point2, Point2][] = [];
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (const triangleId of region.triangleIds) {
    const at = triangleId * 3;
    const ids = [mesh.indices[at] ?? -1, mesh.indices[at + 1] ?? -1, mesh.indices[at + 2] ?? -1];
    const points = ids.map((id) => local(region.frame, vertex(mesh, id))) as [
      Point2,
      Point2,
      Point2,
    ];
    triangles.push(points);
    for (const point of points) {
      minU = Math.min(minU, point[0]);
      maxU = Math.max(maxU, point[0]);
      minV = Math.min(minV, point[1]);
      maxV = Math.max(maxV, point[1]);
    }
    for (let edge = 0; edge < 3; edge++) {
      const ai = identify(ids[edge] ?? -1),
        bi = identify(ids[(edge + 1) % 3] ?? -1);
      const key = ai < bi ? `${String(ai)}:${String(bi)}` : `${String(bi)}:${String(ai)}`;
      const previous = incidence.get(key);
      if (previous) previous.count++;
      else
        incidence.set(key, {
          count: 1,
          a: points[edge] ?? [NaN, NaN],
          b: points[(edge + 1) % 3] ?? [NaN, NaN],
        });
    }
  }
  return {
    triangles,
    boundary: [...incidence.values()].filter((edge) => edge.count === 1),
    minU,
    maxU,
    minV,
    maxV,
  };
}
function contains(region: ProjectedRegion, samples: readonly Point2[], margin: number): boolean {
  return samples.every(
    (point) =>
      region.triangles.some((triangle) => pointInTriangle(point, triangle)) &&
      region.boundary.every((edge) => segmentDistance(point, edge.a, edge.b) >= margin),
  );
}
function circleSamples(u: number, v: number, radius: number): Point2[] {
  return Array.from({ length: 16 }, (_, index) => {
    const angle = (index * Math.PI * 2) / 16;
    return [u + Math.cos(angle) * radius, v + Math.sin(angle) * radius] as Point2;
  });
}
function barSamples(u: number, v: number, width: number, length: number, angle: number): Point2[] {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    hu = length / 2,
    hv = width / 2;
  const result: Point2[] = [];
  const steps = Math.max(2, Math.min(256, Math.ceil(length / Math.max(width, 1e-9))));
  for (let step = 0; step <= steps; step++) {
    const x = -hu + (length * step) / steps;
    for (const y of [-hv, 0, hv]) result.push([u + x * c - y * s, v + x * s + y * c]);
  }
  return result;
}
function lineIntervals(
  region: ProjectedRegion,
  orientation: number,
  crossCoordinate: number,
): readonly (readonly [number, number])[] {
  const c = Math.cos(orientation),
    s = Math.sin(orientation),
    intervals: [number, number][] = [];
  for (const triangle of region.triangles) {
    const points = triangle.map(([u, v]) => [u * c + v * s, -u * s + v * c] as const);
    const crossings: number[] = [];
    for (let edge = 0; edge < 3; edge++) {
      const a = points[edge],
        b = points[(edge + 1) % 3];
      if (!a || !b) continue;
      if (Math.abs(a[1] - crossCoordinate) < 1e-12) crossings.push(a[0]);
      if (
        (a[1] < crossCoordinate && b[1] > crossCoordinate) ||
        (b[1] < crossCoordinate && a[1] > crossCoordinate)
      ) {
        const t = (crossCoordinate - a[1]) / (b[1] - a[1]);
        crossings.push(a[0] + t * (b[0] - a[0]));
      }
    }
    crossings.sort((a, b) => a - b);
    if (crossings.length >= 2)
      intervals.push([crossings[0] ?? 0, crossings[crossings.length - 1] ?? 0]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval[0] <= previous[1] + 1e-9)
      previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([interval[0], interval[1]]);
  }
  return merged;
}
function finiteDimension(value: number, name: string, allowZero = false): void {
  if (!Number.isFinite(value) || value < (allowZero ? 0 : 1e-6) || value > 1_000_000)
    throw invalidState(`${name} is outside the supported range.`, { value });
}
function requireSource(mesh: CanonicalMesh, cancellation: CancellationToken): void {
  const report = analyseTopology(mesh, {
    documentId: 'texture',
    documentRevision: 0,
    partId: 'source',
    cancellation,
    sampleLimit: 0,
    componentSummaryLimit: 1,
  }).report;
  if (
    report.boundaryEdgeCount ||
    report.nonManifoldEdgeCount ||
    report.nonManifoldVertexCount ||
    report.windingConflictEdgeCount ||
    report.zeroAreaFaceCount ||
    report.repeatedPositionFaceCount
  )
    throw invalidState(
      'This part is not a closed manifold solid. Run Repair or choose another part.',
    );
}
export function buildSurfaceTextureLayout(
  mesh: CanonicalMesh,
  request: SurfaceTextureRequest,
  cancellation: CancellationToken,
): SurfaceTextureLayout {
  finiteDimension(request.featureSize, request.pattern === 'dots' ? 'Dot diameter' : 'Line width');
  finiteDimension(request.spacing, 'Spacing');
  finiteDimension(request.heightOrDepth, request.mode === 'emboss' ? 'Height' : 'Depth');
  if (
    !Number.isFinite(request.rotationDegrees) ||
    request.rotationDegrees < 0 ||
    request.rotationDegrees > 180
  )
    throw invalidState('Rotation must be between 0 and 180 degrees.');
  if (request.spacing < request.featureSize)
    throw invalidState('Spacing is centre-to-centre and must be at least the feature size.');
  const bounds = computeBounds(mesh);
  if (!bounds) throw invalidState('The selected part has no geometry.');
  const diagonal = Math.max(bounds.radius * 2, 1e-9);
  if (
    request.featureSize > diagonal ||
    request.spacing > diagonal * 2 ||
    request.heightOrDepth > diagonal / 2
  )
    throw invalidState('Texture dimensions are too large for this part.');
  const distanceTolerance = Math.max(diagonal * 1e-7, 1e-9);
  const region = selectEditSurface(
    mesh,
    request.seedTriangle,
    { maxNormalAngleRadians: NORMAL_ANGLE, maxTriangles: MAX_REGION_TRIANGLES, cancellation },
    distanceTolerance,
  );
  if (region.planarity.kind !== 'PLANAR')
    throw invalidState(
      'This texture tool currently supports flat surfaces. Choose a flatter surface.',
      { planarity: region.planarity.kind },
    );
  const projection = projectedRegion(mesh, region);
  const edgeMargin = request.edgeMargin ?? Math.max(request.featureSize * 0.25, diagonal * 1e-6);
  finiteDimension(edgeMargin, 'Texture edge margin', true);
  const angle = (request.rotationDegrees * Math.PI) / 180;
  const instances: TexturePatternInstance[] = [];
  const admit = (instance: TexturePatternInstance, samples: readonly Point2[]): void => {
    if (!contains(projection, samples, edgeMargin)) return;
    if (instances.length >= MAX_TEXTURE_ELEMENTS)
      throw resourceLimitExceeded(
        `Texture element count is greater than ${String(MAX_TEXTURE_ELEMENTS)}; limit is ${String(MAX_TEXTURE_ELEMENTS)}.`,
        { metric: 'textureElements', observed: instances.length + 1, limit: MAX_TEXTURE_ELEMENTS },
      );
    instances.push(instance);
  };
  const anchorU = Math.floor(projection.minU / request.spacing) * request.spacing;
  const anchorV = Math.floor(projection.minV / request.spacing) * request.spacing;
  if (request.pattern === 'dots') {
    const radius = request.featureSize / 2;
    for (let v = anchorV; v <= projection.maxV; v += request.spacing)
      for (let u = anchorU; u <= projection.maxU; u += request.spacing) {
        throwIfCancelled(cancellation);
        admit(
          {
            localCenterU: u,
            localCenterV: v,
            orientationRadians: 0,
            width: request.featureSize,
            length: request.featureSize,
            kind: 'circle',
          },
          circleSamples(u, v, radius),
        );
      }
  } else {
    const families =
      request.pattern === 'diamond' ? [angle + Math.PI / 4, angle - Math.PI / 4] : [angle];
    for (const orientation of families) {
      const c = Math.cos(orientation),
        s = Math.sin(orientation),
        crossValues = projection.triangles
          .flatMap((triangle) => triangle)
          .map(([u, v]) => -u * s + v * c),
        minimumCross = Math.min(...crossValues),
        maximumCross = Math.max(...crossValues),
        anchorCross = Math.floor(minimumCross / request.spacing) * request.spacing;
      for (
        let crossCoordinate = anchorCross;
        crossCoordinate <= maximumCross;
        crossCoordinate += request.spacing
      )
        for (const interval of lineIntervals(projection, orientation, crossCoordinate)) {
          throwIfCancelled(cancellation);
          // The interval is measured on the bar centreline. Conservatively
          // reserve a full width at each end as well as the explicit margin so
          // rotated strip corners remain inside sloping/concave boundaries.
          const inset = edgeMargin + request.featureSize,
            start = interval[0] + inset,
            end = interval[1] - inset,
            length = end - start;
          if (length < request.featureSize) continue;
          const along = (start + end) / 2,
            u = along * c - crossCoordinate * s,
            v = along * s + crossCoordinate * c;
          admit(
            {
              localCenterU: u,
              localCenterV: v,
              orientationRadians: orientation,
              width: request.featureSize,
              length,
              kind: 'bar',
            },
            barSamples(u, v, request.featureSize, length, orientation),
          );
        }
    }
  }
  if (!instances.length)
    throw invalidState('No texture elements fit inside this surface and its edge margin.');
  const perElement = request.pattern === 'dots' ? CIRCLE_SEGMENTS * 4 - 4 : 12;
  const estimatedPrimitiveTriangles = instances.length * perElement;
  if (estimatedPrimitiveTriangles > MAX_TEXTURE_PRIMITIVE_TRIANGLES)
    throw resourceLimitExceeded(
      `Texture primitive triangle estimate is ${String(estimatedPrimitiveTriangles)}; limit is ${String(MAX_TEXTURE_PRIMITIVE_TRIANGLES)}.`,
      {
        metric: 'texturePrimitiveTriangles',
        observed: estimatedPrimitiveTriangles,
        limit: MAX_TEXTURE_PRIMITIVE_TRIANGLES,
      },
    );
  return {
    region,
    instances,
    edgeMargin,
    interfaceOverlap: Math.max(diagonal * 1e-6, request.heightOrDepth * 1e-4),
    estimatedPrimitiveTriangles,
  };
}
function pointFromLocal(frame: EditFrame, u: number, v: number, n: number): EditVector {
  return add(
    frame.origin,
    add(scale(frame.tangentU, u), add(scale(frame.tangentV, v), scale(frame.normal, n))),
  );
}
const BOX_INDICES = [
  0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7,
  1, 7, 5,
];
function appendBox(
  positions: number[],
  indices: number[],
  frame: EditFrame,
  instance: TexturePatternInstance,
  low: number,
  high: number,
): void {
  const base = positions.length / 3,
    c = Math.cos(instance.orientationRadians),
    s = Math.sin(instance.orientationRadians);
  for (const n of [low, high])
    for (const y of [-instance.width / 2, instance.width / 2])
      for (const x of [-instance.length / 2, instance.length / 2]) {
        const u = instance.localCenterU + x * c - y * s,
          v = instance.localCenterV + x * s + y * c;
        positions.push(...pointFromLocal(frame, u, v, n));
      }
  indices.push(...BOX_INDICES.map((value) => value + base));
}
function appendCylinder(
  positions: number[],
  indices: number[],
  frame: EditFrame,
  instance: TexturePatternInstance,
  low: number,
  high: number,
): void {
  const base = positions.length / 3,
    radius = instance.width / 2;
  for (const n of [low, high])
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i * Math.PI * 2) / CIRCLE_SEGMENTS;
      positions.push(
        ...pointFromLocal(
          frame,
          instance.localCenterU + Math.cos(a) * radius,
          instance.localCenterV + Math.sin(a) * radius,
          n,
        ),
      );
    }
  for (let i = 1; i + 1 < CIRCLE_SEGMENTS; i++)
    indices.push(
      base,
      base + i + 1,
      base + i,
      base + CIRCLE_SEGMENTS,
      base + CIRCLE_SEGMENTS + i,
      base + CIRCLE_SEGMENTS + i + 1,
    );
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const j = (i + 1) % CIRCLE_SEGMENTS;
    indices.push(
      base + i,
      base + j,
      base + CIRCLE_SEGMENTS + j,
      base + i,
      base + CIRCLE_SEGMENTS + j,
      base + CIRCLE_SEGMENTS + i,
    );
  }
}
export function buildSurfaceTextureOperand(
  layout: SurfaceTextureLayout,
  request: SurfaceTextureRequest,
  cancellation: CancellationToken,
): CanonicalMesh {
  const positions: number[] = [],
    indices: number[] = [];
  const low = request.mode === 'emboss' ? -layout.interfaceOverlap : -request.heightOrDepth;
  const high = request.mode === 'emboss' ? request.heightOrDepth : layout.interfaceOverlap;
  for (const instance of layout.instances) {
    throwIfCancelled(cancellation);
    if (instance.kind === 'circle')
      appendCylinder(positions, indices, layout.region.frame, instance, low, high);
    else appendBox(positions, indices, layout.region.frame, instance, low, high);
  }
  const p = createPositionArray(positions.length),
    i = createIndexArray(indices.length);
  p.set(positions);
  i.set(indices);
  return { positions: p, indices: i, metadata: {} };
}
export async function textureSurface(
  backend: BooleanBackend,
  source: CanonicalMesh,
  request: SurfaceTextureRequest,
  cancellation: CancellationToken,
): Promise<SurfaceTextureResult> {
  throwIfCancelled(cancellation);
  requireSource(source, cancellation);
  const layout = buildSurfaceTextureLayout(source, request, cancellation);
  let operand: CanonicalMesh;
  if (request.pattern === 'diamond') {
    const orientations = [
      ...new Set(layout.instances.map((instance) => instance.orientationRadians)),
    ];
    const families = orientations.map((orientation) =>
      buildSurfaceTextureOperand(
        {
          ...layout,
          instances: layout.instances.filter(
            (instance) => instance.orientationRadians === orientation,
          ),
        },
        request,
        cancellation,
      ),
    );
    const first = families[0];
    if (!first) throw invalidState('No complete Diamond line family fits this surface.');
    const second = families[1];
    // Each family is non-overlapping. Normalize their crossings once before
    // using the lattice as the source Boolean operand; this avoids feeding a
    // knowingly self-overlapping solid soup to Manifold.
    operand = second
      ? (await runValidatedBoolean(backend, 'union', first, second, cancellation)).mesh
      : first;
  } else {
    operand = buildSurfaceTextureOperand(layout, request, cancellation);
  }
  const result = await runValidatedBoolean(
    backend,
    request.mode === 'emboss' ? 'union' : 'difference',
    source,
    operand,
    cancellation,
  );
  return {
    mesh: result.mesh,
    pattern: request.pattern,
    mode: request.mode,
    elementCount: layout.instances.length,
    sourceTriangleCount: source.indices.length / 3,
    candidateTriangleCount: result.mesh.indices.length / 3,
    planarity: layout.region.planarity,
    edgeMargin: layout.edgeMargin,
    interfaceOverlap: layout.interfaceOverlap,
  };
}

/**
 * WHAT A TEXTURE WOULD PLACE, WITHOUT BUILDING IT — UI-04's "fast preview".
 *
 * The same `buildSurfaceTextureLayout` the Boolean path runs first, so the
 * admission rules, the refusals and the element positions are the ones Apply
 * would use. No operand is built and no Boolean runs. `footprint` is every
 * element's outline on the surface (pairs of part-local points): the exact
 * 24-sided circle or rectangle the engine will extrude, not an approximation.
 */
export interface TextureLayoutSummary {
  readonly elementCount: number;
  readonly estimatedPrimitiveTriangles: number;
  readonly edgeMargin: number;
  readonly footprint: Float32Array;
}

export function describeTextureLayout(
  mesh: CanonicalMesh,
  request: SurfaceTextureRequest,
  cancellation: CancellationToken,
): TextureLayoutSummary {
  requireSource(mesh, cancellation);
  const layout = buildSurfaceTextureLayout(mesh, request, cancellation);
  const frame = layout.region.frame;
  const segments: number[] = [];
  const edge = (a: Point2, b: Point2): void => {
    segments.push(...pointFromLocal(frame, a[0], a[1], 0), ...pointFromLocal(frame, b[0], b[1], 0));
  };
  for (const instance of layout.instances) {
    throwIfCancelled(cancellation);
    const u = instance.localCenterU,
      v = instance.localCenterV;
    if (instance.kind === 'circle') {
      const radius = instance.width / 2;
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (i * Math.PI * 2) / CIRCLE_SEGMENTS,
          b = ((i + 1) * Math.PI * 2) / CIRCLE_SEGMENTS;
        edge(
          [u + Math.cos(a) * radius, v + Math.sin(a) * radius],
          [u + Math.cos(b) * radius, v + Math.sin(b) * radius],
        );
      }
      continue;
    }
    const c = Math.cos(instance.orientationRadians),
      s = Math.sin(instance.orientationRadians),
      hx = instance.length / 2,
      hy = instance.width / 2;
    const corners = [
      [-hx, -hy],
      [hx, -hy],
      [hx, hy],
      [-hx, hy],
    ].map(([x = 0, y = 0]) => [u + x * c - y * s, v + x * s + y * c] as const);
    for (let i = 0; i < 4; i++) edge(corners[i] ?? [u, v], corners[(i + 1) % 4] ?? [u, v]);
  }
  return {
    elementCount: layout.instances.length,
    estimatedPrimitiveTriangles: layout.estimatedPrimitiveTriangles,
    edgeMargin: layout.edgeMargin,
    footprint: Float32Array.from(segments),
  };
}

/** Summed triangle area — of every face, or of the listed faces only. */
export function meshSurfaceArea(mesh: CanonicalMesh, triangleIds?: readonly number[]): number {
  const faceArea = (t: number): number => {
    const a = vertex(mesh, mesh.indices[t * 3] ?? 0),
      b = vertex(mesh, mesh.indices[t * 3 + 1] ?? 0),
      c = vertex(mesh, mesh.indices[t * 3 + 2] ?? 0),
      e1 = sub(b, a),
      e2 = sub(c, a);
    return (
      Math.hypot(
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ) / 2
    );
  };
  let total = 0;
  if (triangleIds === undefined) {
    for (let t = 0; t < mesh.indices.length / 3; t++) total += faceArea(t);
  } else for (const t of triangleIds) total += faceArea(t);
  return total;
}
