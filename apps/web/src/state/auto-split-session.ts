import {
  analyzeError,
  AnalyzeErrorCode,
  PROTOCOL_VERSIONS,
  VIEW_NAMES,
  encodeBase64,
  type AnalyzeRequest,
  type SemanticMode,
} from '@cadfixer/auto-split-contract';
import type { ComponentSummary, Suggestion } from '@cadfixer/auto-split';
import type {
  AutoSplitRenderResult,
  AutoSplitSuggestResult,
  DocumentHandle,
  ProgressUpdate,
} from '@cadfixer/geometry-runtime';
import { isAppError, AppErrorCode } from '@cadfixer/shared';
import type { AnalysisTransport } from '../runtime/auto-split-transport';

/**
 * THE AUTO SPLIT SESSION: what the product knows about one analysis, as a framework-free machine.
 *
 * IT SUGGESTS; IT NEVER MUTATES. Nothing here holds a handle that can commit, and no method can reach
 * `split/commit`: applying a suggestion is the user's click on the existing split preview. What the
 * session owns is the ordering and the honesty of the analysis: consent first, six local renders, one
 * request, one validated answer, local geometry checks, and a result that is only ever read back for
 * the (document, revision, part) it was made for.
 *
 * - **A result belongs to a revision.** Any change of revision (Repair, Apply, Undo, an edit) makes
 *   the result STALE — still listed, never executable — and a different document clears everything.
 * - **A late answer is nothing.** Every run has a generation; a render, a response or a suggestion
 *   that settles after a cancel, a newer run or a change of source is dropped without touching state.
 * - **Cancel is real**: it aborts the browser request (which the service turns into an aborted
 *   provider call) and cancels the local render, and leaves geometry untouched, because nothing here
 *   can change geometry.
 * - **The disclosure is asked before the first request**, and nothing leaves the page without it.
 *   It is kept for this page session only: nothing is written to storage.
 */

export const ModelKind = {
  Character: 'human',
  Vehicle: 'vehicle',
  Other: 'other',
} as const;
export type ModelKind = (typeof ModelKind)[keyof typeof ModelKind];

/** The states the product names. PREVIEWING and APPLYING belong to the split workflow, and are derived. */
export const AutoSplitPhase = {
  Idle: 'IDLE',
  PreparingViews: 'PREPARING_VIEWS',
  Analyzing: 'ANALYZING',
  SuggestionsReady: 'SUGGESTIONS_READY',
  Previewing: 'PREVIEWING',
  Applying: 'APPLYING',
  Error: 'ERROR',
  Cancelled: 'CANCELLED',
  SourceNotReady: 'SOURCE_NOT_READY',
} as const;
export type AutoSplitPhase = (typeof AutoSplitPhase)[keyof typeof AutoSplitPhase];

/** What the session itself can be doing; the derived phases add the rest. */
type RunPhase = 'idle' | 'preparing' | 'analyzing' | 'ready' | 'error' | 'cancelled';

export const LocalErrorCode = {
  /** The model changed while it was being analysed. */
  SourceChanged: 'SOURCE_CHANGED',
  /** The part could not be rendered or its suggestions built on this device. */
  LocalFailure: 'LOCAL_FAILURE',
} as const;
export type LocalErrorCode = (typeof LocalErrorCode)[keyof typeof LocalErrorCode];

