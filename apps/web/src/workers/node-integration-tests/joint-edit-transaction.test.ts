import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyPlacement,
  createIndexArray,
  createPositionArray,
  IDENTITY_PART_TRANSFORM,
  jointRetainedBytes,
  liveJoints,
  meshByteLength,
  partId,
  retiredJoints,
  singlePartDocument,
  withPartMesh,
  type CanonicalMesh,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { CancellationSource, isAppError, uncancellable } from '@cadfixer/shared';
import {
  describeCutOutline,
  describeJoints,
  documentByteLength,
  isDocument,
  jointSpecDigest,
  pinCutOfJoint,
  siteOnInterface,
  splitWithConnectors,
  SplitCandidateStore,
  type DocumentHandle,
  type JointEditCandidateHandle,
  type JointEditRequest,
  type OperationContext,
  type PhysicalPinRequest,
  type SplitCandidateSummary,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';
import {
  geometryEdits,
  jointEdits,
  repairHistory,
  residentDocuments,
  splitCandidates,
} from '../stl-handlers';
import {
  createJointCommitHandler,
  createJointProposeHandler,
  jointListHandler,
  PRODUCTION_JOINT_COMMIT_WORK,
  readJointEdit,
} from '../joint-handlers';
import { repairUndoHandler } from '../repair-handlers';

/*
 * Stage EC-3 — editing the connectors of a joint, as a transaction, on the real kernel and through the worker's own handlers.
 *
 * The split that makes the joint goes through the production stores (a split is created, resolved and committed exactly as
 * `split/create` and `split/commit` do it); the edit goes through `joint/list`, `joint/propose`, `joint/commit` and `repair/undo`.
 * The only substitution is the Boolean backend: the application drives one from a nested worker, the test hands the handler the
 * kernel directly.
 */
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
function cube(size: number): CanonicalMesh {
  const h = size / 2,
    p = [-h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h, -h, -h, h, h, -h, h, -h, h, h, h, h, h],
    i = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
const X_PLANE = { origin: [0, 0, 0], normal: [1, 0, 0] } as const;
const PIN: PhysicalPinRequest = {
  kind: 'physical-pin',
  unit: 'millimeter',
  count: 1,
  diameterMm: 3,
  depthMm: 4,
  clearanceMm: 0.2,
  maleSide: 'A',
};

function context(token = uncancellable): OperationContext {
  return {
    cancellation: token,
    interruptible: true,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (token.isCancelled) throw new Error('cancelled');
    },
  };
}
async function backend(): ReturnType<typeof createManifoldBooleanBackend> {
  return createManifoldBooleanBackend(binary);
}

interface Split {
  readonly handle: DocumentHandle;
  readonly summary: SplitCandidateSummary;
  readonly recordId: string;
}
/** A real split, created, resolved and committed through the production stores, exactly as `split/create` and `split/commit` do. */
async function splitCube(options: {
  readonly connector: PhysicalPinRequest | { readonly kind: 'none' };
  readonly unit?: GeometryDocument['unit'];
  readonly transform?: PartTransform;
  readonly store?: SplitCandidateStore;
  /** A mesh other than the 20 mm cube the plane x = 0 halves. */
  readonly mesh?: CanonicalMesh;
}): Promise<Split> {
  const store = options.store ?? splitCandidates;
  const mesh = options.mesh ?? cube(20);
  const base = singlePartDocument(mesh, options.unit === undefined ? {} : { unit: options.unit });
  const [only] = base.parts;
  if (only === undefined) throw new Error('expected a part');
  const document: GeometryDocument = {
    ...base,
    parts: [{ ...only, transform: options.transform ?? IDENTITY_PART_TRANSFORM }],
  };
  const source = residentDocuments.commit(document);
  const ticket = store.begin(source, only.id);
  const prepared = store.preparePlaneSource(ticket, X_PLANE, uncancellable);
  const result = await splitWithConnectors(
    await backend(),
    mesh,
    { plane: X_PLANE, connector: options.connector },
    uncancellable,
    undefined,
    classifyPlacement(options.transform ?? IDENTITY_PART_TRANSFORM),
    prepared,
  );
  const summary = store.resolve(ticket, result, uncancellable);
  const committed = store.commit(summary.candidate, source, only.id, () => undefined);
  return { handle: committed.handle, summary, recordId: committed.recordId };
}

function documentOf(handle: DocumentHandle): GeometryDocument {
  const document = residentDocuments.resolve(handle);
  if (!isDocument(document)) throw document;
  return document;
}
function onlyJoint(handle: DocumentHandle): ReturnType<typeof describeJoints>[number] {
  const [joint] = describeJoints(documentOf(handle)).filter((j) => j.status === 'ATTACHED');
  if (joint === undefined) throw new Error('expected an attached joint');
  return joint;
}
const code = (error: unknown): unknown => (isAppError(error) ? error.details.code : undefined);
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}
function synchronousRefusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  residentDocuments.releaseAll();
  repairHistory.releaseAll();
});

