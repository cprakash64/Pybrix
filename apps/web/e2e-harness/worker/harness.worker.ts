import {
  createSelfTestHandler,
  GeometryWorkerHost,
  toTransferables,
  type MessageEndpoint,
  type OperationHandler,
} from '@cadfixer/geometry-runtime';
import {
  adoptSharedCancellation,
  CancellationSource,
  combineCancellation,
  isAppError,
  malformedFile,
  throwIfCancelled,
} from '@cadfixer/shared';
import {
  createThreeMfReader,
  DEFAULT_ZIP_LIMITS,
  EMPTY_COMPATIBILITY,
  ThreeMfIngestion,
} from '@cadfixer/file-formats';
import {
  assertGeometryDocument,
  createIndexArray,
  createPositionArray,
  distinctMeshes,
  partId,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import {
  commitImportedDocument,
  createModelImportHandler,
  PRODUCTION_IMPORT_CONFIG,
  type ModelImportConfig,
  modelAnalyzeHandler,
  modelExportHandler,
  modelReleaseHandler,
  residentDocuments,
  geometryEdits,
  booleanOperations,
  buildRenderSnapshot,
} from '../../src/workers/stl-handlers';
import { runValidatedBoolean, type BooleanKind } from '@cadfixer/geometry-runtime';
import { modelSendForDiagnosticHandler } from '../../src/workers/self-intersection-handlers';
import {
  holeFillDiscardHandler,
  holeFillListLoopsHandler,
  holeFillSendForFillHandler,
} from '../../src/workers/hole-fill-handlers';
import {
  holeFillBoundaryPreviewHandler,
  holeFillCommitHandler,
  holeFillPatchPreviewHandler,
} from '../../src/workers/hole-fill-workflow-handlers';
import { documentSendForExportHandler } from '../../src/workers/export-handlers';
import {
  editPreviewHandler,
  editCommitHandler,
  editDiscardHandler,
} from '../../src/workers/geometry-edit-handlers';
import {
  splitCommitHandler,
  splitCommitStatusHandler,
  splitCommitReleaseHandler,
  splitCommitAckHandler,
  splitCommitAbortHandler,
  splitCreateHandler,
  splitDiscardHandler,
  setSplitQualificationObserver,
} from '../../src/workers/split-handlers';
import {
  jointCommitHandler,
  jointDiscardHandler,
  jointListHandler,
  jointProposeHandler,
} from '../../src/workers/joint-handlers';
import {
  setTextureQualificationObserver,
  textureCreateHandler,
  textureLayoutHandler,
  textureSelectHandler,
} from '../../src/workers/texture-handlers';
import {
  repairCommitHandler,
  repairCreateCandidateHandler,
  repairDiscardHandler,
  repairPlanHandler,
  repairUndoHandler,
} from '../../src/workers/repair-handlers';
import { buildHarnessDocument, isHarnessFixtureId } from '../fixtures';

/**
 * THE END-TO-END HARNESS WORKER. Never shipped.
 *
 * It is the production geometry worker with ONE handler swapped: `model/import`
 * builds a synthetic multi-part document instead of parsing STL. Every other
 * operation — analysis, self-intersection, all five repair operations, export,
 * release — is the production handler, imported directly, unmodified.
 *
 * WHY SWAP IMPORT RATHER THAN ADD AN OPERATION. Adding a synthetic-document
 * operation to the production `OperationMap` would put a permanent route into
 * authoritative geometry in the shipped protocol, registered or not. Swapping a
 * handler in a worker entry that no production module imports puts it nowhere at
 * all: `apps/web/src/workers/geometry.worker.ts` still registers the real STL
 * importer, and the production build never reaches this file.
 *
 * WHAT THE PAYLOAD CARRIES, precisely. A fixture IDENTIFIER — the ASCII text
 * `two-independent-parts`, and nothing else. Not geometry, not coordinates, not
 * a serialisation format. There is no encoder, no schema and no reader for
 * anything else, and the production importer would refuse the same bytes as a
 * malformed STL. This is a switch, not a file format.
 */

const workerScope: DedicatedWorkerGlobalScope = self;

// Test-only terminal-delivery faults; never included in the production worker.
let splitTransactionFault: string | undefined;
const splitTransactionOperations = new Map<string, string>();
workerScope.addEventListener('message', (event: MessageEvent): void => {
  const data = event.data as { kind?: string; operation?: string };
  if (data.kind === 'harness/split-transaction-fault') splitTransactionFault = data.operation;
});
const endpoint: MessageEndpoint = {
  postMessage(message, transfer) {
    const m = message as { kind?: string; id?: string };
    const operation = m.id ? splitTransactionOperations.get(m.id) : undefined;
    if (m.kind === 'result' || m.kind === 'error') splitTransactionOperations.delete(m.id ?? '');
    if (m.kind === 'result' && operation && `${operation}-drop` === splitTransactionFault) {
      splitTransactionFault = undefined;
      return;
    }
    if (m.kind === 'result' && operation && operation === splitTransactionFault) {
      splitTransactionFault = undefined;
      throw Error('Injected split terminal delivery throw in real harness worker');
    }
    workerScope.postMessage(message, toTransferables(transfer));
  },
  addMessageListener(listener) {
    const handler = (event: MessageEvent): void => {
      const m = event.data as { id?: string; operation?: string };
      if (m.id && (m.operation === 'split/commit' || m.operation === 'split/commit-ack'))
        splitTransactionOperations.set(m.id, m.operation);
      listener(event.data);
    };
    workerScope.addEventListener('message', handler);
    return () => {
      workerScope.removeEventListener('message', handler);
    };
  },
};

/**
 * Builds the named fixture and commits it through the PRODUCTION transaction.
 *
 * `commitImportedDocument` is the same function the STL importer calls: the
 * document gate, the session memory budget, the render snapshot, the part
 * descriptors and the resident commit are all production code. Nothing about
 * how a document becomes authoritative is reimplemented here — if it were, this
 * harness would be evidence about the harness.
 */
/**
 * THE REAL IMPORT PIPELINE, WITH A HARNESS-CHOSEN 3MF READER — Stage 6E-A2.
 *
 * A file that is not a fixture id goes through `createModelImportHandler`, the
 * production handler's own factory: identification, the mesh gate, the document
 * gate, the resource gate, the render snapshot and the resident commit are all
 * production code. What the harness may choose — and only through the
 * `harness/ingestion` message below, which is outside the protocol — is the 3MF
 * reader: buffered or streamed ingestion, and for the memory previews a wider
 * per-entry ceiling than the product's. None of that exists in the shipped
 * worker, which registers `modelImportHandler` built from
 * `PRODUCTION_IMPORT_CONFIG`; a boundary test holds that line.
 */
let realImport: OperationHandler<'model/import'> =
  createModelImportHandler(PRODUCTION_IMPORT_CONFIG);

/** The longest fixture id is a few dozen characters; a real file is not one. */
const FIXTURE_ID_MAX_BYTES = 128;
const FIXTURE_ID_SHAPE = /^[a-z0-9-]+$/;

const harnessImportHandler: OperationHandler<'model/import'> = (payload, context) => {
  const source = payload.bytes;
  if (!(source instanceof ArrayBuffer)) {
    throw malformedFile('The harness import payload did not contain a transferable buffer.');
  }

  const requested =
    source.byteLength <= FIXTURE_ID_MAX_BYTES
      ? new TextDecoder().decode(new Uint8Array(source)).trim()
      : '';
  if (!FIXTURE_ID_SHAPE.test(requested)) return realImport(payload, context);
  if (!isHarnessFixtureId(requested)) {
    // Refused with a reason, exactly as an unrecognised file would be. A harness
    // that silently substituted a default fixture would let a typo in a spec
    // pass as evidence about a document nobody asked for.
    throw malformedFile(`Unknown harness fixture: ${requested}`, { requested });
  }

  const document = buildHarnessDocument(requested);

  /*
   * THE MESH GATE, which `commitImportedDocument` deliberately does not repeat.
   * The STL path validates meshes while parsing; a synthetic document has no
   * parser, so it validates them here. Skipping it would make the harness able
   * to commit geometry the product would refuse.
   */
  assertGeometryDocument(document, `harness fixture ${requested}`, { validateMeshes: true });

  context.reportProgress(0.5, 'building fixture');

  return Promise.resolve(
    commitImportedDocument(
      {
        document,
        operation: `harness fixture ${requested}`,
        // Honest: nothing was decoded, so no format was identified and no
        // encoding was detected.
        formatId: 'harness',
        encoding: 'synthetic',
        // The fixture id is all that crossed; the geometry was built in here.
        warnings: [],
        compatibility: EMPTY_COMPATIBILITY,
      },
      context,
    ),
  );
};

const host = new GeometryWorkerHost(endpoint);

host.register('model/import', harnessImportHandler);
host.register('model/export', modelExportHandler);
host.register('model/release', modelReleaseHandler);
host.register('model/analyze', modelAnalyzeHandler);
host.register('model/send-for-diagnostic', modelSendForDiagnosticHandler);
host.register('holefill/list-loops', holeFillListLoopsHandler);
host.register('holefill/send-for-fill', holeFillSendForFillHandler);
host.register('holefill/discard', holeFillDiscardHandler);
host.register('holefill/boundary-preview', holeFillBoundaryPreviewHandler);
host.register('holefill/patch-preview', holeFillPatchPreviewHandler);
host.register('holefill/commit', holeFillCommitHandler);
host.register('document/send-for-export', documentSendForExportHandler);
host.register('edit/preview', editPreviewHandler);
host.register('edit/commit', editCommitHandler);
host.register('edit/discard', editDiscardHandler);
host.register('split/create', splitCreateHandler);
host.register('split/commit', splitCommitHandler);
host.register('split/commit-status', splitCommitStatusHandler);
host.register('split/commit-release', splitCommitReleaseHandler);
host.register('split/commit-ack', splitCommitAckHandler);
host.register('split/commit-abort', splitCommitAbortHandler);
host.register('split/discard', splitDiscardHandler);
// Editing the connectors of an existing joint (Stage EC-3): the production handlers, unchanged.
host.register('joint/list', jointListHandler);
host.register('joint/propose', jointProposeHandler);
host.register('joint/commit', jointCommitHandler);
host.register('joint/discard', jointDiscardHandler);
host.register('texture/create', textureCreateHandler);
host.register('texture/select', textureSelectHandler);
host.register('texture/layout', textureLayoutHandler);
setSplitQualificationObserver((detail) => {
  workerScope.postMessage({ kind: 'harness/split-qualification', ...detail });
});
setTextureQualificationObserver((detail) => {
  workerScope.postMessage({ kind: 'harness/split-qualification', ...detail });
});

host.register('repair/plan', repairPlanHandler);
host.register('repair/create-candidate', repairCreateCandidateHandler);
host.register('repair/commit', repairCommitHandler);
host.register('repair/discard', repairDiscardHandler);
host.register('repair/undo', repairUndoHandler);

host.register(
  'runtime/self-test',
  createSelfTestHandler({
    yieldToEventLoop: () =>
      new Promise<void>((resolve) => {
        workerScope.setTimeout(resolve, 0);
      }),
  }),
);

host.start();

/**
 * WORKER-SIDE BYTE OBSERVATION, outside the protocol.
 *
 * A test has to prove authoritative coordinates were not rewritten by a
 * placement or a repair, and the only honest way is to compare the bytes where
 * they live. Transferring canonical arrays to the page to compare them there
 * would make the page an owner of authoritative geometry — the exact inversion
 * ADR 0008 forbids — so the comparison happens here and only a digest and a
 * length cross back.
 *
 * A SEPARATE MESSAGE CHANNEL, not a protocol operation: it is addressed by its
 * own `kind` and is invisible to `GeometryWorkerHost`, so nothing about the
 * production protocol grows a debugging surface.
 */
interface DigestRequest {
  readonly kind: 'harness/digest';
  readonly documentId: string;
  readonly revision: number;
}

function isDigestRequest(value: unknown): value is DigestRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'harness/digest'
  );
}

