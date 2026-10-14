import {
  validateSemanticHierarchy,
  validateHuman,
  validateVehicle,
  type HumanAnswer,
  type VehicleAnswer,
} from '@cadfixer/auto-split-contract';
import {
  prepareSemanticGeometry,
  decomposeSemantic,
  type PreparedSemanticGeometry,
  componentPieces,
  faceFacts,
  AUTO_SPLIT_TOO_DETAILED,
  labelComponents,
  normalizeGeometry,
  prepareViews,
  suggestFor,
  type Checkpoint,
  type ComponentLabelling,
  type SemanticAnswer,
} from '@cadfixer/auto-split';
import {
  isPart,
  meshVolume,
  meshSurfaceArea,
  splitSourceReasons,
  splitTolerance,
  type DocumentHandle,
  type OperationContext,
  type OperationHandler,
  type SplitSourceReason,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { MAX_SUPPORTED_SPLIT_TRIANGLES, partId, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology } from '@cadfixer/mesh-topology';
import {
  invalidState,
  resourceLimitExceeded,
  isAppError,
  type CancellationToken,
} from '@cadfixer/shared';
import {
  buildDocumentRenderSnapshot,
  describeParts,
  documentRenderTransferables,
  residentDocuments,
  splitCandidates,
} from './stl-handlers';

/**
 * AUTO SPLIT, THE LOCAL HALF OF THE GEOMETRY WORKER.
 *
 * NOTHING HERE MUTATES A DOCUMENT. `autosplit/render` and `autosplit/suggest` read a part and answer;
 * `autosplit/extract-create` builds a split CANDIDATE through the same `SplitCandidateStore` that
 * `split/create` uses, so applying it is `split/commit` and undoing it is `repair/undo` — the one
 * transaction and the one undo the manual workflow already has. There is no commit here, and a
 * boundary test asserts that this module reaches no `replace`.
 *
 * AN ANSWER FROM THE PROVIDER IS DATA. It arrives as `unknown`, is validated again here by the same
 * validators the service ran, and can only ever become a list of suggestions: it cannot name a part, a
 * revision, an operation or a handle.
 */

/** zlib-wrapped deflate, which is what a PNG's IDAT carries. The platform compressor, off the page's thread. */
async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const written = writer.write(new Uint8Array(raw)).then(() => writer.close());
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (value !== undefined) {
      parts.push(value);
      total += value.length;
    }
    if (done) break;
  }
  await written;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function resolveMesh(source: DocumentHandle, id: string): CanonicalMesh {
  const part = residentDocuments.resolvePart(source, partId(id));
  if (!isPart(part)) throw part;
  return part.mesh;
}

/** The engine's safe boundary, read from the operation's own cancellation (shared word where interruptible). */
function checkpointOf(context: OperationContext): Checkpoint {
  return (): void => {
    context.throwIfCancelled();
  };
}

/**
 * THE AUTHORITATIVE SIZE CHECK. The page checks the part's triangle count before it offers Find parts,
 * but that is courtesy: this is the check that decides. The ceiling is the ONE shared split ceiling —
 * the same number the exact split enforces — so Auto Split never accepts a part the cut it suggests
 * would then be refused for size alone. The refusal is a deterministic outcome (`AUTO_SPLIT_TOO_DETAILED`):
 * the count is a fact and the ceiling a constant, so retrying cannot change it.
 */
function refuseIfTooLarge(mesh: CanonicalMesh): void {
  const faces = Math.floor(mesh.indices.length / 3);
  if (faces > MAX_SUPPORTED_SPLIT_TRIANGLES)
    throw resourceLimitExceeded(
      `This part has ${faces.toLocaleString('en-US')} triangles; Auto Split supports parts of up to ${MAX_SUPPORTED_SPLIT_TRIANGLES.toLocaleString('en-US')}.`,
      {
        code: AUTO_SPLIT_TOO_DETAILED,
        metric: 'triangles',
        value: faces,
        limit: MAX_SUPPORTED_SPLIT_TRIANGLES,
      },
    );
}

