import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  REPAIR_ISOLATION_DETAIL,
  describeNoRepairsAvailable,
  presentAcceptance,
} from '../state/repair-presentation';
import {
  ADVANCED_INFO,
  ANALYSIS_CANCELLED_LINE,
  ANALYSIS_FAILED_LINE,
  ANALYZE_MODEL_ACTION,
  APPLY_FAILED_LINE,
  APPLY_REPAIRS_ACTION,
  CANCEL_PREVIEW_ACTION,
  FILE_STRUCTURE_INFO,
  NO_REPAIRABLE_PROBLEMS,
  NO_SAFE_REPAIRS,
  PLAN_FAILED_LINE,
  PREVIEW_FAILED_LINE,
  PREVIEW_READY_LINE,
  REPAIRS_EXHAUSTED_LINE,
  REPAIR_CANCELLED_LINE,
  REPAIR_CANCELLING_LINE,
  REPAIR_MODEL_ACTION,
  REPAIR_UNAVAILABLE_LINE,
  RepairActionKind,
  SUMMARY_INFO,
  deriveRepairOutcome,
  describeAppliedChanges,
  describeFileStructure,
  describeHealthRemaining,
  describeRemaining,
  describeRepairScope,
  describeRepairsExhausted,
} from '../state/repair-workspace-presentation';
import {
  NO_SAFE_CHANGE_CODE,
  REPAIR_APPLYING_LINE,
  REPAIR_CHECKING_MODEL_LINE,
  describeLimitLikely,
} from '../state/repair-preview-summary';
import { useWorkspaceState } from '../state/store-context';
import { totalDefectCount } from '../state/topology-presentation';
import { useRepairWorkspace, type RepairWorkspaceView } from '../state/use-repair-workspace';
import { useAnalysisControls, useRepairControls } from '../state/workflow-controllers';
import { AnalysisState, RepairCandidateState } from '../state/workspace-store';
import { WorkflowId } from '../state/workflows';
import { MeshAnalysisSection } from './MeshAnalysisSection';
import { MeshHealthPanel } from './MeshHealthPanel';
import { OpenBoundaryPanel, OpenBoundaryLimits } from './OpenBoundaryPanel';
import { RepairExclusions, RepairPanel } from './RepairPanel';
import {
  ActionFooter,
  ActionFooterLine,
  OutcomeAlert,
  OutcomeNote,
  WorkspaceOutcome,
} from './shell/action-footer';
import { Icon } from './shell/Icon';
import { InfoButton, InfoPanel, useInfoDisclosure, type InfoDisclosure } from './shell/info';
import { PanelSection } from './shell/primitives';

/**
 * THE REPAIR WORKSPACE — REPAIR-UX-01.
 *
 * Answers three questions by default and nothing else: what is wrong (the
 * health line and Detected issues), what Pybrix can repair (each row's
 * fixability line and Repair options), and what to click (the one primary
 * action in the sticky footer). Explanations sit behind ⓘ buttons; the full
 * report is in Advanced diagnostics, collapsed.
 *
 * THE FOOTER'S PRIMARY ACTION NEVER MOVES. It reads Analyze model, Repair
 * model or Apply repairs depending on the state, and when nothing safe can
 * run it is still there, disabled, with the reason beside it — a hidden
 * button reads as a missing feature.
 *
 * THE FOOTER IS THE SHARED BOUNDED ACTION REGION (WORKSPACE-UX-03): the action
 * row and one line. The applied result and its Undo, the full text of a
 * failure and the explanation behind the reason's ⓘ are scrolling content.
 *
 * NOTHING HERE COMMITS. Repair model builds and validates a candidate through
 * the existing transactional workflow; Apply repairs asks the worker, which
 * re-checks every guard; Discard preview discards; Undo restores the retained
 * mesh. The panels stay mounted while hidden, because their hooks own worker
 * operations.
 */
