import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { invalidState } from '@cadfixer/shared';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentRenderSnapshot,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { SplitWorkspace } from './SplitWorkspace';
import { SplitHud } from './SplitHud';
import { ShellLayoutProvider } from './shell/shell-layout';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import {
  ConnectorEditControlsProvider,
  SplitControlsProvider,
} from '../state/workflow-controllers';
import { WorkspaceStore } from '../state/workspace-store';
import { WorkflowId } from '../state/workflows';
import type { LoadedModel } from '../state/model';

/**
 * UI-04: the Split & Connect workspace at component level.
 *
 * The Boolean split itself is proven in the Node suite and in Chromium; the
 * worker is stubbed here and never replies. What this proves is the workspace:
 * one plane state behind every control, only real connectors, clearance stated
 * precisely, and nothing carried to a part it was not set for.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function part(partId: string, zMax = 104): PartDescriptor {
  return {
    partId,
    name: `Part ${partId}`,
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount: 12,
    vertexCount: 8,
    bounds: {
      min: [0, 0, 0],
      max: [40, 20, zMax],
      size: [40, 20, zMax],
      center: [20, 10, zMax / 2],
      radius: 50,
    },
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

function load(store: WorkspaceStore, unit: string | undefined, parts = [part('p1')]): void {
  const handle = { documentId: 'doc-1', revision: 1 } as DocumentHandle;
  const renderSnapshot: DocumentRenderSnapshot = {
    parts: parts.map((p) => ({
      partId: p.partId,
      transform: p.transform,
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      vertexCount: 3,
    })),
  };
  const model: Omit<LoadedModel, 'revision'> = {
    handle,
    parts,
    render: renderSnapshot,
    source: {
      fileName: 'bracket.3mf',
      fileBytes: 100,
      formatId: '3mf',
      encoding: '3mf',
      unit,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: 12,
    vertexCount: 8,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 1,
  };
  const token = store.beginImport(model.source.fileName);
  store.commitImport(token, model);
  store.selectWorkflow(WorkflowId.Split);
}

function mount(configure: (store: WorkspaceStore) => void): WorkspaceStore {
  const store = new WorkspaceStore();
  configure(store);
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <ShellLayoutProvider>
          <SplitControlsProvider>
            <ConnectorEditControlsProvider>
              <SplitWorkspace />
              <SplitHud />
            </ConnectorEditControlsProvider>
          </SplitControlsProvider>
        </ShellLayoutProvider>
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return store;
}

describe('the cut plane', () => {
  it('offers only the real planes, with no cut list and no custom plane modes', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    const group = screen.getByRole('group', { name: 'Cut plane orientation' });
    expect(group).toHaveTextContent('XY');
    expect(group).toHaveTextContent('XZ');
    expect(group).toHaveTextContent('YZ');
    const workspace = screen.getByTestId('split-workspace');
    expect(workspace).not.toHaveTextContent(/Add cut|Align to face|3 points|Custom/i);
  });

  it('derives the range from the part and starts at its centre', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    const slider = screen.getByTestId('split-position-slider');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '104');
    expect(slider).toHaveValue('52');
    expect(screen.getByTestId('split-position-range')).toHaveTextContent('0.0 mm – 104.0 mm');
  });

  it('keeps the slider, the number field, the HUD and the published plane on one value', () => {
    const store = mount((s) => {
      load(s, 'millimeter');
    });
    fireEvent.change(screen.getByTestId('split-position-value'), { target: { value: '54' } });
    expect(screen.getByTestId('split-position-slider')).toHaveValue('54');
    expect(screen.getByTestId('split-hud-cut')).toHaveTextContent('Z = 54.0 mm');
    expect(store.getSnapshot().splitPlane?.origin[2]).toBe(54);

    fireEvent.change(screen.getByTestId('split-position-slider'), { target: { value: '60' } });
    fireEvent.blur(screen.getByTestId('split-position-value'));
    expect(screen.getByTestId('split-position-value')).toHaveValue(60);
    expect(store.getSnapshot().splitPlane?.origin[2]).toBe(60);
  });

  it('rolls the plane about the second axis, and the published plane follows', () => {
    const store = mount((s) => {
      load(s, 'millimeter');
    });
    expect(screen.getByTestId('split-roll')).toHaveValue(0);
    fireEvent.change(screen.getByTestId('split-roll'), { target: { value: '30' } });
    fireEvent.blur(screen.getByTestId('split-roll'));
    const normal = store.getSnapshot().splitPlane?.normal;
    expect(normal?.[1]).toBeCloseTo(-Math.sin(Math.PI / 6), 9);
    expect(normal?.[2]).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    expect(screen.getByTestId('split-hud-cut')).toHaveTextContent('rolled 30.0°');
  });

  it('swaps sides without moving the plane, and says it is pressed', () => {
    const store = mount((s) => {
      load(s, 'millimeter');
    });
    const flip = screen.getByTestId('split-flip-plane');
    expect(flip).toHaveAttribute('aria-pressed', 'false');
    const before = store.getSnapshot().splitPlane;
    fireEvent.click(flip);
    const after = store.getSnapshot().splitPlane;
    expect(flip).toHaveAttribute('aria-pressed', 'true');
    expect(after?.origin).toEqual(before?.origin);
    expect(after?.normal.map((c) => c + 0)).toEqual(before?.normal.map((c) => -c + 0));
  });

  it('reset restores a level, unflipped plane at the centre', () => {
    const store = mount((s) => {
      load(s, 'millimeter');
    });
    fireEvent.change(screen.getByTestId('split-roll'), { target: { value: '30' } });
    fireEvent.blur(screen.getByTestId('split-roll'));
    fireEvent.click(screen.getByTestId('split-flip-plane'));
    fireEvent.click(screen.getByTestId('split-reset-plane'));
    expect(screen.getByTestId('split-roll')).toHaveValue(0);
    expect(screen.getByTestId('split-flip-plane')).toHaveAttribute('aria-pressed', 'false');
    expect(store.getSnapshot().splitPlane?.normal).toEqual([0, 0, 1]);
  });

  it('clamps a typed position to the part', () => {
    const store = mount((s) => {
      load(s, 'millimeter');
    });
    fireEvent.change(screen.getByTestId('split-position-value'), { target: { value: '500' } });
    expect(store.getSnapshot().splitPlane?.origin[2]).toBe(104);
  });

  it('labels the slider and field with the axis and states the unit', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    expect(screen.getByLabelText('Position along Z')).toBe(
      screen.getByTestId('split-position-slider'),
    );
    expect(screen.getByLabelText('Position along Z value')).toBeInTheDocument();
    expect(screen.getByTestId('split-position-slider')).toHaveAttribute(
      'aria-valuetext',
      '52.0 mm',
    );
  });

  it('does not carry a cut to another part', () => {
    const store = mount((s) => {
      load(s, 'millimeter', [part('p1'), part('p2', 50)]);
    });
    fireEvent.change(screen.getByTestId('split-position-value'), { target: { value: '90' } });
    expect(store.getSnapshot().splitPlane?.origin[2]).toBe(90);
    act(() => {
      store.selectPart('p2');
    });
    // The second part's own centre, not the first part's number.
    expect(store.getSnapshot().splitPlane?.origin[2]).toBe(25);
    expect(screen.getByTestId('split-position-slider')).toHaveAttribute('max', '50');
  });
});

describe('connectors', () => {
  it('shows only None and round pin — no dovetail — as a labelled radio group', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    fireEvent.click(
      within(screen.getByTestId('split-connectors')).getByRole('button', { name: /Connector/ }),
    );
    const group = screen.getByRole('radiogroup', { name: 'Connector type' });
    const radios = [...group.querySelectorAll('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(screen.getByTestId('split-connector-none')).toBeChecked();
    expect(screen.queryByTestId('split-connector-dovetail')).toBeNull();
    expect(group).not.toHaveTextContent(/dovetail/i);
    expect(group).not.toHaveTextContent(/snap|thread|magnet|puzzle|screw|keyed/i);
  });

  it('disables connectors for a model that states no unit, and asks how to read it', () => {
    mount((store) => {
      load(store, undefined);
    });
    expect(screen.getByTestId('split-connector-pin')).toBeEnabled();
    expect(screen.queryByTestId('split-unit-interpretation')).toBeNull();
    fireEvent.click(screen.getByTestId('split-connector-pin'));
    expect(screen.getByTestId('split-preview')).toBeDisabled();
    expect(screen.getByTestId('split-connector-none')).toBeEnabled();
    expect(screen.getByTestId('split-connectors-unit')).toHaveTextContent('Choose its units');
    // Nothing is preselected: no radio is checked until the user chooses.
    const prompt = screen.getByTestId('split-unit-interpretation');
    expect(prompt.querySelectorAll('input:checked')).toHaveLength(0);
  });

  it('enables connectors once the user chooses how to read the units', () => {
    mount((store) => {
      load(store, undefined);
    });
    fireEvent.click(screen.getByTestId('split-connector-pin'));
    fireEvent.click(screen.getByTestId('split-unit-interpretation-inch'));
    expect(screen.getByTestId('split-connector-pin')).toBeEnabled();
    expect(screen.getByTestId('split-unit-interpretation-inch')).toBeChecked();
    expect(screen.queryByTestId('split-connectors-unit')).toBeNull();
  });

  it('offers no unit choice when the file states its own unit', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    expect(screen.queryByTestId('split-unit-interpretation')).toBeNull();
    expect(screen.getByTestId('split-connector-pin')).toBeEnabled();
  });

  it('states pin clearance precisely and shows the socket it produces', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    fireEvent.click(
      within(screen.getByTestId('split-connectors')).getByRole('button', { name: /Connector/ }),
    );
    fireEvent.click(screen.getByTestId('split-connector-pin'));
    expect(screen.getByLabelText('Clearance, per side, millimetres')).toHaveValue(0.2);
    expect(screen.getByTestId('split-socket-size')).toHaveTextContent(
      'Pin Ø 4 mm → socket Ø 4.4 mm',
    );
    fireEvent.change(screen.getByTestId('split-clearance'), { target: { value: '0.3' } });
    expect(screen.getByTestId('split-socket-size')).toHaveTextContent('socket Ø 4.6 mm');
  });

  it('refuses to preview a dimension the engine would refuse, and names it', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    fireEvent.click(
      within(screen.getByTestId('split-connectors')).getByRole('button', { name: /Connector/ }),
    );
    fireEvent.click(screen.getByTestId('split-connector-pin'));
    fireEvent.change(screen.getByTestId('split-pin-diameter'), { target: { value: '0' } });
    expect(screen.getByTestId('split-connector-problem')).toHaveTextContent('Pin diameter');
    expect(screen.getByTestId('split-preview')).toBeDisabled();
  });

  it('offers placement as automatic only, with no pattern or margin control', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    const connectors = screen.getByTestId('split-connectors');
    expect(connectors).toHaveTextContent('Placed automatically');
    expect(connectors).not.toHaveTextContent(/Manual|Grid|Circular|Along edge|Margin/);
  });
});

describe('the footer', () => {
  it('previews before anything can be applied or exported', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    expect(screen.getByTestId('split-preview')).toBeEnabled();
    expect(screen.queryByTestId('split-apply')).toBeNull();
    expect(screen.queryByTestId('split-export')).toBeNull();
  });

  it('shows an empty state with no usable action when no model is open', () => {
    mount(() => undefined);
    expect(screen.getByTestId('split-empty')).toBeInTheDocument();
    expect(screen.getByTestId('split-preview')).toBeDisabled();
  });

  it('keeps settings across a workspace switch, and Cancel resets them', () => {
    const store = mount((s) => {
      load(s, 'millimeter');
    });
    fireEvent.click(screen.getByTestId('split-connector-pin'));
    fireEvent.change(screen.getByTestId('split-position-value'), { target: { value: '30' } });
    act(() => {
      store.selectWorkflow(WorkflowId.Repair);
    });
    act(() => {
      store.selectWorkflow(WorkflowId.Split);
    });
    expect(screen.getByTestId('split-connector-pin')).toBeChecked();
    expect(store.getSnapshot().splitPlane?.origin[2]).toBe(30);

    fireEvent.click(screen.getByTestId('split-cancel'));
    expect(store.getSnapshot().selectedWorkflow).toBeUndefined();
    act(() => {
      store.selectWorkflow(WorkflowId.Split);
    });
    expect(screen.getByTestId('split-connector-none')).toBeChecked();
    expect(store.getSnapshot().splitPlane?.origin[2]).toBe(52);
  });
});

describe('a refusal about what the connector was asked to BE is said as that, not as an unsafe cut (Stage C03-C2)', () => {
  /** A worker that answers the preview with the refusal the real engine gives, so the page's own wording is what is observed. */
  function workerRefuses(code: string, message: string): void {
    vi.spyOn(GeometryClient.prototype, 'createSplit').mockImplementation(
      () =>
        ({
          promise: Promise.reject(invalidState(message, { code })),
          cancel: (): void => undefined,
        }) as unknown as ReturnType<GeometryClient['createSplit']>,
    );
  }
  async function previewWithPin(unit: 'millimeter'): Promise<void> {
    mount((store) => {
      load(store, unit);
    });
    fireEvent.click(screen.getByTestId('split-connector-pin'));
    fireEvent.click(screen.getByTestId('split-preview'));
    await screen.findByTestId('split-connector-input');
  }
  it.each([
    [
      'UNKNOWN_UNITS',
      'This model has no physical units. Set the model units before adding a physical connector.',
    ],
    ['CONNECTOR_UNSUPPORTED_TRANSFORM', 'Connectors require uniform model scale.'],
    [
      'CONNECTOR_DIMENSION_OUT_OF_POLICY',
      'Pin diameter of 0.001 mm is outside the range Pybrix can place (0.01–1000 mm).',
    ],
  ])(
    "%s: the worker's sentence is shown, with what is still true, and no advice about the cut",
    async (code, message) => {
      workerRefuses(code, message);
      await previewWithPin('millimeter');
      const shown = screen.getByTestId('split-connector-input');
      expect(shown).toHaveTextContent(message);
      expect(shown).toHaveTextContent('Your model is unchanged.');
      expect(shown).not.toHaveTextContent(/cut|safely|move/i);
      expect(shown).toHaveAttribute('role', 'status');
      // and not the generic cut refusal beside it
      expect(screen.queryByText(/can't be made safely/)).toBeNull();
      expect(screen.queryByTestId('split-error')).toBeNull();
    },
  );
  it('any other refusal keeps the cut wording it always had', async () => {
    workerRefuses('CUT_NOT_SAFE', 'This cut cannot be made safely. Try a different plane.');
    mount((store) => {
      load(store, 'millimeter');
    });
    fireEvent.click(screen.getByTestId('split-connector-pin'));
    fireEvent.click(screen.getByTestId('split-preview'));
    await screen.findByTestId('split-error');
    expect(screen.queryByTestId('split-connector-input')).toBeNull();
    expect(screen.getByTestId('split-error')).toHaveTextContent("This cut can't be made safely.");
  });
});

