import { adoptSplitCommit } from '../apps/web/src/runtime/split-commit-transaction';
import type { GeometryClient } from '../apps/web/src/runtime/geometry-client';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  singlePartDocument,
  partId,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import {
  GeometryCoordinator,
  splitTransactionId,
  GeometryWorkerHost,
  createLinkedEndpoints,
  isDocument,
  type MessageEndpoint,
  type SplitCommitResult,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../apps/web/src/workers/manifold-boolean-backend';
import { repairUndoHandler } from '../apps/web/src/workers/repair-handlers';
import {
  splitCreateHandler,
  splitCommitHandler,
  splitDiscardHandler,
  splitCommitStatusHandler,
  splitCommitAbortHandler,
  splitCommitAckHandler,
} from '../apps/web/src/workers/split-handlers';
import {
  booleanOperations,
  residentDocuments,
  splitCandidates,
  buildDocumentRenderSnapshot,
  describeParts,
  documentBounds,
} from '../apps/web/src/workers/stl-handlers';
import { WorkspaceStore } from '../apps/web/src/state/workspace-store';

const evidence = process.env.PYBRIX_TRANSACTION_EVIDENCE;
const observations: unknown[] = [];
afterEach(() => {
  vi.restoreAllMocks();
});
function cube(): CanonicalMesh {
  const positions = createPositionArray(24),
    indices = createIndexArray(36);
  positions.set([
    -10, -10, -10, 10, -10, -10, -10, 10, -10, 10, 10, -10, -10, -10, 10, 10, -10, 10, -10, 10, 10,
    10, 10, 10,
  ]);
  indices.set([
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3,
    7, 1, 7, 5,
  ]);
  return { positions, indices, metadata: {} };
}

// Original before-integration safety assertions, now exercised through transaction recovery. Real baseline closed-solid handler/native
// result and candidate/commit stores; only the nested-worker transport is bridged
// to the same pinned native backend. No replacement-kernel success is claimed.
it.each(['success-undo', 'delivery-throw', 'adoption-refuse', 'adoption-throw'] as const)(
  'resident authority survives %s and the existing cleanup path',
  async (fault) => {
    const native = await createManifoldBooleanBackend(
      readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm'),
    );
    let nativeCalls = 0;
    vi.spyOn(booleanOperations, 'run').mockImplementation((kind, a, b, cancellation) => {
      nativeCalls += 1;
      return native.operate(kind, a, b, cancellation);
    });
    const document = singlePartDocument(cube()),
      source = residentDocuments.commit(document),
      part = partId('part-1');
    const workspace = new WorkspaceStore();
    workspace.commitImport(workspace.beginImport('closed-cube.stl'), {
      handle: source,
      parts: describeParts(document),
      render: buildDocumentRenderSnapshot(document),
      source: {
        fileName: 'closed-cube.stl',
        fileBytes: 684,
        formatId: 'stl',
        encoding: 'binary',
        unit: undefined,
        unsupportedFeatures: [],
        externalReferences: [],
        importedAt: 0,
      },
      bounds: documentBounds(document),
      triangleCount: 12,
      vertexCount: 8,
      residentBytes: 240,
      validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
      warnings: [],
    });
    const [client, worker] = createLinkedEndpoints();
    let deliveryAttempted = false;
    const faultEndpoint: MessageEndpoint = {
      ...worker,
      postMessage(message, transfer) {
        if (
          fault === 'delivery-throw' &&
          !deliveryAttempted &&
          (message as { kind?: string }).kind === 'result' &&
          'recordId' in (message as { value: object }).value
        ) {
          deliveryAttempted = true;
          throw Error('Injected terminal split result delivery failure');
        }
        worker.postMessage(message, transfer);
      },
    };
    const host = new GeometryWorkerHost(faultEndpoint);
    host.register('split/create', splitCreateHandler);
    host.register('split/commit', splitCommitHandler);
    host.register('split/commit-status', splitCommitStatusHandler);
    host.register('split/commit-ack', splitCommitAckHandler);
    host.register('split/commit-abort', splitCommitAbortHandler);
    host.register('split/discard', splitDiscardHandler);
    host.register('repair/undo', repairUndoHandler);
    const stop = host.start(),
      coordinator = new GeometryCoordinator(client, { onDiagnostic: (): void => undefined });
    try {
      const preview = await coordinator.dispatch('split/create', {
        source,
        partId: part,
        request: { plane: { origin: [0, 0, 0], normal: [1, 0, 0] }, connector: { kind: 'none' } },
      }).promise;
      expect(nativeCalls).toBe(0);
      expect(residentDocuments.resolve(source)).toBe(document);
      expect(splitCandidates.preview(preview.candidate, (d) => d.parts.length)).toBe(2);
      const originalAdoption = workspace.applySplitResult.bind(workspace);
      const transactionId = splitTransactionId(preview.candidate, 1);
      const recoveryClient = {
        ackSplitCommit: (transactionId: string) =>
          coordinator.dispatch('split/commit-ack', { transactionId }),
        abortSplitCommit: (transactionId: string) =>
          coordinator.dispatch('split/commit-abort', { transactionId }),
        splitCommitStatus: (transactionId: string) =>
          coordinator.dispatch('split/commit-status', { transactionId }),
      } as GeometryClient;
      let result: SplitCommitResult | undefined,
        error: string | undefined,
        adopted = false;
      try {
        const operation = coordinator.dispatch('split/commit', {
          transactionId,
          candidate: preview.candidate,
          expectedSource: source,
          expectedPart: part,
        });
        if (fault === 'adoption-refuse')
          vi.spyOn(workspace, 'applySplitResult').mockReturnValue(false);
        if (fault === 'adoption-throw')
          vi.spyOn(workspace, 'applySplitResult').mockImplementation(() => {
            throw Error('Injected UI adoption failure');
          });
        result = await adoptSplitCommit(
          recoveryClient,
          { ...operation, transactionId },
          (prepared) => {
            adopted = workspace.applySplitResult(prepared);
            return adopted;
          },
          workspace.splitAdoptionCheckpoint(),
        );
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      // Existing workflow cleanup is best-effort split/discard, not rollback.
      const cleanup = await coordinator.dispatch('split/discard', { candidate: preview.candidate })
        .promise;
      let retryRejected = false;
      try {
        await coordinator.dispatch('split/commit', {
          transactionId,
          candidate: preview.candidate,
          expectedSource: source,
          expectedPart: part,
        }).promise;
      } catch {
        retryRejected = true;
      }
      const workerAtSource = residentDocuments.resolve(source),
        next = { ...source, revision: source.revision + 1 },
        workerAfter = residentDocuments.resolve(next);
      const row = {
        fault,
        source,
        observedWorkerHandle: {
          documentId: source.documentId,
          revision: residentDocuments.revisionOf(source.documentId),
        },
        nativeCalls,
        previewNonmutating: true,
        deliveryAttempted,
        clientReceivedResult: result !== undefined,
        adopted,
        error,
        cleanupReleased: cleanup.released,
        retryRejected,
        uiHandle: workspace.getSnapshot().model?.handle,
        workerOriginalPreserved: workerAtSource === document,
        workerHasTwoPieces: isDocument(workerAfter) && workerAfter.parts.length === 2,
        sourceHandleStale: !isDocument(workerAtSource),
        automaticRecovery: fault !== 'success-undo' && workerAtSource === document,
      };
      let positiveUndoRestored: boolean | undefined;
      if (fault === 'success-undo' && result) {
        expect(adopted).toBe(true);
        const undo = await coordinator.dispatch('repair/undo', {
          handle: result.handle,
          recordId: result.recordId,
        }).promise;
        expect(workspace.applyUndoResult(undo)).toBe(true);
        positiveUndoRestored = residentDocuments.resolve(undo.handle) === document;
        expect(positiveUndoRestored).toBe(true);
      }
      observations.push({ ...row, positiveUndoRestored });
      if (evidence)
        writeFileSync(
          join(evidence, 'DELIVERY_ADOPTION_FAULT_OBSERVATIONS.json'),
          JSON.stringify(
            {
              phase: 'TRANSACTION_RECOVERY_NO_KERNEL_CHANGE',
              method:
                'Actual baseline split/create→closed native path→candidate store→split/commit→GeometryWorkerHost→GeometryCoordinator→WorkspaceStore. Injected delivery/adoption faults only. Linked transport proves sequencing and synchronous postMessage throw; not physical browser buffer transfer.',
              rows: observations,
            },
            null,
            2,
          ),
        );
      if (fault === 'success-undo') return;
      expect(workspace.getSnapshot().model?.handle).toEqual(source);
      expect(cleanup.released).toBe(false);
      expect(retryRejected).toBe(true);
      // Required safety invariant. Known if this fails: worker committed, UI did
      // not adopt, candidate consumed and discard cannot restore resident state.
      expect(
        workerAtSource,
        'original worker document must survive failed delivery/adoption or be recovered by existing cleanup',
      ).toBe(document);
      // Recovery must permit a real subsequent edit, not only unlock a flag.
      workspace.applySplitResult = originalAdoption;
      const nextPreview = await coordinator.dispatch('split/create', {
        source,
        partId: part,
        request: { plane: { origin: [0, 0, 0], normal: [1, 0, 0] }, connector: { kind: 'none' } },
      }).promise;
      const nextId = splitTransactionId(nextPreview.candidate, 1);
      const nextOperation = coordinator.dispatch('split/commit', {
        transactionId: nextId,
        candidate: nextPreview.candidate,
        expectedSource: source,
        expectedPart: part,
      });
      const successful = await adoptSplitCommit(
        recoveryClient,
        { ...nextOperation, transactionId: nextId },
        (r) => workspace.applySplitResult(r),
        workspace.splitAdoptionCheckpoint(),
      );
      expect(workspace.getSnapshot().model?.handle).toEqual(successful.handle);
      expect(residentDocuments.resolve(successful.handle)).toHaveProperty('parts.length', 2);
      const restored = await coordinator.dispatch('repair/undo', {
        handle: successful.handle,
        recordId: successful.recordId,
      }).promise;
      expect(workspace.applyUndoResult(restored)).toBe(true);
      expect(residentDocuments.resolve(restored.handle)).toBe(document);
      expect(workspace.getSnapshot().model?.handle).toEqual(restored.handle);
    } finally {
      coordinator.dispose();
      stop();
    }
  },
);
