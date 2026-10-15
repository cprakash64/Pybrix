import {
  VIEW_NAMES,
  type SemanticHierarchy,
  type SemanticPart,
} from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import type { Suggestion } from './suggestions';
import { CHECKPOINT_STRIDE, type Checkpoint } from './checkpoint';

export type SemanticRoleScope =
  'WHOLE_ASSEMBLY' | 'EXTRACTABLE_PART' | 'REPEATED_FAMILY' | 'DETAIL_FEATURE' | 'UNKNOWN_SCOPE';
export interface SemanticExtent {
  readonly scope: SemanticRoleScope;
  readonly admitted: boolean;
  readonly conflicts: readonly {
    id: string;
    views: readonly string[];
    maximumShare: number;
    minimumEvidencePurity: number;
    independentComponent: boolean;
  }[];
  readonly targetPixels: number;
  readonly potentialCompetingPixelsUpperBound: number;
  readonly unknownPixelsLowerBound: number;
  readonly evaluatedPixels: number;
}
const physical = (p: SemanticPart): boolean =>
  p.confidence >= 0.72 &&
  p.expectedGeometry.kind !== 'surface_part' &&
  (p.expectedGeometry.kind !== 'unknown' || p.importance === 'major');
function descendant(answer: SemanticHierarchy, parent: string, child: SemanticPart): boolean {
  let id = child.parentId;
  for (let depth = 0; id && depth < 4; depth++) {
    if (id === parent) return true;
    id = answer.parts.find((p) => p.id === id)?.parentId ?? null;
  }
  return false;
}
/** Labels can declare aggregate intent, but cannot alone establish aggregate ownership. */
export function semanticRoleScope(
  part: SemanticPart,
  answer: SemanticHierarchy,
): SemanticRoleScope {
  if (part.expectedGeometry.kind === 'surface_part') return 'DETAIL_FEATURE';
  if (part.expectedGeometry.kind === 'repeated_part' && part.instances > 1)
    return 'REPEATED_FAMILY';
  if (
    /\bassembly\b/i.test(part.label) &&
    part.expectedGeometry.kind === 'solid_part' &&
    part.views.length >= 2 &&
    answer.parts.some((p) => descendant(answer, part.id, p))
  )
    return 'WHOLE_ASSEMBLY';
  if (part.expectedGeometry.kind === 'solid_part' || part.expectedGeometry.likelySeparable)
    return 'EXTRACTABLE_PART';
  return 'UNKNOWN_SCOPE';
}
/** Triangular joint-support table: no source-face array per part, and no candidate raster rescans. */
function jointIndex(a: number, b: number, count: number): number {
  const lo = Math.min(a, b),
    hi = Math.max(a, b);
  return (lo * (2 * count - lo - 1)) / 2 + hi - lo - 1;
}
export function componentSemanticExtents(
  p: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  suggestions: readonly Suggestion[],
  support: readonly Uint32Array[],
  checkpoint: Checkpoint,
  charge: () => void,
): Map<string, SemanticExtent> {
  const results = new Map<string, SemanticExtent>();
  if (!suggestions.some((s) => s.operation === 'COMPONENT' && s.quality === 'READY'))
    return results;
  const parts = answer.parts.length,
    ranks = p.metadata.components.length,
    pairs = (parts * (parts - 1)) / 2;
  const totals = new Uint32Array(p.rasters.length * ranks),
    counts = new Uint32Array(p.rasters.length * ranks * parts),
    joints = new Uint32Array(p.rasters.length * ranks * pairs),
    global = new Uint32Array(p.rasters.length * parts),
    ownersScratch = new Uint8Array(parts);
  for (const [vi, raster] of p.rasters.entries())
    for (let pixel = 0; pixel < raster.face.length; pixel++) {
      if (pixel % CHECKPOINT_STRIDE === 0) checkpoint();
      charge();
      const face = raster.face[pixel] ?? -1;
      if (face < 0) continue;
      const rank = p.labelling.faceRank[face] ?? -1,
        admitted = rank >= 0 && rank < ranks,
        base = vi * ranks + rank;
      if (admitted) totals[base] = (totals[base] ?? 0) + 1;
      let bits = support[vi]?.[pixel] ?? 0,
        length = 0;
      while (bits) {
        charge();
        const bit = bits & -bits,
          index = 31 - Math.clz32(bit);
        bits ^= bit;
        ownersScratch[length++] = index;
        global[vi * parts + index] = (global[vi * parts + index] ?? 0) + 1;
        if (admitted) counts[base * parts + index] = (counts[base * parts + index] ?? 0) + 1;
      }
      if (!admitted) continue;
      for (let a = 0; a < length; a++)
        for (let b = a + 1; b < length; b++) {
          charge();
          const i = base * pairs + jointIndex(ownersScratch[a] ?? 0, ownersScratch[b] ?? 0, parts);
          joints[i] = (joints[i] ?? 0) + 1;
        }
    }
  for (const [ti, target] of answer.parts.entries()) {
    checkpoint();
    const candidate = suggestions.find((s) => s.id === target.id);
    if (candidate?.operation !== 'COMPONENT' || candidate.quality !== 'READY') continue;
    const selected = [...new Set(candidate.components)],
      scope = semanticRoleScope(target, answer);
    const stats = answer.parts
      .map((part, index) => ({
        part,
        index,
        views: [] as string[],
        maximumShare: 0,
        minimumEvidencePurity: 1,
        independentComponent: false,
        aggregateViews: 0,
      }))
      .filter(
        (s) =>
          s.part.id !== target.id && physical(s.part) && !descendant(answer, s.part.id, target),
      );
    let targetPixels = 0,
      potentialCompetingPixelsUpperBound = 0,
      unknownPixelsLowerBound = 0,
      evaluatedPixels = 0;
    for (const [vi] of p.rasters.entries()) {
      let visible = 0,
        targetTotal = 0,
        otherTotal = 0;
      for (const rank of selected) {
        charge();
        const base = vi * ranks + rank;
        visible += totals[base] ?? 0;
        targetTotal += counts[base * parts + ti] ?? 0;
      }
      evaluatedPixels += visible;
      targetPixels += targetTotal;
      for (const state of stats) {
        checkpoint();
        let total = 0,
          inside = 0,
          independent = false;
        for (const rank of selected) {
          charge();
          const base = vi * ranks + rank,
            n = totals[base] ?? 0,
            hit = counts[base * parts + state.index] ?? 0;
          total += hit;
          inside += joints[base * pairs + jointIndex(ti, state.index, parts)] ?? 0;
          if (n >= 8 && hit / n >= 0.82) independent = true;
        }
        otherTotal += total;
        const share = visible ? total / visible : 0,
          isChild = descendant(answer, target.id, state.part);
        if (
          isChild &&
          total >= 8 &&
          inside / total >= 0.9 &&
          targetTotal / Math.max(1, visible) >= 0.9
        )
          state.aggregateViews++;
        // Evidence purity excludes unknown pixels. A supplied localized physical competitor is
        // negative even when a coarse parent polygon also covers it. Whole masks are not localization.
        const meaningful = targetTotal + total - inside,
          purity = meaningful ? Math.max(0, targetTotal - inside) / meaningful : 1;
        const grounded =
          total >= 8 && total / Math.max(1, global[vi * parts + state.index] ?? 0) >= 0.82;
        const coarseHierarchyOverlap =
          isChild &&
          selected.length === 1 &&
          share >= 0.95 &&
          inside / Math.max(1, meaningful) >= 0.9;
        const localized = grounded && purity < 0.9 && !coarseHierarchyOverlap;
        if (localized || (grounded && independent && (!isChild || selected.length > 1))) {
          state.views.push(VIEW_NAMES[vi] ?? '');
          state.maximumShare = Math.max(state.maximumShare, share);
          state.minimumEvidencePurity = Math.min(state.minimumEvidencePurity, purity);
          state.independentComponent ||= independent;
        }
      }
      // Other regions can overlap each other and target support. These are explicit bounds,
      // not an invented full 3D partition. Neither bound penalizes unseen/unknown geometry.
      potentialCompetingPixelsUpperBound += Math.min(visible, otherTotal);
      unknownPixelsLowerBound += Math.max(0, visible - targetTotal - otherTotal);
    }
    const conflicts = stats
      .filter((state) => {
        if (state.views.length < 2) return false;
        const child = descendant(answer, target.id, state.part);
        if (child && scope === 'WHOLE_ASSEMBLY' && state.aggregateViews >= 2) return false;
        if (
          child &&
          scope === 'REPEATED_FAMILY' &&
          state.part.instances === 1 &&
          state.independentComponent
        )
          return false;
        return true;
      })
      .map((s) => ({
        id: s.part.id,
        views: s.views,
        maximumShare: s.maximumShare,
        minimumEvidencePurity: s.minimumEvidencePurity,
        independentComponent: s.independentComponent,
      }));
    results.set(target.id, {
      scope,
      admitted: conflicts.length === 0 && scope !== 'UNKNOWN_SCOPE' && scope !== 'DETAIL_FEATURE',
      conflicts,
      targetPixels,
      potentialCompetingPixelsUpperBound,
      unknownPixelsLowerBound,
      evaluatedPixels,
    });
  }
  checkpoint();
  return results;
}
