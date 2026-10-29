import { afterEach, expect, it, vi } from 'vitest';
import type * as ScopeAuthority from './semantic-scope-authority';
import {
  ResidentDocumentStore,
  RepairHistoryStore,
  GeometryEditStore,
  SplitCandidateStore,
  splitOpenSurface,
  type SplitCreateResult,
} from '@cadfixer/geometry-runtime';
import {
  createIndexArray,
  createPositionArray,
  partId,
  singlePartDocument,
} from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';

async function runtime(automatic: boolean): Promise<{
  authority: typeof ScopeAuthority;
  store: SplitCandidateStore;
  preview: SplitCreateResult;
  source: ReturnType<ResidentDocumentStore['commit']>;
  issued: ReturnType<(typeof ScopeAuthority)['issueScopeReceipt']>;
  receiptId: string;
}> {
  // Reload actual Worker receipt module state as well as constructing independent
  // real resident/edit/candidate owners. No runtime identity is mocked or edited.
  vi.resetModules();
  const authority = await import('./semantic-scope-authority');
  const resident = new ResidentDocumentStore(),
    history = new RepairHistoryStore(),
    edits = new GeometryEditStore(resident, history),
    store = new SplitCandidateStore(resident, history, edits),
    positions = createPositionArray(9),
    indices = createIndexArray(3);
  positions.set([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  indices.set([0, 1, 2]);
  const mesh = { positions, indices, metadata: { sourceFormat: 'stl' } },
    source = resident.commit(singlePartDocument(mesh)),
    plane = { normal: [1, 0, 0] as const, origin: [0, 0, 0] as const },
    summary = store.resolve(
      store.begin(source, partId('part-1')),
      splitOpenSurface(mesh, plane, uncancellable),
      uncancellable,
    );
  // Render is irrelevant to receipt issuance; this synthetic fixture performs no
  // native qualification and claims no semantic certificate/quality result.
  const preview = {
    ...summary,
    semanticQualification: {
      candidateId: 'synthetic-semantic',
      preparationId: 1,
      plane,
      attempts: 1,
      failures: 0,
      winnerIndex: 0,
      milliseconds: 0,
    },
  } as SplitCreateResult;
  const issued = authority.issueScopeReceipt(preview, store.resultIdentity(preview.candidate), {
    automatic,
    current: () => true,
  });
  store.authorizeCommit(preview.candidate, issued.authorizeCommit);
  const receiptId = issued.proof.scopeConfirmation?.receiptId;
  if (!receiptId) throw Error('Missing fixture receipt');
  return { authority, store, preview, source, issued, receiptId };
}
const owners: Awaited<ReturnType<typeof runtime>>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.authority.releaseScopeReceipt();
});
it.each([false, true])(
  'receipt and closure cannot cross actual reconstructed owners (automatic=%s)',
  async (automatic) => {
    const a = await runtime(automatic);
    owners.push(a);
    const b = await runtime(automatic);
    owners.push(b);
    expect(() =>
      b.authority.confirmScopeReceipt(a.receiptId, (h) => b.store.resultIdentity(h)),
    ).toThrow();
    expect(() => {
      b.store.authorizeCommit(a.preview.candidate, a.issued.authorizeCommit);
    }).toThrow();
    expect(() =>
      b.store.commit(a.preview.candidate, b.source, partId('part-1'), (d) => d),
    ).toThrow();
    if (!automatic) {
      expect(() =>
        b.store.commit(b.preview.candidate, b.source, partId('part-1'), (d) => d),
      ).toThrow();
      // An old discard must not cancel the replacement's receipt either.
      b.authority.cancelScopeReceipt(a.preview.candidate);
      b.authority.confirmScopeReceipt(b.receiptId, (h) => b.store.resultIdentity(h));
    }
    expect(
      b.store.commit(b.preview.candidate, b.source, partId('part-1'), (d) => d).handle.revision,
    ).toBe(2);
    expect(() => {
      b.issued.authorizeCommit();
    }).toThrow();
  },
);
