import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentId,
  JointCommitResult,
  PartDescriptor,
  RepairUndoResult,
  SplitCommitResult,
} from '@cadfixer/geometry-runtime';
import { WorkspaceStore } from './workspace-store';
import type { LoadedModel } from './model';

/*
 * Stage EC-5. A connector edit keeps every part, so the page keeps its layout; and because it is one forward revision like any other,
 * an Undo that brings the earlier revision back brings the layout back with it instead of leaving the screen with none.
 */
const part = (partId: string, triangles = 12): PartDescriptor => ({
  partId,
  transform: IDENTITY_PART_TRANSFORM,
  triangleCount: triangles,
  vertexCount: triangles * 3,
  bounds: undefined,
  meshResourceIndex: 0,
  groupCount: 0,
  groupMaterialRefCount: 0,
  hasNormals: false,
  hasUvs: false,
});
const handle = (revision: number): { documentId: DocumentId; revision: number } => ({
  documentId: 'doc-1' as DocumentId,
  revision,
});

function appliedSplit(): WorkspaceStore {
  const store = new WorkspaceStore();
  const model: Omit<LoadedModel, 'revision'> = {
    handle: handle(1),
    parts: [part('source')],
    render: { parts: [] },
    source: {
      fileName: 'cube.stl',
      fileBytes: 1,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: 12,
    vertexCount: 36,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 1,
  };
  store.commitImport(store.beginImport('cube.stl'), model);
  const split = {
    recordId: '2',
    metrics: { tolerance: 0.00001 },
    parentRevision: 1,
    handle: handle(2),
    pieceAId: 'a',
    pieceBId: 'b',
    parts: [part('a'), part('b')],
    bounds: undefined,
    triangleCount: 24,
    vertexCount: 72,
    residentBytes: 2,
    render: { parts: [] },
    resources: { triangles: 24 },
    connector: { kind: 'pin', count: 1, diameter: 4, depth: 6, clearance: 0.2, maleSide: 'A' },
    interface: {
      plane: { origin: [0, 0, 0], normal: [1, 0, 0] },
      center: [0, 0, 0],
      bounds: { min: [0, -15, -15], max: [0, 15, 15] },
      connectorEligible: true,
      placements: [],
    },
  } as unknown as SplitCommitResult;
  store.applySplitResult(split, {
    sourcePartId: 'source',
    sourceTransform: IDENTITY_PART_TRANSFORM,
    plane: { origin: [0, 0, 0], normal: [1, 0, 0] },
    label: 'Top',
  });
  return store;
}
const edited = (revision: number, parentRevision: number): JointCommitResult =>
  ({
    handle: handle(revision),
    parentRevision,
    recordId: 'rec-1',
    render: { parts: [] },
    parts: [part('a', 14), part('b', 12)],
    joints: [],
    residentBytes: 3,
    triangleCount: 26,
    vertexCount: 78,
    bounds: undefined,
    summary: {},
  }) as unknown as JointCommitResult;
const undone = (revision: number): RepairUndoResult =>
  ({
    handle: handle(revision),
    revertedRevision: revision - 1,
    restoredRevision: revision - 2,
    recordId: 'rec-1',
    kind: 'geometry-edit',
    partId: 'a',
    appliedOperations: [],
    render: { positions: new Float32Array(0), normals: new Float32Array(0), vertexCount: 0 },
    documentRender: { parts: [] },
    parts: [part('a'), part('b')],
    residentBytes: 2,
    triangleCount: 24,
    vertexCount: 72,
    bounds: undefined,
  }) as unknown as RepairUndoResult;

describe('adopting a connector edit', () => {
  it('moves the model one revision on with the same parts and carries the layout to it', () => {
    const store = appliedSplit();
    const before = store.getSnapshot();
    expect(before.assembly?.revision).toBe(2);
    expect(store.applyJointEditResult(edited(3, 2))).toBe(true);
    const after = store.getSnapshot();
    expect(after.model?.handle).toEqual(handle(3));
    expect(after.model?.parts.map((p) => p.partId)).toEqual(['a', 'b']);
    expect(after.model?.triangleCount).toBe(26);
    expect(after.activePartId).toBe(before.activePartId);
    expect(after.assembly).toMatchObject({ revision: 3, labels: before.assembly?.labels });
    expect(after.assembly?.interfaces).toEqual(before.assembly?.interfaces);
  });

  it('resets what described the old revision: analysis, repair and fill are bound to the new one', () => {
    const store = appliedSplit();
    store.applyJointEditResult(edited(3, 2));
    const state = store.getSnapshot();
    expect(state.analysis.handle).toEqual(handle(3));
    expect(state.repair.handle).toEqual(handle(3));
    expect(state.holeFill.handle).toEqual(handle(3));
  });

  it('marks the revision it produced, and the revision an undo of it produced, as connector edits', () => {
    const store = appliedSplit();
    expect(store.getSnapshot().connectorEditRevision).toBeUndefined();
    store.applyJointEditResult(edited(3, 2));
    const afterEdit = store.getSnapshot();
    expect(afterEdit.connectorEditRevision).toBe(afterEdit.model?.revision);
    store.applyUndoResult(undone(4));
    // an undo is a revision like any other until the editor, which knows what it undid, says what it was
    expect(store.getSnapshot().connectorEditRevision).not.toBe(store.getSnapshot().model?.revision);
    store.noteConnectorEditUndone();
    expect(store.getSnapshot().connectorEditRevision).toBe(store.getSnapshot().model?.revision);
  });

  it('refuses a result for a document or revision the store does not hold', () => {
    const store = appliedSplit();
    expect(store.applyJointEditResult(edited(9, 8))).toBe(false);
    expect(
      store.applyJointEditResult({
        ...edited(3, 2),
        handle: { documentId: 'other' as DocumentId, revision: 3 },
      }),
    ).toBe(false);
    expect(store.getSnapshot().model?.handle).toEqual(handle(2));
  });

  it('leaves the layout in place after an Undo, for the parts it brings back', () => {
    const store = appliedSplit();
    const layout = store.getSnapshot().assembly;
    store.applyJointEditResult(edited(3, 2));
    expect(store.applyUndoResult(undone(4))).toBe(true);
    const state = store.getSnapshot();
    expect(state.model?.handle).toEqual(handle(4));
    expect(state.assembly).toEqual({ ...layout, revision: 4 });
  });

  it('keeps no layout when there was none to carry', () => {
    const store = appliedSplit();
    // a layout for another revision is not this model's
    const stale = new WorkspaceStore();
    stale.commitImport(stale.beginImport('cube.stl'), {
      handle: handle(2),
      parts: [part('a'), part('b')],
      render: { parts: [] },
      source: store.getSnapshot().model?.source ?? ({} as never),
      bounds: undefined,
      triangleCount: 24,
      vertexCount: 72,
      validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
      warnings: [],
      residentBytes: 2,
    });
    expect(stale.applyJointEditResult(edited(3, 2))).toBe(true);
    expect(stale.getSnapshot().assembly).toBeUndefined();
  });
});
