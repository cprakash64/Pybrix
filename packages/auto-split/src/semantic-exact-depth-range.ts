/** Exact depth bounds for the existing orthographic affine triangle depth. */
export interface ExactDepth {
  readonly n: bigint;
  readonly d: bigint;
}
export interface ExactTriangleDepthRange {
  readonly minDepth: ExactDepth;
  readonly maxDepth: ExactDepth;
}
type Compare = (a: ExactDepth, b: ExactDepth) => number;
export function exactTriangleDepthRange(
  vertices: readonly { readonly z: ExactDepth }[],
  compare: Compare,
): ExactTriangleDepthRange {
  let minDepth = requiredValue(vertices[0]).z,
    maxDepth = minDepth;
  for (let i = 1; i < 3; i++) {
    const z = requiredValue(vertices[i]).z;
    if (compare(z, minDepth) < 0) minDepth = z;
    if (compare(z, maxDepth) > 0) maxDepth = z;
  }
  return { minDepth, maxDepth };
}
/** Equality is noncloser because the existing visibility comparison is strict. */
export function exactRangeNonCloser(
  source: ExactTriangleDepthRange,
  target: ExactTriangleDepthRange,
  compare: Compare,
): boolean {
  return compare(source.minDepth, target.maxDepth) >= 0;
}

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
