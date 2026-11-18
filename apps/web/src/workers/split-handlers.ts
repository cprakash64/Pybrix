import {
  issueScopeReceipt,
  confirmScopeReceipt,
  cancelScopeReceipt,
  releaseScopeReceipt,
} from './semantic-scope-authority';
import { semanticScopeBinding } from './semantic-native-finalists';
import { qualifySemanticFinalists } from '@cadfixer/auto-split';
import {
  recordSemanticNativeRefusal,
  semanticNativePlan,
  recordSemanticNativeWinner,
  recordBoundaryPreview,
  requireConfirmedBoundary,
} from './semantic-native-finalists';
import { isAppError, AppErrorCode, invalidState } from '@cadfixer/shared';
import {
  classifyPlacement,
  documentTriangleCount,
  documentVertexCount,
  partId,
} from '@cadfixer/mesh-core';
import {
  assertProductConnectorRequest,
  documentByteLength,
  splitWithConnectors,
  SplitStage,
  withStatedUnit,
  type OperationHandler,
} from '@cadfixer/geometry-runtime';
import {
  booleanOperations,
  buildDocumentRenderSnapshot,
  describeParts,
  documentRenderTransferables,
  documentBounds,
  residentDocuments,
  splitCandidates,
} from './stl-handlers';
import { isPart } from '@cadfixer/geometry-runtime';
import type { BooleanKind } from '@cadfixer/geometry-runtime';
import type { BooleanOperationPhase } from './boolean-operation-protocol';

export interface SplitQualificationEvent {
  readonly documentId: string;
  readonly generation: number;
  readonly booleanIndex: number;
  readonly operation: BooleanKind;
  readonly phase: BooleanOperationPhase | 'KERNEL_ENTER' | 'TERMINAL';
  readonly at: number;
  readonly stats: {
    readonly active: number;
    readonly created: number;
    readonly terminated: number;
  };
}
let qualificationObserver: ((event: SplitQualificationEvent) => void) | undefined;
/** Harness-only observation seam; production leaves it unset. */
export function setSplitQualificationObserver(
  observer: ((event: SplitQualificationEvent) => void) | undefined,
): void {
  qualificationObserver = observer;
}

/** Where each stage begins, in the user's words. Notes only: no stage reports a fraction it cannot know. */
const STAGE_PROGRESS: Readonly<Record<SplitStage, readonly [number, string]>> = Object.freeze({
  [SplitStage.PreparingCut]: [0.02, 'Preparing cut…'],
  [SplitStage.Intersecting]: [0.1, 'Intersecting model…'],
  [SplitStage.BuildingCutSurfaces]: [0.6, 'Building cut surfaces…'],
  [SplitStage.AddingConnectors]: [0.7, 'Adding connectors…'],
});

