import type {
  BoundaryFillOutcome,
  BoundaryFillPlan,
  ConservativeRepairPlan,
  LocalRepairChange,
  LocalRepairNotRun,
  LocalRepairOutcome,
  LocalRepairPlan,
  DocumentRenderSnapshot,
  EditCommitResult,
  SplitCommitResult,
  MeshBounds,
  DocumentHandle,
  PartDescriptor,
  RenderSnapshot,
  RepairCandidateHandle,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairOperation,
  RepairValidation,
  TopologyDetail,
  TopologyReport,
  HoleFillCandidateHandle,
  HoleFillValidationSummary,
  BoundaryLoopRefusal,
} from '@cadfixer/geometry-runtime';
import { fillableOpeningCount } from '@cadfixer/geometry-runtime';
import type { ExportStatus } from '@cadfixer/file-formats';
import type { WorkflowId } from './workflows';
import {
  SelfIntersectionBand,
  SelfIntersectionPhase,
  bandForFaceCount,
  type SelfIntersectionReport,
  type SelfIntersectionStatus,
} from '@cadfixer/mesh-self-intersection';
import type { LoadedModel } from './model';
import type { RepairIssueId } from './repair-issues';

/**
 * Application/workspace state.
 *
 * Deliberately framework-free: a plain observable with an immutable snapshot,
 * consumed by React through `useSyncExternalStore`. Keeping it independent of
 * React means the state layer can be unit-tested without a DOM, and that the
 * eventual document model (loaded mesh, undo stack, operation history) does not
 * become entangled with component lifecycles.
 *
 * No third-party state library is used. The surface is small enough that a
 * dependency would not earn its place — see docs/DEPENDENCIES.md.
 */

export const StatusSeverity = {
  Info: 'info',
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
} as const;

export type StatusSeverity = (typeof StatusSeverity)[keyof typeof StatusSeverity];

export interface StatusEntry {
  readonly id: number;
  readonly severity: StatusSeverity;
  readonly message: string;
  readonly at: number;
}

export const SelfTestState = {
  Idle: 'idle',
  Running: 'running',
  Passed: 'passed',
  Failed: 'failed',
} as const;

export type SelfTestState = (typeof SelfTestState)[keyof typeof SelfTestState];

export interface RuntimeState {
  readonly selfTest: SelfTestState;
  /** 0..1, meaningful only while `selfTest` is `running`. */
  readonly progress: number;
  readonly detail?: string;
}

export const ImportState = {
  Idle: 'idle',
  Screening: 'screening',
  Reading: 'reading',
  Parsing: 'parsing',
  Validating: 'validating',
  Ready: 'ready',
  Error: 'error',
} as const;

export type ImportState = (typeof ImportState)[keyof typeof ImportState];

declare const importTokenBrand: unique symbol;

/**
 * Identifies one import attempt. Branded so a plain number cannot be passed
 * where a token is required.
 */
export type ImportToken = number & { readonly [importTokenBrand]: true };

export interface ImportProgressState {
  readonly state: ImportState;
  /** 0..1 across the whole import. */
  readonly fraction: number;
  /** Name of the file currently being imported, for the progress label. */
  readonly fileName?: string;
  readonly note?: string;
}

export const ExportState = {
  Idle: 'idle',
  Working: 'working',
} as const;

export type ExportState = (typeof ExportState)[keyof typeof ExportState];

declare const exportTokenBrand: unique symbol;

/** Identifies one export attempt, for the same reason imports have tokens. */
export type ExportToken = number & { readonly [exportTokenBrand]: true };

export interface ExportProgressState {
  readonly state: ExportState;
  /** 0..1, meaningful only while `state` is `working`. */
  readonly fraction: number;
  readonly encoding?: string;
}

/* ------------------------------------------------- format conversion -- */

export const ConversionState = {
  /**
   * No conversion session: nothing loaded, or the Convert workspace has not
   * been entered for this model yet.
   */
  Closed: 'closed',
  /** A session exists, a target chosen or not, nothing running. */
  Reviewing: 'reviewing',
  /** A file is being written and checked. */
  Working: 'working',
  /** The last attempt did not produce a file. The workspace stays usable. */
  Failed: 'failed',
  /** A file was written, validated and handed to the browser. */
  Saved: 'saved',
} as const;

export type ConversionState = (typeof ConversionState)[keyof typeof ConversionState];

declare const conversionTokenBrand: unique symbol;

/** Identifies one conversion attempt, for the same reason imports have tokens. */
export type ConversionToken = number & { readonly [conversionTokenBrand]: true };

/**
 * WHICH EXPORT FAILED — Convert P1 (REPAIR-RC-03). The document revision, the
 * target and the unit key the attempt was made with, stated by the caller that
 * captured them when Export was pressed.
 */
export interface ConversionAttempt {
  readonly source: DocumentHandle;
  readonly target: string;
  readonly unitAssertion: string | undefined;
}

export interface ConversionFailure {
  /**
   * The machine-readable outcome. The sentence is presentation's.
   *
   * TYPED, not `string`, so the copy layer's switch over it stays exhaustive: a
   * new export status then fails to compile until it has been given a wording,
   * rather than falling through to a generic sentence nobody wrote.
   */
  readonly status: ExportStatus;
  readonly reason: string | undefined;
}

/**
 * AN EXPORT THAT CANNOT BE WRITTEN, REMEMBERED — Convert P1 (REPAIR-RC-03).
 *
 * A `ResourceLimit` refusal comes from exactly two writer ceilings
 * (`EXPORT_SERIALISED_TOO_LARGE`, `EXPORT_OUTPUT_TOO_LARGE`) on bytes that are a
 * pure function of the document revision, the target and the unit, so the same
 * three can only be refused again. Offering the same press again made a
 * 94.8 MiB STL cost four seconds per retry for an answer already known. The
 * record lives exactly as long as `measured`: cleared with the model, kept
 * across a target or unit change, and matched by all three keys, so a repair
 * (a new revision) or another format is offered again.
 */
export interface RefusedExport {
  readonly documentId: string;
  readonly revision: number;
  readonly target: string;
  readonly unitAssertion: string | undefined;
}

export const MAX_REFUSED_EXPORTS = 12;

/** Whether exactly this revision, target and unit was refused for size. */
export function refusedExportFor(
  refused: readonly RefusedExport[],
  handle: DocumentHandle,
  target: string,
  unitAssertion: string | undefined,
): RefusedExport | undefined {
  return refused.find(
    (entry) =>
      entry.documentId === handle.documentId &&
      entry.revision === handle.revision &&
      entry.target === target &&
      entry.unitAssertion === unitAssertion,
  );
}

export interface ConversionResult {
  readonly fileName: string;
  readonly byteLength: number;
  readonly target: string;
  readonly triangleCount: number;
  readonly partCount: number;
  /** The document revision the file was written from. */
  readonly source: DocumentHandle;
  /** The unit stated for this export, when one was. It changes the bytes. */
  readonly unitAssertion: string | undefined;
}

/**
 * THE SIZE OF A FILE CAD FIXER ACTUALLY WROTE, VALIDATED AND SAVED.
 *
 * A MEASUREMENT, NEVER AN ESTIMATE. OBJ's length depends on how each
 * coordinate is spelled and 3MF's on how well its XML compresses, so neither
 * can be predicted honestly; the only defensible number for them is the one a
 * real export produced. Keyed by everything that changes the bytes — the
 * document revision, the target and the stated unit — so a repair, an undo or
 * a different unit makes the entry describe a file the user can no longer
 * produce, and it stops being shown.
 */
export interface MeasuredExport {
  readonly documentId: string;
  readonly revision: number;
  readonly target: string;
  readonly unitAssertion: string | undefined;
  readonly byteLength: number;
}

/** Enough for every target at a few revisions; old entries are dropped first. */
export const MAX_MEASURED_EXPORTS = 12;

/** Finds the measurement for exactly this revision, target and unit, if one exists. */
export function measuredExportFor(
  measured: readonly MeasuredExport[],
  handle: DocumentHandle,
  target: string,
  unitAssertion: string | undefined,
): MeasuredExport | undefined {
  return measured.find(
    (entry) =>
      entry.documentId === handle.documentId &&
      entry.revision === handle.revision &&
      entry.target === target &&
      entry.unitAssertion === unitAssertion,
  );
}

export interface ConversionSnapshot {
  readonly state: ConversionState;
  /**
   * The chosen target, or `undefined` when none has been chosen.
   *
   * PRESELECTED TO THE SOURCE FORMAT when that format has a writer, because
   * "save this again" is the commonest reason to open the dialog and it is the
   * one choice that cannot surprise anyone — it bypasses no review, since the
   * compatibility summary for that target is on screen before anything can be
   * clicked. Nothing is ever exported without an explicit action.
   */
  readonly target: string | undefined;
  /**
   * The unit the user has stated for this export.
   *
   * `undefined` MEANS UNCHOSEN, and it starts that way every time. There is no
   * preselection, no remembered value and no implicit first option — a select
   * element that silently reports its first entry would make CAD Fixer choose a
   * physical unit on the user's behalf, which is the one thing this stage exists
   * to prevent.
   */
  readonly unitAssertion: string | undefined;
  /** 0..1, meaningful only while `state` is `working`. */
  readonly fraction: number;
  /** The writer's own phase note. Never a fabricated percentage. */
  readonly phase: string | undefined;
  readonly failure: ConversionFailure | undefined;
  readonly result: ConversionResult | undefined;
  /**
   * Sizes of files written from THIS model, newest last. Survives a target or
   * unit change — it is keyed by both — and is cleared with the model.
   */
  readonly measured: readonly MeasuredExport[];
  /** Exports refused for size at a revision, target and unit — see `RefusedExport`. */
  readonly refused: readonly RefusedExport[];
}

const CONVERSION_CLOSED: ConversionSnapshot = Object.freeze({
  state: ConversionState.Closed,
  target: undefined,
  unitAssertion: undefined,
  fraction: 0,
  phase: undefined,
  failure: undefined,
  result: undefined,
  measured: Object.freeze([]),
  refused: Object.freeze([]),
});

export interface TextureSelectionState {
  readonly source: DocumentHandle;
  readonly partId: string;
  readonly seedTriangle: number;
  readonly triangleIds: readonly number[];
  /** Summed area of the selected faces, part-local units squared. */
  readonly area: number;
  /** Summed area of every face of the part. */
  readonly partArea: number;
  readonly planarity: 'PLANAR' | 'NEAR_PLANAR';
}

