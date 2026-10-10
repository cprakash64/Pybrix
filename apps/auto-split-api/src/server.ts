import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  analyzeError,
  AnalyzeErrorCode,
  MAX_REQUEST_BODY_BYTES,
  validateAnalyzeRequest,
  validateHuman,
  validateVehicle,
  type AnalyzeError,
  type AnalyzeRequest,
} from '@cadfixer/auto-split-contract';
import type { ServerConfig } from './config';
import { AnalysisLimiter } from './limiter';
import type { Logger } from './log';
import { planFor } from './prompts';
import {
  estimateCostUsd,
  ProviderFailure,
  ProviderFailureKind,
  type Provider,
  type ProviderResult,
} from './provider';

/**
 * THE ANALYSIS SERVICE: one route that spends money, guarded in the order that spends the least first.
 *
 *   method, path -> same-origin -> content type and length -> rate limit -> read the body (capped) ->
 *   parse -> validate (strict, refuses raw geometry) -> concurrency -> provider (timeout, bounded
 *   retry of a transient failure, abort on client disconnect) -> validate the answer -> respond.
 *
 * The response carries our own sentence for an error, never the provider's. The logger has no field
 * for a payload. The browser cannot supply a prompt, a model or a URL.
 */
export const ANALYZE_PATH = '/api/auto-split/analyze';
export const HEALTH_PATH = '/api/auto-split/health';

export interface ServiceDeps {
  readonly config: ServerConfig;
  readonly provider: Provider;
  readonly logger: Logger;
  readonly now?: () => number;
  /** Test-server routes only (scenario control). Never set by the production entry. */
  readonly extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
}

const STATUS_FOR: Readonly<Record<AnalyzeErrorCode, number>> = {
  INVALID_REQUEST: 400,
  RAW_GEOMETRY_REJECTED: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MODE: 400,
  UNSUPPORTED_PROTOCOL: 400,
  RATE_LIMITED: 429,
  BUSY: 503,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_INVALID_RESPONSE: 502,
  CANCELLED: 499,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL: 500,
  NETWORK: 502,
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    ...extra,
  });
  res.end(text);
}

function fail(res: ServerResponse, error: AnalyzeError): void {
  const headers: Record<string, string> =
    error.retryAfterSeconds === undefined ? {} : { 'retry-after': String(error.retryAfterSeconds) };
  send(res, STATUS_FOR[error.code], { ok: false, error }, headers);
}

/** A client key that is a plain address token, or 'unknown'. The proxy sets `X-Real-IP`; nothing else is trusted. */
export function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  const raw = trustProxy ? req.headers['x-real-ip'] : req.socket.remoteAddress;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && /^[0-9A-Fa-f:.]{2,45}$/.test(value) ? value : 'unknown';
}

/** Refuses a request that a browser would only send cross-origin. */
function sameOrigin(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none')
    return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('aborted', () => {
      reject(new Error('aborted'));
    });
  });
}

function failureCode(kind: ProviderFailureKind): AnalyzeErrorCode {
  switch (kind) {
    case ProviderFailureKind.Timeout:
      return AnalyzeErrorCode.ProviderTimeout;
    case ProviderFailureKind.Cancelled:
      return AnalyzeErrorCode.Cancelled;
    case ProviderFailureKind.RateLimited:
    case ProviderFailureKind.Unavailable:
      return AnalyzeErrorCode.ProviderUnavailable;
    case ProviderFailureKind.Refused:
    case ProviderFailureKind.Incomplete:
    case ProviderFailureKind.InvalidRequest:
      return AnalyzeErrorCode.ProviderInvalidResponse;
  }
}

