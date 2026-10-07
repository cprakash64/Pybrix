import {
  fillableOpeningCount,
  BOUNDARY_FILL_MAX_OPENINGS_PER_REPAIR,
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  BoundaryFillOutcomeStatus,
  BoundaryFillScanStatus,
  BoundaryFillVerdict,
  RepairDecision,
  RepairOperation,
  RepairReason,
  type BoundaryFillOutcome,
  type BoundaryFillPlan,
  type ConservativeRepairPlan,
  type LocalRepairPlan,
  type RepairChangeCounts,
  type RepairOperationDecision,
} from '@cadfixer/geometry-runtime';
import { SELF_INTERSECTION_MAX_FACES } from '@cadfixer/mesh-self-intersection';
import { IssueSeverity, RepairIssueId, type RepairIssue } from './repair-issues';

/**
 * The Repair workspace's action model and its compact wording — REPAIR-UX-01.
 *
 * FRAMEWORK-FREE AND PURE, like every presentation module. Scalars in, a
 * decision and its sentences out, tested without a DOM. The workspace answers
 * three questions by default — what is wrong, what Pybrix can repair, what to
 * click — and every answer is decided here so the footer, the issue rows and
 * the option rows cannot disagree about any of them.
 *
 * NOTHING HERE DECIDES A SAFETY QUESTION. Whether an operation can run is the
 * worker's plan; this module only reads the decision it already made. The
 * primary action is "Repair model" because pressing it runs every SELECTED
 * operation the plan found APPLICABLE and previews the validated result — no
 * more. It never means that every detected issue will go away, and nothing
 * here may say so.
 *
 * THE COPY IS SHORT ON PURPOSE. The long explanations live in `ISSUE_INFO` and
 * the other info texts, which the interface shows only when asked: an ⓘ button
 * or the collapsed Advanced diagnostics. They are still exported and tested,
 * because hiding information is not the same as deleting it.
 */

/**
 * Every term the three older presentation modules forbid, plus the claims a
 * one-button repair screen is specifically tempted to make. Enforced by test
 * against every string this module can produce.
 */
export const REPAIR_WORKSPACE_FORBIDDEN_TERMS: readonly string[] = [
  'hole',
  'printable',
  'watertight',
  'valid mesh',
  'error free',
  'fully repaired',
  'ready to print',
  'all errors fixed',
  'all issues fixed',
  'fix everything',
  'fix all',
  'make printable',
  'model repaired',
  'model fixed',
  'perfect',
  'damaged',
];

/* ------------------------------------------------------- the workspace -- */

export const REPAIR_WORKSPACE_TITLE = 'Repair';

/** The primary action's label. Not "Fix all": see the module comment. */
export const REPAIR_MODEL_ACTION = 'Repair model';
export const ANALYZE_MODEL_ACTION = 'Analyze model';
export const APPLY_REPAIRS_ACTION = 'Apply repairs';
export const CANCEL_PREVIEW_ACTION = 'Discard preview';
export const UNDO_REPAIR_ACTION = 'Undo repair';

/** Beneath the action while it is available. */
export const REPAIR_MODEL_SUPPORT =
  'Repairs every issue Pybrix can safely fix automatically. You review the result before anything changes.';

/** Detected issues remain and nothing selected can change them. */
export const NO_SAFE_REPAIRS = 'No safe automatic repairs are available for the detected issues.';

/** Nothing was detected that an automatic operation acts on. */
export const NO_REPAIRABLE_PROBLEMS = 'No repairable problems found.';

/** State C, stated beside the Apply button. */
export const PREVIEW_READY_LINE = 'Preview ready — nothing has changed until you apply it.';

/*
 * FAILURE HEADLINES — WORKSPACE-UX-03. One line each, for the action region;
 * the full message is an alert in the scrolling content above it. Each says
 * only what is certain: what did not happen.
 */
export const ANALYSIS_FAILED_LINE = 'Analysis did not finish — details above';
export const PLAN_FAILED_LINE = 'No repair plan was made — details above';
export const PREVIEW_FAILED_LINE = 'No preview was made — details above';
export const APPLY_FAILED_LINE = 'The repair was not applied — details above';

/** While a cancel is being acknowledged. */
export const REPAIR_CANCELLING_LINE = 'Cancelling… nothing has been changed.';
export const REPAIR_CANCELLED_LINE = 'Repair was cancelled. Nothing was changed.';
export const ANALYSIS_CANCELLED_LINE = 'Analysis was cancelled. No partial results are shown.';

/**
 * AFTER A PARTIAL REPAIR, the reason Repair model is disabled — REPAIR-UX-04.
 * It answers the question the disabled button raises next to a Health line
 * that still shows an error: why are there still issues, and why would pressing
 * Repair again not help. Not "nothing is wrong": the detail names what remains.
 */
export const REPAIRS_EXHAUSTED_LINE =
  'Everything Pybrix can safely repair automatically has been fixed.';

