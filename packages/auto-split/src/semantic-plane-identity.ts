import type { SuggestedPlane } from './suggestions';
type Rational = readonly [bigint, bigint];
function gcd(a: bigint, b: bigint): bigint {
  return b ? gcd(b, a % b) : a < 0n ? -a : a;
}
function ratio(a: bigint, b = 1n): Rational {
  if (!b) throw Error('Invalid plane ratio.');
  if (b < 0n) {
    a = -a;
    b = -b;
  }
  const d = gcd(a, b);
  return [a / d, b / d];
}
function binary(x: number): Rational {
  if (!Number.isFinite(x)) throw Error('Invalid plane coordinate.');
  if (x === 0) return [0n, 1n];
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0),
    exponent = Number((bits >> 52n) & 2047n),
    fraction = bits & ((1n << 52n) - 1n);
  const n = (exponent ? fraction + (1n << 52n) : fraction) * (bits >> 63n ? -1n : 1n),
    power = (exponent || 1) - 1075;
  return power >= 0 ? ratio(n << BigInt(power)) : ratio(n, 1n << BigInt(-power));
}
const divide = (a: Rational, b: Rational): Rational => ratio(a[0] * b[1], a[1] * b[0]);
/** Exact binary-rational physical identity. Orientation is separately bound to the selected side. */
export function semanticPlaneIdentity(plane: SuggestedPlane): {
  readonly hyperplane: string;
  readonly positiveSide: 1 | -1;
} {
  const n = plane.normal.map(binary),
    o = plane.origin.map(binary);
  let axis = 0;
  for (let i = 1; i < 3; i++)
    if (Math.abs(plane.normal[i] ?? 0) > Math.abs(plane.normal[axis] ?? 0)) axis = i;
  const pivot = n[axis];
  if (!pivot || pivot[0] === 0n) throw Error('Invalid plane normal.');
  let dot: Rational = [0n, 1n];
  for (let i = 0; i < 3; i++) {
    const a = n[i],
      b = o[i];
    if (!a || !b) throw Error('Invalid plane dimension.');
    const term = ratio(a[0] * b[0], a[1] * b[1]);
    dot = ratio(dot[0] * term[1] + term[0] * dot[1], dot[1] * term[1]);
  }
  return {
    hyperplane: JSON.stringify(
      [...n.map((v) => divide(v, pivot)), divide(dot, pivot)].map((v) => v.map(String)),
    ),
    positiveSide: pivot[0] > 0n ? 1 : -1,
  };
}
