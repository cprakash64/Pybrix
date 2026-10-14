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
import type { Checkpoint } from './checkpoint';

export const LOCAL_PLANE_LIMITS = Object.freeze({
  sampleStride: 16,
  normals: 32,
  offsets: 64,
  sectionFaces: 8192,
  finalists: 3,
});
interface Observation {
  point: Vec3;
  view: number;
  target: boolean;
  peer: boolean;
  conflict: boolean;
  rank: number;
  peerMask: number;
}
export interface LocalPlaneProposal {
  readonly cut: { readonly normal: Vec3; readonly origin: Vec3 };
  readonly confidence: number;
  readonly scope: 'assembly';
  readonly alignment: 'focused' | 'broad';
  readonly samples: number;
  readonly candidates: number;
  readonly sectionSamples: number;
  readonly capturedFraction: number;
  readonly views: readonly {
    readonly view: number;
    readonly recall: number;
    readonly exclusion: number;
    readonly rawPurity: number;
    readonly agreement: number;
  }[];
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
function observations(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  part: SemanticPart,
  checkpoint: Checkpoint,
): Observation[] {
  const result: Observation[] = [];
  const byId = new Map(answer.parts.map((p) => [p.id, p]));
  const ancestor = (a: string, b: SemanticPart): boolean => {
    let p = b.parentId;
    for (let depth = 0; p !== null && depth < 4; depth++) {
      if (p === a) return true;
      p = byId.get(p)?.parentId ?? null;
    }
    return false;
  };
  const peers = answer.parts.filter(
    (p) =>
      p.id !== part.id &&
      p.importance === 'major' &&
      p.instances === 1 &&
      !ancestor(p.id, part) &&
      !ancestor(part.id, p),
  );
  for (const region of part.views) {
    const vi = VIEW_NAMES.indexOf(region.view),
      raster = defined(prepared.rasters[vi]);
    const camera = cameraFor(region.view),
      k = (raster.size * FRAME_FILL) / (2 * prepared.geometry.radius);
    for (let y = 8; y < raster.size; y += LOCAL_PLANE_LIMITS.sampleStride) {
      checkpoint();
      for (let x = 8; x < raster.size; x += LOCAL_PLANE_LIMITS.sampleStride) {
        const f = raster.face[y * raster.size + x] ?? -1,
          depth = raster.depth?.[y * raster.size + x];
        if (f < 0 || depth === undefined || !Number.isFinite(depth)) continue;
        const nx = (x + 0.5) / raster.size,
          ny = (y + 0.5) / raster.size,
          u = (x + 0.5 - raster.size / 2) / k,
          w = -(y + 0.5 - raster.size / 2) / k;
        const target = region.polygons.some((poly) => pointInSemanticPolygon(nx, ny, poly)),
          peerFlags = peers.map((p) =>
            p.views.some(
              (v) =>
                v.view === region.view &&
                v.polygons.some((poly) => pointInSemanticPolygon(nx, ny, poly)),
            ),
          );
        const peer = peerFlags.some(Boolean);
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
          rank: prepared.labelling.faceRank[f] ?? -1,
          peerMask: peerFlags.reduce((mask, inside, i) => (inside ? mask | (1 << i) : mask), 0),
          target,
          peer: peer && !target,
          conflict: peer && target,
        });
      }
    }
  }
  // A shared backbone can span several assemblies. Use the most spatially contrasting peer along
  // the model's measured principal direction, rather than treating every unlabelled/shared surface
  // as negative. Exact-part silhouette agreement remains a separate, preferred hypothesis.
  const axis = principal(result.map((p) => p.point))[0] ?? [1, 0, 0];
  const center = mean(result.filter((p) => p.target).map((p) => p.point));
  let best = -1,
    gap = 0;
  peers.forEach((_p, i) => {
    const points = result.filter((p) => (p.peerMask & (1 << i)) !== 0).map((p) => p.point);
    if (points.length < 8) return;
    const d = Math.abs(dot(mean(points), axis) - dot(center, axis));
    if (d > gap) {
      gap = d;
      best = i;
    }
  });
  for (const p of result) p.peer = !p.target && best >= 0 && (p.peerMask & (1 << best)) !== 0;
  return result;
}
interface Counts {
  selected: number;
  target: number;
  hit: number;
  peer: number;
  peerSelected: number;
}
function evaluate(
  points: readonly Observation[],
  normal: Vec3,
  offset: number,
  cached?: Counts[],
):
  | {
      confidence: number;
      focus: 'focused' | 'broad';
      fraction: number;
      views: LocalPlaneProposal['views'];
    }
  | undefined {
  const counts =
    cached ??
    Array.from({ length: 6 }, () => ({ selected: 0, target: 0, hit: 0, peer: 0, peerSelected: 0 }));
  let selected = cached ? cached.reduce((sum, r) => sum + r.selected, 0) : 0;
  if (!cached)
    for (const p of points) {
      const row = defined(counts[p.view]),
        inside = dot(p.point, normal) >= offset;
      if (inside) {
        selected++;
        row.selected++;
      }
      if (p.target) row.target++;
      if (p.peer) row.peer++;
      if (inside && p.target) row.hit++;
      if (inside && p.peer) row.peerSelected++;
    }
  const fraction = selected / points.length;
  if (fraction <= 0.02 || fraction >= 0.98) return undefined;
  const views = counts.flatMap((r, view) =>
    r.target >= 8 && r.selected >= 8
      ? [
          {
            view,
            recall: r.hit / r.target,
            exclusion: r.peer >= 8 ? 1 - r.peerSelected / r.peer : r.hit / r.selected,
            rawPurity: r.hit / r.selected,
            agreement: 0,
          },
        ]
      : [],
  );
  for (const v of views) v.agreement = Math.min(v.recall, v.exclusion);
  if (
    views.length < 2 ||
    views.filter((v) => v.agreement >= SEMANTIC_WORK_LIMITS.planePurity).length < 2 ||
    views.some((v) => v.agreement < 0.55)
  )
    return undefined;
  const confidence = views.reduce((s, v) => s + v.agreement, 0) / views.length;
  if (confidence < SEMANTIC_WORK_LIMITS.planePurity) return undefined;
  // Unlabelled surface is unknown, not evidence of another part. Peer exclusion is separately normalized
  // so a large target mask cannot overwhelm a smaller contradictory semantic peer.
  const raw = views.reduce((s, v) => s + Math.min(v.recall, v.rawPurity), 0) / views.length;
  return {
    confidence,
    focus: raw >= SEMANTIC_WORK_LIMITS.planePurity ? 'focused' : 'broad',
    fraction,
    views,
  };
}
/** Read-only, region-driven proposals. Neither a hint nor separability flag grants execution. */
export function synthesizeSemanticPlane(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  part: SemanticPart,
  checkpoint: Checkpoint,
): LocalPlaneProposal | undefined {
  if (
    part.importance !== 'major' ||
    part.instances !== 1 ||
    part.expectedGeometry.kind === 'surface_part' ||
    part.views.length < 2 ||
    Math.min(answer.object.confidence, part.confidence) < SEMANTIC_WORK_LIMITS.semanticConfidence
  )
    return undefined;
  const points = observations(prepared, answer, part, checkpoint),
    target = points.filter((p) => p.target).map((p) => p.point),
    negative = points.filter((p) => p.peer).map((p) => p.point);
  if (target.length < 32 || target.length / Math.max(1, points.length) >= 0.995) return undefined;
  if (points.filter((p) => p.conflict).length > target.length * 0.72) return undefined;
  const coarse = new Map<number, { total: number[]; hit: number[] }>();
  for (const p of points) {
    const row = coarse.get(p.rank) ?? { total: [0, 0, 0, 0, 0, 0], hit: [0, 0, 0, 0, 0, 0] };
    row.total[p.view] = (row.total[p.view] ?? 0) + 1;
    if (p.target) row.hit[p.view] = (row.hit[p.view] ?? 0) + 1;
    coarse.set(p.rank, row);
  }
  const exactRanks = [...coarse]
    .filter(
      ([rank, row]) =>
        rank < prepared.metadata.components.length &&
        row.total.filter(
          (n, vi) => n >= 8 && (row.hit[vi] ?? 0) / n >= SEMANTIC_WORK_LIMITS.coverage,
        ).length >= 2,
    )
    .map(([rank]) => rank);
  const exactShare = exactRanks.reduce(
    (sum, rank) => sum + (prepared.facts[rank]?.areaShare ?? 0),
    0,
  );
  if (
    exactShare > 0 &&
    exactShare < 0.995 &&
    points.filter((p) => p.target && exactRanks.includes(p.rank)).length / target.length >= 0.72
  )
    return undefined;
  const normals: Vec3[] = [];
  const add = (raw: Vec3): void => {
    const n = unit(raw);
    if (
      n &&
      normals.length < LOCAL_PLANE_LIMITS.normals &&
      !normals.some((x) => Math.abs(dot(x, n)) > 0.999)
    )
      normals.push(n);
  };
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) add([x, y, z]);
  for (const n of principal(target)) add(n);
  for (const n of principal(points.map((p) => p.point))) add(n);
  const a = mean(target),
    b = mean(negative);
  add([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
  if (part.cut) add(part.cut.normal);
  const candidates: {
    normal: Vec3;
    offset: number;
    score: NonNullable<ReturnType<typeof evaluate>>;
    section: number;
  }[] = [];
  for (const normal of normals) {
    checkpoint();
    const projected = points.map((p) => dot(p.point, normal)),
      lo = Math.min(...projected),
      hi = Math.max(...projected);
    if (hi - lo < 1e-9) continue;
    const hist = Array.from({ length: 6 }, () => ({
      all: new Uint32Array(LOCAL_PLANE_LIMITS.offsets),
      target: new Uint32Array(LOCAL_PLANE_LIMITS.offsets),
      peer: new Uint32Array(LOCAL_PLANE_LIMITS.offsets),
    }));
    points.forEach((p, i) => {
      if (i % 4096 === 0) checkpoint();
      const bin = Math.min(
          LOCAL_PLANE_LIMITS.offsets - 1,
          Math.floor(((defined(projected[i]) - lo) / (hi - lo)) * LOCAL_PLANE_LIMITS.offsets),
        ),
        h = defined(hist[p.view]);
      h.all[bin] = (h.all[bin] ?? 0) + 1;
      if (p.target) h.target[bin] = (h.target[bin] ?? 0) + 1;
      if (p.peer) h.peer[bin] = (h.peer[bin] ?? 0) + 1;
    });
    const totals = hist.map((h) => ({
        all: h.all.reduce((a, b) => a + b, 0),
        target: h.target.reduce((a, b) => a + b, 0),
        peer: h.peer.reduce((a, b) => a + b, 0),
      })),
      below = totals.map(() => ({ all: 0, target: 0, peer: 0 }));
    for (let bin = 1; bin < LOCAL_PLANE_LIMITS.offsets; bin++) {
      if ((bin & 7) === 0) checkpoint();
      hist.forEach((h, vi) => {
        const b = defined(below[vi]);
        b.all += h.all[bin - 1] ?? 0;
        b.target += h.target[bin - 1] ?? 0;
        b.peer += h.peer[bin - 1] ?? 0;
      });
      const offset = lo + ((hi - lo) * bin) / LOCAL_PLANE_LIMITS.offsets;
      for (const side of [1, -1]) {
        const n = vector(normal.map((x) => x * side)),
          d = offset * side,
          counts = totals.map((t, vi) => {
            const b = defined(below[vi]);
            return {
              selected: side === 1 ? t.all - b.all : b.all,
              target: t.target,
              hit: side === 1 ? t.target - b.target : b.target,
              peer: t.peer,
              peerSelected: side === 1 ? t.peer - b.peer : b.peer,
            };
          }),
          score = evaluate(points, n, d, counts);
        if (score) candidates.push({ normal: n, offset: d, score, section: 0 });
      }
    }
  }
  if (part.cut) {
    const n = unit(part.cut.normal);
    if (n)
      for (const side of [1, -1]) {
        const normal = vector(n.map((v) => v * side)),
          offset = dot(part.cut.origin, normal),
          score = evaluate(points, normal, offset);
        if (score) candidates.push({ normal, offset, score, section: 0 });
      }
  }
  // Bound the section stage before touching source triangles. Semantic agreement ranks the beam;
  // section complexity then chooses between comparably supported alternatives, never an unsupported cut.
  candidates.sort(
    (a, b) =>
      Number(a.score.focus === 'broad') - Number(b.score.focus === 'broad') ||
      b.score.confidence - a.score.confidence ||
      a.offset - b.offset,
  );
  const beam: typeof candidates = [];
  for (const candidate of candidates) {
    if (!beam.some((other) => Math.abs(dot(other.normal, candidate.normal)) > 0.995))
      beam.push(candidate);
    if (beam.length >= LOCAL_PLANE_LIMITS.finalists) break;
  }
  const stride = Math.max(
    1,
    Math.ceil(prepared.geometry.faceCount / LOCAL_PLANE_LIMITS.sectionFaces),
  );
  for (const c of beam) {
    checkpoint();
    for (let f = 0; f < prepared.geometry.faceCount; f += stride) {
      if (f % (stride * 256) === 0) checkpoint();
      let lo = Infinity,
        hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        const i = (prepared.geometry.indices[f * 3 + k] ?? 0) * 3,
          v =
            dot(
              [
                prepared.geometry.positions[i] ?? 0,
                prepared.geometry.positions[i + 1] ?? 0,
                prepared.geometry.positions[i + 2] ?? 0,
              ],
              c.normal,
            ) - c.offset;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (lo < 0 && hi > 0) c.section++;
    }
  }
  beam.sort(
    (a, b) =>
      a.section - b.section || b.score.confidence - a.score.confidence || a.offset - b.offset,
  );
  const winner = beam[0];
  if (!winner) return undefined;
  return {
    cut: { normal: winner.normal, origin: vector(winner.normal.map((x) => x * winner.offset)) },
    confidence: winner.score.confidence,
    scope: 'assembly',
    alignment: winner.score.focus,
    samples: points.length,
    candidates: candidates.length,
    sectionSamples: winner.section,
    capturedFraction: winner.score.fraction,
    views: winner.score.views,
  };
}

/** Recheck a geometry-refined prior against the same local semantic evidence. */
export function confirmSemanticPlane(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  part: SemanticPart,
  cut: NonNullable<SemanticPart['cut']>,
  previous: LocalPlaneProposal,
  checkpoint: Checkpoint,
): LocalPlaneProposal | undefined {
  const points = observations(prepared, answer, part, checkpoint),
    normal = unit(cut.normal);
  if (!normal) return undefined;
  const score = evaluate(points, normal, dot(cut.origin, normal));
  return score
    ? {
        ...previous,
        cut,
        confidence: score.confidence,
        scope: 'assembly',
        alignment: score.focus,
        capturedFraction: score.fraction,
        views: score.views,
      }
    : undefined;
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required bounded geometry evidence is missing.');
  return value;
}
