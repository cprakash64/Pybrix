import {
  ProviderFailure,
  ProviderFailureKind,
  type Provider,
  type ProviderInput,
  type ProviderResult,
} from './provider';

/**
 * THE OPENAI PROVIDER — the Responses API over plain HTTPS, no SDK.
 *
 * `POST {base}/responses` with strict structured output, `store: false` and the pinned model. The key
 * travels in the Authorization header of this one request and nowhere else: it is not logged, not
 * placed in an error, not returned. A non-success status becomes a `ProviderFailure` that carries the
 * status NUMBER and nothing the provider wrote, so provider text cannot reach a browser.
 */
export interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function createOpenAiProvider(options: OpenAiProviderOptions): Provider {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async analyze(input: ProviderInput, signal: AbortSignal): Promise<ProviderResult> {
      const body = {
        model: options.model,
        instructions: input.plan.instructions,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: input.plan.userText },
              ...input.pngBase64.map((png) => ({
                type: 'input_image',
                image_url: `data:image/png;base64,${png}`,
                detail: 'high',
              })),
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: input.plan.schemaName,
            strict: true,
            schema: input.plan.schema,
          },
        },
        max_output_tokens: options.maxOutputTokens,
        store: false,
      };
      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timeout.abort();
      }, options.timeoutMs);
      const combined = AbortSignal.any([signal, timeout.signal]);
      let response: Response;
      try {
        response = await doFetch(`${options.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch {
        // A thrown fetch is a cancel, a timeout or a network failure; none carries text we forward.
        if (signal.aborted) throw new ProviderFailure(ProviderFailureKind.Cancelled);
        if (timeout.signal.aborted)
          throw new ProviderFailure(ProviderFailureKind.Timeout, undefined, false);
        throw new ProviderFailure(ProviderFailureKind.Unavailable, undefined, true);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        // The body is NOT read into an error: provider text stays here.
        void response.body?.cancel();
        const status = response.status;
        if (status === 429)
          throw new ProviderFailure(ProviderFailureKind.RateLimited, status, true);
        if (status === 408 || status === 409 || status >= 500)
          throw new ProviderFailure(ProviderFailureKind.Unavailable, status, true);
        if (status === 400 || status === 413 || status === 422)
          throw new ProviderFailure(ProviderFailureKind.InvalidRequest, status, false);
        throw new ProviderFailure(ProviderFailureKind.Unavailable, status, false);
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        if (signal.aborted) throw new ProviderFailure(ProviderFailureKind.Cancelled);
        throw new ProviderFailure(ProviderFailureKind.Unavailable, response.status, true);
      }
      if (!isRecord(parsed))
        throw new ProviderFailure(ProviderFailureKind.Unavailable, response.status, false);
      const usageRaw = isRecord(parsed.usage) ? parsed.usage : {};
      const inputDetails = isRecord(usageRaw.input_tokens_details)
        ? usageRaw.input_tokens_details
        : {};
      const outputDetails = isRecord(usageRaw.output_tokens_details)
        ? usageRaw.output_tokens_details
        : {};
      const usage = {
        inputTokens: num(usageRaw.input_tokens),
        cachedInputTokens: num(inputDetails.cached_tokens),
        outputTokens: num(usageRaw.output_tokens),
        reasoningTokens: num(outputDetails.reasoning_tokens),
      };
      if (parsed.status === 'incomplete')
        throw new ProviderFailure(ProviderFailureKind.Incomplete, response.status, false);
      const parts: string[] = [];
      const output = Array.isArray(parsed.output) ? (parsed.output as unknown[]) : [];
      for (const item of output) {
        if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content as unknown[]) {
          if (!isRecord(part)) continue;
          if (part.type === 'refusal')
            throw new ProviderFailure(ProviderFailureKind.Refused, response.status);
          if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
        }
      }
      return { text: parts.join(''), usage, providerStatus: response.status };
    },
  };
}
