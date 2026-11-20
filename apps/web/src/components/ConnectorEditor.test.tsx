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
import { ConnectorEditor, ConnectorEditorSlot } from './ConnectorEditor';
import { GeometryClientProvider } from '../runtime/client-context';
import type { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import { WorkspaceStore } from '../state/workspace-store';
import { ConnectorEditControlsProvider } from '../state/workflow-controllers';
import { CONNECTOR_EDIT_COPY } from '../state/connector-edit-presentation';
import type { LoadedModel } from '../state/model';
import { WorkflowId } from '../state/workflows';

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
const OUTLINE = {
  bounds: { minU: -10, maxU: 10, minV: -10, maxV: 10 },
  loops: [{ role: 'OUTER' as const, points: [-10, -10, 10, -10, 10, 10, -10, 10] }],
};
const CUT_FACE = { mmPerCoordinate: 1, maxPins: 4, outline: OUTLINE };
const joint = (diameterMm = 4, maleSide: 'A' | 'B' = 'A'): JointDescriptor => ({
  jointId: 'doc-1/joint/1',
  aPartId: 'a',
  bPartId: 'b',
  status: 'ATTACHED',
  pinCount: 1,
  retainedBytes: 0,
  specDigest: `digest-${String(diameterMm)}-${maleSide}`,
  cutFace: CUT_FACE,
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
  cutFace: CUT_FACE,
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
        <ConnectorEditControlsProvider>
          <ConnectorEditor labels={{ a: 'Top', b: 'Bottom' }} />
        </ConnectorEditControlsProvider>
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

  it('draws the cut with the connector on it and lists where it sits, in millimetres', () => {
    mount();
    expect(screen.getByText(CONNECTOR_EDIT_COPY.intro)).toBeInTheDocument();
    expect(screen.getByTestId('cut-face-pin-0')).toHaveAttribute('data-u', '1');
    expect(screen.getByTestId('connector-position-u-0')).toHaveValue(1);
    expect(screen.getByTestId('connector-position-v-0')).toHaveValue(2);
  });

  it('says so, and still offers the sizes and the removal, for a cut it cannot draw', () => {
    mount({
      joints: [{ ...joint(), cutFace: { mmPerCoordinate: 1, maxPins: 4, outline: undefined } }],
    });
    expect(screen.getByTestId('connector-edit-no-face')).toHaveTextContent(
      CONNECTOR_EDIT_COPY.noFace,
    );
    expect(screen.queryByTestId('cut-face')).toBeNull();
    expect(screen.queryByTestId('connector-edit-add')).toBeNull();
    expect(screen.getByTestId('connector-edit-diameter')).toBeEnabled();
    expect(screen.getByTestId('connector-edit-remove')).toBeEnabled();
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

describe('moving, adding and taking out a connector', () => {
  it('typing a position moves the connector in the draft and makes the change checkable', () => {
    mount();
    fireEvent.change(screen.getByTestId('connector-position-u-0'), { target: { value: '3.5' } });
    expect(screen.getByTestId('cut-face-pin-0')).toHaveAttribute('data-u', '3.5');
    expect(screen.getByTestId('cut-face-pin-0')).toHaveAttribute('data-v', '2');
    expect(screen.getByTestId('connector-edit-check')).toBeEnabled();
  });

  it('moves a connector with the arrow keys by half a millimetre, and takes it out with Delete', () => {
    mount();
    const pin = screen.getByTestId('cut-face-pin-0');
    fireEvent.keyDown(pin, { key: 'ArrowRight' });
    expect(screen.getByTestId('cut-face-pin-0')).toHaveAttribute('data-u', '1.5');
    fireEvent.keyDown(screen.getByTestId('cut-face-pin-0'), { key: 'ArrowUp', shiftKey: true });
    expect(screen.getByTestId('cut-face-pin-0')).toHaveAttribute('data-v', '4.5');
    fireEvent.keyDown(screen.getByTestId('cut-face-pin-0'), { key: 'Delete' });
    expect(screen.queryByTestId('cut-face-pin-0')).toBeNull();
    // taking out the last one is taking the connectors off, and the check says so
    expect(screen.getByTestId('connector-edit-check')).toBeEnabled();
  });

  it('follows a drag across the picture, by where the pointer is over the cut', () => {
    mount();
    const svg = screen.getByTestId('cut-face');
    // 24.8 wide by 24.8 tall in the view (20 plus a margin of 2.4 each side), drawn at 10 px a unit
    svg.getBoundingClientRect = (): DOMRect =>
      ({
        left: 0,
        top: 0,
        width: 248,
        height: 248,
        right: 248,
        bottom: 248,
        x: 0,
        y: 0,
      }) as DOMRect;
    const pin = screen.getByTestId('cut-face-pin-0');
    // the connector sits at (1, 2): x = (1 + 12.4) * 10 = 134, y = (-2 + 12.4) * 10 = 104
    fireEvent.pointerDown(pin, { clientX: 134, clientY: 104, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 164, clientY: 74, pointerId: 1 });
    expect(Number(screen.getByTestId('cut-face-pin-0').getAttribute('data-u'))).toBeCloseTo(4, 6);
    expect(Number(screen.getByTestId('cut-face-pin-0').getAttribute('data-v'))).toBeCloseTo(5, 6);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(screen.getByTestId('cut-face')).toHaveAttribute('data-dragging', 'false');
    expect(screen.getByTestId('connector-position-u-0')).toHaveValue(4);
  });

  it('adds a connector at the middle of the cut, up to the cut limit, and says when it is full', () => {
    mount({ joints: [plainCut] });
    expect(screen.getByTestId('connector-edit-none-yet')).toBeInTheDocument();
    expect(screen.queryByTestId('connector-edit-remove')).toBeNull();
    expect(screen.getByTestId('connector-edit-check')).toBeDisabled();
    fireEvent.click(screen.getByTestId('connector-edit-add'));
    expect(screen.getByTestId('cut-face-pin-0')).toHaveAttribute('data-u', '0');
    expect(screen.getByTestId('cut-face-pin-0')).toHaveAttribute('data-v', '0');
    expect(screen.getByTestId('connector-edit-check')).toBeEnabled();
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByTestId('connector-edit-add'));
    expect(screen.getByTestId('connector-edit-add')).toBeDisabled();
    expect(screen.getByTestId('connector-edit-add-note')).toHaveTextContent(
      'A cut holds at most 4 connectors.',
    );
  });

  it('sends a moved connector with its name and its new place, and an added one with no name', async () => {
    const { propose } = mount();
    propose.mockReturnValue(later(proposal(joint(4))));
    fireEvent.change(screen.getByTestId('connector-position-v-0'), { target: { value: '-3' } });
    fireEvent.click(screen.getByTestId('connector-edit-add'));
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    expect(propose.mock.calls[0]?.[3]).toEqual({
      kind: 'SET_CONNECTORS',
      maleSide: 'A',
      diameterMm: 4,
      depthMm: 6,
      clearanceMm: 0.2,
      pins: [
        { pinId: 'pin-1', u: 1, v: -3 },
        { u: 0, v: 0 },
      ],
    });
  });

  it('checks taking every connector out as a removal', async () => {
    const { propose } = mount();
    propose.mockReturnValue(later(proposal(plainCut)));
    fireEvent.click(screen.getByTestId('connector-position-remove-0'));
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    expect(propose.mock.calls[0]?.[3]).toEqual({ kind: 'REMOVE_CONNECTORS' });
  });
});

describe('what the editor says', () => {
  it('makes no claim about use and calls no place good before the check has', async () => {
    const { propose } = mount();
    propose.mockReturnValue(later(proposal(joint(3))));
    fireEvent.change(screen.getByTestId('connector-edit-diameter'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('connector-edit-check'));
    await settle();
    const text = screen.getByTestId('connector-editor').textContent;
    expect(text).not.toMatch(/printable|watertight|\bfits?\b|\bstrong\b|secure|will hold/i);
    expect(text).not.toMatch(/\b(?:safe|safely|best|optimal|recommended|automatically|ideal)\b/i);
  });
});

describe('the editor in every workspace (Stage EC-7)', () => {
  /** All four workspaces' slots, mounted at once, as the tool panel mounts them: they stay mounted while hidden. */
  function mountSlots(): { store: WorkspaceStore } {
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
    store.setJoints({ status: 'READY', documentId: 'doc-1', revision: 1, joints: [joint()] });
    const client = {
      proposeJointEdit: vi.fn(),
      commitJointEdit: vi.fn(),
      discardJointEdit: vi.fn(() => ({ promise: Promise.resolve({ released: true }) })),
      undoRepair: vi.fn(),
    } as unknown as GeometryClient;
    render(
      <WorkspaceProvider store={store}>
        <GeometryClientProvider client={client}>
          <ConnectorEditControlsProvider>
            <ConnectorEditorSlot workflow={WorkflowId.Repair} />
            <ConnectorEditorSlot workflow={WorkflowId.Convert} />
            <ConnectorEditorSlot workflow={WorkflowId.Split} />
            <ConnectorEditorSlot workflow={WorkflowId.Texture} />
          </ConnectorEditControlsProvider>
        </GeometryClientProvider>
      </WorkspaceProvider>,
    );
    return { store };
  }
  const sections = (): HTMLElement[] =>
    screen.queryAllByRole('region', { name: CONNECTOR_EDIT_COPY.section });

  it('draws one editor, in the workspace that is shown, whichever workspace that is', () => {
    const { store } = mountSlots();
    for (const workflow of [
      WorkflowId.Repair,
      WorkflowId.Convert,
      WorkflowId.Split,
      WorkflowId.Texture,
    ]) {
      act(() => {
        store.selectWorkflow(workflow);
      });
      expect(sections(), workflow).toHaveLength(1);
    }
  });

  it('opens in the Split workspace and is a collapsed section in the others', () => {
    const { store } = mountSlots();
    const expanded = (): string | null =>
      screen
        .getByRole('button', { name: new RegExp(CONNECTOR_EDIT_COPY.section) })
        .getAttribute('aria-expanded');
    act(() => {
      store.selectWorkflow(WorkflowId.Split);
    });
    expect(expanded()).toBe('true');
    act(() => {
      store.selectWorkflow(WorkflowId.Convert);
    });
    expect(expanded()).toBe('false');
  });

  it('keeps one draft: a connector moved in one workspace is where it was left in the next', () => {
    const { store } = mountSlots();
    act(() => {
      store.selectWorkflow(WorkflowId.Split);
    });
    fireEvent.change(screen.getByTestId('connector-position-u-0'), { target: { value: '5' } });
    act(() => {
      store.selectWorkflow(WorkflowId.Texture);
    });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(CONNECTOR_EDIT_COPY.section) }));
    expect(screen.getByTestId('connector-position-u-0')).toHaveValue(5);
    expect(screen.getByTestId('connector-edit-check')).toBeEnabled();
  });

  it('draws nothing in any workspace for a model with no attached cut', () => {
    const { store } = mountSlots();
    act(() => {
      store.setJoints({ status: 'READY', documentId: 'doc-1', revision: 1, joints: [] });
      store.selectWorkflow(WorkflowId.Repair);
    });
    expect(sections()).toHaveLength(0);
  });
});
