import { describe, expect, it } from 'vitest';
import { isAppError } from '@cadfixer/shared';
import {
  jointAttachment,
  jointRetainedBytes,
  JointRetirement,
  liveJoints,
  meshByteLength,
  partId,
  retiredJoints,
  withPartMesh,
  withPartTransform,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import { jointedDocument, tetrahedronMesh, translation } from '@cadfixer/mesh-core/fixtures';
import { describeJoints } from './joint-descriptors';
import { jointSpecDigest } from './connector-rebuild';
import { documentByteLength, isDocument, ResidentDocumentStore } from './resident-documents';

/*
 * Stage EC-1. The resident store is the ONLY place a document is installed, so it is the one place a joint stops being usable and
 * the one place what it held is released. Every test goes through the store, because a rule that only the helper obeys is not a
 * rule about installation.
 */
const A = partId('part-a');
const B = partId('part-b');

function resolved(
  store: ResidentDocumentStore,
  handle: Parameters<ResidentDocumentStore['resolve']>[0],
): GeometryDocument {
  const document = store.resolve(handle);
  if (!isDocument(document)) throw document;
  return document;
}
function repaired(document: GeometryDocument): GeometryDocument {
  const next = withPartMesh(document, A, tetrahedronMesh(2));
  if (next === undefined) throw new Error('part missing');
  return next;
}

describe('a joint stays live while the parts hold what it built', () => {
  it('installing an unrelated change keeps the very same record, attached', () => {
    const { document, joint } = jointedDocument();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const second = store.replace(first, { ...document, parts: document.parts.slice() });
    if (isAppError(second)) throw second;
    expect(liveJoints(resolved(store, second))[0]).toBe(joint);
  });

  it('installs the document it was given, by reference, when nothing retires', () => {
    const { document } = jointedDocument();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const next: GeometryDocument = { ...document, parts: document.parts.slice() };
    const second = store.replace(first, next);
    if (isAppError(second)) throw second;
    expect(resolved(store, second)).toBe(next);
  });
});

type Change = (document: GeometryDocument) => GeometryDocument | undefined;

describe('installing a change that detaches a joint retires it, and only here', () => {
  it('replaces the live record with a descriptor that names the revision it retired at', () => {
    const { document } = jointedDocument();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const second = store.replace(first, repaired(document));
    if (isAppError(second)) throw second;
    const installed = resolved(store, second);
    expect(liveJoints(installed)).toEqual([]);
    expect(retiredJoints(installed)).toEqual([
      {
        kind: 'retired-joint',
        jointId: 'document-1/joint/1',
        a: A,
        b: B,
        reason: JointRetirement.GeometryChanged,
        retiredAtRevision: second.revision,
        pinCount: 1,
      },
    ]);
  });

  const moved: Change = (d) => withPartTransform(d, B, translation(2, 0, 0));
  const removed: Change = (d) => ({ ...d, parts: d.parts.filter((p) => p.id !== A) });
  const reunit: Change = (d) => ({ ...d, unit: 'inch' });
  const CHANGES: readonly (readonly [string, Change, JointRetirement])[] = [
    ['a moved part', moved, JointRetirement.PlacementChanged],
    ['a removed part', removed, JointRetirement.PartRemoved],
    ['a different unit', reunit, JointRetirement.UnitChanged],
  ];

  it.each(CHANGES)('retires on %s', (_label, change, reason) => {
    const { document } = jointedDocument();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const next = change(document);
    if (next === undefined) throw new Error('part missing');
    const second = store.replace(first, next);
    if (isAppError(second)) throw second;
    expect(retiredJoints(resolved(store, second)).map((r) => r.reason)).toEqual([reason]);
  });

  it('shares the parts array and every mesh with what it was given', () => {
    const { document } = jointedDocument();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const next = repaired(document);
    const second = store.replace(first, next);
    if (isAppError(second)) throw second;
    const installed = resolved(store, second);
    expect(installed).not.toBe(next);
    expect(installed.parts).toBe(next.parts);
  });

  it('refuses a stale replace without retiring or releasing anything', () => {
    const { document } = jointedDocument();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const second = store.replace(first, { ...document, parts: document.parts.slice() });
    if (isAppError(second)) throw second;
    const refused = store.replace(first, repaired(document));
    expect(isAppError(refused)).toBe(true);
    expect(liveJoints(resolved(store, second)).length).toBe(1);
  });

  it('retires at import too: a document committed already detached is installed without its meshes', () => {
    const { document } = jointedDocument();
    const store = new ResidentDocumentStore();
    const handle = store.commit(repaired(document));
    const installed = resolved(store, handle);
    expect(liveJoints(installed)).toEqual([]);
    expect(retiredJoints(installed)[0]?.retiredAtRevision).toBe(1);
  });
});

describe('undo restores the joint without a rule of its own', () => {
  it('installing the previous document object makes the joint attached again', () => {
    const { document, joint } = jointedDocument();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const afterRepair = store.replace(first, repaired(document));
    if (isAppError(afterRepair)) throw afterRepair;
    expect(liveJoints(resolved(store, afterRepair))).toEqual([]);
    // What `repair/undo` does with a record that retained `previousDocument`: it installs that object.
    const afterUndo = store.replace(afterRepair, document);
    if (isAppError(afterUndo)) throw afterUndo;
    const restored = resolved(store, afterUndo);
    expect(liveJoints(restored)[0]).toBe(joint);
    expect(jointAttachment(restored, joint)).toEqual({ attached: true });
    expect(afterUndo.revision).toBe(afterRepair.revision + 1);
  });
});

describe('what a joint retains is charged, and released when it retires', () => {
  it('counts the bases in the document total and in the store, and drops them on retirement', () => {
    const { document, joint } = jointedDocument();
    const partsOnly = meshByteLength(joint.a.builtMesh) + meshByteLength(joint.b.builtMesh);
    const retained = meshByteLength(joint.a.baseMesh) + meshByteLength(joint.b.baseMesh);
    expect(jointRetainedBytes(document)).toBe(retained);
    expect(documentByteLength(document)).toBe(partsOnly + retained);

    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    expect(store.stats().totalBytes).toBe(partsOnly + retained);
    const second = store.replace(first, repaired(document));
    if (isAppError(second)) throw second;
    const after = resolved(store, second);
    expect(jointRetainedBytes(after)).toBe(0);
    expect(store.stats().totalBytes).toBe(documentByteLength(after));
    expect(store.stats().totalBytes).toBeLessThan(partsOnly + retained);
  });

  it('charges nothing for a document with no joints', () => {
    const mesh = tetrahedronMesh();
    expect(documentByteLength({ parts: [{ id: A, mesh, transform: translation(0, 0, 0) }] })).toBe(
      meshByteLength(mesh),
    );
  });
});

describe('the page is told what a joint is, never what it holds', () => {
  it("describes an attached joint with its connectors in the page's terms and no geometry", () => {
    const { document, joint } = jointedDocument({ authorityBytes: 10 });
    const [described] = describeJoints(document);
    expect(described).toEqual({
      jointId: joint.jointId,
      aPartId: A,
      bPartId: B,
      status: 'ATTACHED',
      pinCount: 1,
      retainedBytes: jointRetainedBytes(document),
      specDigest: jointSpecDigest(joint),
      connector: {
        maleSide: 'A',
        pins: [{ pinId: 'pin-1', u: 0, v: 0, diameterMm: 4, depthMm: 6, clearanceMm: 0.2 }],
      },
    });
    // nothing in it is a mesh, a base piece or a point of the model
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
    expect(JSON.stringify(described)).not.toMatch(/local|baseMesh|builtMesh|positions|indices/);
  });

  it('describes a plain joint as zero pins', () => {
    expect(describeJoints(jointedDocument({ connector: undefined }).document)[0]?.pinCount).toBe(0);
  });

  it('describes a retired joint with its reason and revision, and zero retained bytes', () => {
    const { document } = jointedDocument();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const second = store.replace(first, repaired(document));
    if (isAppError(second)) throw second;
    expect(describeJoints(resolved(store, second))).toEqual([
      {
        jointId: 'document-1/joint/1',
        aPartId: A,
        bPartId: B,
        status: 'RETIRED',
        reason: JointRetirement.GeometryChanged,
        retiredAtRevision: second.revision,
        pinCount: 1,
        retainedBytes: 0,
      },
    ]);
  });

  it('reports a not-yet-installed detached record as retired with a reason and no revision', () => {
    const { document } = jointedDocument();
    const [described] = describeJoints(repaired(document));
    expect(described?.status).toBe('RETIRED');
    expect(described?.reason).toBe(JointRetirement.GeometryChanged);
    expect(described).not.toHaveProperty('retiredAtRevision');
  });

  it('adds up: per-joint retained bytes sum to the document total', () => {
    const { document } = jointedDocument({ authorityBytes: 123 });
    expect(describeJoints(document).reduce((sum, d) => sum + d.retainedBytes, 0)).toBe(
      jointRetainedBytes(document),
    );
  });

  it('lists nothing for a document with no joints', () => {
    expect(describeJoints({ parts: jointedDocument().document.parts })).toEqual([]);
  });
});