/** FNV-1a over the raw bytes. Not a security primitive: an equality witness. */
function digestBytes(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

workerScope.addEventListener('message', (event: MessageEvent) => {
  if (!isDigestRequest(event.data)) return;

  const document = residentDocuments.resolve({
    documentId: event.data.documentId as never,
    revision: event.data.revision,
  });
  if (!('parts' in document)) {
    workerScope.postMessage({ kind: 'harness/digest-result', ok: false, parts: [] });
    return;
  }

  const meshIndex = new Map(distinctMeshes(document).map((mesh, index) => [mesh, index]));
  workerScope.postMessage({
    kind: 'harness/digest-result',
    ok: true,
    distinctMeshes: meshIndex.size,
    // Stage 6E-A2: the authoritative unit, not the page's mirror of it.
    unit: document.unit ?? null,
    parts: document.parts.map((part) => ({
      partId: part.id,
      name: part.name ?? null,
      materialRef: part.materialRef ?? null,
      meshResourceIndex: meshIndex.get(part.mesh) ?? -1,
      transform: [...part.transform],
      positionBytes: part.mesh.positions.byteLength,
      indexBytes: part.mesh.indices.byteLength,
      positionDigest: digestBytes(part.mesh.positions),
      indexDigest: digestBytes(part.mesh.indices),
    })),
  });
});

let activeBoolean:
  { readonly requestId: number; readonly cancellation: CancellationSource } | undefined;

function sphere(cx: number, segments: number, rings: number): CanonicalMesh {
  const vertexCount = 2 + (rings - 1) * segments;
  const positions = createPositionArray(vertexCount * 3);
  positions.set([cx, 0, 1], 0);
  let vertex = 1;
  for (let ring = 1; ring < rings; ring++) {
    const phi = (Math.PI * ring) / rings;
    for (let segment = 0; segment < segments; segment++) {
      const theta = (Math.PI * 2 * segment) / segments;
      positions.set(
        [cx + Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)],
        vertex * 3,
      );
      vertex += 1;
    }
  }
  positions.set([cx, 0, -1], (vertexCount - 1) * 3);
  const indices = createIndexArray(segments * (rings - 1) * 6);
  let at = 0;
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices.set([0, 1 + segment, 1 + next], at);
    at += 3;
  }
  for (let ring = 0; ring < rings - 2; ring++) {
    const row = 1 + ring * segments,
      nextRow = row + segments;
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      indices.set([row + segment, nextRow + segment, row + next], at);
      at += 3;
      indices.set([row + next, nextRow + segment, nextRow + next], at);
      at += 3;
    }
  }
  const south = vertexCount - 1,
    last = 1 + (rings - 2) * segments;
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices.set([last + segment, south, last + next], at);
    at += 3;
  }
  return { positions, indices, metadata: {} };
}

