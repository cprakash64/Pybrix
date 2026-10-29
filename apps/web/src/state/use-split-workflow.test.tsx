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
  readonly client: GeometryClient;
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
  return { ...hook, create, commit, undo, status, client };
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
  it('boundary inspection ignores unrelated invalid connector settings and stays connector-free', async () => {
    const s = setup();
    act(() => {
      s.result.current.setConnector({ kind: 'pin', diameter: -1 });
    });
    act(() => {
      s.result.current.loadSuggestedPlane({ normal: [0, 0, 1], origin: [0, 0, 52] }, 'Option A', {
        preparationId: 7,
        candidateId: 'part',
        boundaryAlternativeId: 'part:boundary:0',
        boundaryChoice: 'PREVIEW',
      });
    });
    expect(s.result.current.connectorProblem).toBeDefined();
    act(() => {
      s.result.current.updatePreview();
    });
    await frame();
    await frame();
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.create.mock.calls[0]?.[2].connector).toEqual({ kind: 'none' });
    expect(s.commit).not.toHaveBeenCalled();
  });

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
      s.result.current.discardPreview();
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
  it('keeps the plane fixed when a viewport drag arrives during Preview', () => {
    const s = setup();
    const offset = s.result.current.offset;
    act(() => {
      s.result.current.updatePreview();
      s.result.current.beginPlaneDrag();
      s.result.current.dragPlane(10);
    });
    expect(s.result.current.offset).toBe(offset);
    expect(s.create).not.toHaveBeenCalled();
  });
  it('discard before paint cancels the queued Preview and releases its guard', async () => {
    const s = setup();
    act(() => {
      s.result.current.updatePreview();
      s.result.current.discardPreview();
    });
    await frame();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.result.current.phase).toBe(SplitPhase.Idle);
    expect(s.status).not.toHaveBeenCalled();
    act(() => {
      s.result.current.updatePreview();
    });
    await frame();
    await frame();
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.result.current.phase).toBe(SplitPhase.Preview);
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
      s.result.current.discardPreview();
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

it('C2AD: a failed authorized semantic Apply must withdraw consumed authority before another Apply', async () => {
  const s = setup();
  const original = s.create.getMockImplementation();
  if (!original) throw Error('Missing fixture');
  const operation = original({} as never, '', {} as never);
  const base = await operation.promise;
  s.create.mockReturnValue({
    ...operation,
    promise: Promise.resolve({
      ...base,
      semanticQualification: {
        preparationId: 7,
        candidateId: 'semantic',
        plane: { normal: [1, 0, 0], origin: [0, 0, 0] },
        attempts: 1,
        failures: 0,
        winnerIndex: 0,
        milliseconds: 0,
        scopeConfirmation: { receiptId: 'consumed-by-worker', state: 'CONFIRMED' },
      },
    }),
  });
  s.commit.mockReturnValue({
    promise: Promise.reject(Error('Authorized commit failed after consumption')),
  } as ReturnType<GeometryClient['commitSplit']>);
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
  expect(s.commit).toHaveBeenCalledTimes(1);
  act(() => {
    s.result.current.apply();
  });
  await frame();
  await frame();
  expect(s.commit).toHaveBeenCalledTimes(1);
  expect(s.result.current.preview).toBeUndefined();
});

