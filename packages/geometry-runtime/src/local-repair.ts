import type {
  LocalRepairKind as EngineLocalRepairKind,
  RepairWorkPhase as EngineRepairWorkPhase,
} from '@cadfixer/mesh-hole-fill';

/**
 * LOCAL PINCH REPAIR OVER THE WIRE — REPAIR-CORE-06A.
 *
 * What the page may learn about the local repair — the primary pinch search and the bounded
 * residual phase — and nothing else: counts, typed outcomes and work figures. The page holds no
 * geometry, so none of this describes a face by position; it states how many, what kind and what
 * stopped it.
 *
 * RESTATED, NOT RE-EXPORTED, for the reason `repair.ts` gives: a value import from the engine
 * would make it a runtime dependency of the main-thread bundle. Both directions are checked at
 * compile time below, so a case the engine can produce and this file lacks fails `tsc`.
 */

/** How a local repair ended. Never collapsed into a boolean. */
export const LocalRepairOutcomeKind = {
  /** Every supported hard topology defect that was detected is repaired. */
  Complete: 'complete',
  /** Some defect class cannot safely be repaired. */
  PartialUnsupported: 'partial_unsupported',
  /** The automatic repair work budget was exhausted. A typed stop, not a failure. */
  PartialLimit: 'partial_limit',
  /** Repairing what remains would require guessing geometric intent. */
  PartialAmbiguous: 'partial_ambiguous',
  /** No safe supported repair exists, so there is nothing to apply. */
  NoChange: 'no_change',
} as const;
export type LocalRepairOutcomeKind =
  (typeof LocalRepairOutcomeKind)[keyof typeof LocalRepairOutcomeKind];

/** Which deterministic work budget a limit refers to. */
export const LocalRepairWorkPhase = {
  Primary: 'primary',
  Residual: 'residual',
} as const;
export type LocalRepairWorkPhase = (typeof LocalRepairWorkPhase)[keyof typeof LocalRepairWorkPhase];

/** Why the local repair did not run at all, when it did not. */
export const LocalRepairNotRun = {
  /** The caller did not ask for it. */
  NotRequested: 'not_requested',
  /** No exact-gate channel was supplied: nothing can be verified, so nothing is repaired. */
  NoVerifier: 'no_verifier',
  /** The conservative stage was rejected, so there is no sound mesh to repair further. */
  ConservativeRejected: 'conservative_rejected',
  /** The part is above the face ceiling the local repair accepts. */
  TooLarge: 'too_large',
} as const;
export type LocalRepairNotRun = (typeof LocalRepairNotRun)[keyof typeof LocalRepairNotRun];

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _kindMatches: Exactly<LocalRepairOutcomeKind, EngineLocalRepairKind> = true;
const _phaseMatches: Exactly<LocalRepairWorkPhase, EngineRepairWorkPhase> = true;
export const LOCAL_REPAIR_CONTRACT_CHECKED = [_kindMatches, _phaseMatches] as const;

/** Faces of each kind a local repair's change delta carries to the page. Counts are never capped. */
export const LOCAL_CHANGE_FACE_LIMIT = 2_048;

/**
 * WHAT A LOCAL REPAIR CHANGED, for the preview's overlay — REPAIR-CORE-06B.
 *
 * Derived from the exact S -> C patch the candidate was BUILT from, never from operation labels,
 * and bounded: the page receives at most `sampleLimit` faces of each kind, chosen by a
 * deterministic stride across the whole change so a sampled overlay is spread over every
 * affected area rather than clustered at the start. The exact totals are separate and never
 * sampled; `truncated` says whether the three arrays are complete.
 *
 * Removed and reversed faces are SOURCE face indices, so they index the render snapshot the page
 * already holds. Added faces are carried as positions (nine floats a face), because they exist
 * only in the candidate.
 */
export interface LocalRepairChange {
  readonly removedSourceFaces: Uint32Array;
  readonly reversedSourceFaces: Uint32Array;
  readonly addedPositions: Float32Array;
  readonly removedCount: number;
  readonly reversedCount: number;
  readonly addedCount: number;
  readonly truncated: boolean;
  readonly sampleLimit: number;
}

/** Rows of a reason table that cross the wire. The counts are never capped. */
export const LOCAL_REPAIR_REASON_LIMIT = 16;

export interface LocalRepairWorkFigure {
  /** Deterministic work units used. Same geometry and product version, same number. */
  readonly used: number;
  /** The ceiling, or undefined when the run was unmetered (qualification only). */
  readonly limit: number | undefined;
}

/**
 * What local repair WOULD attempt at this revision, decided from topology alone.
 *
 * `estimatedWorkLowerBound` and `limitLikely` are ADVISORY and say so: the authoritative limit is
 * the meter that runs during the repair, and a plan never promises that a repair will finish.
 */
export interface LocalRepairPlan {
  readonly requested: boolean;
  /** Vertices where more than one fan of faces meets. */
  readonly pinchedVertices: number;
  /** Of those, the ones the repair can attempt. */
  readonly eligible: number;
  /** Pinched vertices a non-manifold edge makes unseparable by movement. Never attempted. */
  readonly unsupportedNonManifoldEdge: number;
  readonly byClass: Readonly<Record<string, number>>;
  readonly workLimit: {
    readonly primary: number | undefined;
    readonly residual: number | undefined;
  };
  /** A floor on the work the eligible vertices will cost; the real figure is at least this. */
  readonly estimatedWorkLowerBound: number;
  /** True when the floor alone already reaches the primary limit: the repair will stop early. */
  readonly limitLikely: boolean;
  /** Binds a candidate request to what the user saw. */
  readonly planHash: string;
}

/** What a candidate's local repair actually did. */
export interface LocalRepairOutcome {
  readonly kind: LocalRepairOutcomeKind;
  readonly eligible: number;
  readonly unsupportedNonManifoldEdge: number;
  readonly repaired: number;
  readonly remaining: number;
  /** Remaining vertices never attempted because a limit stopped the repair first. */
  readonly unattempted: number;
  /** Why the remaining refused vertices were refused, by the engine's reason. */
  readonly remainingByReason: readonly { readonly reason: string; readonly count: number }[];
  /** Which budget stopped the repair, when one did. */
  readonly limitReached: LocalRepairWorkPhase | undefined;
  readonly work: {
    readonly primary: LocalRepairWorkFigure;
    readonly residual: LocalRepairWorkFigure;
  };
  readonly residual: {
    readonly ran: boolean;
    readonly skippedBecause: 'nothing-refused' | 'primary-limit' | 'cancelled' | undefined;
    readonly linkRetriangulations: number;
    readonly repairedAfterResidual: number;
    readonly windingComponentsResolved: number;
    readonly windingFacesReversed: number;
  };
  /** What the candidate changed, in faces of the mesh the local repair received. */
  readonly facesRemoved: number;
  readonly facesAppended: number;
  readonly facesReversed: number;
  /** True when the engine's own refusal list was longer than the table above. */
  readonly reasonsTruncated: boolean;
}