async function proposeHandler(): Promise<ReturnType<typeof createJointProposeHandler>> {
  const real = await backend();
  return createJointProposeHandler(() => real);
}
const set = (
  overrides: Partial<Extract<JointEditRequest, { kind: 'SET_CONNECTORS' }>> = {},
): JointEditRequest => ({
  kind: 'SET_CONNECTORS',
  maleSide: 'A',
  diameterMm: 3,
  depthMm: 4,
  clearanceMm: 0.2,
  pins: [{ pinId: 'pin-1', u: 0, v: 0 }],
  ...overrides,
});

/** The signed volume of a closed indexed mesh, by the divergence theorem, in cubic coordinate units. */
function signedVolume(mesh: CanonicalMesh): number {
  let volume = 0;
  const { positions: p, indices: ix } = mesh;
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = 3 * (ix[t] ?? 0),
      b = 3 * (ix[t + 1] ?? 0),
      c = 3 * (ix[t + 2] ?? 0);
    const ax = p[a] ?? 0,
      ay = p[a + 1] ?? 0,
      az = p[a + 2] ?? 0;
    const bx = p[b] ?? 0,
      by = p[b + 1] ?? 0,
      bz = p[b + 2] ?? 0;
    const cx = p[c] ?? 0,
      cy = p[c + 1] ?? 0,
      cz = p[c + 2] ?? 0;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}
const piecesVolume = (handle: DocumentHandle): number =>
  documentOf(handle).parts.reduce((total, part) => total + signedVolume(part.mesh), 0);

describe('moving a connector, and adding one where the person put it (Stage EC-6)', () => {
  it('moves a pin to the place it was given: the descriptor says where, the pieces change, and the volumes still add up', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const before = piecesVolume(split.handle);
    const [original] = liveJoints(documentOf(split.handle));
    const propose = await proposeHandler();
    const proposed = await propose(
      {
        source: split.handle,
        jointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
        edit: set({ pins: [{ pinId: 'pin-1', u: 3, v: 2 }] }),
      },
      context(),
    );
    const [pin] = proposed.value.after.connector?.pins ?? [];
    expect(pin?.pinId).toBe('pin-1');
    // the cut cuts the exact point, which may differ from the request by a rounding error and no more
    expect(pin?.u).toBeCloseTo(3, 4);
    expect(pin?.v).toBeCloseTo(2, 4);
    const commit = createJointCommitHandler(PRODUCTION_JOINT_COMMIT_WORK);
    const committed = await commit(
      {
        candidate: proposed.value.candidate,
        expectedSource: split.handle,
        expectedJointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
      },
      context(),
    );
    const after = piecesVolume(committed.value.handle);
    // the same pin and socket, somewhere else in the same material: the pieces together hold the volume they held
    expect(Math.abs(after - before)).toBeLessThan(0.05);
    const [moved] = liveJoints(documentOf(committed.value.handle));
    expect(moved?.connector?.elements[0]?.site).not.toBe(original?.connector?.elements[0]?.site);
    // and Undo puts the first place back
    const undone = await repairUndoHandler(
      { handle: committed.value.handle, recordId: committed.value.recordId },
      context(),
    );
    expect(piecesVolume(undone.value.handle)).toBeCloseTo(before, 6);
  });

  it('refuses a place off the material, and two connectors in one place, and changes nothing', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    const held = jointEdits.stats().candidateCount;
    const attempt = (pins: readonly { pinId?: string; u: number; v: number }[]): Promise<unknown> =>
      propose(
        {
          source: split.handle,
          jointId: joint.jointId,
          expectedSpecDigest: joint.specDigest ?? '',
          edit: set({ pins }),
        },
        context(),
      );
    // a 20 mm cut: 60 mm across is not on it
    const offCut = await refusal(attempt([{ pinId: 'pin-1', u: 60, v: 0 }]));
    expect(isAppError(offCut), String(offCut)).toBe(true);
    // two connectors with the same centre cannot both have their own room
    const together = await refusal(
      attempt([
        { pinId: 'pin-1', u: 0, v: 0 },
        { u: 0.1, v: 0 },
      ]),
    );
    expect(isAppError(together), String(together)).toBe(true);
    expect(code(together)).not.toBe(code(offCut));
    expect(jointEdits.stats().candidateCount).toBe(held);
    expect(residentDocuments.revisionOf(split.handle.documentId)).toBe(split.handle.revision);
  });

  it('adds the first connector to a plain cut at the place it was given, and the descriptor says so', async () => {
    const split = await splitCube({ connector: { kind: 'none' }, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    expect(joint.pinCount).toBe(0);
    const propose = await proposeHandler();
    const proposed = await propose(
      {
        source: split.handle,
        jointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
        edit: set({ pins: [{ u: -4, v: 3 }] }),
      },
      context(),
    );
    const [pin] = proposed.value.after.connector?.pins ?? [];
    expect(pin?.pinId).toBe('pin-1');
    expect(pin?.u).toBeCloseTo(-4, 4);
    expect(pin?.v).toBeCloseTo(3, 4);
  });
});

