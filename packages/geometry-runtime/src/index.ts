export { isClientBoundMessage, isHostBoundMessage, PROTOCOL_CHANNEL } from './protocol';
export type {
  CancelMessage,
  ClientBoundMessage,
  ErrorMessage,
  HostBoundMessage,
  OperationMap,
  OperationName,
  OperationPayload,
  OperationResult,
  ProgressMessage,
  ProtocolMessage,
  ProtocolPort,
  RequestMessage,
  ResultMessage,
  DocumentRenderSnapshot,
  MeshValidationSummary,
  ModelAnalyzePayload,
  ModelAnalyzeResult,
  SendForDiagnosticPayload,
  SendForDiagnosticResult,
  SendForExportPayload,
  SendForExportResult,
  ModelExportPayload,
  ModelImportResult,
  ModelReleasePayload,
  ModelReleaseResult,
  PartDescriptor,
  PartRenderSnapshot,
  RenderSnapshot,
  RepairCandidatePayload,
  RepairCandidateResult,
  RepairCommitPayload,
  RepairCommitResult,
  RepairDiscardPayload,
  RepairDiscardResult,
  RepairPlanOperationResult,
  RepairPlanPayload,
  RepairUndoPayload,
  RepairUndoResult,
  SelfTestPayload,
  SelfTestResult,
  StlExportResult,
  StlImportPayload,
  TransferHandle,
  BoundaryLoopSummary,
  HoleFillDiscardPayload,
  HoleFillDiscardResult,
  HoleFillLimitsPayload,
  ListBoundaryLoopsPayload,
  ListBoundaryLoopsResult,
  SendForFillPayload,
  SendForFillResult,
  BoundaryPreviewPayload,
  BoundaryPreviewResult,
  PatchPreviewPayload,
  PatchPreviewResult,
  HoleFillCommitPayload,
  HoleFillCommitResult,
} from './protocol';

/**
 * Repair contract values, RESTATED rather than re-exported from the engine, so
 * the main-thread bundle never gains a runtime edge to `@cadfixer/mesh-repair`.
 * See `repair.ts` for why, and for the compile-time check that keeps them equal.
 */
export {
  BoundsComparison,
  RepairAcceptance,
  RepairDecision,
  RepairOperation,
  RepairReason,
  RepairRegression,
  REPAIR_PIPELINE_ORDER,
  VolumeComparison,
} from './repair';

/**
 * The repair result SHAPES. Type-only, so the application can name a plan, a
 * validation or a change count without importing the engine that produced it.
 */
export type {
  ConservativeRepairPlan,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairDefectDeltas,
  RepairMemoryEstimate,
  RepairOperationDecision,
  RepairValidation,
} from '@cadfixer/mesh-repair';

/**
 * Re-exported so the application layer can name what `model/analyze` returns
 * without depending on `mesh-topology` directly. The application consumes the
 * report; it must never reach for the engine that produced it.
 */
export type {
  BoundaryComponentSummary,
  ComponentSummary,
  TopologyDetail,
  TopologyReport,
} from '@cadfixer/mesh-topology';
export { BoundaryKind, PrintabilityStatus, SelfIntersectionStatus, VolumeStatus } from './topology';

export {
  checkExportPeak,
  checkImportGeometry,
  DEFAULT_SESSION_MEMORY_BUDGET,
  estimateExportPeak,
  requestAnalysisWorkspace,
  requestRepairPeak,
} from './memory-budget';
export type { MemoryEstimate, SessionMemoryBudget } from './memory-budget';

/**
 * Re-exported so the application can name a bounding box without importing the
 * mesh package. `MeshBounds` is a plain record of numbers — no geometry code
 * travels with a type-only export.
 */
export type { MeshBounds } from '@cadfixer/mesh-core';

/**
 * The canonical document vocabulary, re-exported so the application can name a
 * part or a placement without importing the mesh package directly.
 *
 * TYPE-ONLY. `mesh-core` carries validation and analysis code; a value edge
 * from here would put it in the main-thread bundle to do nothing. The
 * application never constructs canonical geometry — the worker does.
 */
export type { GeometryDocument, GeometryPart, PartId, PartTransform } from '@cadfixer/mesh-core';

export {
  documentByteLength,
  isDocument,
  isPart,
  ResidentDocumentStore,
} from './resident-documents';
export type { DocumentHandle, DocumentId, ResidentDocumentStats } from './resident-documents';

export type { MessageEndpoint } from './endpoint';

export { GeometryCoordinator } from './coordinator';
export type {
  DiagnosticSink,
  DispatchOptions,
  GeometryCoordinatorOptions,
  OperationHandle,
  ProgressUpdate,
} from './coordinator';

export { GeometryWorkerHost } from './worker-host';
export type { HandlerOutcome, OperationContext, OperationHandler } from './worker-host';

