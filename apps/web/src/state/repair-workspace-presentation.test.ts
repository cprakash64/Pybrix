import { describe, expect, it } from 'vitest';
import {
  BoundaryFillScanStatus,
  fillableOpeningCount,
  RepairDecision,
  RepairOperation,
  RepairReason,
  type BoundaryFillPlan,
  type ConservativeRepairPlan,
  type LocalRepairPlan,
  type RepairOperationDecision,
} from '@cadfixer/geometry-runtime';
import { IssueSeverity, RepairIssueId, type RepairIssue } from './repair-issues';
import {
  ADVANCED_INFO,
  FILE_STRUCTURE_INFO,
  Fixability,
  HOLE_FILL_SIZE_LIMIT_LINE,
  ISSUE_INFO,
  NO_REPAIRABLE_PROBLEMS,
  NO_SAFE_REPAIRS,
  PREVIEW_READY_LINE,
  REPAIRS_EXHAUSTED_LINE,
  REPAIR_CHECKING_REMAINING,
  REPAIR_FIXED_LABEL,
  REPAIR_MODEL_ACTION,
  REPAIR_MODEL_SUPPORT,
  REPAIR_OPTIONS_INFO,
  REPAIR_OPTION_LABELS,
  REPAIR_REMAINING_LABEL,
  REPAIR_UNAVAILABLE_LINE,
  REPAIR_WORKSPACE_FORBIDDEN_TERMS,
  RepairActionKind,
  RepairOutcomeKind,
  SUMMARY_INFO,
  deriveIssueStatus,
  deriveRepairAction,
  deriveRepairOutcome,
  deriveRepairScope,
  describeAppliedActivity,
  describeAppliedChanges,
  describeFileStructure,
  describeHealthRemaining,
  describeFillOptionStatus,
  describeOptionStatus,
  describeRemaining,
  describeRemainingIssue,
  describeRepairsExhausted,
  remainingIssues,
  describeRepairScope,
  type IssueStatus,
  type IssueStatusContext,
  type RepairActionInput,
} from './repair-workspace-presentation';

/* ---------------------------------------------------------------- helpers -- */

function issue(
  id: RepairIssueId,
  count: number | undefined,
  severity?: IssueSeverity,
): RepairIssue {
  return {
    id,
    label: id,
    help: '',
    severity:
      severity ??
      (count === undefined
        ? IssueSeverity.Unchecked
        : count === 0
          ? IssueSeverity.Ok
          : IssueSeverity.Warning),
    count,
    unit: ['thing', 'things'],
    occurrenceSource: 'none',
    occurrenceCount: 0,
    occurrencesPartial: false,
  };
}

function decision(
  operation: RepairOperation,
  overrides: Partial<RepairOperationDecision> = {},
): RepairOperationDecision {
  return {
    operation,
    decision: RepairDecision.NotNeeded,
    reason: RepairReason.NoDefectPresent,
    targetedCount: 0,
    expectedFaceMutations: 0,
    ...overrides,
  };
}

function plan(decisions: readonly RepairOperationDecision[]): ConservativeRepairPlan {
  const all = [
    RepairOperation.RemoveDuplicateFaces,
    RepairOperation.RemoveRepeatedPositionFaces,
    RepairOperation.RemoveZeroAreaFaces,
    RepairOperation.UnifyWinding,
  ].map(
    (operation) => decisions.find((entry) => entry.operation === operation) ?? decision(operation),
  );
  return {
    schemaVersion: 1,
    documentId: 'model-1',
    partId: 'part-1',
    sourceRevision: 1,
    reportVersion: 1,
    requested: [],
    order: [],
    decisions: all,
    memory: {
      candidateBytes: 0,
      workspaceBytes: 0,
      validationBytes: 0,
      undoRetainedBytes: 0,
      peakBytes: 0,
    },
    warnings: [],
    planHash: 'hash',
    noOp: !all.some((entry) => entry.decision === RepairDecision.Applicable),
  };
}

function context(overrides: Partial<IssueStatusContext> = {}): IssueStatusContext {
  return {
    plan: plan([]),
    boundaries: { simpleLoops: 0, openChains: 0, branched: 0 },
    partFaceCount: 1_000,
    selfIntersectionSizeLimited: false,
    fillSelected: true,
    fill: undefined,
    ...overrides,
  };
}

