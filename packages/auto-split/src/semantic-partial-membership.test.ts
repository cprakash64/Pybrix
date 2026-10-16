import { it, expect } from 'vitest';
import type { Vec3, SemanticPart } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry, SemanticEvidence } from './semantic';
import type { FamilySignatures } from './semantic-family';
import {
  qualifyPartialFamilyMembership,
  type PartialFamilyMembership,
} from './semantic-partial-membership';
const part: SemanticPart = {
  id: 'family',
  label: 'Physical members',
  parentId: 'plate',
  importance: 'major',
  confidence: 0.99,
  instances: 6,
  views: [],
  componentIds: [],
  cut: null,
  expectedGeometry: { kind: 'repeated_part', likelySeparable: true },
};
function run(
  points: readonly Vec3[],
  options: { flat?: boolean; rotate?: boolean; cancel?: number } = {},
): PartialFamilyMembership {
  const rotate = (p: Vec3): Vec3 => {
    if (!options.rotate) return p;
    const x = p[0],
      y = p[1] * Math.cos(0.61) - p[2] * Math.sin(0.61),
      z = p[1] * Math.sin(0.61) + p[2] * Math.cos(0.61);
    return [x * Math.cos(0.37) - y * Math.sin(0.37), x * Math.sin(0.37) + y * Math.cos(0.37), z];
  };
  const basis = [rotate([1, 0, 0]), rotate([0, 1, 0]), rotate([0, 0, 1])],
    eigen = options.flat === false ? [0.1, 0.1, 0.1] : [0.2, 0.1, 0.0002],
    cov = (a: number, b: number): number =>
      basis.reduce((sum, v, k) => sum + (eigen[k] ?? 0) * (v[a] ?? 0) * (v[b] ?? 0), 0),
    moments = [cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2)];
  const centers: Vec3[] = [[0, 0, 0], ...points.map(rotate)],
    p = {
      facts: centers.map((centroid, rank) => ({
        rank,
        centroid,
        diagonal: rank === 0 ? 3 : 0.5,
        area: rank === 0 ? 10 : 1,
      })),
    } as unknown as PreparedSemanticGeometry;
  const data = {
    signatures: [{ rank: 0, moments, diagonal: 3 }],
    facesVisited: 0,
    bytes: 0,
  } as unknown as FamilySignatures;
  const evidence: SemanticEvidence[] = [
    {
      id: 'plate',
      components: [{ rank: 0, strongViews: 2, viewCoverage: [1, 1] }],
      multiViewFaces: 0,
      visibleFaces: 0,
      planePurity: null,
      reason: 'localized',
    },
  ];
  let polls = 0;
  return qualifyPartialFamilyMembership(
    p,
    part,
    points.map((_p, i) => i + 1),
    [
      {
        ...part,
        id: 'plate',
        instances: 1,
        expectedGeometry: { kind: 'solid_part', likelySeparable: true },
      },
      part,
    ],
    evidence,
    () => data,
    () => {
      if (options.cancel && ++polls === options.cancel) throw Error('cancel');
    },
    () => undefined,
  );
}
it('A: three coherent direct members of six remain partial with no inference', () => {
  expect(
    run([
      [-1, 0, 1],
      [0, 0, 1],
      [1, 0, 1],
    ]),
  ).toMatchObject({ qualifiedRanks: [1, 2, 3], rejectedRanks: [] });
});
it('B: two opposite direct members remain available', () => {
  expect(
    run([
      [-1, 0, 1],
      [1, 0, 1],
    ]).qualifiedRanks,
  ).toEqual([1, 2]);
});
it('excludes a clearly separated elevated member while keeping two lower direct members', () => {
  expect(
    run([
      [-1, 0, 1],
      [1, 0, 1],
      [0, 0.3, 3],
    ]),
  ).toMatchObject({ qualifiedRanks: [1, 2], rejectedRanks: [3] });
});
it('the same generic rule handles supports below a parent and upper outlier', () => {
  expect(
    run([
      [-1, 0, -1],
      [1, 0, -1],
      [0, 0, 3],
    ]).qualifiedRanks,
  ).toEqual([1, 2]);
});
it('C: no unique coherent structure publishes no arbitrary subset', () => {
  expect(
    run(
      [
        [0, 0, 0],
        [1, 0.2, 0.3],
        [0.2, 1, 0.8],
      ],
      { flat: false },
    ).qualifiedRanks,
  ).toEqual([]);
});
it('D: competing support clusters tied at two members refuse', () => {
  expect(
    run([
      [-1, 0, 1],
      [1, 0, 1],
      [-1, 0, 3],
      [1, 0, 3],
    ]).qualifiedRanks,
  ).toEqual([]);
});
it('E: one directly proven member retains conservative existing availability', () => {
  expect(run([[1, 0, 1]]).qualifiedRanks).toEqual([1]);
});
it('F: a rotated support frame is not a world-Z heuristic', () => {
  expect(
    run(
      [
        [-1, 0, 1],
        [1, 0, 1],
        [0, 0.3, 3],
      ],
      { rotate: true },
    ).qualifiedRanks,
  ).toEqual([1, 2]);
});
it('retains non-planar reflected arrangements without a flat parent frame', () => {
  expect(
    run(
      [
        [-1, -1, -1],
        [1, 1, 1],
        [-1, 1, 1],
        [1, -1, -1],
      ],
      { flat: false },
    ).qualifiedRanks,
  ).toEqual([1, 2, 3, 4]);
});
it('cancellation returns no partial membership decision', () => {
  expect(() =>
    run(
      [
        [-1, 0, 1],
        [1, 0, 1],
        [0, 0, 3],
      ],
      { cancel: 4 },
    ),
  ).toThrow('cancel');
});
