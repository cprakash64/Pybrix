import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import { AppError, AppErrorCode, invalidState } from '@cadfixer/shared';
import type {
  DocumentHandle,
  DocumentId,
  JointCommitResult,
  JointDescriptor,
  JointEditRequest,
  JointProposeResult,
  PartDescriptor,
  RepairUndoResult,
} from '@cadfixer/geometry-runtime';
import { GeometryClientProvider } from '../runtime/client-context';
import type { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from './store-context';
import { StatusSeverity, WorkspaceStore } from './workspace-store';
import { CONNECTOR_EDIT_COPY } from './connector-edit-presentation';
import { ConnectorEditPhase, draftProblem, useConnectorEdit } from './use-connector-edit';
import type { LoadedModel } from './model';

/*
 * Stage EC-5. The editor holds a draft of four values and a candidate handle, and every answer is the worker's. These tests drive it
 * with a stand-in client whose answers they control, which is the only seam the page has to the worker, and read the store the way the
 * screen does.
 */
const part = (partId: string): PartDescriptor => ({
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
});
const handleAt = (revision: number): DocumentHandle => ({
  documentId: 'doc-1' as DocumentId,
  revision,
});
function loaded(store: WorkspaceStore, revision = 1): void {
  const model: Omit<LoadedModel, 'revision'> = {
    handle: handleAt(revision),
    parts: [part('a'), part('b')],
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
    triangleCount: 24,
    vertexCount: 72,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 1,
  };
  store.commitImport(store.beginImport('cube.stl'), model);
}
/** A recorded cut with no connectors: no `connector` key at all, as the worker describes one. */
function plainCut(): JointDescriptor {
  return {
    jointId: 'doc-1/joint/1',
    aPartId: 'a',
    bPartId: 'b',
    status: 'ATTACHED',
    pinCount: 0,
    retainedBytes: 0,
    specDigest: 'digest-plain',
  };
}
function joint(overrides: Partial<JointDescriptor> = {}, diameterMm = 4): JointDescriptor {
  return {
    jointId: 'doc-1/joint/1',
    aPartId: 'a',
    bPartId: 'b',
    status: 'ATTACHED',
    pinCount: 1,
    retainedBytes: 0,
    specDigest: `digest-${String(diameterMm)}`,
    connector: {
      maleSide: 'A',
      axis: [-1, 0, 0],
      mmPerSceneUnit: 1,
      pins: [
        {
          pinId: 'pin-1',
          u: 1.5,
          v: -2,
          center: [0, 1.5, -2],
          diameterMm,
          depthMm: 6,
          clearanceMm: 0.2,
        },
      ],
    },
    ...overrides,
  };
}
const list = (store: WorkspaceStore, joints: readonly JointDescriptor[], revision = 1): void => {
  act(() => {
    store.setJoints({ status: 'READY', documentId: 'doc-1', revision, joints });
  });
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const candidateHandle = {
  candidateId: 'c-1',
  jointId: 'doc-1/joint/1',
} as unknown as JointProposeResult['candidate'];
function proposed(after: JointDescriptor): JointProposeResult {
  return {
    candidate: candidateHandle,
    jointId: 'doc-1/joint/1',
    specDigestBefore: 'digest-4',
    specDigestAfter: 'digest-3',
    after,
    render: { parts: [] },
    parts: [part('a'), part('b')],
    resources: { triangles: 24 },
    triangleCountBefore: 24,
    triangleCountAfter: 24,
  } as unknown as JointProposeResult;
}
function committed(revision: number): JointCommitResult {
  return {
    handle: handleAt(revision),
    parentRevision: revision - 1,
    recordId: 'rec-1',
    render: { parts: [] },
    parts: [part('a'), part('b')],
    joints: [],
    residentBytes: 2,
    triangleCount: 30,
    vertexCount: 90,
    bounds: undefined,
  } as unknown as JointCommitResult;
}

function mount(): {
  store: WorkspaceStore;
  client: {
    proposeJointEdit: ReturnType<typeof vi.fn>;
    commitJointEdit: ReturnType<typeof vi.fn>;
    discardJointEdit: ReturnType<typeof vi.fn>;
    undoRepair: ReturnType<typeof vi.fn>;
  };
  proposals: Deferred<JointProposeResult>[];
  commits: Deferred<JointCommitResult>[];
  undos: Deferred<RepairUndoResult>[];
  result: { current: ReturnType<typeof useConnectorEdit> };
  unmount: () => void;
} {
  const store = new WorkspaceStore();
  loaded(store);
  const proposals: Deferred<JointProposeResult>[] = [];
  const commits: Deferred<JointCommitResult>[] = [];
  const undos: Deferred<RepairUndoResult>[] = [];
  const client = {
    proposeJointEdit: vi.fn(() => {
      const d = deferred<JointProposeResult>();
      proposals.push(d);
      return { promise: d.promise, cancel: vi.fn() };
    }),
    commitJointEdit: vi.fn(() => {
      const d = deferred<JointCommitResult>();
      commits.push(d);
      return { promise: d.promise };
    }),
    discardJointEdit: vi.fn(() => ({
      promise: Promise.resolve({ released: true }),
    })),
    undoRepair: vi.fn(() => {
      const d = deferred<RepairUndoResult>();
      undos.push(d);
      return { promise: d.promise };
    }),
  };
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client as unknown as GeometryClient}>
        {children}
      </GeometryClientProvider>
    </WorkspaceProvider>
  );
  const { result, unmount } = renderHook(() => useConnectorEdit(), { wrapper });
  return { store, client, proposals, commits, undos, result, unmount };
}
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('the connectors an edit starts from', () => {
  it('finds the attached cut with connectors that the active piece belongs to, and reads the draft from it', () => {
    const { store, result } = mount();
    expect(result.current.joint).toBeUndefined();
    list(store, [joint()]);
    expect(result.current.joint?.jointId).toBe('doc-1/joint/1');
    expect(result.current.draft).toEqual({
      diameterMm: 4,
      depthMm: 6,
      clearanceMm: 0.2,
      maleSide: 'A',
    });
    expect(result.current.changed).toBe(false);
    expect(result.current.phase).toBe(ConnectorEditPhase.Idle);
  });

  it("offers nothing for a cut with no connectors, a cut whose record has ended, or another piece's cut", () => {
    const { store, result } = mount();
    list(store, [plainCut()]);
    expect(result.current.joint).toBeUndefined();
    list(store, [joint({ status: 'RETIRED', reason: 'GEOMETRY_CHANGED' })]);
    expect(result.current.joint).toBeUndefined();
    list(store, [joint({ aPartId: 'x', bPartId: 'y' })]);
    expect(result.current.joint).toBeUndefined();
  });

  it("reports a size outside the physical range, in the split's own words, and will not check it", () => {
    const { store, result, client } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 0.001 });
    });
    expect(result.current.problem).toBe('Pin diameter must be between 0.01 and 1000 mm.');
    act(() => {
      result.current.check();
    });
    expect(client.proposeJointEdit).not.toHaveBeenCalled();
    expect(
      draftProblem({ diameterMm: 4, depthMm: 6, clearanceMm: 0, maleSide: 'A' }),
    ).toBeUndefined();
    expect(draftProblem({ diameterMm: 4, depthMm: 6, clearanceMm: -1, maleSide: 'A' })).toMatch(
      /Clearance/,
    );
  });

  it('will not check a draft that changes nothing', () => {
    const { store, result, client } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 4 });
    });
    expect(result.current.changed).toBe(false);
    act(() => {
      result.current.check();
    });
    expect(client.proposeJointEdit).not.toHaveBeenCalled();
  });
});

