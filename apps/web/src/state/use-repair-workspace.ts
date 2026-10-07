import { useMemo } from 'react';
import {
  fillableOpeningCount,
  type BoundaryFillPlan,
  type ConservativeRepairPlan,
  type LocalRepairPlan,
} from '@cadfixer/geometry-runtime';
import { SelfIntersectionBand } from '@cadfixer/mesh-self-intersection';
import { isInterruptibleRepairSupported } from '../runtime/cancellation-support';
import { IssueSeverity, type RepairIssue, type RepairIssueId } from './repair-issues';
import {
  deriveIssueStatus,
  deriveRepairAction,
  deriveRepairScope,
  type IssueStatus,
  type RepairActionKind,
  type RepairScope,
} from './repair-workspace-presentation';
import { useWorkspaceState } from './store-context';
import { useIssueNavigation, type IssueNavigation } from './use-issue-navigation';
import { useAnalysisControls } from './workflow-controllers';
import { AnalysisState, RepairPlanState } from './workspace-store';

/**
 * The Repair workspace's one derived view — REPAIR-UX-01.
 *
 * Reads the store and the shared issue navigation and hands the workspace
 * everything it shows by default: the rows, what Pybrix can do about each, and
 * the single primary action. PURE DERIVATION: it starts nothing and holds
 * nothing, so the footer, the issue list and the option list read one answer.
 */
export interface RepairWorkspaceView {
  readonly navigation: IssueNavigation;
  readonly statuses: ReadonlyMap<RepairIssueId, IssueStatus>;
  readonly scope: RepairScope;
  readonly action: RepairActionKind;
  /** A report exists for the current revision and active part. */
  readonly reportIsCurrent: boolean;
  /** The plan, only when it was derived for the current revision and part. */
  readonly currentPlan: ConservativeRepairPlan | undefined;
  /** The fill plan that belongs to `currentPlan`, when filling is selected. */
  readonly currentFill: BoundaryFillPlan | undefined;
  /** The local repair plan that belongs to `currentPlan`. */
  readonly currentLocal: LocalRepairPlan | undefined;
  /** Openings Repair model would attempt: admitted, and filling selected. */
  readonly fillableOpenings: number;
  /** Issue types currently detected (errors and warnings). */
  readonly detectedIssueTypes: number;
}

export function useRepairWorkspace(): RepairWorkspaceView {
  const state = useWorkspaceState();
  const { isAnalyzing } = useAnalysisControls();
  const navigation = useIssueNavigation();
  const { model, activePartId, analysis, repair, selfIntersection } = state;

  const reportIsCurrent =
    analysis.state === AnalysisState.Ready &&
    analysis.report !== undefined &&
    model !== undefined &&
    analysis.handle?.documentId === model.handle.documentId &&
    analysis.handle.revision === model.handle.revision &&
    // Two parts share a revision, so a report of another part is not current.
    analysis.partId === activePartId;

  const plan = repair.plan;
  const currentPlan =
    reportIsCurrent &&
    repair.planState === RepairPlanState.Ready &&
    plan?.documentId === model.handle.documentId &&
    plan.sourceRevision === model.handle.revision &&
    plan.partId === activePartId
      ? plan
      : undefined;

  const currentFill = currentPlan === undefined ? undefined : repair.fillPlan;
  const currentLocal = currentPlan === undefined ? undefined : repair.localPlan;
  const fillableOpenings = repair.fillOpenings ? fillableOpeningCount(currentFill) : 0;

  const report = reportIsCurrent ? analysis.report : undefined;
  const partFaceCount =
    model?.parts.find((part) => part.partId === activePartId)?.triangleCount ??
    model?.triangleCount ??
    0;

  const statuses = useMemo(() => {
    const map = new Map<RepairIssueId, IssueStatus>();
    for (const issue of navigation.issues) {
      map.set(
        issue.id,
        deriveIssueStatus(issue, {
          plan: currentPlan,
          boundaries: {
            simpleLoops: report?.simpleBoundaryLoopCount ?? 0,
            openChains: report?.openBoundaryChainCount ?? 0,
            branched: report?.branchedBoundaryCount ?? 0,
          },
          partFaceCount,
          selfIntersectionSizeLimited: selfIntersection.band === SelfIntersectionBand.SizeLimit,
          fillSelected: repair.fillOpenings,
          fill: currentFill,
          localRepair: currentLocal,
        }),
      );
    }
    return map;
  }, [
    currentFill,
    currentLocal,
    currentPlan,
    navigation.issues,
    partFaceCount,
    repair.fillOpenings,
    report,
    selfIntersection.band,
  ]);

  const scope = useMemo(
    () => deriveRepairScope(navigation.issues, statuses, fillableOpenings),
    [fillableOpenings, navigation.issues, statuses],
  );
  const detectedIssueTypes = countDetected(navigation.issues);

  const action = deriveRepairAction({
    hasModel: model !== undefined,
    isolationSupported: isInterruptibleRepairSupported(),
    reportIsCurrent,
    isAnalyzing,
    planState: repair.planState,
    planNoOp: currentPlan?.noOp,
    fillableOpenings,
    localEligible: currentLocal?.eligible ?? 0,
    candidateState: repair.candidateState,
    commitState: repair.commitState,
    detectedIssueTypes,
  });

  return {
    navigation,
    statuses,
    scope,
    action,
    reportIsCurrent,
    currentPlan,
    currentFill,
    currentLocal,
    fillableOpenings,
    detectedIssueTypes,
  };
}

function countDetected(issues: readonly RepairIssue[]): number {
  return issues.filter(
    (issue) => issue.severity === IssueSeverity.Error || issue.severity === IssueSeverity.Warning,
  ).length;
}