function fillPlan(admitted: number, verified = true): BoundaryFillPlan {
  return {
    status: BoundaryFillScanStatus.Scanned,
    boundaryEdgeCount: 40,
    simpleLoopCount: 6,
    complexBoundaryCount: 7,
    admittedCount: admitted,
    admittedPatchFaces: admitted * 2,
    loops: [],
    loopsTruncated: false,
    verified,
    planHash: 'bf-test',
  };
}

function action(overrides: Partial<RepairActionInput> = {}): RepairActionKind {
  return deriveRepairAction({
    hasModel: true,
    isolationSupported: true,
    reportIsCurrent: true,
    isAnalyzing: false,
    planState: 'ready',
    planNoOp: false,
    fillableOpenings: 0,
    candidateState: 'idle',
    commitState: 'idle',
    detectedIssueTypes: 1,
    ...overrides,
  });
}

/* ------------------------------------------------------ CTA state machine -- */

describe('the primary action state machine', () => {
  it('asks for an analysis before anything can be repaired (state A)', () => {
    expect(action({ reportIsCurrent: false, planState: 'unavailable', planNoOp: undefined })).toBe(
      RepairActionKind.Analyze,
    );
    expect(action({ isAnalyzing: true, reportIsCurrent: false })).toBe(RepairActionKind.Analyzing);
  });

  it('offers Repair model only for a current plan with applicable work (state B)', () => {
    expect(action()).toBe(RepairActionKind.Ready);
    expect(action({ planState: 'planning', planNoOp: undefined })).toBe(RepairActionKind.Planning);
    // A plan object without a current noOp answer is not a plan to act on.
    expect(action({ planNoOp: undefined })).toBe(RepairActionKind.Planning);
    expect(action({ planState: 'failed' })).toBe(RepairActionKind.PlanFailed);
  });

  it('turns into Apply once a validated preview exists (state C), and outranks planning', () => {
    expect(action({ candidateState: 'ready' })).toBe(RepairActionKind.Preview);
    expect(action({ candidateState: 'ready', planState: 'planning' })).toBe(
      RepairActionKind.Preview,
    );
    expect(action({ candidateState: 'building' })).toBe(RepairActionKind.Building);
    expect(action({ candidateState: 'cancelling' })).toBe(RepairActionKind.Building);
  });

  it('reports commits in flight above everything else', () => {
    expect(action({ candidateState: 'ready', commitState: 'applying' })).toBe(
      RepairActionKind.Applying,
    );
    expect(action({ commitState: 'undoing' })).toBe(RepairActionKind.Undoing);
  });

  it('distinguishes "nothing safe" from "nothing found" (state E)', () => {
    expect(action({ planNoOp: true, detectedIssueTypes: 3 })).toBe(RepairActionKind.NothingSafe);
    expect(action({ planNoOp: true, detectedIssueTypes: 0 })).toBe(RepairActionKind.NothingFound);
  });

  it('fails closed without a model or an interruptible context', () => {
    expect(action({ hasModel: false })).toBe(RepairActionKind.NoModel);
    expect(action({ isolationSupported: false, candidateState: 'ready' })).toBe(
      RepairActionKind.Unavailable,
    );
  });

  it('never lets an in-flight analysis hide a stale report behind Repair model', () => {
    // A stale report with a plan still in the store must not enable the action.
    expect(action({ reportIsCurrent: false, planState: 'ready', planNoOp: false })).toBe(
      RepairActionKind.Analyze,
    );
  });
});

/* ------------------------------------------------------------ fixability -- */

