import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyzeErrorCode, ANALYZE_ERROR_MESSAGES } from '@cadfixer/auto-split-contract';
import { makeRequest } from '@cadfixer/auto-split-contract/test-fixtures';
import {
  ConfigError,
  DEFAULT_LIMITS,
  MAX_GLOBAL_ENTRIES,
  parseConfig,
  type ServerConfig,
} from './config';
import { AnalysisLimiter, WindowCounter } from './limiter';
import { createLogger } from './log';
import {
  ProviderFailure,
  ProviderFailureKind,
  type Provider,
  type ProviderResult,
} from './provider';
import { ANALYZE_PATH, createAnalysisServer, HEALTH_PATH } from './server';

/**
 * THE SERVICE-WIDE CEILINGS (RC2.2): an hourly and a daily bound on provider attempts that no choice of
 * client identity can get around.
 *
 * Everything here uses a fake provider that COUNTS its calls and a fake clock the test advances by hand,
 * so "exactly N" and "exactly at the boundary" are statements about the implementation and not about luck.
 * No request in this file leaves the machine, and none reaches OpenAI.
 */

const KEY = 'sk-test-0000000000000000000000-DO-NOT-LOG';
const HOUR = 3_600_000;
const DAY = 86_400_000;

const HUMAN_ANSWER = {
  figure: { kind: 'humanoid_figure' },
  parts: Object.fromEntries(
    ['head', 'left_arm', 'right_arm'].map((slot) => [
      slot,
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

const USAGE = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 };

interface Counting {
  readonly provider: Provider;
  readonly calls: () => number;
  readonly aborted: () => number;
}

function counting(behave: (call: number, signal: AbortSignal) => Promise<string>): Counting {
  let calls = 0;
  let aborted = 0;
  return {
    calls: () => calls,
    aborted: () => aborted,
    provider: {
      async analyze(_input, signal): Promise<ProviderResult> {
        calls += 1;
        signal.addEventListener('abort', () => {
          aborted += 1;
        });
        const text = await behave(calls, signal);
        return { text, usage: USAGE, providerStatus: 200 };
      },
    },
  };
}

const ok = (): Promise<string> => Promise.resolve(JSON.stringify(HUMAN_ANSWER));

function limits(over: Partial<ServerConfig['limits']> = {}): ServerConfig['limits'] {
  return {
    ...DEFAULT_LIMITS,
    perClientMax: 100,
    perClientConcurrent: 10,
    globalConcurrent: 100,
    globalRateMax: 5,
    globalRateWindowMs: HOUR,
    globalDailyMax: 1000,
    globalDailyWindowMs: DAY,
    ...over,
  };
}

function config(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    provider: 'openai',
    apiKey: KEY,
    baseUrl: 'http://127.0.0.1:1',
    model: 'gpt-6.1-sol',
    limits: limits(),
    trustProxy: true,
    providerTimeoutMs: 5000,
    maxOutputTokens: 1000,
    providerRetries: 0,
    retryDelayMs: 0,
    ...over,
  };
}

interface Harness {
  readonly url: string;
  readonly lines: string[];
  readonly clock: { now: number };
}
const open: Server[] = [];
afterEach(async () => {
  for (const s of open.splice(0))
    await new Promise<void>((resolve) =>
      s.close(() => {
        resolve();
      }),
    );
});

async function start(provider: Provider, over: Partial<ServerConfig> = {}): Promise<Harness> {
  const lines: string[] = [];
  const clock = { now: 1_000_000 };
  const server = createAnalysisServer({
    config: config(over),
    provider,
    logger: createLogger((line) => lines.push(line)),
    now: () => clock.now,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(server);
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    lines,
    clock,
  };
}

interface Reply {
  readonly status: number;
  readonly json: {
    ok: boolean;
    error?: { code: string; message: string; retryAfterSeconds?: number };
  };
  readonly retryAfter: string | null;
}

async function analyze(h: Harness, ip: string, signal?: AbortSignal): Promise<Reply> {
  const res = await fetch(`${h.url}${ANALYZE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(await makeRequest('human')),
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    status: res.status,
    json: (await res.json()) as Reply['json'],
    retryAfter: res.headers.get('retry-after'),
  };
}

/** `n` analyses from `n` different client addresses. */
async function many(h: Harness, n: number, prefix = '198.51.100.'): Promise<Reply[]> {
  const out: Reply[] = [];
  for (let i = 0; i < n; i += 1) out.push(await analyze(h, `${prefix}${String(i + 1)}`));
  return out;
}

const statuses = (replies: readonly Reply[]): number[] => replies.map((r) => r.status);

describe('A. the hourly ceiling, whoever asks', () => {
  it('admits exactly N analyses from N different clients, refuses the rest, and calls the provider N times', async () => {
    const p = counting(ok);
    const h = await start(p.provider);
    const replies = await many(h, 12);
    expect(statuses(replies)).toEqual([200, 200, 200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
    expect(p.calls()).toBe(5);
    for (const refused of replies.slice(5))
      expect(refused.json.error?.code).toBe(AnalyzeErrorCode.AtCapacity);
  });
});

describe('B. the daily ceiling cannot be walked around by hourly windows rolling over', () => {
  it('keeps counting across hours, and refuses the N+1th of the day', async () => {
    const p = counting(ok);
    const h = await start(p.provider, {
      limits: limits({ globalRateMax: 3, globalDailyMax: 5 }),
    });
    expect(statuses(await many(h, 3))).toEqual([200, 200, 200]);
    // The hour is over: the hourly window is empty again.
    h.clock.now += HOUR + 1;
    expect(statuses(await many(h, 3, '203.0.113.'))).toEqual([200, 200, 429]);
    expect(p.calls()).toBe(5);
    // Another hour, still the same day: the day is still full.
    h.clock.now += HOUR + 1;
    expect(statuses(await many(h, 2, '192.0.2.'))).toEqual([429, 429]);
    expect(p.calls()).toBe(5);
    // A full day after the first admission, the day has room again.
    h.clock.now += DAY;
    expect(statuses(await many(h, 1, '192.0.2.'))).toEqual([200]);
    expect(p.calls()).toBe(6);
  });
});

describe('C. per-client and service-wide limits together', () => {
  it('keeps the per-client limit, with its own code, and a refusal for it spends nothing service-wide', async () => {
    const p = counting(ok);
    const h = await start(p.provider, { limits: limits({ perClientMax: 2, globalRateMax: 4 }) });
    expect(statuses([await analyze(h, '10.0.0.1'), await analyze(h, '10.0.0.1')])).toEqual([
      200, 200,
    ]);
    const third = await analyze(h, '10.0.0.1');
    expect(third.status).toBe(429);
    expect(third.json.error?.code).toBe(AnalyzeErrorCode.RateLimited);
    // Two admitted so far; the per-client refusal consumed nothing, so two more can be admitted.
    expect(statuses([await analyze(h, '10.0.0.2'), await analyze(h, '10.0.0.3')])).toEqual([
      200, 200,
    ]);
    expect((await analyze(h, '10.0.0.4')).json.error?.code).toBe(AnalyzeErrorCode.AtCapacity);
    expect(p.calls()).toBe(4);
  });

  it('is not moved by anything a client says about itself: unique addresses, forged forwarding headers', async () => {
    const p = counting(ok);
    const h = await start(p.provider);
    const body = JSON.stringify(await makeRequest('human'));
    let admitted = 0;
    for (let i = 0; i < 40; i += 1) {
      const res = await fetch(`${h.url}${ANALYZE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-real-ip': `192.0.2.${String(i + 1)}`,
          'x-forwarded-for': `203.0.113.${String(i + 1)}, 10.1.1.1`,
          forwarded: `for=198.51.100.${String(i + 1)}`,
        },
        body,
      });
      if (res.status === 200) admitted += 1;
      await res.arrayBuffer();
    }
    expect(admitted).toBe(5);
    expect(p.calls()).toBe(5);
  });

  it('applies the same bound when the proxy is not trusted and every request is one address', async () => {
    const p = counting(ok);
    const h = await start(p.provider, { trustProxy: false, limits: limits({ perClientMax: 100 }) });
    expect(statuses(await many(h, 8))).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
    expect(p.calls()).toBe(5);
  });
});