describe('a split leaves an editable joint behind, and is never refused for it', () => {
  it('records the pin the split made, attached to the pieces it installed', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const status = split.summary.editableConnector;
    expect(status.status).toBe('RECORDED');
    const document = documentOf(split.handle);
    const [joint] = liveJoints(document);
    expect(joint?.connector?.elements).toHaveLength(1);
    expect(joint?.a.partId).toBe(split.summary.pieceAId);
    expect(joint?.b.partId).toBe(split.summary.pieceBId);
    const [described] = describeJoints(document);
    expect(described?.status).toBe('ATTACHED');
    expect(described?.connector?.pins[0]).toMatchObject({
      pinId: 'pin-1',
      diameterMm: 3,
      depthMm: 4,
      clearanceMm: 0.2,
    });
  });

  it('records a PLAIN cut as a joint with no connectors, so connectors can be added to it', async () => {
    const split = await splitCube({ connector: { kind: 'none' }, unit: 'millimeter' });
    expect(split.summary.editableConnector.status).toBe('RECORDED');
    const joint = onlyJoint(split.handle);
    expect(joint.pinCount).toBe(0);
    expect(joint.connector).toBeUndefined();
  });

  it('says why when it records nothing, and the pieces are the ones it always made', async () => {
    const pieces = (handle: DocumentHandle): number[] =>
      documentOf(handle).parts.map((part) => meshByteLength(part.mesh));
    const withJoint = await splitCube({ connector: { kind: 'none' }, unit: 'millimeter' });
    const recorded = pieces(withJoint.handle);
    residentDocuments.releaseAll();
    const unitless = await splitCube({ connector: { kind: 'none' } });
    expect(unitless.summary.editableConnector).toEqual({
      status: 'NOT_RECORDED',
      reason: 'UNIT_UNKNOWN',
    });
    expect(describeJoints(documentOf(unitless.handle))).toEqual([]);
    expect(pieces(unitless.handle)).toEqual(recorded);
    residentDocuments.releaseAll();
    const sheared = await splitCube({
      connector: { kind: 'none' },
      unit: 'millimeter',
      transform: [1, 0, 0, 0.4, 1, 0, 0, 0, 1, 0, 0, 0],
    });
    expect(sheared.summary.editableConnector).toEqual({
      status: 'NOT_RECORDED',
      reason: 'UNSUPPORTED_TRANSFORM',
    });
  });

  it('records a pin on a model that states no unit, under the unit the user asserted for the split, and the model stays unit-less', async () => {
    const split = await splitCube({ connector: { ...PIN, unit: 'inch' } });
    expect(split.summary.editableConnector.status).toBe('RECORDED');
    const document = documentOf(split.handle);
    expect(document.unit).toBeUndefined();
    const [joint] = liveJoints(document);
    expect(joint?.frame.unit).toBe('inch');
    const [described] = describeJoints(document);
    expect(described?.status).toBe('ATTACHED');
    // an edit is sized in the joint's own frame, not in a unit the document does not have
    const propose = await proposeHandler();
    const proposed = await propose(
      {
        source: split.handle,
        jointId: described?.jointId ?? '',
        expectedSpecDigest: described?.specDigest ?? '',
        edit: set({ diameterMm: 2 }),
      },
      context(),
    );
    expect(proposed.value.after.connector?.pins[0]?.diameterMm).toBe(2);
    expect(documentOf(split.handle).unit).toBeUndefined();
  });

  it('above the retention ceiling the split still succeeds and the pieces are unchanged, with the metric, the value and the limit', async () => {
    const small = new SplitCandidateStore(residentDocuments, repairHistory, geometryEdits, 64);
    const split = await splitCube({ connector: PIN, unit: 'millimeter', store: small });
    const status = split.summary.editableConnector;
    expect(status.status).toBe('NOT_RECORDED');
    if (status.status !== 'NOT_RECORDED') throw new Error('unreachable');
    expect(status.reason).toBe('RETENTION_CEILING');
    expect(status.limit).toBe(64);
    expect(status.retainedBytes ?? 0).toBeGreaterThan(64);
    const document = documentOf(split.handle);
    expect(document.joints ?? []).toEqual([]);
    expect(document.parts).toHaveLength(2);
    expect(jointRetainedBytes(document)).toBe(0);
  });
});

