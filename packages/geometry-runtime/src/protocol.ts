import type { Diagnostic, OperationId, SerializedAppError } from '@cadfixer/shared';
import type { MeshBounds, PartTransform } from '@cadfixer/mesh-core';
// Type-only, so no topology code is pulled into the main-thread bundle. The
// analysis contract is described here rather than left as `unknown`: this is a
// module boundary, and an unchecked one would let the worker and its consumer
// drift apart silently.
import type { TopologyDetail, TopologyReport } from '@cadfixer/mesh-topology';
import type {
  ConservativeRepairPlan,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairOperation,
  RepairValidation,
} from '@cadfixer/mesh-repair';
import type { DocumentHandle } from './resident-documents';
import type { RepairCandidateHandle } from './repair-candidates';
import type { HoleFillCandidateHandle } from './hole-fill-candidates';
import type { GeometryEditCandidateHandle, GeometryEditResourceAccounting } from './geometry-edit';
import type { SplitCandidateHandle, SplitCandidateSummary } from './split-candidates';
import type { SplitRequest } from './split-connectors';
import type {
  SurfaceTextureRequest,
  SurfaceTextureResult,
  TextureLayoutSummary,
} from './surface-texture';
import type { UndoableChangeKind } from './repair-history';
// Type-only, exactly as the topology and repair contracts are, so no engine
// code is pulled into the main-thread bundle. The VALUES the interface compares
// against are restated in `hole-fill.ts`.
import type { BoundaryLoopRefusal, HoleFillStatus, HoleFillValidationSummary } from './hole-fill';
import type { BoundaryFillOutcome, BoundaryFillPlan } from './boundary-fill';
import type { LocalRepairNotRun, LocalRepairOutcome, LocalRepairPlan } from './local-repair';

/**
 * Wire protocol between the main thread and geometry workers.
 *
 * Design rules:
 * - Every message carries an `OperationId` so several operations can be in
 *   flight on one worker without ambiguity.
 * - Every message is a plain structured-cloneable object. No class instances,
 *   no functions. Errors cross as `SerializedAppError`.
 * - The channel tag lets a worker ignore messages it does not own, and lets the
 *   protocol be versioned without guessing.
 */

export const PROTOCOL_CHANNEL = 'cadfixer.geometry.v1';

/**
 * Values eligible for a `postMessage` transfer list.
 *
 * Restricted to array buffers for now, which is all the geometry runtime moves.
 * `SharedArrayBuffer` is deliberately NOT transferable and must never be placed
 * in a transfer list — it is shared, not moved.
 */
/**
 * A `MessagePort`, described structurally.
 *
 * `geometry-runtime` compiles WITHOUT the DOM lib on purpose — it must be
 * unit-testable outside a browser, and naming `MessagePort` directly would drag
 * the whole DOM in. The two members below are all the protocol needs, and a
 * real port satisfies them structurally in both the DOM and WebWorker
 * definitions.
 */
export interface ProtocolPort {
  postMessage(message: unknown, transfer?: unknown[]): void;
  close(): void;
}

/**
 * Values that may legally be MOVED through `postMessage`.
 *
 * Buffers and ports, and nothing else. A `SharedArrayBuffer` is structurally an
 * `ArrayBufferLike` but must never appear in a transfer list — it is shared
 * between realms rather than moved, and transferring one throws at runtime.
 * `toTransferables` rejects it explicitly.
 */
export type TransferHandle = ArrayBufferLike | ProtocolPort;

/**
 * Operations the geometry runtime can perform, as a compile-time map from
 * operation name to its payload and result types.
 *
 * Stage 0 declares exactly one entry, and it is a diagnostic rather than a
 * geometry operation. Repair, convert, split, texture, and hollow will be added
 * here as they are implemented.
 */
