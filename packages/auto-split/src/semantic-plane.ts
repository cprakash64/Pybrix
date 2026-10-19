import {
  cameraFor,
  FRAME_FILL,
  VIEW_NAMES,
  type SemanticPart,
  type Vec3,
} from '@cadfixer/auto-split-contract';
import type { NormalizedGeometry } from './geometry';
import { CHECKPOINT_MASK, type Checkpoint } from './checkpoint';

/** Read-only local refinement, independent of either qualified splitter. Never creates a face/cap. */
export const SEMANTIC_PLANE_REFINEMENT_LIMITS = Object.freeze({
  samples: 9,
  band: 0.025,
  minimumImprovement: 0.1,
  groups: 8,
  shoulderPlanes: 16,
});
export interface SemanticPlaneRefinement {
  readonly cut: NonNullable<SemanticPart['cut']>;
  readonly proposedOffset: number;
  readonly chosenOffset: number;
  readonly proposedSectionLength: number;
  readonly chosenSectionLength: number;
  readonly samples: number;
  readonly profileNormal: Vec3;
  readonly shoulderEvidence?: {
    readonly surfaceOffset: number | null;
    readonly featureOverflow: boolean;
    readonly ownership: 'INCLUDED' | 'EXCLUDED' | 'AMBIGUOUS';
  };
  readonly sectionProfile: readonly { readonly offset: number; readonly length: number }[];
}
interface PlaneGroup {
  readonly normal: Vec3;
  readonly offset: number;
  readonly parts: SemanticPart[];
  readonly lengths: Float64Array;
  readonly shoulders: Map<number, { offset: number; area: number }>;
  featureOverflow: boolean;
}
/** Shared complementary planes refine together, so sibling assembly suggestions remain complementary. */
export function refineSemanticPlanes(
  geometry: NormalizedGeometry,
  parts: readonly SemanticPart[],
  checkpoint: Checkpoint,
  preserveUnbracketed?: ReadonlySet<string>,
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
    else
      groups.set(key, {
        normal,
        offset,
        parts: [part],
        lengths: new Float64Array(9),
        shoulders: new Map(),
        featureOverflow: false,
      });
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
      // Parallel source faces identify a shoulder crossed by the coarse proposal.
      // Collect in the existing bounded face pass; no per-finalist or sibling face scan.
      if (maximum - minimum <= 1e-7) {
        const v0 = vertices[0] ?? 0,
          v1 = vertices[1] ?? 0,
          v2 = vertices[2] ?? 0,
          ax = (positions[v1] ?? 0) - (positions[v0] ?? 0),
          ay = (positions[v1 + 1] ?? 0) - (positions[v0 + 1] ?? 0),
          az = (positions[v1 + 2] ?? 0) - (positions[v0 + 2] ?? 0),
          bx = (positions[v2] ?? 0) - (positions[v0] ?? 0),
          by = (positions[v2 + 1] ?? 0) - (positions[v0 + 1] ?? 0),
          bz = (positions[v2 + 2] ?? 0) - (positions[v0 + 2] ?? 0),
          area = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2,
          offset = group.offset + minimum,
          key = Math.round(offset * 1e7),
          previous = group.shoulders.get(key);
        if (previous) previous.area += area;
        else if (group.shoulders.size < SEMANTIC_PLANE_REFINEMENT_LIMITS.shoulderPlanes)
          group.shoulders.set(key, { offset, area });
        else group.featureOverflow = true;
      }
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
    checkpoint();
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
    // A minimum plateau reaching the search boundary is not a localized neck.
    // Grounded semantic ownership must retain its seed in that ambiguous band.
    // Structural-seam-only callers can retain their established refinement policy.
    const minimum = group.lengths[best] ?? 0,
      plateauTolerance = Math.max(1e-8, original * 1e-6),
      unbracketed =
        Math.abs((group.lengths[0] ?? 0) - minimum) <= plateauTolerance ||
        Math.abs((group.lengths[8] ?? 0) - minimum) <= plateauTolerance;
    const proposedMinimum = group.offset + ((best - 4) * SEMANTIC_PLANE_REFINEMENT_LIMITS.band) / 4,
      crossed = [...group.shoulders.values()]
        .filter(
          (surface) =>
            surface.offset > Math.min(group.offset, proposedMinimum) + 1e-7 &&
            surface.offset < Math.max(group.offset, proposedMinimum) - 1e-7,
        )
        .sort((a, b) => b.area - a.area || a.offset - b.offset)[0];
    for (const part of group.parts) {
      checkpoint();
      if (part.cut) {
        const grounded = preserveUnbracketed?.has(part.id) ?? true,
          ownership =
            crossed && !group.featureOverflow
              ? semanticShoulderOwnership(geometry, part, group.normal, crossed.offset, checkpoint)
              : 'AMBIGUOUS',
          selectedAfterMove =
            crossed &&
            group.normal.reduce((sum, n, a) => sum + n * (part.cut?.normal[a] ?? 0), 0) *
              (crossed.offset - proposedMinimum) >=
              0,
          moveSupported = crossed && ownership === (selectedAfterMove ? 'INCLUDED' : 'EXCLUDED'),
          chosen = unbracketed && grounded && !moveSupported ? 4 : best,
          delta = ((chosen - 4) * SEMANTIC_PLANE_REFINEMENT_LIMITS.band) / 4;
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
          chosenSectionLength: group.lengths[chosen] ?? 0,
          samples: 9,
          ...(unbracketed && best !== 4 && grounded
            ? {
                shoulderEvidence: {
                  surfaceOffset: crossed?.offset ?? null,
                  featureOverflow: group.featureOverflow,
                  ownership,
                },
              }
            : {}),
          profileNormal: group.normal,
          sectionProfile: Array.from(group.lengths, (length, i) => ({
            offset: group.offset + ((i - 4) * SEMANTIC_PLANE_REFINEMENT_LIMITS.band) / 4,
            length,
          })),
        });
      }
    }
  }
  return { refinements, triangleVisits, milliseconds: Date.now() - started };
}