workerScope.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {
    kind?: string;
    requestId?: number;
    operation?: BooleanKind;
    segments?: number;
    rings?: number;
    testCrash?: boolean;
    cancellation?: SharedArrayBuffer;
  };
  if (data.kind === 'harness/boolean-cancel') {
    activeBoolean?.cancellation.cancel();
    return;
  }
  if (
    data.kind !== 'harness/boolean-run' ||
    data.requestId === undefined ||
    data.operation === undefined
  )
    return;
  activeBoolean?.cancellation.cancel();
  const requestId = data.requestId,
    operation = data.operation;
  const cancellation = new CancellationSource();
  activeBoolean = { requestId, cancellation };
  const token =
    data.cancellation === undefined
      ? cancellation.token
      : combineCancellation(adoptSharedCancellation(data.cancellation), cancellation.token);
  const started = performance.now();
  const segments = data.segments ?? 20,
    rings = data.rings ?? 12;
  const a = sphere(0, segments, rings),
    b = sphere(0.35, segments, rings);
  void (async (): Promise<void> => {
    try {
      const result = await runValidatedBoolean(
        {
          operate: async (kind, left, right, childToken) => {
            const mesh = await booleanOperations.run(kind, left, right, childToken, {
              owner: {
                documentId: `harness-${String(requestId)}`,
                generation: requestId,
              },
              ...(data.testCrash === undefined ? {} : { testCrash: data.testCrash }),
              onPhase: (timing) => {
                workerScope.postMessage({
                  kind: 'harness/boolean-phase',
                  requestId,
                  ...timing,
                });
              },
            });
            workerScope.postMessage({
              kind: 'harness/boolean-phase',
              requestId,
              phase: 'OUTPUT_VALIDATION',
              at: performance.now(),
            });
            return mesh;
          },
        },
        operation,
        a,
        b,
        token,
      );
      workerScope.postMessage({
        kind: 'harness/boolean-phase',
        requestId,
        phase: 'PREVIEW_CONSTRUCTION',
        at: performance.now(),
      });
      // Qualification-only extension of the real preview preparation window.
      // It touches the returned coordinates and polls the same shared token,
      // making cancellation after the phase marker deterministic on fast hosts.
      const previewDeadline = performance.now() + 200;
      let previewChecksum = 0;
      while (performance.now() < previewDeadline) {
        for (let at = 0; at < result.mesh.positions.length; at += 1024) {
          previewChecksum += result.mesh.positions[at] ?? 0;
          throwIfCancelled(token);
        }
      }
      const preview = buildRenderSnapshot(result.mesh);
      void preview;
      void previewChecksum;
      throwIfCancelled(token);
      workerScope.postMessage({
        kind: 'harness/boolean-result',
        requestId,
        status: 'SUCCESS',
        triangles: result.mesh.indices.length / 3,
        elapsedMs: performance.now() - started,
        stats: booleanOperations.stats,
      });
    } catch (cause) {
      workerScope.postMessage({
        kind: 'harness/boolean-result',
        requestId,
        status: isAppError(cause) ? cause.code : 'INTERNAL_ERROR',
        message: cause instanceof Error ? cause.message : String(cause),
        elapsedMs: performance.now() - started,
        stats: booleanOperations.stats,
      });
    } finally {
      if (activeBoolean.requestId === requestId) activeBoolean = undefined;
    }
  })();
});

