import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import {
  BoundaryFillScanStatus,
  PrintabilityStatus,
  RepairAcceptance,
  RepairDecision,
  RepairOperation,
  RepairReason,
  SelfIntersectionStatus,
  type BoundaryFillPlan,
  type ConservativeRepairPlan,
  type LocalRepairPlan,
  type DocumentHandle,
  type DocumentRenderSnapshot,
  type PartDescriptor,
  type RepairCandidateHandle,
  type RepairOperationDecision,
  type RepairValidation,
  type TopologyDetail,
  type TopologyReport,
} from '@cadfixer/geometry-runtime';
import { RepairWorkspace } from './RepairWorkspace';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import { WorkspaceProvider } from '../state/store-context';
import { WorkflowControllersProvider } from '../state/workflow-controllers';
import { NO_SAFE_CHANGE_CODE } from '../state/repair-preview-summary';
import { WorkspaceStore } from '../state/workspace-store';
import {
  REPAIR_EXCLUSIONS,
  REPAIR_ISOLATION_HEADLINE,
  REPAIR_QUALIFIER,
} from '../state/repair-presentation';
import {
  NO_REPAIRABLE_PROBLEMS,
  NO_SAFE_REPAIRS,
  REPAIR_WORKSPACE_FORBIDDEN_TERMS,
} from '../state/repair-workspace-presentation';
import type { LoadedModel } from '../state/model';

/**
 * THE REPAIR WORKSPACE — REPAIR-UX-01, at component level.
 *
 * What is proved here is the SHAPE of the default screen: one primary action
 * that is always in the same place and always says why it is disabled, compact
 * issue rows, explanations behind ⓘ buttons, and the full report collapsed.
 * The pure decisions behind every sentence are in
 * `repair-workspace-presentation.test.ts`; the happy path against a real
 * worker is end to end. The worker here is stubbed and never replies, so the
 * store is driven directly and nothing can be reading a real result.
 */

function setIsolated(value: boolean): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    writable: true,
    value,
  });
}

beforeEach(() => {
  setIsolated(true);
});

afterEach(cleanup);

const PART = 'part-1';
const HANDLE = { documentId: 'model-1', revision: 1 } as DocumentHandle;

function renderWorkspace(
  configure: (store: WorkspaceStore) => void = () => undefined,
): WorkspaceStore {
  const store = new WorkspaceStore();
  configure(store);
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <WorkflowControllersProvider>
          <RepairWorkspace />
        </WorkflowControllersProvider>
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return store;
}

