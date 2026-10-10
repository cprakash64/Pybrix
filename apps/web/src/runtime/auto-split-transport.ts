import {
  analyzeError,
  AnalyzeErrorCode,
  CLIENT_TIMEOUT_MS,
  parseAnalyzeResponse,
  type AnalyzeRequest,
  type ParsedResponse,
} from '@cadfixer/auto-split-contract';

/**
 * THE ONE PLACE THE BROWSER APPLICATION MAKES A NETWORK REQUEST (ADR 0020).
 *
 * It POSTs a request built by the geometry worker — six rendered PNGs and three bounded numbers,
 * validated by the same contract the service enforces — to the SAME ORIGIN, and reads the answer. It
 * never sends a model file, vertices, faces, a file name or anything else from the document, and it has
 * no way to: its input type is `AnalyzeRequest`, which has no such field, and the service refuses a
 * body that carries one.
 *
 * - The URL is a relative path on this origin. There is no absolute URL, no configurable endpoint and
 *   no query string in this file, and `production-boundary.test.ts` asserts that.
 * - It sends no credentials, no referrer and stores nothing (`cache: 'no-store'`).
 * - ABORT IS REAL: aborting the signal aborts the in-flight request, the connection closes, and the
 *   service aborts its provider call when the connection does. A response that arrives after an abort is
 *   never read.
 * - Whatever comes back is DATA: the body is size-capped and parsed by `parseAnalyzeResponse`, which
 *   validates it again and re-derives every sentence from a code, so provider or server text never
 *   reaches the interface.
 * - No automatic retry here. The service retries a transient provider failure once, boundedly; after
 *   that, trying again is the user's choice.
 */
export const ANALYZE_URL = '/api/auto-split/analyze';
/** A response is a few kilobytes; anything near this is not the service. */
const MAX_RESPONSE_CHARACTERS = 262_144;

export type AnalysisFetch = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
    readonly credentials: 'omit';
    readonly cache: 'no-store';
    readonly referrerPolicy: 'no-referrer';
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface AnalysisTransport {
  /** Resolves with a parsed outcome; never rejects. A cancellation is `CANCELLED`, not an exception. */
  analyze(request: AnalyzeRequest, signal: AbortSignal): Promise<ParsedResponse>;
}

export interface TransportOptions {
  readonly fetcher?: AnalysisFetch;
  readonly timeoutMs?: number;
}

/** Read through a call so a check after an `await` is not narrowed away by the one before it. */
const isAborted = (signal: AbortSignal): boolean => signal.aborted;

function codeForUnreadableReply(status: number): AnalyzeErrorCode {
  if (status === 429) return AnalyzeErrorCode.RateLimited;
  if (status === 503) return AnalyzeErrorCode.Busy;
  if (status === 404 || status === 502 || status === 504)
    return AnalyzeErrorCode.ProviderUnavailable;
  return AnalyzeErrorCode.ProviderInvalidResponse;
}

const failure = (code: AnalyzeErrorCode, retryAfterSeconds?: number): ParsedResponse => ({
  ok: false,
  error: analyzeError(code, retryAfterSeconds),
});

export function createAnalysisTransport(options: TransportOptions = {}): AnalysisTransport {
  const fetcher: AnalysisFetch =
    options.fetcher ?? ((url, init): ReturnType<AnalysisFetch> => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? CLIENT_TIMEOUT_MS;
  return {
    async analyze(request, signal): Promise<ParsedResponse> {
      if (signal.aborted) return failure(AnalyzeErrorCode.Cancelled);
      const controller = new AbortController();
      const flags = { timedOut: false };
      const onAbort = (): void => {
        controller.abort();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        flags.timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetcher(ANALYZE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        const text = await response.text();
        if (isAborted(signal)) return failure(AnalyzeErrorCode.Cancelled);
        if (text.length > MAX_RESPONSE_CHARACTERS)
          return failure(AnalyzeErrorCode.ProviderInvalidResponse);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON: a proxy's error page, not our service. The page itself is never shown. A path
          // that does not exist (the service is not installed) and a gateway that cannot reach the
          // service both mean the service is unavailable.
          return failure(codeForUnreadableReply(response.status));
        }
        return parseAnalyzeResponse(body, { requestId: request.requestId, mode: request.mode });
      } catch {
        // `fetch` rejects for an abort and for a network failure; which one is known from our own flags.
        if (isAborted(signal)) return failure(AnalyzeErrorCode.Cancelled);
        if (flags.timedOut) return failure(AnalyzeErrorCode.ProviderTimeout);
        return failure(AnalyzeErrorCode.Network);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