/**
 * WHICH 3MF READER THE REAL IMPORT USES, set by the harness page — Stage 6E-A2.
 *
 * Its own message kind, invisible to `GeometryWorkerHost`, like the digest.
 *
 * `auto` WITH NO CEILING IS THE PRODUCTION CONFIGURATION ITSELF — Stage 6E-A3
 * moved the product from buffered to routed, so that is now which mode aliases
 * to `PRODUCTION_IMPORT_CONFIG`. Every other request builds a reader with
 * `createThreeMfReader`, which is exactly how the shipped worker could NOT be
 * configured. FORCING `buffered` MUST KEEP FORCING IT: the differential suites
 * read the same file both ways, and a `buffered` that quietly resolved to the
 * production default would compare routing against itself.
 */
interface IngestionRequest {
  readonly kind: 'harness/ingestion';
  readonly mode: 'buffered' | 'streaming' | 'auto';
  /** A wider per-entry ceiling, for memory previews above the product's. */
  readonly maxEntryBytes?: number;
}

function isIngestionRequest(value: unknown): value is IngestionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; mode?: unknown; maxEntryBytes?: unknown };
  return (
    candidate.kind === 'harness/ingestion' &&
    (candidate.mode === 'buffered' ||
      candidate.mode === 'streaming' ||
      candidate.mode === 'auto') &&
    (candidate.maxEntryBytes === undefined ||
      (typeof candidate.maxEntryBytes === 'number' &&
        Number.isSafeInteger(candidate.maxEntryBytes)))
  );
}

