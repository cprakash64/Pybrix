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

export const splitCreateHandler: OperationHandler<'split/create'> = async (payload, context) => {
  context.throwIfCancelled();
  const sourcePart = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(sourcePart)) throw sourcePart;
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

export const splitCommitHandler: OperationHandler<'split/commit'> = (payload, context) => {
  context.throwIfCancelled();
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

export const splitDiscardHandler: OperationHandler<'split/discard'> = (payload) =>
  Promise.resolve({ value: { released: splitCandidates.discard(payload.candidate) } });

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required bounded geometry evidence is missing.');
  return value;
}
