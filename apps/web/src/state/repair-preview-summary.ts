import {
  LocalRepairOutcomeKind,
  type LocalRepairNotRun,
  type LocalRepairOutcome,
  type LocalRepairPlan,
  type TopologyReport,
} from '@cadfixer/geometry-runtime';
import {
  deriveRepairIssues,
  IssueSeverity,
  type RepairIssue,
  type RepairIssueId,
} from './repair-issues';

/**
 * WHAT A REPAIR PREVIEW SAYS — REPAIR-CORE-06B.
 *
 * FRAMEWORK-FREE AND PURE, like every presentation module. Scalars and two topology reports in,
 * sentences out, tested without a DOM. The Preview answers three questions at once: what will be
 * fixed, what will remain, and what happened to the parts Pybrix would not touch.
 *
 * ISSUES AND GEOMETRY EDITS ARE DIFFERENT QUANTITIES. "3 non-manifold vertices fixed" is a fact
 * about the model's issues, read from the two authoritative analyses (the source's and the
 * candidate's). "19 triangles replaced" is a fact about the edit. They are reported separately
 * and never converted into one another, and no category count is ever summed with another.
 *
 * NOTHING HERE DECIDES A SAFETY QUESTION, and nothing here names an algorithm: no work budget, no
 * fan, no surgery, no intersection pair. The typed outcome the worker returned is mapped to what
 * it means to a person trying to fix a model.
 *
 * `limitLikely` IS ADVISORY ONLY. It may produce a subtle line BEFORE the repair runs and it
 * decides nothing: it never disables Repair, never predicts the result, and never changes an
 * outcome. The outcome is the typed result the engine actually returned.
 */

/** Terms no string in this module may contain. Enforced by test over every string it can emit. */
export const REPAIR_PREVIEW_FORBIDDEN_TERMS: readonly string[] = [
  'hole',
  'printable',
  'print ready',
  'ready to print',
  'watertight',
  'perfect',
  'guaranteed',
  'fully repaired',
  'manufacturing',
  'all issues fixed',
  'all errors fixed',
  'fix everything',
  'work unit',
  'budget',
  'surgery',
  'retriangulat',
  'residual',
  'geogram',
  'ls-a2',
  'fan ',
  'failed',
];

/* ----------------------------------------------------------- the outcome -- */

/** What the user is told about a preview. One value, derived, never stored. */
export const PreviewOutcome = {
  /** Every supported issue Pybrix detected is repaired in this preview. */
  Complete: 'complete',
  /** Pybrix repaired what it could; the rest is outside what automatic repair supports. */
  PartialUnsupported: 'partial-unsupported',
  /** Automatic repair reached its safe processing limit on a complex model. */
  PartialLimit: 'partial-limit',
  /** Some areas were left unchanged because repairing them would mean guessing. */
  PartialAmbiguous: 'partial-ambiguous',
} as const;

export type PreviewOutcome = (typeof PreviewOutcome)[keyof typeof PreviewOutcome];

export interface PreviewSummary {
  readonly outcome: PreviewOutcome;
  readonly headline: string;
  /** One or two sentences under the headline. */
  readonly support: string;
  /** Issue categories this preview fixes, each with its OWN count. */
  readonly fixed: readonly string[];
  /** Issue categories still detected in the candidate, each with its own count. */
  readonly remaining: readonly string[];
  /** Issue TYPES detected in the model as it is now / in the candidate. */
  readonly currentIssueTypes: number | undefined;
  readonly afterIssueTypes: number | undefined;
  /** The edit itself, secondary: triangles replaced, added, reversed. */
  readonly geometry: readonly string[];
}

export function mapLocalOutcome(kind: LocalRepairOutcome['kind'] | undefined): PreviewOutcome {
  switch (kind) {
    case LocalRepairOutcomeKind.PartialUnsupported:
      return PreviewOutcome.PartialUnsupported;
    case LocalRepairOutcomeKind.PartialLimit:
      return PreviewOutcome.PartialLimit;
    case LocalRepairOutcomeKind.PartialAmbiguous:
      return PreviewOutcome.PartialAmbiguous;
    case LocalRepairOutcomeKind.Complete:
    case LocalRepairOutcomeKind.NoChange:
    case undefined:
      return PreviewOutcome.Complete;
  }
}

