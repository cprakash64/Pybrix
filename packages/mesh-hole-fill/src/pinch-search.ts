import {
  add,
  boundarySize,
  cross,
  dot,
  faceNormal,
  growRegion,
  len,
  liveFanCount,
  liveFans,
  mul,
  SurgeryRefusal,
  sub,
  tryReconstruct,
  type CandidateBaseline,
  type FanChain,
  type FanRegion,
  type SiteResult,
  type SurgeryAccept,
  type SurgeryMesh,
  type SurgeryOperation,
  type SurgeryRefusalRecord,
  type TentativeContext,
  type Vec3,
} from './surgery-mesh';
import {
  faceCornerCoordinates,
  measureSurfaceFidelity,
  type SurfaceFidelity,
} from './surface-fidelity';
import { WorkLimitReached, type RepairWorkMeter } from './repair-work-budget';

/**
 * LOCAL PINCH SEARCH (LS-A2 / LS-B) — the primary local repair.
 *
 * One non-manifold vertex at a time: remove a bounded star, rebuild it with V replaced by a fresh
 * apex per MOVED fan, validate the finished candidate, install it. Every displacement is
 * rho * L, where L is the median edge of the faces the operation could touch; a displacement is
 * never scaled by a fan's own extent.
 *
 * Per site and depth the search is:
 *
 *   anchor  - none, or ONE fan left exactly as it is (its apex stays at V, its faces are not
 *             removed): that fan cannot deviate at all and the others need only clear it.
 *   kind    - a direction per moved fan, each derived from that fan's own geometry.
 *   rho     - displacement over L: starts at the analytic separation floor for that kind, climbs
 *             by sqrt(2) rungs, and a first valid rung is refined by bisection against the rung
 *             below it.
 *
 * Every candidate is built and MEASURED without the expensive exact test: structural gates,
 * triangle quality against the removed star, the locality envelope and the bidirectional surface
 * deviation. The valid ones are ranked lexicographically (maximum deviation, p95 deviation,
 * absolute area change, displacement) and the exact intersection test is spent on them in that
 * order; the first to pass is installed. Nothing is random.
 *
 * KERNEL-FREE. The exact test is injected as `accept`, called with the tentative candidate in
 * place, so this module imports no geometry kernel.
 *
 * BOUNDED. A `RepairWorkMeter` is charged for every candidate and every exact test and consulted
 * only BETWEEN reconstructions, so a limit stops the search at a safe point and never inside a
 * tentative state.
 */

/** Rungs per kind are sqrt(2) apart. */
const RUNG_RATIO = Math.SQRT2;
/** Valid rungs kept per (anchor, kind): enough to fall back on if the exact test refuses. */
const VALID_RUNGS_KEPT = 3;
const REFINE_STEPS = 3;

export interface PinchSearchOptions {
  readonly accept?: SurgeryAccept;
  readonly minDepth?: number;
  /** Depth 1 is LS-A2; 2..maxDepth is LS-B. */
  readonly maxDepth?: number;
  /**
   * The finite-feature requirement: the closest two apexes of one operation (a fan left in place
   * counts as an apex at V) end at least this fraction of L apart.
   */
  readonly separationFloor?: number;
  /** Safety ceiling on max bidirectional deviation over L (both normalisers). */
  readonly deviationCeiling?: number;
  /** Candidate worst triangle quality must be at least this fraction of the source's. */
  readonly qualityFloorFraction?: number;
  /** Candidate worst edge-length ratio may be at most this multiple of the source's. */
  readonly edgeRatioCeilingFactor?: number;
  /** Highest rho tried. */
  readonly maxRho?: number;
  /** Upper bound on exact intersection tests spent on one (site, depth). */
  readonly maxExactAttempts?: number;
  /** Polled between site attempts; a true stops the driver at a site boundary. */
  readonly cancelled?: () => boolean;
  /**
   * Lets the injected exact gate say WHICH REGION OF SPACE it read. `reset` is called before each
   * site attempt, `box` after it. With it a refused site is retried only when something it read
   * has changed.
   */
  readonly acceptReads?: {
    readonly reset: () => void;
    readonly box: () => readonly [number, number, number, number, number, number] | undefined;
  };
  /** The deterministic work meter this search charges; absent means unmetered. */
  readonly meter?: RepairWorkMeter;
  /** Progress at a bounded cadence (every `PROGRESS_EVERY_ATTEMPTS` site attempts). */
  readonly onProgress?: (progress: PinchProgress) => void;
}

export interface PinchProgress {
  readonly pass: number;
  readonly total: number;
  readonly attempted: number;
  readonly accepted: number;
  readonly refused: number;
}

const PROGRESS_EVERY_ATTEMPTS = 25;

export const PINCH_SEARCH_DEFAULTS = Object.freeze({
  separationFloor: 0.125,
  deviationCeiling: 1.0,
  qualityFloorFraction: 0.5,
  edgeRatioCeilingFactor: 2,
  maxRho: 2,
  maxExactAttempts: 40,
  minDepth: 1,
  maxDepth: 4,
});

export interface PinchSelection {
  readonly anchorFan: number;
  readonly kind: string;
  readonly scheme: string;
  /** Displacement over L of the first moved apex (others scale by the scheme). */
  readonly rho: number;
  readonly refined: boolean;
}

export interface QualityEvidence {
  readonly minQ: number;
  readonly maxEdgeRatio: number;
  readonly minAngleDeg: number;
}

export interface PinchOperation extends SurgeryOperation {
  readonly selection: PinchSelection;
  /** Median edge of every face the operation could touch at this depth. */
  readonly localScale: number;
  readonly movedFans: number;
  readonly displacementOverScale: number;
  readonly fidelity: SurfaceFidelity;
  readonly qualityBefore: QualityEvidence;
  readonly qualityAfter: QualityEvidence;
  readonly candidatesEvaluated: number;
  readonly candidatesValid: number;
  readonly exactAttempts: number;
}

/* ------------------------------------------------------------- geometry -- */