describe('issue fixability', () => {
  it('says "Not checked" rather than zero, and names the size limit for self-intersections', () => {
    expect(deriveIssueStatus(issue(RepairIssueId.SelfIntersections, undefined), context())).toEqual(
      {
        fixability: Fixability.CheckNotRun,
        text: 'Not checked',
      },
    );
    expect(
      deriveIssueStatus(
        issue(RepairIssueId.SelfIntersections, undefined),
        context({ selfIntersectionSizeLimited: true }),
      ).text,
    ).toBe('Not checked — model exceeds automatic check size');
  });

  it('marks a zero count as no issue, except a single component which is simply one piece', () => {
    expect(deriveIssueStatus(issue(RepairIssueId.NonManifoldEdges, 0), context()).fixability).toBe(
      Fixability.NoIssue,
    );
    expect(deriveIssueStatus(issue(RepairIssueId.Components, 1), context()).fixability).toBe(
      Fixability.NoIssue,
    );
  });

  it('never calls separate components a defect to repair', () => {
    const status = deriveIssueStatus(issue(RepairIssueId.Components, 39), context());
    expect(status.fixability).toBe(Fixability.Review);
    expect(status.text).toMatch(/review recommended/i);
  });

  it('reports non-manifold edges and self-intersections as not automatically repairable', () => {
    for (const id of [RepairIssueId.NonManifoldEdges, RepairIssueId.SelfIntersections]) {
      expect(deriveIssueStatus(issue(id, 155, IssueSeverity.Error), context()).fixability).toBe(
        Fixability.NotRepairable,
      );
    }
  });

  it('reads non-manifold VERTICES from the local repair plan, and says "can attempt" not "will fix" (06B)', () => {
    const row = issue(RepairIssueId.NonManifoldVertices, 10, IssueSeverity.Error);
    const plan = (eligible: number): LocalRepairPlan => ({
      requested: true,
      pinchedVertices: 10,
      eligible,
      unsupportedNonManifoldEdge: 10 - eligible,
      byClass: {},
      workLimit: { primary: 1, residual: 1 },
      estimatedWorkLowerBound: 0,
      limitLikely: false,
      planHash: 'lr-x',
    });
    // A plan that offers no local repair says nothing can be attempted: never a guess.
    expect(deriveIssueStatus(row, context()).fixability).toBe(Fixability.NotRepairable);
    expect(deriveIssueStatus(row, context({ localRepair: plan(10) })).fixability).toBe(
      Fixability.Repairable,
    );
    expect(deriveIssueStatus(row, context({ localRepair: plan(4) })).fixability).toBe(
      Fixability.Partial,
    );
    expect(deriveIssueStatus(row, context({ localRepair: plan(0) })).fixability).toBe(
      Fixability.NotRepairable,
    );
  });

  it('never presents an UNVERIFIED admitted count as fillable (REPAIR-RC-03)', () => {
    // The real model: six admitted, two passed the exact check.
    const open = issue(RepairIssueId.OpenBoundaries, 13);
    const detail = '6 simple loops · 7 complex';
    const boundaries = { simpleLoops: 6, openChains: 0, branched: 7 };
    expect(deriveIssueStatus(open, context({ boundaries, fill: fillPlan(6, false) }))).toEqual({
      fixability: Fixability.NotRepairable,
      text: 'Openings could not be checked',
      detail,
    });
    expect(describeFillOptionStatus(true, fillPlan(6, false))).toBe('Could not check');
    expect(fillableOpeningCount(fillPlan(6, false))).toBe(0);
    // The same plan once verified: only what passed is promised.
    expect(deriveIssueStatus(open, context({ boundaries, fill: fillPlan(2) })).text).toBe(
      '2 fillable · 11 need attention',
    );
    expect(describeFillOptionStatus(true, fillPlan(2))).toBe('2 to fill');
    // Repair model is not enabled by an unverified count alone.
    expect(
      action({ planNoOp: true, fillableOpenings: fillableOpeningCount(fillPlan(6, false)) }),
    ).not.toBe(RepairActionKind.Ready);
  });

  it('reads open boundaries from the worker’s fill plan, never from a count (REPAIR-CORE-02)', () => {
    const boundaries = { simpleLoops: 6, openChains: 2, branched: 5 };
    const open = issue(RepairIssueId.OpenBoundaries, 13);
    const detail = '6 simple loops · 7 complex';

    // Four of thirteen admitted, on a two-million-triangle part: partial, and
    // the part size is no longer what decides.
    expect(
      deriveIssueStatus(open, context({ boundaries, partFaceCount: 1_988_877, fill: fillPlan(4) })),
    ).toEqual({ fixability: Fixability.Partial, text: '4 fillable · 9 need attention', detail });

    // Every opening admitted.
    expect(
      deriveIssueStatus(issue(RepairIssueId.OpenBoundaries, 2), context({ fill: fillPlan(2) })),
    ).toMatchObject({ fixability: Fixability.Repairable, text: '2 fillable openings' });

    // None admitted — e.g. only branched boundaries — is never presented as fillable.
    expect(deriveIssueStatus(open, context({ boundaries, fill: fillPlan(0) })).fixability).toBe(
      Fixability.NotRepairable,
    );

    // The scan refused to assemble loops: a resource limit, stated as such.
    expect(
      deriveIssueStatus(
        open,
        context({
          boundaries,
          fill: { ...fillPlan(0), status: BoundaryFillScanStatus.TooManyBoundaryEdges },
        }),
      ),
    ).toMatchObject({
      fixability: Fixability.ResourceLimit,
      text: 'Too many open edges to check automatically',
    });

    // Filling switched off, and the plan still pending.
    expect(deriveIssueStatus(open, context({ fillSelected: false })).fixability).toBe(
      Fixability.NotSelected,
    );
    expect(deriveIssueStatus(open, context({ fill: undefined })).fixability).toBe(
      Fixability.Pending,
    );
  });

  it('reads repairability from the plan decisions, never from the count alone', () => {
    const degenerate = issue(RepairIssueId.DegenerateFaces, 14);
    const both = context({
      plan: plan([
        decision(RepairOperation.RemoveRepeatedPositionFaces, {
          decision: RepairDecision.Applicable,
          reason: RepairReason.NoDefectPresent,
          targetedCount: 10,
          expectedFaceMutations: 10,
        }),
        decision(RepairOperation.RemoveZeroAreaFaces, {
          decision: RepairDecision.Applicable,
          targetedCount: 4,
          expectedFaceMutations: 4,
        }),
      ]),
    });
    expect(deriveIssueStatus(degenerate, both).fixability).toBe(Fixability.Repairable);

    const oneRefused = context({
      plan: plan([
        decision(RepairOperation.RemoveRepeatedPositionFaces, {
          decision: RepairDecision.Applicable,
          targetedCount: 10,
          expectedFaceMutations: 10,
        }),
        decision(RepairOperation.RemoveZeroAreaFaces, {
          decision: RepairDecision.RefusedUnsafe,
          reason: RepairReason.RemovalIntroducesBoundary,
          targetedCount: 4,
        }),
      ]),
    });
    expect(deriveIssueStatus(degenerate, oneRefused).fixability).toBe(Fixability.Partial);

    const refused = context({
      plan: plan([
        decision(RepairOperation.RemoveZeroAreaFaces, {
          decision: RepairDecision.RefusedUnsafe,
          reason: RepairReason.RemovalIntroducesBoundary,
          targetedCount: 4,
        }),
      ]),
    });
    expect(deriveIssueStatus(degenerate, refused).fixability).toBe(Fixability.NotRepairable);
  });

  it('says a repair is available but not selected when the user deselected it', () => {
    const status = deriveIssueStatus(
      issue(RepairIssueId.WindingConflicts, 3),
      context({
        plan: plan([
          decision(RepairOperation.UnifyWinding, {
            reason: RepairReason.NotRequested,
            targetedCount: 3,
          }),
        ]),
      }),
    );
    expect(status.fixability).toBe(Fixability.NotSelected);
  });

  it('counts a conflict an earlier operation resolves as repairable', () => {
    const status = deriveIssueStatus(
      issue(RepairIssueId.WindingConflicts, 3),
      context({
        plan: plan([
          decision(RepairOperation.UnifyWinding, {
            reason: RepairReason.NoDefectPresent,
            targetedCount: 3,
          }),
        ]),
      }),
    );
    expect(status.fixability).toBe(Fixability.Repairable);
  });

  it('keeps reversed duplicates honest', () => {
    const reversedOnly = deriveIssueStatus(issue(RepairIssueId.DuplicateFaces, 2), context());
    expect(reversedOnly.fixability).toBe(Fixability.NotRepairable);
    expect(reversedOnly.text).toMatch(/kept/);

    const exact = deriveIssueStatus(
      issue(RepairIssueId.DuplicateFaces, 2),
      context({
        plan: plan([
          decision(RepairOperation.RemoveDuplicateFaces, {
            decision: RepairDecision.Applicable,
            targetedCount: 1,
            expectedFaceMutations: 1,
          }),
        ]),
      }),
    );
    expect(exact.fixability).toBe(Fixability.Partial);
  });

  it('says it is still checking while the plan is being worked out', () => {
    expect(
      deriveIssueStatus(issue(RepairIssueId.WindingConflicts, 3), context({ plan: undefined })),
    ).toEqual({ fixability: Fixability.Pending, text: 'Checking…' });
  });
});