function partDescriptor(triangleCount = 4): PartDescriptor {
  return {
    partId: PART,
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount,
    vertexCount: triangleCount * 3,
    bounds: undefined,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

function loadModel(store: WorkspaceStore, triangleCount = 4): DocumentHandle {
  const render_: DocumentRenderSnapshot = {
    parts: [
      {
        partId: PART,
        transform: IDENTITY_PART_TRANSFORM,
        positions: new Float32Array(9),
        normals: new Float32Array(9),
        vertexCount: 3,
      },
    ],
  };
  const model: Omit<LoadedModel, 'revision'> = {
    handle: HANDLE,
    parts: [partDescriptor(triangleCount)],
    render: render_,
    source: {
      fileName: 'part.stl',
      fileBytes: 100,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount,
    vertexCount: triangleCount * 3,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 192,
  };
  const token = store.beginImport('part.stl');
  store.commitImport(token, model);
  return HANDLE;
}

function report(overrides: Partial<TopologyReport> = {}): TopologyReport {
  return {
    schemaVersion: 1,
    documentId: 'model-1',
    documentRevision: 1,
    partId: PART,
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
    selfIntersectionStatus: SelfIntersectionStatus.NotChecked,
    printabilityStatus: PrintabilityStatus.NotFullyDetermined,
    analysisMilliseconds: 1,
    ...overrides,
  };
}

const DETAIL: TopologyDetail = {
  boundaryEdges: new Uint32Array(0),
  boundaryEdgesTruncated: false,
  nonManifoldEdges: new Uint32Array(0),
  nonManifoldEdgesTruncated: false,
  windingConflictEdges: new Uint32Array(0),
  windingConflictEdgesTruncated: false,
  degenerateFaces: new Uint32Array(0),
  degenerateFacesTruncated: false,
  sampleVertexIds: new Uint32Array(0),
  sampleVertexPositions: new Float32Array(0),
  sampleLimit: 64,
};

/**
 * Commits a report as if the worker had answered. Must run AFTER render: the
 * analysis hook starts its own automatic analysis on mount, and a report
 * committed before that would simply be superseded by it.
 */
function analyse(store: WorkspaceStore, overrides: Partial<TopologyReport> = {}): void {
  act(() => {
    const token = store.beginAnalysis(HANDLE, PART);
    store.commitAnalysis(token, HANDLE, PART, report(overrides), DETAIL, 1);
  });
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

function planWith(decisions: readonly RepairOperationDecision[]): ConservativeRepairPlan {
  const all = [
    RepairOperation.RemoveDuplicateFaces,
    RepairOperation.RemoveRepeatedPositionFaces,
    RepairOperation.RemoveZeroAreaFaces,
    RepairOperation.UnifyWinding,
  ].map((op) => decisions.find((entry) => entry.operation === op) ?? decision(op));
  return {
    schemaVersion: 1,
    documentId: 'model-1',
    partId: PART,
    sourceRevision: 1,
    reportVersion: 1,
    requested: all.map((entry) => entry.operation),
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

/** Installs a plan as if the worker had answered. Must run after render. */
function commitPlan(
  store: WorkspaceStore,
  plan: ConservativeRepairPlan,
  fill: BoundaryFillPlan = fillPlan(0),
): void {
  act(() => {
    const token = store.beginRepairPlan(HANDLE, PART, plan.requested);
    store.commitRepairPlan(token, HANDLE, plan, fill);
  });
}

function fillPlan(admitted: number, verified = true): BoundaryFillPlan {
  return {
    status: BoundaryFillScanStatus.Scanned,
    boundaryEdgeCount: 400,
    simpleLoopCount: 6,
    complexBoundaryCount: 7,
    admittedCount: admitted,
    admittedPatchFaces: admitted * 4,
    verified,
    loops: [],
    loopsTruncated: false,
    planHash: `bf-${String(admitted)}`,
  };
}

const DEGENERATE_PLAN = planWith([
  decision(RepairOperation.RemoveZeroAreaFaces, {
    decision: RepairDecision.Applicable,
    targetedCount: 2,
    expectedFaceMutations: 2,
  }),
]);

function validation(): RepairValidation {
  return {
    acceptance: RepairAcceptance.Accepted,
    regressions: [],
    warnings: [],
    before: report({ zeroAreaFaceCount: 2 }),
    after: report({ sourceFaceCount: 2 }),
    surfaceAreaBefore: 1,
    surfaceAreaAfter: 1,
    signedVolumeBefore: 1,
    signedVolumeAfter: 1,
    volumeComparison: 'UNCHANGED',
    boundsComparison: 'IDENTICAL',
  } as unknown as RepairValidation;
}

function commitPreview(store: WorkspaceStore): void {
  act(() => {
    const token = store.beginRepairPreview();
    if (token === undefined) throw new Error('no preview token');
    store.beginRepairCandidate(token);
    store.commitRepairCandidate(token, {
      candidate: { candidateId: 'c-1' } as unknown as RepairCandidateHandle,
      source: HANDLE,
      partId: PART,
      planHash: 'hash',
      validation: validation(),
      counts: {
        removedDuplicateFaces: 0,
        removedRepeatedPositionFaces: 0,
        removedZeroAreaFaces: 2,
        flippedFaces: 0,
        sourceFaceCount: 4,
        candidateFaceCount: 2,
      },
      samples: {
        removedDuplicateFaces: new Uint32Array(0),
        removedRepeatedPositionFaces: new Uint32Array(0),
        removedZeroAreaFaces: new Uint32Array(0),
        flippedFaces: new Uint32Array(0),
        truncated: false,
        sampleLimit: 256,
      },
      render: undefined,
      bounds: undefined,
      undoRetainedBytes: 0,
      boundaryFill: undefined,
    });
  });
}

function applied(store: WorkspaceStore, undoable: boolean): void {
  store.applyRepairResult({
    handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
    partId: PART,
    parts: [partDescriptor()],
    parentRevision: 1,
    recordId: 'record-1',
    appliedOperations: [RepairOperation.RemoveZeroAreaFaces],
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 12,
      removedZeroAreaFaces: 2,
      flippedFaces: 0,
      sourceFaceCount: 18,
      candidateFaceCount: 4,
    },
    undoable,
    render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
    bounds: undefined,
    triangleCount: 4,
    vertexCount: 12,
    residentBytes: 192,
  });
}

/* --------------------------------------------------------- primary action -- */

describe('the primary action', () => {
  it('exists, disabled, with no model — the same place every other workspace keeps its action', () => {
    renderWorkspace();
    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    expect(screen.queryByTestId('undo-repair')).toBeNull();
  });

  it('asks for an analysis first, and offers a cancel while one runs', () => {
    renderWorkspace(loadModel);
    // The hook starts the automatic analysis on mount; the stub never replies.
    expect(screen.getByTestId('analyze-mesh')).toBeDisabled();
    expect(screen.getByTestId('analyze-mesh')).toHaveTextContent('Analyzing…');
    expect(screen.getByTestId('cancel-analysis')).toBeEnabled();
    expect(screen.getByTestId('analysis-progress')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-repair')).toBeNull();
  });

  it('shows Repair model, disabled, while the plan is worked out', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-planning')).toBeInTheDocument();
  });

  it('enables Repair model for a current plan with applicable work, and says how much it covers', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2, nonManifoldVertexCount: 1, isVertexManifold: false });
    commitPlan(store, DEGENERATE_PLAN);

    const button = screen.getByTestId('preview-repair');
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Repair model');
    // Honest scope: one of the two detected types, and the rest named as such.
    expect(screen.getByTestId('repair-scope')).toHaveTextContent(
      '1 repairable issue type of 2 detected. 1 type will need other attention.',
    );
    expect(screen.getByTestId('issue-status-degenerate-faces')).toHaveTextContent(
      'Repair available',
    );
    expect(screen.getByTestId('issue-status-non-manifold-vertices')).toHaveTextContent(
      'Not automatically repairable',
    );
  });

  it('keeps Repair model visible but disabled, with the reason, when nothing safe can run', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 155, isVertexManifold: false, componentCount: 39 });
    commitPlan(store, planWith([]));

    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-no-repairs')).toHaveTextContent(NO_SAFE_REPAIRS);
    // The longer reason is one ⓘ away, not on screen.
    const detail = screen.getByTestId('repair-no-repairs-detail');
    expect(detail).not.toBeVisible();
    fireEvent.click(screen.getByTestId('repair-no-repairs-info'));
    expect(detail).toBeVisible();
  });

  it('says there is nothing to repair on a model with no detected issue', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store);
    commitPlan(store, planWith([]));

    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-no-repairs')).toHaveTextContent(NO_REPAIRABLE_PROBLEMS);
  });

  it('becomes Apply repairs + Discard preview once a validated preview exists', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    commitPreview(store);

    expect(screen.queryByTestId('preview-repair')).toBeNull();
    expect(screen.getByTestId('apply-repair')).toBeEnabled();
    expect(screen.getByTestId('apply-repair')).toHaveTextContent('Apply repairs');
    expect(screen.getByTestId('discard-preview')).toHaveTextContent('Discard preview');
    expect(screen.getByTestId('repair-preview-ready')).toHaveTextContent(
      'nothing has changed until you apply it',
    );
    // The preview's metrics are one click away, not on screen.
    expect(screen.getByTestId('repair-metrics')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('repair-preview-details-toggle'));
    expect(screen.getByTestId('repair-metrics')).toBeVisible();
  });

  it('refuses a stale plan: a report for another revision disables the action', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    expect(screen.getByTestId('preview-repair')).toBeEnabled();

    act(() => {
      applied(store, true);
    });
    // Revision 2 has no report yet: the action asks for analysis, and the
    // plan for revision 1 cannot be pressed.
    expect(screen.queryByTestId('preview-repair')).toBeNull();
    expect(screen.getByTestId('analyze-mesh')).toBeInTheDocument();
  });

  it('fails closed in a context that cannot stop a repair — disabled, with the reason', () => {
    setIsolated(false);
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });

    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.queryByTestId('cancel-repair')).toBeNull();
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    expect(screen.queryByTestId('repair-operations')).toBeNull();
    expect(screen.getByTestId('repair-isolation-unavailable')).toHaveTextContent(
      REPAIR_ISOLATION_HEADLINE,
    );
    expect(screen.getByTestId('repair-isolation-detail')).toHaveTextContent(
      /cross-origin isolated/i,
    );
  });
});

