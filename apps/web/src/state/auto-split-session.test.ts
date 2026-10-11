import { describe, expect, it } from 'vitest';
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
} from '@cadfixer/geometry-runtime';
import { operationCancelled, internalError, resourceLimitExceeded } from '@cadfixer/shared';
import { AUTO_SPLIT_TOO_DETAILED } from '@cadfixer/auto-split';
import type { AnalysisTransport } from '../runtime/auto-split-transport';
import {
  AutoSplitSession,
  LocalErrorCode,
  ModelKind,
  targetKey,
  type AutoSplitClient,
  type AutoSplitTarget,
} from './auto-split-session';

/**
 * THE SESSION'S ORDERING AND HONESTY, with a client and a transport that are test doubles the test
 * settles by hand, so "the answer arrived after Cancel" is a statement about order and not about luck.
 */

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const handle = (revision: number, documentId = 'doc-1'): DocumentHandle => ({
  documentId: documentId as DocumentHandle['documentId'],
  revision,
});
const target = (revision = 1, documentId = 'doc-1', partId = 'part-1'): AutoSplitTarget => ({
  handle: handle(revision, documentId),
  partId,
});

const VIEWS: AutoSplitRenderResult = {
  source: handle(1),
  partId: 'part-1',
  pngs: VIEW_NAMES.map((_, i) => new Uint8Array([137, 80, 78, 71, i])),
  summary: { extents: [1, 0.5, 0.25], shells: 5, radius: 0.6 },
};

