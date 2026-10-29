import type { SemanticExecutionEligibility } from './semantic-execution-eligibility';
import type { Vec3 } from '@cadfixer/auto-split-contract';
import type { BoundaryAmbiguity, BoundaryConfirmation } from './semantic-boundary-confirmation';

/**
 * WHAT AUTO SPLIT HANDS THE PAGE: editable SUGGESTIONS, never operations.
 *
 * A suggestion names a part, says what kind of change would separate it and how much the evidence
 * supports it, and carries just enough geometry to draw and to start editing: a plane in the part's
 * own coordinates, or the ranks of the components that would be taken out. It carries no confidence
 * number (the page must not show one) and nothing here can be applied; applying is the user's click
 * on a previewed candidate.
 */
export const SuggestionStatus = {
  /** The evidence is strong; the user still previews and applies. */
  Suggested: 'SUGGESTED',
  /** A starting point that needs a person's eyes: the cut or the selection may be wrong. */
  NeedsAdjustment: 'NEEDS_ADJUSTMENT',
  /** The part was found but no safe split can be prepared for it. */
  Unavailable: 'UNAVAILABLE',
  NeedsBoundaryConfirmation: 'NEEDS_BOUNDARY_CONFIRMATION',
} as const;
export type SuggestionStatus = (typeof SuggestionStatus)[keyof typeof SuggestionStatus];

export const SuggestionOperation = {
  /** One flat cut. */
  Plane: 'PLANE',
  /** Take out components that are already separate. */
  Component: 'COMPONENT',
  /** Nothing to do. */
  None: 'NONE',
} as const;
export type SuggestionOperation = (typeof SuggestionOperation)[keyof typeof SuggestionOperation];

/** Why a suggestion has the status it has. The page writes the sentence; this is only the cause. */
export const SuggestionReason = {
  /** Strong evidence. */
  Clear: 'CLEAR',
  /** An arm, or a head the model was unsure of: the cut is a start. */
  ReviewCut: 'REVIEW_CUT',
  /** Several components could be this part: check the selection. */
  ReviewSelection: 'REVIEW_SELECTION',
  /** A cab/bed cut, offered as a beta. */
  BetaCut: 'BETA_CUT',
  /** The proposed cut does not isolate the part (it cuts off too much, too little, or the wrong side). */
  CutDoesNotIsolate: 'CUT_DOES_NOT_ISOLATE',
  /** The part is built into a bigger component (a wheel fused into the body). */
  FusedIntoBody: 'FUSED_INTO_BODY',
  /** The matching component is the whole model: nothing would be left. */
  WholeModel: 'WHOLE_MODEL',
  /** The model gave no usable location for this part. */
  NotLocated: 'NOT_LOCATED',
} as const;
export type SuggestionReason = (typeof SuggestionReason)[keyof typeof SuggestionReason];

export type SuggestionFamily =
  'head' | 'arm' | 'wheel' | 'cab' | 'cargo' | 'body' | 'cab_bed' | 'semantic';

/** A flat cut in the part's own coordinates. The normal points INTO the part: Piece A is the part. */
export interface SuggestedPlane {
  readonly origin: Vec3;
  readonly normal: Vec3;
}

export interface Suggestion {
  /** Original semantic execution permission; native success cannot upgrade it. */
  readonly semanticExecutionEligibility?: SemanticExecutionEligibility;
  /** Stable for one analysis: `head`, `left_arm`, `wheel:wheel_1`, `cab`, `cab_bed`... */
  readonly id: string;
  readonly family: SuggestionFamily;
  /** The name to show, for example `Left arm` or `Front-left wheel`. */
  readonly label: string;
  readonly operation: SuggestionOperation;
  readonly status: SuggestionStatus;
  readonly reason: SuggestionReason;
  readonly plane: SuggestedPlane | null;
  /** The suggested components, by rank (largest surface first). Empty unless the operation is COMPONENT. */
  readonly components: readonly number[];
  readonly parentId?: string | null;
  readonly importance?: 'major' | 'detail';
  readonly semanticConfidence?: number;
  readonly geometryConfidence?: number;
  readonly quality?:
    | 'SUGGESTED'
    | 'READY'
    | 'RECOGNIZED_NOT_SEPARABLE'
    | 'UNSAFE'
    | 'LOW_CONFIDENCE'
    | 'STALE'
    | 'NEEDS_BOUNDARY_CONFIRMATION'
    | 'NEEDS_SCOPE_CONFIRMATION';
  /** Worker-only pending evidence; never an executable or native-qualified claim. */
  readonly boundaryAmbiguity?: BoundaryAmbiguity;
  readonly boundaryConfirmation?: BoundaryConfirmation;
  /** Presentation diagnosis only; never grants an operation or changes validation. */
  readonly diagnostic?: 'CONFIRMED_FUSED' | 'MAPPING_UNCERTAIN' | 'NO_REALIZATION_PROPOSAL';
  /** Semantically admitted alternatives, never native-validity claims. At most three. */
  readonly semanticFinalists?: readonly SuggestedPlane[];
  /** Two identities for one physical partition and one shared native finalist pool. */
  readonly sharedBoundary?: {
    readonly key: string;
    readonly primaryId: string;
    readonly complementId: string;
    readonly side: 'PRIMARY' | 'COMPLEMENT';
  };
  /** Trusted projection of the existing IDENTIFIED certificate, not a new certificate. */
  readonly semanticScopeAuthority?: {
    readonly state: 'STRUCTURAL_IDENTIFIED';
    readonly plane: SuggestedPlane;
  };
  readonly semanticPreparationId?: number;
  readonly instanceCount?: number;
}

/** A component the user could add to or remove from a selection. */
export interface ComponentSummary {
  readonly rank: number;
  /** Share of the part's surface, 0 to 1. */
  readonly areaShare: number;
  readonly faces: number;
}

export interface SuggestionResult {
  readonly suggestions: readonly Suggestion[];
  /** Vehicles only: the largest components, for correcting a selection. Bounded. */
  readonly components: readonly ComponentSummary[];
  readonly componentCount: number;
  readonly faceCount: number;
}

/** The most components offered in a selection list. */
export const MAX_SELECTABLE_COMPONENTS = 24;