/* ------------------------------------------------------------ applied result -- */

describe('after a repair has been applied', () => {
  it('lists what was fixed, qualifies it, and offers a single undo', () => {
    renderWorkspace((store) => {
      loadModel(store);
      applied(store, true);
    });

    // The repaired mesh has not been analysed yet: neither partial nor complete.
    expect(screen.getByTestId('repair-applied-headline')).toHaveTextContent('Repair applied');
    expect(screen.getByTestId('repair-applied')).toHaveAttribute('data-outcome', 'checking');
    expect(screen.getByTestId('repair-applied-changes')).toHaveTextContent(
      '14 degenerate triangles removed',
    );
    // The new revision has no report yet, so nothing claims what remains.
    expect(screen.getByTestId('repair-applied-remaining')).toHaveTextContent(
      'Checking the repaired mesh…',
    );
    expect(screen.getByTestId('repair-applied-detail')).toHaveTextContent(
      'Selected topological issues were repaired and revalidated.',
    );
    expect(screen.getByTestId('repair-applied-qualifier')).toHaveTextContent(REPAIR_QUALIFIER);
    expect(screen.getByTestId('undo-repair')).toBeEnabled();
  });

  it('names what remains from the NEW analysis, never "all fixed"', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      applied(s, true);
    });
    const handle = { documentId: 'model-1', revision: 2 } as DocumentHandle;
    act(() => {
      const token = store.beginAnalysis(handle, PART);
      store.commitAnalysis(
        token,
        handle,
        PART,
        report({
          documentRevision: 2,
          boundaryEdgeCount: 3,
          simpleBoundaryLoopCount: 1,
          componentCount: 39,
        }),
        DETAIL,
        1,
      );
    });

    const remaining = screen.getByTestId('repair-applied-remaining');
    expect(remaining).toHaveTextContent('1 open boundaries');
    expect(remaining).toHaveTextContent('39 separate components');
  });

  it('disables undo and says so when the repair cannot be reversed', () => {
    renderWorkspace((store) => {
      loadModel(store);
      applied(store, false);
    });
    expect(screen.getByTestId('undo-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-undo-unavailable')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------ progressive disclosure -- */

describe('progressive disclosure', () => {
  function renderAnalysed(): WorkspaceStore {
    const store = renderWorkspace((s) => {
      loadModel(s, 1_988_877);
    });
    analyse(store, {
      sourceFaceCount: 1_988_877,
      boundaryEdgeCount: 400,
      simpleBoundaryLoopCount: 6,
      branchedBoundaryCount: 7,
      nonManifoldVertexCount: 155,
      isVertexManifold: false,
      isBoundaryFree: false,
      componentCount: 39,
    });
    // The reported model's shape: nothing for the four conservative operations,
    // four openings the worker admitted for filling.
    commitPlan(store, planWith([]), fillPlan(4));
    // The worker skips the openings walk above the filling ceiling.
    act(() => {
      const token = store.beginHoleFillListing(HANDLE, PART);
      store.commitHoleFillListing(token, {
        handle: HANDLE,
        partId: PART,
        inventoried: false,
        loopCount: 0,
        rows: [],
        truncated: false,
        partFaceCount: 1_988_877,
      });
    });
    return store;
  }

  it('shows compact rows by default and keeps the long explanations out of view', () => {
    renderAnalysed();

    // Issue TYPES, not occurrences.
    expect(screen.getByTestId('health-summary')).toHaveTextContent('1 error · 2 warnings');
    expect(screen.getByTestId('issue-detail-open-boundaries')).toHaveTextContent(
      '6 simple loops · 7 complex',
    );
    expect(screen.getByTestId('issue-status-open-boundaries')).toHaveTextContent(
      '4 fillable · 9 need attention',
    );
    expect(screen.getByTestId('issue-status-components')).toHaveTextContent('Review recommended');
    expect(screen.getByTestId('file-structure')).toHaveTextContent('File structure valid');

    // No prose walls: exclusions, filling limits, topology and the component
    // table are all present in the document and none is visible.
    expect(screen.getByTestId('repair-exclusions')).not.toBeVisible();
    expect(screen.getByTestId('hole-fill-limits')).not.toBeVisible();
    expect(screen.getByTestId('health-topology')).not.toBeVisible();
    expect(screen.getByTestId('issue-info-panel-open-boundaries')).not.toBeVisible();
    expect(screen.getByTestId('hole-fill-size-limit')).toHaveTextContent(
      'Choosing openings one at a time isn’t available at this part size.',
    );
    expect(screen.getByTestId('hole-fill-not-inventoried')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('hole-fill-size-limit-info'));
    expect(screen.getByTestId('hole-fill-not-inventoried')).toHaveTextContent('1,988,877');
  });

  it('enables Repair model on a large part when filling openings is the only work (REPAIR-CORE-02 §42)', () => {
    renderAnalysed();
    const button = screen.getByTestId('preview-repair');
    expect(button).toBeEnabled();
    expect(screen.getByTestId('repair-scope')).toHaveTextContent(
      '4 openings can be filled. Other detected issues will remain.',
    );
    expect(screen.getByTestId('repair-op-status-fill-openings')).toHaveTextContent('4 to fill');
  });

  it('turning filling off disables Repair model when nothing else can run', () => {
    const store = renderAnalysed();
    fireEvent.click(screen.getByTestId('repair-op-toggle-fill-openings'));
    expect(store.getSnapshot().repair.fillOpenings).toBe(false);
    expect(screen.getByTestId('issue-status-open-boundaries')).toHaveTextContent(
      'Automatic filling not selected',
    );
  });

  it('starts Advanced diagnostics collapsed and reveals the full report when opened', () => {
    renderAnalysed();

    const section = screen.getByTestId('advanced-diagnostics');
    const toggle = within(section).getByRole('button', { name: 'Advanced diagnostics' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('health-topology')).toBeVisible();
    expect(screen.getByTestId('topo-nonmanifold-vertices')).toHaveTextContent('155');
    const exclusions = within(screen.getByTestId('repair-exclusions')).getAllByRole('listitem');
    expect(exclusions).toHaveLength(REPAIR_EXCLUSIONS.length);
    expect(screen.getByTestId('hole-fill-limits')).toBeVisible();
  });

  it('keeps a way to re-run a finished analysis, in Advanced diagnostics', () => {
    // Regression: the redesign first removed Mesh Health's re-run control along
    // with the analysis lifecycle, leaving no way to analyse a current model again.
    renderAnalysed();
    const rerun = screen.getByTestId('rerun-analysis');
    expect(rerun).not.toBeVisible();
    fireEvent.click(
      within(screen.getByTestId('advanced-diagnostics')).getByRole('button', {
        name: 'Advanced diagnostics',
      }),
    );
    expect(rerun).toBeVisible();
    fireEvent.click(rerun);
    // The analysis restarts: the footer shows its progress and Cancel.
    expect(screen.getByTestId('cancel-analysis')).toBeInTheDocument();
  });

  it('opens an ⓘ by click, closes it with Escape and returns focus to the button', () => {
    renderAnalysed();

    const button = screen.getByTestId('issue-info-non-manifold-vertices');
    const panel = screen.getByTestId('issue-info-panel-non-manifold-vertices');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAccessibleName('About Non-manifold vertices');
    expect(button.getAttribute('aria-controls')).toBe(panel.id);

    fireEvent.click(button);
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent('What it means');
    expect(panel).toHaveTextContent('What Pybrix can do');
    expect(panel).toHaveTextContent('When it cannot');

    within(panel).getByRole('button', { name: 'Close' }).focus();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(panel).not.toBeVisible();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(button);
  });

  it('reports a self-intersection check that did not run as not checked, never as zero', () => {
    renderAnalysed();
    expect(screen.getByTestId('issue-count-self-intersections')).toHaveTextContent('—');
    expect(screen.getByTestId('self-intersection-headline')).toHaveTextContent(
      'Not checked — model exceeds automatic check size',
    );
    // No button above the ceiling, not even a disabled one.
    expect(screen.queryByTestId('run-self-intersection')).toBeNull();
  });

  it('never emits a forbidden claim anywhere in the workspace', () => {
    renderAnalysed();
    const text = screen.getByTestId('repair-workspace').textContent;
    for (const term of REPAIR_WORKSPACE_FORBIDDEN_TERMS) {
      expect(text).not.toMatch(new RegExp(`\\b${term}\\b`, 'i'));
    }
  });
});

/* ---------------------------------------------------- WORKSPACE-UX-03 -- */

/** The lines the action region is DRAWING — not the ones it only speaks. */
function drawnLines(footer: HTMLElement): number {
  return footer.querySelectorAll(
    '.action-footer__line, .convert-footer__hint, .repair-footer__progress',
  ).length;
}

describe('the bounded action region', () => {
  it('holds the action row and one line while a preview is ready', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    commitPreview(store);

    const footer = screen.getByTestId('repair-footer');
    expect(footer).toHaveClass('action-footer');
    expect(drawnLines(footer)).toBe(1);
    expect(footer).toContainElement(screen.getByTestId('repair-preview-ready'));
    // What Apply does is still said — as the button's description, not a line.
    expect(screen.getByTestId('apply-repair')).toHaveAccessibleDescription(
      'Apply replaces the model with the validated preview. You can undo it.',
    );
    // The preview's review is content.
    expect(footer).not.toContainElement(screen.getByTestId('repair-candidate'));
  });

  it('keeps the applied result and its Undo out of the action region', () => {
    renderWorkspace((store) => {
      loadModel(store);
      applied(store, true);
    });

    const footer = screen.getByTestId('repair-footer');
    expect(footer).not.toContainElement(screen.getByTestId('repair-applied'));
    expect(footer).not.toContainElement(screen.getByTestId('undo-repair'));
    expect(
      screen.getByTestId('undo-repair').closest('.convert-workspace__sections'),
    ).not.toBeNull();
    expect(drawnLines(footer)).toBeLessThanOrEqual(1);
  });

  it('states a failure as a headline, with the message in the scrolling content', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    const message =
      'The preview could not be built because the working memory it needs is larger than this browser session allows for a part of this size.';
    act(() => {
      const token = store.beginRepairPreview();
      if (token === undefined) throw new Error('no preview token');
      store.beginRepairCandidate(token);
      store.failRepairCandidate(token, { message, code: 'RESOURCE_LIMIT', retryable: true });
    });

    const footer = screen.getByTestId('repair-footer');
    const alert = screen.getByTestId('repair-candidate-error');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(footer).not.toContainElement(alert);
    expect(alert.closest('.workspace-outcome')).not.toBeNull();
    expect(screen.getByTestId('repair-failure-line')).toHaveTextContent('No preview was made');
    expect(footer).not.toHaveTextContent(message);
    expect(drawnLines(footer)).toBe(1);
    // One alert for one failure.
    expect(within(footer).queryByRole('alert')).toBeNull();
  });

  it('opens the reason behind ⓘ in the scrolling content, never in the region', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 3 });
    commitPlan(store, planWith([]));

    const footer = screen.getByTestId('repair-footer');
    const detail = screen.getByTestId('repair-no-repairs-detail');
    fireEvent.click(screen.getByTestId('repair-no-repairs-info'));
    expect(detail).toBeVisible();
    expect(footer).not.toContainElement(detail);
    expect(footer).toContainElement(screen.getByTestId('repair-no-repairs-info'));
  });
});

