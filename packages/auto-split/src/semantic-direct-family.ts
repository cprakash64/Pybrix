import type { SemanticPart } from '@cadfixer/auto-split-contract';
import type { Checkpoint } from './checkpoint';
import { FAMILY_COMPLETION_LIMITS, type FamilyPolygon, type FamilyScore } from './semantic-family';

/** Source membership from independent semantic instance footprints, never shape propagation. */
export interface DirectSemanticFamily {
  readonly ranks: readonly number[];
  readonly state: 'COMPLETE' | 'PARTIAL' | 'AMBIGUOUS' | 'NONE';
  readonly evaluated: number;
  readonly workUnits: number;
  readonly comparisons: number;
  readonly scratchBytes: number;
  readonly milliseconds: number;
}
export function directSemanticFamily(
  part: SemanticPart,
  scores: readonly FamilyScore[],
  polygons: readonly FamilyPolygon[],
  checkpoint: Checkpoint,
  charge: () => void,
): DirectSemanticFamily {
  const start = Date.now();
  let workUnits = 0;
  const work = (): void => {
    checkpoint();
    charge();
    workUnits++;
  };
  const eligible =
    part.confidence >= 0.9 && part.instances > 1 && part.expectedGeometry.kind === 'repeated_part';
  const proven: number[] = [];
  if (eligible)
    for (const score of scores) {
      work();
      if (
        score.strongViews < 2 ||
        score.viewCoverage.some((v) => v > 0 && v < FAMILY_COMPLETION_LIMITS.coverage)
      )
        continue;
      const views = new Set<number>();
      let duplicate = false;
      for (const polygon of polygons) {
        work();
        if (
          polygon.ranks.length !== 1 ||
          polygon.ranks[0] !== score.rank ||
          polygon.purity < FAMILY_COMPLETION_LIMITS.polygonPurity
        )
          continue;
        if (views.has(polygon.view)) duplicate = true;
        views.add(polygon.view);
      }
      if (!duplicate && views.size >= 2) proven.push(score.rank);
    }
  // A footprint that substantially consumes a non-proven body/other component cannot
  // establish an independent instance. Evaluate simultaneously, without first-match pruning.
  const ranks = proven.filter(
    (rank) =>
      !polygons.some((polygon) => {
        work();
        if (!polygon.ranks.includes(rank)) return false;
        const purity =
          polygon.support && polygon.pixels
            ? polygon.support
                .filter((s) => proven.includes(s.rank))
                .reduce((n, s) => n + s.pixels, 0) / polygon.pixels
            : polygon.ranks.every((r) => proven.includes(r))
              ? polygon.purity
              : 0;
        return purity < FAMILY_COMPLETION_LIMITS.polygonPurity;
      }),
  );
  checkpoint();
  return {
    ranks: ranks.length > part.instances ? [] : ranks,
    state:
      ranks.length > part.instances
        ? 'AMBIGUOUS'
        : !ranks.length
          ? 'NONE'
          : ranks.length === part.instances
            ? 'COMPLETE'
            : 'PARTIAL',
    evaluated: eligible ? scores.length : 0,
    workUnits,
    comparisons: workUnits,
    scratchBytes: 0,
    milliseconds: Date.now() - start,
  };
}
