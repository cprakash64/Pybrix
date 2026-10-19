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
import {
  PEERLESS_SCOPE_LIMITS,
  peerlessScopeProjection,
  collectPeerlessScopeEnvelope,
  peerlessScopeForCut,
  type PeerlessScopeEvidence,
} from './semantic-peerless-scope';
import { refineSemanticPlanes, type SemanticPlaneRefinement } from './semantic-plane';
import { structuralSeamEvidence } from './semantic-seam';
import { probePeerlessSections } from './semantic-peerless-frontier';
export const LOCAL_PLANE_LIMITS = Object.freeze({
  sampleStride: 16,
  normals: 32,
  offsets: 64,
  sectionFaces: 8192,
  finalists: 3,
  compatibilityReserve: 6,
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
  compatibilityReserveChecks: number;
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
  compatibilityReserveChecks: 0,
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
  scopeOverhangWitness?: boolean;
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
  readonly targetScope?: PeerlessScopeEvidence;
  readonly peerlessRefinement?: SemanticPlaneRefinement;
  readonly provenance?: PlaneCandidateProvenance;
  /** Compact ordinary-supported normal diversity, used only by complementary reconciliation. */
  readonly compatibilityReserve?: LocalPlaneProposal['finalists'];
  readonly finalists?: readonly {
    readonly normal: Vec3;
    readonly origin: Vec3;
    readonly independentComplement: boolean;
    readonly capturedFraction: number;
    readonly provenance?: PlaneCandidateProvenance;
    readonly support?: number;
  }[];
  readonly cut: {
    readonly normal: Vec3;
    readonly origin: Vec3;
  };
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
  targetScope?: PeerlessScopeEvidence;
  structuralHint?: number;
  localization?: number;
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
    ...(candidate.targetScope ? { targetScope: candidate.targetScope } : {}),
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
  const modelAxes = principal(points.map((p) => p.point));
  for (const n of principal(target)) add(n, 'TARGET_PCA');
  for (const n of modelAxes) add(n, 'MODEL_PCA');
  if (evidence.peers.length === 0) {
    trace.peerless = {
      scopeMilliseconds: 0,
      structuralMilliseconds: 0,
      refinementMilliseconds: 0,
      supported: 0,
      ambiguous: 0,
      overbroad: 0,
      frontier: [],
      refinements: 0,
      triangleVisits: 0,
      phase: 'COLLECT_SCOPE',
      scratchBytes: points.length * 40 + 8192,
    };
    const scopeStart = Date.now();
    const envelope = collectPeerlessScopeEnvelope(points, modelAxes, checkpoint, charge);
    trace.peerless.targetEnvelope = envelope.bounds;
    trace.peerless.scopeMilliseconds += Date.now() - scopeStart;
  }
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
    channels = 5 + evidence.peers.length + (evidence.peers.length === 0 ? 1 : 0);
  for (const [normalIndex, normal] of normals.entries()) {
    checkpoint();
    context.telemetry.normals++;
    const projected = new Float64Array(points.length),
      heads = new Int32Array(bins).fill(-1),
      next = new Int32Array(points.length).fill(-1);
    let lo = Infinity,
      hi = -Infinity,
      targetLo = Infinity,
      targetHi = -Infinity,
      sum = 0,
      sumSquared = 0,
      targetSum = 0,
      targetSquared = 0,
      targetCount = 0;
    const peerLo = new Float64Array(evidence.peers.length).fill(Infinity),
      peerHi = new Float64Array(evidence.peers.length).fill(-Infinity);
    for (const [i, p] of points.entries()) {
      if ((i & 1023) === 0) checkpoint();
      charge();
      const d = dot(p.point, normal);
      projected[i] = d;
      sum += d;
      sumSquared += d * d;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
      if (p.target) {
        targetCount++;
        targetSum += d;
        targetSquared += d * d;
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
    const variance = Math.max(0, sumSquared / points.length - (sum / points.length) ** 2),
      targetVariance = Math.max(
        0,
        targetSquared / Math.max(1, targetCount) - (targetSum / Math.max(1, targetCount)) ** 2,
      ),
      localization = Math.max(0, 1 - targetVariance / Math.max(1e-12, variance));
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
      if (evidence.peers.length === 0 && p.scopeOverhangWitness) action(5);
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
    const scopeStarted = Date.now();
    const scopeProjection =
      evidence.peers.length === 0
        ? peerlessScopeProjection(points, projected, checkpoint, charge)
        : undefined;
    if (scopeProjection) {
      trace.peerless ??= {
        scopeMilliseconds: 0,
        structuralMilliseconds: 0,
        refinementMilliseconds: 0,
        supported: 0,
        ambiguous: 0,
        overbroad: 0,
        frontier: [],
        refinements: 0,
        triangleVisits: 0,
      };
      trace.peerless.scopeMilliseconds += Date.now() - scopeStarted;
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
    if (scopeProjection) {
      // Robust boundary proposals trim at most the existing .10 recall allowance.
      // They propose offsets only; localization, scope and structure still all must pass.
      const targetDepths = points.flatMap((p, i) => (p.target ? [projected[i] ?? 0] : []));
      targetDepths.sort((a, b) => {
        checkpoint();
        charge();
        return a - b;
      });
      for (const q of [0.05, 0.95]) {
        checkpoint();
        const robust = targetDepths[Math.floor((targetDepths.length - 1) * q)] ?? 0;
        offset(robust, 'TARGET_QUANTILE');
        // A bounded interior proposal covers the uncertainty between a raster
        // extremum and its robust frontier; it cannot bypass scope or structure.
        offset((robust + (q < 0.5 ? targetLo : targetHi)) / 2, 'TARGET_FRONTIER_BRACKET');
      }
    }
    if (
      part.cut &&
      Math.abs(dot(part.cut.normal, normal)) / Math.max(1e-9, Math.hypot(...part.cut.normal)) >
        0.999
    )
      offset(dot(part.cut.origin, normal), 'PROVIDER_HINT');
    const aggregate = (channel: number, bin: number): number =>
      VIEW_NAMES.reduce((sum, _view, vi) => sum + (hist[slot(vi, channel, bin)] ?? 0), 0);
    if (scopeProjection) {
      const width = (hi - lo) / bins;
      const boundaries = offsets.filter((_d, i) => offsetSources[i] === 'TARGET_QUANTILE');
      for (const boundary of boundaries) {
        let best:
          | {
              offset: number;
              contrast: number;
            }
          | undefined;
        for (let b = 1; b < bins; b++) {
          checkpoint();
          charge();
          const a = aggregate(0, b - 1),
            next = aggregate(0, b),
            d = lo + width * b;
          if (
            a < PEERLESS_SCOPE_LIMITS.samples ||
            next < PEERLESS_SCOPE_LIMITS.samples ||
            Math.abs(boundary - d) > 0.025 + width
          )
            continue;
          const contrast = Math.abs(a - next) / Math.max(a, next);
          if (!best || contrast > best.contrast) best = { offset: d, contrast };
        }
        if (best) offset(best.offset, 'VISIBLE_SECTION_TRANSITION');
      }
    }
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
        if (score) {
          const scopeStart = Date.now();
          const targetScope = scopeProjection
            ? peerlessScopeForCut(
                scopeProjection,
                rows,
                rows.map((_r, v) => below[v * channels + 4] ?? 0),
                d,
                side,
                checkpoint,
                rows.map((_r, v) =>
                  side === 1
                    ? (prefix[(v * channels + 5) * (bins + 1) + bins] ?? 0) -
                      (below[v * channels + 5] ?? 0)
                    : (below[v * channels + 5] ?? 0),
                ),
              )
            : undefined;
          if (targetScope && trace.peerless) {
            trace.peerless.scopeMilliseconds += Date.now() - scopeStart;
            if (targetScope.state === 'TARGET_SCOPE_SUPPORTED') trace.peerless.supported++;
            else if (targetScope.state === 'TARGET_SCOPE_OVERBROAD') trace.peerless.overbroad++;
            else trace.peerless.ambiguous++;
          }
          const structuralStart = Date.now();
          let structuralHint = 0;
          if (targetScope?.state === 'TARGET_SCOPE_SUPPORTED') {
            for (let b = Math.max(1, bin); b <= Math.min(bins - 1, bin + 1); b++) {
              checkpoint();
              charge();
              const a = aggregate(0, b - 1),
                next = aggregate(0, b);
              if (a < PEERLESS_SCOPE_LIMITS.samples || next < PEERLESS_SCOPE_LIMITS.samples)
                continue;
              structuralHint = Math.max(structuralHint, Math.abs(a - next) / Math.max(1, a, next));
            }
          }
          if (trace.peerless) trace.peerless.structuralMilliseconds += Date.now() - structuralStart;
          candidates.push({
            ...(targetScope ? { targetScope, structuralHint, localization } : {}),
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
  let peerlessRefinement: SemanticPlaneRefinement | undefined;
  let peerlessEligible: Candidate[] | undefined;
  if (evidence.peers.length === 0) {
    if (trace.peerless) trace.peerless.phase = 'BUILD_FRONTIER';
    // Four intrinsic normal families, with one interior boundary bracket and
    // one independently visible transition per family. Scope is a gate, not an
    // unknown-foreground penalty. Localization compares target/source variance
    // and therefore gives neither canonical nor PCA provenance a bonus.
    const families: {
      normal: Vec3;
      localization: number;
      bracket?: Candidate;
      robust?: Candidate;
      structural?: Candidate;
    }[] = [];
    const better = (a: Candidate, b: Candidate): boolean =>
      (a.structuralHint ?? 0) > (b.structuralHint ?? 0) ||
      ((a.structuralHint ?? 0) === (b.structuralHint ?? 0) &&
        (a.score.recall > b.score.recall ||
          (a.score.recall === b.score.recall &&
            defined(a.targetScope).boundaryGap < defined(b.targetScope).boundaryGap)));
    for (const c of eligible) {
      checkpoint();
      charge();
      if (c.targetScope?.state !== 'TARGET_SCOPE_SUPPORTED') continue;
      let family = families.find((f) => dot(f.normal, c.normal) > 0.999);
      if (!family) {
        family = { normal: c.normal, localization: c.localization ?? 0 };
        if (families.length === PEERLESS_SCOPE_LIMITS.frontier / 2) {
          let worst = 0;
          for (let i = 1; i < families.length; i++)
            if (defined(families[i]).localization < defined(families[worst]).localization)
              worst = i;
          if (family.localization <= defined(families[worst]).localization) continue;
          families.splice(worst, 1);
        }
        families.push(family);
      }
      if (
        c.offsetSource === 'TARGET_FRONTIER_BRACKET' &&
        (!family.bracket || better(c, family.bracket))
      )
        family.bracket = c;
      if (c.offsetSource === 'TARGET_QUANTILE' && (!family.robust || better(c, family.robust)))
        family.robust = c;
      if (
        c.offsetSource !== 'TARGET_FRONTIER_BRACKET' &&
        (!family.structural || better(c, family.structural))
      )
        family.structural = c;
    }
    families.sort((a, b) => {
      checkpoint();
      charge();
      return b.localization - a.localization;
    });
    const frontier: Candidate[] = [];
    const retain = (c: Candidate | undefined): void => {
      if (c && !frontier.includes(c) && frontier.length < PEERLESS_SCOPE_LIMITS.frontier)
        frontier.push(c);
    };
    // First cover normal diversity. The two most localized families also keep
    // their robust endpoint and independently visible transition, rather than
    // collapsing the uncertain boundary interval onto one proxy's preferred phase.
    for (const f of families) retain(f.bracket ?? f.robust ?? f.structural);
    for (const f of families.slice(0, 2)) retain(f.robust);
    for (const f of families.slice(0, 2)) retain(f.structural);
    for (const f of families) {
      retain(f.robust);
      retain(f.structural);
    }
    if (trace.peerless) trace.peerless.phase = 'STRUCTURAL_RANKING';
    const probeStarted = Date.now();
    const probes = probePeerlessSections(
      prepared.geometry,
      frontier,
      LOCAL_PLANE_LIMITS.sectionFaces,
      checkpoint,
    );
    for (const [i, c] of frontier.entries()) c.structuralHint = probes.profiles[i]?.contrast ?? 0;
    frontier.sort((a, b) => {
      checkpoint();
      charge();
      return (
        (b.structuralHint ?? 0) - (a.structuralHint ?? 0) ||
        b.score.recall - a.score.recall ||
        defined(a.targetScope).boundaryGap - defined(b.targetScope).boundaryGap
      );
    });
    peerlessEligible = frontier;
    if (trace.peerless) {
      trace.peerless.structuralMilliseconds += Date.now() - probeStarted;
      trace.peerless.probeTriangleVisits = probes.triangleVisits;
      trace.peerless.probeProjectionVisits = probes.projectionVisits;
    }
    if (trace.peerless)
      trace.peerless.frontier = frontier.map((c) => ({
        normal: c.normal,
        offset: c.offset,
        scope: defined(c.targetScope),
        structuralHint: c.structuralHint ?? 0,
        localization: c.localization ?? 0,
        offsetSource: c.offsetSource ?? 'SEMANTIC_TRANSITION',
      }));
  }
  const beam: Candidate[] = [];
  for (const c of peerlessEligible ?? eligible) {
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
  if (trace.peerless) trace.peerless.phase = 'REFINEMENT';
  const peerlessProfiles = peerlessEligible
    ? refineSemanticPlanes(
        prepared.geometry,
        beam.map((c, i) => ({
          ...part,
          id: String(i),
          cut: { normal: c.normal, origin: vector(c.normal.map((n) => n * c.offset)) },
          expectedGeometry: { ...part.expectedGeometry, likelySeparable: true },
        })),
        checkpoint,
        new Set(),
      )
    : undefined;
  if (peerlessProfiles && trace.peerless) {
    trace.peerless.refinementMilliseconds = peerlessProfiles.milliseconds;
    trace.peerless.refinements = beam.length;
    trace.peerless.triangleVisits = peerlessProfiles.triangleVisits;
  }
  if (trace.peerless) {
    trace.peerless.phase = 'CONFIRMATION';
    trace.peerless.finalists = [];
  }
  const confirmedRefinements = new Map<Candidate, SemanticPlaneRefinement>();
  for (const [beamIndex, original] of beam.entries()) {
    let c = original;
    const refined = peerlessProfiles?.refinements.get(String(beamIndex));
    if (peerlessProfiles) {
      const seam = structuralSeamEvidence(refined, checkpoint);
      trace.peerless?.finalists?.push({
        rank: beamIndex,
        normal: original.normal,
        proposedOffset: original.offset,
        refinedOffset: refined?.chosenOffset ?? null,
        structuralReason: seam.reason,
        structurallyAdmitted: seam.admitted,
        confirmed: false,
      });
      if (!refined || !seam.admitted) continue;
      const normal = refined.cut.normal,
        offset = dot(normal, refined.cut.origin);
      const scopeStart = Date.now();
      const projected = Float64Array.from(points, (p) => dot(p.point, normal));
      const scopeProjection = peerlessScopeProjection(points, projected, checkpoint, charge);
      const rows = emptyCounts(0),
        below = new Array<number>(6).fill(0),
        outsideSelected = new Array<number>(6).fill(0);
      for (const [i, p] of points.entries()) {
        if ((i & 1023) === 0) checkpoint();
        charge();
        const row = defined(rows[p.view]);
        if (p.target) row.target++;
        if (defined(projected[i]) >= offset) {
          row.selected++;
          if (p.target) row.hit++;
          if (p.scopeOverhangWitness) outsideSelected[p.view] = (outsideSelected[p.view] ?? 0) + 1;
        } else if (!p.target) below[p.view] = (below[p.view] ?? 0) + 1;
      }
      const targetScope = peerlessScopeForCut(
        scopeProjection,
        rows,
        below,
        offset,
        1,
        checkpoint,
        outsideSelected,
        true,
      );
      if (trace.peerless) {
        trace.peerless.scopeMilliseconds += Date.now() - scopeStart;
        const entry = trace.peerless.finalists?.[beamIndex];
        if (entry) entry.scopeState = targetScope.state;
      }
      if (targetScope.state !== 'TARGET_SCOPE_SUPPORTED') continue;
      c = { ...original, normal, offset, targetScope };
      confirmedRefinements.set(c, refined);
    }
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
    const entry = trace.peerless?.finalists?.[beamIndex];
    if (entry) entry.confirmed = true;
  }
  checkpoint();
  confirmed.sort((a, b) => {
    context.telemetry.rankingComparisons++;
    checkpoint();
    charge();
    return peerlessEligible
      ? (b.structuralHint ?? 0) - (a.structuralHint ?? 0) ||
          defined(a.targetScope).boundaryGap - defined(b.targetScope).boundaryGap ||
          b.score.recall - a.score.recall
      : semanticOrder(a, b);
  });
  trace.confirmed = confirmed.length;
  const winner = confirmed[0];
  if (winner) peerlessRefinement = confirmedRefinements.get(winner);
  if (winner) trace.phase = 'PROPOSAL';
  if (trace.peerless) trace.peerless.phase = 'COMPLETE';
  const support = (c: Candidate): number =>
    Math.min(c.score.confidence, c.score.recall, c.score.purity, 1 - c.score.worstLeakage);
  const families: Candidate[] = [];
  if (
    winner?.score.clean &&
    evidence.peers.some(
      (peer) =>
        peer.fused &&
        peer.part.parentId === part.parentId &&
        peer.part.importance === 'major' &&
        peer.part.instances === 1 &&
        peer.part.expectedGeometry.kind === 'solid_part',
    )
  )
    for (const c of eligible) {
      context.telemetry.compatibilityReserveChecks++;
      checkpoint();
      charge();
      if (!c.score.clean) continue;
      const index = families.findIndex(
        (other) => dot(c.normal, other.normal) >= Math.cos(Math.PI / 720),
      );
      const previous = families[index];
      if (!previous) families.push(c);
      else if (
        support(c) > support(previous) ||
        (support(c) === support(previous) && semanticOrder(c, previous) < 0)
      )
        families[index] = c;
    }
  const reserve = families
    .sort((a, b) => support(b) - support(a) || semanticOrder(a, b))
    .slice(0, LOCAL_PLANE_LIMITS.compatibilityReserve)
    .flatMap((c) => {
      checkpoint();
      const score = directScore(evidence, c.normal, c.offset, checkpoint, context);
      if (
        !score?.clean ||
        !assemblyEligible(evidence, answer, part, { ...c, score }, candidates, checkpoint, charge)
      )
        return [];
      return [
        {
          normal: c.normal,
          origin: vector(c.normal.map((n) => n * c.offset)),
          independentComplement: score.peers.some(
            (peer) =>
              peer.views >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews &&
              peer.leakage <= SEMANTIC_INTENT_LIMITS.maximumOppositePeerLeakage &&
              independentPlanePeer(part, peer.id, answer, peer, checkpoint),
          ),
          capturedFraction: score.fraction,
          support: Math.min(score.confidence, score.recall, score.purity, 1 - score.worstLeakage),
          provenance: {
            normalSources: PLANE_NORMAL_SOURCES.filter(
              (_s, i) => (c.normalSourceMask ?? 0) & (1 << i),
            ),
            offsetSource: c.offsetSource ?? 'SEMANTIC_TRANSITION',
            refined: false,
          },
        },
      ];
    });
  return winner
    ? {
        ...proposal(winner, evidence, part, candidates, answer, checkpoint, charge),
        ...(peerlessRefinement ? { peerlessRefinement } : {}),
        compatibilityReserve: reserve,
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
  return semanticPlaneScorer(prepared, answer, part, previous, checkpoint, context)(cut);
}
export function semanticPlaneScorer(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  part: SemanticPart,
  previous: LocalPlaneProposal,
  checkpoint: Checkpoint,
  context?: PlaneOwnershipContext,
): (cut: NonNullable<SemanticPart['cut']>) => LocalPlaneProposal | undefined {
  const bounded = boundedContext(context);
  // Local synthesis may set a derived separability flag. Aggregate intent must use the raw semantics.
  part = answer.parts.find((p) => p.id === part.id) ?? part;
  const evidence = observations(prepared, answer, part, checkpoint, bounded);
  return (cut) => {
    const normal = unit(cut.normal);
    if (!normal) return undefined;
    const offset = dot(cut.origin, normal),
      score = directScore(evidence, normal, offset, checkpoint, bounded);
    if (!score) return undefined;
    let targetScope: PeerlessScopeEvidence | undefined;
    if (previous.targetScope && evidence.peers.length === 0) {
      const scopeStart = Date.now();
      const charge = (): void => {
        bounded.telemetry.workUnits++;
        bounded.charge();
      };
      collectPeerlessScopeEnvelope(
        evidence.points,
        principal(evidence.points.map((p) => p.point)),
        checkpoint,
        charge,
      );
      const projected = Float64Array.from(evidence.points, (p) => dot(p.point, normal));
      const projection = peerlessScopeProjection(evidence.points, projected, checkpoint, charge);
      const rows = emptyCounts(0),
        below = new Array<number>(6).fill(0),
        outsideSelected = new Array<number>(6).fill(0);
      for (const [i, p] of evidence.points.entries()) {
        if ((i & 1023) === 0) checkpoint();
        charge();
        const row = defined(rows[p.view]);
        if (p.target) row.target++;
        if (defined(projected[i]) >= offset) {
          row.selected++;
          if (p.target) row.hit++;
          if (p.scopeOverhangWitness) outsideSelected[p.view] = (outsideSelected[p.view] ?? 0) + 1;
        } else if (!p.target) below[p.view] = (below[p.view] ?? 0) + 1;
      }
      targetScope = peerlessScopeForCut(
        projection,
        rows,
        below,
        offset,
        1,
        checkpoint,
        outsideSelected,
        true,
      );
      const trace = context?.synthesis?.get(part.id)?.peerless;
      if (trace) trace.scopeMilliseconds += Date.now() - scopeStart;
      if (targetScope.state !== 'TARGET_SCOPE_SUPPORTED') return undefined;
    }
    const candidate = {
      normal,
      offset,
      score,
      section: previous.sectionSamples,
      ...(targetScope ? { targetScope } : {}),
    };
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
      bounded.telemetry.workUnits++;
      bounded.charge();
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
  };
}
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Required bounded geometry evidence is missing.');
  return value;
}
export interface MajorSiblingConsistency {
  readonly outcome: 'CONSISTENT' | 'IRRELEVANT' | 'CONTRADICTORY' | 'AMBIGUOUS';
  readonly siblings: readonly {
    readonly id: string;
    readonly splitAxes: number;
    readonly competingAxes: number;
    readonly nonCompetingAxes: number;
    readonly ownership: 'NON_COMPETING' | 'COMPETING' | 'INSUFFICIENT_EVIDENCE';
    readonly views: readonly {
      readonly total: number;
      readonly selected: number;
      readonly shared: number;
      readonly targetSelected: number;
    }[];
  }[];
}
/** Reuses bounded raster samples, never source faces. A single occluded view cannot veto an assembly. */
export function majorSiblingConsistencyScorer(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  part: SemanticPart,
  checkpoint: Checkpoint,
  context?: PlaneOwnershipContext,
): (cut: LocalPlaneProposal['cut']) => MajorSiblingConsistency {
  const evidence = observations(prepared, answer, part, checkpoint, context);
  const relevant = evidence.peers
    .flatMap((peer, index) => {
      checkpoint();
      if (peer.part.parentId !== part.parentId || peer.part.importance !== 'major' || !peer.fused)
        return [];
      const axes = new Set<number>();
      for (const [i, point] of evidence.points.entries()) {
        if ((i & 1023) === 0) checkpoint();
        if (context) {
          context.telemetry.workUnits++;
          context.charge();
        }
        if (point.peerMask & (1 << index)) axes.add(Math.floor(point.view / 2));
      }
      // Keep weakly observed siblings for an explicit insufficient-evidence result.
      // Independence is required below for a competing conclusion, not for visibility.
      return axes.size > 0 &&
        !ancestor(answer, part.id, peer.part) &&
        !ancestor(answer, peer.part.id, part)
        ? [{ peer, index }]
        : [];
    })
    .sort((a, b) => a.peer.part.id.localeCompare(b.peer.part.id));
  const cache = new Map<string, MajorSiblingConsistency>();
  const dominant = prepared.facts.findIndex((f) => f.areaShare >= 0.5);
  return (cut) => {
    checkpoint();
    const key = JSON.stringify([cut.normal, cut.origin]);
    const cached = cache.get(key);
    if (cached) return cached;
    const offset = dot(cut.normal, cut.origin);
    const siblings = relevant.map(({ peer, index }) => {
      checkpoint();
      const views = Array.from({ length: 6 }, () => ({
        total: 0,
        selected: 0,
        shared: 0,
        targetSelected: 0,
      }));
      for (const [i, point] of evidence.points.entries()) {
        if ((i & 1023) === 0) checkpoint();
        if (context) {
          context.telemetry.workUnits++;
          context.charge();
        }
        if (point.rank !== dominant) continue;
        const row = defined(views[point.view]);
        if (point.target && dot(point.point, cut.normal) >= offset) row.targetSelected++;
        if (!(point.peerMask & (1 << index))) continue;
        row.total++;
        if (dot(point.point, cut.normal) >= offset) {
          row.selected++;
          if (point.target) row.shared++;
        }
      }
      const split = new Set<number>(),
        competing = new Set<number>(),
        nonCompeting = new Set<number>(),
        unresolvedAxes = new Set<number>();
      let unresolvedOverlap = false;
      for (const [vi, row] of views.entries()) {
        checkpoint();
        if (row.shared > 0 && row.shared / Math.max(1, row.targetSelected) > 0.1) {
          unresolvedOverlap = true;
          unresolvedAxes.add(Math.floor(vi / 2));
        }
        if (row.total < 8) continue;
        if (row.targetSelected >= 8 && row.shared / row.targetSelected <= 0.1)
          nonCompeting.add(Math.floor(vi / 2));
        const fraction = row.selected / row.total;
        if (
          fraction > SEMANTIC_INTENT_LIMITS.maximumOppositePeerLeakage &&
          fraction < 1 - SEMANTIC_INTENT_LIMITS.maximumOppositePeerLeakage
        )
          split.add(Math.floor(vi / 2));
        // Candidate-relative ownership: a broad peer mask cannot dilute shared target support.
        // Eight corroborating samples on each of two axes are required for a contradiction.
        if (row.shared >= 8 && row.targetSelected >= 8 && row.shared / row.targetSelected > 0.1)
          competing.add(Math.floor(vi / 2));
      }
      // One occluded projection can contain another part's silhouette. It is
      // resolved only by two independently observed non-competing axes; missing
      // or weak views never count as evidence of separation.
      for (const axis of unresolvedAxes) nonCompeting.delete(axis);
      const ownership =
        competing.size >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews ||
        split.size >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews
          ? ('COMPETING' as const)
          : unresolvedOverlap && nonCompeting.size < SEMANTIC_INTENT_LIMITS.minimumIndependentViews
            ? ('INSUFFICIENT_EVIDENCE' as const)
            : ('NON_COMPETING' as const);
      return {
        id: peer.part.id,
        splitAxes: split.size,
        competingAxes: competing.size,
        nonCompetingAxes: nonCompeting.size,
        ownership,
        views,
      };
    });
    const result: MajorSiblingConsistency = {
      outcome: siblings.some(
        (s) =>
          s.splitAxes >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews ||
          s.competingAxes >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews,
      )
        ? 'CONTRADICTORY'
        : siblings.some((s) => s.ownership === 'INSUFFICIENT_EVIDENCE')
          ? 'AMBIGUOUS'
          : siblings.length
            ? 'CONSISTENT'
            : 'IRRELEVANT',
      siblings,
    };
    cache.set(key, result);
    return result;
  };
}
