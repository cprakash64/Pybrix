import { describe, expect, it } from 'vitest';
import {
  LocalRepairNotRun,
  PrintabilityStatus,
  LocalRepairOutcomeKind,
  SelfIntersectionStatus as TopologySelfIntersectionStatus,
  type LocalRepairOutcome,
  type LocalRepairPlan,
  type TopologyReport,
} from '@cadfixer/geometry-runtime';
import {
  PreviewOutcome,
  REPAIR_PREVIEW_FORBIDDEN_TERMS,
  derivePreviewSummary,
  describeGeometryChanges,
  describeIssueTypeCount,
  describeLimitLikely,
  describeNoSafeChange,
  describePreviewOutcome,
  diffIssues,
  mapLocalOutcome,
} from './repair-preview-summary';
import { deriveRepairAction, RepairActionKind } from './repair-workspace-presentation';

function report(overrides: Partial<TopologyReport> = {}): TopologyReport {
  return {
    schemaVersion: 1,
    documentId: 'model-1',
    documentRevision: 1,
    partId: 'part-1',
    identityMode: 'exact-stored-coordinate',
    sourceFaceCount: 4,
    sourceCornerCount: 12,
    topologicalVertexCount: 4,
    uniqueEdgeCount: 6,
    boundaryEdgeCount: 0,
    ordinaryEdgeCount: 6,
    nonManifoldEdgeCount: 0,
    nonManifoldVertexCount: 0,
    windingConflictEdgeCount: 0,
    repeatedPositionFaceCount: 0,
    zeroAreaFaceCount: 0,
    sameOrientationDuplicateCount: 0,
    reversedOrientationDuplicateCount: 0,
    componentCount: 1,
    components: [],
    componentsTruncated: false,
    simpleBoundaryLoopCount: 0,
    openBoundaryChainCount: 0,
    branchedBoundaryCount: 0,
    boundaryComponents: [],
    boundaryComponentsTruncated: false,
    totalSurfaceArea: 1,
    totalSignedVolume: 1 / 6,
    isEdgeManifold: true,
    isVertexManifold: true,
    isWindingConsistent: true,
    isBoundaryFree: true,
    selfIntersectionStatus: TopologySelfIntersectionStatus.NotChecked,
    printabilityStatus: PrintabilityStatus.NotFullyDetermined,
    analysisMilliseconds: 1,
    ...overrides,
  };
}

const outcome = (overrides: Partial<LocalRepairOutcome> = {}): LocalRepairOutcome => ({
  kind: LocalRepairOutcomeKind.Complete,
  eligible: 3,
  unsupportedNonManifoldEdge: 0,
  repaired: 3,
  remaining: 0,
  unattempted: 0,
  remainingByReason: [],
  limitReached: undefined,
  work: { primary: { used: 100, limit: 200 }, residual: { used: 0, limit: 50 } },
  residual: {
    ran: false,
    skippedBecause: undefined,
    linkRetriangulations: 0,
    repairedAfterResidual: 0,
    windingComponentsResolved: 0,
    windingFacesReversed: 0,
  },
  facesRemoved: 19,
  facesAppended: 2,
  facesReversed: 0,
  reasonsTruncated: false,
  ...overrides,
});

describe('the issue diff is read from the two analyses, never from operation labels', () => {
  it('lists each category with its OWN count and never adds them up', () => {
    const before = report({ nonManifoldVertexCount: 8, windingConflictEdgeCount: 3 });
    const after = report({ nonManifoldVertexCount: 0, windingConflictEdgeCount: 1 });
    const diff = diffIssues(before, after);
    expect(diff.fixed).toEqual(['8 non-manifold vertices', '2 winding conflicts']);
    expect(diff.remaining).toEqual(['1 winding conflicts'.replace('conflicts', 'conflict')]);
    expect(diff.currentTypes).toBe(2);
    expect(diff.afterTypes).toBe(1);
  });

  it('uses the singular for one', () => {
    const diff = diffIssues(report({ nonManifoldVertexCount: 1 }), report());
    expect(diff.fixed).toEqual(['1 non-manifold vertex']);
  });

  it('reports nothing fixed and nothing remaining for a clean model', () => {
    const diff = diffIssues(report(), report());
    expect(diff.fixed).toEqual([]);
    expect(diff.remaining).toEqual([]);
  });

  it('never reports a category that got WORSE as fixed', () => {
    const diff = diffIssues(
      report({ nonManifoldVertexCount: 1 }),
      report({ nonManifoldVertexCount: 4 }),
    );
    expect(diff.fixed).toEqual([]);
    expect(diff.remaining).toEqual(['4 non-manifold vertices']);
  });
});

