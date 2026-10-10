import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  encodeBase64,
  PROTOCOL_VERSIONS,
  parseAnalyzeResponse,
  VIEW_NAMES,
  type AnalyzeRequest,
  type SemanticMode,
} from '@cadfixer/auto-split-contract';
import { prepareViews, suggestFor, type Deflate } from '@cadfixer/auto-split';
import { carMultipart, humanFigure } from '@cadfixer/auto-split/fixtures';
import { parseConfig } from '../apps/auto-split-api/src/config';
import { createLogger, type Logger } from '../apps/auto-split-api/src/log';
import { createOpenAiProvider } from '../apps/auto-split-api/src/openai-provider';
import { createAnalysisServer } from '../apps/auto-split-api/src/server';

/**
 * AUTO SPLIT — MANUAL LIVE SMOKE TEST. NOT PART OF `npm test`, NOT PART OF CI.
 *
 *   AUTO_SPLIT_LIVE=1 OPENAI_API_KEY=... npm run smoke:auto-split-live
 *
 * It starts the PRODUCTION service in this process with the REAL provider, sends it ONE analysis per
 * mode of a model that Pybrix generated itself (a synthetic figure and a synthetic car; never a
 * customer's or any third party's file), and reports what came back. Two requests, a few cents.
 *
 * WHAT IT CHECKS is the contract and the plumbing, not the provider's accuracy: the answer validates,
 * the local engine turns it into suggestions with statuses from the fixed set, and the service's log
 * lines carry only their whitelisted fields. It asserts nothing about WHICH parts were found, because a
 * real provider is not deterministic and a smoke test that pretended otherwise would be flaky or false.
 *
 * NOTHING SECRET IS RECORDED. The key is read from the environment by the service's own config parser,
 * is never printed, and the output below is request ids, modes, durations, statuses and counts only.
 */
const live = process.env.AUTO_SPLIT_LIVE === '1' && (process.env.OPENAI_API_KEY ?? '') !== '';

const deflate: Deflate = async (raw) => {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(raw)).then(() => writer.close());
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (value) parts.push(value);
    if (done) break;
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const STATUSES = new Set(['SUGGESTED', 'NEEDS_ADJUSTMENT', 'UNAVAILABLE']);

describe.skipIf(!live)('Auto Split live smoke (real provider, generated models only)', () => {
  const lines: Record<string, unknown>[] = [];
  const logger: Logger = createLogger((line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });

  async function run(
    mode: SemanticMode,
    mesh: ReturnType<typeof humanFigure>['mesh'],
  ): Promise<void> {
    const config = parseConfig(
      { ...process.env, AUTO_SPLIT_PORT: '1', AUTO_SPLIT_HOST: '127.0.0.1' },
      { allowMock: false },
    );
    if (config.apiKey === undefined) throw new Error('no key');
    const provider = createOpenAiProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.providerTimeoutMs,
    });
    const server = createAnalysisServer({ config, provider, logger });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const prepared = await prepareViews(mesh, deflate);
      const request: AnalyzeRequest = {
        requestId: `smoke-${mode}-${String(Date.now())}`,
        mode,
        protocolVersion: PROTOCOL_VERSIONS[mode],
        views: VIEW_NAMES.map((view, index) => ({
          view,
          png: encodeBase64(prepared.pngs[index] ?? new Uint8Array(0)),
        })),
        summary: prepared.summary,
      };
      const started = performance.now();
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/api/auto-split/analyze`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      const text = await response.text();
      const seconds = (performance.now() - started) / 1000;
      const parsed = parseAnalyzeResponse(JSON.parse(text) as unknown, {
        requestId: request.requestId,
        mode,
      });
      expect(parsed.ok, `the service answered ${String(response.status)}`).toBe(true);
      if (!parsed.ok) return;
      const answer =
        parsed.analysis.mode === 'human'
          ? ({ mode: 'human', human: parsed.analysis.human } as const)
          : ({ mode: 'vehicle', vehicle: parsed.analysis.vehicle } as const);
      const result = suggestFor(mesh, answer);
      for (const suggestion of result.suggestions)
        expect(STATUSES.has(suggestion.status)).toBe(true);
      const logged = lines.find((line) => line.requestId === request.requestId);
      // `warn` is the one console method the repository allows; this suite exists to print its report.
      console.warn(
        JSON.stringify({
          mode,
          seconds: Number(seconds.toFixed(1)),
          suggestions: result.suggestions.map((s) => ({
            id: s.id,
            status: s.status,
            op: s.operation,
          })),
          service: logged,
        }),
      );
      // The log line has only whitelisted, payload-free fields.
      for (const value of Object.values(logged ?? {}))
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      expect(JSON.stringify(logged ?? {})).not.toMatch(/base64|iVBOR|sk-|Bearer/);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  }

  it('analyses a generated figure', async () => {
    await run('human', humanFigure().mesh);
  }, 240_000);

  it('analyses a generated car', async () => {
    await run('vehicle', carMultipart().mesh);
  }, 240_000);
});
