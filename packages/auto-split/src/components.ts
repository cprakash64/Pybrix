import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseComponents,
  buildDirectedEdges,
  buildTopologicalGeometry,
  groupEdges,
  recoverVertexIdentity,
} from '@cadfixer/mesh-topology';
import type { Vec3 } from '@cadfixer/auto-split-contract';
import { CHECKPOINT_STRIDE, NO_CHECKPOINT, type Checkpoint } from './checkpoint';
import type { FaceFacts, NormalizedGeometry } from './geometry';

/**
 * THE PART'S CONNECTED COMPONENTS, ranked.
 *
 * A component is a set of faces joined through shared edges, on vertices identified by their EXACT
 * stored coordinates and nothing else: no tolerance, nothing welded that the file did not already
 * make identical. The ranking is by surface area, largest first, ties to the lower first face, so a
 * rank is a fact about the geometry and not about the run.
 */
export interface ComponentLabelling {
  /** Rank of the component every face belongs to. */
  readonly faceRank: Int32Array;
  readonly count: number;
}

export function labelComponents(
  mesh: CanonicalMesh,
  facts: FaceFacts,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): ComponentLabelling {
  const faceCount = Math.floor(mesh.indices.length / 3);
  // Each topology primitive already reports between batches; a batch is a few milliseconds, so the
  // checkpoint is read at each of those boundaries and a cancel is seen between them.
  const poll = (): void => {
    checkpoint();
  };
  const geometry = buildTopologicalGeometry(mesh, recoverVertexIdentity(mesh, { onBatch: poll }));
  checkpoint();
  const edges = buildDirectedEdges(geometry.triangles, faceCount, poll);
  const groups = groupEdges(edges, poll);
  const { faceComponent, componentCount } = analyseComponents(edges, groups, faceCount, poll);
  checkpoint();
  const area = new Float64Array(componentCount);
  const first = new Int32Array(componentCount).fill(-1);
  for (let start = 0; start < faceCount; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(faceCount, start + CHECKPOINT_STRIDE);
    for (let f = start; f < end; f += 1) {
      const c = faceComponent[f] ?? 0;
      area[c] = (area[c] ?? 0) + (facts.areas[f] ?? 0);
      if ((first[c] ?? -1) < 0) first[c] = f;
    }
  }
  // Largest surface first, ties to the lower first face: a TOTAL order (no two components share a
  // first face), so the ranking is the same whichever sort runs. Typed, so a model of many shells
  // holds four bytes a component here rather than a boxed number.
  const order = new Uint32Array(componentCount);
  for (let i = 0; i < componentCount; i += 1) order[i] = i;
  order.sort((a, b) => (area[b] ?? 0) - (area[a] ?? 0) || (first[a] ?? 0) - (first[b] ?? 0));
  checkpoint();
  const rankOf = new Int32Array(componentCount);
  for (let rank = 0; rank < componentCount; rank += 1) rankOf[order[rank] ?? 0] = rank;
  const faceRank = new Int32Array(faceCount);
  for (let f = 0; f < faceCount; f += 1) faceRank[f] = rankOf[faceComponent[f] ?? 0] ?? 0;
  return { faceRank, count: componentCount };
}

export interface ComponentFacts {
  readonly rank: number;
  readonly faces: number;
  readonly area: number;
  readonly areaShare: number;
  /** Bounds of the component's face centroids, normalized. */
  readonly lo: Vec3;
  readonly hi: Vec3;
  /** The area-weighted centroid, normalized. */
  readonly centroid: Vec3;
  readonly diagonal: number;
}

export function componentFacts(
  labelling: ComponentLabelling,
  facts: FaceFacts,
  geometry: NormalizedGeometry,
): ComponentFacts[] {
  const n = labelling.count;
  const faces = new Int32Array(n);
  const area = new Float64Array(n);
  const lo = new Float64Array(n * 3).fill(Infinity);
  const hi = new Float64Array(n * 3).fill(-Infinity);
  const sum = new Float64Array(n * 3);
  for (let f = 0; f < geometry.faceCount; f += 1) {
    const r = labelling.faceRank[f] ?? 0;
    const a = facts.areas[f] ?? 0;
    faces[r] = (faces[r] ?? 0) + 1;
    area[r] = (area[r] ?? 0) + a;
    for (let k = 0; k < 3; k += 1) {
      const v = facts.centroids[f * 3 + k] ?? 0;
      if (v < (lo[r * 3 + k] ?? Infinity)) lo[r * 3 + k] = v;
      if (v > (hi[r * 3 + k] ?? -Infinity)) hi[r * 3 + k] = v;
      sum[r * 3 + k] = (sum[r * 3 + k] ?? 0) + a * v;
    }
  }
  return Array.from({ length: n }, (_, rank): ComponentFacts => {
    const l: Vec3 = [lo[rank * 3] ?? 0, lo[rank * 3 + 1] ?? 0, lo[rank * 3 + 2] ?? 0];
    const h: Vec3 = [hi[rank * 3] ?? 0, hi[rank * 3 + 1] ?? 0, hi[rank * 3 + 2] ?? 0];
    const a = area[rank] ?? 0;
    return {
      rank,
      faces: faces[rank] ?? 0,
      area: a,
      areaShare: facts.totalArea > 0 ? a / facts.totalArea : 0,
      lo: l,
      hi: h,
      centroid:
        a > 0
          ? [(sum[rank * 3] ?? 0) / a, (sum[rank * 3 + 1] ?? 0) / a, (sum[rank * 3 + 2] ?? 0) / a]
          : [(l[0] + h[0]) / 2, (l[1] + h[1]) / 2, (l[2] + h[2]) / 2],
      diagonal: Math.hypot(h[0] - l[0], h[1] - l[1], h[2] - l[2]),
    };
  });
}
