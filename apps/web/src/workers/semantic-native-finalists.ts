import { releaseScopeReceipt } from './semantic-scope-authority';
import { semanticPlaneIdentity, sameSemanticPlane as samePlane } from '@cadfixer/auto-split';
import { semanticNativePolicy, SEMANTIC_NATIVE_LIMITS } from '@cadfixer/auto-split';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { Suggestion } from '@cadfixer/auto-split';
import type { DocumentHandle, SplitCreatePayload } from '@cadfixer/geometry-runtime';
import type { SplitCandidateHandle } from '@cadfixer/geometry-runtime';
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
      confirmations: Map<string, NonNullable<Suggestion['boundaryConfirmation']>>;
      groups: Map<string, { key: string; opposite: boolean }>;
      winners: Map<string, NonNullable<Suggestion['plane']>>;
      /** Groups whose every finalist failed the exact check: a COMPLETED analysis, remembered so it is not repeated. */
      refused: Set<string>;
      parts: Set<string>;
      attempts: number;
      identified: Map<string, NonNullable<Suggestion['plane']>>;
      policy: ReturnType<typeof semanticNativePolicy>;
    }
  | undefined;
export const clearSemanticNativeFinalists = (): void => {
  releaseScopeReceipt();
  current = undefined;
};
export function registerSemanticNativeFinalists(
  source: DocumentHandle,
  part: string,
  mesh: CanonicalMesh,
  preparationId: number,
  suggestions: readonly Suggestion[],
  spent: { readonly attempts: number; readonly partIds: readonly string[] } = {
    attempts: 0,
    partIds: [],
  },
): void {
  releaseScopeReceipt();
  current = {
    key: key(source, part),
    mesh: new WeakRef(mesh),
    preparationId,
    confirmations: new Map(
      suggestions.flatMap((s) =>
        s.boundaryConfirmation ? [[s.id, s.boundaryConfirmation] as const] : [],
      ),
    ),
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
    refused: new Set(),
    parts: new Set(spent.partIds),
    attempts: spent.attempts,
    identified: new Map(
      suggestions.flatMap((s) =>
        s.semanticScopeAuthority?.state === 'STRUCTURAL_IDENTIFIED'
          ? [[s.id, s.semanticScopeAuthority.plane] as const]
          : [],
      ),
    ),
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
  const confirmation = c?.confirmations.get(identity.candidateId);
  if (confirmation) {
    const alternative = confirmation.alternatives.find(
      (a) => a.id === identity.boundaryAlternativeId,
    );
    if (
      c?.key !== key(payload.source, payload.partId) ||
      c.mesh.deref() !== mesh ||
      c.preparationId !== identity.preparationId ||
      !alternative ||
      !samePlane(alternative.plane, payload.request.plane) ||
      identity.boundaryChoice !== 'PREVIEW' ||
      payload.request.connector.kind !== 'none'
    )
      throw invalidState('Choose a boundary option before checking this cut.');
    return {
      planes: [alternative.plane],
      charge: (): void => {
        /* Explicit existing native-proven choice. */
      },
    };
  }
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
  // A part whose every finalist already failed the exact check has had its analysis: say so again,
  // do not repeat the work and do not call it a limit.
  if (c.refused.has(group.key))
    throw invalidState('No safe split found.', {
      code: 'SEMANTIC_NATIVE_FINALISTS_REFUSED',
      remembered: true,
    });
  /*
   * ONE ENVELOPE PER SELECTION. Previewing a part is the user's own request for ONE bounded exact
   * check of THAT part, so the allowance (`policy.attempts` checks of `policy.finalistsPerPart`
   * finalists, one and one on a large model) belongs to the request, not to the whole analysis.
   * Counting it across the analysis meant that on a 2,000,000-triangle model the first part
   * previewed spent everything and every later part was refused as "No safe split found" without
   * having been examined. Nothing here raises a ceiling: each request is bounded exactly as before,
   * an outcome is remembered per part (`winners`, `refused`, at most one entry per suggestion, so at
   * most 24), and the page releases the previous candidate before it asks for the next.
   */
  c.parts = new Set([group.key]);
  c.attempts = 0;
  const remaining = c.policy.attempts;
  const ordered = [...planes].sort(
    (a, b) =>
      Number(samePlane(b, payload.request.plane)) - Number(samePlane(a, payload.request.plane)),
  );
  return {
    planes: ordered.slice(0, Math.min(c.policy.finalistsPerPart, remaining)),
    charge: (): void => {
      // Unreachable while `planes` is bounded by `remaining`; kept as the typed guard that a limit is
      // never worded as a finding.
      if (++c.attempts > c.policy.attempts)
        throw invalidState('Auto Split reached its analysis limit for this part.', {
          code: 'SEMANTIC_NATIVE_BUDGET_EXHAUSTED',
        });
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
  if (c.confirmations.has(identity.candidateId)) return true;
  c.winners.set(group.key, group.opposite ? oppositePlane(plane) : plane);
  return true;
}

// Keep this guard independent of semantic-analysis lifetime: clearing/replacing an analysis must
// never turn its unconfirmed preview into a committable transaction. One current ticket per document.
const unconfirmedPreviews = new Map<string, string>();
export function recordBoundaryPreview(candidate: SplitCandidateHandle, unconfirmed: boolean): void {
  if (unconfirmed) unconfirmedPreviews.set(candidate.documentId, candidate.candidateId);
  else unconfirmedPreviews.delete(candidate.documentId);
}
export function requireConfirmedBoundary(candidate: SplitCandidateHandle): void {
  if (unconfirmedPreviews.get(candidate.documentId) === candidate.candidateId)
    throw invalidState('Choose a boundary option before applying this cut.');
}
export function releaseBoundaryPreview(documentId: string): void {
  releaseScopeReceipt(documentId);
  unconfirmedPreviews.delete(documentId);
}

function oppositePlane(p: NonNullable<Suggestion['plane']>): NonNullable<Suggestion['plane']> {
  return { normal: [-p.normal[0], -p.normal[1], -p.normal[2]], origin: p.origin };
}

/** The registry object itself is a generation identity. Replacement invalidates all old receipts. */
export function semanticScopeBinding(
  payload: SplitCreatePayload,
  mesh: CanonicalMesh,
  plane: NonNullable<Suggestion['plane']>,
): { readonly current: () => boolean; readonly automatic: boolean } {
  const registry = current,
    identity = payload.semanticQualification;
  if (
    !registry ||
    !identity ||
    registry.mesh.deref() !== mesh ||
    registry.key !== key(payload.source, payload.partId) ||
    registry.preparationId !== identity.preparationId ||
    !registry.groups.has(identity.candidateId)
  )
    throw invalidState('Find parts again before checking this cut.');
  const identified = registry.identified.get(identity.candidateId);
  const meshIdentity = new WeakRef(mesh);
  return {
    current: () =>
      current === registry &&
      meshIdentity.deref() !== undefined &&
      registry.mesh.deref() === meshIdentity.deref(),
    automatic:
      !!identified &&
      JSON.stringify(semanticPlaneIdentity(identified)) ===
        JSON.stringify(semanticPlaneIdentity(plane)),
  };
}

/** Remembers that the exact check completed for this part and refused every finalist. */
export function recordSemanticNativeRefusal(payload: SplitCreatePayload): void {
  const c = current;
  const id = payload.semanticQualification?.candidateId;
  if (c === undefined || id === undefined) return;
  if (c.key !== key(payload.source, payload.partId)) return;
  const group = c.groups.get(id);
  if (group !== undefined) c.refused.add(group.key);
}
