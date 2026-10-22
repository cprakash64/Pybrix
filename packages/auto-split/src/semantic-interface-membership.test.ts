import { expect, it } from 'vitest';
import type { NormalizedGeometry } from './geometry';
import type { SuggestedPlane } from './suggestions';
import {
  interfaceTriangleFraction,
  interfaceMembershipSignature,
  type MaterialInterface,
} from './semantic-interface-membership';
const geometry: NormalizedGeometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  faceCount: 1,
  center: [0, 0, 0],
  scale: 1,
  radius: 1,
  extents: [1, 1, 0],
};
const region: MaterialInterface = {
  faces: [0],
  normal: [0, 0, 1],
  offset: 0,
  area: 0.5,
  sourceFacesInspected: 1,
  clippedOperations: 0,
  scratchBytes: 4,
};
const plane = (offset: number): SuggestedPlane => ({ normal: [1, 0, 0], origin: [offset, 0, 0] });
it('clips the original triangle fraction rather than assigning a straddler as a whole face', () => {
  expect(interfaceTriangleFraction(geometry, 0, plane(0.5))).toBeCloseTo(0.25, 12);
  const signature = interfaceMembershipSignature(
    geometry,
    region,
    plane(0.5),
    () => {},
    () => {},
  );
  expect(signature.ownership).toBe('INTERMEDIATE');
  expect(signature.partialFaces).toBe(1);
  expect(signature.selectedArea).toBeCloseTo(0.125, 12);
  expect(signature.excludedArea).toBeCloseTo(0.375, 12);
});
it('distinguishes complete ownership classes including the exact edge boundary', () => {
  expect(
    interfaceMembershipSignature(
      geometry,
      region,
      plane(0),
      () => {},
      () => {},
    ).ownership,
  ).toBe('TARGET_SIDE');
  expect(
    interfaceMembershipSignature(
      geometry,
      region,
      plane(1),
      () => {},
      () => {},
    ).ownership,
  ).toBe('BODY_SIDE');
});
it('checks cancellation while constructing membership without mutating the input', () => {
  const before = geometry.positions.slice();
  expect(() =>
    interfaceMembershipSignature(
      geometry,
      region,
      plane(0.5),
      () => {
        throw Error('cancelled');
      },
      () => {},
    ),
  ).toThrow('cancelled');
  expect(geometry.positions).toEqual(before);
});
