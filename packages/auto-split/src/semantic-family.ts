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
  readonly pixels?: number;
  readonly support?: readonly { readonly rank: number; readonly pixels: number }[];
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
/** Independent observations, not labels or component IDs, establish the semantic anchors. */
export function familyGrounding(
  part: SemanticPart,
  scores: readonly FamilyScore[],
  polygons: readonly FamilyPolygon[],
): {
  readonly direct: readonly number[];
  readonly strict: readonly number[];
  readonly collective: boolean;
  readonly distributed: boolean;
} {
  const direct = scores
    .filter(
      (s) =>
        s.strongViews >= 1 &&
        polygons.some(
          (poly) =>
            poly.ranks.length === 1 &&
            poly.ranks[0] === s.rank &&
            poly.purity >= FAMILY_COMPLETION_LIMITS.polygonPurity,
        ),
    )
    .map((s) => s.rank);
  const strict = scores
    .filter((s) => s.strongViews >= 2 && direct.includes(s.rank))
    .map((s) => s.rank);
  const views = new Set(
    polygons
      .filter(
        (poly) =>
          poly.ranks.length === 1 &&
          direct.includes(poly.ranks[0] ?? -1) &&
          poly.purity >= FAMILY_COMPLETION_LIMITS.polygonPurity,
      )
      .map((poly) => poly.view),
  );
  return {
    direct,
    strict,
    distributed: part.confidence >= 0.9 && direct.length === part.instances && views.size >= 3,
    collective:
      part.confidence >= 0.9 &&
      strict.length >= 1 &&
      direct.length >= Math.max(2, Math.ceil(part.instances / 2)) &&
      views.size >= 3,
  };
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
  if (part.instances < 3 || part.expectedGeometry.kind !== 'repeated_part') return undefined;
  // Fully mapped groups retain their existing admission, but cannot hide a contradictory
  // complete shape class merely because coarse masks provide no single-instance anchors.
  if (initial.length >= part.instances) {
    const start = Date.now(),
      data = signatures(),
      first = required(
        data.signatures.find((s) => s.rank === initial[0]),
        'mapped family signature',
      );
    const ranks: number[] = [];
    let comparisons = 0;
    for (const signature of data.signatures) {
      checkpoint();
      comparisons++;
      if (similarFamilyComponents(first, signature)) ranks.push(signature.rank);
    }
    if (ranks.length !== part.instances || !initial.every((r) => ranks.includes(r)))
      return {
        ranks: [],
        anchors: [],
        propagated: [],
        candidatesConsidered: data.signatures.length,
        comparisons,
        workerMs: Date.now() - start,
        reason: 'Mapped family contradicts the complete equivalent component class',
      };
    return undefined;
  }
  // Independently isolated instance footprints may be distributed across views.
  // This mode never invents an unobserved sibling: every declared member must be directly grounded.
  const distributed =
    part.confidence >= 0.9 &&
    new Set(polygons.map((p) => p.view)).size >= 3 &&
    new Set(
      polygons
        .filter((p) => p.ranks.length === 1 && p.purity >= FAMILY_COMPLETION_LIMITS.polygonPurity)
        .map((p) => p.ranks[0]),
    ).size === part.instances;
  const grounding = familyGrounding(part, scores, polygons);
  const strongAnchors = grounding.strict;
  const start = Date.now(),
    anchors =
      strongAnchors.length >= FAMILY_COMPLETION_LIMITS.minimumAnchors
        ? strongAnchors
        : distributed
          ? grounding.direct
          : grounding.collective
            ? grounding.direct
            : [];
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
  if (
    ranks.length !== part.instances ||
    !anchors.every((r) => ranks.includes(r)) ||
    !initial.every((r) => ranks.includes(r))
  )
    return refuse('No unique complete equivalent component class');
  // Missing observations require a uniquely corroborated whole class, not a best subset.
  // All members must agree mutually: overlapping loose equivalence neighbourhoods are ambiguous.
  let collectiveClass = grounding.collective;
  if (collectiveClass) {
    const members = ranks.map((r) =>
      required(
        data.signatures.find((s) => s.rank === r),
        'class member',
      ),
    );
    for (const member of members)
      for (const signature of data.signatures) {
        checkpoint();
        comparisons++;
        if (similarFamilyComponents(member, signature) !== ranks.includes(signature.rank))
          return refuse('Ambiguous overlapping equivalent component classes');
      }
    for (let axis = 0; axis < 3; axis++) {
      const extent = (rs: readonly number[]): number => {
        const xs = rs.map(
          (r) => required(p.facts[r], 'grounded family center').centroid[axis] ?? 0,
        );
        return Math.max(...xs) - Math.min(...xs);
      };
      const full = extent(ranks);
      if (
        full > first.diagonal * 0.1 &&
        extent(grounding.direct) < full * (1 - FAMILY_COMPLETION_LIMITS.spatialResidual)
      )
        collectiveClass = false;
    }
  }
  const classPurity = (poly: FamilyPolygon): number =>
    poly.support && poly.pixels
      ? poly.support.filter((x) => ranks.includes(x.rank)).reduce((sum, x) => sum + x.pixels, 0) /
        poly.pixels
      : poly.ranks.length === 1 && ranks.includes(poly.ranks[0] ?? -1)
        ? poly.purity
        : 0;
  const grouped =
    part.confidence >= 0.9 &&
    anchors.length >= 2 &&
    new Set(
      polygons
        .filter((p) => classPurity(p) >= FAMILY_COMPLETION_LIMITS.polygonPurity)
        .map((p) => p.view),
    ).size >= 2;
  if (
    !polygons.length ||
    polygons.some(
      (poly) =>
        !poly.ranks.length ||
        poly.ranks.some((r) => !ranks.includes(r)) ||
        classPurity(poly) < FAMILY_COMPLETION_LIMITS.polygonPurity,
    )
  )
    return refuse('Contradictory or ambiguous family polygon');
  if (
    polygons.some(
      (poly, i) =>
        poly.ranks.length === 1 &&
        polygons.some(
          (other, j) =>
            j < i &&
            other.view === poly.view &&
            other.ranks.length === 1 &&
            other.ranks[0] === poly.ranks[0],
        ),
    )
  )
    return refuse('Duplicated direct instance region');
  for (const r of ranks) {
    checkpoint();
    if (
      !polygons.some(
        (poly) =>
          poly.ranks.includes(r) &&
          (poly.ranks.length === 1 || grouped) &&
          classPurity(poly) >= FAMILY_COMPLETION_LIMITS.polygonPurity,
      ) &&
      !collectiveClass
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
    reason: collectiveClass
      ? 'Exact-count isolated spatial class corroborates collectively grounded family observations'
      : distributed
        ? 'Exact equivalent family corroborates distributed direct instance observations'
        : 'Exact isolated equivalent family corroborates omitted instance annotations',
  };
}