describe('checking, applying and undoing a change', () => {
  it('sends the draft with every pin keeping its name and its place, and states the digest it started from', () => {
    const { store, result, client } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3, maleSide: 'B' });
    });
    act(() => {
      result.current.check();
    });
    expect(result.current.phase).toBe(ConnectorEditPhase.Checking);
    const [source, jointId, digest, edit] = client.proposeJointEdit.mock.calls[0] as [
      DocumentHandle,
      string,
      string,
      JointEditRequest,
    ];
    expect(source).toEqual(handleAt(1));
    expect(jointId).toBe('doc-1/joint/1');
    expect(digest).toBe('digest-4');
    expect(edit).toEqual({
      kind: 'SET_CONNECTORS',
      maleSide: 'B',
      diameterMm: 3,
      depthMm: 6,
      clearanceMm: 0.2,
      pins: [{ pinId: 'pin-1', u: 1.5, v: -2 }],
    });
  });

  it('shows a preview that is not applied, then applies it, adopts the result and records one undo', async () => {
    const { store, result, client, proposals, commits } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[0]?.resolve(proposed(joint({}, 3)));
      await Promise.resolve();
    });
    expect(result.current.phase).toBe(ConnectorEditPhase.Ready);
    expect(result.current.kind).toBe('SET');
    expect(result.current.after?.connector?.pins[0]?.diameterMm).toBe(3);
    // the model has not moved
    expect(store.getSnapshot().model?.handle.revision).toBe(1);

    act(() => {
      result.current.apply();
    });
    expect(result.current.phase).toBe(ConnectorEditPhase.Applying);
    expect(client.commitJointEdit).toHaveBeenCalledWith({
      candidate: candidateHandle,
      expectedSource: handleAt(1),
      expectedJointId: 'doc-1/joint/1',
      expectedSpecDigest: 'digest-4',
    });
    await act(async () => {
      commits[0]?.resolve(committed(2));
      await Promise.resolve();
    });
    expect(store.getSnapshot().model?.handle.revision).toBe(2);
    const latest = store.getSnapshot().status[0];
    expect(latest?.severity).toBe(StatusSeverity.Success);
    expect(latest?.message).toBe(
      `${CONNECTOR_EDIT_COPY.applied}. ${CONNECTOR_EDIT_COPY.qualifier}`,
    );
    expect(result.current.undoable).toBe(true);
    expect(result.current.appliedSentence).toBe(
      `${CONNECTOR_EDIT_COPY.applied}. ${CONNECTOR_EDIT_COPY.qualifier}`,
    );
  });

  it('undoes the change it applied, through the existing undo, and then offers no second one', async () => {
    const { store, result, client, proposals, commits, undos } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[0]?.resolve(proposed(joint({}, 3)));
      await Promise.resolve();
    });
    act(() => {
      result.current.apply();
    });
    await act(async () => {
      commits[0]?.resolve(committed(2));
      await Promise.resolve();
    });
    act(() => {
      result.current.undo();
    });
    expect(client.undoRepair).toHaveBeenCalledWith(handleAt(2), 'rec-1', expect.any(Function));
    expect(result.current.undoing).toBe(true);
    await act(async () => {
      undos[0]?.resolve({
        handle: handleAt(3),
        revertedRevision: 2,
        restoredRevision: 1,
        recordId: 'rec-1',
        kind: 'geometry-edit',
        partId: 'a',
        appliedOperations: [],
        render: { positions: new Float32Array(0), normals: new Float32Array(0), vertexCount: 0 },
        documentRender: { parts: [] },
        parts: [part('a'), part('b')],
        residentBytes: 1,
        triangleCount: 24,
        vertexCount: 72,
        bounds: undefined,
      } as unknown as RepairUndoResult);
      await Promise.resolve();
    });
    expect(store.getSnapshot().model?.handle.revision).toBe(3);
    expect(result.current.undoable).toBe(false);
    expect(store.getSnapshot().status[0]?.message).toBe(CONNECTOR_EDIT_COPY.undone);
  });

  it('removes the connectors through the same check and apply', async () => {
    const { store, result, client, proposals } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.checkRemoval();
    });
    expect((client.proposeJointEdit.mock.calls[0] as unknown[])[3]).toEqual({
      kind: 'REMOVE_CONNECTORS',
    });
    await act(async () => {
      proposals[0]?.resolve(proposed(plainCut()));
      await Promise.resolve();
    });
    expect(result.current.phase).toBe(ConnectorEditPhase.Ready);
    expect(result.current.kind).toBe('REMOVE');
  });
});