function unit(v: Vec3): Vec3 | undefined {
  const l = len(v);
  return l > 0 && Number.isFinite(l) ? mul(v, 1 / l) : undefined;
}

function centroidOf(points: readonly Vec3[], fallback: Vec3): Vec3 {
  if (points.length === 0) return fallback;
  let c: Vec3 = [0, 0, 0];
  for (const p of points) c = add(c, p);
  return mul(c, 1 / points.length);
}

/** The elements of `items` at `indices`, in that order; an index out of range is skipped. */
function pick<T>(items: readonly T[], indices: readonly number[]): T[] {
  return indices.flatMap((i) => {
    const item = items[i];
    return item === undefined ? [] : [item];
  });
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.floor(s.length / 2))] ?? 0);
}

/** Eigenvectors of a symmetric 3x3 by cyclic Jacobi, ordered by DESCENDING eigenvalue. */
function symmetricAxes(m: readonly number[]): Vec3[] {
  const a = [...m];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const at = (i: number, j: number): number => a[i * 3 + j] ?? 0;
  for (let sweep = 0; sweep < 16; sweep += 1) {
    let off = 0;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      off += Math.abs(at(p, q));
      if (Math.abs(at(p, q)) < 1e-300) continue;
      const theta = (at(q, q) - at(p, p)) / (2 * at(p, q));
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const akp = at(k, p);
        const akq = at(k, q);
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const apk = at(p, k);
        const aqk = at(q, k);
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k * 3 + p] ?? 0;
        const vkq = v[k * 3 + q] ?? 0;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
    if (off < 1e-30) break;
  }
  const order = [0, 1, 2].sort((i, j) => at(j, j) - at(i, i) || i - j);
  return order.map((i): Vec3 => [v[i] ?? 0, v[3 + i] ?? 0, v[6 + i] ?? 0]);
}

interface FanGeometry {
  readonly linkCentroid: Vec3;
  readonly faceCentroid: Vec3;
  readonly linkMedian: Vec3;
  readonly edgeWeighted: Vec3;
  readonly normal: Vec3 | undefined;
  readonly tangent1: Vec3 | undefined;
  readonly tangent2: Vec3 | undefined;
  readonly pcaNormal: Vec3 | undefined;
}

function fanGeometry(mesh: SurgeryMesh, vertex: number, fan: FanChain): FanGeometry {
  const p = mesh.point(vertex);
  const link = fan.link.map((u) => mesh.point(u));
  const linkCentroid = centroidOf(link, p);
  let weighted: Vec3 = [0, 0, 0];
  let area = 0;
  let n: Vec3 = [0, 0, 0];
  for (const f of fan.faces) {
    const raw = faceNormal(mesh, f);
    const a = 0.5 * len(raw);
    const [x, y, z] = mesh.corners(f);
    const c = mul(add(add(mesh.point(x), mesh.point(y)), mesh.point(z)), 1 / 3);
    weighted = add(weighted, mul(c, a));
    area += a;
    n = add(n, raw);
  }
  const mid = (axis: 0 | 1 | 2): number => median(link.map((q) => q[axis]));
  let edgeSum: Vec3 = [0, 0, 0];
  let edgeLen = 0;
  const pairs = link.length - 1 + (fan.closed && link.length > 1 ? 1 : 0);
  for (let i = 0; i < pairs; i += 1) {
    const a = link[i] ?? p;
    const b = link[(i + 1) % link.length] ?? p;
    const l = len(sub(a, b));
    edgeSum = add(edgeSum, mul(add(a, b), 0.5 * l));
    edgeLen += l;
  }
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const q of [p, ...link]) {
    const d = sub(q, linkCentroid);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1)
        cov[i * 3 + j] = (cov[i * 3 + j] ?? 0) + (d[i] ?? 0) * (d[j] ?? 0);
    }
  }
  const axes = symmetricAxes(cov);
  return {
    linkCentroid,
    faceCentroid: area > 0 ? mul(weighted, 1 / area) : linkCentroid,
    linkMedian: [mid(0), mid(1), mid(2)],
    edgeWeighted: edgeLen > 0 ? mul(edgeSum, 1 / edgeLen) : linkCentroid,
    normal: unit(n),
    tangent1: axes[0],
    tangent2: axes[1],
    pcaNormal: axes[2],
  };
}

export const DIRECTION_KINDS: readonly string[] = Object.freeze([
  'link-centroid',
  'face-centroid',
  'link-median',
  'link-edge-weighted',
  'normal-away',
  'normal-toward',
  'pca-tangent-major+',
  'pca-tangent-major-',
  'pca-tangent-minor+',
  'pca-tangent-minor-',
  'pca-normal-away',
  'pca-normal-toward',
  'centroid+normal-away',
  'centroid+normal-toward',
  'away-from-other-fans',
]);

