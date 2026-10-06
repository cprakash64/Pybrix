import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  buildVertexIncidence,
  exactStoredCoordinateIdentity,
  recoverVertexIdentity,
} from '@cadfixer/mesh-topology';
import type { Vec3 } from './surgery-mesh';

/**
 * FAN TOPOLOGY — the pinched vertices of a mesh.
 *
 * A non-manifold vertex is several edge-connected FANS of faces meeting at one exact stored
 * coordinate. This module finds every such vertex, partitions its faces into fans, and labels the
 * face-connected components, so that the local repair can decide what to attempt and report what
 * it could not. It is READ-ONLY and TOLERANCE-FREE: identity is the exact coordinate, exactly as in
 * `@cadfixer/mesh-topology`, and nothing is welded, merged or moved here.
 *
 * Deterministic: ties are broken by face id, and the result does not depend on iteration order.
 */

export interface VertexFan {
  /** Face ids, ascending. */
  readonly faces: readonly number[];
  /** True when an edge at this vertex belongs to exactly one face of the fan. */
  readonly open: boolean;
}

export interface PinchedVertex {
  /** Exact-coordinate topological vertex id. */
  readonly vertex: number;
  readonly point: Vec3;
  readonly fans: readonly VertexFan[];
  /** An edge at this vertex has more than two faces: not separable by movement. */
  readonly nonManifoldEdge: boolean;
}

export interface FanTopology {
  readonly faceCount: number;
  readonly vertexCount: number;
  /** Three exact-coordinate vertex ids per face. */
  readonly tri: Uint32Array;
  readonly pinched: readonly PinchedVertex[];
  /** Face-connected component id per face (faces joined by a shared edge). */
  readonly faceComponent: Uint32Array;
  readonly componentFaceCount: readonly number[];
  readonly coordinateSet: CoordinateSet;
}

/** Exact-coordinate set over a mesh's vertices, for "is this already a vertex?". */
export class CoordinateSet {
  private readonly table: Int32Array;
  private readonly mask: number;
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly zs: number[] = [];

  public constructor(expected: number) {
    let capacity = 16;
    while (capacity < expected * 2 + 2) capacity *= 2;
    this.mask = capacity - 1;
    this.table = new Int32Array(capacity).fill(-1);
  }

  public has(x: number, y: number, z: number): boolean {
    return this.find(x, y, z) !== -1;
  }

  public add(x: number, y: number, z: number): void {
    if (this.find(x, y, z) !== -1) return;
    const nx = exactStoredCoordinateIdentity.normalize(x);
    const ny = exactStoredCoordinateIdentity.normalize(y);
    const nz = exactStoredCoordinateIdentity.normalize(z);
    let slot = exactStoredCoordinateIdentity.hash(nx, ny, nz) & this.mask;
    while ((this.table[slot] ?? -1) !== -1) slot = (slot + 1) & this.mask;
    this.table[slot] = this.xs.length;
    this.xs.push(nx);
    this.ys.push(ny);
    this.zs.push(nz);
  }

  private find(x: number, y: number, z: number): number {
    const nx = exactStoredCoordinateIdentity.normalize(x);
    const ny = exactStoredCoordinateIdentity.normalize(y);
    const nz = exactStoredCoordinateIdentity.normalize(z);
    let slot = exactStoredCoordinateIdentity.hash(nx, ny, nz) & this.mask;
    for (;;) {
      const entry = this.table[slot] ?? -1;
      if (entry === -1) return -1;
      if (this.xs[entry] === nx && this.ys[entry] === ny && this.zs[entry] === nz) return entry;
      slot = (slot + 1) & this.mask;
    }
  }
}

export interface FanTopologyOptions {
  readonly poll?: () => void;
}

const POLL_INTERVAL = 65_536;

