import { SEMANTIC_LIMITS, type SemanticPart, type Vec3 } from '@cadfixer/auto-split-contract';
import { MAX_SUPPORTED_SPLIT_TRIANGLES } from '@cadfixer/mesh-core';
import { resourceLimitExceeded } from '@cadfixer/shared';
import type { PreparedSemanticGeometry } from './semantic';
import { CHECKPOINT_STRIDE, type Checkpoint } from './checkpoint';
import { required } from './required';

/** These are additional inference requirements, never replacements for raster coverage or Preview. */
export const FAMILY_COMPLETION_LIMITS = Object.freeze({
  dimensionRatio: 1.03,
  areaRatio: 1.03,
  faceRatio: 4,
  momentDifference: 0.003,
  supportDifference: 0.003,
  volumeRatio: 1.03,
  spatialResidual: 0.03,
  polygonPurity: 0.9,
  minimumAnchors: 2,
  coverage: 0.82,
});
const directions: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [1, -1, 0],
  [1, 0, 1],
  [1, 0, -1],
  [0, 1, 1],
  [0, 1, -1],
  [1, 1, 1],
  [1, 1, -1],
  [1, -1, 1],
  [1, -1, -1],
].map((v) => v.map((x) => x / Math.hypot(...v)) as unknown as Vec3);
export interface FamilySignature {
  readonly rank: number;
  readonly dimensions: readonly number[];
  readonly area: number;
  readonly faces: number;
  readonly moments: readonly number[];
  readonly support: readonly number[];
  readonly volume: number;
  readonly diagonal: number;
  readonly lo: Vec3;
  readonly hi: Vec3;
}
export interface FamilySignatures {
  readonly signatures: readonly FamilySignature[];
  readonly facesVisited: number;
  readonly bytes: number;
}
/** One lazy worker-side scan, shared by incomplete families. No canonical mesh allocation. */
export function familySignatures(
  p: PreparedSemanticGeometry,
  checkpoint: Checkpoint,
): FamilySignatures {
  if (
    p.geometry.faceCount > MAX_SUPPORTED_SPLIT_TRIANGLES ||
    p.metadata.components.length > SEMANTIC_LIMITS.components
  )
    throw resourceLimitExceeded('The family evidence exceeds the supported work limit.');
  const meta = p.metadata.components,
    count = meta.length;
  const moments = new Float64Array(count * 6),
    volume = new Float64Array(count);
  const min = new Float64Array(count * directions.length).fill(Infinity);
  const max = new Float64Array(count * directions.length).fill(-Infinity);
  const xyz = new Float64Array(9);
  for (let f = 0; f < p.geometry.faceCount; f++) {
    if (f % CHECKPOINT_STRIDE === 0) checkpoint();
    const r = p.labelling.faceRank[f] ?? -1;
    if (r < 0 || r >= count) continue;
    const centroid = required(p.facts[r], 'family centroid').centroid;
    for (let c = 0; c < 3; c++) {
      const i = (p.geometry.indices[f * 3 + c] ?? 0) * 3;
      for (let a = 0; a < 3; a++)
        xyz[c * 3 + a] = (p.geometry.positions[i + a] ?? 0) - (centroid[a] ?? 0);
      for (const [d, n] of directions.entries()) {
        const value =
          (xyz[c * 3] ?? 0) * n[0] + (xyz[c * 3 + 1] ?? 0) * n[1] + (xyz[c * 3 + 2] ?? 0) * n[2];
        min[r * directions.length + d] = Math.min(
          min[r * directions.length + d] ?? Infinity,
          value,
        );
        max[r * directions.length + d] = Math.max(
          max[r * directions.length + d] ?? -Infinity,
          value,
        );
      }
    }
    const ax = xyz[0] ?? 0,
      ay = xyz[1] ?? 0,
      az = xyz[2] ?? 0,
      bx = xyz[3] ?? 0,
      by = xyz[4] ?? 0,
      bz = xyz[5] ?? 0,
      cx = xyz[6] ?? 0,
      cy = xyz[7] ?? 0,
      cz = xyz[8] ?? 0;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay),
      ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
      nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const area = Math.hypot(nx, ny, nz) / 2;
    let k = 0;
    for (let a = 0; a < 3; a++)
      for (let b = a; b < 3; b++) {
        const x = xyz[a] ?? 0,
          y = xyz[a + 3] ?? 0,
          z = xyz[a + 6] ?? 0,
          u = xyz[b] ?? 0,
          v = xyz[b + 3] ?? 0,
          w = xyz[b + 6] ?? 0;
        moments[r * 6 + k] =
          (moments[r * 6 + k] ?? 0) +
          (area * ((x + y + z) * (u + v + w) + x * u + y * v + z * w)) / 12;
        k++;
      }
    volume[r] =
      (volume[r] ?? 0) +
      (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  checkpoint();
  return {
    facesVisited: p.geometry.faceCount,
    bytes:
      moments.byteLength + volume.byteLength + min.byteLength + max.byteLength + xyz.byteLength,
    signatures: meta.map((c) => {
      const r = Number(c.id.slice(1)),
        dimensions = c.bounds.max.map((v, a) => v - (c.bounds.min[a] ?? 0)),
        diagonal = Math.hypot(...dimensions),
        fact = required(p.facts[r], 'family facts');
      return {
        rank: r,
        dimensions,
        diagonal,
        area: fact.area,
        faces: fact.faces,
        lo: c.bounds.min,
        hi: c.bounds.max,
        moments: Array.from(
          moments.subarray(r * 6, r * 6 + 6),
          (v) => v / (fact.area * diagonal * diagonal),
        ),
        support: directions.flatMap((_n, d) => [
          (min[r * directions.length + d] ?? 0) / diagonal,
          (max[r * directions.length + d] ?? 0) / diagonal,
        ]),
        volume: Math.abs(volume[r] ?? 0) / diagonal ** 3,
      };
    }),
  };
}
const ratio = (a: number, b: number): number =>
  Math.min(a, b) > 0 ? Math.max(a, b) / Math.min(a, b) : Infinity;
export function similarFamilyComponents(a: FamilySignature, b: FamilySignature): boolean {
  return (
    a.dimensions.every(
      (v, i) => ratio(v, b.dimensions[i] ?? 0) <= FAMILY_COMPLETION_LIMITS.dimensionRatio,
    ) &&
    ratio(a.area, b.area) <= FAMILY_COMPLETION_LIMITS.areaRatio &&
    ratio(a.faces, b.faces) <= FAMILY_COMPLETION_LIMITS.faceRatio &&
    a.volume > 1e-6 &&
    b.volume > 1e-6 &&
    ratio(a.volume, b.volume) <= FAMILY_COMPLETION_LIMITS.volumeRatio &&
    a.moments.every(
      (v, i) =>
        Math.abs(v - (b.moments[i] ?? Infinity)) <= FAMILY_COMPLETION_LIMITS.momentDifference,
    ) &&
    a.support.every(
      (v, i) =>
        Math.abs(v - (b.support[i] ?? Infinity)) <= FAMILY_COMPLETION_LIMITS.supportDifference,
    )
  );
}
export interface FamilyPolygon {
  readonly view: number;
  readonly ranks: readonly number[];
  readonly purity: number;
}
export interface FamilyScore {
  readonly rank: number;
  readonly viewCoverage: readonly number[];
  readonly strongViews: number;
}
export interface FamilyCompletion {
  readonly ranks: readonly number[];
  readonly anchors: readonly number[];
  readonly propagated: readonly number[];
  readonly candidatesConsidered: number;
  readonly comparisons: number;
  readonly workerMs: number;
  readonly reason: string;
}
/** A complete equivalent class is required. No best-subset search, labels, axis assumptions, or inferred geometry. */
export function completeSemanticFamily(
  p: PreparedSemanticGeometry,
  part: SemanticPart,
  initial: readonly number[],
  scores: readonly FamilyScore[],
  polygons: readonly FamilyPolygon[],
  signatures: () => FamilySignatures,
  checkpoint: Checkpoint,
): FamilyCompletion | undefined {
  if (
    part.instances < 3 ||
    initial.length >= part.instances ||
    part.expectedGeometry.kind !== 'repeated_part'
  )
    return undefined;
  const start = Date.now(),
    anchors = scores
      .filter(
        (s) =>
          s.strongViews >= 2 &&
          polygons.some(
            (poly) =>
              poly.ranks.length === 1 &&
              poly.ranks[0] === s.rank &&
              poly.purity >= FAMILY_COMPLETION_LIMITS.polygonPurity,
          ),
      )
      .map((s) => s.rank);
  if (anchors.length < FAMILY_COMPLETION_LIMITS.minimumAnchors) return undefined;
  const data = signatures(),
    first = required(
      data.signatures.find((s) => s.rank === anchors[0]),
      'anchor signature',
    );
  let comparisons = 0;
  const ranks: number[] = [];
  for (const signature of data.signatures) {
    checkpoint();
    comparisons++;
    if (similarFamilyComponents(first, signature)) ranks.push(signature.rank);
  }
  const refuse = (reason: string): FamilyCompletion => ({
    ranks: [],
    anchors,
    propagated: [],
    candidatesConsidered: data.signatures.length,
    comparisons,
    workerMs: Date.now() - start,
    reason,
  });
  if (ranks.length !== part.instances || !anchors.every((r) => ranks.includes(r)))
    return refuse('No unique complete equivalent component class');
  // Every supplied polygon must prove one member of this class. A polygon elsewhere is contradiction.
  if (
    !polygons.length ||
    polygons.some(
      (poly) =>
        poly.ranks.length !== 1 ||
        !ranks.includes(poly.ranks[0] ?? -1) ||
        poly.purity < FAMILY_COMPLETION_LIMITS.polygonPurity,
    )
  )
    return refuse('Contradictory or ambiguous family polygon');
  for (const r of ranks) {
    checkpoint();
    if (
      !polygons.some(
        (poly) =>
          poly.ranks.length === 1 &&
          poly.ranks[0] === r &&
          poly.purity >= FAMILY_COMPLETION_LIMITS.polygonPurity,
      )
    )
      return refuse('No direct semantic observation for a proposed sibling');
    const score = required(
      scores.find((s) => s.rank === r),
      'family score',
    );
    if (score.viewCoverage.some((v) => v > 0 && v < FAMILY_COMPLETION_LIMITS.coverage))
      return refuse('Partial contradictory annotation for an observable instance');
  }
  const signaturesByRank = new Map(data.signatures.map((s) => [s.rank, s]));
  const centers = ranks.map((r) => required(p.facts[r], 'family center').centroid);
  const center = [0, 1, 2].map(
    (a) => centers.reduce((s, v) => s + (v[a] ?? 0), 0) / centers.length,
  );
  let minGap = Infinity;
  for (let i = 0; i < ranks.length; i++)
    for (let j = i + 1; j < ranks.length; j++) {
      checkpoint();
      comparisons++;
      const a = required(signaturesByRank.get(ranks[i] ?? -1), 'family bounds'),
        b = required(signaturesByRank.get(ranks[j] ?? -1), 'family bounds');
      const separated = [0, 1, 2].some(
        (k) => (a.hi[k] ?? 0) < (b.lo[k] ?? 0) - 1e-6 || (b.hi[k] ?? 0) < (a.lo[k] ?? 0) - 1e-6,
      );
      if (!separated) return refuse('Overlapping or unproven isolated component bounds');
      minGap = Math.min(
        minGap,
        Math.hypot(...required(centers[i], 'center').map((v, k) => v - (centers[j]?.[k] ?? 0))),
      );
    }
  const reflected = centers.every((a) =>
    centers.some(
      (b) =>
        Math.hypot(...a.map((v, k) => v + (b[k] ?? 0) - 2 * (center[k] ?? 0))) <=
        minGap * FAMILY_COMPLETION_LIMITS.spatialResidual,
    ),
  );
  const pairDistances = centers.flatMap((a, i) =>
    centers.slice(i + 1).map((b) => Math.hypot(...a.map((v, k) => v - (b[k] ?? 0)))),
  );
  const regular = ratio(Math.max(...pairDistances), Math.min(...pairDistances)) <= 1.03;
  if (!reflected && !regular) return refuse('No corroborating symmetric or regular spatial family');
  return {
    ranks,
    anchors,
    propagated: ranks.filter((r) => !anchors.includes(r)),
    candidatesConsidered: data.signatures.length,
    comparisons,
    workerMs: Date.now() - start,
    reason: 'Exact isolated equivalent family corroborates omitted instance annotations',
  };
}
