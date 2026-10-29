import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type * as ScopeAuthority from '../workers/semantic-scope-authority';
import { createOperationId, invalidState } from '@cadfixer/shared';
import { PROTOCOL_CHANNEL, type GeometryCoordinator } from '@cadfixer/geometry-runtime';
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
const paint = vi.hoisted(() => ({
  frames: [] as (() => void)[],
  failure: undefined as Error | undefined,
}));
vi.mock('./after-paint', () => ({
  afterPaint: (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (paint.failure) reject(paint.failure);
      else paint.frames.push(resolve);
    }),
}));
afterEach(() => {
  cleanup();
  paint.frames = [];
  paint.failure = undefined;
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
  readonly unmount: () => void;
  readonly store: WorkspaceStore;
  readonly client: GeometryClient;
  readonly result: { current: SplitControls };
  readonly create: MockInstance<GeometryClient['createSplit']>;
  readonly commit: MockInstance<GeometryClient['commitSplit']>;
  readonly undo: MockInstance<GeometryClient['undoRepair']>;
  readonly discard: MockInstance<GeometryClient['discardSplit']>;
  readonly adopt: MockInstance<WorkspaceStore['applySplitResult']>;
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
  const discard = vi.spyOn(client, 'discardSplit').mockReturnValue({
    id: createOperationId(),
    interruptible: true,
    cancel: vi.fn(),
    promise: Promise.resolve({ released: true }),
  });
  const adopt = vi.spyOn(store, 'applySplitResult').mockReturnValue(true);
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
  return { ...hook, create, commit, undo, discard, adopt, status, client, store };
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
  s.commit.mockImplementation(
    () =>
      ({
        promise: Promise.reject(Error('Authorized commit failed after consumption')),
      }) as ReturnType<GeometryClient['commitSplit']>,
  );
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
  s.commit.mockImplementation(
    () => ({ promise: Promise.reject(Error(kind)) }) as ReturnType<GeometryClient['commitSplit']>,
  );
  if (kind === 'discard-reject')
    vi.spyOn(s.client, 'discardSplit').mockImplementation(
      () =>
        ({ promise: Promise.reject(Error('cleanup')) }) as ReturnType<
          GeometryClient['discardSplit']
        >,
    );
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
  s.commit.mockImplementation(
    () =>
      ({ promise: Promise.reject(Error('retryable')) }) as ReturnType<
        GeometryClient['commitSplit']
      >,
  );
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
    s.commit.mockImplementation(
      () =>
        ({ promise: Promise.reject(Error('first failure')) }) as ReturnType<
          GeometryClient['commitSplit']
        >,
    );
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

it('C2AF: local adoption refusal after successful semantic commit kills the consumed Preview', async () => {
  const s = setup();
  await recoveryPreview(s, 'CONFIRMED');
  vi.spyOn(s.store, 'applySplitResult').mockReturnValue(false);
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
  expect(s.result.current.error).toContain('model changed');
  act(() => {
    s.result.current.apply();
  });
  await frame();
  await frame();
  expect(s.commit).toHaveBeenCalledTimes(1);
  expect(s.result.current.preview).toBeUndefined();
});

it.each([
  'CONFIRMED',
  'AUTOMATIC_IDENTIFIED',
  'boundary',
  'discard-reject',
  'discard-throw',
  'local-clear-throw',
  'processing-throw',
  'status-throw',
  'applied-transition-throw',
] as const)('centralizes post-dispatch adoption failure %s', async (kind) => {
  const s = setup();
  await recoveryPreview(
    s,
    kind === 'AUTOMATIC_IDENTIFIED' ? 'AUTOMATIC_IDENTIFIED' : 'CONFIRMED',
    kind === 'boundary',
  );
  if (kind === 'processing-throw')
    vi.spyOn(s.store, 'applySplitResult').mockImplementation(() => {
      throw Error('processing failure');
    });
  else vi.spyOn(s.store, 'applySplitResult').mockReturnValue(kind === 'applied-transition-throw');
  if (kind === 'discard-reject')
    vi.spyOn(s.client, 'discardSplit').mockImplementation(
      () =>
        ({ promise: Promise.reject(Error('cleanup')) }) as ReturnType<
          GeometryClient['discardSplit']
        >,
    );
  if (kind === 'discard-throw')
    vi.spyOn(s.client, 'discardSplit').mockImplementation(() => {
      throw Error('cleanup');
    });

  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  if (kind === 'status-throw' || kind === 'applied-transition-throw')
    s.status.mockImplementation(() => {
      throw Error('status failure');
    });
  const clearSpy =
    kind === 'local-clear-throw'
      ? vi.spyOn(s.store, 'clearSplitPreview').mockImplementation(() => {
          throw Error('local cleanup');
        })
      : undefined;
  act(() => {
    s.result.current.apply();
  });
  await frame();
  await frame();
  expect(s.result.current.preview).toBeUndefined();
  expect(s.result.current.phase).toBe(SplitPhase.Idle);
  expect(s.result.current.failedSemanticApply).toBeDefined();
  expect(s.result.current.error).toContain(
    kind === 'processing-throw'
      ? 'processing failure'
      : kind === 'applied-transition-throw'
        ? 'status failure'
        : 'model changed',
  );
  act(() => {
    s.result.current.apply();
  });
  await frame();
  expect(s.commit).toHaveBeenCalledTimes(1);
  clearSpy?.mockRestore();
});
it('preserves manual adoption-refusal behavior', async () => {
  const s = setup();
  vi.spyOn(s.store, 'applySplitResult').mockReturnValue(false);
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
it('unmount after semantic dispatch already retires the operative Preview', async () => {
  const s = setup();
  await recoveryPreview(s, 'CONFIRMED');
  let resolve:
    ((v: Awaited<ReturnType<GeometryClient['commitSplit']>['promise']>) => void) | undefined;
  const impl = s.commit.getMockImplementation();
  if (!impl) throw Error('fixture');
  const success = await impl({} as never, {} as never, '').promise;
  s.commit.mockReturnValue({
    promise: new Promise((r) => {
      resolve = r;
    }),
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
  s.unmount();
  if (!resolve) throw Error('resolver');
  resolve(success);
  await frame();
  await frame();
  act(() => {
    s.result.current.apply();
  });
  expect(s.commit).toHaveBeenCalledTimes(1);
});

it.each(['CONFIRMED', 'AUTOMATIC_IDENTIFIED'] as const)(
  'allows fresh %s success after local adoption refusal',
  async (state) => {
    const s = setup();
    await recoveryPreview(s, state);
    const commitImpl = s.commit.getMockImplementation();
    if (!commitImpl) throw Error('Missing fixture');
    const success = commitImpl({} as never, {} as never, '');
    vi.spyOn(s.store, 'applySplitResult').mockReturnValueOnce(false);
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

/** The real client/coordinator, with only the transport acceptance/response controlled. */
async function boundaryTransport(
  s: TestSetup,
  synchronousFailures: number,
  outcome: 'success' | 'reject' | 'pending' = 'success',
): Promise<{
  counts: { attempted: number; accepted: number; returned: number };
  pending: () => number;
  reply: () => void;
}> {
  const original = s.commit.getMockImplementation();
  const preview = s.result.current.preview;
  const model = s.store.getSnapshot().model;
  if (!original || !preview || !model) throw Error('Missing transport fixture');
  const success = await original(preview.candidate, model.handle, 'A').promise;
  s.commit.mockRestore();
  const commit = s.client.commitSplit.bind(s.client);
  const counts = { attempted: 0, accepted: 0, returned: 0 };
  // Observe successful handle return without replacing the dispatch implementation.
  vi.spyOn(s.client, 'commitSplit').mockImplementation((...args) => {
    const operation = commit(...args);
    counts.returned++;
    return operation;
  });
  const worker = (s.client as unknown as { worker: Worker }).worker;
  let reply = (): void => undefined;
  vi.spyOn(worker, 'postMessage').mockImplementation((value: unknown) => {
    const message = value as { operation?: string; id: string };
    if (message.operation !== 'split/commit') return;
    counts.attempted++;
    if (synchronousFailures-- > 0) throw invalidState('Apply was not submitted. Try again.');
    counts.accepted++;
    reply = (): void => {
      worker.dispatchEvent(
        new MessageEvent('message', {
          data: {
            channel: PROTOCOL_CHANNEL,
            id: message.id,
            ...(outcome === 'success'
              ? { kind: 'result', value: success }
              : {
                  kind: 'error',
                  error: invalidState('Accepted commit failed.').toSerializable(),
                }),
          },
        }),
      );
    };
    if (outcome !== 'pending') queueMicrotask(reply);
  });
  return {
    counts,
    pending: (): number =>
      (s.client as unknown as { coordinator: GeometryCoordinator }).coordinator.pendingCount,
    reply: (): void => {
      reply();
    },
  };
}

it.each(['CONFIRMED', 'AUTOMATIC_IDENTIFIED', 'boundary'] as const)(
  'C2AK: preserves %s Preview through two real pre-dispatch throws, then accepts one retry',
  async (state) => {
    const s = setup();
    await recoveryPreview(
      s,
      state === 'AUTOMATIC_IDENTIFIED' ? state : 'CONFIRMED',
      state === 'boundary',
    );
    act(() => {
      s.result.current.updatePreview();
    });
    await frame();
    await frame();
    const before = s.result.current.preview;
    const discardedBefore = s.discard.mock.calls.length;
    const transport = await boundaryTransport(s, 2);
    for (let attempt = 1; attempt <= 2; attempt++) {
      act(() => {
        s.result.current.apply();
      });
      await frame();
      await frame();
      expect(transport.counts).toEqual({ attempted: attempt, accepted: 0, returned: 0 });
      expect(transport.pending()).toBe(0);
      expect(s.result.current.preview).toBe(before);
      expect(s.result.current.preview?.semanticQualification?.scopeConfirmation).toBe(
        before?.semanticQualification?.scopeConfirmation,
      );
      expect(s.result.current.failedSemanticApply).toBeUndefined();
      expect(s.result.current.phase).toBe(SplitPhase.Preview);
      expect(s.result.current.error).toBe('Apply was not submitted. Try again.');
      expect(s.discard.mock.calls.length).toBe(discardedBefore);
      expect(screen.getByTestId('split-apply')).toBeEnabled();
    }
    act(() => {
      s.result.current.apply();
    });
    await frame();
    await frame();
    expect(transport.counts).toEqual({ attempted: 3, accepted: 1, returned: 1 });
    expect(transport.pending()).toBe(0);
    expect(s.result.current.preview).toBeUndefined();
    expect(s.result.current.applied).toBeDefined();
    expect(s.result.current.failedSemanticApply).toBeUndefined();
    act(() => {
      s.result.current.undo();
    });
    await frame();
    await frame();
    expect(s.undo).toHaveBeenCalledTimes(1);
  },
);

it('C2AK: REQUIRED blocks the real commit transport and preserves the unconfirmed Preview', async () => {
  const s = setup();
  await recoveryPreview(s, 'REQUIRED');
  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  const before = s.result.current.preview;
  const transport = await boundaryTransport(s, 0);
  act(() => {
    s.result.current.apply();
  });
  await frame();
  expect(transport.counts).toEqual({ attempted: 0, accepted: 0, returned: 0 });
  expect(s.result.current.preview).toBe(before);
  expect(s.result.current.preview?.semanticQualification?.scopeConfirmation?.state).toBe(
    'REQUIRED',
  );
  expect(s.result.current.failedSemanticApply).toBeUndefined();
  expect(screen.getByTestId('split-apply')).toBeDisabled();
});

it.each([
  'reject',
  'adoption-refuse',
  'adoption-throw',
  'cleanup-reject',
  'cleanup-throw',
  'cancel-after-acceptance',
] as const)('C2AK: real accepted transport remains terminal for %s', async (kind) => {
  const s = setup();
  await recoveryPreview(s, 'CONFIRMED');
  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  const transport = await boundaryTransport(
    s,
    0,
    kind.startsWith('adoption')
      ? 'success'
      : kind === 'cancel-after-acceptance'
        ? 'pending'
        : 'reject',
  );
  if (kind === 'adoption-refuse') s.adopt.mockReturnValue(false);
  if (kind === 'adoption-throw')
    s.adopt.mockImplementation(() => {
      throw invalidState('Adoption failed.');
    });
  if (kind === 'cleanup-reject')
    s.discard.mockReturnValue({
      promise: Promise.reject(invalidState('Cleanup failed.')),
    } as ReturnType<GeometryClient['discardSplit']>);
  if (kind === 'cleanup-throw')
    s.discard.mockImplementation(() => {
      throw invalidState('Cleanup failed.');
    });
  act(() => {
    s.result.current.apply();
  });
  await frame();
  if (kind === 'cancel-after-acceptance') {
    act(() => {
      s.result.current.cancel();
    });
    await act(async () => {
      transport.reply();
      await Promise.resolve();
    });
  }
  await frame();
  expect(transport.counts).toEqual({ attempted: 1, accepted: 1, returned: 1 });
  expect(s.result.current.preview).toBeUndefined();
  expect(s.result.current.failedSemanticApply).toBeDefined();
  expect(s.result.current.phase).toBe(SplitPhase.Idle);
  expect(s.result.current.error).toContain(
    kind === 'adoption-refuse'
      ? 'model changed'
      : kind === 'adoption-throw'
        ? 'Adoption failed'
        : 'Accepted commit failed',
  );
  act(() => {
    s.result.current.apply();
  });
  await frame();
  expect(transport.counts.accepted).toBe(1);
  expect(s.discard).toHaveBeenCalled();
});

it('C2AK: a before-call paint rejection preserves authority without submitting or discarding', async () => {
  const s = setup();
  await recoveryPreview(s, 'CONFIRMED');
  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  const before = s.result.current.preview;
  const discardedBefore = s.discard.mock.calls.length;
  const transport = await boundaryTransport(s, 0);
  // A requestAnimationFrame exception in afterPaint's Promise executor rejects
  // before submission. Normal supported browser scheduling has no explicit rejection.
  paint.failure = invalidState('Paint could not be scheduled.');
  act(() => {
    s.result.current.apply();
  });
  await frame();
  paint.failure = undefined;
  expect(transport.counts).toEqual({ attempted: 0, accepted: 0, returned: 0 });
  expect(s.result.current.preview).toBe(before);
  expect(s.result.current.phase).toBe(SplitPhase.Preview);
  expect(s.result.current.error).toBe('Paint could not be scheduled.');
  expect(s.result.current.failedSemanticApply).toBeUndefined();
  expect(s.discard.mock.calls.length).toBe(discardedBefore);
});

it.each(['part', 'source', 'supersession'] as const)(
  'C2AK: independent %s invalidation still retires a pre-dispatch retryable Preview',
  async (kind) => {
    const s = setup();
    await recoveryPreview(s, 'CONFIRMED');
    act(() => {
      s.result.current.updatePreview();
    });
    await frame();
    await frame();
    const transport = await boundaryTransport(s, 1);
    act(() => {
      s.result.current.apply();
    });
    await frame();
    await frame();
    expect(s.result.current.preview).toBeDefined();
    act(() => {
      if (kind === 'part') s.store.selectPart('B');
      else if (kind === 'source') load(s.store, 'millimeter', [part('new-source')]);
      else s.result.current.discardPreview();
    });
    act(() => {
      s.result.current.apply();
    });
    await frame();
    expect(s.result.current.preview).toBeUndefined();
    expect(transport.counts.accepted).toBe(0);
    expect(s.result.current.failedSemanticApply).toBeUndefined();
  },
);

it('C2AK: Cancel while Applying retains the existing guarded queued-commit behavior', async () => {
  const s = setup();
  await recoveryPreview(s, 'CONFIRMED');
  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  const transport = await boundaryTransport(s, 0);
  act(() => {
    s.result.current.apply();
  });
  act(() => {
    s.result.current.cancel();
  });
  await frame();
  await frame();
  expect(transport.counts.accepted).toBe(1);
  expect(s.result.current.applied).toBeDefined();
  expect(s.result.current.failedSemanticApply).toBeUndefined();
});

it('C2AK: ordinary manual Preview remains retryable on a real synchronous transport failure', async () => {
  const s = setup();
  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  const before = s.result.current.preview;
  expect(before?.semanticQualification).toBeUndefined();
  const transport = await boundaryTransport(s, 1);
  act(() => {
    s.result.current.apply();
  });
  await frame();
  await frame();
  expect(transport.counts.accepted).toBe(0);
  expect(s.result.current.preview).toBe(before);
  expect(s.result.current.error).toBe('Apply was not submitted. Try again.');
  expect(s.result.current.failedSemanticApply).toBeUndefined();
  act(() => {
    s.result.current.apply();
  });
  await frame();
  await frame();
  expect(transport.counts.accepted).toBe(1);
  expect(s.result.current.applied).toBeDefined();
});

interface ConfirmationFixture extends TestSetup {
  readonly preview: SplitCreateResult;
  readonly physical: object;
  readonly receiptId: string;
  readonly issued: ReturnType<typeof ScopeAuthority.issueScopeReceipt>;
  readonly counts: {
    attempted: number;
    accepted: number;
    returned: number;
    workerConfirmed: number;
  };
  readonly coordinator: GeometryCoordinator;
  readonly worker: Worker;
  readonly setMode: (mode: 'success' | 'reject' | 'lost' | 'pending' | 'adoption-throw') => void;
  readonly finish: () => void;
  readonly stale: () => void;
  readonly confirm: () => Promise<void>;
  readonly release: () => void;
  readonly reconfirm: () => unknown;
}

/** No native geometry: actual receipt authority and actual client/coordinator over controlled transport. */
async function confirmationFixture(failures = 0): Promise<ConfirmationFixture> {
  const authority = await import('../workers/semantic-scope-authority');
  const s = setup();
  await recoveryPreview(s, 'REQUIRED');
  const op = s.create.getMockImplementation()?.({} as never, '', {} as never);
  if (!op) throw Error('Missing preview');
  const base = await op.promise;
  const physical = {};
  let current = true;
  const candidate = {
    documentId: 'doc-1',
    sourceRevision: 1,
    partId: 'A',
    generation: 1,
    candidateId: crypto.randomUUID(),
  } as SplitCreateResult['candidate'];
  const issued = authority.issueScopeReceipt({ ...base, candidate }, physical, {
    automatic: false,
    current: () => current,
  });
  const preview = { ...base, candidate, semanticQualification: issued.proof };
  const receiptId = issued.proof.scopeConfirmation?.receiptId;
  if (!receiptId) throw Error('Missing receipt');
  s.create.mockReturnValue({ ...op, promise: Promise.resolve(preview) });
  act(() => {
    s.result.current.updatePreview();
  });
  await frame();
  await frame();
  const worker = (s.client as unknown as { worker: Worker }).worker;
  const coordinator = (s.client as unknown as { coordinator: GeometryCoordinator }).coordinator;
  const counts = { attempted: 0, accepted: 0, returned: 0, workerConfirmed: 0 };
  let mode: 'success' | 'reject' | 'lost' | 'pending' | 'adoption-throw' = 'success';
  let finish = (): void => undefined;
  const confirm = s.client.confirmSplitScope.bind(s.client);
  vi.spyOn(s.client, 'confirmSplitScope').mockImplementation((...args) => {
    const handle = confirm(...args);
    counts.returned++;
    return handle;
  });
  s.discard.mockImplementation((handle) => {
    authority.cancelScopeReceipt(handle);
    return {
      id: createOperationId(),
      interruptible: true,
      cancel: vi.fn(),
      promise: Promise.resolve({ released: true }),
    };
  });
  vi.spyOn(worker, 'postMessage').mockImplementation((value: unknown) => {
    const message = value as { operation?: string; id: string; payload: { receiptId: string } };
    if (message.operation !== 'split/confirm-scope') return;
    counts.attempted++;
    if (failures-- > 0) throw invalidState('Confirmation was not submitted. Try again.');
    counts.accepted++;
    let result: Pick<SplitCreateResult, 'candidate' | 'semanticQualification'> | undefined;
    let error: ReturnType<typeof invalidState> | undefined;
    try {
      const confirmed = authority.confirmScopeReceipt(message.payload.receiptId, () => physical);
      counts.workerConfirmed++;
      result = { candidate: confirmed.candidate, semanticQualification: confirmed.proof };
      if (mode === 'adoption-throw')
        Object.defineProperty(result, 'semanticQualification', {
          enumerable: true,
          get: () => {
            throw invalidState('Confirmation adoption failed.');
          },
        });
    } catch (cause) {
      error = cause as ReturnType<typeof invalidState>;
    }
    finish = (): void => {
      if (mode === 'lost') {
        worker.dispatchEvent(new ErrorEvent('error', { message: 'Controlled Worker loss' }));
        return;
      }
      worker.dispatchEvent(
        new MessageEvent('message', {
          data: {
            channel: PROTOCOL_CHANNEL,
            id: message.id,
            ...(error || mode === 'reject'
              ? {
                  kind: 'error',
                  error: (error ?? invalidState('Accepted confirmation failed.')).toSerializable(),
                }
              : { kind: 'result', value: result }),
          },
        }),
      );
    };
    if (mode !== 'pending') queueMicrotask(finish);
  });
  return {
    ...s,
    preview,
    physical,
    receiptId,
    issued,
    counts,
    coordinator,
    worker,
    setMode: (next: typeof mode): void => {
      mode = next;
    },
    finish: (): void => {
      finish();
    },
    stale: (): void => {
      current = false;
    },
    confirm: async (): Promise<void> => {
      act(() => {
        s.result.current.confirmScope?.();
      });
      await frame();
    },
    release: authority.releaseScopeReceipt,
    reconfirm: (): unknown => authority.confirmScopeReceipt(receiptId, () => physical),
  };
}
function expectConfirmationResources(f: Awaited<ReturnType<typeof confirmationFixture>>): void {
  expect(f.coordinator.pendingCount).toBe(0);
  expect(f.coordinator.liveCancellationSignals).toBe(0);
}
function expectRetryableConfirmation(f: Awaited<ReturnType<typeof confirmationFixture>>): void {
  expect(f.result.current.phase).toBe(SplitPhase.Preview);
  expect(f.result.current.preview).toBe(f.preview);
  expect(f.result.current.preview?.semanticQualification?.scopeConfirmation?.state).toBe(
    'REQUIRED',
  );
  expect(f.result.current.error).toBe('Confirmation was not submitted. Try again.');
  expect(f.result.current.errorIsOperationFailure).toBe(true);
  expectConfirmationResources(f);
}
it('C2AO: unsubmitted confirmation preserves the exact Preview and retries once through real dispatch', async () => {
  const f = await confirmationFixture(1);
  await f.confirm();
  expectRetryableConfirmation(f);
  expect(f.counts).toEqual({ attempted: 1, accepted: 0, returned: 0, workerConfirmed: 0 });
  await f.confirm();
  expect(f.counts).toEqual({ attempted: 2, accepted: 1, returned: 1, workerConfirmed: 1 });
  expect(f.result.current.preview?.candidate).toBe(f.preview.candidate);
  expect(f.result.current.preview?.render).toBe(f.preview.render);
  expect(f.result.current.preview?.semanticQualification?.scopeConfirmation?.state).toBe(
    'CONFIRMED',
  );
  expect(f.result.current.phase).toBe(SplitPhase.Preview);
  expect(f.result.current.error).toBeUndefined();
  expect(f.create).toHaveBeenCalledTimes(1);
  expectConfirmationResources(f);
  f.release();
});
it('C2AO: 50 unsubmitted confirmations leave no orphan operations even on later Worker loss', async () => {
  const f = await confirmationFixture(50);
  for (let i = 1; i <= 50; i++) {
    await f.confirm();
    expectRetryableConfirmation(f);
    expect(f.counts).toEqual({ attempted: i, accepted: 0, returned: 0, workerConfirmed: 0 });
  }
  f.worker.dispatchEvent(new ErrorEvent('error', { message: 'Controlled Worker loss' }));
  await frame();
  expectConfirmationResources(f);
  f.release();
});
it('C2AO: two unsubmitted confirmations then success accept exactly one operation', async () => {
  const f = await confirmationFixture(2);
  await f.confirm();
  expectRetryableConfirmation(f);
  await f.confirm();
  expectRetryableConfirmation(f);
  await f.confirm();
  expect(f.counts).toEqual({ attempted: 3, accepted: 1, returned: 1, workerConfirmed: 1 });
  expect(f.result.current.preview?.semanticQualification?.scopeConfirmation?.state).toBe(
    'CONFIRMED',
  );
  expectConfirmationResources(f);
  f.release();
});
it.each(['success', 'reject', 'lost', 'adoption-throw'] as const)(
  'C2AO: accepted confirmation %s clears ownership and follows the one-use receipt contract',
  async (mode) => {
    const f = await confirmationFixture();
    f.setMode(mode);
    await f.confirm();
    expect(f.counts).toEqual({ attempted: 1, accepted: 1, returned: 1, workerConfirmed: 1 });
    expect(f.result.current.phase).toBe(mode === 'success' ? SplitPhase.Preview : SplitPhase.Idle);
    if (mode === 'success') {
      expect(f.result.current.preview?.semanticQualification?.scopeConfirmation?.state).toBe(
        'CONFIRMED',
      );
      expect(f.result.current.preview?.render).toBe(f.preview.render);
      expect(() => f.reconfirm()).toThrow();
    } else {
      expect(f.result.current.preview).toBeUndefined();
      expect(f.result.current.failedSemanticApply).toBe(f.preview.semanticQualification);
      expect(f.result.current.error).toBeTruthy();
      expect(f.discard).toHaveBeenCalledWith(f.preview.candidate);
      await f.confirm();
      expect(f.counts.accepted).toBe(1);
    }
    expectConfirmationResources(f);
    f.release();
  },
);
it('C2AO: concurrent confirmation clicks submit once; later discard does not cancel a completed handle', async () => {
  const f = await confirmationFixture();
  f.setMode('pending');
  act(() => {
    f.result.current.confirmScope?.();
    f.result.current.confirmScope?.();
  });
  expect(f.counts.accepted).toBe(1);
  expect(f.coordinator.pendingCount).toBe(1);
  expect(f.result.current.phase).toBe(SplitPhase.Computing);
  await act(async () => {
    f.finish();
    await Promise.resolve();
  });
  await frame();
  const post = vi.spyOn(f.worker, 'postMessage');
  post.mockClear();
  act(() => {
    f.result.current.discardPreview();
  });
  // A completed confirmation's running handle must have been cleared.
  expect(post.mock.calls.some(([v]) => (v as { kind?: string }).kind === 'cancel')).toBe(false);
  expectConfirmationResources(f);
  f.release();
});
it.each(['cancel', 'discard', 'unmount', 'source', 'part', 'supersession'] as const)(
  'C2AO: in-flight confirmation retired by %s cannot resurrect on late success',
  async (kind) => {
    const f = await confirmationFixture();
    f.setMode('pending');
    act(() => {
      f.result.current.confirmScope?.();
    });
    expect(f.counts.workerConfirmed).toBe(1);
    act(() => {
      if (kind === 'cancel') f.result.current.cancel();
      else if (kind === 'unmount') f.unmount();
      else if (kind === 'source') load(f.store, 'millimeter', [part('new-source')]);
      else if (kind === 'part') f.store.selectPart('B');
      else f.result.current.discardPreview();
    });
    await act(async () => {
      f.finish();
      await Promise.resolve();
    });
    await frame();
    if (kind !== 'unmount') {
      expect(f.result.current.preview).toBeUndefined();
      expect(f.result.current.phase).not.toBe(SplitPhase.Computing);
    }
    expectConfirmationResources(f);
    f.release();
  },
);
it.each([
  'cancel',
  'expiry',
  'supersession',
  'source',
  'part',
  'worker-restart',
  'source-binding',
  'preparation-binding',
] as const)('C2AO: failed confirmation does not override %s invalidation', async (kind) => {
  const f = await confirmationFixture(1);
  await f.confirm();
  expectRetryableConfirmation(f);
  if (kind === 'expiry') {
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now + 240_001);
    await f.confirm();
    clock.mockRestore();
  } else if (kind === 'source-binding' || kind === 'preparation-binding') {
    f.stale();
    await f.confirm();
  } else if (kind === 'worker-restart') {
    // A replacement Worker has no module-local receipt from its predecessor.
    f.release();
    await f.confirm();
  } else {
    act(() => {
      if (kind === 'cancel') f.result.current.cancel();
      else if (kind === 'source') load(f.store, 'millimeter', [part('new-source')]);
      else if (kind === 'part') f.store.selectPart('B');
      else f.result.current.discardPreview();
    });
    await f.confirm();
  }
  expect(f.counts.workerConfirmed).toBe(0);
  expect(f.result.current.preview).toBeUndefined();
  expect(f.result.current.phase).not.toBe(SplitPhase.Computing);
  expectConfirmationResources(f);
  f.release();
});

it.each(['throw', 'reject'] as const)(
  'C2AO: ambiguous confirmation preserves original error if release %s',
  async (kind) => {
    const f = await confirmationFixture();
    f.setMode('reject');
    f.discard.mockImplementation(() => {
      if (kind === 'throw') throw invalidState('Release failed.');
      return {
        id: createOperationId(),
        interruptible: true,
        cancel: vi.fn(),
        promise: Promise.reject(invalidState('Release failed.')),
      };
    });
    await f.confirm();
    expect(f.result.current.preview).toBeUndefined();
    expect(f.result.current.error).toBe('Accepted confirmation failed.');
    expect(f.result.current.phase).toBe(SplitPhase.Idle);
    expectConfirmationResources(f);
    f.release();
  },
);
it('C2AO: old confirmation completion cannot overwrite a newer physical Preview', async () => {
  const f = await confirmationFixture();
  f.setMode('pending');
  act(() => {
    f.result.current.confirmScope?.();
  });
  act(() => {
    f.result.current.discardPreview();
  });
  const next = { ...f.preview, candidate: { ...f.preview.candidate, candidateId: 'new-ticket' } };
  f.create.mockReturnValue({
    id: createOperationId(),
    interruptible: true,
    cancel: vi.fn(),
    promise: Promise.resolve(next),
  });
  act(() => {
    f.result.current.updatePreview();
  });
  await frame();
  await frame();
  expect(f.result.current.preview).toBe(next);
  await act(async () => {
    f.finish();
    await Promise.resolve();
  });
  await frame();
  expect(f.result.current.preview).toBe(next);
  expect(f.result.current.preview?.semanticQualification?.scopeConfirmation?.state).toBe(
    'REQUIRED',
  );
  expectConfirmationResources(f);
  f.release();
});
it('C2AO: late confirmation rejection after reset cannot resurrect its error or Preview', async () => {
  const f = await confirmationFixture();
  f.setMode('pending');
  act(() => {
    f.result.current.confirmScope?.();
  });
  act(() => {
    f.result.current.discardPreview();
  });
  f.setMode('reject');
  await act(async () => {
    f.finish();
    await Promise.resolve();
  });
  await frame();
  expect(f.result.current.preview).toBeUndefined();
  expect(f.result.current.error).toBeUndefined();
  expect(f.result.current.phase).toBe(SplitPhase.Idle);
  expectConfirmationResources(f);
  f.release();
});
