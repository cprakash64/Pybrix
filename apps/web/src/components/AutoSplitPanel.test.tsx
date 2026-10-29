import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import {
  analyzeError,
  AnalyzeErrorCode,
  PROTOCOL_VERSIONS,
  VIEW_NAMES,
  type AnalyzeRequest,
  type ParsedResponse,
} from '@cadfixer/auto-split-contract';
import {
  SuggestionOperation,
  SuggestionReason,
  SuggestionStatus,
  type Suggestion,
} from '@cadfixer/auto-split';
import type {
  AutoSplitRenderResult,
  AutoSplitSuggestResult,
  DocumentHandle,
  DocumentRenderSnapshot,
  PartDescriptor,
  SplitCreateResult,
} from '@cadfixer/geometry-runtime';
import { SplitHud } from './SplitHud';
import { SplitWorkspace } from './SplitWorkspace';
import { ShellLayoutProvider } from './shell/shell-layout';
import { GeometryClientProvider } from '../runtime/client-context';
import { GeometryClient } from '../runtime/geometry-client';
import type { AnalysisTransport } from '../runtime/auto-split-transport';
import { WorkspaceProvider } from '../state/store-context';
import { SplitControlsProvider } from '../state/workflow-controllers';
import { WorkspaceStore } from '../state/workspace-store';
import { WorkflowId } from '../state/workflows';
import type { LoadedModel } from '../state/model';
import { AUTO_SPLIT_COPY } from '../state/auto-split-presentation';
import { invalidState, resourceLimitExceeded } from '@cadfixer/shared';

/**
 * AUTO SPLIT AT COMPONENT LEVEL: the flow a person actually goes through, with the geometry worker and
 * the network replaced by doubles that the test settles by hand.
 *
 * What it proves is order and consequence: nothing is sent before the disclosure is accepted, Cancel
 * aborts, a suggestion is a setting of Manual Split's own controls, a preview is asked for and an Apply is
 * never made on its own, and a part that cannot be split offers no way to try.
 */

afterEach(cleanup);

const PART_ID = 'p1';

