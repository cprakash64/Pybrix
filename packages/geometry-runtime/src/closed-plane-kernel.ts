import {
  composePartTransforms,
  isValidPartTransform,
  type CanonicalMesh,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import type { SplitPlane, SplitVector } from './split-connectors';

// Production port of the qualified local-space deterministic plane clip. The
// operation meter retains its typed allocations through return.
type Buffers = Pick<CanonicalMesh, 'positions' | 'indices'>;
type Point = [number, number, number];

export interface ClipBinding {
  readonly document: string;
  readonly revision: number;
  readonly part: string;
  readonly generation: number;
}

export interface CanonicalSplitFrame {
  readonly O: SplitVector;
  readonly U: SplitVector;
  readonly V: SplitVector;
  readonly N: SplitVector;
  readonly sourceToFrame: readonly number[];
  readonly frameToSource: readonly number[];
  readonly precision: {
    readonly scalar: 'BINARY64';
    readonly resident: 'FLOAT32';
    readonly subtractOriginBeforeProjection: true;
  };
  readonly sourceSHA: string;
  readonly binding: ClipBinding;
  readonly sideA: 'POSITIVE';
  readonly sideB: 'NEGATIVE';
  readonly identity: string;
}

interface ClipOptions {
  readonly binding: ClipBinding;
  readonly sourceSHA: string;
  readonly sourceReport: { readonly volume: number };
  readonly placement: PartTransform;
  readonly cancellation: CancellationToken;
}
interface Allocation {
  readonly name: string;
  readonly type: string;
  readonly count: number;
  readonly bytesPerElement: number;
  readonly bytes: number;
  readonly start: number;
  readonly end: string;
  readonly borrowed?: boolean;
  lastUseAllocationEvent?: number;
}
interface PhaseStart {
  readonly name: string;
  readonly start: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly allocationStart: number;
}
interface WorkPhase {
  readonly stage: string;
  readonly start: number;
  readonly end: number;
  readonly work: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly allocationStart: number;
  readonly allocationEnd: number;
}
interface ClipResources {
  readonly ledger: readonly WorkPhase[];
  readonly total: number;
  readonly limit: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly peakWorkspaceBytes: number;
  readonly remainingLiveBytes: number;
  readonly allocationPolicy: string;
  readonly allocations: readonly Allocation[];
}
interface ClosedMeshReport {
  readonly valid: boolean;
  readonly faces: number;
  readonly vertices: number;
  readonly edges: number;
  readonly zeroArea: number;
  readonly duplicates: number;
  readonly boundaryEdges: number;
  readonly nonManifoldVertices: number;
  readonly windingConflicts: number;
  readonly signedVolume: number;
  readonly volume: number;
}
export interface GeneratedSeparationInterface extends ClipBinding {
  readonly frame: CanonicalSplitFrame;
  readonly sourceSHA: string;
  readonly outputAnchor: SplitVector;
  readonly outputPlaneOrigin: SplitVector;
  readonly sharedRegion: {
    readonly positions: Float32Array;
    readonly uv: Float64Array;
    readonly loops: Uint32Array;
    readonly triangles: Uint32Array;
    readonly vertexMapA: Uint32Array;
    readonly vertexMapB: Uint32Array;
  };
  readonly area: number;
  readonly loopCount: number;
  readonly boundaryVertices: number;
  readonly capFaces: number;
  readonly footprintDifference: number;
  readonly orientationA: -1;
  readonly orientationB: 1;
}
export interface ClosedPlaneClip {
  readonly status: 'PASS';
  readonly pieceA: CanonicalMesh;
  readonly pieceB: CanonicalMesh;
  readonly sourcePlacement: PartTransform;
  readonly outputPlacement: PartTransform;
  readonly outputAnchor: SplitVector;
  readonly provenanceA: Int32Array;
  readonly provenanceB: Int32Array;
  readonly provenanceBinding: ClipBinding & {
    readonly sourceSHA: string;
    readonly frameIdentity: string;
  };
  readonly sourceDispositions: {
    readonly codes: Uint8Array;
    readonly sourceFaces: number;
    readonly crossed: number;
    readonly coplanar: number;
    readonly singleSide: number;
  };
  readonly interface: GeneratedSeparationInterface;
  readonly reports: readonly [ClosedMeshReport, ClosedMeshReport];
  readonly sourceVolume: number;
  readonly volumes: readonly [number, number];
  readonly volumeError: number;
  readonly tolerance: number;
  readonly maximumSourceAreaError: number;
  readonly sharedCapChainArea: number;
  readonly sharedCapCoverageError: number;
  readonly rebaseLossless: boolean;
  readonly quantizationBounds: { readonly absolute: number; readonly rebased: number };
  readonly maxCanonicalPlaneResidual: number;
  readonly maxIntersectionDisplacement: number;
  readonly sourcePreparationReceiptReused: boolean;
  readonly requestedPlaneMovement: number;
  readonly redundantFullSourceCopies: number;
  readonly resource: ClipResources;
}
type ClipResult =
  | ClosedPlaneClip
  | {
      readonly status: 'REFUSED';
      readonly reason: string;
      readonly resource: ClipResources;
    };

const POLICY = Object.freeze({
  work: 48000000,
  workspace: 1073741824,
  patchVertices: 65536,
  sourceFaces: 2000000,
  outputFaces: 2000000,
  volumeError: 1e-4,
  canonicalBytes: 402653184,
});
class Refusal extends Error {}

function read(array: ArrayLike<number>, index: number): number {
  const value = array[index];
  if (value === undefined) throw new Refusal('INVALID_INTERMEDIATE_INDEX');
  return value;
}
class Meter {
  #total = 0;
  private readonly counts: Record<string, number> = {};
  private live = 0;
  private peak = 0;
  private readonly allocations: Allocation[] = [];
  private readonly buffers = new Map<string, ArrayBufferView>();
  private readonly retained: ArrayBufferView[] = [];
  private readonly ledger: WorkPhase[] = [];
  private activePhase: PhaseStart | null = null;
  private readonly cancellation: CancellationToken;
  constructor(cancellation: CancellationToken) {
    this.cancellation = cancellation;
  }
  phase(name: string): void {
    if (this.activePhase) {
      const p = this.activePhase;
      const counts: Record<string, number> = {};
      for (const [key, count] of Object.entries(this.counts)) {
        const delta = count - (p.counts[key] ?? 0);
        if (delta !== 0) counts[key] = delta;
      }
      this.ledger.push({
        stage: p.name,
        start: p.start,
        end: this.#total,
        work: this.#total - p.start,
        counts,
        allocationStart: p.allocationStart,
        allocationEnd: this.allocations.length,
      });
    }
    this.activePhase = {
      name,
      start: this.#total,
      counts: { ...this.counts },
      allocationStart: this.allocations.length,
    };
  }
  checkCancellation(): void {
    throwIfCancelled(this.cancellation);
  }
  tick(stage: string, n = 1): void {
    this.checkCancellation();
    if (!Number.isSafeInteger(n) || n < 0) throw new Refusal('INVALID_WORK');
    this.#total += n;
    this.counts[stage] = (this.counts[stage] ?? 0) + n;
    if (this.#total > POLICY.work) throw new Refusal('WORK_LIMIT');
  }
  get total(): number {
    return this.#total;
  }
  array<T extends ArrayBufferView>(
    name: string,
    Type: { new (length: number): T; readonly BYTES_PER_ELEMENT: number; readonly name: string },
    n: number,
  ): T {
    if (!Number.isSafeInteger(n) || n < 0) throw new Refusal('INVALID_ALLOCATION');
    const bytes = n * Type.BYTES_PER_ELEMENT;
    if (this.live + bytes > POLICY.workspace) throw new Refusal('WORKSPACE_LIMIT');
    const a = new Type(n);
    this.live += bytes;
    this.peak = Math.max(this.peak, this.live);
    this.buffers.set(name, a);
    this.retained.push(a);
    this.allocations.push({
      name,
      type: Type.name,
      count: n,
      bytesPerElement: Type.BYTES_PER_ELEMENT,
      bytes,
      start: this.allocations.length,
      end: name.startsWith('result.') ? 'RESULT_LIFETIME' : 'OPERATION_RETURN',
    });
    return a;
  }
  borrow(name: string, buffer: ArrayBufferLike): void {
    if (this.live + buffer.byteLength > POLICY.workspace) throw new Refusal('WORKSPACE_LIMIT');
    const view = new Uint8Array(buffer);
    this.buffers.set(name, view);
    this.retained.push(view);
    this.live += view.byteLength;
    this.peak = Math.max(this.peak, this.live);
    this.allocations.push({
      name,
      type: 'BORROWED_ARRAY_BUFFER',
      count: buffer.byteLength,
      bytesPerElement: 1,
      bytes: buffer.byteLength,
      start: this.allocations.length,
      end: 'OPERATION_RETURN_BORROWED',
      borrowed: true,
    });
  }
  release(name: string): void {
    const a = this.buffers.get(name);
    if (a) {
      this.buffers.delete(name);
      const r = this.allocations.findLast(
        (x): boolean => x.name === name && x.lastUseAllocationEvent === undefined,
      );
      if (r) r.lastUseAllocationEvent = this.allocations.length;
    }
  }
  releasePrefix(prefix: string): void {
    for (const n of [...this.buffers.keys()]) if (n.startsWith(prefix)) this.release(n);
  }
  receipt(): ClipResources {
    if (this.activePhase) {
      this.phase('RETURN');
      this.activePhase = null;
    }
    return {
      ledger: this.ledger,
      total: this.#total,
      limit: POLICY.work,
      counts: { ...this.counts },
      peakWorkspaceBytes: this.peak,
      remainingLiveBytes: this.live,
      allocationPolicy: 'ALL_TYPED_BUFFERS_RETAINED_UNTIL_OPERATION_RETURN_NO_GC_ASSUMPTION',
      allocations: this.allocations,
    };
  }
}
const pow2 = (n: number): number => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};
const mix = (x: number): number => {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  return x ^ (x >>> 16);
};
const h2 = (a: number, b: number): number => mix(mix(a ^ 0x9e3779b9) ^ mix(b ^ 0x85ebca6b));
const h3 = (a: number, b: number, c: number): number => h2(h2(a, b), c);
function identity(
  mesh: Buffers,
  m: Meter,
  prefix: string,
): {
  map: Uint32Array<ArrayBuffer>;
  rep: Uint32Array<ArrayBuffer>;
  V: number;
  tab: Uint32Array<ArrayBuffer>;
  cap: number;
  bits: Uint32Array;
} {
  const C = mesh.positions.length / 3,
    cap = pow2(Math.ceil(C / 0.7)),
    map = m.array(prefix + 'map', Uint32Array, C),
    rep = m.array(prefix + 'rep', Uint32Array, C),
    tab = m.array(prefix + 'table', Uint32Array, cap),
    bits = new Uint32Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.length);
  let V = 0;
  for (let i = 0; i < C; i++) {
    m.tick('coordinate_identity');
    const at = 3 * i,
      x = read(bits, at) & 0x7fffffff ? read(bits, at) : 0,
      y = read(bits, at + 1) & 0x7fffffff ? read(bits, at + 1) : 0,
      z = read(bits, at + 2) & 0x7fffffff ? read(bits, at + 2) : 0;
    let slot = h3(x, y, z) & (cap - 1);
    while (read(tab, slot)) {
      m.tick('coordinate_identity_probe');
      const j = read(tab, slot) - 1;
      if (
        read(mesh.positions, 3 * j) === read(mesh.positions, at) &&
        read(mesh.positions, 3 * j + 1) === read(mesh.positions, at + 1) &&
        read(mesh.positions, 3 * j + 2) === read(mesh.positions, at + 2)
      )
        break;
      slot = (slot + 1) & (cap - 1);
    }
    if (!read(tab, slot)) {
      tab[slot] = i + 1;
      rep[V] = i;
      map[i] = V++;
    } else map[i] = read(map, read(tab, slot) - 1);
  }
  return { map, rep, V, tab, cap, bits };
}
function frame(plane: SplitPlane, sourceSHA: string, binding: ClipBinding): CanonicalSplitFrame {
  const len = Math.hypot(...plane.normal);
  if (!(len > 0) || !Number.isFinite(len) || !plane.origin.every(Number.isFinite))
    throw new Refusal('PLANE_INVALID');
  const N: SplitVector = [plane.normal[0] / len, plane.normal[1] / len, plane.normal[2] / len],
    k = N.map(Math.abs).indexOf(Math.min(...N.map(Math.abs))),
    axis: Point = [0, 0, 0];
  axis[k] = 1;
  const U: Point = [
      axis[1] * N[2] - axis[2] * N[1],
      axis[2] * N[0] - axis[0] * N[2],
      axis[0] * N[1] - axis[1] * N[0],
    ],
    ul = Math.hypot(...U);
  for (let i = 0; i < 3; i++) U[i] = read(U, i) / ul;
  const V: SplitVector = [
    N[1] * U[2] - N[2] * U[1],
    N[2] * U[0] - N[0] * U[2],
    N[0] * U[1] - N[1] * U[0],
  ];
  const O: SplitVector = [...plane.origin],
    sourceToFrame = [
      ...U,
      -(O[0] * U[0] + O[1] * U[1] + O[2] * U[2]),
      ...V,
      -(O[0] * V[0] + O[1] * V[1] + O[2] * V[2]),
      ...N,
      -(O[0] * N[0] + O[1] * N[1] + O[2] * N[2]),
    ],
    frameToSource = [U[0], V[0], N[0], O[0], U[1], V[1], N[1], O[1], U[2], V[2], N[2], O[2]];
  return Object.freeze({
    O: Object.freeze(O),
    N: Object.freeze(N),
    U: Object.freeze(U),
    V: Object.freeze(V),
    sourceToFrame: Object.freeze(sourceToFrame),
    frameToSource: Object.freeze(frameToSource),
    precision: Object.freeze({
      scalar: 'BINARY64' as const,
      resident: 'FLOAT32' as const,
      subtractOriginBeforeProjection: true as const,
    }),
    sourceSHA,
    binding,
    sideA: 'POSITIVE' as const,
    sideB: 'NEGATIVE' as const,
    identity: JSON.stringify({ plane, sourceSHA, binding }),
  });
}
function area2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function crossBound(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return 128 * Number.EPSILON * (Math.abs((bx - ax) * (cy - ay)) + Math.abs((by - ay) * (cx - ax)));
}
// One bounded typed linked polygon, including deterministic hole bridges.
function triangulate(
  loopIds: Uint32Array,
  starts: Uint32Array,
  loopCount: number,
  uv: Float64Array,
  m: Meter,
): { triangles: Uint32Array<ArrayBuffer>; depths: Uint32Array<ArrayBuffer> } {
  const B = loopIds.length,
    cap = B + 2 * loopCount + 4,
    id = m.array('cap.id', Uint32Array, cap),
    prev = m.array('cap.prev', Uint32Array, cap),
    next = m.array('cap.next', Uint32Array, cap),
    active = m.array('cap.active', Uint8Array, cap),
    depth = m.array('cap.depth', Uint32Array, loopCount),
    heads = m.array('cap.heads', Uint32Array, loopCount),
    out = m.array('cap.triangles', Uint32Array, Math.max(0, 3 * (B + 2 * loopCount)));
  let used = 0,
    w = 0;
  const x = (i: number): number => read(uv, 2 * read(id, i)),
    y = (i: number): number => read(uv, 2 * read(id, i) + 1),
    alloc = (v: number): number => {
      if (used >= cap) throw new Refusal('CAP_NODE_LIMIT');
      const n = used++;
      id[n] = v;
      active[n] = 1;
      return n;
    };
  function inside(px: number, py: number, loop: number): boolean {
    let yes = false;
    for (let j = read(starts, loop), end = read(starts, loop + 1), k = end - 1; j < end; k = j++) {
      m.tick('cap_containment');
      const a = read(loopIds, k),
        b = read(loopIds, j),
        ax = read(uv, 2 * a),
        ay = read(uv, 2 * a + 1),
        bx = read(uv, 2 * b),
        by = read(uv, 2 * b + 1);
      if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) yes = !yes;
    }
    return yes;
  }
  for (let l = 0; l < loopCount; l++) {
    const p = read(loopIds, read(starts, l));
    for (let q = 0; q < loopCount; q++)
      if (q !== l && inside(read(uv, 2 * p), read(uv, 2 * p + 1), q)) depth[l] = read(depth, l) + 1;
  }
  for (let l = 0; l < loopCount; l++) {
    let ar = 0;
    const begin = read(starts, l),
      end = read(starts, l + 1);
    for (let j = begin; j < end; j++) {
      m.tick('cap_loop_orientation');
      const a = read(loopIds, j),
        b = read(loopIds, j + 1 < end ? j + 1 : begin);
      const o = read(loopIds, begin);
      ar +=
        (read(uv, 2 * a) - read(uv, 2 * o)) * (read(uv, 2 * b + 1) - read(uv, 2 * o + 1)) -
        (read(uv, 2 * a + 1) - read(uv, 2 * o + 1)) * (read(uv, 2 * b) - read(uv, 2 * o));
    }
    const forward = ar > 0 === (read(depth, l) % 2 === 0);
    let first = 0,
      last = 0;
    for (let j = 0; j < end - begin; j++) {
      const node = alloc(read(loopIds, forward ? begin + j : end - 1 - j));
      if (j === 0) first = node;
      else {
        next[last] = node;
        prev[node] = last;
      }
      last = node;
    }
    next[last] = first;
    prev[first] = last;
    heads[l] = first;
  }
  function orient(a: number, b: number, c: number): number {
    return area2(x(a), y(a), x(b), y(b), x(c), y(c));
  }
  function properIntersect(a: number, b: number, c: number, d: number): boolean {
    const p = orient(a, b, c),
      q = orient(a, b, d),
      r = orient(c, d, a),
      s = orient(c, d, b);
    return p * q < 0 && r * s < 0;
  }
  for (let outer = 0; outer < loopCount; outer++)
    if (read(depth, outer) % 2 === 0) {
      const head = read(heads, outer);
      for (let hole = 0; hole < loopCount; hole++)
        if (
          read(depth, hole) === read(depth, outer) + 1 &&
          inside(
            read(uv, 2 * read(loopIds, read(starts, hole))),
            read(uv, 2 * read(loopIds, read(starts, hole)) + 1),
            outer,
          )
        ) {
          let h = read(heads, hole),
            at = read(next, h);
          while (at !== read(heads, hole)) {
            m.tick('cap_bridge_search');
            if (x(at) < x(h) || (x(at) === x(h) && y(at) < y(h))) h = at;
            at = read(next, at);
          }
          let best = -1,
            dist = Infinity,
            b = head;
          do {
            m.tick('cap_bridge_candidates');
            const d = (x(b) - x(h)) ** 2 + (y(b) - y(h)) ** 2;
            if (d < dist) {
              let visible = true;
              for (let l = 0; l < loopCount && visible; l++) {
                let e = read(heads, l);
                do {
                  m.tick('cap_bridge_visibility');
                  const f = read(next, e);
                  if (
                    read(id, e) !== read(id, h) &&
                    read(id, f) !== read(id, h) &&
                    read(id, e) !== read(id, b) &&
                    read(id, f) !== read(id, b) &&
                    properIntersect(h, b, e, f)
                  ) {
                    visible = false;
                    break;
                  }
                  e = f;
                } while (e !== read(heads, l));
              }
              const mx = (x(b) + x(h)) / 2,
                my = (y(b) + y(h)) / 2;
              if (visible && inside(mx, my, outer) && !inside(mx, my, hole)) {
                best = b;
                dist = d;
              }
            }
            b = read(next, b);
          } while (b !== head);
          if (best < 0) throw new Refusal('HOLE_BRIDGE_UNPROVEN');
          const a = best,
            an = read(next, a),
            hp = read(prev, h),
            a2 = alloc(read(id, a)),
            h2 = alloc(read(id, h));
          next[a] = h;
          prev[h] = a;
          next[hp] = h2;
          prev[h2] = hp;
          next[h2] = a2;
          prev[a2] = h2;
          next[a2] = an;
          prev[an] = a2;
        }
      let remaining = 0,
        n = head;
      do {
        remaining++;
        n = read(next, n);
      } while (n !== head);
      let tries = 0,
        b = head;
      while (remaining > 3) {
        m.tick('cap_ear_candidate');
        const a = read(prev, b),
          c = read(next, b),
          cr = orient(a, b, c),
          bound = crossBound(x(a), y(a), x(b), y(b), x(c), y(c));
        let ear = cr > bound;
        if (ear) {
          let pnode = read(next, c);
          while (pnode !== a) {
            m.tick('cap_ear_point');
            if (
              read(id, pnode) !== read(id, a) &&
              read(id, pnode) !== read(id, b) &&
              read(id, pnode) !== read(id, c)
            ) {
              const s1 = orient(a, b, pnode),
                s2 = orient(b, c, pnode),
                s3 = orient(c, a, pnode),
                e1 = crossBound(x(a), y(a), x(b), y(b), x(pnode), y(pnode)),
                e2 = crossBound(x(b), y(b), x(c), y(c), x(pnode), y(pnode)),
                e3 = crossBound(x(c), y(c), x(a), y(a), x(pnode), y(pnode));
              if (s1 >= -e1 && s2 >= -e2 && s3 >= -e3) {
                ear = false;
                break;
              }
            }
            pnode = read(next, pnode);
          }
        }
        if (ear) {
          out[w++] = read(id, a);
          out[w++] = read(id, b);
          out[w++] = read(id, c);
          next[a] = c;
          prev[c] = a;
          active[b] = 0;
          remaining--;
          b = c;
          tries = 0;
        } else {
          b = read(next, b);
          if (++tries > remaining) throw new Refusal('CAP_TRIANGULATION_UNPROVEN');
        }
      }
      const a = b,
        c = read(next, a),
        d = read(next, c);
      if (orient(a, c, d) <= crossBound(x(a), y(a), x(c), y(c), x(d), y(d)))
        throw new Refusal('CAP_FINAL_DEGENERATE');
      out[w++] = read(id, a);
      out[w++] = read(id, c);
      out[w++] = read(id, d);
    }
  return { triangles: out.subarray(0, w), depths: depth };
}
function validateHash(mesh: Buffers, m: Meter, prefix = 'validation.'): ClosedMeshReport {
  const C = mesh.positions.length / 3,
    F = mesh.indices.length / 3;
  if (F < 1 || F > POLICY.outputFaces) throw new Refusal('OUTPUT_FACE_LIMIT');
  const ident = identity(mesh, m, prefix + 'identity.'),
    V = ident.V,
    ecap = pow2(Math.ceil((1.5 * F) / 0.7)),
    fcap = pow2(Math.ceil(F / 0.7)),
    lo = m.array(prefix + 'lo', Uint32Array, ecap),
    hi = m.array(prefix + 'hi', Uint32Array, ecap),
    first = m.array(prefix + 'first', Uint32Array, ecap),
    cnt = m.array(prefix + 'count', Uint8Array, ecap),
    mate = m.array(prefix + 'mate', Uint32Array, 3 * F),
    vfirst = m.array(prefix + 'vfirst', Uint32Array, V),
    degree = m.array(prefix + 'degree', Uint32Array, V),
    fa = m.array(prefix + 'fa', Uint32Array, fcap),
    fb = m.array(prefix + 'fb', Uint32Array, fcap),
    fc = m.array(prefix + 'fc', Uint32Array, fcap);
  let edges = 0,
    closed = 0,
    six = 0,
    comp = 0;
  const O = [read(mesh.positions, 0), read(mesh.positions, 1), read(mesh.positions, 2)];
  for (let v = 0; v < C; v++) {
    m.tick('validation_coordinates');
    if (
      !Number.isFinite(read(mesh.positions, v * 3)) ||
      !Number.isFinite(read(mesh.positions, v * 3 + 1)) ||
      !Number.isFinite(read(mesh.positions, v * 3 + 2))
    )
      throw new Refusal('NONFINITE_COORDINATE');
  }
  for (let f = 0; f < F; f++) {
    m.tick('validation_faces');
    const i = f * 3,
      sa = read(mesh.indices, i),
      sb = read(mesh.indices, i + 1),
      sc = read(mesh.indices, i + 2);
    if (sa >= C || sb >= C || sc >= C) throw new Refusal('INVALID_INDEX');
    const a = read(ident.map, sa),
      b = read(ident.map, sb),
      c = read(ident.map, sc);
    if (a === b || b === c || c === a) throw new Refusal('REPEATED_POSITION_FACE');
    const ia = 3 * sa,
      ib = 3 * sb,
      ic = 3 * sc,
      ax = read(mesh.positions, ia) - read(O, 0),
      ay = read(mesh.positions, ia + 1) - read(O, 1),
      az = read(mesh.positions, ia + 2) - read(O, 2),
      bx = read(mesh.positions, ib) - read(O, 0),
      by = read(mesh.positions, ib + 1) - read(O, 1),
      bz = read(mesh.positions, ib + 2) - read(O, 2),
      cx = read(mesh.positions, ic) - read(O, 0),
      cy = read(mesh.positions, ic + 1) - read(O, 1),
      cz = read(mesh.positions, ic + 2) - read(O, 2),
      ux = read(mesh.positions, ib) - read(mesh.positions, ia),
      uy = read(mesh.positions, ib + 1) - read(mesh.positions, ia + 1),
      uz = read(mesh.positions, ib + 2) - read(mesh.positions, ia + 2),
      vx = read(mesh.positions, ic) - read(mesh.positions, ia),
      vy = read(mesh.positions, ic + 1) - read(mesh.positions, ia + 1),
      vz = read(mesh.positions, ic + 2) - read(mesh.positions, ia + 2);
    if (uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0)
      throw new Refusal('ZERO_AREA_FACE');
    const term = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx),
      y = term - comp,
      t = six + y;
    comp = t - six - y;
    six = t;
    let A = a,
      B = b,
      D = c;
    let swap;
    if (A > B) {
      swap = A;
      A = B;
      B = swap;
    }
    if (B > D) {
      swap = B;
      B = D;
      D = swap;
    }
    if (A > B) {
      swap = A;
      A = B;
      B = swap;
    }
    let slot = h3(A, B, D) & (fcap - 1);
    while (read(fa, slot)) {
      m.tick('validation_face_hash_probe');
      if (read(fa, slot) === A + 1 && read(fb, slot) === B && read(fc, slot) === D)
        throw new Refusal('DUPLICATE_FACE');
      slot = (slot + 1) & (fcap - 1);
    }
    fa[slot] = A + 1;
    fb[slot] = B;
    fc[slot] = D;
    for (let k = 0; k < 3; k++) {
      m.tick('validation_edge');
      const u = k === 0 ? a : k === 1 ? b : c,
        v = k === 0 ? b : k === 1 ? c : a,
        L = Math.min(u, v),
        H = Math.max(u, v),
        half = i + k;
      degree[u] = read(degree, u) + 1;
      if (!read(vfirst, u)) vfirst[u] = half + 1;
      let s = h2(L, H) & (ecap - 1);
      while (read(lo, s) && (read(lo, s) !== L + 1 || read(hi, s) !== H)) {
        m.tick('validation_edge_hash_probe');
        s = (s + 1) & (ecap - 1);
      }
      if (!read(lo, s)) {
        lo[s] = L + 1;
        hi[s] = H;
        first[s] = half + 1;
        cnt[s] = 1;
        edges++;
      } else {
        if (read(cnt, s) !== 1) throw new Refusal('NONMANIFOLD_EDGE');
        const old = read(first, s) - 1,
          oldStart = read(ident.map, read(mesh.indices, old));
        if (oldStart === u) throw new Refusal('WINDING_CONFLICT');
        cnt[s] = 2;
        mate[old] = half;
        mate[half] = old;
        closed++;
      }
    }
  }
  if (edges !== closed) throw new Refusal('OPEN_EDGES');
  for (let v = 0; v < V; v++) {
    m.tick('validation_vertex');
    if (!read(degree, v)) continue;
    const firstHalf = read(vfirst, v) - 1;
    let h = firstHalf,
      n = 0;
    do {
      m.tick('validation_vertex_fan');
      const previous = h - (h % 3) + (((h % 3) + 2) % 3);
      h = read(mate, previous);
      if (++n > read(degree, v)) throw new Refusal('VERTEX_FAN_CYCLE');
    } while (h !== firstHalf);
    if (n !== read(degree, v)) throw new Refusal('NONMANIFOLD_VERTEX');
  }
  const result = {
    valid: true,
    faces: F,
    vertices: V,
    edges,
    zeroArea: 0,
    duplicates: 0,
    boundaryEdges: 0,
    nonManifoldVertices: 0,
    windingConflicts: 0,
    signedVolume: six / 6,
    volume: Math.abs(six / 6),
  };
  m.releasePrefix(prefix);
  return result;
}
export function clipPlane(source: Buffers, plane: SplitPlane, options: ClipOptions): ClipResult {
  const m = new Meter(options.cancellation),
    binding = options.binding;
  try {
    m.phase('BIND_SOURCE');
    if (
      !Number.isSafeInteger(binding.revision) ||
      !Number.isSafeInteger(binding.generation) ||
      binding.revision < 0 ||
      binding.generation < 0
    )
      throw new Refusal('INVALID_BINDING');
    if (!isValidPartTransform(options.placement)) throw new Refusal('INVALID_PLACEMENT');
    const [ma, mb, mc, md, me, mf, mg, mh, mi] = options.placement;
    const determinant =
      ma * (me * mi - mh * mf) - md * (mb * mi - mh * mc) + mg * (mb * mf - me * mc);
    if (!Number.isFinite(determinant) || determinant === 0) throw new Refusal('SINGULAR_PLACEMENT');
    const C = source.positions.length / 3,
      F = source.indices.length / 3;
    if (source.positions.byteLength + source.indices.byteLength > POLICY.canonicalBytes)
      throw new Refusal('SOURCE_CANONICAL_BYTES');
    m.borrow('resident.source.positions', source.positions.buffer);
    if (source.indices.buffer !== source.positions.buffer)
      m.borrow('resident.source.indices', source.indices.buffer);
    if (F > POLICY.sourceFaces || !F) throw new Refusal('SOURCE_FACE_LIMIT');
    m.tick('source_content_binding', C + F);
    const sourceSHA = options.sourceSHA;
    const sourceReport = options.sourceReport;

    if (!(sourceReport.volume > 0)) throw new Refusal('SOURCE_ORIENTATION_UNPROVEN');
    m.phase('SOURCE_IDENTITY_BOUNDS');
    const sf = frame(plane, sourceSHA, binding),
      ident = identity(source, m, 'sourceIdentity.'),
      V = ident.V,
      dist = m.array('distances', Float64Array, V),
      side = m.array('sides', Int8Array, V);
    let xmin = Infinity,
      ymin = Infinity,
      zmin = Infinity,
      xmax = -Infinity,
      ymax = -Infinity,
      zmax = -Infinity;
    const candidateAnchor: Point = [
        read(source.positions, 0),
        read(source.positions, 1),
        read(source.positions, 2),
      ],
      relativeMax = [0, 0, 0];
    let rebaseLossless = true,
      outputAnchor: Point = [0, 0, 0];
    for (let v = 0; v < V; v++) {
      m.tick('source_bounds');
      const i = 3 * read(ident.rep, v),
        x = read(source.positions, i),
        y = read(source.positions, i + 1),
        z = read(source.positions, i + 2);
      xmin = Math.min(xmin, x);
      xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
      zmin = Math.min(zmin, z);
      zmax = Math.max(zmax, z);
      for (let k = 0; k < 3; k++) {
        const original = read(source.positions, i + k),
          relative = original - read(candidateAnchor, k);
        relativeMax[k] = Math.max(read(relativeMax, k), Math.abs(relative));
        if (Math.fround(relative) + read(candidateAnchor, k) !== original) rebaseLossless = false;
      }
    }
    const tolerance = Math.max(
      Math.hypot(xmax - xmin, ymax - ymin, zmax - zmin) * 1e-6,
      Math.max(
        1,
        Math.abs(xmin),
        Math.abs(xmax),
        Math.abs(ymin),
        Math.abs(ymax),
        Math.abs(zmin),
        Math.abs(zmax),
      ) *
        Number.EPSILON *
        64,
    );
    m.phase('CLASSIFY_VERTICES');
    for (let v = 0; v < V; v++) {
      m.tick('source_vertex_classification');
      const i = 3 * read(ident.rep, v),
        d =
          (read(source.positions, i) - sf.O[0]) * sf.N[0] +
          (read(source.positions, i + 1) - sf.O[1]) * sf.N[1] +
          (read(source.positions, i + 2) - sf.O[2]) * sf.N[2];
      dist[v] = d;
      side[v] = Math.abs(d) <= tolerance ? 0 : d > 0 ? 1 : -1;
    }
    const dispositions = m.array('result.sourceFaceDisposition', Uint8Array, F);
    let countA = 0,
      countB = 0,
      occ = 0,
      crossed = 0,
      coplanar = 0;
    function vertices(f: number, out: Uint32Array): void {
      const i = 3 * f;
      for (let k = 0; k < 3; k++) {
        const storage = read(source.indices, i + k);
        if (storage >= C) throw new Refusal('SOURCE_INDEX');
        out[k] = read(ident.map, storage);
      }
    }
    const tri = m.array('scratch.triangle', Uint32Array, 3);
    m.phase('CLASSIFY_TRIANGLES');
    for (let f = 0; f < F; f++) {
      m.tick('source_triangle_classification');
      vertices(f, tri);
      let a = 0,
        b = 0,
        z = 0;
      for (let k = 0; k < 3; k++) {
        if (read(side, read(tri, k)) > 0) a++;
        else if (read(side, read(tri, k)) < 0) b++;
        else z++;
      }
      let code;
      if (z === 3) {
        const i = 3 * read(ident.rep, read(tri, 0)),
          j = 3 * read(ident.rep, read(tri, 1)),
          k = 3 * read(ident.rep, read(tri, 2)),
          ux = read(source.positions, j) - read(source.positions, i),
          uy = read(source.positions, j + 1) - read(source.positions, i + 1),
          uz = read(source.positions, j + 2) - read(source.positions, i + 2),
          vx = read(source.positions, k) - read(source.positions, i),
          vy = read(source.positions, k + 1) - read(source.positions, i + 1),
          vz = read(source.positions, k + 2) - read(source.positions, i + 2),
          orient =
            (uy * vz - uz * vy) * sf.N[0] +
            (uz * vx - ux * vz) * sf.N[1] +
            (ux * vy - uy * vx) * sf.N[2];
        if (orient === 0) throw new Refusal('COPLANAR_MATERIAL_AMBIGUOUS');
        code = orient > 0 ? 4 : 3;
        coplanar++;
        occ += 3;
        if (code === 3) countA++;
        else countB++;
      } else if (!b) {
        code = 1;
        countA++;
        if (z === 2) occ++;
      } else if (!a) {
        code = 2;
        countB++;
        if (z === 2) occ++;
      } else {
        code = 5;
        crossed++;
        countA += a === 2 && z === 0 ? 2 : 1;
        countB += b === 2 && z === 0 ? 2 : 1;
        occ += 2;
      }
      dispositions[f] = code;
    }
    const absoluteQuantizationBound = Math.hypot(
        ...[
          Math.max(Math.abs(xmin), Math.abs(xmax)),
          Math.max(Math.abs(ymin), Math.abs(ymax)),
          Math.max(Math.abs(zmin), Math.abs(zmax)),
        ].map((v): number => Math.max(2 ** -150, v * 2 ** -24)),
      ),
      relativeQuantizationBound = Math.hypot(
        ...relativeMax.map((v): number => Math.max(2 ** -150, v * 2 ** -24)),
      );
    if (crossed && absoluteQuantizationBound > tolerance) {
      if (!rebaseLossless || relativeQuantizationBound > tolerance)
        throw new Refusal('OUTPUT_FRAME_PRECISION_UNREPRESENTABLE');
      outputAnchor = [...candidateAnchor];
    }
    const outputPlaneOrigin: SplitVector = [
      sf.O[0] - outputAnchor[0],
      sf.O[1] - outputAnchor[1],
      sf.O[2] - outputAnchor[2],
    ];
    if (!countA || !countB) throw new Refusal('EMPTY_PIECE');
    if (occ % 2) throw new Refusal('UNPAIRED_SOURCE_SECTION');
    const maxCut = crossed,
      edgeCap = pow2(Math.max(1, Math.ceil(maxCut / 0.7))),
      el = m.array('intersection.lo', Uint32Array, edgeCap),
      eh = m.array('intersection.hi', Uint32Array, edgeCap),
      ev = m.array('intersection.vertex', Uint32Array, edgeCap),
      newPoints = m.array('intersection.coordinates', Float32Array, maxCut * 3),
      poolMax = V + maxCut,
      usedA = m.array('usedA', Uint8Array, poolMax),
      usedB = m.array('usedB', Uint8Array, poolMax),
      graphMax = Math.max(1, occ / 2),
      gcap = pow2(Math.ceil(graphMax / 0.7)),
      gl = m.array('graph.lo', Uint32Array, gcap),
      gh = m.array('graph.hi', Uint32Array, gcap),
      ga = m.array('graph.A', Int8Array, gcap),
      gb = m.array('graph.B', Int8Array, gcap),
      occupied = m.array('graph.occupied', Uint32Array, graphMax);
    let K = 0,
      G = 0,
      maxResidual = 0,
      maxDisplacement = 0;
    const p0 = m.array('scratch.point0', Float64Array, 3),
      p1 = m.array('scratch.point1', Float64Array, 3),
      p2 = m.array('scratch.point2', Float64Array, 3);
    function point(id: number, p: Float64Array, relative = false): Float64Array {
      if (id < V) {
        const i = 3 * read(ident.rep, id);
        for (let k = 0; k < 3; k++)
          p[k] = read(source.positions, i + k) - (relative ? read(outputAnchor, k) : 0);
      } else {
        const i = 3 * (id - V);
        for (let k = 0; k < 3; k++)
          p[k] = read(newPoints, i + k) + (relative ? 0 : read(outputAnchor, k));
      }
      return p;
    }
    function intersection(a: number, b: number): number {
      const L = Math.min(a, b),
        H = Math.max(a, b);
      let s = h2(L, H) & (edgeCap - 1);
      while (read(el, s)) {
        m.tick('intersection_hash_probe');
        if (read(el, s) === L + 1 && read(eh, s) === H) return read(ev, s);
        s = (s + 1) & (edgeCap - 1);
      }
      m.tick('intersection_create');
      if (K >= maxCut) throw new Refusal('INTERSECTION_CACHE_BOUND');
      point(L, p0);
      point(H, p1);
      const t = read(dist, L) / (read(dist, L) - read(dist, H)),
        id = V + K;
      let displacement = 0;
      for (let k = 0; k < 3; k++) {
        const x = read(p0, k) - read(outputAnchor, k) + t * (read(p1, k) - read(p0, k));
        newPoints[3 * K + k] = x;
        displacement += (read(newPoints, 3 * K + k) - x) ** 2;
      }
      if (Math.sqrt(displacement) > tolerance) throw new Refusal('CANONICAL_EDGE_DISPLACEMENT');
      point(id, p2, true);
      if (
        (read(p2, 0) === read(p0, 0) - outputAnchor[0] &&
          read(p2, 1) === read(p0, 1) - outputAnchor[1] &&
          read(p2, 2) === read(p0, 2) - outputAnchor[2]) ||
        (read(p2, 0) === read(p1, 0) - outputAnchor[0] &&
          read(p2, 1) === read(p1, 1) - outputAnchor[1] &&
          read(p2, 2) === read(p1, 2) - outputAnchor[2])
      )
        throw new Refusal('CANONICAL_INTERSECTION_COLLAPSE');
      const residual = Math.abs(
        (read(p2, 0) - outputPlaneOrigin[0]) * sf.N[0] +
          (read(p2, 1) - outputPlaneOrigin[1]) * sf.N[1] +
          (read(p2, 2) - outputPlaneOrigin[2]) * sf.N[2],
      );
      if (residual > tolerance) throw new Refusal('CANONICAL_PLANE_RESIDUAL');
      maxResidual = Math.max(maxResidual, residual);
      maxDisplacement = Math.max(maxDisplacement, Math.sqrt(displacement));
      el[s] = L + 1;
      eh[s] = H;
      ev[s] = id;
      K++;
      return id;
    }
    function planeVertex(id: number): boolean {
      return id >= V || read(side, id) === 0;
    }
    function addEdge(a: number, b: number, s: number): void {
      m.tick('cut_graph_edge');
      if (a === b) throw new Refusal('CUT_ZERO_EDGE');
      const L = Math.min(a, b),
        H = Math.max(a, b);
      let q = h2(L, H) & (gcap - 1);
      while (read(gl, q) && (read(gl, q) !== L + 1 || read(gh, q) !== H)) {
        m.tick('cut_graph_hash_probe');
        q = (q + 1) & (gcap - 1);
      }
      if (!read(gl, q)) {
        if (G >= graphMax) throw new Refusal('CUT_GRAPH_BOUND');
        gl[q] = L + 1;
        gh[q] = H;
        occupied[G++] = q;
      }
      const arr = s === 0 ? ga : gb;
      arr[q] = read(arr, q) + (a === L ? 1 : -1);
      if (Math.abs(read(arr, q)) > 2) throw new Refusal('CUT_NONMANIFOLD_EDGE');
    }
    const polyA = m.array('scratch.polyA', Uint32Array, 4),
      polyB = m.array('scratch.polyB', Uint32Array, 4);
    function polygon(s: number, poly: Uint32Array): number {
      let n = 0;
      for (let k = 0; k < 3; k++) {
        m.tick('triangle_clip_edge');
        const a = read(tri, k),
          b = read(tri, (k + 1) % 3),
          sa = read(side, a),
          sb = read(side, b);
        if (sa * (s === 0 ? 1 : -1) >= 0) poly[n++] = a;
        if (sa * sb < 0) poly[n++] = intersection(a, b);
      }
      return n;
    }
    function graphPolygon(poly: Uint32Array, n: number, s: number): void {
      for (let k = 0; k < n; k++) {
        const a = read(poly, k),
          b = read(poly, (k + 1) % n);
        if (s === 0) usedA[a] = 1;
        else usedB[a] = 1;
        if (planeVertex(a) && planeVertex(b)) addEdge(a, b, s);
      }
    }
    m.phase('BUILD_CUT_GRAPH');
    for (let f = 0; f < F; f++) {
      m.tick('cut_graph_source_pass');
      vertices(f, tri);
      const d = read(dispositions, f);
      if (d === 5) {
        graphPolygon(polyA, polygon(0, polyA), 0);
        graphPolygon(polyB, polygon(1, polyB), 1);
      } else graphPolygon(tri, 3, d === 1 || d === 3 ? 0 : 1);
    }
    const next = m.array('graph.next', Uint32Array, V + K),
      indegree = m.array('graph.indegree', Uint8Array, V + K),
      boundary = m.array('graph.boundary', Uint32Array, Math.min(POLICY.patchVertices, G)),
      boundaryIds = m.array('graph.boundaryIds', Uint32Array, Math.min(POLICY.patchVertices, G)),
      boundaryCountMax = boundary.length;
    let B = 0;
    m.phase('EXTRACT_GRAPH_LOOPS');
    for (let i = 0; i < G; i++) {
      m.tick('cut_graph_extract');
      const s = read(occupied, i);
      if (read(ga, s) === 0 && read(gb, s) === 0) continue;
      if (Math.abs(read(ga, s)) !== 1 || read(ga, s) !== -read(gb, s))
        throw new Refusal('UNPAIRED_CUT_BOUNDARY');
      const a = read(ga, s) > 0 ? read(gl, s) - 1 : read(gh, s),
        b = read(ga, s) > 0 ? read(gh, s) : read(gl, s) - 1;
      if (read(next, a) || (indegree[b] = read(indegree, b) + 1) !== 1)
        throw new Refusal('BRANCHED_CUT_GRAPH');
      next[a] = b + 1;
      if (B >= boundaryCountMax) throw new Refusal('PATCH_VERTEX_LIMIT');
      boundary[B] = a;
      B++;
    }
    if (!B) throw new Refusal('NO_GENERATED_INTERFACE');
    const visited = m.array('graph.visited', Uint8Array, V + K),
      loopStarts = m.array('graph.loopStarts', Uint32Array, B + 1),
      uv = m.array('graph.uv', Float64Array, 2 * B);
    let cursor = 0,
      loops = 0;
    for (let i = 0; i < B; i++) {
      const start = read(boundary, i);
      if (read(visited, start)) continue;
      loopStarts[loops++] = cursor;
      let at = start;
      do {
        m.tick('cut_loop_walk');
        if (read(visited, at) || !read(next, at) || read(indegree, at) !== 1)
          throw new Refusal('OPEN_CUT_GRAPH');
        visited[at] = 1;
        boundaryIds[cursor] = at;
        point(at, p0, true);
        uv[2 * cursor] =
          (read(p0, 0) - outputPlaneOrigin[0]) * sf.U[0] +
          (read(p0, 1) - outputPlaneOrigin[1]) * sf.U[1] +
          (read(p0, 2) - outputPlaneOrigin[2]) * sf.U[2];
        uv[2 * cursor + 1] =
          (read(p0, 0) - outputPlaneOrigin[0]) * sf.V[0] +
          (read(p0, 1) - outputPlaneOrigin[1]) * sf.V[1] +
          (read(p0, 2) - outputPlaneOrigin[2]) * sf.V[2];
        maxResidual = Math.max(
          maxResidual,
          Math.abs(
            (read(p0, 0) - outputPlaneOrigin[0]) * sf.N[0] +
              (read(p0, 1) - outputPlaneOrigin[1]) * sf.N[1] +
              (read(p0, 2) - outputPlaneOrigin[2]) * sf.N[2],
          ),
        );
        cursor++;
        at = read(next, at) - 1;
      } while (at !== start);
      if (cursor - read(loopStarts, loops - 1) < 3) throw new Refusal('CUT_LOOP_TOO_SHORT');
    }
    loopStarts[loops] = cursor;
    // Source ancestry supplies exact endpoint identity; projected nonadjacent contacts are refused.
    m.phase('CHECK_CONTOURS');
    const edgeNext = m.array('graph.localNext', Uint32Array, B);
    for (let l = 0; l < loops; l++)
      for (let i = read(loopStarts, l); i < read(loopStarts, l + 1); i++) {
        m.tick('cut_contour_prepare');
        edgeNext[i] = i + 1 < read(loopStarts, l + 1) ? i + 1 : read(loopStarts, l);
      }
    for (let a = 0; a < B; a++)
      for (let c = a + 1; c < B; c++) {
        m.tick('cut_contour_pair');
        const b = read(edgeNext, a),
          d = read(edgeNext, c);
        if (a === c || a === d || b === c || b === d) continue;
        const ax = read(uv, 2 * a),
          ay = read(uv, 2 * a + 1),
          bx = read(uv, 2 * b),
          by = read(uv, 2 * b + 1),
          cx = read(uv, 2 * c),
          cy = read(uv, 2 * c + 1),
          dx = read(uv, 2 * d),
          dy = read(uv, 2 * d + 1);
        if (
          Math.max(ax, bx) < Math.min(cx, dx) ||
          Math.max(cx, dx) < Math.min(ax, bx) ||
          Math.max(ay, by) < Math.min(cy, dy) ||
          Math.max(cy, dy) < Math.min(ay, by)
        )
          continue;
        const abC = area2(ax, ay, bx, by, cx, cy),
          abD = area2(ax, ay, bx, by, dx, dy),
          cdA = area2(cx, cy, dx, dy, ax, ay),
          cdB = area2(cx, cy, dx, dy, bx, by),
          s1 = Math.abs(abC) <= crossBound(ax, ay, bx, by, cx, cy) ? 0 : Math.sign(abC),
          s2 = Math.abs(abD) <= crossBound(ax, ay, bx, by, dx, dy) ? 0 : Math.sign(abD),
          s3 = Math.abs(cdA) <= crossBound(cx, cy, dx, dy, ax, ay) ? 0 : Math.sign(cdA),
          s4 = Math.abs(cdB) <= crossBound(cx, cy, dx, dy, bx, by) ? 0 : Math.sign(cdB);
        if (s1 * s2 <= 0 && s3 * s4 <= 0) throw new Refusal('CUT_CONTOUR_INTERSECTION');
      }
    // Cap triangulation uses local loop-position indices, then maps to shared pool IDs.
    m.phase('TRIANGULATE_SHARED_REGION');
    const localIds = m.array('cap.localLoopIds', Uint32Array, B);
    for (let i = 0; i < B; i++) {
      m.tick('cap_local_identity');
      localIds[i] = i;
    }
    const caps = triangulate(localIds, loopStarts.subarray(0, loops + 1), loops, uv, m),
      capFaces = caps.triangles.length / 3;
    m.phase('CONSTRUCT_OUTPUTS');
    for (let i = 0; i < B; i++) {
      m.tick('interface_vertex_membership');
      usedA[read(boundaryIds, i)] = 1;
      usedB[read(boundaryIds, i)] = 1;
    }
    const mapA = m.array('output.mapA', Uint32Array, V + K),
      mapB = m.array('output.mapB', Uint32Array, V + K);
    let VA = 0,
      VB = 0;
    for (let v = 0; v < V + K; v++) {
      m.tick('output_compaction_count');
      if (read(usedA, v)) mapA[v] = ++VA;
      if (read(usedB, v)) mapB[v] = ++VB;
    }
    const posA = m.array('result.A.positions', Float32Array, 3 * VA),
      posB = m.array('result.B.positions', Float32Array, 3 * VB),
      idxA = m.array('result.A.indices', Uint32Array, 3 * (countA + capFaces)),
      idxB = m.array('result.B.indices', Uint32Array, 3 * (countB + capFaces)),
      provA = m.array('result.A.provenance', Int32Array, countA + capFaces),
      provB = m.array('result.B.provenance', Int32Array, countB + capFaces);
    let wa = 0,
      wb = 0;
    for (let v = 0; v < V + K; v++) {
      m.tick('output_coordinate_construction');
      point(v, p0, true);
      if (read(usedA, v))
        for (let k = 0; k < 3; k++) posA[3 * (read(mapA, v) - 1) + k] = read(p0, k);
      if (read(usedB, v))
        for (let k = 0; k < 3; k++) posB[3 * (read(mapB, v) - 1) + k] = read(p0, k);
    }
    function emit(poly: Uint32Array, n: number, s: number, origin: number): void {
      const idx = s === 0 ? idxA : idxB,
        map = s === 0 ? mapA : mapB,
        prov = s === 0 ? provA : provB;
      for (let k = 1; k < n - 1; k++) {
        m.tick('output_source_face');
        const w = s === 0 ? wa : wb;
        idx[3 * w] = read(map, read(poly, 0)) - 1;
        idx[3 * w + 1] = read(map, read(poly, k)) - 1;
        idx[3 * w + 2] = read(map, read(poly, k + 1)) - 1;
        prov[w] = origin;
        if (s === 0) wa++;
        else wb++;
      }
    }
    let maximumSourceAreaError = 0;
    function polygonArea(poly: Uint32Array, n: number): number {
      let area = 0;
      for (let k = 1; k < n - 1; k++) {
        m.tick('source_cross_conservation');
        point(read(poly, 0), p0, true);
        point(read(poly, k), p1, true);
        point(read(poly, k + 1), p2, true);
        const ux = read(p1, 0) - read(p0, 0),
          uy = read(p1, 1) - read(p0, 1),
          uz = read(p1, 2) - read(p0, 2),
          vx = read(p2, 0) - read(p0, 0),
          vy = read(p2, 1) - read(p0, 1),
          vz = read(p2, 2) - read(p0, 2);
        area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }
      return area;
    }
    for (let f = 0; f < F; f++) {
      m.tick('output_source_pass');
      vertices(f, tri);
      const d = read(dispositions, f);
      if (d === 5) {
        const na = polygon(0, polyA),
          nb = polygon(1, polyB),
          original = polygonArea(tri, 3),
          covered = polygonArea(polyA, na) + polygonArea(polyB, nb);
        point(read(tri, 0), p0, true);
        point(read(tri, 1), p1, true);
        point(read(tri, 2), p2, true);
        const perimeter =
          Math.hypot(
            read(p1, 0) - read(p0, 0),
            read(p1, 1) - read(p0, 1),
            read(p1, 2) - read(p0, 2),
          ) +
          Math.hypot(
            read(p2, 0) - read(p1, 0),
            read(p2, 1) - read(p1, 1),
            read(p2, 2) - read(p1, 2),
          ) +
          Math.hypot(
            read(p0, 0) - read(p2, 0),
            read(p0, 1) - read(p2, 1),
            read(p0, 2) - read(p2, 2),
          );
        maximumSourceAreaError = Math.max(maximumSourceAreaError, Math.abs(covered - original));
        if (Math.abs(covered - original) > 4 * tolerance * perimeter)
          throw new Refusal('SOURCE_SURFACE_CONSERVATION');
        emit(polyA, na, 0, f);
        emit(polyB, nb, 1, f);
      } else emit(tri, 3, d === 1 || d === 3 ? 0 : 1, f);
    }
    let interfaceArea = 0;
    for (let f = 0; f < capFaces; f++) {
      m.tick('output_shared_cap_face');
      const a = read(caps.triangles, f * 3),
        b = read(caps.triangles, f * 3 + 1),
        c = read(caps.triangles, f * 3 + 2);
      const ar =
        area2(
          read(uv, a * 2),
          read(uv, a * 2 + 1),
          read(uv, b * 2),
          read(uv, b * 2 + 1),
          read(uv, c * 2),
          read(uv, c * 2 + 1),
        ) / 2;
      if (!(ar > 0)) throw new Refusal('ZERO_AREA_CAP');
      interfaceArea += ar;
      const A = read(boundaryIds, a),
        Bv = read(boundaryIds, b),
        Cv = read(boundaryIds, c);
      idxA[wa * 3] = read(mapA, A) - 1;
      idxA[wa * 3 + 1] = read(mapA, Cv) - 1;
      idxA[wa * 3 + 2] = read(mapA, Bv) - 1;
      provA[wa++] = -1;
      idxB[wb * 3] = read(mapB, A) - 1;
      idxB[wb * 3 + 1] = read(mapB, Bv) - 1;
      idxB[wb * 3 + 2] = read(mapB, Cv) - 1;
      provB[wb++] = -1;
    }
    if (wa !== countA + capFaces || wb !== countB + capFaces) throw new Refusal('OUTPUT_COUNT');
    const regionPositions = m.array('result.interface.positions', Float32Array, 3 * B),
      regionUV = m.array('result.interface.uv', Float64Array, 2 * B),
      regionLoops = m.array('result.interface.loops', Uint32Array, loops + 1),
      regionTriangles = m.array('result.interface.triangles', Uint32Array, 3 * capFaces),
      regionA = m.array('result.interface.mapA', Uint32Array, B),
      regionB = m.array('result.interface.mapB', Uint32Array, B);
    for (let i = 0; i < B; i++) {
      m.tick('interface_authority');
      point(read(boundaryIds, i), p0, true);
      for (let k = 0; k < 3; k++) regionPositions[i * 3 + k] = read(p0, k);
      regionUV[2 * i] = read(uv, 2 * i);
      regionUV[2 * i + 1] = read(uv, 2 * i + 1);
      regionA[i] = read(mapA, read(boundaryIds, i)) - 1;
      regionB[i] = read(mapB, read(boundaryIds, i)) - 1;
    }
    for (let i = 0; i < loops + 1; i++) {
      m.tick('interface_loop_copy');
      regionLoops[i] = read(loopStarts, i);
    }
    for (let i = 0; i < 3 * capFaces; i++) {
      m.tick('interface_triangle_copy');
      regionTriangles[i] = read(caps.triangles, i);
    }
    const sharedRegion = Object.freeze({
      positions: regionPositions,
      uv: regionUV,
      loops: regionLoops,
      triangles: regionTriangles,
      vertexMapA: regionA,
      vertexMapB: regionB,
    });
    const pieceA = { positions: posA, indices: idxA, metadata: {} },
      pieceB = { positions: posB, indices: idxB, metadata: {} };
    m.releasePrefix('cap.');
    m.releasePrefix('graph.');
    m.releasePrefix('sourceIdentity.');
    m.releasePrefix('scratch.');
    for (const name of [
      'distances',
      'sides',
      'source_face_disposition',
      'intersection.lo',
      'intersection.hi',
      'intersection.vertex',
      'intersection.coordinates',
      'usedA',
      'usedB',
      'output.mapA',
      'output.mapB',
    ])
      m.release(name);
    m.phase('VALIDATE_OUTPUT_A');
    const reportA = validateHash(pieceA, m, 'validateA.');
    m.phase('VALIDATE_OUTPUT_B');
    const reportB = validateHash(pieceB, m, 'validateB.');
    m.phase('FINAL_CONSERVATION');
    if (reportA.signedVolume <= 0 || reportB.signedVolume <= 0)
      throw new Refusal('OUTPUT_ORIENTATION_VOLUME');
    const error =
      Math.abs(reportA.volume + reportB.volume - sourceReport.volume) / sourceReport.volume;
    if (error > POLICY.volumeError) throw new Refusal('VOLUME_CONSERVATION');
    let boundaryArea2 = 0,
      boundaryAbsTerms = 0;
    for (let l = 0; l < loops; l++)
      for (let i = read(regionLoops, l); i < read(regionLoops, l + 1); i++) {
        m.tick('interface_chain_conservation');
        const j = i + 1 < read(regionLoops, l + 1) ? i + 1 : read(regionLoops, l),
          o = read(regionLoops, l),
          term =
            (read(regionUV, 2 * i) - read(regionUV, 2 * o)) *
              (read(regionUV, 2 * j + 1) - read(regionUV, 2 * o + 1)) -
            (read(regionUV, 2 * j) - read(regionUV, 2 * o)) *
              (read(regionUV, 2 * i + 1) - read(regionUV, 2 * o + 1));
        boundaryArea2 += term;
        boundaryAbsTerms += Math.abs(term);
      }
    const areaBound = 128 * Number.EPSILON * (boundaryAbsTerms + 2 * Math.abs(interfaceArea));
    if (Math.abs(boundaryArea2 / 2 - interfaceArea) > areaBound)
      throw new Refusal('CAP_CHAIN_COVERAGE_MISMATCH');
    const placement = options.placement;
    const outputPlacement = Object.freeze(
      composePartTransforms(placement, [1, 0, 0, 0, 1, 0, 0, 0, 1, ...outputAnchor]),
    );
    const interfaceAuthority = Object.freeze({
      frame: sf,
      outputAnchor: Object.freeze(outputAnchor),
      outputPlaneOrigin: Object.freeze(outputPlaneOrigin),
      sharedRegion,
      area: interfaceArea,
      loopCount: loops,
      boundaryVertices: B,
      capFaces,
      footprintDifference: 0,
      orientationA: -1 as const,
      orientationB: 1 as const,
      sourceSHA,
      ...binding,
    });
    return {
      status: 'PASS' as const,
      pieceA,
      pieceB,
      outputPlacement,
      outputAnchor,
      sourcePlacement: placement,
      maximumSourceAreaError,
      sharedCapChainArea: boundaryArea2 / 2,
      sharedCapCoverageError: Math.abs(boundaryArea2 / 2 - interfaceArea),
      rebaseLossless: outputAnchor.some((v): boolean => v !== 0) ? rebaseLossless : true,
      quantizationBounds: {
        absolute: absoluteQuantizationBound,
        rebased: relativeQuantizationBound,
      },
      provenanceA: provA,
      provenanceB: provB,
      provenanceBinding: Object.freeze({ sourceSHA, frameIdentity: sf.identity, ...binding }),
      sourceDispositions: {
        codes: dispositions,
        sourceFaces: F,
        crossed,
        coplanar,
        singleSide: F - crossed - coplanar,
      },
      interface: interfaceAuthority,
      reports: [reportA, reportB],
      sourceVolume: sourceReport.volume,
      volumes: [reportA.volume, reportB.volume],
      volumeError: error,
      tolerance,
      maxCanonicalPlaneResidual: maxResidual,
      maxIntersectionDisplacement: maxDisplacement,
      sourcePreparationReceiptReused: true,
      requestedPlaneMovement: 0,
      redundantFullSourceCopies: 0,
      resource: m.receipt(),
    };
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { status: 'REFUSED' as const, reason: e.message, resource: m.receipt() };
  }
}
