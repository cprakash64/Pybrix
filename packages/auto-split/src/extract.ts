import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { CHECKPOINT_STRIDE, NO_CHECKPOINT, type Checkpoint } from './checkpoint';
import type { ComponentLabelling } from './components';

/**
 * COMPONENT EXTRACTION AS A PREVIEW.
 *
 * Splitting a part by its components needs no cut: it is a face subset. The selected piece is the
 * faces whose component is selected, in source order, over the source's own vertices renumbered by
 * first use; the other piece is everything else, built the same way. Nothing is welded, moved,
 * reoriented or re-coloured, and the source is never written. Both pieces are validated by the caller
 * exactly as a plane cut's pieces are, before anything may be applied.
 */
export function extractFaces(
  source: CanonicalMesh,
  keep: (face: number) => boolean,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): CanonicalMesh {
  const faces = Math.floor(source.indices.length / 3);
  const mask = new Uint8Array(faces);
  let kept = 0;
  for (let start = 0; start < faces; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(faces, start + CHECKPOINT_STRIDE);
    for (let f = start; f < end; f += 1) {
      if (keep(f)) {
        mask[f] = 1;
        kept += 1;
      }
    }
  }
  return extractMasked(source, mask, kept, checkpoint);
}

/**
 * The faces whose `mask` byte is 1, in source order, over the source's own vertices renumbered by
 * first use (the first corner of the first kept face is vertex 0).
 *
 * BOUNDED TYPED STATE. The renumbering is one Int32Array of four bytes per SOURCE vertex plus one of
 * four bytes per USED vertex, replacing a JavaScript `Map` of boxed numbers and a growing `number[]`
 * of positions: at two million triangles the Map and the array held roughly 700 MB of heap, the
 * typed pair holds about 12 bytes a vertex and no per-vertex object. The numbering, the order of the
 * faces and every coordinate are the ones the `Map` version produced; a test holds the two equal.
 */
function extractMasked(
  source: CanonicalMesh,
  mask: Uint8Array,
  kept: number,
  checkpoint: Checkpoint,
): CanonicalMesh {
  const faces = mask.length;
  const sourceVertices = Math.floor(source.positions.length / 3);
  // New id of a source vertex, or -1 until the first kept face uses it.
  const remap = new Int32Array(sourceVertices).fill(-1);
  // The source vertex each new id came from, in new-id order. At most one per kept corner.
  const origin = new Int32Array(Math.min(kept * 3, sourceVertices));
  const indices = createIndexArray(kept * 3);
  let used = 0;
  let w = 0;
  for (let start = 0; start < faces; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(faces, start + CHECKPOINT_STRIDE);
    for (let f = start; f < end; f += 1) {
      if (mask[f] !== 1) continue;
      for (let k = 0; k < 3; k += 1) {
        const v = source.indices[f * 3 + k] ?? 0;
        let id = remap[v] ?? -1;
        if (id < 0) {
          id = used;
          remap[v] = id;
          origin[used] = v;
          used += 1;
        }
        indices[w] = id;
        w += 1;
      }
    }
  }
  const out = createPositionArray(used * 3);
  for (let id = 0; id < used; id += 1) {
    const v = origin[id] ?? 0;
    out[id * 3] = source.positions[v * 3] ?? 0;
    out[id * 3 + 1] = source.positions[v * 3 + 1] ?? 0;
    out[id * 3 + 2] = source.positions[v * 3 + 2] ?? 0;
  }
  return { positions: out, indices, metadata: {} };
}

export interface ComponentPieces {
  readonly selected: CanonicalMesh;
  readonly rest: CanonicalMesh;
  readonly selectedFaces: number;
  readonly restFaces: number;
}

/** The two pieces for a set of component ranks. Throws a plain Error naming the problem when the set is empty or everything. */
export function componentPieces(
  source: CanonicalMesh,
  labelling: ComponentLabelling,
  ranks: readonly number[],
  checkpoint: Checkpoint = NO_CHECKPOINT,
): ComponentPieces {
  const chosen = new Uint8Array(labelling.count);
  let chosenCount = 0;
  for (const r of ranks)
    if (Number.isInteger(r) && r >= 0 && r < labelling.count && chosen[r] !== 1) {
      chosen[r] = 1;
      chosenCount += 1;
    }
  if (chosenCount === 0) throw new Error('No component is selected.');
  if (chosenCount >= labelling.count)
    throw new Error('The selection is the whole model: nothing would be left.');
  const faces = Math.floor(source.indices.length / 3);
  const inSelection = new Uint8Array(faces);
  let selectedCount = 0;
  for (let start = 0; start < faces; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(faces, start + CHECKPOINT_STRIDE);
    for (let f = start; f < end; f += 1) {
      if (chosen[labelling.faceRank[f] ?? -1] === 1) {
        inSelection[f] = 1;
        selectedCount += 1;
      }
    }
  }
  const selected = extractMasked(source, inSelection, selectedCount, checkpoint);
  // The rest is the same mask inverted, in place: one byte a face for both pieces.
  for (let f = 0; f < faces; f += 1) inSelection[f] = inSelection[f] === 1 ? 0 : 1;
  const rest = extractMasked(source, inSelection, faces - selectedCount, checkpoint);
  return {
    selected,
    rest,
    selectedFaces: Math.floor(selected.indices.length / 3),
    restFaces: Math.floor(rest.indices.length / 3),
  };
}
