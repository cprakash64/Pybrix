import { describe, expect, it } from 'vitest';
import type { GeometryDocument } from '@cadfixer/mesh-core';
import { jointedDocument } from '@cadfixer/mesh-core/fixtures';
import { exportSnapshotOf } from './export-contract';

/*
 * Stage EC-1. An editable connector is session state. The export snapshot is a copy of what is to be WRITTEN, so a document that
 * holds joints must snapshot exactly as the same document without them: the retained bases are not parts, and are not geometry a
 * file may carry.
 */
describe('the export snapshot never carries a joint', () => {
  it('is identical to the snapshot of the same document with its joints removed', () => {
    const { document } = jointedDocument();
    const without: GeometryDocument = {
      ...(document.unit === undefined ? {} : { unit: document.unit }),
      parts: document.parts,
    };
    expect(exportSnapshotOf(document, 'document-1', 3)).toEqual(
      exportSnapshotOf(without, 'document-1', 3),
    );
  });

  it('holds one resource per distinct PART mesh, not per retained base', () => {
    const { document } = jointedDocument();
    expect(exportSnapshotOf(document, 'document-1', 3).meshes).toHaveLength(2);
  });

  it('names no joint, base or retained piece anywhere in what it holds', () => {
    const { document } = jointedDocument();
    const text = JSON.stringify(exportSnapshotOf(document, 'document-1', 3));
    expect(text).not.toMatch(/joint|baseMesh|builtMesh|authority/i);
  });
});