/** Unit direction of `kind` for fan `i`, or undefined if its geometry cannot supply one. */
function directionOf(
  kind: string,
  i: number,
  p: Vec3,
  geoms: readonly FanGeometry[],
): Vec3 | undefined {
  const g = geoms[i];
  if (g === undefined) return undefined;
  const others = geoms.filter((_, j) => j !== i);
  const otherCentroid =
    others.length === 0
      ? undefined
      : centroidOf(
          others.map((o) => o.linkCentroid),
          p,
        );
  const away = otherCentroid === undefined ? undefined : sub(p, otherCentroid);
  const toCentroid = unit(sub(g.linkCentroid, p));
  const signed = (axis: Vec3 | undefined, wantAway: boolean): Vec3 | undefined => {
    if (axis === undefined) return undefined;
    if (away === undefined) return wantAway ? axis : mul(axis, -1);
    const along = dot(axis, away) >= 0;
    return wantAway === along ? axis : mul(axis, -1);
  };
  const towardSigned = (axis: Vec3 | undefined): Vec3 | undefined => {
    if (axis === undefined) return undefined;
    const reference = sub(g.linkCentroid, p);
    return dot(axis, reference) >= 0 ? axis : mul(axis, -1);
  };
  switch (kind) {
    case 'link-centroid':
      return toCentroid;
    case 'face-centroid':
      return unit(sub(g.faceCentroid, p));
    case 'link-median':
      return unit(sub(g.linkMedian, p));
    case 'link-edge-weighted':
      return unit(sub(g.edgeWeighted, p));
    case 'normal-away':
      return signed(g.normal, true);
    case 'normal-toward':
      return signed(g.normal, false);
    case 'pca-tangent-major+':
      return towardSigned(g.tangent1);
    case 'pca-tangent-major-': {
      const t = towardSigned(g.tangent1);
      return t === undefined ? undefined : mul(t, -1);
    }
    case 'pca-tangent-minor+':
      return towardSigned(g.tangent2);
    case 'pca-tangent-minor-': {
      const t = towardSigned(g.tangent2);
      return t === undefined ? undefined : mul(t, -1);
    }
    case 'pca-normal-away':
      return signed(g.pcaNormal, true);
    case 'pca-normal-toward':
      return signed(g.pcaNormal, false);
    case 'centroid+normal-away': {
      const n = signed(g.normal, true);
      return toCentroid === undefined || n === undefined ? undefined : unit(add(toCentroid, n));
    }
    case 'centroid+normal-toward': {
      const n = signed(g.normal, false);
      return toCentroid === undefined || n === undefined ? undefined : unit(add(toCentroid, n));
    }
    case 'away-from-other-fans':
      return away === undefined ? undefined : unit(away);
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------- quality -- */

function faceQ(c: readonly number[]): { q: number; edgeRatio: number; minAngleDeg: number } {
  const p = (k: number): Vec3 => [c[k * 3] ?? 0, c[k * 3 + 1] ?? 0, c[k * 3 + 2] ?? 0];
  const a = p(0);
  const b = p(1);
  const d = p(2);
  const ab = sub(b, a);
  const bd = sub(d, b);
  const da = sub(a, d);
  const e = [len(ab), len(bd), len(da)];
  const area = 0.5 * len(cross(ab, sub(d, a)));
  const sq = e.reduce((s, x) => s + x * x, 0);
  const lo = Math.min(...e);
  // Smallest angle is opposite the shortest edge: law of cosines.
  const angleAt = (x: number, y: number, z: number): number =>
    x > 0 && y > 0
      ? Math.acos(Math.max(-1, Math.min(1, (x * x + y * y - z * z) / (2 * x * y))))
      : 0;
  const angles = [
    angleAt(e[0] ?? 0, e[2] ?? 0, e[1] ?? 0),
    angleAt(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0),
    angleAt(e[1] ?? 0, e[2] ?? 0, e[0] ?? 0),
  ];
  return {
    q: sq > 0 ? (4 * Math.sqrt(3) * area) / sq : 0,
    edgeRatio: lo > 0 ? Math.max(...e) / lo : Infinity,
    minAngleDeg: (Math.min(...angles) * 180) / Math.PI,
  };
}

function qualityOf(mesh: SurgeryMesh, faces: readonly number[]): QualityEvidence {
  let minQ = Infinity;
  let ratio = 0;
  let angle = Infinity;
  for (const f of faces) {
    const x = faceQ(faceCornerCoordinates(mesh, f));
    minQ = Math.min(minQ, x.q);
    ratio = Math.max(ratio, x.edgeRatio);
    angle = Math.min(angle, x.minAngleDeg);
  }
  return {
    minQ: minQ === Infinity ? 0 : minQ,
    maxEdgeRatio: ratio,
    minAngleDeg: angle === Infinity ? 0 : angle,
  };
}

/* ------------------------------------------------------------ the search -- */

/**
 * How the moved fans' magnitudes relate. `uniform`: every moved apex travels rho * L.
 * `staggered`: the k-th moved fan travels (k + 1) * rho * L, which separates apexes whose
 * directions coincide (a thin wedge of fans) along ONE axis instead of refusing them.
 * `alternating`: the same separation with magnitudes +1, -1, +2, -2, ...: the nearest two
 * apexes are as far apart, but the farthest travels about half as far, which matters
 * because the largest displacement is what bounds the deviation of a many-fan site.
 */
export const MAGNITUDE_SCHEMES: readonly string[] = Object.freeze([
  'uniform',
  'staggered',
  'alternating',
]);

interface Spec {
  readonly anchor: number;
  readonly kind: string;
  readonly scheme: string;
  readonly rho: number;
  readonly refined: boolean;
  readonly index: number;
}

interface Measured {
  readonly spec: Spec;
  readonly fidelity: SurfaceFidelity;
  readonly before: QualityEvidence;
  readonly after: QualityEvidence;
  readonly displacement: number;
}

function compareMeasured(a: Measured, b: Measured): number {
  // Lexicographic, in the order the stage specifies. Values within a relative 1e-9 are
  // ties so floating-point noise cannot reorder candidates.
  const keys: ((m: Measured) => number)[] = [
    (m): number => m.fidelity.maxDistanceOverLocalEdge,
    (m): number => m.fidelity.p95OverLocalEdge,
    (m): number => Math.abs(m.fidelity.areaDelta),
    (m): number => m.displacement,
  ];
  for (const key of keys) {
    const x = key(a);
    const y = key(b);
    const tolerance = 1e-9 * Math.max(Math.abs(x), Math.abs(y), 1e-300);
    if (Math.abs(x - y) > tolerance) return x - y;
  }
  return a.spec.index - b.spec.index;
}

/* ------------------------------------------------- the search, as separable units -- */
/*
 * REPAIR-CORE-05D-2. `searchPinchSite` used to be one closure. Its work falls into units that do
 * not depend on each other's RESULTS, only on the mesh as it stood when the site was opened:
 *
 *   - a CHAIN: every rung of one (anchor, kind, scheme), including the bisection after the first
 *     failure-then-pass. Chains are independent of each other; the order they are CONSUMED in
 *     (anchor, then kind, then scheme) is the order the legacy loop ran them in.
 *   - an EXACT PROBE: one ranked candidate run through the exact gate. Probes of one ranked list
 *     are independent of each other until one is accepted, and the winner is the EARLIEST-ranked
 *     accepted candidate, exactly as the sequential loop would have chosen.
 *
 * The serial path runs these units in legacy order and is the ORACLE for any executor that runs
 * them elsewhere. Nothing here decides anything new.
 */

/** The numeric configuration of one search. */
export interface SearchConfig {
  readonly separationFloor: number;
  readonly deviationCeiling: number;
  readonly qualityFloorFraction: number;
  readonly edgeRatioCeilingFactor: number;
  readonly maxRho: number;
  readonly maxExactAttempts: number;
  readonly minDepth: number;
  readonly maxDepth: number;
}

export function resolveSearchConfig(options: PinchSearchOptions): SearchConfig {
  return {
    separationFloor: options.separationFloor ?? PINCH_SEARCH_DEFAULTS.separationFloor,
    deviationCeiling: options.deviationCeiling ?? PINCH_SEARCH_DEFAULTS.deviationCeiling,
    qualityFloorFraction:
      options.qualityFloorFraction ?? PINCH_SEARCH_DEFAULTS.qualityFloorFraction,
    edgeRatioCeilingFactor:
      options.edgeRatioCeilingFactor ?? PINCH_SEARCH_DEFAULTS.edgeRatioCeilingFactor,
    maxRho: options.maxRho ?? PINCH_SEARCH_DEFAULTS.maxRho,
    maxExactAttempts: options.maxExactAttempts ?? PINCH_SEARCH_DEFAULTS.maxExactAttempts,
    minDepth: options.minDepth ?? PINCH_SEARCH_DEFAULTS.minDepth,
    maxDepth: options.maxDepth ?? PINCH_SEARCH_DEFAULTS.maxDepth,
  };
}

/** A candidate's identity: plain data, so it can be sent to another thread and back. */
export interface CandidateSpec {
  readonly anchor: number;
  readonly kind: string;
  readonly scheme: string;
  readonly rho: number;
  readonly refined: boolean;
  /** Evaluation order within the depth, 1-based. Breaks exact ties in the ranking. */
  readonly index: number;
}

/** The measurements a dry-run candidate carries into the ranking. */
export interface MeasuredCandidate {
  readonly spec: CandidateSpec;
  readonly fidelity: SurfaceFidelity;
  readonly before: QualityEvidence;
  readonly after: QualityEvidence;
  readonly displacement: number;
}

/** One chain of rungs. */
export interface ChainJob {
  readonly anchor: number;
  readonly kind: string;
  readonly scheme: string;
  readonly startRho: number;
}

/** A chain entry in legacy order: either a chain to run, or the reason it was skipped. */
export type ChainEntry =
  | { readonly job: ChainJob; readonly note?: undefined }
  | { readonly note: string; readonly job?: undefined };

export interface ChainResult {
  /** Candidates that passed the dry run, in the order the legacy loop pushed them. LOCAL indices. */
  readonly valid: readonly MeasuredCandidate[];
  /** Rejection reasons in the order the legacy loop noted them. */
  readonly notes: readonly string[];
  /** Dry-run evaluations that reached the reconstruction (the legacy `evaluated` increment). */
  readonly evaluated: number;
  /** Spec numbers consumed, whether or not they reached it (the legacy `specIndex` increment). */
  readonly calls: number;
}

interface ChainTally {
  evaluated: number;
}

/** Everything about an opened site that does not depend on the depth. */
export interface SiteContext {
  readonly mesh: SurgeryMesh;
  readonly vertex: number;
  readonly cfg: SearchConfig;
  readonly fans: readonly FanChain[];
  readonly geoms: readonly FanGeometry[];
  readonly anchors: readonly number[];
  readonly p: Vec3;
  readonly meter: RepairWorkMeter | undefined;
  /** One baseline cache per site: the mesh is identical at every candidate (each is rolled back). */
  readonly baselineCache: Map<string, CandidateBaseline>;
}

export function buildSiteContext(
  mesh: SurgeryMesh,
  vertex: number,
  fans: readonly FanChain[],
  cfg: SearchConfig,
  meter: RepairWorkMeter | undefined,
): SiteContext {
  const p = mesh.point(vertex);
  const geoms = fans.map((fan) => fanGeometry(mesh, vertex, fan));
  const fanArea = fans.map((fan) =>
    fan.faces.reduce((s, f) => s + 0.5 * len(faceNormal(mesh, f)), 0),
  );
  // Anchors: no anchor, then every fan, largest area first (ties by index). Capped so a
  // many-fan site cannot multiply the search: the three largest are the ones that matter.
  const byArea = fans
    .map((_, i) => i)
    .sort((a, b) => (fanArea[b] ?? 0) - (fanArea[a] ?? 0) || a - b);
  const anchors = [-1, ...byArea.slice(0, Math.min(fans.length, 3))];
  return {
    mesh,
    vertex,
    cfg,
    fans,
    geoms,
    anchors,
    p,
    meter,
    baselineCache: new Map<string, CandidateBaseline>(),
  };
}

export interface DepthSearch {
  readonly depth: number;
  readonly scale: number;
  readonly regions: readonly FanRegion[];
  /** Chains and skip-notes in the order the legacy loop visited them. */
  readonly entries: readonly ChainEntry[];
  readonly runChain: (job: ChainJob) => ChainResult;
  /** One exact attempt on a candidate, with `accept` as the gate. Mutates `mesh` as tryReconstruct does. */
  readonly attempt: (
    spec: CandidateSpec,
    accept: SurgeryAccept | undefined,
  ) => {
    readonly moved: readonly number[];
    readonly movedFans: readonly FanChain[];
    readonly movedRegions: readonly FanRegion[];
    readonly result: ReturnType<typeof tryReconstruct>;
  };
}

export type OpenedDepth =
  | { readonly kind: 'overlap' }
  | { readonly kind: 'no-scale' }
  | { readonly kind: 'ready'; readonly search: DepthSearch };

/**
 * The structural-quality, locality and fidelity gate every A2 candidate must pass before the exact
 * test is spent on it. One definition, used by the search and by the 05E feasibility probe, so the
 * probe applies exactly the engine's limits. Returns the refusal reason, or the measurements.
 */
export function inspectCandidate(
  ctx: TentativeContext,
  cfg: SearchConfig,
  p: Vec3,
  scale: number,
): string | { fidelity: SurfaceFidelity; before: QualityEvidence; after: QualityEvidence } {
  const before = qualityOf(ctx.mesh, ctx.removedFaces);
  const after = qualityOf(ctx.mesh, ctx.addedFaces);
  if (after.minQ < cfg.qualityFloorFraction * before.minQ) return 'quality-q';
  if (after.maxEdgeRatio > cfg.edgeRatioCeilingFactor * before.maxEdgeRatio) {
    return 'quality-edge-ratio';
  }
  // Locality envelope: the source star's bounding SPHERE about V. No new vertex
  // may leave it; retained vertices cannot move at all (they are reused by id).
  let radius = 0;
  for (const f of ctx.removedFaces) {
    for (const x of ctx.mesh.corners(f)) radius = Math.max(radius, len(sub(ctx.mesh.point(x), p)));
  }
  for (const f of ctx.addedFaces) {
    for (const x of ctx.mesh.corners(f)) {
      if (len(sub(ctx.mesh.point(x), p)) > radius * (1 + 1e-9)) return 'outside-envelope';
    }
  }
  const fidelity = measureSurfaceFidelity(ctx.mesh, ctx.removedFaces, ctx.addedFaces);
  if (!(fidelity.maxDistanceOverLocalEdge <= cfg.deviationCeiling)) return 'deviation-ceiling';
  if (!(fidelity.maxDistance <= cfg.deviationCeiling * scale)) return 'deviation-ceiling-site';
  return { fidelity, before, after };
}

export function openDepth(site: SiteContext, depth: number): OpenedDepth {
  const { mesh, vertex, cfg, fans, geoms, anchors, p, meter, baselineCache } = site;
  const regions = fans.map((fan) => growRegion(mesh, vertex, fan, depth));
  if (regionsMeet(regions, vertex, depth)) return { kind: 'overlap' };
  // L: median edge over every face any candidate at this depth could remove.
  const touchedFaces = new Set<number>();
  for (const r of regions) for (const f of r.faces) touchedFaces.add(f);
  const edgeLengths: number[] = [];
  for (const f of touchedFaces) {
    const c = faceCornerCoordinates(mesh, f);
    for (let k = 0; k < 3; k += 1) {
      const a: Vec3 = [c[k * 3] ?? 0, c[k * 3 + 1] ?? 0, c[k * 3 + 2] ?? 0];
      const b: Vec3 = [
        c[((k + 1) % 3) * 3] ?? 0,
        c[((k + 1) % 3) * 3 + 1] ?? 0,
        c[((k + 1) % 3) * 3 + 2] ?? 0,
      ];
      edgeLengths.push(len(sub(a, b)));
    }
  }
  const scale = median(edgeLengths);
  if (!(scale > 0)) return { kind: 'no-scale' };

  const movedOf = (anchor: number): number[] => fans.map((_, i) => i).filter((i) => i !== anchor);
  const magnitudeOf = (scheme: string, k: number): number => {
    if (scheme === 'staggered') return k + 1;
    if (scheme === 'alternating') return k % 2 === 0 ? k / 2 + 1 : -(k + 1) / 2;
    return 1;
  };
  const buildOffsets = (spec: CandidateSpec): Vec3[] | undefined => {
    const out: Vec3[] = [];
    let k = 0;
    for (const i of movedOf(spec.anchor)) {
      const d = directionOf(spec.kind, i, p, geoms);
      if (d === undefined) return undefined;
      out.push(mul(d, magnitudeOf(spec.scheme, k) * spec.rho * scale));
      k += 1;
    }
    return out;
  };
  // Evaluate one spec WITHOUT the exact test; returns its measurements or the reason.
  const evaluate = (spec: Spec, tally: ChainTally): Measured | string => {
    // A SAFE POINT: no reconstruction is in flight, so a work limit may stop the search here.
    meter?.check();
    meter?.chargeCandidate();
    const moved = movedOf(spec.anchor);
    const offsets = buildOffsets(spec);
    if (offsets === undefined) return 'no-direction';
    const movedFans = pick(fans, moved);
    const movedRegions = pick(regions, moved);
    let captured: Measured | undefined;
    const inspect = (ctx: TentativeContext): string | undefined => {
      const verdict = inspectCandidate(ctx, cfg, p, scale);
      if (typeof verdict === 'string') return verdict;
      captured = {
        spec,
        fidelity: verdict.fidelity,
        before: verdict.before,
        after: verdict.after,
        displacement: Math.max(0, ...offsets.map(len)),
      };
      return undefined;
    };
    tally.evaluated += 1;
    const result = tryReconstruct(
      mesh,
      vertex,
      movedFans,
      movedRegions,
      depth,
      offsets,
      movedFans.map(() => scale),
      undefined,
      {
        minSeparation: 0,
        inspect,
        dryRun: true,
        skipAccept: true,
        truncate: true,
        baselineCache,
      },
    );
    if (typeof result === 'string') return result;
    return captured ?? 'internal-no-measure';
  };
  // The enumeration: the same visits, in the same order, as the legacy nested loops. A visit
  // that the legacy loop skipped with a reason becomes a note entry; one it ran becomes a job.
  const entries: ChainEntry[] = [];
  for (const anchor of anchors) {
    const moved = movedOf(anchor);
    if (moved.length === 0) continue;
    for (const kind of DIRECTION_KINDS) {
      const dirs: Vec3[] = [];
      let usable = true;
      for (const i of moved) {
        const d = directionOf(kind, i, p, geoms);
        if (d === undefined) {
          usable = false;
          break;
        }
        dirs.push(d);
      }
      if (!usable) continue;
      for (const scheme of MAGNITUDE_SCHEMES) {
        // The analytic separation floor for this direction set: the nearest pair of
        // apexes at unit rho (a kept fan counts as an apex at V, i.e. the origin).
        const weighted = dirs.map((d, k) => mul(d, magnitudeOf(scheme, k)));
        let nearest = Infinity;
        for (let a = 0; a < weighted.length; a += 1) {
          if (anchor >= 0) nearest = Math.min(nearest, len(weighted[a] ?? [0, 0, 0]));
          for (let b = a + 1; b < weighted.length; b += 1) {
            nearest = Math.min(
              nearest,
              len(sub(weighted[a] ?? [0, 0, 0], weighted[b] ?? [0, 0, 0])),
            );
          }
        }
        // Staggering is a remedy for directions that nearly coincide, not a second copy
        // of every search: it is tried only when the uniform scheme could not separate
        // the apexes within half a unit of rho.
        if (scheme === 'staggered' || scheme === 'alternating') {
          const uniform = dirs.map((d) => d);
          let uniformNearest = Infinity;
          for (let a = 0; a < uniform.length; a += 1) {
            if (anchor >= 0)
              uniformNearest = Math.min(uniformNearest, len(uniform[a] ?? [0, 0, 0]));
            for (let b = a + 1; b < uniform.length; b += 1) {
              uniformNearest = Math.min(
                uniformNearest,
                len(sub(uniform[a] ?? [0, 0, 0], uniform[b] ?? [0, 0, 0])),
              );
            }
          }
          if (moved.length < 2 || uniformNearest >= 0.5) continue;
        }
        if (!(nearest > 1e-6)) {
          entries.push({ note: 'directions-coincide' });
          continue;
        }
        const rho = cfg.separationFloor / nearest;
        if (rho > cfg.maxRho) {
          entries.push({ note: 'separation-exceeds-max-rho' });
          continue;
        }
        entries.push({ job: { anchor, kind, scheme, startRho: rho } });
      }
    }
  }

  const runChain = (job: ChainJob): ChainResult => {
    const { anchor, kind, scheme } = job;
    const valid: MeasuredCandidate[] = [];
    const notes: string[] = [];
    const tally: ChainTally = { evaluated: 0 };
    let specIndex = 0;
    let rho = job.startRho;
    let previous: number | undefined;
    let kept = 0;
    while (rho <= cfg.maxRho && kept < VALID_RUNGS_KEPT) {
      specIndex += 1;
      const spec: Spec = { anchor, kind, scheme, rho, refined: false, index: specIndex };
      const m = evaluate(spec, tally);
      if (typeof m === 'string') {
        notes.push(m);
        previous = rho;
      } else {
        let best = m;
        if (kept === 0 && previous !== undefined) {
          // The rung below failed and this one passed: bisect in log space for a
          // smaller passing displacement.
          let lo = previous;
          let hi = rho;
          for (let step = 0; step < REFINE_STEPS; step += 1) {
            const mid = Math.sqrt(lo * hi);
            specIndex += 1;
            const trial = evaluate(
              {
                anchor,
                kind,
                scheme,
                rho: mid,
                refined: true,
                index: specIndex,
              },
              tally,
            );
            if (typeof trial === 'string') {
              notes.push(trial);
              lo = mid;
            } else {
              best = trial;
              hi = mid;
            }
          }
        }
        valid.push(best);
        kept += 1;
      }
      rho *= RUNG_RATIO;
    }
    return { valid, notes, evaluated: tally.evaluated, calls: specIndex };
  };

  const attempt: DepthSearch['attempt'] = (spec, accept) => {
    // Charged here, not at the gate: the install half of an attempt costs a candidate even when a
    // structural gate refuses it before the exact test is reached.
    meter?.chargeCandidate();
    const metered: SurgeryAccept | undefined =
      accept === undefined || meter === undefined
        ? accept
        : (context: Parameters<SurgeryAccept>[0]): ReturnType<SurgeryAccept> => {
            meter.chargeExactTest();
            return accept(context);
          };
    const moved = movedOf(spec.anchor);
    const offsets = buildOffsets(spec) ?? [];
    const movedFans = pick(fans, moved);
    const movedRegions = pick(regions, moved);
    const result = tryReconstruct(
      mesh,
      vertex,
      movedFans,
      movedRegions,
      depth,
      offsets,
      movedFans.map(() => scale),
      metered,
      {
        minSeparation: 0,
        truncate: true,
        baselineCache,
      },
    );
    return { moved, movedFans, movedRegions, result };
  };

  return { kind: 'ready', search: { depth, scale, regions, entries, runChain, attempt } };
}

export function searchPinchSite(
  mesh: SurgeryMesh,
  vertex: number,
  options: PinchSearchOptions = {},
): SiteResult & { readonly pinch?: PinchOperation } {
  const cfg = { accept: options.accept, ...resolveSearchConfig(options) };
  const found = liveFans(mesh, vertex);
  const refuse = (
    reason: SurgeryRefusal,
    detail: string,
    attempts: number,
  ): SiteResult & { readonly pinch?: PinchOperation } => ({
    refusal: { vertex, reason, detail, attempts } satisfies SurgeryRefusalRecord,
  });
  if (found.refusal !== undefined) return refuse(found.refusal, '', 0);
  const fans = found.fans;
  if (fans.length < 2) return refuse(SurgeryRefusal.NoUsableDirection, 'already one fan', 0);

  const site = buildSiteContext(mesh, vertex, fans, cfg, options.meter);
  const { p } = site;
  const reasons = new Map<string, number>();
  const note = (reason: string): void => {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  };
  let totalEvaluated = 0;
  let totalExact = 0;
  let overlapAt = 0;

  for (let depth = cfg.minDepth; depth <= cfg.maxDepth; depth += 1) {
    const opened = openDepth(site, depth);
    if (opened.kind === 'overlap') {
      overlapAt = depth;
      break;
    }
    if (opened.kind === 'no-scale') continue;
    const { search } = opened;
    const { scale } = search;

    // Build the candidate list: run every chain and consume the results in the order the
    // search visits the chains, so the ranking tie-break (the evaluation index) is what a single
    // sequential loop would have assigned.
    const valid: Measured[] = [];
    let evaluated = 0;
    let specBase = 0;
    for (const entry of search.entries) {
      if (entry.job === undefined) {
        note(entry.note);
        continue;
      }
      const chain = search.runChain(entry.job);
      for (const reason of chain.notes) note(reason);
      for (const m of chain.valid) {
        valid.push({ ...m, spec: { ...m.spec, index: m.spec.index + specBase } });
      }
      evaluated += chain.evaluated;
      specBase += chain.calls;
    }
    totalEvaluated += evaluated;
    valid.sort(compareMeasured);

    // Spend the exact test in rank order.
    const limit = Math.min(valid.length, cfg.maxExactAttempts);
    for (let rank = 0; rank < limit; rank += 1) {
      const candidate = valid[rank];
      if (candidate === undefined) break;
      // A SAFE POINT: the previous attempt was rolled back.
      options.meter?.check();
      totalExact += 1;
      const { spec } = candidate;
      const { moved, movedFans, movedRegions, result } = search.attempt(spec, cfg.accept);
      if (typeof result === 'string') {
        note(result);
        continue;
      }
      const apexes = result.newVertices.slice(0, moved.length).map((v) => mesh.point(v));
      let separation = Infinity;
      const points = [...apexes, ...(spec.anchor >= 0 ? [p] : [])];
      for (let a = 0; a < points.length; a += 1) {
        for (let b = a + 1; b < points.length; b += 1) {
          separation = Math.min(separation, len(sub(points[a] ?? p, points[b] ?? p)));
        }
      }
      const operation: PinchOperation = {
        vertex,
        depth,
        scale: spec.rho,
        strategy: `${spec.kind}${spec.scheme === 'uniform' ? '' : `|${spec.scheme}`}${
          spec.anchor >= 0 ? `|anchor:${String(spec.anchor)}` : ''
        }`,
        removedFaces: result.removed,
        addedFaces: result.added,
        newVertices: result.newVertices,
        displacedInteriorVertices: result.interior,
        maxInteriorDisplacement: result.maxInterior,
        cycleSizes: movedRegions.map((r) => boundarySize(mesh, r.faces)),
        fanCount: fans.length,
        closedFans: fans.filter((f) => f.closed).length,
        meanIncidentEdge: movedFans.map(() => scale),
        apexSeparation: separation === Infinity ? 0 : separation,
        attempts: totalEvaluated,
        boundaryEdgesBefore: result.boundary,
        boundaryEdgesAfter: result.boundary,
        point: p,
        selection: {
          anchorFan: spec.anchor,
          kind: spec.kind,
          scheme: spec.scheme,
          rho: spec.rho,
          refined: spec.refined,
        },
        localScale: scale,
        movedFans: moved.length,
        displacementOverScale: spec.rho,
        fidelity: candidate.fidelity,
        qualityBefore: candidate.before,
        qualityAfter: candidate.after,
        candidatesEvaluated: totalEvaluated,
        candidatesValid: valid.length,
        exactAttempts: totalExact,
      };
      return { operation, pinch: operation };
    }
  }
  const detail = [...reasons.entries()].map(([k, n]) => `${k}×${String(n)}`).join(', ');
  if (overlapAt > 0 && reasons.size === 0) {
    return refuse(SurgeryRefusal.RegionOverlap, `at depth ${String(overlapAt)}`, totalEvaluated);
  }
  const byGate = [...reasons.keys()].some((k) => k.includes('intersect'));
  return refuse(
    byGate ? SurgeryRefusal.Rejected : SurgeryRefusal.NoUsableDirection,
    `${detail}${overlapAt > 0 ? `; regions met at depth ${String(overlapAt)}` : ''}`,
    totalEvaluated,
  );
}

function regionsMeet(regions: readonly FanRegion[], vertex: number, depth: number): boolean {
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i];
      const b = regions[j];
      if (a === undefined || b === undefined) continue;
      for (const f of a.faces) if (b.faces.has(f)) return true;
      for (const [v, k] of a.dist) {
        if (v === vertex) continue;
        const kb = b.dist.get(v);
        if (kb !== undefined && (k < depth || kb < depth)) return true;
      }
    }
  }
  return false;
}