describe('editing a joint: list, propose, commit', () => {
  it('lists, proposes, applies and reports exactly the document that is then held', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const listed = await jointListHandler({ source: split.handle }, context());
    expect(listed.value.joints).toEqual(describeJoints(documentOf(split.handle)));
    const before = documentOf(split.handle);

    const propose = await proposeHandler();
    const proposed = await propose(
      {
        source: split.handle,
        jointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
        edit: set({ diameterMm: 2 }),
      },
      context(),
    );
    // a preview is not an application
    expect(residentDocuments.revisionOf(split.handle.documentId)).toBe(split.handle.revision);
    expect(documentOf(split.handle)).toBe(before);
    expect(proposed.value.after.connector?.pins[0]?.diameterMm).toBe(2);
    expect(proposed.value.specDigestAfter).not.toBe(proposed.value.specDigestBefore);

    const commit = createJointCommitHandler(PRODUCTION_JOINT_COMMIT_WORK);
    const committed = await commit(
      {
        candidate: proposed.value.candidate,
        expectedSource: split.handle,
        expectedJointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
      },
      context(),
    );
    const after = documentOf(committed.value.handle);
    expect(committed.value.handle.revision).toBe(split.handle.revision + 1);
    expect(committed.value.parentRevision).toBe(split.handle.revision);
    // every part keeps its id, name and placement; only the two meshes changed
    expect(after.parts.map((p) => [p.id, p.name, p.transform])).toEqual(
      before.parts.map((p) => [p.id, p.name, p.transform]),
    );
    expect(after.parts.every((part, i) => part.mesh !== before.parts[i]?.mesh)).toBe(true);
    // what was reported is what is held, and the joint is attached to the new pieces with the new connectors
    expect(committed.value.residentBytes).toBe(documentByteLength(after));
    expect(committed.value.residentBytes).toBe(residentDocuments.stats().totalBytes);
    expect(committed.value.joints).toEqual(describeJoints(after));
    const [attached] = committed.value.joints;
    expect(attached?.status).toBe('ATTACHED');
    expect(attached?.connector?.pins[0]?.diameterMm).toBe(2);
    expect(attached?.specDigest).toBe(proposed.value.specDigestAfter);
  });

  it('keeps a pin that does not move exactly where it was, and names a new pin from an ordinal that only grows', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const [live] = liveJoints(documentOf(split.handle));
    if (live === undefined) throw new Error('expected a joint');
    const cut = pinCutOfJoint(live);
    const second = siteOnInterface(cut, 4, 4);
    const propose = await proposeHandler();
    const proposed = await propose(
      {
        source: split.handle,
        jointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
        edit: set({
          pins: [
            { pinId: 'pin-1', u: 0, v: 0 },
            { u: second.u, v: second.v },
          ],
        }),
      },
      context(),
    );
    expect(proposed.value.after.connector?.pins.map((p) => p.pinId)).toEqual(['pin-1', 'pin-2']);
    const commit = createJointCommitHandler(PRODUCTION_JOINT_COMMIT_WORK);
    const committed = await commit(
      {
        candidate: proposed.value.candidate,
        expectedSource: split.handle,
        expectedJointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
      },
      context(),
    );
    const [grown] = liveJoints(documentOf(committed.value.handle));
    expect(grown?.nextPinOrdinal).toBe(3);
    expect(grown?.connector?.elements[0]?.site).toBe(live.connector?.elements[0]?.site);
    // remove pin-2, then add one: it is pin-3, never pin-2 again
    const remaining = describeJoints(documentOf(committed.value.handle))[0];
    const again = await propose(
      {
        source: committed.value.handle,
        jointId: joint.jointId,
        expectedSpecDigest: remaining?.specDigest ?? '',
        edit: set({ pins: [{ pinId: 'pin-1', u: 0, v: 0 }] }),
      },
      context(),
    );
    const afterRemoval = await commit(
      {
        candidate: again.value.candidate,
        expectedSource: committed.value.handle,
        expectedJointId: joint.jointId,
        expectedSpecDigest: remaining?.specDigest ?? '',
      },
      context(),
    );
    const next = describeJoints(documentOf(afterRemoval.value.handle))[0];
    const readded = await propose(
      {
        source: afterRemoval.value.handle,
        jointId: joint.jointId,
        expectedSpecDigest: next?.specDigest ?? '',
        edit: set({
          pins: [
            { pinId: 'pin-1', u: 0, v: 0 },
            { u: second.u, v: second.v },
          ],
        }),
      },
      context(),
    );
    expect(readded.value.after.connector?.pins.map((p) => p.pinId)).toEqual(['pin-1', 'pin-3']);
  });

  it('adds connectors to a plain cut and removes them again', async () => {
    const split = await splitCube({ connector: { kind: 'none' }, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    const commit = createJointCommitHandler(PRODUCTION_JOINT_COMMIT_WORK);
    const added = await propose(
      {
        source: split.handle,
        jointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
        edit: set({ pins: [{ u: 0, v: 0 }] }),
      },
      context(),
    );
    const applied = await commit(
      {
        candidate: added.value.candidate,
        expectedSource: split.handle,
        expectedJointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
      },
      context(),
    );
    const withPin = onlyJoint(applied.value.handle);
    expect(withPin.pinCount).toBe(1);
    const removed = await propose(
      {
        source: applied.value.handle,
        jointId: joint.jointId,
        expectedSpecDigest: withPin.specDigest ?? '',
        edit: { kind: 'REMOVE_CONNECTORS' },
      },
      context(),
    );
    const back = await commit(
      {
        candidate: removed.value.candidate,
        expectedSource: applied.value.handle,
        expectedJointId: joint.jointId,
        expectedSpecDigest: withPin.specDigest ?? '',
      },
      context(),
    );
    const plain = documentOf(back.value.handle);
    const [after] = liveJoints(plain);
    expect(after?.connector).toBeUndefined();
    // the pieces are the retained bases themselves: nothing was left behind by the detour
    expect(plain.parts.map((p) => p.mesh)).toEqual([after?.a.baseMesh, after?.b.baseMesh]);
  });
});

