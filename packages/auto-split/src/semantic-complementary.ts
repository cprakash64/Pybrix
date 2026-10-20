import { required } from './required';
import {
  VIEW_NAMES,
  type SemanticHierarchy,
  type SemanticPart,
  type Vec3,
} from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import { pointInSemanticPolygon } from './semantic';
import {
  LOCAL_PLANE_LIMITS,
  semanticPlaneScorer,
  type LocalPlaneProposal,
  type PlaneOwnershipContext,
} from './semantic-local-plane';
import type { Checkpoint } from './checkpoint';

/** Prospective bounds; all candidates originate in ordinary bounded synthesis. */
export const COMPLEMENTARY_LIMITS = Object.freeze({
  // Consumed axis pairs: 0 degrees; independently sampled oblique development pair: 0.174 degrees.
  normalDot: -Math.cos(Math.PI / 720),
  offsetDistance: 0.025,
  unionCoverage: 0.95,
  overlap: 0.02,
  candidates: 6,
  finalists: 3,
});
export interface ComplementarySiblingPair {
  readonly key: string;
  readonly primaryId: string;
  readonly complementId: string;
  readonly parentId: string | null;
  readonly rank: number;
  readonly independentAxes: number;
  readonly candidates: number;
  readonly compatibility: 'PRIMARY' | 'RESERVE';
  readonly reserveCandidates: number;
}
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const opposite = (p: LocalPlaneProposal['cut']): LocalPlaneProposal['cut'] => ({
  normal: [-p.normal[0], -p.normal[1], -p.normal[2]],
  origin: p.origin,
});
const key = (p: LocalPlaneProposal['cut']): string =>
  [...p.normal, dot(p.normal, p.origin)].map((n) => n.toFixed(10)).join('/');
const compatible = (a: LocalPlaneProposal['cut'], b: LocalPlaneProposal['cut']): boolean =>
  dot(a.normal, b.normal) <= COMPLEMENTARY_LIMITS.normalDot &&
  Math.abs(dot(a.normal, a.origin) + dot(b.normal, b.origin)) <=
    COMPLEMENTARY_LIMITS.offsetDistance;
const withinBoth = (
  p: LocalPlaneProposal['cut'],
  a: LocalPlaneProposal['cut'],
  b: LocalPlaneProposal['cut'],
): boolean =>
  dot(p.normal, a.normal) >= -COMPLEMENTARY_LIMITS.normalDot &&
  dot(p.normal, b.normal) <= COMPLEMENTARY_LIMITS.normalDot &&
  Math.abs(dot(p.normal, p.origin) - dot(p.normal, a.origin)) <=
    COMPLEMENTARY_LIMITS.offsetDistance &&
  Math.abs(dot(p.normal, p.origin) - dot(p.normal, b.origin)) <=
    COMPLEMENTARY_LIMITS.offsetDistance;
const eligible = (p: SemanticPart): boolean =>
  p.importance === 'major' && p.instances === 1 && p.expectedGeometry.kind === 'solid_part';

