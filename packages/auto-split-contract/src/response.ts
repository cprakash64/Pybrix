import { analyzeError, AnalyzeErrorCode, type AnalyzeError } from './errors';
import { validateHuman, type HumanAnswer } from './human';
import { isSemanticMode, PROTOCOL_VERSIONS, type SemanticMode } from './limits';
import { validateVehicle, type VehicleAnswer } from './vehicle';

/**
 * THE ANALYSIS RESPONSE.
 *
 * Success carries the validated answer for the mode that was asked, in the provider's own schema
 * shape (the service has already refused anything that does not validate, and the browser validates
 * again: a response is data from the network, not a trusted object). Failure carries a code and a
 * sentence the service wrote. Nothing from the provider's own error text crosses.
 */
export interface AnalyzeSuccessWire {
  readonly ok: true;
  readonly requestId: string;
  readonly mode: SemanticMode;
  readonly protocolVersion: string;
  /** The answer in the provider's schema shape (snake_case). */
  readonly analysis: unknown;
}

export interface AnalyzeFailureWire {
  readonly ok: false;
  readonly error: AnalyzeError;
}

export type AnalyzeResponseWire = AnalyzeSuccessWire | AnalyzeFailureWire;

export type ParsedAnalysis =
  | {
      readonly mode: 'human';
      readonly requestId: string;
      readonly protocolVersion: string;
      readonly human: HumanAnswer;
    }
  | {
      readonly mode: 'vehicle';
      readonly requestId: string;
      readonly protocolVersion: string;
      readonly vehicle: VehicleAnswer;
    };

export type ParsedResponse =
  | { readonly ok: true; readonly analysis: ParsedAnalysis }
  | { readonly ok: false; readonly error: AnalyzeError };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const CODES: readonly string[] = Object.values(AnalyzeErrorCode);

/**
 * Reads a response the browser received. A body that is not exactly one of the two shapes becomes a
 * PROVIDER_INVALID_RESPONSE: the browser never guesses at a response it cannot read.
 */
export function parseAnalyzeResponse(
  raw: unknown,
  expected: { requestId: string; mode: SemanticMode },
): ParsedResponse {
  const bad: ParsedResponse = {
    ok: false,
    error: analyzeError(AnalyzeErrorCode.ProviderInvalidResponse),
  };
  if (!isRecord(raw)) return bad;
  if (raw.ok === false) {
    const error = raw.error;
    if (!isRecord(error) || typeof error.code !== 'string' || !CODES.includes(error.code))
      return bad;
    const code = error.code as AnalyzeErrorCode;
    const retry = error.retryAfterSeconds;
    return {
      ok: false,
      // The sentence is re-derived from the code: whatever text arrived is not shown.
      error:
        typeof retry === 'number' && Number.isFinite(retry) && retry >= 0
          ? analyzeError(code, Math.min(Math.ceil(retry), 86_400))
          : analyzeError(code),
    };
  }
  if (raw.ok !== true) return bad;
  const { requestId, mode, protocolVersion, analysis } = raw;
  if (requestId !== expected.requestId || mode !== expected.mode || !isSemanticMode(mode))
    return bad;
  if (protocolVersion !== PROTOCOL_VERSIONS[mode]) return bad;
  if (mode === 'human') {
    const checked = validateHuman(analysis);
    return checked.ok
      ? { ok: true, analysis: { mode, requestId, protocolVersion, human: checked.value } }
      : bad;
  }
  const checked = validateVehicle(analysis);
  return checked.ok
    ? { ok: true, analysis: { mode, requestId, protocolVersion, vehicle: checked.value } }
    : bad;
}
