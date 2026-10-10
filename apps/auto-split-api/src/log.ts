/**
 * OPERATIONAL LOGGING THAT CANNOT CARRY A PAYLOAD.
 *
 * An event is built from a fixed list of fields, each a number, boolean or a short token. There is no
 * way to log an image, a base64 string, a header, a key, a provider request or response, a file name
 * or a path: the type has no field for them, and `sanitize` drops any value that is not a short plain
 * token. Logs are single JSON lines on standard output.
 */
export interface LogEvent {
  readonly event: 'request' | 'start' | 'refused' | 'error';
  readonly requestId?: string;
  readonly mode?: string;
  readonly protocolVersion?: string;
  readonly status?: number;
  readonly outcome?: string;
  readonly durationMs?: number;
  readonly providerDurationMs?: number;
  readonly providerStatus?: number;
  readonly attempts?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
  readonly bodyBytes?: number;
  readonly provider?: string;
  readonly inFlight?: number;
}

export interface Logger {
  log(event: LogEvent): void;
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Keeps numbers, booleans and short plain tokens; drops everything else. */
export function sanitize(event: LogEvent): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && TOKEN.test(value)) out[key] = value;
  }
  return out;
}

export function createLogger(
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): Logger {
  return {
    log(event: LogEvent): void {
      write(JSON.stringify({ time: now().toISOString(), ...sanitize(event) }));
    },
  };
}
