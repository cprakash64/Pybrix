import type { SemanticMode } from '@cadfixer/auto-split-contract';
import type { ProtocolPlan } from './prompts';

/**
 * THE PROVIDER SEAM. The service never knows which provider it talks to: it hands over a pinned plan
 * and six base64 PNGs and gets text and token usage back, or a `ProviderFailure` that names a KIND and
 * carries no provider words. The HTTP layer maps a kind to a code the browser understands.
 */
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface ProviderInput {
  readonly mode: SemanticMode;
  readonly plan: ProtocolPlan;
  /** Standard base64 of each clean PNG, in view order. */
  readonly pngBase64: readonly string[];
}

export interface ProviderResult {
  /** The model's JSON text, to be parsed and validated by the caller. Never trusted. */
  readonly text: string;
  readonly usage: ProviderUsage;
  readonly providerStatus: number;
}

export const ProviderFailureKind = {
  Unavailable: 'unavailable',
  Timeout: 'timeout',
  RateLimited: 'rate_limited',
  Refused: 'refused',
  Incomplete: 'incomplete',
  Cancelled: 'cancelled',
  InvalidRequest: 'invalid_request',
} as const;
export type ProviderFailureKind = (typeof ProviderFailureKind)[keyof typeof ProviderFailureKind];

/** A provider failure. The message is ours and never contains provider text, a key or a payload. */
export class ProviderFailure extends Error {
  public readonly kind: ProviderFailureKind;
  public readonly httpStatus: number | undefined;
  public readonly transient: boolean;
  public constructor(kind: ProviderFailureKind, httpStatus?: number, transient = false) {
    super(
      `provider failure: ${kind}${httpStatus === undefined ? '' : ` (HTTP ${String(httpStatus)})`}`,
    );
    this.name = 'ProviderFailure';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.transient = transient;
  }
}

export interface Provider {
  analyze(input: ProviderInput, signal: AbortSignal): Promise<ProviderResult>;
}

/** gpt-6.1-sol, standard short-context rates in USD per million tokens (research `pricing.json`). */
export const PRICING = Object.freeze({ input: 2.0, cachedInput: 0.1, output: 10.0 });

export function estimateCostUsd(usage: ProviderUsage): number {
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (fresh * PRICING.input +
      usage.cachedInputTokens * PRICING.cachedInput +
      usage.outputTokens * PRICING.output) /
    1_000_000
  );
}