describe('D. concurrency is retained, and the ceilings do not weaken it', () => {
  it('refuses a seventh-style overflow as busy, spends nothing for it, and releases cleanly', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = counting(async () => {
      await gate;
      return JSON.stringify(HUMAN_ANSWER);
    });
    const h = await start(p.provider, {
      limits: limits({ globalConcurrent: 2, globalRateMax: 4 }),
    });
    const first = analyze(h, '10.0.0.1');
    const second = analyze(h, '10.0.0.2');
    // Wait until both are inside the provider.
    for (let i = 0; i < 200 && p.calls() < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(p.calls()).toBe(2);
    const third = await analyze(h, '10.0.0.3');
    expect(third.status).toBe(503);
    expect(third.json.error?.code).toBe(AnalyzeErrorCode.Busy);
    expect(p.calls()).toBe(2);
    release();
    expect(statuses(await Promise.all([first, second]))).toEqual([200, 200]);
    // The busy refusal spent nothing: two more of the four service-wide admissions remain.
    expect(statuses([await analyze(h, '10.0.0.4'), await analyze(h, '10.0.0.5')])).toEqual([
      200, 200,
    ]);
    expect((await analyze(h, '10.0.0.6')).json.error?.code).toBe(AnalyzeErrorCode.AtCapacity);
    const health = (await (await fetch(`${h.url}${HEALTH_PATH}`)).json()) as { inFlight: number };
    expect(health.inFlight).toBe(0);
  });
});

