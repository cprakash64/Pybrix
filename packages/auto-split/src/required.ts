/**
 * Unwraps a value an invariant says is present. `noUncheckedIndexedAccess` makes every index
 * read optional and the lint rules forbid both `!` and a bare `as`, so a read that the
 * surrounding code has already proven in range goes through here and fails loudly if that
 * proof was wrong, instead of carrying `undefined` into geometry.
 */
export function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Internal invariant broken: ${what} is missing.`);
  }
  return value;
}