const createSingleSplit: OperationHandler<'split/create'> = async (payload, context) => {
  context.throwIfCancelled();
  // A connector the page names is stated PHYSICALLY. A message is untrusted, so the kind is checked here too, before anything is
  // touched: a pin in raw coordinates would route around the unit policy.
  assertProductConnectorRequest(payload.request.connector);
  const sourcePart = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(sourcePart)) throw sourcePart;
  // The unit a physical connector is sized in is the FILE's when the file states one: a page holding a stale mirror of the document
  // cannot size a connector in the wrong unit. A document that states none takes the unit the user assigned, which the request carries.
  const document = residentDocuments.resolve(payload.source);
  if (isAppError(document)) throw document;
  const connector = withStatedUnit(payload.request.connector, document.unit);
  releaseScopeReceipt(payload.source.documentId);
  const ticket = splitCandidates.begin(payload.source, sourcePart.id);
  let booleanIndex = 0;
  try {
    context.reportProgress(0.02, 'Preparing cut…');
    /*
     * The part's placement, classified once by the one classifier and handed to the engine whole: a similarity's scale, or the
     * REASON the placement has none (non-uniform scale, shear, degenerate, malformed, non-finite). The engine refuses a connector on
     * the latter as `UNSUPPORTED_TRANSFORM` and carries the reason with it.
     */
    const placement = classifyPlacement(sourcePart.transform);
    const prepared = splitCandidates.preparePlaneSource(
      ticket,
      payload.request.plane,
      context.cancellation,
    );
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, cancellation) => {
          const index = booleanIndex++;
          return booleanOperations.run(kind, a, b, cancellation, {
            owner: { documentId: ticket.documentId, generation: ticket.generation },
            onPhase: (timing) =>
              qualificationObserver?.({
                documentId: ticket.documentId,
                generation: ticket.generation,
                booleanIndex: index,
                operation: kind,
                ...timing,
                stats: booleanOperations.stats,
              }),
          });
        },
      },
      sourcePart.mesh,
      { plane: payload.request.plane, connector },
      context.cancellation,
      (stage) => {
        context.reportProgress(STAGE_PROGRESS[stage][0], STAGE_PROGRESS[stage][1]);
        if (stage === SplitStage.Intersecting && prepared.capability.strategy === 'exact-solid')
          qualificationObserver?.({
            documentId: ticket.documentId,
            generation: ticket.generation,
            booleanIndex: -1,
            operation: 'intersection',
            phase: 'KERNEL_ENTER',
            at: performance.now(),
            stats: booleanOperations.stats,
          });
      },
      placement,
      prepared,
    );
    context.reportProgress(0.85, 'Checking parts…');
    const summary = splitCandidates.resolve(ticket, result, context.cancellation);
    recordBoundaryPreview(
      summary.candidate,
      payload.semanticQualification?.boundaryChoice === 'PREVIEW',
    );
    const preview = splitCandidates.preview(summary.candidate, (document) => ({
      render: buildDocumentRenderSnapshot(document),
      parts: describeParts(document),
    }));
    context.reportProgress(1, 'Preparing preview…');
    return {
      value: { ...summary, ...preview },
      transfer: documentRenderTransferables(preview.render),
    };
  } catch (error) {
    splitCandidates.fail(ticket);
    throw error;
  } finally {
    qualificationObserver?.({
      documentId: ticket.documentId,
      generation: ticket.generation,
      booleanIndex,
      operation: 'intersection',
      phase: 'TERMINAL',
      at: performance.now(),
      stats: booleanOperations.stats,
    });
  }
};

/** Lazy qualification IS Preview. Its one successful candidate is subsequently committed unchanged. */
export const splitCreateHandler: OperationHandler<'split/create'> = async (payload, context) => {
  context.throwIfCancelled();
  const part = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(part)) throw part;
  const plan = semanticNativePlan(payload, part.mesh);
  if (!plan || !payload.semanticQualification) return createSingleSplit(payload, context);
  let nativeAttempts = 0,
    nativeFailures = 0;
  const qualified = await qualifySemanticFinalists(
    plan.planes,
    async (plane) => {
      context.reportProgress(0, 'Checking cut…');
      nativeAttempts++;
      try {
        return await createSingleSplit(
          { ...payload, request: { ...payload.request, plane } },
          context,
        );
      } catch (error) {
        if (
          isAppError(error) &&
          (error.code === AppErrorCode.InvalidState ||
            error.code === AppErrorCode.GeometryValidationFailed)
        )
          nativeFailures++;
        throw error;
      }
    },
    {
      checkpoint: (): void => {
        context.throwIfCancelled();
      },
      charge: plan.charge,
      isNativeInvalid: (error) =>
        isAppError(error) &&
        (error.code === AppErrorCode.InvalidState ||
          error.code === AppErrorCode.GeometryValidationFailed),
      discard: (result) => {
        splitCandidates.discard(result.value.candidate);
      },
    },
  );
  if (!qualified) {
    recordSemanticNativeRefusal(payload);
    throw invalidState('No safe split found.', {
      code: 'SEMANTIC_NATIVE_FINALISTS_REFUSED',
      attempts: nativeAttempts,
      failures: nativeFailures,
      finalists: plan.planes.length,
    });
  }
  const { value, ...metrics } = qualified;
  if (!recordSemanticNativeWinner(payload, qualified.plane)) {
    splitCandidates.discard(value.value.candidate);
    throw invalidState('Find parts again before checking this cut.');
  }
  const preview = {
    ...value.value,
    semanticQualification: { ...payload.semanticQualification, ...metrics },
  };
  const registry = semanticScopeBinding(payload, part.mesh, qualified.plane);
  const physical = splitCandidates.resultIdentity(preview.candidate);
  const sourcePartIdentity = new WeakRef(part);
  const authority = issueScopeReceipt(preview, physical, {
    automatic: registry.automatic,
    current: () =>
      registry.current() &&
      residentDocuments.has(payload.source) &&
      residentDocuments.resolvePart(payload.source, partId(payload.partId)) ===
        sourcePartIdentity.deref(),
  });
  splitCandidates.authorizeCommit(preview.candidate, authority.authorizeCommit);
  return { ...value, value: { ...preview, semanticQualification: authority.proof } };
};

