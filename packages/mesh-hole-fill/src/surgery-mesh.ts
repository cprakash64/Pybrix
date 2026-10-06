import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { createIndexArray, createPositionArray } from '@cadfixer/mesh-core';
import { buildVertexIncidence, recoverVertexIdentity } from '@cadfixer/mesh-topology';

/**
 * LOCAL PINCH SURGERY PRIMITIVES — the live mesh, fan chains, regions and the tentative
 * reconstruction every local repair is built from (REPAIR-CORE-06A).
 *
 * One non-manifold vertex V at a time:
 *
 *   partition the faces at V into manifold fans
 *   -> choose a neighbourhood (depth d = rings of faces around V, per fan)
 *   -> REMOVE exactly that neighbourhood
 *   -> RECONSTRUCT it at once, one disk per fan, with V replaced by a NEW vertex
 *      per fan at a finite, locally scaled offset (and, for depth > 1, interior
 *      vertices carried along by a graded displacement field)
 *   -> validate the finished candidate
 *   -> only then continue to the next vertex.
 *
 * Nothing is ever left excised between operations. Cut-cycle vertices are REUSED
 * (pinned), so every unaffected source vertex and face is byte-identical, and the
 * shared coordinate V disappears entirely — it is not duplicated at the same
 * coordinate and it is not separated by a unit in the last place.
 *
 * Everything is deterministic; ties break by id.
 *
 * KERNEL-FREE. The exact intersection test is injected as `accept`, called with
 * the tentative candidate already in place, so this module imports no geometry
 * kernel and runs under plain Node.
 */

export type Vec3 = readonly [number, number, number];

export const SurgeryRefusal = {
  NonManifoldEdge: 'non-manifold edge at the vertex',
  InconsistentFan: 'a fan is not one consistently oriented chain',
  DegenerateFan: 'a fan holds a degenerate face',
  RegionOverlap: 'the regions of two fans meet',
  NoUsableDirection: 'no separation direction passed the local gates',
  Rejected: 'the intersection gate rejected every candidate',
} as const;
export type SurgeryRefusal = (typeof SurgeryRefusal)[keyof typeof SurgeryRefusal];

/**
 * The smallest rung of the ladder, reused as the separation requirement: two
 * apexes of one operation must end at least this fraction of the local mean
 * incident edge apart. Derived from the ladder, not a world-space number.
 */
export const MINIMUM_APEX_SEPARATION = 0.125;

export interface FanChain {
  /** Face ids, in chain order. */
  readonly faces: readonly number[];
  /** Link vertices in chain order (closed fans repeat nothing). */
  readonly link: readonly number[];
  readonly closed: boolean;
}

export interface LiveFans {
  readonly fans: readonly FanChain[];
  readonly refusal?: SurgeryRefusal;
}

export interface SurgeryOperation {
  readonly vertex: number;
  readonly depth: number;
  readonly scale: number;
  readonly strategy: string;
  readonly removedFaces: readonly number[];
  readonly addedFaces: readonly number[];
  readonly newVertices: readonly number[];
  readonly displacedInteriorVertices: number;
  readonly maxInteriorDisplacement: number;
  /** Boundary size (edges with one region face) of each fan's region. */
  readonly cycleSizes: readonly number[];
  readonly fanCount: number;
  readonly closedFans: number;
  /** Local mean incident edge length per fan, and the achieved apex separation. */
  readonly meanIncidentEdge: readonly number[];
  readonly apexSeparation: number;
  readonly attempts: number;
  readonly boundaryEdgesBefore: number;
  readonly boundaryEdgesAfter: number;
  readonly point: Vec3;
}

export interface SurgeryRefusalRecord {
  readonly vertex: number;
  readonly reason: SurgeryRefusal;
  readonly detail: string;
  readonly attempts: number;
}

export interface TentativeContext {
  readonly mesh: SurgeryMesh;
  readonly vertex: number;
  readonly removedFaces: readonly number[];
  readonly addedFaces: readonly number[];
}

/** Returns a reason to refuse the tentative candidate, or undefined to accept. */
export type SurgeryAccept = (context: TentativeContext) => string | undefined;

/* ------------------------------------------------------------ live mesh -- */

/**
 * A mutable working copy over WELDED (exact-coordinate) vertex ids. Faces are
 * killed and appended, never edited, so a tentative operation rolls back by
 * flipping flags. The caller's `CanonicalMesh` is never written.
 */
