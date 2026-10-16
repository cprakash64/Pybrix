import type { FamilyIdentityEvidence } from './semantic-family-identity';
import type { Vec3, SemanticPart } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry, SemanticEvidence } from './semantic';
import type { FamilySignatures } from './semantic-family';
import type { Checkpoint } from './checkpoint';
import { required } from './required';
export const PARTIAL_MEMBERSHIP_LIMITS = Object.freeze({
  maximumCandidates: 24,
  maximumSubsets: 64,
  levelToleranceParent: 0.01,
  levelToleranceMember: 0.05,
  outlierParent: 0.08,
  outlierMember: 0.5,
  minimumAxisSeparation: 4,
  minimumReferenceAreaDominance: 1.1,
  reflectionResidual: 0.03,
});
export interface PartialFamilyMembership {
  readonly identity?: FamilyIdentityEvidence;
  readonly physicalRanks: readonly number[];
  readonly qualifiedRanks: readonly number[];
  readonly rejectedRanks: readonly number[];
  readonly rule: string;
  readonly referenceRank: number | null;
  readonly support?: { readonly normal: Vec3; readonly offset: number; readonly tolerance: number };
  readonly subsets: number;
  readonly comparisons: number;
  readonly workUnits: number;
  readonly scratchBytes: number;
  readonly milliseconds: number;
}
/** A unique thin support direction, computed from an existing area covariance. No face scan. */
function supportNormal(m: readonly number[]): Vec3 | undefined {
  const a = [
      [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0],
      [m[1] ?? 0, m[3] ?? 0, m[4] ?? 0],
      [m[2] ?? 0, m[4] ?? 0, m[5] ?? 0],
    ],
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  for (let step = 0; step < 12; step++) {
    let p = 0,
      q = 1;
    for (const [i, j] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ])
      if (Math.abs(a[i ?? 0]?.[j ?? 0] ?? 0) > Math.abs(a[p]?.[q] ?? 0)) {
        p = i ?? 0;
        q = j ?? 1;
      }
    const off = a[p]?.[q] ?? 0;
    if (Math.abs(off) < 1e-12) break;
    const angle = 0.5 * Math.atan2(2 * off, (a[q]?.[q] ?? 0) - (a[p]?.[p] ?? 0)),
      c = Math.cos(angle),
      s = Math.sin(angle);
    for (let k = 0; k < 3; k++) {
      const x = a[k]?.[p] ?? 0,
        y = a[k]?.[q] ?? 0;
      required(a[k], 'covariance row')[p] = c * x - s * y;
      required(a[k], 'covariance row')[q] = s * x + c * y;
    }
    for (let k = 0; k < 3; k++) {
      const x = a[p]?.[k] ?? 0,
        y = a[q]?.[k] ?? 0;
      required(a[p], 'covariance row')[k] = c * x - s * y;
      required(a[q], 'covariance row')[k] = s * x + c * y;
      const u = v[k]?.[p] ?? 0,
        w = v[k]?.[q] ?? 0;
      required(v[k], 'basis row')[p] = c * u - s * w;
      required(v[k], 'basis row')[q] = s * u + c * w;
    }
  }
  const order = [0, 1, 2].sort((i, j) => (a[i]?.[i] ?? 0) - (a[j]?.[j] ?? 0)),
    first = order[0] ?? 0,
    second = order[1] ?? 1;
  if (
    (a[first]?.[first] ?? 0) * PARTIAL_MEMBERSHIP_LIMITS.minimumAxisSeparation >=
    (a[second]?.[second] ?? 0)
  )
    return undefined;
  return [v[0]?.[first] ?? 0, v[1]?.[first] ?? 0, v[2]?.[first] ?? 0];
}
/** FILTERS only already direct physical candidates. Complete family proof routes never call this. */
export function qualifyPartialFamilyMembership(
  p: PreparedSemanticGeometry,
  part: SemanticPart,
  physicalRanks: readonly number[],
  parts: readonly SemanticPart[],
  evidence: readonly SemanticEvidence[],
  signatures: () => FamilySignatures,
  checkpoint: Checkpoint,
  charge: () => void,
): PartialFamilyMembership {
  const started = Date.now();
  let workUnits = 0,
    comparisons = 0,
    subsets = 0;
  const work = (): void => {
    checkpoint();
    charge();
    workUnits++;
  };
  const ranks = [...new Set(physicalRanks)].sort((a, b) => a - b);
  const finish = (
    qualifiedRanks: readonly number[],
    rule: string,
    referenceRank: number | null = null,
    support?: PartialFamilyMembership['support'],
  ): PartialFamilyMembership => {
    checkpoint();
    return {
      physicalRanks: ranks,
      qualifiedRanks,
      rejectedRanks: ranks.filter((r) => !qualifiedRanks.includes(r)),
      rule,
      referenceRank,
      ...(support ? { support } : {}),
      subsets,
      comparisons,
      workUnits,
      scratchBytes: 0,
      milliseconds: Date.now() - started,
    };
  };
  if (!ranks.length || ranks.length > 24) return finish([], 'BOUNDED_OR_EMPTY');
  const data = signatures();
  const references = parts
    .filter((other) => other.id !== part.id && other.instances === 1)
    .flatMap((other) => {
      work();
      const e = evidence.find((e) => e.id === other.id),
        grounded = e?.components.filter((c) => c.strongViews >= 2) ?? [];
      return grounded.length === 1 && !ranks.includes(grounded[0]?.rank ?? -1)
        ? [{ part: other, rank: grounded[0]?.rank ?? -1 }]
        : [];
    })
    .sort(
      (a, b) =>
        Number(b.part.id === part.parentId) - Number(a.part.id === part.parentId) ||
        (p.facts[b.rank]?.area ?? 0) - (p.facts[a.rank]?.area ?? 0),
    );
  const firstReference = references[0],
    runnerUpReference = references[1];
  const reference =
      firstReference &&
      (firstReference.part.id === part.parentId ||
        !runnerUpReference ||
        (p.facts[firstReference.rank]?.area ?? 0) >=
          (p.facts[runnerUpReference.rank]?.area ?? 0) *
            PARTIAL_MEMBERSHIP_LIMITS.minimumReferenceAreaDominance)
        ? firstReference
        : undefined,
    shape = data.signatures.find((s) => s.rank === reference?.rank),
    normal = shape ? supportNormal(shape.moments) : undefined;
  const dot = (point: Vec3, n: Vec3): number =>
    point.reduce((sum, v, i) => sum + v * (n[i] ?? 0), 0);
  if (normal && reference) {
    const center = required(p.facts[reference.rank], 'support reference').centroid,
      parentLevel = dot(center, normal),
      diagonal = required(shape, 'support shape').diagonal,
      memberDiagonal = Math.min(
        ...ranks.map((r) => required(p.facts[r], 'physical member').diagonal),
      ),
      tolerance = Math.max(1e-6, diagonal * 0.01, memberDiagonal * 0.05),
      outlier = Math.max(tolerance * 4, diagonal * 0.08, memberDiagonal * 0.5),
      levels = new Map(
        ranks.map((r) => [r, dot(required(p.facts[r], 'physical member').centroid, normal)]),
      );
    const candidates: number[][] = [];
    for (const seed of ranks) {
      work();
      const members = ranks.filter((rank) => {
        work();
        comparisons++;
        return (
          Math.abs(
            required(levels.get(rank), 'member level') - required(levels.get(seed), 'seed level'),
          ) <= tolerance
        );
      });
      if (members.length < Math.min(2, ranks.length)) continue;
      if (
        Math.max(...members.map((r) => required(levels.get(r), 'level'))) -
          Math.min(...members.map((r) => required(levels.get(r), 'level'))) >
        tolerance
      )
        continue;
      if (!candidates.some((c) => c.join(',') === members.join(','))) candidates.push(members);
    }
    subsets = candidates.length;
    if (subsets > 64) return finish([], 'SUBSET_CEILING');
    candidates.sort((a, b) => b.length - a.length);
    const best = candidates[0];
    if (best) {
      const offset =
          best.reduce((sum, r) => sum + required(levels.get(r), 'level'), 0) / best.length,
        support = { normal, offset, tolerance };
      if (best.length === ranks.length)
        return finish(best, 'SHARED_PARENT_SUPPORT', reference.rank, support);
      const unique = best.length >= (candidates[1]?.length ?? 0) + 1;
      const positive = ranks
        .filter((r) => !best.includes(r))
        .every((r) => {
          work();
          comparisons++;
          const level = required(levels.get(r), 'outlier level');
          return (
            Math.abs(level - offset) >= outlier &&
            Math.abs(level - parentLevel) - Math.abs(offset - parentLevel) >= outlier
          );
        });
      if (unique && best.length >= 2 && positive)
        return finish(
          best,
          'UNIQUE_SUPPORTED_PARTIAL_WITH_POSITIVE_OUTLIER',
          reference.rank,
          support,
        );
    }
    return finish([], 'AMBIGUOUS_OR_CONTRADICTORY_SUPPORT', reference.rank);
    // No categorical same-plane assumption: references without a unique thin support axis
    // use the reflected three-dimensional pattern below instead.
  }
  const centers = ranks.map((r) => required(p.facts[r], 'physical member').centroid),
    center = [0, 1, 2].map(
      (a) => centers.reduce((n, c) => n + (c[a] ?? 0), 0) / centers.length,
    ) as unknown as Vec3;
  if (ranks.length >= 3) {
    let gap = Infinity;
    for (let i = 0; i < centers.length; i++)
      for (let j = i + 1; j < centers.length; j++) {
        work();
        comparisons++;
        gap = Math.min(
          gap,
          Math.hypot(...required(centers[i], 'center').map((v, a) => v - (centers[j]?.[a] ?? 0))),
        );
      }
    const reflected = centers.every((a) =>
      centers.some((b) => {
        work();
        comparisons++;
        return Math.hypot(...a.map((v, i) => v + (b[i] ?? 0) - 2 * (center[i] ?? 0))) <= gap * 0.03;
      }),
    );
    if (reflected && gap > 1e-6) return finish(ranks, 'REFLECTED_PARTIAL_PATTERN');
    return finish([], 'AMBIGUOUS_PARTIAL_MEMBERSHIP');
  }
  if (!normal)
    return finish(ranks, 'UNCONTRADICTED_DIRECT_PHYSICAL_MEMBERS', reference?.rank ?? null);
  return finish([], 'CONTRADICTORY_SUPPORT_RELATION');
}
export function matchesPartialFamilySupport(
  p: PreparedSemanticGeometry,
  membership: PartialFamilyMembership,
  rank: number,
): boolean {
  if (membership.identity) return membership.identity.familyRanks.includes(rank);
  if (membership.support) {
    const s = membership.support,
      c = p.facts[rank]?.centroid;
    if (!c) return false;
    return Math.abs(c.reduce((n, v, i) => n + v * (s.normal[i] ?? 0), 0) - s.offset) <= s.tolerance;
  }
  return membership.qualifiedRanks.includes(rank);
}