/** Resolve the entire compatibility graph before selecting any edge: record order cannot select a peer. */
export function reconcileComplementarySiblings(
  prepared: PreparedSemanticGeometry,
  answer: SemanticHierarchy,
  proposals: Map<string, LocalPlaneProposal>,
  checkpoint: Checkpoint,
  context: PlaneOwnershipContext,
): {
  pairs: readonly ComplementarySiblingPair[];
  ambiguous: ReadonlySet<string>;
  diagnostic?: 'AMBIGUOUS_COMPLEMENTARY_PAIR';
  discoveryMilliseconds: number;
  crossScoreMilliseconds: number;
} {
  const discoveryStarted = Date.now();
  const parts = answer.parts
    .filter((p) => eligible(p) && proposals.has(p.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges: { a: SemanticPart; b: SemanticPart; rank: number; axes: number; third: boolean }[] =
    [];
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      checkpoint();
      const a = required(parts[i], 'pair primary'),
        b = required(parts[j], 'pair complement'),
        ap = required(proposals.get(a.id), 'primary proposal'),
        bp = required(proposals.get(b.id), 'complement proposal');
      if (
        a.parentId !== b.parentId ||
        ap.scope !== 'part' ||
        bp.scope !== 'part' ||
        ap.ownership.rule !== 'CLEAN_PHYSICAL_EXTENT' ||
        bp.ownership.rule !== 'CLEAN_PHYSICAL_EXTENT'
      )
        continue;
      const peer = (p: LocalPlaneProposal, id: string): boolean =>
        p.ownership.peers.some(
          (x) => x.id === id && x.sameSourceComponent && x.independentAxes >= 2,
        );
      if (
        !peer(ap, b.id) ||
        !peer(bp, a.id) ||
        (!compatible(ap.cut, bp.cut) &&
          !(ap.compatibilityReserve ?? []).some((ac) => {
            checkpoint();
            return (
              ac.independentComplement &&
              (bp.compatibilityReserve ?? []).some((bc) => {
                checkpoint();
                return bc.independentComplement && compatible(ac, bc);
              })
            );
          }))
      )
        continue;
      const totals = new Map<number, number>();
      const rows: {
        vi: number;
        rank: number;
        total: number;
        a: number;
        b: number;
        union: number;
        overlap: number;
        third: number;
      }[] = [];
      for (const [vi, view] of VIEW_NAMES.entries()) {
        const av = a.views.find((v) => v.view === view),
          bv = b.views.find((v) => v.view === view);
        if (!av || !bv) continue;
        const third = answer.parts
          .filter(
            (p) =>
              p.id !== a.id &&
              p.id !== b.id &&
              p.parentId === a.parentId &&
              p.importance === 'major',
          )
          .map((p) => p.views.find((v) => v.view === view));
        const raster = required(prepared.rasters[vi], 'pair raster');
        const byRank = new Map<number, (typeof rows)[number]>();
        for (let y = 8; y < raster.size; y += LOCAL_PLANE_LIMITS.sampleStride) {
          checkpoint();
          for (let x = 8; x < raster.size; x += LOCAL_PLANE_LIMITS.sampleStride) {
            context.telemetry.workUnits++;
            context.charge();
            const face = raster.face[y * raster.size + x] ?? -1;
            if (face < 0) continue;
            const rank = prepared.labelling.faceRank[face] ?? -1;
            if (rank < 0) continue;
            let row = byRank.get(rank);
            if (!row) {
              row = { vi, rank, total: 0, a: 0, b: 0, union: 0, overlap: 0, third: 0 };
              byRank.set(rank, row);
            }
            const hit = (v: SemanticPart['views'][number] | undefined): boolean =>
              v?.polygons.some((poly) =>
                pointInSemanticPolygon((x + 0.5) / raster.size, (y + 0.5) / raster.size, poly),
              ) ?? false;
            const ah = hit(av),
              bh = hit(bv);
            row.total++;
            if (ah) row.a++;
            if (bh) row.b++;
            if (ah || bh) row.union++;
            if (ah && bh) row.overlap++;
            if (third.some(hit)) row.third++;
          }
        }
        for (const row of byRank.values()) {
          rows.push(row);
          totals.set(row.rank, (totals.get(row.rank) ?? 0) + row.a + row.b);
        }
      }
      const ranked = [...totals].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const rank = ranked[0]?.[0];
      if (rank === undefined) continue;
      const all = rows.reduce((s, r) => s + r.a + r.b, 0);
      if ((totals.get(rank) ?? 0) < all * 0.95) continue;
      const supported = rows.filter(
        (r) =>
          r.rank === rank &&
          r.a >= 8 &&
          r.b >= 8 &&
          r.union / r.total >= COMPLEMENTARY_LIMITS.unionCoverage &&
          r.overlap / Math.max(1, r.union) <= COMPLEMENTARY_LIMITS.overlap,
      );
      const axes = new Set(supported.map((r) => Math.floor(r.vi / 2))).size;
      if (axes < 2) continue;
      edges.push({
        a,
        b,
        rank,
        axes,
        third: rows.some((r) => r.rank === rank && r.third >= 8 && r.third / r.total > 0.02),
      });
    }
  const degree = new Map<string, number>();
  for (const e of edges) for (const p of [e.a, e.b]) degree.set(p.id, (degree.get(p.id) ?? 0) + 1);
  const ambiguous = new Set<string>();
  for (const e of edges)
    if ((degree.get(e.a.id) ?? 0) > 1 || (degree.get(e.b.id) ?? 0) > 1) {
      ambiguous.add(e.a.id);
      ambiguous.add(e.b.id);
    }
  const discoveryMilliseconds = Date.now() - discoveryStarted;
  const scoringStarted = Date.now();
  const pairs: ComplementarySiblingPair[] = [];
  for (const e of edges) {
    checkpoint();
    if (e.third || ambiguous.has(e.a.id) || ambiguous.has(e.b.id)) continue;
    const ap = required(proposals.get(e.a.id), 'primary proposal'),
      bp = required(proposals.get(e.b.id), 'complement proposal');
    const useReserve = !compatible(ap.cut, bp.cut);
    const candidates = (
      p: LocalPlaneProposal,
    ): readonly (LocalPlaneProposal['cut'] & {
      provenance?: LocalPlaneProposal['provenance'];
      support?: number;
    })[] =>
      (useReserve
        ? (p.compatibilityReserve ?? [])
            .filter((candidate) => candidate.independentComplement)
            .toSorted((a, b) => (b.support ?? 0) - (a.support ?? 0) || key(a).localeCompare(key(b)))
        : [
            { ...p.cut, ...(p.provenance ? { provenance: p.provenance } : {}) },
            ...(p.finalists ?? []),
          ]
      )
        .filter((cut, i, all) => all.findIndex((q) => key(q) === key(cut)) === i)
        .slice(
          0,
          useReserve ? LOCAL_PLANE_LIMITS.compatibilityReserve : LOCAL_PLANE_LIMITS.finalists,
        );
    const ac = candidates(ap),
      bc = candidates(bp);
    const pool = [
      ...ac.filter((a) => !useReserve || bc.some((b) => compatible(a, b))),
      ...bc
        .filter((b) => !useReserve || ac.some((a) => compatible(a, b)))
        .map((p) => ({
          ...opposite(p),
          ...(p.support !== undefined ? { support: p.support } : {}),
          ...(p.provenance ? { provenance: p.provenance } : {}),
        })),
    ]
      .filter((p, i, all) => all.findIndex((q) => key(q) === key(p)) === i)
      .filter((p) =>
        useReserve
          ? ac.some((a) => bc.some((b) => compatible(a, b) && withinBoth(p, a, b)))
          : withinBoth(p, ap.cut, bp.cut),
      )
      .sort((a, b) =>
        useReserve ? (b.support ?? 0) - (a.support ?? 0) || key(a).localeCompare(key(b)) : 0,
      )
      .slice(0, COMPLEMENTARY_LIMITS.candidates);
    const scoreA = semanticPlaneScorer(prepared, answer, e.a, ap, checkpoint, context),
      scoreB = semanticPlaneScorer(prepared, answer, e.b, bp, checkpoint, context);
    const scored = pool.flatMap((cut) => {
      checkpoint();
      const a = scoreA(cut),
        b = scoreB(opposite(cut));
      // Both sides must pass the existing ownership scorer at this exact cut.
      // The graph's silhouette-overlap bound is not an additional per-view
      // leakage threshold for independently rasterized boundary observations.
      return a && b
        ? [
            {
              cut,
              a: { ...a, ...(cut.provenance ? { provenance: cut.provenance } : {}) },
              b: { ...b, ...(cut.provenance ? { provenance: cut.provenance } : {}) },
            },
          ]
        : [];
    });
    const quality = (p: LocalPlaneProposal): number =>
      Math.min(
        p.confidence,
        p.ownership.targetRecall,
        p.ownership.semanticPurity,
        1 - p.ownership.worstPeerLeakage,
      );
    scored.sort(
      (x, y) =>
        Math.min(quality(y.a), quality(y.b)) - Math.min(quality(x.a), quality(x.b)) ||
        key(x.cut).localeCompare(key(y.cut)),
    );
    const finalists = scored.slice(0, COMPLEMENTARY_LIMITS.finalists),
      best = finalists[0];
    if (!best) continue;
    const install = (id: string, side: 'a' | 'b'): void => {
      const primary = best[side];
      proposals.set(id, {
        ...primary,
        finalists: finalists.map((x) => ({
          ...x[side].cut,
          independentComplement: true,
          capturedFraction: x[side].capturedFraction,
          ...(x[side].provenance ? { provenance: x[side].provenance } : {}),
        })),
      });
    };
    install(e.a.id, 'a');
    install(e.b.id, 'b');
    pairs.push({
      key: JSON.stringify([e.a.id, e.b.id]),
      primaryId: e.a.id,
      complementId: e.b.id,
      parentId: e.a.parentId ?? null,
      rank: e.rank,
      independentAxes: e.axes,
      candidates: pool.length,
      compatibility: useReserve ? 'RESERVE' : 'PRIMARY',
      reserveCandidates: useReserve ? ac.length + bc.length : 0,
    });
  }
  checkpoint();
  const crossScoreMilliseconds = Date.now() - scoringStarted;
  return {
    pairs,
    ambiguous,
    ...(ambiguous.size ? { diagnostic: 'AMBIGUOUS_COMPLEMENTARY_PAIR' as const } : {}),
    discoveryMilliseconds,
    crossScoreMilliseconds,
  };
}