export class SurgeryMesh {
  public pos: Float64Array;
  public tri: Int32Array;
  public alive: Uint8Array;
  public vertexCount: number;
  public faceCount: number;
  public readonly sourceFaceCount: number;
  public readonly sourceVertexCount: number;
  private readonly csrStart: Uint32Array;
  private readonly csrFaces: Uint32Array;
  private readonly extra = new Map<number, number[]>();
  private readonly metadata: CanonicalMesh['metadata'];
  /** Welded vertex id -> a position slot of the SOURCE mesh that carries that coordinate. */
  private readonly representativeSlot: Uint32Array;
  /** Position slots the source mesh had; appended vertices are numbered from here. */
  private readonly sourceSlotCount: number;
  /** Source faces whose winding is currently reversed relative to the source. */
  private readonly reversedSourceFaces = new Set<number>();

  private constructor(
    pos: Float64Array,
    tri: Int32Array,
    vertexCount: number,
    faceCount: number,
    csrStart: Uint32Array,
    csrFaces: Uint32Array,
    metadata: CanonicalMesh['metadata'],
    representativeSlot: Uint32Array,
    sourceSlotCount: number,
  ) {
    this.pos = pos;
    this.tri = tri;
    this.vertexCount = vertexCount;
    this.faceCount = faceCount;
    this.sourceFaceCount = faceCount;
    this.sourceVertexCount = vertexCount;
    this.alive = new Uint8Array(Math.max(faceCount * 2, 16)).fill(0);
    this.alive.fill(1, 0, faceCount);
    this.csrStart = csrStart;
    this.csrFaces = csrFaces;
    this.metadata = metadata;
    this.representativeSlot = representativeSlot;
    this.sourceSlotCount = sourceSlotCount;
  }

  public static from(mesh: CanonicalMesh): SurgeryMesh {
    const faceCount = Math.floor(mesh.indices.length / 3);
    const identity = recoverVertexIdentity(mesh);
    const vertexCount = identity.vertexCount;
    const tri = new Int32Array(Math.max(faceCount * 2, 16) * 3);
    const asUint = new Uint32Array(faceCount * 3);
    for (let i = 0; i < faceCount * 3; i += 1) {
      const v = identity.cornerToVertex[mesh.indices[i] ?? 0] ?? 0;
      tri[i] = v;
      asUint[i] = v;
    }
    const pos = new Float64Array(Math.max(vertexCount * 2, 16) * 3);
    for (let v = 0; v < vertexCount; v += 1) {
      const slot = identity.vertexRepresentativeCorner[v] ?? 0;
      pos[v * 3] = mesh.positions[slot * 3] ?? 0;
      pos[v * 3 + 1] = mesh.positions[slot * 3 + 1] ?? 0;
      pos[v * 3 + 2] = mesh.positions[slot * 3 + 2] ?? 0;
    }
    const incidence = buildVertexIncidence(asUint, faceCount, vertexCount);
    return new SurgeryMesh(
      pos,
      tri,
      vertexCount,
      faceCount,
      incidence.start,
      incidence.faces,
      mesh.metadata,
      Uint32Array.from(identity.vertexRepresentativeCorner.subarray(0, vertexCount)),
      Math.floor(mesh.positions.length / 3),
    );
  }

  public point(v: number): Vec3 {
    return [this.pos[v * 3] ?? 0, this.pos[v * 3 + 1] ?? 0, this.pos[v * 3 + 2] ?? 0];
  }

  public corners(face: number): [number, number, number] {
    return [this.tri[face * 3] ?? 0, this.tri[face * 3 + 1] ?? 0, this.tri[face * 3 + 2] ?? 0];
  }

  /** Alive faces at `v`, ascending by id. */
  public facesAt(v: number): number[] {
    const out: number[] = [];
    if (v < this.sourceVertexCount) {
      const from = this.csrStart[v] ?? 0;
      const to = this.csrStart[v + 1] ?? 0;
      for (let s = from; s < to; s += 1) {
        const f = this.csrFaces[s] ?? 0;
        if (this.alive[f] === 1) out.push(f);
      }
    }
    for (const f of this.extra.get(v) ?? []) if (this.alive[f] === 1) out.push(f);
    return out.sort((a, b) => a - b);
  }

