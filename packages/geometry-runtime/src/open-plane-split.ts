import {
  assertMeshStructure,
  computeBounds,
  createIndexArray,
  createPositionArray,
  MAX_SUPPORTED_SPLIT_TRIANGLES,
  meshByteLength,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import {
  analyseTopology,
  estimateTopologyWorkspaceBytes,
  type TopologyReport,
} from '@cadfixer/mesh-topology';
import {
  invalidState,
  resourceLimitExceeded,
  throwIfCancelled,
  type CancellationToken,
} from '@cadfixer/shared';
import earcut from './third-party/earcut.js';
import { DEFAULT_GEOMETRY_EDIT_LIMITS } from './geometry-edit';
import type { CutSurfaceSummary, SplitPlane, SplitResult, SplitVector } from './split-connectors';

/** Additional bounds are narrower than the shared edit policy, never replacements for it. */
export const OPEN_SPLIT_LIMITS = Object.freeze({
  maxSegments: 65_536,
  maxNodes: 65_536,
  maxLoops: 256,
  maxCapVertices: 8_192,
  maxCapTriangles: 16_384,
  maxContourComparisons: 2_000_000,
  maxIntermediateBytes: 128 * 1024 * 1024,
});
export const CUT_NOT_SAFE = 'CUT_NOT_SAFE';
type Point = [number, number, number];
interface Segment {
  a: number;
  b: number;
  countA: number;
  countB: number;
  directionA: number;
  directionB: number;
  crossingFaces: number;
}
export interface PlaneSplitCapability {
  readonly strategy: 'exact-solid' | 'open-surface' | 'unsupported';
  readonly connectors: boolean;
  readonly topology: TopologyReport;
}
function getAt<T>(values: Readonly<Record<number, T>>, index: number): T {
  const value = values[index];
  if (value === undefined) refuse('invalid-intermediate-index');
  return value;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) refuse('invalid-intermediate-state');
  return value;
}
function refuse(reason: string): never {
  throw invalidState('This cut cannot be made safely. Try a different plane.', {
    code: CUT_NOT_SAFE,
    reason,
  });
}
function bound(metric: string, value: number, limit: number): void {
  if (!Number.isFinite(value) || value > limit)
    throw resourceLimitExceeded('This cut exceeds the supported resource limit.', {
      code: 'OPEN_SPLIT_RESOURCE_LIMIT',
      metric,
      value,
      limit,
    });
}
const dot = (a: SplitVector, b: SplitVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: SplitVector, b: SplitVector): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: SplitVector, b: SplitVector): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const key = (p: Point): string =>
  `${String(p[0] === 0 ? 0 : p[0])}/${String(p[1] === 0 ? 0 : p[1])}/${String(p[2] === 0 ? 0 : p[2])}`;
