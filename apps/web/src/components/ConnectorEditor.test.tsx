import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import { invalidState } from '@cadfixer/shared';
import type {
  DocumentHandle,
  DocumentId,
  JointCommitResult,
  JointDescriptor,
  JointProposeResult,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { ConnectorEditor } from './ConnectorEditor';
import { GeometryClientProvider } from '../runtime/client-context';
import type { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import { WorkspaceStore } from '../state/workspace-store';
import { CONNECTOR_EDIT_COPY } from '../state/connector-edit-presentation';
import type { LoadedModel } from '../state/model';

/*
 * Stage EC-5. The editor as a person meets it: four values, a check, a preview that says nothing has changed, an apply and an undo. The
 * worker is a stand-in whose answers the test controls; what is drawn is what the store and the hook make of them.
 */
afterEach(cleanup);

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
const at = (revision: number): DocumentHandle => ({
  documentId: 'doc-1' as DocumentId,
  revision,
});
const joint = (diameterMm = 4, maleSide: 'A' | 'B' = 'A'): JointDescriptor => ({
  jointId: 'doc-1/joint/1',
  aPartId: 'a',
  bPartId: 'b',
  status: 'ATTACHED',
  pinCount: 1,
  retainedBytes: 0,
  specDigest: `digest-${String(diameterMm)}-${maleSide}`,
  connector: {
    maleSide,
    axis: [-1, 0, 0],
    mmPerSceneUnit: 1,
    pins: [
      { pinId: 'pin-1', u: 1, v: 2, center: [0, 1, 2], diameterMm, depthMm: 6, clearanceMm: 0.2 },
    ],
  },
});
const plainCut: JointDescriptor = {
  jointId: 'doc-1/joint/1',
  aPartId: 'a',
  bPartId: 'b',
  status: 'ATTACHED',
  pinCount: 0,
  retainedBytes: 0,
  specDigest: 'digest-plain',
};
const candidate = {
  candidateId: 'c-1',
  jointId: 'doc-1/joint/1',
} as unknown as JointProposeResult['candidate'];

function mount(options: { readonly joints?: readonly JointDescriptor[] } = {}): {
  store: WorkspaceStore;
  propose: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
} {
  const store = new WorkspaceStore();
  const model: Omit<LoadedModel, 'revision'> = {
    handle: at(1),
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
  store.setJoints({
    status: 'READY',
    documentId: 'doc-1',
    revision: 1,
    joints: options.joints ?? [joint()],
  });
  const propose = vi.fn();
  const commit = vi.fn();
  const client = {
    proposeJointEdit: propose,
    commitJointEdit: commit,
    discardJointEdit: vi.fn(() => ({ promise: Promise.resolve({ released: true }) })),
    undoRepair: vi.fn(),
  } as unknown as GeometryClient;
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <ConnectorEditor labels={{ a: 'Top', b: 'Bottom' }} />
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return { store, propose, commit };
}
const later = <T,>(value: T): { promise: Promise<T>; cancel: () => void } => ({
  promise: Promise.resolve(value),
  cancel: () => undefined,
});
const proposal = (after: JointDescriptor): JointProposeResult =>
  ({
    candidate,
    jointId: 'doc-1/joint/1',
    specDigestBefore: 'x',
    specDigestAfter: 'y',
    after,
    render: { parts: [] },
    parts: [part('a'), part('b')],
    triangleCountBefore: 24,
    triangleCountAfter: 24,
  }) as unknown as JointProposeResult;
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('the editor shows the connectors as they are', () => {
  it('names the piece that carries the pin, and prefills the three sizes', () => {
    mount();
    expect(screen.getByTestId('connector-edit-diameter')).toHaveValue(4);
    expect(screen.getByTestId('connector-edit-depth')).toHaveValue(6);
    expect(screen.getByTestId('connector-edit-clearance')).toHaveValue(0.2);
    expect(screen.getByText('Top')).toBeInTheDocument();
    expect(screen.getByText('Bottom')).toBeInTheDocument();
    expect(screen.getByTestId('connector-edit-check')).toBeDisabled();
    expect(screen.getByTestId('connector-edit-remove')).toBeEnabled();
  });

  it('says in its first sentence that where a connector sits does not change here', () => {
    mount();
    expect(screen.getByText(CONNECTOR_EDIT_COPY.intro)).toBeInTheDocument();
    expect(CONNECTOR_EDIT_COPY.intro).toMatch(/Where they sit does not change/);
  });

  it('draws nothing for a cut whose connectors cannot be changed', () => {
    mount({ joints: [{ ...joint(), status: 'RETIRED', reason: 'GEOMETRY_CHANGED' }] });
    expect(screen.queryByTestId('connector-editor')).toBeNull();
  });
});

describe('changing a value', () => {
  it('enables the check for a change and says why for a size out of range', () => {
    mount();
    fireEvent.change(screen.getByTestId('connector-edit-diameter'), { target: { value: '3' } });
    expect(screen.getByTestId('connector-edit-check')).toBeEnabled();
    fireEvent.change(screen.getByTestId('connector-edit-diameter'), { target: { value: '0' } });
    expect(screen.getByTestId('connector-edit-problem')).toHaveTextContent(
      'Pin diameter must be between 0.01 and 1000 mm.',
    );
    expect(screen.getByTestId('connector-edit-check')).toBeDisabled();
  });

  it('swapping the male side is a change too', () => {
    mount();
    fireEvent.click(screen.getByTestId('connector-edit-male-b'));
    expect(screen.getByTestId('connector-edit-check')).toBeEnabled();
  });
});

describe('checking and applying', () => {
  it('shows what would change, labelled as not applied, and does nothing to the model until Apply', async () => {
    const { store, propose } = mount();
    propose.mockReturnValue(later(proposal(joint(3))));
    fireEvent.change(screen.getByTestId('connector-edit-diameter'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    expect(screen.getByTestId('connector-edit-preview-label')).toHaveTextContent(
      'Preview — not applied',
    );
    expect(screen.getByTestId('connector-edit-preview-text')).toHaveTextContent(
      'Pin diameter 4 to 3 mm. The change passed Pybrix’s checks. Nothing has changed yet.',
    );
    expect(store.getSnapshot().model?.handle.revision).toBe(1);
    expect(screen.getByTestId('connector-edit-apply')).toBeEnabled();
    expect(screen.queryByTestId('connector-edit-check')).toBeNull();
  });

  it("names a swapped male side by the piece's own label", async () => {
    const { propose } = mount();
    propose.mockReturnValue(later(proposal(joint(4, 'B'))));
    fireEvent.click(screen.getByTestId('connector-edit-male-b'));
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    expect(screen.getByTestId('connector-edit-preview-text')).toHaveTextContent(
      'The pin moves to Bottom.',
    );
  });

  it('applies, adopts the new revision, and offers one Undo', async () => {
    const { store, propose, commit } = mount();
    propose.mockReturnValue(later(proposal(joint(3))));
    commit.mockReturnValue(
      later({
        handle: at(2),
        parentRevision: 1,
        recordId: 'rec-1',
        render: { parts: [] },
        parts: [part('a'), part('b')],
        joints: [],
        residentBytes: 2,
        triangleCount: 24,
        vertexCount: 72,
        bounds: undefined,
      } as unknown as JointCommitResult),
    );
    fireEvent.change(screen.getByTestId('connector-edit-diameter'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    fireEvent.click(screen.getByTestId('connector-edit-apply'));
    await settle();
    expect(store.getSnapshot().model?.handle.revision).toBe(2);
    expect(store.getSnapshot().status[0]?.message).toBe(
      `${CONNECTOR_EDIT_COPY.applied}. ${CONNECTOR_EDIT_COPY.qualifier}`,
    );
    expect(screen.getByTestId('connector-edit-undo')).toBeEnabled();
    expect(screen.getByTestId('connector-edit-applied')).toHaveTextContent(
      `${CONNECTOR_EDIT_COPY.applied}. ${CONNECTOR_EDIT_COPY.qualifier}`,
    );
  });

  it('discarding a preview leaves the draft and returns to the check', async () => {
    const { propose } = mount();
    propose.mockReturnValue(later(proposal(joint(3))));
    fireEvent.change(screen.getByTestId('connector-edit-diameter'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    fireEvent.click(screen.getByTestId('connector-edit-discard'));
    expect(screen.getByTestId('connector-edit-check')).toBeEnabled();
    expect(screen.getByTestId('connector-edit-diameter')).toHaveValue(3);
  });

  it('says why a check was refused, in words, and keeps what was typed', async () => {
    const { propose } = mount();
    propose.mockReturnValue({
      promise: Promise.reject(
        invalidState('The material around the socket is too thin.', {
          code: 'CONNECTOR_SOCKET_SUPPORT_INSUFFICIENT',
        }),
      ),
      cancel: () => undefined,
    });
    fireEvent.change(screen.getByTestId('connector-edit-diameter'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    expect(screen.getByTestId('connector-edit-refusal')).toHaveTextContent(
      'The material around the socket is too thin.',
    );
    expect(screen.getByTestId('connector-edit-diameter')).toHaveValue(9);
  });

  it('previews taking the connectors off as a separate act that leaves the plain cut', async () => {
    const { propose } = mount();
    propose.mockReturnValue(later(proposal(plainCut)));
    fireEvent.click(screen.getByTestId('connector-edit-remove'));
    await settle();
    expect(screen.getByTestId('connector-edit-preview-text')).toHaveTextContent(
      CONNECTOR_EDIT_COPY.removeReady,
    );
    expect(propose.mock.calls[0]?.[3]).toEqual({ kind: 'REMOVE_CONNECTORS' });
  });
});

describe('what the editor says', () => {
  it('makes no claim about use and promises neither a move nor an addition', async () => {
    const { propose } = mount();
    propose.mockReturnValue(later(proposal(joint(3))));
    fireEvent.change(screen.getByTestId('connector-edit-diameter'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    const text = screen.getByTestId('connector-editor').textContent;
    expect(text).not.toMatch(/printable|watertight|\bfits?\b|\bstrong\b|secure|will hold/i);
    expect(text).not.toMatch(/\b(?:move|moves|drag|add|adds)\b(?! to)/i);
  });
});