/** Behind the ⓘ beside `REPAIRS_EXHAUSTED_LINE`. Category counts, never a sum. */
export function describeRepairsExhausted(remaining: readonly string[]): string {
  const still = remaining.length === 0 ? '' : `Still detected: ${joinList(remaining)}. `;
  return `${still}Pybrix has no safe automatic repair for what is left, so repairing again would change nothing. Each row under Detected issues says what can be done about it.`;
}

/* ------------------------------------------------------ fixability ---- */

/**
 * What Pybrix can do about ONE issue type, in the plainest honest words.
 *
 * Not severity: a warning may be repairable and an error may not. Rendered as
 * text beneath the issue's name, never as colour alone.
 */
export const Fixability = {
  /** Every occurrence is targeted by a selected, applicable operation. */
  Repairable: 'repairable',
  /** Some occurrences can be repaired automatically and some cannot. */
  Partial: 'partial',
  /** Nothing automatic acts on it. */
  NotRepairable: 'not-repairable',
  /** Not necessarily a problem at all; the user decides. */
  Review: 'review',
  /** An applicable repair exists but its operation is not selected. */
  NotSelected: 'not-selected',
  /** The check that finds it has not run for this version. */
  CheckNotRun: 'check-not-run',
  /** Automatic handling is withheld because of the part's size. */
  ResourceLimit: 'resource-limit',
  /** The check ran and found none. */
  NoIssue: 'no-issue',
  /** The plan that decides this is still being worked out. */
  Pending: 'pending',
} as const;

export type Fixability = (typeof Fixability)[keyof typeof Fixability];

export interface IssueStatus {
  readonly fixability: Fixability;
  /** One short line under the issue name. */
  readonly text: string;
  /** An optional second fact, such as the simple / complex boundary split. */
  readonly detail?: string;
}

/**
 * Everything `deriveIssueStatus` reads, restated structurally so this module
 * stays free of the store.
 */
export interface IssueStatusContext {
  /**
   * The CURRENT plan for the active part, or `undefined` while it is being
   * computed or when it is missing. A plan from another revision must not be
   * passed: its decisions describe a different mesh.
   */
  readonly plan: ConservativeRepairPlan | undefined;
  /** The topology counts the boundary split comes from. */
  readonly boundaries: {
    readonly simpleLoops: number;
    readonly openChains: number;
    readonly branched: number;
  };
  /** Triangles in the active part. */
  readonly partFaceCount: number;
  /** True when the self-intersection check will not run at this size. */
  readonly selfIntersectionSizeLimited: boolean;
  /** Whether the user has automatic opening fills selected — REPAIR-CORE-02. */
  readonly fillSelected: boolean;
  /** The worker's fill plan for the CURRENT revision, or `undefined` while pending. */
  readonly fill: BoundaryFillPlan | undefined;
  /** The local repair plan for the CURRENT revision — REPAIR-CORE-06B. */
  readonly localRepair?: LocalRepairPlan | undefined;
}

/**
 * The fixability line for one issue row. EXHAUSTIVE over `RepairIssueId`, with
 * no default, so a new row cannot reach the screen without a decision.
 */
export function deriveIssueStatus(issue: RepairIssue, context: IssueStatusContext): IssueStatus {
  if (issue.count === undefined) {
    return {
      fixability: Fixability.CheckNotRun,
      text:
        issue.id === RepairIssueId.SelfIntersections && context.selfIntersectionSizeLimited
          ? 'Not checked — model exceeds automatic check size'
          : 'Not checked',
    };
  }
  if (issue.count === 0 && issue.id !== RepairIssueId.Components) {
    return { fixability: Fixability.NoIssue, text: 'No issue' };
  }

  switch (issue.id) {
    case RepairIssueId.OpenBoundaries: {
      const { simpleLoops, openChains, branched } = context.boundaries;
      const complex = openChains + branched;
      const detail = `${plural(simpleLoops, 'simple loop')} · ${complex.toLocaleString()} complex`;
      return openBoundaryStatus(issue.count, detail, context);
    }
    case RepairIssueId.NonManifoldEdges:
      return { fixability: Fixability.NotRepairable, text: 'Not automatically repairable' };
    case RepairIssueId.NonManifoldVertices: {
      // REPAIR-CORE-06B: pinched vertices are what the local repair attempts. It repairs a vertex
      // only if its exact checks pass, so this says "can attempt", never "will fix".
      const eligible = context.localRepair?.eligible ?? 0;
      if (eligible === 0) {
        return { fixability: Fixability.NotRepairable, text: 'Not automatically repairable' };
      }
      return eligible >= issue.count
        ? { fixability: Fixability.Repairable, text: 'Repair available' }
        : { fixability: Fixability.Partial, text: 'Partly repairable' };
    }
    case RepairIssueId.SelfIntersections:
      return { fixability: Fixability.NotRepairable, text: 'Not automatically repairable' };
    case RepairIssueId.Components:
      return issue.count <= 1
        ? { fixability: Fixability.NoIssue, text: 'One connected piece' }
        : { fixability: Fixability.Review, text: 'Review recommended — may be intentional' };
    case RepairIssueId.WindingConflicts:
      return fromDecisions(context.plan, [RepairOperation.UnifyWinding], false);
    case RepairIssueId.DegenerateFaces:
      return fromDecisions(
        context.plan,
        [RepairOperation.RemoveRepeatedPositionFaces, RepairOperation.RemoveZeroAreaFaces],
        false,
      );
    case RepairIssueId.DuplicateFaces: {
      const reversedOnly =
        context.plan !== undefined &&
        (decisionFor(context.plan, RepairOperation.RemoveDuplicateFaces)?.targetedCount ?? 0) === 0;
      if (reversedOnly) {
        return {
          fixability: Fixability.NotRepairable,
          text: 'Reversed copies are kept — they may be intentional',
        };
      }
      return fromDecisions(context.plan, [RepairOperation.RemoveDuplicateFaces], true);
    }
  }
}