/* ------------------------------------------------------------ repair scope -- */

describe('the repair scope line', () => {
  it('counts issue TYPES Repair model acts on, including openings it can fill', () => {
    const issues = [
      issue(RepairIssueId.OpenBoundaries, 13),
      issue(RepairIssueId.NonManifoldVertices, 155, IssueSeverity.Error),
      issue(RepairIssueId.DegenerateFaces, 14),
      issue(RepairIssueId.Components, 39),
      issue(RepairIssueId.DuplicateFaces, 0),
    ];
    const statuses = new Map<RepairIssueId, IssueStatus>([
      [RepairIssueId.OpenBoundaries, { fixability: Fixability.NotRepairable, text: '' }],
      [RepairIssueId.NonManifoldVertices, { fixability: Fixability.NotRepairable, text: '' }],
      [RepairIssueId.DegenerateFaces, { fixability: Fixability.Repairable, text: '' }],
      [RepairIssueId.Components, { fixability: Fixability.Review, text: '' }],
    ]);
    const scope = deriveRepairScope(issues, statuses);
    expect(scope).toEqual({ detected: 4, repairable: 1, openings: 0 });
    expect(describeRepairScope(scope)).toBe(
      '1 repairable issue type of 4 detected. 3 types will need other attention.',
    );
    // A complete scope still promises only a review, never a result.
    expect(describeRepairScope({ detected: 2, repairable: 2, openings: 0 })).toBe(
      '2 repairable issue types of 2 detected. You review the result before anything changes.',
    );
    expect(describeRepairScope({ detected: 0, repairable: 0, openings: 0 })).toBe(
      REPAIR_MODEL_SUPPORT,
    );
  });

  it('names the openings when filling is the only work (the reported model)', () => {
    const issues = [
      issue(RepairIssueId.OpenBoundaries, 13),
      issue(RepairIssueId.NonManifoldVertices, 155, IssueSeverity.Error),
      issue(RepairIssueId.Components, 39),
    ];
    const statuses = new Map<RepairIssueId, IssueStatus>([
      [RepairIssueId.OpenBoundaries, { fixability: Fixability.Partial, text: '' }],
      [RepairIssueId.NonManifoldVertices, { fixability: Fixability.NotRepairable, text: '' }],
      [RepairIssueId.Components, { fixability: Fixability.Review, text: '' }],
    ]);
    const scope = deriveRepairScope(issues, statuses, 4);
    expect(scope).toEqual({ detected: 3, repairable: 1, openings: 4 });
    expect(describeRepairScope(scope)).toBe(
      '4 openings can be filled. Other detected issues will remain.',
    );
    // Never "13 boundaries repaired", never "fully".
    expect(describeRepairScope(scope)).not.toMatch(/13|fully|all/);
  });

  it('enables Repair model for openings alone, even when every conservative operation is a no-op', () => {
    expect(action({ planNoOp: true, fillableOpenings: 4 })).toBe(RepairActionKind.Ready);
    expect(action({ planNoOp: true, fillableOpenings: 0, detectedIssueTypes: 3 })).toBe(
      RepairActionKind.NothingSafe,
    );
  });
});

