import {
  assertMeshStructure,
  computeBounds,
  createIndexArray,
  createPositionArray,
  triangleCount,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { invalidState, throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { runValidatedBoolean, type BooleanBackend } from './boolean-adapter';

export type SplitVector = readonly [number, number, number];
export interface SplitPlane {
  readonly origin: SplitVector;
  readonly normal: SplitVector;
}
export type SplitConnector =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'pin';
      readonly count: 1 | 2 | 3 | 4;
      readonly diameter: number;
      readonly depth: number;
      readonly clearance: number;
      readonly maleSide: 'A' | 'B';
    }
  | {
      readonly kind: 'dovetail';
      readonly width: number;
      readonly depth: number;
      readonly length: number;
      readonly clearance: number;
      readonly maleSide: 'A' | 'B';
      readonly orientationDegrees: 0 | 90;
    };
export interface SplitRequest {
  readonly plane: SplitPlane;
  readonly connector: SplitConnector;
}
export interface CutSurfaceSummary {
  readonly triangleIds: readonly number[];
  readonly center: SplitVector;
  readonly spanU: number;
  readonly spanV: number;
  /** Distance from the automatic placement point to the actual cap boundary. */
  readonly centerEdgeDistance: number;
  /** Bounded, deterministic interior samples ordered by boundary clearance. */
  readonly interiorCandidates: readonly {
    readonly point: SplitVector;
    readonly edgeDistance: number;
  }[];
  /**
   * WHAT THE CUT ACTUALLY LOOKS LIKE, reported and never decided on.
   *
   * `area` is the summed area of the cap triangles — the real cross-section
   * of the source at this plane. `loopCount` is the number of closed boundary
   * loops of that cap (an annulus has two, two separate discs have two), so it
   * is a count of OUTLINES, not of solid regions. `outline` is every boundary
   * edge as a pair of part-local points, capped at `MAX_SECTION_OUTLINE_EDGES`
   * so a dense cap cannot put an unbounded buffer on the wire; `outlineTruncated`
   * says when it was. None of these feeds placement or acceptance.
   */
  readonly area: number;
  readonly loopCount: number;
  readonly outline: Float32Array;
  readonly outlineTruncated: boolean;
}

/** Upper bound on the cap boundary edges carried back for display. */
export const MAX_SECTION_OUTLINE_EDGES = 65_536;
export interface SplitMetrics {
  readonly sourceVolume: number;
  /**
   * The two pieces straight after the cut, BEFORE any connector — the volumes
   * the conservation check compares with the source.
   */
  readonly pieceAVolume: number;
  readonly pieceBVolume: number;
  /**
   * The finished pieces, AFTER connectors: a pin adds material to its male
   * piece and its socket removes material from the other. Equal to the cut
   * volumes when there is no connector.
   */
  readonly pieceAFinalVolume: number;
  readonly pieceBFinalVolume: number;
  readonly volumeRelativeError: number;
  readonly tolerance: number;
}
export interface SplitResult {
  readonly pieceA: CanonicalMesh;
  readonly pieceB: CanonicalMesh;
  readonly cutA: CutSurfaceSummary;
  readonly cutB: CutSurfaceSummary;
  readonly connector: SplitConnector;
  readonly metrics: SplitMetrics;
  readonly placements: readonly SplitVector[];
}

export function roundSocketRadius(pinDiameter: number, radialClearance: number): number {
  return pinDiameter / 2 + radialClearance;
}
export function dovetailFemaleDimensions(
  width: number,
  length: number,
  perSideClearance: number,
): { readonly width: number; readonly length: number } {
  return { width: width + perSideClearance * 2, length: length + perSideClearance * 2 };
}

const CYLINDER_SEGMENTS = 32;
function positionsOf(values: readonly number[]): ReturnType<typeof createPositionArray> {
  const out = createPositionArray(values.length);
  out.set(values);
  return out;
}
function indicesOf(values: readonly number[]): ReturnType<typeof createIndexArray> {
  const out = createIndexArray(values.length);
  out.set(values);
  return out;
}
const dot = (a: SplitVector, b: SplitVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: SplitVector, b: SplitVector): SplitVector => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
const scale = (a: SplitVector, s: number): SplitVector => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: SplitVector, b: SplitVector): SplitVector => add(a, scale(b, -1));
const cross = (a: SplitVector, b: SplitVector): SplitVector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(v: SplitVector): SplitVector {
  const length = Math.hypot(...v);
  if (!Number.isFinite(length) || length < 1e-12)
    throw invalidState('Split plane normal must have a finite non-zero length.');
  return scale(v, 1 / length);
}
function frame(plane: SplitPlane): { n: SplitVector; u: SplitVector; v: SplitVector } {
  if (!plane.origin.every(Number.isFinite)) throw invalidState('Split plane origin is not finite.');
  const n = unit(plane.normal),
    axis: SplitVector = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0],
    u = unit(cross(axis, n));
  return { n, u, v: unit(cross(n, u)) };
}
function vertex(mesh: CanonicalMesh, id: number): SplitVector {
  const at = id * 3;
  return [mesh.positions[at] ?? NaN, mesh.positions[at + 1] ?? NaN, mesh.positions[at + 2] ?? NaN];
}
export function meshVolume(mesh: CanonicalMesh): number {
  return Math.abs(meshSignedVolume(mesh));
}
function meshSignedVolume(mesh: CanonicalMesh): number {
  let six = 0;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const a = vertex(mesh, mesh.indices[at] ?? 0),
      b = vertex(mesh, mesh.indices[at + 1] ?? 0),
      c = vertex(mesh, mesh.indices[at + 2] ?? 0);
    six += dot(a, cross(b, c));
  }
  return six / 6;
}
function outward(mesh: CanonicalMesh): CanonicalMesh {
  if (meshSignedVolume(mesh) >= 0) return mesh;
  const indices = createIndexArray(mesh.indices.length);
  for (let at = 0; at < mesh.indices.length; at += 3) {
    indices[at] = mesh.indices[at] ?? 0;
    indices[at + 1] = mesh.indices[at + 2] ?? 0;
    indices[at + 2] = mesh.indices[at + 1] ?? 0;
  }
  return { ...mesh, indices };
}
/**
 * WHY A PART IS NOT A SPLITTABLE SOLID. Typed, so a caller can test the reason
 * and the sentence can change without weakening what a test proves. The reasons
 * are independent: a part may carry several at once.
 */