type Box6 = [number, number, number, number, number, number];

function boxesMeet(a: Box6, b: Box6): boolean {
  return (
    a[0] <= b[3] && b[0] <= a[3] && a[1] <= b[4] && b[1] <= a[4] && a[2] <= b[5] && b[2] <= a[5]
  );
}

function growBox(box: Box6, p: Vec3): void {
  if (p[0] < box[0]) box[0] = p[0];
  if (p[1] < box[1]) box[1] = p[1];
  if (p[2] < box[2]) box[2] = p[2];
  if (p[0] > box[3]) box[3] = p[0];
  if (p[1] > box[4]) box[4] = p[1];
  if (p[2] > box[5]) box[5] = p[2];
}

function starBox(mesh: SurgeryMesh, vertex: number, rings: number): Box6 {
  const seen = new Set<number>([vertex]);
  let frontier = [vertex];
  const box: Box6 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  growBox(box, mesh.point(vertex));
  for (let ring = 0; ring <= rings; ring += 1) {
    const next: number[] = [];
    for (const v of frontier) {
      for (const f of mesh.facesAt(v)) {
        for (const x of mesh.corners(f)) {
          if (seen.has(x)) continue;
          seen.add(x);
          growBox(box, mesh.point(x));
          next.push(x);
        }
      }
    }
    frontier = next;
  }
  return box;
}

