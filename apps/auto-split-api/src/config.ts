/**
 * THE SERVICE'S CONFIGURATION, read from the environment once, at start-up.
 *
 * THE PROVIDER KEY lives here and nowhere else: it is read from `OPENAI_API_KEY`, held in a closure
 * by the provider, and is never logged, returned, echoed in an error or placed in a response. It is
 * not a `VITE_*` variable and nothing in the browser build can name it.
 */
export interface LimitConfig {
  /** Analyses one client may start inside `windowMs`. */
  readonly perClientMax: number;
  readonly windowMs: number;
  /** Analyses one client may have running at once. */
  readonly perClientConcurrent: number;
  /** Analyses running at once across every client. */
  readonly globalConcurrent: number;
  /** The most clients the limiter remembers; the oldest are forgotten first. */
  readonly maxTrackedClients: number;
  /**
   * THE SERVICE-WIDE CEILINGS, independent of who is asking. Each counts PROVIDER ATTEMPTS inside a
   * sliding window: an analysis consumes one when it is admitted to the provider, and a retry of a
   * transient failure consumes one more. Nothing a client sends is an input to them.
   */
  readonly globalRateMax: number;
  readonly globalRateWindowMs: number;
  readonly globalDailyMax: number;
  readonly globalDailyWindowMs: number;
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly provider: 'openai' | 'mock';
  /** Absent for the mock provider. Never serialised. */
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly model: string;
  readonly limits: LimitConfig;
  /** Read the client address from `X-Real-IP` (set by the reverse proxy) instead of the socket. */
  readonly trustProxy: boolean;
  readonly providerTimeoutMs: number;
  readonly maxOutputTokens: number;
  /** One retry of a transient provider failure, with this pause. 0 disables retries. */
  readonly providerRetries: number;
  readonly retryDelayMs: number;
}

export const DEFAULT_LIMITS: LimitConfig = Object.freeze({
  perClientMax: 8,
  windowMs: 60 * 60 * 1000,
  perClientConcurrent: 1,
  globalConcurrent: 6,
  maxTrackedClients: 20_000,
  // 60 an hour and 300 a day: at the highest cost seen in qualification ($0.03) about $1.80 and $9.
  globalRateMax: 60,
  globalRateWindowMs: 60 * 60 * 1000,
  globalDailyMax: 300,
  globalDailyWindowMs: 24 * 60 * 60 * 1000,
});

/** The most entries a global window may hold: its memory is exactly this many numbers, whatever arrives. */
export const MAX_GLOBAL_ENTRIES = 100_000;

export const PRODUCTION_MODEL = 'gpt-6.1-sol';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Output room for three slots, up to twelve wheels and the reasoning in between (the research setting). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 24_000;

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  // Digits only: `1e3`, `0x10`, `+5`, `60.0` and ` 60` are not what anyone meant, and are refused rather than read.
  if (!/^[0-9]{1,15}$/.test(raw))
    throw new ConfigError(`${name} must be an integer from ${String(min)} to ${String(max)}.`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new ConfigError(`${name} must be an integer from ${String(min)} to ${String(max)}.`);
  return value;
}

/** A key must be printable ASCII with no whitespace: an ESC byte or a newline is a copy-paste fault, refused at start-up. */
export function checkApiKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 20 || !/^[\x21-\x7e]+$/.test(key))
    throw new ConfigError(
      'OPENAI_API_KEY is not a usable key (it must be printable ASCII with no spaces).',
    );
  return key;
}

export function parseConfig(env: NodeJS.ProcessEnv, options: { allowMock: boolean }): ServerConfig {
  const requested = env.AUTO_SPLIT_PROVIDER ?? 'openai';
  if (requested !== 'openai' && requested !== 'mock')
    throw new ConfigError('AUTO_SPLIT_PROVIDER must be "openai" or "mock".');
  if (requested === 'mock' && !options.allowMock)
    throw new ConfigError('The mock provider is not available in this build.');
  const apiKey = requested === 'openai' ? checkApiKey(env.OPENAI_API_KEY ?? '') : undefined;
  const baseUrl = (env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl))
    throw new ConfigError('OPENAI_BASE_URL must be an http(s) URL.');
  if (
    requested === 'openai' &&
    env.NODE_ENV === 'production' &&
    baseUrl !== OPENAI_DEFAULT_BASE_URL
  )
    throw new ConfigError('OPENAI_BASE_URL may not be changed in production.');
  const host = env.AUTO_SPLIT_HOST ?? '127.0.0.1';
  return {
    host,
    port: integer(env, 'AUTO_SPLIT_PORT', 8787, 1, 65_535),
    provider: requested,
    apiKey,
    baseUrl,
    model: PRODUCTION_MODEL,
    limits: {
      perClientMax: integer(env, 'AUTO_SPLIT_RATE_MAX', DEFAULT_LIMITS.perClientMax, 1, 10_000),
      windowMs:
        integer(env, 'AUTO_SPLIT_RATE_WINDOW_SECONDS', DEFAULT_LIMITS.windowMs / 1000, 1, 86_400) *
        1000,
      perClientConcurrent: integer(
        env,
        'AUTO_SPLIT_CLIENT_CONCURRENT',
        DEFAULT_LIMITS.perClientConcurrent,
        1,
        100,
      ),
      globalConcurrent: integer(
        env,
        'AUTO_SPLIT_GLOBAL_CONCURRENT',
        DEFAULT_LIMITS.globalConcurrent,
        1,
        1000,
      ),
      maxTrackedClients: DEFAULT_LIMITS.maxTrackedClients,
      globalRateMax: integer(
        env,
        'AUTO_SPLIT_GLOBAL_RATE_MAX',
        DEFAULT_LIMITS.globalRateMax,
        1,
        MAX_GLOBAL_ENTRIES,
      ),
      globalRateWindowMs:
        integer(
          env,
          'AUTO_SPLIT_GLOBAL_RATE_WINDOW_SECONDS',
          DEFAULT_LIMITS.globalRateWindowMs / 1000,
          1,
          7 * 86_400,
        ) * 1000,
      globalDailyMax: integer(
        env,
        'AUTO_SPLIT_GLOBAL_DAILY_MAX',
        DEFAULT_LIMITS.globalDailyMax,
        1,
        MAX_GLOBAL_ENTRIES,
      ),
      globalDailyWindowMs:
        integer(
          env,
          'AUTO_SPLIT_GLOBAL_DAILY_WINDOW_SECONDS',
          DEFAULT_LIMITS.globalDailyWindowMs / 1000,
          1,
          30 * 86_400,
        ) * 1000,
    },
    trustProxy: env.AUTO_SPLIT_TRUST_PROXY === '1',
    providerTimeoutMs: integer(env, 'AUTO_SPLIT_PROVIDER_TIMEOUT_MS', 150_000, 1000, 600_000),
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    providerRetries: integer(env, 'AUTO_SPLIT_PROVIDER_RETRIES', 1, 0, 2),
    retryDelayMs: integer(env, 'AUTO_SPLIT_RETRY_DELAY_MS', 1500, 0, 30_000),
  };
}
