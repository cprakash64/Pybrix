import type { Vec3 } from '@cadfixer/auto-split-contract';
import type { PlaneOffsetSource } from './semantic-synthesis-trace';

/** Existing scalar metadata in one synthesis target's finite, unit-normal candidate domain. */
export interface SemanticPlaneOrderCandidate {
  readonly normal: Vec3;
  readonly offset: number;
  readonly section: number;
  readonly offsetSource?: PlaneOffsetSource;
  readonly localization?: number;
  readonly groundedScope?: {
    readonly intrinsicFrontier: number;
    readonly pixelUncertainty: number;
    readonly boundaryWitness?: { readonly observedAxes: readonly number[] };
  };
  readonly score: {
    readonly clean: boolean;
    readonly worstLeakage: number;
    readonly recall: number;
    readonly purity: number;
    readonly fraction: number;
  };
}

function targetExtremumPriority(source: PlaneOffsetSource | undefined): number {
  return source === 'TARGET_MIN' || source === 'TARGET_MAX' ? 0 : 1;
}

/** A dense, corroborated perimeter resolves ties that the sparse score cannot see. */
function groundedFrontierDistance(candidate: SemanticPlaneOrderCandidate): number {
  const scope = candidate.groundedScope;
  return scope?.boundaryWitness && scope.boundaryWitness.observedAxes.length >= 2
    ? Math.max(
        0,
        Math.abs(candidate.offset - scope.intrinsicFrontier) - scope.pixelUncertainty - 1e-8,
      )
    : 0;
}

export function compareSemanticPlanes(
  a: SemanticPlaneOrderCandidate,
  b: SemanticPlaneOrderCandidate,
): number {
  return (
    (a.groundedScope && b.groundedScope ? (b.localization ?? 0) - (a.localization ?? 0) : 0) ||
    Number(!a.score.clean) - Number(!b.score.clean) ||
    (!a.score.clean && !b.score.clean ? a.score.worstLeakage - b.score.worstLeakage : 0) ||
    b.score.recall - a.score.recall ||
    b.score.purity - a.score.purity ||
    a.score.worstLeakage - b.score.worstLeakage ||
    groundedFrontierDistance(a) - groundedFrontierDistance(b) ||
    a.score.fraction - b.score.fraction ||
    a.section - b.section ||
    a.normal[0] - b.normal[0] ||
    a.normal[1] - b.normal[1] ||
    a.normal[2] - b.normal[2] ||
    // Once measured quality and orientation tie, retain an observed target-depth
    // boundary anchor before arbitrary coordinate order. This is proposal provenance,
    // not scope authority. Min/max have equal priority under raw-normal reversal.
    targetExtremumPriority(a.offsetSource) - targetExtremumPriority(b.offsetSource) ||
    a.offset - b.offset
  );
}
