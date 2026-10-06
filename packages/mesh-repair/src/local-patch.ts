import { createIndexArray, createPositionArray, vertexCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { rebuildCandidate, type RebuildProgress } from './rebuild';

/**
 * APPLIES A LOCAL REPAIR PATCH TO A MESH — REPAIR-CORE-06A.
 *
 * The local repair runs in a disposable kernel worker on a COPY of the mesh and sends back a
 * description of what it changed, in the SOURCE'S OWN SLOT SPACE: which source faces are gone,
 * which survive with reversed winding, and the faces and vertices it appended. This function turns
 * that description into the candidate, and it does so with the SAME rebuild every other repair
 * uses, so every representation rule carries over unchanged:
 *
 *   - surviving faces keep their ORIGINAL index triplets, in source face order;
 *   - retained vertices keep their exact Float32 bytes, nothing is welded, and only vertices no
 *     face references any longer are dropped, renumbered in ascending original order;
 *   - groups address faces by offset and are rebuilt for the removals; appended faces join no
 *     group, because they are geometry the file never carried;
 *   - a flip reorders corners and never touches a coordinate.
 *
 * The appended faces and vertices are placed after the source's, so the rebuild treats them as
 * ordinary faces that nothing removes: they are never in the removal mask and are never flipped
 * here (they arrive already in their final winding).
 *
 * THE CALLER VALIDATES. This builds a candidate; it decides nothing. The repair handler runs the
 * structural check and the independent topology re-analysis on the result before registering it.
 */
export interface LocalRepairPatchInput {
  readonly removedSourceFaces: Uint32Array;
  readonly flippedSourceFaces: Uint32Array;
  /** x, y, z of appended vertices; vertex i occupies slot `vertexCount(mesh) + i`. */
  readonly appendedPositions: Float32Array;
  /** Three corner slots per appended face, in their final winding. */
  readonly appendedFaces: Uint32Array;
}

export interface LocalPatchCandidate {
  readonly mesh: CanonicalMesh;
  /** Source face index per SURVIVING face, in candidate order (the candidate's prefix). */
  readonly candidateToSourceFace: Uint32Array;
  readonly removedSourceFaces: Uint32Array;
  readonly flippedSourceFaces: Uint32Array;
  /** Faces appended after the survivors. */
  readonly appendedFaceCount: number;
}

export function applyLocalRepairPatch(
  mesh: CanonicalMesh,
  patch: LocalRepairPatchInput,
  progress: RebuildProgress = {},
): LocalPatchCandidate {
  const sourceFaceCount = Math.floor(mesh.indices.length / 3);
  const sourceSlots = vertexCount(mesh);
  const appendedFaceCount = Math.floor(patch.appendedFaces.length / 3);
  const appendedVertexCount = Math.floor(patch.appendedPositions.length / 3);
  const totalFaces = sourceFaceCount + appendedFaceCount;

  const positions = createPositionArray((sourceSlots + appendedVertexCount) * 3);
  positions.set(mesh.positions.subarray(0, sourceSlots * 3), 0);
  positions.set(patch.appendedPositions, sourceSlots * 3);
  const indices = createIndexArray(totalFaces * 3);
  indices.set(mesh.indices.subarray(0, sourceFaceCount * 3), 0);
  indices.set(patch.appendedFaces, sourceFaceCount * 3);

  const removeMask = new Uint8Array(totalFaces);
  for (const f of patch.removedSourceFaces) removeMask[f] = 1;
  const flipMask = new Uint8Array(totalFaces);
  for (const f of patch.flippedSourceFaces) flipMask[f] = 1;

  const augmented: CanonicalMesh = {
    positions,
    indices,
    ...(mesh.groups === undefined ? {} : { groups: mesh.groups }),
    metadata: mesh.metadata,
  };
  const rebuilt = rebuildCandidate(augmented, totalFaces, removeMask, flipMask, progress);
  const survivors = rebuilt.mesh.indices.length / 3 - appendedFaceCount;
  return {
    mesh: rebuilt.mesh,
    candidateToSourceFace: rebuilt.candidateToSourceFace.slice(0, survivors),
    removedSourceFaces: rebuilt.removedSourceFaces,
    flippedSourceFaces: rebuilt.flippedSourceFaces,
    appendedFaceCount,
  };
}
