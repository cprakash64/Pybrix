/** Independent frozen old mathematical predicates; test-only, never imported by product. */
import { InvocationExactGcdCache } from './semantic-exact-gcd-cache';
import {
  exactOwnerOrientationSign,
  type OwnerOrientationSign,
} from './semantic-owner-orientation-sign';
interface Q {
  n: bigint;
  d: bigint;
}
interface P {
  x: Q;
  y: Q;
  z: Q;
}
export function oldExactGeometry(): {
  q: (n: bigint, d?: bigint) => Q;
  from: (x: number) => Q;
  zero: Q;
  one: Q;
  half: Q;
  add: (a: Q, b: Q) => Q;
  neg: (a: Q) => Q;
  sub: (a: Q, b: Q) => Q;
  mul: (a: Q, b: Q) => Q;
  div: (a: Q, b: Q) => Q;
  cmp: (a: Q, b: Q) => number;
  cross: (a: P, b: P, c: P) => Q;
  mix: (a: P, b: P, t: Q) => P;
  inside: (p: P, poly: P[]) => boolean;
  contained: (tri: P[], poly: P[]) => boolean;
  clip: (input: P[], tri: P[]) => P[];
  depth: (p: P, tri: P[]) => Q;
  simple: (poly: P[]) => boolean;
  clipCalls: () => number;
} {
  let workUnits = 0,
    clipEntries = 0;
  const tick = (): void => {
      workUnits++;
    },
    checkpoint = (): void => {
      // Intentionally empty hook; preserve the undefined return value.
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

  return {
    q,
    from,
    zero,
    one,
    half,
    add,
    neg,
    sub,
    mul,
    div,
    cmp,
    cross,
    mix,
    inside,
    contained,
    clip,
    depth,
    simple,
    clipCalls: (): number => clipEntries,
  };
}

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