describe('outcome mapping', () => {
  it('maps every typed engine outcome to what it means to a person', () => {
    expect(mapLocalOutcome(LocalRepairOutcomeKind.Complete)).toBe(PreviewOutcome.Complete);
    expect(mapLocalOutcome(LocalRepairOutcomeKind.PartialUnsupported)).toBe(
      PreviewOutcome.PartialUnsupported,
    );
    expect(mapLocalOutcome(LocalRepairOutcomeKind.PartialLimit)).toBe(PreviewOutcome.PartialLimit);
    expect(mapLocalOutcome(LocalRepairOutcomeKind.PartialAmbiguous)).toBe(
      PreviewOutcome.PartialAmbiguous,
    );
    // Conservative-only candidates carry no local outcome and read as complete work.
    expect(mapLocalOutcome(undefined)).toBe(PreviewOutcome.Complete);
  });

  it('says the right thing for each, and a limit is never called an error', () => {
    const limit = describePreviewOutcome(PreviewOutcome.PartialLimit, true);
    expect(limit.support).toMatch(/too complex for this automatic repair pass/);
    expect(limit.headline).not.toMatch(/error|fail/i);
    expect(describePreviewOutcome(PreviewOutcome.PartialUnsupported, true).headline).toBe(
      'Some issues need manual repair',
    );
    expect(describePreviewOutcome(PreviewOutcome.PartialAmbiguous, true).support).toMatch(
      /intended shape/,
    );
    expect(describePreviewOutcome(PreviewOutcome.Complete, false).headline).toBe('Ready to apply');
  });

  it('keeps a complete outcome honest when other issues remain', () => {
    expect(describePreviewOutcome(PreviewOutcome.Complete, true).support).toMatch(/remain/);
  });

  it('derives one summary for a candidate, with geometry kept secondary', () => {
    const summary = derivePreviewSummary({
      before: report({ nonManifoldVertexCount: 3 }),
      after: report({ boundaryEdgeCount: 4, simpleBoundaryLoopCount: 1 }),
      local: outcome({ kind: LocalRepairOutcomeKind.PartialLimit }),
    });
    expect(summary.outcome).toBe(PreviewOutcome.PartialLimit);
    expect(summary.fixed).toEqual(['3 non-manifold vertices']);
    expect(summary.geometry).toEqual(['19 triangles replaced', '2 triangles added']);
  });
});

describe('no safe change is a decision, not a failure', () => {
  it('distinguishes the reasons and never claims a failure', () => {
    const texts = [
      describeNoSafeChange(LocalRepairOutcomeKind.NoChange, undefined),
      describeNoSafeChange(LocalRepairOutcomeKind.PartialAmbiguous, undefined),
      describeNoSafeChange(LocalRepairOutcomeKind.PartialLimit, undefined),
      describeNoSafeChange(undefined, LocalRepairNotRun.NoVerifier),
    ];
    expect(new Set(texts).size).toBe(4);
    for (const text of texts) {
      expect(text).toMatch(/Your model is unchanged/);
      expect(text).not.toMatch(/fail|error/i);
    }
  });
});

describe('limitLikely is ADVISORY ONLY', () => {
  const plan = (limitLikely: boolean): LocalRepairPlan => ({
    requested: true,
    pinchedVertices: 100,
    eligible: 100,
    unsupportedNonManifoldEdge: 0,
    byClass: {},
    workLimit: { primary: 1_200_000, residual: 40_000 },
    estimatedWorkLowerBound: 900,
    limitLikely,
    planHash: 'lr-1',
  });

  it('produces only a subtle pre-run line, and none when it is false', () => {
    expect(describeLimitLikely(plan(true))).toMatch(/unusually complex/);
    expect(describeLimitLikely(plan(false))).toBeUndefined();
    expect(describeLimitLikely(undefined)).toBeUndefined();
  });

  it('never changes the action: Repair stays available whatever it says', () => {
    const input = {
      hasModel: true,
      isolationSupported: true,
      reportIsCurrent: true,
      isAnalyzing: false,
      planState: 'ready' as const,
      planNoOp: true,
      fillableOpenings: 0,
      candidateState: 'idle' as const,
      commitState: 'idle' as const,
      detectedIssueTypes: 1,
    };
    // The action function does not even receive the flag: it cannot disable Repair.
    expect(deriveRepairAction({ ...input, localEligible: 100 })).toBe(RepairActionKind.Ready);
    expect(deriveRepairAction({ ...input, localEligible: 0 })).toBe(RepairActionKind.NothingSafe);
  });

  it('is never what an outcome is derived from', () => {
    // The summary takes the typed engine result and two analyses — there is no plan input.
    const summary = derivePreviewSummary({
      before: report({ nonManifoldVertexCount: 1 }),
      after: report(),
      local: outcome(),
    });
    expect(summary.outcome).toBe(PreviewOutcome.Complete);
  });
});

describe('progress and counts', () => {
  it('describes geometry edits separately from issues', () => {
    expect(describeGeometryChanges(undefined)).toEqual([]);
    expect(describeGeometryChanges(outcome({ facesRemoved: 1, facesAppended: 0 }))).toEqual([
      '1 triangle replaced',
    ]);
  });

  it('counts issue TYPES for the current model and the candidate', () => {
    expect(describeIssueTypeCount(undefined)).toBe('Not checked');
    expect(describeIssueTypeCount(0)).toBe('No detected issues');
    expect(describeIssueTypeCount(1)).toBe('1 issue type');
    expect(describeIssueTypeCount(4)).toBe('4 issue types');
  });
});

describe('copy discipline', () => {
  it('no string the module can emit contains a forbidden claim or an internal term', () => {
    const strings: string[] = [];
    for (const kind of Object.values(PreviewOutcome)) {
      for (const remains of [true, false]) {
        const copy = describePreviewOutcome(kind, remains);
        strings.push(copy.headline, copy.support);
      }
    }
    for (const kind of Object.values(LocalRepairOutcomeKind)) {
      strings.push(describeNoSafeChange(kind, undefined));
    }
    strings.push(describeNoSafeChange(undefined, LocalRepairNotRun.NoVerifier));
    strings.push(describeLimitLikely({ limitLikely: true } as LocalRepairPlan) ?? '');
    for (const text of strings) {
      for (const term of REPAIR_PREVIEW_FORBIDDEN_TERMS) {
        expect(text.toLowerCase(), `"${text}" contains "${term}"`).not.toContain(term);
      }
    }
  });
});
