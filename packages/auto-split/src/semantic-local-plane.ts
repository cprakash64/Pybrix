import {
  planeSynthesisTrace,
  PLANE_NORMAL_SOURCES,
  type PlaneSynthesisTrace,
  type PlaneNormalSource,
  type PlaneOffsetSource,
  type PlaneCandidateProvenance,
} from './semantic-synthesis-trace';
import { independentPlanePeer, SEMANTIC_INTENT_LIMITS } from './semantic-intent';
import {
  cameraFor,
  FRAME_FILL,
  VIEW_NAMES,
  type SemanticHierarchy,
  type SemanticPart,
  type Vec3,
} from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import { pointInSemanticPolygon, SEMANTIC_WORK_LIMITS } from './semantic';
import { NO_CHECKPOINT, type Checkpoint } from './checkpoint';
import { resourceLimitExceeded } from '@cadfixer/shared';
import { semanticRoleScope } from './semantic-extent';

export const LOCAL_PLANE_LIMITS = Object.freeze({
  sampleStride: 16,
  normals: 32,
  offsets: 64,
  sectionFaces: 8192,
  finalists: 3,
});
export interface PlaneOwnershipTelemetry {
  workUnits: number;
  observations: number;
  peers: number;
  normals: number;
  offsets: number;
  histogramBins: number;
  scratchBytes: number;
  finalists: number;
  peerScoringPasses: number;
  rankingComparisons: number;
}
export const planeOwnershipTelemetry = (): PlaneOwnershipTelemetry => ({
  workUnits: 0,
  observations: 0,
  peers: 0,
  normals: 0,
  offsets: 0,
  histogramBins: 0,
  scratchBytes: 0,
  finalists: 0,
  peerScoringPasses: 0,
  rankingComparisons: 0,
});
export interface PlaneOwnershipContext {
  readonly telemetry: PlaneOwnershipTelemetry;
  readonly charge: () => void;
  readonly synthesis?: Map<string, PlaneSynthesisTrace>;
}
interface Observation {
  point: Vec3;
  view: number;
  target: boolean;
  rank: number;
  peerMask: number;
}
interface Peer {
  part: SemanticPart;
  exactRanks: readonly number[];
  fused: boolean;
}
interface Evidence {
  points: readonly Observation[];
  peers: readonly Peer[];
  typedBytes: number;
  exactTarget: boolean;
  fusedTarget: boolean;
}
interface Counts {
  selected: number;
  target: number;
  hit: number;
  competing: number;
  shared: number;
  peer: number[];
  peerSelected: number[];
}
interface Score {
  confidence: number;
  recall: number;
  purity: number;
  worstLeakage: number;
  clean: boolean;
  fraction: number;
  rawPurity: number;
  peers: readonly {
    id: string;
    leakage: number;
    exactComponent: boolean;
    views: number;
    independentAxes: number;
    sameSourceComponent: boolean;
  }[];
  views: readonly {
    view: number;
    recall: number;
    exclusion: number;
    rawPurity: number;
    agreement: number;
    semanticPurity: number;
  }[];
}
export interface LocalPlaneProposal {
  readonly provenance?: PlaneCandidateProvenance;
  readonly finalists?: readonly {
    readonly normal: Vec3;
    readonly origin: Vec3;
    readonly independentComplement: boolean;
    readonly capturedFraction: number;
    readonly provenance?: PlaneCandidateProvenance;
  }[];
  readonly cut: { readonly normal: Vec3; readonly origin: Vec3 };
  readonly confidence: number;
  readonly scope: 'part' | 'assembly';
  readonly alignment: 'focused' | 'broad';
  readonly samples: number;
  readonly candidates: number;
  readonly sectionSamples: number;
  readonly capturedFraction: number;
  readonly views: Score['views'];
  readonly ownership: {
    readonly admitted: true;
    readonly rule: 'CLEAN_PHYSICAL_EXTENT' | 'BEST_FEASIBLE_FUSED_ASSEMBLY';
    readonly targetRecall: number;
    readonly semanticPurity: number;
    readonly worstPeerLeakage: number;
    readonly peers: Score['peers'];
    readonly comparableCleanerCandidates: number;
    readonly frontierCandidates: number;
  };
}
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 | undefined => {
  const m = Math.hypot(...a);
  return m > 1e-9 ? [a[0] / m, a[1] / m, a[2] / m] : undefined;
};
const vector = (a: number[]): Vec3 => [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
function mean(points: readonly Vec3[]): Vec3 {
  return vector(
    [0, 1, 2].map((a) => points.reduce((s, p) => s + (p[a] ?? 0), 0) / Math.max(1, points.length)),
  );
}
/** Three Jacobi eigenvectors. Fixed iterations, stable tie order; axes are candidates, not semantic directions. */
function principal(points: readonly Vec3[]): Vec3[] {
  const center = mean(points),
    m = Array.from({ length: 3 }, () => [0, 0, 0]),
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  for (const p of points)
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++)
        defined(m[a])[b] =
          defined(defined(m[a])[b]) +
          (defined(p[a]) - defined(center[a])) * (defined(p[b]) - defined(center[b]));
  for (let pass = 0; pass < 24; pass++) {
    let a = 0,
      b = 1;
    for (const [i, j] of [
      [0, 2],
      [1, 2],
    ])
      if (
        Math.abs(defined(defined(m[defined(i)])[defined(j)])) > Math.abs(defined(defined(m[a])[b]))
      ) {
        a = defined(i);
        b = defined(j);
      }
    if (Math.abs(defined(defined(m[a])[b])) < 1e-10) break;
    const theta =
        0.5 *
        Math.atan2(
          2 * defined(defined(m[a])[b]),
          defined(defined(m[b])[b]) - defined(defined(m[a])[a]),
        ),
      c = Math.cos(theta),
      s = Math.sin(theta);
    const aa = defined(defined(m[a])[a]),
      bb = defined(defined(m[b])[b]),
      ab = defined(defined(m[a])[b]);
    defined(m[a])[a] = c * c * aa - 2 * s * c * ab + s * s * bb;
    defined(m[b])[b] = s * s * aa + 2 * s * c * ab + c * c * bb;
    defined(m[a])[b] = defined(m[b])[a] = 0;
    for (let k = 0; k < 3; k++) {
      if (k !== a && k !== b) {
        const ka = defined(defined(m[k])[a]),
          kb = defined(defined(m[k])[b]);
        defined(m[k])[a] = defined(m[a])[k] = c * ka - s * kb;
        defined(m[k])[b] = defined(m[b])[k] = s * ka + c * kb;
      }
      const va = defined(defined(v[k])[a]),
        vb = defined(defined(v[k])[b]);
      defined(v[k])[a] = c * va - s * vb;
      defined(v[k])[b] = s * va + c * vb;
    }
  }
  return [0, 1, 2]
    .sort((a, b) => defined(defined(m[b])[b]) - defined(defined(m[a])[a]))
    .map((i) => vector(v.map((row) => defined(row[i]))));
}
function ancestor(answer: SemanticHierarchy, parent: string, child: SemanticPart): boolean {
  let id = child.parentId;
  for (let depth = 0; id && depth < 4; depth++) {
    if (id === parent) return true;
    id = answer.parts.find((p) => p.id === id)?.parentId ?? null;
  }
  return false;
}
const physical = (p: SemanticPart): boolean =>
  p.confidence >= SEMANTIC_WORK_LIMITS.semanticConfidence &&
  p.expectedGeometry.kind !== 'surface_part' &&
  (p.expectedGeometry.kind !== 'unknown' || p.importance === 'major');