/** Independent raw polygon extents resolve which side owns a planar shoulder.
 * Only views whose image plane contains the cut normal provide a depth-free bound.
 * Missing, oblique or contradictory projections remain ambiguous. */
export function semanticShoulderOwnership(
  geometry: NormalizedGeometry,
  part: SemanticPart,
  normal: Vec3,
  offset: number,
  checkpoint: Checkpoint,
): 'INCLUDED' | 'EXCLUDED' | 'AMBIGUOUS' {
  if (!part.cut) return 'AMBIGUOUS';
  const sign = normal.reduce((sum, n, a) => sum + n * (part.cut?.normal[a] ?? 0), 0) < 0 ? -1 : 1,
    oriented = normal.map((n) => n * sign),
    included = new Set<number>(),
    excluded = new Set<number>();
  for (const region of part.views) {
    checkpoint();
    const camera = cameraFor(region.view);
    if (Math.abs(oriented.reduce((sum, n, a) => sum + n * (camera.forward[a] ?? 0), 0)) > 1e-6)
      continue;
    let lower = Infinity;
    for (const polygon of region.polygons)
      for (const [x, y] of polygon) {
        const projected = oriented.reduce(
          (sum, n, a) =>
            sum +
            n *
              (((camera.right[a] ?? 0) * (x - 0.5) * 2 * geometry.radius) / FRAME_FILL -
                ((camera.up[a] ?? 0) * (y - 0.5) * 2 * geometry.radius) / FRAME_FILL),
          0,
        );
        lower = Math.min(lower, projected);
      }
    if (!Number.isFinite(lower)) continue;
    const axis = Math.floor(VIEW_NAMES.indexOf(region.view) / 2);
    if (lower <= offset * sign + 1e-6) included.add(axis);
    else excluded.add(axis);
  }
  return included.size >= 2 && excluded.size < 2
    ? 'INCLUDED'
    : excluded.size >= 2 && included.size < 2
      ? 'EXCLUDED'
      : 'AMBIGUOUS';
}
