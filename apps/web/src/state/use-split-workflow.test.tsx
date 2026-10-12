import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createOperationId } from '@cadfixer/shared';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentRenderSnapshot,
  PartDescriptor,
  SplitCreateResult,
} from '@cadfixer/geometry-runtime';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from './store-context';
import { WorkspaceStore } from './workspace-store';
import { WorkflowId } from './workflows';
import type { LoadedModel } from './model';
import { SplitPhase, type SplitControls } from './use-split-workflow';
import { SplitControlsProvider, useSplitControls } from './workflow-controllers';
import { SplitWorkspace } from '../components/SplitWorkspace';
import { ShellLayoutProvider } from '../components/shell/shell-layout';
const paint = vi.hoisted(() => ({ frames: [] as (() => void)[] }));
vi.mock('./after-paint', () => ({
  afterPaint: (): Promise<void> => new Promise<void>((resolve) => paint.frames.push(resolve)),
}));
afterEach(() => {
  cleanup();
  paint.frames = [];
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

interface TestSetup {
  readonly result: { current: SplitControls };
  readonly create: MockInstance<GeometryClient['createSplit']>;
  readonly commit: MockInstance<GeometryClient['commitSplit']>;
  readonly undo: MockInstance<GeometryClient['undoRepair']>;
  readonly status: MockInstance<WorkspaceStore['pushStatus']>;
}
function setup(): TestSetup {
  const store = new WorkspaceStore();
  load(store, 'millimeter', [part('A'), part('B')]);
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  const candidate = {
    candidate: {},
    render: { parts: [] },
    parts: [],
    metrics: { pieceAFinalVolume: 1, pieceBFinalVolume: 1, volumeRelativeError: 0 },
    section: {},
    connector: { kind: 'none' },
  } as unknown as SplitCreateResult;
  const create = vi.spyOn(client, 'createSplit').mockReturnValue({
    id: createOperationId(),
    interruptible: true,
    promise: Promise.resolve(candidate),
    cancel: vi.fn(),
  });
  const commit = vi.spyOn(client, 'commitSplit').mockReturnValue({
    promise: Promise.resolve({
      pieceAId: 'A',
      pieceBId: 'B',
      recordId: 'record',
      metrics: { pieceAFinalVolume: 1, pieceBFinalVolume: 1, volumeRelativeError: 0 },
      section: {},
      connector: { kind: 'none' },
    }),
  } as ReturnType<GeometryClient['commitSplit']>);
  const undo = vi
    .spyOn(client, 'undoRepair')
    .mockReturnValue({ promise: Promise.resolve({}) } as ReturnType<GeometryClient['undoRepair']>);
  vi.spyOn(client, 'discardSplit').mockReturnValue({
    id: createOperationId(),
    interruptible: true,
    cancel: vi.fn(),
    promise: Promise.resolve({ released: true }),
  });
  vi.spyOn(store, 'applySplitResult').mockReturnValue(true);
  vi.spyOn(store, 'applyUndoResult').mockReturnValue(true);
  const status = vi.spyOn(store, 'pushStatus');
  const hook = renderHook(() => useSplitControls(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceProvider store={store}>
        <GeometryClientProvider client={client}>
          <ShellLayoutProvider>
            <SplitControlsProvider>
              <SplitWorkspace />
              {children}
            </SplitControlsProvider>
          </ShellLayoutProvider>
        </GeometryClientProvider>
      </WorkspaceProvider>
    ),
  });
  return { ...hook, create, commit, undo, status };
}
async function frame(): Promise<void> {
  await act(async () => {
    const callbacks = paint.frames.splice(0);
    callbacks.forEach((resolve) => {
      resolve();
    });
    await Promise.resolve();
  });
}
async function applied(s: ReturnType<typeof setup>): Promise<void> {
  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  act(() => {
    s.result.current.apply();
  });
  await frame();
  await frame();
}
describe('Split action guards and painted phases', () => {
  it('Preview closes synchronously, dispatches once after paint, and recovers', async () => {
    const s = setup();
    act(() => {
      s.result.current.updatePreview();
      s.result.current.updatePreview();
    });
    expect(s.result.current.phase).toBe(SplitPhase.Computing);
    expect(s.create).not.toHaveBeenCalled();
    await frame();
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.result.current.phase).toBe(SplitPhase.Computing);
    await frame();
    expect(s.result.current.phase).toBe(SplitPhase.Preview);
  });
  it('suggestion preparation guards the load before scene work', async () => {
    const s = setup();
    const loadCut = vi.fn();
    act(() => {
      s.result.current.preparePreview(loadCut);
      s.result.current.preparePreview(loadCut);
    });
    expect(s.result.current.phase).toBe(SplitPhase.Preparing);
    expect(loadCut).not.toHaveBeenCalled();
    await frame();
    expect(loadCut).toHaveBeenCalledTimes(1);
    act(() => {
      s.result.current.completePreparedPreview();
    });
    await frame();
    await frame();
    expect(s.create).toHaveBeenCalledTimes(1);
  });
  it('thrown Preview releases the guard and returns idle', async () => {
    const s = setup();
    s.create.mockImplementation(() => {
      throw new Error('preview failed');
    });
    act(() => {
      s.result.current.updatePreview();
    });
    await frame();
    expect(s.result.current.phase).toBe(SplitPhase.Idle);
    act(() => {
      s.result.current.updatePreview();
    });
    await frame();
    expect(s.create).toHaveBeenCalledTimes(2);
  });
  it('Undo dispatches once after paint and emits one success without stale Activity', async () => {
    const s = setup();
    await applied(s);
    act(() => {
      s.result.current.undo();
      s.result.current.undo();
    });
    expect(s.result.current.phase).toBe(SplitPhase.Undoing);
    expect(s.undo).not.toHaveBeenCalled();
    expect(screen.getByTestId('split-undo')).toBeDisabled();
    expect(screen.getByTestId('split-export')).toBeDisabled();
    expect(screen.getByTestId('split-progress')).toHaveTextContent('Undoing split…');
    await frame();
    expect(s.undo).toHaveBeenCalledTimes(1);
    expect(s.result.current.phase).toBe(SplitPhase.Undoing);
    await frame();
    expect(s.result.current.phase).toBe(SplitPhase.Idle);
    expect(s.result.current.applied).toBeUndefined();
    expect(s.status.mock.calls.filter((call) => call[1] === 'Split undone.')).toHaveLength(1);
    expect(s.status.mock.calls.some((call) => /out-of-date|stale/.test(call[1]))).toBe(false);
  });
  it('thrown Undo releases the guard and retains the applied model', async () => {
    const s = setup();
    await applied(s);
    s.undo.mockImplementation(() => {
      throw new Error('undo failed');
    });
    act(() => {
      s.result.current.undo();
    });
    await frame();
    expect(s.result.current.phase).toBe(SplitPhase.Idle);
    expect(s.result.current.applied).toBeDefined();
    expect(screen.getByTestId('split-undo')).toBeEnabled();
    expect(screen.getByTestId('split-export')).toBeEnabled();
    act(() => {
      s.result.current.undo();
    });
    await frame();
    expect(s.undo).toHaveBeenCalledTimes(2);
  });
  it('Apply dispatches one commit and recovers', async () => {
    const s = setup();
    act(() => {
      s.result.current.updatePreview();
    });
    await frame();
    await frame();
    act(() => {
      s.result.current.apply();
      s.result.current.apply();
    });
    expect(s.result.current.phase).toBe(SplitPhase.Applying);
    expect(s.commit).not.toHaveBeenCalled();
    await frame();
    await frame();
    expect(s.commit).toHaveBeenCalledTimes(1);
    expect(s.result.current.phase).toBe(SplitPhase.Idle);
  });
});
