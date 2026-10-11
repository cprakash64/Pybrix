/**
 * THE ONE TRIANGLE CEILING A SPLIT SUPPORTS.
 *
 * Auto Split analyses a part, then hands a plane or a component selection to the same exact-split
 * and preview path Manual Split uses. Two ceilings, one in each place, meant a model could pass the
 * first and be refused by the second — "Auto Split found a cut and the cut cannot be previewed".
 * There is ONE number instead, and every path that decides "is this part too detailed to split"
 * reads it:
 *
 *   - Auto Split's analysis (`autosplit/render`, `autosplit/suggest`) and the page's pre-check,
 *   - the Boolean adapter's per-input triangle gate (`runValidatedBoolean`),
 *   - and, derived from it, the Manifold input-byte budget (`MAX_BOOLEAN_INPUT_BYTES`).
 *
 * The value is the qualified Boolean ceiling it replaced as the binding limit, not a new one: raising
 * it is a decision that needs the large-mesh ladder in `docs/design/AUTO_SPLIT_LARGE_MESH.md`
 * re-measured, not an argument. The topology-workspace, canonical-byte, output-triangle and
 * edit-peak guards are INDEPENDENT of it and stay in force.
 */
export const MAX_SUPPORTED_SPLIT_TRIANGLES = 2_000_000;

/** True when a part of `triangles` faces is within the split ceiling (the ceiling itself is allowed). */
export function isWithinSplitTriangleCeiling(triangles: number): boolean {
  return (
    Number.isSafeInteger(triangles) && triangles >= 0 && triangles <= MAX_SUPPORTED_SPLIT_TRIANGLES
  );
}
