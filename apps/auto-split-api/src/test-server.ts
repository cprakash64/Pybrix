import type { IncomingMessage } from 'node:http';
import { SCENARIOS, scenarioAnswer, type ScenarioName } from '@cadfixer/auto-split/fixtures';
import { parseConfig } from './config';
import { createLogger } from './log';
import {
  ProviderFailure,
  ProviderFailureKind,
  type Provider,
  type ProviderInput,
  type ProviderResult,
} from './provider';
import { createAnalysisServer } from './server';

/**
 * THE TEST SERVER: the real service, the real validators and limiter, with a deterministic provider
 * in place of OpenAI, and a control route so a browser test can choose what the provider "says".
 *
 * IT IS NEVER PART OF THE RELEASE. It has its own entry and its own build, it is the only importer of
 * the fixtures, and `production-boundary.test.ts` asserts that neither the production entry nor the
 * release bundle names it. A scenario answer is a fixture built from a test model's own geometry; it
 * says nothing about how accurate a real provider is.
 */
const BEHAVIOURS = ['ok', 'timeout', 'malformed', 'unavailable', 'rate_limited', 'slow'] as const;
type Behaviour = (typeof BEHAVIOURS)[number];

interface Control {
  scenario: ScenarioName;
  behaviour: Behaviour;
  delayMs: number;
}

/** What the provider was handed, as SIZES and NAMES only: the audit must never hold an image. */
interface Received {
  readonly mode: string;
  readonly protocolVersion: string;
  readonly imageCount: number;
  readonly imageBytes: readonly number[];
  readonly userTextLength: number;
}

const control: Control = { scenario: 'human-ok', behaviour: 'ok', delayMs: 0 };
const received: Received[] = [];
let aborted = 0;
let completed = 0;
const answers = new Map<ScenarioName, string>();

function answerText(name: ScenarioName): string {
  const cached = answers.get(name);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(scenarioAnswer(name));
  answers.set(name, text);
  return text;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderFailure(ProviderFailureKind.Cancelled));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderFailure(ProviderFailureKind.Cancelled));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const provider: Provider = {
  async analyze(input: ProviderInput, signal: AbortSignal): Promise<ProviderResult> {
    received.push({
      mode: input.mode,
      protocolVersion: input.plan.protocolVersion,
      imageCount: input.pngBase64.length,
      imageBytes: input.pngBase64.map((b) => Math.floor((b.length * 3) / 4)),
      userTextLength: input.plan.userText.length,
    });
    try {
      if (control.delayMs > 0 || control.behaviour === 'slow')
        await pause(
          control.behaviour === 'slow' ? Math.max(control.delayMs, 600_000) : control.delayMs,
          signal,
        );
    } catch (error) {
      aborted += 1;
      throw error;
    }
    switch (control.behaviour) {
      case 'timeout':
        throw new ProviderFailure(ProviderFailureKind.Timeout);
      case 'unavailable':
        throw new ProviderFailure(ProviderFailureKind.Unavailable, 503, false);
      case 'rate_limited':
        throw new ProviderFailure(ProviderFailureKind.RateLimited, 429, false);
      case 'malformed':
        completed += 1;
        return { text: '{"not":"the schema"', usage: usage(), providerStatus: 200 };
      case 'ok':
      case 'slow':
        completed += 1;
        return { text: answerText(control.scenario), usage: usage(), providerStatus: 200 };
    }
  },
};

function usage(): ProviderResult['usage'] {
  return { inputTokens: 9000, cachedInputTokens: 0, outputTokens: 1200, reasoningTokens: 600 };
}

const logger = createLogger((line) => {
  process.stdout.write(`${line}\n`);
});
const config = parseConfig({ ...process.env, AUTO_SPLIT_PROVIDER: 'mock' }, { allowMock: true });

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error('control body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('bad control body'));
      }
    });
    req.on('error', reject);
  });
}

const server = createAnalysisServer({
  config,
  provider,
  logger,
  extraRoutes: (req, res, url) => {
    if (!url.pathname.startsWith('/api/auto-split/__mock/')) return false;
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith('/state') && req.method === 'GET') {
      reply(200, { control, received, aborted, completed });
      return true;
    }
    if (url.pathname.endsWith('/reset') && req.method === 'POST') {
      control.scenario = 'human-ok';
      control.behaviour = 'ok';
      control.delayMs = 0;
      received.length = 0;
      aborted = 0;
      completed = 0;
      reply(200, { ok: true });
      return true;
    }
    if (url.pathname.endsWith('/scenario') && req.method === 'POST') {
      void readJson(req).then(
        (body) => {
          const b = body as Partial<Control>;
          if (
            typeof b.scenario === 'string' &&
            (SCENARIOS as readonly string[]).includes(b.scenario)
          )
            control.scenario = b.scenario;
          if (
            typeof b.behaviour === 'string' &&
            (BEHAVIOURS as readonly string[]).includes(b.behaviour)
          )
            control.behaviour = b.behaviour;
          if (typeof b.delayMs === 'number' && b.delayMs >= 0 && b.delayMs <= 600_000)
            control.delayMs = b.delayMs;
          reply(200, { control });
        },
        () => {
          reply(400, { ok: false });
        },
      );
      return true;
    }
    reply(404, { ok: false });
    return true;
  },
});

server.listen(config.port, config.host, () => {
  logger.log({ event: 'start', provider: 'mock', status: config.port });
});
const stop = (): void => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