function part(triangleCount = 12): PartDescriptor {
  return {
    partId: PART_ID,
    name: 'Figure',
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount,
    vertexCount: 8,
    bounds: {
      min: [0, 0, 0],
      max: [40, 20, 104],
      size: [40, 20, 104],
      center: [20, 10, 52],
      radius: 60,
    },
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

function load(store: WorkspaceStore, triangleCount = 12): void {
  const handle = { documentId: 'doc-1', revision: 1 } as DocumentHandle;
  const parts = [part(triangleCount)];
  const renderSnapshot: DocumentRenderSnapshot = {
    parts: parts.map((p) => ({
      partId: p.partId,
      transform: p.transform,
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      vertexCount: 3,
    })),
  };
  const model: Omit<LoadedModel, 'revision'> = {
    handle,
    parts,
    render: renderSnapshot,
    source: {
      fileName: 'figure.3mf',
      fileBytes: 100,
      formatId: '3mf',
      encoding: '3mf',
      unit: 'millimeter',
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount,
    vertexCount: 8,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 1,
  };
  const token = store.beginImport(model.source.fileName);
  store.commitImport(token, model);
  store.selectWorkflow(WorkflowId.Split);
}

const HEAD: Suggestion = {
  id: 'head',
  family: 'head',
  label: 'Head',
  operation: SuggestionOperation.Plane,
  status: SuggestionStatus.Suggested,
  reason: SuggestionReason.Clear,
  plane: { origin: [20, 10, 80], normal: [0, 0, 1] },
  components: [],
};
const ARM: Suggestion = {
  id: 'left_arm',
  family: 'arm',
  label: 'Left arm',
  operation: SuggestionOperation.Plane,
  status: SuggestionStatus.NeedsAdjustment,
  reason: SuggestionReason.ReviewCut,
  plane: { origin: [28, 10, 60], normal: [1, 0, 0] },
  components: [],
};
const WHEEL: Suggestion = {
  id: 'wheel:wheel_1',
  family: 'wheel',
  label: 'Front-left wheel',
  operation: SuggestionOperation.Component,
  status: SuggestionStatus.Suggested,
  reason: SuggestionReason.Clear,
  plane: null,
  components: [1],
};
const GONE: Suggestion = {
  id: 'right_arm',
  family: 'arm',
  label: 'Right arm',
  operation: SuggestionOperation.None,
  status: SuggestionStatus.Unavailable,
  reason: SuggestionReason.NotLocated,
  plane: null,
  components: [],
};

interface Spies {
  readonly store: WorkspaceStore;
  readonly transport: ReturnType<typeof vi.fn<AnalysisTransport['analyze']>>;
  readonly render: ReturnType<typeof vi.fn>;
  readonly suggest: ReturnType<typeof vi.fn>;
  readonly createSplit: ReturnType<typeof vi.fn>;
  readonly createComponentSplit: ReturnType<typeof vi.fn>;
  readonly commitSplit: ReturnType<typeof vi.fn>;
  readonly confirmSplitScope: ReturnType<typeof vi.fn>;
  readonly requests: AnalyzeRequest[];
  readonly signals: AbortSignal[];
}

function okResponse(mode: 'human' | 'vehicle' | 'semantic'): ParsedResponse {
  if (mode === 'semantic')
    return {
      ok: true,
      analysis: {
        mode,
        requestId: 'req-test-0001',
        protocolVersion: PROTOCOL_VERSIONS.semantic,
        semantic: { object: { label: 'assembly', confidence: 1 }, parts: [] },
        raw: {},
      },
    };
  return {
    ok: true,
    analysis:
      mode === 'human'
        ? {
            mode,
            requestId: 'req-test-0001',
            protocolVersion: PROTOCOL_VERSIONS.human,
            human: {} as never,
            raw: { an: 'answer' },
          }
        : {
            mode,
            requestId: 'req-test-0001',
            protocolVersion: PROTOCOL_VERSIONS.vehicle,
            vehicle: {} as never,
            raw: { an: 'answer' },
          },
  };
}

const VIEWS: AutoSplitRenderResult = {
  source: { documentId: 'doc-1', revision: 1 } as DocumentHandle,
  partId: PART_ID,
  pngs: VIEW_NAMES.map(() => new Uint8Array([137, 80, 78, 71])),
  summary: { extents: [1, 0.5, 0.25], shells: 5, radius: 0.6 },
};

interface Options {
  readonly suggestions?: readonly Suggestion[];
  readonly sourceReasons?: readonly string[];
  readonly response?: (request: AnalyzeRequest, signal: AbortSignal) => Promise<ParsedResponse>;
  /** The active part's triangle count, as its descriptor reports it. */
  readonly triangleCount?: number;
  /** What the exact split's preview rejects with, when it should. */
  readonly previewRejects?: unknown;
}

function mount(options: Options = {}): Spies {
  const store = new WorkspaceStore();
  load(store, options.triangleCount);
  const requests: AnalyzeRequest[] = [];
  const signals: AbortSignal[] = [];
  const transport = vi.fn<AnalysisTransport['analyze']>((request, signal) => {
    requests.push(request);
    signals.push(signal);
    return options.response === undefined
      ? Promise.resolve(okResponse(request.mode))
      : options.response(request, signal);
  });
  const render = vi.fn(() => ({ promise: Promise.resolve(VIEWS), cancel: (): void => undefined }));
  const suggest = vi.fn((_source: DocumentHandle, _part: string, mode: 'human' | 'vehicle') => ({
    promise: Promise.resolve<AutoSplitSuggestResult>({
      source: VIEWS.source,
      partId: PART_ID,
      mode,
      suggestions: options.suggestions ?? [HEAD, ARM, GONE],
      components: [
        { rank: 0, areaShare: 0.7, faces: 100 },
        { rank: 1, areaShare: 0.1, faces: 20 },
        { rank: 2, areaShare: 0.1, faces: 20 },
      ],
      componentCount: 3,
      faceCount: 140,
      sourceReasons: options.sourceReasons ?? [],
    }),
    cancel: (): void => undefined,
  }));
  const never = (): { promise: Promise<never>; cancel: () => void } => ({
    promise: new Promise<never>(() => undefined),
    cancel: (): void => undefined,
  });
  const createSplit = vi.fn(() =>
    options.previewRejects === undefined
      ? never()
      : { promise: Promise.reject(options.previewRejects as Error), cancel: (): void => undefined },
  );
  const createComponentSplit = vi.fn(never);
  const commitSplit = vi.fn(never);
  const confirmSplitScope = vi.fn(never);
  const client = Object.assign(new GeometryClient({ onDiagnostic: (): void => undefined }), {
    renderAutoSplitViews: render,
    suggestAutoSplit: suggest,
    autoSplitComponentFaces: vi.fn(() => ({
      promise: Promise.resolve({
        source: VIEWS.source,
        partId: PART_ID,
        faces: new Uint32Array([1]),
      }),
      cancel: (): void => undefined,
    })),
    createSplit,
    createComponentSplit,
    commitSplit,
    confirmSplitScope,
  });
  let n = 0;
  render_(store, client, transport, () => `req-test-${String((n += 1)).padStart(4, '0')}`);
  return {
    store,
    transport,
    render,
    suggest,
    createSplit,
    createComponentSplit,
    commitSplit,
    confirmSplitScope,
    requests,
    signals,
  };
}

function render_(
  store: WorkspaceStore,
  client: GeometryClient,
  transport: AnalysisTransport['analyze'],
  newRequestId: () => string,
): void {
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <ShellLayoutProvider>
          <SplitControlsProvider autoSplit={{ transport: { analyze: transport }, newRequestId }}>
            <SplitWorkspace />
            <SplitHud />
          </SplitControlsProvider>
        </ShellLayoutProvider>
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
}

// Paint is verified in Chromium; component tests advance this boundary deterministically.
vi.mock('../state/after-paint', () => ({ afterPaint: (): Promise<void> => Promise.resolve() }));

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
};
const click = (testId: string): void => {
  fireEvent.click(screen.getByTestId(testId));
};
async function openAuto(): Promise<void> {
  click('split-tab-auto');
  await settle();
}
async function chooseAndAccept(kind: 'human' | 'vehicle' = 'human'): Promise<void> {
  await openAuto();
  click(`auto-kind-${kind}`);
  await settle();
  click('auto-disclosure-continue');
  await settle();
}
async function findParts(kind: 'human' | 'vehicle' = 'human'): Promise<void> {
  await chooseAndAccept(kind);
  click('auto-analyze');
  await settle();
}

describe('boundary option preview', () => {
  it('loads only the explicit option without connectors or an automatic commit', async () => {
    const alternative = (
      index: number,
    ): NonNullable<Suggestion['boundaryConfirmation']>['alternatives'][number] => ({
      id: `head:boundary:${String(index)}`,
      plane: { normal: [0, 0, 1] as const, origin: [0, 0, 80 + index] as const },
      selectedSide: 'POSITIVE' as const,
      nativeProof: {
        valid: true as const,
        sourcePreserved: true as const,
        partitionCount: 2 as const,
      },
      previewMetadata: { label: index === 0 ? ('Option A' as const) : ('Option B' as const) },
    });
    const spies = mount({
      suggestions: [
        {
          ...HEAD,
          family: 'semantic',
          operation: 'NONE',
          plane: null,
          status: SuggestionStatus.NeedsBoundaryConfirmation,
          quality: 'NEEDS_BOUNDARY_CONFIRMATION',
          semanticPreparationId: 7,
          boundaryConfirmation: {
            status: 'NEEDS_BOUNDARY_CONFIRMATION',
            targetId: 'head',
            route: 'STRUCTURAL_SEAM',
            ambiguityReason: 'UNRESOLVED_INTERFACE_OWNERSHIP',
            alternatives: [alternative(0), alternative(1)],
          },
        },
      ],
    });
    await findParts();
    expect(screen.getByTestId('auto-row-status-head')).toHaveTextContent('Choose a boundary');
    expect(screen.queryByTestId('auto-preview-head')).toBeNull();
    expect(screen.queryByTestId('auto-boundary-confirm-head')).toBeNull();
    spies.createSplit.mockReturnValue({
      promise: Promise.resolve({
        candidate: { documentId: 'doc-1', generation: 1, candidateId: 'option-b' },
        render: { parts: [] },
        parts: [],
        pieceAId: 'a',
        pieceBId: 'b',
        metrics: { pieceAFinalVolume: 1, pieceBFinalVolume: 1, volumeRelativeError: 0 },
        section: { area: 1, loopCount: 1 },
        connector: { kind: 'none' },
        semanticQualification: {
          preparationId: 7,
          candidateId: 'head',
          boundaryAlternativeId: 'head:boundary:1',
          boundaryChoice: 'PREVIEW',
          plane: alternative(1).plane,
          attempts: 1,
          failures: 0,
          winnerIndex: 0,
          milliseconds: 1,
        },
      } as unknown as SplitCreateResult),
      cancel: (): void => undefined,
    });
    click('auto-boundary-head-1');
    await settle();
    expect(spies.createSplit).toHaveBeenCalledTimes(1);
    const call = spies.createSplit.mock.calls[0] as unknown as [
      DocumentHandle,
      string,
      { connector: { kind: string }; plane: { origin: number[] } },
      unknown,
      unknown,
    ];
    expect(call[2].connector).toEqual({ kind: 'none' });
    expect(call[2].plane.origin[2]).toBeCloseTo(81, 6);
    expect(call[4]).toEqual({
      preparationId: 7,
      candidateId: 'head',
      boundaryAlternativeId: 'head:boundary:1',
      boundaryChoice: 'PREVIEW',
    });
    expect(screen.getByTestId('auto-boundary-confirm-head')).toBeVisible();
    expect(screen.getByTestId('auto-boundary-head-0')).toBeVisible();
    expect(screen.getByTestId('split-apply')).toBeDisabled();
    click('split-apply');
    expect(spies.commitSplit).not.toHaveBeenCalled();
  });
});

describe('the tabs', () => {
  it('opens on Manual Split, with the Beta badge on the Auto Split tab, and neither tab sends anything', async () => {
    const spies = mount();
    expect(screen.getByTestId('split-tab-manual')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('split-position-slider')).toBeInTheDocument();
    expect(screen.getByTestId('auto-beta-badge')).toHaveTextContent('Beta');
    await openAuto();
    expect(screen.getByTestId('auto-tagline')).toHaveTextContent(AUTO_SPLIT_COPY.tagline);
    click('split-tab-manual');
    expect(screen.getByTestId('split-position-slider')).toBeInTheDocument();
    expect(spies.transport).not.toHaveBeenCalled();
    expect(spies.render).not.toHaveBeenCalled();
    expect(spies.suggest).not.toHaveBeenCalled();
  });

  it('is a real tablist: the selected tab is the only one in the tab order, and arrows move between them', async () => {
    mount();
    const auto = screen.getByTestId('split-tab-auto');
    const manual = screen.getByTestId('split-tab-manual');
    expect(screen.getByRole('tablist', { name: 'Split mode' })).toBeInTheDocument();
    expect(manual).toHaveAttribute('tabindex', '0');
    expect(auto).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(manual, { key: 'ArrowLeft' });
    await settle();
    expect(auto).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the disclosure comes before anything is sent', () => {
  it('asks first, with the approved text, and sends nothing until Continue and Find parts', async () => {
    const spies = mount();
    await openAuto();
    click('auto-kind-human');
    await settle();
    expect(screen.getByTestId('auto-disclosure-text')).toHaveTextContent(
      AUTO_SPLIT_COPY.disclosure,
    );
    expect(screen.queryByTestId('auto-analyze')).toBeNull();
    expect(spies.transport).not.toHaveBeenCalled();
    click('auto-disclosure-continue');
    await settle();
    expect(spies.transport).not.toHaveBeenCalled();
    expect(spies.render).not.toHaveBeenCalled();
    click('auto-analyze');
    await settle();
    expect(spies.render).toHaveBeenCalledTimes(1);
    expect(spies.transport).toHaveBeenCalledTimes(1);
  });

  it('Cancel declines: nothing was sent, and the person is on Manual Split', async () => {
    const spies = mount();
    await openAuto();
    click('auto-kind-vehicle');
    await settle();
    click('auto-disclosure-cancel');
    await settle();
    expect(screen.getByTestId('split-tab-manual')).toHaveAttribute('aria-selected', 'true');
    expect(spies.transport).not.toHaveBeenCalled();
  });

  it('the Manual shortcut offers local Manual Split and never asks for consent', async () => {
    const spies = mount();
    await openAuto();
    click('auto-kind-other');
    await settle();
    expect(screen.getByTestId('auto-other')).toBeInTheDocument();
    expect(screen.queryByTestId('auto-disclosure')).toBeNull();
    expect(screen.queryByTestId('auto-analyze')).toBeNull();
    click('auto-open-manual');
    await settle();
    expect(screen.getByTestId('split-tab-manual')).toHaveAttribute('aria-selected', 'true');
    expect(spies.transport).not.toHaveBeenCalled();
  });
});

describe('focus and scope', () => {
  it('moves focus to Find parts when the disclosure is accepted, and to Manual Split when it is cancelled', async () => {
    mount();
    await openAuto();
    click('auto-kind-human');
    await settle();
    click('auto-disclosure-continue');
    await settle();
    expect(screen.getByTestId('auto-analyze')).toHaveFocus();

    cleanup();
    mount();
    await openAuto();
    click('auto-kind-vehicle');
    await settle();
    click('auto-disclosure-cancel');
    await settle();
    expect(screen.getByTestId('split-tab-manual')).toHaveFocus();
  });

  it('names the part an analysis looks at, and Re-analyze says it means that part', async () => {
    mount();
    await openAuto();
    expect(screen.getByTestId('auto-part')).toHaveTextContent('Figure');
    await findParts('human');
    expect(screen.getByTestId('auto-reanalyze-fresh')).toHaveTextContent('Find again');
  });
});

describe('an analysis', () => {
  it('sends six views and three numbers, nothing else, and lists the suggestions with their statuses', async () => {
    const spies = mount();
    await findParts('human');
    const request = spies.requests[0];
    expect(Object.keys(request ?? {}).sort()).toEqual([
      'mode',
      'protocolVersion',
      'requestId',
      'summary',
      'views',
    ]);
    expect(request?.views).toHaveLength(6);
    expect(request?.mode).toBe('human');
    expect(screen.getByTestId('auto-row-status-head')).toHaveTextContent('Suggested');
    expect(screen.getByTestId('auto-row-status-left_arm')).toHaveTextContent('Suggested cut');
    expect(screen.getByTestId('auto-row-status-right_arm')).toHaveTextContent(
      'No separate part found',
    );
    expect(screen.getByTestId('auto-preview-right_arm')).toBeDisabled();
    expect(screen.getByTestId('auto-edit-right_arm')).toBeDisabled();
    // No number reads as confidence anywhere in the list.
    expect(screen.getByTestId('auto-results').textContent).not.toMatch(/\d\s*%|confidence/i);
    // READY IS NOT APPLIED.
    expect(spies.commitSplit).not.toHaveBeenCalled();
    expect(spies.createSplit).not.toHaveBeenCalled();
  });

  it('shows honest progress with Cancel, and Cancel aborts the request and leaves the model alone', async () => {
    const pending = new Promise<ParsedResponse>(() => undefined);
    const spies = mount({ response: () => pending });
    await findParts('human');
    expect(screen.getByTestId('auto-progress')).toBeInTheDocument();
    expect(screen.getByTestId('auto-status')).toHaveTextContent('Looking for parts…');
    expect(screen.getByTestId('split-footer')).not.toHaveTextContent('Find parts first');
    expect(screen.getByTestId('auto-progress').textContent).not.toMatch(/\d\s*%/);
    expect(spies.signals[0]?.aborted).toBe(false);
    click('auto-cancel');
    await settle();
    expect(spies.signals[0]?.aborted).toBe(true);
    expect(screen.getByTestId('auto-cancelled')).toHaveTextContent('Your model was not changed');
    expect(screen.queryByTestId('auto-progress')).toBeNull();
    expect(spies.commitSplit).not.toHaveBeenCalled();
  });

  it('the footer says what its Cancel cancels while an analysis runs, and it cancels only that', async () => {
    const pending = new Promise<ParsedResponse>(() => undefined);
    const spies = mount({ response: () => pending });
    await findParts('human');
    expect(screen.queryByTestId('split-cancel')).toBeNull();
    expect(screen.getByTestId('split-cancel-analysis')).toHaveTextContent('Cancel analysis');
    click('split-cancel-analysis');
    await settle();
    expect(spies.signals[0]?.aborted).toBe(true);
    // The split workspace is still open: only the analysis was cancelled.
    expect(screen.getByTestId('split-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('auto-cancelled')).toBeInTheDocument();
    expect(screen.getByTestId('split-cancel')).toBeInTheDocument();
  });

  it('a service-wide capacity refusal reads as such, says nothing about counts, and leaves the other workflows alone', async () => {
    mount({
      response: () =>
        Promise.resolve({
          ok: false,
          error: analyzeError(AnalyzeErrorCode.AtCapacity, 600),
        } satisfies ParsedResponse),
    });
    await findParts('human');
    const error = screen.getByTestId('auto-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('auto-error-message')).toHaveTextContent(
      'Auto Split is temporarily at capacity. Try again later.',
    );
    expect(screen.getByTestId('auto-error-detail')).toHaveTextContent(
      'Repair and Manual Split are not affected.',
    );
    expect(error.textContent).not.toMatch(/\d|minute|hour|limit|cost/i);
    expect(within(error).getByTestId('auto-try-again')).toBeInTheDocument();
    // Manual Split is still right there.
    fireEvent.click(screen.getByTestId('split-tab-manual'));
    expect(screen.getByTestId('split-preview')).toBeEnabled();
  });

  it('turns a failure into a decision with our own sentence and a way forward', async () => {
    mount({
      response: () =>
        Promise.resolve({
          ok: false,
          error: analyzeError(AnalyzeErrorCode.RateLimited, 600),
        } satisfies ParsedResponse),
    });
    await findParts('human');
    const error = screen.getByTestId('auto-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('auto-error-message')).toHaveTextContent(
      analyzeError(AnalyzeErrorCode.RateLimited).message,
    );
    expect(screen.getByTestId('auto-error-detail')).toHaveTextContent(
      'Try again in about 10 minutes.',
    );
    expect(within(error).getByTestId('auto-try-again')).toBeInTheDocument();
    click('auto-start-over');
    await settle();
    expect(screen.queryByTestId('auto-error')).toBeNull();
    expect(screen.getByTestId('auto-analyze')).toBeInTheDocument();
  });
});

describe('a suggestion is a setting of Manual Split, and a preview is asked for, never an Apply', () => {
  it('Edit loads the cut into the manual plane controls and makes no preview', async () => {
    const spies = mount();
    await findParts('human');
    click('auto-edit-head');
    await settle();
    // The manual plane editor is shown, holding the suggested height (z = 80).
    expect(screen.getByTestId('split-position-slider')).toHaveValue('80');
    expect(screen.getByTestId('auto-row-head')).toHaveAttribute('data-selected', 'true');
    expect(spies.createSplit).not.toHaveBeenCalled();
    expect(spies.commitSplit).not.toHaveBeenCalled();
  });

  it('Preview loads the cut and asks the existing split operation for a preview with exactly that plane', async () => {
    const spies = mount();
    await findParts('human');
    click('auto-preview-head');
    await settle();
    expect(spies.createSplit).toHaveBeenCalledTimes(1);
    const call = spies.createSplit.mock.calls[0] as unknown as [
      DocumentHandle,
      string,
      { plane: { origin: number[]; normal: number[] }; connector: { kind: string } },
    ];
    expect(call[1]).toBe(PART_ID);
    expect(call[2].plane.origin[2]).toBeCloseTo(80, 6);
    expect(call[2].plane.normal).toEqual([0, 0, 1]);
    expect(call[2].connector).toEqual({ kind: 'automatic', unit: 'millimeter' });
    expect(screen.getByTestId('auto-preview-head')).toBeDisabled();
    expect(screen.getByTestId('auto-preview-left_arm')).toBeDisabled();
    expect(screen.getByTestId('split-preview')).toBeDisabled();
    // Previewing is not applying.
    expect(spies.commitSplit).not.toHaveBeenCalled();
  });

  it('one suggestion at a time: choosing another moves the manual plane to it', async () => {
    mount();
    await findParts('human');
    click('auto-edit-head');
    await settle();
    expect(screen.getByTestId('split-position-slider')).toHaveValue('80');
    click('auto-edit-left_arm');
    await settle();
    expect(screen.getByTestId('auto-row-left_arm')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('auto-row-head')).toHaveAttribute('data-selected', 'false');
    // The arm's cut is across X, at x = 28.
    expect(screen.getByTestId('split-position-slider')).toHaveValue('28');
  });

  it('a component suggestion previews through the component operation, with the user’s corrected selection', async () => {
    const spies = mount({ suggestions: [WHEEL] });
    await findParts('vehicle');
    click('auto-edit-wheel:wheel_1');
    await settle();
    expect(screen.getByTestId('auto-components')).toBeInTheDocument();
    expect(screen.getByTestId('auto-component-1')).toBeChecked();
    fireEvent.click(screen.getByTestId('auto-component-2'));
    await settle();
    click('auto-preview-selection');
    await settle();
    expect(spies.createComponentSplit).toHaveBeenCalledTimes(1);
    expect(spies.createComponentSplit.mock.calls[0]?.[2]).toEqual([1, 2]);
    expect(spies.createSplit).not.toHaveBeenCalled();
    expect(spies.commitSplit).not.toHaveBeenCalled();
  });
});

describe('the manual cut plane is drawn only for a cut someone chose', () => {
  it('shows the cut capsule in Manual Split, hides it in Auto Split until a cut suggestion is chosen, and not for components', async () => {
    mount({ suggestions: [HEAD, WHEEL] });
    expect(screen.getByTestId('split-hud')).toBeInTheDocument();
    await findParts('human');
    expect(screen.queryByTestId('split-hud')).toBeNull();
    click('auto-edit-head');
    await settle();
    expect(screen.getByTestId('split-hud')).toBeInTheDocument();
    click('auto-edit-wheel:wheel_1');
    await settle();
    expect(screen.queryByTestId('split-hud')).toBeNull();
    click('split-tab-manual');
    await settle();
    expect(screen.getByTestId('split-hud')).toBeInTheDocument();
  });

  it('keeps a plane suggestion available when the source has openings', async () => {
    mount({ sourceReasons: ['OPEN_BOUNDARIES'] });
    await findParts('human');
    expect(screen.getByTestId('auto-preview-head')).toBeEnabled();
    expect(screen.getByTestId('auto-row-head')).not.toHaveTextContent(
      /once the model can be split/i,
    );
  });
});

describe('operation capabilities on open sources', () => {
  it('previews planes without a global Repair prerequisite', async () => {
    const spies = mount({ sourceReasons: ['OPEN_BOUNDARIES'] });
    await findParts('human');
    expect(screen.queryByTestId('auto-source-not-ready')).toBeNull();
    expect(screen.getByTestId('auto-row-status-head')).not.toHaveTextContent('Repair model first');
    expect(screen.getByTestId('auto-preview-head')).toBeEnabled();
    expect(screen.getByTestId('auto-edit-head')).toBeEnabled();
    click('auto-preview-head');
    await settle();
    expect(spies.createSplit).toHaveBeenCalledTimes(1);
    expect(spies.commitSplit).not.toHaveBeenCalled();
  });
  it('offers both a plane cut and a triangle partition on an open source', async () => {
    mount({ sourceReasons: ['WINDING_CONFLICT'], suggestions: [HEAD, WHEEL] });
    await findParts('vehicle');
    expect(screen.getByTestId('auto-preview-head')).toBeEnabled();
    expect(screen.getByTestId('auto-preview-wheel:wheel_1')).toBeEnabled();
  });
});

describe('manual split stays local', () => {
  it('using the manual controls makes no semantic request of any kind', async () => {
    const spies = mount();
    fireEvent.change(screen.getByTestId('split-position-value'), { target: { value: '60' } });
    click('split-flip-plane');
    click('split-plane-xz');
    click('split-preview');
    await settle();
    expect(spies.createSplit).toHaveBeenCalledTimes(1);
    expect(spies.transport).not.toHaveBeenCalled();
    expect(spies.render).not.toHaveBeenCalled();
    expect(spies.suggest).not.toHaveBeenCalled();
  });
});

describe('a part too detailed for the split tools', () => {
  it('Auto Split says so as a status before Find parts, with the size and the limit, and no retry', async () => {
    const spies = mount({ triangleCount: 2_010_000 });
    await openAuto();
    const card = screen.getByTestId('auto-too-detailed');
    // A neutral status, never an alert: nothing went wrong.
    expect(card).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('auto-too-detailed-heading')).toHaveTextContent(
      'This model is too detailed for Auto Split right now.',
    );
    expect(screen.getByTestId('auto-too-detailed-size')).toHaveTextContent('2.01M triangles');
    expect(screen.getByTestId('auto-too-detailed-limit')).toHaveTextContent(
      'Auto Split currently supports models up to 2.00M triangles.',
    );
    expect(screen.getByTestId('auto-too-detailed-unchanged')).toHaveTextContent(
      'Your model is unchanged and nothing was sent.',
    );
    // Repeating the action cannot succeed, so nothing offers to: no retry, no question, no analysis.
    for (const id of ['auto-analyze', 'auto-try-again', 'auto-kind-human', 'auto-disclosure'])
      expect(screen.queryByTestId(id)).toBeNull();
    expect(card.textContent).not.toMatch(/try again/i);
    expect(spies.render).not.toHaveBeenCalled();
    expect(spies.transport).not.toHaveBeenCalled();
  });

  it('does not offer Manual Split as the way out, because it has the same limit', async () => {
    mount({ triangleCount: 2_010_000 });
    await openAuto();
    const text = screen.getByTestId('auto-too-detailed').textContent;
    expect(text).toContain('Manual Split has the same limit');
    expect(text).toContain('Repair, Convert and Export have their own limits');
    expect(screen.queryByTestId('auto-open-manual')).toBeNull();
    expect(text).not.toMatch(/use manual split/i);
  });

  it('Manual Split says the same, asks the worker for nothing, and keeps Preview off', async () => {
    const spies = mount({ triangleCount: 2_010_000 });
    expect(screen.getByTestId('split-too-detailed')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('split-too-detailed-heading')).toHaveTextContent(
      'This model is too detailed for Manual Split right now.',
    );
    expect(screen.getByTestId('split-too-detailed-others')).toHaveTextContent(
      'Auto Split has the same limit.',
    );
    click('split-preview');
    await settle();
    expect(spies.createSplit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('writes 2,000,001 against 2,000,000 in full, so it never says a number exceeds itself', async () => {
    mount({ triangleCount: 2_000_001 });
    await openAuto();
    expect(screen.getByTestId('auto-too-detailed-size')).toHaveTextContent('2,000,001 triangles');
    expect(screen.getByTestId('auto-too-detailed-limit')).toHaveTextContent(
      'up to 2,000,000 triangles',
    );
  });

  it('does not appear at 2,000,000 or 1,999,999: Find parts is offered', async () => {
    for (const triangleCount of [1_999_999, 2_000_000]) {
      const spies = mount({ triangleCount });
      await chooseAndAccept('human');
      expect(screen.queryByTestId('auto-too-detailed')).toBeNull();
      expect(screen.getByTestId('auto-analyze')).toBeEnabled();
      expect(spies.render).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe('a split the worker declines for resources', () => {
  const declined = resourceLimitExceeded('Manifold input bytes are 1; limit is 1.', {
    metric: 'inputBytes',
  });

  it('Manual Split shows a decision in a neutral status, not a failure alert, and not the raw limit', async () => {
    mount({ previewRejects: declined });
    click('split-preview');
    await settle();
    const note = screen.getByTestId('split-resource-limit');
    expect(note).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('split-error')).toBeNull();
    expect(note.textContent).toContain('This split needs more room than Pybrix allows.');
    expect(note.textContent).toContain('Your model is unchanged.');
    expect(note.textContent).not.toMatch(/manifold|inputBytes|limit is/i);
    expect(screen.queryByTestId('split-failure-line')).toBeNull();
  });

  it('Auto Split does not tell the person to use Manual Split, which has the same limits', async () => {
    mount({ previewRejects: declined });
    await findParts('human');
    click('auto-preview-head');
    await settle();
    expect(screen.getByTestId('auto-needs-room')).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('auto-unsafe')).toBeNull();
    expect(document.body.textContent).not.toMatch(/use manual split/i);
  });

  it('still says "adjust the cut or use Manual Split" for a cut that is merely unsound', async () => {
    mount({ previewRejects: invalidState('Geometry edit candidate contains degenerate faces.') });
    await findParts('human');
    click('auto-preview-head');
    await settle();
    expect(screen.getByTestId('auto-unsafe')).toHaveTextContent(AUTO_SPLIT_COPY.unsafeCut);
    expect(screen.queryByTestId('auto-needs-room')).toBeNull();
  });
});

describe('physical scope confirmation controls', () => {
  function physicalPreview(state: 'REQUIRED' | 'CONFIRMED'): SplitCreateResult {
    return {
      candidate: {
        documentId: 'doc-1',
        sourceRevision: 1,
        partId: PART_ID,
        generation: 1,
        candidateId: 'physical-ticket',
      },
      render: { parts: [] },
      parts: [],
      pieceAId: 'a',
      pieceBId: 'b',
      metrics: { pieceAFinalVolume: 1, pieceBFinalVolume: 1, volumeRelativeError: 0 },
      section: { area: 1, loopCount: 1 },
      connector: { kind: 'none' },
      semanticQualification: {
        preparationId: 7,
        candidateId: 'head',
        plane: HEAD.plane,
        attempts: 1,
        failures: 0,
        winnerIndex: 0,
        milliseconds: 1,
        scopeConfirmation: { receiptId: 'opaque-receipt', state },
      },
    } as unknown as SplitCreateResult;
  }
  async function suggestedScope(): Promise<Spies> {
    const s = mount({
      suggestions: [
        { ...HEAD, family: 'semantic', quality: 'SUGGESTED', semanticPreparationId: 7 },
      ],
    });
    await openAuto();
    click('auto-disclosure-continue');
    await settle();
    click('auto-analyze');
    await settle();
    s.createSplit.mockReturnValue({
      promise: Promise.resolve(physicalPreview('REQUIRED')),
      cancel: (): void => undefined,
    });
    return s;
  }
  it('shows confirm only after physical Preview, keeps Apply disabled, and reuses the receipt', async () => {
    const s = await suggestedScope();
    expect(screen.queryByTestId('auto-scope-confirm-head')).toBeNull();
    click('auto-preview-head');
    await settle();
    expect(screen.getByTestId('auto-scope-confirm-head')).toBeVisible();
    expect(screen.getByTestId('split-apply')).toBeDisabled();
    s.confirmSplitScope.mockReturnValue({
      promise: Promise.resolve({
        candidate: physicalPreview('CONFIRMED').candidate,
        semanticQualification: physicalPreview('CONFIRMED').semanticQualification,
      }),
      cancel: (): void => undefined,
    });
    click('auto-scope-confirm-head');
    await settle();
    expect(s.confirmSplitScope).toHaveBeenCalledWith('opaque-receipt');
    expect(s.createSplit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('auto-row-status-head')).toHaveTextContent('Ready');
    expect(screen.getByTestId('split-apply')).toBeEnabled();
    expect(s.commitSplit).not.toHaveBeenCalled();
  });
  it('None clears the inspected result and offers no Apply or confirmation', async () => {
    const s = await suggestedScope();
    click('auto-preview-head');
    await settle();
    click('auto-scope-cancel-head');
    await settle();
    expect(screen.queryByTestId('auto-scope-confirm-head')).toBeNull();
    expect(s.confirmSplitScope).not.toHaveBeenCalled();
    expect(s.commitSplit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('split-apply')).toBeNull();
  });
  it('withdraws the inspected result when its worker receipt expires', async () => {
    const s = await suggestedScope();
    const preview = physicalPreview('REQUIRED');
    const proof = preview.semanticQualification;
    if (!proof) throw Error('Missing fixture proof');
    s.createSplit.mockReturnValue({
      promise: Promise.resolve({
        ...preview,
        semanticQualification: {
          ...proof,
          scopeConfirmation: {
            receiptId: 'expiring',
            state: 'REQUIRED',
            expiresAt: Date.now() + 100,
          },
        },
      }),
      cancel: (): void => undefined,
    });
    click('auto-preview-head');
    await settle();
    expect(screen.getByTestId('auto-scope-confirm-head')).toBeVisible();
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 130);
      });
    });
    expect(screen.queryByTestId('auto-scope-confirm-head')).toBeNull();
    expect(screen.queryByTestId('split-apply')).toBeNull();
    expect(s.commitSplit).not.toHaveBeenCalled();
  });
});
