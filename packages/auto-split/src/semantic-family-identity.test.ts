import { expect, it } from 'vitest';
import type { SemanticPart, Vec3 } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry, SemanticEvidence } from './semantic';
import type { FamilySignatures } from './semantic-family';
import { qualifyPartialFamilyMembership } from './semantic-partial-membership';
import { qualifyFamilyIdentity, type FamilyIdentityEvidence } from './semantic-family-identity';
const part: SemanticPart = {
  id: 'family',
  label: 'Repeated members',
  parentId: 'host',
  importance: 'major',
  confidence: 0.99,
  instances: 4,
  componentIds: [],
  views: [],
  expectedGeometry: { kind: 'repeated_part', likelySeparable: true },
  cut: null,
};
function run(
  points: readonly Vec3[],
  direct: number[],
  options: {
    physicalOnly?: boolean;
    foreignShape?: number;
    duplicate?: boolean;
    noThinHost?: boolean;
    noHost?: boolean;
    orthogonalPair?: boolean;
    opposedPair?: boolean;
    cancel?: number;
    confidence?: number;
  } = {},
): FamilyIdentityEvidence {
  const p = {
    facts: [[0, 0, 0], ...points].map((centroid, rank) => ({
      centroid,
      rank,
      area: rank ? 8 : 100,
      diagonal: rank ? 2 : 10,
    })),
  } as unknown as PreparedSemanticGeometry;
  const data = {
    signatures: p.facts.map((_fact, rank) => ({
      rank,
      dimensions: rank === options.foreignShape ? [4, 1, 2] : [1, 1, 2],
      area: 8,
      faces: 12,
      volume: 0.1,
      diagonal: rank ? 2 : 10,
      moments:
        rank === 0
          ? options.noThinHost
            ? [0.1, 0, 0, 0.1, 0, 0.1]
            : [0.2, 0, 0, 0.1, 0, 0.0001]
          : [0.1, 0, 0, 0.1, 0, 0.1],
      support: [0, 0, 0, 0, 0, 0],
      lo: _fact.centroid.map((v, a) => v - (a === 2 ? 1 : 0.5)),
      hi: _fact.centroid.map((v, a) => v + (a === 2 ? 1 : 0.5)),
    })),
  } as unknown as FamilySignatures;
  const role = { ...part, confidence: options.confidence ?? part.confidence },
    e = {
      id: 'family',
      components: points.map((_, i) => ({
        rank: i + 1,
        strongViews: direct.includes(i + 1) ? 2 : 1,
        viewCoverage: [1, 1],
      })),
      regionInstances: points.flatMap((_, i) =>
        (options.orthogonalPair
          ? ['front', 'left']
          : options.opposedPair
            ? ['front', 'rear']
            : [i === 0 || options.duplicate ? 'front' : 'rear']
        ).map((view) => ({ view, polygon: options.duplicate ? 0 : i, ranks: [i + 1], purity: 1 })),
      ),
      multiViewFaces: 0,
      visibleFaces: 0,
      planePurity: null,
      reason: 'localized',
    } as unknown as SemanticEvidence;
  let polls = 0;
  const checkpoint = (): void => {
    if (options.cancel && ++polls === options.cancel) throw Error('cancel');
  };
  const membership = qualifyPartialFamilyMembership(
    p,
    role,
    direct,
    options.noHost ? [role] : [{ ...part, id: 'host', instances: 1 }, role],
    [
      {
        id: 'host',
        components: [{ rank: 0, strongViews: 2, viewCoverage: [1, 1] }],
        multiViewFaces: 0,
        visibleFaces: 0,
        planePurity: null,
        reason: 'localized',
      },
    ],
    () => data,
    () => undefined,
    () => undefined,
  );
  return qualifyFamilyIdentity(
    p,
    role,
    e,
    membership,
    [
      {
        id: 'family',
        scope: options.physicalOnly ? 'PHYSICAL_PART' : 'QUALIFIED_FAMILY',
        components: points.map((_, i) => i + 1),
        multiViewComponents: direct,
        corroboratedComponents: points.map((_, i) => i + 1).filter((r) => !direct.includes(r)),
      },
    ],
    () => data,
    checkpoint,
    () => undefined,
  );
}
it('isolated singleton cannot corroborate its own mapping/reservation', () => {
  expect(run([[1, 0, 1]], [1]).qualifiedRanks).toEqual([]);
});
it('generic physical reservations never corroborate family identity', () => {
  expect(
    run(
      [
        [-1, 0, 1],
        [1, 0, 1],
      ],
      [1],
      { physicalOnly: true },
    ).qualifiedRanks,
  ).toEqual([]);
});
it('distinct qualified sibling observations preserve a true singleton without adding children', () => {
  const r = run(
    [
      [-2, 0, 1],
      [0, 2, 1],
      [2, 0, 1],
    ],
    [1],
  );
  expect(r.qualifiedRanks).toEqual([1]);
  expect(r.familyRanks).toEqual([1, 2, 3]);
  expect(r.witnesses).toEqual([
    { candidate: 1, corroborator: 2 },
    { candidate: 1, corroborator: 3 },
  ]);
});
it('foreign singleton contradicted by a lower independently observed family member is refused', () => {
  expect(
    run(
      [
        [1, 0, 5],
        [-1, 0, 1],
      ],
      [1],
    ).qualifiedRanks,
  ).toEqual([]);
});
it('duplicated observation identity is never independent corroboration', () => {
  expect(
    run(
      [
        [-1, 0, 1],
        [1, 0, 1],
      ],
      [1],
      { duplicate: true },
    ).qualifiedRanks,
  ).toEqual([]);
});
it('two direct intended members mutually corroborate with independent regions and host support', () => {
  expect(
    run(
      [
        [-1, 0, 1],
        [1, 0, 1],
      ],
      [1, 2],
    ).qualifiedRanks,
  ).toEqual([1, 2]);
});
it('two source-exact components with incompatible family shapes are refused', () => {
  expect(
    run(
      [
        [-1, 0, 1],
        [1, 0, 1],
      ],
      [1, 2],
      { foreignShape: 2 },
    ).qualifiedRanks,
  ).toEqual([]);
});
it('two direct members on contradictory support levels do not define their own family', () => {
  expect(
    run(
      [
        [-1, 0, 1],
        [1, 0, 5],
      ],
      [1, 2],
    ).qualifiedRanks,
  ).toEqual([]);
});
it('two reflected members can use an independent isotropic host rather than a third member', () => {
  expect(
    run(
      [
        [-2, 0, 0],
        [2, 0, 0],
      ],
      [1, 2],
      { noThinHost: true },
    ).qualifiedRanks,
  ).toEqual([1, 2]);
});
it('the pair mean itself is not an independent spatial reference', () => {
  expect(
    run(
      [
        [-2, 0, 1],
        [2, 0, 1],
      ],
      [1, 2],
      { noThinHost: true },
    ).qualifiedRanks,
  ).toEqual([]);
});
it('low-confidence family reservation cannot establish identity', () => {
  expect(
    run(
      [
        [-1, 0, 1],
        [1, 0, 1],
      ],
      [1],
      { confidence: 0.8 },
    ).qualifiedRanks,
  ).toEqual([]);
});
it('corroboration cancellation returns no partially built identity result', () => {
  expect(() =>
    run(
      [
        [-1, 0, 1],
        [1, 0, 1],
      ],
      [1],
      { cancel: 3 },
    ),
  ).toThrow('cancel');
});

it('two direct members with orthogonal instance projections need no third host component', () => {
  expect(
    run(
      [
        [-2, -1, 1],
        [2, 1, 1],
      ],
      [1, 2],
      { noHost: true, orthogonalPair: true },
    ).qualifiedRanks,
  ).toEqual([1, 2]);
});
it('two arbitrary same-axis observations do not establish a hostless pair', () => {
  expect(
    run(
      [
        [-2, -1, 1],
        [2, 1, 1],
      ],
      [1, 2],
      { noHost: true, opposedPair: true },
    ).qualifiedRanks,
  ).toEqual([]);
});
