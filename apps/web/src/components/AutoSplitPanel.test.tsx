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

function part(): PartDescriptor {
  return {
    partId: PART_ID,
    name: 'Figure',
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount: 12,
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

function load(store: WorkspaceStore): void {
  const handle = { documentId: 'doc-1', revision: 1 } as DocumentHandle;
  const parts = [part()];
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
    triangleCount: 12,
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
  readonly requests: AnalyzeRequest[];
  readonly signals: AbortSignal[];
}

function okResponse(mode: 'human' | 'vehicle'): ParsedResponse {
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
}

function mount(options: Options = {}): Spies {
  const store = new WorkspaceStore();
  load(store);
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
  const createSplit = vi.fn(never);
  const createComponentSplit = vi.fn(never);
  const commitSplit = vi.fn(never);
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

  it('Other explains that Auto Split cannot help, offers Manual Split, and never asks for consent', async () => {
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
    expect(screen.getByTestId('auto-reanalyze-fresh')).toHaveTextContent('Re-analyze current part');
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
    expect(screen.getByTestId('auto-row-status-left_arm')).toHaveTextContent('Review cut');
    expect(screen.getByTestId('auto-row-status-right_arm')).toHaveTextContent(
      'No safe split found',
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
    expect(screen.getByTestId('auto-status')).toHaveTextContent(/finding parts/i);
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
    expect(call[2].connector.kind).toBe('none');
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

  it('does not tell a part that cannot be split that it found a clear match', async () => {
    mount({ sourceReasons: ['OPEN_BOUNDARIES'] });
    await findParts('human');
    expect(screen.getByTestId('auto-row-head')).not.toHaveTextContent(/clear match/i);
    expect(screen.getByTestId('auto-row-head')).toHaveTextContent(/once the model can be split/i);
  });
});

describe('a part that cannot be split offers no way to try', () => {
  it('shows the suggestions, disables them, and says Repair model first', async () => {
    const spies = mount({ sourceReasons: ['OPEN_BOUNDARIES'] });
    await findParts('human');
    expect(screen.getByTestId('auto-source-not-ready')).toHaveTextContent(
      'Part found, but this model needs Repair before it can be split.',
    );
    expect(screen.getByTestId('auto-row-status-head')).toHaveTextContent('Repair model first');
    expect(screen.getByTestId('auto-preview-head')).toBeDisabled();
    expect(screen.getByTestId('auto-edit-head')).toBeDisabled();
    // Repair cannot close an opening, so it is not offered as the way out.
    expect(screen.queryByTestId('auto-run-repair')).toBeNull();
    expect(screen.getByTestId('split-preview')).toBeDisabled();
    fireEvent.click(screen.getByTestId('auto-preview-head'));
    expect(spies.createSplit).not.toHaveBeenCalled();
  });

  it('offers Repair where Repair can help, and opens it', async () => {
    const spies = mount({ sourceReasons: ['WINDING_CONFLICT'] });
    await findParts('human');
    click('auto-run-repair');
    await settle();
    expect(spies.store.getSnapshot().selectedWorkflow).toBe(WorkflowId.Repair);
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