export function RepairWorkspace(): ReactNode {
  const { model } = useWorkspaceState();
  const view = useRepairWorkspace();
  /*
   * OWNED HERE, because the ⓘ is in the footer and what it opens is not: an
   * explanation inside the pinned region is how the region outgrew the panel.
   */
  const reasonInfo = useInfoDisclosure();

  return (
    <div className="convert-workspace repair-workspace" data-testid="repair-workspace">
      <div className="convert-workspace__sections">
        {model === undefined ? null : <RepairOverview view={view} />}
        <MeshAnalysisSection />
        <RepairPanel />
        <OpenBoundaryPanel />
        {model === undefined ? null : (
          <PanelSection
            title="Advanced diagnostics"
            testId="advanced-diagnostics"
            defaultOpen={false}
            info={ADVANCED_INFO}
          >
            <MeshHealthPanel />
            <div className="panel" data-testid="advanced-limits">
              <RepairExclusions />
              <OpenBoundaryLimits />
            </div>
          </PanelSection>
        )}
        <RepairOutcome view={view} reasonInfo={reasonInfo} />
      </div>
      <RepairFooter view={view} reasonInfo={reasonInfo} />
    </div>
  );
}

/* ------------------------------------------------------------- overview -- */

/**
 * The health line: how many issue TYPES were found, what the checks do not
 * cover, and that the file itself parsed — stated so that "file structure
 * valid" can never be read as "this mesh has no problems".
 */
function RepairOverview({ view }: { readonly view: RepairWorkspaceView }): ReactNode {
  const { model, selectedWorkflow } = useWorkspaceState();
  const applied = useCurrentAppliedRepair();
  const summaryInfo = useInfoDisclosure();
  const fileInfo = useInfoDisclosure();
  const headingRef = useRef<HTMLParagraphElement>(null);
  const { summary } = view.navigation;

  /*
   * Moves focus here when the workspace is chosen from the navigation, so the
   * navigation button does something real for a keyboard or screen-reader user
   * instead of only highlighting itself.
   */
  useEffect(() => {
    if (selectedWorkflow !== WorkflowId.Repair) return;
    headingRef.current?.focus();
  }, [selectedWorkflow]);

  if (model === undefined) return null;

  return (
    <div className="repair-overview" data-testid="repair-overview">
      <div className="repair-overview__line">
        <p
          className="repair-overview__label"
          tabIndex={-1}
          ref={headingRef}
          data-testid="repair-heading"
        >
          Health
        </p>
        <span
          className={`health-summary health-summary--${summary.tone}`}
          data-testid="health-summary"
        >
          {/* THE SAME AUTHORITATIVE COUNTS, with one word saying they are what
              is LEFT — only while the repair that left them is the current
              state. Never a different colour because a repair ran. */}
          {applied !== undefined && view.reportIsCurrent && summary.errors + summary.warnings > 0
            ? describeHealthRemaining(summary.text)
            : summary.text}
        </span>
        <InfoButton
          disclosure={summaryInfo}
          label="the health summary"
          testId="health-summary-info"
        />
      </div>
      <InfoPanel disclosure={summaryInfo} label="the health summary" info={SUMMARY_INFO} />
      {summary.tone === 'neutral' ? null : (
        <p className="repair-overview__qualifier" data-testid="mesh-analysis-qualifier">
          {summary.qualifier}
        </p>
      )}
      <div className="repair-overview__line">
        <p className="repair-overview__file" data-testid="file-structure">
          <Icon name={model.validation.valid ? 'ok' : 'error'} size={13} />
          {describeFileStructure(model.validation.valid)}
        </p>
        <InfoButton disclosure={fileInfo} label="file structure" testId="file-structure-info" />
      </div>
      <InfoPanel disclosure={fileInfo} label="file structure" info={FILE_STRUCTURE_INFO} />
    </div>
  );
}

/* -------------------------------------------------------- applied repair -- */

/**
 * The applied repair, ONLY WHILE IT DESCRIBES WHAT IS ON SCREEN: this document,
 * this revision, this part. Undo, a replacement model, another edit or a switch
 * of part each move one of the three, and every "after the repair" wording —
 * the Health suffix, the disabled reason, the announcement — goes with it.
 * Derived on every render; nothing remembers that a repair once ran.
 */
function useCurrentAppliedRepair(): ReturnType<typeof useWorkspaceState>['repair']['lastApplied'] {
  const { model, activePartId, repair } = useWorkspaceState();
  const applied = repair.lastApplied;
  return model !== undefined &&
    applied?.handle.documentId === model.handle.documentId &&
    applied.handle.revision === model.handle.revision &&
    applied.partId === activePartId
    ? applied
    : undefined;
}

/* -------------------------------------------------------------- outcome -- */