describe('E. a request that never reaches the provider spends nothing', () => {
  it('survives a barrage of invalid requests with the whole allowance intact', async () => {
    const p = counting(ok);
    const h = await start(p.provider);
    const good = JSON.parse(JSON.stringify(await makeRequest('human'))) as Record<string, unknown>;
    const post = (body: string, headers: Record<string, string>): Promise<Response> =>
      fetch(`${h.url}${ANALYZE_PATH}`, {
        method: 'POST',
        body,
        headers: { 'x-real-ip': '10.9.9.9', ...headers },
      });
    const json = { 'content-type': 'application/json' };
    const refusals: Response[] = [];
    for (let i = 0; i < 6; i += 1) {
      refusals.push(await post('{ not json', json));
      refusals.push(await post(JSON.stringify({ ...good, positions: [0, 1, 2] }), json));
      refusals.push(await post(JSON.stringify({ ...good, mode: 'boat' }), json));
      refusals.push(await post(JSON.stringify(good), { 'content-type': 'text/plain' }));
      refusals.push(await post(JSON.stringify(good), { ...json, origin: 'https://evil.example' }));
      refusals.push(await post(JSON.stringify({ ...good, views: [] }), json));
    }
    expect(refusals.every((r) => r.status === 400)).toBe(true);
    expect(p.calls()).toBe(0);
    // All five admissions are still there.
    expect(statuses(await many(h, 5))).toEqual([200, 200, 200, 200, 200]);
    expect(p.calls()).toBe(5);
  });
});

describe('F. a provider attempt spends its slot however it ends, and a retry cannot be a way round', () => {
  const transient = (): Promise<string> =>
    Promise.reject(new ProviderFailure(ProviderFailureKind.Unavailable, 503, true));

  it('counts an admitted analysis that fails', async () => {
    const p = counting(transient);
    const h = await start(p.provider, { limits: limits({ globalRateMax: 2 }) });
    expect(statuses([await analyze(h, '10.0.0.1'), await analyze(h, '10.0.0.2')])).toEqual([
      502, 502,
    ]);
    expect((await analyze(h, '10.0.0.3')).json.error?.code).toBe(AnalyzeErrorCode.AtCapacity);
    expect(p.calls()).toBe(2);
  });

  it('counts a malformed answer as an attempt', async () => {
    const p = counting(() => Promise.resolve('{"not":"the schema"'));
    const h = await start(p.provider, { limits: limits({ globalRateMax: 1 }) });
    expect((await analyze(h, '10.0.0.1')).status).toBe(502);
    expect((await analyze(h, '10.0.0.2')).json.error?.code).toBe(AnalyzeErrorCode.AtCapacity);
    expect(p.calls()).toBe(1);
  });

  it('spends a second slot for a retry, so the bound is on provider CALLS', async () => {
    const p = counting(transient);
    const h = await start(p.provider, { providerRetries: 1, limits: limits({ globalRateMax: 2 }) });
    const reply = await analyze(h, '10.0.0.1');
    expect(reply.status).toBe(502);
    expect(p.calls()).toBe(2);
    // Both slots are gone: nobody is admitted.
    expect((await analyze(h, '10.0.0.2')).json.error?.code).toBe(AnalyzeErrorCode.AtCapacity);
    expect(p.calls()).toBe(2);
  });

  it('does not make a retry when there is no slot for it, and returns the first failure', async () => {
    const p = counting(transient);
    const h = await start(p.provider, { providerRetries: 1, limits: limits({ globalRateMax: 1 }) });
    const reply = await analyze(h, '10.0.0.1');
    expect(p.calls()).toBe(1);
    expect(reply.status).toBe(502);
    expect(reply.json.error?.code).toBe(AnalyzeErrorCode.ProviderUnavailable);
  });

  it('keeps retrying as before when there is room', async () => {
    const p = counting((call) =>
      call === 1
        ? Promise.reject(new ProviderFailure(ProviderFailureKind.Unavailable, 503, true))
        : ok(),
    );
    const h = await start(p.provider, { providerRetries: 1, limits: limits({ globalRateMax: 5 }) });
    expect((await analyze(h, '10.0.0.1')).status).toBe(200);
    expect(p.calls()).toBe(2);
  });
});

