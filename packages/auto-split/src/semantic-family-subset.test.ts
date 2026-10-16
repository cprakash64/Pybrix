import { required } from './required';
import { it, expect } from 'vitest';
import type { SemanticPart, Vec3 } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import { resolveSemanticFamilySubset } from './semantic-family-subset';
import type { FamilySignature, FamilyPolygon, FamilyScore } from './semantic-family';
const part: SemanticPart = {
  id: 'members',
  label: 'Members',
  parentId: null,
  importance: 'major',
  confidence: 0.99,
  instances: 4,
  views: [],
  componentIds: [],
  cut: null,
  expectedGeometry: { kind: 'repeated_part', likelySeparable: true },
};
function fixture(extra: readonly Vec3[] = [[0, 0, 10]]): {
  p: PreparedSemanticGeometry;
  signatures: FamilySignature[];
  polygons: FamilyPolygon[];
  scores: FamilyScore[];
} {
  const centers: Vec3[] = [[-4, -3, 0], [-4, 3, 0], [4, -3, 0], [4, 3, 0], ...extra],
    signatures: FamilySignature[] = centers.map((c, rank) => ({
      rank,
      dimensions: [1, 1, 2],
      area: 10,
      faces: 12,
      moments: [0],
      support: [0],
      volume: 0.1,
      diagonal: Math.sqrt(6),
      lo: c.map((x) => x - 0.5) as unknown as Vec3,
      hi: c.map((x) => x + 0.5) as unknown as Vec3,
    })),
    p = { facts: centers.map((centroid) => ({ centroid })) } as unknown as PreparedSemanticGeometry,
    polygons: FamilyPolygon[] = [0, 1].flatMap((rank) =>
      [0, 1].map((view) => ({
        view,
        ranks: [rank],
        purity: 1,
        pixels: 100,
        support: [{ rank, pixels: 100 }],
      })),
    ),
    scores: FamilyScore[] = centers.map((_c, rank) => ({
      rank,
      strongViews: rank < 2 ? 2 : 0,
      viewCoverage: rank < 2 ? [1, 1, -1, -1, -1, -1] : [-1, -1, -1, -1, -1, -1],
    }));
  return { p, signatures, polygons, scores };
}
function run(
  f = fixture(),
  patch: Partial<SemanticPart> = {},
  anchors: readonly number[] = [0, 1],
): ReturnType<typeof resolveSemanticFamilySubset> {
  return resolveSemanticFamilySubset(
    f.p,
    { ...part, ...patch },
    anchors,
    f.scores,
    f.polygons,
    () => ({ signatures: f.signatures, facesVisited: 0, bytes: 0 }),
    () => undefined,
    () => undefined,
  );
}
it('A: uniquely recovers four anchored members and positively excludes upper outlier', () => {
  expect(run()).toMatchObject({ ranks: [0, 1, 2, 3], excluded: [4], propagated: [2, 3] });
});
it('B/F: same-plane plausible distractors or tied subsets remain refused', () => {
  expect(
    run(
      fixture([
        [0, 5, 0],
        [0, -5, 0],
      ]),
    )?.ranks,
  ).toEqual([]);
});
it('C: one direct independent anchor never permits inference', () => {
  expect(run(fixture(), {}, [0])).toBeUndefined();
});
it('D: wrong count cannot trim this pattern', () => {
  expect(run(fixture(), { instances: 3 })?.ranks).toEqual([]);
});
it('E: non-transitive equivalent neighbourhood is refused', () => {
  const f = fixture();
  f.signatures[1] = { ...required(f.signatures[1], 'test signature'), moments: [0.0029] };
  f.signatures[2] = { ...required(f.signatures[2], 'test signature'), moments: [-0.0029] };
  expect(run(f)?.ranks).toEqual([]);
});
it('G: every returned subset must retain all direct anchors', () => {
  expect(run(fixture(), {}, [0, 4])?.ranks).toEqual([]);
});
it('H: family regions substantially overlapping foreign body are refused', () => {
  const f = fixture();
  f.polygons.push({
    view: 2,
    ranks: [0, 99],
    purity: 0.5,
    pixels: 200,
    support: [
      { rank: 0, pixels: 100 },
      { rank: 99, pixels: 100 },
    ],
  });
  expect(run(f)?.ranks).toEqual([]);
});
it('refuses excess classes larger than N+2', () => {
  expect(
    run(
      fixture([
        [0, 0, 10],
        [0, 0, 20],
        [0, 0, 30],
      ]),
    )?.ranks,
  ).toEqual([]);
});
it('requires non-overlapping isolated bounds and multiple family views', () => {
  const f = fixture();
  f.signatures[2] = {
    ...required(f.signatures[2], 'test signature'),
    lo: [-10, -10, -10],
    hi: [10, 10, 10],
  };
  expect(run(f)?.ranks).toEqual([]);
  const g = fixture();
  g.polygons = g.polygons.filter((p) => p.view === 0);
  expect(run(g)?.ranks).toEqual([]);
});
it('bounds enumerated subsets and cancels before publishing', () => {
  const f = fixture();
  let visits = 0;
  expect(() =>
    resolveSemanticFamilySubset(
      f.p,
      part,
      [0, 1],
      f.scores,
      f.polygons,
      () => ({ signatures: f.signatures, facesVisited: 0, bytes: 0 }),
      () => {
        if (++visits === 12) throw Error('cancel');
      },
      () => undefined,
    ),
  ).toThrow('cancel');
  expect(run()?.subsets).toBeLessThanOrEqual(64);
});
it('refuses combinatorial classes before evaluating more than64 subsets', () => {
  const f = fixture(),
    prototype = required(f.signatures[0], 'prototype');
  f.signatures = Array.from({ length: 22 }, (_, rank) => ({
    ...prototype,
    rank,
    lo: [rank * 3, 0, 0] as Vec3,
    hi: [rank * 3 + 1, 1, 1] as Vec3,
  }));
  f.p = {
    facts: f.signatures.map((s) => ({ centroid: [s.rank * 3, 0, 0] })),
  } as unknown as PreparedSemanticGeometry;
  expect(run(f, { instances: 20 })).toMatchObject({
    ranks: [],
    subsets: 0,
    reason: 'Subset enumeration ceiling',
  });
});
