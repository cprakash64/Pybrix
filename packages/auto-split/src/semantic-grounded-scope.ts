import { FRAME_FILL, type SemanticPart, type Vec3 } from '@cadfixer/auto-split-contract';
import type { Checkpoint } from './checkpoint';
import { SEMANTIC_PLANE_REFINEMENT_LIMITS } from './semantic-plane';
import type { NormalizedGeometry } from './geometry';
import type { GroundedBoundaryWitness } from './semantic-grounded-boundary';
import {
  peerlessScopeProjection,
  peerlessScopeForCut,
  type PeerlessScopeEvidence,
} from './semantic-peerless-scope';

/** Grounded scope has no structural ranking or native search. A raster pixel
 * describes boundary uncertainty; unlabelled interior samples remain neutral. */
export const GROUNDED_SCOPE_LIMITS = Object.freeze({
  tail: 0.05,
  samples: 8,
  axes: 2,
  materialOverhang: 0.1,
});
interface Point {
  readonly point: Vec3;
  readonly view: number;
  readonly target: boolean;
  readonly peerMask: number;
  readonly rank: number;
  scopeOverhangWitness?: boolean;
}
export interface GroundedTargetScopeEvidence extends PeerlessScopeEvidence {
  readonly boundaryWitness?: GroundedBoundaryWitness;
  readonly intrinsicFrontier: number;
  readonly pixelUncertainty: number;
}
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const quantile = (values: readonly number[], q: number): number =>
  values[Math.floor((values.length - 1) * q)] ?? 0;

/** Refine only the three intrinsic directions with corroborating planar source
 * sections. One bounded face pass; neither candidate offsets nor native results
 * participate. Source coordinates and buffers are never changed. */
