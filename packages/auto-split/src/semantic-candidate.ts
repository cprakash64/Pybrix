import type { SemanticPart, Vec3 } from '@cadfixer/auto-split-contract';

/** Scalar candidate vocabulary; ownership/revision live on its enclosing worker result and store ticket.
 * Future bounded/local surfaces have an explicit refusal-only representation, never executable in v1.
 * Typed geometry remains in the worker and the existing transactional candidate store.
 */
export type SemanticRealization =
  | { readonly kind: 'existing-components'; readonly ranks: readonly number[] }
  | { readonly kind: 'plane-cut'; readonly normal: Vec3; readonly origin: Vec3 }
  | { readonly kind: 'recognized-feature'; readonly executable: false }
  | {
      readonly kind: 'local-cut-required';
      readonly regions: SemanticPart['views'];
      readonly executable: false;
    }
  | { readonly kind: 'unavailable'; readonly executable: false };
export interface SemanticCandidate {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly semanticConfidence: number;
  readonly geometryConfidence: number;
  readonly instances: number;
  readonly realization: SemanticRealization;
  readonly quality:
    | 'SUGGESTED'
    | 'READY'
    | 'RECOGNIZED_NOT_SEPARABLE'
    | 'UNSAFE'
    | 'LOW_CONFIDENCE'
    | 'STALE'
    | 'NEEDS_BOUNDARY_CONFIRMATION'
    | 'NEEDS_SCOPE_CONFIRMATION';
}
