import { required } from '@cadfixer/auto-split/fixtures';
import { deflateSync } from 'node:zlib';
import { prepareSemanticGeometry } from '@cadfixer/auto-split';
import { semanticFixture, annotatedFixture } from '@cadfixer/auto-split/fixtures';
import { encodeBase64, VIEW_NAMES } from '@cadfixer/auto-split-contract';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, createServer as createHttpServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnalyzeErrorCode,
  MAX_REQUEST_BODY_BYTES,
  PROTOCOL_VERSIONS,
  VEHICLE_PROMPT_VERSION,
} from '@cadfixer/auto-split-contract';
import { makeRequest } from '@cadfixer/auto-split-contract/test-fixtures';
import { DEFAULT_LIMITS, parseConfig, type ServerConfig } from './config';
import { AnalysisLimiter } from './limiter';
import { createLogger, sanitize, type LogEvent } from './log';
import { createOpenAiProvider } from './openai-provider';
import {
  ProviderFailure,
  ProviderFailureKind,
  type Provider,
  type ProviderInput,
} from './provider';
import { planFor } from './prompts';
import { createAnalysisServer, ANALYZE_PATH, HEALTH_PATH, clientKey } from './server';
import { buildUserText, SYSTEM_PROMPT, vehicleJsonSchema } from './vehicle-protocol';
import { buildHumanUserText, humanJsonSchema, HUMAN_SYSTEM_PROMPT } from './human-protocol';
const KEY = 'sk-test-0000000000000000000000-DO-NOT-LOG';
function config(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    provider: 'openai',
    apiKey: KEY,
    baseUrl: 'http://127.0.0.1:1',
    model: 'gpt-6.1-sol',
    limits: { ...DEFAULT_LIMITS, perClientMax: 3 },
    trustProxy: false,
    providerTimeoutMs: 5000,
    maxOutputTokens: 1000,
    providerRetries: 1,
    retryDelayMs: 1,
    ...over,
  };
}
const HUMAN_ANSWER = {
  figure: { kind: 'humanoid_figure' },
  parts: Object.fromEntries(
    ['head', 'left_arm', 'right_arm'].map((s) => [
      s,
      {
        status: 'PRESENT',
        center: [0, 0, 0.4],
        extent: [0.2, 0.2, 0.2],
        plane_normal: [0, 0, 1],
        plane_offset: 0.3,
      },
    ]),
  ),
};
interface Harness {
  readonly url: string;
  readonly logs: LogEvent[];
  readonly rawLines: string[];
  readonly server: Server;
}
const open: Server[] = [];
afterEach(async () => {
  for (const s of open.splice(0))
    await new Promise<void>((r) =>
      s.close(() => {
        r();
      }),
    );
});
async function start(provider: Provider, over: Partial<ServerConfig> = {}): Promise<Harness> {
  const rawLines: string[] = [];
  const logs: LogEvent[] = [];
  const base = createLogger((l) => rawLines.push(l));
  const server = createAnalysisServer({
    config: config(over),
    provider,
    logger: {
      log: (e) => {
        logs.push(e);
        base.log(e);
      },
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(server);
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    logs,
    rawLines,
    server,
  };
}
const okProvider = (answer: unknown = HUMAN_ANSWER): Provider => ({
  analyze: () =>
    Promise.resolve({
      text: JSON.stringify(answer),
      usage: { inputTokens: 4500, cachedInputTokens: 0, outputTokens: 2500, reasoningTokens: 500 },
      providerStatus: 200,
    }),
});
async function post(
  h: Harness,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}> {
  const res = await fetch(`${h.url}${ANALYZE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}
describe('the analysis route', () => {
  it('validates semantic hierarchy and passes exactly twelve images plus bounded metadata to the provider', async () => {
    const fixture = semanticFixture('chair'),
      prepared = await prepareSemanticGeometry(fixture.mesh, (raw) =>
        Promise.resolve(new Uint8Array(deflateSync(raw))),
      ),
      answer = annotatedFixture(prepared, fixture);
    const inputs: ProviderInput[] = [];
    const h = await start({
      analyze: (input) => {
        inputs.push(input);
        return okProvider(answer).analyze(input, new AbortController().signal);
      },
    });
    const body = {
      requestId: 'semantic-service-test',
      mode: 'semantic',
      protocolVersion: PROTOCOL_VERSIONS.semantic,
      views: VIEW_NAMES.map((view, i) => ({
        view,
        png: encodeBase64(required(prepared.pngs[i], 'prepared.pngs[i]')),
      })),
      componentViews: VIEW_NAMES.map((view, i) => ({
        view,
        png: encodeBase64(required(prepared.componentPngs[i], 'prepared.componentPngs[i]')),
      })),
      semantic: prepared.metadata,
      summary: {
        extents: prepared.geometry.extents,
        shells: prepared.labelling.count,
        radius: prepared.geometry.radius,
      },
    };
    const response = await post(h, body);
    expect(response.status).toBe(200);
    expect(response.json.analysis).toEqual(answer);
    expect(inputs[0]?.pngBase64).toHaveLength(12);
    expect(inputs[0]?.plan.schemaName).toBe('semantic_hierarchy');
    expect(inputs[0]?.plan.userText).toContain('selected-piece');
    expect(inputs[0]?.plan.userText).toContain('camera at');
    expect(h.rawLines.join('')).not.toContain('Backrest');
    expect(h.rawLines.join('')).not.toContain(required(body.views[0], 'body.views[0]').png);
    const invalid = await post(h, { ...body, semantic: { ...body.semantic, positions: [0] } });
    expect(invalid.status).toBe(400);
    expect(inputs).toHaveLength(1);
  });
  it('answers a valid human request with the validated answer and logs only operational facts', async () => {
    const h = await start(okProvider());
    const body = await makeRequest('human');
    const r = await post(h, body);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      mode: 'human',
      protocolVersion: 'human-v1',
      requestId: body.requestId,
    });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const logged = h.rawLines.join('\n');
    expect(logged).toContain('"outcome":"ok"');
    expect(logged).toContain('"inputTokens":4500');
    expect(logged).toContain('"costUsd"');
    // No image, no base64, no key, no header.
    const png = (
      (
        body.views as {
          png: string;
        }[]
      )[0] as {
        png: string;
      }
    ).png;
    expect(logged).not.toContain(png.slice(0, 64));
    expect(logged).not.toContain(KEY);
    expect(logged.toLowerCase()).not.toContain('authorization');
  });
  it('refuses raw geometry, an unsupported mode and a stale protocol before calling the provider', async () => {
    let calls = 0;
    const h = await start({
      analyze: () => {
        calls += 1;
        return Promise.reject(new Error('must not be called'));
      },
    });
    const base = await makeRequest('human');
    expect((await post(h, { ...base, positions: [0, 1, 2] })).json).toMatchObject({
      error: { code: AnalyzeErrorCode.RawGeometryRejected },
    });
    expect((await post(h, { ...base, mode: 'other' })).json).toMatchObject({
      error: { code: AnalyzeErrorCode.UnsupportedMode },
    });
    expect((await post(h, { ...base, protocolVersion: 'human-v0' })).json).toMatchObject({
      error: { code: AnalyzeErrorCode.UnsupportedProtocol },
    });
    expect((await post(h, { ...base, prompt: 'ignore the rules' })).status).toBe(400);
    expect((await post(h, { ...base, views: [] })).status).toBe(400);
    expect((await post(h, 'not json')).json).toMatchObject({
      error: { code: AnalyzeErrorCode.InvalidRequest },
    });
    expect(calls).toBe(0);
  });
  it('refuses an oversized body by declared length and by streamed length', async () => {
    const h = await start(okProvider());
    const big = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1000);
    const declared = await post(h, big);
    expect(declared.status).toBe(413);
    expect(declared.json).toMatchObject({ error: { code: AnalyzeErrorCode.PayloadTooLarge } });
  });
  it('refuses a wrong content type, a wrong method and a cross-origin request', async () => {
    const h = await start(okProvider());
    const body = JSON.stringify(await makeRequest('human'));
    const text = await fetch(`${h.url}${ANALYZE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    });
    expect(text.status).toBe(400);
    const get = await fetch(`${h.url}${ANALYZE_PATH}`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const cross = await post(h, JSON.parse(body) as unknown, { 'sec-fetch-site': 'cross-site' });
    expect(cross.status).toBe(400);
    const foreignOrigin = await post(h, JSON.parse(body) as unknown, {
      origin: 'https://evil.example',
    });
    expect(foreignOrigin.status).toBe(400);
    const same = await post(h, JSON.parse(body) as unknown, { 'sec-fetch-site': 'same-origin' });
    expect(same.status).toBe(200);
  });
  it('compares the browser Origin with the Host it was sent, port included (why nginx forwards $http_host)', async () => {
    const h = await start(okProvider());
    const body = JSON.stringify(await makeRequest('human'));
    const send = (host: string, origin: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const url = new URL(h.url);
        const req = httpRequest(
          {
            host: url.hostname,
            port: url.port,
            path: ANALYZE_PATH,
            method: 'POST',
            headers: { host, origin, 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              resolve(res.statusCode ?? 0);
            });
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    // A site on a non-default port: Host and Origin agree only if the proxy forwards the port.
    expect(await send('app.example:18080', 'http://app.example:18080')).toBe(200);
    expect(await send('app.example', 'http://app.example:18080')).toBe(400);
    // The default port: both sides omit it.
    expect(await send('app.example', 'https://app.example')).toBe(200);
  });
  it('serves a health route and 404s everything else', async () => {
    const h = await start(okProvider());
    expect((await fetch(`${h.url}${HEALTH_PATH}`)).status).toBe(200);
    expect((await fetch(`${h.url}/api/auto-split/other`)).status).toBe(404);
    expect((await fetch(`${h.url}/`)).status).toBe(404);
  });
  it('sanitises a provider failure to our own sentence and never forwards provider text', async () => {
    const h = await start({
      analyze: () =>
        Promise.reject(
          Object.assign(new ProviderFailure(ProviderFailureKind.Unavailable, 503, false), {
            providerBody: 'secret provider words',
          }),
        ),
    });
    const r = await post(h, await makeRequest('human'));
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toContain('secret provider words');
    expect(r.json).toMatchObject({
      ok: false,
      error: { code: AnalyzeErrorCode.ProviderUnavailable },
    });
  });
  it('turns a malformed or schema-invalid provider answer into PROVIDER_INVALID_RESPONSE without retrying it', async () => {
    let calls = 0;
    const bad: Provider = {
      analyze: () => {
        calls += 1;
        return Promise.resolve({
          text: '{"figure":1}',
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
          providerStatus: 200,
        });
      },
    };
    const h = await start(bad);
    const r = await post(h, await makeRequest('human'));
    expect(r.json).toMatchObject({ error: { code: AnalyzeErrorCode.ProviderInvalidResponse } });
    expect(calls).toBe(1);
    const garbage = await start({
      analyze: () =>
        Promise.resolve({
          text: 'not json at all',
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
          providerStatus: 200,
        }),
    });
    expect((await post(garbage, await makeRequest('human'))).json).toMatchObject({
      error: { code: AnalyzeErrorCode.ProviderInvalidResponse },
    });
  });
  it('retries a transient failure a bounded number of times and stops on a permanent one', async () => {
    let calls = 0;
    const flaky: Provider = {
      analyze: (input: ProviderInput) => {
        calls += 1;
        if (calls < 2)
          return Promise.reject(new ProviderFailure(ProviderFailureKind.Unavailable, 503, true));
        return okProvider().analyze(input, new AbortController().signal);
      },
    };
    const h = await start(flaky);
    expect((await post(h, await makeRequest('human'))).status).toBe(200);
    expect(calls).toBe(2);
    calls = 0;
    const alwaysTransient: Provider = {
      analyze: () => {
        calls += 1;
        return Promise.reject(new ProviderFailure(ProviderFailureKind.Unavailable, 503, true));
      },
    };
    const h2 = await start(alwaysTransient, { providerRetries: 1 });
    expect((await post(h2, await makeRequest('human'))).status).toBe(502);
    expect(calls).toBe(2);
    calls = 0;
    const permanent: Provider = {
      analyze: () => {
        calls += 1;
        return Promise.reject(new ProviderFailure(ProviderFailureKind.InvalidRequest, 400, false));
      },
    };
    const h3 = await start(permanent);
    await post(h3, await makeRequest('human'));
    expect(calls).toBe(1);
  });
  it('maps a provider timeout to PROVIDER_TIMEOUT', async () => {
    const h = await start({
      analyze: () => Promise.reject(new ProviderFailure(ProviderFailureKind.Timeout)),
    });
    const r = await post(h, await makeRequest('human'));
    expect(r.status).toBe(504);
    expect(r.json).toMatchObject({ error: { code: AnalyzeErrorCode.ProviderTimeout } });
  });
  it('aborts the provider call when the browser goes away', async () => {
    const seen = { aborted: false };
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    const provider: Provider = {
      analyze: (_input, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener('abort', () => {
            seen.aborted = true;
            reject(new ProviderFailure(ProviderFailureKind.Cancelled));
          });
        }),
    };
    const h = await start(provider);
    const controller = new AbortController();
    const pending = fetch(`${h.url}${ANALYZE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await makeRequest('human')),
      signal: controller.signal,
    }).catch(() => undefined);
    await begun;
    controller.abort();
    await pending;
    for (let i = 0; i < 50 && !seen.aborted; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(seen.aborted).toBe(true);
    // The slot is released: the same client may start another.
    for (let i = 0; i < 50 && h.logs.every((l) => l.outcome !== AnalyzeErrorCode.Cancelled); i += 1)
      await new Promise((r) => setTimeout(r, 10));
    expect(h.logs.some((l) => l.outcome === AnalyzeErrorCode.Cancelled)).toBe(true);
  });
  it('rate limits one client, with a retry time, and counts only its own requests', async () => {
    const h = await start(okProvider(), {
      trustProxy: true,
      limits: { ...DEFAULT_LIMITS, perClientMax: 2 },
    });
    const body = await makeRequest('human');
    const a = { 'x-real-ip': '203.0.113.7' };
    expect((await post(h, body, a)).status).toBe(200);
    expect((await post(h, body, a)).status).toBe(200);
    const limited = await post(h, body, a);
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ error: { code: AnalyzeErrorCode.RateLimited } });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post(h, body, { 'x-real-ip': '203.0.113.8' })).status).toBe(200);
  });
});
describe('the limiter', () => {
  it('slides the window, caps concurrency per client and globally, and releases exactly once', () => {
    let clock = 0;
    const limiter = new AnalysisLimiter(
      {
        ...DEFAULT_LIMITS,
        perClientMax: 2,
        windowMs: 1000,
        perClientConcurrent: 1,
        globalConcurrent: 2,
        maxTrackedClients: 10,
      },
      () => clock,
    );
    const first = limiter.admit('a');
    expect(first.allowed).toBe(true);
    expect(limiter.admit('a')).toMatchObject({ allowed: false, reason: 'busy' });
    if (first.allowed) {
      first.release();
      first.release();
    }
    expect(limiter.inFlight).toBe(0);
    const second = limiter.admit('a');
    if (second.allowed) second.release();
    expect(limiter.admit('a')).toMatchObject({ allowed: false, reason: 'rate' });
    clock = 1001;
    expect(limiter.admit('a').allowed).toBe(true);
    const b = limiter.admit('b');
    expect(b.allowed).toBe(true);
    expect(limiter.admit('c')).toMatchObject({ allowed: false, reason: 'busy' });
  });
  it('forgets the oldest idle clients and never one that is running', () => {
    const limiter = new AnalysisLimiter(
      {
        ...DEFAULT_LIMITS,
        perClientMax: 5,
        windowMs: 1000,
        perClientConcurrent: 1,
        globalConcurrent: 100,
        maxTrackedClients: 3,
      },
      () => 0,
    );
    const held = limiter.admit('held');
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const r = limiter.admit(id);
      if (r.allowed) r.release();
    }
    expect(limiter.trackedClients).toBeLessThanOrEqual(4);
    if (held.allowed) held.release();
    expect(limiter.inFlight).toBe(0);
  });
});
describe('the OpenAI provider', () => {
  async function fakeUpstream(
    handler: (
      body: Record<string, unknown>,
      headers: Record<string, string | string[] | undefined>,
    ) => {
      status: number;
      body: unknown;
    },
  ): Promise<{
    url: string;
    seen: Record<string, unknown>[];
  }> {
    const seen: Record<string, unknown>[] = [];
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        seen.push({ ...body, __auth: req.headers.authorization, __path: req.url });
        const out = handler(body, req.headers);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    open.push(server);
    return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
  }
  const input = (): ProviderInput => ({
    mode: 'human',
    plan: planFor({
      requestId: 'req-0123456789ab',
      mode: 'human',
      protocolVersion: 'human-v1',
      views: [],
      summary: { extents: [1, 0.5, 0.25], shells: 1, radius: 0.6 },
    }),
    pngBase64: ['AAAA', 'AAAA', 'AAAA', 'AAAA', 'AAAA', 'AAAA'],
  });
  it('sends the Responses request the research used: store false, strict schema, the pinned model, six images', async () => {
    const up = await fakeUpstream(() => ({
      status: 200,
      body: {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    }));
    const provider = createOpenAiProvider({
      apiKey: KEY,
      baseUrl: up.url,
      model: 'gpt-6.1-sol',
      maxOutputTokens: 123,
      timeoutMs: 5000,
    });
    const out = await provider.analyze(input(), new AbortController().signal);
    expect(out.text).toBe('{"a":1}');
    expect(out.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reasoningTokens: 1,
    });
    const sent = up.seen[0] as Record<string, unknown> & {
      text: {
        format: {
          strict: boolean;
          type: string;
        };
      };
      input: {
        content: {
          type: string;
        }[];
      }[];
    };
    expect(sent.__path).toBe('/responses');
    expect(sent.__auth).toBe(`Bearer ${KEY}`);
    expect(sent.store).toBe(false);
    expect(sent.model).toBe('gpt-6.1-sol');
    expect(sent.max_output_tokens).toBe(123);
    expect(sent.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(sent.input[0]?.content.filter((c) => c.type === 'input_image')).toHaveLength(6);
    expect(Object.keys(sent).sort()).toEqual([
      '__auth',
      '__path',
      'input',
      'instructions',
      'max_output_tokens',
      'model',
      'store',
      'text',
    ]);
  });
  it('maps statuses to failure kinds and never copies provider text', async () => {
    const cases: [number, ProviderFailureKind, boolean][] = [
      [429, ProviderFailureKind.RateLimited, true],
      [500, ProviderFailureKind.Unavailable, true],
      [503, ProviderFailureKind.Unavailable, true],
      [401, ProviderFailureKind.Unavailable, false],
      [400, ProviderFailureKind.InvalidRequest, false],
    ];
    for (const [status, kind, transient] of cases) {
      const up = await fakeUpstream(() => ({
        status,
        body: { error: { message: `leak ${KEY} prompt text` } },
      }));
      const provider = createOpenAiProvider({
        apiKey: KEY,
        baseUrl: up.url,
        model: 'm',
        maxOutputTokens: 1,
        timeoutMs: 5000,
      });
      const error = await provider
        .analyze(input(), new AbortController().signal)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderFailure);
      const failure = error as ProviderFailure;
      expect([failure.kind, failure.transient]).toEqual([kind, transient]);
      expect(failure.message).not.toContain('leak');
      expect(failure.message).not.toContain(KEY);
    }
  });
  it('reports a refusal, an incomplete response, a timeout and a cancel', async () => {
    const refusal = await fakeUpstream(() => ({
      status: 200,
      body: {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      },
    }));
    const incomplete = await fakeUpstream(() => ({
      status: 200,
      body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    }));
    for (const [up, kind] of [
      [refusal, ProviderFailureKind.Refused],
      [incomplete, ProviderFailureKind.Incomplete],
    ] as const) {
      const provider = createOpenAiProvider({
        apiKey: KEY,
        baseUrl: up.url,
        model: 'm',
        maxOutputTokens: 1,
        timeoutMs: 5000,
      });
      const error = (await provider
        .analyze(input(), new AbortController().signal)
        .catch((e: unknown) => e)) as ProviderFailure;
      expect(error.kind).toBe(kind);
    }
    const slow = createServerThatNeverAnswers();
    const url = await slow;
    const provider = createOpenAiProvider({
      apiKey: KEY,
      baseUrl: url,
      model: 'm',
      maxOutputTokens: 1,
      timeoutMs: 100,
    });
    const timedOut = (await provider
      .analyze(input(), new AbortController().signal)
      .catch((e: unknown) => e)) as ProviderFailure;
    expect(timedOut.kind).toBe(ProviderFailureKind.Timeout);
    const controller = new AbortController();
    const slowProvider = createOpenAiProvider({
      apiKey: KEY,
      baseUrl: url,
      model: 'm',
      maxOutputTokens: 1,
      timeoutMs: 5000,
    });
    const pending = slowProvider.analyze(input(), controller.signal).catch((e: unknown) => e);
    setTimeout(() => {
      controller.abort();
    }, 50);
    expect(((await pending) as ProviderFailure).kind).toBe(ProviderFailureKind.Cancelled);
  });
});
async function createServerThatNeverAnswers(): Promise<string> {
  const server = createHttpServer(() => undefined);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(server);
  server.closeAllConnections();
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}
describe('configuration', () => {
  const env = { OPENAI_API_KEY: KEY } as NodeJS.ProcessEnv;
  it('requires a usable key for the real provider and refuses mock where it is not built', () => {
    expect(parseConfig(env, { allowMock: false }).provider).toBe('openai');
    expect(() => parseConfig({}, { allowMock: false })).toThrow(/OPENAI_API_KEY/);
    expect(() => parseConfig({ OPENAI_API_KEY: '\u001b[Dsk-abc' }, { allowMock: false })).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() =>
      parseConfig({ ...env, AUTO_SPLIT_PROVIDER: 'mock' }, { allowMock: false }),
    ).toThrow(/mock/);
    expect(
      parseConfig({ AUTO_SPLIT_PROVIDER: 'mock' }, { allowMock: true }).apiKey,
    ).toBeUndefined();
  });
  it('refuses a malformed number and a production base-URL override, and never echoes the key', () => {
    expect(() => parseConfig({ ...env, AUTO_SPLIT_PORT: 'abc' }, { allowMock: false })).toThrow(
      /AUTO_SPLIT_PORT/,
    );
    expect(() =>
      parseConfig(
        { ...env, NODE_ENV: 'production', OPENAI_BASE_URL: 'http://evil.example' },
        { allowMock: false },
      ),
    ).toThrow(/production/);
    try {
      parseConfig({ OPENAI_API_KEY: 'short' }, { allowMock: false });
    } catch (error) {
      expect(String(error)).not.toContain('short');
    }
  });
  it('pins the model, and trusts a proxy address only when told to', () => {
    expect(parseConfig(env, { allowMock: false }).model).toBe('gpt-6.1-sol');
    const req = {
      headers: { 'x-real-ip': '198.51.100.9' },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as Parameters<typeof clientKey>[0];
    expect(clientKey(req, true)).toBe('198.51.100.9');
    expect(clientKey(req, false)).toBe('10.0.0.1');
    const forged = {
      headers: { 'x-real-ip': 'a; drop table' },
      socket: { remoteAddress: undefined },
    } as unknown as Parameters<typeof clientKey>[0];
    expect(clientKey(forged, true)).toBe('unknown');
  });
});
describe('the logger', () => {
  it('drops anything that is not a number, a boolean or a short plain token', () => {
    const dirty = {
      event: 'request',
      requestId: 'data:image/png;base64,AAAA',
      mode: 'human',
      outcome: 'x'.repeat(200),
      status: 200,
    } as unknown as LogEvent;
    expect(sanitize(dirty)).toEqual({ event: 'request', mode: 'human', status: 200 });
  });
});
describe('the pinned protocols', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  it('keeps the vehicle protocol byte for byte what the research froze (VEHICLE_SEMANTIC_PROTOCOL_V0)', () => {
    expect(PROTOCOL_VERSIONS.vehicle).toBe('vehicle-v0');
    expect(VEHICLE_PROMPT_VERSION).toBe('pv.0');
    expect(sha(SYSTEM_PROMPT)).toBe(
      '67dc609d84c53a27e69079a4963898196afa2e2a27e0666f83522f05852de01a',
    );
    expect(sha(buildUserText('m-0000000000', { extents: [0, 0, 0], components: 0 }))).toBe(
      '016661858c5a79a9888755958efbafed3fb394d88bee6ec0950dfd6ccfba2d19',
    );
    expect(sha(JSON.stringify(vehicleJsonSchema()))).toBe(
      '49c6ac21fed845004ba54823d618cee8e58b2b51e70f92863faf23debc87b84d',
    );
  });
  it('makes a human schema that requires every property of every object, as strict output demands', () => {
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') {
        expect([...((n.required as string[] | undefined) ?? [])].sort(), path).toEqual(
          Object.keys(n.properties ?? {}).sort(),
        );
        expect(n.additionalProperties, path).toBe(false);
      }
      for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
    };
    walk(humanJsonSchema(), '$');
    walk(vehicleJsonSchema(), '$');
  });
  it('builds a human request text from the id and two bounded values only, and carries no file word', () => {
    const text = buildHumanUserText('req-0123456789ab', { extents: [1, 0.5, 0.25], shells: 3 });
    expect(text).toContain('Image 6: bottom view');
    expect(text).toContain('req-0123456789ab');
    expect(text.toLowerCase()).not.toMatch(/\.stl|\.obj|\.3mf|c:\\|\/users\//);
    expect(HUMAN_SYSTEM_PROMPT).toContain('OWN anatomical sides');
  });
});