const HEAD: Suggestion = {
  id: 'head',
  family: 'head',
  label: 'Head',
  operation: SuggestionOperation.Plane,
  status: SuggestionStatus.Suggested,
  reason: SuggestionReason.Clear,
  plane: { origin: [0, 0, 1], normal: [0, 0, 1] },
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

function suggestResult(
  mode: 'human' | 'vehicle',
  suggestions: readonly Suggestion[],
  sourceReasons: readonly string[] = [],
): AutoSplitSuggestResult {
  return {
    source: handle(1),
    partId: 'part-1',
    mode,
    suggestions,
    components: [],
    componentCount: 5,
    faceCount: 100,
    sourceReasons,
  };
}

interface Rig {
  readonly session: AutoSplitSession;
  readonly calls: { render: number; suggest: number; transport: number };
  readonly requests: AnalyzeRequest[];
  readonly signals: AbortSignal[];
  readonly cancelled: { render: number; suggest: number };
  /** Whether the suggest operation reports that a Cancel reaches synchronous work. */
  suggestInterruptible: boolean;
  render: ReturnType<typeof deferred<AutoSplitRenderResult>>;
  progress: ((update: { fraction: number; note?: string }) => void) | undefined;
  transport: ReturnType<typeof deferred<ParsedResponse>>;
  suggest: ReturnType<typeof deferred<AutoSplitSuggestResult>>;
  raws: unknown[];
}

function rig(): Rig {
  const r: Rig = {
    calls: { render: 0, suggest: 0, transport: 0 },
    requests: [],
    signals: [],
    cancelled: { render: 0, suggest: 0 },
    suggestInterruptible: true,
    render: deferred(),
    transport: deferred(),
    suggest: deferred(),
    raws: [],
    progress: undefined,
    session: undefined as unknown as AutoSplitSession,
  };
  const client: AutoSplitClient = {
    renderAutoSplitViews: (_source, _part, onProgress) => {
      r.progress = onProgress;
      r.calls.render += 1;
      return {
        promise: r.render.promise,
        cancel: (): void => {
          r.cancelled.render += 1;
        },
      };
    },
    suggestAutoSplit: (_source, _part, _mode, analysis) => {
      r.calls.suggest += 1;
      r.raws.push(analysis);
      return {
        promise: r.suggest.promise,
        interruptible: r.suggestInterruptible,
        cancel: (): void => {
          r.cancelled.suggest += 1;
        },
      };
    },
  };
  const transport: AnalysisTransport = {
    analyze: (request, signal) => {
      r.calls.transport += 1;
      r.requests.push(request);
      r.signals.push(signal);
      return r.transport.promise;
    },
  };
  let n = 0;
  const session = new AutoSplitSession({
    client,
    transport,
    newRequestId: (): string => `request-${String((n += 1)).padStart(8, '0')}`,
  });
  return Object.assign(r, { session });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const okHuman = (raw: unknown = { raw: 'human' }): ParsedResponse => ({
  ok: true,
  analysis: {
    mode: 'human',
    requestId: 'request-00000001',
    protocolVersion: PROTOCOL_VERSIONS.human,
    human: {} as never,
    raw,
  },
});

function ready(r: Rig, kind: ModelKind = ModelKind.Character): void {
  r.session.acceptDisclosure();
  r.session.chooseKind(kind);
}

async function completeHuman(r: Rig, t = target()): Promise<void> {
  expect(r.session.analyze(t)).toBe(true);
  r.render.resolve(VIEWS);
  await flush();
  r.transport.resolve(okHuman());
  await flush();
  r.suggest.resolve(suggestResult('human', [HEAD]));
  await flush();
}

describe('consent and model type come first', () => {
  it('starts nothing without the disclosure, and nothing for Other', () => {
    const r = rig();
    r.session.chooseKind(ModelKind.Character);
    expect(r.session.analyze(target())).toBe(false);
    r.session.acceptDisclosure();
    r.session.chooseKind(ModelKind.Other);
    expect(r.session.analyze(target())).toBe(false);
    expect(r.calls).toEqual({ render: 0, suggest: 0, transport: 0 });
    expect(r.session.getSnapshot().run).toBe('idle');
  });

  it('keeps consent in memory only: a new session asks again', () => {
    const first = rig();
    first.session.acceptDisclosure();
    expect(first.session.getSnapshot().disclosureAccepted).toBe(true);
    expect(rig().session.getSnapshot().disclosureAccepted).toBe(false);
  });
});

describe('a normal analysis', () => {
  it('renders locally, sends only six views and three numbers, and ends with suggestions', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    expect(r.session.getSnapshot().run).toBe('preparing');
    expect(r.calls.transport).toBe(0);
    r.render.resolve(VIEWS);
    await flush();
    expect(r.session.getSnapshot().run).toBe('analyzing');
    const request = r.requests[0];
    expect(request).toBeDefined();
    expect(Object.keys(request ?? {}).sort()).toEqual(
      ['mode', 'protocolVersion', 'requestId', 'summary', 'views'].sort(),
    );
    expect(request?.views.map((v) => v.view)).toEqual([...VIEW_NAMES]);
    expect(request?.mode).toBe('human');
    expect(request?.protocolVersion).toBe(PROTOCOL_VERSIONS.human);
    expect(Object.keys(request?.summary ?? {}).sort()).toEqual(['extents', 'radius', 'shells']);
    r.transport.resolve(okHuman({ the: 'answer' }));
    await flush();
    // The answer goes to the worker as data to validate; the suggestions come from the worker.
    expect(r.raws).toEqual([{ the: 'answer' }]);
    r.suggest.resolve(suggestResult('human', [HEAD]));
    await flush();
    const snap = r.session.getSnapshot();
    expect(snap.run).toBe('ready');
    expect(snap.result?.suggestions).toEqual([HEAD]);
    // READY IS NOT APPLIED: nothing is selected, shown or previewed until the user does it.
    expect(snap.selectedId).toBeUndefined();
    expect(snap.shownId).toBeUndefined();
  });

  it('caches per unchanged revision, calls again for Re-analyze, and again for a new revision', async () => {
    const r = rig();
    ready(r);
    await completeHuman(r);
    expect(r.calls).toEqual({ render: 1, suggest: 1, transport: 1 });
    r.session.reset();
    expect(r.session.analyze(target())).toBe(true);
    expect(r.calls).toEqual({ render: 1, suggest: 1, transport: 1 });
    expect(r.session.getSnapshot().result?.suggestions).toEqual([HEAD]);

    r.render = deferred();
    r.session.reset();
    expect(r.session.analyze(target(), true)).toBe(true);
    expect(r.calls.render).toBe(2);

    r.render = deferred();
    r.session.reset();
    r.session.follow(target(2));
    expect(r.session.analyze(target(2))).toBe(true);
    expect(r.calls.render).toBe(3);
  });

  it('refuses a second analysis while one is running', () => {
    const r = rig();
    ready(r);
    expect(r.session.analyze(target())).toBe(true);
    expect(r.session.analyze(target())).toBe(false);
    expect(r.calls.render).toBe(1);
  });
});

describe('progress', () => {
  it('writes the render note while rendering, and a late one never overwrites the next phase', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    r.progress?.({ fraction: 0.5, note: 'Rendered view 3 of 6' });
    expect(r.session.getSnapshot().note).toBe('Rendered view 3 of 6');
    r.render.resolve(VIEWS);
    await flush();
    const analysing = r.session.getSnapshot().note;
    expect(r.session.getSnapshot().run).toBe('analyzing');
    // The coordinator can deliver a progress message after the result.
    r.progress?.({ fraction: 1, note: 'Rendered view 6 of 6' });
    expect(r.session.getSnapshot().note).toBe(analysing);
  });
});

