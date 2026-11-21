import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentId,
  DocumentRenderSnapshot,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { WorkspaceStore } from './workspace-store';
import type { LoadedModel } from './model';
import type { AssemblyPresentation } from './assembly-presentation';

/**
 * EXPLODING A SPLIT PREVIEW IS A VISUAL CHOICE, AND ONLY THAT.
 *
 * `PREVIEW_DOCUMENT_MUTATION_COUNT = 0`: showing a preview exploded, assembled again, or discarding it
 * changes no model, no revision, no part, no render buffer and — critically for the viewport, which
 * rebuilds its scene whenever the preview OBJECT changes — not even the identity of `splitPreview`.
 */

const handle: DocumentHandle = { documentId: 'doc-1' as DocumentId, revision: 1 };

function part(partId: string): PartDescriptor {
  return {
    partId,
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount: 12,
    vertexCount: 36,
    bounds: undefined,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

const render = (parts: readonly PartDescriptor[]): DocumentRenderSnapshot => ({
  parts: parts.map((p) => ({
    partId: p.partId,
    transform: p.transform,
    positions: new Float32Array(p.triangleCount * 9),
    normals: new Float32Array(p.triangleCount * 9),
    vertexCount: p.triangleCount * 3,
  })),
});

function loaded(): WorkspaceStore {
  const store = new WorkspaceStore();
  const parts = [part('part-1')];
  const model: Omit<LoadedModel, 'revision'> = {
    handle,
    parts,
    render: render(parts),
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
  return store;
}

const assembly: AssemblyPresentation = {
  documentId: 'doc-1',
  revision: 2,
  exploded: false,
  connectorMode: 'plain',
  offsets: [
    { partId: 'part-1-A', offset: [4, 0, 0] },
    { partId: 'part-1-B', offset: [-4, 0, 0] },
  ],
  interfaces: [],
  labels: {},
};

describe('the split preview and its exploded view', () => {
  const pieces = [part('part-1-A'), part('part-1-B')];

  it('starts assembled and keeps the assembly with the preview it belongs to', () => {
    const store = loaded();
    expect(store.getSnapshot().previewExploded).toBe(false);
    expect(store.setSplitPreview(handle, render(pieces), pieces, assembly)).toBe(true);
    expect(store.getSnapshot().splitPreview?.assembly).toBe(assembly);
  });

  it('toggling changes ONLY the flag: same model, revision, preview object and assembly', () => {
    const store = loaded();
    store.setSplitPreview(handle, render(pieces), pieces, assembly);
    const before = store.getSnapshot();
    store.setPreviewExploded(true);
    const after = store.getSnapshot();
    expect(after.previewExploded).toBe(true);
    expect(after.model).toBe(before.model);
    expect(after.model?.revision).toBe(before.model?.revision);
    expect(after.model?.handle).toBe(before.model?.handle);
    expect(after.splitPreview).toBe(before.splitPreview); // the viewport rebuilds on a new object
    expect(after.splitPreview?.assembly).toBe(assembly);
    expect(after.assembly).toBe(before.assembly);
    store.setPreviewExploded(false);
    expect(store.getSnapshot().previewExploded).toBe(false);
    expect(store.getSnapshot().splitPreview).toBe(before.splitPreview);
  });

  it('does not notify subscribers when nothing changed', () => {
    const store = loaded();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.setPreviewExploded(false);
    expect(calls).toBe(0);
  });

  it('discarding the preview discards its assembly with it, and the model is untouched', () => {
    const store = loaded();
    const model = store.getSnapshot().model;
    store.setSplitPreview(handle, render(pieces), pieces, assembly);
    store.setPreviewExploded(true);
    store.clearSplitPreview();
    expect(store.getSnapshot().splitPreview).toBeUndefined();
    expect(store.getSnapshot().model).toBe(model);
  });

  it('refuses a preview made for a revision the model is no longer on', () => {
    const store = loaded();
    expect(
      store.setSplitPreview({ ...handle, revision: 9 }, render(pieces), pieces, assembly),
    ).toBe(false);
    expect(store.getSnapshot().splitPreview).toBeUndefined();
  });

  it("replacing the document drops the previous document's exploded choice, preview and layout", () => {
    const store = loaded();
    store.setSplitPreview(handle, render(pieces), pieces, assembly);
    store.setPreviewExploded(true);
    expect(store.getSnapshot().previewExploded).toBe(true);

    // Model B: a different document, installed without a refresh.
    const parts = [part('part-1')];
    const current = store.getSnapshot().model;
    if (current === undefined) throw new Error('the fixture model should be loaded');
    const replacement: Omit<LoadedModel, 'revision'> = {
      ...current,
      handle: { documentId: 'doc-2' as DocumentId, revision: 1 },
      parts,
      render: render(parts),
    };
    expect(store.commitImport(store.beginImport('truck.stl'), replacement)).toBe(true);

    const after = store.getSnapshot();
    expect(after.previewExploded).toBe(false);
    expect(after.splitPreview).toBeUndefined();
    expect(after.assembly).toBeUndefined();
    expect(after.model?.handle.documentId).toBe('doc-2');
  });
});