/** The closed-solid reasons for a mesh, empty when it is splittable. The same predicate Manual Split enforces. */
function sourceReasonsOf(
  mesh: CanonicalMesh,
  documentRevision: number,
  label: string,
  cancellation: CancellationToken,
): readonly SplitSourceReason[] {
  const { report } = analyseTopology(mesh, {
    documentId: 'autosplit',
    documentRevision,
    partId: label,
    cancellation,
    sampleLimit: 0,
    componentSummaryLimit: 8,
  });
  return splitSourceReasons(report);
}

/** The last labelling, keyed by document, revision and part, so selecting components does not relabel. */
let lastLabelling:
  | { readonly key: string; readonly mesh: CanonicalMesh; readonly labelling: ComponentLabelling }
  | undefined;

function labellingFor(
  source: DocumentHandle,
  id: string,
  mesh: CanonicalMesh,
  checkpoint: Checkpoint,
): ComponentLabelling {
  const key = `${source.documentId}@${String(source.revision)}/${id}`;
  if (lastLabelling?.key === key && lastLabelling.mesh === mesh) return lastLabelling.labelling;
  const labelling = labelComponents(
    mesh,
    faceFacts(normalizeGeometry(mesh.positions, mesh.indices, checkpoint), checkpoint),
    checkpoint,
  );
  lastLabelling = { key, mesh, labelling };
  return labelling;
}

let semanticPrepared:
  | { key: string; mesh: CanonicalMesh; prepared: PreparedSemanticGeometry; preparationId: number }
  | undefined;
let preparationSequence = 0;
let preparationExpiry: ReturnType<typeof setTimeout> | undefined;
function clearSemanticPreparation(): void {
  semanticPrepared = undefined;
  if (preparationExpiry !== undefined) clearTimeout(preparationExpiry);
  preparationExpiry = undefined;
}
export const autoSplitReleaseHandler: OperationHandler<'autosplit/release'> = (payload) => {
  const released =
    semanticPrepared?.key === semanticKey(payload.source, payload.partId) &&
    semanticPrepared.preparationId === payload.preparationId;
  if (released) clearSemanticPreparation();
  return Promise.resolve({ value: { released } });
};
const semanticKey = (source: DocumentHandle, id: string): string =>
  `${source.documentId}@${String(source.revision)}/${id}`;

export const autoSplitRenderHandler: OperationHandler<'autosplit/render'> = async (
  payload,
  context,
) => {
  context.throwIfCancelled();
  const mesh = resolveMesh(payload.source, payload.partId);
  refuseIfTooLarge(mesh);
  clearSemanticPreparation();
  if (payload.mode === 'semantic') {
    if (payload.scope === 'entire-model') {
      const document = residentDocuments.resolve(payload.source);
      if (isAppError(document)) throw document;
      if (document.parts.length !== 1) throw invalidState('Choose a piece to find its parts.');
    }
    const prepared = await prepareSemanticGeometry(
      mesh,
      deflate,
      checkpointOf(context),
      (_view, index) => {
        context.reportProgress((index + 1) / 6, `Preparing model… view ${String(index + 1)} of 6`);
      },
    );
    context.throwIfCancelled();
    const key = semanticKey(payload.source, payload.partId);
    const preparationId = ++preparationSequence;
    semanticPrepared = { key, mesh, prepared, preparationId };
    preparationExpiry = setTimeout(() => {
      if (semanticPrepared?.preparationId === preparationId) clearSemanticPreparation();
    }, 240_000);
    lastLabelling = { key, mesh, labelling: prepared.labelling };
    return {
      value: {
        source: payload.source,
        partId: payload.partId,
        pngs: prepared.pngs,
        preparationId,
        componentPngs: prepared.componentPngs,
        semantic: { ...prepared.metadata, scope: payload.scope ?? 'selected-piece' },
        summary: {
          extents: prepared.geometry.extents,
          shells: prepared.labelling.count,
          radius: prepared.geometry.radius,
        },
      },
      transfer: [...prepared.pngs, ...prepared.componentPngs].map(
        (png) => png.buffer as ArrayBuffer,
      ),
    };
  }
  const prepared = await prepareViews(
    mesh,
    deflate,
    (_view, index) => {
      context.throwIfCancelled();
      context.reportProgress((index + 1) / 6, `Preparing model… view ${String(index + 1)} of 6`);
    },
    // Read inside every long loop. Where the operation is interruptible the shared cancellation word
    // is visible from synchronous work, so a cancel lands within a few milliseconds, not at a view's end.
    checkpointOf(context),
  );
  context.throwIfCancelled();
  return {
    value: {
      source: payload.source,
      partId: payload.partId,
      pngs: prepared.pngs,
      summary: prepared.summary,
    },
    transfer: prepared.pngs.map((png) => png.buffer as ArrayBuffer),
  };
};