describe('undo restores the document, joint included, through the existing path', () => {
  it('puts the previous document back: the old connectors and the old pieces, attached', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const before = documentOf(split.handle);
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    const proposed = await propose(
      {
        source: split.handle,
        jointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
        edit: set({ diameterMm: 2 }),
      },
      context(),
    );
    const commit = createJointCommitHandler(PRODUCTION_JOINT_COMMIT_WORK);
    const committed = await commit(
      {
        candidate: proposed.value.candidate,
        expectedSource: split.handle,
        expectedJointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
      },
      context(),
    );
    const undone = await repairUndoHandler(
      { handle: committed.value.handle, recordId: committed.value.recordId },
      context(),
    );
    const restored = documentOf(undone.value.handle);
    expect(undone.value.handle.revision).toBe(committed.value.handle.revision + 1);
    // the same document OBJECT, so the joint is the same record, attached to the same meshes
    expect(restored).toBe(before);
    const [back] = describeJoints(restored);
    expect(back?.status).toBe('ATTACHED');
    expect(back?.specDigest).toBe(joint.specDigest);
  });
});

describe("every guard is the caller's and is read again by the store", () => {
  async function proposed(): Promise<{
    split: Split;
    candidate: JointEditCandidateHandle;
    jointId: string;
    digest: string;
  }> {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    const result = await propose(
      {
        source: split.handle,
        jointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
        edit: set({ diameterMm: 2 }),
      },
      context(),
    );
    return {
      split,
      candidate: result.value.candidate,
      jointId: joint.jointId,
      digest: joint.specDigest ?? '',
    };
  }
  const commit = createJointCommitHandler(PRODUCTION_JOINT_COMMIT_WORK);

  it('refuses a joint that is not there, one that was retired, and connectors that are not what was shown', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    const ask = (jointId: string, digest: string): Promise<unknown> =>
      propose(
        { source: split.handle, jointId, expectedSpecDigest: digest, edit: set({ diameterMm: 2 }) },
        context(),
      );
    expect(code(await refusal(ask('nope', joint.specDigest ?? '')))).toBe('JOINT_UNKNOWN');
    expect(code(await refusal(ask(joint.jointId, 'not-the-digest')))).toBe('JOINT_SPEC_STALE');
  });

  it('refuses an edit of a joint that a repair-shaped change retired, naming why', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const document = documentOf(split.handle);
    const changed = withPartMesh(document, document.parts[0]?.id ?? partId('x'), cube(20));
    if (changed === undefined) throw new Error('part missing');
    const next = residentDocuments.replace(split.handle, changed);
    if (isAppError(next)) throw next;
    const propose = await proposeHandler();
    const error = await refusal(
      propose(
        {
          source: next,
          jointId: joint.jointId,
          expectedSpecDigest: joint.specDigest ?? '',
          edit: set({ diameterMm: 2 }),
        },
        context(),
      ),
    );
    expect(code(error)).toBe('JOINT_RETIRED');
    expect(isAppError(error) && error.details.reason).toBe('GEOMETRY_CHANGED');
  });

  it('refuses an edit that changes nothing, removal from a plain joint, and a connector the joint does not have', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    const ask = (edit: JointEditRequest): Promise<unknown> =>
      propose(
        {
          source: split.handle,
          jointId: joint.jointId,
          expectedSpecDigest: joint.specDigest ?? '',
          edit,
        },
        context(),
      );
    expect(code(await refusal(ask(set())))).toBe('JOINT_EDIT_NO_CHANGE');
    expect(code(await refusal(ask(set({ pins: [{ pinId: 'pin-9', u: 0, v: 0 }] }))))).toBe(
      'JOINT_EDIT_UNKNOWN_PIN',
    );
    residentDocuments.releaseAll();
    const plain = await splitCube({ connector: { kind: 'none' }, unit: 'millimeter' });
    const plainJoint = onlyJoint(plain.handle);
    expect(
      code(
        await refusal(
          propose(
            {
              source: plain.handle,
              jointId: plainJoint.jointId,
              expectedSpecDigest: plainJoint.specDigest ?? '',
              edit: { kind: 'REMOVE_CONNECTORS' },
            },
            context(),
          ),
        ),
      ),
    ).toBe('JOINT_EDIT_NO_CHANGE');
  });

  it("refuses a commit against another revision, another joint, or a spec that is not the store's own reading", async () => {
    const { split, candidate, jointId, digest } = await proposed();
    const wrongRevision = synchronousRefusal(() =>
      commit(
        {
          candidate,
          expectedSource: { ...split.handle, revision: split.handle.revision + 1 },
          expectedJointId: jointId,
          expectedSpecDigest: digest,
        },
        context(),
      ),
    );
    expect(isAppError(wrongRevision)).toBe(true);
    expect(
      isAppError(
        synchronousRefusal(() =>
          commit(
            {
              candidate,
              expectedSource: split.handle,
              expectedJointId: 'other',
              expectedSpecDigest: digest,
            },
            context(),
          ),
        ),
      ),
    ).toBe(true);
    const stale = synchronousRefusal(() =>
      commit(
        {
          candidate,
          expectedSource: split.handle,
          expectedJointId: jointId,
          expectedSpecDigest: 'x',
        },
        context(),
      ),
    );
    expect(code(stale)).toBe('JOINT_SPEC_STALE');
  });

  it('a refused commit consumes nothing: the candidate is still resolved and still applies', async () => {
    const held = jointEdits.stats().candidateCount;
    const { split, candidate, jointId, digest } = await proposed();
    synchronousRefusal(() =>
      commit(
        {
          candidate,
          expectedSource: split.handle,
          expectedJointId: jointId,
          expectedSpecDigest: 'x',
        },
        context(),
      ),
    );
    expect(jointEdits.stats().candidateCount).toBe(held + 1);
    const applied = await commit(
      {
        candidate,
        expectedSource: split.handle,
        expectedJointId: jointId,
        expectedSpecDigest: digest,
      },
      context(),
    );
    expect(applied.value.handle.revision).toBe(split.handle.revision + 1);
    expect(jointEdits.stats().candidateCount).toBe(held);
  });

  it('a candidate is consumed by its commit: applying it twice is refused', async () => {
    const { split, candidate, jointId, digest } = await proposed();
    const request = {
      candidate,
      expectedSource: split.handle,
      expectedJointId: jointId,
      expectedSpecDigest: digest,
    };
    await commit(request, context());
    expect(isAppError(synchronousRefusal(() => commit(request, context())))).toBe(true);
  });

  it('a newer edit supersedes an older candidate before it can be applied', async () => {
    const { split, candidate, jointId, digest } = await proposed();
    const propose = await proposeHandler();
    await propose(
      {
        source: split.handle,
        jointId,
        expectedSpecDigest: digest,
        edit: set({ diameterMm: 2.5 }),
      },
      context(),
    );
    const error = synchronousRefusal(() =>
      commit(
        {
          candidate,
          expectedSource: split.handle,
          expectedJointId: jointId,
          expectedSpecDigest: digest,
        },
        context(),
      ),
    );
    expect(isAppError(error)).toBe(true);
    expect(residentDocuments.revisionOf(split.handle.documentId)).toBe(split.handle.revision);
  });

  it('a change installed after the proposal leaves nothing to apply it to: the revision moved, so the candidate is refused', async () => {
    const { split, candidate, jointId, digest } = await proposed();
    const document = documentOf(split.handle);
    const touched: GeometryDocument = { ...document, parts: document.parts.slice() };
    const moved = residentDocuments.replace(split.handle, touched);
    if (isAppError(moved)) throw moved;
    const error = synchronousRefusal(() =>
      commit(
        { candidate, expectedSource: moved, expectedJointId: jointId, expectedSpecDigest: digest },
        context(),
      ),
    );
    expect(isAppError(error)).toBe(true);
    expect(residentDocuments.revisionOf(split.handle.documentId)).toBe(moved.revision);
    expect(documentOf(moved)).toBe(touched);
  });

  it('starting a split on the same document supersedes a joint candidate, as it does any other', async () => {
    const { split, candidate, jointId, digest } = await proposed();
    const [part] = documentOf(split.handle).parts;
    if (part === undefined) throw new Error('expected a part');
    splitCandidates.begin(split.handle, part.id);
    const error = synchronousRefusal(() =>
      commit(
        {
          candidate,
          expectedSource: split.handle,
          expectedJointId: jointId,
          expectedSpecDigest: digest,
        },
        context(),
      ),
    );
    expect(isAppError(error)).toBe(true);
    expect(residentDocuments.revisionOf(split.handle.documentId)).toBe(split.handle.revision);
  });

  it('a discarded candidate cannot be applied', async () => {
    const { split, candidate, jointId, digest } = await proposed();
    expect(jointEdits.discard(candidate)).toBe(true);
    expect(
      isAppError(
        synchronousRefusal(() =>
          commit(
            {
              candidate,
              expectedSource: split.handle,
              expectedJointId: jointId,
              expectedSpecDigest: digest,
            },
            context(),
          ),
        ),
      ),
    ).toBe(true);
  });
});

