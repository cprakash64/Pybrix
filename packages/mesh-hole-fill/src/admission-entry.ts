/**
 * `@cadfixer/mesh-hole-fill/admission` — REPAIR-CORE-02.
 *
 * THE ONLY PART OF THIS PACKAGE THE AUTHORITATIVE GEOMETRY WORKER MAY IMPORT.
 * Everything reachable from here is pure and bounded by the loop: planarity,
 * deterministic ear clipping, the admission rules and the local-region builder.
 * The engine entry (`runHoleFill`), the BVH and anything that drives the exact
 * narrowphase are NOT reachable from here — they stay in the disposable worker,
 * where cancellation is termination. A production boundary test holds both
 * halves of that.
 */
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
export {
  appendPatches,
  FillRegression,
  judgeFilledCandidate,
  sourcePreserved,
} from './fill-candidate';

/*
 * REPAIR-CORE-06A. What the planner needs from the local repair WITHOUT any engine: the read-only
 * fan topology and the deterministic work-budget constants. The search, the exact gate and the
 * residual phase are not reachable from here; they run in the disposable kernel worker.
 */
export { buildFanTopology, classifyPinch, planLocalRepair, PinchClass } from './pinch-topology';
export type { FanTopology, LocalRepairPlanFacts, PinchedVertex } from './pinch-topology';
export {
  createWorkMeter,
  REPAIR_WORK_UNITS,
  RepairWorkPhase,
  WINDING_FACES_PER_UNIT,
} from './repair-work-budget';
export type { RepairWorkCounters, RepairWorkMeter } from './repair-work-budget';
export { PRODUCTION_REPAIR_WORK_LIMITS } from './repair-work-limits';