export const autoSplitSuggestHandler: OperationHandler<'autosplit/suggest'> = (
  payload,
  context,
) => {
  context.throwIfCancelled();
  const mesh = resolveMesh(payload.source, payload.partId);
  refuseIfTooLarge(mesh);
  if (payload.mode === 'semantic') {
    const cached = semanticPrepared;
    clearSemanticPreparation();
    if (
      cached?.key !== semanticKey(payload.source, payload.partId) ||
      cached.mesh !== mesh ||
      cached.preparationId !== payload.preparationId
    )
      throw invalidState('Prepare this piece again before finding parts.', {
        code: 'AUTO_SPLIT_SOURCE_STALE',
      });
    const checked = validateSemanticHierarchy(payload.analysis);
    if (!checked.ok)
      throw invalidState('The analysis did not match the expected shape.', {
        code: 'AUTO_SPLIT_ANSWER_INVALID',
      });
    const result = decomposeSemantic(cached.prepared, checked.value, checkpointOf(context));
    context.throwIfCancelled();
    return Promise.resolve({
      value: {
        source: payload.source,
        partId: payload.partId,
        mode: payload.mode,
        objectLabel: result.objectLabel,
        suggestions: result.suggestions,
        components: result.components,
        componentCount: result.componentCount,
        faceCount: result.faceCount,
        sourceReasons: [],
        sourceDiagnostics: 'deferred-to-preview',
      },
    });
  }
  let answer: SemanticAnswer;
  if (payload.mode === 'human') {
    const checked = validateHuman(payload.analysis);
    if (!checked.ok)
      throw invalidState('The analysis did not match the expected shape.', {
        code: 'AUTO_SPLIT_ANSWER_INVALID',
      });
    const human: HumanAnswer = checked.value;
    answer = { mode: 'human', human };
  } else {
    const checked = validateVehicle(payload.analysis);
    if (!checked.ok)
      throw invalidState('The analysis did not match the expected shape.', {
        code: 'AUTO_SPLIT_ANSWER_INVALID',
      });
    const vehicle: VehicleAnswer = checked.value;
    answer = { mode: 'vehicle', vehicle };
  }
  const result = suggestFor(mesh, answer, { checkpoint: checkpointOf(context) });
  context.throwIfCancelled();
  const sourceReasons = sourceReasonsOf(
    mesh,
    payload.source.revision,
    payload.partId,
    context.cancellation,
  );
  return Promise.resolve({
    value: {
      source: payload.source,
      partId: payload.partId,
      mode: payload.mode,
      suggestions: result.suggestions,
      components: result.components,
      componentCount: result.componentCount,
      faceCount: result.faceCount,
      sourceReasons,
    },
  });
};