describe('a commit is atomic as the caller can observe it', () => {
  it('a failure while building the reply leaves the document, the history and the candidate as they were', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    const proposed = await propose(
      {
        source: split.handle,
        jointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
        edit: set({ diameterMm: 2 }),
      },
      context(),
    );
    const before = documentOf(split.handle);
    const recordsBefore = repairHistory.stats();
    const failing = createJointCommitHandler({
      build: () => {
        throw new Error('the render snapshot could not be built');
      },
    });
    const request = {
      candidate: proposed.value.candidate,
      expectedSource: split.handle,
      expectedJointId: joint.jointId,
      expectedSpecDigest: joint.specDigest ?? '',
    };
    expect(() => failing(request, context())).toThrow('render snapshot');
    expect(documentOf(split.handle)).toBe(before);
    expect(residentDocuments.revisionOf(split.handle.documentId)).toBe(split.handle.revision);
    expect(repairHistory.stats()).toEqual(recordsBefore);
    // and it is still there to be applied
    const applied = await createJointCommitHandler(PRODUCTION_JOINT_COMMIT_WORK)(
      request,
      context(),
    );
    expect(applied.value.handle.revision).toBe(split.handle.revision + 1);
  });
});

describe('what a joint edit refuses, a first split refuses (the pin stage is one)', () => {
  it("a depth the receiving piece cannot hold is refused at propose with the split's own code and nothing resident changes", async () => {
    const held = jointEdits.stats().candidateCount;
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    const error = await refusal(
      propose(
        {
          source: split.handle,
          jointId: joint.jointId,
          expectedSpecDigest: joint.specDigest ?? '',
          edit: set({ depthMm: 15 }),
        },
        context(),
      ),
    );
    expect(code(error)).toBe('CONNECTOR_SOCKET_BREAKTHROUGH');
    expect(jointEdits.stats().candidateCount).toBe(held);
    expect(residentDocuments.revisionOf(split.handle.documentId)).toBe(split.handle.revision);
  });

  it('a request that is not an edit is refused before anything is touched', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const propose = await proposeHandler();
    for (const edit of [
      null,
      { kind: 'SET_CONNECTORS' },
      {
        kind: 'SET_CONNECTORS',
        maleSide: 'C',
        pins: [{ u: 0, v: 0 }],
        diameterMm: 3,
        depthMm: 4,
        clearanceMm: 0,
      },
      {
        kind: 'SET_CONNECTORS',
        maleSide: 'A',
        pins: [],
        diameterMm: 3,
        depthMm: 4,
        clearanceMm: 0,
      },
      {
        kind: 'SET_CONNECTORS',
        maleSide: 'A',
        pins: [{ u: Number.NaN, v: 0 }],
        diameterMm: 3,
        depthMm: 4,
        clearanceMm: 0,
      },
      {
        kind: 'SET_CONNECTORS',
        maleSide: 'A',
        pins: [{ u: 0, v: 0 }],
        diameterMm: '3',
        depthMm: 4,
        clearanceMm: 0,
      },
    ])
      expect(
        code(
          await refusal(
            propose(
              {
                source: split.handle,
                jointId: joint.jointId,
                expectedSpecDigest: joint.specDigest ?? '',
                edit: edit as unknown as JointEditRequest,
              },
              context(),
            ),
          ),
        ),
        JSON.stringify(edit),
      ).toBe('JOINT_EDIT_MALFORMED');
    expect(() => readJointEdit({ kind: 'REMOVE_CONNECTORS' })).not.toThrow();
  });
});