export interface OperationMap {
  'runtime/self-test': {
    payload: SelfTestPayload;
    result: SelfTestResult;
  };
  'model/import': {
    payload: StlImportPayload;
    result: ModelImportResult;
  };
  'model/export': {
    payload: ModelExportPayload;
    result: StlExportResult;
  };
  'model/release': {
    payload: ModelReleasePayload;
    result: ModelReleaseResult;
  };
  'model/analyze': {
    payload: ModelAnalyzePayload;
    result: ModelAnalyzeResult;
  };
  /**
   * Hands the diagnostic worker a DISPOSABLE COPY of a model's geometry over a
   * MessageChannel port.
   *
   * The result is deliberately tiny: this operation exists to move geometry
   * WORKER-TO-WORKER, so the only thing that comes back to the page is
   * confirmation that the copy was sent. Returning the geometry would defeat
   * the entire point (ADR 0008).
   */
  'model/send-for-diagnostic': {
    payload: SendForDiagnosticPayload;
    result: SendForDiagnosticResult;
  };
  /**
   * Hands the export worker a DISPOSABLE SNAPSHOT of the whole document over a
   * MessageChannel.
   *
   * The same shape as `model/send-for-diagnostic`, and for the same reason: the
   * geometry travels worker to worker and the page learns only scalars. The
   * finished FILE comes back from the export worker directly, because that is
   * the artifact the user asked for.
   */
  'document/send-for-export': {
    payload: SendForExportPayload;
    result: SendForExportResult;
  };
  'repair/plan': {
    payload: RepairPlanPayload;
    result: RepairPlanOperationResult;
  };
  'repair/create-candidate': {
    payload: RepairCandidatePayload;
    result: RepairCandidateResult;
  };
  'repair/commit': {
    payload: RepairCommitPayload;
    result: RepairCommitResult;
  };
  'repair/discard': {
    payload: RepairDiscardPayload;
    result: RepairDiscardResult;
  };
  'repair/undo': {
    payload: RepairUndoPayload;
    result: RepairUndoResult;
  };
  /**
   * Lists the boundary components of one part as ORDERED, TARGETABLE loops.
   *
   * READ-ONLY, and the only way a caller can obtain a `boundaryLoopId`. There
   * is no other route: a fill names a loop by an identity the authoritative
   * worker produced from the geometry it holds, never by an index the interface
   * chose.
   */
  'holefill/list-loops': {
    payload: ListBoundaryLoopsPayload;
    result: ListBoundaryLoopsResult;
  };
  /**
   * Hands the disposable fill worker a copy of one part and awaits its verdict.
   *
   * The same worker-to-worker shape as `model/send-for-diagnostic`, with one
   * difference: this operation stays PENDING until the fill worker answers,
   * because the answer includes a CANDIDATE the authoritative worker has to
   * take ownership of. The page receives a handle and scalars; the geometry
   * never leaves the workers.
   */
  'holefill/send-for-fill': {
    payload: SendForFillPayload;
    result: SendForFillResult;
  };
  /** Releases a hole-fill candidate's geometry. Candidate-scoped. */
  'holefill/discard': {
    payload: HoleFillDiscardPayload;
    result: HoleFillDiscardResult;
  };
  /**
   * Draws one boundary component as a DISPOSABLE line-segment snapshot.
   *
   * A RENDER SNAPSHOT, not geometry. It exists so a user can see which opening
   * they have selected, it is built from authoritative geometry in the worker,
   * and it can never travel back: no operation accepts it, and nothing in the
   * document model can be constructed from it. The page may hold it for exactly
   * the reason it may hold the model's render buffers.
   */
  'holefill/boundary-preview': {
    payload: BoundaryPreviewPayload;
    result: BoundaryPreviewResult;
  };
  /**
   * Draws the PATCH of a stored candidate as a disposable triangle snapshot.
   *
   * THE PATCH ONLY, and read from the candidate the store already holds. It does
   * not re-triangulate, does not re-run the engine, and does not send the
   * candidate mesh — so what the user previews is, by construction, the suffix
   * of exactly the geometry Apply will commit.
   */
  'holefill/patch-preview': {
    payload: PatchPreviewPayload;
    result: PatchPreviewResult;
  };
  /**
   * Applies one stored, validated candidate. THE ONLY HOLE-FILL MUTATION.
   *
   * No geometry arrives from the page: the payload is four identifiers and the
   * worker resolves the candidate it already owns. Nothing is triangulated,
   * classified or validated for shape here — that happened when the candidate
   * was built, and re-running it would mean committing something other than what
   * was previewed.
   */
  'holefill/commit': {
    payload: HoleFillCommitPayload;
    result: HoleFillCommitResult;
  };
  'edit/preview': { payload: EditPreviewPayload; result: EditPreviewResult };
  'edit/commit': { payload: EditCommitPayload; result: EditCommitResult };
  'edit/discard': { payload: EditDiscardPayload; result: EditDiscardResult };
  'split/create': { payload: SplitCreatePayload; result: SplitCreateResult };
  'split/commit': { payload: SplitCommitPayload; result: SplitCommitResult };
  'split/discard': { payload: SplitDiscardPayload; result: SplitDiscardResult };
  'texture/select': { payload: TextureSelectPayload; result: TextureSelectResult };
  'texture/layout': { payload: TextureCreatePayload; result: TextureLayoutResult };
  'texture/create': { payload: TextureCreatePayload; result: TextureCreateResult };
}

/* ------------------------------------------------------------- geometry edit -- */

export interface EditPreviewPayload {
  readonly candidate: GeometryEditCandidateHandle;
}
export interface EditPreviewResult {
  readonly candidate: GeometryEditCandidateHandle;
  readonly render: RenderSnapshot;
}
export interface EditCommitPayload {
  readonly candidate: GeometryEditCandidateHandle;
  readonly expectedSource: DocumentHandle;
  readonly expectedPart: string;
}
export interface EditCommitResult {
  readonly handle: DocumentHandle;
  readonly parentRevision: number;
  readonly recordId: string;
  readonly partId: string;
  readonly render: RenderSnapshot;
  readonly parts: readonly PartDescriptor[];
  readonly residentBytes: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly bounds: MeshBounds | undefined;
  readonly resources: GeometryEditResourceAccounting;
}
export interface EditDiscardPayload {
  readonly candidate: GeometryEditCandidateHandle;
}
export interface EditDiscardResult {
  readonly released: boolean;
}

/* ------------------------------------------------------------------- split -- */
export interface SplitCreatePayload {
  readonly source: DocumentHandle;
  readonly partId: string;
  readonly request: SplitRequest;
}
export interface SplitCreateResult extends SplitCandidateSummary {
  readonly render: DocumentRenderSnapshot;
  readonly parts: readonly PartDescriptor[];
}
export interface SplitCommitPayload {
  readonly candidate: SplitCandidateHandle;
  readonly expectedSource: DocumentHandle;
  readonly expectedPart: string;
}
export interface SplitCommitResult extends SplitCandidateSummary {
  readonly handle: DocumentHandle;
  readonly parentRevision: number;
  readonly recordId: string;
  readonly render: DocumentRenderSnapshot;
  readonly parts: readonly PartDescriptor[];
  readonly residentBytes: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly bounds: MeshBounds | undefined;
}
export interface SplitDiscardPayload {
  readonly candidate: SplitCandidateHandle;
}
export interface SplitDiscardResult {
  readonly released: boolean;
}

/* --------------------------------------------------------- surface texture -- */
export interface TextureSelectPayload {
  readonly source: DocumentHandle;
  readonly partId: string;
  readonly seedTriangle: number;
}
export interface TextureSelectResult {
  readonly source: DocumentHandle;
  readonly partId: string;
  readonly triangleIds: readonly number[];
  readonly planarity: 'PLANAR' | 'NEAR_PLANAR';
  /** Summed area of the selected faces, part-local units squared. */
  readonly area: number;
  /** Summed area of every face of the part, for coverage. */
  readonly partArea: number;
}
/**
 * The layout a texture request would produce, from the engine's own layout
 * step — element count, the admission estimate and footprint outlines. No
 * geometry is built.
 */