export interface AutoSplitErrorView {
  readonly code: AnalyzeErrorCode | LocalErrorCode;
  /** A sentence Pybrix wrote. Never provider text, never a file name. */
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

export interface AutoSplitTarget {
  readonly handle: DocumentHandle;
  readonly partId: string;
}

/** `document@revision/part`: the identity every result is read back against. */
export const targetKey = (target: AutoSplitTarget): string =>
  `${target.handle.documentId}@${String(target.handle.revision)}/${target.partId}`;

export interface AutoSplitResult {
  readonly key: string;
  readonly documentId: string;
  readonly mode: SemanticMode;
  readonly suggestions: readonly Suggestion[];
  readonly components: readonly ComponentSummary[];
  readonly componentCount: number;
  /** Closed-solid reasons from the local gate; empty means a suggestion may be previewed. */
  readonly sourceReasons: readonly string[];
}

export interface AutoSplitSnapshot {
  readonly run: RunPhase;
  readonly disclosureAccepted: boolean;
  readonly kind: ModelKind | undefined;
  /** Phase-oriented, never a percentage. */
  readonly note: string;
  readonly error: AutoSplitErrorView | undefined;
  readonly result: AutoSplitResult | undefined;
  /** True once the revision moved on: the list is shown, nothing in it can be previewed. */
  readonly stale: boolean;
  /** The suggestion being previewed or edited. One at a time. */
  readonly selectedId: string | undefined;
  /** The suggestion drawn in the viewport. One at a time; undefined hides every overlay. */
  readonly shownId: string | undefined;
  /** The user's own component selection for the selected component suggestion. */
  readonly selection: readonly number[] | undefined;
}

interface OperationLike<T> {
  readonly promise: Promise<T>;
  cancel(): void;
}

/** The two geometry reads the session needs. A `GeometryClient` satisfies it. */
export interface AutoSplitClient {
  renderAutoSplitViews(
    source: DocumentHandle,
    partId: string,
    onProgress?: (update: ProgressUpdate) => void,
  ): OperationLike<AutoSplitRenderResult>;
  suggestAutoSplit(
    source: DocumentHandle,
    partId: string,
    mode: SemanticMode,
    analysis: unknown,
  ): OperationLike<AutoSplitSuggestResult>;
}

export interface AutoSplitDeps {
  readonly client: AutoSplitClient;
  readonly transport: AnalysisTransport;
  readonly newRequestId: () => string;
}

const INITIAL: AutoSplitSnapshot = Object.freeze({
  run: 'idle',
  disclosureAccepted: false,
  kind: undefined,
  note: '',
  error: undefined,
  result: undefined,
  stale: false,
  selectedId: undefined,
  shownId: undefined,
  selection: undefined,
});

const isCancellation = (cause: unknown): boolean =>
  isAppError(cause) && cause.code === AppErrorCode.OperationCancelled;

export class AutoSplitSession {
  private snapshot: AutoSplitSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly deps: AutoSplitDeps;
  /** One cached result per revision and mode: an unchanged revision is not analysed twice. */
  private readonly cache = new Map<string, AutoSplitResult>();
  private generation = 0;
  private abort: AbortController | undefined;
  private render: OperationLike<AutoSplitRenderResult> | undefined;
  private running: { readonly key: string; readonly documentId: string } | undefined;

  public constructor(deps: AutoSplitDeps) {
    this.deps = deps;
  }

  /* ------------------------------------------------------------- store -- */

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  public readonly getSnapshot = (): AutoSplitSnapshot => this.snapshot;

  private set(patch: Partial<AutoSplitSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /* ------------------------------------------------------- disclosure -- */

  public acceptDisclosure(): void {
    this.set({ disclosureAccepted: true });
  }
  public declineDisclosure(): void {
    this.set({ disclosureAccepted: false });
  }

  public chooseKind(kind: ModelKind | undefined): void {
    if (kind === this.snapshot.kind) return;
    // A different model type is a different question: whatever was running is not its answer.
    this.stop();
    this.set({
      kind,
      run: 'idle',
      note: '',
      error: undefined,
      result: undefined,
      stale: false,
      selectedId: undefined,
      shownId: undefined,
      selection: undefined,
    });
  }

  /* --------------------------------------------------------- analysis -- */

  /**
   * Starts an analysis of `target` for the chosen model type. Returns false, doing nothing, when the
   * disclosure has not been accepted, the type is not one with an analysis, or one is already running.
   * `force` is Re-analyze: it bypasses the cache and calls again.
   */
  public analyze(target: AutoSplitTarget, force = false): boolean {
    const { kind, disclosureAccepted } = this.snapshot;
    if (!disclosureAccepted || kind === undefined || kind === ModelKind.Other) return false;
    if (this.snapshot.run === 'preparing' || this.snapshot.run === 'analyzing') return false;
    const mode: SemanticMode = kind;
    const key = targetKey(target);
    const cacheKey = `${key}/${mode}`;
    const cached = force ? undefined : this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.set({
        run: 'ready',
        note: '',
        error: undefined,
        result: cached,
        stale: false,
        selectedId: undefined,
        shownId: undefined,
        selection: undefined,
      });
      return true;
    }
    void this.execute(target, mode, key, cacheKey);
    return true;
  }

