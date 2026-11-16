/**
 * THE UNIFORM SCALE OF A PART'S PLACEMENT, or NaN when it has none.
 *
 * A connector's physical size and the material around it are distances in the part's own coordinates; they mean the same thing in
 * the world only if the placement is a SIMILARITY — a translation, a rotation, a reflection and at most one uniform scale. The
 * canonical transform is twelve numbers: three basis vectors (the columns of the linear part, three numbers each) and then the
 * translation (`mesh-core`'s `PartTransform`; `[1,0,0, 0,1,0, 0,0,1, x,y,z]` is a translation). The linear part is a similarity iff
 * its three basis vectors have one common length and are mutually orthogonal. NaN is returned for a non-uniform scale, a shear, a
 * degenerate (zero or non-finite) transform, or anything that is not twelve numbers, and the connector code refuses on NaN
 * (`UNSUPPORTED_TRANSFORM`): it neither reinterprets nor corrects the placement. Audit C03 decides what such a transform means.
 *
 * The tolerance is the one this check has always had: lengths agree and axes are orthogonal to one part in a million of the scale.
 * The translation is not read: it moves a part and distorts nothing.
 */
export function uniformPhysicalScale(transform: readonly number[]): number {
  if (transform.length !== 12) return Number.NaN;
  const axes: readonly (readonly [number, number, number])[] = [
      [transform[0] ?? Number.NaN, transform[1] ?? Number.NaN, transform[2] ?? Number.NaN],
      [transform[3] ?? Number.NaN, transform[4] ?? Number.NaN, transform[5] ?? Number.NaN],
      [transform[6] ?? Number.NaN, transform[7] ?? Number.NaN, transform[8] ?? Number.NaN],
    ],
    lengths = axes.map((axis) => Math.hypot(...axis)),
    scale = lengths[0] ?? Number.NaN;
  if (
    !(scale > 0) ||
    !Number.isFinite(scale) ||
    lengths.some((x) => !(Math.abs(x - scale) <= scale * 1e-6))
  )
    return Number.NaN;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const a = axes[i],
        b = axes[j];
      if (a === undefined || b === undefined) return Number.NaN;
      if (!(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) <= scale * scale * 1e-6))
        return Number.NaN;
    }
  return scale;
}