describe('refusals and the things that supersede a check', () => {
  it("says the joint's own refusals in our words and the engine's in its own, and returns to idle", async () => {
    const { store, result, proposals } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[0]?.reject(invalidState('stale', { code: 'JOINT_SPEC_STALE' }));
      await Promise.resolve();
    });
    expect(result.current.phase).toBe(ConnectorEditPhase.Idle);
    expect(result.current.message).toMatch(/changed since these values were shown/);
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[1]?.reject(
        invalidState('The socket would break through the piece.', {
          code: 'CONNECTOR_SOCKET_BREAKTHROUGH',
        }),
      );
      await Promise.resolve();
    });
    expect(result.current.message).toBe('The socket would break through the piece.');
    // the draft survives a refusal: the user adjusts it, not retypes it
    expect(result.current.draft?.diameterMm).toBe(3);
  });

  it('says nothing for a check the user cancelled, and releases the candidate that arrives late', async () => {
    const { store, result, client, proposals } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    act(() => {
      result.current.cancelCheck();
    });
    expect(result.current.phase).toBe(ConnectorEditPhase.Idle);
    expect(result.current.message).toBeUndefined();
    await act(async () => {
      proposals[0]?.resolve(proposed(joint({}, 3)));
      await Promise.resolve();
    });
    expect(result.current.phase).toBe(ConnectorEditPhase.Idle);
    expect(client.discardJointEdit).toHaveBeenCalledWith(candidateHandle);
  });

  it('releases a candidate when the draft changes under it, and reads it as no candidate', async () => {
    const { store, result, client, proposals } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[0]?.resolve(proposed(joint({}, 3)));
      await Promise.resolve();
    });
    act(() => {
      result.current.setDraft({ depthMm: 5 });
    });
    expect(client.discardJointEdit).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe(ConnectorEditPhase.Idle);
    expect(result.current.after).toBeUndefined();
    expect(result.current.draft).toMatchObject({ diameterMm: 3, depthMm: 5 });
  });

  it('forgets a draft and a candidate when the connectors they were made for change', async () => {
    const { store, result, proposals } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[0]?.resolve(proposed(joint({}, 3)));
      await Promise.resolve();
    });
    // the worker now lists different connectors for this revision
    list(store, [joint({}, 5)]);
    expect(result.current.phase).toBe(ConnectorEditPhase.Idle);
    expect(result.current.after).toBeUndefined();
    expect(result.current.draft?.diameterMm).toBe(5);
  });

  it('releases a pending candidate when the editor goes away', async () => {
    const { store, result, client, proposals, unmount } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[0]?.resolve(proposed(joint({}, 3)));
      await Promise.resolve();
    });
    unmount();
    expect(client.discardJointEdit).toHaveBeenCalledWith(candidateHandle);
  });

  it('refuses to apply into a model that moved on, and says the connectors changed', async () => {
    const { store, result, proposals, commits } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[0]?.resolve(proposed(joint({}, 3)));
      await Promise.resolve();
    });
    act(() => {
      result.current.apply();
    });
    // a result for a revision the store does not hold is not adopted
    await act(async () => {
      commits[0]?.resolve({ ...committed(7), parentRevision: 6 });
      await Promise.resolve();
    });
    expect(store.getSnapshot().model?.handle.revision).toBe(1);
    expect(result.current.undoable).toBe(false);
    expect(result.current.message).toMatch(/changed since/);
  });

  it('turns a failure of the apply into a sentence and leaves the model alone', async () => {
    const { store, result, proposals, commits } = mount();
    list(store, [joint()]);
    act(() => {
      result.current.setDraft({ diameterMm: 3 });
    });
    act(() => {
      result.current.check();
    });
    await act(async () => {
      proposals[0]?.resolve(proposed(joint({}, 3)));
      await Promise.resolve();
    });
    act(() => {
      result.current.apply();
    });
    await act(async () => {
      commits[0]?.reject(
        new AppError(AppErrorCode.ModelUnavailable, 'That model is no longer available.'),
      );
      await Promise.resolve();
    });
    await flush();
    expect(store.getSnapshot().model?.handle.revision).toBe(1);
    expect(result.current.phase).toBe(ConnectorEditPhase.Idle);
    expect(result.current.message).toBe('That model is no longer available.');
  });
});
