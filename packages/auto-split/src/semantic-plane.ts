import type { SemanticPart, Vec3 } from '@cadfixer/auto-split-contract';
import type { NormalizedGeometry } from './geometry';
import { CHECKPOINT_MASK, type Checkpoint } from './checkpoint';

/** Read-only local refinement, independent of either qualified splitter. Never creates a face/cap. */
export const SEMANTIC_PLANE_REFINEMENT_LIMITS = Object.freeze({
  samples: 9,
  band: 0.025,
  minimumImprovement: 0.1,
  groups: 8,
});
export interface SemanticPlaneRefinement {
  readonly cut: NonNullable<SemanticPart['cut']>;
  readonly proposedOffset: number;
  readonly chosenOffset: number;
  readonly proposedSectionLength: number;
  readonly chosenSectionLength: number;
  readonly samples: number;
  readonly profileNormal: Vec3;
  readonly sectionProfile: readonly { readonly offset: number; readonly length: number }[];
}
interface PlaneGroup {
  readonly normal: Vec3;
  readonly offset: number;
  readonly parts: SemanticPart[];
  readonly lengths: Float64Array;
}
/** Shared complementary planes refine together, so sibling assembly suggestions remain complementary. */
export function refineSemanticPlanes(
  geometry: NormalizedGeometry,
  parts: readonly SemanticPart[],
  checkpoint: Checkpoint,
): {
  refinements: ReadonlyMap<string, SemanticPlaneRefinement>;
  triangleVisits: number;
  milliseconds: number;
} {
  const started = Date.now(),
    groups = new Map<string, PlaneGroup>();
  for (const part of parts) {
    if (
      !part.cut ||
      part.importance !== 'major' ||
      !part.expectedGeometry.likelySeparable ||
      part.expectedGeometry.kind === 'surface_part'
    )
      continue;
    const magnitude = Math.hypot(...part.cut.normal),
      unit = part.cut.normal.map((n) => n / magnitude) as unknown as Vec3;
    const leading = unit.find((n) => Math.abs(n) > 1e-8) ?? 1,
      normal = unit.map((n) => (leading < 0 ? -n : n)) as unknown as Vec3;
    const offset = normal.reduce((sum, n, a) => sum + n * (part.cut?.origin[a] ?? 0), 0),
      key = [...normal, offset].map((n) => n.toFixed(8)).join('/');
    const group = groups.get(key);
    if (group) group.parts.push(part);
    else groups.set(key, { normal, offset, parts: [part], lengths: new Float64Array(9) });
  }
  // Schema bounds major parts at eight; no unbounded face × proposed-plane work.
  if (groups.size > SEMANTIC_PLANE_REFINEMENT_LIMITS.groups)
    throw new Error('Semantic plane refinement exceeds its structural bound.');
  if (groups.size === 0)
    return { refinements: new Map(), triangleVisits: 0, milliseconds: Date.now() - started };
  const vertices = new Int32Array(3),
    distances = new Float64Array(3),
    positions = geometry.positions;
  let triangleVisits = 0;
  for (let f = 0; f < geometry.faceCount; f++) {
    if ((f & CHECKPOINT_MASK) === 0) checkpoint();
    for (let k = 0; k < 3; k++) vertices[k] = (geometry.indices[f * 3 + k] ?? 0) * 3;
    for (const group of groups.values()) {
      triangleVisits++;
      for (let k = 0; k < 3; k++) {
        const v = vertices[k] ?? 0;
        distances[k] =
          (positions[v] ?? 0) * group.normal[0] +
          (positions[v + 1] ?? 0) * group.normal[1] +
          (positions[v + 2] ?? 0) * group.normal[2] -
          group.offset;
      }
      const minimum = Math.min(...distances),
        maximum = Math.max(...distances);
      if (
        minimum > SEMANTIC_PLANE_REFINEMENT_LIMITS.band ||
        maximum < -SEMANTIC_PLANE_REFINEMENT_LIMITS.band
      )
        continue;
      for (let sample = 0; sample < 9; sample++) {
        const delta = ((sample - 4) * SEMANTIC_PLANE_REFINEMENT_LIMITS.band) / 4;
        if (minimum >= delta || maximum <= delta) continue;
        let intersections = 0,
          x0 = 0,
          y0 = 0,
          z0 = 0;
        for (let edge = 0; edge < 3; edge++) {
          const next = (edge + 1) % 3,
            a = (distances[edge] ?? 0) - delta,
            b = (distances[next] ?? 0) - delta;
          if (a >= 0 === b >= 0) continue;
          const va = vertices[edge] ?? 0,
            vb = vertices[next] ?? 0,
            t = a / (a - b);
          const x = (positions[va] ?? 0) + t * ((positions[vb] ?? 0) - (positions[va] ?? 0)),
            y =
              (positions[va + 1] ?? 0) + t * ((positions[vb + 1] ?? 0) - (positions[va + 1] ?? 0)),
            z =
              (positions[va + 2] ?? 0) + t * ((positions[vb + 2] ?? 0) - (positions[va + 2] ?? 0));
          if (intersections++ === 0) {
            x0 = x;
            y0 = y;
            z0 = z;
          } else {
            group.lengths[sample] =
              (group.lengths[sample] ?? 0) + Math.hypot(x - x0, y - y0, z - z0);
            break;
          }
        }
      }
    }
  }
  const refinements = new Map<string, SemanticPlaneRefinement>();
  for (const group of groups.values()) {
    let best = 4;
    const original = group.lengths[4] ?? 0;
    for (let i = 0; i < 9; i++) {
      const score = group.lengths[i] ?? 0,
        current = group.lengths[best] ?? 0;
      // A zero intersection is not an empty-model "improvement"; preserve the proposed plane in doubt.
      if (score <= 0) continue;
      if (
        score < current - 1e-8 ||
        (Math.abs(score - current) < 1e-8 && Math.abs(i - 4) < Math.abs(best - 4))
      )
        best = i;
    }
    if (
      original <= 0 ||
      (group.lengths[best] ?? 0) >
        original * (1 - SEMANTIC_PLANE_REFINEMENT_LIMITS.minimumImprovement)
    )
      best = 4;
    const delta = ((best - 4) * SEMANTIC_PLANE_REFINEMENT_LIMITS.band) / 4;
    for (const part of group.parts)
      if (part.cut)
        refinements.set(part.id, {
          cut: {
            normal: part.cut.normal,
            origin: part.cut.origin.map(
              (n, a) => n + delta * (group.normal[a] ?? 0),
            ) as unknown as Vec3,
          },
          proposedOffset: group.offset,
          chosenOffset: group.offset + delta,
          proposedSectionLength: original,
          chosenSectionLength: group.lengths[best] ?? 0,
          samples: 9,
          profileNormal: group.normal,
          sectionProfile: Array.from(group.lengths, (length, i) => ({
            offset: group.offset + ((i - 4) * SEMANTIC_PLANE_REFINEMENT_LIMITS.band) / 4,
            length,
          })),
        });
  }
  return { refinements, triangleVisits, milliseconds: Date.now() - started };
}
