import type { ExactCoordinate, ExactProjectedPoint } from './semantic-exact-owner-preprocessing';
export interface ExactProjectedTriangle {
  readonly vs: readonly ExactProjectedPoint[];
  readonly area: ExactCoordinate;
  readonly loX: ExactCoordinate;
  readonly hiX: ExactCoordinate;
  readonly loY: ExactCoordinate;
  readonly hiY: ExactCoordinate;
  readonly depthRange: {
    readonly minDepth: ExactCoordinate;
    readonly maxDepth: ExactCoordinate;
  };
}
interface Bounds {
  loX: ExactCoordinate;
  hiX: ExactCoordinate;
  loY: ExactCoordinate;
  hiY: ExactCoordinate;
  minZ: ExactCoordinate;
}
type Node = Bounds & { ids?: readonly number[]; left?: Node; right?: Node };
type IntegerPoint = readonly [bigint, bigint, bigint];
interface TargetPredicate {
  readonly triangle: ExactProjectedTriangle;
  readonly points: readonly IntegerPoint[];
  readonly edges: (readonly [bigint, bigint] | undefined)[];
  winding: bigint | undefined;
}
// One retained target (three points, three edge pairs and a winding); replacement
// staging fits the existing point scratch allowance. No per-source records grow.
const TARGET_PREDICATE_BYTES = 2048;
class VisibilityBuildLimit extends Error {}
export const EXACT_VISIBILITY_LIMITS = Object.freeze({
  sourceTriangles: 262144,
  entries: 65536,
  nodes: 65535,
  leafSize: 8,
  buildWork: 16_000_000,
  indexBytes: 32 * 1024 * 1024,
  pointEntries: 4096,
  pointBytes: 4 * 1024 * 1024,
  pointScratchBytes: 2 * 1024 * 1024,
});
/** Conservative spatial candidates and sufficient zero-positive-area overlap facts only. */
export class ExactVisibilityAcceleration {
  private triangles: readonly ExactProjectedTriangle[];
  private faces: readonly number[];
  private tick: () => void;
  private checkpoint: () => void;
  private tree: Node | undefined;
  private points = new Map<ExactProjectedPoint, IntegerPoint>();
  private target: TargetPredicate | undefined;
  private readonly scale = 1n << 149n;
  private building = false;
  private disposed = false;
  private buildWork = 0;
  private queryWork = 0;
  private nodes = 0;
  private entries = 0;
  private indexBytes = 0;
  private peakIndexBytes = 0;
  private sortScratchBytes = 0;
  private pointBytes = 0;
  private peakPointBytes = 0;
  private pointConversions = 0;
  constructor(
    triangles: readonly ExactProjectedTriangle[],
    faces: readonly number[],
    tick: () => void,
    checkpoint: () => void,
  ) {
    this.triangles = triangles;
    this.faces = faces;
    this.tick = tick;
    this.checkpoint = checkpoint;
  }
  private op(): void {
    this.tick();
    if (this.building) {
      if (++this.buildWork > EXACT_VISIBILITY_LIMITS.buildWork) throw new VisibilityBuildLimit();
    } else this.queryWork++;
  }
  private guard(ok: boolean): void {
    this.op();
    if (!ok) throw new VisibilityBuildLimit();
  }
  private mul(a: bigint, b: bigint): bigint {
    this.op();
    return a * b;
  }
  private add(a: bigint, b: bigint): bigint {
    this.op();
    return a + b;
  }
  private sub(a: bigint, b: bigint): bigint {
    this.op();
    return a - b;
  }
  private div(a: bigint, b: bigint): bigint {
    this.op();
    return a / b;
  }
  private less(a: bigint, b: bigint): boolean {
    this.op();
    return a < b;
  }
  private atLeast(a: bigint, b: bigint): boolean {
    this.op();
    return a >= b;
  }
  private atMost(a: bigint, b: bigint): boolean {
    this.op();
    return a <= b;
  }
  private compare(a: ExactCoordinate, b: ExactCoordinate, relation: 'LT' | 'GE' | 'LE'): boolean {
    const value = this.sub(this.mul(a.n, b.d), this.mul(b.n, a.d));
    return relation === 'LT'
      ? this.less(value, 0n)
      : relation === 'GE'
        ? this.atLeast(value, 0n)
        : this.atMost(value, 0n);
  }
  private overlap(a: Bounds | ExactProjectedTriangle, b: Bounds | ExactProjectedTriangle): boolean {
    return (
      !this.compare(a.hiX, b.loX, 'LE') &&
      !this.compare(b.hiX, a.loX, 'LE') &&
      !this.compare(a.hiY, b.loY, 'LE') &&
      !this.compare(b.hiY, a.loY, 'LE')
    );
  }
  private bounds(face: number): Bounds {
    const t = requiredValue(this.triangles[face]);
    return {
      loX: t.loX,
      hiX: t.hiX,
      loY: t.loY,
      hiY: t.hiY,
      minZ: t.depthRange.minDepth,
    };
  }
  private union(a: Bounds | undefined, b: Bounds): Bounds {
    if (!a) return b;
    return {
      loX: this.compare(a.loX, b.loX, 'LT') ? a.loX : b.loX,
      hiX: this.compare(a.hiX, b.hiX, 'GE') ? a.hiX : b.hiX,
      loY: this.compare(a.loY, b.loY, 'LT') ? a.loY : b.loY,
      hiY: this.compare(a.hiY, b.hiY, 'GE') ? a.hiY : b.hiY,
      minZ: this.compare(a.minZ, b.minZ, 'LT') ? a.minZ : b.minZ,
    };
  }
  /** The existing Float32 orthographic projection constructor bounds each scaled coordinate. */
  private integer(q: ExactCoordinate): bigint {
    this.op();
    if (q.d <= 0n) throw new VisibilityBuildLimit();
    this.op();
    const remainder = this.scale % q.d;
    this.op();
    if (remainder !== 0n) throw new VisibilityBuildLimit();
    return this.mul(q.n, this.div(this.scale, q.d));
  }
  private reserveIndex(bytes: number): void {
    this.guard(this.indexBytes + bytes <= EXACT_VISIBILITY_LIMITS.indexBytes);
    this.indexBytes += bytes;
    this.peakIndexBytes = Math.max(this.peakIndexBytes, this.indexBytes);
  }
  private sort(
    ids: readonly number[],
    axis: number,
    centers: ReadonlyMap<number, readonly bigint[]>,
  ): number[] {
    let a = ids.slice(),
      b = new Array<number>(a.length);
    for (let step = 1; step < a.length; step *= 2) {
      this.op();
      for (let lo = 0; lo < a.length; lo += 2 * step) {
        let i = lo,
          j = Math.min(lo + step, a.length),
          k = lo;
        const end = j,
          rightEnd = Math.min(lo + 2 * step, a.length);
        while (i < end || j < rightEnd) {
          this.op();
          let left = j >= rightEnd;
          if (!left && i < end) {
            const x = requiredValue(requiredValue(centers.get(requiredValue(a[i])))[axis]),
              y = requiredValue(requiredValue(centers.get(requiredValue(a[j])))[axis]);
            left = this.less(x, y);
            if (!left) {
              this.op();
              if (x === y) {
                this.op();
                left = requiredValue(a[i]) < requiredValue(a[j]);
              }
            }
          }
          b[k++] = left ? requiredValue(a[i++]) : requiredValue(a[j++]);
        }
      }
      [a, b] = [b, a];
    }
    return a;
  }
  private buildTree(): Node | undefined {
    this.guard(this.triangles.length <= EXACT_VISIBILITY_LIMITS.sourceTriangles);
    let root: Bounds | undefined;
    for (const face of this.faces) {
      this.op();
      root = this.union(root, this.bounds(face));
    }
    if (!root) return undefined;
    const ids: number[] = [],
      centers = new Map<number, readonly bigint[]>();
    for (let face = 0; face < this.triangles.length; face++) {
      this.op();
      this.op();
      const t = requiredValue(this.triangles[face]);
      if (!t.area.n) continue;
      if (!this.overlap(t, root)) continue;
      this.guard(ids.length < EXACT_VISIBILITY_LIMITS.entries);
      ids.push(face);
      centers.set(face, [
        this.add(this.integer(t.loX), this.integer(t.hiX)),
        this.add(this.integer(t.loY), this.integer(t.hiY)),
      ]);
    }
    this.entries = ids.length;
    // Includes center records, ordering arrays and bounded recursion partition scratch.
    this.sortScratchBytes = ids.length * 64 + 1024 * 1024;
    this.reserveIndex(ids.length * 384 + 1024 * 1024);
    if (!ids.length) return undefined;
    const xs = this.sort(ids, 0, centers),
      ys = this.sort(ids, 1, centers);
    const recurse = (x: readonly number[], y: readonly number[]): Node => {
      this.checkpoint();
      this.guard(this.nodes < EXACT_VISIBILITY_LIMITS.nodes);
      this.reserveIndex(256);
      this.nodes++;
      if (x.length <= EXACT_VISIBILITY_LIMITS.leafSize) {
        let box: Bounds | undefined;
        for (const face of x) {
          this.op();
          box = this.union(box, this.bounds(face));
        }
        return { ...requiredValue(box), ids: x };
      }
      const sx = this.sub(
          requiredValue(requiredValue(centers.get(requiredValue(x.at(-1))))[0]),
          requiredValue(requiredValue(centers.get(requiredValue(x[0])))[0]),
        ),
        sy = this.sub(
          requiredValue(requiredValue(centers.get(requiredValue(y.at(-1))))[1]),
          requiredValue(requiredValue(centers.get(requiredValue(y[0])))[1]),
        ),
        axis = this.atLeast(sx, sy) ? 0 : 1;
      this.op();
      const main = axis === 0 ? x : y,
        other = axis === 0 ? y : x,
        middle = main.length >> 1,
        leftOrder = main.slice(0, middle),
        rightOrder = main.slice(middle),
        members = new Set<number>();
      for (const face of leftOrder) {
        this.op();
        members.add(face);
      }
      const alternateLeft: number[] = [],
        alternateRight: number[] = [];
      for (const face of other) {
        this.op();
        (members.has(face) ? alternateLeft : alternateRight).push(face);
      }
      const left =
          axis === 0 ? recurse(leftOrder, alternateLeft) : recurse(alternateLeft, leftOrder),
        right =
          axis === 0 ? recurse(rightOrder, alternateRight) : recurse(alternateRight, rightOrder);
      return { ...this.union(left, right), left, right };
    };
    return recurse(xs, ys);
  }
  build(): void {
    this.checkpoint();
    if (this.disposed) return;
    this.building = true;
    try {
      this.op();
      this.tree = this.buildTree();
    } catch (error) {
      if (!(error instanceof VisibilityBuildLimit)) throw error;
      this.tree = undefined;
      this.entries = 0;
      this.nodes = 0;
      this.indexBytes = 0;
      this.sortScratchBytes = 0;
      this.checkpoint();
    } finally {
      this.building = false;
      this.checkpoint();
    }
  }
  needsGrid(): boolean {
    return !this.tree;
  }
  candidates(
    triangle: ExactProjectedTriangle,
    face: number,
    oldGrid: () => Set<number>,
  ): Set<number> {
    this.checkpoint();
    if (!this.tree || this.disposed) {
      this.checkpoint();
      return oldGrid();
    }
    const result = new Set<number>(),
      stack = [this.tree];
    while (stack.length) {
      this.op();
      const node = requiredValue(stack.pop());
      if (!this.overlap(node, triangle)) continue;
      if (this.compare(node.minZ, triangle.depthRange.maxDepth, 'GE')) continue;
      if (node.left) {
        stack.push(requiredValue(node.right), node.left);
      } else
        for (const source of requiredValue(node.ids)) {
          this.op();
          this.op();
          if (source !== face) result.add(source);
        }
    }
    this.checkpoint();
    return result;
  }
  private point(p: ExactProjectedPoint): IntegerPoint {
    const cached = this.points.get(p);
    this.op();
    if (cached) return cached;
    const value: IntegerPoint = [this.integer(p.x), this.integer(p.y), this.integer(p.z)];
    this.pointConversions++;
    this.op();
    if (this.points.size < EXACT_VISIBILITY_LIMITS.pointEntries) {
      this.guard(
        this.pointBytes +
          448 +
          (this.target ? TARGET_PREDICATE_BYTES : 0) +
          EXACT_VISIBILITY_LIMITS.pointScratchBytes <=
          EXACT_VISIBILITY_LIMITS.pointBytes,
      );
      this.pointBytes += 448;
      this.peakPointBytes = Math.max(this.peakPointBytes, this.pointBytes);
      this.points.set(p, value);
    }
    return value;
  }
  private side(a: IntegerPoint, b: IntegerPoint, p: IntegerPoint): bigint {
    return this.sub(
      this.mul(this.sub(b[0], a[0]), this.sub(p[1], a[1])),
      this.mul(this.sub(b[1], a[1]), this.sub(p[0], a[0])),
    );
  }
  separated(triangle: ExactProjectedTriangle, source: ExactProjectedTriangle): boolean {
    this.checkpoint();
    if (this.disposed) return false;
    try {
      // The certificate constructs immutable projected triangles once per view.
      // Its inner candidate loop repeats this target. Identity changes replace
      // the entire record; exceptions cannot publish partially converted points.
      this.op();
      let target = this.target;
      if (target?.triangle !== triangle) {
        const points = triangle.vs.map((p) => this.point(p));
        this.guard(
          this.pointBytes + TARGET_PREDICATE_BYTES + EXACT_VISIBILITY_LIMITS.pointScratchBytes <=
            EXACT_VISIBILITY_LIMITS.pointBytes,
        );
        this.op();
        target = {
          triangle,
          points,
          edges: new Array<readonly [bigint, bigint] | undefined>(3),
          winding: undefined,
        };
        this.target = target;
      }
      const a = target.points,
        b = source.vs.map((p) => this.point(p));
      for (const [polygon, opposite] of [
        [a, b],
        [b, a],
      ]) {
        const isTarget = polygon === a;
        let winding: bigint;
        if (isTarget) {
          this.op();
          if (target.winding === undefined) {
            const value = this.side(
              requiredValue(requiredValue(polygon)[0]),
              requiredValue(requiredValue(polygon)[1]),
              requiredValue(requiredValue(polygon)[2]),
            );
            this.op();
            target.winding = value;
          }
          winding = target.winding;
        } else {
          winding = this.side(
            requiredValue(requiredValue(polygon)[0]),
            requiredValue(requiredValue(polygon)[1]),
            requiredValue(requiredValue(polygon)[2]),
          );
        }
        this.op();
        if (!winding) return false;
        for (let i = 0; i < 3; i++) {
          this.op();
          let edge: readonly [bigint, bigint] | undefined;
          if (isTarget) {
            this.op();
            edge = target.edges[i];
            if (!edge) {
              const start = requiredValue(requiredValue(polygon)[i]),
                end = requiredValue(requiredValue(polygon)[(i + 1) % 3]);
              edge = [this.sub(end[0], start[0]), this.sub(end[1], start[1])];
              this.op();
              target.edges[i] = edge;
            }
          }
          let exterior = true;
          for (const point of requiredValue(opposite)) {
            this.op();
            const start = requiredValue(requiredValue(polygon)[i]);
            const side = edge
              ? this.sub(
                  this.mul(edge[0], this.sub(point[1], start[1])),
                  this.mul(edge[1], this.sub(point[0], start[0])),
                )
              : this.side(start, requiredValue(requiredValue(polygon)[(i + 1) % 3]), point);
            this.op();
            if (winding > 0n ? !this.atMost(side, 0n) : !this.atLeast(side, 0n)) {
              exterior = false;
              break;
            }
          }
          if (exterior) return true;
        }
      }
      return false;
    } catch (error) {
      if (!(error instanceof VisibilityBuildLimit)) throw error;
      this.checkpoint();
      return false;
    } finally {
      this.checkpoint();
    }
  }
  snapshot(): {
    nodes: number;
    entries: number;
    indexBytes: number;
    peakIndexBytes: number;
    sortScratchBytes: number;
    retainedTreeBytes: number;
    pointRecords: number;
    cachedTargetBytes: number;
    pointBytes: number;
    peakPointBytes: number;
    pointScratchBytes: number;
    pointConversions: number;
    buildWork: number;
    queryWork: number;
    sourceReferences: number;
    interfaceReferences: number;
    disposed: boolean;
  } {
    return {
      nodes: this.nodes,
      entries: this.entries,
      indexBytes: this.indexBytes,
      peakIndexBytes: this.peakIndexBytes,
      sortScratchBytes: this.sortScratchBytes,
      retainedTreeBytes: this.tree ? this.nodes * 256 : 0,
      pointRecords: this.points.size,
      cachedTargetBytes: this.target ? TARGET_PREDICATE_BYTES : 0,
      pointBytes: this.pointBytes,
      peakPointBytes: this.peakPointBytes,
      pointScratchBytes: EXACT_VISIBILITY_LIMITS.pointScratchBytes,
      pointConversions: this.pointConversions,
      buildWork: this.buildWork,
      queryWork: this.queryWork,
      sourceReferences: this.triangles.length,
      interfaceReferences: this.faces.length,
      disposed: this.disposed,
    };
  }
  dispose(): void {
    this.tree = undefined;
    this.points.clear();
    this.target = undefined;
    this.triangles = [];
    this.faces = [];
    this.nodes = 0;
    this.entries = 0;
    this.indexBytes = 0;
    this.sortScratchBytes = 0;
    this.pointBytes = 0;
    this.tick = (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    };
    this.checkpoint = (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    };
    this.disposed = true;
  }
}

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