describe('G. cancellation leaves no state behind', () => {
  it('aborts the provider call, frees the concurrency slot but not the allowance, and the service goes on', async () => {
    const p = counting((call, signal) => {
      if (call > 1) return ok();
      // The first call hangs until it is cancelled.
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(JSON.stringify(HUMAN_ANSWER));
        }, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new ProviderFailure(ProviderFailureKind.Cancelled));
        });
      });
    });
    const h = await start(p.provider, {
      limits: limits({ globalRateMax: 3, globalConcurrent: 1 }),
    });
    const controller = new AbortController();
    const pending = analyze(h, '10.0.0.1', controller.signal).catch(() => undefined);
    for (let i = 0; i < 200 && p.calls() < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await pending;
    for (let i = 0; i < 200 && p.aborted() < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(p.aborted()).toBe(1);
    let inFlight = 1;
    for (let i = 0; i < 200 && inFlight !== 0; i += 1) {
      inFlight = ((await (await fetch(`${h.url}${HEALTH_PATH}`)).json()) as { inFlight: number })
        .inFlight;
      if (inFlight !== 0) await new Promise((r) => setTimeout(r, 5));
    }
    // No negative counter, no leaked slot: the single concurrency slot is free again.
    expect(inFlight).toBe(0);
    // The cancelled attempt was dispatched, so it stays spent: exactly two of the three admissions remain.
    expect(statuses([await analyze(h, '10.0.0.2'), await analyze(h, '10.0.0.3')])).toEqual([
      200, 200,
    ]);
    expect((await analyze(h, '10.0.0.4')).json.error?.code).toBe(AnalyzeErrorCode.AtCapacity);
    expect(p.calls()).toBe(3);
  });
});

describe('H. the window boundary, exactly', () => {
  it('lets a slot go at the instant it is one window old, and not a moment before', () => {
    let clock = 0;
    const limiter = new AnalysisLimiter(
      limits({ globalRateMax: 2, globalRateWindowMs: 1000, globalDailyMax: 100 }),
      () => clock,
    );
    const admit = (id: string): boolean => {
      const a = limiter.admit(id);
      if (a.allowed) a.release();
      return a.allowed;
    };
    expect(admit('a')).toBe(true);
    clock = 400;
    expect(admit('b')).toBe(true);
    clock = 999;
    expect(admit('c')).toBe(false);
    clock = 1000; // the first admission (t = 0) is exactly one window old
    expect(admit('c')).toBe(true);
    expect(admit('d')).toBe(false); // the t = 400 one is still inside
    clock = 1400;
    expect(admit('d')).toBe(true);
  });

  it('WindowCounter never holds more than its capacity, however many events pass through it', () => {
    const window = new WindowCounter(3, 10);
    let at = 0;
    for (let i = 0; i < 1000; i += 1) {
      at += 4;
      if (!window.isFull(at)) window.record(at);
      expect(window.count).toBeLessThanOrEqual(3);
    }
    expect(() => {
      const full = new WindowCounter(1, 1000);
      full.record(0);
      full.record(1);
    }).toThrow(RangeError);
    expect(() => new WindowCounter(0, 10)).toThrow(RangeError);
    expect(() => new WindowCounter(1, 0)).toThrow(RangeError);
  });

  it('a refused request spends nothing, and a retry is refused rather than recorded when the window is full', () => {
    let clock = 0;
    const limiter = new AnalysisLimiter(
      limits({ globalRateMax: 2, globalDailyMax: 2 }),
      () => clock,
    );
    const first = limiter.admit('a');
    expect(first.allowed).toBe(true);
    expect(limiter.globalUsage).toEqual({ hourly: 1, daily: 1 });
    expect(limiter.admit('b').allowed).toBe(true);
    expect(limiter.admit('c')).toMatchObject({ allowed: false, reason: 'capacity' });
    expect(limiter.globalUsage).toEqual({ hourly: 2, daily: 2 });
    expect(limiter.tryConsumeRetry()).toBe(false);
    expect(limiter.globalUsage).toEqual({ hourly: 2, daily: 2 });
    clock = HOUR; // the hourly window is empty, the daily one is not
    expect(limiter.admit('d')).toMatchObject({ allowed: false, reason: 'capacity' });
    if (first.allowed) first.release();
    expect(limiter.inFlight).toBe(1);
  });
});