describe('cancel', () => {
  it('during the local render: cancels it, makes the late render inert, sends nothing', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    r.session.cancel();
    expect(r.cancelled.render).toBe(1);
    expect(r.session.getSnapshot().run).toBe('cancelled');
    r.render.resolve(VIEWS);
    await flush();
    expect(r.calls.transport).toBe(0);
    expect(r.session.getSnapshot().run).toBe('cancelled');
  });

  it('during the request: aborts it, and a response that arrives later changes nothing', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    r.render.resolve(VIEWS);
    await flush();
    const signal = r.signals[0];
    expect(signal?.aborted).toBe(false);
    r.session.cancel();
    expect(signal?.aborted).toBe(true);
    expect(r.session.getSnapshot().run).toBe('cancelled');
    r.transport.resolve(okHuman());
    await flush();
    r.suggest.resolve(suggestResult('human', [HEAD]));
    await flush();
    const snap = r.session.getSnapshot();
    expect(snap.run).toBe('cancelled');
    expect(snap.result).toBeUndefined();
    expect(r.calls.suggest).toBe(0);
  });

  it('is a no-op when nothing is running', () => {
    const r = rig();
    r.session.cancel();
    expect(r.session.getSnapshot().run).toBe('idle');
  });
});

describe('a result belongs to its revision', () => {
  it('goes stale, unselectable, when the revision moves, and stays listed', async () => {
    const r = rig();
    ready(r);
    await completeHuman(r);
    r.session.select('head');
    expect(r.session.getSnapshot().selectedId).toBe('head');
    r.session.follow(target(2));
    const snap = r.session.getSnapshot();
    expect(snap.stale).toBe(true);
    expect(snap.result?.suggestions).toHaveLength(1);
    expect(snap.selectedId).toBeUndefined();
    r.session.select('head');
    expect(r.session.getSnapshot().selectedId).toBeUndefined();
  });

  it('is not stale while the same revision is followed', async () => {
    const r = rig();
    ready(r);
    await completeHuman(r);
    r.session.follow(target(1));
    expect(r.session.getSnapshot().stale).toBe(false);
  });

  it('is cleared, with its cache, by a different document', async () => {
    const r = rig();
    ready(r);
    await completeHuman(r);
    r.session.follow(target(1, 'doc-2'));
    expect(r.session.getSnapshot().result).toBeUndefined();
    r.session.follow(target(1, 'doc-1'));
    // The cache did not survive the other document.
    r.render = deferred();
    expect(r.session.analyze(target(1, 'doc-1'))).toBe(true);
    expect(r.calls.render).toBe(2);
  });

  it('stays listed, stale, when the revision moves and the workspace shows another part (an Apply does this)', async () => {
    const r = rig();
    ready(r);
    await completeHuman(r);
    r.session.follow(target(2, 'doc-1', 'part-1-A'));
    const snap = r.session.getSnapshot();
    expect(snap.stale).toBe(true);
    expect(snap.result?.suggestions).toHaveLength(1);
  });

  it('is cleared by another part of the same document', async () => {
    const r = rig();
    ready(r);
    await completeHuman(r);
    r.session.follow(target(1, 'doc-1', 'part-2'));
    expect(r.session.getSnapshot().result).toBeUndefined();
  });

  it('cancels a run whose model moved, says so, and ignores what the run later returns', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target(1));
    r.render.resolve(VIEWS);
    await flush();
    r.session.follow(target(2));
    const snap = r.session.getSnapshot();
    expect(snap.run).toBe('error');
    expect(snap.error?.code).toBe(LocalErrorCode.SourceChanged);
    expect(r.signals[0]?.aborted).toBe(true);
    r.transport.resolve(okHuman());
    await flush();
    r.suggest.resolve(suggestResult('human', [HEAD]));
    await flush();
    expect(r.session.getSnapshot().result).toBeUndefined();
  });

  it('drops a run silently when a different document is opened', () => {
    const r = rig();
    ready(r);
    r.session.analyze(target(1));
    r.session.follow(target(1, 'doc-2'));
    expect(r.session.getSnapshot().run).toBe('idle');
    expect(r.session.getSnapshot().error).toBeUndefined();
  });
});

