import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
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
): CanonicalMesh {
  const faces = Math.floor(source.indices.length / 3);
  let kept = 0;
  for (let f = 0; f < faces; f += 1) if (keep(f)) kept += 1;
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices = createIndexArray(kept * 3);
  let w = 0;
  for (let f = 0; f < faces; f += 1) {
    if (!keep(f)) continue;
    for (let k = 0; k < 3; k += 1) {
      const v = source.indices[f * 3 + k] ?? 0;
      let id = remap.get(v);
      if (id === undefined) {
        id = positions.length / 3;
        remap.set(v, id);
        positions.push(
          source.positions[v * 3] ?? 0,
          source.positions[v * 3 + 1] ?? 0,
          source.positions[v * 3 + 2] ?? 0,
        );
      }
      indices[w] = id;
      w += 1;
    }
  }
  const out = createPositionArray(positions.length);
  out.set(positions);
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
): ComponentPieces {
  const chosen = new Set(ranks.filter((r) => Number.isInteger(r) && r >= 0 && r < labelling.count));
  if (chosen.size === 0) throw new Error('No component is selected.');
  if (chosen.size >= labelling.count)
    throw new Error('The selection is the whole model: nothing would be left.');
  const selected = extractFaces(source, (f) => chosen.has(labelling.faceRank[f] ?? -1));
  const rest = extractFaces(source, (f) => !chosen.has(labelling.faceRank[f] ?? -1));
  return {
    selected,
    rest,
    selectedFaces: Math.floor(selected.indices.length / 3),
    restFaces: Math.floor(rest.indices.length / 3),
  };
}
