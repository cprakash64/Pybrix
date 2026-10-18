import { sameSemanticPlane as samePlane } from '@cadfixer/auto-split';
import { semanticNativePolicy, SEMANTIC_NATIVE_LIMITS } from '@cadfixer/auto-split';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { Suggestion } from '@cadfixer/auto-split';
import type { DocumentHandle, SplitCreatePayload } from '@cadfixer/geometry-runtime';
import { invalidState } from '@cadfixer/shared';

/** Scalar evidence only; canonical source storage remains owned by the resident document. */
const key = (source: DocumentHandle, part: string): string =>
  JSON.stringify([source.documentId, source.revision, part]);
let current:
  | {
      key: string;
      mesh: WeakRef<CanonicalMesh>;
      preparationId: number;
      candidates: Map<string, NonNullable<Suggestion['semanticFinalists']>>;
      groups: Map<string, { key: string; opposite: boolean }>;
      winners: Map<string, NonNullable<Suggestion['plane']>>;
      parts: Set<string>;
      attempts: number;
      policy: ReturnType<typeof semanticNativePolicy>;
    }
  | undefined;
export const clearSemanticNativeFinalists = (): void => {
  current = undefined;
};
export function registerSemanticNativeFinalists(
  source: DocumentHandle,
  part: string,
  mesh: CanonicalMesh,
  preparationId: number,
  suggestions: readonly Suggestion[],
): void {
  current = {
    key: key(source, part),
    mesh: new WeakRef(mesh),
    preparationId,
    candidates: new Map(
      suggestions
        .filter((s) => s.quality === 'SUGGESTED' && s.operation === 'PLANE')
        .map((s) => [
          s.id,
          (s.semanticFinalists ?? (s.plane ? [s.plane] : [])).slice(
            0,
            SEMANTIC_NATIVE_LIMITS.finalists,
          ),
        ]),
    ),
    groups: new Map(
      suggestions.map((s) => [
        s.id,
        { key: s.sharedBoundary?.key ?? s.id, opposite: s.sharedBoundary?.side === 'COMPLEMENT' },
      ]),
    ),
    winners: new Map(),
    parts: new Set(),
    attempts: 0,
    policy: semanticNativePolicy(mesh.indices.length / 3),
  };
}
export function semanticNativePlan(
  payload: SplitCreatePayload,
  mesh: CanonicalMesh,
):
  | {
      planes: NonNullable<Suggestion['semanticFinalists']>;
      charge: () => void;
    }
  | undefined {
  const identity = payload.semanticQualification;
  if (!identity) return undefined;
  const c = current,
    planes = c?.candidates.get(identity.candidateId);
  if (
    c?.key !== key(payload.source, payload.partId) ||
    c.mesh.deref() !== mesh ||
    c.preparationId !== identity.preparationId ||
    !planes?.length ||
    !planes.some((p) => samePlane(p, payload.request.plane))
  )
    throw invalidState('Find parts again before checking this cut.');
  // A later explicit connector/unit Preview rechecks only the already-qualified plane.
  // No geometry is cached here, and no alternative search runs on that user-requested refresh.
  const group = c.groups.get(identity.candidateId);
  if (!group) throw invalidState('Find parts again before checking this cut.');
  const canonicalWinner = c.winners.get(group.key);
  const winner =
    canonicalWinner && group.opposite ? oppositePlane(canonicalWinner) : canonicalWinner;
  if (winner && (group.key !== identity.candidateId || samePlane(winner, payload.request.plane)))
    return {
      planes: [winner],
      charge: (): void => {
        /* Explicit refresh: no new fallback search budget. */
      },
    };
  if (!c.parts.has(group.key) && c.parts.size >= c.policy.parts)
    throw invalidState('No safe split found.', { code: 'SEMANTIC_NATIVE_BUDGET_EXHAUSTED' });
  const remaining = Math.max(0, c.policy.attempts - c.attempts);
  if (!remaining)
    throw invalidState('No safe split found.', { code: 'SEMANTIC_NATIVE_BUDGET_EXHAUSTED' });
  c.parts.add(group.key);
  const ordered = [...planes].sort(
    (a, b) =>
      Number(samePlane(b, payload.request.plane)) - Number(samePlane(a, payload.request.plane)),
  );
  return {
    planes: ordered.slice(0, Math.min(c.policy.finalistsPerPart, remaining)),
    charge: (): void => {
      if (++c.attempts > c.policy.attempts)
        throw invalidState('No safe split found.', { code: 'SEMANTIC_NATIVE_BUDGET_EXHAUSTED' });
    },
  };
}

export function recordSemanticNativeWinner(
  payload: SplitCreatePayload,
  plane: NonNullable<Suggestion['plane']>,
): boolean {
  const identity = payload.semanticQualification,
    c = current;
  if (
    !identity ||
    c?.key !== key(payload.source, payload.partId) ||
    c.preparationId !== identity.preparationId
  )
    return false;
  const group = c.groups.get(identity.candidateId);
  if (!group) return false;
  c.winners.set(group.key, group.opposite ? oppositePlane(plane) : plane);
  return true;
}

function oppositePlane(p: NonNullable<Suggestion['plane']>): NonNullable<Suggestion['plane']> {
  return { normal: [-p.normal[0], -p.normal[1], -p.normal[2]], origin: p.origin };
}
