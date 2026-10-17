/**
 * RESEARCH-ONLY evaluation package.
 *
 * Nothing here is imported by `apps/**` or by any worker, and a test asserts
 * that. It exists so Stage 3A-2 can compile candidate geometry kernels and
 * measure them against identical geometry with identical rules, without any of
 * them entering the production runtime or the shipped bundle.
 */

export {
  ConfidenceClass,
  ForbiddenOutcome,
  LicenceClass,
  RepairOperation,
  RepairStatus,
  SelfIntersectionCapability,
  ThreadingMode,
  summariseReport,
} from './contract';
export type {
  AcceptanceVerdict,
  BakeoffRow,
  CandidateMetadata,
  GeometryChange,
  RepairKernelCandidate,
  RepairOutcome,
  RepairParameters,
  TopologySummaryRow,
} from './contract';

export { CORPUS, FixtureScale, fixtureById } from './corpus';
export type { AcceptanceCriteria, ExpectedDiagnosis, RepairFixture } from './corpus';

export {
  checkExpectation,
  confidenceOf,
  diagnose,
  digestOf,
  judge,
  measureChange,
  runCase,
} from './harness';
export type { HarnessOptions } from './harness';

export {
  DEFAULT_SURFACE_DISTANCE_OPTIONS,
  symmetricSampledSurfaceDistance,
} from './surface-distance';
export type {
  DirectionalSurfaceDistance,
  SurfaceDistanceOptions,
  SymmetricSampledSurfaceDistanceResult,
} from './surface-distance';

export {
  bruteForceNearestDistanceSquared,
  buildTriangleBvh,
  flattenTriangles,
  nearestTriangleDistanceSquared,
  pointTriangleDistanceSquared,
} from './bvh';
export type { TriangleBvh } from './bvh';

export { fromTransfer, toTransfer } from './transfer';
export type { TransferMesh } from './transfer';

export { HARD_GATES, KernelRole, SCORING_MODEL, TOTAL_WEIGHT } from './scoring';
export { toJson, toMarkdown } from './report';
export type { BakeoffRun } from './report';
export type { HardGate, ScoringDimension } from './scoring';

export {
  box,
  boxMissingOneFace,
  crackedPatch,
  gridPatch,
  openTube,
  reverseAll,
  scalePoints,
  soup,
  tetrahedron,
  translate,
} from './geometry';
export type { Point, Triangle } from './geometry';

// Offline semantic qualification. These contracts MUST remain unreachable from production.
export {
  buildGridSource,
  buildSemanticFixture,
  validateSemanticFixture,
  freezeSemanticFixture,
  auditFixtureTopology,
  faceComponents,
  meshDigest,
} from './semantic-fixture';
export type {
  SemanticFixture,
  FixtureEvidence,
  RoleTruth,
  FamilyTruth,
  NamingTruth,
  PlaneTruth,
  PlaneEvidence,
  ConnectorEvidence,
} from './semantic-fixture';
export {
  scoreAllOutputs,
  assertFixtureDispatchable,
  selectedPlaneFaces,
  nameMatches,
} from './semantic-all-output';
export type {
  FinalOutput,
  RealizationInput,
  SemanticRecord,
  NativeProof,
} from './semantic-all-output';
