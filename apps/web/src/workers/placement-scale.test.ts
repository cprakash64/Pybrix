import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import { uniformPhysicalScale } from './placement-scale';

/*
 * Release 2, Slice 2D — which placements may carry a connector. The canonical transform is twelve numbers: three basis vectors
 * (the columns of the linear part) and then the translation. Only a SIMILARITY has one physical scale; everything else is NaN,
 * and the connector code refuses on NaN (`UNSUPPORTED_TRANSFORM`).
 */
type T12 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
const linear = (
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  t: [number, number, number] = [0, 0, 0],
): T12 => [...a, ...b, ...c, ...t];
// a rotation of 36.87 degrees about Y (sin 0.6, cos 0.8), exact enough that its axes are unit length and orthogonal
const ROT_Y = (s: number): T12 => linear([0.8 * s, 0, -0.6 * s], [0, s, 0], [0.6 * s, 0, 0.8 * s]);

describe('uniformPhysicalScale — the placements that may carry a connector', () => {
  it('identity is scale 1', () => {
    expect(uniformPhysicalScale(IDENTITY_PART_TRANSFORM)).toBe(1);
  });
  it('a translation does not change it, however far', () => {
    expect(uniformPhysicalScale(linear([1, 0, 0], [0, 1, 0], [0, 0, 1], [100, -50, 30]))).toBe(1);
    expect(uniformPhysicalScale(linear([1, 0, 0], [0, 1, 0], [0, 0, 1], [1e9, -1e9, 1e9]))).toBe(1);
  });
  it('a rotation is scale 1 (a quarter turn about X, and an oblique turn about Y)', () => {
    expect(uniformPhysicalScale(linear([1, 0, 0], [0, 0, 1], [0, -1, 0]))).toBe(1);
    expect(uniformPhysicalScale(ROT_Y(1))).toBeCloseTo(1, 12);
  });
  it('a uniform scale is that scale, alone or with a rotation and a translation', () => {
    for (const s of [0.5, 2, 4, 25.4])
      expect(uniformPhysicalScale(linear([s, 0, 0], [0, s, 0], [0, 0, s]))).toBe(s);
    const turned = ROT_Y(2);
    turned[9] = 7;
    turned[10] = 8;
    turned[11] = 9;
    expect(uniformPhysicalScale(turned)).toBeCloseTo(2, 12);
  });
  it('a reflection is a similarity: it preserves every distance', () => {
    expect(uniformPhysicalScale(linear([-1, 0, 0], [0, 1, 0], [0, 0, 1]))).toBe(1);
    expect(uniformPhysicalScale(linear([-3, 0, 0], [0, 3, 0], [0, 0, 3]))).toBe(3);
  });
  it('a non-uniform scale is NaN, along any axis, and a turn does not hide it', () => {
    expect(uniformPhysicalScale(linear([2, 0, 0], [0, 1, 0], [0, 0, 1]))).toBeNaN();
    expect(uniformPhysicalScale(linear([1, 0, 0], [0, 2, 0], [0, 0, 1]))).toBeNaN();
    expect(uniformPhysicalScale(linear([1, 0, 0], [0, 1, 0], [0, 0, 0.5]))).toBeNaN();
    const turned = ROT_Y(1);
    turned[4] = 1.5;
    expect(uniformPhysicalScale(turned)).toBeNaN();
  });
  it('a shear is NaN: the axes are no longer orthogonal, even when they keep their lengths', () => {
    expect(uniformPhysicalScale(linear([1, 0, 0], [0.5, 1, 0], [0, 0, 1]))).toBeNaN();
    // two unit axes 60 degrees apart: equal lengths, not orthogonal
    expect(
      uniformPhysicalScale(linear([1, 0, 0], [0.5, Math.sqrt(3) / 2, 0], [0, 0, 1])),
    ).toBeNaN();
  });
  it('a degenerate placement is NaN: a zero axis, a zero scale, a non-finite entry', () => {
    expect(uniformPhysicalScale(linear([0, 0, 0], [0, 0, 0], [0, 0, 0]))).toBeNaN();
    expect(uniformPhysicalScale(linear([1, 0, 0], [0, 0, 0], [0, 0, 1]))).toBeNaN();
    expect(uniformPhysicalScale(linear([Number.NaN, 0, 0], [0, 1, 0], [0, 0, 1]))).toBeNaN();
    expect(
      uniformPhysicalScale(linear([Infinity, 0, 0], [0, Infinity, 0], [0, 0, Infinity])),
    ).toBeNaN();
  });
  it('anything that is not twelve numbers is NaN', () => {
    expect(uniformPhysicalScale([])).toBeNaN();
    expect(uniformPhysicalScale([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNaN();
    expect(uniformPhysicalScale([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0])).toBeNaN();
  });
  it('uses the existing tolerance: one part in a million agrees, one part in a hundred thousand does not', () => {
    expect(
      uniformPhysicalScale(linear([1, 0, 0], [0, 1 + 5e-7, 0], [0, 0, 1 - 5e-7])),
    ).toBeGreaterThan(0.999);
    expect(uniformPhysicalScale(linear([1, 0, 0], [0, 1 + 1e-5, 0], [0, 0, 1]))).toBeNaN();
    // axes that deviate from orthogonal by 5e-7 are accepted, by 1e-5 are not
    expect(uniformPhysicalScale(linear([1, 0, 0], [5e-7, 1, 0], [0, 0, 1]))).toBeGreaterThan(0.999);
    expect(uniformPhysicalScale(linear([1, 0, 0], [1e-5, 1, 0], [0, 0, 1]))).toBeNaN();
  });
});