/* ---------------------------------------------------------- applied result -- */

describe('the applied result', () => {
  it('lists only what actually changed, from the committed counts', () => {
    expect(
      describeAppliedChanges({
        removedDuplicateFaces: 0,
        removedRepeatedPositionFaces: 10,
        removedZeroAreaFaces: 4,
        flippedFaces: 1,
        sourceFaceCount: 100,
        candidateFaceCount: 86,
      }),
    ).toEqual(['14 degenerate triangles removed', '1 triangle reversed to match neighbours']);
  });

  it('lists what is still detected, never a check that has not run', () => {
    expect(
      describeRemaining([
        issue(RepairIssueId.OpenBoundaries, 13),
        issue(RepairIssueId.SelfIntersections, undefined),
        issue(RepairIssueId.DegenerateFaces, 0),
        issue(RepairIssueId.Components, 39),
      ]),
    ).toEqual(['13 open-boundaries', '39 components']);
  });
});

/* ---------------------------------------------------------- repair options -- */

describe('repair option status', () => {
  it('states each decision in a word or two', () => {
    expect(
      describeOptionStatus(
        decision(RepairOperation.RemoveDuplicateFaces, {
          decision: RepairDecision.Applicable,
          targetedCount: 2,
          expectedFaceMutations: 3,
        }),
      ),
    ).toBe('3 to remove');
    expect(
      describeOptionStatus(
        decision(RepairOperation.UnifyWinding, {
          decision: RepairDecision.Applicable,
          targetedCount: 2,
          expectedFaceMutations: 5,
        }),
      ),
    ).toBe('5 to reverse');
    expect(describeOptionStatus(decision(RepairOperation.RemoveZeroAreaFaces))).toBe('No matches');
    expect(
      describeOptionStatus(
        decision(RepairOperation.UnifyWinding, {
          decision: RepairDecision.BlockedByPrecondition,
          reason: RepairReason.NonManifoldVertexPresent,
          targetedCount: 2,
        }),
      ),
    ).toBe('Blocked');
    expect(
      describeOptionStatus(
        decision(RepairOperation.RemoveDuplicateFaces, {
          reason: RepairReason.NotRequested,
          targetedCount: 2,
        }),
      ),
    ).toBe('Not selected');
  });
});

