import { it, expect } from 'vitest';
import { structuralSeamEvidence, seamSupportsPlane } from './semantic-seam';
import type { SemanticPlaneRefinement } from './semantic-plane';
const profile = (lengths: readonly number[]): SemanticPlaneRefinement => ({
  cut: { normal: [1, 0, 0], origin: [0, 0, 0] },
  profileNormal: [1, 0, 0],
  proposedOffset: 0,
  chosenOffset: 0,
  proposedSectionLength: lengths[4] ?? 0,
  chosenSectionLength: lengths[4] ?? 0,
  samples: 9,
  sectionProfile: lengths.map((length, i) => ({ offset: ((i - 4) * 0.025) / 4, length })),
});
it('constant section, gradual taper, isolated sample and missing profile provide no seam', () => {
  for (const lengths of [
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8],
    [1, 1, 1, 1, 4, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 4],
  ])
    expect(structuralSeamEvidence(profile(lengths), () => undefined).admitted).toBe(false);
  expect(structuralSeamEvidence(undefined, () => undefined).admitted).toBe(false);
});
it('reuses bounded section shoulders on both orientations without treating zero as a minimum', () => {
  for (const lengths of [
    [1, 1, 1, 1, 1, 1, 1, 7, 7],
    [1, 1, 1, 1, 0, 7, 7, 7, 7],
    [7, 7, 7, 7, 0, 1, 1, 1, 1],
  ])
    expect(structuralSeamEvidence(profile(lengths), () => undefined)).toMatchObject({
      admitted: true,
      reason: 'STABLE_SECTION_STEP',
    });
  expect(
    structuralSeamEvidence(profile([1, 1, 1, 1, 0, 1, 1, 1, 1]), () => undefined).admitted,
  ).toBe(false);
});
it('honors cancellation before publishing any evidence', () => {
  expect(() =>
    structuralSeamEvidence(profile([1, 1, 1, 1, 1, 7, 7, 7, 7]), () => {
      throw Error('cancel');
    }),
  ).toThrow('cancel');
});
it('a stable two-sided neck is positive; an isolated dip or competing equal minima are not', () => {
  expect(
    structuralSeamEvidence(profile([7, 7, 1, 1, 1, 1, 1, 7, 7]), () => undefined),
  ).toMatchObject({ admitted: true, reason: 'STABLE_SECTION_MINIMUM' });
  expect(
    structuralSeamEvidence(profile([7, 7, 7, 7, 1, 7, 7, 7, 7]), () => undefined).admitted,
  ).toBe(false);
  expect(
    structuralSeamEvidence(profile([7, 7, 1, 1, 7, 1, 1, 7, 7]), () => undefined).admitted,
  ).toBe(false);
});

it('a section proof never certifies rotated or out-of-profile fallback planes', () => {
  const r = profile([7, 7, 1, 1, 1, 1, 1, 7, 7]),
    e = structuralSeamEvidence(r, () => undefined);
  expect(seamSupportsPlane(r, { normal: [1, 0, 0], origin: [0, 0, 0] }, e)).toBe(true);
  expect(seamSupportsPlane(r, { normal: [-1, 0, 0], origin: [0, 0, 0] }, e)).toBe(true);
  expect(seamSupportsPlane(r, { normal: [0, 1, 0], origin: [0, 0, 0] }, e)).toBe(false);
  expect(seamSupportsPlane(r, { normal: [1, 0, 0], origin: [0.02, 0, 0] }, e)).toBe(false);
  expect(seamSupportsPlane(r, { normal: [1, 0, 0], origin: [-0.02, 0, 0] }, e)).toBe(false);
});