export { createSelfTestHandler } from './self-test';
export type { SelfTestHandlerOptions } from './self-test';

export { createLinkedEndpoints } from './linked-endpoints';

export { toTransferables } from './transferables';

export { CandidateState, RepairCandidateStore } from './repair-candidates';
export type {
  CandidateStats,
  CommitRequest,
  RepairCandidateHandle,
  RepairCandidateId,
} from './repair-candidates';

export { TopologyReportCache } from './topology-cache';

export { RepairHistoryStore, UndoableChangeKind } from './repair-history';
export type {
  RepairHistoryEntry,
  RepairHistoryStats,
  RepairUndoPreparation,
  UndoableInverse,
} from './repair-history';

/**
 * Hole-fill contract values, RESTATED rather than re-exported from the engine,
 * for exactly the reason `repair.ts` gives: a value edge to
 * `@cadfixer/mesh-hole-fill` would drag the triangulator, the broadphase and the
 * topology engine behind them into the main-thread bundle. See `hole-fill.ts`
 * for the compile-time check and `hole-fill-contract.test.ts` for the runtime
 * one.
 */
export {
  BoundaryLoopRefusal,
  HOLE_FILL_CONTRACT_CHECKED,
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  HOLE_FILL_MAX_PART_FACES,
  HoleFillStatus,
} from './hole-fill';
export type { HoleFillLimits, HoleFillValidationSummary } from './hole-fill';

export { HoleFillCandidateState, HoleFillCandidateStore } from './hole-fill-candidates';
export type {
  HoleFillCandidateHandle,
  HoleFillCandidateId,
  HoleFillCandidateStats,
  HoleFillCommitRequest,
} from './hole-fill-candidates';

export {
  GeometryEditStore,
  validateGeometryEdit,
  DEFAULT_GEOMETRY_EDIT_LIMITS,
} from './geometry-edit';
export type {
  GeometryEditTicket,
  GeometryEditCandidateHandle,
  GeometryEditResourceAccounting,
  GeometryEditCandidateSummary,
  GeometryEditCommitResult,
  GeometryEditLimits,
} from './geometry-edit';
export {
  booleanUnion,
  booleanDifference,
  booleanIntersection,
  runValidatedBoolean,
} from './boolean-adapter';
export type { BooleanBackend, BooleanKind, BooleanResult } from './boolean-adapter';
export {
  buildSplitCutters,
  identifyCutSurface,
  meshVolume,
  roundSocketRadius,
  dovetailFemaleDimensions,
  splitTolerance,
  splitWithConnectors,
} from './split-connectors';
export { SplitCandidateStore } from './split-candidates';
export type { SplitCandidateHandle, SplitCandidateSummary } from './split-candidates';
export type {
  CutSurfaceSummary,
  SplitConnector,
  SplitMetrics,
  SplitPlane,
  SplitRequest,
  SplitResult,
  SplitVector,
} from './split-connectors';
export {
  buildSurfaceTextureLayout,
  buildSurfaceTextureOperand,
  describeTextureLayout,
  meshSurfaceArea,
  textureSurface,
  MAX_TEXTURE_ELEMENTS,
  MAX_TEXTURE_PRIMITIVE_TRIANGLES,
} from './surface-texture';
export type {
  SurfaceTextureLayout,
  SurfaceTextureRequest,
  SurfaceTextureResult,
  TextureLayoutSummary,
  TextureMode,
  TexturePattern,
  TexturePatternInstance,
} from './surface-texture';

export type {
  EditPreviewPayload,
  EditPreviewResult,
  EditCommitPayload,
  EditCommitResult,
  EditDiscardPayload,
  EditDiscardResult,
  SplitCreatePayload,
  SplitCreateResult,
  SplitCommitPayload,
  SplitCommitResult,
  SplitDiscardPayload,
  SplitDiscardResult,
  TextureCreatePayload,
  TextureCreateResult,
  TextureSelectPayload,
  TextureLayoutResult,
  TextureSelectResult,
} from './protocol';

export {
  BOUNDARY_FILL_LOOP_LIST_LIMIT,
  BOUNDARY_FILL_MAX_OPENINGS_PER_REPAIR,
  BoundaryFillOutcomeStatus,
  BoundaryFillScanStatus,
  BoundaryFillVerdict,
  fillableOpeningCount,
  NO_BOUNDARY_FILL_PLAN,
} from './boundary-fill';
export type {
  BoundaryFillLoopSummary,
  BoundaryFillOutcome,
  BoundaryFillPlan,
} from './boundary-fill';

export {
  LOCAL_REPAIR_CONTRACT_CHECKED,
  LOCAL_REPAIR_REASON_LIMIT,
  LocalRepairNotRun,
  LocalRepairOutcomeKind,
  LocalRepairWorkPhase,
} from './local-repair';
export type { LocalRepairOutcome, LocalRepairPlan, LocalRepairWorkFigure } from './local-repair';
