import { expect, it, vi, afterEach } from 'vitest';
import { createIndexArray, createPositionArray, singlePartDocument } from '@cadfixer/mesh-core';
import {
  GeometryWorkerHost,
  GeometryCoordinator,
  createLinkedEndpoints,
  splitTransactionId,
  type MessageEndpoint,
  type OperationName,
} from '@cadfixer/geometry-runtime';
import {
  splitCreateHandler,
  splitCommitHandler,
  splitCommitAckHandler,
  splitCommitAbortHandler,
  splitCommitStatusHandler,
} from '../apps/web/src/workers/split-handlers';
import { repairUndoHandler } from '../apps/web/src/workers/repair-handlers';
import {
  residentDocuments,
  repairHistory,
  splitCandidates,
  buildDocumentRenderSnapshot,
  describeParts,
  documentBounds,
} from '../apps/web/src/workers/stl-handlers';
import { WorkspaceStore } from '../apps/web/src/state/workspace-store';
import { adoptSplitCommit } from '../apps/web/src/runtime/split-commit-transaction';
import type { GeometryClient } from '../apps/web/src/runtime/geometry-client';

afterEach(() => vi.restoreAllMocks());
async function harness(): Promise<{
  source: ReturnType<typeof residentDocuments.commit>;
  document: ReturnType<typeof singlePartDocument>;
  workspace: WorkspaceStore;
  preview: Awaited<ReturnType<typeof splitCreateHandler>>['value'];
  id: string;
  coordinator: () => GeometryCoordinator;
  reconnect: () => void;
  close: () => void;
  fault: (operation: OperationName, mode: 'throw' | 'drop') => Promise<void>;
  client: GeometryClient;
}> {
  const positions = createPositionArray(9),
    indices = createIndexArray(3);
  positions.set([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  indices.set([0, 1, 2]);
  const document = singlePartDocument({ positions, indices, metadata: {} }),
    source = residentDocuments.commit(document),
    workspace = new WorkspaceStore();
  workspace.commitImport(workspace.beginImport('open.stl'), {
    handle: source,
    parts: describeParts(document),
    render: buildDocumentRenderSnapshot(document),
    source: {
      fileName: 'open.stl',
      fileBytes: 134,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: documentBounds(document),
    triangleCount: 1,
    vertexCount: 3,
    residentBytes: 48,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
  });
  const [clientEndpoint, workerEndpoint] = createLinkedEndpoints(),
    operations = new Map<string, OperationName>();
  let fail: { operation: OperationName; mode: 'throw' | 'drop'; done: () => void } | undefined;
  const clientPort: MessageEndpoint = {
    ...clientEndpoint,
    postMessage(message, transfer): void {
      const m = message as { id: string; operation?: OperationName };
      if (m.operation) operations.set(m.id, m.operation);
      clientEndpoint.postMessage(message, transfer);
    },
  };
  const workerPort: MessageEndpoint = {
    ...workerEndpoint,
    postMessage(message, transfer): void {
      const m = message as { kind: string; id: string };
      if (m.kind === 'result' && fail && operations.get(m.id) === fail.operation) {
        const f = fail;
        fail = undefined;
        f.done();
        if (f.mode === 'throw') throw Error('Injected response delivery failure');
        return;
      }
      workerEndpoint.postMessage(message, transfer);
    },
  };
  const host = new GeometryWorkerHost(workerPort);
  host.register('split/create', splitCreateHandler);
  host.register('split/commit', splitCommitHandler);
  host.register('split/commit-ack', splitCommitAckHandler);
  host.register('split/commit-abort', splitCommitAbortHandler);
  host.register('split/commit-status', splitCommitStatusHandler);
  host.register('repair/undo', repairUndoHandler);
  const stop = host.start();
  let coordinator = new GeometryCoordinator(clientPort, { onDiagnostic: (): void => undefined });
  const preview = await coordinator.dispatch('split/create', {
    source,
    partId: 'part-1',
    request: { plane: { origin: [0, 0, 0], normal: [1, 0, 0] }, connector: { kind: 'none' } },
  }).promise;
  const id = splitTransactionId(preview.candidate, 1);
  const client = {
    ackSplitCommit: (transactionId: string) =>
      coordinator.dispatch('split/commit-ack', { transactionId }),
    abortSplitCommit: (transactionId: string) =>
      coordinator.dispatch('split/commit-abort', { transactionId }),
    splitCommitStatus: (transactionId: string) =>
      coordinator.dispatch('split/commit-status', { transactionId }),
  } as GeometryClient;
  return {
    source,
    document,
    workspace,
    preview,
    id,
    client,
    coordinator: () => coordinator,
    reconnect: (): void => {
      coordinator.dispose();
      coordinator = new GeometryCoordinator(clientPort, { onDiagnostic: (): void => undefined });
    },
    close: (): void => {
      const status = splitCandidates.transactionStatus(id);
      if (status.state === 'APPLIED_PENDING_ADOPTION' || status.state === 'PREPARED')
        splitCandidates.abortCommit(id);
      coordinator.dispose();
      stop();
    },
    fault: (operation, mode) =>
      new Promise<void>((resolve) => {
        fail = { operation, mode, done: resolve };
      }),
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing transaction fixture value.');
  return value;
}

function pending(
  h: Awaited<ReturnType<typeof harness>>,
): ReturnType<GeometryCoordinator['dispatch']> & { transactionId: string } {
  return {
    ...h.coordinator().dispatch('split/commit', {
      transactionId: h.id,
      candidate: h.preview.candidate,
      expectedSource: h.source,
      expectedPart: 'part-1',
    }),
    transactionId: h.id,
  };
}

it('lost pending response is recoverable by a NEW coordinator using only the pre-known ID', async () => {
  const h = await harness();
  try {
    h.workspace.splitAdoptionCheckpoint(h.id);
    const lost = h.fault('split/commit', 'drop'),
      op = pending(h);
    void op.promise.catch(() => undefined);
    await lost;
    expect(residentDocuments.resolve(h.source)).toBe(h.document);
    expect(repairHistory.undoableFor(h.source.documentId)).toBeUndefined();
    h.reconnect();
    const status = await h.client.splitCommitStatus(h.id).promise;
    expect(status.state).toBe('APPLIED_PENDING_ADOPTION');
    expect(status.source).toEqual(h.source);
    const aborted = await h.client.abortSplitCommit(h.id).promise;
    expect(aborted.state).toBe('ABORTED');
    h.workspace.reconcileSplitAdoption(aborted);
    expect(h.workspace.getSnapshot().model?.handle).toEqual(h.source);
    expect(residentDocuments.resolve(h.source)).toBe(h.document);
    expect(splitCandidates.stats().candidateCount).toBe(0);
  } finally {
    h.close();
  }
});
it('lost ACK response keeps NEW authority and exactly one history publication across reconnect/retry', async () => {
  const h = await harness();
  try {
    const record = vi.spyOn(repairHistory, 'record'),
      result = (await pending(h).promise) as Awaited<
        ReturnType<typeof splitCommitHandler>
      >['value'];
    h.workspace.splitAdoptionCheckpoint(h.id);
    expect(h.workspace.applySplitResult(result)).toBe(true);
    expect(h.workspace.pendingSplitAdoption()?.proposed).toEqual(result.handle);
    const lost = h.fault('split/commit-ack', 'drop'),
      ack = h.client.ackSplitCommit(h.id);
    void ack.promise.catch(() => undefined);
    await lost;
    h.reconnect();
    const status = await h.client.splitCommitStatus(h.id).promise;
    expect(status.state).toBe('FINALIZED');
    h.workspace.reconcileSplitAdoption(status);
    expect(status.handle).toEqual(result.handle);
    expect((await h.client.ackSplitCommit(h.id).promise).state).toBe('FINALIZED');
    expect((await h.client.abortSplitCommit(h.id).promise).state).toBe('FINALIZED');
    expect(record).toHaveBeenCalledTimes(1);
    expect(h.workspace.getSnapshot().model?.handle).toEqual(result.handle);
    expect(residentDocuments.resolve(result.handle)).toHaveProperty('parts.length', 2);
    const undo = await h
      .coordinator()
      .dispatch('repair/undo', { handle: result.handle, recordId: result.recordId }).promise;
    expect(h.workspace.applyUndoResult(undo)).toBe(true);
    expect(residentDocuments.resolve(undo.handle)).toBe(h.document);
  } finally {
    h.close();
  }
});
it('ACK delivery throw queries FINALIZED instead of rolling an adopted UI back', async () => {
  const h = await harness();
  try {
    const lost = h.fault('split/commit-ack', 'throw');
    const result = await adoptSplitCommit(
      h.client,
      pending(h) as ReturnType<GeometryClient['commitSplit']>,
      (r) => h.workspace.applySplitResult(r),
      h.workspace.splitAdoptionCheckpoint(),
    );
    await lost;
    expect(h.workspace.getSnapshot().model?.handle).toEqual(result.handle);
    expect(residentDocuments.resolve(result.handle)).toHaveProperty('parts.length', 2);
    expect(splitCandidates.transactionStatus(h.id).state).toBe('FINALIZED');
  } finally {
    h.close();
  }
});
it('a UI write followed by throw restores exact state and old handle, including local revision metadata', async () => {
  const h = await harness();
  try {
    const before = h.workspace.getSnapshot();
    await expect(
      adoptSplitCommit(
        h.client,
        pending(h) as ReturnType<GeometryClient['commitSplit']>,
        (r) => {
          expect(h.workspace.applySplitResult(r)).toBe(true);
          throw Error('after local write');
        },
        h.workspace.splitAdoptionCheckpoint(),
      ),
    ).rejects.toThrow('after local write');
    expect(h.workspace.getSnapshot()).toBe(before);
    expect(residentDocuments.resolve(required(before.model).handle)).toBe(h.document);
    expect(splitCandidates.transactionStatus(h.id).state).toBe('ABORTED');
    expect(repairHistory.undoableFor(h.source.documentId)).toBeUndefined();
  } finally {
    h.close();
  }
});
it('duplicate pending Apply, ACK and Abort are idempotent through real worker handlers', async () => {
  const h = await harness();
  try {
    const a = (await pending(h).promise) as Awaited<ReturnType<typeof splitCommitHandler>>['value'],
      b = (await pending(h).promise) as typeof a;
    expect(a.handle).toEqual(b.handle);
    expect(h.workspace.applySplitResult(b)).toBe(true);
    const record = vi.spyOn(repairHistory, 'record');
    for (let i = 0; i < 3; i++)
      expect((await h.client.ackSplitCommit(h.id).promise).state).toBe('FINALIZED');
    for (let i = 0; i < 3; i++)
      expect((await h.client.abortSplitCommit(h.id).promise).state).toBe('FINALIZED');
    expect(record).toHaveBeenCalledTimes(1);
    expect(residentDocuments.resolve(b.handle)).toHaveProperty('parts.length', 2);
  } finally {
    h.close();
  }
});
it('history publication failure retains OLD worker authority and restores prior history before retry', async () => {
  const h = await harness();
  try {
    await pending(h).promise;
    const before = repairHistory.stats(),
      record = repairHistory.record.bind(repairHistory);
    const fault = vi.spyOn(repairHistory, 'record').mockImplementation((input) => {
      record(input);
      throw Error('history publish');
    });
    await expect(h.client.ackSplitCommit(h.id).promise).rejects.toThrow('history publish');
    expect(residentDocuments.resolve(h.source)).toBe(h.document);
    expect(repairHistory.stats()).toEqual(before);
    expect(splitCandidates.transactionStatus(h.id).state).toBe('APPLIED_PENDING_ADOPTION');
    fault.mockRestore();
    expect((await h.client.abortSplitCommit(h.id).promise).state).toBe('ABORTED');
    expect(h.workspace.getSnapshot().model?.handle).toEqual(h.source);
  } finally {
    h.close();
  }
});
it('receipt release refuses pending cleanup and preserves uncertain terminal receipts until explicit observation', async () => {
  const h = await harness();
  try {
    await pending(h).promise;
    expect(() => splitCandidates.releaseCommitReceipt(h.id)).toThrow();
    const done = await h.client.abortSplitCommit(h.id).promise;
    for (let i = 0; i < 20; i++) expect(splitCandidates.transactionStatus(h.id)).toEqual(done);
    expect(splitCandidates.releaseCommitReceipt(h.id)).toEqual(done);
    expect(splitCandidates.transactionStatus(h.id).state).toBe('UNKNOWN');
    await expect(pending(h).promise).rejects.toThrow();
  } finally {
    h.close();
  }
});
it('UI adoption remains unpublished until ACK, and stale reconciliation cannot publish it', async () => {
  const h = await harness();
  try {
    const before = h.workspace.getSnapshot(),
      checkpoint = h.workspace.splitAdoptionCheckpoint(h.id);
    const prepared = (await pending(h).promise) as Awaited<
      ReturnType<typeof splitCommitHandler>
    >['value'];
    expect(h.workspace.applySplitResult(prepared)).toBe(true);
    expect(h.workspace.getSnapshot()).toBe(before);
    expect(h.workspace.pendingSplitAdoption()?.proposed).toEqual(prepared.handle);
    expect(() => {
      h.workspace.reconcileSplitAdoption({
        ...splitCandidates.transactionStatus(h.id),
        transactionId: 'spoofed',
      });
    }).toThrow();
    expect(h.workspace.getSnapshot()).toBe(before);
    const final = await h.client.ackSplitCommit(h.id).promise;
    h.workspace.reconcileSplitAdoption(final);
    expect(h.workspace.getSnapshot().model?.handle).toEqual(prepared.handle);
    checkpoint(); // terminal publication cannot subsequently roll the model back
    expect(h.workspace.getSnapshot().model?.handle).toEqual(prepared.handle);
  } finally {
    h.close();
  }
});
it('worker-session loss invalidates staged and published UI authority rather than inventing persistence', async () => {
  const h = await harness();
  try {
    h.workspace.splitAdoptionCheckpoint(h.id);
    const prepared = (await pending(h).promise) as Awaited<
      ReturnType<typeof splitCommitHandler>
    >['value'];
    expect(h.workspace.applySplitResult(prepared)).toBe(true);
    h.workspace.loseGeometrySession('Worker terminated');
    expect(h.workspace.getSnapshot().model).toBeUndefined();
    expect(h.workspace.pendingSplitAdoption()).toBeUndefined();
    // This is the UI invalidation policy; the in-process test host is explicitly
    // cleaned up below. It is not a claim of real worker-crash persistence.
  } finally {
    h.close();
  }
});
it('Abort preserves a real preceding split Undo, and Undo is refused while the next split is pending', async () => {
  const h = await harness();
  try {
    const first = await adoptSplitCommit(
      h.client,
      pending(h) as ReturnType<GeometryClient['commitSplit']>,
      (r) => h.workspace.applySplitResult(r),
      h.workspace.splitAdoptionCheckpoint(h.id),
    );
    const current = residentDocuments.resolve(first.handle),
      history = repairHistory.undoableFor(first.handle.documentId);
    const second = await h.coordinator().dispatch('split/create', {
      source: first.handle,
      partId: first.pieceAId,
      request: { plane: { origin: [0, 0, 0], normal: [0, 1, 0] }, connector: { kind: 'none' } },
    }).promise;
    const id = splitTransactionId(second.candidate, 1),
      operation = h.coordinator().dispatch('split/commit', {
        transactionId: id,
        candidate: second.candidate,
        expectedSource: first.handle,
        expectedPart: first.pieceAId,
      });
    await operation.promise;
    await expect(
      h.coordinator().dispatch('repair/undo', { handle: first.handle, recordId: first.recordId })
        .promise,
    ).rejects.toThrow('awaiting adoption');
    expect(repairHistory.undoableFor(first.handle.documentId)).toBe(history);
    await expect(
      adoptSplitCommit(
        h.client,
        { ...operation, transactionId: id },
        () => false,
        h.workspace.splitAdoptionCheckpoint(id),
      ),
    ).rejects.toThrow('model changed');
    expect(residentDocuments.resolve(first.handle)).toBe(current);
    expect(h.workspace.getSnapshot().model?.handle).toEqual(first.handle);
    expect(repairHistory.undoableFor(first.handle.documentId)).toBe(history);
    const undo = await h
      .coordinator()
      .dispatch('repair/undo', { handle: first.handle, recordId: first.recordId }).promise;
    expect(h.workspace.applyUndoResult(undo)).toBe(true);
    expect(residentDocuments.resolve(undo.handle)).toBe(h.document);
    expect(h.workspace.getSnapshot().model?.handle).toEqual(undo.handle);
  } finally {
    h.close();
  }
});
