import { describe, expect, it, vi } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  partId,
  singlePartDocument,
} from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';
import { ResidentDocumentStore, isDocument } from './resident-documents';
import { RepairHistoryStore } from './repair-history';
import { GeometryEditStore } from './geometry-edit';
import { SplitCandidateStore, splitTransactionId } from './split-candidates';
import { splitOpenSurface } from './open-plane-split';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing transaction fixture value.');
  return value;
}

function owner(): {
  resident: ResidentDocumentStore;
  history: RepairHistoryStore;
  edits: GeometryEditStore;
  store: SplitCandidateStore;
  source: ReturnType<ResidentDocumentStore['commit']>;
  document: ReturnType<typeof singlePartDocument>;
  candidate: ReturnType<SplitCandidateStore['resolve']>['candidate'];
  id: string;
} {
  const p = createPositionArray(9),
    i = createIndexArray(3);
  p.set([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  i.set([0, 1, 2]);
  const mesh = { positions: p, indices: i, metadata: {} },
    document = singlePartDocument(mesh),
    resident = new ResidentDocumentStore(),
    history = new RepairHistoryStore(),
    edits = new GeometryEditStore(resident, history),
    store = new SplitCandidateStore(resident, history, edits),
    source = resident.commit(document),
    candidate = store.resolve(
      store.begin(source, partId('part-1')),
      splitOpenSurface(mesh, { origin: [0, 0, 0], normal: [1, 0, 0] }, uncancellable),
      uncancellable,
    ).candidate;
  return {
    resident,
    history,
    edits,
    store,
    source,
    document,
    candidate,
    id: splitTransactionId(candidate, 1),
  };
}
function prepare(o: ReturnType<typeof owner>): ReturnType<SplitCandidateStore['prepareCommit']> {
  return o.store.prepareCommit(
    o.id,
    o.candidate,
    o.source,
    partId('part-1'),
    (d) => d.parts.length,
  );
}
describe('split transaction authority', () => {
  it('stages without resident/history mutation, then ACK publishes exactly one edit', () => {
    const o = owner(),
      record = vi.spyOn(o.history, 'record'),
      r = prepare(o);
    expect(r.handle.revision).toBe(2);
    expect(o.resident.resolve(o.source)).toBe(o.document);
    expect(o.history.undoableFor(o.source.documentId)).toBeUndefined();
    expect(o.store.transactionStatus(o.id).state).toBe('APPLIED_PENDING_ADOPTION');
    const done = o.store.ackCommit(o.id);
    expect(done.state).toBe('FINALIZED');
    expect(isDocument(o.resident.resolve(r.handle))).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(o.store.stats().candidateCount).toBe(0);
    expect(o.store.ackCommit(o.id)).toEqual(done);
    expect(o.store.abortCommit(o.id)).toEqual(done);
    expect(record).toHaveBeenCalledTimes(1);
    expect(o.history.undoableFor(o.source.documentId)?.recordId).toBe(done.recordId);
  });
  it('duplicate prepare has one lock, rebuilds transferable render values and no mutation', () => {
    const o = owner(),
      build = vi.fn(() => new Uint8Array(4));
    const a = o.store.prepareCommit(o.id, o.candidate, o.source, partId('part-1'), build),
      b = o.store.prepareCommit(o.id, o.candidate, o.source, partId('part-1'), build);
    expect(a.handle).toEqual(b.handle);
    expect(a.value).not.toBe(b.value);
    expect(o.resident.resolve(o.source)).toBe(o.document);
    o.store.abortCommit(o.id);
  });
  it('Abort is idempotent, preserves old handle/history, frees candidate and allows a fresh edit', () => {
    const o = owner(),
      history = o.history.undoableFor(o.source.documentId);
    prepare(o);
    const abort = o.store.abortCommit(o.id);
    for (let i = 0; i < 30; i++) {
      expect(o.store.abortCommit(o.id)).toEqual(abort);
      expect(o.store.transactionStatus(o.id)).toEqual(abort);
    }
    expect(o.resident.resolve(o.source)).toBe(o.document);
    expect(o.history.undoableFor(o.source.documentId)).toBe(history);
    expect(o.store.stats().candidateCount).toBe(0);
    expect(() => o.store.begin(o.source, partId('part-1'))).not.toThrow();
    expect(() => o.store.ackCommit(o.id)).toThrow();
  });
  it('preserves a previous Undo entry on Abort', () => {
    const o = owner();
    o.history.record({
      recordId: 'prior',
      kind: 'geometry-edit',
      source: o.source,
      result: o.source,
      part: partId('part-1'),
      planHash: 'prior',
      appliedOperations: [],
      inverse: {
        previousDocument: o.document,
        previousMesh: required(o.document.parts[0]).mesh,
        sourceFaceCount: 1,
        sourceIndexCount: 3,
        byteLength: 48,
      },
    });
    const old = o.history.undoableFor(o.source.documentId);
    prepare(o);
    o.store.abortCommit(o.id);
    expect(o.history.undoableFor(o.source.documentId)).toBe(old);
  });
  it.each([
    'replace',
    'release',
    'releaseAll',
    'import',
    'second-split',
    'other-edit',
    'legacy-commit',
    'discard',
  ] as const)('blocks %s while pending', (kind) => {
    const o = owner();
    prepare(o);
    if (kind === 'discard') expect(o.store.discard(o.candidate)).toBe(false);
    else
      expect(() => {
        if (kind === 'replace') o.resident.replace(o.source, o.document);
        if (kind === 'release') o.resident.release(o.source.documentId);
        if (kind === 'releaseAll') o.resident.releaseAll();
        if (kind === 'import') o.resident.commit(o.document);
        if (kind === 'second-split') o.store.begin(o.source, partId('part-1'));
        if (kind === 'other-edit') o.edits.begin(o.source, partId('part-1'), 'repair');
        if (kind === 'legacy-commit')
          o.store.commit(o.candidate, o.source, partId('part-1'), () => undefined);
      }).toThrow();
    expect(o.resident.resolve(o.source)).toBe(o.document);
    expect(o.store.transactionStatus(o.id).state).toBe('APPLIED_PENDING_ADOPTION');
    o.store.abortCommit(o.id);
  });
  it('refuses a different transaction attempt against a locked candidate', () => {
    const o = owner();
    prepare(o);
    expect(() =>
      o.store.prepareCommit(
        splitTransactionId(o.candidate, 2),
        o.candidate,
        o.source,
        partId('part-1'),
        () => undefined,
      ),
    ).toThrow();
    o.store.abortCommit(o.id);
  });
  it.each([
    'document',
    'revision',
    'part',
    'generation',
    'candidate',
    'mesh',
    'prepared-mesh',
  ] as const)('rejects changed %s binding before acquisition', (kind) => {
    const o = owner();
    const c = { ...o.candidate },
      expected = { ...o.source };
    let part = partId('part-1');
    if (kind === 'document') expected.documentId = 'wrong' as never;
    if (kind === 'revision') expected.revision++;
    if (kind === 'part') part = partId('wrong');
    if (kind === 'generation') c.generation++;
    if (kind === 'candidate') c.candidateId += 'wrong';
    if (kind === 'mesh') required(o.document.parts[0]).mesh.positions[0] = 42;
    if (kind === 'prepared-mesh')
      o.store.preview(c, (d) => {
        required(d.parts[0]).mesh.positions[0] = 42;
      });
    expect(() => o.store.prepareCommit(o.id, c, expected, part, () => undefined)).toThrow();
    expect(o.resident.has(o.source)).toBe(true);
  });
  it('fails stale generation during pending; Abort remains independent of candidate validity', () => {
    const o = owner();
    prepare(o);
    o.edits.invalidate(o.candidate);
    expect(() => o.store.ackCommit(o.id)).toThrow();
    expect(o.store.abortCommit(o.id).state).toBe('ABORTED');
    expect(o.resident.resolve(o.source)).toBe(o.document);
  });
  it('refuses a changed mesh after staging, retaining recovery until Abort', () => {
    const o = owner();
    prepare(o);
    required(o.document.parts[0]).mesh.positions[0] = 2;
    expect(() => o.store.ackCommit(o.id)).toThrow();
    expect(o.store.abortCommit(o.id).state).toBe('ABORTED');
  });
  it('records Abort on render preparation failure and never publishes history', () => {
    const o = owner();
    expect(() =>
      o.store.prepareCommit(o.id, o.candidate, o.source, partId('part-1'), () => {
        throw Error('render');
      }),
    ).toThrow('render');
    expect(o.store.transactionStatus(o.id).state).toBe('ABORTED');
    expect(o.resident.resolve(o.source)).toBe(o.document);
    expect(o.history.undoableFor(o.source.documentId)).toBeUndefined();
  });
  it.each(['ack', 'abort'] as const)('rejects unknown %s and reports UNKNOWN status', (verb) => {
    const o = owner();
    expect(o.store.transactionStatus('unknown').state).toBe('UNKNOWN');
    expect(() =>
      verb === 'ack' ? o.store.ackCommit('unknown') : o.store.abortCommit('unknown'),
    ).toThrow();
  });
  it('refuses transaction ID reuse for a different candidate and a stale repeated Apply', () => {
    const o = owner();
    prepare(o);
    o.store.abortCommit(o.id);
    const old = o.id;
    const candidate = o.store.resolve(
      o.store.begin(o.source, partId('part-1')),
      splitOpenSurface(
        required(o.document.parts[0]).mesh,
        { origin: [0, 0, 0], normal: [1, 0, 0] },
        uncancellable,
      ),
      uncancellable,
    ).candidate;
    expect(() =>
      o.store.prepareCommit(old, candidate, o.source, partId('part-1'), () => undefined),
    ).toThrow();
    expect(() => prepare(o)).toThrow();
  });
  it('bounds pending storage, never evicts an uncertain receipt, and deterministically releases metadata', () => {
    const o = owner(),
      sources = [o.source];
    for (let i = 0; i < 32; i++)
      sources.push(o.resident.commit(singlePartDocument(required(o.document.parts[0]).mesh)));
    const pending: string[] = [];
    for (let i = 0; i < 32; i++) {
      const source = required(sources[i]),
        candidate =
          i === 0
            ? o.candidate
            : o.store.resolve(
                o.store.begin(source, partId('part-1')),
                splitOpenSurface(
                  required(o.document.parts[0]).mesh,
                  { origin: [0, 0, 0], normal: [1, 0, 0] },
                  uncancellable,
                ),
                uncancellable,
              ).candidate;
      const id = splitTransactionId(candidate, 1);
      o.store.prepareCommit(id, candidate, source, partId('part-1'), () => undefined);
      pending.push(id);
    }
    expect(o.store.commitTransactionStats()).toMatchObject({ pending: 32, receipts: 32 });
    const source = required(sources[32]),
      candidate = o.store.resolve(
        o.store.begin(source, partId('part-1')),
        splitOpenSurface(
          required(o.document.parts[0]).mesh,
          { origin: [0, 0, 0], normal: [1, 0, 0] },
          uncancellable,
        ),
        uncancellable,
      ).candidate;
    expect(() =>
      o.store.prepareCommit(
        splitTransactionId(candidate, 1),
        candidate,
        source,
        partId('part-1'),
        () => undefined,
      ),
    ).toThrow('Too many');
    for (const id of pending) {
      expect(o.store.transactionStatus(id).state).toBe('APPLIED_PENDING_ADOPTION');
      o.store.abortCommit(id);
      o.store.releaseCommitReceipt(id);
    }
    o.store.discard(candidate);
    expect(o.store.commitTransactionStats()).toMatchObject({ pending: 0, receipts: 0 });
    expect(o.store.stats().candidateCount).toBe(0);
  });
  it('returns immutable status metadata rather than mutable transaction authority', () => {
    const o = owner();
    prepare(o);
    const status = o.store.transactionStatus(o.id);
    expect(Reflect.set(status, 'state', 'FINALIZED')).toBe(false);
    expect(o.store.transactionStatus(o.id).state).toBe('APPLIED_PENDING_ADOPTION');
    o.store.abortCommit(o.id);
  });
});