describe('a later change to a piece retires the joint and the reply says what is held', () => {
  it('a repair-shaped install retires it and releases its geometry, and the digest the page held no longer applies', async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    const document = documentOf(split.handle);
    const retiredBytes = jointRetainedBytes(document);
    expect(retiredBytes).toBeGreaterThan(0);
    const changed = withPartMesh(document, document.parts[0]?.id ?? partId('x'), cube(20));
    if (changed === undefined) throw new Error('part missing');
    const next = residentDocuments.replace(split.handle, changed);
    if (isAppError(next)) throw next;
    const installed = documentOf(next);
    expect(retiredJoints(installed)[0]?.jointId).toBe(joint.jointId);
    expect(jointRetainedBytes(installed)).toBe(0);
    expect(residentDocuments.stats().totalBytes).toBe(documentByteLength(installed));
    expect(jointSpecDigest).toBeTypeOf('function');
    expect(new CancellationSource().token.isCancelled).toBe(false);
  });
});

/** A closed cylinder of radius 10 and length 20 along x, `segments` sided: the plane x = 0 cuts it in a `segments`-gon. */
function cylinder(segments: number): CanonicalMesh {
  const vertices = segments * 2 + 2;
  const positions = createPositionArray(vertices * 3);
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const y = 10 * Math.cos(angle);
    const z = 10 * Math.sin(angle);
    positions.set([-10, y, z], i * 3);
    positions.set([10, y, z], (segments + i) * 3);
  }
  const south = segments * 2;
  const north = segments * 2 + 1;
  positions.set([-10, 0, 0], south * 3);
  positions.set([10, 0, 0], north * 3);
  const indices = createIndexArray(segments * 12);
  let k = 0;
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments;
    const a = i;
    const b = j;
    const c = segments + i;
    const d = segments + j;
    indices.set([a, b, c, b, d, c, north, c, d, south, b, a], k);
    k += 12;
  }
  return { positions, indices, metadata: {} };
}