describe('failures read as decisions with a way forward', () => {
  const cases: readonly [AnalyzeErrorCode, number | undefined][] = [
    [AnalyzeErrorCode.Network, undefined],
    [AnalyzeErrorCode.ProviderTimeout, undefined],
    [AnalyzeErrorCode.ProviderUnavailable, undefined],
    [AnalyzeErrorCode.ProviderInvalidResponse, undefined],
    [AnalyzeErrorCode.RateLimited, 90],
    [AnalyzeErrorCode.UnsupportedProtocol, undefined],
  ];
  for (const [code, retry] of cases)
    it(`reports ${code} with our own sentence and offers a fresh start`, async () => {
      const r = rig();
      ready(r);
      r.session.analyze(target());
      r.render.resolve(VIEWS);
      await flush();
      r.transport.resolve({ ok: false, error: analyzeError(code, retry) });
      await flush();
      const snap = r.session.getSnapshot();
      expect(snap.run).toBe('error');
      expect(snap.error?.code).toBe(code);
      expect(snap.error?.message).toBe(analyzeError(code).message);
      expect(snap.error?.retryAfterSeconds).toBe(retry);
      r.session.reset();
      expect(r.session.getSnapshot().run).toBe('idle');
    });

  it('a cancellation from the transport is a cancellation, not an error', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    r.render.resolve(VIEWS);
    await flush();
    r.transport.resolve({ ok: false, error: analyzeError(AnalyzeErrorCode.Cancelled) });
    await flush();
    expect(r.session.getSnapshot().run).toBe('cancelled');
  });

  it('a local failure keeps its own sentence, and a worker cancellation is a cancellation', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    r.render.reject(internalError('Six views could not be drawn.'));
    await flush();
    expect(r.session.getSnapshot().error?.code).toBe(LocalErrorCode.LocalFailure);
    expect(r.session.getSnapshot().error?.message).toBe('Six views could not be drawn.');

    const second = rig();
    ready(second);
    second.session.analyze(target());
    second.render.reject(operationCancelled());
    await flush();
    expect(second.session.getSnapshot().run).toBe('cancelled');
  });

  it('a failure while preparing suggestions is a failure, with no result', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    r.render.resolve(VIEWS);
    await flush();
    r.transport.resolve(okHuman());
    await flush();
    r.suggest.reject(internalError('The answer did not match the expected shape.'));
    await flush();
    expect(r.session.getSnapshot().run).toBe('error');
    expect(r.session.getSnapshot().result).toBeUndefined();
  });
});

describe('selection', () => {
  it('shows one suggestion at a time and lets the user correct a component selection', async () => {
    const r = rig();
    ready(r, ModelKind.Vehicle);
    r.session.analyze(target());
    r.render.resolve(VIEWS);
    await flush();
    r.transport.resolve({
      ok: true,
      analysis: {
        mode: 'vehicle',
        requestId: 'request-00000001',
        protocolVersion: PROTOCOL_VERSIONS.vehicle,
        vehicle: {} as never,
        raw: {},
      },
    });
    await flush();
    r.suggest.resolve(suggestResult('vehicle', [HEAD, WHEEL]));
    await flush();

    r.session.select('head');
    r.session.select('wheel:wheel_1');
    expect(r.session.getSnapshot().selectedId).toBe('wheel:wheel_1');
    expect(r.session.getSnapshot().shownId).toBe('wheel:wheel_1');
    expect(r.session.getSnapshot().selection).toEqual([1]);

    r.session.toggleComponent(3);
    expect(r.session.getSnapshot().selection).toEqual([1, 3]);
    r.session.toggleComponent(1);
    expect(r.session.getSnapshot().selection).toEqual([3]);

    r.session.toggleShown('wheel:wheel_1');
    expect(r.session.getSnapshot().shownId).toBeUndefined();
    r.session.toggleShown('head');
    expect(r.session.getSnapshot().shownId).toBe('head');

    r.session.select('nonexistent');
    expect(r.session.getSnapshot().selectedId).toBe('wheel:wheel_1');
    r.session.select(undefined);
    expect(r.session.getSnapshot().selectedId).toBeUndefined();
  });

  it('changing the model type discards the previous answer: it answered another question', async () => {
    const r = rig();
    ready(r);
    await completeHuman(r);
    r.session.chooseKind(ModelKind.Vehicle);
    expect(r.session.getSnapshot().result).toBeUndefined();
    expect(r.session.getSnapshot().run).toBe('idle');
  });
});

describe('the key is the identity', () => {
  it('names document, revision and part', () => {
    expect(targetKey(target(4, 'doc-9', 'part-3'))).toBe('doc-9@4/part-3');
  });
});

