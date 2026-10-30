import { semanticPlaneIdentity } from './semantic-plane-identity';
import type { SuggestedPlane } from './suggestions';

/** Publication only: never expands the existing confirmed beam or ranks by an external grade. */
export const MAX_REVIEW_ALTERNATIVES = 3;
export function distinctReviewPlanes(planes: readonly SuggestedPlane[]): readonly SuggestedPlane[] {
  const seen = new Set<string>();
  const result: SuggestedPlane[] = [];
  for (const plane of planes) {
    const key = JSON.stringify(semanticPlaneIdentity(plane));
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(plane);
    if (result.length === MAX_REVIEW_ALTERNATIVES) break;
  }
  return result;
}
