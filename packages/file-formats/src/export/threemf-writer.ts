import {
  IDENTITY_PART_TRANSFORM,
  placementReversesOrientation,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { throwIfCancelled } from '@cadfixer/shared';
import { MeshFormatId } from '../formats';
import { escapeXml } from '../threemf/xml-scan';
import { THREE_MF_UNITS } from '../threemf/threemf-reader';
import { createByteSink } from './byte-sink';
import {
  ExportObservation,
  mirroredObjectPlacement,
  planThreeMfObjects,
  snapshotTriangleCount,
  type ExportDocumentSnapshot,
  type FormatWriteDocumentContext,
  type WrittenDocument,
} from './export-contract';
import { MAX_THREEMF_MODEL_ENTRY_BYTES } from '../threemf/size-limits';
import { ExportRefusal, exportBlocked, exportInternal, exportTooLarge } from './export-errors';
import { writeFloat32Text, writeFloat64Text } from './numeric';
import { buildZipArchive } from './zip-writer';

/**
 * THE PRODUCTION 3MF WRITER.
 *
 * WHAT 3MF CARRIES THAT OBJ CANNOT, and this writer therefore does not lose:
 *
 *   - THE UNIT, written as the document's own token. Coordinates are never
 *     rescaled: the unit says what the numbers mean, not what they are.
 *   - THE PLACEMENTS, as `<item transform>` in Float64 decimal. Nothing is
 *     baked into a vertex.
 *   - THE SHARING. One distinct mesh becomes ONE `<object>`, and every part
 *     that uses it becomes a `<build><item>` pointing at that object. A
 *     thousand placements of one mesh serialise its geometry once. The research
 *     prototype wrote one object per part; production does not, because
 *     flattening sharing on write would turn a two-megabyte document into a
 *     two-gigabyte file for no reason.
 *
 * WHAT IT DOES NOT WRITE: any property resource, and therefore any `pid`. See
 * the object element below — a reference to a resource that does not exist is
 * not a preserved material, it is a malformed file.
 *
 * WHAT IT DOES NOT ATTEMPT: reconstructing the nested component graph an
 * imported file may have had. A `GeometryDocument` holds leaf placements and
 * mesh identity; the hierarchy above them is not retained, and inventing a
 * plausible one would be describing a structure the user never wrote. Output is
 * therefore canonical — mesh objects plus build items — and reads back as the
 * same document.
 *
 * ARCHIVE PATHS ARE FIXED. No entry path is derived from a document name, a
 * part name, a material reference or anything else that came from a file.
 */

const NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/** Fixed, and the same three entries the reader expects. */
const CONTENT_TYPES_PATH = '[Content_Types].xml';
const RELS_PATH = '_rels/.rels';
const MODEL_PATH = '3D/3dmodel.model';

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
  ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
  '</Types>\n';

/**
 * The one relationship, pointing INSIDE the package.
 *
 * `/3D/3dmodel.model` is a package-relative part name, not a URL. Nothing here
 * is fetchable and nothing external is referenced — the writer must produce
 * files that satisfy the same reader security contract imported files face, and
 * an external target would be refused by our own reader.
 */
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  ' <Relationship Id="rel0" Target="/3D/3dmodel.model" ' +
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
  '</Relationships>\n';

const TRIANGLES_PER_BATCH = 32_768;

/**
 * `Object.is`, NOT `===`.
 *
 * `-0 === 0` is true, so a placement whose translation is negative zero would
 * be judged the identity, no `transform` attribute would be written, and the
 * sign would be gone. `-0` is observable and is a stored value like any other.
 */
function isIdentity(transform: PartTransform): boolean {
  for (let index = 0; index < 12; index += 1) {
    if (!Object.is(transform[index], IDENTITY_PART_TRANSFORM[index])) return false;
  }
  return true;
}

/** Serialises the model part, enforcing the pre-compression byte ceiling. */
async function writeModelXml(
  snapshot: ExportDocumentSnapshot,
  unit: string,
  context: FormatWriteDocumentContext,
): Promise<Uint8Array> {
  /*
   * BOUNDED BY WHAT THE READER WILL TAKE BACK, NOT ONLY BY `maxSerialisedBytes`
   * — Stage 6E-A4.
   *
   * This buffer becomes ONE ZIP ENTRY, so the ceiling that actually binds it is
   * the reader's per-model-entry ceiling. Before A4 the writer used
   * `maxSerialisedBytes` (512 MiB) alone while the reader refused an entry over
   * 256 MiB, and the gap was reachable: a document of about 1.5 M triangles
   * serialised to a 22.7 MiB archive whose model entry the production reader
   * then refused as `ZIP_ENTRY_TOO_LARGE`. The export had already done all of
   * its work and failed at parse-back as an INTERNAL error — CAD Fixer writing
   * a file it could not read back.
   *
   * THE SMALLER OF THE TWO, so neither can be escaped: `maxSerialisedBytes`
   * still bounds the pre-compression text for a caller that narrows it, and
   * `MAX_THREEMF_MODEL_ENTRY_BYTES` guarantees the result is re-openable.
   */
  const sink = createByteSink(
    context.encodeText,
    Math.min(context.limits.maxSerialisedBytes, MAX_THREEMF_MODEL_ENTRY_BYTES),
    ExportRefusal.SerialisedTooLarge,
  );

  sink.write('<?xml version="1.0" encoding="UTF-8"?>\n');
  sink.write(`<model unit="${escapeXml(unit)}" xml:lang="en-US" xmlns="${NS}">\n`);
  sink.write(' <resources>\n');

  const totalTriangles = snapshotTriangleCount(snapshot);
  let written = 0;

  /*
   * ONE OBJECT PER (MESH, NAME, MATERIAL REFERENCE), because all three live on
   * the `<object>` in 3MF rather than on the `<item>` that places it. Object
   * ids are 1-based positions in this plan — ours, generated, never the source
   * file's ids, which may repeat across imports and are not identity here.
   */
  const plans = planThreeMfObjects(snapshot);
  for (const [index, plan] of plans.entries()) {
    const mesh = snapshot.meshes[plan.meshResourceIndex];
    if (mesh === undefined) {
      throw exportBlocked(
        ExportRefusal.MissingMeshResource,
        'A part in this document refers to geometry that is not present.',
        { objectIndex: index },
      );
    }
    const nameAttr =
      plan.name === undefined || plan.name === '' ? '' : ` name="${escapeXml(plan.name)}"`;
    /*
     * NO `pid` IS EMITTED, EVER, and that is a conformance requirement rather
     * than a preference.
     *
     * 3MF core defines `object@pid` as an `ST_ResourceID` — a positive integer
     * naming a property-group resource that must EXIST in `<resources>`. CAD
     * Fixer has no qualified property writer: it emits no `<basematerials>`, no
     * `<colorgroup>`, nothing a `pid` could point at. Writing the document's
     * opaque `materialRef` here therefore produced a DANGLING reference in every
     * case, and when that reference came from anywhere but a numeric source it
     * was not even lexically a resource id — `pid="steel-brushed"` was a real
     * output of this writer.
     *
     * Fabricating a `<basematerials>` to make the reference resolve is not the
     * fix either: a `materialRef` is an opaque import-level string, not a
     * material definition, so any resource invented for it would describe a
     * colour and a name the user never specified. The honest answer is to drop
     * the reference and SAY SO — `MaterialReferencesOmitted` below, surfaced by
     * the conversion report before the user exports.
     *
     * See ADR 0017, "3MF property references".
     */
    sink.write(`  <object id="${String(index + 1)}" type="model"${nameAttr}>\n`);
    sink.write('   <mesh>\n    <vertices>\n');

    const { positions, indices } = mesh;
    /*
     * A MIRRORED OBJECT holds the mesh mirrored in its own x with its triangles turned (`mirroredObjectPlacement` says why and
     * what the placement becomes). Negating a Float32 is exact, so no coordinate is rounded that was not rounded before.
     */
    const flip = plan.mirrored;
    for (let at = 0; at < positions.length; at += 3) {
      sink.write(
        `     <vertex x="${writeFloat32Text(flip ? -(positions[at] ?? 0) : (positions[at] ?? 0))}"` +
          ` y="${writeFloat32Text(positions[at + 1] ?? 0)}"` +
          ` z="${writeFloat32Text(positions[at + 2] ?? 0)}"/>\n`,
      );
    }

    sink.write('    </vertices>\n    <triangles>\n');
    for (let at = 0; at < indices.length; at += 3) {
      sink.write(
        `     <triangle v1="${String(indices[at] ?? 0)}"` +
          ` v2="${String(indices[at + (flip ? 2 : 1)] ?? 0)}"` +
          ` v3="${String(indices[at + (flip ? 1 : 2)] ?? 0)}"/>\n`,
      );
      written += 1;
      if (written % TRIANGLES_PER_BATCH === 0) {
        throwIfCancelled(context.cancellation);
        await context.yieldToEventLoop();
        throwIfCancelled(context.cancellation);
        context.progress.report(
          totalTriangles === 0 ? 0.5 : (written / totalTriangles) * 0.6,
          'writing model',
        );
      }
    }

    sink.write('    </triangles>\n   </mesh>\n  </object>\n');
    throwIfCancelled(context.cancellation);
  }

  sink.write(' </resources>\n <build>\n');

  /*
   * BUILD ITEMS IN DOCUMENT ORDER, each pointing at the object its part was
   * grouped into. Order is the DOCUMENT'S, not the plan's: a reader rebuilds
   * parts from the build, so emitting them grouped would silently reorder the
   * user's parts.
   */
  const objectIdOfPart = new Map<number, number>();
  for (const [index, plan] of plans.entries()) {
    for (const partIndex of plan.partIndices) objectIdOfPart.set(partIndex, index + 1);
  }

  for (const [index, part] of snapshot.parts.entries()) {
    const objectId = objectIdOfPart.get(index) ?? 1;
    // The placement a build item carries never reflects: a mirroring placement is composed with the object's own mirror.
    const placement = placementReversesOrientation(part.transform)
      ? mirroredObjectPlacement(part.transform)
      : part.transform;
    const transform = isIdentity(placement)
      ? ''
      : ` transform="${placement.map(writeFloat64Text).join(' ')}"`;
    sink.write(`  <item objectid="${String(objectId)}"${transform}/>\n`);
  }

  sink.write(' </build>\n</model>\n');
  return sink.finish();
}

export async function write3mfDocument(
  snapshot: ExportDocumentSnapshot,
  context: FormatWriteDocumentContext,
): Promise<WrittenDocument> {
  if (snapshot.parts.length === 0) {
    throw exportBlocked(
      ExportRefusal.NoParts,
      'This document has no parts, so there is nothing to write.',
    );
  }

  /*
   * THE UNIT IS REQUIRED AND IS NEVER INVENTED.
   *
   * A 3MF states one unit for everything it contains. A document derived from
   * an STL or an OBJ states none, and there is no assertion anywhere to base a
   * guess on — writing `millimeter` would be CAD Fixer claiming a physical fact
   * about the user's model that nobody established.
   *
   * This is NOT in tension with the reader's millimetre default. A 3MF that
   * omits the attribute HAS stated millimetres, because the specification
   * defines what an absent attribute means. An unknown-unit document has said
   * nothing at all. One is reading a fact; the other would be inventing one.
   */
  if (snapshot.unit === undefined) {
    throw exportBlocked(
      ExportRefusal.UnitRequired,
      'This model states no unit, and a 3MF file has to declare one. Pybrix will not choose a unit on your behalf.',
    );
  }
  if (!THREE_MF_UNITS.includes(snapshot.unit)) {
    throw exportInternal(
      ExportRefusal.MalformedSnapshot,
      'This model states a unit that 3MF cannot express.',
      { unit: snapshot.unit.slice(0, 32) },
    );
  }

  const deflateRaw = context.deflateRaw;
  if (deflateRaw === undefined) {
    throw exportInternal(
      ExportRefusal.MalformedSnapshot,
      '3MF export needs a compressor, and none was provided.',
    );
  }

  context.progress.report(0.02, 'writing model');
  const model = await writeModelXml(snapshot, snapshot.unit, context);
  throwIfCancelled(context.cancellation);

  context.progress.report(0.65, 'compressing');
  const bytes = await buildZipArchive(
    [
      { name: CONTENT_TYPES_PATH, content: context.encodeText(CONTENT_TYPES) },
      { name: RELS_PATH, content: context.encodeText(RELS) },
      { name: MODEL_PATH, content: model },
    ],
    {
      deflateRaw,
      maxOutputBytes: context.limits.maxOutputBytes,
      throwIfCancelled: () => {
        throwIfCancelled(context.cancellation);
      },
    },
  );

  if (bytes.byteLength > context.limits.maxOutputBytes) {
    throw exportTooLarge(
      ExportRefusal.OutputTooLarge,
      'This export would produce a larger file than Pybrix will write.',
      { produced: bytes.byteLength, limit: context.limits.maxOutputBytes },
    );
  }

  const observations: ExportObservation[] = [
    ExportObservation.UnitPreserved,
    ExportObservation.TransformsPreserved,
    ExportObservation.NormalsOmitted,
    ExportObservation.TextureCoordinatesOmitted,
    ExportObservation.ComponentHierarchyNotReconstructed,
  ];
  const objectPlans = planThreeMfObjects(snapshot);
  if (objectPlans.length < snapshot.parts.length) {
    observations.push(ExportObservation.SharingPreserved);
  }
  // A mirrored placement of a mesh and a plain one are different OBJECTS by construction, not by metadata: only objects beyond one
  // per distinct (mesh, mirror) were split because the parts disagreed about a name.
  const distinctShapes = new Set(
    objectPlans.map((plan) => `${String(plan.meshResourceIndex)}:${String(plan.mirrored)}`),
  ).size;
  if (objectPlans.length > distinctShapes) {
    // Parts shared a mesh and disagreed about its name or material reference,
    // so the geometry was written more than once to keep both names.
    observations.push(ExportObservation.SharingSplitByMetadata);
  }
  if (objectPlans.some((plan) => plan.mirrored)) {
    observations.push(ExportObservation.MirroredPlacementReoriented);
  }
  if (snapshot.parts.some((part) => part.name !== undefined && part.name !== '')) {
    observations.push(ExportObservation.NamesPreserved);
  }
  if (snapshot.parts.some((part) => part.materialRef !== undefined)) {
    /*
     * OMITTED, NOT PRESERVED. This said `MaterialReferencesPreserved` while the
     * writer emitted a `pid` no resource backed — the observation and the bytes
     * described different files. One contract, stated once.
     */
    observations.push(ExportObservation.MaterialReferencesOmitted);
  }
  /*
   * RECORDED WHEN THE UNIT CAME FROM A PERSON, not from the document.
   *
   * The file now states something the model never did. That is the one fact in
   * this list whose source is a user rather than geometry, and it belongs in
   * the artifact's own record of what happened rather than only in the dialog
   * that asked the question.
   */
  if (snapshot.unitAsserted) observations.push(ExportObservation.UnitAssertedByUser);

  return {
    bytes,
    metadata: {
      formatId: MeshFormatId.ThreeMf,
      outputBytes: bytes.byteLength,
      triangleCount: snapshotTriangleCount(snapshot),
      partCount: snapshot.parts.length,
      meshResourceCount: objectPlans.length,
      observations,
    },
  };
}
