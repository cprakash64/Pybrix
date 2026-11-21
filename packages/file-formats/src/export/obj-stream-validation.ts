import {
  applyPartTransform,
  IDENTITY_PART_TRANSFORM,
  placementReversesOrientation,
  type MeshGroup,
} from '@cadfixer/mesh-core';
import type { FormatReadContext } from '../context';
import { DEFAULT_OBJ_LIMITS } from '../obj/limits';
import { readObjRecordStream } from '../obj/obj-records';
import {
  expectedObjGroups,
  objRoundTripName,
  type ExportDocumentSnapshot,
} from './export-contract';
import { ExportRefusal, exportInternal } from './export-errors';

/** Independent production-record read-back: every vertex, corner and group is
 * checked against the source contract without reconstructed geometry arrays. */
export async function validateObjRecordStream(
  snapshot: ExportDocumentSnapshot,
  pieces: AsyncIterable<string>,
  context: FormatReadContext,
): Promise<void> {
  const fail = (): never => {
    throw exportInternal(
      ExportRefusal.ValidationFailed,
      'The OBJ did not preserve the expected geometry, so the export was refused.',
    );
  };
  let partIndex = -1;
  let vertex = 0;
  let face = 0;
  let vertexBase = 0;
  let faceBase = 0;
  let groups: readonly MeshGroup[] = [];
  let groupIndex = 0;
  const runs = { started: false };
  let group: { name: string; material: string | undefined; firstFace: number } | undefined;
  let active:
    | {
        part: ExportDocumentSnapshot['parts'][number];
        mesh: ExportDocumentSnapshot['meshes'][number];
        identity: boolean;
        reversed: boolean;
      }
    | undefined;
  const current = (): {
    part: ExportDocumentSnapshot['parts'][number];
    mesh: ExportDocumentSnapshot['meshes'][number];
  } => {
    if (active === undefined) return fail();
    return active;
  };
  const endPart = (): void => {
    if (partIndex < 0) return;
    const { mesh } = current();
    if (face === 0 || vertex * 3 !== mesh.positions.length || face * 3 !== mesh.indices.length)
      fail();
    vertexBase += vertex;
    faceBase += face;
  };
  await readObjRecordStream(pieces, DEFAULT_OBJ_LIMITS, context, {
    object(name, firstFace): void {
      endPart();
      partIndex += 1;
      vertex = 0;
      face = 0;
      groupIndex = 0;
      const part = snapshot.parts[partIndex];
      const mesh = part === undefined ? undefined : snapshot.meshes[part.meshResourceIndex];
      if (part === undefined || mesh === undefined) return fail();
      active = {
        part,
        mesh,
        identity: part.transform.every((value, index) => value === IDENTITY_PART_TRANSFORM[index]),
        reversed: placementReversesOrientation(part.transform),
      };
      const sourceName = part.name === undefined ? '' : objRoundTripName(part.name);
      if (name !== (sourceName || `part-${String(partIndex + 1)}`) || firstFace !== faceBase)
        fail();
      groups = expectedObjGroups(mesh.groups, mesh.indices.length / 3, runs).groups ?? [];
    },
    vertex(x, y, z): void {
      const { part, mesh } = current();
      if (face !== 0 || vertex * 3 >= mesh.positions.length) fail();
      const at = vertex * 3;
      const sx = mesh.positions[at] ?? 0;
      const sy = mesh.positions[at + 1] ?? 0;
      const sz = mesh.positions[at + 2] ?? 0;
      // Cache the identity test once per object; avoid six million temporary
      // tuples and per-vertex callbacks for an imported STL triangle soup.
      const values = active?.identity ? undefined : applyPartTransform(part.transform, sx, sy, sz);
      if (
        !Object.is(Math.fround(x), Math.fround(values?.[0] ?? sx)) ||
        !Object.is(Math.fround(y), Math.fround(values?.[1] ?? sy)) ||
        !Object.is(Math.fround(z), Math.fround(values?.[2] ?? sz))
      )
        fail();
      vertex += 1;
    },
    face(a, b, c): void {
      const { mesh } = current();
      const at = face * 3;
      // A mirroring placement exchanges the second and third corner of every face (Stage C03-D2).
      const second = active?.reversed === true ? 2 : 1;
      const third = active?.reversed === true ? 1 : 2;
      if (
        vertex * 3 !== mesh.positions.length ||
        at >= mesh.indices.length ||
        a !== vertexBase + (mesh.indices[at] ?? -1) ||
        b !== vertexBase + (mesh.indices[at + second] ?? -1) ||
        c !== vertexBase + (mesh.indices[at + third] ?? -1)
      )
        fail();
      let candidate = groups[groupIndex];
      while (candidate !== undefined && candidate.indexOffset + candidate.indexCount <= at) {
        groupIndex += 1;
        candidate = groups[groupIndex];
      }
      const wanted = groups[groupIndex];
      const belongs = wanted !== undefined && at >= wanted.indexOffset;
      if (
        belongs
          ? group?.name !== wanted.name ||
            group.material !== wanted.materialRef ||
            group.firstFace !== faceBase + wanted.indexOffset / 3
          : group !== undefined
      )
        fail();
      face += 1;
    },
    group(name, material, firstFace): void {
      group = { name, material, firstFace };
    },
    materialUse: (): void => undefined,
    materialLibrary(): void {
      fail();
    },
  });
  endPart();
  if (partIndex + 1 !== snapshot.parts.length) fail();
}
