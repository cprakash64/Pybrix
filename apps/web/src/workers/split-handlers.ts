import {
  issueScopeReceipt,
  confirmScopeReceipt,
  cancelScopeReceipt,
  releaseScopeReceipt,
} from './semantic-scope-authority';
import { semanticScopeBinding } from './semantic-native-finalists';
import { qualifySemanticFinalists } from '@cadfixer/auto-split';
import {
  semanticNativePlan,
  recordSemanticNativeWinner,
  recordBoundaryPreview,
  requireConfirmedBoundary,
} from './semantic-native-finalists';
import { isAppError, AppErrorCode, invalidState } from '@cadfixer/shared';
import { documentTriangleCount, documentVertexCount, partId } from '@cadfixer/mesh-core';
import {
  documentByteLength,
  splitWithConnectors,
  SplitStage,
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
  readonly phase: BooleanOperationPhase | 'TERMINAL';
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

/** Physical sizing only supports an orthogonal uniform source transform. */
function uniformPhysicalScale(t: readonly number[]): number {
  const axes = [
      [defined(t[0]), defined(t[1]), defined(t[2])],
      [defined(t[3]), defined(t[4]), defined(t[5])],
      [defined(t[6]), defined(t[7]), defined(t[8])],
    ],
    lengths = axes.map((a) => Math.hypot(...a)),
    scale = defined(lengths[0]);
  if (!(scale > 0) || lengths.some((x) => Math.abs(x - scale) > scale * 1e-6)) return NaN;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      if (
        Math.abs(defined(axes[i]).reduce((v, x, k) => v + x * defined(defined(axes[j])[k]), 0)) >
        scale * scale * 1e-6
      )
        return NaN;
  return scale;
}

const createSingleSplit: OperationHandler<'split/create'> = async (payload, context) => {
  context.throwIfCancelled();
  const sourcePart = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(sourcePart)) throw sourcePart;
  releaseScopeReceipt(payload.source.documentId);
  const ticket = splitCandidates.begin(payload.source, sourcePart.id);
  let booleanIndex = 0;
  try {
    context.reportProgress(0.02, 'Preparing cut…');
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
      payload.request,
      context.cancellation,
      (stage) => {
        context.reportProgress(STAGE_PROGRESS[stage][0], STAGE_PROGRESS[stage][1]);
      },
      uniformPhysicalScale(sourcePart.transform),
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
  if (!qualified)
    throw invalidState('No safe split found.', {
      code: 'SEMANTIC_NATIVE_FINALISTS_REFUSED',
      attempts: nativeAttempts,
      failures: nativeFailures,
      finalists: plan.planes.length,
    });
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
  const committed = splitCandidates.commit(
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

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required bounded geometry evidence is missing.');
  return value;
}