function observations(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  part: SemanticPart,
  checkpoint: Checkpoint,
  context?: PlaneOwnershipContext,
): Evidence {
  const charge = (): void => {
    if (context) {
      context.telemetry.workUnits++;
      context.charge();
    }
  };
  const peers = answer.parts.filter(
    (p) => p.id !== part.id && physical(p) && !ancestor(answer, p.id, part),
  );
  const result: Observation[] = [];
  const counts = peers.map(() => new Uint32Array(6));
  const shared = peers.map(() => new Uint32Array(6));
  const target = new Uint32Array(6);
  const ranks = prepared.metadata.components.length;
  const rankTotals = new Uint32Array(6 * ranks);
  const rankTarget = new Uint32Array(6 * ranks);
  const rankPeers = new Uint32Array(6 * ranks * peers.length);
  for (const [vi, view] of VIEW_NAMES.entries()) {
    const region = part.views.find((v) => v.view === view);
    const peerRegions = peers.map((p) => p.views.find((v) => v.view === view));
    if (!region && !peerRegions.some(Boolean)) continue;
    const raster = defined(prepared.rasters[vi]),
      camera = cameraFor(view),
      k = (raster.size * FRAME_FILL) / (2 * prepared.geometry.radius);
    for (let y = 8; y < raster.size; y += LOCAL_PLANE_LIMITS.sampleStride) {
      checkpoint();
      for (let x = 8; x < raster.size; x += LOCAL_PLANE_LIMITS.sampleStride) {
        charge();
        const f = raster.face[y * raster.size + x] ?? -1,
          depth = raster.depth?.[y * raster.size + x];
        if (f < 0 || depth === undefined || !Number.isFinite(depth)) continue;
        const nx = (x + 0.5) / raster.size,
          ny = (y + 0.5) / raster.size,
          u = (x + 0.5 - raster.size / 2) / k,
          w = -(y + 0.5 - raster.size / 2) / k,
          hit = region?.polygons.some((poly) => pointInSemanticPolygon(nx, ny, poly)) ?? false,
          rank = prepared.labelling.faceRank[f] ?? -1,
          base = vi * ranks + rank;
        if (rank >= 0 && rank < ranks) {
          rankTotals[base] = (rankTotals[base] ?? 0) + 1;
          if (hit) rankTarget[base] = (rankTarget[base] ?? 0) + 1;
        }
        if (hit) target[vi] = (target[vi] ?? 0) + 1;
        let mask = 0;
        for (const [i, peer] of peerRegions.entries()) {
          charge();
          if (peer?.polygons.some((poly) => pointInSemanticPolygon(nx, ny, poly))) {
            mask |= 1 << i;
            const row = defined(counts[i]);
            row[vi] = (row[vi] ?? 0) + 1;
            if (hit) {
              const row = defined(shared[i]);
              row[vi] = (row[vi] ?? 0) + 1;
            }
            if (rank >= 0 && rank < ranks) {
              const index = base * peers.length + i;
              rankPeers[index] = (rankPeers[index] ?? 0) + 1;
            }
          }
        }
        result.push({
          point: vector(
            [0, 1, 2].map(
              (a) =>
                defined(camera.right[a]) * u +
                defined(camera.up[a]) * w +
                defined(camera.forward[a]) * depth,
            ),
          ),
          view: vi,
          target: hit,
          rank,
          peerMask: mask,
        });
      }
    }
  }
  const dominant = prepared.facts.findIndex((f) => f.areaShare >= 0.5);
  // Opposite views on one axis can both be occluded by a terminal region. They
  // cannot prove that region is the whole component and suppress plane synthesis.
  // This stronger prefilter witness does not change any plane-admission gate.
  const rankGrounded = (rank: number, owner: (vi: number) => number): boolean =>
    new Set(
      VIEW_NAMES.flatMap((_v, vi) => {
        checkpoint();
        return owner(vi) >= 8 && owner(vi) / Math.max(1, rankTotals[vi * ranks + rank] ?? 0) >= 0.82
          ? [Math.floor(vi / 2)]
          : [];
      }),
    ).size >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews;
  const targetOnDominant =
    VIEW_NAMES.filter((_v, vi) => {
      const n = target[vi] ?? 0;
      return n >= 8 && (rankTarget[vi * ranks + dominant] ?? 0) / n >= 0.82;
    }).length >= 2;
  let groundedMask = 0;
  const grounded: Peer[] = [];
  for (const [i, peer] of peers.entries()) {
    checkpoint();
    charge();
    const row = defined(counts[i]),
      joint = defined(shared[i]);
    if ([...row].filter((n) => n >= 8).length < 2) continue;
    const inclusive =
      semanticRoleScope(part, answer) === 'WHOLE_ASSEMBLY' &&
      ancestor(answer, part.id, peer) &&
      VIEW_NAMES.filter(
        (_v, vi) =>
          (row[vi] ?? 0) >= 8 &&
          (joint[vi] ?? 0) / Math.max(1, row[vi] ?? 0) >= 0.9 &&
          (target[vi] ?? 0) / Math.max(1, result.filter((p) => p.view === vi).length) >= 0.9,
      ).length >= 2;
    if (inclusive) continue;
    const exactRanks: number[] = [];
    for (let rank = 0; rank < ranks; rank++) {
      charge();
      if (
        VIEW_NAMES.filter(
          (view, vi) =>
            part.views.some((v) => v.view === view) &&
            (rankTotals[vi * ranks + rank] ?? 0) >= 8 &&
            (rankPeers[(vi * ranks + rank) * peers.length + i] ?? 0) /
              Math.max(1, rankTotals[vi * ranks + rank] ?? 0) >=
              0.82 &&
            (rankTarget[vi * ranks + rank] ?? 0) /
              Math.max(1, rankTotals[vi * ranks + rank] ?? 0) <=
              0.1,
        ).length >= 2
      )
        exactRanks.push(rank);
    }
    const fused =
      dominant >= 0 &&
      targetOnDominant &&
      exactRanks.length === 0 &&
      VIEW_NAMES.filter(
        (_v, vi) =>
          (row[vi] ?? 0) >= 8 &&
          (rankPeers[(vi * ranks + dominant) * peers.length + i] ?? 0) /
            Math.max(1, row[vi] ?? 0) >=
            0.82,
      ).length >= 2;
    groundedMask |= 1 << i;
    grounded.push({ part: peer, exactRanks, fused });
  }
  // Compact the original <=24-bit memberships once; neither missing nor occluded views fabricate ownership.
  for (const [index, p] of result.entries()) {
    if ((index & 1023) === 0) checkpoint();
    let compact = 0,
      j = 0;
    for (let i = 0; i < peers.length; i++)
      if (groundedMask & (1 << i)) {
        charge();
        if (p.peerMask & (1 << i)) compact |= 1 << j;
        j++;
      }
    p.peerMask = compact;
  }
  const exactRanks = Array.from({ length: ranks }, (_x, rank) => rank).filter((rank) =>
    rankGrounded(rank, (vi) => rankTarget[vi * ranks + rank] ?? 0),
  );
  const exactShare = exactRanks.reduce(
    (sum, rank) => sum + (prepared.facts[rank]?.areaShare ?? 0),
    0,
  );
  const targetCount = result.filter((p) => p.target).length;
  const exactTarget =
    exactShare > 0 &&
    // Without a second grounded physical role, a near-whole component is not a semantic boundary.
    (exactShare < 0.995 || grounded.length === 0) &&
    result.filter((p) => p.target && exactRanks.includes(p.rank)).length /
      Math.max(1, targetCount) >=
      0.72;
  const typedBytes =
    rankTotals.byteLength +
    rankTarget.byteLength +
    rankPeers.byteLength +
    target.byteLength +
    peers.length * 6 * 8;
  if (context) {
    const t = context.telemetry;
    t.observations += result.length;
    t.peers = Math.max(t.peers, grounded.length);
    t.scratchBytes = Math.max(
      t.scratchBytes,
      rankTotals.byteLength +
        rankTarget.byteLength +
        rankPeers.byteLength +
        target.byteLength +
        peers.length * 6 * 8,
    );
  }
  return {
    points: result,
    peers: grounded,
    typedBytes,
    exactTarget,
    fusedTarget: dominant >= 0 && targetOnDominant,
  };
}
const robustHigh = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[1] ?? 0;
};
const robustLow = (values: readonly number[]): number => 1 - robustHigh(values.map((v) => 1 - v));
const emptyCounts = (peers: number): Counts[] =>
  Array.from({ length: 6 }, () => ({
    selected: 0,
    target: 0,
    hit: 0,
    competing: 0,
    shared: 0,
    peer: Array<number>(peers).fill(0),
    peerSelected: Array<number>(peers).fill(0),
  }));