/* ------------------------------------------------------- REPAIR-UX-04 -- */

describe('a repair outcome and the model’s health are distinct', () => {
  const REPAIRED = { documentId: 'model-1', revision: 2 } as DocumentHandle;

  /** The analysis of the REPAIRED revision, as the worker would report it. */
  function analyseRepaired(store: WorkspaceStore, overrides: Partial<TopologyReport> = {}): void {
    act(() => {
      const token = store.beginAnalysis(REPAIRED, PART);
      store.commitAnalysis(
        token,
        REPAIRED,
        PART,
        report({ documentRevision: 2, ...overrides }),
        DETAIL,
        1,
      );
    });
  }

  /** The plan for the repaired revision: nothing further to do. */
  function planRepaired(store: WorkspaceStore): void {
    const plan: ConservativeRepairPlan = { ...planWith([]), sourceRevision: 2 };
    act(() => {
      const token = store.beginRepairPlan(REPAIRED, PART, plan.requested);
      store.commitRepairPlan(token, REPAIRED, plan, fillPlan(0));
    });
  }

  /** The truck's shape in miniature: openings, vertices and pieces remain. */
  const REMAINING: Partial<TopologyReport> = {
    boundaryEdgeCount: 44,
    simpleBoundaryLoopCount: 4,
    branchedBoundaryCount: 7,
    nonManifoldVertexCount: 155,
    componentCount: 39,
  };

  function partiallyRepaired(): WorkspaceStore {
    const store = renderWorkspace((s) => {
      loadModel(s);
      applied(s, true);
    });
    analyseRepaired(store, REMAINING);
    planRepaired(store);
    return store;
  }

  it('heads a repair that left detected issues "Partial repair completed"', () => {
    partiallyRepaired();
    const card = screen.getByTestId('repair-applied');
    expect(card).toHaveAttribute('data-outcome', 'partial');
    expect(screen.getByTestId('repair-applied-headline')).toHaveTextContent(
      'Partial repair completed',
    );
    expect(card).not.toHaveTextContent('Conservative repair applied');
    expect(screen.getByTestId('repair-applied-support')).toHaveTextContent(
      'Pybrix fixed everything it can currently repair safely on this model.',
    );
    // Not the all-green frame of a complete repair.
    expect(card).not.toHaveClass('repair-result--complete');
  });

  it('shows what was fixed and, separately, each category that remains', () => {
    partiallyRepaired();
    const card = screen.getByTestId('repair-applied');
    expect(card).toHaveTextContent('Fixed');
    expect(card).toHaveTextContent('Still needs attention');
    expect(screen.getByTestId('repair-applied-changes')).toHaveTextContent(
      '14 degenerate triangles removed',
    );
    expect(screen.getByTestId('repair-remaining-open-boundaries')).toHaveTextContent(
      '11 open boundaries',
    );
    expect(screen.getByTestId('repair-remaining-non-manifold-vertices')).toHaveTextContent(
      '155 non-manifold vertices',
    );
    expect(screen.getByTestId('repair-remaining-components')).toHaveTextContent(
      '39 separate components',
    );
    // Categories are never added up.
    expect(card).not.toHaveTextContent(/\b205\b/);
  });

  it('says what Pybrix can do about each remaining category, with its own severity', () => {
    partiallyRepaired();
    const vertices = screen.getByTestId('repair-remaining-non-manifold-vertices');
    expect(vertices).toHaveTextContent('Not automatically repairable');
    expect(vertices).toHaveClass('repair-result__remaining--error');
    expect(vertices).toHaveTextContent('(error)');
    const components = screen.getByTestId('repair-remaining-components');
    // Disconnected pieces are not declared broken.
    expect(components).toHaveTextContent('Review recommended — may be intentional');
    expect(components).toHaveClass('repair-result__remaining--warning');
    expect(screen.getByTestId('repair-remaining-open-boundaries')).toHaveTextContent(
      'Not automatically fillable',
    );
  });

  it('keeps Health authoritative, and marks its counts as what remains', () => {
    partiallyRepaired();
    const health = screen.getByTestId('health-summary');
    expect(health).toHaveTextContent('1 error · 2 warnings remaining');
    // Still the error tone: a repair having run does not turn Health green.
    expect(health).toHaveClass('health-summary--error');
  });

  it('explains the disabled action: supported repairs are exhausted, issues remain', () => {
    partiallyRepaired();
    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-no-repairs')).toHaveTextContent(
      'Everything Pybrix can safely repair automatically has been fixed.',
    );
    expect(screen.getByTestId('preview-repair')).toHaveAccessibleDescription(
      'Everything Pybrix can safely repair automatically has been fixed.',
    );
    fireEvent.click(screen.getByTestId('repair-no-repairs-info'));
    const detail = screen.getByTestId('repair-no-repairs-detail');
    expect(detail).toHaveTextContent(
      'Still detected: 11 open boundaries, 155 non-manifold vertices and 39 separate components.',
    );
    expect(detail).toHaveTextContent('repairing again would change nothing');
  });

  it('announces the outcome once, as one sentence, and not through the card', () => {
    partiallyRepaired();
    const status = screen.getByTestId('repair-applied-status');
    expect(status).toHaveTextContent(
      'Partial repair completed. 14 degenerate triangles removed. Some detected issues remain.',
    );
    expect(status.closest('[aria-live]')).not.toBeNull();
    expect(screen.getAllByTestId('repair-applied-status')).toHaveLength(1);
    // The card is a labelled group, not a second live region.
    const card = screen.getByTestId('repair-applied');
    expect(card).toHaveAttribute('role', 'group');
    expect(card.closest('[aria-live]')).toBeNull();
    expect(screen.getAllByTestId('repair-applied')).toHaveLength(1);
  });

  it('keeps the remaining section while the repaired mesh is still being checked', () => {
    // Absent is a claim: it is drawn only once the new analysis says nothing remains.
    renderWorkspace((s) => {
      loadModel(s);
      applied(s, true);
    });
    const card = screen.getByTestId('repair-applied');
    expect(card).toHaveAttribute('data-outcome', 'checking');
    expect(card).toHaveTextContent('Still needs attention');
    expect(screen.getByTestId('repair-applied-remaining')).toHaveTextContent(
      'Checking the repaired mesh…',
    );
  });

  it('shows both sections for a partial repair', () => {
    partiallyRepaired();
    const card = screen.getByTestId('repair-applied');
    expect(card.querySelectorAll('.repair-result__label')).toHaveLength(2);
    expect(card).toHaveTextContent('Fixed');
    expect(card).toHaveTextContent('Still needs attention');
    expect(screen.getByTestId('repair-applied-remaining').children).toHaveLength(3);
  });

  it('announces nothing while the repaired mesh is still being checked', () => {
    renderWorkspace((s) => {
      loadModel(s);
      applied(s, true);
    });
    expect(screen.queryByTestId('repair-applied-status')).toBeNull();
    expect(screen.getByTestId('repair-applied-remaining')).toHaveTextContent(
      'Checking the repaired mesh…',
    );
  });

  it('heads a repair that left nothing detected "Repair completed"', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
      applied(s, true);
    });
    analyseRepaired(store);
    planRepaired(store);

    const card = screen.getByTestId('repair-applied');
    expect(card).toHaveAttribute('data-outcome', 'complete');
    expect(screen.getByTestId('repair-applied-headline')).toHaveTextContent('Repair completed');
    expect(screen.getByTestId('repair-applied-headline')).not.toHaveTextContent('Partial');
    expect(screen.getByTestId('repair-applied-support')).toHaveTextContent(
      'No detected issues remain in the checks Pybrix ran.',
    );
    // FIXED is shown; nothing claims attention, so that section is not drawn.
    expect(card).toHaveTextContent('Fixed');
    expect(screen.getByTestId('repair-applied-changes')).toHaveTextContent(
      '14 degenerate triangles removed',
    );
    expect(screen.queryByTestId('repair-applied-remaining')).toBeNull();
    expect(card).not.toHaveTextContent('Still needs attention');
    // And no placeholder row stands in for it.
    expect(card).not.toHaveTextContent(/No issue types|None found|Nothing remains/i);
    expect(card.querySelectorAll('.repair-result__label')).toHaveLength(1);
    // The qualifier still travels with it: unchecked is not passed. The absent
    // section says nothing about the checks that did not run.
    expect(screen.getByTestId('repair-applied-qualifier')).toHaveTextContent(REPAIR_QUALIFIER);
    expect(screen.getByTestId('repair-applied-qualifier')).toHaveTextContent(
      'Self-intersections and wall thickness have not yet been checked.',
    );
    expect(screen.getByTestId('undo-repair')).toBeEnabled();
    // One coherent sentence, with nothing about attention in it.
    const status = screen.getByTestId('repair-applied-status');
    expect(status).toHaveTextContent(
      'Repair completed. 14 degenerate triangles removed. No detected issues remain in the checks Pybrix ran.',
    );
    expect(status).not.toHaveTextContent(/attention/i);
    // Nothing remains, so Health does not say "remaining" and the reason is the plain one.
    expect(screen.getByTestId('health-summary')).toHaveTextContent(/^No issues found$/);
    expect(screen.getByTestId('repair-no-repairs')).toHaveTextContent(NO_REPAIRABLE_PROBLEMS);
  });

  it('shows no outcome and no "remaining" for a model no repair was applied to', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 3 });
    commitPlan(store, planWith([]));

    expect(screen.queryByTestId('repair-applied')).toBeNull();
    expect(screen.queryByTestId('repair-applied-status')).toBeNull();
    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.getByTestId('repair-no-repairs')).toHaveTextContent(NO_SAFE_REPAIRS);
    const health = screen.getByTestId('health-summary');
    expect(health).toHaveTextContent(/^1 error · 0 warnings$/);
    expect(health).toHaveClass('health-summary--error');
  });

  it('clears every post-repair wording when the repair is undone', () => {
    const store = partiallyRepaired();
    const restored = { documentId: 'model-1', revision: 3 } as DocumentHandle;
    act(() => {
      store.beginRepairUndo();
      store.applyUndoResult({
        handle: restored,
        partId: PART,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        parts: [partDescriptor()],
        bounds: undefined,
        triangleCount: 4,
        vertexCount: 12,
        residentBytes: 192,
      });
    });
    act(() => {
      const token = store.beginAnalysis(restored, PART);
      store.commitAnalysis(
        token,
        restored,
        PART,
        report({ documentRevision: 3, ...REMAINING, boundaryEdgeCount: 52 }),
        DETAIL,
        1,
      );
      const plan: ConservativeRepairPlan = { ...planWith([]), sourceRevision: 3 };
      const planToken = store.beginRepairPlan(restored, PART, plan.requested);
      store.commitRepairPlan(planToken, restored, plan, fillPlan(0));
    });

    expect(screen.queryByTestId('repair-applied')).toBeNull();
    expect(screen.queryByTestId('repair-applied-status')).toBeNull();
    expect(screen.getByTestId('health-summary')).toHaveTextContent(/^1 error · 2 warnings$/);
    // No stale "everything Pybrix can fix has been fixed", drawn or spoken.
    expect(screen.getByTestId('repair-workspace')).not.toHaveTextContent('has been fixed');
    expect(screen.getByTestId('repair-workspace')).not.toHaveTextContent('Partial repair');
  });

  it('clears every post-repair wording when another model is opened', () => {
    const store = partiallyRepaired();
    act(() => {
      loadModel(store);
    });
    analyse(store, { nonManifoldVertexCount: 2 });
    commitPlan(store, planWith([]));

    expect(screen.queryByTestId('repair-applied')).toBeNull();
    expect(screen.queryByTestId('repair-applied-status')).toBeNull();
    expect(screen.getByTestId('health-summary')).toHaveTextContent(/^1 error · 0 warnings$/);
    expect(screen.getByTestId('repair-no-repairs')).toHaveTextContent(NO_SAFE_REPAIRS);
  });

  it('shows one result, with current counts, when a repair is applied again', () => {
    const store = partiallyRepaired();
    act(() => {
      store.applyRepairResult({
        handle: { documentId: 'model-1', revision: 3 } as DocumentHandle,
        partId: PART,
        parts: [partDescriptor()],
        parentRevision: 2,
        recordId: 'record-2',
        appliedOperations: [RepairOperation.RemoveDuplicateFaces],
        counts: {
          removedDuplicateFaces: 3,
          removedRepeatedPositionFaces: 0,
          removedZeroAreaFaces: 0,
          flippedFaces: 0,
          sourceFaceCount: 7,
          candidateFaceCount: 4,
        },
        undoable: true,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        bounds: undefined,
        triangleCount: 4,
        vertexCount: 12,
        residentBytes: 192,
      });
    });

    expect(screen.getAllByTestId('repair-applied')).toHaveLength(1);
    const changes = screen.getByTestId('repair-applied-changes');
    expect(changes).toHaveTextContent('3 duplicate triangles removed');
    expect(changes).not.toHaveTextContent('degenerate');
    // The earlier outcome is not carried over: this revision is not analysed yet.
    expect(screen.getByTestId('repair-applied')).toHaveAttribute('data-outcome', 'checking');
    expect(screen.queryByTestId('repair-applied-status')).toBeNull();
    expect(screen.getByTestId('health-summary')).not.toHaveTextContent('remaining');
  });
});