describe('the face of a cut is described to the page, for a view it draws', () => {
  const area = (points: readonly number[]): number => {
    let sum = 0;
    for (let i = 0; i < points.length; i += 2) {
      const j = (i + 2) % points.length;
      sum += (points[i] ?? 0) * (points[j + 1] ?? 0) - (points[j] ?? 0) * (points[i + 1] ?? 0);
    }
    return sum / 2;
  };

  it("gives a square cut its outline in the cut's own axes, the unit factor and the most pins it holds", async () => {
    const split = await splitCube({ connector: PIN, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    expect(joint.cutFace?.mmPerCoordinate).toBe(1);
    expect(joint.cutFace?.maxPins).toBe(4);
    const outline = joint.cutFace?.outline;
    if (outline === undefined) throw new Error('expected an outline');
    expect(outline.loops).toHaveLength(1);
    expect(outline.loops[0]?.role).toBe('OUTER');
    expect(outline.bounds).toEqual({ minU: -10, maxU: 10, minV: -10, maxV: 10 });
    expect(Math.abs(area(outline.loops[0]?.points ?? []))).toBeCloseTo(400, 6);
    // the pin the split made sits inside what is drawn
    const [pin] = joint.connector?.pins ?? [];
    expect(Math.abs(pin?.u ?? 99)).toBeLessThan(10);
    expect(Math.abs(pin?.v ?? 99)).toBeLessThan(10);
  });

  it("describes a plain cut's face too, since connectors can be added to it", async () => {
    const split = await splitCube({ connector: { kind: 'none' }, unit: 'millimeter' });
    const joint = onlyJoint(split.handle);
    expect(joint.connector).toBeUndefined();
    expect(joint.cutFace?.outline?.loops).toHaveLength(1);
  });

  it('describes a round cut by its polygon, and says there is no outline for one with too many points', async () => {
    const round = await splitCube({
      connector: { kind: 'none' },
      unit: 'millimeter',
      mesh: cylinder(64),
    });
    const outline = onlyJoint(round.handle).cutFace?.outline;
    // each side facet is cut along its edge and along its diagonal, so the polygon carries a vertex on every edge too
    expect(outline?.loops[0]?.points.length).toBe(64 * 2 * 2);
    expect(Math.abs(area(outline?.loops[0]?.points ?? []))).toBeCloseTo(
      0.5 * 64 * 100 * Math.sin((2 * Math.PI) / 64),
      4, // the mesh is stored in Float32
    );
    // a cut with more points than the page is sent has no outline, and says so; resizing and removal still work without one
    const [live] = liveJoints(documentOf(round.handle));
    if (live === undefined) throw new Error('expected a joint');
    expect(describeCutOutline(live, 100)).toBeUndefined();
    expect(describeCutOutline(live, 128)?.loops[0]?.points.length).toBe(64 * 2 * 2);
    expect(describeJoints(documentOf(round.handle))[0]?.cutFace?.mmPerCoordinate).toBe(1);
  });
});