/** What went wrong, if anything did, as the footer and the content both read it. */
function repairFailures(
  action: RepairActionKind,
  analysis: ReturnType<typeof useWorkspaceState>['analysis'],
  repair: ReturnType<typeof useWorkspaceState>['repair'],
): {
  readonly analysis: string | undefined;
  readonly plan: string | undefined;
  readonly candidate: string | undefined;
  /** A NEUTRAL result — Pybrix looked and found nothing safe to change. Not a failure. */
  readonly notice: string | undefined;
  readonly commit: string | undefined;
} {
  // 'fill-refused' predates 06B and is the same kind of result: a decision, not a fault.
  const neutral =
    repair.candidateState === RepairCandidateState.Failed &&
    (repair.candidateError?.code === NO_SAFE_CHANGE_CODE ||
      repair.candidateError?.code === 'fill-refused');
  return {
    analysis:
      analysis.state === AnalysisState.Failed && analysis.error !== undefined
        ? analysis.error.message
        : undefined,
    plan:
      action === RepairActionKind.PlanFailed && repair.planError !== undefined
        ? repair.planError.message
        : undefined,
    candidate:
      !neutral &&
      repair.candidateState === RepairCandidateState.Failed &&
      repair.candidateError !== undefined
        ? repair.candidateError.message
        : undefined,
    notice: neutral ? repair.candidateError.message : undefined,
    commit: repair.commitError?.message,
  };
}

/**
 * The end of the scrolling content, directly above the action region: every
 * failure in full, and the explanation behind the footer's ⓘ. Each failure is
 * said once as an alert here and once, as a headline, beside the action.
 */
function RepairOutcome({
  view,
  reasonInfo,
}: {
  readonly view: RepairWorkspaceView;
  readonly reasonInfo: InfoDisclosure;
}): ReactNode {
  const { analysis, repair } = useWorkspaceState();
  const { action } = view;
  const failures = repairFailures(action, analysis, repair);
  const report = view.reportIsCurrent ? analysis.report : undefined;
  const limitAdvisory = describeLimitLikely(view.currentLocal);
  const applied = useCurrentAppliedRepair();
  const exhausted = applied !== undefined && action === RepairActionKind.NothingSafe;
  const explains =
    action === RepairActionKind.NothingSafe ||
    action === RepairActionKind.NothingFound ||
    action === RepairActionKind.Unavailable;
  // Nothing left to explain — the state moved on — so nothing stays open.
  const { open, close } = reasonInfo;
  useEffect(() => {
    if (open && !explains) close();
  }, [open, explains, close]);
  const shown = [
    failures.analysis,
    failures.plan,
    failures.candidate,
    failures.notice,
    failures.commit,
  ]
    .filter((message) => message !== undefined)
    .join('|');
  const revealKey = `${shown}${open && explains ? '|reason' : ''}`;

  return (
    <WorkspaceOutcome revealKey={revealKey === '' ? undefined : revealKey}>
      {failures.analysis === undefined ? null : (
        <OutcomeAlert testId="analysis-error">
          {failures.analysis} The model is still loaded and can be viewed and exported.
        </OutcomeAlert>
      )}
      {failures.plan === undefined ? null : (
        <OutcomeAlert testId="repair-plan-error">
          {failures.plan} Your model is unchanged.
        </OutcomeAlert>
      )}
      {failures.candidate === undefined ? null : (
        <OutcomeAlert testId="repair-candidate-error">{failures.candidate}</OutcomeAlert>
      )}
      {failures.notice === undefined ? null : (
        <OutcomeNote testId="repair-no-safe-change">{failures.notice}</OutcomeNote>
      )}
      {/* ADVISORY ONLY: it never disables Repair and never predicts the outcome. */}
      {action === RepairActionKind.Ready && limitAdvisory !== undefined ? (
        <p className="repair-advisory" data-testid="repair-limit-advisory">
          {limitAdvisory}
        </p>
      ) : null}
      {failures.commit === undefined ? null : (
        <OutcomeAlert testId="repair-commit-error">{failures.commit}</OutcomeAlert>
      )}
      {action === RepairActionKind.Unavailable ? (
        <InfoPanel disclosure={reasonInfo} label="repair availability">
          <p className="info-panel__text">{REPAIR_ISOLATION_DETAIL}</p>
        </InfoPanel>
      ) : (
        <InfoPanel disclosure={reasonInfo} label="automatic repair">
          <p className="info-panel__text" data-testid="repair-no-repairs-detail">
            {exhausted
              ? describeRepairsExhausted(describeRemaining(view.navigation.issues))
              : describeNoRepairsAvailable(
                  report === undefined ? false : totalDefectCount(report) > 0,
                )}
          </p>
        </InfoPanel>
      )}
    </WorkspaceOutcome>
  );
}

