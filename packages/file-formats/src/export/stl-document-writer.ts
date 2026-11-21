import {
  applyPartTransform,
  IDENTITY_PART_TRANSFORM,
  placementReversesOrientation,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { throwIfCancelled } from '@cadfixer/shared';
import { MeshFormatId } from '../formats';
import {
  BINARY_FACET_BYTES,
  BINARY_HEADER_BYTES,
  BINARY_PREFIX_BYTES,
  binaryStlByteLength,
  maxStlDocumentTriangles as triangleCeilingFor,
} from './stl-layout';
import {
  ExportObservation,
  snapshotTriangleCount,
  type ExportDocumentSnapshot,
  type ExportLimits,
  type FormatWriteDocumentContext,
  type WrittenDocument,
} from './export-contract';
import { ExportRefusal, exportBlocked, exportTooLarge } from './export-errors';

/**
 * THE WHOLE-DOCUMENT BINARY STL WRITER.
 *
 * DIFFERENT FROM `stl/stl-writer.ts`, and deliberately so. That writer takes
 * ONE `CanonicalMesh` and is what the active-part quick export uses. This one
 * takes a whole `ExportDocumentSnapshot` and flattens every part into a single
 * triangle stream, because that is what "convert this document to STL" has to
 * mean: STL has one implicit object and no way to say otherwise.
 *
 * WHAT STL CANNOT CARRY, and is therefore never pretended:
 *
 *   - PARTS. Everything becomes one soup. A document's part structure is gone,
 *     which is a structural loss and is recorded as one.
 *   - TRANSFORMS. A placement survives only by being applied to coordinates.
 *   - UNITS. The format has no field at all, so a document with a known unit
 *     loses the label. The coordinates are NOT rescaled to compensate.
 *   - NAMES, GROUPS, MATERIAL REFERENCES, SHARED INSTANCES. All flattened away.
 *
 * BINARY, NOT ASCII. The active-part exporter offers both because a user may
 * want to read the file; a whole-document conversion of a multi-part model is
 * the large case, and ASCII is roughly five times the size for the same
 * geometry — large enough that the self-round-trip policy in `stl-writer.ts`
 * starts refusing files binary would write happily. One encoding also makes the
 * output size EXACTLY predictable, which is what lets this refuse an impossible
 * conversion before allocating anything.
 *
 * NOTHING HERE MUTATES THE SNAPSHOT. Flattening is a property of the output; it
 * happens into the output buffer and into nothing else. There is no flattened
 * `CanonicalMesh` anywhere, authoritative or otherwise.
 */

/** Yield every this many triangles. Matches the OBJ writer's batch. */
const TRIANGLES_PER_BATCH = 32_768;

/**
 * Fixed 80-byte header.
 *
 * Carries no document name, no part name and no filename — the same policy as
 * `stl/stl-writer.ts`, and for the same reason: the header is a fixed-width
 * field many tools display verbatim, so user text placed there travels with any
 * copy of the file the user shares.
 */
const BINARY_HEADER_TEXT = 'Pybrix binary STL';

/**
 * The largest triangle count that fits this export's ceiling.
 *
 * A thin wrapper over `stl-layout.ts` so a writer can keep speaking in
 * `ExportLimits` while the arithmetic itself stays in a module the main thread
 * can import without dragging a serialiser along with it.
 */
export function maxStlDocumentTriangles(limits: ExportLimits): number {
  return triangleCeilingFor(limits.maxOutputBytes);
}

/** Exact byte length of the artifact a triangle count will produce. */
export function stlDocumentByteLength(triangles: number): number {
  return binaryStlByteLength(triangles);
}

function isIdentity(transform: PartTransform): boolean {
  for (let index = 0; index < 12; index += 1) {
    if (transform[index] !== IDENTITY_PART_TRANSFORM[index]) return false;
  }
  return true;
}

export async function writeStlDocument(
  snapshot: ExportDocumentSnapshot,
  context: FormatWriteDocumentContext,
): Promise<WrittenDocument> {
  if (snapshot.parts.length === 0) {
    throw exportBlocked(
      ExportRefusal.NoParts,
      'This document has no parts, so there is nothing to write.',
    );
  }

  const totalTriangles = snapshotTriangleCount(snapshot);

  /*
   * THE PREFLIGHT, AND IT IS EXACT.
   *
   * Checked before the single allocation below, because that allocation IS the
   * whole artifact: discovering afterwards that 300 MiB was too much would mean
   * having already held 300 MiB to find out.
   */
  const ceiling = maxStlDocumentTriangles(context.limits);
  if (totalTriangles > ceiling) {
    throw exportTooLarge(
      ExportRefusal.OutputTooLarge,
      'This document is too large to write as an STL file.',
      {
        triangles: totalTriangles,
        requires: stlDocumentByteLength(totalTriangles),
        limit: context.limits.maxOutputBytes,
        maxTriangles: ceiling,
      },
    );
  }

  const byteLength = stlDocumentByteLength(totalTriangles);
  const output = new Uint8Array(byteLength);
  const view = new DataView(output.buffer);

  for (
    let index = 0;
    index < BINARY_HEADER_TEXT.length && index < BINARY_HEADER_BYTES;
    index += 1
  ) {
    output[index] = BINARY_HEADER_TEXT.charCodeAt(index);
  }
  view.setUint32(BINARY_HEADER_BYTES, totalTriangles, true);

  let anyBaked = false;
  let anyReoriented = false;
  let anyName = false;
  let anyGroups = false;
  let anyMaterial = false;
  let sharedExpanded = false;
  const seenMesh = new Set<number>();

  let written = 0;
  /*
   * ONE SCRATCH BUFFER FOR THE WHOLE PASS, allocated here rather than per
   * triangle. A five-million-triangle conversion would otherwise make five
   * million short-lived typed arrays, which is a measurable amount of garbage
   * collection to do nothing useful with.
   */
  const corners = new Float64Array(9);

  for (const [partIndex, part] of snapshot.parts.entries()) {
    const mesh = snapshot.meshes[part.meshResourceIndex];
    if (mesh === undefined) {
      throw exportBlocked(
        ExportRefusal.MissingMeshResource,
        'A part in this document refers to geometry that is not present.',
        { partIndex },
      );
    }

    if (seenMesh.has(part.meshResourceIndex)) sharedExpanded = true;
    seenMesh.add(part.meshResourceIndex);

    if (part.name !== undefined && part.name.length > 0) anyName = true;
    if (part.materialRef !== undefined) anyMaterial = true;
    if ((mesh.groups?.length ?? 0) > 0) anyGroups = true;

    const identity = isIdentity(part.transform);
    if (!identity) anyBaked = true;
    /*
     * A PLACEMENT THAT MIRRORS THE PART TURNS EVERY TRIANGLE (Stage C03-D2). Vertices go where the placement puts them; keeping the
     * corner order as stored would leave a closed solid inside out — its normals into the material and a negative volume — so the
     * second and third corner are exchanged. The question has one answer, `placementReversesOrientation`, shared with the classifier.
     */
    const reversed = placementReversesOrientation(part.transform);
    if (reversed) anyReoriented = true;

    const { positions, indices } = mesh;

    for (let at = 0; at < indices.length; at += 3) {
      /*
       * THE CORNERS, IN THE TARGET'S OWN REPRESENTATION.
       *
       * A canonical Float32 local coordinate goes through the Float64
       * placement and is narrowed ONCE by `Math.fround` — the same single
       * narrowing `DataView.setFloat32` would perform, done here so the normal
       * below is computed from the coordinates the FILE will actually contain
       * rather than from a more precise intermediate the reader will never see.
       * A reader parsing this file and a validator predicting it therefore
       * agree bit for bit.
       */
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = (indices[at + corner] ?? 0) * 3;
        const x = positions[vertex] ?? 0;
        const y = positions[vertex + 1] ?? 0;
        const z = positions[vertex + 2] ?? 0;
        if (identity) {
          corners[corner * 3] = x;
          corners[corner * 3 + 1] = y;
          corners[corner * 3 + 2] = z;
          continue;
        }
        const [wx, wy, wz] = applyPartTransform(part.transform, x, y, z);
        corners[corner * 3] = Math.fround(wx);
        corners[corner * 3 + 1] = Math.fround(wy);
        corners[corner * 3 + 2] = Math.fround(wz);
      }

      if (reversed) {
        for (let axis = 0; axis < 3; axis += 1) {
          const second = corners[3 + axis] ?? 0;
          corners[3 + axis] = corners[6 + axis] ?? 0;
          corners[6 + axis] = second;
        }
      }

      const offset = BINARY_PREFIX_BYTES + written * BINARY_FACET_BYTES;

      /*
       * THE NORMAL IS DERIVED FROM THE TRANSFORMED TRIANGLE, never carried over.
       *
       * A stored source normal is advisory and, after a rotation, a non-uniform
       * scale or a reflection, simply wrong — a reflection reverses the facet's
       * geometric orientation, and a normal copied across would point into the
       * solid. Recomputing is the only answer that stays true under every
       * placement this format has to bake.
       *
       * A DEGENERATE TRIANGLE GETS A ZERO NORMAL, matching `triangleNormal` and
       * `stl/stl-writer.ts`. That is the honest answer: the triangle has no
       * plane, the defect stays visible to whatever reads the file, and no
       * plausible-looking direction is invented to conceal it. `NaN` would make
       * the file unreadable by other tools, which helps nobody.
       */
      const ax = corners[0] ?? 0;
      const ay = corners[1] ?? 0;
      const az = corners[2] ?? 0;
      const e1x = (corners[3] ?? 0) - ax;
      const e1y = (corners[4] ?? 0) - ay;
      const e1z = (corners[5] ?? 0) - az;
      const e2x = (corners[6] ?? 0) - ax;
      const e2y = (corners[7] ?? 0) - ay;
      const e2z = (corners[8] ?? 0) - az;

      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const usable = length > 0 && Number.isFinite(length);

      view.setFloat32(offset, usable ? nx / length : 0, true);
      view.setFloat32(offset + 4, usable ? ny / length : 0, true);
      view.setFloat32(offset + 8, usable ? nz / length : 0, true);

      for (let corner = 0; corner < 3; corner += 1) {
        const cornerOffset = offset + 12 + corner * 12;
        view.setFloat32(cornerOffset, corners[corner * 3] ?? 0, true);
        view.setFloat32(cornerOffset + 4, corners[corner * 3 + 1] ?? 0, true);
        view.setFloat32(cornerOffset + 8, corners[corner * 3 + 2] ?? 0, true);
      }

      // Attribute byte count. Vendor-specific with no portable meaning; always
      // zero, so nothing a consumer might misread as colour is emitted.
      view.setUint16(offset + 48, 0, true);

      written += 1;
      if (written % TRIANGLES_PER_BATCH === 0) {
        throwIfCancelled(context.cancellation);
        await context.yieldToEventLoop();
        throwIfCancelled(context.cancellation);
        context.progress.report(totalTriangles === 0 ? 1 : written / totalTriangles, 'writing');
      }
    }

    throwIfCancelled(context.cancellation);
  }

  context.progress.report(1, 'writing');

  /*
   * WHAT THIS CONVERSION ACTUALLY DID, as facts rather than sentences.
   *
   * Each one is conditioned on the DOCUMENT, not on the target's name: a
   * one-part identity-placed unnamed document loses nothing here and says so by
   * recording nothing. Warning about flattened parts on a document with one
   * part would be noise that teaches a user to ignore the list.
   */
  const observations: ExportObservation[] = [];
  if (snapshot.parts.length > 1) observations.push(ExportObservation.PartStructureFlattened);
  if (anyBaked) observations.push(ExportObservation.TransformsBaked);
  if (anyReoriented) observations.push(ExportObservation.MirroredPlacementReoriented);
  if (snapshot.unit !== undefined) observations.push(ExportObservation.UnitOmitted);
  if (anyName) observations.push(ExportObservation.NamesDropped);
  if (anyGroups) observations.push(ExportObservation.GroupsDropped);
  if (anyMaterial) observations.push(ExportObservation.MaterialReferencesOmitted);
  if (sharedExpanded) observations.push(ExportObservation.SharingFlattened);

  return {
    bytes: output,
    metadata: {
      formatId: MeshFormatId.Stl,
      outputBytes: output.byteLength,
      triangleCount: totalTriangles,
      partCount: snapshot.parts.length,
      meshResourceCount: snapshot.meshes.length,
      observations,
    },
  };
}