/**
 * Everything a refused attempt at `vertex` could have READ, as one box.
 *
 * Topology: the faces around every vertex within `rings` graph steps of the vertex (a region of
 * depth d touches vertices at distance <= d and consults the faces around them). Geometry: the
 * exact gate reads only faces whose boxes meet a box it queried (a patch or a removed face); when
 * the gate reports those boxes they are unioned in EXACTLY. When it cannot, the box is widened by
 * the largest displacement the search can propose, maxRho * L * (moved fans + 1), L being no
 * larger than the star's box diagonal. If no face appended or removed since the attempt meets
 * this box, the attempt would be repeated verbatim. A larger box can only cause an extra retry,
 * never a skipped one that would have differed.
 */
function dependencyBox(
  mesh: SurgeryMesh,
  vertex: number,
  rings: number,
  fallbackMarginRho: number,
  fanCount: number,
  reads: readonly number[] | undefined,
): Box6 {
  const box = starBox(mesh, vertex, rings);
  if (reads?.length === 6) {
    // The gate told us exactly where it looked: the union of its query boxes.
    growBox(box, [reads[0] ?? 0, reads[1] ?? 0, reads[2] ?? 0]);
    growBox(box, [reads[3] ?? 0, reads[4] ?? 0, reads[5] ?? 0]);
    return box;
  }
  const diagonal = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
  const margin = fallbackMarginRho * diagonal * (fanCount + 1) + diagonal;
  return [
    box[0] - margin,
    box[1] - margin,
    box[2] - margin,
    box[3] + margin,
    box[4] + margin,
    box[5] + margin,
  ];
}

