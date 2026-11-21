import {
  diagnostic,
  malformedFile,
  throwIfCancelled,
  type CancellationToken,
  type Diagnostic,
} from '@cadfixer/shared';
import { BooleanOperationController } from './boolean-operation-controller';
import {
  assertGeometryDocument,
  assertMeshStructure,
  computeBounds,
  buildDrawableTriangles,
  distinctMeshes,
  documentTriangleCount,
  documentVertexCount,
  IDENTITY_PART_TRANSFORM,
  measureImportGeometry,
  placeMesh,
  placementReversesOrientation,
  transformBounds,
  triangleCount,
  unionBounds,
  vertexCount,
  validateMeshStructure,
  MeshValidationSeverity,
  type CanonicalMesh,
  type GeometryDocument,
  type MeshBounds,
  type PartId,
  type PartTransform,
} from '@cadfixer/mesh-core';
import {
  DEFAULT_IMPORT_BUDGET,
  describeFormat,
  identifyFormat,
  registerBuiltInFormats,
  requireReader,
  requireWriter,
  MeshFormatId,
  type FormatProgressReporter,
  type DocumentReader,
  type FormatReadContext,
  type ImportBudget,
  type ImportCompatibility,
} from '@cadfixer/file-formats';
import { inflateRaw } from './platform-inflate';
import { analyseTopology, estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import {
  HoleFillCandidateStore,
  GeometryEditStore,
  JointEditStore,
  SplitCandidateStore,
  RepairCandidateStore,
  RepairHistoryStore,
  TopologyReportCache,
} from '@cadfixer/geometry-runtime';
import {
  checkImportGeometry,
  documentByteLength,
  isDocument,
  isPart,
  requestAnalysisWorkspace,
  ResidentDocumentStore,
  type DocumentRenderSnapshot,
  type MeshValidationSummary,
  type DocumentId,
  type HandlerOutcome,
  type OperationContext,
  type OperationHandler,
  type PartDescriptor,
  type PartRenderSnapshot,
  type RenderSnapshot,
  type StlExportResult,
  type ModelImportResult,
  type ModelAnalyzeResult,
  type ModelReleaseResult,
} from '@cadfixer/geometry-runtime';

/**
 * Worker-side handlers for the resident model operations.
 *
 * These are adapters, not geometry code. Everything substantive — detection,
 * parsing, limits, writing — lives in `@cadfixer/file-formats` and is tested
 * under plain Node. What happens here is translating the worker protocol's
 * `OperationContext` into the format layer's context, running the validation
 * gate, and managing residency.
 */

registerBuiltInFormats();

/**
 * The authoritative geometry for this worker.
 *
 * Module-scoped because there is one worker and one store. It is exported for
 * tests, which is also the only way to assert residency behaviour without a
 * browser.
 */
/**
 * Repair candidates live beside the authoritative models, in the same worker.
 *
 * Separate store, separate handle type: a candidate can never be resolved by an
 * operation that takes a `DocumentHandle`, so export and analysis cannot reach
 * proposed geometry by accident.
 */
export const repairCandidates = new RepairCandidateStore();

/**
 * Undo information for repairs that have already been committed.
 *
 * Held in the worker for the same reason the models are: undo restores
 * AUTHORITATIVE geometry, and the main thread holds none. Exactly one repair per
 * model is reversible — see `repair-history.ts` for why a deeper stack was not
 * built here.
 */
export const repairHistory = new RepairHistoryStore();

/**
 * Hole-fill candidates, beside the repair candidates and for the same reasons.
 *
 * DECLARED HERE RATHER THAN IN `hole-fill-handlers.ts` — Stage 4B-1B2. The store
 * has to be released when a document is released, and `model/release` lives in
 * this file; a store declared in the hole-fill module would have made this file
 * import that one, which already imports this one. Only the DECLARATION moved.
 * `HoleFillCandidateStore.create` is still called from exactly one place, and
 * the production boundary scan still asserts which place that is.
 */
export const holeFillCandidates = new HoleFillCandidateStore();

/**
 * The latest topology report per resident model.
 *
 * Analysis runs automatically on import and repair is planned from its result,
 * so without this the same unchanged mesh was analysed once to diagnose it,
 * again to plan a repair, and a third time to build a candidate. Keyed by
 * revision, so a report is never reused for geometry it does not describe.
 */
export const topologyReports = new TopologyReportCache();

export const residentDocuments = new ResidentDocumentStore();

/** Shared Stage 7 candidate store. Future split and texture engines produce here. */
export const geometryEdits = new GeometryEditStore(residentDocuments, repairHistory);
/** Split uses the same authoritative document and one-step history transaction. */
export const splitCandidates = new SplitCandidateStore(
  residentDocuments,
  repairHistory,
  geometryEdits,
);
/**
 * Edits of an existing connector joint (Stage EC-3), on the same authoritative document and the same one-step history. It shares the
 * document's edit lifecycle with the split store, so a joint edit and a split exclude one another by construction.
 */
export const jointEdits = new JointEditStore(residentDocuments, repairHistory, geometryEdits);
/** Owns the one disposable nested Manifold worker, when a Boolean is active. */
export const booleanOperations = new BooleanOperationController();

/**
 * Returns control to the worker's event loop.
 *
 * A `MessageChannel` round-trip rather than `setTimeout(0)`: browsers clamp
 * nested timeouts to about 4 ms, and a parse that yields once per batch would
 * pay that clamp on every batch — hundreds of milliseconds of pure waiting on a
 * large model. A message task is not clamped.
 *
 * This is what makes cancellation real. The cancel message is queued behind the
 * running handler; yielding is the only thing that lets the worker read it.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (): void => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/**
 * Phase boundaries within a single import, so the progress bar reflects the
 * work actually remaining rather than restarting at each stage.
 */
const PARSE_SHARE = 0.8;
const VALIDATE_SHARE = 0.9;

function progressReporter(
  report: (fraction: number, note?: string) => void,
  from: number,
  to: number,
): FormatProgressReporter {
  return {
    report(fraction: number, note?: string): void {
      const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
      report(from + clamped * (to - from), note);
    },
  };
}

/**
 * Applies caller-supplied limit overrides.
 *
 * Overrides may only LOWER a limit. Raising one over the wire would let a
 * message decide how much memory the worker is allowed to commit, which is
 * exactly the decision the budget exists to take away from untrusted input.
 */
function resolveBudget(overrides: Readonly<Record<string, number>> | undefined): ImportBudget {
  if (overrides === undefined) return DEFAULT_IMPORT_BUDGET;

  const lower = (key: keyof ImportBudget): number => {
    const proposed = overrides[key];
    const current = DEFAULT_IMPORT_BUDGET[key];
    if (proposed === undefined || !Number.isFinite(proposed) || proposed < 0) return current;
    return Math.min(current, proposed);
  };

  // Built field by field rather than by spreading and casting. A cast here
  // would let a renamed or removed budget field pass silently; this way the
  // compiler checks that every limit is accounted for.
  return {
    maxInputBytes: lower('maxInputBytes'),
    maxTriangles: lower('maxTriangles'),
    maxUnsharedImportTriangles: lower('maxUnsharedImportTriangles'),
    maxVertices: lower('maxVertices'),
    maxOutputBytes: lower('maxOutputBytes'),
    maxEstimatedPeakBytes: lower('maxEstimatedPeakBytes'),
    maxTokenBytes: lower('maxTokenBytes'),
  };
}

function summarise(mesh: CanonicalMesh): MeshValidationSummary {
  const report = validateMeshStructure(mesh);
  const errors = report.issues.filter(
    (issue) => issue.severity === MeshValidationSeverity.Error,
  ).length;
  return {
    valid: report.valid,
    issueCount: errors,
    warningCount: report.issues.length - errors,
    truncated: report.truncated,
    codes: [...new Set(report.issues.map((issue) => issue.code))],
  };
}

/**
 * Builds the buffers the UI needs to draw, from geometry that stays here.
 *
 * THE SNAPSHOT IS EXPANDED, THE CANONICAL MESH IS NOT — Stage 4B-1D. The draw is
 * non-indexed, so the buffer holds three corners per face in face order,
 * materialised by `buildDrawableTriangles` from the mesh's INDEX BUFFER.
 *
 * This used to be `mesh.positions.slice()` with no reference to the indices at
 * all, on the stated assumption that canonical geometry is STL soup numbered
 * 0,1,2,3,…. That assumption stopped being true when OBJ and 3MF import landed:
 * an indexed mesh's vertex TABLE is not its triangle stream, so the GPU drew
 * whatever triangles the table's ordering happened to spell — a four-vertex,
 * four-face tetrahedron was drawn as ONE triangle. The overlay builders index
 * this buffer as `face * 9`, so they were reading the same wrong thing. Both are
 * correct for every format now.
 *
 * Positions are COPIED rather than transferred: the worker keeps the
 * authoritative array, so handing the original to the main thread would detach
 * it and leave the resident model unusable. That copy is the price of worker-
 * side ownership, and it is accounted for in docs/PERFORMANCE_BASELINE.md.
 *
 * NORMALS ARE FLAT, and expansion is what makes that free: each corner belongs
 * to exactly one face and carries that face's normal. It is also what keeps a
 * repaired model looking like the model it was — Stage 4B-1D gave repair
 * candidates the source's shared corners, and smoothing across them would have
 * rounded off every hard edge purely because the geometry is now stored better.
 */
export function buildRenderSnapshot(mesh: CanonicalMesh): RenderSnapshot {
  const drawable = buildDrawableTriangles(mesh);
  return {
    positions: drawable.positions,
    normals: drawable.normals,
    vertexCount: drawable.vertexCount,
  };
}

/**
 * Drawable buffers for a whole document, WITH RENDER GEOMETRY SHARED.
 *
 * Buffers are built once per DISTINCT authoritative mesh and then referenced by
 * every part that uses it. Structured clone preserves object identity across
 * `postMessage`, so two parts that share a mesh here arrive on the main thread
 * still sharing one `Float32Array` — which is what lets the viewport give them
 * one `BufferGeometry` and two object transforms. A thousand placements of one
 * component therefore cost one copy of the geometry, not a thousand.
 *
 * The placement travels beside the buffers and is never baked into them. Baking
 * would make each placement a different buffer and destroy the sharing this
 * function exists to preserve.
 */
export function buildDocumentRenderSnapshot(document: GeometryDocument): DocumentRenderSnapshot {
  const byMesh = new Map<CanonicalMesh, RenderSnapshot>();
  const parts: PartRenderSnapshot[] = [];

  for (const part of document.parts) {
    let snapshot = byMesh.get(part.mesh);
    if (snapshot === undefined) {
      snapshot = buildRenderSnapshot(part.mesh);
      byMesh.set(part.mesh, snapshot);
    }
    parts.push({
      partId: part.id,
      transform: part.transform,
      positions: snapshot.positions,
      normals: snapshot.normals,
      vertexCount: snapshot.vertexCount,
    });
  }

  return { parts };
}

/**
 * The buffers of a document snapshot, deduplicated for a transfer list.
 *
 * Passing one buffer twice throws `DataCloneError`, and shared render geometry
 * guarantees duplicates.
 */
export function documentRenderTransferables(snapshot: DocumentRenderSnapshot): ArrayBufferLike[] {
  const buffers = new Set<ArrayBufferLike>();
  for (const part of snapshot.parts) {
    buffers.add(part.positions.buffer);
    buffers.add(part.normals.buffer);
  }
  return [...buffers];
}

/**
 * Scalar metadata about each part, for the main thread.
 *
 * `meshResourceIndex` is assigned by first appearance of the underlying mesh
 * OBJECT, so two parts sharing geometry report the same index. That is the only
 * way the page — or a test — can observe structural sharing without holding the
 * geometry that is shared.
 */
export function describeParts(document: GeometryDocument): readonly PartDescriptor[] {
  const resourceIndex = new Map<CanonicalMesh, number>();
  const localBounds = boundsPerMesh(document);
  const descriptors: PartDescriptor[] = [];

  for (const part of document.parts) {
    let index = resourceIndex.get(part.mesh);
    if (index === undefined) {
      index = resourceIndex.size;
      resourceIndex.set(part.mesh, index);
    }
    /*
     * CONVERSION FEATURES, COUNTED PER PART FROM THE PART'S OWN MESH.
     *
     * Cheap by construction: a group list is a handful of entries and
     * `normals`/`uvs` are presence checks, so this touches no coordinate and
     * costs the same whether the mesh has ten triangles or ten million. Two
     * parts sharing one mesh report the same numbers, which is correct — they
     * are describing the same geometry.
     */
    const groups = part.mesh.groups ?? [];
    let groupMaterialRefCount = 0;
    for (const group of groups) {
      if (group.materialRef !== undefined) groupMaterialRefCount += 1;
    }

    descriptors.push({
      partId: part.id,
      ...(part.name === undefined ? {} : { name: part.name }),
      transform: part.transform,
      triangleCount: triangleCount(part.mesh),
      vertexCount: vertexCount(part.mesh),
      bounds: localBounds.get(part.mesh),
      meshResourceIndex: index,
      ...(part.materialRef === undefined ? {} : { materialRef: part.materialRef }),
      groupCount: groups.length,
      groupMaterialRefCount,
      hasNormals: part.mesh.normals !== undefined,
      hasUvs: part.mesh.uvs !== undefined,
    });
  }

  return descriptors;
}

/**
 * Each DISTINCT mesh's local box, computed once.
 *
 * MEASURED, NOT ASSUMED. `computeBounds` walks every coordinate, so calling it
 * per PART made a 1,000-placement document walk one shared mesh a thousand
 * times: 356 ms of pure repetition in the document benchmark, for an answer
 * that is identical every time. Local bounds belong to the MESH; only the
 * placement differs, and a placement is applied to the box afterwards.
 */
function boundsPerMesh(document: GeometryDocument): Map<CanonicalMesh, MeshBounds | undefined> {
  const bounds = new Map<CanonicalMesh, MeshBounds | undefined>();
  for (const mesh of distinctMeshes(document)) bounds.set(mesh, computeBounds(mesh));
  return bounds;
}

/**
 * The document's world-space extent.
 *
 * Each part's local box is transformed by its placement and the results are
 * unioned, so a document whose parts sit apart frames all of them. Transforming
 * a box means transforming all eight corners — see `transformBounds`.
 */
export function documentBounds(document: GeometryDocument): MeshBounds | undefined {
  const localBounds = boundsPerMesh(document);
  let bounds: MeshBounds | undefined;
  for (const part of document.parts) {
    const local = localBounds.get(part.mesh);
    if (local === undefined) continue;
    bounds = unionBounds(bounds, transformBounds(local, part.transform));
  }
  return bounds;
}

/**
 * The structural validation summary for a document.
 *
 * Reported per DISTINCT mesh and merged, because that is what was actually
 * validated: a shared mesh is one mesh however many parts place it.
 */
function summariseDocument(document: GeometryDocument): MeshValidationSummary {
  let valid = true;
  let issueCount = 0;
  let warningCount = 0;
  let truncated = false;
  const codes = new Set<string>();

  for (const mesh of distinctMeshes(document)) {
    const summary = summarise(mesh);
    valid = valid && summary.valid;
    issueCount += summary.issueCount;
    warningCount += summary.warningCount;
    truncated = truncated || summary.truncated;
    for (const code of summary.codes) codes.add(code);
  }

  return { valid, issueCount, warningCount, truncated, codes: [...codes] };
}

/** The read context every codec receives. One shape, whatever the format. */
function readContext(
  payload: { readonly budget?: Readonly<Record<string, number>> },
  context: OperationContext,
  from: number,
  to: number,
): FormatReadContext {
  return {
    cancellation: context.cancellation,
    budget: resolveBudget(payload.budget),
    yieldToEventLoop,
    decodeText: (input: Uint8Array): string =>
      new TextDecoder('utf-8', { fatal: false }).decode(input),
    inflateRaw,
    createTextDecoder: () => new TextDecoder('utf-8', { fatal: false }),
    progress: progressReporter(
      (fraction, note) => {
        context.reportProgress(fraction, note);
      },
      from,
      to,
    ),
  };
}

/**
 * IMPORT, FOR EVERY FORMAT.
 *
 * The handler identifies the file from its BYTES, dispatches to the registered
 * reader, validates what came back, and commits it. There is no per-format
 * branching after the dispatch line: every reader produces a
 * `GeometryDocument`, and `commitImportedDocument` is the single place one
 * becomes authoritative — so OBJ and 3MF cannot acquire their own residency
 * rules, their own revision semantics, or their own idea of what validation
 * means.
 *
 * TRANSACTIONAL THROUGHOUT. Identification, parsing, mesh validation, document
 * validation and the memory preflight all happen before the store is touched,
 * so a malformed OBJ or a hostile 3MF leaves the previously resident document
 * exactly as it was.
 */
/**
 * Which readers `model/import` uses — A CONSTRUCTION SEAM, Stage 6E-A2.
 *
 * The product builds exactly one import handler, from
 * `PRODUCTION_IMPORT_CONFIG`, which overrides nothing: every format is read by
 * the reader the registry holds, and for 3MF that is the BUFFERED reader under
 * the production limits. A boundary test asserts that the shipped worker
 * registers `modelImportHandler` and that nothing under `apps/web/src` builds a
 * handler from any other configuration.
 *
 * The seam exists so the end-to-end harness can drive the SAME handler — the
 * same identification, mesh gate, document gate, resource gate, render snapshot
 * and resident commit — with a streamed 3MF reader, which is the only honest
 * way to qualify streaming through the whole pipeline. It is not a switch:
 * there is no flag, query parameter or setting in the product that reaches it.
 */
export interface ModelImportConfig {
  /** Replaces the registry's 3MF reader. Absent in production. */
  readonly threeMfReader?: DocumentReader;
}

export const PRODUCTION_IMPORT_CONFIG: ModelImportConfig = Object.freeze({});

export function createModelImportHandler(
  config: ModelImportConfig,
): OperationHandler<'model/import'> {
  return (payload, context) => importModel(payload, context, config);
}

export const modelImportHandler: OperationHandler<'model/import'> =
  createModelImportHandler(PRODUCTION_IMPORT_CONFIG);

async function importModel(
  payload: Parameters<OperationHandler<'model/import'>>[0],
  context: OperationContext,
  config: ModelImportConfig,
): Promise<HandlerOutcome<ModelImportResult>> {
  const source = payload.bytes;
  if (!(source instanceof ArrayBuffer)) {
    throw malformedFile('The import payload did not contain a transferable file buffer.');
  }

  const bytes = new Uint8Array(source);
  const cancellation: CancellationToken = context.cancellation;

  /*
   * WHAT IS THIS FILE? Answered once, from the bytes, before any parser runs.
   * A name is user-supplied text and is consulted only to break the OBJ/ASCII-
   * STL ambiguity and to refuse a file whose name and contents disagree.
   */
  context.reportProgress(0, 'identifying');
  const identified = identifyFormat(bytes, payload.fileName);
  throwIfCancelled(cancellation);

  const reader =
    identified.formatId === MeshFormatId.ThreeMf && config.threeMfReader !== undefined
      ? config.threeMfReader
      : requireReader(identified.formatId);
  const parsed = await reader.read(bytes, readContext(payload, context, 0.02, PARSE_SHARE));

  throwIfCancelled(cancellation);
  context.reportProgress(PARSE_SHARE, 'validating');

  /*
   * THE MESH GATE. A parser returning geometry is not a successful import;
   * passing structural validation is. Run per DISTINCT mesh, so a document with
   * a thousand placements of one component validates one mesh rather than a
   * thousand.
   */
  const operation = `${describeFormat(identified.formatId).label} import`;
  for (const mesh of distinctMeshes(parsed.document)) {
    assertMeshStructure(mesh, operation);
    throwIfCancelled(cancellation);
  }

  return commitImportedDocument(
    {
      document: parsed.document,
      operation,
      formatId: identified.formatId,
      encoding: parsed.encoding,
      warnings: parsed.warnings,
      compatibility: parsed.compatibility,
    },
    context,
  );
}

/** What `commitImportedDocument` needs that it cannot derive from the document. */
export interface DocumentCommitInput {
  /** The candidate. Nothing has been committed for it yet. */
  readonly document: GeometryDocument;
  /** Names the caller in validation failures, e.g. `STL import`. */
  readonly operation: string;
  /** Which format was actually read, as identified from the bytes. */
  readonly formatId: string;
  /** As actually detected. Reported, never guessed. */
  readonly encoding: string;
  readonly warnings: readonly Diagnostic[];
  /** What the reader recognised in the source and did not carry across. */
  readonly compatibility: ImportCompatibility;
}

/**
 * THE IMPORT TRANSACTION, from a candidate document to a committed one.
 *
 * EXTRACTED FROM THE STL HANDLER so there is exactly one implementation of the
 * steps that decide whether a document becomes authoritative: the document
 * gate, the session budget, the render snapshot, and the commit. A second
 * producer of documents — the OBJ and 3MF readers of Stage 4A-2B, and the
 * end-to-end harness that constructs synthetic multi-part documents today —
 * must not reimplement any of it, because a second copy is a second place the
 * gate can be forgotten.
 *
 * Everything above this point is format-specific: reading bytes, detecting an
 * encoding, and validating the MESHES. Everything from here down is not.
 */
export function commitImportedDocument(
  input: DocumentCommitInput,
  context: OperationContext,
): HandlerOutcome<ModelImportResult> {
  const { document } = input;

  /*
   * THE SECOND GATE. Structural mesh validity is not document validity: unique
   * part ids, a finite placement, a recognised unit and the document-wide
   * resource ceilings are questions only this can answer. Meshes are not
   * re-walked — the caller validated them moments ago and walking every
   * coordinate twice on import is exactly the kind of cost a large model cannot
   * absorb.
   */
  assertGeometryDocument(document, input.operation, { validateMeshes: false });

  context.reportProgress(VALIDATE_SHARE, 'preparing');

  /*
   * THE RESOURCE GATE — Stage 6D-R3, and it is the LAST THING BEFORE THE
   * SNAPSHOT because the snapshot is what it prevents.
   *
   * It bounds the geometry this document costs to open: its canonical buffers
   * plus the render snapshot `buildDocumentRenderSnapshot` is about to allocate
   * from them, counted once per DISTINCT mesh. Both terms are facts about the
   * document in hand, not predictions about the process — and the ceiling they
   * are compared against was calibrated against measured Chromium footprint on
   * the stated minimum host.
   *
   * WHAT IT REPLACED. `estimateImportPeak` / `checkImportPeak` summed five
   * quantities and called the total a session memory peak. It ran after the
   * transient peak it named, computed geometry from the SUMMED triangle count so
   * a thousand placements of one mesh were charged a thousand times, and counted
   * the candidate's render bytes twice. See ADR 0018's sibling in
   * docs/design/STAGE_6D_3MF_PRODUCTION_AND_LARGE_ENTRY_ARCHITECTURE.md.
   */
  const documentTriangles = documentTriangleCount(document);
  const cost = measureImportGeometry(document);
  const overBudget = checkImportGeometry(cost);
  if (overBudget) throw overBudget;

  const bounds = documentBounds(document);
  const render = buildDocumentRenderSnapshot(document);

  // TRANSACTIONAL. Nothing above this line touched the store, so a parse
  // failure, a validation failure, a budget rejection, or a cancellation leaves
  // any previously resident document exactly as it was.
  throwIfCancelled(context.cancellation);
  const handle = residentDocuments.commit(document);

  context.reportProgress(1, 'complete');

  const value: ModelImportResult = {
    handle,
    formatId: input.formatId,
    encoding: input.encoding,
    unsupportedFeatures: input.compatibility.unsupported,
    externalReferences: input.compatibility.externalReferences,
    unit: document.unit,
    bounds,
    triangleCount: documentTriangles,
    vertexCount: documentVertexCount(document),
    parts: describeParts(document),
    render,
    warnings: input.warnings,
    validation: summariseDocument(document),
    residentBytes: documentByteLength(document),
  };

  // Only the render snapshots are transferred. The canonical document stays here.
  return { value, transfer: documentRenderTransferables(render) };
}

/**
 * Names the parts an STL export will NOT contain.
 *
 * STL has one implicit part and no way to say otherwise, so exporting part A of
 * a three-part document genuinely loses B and C. Returning that as a warning is
 * the difference between a documented loss and a silent one. Whole-document
 * multi-part export waits for Stage 4A-2B, which can state the loss through a
 * conversion report rather than through a note attached to one file.
 */
function describeOmittedParts(document: GeometryDocument, exported: PartId): readonly Diagnostic[] {
  const omitted = document.parts.filter((part) => part.id !== exported);
  if (omitted.length === 0) return [];
  return [
    diagnostic(
      'STL_EXPORT_SINGLE_PART',
      `STL files hold one object, so this file contains only the selected part. ${String(omitted.length)} other ${omitted.length === 1 ? 'part was' : 'parts were'} not written.`,
      { exportedPartId: exported, omittedPartCount: omitted.length },
    ),
  ];
}

/** Whether a placement is exactly the identity. `===`, so a stored negative zero is still the identity, as in every document writer. */
function isIdentityPlacement(transform: PartTransform): boolean {
  for (let index = 0; index < 12; index += 1) {
    if (transform[index] !== IDENTITY_PART_TRANSFORM[index]) return false;
  }
  return true;
}

/**
 * Says that the file's coordinates are the part AS PLACED, not as stored (Stage C03-D).
 *
 * STL has no transform and no unit, so a placement survives only by being applied to the coordinates. The active-part export used to
 * write the part's local coordinates and say nothing, which put a placed, scaled or mirrored part somewhere other than where the
 * document has it. Only a part that actually has a placement carries this note: an unplaced part's file is the stored geometry.
 */
function describePlacementApplied(transform: PartTransform): readonly Diagnostic[] {
  if (isIdentityPlacement(transform)) return [];
  const mirrored = placementReversesOrientation(transform);
  return [
    diagnostic(
      'STL_EXPORT_PLACEMENT_APPLIED',
      mirrored
        ? "This part's placement, which mirrors it, was applied to the coordinates in the file, with the triangles turned so the surface still faces outward. STL stores no placement and no unit."
        : "This part's placement was applied to the coordinates in the file. STL stores no placement and no unit.",
      { mirrored },
    ),
  ];
}

export const modelExportHandler: OperationHandler<'model/export'> = async (payload, context) => {
  // Resolving the handle AND the part is also the staleness check: an export
  // queued against a document that has since been replaced, or naming a part
  // that no longer exists, fails here rather than silently writing out the
  // wrong geometry.
  const document = residentDocuments.resolve(payload.handle);
  if (!isDocument(document)) throw document;

  const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
  if (!isPart(part)) throw part;

  // Export must never produce a file from geometry we would refuse to load.
  assertMeshStructure(part.mesh, 'STL export');
  context.reportProgress(0.02, 'writing');

  /*
   * THE FILE DESCRIBES THE PART WHERE THE DOCUMENT HAS IT. `placeMesh` applies the placement once, in Float64, and turns the triangles
   * when the placement mirrors, so a closed part stays outward-facing. An unplaced part is written as stored, with no copy at all.
   * The placed copy is judged by the same structural gate as the stored one: producing geometry is not success. Nothing is written
   * back: the authoritative mesh keeps its local coordinates and the placement stays the part's one transform authority.
   */
  const placed = isIdentityPlacement(part.transform)
    ? part.mesh
    : placeMesh(part.mesh, part.transform);
  if (placed !== part.mesh) assertMeshStructure(placed, 'STL export (placed)');

  const writer = requireWriter(MeshFormatId.Stl);
  const written = await writer.write(placed, {
    cancellation: context.cancellation,
    budget: DEFAULT_IMPORT_BUDGET,
    encoding: payload.encoding,
    yieldToEventLoop,
    progress: progressReporter(
      (fraction, note) => {
        context.reportProgress(fraction, note);
      },
      0.02,
      1,
    ),
  });

  const value: StlExportResult = {
    bytes: written.bytes.buffer,
    byteLength: written.bytes.byteLength,
    encoding: payload.encoding,
    warnings: [
      ...written.warnings,
      ...describePlacementApplied(part.transform),
      ...describeOmittedParts(document, part.id),
    ],
  };

  return { value, transfer: [written.bytes.buffer] };
};

export const modelReleaseHandler: OperationHandler<'model/release'> = (payload) => {
  const documentId = payload.documentId as DocumentId;
  const released = residentDocuments.release(documentId);
  // The repair history for a released document describes geometry that no
  // longer exists. Retaining its inverse patch would hold bytes for a repair
  // nothing can reverse, and its reports would describe meshes nothing can
  // resolve.
  repairHistory.releaseDocument(documentId);
  // A candidate for a released document can never be committed — every guard in
  // `prepareCommit` would refuse it — so retaining a whole part's geometry for
  // it would be a leak with no upside.
  holeFillCandidates.releaseDocument(documentId);
  geometryEdits.releaseDocument(documentId);
  splitCandidates.releaseDocument(documentId);
  jointEdits.releaseDocument(documentId);
  booleanOperations.cancelDocument(documentId);
  topologyReports.release(documentId);
  const value: ModelReleaseResult = { released };
  return Promise.resolve({ value });
};

export const modelAnalyzeHandler: OperationHandler<'model/analyze'> = async (payload, context) => {
  // Resolving is also the staleness check: an analysis queued against a
  // document that has since been replaced — or naming a part that is not in
  // this revision — fails here rather than quietly producing a report
  // describing different geometry.
  const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
  if (!isPart(part)) throw part;

  const mesh = part.mesh;
  const faceCount = triangleCount(mesh);
  const cornerCount = Math.floor(mesh.positions.length / 3);

  // MEMORY PREFLIGHT. Topology scratch runs several times the size of the mesh,
  // so the estimate is checked BEFORE any bulk array is allocated. Refusing
  // with a typed error beats an out-of-memory crash that takes the tab with it.
  const workspaceBytes = estimateTopologyWorkspaceBytes(faceCount, cornerCount);
  const refusal = requestAnalysisWorkspace('model/analyze', workspaceBytes, {
    faceCount,
    cornerCount,
  });
  if (refusal) throw refusal;

  context.reportProgress(0, 'analyzing');

  const result = analyseTopology(mesh, {
    documentId: payload.handle.documentId,
    documentRevision: payload.handle.revision,
    partId: part.id,
    cancellation: context.cancellation,
    ...(payload.sampleLimit === undefined ? {} : { sampleLimit: payload.sampleLimit }),
    onProgress: (progress) => {
      context.reportProgress(progress.fraction, progress.phase);
    },
  });

  // Yield once before returning so a cancel queued during the synchronous
  // analysis is still observed rather than being overtaken by the result.
  await yieldToEventLoop();
  throwIfCancelled(context.cancellation);

  // Retained for the repair workflow, which is planned from a report and would
  // otherwise recompute this one immediately. Stored against the handle AND the
  // part, so it is returned only for the geometry it actually describes.
  topologyReports.set(payload.handle, part.id, result.report);

  const value: ModelAnalyzeResult = {
    // Echoed so a late report can be matched against the document and part the
    // application currently shows, and discarded if either has moved on.
    handle: payload.handle,
    partId: part.id,
    report: result.report,
    detail: result.detail,
  };

  return {
    value,
    transfer: [
      result.detail.boundaryEdges.buffer,
      result.detail.nonManifoldEdges.buffer,
      result.detail.windingConflictEdges.buffer,
      result.detail.degenerateFaces.buffer,
      result.detail.sampleVertexIds.buffer,
      result.detail.sampleVertexPositions.buffer,
    ],
  };
};