function evaluate(
  evidence: Evidence,
  counts: readonly Counts[],
  context?: PlaneOwnershipContext,
  checkpoint: Checkpoint = NO_CHECKPOINT,
  trace?: PlaneSynthesisTrace,
): Score | undefined {
  const charge = (): void => {
    if (context) {
      context.telemetry.workUnits++;
      context.charge();
    }
  };
  const selected = counts.reduce((n, c) => n + c.selected, 0),
    fraction = selected / Math.max(1, evidence.points.length);
  if (fraction <= 0.02 || fraction >= 0.98) {
    if (trace) trace.scoreRefusals.balance++;
    return undefined;
  }
  const targetViews = counts.flatMap((r, view) =>
    r.target >= 8 && r.selected >= 8
      ? [
          {
            view,
            recall: r.hit / r.target,
            exclusion: 1,
            rawPurity: r.hit / r.selected,
            agreement: 0,
            semanticPurity: (r.hit - r.shared) / Math.max(1, r.hit + r.competing - r.shared),
          },
        ]
      : [],
  );
  if (targetViews.length < 2) {
    if (trace) trace.scoreRefusals.views++;
    return undefined;
  }
  if (
    targetViews.filter((v) => v.recall >= 0.9).length < 2 ||
    targetViews.some((v) => v.recall < 0.65)
  ) {
    if (trace) trace.scoreRefusals.viewRecall++;
    return undefined;
  }
  const recall = targetViews.reduce((n, v) => n + v.recall, 0) / targetViews.length;
  if (recall < 0.9) {
    if (trace) trace.scoreRefusals.meanRecall++;
    return undefined;
  }
  const peers = evidence.peers.map((peer, i) => {
    if (context) context.telemetry.peerScoringPasses++;
    checkpoint();
    const leakage: number[] = [];
    const axes = new Set<number>();
    for (const [view, row] of counts.entries()) {
      charge();
      if ((row.peer[i] ?? 0) >= 8) {
        leakage.push((row.peerSelected[i] ?? 0) / defined(row.peer[i]));
        axes.add(Math.floor(view / 2));
      }
    }
    return {
      id: peer.part.id,
      leakage: robustHigh(leakage),
      exactComponent: peer.exactRanks.length > 0,
      views: leakage.length,
      independentAxes: axes.size,
      sameSourceComponent: peer.fused,
    };
  });
  for (const view of targetViews) {
    const row = defined(counts[view.view]);
    const leak = Math.max(
      0,
      ...row.peer.map((total, i) => (total >= 8 ? (row.peerSelected[i] ?? 0) / total : 0)),
    );
    view.exclusion = 1 - leak;
    view.agreement = Math.min(view.recall, view.exclusion);
  }
  const worstLeakage = Math.max(0, ...peers.map((p) => p.leakage));
  const purityViews = counts
    .filter((r) => r.target >= 8 && r.hit + r.competing - r.shared >= 8)
    .map((r) => (r.hit - r.shared) / Math.max(1, r.hit + r.competing - r.shared));
  const purity = robustLow(purityViews);
  return {
    confidence: Math.min(recall, 1 - worstLeakage),
    recall,
    purity,
    worstLeakage,
    clean: purity >= 0.9 && worstLeakage <= 0.1,
    fraction,
    rawPurity: targetViews.reduce((n, v) => n + v.rawPurity, 0) / targetViews.length,
    peers,
    views: targetViews,
  };
}
function directScore(
  evidence: Evidence,
  normal: Vec3,
  offset: number,
  checkpoint: Checkpoint,
  context?: PlaneOwnershipContext,
): Score | undefined {
  const rows = emptyCounts(evidence.peers.length);
  for (const [i, p] of evidence.points.entries()) {
    if ((i & 1023) === 0) checkpoint();
    if (context) {
      context.telemetry.workUnits++;
      context.charge();
    }
    const row = defined(rows[p.view]),
      inside = dot(p.point, normal) >= offset;
    if (p.target) row.target++;
    if (inside) {
      row.selected++;
      if (p.target) row.hit++;
      if (p.peerMask) {
        row.competing++;
        if (p.target) row.shared++;
      }
    }
    for (let j = 0; j < evidence.peers.length; j++)
      if (p.peerMask & (1 << j)) {
        row.peer[j] = (row.peer[j] ?? 0) + 1;
        if (inside) row.peerSelected[j] = (row.peerSelected[j] ?? 0) + 1;
      }
  }
  return evaluate(evidence, rows, context, checkpoint);
}
interface Candidate {
  normalSourceMask?: number;
  offsetSource?: PlaneOffsetSource;
  normal: Vec3;
  offset: number;
  score: Score;
  section: number;
}
function semanticOrder(a: Candidate, b: Candidate): number {
  return (
    Number(!a.score.clean) - Number(!b.score.clean) ||
    (!a.score.clean && !b.score.clean ? a.score.worstLeakage - b.score.worstLeakage : 0) ||
    b.score.recall - a.score.recall ||
    b.score.purity - a.score.purity ||
    a.score.worstLeakage - b.score.worstLeakage ||
    a.score.fraction - b.score.fraction ||
    a.section - b.section ||
    a.normal[0] - b.normal[0] ||
    a.normal[1] - b.normal[1] ||
    a.normal[2] - b.normal[2] ||
    a.offset - b.offset
  );
}
/** The frontier, fused source support and structured geometry must all corroborate approximation. */
function assemblyBaseEligible(
  evidence: Evidence,
  answer: SemanticHierarchy,
  part: SemanticPart,
  candidate: Candidate,
): boolean {
  const s = candidate.score;
  if (s.clean) return true;
  if (
    part.confidence < 0.9 ||
    answer.object.confidence < SEMANTIC_WORK_LIMITS.semanticConfidence ||
    part.expectedGeometry.likelySeparable ||
    !evidence.fusedTarget ||
    evidence.exactTarget ||
    s.recall < 0.95 ||
    s.views.some((v) => v.recall < 0.9) ||
    s.purity < SEMANTIC_WORK_LIMITS.planePurity
  )
    return false;
  if (!s.peers.some((p) => p.views >= 2 && p.leakage <= 0.1)) return false;
  for (const [i, peer] of evidence.peers.entries()) {
    const metric = defined(s.peers[i]);
    if (
      metric.leakage > 0.1 &&
      (metric.exactComponent || !peer.fused || peer.part.expectedGeometry.likelySeparable)
    )
      return false;
  }
  return true;
}
function cleanerAlternative(
  evidence: Evidence,
  answer: SemanticHierarchy,
  part: SemanticPart,
  candidate: Candidate,
  other: Candidate,
): boolean {
  const s = candidate.score;
  return (
    !s.clean &&
    other !== candidate &&
    assemblyBaseEligible(evidence, answer, part, other) &&
    other.score.recall >= s.recall - 0.02 &&
    (other.score.clean ||
      (other.score.purity >= s.purity + 0.1 && other.score.worstLeakage <= s.worstLeakage + 1e-9) ||
      (other.score.worstLeakage <= s.worstLeakage - 0.1 && other.score.purity >= s.purity - 0.02))
  );
}
function assemblyEligible(
  evidence: Evidence,
  answer: SemanticHierarchy,
  part: SemanticPart,
  candidate: Candidate,
  candidates: readonly Candidate[],
  checkpoint: Checkpoint = NO_CHECKPOINT,
  charge: () => void = NO_CHECKPOINT,
): boolean {
  if (!assemblyBaseEligible(evidence, answer, part, candidate)) return false;
  if (candidate.score.clean) return true;
  return !candidates.some((other, i) => {
    charge();
    if ((i & 255) === 0) checkpoint();
    return cleanerAlternative(evidence, answer, part, candidate, other);
  });
}

