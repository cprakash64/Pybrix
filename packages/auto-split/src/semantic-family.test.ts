import { required } from './required';
import { describe, it, expect } from 'vitest';
import { fixtureDeflate } from './fixtures/deflate';
import { box, concatMeshes } from './fixtures';
import { prepareSemanticGeometry, type PreparedSemanticGeometry } from './semantic';
import {
  completeSemanticFamily,
  familySignatures,
  type FamilyPolygon,
  type FamilyScore,
  type FamilySignatures,
  type FamilyCompletion,
} from './semantic-family';
import type { SemanticPart } from '@cadfixer/auto-split-contract';
const part: SemanticPart = {
  id: 'supports',
  label: 'supports',
  parentId: null,
  importance: 'major',
  confidence: 0.99,
  instances: 6,
  componentIds: [],
  cut: null,
  expectedGeometry: { kind: 'repeated_part', likelySeparable: true },
  views: [],
};
interface FamilyFixture {
  p: PreparedSemanticGeometry;
  signatures: FamilySignatures;
  ranks: number[];
  scores: FamilyScore[];
  polygons: FamilyPolygon[];
}
async function fixture(n = 6, variation = 'none'): Promise<FamilyFixture> {
  const pieces = [
    box([-7, -4, 5], [7, 4, 6]),
    ...Array.from({ length: n }, (_, i) => {
      const x = ((i % 3) - 1) * 4,
        y = (Math.floor(i / 3) - 0.5) * 4;
      return variation === 'decorative' && i === 5
        ? box([x - 2, y - 0.35, 1], [x + 2, y + 0.35, 1.7])
        : box(
            [x - 0.35, y - 0.35, 0],
            [x + 0.35, y + 0.35, variation === 'sizes' && i >= 4 ? 3 : 4],
          );
    }),
  ];
  const prepared = await prepareSemanticGeometry(concatMeshes(pieces), fixtureDeflate),
    signatures = familySignatures(prepared, () => undefined),
    ranks = prepared.facts.filter((f) => f.rank !== 0).map((f) => f.rank);
  const p = { facts: prepared.facts } as PreparedSemanticGeometry;
  const scores: FamilyScore[] = ranks.map((rank, i) => ({
    rank,
    strongViews: i < 2 ? 2 : 1,
    viewCoverage: i < 2 ? [1, 1, -1, -1, -1, -1] : [1, 0, -1, -1, -1, -1],
  }));
  const polygons: FamilyPolygon[] = ranks.map((rank, i) => ({
    ranks: [rank],
    purity: 1,
    view: i % 4,
  }));
  return { p, signatures, ranks, scores, polygons };
}
const complete = (
  f: FamilyFixture,
  patch: Partial<SemanticPart> = {},
): FamilyCompletion | undefined =>
  completeSemanticFamily(
    f.p,
    { ...part, ...patch },
    [],
    f.scores,
    f.polygons,
    () => f.signatures,
    () => undefined,
  );
