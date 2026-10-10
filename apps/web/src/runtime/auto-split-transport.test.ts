import { describe, expect, it } from 'vitest';
import {
  AnalyzeErrorCode,
  PROTOCOL_VERSIONS,
  validateAnalyzeRequest,
  VIEW_NAMES,
  type AnalyzeRequest,
} from '@cadfixer/auto-split-contract';
import { makeRequest } from '@cadfixer/auto-split-contract/test-fixtures';
import { scenarioAnswer } from '@cadfixer/auto-split/fixtures';
import { ANALYZE_URL, createAnalysisTransport, type AnalysisFetch } from './auto-split-transport';

/**
 * THE BROWSER'S ONE REQUEST. The fetcher is injected, so every case below is about what is sent and
 * how a reply is read, with no network at all.
 */

async function request(): Promise<AnalyzeRequest> {
  const checked = validateAnalyzeRequest(await makeRequest('human'));
  if (!checked.ok) throw new Error(`the fixture request is not valid: ${checked.code}`);
  return checked.request;
}

const reply =
  (status: number, body: string): AnalysisFetch =>
  () =>
    Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(body) });

describe('what is sent', () => {
  it('is one same-origin POST of the request, with no credentials, referrer or caching', async () => {
    const seen: { url: string; init: Parameters<AnalysisFetch>[1] }[] = [];
    const req = await request();
    const transport = createAnalysisTransport({
      fetcher: (url, init) => {
        seen.push({ url, init });
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                ok: true,
                requestId: req.requestId,
                mode: 'human',
                protocolVersion: PROTOCOL_VERSIONS.human,
                analysis: scenarioAnswer('human-ok'),
              }),
            ),
        });
      },
    });
    const outcome = await transport.analyze(req, new AbortController().signal);
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const first = seen[0];
    expect(first?.url).toBe(ANALYZE_URL);
    expect(ANALYZE_URL.startsWith('/')).toBe(true);
    expect(ANALYZE_URL).not.toMatch(/^[a-z]+:/i);
    expect(first?.init.method).toBe('POST');
    expect(first?.init.credentials).toBe('omit');
    expect(first?.init.referrerPolicy).toBe('no-referrer');
    expect(first?.init.cache).toBe('no-store');
    expect(JSON.parse(first?.init.body ?? '{}')).toEqual(JSON.parse(JSON.stringify(req)));
    const keys = Object.keys(JSON.parse(first?.init.body ?? '{}') as object).sort();
    expect(keys).toEqual(['mode', 'protocolVersion', 'requestId', 'summary', 'views']);
    expect(req.views.map((v) => v.view)).toEqual([...VIEW_NAMES]);
  });
});

describe('how a reply is read', () => {
  it('re-derives the sentence from the code and drops whatever text the server sent', async () => {
    const transport = createAnalysisTransport({
      fetcher: reply(
        429,
        JSON.stringify({
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'sk-secret-text from a provider <script>',
            retryAfterSeconds: 42,
          },
        }),
      ),
    });
    const outcome = await transport.analyze(await request(), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe(AnalyzeErrorCode.RateLimited);
    expect(outcome.error.retryAfterSeconds).toBe(42);
    expect(outcome.error.message).not.toContain('sk-secret');
  });

  it('refuses an answer for another request, another mode or a wrong protocol', async () => {
    const req = await request();
    for (const patch of [
      { requestId: 'someone-elses-request' },
      { mode: 'vehicle' },
      { protocolVersion: 'human-v0' },
    ]) {
      const transport = createAnalysisTransport({
        fetcher: reply(
          200,
          JSON.stringify({
            ok: true,
            requestId: req.requestId,
            mode: 'human',
            protocolVersion: PROTOCOL_VERSIONS.human,
            analysis: scenarioAnswer('human-ok'),
            ...patch,
          }),
        ),
      });
      const outcome = await transport.analyze(req, new AbortController().signal);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe(AnalyzeErrorCode.ProviderInvalidResponse);
    }
  });

  it('treats a body that is not our JSON as a service fault, and never shows it', async () => {
    const req = await request();
    const cases: readonly [number, string, AnalyzeErrorCode][] = [
      [502, '<html>Bad gateway</html>', AnalyzeErrorCode.ProviderUnavailable],
      [404, '<html>Not Found</html>', AnalyzeErrorCode.ProviderUnavailable],
      [500, '<html>oops</html>', AnalyzeErrorCode.ProviderInvalidResponse],
      [429, '<html>slow down</html>', AnalyzeErrorCode.RateLimited],
      [503, 'busy', AnalyzeErrorCode.Busy],
      [
        200,
        JSON.stringify({ ok: true, analysis: 'x'.repeat(10) }),
        AnalyzeErrorCode.ProviderInvalidResponse,
      ],
      [200, 'x'.repeat(300_000), AnalyzeErrorCode.ProviderInvalidResponse],
    ];
    for (const [status, body, code] of cases) {
      const outcome = await createAnalysisTransport({ fetcher: reply(status, body) }).analyze(
        req,
        new AbortController().signal,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe(code);
        expect(outcome.error.message).not.toContain('Bad gateway');
      }
    }
  });

  it('reports a failed connection as a network failure', async () => {
    const transport = createAnalysisTransport({
      fetcher: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const outcome = await transport.analyze(await request(), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe(AnalyzeErrorCode.Network);
  });
});

describe('abort and timeout', () => {
  it('aborts the in-flight request when the caller aborts, and reads nothing after', async () => {
    let inner: AbortSignal | undefined;
    const transport = createAnalysisTransport({
      fetcher: (_url, init) => {
        inner = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    });
    const controller = new AbortController();
    const pending = transport.analyze(await request(), controller.signal);
    controller.abort();
    const outcome = await pending;
    expect(inner?.aborted).toBe(true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe(AnalyzeErrorCode.Cancelled);
  });

  it('does not even send when already aborted', async () => {
    let sent = 0;
    const transport = createAnalysisTransport({
      fetcher: () => {
        sent += 1;
        return Promise.reject(new Error('should not be called'));
      },
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await transport.analyze(await request(), controller.signal);
    expect(sent).toBe(0);
    if (!outcome.ok) expect(outcome.error.code).toBe(AnalyzeErrorCode.Cancelled);
  });

  it('a response that arrives after the abort is ignored, not parsed', async () => {
    const transport = createAnalysisTransport({
      fetcher: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}') });
          }, 20);
        }),
    });
    const controller = new AbortController();
    const pending = transport.analyze(await request(), controller.signal);
    controller.abort();
    const outcome = await pending;
    if (!outcome.ok) expect(outcome.error.code).toBe(AnalyzeErrorCode.Cancelled);
    else throw new Error('a late response was accepted');
  });

  it('times out with its own code', async () => {
    const transport = createAnalysisTransport({
      timeoutMs: 20,
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const outcome = await transport.analyze(await request(), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe(AnalyzeErrorCode.ProviderTimeout);
  });
});
