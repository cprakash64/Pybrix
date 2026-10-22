import type { StructuralOwnershipCardinality } from './semantic-structural-ownership';
import type { PeerlessScopeEvidence } from './semantic-peerless-scope';
import type { Vec3 } from '@cadfixer/auto-split-contract';

export const PLANE_NORMAL_SOURCES = [
  'CANONICAL_AXES_AND_DIAGONALS',
  'TARGET_PCA',
  'MODEL_PCA',
  'PEER_DIRECTION',
  'PROVIDER_HINT',
  'SOURCE_SECTION_FRAME',
] as const;
export type PlaneNormalSource = (typeof PLANE_NORMAL_SOURCES)[number];
export type PlaneOffsetSource =
  | 'TARGET_MIN'
  | 'TARGET_MAX'
  | 'TARGET_QUANTILE'
  | 'TARGET_FRONTIER_BRACKET'
  | 'VISIBLE_SECTION_TRANSITION'
  | 'PEER_INTERVAL'
  | 'PROVIDER_HINT'
  | 'SEMANTIC_TRANSITION';
export interface PlaneCandidateProvenance {
  readonly normalSources: readonly PlaneNormalSource[];
  readonly offsetSource: PlaneOffsetSource;
  readonly refined: boolean;
}
/** Compact diagnostics only: <=32 normal rows, six view rows and scalar counters.
 * No raster, source faces, per-offset scores or mesh buffers are retained here. */
export interface PlaneSynthesisTrace {
  ownershipCardinality?: StructuralOwnershipCardinality;
  interfaceOwnership?: {
    readonly ownership: string;
    readonly targetPixels: number;
    readonly bodyPixels: number;
    readonly unknownPixels: number;
    readonly positiveFrontierProof: boolean;
    readonly localSupport?: {
      readonly viewPixels: readonly number[];
      readonly observedAxes: readonly number[];
      readonly frontier: number | null;
      readonly interfaceLow: number;
      readonly uncertainty: number;
      readonly interfaceFaces: number;
    };
    readonly sourceFaceVisits: number;
    clippedOperations: number;
    ownershipComparisons: number;
    readonly scratchBytes: number;
  };
  phase:
    | 'INPUT_REFUSED'
    | 'TARGET_SAMPLES_REFUSED'
    | 'EXACT_COMPONENT_WITNESS'
    | 'NO_ELIGIBLE_CANDIDATE'
    | 'NO_CONFIRMED_FINALIST'
    | 'PROPOSAL';
  inputRefusal:
    | 'NOT_MAJOR'
    | 'MULTIPLE_INSTANCES'
    | 'SURFACE_ONLY'
    | 'INSUFFICIENT_VIEWS'
    | 'SEMANTIC_CONFIDENCE'
    | null;
  foregroundSamples: number;
  targetSamples: number;
  exactTarget: boolean;
  views: { view: number; foreground: number; target: number }[];
  normalCandidates: { normal: Vec3; sources: PlaneNormalSource[] }[];
  normalAttempts: number;
  normalRefusals: { degenerate: number; parallel: number; cap: number };
  offsetCandidates: number;
  offsetSources: Record<PlaneOffsetSource, number>;
  orientedOffsets: number;
  scoreRefusals: { balance: number; views: number; viewRecall: number; meanRecall: number };
  scoredCandidates: number;
  ownershipEligible: number;
  beam: number;
  confirmed: number;
  seamDerivedCandidates: number;
  peerless?: {
    phase?:
      | 'COLLECT_SCOPE'
      | 'BUILD_FRONTIER'
      | 'STRUCTURAL_RANKING'
      | 'REFINEMENT'
      | 'CONFIRMATION'
      | 'COMPLETE';
    scratchBytes?: number;
    probeProjectionVisits?: number;
    targetEnvelope?: readonly { normal: Vec3; low: number; high: number }[];
    finalists?: {
      rank: number;
      normal: Vec3;
      proposedOffset: number;
      refinedOffset: number | null;
      structuralReason: string;
      structurallyAdmitted: boolean;
      scopeState?: string;
      confirmed: boolean;
    }[];
    scopeMilliseconds: number;
    structuralMilliseconds: number;
    refinementMilliseconds: number;
    supported: number;
    ambiguous: number;
    overbroad: number;
    refinements: number;
    triangleVisits: number;
    probeTriangleVisits?: number;
    frontier: {
      normal: Vec3;
      offset: number;
      scope: PeerlessScopeEvidence;
      structuralHint: number;
      localization?: number;
      offsetSource?: PlaneOffsetSource;
    }[];
  };
}
export const planeSynthesisTrace = (): PlaneSynthesisTrace => ({
  phase: 'INPUT_REFUSED',
  inputRefusal: null,
  foregroundSamples: 0,
  targetSamples: 0,
  exactTarget: false,
  views: [],
  normalCandidates: [],
  normalAttempts: 0,
  normalRefusals: { degenerate: 0, parallel: 0, cap: 0 },
  offsetCandidates: 0,
  offsetSources: {
    TARGET_MIN: 0,
    TARGET_MAX: 0,
    TARGET_QUANTILE: 0,
    TARGET_FRONTIER_BRACKET: 0,
    VISIBLE_SECTION_TRANSITION: 0,
    PEER_INTERVAL: 0,
    PROVIDER_HINT: 0,
    SEMANTIC_TRANSITION: 0,
  },
  orientedOffsets: 0,
  scoreRefusals: { balance: 0, views: 0, viewRecall: 0, meanRecall: 0 },
  scoredCandidates: 0,
  ownershipEligible: 0,
  beam: 0,
  confirmed: 0,
  seamDerivedCandidates: 0,
});