describe('a cut that ran out of its work budget is said as that, not as an unsafe cut (v0.8.0 scale-limit truthfulness)', () => {
  /** The worker's refusal exactly as the kernel types it: `CUT_NOT_SAFE` carrying a `reason`. Only the reason differs between the two cases. */
  function workerRefusesCut(reason: string): void {
    vi.spyOn(GeometryClient.prototype, 'createSplit').mockImplementation(
      () =>
        ({
          promise: Promise.reject(
            invalidState('This cut cannot be made safely. Try a different plane.', {
              code: 'CUT_NOT_SAFE',
              reason,
            }),
          ),
          cancel: (): void => undefined,
        }) as unknown as ReturnType<GeometryClient['createSplit']>,
    );
  }
  function preview(): void {
    mount((store) => {
      load(store, 'millimeter');
    });
    fireEvent.click(screen.getByTestId('split-connector-pin'));
    fireEvent.click(screen.getByTestId('split-preview'));
  }
  it('WORK_LIMIT is the resource sentence, with no advice to move the cut', async () => {
    workerRefusesCut('WORK_LIMIT');
    preview();
    const shown = await screen.findByTestId('split-resource-limit');
    expect(shown).toHaveTextContent(
      'This operation is too large to process safely with the current limits.',
    );
    expect(shown).toHaveTextContent('Try a smaller model or a simpler operation.');
    expect(shown).toHaveTextContent('Your model is unchanged.');
    expect(shown).not.toHaveTextContent(/move the cut|another part|different plane|invalid/i);
    expect(shown).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('split-error')).toBeNull();
    expect(screen.queryByText(/can't be made safely/)).toBeNull();
  });
  it.each(['EMPTY_PIECE', 'COPLANAR_MATERIAL_AMBIGUOUS', 'UNPAIRED_SOURCE_SECTION'])(
    'a cut refused for a reason about the cut itself (%s) keeps its advice about the cut',
    async (reason) => {
      workerRefusesCut(reason);
      preview();
      const shown = await screen.findByTestId('split-error');
      expect(shown).toHaveTextContent("This cut can't be made safely.");
      expect(shown).toHaveTextContent('Try moving the cut');
      expect(screen.queryByTestId('split-resource-limit')).toBeNull();
    },
  );
});
