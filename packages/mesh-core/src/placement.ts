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
 * REFLECTION POLICY (Stage C03-B). A placement whose linear part has a NEGATIVE determinant mirrors the part. A mirror preserves every
 * distance, and a round pin and its round socket are each symmetric about their own axis, so a mirrored part carries a connector with
 * exactly the physical sizes, clearance and material margins of its unmirrored twin: the engine works in the part's own coordinates,
 * where no reflection exists, and the two pieces a split makes inherit the same mirror through their placements, so a pin and its
 * socket stay one world-space pair. A reflection is therefore SUPPORTED, and it is reported (`mirrored`), never silently folded
 * into "a rotation". The determinant is read only after the placement is known to be a similarity, where its magnitude is the cube of
 * the scale and its sign cannot be a rounding artefact. If a later connector kind has a handedness (a dovetail, a keyed or chiral
 * feature), it must refuse `mirrored` itself: this module does not decide that for a kind that does not exist.
 *
 * TOLERANCE (Stage C03-B). The tolerance is the one the check has always had — lengths agree and axes are orthogonal to one part in
 * a million of the scale — and the scale it reports is the length of the first basis vector, exactly as before. C03-B measured it
 * against the real 3MF files available (see the C03-B evidence) and found nothing that contradicts it; it is preserved, not
 * re-derived. Widening it needs a producer that writes fewer significant digits than six AND evidence that its transforms are
 * rigid by intent, neither of which exists in the corpus. It is a CLASSIFICATION tolerance: it is never a welding distance, a snap
 * or a geometric tolerance, and nothing else may read it.
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
      /** The uniform scale: the length of the first basis vector. 1 for a rigid placement. Always finite and positive. */
      readonly scale: number;
      /** The determinant is negative: the placement mirrors the part. See the reflection policy above. */
      readonly mirrored: boolean;
    }
  | { readonly kind: 'UNSUPPORTED'; readonly reason: PlacementRefusal };

/** The placement of a part that has none: no scale, no mirror. What an engine call that names no placement means. */
export const IDENTITY_PLACEMENT: PlacementClass = Object.freeze({
  kind: 'SIMILARITY',
  scale: 1,
  mirrored: false,
});

/** Lengths agree, and axes are orthogonal, to this fraction of the scale. Unchanged by Stages C03-A and C03-B. */
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
  // For a similarity the determinant's magnitude is scale³, so only its sign is read.
  return Object.freeze({
    kind: 'SIMILARITY',
    scale,
    mirrored: placementReversesOrientation(transform),
  });
}

/**
 * The determinant of the placement's 3×3 linear part: the triple product a · (b × c) of its three basis vectors. The one place the
 * number is formed, so that "does this placement mirror?" has one answer for the classifier AND for every writer that has to keep a
 * solid facing outward after it applies a placement (Stage C03-D).
 */
export function placementLinearDeterminant(transform: readonly number[]): number {
  const [a0 = 0, a1 = 0, a2 = 0, b0 = 0, b1 = 0, b2 = 0, c0 = 0, c1 = 0, c2 = 0] = transform;
  return a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0);
}

/**
 * Whether applying this placement to a mesh turns it inside out unless the winding is also reversed: the determinant is negative.
 *
 * A mirror keeps every vertex where the placement puts it and reverses the handedness of every triangle, so a closed solid written
 * with its original corner order has its normals pointing into the material and a negative volume. This is independent of
 * `classifyPlacement`'s support policy: a non-uniform or sheared placement that also mirrors reverses orientation too, and an
 * exporter that bakes one must reverse the corners whether or not a connector could have been cut into that part. A non-finite or
 * zero determinant (a collapsed placement) reverses nothing: there is no orientation left to keep.
 */
export function placementReversesOrientation(transform: readonly number[]): boolean {
  return placementLinearDeterminant(transform) < 0;
}
