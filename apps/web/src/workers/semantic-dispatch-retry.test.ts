import { afterEach, expect, it, vi } from 'vitest';
import {
  GeometryCoordinator,
  GeometryWorkerHost,
  createLinkedEndpoints,
  splitOpenSurface,
  type SplitCreateResult,
} from '@cadfixer/geometry-runtime';
import {
  createIndexArray,
  createPositionArray,
  partId,
  singlePartDocument,
} from '@cadfixer/mesh-core';
import { invalidState, uncancellable } from '@cadfixer/shared';
import type { Suggestion } from '@cadfixer/auto-split';
import type * as StlHandlers from './stl-handlers';
import type * as NativeFinalists from './semantic-native-finalists';

async function owner(): Promise<{
  commit: (expectedPart?: string) => ReturnType<GeometryCoordinator['dispatch']>;
  accepted: () => number;
  preview: SplitCreateResult;
  stores: typeof StlHandlers;
  registry: typeof NativeFinalists;
  source: ReturnType<(typeof StlHandlers)['residentDocuments']['commit']>;
  document: ReturnType<typeof singlePartDocument>;
  suggestions: readonly Suggestion[];
  stop: () => void;
}> {
  vi.resetModules();
  const stores = await import('./stl-handlers');
  const registry = await import('./semantic-native-finalists');
  const authority = await import('./semantic-scope-authority');
  const handlers = await import('./split-handlers');
  const positions = createPositionArray(9),
    indices = createIndexArray(3);
  positions.set([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  indices.set([0, 1, 2]);
  const mesh = { positions, indices, metadata: { sourceFormat: 'stl' } };
  const document = singlePartDocument(mesh),
    source = stores.residentDocuments.commit(document);
  const part = partId('part-1'),
    plane = { origin: [0, 0, 0] as const, normal: [1, 0, 0] as const };
  const summary = stores.splitCandidates.resolve(
    stores.splitCandidates.begin(source, part),
    splitOpenSurface(mesh, plane, uncancellable),
    uncancellable,
  );
  const suggestions: readonly Suggestion[] = [
    {
      id: 'semantic',
      label: 'test piece',
      family: 'semantic',
      operation: 'PLANE',
      status: 'SUGGESTED',
      reason: 'CLEAR',
      quality: 'SUGGESTED',
      components: [],
      plane,
      semanticFinalists: [plane],
    },
  ];
  registry.registerSemanticNativeFinalists(source, part, mesh, 1, suggestions);
  const request = {
    source,
    partId: part,
    request: { plane, connector: { kind: 'none' as const } },
    semanticQualification: { candidateId: 'semantic', preparationId: 1 },
  };
  // Zero-native validated synthetic split. These are actual production registry,
  // receipt, store and commit handlers, not a new semantic qualification claim.
  const preview = {
    ...summary,
    semanticQualification: {
      ...request.semanticQualification,
      plane,
      attempts: 1,
      failures: 0,
      winnerIndex: 0,
      milliseconds: 0,
    },
  } as SplitCreateResult;
  const binding = registry.semanticScopeBinding(request, mesh, plane);
  const issued = authority.issueScopeReceipt(
    preview,
    stores.splitCandidates.resultIdentity(preview.candidate),
    {
      automatic: binding.automatic,
      current: () => binding.current() && stores.residentDocuments.has(source),
    },
  );
  stores.splitCandidates.authorizeCommit(preview.candidate, issued.authorizeCommit);
  const id = issued.proof.scopeConfirmation?.receiptId;
  if (!id) throw Error('Missing fixture receipt');
  authority.confirmScopeReceipt(id, (h) => stores.splitCandidates.resultIdentity(h));
  const [client, worker] = createLinkedEndpoints();
  const host = new GeometryWorkerHost(worker);
  host.register('split/commit', handlers.splitCommitHandler);
  const stopHost = host.start();
  let first = true,
    accepted = 0;
  const coordinator = new GeometryCoordinator(
    {
      ...client,
      postMessage: (message, transfer): void => {
        if (first) {
          first = false;
          throw invalidState('Not submitted');
        }
        accepted++;
        client.postMessage(message, transfer);
      },
    },
    { onDiagnostic: (): void => undefined },
  );
  return {
    commit: (expectedPart: string = part) =>
      coordinator.dispatch('split/commit', {
        candidate: preview.candidate,
        expectedSource: source,
        expectedPart,
      }),
    accepted: () => accepted,
    preview,
    stores,
    registry,
    source,
    document,
    suggestions,
    stop: (): void => {
      authority.releaseScopeReceipt();
      stores.residentDocuments.releaseAll();
      stopHost();
      client.close?.();
      worker.close?.();
    },
  };
}
const owners: Awaited<ReturnType<typeof owner>>[] = [];
afterEach(() => {
  for (const o of owners.splice(0)) o.stop();
  vi.restoreAllMocks();
});

it('C2AK: an actual confirmed Worker-owned receipt survives non-submission and remains one-use after accepted retry', async () => {
  const o = await owner();
  owners.push(o);
  expect(() => o.commit()).toThrow('Not submitted');
  expect(o.accepted()).toBe(0);
  expect(o.stores.splitCandidates.preview(o.preview.candidate, (d) => d.parts.length)).toBe(2);
  expect(o.stores.residentDocuments.resolve(o.source)).toBe(o.document);
  const operation = o.commit();
  expect(o.accepted()).toBe(1);
  await expect(operation.promise).resolves.toMatchObject({ handle: { revision: 2 } });
  await expect(o.commit().promise).rejects.toThrow();
});

it.each(['expiry', 'supersession', 'source', 'part', 'preparation'] as const)(
  'C2AK: pre-dispatch retry preservation cannot outlive actual %s invalidation',
  async (reason) => {
    const o = await owner();
    owners.push(o);
    expect(() => o.commit()).toThrow('Not submitted');
    expect(o.accepted()).toBe(0);
    if (reason === 'expiry')
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 240_001);
    if (reason === 'supersession') o.stores.splitCandidates.begin(o.source, partId('part-1'));
    if (reason === 'source') o.stores.residentDocuments.replace(o.source, o.document);
    if (reason === 'preparation')
      o.registry.registerSemanticNativeFinalists(
        o.source,
        'part-1',
        requiredPart(o.document).mesh,
        2,
        o.suggestions,
      );
    const observedBefore = o.stores.residentDocuments.stats();
    await expect(o.commit(reason === 'part' ? 'other-part' : undefined).promise).rejects.toThrow();
    expect(o.accepted()).toBe(1);
    expect(o.stores.residentDocuments.stats()).toEqual(observedBefore);
    expect(
      o.stores.residentDocuments.resolve({ ...o.source, revision: reason === 'source' ? 2 : 1 }),
    ).toBe(o.document);
  },
);

it('C2AK: retry after actual store/receipt reconstruction cannot cross runtime identity', async () => {
  const a = await owner();
  owners.push(a);
  expect(() => a.commit()).toThrow('Not submitted');
  const b = await owner();
  owners.push(b);
  expect(a.source).toEqual(b.source);
  expect(a.preview.candidate.generation).toBe(b.preview.candidate.generation);
  expect(a.preview.candidate.candidateId).not.toBe(b.preview.candidate.candidateId);
  expect(() =>
    b.stores.splitCandidates.commit(a.preview.candidate, b.source, partId('part-1'), (d) => d),
  ).toThrow();
  expect(b.stores.residentDocuments.resolve(b.source)).toBe(b.document);
  expect(() => b.commit()).toThrow('Not submitted');
  await expect(b.commit().promise).resolves.toMatchObject({ handle: { revision: 2 } });
});

function requiredPart(
  document: ReturnType<typeof singlePartDocument>,
): ReturnType<typeof singlePartDocument>['parts'][number] {
  const part = document.parts[0];
  if (!part) throw Error('Missing fixture part');
  return part;
}