export interface TextureLayoutResult extends TextureLayoutSummary {
  readonly source: DocumentHandle;
  readonly partId: string;
}
export interface TextureCreatePayload {
  readonly source: DocumentHandle;
  readonly partId: string;
  readonly request: SurfaceTextureRequest;
}
export interface TextureCreateResult extends Omit<SurfaceTextureResult, 'mesh'> {
  readonly candidate: GeometryEditCandidateHandle;
  readonly resources: GeometryEditResourceAccounting;
  readonly render: RenderSnapshot;
}

/* --------------------------------------------------------------- hole fill -- */

export interface ListBoundaryLoopsPayload {
  readonly handle: DocumentHandle;
  readonly partId: string;
  /** Bounded: a mesh of loose triangles has one boundary component per face. */
  readonly limit?: number;
}

/**
 * One boundary component, described in SCALARS.
 *
 * NO COORDINATES. The interface needs to know an opening exists, how big it is,
 * and whether it can be filled; it does not need the ring of points, and
 * shipping one would put geometry in React state.
 */
export interface BoundaryLoopSummary {
  readonly boundaryLoopId: string;
  readonly vertexCount: number;
  readonly edgeCount: number;
  /** True when this component is one ordered, fillable cycle. */
  readonly fillable: boolean;
  /** Why not, when `fillable` is false. A code, never a sentence. */
  readonly refusal?: BoundaryLoopRefusal;
}

export interface ListBoundaryLoopsResult {
  readonly handle: DocumentHandle;
  readonly partId: string;
  /**
   * Whether the boundary walk was performed at all.
   *
   * FALSE IS NOT "NO OPENINGS" — Stage 6D-R3. A part above
   * `HOLE_FILL_MAX_PART_FACES` cannot have any opening filled, so the walk is
   * not started: it is the largest unbounded allocation an import can trigger,
   * and it would produce an inventory nobody could act on. When this is false
   * `loopCount` is zero because nothing counted, and the interface must say that
   * rather than report a model with openings as a model without.
   */
  readonly inventoried: boolean;
  /** Exact count, even when `loops` was capped. Zero when not `inventoried`. */
  readonly loopCount: number;
  readonly loops: readonly BoundaryLoopSummary[];
  readonly truncated: boolean;
  /**
   * Triangles in this part.
   *
   * Reported so the interface can state a resource refusal BEFORE it starts
   * anything. A part above `HOLE_FILL_MAX_PART_FACES` will be refused by the
   * engine no matter which opening is chosen, and spinning up a worker and
   * copying tens of megabytes to learn a scalar the worker already knows is
   * work nobody needs done.
   */
  readonly partFaceCount: number;
}

/* ------------------------------------------------- hole fill: previews -- */

export interface BoundaryPreviewPayload {
  readonly handle: DocumentHandle;
  readonly partId: string;
  /** From `holefill/list-loops`. Never an index, never a described boundary. */
  readonly boundaryLoopId: string;
}

/**
 * A boundary rim, ready to draw.
 *
 * PART-LOCAL COORDINATES, exactly as the render snapshot is. The part's
 * `PartTransform` is applied by the viewport to the object that holds this, for
 * the same reason it is applied to the model: baking a placement into
 * coordinates is a display concern rewriting geometry.
 */
export interface BoundaryPreviewResult {
  readonly handle: DocumentHandle;
  readonly partId: string;
  readonly boundaryLoopId: string;
  /**
   * Flattened line-segment endpoints: six floats per rim edge.
   *
   * `LineSegments` order — a pair per edge rather than a strip — so the rim
   * draws as one buffer and one draw call regardless of how many edges it has.
   */
  readonly positions: Float32Array;
  readonly vertexCount: number;
  readonly edgeCount: number;
}

export interface PatchPreviewPayload {
  readonly candidate: HoleFillCandidateHandle;
}

/**
 * The generated patch, ready to draw.
 *
 * NON-INDEXED TRIANGLES, nine floats per face, plus flat normals. Only the patch
 * faces — `[sourceFaceCount, candidateFaceCount)` — travel, so a fill on a
 * 250,000-face part sends a few kilobytes rather than the whole candidate.
 *
 * THE CANDIDATE'S IDENTITY IS ECHOED so a snapshot that arrives after the user
 * has moved on can be discarded rather than drawn over geometry it does not
 * describe.
 */
export interface PatchPreviewResult {
  readonly candidate: HoleFillCandidateHandle;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly triangleCount: number;
  /** Patch bounds, so frustum culling never walks the buffer on the UI thread. */
  readonly bounds: MeshBounds | undefined;
}

/* --------------------------------------------------- hole fill: commit -- */

export interface HoleFillCommitPayload {
  readonly candidate: HoleFillCandidateHandle;
  /** The revision the caller believes is authoritative. Re-checked. */
  readonly expectedSource: DocumentHandle;
  /** The part the caller believes it is replacing. Re-checked against the candidate. */
  readonly expectedPart: string;
  /** The opening the caller believes it is closing. Re-checked too. */
  readonly expectedLoopId: string;
}

export interface HoleFillCommitResult {
  /** The NEW revision. Same document id, same part id, same lineage. */
  readonly handle: DocumentHandle;
  readonly parentRevision: number;
  /** Identity of this change in the ONE undo history. */
  readonly recordId: string;
  readonly partId: string;
  readonly boundaryLoopId: string;
  /** Faces the patch added. Never a claim about the model's health. */
  readonly patchFaceCount: number;
  /** Drawable buffers for the FILLED PART ONLY. See `RepairCommitResult.render`. */
  readonly render: RenderSnapshot;
  /** Part metadata for the whole successor document. See `RepairCommitResult.parts`. */
  readonly parts: readonly PartDescriptor[];
  readonly residentBytes: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly bounds: MeshBounds | undefined;
  readonly undoable: boolean;
}

export interface SendForFillPayload {
  readonly handle: DocumentHandle;
  readonly partId: string;
  /** Resolved by the AUTHORITATIVE worker against the geometry it holds. */
  readonly boundaryLoopId: string;
  readonly operationId: string;
  readonly port: ProtocolPort;
  /** May only NARROW the production ceilings. The worker clamps. */
  readonly limits?: Partial<HoleFillLimitsPayload>;
}