export function groundedSourceFrame(
  geometry: NormalizedGeometry,
  axes: readonly Vec3[],
  faceSamples: number,
  checkpoint: Checkpoint,
  charge: () => void,
): readonly Vec3[] {
  const sums = axes.map(() => ({ vector: [0, 0, 0], area: 0, faces: 0 }));
  let totalArea = 0;
  const stride = Math.max(1, Math.ceil(geometry.faceCount / faceSamples));
  for (let f = 0; f < geometry.faceCount; f += stride) {
    if (f % (stride * 256) === 0) checkpoint();
    charge();
    const vertices = [0, 1, 2].map((k) => (geometry.indices[f * 3 + k] ?? 0) * 3);
    const a = vertices[0] ?? 0,
      b = vertices[1] ?? 0,
      c = vertices[2] ?? 0;
    const edge = (i: number, axis: number): number =>
      (geometry.positions[i + axis] ?? 0) - (geometry.positions[a + axis] ?? 0);
    const u = [0, 1, 2].map((axis) => edge(b, axis)),
      v = [0, 1, 2].map((axis) => edge(c, axis));
    const cross: Vec3 = [
      (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
      (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
      (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
    ];
    const area = Math.hypot(...cross);
    if (!(area > 0)) continue;
    totalArea += area;
    for (const [i, axis] of axes.entries()) {
      const alignment = dot(cross, axis) / area,
        sum = sums[i];
      if (!sum || Math.abs(alignment) < Math.cos(0.1)) continue;
      sum.area += area;
      sum.faces++;
      for (let k = 0; k < 3; k++)
        sum.vector[k] = (sum.vector[k] ?? 0) + (cross[k] ?? 0) * Math.sign(alignment);
    }
  }
  checkpoint();
  return sums.flatMap((sum) => {
    const length = Math.hypot(...sum.vector);
    return sum.faces >= 8 && sum.area / Math.max(1e-12, totalArea) >= 0.01 && length > 0
      ? [
          [
            (sum.vector[0] ?? 0) / length,
            (sum.vector[1] ?? 0) / length,
            (sum.vector[2] ?? 0) / length,
          ] as Vec3,
        ]
      : [];
  });
}
function sorted(values: number[], checkpoint: Checkpoint, charge: () => void): number[] {
  let work = 0;
  return values.sort((a, b) => {
    if ((work++ & 1023) === 0) checkpoint();
    charge();
    return a - b;
  });
}

/** Preserve ordinary proposals for actual complementary coverage: reconciliation
 * still proves the complete graph, source rank, uniqueness and common cut. */
export function complementaryCoveragePartners(
  points: readonly Point[],
  peers: readonly { readonly part: SemanticPart; readonly fused: boolean }[],
  part: SemanticPart,
  checkpoint: Checkpoint,
  charge: () => void,
): readonly string[] {
  return peers
    .flatMap((peer, index) => {
      if (
        !peer.fused ||
        peer.part.parentId !== part.parentId ||
        peer.part.importance !== 'major' ||
        peer.part.instances !== 1 ||
        peer.part.expectedGeometry.kind !== 'solid_part'
      )
        return [];
      const rows = Array.from({ length: 6 }, () => ({
        total: 0,
        a: 0,
        b: 0,
        union: 0,
        overlap: 0,
      }));
      for (const [i, p] of points.entries()) {
        if ((i & 1023) === 0) checkpoint();
        charge();
        const row = rows[p.view];
        if (!row) continue;
        const b = Boolean(p.peerMask & (1 << index));
        row.total++;
        if (p.target) row.a++;
        if (b) row.b++;
        if (p.target || b) row.union++;
        if (p.target && b) row.overlap++;
      }
      const supported =
        new Set(
          rows.flatMap((r, vi) =>
            r.a >= 8 &&
            r.b >= 8 &&
            r.union / Math.max(1, r.total) >= 0.95 &&
            r.overlap / Math.max(1, r.union) <= 0.02
              ? [Math.floor(vi / 2)]
              : [],
          ),
        ).size >= 2;
      return supported ? [peer.part.id] : [];
    })
    .sort();
}

export function collectGroundedScopeEnvelope(
  points: readonly Point[],
  axes: readonly Vec3[],
  radius: number,
  rasterSize: number,
  checkpoint: Checkpoint,
  charge: () => void,
): number {
  const uncertainty = (2 * radius) / (rasterSize * FRAME_FILL);
  const envelopeUncertainty = Math.max(uncertainty, SEMANTIC_PLANE_REFINEMENT_LIMITS.band);
  const bounds = axes.map((normal) => {
    const values = sorted(
      points.filter((p) => p.target).map((p) => dot(p.point, normal)),
      checkpoint,
      charge,
    );
    return { normal, low: quantile(values, 0.05), high: quantile(values, 0.95) };
  });
  for (const [i, p] of points.entries()) {
    if ((i & 1023) === 0) checkpoint();
    charge();
    p.scopeOverhangWitness =
      !p.target &&
      bounds.some(({ normal, low, high }) => {
        const d = dot(p.point, normal);
        return d < low - envelopeUncertainty || d > high + envelopeUncertainty;
      });
  }
  return uncertainty;
}
export function groundedScopeProjection(
  points: readonly Point[],
  projected: Float64Array,
  checkpoint: Checkpoint,
  charge: () => void,
  boundaryWitness?: GroundedBoundaryWitness,
): {
  rows: ReturnType<typeof peerlessScopeProjection>;
  low: number;
  high: number;
  boundaryWitness?: GroundedBoundaryWitness;
} {
  const rows = peerlessScopeProjection(points, projected, checkpoint, charge);
  const axes = [0, 1, 2].flatMap((axis) => {
    const observed = rows
      .slice(axis * 2, axis * 2 + 2)
      .filter((r) => r.target >= GROUNDED_SCOPE_LIMITS.samples);
    return observed.length
      ? [
          {
            low: Math.min(...observed.map((r) => r.low)),
            high: Math.max(...observed.map((r) => r.high)),
          },
        ]
      : [];
  });
  const lows = sorted(
    axes.map((a) => a.low),
    checkpoint,
    charge,
  );
  const highs = sorted(
    axes.map((a) => a.high),
    checkpoint,
    charge,
  );
  return {
    rows,
    // One padded or occluded camera axis cannot establish a target boundary.
    // Interior annotation omissions do not move independently seen extrema.
    low: boundaryWitness?.low ?? lows[Math.min(1, lows.length - 1)] ?? 0,
    high: boundaryWitness?.high ?? highs[Math.max(0, highs.length - 2)] ?? 0,
    ...(boundaryWitness ? { boundaryWitness } : {}),
  };
}
export function groundedScopeForCut(
  projection: ReturnType<typeof groundedScopeProjection>,
  counts: readonly { target: number; hit: number; selected: number }[],
  unknownBelow: readonly number[],
  outsideSelected: readonly number[],
  offset: number,
  side: number,
  uncertainty: number,
  checkpoint: Checkpoint,
): GroundedTargetScopeEvidence {
  const base = peerlessScopeForCut(
    projection.rows,
    counts,
    unknownBelow,
    offset,
    side,
    checkpoint,
    outsideSelected,
    true,
  );
  const frontier = side === 1 ? projection.low : -projection.high;
  // A broad selected halfspace cannot dilute its own overhang witness. Measure
  // corroborated outside source against observed target support on each axis.
  const rows = base.rows.map((row) => ({
    ...row,
    overhangFraction: row.overhang / Math.max(1, row.targetSelected),
  }));
  const overhang = new Set(
    rows.flatMap((row) =>
      row.targetSelected >= GROUNDED_SCOPE_LIMITS.samples &&
      row.overhang >= GROUNDED_SCOPE_LIMITS.samples &&
      row.overhangFraction > GROUNDED_SCOPE_LIMITS.materialOverhang
        ? [Math.floor(row.view / 2)]
        : [],
    ),
  );
  // Keep target support separate from uncorroborated overhang. One camera
  // cannot become an implicit veto; peer ownership is checked independently.
  const observedAxes = [
    ...new Set(
      rows.flatMap((row) =>
        row.target >= GROUNDED_SCOPE_LIMITS.samples &&
        row.targetSelected >= GROUNDED_SCOPE_LIMITS.samples
          ? [Math.floor(row.view / 2)]
          : [],
      ),
    ),
  ];
  return {
    ...base,
    state:
      overhang.size >= GROUNDED_SCOPE_LIMITS.axes
        ? 'TARGET_SCOPE_OVERBROAD'
        : offset * side < frontier - (projection.boundaryWitness ? uncertainty : 1e-8)
          ? 'TARGET_SCOPE_AMBIGUOUS'
          : observedAxes.length >= GROUNDED_SCOPE_LIMITS.axes &&
              base.underCoveredAxes.length < GROUNDED_SCOPE_LIMITS.axes
            ? 'TARGET_SCOPE_SUPPORTED'
            : 'TARGET_SCOPE_AMBIGUOUS',
    rows,
    overhangAxes: [...overhang],
    supportedAxes:
      overhang.size >= GROUNDED_SCOPE_LIMITS.axes
        ? observedAxes.filter((axis) => !overhang.has(axis))
        : observedAxes,
    overhangFraction: Math.max(0, ...rows.map((row) => row.overhangFraction)),
    intrinsicFrontier: frontier,
    pixelUncertainty: uncertainty,
    ...(projection.boundaryWitness ? { boundaryWitness: projection.boundaryWitness } : {}),
  };
}
