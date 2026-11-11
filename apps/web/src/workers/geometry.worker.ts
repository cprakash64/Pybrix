import {
  createSelfTestHandler,
  GeometryWorkerHost,
  toTransferables,
  type MessageEndpoint,
} from '@cadfixer/geometry-runtime';
import {
  modelAnalyzeHandler,
  modelExportHandler,
  modelImportHandler,
  modelReleaseHandler,
} from './stl-handlers';
import { modelSendForDiagnosticHandler } from './self-intersection-handlers';
import {
  holeFillDiscardHandler,
  holeFillListLoopsHandler,
  holeFillSendForFillHandler,
} from './hole-fill-handlers';
import {
  holeFillBoundaryPreviewHandler,
  holeFillCommitHandler,
  holeFillPatchPreviewHandler,
} from './hole-fill-workflow-handlers';
import { documentSendForExportHandler } from './export-handlers';
import {
  editPreviewHandler,
  editCommitHandler,
  editDiscardHandler,
} from './geometry-edit-handlers';
import {
  autoSplitComponentFacesHandler,
  autoSplitExtractCreateHandler,
  autoSplitReleaseHandler,
  autoSplitRenderHandler,
  autoSplitSuggestHandler,
} from './auto-split-handlers';
import {
  splitCommitHandler,
  splitCommitStatusHandler,
  splitCommitReleaseHandler,
  splitCommitAckHandler,
  splitCommitAbortHandler,
  splitCreateHandler,
  splitDiscardHandler,
  splitConfirmScopeHandler,
} from './split-handlers';
import {
  textureCreateHandler,
  textureLayoutHandler,
  textureSelectHandler,
} from './texture-handlers';
import {
  repairCommitHandler,
  repairCreateCandidateHandler,
  repairDiscardHandler,
  repairPlanHandler,
  repairUndoHandler,
} from './repair-handlers';

/**
 * The geometry worker entry point.
 *
 * This is the ONLY place in the worker that touches worker globals. All
 * coordination logic lives in `@cadfixer/geometry-runtime`, which is
 * platform-free and unit-tested outside a browser.
 *
 * Stage 0 registers a single diagnostic handler. Format codecs and geometry
 * operations will register here as they are implemented.
 */

// `self` is already typed as DedicatedWorkerGlobalScope under the WebWorker lib
// that this directory's tsconfig selects. Aliasing it keeps the intent explicit.
const workerScope: DedicatedWorkerGlobalScope = self;

const endpoint: MessageEndpoint = {
  postMessage(message, transfer) {
    workerScope.postMessage(message, toTransferables(transfer));
  },
  addMessageListener(listener) {
    const handler = (event: MessageEvent): void => {
      listener(event.data);
    };
    workerScope.addEventListener('message', handler);
    return () => {
      workerScope.removeEventListener('message', handler);
    };
  },
};

const host = new GeometryWorkerHost(endpoint);

host.register('model/import', modelImportHandler);
host.register('model/export', modelExportHandler);
host.register('model/release', modelReleaseHandler);
host.register('model/analyze', modelAnalyzeHandler);
host.register('model/send-for-diagnostic', modelSendForDiagnosticHandler);
host.register('holefill/list-loops', holeFillListLoopsHandler);
host.register('holefill/send-for-fill', holeFillSendForFillHandler);
host.register('holefill/discard', holeFillDiscardHandler);
// The Stage 4B-1B2 workflow: two disposable render snapshots and ONE mutation.
// Nothing here re-triangulates; `holefill/commit` applies the stored candidate.
host.register('holefill/boundary-preview', holeFillBoundaryPreviewHandler);
host.register('holefill/patch-preview', holeFillPatchPreviewHandler);
host.register('holefill/commit', holeFillCommitHandler);
host.register('document/send-for-export', documentSendForExportHandler);
host.register('edit/preview', editPreviewHandler);
host.register('edit/commit', editCommitHandler);
host.register('edit/discard', editDiscardHandler);
host.register('split/create', splitCreateHandler);
host.register('split/confirm-scope', splitConfirmScopeHandler);
host.register('split/commit', splitCommitHandler);
host.register('split/commit-status', splitCommitStatusHandler);
host.register('split/commit-release', splitCommitReleaseHandler);
host.register('split/commit-ack', splitCommitAckHandler);
host.register('split/commit-abort', splitCommitAbortHandler);
host.register('split/discard', splitDiscardHandler);
// Auto Split, local half: two reads and one CANDIDATE. None of them commits; Apply is `split/commit`.
host.register('autosplit/release', autoSplitReleaseHandler);
host.register('autosplit/render', autoSplitRenderHandler);
host.register('autosplit/suggest', autoSplitSuggestHandler);
host.register('autosplit/component-faces', autoSplitComponentFacesHandler);
host.register('autosplit/extract-create', autoSplitExtractCreateHandler);
host.register('texture/create', textureCreateHandler);
host.register('texture/select', textureSelectHandler);
host.register('texture/layout', textureLayoutHandler);

// Conservative repair. Five operations so planning, preview, apply and undo
// stay separate acts; see apps/web/src/workers/repair-handlers.ts. No geometry
// kernel is involved.
host.register('repair/plan', repairPlanHandler);
host.register('repair/create-candidate', repairCreateCandidateHandler);
host.register('repair/commit', repairCommitHandler);
host.register('repair/discard', repairDiscardHandler);
host.register('repair/undo', repairUndoHandler);

host.register(
  'runtime/self-test',
  createSelfTestHandler({
    // A macrotask, not a microtask: only a macrotask boundary lets the worker's
    // message queue deliver a pending `cancel` between chunks.
    yieldToEventLoop: () =>
      new Promise<void>((resolve) => {
        workerScope.setTimeout(resolve, 0);
      }),
  }),
);

host.start();