/** The subset of the engine's limits a message is allowed to carry. */
export interface HoleFillLimitsPayload {
  readonly maxBoundaryVertices: number;
  readonly maxPartFaces: number;
  readonly maxAabbTests: number;
  readonly maxBvhNodeVisits: number;
  readonly maxBroadphaseCandidates: number;
  readonly maxNarrowphasePairs: number;
  readonly maxSamples: number;
}

export interface SendForFillResult {
  readonly status: HoleFillStatus;
  readonly summary: HoleFillValidationSummary;
  /**
   * Present ONLY when the status is `VALID_CANDIDATE`.
   *
   * A handle, not a mesh. The candidate stays resident in the authoritative
   * worker; Stage 4B-1B2 will add preview and apply on top of this handle
   * without the page ever holding a coordinate.
   */
  readonly candidate?: HoleFillCandidateHandle;
  /**
   * The AUTHORITATIVE preservation verdict — Stage 4B-1B1-R1.
   *
   * Set by the geometry worker by comparing the returned candidate against the
   * RESIDENT part, byte for byte, immediately before registration. The engine's
   * own check runs inside the fill worker where the candidate shares the
   * source's buffer, so it cannot independently prove the source was not
   * rewritten; this one can, because the two sides crossed a thread boundary.
   *
   * Absent when no candidate geometry came back, because there was nothing to
   * compare.
   */
  readonly sourcePositionsPreserved?: boolean;
  readonly sourceFacePrefixPreserved?: boolean;
  /** Bounded (faceA, faceB, category) triples. Diagnostic only. */
  readonly intersectionSamples: Uint32Array;
  readonly samplesTruncated: boolean;
}

export interface HoleFillDiscardPayload {
  readonly candidate: HoleFillCandidateHandle;
}

export interface HoleFillDiscardResult {
  readonly released: boolean;
}

/* ------------------------------------------------------------------ repair -- */

/**
 * CONSERVATIVE REPAIR OVER THE WIRE.
 *
 * Deliberately four operations rather than one. Planning must be observable
 * without allocating a candidate, and applying must be a separate, explicitly
 * confirmed act — a single `repair/apply` would make preview impossible and
 * would make an accidental double-send destructive.
 *
 * `model/analyze` is NOT overloaded with any of this. Analysis is read-only and
 * must stay that way; a repair verb hidden inside it would make every analysis
 * a potential mutation.
 *
 * NO GEOMETRY CROSSES for any of these. The main thread sends handles,
 * revisions and operation names; it receives plans, reports, counts and bounded
 * samples. Candidate geometry stays worker-resident exactly as authoritative
 * geometry does.
 */
export interface RepairPlanPayload {
  readonly handle: DocumentHandle;
  /** The part to repair. Repair operates on exactly one part's mesh. */
  readonly partId: string;
  /** What the caller wants attempted. The plan never widens this. */
  readonly requested: readonly RepairOperation[];
  /** Refuse before allocating if the estimated peak exceeds this. */
  readonly memoryBudgetBytes?: number;
  /**
   * Also plan automatic filling of eligible simple planar openings —
   * REPAIR-CORE-02. Absent or false: nothing is scanned.
   */
  readonly fillOpenings?: boolean;
  /**
   * Also plan the LOCAL PINCH REPAIR — REPAIR-CORE-06A: the primary pinch search and the bounded
   * residual phase. Absent or false: no pinch is counted and the plan says it was not requested.
   */
  readonly localRepair?: boolean;
  /**
   * A channel to a disposable verifier — REPAIR-RC-03. When present and the
   * plan admits openings, the exact intersection check runs NOW, so the plan
   * the user sees counts only openings that passed it. Absent: the plan is
   * returned unverified (`verified: false`) and says nothing is fillable yet.
   */
  readonly verifierPort?: ProtocolPort;
}

export interface RepairPlanOperationResult {
  readonly handle: DocumentHandle;
  readonly partId: string;
  readonly plan: ConservativeRepairPlan;
  /** What automatic filling would attempt. `NOT_REQUESTED` when not asked for. */
  readonly boundaryFill: BoundaryFillPlan;
  /** What the local pinch repair would attempt, from topology alone. Absent when not asked for. */
  readonly localRepair?: LocalRepairPlan;
}

export interface RepairCandidatePayload {
  readonly handle: DocumentHandle;
  readonly partId: string;
  readonly requested: readonly RepairOperation[];
  /**
   * The plan the caller previewed.
   *
   * Checked against a freshly computed plan: if the model or the request has
   * changed, the candidate is refused rather than silently built from a
   * different plan than the one that was shown.
   */
  readonly planHash: string;
  readonly memoryBudgetBytes?: number;
  readonly sampleLimit?: number;
  /** Fill eligible openings as part of this candidate — REPAIR-CORE-02. */
  readonly fillOpenings?: boolean;
  /** `BoundaryFillPlan.planHash` the caller saw. Re-checked against the source. */
  readonly fillPlanHash?: string;
  /** Run the local pinch repair as part of this candidate — REPAIR-CORE-06A. */
  readonly localRepair?: boolean;
  /** `LocalRepairPlan.planHash` the caller saw. Re-checked against the conservative candidate's source. */
  readonly localRepairPlanHash?: string;
  /**
   * A channel to a disposable worker that runs the exact intersection check on
   * the LOCAL region of the patches. Without it no opening can be verified, and
   * none is filled.
   */
  readonly verifierPort?: ProtocolPort;
}

/**
 * Everything Stage 3B-1B needs to build a preview, and nothing more.
 *
 * The candidate render snapshot is deliberately NOT included by default: it
 * doubles the transfer for a preview the caller may not display. It is
 * requested separately when the UI actually needs to draw the result.
 */