  public addVertex(p: Vec3): number {
    if ((this.vertexCount + 1) * 3 > this.pos.length) {
      const grown = new Float64Array(this.pos.length * 2);
      grown.set(this.pos);
      this.pos = grown;
    }
    const v = this.vertexCount;
    this.vertexCount += 1;
    // Canonical storage is Float32: round once, here, so every later test sees
    // the coordinate that will actually be written.
    this.pos[v * 3] = Math.fround(p[0]);
    this.pos[v * 3 + 1] = Math.fround(p[1]);
    this.pos[v * 3 + 2] = Math.fround(p[2]);
    return v;
  }

  public addFace(a: number, b: number, c: number): number {
    if ((this.faceCount + 1) * 3 > this.tri.length) {
      const grown = new Int32Array(this.tri.length * 2);
      grown.set(this.tri);
      this.tri = grown;
      const aliveGrown = new Uint8Array(this.alive.length * 2);
      aliveGrown.set(this.alive);
      this.alive = aliveGrown;
    }
    const f = this.faceCount;
    this.faceCount += 1;
    this.tri[f * 3] = a;
    this.tri[f * 3 + 1] = b;
    this.tri[f * 3 + 2] = c;
    this.alive[f] = 1;
    for (const v of [a, b, c]) {
      const list = this.extra.get(v);
      if (list === undefined) this.extra.set(v, [f]);
      else list.push(f);
    }
    return f;
  }

  public kill(face: number): void {
    this.alive[face] = 0;
  }

  /** Reverses one face's winding (swaps corners 1 and 2). Moves no vertex; incidence is unchanged. */
  public flipFace(face: number): void {
    const a = this.tri[face * 3 + 1] ?? 0;
    this.tri[face * 3 + 1] = this.tri[face * 3 + 2] ?? 0;
    this.tri[face * 3 + 2] = a;
    if (face < this.sourceFaceCount) {
      if (this.reversedSourceFaces.has(face)) this.reversedSourceFaces.delete(face);
      else this.reversedSourceFaces.add(face);
    }
  }

  public revive(face: number): void {
    this.alive[face] = 1;
  }

  /**
   * Erases every face and vertex appended after the given counts, as if they had never
   * been added. Ids of everything that remains are unchanged. Used by the A2 search,
   * which builds and discards hundreds of tentative candidates per site and must not
   * leave dead faces in the incidence lists of the vertices it keeps probing.
   */
  public truncate(faceCount: number, vertexCount: number): void {
    for (let f = this.faceCount - 1; f >= faceCount; f -= 1) {
      for (const v of [this.tri[f * 3], this.tri[f * 3 + 1], this.tri[f * 3 + 2]]) {
        if (v === undefined) continue;
        const list = this.extra.get(v);
        while (
          list !== undefined &&
          list.length > 0 &&
          (list[list.length - 1] ?? -1) >= faceCount
        ) {
          list.pop();
        }
      }
      this.alive[f] = 0;
    }
    for (let v = vertexCount; v < this.vertexCount; v += 1) this.extra.delete(v);
    this.faceCount = faceCount;
    this.vertexCount = vertexCount;
  }

  public aliveFaceCount(): number {
    let n = 0;
    for (let f = 0; f < this.faceCount; f += 1) if (this.alive[f] === 1) n += 1;
    return n;
  }

  /**
   * An indexed canonical mesh: surviving source vertices in ascending original
   * order, then new vertices in creation order; surviving faces in source order,
   * then added faces. Orphaned vertices are not written.
   */
  /**
   * What this mesh now differs from its source by, in the SOURCE'S OWN SLOT SPACE: which source
   * faces are gone, which survive with their winding reversed, and the faces and vertices that
   * were added. Nothing is welded and no source vertex is renumbered: a new face names a retained
   * vertex by a position slot the source already had, and a new vertex by a slot appended after
   * them. The authoritative side applies this with the repair rebuild, which keeps the source's
   * representation (Policy B) and rebuilds groups.
   */
  public describePatch(): SurgeryPatch {
    const removed: number[] = [];
    const flipped: number[] = [];
    for (let f = 0; f < this.sourceFaceCount; f += 1) {
      if (this.alive[f] !== 1) removed.push(f);
      else if (this.reversedSourceFaces.has(f)) flipped.push(f);
    }
    const appendedVertexCount = this.vertexCount - this.sourceVertexCount;
    const appendedPositions = new Float32Array(appendedVertexCount * 3);
    for (let i = 0; i < appendedVertexCount * 3; i += 1) {
      appendedPositions[i] = this.pos[this.sourceVertexCount * 3 + i] ?? 0;
    }
    const slotOf = (vertex: number): number =>
      vertex < this.sourceVertexCount
        ? (this.representativeSlot[vertex] ?? 0)
        : this.sourceSlotCount + (vertex - this.sourceVertexCount);
    const corners: number[] = [];
    for (let f = this.sourceFaceCount; f < this.faceCount; f += 1) {
      if (this.alive[f] !== 1) continue;
      for (let c = 0; c < 3; c += 1) corners.push(slotOf(this.tri[f * 3 + c] ?? 0));
    }
    return {
      removedSourceFaces: Uint32Array.from(removed),
      flippedSourceFaces: Uint32Array.from(flipped),
      appendedPositions,
      appendedFaces: Uint32Array.from(corners),
    };
  }

