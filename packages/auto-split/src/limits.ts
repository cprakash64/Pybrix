/**
 * The detail code a "this part is too detailed for Auto Split" refusal carries in its error details.
 *
 * It names a DETERMINISTIC outcome: the part's triangle count is a fact, the ceiling is a constant
 * (`MAX_SUPPORTED_SPLIT_TRIANGLES`, shared with the exact split), so the same part is refused the same
 * way every time and repeating the request cannot succeed. The page uses the code to say so and to
 * offer no retry; the worker's check stays the authority and the page's pre-check is only courtesy.
 */
export const AUTO_SPLIT_TOO_DETAILED = 'AUTO_SPLIT_TOO_DETAILED';