/**
 * REPAIR-CORE-02: open boundaries read the WORKER'S FILL PLAN, never a count.
 * "Fillable" means admitted: simple, flat, triangulable without a new point,
 * adding no existing edge, and within the batch limits. The exact intersection
 * check still runs at preview, so this line never promises a closure.
 */
function openBoundaryStatus(
  count: number,
  detail: string,
  context: IssueStatusContext,
): IssueStatus {
  if (!context.fillSelected) {
    return { fixability: Fixability.NotSelected, text: 'Automatic filling not selected', detail };
  }
  const fill = context.fill;
  if (fill === undefined || fill.status === BoundaryFillScanStatus.NotRequested) {
    return { fixability: Fixability.Pending, text: 'Checking…', detail };
  }
  if (fill.status === BoundaryFillScanStatus.TooManyBoundaryEdges) {
    return {
      fixability: Fixability.ResourceLimit,
      text: 'Too many open edges to check automatically',
      detail,
    };
  }
  // An opening admission passed but the exact check never saw is not fillable
  // and not refused either — REPAIR-RC-03. Say it was not checked.
  if (!fill.verified && fill.admittedCount > 0) {
    return { fixability: Fixability.NotRepairable, text: 'Openings could not be checked', detail };
  }
  const fillable = fillableOpeningCount(fill);
  if (fillable === 0) {
    return { fixability: Fixability.NotRepairable, text: 'Not automatically fillable', detail };
  }
  const rest = Math.max(0, count - fillable);
  return rest === 0
    ? { fixability: Fixability.Repairable, text: plural(fillable, 'fillable opening'), detail }
    : {
        fixability: Fixability.Partial,
        text: `${fillable.toLocaleString()} fillable · ${rest.toLocaleString()} need attention`,
        detail,
      };
}

/**
 * Status from the plan's decisions for the operations that act on one issue.
 *
 * `partialByNature` is for duplicates: reversed copies are counted in the row
 * and never removed, so even an applicable removal repairs only part of it
 * when any reversed copies exist. The caller cannot see that split, so it is
 * stated as "some" only when the source count exceeds what is targeted.
 */
function fromDecisions(
  plan: ConservativeRepairPlan | undefined,
  operations: readonly RepairOperation[],
  partialByNature: boolean,
): IssueStatus {
  if (plan === undefined) return { fixability: Fixability.Pending, text: 'Checking…' };
  const decisions = operations
    .map((operation) => decisionFor(plan, operation))
    .filter((entry): entry is RepairOperationDecision => entry !== undefined)
    // An operation with nothing to target says nothing about this issue.
    .filter((entry) => entry.targetedCount > 0);
  if (decisions.length === 0) {
    return { fixability: Fixability.NotRepairable, text: 'Not automatically repairable' };
  }
  const repairable = decisions.filter(isRepairableDecision);
  const notSelected = decisions.filter((entry) => entry.reason === RepairReason.NotRequested);
  if (repairable.length === decisions.length) {
    return partialByNature
      ? {
          fixability: Fixability.Partial,
          text: 'Exact copies can be removed; reversed copies are kept',
        }
      : { fixability: Fixability.Repairable, text: 'Repair available' };
  }
  if (repairable.length > 0) {
    return { fixability: Fixability.Partial, text: 'Partly repairable' };
  }
  if (notSelected.length > 0) {
    return { fixability: Fixability.NotSelected, text: 'Repair available — option not selected' };
  }
  return { fixability: Fixability.NotRepairable, text: 'Blocked by the model’s topology' };
}

/**
 * True when the plan will act on (or already resolves) this operation's
 * targets. `NOT_NEEDED` with targets and any reason other than "not requested"
 * is the "an earlier operation in this plan resolves it" case — which is a
 * repair, not an absence.
 */
function isRepairableDecision(entry: RepairOperationDecision): boolean {
  if (entry.decision === RepairDecision.Applicable) return true;
  return (
    entry.decision === RepairDecision.NotNeeded &&
    entry.targetedCount > 0 &&
    entry.reason !== RepairReason.NotRequested
  );
}

function decisionFor(
  plan: ConservativeRepairPlan,
  operation: RepairOperation,
): RepairOperationDecision | undefined {
  return plan.decisions.find((entry) => entry.operation === operation);
}

/* ------------------------------------------------------ repair scope -- */

