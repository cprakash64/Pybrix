import { IDENTITY_PART_TRANSFORM, placementReversesOrientation } from '@cadfixer/mesh-core';
import type { PartDescriptor } from '@cadfixer/geometry-runtime';
import { objNameChangesOnWrite, xmlTextChangesOnWrite } from '@cadfixer/file-formats';
import type { DocumentFeatureProfile } from '@cadfixer/file-formats';
import type { LoadedModel } from './model';

/**
 * THE SCALAR SUMMARY A CONVERSION REPORT IS JUDGED FROM.
 *
 * Built from part descriptors the page already holds, so it costs a walk over a
 * few hundred scalars and touches no geometry — a thousand-part document is a
 * thousand small objects, not a thousand meshes.
 *
 * WHY IT IS DERIVED HERE RATHER THAN FETCHED FROM THE WORKER. A report fetched
 * once is a report that can go stale: the user opens Export, a repair lands, the
 * document moves to revision N+1, and the dialog is now describing geometry that
 * is no longer there. Deriving it from current state makes the report a pure
 * function of the model — when the model changes, React re-renders and the
 * report is recomputed, with no window in which a stale one could authorise an
 * export. See ADR 0017.
 *
 * THE WORKER REMAINS THE AUTHORITY ON WHAT IS WRITTEN. This decides what the
 * user is TOLD; the export snapshot is built from the real document, and the
 * 3MF writer still refuses a unit-less document whatever this said.
 */

/**
 * Counts DISTINCT meshes among the descriptors.
 *
 * `meshResourceIndex` is assigned in first-use order by `describeParts`, so the
 * distinct count is one more than the largest index. Counting parts instead
 * would report a thousand placements of one mesh as a thousand meshes and turn
 * every shared document into a false "geometry will be duplicated" warning —
 * for 3MF, where it will not be.
 */
function distinctMeshCount(parts: readonly PartDescriptor[]): number {
  const seen = new Set<number>();
  for (const part of parts) seen.add(part.meshResourceIndex);
  return seen.size;
}

/**
 * `Object.is`, not `===`, matching the 3MF writer's own identity test.
 *
 * `-0 === 0` is true, so a placement translated by negative zero would be judged
 * the identity here and preserved as one there — or the other way round. The two
 * must agree, or the report describes a bake that does not happen.
 */
function isIdentityTransform(transform: PartDescriptor['transform']): boolean {
  for (let index = 0; index < 12; index += 1) {
    if (!Object.is(transform[index], IDENTITY_PART_TRANSFORM[index])) return false;
  }
  return true;
}

/**
 * How many `<object>` records a 3MF export would write.
 *
 * THE SAME KEY `planThreeMfObjects` USES — (mesh, NAME). The material reference
 * is deliberately NOT part of it: the writer emits no `pid`, so two placements
 * that differ only in an opaque material reference produce one object, and
 * splitting on it here would report duplicated geometry that never happens.
 *
 * Restated rather than imported because importing the writer's planner would
 * pull the serialiser into the main-thread bundle; tests keep the mirror honest
 * against `planThreeMfObjects` itself.
 *
 * Getting this wrong in the optimistic direction is the failure that matters:
 * a report claiming a thousand placements share one copy of the geometry, when
 * their names differ and the writer will emit a thousand objects, is a false
 * lossless claim about the largest file the product can produce.
 */
function threeMfObjectCount(parts: readonly PartDescriptor[]): number {
  const keys = new Set<string>();
  for (const part of parts) {
    // A part whose placement mirrors it is written as its own (mirrored) object, exactly as `planThreeMfObjects` plans it.
    const mirrored = placementReversesOrientation(part.transform);
    keys.add(
      `${String(part.meshResourceIndex)}\u0000${part.name ?? ''}\u0000${mirrored ? 'mirrored' : 'plain'}`,
    );
  }
  return keys.size;
}

export function documentFeatureProfile(model: LoadedModel): DocumentFeatureProfile {
  const parts = model.parts;

  let nonIdentityTransformCount = 0;
  let namedPartCount = 0;
  let unnamedPartCount = 0;
  let partMaterialRefCount = 0;

  /*
   * GROUPS AND ATTRIBUTES ARE COUNTED PER DISTINCT MESH, NOT PER PART.
   *
   * Two parts sharing one mesh report the same group count, so summing per part
   * would double it — and the user would be told twelve groups will be dropped
   * from a model that has six. The same reasoning `assertMeshStructure` uses on
   * import: a shared mesh is one thing, however many places it stands in.
   */
  const countedMeshes = new Set<number>();
  let groupCount = 0;
  let groupMaterialRefCount = 0;
  let meshesWithNormals = 0;
  let meshesWithUvs = 0;

  for (const part of parts) {
    if (!isIdentityTransform(part.transform)) nonIdentityTransformCount += 1;
    if (part.name === undefined || part.name.length === 0) unnamedPartCount += 1;
    else namedPartCount += 1;
    if (part.materialRef !== undefined) partMaterialRefCount += 1;

    if (countedMeshes.has(part.meshResourceIndex)) continue;
    countedMeshes.add(part.meshResourceIndex);
    groupCount += part.groupCount;
    groupMaterialRefCount += part.groupMaterialRefCount;
    if (part.hasNormals) meshesWithNormals += 1;
    if (part.hasUvs) meshesWithUvs += 1;
  }

  /*
   * NAMES THAT WILL NOT SURVIVE A WRITE UNCHANGED, counted per target.
   *
   * COUNTED, NEVER CARRIED. The profile deliberately holds no names — putting
   * one in a compatibility fact would put untrusted text one render away from
   * markup — so the disclosure is a number and the names stay here.
   *
   * The predicates come from leaf modules that import nothing, so asking this
   * question on the main thread does not pull a serialiser or the XML scanner
   * into the bundle. They are the SAME functions the writers use, not a mirror
   * of them, so the count cannot disagree with what actually happens.
   */
  let namesUnwritableAsObj = 0;
  let namesUnwritableAsXml = 0;
  for (const part of parts) {
    const name = part.name;
    if (name === undefined || name.length === 0) continue;
    if (objNameChangesOnWrite(name)) namesUnwritableAsObj += 1;
    if (xmlTextChangesOnWrite(name)) namesUnwritableAsXml += 1;
  }

  return {
    partCount: parts.length,
    meshResourceCount: distinctMeshCount(parts),
    threeMfObjectCount: threeMfObjectCount(parts),
    triangleCount: model.triangleCount,
    unit: model.source.unit,
    nonIdentityTransformCount,
    namedPartCount,
    unnamedPartCount,
    groupCount,
    groupMaterialRefCount,
    partMaterialRefCount,
    meshesWithNormals,
    meshesWithUvs,
    sourceUnsupported: model.source.unsupportedFeatures,
    sourceFormat: model.source.formatId,
    namesUnwritableAsObj,
    namesUnwritableAsXml,
  };
}
