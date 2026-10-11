import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentId,
  DocumentRenderSnapshot,
  PartDescriptor,
  SplitCommitResult,
} from '@cadfixer/geometry-runtime';
import { WorkspaceStore } from './workspace-store';
import type { LoadedModel } from './model';

/**
 * THE ACTIVE PART MUST EXIST AFTER AN UNDO (RC2.1).
 *
 * A split replaces part `part-1` with `part-1-A` and `part-1-B` and makes Piece A the active part. Undo
 * puts the original `part-1` back, and until RC2.1 `applyUndoResult` left `activePartId` pointing at
 * `part-1-A`, a part the restored document does not contain. Every consumer of the active part then
 * failed on a name that no longer resolved:
 *
 *   - "Export active part as binary STL" asked the worker for `part-1-A` and was refused with
 *     "That part is not in this version of the model" (a line in the activity log, no file);
 *   - the Split workspace found no part to cut;
 *   - the analysis, self-intersection, hole-fill and repair slices were all re-bound to the missing id.
 *
 * The document's facts were restored exactly; the WORKSPACE'S pointer to it was not. These tests state
 * the property directly: after any undo, the active part is a part of the document on screen.
 */

const handle = (revision: number): DocumentHandle => ({
  documentId: 'doc-1' as DocumentId,
  revision,
});

function part(partId: string, triangles: number): PartDescriptor {
  return {
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
  };
}

const renderFor = (parts: readonly PartDescriptor[]): DocumentRenderSnapshot => ({
  parts: parts.map((p) => ({
    partId: p.partId,
    transform: p.transform,
    positions: new Float32Array(p.triangleCount * 9),
    normals: new Float32Array(p.triangleCount * 9),
    vertexCount: p.triangleCount * 3,
  })),
});

function load(parts: readonly PartDescriptor[]): WorkspaceStore {
  const store = new WorkspaceStore();
  const model: Omit<LoadedModel, 'revision'> = {
    handle: handle(1),
    parts,
    render: renderFor(parts),
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
    triangleCount: parts.reduce((n, p) => n + p.triangleCount, 0),
    vertexCount: 1,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 1,
  };
  store.commitImport(store.beginImport('cube.stl'), model);
  return store;
}

/** What the worker reports for a split of `source` into `source`-A and `source`-B (12 triangles became 8 + 8). */
function splitResult(source: string): SplitCommitResult {
  const parts = [part(`${source}-A`, 8), part(`${source}-B`, 8)];
  // Only the fields the store reads; the rest of the worker's answer is not its business.
  return {
    handle: handle(2),
    parentRevision: 1,
    recordId: 'record-1',
    pieceAId: `${source}-A`,
    pieceBId: `${source}-B`,
    render: renderFor(parts),
    parts,
    residentBytes: 1,
    triangleCount: 16,
    vertexCount: 48,
    bounds: undefined,
    resources: {
      triangles: 16,
      vertices: 48,
      canonicalBytes: 1,
      renderBytes: 1,
      estimatedPeakBytes: 1,
    },
  } as unknown as SplitCommitResult;
}

function undoResult(
  restored: readonly PartDescriptor[],
  partId: string,
): Parameters<WorkspaceStore['applyUndoResult']>[0] {
  return {
    handle: handle(3),
    partId,
    render: renderFor(restored.filter((p) => p.partId === partId))
      .parts[0] as unknown as Parameters<WorkspaceStore['applyUndoResult']>[0]['render'],
    documentRender: renderFor(restored),
    parts: restored,
    bounds: undefined,
    triangleCount: restored.reduce((n, p) => n + p.triangleCount, 0),
    vertexCount: 36,
    residentBytes: 1,
  };
}

const ids = (store: WorkspaceStore): string[] =>
  (store.getSnapshot().model?.parts ?? []).map((p) => p.partId);

describe('Split Apply then Undo', () => {
  it('leaves the active part pointing at a part the restored document contains', () => {
    const store = load([part('part-1', 12)]);
    expect(store.getSnapshot().activePartId).toBe('part-1');

    expect(store.applySplitResult(splitResult('part-1'))).toBe(true);
    // Apply moves the selection to Piece A: that is the product's behaviour and it is kept.
    expect(store.getSnapshot().activePartId).toBe('part-1-A');
    expect(ids(store)).toEqual(['part-1-A', 'part-1-B']);

    expect(store.applyUndoResult(undoResult([part('part-1', 12)], 'part-1'))).toBe(true);

    const state = store.getSnapshot();
    expect(ids(store)).toEqual(['part-1']);
    expect(state.activePartId, 'the active part must be one the document has').toBe('part-1');
    expect(state.activePartId).toBeDefined();
    expect(ids(store)).toContain(state.activePartId);
    expect(store.activePart()?.partId).toBe('part-1');
  });

  it('re-binds every per-part slice to the restored part, never to the missing one', () => {
    const store = load([part('part-1', 12)]);
    store.applySplitResult(splitResult('part-1'));
    store.applyUndoResult(undoResult([part('part-1', 12)], 'part-1'));

    const state = store.getSnapshot();
    expect(state.analysis.partId).toBe('part-1');
    expect(state.selfIntersection.partId).toBe('part-1');
    expect(state.holeFill.partId).toBe('part-1');
    expect(state.repair.partId).toBe('part-1');
  });

  it('puts a multi-part document back with the restored part active, and its siblings untouched', () => {
    const store = load([part('body', 12), part('wheel', 12)]);
    store.applySplitResult({
      ...splitResult('body'),
      parts: [part('body-A', 8), part('body-B', 8), part('wheel', 12)],
    });
    expect(store.getSnapshot().activePartId).toBe('body-A');

    store.applyUndoResult(undoResult([part('body', 12), part('wheel', 12)], 'body'));

    expect(ids(store)).toEqual(['body', 'wheel']);
    expect(store.getSnapshot().activePartId).toBe('body');
  });
});

describe('Undo keeps a selection that is still valid', () => {
  it('does not move the user off a part that survives the undo (the repair case)', () => {
    const store = load([part('a', 12), part('b', 12)]);
    store.selectPart('b');

    // A repair of `a` is undone while `b` is selected: `b` exists, so `b` stays selected.
    store.applyUndoResult(undoResult([part('a', 12), part('b', 12)], 'a'));

    expect(store.getSnapshot().activePartId).toBe('b');
    expect(store.getSnapshot().repair.partId).toBe('b');
  });

  it('falls back to the first part when neither the selection nor the restored part exists', () => {
    const store = load([part('a', 12)]);
    store.applyUndoResult(undoResult([part('z', 12), part('y', 12)], 'ghost'));

    expect(store.getSnapshot().activePartId).toBe('z');
  });
});
