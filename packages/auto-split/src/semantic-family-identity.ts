import { VIEW_NAMES, type ViewName, type SemanticPart } from '@cadfixer/auto-split-contract';
import type { Checkpoint } from './checkpoint';
import type { PreparedSemanticGeometry, SemanticEvidence } from './semantic';
import type { PartialFamilyMembership } from './semantic-partial-membership';
import type { SemanticReservation } from './semantic-reservation';
import { similarFamilyComponents, type FamilySignatures } from './semantic-family';
export interface FamilyIdentityObservation {
  readonly rank: number;
  readonly role: string;
  readonly instance: string;
  readonly views: readonly string[];
  readonly observations: readonly string[];
  readonly scope: 'QUALIFIED_FAMILY';
  readonly category: 'DIRECT_PHYSICAL' | 'QUALIFIED_FAMILY_RESERVATION';
}
export interface FamilyIdentityEvidence {
  readonly qualifiedRanks: readonly number[];
  readonly familyRanks: readonly number[];
  readonly observations: readonly FamilyIdentityObservation[];
  readonly witnesses: readonly { readonly candidate: number; readonly corroborator: number }[];
  readonly rule: string;
  readonly comparisons: number;
  readonly workUnits: number;
  /** Typed scratch only; provenance string payload is accounted separately. */
  readonly scratchBytes: number;
  readonly provenanceBytes: number;
  readonly milliseconds: number;
}
/** Independent identity for low-cardinality partials. Never creates a physical mapping. */
export function qualifyFamilyIdentity(
  p: PreparedSemanticGeometry,
  part: SemanticPart,
  evidence: SemanticEvidence,
  membership: PartialFamilyMembership,
  reservations: readonly SemanticReservation[],
  signatures: () => FamilySignatures,
  checkpoint: Checkpoint,
  charge: () => void,
): FamilyIdentityEvidence {
  const start = Date.now();
  let comparisons = 0,
    workUnits = 0;
  const work = (): void => {
    checkpoint();
    charge();
    workUnits++;
  };
  const qualified = new Set<number>(),
    family = new Set<number>(),
    observations: FamilyIdentityObservation[] = [],
    witnesses: { candidate: number; corroborator: number }[] = [];
  const finish = (rule: string): FamilyIdentityEvidence => {
    checkpoint();
    return {
      qualifiedRanks: [...qualified],
      familyRanks: [...family].sort((a, b) => a - b),
      observations,
      witnesses,
      rule,
      comparisons,
      workUnits,
      scratchBytes: 0,
      provenanceBytes:
        observations.reduce(
          (n, o) =>
            n +
            8 +
            2 *
              (o.role.length +
                o.instance.length +
                o.views.join('').length +
                o.observations.join('').length),
          0,
        ) +
        witnesses.length * 8,
      milliseconds: Date.now() - start,
    };
  };
  if (part.confidence < 0.9 || part.instances < 2) return finish('NO_CONFIDENT_REPEATED_ROLE');
  if (membership.physicalRanks.length > 24) return finish('IDENTITY_CANDIDATE_CEILING');
  const claim = reservations.find((r) => r.id === part.id && r.scope === 'QUALIFIED_FAMILY');
  const ranks = [...new Set([...membership.physicalRanks, ...(claim?.components ?? [])])];
  if (ranks.length > 64) return finish('IDENTITY_CORROBORATOR_CEILING');
  for (const rank of ranks) {
    work();
    const regions = (evidence.regionInstances ?? []).filter((r) => {
      work();
      return r.ranks.length === 1 && r.ranks[0] === rank && (r.purity ?? 0) >= 0.9;
    });
    if (!regions.length || !claim?.components.includes(rank)) continue;
    observations.push({
      rank,
      role: part.id,
      instance: `${part.id}:physical-${String(rank)}`,
      views: [...new Set(regions.map((r) => r.view))],
      observations: regions.map((r) => `${part.id}:${r.view}:${String(r.polygon)}`),
      scope: 'QUALIFIED_FAMILY',
      category: membership.physicalRanks.includes(rank)
        ? 'DIRECT_PHYSICAL'
        : 'QUALIFIED_FAMILY_RESERVATION',
    });
  }
  const data = signatures();
  for (const candidate of membership.qualifiedRanks) {
    work();
    const own = observations.find((o) => o.rank === candidate),
      shape = data.signatures.find((s) => s.rank === candidate),
      center = p.facts[candidate]?.centroid;
    if (!own || !shape || !center) continue;
    for (const other of observations) {
      work();
      comparisons++;
      if (
        other.rank === candidate ||
        other.observations.some((id) => own.observations.includes(id))
      )
        continue;
      const peer = data.signatures.find((s) => s.rank === other.rank),
        point = p.facts[other.rank]?.centroid;
      if (!peer || !point || !similarFamilyComponents(shape, peer)) continue;
      const distance = Math.hypot(...center.map((v, i) => v - (point[i] ?? 0)));
      if (distance <= Math.max(1e-6, Math.min(shape.diagonal, peer.diagonal) * 0.05)) continue;
      let coherent = false;
      if (membership.support) {
        const support = membership.support,
          level = point.reduce((n, v, i) => n + v * (support.normal[i] ?? 0), 0);
        coherent = Math.abs(level - support.offset) <= support.tolerance;
      } else if (membership.referenceRank !== null) {
        // Reflection is about an independently grounded host, never the pair's own mean.
        const host = p.facts[membership.referenceRank]?.centroid;
        coherent = Boolean(
          host &&
          Math.hypot(...center.map((v, i) => v + (point[i] ?? 0) - 2 * (host[i] ?? 0))) <=
            distance * 0.03,
        );
      }
      if (
        !coherent &&
        !membership.support &&
        membership.physicalRanks.length === 2 &&
        own.category === 'DIRECT_PHYSICAL' &&
        other.category === 'DIRECT_PHYSICAL'
      ) {
        // Two explicit, disjoint instance footprints in independent projection axes
        // corroborate one another; no third physical component is required. Shape
        // compatibility above is measured separately for each source component.
        const axes = new Set(
          own.views
            .filter((view) => other.views.includes(view))
            .map((view) => Math.floor(VIEW_NAMES.indexOf(view as ViewName) / 2)),
        );
        const separated = [0, 1, 2].some(
          (axis) =>
            (shape.hi[axis] ?? 0) < (peer.lo[axis] ?? 0) - 1e-6 ||
            (peer.hi[axis] ?? 0) < (shape.lo[axis] ?? 0) - 1e-6,
        );
        coherent = axes.size >= 2 && separated;
      }
      if (!coherent) continue;
      qualified.add(candidate);
      family.add(candidate);
      family.add(other.rank);
      witnesses.push({ candidate, corroborator: other.rank });
    }
  }
  return finish(
    qualified.size ? 'INDEPENDENT_COMPATIBLE_FAMILY_OBSERVATION' : 'NO_INDEPENDENT_FAMILY_IDENTITY',
  );
}