describe('I. configuration', () => {
  const base = { OPENAI_API_KEY: KEY };

  it('defaults to exactly 60 an hour and 300 a day', () => {
    const l = parseConfig(base, { allowMock: false }).limits;
    expect(l.globalRateMax).toBe(60);
    expect(l.globalRateWindowMs).toBe(3_600_000);
    expect(l.globalDailyMax).toBe(300);
    expect(l.globalDailyWindowMs).toBe(86_400_000);
    // And the per-client and concurrency controls are untouched.
    expect(l.perClientMax).toBe(8);
    expect(l.perClientConcurrent).toBe(1);
    expect(l.globalConcurrent).toBe(6);
  });

  it('reads explicit values exactly', () => {
    const l = parseConfig(
      {
        ...base,
        AUTO_SPLIT_GLOBAL_RATE_MAX: '10',
        AUTO_SPLIT_GLOBAL_RATE_WINDOW_SECONDS: '120',
        AUTO_SPLIT_GLOBAL_DAILY_MAX: '40',
        AUTO_SPLIT_GLOBAL_DAILY_WINDOW_SECONDS: '7200',
      },
      { allowMock: false },
    ).limits;
    expect([
      l.globalRateMax,
      l.globalRateWindowMs,
      l.globalDailyMax,
      l.globalDailyWindowMs,
    ]).toEqual([10, 120_000, 40, 7_200_000]);
  });

  it('refuses a value that is not a plain positive integer in range, and names the variable', () => {
    for (const name of [
      'AUTO_SPLIT_GLOBAL_RATE_MAX',
      'AUTO_SPLIT_GLOBAL_RATE_WINDOW_SECONDS',
      'AUTO_SPLIT_GLOBAL_DAILY_MAX',
      'AUTO_SPLIT_GLOBAL_DAILY_WINDOW_SECONDS',
    ]) {
      for (const bad of [
        '0',
        '-1',
        'abc',
        '1e3',
        '60.5',
        '0x10',
        '+5',
        ' 60',
        '60 ',
        '99999999999999999999',
        '9999999999999999',
      ]) {
        expect(
          () => parseConfig({ ...base, [name]: bad }, { allowMock: false }),
          `${name}=${JSON.stringify(bad)}`,
        ).toThrow(new RegExp(name));
      }
    }
    expect(() =>
      parseConfig(
        { ...base, AUTO_SPLIT_GLOBAL_RATE_MAX: String(MAX_GLOBAL_ENTRIES + 1) },
        { allowMock: false },
      ),
    ).toThrow(ConfigError);
    expect(
      parseConfig(
        { ...base, AUTO_SPLIT_GLOBAL_RATE_MAX: String(MAX_GLOBAL_ENTRIES) },
        { allowMock: false },
      ).limits.globalRateMax,
    ).toBe(MAX_GLOBAL_ENTRIES);
  });
});

describe('J. what a refused caller learns, and what the logs hold', () => {
  it('is told only that Auto Split is at capacity, with a coarse wait and nothing else', async () => {
    const p = counting(ok);
    const h = await start(p.provider, { limits: limits({ globalRateMax: 1 }) });
    await analyze(h, '10.0.0.1');
    const refused = await analyze(h, '10.0.0.2');
    expect(refused.status).toBe(429);
    expect(refused.json).toEqual({
      ok: false,
      error: {
        code: 'AT_CAPACITY',
        message: ANALYZE_ERROR_MESSAGES.AT_CAPACITY,
        retryAfterSeconds: 600,
      },
    });
    expect(refused.retryAfter).toBe('600');
    expect(JSON.stringify(refused.json)).not.toMatch(/\d+ (of|per)|hour|day|limit|\$|cost|token/i);
    expect(ANALYZE_ERROR_MESSAGES.AT_CAPACITY).toBe(
      'Auto Split is temporarily at capacity. Try again later.',
    );
  });

  it('logs a capacity refusal without a payload, an image, a key or a header', async () => {
    const p = counting(ok);
    const h = await start(p.provider, { limits: limits({ globalRateMax: 1 }) });
    await analyze(h, '10.0.0.1');
    await analyze(h, '10.0.0.2');
    const text = h.lines.join('\n');
    expect(text).toContain('AT_CAPACITY');
    for (const forbidden of [
      'sk-',
      'Authorization',
      'Bearer',
      'iVBOR',
      'base64',
      '10.0.0.',
      'x-real-ip',
    ])
      expect(text, forbidden).not.toContain(forbidden);
  });
});
