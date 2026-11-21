import { useCallback, useRef } from 'react';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import { exportStlFile, type ExportSession } from '../runtime/export-service';
import { useGeometryClient } from '../runtime/client-context';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { ExportState, StatusSeverity, type ExportToken } from './workspace-store';

/**
 * Binds the export service to the workspace store.
 *
 * The component calls `exportModel` and renders state. It does not dispatch the
 * worker operation, derive filenames, or trigger downloads — all of that moved
 * out of `ModelPanel` and into `runtime/export-service`.
 */

export interface ModelExportControls {
  readonly exportModel: (encoding: 'binary' | 'ascii') => void;
  readonly cancelExport: () => void;
  readonly isExporting: boolean;
  readonly fraction: number;
  readonly encoding: string | undefined;
}

export function useModelExport(): ModelExportControls {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { model, activePartId, exportProgress } = useWorkspaceState();
  const sessionRef = useRef<ExportSession | undefined>(undefined);

  const exportModel = useCallback(
    (encoding: 'binary' | 'ascii'): void => {
      if (model === undefined) return;
      if (client === undefined) {
        store.pushStatus(StatusSeverity.Error, 'The geometry worker is not ready yet.');
        return;
      }
      /*
       * EXPORT IS PART-TARGETED, because STL holds one object and has no way to
       * say otherwise. The selected part is written; the worker returns a
       * warning naming what a multi-part document left out, and the panel shows
       * it. Nothing is flattened and nothing is lost silently.
       */
      if (activePartId === undefined || !model.parts.some((part) => part.partId === activePartId)) {
        // Never a silent no-op, and never a request for a part this document does not hold.
        store.pushStatus(
          StatusSeverity.Error,
          'Export failed: there is no selected part to export.',
        );
        return;
      }

      sessionRef.current?.cancel();
      const token: ExportToken = store.beginExport(encoding);

      const session = exportStlFile({
        handle: model.handle,
        partId: activePartId,
        sourceFileName: model.source.fileName,
        encoding,
        client,
        onProgress: (progress) => {
          // Token-gated, so a superseded export cannot drive the bar that now
          // belongs to a different one.
          store.reportExportProgress(token, progress.fraction, encoding);
        },
      });
      sessionRef.current = session;

      session.promise.then(
        (outcome) => {
          if (!store.finishExport(token)) return;
          sessionRef.current = undefined;

          store.pushStatus(
            StatusSeverity.Success,
            `Exported ${outcome.fileName} (${outcome.encoding} STL, ${formatBytes(outcome.byteLength)}).`,
          );
          // Metadata that the chosen encoding could not carry is surfaced, not
          // swallowed — binary STL genuinely cannot hold multiple solids.
          for (const warning of outcome.warnings) {
            store.pushStatus(StatusSeverity.Warning, warning.message);
          }
        },
        (cause: unknown) => {
          if (!store.finishExport(token)) return;
          sessionRef.current = undefined;

          const error = toAppError(cause);
          if (error.code === AppErrorCode.OperationCancelled) {
            store.pushStatus(StatusSeverity.Info, 'Export cancelled. No file was saved.');
          } else {
            store.pushStatus(StatusSeverity.Error, `Export failed: ${error.message}`);
          }
        },
      );
    },
    [activePartId, client, model, store],
  );

  const cancelExport = useCallback((): void => {
    sessionRef.current?.cancel();
  }, []);

  return {
    exportModel,
    cancelExport,
    isExporting: exportProgress.state === ExportState.Working,
    fraction: exportProgress.fraction,
    encoding: exportProgress.encoding,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
