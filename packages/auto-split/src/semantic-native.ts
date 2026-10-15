import type { SuggestedPlane } from './suggestions';
import type { Checkpoint } from './checkpoint';

export const SEMANTIC_NATIVE_LIMITS = Object.freeze({
  finalists: 3,
  parts: 3,
  attempts: 6,
  largeTriangleCount: 250_000,
});
export function semanticNativePolicy(triangles: number): {
  readonly finalistsPerPart: number;
  readonly parts: number;
  readonly attempts: number;
} {
  return triangles >= SEMANTIC_NATIVE_LIMITS.largeTriangleCount
    ? { finalistsPerPart: 1, parts: 1, attempts: 1 }
    : {
        finalistsPerPart: SEMANTIC_NATIVE_LIMITS.finalists,
        parts: SEMANTIC_NATIVE_LIMITS.parts,
        attempts: SEMANTIC_NATIVE_LIMITS.attempts,
      };
}

/** Equality of oriented plane settings, never a native geometry validity test. */
export function sameSemanticPlane(a: SuggestedPlane, b: SuggestedPlane): boolean {
  return (
    a.normal.every((v, i) => Math.abs(v - (b.normal[i] ?? Infinity)) < 1e-7) &&
    Math.abs(
      a.normal.reduce((sum, n, i) => sum + n * ((a.origin[i] ?? 0) - (b.origin[i] ?? 0)), 0),
    ) <
      1e-6 * Math.max(1, Math.abs(a.normal.reduce((sum, n, i) => sum + n * (a.origin[i] ?? 0), 0)))
  );
}

export interface NativeFinalistResult<T> {
  readonly value: T;
  readonly plane: SuggestedPlane;
  readonly attempts: number;
  readonly failures: number;
  readonly winnerIndex: number;
  readonly milliseconds: number;
}
/** No geometry heuristic here: attempt must invoke the application's authoritative Preview operation. */
export async function qualifySemanticFinalists<T>(
  planes: readonly SuggestedPlane[],
  attempt: (plane: SuggestedPlane) => Promise<T>,
  control: {
    readonly checkpoint: Checkpoint;
    readonly charge: () => void;
    readonly isNativeInvalid: (error: unknown) => boolean;
    readonly discard?: (value: T) => void;
  },
): Promise<NativeFinalistResult<T> | undefined> {
  const started = Date.now();
  let failures = 0;
  for (const [index, plane] of planes.slice(0, SEMANTIC_NATIVE_LIMITS.finalists).entries()) {
    control.checkpoint();
    control.charge();
    let value: T;
    try {
      value = await attempt(plane);
    } catch (error) {
      control.checkpoint();
      if (!control.isNativeInvalid(error)) throw error;
      failures++;
      continue;
    }
    try {
      control.checkpoint();
    } catch (error) {
      control.discard?.(value);
      throw error;
    }
    return {
      value,
      plane,
      attempts: index + 1,
      failures,
      winnerIndex: index,
      milliseconds: Date.now() - started,
    };
  }
  return undefined;
}
