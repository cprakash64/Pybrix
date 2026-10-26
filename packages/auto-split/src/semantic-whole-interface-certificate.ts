import { ExactOwnerPreprocessing } from './semantic-exact-owner-preprocessing';
import { ExactVisibilityAcceleration } from './semantic-exact-visibility-acceleration';
import {
  cameraFor,
  FRAME_FILL,
  VIEW_NAMES,
  type SemanticPart,
} from '@cadfixer/auto-split-contract';
import { SEMANTIC_WORK_LIMITS, type PreparedSemanticGeometry } from './semantic';
import { resourceLimitExceeded } from '@cadfixer/shared';
import type { Checkpoint } from './checkpoint';
import type { MaterialInterface } from './semantic-interface-membership';
import { InvocationExactGcdCache } from './semantic-exact-gcd-cache';
import { exactTriangleDepthRange, exactRangeNonCloser } from './semantic-exact-depth-range';
import {
  exactOwnerOrientationSign,
  type OwnerOrientationSign,
} from './semantic-owner-orientation-sign';

export interface WholeInterfaceCertificate {
  readonly complete: boolean;
  readonly conflict?: boolean;
  readonly reason: string;
  readonly certifiedFaces: number;
  readonly trianglesProcessed: number;
  readonly viewsChecked: number;
  readonly projectionOperations: number;
  readonly visibilityOperations: number;
  readonly workUnits: number;
  readonly scratchBytes: number;
  readonly rangeChecks?: number;
  readonly rangeRejects?: number;
  readonly rangePassThrough?: number;
  readonly rangeCheckWork?: number;
  readonly depthRangePreparationWork?: number;
  readonly depthBoundStorageBytes?: number;
  readonly avoidedClipEntries?: number;
  readonly clipEntries?: number;
}
interface Q {
  n: bigint;
  d: bigint;
}
interface P {
  x: Q;
  y: Q;
  z: Q;
}
/** A sufficient continuous certificate, symmetric in the supplied positive owner regions.
 * All predicates use exact rational arithmetic over the recorded binary source/calibration
 * values. No raster ownership or approximate depth equality is a visibility certificate.
 * The spatial grid is only a conservative broad phase; every positive-area overlap is clipped.
 * Unsupported/ambiguous input never supplies whole proof. Cancellation/budget exceptions propagate.
 */
