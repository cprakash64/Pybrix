import { SEMANTIC_PLANE_REFINEMENT_LIMITS } from './semantic-plane';
import type { Checkpoint } from './checkpoint';
import type { Vec3 } from '@cadfixer/auto-split-contract';

/** Finite visible-target extent evidence, never exact source ownership. Unknown
 * foreground stays neutral unless two axes corroborate proximal geometric overhang. */
export const PEERLESS_SCOPE_LIMITS = Object.freeze({
  boundaryTail: 0.1,
  materialOverhang: 0.1,
  samples: 8,
  axes: 2,
  frontier: 8,
  refinements: 3,
});
interface Observation {
  readonly view: number;
  readonly target: boolean;
  readonly point?: Vec3;
  scopeOverhangWitness?: boolean;
}
interface ProjectionRow {
  readonly target: number;
  readonly low: number;
  readonly high: number;
  readonly frontierLow: number;
  readonly frontierHigh: number;
  readonly unknownBelowLow: number;
  readonly unknownBelowHigh: number;
  readonly outsideBelow: number;
}
/** A shared intrinsic target envelope. Interior unlabeled surfaces remain neutral;
 * only visible source extending beyond robust target support plus the refinement
 * uncertainty band is eligible as overhang. Flags describe samples, never faces. */
