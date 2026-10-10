import type { HumanAnswer, HumanSlot, Vec3 } from '@cadfixer/auto-split-contract';
import { HUMAN_SLOTS } from '@cadfixer/auto-split-contract';
import { toSourcePoint, type FaceFacts, type NormalizedGeometry } from './geometry';
import {
  crossSectionLength,
  dot3,
  normalizedPlane,
  sideShares,
  type NormalizedPlane,
} from './plane-math';
import {
  SuggestionOperation,
  SuggestionReason,
  SuggestionStatus,
  type Suggestion,
} from './suggestions';

/**
 * HUMAN SUGGESTIONS: the simplest evidence-backed method the research supports.
 *
 * The model proposes ONE plane per part (a unit normal pointing from the body into the part, and an
 * offset). Heads came out accurate in the research and arms loose, so:
 *
 *   1. DIRECT PROPOSAL. The model's own plane, flipped if its stated centre lies on the wrong side.
 *   2. BOUNDED LOCAL REFINEMENT. The plane slides along its own normal, at most `WINDOW` either way,
 *      to the place the cut is shortest (a neck or a shoulder is where a figure is narrowest). The slide
 *      is kept only when that minimum is interior to the window; at its edge the proposal stands.
 *   3. A SANITY CHECK that never decides anything good: the part's side must hold a plausible share of
 *      the surface and the part's stated centre. A cut that fails is not offered.
 *
 * Nothing here applies anything. The head is SUGGESTED when the model was sure; every arm, and a head
 * the model was unsure of, NEEDS ADJUSTMENT, because the research found arm planes 15 to 40 degrees off.
 */
export const REFINEMENT_WINDOW = 0.06;
export const REFINEMENT_STEP = 0.005;
/** The part's side must hold at least this much of the surface (a part of a figure is not a sliver)... */
export const MIN_PART_SHARE = 0.005;
/** ...and at most this much (a head or an arm is never most of the figure). */
export const MAX_PART_SHARE = 0.6;

const LABELS: Readonly<Record<HumanSlot, string>> = {
  head: 'Head',
  left_arm: 'Left arm',
  right_arm: 'Right arm',
};

function plausible(plane: NormalizedPlane, facts: FaceFacts, center: Vec3 | null): boolean {
  const share = sideShares(facts, plane).positive;
  if (share < MIN_PART_SHARE || share > MAX_PART_SHARE) return false;
  return center === null || dot3(center, plane.normal) - plane.offset >= 0;
}

export function refinePlane(
  geometry: NormalizedGeometry,
  proposal: NormalizedPlane,
): NormalizedPlane {
  const steps = Math.round(REFINEMENT_WINDOW / REFINEMENT_STEP);
  let best = 0;
  let bestLength = Infinity;
  for (let k = -steps; k <= steps; k += 1) {
    const length = crossSectionLength(geometry, {
      normal: proposal.normal,
      offset: proposal.offset + k * REFINEMENT_STEP,
    });
    // Ties keep the slide closest to the proposal.
    if (
      length < bestLength - 1e-12 ||
      (Math.abs(length - bestLength) <= 1e-12 && Math.abs(k) < Math.abs(best))
    ) {
      bestLength = length;
      best = k;
    }
  }
  if (Math.abs(best) === steps) return proposal;
  return { normal: proposal.normal, offset: proposal.offset + best * REFINEMENT_STEP };
}

export function suggestHuman(
  geometry: NormalizedGeometry,
  facts: FaceFacts,
  answer: HumanAnswer,
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const slot of HUMAN_SLOTS) {
    const part = answer.parts[slot];
    if (part.status === 'ABSENT') continue;
    const base = {
      id: slot,
      family: slot === 'head' ? ('head' as const) : ('arm' as const),
      label: LABELS[slot],
      components: [] as readonly number[],
    };
    const unavailable = (reason: SuggestionReason): Suggestion => ({
      ...base,
      operation: SuggestionOperation.None,
      status: SuggestionStatus.Unavailable,
      reason,
      plane: null,
    });
    if (part.planeNormal === null || part.planeOffset === null) {
      out.push(unavailable(SuggestionReason.NotLocated));
      continue;
    }
    let plane = normalizedPlane(part.planeNormal, part.planeOffset);
    if (plane === null) {
      out.push(unavailable(SuggestionReason.NotLocated));
      continue;
    }
    // The normal points into the part: when the stated centre is behind the plane, the model gave it backwards.
    if (part.center !== null && dot3(part.center, plane.normal) - plane.offset < 0)
      plane = {
        normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
        offset: -plane.offset,
      };
    const refined = refinePlane(geometry, plane);
    const chosen = plausible(refined, facts, part.center)
      ? refined
      : plausible(plane, facts, part.center)
        ? plane
        : null;
    if (chosen === null) {
      out.push(unavailable(SuggestionReason.CutDoesNotIsolate));
      continue;
    }
    const confident = slot === 'head' && part.status === 'PRESENT';
    out.push({
      ...base,
      operation: SuggestionOperation.Plane,
      status: confident ? SuggestionStatus.Suggested : SuggestionStatus.NeedsAdjustment,
      reason: confident ? SuggestionReason.Clear : SuggestionReason.ReviewCut,
      plane: {
        origin: toSourcePoint(geometry, [
          chosen.normal[0] * chosen.offset,
          chosen.normal[1] * chosen.offset,
          chosen.normal[2] * chosen.offset,
        ]),
        normal: chosen.normal,
      },
    });
  }
  return out;
}