export const SplitSourceReason = {
  /** At least one edge belongs to only one triangle: the surface has an opening. */
  OpenBoundaries: 'OPEN_BOUNDARIES',
  /** An edge shared by more than two triangles, or a vertex shared by separate fans. */
  NonManifold: 'NON_MANIFOLD',
  /** Neighbouring triangles disagree about which side is outside. */
  WindingConflict: 'WINDING_CONFLICT',
  /** Zero-area triangles, or triangles repeated at the same positions. */
  DegenerateOrDuplicate: 'DEGENERATE_OR_DUPLICATE',
} as const;
export type SplitSourceReason = (typeof SplitSourceReason)[keyof typeof SplitSourceReason];

/** The reasons a part is not a closed manifold solid, in a fixed order; empty when it is one. */
export function splitSourceReasons(report: {
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly nonManifoldVertexCount: number;
  readonly windingConflictEdgeCount: number;
  readonly zeroAreaFaceCount: number;
  readonly repeatedPositionFaceCount: number;
}): readonly SplitSourceReason[] {
  const reasons: SplitSourceReason[] = [];
  if (report.boundaryEdgeCount > 0) reasons.push(SplitSourceReason.OpenBoundaries);
  if (report.nonManifoldEdgeCount > 0 || report.nonManifoldVertexCount > 0)
    reasons.push(SplitSourceReason.NonManifold);
  if (report.windingConflictEdgeCount > 0) reasons.push(SplitSourceReason.WindingConflict);
  if (report.zeroAreaFaceCount > 0 || report.repeatedPositionFaceCount > 0)
    reasons.push(SplitSourceReason.DegenerateOrDuplicate);
  return reasons;
}

/** The `details.code` of the refusal `requireSolid` throws, so the page recognises it by name and not by wording. */
export const SPLIT_SOURCE_NOT_CLOSED_SOLID_CODE = 'SPLIT_SOURCE_NOT_CLOSED_SOLID';

/**
 * The sentence for a set of reasons. TRUTHFUL ABOUT REPAIR: it points at Repair
 * only when every reason is one Repair's conservative operations address
 * (winding, degenerate and duplicate triangles). An opening or a non-manifold
 * edge may or may not be fixable, so those say what Split needs and no more.
 */