/** Issue types a Repair model press would act on, and how many were detected. */
export interface RepairScope {
  /** Detected issue types (count > 0, excluding a single component). */
  readonly detected: number;
  /** Of those, how many the current plan repairs fully or in part. */
  readonly repairable: number;
  /** Openings the fill plan admitted. Zero when filling is off or none qualify. */
  readonly openings: number;
}

export function deriveRepairScope(
  issues: readonly RepairIssue[],
  statuses: ReadonlyMap<RepairIssueId, IssueStatus>,
  fillableOpenings = 0,
): RepairScope {
  let detected = 0;
  let repairable = 0;
  for (const issue of issues) {
    if (issue.severity !== IssueSeverity.Error && issue.severity !== IssueSeverity.Warning)
      continue;
    detected += 1;
    const status = statuses.get(issue.id);
    if (status === undefined) continue;
    if (status.fixability === Fixability.Repairable || status.fixability === Fixability.Partial) {
      repairable += 1;
    }
  }
  return { detected, repairable, openings: fillableOpenings };
}

/**
 * The supporting line under an enabled Repair model. Counts issue TYPES, names
 * how many openings would be attempted, and never claims more than that.
 */
export function describeRepairScope(scope: RepairScope): string {
  if (scope.detected === 0) return REPAIR_MODEL_SUPPORT;
  const remaining = scope.detected - scope.repairable;
  const openings = scope.openings > 0 ? `${plural(scope.openings, 'opening')} can be filled. ` : '';
  const head =
    scope.openings > 0 && scope.repairable === 1
      ? openings.trimEnd()
      : `${openings}${plural(scope.repairable, 'repairable issue type')} of ${scope.detected.toLocaleString()} detected.`;
  if (remaining === 0) return `${head} You review the result before anything changes.`;
  return scope.openings > 0 && scope.repairable === 1
    ? `${head} Other detected issues will remain.`
    : `${head} ${plural(remaining, 'type')} will need other attention.`;
}

/* --------------------------------------------------- automatic filling -- */

export const FILL_OPTION_LABEL = 'Fill simple openings';

/** The trailing status beside the fill option. */
export function describeFillOptionStatus(
  selected: boolean,
  fill: BoundaryFillPlan | undefined,
): string {
  if (!selected) return 'Not selected';
  if (fill === undefined || fill.status === BoundaryFillScanStatus.NotRequested) return 'Checking…';
  if (fill.status === BoundaryFillScanStatus.TooManyBoundaryEdges) return 'Too many open edges';
  if (!fill.verified && fill.admittedCount > 0) return 'Could not check';
  const fillable = fillableOpeningCount(fill);
  return fillable === 0 ? 'None eligible' : `${fillable.toLocaleString()} to fill`;
}

/** One short reason per verdict, for ⓘ panels and the preview's refused list. */
export function describeFillVerdict(verdict: BoundaryFillVerdict): string {
  switch (verdict) {
    case BoundaryFillVerdict.Admitted:
      return 'Can be filled';
    case BoundaryFillVerdict.Filled:
      return 'Filled and validated';
    case BoundaryFillVerdict.NotSimple:
      return 'Complex boundary — branches or does not close';
    case BoundaryFillVerdict.NonManifoldBoundary:
      return 'Touches non-manifold geometry';
    case BoundaryFillVerdict.AmbiguousOrientation:
      return 'The surrounding triangles disagree about direction';
    case BoundaryFillVerdict.DegenerateBoundary:
      return 'The rim has no usable shape';
    case BoundaryFillVerdict.TooManyVertices:
      return 'Too many rim points';
    case BoundaryFillVerdict.NonPlanar:
      return 'Not flat enough to fill';
    case BoundaryFillVerdict.NoTriangulation:
      return 'Could not be triangulated without adding points';
    case BoundaryFillVerdict.DegeneratePatch:
      return 'The fill would contain a zero-area triangle';
    case BoundaryFillVerdict.EdgeAlreadyExists:
      return 'The fill would reuse an existing edge';
    case BoundaryFillVerdict.DuplicatesExistingFace:
      return 'The fill would duplicate an existing triangle';
    case BoundaryFillVerdict.InteractsWithAnotherOpening:
      return 'Close to another opening — left for a later repair';
    case BoundaryFillVerdict.BatchLimit:
      return 'Over this repair’s limit — left for a later repair';
    case BoundaryFillVerdict.AmbiguousIdentity:
      return 'Could not be identified uniquely';
    case BoundaryFillVerdict.WouldIntersect:
      return 'The fill would pass through existing geometry';
    case BoundaryFillVerdict.NotVerifiable:
      return 'Could not be checked completely';
    case BoundaryFillVerdict.RegionTooLarge:
      return 'Too much surrounding geometry to check';
  }
}

