/**
 * WHAT A PART'S PLACEMENT DOES TO DISTANCE — the one classifier.
 *
 * A connector's physical size, and the material around it, are distances measured in the part's own coordinates. They mean the
 * same thing in the world only if the placement is a SIMILARITY: a translation, a rotation, a reflection and at most one uniform
 * scale. This module is the single place that decides whether a placement is one, and if so its scale. Everything that needs
 * "the part's physical scale" asks here; nothing else restates the rule (a boundary test holds that).
 *
 * The canonical transform is twelve numbers: three basis vectors (the columns of the linear part, three numbers each) and then
 * the translation (`PartTransform`; `[1,0,0, 0,1,0, 0,0,1, x,y,z]` is a translation). The linear part is a similarity iff its
 * three basis vectors have one common length and are mutually orthogonal. The translation is not read: it moves a part and
 * distorts nothing.
 *
 * REFUSALS ARE TYPED. A placement that is not a similarity carries the REASON it is not one, because a non-uniform scale, a shear,
 * a degenerate placement and a non-finite entry send a person to different places. The classifier neither reinterprets nor
 * corrects a placement.
 *
 * WHAT THIS STAGE (C03-A) DELIBERATELY DOES NOT CHANGE. The tolerance is the one the check has always had — lengths agree and
 * axes are orthogonal to one part in a million of the scale — and the scale it reports is the length of the first basis vector,
 * exactly as before. A real producer that rounds a rotation to six decimals can fall outside that tolerance; whether to widen it
 * is a measured decision for a later stage, and it is not made here.
 */

/** Why a placement is not a similarity. */
export const PlacementRefusal = {
  /** The transform is not twelve numbers. */
  Malformed: 'MALFORMED',
  /** An entry, or the scale it implies, is NaN or infinite. */
  NonFinite: 'NON_FINITE',
  /** A basis vector has zero length: the placement collapses a direction. */
  Degenerate: 'DEGENERATE',
  /** The three basis vectors do not share one length. */
  NonUniformScale: 'NON_UNIFORM_SCALE',
  /** The basis vectors share a length and are not mutually orthogonal. */
  Shear: 'SHEAR',
} as const;
export type PlacementRefusal = (typeof PlacementRefusal)[keyof typeof PlacementRefusal];

export type PlacementClass =
  | {
      readonly kind: 'SIMILARITY';
      /** The uniform scale: the length of the first basis vector. 1 for a rigid placement. */
      readonly scale: number;
    }
  | { readonly kind: 'UNSUPPORTED'; readonly reason: PlacementRefusal };

/** Lengths agree, and axes are orthogonal, to this fraction of the scale. Unchanged by Stage C03-A. */
export const PLACEMENT_CLASSIFICATION_TOLERANCE = 1e-6;

const UNSUPPORTED = (reason: PlacementRefusal): PlacementClass =>
  Object.freeze({ kind: 'UNSUPPORTED', reason });

export function classifyPlacement(transform: readonly number[]): PlacementClass {
  if (transform.length !== 12) return UNSUPPORTED(PlacementRefusal.Malformed);
  const axes: readonly (readonly [number, number, number])[] = [
    [transform[0] ?? Number.NaN, transform[1] ?? Number.NaN, transform[2] ?? Number.NaN],
    [transform[3] ?? Number.NaN, transform[4] ?? Number.NaN, transform[5] ?? Number.NaN],
    [transform[6] ?? Number.NaN, transform[7] ?? Number.NaN, transform[8] ?? Number.NaN],
  ];
  if (axes.some((axis) => axis.some((entry) => !Number.isFinite(entry))))
    return UNSUPPORTED(PlacementRefusal.NonFinite);
  const lengths = axes.map((axis) => Math.hypot(...axis)),
    scale = lengths[0] ?? Number.NaN;
  // Entries are finite, so a non-finite length is an overflow and a non-positive one is a collapsed axis.
  if (!Number.isFinite(scale)) return UNSUPPORTED(PlacementRefusal.NonFinite);
  if (!(scale > 0)) return UNSUPPORTED(PlacementRefusal.Degenerate);
  if (lengths.some((length) => !Number.isFinite(length)))
    return UNSUPPORTED(PlacementRefusal.NonFinite);
  if (lengths.some((length) => !(length > 0))) return UNSUPPORTED(PlacementRefusal.Degenerate);
  if (
    lengths.some(
      (length) => !(Math.abs(length - scale) <= scale * PLACEMENT_CLASSIFICATION_TOLERANCE),
    )
  )
    return UNSUPPORTED(PlacementRefusal.NonUniformScale);
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const a = axes[i],
        b = axes[j];
      if (a === undefined || b === undefined) return UNSUPPORTED(PlacementRefusal.Malformed);
      if (
        !(
          Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) <=
          scale * scale * PLACEMENT_CLASSIFICATION_TOLERANCE
        )
      )
        return UNSUPPORTED(PlacementRefusal.Shear);
    }
  return Object.freeze({ kind: 'SIMILARITY', scale });
}
