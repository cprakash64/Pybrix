import { expect, it } from 'vitest';
import {
  classifyInterfaceOwnershipSupport,
  type InterfaceObservationSupport,
} from './semantic-interface-ownership';
import { bindRepresentativeRefinement } from './semantic-local-plane';
import type { NormalizedGeometry } from './geometry';
import type { SemanticPlaneRefinement } from './semantic-plane';
import type { Vec3 } from '@cadfixer/auto-split-contract';

const observation = (
  view: InterfaceObservationSupport['view'],
  targetPixels: number,
  bodyPixels: number,
  unknownPixels: number,
): InterfaceObservationSupport => ({
  view,
  targetPixels,
  bodyPixels,
  unknownPixels,
  visiblePixels: targetPixels + bodyPixels + unknownPixels,
});
const classify = (rows: readonly InterfaceObservationSupport[], frontier = false) =>
  classifyInterfaceOwnershipSupport(rows, frontier);
it('retains UNKNOWN for sparse single-observation target support', () => {
  const result = classify([observation('rear', 11, 0, 2000)]);
  expect(result.ownership).toBe('AMBIGUOUS');
  expect(result.category).toBe('SPARSE_UNCORROBORATED');
});
it('accepts exhaustive direct target coverage even in one observation', () => {
  expect(classify([observation('rear', 3, 0, 0)]).ownership).toBe('TARGET_SIDE');
});
it('corroborates partial target support across independent axes', () => {
  expect(classify([observation('front', 8, 0, 100), observation('top', 8, 0, 300)]).ownership).toBe(
    'TARGET_SIDE',
  );
});
it('does not count opposite cameras as independent axes or subminimum pixels as an observation', () => {
  expect(
    classify([observation('front', 8, 0, 100), observation('rear', 8, 0, 100)]).ownership,
  ).toBe('AMBIGUOUS');
  expect(classify([observation('front', 8, 0, 100), observation('top', 7, 0, 300)]).ownership).toBe(
    'AMBIGUOUS',
  );
});
it('preserves accepted positive-frontier proof with zero direct target pixels', () => {
  const result = classify([observation('rear', 0, 0, 2000)], true);
  expect(result.ownership).toBe('TARGET_SIDE');
  expect(result.category).toBe('FRONTIER_CORROBORATED');
});
it('accepts explicit exhaustive BODY and corroborated BODY symmetrically', () => {
  expect(classify([observation('rear', 0, 3, 0)]).ownership).toBe('BODY_SIDE');
  expect(classify([observation('front', 0, 8, 100), observation('top', 0, 8, 300)]).ownership).toBe(
    'BODY_SIDE',
  );
});
it('retains UNKNOWN for sparse uncorroborated BODY pixels', () => {
  expect(classify([observation('rear', 0, 11, 2000)]).ownership).toBe('AMBIGUOUS');
});
it('retains conflicts including small direct contradiction of frontier evidence', () => {
  const direct = classify([observation('front', 8, 1, 100)]);
  expect(direct.conflict).toBe(true);
  expect(direct.category).toBe('CONFLICTED');
  expect(classify([observation('rear', 0, 1, 2000)], true).conflict).toBe(true);
});
it('never assigns absent semantic evidence to BODY', () => {
  expect(classify([observation('rear', 0, 0, 2000)]).ownership).toBe('AMBIGUOUS');
  expect(classify([]).category).toBe('UNKNOWN');
});
const geometry: NormalizedGeometry = {
  positions: new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  faceCount: 1,
  center: [0, 0, 0],
  scale: 1,
  radius: 2,
  extents: [2, 1, 0],
};
const profile: SemanticPlaneRefinement = {
  cut: { normal: [1, 0, 0], origin: [0.25, 0, 0] },
  proposedOffset: 0,
  chosenOffset: 0.25,
  proposedSectionLength: 1,
  chosenSectionLength: 0.75,
  samples: 9,
  profileNormal: [1, 0, 0],
  sectionProfile: Array.from({ length: 9 }, (_, i) => ({
    offset: (i - 4) / 8,
    length: 1 - Math.abs((i - 4) / 8),
  })),
  shoulderEvidence: { surfaceOffset: 0.1, featureOverflow: false, ownership: 'INCLUDED' },
};
it('binds replacement metadata to its own exact sampled section', () => {
  const cut = { normal: [1, 0, 0] as Vec3, origin: [0, 0, 0] as Vec3 };
  const result = bindRepresentativeRefinement(
    geometry,
    profile,
    cut,
    () => undefined,
    () => undefined,
  );
  expect(result.cut).toBe(cut);
  expect(result.chosenOffset).toBe(0);
  expect(result.chosenSectionLength).toBe(1);
  expect(result.proposedSectionLength).toBe(1);
  expect(result.shoulderEvidence).toBeUndefined();
  expect(profile.chosenSectionLength).toBe(0.75);
});
it('measures an existing unsampled representative without interpolating another cut metric', () => {
  let charged = 0;
  const result = bindRepresentativeRefinement(
    geometry,
    profile,
    { normal: [1, 0, 0], origin: [0.1, 0, 0] },
    () => undefined,
    () => charged++,
  );
  expect(result.chosenOffset).toBe(0.1);
  expect(result.chosenSectionLength).toBeCloseTo(0.9, 12);
  expect(charged).toBe(geometry.faceCount);
});
it('cancels metadata measurement and preserves source and profile on failure', () => {
  const before = geometry.positions.slice(),
    original = JSON.stringify(profile);
  expect(() =>
    bindRepresentativeRefinement(
      geometry,
      profile,
      { normal: [1, 0, 0], origin: [0.1, 0, 0] },
      () => {
        throw Error('cancelled');
      },
      () => undefined,
    ),
  ).toThrow('cancelled');
  expect(() =>
    bindRepresentativeRefinement(
      geometry,
      profile,
      { normal: [1, 0, 0], origin: [0.1, 0, 0] },
      () => undefined,
      () => {
        throw Error('budget');
      },
    ),
  ).toThrow('budget');
  expect(geometry.positions).toEqual(before);
  expect(JSON.stringify(profile)).toBe(original);
});
it('keeps the metadata binding invariant under a rigid change of coordinates', () => {
  const angle = 0.43,
    c = Math.cos(angle),
    s = Math.sin(angle),
    rotate = (p: Vec3): Vec3 => [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]],
    positions = geometry.positions.slice();
  for (let i = 0; i < positions.length; i += 3)
    positions.set(rotate([positions[i]!, positions[i + 1]!, positions[i + 2]!]), i);
  const normal = rotate([1, 0, 0]),
    origin = rotate([0.1, 0, 0]),
    rotatedProfile = { ...profile, profileNormal: normal };
  const result = bindRepresentativeRefinement(
    { ...geometry, positions },
    rotatedProfile,
    { normal, origin },
    () => undefined,
    () => undefined,
  );
  expect(result.chosenSectionLength).toBeCloseTo(0.9, 6);
});