/** Headline and support for each outcome. Exhaustive, no default. */
export function describePreviewOutcome(
  outcome: PreviewOutcome,
  anythingRemains: boolean,
): { readonly headline: string; readonly support: string } {
  switch (outcome) {
    case PreviewOutcome.Complete:
      return {
        headline: 'Ready to apply',
        support: anythingRemains
          ? 'Pybrix repaired every issue it can fix automatically. Other detected issues remain.'
          : 'Pybrix repaired every issue it detected that automatic repair supports.',
      };
    case PreviewOutcome.PartialUnsupported:
      return {
        headline: 'Some issues need manual repair',
        support:
          'Pybrix can repair part of this model safely. The remaining issues are outside what automatic repair supports.',
      };
    case PreviewOutcome.PartialLimit:
      return {
        headline: 'Part of this model can be repaired',
        support:
          'Pybrix repaired part of this model, but the remaining topology is too complex for this automatic repair pass.',
      };
    case PreviewOutcome.PartialAmbiguous:
      return {
        headline: 'Some areas were left unchanged',
        support:
          'Some areas were left unchanged because repairing them automatically could change the intended shape.',
      };
  }
}

/**
 * Why a repair produced NOTHING to preview, when issues were detected but no safe change exists.
 * Not an error: the model is unchanged and nothing went wrong. Distinct from a model with nothing
 * to repair, which never reaches a repair at all.
 */
export function describeNoSafeChange(
  kind: LocalRepairOutcome['kind'] | undefined,
  notRun: LocalRepairNotRun | undefined,
): string {
  if (notRun !== undefined) {
    return 'Pybrix could not run the safety checks for this repair, so nothing was changed. Your model is unchanged.';
  }
  switch (kind) {
    case LocalRepairOutcomeKind.PartialAmbiguous:
      return 'Repairing these areas automatically could change the intended shape, so Pybrix left them unchanged. Your model is unchanged.';
    case LocalRepairOutcomeKind.PartialLimit:
      return 'This model is too complex for this automatic repair pass, and no safe partial repair was found. Your model is unchanged.';
    case LocalRepairOutcomeKind.PartialUnsupported:
    case LocalRepairOutcomeKind.NoChange:
    case LocalRepairOutcomeKind.Complete:
    case undefined:
      return 'Pybrix couldn’t safely repair these issues automatically. Your model is unchanged.';
  }
}

/** The error code that marks a neutral, non-failure "nothing safe to change" result. */
export const NO_SAFE_CHANGE_CODE = 'no-safe-change';

/** A subtle line BEFORE Repair runs, only when the plan says the model is unusually complex. */
export const LIMIT_LIKELY_LINE =
  'This model is unusually complex. Automatic repair may be limited.';

export function describeLimitLikely(plan: LocalRepairPlan | undefined): string | undefined {
  return plan?.limitLikely === true ? LIMIT_LIKELY_LINE : undefined;
}

/* ------------------------------------------------------------- progress -- */

/*
 * Stage text comes from `runtime/repair-service.ts` (`describeRepairPhase`), the ONE place worker
 * stage notes become words. It is stage text and never a percentage: the engine does not know
 * how much work remains, so the panel shows an indeterminate bar and the stage.
 */

export const REPAIR_APPLYING_LINE = 'Applying repairs…';
export const REPAIR_CHECKING_MODEL_LINE = 'Checking repaired model…';

/* --------------------------------------------------------------- summary -- */