export function describeSplitSourceRefusal(reasons: readonly SplitSourceReason[]): string {
  const facts: string[] = [];
  if (reasons.includes(SplitSourceReason.OpenBoundaries))
    facts.push('it still has open boundaries');
  if (reasons.includes(SplitSourceReason.NonManifold))
    facts.push('it has non-manifold edges or vertices');
  if (reasons.includes(SplitSourceReason.WindingConflict))
    facts.push('its triangles do not agree which side is outside');
  if (reasons.includes(SplitSourceReason.DegenerateOrDuplicate))
    facts.push('it has zero-area or repeated triangles');
  const base = `Manual splitting currently requires a closed solid, and this part is not one: ${facts.join('; ')}.`;
  const repairable = reasons.every(
    (reason) =>
      reason === SplitSourceReason.WindingConflict ||
      reason === SplitSourceReason.DegenerateOrDuplicate,
  );
  return repairable ? `${base} Repair can address these.` : base;
}

function requireSolid(mesh: CanonicalMesh, label: string, cancellation: CancellationToken): void {
  assertMeshStructure(mesh, `split/${label}`);
  const r = analyseTopology(mesh, {
    documentId: 'split',
    documentRevision: 0,
    partId: label,
    cancellation,
    sampleLimit: 0,
    componentSummaryLimit: 8,
  }).report;
  const reasons = splitSourceReasons(r);
  if (reasons.length > 0)
    throw invalidState(describeSplitSourceRefusal(reasons), {
      code: SPLIT_SOURCE_NOT_CLOSED_SOLID_CODE,
      // ErrorDetails hold scalars only, so the typed reasons travel comma-joined.
      reasons: reasons.join(','),
      label,
    });
}
const BOX_INDICES = [
  0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7,
  1, 7, 5,
];
function boxFrom(points: readonly SplitVector[]): CanonicalMesh {
  return outward({
    positions: positionsOf(points.flat()),
    indices: indicesOf(BOX_INDICES),
    metadata: {},
  });
}
function orientedBox(
  center: SplitVector,
  u: SplitVector,
  v: SplitVector,
  n: SplitVector,
  hu: number,
  hv: number,
  hn: number,
): CanonicalMesh {
  const p: SplitVector[] = [];
  for (const sn of [-1, 1])
    for (const sv of [-1, 1])
      for (const su of [-1, 1])
        p.push(add(center, add(scale(u, su * hu), add(scale(v, sv * hv), scale(n, sn * hn)))));
  return boxFrom(p);
}
function range(mesh: CanonicalMesh, axis: SplitVector): [number, number] {
  let min = Infinity,
    max = -Infinity;
  for (let at = 0; at < mesh.positions.length; at += 3) {
    const d = dot(
      [mesh.positions[at] ?? NaN, mesh.positions[at + 1] ?? NaN, mesh.positions[at + 2] ?? NaN],
      axis,
    );
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return [min, max];
}
export function splitTolerance(mesh: CanonicalMesh): number {
  const b = computeBounds(mesh);
  if (!b) throw invalidState('The selected part has no geometry.');
  const diagonal = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]),
    magnitude = Math.max(...b.min.map(Math.abs), ...b.max.map(Math.abs), 1);
  return Math.max(diagonal * 1e-6, magnitude * Number.EPSILON * 64);
}
export function buildSplitCutters(
  mesh: CanonicalMesh,
  plane: SplitPlane,
): readonly [CanonicalMesh, CanonicalMesh] {
  const { n, u, v } = frame(plane),
    [umin, umax] = range(mesh, u),
    [vmin, vmax] = range(mesh, v),
    [nmin, nmax] = range(mesh, n),
    planeN = dot(plane.origin, n),
    tol = splitTolerance(mesh);
  if (planeN <= nmin + tol || planeN >= nmax - tol)
    throw invalidState(
      'The split plane does not pass through enough of this part to create two pieces.',
      { code: 'SPLIT_PLANE_DOES_NOT_INTERSECT_PART', plane: planeN, minimum: nmin, maximum: nmax },
    );
  const margin = Math.max(umax - umin, vmax - vmin, nmax - nmin, tol * 16) * 0.1 + tol * 8,
    hu = (umax - umin) / 2 + margin,
    hv = (vmax - vmin) / 2 + margin,
    uv = add(scale(u, (umin + umax) / 2), scale(v, (vmin + vmax) / 2)),
    pd = nmax - planeN + margin,
    nd = planeN - nmin + margin;
  return [
    orientedBox(add(uv, scale(n, planeN + pd / 2)), u, v, n, hu, hv, pd / 2),
    orientedBox(add(uv, scale(n, planeN - nd / 2)), u, v, n, hu, hv, nd / 2),
  ];
}
export function identifyCutSurface(
  mesh: CanonicalMesh,
  plane: SplitPlane,
  tolerance: number,
): CutSurfaceSummary {
  const { n, u, v } = frame(plane),
    ids: number[] = [];
  const edgeUse = new Map<
    string,
    {
      count: number;
      a: [number, number];
      b: [number, number];
      ai: number;
      bi: number;
    }
  >();
  let area = 0;
  let count = 0,
    minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (let t = 0; t < triangleCount(mesh); t++) {
    const ps = [
      vertex(mesh, mesh.indices[t * 3] ?? 0),
      vertex(mesh, mesh.indices[t * 3 + 1] ?? 0),
      vertex(mesh, mesh.indices[t * 3 + 2] ?? 0),
    ];
    if (!ps.every((p) => Math.abs(dot(sub(p, plane.origin), n)) <= tolerance * 4)) continue;
    ids.push(t);
    const [p0, p1, p2] = ps as [SplitVector, SplitVector, SplitVector];
    area += Math.hypot(...cross(sub(p1, p0), sub(p2, p0))) / 2;
    const triangle = ps.map((p) => [dot(p, u), dot(p, v)] as [number, number]);
    const vertexIds = [
      mesh.indices[t * 3] ?? 0,
      mesh.indices[t * 3 + 1] ?? 0,
      mesh.indices[t * 3 + 2] ?? 0,
    ];
    for (let edge = 0; edge < 3; edge++) {
      const ai = vertexIds[edge] ?? 0,
        bi = vertexIds[(edge + 1) % 3] ?? 0,
        key = ai < bi ? `${String(ai)}:${String(bi)}` : `${String(bi)}:${String(ai)}`,
        prior = edgeUse.get(key);
      if (prior) prior.count++;
      else
        edgeUse.set(key, {
          count: 1,
          a: triangle[edge] ?? [0, 0],
          b: triangle[(edge + 1) % 3] ?? [0, 0],
          ai,
          bi,
        });
    }
    for (const p of ps) {
      const pu = dot(p, u),
        pv = dot(p, v);
      count++;
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }
  }
  if (!ids.length || !count)
    throw invalidState('The split succeeded, but its connector surface could not be identified.', {
      code: 'CONNECTOR_SURFACE_UNAVAILABLE',
    });
  const boundary = [...edgeUse.values()].filter((edge) => edge.count === 1);
  if (!boundary.length)
    throw invalidState('The split cap has no usable boundary for connector placement.', {
      code: 'CONNECTOR_SURFACE_UNAVAILABLE',
    });
  const triangles = ids.map((id) => {
    const points = [0, 1, 2].map((corner) => vertex(mesh, mesh.indices[id * 3 + corner] ?? 0));
    return points.map((p) => [dot(p, u), dot(p, v)] as [number, number]);
  });
  const inside = (point: readonly [number, number]): boolean =>
    triangles.some((triangle) => pointInTriangle(point, triangle));
  const edgeDistance = (point: readonly [number, number]): number =>
    Math.min(...boundary.map((edge) => pointSegmentDistance(point, edge.a, edge.b)));
  const candidates: [number, number][] = [];
  for (const triangle of triangles)
    candidates.push([
      ((triangle[0]?.[0] ?? 0) + (triangle[1]?.[0] ?? 0) + (triangle[2]?.[0] ?? 0)) / 3,
      ((triangle[0]?.[1] ?? 0) + (triangle[1]?.[1] ?? 0) + (triangle[2]?.[1] ?? 0)) / 3,
    ]);
  // A bounded deterministic grid finds an interior pole for concave caps and
  // caps with holes; membership is against the actual cap triangles, not a
  // bounding box or polygon centroid.
  for (let y = 0; y <= 24; y++)
    for (let x = 0; x <= 24; x++) {
      const point: [number, number] = [
        minU + ((maxU - minU) * x) / 24,
        minV + ((maxV - minV) * y) / 24,
      ];
      if (inside(point)) candidates.push(point);
    }
  const ranked = candidates
      .map((point) => ({ point, edgeDistance: edgeDistance(point) }))
      .sort(
        (a, b) =>
          b.edgeDistance - a.edgeDistance || a.point[0] - b.point[0] || a.point[1] - b.point[1],
      ),
    pole = ranked[0]?.point;
  if (!pole)
    throw invalidState('The split cap has no usable interior for connector placement.', {
      code: 'CONNECTOR_SURFACE_UNAVAILABLE',
    });
  const toWorld = (point: readonly [number, number]): SplitVector =>
    add(
      plane.origin,
      add(scale(u, point[0] - dot(plane.origin, u)), scale(v, point[1] - dot(plane.origin, v))),
    );
  const center = toWorld(pole);
  const section = describeSection(mesh, boundary);
  return {
    area,
    ...section,
    triangleIds: ids,
    center,
    spanU: maxU - minU,
    spanV: maxV - minV,
    centerEdgeDistance: edgeDistance(pole),
    interiorCandidates: ranked.map((candidate) => ({
      point: toWorld(candidate.point),
      edgeDistance: candidate.edgeDistance,
    })),
  };
}
/** Loop count by union-find over boundary vertex ids, and a bounded outline. */
function describeSection(
  mesh: CanonicalMesh,
  boundary: readonly { readonly ai: number; readonly bi: number }[],
): { loopCount: number; outline: Float32Array; outlineTruncated: boolean } {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root)
      root = parent.get(root) ?? root;
    let at = x;
    while (at !== root) {
      const next = parent.get(at) ?? root;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const edge of boundary) {
    if (!parent.has(edge.ai)) parent.set(edge.ai, edge.ai);
    if (!parent.has(edge.bi)) parent.set(edge.bi, edge.bi);
    const ra = find(edge.ai),
      rb = find(edge.bi);
    if (ra !== rb) parent.set(ra, rb);
  }
  const roots = new Set<number>();
  for (const id of parent.keys()) roots.add(find(id));
  const kept = Math.min(boundary.length, MAX_SECTION_OUTLINE_EDGES);
  const outline = new Float32Array(kept * 6);
  for (let index = 0; index < kept; index++) {
    const edge = boundary[index];
    if (edge === undefined) break;
    outline.set([...vertex(mesh, edge.ai), ...vertex(mesh, edge.bi)], index * 6);
  }
  return { loopCount: roots.size, outline, outlineTruncated: kept < boundary.length };
}