function normalOf(plane: SplitPlane): Point {
  const length = Math.hypot(...plane.normal);
  if (!plane.origin.every(Number.isFinite) || !Number.isFinite(length) || length === 0)
    refuse('invalid-plane');
  return [plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length];
}
/** Classification is about the source, not Repair readiness. Clean solids always keep the exact path. */
export function choosePlaneSplitStrategy(
  mesh: CanonicalMesh,
  plane: SplitPlane,
  cancellation: CancellationToken,
): PlaneSplitCapability {
  throwIfCancelled(cancellation);
  assertMeshStructure(mesh, 'split/source');
  normalOf(plane);
  bound('source triangles', mesh.indices.length / 3, MAX_SUPPORTED_SPLIT_TRIANGLES);
  bound(
    'topology workspace',
    estimateTopologyWorkspaceBytes(mesh.indices.length / 3, mesh.indices.length) +
      meshByteLength(mesh),
    DEFAULT_GEOMETRY_EDIT_LIMITS.maxEstimatedPeakBytes,
  );
  const topology = analyseTopology(mesh, {
    documentId: 'split',
    documentRevision: 0,
    partId: 'source',
    cancellation,
    sampleLimit: 0,
    componentSummaryLimit: 8,
  }).report;
  const closed =
    topology.boundaryEdgeCount === 0 &&
    topology.nonManifoldEdgeCount === 0 &&
    topology.nonManifoldVertexCount === 0 &&
    topology.windingConflictEdgeCount === 0 &&
    topology.zeroAreaFaceCount === 0 &&
    topology.repeatedPositionFaceCount === 0 &&
    topology.sameOrientationDuplicateCount === 0 &&
    topology.reversedOrientationDuplicateCount === 0;
  return {
    strategy: mesh.indices.length === 0 ? 'unsupported' : closed ? 'exact-solid' : 'open-surface',
    connectors: closed,
    topology,
  };
}
interface CutGraph {
  points: Point[];
  segments: Segment[];
  loops: number[][];
  chains: number[][];
}
interface FlatPoint {
  x: number;
  y: number;
}
const cross2 = (a: FlatPoint, b: FlatPoint, c: FlatPoint): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** Validate planar contours with a bounded sweep; ambiguous contact/crossing is a refusal. */
function capGraph(
  graph: CutGraph,
  plane: SplitPlane,
  normal: Point,
  cancellation: CancellationToken,
): { triangles: number[]; area: number } {
  const axis: Point = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const raw = cross(axis, normal),
    length = Math.hypot(...raw),
    u: Point = [raw[0] / length, raw[1] / length, raw[2] / length],
    v = cross(normal, u);
  const flat = graph.points.map((p) => {
    const q = sub(p, plane.origin);
    return { x: dot(q, u), y: dot(q, v) };
  });
  let comparisons = 0;
  const charge = (): void => {
    if ((comparisons++ & 1023) === 0) throwIfCancelled(cancellation);
    bound('contour comparisons', comparisons, OPEN_SPLIT_LIMITS.maxContourComparisons);
  };
  const edges = graph.segments
    .map((s) => ({
      a: s.a,
      b: s.b,
      minX: Math.min(getAt(flat, s.a).x, getAt(flat, s.b).x),
      maxX: Math.max(getAt(flat, s.a).x, getAt(flat, s.b).x),
      minY: Math.min(getAt(flat, s.a).y, getAt(flat, s.b).y),
      maxY: Math.max(getAt(flat, s.a).y, getAt(flat, s.b).y),
    }))
    .sort((a, b) => a.minX - b.minX || a.a - b.a || a.b - b.b);
  let active: typeof edges = [];
  for (const e of edges) {
    active = active.filter((p) => p.maxX >= e.minX);
    for (const p of active) {
      charge();
      if (p.maxY < e.minY || e.maxY < p.minY) continue;
      if (e.a === p.a || e.a === p.b || e.b === p.a || e.b === p.b) continue;
      const a = getAt(flat, e.a),
        b = getAt(flat, e.b),
        c = getAt(flat, p.a),
        d = getAt(flat, p.b);
      if (cross2(a, b, c) * cross2(a, b, d) <= 0 && cross2(c, d, a) * cross2(c, d, b) <= 0)
        refuse('crossing-cut-contours');
    }
    active.push(e);
  }
  const inside = (id: number, loop: readonly number[]): boolean => {
    let yes = false;
    const p = getAt(flat, id);
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      charge();
      const a = getAt(flat, getAt(loop, i)),
        b = getAt(flat, getAt(loop, j));
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
        yes = !yes;
    }
    return yes;
  };
  const signedArea = (loop: readonly number[]): number => {
    const o = getAt(flat, getAt(loop, 0));
    let sum = 0;
    for (let i = 1; i + 1 < loop.length; i++)
      sum += cross2(o, getAt(flat, getAt(loop, i)), getAt(flat, getAt(loop, i + 1))) / 2;
    return sum;
  };
  const areas = graph.loops.map(signedArea),
    parents = graph.loops.map(() => -1);
  for (let i = 0; i < graph.loops.length; i++) {
    if (areas[i] === 0) refuse('zero-area-contour');
    let smallest = Infinity;
    for (let j = 0; j < graph.loops.length; j++)
      if (
        i !== j &&
        Math.abs(getAt(areas, j)) > Math.abs(getAt(areas, i)) &&
        Math.abs(getAt(areas, j)) < smallest &&
        inside(getAt(getAt(graph.loops, i), 0), getAt(graph.loops, j))
      ) {
        parents[i] = j;
        smallest = Math.abs(getAt(areas, j));
      }
  }
  const depth = (i: number): number => {
    let d = 0;
    for (let p = getAt(parents, i); p !== -1; p = getAt(parents, p)) {
      if (d++ > graph.loops.length) refuse('cyclic-contour');
    }
    return d;
  };
  const triangles: number[] = [];
  let area = 0;
  for (let i = 0; i < graph.loops.length; i++) {
    if (depth(i) % 2 === 1) continue;
    for (const chain of graph.chains) {
      for (const id of chain) {
        if (
          inside(id, getAt(graph.loops, i)) &&
          !graph.loops.some((loop, j) => parents[j] === i && inside(id, loop))
        )
          refuse('open-chain-inside-cap');
      }
    }
    const outer = getAt(graph.loops, i),
      holes = graph.loops.filter((_, j) => parents[j] === i && depth(j) % 2 === 1);
    // Opposite winding is required for nested material boundaries. Same-oriented nested shells overlap.
    for (let j = 0; j < graph.loops.length; j++)
      if (parents[j] === i && Math.sign(getAt(areas, j)) === Math.sign(getAt(areas, i)))
        refuse('ambiguous-nested-shells');
    const ids: number[] = [...outer],
      holeIndices: number[] = [];
    for (const h of holes) {
      holeIndices.push(ids.length);
      ids.push(...h);
    }
    bound('cap vertices', ids.length, OPEN_SPLIT_LIMITS.maxCapVertices);
    const data = ids.flatMap((id) => [getAt(flat, id).x, getAt(flat, id).y]);
    throwIfCancelled(cancellation);
    const result = earcut(data, holeIndices);
    throwIfCancelled(cancellation);
    let measured = 0;
    const expected =
      Math.abs(getAt(areas, i)) - holes.reduce((sum, h) => sum + Math.abs(signedArea(h)), 0);
    const uses = new Map<string, number>();
    const edgeDirections = new Map<string, number>();
    for (let at = 0; at < result.length; at += 3) {
      const a = getAt(ids, getAt(result, at));
      let b = getAt(ids, getAt(result, at + 1)),
        c = getAt(ids, getAt(result, at + 2));
      const signed = cross2(getAt(flat, a), getAt(flat, b), getAt(flat, c)) / 2;
      if (signed === 0 || !Number.isFinite(signed)) refuse('degenerate-cap');
      measured += Math.abs(signed);
      // Piece A is the positive side; its cap follows the surface-derived boundary winding.
      if (Math.sign(signed) !== Math.sign(getAt(areas, i))) [b, c] = [c, b];
      triangles.push(a, b, c);
      for (const [x, y] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const k =
          required(x) < required(y) ? `${String(x)}:${String(y)}` : `${String(y)}:${String(x)}`;
        uses.set(k, (uses.get(k) ?? 0) + 1);
        edgeDirections.set(k, (edgeDirections.get(k) ?? 0) + (required(x) < required(y) ? 1 : -1));
      }
    }
    const rim = new Set<string>();
    const rimDirections = new Map<string, number>();
    for (const loop of [outer, ...holes])
      for (let at = 0; at < loop.length; at++) {
        const a = getAt(loop, at),
          b = getAt(loop, (at + 1) % loop.length);
        const k = a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`;
        rim.add(k);
        rimDirections.set(k, a < b ? 1 : -1);
      }
    for (const [k, count] of uses)
      if (
        count !== (rim.has(k) ? 1 : 2) ||
        edgeDirections.get(k) !== (rim.has(k) ? rimDirections.get(k) : 0)
      )
        refuse('invalid-cap-incidence');
    for (const k of rim) if (uses.get(k) !== 1) refuse('cap-lost-boundary-vertex');
    if (Math.abs(measured - expected) > Math.max(expected * 1e-10, Number.MIN_VALUE))
      refuse('cap-area-mismatch');
    bound('cap triangles', triangles.length / 3, OPEN_SPLIT_LIMITS.maxCapTriangles);
    area += measured;
  }
  return { triangles, area };
}

/**
 * Two passes over original triangles: count before allocating, then write exact-sized soup.
 * Only cut coordinates and their edge graph are retained in maps. No global welding/remeshing.
 * Float64 predicates on exact Float32 inputs; classification allowance is 64 Float64 ULPs of
 * relative coordinates. Output/separation allowance includes four Float32 ULPs of absolute scale.
 * Adjacent soup edges use lexicographically ordered endpoints, hence bit-identical intersections.
 */
export function splitOpenSurface(
  source: CanonicalMesh,
  plane: SplitPlane,
  cancellation: CancellationToken,
): SplitResult {
  const started = Date.now();
  throwIfCancelled(cancellation);
  assertMeshStructure(source, 'split/open-source');
  const n = normalOf(plane),
    bounds = computeBounds(source);
  if (!bounds) refuse('empty-source');
  const extent = Math.hypot(...sub(bounds.max, bounds.min)),
    scale = Math.max(
      extent,
      ...bounds.min.map(Math.abs),
      ...bounds.max.map(Math.abs),
      ...plane.origin.map(Math.abs),
    );
  const predicateTolerance =
    Math.max(
      extent,
      Math.hypot(...sub(bounds.min, plane.origin)),
      Math.hypot(...sub(bounds.max, plane.origin)),
    ) *
    Number.EPSILON *
    64;
  const tolerance = Math.max(scale * 2 ** -21, predicateTolerance, 2 ** -147);
  const faces = source.indices.length / 3;
  bound('source triangles', faces, MAX_SUPPORTED_SPLIT_TRIANGLES);
  const points: Point[] = [],
    nodeIds = new Map<string, number>(),
    segments = new Map<string, Segment>();
  const node = (p: Point): number => {
    const k = key(p),
      old = nodeIds.get(k);
    if (old !== undefined) return old;
    bound('cut nodes', points.length + 1, OPEN_SPLIT_LIMITS.maxNodes);
    const id = points.length;
    points.push(p);
    nodeIds.set(k, id);
    return id;
  };
  const intersections = new Map<string, Point>();
  const generatedPoints = new WeakSet<Point>();
  const distance = (p: Point): number => dot(sub(p, plane.origin), n);
  const side = (d: number): number => (Math.abs(d) <= predicateTolerance ? 0 : d > 0 ? 1 : -1);
  const intersect = (p: Point, q: Point, dp: number, dq: number): Point => {
    if (side(dp) === 0) return p;
    if (side(dq) === 0) return q;
    const pk = key(p),
      qk = key(q),
      k = pk < qk ? `${pk}|${qk}` : `${qk}|${pk}`;
    const old = intersections.get(k);
    if (old) return old;
    const a = pk < qk ? p : q,
      b = pk < qk ? q : p,
      da = pk < qk ? dp : dq,
      db = pk < qk ? dq : dp,
      t = da / (da - db);
    const out: Point = [
      Math.fround(a[0] + (b[0] - a[0]) * t),
      Math.fround(a[1] + (b[1] - a[1]) * t),
      Math.fround(a[2] + (b[2] - a[2]) * t),
    ];
    bound('intersection points', intersections.size + 1, OPEN_SPLIT_LIMITS.maxNodes);
    intersections.set(k, out);
    generatedPoints.add(out);
    return out;
  };
  const clip = (p: Point[], ds: number[], sign: number): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3,
        a = getAt(p, i),
        b = getAt(p, j),
        da = getAt(ds, i),
        db = getAt(ds, j);
      if (side(da) * sign >= 0) out.push(a);
      if (side(da) * side(db) < 0) out.push(intersect(a, b, da, db));
    }
    return out;
  };
  let countA = 0,
    countB = 0,
    cutFaces = 0,
    sourceArea = 0,
    outputArea = 0,
    untouched = 0,
    coplanarFaces = 0;
  const area = (a: Point, b: Point, c: Point): number =>
    Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
  // One reusable flat scratch record for the uncut majority. Point objects exist only at the
  // bounded cut graph, rather than being allocated for every source triangle.
  const coordinates = new Float64Array(9);
  const readTriangle = (f: number): void => {
    for (let k = 0; k < 3; k++) {
      const at = getAt(source.indices, f * 3 + k) * 3;
      coordinates[k * 3] = getAt(source.positions, at);
      coordinates[k * 3 + 1] = getAt(source.positions, at + 1);
      coordinates[k * 3 + 2] = getAt(source.positions, at + 2);
    }
  };
  const flatDistance = (at: number): number =>
    (getAt(coordinates, at) - plane.origin[0]) * n[0] +
    (getAt(coordinates, at + 1) - plane.origin[1]) * n[1] +
    (getAt(coordinates, at + 2) - plane.origin[2]) * n[2];
  const flatArea = (): number => {
    const bx = getAt(coordinates, 3) - getAt(coordinates, 0),
      by = getAt(coordinates, 4) - getAt(coordinates, 1),
      bz = getAt(coordinates, 5) - getAt(coordinates, 2),
      cx = getAt(coordinates, 6) - getAt(coordinates, 0),
      cy = getAt(coordinates, 7) - getAt(coordinates, 1),
      cz = getAt(coordinates, 8) - getAt(coordinates, 2);
    return Math.hypot(by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx) / 2;
  };
  const triangle = (): Point[] => [
    [getAt(coordinates, 0), getAt(coordinates, 1), getAt(coordinates, 2)],
    [getAt(coordinates, 3), getAt(coordinates, 4), getAt(coordinates, 5)],
    [getAt(coordinates, 6), getAt(coordinates, 7), getAt(coordinates, 8)],
  ];
  const polygons = (p: Point[], ds: number[]): [Point[], Point[]] => {
    const positive = ds.some((d) => side(d) > 0),
      negative = ds.some((d) => side(d) < 0);
    if (!negative) return [p, []];
    if (!positive) return [[], p];
    return [clip(p, ds, 1), clip(p, ds, -1)];
  };
  const preparedAt = Date.now();
  for (let f = 0; f < faces; f++) {
    if ((f & 4095) === 0) throwIfCancelled(cancellation);
    readTriangle(f);
    const d0 = flatDistance(0),
      d1 = flatDistance(3),
      d2 = flatDistance(6),
      s0 = side(d0),
      s1 = side(d1),
      s2 = side(d2);
    const positive = s0 > 0 || s1 > 0 || s2 > 0,
      negative = s0 < 0 || s1 < 0 || s2 < 0;
    const originalArea = flatArea();
    sourceArea += originalArea;
    if (originalArea > 0 && s0 === 0 && s1 === 0 && s2 === 0) coplanarFaces++;
    if (!positive || !negative) {
      if (!negative) countA++;
      else countB++;
      untouched++;
      outputArea += originalArea;
      // Without two on-plane endpoints, an untouched triangle contributes no cut edge.
      if (Number(s0 === 0) + Number(s1 === 0) + Number(s2 === 0) < 2) continue;
    }
    const p = triangle(),
      ds = [d0, d1, d2],
      [a, b] = polygons(p, ds);
    if (positive && negative) {
      countA += a.length - 2;
      countB += b.length - 2;
    }
    if (a.length && b.length) {
      cutFaces++;
      let clippedArea = 0;
      for (const poly of [a, b])
        for (let k = 1; k + 1 < poly.length; k++) {
          const pieceArea = area(getAt(poly, 0), getAt(poly, k), getAt(poly, k + 1));
          if (pieceArea === 0) refuse('unrepresentable-cut-fragment');
          clippedArea += pieceArea;
        }
      const perimeter =
        Math.hypot(...sub(getAt(p, 0), getAt(p, 1))) +
        Math.hypot(...sub(getAt(p, 1), getAt(p, 2))) +
        Math.hypot(...sub(getAt(p, 2), getAt(p, 0)));
      if (Math.abs(clippedArea - originalArea) > tolerance * perimeter * 4)
        refuse('surface-conservation');
      outputArea += clippedArea;
    }
    for (const [poly, which] of [
      [a, 0],
      [b, 1],
    ] as const)
      for (let k = 0; k < poly.length; k++) {
        const x = getAt(poly, k),
          y = getAt(poly, (k + 1) % poly.length);
        // A tolerance-zero source point stays untouched; generated vertices have Float32 plane error.
        if (
          (!generatedPoints.has(x) && side(distance(x)) !== 0) ||
          (!generatedPoints.has(y) && side(distance(y)) !== 0)
        )
          continue;
        const ai = node(x),
          bi = node(y);
        if (ai === bi) {
          if (a.length && b.length) refuse('collapsed-cut-edge');
          continue;
        }
        const low = Math.min(ai, bi),
          high = Math.max(ai, bi),
          id = `${String(low)}:${String(high)}`;
        let segment = segments.get(id);
        if (!segment) {
          bound('cut segments', segments.size + 1, OPEN_SPLIT_LIMITS.maxSegments);
          segment = {
            a: low,
            b: high,
            countA: 0,
            countB: 0,
            directionA: 0,
            directionB: 0,
            crossingFaces: 0,
          };
          segments.set(id, segment);
        }
        if (which === 0) {
          segment.countA++;
          if (a.length > 0 && b.length > 0) segment.crossingFaces++;
          segment.directionA += ai === low ? 1 : -1;
          if (segment.crossingFaces > 1) refuse('duplicate-cut-segment');
          if (segment.countA > 2) refuse('non-pairable-cut-edge');
        } else {
          segment.countB++;
          segment.directionB += ai === low ? 1 : -1;
          if (segment.countB > 2) refuse('non-pairable-cut-edge');
        }
      }
  }
  const clippedAt = Date.now();
  if (countA === 0 || countB === 0) refuse('plane-does-not-separate-model');
  const interfaceSegments: Segment[] = [];
  for (const s of segments.values()) {
    if (s.crossingFaces > 1) refuse('duplicate-cut-segment');
    if (
      s.countA > 2 ||
      s.countB > 2 ||
      (s.countA === 2 && s.directionA !== 0) ||
      (s.countB === 2 && s.directionB !== 0)
    )
      refuse('non-pairable-cut-edge');
    if (s.countA === 1 && s.countB === 1) {
      if (s.directionA !== -s.directionB) refuse('inconsistent-cut-winding');
      interfaceSegments.push(s);
    }
  }
  const adjacent = new Map<number, Segment[]>();
  for (const s of interfaceSegments)
    for (const id of [s.a, s.b]) {
      const list = adjacent.get(id) ?? [];
      list.push(s);
      adjacent.set(id, list);
      if (list.length > 2) refuse('branching-cut-graph');
    }
  for (const [id, edges] of adjacent) {
    if (edges.length === 2) {
      const outgoing = edges.filter(
        (edge) => (edge.a === id ? edge.directionA : -edge.directionA) > 0,
      ).length;
      if (outgoing !== 1) refuse('inconsistent-cut-winding');
    }
  }
  const visited = new Set<Segment>(),
    loops: number[][] = [],
    chains: number[][] = [];
  const walk = (start: number): void => {
    const path: number[] = [];
    let id = start;
    for (;;) {
      path.push(id);
      const edge = adjacent.get(id)?.find((e) => !visited.has(e));
      if (!edge) break;
      visited.add(edge);
      id = edge.a === id ? edge.b : edge.a;
      if (id === start) break;
    }
    if (id === start && path.length >= 3) {
      // Cap is opposite the positive surface's boundary direction.
      const a = getAt(path, 0),
        b = getAt(path, 1),
        s = required(adjacent.get(a)).find(
          (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a),
        );
      if (s === undefined) refuse('invalid-cut-graph');
      const follows = (s.a === a ? 1 : -1) === s.directionA;
      if (follows) path.reverse();
      loops.push(path);
    } else chains.push(path);
  };
  for (const [id, edges] of adjacent)
    if (edges.length === 1 && !visited.has(getAt(edges, 0))) walk(id);
  for (const s of interfaceSegments) if (!visited.has(s)) walk(s.a);
  bound('cap loops', loops.length, OPEN_SPLIT_LIMITS.maxLoops);
  bound(
    'total cap vertices',
    loops.reduce((sum, l) => sum + l.length, 0),
    OPEN_SPLIT_LIMITS.maxCapVertices,
  );
  if (coplanarFaces > 0 && loops.length > 0) refuse('coplanar-source-face-at-cap');
  const graph: CutGraph = { points, segments: interfaceSegments, loops, chains };
  const graphAt = Date.now();
  const cap = capGraph(graph, plane, n, cancellation),
    capCount = cap.triangles.length / 3,
    total = countA + countB + capCount * 2;
  const cappedAt = Date.now();
  bound('output triangles', total, DEFAULT_GEOMETRY_EDIT_LIMITS.maxTriangles);
  const bytes = total * 48,
    intermediate = (points.length + segments.size + intersections.size) * 512;
  bound('intermediate bytes', intermediate, OPEN_SPLIT_LIMITS.maxIntermediateBytes);
  bound('canonical bytes', bytes, DEFAULT_GEOMETRY_EDIT_LIMITS.maxCanonicalBytes);
  bound(
    'estimated edit peak',
    meshByteLength(source) + bytes + total * 72 + intermediate,
    DEFAULT_GEOMETRY_EDIT_LIMITS.maxEstimatedPeakBytes,
  );
  const aPositions = createPositionArray((countA + capCount) * 9),
    bPositions = createPositionArray((countB + capCount) * 9);
  let atA = 0,
    atB = 0;
  const write = (poly: Point[], which: number): void => {
    const out = which === 0 ? aPositions : bPositions;
    let at = which === 0 ? atA : atB;
    for (let k = 1; k + 1 < poly.length; k++)
      for (const p of [getAt(poly, 0), getAt(poly, k), getAt(poly, k + 1)]) {
        out[at++] = p[0];
        out[at++] = p[1];
        out[at++] = p[2];
      }
    if (which === 0) atA = at;
    else atB = at;
  };
  for (let f = 0; f < faces; f++) {
    if ((f & 4095) === 0) throwIfCancelled(cancellation);
    readTriangle(f);
    const d0 = flatDistance(0),
      d1 = flatDistance(3),
      d2 = flatDistance(6),
      s0 = side(d0),
      s1 = side(d1),
      s2 = side(d2);
    const positive = s0 > 0 || s1 > 0 || s2 > 0,
      negative = s0 < 0 || s1 < 0 || s2 < 0;
    if (!negative) {
      aPositions.set(coordinates, atA);
      atA += 9;
      continue;
    }
    if (!positive) {
      bPositions.set(coordinates, atB);
      atB += 9;
      continue;
    }
    const p = triangle(),
      [a, b] = polygons(p, [d0, d1, d2]);
    write(a, 0);
    write(b, 1);
  }
  for (let at = 0; at < cap.triangles.length; at += 3) {
    const a = getAt(points, getAt(cap.triangles, at)),
      b = getAt(points, getAt(cap.triangles, at + 1)),
      c = getAt(points, getAt(cap.triangles, at + 2));
    write([a, b, c], 0);
    write([a, c, b], 1);
  }
  const make = (positions: ReturnType<typeof createPositionArray>): CanonicalMesh => {
    const indices = createIndexArray(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    return { positions, indices, metadata: source.metadata };
  };
  const pieceA = make(aPositions),
    pieceB = make(bPositions);
  if (atA !== aPositions.length || atB !== bPositions.length) refuse('face-count-mismatch');
  for (const [mesh, sign] of [
    [pieceA, 1],
    [pieceB, -1],
  ] as const) {
    assertMeshStructure(mesh, 'split/open-output');
    for (let at = 0; at < mesh.positions.length; at += 3) {
      if ((at & 16383) === 0) throwIfCancelled(cancellation);
      const d =
        (getAt(mesh.positions, at) - plane.origin[0]) * n[0] +
        (getAt(mesh.positions, at + 1) - plane.origin[1]) * n[1] +
        (getAt(mesh.positions, at + 2) - plane.origin[2]) * n[2];
      if (sign * d < -tolerance) refuse('cross-side-output');
      for (let axis = 0; axis < 3; axis++) {
        const value = getAt(mesh.positions, at + axis);
        if (
          value < getAt(bounds.min, axis) - tolerance ||
          value > getAt(bounds.max, axis) + tolerance
        )
          refuse('output-outside-source-bounds');
      }
    }
  }
  const outline = new Float32Array(interfaceSegments.length * 6);
  interfaceSegments.forEach((s, i) => {
    outline.set(getAt(points, s.a), i * 6);
    outline.set(getAt(points, s.b), i * 6 + 3);
  });
  const summary = (start: number): CutSurfaceSummary => ({
    triangleIds: Array.from({ length: capCount }, (_, i) => start + i),
    center: plane.origin,
    spanU: 0,
    spanV: 0,
    centerEdgeDistance: 0,
    interiorCandidates: [],
    area: cap.area,
    loopCount: loops.length,
    outline,
    outlineTruncated: false,
  });
  return {
    pieceA,
    pieceB,
    cutA: summary(countA),
    cutB: summary(countB),
    connector: { kind: 'none' },
    placements: [],
    metrics: {
      volumeInterpretable: false,
      sourceVolume: 0,
      pieceAVolume: 0,
      pieceBVolume: 0,
      pieceAFinalVolume: 0,
      pieceBFinalVolume: 0,
      volumeRelativeError: 0,
      tolerance,
    },
    surfaceValidation: {
      sourceFaces: faces,
      untouchedFaces: untouched,
      clippedFaces: cutFaces,
      sourceArea,
      outputArea,
      capTriangles: capCount,
      cutLoops: loops.length,
      openChains: chains.length,
      intermediateBytes: intermediate,
      phaseMilliseconds: {
        preparation: preparedAt - started,
        clipping: clippedAt - preparedAt,
        graph: graphAt - clippedAt,
        capping: cappedAt - graphAt,
        outputAndValidation: Date.now() - cappedAt,
      },
    },
  };
}
