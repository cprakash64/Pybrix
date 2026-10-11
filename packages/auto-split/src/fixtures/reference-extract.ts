import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseComponents,
  buildDirectedEdges,
  buildTopologicalGeometry,
  groupEdges,
  recoverVertexIdentity,
} from '@cadfixer/mesh-topology';
import type { ComponentLabelling } from '../components';
import type { FaceFacts } from '../geometry';

/**
 * THE PRE-OPTIMISATION COMPONENT LABELLING AND EXTRACTION, FROZEN.
 *
 * `extractFaces`, `componentPieces` and `labelComponents` as they stood at 5272c59: a JavaScript `Map`
 * of boxed numbers and a growing `number[]` for the renumbering, a `Set` for the chosen ranks and a
 * boxed `Array.from(...).sort(...)` for the ranking. The live versions hold typed arrays instead
 * (AUTO-SPLIT-LARGE-MESH-02); this copy exists ONLY so a test can hold them to it, face for face and
 * byte for byte, and so the memory benchmark can measure the two side by side. Never imported by
 * production code, and never to be "improved".
 */
export function referenceExtractFaces(
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

export interface ReferenceComponentPieces {
  readonly selected: CanonicalMesh;
  readonly rest: CanonicalMesh;
  readonly selectedFaces: number;
  readonly restFaces: number;
}

export function referenceComponentPieces(
  source: CanonicalMesh,
  labelling: ComponentLabelling,
  ranks: readonly number[],
): ReferenceComponentPieces {
  const chosen = new Set(ranks.filter((r) => Number.isInteger(r) && r >= 0 && r < labelling.count));
  if (chosen.size === 0) throw new Error('No component is selected.');
  if (chosen.size >= labelling.count)
    throw new Error('The selection is the whole model: nothing would be left.');
  const selected = referenceExtractFaces(source, (f) => chosen.has(labelling.faceRank[f] ?? -1));
  const rest = referenceExtractFaces(source, (f) => !chosen.has(labelling.faceRank[f] ?? -1));
  return {
    selected,
    rest,
    selectedFaces: Math.floor(selected.indices.length / 3),
    restFaces: Math.floor(rest.indices.length / 3),
  };
}

export function referenceLabelComponents(
  mesh: CanonicalMesh,
  facts: FaceFacts,
): ComponentLabelling {
  const faceCount = Math.floor(mesh.indices.length / 3);
  const geometry = buildTopologicalGeometry(mesh, recoverVertexIdentity(mesh));
  const edges = buildDirectedEdges(geometry.triangles, faceCount);
  const groups = groupEdges(edges);
  const { faceComponent, componentCount } = analyseComponents(edges, groups, faceCount);
  const area = new Float64Array(componentCount);
  const first = new Int32Array(componentCount).fill(-1);
  for (let f = 0; f < faceCount; f += 1) {
    const c = faceComponent[f] ?? 0;
    area[c] = (area[c] ?? 0) + (facts.areas[f] ?? 0);
    if ((first[c] ?? -1) < 0) first[c] = f;
  }
  const order = Array.from({ length: componentCount }, (_, i) => i).sort(
    (a, b) => (area[b] ?? 0) - (area[a] ?? 0) || (first[a] ?? 0) - (first[b] ?? 0),
  );
  const rankOf = new Int32Array(componentCount);
  order.forEach((component, rank) => {
    rankOf[component] = rank;
  });
  const faceRank = new Int32Array(faceCount);
  for (let f = 0; f < faceCount; f += 1) faceRank[f] = rankOf[faceComponent[f] ?? 0] ?? 0;
  return { faceRank, count: componentCount };
}
