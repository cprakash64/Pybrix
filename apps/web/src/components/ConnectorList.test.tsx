import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentId,
  JointDescriptor,
  PartDescriptor,
  SplitCommitResult,
} from '@cadfixer/geometry-runtime';
import { ConnectorList } from './ConnectorList';
import type { ReactNode } from 'react';
import { WorkspaceProvider, useWorkspaceState } from '../state/store-context';
import { WorkspaceStore } from '../state/workspace-store';
import type { LoadedModel } from '../state/model';
import { JOINT_LIST_UNAVAILABLE } from '../state/connector-edit-presentation';

/*
 * Stage EC-4. The connectors an applied split shows are the worker's list for this revision. These tests put the list in the store the
 * way the sync hook does and read what the component draws; the page keeps no other record of a connector to draw from.
 */
afterEach(cleanup);

const HANDLE = { documentId: 'doc-1' as DocumentId, revision: 2 };
const part = (partId: string): PartDescriptor => ({
  partId,
  transform: IDENTITY_PART_TRANSFORM,
  triangleCount: 4,
  vertexCount: 12,
  bounds: undefined,
  meshResourceIndex: 0,
  groupCount: 0,
  groupMaterialRefCount: 0,
  hasNormals: false,
  hasUvs: false,
});
function loaded(store: WorkspaceStore): LoadedModel {
  const model: Omit<LoadedModel, 'revision'> = {
    handle: { documentId: HANDLE.documentId, revision: 1 },
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
    triangleCount: 8,
    vertexCount: 24,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 1,
  };
  store.commitImport(store.beginImport('cube.stl'), model);
  const current = store.getSnapshot().model;
  if (current === undefined) throw new Error('no model');
  return current;
}
const attached: JointDescriptor = {
  jointId: 'doc-1/joint/1',
  aPartId: 'a',
  bPartId: 'b',
  status: 'ATTACHED',
  pinCount: 2,
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
        v: -5,
        center: [0, -5, 0],
        diameterMm: 4,
        depthMm: 6,
        clearanceMm: 0.2,
      },
      {
        pinId: 'pin-2',
        u: 0,
        v: 5,
        center: [0, 5, 0],
        diameterMm: 4,
        depthMm: 6,
        clearanceMm: 0.2,
      },
    ],
  },
};

/** A real applied split: the store adopts it the way the application does, so the layout it draws from is the production one. */
function applied(store: WorkspaceStore): void {
  const result = {
    recordId: '2',
    metrics: { tolerance: 0.00001 },
    parentRevision: 1,
    handle: HANDLE,
    pieceAId: 'a',
    pieceBId: 'b',
    parts: [part('a'), part('b')],
    bounds: undefined,
    triangleCount: 8,
    vertexCount: 24,
    residentBytes: 1,
    render: { parts: [] },
    resources: { triangles: 8 },
    connector: { kind: 'pin', count: 2, diameter: 4, depth: 6, clearance: 0.2, maleSide: 'A' },
    interface: {
      plane: { origin: [0, 0, 0], normal: [1, 0, 0] },
      center: [0, 0, 0],
      bounds: { min: [0, -15, -15], max: [0, 15, 15] },
      connectorEligible: true,
      placements: [],
    },
  } as unknown as SplitCommitResult;
  store.applySplitResult(result, {
    sourcePartId: 'source',
    sourceTransform: IDENTITY_PART_TRANSFORM,
    plane: { origin: [0, 0, 0], normal: [1, 0, 0] },
    label: 'Top',
  });
}

function mount(slice: Parameters<WorkspaceStore['setJoints']>[0] | undefined): WorkspaceStore {
  const store = new WorkspaceStore();
  loaded(store);
  applied(store);
  if (slice !== undefined) store.setJoints(slice);
  const state = store.getSnapshot();
  if (state.assembly === undefined) throw new Error('no assembly');
  render(
    <WorkspaceProvider store={store}>
      <Harness store={store} />
    </WorkspaceProvider>,
  );
  return store;
}
/** Re-reads the store on every change, as the application does, so a press shows in what is drawn. */
function Harness({ store }: { readonly store: WorkspaceStore }): ReactNode {
  const state = useWorkspaceState();
  if (state.assembly === undefined) return null;
  void store;
  return <ConnectorList assembly={state.assembly} model={state.model} />;
}
const ready = (joints: readonly JointDescriptor[]): Parameters<WorkspaceStore['setJoints']>[0] => ({
  status: 'READY',
  documentId: 'doc-1',
  revision: 2,
  joints,
});

describe("the connectors of an applied split are the worker's list", () => {
  it('draws one button per connector, named by the pieces it joins', () => {
    mount(ready([attached]));
    expect(screen.getByText('Paired')).toBeInTheDocument();
    expect(screen.getByText('Connection 1: Top and Remaining assembly')).toBeInTheDocument();
    expect(screen.getByText('Connection 2: Top and Remaining assembly')).toBeInTheDocument();
  });

  it('selects a connector on press and clears it on a second press', () => {
    const store = mount(ready([attached]));
    const first = screen.getByText('Connection 1: Top and Remaining assembly');
    fireEvent.click(first);
    expect(store.getSnapshot().assembly?.selectedPairId).toBe('doc-1/joint/1/pin-1');
    expect(screen.getByText('Connection 1: Top and Remaining assembly')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByText('Connection 1: Top and Remaining assembly'));
    expect(store.getSnapshot().assembly?.selectedPairId).toBeUndefined();
  });

  it('will not select a connector the worker does not list', () => {
    const store = mount(ready([attached]));
    store.selectConnectorPair('doc-1/joint/1/pin-9');
    expect(store.getSnapshot().assembly?.selectedPairId).toBeUndefined();
  });

  it('draws no connector for a list that was never read, one for another revision, or one that could not be read', () => {
    for (const slice of [
      undefined,
      { ...ready([attached]), revision: 1 },
      { status: 'UNAVAILABLE' as const, documentId: 'doc-1', revision: 2 },
    ]) {
      cleanup();
      mount(slice);
      expect(screen.queryByText(/Connection \d/)).toBeNull();
      expect(screen.getByText('Not added')).toBeInTheDocument();
    }
  });

  it('says in words that a list could not be read, and does not say "no connectors"', () => {
    mount({ status: 'UNAVAILABLE', documentId: 'doc-1', revision: 2 });
    expect(screen.getByTestId('joint-list-unavailable')).toHaveTextContent(JOINT_LIST_UNAVAILABLE);
  });

  it('says that a record has ended, and why, and still draws no connector for it', () => {
    const ended: JointDescriptor = {
      jointId: 'doc-1/joint/2',
      aPartId: 'a',
      bPartId: 'b',
      status: 'RETIRED',
      reason: 'GEOMETRY_CHANGED',
      retiredAtRevision: 2,
      pinCount: 1,
      retainedBytes: 0,
    };
    mount(ready([ended]));
    expect(screen.getByTestId('joint-retired')).toHaveTextContent(
      'The record of these connectors has ended. A piece changed after the connectors were made.',
    );
    expect(screen.queryByText(/Connection \d/)).toBeNull();
  });

  it('draws nothing about records when the list is still being read', () => {
    mount(undefined);
    expect(screen.queryByTestId('joint-retired')).toBeNull();
    expect(screen.queryByTestId('joint-list-unavailable')).toBeNull();
  });
});
