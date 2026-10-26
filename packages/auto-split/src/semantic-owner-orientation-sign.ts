/** Exact sign only: callers needing a rational magnitude must retain their full path. */
export type OwnerOrientationSign = -1 | 0 | 1;
export interface OwnerOrientationCoordinate {
  readonly n: bigint;
  readonly d: bigint;
}
export interface OwnerOrientationPoint {
  readonly x: OwnerOrientationCoordinate;
  readonly y: OwnerOrientationCoordinate;
}

export function exactOwnerOrientationSign(
  a: OwnerOrientationPoint,
  b: OwnerOrientationPoint,
  c: OwnerOrientationPoint,
  charge: () => void,
  unsupported: () => OwnerOrientationSign,
): OwnerOrientationSign {
  const positive = (v: OwnerOrientationCoordinate): boolean => {
    charge();
    return v.d > 0n;
  };
  if (
    !positive(a.x) ||
    !positive(a.y) ||
    !positive(b.x) ||
    !positive(b.y) ||
    !positive(c.x) ||
    !positive(c.y)
  )
    return unsupported();
  const product = (x: bigint, y: bigint): bigint => {
    charge();
    return x * y;
  };
  const difference = (x: bigint, y: bigint): bigint => {
    charge();
    return x - y;
  };
  const un = difference(product(b.x.n, a.x.d), product(a.x.n, b.x.d)),
    ud = product(b.x.d, a.x.d),
    vn = difference(product(c.y.n, a.y.d), product(a.y.n, c.y.d)),
    vd = product(c.y.d, a.y.d),
    sn = difference(product(b.y.n, a.y.d), product(a.y.n, b.y.d)),
    sd = product(b.y.d, a.y.d),
    tn = difference(product(c.x.n, a.x.d), product(a.x.n, c.x.d)),
    td = product(c.x.d, a.x.d),
    left = product(un, vn),
    leftDenominator = product(ud, vd),
    right = product(sn, tn),
    rightDenominator = product(sd, td),
    numerator = difference(product(left, rightDenominator), product(right, leftDenominator));
  charge();
  if (numerator < 0n) return -1;
  charge();
  return numerator > 0n ? 1 : 0;
}