export interface PinchSearchResult {
  readonly mesh: SurgeryMesh;
  readonly operations: readonly PinchOperation[];
  readonly refusals: readonly SurgeryRefusalRecord[];
  readonly passes: number;
  /** True when `cancelled` stopped the run before every site had been attempted. */
  readonly cancelled: boolean;
  /** Set when the work meter stopped the run at a safe point. */
  readonly limit: WorkLimitReached | undefined;
  /**
   * Sites never attempted because the run stopped (cancel or limit) during the FIRST pass. They
   * have no refusal record: nothing was decided about them.
   */
  readonly unattempted: readonly number[];
}

/**
 * The driver: ascending vertex id, live fans, a refused site retried only after progress and only
 * when something it could have read has changed.
 */
export function runPinchSearch(
  mesh: SurgeryMesh,
  targets: readonly number[],
  options: PinchSearchOptions = {},
): PinchSearchResult {
  const operations: PinchOperation[] = [];
  let pending = [...targets].sort((a, b) => a - b);
  const total = pending.length;
  const refused = new Map<number, SurgeryRefusalRecord>();
  // Retry bookkeeping: where each refused site's attempt could have looked, and what changed.
  const maxRho = options.maxRho ?? PINCH_SEARCH_DEFAULTS.maxRho;
  const rings = (options.maxDepth ?? PINCH_SEARCH_DEFAULTS.maxDepth) + 1;
  const dependency = new Map<number, { box: Box6; seq: number }>();
  const changes: Box6[] = [];
  let passes = 0;
  let attempted = 0;
  let cancelled = false;
  let limit: WorkLimitReached | undefined;
  let unattempted: number[] = [];
  const emit = (): void => {
    options.onProgress?.({
      pass: passes,
      total,
      attempted,
      accepted: operations.length,
      refused: refused.size,
    });
  };
  for (;;) {
    passes += 1;
    const next: number[] = [];
    let accepted = 0;
    let stoppedAt = -1;
    for (const [index, vertex] of pending.entries()) {
      if (options.cancelled?.() === true) {
        cancelled = true;
        stoppedAt = index;
        break;
      }
      // A SAFE POINT between two sites.
      if (options.meter?.exhausted() === true) {
        limit = new WorkLimitReached(options.meter.phase);
        stoppedAt = index;
        break;
      }
      if (liveFanCount(mesh, vertex) < 2) continue;
      const known = passes > 1 ? dependency.get(vertex) : undefined;
      if (known !== undefined) {
        let touched = false;
        for (let i = known.seq; i < changes.length && !touched; i += 1) {
          const change = changes[i];
          if (change !== undefined && boxesMeet(known.box, change)) touched = true;
        }
        if (!touched && refused.has(vertex)) {
          // Nothing the previous attempt could have read has changed: it would refuse again,
          // identically. Keep its record and skip the work.
          next.push(vertex);
          known.seq = changes.length;
          continue;
        }
      }
      options.acceptReads?.reset();
      attempted += 1;
      if (passes > 1) options.meter?.noteRetry();
      let result: ReturnType<typeof searchPinchSite>;
      try {
        result = searchPinchSite(mesh, vertex, options);
      } catch (error) {
        if (!(error instanceof WorkLimitReached)) throw error;
        // The limit was reached between two reconstructions of THIS site; the mesh is as it was
        // when the site opened. The site is abandoned, never half-applied.
        limit = error;
        stoppedAt = index;
        break;
      }
      if (result.pinch !== undefined) {
        operations.push(result.pinch);
        refused.delete(vertex);
        dependency.delete(vertex);
        accepted += 1;
        const changed: Box6 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (const f of [...result.pinch.removedFaces, ...result.pinch.addedFaces]) {
          for (const x of mesh.corners(f)) growBox(changed, mesh.point(x));
        }
        changes.push(changed);
      } else {
        next.push(vertex);
        if (result.refusal !== undefined) refused.set(vertex, result.refusal);
        // The mesh is exactly as it was before this attempt (refusals roll back), so the
        // dependency is taken from the state the attempt actually read.
        dependency.set(vertex, {
          box: dependencyBox(
            mesh,
            vertex,
            rings,
            maxRho,
            Math.max(1, liveFans(mesh, vertex).fans.length),
            options.acceptReads?.box(),
          ),
          seq: changes.length,
        });
      }
      if (attempted % PROGRESS_EVERY_ATTEMPTS === 0) emit();
    }
    if (stoppedAt >= 0) {
      const rest = pending.slice(stoppedAt);
      // Sites carried over from this pass keep whatever record they already had; in the FIRST pass
      // the ones never reached have none, and are reported as unattempted.
      if (passes === 1)
        unattempted = rest.filter((v) => !refused.has(v) && liveFanCount(mesh, v) >= 2);
    }
    pending = next;
    if (stoppedAt >= 0 || accepted === 0 || pending.length === 0) break;
  }
  emit();
  return {
    mesh,
    operations,
    refusals: [...refused.values()],
    passes,
    cancelled,
    limit,
    unattempted,
  };
}