  /**
   * The WELDED canonical form: one vertex per distinct coordinate, survivors then appended faces.
   * A diagnostic and test oracle; the product builds its candidate from `describePatch`.
   */
  public toCanonical(): CanonicalMesh {
    const used = new Uint8Array(this.vertexCount);
    let faces = 0;
    for (let f = 0; f < this.faceCount; f += 1) {
      if (this.alive[f] !== 1) continue;
      faces += 1;
      for (let c = 0; c < 3; c += 1) used[this.tri[f * 3 + c] ?? 0] = 1;
    }
    const remap = new Int32Array(this.vertexCount).fill(-1);
    let n = 0;
    for (let v = 0; v < this.vertexCount; v += 1) if (used[v] === 1) remap[v] = n++;
    const positions = createPositionArray(n * 3);
    for (let v = 0; v < this.vertexCount; v += 1) {
      const to = remap[v] ?? -1;
      if (to < 0) continue;
      positions[to * 3] = this.pos[v * 3] ?? 0;
      positions[to * 3 + 1] = this.pos[v * 3 + 1] ?? 0;
      positions[to * 3 + 2] = this.pos[v * 3 + 2] ?? 0;
    }
    const indices = createIndexArray(faces * 3);
    let k = 0;
    for (let f = 0; f < this.faceCount; f += 1) {
      if (this.alive[f] !== 1) continue;
      for (let c = 0; c < 3; c += 1) indices[k++] = remap[this.tri[f * 3 + c] ?? 0] ?? 0;
    }
    return { positions, indices, metadata: this.metadata };
  }
}