export interface RepairCandidateResult {
  readonly candidate: RepairCandidateHandle | undefined;
  readonly source: DocumentHandle;
  /** The part the candidate replaces. Never inferred at commit. */
  readonly partId: string;
  readonly plan: ConservativeRepairPlan;
  readonly validation: RepairValidation;
  readonly counts: RepairChangeCounts;
  readonly samples: RepairChangeSamples;
  /**
   * Bytes the undo record will retain if this candidate is applied.
   *
   * THE SOURCE MESH'S OWN SIZE — Stage 4B-1C. It used to be a patch of the
   * removed triangles; undo now restores the exact previous `CanonicalMesh`
   * object, so this is an upper bound on the record's cost and zero extra
   * whenever a sibling part still references that mesh.
   */
  readonly undoRetainedBytes: number;
  readonly candidateBounds: MeshBounds | undefined;
  readonly render: RenderSnapshot | undefined;
  /** What the fill stage did. Undefined when filling was not requested. */
  readonly boundaryFill: BoundaryFillOutcome | undefined;
  /**
   * What the local pinch repair did — REPAIR-CORE-06A. Undefined when it was not requested or
   * could not run (see `localRepairNotRun`). A LIMIT is in here as a typed outcome, never an error.
   */
  readonly localRepair?: LocalRepairOutcome;
  readonly localRepairNotRun?: LocalRepairNotRun;
  /**
   * THE PATCH ONLY, when filling is the only change — REPAIR-CORE-02. Every
   * existing triangle is untouched, so the preview draws these beside the model
   * the viewport already holds instead of uploading a second copy of a
   * multi-million-triangle part. `render` is then undefined.
   */
  readonly patchRender: RenderSnapshot | undefined;
}

export interface RepairCommitPayload {
  readonly candidate: RepairCandidateHandle;
  /** The revision the caller believes is authoritative. Re-checked. */
  readonly expectedSource: DocumentHandle;
  /** The part the caller believes it is replacing. Re-checked against the candidate. */
  readonly expectedPart: string;
  /** Identity of the validation the caller accepted. */
  readonly planHash: string;
}

export interface RepairCommitResult {
  /** The NEW revision. Same lineage, parent recorded below. */
  readonly handle: DocumentHandle;
  readonly parentRevision: number;
  readonly repairRecordId: string;
  /** The part that changed. Every other part is unchanged and still shared. */
  readonly partId: string;
  readonly appliedOperations: readonly RepairOperation[];
  /**
   * Drawable buffers for the REPAIRED PART ONLY.
   *
   * The other parts did not change, so re-sending them would move megabytes to
   * redraw pixels that are already correct. The viewport swaps one part's
   * geometry and leaves the rest of the scene alone.
   */
  readonly render: RenderSnapshot;
  /**
   * Part metadata for the WHOLE successor document.
   *
   * Sent rather than patched on the main thread because only the worker knows
   * what actually happened: a repaired part may have stopped sharing its mesh
   * with another part, and `meshResourceIndex` is not derivable from anything
   * the page holds. Scalars and strings, so it costs kilobytes.
   */
  readonly parts: readonly PartDescriptor[];
  readonly residentBytes: number;
  /**
   * Facts about the committed geometry, so the application can update the model
   * it displays without re-deriving anything from the render snapshot.
   *
   * They are computed in the worker, which already holds the mesh. Counting
   * triangles from a Float32Array on the UI thread would be exactly the
   * whole-mesh main-thread work this project forbids.
   */
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly bounds: MeshBounds | undefined;
  /** True when this revision can be reversed by `repair/undo`. */
  readonly undoable: boolean;
}

export interface RepairDiscardPayload {
  readonly candidate: RepairCandidateHandle;
}

export interface RepairDiscardResult {
  /** False when there was nothing left to release. Not an error. */
  readonly released: boolean;
}

/**
 * UNDO IS A TRANSACTION, not a view change.
 *
 * It names the repair it reverses AND the revision it believes is authoritative,
 * exactly as commit does. Reversing "the last thing" without saying which would
 * make undo unsafe the moment two operations can be in flight.
 *
 * The restored geometry becomes a NEW monotonic revision rather than reviving
 * the old one — see docs/adr/0011. A revision number that could go backwards
 * would make every stale-handle check in the runtime ambiguous.
 */
export interface RepairUndoPayload {
  /** The revision the caller believes is authoritative: the repaired one. */
  readonly handle: DocumentHandle;
  /** Identity of the commit being reversed. */
  readonly recordId: string;
}

export interface RepairUndoResult {
  /** The NEW revision, holding the restored pre-repair geometry. */
  readonly handle: DocumentHandle;
  /** The revision that was authoritative before the undo. */
  readonly revertedRevision: number;
  /** The revision whose geometry has been reproduced. */
  readonly restoredRevision: number;
  readonly recordId: string;
  /**
   * Which kind of change was reversed.
   *
   * Reported so the interface can say what actually happened rather than
   * guessing from an empty operation list. A hole fill and a repair that
   * happened to apply no operations would otherwise be indistinguishable.
   */
  readonly kind: UndoableChangeKind;
  /** The part whose geometry was restored. */
  readonly partId: string;
  /** Empty for a hole fill. */
  readonly appliedOperations: readonly RepairOperation[];
  /** Drawable buffers for the RESTORED PART ONLY. See `RepairCommitResult.render`. */
  readonly render: RenderSnapshot;
  /** Present when undo restores an entire ordered document graph after a split. */
  readonly documentRender?: DocumentRenderSnapshot;
  /** Part metadata for the whole restored document. See `RepairCommitResult.parts`. */
  readonly parts: readonly PartDescriptor[];
  readonly residentBytes: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly bounds: MeshBounds | undefined;
}

/* -------------------------------------------------------------- stl import -- */

