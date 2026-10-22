import {
  qualifyBoundaryConfirmation,
  guardSemanticExecution,
  semanticNativePolicy,
  SuggestionOperation,
  SuggestionStatus,
  type Suggestion,
} from '@cadfixer/auto-split';
import { AppErrorCode, isAppError, invalidState } from '@cadfixer/shared';
import type { DocumentHandle, OperationContext } from '@cadfixer/geometry-runtime';
import { splitCreateHandler } from './split-handlers';
import { splitCandidates } from './stl-handlers';

/** Validate connector-free alternatives through the authoritative Preview path. Every temporary
 * candidate is released before any confirmation payload is published. No transaction is committed. */
export async function qualifySemanticBoundaries(
  source: DocumentHandle,
  partId: string,
  triangles: number,
  suggestions: readonly Suggestion[],
  context: OperationContext,
): Promise<{
  readonly suggestions: readonly Suggestion[];
  readonly attempts: number;
  readonly partIds: readonly string[];
}> {
  const policy = semanticNativePolicy(triangles);
  let attempts = 0,
    parts = 0;
  const result: Suggestion[] = [];
  const partIds: string[] = [];
  for (const suggestion of suggestions) {
    context.throwIfCancelled();
    const { boundaryAmbiguity, ...publicSuggestion } = suggestion;
    if (
      suggestion.semanticExecutionEligibility &&
      suggestion.semanticExecutionEligibility.state !== 'EXECUTABLE'
    ) {
      result.push(
        guardSemanticExecution(publicSuggestion, suggestion.semanticExecutionEligibility),
      );
      continue;
    }
    if (!boundaryAmbiguity) {
      result.push(publicSuggestion);
      continue;
    }
    const confirmation =
      policy.finalistsPerPart >= 2 && ++parts <= policy.parts && attempts + 2 <= policy.attempts
        ? await qualifyBoundaryConfirmation(boundaryAmbiguity, {
            attemptLimit: Math.min(policy.finalistsPerPart, policy.attempts - attempts),
            checkpoint: () => {
              context.throwIfCancelled();
            },
            charge: () => {
              if (!partIds.includes(suggestion.id)) partIds.push(suggestion.id);
              if (++attempts > policy.attempts) throw invalidState('No safe split found.');
            },
            validate: async (plane) => {
              const preview = await splitCreateHandler(
                { source, partId, request: { plane, connector: { kind: 'none' } } },
                context,
              );
              try {
                context.throwIfCancelled();
                return { valid: true, sourcePreserved: true, partitionCount: 2 } as const;
              } finally {
                splitCandidates.discard(preview.value.candidate);
              }
            },
            isNativeInvalid: (error) =>
              isAppError(error) &&
              (error.code === AppErrorCode.InvalidState ||
                error.code === AppErrorCode.GeometryValidationFailed),
          })
        : undefined;
    context.throwIfCancelled();
    result.push({
      ...publicSuggestion,
      operation: SuggestionOperation.None,
      plane: null,
      semanticFinalists: [],
      quality: confirmation ? 'NEEDS_BOUNDARY_CONFIRMATION' : 'RECOGNIZED_NOT_SEPARABLE',
      status: confirmation
        ? SuggestionStatus.NeedsBoundaryConfirmation
        : SuggestionStatus.Unavailable,
      ...(confirmation ? { boundaryConfirmation: confirmation } : {}),
    });
  }
  context.throwIfCancelled();
  return { suggestions: result, attempts, partIds };
}
