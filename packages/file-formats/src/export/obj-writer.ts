import {
  applyPartTransform,
  IDENTITY_PART_TRANSFORM,
  placementReversesOrientation,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { throwIfCancelled } from '@cadfixer/shared';
import { MeshFormatId } from '../formats';
import { createByteSink, type ByteSink } from './byte-sink';
import type { ChunkTextWriter } from './stream-sink';
import {
  ExportObservation,
  objRoundTripName,
  snapshotTriangleCount,
  type ExportDocumentSnapshot,
  type FormatWriteDocumentContext,
  type WrittenDocument,
  type ExportMetadata,
} from './export-contract';
import { ExportRefusal, exportBlocked, exportTooLarge } from './export-errors';
import { writeFloat32Text } from './numeric';

/**
 * THE PRODUCTION OBJ WRITER.
 *
 * It serialises a WHOLE document. `o` per part, `g` per canonical group,
 * `usemtl` per material reference, `f` per triangle, in document order.
 *
 * WHAT OBJ CANNOT CARRY, and is therefore not pretended:
 *
 *   - A STRUCTURAL TRANSFORM. There is no `<item transform>` equivalent, so a
 *     placement survives only by being applied to the coordinates. Every part
 *     is baked, and the result reads back with identity transforms. Writing the
 *     local coordinates and quietly dropping the placement would move the
 *     user's geometry without saying so.
 *   - A UNIT. Nothing in an OBJ states one, so a document with a known unit
 *     loses it. The coordinates are NOT rescaled to compensate: changing the
 *     numbers to preserve a label the file cannot hold would be inventing data.
 *   - STRUCTURAL SHARING. A thousand placements of one mesh become a thousand
 *     copies of its vertices, because OBJ has no instancing. That is a real
 *     cost and it is what the output budget bounds.
 *   - MATERIAL DEFINITIONS. `usemtl` names are written as the opaque strings
 *     they are; no `mtllib` is emitted, because naming a file we do not write
 *     would point the reader at something that does not exist.
 *   - NORMALS AND TEXTURE COORDINATES. See `ExportObservation`.
 */

/** Yield every this many triangles. Matches the reader's batch. */
const TRIANGLES_PER_BATCH = 32_768;

function isIdentity(transform: PartTransform): boolean {
  for (let index = 0; index < 12; index += 1) {
    if (transform[index] !== IDENTITY_PART_TRANSFORM[index]) return false;
  }
  return true;
}

/** Where a run starts, and what it must read back as. `null`: in no group. */
type RunStart = { readonly name: string; readonly materialRef: string | undefined } | null;

/**
 * EVERY FACE AT WHICH THE READER MUST SEE A RECORD, keyed by face — Stage 6D-A4.
 *
 * OBJ has run-START records and no run-END record: a `g` or `usemtl` lasts until
 * the next one, across `o` too. So a run boundary exists on the way back in
 * only if a record is written there, and this lists all of them: each group's
 * first face, the face after a group that no other group starts at, and the
 * part's first face when it is not a group's.
 *
 * This used to be the group starts alone, and a start was written only when it
 * had a non-empty name or changed the material. A plain `solid` from an ASCII
 * STL — a group with an empty name — therefore wrote NOTHING, its boundary was
 * lost, and OBJ export of every such file was refused on parse-back; so was
 * every hole-filled grouped mesh, whose patch faces ran on into the group
 * before them.
 */
function runStarts(
  groups: readonly {
    name: string;
    indexOffset: number;
    indexCount: number;
    materialRef?: string;
  }[],
  faceCount: number,
): Map<number, RunStart> {
  const starts = new Map<number, RunStart>();
  if (faceCount > 0) starts.set(0, null);
  for (const group of groups) {
    if (group.indexCount === 0) continue;
    const first = group.indexOffset / 3;
    const end = first + group.indexCount / 3;
    const materialRef = group.materialRef === undefined ? '' : objRoundTripName(group.materialRef);
    starts.set(first, {
      name: objRoundTripName(group.name),
      materialRef: materialRef.length === 0 ? undefined : materialRef,
    });
    // Overwritten by the next group when it starts exactly here.
    if (end < faceCount && !starts.has(end)) starts.set(end, null);
  }
  return starts;
}

export async function writeObjDocument(
  snapshot: ExportDocumentSnapshot,
  context: FormatWriteDocumentContext,
): Promise<WrittenDocument> {
  const sink = createByteSink(
    context.encodeText,
    context.limits.maxOutputBytes,
    ExportRefusal.OutputTooLarge,
  );
  const metadata = await serializeObjDocument(snapshot, context, sink);
  const bytes = sink.finish();
  return { bytes, metadata: { ...metadata, outputBytes: bytes.byteLength } };
}

/** Same production formatting for both memory and file-backed storage. */
export async function serializeObjDocument(
  snapshot: ExportDocumentSnapshot,
  context: FormatWriteDocumentContext,
  sink: Pick<ByteSink, 'byteLength'> & Pick<ChunkTextWriter, 'write'>,
): Promise<ExportMetadata> {
  if (snapshot.parts.length === 0) {
    throw exportBlocked(
      ExportRefusal.NoParts,
      'This document has no parts, so there is nothing to write.',
    );
  }

  const totalTriangles = snapshotTriangleCount(snapshot);
  /*
   * A PREFLIGHT, AND ONLY A PREFLIGHT.
   *
   * Count shared vertices separately from faces. Even the shortest vertex or
   * face record needs eight bytes. Actual encoded accounting remains authoritative.
   */
  const floorBytes = snapshot.parts.reduce(
    (sum, part) => sum + ((snapshot.meshes[part.meshResourceIndex]?.positions.length ?? 0) / 3) * 8,
    totalTriangles * 8,
  );
  if (floorBytes > context.limits.maxOutputBytes) {
    throw exportTooLarge(
      ExportRefusal.OutputTooLarge,
      'This document is too large to write as an OBJ file.',
      { triangles: totalTriangles, atLeast: floorBytes, limit: context.limits.maxOutputBytes },
    );
  }

  /*
   * A FIXED HEADER. It contains no document string and never will: a newline
   * inside a comment ends it, and the next characters become records — so
   * anything user-supplied that reached a comment could write geometry into the
   * file. Every string that DOES come from the document goes through
   * `objRoundTripName`, which strips exactly that.
   */
  {
    const pendingWrite = sink.write(
      '# Written by Pybrix. Geometry only: no materials, no textures.\n',
    );
    if (pendingWrite !== undefined) await pendingWrite;
  }

  let anyBaked = false;
  let anyReoriented = false;
  let anyGroups = false;
  let anyMaterial = false;
  let anyName = false;
  let anyGeneratedName = false;
  let sharedFlattened = false;
  let partMaterialDropped = false;
  const seenMesh = new Set<number>();

  /*
   * OBJ VERTEX INDICES ARE FILE-GLOBAL AND ONE-BASED, and they only ever
   * increase. Negative relative indices are legal and our reader accepts them;
   * they are not used, because a file whose meaning depends on where the reader
   * currently is has no benefit here and one more way to be wrong.
   */
  let vertexBase = 1;
  let work = 0;
  const totalWork =
    totalTriangles +
    snapshot.parts.reduce(
      (sum, part) => sum + (snapshot.meshes[part.meshResourceIndex]?.positions.length ?? 0) / 3,
      0,
    );
  const advance = async (): Promise<void> => {
    throwIfCancelled(context.cancellation);
    await context.yieldToEventLoop();
    throwIfCancelled(context.cancellation);
    context.progress.report(totalWork === 0 ? 1 : work / totalWork, 'writing');
  };
  /*
   * THE READER'S GROUPING STATE, which is FILE-GLOBAL: `usemtl` and `g` stay in
   * force across `o`, so a part's first faces would otherwise run on in the
   * previous part's last group.
   */
  let readerMaterial: string | undefined;
  let runStarted = false;

  for (const [partIndex, part] of snapshot.parts.entries()) {
    const mesh = snapshot.meshes[part.meshResourceIndex];
    if (mesh === undefined) {
      throw exportBlocked(
        ExportRefusal.MissingMeshResource,
        'A part in this document refers to geometry that is not present.',
        { partIndex },
      );
    }
    if (seenMesh.has(part.meshResourceIndex)) sharedFlattened = true;
    seenMesh.add(part.meshResourceIndex);
    /*
     * A PART-LEVEL MATERIAL REFERENCE HAS NOWHERE TO GO. OBJ's `usemtl` applies
     * to a run of faces — a `MeshGroup` — and there is no per-object material
     * record. Recorded rather than dropped in silence.
     */
    if (part.materialRef !== undefined) partMaterialDropped = true;

    const name = part.name === undefined ? '' : objRoundTripName(part.name);
    if (name.length > 0) anyName = true;
    else anyGeneratedName = true;
    // A part with no usable name still gets an `o`: without one, two parts'
    // faces would merge into a single object on the way back in.
    {
      const pendingWrite = sink.write(
        `o ${name.length > 0 ? name : `part-${String(partIndex + 1)}`}\n`,
      );
      if (pendingWrite !== undefined) await pendingWrite;
    }

    const identity = isIdentity(part.transform);
    if (!identity) anyBaked = true;
    // A mirroring placement turns every triangle (Stage C03-D2): see `stl-document-writer.ts`. The vertex pool is untouched.
    const reversed = placementReversesOrientation(part.transform);
    if (reversed) anyReoriented = true;

    const { positions, indices } = mesh;
    for (let at = 0; at < positions.length; at += 3) {
      const x = positions[at] ?? 0;
      const y = positions[at + 1] ?? 0;
      const z = positions[at + 2] ?? 0;

      if (identity) {
        {
          const pendingWrite = sink.write(
            `v ${writeFloat32Text(x)} ${writeFloat32Text(y)} ${writeFloat32Text(z)}\n`,
          );
          if (pendingWrite !== undefined) await pendingWrite;
        }
        work += 1;
        if (work % TRIANGLES_PER_BATCH === 0) await advance();
        continue;
      }

      /*
       * BAKED IN FLOAT64, THEN NARROWED ONCE.
       *
       * `applyPartTransform` works in Float64 because the placement is Float64;
       * `Math.fround` is then the SAME single narrowing that assigning to a
       * Float32Array performs, which is what the reader will do to the decimal
       * text below. Emitting nine significant digits of the already-narrowed
       * value is what makes the round trip bit-exact rather than approximately
       * right.
       *
       * Nothing here touches the snapshot's arrays: baking is a property of the
       * OUTPUT, and the authoritative mesh is not even in this worker.
       */
      const [wx, wy, wz] = applyPartTransform(part.transform, x, y, z);
      {
        const pendingWrite = sink.write(
          `v ${writeFloat32Text(Math.fround(wx))} ${writeFloat32Text(Math.fround(wy))} ${writeFloat32Text(Math.fround(wz))}\n`,
        );
        if (pendingWrite !== undefined) await pendingWrite;
      }
      work += 1;
      if (work % TRIANGLES_PER_BATCH === 0) await advance();
    }

    const starts = runStarts(mesh.groups ?? [], indices.length / 3);

    for (let at = 0; at < indices.length; at += 3) {
      const face = at / 3;
      const run = starts.get(face);
      /*
       * A RECORD IS WRITTEN ONLY WHERE THE READER NEEDS ONE. Faces in no group
       * before any run has started in the FILE are already in no group, so the
       * part-start `null` is skipped then — a document with no groups at all
       * writes no `g` and no `usemtl`, exactly as before.
       */
      if (run !== undefined && (run !== null || runStarted)) {
        /*
         * `usemtl` FIRST, THEN `g`, and the order is load-bearing.
         *
         * OBJ treats them as two different axes: `usemtl` sets the material in
         * force, `g` names the run of faces. Our `MeshGroup` flattens both into
         * one record, so on the way back in a reader sees two run-starts at the
         * same face and keeps the LAST, and names a `usemtl` run after its
         * material. So `usemtl` is written when the material in force must
         * change — bare, to clear it — and `g` is then written unless the
         * `usemtl` alone already reads back as the name wanted. A run in no
         * group reads back as an empty name with no material: OBJ has no way to
         * say "no group" once a run has started.
         */
        const wantName = run?.name ?? '';
        const wantMaterial = run?.materialRef;
        let readsBackAs: string | undefined;
        if (wantMaterial !== readerMaterial) {
          {
            const pendingWrite = sink.write(
              wantMaterial === undefined ? 'usemtl\n' : `usemtl ${wantMaterial}\n`,
            );
            if (pendingWrite !== undefined) await pendingWrite;
          }
          readerMaterial = wantMaterial;
          readsBackAs = wantMaterial ?? '';
          if (wantMaterial !== undefined) anyMaterial = true;
        }
        if (readsBackAs !== wantName) {
          {
            const pendingWrite = sink.write(wantName.length > 0 ? `g ${wantName}\n` : 'g\n');
            if (pendingWrite !== undefined) await pendingWrite;
          }
        }
        if (run !== null) anyGroups = true;
        runStarted = true;
      }

      const a = vertexBase + (indices[at] ?? 0);
      const b = vertexBase + (indices[at + (reversed ? 2 : 1)] ?? 0);
      const c = vertexBase + (indices[at + (reversed ? 1 : 2)] ?? 0);
      {
        const pendingWrite = sink.write(`f ${String(a)} ${String(b)} ${String(c)}\n`);
        if (pendingWrite !== undefined) await pendingWrite;
      }

      work += 1;
      if (work % TRIANGLES_PER_BATCH === 0) await advance();
    }

    vertexBase += positions.length / 3;
    throwIfCancelled(context.cancellation);
  }

  const observations: ExportObservation[] = [
    ExportObservation.NormalsOmitted,
    ExportObservation.TextureCoordinatesOmitted,
  ];
  if (anyBaked) observations.push(ExportObservation.TransformsBaked);
  if (anyReoriented) observations.push(ExportObservation.MirroredPlacementReoriented);
  if (snapshot.unit !== undefined) observations.push(ExportObservation.UnitOmitted);
  if (sharedFlattened) observations.push(ExportObservation.SharingFlattened);
  if (anyName) observations.push(ExportObservation.NamesPreserved);
  if (anyGeneratedName) observations.push(ExportObservation.NamesGenerated);
  if (anyGroups || anyMaterial) {
    observations.push(ExportObservation.MaterialLibraryOmitted);
  }
  if (anyMaterial) observations.push(ExportObservation.MaterialReferencesPreserved);
  if (partMaterialDropped) observations.push(ExportObservation.MaterialReferencesOmitted);

  return {
    formatId: MeshFormatId.Obj,
    outputBytes: sink.byteLength,
    triangleCount: totalTriangles,
    partCount: snapshot.parts.length,
    meshResourceCount: snapshot.meshes.length,
    observations,
  };
}