function readScopeReceiptId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw invalidState('Choose the current physical preview.');
  const data = payload as Record<string, unknown>;
  if (
    Object.keys(data).length !== 1 ||
    !Object.hasOwn(data, 'receiptId') ||
    typeof data.receiptId !== 'string' ||
    data.receiptId.length > 96
  )
    throw invalidState('Choose the current physical preview.');
  return data.receiptId;
}

export const splitConfirmScopeHandler: OperationHandler<'split/confirm-scope'> = (
  payload,
  context,
) => {
  context.throwIfCancelled();
  const receiptId = readScopeReceiptId(payload);
  const confirmed = confirmScopeReceipt(receiptId, (candidate) =>
    splitCandidates.resultIdentity(candidate),
  );
  recordBoundaryPreview(confirmed.candidate, false);
  return Promise.resolve({
    value: { candidate: confirmed.candidate, semanticQualification: confirmed.proof },
  });
};

export const splitCommitHandler: OperationHandler<'split/commit'> = (payload, context) => {
  context.throwIfCancelled();
  requireConfirmedBoundary(payload.candidate);
  const committed = splitCandidates.prepareCommit(
    payload.transactionId,
    payload.candidate,
    payload.expectedSource,
    partId(payload.expectedPart),
    (document) => ({
      render: buildDocumentRenderSnapshot(document),
      parts: describeParts(document),
      residentBytes: documentByteLength(document),
      triangleCount: documentTriangleCount(document),
      vertexCount: documentVertexCount(document),
      bounds: documentBounds(document),
    }),
  );
  const value = {
    ...committed.summary,
    ...committed.value,
    handle: committed.handle,
    parentRevision: payload.expectedSource.revision,
    recordId: committed.recordId,
  };
  return Promise.resolve({ value, transfer: documentRenderTransferables(value.render) });
};

export const splitDiscardHandler: OperationHandler<'split/discard'> = (payload) => {
  cancelScopeReceipt(payload.candidate);
  return Promise.resolve({ value: { released: splitCandidates.discard(payload.candidate) } });
};

/** These operations expose only bounded authority metadata, never candidate geometry. */
export const splitCommitStatusHandler: OperationHandler<'split/commit-status'> = (payload) =>
  Promise.resolve({ value: splitCandidates.transactionStatus(payload.transactionId) });
export const splitCommitAckHandler: OperationHandler<'split/commit-ack'> = (payload) =>
  Promise.resolve({ value: splitCandidates.ackCommit(payload.transactionId) });
export const splitCommitAbortHandler: OperationHandler<'split/commit-abort'> = (payload) =>
  Promise.resolve({ value: splitCandidates.abortCommit(payload.transactionId) });

export const splitCommitReleaseHandler: OperationHandler<'split/commit-release'> = (payload) =>
  Promise.resolve({ value: splitCandidates.releaseCommitReceipt(payload.transactionId) });
