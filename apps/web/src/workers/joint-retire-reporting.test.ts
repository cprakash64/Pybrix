import { afterEach, describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  IDENTITY_PART_TRANSFORM,
  jointId,
  jointRetainedBytes,
  liveJoints,
  partId,
  retiredJoints,
  triangleCount,
  type CanonicalMesh,
  type ConnectorJoint,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import { tetrahedronMesh } from '@cadfixer/mesh-core/fixtures';
import { documentByteLength, isDocument, type OperationContext } from '@cadfixer/geometry-runtime';
import { uncancellable } from '@cadfixer/shared';
import { runHoleFill } from '@cadfixer/mesh-hole-fill';
import { hp02QuadHole, referenceNarrowphase } from '@cadfixer/mesh-hole-fill/fixtures';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import { holeFillCommitHandler } from './hole-fill-workflow-handlers';
import { repairUndoHandler } from './repair-handlers';
import {
  geometryEdits,
  holeFillCandidates,
  repairHistory,
  residentDocuments,
} from './stl-handlers';

/*
 * Stage EC-3 — RETIRE BEFORE REPORTING. A commit that replaces a part's mesh retires a joint over that part when the store installs the
 * document. Handlers build their whole reply BEFORE the swap, so a reply built from the successor as it stands would count the joint's
 * bases, which are released a moment later: `residentBytes` would describe memory the store no longer holds. These tests install a
 * joint over a part and then change that part through the real handlers.
 */
const A = partId('part-a');
const B = partId('part-b');

function context(): OperationContext {
  return {
    cancellation: uncancellable,
    interruptible: false,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => undefined,
  };
}

/** Part A holds `built`; the joint retains two bases of its own, so the retained bytes are real and larger than nothing. */
function jointedOver(built: CanonicalMesh): { document: GeometryDocument; joint: ConnectorJoint } {
  const other = tetrahedronMesh(3);
  const joint: ConnectorJoint = {
    kind: 'joint',
    jointId: jointId('document-1/joint/1'),
    a: {
      partId: A,
      baseMesh: tetrahedronMesh(1.5),
      builtMesh: built,
      builtTransform: IDENTITY_PART_TRANSFORM,
    },
    b: {
      partId: B,
      baseMesh: tetrahedronMesh(2.5),
      builtMesh: other,
      builtTransform: IDENTITY_PART_TRANSFORM,
    },
    frame: { unit: 'millimeter', mmPerUnit: 1, placementScale: 1, mmPerCoordinate: 1 },
    authority: { provenanceSHA: 'sha', retainedBytes: 4096, detail: {} },
    connector: undefined,
    nextPinOrdinal: 1,
  };
  return {
    joint,
    document: {
      unit: 'millimeter',
      parts: [
        { id: A, mesh: built, transform: IDENTITY_PART_TRANSFORM },
        { id: B, mesh: other, transform: IDENTITY_PART_TRANSFORM },
      ],
      joints: [joint],
    },
  };
}

afterEach(() => {
  residentDocuments.releaseAll();
  holeFillCandidates.releaseAll();
  repairHistory.releaseAll();
});

function documentOf(handle: Parameters<typeof residentDocuments.resolve>[0]): GeometryDocument {
  const document = residentDocuments.resolve(handle);
  if (!isDocument(document)) throw document;
  return document;
}

describe('a hole fill over a jointed part reports the document that is held', () => {
  it('retires the joint, releases its bytes, and reports exactly what the store then holds', async () => {
    const source: CanonicalMesh = hp02QuadHole();
    const { document, joint } = jointedOver(source);
    const handle = residentDocuments.commit(document);
    expect(jointRetainedBytes(documentOf(handle))).toBeGreaterThan(0);

    const loop = extractBoundaryLoops(source).loops.find((entry) => entry.refusal === undefined);
    if (loop === undefined) throw new Error('fixture has no fillable loop');
    const result = runHoleFill({
      source,
      request: {
        operationId: 'ec3',
        documentId: 'ec3',
        revision: 1,
        partId: 'ec3',
        boundaryLoopId: loop.id,
      },
      narrowphase: referenceNarrowphase(),
    });
    if (result.candidate === undefined) throw new Error('engine returned no candidate');
    const candidate = holeFillCandidates.create(
      handle,
      A,
      loop.id,
      result.candidate,
      triangleCount(source),
    );

    const applied = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, expectedLoopId: loop.id },
      context(),
    );
    const installed = documentOf(applied.value.handle);
    expect(liveJoints(installed)).toEqual([]);
    expect(retiredJoints(installed)[0]).toMatchObject({
      jointId: joint.jointId,
      reason: 'GEOMETRY_CHANGED',
      retiredAtRevision: applied.value.handle.revision,
    });
    expect(applied.value.residentBytes).toBe(residentDocuments.stats().totalBytes);
    expect(applied.value.residentBytes).toBe(documentByteLength(installed));

    // Undo installs the previous document object, so the joint is attached again and its bytes are held again.
    const undone = await repairUndoHandler(
      { handle: applied.value.handle, recordId: applied.value.recordId },
      context(),
    );
    const restored = documentOf(undone.value.handle);
    expect(restored).toBe(document);
    expect(liveJoints(restored)).toEqual([joint]);
    expect(undone.value.residentBytes).toBe(residentDocuments.stats().totalBytes);
    expect(jointRetainedBytes(restored)).toBeGreaterThan(0);
  });
});

describe('a generic geometry edit over a jointed part reports the document that is held, and undo brings the joint back', () => {
  it('retires the joint before it reports, and the report equals what the store holds', async () => {
    const { document, joint } = jointedOver(tetrahedronMesh(2));
    const handle = residentDocuments.commit(document);
    const ticket = geometryEdits.begin(handle, A, 'ec3-test');
    // a structurally valid replacement of the same shape: a new OBJECT, which is all attachment compares
    const shape = tetrahedronMesh(2);
    const replacement: CanonicalMesh = {
      positions: createPositionArray(shape.positions.length),
      indices: createIndexArray(shape.indices.length),
      metadata: {},
    };
    replacement.positions.set(shape.positions);
    replacement.indices.set(shape.indices);
    const summary = geometryEdits.resolve(ticket, replacement);
    const applied = geometryEdits.commit(summary.candidate, handle, A, (_mesh, installable) =>
      documentByteLength(installable),
    );
    const installed = documentOf(applied.handle);
    expect(retiredJoints(installed)[0]?.jointId).toBe(joint.jointId);
    expect(applied.render).toBe(residentDocuments.stats().totalBytes);

    const undone = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );
    expect(documentOf(undone.value.handle)).toBe(document);
    expect(liveJoints(documentOf(undone.value.handle))).toEqual([joint]);
  });
});