  private async execute(
    target: AutoSplitTarget,
    mode: SemanticMode,
    key: string,
    cacheKey: string,
  ): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    const current = (): boolean => this.generation === generation;
    const abort = new AbortController();
    this.abort = abort;
    this.running = { key, documentId: target.handle.documentId };
    this.set({
      run: 'preparing',
      note: 'Rendering six views of your model on this device…',
      error: undefined,
      result: undefined,
      stale: false,
      selectedId: undefined,
      shownId: undefined,
      selection: undefined,
    });
    try {
      // 1. Six local renders. Nothing leaves the device in this step.
      const render = this.deps.client.renderAutoSplitViews(
        target.handle,
        target.partId,
        (update) => {
          if (current()) this.set({ note: update.note ?? 'Rendering views on this device…' });
        },
      );
      this.render = render;
      const views = await render.promise;
      if (!current()) return;
      this.render = undefined;

      // 2. One request: six PNGs and three bounded numbers.
      this.set({ run: 'analyzing', note: 'Finding parts. This can take up to a minute or more…' });
      const request: AnalyzeRequest = {
        requestId: this.deps.newRequestId(),
        mode,
        protocolVersion: PROTOCOL_VERSIONS[mode],
        views: VIEW_NAMES.map((view, index) => ({
          view,
          png: encodeBase64(views.pngs[index] ?? new Uint8Array(0)),
        })),
        summary: {
          extents: [views.summary.extents[0], views.summary.extents[1], views.summary.extents[2]],
          shells: views.summary.shells,
          radius: views.summary.radius,
        },
      };
      const response = await this.deps.transport.analyze(request, abort.signal);
      if (!current()) return;
      if (!response.ok) {
        this.fail(response.error);
        return;
      }

      // 3. The answer is data. The worker validates it again and turns it into suggestions.
      this.set({ note: 'Preparing editable suggestions…' });
      const suggested = await this.deps.client.suggestAutoSplit(
        target.handle,
        target.partId,
        mode,
        response.analysis.raw,
      ).promise;
      if (!current()) return;
      const result: AutoSplitResult = {
        key,
        documentId: target.handle.documentId,
        mode,
        suggestions: suggested.suggestions,
        components: suggested.components,
        componentCount: suggested.componentCount,
        sourceReasons: suggested.sourceReasons,
      };
      this.cache.set(cacheKey, result);
      this.running = undefined;
      this.abort = undefined;
      this.set({ run: 'ready', note: '', error: undefined, result, stale: false });
    } catch (cause: unknown) {
      if (!current()) return;
      this.render = undefined;
      if (isCancellation(cause)) {
        this.set({ run: 'cancelled', note: '', error: undefined });
        this.running = undefined;
        return;
      }
      this.fail({
        code: LocalErrorCode.LocalFailure,
        message:
          isAppError(cause) && cause.message !== ''
            ? cause.message
            : 'Pybrix could not prepare this model for analysis.',
      });
    }
  }

  private fail(error: AutoSplitErrorView): void {
    this.running = undefined;
    this.abort = undefined;
    if (error.code === AnalyzeErrorCode.Cancelled) {
      this.set({ run: 'cancelled', note: '', error: undefined });
      return;
    }
    this.set({ run: 'error', note: '', error, result: undefined });
  }

  /** Stops whatever is running: aborts the request, cancels the render, and makes any late answer inert. */
  private stop(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    this.render?.cancel();
    this.render = undefined;
    this.running = undefined;
  }

  /** The user's Cancel. The model is untouched by construction. */
  public cancel(): void {
    const { run } = this.snapshot;
    if (run !== 'preparing' && run !== 'analyzing') return;
    this.stop();
    this.set({ run: 'cancelled', note: '', error: undefined });
  }

