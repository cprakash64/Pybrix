import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseComponents,
  buildDirectedEdges,
  buildTopologicalGeometry,
  groupEdges,
  recoverVertexIdentity,
} from '@cadfixer/mesh-topology';
import type { Vec3 } from '@cadfixer/auto-split-contract';
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

export function labelComponents(mesh: CanonicalMesh, facts: FaceFacts): ComponentLabelling {
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