describe('a part too detailed for Auto Split', () => {
  const sized = (triangleCount: number): AutoSplitTarget => ({ ...target(), triangleCount });

  it('is refused before any work at 2,000,001 triangles, and not at 1,999,999 or 2,000,000', () => {
    for (const [triangles, allowed] of [
      [1_999_999, true],
      [2_000_000, true],
      [2_000_001, false],
    ] as const) {
      const r = rig();
      ready(r);
      expect(r.session.analyze(sized(triangles))).toBe(allowed);
      expect(r.calls.render).toBe(allowed ? 1 : 0);
      // Nothing was rendered, sent, retried or turned into an error state for the refused one.
      expect(r.calls.transport).toBe(0);
      expect(r.session.getSnapshot().run).toBe(allowed ? 'preparing' : 'idle');
      expect(r.session.getSnapshot().error).toBeUndefined();
    }
  });

  it('shows the worker’s own size refusal as a deterministic status with the numbers it measured', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    r.render.reject(
      resourceLimitExceeded('This part has 2,500,000 triangles.', {
        code: AUTO_SPLIT_TOO_DETAILED,
        metric: 'triangles',
        value: 2_500_000,
        limit: 2_000_000,
      }),
    );
    await flush();
    const snap = r.session.getSnapshot();
    expect(snap.run).toBe('error');
    expect(snap.error?.code).toBe(LocalErrorCode.TooDetailed);
    expect(snap.error?.size).toEqual({ triangles: 2_500_000, limit: 2_000_000 });
    // Nothing was sent: the refusal came from the local render, before the request.
    expect(r.calls.transport).toBe(0);
  });

  it('does not mistake any other resource refusal for a size verdict', async () => {
    const r = rig();
    ready(r);
    r.session.analyze(target());
    r.render.reject(resourceLimitExceeded('Some other limit.', { metric: 'inputBytes' }));
    await flush();
    expect(r.session.getSnapshot().error?.code).toBe(LocalErrorCode.LocalFailure);
  });
});

describe('the phases the person reads', () => {
  it('goes Preparing model, Looking for parts, Reviewing candidate cuts, in that order', async () => {
    const r = rig();
    ready(r);
    const notes: string[] = [];
    r.session.subscribe(() => {
      const { note } = r.session.getSnapshot();
      if (note !== '' && notes.at(-1) !== note) notes.push(note);
    });
    r.session.analyze(target());
    r.render.resolve(VIEWS);
    await flush();
    r.transport.resolve(okHuman());
    await flush();
    r.suggest.resolve(suggestResult('human', [HEAD]));
    await flush();
    expect(notes).toEqual(['Preparing model…', 'Looking for parts…', 'Reviewing candidate cuts…']);
  });

  it('carries no implementation vocabulary', async () => {
    const r = rig();
    ready(r);
    const notes = new Set<string>();
    r.session.subscribe(() => {
      notes.add(r.session.getSnapshot().note);
    });
    r.session.analyze(target());
    r.progress?.({ fraction: 0.5, note: 'Preparing model… view 3 of 6' });
    r.render.resolve(VIEWS);
    await flush();
    r.transport.resolve(okHuman());
    await flush();
    for (const note of notes) expect(note).not.toMatch(/manifold|scorer|triangle soup|provider/i);
  });
});

describe('cancelling the local suggestion pass', () => {
  async function toSuggesting(r: Rig): Promise<void> {
    ready(r);
    r.session.analyze(target());
    r.render.resolve(VIEWS);
    await flush();
    r.transport.resolve(okHuman());
    await flush();
  }

  it('cancels the worker operation, not just the page’s wait for it', async () => {
    const r = rig();
    await toSuggesting(r);
    expect(r.session.getSnapshot().note).toBe('Reviewing candidate cuts…');
    expect(r.session.getSnapshot().cancellable).toBe(true);
    r.session.cancel();
    expect(r.cancelled.suggest).toBe(1);
    expect(r.session.getSnapshot().run).toBe('cancelled');
    // A late answer from the cancelled pass is nothing.
    r.suggest.resolve(suggestResult('human', [HEAD]));
    await flush();
    expect(r.session.getSnapshot().run).toBe('cancelled');
    expect(r.session.getSnapshot().result).toBeUndefined();
  });

  it('withdraws Cancel, and does not pretend, where the pass cannot be interrupted', async () => {
    const r = rig();
    r.suggestInterruptible = false;
    await toSuggesting(r);
    expect(r.session.getSnapshot().cancellable).toBe(false);
    r.session.cancel();
    expect(r.cancelled.suggest).toBe(0);
    expect(r.session.getSnapshot().run).toBe('analyzing');
    // It finishes, and the control comes back for the next run.
    r.suggest.resolve(suggestResult('human', [HEAD]));
    await flush();
    expect(r.session.getSnapshot().run).toBe('ready');
    expect(r.session.getSnapshot().cancellable).toBe(true);
  });
});