describe('semantically anchored exact family completion', () => {
  it('admits six directly grounded instances distributed across independent views', async () => {
    const f = await fixture();
    f.scores = f.scores.map((s) => ({ ...s, strongViews: 1 }));
    const result = complete(f);
    expect(result?.ranks).toEqual(f.ranks);
    expect(new Set(result?.ranks).size).toBe(6);
  });
  it('preserves strong anchors and resolves a pure family mask without individual polygons for each member', async () => {
    const f = await fixture();
    f.polygons = f.polygons.slice(0, 2);
    f.polygons.push({
      view: 2,
      ranks: f.ranks,
      purity: 1 / 6,
      pixels: 600,
      support: f.ranks.map((rank) => ({ rank, pixels: 100 })),
    });
    const result = complete(f);
    expect(result?.ranks).toEqual(f.ranks);
    expect(result?.anchors).toEqual(f.ranks.slice(0, 2));
  });
  it('completes an omitted member only with exact count, distributed anchors and full spatial extent', async () => {
    const f = await fixture();
    f.polygons = f.polygons.filter((poly) => poly.ranks[0] !== f.ranks[5]);
    f.scores = f.scores.map((score) =>
      score.rank === f.ranks[5]
        ? { ...score, strongViews: 0, viewCoverage: [0, 0, -1, -1, -1, -1] }
        : score,
    );
    expect(complete(f)?.ranks).toEqual(f.ranks);
  });
  it('cannot guess a class from an adjacent localized subset that fails spatial coverage', async () => {
    const f = await fixture();
    const first = required(f.p.facts[f.ranks[0] ?? -1], 'first anchor').centroid;
    const anchors = f.ranks.filter((r) => (f.p.facts[r]?.centroid[1] ?? 0) === first[1]);
    f.polygons = anchors.flatMap((rank) =>
      [0, 1, 2].map((view) => ({ rank, view, ranks: [rank], purity: 1 })),
    );
    f.scores = f.scores.map((score) => ({
      ...score,
      strongViews: anchors.includes(score.rank) ? 2 : 0,
    }));
    expect(complete(f)?.ranks ?? []).toEqual([]);
  });
  it('refuses two plausible repeated sets instead of selecting an arbitrary exact-count subset', async () => {
    expect(complete(await fixture(12))?.ranks ?? []).toEqual([]);
  });
  it('refuses overlapping non-transitive shape classes', async () => {
    const f = await fixture();
    const center =
      required(
        f.signatures.signatures.find((s) => s.rank === f.ranks[0]),
        'signature',
      ).moments[0] ?? 0;
    f.signatures = {
      ...f.signatures,
      signatures: f.signatures.signatures.map((s) =>
        f.ranks.includes(s.rank)
          ? {
              ...s,
              moments: s.moments.map((v, i) =>
                i === 0
                  ? center + (s.rank === f.ranks[1] ? 0.002 : s.rank === f.ranks[2] ? -0.002 : 0)
                  : v,
              ),
            }
          : s,
      ),
    };
    expect(complete(f)?.ranks ?? []).toEqual([]);
  });
  it('refuses five legs plus a decorative support', async () => {
    expect(complete(await fixture(6, 'decorative'))?.ranks ?? []).toEqual([]);
  });
  it('refuses six equivalent components when four are declared', async () => {
    expect(complete(await fixture(), { instances: 4 })?.ranks ?? []).toEqual([]);
  });
  it('does not bypass contradictory family-count evidence when four initial members already map', async () => {
    const f = await fixture();
    const result = completeSemanticFamily(
      f.p,
      { ...part, instances: 4 },
      f.ranks.slice(0, 4),
      f.scores,
      f.polygons,
      () => f.signatures,
      () => undefined,
    );
    expect(result?.ranks ?? []).toEqual([]);
  });
  it.each([4, 6])(
    'audits a fully mapped coarse family of %i without requiring isolated anchors',
    async (count) => {
      const f = await fixture();
      const initial = f.ranks.slice(0, count);
      const result = completeSemanticFamily(
        f.p,
        { ...part, instances: count },
        initial,
        f.scores,
        [{ view: 0, ranks: initial, purity: 1 / count }],
        () => f.signatures,
        () => undefined,
      );
      if (count === 4) {
        expect(result).toBeDefined();
        expect(result?.ranks).toEqual([]);
      } else expect(result).toBeUndefined();
    },
  );
  it('refuses two differently sized members', async () => {
    expect(complete(await fixture(6, 'sizes'))?.ranks ?? []).toEqual([]);
  });
  it('refuses a family mask that includes the seat/body', async () => {
    const f = await fixture();
    f.polygons.push({
      view: 5,
      ranks: [0, ...f.ranks],
      purity: 0.5,
      pixels: 1200,
      support: [{ rank: 0, pixels: 600 }, ...f.ranks.map((rank) => ({ rank, pixels: 100 }))],
    });
    expect(complete(f)?.ranks ?? []).toEqual([]);
  });
  it('refuses a single semantic anchor', async () => {
    const f = await fixture();
    f.scores = f.scores.map((s, i) => ({ ...s, strongViews: i === 0 ? 2 : 0 }));
    f.polygons = f.polygons.slice(0, 1);
    expect(complete(f)?.ranks ?? []).toEqual([]);
  });
  it('refuses duplicated instance regions', async () => {
    const f = await fixture();
    f.polygons.push(required(f.polygons[0], 'direct region'));
    expect(complete(f)?.ranks ?? []).toEqual([]);
  });
  it('refuses a missing physical sibling', async () => {
    expect(complete(await fixture(5))?.ranks ?? []).toEqual([]);
  });
  it('refuses a near-symmetric equivalent distractor instead of finding a best subset', async () => {
    expect(complete(await fixture(7))?.ranks ?? []).toEqual([]);
  });
  it('refuses overlapping component candidates', async () => {
    const f = await fixture(),
      a = required(
        f.signatures.signatures.find((s) => s.rank === f.ranks[0]),
        'signature',
      );
    f.signatures = {
      ...f.signatures,
      signatures: f.signatures.signatures.map((s) =>
        s.rank === f.ranks[1] ? { ...s, lo: a.lo, hi: a.hi } : s,
      ),
    };
    expect(complete(f)?.ranks ?? []).toEqual([]);
  });
  it('cancellation during geometric completion publishes no family', async () => {
    const f = await fixture();
    let calls = 0;
    expect(() =>
      completeSemanticFamily(
        f.p,
        part,
        [],
        f.scores,
        f.polygons,
        () => f.signatures,
        () => {
          if (++calls === 2) throw new Error('cancelled');
        },
      ),
    ).toThrow('cancelled');
  });
});