/* --------------------------------------------------------------- footer -- */

/**
 * The sticky action area. One primary control, in one place, in every state,
 * and ONE LINE beside it: progress while something runs, else the headline of
 * a failure, else the state, else what the action will do or why it cannot.
 */
function RepairFooter({
  view,
  reasonInfo,
}: {
  readonly view: RepairWorkspaceView;
  readonly reasonInfo: InfoDisclosure;
}): ReactNode {
  const { analysis, repair } = useWorkspaceState();
  const analysisControls = useAnalysisControls();
  const controls = useRepairControls();
  const hintId = useId();
  const { action, scope } = view;

  const analysisPercent = Math.round(analysis.fraction * 100);
  const candidate = repair.candidate;
  const previewable =
    candidate !== undefined &&
    presentAcceptance(candidate.validation.acceptance, candidate.validation.regressions)
      .previewable;
  const failures = repairFailures(action, analysis, repair);
  const cancelling = repair.candidateState === RepairCandidateState.Cancelling;
  const applied = useCurrentAppliedRepair();
  /*
   * ONE SENTENCE, ONCE — REPAIR-UX-04. The outcome is announced here, when the
   * analysis of the repaired mesh has settled what it is: "Partial repair
   * completed. 2 openings filled. Some detected issues remain." Nothing is
   * announced while it is still being checked, so a screen reader never hears
   * a bare "applied" followed by a separate list of errors.
   */
  const settled =
    action === RepairActionKind.Ready ||
    action === RepairActionKind.NothingSafe ||
    action === RepairActionKind.NothingFound;
  const announcement =
    applied === undefined || !settled || !view.reportIsCurrent
      ? undefined
      : deriveRepairOutcome({
          changes: describeAppliedChanges(applied.counts, applied.filledOpenings, {
            repaired: applied.localRepaired ?? 0,
            reversed: applied.localReversed ?? 0,
          }),
          remainingTypes: view.detectedIssueTypes,
          exhausted: action === RepairActionKind.NothingSafe,
        }).announcement;

  /* WORKING: the phase is the worker's own, and it outranks everything. */
  const working = ((): ReactNode => {
    switch (action) {
      case RepairActionKind.Analyzing:
        return (
          <div className="repair-footer__progress" data-testid="analysis-progress">
            <div className="convert-footer__progress-row">
              <span data-testid="analysis-phase">
                {applied === undefined
                  ? (analysis.phase ?? 'Analyzing the mesh')
                  : REPAIR_CHECKING_MODEL_LINE}
              </span>
              <span data-testid="analysis-percent">{analysisPercent}%</span>
            </div>
            <progress
              className="import__bar"
              max={100}
              value={analysisPercent}
              aria-label={`Mesh analysis progress: ${String(analysisPercent)}%`}
            />
          </div>
        );
      case RepairActionKind.Building:
        // ONE LINE: once a cancel is signalled the bar has nothing left to say.
        return cancelling ? (
          <ActionFooterLine testId="repair-cancelling">{REPAIR_CANCELLING_LINE}</ActionFooterLine>
        ) : (
          <div className="repair-footer__progress" data-testid="repair-progress">
            {/* HONEST STAGES, NO PERCENTAGE: the engine does not know how much work remains,
                so an indeterminate bar and the stage in words say exactly what is known. */}
            <div className="convert-footer__progress-row">
              <span data-testid="repair-phase">{repair.phase ?? 'Building a safe repair'}</span>
            </div>
            <progress className="import__bar" aria-label="Repair in progress" />
          </div>
        );
      case RepairActionKind.Applying:
        return (
          <div className="repair-footer__progress" data-testid="repair-commit-progress">
            <div className="convert-footer__progress-row">
              <span data-testid="repair-commit-phase">{REPAIR_APPLYING_LINE}</span>
            </div>
            <progress className="import__bar" aria-label="Applying repairs" />
          </div>
        );
      case RepairActionKind.Undoing:
        return <ActionFooterLine>Undoing repair…</ActionFooterLine>;
      case RepairActionKind.Planning:
        return (
          <ActionFooterLine testId="repair-planning">
            Working out what Pybrix can repair…
          </ActionFooterLine>
        );
      case RepairActionKind.Preview:
      case RepairActionKind.NoModel:
      case RepairActionKind.Unavailable:
      case RepairActionKind.Analyze:
      case RepairActionKind.PlanFailed:
      case RepairActionKind.Ready:
      case RepairActionKind.NothingSafe:
      case RepairActionKind.NothingFound:
        return undefined;
    }
  })();

  const failureLine =
    failures.analysis !== undefined
      ? ANALYSIS_FAILED_LINE
      : failures.plan !== undefined
        ? PLAN_FAILED_LINE
        : failures.candidate !== undefined
          ? PREVIEW_FAILED_LINE
          : failures.commit !== undefined
            ? APPLY_FAILED_LINE
            : undefined;

  const stateLine =
    action === RepairActionKind.Preview ? (
      <ActionFooterLine testId="repair-preview-ready" title={PREVIEW_READY_LINE}>
        {PREVIEW_READY_LINE}
      </ActionFooterLine>
    ) : failures.notice !== undefined ? (
      <ActionFooterLine testId="repair-no-safe-change-line">
        Nothing was changed — details above
      </ActionFooterLine>
    ) : repair.candidateState === RepairCandidateState.Cancelled ? (
      <ActionFooterLine testId="repair-cancelled">{REPAIR_CANCELLED_LINE}</ActionFooterLine>
    ) : analysis.state === AnalysisState.Cancelled && action === RepairActionKind.Analyze ? (
      <ActionFooterLine testId="analysis-cancelled">{ANALYSIS_CANCELLED_LINE}</ActionFooterLine>
    ) : undefined;

  const line =
    working ??
    (failureLine === undefined ? undefined : (
      <ActionFooterLine tone="failure" testId="repair-failure-line">
        {failureLine}
      </ActionFooterLine>
    )) ??
    stateLine;

  return (
    <ActionFooter testId="repair-footer" className="repair-footer">
      <div className="convert-footer__status" aria-live="polite">
        {line}
      </div>

      {/* The result card in the content shows the outcome; this says it, once,
          to assistive technology. ITS OWN REGION, out of the layout: inside the
          status slot it kept that slot from collapsing, and the 8 px it took
          clipped the second line of the reason beneath the action. */}
      <div className="visually-hidden" aria-live="polite">
        {announcement === undefined ? null : (
          <p data-testid="repair-applied-status">{announcement}</p>
        )}
      </div>

      <div className="convert-footer__actions">
        {action === RepairActionKind.Analyzing ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={analysisControls.cancelAnalysis}
            data-testid="cancel-analysis"
          >
            Cancel
          </button>
        ) : null}
        {action === RepairActionKind.Building ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={controls.cancelPreview}
            // Disabled once cancellation is signalled: a second press cannot
            // make the worker unwind sooner.
            disabled={cancelling}
            data-testid="cancel-repair"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}
        {action === RepairActionKind.PlanFailed && repair.planError?.retryable === true ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={controls.replan}
            data-testid="repair-replan"
          >
            Try again
          </button>
        ) : null}
        {action === RepairActionKind.Preview || action === RepairActionKind.Applying ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={controls.discardPreview}
            disabled={action === RepairActionKind.Applying}
            data-testid="discard-preview"
          >
            {CANCEL_PREVIEW_ACTION}
          </button>
        ) : null}
        <PrimaryAction
          view={view}
          previewable={previewable}
          canAnalyze={analysisControls.canRetry}
          onAnalyze={analysisControls.runAnalysis}
          onRepair={controls.previewRepair}
          onApply={controls.applyRepair}
          hintId={hintId}
        />
      </div>

      <FooterHint
        action={action}
        hintId={hintId}
        describeScope={describeRepairScope(scope)}
        reasonInfo={reasonInfo}
        exhausted={applied !== undefined}
        // ONE LINE AT A TIME: with another line on screen the reason still
        // describes the action, to assistive technology.
        spoken={line !== undefined}
      />
    </ActionFooter>
  );
}

