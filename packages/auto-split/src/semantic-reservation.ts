import { matchesPartialFamilySupport } from './semantic-partial-membership';
import { VIEW_NAMES, type SemanticHierarchy } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry, SemanticEvidence } from './semantic';
import { semanticRoleScope } from './semantic-extent';
import { familyGrounding, similarFamilyComponents, type FamilySignatures } from './semantic-family';
import type { Checkpoint } from './checkpoint';

/** Negative ownership only. These records never create source pieces or executable candidates. */
export interface SemanticReservation {
  readonly id: string;
  readonly ownerId?: string;
  readonly scope?: 'PHYSICAL_PART' | 'QUALIFIED_FAMILY';
  readonly components: readonly number[];
  readonly multiViewComponents: readonly number[];
  readonly corroboratedComponents: readonly number[];
}
export function buildSemanticReservations(
  p: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  evidence: readonly SemanticEvidence[],
  signatures: () => FamilySignatures,
  checkpoint: Checkpoint,
  charge: () => void,
): {
  readonly reservations: readonly SemanticReservation[];
  readonly components: number;
  readonly scratchBytes: number;
  readonly workUnits: number;
  readonly milliseconds: number;
} {
  const start = Date.now(),
    reservations: SemanticReservation[] = [];
  const owned = new Uint8Array(p.metadata.components.length);
  let workUnits = 0;
  const work = (): void => {
    checkpoint();
    charge();
    workUnits++;
  };
  for (const part of answer.parts) {
    work();
    const scope = semanticRoleScope(part, answer);
    if (
      part.expectedGeometry.kind === 'unknown' ||
      part.confidence < 0.9 ||
      (scope !== 'EXTRACTABLE_PART' && scope !== 'REPEATED_FAMILY')
    )
      continue;
    const e = evidence.find((e) => e.id === part.id);
    if (!e) continue;
    const polygons = (e.regionInstances ?? []).map((poly) => ({
      ...poly,
      view: VIEW_NAMES.indexOf(poly.view),
      purity: poly.purity ?? 0,
    }));
    const grounding = familyGrounding(part, e.components, polygons);
    const multiView = grounding.strict.filter(
      (rank) =>
        scope === 'REPEATED_FAMILY' ||
        new Set(
          polygons
            .filter(
              (poly) => poly.ranks.length === 1 && poly.ranks[0] === rank && poly.purity >= 0.9,
            )
            .map((poly) => poly.view),
        ).size >= 2,
    );
    // A hierarchy copy of the same whole-component foreground is not a separately
    // localized physical claim. Keep the existing coarse-mask neutrality at construction.
    const indistinguishable = (rank: number): boolean => {
      let parentId = part.parentId;
      for (let depth = 0; parentId && depth < 4; depth++) {
        work();
        const parent = answer.parts.find((p) => p.id === parentId);
        const other = evidence.find((e) => e.id === parentId);
        const grounded = other?.components.filter((s) => s.strongViews >= 2) ?? [];
        if (grounded.length === 1 && grounded[0]?.rank === rank) {
          const own = e.components.find((s) => s.rank === rank);
          if (
            grounded[0].viewCoverage.filter(
              (coverage, view) => coverage >= 0.95 && (own?.viewCoverage[view] ?? -1) >= 0.95,
            ).length >= 2
          )
            return true;
        }
        parentId = parent?.parentId ?? null;
      }
      return false;
    };
    if (scope !== 'REPEATED_FAMILY')
      for (let i = multiView.length - 1; i >= 0; i--)
        if (indistinguishable(multiView[i] ?? -1)) multiView.splice(i, 1);
    const corroborated: number[] = [];
    // A single localized footprint needs independent semantic AND exact-shape corroboration.
    // Count disagreement prevents execution, but does not erase directly observed ownership.
    if (
      scope === 'REPEATED_FAMILY' &&
      (grounding.strict.length >= 2 || grounding.collective || grounding.distributed)
    ) {
      const data = signatures();
      const anchors = grounding.strict.length >= 2 ? grounding.strict : grounding.direct;
      const anchorShapes = data.signatures.filter((s) => anchors.includes(s.rank));
      const coherent =
        anchorShapes.length === anchors.length &&
        anchorShapes.every((a) =>
          anchorShapes.every((b) => {
            work();
            return similarFamilyComponents(a, b);
          }),
        );
      if (coherent)
        for (const rank of grounding.direct) {
          work();
          const shape = data.signatures.find((s) => s.rank === rank);
          if (
            !multiView.includes(rank) &&
            shape &&
            anchorShapes.every((a) => {
              work();
              return similarFamilyComponents(a, shape);
            })
          )
            corroborated.push(rank);
        }
    }
    const components = [...multiView, ...corroborated].sort((a, b) => a - b);
    if (components.length) {
      for (const rank of components) {
        work();
        owned[rank] = 1;
      }
      reservations.push({
        id: part.id,
        components,
        multiViewComponents: multiView,
        corroboratedComponents: corroborated,
      });
    }
  }
  // A broad ordinary role cannot reserve a separately localized narrower role away from it.
  // Decide from the original claim sets simultaneously, never from executable status or order.
  const localized = reservations
    .map((reservation) => {
      const part = answer.parts.find((part) => part.id === reservation.id);
      if (part?.expectedGeometry.kind === 'repeated_part') return reservation;
      const narrower = reservations.filter((other) => {
        work();
        return (
          other.id !== reservation.id &&
          other.components.length < reservation.components.length &&
          other.components.every((rank) => {
            work();
            return reservation.components.includes(rank);
          })
        );
      });
      const components = reservation.components.filter(
        (rank) =>
          !narrower.some((other) => {
            work();
            return other.components.includes(rank);
          }),
      );
      return {
        ...reservation,
        components,
        multiViewComponents: reservation.multiViewComponents.filter((rank) =>
          components.includes(rank),
        ),
        corroboratedComponents: reservation.corroboratedComponents.filter((rank) =>
          components.includes(rank),
        ),
      };
    })
    .filter((reservation) => reservation.components.length > 0);
  // Preserve physical negative ownership even when the repeated-family relationship fails.
  const scoped = localized.flatMap((reservation): SemanticReservation[] => {
    const membership = evidence.find((e) => e.id === reservation.id)?.partialFamilyMembership;
    if (!membership) return [reservation];
    const family = reservation.components.filter((rank) => {
      work();
      return matchesPartialFamilySupport(p, membership, rank);
    });
    const physical = reservation.components.filter((rank) => !family.includes(rank));
    return [
      ...(family.length
        ? [
            {
              ...reservation,
              scope: 'QUALIFIED_FAMILY' as const,
              components: family,
              multiViewComponents: reservation.multiViewComponents.filter((rank) =>
                family.includes(rank),
              ),
              corroboratedComponents: reservation.corroboratedComponents.filter((rank) =>
                family.includes(rank),
              ),
            },
          ]
        : []),
      ...physical.map((rank) => ({
        id: `${reservation.id}:physical-${String(rank)}`,
        ownerId: reservation.id,
        scope: 'PHYSICAL_PART' as const,
        components: [rank],
        multiViewComponents: reservation.multiViewComponents.includes(rank) ? [rank] : [],
        corroboratedComponents: reservation.corroboratedComponents.includes(rank) ? [rank] : [],
      })),
    ];
  });
  owned.fill(0);
  for (const reservation of scoped)
    for (const rank of reservation.components) {
      work();
      owned[rank] = 1;
    }
  checkpoint();
  return {
    reservations: scoped,
    components: owned.reduce((n, bit) => n + bit, 0),
    scratchBytes: owned.byteLength,
    workUnits,
    milliseconds: Date.now() - start,
  };
}