export function certifyWholeInterface(
  prepared: PreparedSemanticGeometry,
  region: MaterialInterface,
  owners: readonly SemanticPart[],
  checkpoint: Checkpoint,
  charge: () => void,
  opponents: readonly SemanticPart[] = [],
): WholeInterfaceCertificate {
  let workUnits = 0,
    projectionOperations = 0,
    visibilityOperations = 0,
    viewsChecked = 0;
  let scratchBytes = 0,
    trianglesProcessed = 0;
  let rangeChecks = 0,
    rangeRejects = 0,
    rangePassThrough = 0,
    rangeCheckWork = 0,
    depthRangePreparationWork = 0,
    depthBoundStorageBytes = 0,
    clipEntries = 0;
  const tick = (): void => {
    charge();
    if (++workUnits > SEMANTIC_WORK_LIMITS.regionPixels)
      throw resourceLimitExceeded(
        'The whole-interface certificate exceeds the supported work limit.',
      );
    if (((workUnits - 1) & 255) === 0) checkpoint();
  };
  const gcdCache = new InvocationExactGcdCache(checkpoint);
  const gcd = (a: bigint, b: bigint): bigint => {
    const cached = gcdCache.get(a, b);
    if (cached !== undefined) return cached;
    const inputA = a,
      inputB = b,
      start = workUnits;
    a = a < 0n ? -a : a;
    while (b) {
      tick();
      [a, b] = [b, a % b];
    }
    gcdCache.store(inputA, inputB, a, workUnits - start);
    return a;
  };
  const q = (n: bigint, d = 1n): Q => {
    tick();
    if (!d) throw Error('Uncertified zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    if (!n) return { n: 0n, d: 1n };
    const v = (d & (d - 1n)) === 0n ? ((n & -n) < d ? n & -n : d) : gcd(n, d);
    return { n: n / v, d: d / v };
  };
  const zero = q(0n),
    one = q(1n),
    half = q(1n, 2n);
  const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
  const neg = (a: Q): Q => ({ n: -a.n, d: a.d });
  const sub = (a: Q, b: Q): Q => add(a, neg(b));
  const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
  const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
  const cmp = (a: Q, b: Q): number => {
    tick();
    const x = a.n * b.d - b.n * a.d;
    return x > 0n ? 1 : x < 0n ? -1 : 0;
  };
  const compareDepthPreparation = (a: Q, b: Q): number => {
    depthRangePreparationWork++;
    return cmp(a, b);
  };
  const compareDepthRange = (a: Q, b: Q): number => {
    rangeCheckWork++;
    return cmp(a, b);
  };
  const bits = new DataView(new ArrayBuffer(8));
  const numbers = new Map<number, Q>();
  const from = (x: number): Q => {
    const cached = numbers.get(x);
    if (cached) return cached;
    bits.setFloat64(0, x);
    const v = bits.getBigUint64(0),
      exponent = Number((v >> 52n) & 2047n),
      mantissa = (v & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n),
      shift = (exponent || 1) - 1075,
      n = (v >> 63n ? -1n : 1n) * mantissa;
    const value = shift >= 0 ? q(n << BigInt(shift)) : q(n, 1n << BigInt(-shift));
    numbers.set(x, value);
    return value;
  };
  const cross = (a: P, b: P, c: P): Q =>
    sub(mul(sub(b.x, a.x), sub(c.y, a.y)), mul(sub(b.y, a.y), sub(c.x, a.x)));
  const mix = (a: P, b: P, t: Q): P => ({
    x: add(a.x, mul(t, sub(b.x, a.x))),
    y: add(a.y, mul(t, sub(b.y, a.y))),
    z: zero,
  });
  const within = (x: Q, a: Q, b: Q): boolean => cmp(x, a) * cmp(x, b) <= 0;
  const onSegment = (a: P, b: P, p: P): boolean =>
    cross(a, b, p).n === 0n && within(p.x, a.x, b.x) && within(p.y, a.y, b.y);
  const segmentsMeet = (a: P, b: P, c: P, d: P): boolean => {
    const ac = cmp(cross(a, b, c), zero),
      ad = cmp(cross(a, b, d), zero),
      ca = cmp(cross(c, d, a), zero),
      cb = cmp(cross(c, d, b), zero);
    return (
      (ac * ad < 0 && ca * cb < 0) ||
      (ac === 0 && onSegment(a, b, c)) ||
      (ad === 0 && onSegment(a, b, d)) ||
      (ca === 0 && onSegment(c, d, a)) ||
      (cb === 0 && onSegment(c, d, b))
    );
  };
  const simple = (poly: P[]): boolean => {
    for (let i = 0; i < poly.length; i++) {
      tick();
      if (
        cmp(requiredValue(poly[i]).x, requiredValue(poly[(i + 1) % poly.length]).x) === 0 &&
        cmp(requiredValue(poly[i]).y, requiredValue(poly[(i + 1) % poly.length]).y) === 0
      )
        return false;
      for (let j = i + 1; j < poly.length; j++) {
        if (j === i + 1 || (i === 0 && j === poly.length - 1)) continue;
        if (
          segmentsMeet(
            requiredValue(poly[i]),
            requiredValue(poly[(i + 1) % poly.length]),
            requiredValue(poly[j]),
            requiredValue(poly[(j + 1) % poly.length]),
          )
        )
          return false;
      }
    }
    return poly.length >= 3;
  };
  const ownerOrientationSign = (a: P, b: P, c: P): OwnerOrientationSign =>
    exactOwnerOrientationSign(
      a,
      b,
      c,
      tick,
      () => cmp(cross(a, b, c), zero) as OwnerOrientationSign,
    );
  const ownerOnSegment = (a: P, b: P, p: P): boolean =>
    ownerOrientationSign(a, b, p) === 0 && within(p.x, a.x, b.x) && within(p.y, a.y, b.y);
  const inside = (p: P, poly: P[]): boolean => {
    let yes = false;
    for (let i = 0; i < poly.length; i++) {
      tick();
      const a = requiredValue(poly[i]),
        b = requiredValue(poly[(i + 1) % poly.length]);
      if (ownerOnSegment(a, b, p)) return true;
      if (
        cmp(a.y, p.y) > 0 !== cmp(b.y, p.y) > 0 &&
        ownerOrientationSign(a, b, p) === cmp(b.y, a.y)
      )
        yes = !yes;
    }
    return yes;
  };
  const contained = (tri: P[], poly: P[]): boolean => {
    if (!tri.every((p) => inside(p, poly))) return false;
    const sign = ownerOrientationSign(
      requiredValue(tri[0]),
      requiredValue(tri[1]),
      requiredValue(tri[2]),
    );
    for (let i = 0; i < poly.length; i++) {
      let lo = zero,
        hi = one,
        empty = false;
      const p = requiredValue(poly[i]),
        r = requiredValue(poly[(i + 1) % poly.length]);
      for (let j = 0; j < 3; j++) {
        tick();
        let u = cross(requiredValue(tri[j]), requiredValue(tri[(j + 1) % 3]), p),
          v = cross(requiredValue(tri[j]), requiredValue(tri[(j + 1) % 3]), r);
        if (sign < 0) {
          u = neg(u);
          v = neg(v);
        }
        const delta = sub(v, u);
        if (delta.n === 0n) {
          if (u.n < 0n) {
            empty = true;
            break;
          }
        } else {
          const bound = div(neg(u), delta);
          if (delta.n > 0n) {
            if (cmp(bound, lo) > 0) lo = bound;
          } else if (cmp(bound, hi) < 0) hi = bound;
        }
      }
      if (!empty && cmp(hi, lo) > 0) {
        const m = mix(p, r, mul(add(lo, hi), half));
        if (
          tri.every((a, j) => ownerOrientationSign(a, requiredValue(tri[(j + 1) % 3]), m) === sign)
        )
          return false;
      }
    }
    return true;
  };
  const clip = (input: P[], tri: P[]): P[] => {
    clipEntries++;
    const sign = cmp(
      cross(requiredValue(tri[0]), requiredValue(tri[1]), requiredValue(tri[2])),
      zero,
    );
    let out = input;
    for (let i = 0; i < 3 && out.length; i++) {
      const previous = out;
      out = [];
      for (let j = 0; j < previous.length; j++) {
        tick();
        const p = requiredValue(previous[j]),
          r = requiredValue(previous[(j + 1) % previous.length]);
        let u = cross(requiredValue(tri[i]), requiredValue(tri[(i + 1) % 3]), p),
          v = cross(requiredValue(tri[i]), requiredValue(tri[(i + 1) % 3]), r);
        if (sign < 0) {
          u = neg(u);
          v = neg(v);
        }
        if (u.n >= 0n) out.push(p);
        if (u.n * v.n < 0n) out.push(mix(p, r, div(u, sub(u, v))));
      }
    }
    return out;
  };
  const depth = (p: P, tri: P[]): Q => {
    const a = requiredValue(tri[0]),
      b = requiredValue(tri[1]),
      c = requiredValue(tri[2]),
      area = cross(a, b, c),
      u = div(cross(p, b, c), area),
      v = div(cross(a, p, c), area);
    return add(add(mul(u, a.z), mul(v, b.z)), mul(sub(sub(one, u), v), c.z));
  };
  const result = (
    complete: boolean,
    reason: string,
    certifiedFaces = 0,
  ): WholeInterfaceCertificate => ({
    complete,
    reason,
    certifiedFaces,
    trianglesProcessed,
    viewsChecked,
    projectionOperations,
    visibilityOperations,
    workUnits,
    scratchBytes: scratchBytes + gcdCache.estimatedPeakBytes + depthBoundStorageBytes,
    rangeChecks,
    rangeRejects,
    rangePassThrough,
    rangeCheckWork,
    depthRangePreparationWork,
    depthBoundStorageBytes,
    avoidedClipEntries: rangeRejects,
    clipEntries,
  });
  const g = prepared.geometry;
  if (!region.faces.length || region.faces.length > 8192)
    return result(false, 'INTERFACE_FACE_CAP_OR_EMPTY');
  if (
    !Number.isFinite(g.radius) ||
    g.radius < 1e-9 ||
    !g.positions.every((x) => {
      tick();
      return Number.isFinite(x);
    }) ||
    g.indices.length !== g.faceCount * 3 ||
    !g.indices.every((i) => {
      tick();
      return i < g.positions.length / 3;
    }) ||
    !region.faces.every((f) => Number.isInteger(f) && f >= 0 && f < g.faceCount)
  )
    return result(false, 'NUMERICAL_OR_SOURCE_UNCERTAINTY');
  const k = from(FRAME_FILL / (2 * g.radius)),
    proved = new Set<number>();
  const bin = (x: Q): number => {
    tick();
    const image = add(half, mul(x, k));
    const n = image.n * 32n;
    const f = n >= 0n ? n / image.d : -((-n + image.d - 1n) / image.d);
    return f < 0n ? 0 : f > 31n ? 31 : Number(f);
  };
  for (const view of VIEW_NAMES) {
    checkpoint();
    const positive = owners.flatMap((o) =>
      o.views.filter((v) => v.view === view).flatMap((v) => v.polygons),
    );
    if (!positive.length) continue;
    viewsChecked++;
    if (positive.some((poly) => poly.some((p) => p.some((x) => !Number.isFinite(x)))))
      return result(false, 'NUMERICAL_REGION_UNCERTAINTY', proved.size);
    const polygons = positive
      .map((poly) =>
        poly.map(([x, y]) => ({
          x: div(sub(from(x), half), k),
          y: div(sub(from(y), half), k),
          z: zero,
        })),
      )
      .filter(simple);
    if (!polygons.length) continue;
    const oppositeRegions = opponents.flatMap((o) =>
      o.views.filter((v) => v.view === view).flatMap((v) => v.polygons),
    );
    if (oppositeRegions.some((poly) => poly.some((p) => p.some((x) => !Number.isFinite(x)))))
      return result(false, 'NUMERICAL_OPPOSITE_REGION_UNCERTAINTY', proved.size);
    const opposite = oppositeRegions.map((poly) =>
      poly.map(([x, y]) => ({
        x: div(sub(from(x), half), k),
        y: div(sub(from(y), half), k),
        z: zero,
      })),
    );
    if (!opposite.every(simple))
      return result(false, 'UNSUPPORTED_OPPOSITE_REGION_UNCERTAINTY', proved.size);

    const camera = cameraFor(view),
      dot = (point: number[], direction: readonly number[]): Q => {
        const axis = direction.findIndex((x) => x !== 0);
        const value = from(requiredValue(point[axis]));
        return direction[axis] === -1 ? neg(value) : value;
      };
    const triangles = Array.from({ length: g.faceCount }, (_, face) => {
      tick();
      projectionOperations++;
      const vs = [0, 1, 2].map((corner) => {
        const index = (g.indices[face * 3 + corner] ?? -1) * 3;
        const point = [
          requiredValue(g.positions[index]),
          requiredValue(g.positions[index + 1]),
          requiredValue(g.positions[index + 2]),
        ];
        return {
          x: dot(point, camera.right),
          y: neg(dot(point, camera.up)),
          z: dot(point, camera.forward),
        };
      });
      const xs = vs.map((p) => p.x).sort(cmp),
        ys = vs.map((p) => p.y).sort(cmp);
      return {
        vs,
        depthRange: exactTriangleDepthRange(vs, compareDepthPreparation),
        area: cross(requiredValue(vs[0]), requiredValue(vs[1]), requiredValue(vs[2])),
        loX: requiredValue(xs[0]),
        hiX: requiredValue(xs[2]),
        loY: requiredValue(ys[0]),
        hiY: requiredValue(ys[2]),
      };
    });
    depthBoundStorageBytes = Math.max(depthBoundStorageBytes, triangles.length * 64);
    const owner = new ExactOwnerPreprocessing(tick, checkpoint);
    const visibility = new ExactVisibilityAcceleration(triangles, region.faces, tick, checkpoint);
    try {
      owner.build(polygons);
      visibility.build();
      const grid = new Map<number, number[]>();
      let entries = 0;
      if (visibility.needsGrid())
        for (const [t, tri] of triangles.entries()) {
          if (tri.area.n === 0n) continue;
          for (let x = bin(tri.loX); x <= bin(tri.hiX); x++)
            for (let y = bin(tri.loY); y <= bin(tri.hiY); y++) {
              tick();
              const key = x * 32 + y,
                bucket = grid.get(key);
              if (bucket) bucket.push(t);
              else grid.set(key, [t]);
              entries++;
            }
        }
      scratchBytes = Math.max(scratchBytes, entries * 8 + triangles.length * 3 * 3 * 64);
      for (const face of region.faces) {
        if (proved.has(face)) continue;
        trianglesProcessed++;
        const tri = requiredValue(triangles[face]);
        if (
          tri.area.n === 0n ||
          !polygons.some((poly) => owner.contains(tri.vs, poly) === true || contained(tri.vs, poly))
        )
          continue;
        const others = visibility.candidates(tri, face, () => {
          const others = new Set<number>();
          for (let x = bin(tri.loX); x <= bin(tri.hiX); x++)
            for (let y = bin(tri.loY); y <= bin(tri.hiY); y++)
              for (const f of grid.get(x * 32 + y) ?? []) {
                tick();
                if (f !== face) others.add(f);
              }
          return others;
        });
        let visible = true;
        for (const f of others) {
          tick();
          visibilityOperations++;
          const other = requiredValue(triangles[f]);
          if (
            cmp(other.hiX, tri.loX) <= 0 ||
            cmp(other.loX, tri.hiX) >= 0 ||
            cmp(other.hiY, tri.loY) <= 0 ||
            cmp(other.loY, tri.hiY) >= 0
          )
            continue;
          rangeChecks++;
          if (exactRangeNonCloser(other.depthRange, tri.depthRange, compareDepthRange)) {
            rangeRejects++;
            continue;
          }
          rangePassThrough++;
          if (visibility.separated(tri, other)) continue;
          const overlap = clip(tri.vs, other.vs);
          if (overlap.length < 3) continue;
          let area = zero;
          for (let j = 1; j + 1 < overlap.length; j++)
            area = add(
              area,
              cross(
                requiredValue(overlap[0]),
                requiredValue(overlap[j]),
                requiredValue(overlap[j + 1]),
              ),
            );
          if (area.n === 0n) continue;
          if (overlap.some((p) => cmp(depth(p, other.vs), depth(p, tri.vs)) < 0)) {
            visible = false;
            break;
          }
        }
        if (visible) {
          for (const polygon of opposite) {
            const overlap = clip(polygon, tri.vs);
            let area = zero;
            for (let j = 1; j + 1 < overlap.length; j++)
              area = add(
                area,
                cross(
                  requiredValue(overlap[0]),
                  requiredValue(overlap[j]),
                  requiredValue(overlap[j + 1]),
                ),
              );
            if (area.n !== 0n)
              return {
                ...result(false, 'CONTRADICTORY_CONTINUOUS_POSITIVE_OWNERSHIP', proved.size),
                conflict: true,
              };
          }
          proved.add(face);
        }
      }
      if (proved.size === region.faces.length)
        return result(true, 'COMPLETE_ORIGINAL_TRIANGLE_OBSERVATION_CERTIFICATE', proved.size);
    } finally {
      owner.dispose();
      visibility.dispose();
    }
  }
  return result(false, 'UNCERTIFIED_ORIGINAL_SOURCE_TRIANGLE', proved.size);
}

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