function PrimaryAction({
  view,
  previewable,
  canAnalyze,
  onAnalyze,
  onRepair,
  onApply,
  hintId,
}: {
  readonly view: RepairWorkspaceView;
  readonly previewable: boolean;
  readonly canAnalyze: boolean;
  readonly onAnalyze: () => void;
  readonly onRepair: () => void;
  readonly onApply: () => void;
  readonly hintId: string;
}): ReactNode {
  const { action } = view;

  if (action === RepairActionKind.Analyze || action === RepairActionKind.Analyzing) {
    const analyzing = action === RepairActionKind.Analyzing;
    return (
      <button
        type="button"
        className="primary-action convert-footer__primary"
        onClick={onAnalyze}
        disabled={analyzing || !canAnalyze}
        aria-busy={analyzing}
        aria-describedby={hintId}
        data-testid="analyze-mesh"
      >
        <Icon name={analyzing ? 'loader' : 'scan'} size={16} className={analyzing ? 'spin' : ''} />
        <span>{analyzing ? 'Analyzing…' : ANALYZE_MODEL_ACTION}</span>
      </button>
    );
  }

  if (action === RepairActionKind.Preview || action === RepairActionKind.Applying) {
    const applying = action === RepairActionKind.Applying;
    return (
      <button
        type="button"
        className="primary-action convert-footer__primary"
        onClick={onApply}
        disabled={applying || !previewable}
        aria-busy={applying}
        aria-describedby={hintId}
        data-testid="apply-repair"
      >
        <Icon name="ok" size={16} />
        <span>{applying ? 'Applying…' : APPLY_REPAIRS_ACTION}</span>
      </button>
    );
  }

  // Every other state shows Repair model, enabled only when a current plan has
  // something selected and applicable to do.
  const building = action === RepairActionKind.Building;
  return (
    <button
      type="button"
      className="primary-action convert-footer__primary"
      onClick={onRepair}
      disabled={action !== RepairActionKind.Ready}
      aria-busy={building}
      aria-describedby={hintId}
      data-testid="preview-repair"
    >
      <Icon name={building ? 'loader' : 'zap'} size={16} className={building ? 'spin' : ''} />
      <span>{building ? 'Preparing preview…' : REPAIR_MODEL_ACTION}</span>
    </button>
  );
}

