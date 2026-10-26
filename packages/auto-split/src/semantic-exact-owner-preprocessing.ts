/** Exact sufficient containment shortcut. The caller has already proved polygon simplicity. */
export interface ExactCoordinate {
  readonly n: bigint;
  readonly d: bigint;
}
export interface ExactProjectedPoint {
  readonly x: ExactCoordinate;
  readonly y: ExactCoordinate;
  readonly z: ExactCoordinate;
}
export type ExactOwnerPolygon = readonly ExactProjectedPoint[];
type IntegerPoint = readonly [bigint, bigint, bigint];
interface OwnerRecord {
  readonly lines: readonly IntegerPoint[];
  readonly winding: number;
}
class OwnerBuildLimit extends Error {}
export const EXACT_OWNER_LIMITS = Object.freeze({
  polygonVertices: 256,
  edges: 2048,
  buildWork: 2_000_000,
  retainedBytes: 4 * 1024 * 1024,
  scratchBytes: 2 * 1024 * 1024,
  integrationBytes: 8 * 1024 * 1024,
});
export class ExactOwnerPreprocessing {
  private records = new Map<ExactOwnerPolygon, OwnerRecord>();
  private retainedEdges = 0;
  private retainedBytes = 0;
  private peakBytes = 0;
  private scratchBytes = 0;
  private peakScratchBytes = 0;
  private buildWork = 0;
  private queryWork = 0;
  private building = false;
  private disposed = false;
  private tick: () => void;
  private checkpoint: () => void;
  constructor(tick: () => void, checkpoint: () => void) {
    this.tick = tick;
    this.checkpoint = checkpoint;
  }
  private op(): void {
    this.tick();
    if (this.building) {
      if (++this.buildWork > EXACT_OWNER_LIMITS.buildWork) throw new OwnerBuildLimit();
    } else this.queryWork++;
  }
  private guard(ok: boolean): void {
    this.op();
    if (!ok) throw new OwnerBuildLimit();
  }
  private mul(a: bigint, b: bigint): bigint {
    this.op();
    return a * b;
  }
  private sub(a: bigint, b: bigint): bigint {
    this.op();
    return a - b;
  }
  private add(a: bigint, b: bigint): bigint {
    this.op();
    return a + b;
  }
  private homogeneous(p: ExactProjectedPoint): IntegerPoint {
    this.op();
    this.op();
    if (p.x.d <= 0n || p.y.d <= 0n) throw new OwnerBuildLimit();
    return [this.mul(p.x.n, p.y.d), this.mul(p.y.n, p.x.d), this.mul(p.x.d, p.y.d)];
  }
  private line(a: IntegerPoint, b: IntegerPoint): IntegerPoint {
    return [
      this.sub(this.mul(a[1], b[2]), this.mul(a[2], b[1])),
      this.sub(this.mul(a[2], b[0]), this.mul(a[0], b[2])),
      this.sub(this.mul(a[0], b[1]), this.mul(a[1], b[0])),
    ];
  }
  private evaluate(l: IntegerPoint, p: IntegerPoint): bigint {
    return this.add(this.add(this.mul(l[0], p[0]), this.mul(l[1], p[1])), this.mul(l[2], p[2]));
  }
  private sign(v: bigint): number {
    this.op();
    if (v < 0n) return -1;
    this.op();
    return v > 0n ? 1 : 0;
  }
  private sameSide(v: bigint, winding: number): boolean {
    this.op();
    return winding > 0 ? v >= 0n : v <= 0n;
  }
  private bigintBytes(v: bigint): number {
    this.checkpoint();
    const length = (v < 0n ? -v : v).toString(16).length;
    for (let i = 0; i < Math.ceil(length / 8); i++) this.op();
    return 64 + Math.ceil(length / 2);
  }
  build(polygons: readonly ExactOwnerPolygon[]): void {
    this.checkpoint();
    if (this.disposed) return;
    this.building = true;
    try {
      for (const polygon of polygons) {
        this.checkpoint();
        this.op();
        this.op();
        if (polygon.length < 3 || polygon.length > EXACT_OWNER_LIMITS.polygonVertices) continue;
        this.guard(this.retainedEdges + polygon.length <= EXACT_OWNER_LIMITS.edges);
        this.scratchBytes = polygon.length * 6144 + 65536;
        this.guard(this.scratchBytes <= EXACT_OWNER_LIMITS.scratchBytes);
        this.peakScratchBytes = Math.max(this.peakScratchBytes, this.scratchBytes);
        const points = polygon.map((p) => {
          this.op();
          return this.homogeneous(p);
        });
        const lines = points.map((p, i) => {
          this.op();
          return this.line(p, requiredValue(points[(i + 1) % points.length]));
        });
        let winding = 0;
        for (let i = 0; i < lines.length && !winding; i++) {
          this.op();
          winding = this.sign(
            this.evaluate(requiredValue(lines[i]), requiredValue(points[(i + 2) % points.length])),
          );
        }
        if (!winding) continue;
        let convex = true;
        outer: for (const line of lines)
          for (const point of points) {
            this.op();
            if (!this.sameSide(this.evaluate(line, point), winding)) {
              convex = false;
              break outer;
            }
          }
        if (!convex) continue;
        let bytes = 128 + lines.length * 48;
        for (const line of lines)
          for (const coordinate of line) bytes += this.bigintBytes(coordinate);
        this.guard(this.retainedBytes + bytes <= EXACT_OWNER_LIMITS.retainedBytes);
        this.retainedBytes += bytes;
        this.peakBytes = Math.max(this.peakBytes, this.retainedBytes);
        this.records.set(polygon, { lines, winding });
        this.retainedEdges += polygon.length;
      }
    } catch (error) {
      if (!(error instanceof OwnerBuildLimit)) throw error;
      this.checkpoint();
    } finally {
      this.building = false;
      this.scratchBytes = 0;
      this.checkpoint();
    }
  }
  /** true is sufficient; undefined always requests the original exact contained predicate. */
  contains(triangle: readonly ExactProjectedPoint[], polygon: ExactOwnerPolygon): true | undefined {
    if (this.disposed) return undefined;
    const record = this.records.get(polygon);
    if (!record) {
      this.checkpoint();
      return undefined;
    }
    this.checkpoint();
    this.op();
    if (triangle.length !== 3) return undefined;
    try {
      for (const point of triangle) {
        this.op();
        const homogeneous = this.homogeneous(point);
        for (const line of record.lines) {
          this.op();
          if (!this.sameSide(this.evaluate(line, homogeneous), record.winding)) return undefined;
        }
      }
      return true;
    } catch (error) {
      if (!(error instanceof OwnerBuildLimit)) throw error;
      this.checkpoint();
      return undefined;
    } finally {
      this.checkpoint();
    }
  }
  snapshot(): {
    records: number;
    retainedEdges: number;
    retainedBytes: number;
    peakBytes: number;
    buildWork: number;
    queryWork: number;
    scratchBound: number;
    scratchBytes: number;
    peakScratchBytes: number;
    disposed: boolean;
  } {
    return {
      records: this.records.size,
      retainedEdges: this.retainedEdges,
      retainedBytes: this.retainedBytes,
      peakBytes: this.peakBytes,
      buildWork: this.buildWork,
      queryWork: this.queryWork,
      scratchBound: EXACT_OWNER_LIMITS.scratchBytes,
      scratchBytes: this.scratchBytes,
      peakScratchBytes: this.peakScratchBytes,
      disposed: this.disposed,
    };
  }
  dispose(): void {
    this.records.clear();
    this.retainedEdges = 0;
    this.retainedBytes = 0;
    this.scratchBytes = 0;
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
