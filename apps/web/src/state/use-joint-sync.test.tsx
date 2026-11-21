import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AppErrorCode, AppError } from '@cadfixer/shared';
import type { DocumentId, JointDescriptor, PartDescriptor } from '@cadfixer/geometry-runtime';
import { GeometryClientProvider } from '../runtime/client-context';
import type { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from './store-context';
import { StatusSeverity, WorkspaceStore } from './workspace-store';
import { useJointSync } from './use-joint-sync';
import { connectorPairsOf, currentJoints } from './joint-presentation';
import type { LoadedModel } from './model';

/*
 * Stage EC-4. The page asks the worker for the connector joints once for every revision it comes to hold, keeps the answer only for that
 * revision, and says so, in words, when it cannot read the list. These tests drive the hook with a stand-in client whose answers they
 * control, which is the only seam the page has to the worker.
 */
function model(revision: number, documentId = 'doc-1'): Omit<LoadedModel, 'revision'> {
  const parts: readonly PartDescriptor[] = [];
  return {
    handle: { documentId: documentId as DocumentId, revision },
    parts,
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
    triangleCount: 0,
    vertexCount: 0,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 1,
  };
}
function joint(id: string): JointDescriptor {
  return {
    jointId: id,
    aPartId: 'a',
    bPartId: 'b',
    status: 'ATTACHED',
    pinCount: 1,
    retainedBytes: 0,
    specDigest: 'd',
    connector: {
      maleSide: 'A',
      axis: [-1, 0, 0],
      mmPerSceneUnit: 1,
      pins: [
        {
          pinId: 'pin-1',
          u: 0,
          v: 0,
          center: [0, 0, 0],
          diameterMm: 4,
          depthMm: 6,
          clearanceMm: 0.2,
        },
      ],
    },
  };
}
interface Pending {
  readonly asked: { documentId: string; revision: number };
  readonly resolve: (joints: readonly JointDescriptor[]) => void;
  readonly reject: (error: unknown) => void;
}
function mount(): {
  store: WorkspaceStore;
  pending: Pending[];
  listJoints: ReturnType<typeof vi.fn>;
} {
  const store = new WorkspaceStore();
  const pending: Pending[] = [];
  const listJoints = vi.fn((asked: { documentId: string; revision: number }) => ({
    promise: new Promise<{ joints: readonly JointDescriptor[] }>((resolve, reject) => {
      pending.push({
        asked,
        resolve: (joints) => {
          resolve({ joints });
        },
        reject,
      });
    }),
  }));
  const client = { listJoints } as unknown as GeometryClient;
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>{children}</GeometryClientProvider>
    </WorkspaceProvider>
  );
  renderHook(
    () => {
      useJointSync();
    },
    { wrapper },
  );
  return { store, pending, listJoints };
}
const importModel = (store: WorkspaceStore, revision: number, documentId = 'doc-1'): void => {
  act(() => {
    store.commitImport(store.beginImport('cube.stl'), model(revision, documentId));
  });
};

describe('the page asks for the joints of each revision it holds', () => {
  it('asks nothing while there is no model', () => {
    const { listJoints } = mount();
    expect(listJoints).not.toHaveBeenCalled();
  });

  it('asks once for the revision it holds and keeps the answer for that revision only', async () => {
    const { store, pending, listJoints } = mount();
    importModel(store, 1);
    expect(listJoints).toHaveBeenCalledTimes(1);
    expect(listJoints).toHaveBeenCalledWith({ documentId: 'doc-1', revision: 1 });
    await act(async () => {
      pending[0]?.resolve([joint('doc-1/joint/1')]);
      await Promise.resolve();
    });
    const state = store.getSnapshot();
    expect(currentJoints(state.joints, state.model?.handle)).toHaveLength(1);
    expect(connectorPairsOf(currentJoints(state.joints, state.model?.handle))).toHaveLength(1);
  });

  it('reads the list as nothing the moment the model moves to another revision, and asks again', async () => {
    const { store, pending, listJoints } = mount();
    importModel(store, 1);
    await act(async () => {
      pending[0]?.resolve([joint('doc-1/joint/1')]);
      await Promise.resolve();
    });
    importModel(store, 2);
    const state = store.getSnapshot();
    expect(currentJoints(state.joints, state.model?.handle)).toEqual([]);
    expect(listJoints).toHaveBeenCalledTimes(2);
  });

  it('drops an answer that arrives after the model moved on', async () => {
    const { store, pending } = mount();
    importModel(store, 1);
    importModel(store, 2);
    await act(async () => {
      pending[0]?.resolve([joint('stale')]);
      await Promise.resolve();
    });
    const state = store.getSnapshot();
    expect(state.joints).toBeUndefined();
    await act(async () => {
      pending[1]?.resolve([joint('current')]);
      await Promise.resolve();
    });
    expect(
      currentJoints(store.getSnapshot().joints, store.getSnapshot().model?.handle)[0]?.jointId,
    ).toBe('current');
  });

  it('says it could not read the list, and does not read that as "no connectors"', async () => {
    const { store, pending } = mount();
    importModel(store, 1);
    await act(async () => {
      pending[0]?.reject(new AppError(AppErrorCode.Internal, 'worker went away'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(store.getSnapshot().joints?.status).toBe('UNAVAILABLE');
    });
    const latest = store.getSnapshot().status[0];
    expect(latest?.severity).toBe(StatusSeverity.Warning);
    expect(latest?.message).toMatch(/connectors of this model could not be listed/i);
  });

  it('stays quiet when the read was cancelled', async () => {
    const { store, pending } = mount();
    importModel(store, 1);
    const before = store.getSnapshot().status.length;
    await act(async () => {
      pending[0]?.reject(new AppError(AppErrorCode.OperationCancelled, 'cancelled'));
      await Promise.resolve();
    });
    expect(store.getSnapshot().joints).toBeUndefined();
    expect(store.getSnapshot().status.length).toBe(before);
  });
});

describe('the store refuses a list for a model it does not hold', () => {
  it('records nothing for another revision, another document, or no model', () => {
    const store = new WorkspaceStore();
    expect(store.setJoints({ status: 'READY', documentId: 'doc-1', revision: 1, joints: [] })).toBe(
      false,
    );
    importModel(store, 1);
    expect(store.setJoints({ status: 'READY', documentId: 'doc-1', revision: 2, joints: [] })).toBe(
      false,
    );
    expect(store.setJoints({ status: 'READY', documentId: 'other', revision: 1, joints: [] })).toBe(
      false,
    );
    expect(store.getSnapshot().joints).toBeUndefined();
    expect(store.setJoints({ status: 'READY', documentId: 'doc-1', revision: 1, joints: [] })).toBe(
      true,
    );
  });

  it('forgets the list of the previous document when another is imported', () => {
    const store = new WorkspaceStore();
    importModel(store, 1);
    store.setJoints({ status: 'READY', documentId: 'doc-1', revision: 1, joints: [joint('x')] });
    importModel(store, 1, 'doc-2');
    expect(store.getSnapshot().joints).toBeUndefined();
  });

  it('selects a connector only if the worker lists it for this revision', () => {
    const store = new WorkspaceStore();
    importModel(store, 1);
    store.setJoints({
      status: 'READY',
      documentId: 'doc-1',
      revision: 1,
      joints: [joint('doc-1/joint/1')],
    });
    store.selectConnectorPair('doc-1/joint/1/pin-1');
    expect(store.getSnapshot().assembly).toBeUndefined(); // no layout yet: nothing to select it in
  });
});