export const autoSplitComponentFacesHandler: OperationHandler<'autosplit/component-faces'> = (
  payload,
  context,
) => {
  context.throwIfCancelled();
  const mesh = resolveMesh(payload.source, payload.partId);
  const labelling = labellingFor(payload.source, payload.partId, mesh, checkpointOf(context));
  const chosen = new Set(payload.ranks);
  const faces: number[] = [];
  labelling.faceRank.forEach((rank, face) => {
    if (chosen.has(rank)) faces.push(face);
  });
  const out = Uint32Array.from(faces);
  return Promise.resolve({
    value: { source: payload.source, partId: payload.partId, faces: out },
    transfer: [out.buffer],
  });
};

const NO_CUT = {
  triangleIds: [],
  center: [0, 0, 0],
  spanU: 0,
  spanV: 0,
  centerEdgeDistance: 0,
  interiorCandidates: [],
  area: 0,
  loopCount: 0,
  outline: new Float32Array(0),
  outlineTruncated: false,
} as const;

export const autoSplitExtractCreateHandler: OperationHandler<'autosplit/extract-create'> = (
  payload,
  context,
) => {
  context.throwIfCancelled();
  const sourcePart = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(sourcePart)) throw sourcePart;
  refuseIfTooLarge(sourcePart.mesh);
  const reasons = sourceReasonsOf(
    sourcePart.mesh,
    payload.source.revision,
    payload.partId,
    context.cancellation,
  );
  // Component extraction is a complete triangle partition, not a Boolean. Source openings
  // stay exactly where they were; validation permits only already-present degenerate faces.
  const labelling = labellingFor(
    payload.source,
    payload.partId,
    sourcePart.mesh,
    checkpointOf(context),
  );
  let pieces;
  try {
    pieces = componentPieces(sourcePart.mesh, labelling, payload.ranks, checkpointOf(context));
  } catch (error) {
    throw invalidState(error instanceof Error ? error.message : 'The selection cannot be split.', {
      code: 'AUTO_SPLIT_SELECTION_INVALID',
    });
  }
  const ticket = splitCandidates.begin(payload.source, sourcePart.id);
  try {
    context.reportProgress(0.3, 'Preparing selection…');
    const sourceVolume = meshVolume(sourcePart.mesh);
    const a = meshVolume(pieces.selected);
    const b = meshVolume(pieces.rest);
    const result: SplitResult = {
      pieceA: pieces.selected,
      pieceB: pieces.rest,
      cutA: NO_CUT,
      cutB: NO_CUT,
      connector: { kind: 'none' },
      metrics: {
        ...(reasons.length === 0 ? {} : { volumeInterpretable: false }),
        sourceVolume,
        pieceAVolume: a,
        pieceBVolume: b,
        pieceAFinalVolume: a,
        pieceBFinalVolume: b,
        volumeRelativeError: sourceVolume === 0 ? 0 : Math.abs(a + b - sourceVolume) / sourceVolume,
        tolerance: splitTolerance(sourcePart.mesh),
      },
      placements: [],
      ...(reasons.length === 0
        ? {}
        : {
            surfaceValidation: {
              sourceFaces: sourcePart.mesh.indices.length / 3,
              untouchedFaces: sourcePart.mesh.indices.length / 3,
              clippedFaces: 0,
              sourceArea: meshSurfaceArea(sourcePart.mesh),
              outputArea: meshSurfaceArea(pieces.selected) + meshSurfaceArea(pieces.rest),
              capTriangles: 0,
              cutLoops: 0,
              openChains: 0,
              intermediateBytes: 0,
              phaseMilliseconds: {},
            },
          }),
    };
    context.reportProgress(0.7, 'Checking parts…');
    const summary = splitCandidates.resolve(ticket, result, context.cancellation);
    const preview = splitCandidates.preview(summary.candidate, (document) => ({
      render: buildDocumentRenderSnapshot(document),
      parts: describeParts(document),
    }));
    context.reportProgress(1, 'Preparing preview…');
    return Promise.resolve({
      value: { ...summary, ...preview },
      transfer: documentRenderTransferables(preview.render),
    });
  } catch (error) {
    splitCandidates.fail(ticket);
    throw error;
  }
};
