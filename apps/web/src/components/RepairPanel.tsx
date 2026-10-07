import type { ReactNode } from 'react';
import {
  fillableOpeningCount,
  BoundaryFillVerdict,
  type BoundaryFillOutcome,
  type BoundaryFillPlan,
} from '@cadfixer/geometry-runtime';
import type {
  ConservativeRepairPlan,
  LocalRepairChange,
  LocalRepairOutcome,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairOperation,
  RepairOperationDecision,
  RepairValidation,
} from '@cadfixer/geometry-runtime';
import { isInterruptibleRepairSupported } from '../runtime/cancellation-support';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useRepairControls } from '../state/workflow-controllers';
import { useRevealOnMount } from './shell/action-footer';
import { Icon } from './shell/Icon';
import { InfoButton, InfoPanel, useInfoDisclosure } from './shell/info';
import { PanelSection } from './shell/primitives';
import {
  DeltaMeaning,
  REPAIR_APPLIED_DETAIL,
  REPAIR_EXCLUSIONS,
  REPAIR_ISOLATION_DETAIL,
  REPAIR_ISOLATION_HEADLINE,
  REPAIR_OPERATION_COPY,
  REPAIR_OPERATION_ORDER,
  REPAIR_QUALIFIER,
  buildMetricRows,
  describeBoundsComparison,
  describeChangeSampling,
  describeVolumeComparison,
  describeVolumeComparisonHelp,
  presentAcceptance,
  presentDecision,
} from '../state/repair-presentation';
import {
  FILL_OPTION_INFO,
  FILL_OPTION_LABEL,
  REPAIR_OPTIONS_INFO,
  REPAIR_OPTION_LABELS,
  describeFillOptionStatus,
  describeFillVerdict,
  summariseFillVerdicts,
  REPAIR_CHECKING_REMAINING,
  REPAIR_FIXED_LABEL,
  REPAIR_REMAINING_LABEL,
  RepairActionKind,
  RepairOutcomeKind,
  UNDO_REPAIR_ACTION,
  deriveRepairOutcome,
  describeAppliedChanges,
  describeOptionStatus,
  describeRemainingIssue,
  remainingIssues,
  type IssueStatus,
  type RepairOutcome,
} from '../state/repair-workspace-presentation';
import { IssueSeverity, type RepairIssue, type RepairIssueId } from '../state/repair-issues';
import { derivePreviewSummary, describeIssueTypeCount } from '../state/repair-preview-summary';
import { formatArea, formatMagnitude } from '../state/topology-presentation';
import { useRepairWorkspace } from '../state/use-repair-workspace';
import {
  RepairCandidateState,
  RepairCommitState,
  RepairPlanState,
  RepairPreviewMode,
  type ChangeOverlayId,
} from '../state/workspace-store';
import { describeActivePart } from '../state/part-presentation';

/**
 * REPAIR OPTIONS — the conservative operations, compactly (REPAIR-UX-01).
 *
 * PRESENTATION AND DISPATCH ONLY. Every decision shown here was made in the
 * worker; every sentence was written in `repair-presentation.ts` or
 * `repair-workspace-presentation.ts`. This component runs no repair logic,
 * decides no safety question, and cannot commit anything: the footer's Apply
 * calls a hook that calls the worker, and the worker re-checks every guard
 * before it swaps a single reference.
 *
 * WHAT IS ON SCREEN BY DEFAULT: one row per operation with its checkbox and
 * what the plan found for it; the preview's headline and change counts while a
 * candidate exists; and what an applied repair changed and what remains. The
 * operation descriptions, refusal reasons, before/after metrics and change
 * overlays are all still here, one ⓘ or one "Preview details" away.
 *
 * EVERY OPERATION IS LISTED, always — including the ones with nothing to do
 * and the ones that were refused. An absent row leaves the user wondering
 * whether the check ran.
 */