workerScope.addEventListener('message', (event: MessageEvent) => {
  if (!isIngestionRequest(event.data)) return;
  const { mode, maxEntryBytes } = event.data;
  const ingestion =
    mode === 'streaming'
      ? ThreeMfIngestion.Streaming
      : mode === 'auto'
        ? ThreeMfIngestion.Auto
        : ThreeMfIngestion.Buffered;
  const config: ModelImportConfig =
    mode === 'auto' && maxEntryBytes === undefined
      ? PRODUCTION_IMPORT_CONFIG
      : {
          threeMfReader: createThreeMfReader({
            ingestion,
            ...(maxEntryBytes === undefined
              ? {}
              : { zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes } }),
          }),
        };
  realImport = createModelImportHandler(config);
  workerScope.postMessage({ kind: 'harness/ingestion-set', mode, maxEntryBytes });
});

/** Harness-only deterministic edit producer. The production worker registers no
 * create operation, so users cannot request this synthetic translation. */
workerScope.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data;
  if (
    typeof data !== 'object' ||
    data === null ||
    (data as { kind?: unknown }).kind !== 'harness/edit-translate'
  )
    return;
  const request = data as {
    kind: string;
    requestId: number;
    documentId: string;
    revision: number;
    partId: string;
    dx: number;
  };
  try {
    if (
      !Number.isSafeInteger(request.requestId) ||
      !Number.isFinite(request.dx) ||
      Math.abs(request.dx) > 1000
    )
      throw new Error('Invalid test edit request.');
    const source = { documentId: request.documentId as never, revision: request.revision };
    const part = residentDocuments.resolvePart(source, partId(request.partId));
    if (isAppError(part)) throw part;
    const ticket = geometryEdits.begin(source, part.id, 'test-translate');
    const positions = createPositionArray(part.mesh.positions.length);
    positions.set(part.mesh.positions);
    for (let at = 0; at < positions.length; at += 3)
      positions[at] = (positions[at] ?? 0) + request.dx;
    const indices = createIndexArray(part.mesh.indices.length);
    indices.set(part.mesh.indices);
    const candidate = geometryEdits.resolve(ticket, { ...part.mesh, positions, indices });
    workerScope.postMessage({
      kind: 'harness/edit-result',
      requestId: request.requestId,
      ok: true,
      candidate: candidate.candidate,
      resources: candidate.resources,
    });
  } catch (cause) {
    workerScope.postMessage({
      kind: 'harness/edit-result',
      requestId: request.requestId,
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
});