/* ------------------------------------------------------------ vocabulary -- */

describe('vocabulary', () => {
  it('labels file structure so it cannot read as mesh health', () => {
    expect(describeFileStructure(true)).toBe('File structure valid');
    expect(FILE_STRUCTURE_INFO.cannot).toMatch(/does not mean the mesh is manifold/);
  });

  it('explains that the summary counts issue types, not occurrences', () => {
    expect(SUMMARY_INFO.meaning).toMatch(/issue TYPES, not individual occurrences/);
  });

  it('has an explanation for every issue row', () => {
    for (const id of Object.values(RepairIssueId)) {
      const info = ISSUE_INFO[id];
      expect(info.meaning.length).toBeGreaterThan(0);
      expect(info.canDo.length).toBeGreaterThan(0);
      expect(info.cannot.length).toBeGreaterThan(0);
    }
  });

  it('emits no forbidden term from any string it can produce', () => {
    const strings: string[] = [
      REPAIR_MODEL_ACTION,
      REPAIR_MODEL_SUPPORT,
      NO_SAFE_REPAIRS,
      NO_REPAIRABLE_PROBLEMS,
      PREVIEW_READY_LINE,
      REPAIRS_EXHAUSTED_LINE,
      REPAIR_FIXED_LABEL,
      REPAIR_REMAINING_LABEL,
      REPAIR_CHECKING_REMAINING,
      describeHealthRemaining('1 error · 2 warnings'),
      describeAppliedActivity([]),
      describeAppliedActivity(['2 openings filled']),
      describeRepairsExhausted(['11 open boundaries', '155 non-manifold vertices']),
      ...[
        { changes: [], remainingTypes: undefined, exhausted: false },
        { changes: ['2 openings filled'], remainingTypes: undefined, exhausted: false },
        { changes: ['2 openings filled'], remainingTypes: 0, exhausted: false },
        { changes: ['2 openings filled'], remainingTypes: 3, exhausted: false },
        { changes: ['2 openings filled'], remainingTypes: 3, exhausted: true },
      ].flatMap((input) => {
        const outcome = deriveRepairOutcome(input);
        return [outcome.headline, outcome.support, outcome.announcement ?? ''];
      }),
      REPAIR_UNAVAILABLE_LINE,
      HOLE_FILL_SIZE_LIMIT_LINE,
      describeFileStructure(true),
      describeFileStructure(false),
      describeRepairScope({ detected: 5, repairable: 2, openings: 0 }),
      ...Object.values(REPAIR_OPTION_LABELS),
      ...[SUMMARY_INFO, REPAIR_OPTIONS_INFO, FILE_STRUCTURE_INFO, ADVANCED_INFO].flatMap((info) => [
        info.meaning,
        info.canDo,
        info.cannot,
      ]),
      ...Object.values(ISSUE_INFO).flatMap((info) => [info.meaning, info.canDo, info.cannot]),
    ];
    const contexts = [
      context(),
      context({ plan: undefined }),
      context({
        partFaceCount: 2_000_000,
        boundaries: { simpleLoops: 1, openChains: 1, branched: 1 },
      }),
      context({ selfIntersectionSizeLimited: true }),
    ];
    for (const id of Object.values(RepairIssueId)) {
      for (const count of [undefined, 0, 1, 7]) {
        for (const ctx of contexts) {
          const status = deriveIssueStatus(issue(id, count), ctx);
          strings.push(status.text, status.detail ?? '');
        }
      }
    }
    for (const text of strings) {
      for (const term of REPAIR_WORKSPACE_FORBIDDEN_TERMS) {
        // Whole words: "whole" is not "hole".
        expect(text, `"${text}" contains "${term}"`).not.toMatch(new RegExp(`\\b${term}\\b`, 'i'));
      }
    }
  });
});