/* ------------------------------------------------------- REPAIR-CORE-06B -- */

describe('the 06B repair experience', () => {
  const NOOP_PLAN = planWith([]);
  const localPlan = (limitLikely: boolean): LocalRepairPlan => ({
    requested: true,
    pinchedVertices: 5,
    eligible: 5,
    unsupportedNonManifoldEdge: 0,
    byClass: {},
    workLimit: { primary: 1_200_000, residual: 40_000 },
    estimatedWorkLowerBound: 45,
    limitLikely,
    planHash: 'lr-1',
  });
  const commitLocalPlan = (store: WorkspaceStore, limitLikely: boolean): void => {
    act(() => {
      const token = store.beginRepairPlan(HANDLE, PART, DEGENERATE_PLAN.requested);
      store.commitRepairPlan(token, HANDLE, NOOP_PLAN, fillPlan(0), localPlan(limitLikely));
    });
  };

  it('offers Repair when the only work is a local repair, with no option to choose it', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 5, isVertexManifold: false });
    commitLocalPlan(store, false);
    expect(screen.getByTestId('preview-repair')).toBeEnabled();
    expect(screen.getByTestId('issue-status-non-manifold-vertices')).toHaveTextContent(
      'Repair available',
    );
    // There is no Local Repair control and no algorithm name anywhere on screen.
    expect(screen.queryByText(/local repair/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/LS-A2|surgery|retriangulat|geogram/i);
  });

  it('limitLikely is a subtle advisory and never disables or pre-judges Repair', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 5, isVertexManifold: false });
    commitLocalPlan(store, true);
    expect(screen.getByTestId('repair-limit-advisory')).toHaveTextContent(
      'unusually complex. Automatic repair may be limited.',
    );
    expect(screen.getByTestId('preview-repair')).toBeEnabled();
    // It never shows a limit outcome before the engine has returned one.
    expect(screen.queryByTestId('repair-summary')).toBeNull();
    expect(document.body.textContent).not.toMatch(/too complex for this automatic repair pass/);
  });

  it('shows no advisory when the plan does not say the model is complex', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 5, isVertexManifold: false });
    commitLocalPlan(store, false);
    expect(screen.queryByTestId('repair-limit-advisory')).toBeNull();
  });

  it('presents a no-safe-change result as a neutral note, never an alert', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { nonManifoldVertexCount: 5, isVertexManifold: false });
    commitLocalPlan(store, false);
    act(() => {
      const token = store.beginRepairPreview();
      if (token === undefined) throw new Error('no token');
      store.beginRepairCandidate(token);
      store.failRepairCandidate(token, {
        message:
          'Pybrix couldn’t safely repair these issues automatically. Your model is unchanged.',
        code: NO_SAFE_CHANGE_CODE,
        retryable: false,
      });
    });
    const note = screen.getByTestId('repair-no-safe-change');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveTextContent('Your model is unchanged');
    expect(screen.queryByTestId('repair-candidate-error')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('repair-no-safe-change-line')).toBeInTheDocument();
    expect(screen.queryByTestId('repair-failure-line')).toBeNull();
  });

  it('still presents a real failure as an alert', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    act(() => {
      const token = store.beginRepairPreview();
      if (token === undefined) throw new Error('no token');
      store.beginRepairCandidate(token);
      store.failRepairCandidate(token, {
        message: 'The repair worker stopped unexpectedly.',
        code: 'INTERNAL_ERROR',
        retryable: true,
      });
    });
    expect(screen.getByTestId('repair-candidate-error')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('repair-no-safe-change')).toBeNull();
  });

  it('shows honest stage progress while building, with no percentage', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    act(() => {
      const token = store.beginRepairPreview();
      if (token === undefined) throw new Error('no token');
      store.beginRepairCandidate(token);
      store.reportRepairProgress(token, 0.62, 'repairing pinched vertices');
    });
    expect(screen.getByTestId('repair-phase')).toHaveTextContent('Building a safe repair…');
    expect(screen.queryByTestId('repair-percent')).toBeNull();
    expect(document.body.textContent).not.toMatch(/62\s*%/);
    // The bar is indeterminate: it has no value to claim.
    expect(screen.getByLabelText('Repair in progress')).not.toHaveAttribute('value');
    expect(screen.getByTestId('cancel-repair')).toBeEnabled();
  });

  it('summarises what is fixed and what remains, and says which model each count describes', () => {
    const store = renderWorkspace((s) => {
      loadModel(s);
    });
    analyse(store, { zeroAreaFaceCount: 2 });
    commitPlan(store, DEGENERATE_PLAN);
    commitPreview(store);
    expect(screen.getByTestId('repair-summary-headline')).toHaveTextContent('Ready to apply');
    expect(screen.getByTestId('repair-summary-fixed')).toHaveTextContent('2 degenerate');
    expect(screen.getByTestId('repair-summary-current')).toBeInTheDocument();
    expect(screen.getByTestId('repair-summary-after')).toBeInTheDocument();
    // The Health line still describes the committed model, not the candidate.
    expect(screen.getByTestId('health-summary')).not.toHaveTextContent(/remaining/);
  });
});