/** Counts of a list of loop verdicts, most frequent first. */
export function summariseFillVerdicts(
  loops: readonly { readonly verdict: BoundaryFillVerdict }[],
  exclude: readonly BoundaryFillVerdict[] = [],
): readonly { readonly verdict: BoundaryFillVerdict; readonly count: number }[] {
  const counts = new Map<BoundaryFillVerdict, number>();
  for (const loop of loops) {
    if (exclude.includes(loop.verdict)) continue;
    counts.set(loop.verdict, (counts.get(loop.verdict) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([verdict, count]) => ({ verdict, count }))
    .sort((a, b) => b.count - a.count || (a.verdict < b.verdict ? -1 : 1));
}

/**
 * Why a Repair model press produced nothing to preview, when the only planned
 * work was filling and every opening was refused at the exact check.
 */
export function describeFillFailure(outcome: BoundaryFillOutcome | undefined): string | undefined {
  if (outcome === undefined) return undefined;
  switch (outcome.status) {
    case BoundaryFillOutcomeStatus.None:
    case BoundaryFillOutcomeStatus.Filled:
      return undefined;
    case BoundaryFillOutcomeStatus.NothingPassed: {
      const reasons = summariseFillVerdicts(outcome.loops, [
        BoundaryFillVerdict.Admitted,
        BoundaryFillVerdict.Filled,
      ]).filter(
        (entry) =>
          entry.verdict === BoundaryFillVerdict.WouldIntersect ||
          entry.verdict === BoundaryFillVerdict.NotVerifiable ||
          entry.verdict === BoundaryFillVerdict.RegionTooLarge,
      );
      const first = reasons[0];
      return first === undefined
        ? 'No opening passed the final check. Your model is unchanged.'
        : `No opening passed the final check: ${describeFillVerdict(first.verdict).toLowerCase()}. Your model is unchanged.`;
    }
    case BoundaryFillOutcomeStatus.Rejected:
      return 'The filled result did not match what was predicted, so nothing was filled. Your model is unchanged.';
  }
}

/* ------------------------------------------------------ action states -- */

/**
 * The footer's state. One primary control lives in one place in every state,
 * so a user always knows where the next step is.
 */
export const RepairActionKind = {
  NoModel: 'no-model',
  /** The deployment cannot stop a repair, so none is offered. */
  Unavailable: 'unavailable',
  /** State A. */
  Analyze: 'analyze',
  Analyzing: 'analyzing',
  /** A report exists; the plan is being derived. Repair model is disabled. */
  Planning: 'planning',
  PlanFailed: 'plan-failed',
  /** State B. */
  Ready: 'ready',
  /** State E, with detected issues. */
  NothingSafe: 'nothing-safe',
  /** State E, with nothing detected an operation acts on. */
  NothingFound: 'nothing-found',
  Building: 'building',
  /** State C. */
  Preview: 'preview',
  Applying: 'applying',
  Undoing: 'undoing',
} as const;

export type RepairActionKind = (typeof RepairActionKind)[keyof typeof RepairActionKind];

export interface RepairActionInput {
  readonly hasModel: boolean;
  readonly isolationSupported: boolean;
  /** A topology report exists for the CURRENT revision and active part. */
  readonly reportIsCurrent: boolean;
  readonly isAnalyzing: boolean;
  readonly planState: 'unavailable' | 'planning' | 'ready' | 'failed';
  /** `plan.noOp` for the current plan; `undefined` when there is none. */
  readonly planNoOp: boolean | undefined;
  /** Openings the current fill plan admitted, when filling is selected. */
  readonly fillableOpenings: number;
  /** Pinched vertices the local repair can attempt — REPAIR-CORE-06B. Zero when none. */
  readonly localEligible?: number;
  readonly candidateState: 'idle' | 'building' | 'cancelling' | 'ready' | 'failed' | 'cancelled';
  readonly commitState: 'idle' | 'applying' | 'undoing';
  /** Detected issue types (errors and warnings). */
  readonly detectedIssueTypes: number;
}

/**
 * THE CTA STATE MACHINE. Order matters: work in flight outranks everything,
 * a preview outranks planning, and a missing report outranks the plan.
 */
export function deriveRepairAction(input: RepairActionInput): RepairActionKind {
  if (!input.hasModel) return RepairActionKind.NoModel;
  if (!input.isolationSupported) return RepairActionKind.Unavailable;
  if (input.commitState === 'applying') return RepairActionKind.Applying;
  if (input.commitState === 'undoing') return RepairActionKind.Undoing;
  if (input.candidateState === 'building' || input.candidateState === 'cancelling') {
    return RepairActionKind.Building;
  }
  if (input.candidateState === 'ready') return RepairActionKind.Preview;
  if (input.isAnalyzing) return RepairActionKind.Analyzing;
  if (!input.reportIsCurrent) return RepairActionKind.Analyze;
  if (input.planState === 'failed') return RepairActionKind.PlanFailed;
  if (input.planState !== 'ready' || input.planNoOp === undefined) return RepairActionKind.Planning;
  // A plan with no conservative work is still work when openings qualify.
  if (!input.planNoOp || input.fillableOpenings > 0 || (input.localEligible ?? 0) > 0) {
    return RepairActionKind.Ready;
  }
  return input.detectedIssueTypes > 0
    ? RepairActionKind.NothingSafe
    : RepairActionKind.NothingFound;
}

/* ---------------------------------------------------- repair outcome -- */

/**
 * WHAT THE LAST REPAIR ACCOMPLISHED — REPAIR-UX-04.
 *
 * A SUCCESSFUL REPAIR OPERATION AND A HEALTHY MODEL ARE DISTINCT STATES. The
 * outcome reports the OPERATION: what it changed, and whether detected issues
 * remain afterwards. Health reports the MODEL, from the analysis of the
 * revision on screen, and is never recoloured because a repair ran. v0.6.0
 * headed every applied repair "Conservative repair applied" in green, beside a
 * Health line still reading "1 error · 2 warnings"; a reasonable person read
 * that as a repair that claimed to fix the model and did not.
 *
 * DERIVED, NEVER STORED, from two authoritative facts: what the committed
 * candidate changed, and what the analysis of the NEW revision still detects.
 * "The repair added triangles" is not the test for partial; what remains is.
 */
export const RepairOutcomeKind = {
  /** Applied; the new revision's analysis has not reported yet. */
  Checking: 'checking',
  /** Something was fixed and the new analysis detects no error or warning. */
  Complete: 'complete',
  /** Something was fixed and detected issues remain. */
  Partial: 'partial',
  /** The repair changed no triangle. Not a success: nothing happened. */
  NoChange: 'no-change',
} as const;

export type RepairOutcomeKind = (typeof RepairOutcomeKind)[keyof typeof RepairOutcomeKind];

export interface RepairOutcome {
  readonly kind: RepairOutcomeKind;
  readonly headline: string;
  /** One sentence under the headline. */
  readonly support: string;
  /**
   * ONE coherent sentence for assistive technology, or `undefined` while the
   * outcome is still being checked — so a screen reader hears "partial repair,
   * two openings filled, issues remain" once, not "applied" and then a
   * separate list of errors.
   */
  readonly announcement: string | undefined;
}

export interface RepairOutcomeInput {
  /** `describeAppliedChanges` for the committed candidate. Empty: no change. */
  readonly changes: readonly string[];
  /**
   * Issue types (errors and warnings) the analysis of the NEW revision
   * detects, or `undefined` while that analysis has not reported.
   */
  readonly remainingTypes: number | undefined;
  /** The current plan offers nothing further: supported repairs are exhausted. */
  readonly exhausted: boolean;
}

export const REPAIR_FIXED_LABEL = 'Fixed';
export const REPAIR_REMAINING_LABEL = 'Still needs attention';
export const REPAIR_CHECKING_REMAINING = 'Checking the repaired mesh…';

export function deriveRepairOutcome(input: RepairOutcomeInput): RepairOutcome {
  const fixed = joinList(input.changes);
  if (input.changes.length === 0) {
    return {
      kind: RepairOutcomeKind.NoChange,
      headline: 'No changes were made',
      support: 'The repair found nothing it could change. Your model is as it was.',
      announcement: 'The repair made no changes.',
    };
  }
  if (input.remainingTypes === undefined) {
    return {
      kind: RepairOutcomeKind.Checking,
      headline: 'Repair applied',
      support: 'Checking what remains in the repaired mesh…',
      announcement: undefined,
    };
  }
  if (input.remainingTypes === 0) {
    return {
      kind: RepairOutcomeKind.Complete,
      headline: 'Repair completed',
      support: 'No detected issues remain in the checks Pybrix ran.',
      announcement: `Repair completed. ${sentenceCase(fixed)}. No detected issues remain in the checks Pybrix ran.`,
    };
  }
  return {
    kind: RepairOutcomeKind.Partial,
    headline: 'Partial repair completed',
    support: input.exhausted
      ? 'Pybrix fixed everything it can currently repair safely on this model.'
      : 'Pybrix fixed the issues it could repair safely. Some detected issues remain.',
    announcement: `Partial repair completed. ${sentenceCase(fixed)}. Some detected issues remain.`,
  };
}

/**
 * The Health line after a repair that left issues: the same authoritative
 * counts, with one word saying they are what is LEFT. Only ever applied to a
 * summary that has an error or a warning in it.
 */
export function describeHealthRemaining(summaryText: string): string {
  return `${summaryText} remaining`;
}

/**
 * The Activity entry for an applied repair: what changed, and where to look
 * for the rest. It makes no claim about what remains — the analysis of the new
 * revision has not run when this is written.
 */
export function describeAppliedActivity(changes: readonly string[]): string {
  return changes.length === 0
    ? 'Repair applied. No triangles changed.'
    : `Repair applied: ${joinList(changes)}. Health shows what remains.`;
}

/* ---------------------------------------------------- applied result -- */

/**
 * What an applied repair changed, one line per non-zero count. Counts come
 * from the validated candidate the worker committed, never from the plan.
 */
export function describeAppliedChanges(
  counts: RepairChangeCounts,
  filledOpenings = 0,
  local: { readonly repaired: number; readonly reversed: number } = { repaired: 0, reversed: 0 },
): readonly string[] {
  const lines: string[] = [];
  if (filledOpenings > 0) lines.push(`${plural(filledOpenings, 'opening')} filled`);
  // REPAIR-CORE-06B: what the local repair fixed, in the model's own terms.
  if (local.repaired > 0) {
    lines.push(
      `${plural(local.repaired, 'non-manifold vertex', 'non-manifold vertices')} repaired`,
    );
  }
  if (counts.removedDuplicateFaces > 0) {
    lines.push(`${plural(counts.removedDuplicateFaces, 'duplicate triangle')} removed`);
  }
  const degenerate = counts.removedRepeatedPositionFaces + counts.removedZeroAreaFaces;
  if (degenerate > 0) lines.push(`${plural(degenerate, 'degenerate triangle')} removed`);
  const reversed = counts.flippedFaces + local.reversed;
  if (reversed > 0) {
    lines.push(`${plural(reversed, 'triangle')} reversed to match neighbours`);
  }
  return lines;
}

/**
 * Issue types still detected after the repair, from the NEW analysis. Empty
 * while that analysis has not reported, which the caller must not present as
 * "nothing remains".
 */
export function describeRemaining(issues: readonly RepairIssue[]): readonly string[] {
  return remainingIssues(issues).map(describeRemainingIssue);
}

/** The rows still detected: errors and warnings whose check has run. */
export function remainingIssues(issues: readonly RepairIssue[]): readonly RepairIssue[] {
  return issues.filter(
    (issue) =>
      (issue.severity === IssueSeverity.Error || issue.severity === IssueSeverity.Warning) &&
      issue.count !== undefined,
  );
}

/**
 * "11 open boundaries". ONE CATEGORY, ITS OWN COUNT: boundaries, vertices and
 * pieces are different kinds of thing, and nothing here ever adds them up.
 */
export function describeRemainingIssue(issue: RepairIssue): string {
  return `${(issue.count ?? 0).toLocaleString()} ${issue.label.toLowerCase()}`;
}

/* ------------------------------------------------------ repair options -- */

/** Short labels for the four conservative operations, in the compact list. */
export const REPAIR_OPTION_LABELS: Readonly<Record<RepairOperation, string>> = {
  [RepairOperation.RemoveDuplicateFaces]: 'Remove duplicate triangles',
  [RepairOperation.RemoveRepeatedPositionFaces]: 'Remove collapsed triangles',
  [RepairOperation.RemoveZeroAreaFaces]: 'Remove zero-area triangles',
  [RepairOperation.UnifyWinding]: 'Unify winding',
};

/** The trailing status beside one option: what the plan found for it. */
export function describeOptionStatus(entry: RepairOperationDecision): string {
  switch (entry.decision) {
    case RepairDecision.Applicable:
      return entry.operation === RepairOperation.UnifyWinding
        ? `${entry.expectedFaceMutations.toLocaleString()} to reverse`
        : `${entry.expectedFaceMutations.toLocaleString()} to remove`;
    case RepairDecision.NotNeeded:
      if (entry.reason === RepairReason.NotRequested) {
        return entry.targetedCount > 0 ? 'Not selected' : 'No matches';
      }
      return entry.targetedCount > 0 ? 'Resolved by plan' : 'No matches';
    case RepairDecision.RefusedUnsafe:
      return 'Refused';
    case RepairDecision.BlockedByPrecondition:
      return 'Blocked';
    case RepairDecision.Unsupported:
      return 'Unavailable';
  }
}

/* ------------------------------------------------------------ info -- */

/** The three-part explanation behind an ⓘ. */
export interface InfoText {
  readonly meaning: string;
  readonly canDo: string;
  readonly cannot: string;
}

export const ISSUE_INFO: Readonly<Record<RepairIssueId, InfoText>> = {
  [RepairIssueId.OpenBoundaries]: {
    meaning:
      'Edges used by only one triangle, grouped into rims where the surface stops. A simple loop is one clean closed rim; a complex boundary branches or does not close.',
    canDo: `Repair model fills simple, flat openings that qualify on their own — up to ${BOUNDARY_FILL_MAX_OPENINGS_PER_REPAIR.toLocaleString()} per repair, each of up to ${HOLE_FILL_MAX_BOUNDARY_VERTICES.toLocaleString()} rim points — and checks every fill against the geometry around it before you apply it. No points are added or moved.`,
    cannot:
      'Complex boundaries, curved rims, and fills that would pass through existing geometry are left open and listed with the reason. An opening may also be intentional — a tube, a vase, a shell; turn off Fill simple openings to keep them all.',
  },
  [RepairIssueId.NonManifoldEdges]: {
    meaning: 'More than two triangles meet along one edge, so which side is inside is ambiguous.',
    canDo: 'Show where they are so they can be fixed in the source model.',
    cannot:
      'Rewriting them means choosing which triangles belong together, which cannot be decided from the stored coordinates alone.',
  },
  [RepairIssueId.NonManifoldVertices]: {
    meaning:
      'Triangles around one point do not form a single continuous fan — for example two shells touching at a corner.',
    canDo: 'Report them. They can also block winding repair in the affected piece.',
    cannot:
      'Separating them without moving a point leaves every point exactly where it is, so exact-coordinate analysis — and any tool that joins triangles by position — would still see them joined. Pybrix does not offer it; they are fixed in the source model.',
  },
  [RepairIssueId.WindingConflicts]: {
    meaning: 'Neighbouring triangles disagree about which way their shared edge runs.',
    canDo:
      'Reverse triangles so neighbours agree. Agreement is relative to neighbours; it does not decide which side is outside.',
    cannot:
      'A piece with non-manifold edges or vertices, or one that cannot be oriented consistently, is left unchanged.',
  },
  [RepairIssueId.SelfIntersections]: {
    meaning:
      'Triangles of this part that pass through other triangles of the same part. Other parts are not compared.',
    canDo: `Check parts of up to ${SELF_INTERSECTION_MAX_FACES.toLocaleString()} triangles and show where crossings are.`,
    cannot: 'Resolving a crossing changes the shape, so no automatic repair is offered.',
  },
  [RepairIssueId.DegenerateFaces]: {
    meaning:
      'Triangles with no usable area: two corners at the same point, or three corners exactly in a line.',
    canDo: 'Remove them, keeping every other triangle and every coordinate exactly as stored.',
    cannot:
      'A removal that would open the surface, split a piece or create a new conflict is refused.',
  },
  [RepairIssueId.DuplicateFaces]: {
    meaning: 'Extra triangles occupying the same three points as another triangle.',
    canDo: 'Remove exact copies that run the same way, keeping the first.',
    cannot:
      'Reversed copies are always kept — they may describe a deliberate zero-thickness feature. Copies in different mesh groups are kept too.',
  },
  [RepairIssueId.Components]: {
    meaning:
      'Groups of triangles not connected to each other by a shared edge. An assembly of separate pieces is normal; a stray fragment may not be.',
    canDo: 'Count them. Advanced diagnostics lists each one.',
    cannot: 'Pieces are never joined, welded or deleted automatically.',
  },
};

/** Behind the ⓘ beside the health summary. Explains the arithmetic. */
export const SUMMARY_INFO: InfoText = {
  meaning:
    'The summary counts issue TYPES, not individual occurrences: "1 error · 2 warnings" means three kinds of issue, however many edges or triangles each involves.',
  canDo:
    'Errors are structurally ambiguous surfaces — non-manifold edges or vertices and self-intersections. Warnings may be intended or are recoverable — open boundaries, winding conflicts, degenerate or duplicate triangles, and more than one piece.',
  cannot:
    'A check that has not run is not counted as passing. Wall thickness is not measured, so no summary here says whether a model will print.',
};

/** Behind the ⓘ beside Repair options. */
export const REPAIR_OPTIONS_INFO: InfoText = {
  meaning:
    'Four conservative operations, each decided exactly from the stored coordinates, and filling of simple flat openings. The selected ones run together when you press Repair model.',
  canDo:
    'Remove exact duplicate and degenerate triangles, make neighbouring triangles agree on winding, and fill openings that qualify one by one. Every result is previewed and revalidated before you apply it, and can be undone.',
  cannot:
    'No tolerance or welding is used, no existing point is moved, complex boundaries are not closed, and non-manifold geometry and self-intersections are not rewritten.',
};

/** Behind the ⓘ beside the fill option. */
export const FILL_OPTION_INFO: InfoText = {
  meaning:
    'Closes simple, flat openings with new triangles between the rim’s own points, as part of the same repair.',
  canDo: `Each opening is admitted on its own: one closed rim, flat, triangulable without new points, and not touching another opening. Up to ${BOUNDARY_FILL_MAX_OPENINGS_PER_REPAIR.toLocaleString()} per repair. Each fill is checked against the geometry around it, and the whole result is re-analysed before you can apply it.`,
  cannot:
    'Branched or curved boundaries are never filled, and an opening that is meant to be there is filled too if it qualifies — turn this off to keep openings as they are.',
};

/** Behind the ⓘ beside the file-structure line. */
export const FILE_STRUCTURE_INFO: InfoText = {
  meaning: 'The file parsed correctly and describes well-formed triangles.',
  canDo: 'Pybrix could read every triangle the file contains, exactly as stored.',
  cannot:
    'This does not mean the mesh is manifold or ready for a slicer. Mesh topology is reported separately, in Detected issues.',
};

/** Behind the ⓘ beside Advanced diagnostics. */
export const ADVANCED_INFO: InfoText = {
  meaning:
    'The full report every row above is derived from: topology counts, boundaries, surface metrics, pieces, overlays and the checks that were not performed.',
  canDo: 'Show the exact numbers and toggle viewport overlays for each category.',
  cannot: 'Nothing here changes the model.',
};

/** The one-line file-structure label. Never "Valid" alone. */
export function describeFileStructure(valid: boolean): string {
  return valid ? 'File structure valid' : 'File structure invalid';
}

/** The one line a part above the filling ceiling gets; the numbers are behind an ⓘ. */
export const HOLE_FILL_SIZE_LIMIT_LINE =
  'Choosing openings one at a time isn’t available at this part size. Repair model can still fill eligible openings.';

/** The disabled-action reason when the page cannot stop a repair. */
export const REPAIR_UNAVAILABLE_LINE = 'Repair is unavailable in this browser context.';

/* ----------------------------------------------------------- utilities -- */

/** "a", "a and b", "a, b and c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}
