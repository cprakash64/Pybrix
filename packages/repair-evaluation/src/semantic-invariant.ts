/** Checked invariants for small offline fixture arrays. Missing provenance is an error, never zero. */
export function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('MISSING_FIXTURE_VALUE');
  return value;
}

/** Runtime guard also covers deserialized fixtures whose TypeScript literal types are untrusted. */
export function contractValueEquals(value: unknown, expected: unknown): boolean {
  return value === expected;
}