export interface StlImportPayload {
  /**
   * The file's name, for FORMAT IDENTIFICATION only.
   *
   * Never trusted on its own: the worker decides what a file is from its bytes
   * and consults this only to break the one ambiguity bytes cannot settle —
   * plain text that could be OBJ or ASCII STL — and to report a mismatch when
   * the name and the content disagree. It is also untrusted TEXT: it is never
   * resolved as a path and never used to open anything.
   */
  readonly fileName: string;
  /**
   * The whole file. Transferred, so the main thread loses access the moment
   * dispatch returns — see docs/ARCHITECTURE.md on transfer ownership.
   */
  readonly bytes: ArrayBufferLike;
  /**
   * Optional limit overrides. Shaped as plain numbers rather than the
   * format layer's `ImportBudget` type so the protocol does not depend on
   * `@cadfixer/file-formats`.
   */
  readonly budget?: Readonly<Record<string, number>>;
}

/**
 * Geometry the UI needs in order to DRAW a model — and nothing more.
 *
 * THE DISTINCTION THAT MATTERS: the authoritative `CanonicalMesh` stays in the
 * worker. This is a derived, read-only view of it, safe to transfer to the main
 * thread and hand to the GPU. The two must not be confused: the snapshot is
 * regenerable at any time, whereas the canonical mesh is the user's data.
 *
 * Positions are NON-INDEXED. STL is triangle soup, so its indices are the
 * sequence 0,1,2,3,… and carry no information; sending them would cost 24 MiB
 * per two million triangles to tell the GPU what it already assumes. The worker
 * keeps the real index buffer because later operations need it.
 */
export interface RenderSnapshot {
  /** Interleaved XYZ, three vertices per triangle, drawn non-indexed. */
  readonly positions: Float32Array;
  /**
   * Per-vertex normals derived from the geometry, for display only.
   *
   * They are not what the file said, and canonical data is never rewritten for
   * presentation. Computed in the worker because deriving them is a
   * per-triangle cross product over the whole mesh.
   */
  readonly normals: Float32Array;
  readonly vertexCount: number;
}

/**
 * WHAT THE MAIN THREAD IS ALLOWED TO KNOW ABOUT A PART.
 *
 * Identifiers, a name, a placement and scalar counts. NOT the mesh, and not the
 * canonical buffers: those stay worker-resident exactly as they did when a
 * model was one mesh. Everything here is either a string, a number, or the
 * twelve numbers of a placement, so a hundred-part document costs the page a
 * few kilobytes of metadata rather than a hundred meshes.
 */
export interface PartDescriptor {
  /** Stable within the document. Names the part in every part-targeted request. */
  readonly partId: string;
  readonly name?: string;
  readonly transform: PartTransform;
  readonly triangleCount: number;
  readonly vertexCount: number;
  /** In PART-LOCAL coordinates, before the placement above is applied. */
  readonly bounds: MeshBounds | undefined;
  /**
   * Which distinct mesh resource this part uses.
   *
   * Parts with EQUAL indices share one authoritative mesh in the worker. This
   * exists so the page can reason about — and a test can assert — structural
   * sharing without ever seeing the geometry that is shared.
   */
  readonly meshResourceIndex: number;

  /* ------------------------------------------------ conversion features -- */
  /**
   * The rest of this interface exists so the page can answer "what would be
   * lost if this were saved as OBJ?" without asking the worker and without
   * touching geometry.
   *
   * WHY NOT A WORKER ROUND TRIP. A report fetched once goes stale the moment a
   * repair lands, and a dialog holding a stale report is exactly the hazard
   * Stage 4A-2B3 has to rule out. Derived from descriptors the page already
   * holds, the report is a pure function of current state and recomputes for
   * free when that state changes — there is no window in which it can describe
   * a revision the user has moved off.
   *
   * All of it is scalar: three counts and a short opaque string. A thousand-part
   * document pays a few kilobytes, which is what the rest of this interface
   * already costs.
   */
  /** Opaque material reference this PART names, when the source had one. */
  readonly materialRef?: string;
  /** Canonical groups in this part's mesh. Shared meshes report the same count. */
  readonly groupCount: number;
  /** Groups in this part's mesh that name a material. A subset of `groupCount`. */
  readonly groupMaterialRefCount: number;
  /** True when this part's mesh stores per-vertex normals. */
  readonly hasNormals: boolean;
  /** True when this part's mesh stores per-vertex texture coordinates. */
  readonly hasUvs: boolean;
}

/**
 * One part's drawable buffers.
 *
 * The placement is carried BESIDE the positions, never baked into them: the
 * renderer applies it as an object transform, so two parts sharing one mesh
 * resource can share these buffers too and still stand in different places.
 */