interface IdentityTimings {
  familyIdentityCorroborators: number;
  familyIdentityComparisons: number;
  familyIdentityWork: number;
  familyIdentityMilliseconds: number;
  familyIdentityProvenanceBytes: number;
  familyIdentityTypedScratchBytes: number;
  familyIdentityReservationWork: number;
  familyIdentityReservationMilliseconds: number;
  familyIdentityReservationTypedScratchBytes: number;
}
const NO_IDENTITY_TIMINGS: Readonly<IdentityTimings> = Object.freeze({
  familyIdentityCorroborators: 0,
  familyIdentityComparisons: 0,
  familyIdentityWork: 0,
  familyIdentityMilliseconds: 0,
  familyIdentityProvenanceBytes: 0,
  familyIdentityTypedScratchBytes: 0,
  familyIdentityReservationWork: 0,
  familyIdentityReservationMilliseconds: 0,
  familyIdentityReservationTypedScratchBytes: 0,
});
/** Qualified complete-only routes incur no new evidence passes or claim construction. */
export function familyIdentityTimings(
  evidence: readonly SemanticEvidence[],
  claims:
    | { readonly workUnits: number; readonly milliseconds: number; readonly scratchBytes: number }
    | undefined,
): Readonly<IdentityTimings> {
  if (!claims) return NO_IDENTITY_TIMINGS;
  const totals: IdentityTimings = { ...NO_IDENTITY_TIMINGS };
  for (const e of evidence) {
    const identity = e.partialFamilyMembership?.identity;
    if (!identity) continue;
    totals.familyIdentityCorroborators += identity.witnesses.length;
    totals.familyIdentityComparisons += identity.comparisons;
    totals.familyIdentityWork += identity.workUnits;
    totals.familyIdentityMilliseconds += identity.milliseconds;
    totals.familyIdentityProvenanceBytes += identity.provenanceBytes;
  }
  totals.familyIdentityReservationWork = claims.workUnits;
  totals.familyIdentityReservationMilliseconds = claims.milliseconds;
  totals.familyIdentityReservationTypedScratchBytes = claims.scratchBytes;
  return totals;
}