/** Finds every vertex with more than one fan, and builds what anchoring needs. */
export function buildFanTopology(
  mesh: CanonicalMesh,
  options: FanTopologyOptions = {},
): FanTopology {
  const poll = options.poll ?? ((): void => undefined);
  const faceCount = Math.floor(mesh.indices.length / 3);
  const identity = recoverVertexIdentity(mesh);
  const vertexCount = identity.vertexCount;
  const tri = new Uint32Array(faceCount * 3);
  for (let i = 0; i < tri.length; i += 1) {
    tri[i] = identity.cornerToVertex[mesh.indices[i] ?? 0] ?? 0;
  }
  const incidence = buildVertexIncidence(tri, faceCount, vertexCount);

  const coordinateSet = new CoordinateSet(vertexCount);
  const pointOf = (vertex: number): Vec3 => {
    const slot = identity.vertexRepresentativeCorner[vertex] ?? 0;
    return [
      mesh.positions[slot * 3] ?? 0,
      mesh.positions[slot * 3 + 1] ?? 0,
      mesh.positions[slot * 3 + 2] ?? 0,
    ];
  };
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const p = pointOf(vertex);
    coordinateSet.add(p[0], p[1], p[2]);
  }

  const pinched: PinchedVertex[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (vertex % POLL_INTERVAL === 0) poll();
    const from = incidence.start[vertex] ?? 0;
    const to = incidence.start[vertex + 1] ?? 0;
    if (to - from < 2) continue;
    const found = partition(vertex, tri, incidence.faces, from, to);
    if (found !== undefined) pinched.push({ ...found, point: pointOf(vertex) });
  }

  // Face components, joined across shared edges.
  const parent = new Int32Array(faceCount);
  for (let f = 0; f < faceCount; f += 1) parent[f] = f;
  const root = (x: number): number => {
    let r = x;
    while ((parent[r] ?? r) !== r) r = parent[r] ?? r;
    let c = x;
    while ((parent[c] ?? c) !== r) {
      const next = parent[c] ?? r;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const owner = new Map<number, number>();
  for (let f = 0; f < faceCount; f += 1) {
    if (f % POLL_INTERVAL === 0) poll();
    for (let k = 0; k < 3; k += 1) {
      const a = tri[f * 3 + k] ?? 0;
      const b = tri[f * 3 + ((k + 1) % 3)] ?? 0;
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      const prior = owner.get(key);
      if (prior === undefined) owner.set(key, f);
      else parent[root(f)] = root(prior);
    }
  }
  owner.clear();
  const faceComponent = new Uint32Array(faceCount);
  const ids = new Map<number, number>();
  const counts: number[] = [];
  for (let f = 0; f < faceCount; f += 1) {
    const r = root(f);
    let id = ids.get(r);
    if (id === undefined) {
      id = counts.length;
      ids.set(r, id);
      counts.push(0);
    }
    faceComponent[f] = id;
    counts[id] = (counts[id] ?? 0) + 1;
  }

  return {
    faceCount,
    vertexCount,
    tri,
    pinched: pinched.map((entry) => ({ ...entry })),
    faceComponent,
    componentFaceCount: counts,
    coordinateSet,
  };
}

function partition(
  vertex: number,
  tri: Uint32Array,
  incident: Uint32Array,
  from: number,
  to: number,
): Omit<PinchedVertex, 'point'> | undefined {
  const faces: number[] = [];
  const nbrA: number[] = [];
  const nbrB: number[] = [];
  for (let slot = from; slot < to; slot += 1) {
    const face = incident[slot] ?? 0;
    const a = tri[face * 3] ?? 0;
    const b = tri[face * 3 + 1] ?? 0;
    const c = tri[face * 3 + 2] ?? 0;
    if (a === b || b === c || a === c) continue;
    const others = [a, b, c].filter((w) => w !== vertex);
    faces.push(face);
    nbrA.push(others[0] ?? -1);
    nbrB.push(others[1] ?? -1);
  }
  const count = faces.length;
  if (count < 2) return undefined;
  const parent = Array.from({ length: count }, (_, i) => i);
  const root = (x: number): number => {
    let r = x;
    while ((parent[r] ?? r) !== r) r = parent[r] ?? r;
    return r;
  };
  const byNeighbour = new Map<number, number[]>();
  const push = (w: number, i: number): void => {
    const list = byNeighbour.get(w);
    if (list === undefined) byNeighbour.set(w, [i]);
    else list.push(i);
  };
  for (let i = 0; i < count; i += 1) {
    push(nbrA[i] ?? -1, i);
    push(nbrB[i] ?? -1, i);
  }
  let nonManifoldEdge = false;
  const openNeighbour = new Set<number>();
  for (const [w, list] of byNeighbour) {
    if (list.length > 2) nonManifoldEdge = true;
    if (list.length === 1) openNeighbour.add(w);
    for (let j = 1; j < list.length; j += 1) parent[root(list[j] ?? 0)] = root(list[0] ?? 0);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i += 1) {
    const r = root(i);
    const list = groups.get(r);
    if (list === undefined) groups.set(r, [faces[i] ?? 0]);
    else list.push(faces[i] ?? 0);
  }
  if (groups.size < 2 && !nonManifoldEdge) return undefined;
  const fans: VertexFan[] = [];
  for (const list of groups.values()) {
    const members = new Set(list);
    let open = false;
    for (let i = 0; i < count; i += 1) {
      if (!members.has(faces[i] ?? -1)) continue;
      if (openNeighbour.has(nbrA[i] ?? -1) || openNeighbour.has(nbrB[i] ?? -1)) open = true;
    }
    fans.push({ faces: list.sort((a, b) => a - b), open });
  }
  fans.sort((a, b) => (a.faces[0] ?? 0) - (b.faces[0] ?? 0));
  return { vertex, fans, nonManifoldEdge };
}

/**
 * The defect class of a pinched vertex, from its fans' components and openness. Reporting only:
 * no decision in the repair depends on the class, and the class never relaxes a gate.
 */
export const PinchClass = {
  SeparateShells: 'A separate-shell contacts',
  BoundaryPinch: 'B boundary pinches (one component)',
  Mixed: 'C mixed',
  ClosedFans: 'D closed fans meeting at a point',
  NonManifoldEdge: 'non-manifold edge (refused)',
  Other: 'other',
} as const;
export type PinchClass = (typeof PinchClass)[keyof typeof PinchClass];

export function classifyPinch(vertex: PinchedVertex, topology: FanTopology): PinchClass {
  if (vertex.nonManifoldEdge) return PinchClass.NonManifoldEdge;
  const comps = new Set(vertex.fans.map((f) => topology.faceComponent[f.faces[0] ?? 0] ?? 0));
  const open = vertex.fans.filter((f) => f.open).length;
  if (comps.size === vertex.fans.length && comps.size > 1) return PinchClass.SeparateShells;
  if (comps.size === 1 && open === 0) return PinchClass.ClosedFans;
  if (comps.size === 1) return PinchClass.BoundaryPinch;
  if (open > 0) return PinchClass.Mixed;
  return PinchClass.Other;
}

export interface LocalRepairPlanFacts {
  readonly pinchedVertices: number;
  readonly eligible: number;
  readonly unsupportedNonManifoldEdge: number;
  readonly byClass: Readonly<Record<string, number>>;
}

/** Read-only counts the planner shows; decides nothing. */
export function planLocalRepair(topology: FanTopology): LocalRepairPlanFacts {
  const byClass: Record<string, number> = {};
  let eligible = 0;
  let unsupported = 0;
  for (const v of topology.pinched) {
    if (v.nonManifoldEdge) {
      unsupported += 1;
      continue;
    }
    eligible += 1;
    const cls = classifyPinch(v, topology);
    byClass[cls] = (byClass[cls] ?? 0) + 1;
  }
  return {
    pinchedVertices: topology.pinched.length,
    eligible,
    unsupportedNonManifoldEdge: unsupported,
    byClass,
  };
}