export interface PartRenderSnapshot {
  readonly partId: string;
  readonly transform: PartTransform;
  /** Interleaved XYZ, three vertices per triangle, drawn non-indexed. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly vertexCount: number;
}

/** Everything the viewport needs to draw a whole document. */
export interface DocumentRenderSnapshot {
  readonly parts: readonly PartRenderSnapshot[];
}

/**
 * Everything the application needs about an imported model.
 *
 * Statistics are computed IN THE WORKER, during the pass that already has the
 * positions in cache, so the main thread never walks a multi-million-triangle
 * buffer to fill in a details panel.
 */
export interface ModelImportResult {
  /** Identifies the DOCUMENT that now lives in the worker. */
  readonly handle: DocumentHandle;
  /** `binary` or `ascii`, as actually detected — never guessed from the name. */
  readonly encoding: string;
  /**
   * The unit the source stated, or `undefined` when it stated none.
   *
   * Carried explicitly because the main thread no longer holds the mesh and so
   * cannot read its metadata. `undefined` is meaningful — STL has no unit field
   * — and must not be flattened into a default on the way across.
   */
  readonly unit: string | undefined;
  /**
   * The document's world-space extent, for framing the camera.
   *
   * Unions each part's local box AFTER its placement, so a document whose parts
   * are spread out frames all of them rather than only the first.
   */
  readonly bounds: MeshBounds | undefined;
  /** Summed across every part. */
  readonly triangleCount: number;
  readonly vertexCount: number;
  /** Ordered as the document orders its parts. */
  readonly parts: readonly PartDescriptor[];
  readonly render: DocumentRenderSnapshot;
  readonly warnings: readonly Diagnostic[];
  /**
   * Which format was actually read, as identified from the BYTES.
   *
   * Reported rather than echoed from the file name, so the panel can say what
   * CAD Fixer actually opened.
   */
  readonly formatId: string;
  /**
   * Source features the reader recognised and did not import.
   *
   * Empty for an ordinary file. A valid STL or a plain OBJ must not be
   * decorated with warnings about things it never contained.
   */
  readonly unsupportedFeatures: readonly string[];
  /**
   * Opaque names the source referred to and CAD Fixer never opened.
   *
   * An OBJ `mtllib` is the only producer today. Carried as TEXT for display:
   * nothing resolves it, nothing fetches it, and nothing asks the user for it.
   * Reported so a later conversion can say the reference existed and was not
   * followed, rather than leaving the user to wonder where their materials went.
   */
  readonly externalReferences: readonly string[];
  /** Structural validation summary. The import already passed the gate. */
  readonly validation: MeshValidationSummary;
  /** Bytes of authoritative geometry the worker now holds for this model. */
  readonly residentBytes: number;
}

export interface MeshValidationSummary {
  readonly valid: boolean;
  readonly issueCount: number;
  readonly warningCount: number;
  readonly truncated: boolean;
  /** Issue codes, deduplicated, for display. Never geometry. */
  readonly codes: readonly string[];
}

/* -------------------------------------------------------------- stl export -- */

/**
 * Export names a resident model rather than carrying geometry.
 *
 * This is the whole point of the resident runtime: Stage 1 structured-cloned
 * the entire canonical mesh from the main thread into the worker on every
 * export — about 96 MiB for a two-million-triangle model. Now nothing larger
 * than a handle crosses the boundary.
 */
export interface ModelExportPayload {
  readonly handle: DocumentHandle;
  /**
   * The part to write.
   *
   * STL HAS ONE IMPLICIT PART. It has no way to say "these are three separate
   * objects", so exporting a multi-part document to STL either flattens it —
   * losing the structure the document exists to preserve — or writes one part.
   * This operation writes ONE, names it explicitly, and returns a warning
   * listing what was left out. Whole-document STL export waits for Stage
   * 4A-2B's conversion report, which can state the loss properly.
   */
  readonly partId: string;
  readonly encoding: string;
}

/**
 * Topology analysis names a resident model rather than sending one.
 *
 * WHAT ACTUALLY CROSSES, precisely:
 *
 *   main → worker   a handle, a revision, and configuration. Nothing else. The
 *                   main thread never sends canonical geometry into the worker
 *                   for analysis, because it does not hold any.
 *   worker → main   counts, statuses, and BOUNDED DIAGNOSTIC SAMPLES. The
 *                   samples are geometry-derived on purpose — sampled vertex
 *                   positions and edge endpoints exist so the viewport can draw
 *                   the defects — and they are capped by `sampleLimit`, not by
 *                   mesh size.
 *
 * Authoritative canonical geometry stays worker-resident throughout and is never
 * returned by this operation. Render snapshots are a separate, separately
 * defined transfer and are likewise not the authoritative geometry.
 *
 * "No geometry crosses the boundary" would be a convenient thing to say here
 * and it would be false: bounded samples are geometry, deliberately.
 *
 * The handle carries the revision the caller believes it is analysing, so an
 * analysis queued against a model that has since been replaced fails rather
 * than silently producing a report for different geometry.
 */
export interface ModelAnalyzePayload {
  readonly handle: DocumentHandle;
  /**
   * The part to analyse.
   *
   * PART-TARGETED, NOT DOCUMENT-WIDE. Analysing every part as one mesh would
   * report shared edges between parts the file declared separate, which is a
   * claim about the model that nothing checked.
   */
  readonly partId: string;
  /** Caps retained detail samples per category. */
  readonly sampleLimit?: number;
}

/**
 * The report, plus the identity it was computed for.
 *
 * `handle` is echoed so a consumer can discard a late report belonging to a
 * model it has already replaced — the application cannot rely on arrival order.
 */
export interface ModelAnalyzeResult {
  readonly handle: DocumentHandle;
  /**
   * Echoed alongside the handle so a consumer can discard a report for a part
   * it is no longer showing. A late report for part A must never be displayed
   * as part B's.
   */
  readonly partId: string;
  readonly report: TopologyReport;
  readonly detail: TopologyDetail;
}

export interface ModelReleasePayload {
  readonly documentId: string;
}

/**
 * Operation scope, recorded here so the classification is part of the protocol
 * rather than of somebody's memory.
 *
 *   runtime/self-test           — neither; carries no geometry
 *   model/import                — DOCUMENT-level: produces a whole document
 *   model/release               — DOCUMENT-level
 *   model/export                — PART-targeted
 *   model/analyze               — PART-targeted
 *   model/send-for-diagnostic   — PART-targeted
 *   repair/plan                 — PART-targeted
 *   repair/create-candidate     — PART-targeted
 *   repair/commit               — PART-targeted; commits a DOCUMENT revision
 *   repair/discard              — candidate-scoped (the candidate names its part)
 *   repair/undo                 — DOCUMENT-level transaction restoring one part,
 *                                 for a conservative repair OR a hole fill: one
 *                                 history, one Undo, one most-recent change
 *   holefill/list-loops         — PART-targeted; read-only
 *   holefill/send-for-fill      — PART-targeted; produces a CANDIDATE only
 *   holefill/discard            — candidate-scoped (the candidate names its part)
 *   holefill/boundary-preview   — PART-targeted; read-only, disposable snapshot
 *   holefill/patch-preview      — candidate-scoped; read-only, disposable snapshot
 *   holefill/commit             — PART-targeted; commits a DOCUMENT revision
 *
 * Every part-targeted request carries its `partId` EXPLICITLY. The authoritative
 * worker never infers a target from UI selection state: a request is executable
 * from its payload alone, or it is refused.
 */

export interface ModelReleaseResult {
  readonly released: boolean;
}

export interface StlExportResult {
  /** Encoded file bytes, transferred back to the caller. */
  readonly bytes: ArrayBufferLike;
  readonly byteLength: number;
  readonly encoding: string;
  /** Non-fatal findings, e.g. grouping that the chosen encoding cannot carry. */
  readonly warnings: readonly Diagnostic[];
}

/**
 * Asks the authoritative worker to copy a model's geometry to a diagnostic
 * worker through `port`.
 *
 * `port` is transferred. The GEOMETRY is not: the authoritative worker builds a
 * fresh Float64 copy and transfers that, so its own canonical buffers are never
 * detached and survive whatever happens to the diagnostic worker.
 */
export interface SendForDiagnosticPayload {
  readonly handle: DocumentHandle;
  /**
   * The part to copy.
   *
   * Self-intersection asks whether ONE part's own faces cross. Two independent
   * parts that overlap in world space are not self-intersecting, and sending a
   * flattened document would report exactly that falsehood. Inter-part overlap
   * is a different question with no implementation — see ADR 0013.
   */
  readonly partId: string;
  readonly operationId: string;
  readonly port: ProtocolPort;
  readonly limits: {
    readonly maxCandidatePairs: number;
    readonly maxTestedPairs: number;
    readonly maxSamples: number;
  };
}

export interface SendForExportPayload {
  readonly handle: DocumentHandle;
  /** `stl`, `obj` or `3mf`. Validated in the export worker, not trusted here. */
  readonly target: string;
  readonly operationId: string;
  readonly port: ProtocolPort;
  /**
   * What the user says this document's numbers mean, for THIS export only.
   *
   * USED ONLY WHEN THE DOCUMENT STATES NO UNIT, which the authoritative worker
   * decides — not the caller. The document is not edited, its revision does not
   * move, and nothing is rescaled: the assertion travels on a disposable
   * snapshot and dies with it. See ADR 0017.
   */
  readonly unitAssertion?: string;
}

export interface SendForExportResult {
  /** Parts in the snapshot that was sent. Scalar only. */
  readonly partCount: number;
  /** DISTINCT meshes copied — one per shared resource, never one per part. */
  readonly meshResourceCount: number;
  readonly triangleCount: number;
  /** The revision the snapshot describes, so a stale result can be rejected. */
  readonly revision: number;
}

export interface SendForDiagnosticResult {
  /** Faces in the copy that was sent. Scalar only. */
  readonly faceCount: number;
  readonly vertexCount: number;
}

export type OperationName = keyof OperationMap;

export type OperationPayload<K extends OperationName> = OperationMap[K]['payload'];
export type OperationResult<K extends OperationName> = OperationMap[K]['result'];

/**
 * Proof-of-life payload. Exercises the full protocol surface — buffer transfer,
 * chunked progress, and cancellation polling — without doing geometry work.
 */
export interface SelfTestPayload {
  /** Buffer transferred to the worker. Ownership moves with it. */
  readonly bytes: ArrayBufferLike;
  /** Number of progress steps to report while scanning. Must be at least 1. */
  readonly chunks: number;
}

export interface SelfTestResult {
  /** The same buffer, transferred back. */
  readonly bytes: ArrayBufferLike;
  readonly byteLength: number;
  /** Sum of all bytes modulo 2^32. Deterministic, so tests can assert on it. */
  readonly checksum: number;
}

export interface RequestMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'request';
  readonly id: OperationId;
  readonly operation: OperationName;
  readonly payload: unknown;
  /**
   * A four-byte shared control word carrying this operation's cancel flag.
   *
   * ON THE ENVELOPE, NOT IN A PAYLOAD, because cancellation is a property of an
   * OPERATION rather than of any particular operation's arguments. Putting it
   * here means the worker host can build an interruptible
   * `OperationContext.cancellation` for every handler uniformly, and no handler
   * has to remember to adopt it.
   *
   * WHY IT EXISTS AT ALL: the `cancel` message below cannot interrupt a
   * synchronous handler, because a worker does not read its message queue while
   * one is running. A polled flag that cannot change is not cancellation. This
   * word is written with `Atomics.store` on the main thread and read with
   * `Atomics.load` inside the worker's own loops, so it crosses threads without
   * the event loop's involvement.
   *
   * SHARED, NOT TRANSFERRED. A `SharedArrayBuffer` must never appear in a
   * transfer list — it is shared by structured clone, and transferring it would
   * detach the sender's view of the very flag it needs to set.
   *
   * Optional so the protocol still describes environments without cross-origin
   * isolation, and so existing operations that never adopted it keep working.
   */
  readonly cancellation?: SharedArrayBuffer;
}

