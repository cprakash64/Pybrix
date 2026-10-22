import type { Checkpoint } from './checkpoint';
import type { SuggestedPlane } from './suggestions';
import { sameSemanticPlane } from './semantic-native';

/** Positive observations can establish ownership. Missing observations cannot. */
export type InterfaceOwnership = 'TARGET_SIDE' | 'BODY_SIDE' | 'AMBIGUOUS';
export type BoundaryConfirmationRoute = 'STRUCTURAL_SEAM' | 'GROUNDED_COMPLEMENT' | 'BOTH';
export interface BoundaryAlternative {
  readonly id: string;
  readonly plane: SuggestedPlane;
  readonly selectedSide: 'POSITIVE';
  readonly nativeProof: {
    readonly valid: true;
    readonly sourcePreserved: true;
    readonly partitionCount: 2;
  };
  /** Scalar settings for a real worker Preview; never an approximate geometry substitute. */
  readonly previewMetadata: { readonly label: 'Option A' | 'Option B' };
}
export interface BoundaryConfirmation {
  readonly status: 'NEEDS_BOUNDARY_CONFIRMATION';
  readonly targetId: string;
  readonly route: BoundaryConfirmationRoute;
  readonly ambiguityReason: 'UNRESOLVED_INTERFACE_OWNERSHIP';
  readonly alternatives: readonly [BoundaryAlternative, BoundaryAlternative];
}
/** Internal evidence must come from semantic admission and source ownership, never score proximity. */
export interface BoundaryHypothesis {
  readonly plane: SuggestedPlane;
  readonly ownershipClass: 'TARGET_SIDE' | 'BODY_SIDE';
  readonly semanticAdmission: true;
  readonly preservesPositiveEvidence: true;
  readonly respectsKnownOwnership: true;
}
export interface BoundaryAmbiguity {
  readonly targetId: string;
  readonly route: BoundaryConfirmationRoute;
  readonly interfaceOwnership: 'AMBIGUOUS';
  readonly materialUnknownInterface: true;
  readonly hypotheses: readonly BoundaryHypothesis[];
}

/** Both hypotheses must succeed. Native fallback success alone cannot establish a confirmation set.
 * The callback validates connector-free geometry and releases its candidate before returning proof.
 * No geometry or transaction handle escapes this controller. */
export async function qualifyBoundaryConfirmation(
  ambiguity: BoundaryAmbiguity,
  control: {
    readonly checkpoint: Checkpoint;
    readonly attemptLimit?: number;
    readonly charge: () => void;
    readonly validate: (plane: SuggestedPlane) => Promise<BoundaryAlternative['nativeProof']>;
    readonly isNativeInvalid: (error: unknown) => boolean;
  },
): Promise<BoundaryConfirmation | undefined> {
  control.checkpoint();
  // The existing native finalist ceiling is three, including duplicate ownership representatives.
  if (ambiguity.hypotheses.length > 3) return undefined;
  const classes = new Map<BoundaryHypothesis['ownershipClass'], BoundaryHypothesis[]>();
  for (const hypothesis of ambiguity.hypotheses) {
    control.checkpoint();
    const group = classes.get(hypothesis.ownershipClass) ?? [];
    if (!group.some((h) => sameSemanticPlane(h.plane, hypothesis.plane))) group.push(hypothesis);
    classes.set(hypothesis.ownershipClass, group);
  }
  const target = classes.get('TARGET_SIDE'),
    body = classes.get('BODY_SIDE');
  if (!target?.length || !body?.length || sameSemanticPlane(target[0]!.plane, body[0]!.plane))
    return undefined;
  const alternatives: BoundaryAlternative[] = [];
  let attempted = 0;
  for (const [index, group] of [target, body].entries()) {
    let accepted: BoundaryAlternative | undefined;
    for (const hypothesis of group) {
      control.checkpoint();
      if (attempted >= Math.min(3, control.attemptLimit ?? 3)) return undefined;
      attempted++;
      control.charge();
      let nativeProof: BoundaryAlternative['nativeProof'];
      try {
        nativeProof = await control.validate(hypothesis.plane);
      } catch (error) {
        control.checkpoint();
        if (!control.isNativeInvalid(error)) throw error;
        continue;
      }
      control.checkpoint();
      accepted = {
        id: `${ambiguity.targetId}:boundary:${String(index)}`,
        plane: hypothesis.plane,
        selectedSide: 'POSITIVE',
        nativeProof,
        previewMetadata: { label: index === 0 ? 'Option A' : 'Option B' },
      };
      break;
    }
    if (!accepted) return undefined;
    alternatives.push(accepted);
  }
  const a = alternatives[0],
    b = alternatives[1];
  if (!a || !b) return undefined;
  control.checkpoint();
  return {
    status: 'NEEDS_BOUNDARY_CONFIRMATION',
    targetId: ambiguity.targetId,
    route: ambiguity.route,
    ambiguityReason: 'UNRESOLVED_INTERFACE_OWNERSHIP',
    alternatives: [a, b],
  };
}

/** An explicit decision applies only to this result and source preparation. */
export function selectBoundaryAlternative(
  confirmation: BoundaryConfirmation,
  alternativeId: string,
): BoundaryAlternative | undefined {
  return confirmation.alternatives.find((alternative) => alternative.id === alternativeId);
}
