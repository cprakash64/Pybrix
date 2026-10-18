import type { SemanticPart } from '@cadfixer/auto-split-contract';
import { SEMANTIC_PLANE_REFINEMENT_LIMITS, type SemanticPlaneRefinement } from './semantic-plane';
import type { Checkpoint } from './checkpoint';

/** A localized shoulder or stable two-sided neck. A shoulder step must dominate all remaining
 * variation; a neck needs multiple minimum samples and broader support on both sides.
 * Uses the existing refinement contrast floor.
 * No extra mesh pass, native operation, label, object class, or provider hint participates. */
export interface StructuralSeamEvidence {
  readonly admitted: boolean;
  readonly reason:
    'STABLE_SECTION_STEP' | 'STABLE_SECTION_MINIMUM' | 'INSUFFICIENT_SECTION_STRUCTURE';
  readonly minimumOffsetRange: readonly [number, number] | null;
  readonly profile: readonly { readonly offset: number; readonly length: number }[];
  readonly relativeContrast: number;
  readonly dominantStep: number;
  readonly remainingVariation: number;
  readonly supportedSamplesBefore: number;
  readonly supportedSamplesAfter: number;
  readonly workUnits: number;
}
export function structuralSeamEvidence(
  refinement: SemanticPlaneRefinement | undefined,
  checkpoint: Checkpoint,
): StructuralSeamEvidence {
  const profile =
    refinement?.sectionProfile.length === SEMANTIC_PLANE_REFINEMENT_LIMITS.samples
      ? refinement.sectionProfile
      : [];
  // A plane exactly on a source edge can have zero strict-triangle intersections. Nearby
  // positive sections must independently establish structure; a zero never counts as a neck.
  const supported = profile.filter((p) => Number.isFinite(p.length) && p.length > 0);
  let dominantStep = 0,
    split = 0,
    totalVariation = 0;
  for (let i = 1; i < supported.length; i++) {
    checkpoint();
    const a = supported[i - 1]?.length ?? 0,
      b = supported[i]?.length ?? 0,
      step = Math.abs(b - a);
    totalVariation += step;
    if (step > dominantStep) {
      dominantStep = step;
      split = i;
    }
  }
  const remainingVariation = totalVariation - dominantStep;
  const minimum = Math.min(...supported.map((p) => p.length));
  let minimumStart = -1,
    minimumEnd = -1,
    repeatedMinimum = false;
  for (let i = 0; i < supported.length; i++) {
    checkpoint();
    if ((supported[i]?.length ?? Infinity) <= minimum + 1e-8) {
      if (minimumStart < 0) minimumStart = i;
      else if (minimumEnd !== i - 1) repeatedMinimum = true;
      minimumEnd = i;
    }
  }
  const left = supported[minimumStart - 1]?.length ?? 0;
  const right = supported[minimumEnd + 1]?.length ?? 0;
  const minimumContrast = Math.min(
    (left - minimum) / Math.max(left, 1e-8),
    (right - minimum) / Math.max(right, 1e-8),
  );
  const firstMinimumOffset = supported[minimumStart]?.offset;
  const lastMinimumOffset = supported[minimumEnd]?.offset;
  const stableMinimum =
    !repeatedMinimum &&
    minimumStart >= 2 &&
    supported.length - minimumEnd - 1 >= 2 &&
    minimumEnd - minimumStart >= 1 &&
    minimumContrast >= SEMANTIC_PLANE_REFINEMENT_LIMITS.minimumImprovement &&
    firstMinimumOffset !== undefined &&
    lastMinimumOffset !== undefined &&
    refinement !== undefined &&
    refinement.chosenOffset >= firstMinimumOffset - 1e-8 &&
    refinement.chosenOffset <= lastMinimumOffset + 1e-8;
  const a = supported[split - 1]?.length ?? 0,
    b = supported[split]?.length ?? 0,
    relativeContrast = dominantStep / Math.max(a, b, 1e-8),
    stableStep =
      split >= 2 &&
      supported.length - split >= 2 &&
      relativeContrast >= SEMANTIC_PLANE_REFINEMENT_LIMITS.minimumImprovement &&
      dominantStep > remainingVariation + 1e-8;
  checkpoint();
  return {
    admitted: stableStep || stableMinimum,
    reason: stableStep
      ? 'STABLE_SECTION_STEP'
      : stableMinimum
        ? 'STABLE_SECTION_MINIMUM'
        : 'INSUFFICIENT_SECTION_STRUCTURE',
    minimumOffsetRange: stableMinimum ? [firstMinimumOffset, lastMinimumOffset] : null,
    profile,
    relativeContrast,
    dominantStep,
    remainingVariation,
    supportedSamplesBefore: split,
    supportedSamplesAfter: supported.length - split,
    workUnits: profile.length + 3 * supported.length,
  };
}

/** A profile cannot certify a rotated or unrelated native fallback plane. */
export function seamSupportsPlane(
  refinement: SemanticPlaneRefinement | undefined,
  cut: NonNullable<SemanticPart['cut']>,
  seam?: StructuralSeamEvidence,
): boolean {
  if (!refinement) return false;
  const normal = refinement.profileNormal;
  const parallel = [1, -1].some((sign) =>
    normal.every((n, i) => Math.abs(n - sign * (cut.normal[i] ?? 0)) <= 1e-7),
  );
  if (!parallel) return false;
  const offset = normal.reduce((sum, n, i) => sum + n * (cut.origin[i] ?? 0), 0);
  const first =
    seam?.reason === 'STABLE_SECTION_MINIMUM'
      ? seam.minimumOffsetRange?.[0]
      : refinement.sectionProfile[0]?.offset;
  const last =
    seam?.reason === 'STABLE_SECTION_MINIMUM'
      ? seam.minimumOffsetRange?.[1]
      : refinement.sectionProfile[SEMANTIC_PLANE_REFINEMENT_LIMITS.samples - 1]?.offset;
  return (
    first !== undefined && last !== undefined && offset >= first - 1e-8 && offset <= last + 1e-8
  );
}
