/**
 * The error codes the service returns and the browser understands. A code is a promise about what
 * the user is told, never a provider message: provider text does not cross this boundary.
 */
export const AnalyzeErrorCode = {
  /** The body is not a valid analysis request. */
  InvalidRequest: 'INVALID_REQUEST',
  /** The body carries something that looks like a model file or mesh data. Refused, not stripped. */
  RawGeometryRejected: 'RAW_GEOMETRY_REJECTED',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  UnsupportedMode: 'UNSUPPORTED_MODE',
  UnsupportedProtocol: 'UNSUPPORTED_PROTOCOL',
  RateLimited: 'RATE_LIMITED',
  /** Too many analyses are running; try again shortly. */
  Busy: 'BUSY',
  /**
   * Auto Split as a whole is at its capacity for now (a service-wide ceiling, not this person's own
   * use). Says nothing about counts, cost or the provider.
   */
  AtCapacity: 'AT_CAPACITY',
  ProviderUnavailable: 'PROVIDER_UNAVAILABLE',
  ProviderTimeout: 'PROVIDER_TIMEOUT',
  /** The provider answered, and not with an answer the contract accepts. */
  ProviderInvalidResponse: 'PROVIDER_INVALID_RESPONSE',
  Cancelled: 'CANCELLED',
  NotFound: 'NOT_FOUND',
  MethodNotAllowed: 'METHOD_NOT_ALLOWED',
  Internal: 'INTERNAL',
  /** Browser side only: the network failed before an answer arrived. */
  Network: 'NETWORK',
} as const;
export type AnalyzeErrorCode = (typeof AnalyzeErrorCode)[keyof typeof AnalyzeErrorCode];

export interface AnalyzeError {
  readonly code: AnalyzeErrorCode;
  /** A sentence safe to show: written here, never forwarded from a provider. */
  readonly message: string;
  /** Present for RATE_LIMITED and BUSY. */
  readonly retryAfterSeconds?: number;
}

/** The sentence for each code. The only prose the service sends. */
export const ANALYZE_ERROR_MESSAGES: Readonly<Record<AnalyzeErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: 'The analysis request was not valid.',
  RAW_GEOMETRY_REJECTED: 'The analysis request contained model data it must not carry.',
  PAYLOAD_TOO_LARGE: 'The analysis request was too large.',
  UNSUPPORTED_MODE: 'That model type is not supported for Auto Split.',
  UNSUPPORTED_PROTOCOL: 'This version of Pybrix is out of date. Reload the page and try again.',
  RATE_LIMITED: 'Auto Split has been used a lot from this connection. Try again in a little while.',
  BUSY: 'Auto Split is busy right now. Try again in a moment.',
  AT_CAPACITY: 'Auto Split is temporarily at capacity. Try again later.',
  PROVIDER_UNAVAILABLE: 'The part-finding service is unavailable right now. Try again later.',
  PROVIDER_TIMEOUT: 'The part-finding service took too long to answer. Try again.',
  PROVIDER_INVALID_RESPONSE:
    'The part-finding service gave an answer Pybrix could not use. Try again.',
  CANCELLED: 'The analysis was cancelled.',
  NOT_FOUND: 'Not found.',
  METHOD_NOT_ALLOWED: 'That method is not allowed.',
  INTERNAL: 'Something went wrong while analysing the model. Try again.',
  NETWORK: 'Pybrix could not reach the part-finding service. Check your connection and try again.',
});

export function analyzeError(code: AnalyzeErrorCode, retryAfterSeconds?: number): AnalyzeError {
  return {
    code,
    message: ANALYZE_ERROR_MESSAGES[code],
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}