function pointInTriangle(
  p: readonly [number, number],
  triangle: readonly (readonly [number, number])[],
): boolean {
  const [a, b, c] = triangle;
  if (!a || !b || !c) return false;
  const sign = (
      p1: readonly [number, number],
      p2: readonly [number, number],
      p3: readonly [number, number],
    ): number => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]),
    d1 = sign(p, a, b),
    d2 = sign(p, b, c),
    d3 = sign(p, c, a),
    hasNegative = d1 < 0 || d2 < 0 || d3 < 0,
    hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}
function pointSegmentDistance(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function cylinder(
  center: SplitVector,
  axis: SplitVector,
  radius: number,
  depth: number,
): CanonicalMesh {
  const { u, v, n } = frame({ origin: center, normal: axis }),
    positions: number[] = [];
  for (const side of [-1, 1])
    for (let i = 0; i < CYLINDER_SEGMENTS; i++) {
      const a = (i / CYLINDER_SEGMENTS) * Math.PI * 2;
      positions.push(
        ...add(
          add(center, scale(n, (side * depth) / 2)),
          add(scale(u, Math.cos(a) * radius), scale(v, Math.sin(a) * radius)),
        ),
      );
    }
  const indices: number[] = [];
  for (let i = 1; i + 1 < CYLINDER_SEGMENTS; i++)
    indices.push(0, i + 1, i, CYLINDER_SEGMENTS, CYLINDER_SEGMENTS + i, CYLINDER_SEGMENTS + i + 1);
  for (let i = 0; i < CYLINDER_SEGMENTS; i++) {
    const j = (i + 1) % CYLINDER_SEGMENTS;
    indices.push(i, j, CYLINDER_SEGMENTS + j, i, CYLINDER_SEGMENTS + j, CYLINDER_SEGMENTS + i);
  }
  return outward({ positions: positionsOf(positions), indices: indicesOf(indices), metadata: {} });
}
function dovetail(
  center: SplitVector,
  plane: SplitPlane,
  width: number,
  length: number,
  depth: number,
  orientation: 0 | 90,
): CanonicalMesh {
  const f = frame(plane),
    u = orientation === 0 ? f.u : f.v,
    v = orientation === 0 ? f.v : f.u,
    points: SplitVector[] = [];
  for (const sn of [-1, 1]) {
    const w = sn < 0 ? width * 0.65 : width;
    for (const sv of [-1, 1])
      for (const su of [-1, 1])
        points.push(
          add(
            center,
            add(
              scale(u, (su * length) / 2),
              add(scale(v, (sv * w) / 2), scale(f.n, (sn * depth) / 2)),
            ),
          ),
        );
  }
  return boxFrom(points);
}
function dimension(value: number, label: string, zero = false): void {
  if (!Number.isFinite(value) || value < (zero ? 0 : 0.01) || value > 1000)
    throw invalidState(`${label} is outside the supported range.`, { value });
}
function centers(
  cut: CutSurfaceSummary,
  count: number,
  radius: number,
  margin: number,
): SplitVector[] {
  const need = radius + margin;
  if (cut.spanU < need * 2 || cut.spanV < need * 2 || cut.centerEdgeDistance < need)
    throw invalidState(
      'The connector does not fit inside the cut surface with the required edge margin.',
      { code: 'CONNECTOR_TOO_CLOSE_TO_EDGE' },
    );
  const eligible = cut.interiorCandidates.filter((candidate) => candidate.edgeDistance >= need),
    selected: SplitVector[] = [],
    minimumSpacing = radius * 2 + margin;
  while (selected.length < count) {
    const next = eligible
      .filter((candidate) =>
        selected.every((chosen) => Math.hypot(...sub(candidate.point, chosen)) >= minimumSpacing),
      )
      .sort((a, b) => {
        const distanceA = selected.length
            ? Math.min(...selected.map((chosen) => Math.hypot(...sub(a.point, chosen))))
            : a.edgeDistance,
          distanceB = selected.length
            ? Math.min(...selected.map((chosen) => Math.hypot(...sub(b.point, chosen))))
            : b.edgeDistance;
        return distanceB - distanceA;
      })[0];
    if (!next) break;
    selected.push(next.point);
  }
  if (selected.length !== count)
    throw invalidState('The requested connectors would overlap or sit too close to the cut edge.', {
      code: 'CONNECTOR_DOES_NOT_FIT',
    });
  return selected;
}

/**
 * The stages of a split, reported as they BEGIN. These are facts about where the
 * work is, not a percentage: the kernel calls inside a stage are synchronous and
 * poll nothing, so a fraction between stages would be invented.
 */
export const SplitStage = {
  PreparingCut: 'preparing-cut',
  Intersecting: 'intersecting',
  BuildingCutSurfaces: 'building-cut-surfaces',
  AddingConnectors: 'adding-connectors',
} as const;
export type SplitStage = (typeof SplitStage)[keyof typeof SplitStage];

export async function splitWithConnectors(
  backend: BooleanBackend,
  source: CanonicalMesh,
  request: SplitRequest,
  cancellation: CancellationToken,
  onStage?: (stage: SplitStage) => void,
): Promise<SplitResult> {
  throwIfCancelled(cancellation);
  onStage?.(SplitStage.PreparingCut);
  requireSolid(source, 'source', cancellation);
  const tolerance = splitTolerance(source),
    [positive, negative] = buildSplitCutters(source, request.plane);
  onStage?.(SplitStage.Intersecting);
  let pieceA = (await runValidatedBoolean(backend, 'intersection', source, positive, cancellation))
      .mesh,
    pieceB = (await runValidatedBoolean(backend, 'intersection', source, negative, cancellation))
      .mesh;
  requireSolid(pieceA, 'piece A', cancellation);
  requireSolid(pieceB, 'piece B', cancellation);
  onStage?.(SplitStage.BuildingCutSurfaces);
  const cutA = identifyCutSurface(pieceA, request.plane, tolerance),
    cutB = identifyCutSurface(pieceB, request.plane, tolerance),
    sourceVolume = meshVolume(source),
    pieceAVolume = meshVolume(pieceA),
    pieceBVolume = meshVolume(pieceB),
    volumeRelativeError =
      Math.abs(pieceAVolume + pieceBVolume - sourceVolume) / Math.max(sourceVolume, tolerance ** 3);
  if (volumeRelativeError > 1e-4)
    throw invalidState('The split did not conserve the source volume within tolerance.', {
      relativeError: volumeRelativeError,
      limit: 1e-4,
    });
  const c = request.connector,
    placements: SplitVector[] = [];
  if (c.kind !== 'none') onStage?.(SplitStage.AddingConnectors);
  if (c.kind === 'pin') {
    dimension(c.diameter, 'Pin diameter');
    dimension(c.depth, 'Pin depth');
    dimension(c.clearance, 'Pin clearance', true);
    const r = c.diameter / 2;
    for (const center of centers(
      cutA,
      c.count,
      r + c.clearance,
      Math.max(tolerance * 8, r * 0.35),
    )) {
      placements.push(center);
      throwIfCancelled(cancellation);
      const axis =
          c.maleSide === 'A' ? scale(unit(request.plane.normal), -1) : unit(request.plane.normal),
        overlap = Math.max(tolerance * 8, c.depth * 1e-4),
        primitiveDepth = c.depth + overlap,
        primitiveCenter = add(center, scale(axis, (c.depth - overlap) / 2)),
        male = cylinder(primitiveCenter, axis, r, primitiveDepth),
        socket = cylinder(
          primitiveCenter,
          axis,
          roundSocketRadius(c.diameter, c.clearance),
          primitiveDepth,
        );
      if (c.maleSide === 'A') {
        pieceA = (await runValidatedBoolean(backend, 'union', pieceA, male, cancellation)).mesh;
        pieceB = (await runValidatedBoolean(backend, 'difference', pieceB, socket, cancellation))
          .mesh;
      } else {
        pieceB = (await runValidatedBoolean(backend, 'union', pieceB, male, cancellation)).mesh;
        pieceA = (await runValidatedBoolean(backend, 'difference', pieceA, socket, cancellation))
          .mesh;
      }
    }
  } else if (c.kind === 'dovetail') {
    dimension(c.width, 'Dovetail width');
    dimension(c.depth, 'Dovetail depth');
    dimension(c.length, 'Dovetail length');
    dimension(c.clearance, 'Dovetail clearance', true);
    const need = Math.max(c.width, c.length) / 2 + c.clearance;
    const [placement] = centers(cutA, 1, need, Math.max(tolerance * 8, need * 0.25));
    if (!placement) throw invalidState('No safe dovetail placement was found.');
    placements.push(placement);
    const axis =
        c.maleSide === 'A' ? scale(unit(request.plane.normal), -1) : unit(request.plane.normal),
      overlap = Math.max(tolerance * 8, c.depth * 1e-4),
      primitiveDepth = c.depth + overlap,
      mc = add(cutA.center, scale(axis, (c.depth - overlap) / 2)),
      male = dovetail(
        mc,
        { origin: mc, normal: axis },
        c.width,
        c.length,
        primitiveDepth,
        c.orientationDegrees,
      ),
      female = dovetailFemaleDimensions(c.width, c.length, c.clearance),
      socket = dovetail(
        mc,
        { origin: mc, normal: axis },
        female.width,
        female.length,
        primitiveDepth,
        c.orientationDegrees,
      );
    if (c.maleSide === 'A') {
      pieceA = (await runValidatedBoolean(backend, 'union', pieceA, male, cancellation)).mesh;
      pieceB = (await runValidatedBoolean(backend, 'difference', pieceB, socket, cancellation))
        .mesh;
    } else {
      pieceB = (await runValidatedBoolean(backend, 'union', pieceB, male, cancellation)).mesh;
      pieceA = (await runValidatedBoolean(backend, 'difference', pieceA, socket, cancellation))
        .mesh;
    }
  }
  requireSolid(pieceA, 'final piece A', cancellation);
  requireSolid(pieceB, 'final piece B', cancellation);
  const pieceAFinalVolume = c.kind === 'none' ? pieceAVolume : meshVolume(pieceA),
    pieceBFinalVolume = c.kind === 'none' ? pieceBVolume : meshVolume(pieceB);
  return {
    pieceA,
    pieceB,
    cutA,
    cutB,
    connector: c,
    placements,
    metrics: {
      sourceVolume,
      pieceAVolume,
      pieceBVolume,
      pieceAFinalVolume,
      pieceBFinalVolume,
      volumeRelativeError,
      tolerance,
    },
  };
}
