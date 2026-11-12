import { describe, expect, it, vi } from 'vitest';
import {
  applyPartTransform,
  partId,
  singlePartDocument,
  type CanonicalMesh,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';
import { GeometryEditStore } from './geometry-edit';
import { RepairHistoryStore } from './repair-history';
import { ResidentDocumentStore } from './resident-documents';
import { SplitCandidateStore, splitTransactionId } from './split-candidates';
import { splitWithConnectors, type SplitPlane } from './split-connectors';

function cube(shift: number): CanonicalMesh {
  const positions = Float32Array.from(
    [-4, -4, -4, 4, -4, -4, 4, 4, -4, -4, 4, -4, -4, -4, 4, 4, -4, 4, 4, 4, 4, -4, 4, 4],
    (value, index) => (index % 3 === 0 ? value + shift : value),
  );
  const indices = Uint32Array.of(
    0,
    2,
    1,
    0,
    3,
    2,
    4,
    5,
    6,
    4,
    6,
    7,
    0,
    1,
    5,
    0,
    5,
    4,
    1,
    2,
    6,
    1,
    6,
    5,
    2,
    3,
    7,
    2,
    7,
    6,
    3,
    0,
    4,
    3,
    4,
    7,
  );
  return { positions, indices, metadata: {} };
}

const part = partId('part-1');
const rejectBoolean = vi.fn(() => {
  throw new Error('Unexpected Boolean for a plain plane split');
});

function setup(
  mesh: CanonicalMesh,
  transform: PartTransform,
): {
  resident: ResidentDocumentStore;
  history: RepairHistoryStore;
  store: SplitCandidateStore;
  source: ReturnType<ResidentDocumentStore['commit']>;
  document: ReturnType<typeof singlePartDocument>;
} {
  const base = singlePartDocument(mesh);
  const document = { ...base, parts: base.parts.map((p) => ({ ...p, transform })) };
  const resident = new ResidentDocumentStore();
  const history = new RepairHistoryStore();
  const store = new SplitCandidateStore(
    resident,
    history,
    new GeometryEditStore(resident, history),
  );
  return { resident, history, store, document, source: resident.commit(document) };
}

describe('production closed plane strategy', () => {
  it('binds a local rebase to a staged split, with no native Boolean', async () => {
    const mesh = cube(1_000_000);
    const placement: PartTransform = [-2, 0, 0, 0.5, 1, 0, 0, 0, 3, 10, 20, 30];
    const plane: SplitPlane = { origin: [1_000_000.17, 0, 0], normal: [1, 0, 0] };
    const { resident, history, store, source, document } = setup(mesh, placement);
    const ticket = store.begin(source, part);
    const prepared = store.preparePlaneSource(ticket, plane, uncancellable);
    const result = await splitWithConnectors(
      { operate: rejectBoolean },
      mesh,
      { plane, connector: { kind: 'none' } },
      uncancellable,
      undefined,
      1,
      prepared,
    );

    const clip = result.closedPlaneClip;
    if (!clip) throw new Error('Missing closed plane result');
    expect(rejectBoolean).not.toHaveBeenCalled();
    expect(clip.outputAnchor).toEqual([999_996, -4, -4]);
    expect(clip.interface.area).toBe(64);
    expect(clip.interface.footprintDifference).toBe(0);
    expect(clip.interface.orientationA).toBe(-clip.interface.orientationB);
    expect(clip.provenanceA.filter((value) => value === -1)).toHaveLength(clip.interface.capFaces);
    expect(clip.provenanceB.filter((value) => value === -1)).toHaveLength(clip.interface.capFaces);
    expect(applyPartTransform(clip.outputPlacement, 0, 0, 0)).toEqual(
      applyPartTransform(placement, ...clip.outputAnchor),
    );
    expect(clip.volumes[0] + clip.volumes[1]).toBeCloseTo(512, 5);

    const summary = store.resolve(ticket, result, uncancellable);
    const id = splitTransactionId(summary.candidate, 1);
    const preview = store.preview(summary.candidate, (value) => value);
    expect(preview.parts.map((p) => p.transform)).toEqual([
      clip.outputPlacement,
      clip.outputPlacement,
    ]);
    expect(resident.resolve(source)).toBe(document);
    expect(history.undoableFor(source.documentId)).toBeUndefined();
    expect(store.transactionStatus(id).state).toBe('UNKNOWN');
    const staged = store.prepareCommit(id, summary.candidate, source, part, (value) => value);
    expect(staged.value).toBe(preview);
    expect(resident.resolve(source)).toBe(document);
    expect(store.ackCommit(id).state).toBe('FINALIZED');
    expect(resident.resolve(staged.handle)).toBe(preview);
    expect(history.stats().recordCount).toBe(1);
  });

  it('rejects a result created from a superseded preparation', async () => {
    const mesh = cube(0);
    const { store, source } = setup(mesh, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const ticket = store.begin(source, part);
    const plane: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };
    const first = store.preparePlaneSource(ticket, plane, uncancellable);
    const result = await splitWithConnectors(
      { operate: rejectBoolean },
      mesh,
      { plane, connector: { kind: 'none' } },
      uncancellable,
      undefined,
      1,
      first,
    );
    store.preparePlaneSource(ticket, { ...plane, origin: [0, 0, 1] }, uncancellable);
    expect(() => store.resolve(ticket, result, uncancellable)).toThrow();
  });

  it('keeps open surfaces on the existing strategy', async () => {
    const mesh = {
      positions: Float32Array.of(-2, 0, 0, 2, 0, 0, 0, 2, 0),
      indices: Uint32Array.of(0, 1, 2),
      metadata: {},
    };
    const result = await splitWithConnectors(
      { operate: rejectBoolean },
      mesh,
      { plane: { origin: [0, 0, 0], normal: [1, 0, 0] }, connector: { kind: 'none' } },
      uncancellable,
    );
    expect(result.closedPlaneClip).toBeUndefined();
    expect(result.surfaceValidation?.sourceFaces).toBe(1);
  });
});