/** `signal.aborted` read through a call, so a check after an await is not narrowed away by an earlier one. */
const isAborted = (signal: AbortSignal): boolean => signal.aborted;

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export function createAnalysisServer(deps: ServiceDeps): Server {
  const { config, provider, logger } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const limiter = new AnalysisLimiter(config.limits, now);

  async function callProvider(
    request: AnalyzeRequest,
    signal: AbortSignal,
  ): Promise<{ result: ProviderResult; attempts: number; providerMs: number }> {
    const plan = planFor(request);
    const input = { mode: request.mode, plan, pngBase64: request.views.map((v) => v.png) };
    let attempts = 0;
    const started = now();
    for (;;) {
      attempts += 1;
      try {
        const result = await provider.analyze(input, signal);
        return { result, attempts, providerMs: now() - started };
      } catch (error) {
        const failure =
          error instanceof ProviderFailure
            ? error
            : new ProviderFailure(ProviderFailureKind.Unavailable);
        if (signal.aborted) throw new ProviderFailure(ProviderFailureKind.Cancelled);
        if (!failure.transient || attempts > config.providerRetries) throw failure;
        await pause(config.retryDelayMs, signal);
        if (isAborted(signal)) throw new ProviderFailure(ProviderFailureKind.Cancelled);
      }
    }
  }

  async function analyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    const client = clientKey(req, config.trustProxy);
    const refuse = (error: AnalyzeError, requestId?: string, bodyBytes?: number): void => {
      logger.log({
        event: 'refused',
        status: STATUS_FOR[error.code],
        outcome: error.code,
        durationMs: now() - started,
        provider: config.provider,
        ...(requestId === undefined ? {} : { requestId }),
        ...(bodyBytes === undefined ? {} : { bodyBytes }),
      });
      fail(res, error);
    };

    if (!sameOrigin(req)) {
      refuse(analyzeError(AnalyzeErrorCode.InvalidRequest));
      return;
    }
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json\s*(;|$)/i.test(type)) {
      refuse(analyzeError(AnalyzeErrorCode.InvalidRequest));
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
      refuse(analyzeError(AnalyzeErrorCode.PayloadTooLarge));
      return;
    }
    const early = limiter.wouldRefuse(client);
    if (early !== undefined) {
      refuse(analyzeError(AnalyzeErrorCode.RateLimited, early.retryAfterSeconds));
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, MAX_REQUEST_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        refuse(analyzeError(AnalyzeErrorCode.PayloadTooLarge));
        return;
      }
      refuse(analyzeError(AnalyzeErrorCode.InvalidRequest));
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      refuse(analyzeError(AnalyzeErrorCode.InvalidRequest), undefined, body.length);
      return;
    }
    const validated = validateAnalyzeRequest(json);
    if (!validated.ok) {
      refuse(analyzeError(validated.code), undefined, body.length);
      return;
    }
    const { request } = validated;

    const admission = limiter.admit(client);
    if (!admission.allowed) {
      refuse(
        analyzeError(
          admission.reason === 'rate' ? AnalyzeErrorCode.RateLimited : AnalyzeErrorCode.Busy,
          admission.retryAfterSeconds,
        ),
        request.requestId,
        body.length,
      );
      return;
    }

    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', onClose);
    try {
      const { result, attempts, providerMs } = await callProvider(request, controller.signal);
      let answer: unknown;
      try {
        answer = JSON.parse(result.text);
      } catch {
        throw new ProviderFailure(ProviderFailureKind.Incomplete, result.providerStatus);
      }
      const checked = request.mode === 'human' ? validateHuman(answer) : validateVehicle(answer);
      if (!checked.ok)
        throw new ProviderFailure(ProviderFailureKind.Incomplete, result.providerStatus);
      logger.log({
        event: 'request',
        requestId: request.requestId,
        mode: request.mode,
        protocolVersion: request.protocolVersion,
        status: 200,
        outcome: 'ok',
        durationMs: now() - started,
        providerDurationMs: providerMs,
        providerStatus: result.providerStatus,
        attempts,
        inputTokens: result.usage.inputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.reasoningTokens,
        costUsd: Math.round(estimateCostUsd(result.usage) * 10_000) / 10_000,
        bodyBytes: body.length,
        provider: config.provider,
      });
      send(res, 200, {
        ok: true,
        requestId: request.requestId,
        mode: request.mode,
        protocolVersion: request.protocolVersion,
        analysis: answer,
      });
    } catch (error) {
      const failure =
        error instanceof ProviderFailure
          ? error
          : new ProviderFailure(ProviderFailureKind.Unavailable);
      const code = failureCode(failure.kind);
      logger.log({
        event: 'error',
        requestId: request.requestId,
        mode: request.mode,
        protocolVersion: request.protocolVersion,
        status: STATUS_FOR[code],
        outcome: code,
        durationMs: now() - started,
        ...(failure.httpStatus === undefined ? {} : { providerStatus: failure.httpStatus }),
        bodyBytes: body.length,
        provider: config.provider,
      });
      if (failure.kind !== ProviderFailureKind.Cancelled) fail(res, analyzeError(code));
    } finally {
      res.off('close', onClose);
      admission.release();
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://service.invalid');
    if (deps.extraRoutes?.(req, res, url) === true) return;
    if (url.pathname === HEALTH_PATH) {
      if (req.method !== 'GET') {
        fail(res, analyzeError(AnalyzeErrorCode.MethodNotAllowed));
        return;
      }
      send(res, 200, { ok: true, inFlight: limiter.inFlight });
      return;
    }
    if (url.pathname === ANALYZE_PATH) {
      if (req.method !== 'POST') {
        send(
          res,
          405,
          { ok: false, error: analyzeError(AnalyzeErrorCode.MethodNotAllowed) },
          { allow: 'POST' },
        );
        return;
      }
      analyze(req, res).catch(() => {
        // Nothing here is logged with its message: an unexpected error may have touched a payload.
        logger.log({
          event: 'error',
          status: 500,
          outcome: AnalyzeErrorCode.Internal,
          provider: config.provider,
        });
        fail(res, analyzeError(AnalyzeErrorCode.Internal));
      });
      return;
    }
    fail(res, analyzeError(AnalyzeErrorCode.NotFound));
  });
  // Receiving a request has a deadline of its own; the provider call that follows does not count toward it.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