  /** Back to the start for this model: the explicit "Try again" and "Start over". */
  public reset(): void {
    this.stop();
    this.set({
      run: 'idle',
      note: '',
      error: undefined,
      result: undefined,
      stale: false,
      selectedId: undefined,
      shownId: undefined,
      selection: undefined,
    });
  }

  /* ---------------------------------------------------- source follow -- */

  /**
   * Tells the session which (document, revision, part) the workspace is showing NOW. Called on every
   * render of the controller hook; it is idempotent. A change of revision stales the list; a change
   * of document or part clears it; a run in flight for anything else is cancelled and says why.
   */
  public follow(current: AutoSplitTarget | undefined): void {
    const key = current === undefined ? undefined : targetKey(current);
    const documentId = current?.handle.documentId;
    // The cache never outlives its document.
    for (const [cacheKey, entry] of this.cache)
      if (entry.documentId !== documentId) this.cache.delete(cacheKey);

    const running = this.running;
    if (running !== undefined && running.key !== key) {
      this.stop();
      // Another document (or none): the run is simply gone. The same document at another revision or
      // part: the user is told, because the result of the run would have described a model that moved.
      this.set(
        running.documentId === documentId
          ? {
              run: 'error',
              note: '',
              error: {
                code: LocalErrorCode.SourceChanged,
                message: 'The model changed while it was being analysed. Analyse it again.',
              },
              result: undefined,
              stale: false,
            }
          : { run: 'idle', note: '', error: undefined, result: undefined, stale: false },
      );
    }
    const result = this.snapshot.result;
    if (result === undefined) return;
    if (
      documentId !== result.documentId ||
      (current !== undefined && !sameStem(result.key, current))
    ) {
      // Another document or another part: nothing here describes it.
      this.set({
        run: 'idle',
        result: undefined,
        stale: false,
        selectedId: undefined,
        shownId: undefined,
        selection: undefined,
      });
      return;
    }
    const stale = key !== result.key;
    if (stale !== this.snapshot.stale)
      this.set({
        stale,
        ...(stale ? { selectedId: undefined, shownId: undefined, selection: undefined } : {}),
      });
  }

  /* -------------------------------------------------------- selection -- */

  public select(id: string | undefined): void {
    const result = this.snapshot.result;
    if (this.snapshot.stale || result === undefined) return;
    if (id === undefined) {
      this.set({ selectedId: undefined, shownId: undefined, selection: undefined });
      return;
    }
    const suggestion = result.suggestions.find((s) => s.id === id);
    if (suggestion === undefined) return;
    this.set({
      selectedId: id,
      shownId: id,
      selection: suggestion.components.length > 0 ? suggestion.components : undefined,
    });
  }

  /** The eye: draw this suggestion in the viewport, or stop drawing it. One at a time. */
  public toggleShown(id: string): void {
    if (this.snapshot.stale) return;
    this.set({ shownId: this.snapshot.shownId === id ? undefined : id });
  }

  /** The user's correction of which components belong to the selected suggestion. */
  public toggleComponent(rank: number): void {
    const { selection, selectedId } = this.snapshot;
    if (selectedId === undefined || selection === undefined) return;
    const next = selection.includes(rank)
      ? selection.filter((r) => r !== rank)
      : [...selection, rank].sort((a, b) => a - b);
    this.set({ selection: next });
  }

  public dispose(): void {
    this.stop();
    this.listeners.clear();
  }
}

/** `document@revision/part` without the revision: same document and part, any revision. */
function sameStem(resultKey: string, current: AutoSplitTarget): boolean {
  const at = resultKey.indexOf('@');
  const slash = resultKey.indexOf('/', at);
  return (
    resultKey.slice(0, at) === current.handle.documentId &&
    resultKey.slice(slash + 1) === current.partId
  );
}

/** The error the interface shows for a code, never a provider's words. */
export function describeAnalysisError(
  code: AnalyzeErrorCode,
  retryAfterSeconds?: number,
): AutoSplitErrorView {
  const error = analyzeError(code, retryAfterSeconds);
  return {
    code,
    message: error.message,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}