/* ------------------------------------------------------- REPAIR-UX-04 -- */

describe('the repair outcome is the operation, not the model', () => {
  const FILLED = ['2 openings filled'];

  it('is PARTIAL when something was fixed and detected issues remain', () => {
    const outcome = deriveRepairOutcome({ changes: FILLED, remainingTypes: 3, exhausted: false });
    expect(outcome.kind).toBe(RepairOutcomeKind.Partial);
    expect(outcome.headline).toBe('Partial repair completed');
    expect(outcome.support).toBe(
      'Pybrix fixed the issues it could repair safely. Some detected issues remain.',
    );
    // One coherent sentence: the outcome, what was fixed, that issues remain.
    expect(outcome.announcement).toBe(
      'Partial repair completed. 2 openings filled. Some detected issues remain.',
    );
  });

  it('says so when nothing further can be repaired safely', () => {
    const outcome = deriveRepairOutcome({ changes: FILLED, remainingTypes: 3, exhausted: true });
    expect(outcome.kind).toBe(RepairOutcomeKind.Partial);
    expect(outcome.support).toBe(
      'Pybrix fixed everything it can currently repair safely on this model.',
    );
  });

  it('stays PARTIAL when supported repairs are exhausted but issues are still detected', () => {
    // "No supported repair remains" is not "no detected issue remains".
    for (const remainingTypes of [1, 2, 3]) {
      expect(deriveRepairOutcome({ changes: FILLED, remainingTypes, exhausted: true }).kind).toBe(
        RepairOutcomeKind.Partial,
      );
    }
  });

  it('is COMPLETE only when the new analysis detects no error or warning', () => {
    const outcome = deriveRepairOutcome({ changes: FILLED, remainingTypes: 0, exhausted: false });
    expect(outcome.kind).toBe(RepairOutcomeKind.Complete);
    expect(outcome.headline).toBe('Repair completed');
    expect(outcome.support).toBe('No detected issues remain in the checks Pybrix ran.');
    expect(outcome.announcement).toContain('Repair completed. 2 openings filled.');
  });

  it('decides nothing before the repaired mesh has been analysed', () => {
    const outcome = deriveRepairOutcome({
      changes: FILLED,
      remainingTypes: undefined,
      exhausted: false,
    });
    expect(outcome.kind).toBe(RepairOutcomeKind.Checking);
    expect(outcome.headline).toBe('Repair applied');
    expect(outcome.headline).not.toMatch(/partial|completed/i);
    // Nothing is announced until the outcome is known.
    expect(outcome.announcement).toBeUndefined();
  });

  it('reports no success when the repair changed nothing', () => {
    for (const remainingTypes of [undefined, 0, 2]) {
      const outcome = deriveRepairOutcome({ changes: [], remainingTypes, exhausted: true });
      expect(outcome.kind).toBe(RepairOutcomeKind.NoChange);
      expect(outcome.headline).toBe('No changes were made');
      expect(`${outcome.headline} ${outcome.support}`).not.toMatch(/completed|fixed everything/i);
    }
  });

  it('is not decided by how many triangles the repair added', () => {
    // Same change, different remaining diagnostics: different outcome.
    const many = ['2,000 openings filled', '5 duplicate triangles removed'];
    expect(deriveRepairOutcome({ changes: many, remainingTypes: 1, exhausted: false }).kind).toBe(
      RepairOutcomeKind.Partial,
    );
    expect(deriveRepairOutcome({ changes: many, remainingTypes: 0, exhausted: false }).kind).toBe(
      RepairOutcomeKind.Complete,
    );
  });

  it('joins several fixes into one sentence', () => {
    const outcome = deriveRepairOutcome({
      changes: ['2 openings filled', '3 duplicate triangles removed', '1 triangle reversed'],
      remainingTypes: 1,
      exhausted: false,
    });
    expect(outcome.announcement).toBe(
      'Partial repair completed. 2 openings filled, 3 duplicate triangles removed and 1 triangle reversed. Some detected issues remain.',
    );
  });
});

