import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createOperationId, resourceLimitExceeded } from '@cadfixer/shared';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  DocumentHandle,
  DocumentRenderSnapshot,
  PartDescriptor,
  TextureSelectResult,
} from '@cadfixer/geometry-runtime';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from './store-context';
import { WorkspaceStore } from './workspace-store';
import { WorkflowId } from './workflows';
import type { LoadedModel } from './model';
import { useTextureWorkflow } from './use-texture-workflow';

afterEach(cleanup);

const PART: PartDescriptor = {
  partId: 'p1',
  name: 'Plate',
  transform: IDENTITY_PART_TRANSFORM,
  triangleCount: 12,
  vertexCount: 8,
  bounds: {
    min: [0, 0, 0],
    max: [40, 20, 10],
    size: [40, 20, 10],
    center: [20, 10, 5],
    radius: 25,
  },
  meshResourceIndex: 0,
  groupCount: 0,
  groupMaterialRefCount: 0,
  hasNormals: false,
  hasUvs: false,
};

function load(store: WorkspaceStore, unit: string | undefined): void {
  const handle = { documentId: 'doc-1', revision: 1 } as DocumentHandle;
  const render: DocumentRenderSnapshot = {
    parts: [
      {
        partId: PART.partId,
        transform: PART.transform,
        positions: new Float32Array(9),
        normals: new Float32Array(9),
        vertexCount: 3,
      },
    ],
  };
  const model: Omit<LoadedModel, 'revision'> = {
    handle,
    parts: [PART],
    render,
    source: {
      fileName: 'plate.3mf',
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
  store.commitImport(store.beginImport(model.source.fileName), model);
  store.selectWorkflow(WorkflowId.Texture);
}

interface Pending {
  readonly resolve: (value: TextureSelectResult) => void;
  readonly reject: (reason: unknown) => void;
}

/** A hook on a loaded millimetre model whose one selection stays pending until the test settles it. */
function setup(unit: string | undefined = 'millimeter'): {
  readonly result: { current: ReturnType<typeof useTextureWorkflow> };
  readonly store: WorkspaceStore;
  readonly pending: Pending;
  readonly cancel: ReturnType<typeof vi.fn>;
} {
  const store = new WorkspaceStore();
  load(store, unit);
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  let pending: Pending | undefined;
  const cancel = vi.fn();
  vi.spyOn(client, 'selectTextureSurface').mockImplementation(() => ({
    id: createOperationId(),
    interruptible: true,
    cancel,
    promise: new Promise<TextureSelectResult>((resolve, reject) => {
      pending = { resolve, reject };
    }),
  }));
  const hook = renderHook(() => useTextureWorkflow(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceProvider store={store}>
        <GeometryClientProvider client={client}>{children}</GeometryClientProvider>
      </WorkspaceProvider>
    ),
  });
  return {
    ...hook,
    store,
    cancel,
    get pending(): Pending {
      if (pending === undefined) throw new Error('No selection was requested.');
      return pending;
    },
  };
}

const HIT = {
  partId: 'p1',
  triangleIndex: 3,
  point: [1, 1, 10],
  normal: [0, 0, 1],
} as const;

describe('TEXTURE-FIX-01 D2: a selection reports its progress and its refusal', () => {
  it('says a selection is running while the worker answers', () => {
    const s = setup();
    expect(s.result.current.selecting).toBe(false);
    act(() => {
      s.result.current.pick(HIT);
    });
    expect(s.result.current.selecting).toBe(true);
  });

  it('says so when the model states no unit and one is read for it', () => {
    // The unit is part of the session. A reading chosen by the person must not hide the answer.
    const s = setup(undefined);
    act(() => {
      s.store.setUnitInterpretation('millimeter');
    });
    act(() => {
      s.result.current.pick(HIT);
    });
    expect(s.result.current.selecting).toBe(true);
  });

  it('shows the refusal, and stops saying it is selecting', async () => {
    const s = setup();
    act(() => {
      s.result.current.pick(HIT);
    });
    await act(async () => {
      s.pending.reject(new Error('That surface could not be selected for a stated reason.'));
      await Promise.resolve();
    });
    expect(s.result.current.selecting).toBe(false);
    expect(s.result.current.error).toBe('That surface could not be selected for a stated reason.');
    expect(s.result.current.selection).toBeUndefined();
  });

  it('keeps the selection from a successful pick, and no error', async () => {
    const s = setup();
    act(() => {
      s.result.current.pick(HIT);
    });
    await act(async () => {
      s.pending.resolve({
        source: { documentId: 'doc-1', revision: 1 },
        partId: 'p1',
        triangleIds: [3, 4],
        area: 800,
        partArea: 4400,
        planarity: { kind: 'PLANAR' },
      } as unknown as TextureSelectResult);
      await Promise.resolve();
    });
    expect(s.result.current.selecting).toBe(false);
    expect(s.result.current.error).toBeUndefined();
    expect(s.result.current.selection?.triangleIds).toEqual([3, 4]);
  });

  it('a refusal for a typed limit is shown too', async () => {
    const s = setup();
    act(() => {
      s.result.current.pick(HIT);
    });
    await act(async () => {
      s.pending.reject(resourceLimitExceeded('Too large.', { metric: 'x', limit: 1 }));
      await Promise.resolve();
    });
    expect(s.result.current.error).toBeDefined();
  });
});