export interface CancelMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'cancel';
  readonly id: OperationId;
}

export interface ProgressMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'progress';
  readonly id: OperationId;
  /** Clamped to 0..1 by the sender. */
  readonly fraction: number;
  readonly note?: string;
}

export interface ResultMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'result';
  readonly id: OperationId;
  readonly value: unknown;
}

export interface ErrorMessage {
  readonly channel: typeof PROTOCOL_CHANNEL;
  readonly kind: 'error';
  readonly id: OperationId;
  readonly error: SerializedAppError;
}

/** Main thread -> worker. */
export type HostBoundMessage = RequestMessage | CancelMessage;

/** Worker -> main thread. */
export type ClientBoundMessage = ProgressMessage | ResultMessage | ErrorMessage;

export type ProtocolMessage = HostBoundMessage | ClientBoundMessage;

function isProtocolEnvelope(value: unknown): value is { kind: string; id: OperationId } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { channel?: unknown; kind?: unknown; id?: unknown };
  return (
    candidate.channel === PROTOCOL_CHANNEL &&
    typeof candidate.kind === 'string' &&
    typeof candidate.id === 'string'
  );
}

export function isHostBoundMessage(value: unknown): value is HostBoundMessage {
  if (!isProtocolEnvelope(value)) return false;
  return value.kind === 'request' || value.kind === 'cancel';
}

export function isClientBoundMessage(value: unknown): value is ClientBoundMessage {
  if (!isProtocolEnvelope(value)) return false;
  return value.kind === 'progress' || value.kind === 'result' || value.kind === 'error';
}
