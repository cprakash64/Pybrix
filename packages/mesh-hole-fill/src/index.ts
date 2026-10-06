/**
 * THE CONSERVATIVE PLANAR HOLE-FILL ENGINE.
 *
 * Deliberately KERNEL-FREE. This package holds the policy, the ceilings, the
 * frozen status taxonomy, the deterministic triangulator, the bounded
 * broadphase and every independent validator. The exact triangle/triangle
 * narrowphase is INJECTED — it is the Geogram WASM kernel, and it stays
 * confined to the disposable worker that loads it, which the production
 * boundary scan asserts.
 *
 * SCOPE, stated once so it cannot drift: ONE selected boundary loop per
 * operation, which must be a topologically simple manifold cycle under exact
 * stored-coordinate identity and must be proven planar by the relative policy.
 * No non-planar filling. No batch filling. No tolerance welding, seam snapping,
 * fairing, smoothing or surrounding remeshing. See
 * `docs/adr/0018-hole-filling-qualification.md`.
 */

export { runHoleFill } from './engine';
export type { HoleFillEngineInput, HoleFillEngineResult } from './engine';

export { HoleFillStatus, isRefusal, isValidCandidate } from './status';

export {
  DEFAULT_HOLE_FILL_LIMITS,
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  HOLE_FILL_MAX_PART_FACES,
  HOLE_FILL_MAX_PATCH_FACES,
  MAX_AABB_TESTS,
  MAX_BROADPHASE_CANDIDATES,
  MAX_BVH_NODE_VISITS,
  MAX_NARROWPHASE_PAIRS,
  MAX_SAMPLES,
  narrowHoleFillLimits,
  patchFaceCountFor,
} from './limits';
export type { HoleFillLimits } from './limits';

export { assessPlanarity, newellNormal, RELATIVE_PLANARITY } from './planarity';
export type { LoopPoint, PlanarityAssessment } from './planarity';

export {
  earClip,
  EarClipRefusal,
  projectedPolygonTwiceArea,
  projectedTwiceArea,
  projectionAxisFor,
  projectPoint,
} from './ear-clip';
export type { EarClipResult, PatchTriangle } from './ear-clip';

export { boxesOverlap, createCounters, faceBoxOf, FaceBvh } from './bvh';
export type { BroadphaseBudget, BroadphaseCounters } from './bvh';

export {
  analysePatchConnectivity,
  analysePatchFaces,
  analysePatchOrientation,
  collectNonManifoldDefects,
  diffNonManifoldDefects,
  eulerCharacteristicOf,
  validateSourcePreservation,
} from './validate';
export type {
  NonManifoldDefects,
  NonManifoldDifference,
  PatchConnectivityReport,
  PatchFaceReport,
  PatchOrientationReport,
  SourcePreservation,
} from './validate';

export type {
  HoleFillOperationIdentity,
  HoleFillOutcome,
  HoleFillPhaseTimings,
  HoleFillRequest,
  HoleFillValidationSummary,
  NarrowphaseBatchResult,
  NarrowphaseGeometry,
  NarrowphaseSamples,
  PatchNarrowphase,
} from './contract';

/* REPAIR-CORE-02: automatic, per-loop boundary filling for Repair model. */
export {
  admitBoundaryLoops,
  BoundaryFillVerdict,
  DEFAULT_BOUNDARY_FILL_LIMITS,
  narrowBoundaryFillLimits,
  triangleArea,
} from './admission';
export type {
  AdmittedLoop,
  BoundaryFillAdmission,
  BoundaryFillLimits,
  LoopDecision,
} from './admission';
export { buildLocalPatchProblem } from './local-region';
export type { LocalPatchProblem, LocalRegionOptions } from './local-region';
export { classifyLocalPatches } from './local-intersection';
export type { LocalLoopVerdict } from './local-intersection';
export {
  appendPatches,
  FillRegression,
  judgeFilledCandidate,
  sourcePreserved,
} from './fill-candidate';

/*
 * LOCAL PINCH REPAIR — REPAIR-CORE-06A. The primary pinch search, the bounded residual phase, the
 * exact gate and the deterministic work budget. Kernel-free: the exact narrowphase is injected by
 * the disposable worker that owns the Geogram instance.
 */
export { LocalRepairKind, runLocalRepair } from './local-repair';
export type {
  LocalRepairCounts,
  LocalRepairInput,
  LocalRepairLimits,
  LocalRepairProgress,
  LocalRepairResidualReport,
  LocalRepairResult,
  WindingResolutionSummary,
  WorkReport,
} from './local-repair';
export { PINCH_SEARCH_DEFAULTS } from './pinch-search';
export { buildFanTopology, classifyPinch, planLocalRepair, PinchClass } from './pinch-topology';
export type {
  FanTopology,
  FanTopologyOptions,
  LocalRepairPlanFacts,
  PinchedVertex,
  VertexFan,
} from './pinch-topology';
export {
  createWorkMeter,
  REPAIR_WORK_UNITS,
  RepairWorkPhase,
  WINDING_FACES_PER_UNIT,
  WorkLimitReached,
} from './repair-work-budget';
export type { RepairWorkCounters, RepairWorkMeter } from './repair-work-budget';
export { createSurgeryGate } from './surgery-gate';
export type { GateStats, SurgeryGate, SurgeryGateOptions } from './surgery-gate';
export { SurgeryMesh } from './surgery-mesh';
export type { SurgeryPatch } from './surgery-mesh';
export { MAX_RETRIANGULATION_EXACT, MAX_RETRIANGULATION_LINK } from './link-retriangulation';
export { DEFAULT_MAX_WINDING_FLIPS } from './winding-resolution';
