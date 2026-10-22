import type { SemanticPart } from '@cadfixer/auto-split-contract';
import {
  SuggestionOperation,
  SuggestionReason,
  SuggestionStatus,
  type Suggestion,
} from './suggestions';

export interface SemanticExecutionEligibility {
  readonly state: 'EXECUTABLE' | 'NON_EXECUTABLE' | 'UNRESOLVED';
  readonly reason:
    'SEMANTIC_EVIDENCE_PERMITTED' | 'STRICT_UNKNOWN_NON_EXECUTABLE' | 'SEMANTIC_TARGET_MISSING';
}
/** Evaluate the original semantic contract. Ownership and native validity cannot rewrite it.
 * A known solid can be fused (likelySeparable=false) and still admit local structural evidence.
 * Unknown with explicit likelySeparable=true is not the strict non-execution contract. */
export function semanticExecutionEligibility(
  part: Pick<SemanticPart, 'expectedGeometry'> | undefined,
): SemanticExecutionEligibility {
  if (!part) return { state: 'UNRESOLVED', reason: 'SEMANTIC_TARGET_MISSING' };
  return part.expectedGeometry.kind === 'unknown' && !part.expectedGeometry.likelySeparable
    ? { state: 'NON_EXECUTABLE', reason: 'STRICT_UNKNOWN_NON_EXECUTABLE' }
    : { state: 'EXECUTABLE', reason: 'SEMANTIC_EVIDENCE_PERMITTED' };
}
/** Last semantic permission gate, including generated family operations. No native claim is granted. */
export function guardSemanticExecution(
  suggestion: Suggestion,
  eligibility: SemanticExecutionEligibility,
): Suggestion {
  if (eligibility.state === 'EXECUTABLE')
    return { ...suggestion, semanticExecutionEligibility: eligibility };
  const {
    boundaryAmbiguity: _ambiguity,
    boundaryConfirmation: _confirmation,
    semanticFinalists: _finalists,
    sharedBoundary: _shared,
    ...safe
  } = suggestion;
  return {
    ...safe,
    semanticExecutionEligibility: eligibility,
    operation: SuggestionOperation.None,
    plane: null,
    components: [],
    quality: 'RECOGNIZED_NOT_SEPARABLE',
    status: SuggestionStatus.Unavailable,
    reason: SuggestionReason.FusedIntoBody,
  };
}