/* --------------------------------------------------------------- vectors -- */

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function mul(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function faceNormal(mesh: SurgeryMesh, face: number): Vec3 {
  const [a, b, c] = mesh.corners(face);
  return cross(sub(mesh.point(b), mesh.point(a)), sub(mesh.point(c), mesh.point(a)));
}

/* ------------------------------------------------------------------ fans -- */

/** Rotates a face's corners so `vertex` is first, keeping the winding. */
function fromVertex(mesh: SurgeryMesh, face: number, vertex: number): [number, number] | undefined {
  const [a, b, c] = mesh.corners(face);
  if (a === vertex) return [b, c];
  if (b === vertex) return [c, a];
  if (c === vertex) return [a, b];
  return undefined;
}

/**
 * The manifold fans at `vertex` in the LIVE mesh, each as an ordered chain. A
 * fan is a set of faces joined across edges at the vertex; its chain follows the
 * directed edges `u -> w` of faces `(V, u, w)`. A fan that is not one consistent
 * chain is refused rather than reordered by guesswork.
 */
export function liveFans(mesh: SurgeryMesh, vertex: number): LiveFans {
  const faces = mesh.facesAt(vertex);
  const entries: { face: number; u: number; w: number }[] = [];
  for (const face of faces) {
    const uw = fromVertex(mesh, face, vertex);
    if (uw === undefined) continue;
    if (uw[0] === uw[1] || uw[0] === vertex || uw[1] === vertex) {
      return { fans: [], refusal: SurgeryRefusal.DegenerateFan };
    }
    entries.push({ face, u: uw[0], w: uw[1] });
  }
  const count = entries.length;
  const parent = Array.from({ length: count }, (_, i) => i);
  const root = (x: number): number => {
    let r = x;
    while ((parent[r] ?? r) !== r) r = parent[r] ?? r;
    return r;
  };
  const byNeighbour = new Map<number, number[]>();
  const push = (v: number, i: number): void => {
    const list = byNeighbour.get(v);
    if (list === undefined) byNeighbour.set(v, [i]);
    else list.push(i);
  };
  entries.forEach((e, i) => {
    push(e.u, i);
    push(e.w, i);
  });
  for (const list of byNeighbour.values()) {
    if (list.length > 2) return { fans: [], refusal: SurgeryRefusal.NonManifoldEdge };
    if (list.length === 2) parent[root(list[1] ?? 0)] = root(list[0] ?? 0);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i += 1) {
    const r = root(i);
    const g = groups.get(r);
    if (g === undefined) groups.set(r, [i]);
    else g.push(i);
  }
  const fans: FanChain[] = [];
  for (const members of [...groups.values()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
    const succ = new Map<number, { w: number; face: number }>();
    const hasIn = new Set<number>();
    for (const i of members) {
      const e = entries[i];
      if (e === undefined) continue;
      if (succ.has(e.u) || hasIn.has(e.w)) {
        return { fans: [], refusal: SurgeryRefusal.InconsistentFan };
      }
      succ.set(e.u, { w: e.w, face: e.face });
      hasIn.add(e.w);
    }
    let start: number | undefined;
    for (const u of succ.keys()) {
      if (!hasIn.has(u)) {
        if (start !== undefined) return { fans: [], refusal: SurgeryRefusal.InconsistentFan };
        start = u;
      }
    }
    const closed = start === undefined;
    start ??= [...succ.keys()].sort((a, b) => a - b)[0];
    if (start === undefined) return { fans: [], refusal: SurgeryRefusal.InconsistentFan };
    const link: number[] = [start];
    const order: number[] = [];
    let at = start;
    for (let step = 0; step <= members.length; step += 1) {
      const next = succ.get(at);
      if (next === undefined) break;
      order.push(next.face);
      if (next.w === start) break;
      link.push(next.w);
      at = next.w;
    }
    if (order.length !== members.length)
      return { fans: [], refusal: SurgeryRefusal.InconsistentFan };
    fans.push({ faces: order, link, closed });
  }
  return { fans };
}

/** Number of manifold fans at a vertex of the live mesh (or -1 if not chain-like). */
export function liveFanCount(mesh: SurgeryMesh, vertex: number): number {
  const faces = mesh.facesAt(vertex);
  if (faces.length === 0) return 0;
  const edgeFaces = new Map<number, number[]>();
  const index = new Map<number, number>();
  faces.forEach((f, i) => index.set(f, i));
  for (const f of faces) {
    for (const x of mesh.corners(f)) {
      if (x === vertex) continue;
      const list = edgeFaces.get(x);
      if (list === undefined) edgeFaces.set(x, [f]);
      else list.push(f);
    }
  }
  const parent = faces.map((_, i) => i);
  const root = (x: number): number => {
    let r = x;
    while ((parent[r] ?? r) !== r) r = parent[r] ?? r;
    return r;
  };
  for (const list of edgeFaces.values()) {
    for (let j = 1; j < list.length; j += 1) {
      const a = index.get(list[0] ?? 0) ?? 0;
      const b = index.get(list[j] ?? 0) ?? 0;
      parent[root(b)] = root(a);
    }
  }
  const roots = new Set<number>();
  for (let i = 0; i < faces.length; i += 1) roots.add(root(i));
  return roots.size;
}

/* ----------------------------------------------------------- local edges -- */

function edgeKey(a: number, b: number): string {
  return a < b ? `${String(a)},${String(b)}` : `${String(b)},${String(a)}`;
}

/** Alive faces sharing the undirected edge (a, b), as `[face, directedAB]`. */
function facesOnEdge(mesh: SurgeryMesh, a: number, b: number): { face: number; ab: boolean }[] {
  const out: { face: number; ab: boolean }[] = [];
  for (const f of mesh.facesAt(a)) {
    const [x, y, z] = mesh.corners(f);
    const cyc: [number, number][] = [
      [x, y],
      [y, z],
      [z, x],
    ];
    for (const [p, q] of cyc) {
      if (p === a && q === b) out.push({ face: f, ab: true });
      else if (p === b && q === a) out.push({ face: f, ab: false });
    }
  }
  return out;
}

export interface EdgeAudit {
  boundary: number;
  nonManifold: number;
  windingConflicts: number;
}

export function auditEdges(mesh: SurgeryMesh, faces: readonly number[]): EdgeAudit {
  const seen = new Set<string>();
  const audit: EdgeAudit = { boundary: 0, nonManifold: 0, windingConflicts: 0 };
  for (const f of faces) {
    const [x, y, z] = mesh.corners(f);
    for (const [a, b] of [
      [x, y],
      [y, z],
      [z, x],
    ] as const) {
      const key = edgeKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      const on = facesOnEdge(mesh, a, b);
      if (on.length === 1) audit.boundary += 1;
      else if (on.length > 2) audit.nonManifold += 1;
      else if (on.length === 2 && on[0]?.ab === on[1]?.ab) audit.windingConflicts += 1;
    }
  }
  return audit;
}

/** True when an alive edge at `v` belongs to exactly one alive face. */
function onMeshBoundary(mesh: SurgeryMesh, v: number): boolean {
  for (const f of mesh.facesAt(v)) {
    for (const x of mesh.corners(f)) {
      if (x !== v && facesOnEdge(mesh, v, x).length === 1) return true;
    }
  }
  return false;
}

/* ----------------------------------------------------------- region/ring -- */

export interface FanRegion {
  readonly faces: Set<number>;
  /** Graph distance from V per vertex of the region. */
  readonly dist: Map<number, number>;
}

export function growRegion(
  mesh: SurgeryMesh,
  vertex: number,
  fan: FanChain,
  depth: number,
): FanRegion {
  const faces = new Set<number>(fan.faces);
  const dist = new Map<number, number>([[vertex, 0]]);
  for (const f of fan.faces) {
    for (const x of mesh.corners(f)) if (x !== vertex && !dist.has(x)) dist.set(x, 1);
  }
  for (let ring = 1; ring < depth; ring += 1) {
    const frontier = [...dist.entries()].filter(([, d]) => d === ring).map(([v]) => v);
    for (const v of frontier.sort((a, b) => a - b)) {
      for (const f of mesh.facesAt(v)) {
        if (faces.has(f)) continue;
        faces.add(f);
        for (const x of mesh.corners(f)) if (!dist.has(x)) dist.set(x, ring + 1);
      }
    }
  }
  return { faces, dist };
}

export function boundarySize(mesh: SurgeryMesh, faces: ReadonlySet<number>): number {
  const count = new Map<string, number>();
  for (const f of faces) {
    const [x, y, z] = mesh.corners(f);
    for (const [a, b] of [
      [x, y],
      [y, z],
      [z, x],
    ] as const) {
      const k = edgeKey(a, b);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  let n = 0;
  for (const c of count.values()) if (c === 1) n += 1;
  return n;
}

export interface Attempt {
  readonly removed: number[];
  readonly added: number[];
  readonly newVertices: number[];
  readonly interior: number;
  readonly maxInterior: number;
  readonly boundary: number;
}

/**
 * Hooks for the A2 engine. With none given the behaviour is exactly 05A's.
 *
 * `minSeparation` replaces the fixed apex-separation requirement (A2 states its own
 * separation rule over the apexes that actually move); `inspect` runs after every
 * structural gate and before the injected intersection test, and may refuse; `dryRun`
 * measures a candidate and then ROLLS IT BACK, so a candidate can be ranked before
 * the expensive exact test is spent on it.
 */
/** What a candidate is compared against: derived from the mesh and the removed set only. */
export interface CandidateBaseline {
  readonly before: EdgeAudit;
  readonly beforeFans: ReadonlyMap<number, number>;
  readonly touched: ReadonlySet<number>;
  readonly dupBefore: number;
  readonly oldNormals: ReadonlyMap<number, Vec3>;
  readonly outline: ReadonlySet<number>;
}

export interface TryExtras {
  readonly minSeparation?: number;
  readonly inspect?: (context: TentativeContext) => string | undefined;
  readonly dryRun?: boolean;
  /** Skip the exact intersection test (used only together with `dryRun`). */
  readonly skipAccept?: boolean;
  /** Erase a refused or dry-run attempt entirely instead of leaving dead faces behind. */
  readonly truncate?: boolean;
  /** REPAIR-CORE-05D: report timings here. Never read back by the algorithm. */
  /**
   * REPAIR-CORE-05D: shared baseline cache. The caller guarantees the mesh is identical at every
   * call that uses one cache instance (candidates of one site/depth, each rolled back).
   */
  readonly baselineCache?: Map<string, CandidateBaseline>;
}

/**
 * Builds and installs one tentative reconstruction. Returns the attempt, or a
 * string naming the gate that refused it (with the mesh left exactly as found).
 */
export function tryReconstruct(
  mesh: SurgeryMesh,
  vertex: number,
  fans: readonly FanChain[],
  regions: readonly FanRegion[],
  depth: number,
  offsets: readonly Vec3[],
  edges: readonly number[],
  accept: SurgeryAccept | undefined,
  extras: TryExtras = {},
): Attempt | string {
  const faceMark = mesh.faceCount;
  const vertexMark = mesh.vertexCount;
  const apexPoints = offsets.map((d) => add(mesh.point(vertex), d));
  // Gate: the apexes of this one operation must end apart, relative to the local
  // incident edge — derived from the ladder's smallest rung.
  let separation = Infinity;
  for (let i = 0; i < apexPoints.length; i += 1) {
    for (let j = i + 1; j < apexPoints.length; j += 1) {
      const d = len(sub(apexPoints[i] ?? [0, 0, 0], apexPoints[j] ?? [0, 0, 0]));
      const scaleEdge = ((edges[i] ?? 0) + (edges[j] ?? 0)) / 2;
      separation = Math.min(separation, scaleEdge > 0 ? d / scaleEdge : 0);
    }
  }
  if (fans.length > 1 && !(separation >= (extras.minSeparation ?? MINIMUM_APEX_SEPARATION))) {
    return 'apex-separation';
  }

  const removed: number[] = [];
  for (const region of regions) for (const f of region.faces) removed.push(f);
  removed.sort((a, b) => a - b);
  // The baseline of a candidate is a pure function of the mesh and the removed set. Every
  // candidate of one (site, depth, anchor) shares both, so a caller that guarantees the mesh
  // is unchanged between them may pass a cache (REPAIR-CORE-05D); the values are identical.
  const tripleKey = (a: number, b: number, c: number): string =>
    [a, b, c].sort((x, y) => x - y).join(',');
  const cacheKey = extras.baselineCache === undefined ? undefined : removed.join(',');
  let base = cacheKey === undefined ? undefined : extras.baselineCache?.get(cacheKey);
  if (base === undefined) {
    const before = auditEdges(mesh, removed);
    const beforeFans = new Map<number, number>();
    const touched = new Set<number>();
    for (const f of removed) for (const x of mesh.corners(f)) touched.add(x);
    for (const x of touched) if (x !== vertex) beforeFans.set(x, liveFanCount(mesh, x));

    // Duplicate baseline: removed faces that already coincide with an alive face.
    const removedSet = new Set(removed);
    const dupBefore = removed.filter((f) => {
      const [a, b, c] = mesh.corners(f);
      return mesh.facesAt(a).some((g) => {
        if (removedSet.has(g) || g === f) return false;
        const [x, y, z] = mesh.corners(g);
        return tripleKey(x, y, z) === tripleKey(a, b, c);
      });
    }).length;
    const oldNormals = new Map<number, Vec3>();
    for (const f of removed) oldNormals.set(f, faceNormal(mesh, f));
    // Mesh-boundary membership is read BEFORE the faces die, or every interior
    // vertex of the region would look like part of an outline.
    const outline = new Set<number>();
    for (const x of touched) if (onMeshBoundary(mesh, x)) outline.add(x);
    base = { before, beforeFans, touched, dupBefore, oldNormals, outline };
    if (cacheKey !== undefined) extras.baselineCache?.set(cacheKey, base);
  }
  const { before, beforeFans, dupBefore, oldNormals, outline } = base;

  const added: number[] = [];
  const newVertices: number[] = [];
  let interior = 0;
  let maxInterior = 0;
  for (const f of removed) mesh.kill(f);
  const rollback = (reason: string): string => {
    for (const f of added) mesh.kill(f);
    for (const f of removed) mesh.revive(f);
    if (extras.truncate === true) mesh.truncate(faceMark, vertexMark);
    return reason;
  };

  // Failed attempts leave dead faces and orphan vertices behind rather than
  // reusing their ids: the per-vertex incidence lists may still name them.
  const restore = (reason: string): string => rollback(reason);

  // Faces that would be re-emitted get their ids stored for the orientation test.
  const originOf = new Map<number, number>();
  fans.forEach((_, i) => {
    const region = regions[i];
    if (region === undefined) return;
    const apex = mesh.addVertex(apexPoints[i] ?? mesh.point(vertex));
    newVertices.push(apex);
    const d = offsets[i] ?? [0, 0, 0];
    const mapped = new Map<number, number>([[vertex, apex]]);
    const pinned = (x: number): boolean => {
      const k = region.dist.get(x) ?? depth;
      // Cut-cycle vertices stay; so do mesh-boundary vertices, the intended outline.
      return k >= depth || outline.has(x);
    };
    for (const f of [...region.faces].sort((a, b) => a - b)) {
      const corners: [number, number, number] = [0, 0, 0];
      mesh.corners(f).forEach((x, c) => {
        if (x === vertex) {
          corners[c] = apex;
          return;
        }
        if (pinned(x)) {
          corners[c] = x;
          return;
        }
        let m = mapped.get(x);
        if (m === undefined) {
          const w = 1 - (region.dist.get(x) ?? depth) / depth;
          m = mesh.addVertex(add(mesh.point(x), mul(d, w)));
          mapped.set(x, m);
          newVertices.push(m);
          interior += 1;
          maxInterior = Math.max(maxInterior, len(sub(mesh.point(m), mesh.point(x))));
        }
        corners[c] = m;
      });
      const id = mesh.addFace(corners[0], corners[1], corners[2]);
      added.push(id);
      originOf.set(id, f);
    }
  });
  // GATE 1 — orientation preserved, nothing exactly degenerate.
  for (const f of added) {
    const n = faceNormal(mesh, f);
    const old = oldNormals.get(originOf.get(f) ?? -1) ?? [0, 0, 0];
    if (!(len(n) > 0)) return restore('degenerate-face');
    if (!(dot(n, old) > 0)) return restore('flipped-face');
  }
  // GATE 2 — local topology: no new boundary, non-manifold edge or winding conflict.
  const after = auditEdges(mesh, added);
  if (after.nonManifold > before.nonManifold) return restore('new-non-manifold-edge');
  if (after.windingConflicts > before.windingConflicts) return restore('new-winding-conflict');
  if (after.boundary !== before.boundary) return restore('boundary-changed');
  // GATE 3 — every new vertex is one fan, no touched vertex gains fans.
  for (const v of newVertices)
    if (liveFanCount(mesh, v) !== 1) return restore('new-vertex-not-manifold');
  for (const [x, fansBefore] of beforeFans) {
    if (newVertices.includes(x)) continue;
    if (mesh.facesAt(x).length === 0) continue;
    if (liveFanCount(mesh, x) > fansBefore) return restore('vertex-gained-fans');
  }
  // GATE 4 — no new duplicate face.
  const addedSet = new Set(added);
  let dupAfter = 0;
  for (const f of added) {
    const [a, b, c] = mesh.corners(f);
    const hit = mesh.facesAt(a).some((g) => {
      if (addedSet.has(g) || g === f) return false;
      const [x, y, z] = mesh.corners(g);
      return tripleKey(x, y, z) === tripleKey(a, b, c);
    });
    if (hit) dupAfter += 1;
  }
  if (dupAfter > dupBefore) return restore('new-duplicate-face');
  // GATE 4b — A2's structural-quality hook (triangle quality, locality, fidelity).
  if (extras.inspect !== undefined) {
    const verdict = extras.inspect({ mesh, vertex, removedFaces: removed, addedFaces: added });
    if (verdict !== undefined) return restore(verdict);
  }
  if (extras.dryRun === true) {
    rollback('dry-run');
    return { removed, added, newVertices, interior, maxInterior, boundary: before.boundary };
  }

  // GATE 5 — the injected exact intersection test on the finished candidate.
  if (accept !== undefined && extras.skipAccept !== true) {
    const verdict = accept({ mesh, vertex, removedFaces: removed, addedFaces: added });
    if (verdict !== undefined) return restore(verdict);
  }
  return { removed, added, newVertices, interior, maxInterior, boundary: before.boundary };
}

/** What a local repair changed, in the source mesh's own slot space. See `describePatch`. */
export interface SurgeryPatch {
  /** Source faces that no longer exist, ascending. */
  readonly removedSourceFaces: Uint32Array;
  /** Source faces that survive with their winding reversed, ascending. */
  readonly flippedSourceFaces: Uint32Array;
  /** x, y, z of the appended vertices; vertex i occupies slot `sourceSlotCount + i`. */
  readonly appendedPositions: Float32Array;
  /** Three corner slots per appended face, in face order, already in their final winding. */
  readonly appendedFaces: Uint32Array;
}

/** One site's outcome. */
export interface SiteResult {
  readonly operation?: SurgeryOperation;
  readonly refusal?: SurgeryRefusalRecord;
}