export const AnalysisState = {
  /** No model is loaded, so there is nothing to analyse. */
  Unavailable: 'unavailable',
  /** A model is loaded and analysis has not run for it yet. */
  Idle: 'idle',
  Analyzing: 'analyzing',
  Ready: 'ready',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type AnalysisState = (typeof AnalysisState)[keyof typeof AnalysisState];

declare const analysisTokenBrand: unique symbol;

/** Identifies one analysis attempt, for the same reason imports have tokens. */
export type AnalysisToken = number & { readonly [analysisTokenBrand]: true };

export interface AnalysisFailure {
  readonly message: string;
  readonly code: string;
  /**
   * Whether offering "try again" makes sense.
   *
   * A resource-limit refusal will refuse identically next time, so a retry
   * button there would be a button that does nothing. A cancelled or
   * transiently-failed analysis is worth retrying.
   */
  readonly retryable: boolean;
}

/**
 * Topology analysis, always bound to the model handle it describes.
 *
 * `handle` is the load-bearing field. Analysis is asynchronous and a user can
 * import a second file while the first is still being analysed, so "which model
 * is this report about?" cannot be answered by timing. Every write is checked
 * against the model currently loaded, and a report for revision M0 is discarded
 * rather than shown beside M1's geometry.
 */
export interface AnalysisSnapshot {
  readonly state: AnalysisState;
  /** The document this state describes. `undefined` only when unavailable. */
  readonly handle: DocumentHandle | undefined;
  /**
   * The PART this state describes.
   *
   * Analysis is per part, so a handle alone no longer identifies a report: two
   * parts of one document share a revision. A report that arrives for a part
   * the user has since switched away from is discarded rather than shown.
   */
  readonly partId: string | undefined;
  /** 0..1, meaningful only while `state` is `analyzing`. */
  readonly fraction: number;
  /** Already translated for display by the analysis service. */
  readonly phase: string | undefined;
  /**
   * The last COMPLETE report for `handle`.
   *
   * Deliberately survives the start of a re-analysis: a user who re-runs
   * analysis should keep seeing the previous answer until a new one exists,
   * rather than watching the panel empty itself. Cleared when the model changes.
   */
  readonly report: TopologyReport | undefined;
  readonly detail: TopologyDetail | undefined;
  readonly error: AnalysisFailure | undefined;
  readonly durationMs: number | undefined;
}

/* ------------------------------------------------ self-intersection slice -- */

declare const selfIntersectionTokenBrand: unique symbol;
export type SelfIntersectionToken = number & {
  readonly [selfIntersectionTokenBrand]: true;
};

/**
 * The self-intersection slice.
 *
 * PHASE AND STATUS ARE SEPARATE FIELDS, and that separation is the point. A
 * `SelfIntersectionStatus` describes how a check ENDED; a phase describes
 * whether one is running at all. Folding "never asked" or "in progress" into
 * the status enum is precisely how an interface ends up implying a verdict it
 * does not have — five of the six statuses carry a zero intersection count.
 *
 * The band is stored rather than recomputed at render time so the panel and the
 * scheduler cannot disagree about which policy applies to the current model.
 */
export interface SelfIntersectionSnapshot {
  readonly phase: SelfIntersectionPhase;
  readonly band: SelfIntersectionBand;
  /** The document this state describes. `undefined` when nothing is loaded. */
  readonly handle: DocumentHandle | undefined;
  /**
   * The PART this state describes.
   *
   * Self-intersection is intra-part. The band is derived from THIS part's face
   * count, not the document's total, because the check runs on one mesh.
   */
  readonly partId: string | undefined;
  /** Faces examined so far, reported by the worker. Scalar only. */
  readonly faceCount: number | undefined;
  /**
   * The last terminal report for `handle`.
   *
   * Cleared the moment the model changes: a "None found" belonging to the
   * previous revision must never sit beside new geometry.
   */
  readonly report: SelfIntersectionReport | undefined;
  readonly error: string | undefined;
  /** True once an automatic check has been scheduled for this exact handle. */
  readonly autoScheduled: boolean;
}

const EMPTY_SELF_INTERSECTION: SelfIntersectionSnapshot = {
  phase: SelfIntersectionPhase.Idle,
  band: SelfIntersectionBand.AutoEligible,
  handle: undefined,
  partId: undefined,
  faceCount: undefined,
  report: undefined,
  error: undefined,
  autoScheduled: false,
};

const EMPTY_ANALYSIS: AnalysisSnapshot = {
  state: AnalysisState.Unavailable,
  handle: undefined,
  partId: undefined,
  fraction: 0,
  phase: undefined,
  report: undefined,
  detail: undefined,
  error: undefined,
  durationMs: undefined,
};

/**
 * Which diagnostic overlays the viewport should draw.
 *
 * View state, but held in the workspace store rather than in a component
 * because two separate subtrees need it: the Mesh Health panel owns the
 * toggles and the viewport owns the GPU buffers. Threading it through props
 * would couple the panel to the viewport's position in the tree.
 *
 * All default to off. Drawing 50,000 boundary edges over a model the instant it
 * loads would bury the geometry the user actually wants to look at.
 */
export interface OverlayVisibility {
  readonly boundaryEdges: boolean;
  readonly nonManifoldEdges: boolean;
  readonly windingConflictEdges: boolean;
  readonly degenerateFaces: boolean;
}

export type OverlayId = keyof OverlayVisibility;

const OVERLAYS_HIDDEN: OverlayVisibility = {
  boundaryEdges: false,
  nonManifoldEdges: false,
  windingConflictEdges: false,
  degenerateFaces: false,
};

/* ------------------------------------------------------- hole filling -- */

/**
 * THE HOLE-FILL WORKFLOW SLICE — Stage 4B-1B2.
 *
 * FIVE THINGS LIVE HERE and nothing else: the inventory of openings for the
 * active part, which opening is selected, the rim to draw, the candidate and
 * its patch, and what has been applied. Every one of them is scalar, a
 * disposable render buffer, or a handle. NO `CanonicalMesh` and no
 * `GeometryDocument`: the page has never held either and this stage does not
 * change that.
 *
 * THE DISPLAY INDEX IS PRESENTATION AND THE `boundaryLoopId` IS IDENTITY. A row
 * reads "Opening 3" because it is third in a deterministic order; every request
 * carries the id the worker produced. If the two ever disagreed, the label would
 * be wrong and the operation would still be right — which is the only direction
 * that error is allowed to run.
 */

export const HoleFillInventoryState = {
  /** No model, no part, or a part whose openings have not been listed. */
  Unavailable: 'unavailable',
  Listing: 'listing',
  Ready: 'ready',
  /**
   * The walk was not performed, because this part is too large to fill anyway.
   *
   * DISTINCT FROM `Ready` WITH A ZERO COUNT — Stage 6D-R3. The listing is the
   * largest allocation an import can trigger automatically and its cost scales
   * with boundary COMPONENTS, of which a mesh of loose triangles has one per
   * face. Above `HOLE_FILL_MAX_PART_FACES` no opening could be filled, so the
   * walk is skipped — and a skipped walk found nothing, which is not the same
   * as finding nothing. Reporting it as `Ready, loopCount: 0` would tell a user
   * their model has no openings on the strength of a check that never ran.
   */
  NotInventoried: 'not-inventoried',
  Failed: 'failed',
} as const;

export type HoleFillInventoryState =
  (typeof HoleFillInventoryState)[keyof typeof HoleFillInventoryState];

export const HoleFillWorkState = {
  Idle: 'idle',
  /** The disposable worker is building and validating a patch. */
  Generating: 'generating',
  /**
   * The worker is being terminated and the operation cancelled.
   *
   * A REAL STATE. Cancellation here is TERMINATION, which is not instantaneous
   * from the page's point of view: the promise has not settled yet. Saying
   * "Cancelled" before it does would claim the work had stopped while it
   * demonstrably had not — the same distinction the repair panel draws.
   */
  Cancelling: 'cancelling',
  /** A validated candidate exists and its patch may be previewed. */
  Ready: 'ready',
  /** The engine refused, the validators rejected, or something failed. */
  Failed: 'failed',
  /** The user cancelled. Nothing was built and nothing is resident. */
  Cancelled: 'cancelled',
} as const;

export type HoleFillWorkState = (typeof HoleFillWorkState)[keyof typeof HoleFillWorkState];

export const HoleFillCommitState = {
  Idle: 'idle',
  Applying: 'applying',
  Undoing: 'undoing',
} as const;

export type HoleFillCommitState = (typeof HoleFillCommitState)[keyof typeof HoleFillCommitState];

declare const holeFillTokenBrand: unique symbol;

/** Identifies one hole-fill attempt, for the same reason imports have tokens. */
export type HoleFillToken = number & { readonly [holeFillTokenBrand]: true };

export interface HoleFillFailure {
  readonly message: string;
  /** The machine-readable outcome. The sentence is presentation's. */
  readonly code: string;
  /** Whether trying the same opening again could plausibly help. */
  readonly retryable: boolean;
}

/**
 * One opening, as the interface lists it.
 *
 * SCALARS AND ONE IDENTITY. No coordinates: the ring of points is fetched only
 * for the opening the user actually selects, and even then only as a disposable
 * line buffer.
 */
export interface HoleBoundaryRow {
  readonly boundaryLoopId: string;
  /**
   * 1-based position in the deterministic order. PRESENTATION ONLY.
   *
   * Never sent to the worker, never compared, never used to resolve anything.
   * It exists so a person can say "the second one" instead of reading a
   * 64-bit hash aloud.
   */
  readonly displayIndex: number;
  readonly vertexCount: number;
  readonly edgeCount: number;
  /** True when the qualified automatic filler can attempt this opening. */
  readonly fillable: boolean;
  /**
   * Why not, when `fillable` is false. A CODE; the sentence is presentation's.
   *
   * TYPED rather than `string`, so the wording layer's switch stays exhaustive.
   * A refusal the engine can produce and the interface has no sentence for then
   * fails to compile, instead of reaching a user as a blank explanation beside a
   * disabled control.
   */
  readonly refusal: BoundaryLoopRefusal | undefined;
}

/**
 * The openings of the active part.
 *
 * BOUNDED BY CONSTRUCTION, and the bound is disclosed. A mesh of loose
 * triangles has one boundary component per face, so `loopCount` and
 * `rows.length` are deliberately separate numbers: a truncated list must never
 * become a smaller number of openings.
 */
export interface HoleFillInventory {
  readonly state: HoleFillInventoryState;
  /** Exact number of boundary components, even when the list was capped. */
  readonly loopCount: number;
  readonly rows: readonly HoleBoundaryRow[];
  readonly truncated: boolean;
  /** Triangles in the active part, so a size refusal can be stated up front. */
  readonly partFaceCount: number;
  readonly error: HoleFillFailure | undefined;
}

const EMPTY_INVENTORY: HoleFillInventory = {
  state: HoleFillInventoryState.Unavailable,
  loopCount: 0,
  rows: [],
  truncated: false,
  partFaceCount: 0,
  error: undefined,
};

/**
 * The selected opening's rim, ready to draw.
 *
 * A DISPOSABLE RENDER BUFFER in part-local coordinates. It carries the identity
 * it was built for so a snapshot arriving after the user has moved on can be
 * discarded rather than drawn over geometry it does not describe.
 */
export interface BoundaryRimPreview {
  readonly boundaryLoopId: string;
  readonly partId: string;
  readonly source: DocumentHandle;
  readonly positions: Float32Array;
  readonly edgeCount: number;
}

/**
 * A validated candidate, as the workspace holds it.
 *
 * WHAT IS DELIBERATELY ABSENT: the candidate's `CanonicalMesh`. It stays
 * worker-resident exactly as the authoritative model's does. `patch` is a
 * display-only snapshot of the patch faces, and `candidate` is a handle the UI
 * can name but cannot export — `HoleFillCandidateHandle` is a distinct type
 * from `DocumentHandle`, so the compiler refuses to let it reach an operation
 * that takes a model.
 */
export interface HoleFillPreview {
  readonly candidate: HoleFillCandidateHandle;
  readonly source: DocumentHandle;
  /** The part this candidate replaces. Bound at creation, never inferred later. */
  readonly partId: string;
  /** The opening it closes. Bound at creation for the same reason. */
  readonly boundaryLoopId: string;
  readonly summary: HoleFillValidationSummary;
  /** Patch triangles for display. `undefined` until the snapshot arrives. */
  readonly patchPositions: Float32Array | undefined;
  readonly patchNormals: Float32Array | undefined;
  readonly patchTriangleCount: number;
}

/** A fill that has actually been applied, and what it takes to reverse it. */
export interface AppliedHoleFill {
  readonly recordId: string;
  /** The revision the fill produced. */
  readonly handle: DocumentHandle;
  readonly partId: string;
  readonly boundaryLoopId: string;
  readonly parentRevision: number;
  readonly patchFaceCount: number;
  readonly undoable: boolean;
}

export interface HoleFillSnapshot {
  /** The document this slice describes. Checked on every write. */
  readonly handle: DocumentHandle | undefined;
  /** The PART this slice describes. Checked on every write. */
  readonly partId: string | undefined;
  readonly inventory: HoleFillInventory;
  /** The opening the user has chosen, by IDENTITY. */
  readonly selectedLoopId: string | undefined;
  readonly rim: BoundaryRimPreview | undefined;
  readonly workState: HoleFillWorkState;
  readonly candidate: HoleFillPreview | undefined;
  readonly candidateError: HoleFillFailure | undefined;
  /** A phase name while generating. Never a fabricated percentage. */
  readonly phase: string | undefined;
  readonly commitState: HoleFillCommitState;
  readonly commitError: HoleFillFailure | undefined;
  /** The most recent applied fill for the loaded model, if any. */
  readonly lastApplied: AppliedHoleFill | undefined;
}

const EMPTY_HOLE_FILL: HoleFillSnapshot = {
  handle: undefined,
  partId: undefined,
  inventory: EMPTY_INVENTORY,
  selectedLoopId: undefined,
  rim: undefined,
  workState: HoleFillWorkState.Idle,
  candidate: undefined,
  candidateError: undefined,
  phase: undefined,
  commitState: HoleFillCommitState.Idle,
  commitError: undefined,
  lastApplied: undefined,
};

/* ------------------------------------------------ conservative repair -- */

export const RepairPlanState = {
  /** No model, or no applicable topology report to plan from. */
  Unavailable: 'unavailable',
  Planning: 'planning',
  Ready: 'ready',
  Failed: 'failed',
} as const;

export type RepairPlanState = (typeof RepairPlanState)[keyof typeof RepairPlanState];

export const RepairCandidateState = {
  Idle: 'idle',
  Building: 'building',
  /**
   * Cancel has been signalled; the worker has not yet acknowledged unwinding.
   *
   * A REAL STATE, not a cosmetic one. The shared flag is set immediately, but
   * the worker is still inside a batch and still owns partially-built scratch
   * memory. Showing "Cancelled" at this point would claim the work had stopped
   * while it demonstrably had not, and would invite a retry that races the
   * operation still unwinding. See Stage 3B-1C.
   */
  Cancelling: 'cancelling',
  /** Built AND accepted by validation. The only state that may be applied. */
  Ready: 'ready',
  Failed: 'failed',
  /** The worker acknowledged: nothing was published, nothing is resident. */
  Cancelled: 'cancelled',
} as const;

export type RepairCandidateState = (typeof RepairCandidateState)[keyof typeof RepairCandidateState];

export const RepairCommitState = {
  Idle: 'idle',
  Applying: 'applying',
  Undoing: 'undoing',
} as const;

export type RepairCommitState = (typeof RepairCommitState)[keyof typeof RepairCommitState];

/**
 * Which geometry the viewport is showing while a candidate exists.
 *
 * A VIEW SETTING AND NOTHING MORE. `After` never makes the candidate
 * authoritative — the model the worker holds is unchanged until commit — and the
 * interface says so on screen whenever this is `After`.
 */
export const RepairPreviewMode = {
  Before: 'before',
  After: 'after',
} as const;

export type RepairPreviewMode = (typeof RepairPreviewMode)[keyof typeof RepairPreviewMode];

export interface RepairFailure {
  readonly message: string;
  readonly code: string;
  /** Whether returning to the selection and trying again could plausibly help. */
  readonly retryable: boolean;
}

declare const repairTokenBrand: unique symbol;

/**
 * Identifies one repair attempt — plan or candidate.
 *
 * Same reason imports and analyses have tokens: two attempts can be in flight
 * when a user changes their selection mid-plan, and results can arrive in either
 * order. Without an identity per attempt, a superseded plan would overwrite a
 * newer one and the checkboxes would stop matching the plan beside them.
 */
export type RepairToken = number & { readonly [repairTokenBrand]: true };

/**
 * A validated candidate, as the workspace holds it.
 *
 * WHAT IS DELIBERATELY ABSENT: the candidate's `CanonicalMesh`. It stays
 * worker-resident exactly as the authoritative model's does. `render` is a
 * display-only snapshot, and `candidate` is a handle the UI can name but cannot
 * export — `RepairCandidateHandle` is a distinct type from `DocumentHandle`, so the
 * compiler refuses to let a candidate reach an operation that takes a model.
 */
export interface RepairPreview {
  readonly candidate: RepairCandidateHandle;
  readonly source: DocumentHandle;
  /** The part this candidate replaces. Bound at creation, never inferred later. */
  readonly partId: string;
  readonly planHash: string;
  readonly validation: RepairValidation;
  readonly counts: RepairChangeCounts;
  readonly samples: RepairChangeSamples;
  readonly render: RenderSnapshot | undefined;
  readonly bounds: MeshBounds | undefined;
  /** Bytes undo would retain if this candidate were applied. See the protocol. */
  readonly undoRetainedBytes: number;
  /** What the fill stage did, when filling was requested — REPAIR-CORE-02. */
  readonly boundaryFill: BoundaryFillOutcome | undefined;
  /** Patch triangles only, for a fill-only candidate; `render` is then undefined. */
  readonly patchRender?: RenderSnapshot;
  /** What the local pinch repair did — REPAIR-CORE-06B. Typed; a limit is data, not an error. */
  readonly localRepair?: LocalRepairOutcome;
  readonly localRepairNotRun?: LocalRepairNotRun;
  /** The bounded S -> C delta the overlay draws, from the exact patch the candidate was built from. */
  readonly localChange?: LocalRepairChange;
}

/** A repair that has actually been applied, and what it takes to reverse it. */
export interface AppliedRepair {
  readonly recordId: string;
  /** The revision the repair produced. */
  readonly handle: DocumentHandle;
  /** The part whose geometry changed. Every other part is untouched. */
  readonly partId: string;
  readonly parentRevision: number;
  readonly appliedOperations: readonly RepairOperation[];
  readonly counts: RepairChangeCounts;
  /** Openings the applied candidate closed. Zero when none. */
  readonly filledOpenings: number;
  /** Non-manifold vertices the local repair separated, and triangles it reversed. REPAIR-CORE-06B. */
  readonly localRepaired?: number;
  readonly localReversed?: number;
  readonly undoable: boolean;
}

/**
 * Which change overlays the viewport should draw over a preview.
 *
 * SEPARATE FROM `OverlayVisibility`, which describes diagnostics of the loaded
 * model. These describe a proposal, they are bounded by the engine's sample cap
 * rather than by mesh size, and they default ON: a user who asked to preview a
 * repair asked to see what it changes. Diagnostics default off for the opposite
 * reason — fifty thousand boundary edges would bury the model.
 */
export interface ChangeOverlayVisibility {
  readonly removedDuplicates: boolean;
  readonly removedRepeatedPosition: boolean;
  readonly removedZeroArea: boolean;
  readonly flippedFaces: boolean;
  /** REPAIR-CORE-06B: triangles the local repair replaces, and those it adds. */
  readonly localRemoved: boolean;
  readonly localAdded: boolean;
}

export type ChangeOverlayId = keyof ChangeOverlayVisibility;

const CHANGE_OVERLAYS_SHOWN: ChangeOverlayVisibility = {
  removedDuplicates: true,
  removedRepeatedPosition: true,
  removedZeroArea: true,
  flippedFaces: true,
  localRemoved: true,
  localAdded: true,
};

export interface RepairSnapshot {
  /** The document the plan and candidate belong to. Checked on every write. */
  readonly handle: DocumentHandle | undefined;
  /** The PART the plan and candidate belong to. Checked on every write. */
  readonly partId: string | undefined;
  readonly planState: RepairPlanState;
  readonly plan: ConservativeRepairPlan | undefined;
  readonly planError: RepairFailure | undefined;
  /** Operations the user has selected. Never wider than what the plan allows. */
  readonly selection: readonly RepairOperation[];
  /** Whether Repair model also fills eligible openings — REPAIR-CORE-02. */
  readonly fillOpenings: boolean;
  /** What filling would attempt, from the worker. Belongs to `plan`'s revision. */
  readonly fillPlan: BoundaryFillPlan | undefined;
  /**
   * What the local pinch repair would attempt, from topology alone — REPAIR-CORE-06B. There is no
   * option for it: Repair always asks, and the worker decides. `limitLikely` inside is ADVISORY.
   */
  readonly localPlan: LocalRepairPlan | undefined;
  readonly candidateState: RepairCandidateState;
  readonly candidate: RepairPreview | undefined;
  readonly candidateError: RepairFailure | undefined;
  /** 0..1, meaningful while planning, building, applying or undoing. */
  readonly fraction: number;
  readonly phase: string | undefined;
  readonly previewMode: RepairPreviewMode;
  readonly changeOverlays: ChangeOverlayVisibility;
  readonly commitState: RepairCommitState;
  readonly commitError: RepairFailure | undefined;
  /** The most recent applied repair for the loaded model, if any. */
  readonly lastApplied: AppliedRepair | undefined;
}

/**
 * The default operation selection.
 *
 * ALL FOUR, because all four are conservative by construction: each is decidable
 * exactly from the stored coordinates, each refuses itself when it cannot be
 * safe, and none of them can run without appearing in the plan the user sees
 * first. Selecting them by default is not "repair everything" — the plan still
 * refuses whatever it must, and nothing runs until Preview is pressed.
 * See docs/repair/REPAIR_POLICY.md.
 */
export const DEFAULT_REPAIR_SELECTION: readonly RepairOperation[] = Object.freeze([
  'remove-duplicate-faces',
  'remove-repeated-position-faces',
  'remove-zero-area-faces',
  'unify-winding',
]);

const EMPTY_REPAIR: RepairSnapshot = {
  handle: undefined,
  partId: undefined,
  planState: RepairPlanState.Unavailable,
  plan: undefined,
  planError: undefined,
  selection: DEFAULT_REPAIR_SELECTION,
  // ON BY DEFAULT, like the four conservative operations: each opening is
  // admitted only if it independently qualifies, and nothing is filled before
  // the user reviews the preview and presses Apply.
  fillOpenings: true,
  fillPlan: undefined,
  localPlan: undefined,
  candidateState: RepairCandidateState.Idle,
  candidate: undefined,
  candidateError: undefined,
  fraction: 0,
  phase: undefined,
  previewMode: RepairPreviewMode.Before,
  changeOverlays: CHANGE_OVERLAYS_SHOWN,
  commitState: RepairCommitState.Idle,
  commitError: undefined,
  lastApplied: undefined,
};

export interface WorkspaceState {
  /** `undefined` means no workflow is open. No workflow can be opened yet. */
  readonly selectedWorkflow: WorkflowId | undefined;
  /**
   * The currently loaded model, or `undefined` when the workspace is empty.
   *
   * Replaced only by a SUCCESSFUL import. A failed or cancelled import leaves
   * whatever was already loaded untouched — losing the user's model because the
   * next file turned out to be broken would be its own kind of data loss.
   */
  readonly model: LoadedModel | undefined;
  /**
   * The document as it was IMPORTED — handle and revision.
   *
   * A reference point, not a second authority: `hasUnexportedChanges` compares
   * the current handle with it, and with the revisions a whole-document export
   * was written from, to decide whether leaving the page would discard work
   * that exists nowhere else (PR-01). Set by `commitImport`, cleared when the
   * geometry session is lost.
   */
  readonly importedHandle: DocumentHandle | undefined;
  /**
   * The part every part-targeted action currently addresses.
   *
   * WORKSPACE STATE, NOT GEOMETRY IDENTITY. Changing it does NOT change the
   * document revision: selecting a different part inspects the same
   * authoritative geometry from a different angle, and burning a revision for a
   * selection would invalidate every in-flight result for no reason.
   *
   * Always either `undefined` — no model loaded — or the id of a part that
   * exists in `model.parts`. The two are updated in the same `update` call, so
   * there is no render in which the selection points at a part that is gone.
   */
  readonly activePartId: string | undefined;
  /** Disposable split preview; authoritative geometry remains worker-resident. */
  readonly splitPreview:
    | {
        readonly source: DocumentHandle;
        readonly render: DocumentRenderSnapshot;
        readonly parts: readonly PartDescriptor[];
      }
    | undefined;
  readonly splitPlane:
    | {
        readonly origin: readonly [number, number, number];
        readonly normal: readonly [number, number, number];
        readonly revision: number;
      }
    | undefined;
  /** Disposable part-local Texture candidate render; canonical mesh remains worker-resident. */
  readonly texturePreview:
    | {
        readonly source: DocumentHandle;
        readonly partId: string;
        readonly render: RenderSnapshot;
        readonly generation: number;
      }
    | undefined;
  /**
   * THE Surface Texture selection — the one canonical copy. The worker grew it
   * from `seedTriangle` and measured it; the viewport draws `triangleIds`, and
   * the panel, HUD and inspector read the summary. It names ONE revision of ONE
   * part: its ids index that exact mesh, so a selection whose `source` is not
   * the loaded model's handle is stale and read as no selection.
   */
  readonly textureSelection: TextureSelectionState | undefined;
  readonly importProgress: ImportProgressState;
  readonly exportProgress: ExportProgressState;
  /**
   * The format conversion workflow.
   *
   * DELIBERATELY HOLDS NO COMPATIBILITY REPORT. The report is derived from
   * `model` on every render, so it cannot be older than the model it is shown
   * beside; storing one would create exactly the stale-report hazard the
   * workflow has to rule out. What lives here is the user's CHOICES and the
   * progress of an attempt — things a re-render must not lose.
   */
  readonly conversion: ConversionSnapshot;
  /** Topology diagnostics for `model`, or the unavailable state when empty. */
  readonly analysis: AnalysisSnapshot;
  readonly selfIntersection: SelfIntersectionSnapshot;
  /** Conservative repair for `model`, or the unavailable state when empty. */
  readonly repair: RepairSnapshot;
  /**
   * The hole-fill workflow for the ACTIVE PART of `model`.
   *
   * Per part, exactly as analysis and repair are: openings are a property of one
   * mesh, and listing part A's beside part B's geometry would be the same
   * diagnostic dishonesty a carried-over boundary-edge count would be.
   */
  readonly holeFill: HoleFillSnapshot;
  readonly overlays: OverlayVisibility;
  /**
   * The issue selected in the Repair workspace, if any.
   *
   * ONE SELECTION, READ BY EVERY SURFACE: the Mesh analysis list, the viewport
   * HUD and marker, and the inspector all resolve it through
   * `resolveIssueSelection`, so none can show a different issue or occurrence.
   *
   * KEYED TO THE ANALYSIS IT WAS MADE AGAINST. `key` names a document revision
   * and part; a selection whose key no longer matches the current analysis is
   * stale and resolves to nothing, whatever changed the geometry — a repair, a
   * fill, an undo, a new import, a part switch. No reset path can be missed.
   *
   * Open boundaries are the exception to `occurrence`: their current
   * occurrence IS `holeFill.selectedLoopId`, so the openings list and this
   * selection cannot drift apart.
   */
  readonly issueSelection: IssueSelection | undefined;
  /** The latest request to frame a region of the active part. */
  readonly frameRequest: FrameRequest | undefined;
  readonly status: readonly StatusEntry[];
  readonly runtime: RuntimeState;
  /**
   * Set when the 3D viewport could not start or lost its context.
   *
   * Held here rather than in component state because it is workspace status,
   * not view-local UI state: the shell may surface it in more than one place,
   * and it must survive the viewport component remounting.
   */
  readonly viewportFailure: string | undefined;
  /**
   * Set when the geometry worker died, taking every resident model with it.
   *
   * POLICY A — the model is CLEARED, not left on screen. The worker held the
   * only copy of the authoritative geometry, so keeping a render snapshot
   * visible would show something no operation could act on: export would fail,
   * diagnostics would fail, and the picture would imply a working session that
   * does not exist. Showing nothing and saying why is less misleading.
   */
  readonly geometrySessionLost: string | undefined;
}

export interface IssueSelection {
  readonly issue: RepairIssueId;
  readonly occurrence: number;
  /** `documentId@revision/partId` of the analysis the selection was made in. */
  readonly key: string;
}

/**
 * A request to frame part-local `center` within `radius`.
 *
 * A COMMAND, not state: `sequence` increases on every request, so asking to
 * frame the same place twice frames it twice. The viewport ignores a request
 * whose `key` no longer names the model on screen.
 */
export interface FrameRequest {
  readonly sequence: number;
  readonly key: string;
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** The key an issue selection and a frame request are tied to. */
export function analysisKey(
  handle: DocumentHandle | undefined,
  partId: string | undefined,
): string | undefined {
  return handle === undefined || partId === undefined
    ? undefined
    : `${handle.documentId}@${String(handle.revision)}/${partId}`;
}

/** Bounded so a chatty session cannot grow the log without limit. */
const MAX_STATUS_ENTRIES = 50;

const INITIAL_STATE: WorkspaceState = {
  selectedWorkflow: undefined,
  model: undefined,
  importedHandle: undefined,
  activePartId: undefined,
  splitPreview: undefined,
  splitPlane: undefined,
  texturePreview: undefined,
  textureSelection: undefined,
  importProgress: { state: ImportState.Idle, fraction: 0 },
  exportProgress: { state: ExportState.Idle, fraction: 0 },
  conversion: CONVERSION_CLOSED,
  analysis: EMPTY_ANALYSIS,
  selfIntersection: EMPTY_SELF_INTERSECTION,
  repair: EMPTY_REPAIR,
  holeFill: EMPTY_HOLE_FILL,
  overlays: OVERLAYS_HIDDEN,
  issueSelection: undefined,
  frameRequest: undefined,
  status: [],
  runtime: { selfTest: SelfTestState.Idle, progress: 0 },
  viewportFailure: undefined,
  geometrySessionLost: undefined,
};

/**
 * Splices one part's new drawable buffers into a document snapshot.
 *
 * ONLY THE CHANGED PART IS REPLACED. Every other entry is carried over by
 * reference, which matters for more than allocation: two parts that share one
 * `Float32Array` keep sharing it, so repairing a third part does not quietly
 * un-share the two that were never touched.
 *
 * Returns the original snapshot unchanged when the part is not in it, so a
 * result that arrives for a part the document no longer has cannot invent one.
 */
function withPartRender(
  snapshot: DocumentRenderSnapshot,
  partId: string,
  render: RenderSnapshot,
  descriptors: readonly PartDescriptor[],
): DocumentRenderSnapshot {
  const index = snapshot.parts.findIndex((part) => part.partId === partId);
  const existing = index < 0 ? undefined : snapshot.parts[index];
  if (existing === undefined) return snapshot;

  const shared = sharedBuffersFor(snapshot, descriptors, partId);
  const parts = snapshot.parts.slice();
  parts[index] =
    shared === undefined
      ? {
          ...existing,
          positions: render.positions,
          normals: render.normals,
          vertexCount: render.vertexCount,
        }
      : { ...existing, ...shared };
  return { parts };
}

/**
 * A sibling's EXISTING buffers, when the successor document says the two parts
 * share one mesh.
 *
 * WHY THIS EXISTS — Stage 4B-1B2-R1. The worker restores the exact pre-fill mesh
 * on undo, so a document whose parts shared one mesh shares it again. The page
 * would not have followed: the result carries a FRESH render snapshot for the
 * changed part, and `SharedPartGeometry` keys on position-array IDENTITY, so the
 * viewport would have uploaded a second GPU geometry for coordinates it was
 * already drawing. Undo would have restored the document and permanently
 * doubled what the GPU holds.
 *
 * THE WORKER IS THE AUTHORITY, and this reads its answer rather than forming its
 * own. `meshResourceIndex` is computed over the successor's DISTINCT meshes, so
 * two parts carrying the same index provably hold the same `CanonicalMesh`. No
 * coordinates are compared here and none could be: the page has never held any.
 *
 * IT IS NOT A HOLE-FILL SPECIAL CASE. Every part-mesh replacement goes through
 * here — repair commit, fill commit and undo — so any of them that lands a part
 * back on a shared mesh now keeps the page's sharing in step. A replacement that
 * genuinely un-shares finds no match and installs the new buffers, which is the
 * common path and is unchanged.
 */
function sharedBuffersFor(
  snapshot: DocumentRenderSnapshot,
  descriptors: readonly PartDescriptor[],
  partId: string,
): { positions: Float32Array; normals: Float32Array; vertexCount: number } | undefined {
  const changed = descriptors.find((part) => part.partId === partId);
  if (changed === undefined) return undefined;

  for (const candidate of descriptors) {
    if (candidate.partId === partId) continue;
    if (candidate.meshResourceIndex !== changed.meshResourceIndex) continue;
    /*
     * The sibling's buffers were built from the mesh both parts now hold, and
     * the sibling was not touched by this operation — so reusing them is exact,
     * not an approximation, and it restores ARRAY IDENTITY, which is what the
     * viewport's reference counting keys on.
     */
    const buffers = snapshot.parts.find((part) => part.partId === candidate.partId);
    if (buffers === undefined) continue;
    return {
      positions: buffers.positions,
      normals: buffers.normals,
      vertexCount: buffers.vertexCount,
    };
  }
  return undefined;
}

export class WorkspaceStore {
  private state: WorkspaceState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private nextStatusId = 1;
  private nextModelRevision = 1;
  private nextImportToken = 1;
  private currentImportToken: ImportToken | undefined;
  private nextExportToken = 1;
  private currentExportToken: ExportToken | undefined;
  private nextConversionToken = 1;
  private currentConversionToken: ConversionToken | undefined;
  private nextAnalysisToken = 1;
  private currentAnalysisToken: AnalysisToken | undefined;
  private nextRepairToken = 1;
  private currentRepairToken: RepairToken | undefined;
  private nextHoleFillToken = 1;
  private currentHoleFillToken: HoleFillToken | undefined;

  public getSnapshot = (): WorkspaceState => this.state;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public selectWorkflow(workflow: WorkflowId | undefined): void {
    this.update({
      selectedWorkflow: workflow,
      ...(workflow === 'split' ? {} : { splitPreview: undefined, splitPlane: undefined }),
      ...(workflow === 'texture' ? {} : { texturePreview: undefined, textureSelection: undefined }),
    });
  }

  public setTexturePreview(
    source: DocumentHandle,
    partId: string,
    render: RenderSnapshot,
    generation: number,
  ): boolean {
    if (!sameHandle(this.state.model?.handle, source) || this.state.activePartId !== partId)
      return false;
    this.update({ texturePreview: { source, partId, render, generation } });
    return true;
  }

  public clearTexturePreview(): void {
    if (this.state.texturePreview !== undefined) this.update({ texturePreview: undefined });
  }

  /** Installs a worker-grown selection; refused for any revision or part not on screen. */
  public setTextureSelection(selection: TextureSelectionState): boolean {
    if (
      !sameHandle(this.state.model?.handle, selection.source) ||
      this.state.activePartId !== selection.partId
    )
      return false;
    this.update({ textureSelection: selection });
    return true;
  }

  public clearTextureSelection(): void {
    if (this.state.textureSelection !== undefined) this.update({ textureSelection: undefined });
  }

  public setSplitPreview(
    source: DocumentHandle,
    render: DocumentRenderSnapshot,
    parts: readonly PartDescriptor[],
  ): boolean {
    if (!sameHandle(this.state.model?.handle, source)) return false;
    this.update({ splitPreview: { source, render, parts } });
    return true;
  }

  public clearSplitPreview(): void {
    if (this.state.splitPreview !== undefined) this.update({ splitPreview: undefined });
  }

  public setSplitPlane(plane: WorkspaceState['splitPlane']): void {
    const current = this.state.splitPlane;
    if (
      current?.revision === plane?.revision &&
      current?.origin.every((value, index) => value === plane?.origin[index]) &&
      current.normal.every((value, index) => value === plane?.normal[index])
    )
      return;
    if (current === undefined && plane === undefined) return;
    this.update({ splitPlane: plane });
  }

  public applySplitResult(result: SplitCommitResult): boolean {
    const model = this.state.model;
    if (
      model?.handle.documentId !== result.handle.documentId ||
      model.handle.revision !== result.parentRevision
    )
      return false;
    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;
    this.currentSelfIntersectionToken = undefined;
    this.currentHoleFillToken = undefined;
    this.update({
      model: {
        ...model,
        handle: result.handle,
        parts: result.parts,
        render: result.render,
        bounds: result.bounds,
        triangleCount: result.triangleCount,
        vertexCount: result.vertexCount,
        residentBytes: result.residentBytes,
        revision,
      },
      activePartId: result.pieceAId,
      splitPreview: undefined,
      splitPlane: undefined,
      texturePreview: undefined,
      textureSelection: undefined,
      analysis: {
        ...EMPTY_ANALYSIS,
        state: AnalysisState.Idle,
        handle: result.handle,
        partId: result.pieceAId,
      },
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: result.handle,
        partId: result.pieceAId,
        band: bandForFaceCount(result.resources.triangles),
      },
      holeFill: { ...EMPTY_HOLE_FILL, handle: result.handle, partId: result.pieceAId },
      repair: { ...EMPTY_REPAIR, handle: result.handle },
      overlays: OVERLAYS_HIDDEN,
    });
    return true;
  }

  public pushStatus(severity: StatusSeverity, message: string): void {
    const entry: StatusEntry = {
      id: this.nextStatusId,
      severity,
      message,
      at: Date.now(),
    };
    this.nextStatusId += 1;
    const status = [entry, ...this.state.status].slice(0, MAX_STATUS_ENTRIES);
    this.update({ status });
  }

  public clearStatus(): void {
    this.update({ status: [] });
  }

  public setRuntime(runtime: RuntimeState): void {
    this.update({ runtime });
  }

  public setViewportFailure(message: string | undefined): void {
    if (this.state.viewportFailure === message) return;
    this.update({ viewportFailure: message });
  }

  /**
   * Claims the import slot and returns the token that identifies this attempt.
   *
   * WHY A TOKEN. Two imports can be in flight at once — the user drops a second
   * file while the first is still parsing — and the results can arrive in
   * either order. A small file started second can easily finish before a large
   * file started first. Without an identity per attempt, the late result of a
   * superseded import would overwrite the newer model, and the user would be
   * looking at geometry that does not match the filename beside it.
   *
   * A boolean "importing" flag cannot express this: by the time the stale
   * result arrives the flag is true again, for a different import. The token is
   * monotonic, so "is this still the current attempt?" is answerable without
   * any reference to timing.
   */
  public beginImport(fileName: string): ImportToken {
    const token = this.nextImportToken as ImportToken;
    this.nextImportToken += 1;
    this.currentImportToken = token;
    this.update({
      importProgress: { state: ImportState.Screening, fraction: 0, fileName },
    });
    return token;
  }

  /** True while `token` is the most recently started import. */
  public isCurrentImport(token: ImportToken): boolean {
    return this.currentImportToken === token;
  }

  /** Progress from a superseded import is discarded rather than displayed. */
  public reportImportProgress(token: ImportToken, progress: ImportProgressState): void {
    if (!this.isCurrentImport(token)) return;
    this.update({ importProgress: progress });
  }

  /**
   * Installs a model, but only if `token` is still the current import.
   *
   * Returns whether the model was installed, so the caller can tell a genuine
   * commit from a discarded stale result.
   */
  public commitImport(token: ImportToken, model: Omit<LoadedModel, 'revision'>): boolean {
    if (!this.isCurrentImport(token)) return false;
    this.currentImportToken = undefined;

    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;

    // A new model invalidates the previous model's diagnostics completely. The
    // in-flight analysis token is dropped so a report for the model being
    // replaced cannot install itself against the replacement, and the report
    // itself goes rather than lingering beside different geometry.
    this.currentAnalysisToken = undefined;
    // And it invalidates the previous model's repair entirely: a plan, a
    // candidate, a preview and an undo record all name geometry the user has
    // just replaced. The candidate's worker-side release is the caller's
    // responsibility — see `useConservativeRepair`.
    this.currentRepairToken = undefined;
    // And any in-flight self-intersection check: its answer describes the model
    // being replaced, so it must not land on the replacement.
    this.currentSelfIntersectionToken = undefined;
    /*
     * AND ANY CONVERSION. A new FILE is a new set of source facts and, more
     * importantly, a new answer to "what do these numbers mean" — carrying an
     * inch assertion made about the previous model onto this one would be CAD
     * Fixer asserting a physical fact nobody stated about this file. The session
     * ends rather than outliving the document it was started for, and so do the
     * measured sizes, which describe files written from that document.
     *
     * A REPAIR OR AN UNDO DOES NOT DO THIS, and the difference is the point:
     * those produce a new revision of the SAME model, the unit still means what
     * the user said it means, and the compatibility report simply recomputes.
     */
    this.currentConversionToken = undefined;

    /*
     * THE INITIAL SELECTION IS DETERMINISTIC: the first part in document order.
     *
     * For an STL — one part — that means the user's experience is unchanged:
     * there is only one thing to select and it is selected. For a multi-part
     * document it means the same file always opens on the same part, rather
     * than on whichever one happened to be built first.
     */
    const activePart = model.parts[0];

    this.update({
      model: { ...model, revision },
      importedHandle: model.handle,
      activePartId: activePart?.partId,
      splitPreview: undefined,
      splitPlane: undefined,
      texturePreview: undefined,
      textureSelection: undefined,
      importProgress: { state: ImportState.Ready, fraction: 1 },
      analysis: {
        ...EMPTY_ANALYSIS,
        state: AnalysisState.Idle,
        handle: model.handle,
        partId: activePart?.partId,
      },
      repair: { ...EMPTY_REPAIR, handle: model.handle, partId: activePart?.partId },
      /*
       * A NEW FILE HAS ITS OWN OPENINGS. The inventory, the selection, the rim,
       * the candidate and the applied record all named the previous document;
       * none of them survives. The candidate's worker-side release is the
       * caller's responsibility — see `useHoleFillWorkflow` — exactly as the
       * repair candidate's is.
       */
      holeFill: { ...EMPTY_HOLE_FILL, handle: model.handle, partId: activePart?.partId },
      conversion: CONVERSION_CLOSED,
      /*
       * The ACTIVE PART's size decides its own policy — not the document total.
       * The check runs on one mesh, so a small part inside a large document is
       * still auto-eligible. Nothing is carried over from the previous model.
       */
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: model.handle,
        partId: activePart?.partId,
        band: bandForFaceCount(activePart?.triangleCount ?? model.triangleCount),
      },
      // A successful import means a live worker, so any previous loss notice is
      // stale and must go.
      geometrySessionLost: undefined,
    });
    return true;
  }

  /**
   * Points every part-targeted action at a different part.
   *
   * NO NEW REVISION. Selection is workspace state; the authoritative document
   * is untouched, every handle stays valid, and no in-flight operation is
   * invalidated by the switch.
   *
   * WHAT IS RESET, and why. The analysis, self-intersection and repair slices
   * all describe ONE part. Carrying part A's boundary-edge count or "None
   * found" verdict across to part B would put a number beside geometry nothing
   * examined, which is exactly the diagnostic dishonesty the product forbids —
   * so they are cleared and re-bound to the new part.
   *
   * A CANDIDATE IS NOT SILENTLY DISCARDED. Its worker-side geometry is released
   * by the caller (`useConservativeRepair`), which returns the handle to
   * discard; clearing the slice here without that would leak a resident mesh.
   * The token streams are dropped so a result computed for the old part cannot
   * install itself against the new one.
   *
   * Returns false when the id is not a part of the loaded document, so a caller
   * cannot leave the selection pointing at something that does not exist.
   */
  public selectPart(partId: string): boolean {
    const model = this.state.model;
    if (model === undefined) return false;

    const part = model.parts.find((candidate) => candidate.partId === partId);
    if (part === undefined) return false;
    if (this.state.activePartId === partId) return true;

    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;
    this.currentSelfIntersectionToken = undefined;

    this.update({
      activePartId: partId,
      texturePreview: undefined,
      textureSelection: undefined,
      analysis: {
        ...EMPTY_ANALYSIS,
        state: AnalysisState.Idle,
        handle: model.handle,
        partId,
      },
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: model.handle,
        partId,
        band: bandForFaceCount(part.triangleCount),
      },
      repair: {
        ...EMPTY_REPAIR,
        handle: model.handle,
        partId,
        // The user's operation choices are a preference about repair, not about
        // a particular part, so they survive a selection change.
        selection: this.state.repair.selection,
        fillOpenings: this.state.repair.fillOpenings,
      },
      /*
       * SWITCHING PARTS ABANDONS THE FILL WORKFLOW, DELIBERATELY.
       *
       * Openings belong to one mesh, so part A's inventory says nothing about
       * part B — and a candidate that stayed alive across the switch would put
       * an Apply button for part A on screen beside part B's geometry. The
       * engine would refuse such an Apply, but the interface must not offer it
       * in the first place: a guard that fires is a bug the user sees.
       *
       * `lastApplied` SURVIVES, because it describes a change that really
       * happened to this document and is still what Undo would reverse.
       */
      holeFill: {
        ...EMPTY_HOLE_FILL,
        handle: model.handle,
        partId,
        lastApplied: this.state.holeFill.lastApplied,
      },
      overlays: OVERLAYS_HIDDEN,
    });
    return true;
  }

  /** The active part's descriptor, or `undefined` when nothing is loaded. */
  public activePart(): PartDescriptor | undefined {
    const { model, activePartId } = this.state;
    if (model === undefined || activePartId === undefined) return undefined;
    return model.parts.find((part) => part.partId === activePartId);
  }

  /* ------------------------------------------- conservative repair -- */

  /**
   * Claims the repair slot for `handle` and returns the token for this attempt.
   *
   * One token stream covers planning AND candidate creation, because they are
   * one user-visible operation with two phases. A candidate built for a plan the
   * user has since changed must not install itself, and a single monotonic token
   * answers that without any reference to timing.
   */
  public beginRepairPlan(
    handle: DocumentHandle,
    partId: string,
    selection: readonly RepairOperation[],
  ): RepairToken {
    const token = this.nextRepairToken as RepairToken;
    this.nextRepairToken += 1;
    this.currentRepairToken = token;

    const repair = this.state.repair;
    this.update({
      repair: {
        ...repair,
        handle,
        partId,
        planState: RepairPlanState.Planning,
        planError: undefined,
        selection,
        fraction: 0,
        phase: undefined,
        // A new plan invalidates any candidate built from the previous one. The
        // handle is kept in `candidate` until the caller releases it, so this
        // clears the state rather than the worker's memory.
        candidateState: RepairCandidateState.Idle,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
      },
    });
    return token;
  }

  /* ------------------------------------------ self-intersection slice -- */

  private nextSelfIntersectionToken = 1;
  private currentSelfIntersectionToken: SelfIntersectionToken | undefined;

  public isCurrentSelfIntersection(token: SelfIntersectionToken): boolean {
    return this.currentSelfIntersectionToken === token;
  }

  /**
   * Re-derives the slice for a newly authoritative model.
   *
   * CALLED ON EVERY REVISION CHANGE — import, replacement, repair apply, undo.
   * The previous report is DROPPED rather than carried forward: it describes
   * geometry that no longer exists, and leaving a "None found" on screen beside
   * a model it was never computed for is the single most damaging thing this
   * slice could do.
   */
  public resetSelfIntersectionFor(
    handle: DocumentHandle | undefined,
    partId: string | undefined,
    faceCount: number,
  ): void {
    this.currentSelfIntersectionToken = undefined;
    this.update({
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle,
        partId,
        band:
          handle === undefined ? SelfIntersectionBand.AutoEligible : bandForFaceCount(faceCount),
      },
    });
  }

  /**
   * Claims the slice for a new check. Returns `undefined` when the model's size
   * band forbids running one at all.
   */
  public beginSelfIntersection(
    handle: DocumentHandle,
    partId: string,
    auto: boolean,
  ): SelfIntersectionToken | undefined {
    const current = this.state.selfIntersection;
    if (!sameHandle(current.handle, handle)) return undefined;
    // Two parts share a revision, so the handle alone cannot say which part a
    // check belongs to. Without this a check requested for part A could publish
    // into the slice now bound to part B.
    if (current.partId !== partId) return undefined;
    if (current.band === SelfIntersectionBand.SizeLimit) return undefined;
    if (auto && current.autoScheduled) return undefined;

    const token = this.nextSelfIntersectionToken as SelfIntersectionToken;
    this.nextSelfIntersectionToken += 1;
    this.currentSelfIntersectionToken = token;
    this.update({
      selfIntersection: {
        ...current,
        phase: SelfIntersectionPhase.Scheduled,
        report: undefined,
        error: undefined,
        faceCount: undefined,
        autoScheduled: current.autoScheduled || auto,
      },
    });
    return token;
  }

  public reportSelfIntersectionStarted(token: SelfIntersectionToken, faceCount: number): void {
    if (!this.isCurrentSelfIntersection(token)) return;
    this.update({
      selfIntersection: {
        ...this.state.selfIntersection,
        phase: SelfIntersectionPhase.Running,
        faceCount,
      },
    });
  }

  public beginSelfIntersectionCancellation(token: SelfIntersectionToken): boolean {
    if (!this.isCurrentSelfIntersection(token)) return false;
    if (
      this.state.selfIntersection.phase !== SelfIntersectionPhase.Running &&
      this.state.selfIntersection.phase !== SelfIntersectionPhase.Scheduled
    ) {
      return false;
    }
    this.update({
      selfIntersection: {
        ...this.state.selfIntersection,
        phase: SelfIntersectionPhase.Cancelling,
      },
    });
    return true;
  }

  /**
   * Publishes a terminal report.
   *
   * GUARDED TWICE, by token AND by handle. A diagnostic that was in flight when
   * the model changed must not land on the replacement: its answer describes
   * different geometry, and by the time it arrives nothing else distinguishes
   * the two.
   */
  public completeSelfIntersection(
    token: SelfIntersectionToken,
    report: SelfIntersectionReport,
  ): boolean {
    if (!this.isCurrentSelfIntersection(token)) return false;
    const current = this.state.selfIntersection;
    if (current.handle === undefined) return false;
    if (
      current.handle.documentId !== report.documentId ||
      current.handle.revision !== report.documentRevision
    ) {
      return false;
    }
    this.currentSelfIntersectionToken = undefined;
    this.update({
      selfIntersection: {
        ...current,
        phase: SelfIntersectionPhase.Complete,
        report,
        error: undefined,
      },
    });
    return true;
  }

  /** Publishes a terminal status that carries no report — cancellation, failure. */
  public failSelfIntersection(
    token: SelfIntersectionToken,
    status: SelfIntersectionStatus,
    message: string,
  ): boolean {
    if (!this.isCurrentSelfIntersection(token)) return false;
    const current = this.state.selfIntersection;
    if (current.handle === undefined) return false;
    this.currentSelfIntersectionToken = undefined;
    this.update({
      selfIntersection: {
        ...current,
        phase: SelfIntersectionPhase.Complete,
        report: {
          schemaVersion: 1,
          status,
          documentId: current.handle.documentId,
          documentRevision: current.handle.revision,
          partId: current.partId ?? '',
          faceCount: current.faceCount ?? 0,
          intersectingPairCount: 0,
          affectedFaceCount: 0,
          categories: {
            properCrossing: 0,
            coplanarOverlap: 0,
            nonAdjacentPointTouch: 0,
            nonAdjacentEdgeTouch: 0,
            adjacentOverlapBeyondShared: 0,
            duplicateTopologyDefect: 0,
            legitimateShared: 0,
          },
          skippedDegenerateFaceCount: 0,
          skippedPairCount: 0,
          unclassifiedPairCount: 0,
          candidatePairCount: 0,
          testedPairCount: 0,
          samples: new Uint32Array(0),
          samplePairCount: 0,
          samplesTruncated: false,
          engine: { name: 'geogram', version: 'v1.10.0', commit: 'c8529bb' },
        },
        error: message,
      },
    });
    return true;
  }

  public isCurrentRepair(token: RepairToken): boolean {
    return this.currentRepairToken === token;
  }

  public reportRepairProgress(token: RepairToken, fraction: number, phase: string): void {
    if (!this.isCurrentRepair(token)) return;
    const repair = this.state.repair;
    // Coalesced at the source, exactly as analysis progress is: a worker phase
    // can emit many updates per second and re-rendering for a fraction that
    // rounds to the same displayed percent is work nobody sees.
    if (
      repair.phase === phase &&
      Math.round(repair.fraction * 100) === Math.round(fraction * 100)
    ) {
      return;
    }
    this.update({ repair: { ...repair, fraction, phase } });
  }

  /**
   * Installs a plan, but only for the model that is actually loaded.
   *
   * TWO GATES, as everywhere else in this store. The token rejects a superseded
   * attempt; the handle comparison rejects a plan whose model is no longer
   * current even if the token somehow survived.
   */
  public commitRepairPlan(
    token: RepairToken,
    handle: DocumentHandle,
    plan: ConservativeRepairPlan,
    fillPlan?: BoundaryFillPlan,
    localPlan?: LocalRepairPlan,
  ): boolean {
    if (!this.isCurrentRepair(token)) return false;
    if (!sameHandle(this.state.model?.handle, handle)) return false;

    this.update({
      repair: {
        ...this.state.repair,
        fillPlan,
        localPlan,
        handle,
        planState: RepairPlanState.Ready,
        plan,
        planError: undefined,
        fraction: 1,
        phase: undefined,
      },
    });
    return true;
  }

  public failRepairPlan(token: RepairToken, error: RepairFailure): boolean {
    if (!this.isCurrentRepair(token)) return false;
    this.currentRepairToken = undefined;
    this.update({
      repair: {
        ...this.state.repair,
        planState: RepairPlanState.Failed,
        planError: error,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Records that no plan can be produced yet.
   *
   * Distinct from a failure: there is nothing wrong, the prerequisite simply is
   * not there. Repair needs a topology report for the CURRENT revision, and
   * while analysis is running, cancelled or failed there is nothing honest to
   * plan from.
   */
  public setRepairUnavailable(handle: DocumentHandle | undefined): void {
    this.currentRepairToken = undefined;
    this.update({
      repair: {
        ...EMPTY_REPAIR,
        handle,
        selection: this.state.repair.selection,
        fillOpenings: this.state.repair.fillOpenings,
        lastApplied: this.state.repair.lastApplied,
      },
    });
  }

  /**
   * Changes which operations the user wants attempted.
   *
   * The plan is marked stale rather than edited: which operations are applicable
   * depends on which others run first — duplicates are removed before winding is
   * solved — so a selection change requires the engine to decide again. Editing
   * the existing plan in place would show the user a plan that does not match
   * what a repair would do.
   */
  public setRepairSelection(selection: readonly RepairOperation[]): void {
    const repair = this.state.repair;
    this.currentRepairToken = undefined;
    this.update({
      repair: {
        ...repair,
        selection: [...selection],
        // THE PLAN IS KEPT ON SCREEN while the new one computes, for the same
        // reason a re-run of analysis keeps the previous report: blanking the
        // decision list on every checkbox click makes the panel lose its place,
        // and it takes the focused control out of the document underneath a
        // keyboard user. `planState` says it is being recomputed, and the
        // Preview button is withheld until the new plan lands — so nothing can
        // be built from decisions that no longer match the selection.
        planState: RepairPlanState.Planning,
        planError: undefined,
        candidateState: RepairCandidateState.Idle,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
  }

  /**
   * Includes or excludes automatic opening fills from Repair model —
   * REPAIR-CORE-02. A change of scope, so it replans exactly as a change of
   * operation selection does, and any preview built for the old scope goes.
   */
  public setFillOpenings(fillOpenings: boolean): void {
    const repair = this.state.repair;
    if (repair.fillOpenings === fillOpenings) return;
    this.currentRepairToken = undefined;
    this.update({
      repair: {
        ...repair,
        fillOpenings,
        planState: RepairPlanState.Planning,
        planError: undefined,
        candidateState: RepairCandidateState.Idle,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
  }

  /**
   * Claims a fresh token for building a candidate, keeping the plan on screen.
   *
   * Separate from `beginRepairPlan` because previewing does NOT re-plan: the
   * user is asking for the plan they can already see to be built. Reusing the
   * planning entry point would blank the decision list and then restore it,
   * which reads as the panel losing its place.
   *
   * Returns `undefined` when there is no plan to build, so a stray click cannot
   * start a candidate for nothing.
   */
  public beginRepairPreview(): RepairToken | undefined {
    const repair = this.state.repair;
    if (repair.planState !== RepairPlanState.Ready || repair.plan === undefined) return undefined;
    // REPAIR-CORE-02: a plan with no conservative work is still work when
    // filling is selected and the fill plan admitted at least one opening.
    const fills = repair.fillOpenings && fillableOpeningCount(repair.fillPlan) > 0;
    // REPAIR-CORE-06B: pinched vertices the local repair can attempt are work too.
    const pinches = (repair.localPlan?.eligible ?? 0) > 0;
    if (repair.plan.noOp && !fills && !pinches) return undefined;

    const token = this.nextRepairToken as RepairToken;
    this.nextRepairToken += 1;
    this.currentRepairToken = token;
    return token;
  }

  public beginRepairCandidate(token: RepairToken): boolean {
    if (!this.isCurrentRepair(token)) return false;
    this.update({
      repair: {
        ...this.state.repair,
        candidateState: RepairCandidateState.Building,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Installs a validated candidate.
   *
   * Only an ACCEPTED candidate reaches here — the service refuses anything else —
   * and the handle is still re-checked, because a candidate for a model that has
   * been replaced describes geometry the user is no longer looking at.
   *
   * The preview opens on AFTER: the user pressed Preview to see the proposal,
   * and the label above the viewport says it is not applied.
   */
  public commitRepairCandidate(token: RepairToken, preview: RepairPreview): boolean {
    if (!this.isCurrentRepair(token)) return false;
    if (!sameHandle(this.state.model?.handle, preview.source)) return false;

    this.update({
      repair: {
        ...this.state.repair,
        candidateState: RepairCandidateState.Ready,
        candidate: preview,
        candidateError: undefined,
        previewMode:
          preview.render === undefined && preview.patchRender === undefined
            ? RepairPreviewMode.Before
            : RepairPreviewMode.After,
        changeOverlays: CHANGE_OVERLAYS_SHOWN,
        fraction: 1,
        phase: undefined,
      },
    });
    return true;
  }

  public failRepairCandidate(token: RepairToken, error: RepairFailure): boolean {
    if (!this.isCurrentRepair(token)) return false;
    this.update({
      repair: {
        ...this.state.repair,
        candidateState: RepairCandidateState.Failed,
        candidate: undefined,
        candidateError: error,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Records that cancellation has been SIGNALLED but not yet acknowledged.
   *
   * Returns false when there is nothing running to cancel, so a stray click
   * cannot put the panel into a transitional state it can never leave.
   */
  public beginRepairCancellation(token: RepairToken): boolean {
    if (!this.isCurrentRepair(token)) return false;
    const repair = this.state.repair;
    if (repair.candidateState !== RepairCandidateState.Building) return false;
    this.update({
      repair: { ...repair, candidateState: RepairCandidateState.Cancelling },
    });
    return true;
  }

  public cancelRepairCandidate(token: RepairToken): boolean {
    if (!this.isCurrentRepair(token)) return false;
    this.update({
      repair: {
        ...this.state.repair,
        candidateState: RepairCandidateState.Cancelled,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Drops the candidate from the interface and returns what was dropped.
   *
   * The handle comes back so the caller can release the worker's copy. The store
   * cannot do that itself — it holds no client and dispatches nothing — and
   * forgetting a candidate without releasing it would leave a mesh the size of
   * the model resident for the rest of the session.
   */
  public clearRepairCandidate(): RepairCandidateHandle | undefined {
    const repair = this.state.repair;
    const dropped = repair.candidate?.candidate;
    if (repair.candidate === undefined && repair.candidateState === RepairCandidateState.Idle) {
      return undefined;
    }
    this.update({
      repair: {
        ...repair,
        candidateState: RepairCandidateState.Idle,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
    return dropped;
  }

  public setRepairPreviewMode(mode: RepairPreviewMode): void {
    const repair = this.state.repair;
    if (repair.previewMode === mode) return;
    // Showing the proposed result requires a proposed result to show.
    if (mode === RepairPreviewMode.After && repair.candidate?.render === undefined) return;
    this.update({ repair: { ...repair, previewMode: mode } });
  }

  public setChangeOverlayVisible(overlay: ChangeOverlayId, visible: boolean): void {
    const repair = this.state.repair;
    if (repair.changeOverlays[overlay] === visible) return;
    this.update({
      repair: { ...repair, changeOverlays: { ...repair.changeOverlays, [overlay]: visible } },
    });
  }

  /**
   * Claims the commit slot.
   *
   * Returns false when a commit or an undo is already running, which is the
   * guard that makes a double-click harmless: the second click finds the slot
   * taken and dispatches nothing. The worker refuses a second commit too — this
   * is the first of two independent defences, not the only one.
   */
  public beginRepairCommit(): boolean {
    if (this.state.conversion.state === ConversionState.Working) return false;
    const repair = this.state.repair;
    if (repair.commitState !== RepairCommitState.Idle) return false;
    if (repair.candidateState !== RepairCandidateState.Ready || repair.candidate === undefined) {
      return false;
    }
    this.update({
      repair: {
        ...repair,
        commitState: RepairCommitState.Applying,
        commitError: undefined,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Progress for a commit or an undo.
   *
   * Not tokened, because `commitState` already admits exactly one at a time —
   * there is no second attempt to tell it apart from. An update that arrives
   * when neither is running belongs to an operation that has already finished
   * and is dropped.
   */
  public reportRepairCommitProgress(fraction: number, phase: string): void {
    const repair = this.state.repair;
    if (repair.commitState === RepairCommitState.Idle) return;
    if (
      repair.phase === phase &&
      Math.round(repair.fraction * 100) === Math.round(fraction * 100)
    ) {
      return;
    }
    this.update({ repair: { ...repair, fraction, phase } });
  }

  public failRepairCommit(error: RepairFailure): void {
    this.update({
      repair: {
        ...this.state.repair,
        commitState: RepairCommitState.Idle,
        commitError: error,
        fraction: 0,
        phase: undefined,
      },
    });
  }

  /**
   * Installs a committed repair as the loaded model.
   *
   * THE MODEL IS REPLACED, not annotated. What the viewport draws, what export
   * resolves, and what Mesh Health describes all follow from `model`, so a
   * commit that updated anything less than this would leave one of them
   * describing the previous revision. The source file facts are carried forward:
   * the user's file did not change, its geometry did.
   *
   * Analysis is reset to `Idle` for the NEW handle, which is what makes
   * diagnostics re-run automatically against the repaired geometry.
   */
  /** Shared future split/texture commit path. Every diagnostic belongs to the old revision. */
  public applyGeometryEditResult(result: EditCommitResult): boolean {
    const model = this.state.model;
    if (
      model?.handle.documentId !== result.handle.documentId ||
      model.handle.revision !== result.parentRevision
    )
      return false;
    if (!model.parts.some((part) => part.partId === result.partId)) return false;
    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;
    this.currentSelfIntersectionToken = undefined;
    this.currentHoleFillToken = undefined;
    const edited = result.parts.find((part) => part.partId === result.partId);
    this.update({
      model: {
        ...model,
        handle: result.handle,
        parts: result.parts,
        render: withPartRender(model.render, result.partId, result.render, result.parts),
        bounds: result.bounds,
        triangleCount: result.triangleCount,
        vertexCount: result.vertexCount,
        residentBytes: result.residentBytes,
        revision,
      },
      analysis: {
        ...EMPTY_ANALYSIS,
        state: AnalysisState.Idle,
        handle: result.handle,
        partId: this.state.activePartId,
      },
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: result.handle,
        partId: this.state.activePartId,
        band: bandForFaceCount(edited?.triangleCount ?? result.triangleCount),
      },
      overlays: OVERLAYS_HIDDEN,
      repair: { ...EMPTY_REPAIR, handle: result.handle, partId: this.state.activePartId },
      holeFill: { ...EMPTY_HOLE_FILL, handle: result.handle, partId: this.state.activePartId },
      texturePreview: undefined,
      textureSelection: undefined,
    });
    return true;
  }

  public applyRepairResult(result: {
    readonly handle: DocumentHandle;
    readonly parentRevision: number;
    readonly recordId: string;
    readonly appliedOperations: readonly RepairOperation[];
    readonly counts: RepairChangeCounts;
    readonly filledOpenings?: number;
    readonly localRepaired?: number;
    readonly localReversed?: number;
    readonly undoable: boolean;
    readonly partId: string;
    readonly render: RenderSnapshot;
    readonly parts: readonly PartDescriptor[];
    readonly bounds: MeshBounds | undefined;
    readonly triangleCount: number;
    readonly vertexCount: number;
    readonly residentBytes: number;
  }): boolean {
    const model = this.state.model;
    if (model === undefined) return false;
    if (model.handle.documentId !== result.handle.documentId) return false;

    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;

    const repairedPart = result.parts.find((part) => part.partId === result.partId);

    this.update({
      model: {
        ...model,
        handle: result.handle,
        parts: result.parts,
        // Only the repaired part's buffers change. The rest of the scene is
        // already correct and is not re-uploaded.
        render: withPartRender(model.render, result.partId, result.render, result.parts),
        bounds: result.bounds,
        triangleCount: result.triangleCount,
        vertexCount: result.vertexCount,
        residentBytes: result.residentBytes,
        revision,
      },
      analysis: {
        ...EMPTY_ANALYSIS,
        state: AnalysisState.Idle,
        handle: result.handle,
        partId: this.state.activePartId,
      },
      /*
       * A NEW REVISION GETS A NEW VERDICT, OR NONE AT ALL.
       *
       * The previous report described geometry that no longer exists. Carrying
       * it forward — even for the instant before a fresh check starts — would
       * put "None found" beside a model nothing has examined. The band is
       * re-derived too, because a repair can move a part across a policy
       * boundary.
       *
       * EVERY part's verdict goes, not just the repaired one: the document
       * carries a single revision, so part B's report is bound to a handle that
       * no longer resolves. That is the qualified cost of one revision.
       */
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: result.handle,
        partId: this.state.activePartId,
        band: bandForFaceCount(repairedPart?.triangleCount ?? result.triangleCount),
      },
      overlays: OVERLAYS_HIDDEN,
      /*
       * A REPAIR SUPERSEDES A FILL IN THE ONE UNDO HISTORY.
       *
       * `lastApplied` is dropped rather than kept, because the worker's history
       * store has just marked that record un-undoable: there is exactly one
       * reversible change per document. Keeping the button would offer to
       * reverse something the worker will refuse.
       */
      holeFill: {
        ...EMPTY_HOLE_FILL,
        handle: result.handle,
        partId: this.state.activePartId,
      },
      repair: {
        ...EMPTY_REPAIR,
        handle: result.handle,
        partId: this.state.activePartId,
        selection: this.state.repair.selection,
        fillOpenings: this.state.repair.fillOpenings,
        lastApplied: {
          recordId: result.recordId,
          handle: result.handle,
          partId: result.partId,
          parentRevision: result.parentRevision,
          appliedOperations: result.appliedOperations,
          counts: result.counts,
          filledOpenings: result.filledOpenings ?? 0,
          localRepaired: result.localRepaired ?? 0,
          localReversed: result.localReversed ?? 0,
          undoable: result.undoable,
        },
      },
    });
    return true;
  }

  /** Claims the undo slot. False when a commit or undo is already running. */
  public beginRepairUndo(): boolean {
    if (this.state.conversion.state === ConversionState.Working) return false;
    const repair = this.state.repair;
    if (repair.commitState !== RepairCommitState.Idle) return false;
    if (repair.lastApplied?.undoable !== true) return false;
    this.update({
      repair: {
        ...repair,
        commitState: RepairCommitState.Undoing,
        commitError: undefined,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  public failRepairUndo(error: RepairFailure): void {
    this.update({
      repair: {
        ...this.state.repair,
        commitState: RepairCommitState.Idle,
        commitError: error,
        fraction: 0,
        phase: undefined,
      },
    });
  }

  /**
   * Installs restored geometry as the loaded model.
   *
   * A NEW REVISION, not a rewind. The undo produced fresh authoritative geometry
   * in the worker at a higher revision number, and the interface follows it —
   * see ADR 0011. `lastApplied` is cleared because the repair it described has
   * been reversed and can no longer be reversed again.
   */
  public applyUndoResult(result: {
    readonly handle: DocumentHandle;
    readonly partId: string;
    readonly render: RenderSnapshot;
    readonly documentRender?: DocumentRenderSnapshot;
    readonly parts: readonly PartDescriptor[];
    readonly bounds: MeshBounds | undefined;
    readonly triangleCount: number;
    readonly vertexCount: number;
    readonly residentBytes: number;
  }): boolean {
    const model = this.state.model;
    if (model === undefined) return false;
    if (model.handle.documentId !== result.handle.documentId) return false;

    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;

    const restoredPart = result.parts.find((part) => part.partId === result.partId);

    this.update({
      model: {
        ...model,
        handle: result.handle,
        parts: result.parts,
        render:
          result.documentRender ??
          withPartRender(model.render, result.partId, result.render, result.parts),
        bounds: result.bounds,
        triangleCount: result.triangleCount,
        vertexCount: result.vertexCount,
        residentBytes: result.residentBytes,
        revision,
      },
      analysis: {
        ...EMPTY_ANALYSIS,
        state: AnalysisState.Idle,
        handle: result.handle,
        partId: this.state.activePartId,
      },
      /*
       * A NEW REVISION GETS A NEW VERDICT, OR NONE AT ALL. See
       * `applyRepairResult` — an undo is a forward revision like any other.
       */
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: result.handle,
        partId: this.state.activePartId,
        band: bandForFaceCount(restoredPart?.triangleCount ?? result.triangleCount),
      },
      overlays: OVERLAYS_HIDDEN,
      /*
       * AN UNDO IS A FORWARD REVISION LIKE ANY OTHER, so the fill workflow is
       * re-bound to it and re-listed from scratch. `lastApplied` goes because
       * the change it named has now been reversed — for a hole fill this IS the
       * record being reversed, and for a repair it was already superseded.
       */
      holeFill: {
        ...EMPTY_HOLE_FILL,
        handle: result.handle,
        partId: this.state.activePartId,
      },
      repair: {
        ...EMPTY_REPAIR,
        handle: result.handle,
        partId: this.state.activePartId,
        selection: this.state.repair.selection,
        fillOpenings: this.state.repair.fillOpenings,
      },
    });
    return true;
  }

  /* ------------------------------------------------------ hole filling -- */

  /**
   * Claims the hole-fill slot for one part and returns this attempt's token.
   *
   * One token stream covers listing, previewing and generating, because they are
   * one user-visible workflow: a listing that lands after the user switched
   * parts must not install itself, and neither must a candidate built for an
   * opening they have since deselected.
   */
  public beginHoleFillListing(handle: DocumentHandle, partId: string): HoleFillToken {
    const token = this.nextHoleFillToken as HoleFillToken;
    this.nextHoleFillToken += 1;
    this.currentHoleFillToken = token;
    this.update({
      holeFill: {
        ...this.state.holeFill,
        handle,
        partId,
        inventory: { ...EMPTY_INVENTORY, state: HoleFillInventoryState.Listing },
        selectedLoopId: undefined,
        rim: undefined,
      },
    });
    return token;
  }

  public isCurrentHoleFill(token: HoleFillToken): boolean {
    return this.currentHoleFillToken === token;
  }

  public commitHoleFillListing(
    token: HoleFillToken,
    listing: {
      readonly handle: DocumentHandle;
      readonly partId: string;
      /** False when the worker skipped the walk. See `NotInventoried`. */
      readonly inventoried: boolean;
      readonly loopCount: number;
      readonly rows: readonly HoleBoundaryRow[];
      readonly truncated: boolean;
      readonly partFaceCount: number;
    },
  ): boolean {
    if (!this.isCurrentHoleFill(token)) return false;
    this.currentHoleFillToken = undefined;
    this.update({
      holeFill: {
        ...this.state.holeFill,
        handle: listing.handle,
        partId: listing.partId,
        inventory: {
          state: listing.inventoried
            ? HoleFillInventoryState.Ready
            : HoleFillInventoryState.NotInventoried,
          loopCount: listing.loopCount,
          rows: listing.rows,
          truncated: listing.truncated,
          partFaceCount: listing.partFaceCount,
          error: undefined,
        },
      },
    });
    return true;
  }

  public failHoleFillListing(token: HoleFillToken, error: HoleFillFailure): boolean {
    if (!this.isCurrentHoleFill(token)) return false;
    this.currentHoleFillToken = undefined;
    this.update({
      holeFill: {
        ...this.state.holeFill,
        inventory: { ...EMPTY_INVENTORY, state: HoleFillInventoryState.Failed, error },
      },
    });
    return true;
  }

  /**
   * Marks the hole-fill workflow unavailable and re-binds it to `handle`.
   *
   * The counterpart of `setRepairUnavailable`: used when there is no model, no
   * active part, or no live worker. Anything retained would describe geometry
   * nothing can address.
   */
  public setHoleFillUnavailable(handle: DocumentHandle | undefined, partId?: string): void {
    this.currentHoleFillToken = undefined;
    this.update({
      holeFill: {
        ...EMPTY_HOLE_FILL,
        handle,
        partId,
        // Survives, because it describes a change that really happened to this
        // model and is still the thing Undo would reverse.
        lastApplied: this.state.holeFill.lastApplied,
      },
    });
  }

  /**
   * Selects one opening BY IDENTITY.
   *
   * The rim is cleared rather than carried: it is a buffer for a different
   * opening. Any existing candidate is cleared too — a candidate closes ONE
   * named opening, so leaving it visible beside a different selection would
   * offer an Apply for something other than what is highlighted. Its worker-side
   * release is the caller's responsibility, exactly as a repair candidate's is.
   *
   * Returns the candidate that must now be released, or `undefined`.
   */
  public selectBoundaryLoop(boundaryLoopId: string | undefined): HoleFillPreview | undefined {
    const holeFill = this.state.holeFill;
    if (holeFill.selectedLoopId === boundaryLoopId) return undefined;
    const dropped = holeFill.candidate;
    this.currentHoleFillToken = undefined;
    this.update({
      holeFill: {
        ...holeFill,
        selectedLoopId: boundaryLoopId,
        rim: undefined,
        workState: HoleFillWorkState.Idle,
        candidate: undefined,
        candidateError: undefined,
        phase: undefined,
        commitError: undefined,
      },
    });
    return dropped;
  }

  /**
   * Installs the rim buffer for the selected opening.
   *
   * REFUSED WHEN ANYTHING HAS MOVED. A rim that arrives for a revision, a part
   * or an opening the workspace has left is dropped rather than drawn — the
   * page cannot rely on arrival order, and a rim in the wrong frame marks an
   * opening where there is none.
   */
  public installBoundaryRim(rim: BoundaryRimPreview): boolean {
    const { model, activePartId, holeFill } = this.state;
    if (model === undefined) return false;
    if (rim.source.documentId !== model.handle.documentId) return false;
    if (rim.source.revision !== model.handle.revision) return false;
    if (rim.partId !== activePartId) return false;
    if (rim.boundaryLoopId !== holeFill.selectedLoopId) return false;
    this.update({ holeFill: { ...holeFill, rim } });
    return true;
  }

  /** Claims the generation slot. False when the workflow has moved on. */
  public beginHoleFillCandidate(
    handle: DocumentHandle,
    partId: string,
    boundaryLoopId: string,
  ): HoleFillToken | undefined {
    const holeFill = this.state.holeFill;
    if (holeFill.selectedLoopId !== boundaryLoopId) return undefined;
    if (holeFill.commitState !== HoleFillCommitState.Idle) return undefined;
    const token = this.nextHoleFillToken as HoleFillToken;
    this.nextHoleFillToken += 1;
    this.currentHoleFillToken = token;
    this.update({
      holeFill: {
        ...holeFill,
        handle,
        partId,
        workState: HoleFillWorkState.Generating,
        candidate: undefined,
        candidateError: undefined,
        commitError: undefined,
        phase: 'Preparing',
      },
    });
    return token;
  }

  /**
   * Reports which phase the fill has reached.
   *
   * A NAME, NEVER A PERCENTAGE. The engine reports when it has started and when
   * it has finished; the phases in between are not instrumented as a fraction,
   * and inventing one would be a progress bar that means nothing. See
   * `hole-fill-presentation.ts` for the wording.
   */
  public reportHoleFillPhase(token: HoleFillToken, phase: string): void {
    if (!this.isCurrentHoleFill(token)) return;
    const holeFill = this.state.holeFill;
    if (holeFill.workState !== HoleFillWorkState.Generating) return;
    if (holeFill.phase === phase) return;
    this.update({ holeFill: { ...holeFill, phase } });
  }

  /** Moves into the transitional cancelling state for the RIGHT attempt. */
  public beginHoleFillCancellation(token: HoleFillToken): boolean {
    if (!this.isCurrentHoleFill(token)) return false;
    const holeFill = this.state.holeFill;
    if (holeFill.workState !== HoleFillWorkState.Generating) return false;
    this.update({
      holeFill: { ...holeFill, workState: HoleFillWorkState.Cancelling, phase: undefined },
    });
    return true;
  }

  public cancelHoleFillCandidate(token: HoleFillToken): boolean {
    if (!this.isCurrentHoleFill(token)) return false;
    this.currentHoleFillToken = undefined;
    this.update({
      holeFill: {
        ...this.state.holeFill,
        workState: HoleFillWorkState.Cancelled,
        candidate: undefined,
        candidateError: undefined,
        phase: undefined,
      },
    });
    return true;
  }

  public commitHoleFillCandidate(token: HoleFillToken, preview: HoleFillPreview): boolean {
    if (!this.isCurrentHoleFill(token)) return false;
    const { model, activePartId, holeFill } = this.state;
    if (model === undefined) return false;
    // THE CANDIDATE MUST STILL DESCRIBE WHAT IS ON SCREEN. Document, revision,
    // part and opening — all four, because two parts share a revision and one
    // part has many openings.
    if (preview.source.documentId !== model.handle.documentId) return false;
    if (preview.source.revision !== model.handle.revision) return false;
    if (preview.partId !== activePartId) return false;
    if (preview.boundaryLoopId !== holeFill.selectedLoopId) return false;

    this.currentHoleFillToken = undefined;
    this.update({
      holeFill: {
        ...holeFill,
        workState: HoleFillWorkState.Ready,
        candidate: preview,
        candidateError: undefined,
        phase: undefined,
      },
    });
    return true;
  }

  public failHoleFillCandidate(token: HoleFillToken, error: HoleFillFailure): boolean {
    if (!this.isCurrentHoleFill(token)) return false;
    this.currentHoleFillToken = undefined;
    this.update({
      holeFill: {
        ...this.state.holeFill,
        workState: HoleFillWorkState.Failed,
        candidate: undefined,
        candidateError: error,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Attaches the patch snapshot to the candidate it was built from.
   *
   * Refused when the candidate on screen is not the one this describes, so a
   * snapshot that arrives after a discard or a supersession cannot decorate its
   * replacement with the wrong triangles.
   */
  public installPatchPreview(
    candidateId: string,
    patch: {
      readonly positions: Float32Array;
      readonly normals: Float32Array;
      readonly triangleCount: number;
    },
  ): boolean {
    const holeFill = this.state.holeFill;
    const candidate = holeFill.candidate;
    if (candidate === undefined) return false;
    if (candidate.candidate.candidateId !== candidateId) return false;
    this.update({
      holeFill: {
        ...holeFill,
        candidate: {
          ...candidate,
          patchPositions: patch.positions,
          patchNormals: patch.normals,
          patchTriangleCount: patch.triangleCount,
        },
      },
    });
    return true;
  }

  /**
   * Drops the candidate and returns it, so the caller can release the worker's
   * copy. The selection and the rim survive: discarding a preview is not
   * deselecting an opening.
   */
  public clearHoleFillCandidate(): HoleFillPreview | undefined {
    const holeFill = this.state.holeFill;
    const dropped = holeFill.candidate;
    if (dropped === undefined && holeFill.workState === HoleFillWorkState.Idle) return undefined;
    this.currentHoleFillToken = undefined;
    this.update({
      holeFill: {
        ...holeFill,
        workState: HoleFillWorkState.Idle,
        candidate: undefined,
        candidateError: undefined,
        phase: undefined,
      },
    });
    return dropped;
  }

  /** Claims the apply slot. False when a commit or undo is already running. */
  public beginHoleFillCommit(): boolean {
    const holeFill = this.state.holeFill;
    if (holeFill.commitState !== HoleFillCommitState.Idle) return false;
    if (holeFill.workState !== HoleFillWorkState.Ready) return false;
    if (holeFill.candidate === undefined) return false;
    // ONE MUTATION AT A TIME across the whole workspace: a repair commit and a
    // fill commit would race for the same revision, and the loser's typed
    // refusal would look like a defect to the user.
    if (this.state.repair.commitState !== RepairCommitState.Idle) return false;
    this.update({
      holeFill: {
        ...holeFill,
        commitState: HoleFillCommitState.Applying,
        commitError: undefined,
      },
    });
    return true;
  }

  public failHoleFillCommit(error: HoleFillFailure): void {
    this.update({
      holeFill: {
        ...this.state.holeFill,
        commitState: HoleFillCommitState.Idle,
        commitError: error,
      },
    });
  }

  /**
   * Installs the filled geometry as the loaded model.
   *
   * A NEW WORKSPACE REVISION, and every per-part diagnostic slice is cleared for
   * exactly the reason `applyRepairResult` clears them: the previous reports
   * describe geometry that no longer exists, and carrying one forward — even for
   * the instant before a fresh analysis starts — would put a count beside a
   * model nothing has examined.
   *
   * THE REPAIR SLICE IS CLEARED TOO, including its `lastApplied`. There is ONE
   * undo history and this fill has just superseded whatever was in it, so
   * leaving a repair's Undo button enabled would offer to reverse something the
   * worker will refuse.
   */
  public applyHoleFillResult(result: {
    readonly handle: DocumentHandle;
    readonly parentRevision: number;
    readonly recordId: string;
    readonly partId: string;
    readonly boundaryLoopId: string;
    readonly patchFaceCount: number;
    readonly undoable: boolean;
    readonly render: RenderSnapshot;
    readonly parts: readonly PartDescriptor[];
    readonly bounds: MeshBounds | undefined;
    readonly triangleCount: number;
    readonly vertexCount: number;
    readonly residentBytes: number;
  }): boolean {
    const model = this.state.model;
    if (model === undefined) return false;
    if (model.handle.documentId !== result.handle.documentId) return false;

    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;
    this.currentSelfIntersectionToken = undefined;
    this.currentHoleFillToken = undefined;

    const filledPart = result.parts.find((part) => part.partId === result.partId);

    this.update({
      model: {
        ...model,
        handle: result.handle,
        parts: result.parts,
        // Only the filled part's buffers change. The rest of the scene is
        // already correct and is not re-uploaded — which is also what keeps a
        // sibling that SHARED the old mesh drawing the geometry it still has.
        render: withPartRender(model.render, result.partId, result.render, result.parts),
        bounds: result.bounds,
        triangleCount: result.triangleCount,
        vertexCount: result.vertexCount,
        residentBytes: result.residentBytes,
        revision,
      },
      analysis: {
        ...EMPTY_ANALYSIS,
        state: AnalysisState.Idle,
        handle: result.handle,
        partId: this.state.activePartId,
      },
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: result.handle,
        partId: this.state.activePartId,
        band: bandForFaceCount(filledPart?.triangleCount ?? result.triangleCount),
      },
      overlays: OVERLAYS_HIDDEN,
      repair: {
        ...EMPTY_REPAIR,
        handle: result.handle,
        partId: this.state.activePartId,
        selection: this.state.repair.selection,
        fillOpenings: this.state.repair.fillOpenings,
      },
      holeFill: {
        ...EMPTY_HOLE_FILL,
        handle: result.handle,
        partId: this.state.activePartId,
        lastApplied: {
          recordId: result.recordId,
          handle: result.handle,
          partId: result.partId,
          boundaryLoopId: result.boundaryLoopId,
          parentRevision: result.parentRevision,
          patchFaceCount: result.patchFaceCount,
          undoable: result.undoable,
        },
      },
    });
    return true;
  }

  /** Claims the undo slot for a hole fill. */
  public beginHoleFillUndo(): boolean {
    if (this.state.conversion.state === ConversionState.Working) return false;
    const holeFill = this.state.holeFill;
    if (holeFill.commitState !== HoleFillCommitState.Idle) return false;
    if (holeFill.lastApplied?.undoable !== true) return false;
    if (this.state.repair.commitState !== RepairCommitState.Idle) return false;
    this.update({
      holeFill: { ...holeFill, commitState: HoleFillCommitState.Undoing, commitError: undefined },
    });
    return true;
  }

  public failHoleFillUndo(error: HoleFillFailure): void {
    this.update({
      holeFill: {
        ...this.state.holeFill,
        commitState: HoleFillCommitState.Idle,
        commitError: error,
      },
    });
  }

  /**
   * Claims the analysis slot for `handle`.
   *
   * The previous report is deliberately KEPT while the new analysis runs. A
   * re-analysis of the same model should not blank the panel the user is
   * reading; if the new run is cancelled or fails, what was already known is
   * still true and still shown.
   */
  public beginAnalysis(handle: DocumentHandle, partId: string): AnalysisToken {
    const token = this.nextAnalysisToken as AnalysisToken;
    this.nextAnalysisToken += 1;
    this.currentAnalysisToken = token;

    const previous = this.state.analysis;
    /*
     * The previous report is carried forward only when it describes THE SAME
     * PART of the same revision. Two parts share a handle, so comparing handles
     * alone would leave part A's counts on screen while part B is analysed.
     */
    const sameSubject = sameHandle(previous.handle, handle) && previous.partId === partId;
    this.update({
      analysis: {
        ...previous,
        state: AnalysisState.Analyzing,
        handle,
        partId,
        fraction: 0,
        phase: undefined,
        error: undefined,
        // Report and detail intentionally carried forward.
        report: sameSubject ? previous.report : undefined,
        detail: sameSubject ? previous.detail : undefined,
      },
    });
    return token;
  }

  public isCurrentAnalysis(token: AnalysisToken): boolean {
    return this.currentAnalysisToken === token;
  }

  /** Selects an issue at its first occurrence, or clears the selection. */
  public selectIssue(issue: RepairIssueId | undefined, key: string | undefined): void {
    if (issue === undefined || key === undefined) {
      if (this.state.issueSelection !== undefined) this.update({ issueSelection: undefined });
      return;
    }
    this.update({ issueSelection: { issue, occurrence: 0, key } });
  }

  /** Moves the current selection to another occurrence of the same issue. */
  public setIssueOccurrence(occurrence: number): void {
    const selection = this.state.issueSelection;
    if (selection === undefined || selection.occurrence === occurrence) return;
    this.update({ issueSelection: { ...selection, occurrence } });
  }

  public requestFrame(
    key: string,
    center: readonly [number, number, number],
    radius: number,
  ): void {
    const sequence = (this.state.frameRequest?.sequence ?? 0) + 1;
    this.update({ frameRequest: { sequence, key, center, radius } });
  }

  public setOverlayVisible(overlay: OverlayId, visible: boolean): void {
    if (this.state.overlays[overlay] === visible) return;
    this.update({ overlays: { ...this.state.overlays, [overlay]: visible } });
  }

  public reportAnalysisProgress(token: AnalysisToken, fraction: number, phase: string): void {
    if (!this.isCurrentAnalysis(token)) return;
    const analysis = this.state.analysis;
    // Coalesced at the source: a worker phase can emit many updates per second,
    // and re-rendering for a fraction that rounds to the same displayed percent
    // is work nobody sees. Phase changes always pass through.
    if (
      analysis.phase === phase &&
      Math.round(analysis.fraction * 100) === Math.round(fraction * 100)
    ) {
      return;
    }
    this.update({ analysis: { ...analysis, state: AnalysisState.Analyzing, fraction, phase } });
  }

  /**
   * Installs a report, but only for the model that is actually loaded.
   *
   * TWO GATES, not one. The token rejects a superseded analysis; the handle
   * comparison rejects a report whose model is no longer current even if the
   * token somehow survived. Either alone would leave a path for M0's topology
   * to be displayed beside M1's geometry.
   */
  public commitAnalysis(
    token: AnalysisToken,
    handle: DocumentHandle,
    partId: string,
    report: TopologyReport,
    detail: TopologyDetail,
    durationMs: number,
  ): boolean {
    if (!this.isCurrentAnalysis(token)) return false;
    if (!sameHandle(this.state.model?.handle, handle)) return false;
    /*
     * THE PART GUARD, and it is not redundant with the handle.
     *
     * Two parts of one document share a revision, so a report for part A and a
     * report for part B carry IDENTICAL handles. Without this check a report
     * that finished after the user switched parts would install itself against
     * the part now on screen and describe geometry nobody analysed.
     */
    if (this.state.activePartId !== partId) return false;
    this.currentAnalysisToken = undefined;

    this.update({
      analysis: {
        state: AnalysisState.Ready,
        handle,
        partId,
        fraction: 1,
        phase: undefined,
        report,
        detail,
        error: undefined,
        durationMs,
      },
    });
    return true;
  }

  /**
   * Records that analysis did not produce a report.
   *
   * Does NOT touch `model`: a failed analysis leaves the imported geometry fully
   * usable. Losing a successfully imported model because diagnostics ran out of
   * memory would be a worse outcome than having no diagnostics.
   */
  public failAnalysis(token: AnalysisToken, error: AnalysisFailure): boolean {
    if (!this.isCurrentAnalysis(token)) return false;
    this.currentAnalysisToken = undefined;

    const analysis = this.state.analysis;
    this.update({
      analysis: { ...analysis, state: AnalysisState.Failed, fraction: 0, phase: undefined, error },
    });
    return true;
  }

  /**
   * Records a cancelled analysis.
   *
   * Falls back to `ready` when a complete earlier report for the same model is
   * still held — cancelling a re-run should not discard the answer the user
   * already had. A partial report is never installed by any path.
   */
  public cancelAnalysis(token: AnalysisToken): boolean {
    if (!this.isCurrentAnalysis(token)) return false;
    this.currentAnalysisToken = undefined;

    const analysis = this.state.analysis;
    const hasEarlierReport = analysis.report !== undefined;
    this.update({
      analysis: {
        ...analysis,
        state: hasEarlierReport ? AnalysisState.Ready : AnalysisState.Cancelled,
        fraction: hasEarlierReport ? 1 : 0,
        phase: undefined,
        error: undefined,
      },
    });
    return true;
  }

  /**
   * Records that an import did not succeed.
   *
   * Deliberately does NOT touch `model`. A failed or cancelled replacement must
   * leave whatever was already loaded exactly as it was — losing the user's
   * model because the next file turned out to be broken would be its own kind
   * of data loss. A stale failure is ignored entirely, so a superseded import
   * cannot put the interface into an error state that belongs to nothing.
   */
  public failImport(token: ImportToken): boolean {
    if (!this.isCurrentImport(token)) return false;
    this.currentImportToken = undefined;
    this.update({
      importProgress: {
        state: this.state.model === undefined ? ImportState.Error : ImportState.Ready,
        fraction: this.state.model === undefined ? 0 : 1,
      },
    });
    return true;
  }

  /**
   * Claims the export slot.
   *
   * Tokened for the same reason imports are: a second export started while the
   * first is still writing would otherwise have its progress bar driven by
   * whichever operation reported last. Progress from a superseded export is
   * discarded rather than displayed.
   */
  /**
   * Records total loss of worker-side geometry and discards the model.
   *
   * POLICY A. The worker held the ONLY copy of the authoritative mesh, so there
   * is nothing left to operate on. Nothing is reconstructed from the render
   * snapshot — pixels are not geometry — and leaving the picture on screen would
   * imply a working session that no longer exists: export would fail, and so
   * would every future diagnostic. Showing nothing and saying why is the less
   * misleading of the two options.
   *
   * In-flight tokens are cleared so a late reply from the dead worker cannot
   * install anything afterwards.
   */
  public loseGeometrySession(reason: string): void {
    this.currentImportToken = undefined;
    this.currentExportToken = undefined;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;
    this.currentConversionToken = undefined;
    this.currentHoleFillToken = undefined;
    this.currentSelfIntersectionToken = undefined;
    this.update({
      model: undefined,
      importedHandle: undefined,
      geometrySessionLost: reason,
      importProgress: { state: ImportState.Idle, fraction: 0 },
      exportProgress: { state: ExportState.Idle, fraction: 0 },
      // The report described geometry that no longer exists. Keeping it on
      // screen would describe a model the user cannot export, overlay, or act
      // on — the same reason the model itself is cleared.
      analysis: EMPTY_ANALYSIS,
      selfIntersection: EMPTY_SELF_INTERSECTION,
      // And so did the repair. A candidate, a preview and an undo record all
      // named worker-resident geometry that died with the worker; leaving an
      // Apply button pointing at a dead candidate would be worse than showing
      // nothing, because pressing it could only fail.
      repair: EMPTY_REPAIR,
      // And so did the fill workflow: the openings were listed from geometry
      // that is gone, the candidate died with the worker that held it, and the
      // applied record names an undo nothing can perform. Policy A applies to
      // all of it.
      holeFill: EMPTY_HOLE_FILL,
      // The document the session described is gone with the worker that held it.
      conversion: CONVERSION_CLOSED,
      overlays: OVERLAYS_HIDDEN,
    });
  }

  public beginExport(encoding: string): ExportToken {
    const token = this.nextExportToken as ExportToken;
    this.nextExportToken += 1;
    this.currentExportToken = token;
    this.update({ exportProgress: { state: ExportState.Working, fraction: 0, encoding } });
    return token;
  }

  public isCurrentExport(token: ExportToken): boolean {
    return this.currentExportToken === token;
  }

  public reportExportProgress(token: ExportToken, fraction: number, encoding: string): void {
    if (!this.isCurrentExport(token)) return;
    this.update({ exportProgress: { state: ExportState.Working, fraction, encoding } });
  }

  /** Ends the export, whether it succeeded, failed, or was cancelled. */
  public finishExport(token: ExportToken): boolean {
    if (!this.isCurrentExport(token)) return false;
    this.currentExportToken = undefined;
    this.update({ exportProgress: { state: ExportState.Idle, fraction: 0 } });
    return true;
  }

  /* ------------------------------------------------ format conversion -- */

  /**
   * Starts a conversion session for the loaded model.
   *
   * `preferredTarget` is the source format when that format can be written.
   * Every other field starts empty — in particular the unit, which is never
   * carried over from a previous session, a previous model or a default.
   */
  public openConversion(preferredTarget: string | undefined): void {
    this.currentConversionToken = undefined;
    this.update({
      conversion: {
        ...CONVERSION_CLOSED,
        state: ConversionState.Reviewing,
        target: preferredTarget,
      },
    });
  }

  public closeConversion(): void {
    this.currentConversionToken = undefined;
    this.update({ conversion: CONVERSION_CLOSED });
  }

  /**
   * Chooses a target.
   *
   * THE UNIT CHOICE SURVIVES A TARGET CHANGE, because it is a statement about
   * the MODEL rather than about the target: someone who has said "these numbers
   * are inches" has not unsaid it by looking at what OBJ would do. Any finished
   * result does not survive, because it described a different format.
   */
  public setConversionTarget(target: string): void {
    const previous = this.state.conversion;
    if (previous.state === ConversionState.Working) return;
    this.update({
      conversion: {
        ...previous,
        state: ConversionState.Reviewing,
        target,
        fraction: 0,
        phase: undefined,
        failure: undefined,
        result: undefined,
      },
    });
  }

  /** States what the model's numbers mean, for the export only. */
  public setConversionUnit(unit: string | undefined): void {
    const previous = this.state.conversion;
    if (previous.state === ConversionState.Working) return;
    this.update({
      conversion: {
        ...previous,
        state: ConversionState.Reviewing,
        unitAssertion: unit,
        failure: undefined,
        result: undefined,
      },
    });
  }

  /**
   * Retires the outcome of the LAST attempt — CONVERT-UX-02.
   *
   * A NEW DESTINATION IS A DIFFERENT FILE. "Export complete" beside a filename
   * the user has since retyped, or a failure beside a folder they have since
   * replaced, describes an attempt they are no longer configuring. The target
   * and unit setters above already do this for their own fields; this is the
   * same step for the two fields the store does not hold.
   *
   * WHAT IS KEPT: the measured sizes and the remembered size refusals, which
   * are facts about revision, target and unit and do not depend on where a
   * file is saved.
   */
  public clearConversionOutcome(): void {
    const previous = this.state.conversion;
    if (previous.state !== ConversionState.Saved && previous.state !== ConversionState.Failed) {
      return;
    }
    this.update({
      conversion: {
        ...previous,
        state: ConversionState.Reviewing,
        fraction: 0,
        phase: undefined,
        failure: undefined,
        result: undefined,
      },
    });
  }

  public beginConversion(): ConversionToken {
    const token = this.nextConversionToken as ConversionToken;
    this.nextConversionToken += 1;
    this.currentConversionToken = token;
    this.update({
      conversion: {
        ...this.state.conversion,
        state: ConversionState.Working,
        fraction: 0,
        phase: undefined,
        failure: undefined,
        result: undefined,
      },
    });
    return token;
  }

  public isCurrentConversion(token: ConversionToken): boolean {
    return this.currentConversionToken === token;
  }

  public reportConversionProgress(
    token: ConversionToken,
    fraction: number,
    phase: string | undefined,
  ): void {
    if (!this.isCurrentConversion(token)) return;
    this.update({
      conversion: { ...this.state.conversion, state: ConversionState.Working, fraction, phase },
    });
  }

  /**
   * Records that a file was written, validated and handed to the browser.
   *
   * Returns false for a superseded attempt, so a result from a cancelled or
   * replaced conversion cannot report success over the top of a later one.
   */
  public completeConversion(token: ConversionToken, result: ConversionResult): boolean {
    if (!this.isCurrentConversion(token)) return false;
    this.currentConversionToken = undefined;
    const entry: MeasuredExport = {
      documentId: result.source.documentId,
      revision: result.source.revision,
      target: result.target,
      unitAssertion: result.unitAssertion,
      byteLength: result.byteLength,
    };
    const measured = [
      ...this.state.conversion.measured.filter(
        (existing) =>
          measuredExportFor([existing], result.source, entry.target, entry.unitAssertion) ===
          undefined,
      ),
      entry,
    ].slice(-MAX_MEASURED_EXPORTS);
    this.update({
      conversion: {
        ...this.state.conversion,
        state: ConversionState.Saved,
        fraction: 1,
        phase: undefined,
        failure: undefined,
        result,
        measured,
      },
    });
    return true;
  }

  /**
   * Records that a conversion did not produce a file.
   *
   * THE WORKSPACE STAYS USABLE. A refusal is a decision the user can act on —
   * choose a unit, choose another format, try again — and resetting the
   * session would take the explanation away with it. The chosen target and
   * unit are kept for exactly that reason.
   */
  /**
   * `sizeRefusal`, when given, is the attempt the CALLER judged deterministic —
   * a size ceiling on bytes fixed by revision, target and unit. The store does
   * not judge it: which statuses qualify is export policy, not state.
   */
  public failConversion(
    token: ConversionToken,
    failure: ConversionFailure,
    sizeRefusal?: ConversionAttempt,
  ): boolean {
    if (!this.isCurrentConversion(token)) return false;
    this.currentConversionToken = undefined;
    const attempt = sizeRefusal;
    const refused =
      attempt !== undefined
        ? [
            ...this.state.conversion.refused.filter(
              (existing) =>
                refusedExportFor(
                  [existing],
                  attempt.source,
                  attempt.target,
                  attempt.unitAssertion,
                ) === undefined,
            ),
            {
              documentId: attempt.source.documentId,
              revision: attempt.source.revision,
              target: attempt.target,
              unitAssertion: attempt.unitAssertion,
            },
          ].slice(-MAX_REFUSED_EXPORTS)
        : this.state.conversion.refused;
    this.update({
      conversion: {
        ...this.state.conversion,
        state: ConversionState.Failed,
        fraction: 0,
        phase: undefined,
        failure,
        result: undefined,
        refused,
      },
    });
    return true;
  }

  private update(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Handle equality: same model AND same revision.
 *
 * Comparing only `documentId` would accept a report computed before the model was
 * replaced in place, which is exactly what the revision exists to catch.
 */
function sameHandle(left: DocumentHandle | undefined, right: DocumentHandle | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return left.documentId === right.documentId && left.revision === right.revision;
}