function recoveryPreview(
  s: TestSetup,
  state?: 'CONFIRMED' | 'AUTOMATIC_IDENTIFIED' | 'REQUIRED',
  boundary = false,
): Promise<void> {
  const impl = s.create.getMockImplementation();
  if (!impl) throw Error('Missing fixture');
  const operation = impl({} as never, '', {} as never);
  return operation.promise.then((base) => {
    s.create.mockReturnValue({
      ...operation,
      promise: Promise.resolve({
        ...base,
        ...(state
          ? {
              semanticQualification: {
                preparationId: 7,
                candidateId: 'semantic',
                plane: { normal: [1, 0, 0] as const, origin: [0, 0, 0] as const },
                attempts: 1,
                failures: 0,
                winnerIndex: 0,
                milliseconds: 0,
                ...(boundary
                  ? { boundaryChoice: 'CONFIRM' as const, boundaryAlternativeId: 'A' }
                  : {}),
                scopeConfirmation: { receiptId: 'opaque', state },
              },
            }
          : {}),
      }),
      cancel: vi.fn(),
    });
  });
}
it.each([
  'CONFIRMED',
  'AUTOMATIC_IDENTIFIED',
  'boundary',
  'transport',
  'stale-source',
  'wrong-part',
  'discard-reject',
  'discard-throw',
] as const)('withdraws semantic failure %s without a second dispatch', async (kind) => {
  const s = setup();
  await recoveryPreview(
    s,
    kind === 'AUTOMATIC_IDENTIFIED' ? 'AUTOMATIC_IDENTIFIED' : 'CONFIRMED',
    kind === 'boundary',
  );
  s.commit.mockReturnValue({ promise: Promise.reject(Error(kind)) } as ReturnType<
    GeometryClient['commitSplit']
  >);
  if (kind === 'discard-reject')
    vi.spyOn(s.client, 'discardSplit').mockReturnValue({
      promise: Promise.reject(Error('cleanup')),
    } as ReturnType<GeometryClient['discardSplit']>);
  if (kind === 'discard-throw')
    vi.spyOn(s.client, 'discardSplit').mockImplementation(() => {
      throw Error('cleanup');
    });
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
  expect(s.result.current.preview).toBeUndefined();
  expect(s.result.current.phase).toBe(SplitPhase.Idle);
  expect(s.result.current.error).toContain(kind);
  expect(screen.queryByTestId('split-apply')).toBeNull();
  act(() => {
    s.result.current.apply();
  });
  await frame();
  expect(s.commit).toHaveBeenCalledTimes(1);
});
it('keeps a manual Preview retryable after commit failure', async () => {
  const s = setup();
  s.commit.mockReturnValue({ promise: Promise.reject(Error('retryable')) } as ReturnType<
    GeometryClient['commitSplit']
  >);
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
  expect(s.result.current.preview).toBeDefined();
  act(() => {
    s.result.current.apply();
  });
  await frame();
  await frame();
  expect(s.commit).toHaveBeenCalledTimes(2);
});
it('does not withdraw REQUIRED authority before dispatch', async () => {
  const s = setup();
  await recoveryPreview(s, 'REQUIRED');
  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  act(() => {
    s.result.current.apply();
  });
  await frame();
  expect(s.commit).not.toHaveBeenCalled();
  expect(s.result.current.preview).toBeDefined();
});
it('keeps successful semantic Apply in normal applied state', async () => {
  const s = setup();
  await recoveryPreview(s, 'CONFIRMED');
  await applied(s);
  expect(s.result.current.applied).toBeDefined();
  expect(s.result.current.preview).toBeUndefined();
  expect(s.result.current.failedSemanticApply).toBeUndefined();
});

it.each(['CONFIRMED', 'AUTOMATIC_IDENTIFIED'] as const)(
  'allows recovery only through a fresh %s Preview response',
  async (state) => {
    const s = setup();
    await recoveryPreview(s, state);
    const commitImpl = s.commit.getMockImplementation();
    if (!commitImpl) throw Error('Missing fixture');
    const success = commitImpl({} as never, {} as never, '');
    s.commit.mockReturnValue({ promise: Promise.reject(Error('first failure')) } as ReturnType<
      GeometryClient['commitSplit']
    >);
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
    act(() => {
      s.result.current.apply();
    });
    await frame();
    expect(s.commit).toHaveBeenCalledTimes(1);
    const createImpl = s.create.getMockImplementation();
    if (!createImpl) throw Error('Missing fixture');
    const op = createImpl({} as never, '', {} as never);
    const old = await op.promise;
    const proof = old.semanticQualification;
    if (!proof) throw Error('Missing proof');
    s.create.mockReturnValue({
      ...op,
      promise: Promise.resolve({
        ...old,
        candidate: { ...old.candidate, candidateId: 'fresh-ticket' },
        semanticQualification: {
          ...proof,
          scopeConfirmation: { receiptId: 'fresh-worker-receipt', state },
        },
      }),
    });
    s.commit.mockReturnValue(success);
    act(() => {
      s.result.current.updatePreview();
    });
    await frame();
    await frame();
    expect(s.create).toHaveBeenCalledTimes(2);
    expect(s.result.current.preview?.candidate.candidateId).toBe('fresh-ticket');
    act(() => {
      s.result.current.apply();
    });
    await frame();
    await frame();
    expect(s.commit).toHaveBeenCalledTimes(2);
    expect(s.result.current.applied).toBeDefined();
  },
);