function proposal(
  candidate: Candidate,
  evidence: Evidence,
  part: SemanticPart,
  candidates: readonly Candidate[],
  answer: SemanticHierarchy,
  checkpoint: Checkpoint,
  charge: () => void,
): LocalPlaneProposal {
  const score = candidate.score,
    assembly =
      !score.clean ||
      (evidence.fusedTarget && !part.expectedGeometry.likelySeparable && score.rawPurity < 0.9);
  const anchor = Math.min(1, ...score.peers.filter((p) => p.views >= 2).map((p) => p.leakage));
  return {
    ...(candidate.offsetSource
      ? {
          provenance: {
            normalSources: PLANE_NORMAL_SOURCES.filter(
              (_s, i) => (candidate.normalSourceMask ?? 0) & (1 << i),
            ),
            offsetSource: candidate.offsetSource,
            refined: false,
          },
        }
      : {}),
    cut: {
      normal: candidate.normal,
      origin: vector(candidate.normal.map((n) => n * candidate.offset)),
    },
    confidence: score.clean ? score.confidence : Math.min(score.recall, score.purity, 1 - anchor),
    scope: assembly ? 'assembly' : 'part',
    alignment: score.rawPurity >= SEMANTIC_WORK_LIMITS.planePurity ? 'focused' : 'broad',
    samples: evidence.points.length,
    candidates: candidates.length,
    sectionSamples: candidate.section,
    capturedFraction: score.fraction,
    views: score.views,
    ownership: {
      admitted: true,
      rule: score.clean ? 'CLEAN_PHYSICAL_EXTENT' : 'BEST_FEASIBLE_FUSED_ASSEMBLY',
      targetRecall: score.recall,
      semanticPurity: score.purity,
      worstPeerLeakage: score.worstLeakage,
      peers: score.peers,
      comparableCleanerCandidates: candidates.filter((c, i) => {
        charge();
        if ((i & 255) === 0) checkpoint();
        return cleanerAlternative(evidence, answer, part, candidate, c);
      }).length,
      frontierCandidates: candidates.filter((c) => c.score.recall >= score.recall - 0.02).length,
    },
  };
}
function boundedContext(context?: PlaneOwnershipContext): PlaneOwnershipContext {
  let work = 0;
  return (
    context ?? {
      telemetry: planeOwnershipTelemetry(),
      charge: (): void => {
        if (++work > SEMANTIC_WORK_LIMITS.regionPixels)
          throw resourceLimitExceeded('The semantic regions exceed the supported work limit.');
      },
    }
  );
}
/** Read-only bounded projection. Histograms retain EVERY grounded peer, including fused peers. */
export function synthesizeSemanticPlane(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  part: SemanticPart,
  checkpoint: Checkpoint,
  context?: PlaneOwnershipContext,
): LocalPlaneProposal | undefined {
  context = boundedContext(context);
  const trace = planeSynthesisTrace();
  context.synthesis?.set(part.id, trace);
  trace.inputRefusal =
    part.importance !== 'major'
      ? 'NOT_MAJOR'
      : part.instances !== 1
        ? 'MULTIPLE_INSTANCES'
        : part.expectedGeometry.kind === 'surface_part'
          ? 'SURFACE_ONLY'
          : part.views.length < 2
            ? 'INSUFFICIENT_VIEWS'
            : Math.min(answer.object.confidence, part.confidence) <
                SEMANTIC_WORK_LIMITS.semanticConfidence
              ? 'SEMANTIC_CONFIDENCE'
              : null;
  if (trace.inputRefusal) return undefined;
  const evidence = observations(prepared, answer, part, checkpoint, context),
    points = evidence.points;
  const target: Vec3[] = [];
  trace.views = VIEW_NAMES.map((_v, view) => ({ view, foreground: 0, target: 0 }));
  // Collect compact counts while extracting the existing target samples.
  for (const [i, p] of points.entries()) {
    if ((i & 1023) === 0) checkpoint();
    const row = defined(trace.views[p.view]);
    row.foreground++;
    if (p.target) {
      target.push(p.point);
      row.target++;
    }
  }
  trace.foregroundSamples = points.length;
  trace.targetSamples = target.length;
  trace.exactTarget = evidence.exactTarget;
  trace.phase =
    target.length < 32 || target.length / Math.max(1, points.length) >= 0.995
      ? 'TARGET_SAMPLES_REFUSED'
      : 'EXACT_COMPONENT_WITNESS';
  if (
    target.length < 32 ||
    target.length / Math.max(1, points.length) >= 0.995 ||
    evidence.exactTarget
  )
    return undefined;
  const charge = (): void => {
    context.telemetry.workUnits++;
    context.charge();
  };
  const normals: Vec3[] = [];
  const normalMasks: number[] = [];
  const add = (raw: Vec3, source: PlaneNormalSource = 'CANONICAL_AXES_AND_DIAGONALS'): void => {
    const n = unit(raw);
    trace.normalAttempts++;
    if (!n) {
      trace.normalRefusals.degenerate++;
      return;
    }
    const mask = 1 << PLANE_NORMAL_SOURCES.indexOf(source);
    const parallel = normals.findIndex((x) => Math.abs(dot(x, n)) > 0.999);
    if (parallel >= 0) {
      trace.normalRefusals.parallel++;
      normalMasks[parallel] = (normalMasks[parallel] ?? 0) | mask;
    } else if (normals.length >= LOCAL_PLANE_LIMITS.normals) trace.normalRefusals.cap++;
    else {
      normals.push(n);
      normalMasks.push(mask);
    }
  };
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) add([x, y, z]);
  for (const n of principal(target)) add(n, 'TARGET_PCA');
  for (const n of principal(points.map((p) => p.point))) add(n, 'MODEL_PCA');
  const center = mean(target);
  for (let i = 0; i < evidence.peers.length; i++) {
    checkpoint();
    const peer = mean(points.filter((p) => p.peerMask & (1 << i)).map((p) => p.point));
    add(vector(center.map((v, a) => v - defined(peer[a]))), 'PEER_DIRECTION');
  }
  if (part.cut) add(part.cut.normal, 'PROVIDER_HINT');
  trace.normalCandidates = normals.map((normal, i) => ({
    normal,
    sources: PLANE_NORMAL_SOURCES.filter((_s, j) => (normalMasks[i] ?? 0) & (1 << j)),
  }));
  trace.phase = 'NO_ELIGIBLE_CANDIDATE';
  const candidates: Candidate[] = [],
    bins = LOCAL_PLANE_LIMITS.offsets,
    channels = 5 + evidence.peers.length;
  for (const [normalIndex, normal] of normals.entries()) {
    checkpoint();
    context.telemetry.normals++;
    const projected = new Float64Array(points.length),
      heads = new Int32Array(bins).fill(-1),
      next = new Int32Array(points.length).fill(-1);
    let lo = Infinity,
      hi = -Infinity,
      targetLo = Infinity,
      targetHi = -Infinity;
    const peerLo = new Float64Array(evidence.peers.length).fill(Infinity),
      peerHi = new Float64Array(evidence.peers.length).fill(-Infinity);
    for (const [i, p] of points.entries()) {
      if ((i & 1023) === 0) checkpoint();
      charge();
      const d = dot(p.point, normal);
      projected[i] = d;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
      if (p.target) {
        targetLo = Math.min(targetLo, d);
        targetHi = Math.max(targetHi, d);
      }
      for (let j = 0; j < evidence.peers.length; j++)
        if (p.peerMask & (1 << j)) {
          charge();
          peerLo[j] = Math.min(peerLo[j] ?? Infinity, d);
          peerHi[j] = Math.max(peerHi[j] ?? -Infinity, d);
        }
    }
    if (hi - lo < 1e-9) continue;
    const hist = new Uint32Array(6 * channels * bins),
      prefix = new Uint32Array(6 * channels * (bins + 1));
    const slot = (view: number, channel: number, bin: number): number =>
      (view * channels + channel) * bins + bin;
    const increment = (p: Observation, action: (channel: number) => void): void => {
      action(0);
      if (p.target) action(1);
      if (p.peerMask) {
        action(2);
        if (p.target) action(3);
      }
      if (!p.target && !p.peerMask) action(4);
      for (let j = 0; j < evidence.peers.length; j++)
        if (p.peerMask & (1 << j)) {
          charge();
          action(5 + j);
        }
    };
    for (const [i, p] of points.entries()) {
      if ((i & 1023) === 0) checkpoint();
      charge();
      const bin = Math.min(bins - 1, Math.floor(((defined(projected[i]) - lo) / (hi - lo)) * bins));
      next[i] = heads[bin] ?? -1;
      heads[bin] = i;
      increment(p, (channel) => {
        const index = slot(p.view, channel, bin);
        hist[index] = (hist[index] ?? 0) + 1;
      });
    }
    for (let v = 0; v < 6; v++)
      for (let c = 0; c < channels; c++) {
        checkpoint();
        let sum = 0;
        for (let bin = 0; bin < bins; bin++) {
          charge();
          sum += hist[slot(v, c, bin)] ?? 0;
          prefix[(v * channels + c) * (bins + 1) + bin + 1] = sum;
        }
      }
    const offsetSources: PlaneOffsetSource[] = [];
    const offsets: number[] = [],
      epsilon = (hi - lo) * 1e-8;
    const offset = (d: number, source: PlaneOffsetSource = 'SEMANTIC_TRANSITION'): void => {
      if (
        Number.isFinite(d) &&
        offsets.length < bins &&
        !offsets.some((x) => Math.abs(x - d) < epsilon)
      ) {
        offsets.push(d);
        offsetSources.push(source);
        trace.offsetCandidates++;
        trace.offsetSources[source]++;
      }
    };
    // Semantic starts/ends and nearest peer transitions precede any geometric preference.
    offset(targetLo - epsilon, 'TARGET_MIN');
    offset(targetHi + epsilon, 'TARGET_MAX');
    for (let j = 0; j < evidence.peers.length; j++) {
      checkpoint();
      const a = defined(peerLo[j]),
        b = defined(peerHi[j]);
      if ((a + b) / 2 < (targetLo + targetHi) / 2) offset((targetLo + b) / 2, 'PEER_INTERVAL');
      else offset((targetHi + a) / 2, 'PEER_INTERVAL');
    }
    if (
      part.cut &&
      Math.abs(dot(part.cut.normal, normal)) / Math.max(1e-9, Math.hypot(...part.cut.normal)) >
        0.999
    )
      offset(dot(part.cut.origin, normal), 'PROVIDER_HINT');
    const aggregate = (channel: number, bin: number): number =>
      VIEW_NAMES.reduce((sum, _view, vi) => sum + (hist[slot(vi, channel, bin)] ?? 0), 0);
    for (let bin = 1; bin < bins; bin++) {
      charge();
      const ta = aggregate(1, bin - 1),
        tb = aggregate(1, bin),
        pa = aggregate(2, bin - 1),
        pb = aggregate(2, bin);
      const before = ta / (ta + pa || 1),
        after = tb / (tb + pb || 1);
      if (
        (ta === 0) !== (tb === 0) ||
        (pa === 0) !== (pb === 0) ||
        Math.abs(before - after) >= 0.15
      )
        offset(lo + ((hi - lo) * bin) / bins);
    }

    const t = context.telemetry;
    t.histogramBins = Math.max(t.histogramBins, bins);
    t.scratchBytes = Math.max(
      t.scratchBytes,
      hist.byteLength +
        prefix.byteLength +
        projected.byteLength +
        heads.byteLength +
        next.byteLength +
        peerLo.byteLength +
        peerHi.byteLength +
        evidence.typedBytes +
        6 * channels * Uint32Array.BYTES_PER_ELEMENT,
    );

    for (const [offsetIndex, d] of offsets.entries()) {
      checkpoint();
      const bin = Math.min(bins - 1, Math.max(0, Math.floor(((d - lo) / (hi - lo)) * bins))),
        below = new Uint32Array(6 * channels);
      for (let v = 0; v < 6; v++)
        for (let c = 0; c < channels; c++) {
          charge();
          below[v * channels + c] = prefix[(v * channels + c) * (bins + 1) + bin] ?? 0;
        }
      // Coarse-to-fine: only resolve samples in the boundary bin, never source faces × peers × offsets.
      for (let i = heads[bin] ?? -1; i >= 0; i = next[i] ?? -1) {
        charge();
        if ((i & 1023) === 0) checkpoint();
        const p = defined(points[i]);
        if (defined(projected[i]) < d)
          increment(p, (c) => {
            const index = p.view * channels + c;
            below[index] = (below[index] ?? 0) + 1;
          });
      }
      for (const side of [1, -1]) {
        context.telemetry.offsets++;
        trace.orientedOffsets++;
        const rows = emptyCounts(evidence.peers.length);
        for (let v = 0; v < 6; v++) {
          const row = defined(rows[v]);
          const all = (c: number): number => prefix[(v * channels + c) * (bins + 1) + bins] ?? 0;
          const selected = (c: number): number =>
            side === 1 ? all(c) - (below[v * channels + c] ?? 0) : (below[v * channels + c] ?? 0);
          row.selected = selected(0);
          row.target = all(1);
          row.hit = selected(1);
          row.competing = selected(2);
          row.shared = selected(3);
          for (let j = 0; j < evidence.peers.length; j++) {
            charge();
            row.peer[j] = all(5 + j);
            row.peerSelected[j] = selected(5 + j);
          }
        }
        const score = evaluate(evidence, rows, context, checkpoint, trace);
        if (score)
          candidates.push({
            normalSourceMask: defined(normalMasks[normalIndex]),
            offsetSource: defined(offsetSources[offsetIndex]),
            normal: vector(normal.map((n) => n * side)),
            offset: d * side,
            score,
            section: 0,
          });
      }
    }
  }
  checkpoint();
  candidates.sort((a, b) => {
    context.telemetry.rankingComparisons++;
    checkpoint();
    charge();
    return semanticOrder(a, b);
  });
  const eligible = candidates.filter((c) => {
    checkpoint();
    return assemblyEligible(evidence, answer, part, c, candidates, checkpoint, charge);
  });
  trace.scoredCandidates = candidates.length;
  trace.ownershipEligible = eligible.length;
  trace.phase = eligible.length ? 'NO_CONFIRMED_FINALIST' : 'NO_ELIGIBLE_CANDIDATE';
  const beam: Candidate[] = [];
  for (const c of eligible) {
    checkpoint();
    if (!beam.some((b) => dot(b.normal, c.normal) > 0.999 && Math.abs(b.offset - c.offset) < 1e-7))
      beam.push(c);
    if (beam.length >= LOCAL_PLANE_LIMITS.finalists) break;
  }
  trace.beam = beam.length;
  const stride = Math.max(
    1,
    Math.ceil(prepared.geometry.faceCount / LOCAL_PLANE_LIMITS.sectionFaces),
  );
  const confirmed: Candidate[] = [];
  for (const c of beam) {
    checkpoint();
    const score = directScore(evidence, c.normal, c.offset, checkpoint, context);
    if (
      !score ||
      !assemblyEligible(evidence, answer, part, { ...c, score }, candidates, checkpoint, charge)
    )
      continue;
    c.score = score;
    context.telemetry.finalists++;
    for (let f = 0; f < prepared.geometry.faceCount; f += stride) {
      if (f % (stride * 256) === 0) checkpoint();
      charge();
      let low = Infinity,
        high = -Infinity;
      for (let k = 0; k < 3; k++) {
        const i = (prepared.geometry.indices[f * 3 + k] ?? 0) * 3,
          d =
            dot(
              [
                prepared.geometry.positions[i] ?? 0,
                prepared.geometry.positions[i + 1] ?? 0,
                prepared.geometry.positions[i + 2] ?? 0,
              ],
              c.normal,
            ) - c.offset;
        low = Math.min(low, d);
        high = Math.max(high, d);
      }
      if (low < 0 && high > 0) c.section++;
    }
    confirmed.push(c);
  }
  checkpoint();
  confirmed.sort((a, b) => {
    context.telemetry.rankingComparisons++;
    checkpoint();
    charge();
    return semanticOrder(a, b);
  });
  trace.confirmed = confirmed.length;
  const winner = confirmed[0];
  if (winner) trace.phase = 'PROPOSAL';
  return winner
    ? {
        ...proposal(winner, evidence, part, candidates, answer, checkpoint, charge),
        finalists: confirmed.map((c) => ({
          normal: c.normal,
          origin: vector(c.normal.map((n) => n * c.offset)),
          independentComplement: c.score.peers.some(
            (peer) =>
              peer.views >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews &&
              peer.leakage <= SEMANTIC_INTENT_LIMITS.maximumOppositePeerLeakage &&
              independentPlanePeer(part, peer.id, answer, peer, checkpoint),
          ),
          capturedFraction: c.score.fraction,
          provenance: {
            normalSources: PLANE_NORMAL_SOURCES.filter(
              (_s, i) => (c.normalSourceMask ?? 0) & (1 << i),
            ),
            offsetSource: c.offsetSource ?? 'SEMANTIC_TRANSITION',
            refined: false,
          },
        })),
      }
    : undefined;
}
/** A geometric refinement never bypasses ownership or its previously established search frontier. */
export function confirmSemanticPlane(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  part: SemanticPart,
  cut: NonNullable<SemanticPart['cut']>,
  previous: LocalPlaneProposal,
  checkpoint: Checkpoint,
  context?: PlaneOwnershipContext,
): LocalPlaneProposal | undefined {
  context = boundedContext(context);
  // Local synthesis may set a derived separability flag. Aggregate intent must use the raw semantics.
  part = answer.parts.find((p) => p.id === part.id) ?? part;
  const normal = unit(cut.normal);
  if (!normal) return undefined;
  const evidence = observations(prepared, answer, part, checkpoint, context),
    offset = dot(cut.origin, normal),
    score = directScore(evidence, normal, offset, checkpoint, context);
  if (!score) return undefined;
  const candidate = { normal, offset, score, section: previous.sectionSamples };
  if (!score.clean) {
    if (
      previous.ownership.rule !== 'BEST_FEASIBLE_FUSED_ASSEMBLY' ||
      !assemblyEligible(evidence, answer, part, candidate, []) ||
      score.recall < previous.ownership.targetRecall - 1e-9 ||
      score.purity < previous.ownership.semanticPurity - 1e-9 ||
      score.worstLeakage > previous.ownership.worstPeerLeakage + 1e-9
    )
      return undefined;
  }
  checkpoint();
  const result = proposal(candidate, evidence, part, [], answer, checkpoint, (): void => {
    context.telemetry.workUnits++;
    context.charge();
  });
  return {
    ...result,
    ...(previous.provenance
      ? {
          provenance: {
            ...previous.provenance,
            refined: Math.abs(dot(previous.cut.origin, normal) - offset) > 1e-8,
          },
        }
      : {}),
    ...(previous.finalists ? { finalists: previous.finalists } : {}),
    candidates: previous.candidates,
    ownership: { ...result.ownership, frontierCandidates: previous.ownership.frontierCandidates },
  };
}
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Required bounded geometry evidence is missing.');
  return value;
}
