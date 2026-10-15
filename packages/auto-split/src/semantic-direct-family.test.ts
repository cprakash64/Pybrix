import { describe, expect, it } from 'vitest';
import type { SemanticPart } from '@cadfixer/auto-split-contract';
import { directSemanticFamily, type DirectSemanticFamily } from './semantic-direct-family';
import type { FamilyPolygon, FamilyScore } from './semantic-family';
const part: SemanticPart = {
  id: 'family',
  label: 'Physical members',
  parentId: null,
  importance: 'major',
  confidence: 0.99,
  instances: 5,
  views: [],
  componentIds: [],
  cut: null,
  expectedGeometry: { kind: 'repeated_part', likelySeparable: true },
};
function fixture(direct: number, others = 1): { scores: FamilyScore[]; polygons: FamilyPolygon[] } {
  const scores: FamilyScore[] = Array.from({ length: direct + others }, (_, rank) => ({
    rank,
    strongViews: rank < direct ? 2 : 0,
    viewCoverage: rank < direct ? [1, 1, -1, -1, -1, -1] : [0, 0, -1, -1, -1, -1],
  }));
  const polygons: FamilyPolygon[] = Array.from({ length: direct }, (_, rank) =>
    [0, 1].map((view) => ({
      view,
      ranks: [rank],
      purity: 1,
      pixels: 100,
      support: [{ rank, pixels: 100 }],
    })),
  ).flat();
  return { scores, polygons };
}
const run = (
  f: ReturnType<typeof fixture>,
  patch: Partial<SemanticPart> = {},
): DirectSemanticFamily =>
  directSemanticFamily(
    { ...part, ...patch },
    f.scores,
    f.polygons,
    () => undefined,
    () => undefined,
  );
describe('independent direct semantic membership', () => {
  it('A: selects five direct legs and excludes the unclaimed similar post', () => {
    expect(run(fixture(5)).ranks).toEqual([0, 1, 2, 3, 4]);
    expect(run(fixture(5)).state).toBe('COMPLETE');
  });
  it('B: four direct of five with two ambiguous unobserved supports stay partial', () => {
    const r = run(fixture(4, 2));
    expect(r.state).toBe('PARTIAL');
    expect(r.ranks).toEqual([0, 1, 2, 3]);
  });
  it('C: duplicate same-view instance polygons refuse the duplicated member', () => {
    const f = fixture(5);
    const first = f.polygons[0];
    if (!first) throw Error('Missing test polygon');
    f.polygons.push(first);
    expect(run(f).ranks).toEqual([1, 2, 3, 4]);
  });
  it('D: four direct wheels exclude the spare independently of shape', () => {
    expect(run(fixture(4), { instances: 4 })).toMatchObject({
      state: 'COMPLETE',
      ranks: [0, 1, 2, 3],
    });
  });
  it('E: three direct wheels cannot infer a fourth from two unobserved circles', () => {
    expect(run(fixture(3, 2), { instances: 4 })).toMatchObject({
      state: 'PARTIAL',
      ranks: [0, 1, 2],
    });
  });
  it('F: a supplied direct footprint overlapping body refuses that member', () => {
    const f = fixture(5);
    f.polygons[0] = {
      view: 0,
      ranks: [0, 5],
      purity: 0.6,
      pixels: 100,
      support: [
        { rank: 0, pixels: 60 },
        { rank: 5, pixels: 40 },
      ],
    };
    expect(run(f).ranks).not.toContain(0);
  });
  it('G: coarse family masks with no isolated instances cannot use the direct path', () => {
    const f = fixture(5);
    f.polygons = [0, 1].map((view) => ({ view, ranks: [0, 1, 2, 3, 4], purity: 0.2 }));
    expect(run(f)).toMatchObject({ state: 'NONE', ranks: [] });
  });
  it('refuses an equally grounded extra candidate rather than selecting the first N', () => {
    expect(run(fixture(6))).toMatchObject({ state: 'AMBIGUOUS', ranks: [] });
  });
  it('zero support in an additional view is omission, while positive partial support refuses', () => {
    const f = fixture(5);
    f.scores[0] = { rank: 0, strongViews: 2, viewCoverage: [1, 1, 0, -1, -1, -1] };
    expect(run(f).ranks).toContain(0);
    f.scores[0] = { rank: 0, strongViews: 2, viewCoverage: [1, 1, 0.5, -1, -1, -1] };
    expect(run(f).ranks).not.toContain(0);
  });
  it.each(['surface_part', 'unknown'] as const)('does not realize %s family roles', (kind) => {
    expect(run(fixture(5), { expectedGeometry: { kind, likelySeparable: true } }).ranks).toEqual(
      [],
    );
  });
  it('requires two independent pure polygon views per member', () => {
    const f = fixture(5);
    f.polygons = f.polygons.filter((p) => p.view === 0);
    expect(run(f).ranks).toEqual([]);
  });
  it('low confidence produces no direct operations', () => {
    expect(run(fixture(5), { confidence: 0.89 }).ranks).toEqual([]);
  });
  it.each([1, 15, 40])('cancellation at work checkpoint %i returns no partial result', (limit) => {
    const f = fixture(5);
    let calls = 0,
      result: unknown;
    expect(() => {
      result = directSemanticFamily(
        part,
        f.scores,
        f.polygons,
        () => {
          if (++calls === limit) throw Error('CANCELLED');
        },
        () => undefined,
      );
    }).toThrow('CANCELLED');
    expect(result).toBeUndefined();
    expect(f.scores).toHaveLength(6);
  });
  it('accounts compact work without a new typed raster or shape comparisons', () => {
    let charged = 0;
    const f = fixture(5);
    const r = directSemanticFamily(
      part,
      f.scores,
      f.polygons,
      () => undefined,
      () => {
        charged++;
      },
    );
    expect(r.workUnits).toBe(charged);
    expect(r.scratchBytes).toBe(0);
    expect(r.evaluated).toBe(6);
  });
});
