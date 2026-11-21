import { describe, expect, it, vi } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  partId,
  singlePartDocument,
} from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';
import { ResidentDocumentStore } from './resident-documents';
import { RepairHistoryStore } from './repair-history';
import { GeometryEditStore } from './geometry-edit';
import { SplitCandidateStore } from './split-candidates';
import { splitOpenSurface } from './open-plane-split';

type Route = 'semantic' | 'component' | 'family' | 'manual';
const part = partId('part-1');
function owner(
  route: Route,
  differentBytes = false,
): {
  resident: ResidentDocumentStore;
  history: RepairHistoryStore;
  store: SplitCandidateStore;
  source: ReturnType<ResidentDocumentStore['commit']>;
  candidate: ReturnType<SplitCandidateStore['resolve']>['candidate'];
  document: ReturnType<typeof singlePartDocument>;
  authorize: ReturnType<typeof vi.fn>;
} {
  const positions = createPositionArray(9),
    indices = createIndexArray(3);
  positions.set([-1, -1, 0, 1, -1, 0, 0, differentBytes ? 2 : 1, 0]);
  indices.set([0, 1, 2]);
  const mesh = { positions, indices, metadata: { sourceFormat: 'stl' } },
    document = singlePartDocument(mesh),
    resident = new ResidentDocumentStore(),
    history = new RepairHistoryStore(),
    edits = new GeometryEditStore(resident, history),
    store = new SplitCandidateStore(resident, history, edits),
    source = resident.commit(document),
    result = splitOpenSurface(mesh, { origin: [0, 0, 0], normal: [1, 0, 0] }, uncancellable),
    candidate = store.resolve(store.begin(source, part), result, uncancellable).candidate,
    authorize = vi.fn();
  // Shared-store fixtures model the policy distinction. Actual component/family
  // handlers and semantic receipts are exercised separately in Worker regressions.
  if (route === 'semantic') store.authorizeCommit(candidate, authorize);
  return { resident, history, store, source, candidate, document, authorize };
}

const matrix: readonly (readonly [Route, Route])[] = [
  ['semantic', 'semantic'],
  ['semantic', 'component'],
  ['semantic', 'family'],
  ['semantic', 'manual'],
  ['component', 'semantic'],
  ['component', 'component'],
  ['manual', 'manual'],
  ['family', 'family'],
];
describe('split candidate store lifetime', () => {
  it.each(matrix)('rejects retained %s handles against a replacement %s owner', (from, to) => {
    const a = owner(from),
      b = owner(to),
      old = JSON.parse(JSON.stringify(a.candidate)) as typeof a.candidate,
      fresh = b.candidate,
      build = vi.fn<() => void>();
    expect(a.source).toEqual(b.source);
    expect(old.generation).toBe(fresh.generation);
    expect(old.partId).toBe(fresh.partId);
    expect(old.candidateId).not.toBe(fresh.candidateId);
    // Both owners really start at sequence/generation 1, without faking entropy.
    expect(old.candidateId.endsWith(':split-candidate-1')).toBe(true);
    expect(fresh.candidateId.endsWith(':split-candidate-1')).toBe(true);
    expect(() => b.store.resultIdentity(old)).toThrow('stale or unavailable');
    expect(() => {
      b.store.preview(old, build);
    }).toThrow('stale or unavailable');
    expect(() => {
      b.store.authorizeCommit(old, build);
    }).toThrow('stale or unavailable');
    expect(b.store.discard(old)).toBe(false);
    expect(() => b.store.commit(old, b.source, part, build)).toThrow('stale or unavailable');
    expect(build).not.toHaveBeenCalled();
    expect(a.authorize).not.toHaveBeenCalled();
    expect(b.authorize).not.toHaveBeenCalled();
    expect(b.resident.resolve(b.source)).toBe(b.document);
    expect(b.history.undoableFor(b.source.documentId)).toBeUndefined();
    expect(b.store.stats().candidateCount).toBe(1);
    const identity = b.store.resultIdentity(fresh);
    expect(b.store.resultIdentity(fresh)).toBe(identity);
    expect(b.store.preview(fresh, (d) => d.parts.length)).toBe(2);
    const committed = b.store.commit(fresh, b.source, part, (d) => d.parts.length);
    expect(committed.handle.revision).toBe(2);
    expect(committed.value).toBe(2);
    expect(b.authorize).toHaveBeenCalledTimes(to === 'semantic' ? 1 : 0);
    expect(b.store.stats().candidateCount).toBe(0);
  });

  it('rejects across different document bytes even when document identity counters repeat', () => {
    const a = owner('semantic'),
      b = owner('component', true);
    expect(a.document).not.toEqual(b.document);
    expect(a.source).toEqual(b.source);
    expect(() => b.store.commit(a.candidate, b.source, part, (d) => d)).toThrow();
    expect(b.resident.resolve(b.source)).toBe(b.document);
    expect(b.store.preview(b.candidate, (d) => d.parts.length)).toBe(2);
  });

  it('rejects legacy/missing candidate identity and preserves current discard and supersession', () => {
    const a = owner('manual');
    for (const candidateId of ['split-candidate-1', '', 'unknown']) {
      const obsolete = { ...a.candidate, candidateId };
      expect(() => a.store.resultIdentity(obsolete)).toThrow();
      expect(a.store.discard(obsolete)).toBe(false);
    }
    const missing = { ...a.candidate };
    Reflect.deleteProperty(missing, 'candidateId');
    expect(() => a.store.resultIdentity(missing)).toThrow('stale or unavailable');
    expect(a.store.discard(missing)).toBe(false);
    expect(a.store.discard(a.candidate)).toBe(true);
    expect(a.store.discard(a.candidate)).toBe(false);
    expect(() => a.store.resultIdentity(a.candidate)).toThrow();
    const b = owner('manual');
    b.store.begin(b.source, part);
    expect(() => b.store.preview(b.candidate, (d) => d)).toThrow();
    expect(b.store.stats().candidateCount).toBe(0);
  });
});
