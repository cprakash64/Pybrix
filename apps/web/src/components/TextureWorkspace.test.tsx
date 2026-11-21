import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentRenderSnapshot,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { TextureWorkspace } from './TextureWorkspace';
import { TextureHud } from './TextureHud';
import { TextureInspector } from './TextureInspector';
import { ShellLayoutProvider } from './shell/shell-layout';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import {
  ConnectorEditControlsProvider,
  TextureControlsProvider,
} from '../state/workflow-controllers';
import { WorkspaceStore } from '../state/workspace-store';
import { WorkflowId } from '../state/workflows';
import type { LoadedModel } from '../state/model';

/**
 * UI-05: the Surface Texture workspace at component level.
 *
 * The worker is stubbed and never replies, so the Boolean and the layout are
 * proven elsewhere (Node and Chromium). What this proves is the workspace:
 * one selection read from the store, only real tools and patterns, rules
 * stated before any work, and no selection surviving a revision it does not
 * belong to.
 */

afterEach(cleanup);

function part(partId: string): PartDescriptor {
  return {
    partId,
    name: `Part ${partId}`,
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount: 12,
    vertexCount: 8,
    bounds: undefined,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

function load(store: WorkspaceStore, unit: string | undefined): DocumentHandle {
  const parts = [part('p1'), part('p2')];
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
      fileName: 'box.3mf',
      fileBytes: 100,
      formatId: '3mf',
      encoding: '3mf',
      unit,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: 24,
    vertexCount: 16,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 1,
  };
  const token = store.beginImport(model.source.fileName);
  store.commitImport(token, model);
  store.selectWorkflow(WorkflowId.Texture);
  return handle;
}

function select(store: WorkspaceStore, source: DocumentHandle): boolean {
  return store.setTextureSelection({
    source,
    partId: 'p1',
    seedTriangle: 2,
    triangleIds: [2, 3],
    area: 800,
    partArea: 8800,
    planarity: 'PLANAR',
  });
}

function mount(configure: (store: WorkspaceStore) => void): WorkspaceStore {
  const store = new WorkspaceStore();
  configure(store);
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <ShellLayoutProvider>
          <TextureControlsProvider>
            <ConnectorEditControlsProvider>
              <TextureWorkspace />
              <TextureHud />
              <TextureInspector />
            </ConnectorEditControlsProvider>
          </TextureControlsProvider>
        </ShellLayoutProvider>
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return store;
}

describe('surface selection', () => {
  it('offers only the one real tool, plus Clear', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    const tools = screen.getByRole('group', { name: 'Selection tool' });
    expect(tools).toHaveTextContent('Flat region');
    expect(tools.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByTestId('texture-clear')).toHaveTextContent('Clear');
    const workspace = screen.getByTestId('texture-workspace');
    expect(workspace).not.toHaveTextContent(
      /Brush|Lasso|Angle|Planar|Select all|Invert|Grow|Shrink|Exclude bottom/,
    );
  });

  it('shows the worker’s real metrics in the panel, the HUD and the inspector', () => {
    mount((store) => {
      select(store, load(store, 'millimeter'));
    });
    expect(screen.getByTestId('texture-area')).toHaveTextContent('800 mm²');
    expect(screen.getByTestId('texture-triangles')).toHaveTextContent('2 triangles');
    expect(screen.getByTestId('texture-coverage')).toHaveTextContent('9% of surface');
    expect(screen.getByTestId('texture-hud-selection')).toHaveTextContent('Selected 800 mm²');
    expect(screen.getByTestId('texture-inspector-area')).toHaveTextContent('800 mm²');
  });

  it('refuses a selection for a revision that is not on screen', () => {
    const store = mount((s) => {
      load(s, 'millimeter');
    });
    expect(select(store, { documentId: 'doc-1', revision: 99 } as DocumentHandle)).toBe(false);
    expect(screen.getByTestId('texture-no-selection')).toBeInTheDocument();
  });

  it('retires a selection the moment the model moves to another revision', () => {
    const store = mount((s) => {
      select(s, load(s, 'millimeter'));
    });
    expect(screen.getByTestId('texture-area')).toBeInTheDocument();
    // A replacement document: the old face ids index a mesh that is gone.
    act(() => {
      load(store, 'millimeter');
    });
    expect(screen.queryByTestId('texture-area')).toBeNull();
    expect(screen.getByTestId('texture-no-selection')).toBeInTheDocument();
  });

  it('does not show one part’s selection while another part is active', () => {
    const store = mount((s) => {
      select(s, load(s, 'millimeter'));
    });
    act(() => {
      store.selectPart('p2');
    });
    expect(screen.queryByTestId('texture-area')).toBeNull();
  });

  it('clears the selection and nothing else', () => {
    const store = mount((s) => {
      select(s, load(s, 'millimeter'));
    });
    fireEvent.click(screen.getByTestId('texture-clear'));
    expect(store.getSnapshot().textureSelection).toBeUndefined();
    expect(store.getSnapshot().model?.revision).toBeDefined();
  });
});

