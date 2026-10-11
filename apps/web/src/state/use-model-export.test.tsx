import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import type { DocumentId, PartDescriptor } from '@cadfixer/geometry-runtime';
import { GeometryClientProvider } from '../runtime/client-context';
import type { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from './store-context';
import { StatusSeverity, WorkspaceStore } from './workspace-store';
import { useModelExport } from './use-model-export';
import type { LoadedModel } from './model';

/**
 * EXPORT NEVER FAILS SILENTLY (RC2.1). If there is no selected part that the document holds, the
 * request is not sent to the worker with a name it cannot resolve, and the person is told.
 */

function store(parts: readonly PartDescriptor[]): WorkspaceStore {
  const s = new WorkspaceStore();
  const model: Omit<LoadedModel, 'revision'> = {
    handle: { documentId: 'doc-1' as DocumentId, revision: 1 },
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
  s.commitImport(s.beginImport('cube.stl'), model);
  return s;
}

function mount(s: WorkspaceStore): { exportModel: Mock; run: () => void } {
  const exportModel = vi.fn();
  const client = { exportModel } as unknown as GeometryClient;
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <WorkspaceProvider store={s}>
      <GeometryClientProvider client={client}>{children}</GeometryClientProvider>
    </WorkspaceProvider>
  );
  const { result } = renderHook(() => useModelExport(), { wrapper });
  return {
    exportModel,
    run: (): void => {
      act(() => {
        result.current.exportModel('binary');
      });
    },
  };
}

describe('Export active part', () => {
  it('says so, and sends nothing to the worker, when the document has no part to export', () => {
    const s = store([]);
    const m = mount(s);
    m.run();
    expect(m.exportModel).not.toHaveBeenCalled();
    const latest = s.getSnapshot().status[0];
    expect(latest?.severity).toBe(StatusSeverity.Error);
    expect(latest?.message).toMatch(/no selected part to export/i);
  });
});