/**
 * The one line beneath the action: what pressing it will do, or why it is
 * disabled. The longer "why" is one ⓘ away, and opens in the scrolling content.
 *
 * `spoken` means another line already occupies the region: the text is then
 * kept as the action's accessible description and not drawn.
 */
function FooterHint({
  action,
  hintId,
  describeScope,
  reasonInfo,
  exhausted,
  spoken,
}: {
  readonly action: RepairActionKind;
  readonly hintId: string;
  readonly describeScope: string;
  readonly reasonInfo: InfoDisclosure;
  /** A repair was just applied to this revision: what is left has no safe fix. */
  readonly exhausted: boolean;
  readonly spoken: boolean;
}): ReactNode {
  const text = ((): { readonly text: string; readonly testId?: string } | undefined => {
    switch (action) {
      case RepairActionKind.Ready:
        return { text: describeScope, testId: 'repair-scope' };
      case RepairActionKind.NothingSafe:
        return {
          text: exhausted ? REPAIRS_EXHAUSTED_LINE : NO_SAFE_REPAIRS,
          testId: 'repair-no-repairs',
        };
      case RepairActionKind.NothingFound:
        return { text: NO_REPAIRABLE_PROBLEMS, testId: 'repair-no-repairs' };
      case RepairActionKind.Unavailable:
        return { text: REPAIR_UNAVAILABLE_LINE, testId: 'repair-action-unavailable' };
      case RepairActionKind.Analyze:
        return { text: 'Pybrix checks the mesh before it can repair it.' };
      case RepairActionKind.Preview:
        return { text: 'Apply replaces the model with the validated preview. You can undo it.' };
      case RepairActionKind.NoModel:
      case RepairActionKind.Analyzing:
      case RepairActionKind.Planning:
      case RepairActionKind.PlanFailed:
      case RepairActionKind.Building:
      case RepairActionKind.Applying:
      case RepairActionKind.Undoing:
        return undefined;
    }
  })();

  if (text === undefined) return <span id={hintId} hidden />;
  const testId = text.testId === undefined ? {} : { 'data-testid': text.testId };
  if (spoken) {
    return (
      <p className="visually-hidden" id={hintId} {...testId}>
        {text.text}
      </p>
    );
  }
  const explained =
    action === RepairActionKind.NothingSafe ||
    action === RepairActionKind.NothingFound ||
    action === RepairActionKind.Unavailable;
  const hint = (
    <p className="convert-footer__hint" id={hintId} title={text.text} {...testId}>
      {text.text}
    </p>
  );
  if (!explained) return hint;
  return (
    <div className="repair-footer__reason">
      {hint}
      <InfoButton
        disclosure={reasonInfo}
        label={action === RepairActionKind.Unavailable ? 'repair availability' : 'automatic repair'}
        {...(action === RepairActionKind.Unavailable ? {} : { testId: 'repair-no-repairs-info' })}
      />
    </div>
  );
}