describe('texture source, mapping and parameters', () => {
  it('shows the three real patterns as a labelled radio group', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    const group = screen.getByRole('radiogroup', { name: 'Pattern' });
    expect(group.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(screen.getByTestId('texture-pattern-dots')).toBeChecked();
    expect(screen.queryByText(/Upload image/)).toBeNull();
  });

  it('states one flat projection and offers rotation only for patterns that use it', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    expect(screen.getByTestId('texture-projection')).toHaveTextContent('Flat');
    expect(screen.queryByTestId('texture-rotation')).toBeNull();
    fireEvent.click(screen.getByTestId('texture-pattern-lines'));
    expect(screen.getByTestId('texture-rotation')).toBeInTheDocument();
    expect(screen.getByTestId('texture-mapping')).not.toHaveTextContent(
      /Cylindrical|Spherical|Triplanar|Follow surface|Scale X/,
    );
  });

  it('labels height or depth by direction, in millimetres', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    expect(screen.getByLabelText('Height, millimetres')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('texture-engraved'));
    expect(screen.getByLabelText('Depth, millimetres')).toBeInTheDocument();
    expect(screen.getByTestId('texture-inspector-direction')).toHaveTextContent('Engraved');
  });

  it('states a rule the engine would refuse, and holds the action', () => {
    mount((store) => {
      select(store, load(store, 'millimeter'));
    });
    fireEvent.change(screen.getByTestId('texture-spacing'), { target: { value: '1' } });
    expect(screen.getByTestId('texture-settings-problem')).toHaveTextContent('centre to centre');
    expect(screen.getByTestId('texture-generate')).toBeDisabled();
  });

  it('disables texturing for a model that states no unit, and asks how to read it', () => {
    mount((store) => {
      select(store, load(store, undefined));
    });
    expect(screen.getByTestId('texture-unit')).toHaveTextContent('Choose how to read');
    expect(screen.getByTestId('texture-pattern-lines')).toBeDisabled();
    expect(screen.getByTestId('texture-generate')).toBeDisabled();
    // The selection's area is still measured, without an invented unit.
    expect(screen.getByTestId('texture-area')).toHaveTextContent('800 sq. units');
  });

  it('enables texturing once the user chooses how to read the units', () => {
    mount((store) => {
      select(store, load(store, undefined));
    });
    fireEvent.click(screen.getByTestId('texture-unit-interpretation-millimeter'));
    expect(screen.getByTestId('texture-pattern-lines')).toBeEnabled();
    expect(screen.queryByTestId('texture-unit')).toBeNull();
  });

  it('needs a selection before anything can be generated', () => {
    mount((store) => {
      load(store, 'millimeter');
    });
    expect(screen.getByTestId('texture-generate')).toBeDisabled();
    expect(screen.getByTestId('texture-unavailable')).toHaveTextContent('Select a flat face');
  });

  it('reset restores the default settings and keeps the selection', () => {
    const store = mount((s) => {
      select(s, load(s, 'millimeter'));
    });
    fireEvent.click(screen.getByTestId('texture-pattern-diamond'));
    fireEvent.click(screen.getByTestId('texture-reset'));
    expect(screen.getByTestId('texture-pattern-dots')).toBeChecked();
    expect(store.getSnapshot().textureSelection).toBeDefined();
  });
});