export function RepairPanel(): ReactNode {
  const { model, activePartId, repair } = useWorkspaceState();
  const store = useWorkspaceStore();
  const controls = useRepairControls();
  const { navigation, reportIsCurrent, currentFill, statuses, action } = useRepairWorkspace();

  if (model === undefined) return null;

  /*
   * FAIL CLOSED. Without an interruptible cancellation signal no repair is
   * offered at all — the footer's action is disabled for the same reason, and
   * the worker refuses the request independently.
   */
  if (!isInterruptibleRepairSupported()) {
    return (
      <PanelSection title="Repair options" testId="auto-repair" info={REPAIR_OPTIONS_INFO}>
        <div className="repair__blocked" role="alert" data-testid="repair-isolation-unavailable">
          <p className="repair__error-message">{REPAIR_ISOLATION_HEADLINE}</p>
          <p className="panel__note" data-testid="repair-isolation-detail">
            {REPAIR_ISOLATION_DETAIL}
          </p>
        </div>
      </PanelSection>
    );
  }

  const plan = repair.plan;
  const candidate = repair.candidate;
  const previewReady =
    repair.candidateState === RepairCandidateState.Ready && candidate !== undefined;
  const isBuilding =
    repair.candidateState === RepairCandidateState.Building ||
    repair.candidateState === RepairCandidateState.Cancelling;
  const isCommitting = repair.commitState !== RepairCommitState.Idle;

  return (
    <PanelSection
      title="Repair options"
      testId="auto-repair"
      meta={`${String(repair.selection.length + (repair.fillOpenings ? 1 : 0))} of 5 selected`}
      info={REPAIR_OPTIONS_INFO}
    >
      <div className="repair-options" data-testid="repair-panel">
        {/*
          WHICH PART A REPAIR WOULD CHANGE. Repair operates on ONE part; on a
          multi-part document leaving that implicit would let a user believe an
          Apply had touched their whole model.
        */}
        {model.parts.length > 1 ? (
          <p className="panel__note" data-testid="repair-part-scope">
            Repairs <strong>{describeActivePart(model.parts, activePartId)}</strong> only, of{' '}
            {model.parts.length.toLocaleString()} parts. The others are left exactly as they are.
          </p>
        ) : null}

        {repair.lastApplied === undefined ? null : (
          <AppliedResult
            operations={repair.lastApplied.appliedOperations}
            counts={repair.lastApplied.counts}
            filledOpenings={repair.lastApplied.filledOpenings}
            local={{
              repaired: repair.lastApplied.localRepaired ?? 0,
              reversed: repair.lastApplied.localReversed ?? 0,
            }}
            remaining={reportIsCurrent ? remainingIssues(navigation.issues) : undefined}
            statuses={statuses}
            exhausted={action === RepairActionKind.NothingSafe}
            undoable={repair.lastApplied.undoable}
            undoing={repair.commitState === RepairCommitState.Undoing}
            busy={isCommitting || isBuilding}
            onUndo={controls.undoLastRepair}
          />
        )}

        {plan === undefined || !reportIsCurrent ? (
          <p className="panel__note" data-testid="repair-options-pending">
            Options appear once the mesh has been analysed.
          </p>
        ) : (
          <>
            <OperationList
              plan={plan}
              selection={repair.selection}
              disabled={isBuilding || isCommitting || previewReady}
              onToggle={controls.setOperationSelected}
              fill={{
                selected: repair.fillOpenings,
                plan: currentFill,
                onToggle: controls.setFillOpenings,
              }}
            />
            {plan.warnings.length > 0 ? (
              <ul className="repair__warnings" data-testid="repair-plan-warnings">
                {plan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {/* The rows above are the PREVIOUS plan while a new one is computed,
                so the list does not blank on every checkbox click. Saying so is
                the difference between stale and wrong. */}
            {repair.planState === RepairPlanState.Planning ? (
              <p className="panel__note" data-testid="repair-replanning">
                Updating for the options you selected…
              </p>
            ) : null}
          </>
        )}

        {previewReady ? (
          <CandidateReview
            validation={candidate.validation}
            counts={candidate.counts}
            boundaryFill={candidate.boundaryFill}
            samples={candidate.samples}
            localRepair={candidate.localRepair}
            localChange={candidate.localChange}
            unit={model.source.unit}
            previewMode={repair.previewMode}
            overlays={repair.changeOverlays}
            onPreviewMode={controls.setPreviewMode}
            onOverlayToggle={(overlay, next) => {
              store.setChangeOverlayVisible(overlay, next);
            }}
          />
        ) : null}

        {controls.workCeiling === undefined ? null : (
          <p className="panel__note" data-testid="repair-work-ceiling-note">
            A reduced automatic repair limit is in force for this session, set by a URL option. It
            can only make automatic repair stop sooner, never later.
          </p>
        )}

        {controls.memoryCeiling.narrowed ? (
          <p className="panel__note" data-testid="repair-memory-note">
            A reduced repair memory ceiling of{' '}
            {Math.round(controls.memoryCeiling.bytes / 1048576).toLocaleString()} MiB is in force
            for this session, set by a URL option. It can only lower the limit, never raise it.
          </p>
        ) : null}
      </div>
    </PanelSection>
  );
}

/* ------------------------------------------------------------ exclusions -- */

/**
 * What conservative repair does not do. Shown in Advanced diagnostics: a user
 * who cannot find their issue among the options needs to know whether Pybrix
 * looked and refused or never looked at all — and those are different answers.
 */
export function RepairExclusions(): ReactNode {
  return (
    <>
      <h3 className="panel__subtitle">What automatic repair does not do</h3>
      <ul className="repair__exclusions" data-testid="repair-exclusions">
        {REPAIR_EXCLUSIONS.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------- operations -- */

interface FillOption {
  readonly selected: boolean;
  readonly plan: BoundaryFillPlan | undefined;
  readonly onToggle: (selected: boolean) => void;
}

function OperationList({
  plan,
  selection,
  disabled,
  onToggle,
  fill,
}: {
  readonly plan: ConservativeRepairPlan;
  readonly selection: readonly RepairOperation[];
  readonly disabled: boolean;
  readonly onToggle: (operation: RepairOperation, selected: boolean) => void;
  readonly fill: FillOption;
}): ReactNode {
  const byOperation = new Map<RepairOperation, RepairOperationDecision>(
    plan.decisions.map((entry) => [entry.operation, entry]),
  );

  return (
    <ul
      className="repair-options__list"
      aria-label="Repair options"
      data-testid="repair-operations"
    >
      {REPAIR_OPERATION_ORDER.map((operation) => {
        const decision = byOperation.get(operation);
        if (decision === undefined) {
          // The plan always decides every operation. If one is missing, say so
          // rather than rendering a row that implies it was considered.
          return (
            <li className="repair-option" key={operation} data-testid={`repair-op-${operation}`}>
              <span className="repair-option__name">{REPAIR_OPTION_LABELS[operation]}</span>
              <span className="repair-option__status">No decision reported</span>
            </li>
          );
        }
        return (
          <OperationRow
            key={operation}
            decision={decision}
            checked={selection.includes(operation)}
            disabled={disabled}
            onToggle={onToggle}
          />
        );
      })}
      <FillOptionRow fill={fill} disabled={disabled} />
    </ul>
  );
}

/**
 * REPAIR-CORE-02: automatic filling of simple flat openings, as a fifth option.
 *
 * The status is the WORKER'S admission count; the ⓘ breaks down why the other
 * openings are left alone. Nothing here decides eligibility.
 */
function FillOptionRow({
  fill,
  disabled,
}: {
  readonly fill: FillOption;
  readonly disabled: boolean;
}): ReactNode {
  const info = useInfoDisclosure();
  const reasons =
    fill.plan === undefined
      ? []
      : summariseFillVerdicts(fill.plan.loops, [BoundaryFillVerdict.Admitted]);
  return (
    <li
      className={`repair-option repair-option--${
        fill.selected && fillableOpeningCount(fill.plan) > 0 ? 'available' : 'inactive'
      }`}
      data-testid="repair-op-fill-openings"
    >
      <div className="repair-option__row">
        <label className="repair-option__label">
          <input
            type="checkbox"
            checked={fill.selected}
            disabled={disabled}
            onChange={(event) => {
              fill.onToggle(event.target.checked);
            }}
            data-testid="repair-op-toggle-fill-openings"
          />
          <span className="repair-option__name">{FILL_OPTION_LABEL}</span>
        </label>
        <span className="repair-option__status" data-testid="repair-op-status-fill-openings">
          {describeFillOptionStatus(fill.selected, fill.plan)}
        </span>
        <InfoButton
          disclosure={info}
          label={FILL_OPTION_LABEL}
          testId="repair-op-info-fill-openings"
        />
      </div>
      <InfoPanel
        disclosure={info}
        label={FILL_OPTION_LABEL}
        info={FILL_OPTION_INFO}
        testId="repair-op-info-panel-fill-openings"
      >
        {reasons.length === 0 ? null : (
          <ul className="info-panel__list" data-testid="fill-plan-reasons">
            {reasons.map((entry) => (
              <li key={entry.verdict}>
                {entry.count.toLocaleString()} — {describeFillVerdict(entry.verdict)}
              </li>
            ))}
          </ul>
        )}
        {fill.plan?.loopsTruncated === true ? (
          <p className="info-panel__text">The first openings are listed; the counts are exact.</p>
        ) : null}
      </InfoPanel>
    </li>
  );
}

function OperationRow({
  decision,
  checked,
  disabled,
  onToggle,
}: {
  readonly decision: RepairOperationDecision;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: (operation: RepairOperation, selected: boolean) => void;
}): ReactNode {
  const operation = decision.operation;
  const info = useInfoDisclosure();
  const presented = presentDecision(decision);
  const copy = REPAIR_OPERATION_COPY[operation];
  const reasonId = `repair-op-reason-${operation}`;

  return (
    <li
      className={`repair-option repair-option--${presented.tone}`}
      data-testid={`repair-op-${operation}`}
    >
      <div className="repair-option__row">
        <label className="repair-option__label">
          <input
            type="checkbox"
            checked={checked}
            // A refused or blocked operation cannot be selected: selecting it
            // would produce a plan that refuses it again, which reads as the
            // checkbox not working.
            disabled={disabled || !presented.selectable}
            aria-describedby={reasonId}
            onChange={(event) => {
              onToggle(operation, event.target.checked);
            }}
            data-testid={`repair-op-toggle-${operation}`}
          />
          <span className="repair-option__name">{REPAIR_OPTION_LABELS[operation]}</span>
        </label>
        {/* The verdict in a word or two, as text — never colour alone. */}
        <span className="repair-option__status" data-testid={`repair-op-status-${operation}`}>
          {describeOptionStatus(decision)}
        </span>
        <InfoButton
          disclosure={info}
          label={REPAIR_OPTION_LABELS[operation]}
          testId={`repair-op-info-${operation}`}
        />
      </div>
      <InfoPanel disclosure={info} label={REPAIR_OPTION_LABELS[operation]}>
        <p className="info-panel__lead" data-testid={`repair-op-verdict-${operation}`}>
          {presented.verdict}
        </p>
        <p className="info-panel__text" id={reasonId} data-testid={reasonId}>
          {presented.reason}
        </p>
        <p className="info-panel__text">
          <span className="info-panel__label">{copy.label}. </span>
          {copy.help}
        </p>
        <p className="info-panel__text">
          <span data-testid={`repair-op-targeted-${operation}`}>
            {decision.targetedCount.toLocaleString()}
          </span>{' '}
          found ·{' '}
          <span data-testid={`repair-op-mutations-${operation}`}>
            {decision.expectedFaceMutations.toLocaleString()}
          </span>{' '}
          triangles would change
        </p>
      </InfoPanel>
    </li>
  );
}

/* --------------------------------------------------------------- applied -- */

/**
 * THE REPAIR OUTCOME — what the last repair changed, and what is still
 * detected (REPAIR-UX-04).
 *
 * THE OPERATION, NOT THE MODEL. The headline says whether the repair was
 * complete or partial; Health, above, says what condition the model is in.
 * The card is green only when the analysis of the new revision detects nothing
 * further. A partial repair keeps a neutral frame, a check mark beside what was
 * fixed, and each remaining category with ITS OWN severity icon, count and what
 * Pybrix can do about it — the same line its row under Detected issues shows.
 *
 * "Remaining" comes from the analysis of the NEW revision; until that exists
 * the card says it is still checking rather than implying nothing remains.
 * Categories are never added together.
 */
function AppliedResult({
  operations,
  counts,
  filledOpenings,
  local,
  remaining,
  statuses,
  exhausted,
  undoable,
  undoing,
  busy,
  onUndo,
}: {
  readonly operations: readonly RepairOperation[];
  readonly counts: RepairChangeCounts;
  readonly filledOpenings: number;
  readonly local: { readonly repaired: number; readonly reversed: number };
  readonly remaining: readonly RepairIssue[] | undefined;
  readonly statuses: ReadonlyMap<RepairIssueId, IssueStatus>;
  readonly exhausted: boolean;
  readonly undoable: boolean;
  readonly undoing: boolean;
  readonly busy: boolean;
  readonly onUndo: () => void;
}): ReactNode {
  const changed = describeAppliedChanges(counts, filledOpenings, local);
  const outcome: RepairOutcome = deriveRepairOutcome({
    changes: changed,
    remainingTypes: remaining?.length,
    exhausted,
  });
  /*
   * THE RESULT ANNOUNCES ITSELF — WORKSPACE-UX-03. It is content, not part of
   * the pinned action region, so on a short window it could be applied out of
   * sight; it is brought into view once, when it appears, and its Undo with it.
   */
  const ref = useRevealOnMount<HTMLDivElement>();
  return (
    // A GROUP, NOT A LIVE REGION: the footer announces the outcome once, in one
    // sentence. A live card would read "applied", then every remaining count.
    <div
      ref={ref}
      className={`repair-result repair-result--${outcome.kind}`}
      role="group"
      aria-label="Repair result"
      data-outcome={outcome.kind}
      data-testid="repair-applied"
    >
      <p className="repair-result__headline" data-testid="repair-applied-headline">
        <Icon
          name={
            outcome.kind === RepairOutcomeKind.Complete
              ? 'ok'
              : outcome.kind === RepairOutcomeKind.Checking
                ? 'loader'
                : 'info'
          }
          size={14}
          className={outcome.kind === RepairOutcomeKind.Checking ? 'spin' : ''}
        />
        {outcome.headline}
      </p>
      <p className="repair-result__support" data-testid="repair-applied-support">
        {outcome.support}
      </p>

      <p className="repair-result__label">{REPAIR_FIXED_LABEL}</p>
      <ul
        className="repair-result__list repair-result__list--fixed"
        data-testid="repair-applied-changes"
      >
        {changed.length === 0 ? <li>No triangles changed</li> : null}
        {changed.map((line) => (
          <li key={line}>
            <Icon name="ok" size={13} />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {/*
        ONLY WHEN SOMETHING REMAINS, OR IS STILL BEING CHECKED — REPAIR-UX-04-R1.
        `remaining` is the analysis of the REPAIRED revision: `undefined` until
        it reports, and empty only when that analysis detects no error or
        warning. A heading that says "Still needs attention" over a line that
        says nothing was detected contradicts "Repair completed" directly above
        it, so a complete repair has no such section. What was NOT checked is
        the qualifier beneath, which is always shown — the section's absence
        says nothing about checks that did not run.
      */}
      {remaining?.length === 0 ? null : (
        <>
          <p className="repair-result__label">{REPAIR_REMAINING_LABEL}</p>
          <ul
            className="repair-result__list repair-result__list--remaining"
            data-testid="repair-applied-remaining"
          >
            {remaining === undefined ? <li>{REPAIR_CHECKING_REMAINING}</li> : null}
            {(remaining ?? []).map((issue) => (
              <li
                key={issue.id}
                className={`repair-result__remaining repair-result__remaining--${issue.severity}`}
                data-testid={`repair-remaining-${issue.id}`}
              >
                <Icon name={issue.severity === IssueSeverity.Error ? 'error' : 'alert'} size={13} />
                <span>
                  <span className="repair-result__remaining-count">
                    {describeRemainingIssue(issue)}
                  </span>
                  {/* Severity in words, for anyone who cannot see the icon. */}
                  <span className="visually-hidden">
                    {issue.severity === IssueSeverity.Error ? ' (error)' : ' (warning)'}
                  </span>
                  {statuses.get(issue.id) === undefined ? null : (
                    <span className="repair-result__remaining-status">
                      {statuses.get(issue.id)?.text}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="repair-result__qualifier">
        {changed.length === 0 ? null : (
          <>
            <span data-testid="repair-applied-detail">{REPAIR_APPLIED_DETAIL}</span>{' '}
          </>
        )}
        <span data-testid="repair-applied-qualifier">{REPAIR_QUALIFIER}</span>
      </p>
      {/* The exact operations, kept for the record and for assistive tech. */}
      <ul className="visually-hidden" data-testid="repair-applied-operations">
        {operations.map((operation) => (
          <li key={operation}>{REPAIR_OPERATION_COPY[operation].label}</li>
        ))}
      </ul>
      <p className="visually-hidden" data-testid="repair-applied-counts">
        {counts.sourceFaceCount.toLocaleString()} triangles before ·{' '}
        {counts.candidateFaceCount.toLocaleString()} after
      </p>
      <div className="repair-result__actions">
        <button
          type="button"
          className="secondary-action"
          onClick={onUndo}
          disabled={!undoable || busy}
          data-testid="undo-repair"
        >
          {undoing ? 'Undoing repair…' : UNDO_REPAIR_ACTION}
        </button>
        {undoable ? null : (
          <span className="repair-result__note" data-testid="repair-undo-unavailable">
            This repair can no longer be undone.
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------ preview summary -- */

/**
 * WHAT THE PREVIEW WILL DO, in three answers: what is fixed, what remains, and how the model as
 * it is now compares with the candidate. Read from the two analyses the worker ran on exactly
 * these two meshes — never from a list of operations. The numbers and meanings are decided in
 * `repair-preview-summary.ts`; this only lays them out.
 *
 * "Current model" and "After repair" are labelled as such because the remaining counts describe
 * the CANDIDATE: the committed model, and the Health line above, are unchanged until Apply.
 */
function PreviewSummaryBlock({
  validation,
  localRepair,
}: {
  readonly validation: RepairValidation;
  readonly localRepair: LocalRepairOutcome | undefined;
}): ReactNode {
  const summary = derivePreviewSummary({
    before: validation.before,
    after: validation.after,
    local: localRepair,
  });
  return (
    <div className="repair-summary" data-testid="repair-summary" data-outcome={summary.outcome}>
      <p className="repair-summary__headline" data-testid="repair-summary-headline">
        {summary.headline}
      </p>
      <p className="repair-summary__support" data-testid="repair-summary-support">
        {summary.support}
      </p>
      <div className="repair-summary__columns">
        <div>
          <p className="repair-summary__heading">Fixed</p>
          <ul
            className={`repair-summary__list${summary.fixed.length === 0 ? ' repair-summary__list--none' : ''}`}
            data-testid="repair-summary-fixed"
          >
            {summary.fixed.length === 0 ? <li>No issue counts change</li> : null}
            {summary.fixed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="repair-summary__heading">Remains</p>
          <ul
            className={`repair-summary__list${summary.remaining.length === 0 ? ' repair-summary__list--none' : ''}`}
            data-testid="repair-summary-remaining"
          >
            {summary.remaining.length === 0 ? <li>No detected issues</li> : null}
            {summary.remaining.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      <dl className="repair-summary__compare" data-testid="repair-summary-compare">
        <dt>Current model</dt>
        <dd data-testid="repair-summary-current">
          {describeIssueTypeCount(summary.currentIssueTypes)}
        </dd>
        <dt>After repair</dt>
        <dd data-testid="repair-summary-after">
          {describeIssueTypeCount(summary.afterIssueTypes)}
        </dd>
      </dl>
      {summary.geometry.length === 0 ? null : (
        <p className="repair-preview__qualifier" data-testid="repair-summary-geometry">
          Geometry changes: {summary.geometry.join(' · ')}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------- candidate review -- */

function CandidateReview({
  validation,
  counts,
  boundaryFill,
  samples,
  localRepair,
  localChange,
  unit,
  previewMode,
  overlays,
  onPreviewMode,
  onOverlayToggle,
}: {
  readonly validation: RepairValidation;
  readonly counts: RepairChangeCounts;
  readonly boundaryFill: BoundaryFillOutcome | undefined;
  readonly samples: RepairChangeSamples;
  readonly localRepair: LocalRepairOutcome | undefined;
  readonly localChange: LocalRepairChange | undefined;
  readonly unit: string | undefined;
  readonly previewMode: RepairPreviewMode;
  readonly overlays: Readonly<Record<ChangeOverlayId, boolean>>;
  readonly onPreviewMode: (mode: RepairPreviewMode) => void;
  readonly onOverlayToggle: (overlay: ChangeOverlayId, next: boolean) => void;
}): ReactNode {
  const presented = presentAcceptance(validation.acceptance, validation.regressions);
  const rows = buildMetricRows(validation);
  const details = useInfoDisclosure();
  // Brought into view once, when the preview appears: it is content, and on a short window the
  // sticky actions below it would otherwise leave the summary out of sight.
  const previewRef = useRevealOnMount<HTMLDivElement>();

  return (
    <div className="repair-preview" data-testid="repair-candidate" ref={previewRef}>
      {/* A PREVIEW IS NOT AN APPLICATION: the headline says so in words. */}
      <p className="repair-preview__headline" data-testid="repair-candidate-headline">
        {presented.headline}
      </p>
      <p className="repair-preview__qualifier" data-testid="repair-candidate-qualifier">
        {presented.qualifier}
      </p>

      <PreviewSummaryBlock validation={validation} localRepair={localRepair} />

      {/* Before / After. Radios, because exactly one view is shown. */}
      <fieldset className="repair-preview__view" data-testid="preview-mode">
        <legend className="visually-hidden">Viewport</legend>
        <label className="repair-preview__view-option">
          <input
            type="radio"
            name="repair-preview-mode"
            checked={previewMode === RepairPreviewMode.Before}
            onChange={() => {
              onPreviewMode(RepairPreviewMode.Before);
            }}
            data-testid="preview-mode-before"
          />
          <span>Before</span>
        </label>
        <label className="repair-preview__view-option">
          <input
            type="radio"
            name="repair-preview-mode"
            checked={previewMode === RepairPreviewMode.After}
            onChange={() => {
              onPreviewMode(RepairPreviewMode.After);
            }}
            data-testid="preview-mode-after"
          />
          <span>After (not applied)</span>
        </label>
      </fieldset>

      <dl className="repair-preview__changes" data-testid="repair-changes">
        <Fact
          label="Duplicate triangles removed"
          value={counts.removedDuplicateFaces.toLocaleString()}
          testId="change-count-removedDuplicates"
        />
        <Fact
          label="Collapsed triangles removed"
          value={counts.removedRepeatedPositionFaces.toLocaleString()}
          testId="change-count-removedRepeatedPosition"
        />
        <Fact
          label="Zero-area triangles removed"
          value={counts.removedZeroAreaFaces.toLocaleString()}
          testId="change-count-removedZeroArea"
        />
        <Fact
          label="Triangles reversed"
          value={counts.flippedFaces.toLocaleString()}
          testId="change-count-flippedFaces"
        />
        {boundaryFill === undefined ? null : (
          <Fact
            label="Openings filled"
            value={boundaryFill.filledCount.toLocaleString()}
            testId="change-count-filledOpenings"
          />
        )}
      </dl>
      {boundaryFill === undefined ? null : <FillLeftOpen outcome={boundaryFill} />}

      <button
        id={details.buttonId}
        type="button"
        className="repair-preview__details-toggle"
        aria-expanded={details.open}
        aria-controls={details.panelId}
        onClick={details.toggle}
        data-testid="repair-preview-details-toggle"
      >
        <Icon name={details.open ? 'chev-down' : 'chev-right'} size={13} />
        Preview details
      </button>

      <div
        id={details.panelId}
        className="repair-preview__details"
        hidden={!details.open}
        data-testid="repair-preview-details"
      >
        <p className="panel__note" data-testid="repair-candidate-detail">
          {presented.detail}
        </p>
        <div className="component-table__scroll">
          <table className="component-table" data-testid="repair-metrics">
            <caption className="component-table__caption">
              Measured before and after by the same analysis. The right-hand column says whether
              each movement was expected.
            </caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} data-testid={`repair-metric-${row.key}`}>
                  <th scope="row">
                    {row.label}
                    {row.note === undefined ? null : (
                      <span className="repair__metric-note" data-testid={`repair-note-${row.key}`}>
                        {row.note}
                      </span>
                    )}
                  </th>
                  <td data-testid={`repair-before-${row.key}`}>{row.before.toLocaleString()}</td>
                  <td data-testid={`repair-after-${row.key}`}>{row.after.toLocaleString()}</td>
                  <td data-testid={`repair-delta-${row.key}`}>
                    {describeDelta(row.delta, row.meaning)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="facts" data-testid="repair-measures">
          <Fact
            label="Surface area before"
            value={formatArea(validation.surfaceAreaBefore, unit)}
            testId="repair-area-before"
          />
          <Fact
            label="Surface area after"
            value={formatArea(validation.surfaceAreaAfter, unit)}
            testId="repair-area-after"
          />
          <Fact
            label="Signed volume (algebraic)"
            value={`${formatMagnitude(validation.signedVolumeBefore)} → ${formatMagnitude(validation.signedVolumeAfter)}`}
            testId="repair-volume"
          />
          <Fact
            label="Volume comparison"
            value={describeVolumeComparison(validation.volumeComparison)}
            testId="repair-volume-status"
          />
          <Fact
            label="Bounding box"
            value={describeBoundsComparison(validation.boundsComparison)}
            testId="repair-bounds-status"
          />
          <Fact label="Self-intersections" value="Not checked" testId="repair-selfintersection" />
        </dl>
        <p className="panel__note">{describeVolumeComparisonHelp(validation.volumeComparison)}</p>

        {/* Warnings are not errors. */}
        {validation.warnings.length > 0 ? (
          <>
            <h3 className="panel__subtitle">Worth knowing</h3>
            <ul className="repair__warnings" data-testid="repair-warnings">
              {validation.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </>
        ) : null}

        <ChangeOverlayControls
          counts={counts}
          samples={samples}
          localChange={localChange}
          visible={overlays}
          previewMode={previewMode}
          onToggle={onOverlayToggle}
        />
      </div>
    </div>
  );
}

/**
 * Openings the fill stage left open, by reason, in one line each. Complex
 * boundaries are named as such rather than hidden: the user should know they
 * were looked at and deliberately left alone.
 */
function FillLeftOpen({ outcome }: { readonly outcome: BoundaryFillOutcome }): ReactNode {
  const reasons = summariseFillVerdicts(outcome.loops, [BoundaryFillVerdict.Filled]);
  if (reasons.length === 0) return null;
  let total = 0;
  for (const entry of reasons) total += entry.count;
  return (
    <div className="repair-preview__left-open" data-testid="fill-left-open">
      <p className="repair-preview__left-open-headline" data-testid="fill-left-open-count">
        {total.toLocaleString()} {total === 1 ? 'opening' : 'openings'} left open
      </p>
      <ul className="repair-result__list">
        {reasons.map((entry) => (
          <li key={entry.verdict} data-testid={`fill-left-open-${entry.verdict}`}>
            {entry.count.toLocaleString()} — {describeFillVerdict(entry.verdict)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The change delta, worded so a movement is never mislabelled.
 *
 * PART F1. Once the validator ACCEPTED a candidate, every remaining difference
 * was predicted before the rebuild and confirmed after it — including a
 * boundary-edge count that rose because a duplicate that was hiding an opening
 * has been removed. Calling that an error would be the interface inventing a
 * problem the engine explicitly reasoned about and allowed.
 */
function describeDelta(delta: number, meaning: DeltaMeaning): string {
  if (meaning === DeltaMeaning.Unchanged) return 'No change';
  const signed = `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;
  return meaning === DeltaMeaning.Expected ? `${signed} (expected)` : `${signed} (rejected)`;
}

/* ---------------------------------------------------------- change overlays -- */

interface ChangeOverlayDescriptor {
  readonly id: ChangeOverlayId;
  readonly label: string;
  readonly exact: number;
  readonly drawn: number;
  /** False when the category's triangles do not exist in the current view. */
  readonly availableInView: boolean;
}

function ChangeOverlayControls({
  counts,
  samples,
  localChange,
  visible,
  previewMode,
  onToggle,
}: {
  readonly counts: RepairChangeCounts;
  readonly samples: RepairChangeSamples;
  readonly localChange: LocalRepairChange | undefined;
  readonly visible: Readonly<Record<ChangeOverlayId, boolean>>;
  readonly previewMode: RepairPreviewMode;
  readonly onToggle: (overlay: ChangeOverlayId, next: boolean) => void;
}): ReactNode {
  const showingAfter = previewMode === RepairPreviewMode.After;

  const descriptors: readonly ChangeOverlayDescriptor[] = [
    {
      id: 'removedDuplicates',
      label: 'Removed duplicate triangles',
      exact: counts.removedDuplicateFaces,
      drawn: samples.removedDuplicateFaces.length,
      availableInView: !showingAfter,
    },
    {
      id: 'removedRepeatedPosition',
      label: 'Removed repeated-position triangles',
      exact: counts.removedRepeatedPositionFaces,
      drawn: samples.removedRepeatedPositionFaces.length,
      availableInView: !showingAfter,
    },
    {
      id: 'removedZeroArea',
      label: 'Removed zero-area triangles',
      exact: counts.removedZeroAreaFaces,
      drawn: samples.removedZeroAreaFaces.length,
      availableInView: !showingAfter,
    },
    {
      id: 'flippedFaces',
      label: 'Reversed triangles',
      exact: counts.flippedFaces + (localChange?.reversedCount ?? 0),
      drawn: samples.flippedFaces.length + (localChange?.reversedSourceFaces.length ?? 0),
      // A flip reorders corners and moves no vertex, so these triangles occupy
      // the same coordinates in both views. The direction marker changes; the
      // highlight does not.
      availableInView: true,
    },
    // REPAIR-CORE-06B: the local repair's own edit, from the exact patch the candidate was built
    // from. Replaced triangles exist only in the current model; added ones only in the candidate.
    {
      id: 'localRemoved',
      label: 'Replaced triangles',
      exact: localChange?.removedCount ?? 0,
      drawn: localChange?.removedSourceFaces.length ?? 0,
      availableInView: !showingAfter,
    },
    {
      id: 'localAdded',
      label: 'Added triangles',
      exact: localChange?.addedCount ?? 0,
      drawn: localChange === undefined ? 0 : localChange.addedPositions.length / 9,
      availableInView: showingAfter,
    },
  ];

  return (
    <>
      <h3 className="panel__subtitle" id="change-overlays-title">
        Highlight changes in the viewport
      </h3>
      <ul
        className="overlays"
        aria-labelledby="change-overlays-title"
        data-testid="change-overlay-controls"
      >
        {descriptors.map((descriptor) => {
          const empty = descriptor.exact === 0;
          const sampling = describeChangeSampling(descriptor.drawn, descriptor.exact);
          return (
            <li className="overlays__row" key={descriptor.id}>
              <label className="overlays__label">
                <input
                  type="checkbox"
                  checked={visible[descriptor.id] && !empty && descriptor.availableInView}
                  disabled={empty || !descriptor.availableInView}
                  onChange={(event) => {
                    onToggle(descriptor.id, event.target.checked);
                  }}
                  data-testid={`change-overlay-toggle-${descriptor.id}`}
                />
                <span
                  className={`overlays__swatch overlays__swatch--${descriptor.id}`}
                  aria-hidden="true"
                />
                <span className="overlays__name">{descriptor.label}</span>
                <span
                  className="overlays__count"
                  data-testid={`change-overlay-count-${descriptor.id}`}
                >
                  {descriptor.exact.toLocaleString()}
                </span>
              </label>
              {sampling === undefined ? null : (
                <p
                  className="overlays__sampling"
                  data-testid={`change-overlay-sampling-${descriptor.id}`}
                >
                  {sampling}
                </p>
              )}
              {descriptor.availableInView ? null : (
                <p
                  className="overlays__sampling"
                  data-testid={`change-overlay-unavailable-${descriptor.id}`}
                >
                  These triangles do not exist in the proposed result. Switch the viewport to Before
                  to see where they are.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {samples.truncated ? (
        <p className="panel__note" data-testid="change-overlay-truncated">
          The viewport draws a bounded sample of the changes. The counts beside each category are
          exact.
        </p>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- utilities -- */

function Fact({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId?: string;
}): ReactNode {
  return (
    <div className="facts__row">
      <dt className="facts__label">{label}</dt>
      <dd className="facts__value" {...(testId === undefined ? {} : { 'data-testid': testId })}>
        {value}
      </dd>
    </div>
  );
}