const issueNoun = (issue: RepairIssue, count: number): string => {
  const plural = issue.label.toLowerCase();
  if (count !== 1) return plural;
  const [singular, pluralUnit] = issue.unit;
  if (plural.endsWith(pluralUnit)) {
    return `${plural.slice(0, plural.length - pluralUnit.length)}${singular}`;
  }
  // The unit names what is counted ("edge"), the label names the issue ("winding conflicts").
  if (plural.endsWith('ies')) return `${plural.slice(0, -3)}y`;
  return plural.endsWith('s') ? plural.slice(0, -1) : plural;
};

const detected = (issue: RepairIssue): boolean =>
  (issue.severity === IssueSeverity.Error || issue.severity === IssueSeverity.Warning) &&
  issue.count !== undefined;

function rowsOf(report: TopologyReport): readonly RepairIssue[] {
  return deriveRepairIssues({
    report,
    detail: undefined,
    selfIntersection: undefined,
    boundaryRows: undefined,
  });
}

/**
 * FIXED: per category, how many fewer the candidate has than the model has now. REMAINING: what
 * the candidate still has. Both come from the two analyses the worker ran on exactly these two
 * meshes, so neither is a prediction and neither depends on which operations ran.
 */
export function diffIssues(
  before: TopologyReport,
  after: TopologyReport,
): {
  readonly fixed: readonly string[];
  readonly remaining: readonly string[];
  readonly fixedIds: readonly RepairIssueId[];
  readonly currentTypes: number;
  readonly afterTypes: number;
} {
  const beforeRows = rowsOf(before);
  const afterRows = new Map(rowsOf(after).map((row) => [row.id, row]));
  const fixed: string[] = [];
  const fixedIds: RepairIssueId[] = [];
  for (const row of beforeRows) {
    const then = row.count;
    const now = afterRows.get(row.id)?.count;
    if (then === undefined || now === undefined || !detected(row)) continue;
    const delta = then - now;
    if (delta > 0) {
      fixed.push(`${delta.toLocaleString()} ${issueNoun(row, delta)}`);
      fixedIds.push(row.id);
    }
  }
  const remainingRows = [...afterRows.values()].filter(detected);
  return {
    fixed,
    fixedIds,
    remaining: remainingRows.map(
      (row) => `${(row.count ?? 0).toLocaleString()} ${issueNoun(row, row.count ?? 0)}`,
    ),
    currentTypes: beforeRows.filter(detected).length,
    afterTypes: remainingRows.length,
  };
}

/** Secondary: what the EDIT did, in triangles. Never presented as issues fixed. */
export function describeGeometryChanges(local: LocalRepairOutcome | undefined): readonly string[] {
  if (local === undefined) return [];
  const lines: string[] = [];
  const triangles = (count: number): string =>
    `${count.toLocaleString()} ${count === 1 ? 'triangle' : 'triangles'}`;
  if (local.facesRemoved > 0) lines.push(`${triangles(local.facesRemoved)} replaced`);
  if (local.facesAppended > 0) lines.push(`${triangles(local.facesAppended)} added`);
  if (local.facesReversed > 0) lines.push(`${triangles(local.facesReversed)} reversed`);
  return lines;
}

export function derivePreviewSummary(input: {
  readonly before: TopologyReport;
  readonly after: TopologyReport;
  readonly local: LocalRepairOutcome | undefined;
}): PreviewSummary {
  const diff = diffIssues(input.before, input.after);
  const outcome = mapLocalOutcome(input.local?.kind);
  const copy = describePreviewOutcome(outcome, diff.remaining.length > 0);
  return {
    outcome,
    headline: copy.headline,
    support: copy.support,
    fixed: diff.fixed,
    remaining: diff.remaining,
    currentIssueTypes: diff.currentTypes,
    afterIssueTypes: diff.afterTypes,
    geometry: describeGeometryChanges(input.local),
  };
}

/** The Current model / After repair pair, one phrase each, counted in issue TYPES. */
export function describeIssueTypeCount(types: number | undefined): string {
  if (types === undefined) return 'Not checked';
  if (types === 0) return 'No detected issues';
  return `${types.toLocaleString()} issue ${types === 1 ? 'type' : 'types'}`;
}