export function collectPeerlessScopeEnvelope(
  points: readonly (Observation & { readonly point: Vec3 })[],
  axes: readonly Vec3[],
  checkpoint: Checkpoint,
  charge: () => void,
): { scratchBytes: number; bounds: readonly { normal: Vec3; low: number; high: number }[] } {
  const bounds = axes.map((normal) => {
    const values: number[] = [];
    for (const [i, p] of points.entries()) {
      if ((i & 1023) === 0) checkpoint();
      charge();
      if (p.target) values.push(p.point.reduce((s, x, a) => s + x * (normal[a] ?? 0), 0));
    }
    let comparisons = 0;
    values.sort((a, b) => {
      if ((comparisons++ & 1023) === 0) checkpoint();
      charge();
      return a - b;
    });
    return {
      normal,
      low: values[Math.floor((values.length - 1) * 0.05)] ?? 0,
      high: values[Math.ceil((values.length - 1) * 0.95)] ?? 0,
    };
  });
  for (const [i, p] of points.entries()) {
    if ((i & 1023) === 0) checkpoint();
    charge();
    p.scopeOverhangWitness =
      !p.target &&
      bounds.some(({ normal, low, high }) => {
        const d = p.point.reduce((s, x, a) => s + x * (normal[a] ?? 0), 0);
        return (
          d < low - SEMANTIC_PLANE_REFINEMENT_LIMITS.band ||
          d > high + SEMANTIC_PLANE_REFINEMENT_LIMITS.band
        );
      });
  }
  return { scratchBytes: points.length * Float64Array.BYTES_PER_ELEMENT, bounds };
}
export interface PeerlessScopeEvidence {
  readonly state: 'TARGET_SCOPE_SUPPORTED' | 'TARGET_SCOPE_AMBIGUOUS' | 'TARGET_SCOPE_OVERBROAD';
  readonly overhangAxes: readonly number[];
  readonly supportedAxes: readonly number[];
  readonly underCoveredAxes: readonly number[];
  readonly boundaryGap: number;
  readonly overhangFraction: number;
  readonly rows: readonly {
    view: number;
    target: number;
    targetSelected: number;
    selected: number;
    unlabeledSelected: number;
    targetFrontier: number;
    targetTerminal: number;
    boundaryGap: number;
    overhang: number;
    overhangFraction: number;
  }[];
}
export function peerlessScopeProjection(
  points: readonly Observation[],
  projected: Float64Array,
  checkpoint: Checkpoint,
  charge: () => void,
): readonly ProjectionRow[] {
  const targets = Array.from({ length: 6 }, () => [] as number[]);
  for (const [i, point] of points.entries()) {
    if ((i & 1023) === 0) checkpoint();
    charge();
    if (point.target) targets[point.view]?.push(projected[i] ?? 0);
  }
  const rows = targets.map((values) => {
    let comparisons = 0;
    values.sort((a, b) => {
      if ((comparisons++ & 1023) === 0) checkpoint();
      charge();
      return a - b;
    });
    return {
      target: values.length,
      low: values[0] ?? 0,
      high: values[values.length - 1] ?? 0,
      frontierLow:
        values[Math.floor((values.length - 1) * PEERLESS_SCOPE_LIMITS.boundaryTail)] ?? 0,
      frontierHigh:
        values[Math.ceil((values.length - 1) * (1 - PEERLESS_SCOPE_LIMITS.boundaryTail))] ?? 0,
      unknownBelowLow: 0,
      unknownBelowHigh: 0,
      outsideBelow: 0,
    };
  });
  for (const [i, point] of points.entries()) {
    if ((i & 1023) === 0) checkpoint();
    charge();
    const row = rows[point.view];
    if (!row || point.target) continue;
    const d = projected[i] ?? 0;
    if (d < row.frontierLow) row.unknownBelowLow++;
    if (d <= row.frontierHigh) row.unknownBelowHigh++;
  }
  return rows;
}
export function peerlessScopeForCut(
  projection: readonly ProjectionRow[],
  counts: readonly { target: number; hit: number; selected: number }[],
  unknownBelow: readonly number[],
  offset: number,
  side: number,
  checkpoint: Checkpoint,
  outsideSelected?: readonly number[],
  requireCoverage = false,
): PeerlessScopeEvidence {
  const observed = new Set<number>(),
    overhangAxes = new Set<number>(),
    underCoveredAxes = new Set<number>();
  let gap = 0,
    worstOverhang = 0;
  const rows = counts.map((count, view) => {
    checkpoint();
    const p = projection[view];
    const frontier = side === 1 ? (p?.frontierLow ?? 0) : -(p?.frontierHigh ?? 0);
    const terminal = side === 1 ? (p?.high ?? 0) : -(p?.low ?? 0);
    const boundaryGap = Math.max(0, frontier - offset * side);
    const overhang = Math.max(
      0,
      side === 1
        ? (p?.unknownBelowLow ?? 0) - (unknownBelow[view] ?? 0)
        : (unknownBelow[view] ?? 0) - (p?.unknownBelowHigh ?? 0),
    );
    const corroboratedOverhang = outsideSelected?.[view] ?? overhang;
    const fraction = corroboratedOverhang / Math.max(1, count.selected);
    if (
      count.target >= PEERLESS_SCOPE_LIMITS.samples &&
      count.selected >= PEERLESS_SCOPE_LIMITS.samples
    ) {
      const axis = Math.floor(view / 2);
      observed.add(axis);
      if (
        count.target - count.hit >= PEERLESS_SCOPE_LIMITS.samples &&
        count.hit / count.target < 0.9
      )
        underCoveredAxes.add(axis);
      gap += boundaryGap / Math.max(1e-8, terminal - frontier);
      worstOverhang = Math.max(worstOverhang, fraction);
      if (
        (outsideSelected !== undefined || boundaryGap > SEMANTIC_PLANE_REFINEMENT_LIMITS.band) &&
        corroboratedOverhang >= PEERLESS_SCOPE_LIMITS.samples &&
        fraction > PEERLESS_SCOPE_LIMITS.materialOverhang
      )
        overhangAxes.add(axis);
    }
    return {
      view,
      target: count.target,
      targetSelected: count.hit,
      selected: count.selected,
      unlabeledSelected: count.selected - count.hit,
      targetFrontier: frontier,
      targetTerminal: terminal,
      boundaryGap,
      overhang: corroboratedOverhang,
      overhangFraction: fraction,
    };
  });
  const supported = [...observed].filter((axis) => !overhangAxes.has(axis));
  return {
    state:
      overhangAxes.size >= PEERLESS_SCOPE_LIMITS.axes
        ? 'TARGET_SCOPE_OVERBROAD'
        : supported.length >= PEERLESS_SCOPE_LIMITS.axes &&
            (!requireCoverage || underCoveredAxes.size < PEERLESS_SCOPE_LIMITS.axes)
          ? 'TARGET_SCOPE_SUPPORTED'
          : 'TARGET_SCOPE_AMBIGUOUS',
    overhangAxes: [...overhangAxes],
    supportedAxes: supported,
    underCoveredAxes: [...underCoveredAxes],
    boundaryGap:
      gap / Math.max(1, rows.filter((r) => r.target >= PEERLESS_SCOPE_LIMITS.samples).length),
    overhangFraction: worstOverhang,
    rows,
  };
}