describe('what remains is reported per category, never summed', () => {
  const issue = (
    id: RepairIssueId,
    label: string,
    severity: IssueSeverity,
    count: number | undefined,
  ): RepairIssue => ({
    id,
    label,
    help: '',
    severity,
    count,
    unit: ['', ''],
    occurrenceSource: 'none',
    occurrenceCount: 0,
    occurrencesPartial: false,
  });
  const TRUCK: readonly RepairIssue[] = [
    issue(RepairIssueId.OpenBoundaries, 'Open boundaries', IssueSeverity.Warning, 11),
    issue(RepairIssueId.NonManifoldEdges, 'Non-manifold edges', IssueSeverity.Ok, 0),
    issue(RepairIssueId.NonManifoldVertices, 'Non-manifold vertices', IssueSeverity.Error, 155),
    issue(
      RepairIssueId.SelfIntersections,
      'Self-intersections',
      IssueSeverity.Unchecked,
      undefined,
    ),
    issue(RepairIssueId.Components, 'Separate components', IssueSeverity.Warning, 39),
  ];

  it('lists each remaining category with its own count', () => {
    expect(remainingIssues(TRUCK).map(describeRemainingIssue)).toEqual([
      '11 open boundaries',
      '155 non-manifold vertices',
      '39 separate components',
    ]);
    expect(describeRemaining(TRUCK)).toEqual(remainingIssues(TRUCK).map(describeRemainingIssue));
  });

  it('never adds unlike quantities together', () => {
    const everything = [
      ...describeRemaining(TRUCK),
      describeRepairsExhausted(describeRemaining(TRUCK)),
      deriveRepairOutcome({ changes: ['2 openings filled'], remainingTypes: 3, exhausted: true })
        .announcement ?? '',
    ].join(' ');
    // 11 + 155 + 39, and the partial sums.
    for (const sum of ['205', '166', '194', '50']) {
      expect(everything).not.toMatch(new RegExp(`\\b${sum}\\b`));
    }
  });

  it('explains the disabled action after a partial repair without saying nothing is wrong', () => {
    expect(REPAIRS_EXHAUSTED_LINE).toBe(
      'Everything Pybrix can safely repair automatically has been fixed.',
    );
    const detail = describeRepairsExhausted(describeRemaining(TRUCK));
    expect(detail).toContain(
      'Still detected: 11 open boundaries, 155 non-manifold vertices and 39 separate components.',
    );
    expect(detail).toContain('repairing again would change nothing');
    expect(`${REPAIRS_EXHAUSTED_LINE} ${detail}`).not.toMatch(
      /no issues|nothing is wrong|healthy/i,
    );
  });

  it('marks the Health counts as what is left, without changing them', () => {
    expect(describeHealthRemaining('1 error · 2 warnings')).toBe('1 error · 2 warnings remaining');
  });

  it('writes an Activity entry about what changed, not about what remains', () => {
    expect(describeAppliedActivity(['2 openings filled'])).toBe(
      'Repair applied: 2 openings filled. Health shows what remains.',
    );
    expect(describeAppliedActivity([])).toBe('Repair applied. No triangles changed.');
    expect(describeAppliedActivity(['2 openings filled'])).not.toMatch(/complete|partial/i);
  });
});
