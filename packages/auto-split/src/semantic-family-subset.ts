import { required } from './required';
import type { SemanticPart, Vec3 } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import type { Checkpoint } from './checkpoint';
import {
  similarFamilyComponents,
  type FamilySignatures,
  type FamilyScore,
  type FamilyPolygon,
  type FamilyCompletion,
} from './semantic-family';
export const FAMILY_SUBSET_LIMITS = Object.freeze({
  maximumExcess: 2,
  maximumSubsets: 64,
  minimumAnchors: 2,
  confidence: 0.9,
  purity: 0.9,
  spatialResidual: 0.03,
  winnerMargin: 0.1,
  outlierGapRatio: 0.15,
  outlierDiagonalRatio: 0.25,
});
export interface FamilySubset extends FamilyCompletion {
  readonly subsets: number;
  readonly workUnits: number;
  readonly scratchBytes: number;
  readonly bestLoss: number | null;
  readonly secondLoss: number | null;
  readonly excluded: readonly number[];
}
/** A separate, bounded inference route. Direct membership and exact-count completion remain unchanged. */
export function resolveSemanticFamilySubset(
  p: PreparedSemanticGeometry,
  part: SemanticPart,
  anchors: readonly number[],
  scores: readonly FamilyScore[],
  polygons: readonly FamilyPolygon[],
  signatures: () => FamilySignatures,
  checkpoint: Checkpoint,
  charge: () => void,
): FamilySubset | undefined {
  if (
    part.instances < 3 ||
    part.confidence < FAMILY_SUBSET_LIMITS.confidence ||
    part.expectedGeometry.kind !== 'repeated_part' ||
    anchors.length < FAMILY_SUBSET_LIMITS.minimumAnchors ||
    anchors.length >= part.instances
  )
    return undefined;
  const started = Date.now();
  let comparisons = 0,
    workUnits = 0,
    subsets = 0;
  const work = (): void => {
    checkpoint();
    charge();
    workUnits++;
  };
  const data = signatures(),
    first = data.signatures.find((s) => s.rank === anchors[0]);
  if (!first) return undefined;
  const members = data.signatures.filter((s) => {
    work();
    comparisons++;
    return similarFamilyComponents(first, s);
  });
  const refuse = (
    reason: string,
    bestLoss: number | null = null,
    secondLoss: number | null = null,
  ): FamilySubset => ({
    ranks: [],
    anchors,
    propagated: [],
    candidatesConsidered: members.length,
    comparisons,
    workerMs: Date.now() - started,
    reason,
    subsets,
    workUnits,
    scratchBytes: 0,
    bestLoss,
    secondLoss,
    excluded: [],
  });
  if (
    members.length <= part.instances ||
    members.length > part.instances + FAMILY_SUBSET_LIMITS.maximumExcess ||
    !anchors.every((r) => members.some((s) => s.rank === r))
  )
    return refuse('No bounded oversized anchored class');
  for (const member of members)
    for (const other of data.signatures) {
      work();
      comparisons++;
      if (similarFamilyComponents(member, other) !== members.some((s) => s.rank === other.rank))
        return refuse('Non-transitive equivalent class');
    }
  const ranks = members.map((s) => s.rank),
    purity = (poly: FamilyPolygon): number =>
      poly.support && poly.pixels
        ? poly.support.filter((s) => ranks.includes(s.rank)).reduce((n, s) => n + s.pixels, 0) /
          poly.pixels
        : poly.ranks.length && poly.ranks.every((r) => ranks.includes(r))
          ? poly.purity
          : 0;
  if (
    new Set(
      polygons
        .filter((poly) => purity(poly) >= FAMILY_SUBSET_LIMITS.purity)
        .map((poly) => poly.view),
    ).size < 2 ||
    polygons.some((poly) => purity(poly) < FAMILY_SUBSET_LIMITS.purity)
  )
    return refuse('Missing or body-overlapping family region');
  // Existing positive contradictory annotations and duplicate semantic instances remain refusals.
  if (
    scores.some((s) => anchors.includes(s.rank) && s.viewCoverage.some((v) => v > 0 && v < 0.82)) ||
    polygons.some(
      (poly, i) =>
        poly.ranks.length === 1 &&
        polygons
          .slice(0, i)
          .some(
            (other) =>
              other.view === poly.view &&
              other.ranks.length === 1 &&
              other.ranks[0] === poly.ranks[0],
          ),
    )
  )
    return refuse('Contradictory or duplicate semantic anchor');
  // One-view isolated observations are weaker than direct executable anchors, but
  // remain positive membership claims. Never discard one to improve spatial fit.
  const mandatory = ranks.filter(
    (rank) =>
      anchors.includes(rank) ||
      scores.some(
        (score) =>
          score.rank === rank &&
          score.strongViews > 0 &&
          polygons.some(
            (poly) =>
              poly.ranks.length === 1 &&
              poly.ranks[0] === rank &&
              poly.purity >= FAMILY_SUBSET_LIMITS.purity,
          ),
      ),
  );
  if (mandatory.length > part.instances) return refuse('More observed members than declared count');
  const choices: number[][] = [],
    optional = ranks.filter((r) => !mandatory.includes(r)),
    need = part.instances - mandatory.length;
  let combinations = 1;
  for (let i = 1; i <= need; i++) {
    work();
    combinations = (combinations * (optional.length - i + 1)) / i;
    if (combinations > FAMILY_SUBSET_LIMITS.maximumSubsets)
      return refuse('Subset enumeration ceiling');
  }
  const enumerate = (from: number, chosen: number[]): void => {
    work();
    if (chosen.length === need) {
      choices.push([...mandatory, ...chosen].sort((a, b) => a - b));
      return;
    }
    for (let i = from; i < optional.length; i++) {
      const rank = optional[i];
      if (rank !== undefined) enumerate(i + 1, [...chosen, rank]);
    }
  };
  enumerate(0, []);
  const distance = (a: Vec3, b: Vec3): number => Math.hypot(...a.map((v, k) => v - (b[k] ?? 0)));
  const evaluations = choices
    .map((selected) => {
      work();
      subsets++;
      const centers = selected.map((r) => required(p.facts[r], 'subset center').centroid);
      let gap = Infinity;
      for (let i = 0; i < selected.length; i++)
        for (let j = i + 1; j < selected.length; j++) {
          work();
          comparisons++;
          const a = required(
              members.find((m) => m.rank === selected[i]),
              'subset member',
            ),
            b = required(
              members.find((m) => m.rank === selected[j]),
              'subset member',
            );
          if (
            ![0, 1, 2].some(
              (k) =>
                (a.hi[k] ?? 0) < (b.lo[k] ?? 0) - 1e-6 || (b.hi[k] ?? 0) < (a.lo[k] ?? 0) - 1e-6,
            )
          )
            return { selected, loss: Infinity, valid: false };
          gap = Math.min(
            gap,
            distance(required(centers[i], 'subset center'), required(centers[j], 'subset center')),
          );
        }
      const origin = required(centers[0], 'subset center'),
        diff = (a: Vec3, b: Vec3): Vec3 => a.map((v, k) => v - (b[k] ?? 0)) as unknown as Vec3;
      let normal: Vec3 = [0, 0, 0],
        magnitude = 0;
      for (let i = 1; i < centers.length; i++)
        for (let j = i + 1; j < centers.length; j++) {
          work();
          const a = diff(required(centers[i], 'subset center'), origin),
            b = diff(required(centers[j], 'subset center'), origin),
            n: Vec3 = [
              a[1] * b[2] - a[2] * b[1],
              a[2] * b[0] - a[0] * b[2],
              a[0] * b[1] - a[1] * b[0],
            ],
            length = Math.hypot(...n);
          if (length > magnitude) {
            normal = n;
            magnitude = length;
          }
        }
      if (magnitude < gap * gap * 0.05) return { selected, loss: Infinity, valid: false };
      const planeDistance = (c: Vec3): number =>
        Math.abs(diff(c, origin).reduce((n, v, k) => n + v * (normal[k] ?? 0), 0)) / magnitude;
      const planar = Math.max(...centers.map(planeDistance)) / gap,
        center = origin.map(
          (_v, k) => centers.reduce((n, c) => n + (c[k] ?? 0), 0) / centers.length,
        ) as unknown as Vec3;
      const reflected =
        Math.max(
          ...centers.map((a) =>
            Math.min(
              ...centers.map((b) =>
                Math.hypot(...a.map((v, k) => v + (b[k] ?? 0) - 2 * (center[k] ?? 0))),
              ),
            ),
          ),
        ) / gap;
      const distances = centers.flatMap((a, i) => centers.slice(i + 1).map((b) => distance(a, b))),
        regular = Math.max(...distances) / gap - 1,
        symmetry = Math.min(reflected, regular);
      const excluded = members.filter((m) => !selected.includes(m.rank));
      const positiveExclusion = excluded.every(
        (m) =>
          planeDistance(required(p.facts[m.rank], 'outlier center').centroid) >
          Math.max(
            gap * FAMILY_SUBSET_LIMITS.outlierGapRatio,
            m.diagonal * FAMILY_SUBSET_LIMITS.outlierDiagonalRatio,
          ),
      );
      return {
        selected,
        loss: planar + symmetry,
        valid:
          planar <= FAMILY_SUBSET_LIMITS.spatialResidual &&
          symmetry <= FAMILY_SUBSET_LIMITS.spatialResidual &&
          positiveExclusion,
      };
    })
    .sort((a, b) => a.loss - b.loss);
  const best = evaluations[0],
    second = evaluations[1];
  if (!best?.valid || (second && second.loss - best.loss < FAMILY_SUBSET_LIMITS.winnerMargin))
    return refuse(
      'No uniquely dominant spatial subset',
      best && Number.isFinite(best.loss) ? best.loss : null,
      second && Number.isFinite(second.loss) ? second.loss : null,
    );
  checkpoint();
  return {
    ranks: best.selected,
    anchors,
    propagated: best.selected.filter((r) => !anchors.includes(r)),
    candidatesConsidered: members.length,
    comparisons,
    workerMs: Date.now() - started,
    reason: 'Unique anchored coplanar symmetric subset with positively separated outliers',
    subsets,
    workUnits,
    scratchBytes: 0,
    bestLoss: best.loss,
    secondLoss: second && Number.isFinite(second.loss) ? second.loss : null,
    excluded: ranks.filter((r) => !best.selected.includes(r)),
  };
}
