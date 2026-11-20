import { describe, expect, it } from 'vitest';
import type { JointDescriptor } from '@cadfixer/geometry-runtime';
import { buildCutMark, cutPointInScene, RING_SEGMENTS } from './cut-mark-presentation';

/** A 20 mm square cut whose across is +Y and along is +Z, its origin at (5, 0, 0), in a scene twice the cut's units. */
const AXES = {
  u: [0, 1, 0] as [number, number, number],
  v: [0, 0, 1] as [number, number, number],
  normal: [1, 0, 0] as [number, number, number],
  origin: [5, 0, 0] as [number, number, number],
  scenePerCoordinate: 2,
};
const OUTLINE = {
  bounds: { minU: -10, maxU: 10, minV: -10, maxV: 10 },
  loops: [{ role: 'OUTER' as const, points: [-10, -10, 10, -10, 10, 10, -10, 10] }],
};
function joint(overrides: Partial<NonNullable<JointDescriptor['cutFace']>> = {}): JointDescriptor {
  return {
    jointId: 'j',
    aPartId: 'a',
    bPartId: 'b',
    status: 'ATTACHED',
    pinCount: 0,
    retainedBytes: 0,
    specDigest: 'd',
    cutFace: { mmPerCoordinate: 0.5, maxPins: 4, outline: OUTLINE, axes: AXES, ...overrides },
  };
}
const ZERO = [0, 0, 0] as const;
/** The distance in the y-z plane (the cut's own plane here) between two scene points. */
const planar = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
const point = (values: Float32Array, index: number): number[] =>
  Array.from(values.subarray(3 * index, 3 * index + 3));

describe('a point of the cut in the scene', () => {
  it('is the origin plus the scale times its own axes', () => {
    expect(cutPointInScene(AXES, 3, -4)).toEqual([5, 6, -8]);
    expect(cutPointInScene(AXES, 0, 0)).toEqual([5, 0, 0]);
  });
});

describe('the mark of a cut', () => {
  it('lays the outline on the face: every loop closed, every point where the cut puts it', () => {
    const mark = buildCutMark(joint(), undefined, { a: ZERO, b: ZERO });
    if (mark === undefined) throw new Error('expected a mark');
    expect(mark.outline).toHaveLength(4 * 2 * 3);
    // the first edge runs from (-10, -10) to (10, -10): scene (5, -20, -20) to (5, 20, -20)
    expect(point(mark.outline, 0)).toEqual([5, -20, -20]);
    expect(point(mark.outline, 1)).toEqual([5, 20, -20]);
    // the last edge closes the loop back to the first point
    expect(point(mark.outline, 7)).toEqual([5, -20, -20]);
    expect(mark.pins).toHaveLength(0);
  });

  it('draws the face once when the pieces sit together and twice, each at its piece, when they are apart', () => {
    const together = buildCutMark(joint(), undefined, { a: ZERO, b: ZERO });
    expect(together?.outline).toHaveLength(24);
    const apart = buildCutMark(joint(), undefined, { a: [0, 0, 0], b: [30, 0, 0] });
    expect(apart?.outline).toHaveLength(48);
    expect(point(apart?.outline ?? new Float32Array(), 8)).toEqual([35, -20, -20]);
  });

  it('draws a ring for the pin and one for its socket for each draft connector, at the radii the sizes give', () => {
    const mark = buildCutMark(
      joint(),
      { pins: [{ u: 1, v: 2 }], diameterMm: 4, clearanceMm: 0.2 },
      {
        a: ZERO,
        b: ZERO,
      },
    );
    if (mark === undefined) throw new Error('expected a mark');
    expect(mark.pins).toHaveLength(2 * RING_SEGMENTS * 2 * 3);
    // 0.5 mm per cut unit and 2 scene units per cut unit: a 2 mm radius is 4 cut units is 8 scene units
    const centre = cutPointInScene(AXES, 1, 2);
    const first = point(mark.pins, 0);
    expect(planar(first, centre)).toBeCloseTo(8, 5);
    expect(first[0]).toBeCloseTo(centre[0], 5);
    // the socket ring is 0.2 mm further out: 2.2 mm is 8.8 scene units
    const socket = point(mark.pins, RING_SEGMENTS * 2);
    expect(planar(socket, centre)).toBeCloseTo(8.8, 5);
  });

  it('follows the draft: more connectors, more rings; none, none', () => {
    const rings = (count: number): number =>
      buildCutMark(
        joint(),
        {
          pins: Array.from({ length: count }, (_, i) => ({ u: i, v: 0 })),
          diameterMm: 4,
          clearanceMm: 0.2,
        },
        { a: ZERO, b: ZERO },
      )?.pins.length ?? -1;
    expect(rings(0)).toBe(0);
    expect(rings(3)).toBe(3 * rings(1));
  });

  it('puts an arrow along each of the cut’s own directions, named by the model axis it points along', () => {
    const mark = buildCutMark(joint(), undefined, { a: ZERO, b: ZERO });
    if (mark === undefined) throw new Error('expected a mark');
    // from the corner (-10, -10): scene (5, -20, -20); across is 45 % of 40 scene units
    expect(point(mark.across, 0)).toEqual([5, -20, -20]);
    expect(point(mark.across, 1)[1]).toBeCloseTo(-20 + 18, 4);
    expect(point(mark.along, 1)[2]).toBeCloseTo(-20 + 18, 4);
    expect(mark.labels.map((l) => l.text)).toEqual(['+Y', '+Z']);
    expect(mark.labels[0]?.position[1]).toBeGreaterThan(point(mark.across, 1)[1] ?? 0);
  });

  it('is nothing when the cut cannot be placed or drawn, or its record has ended', () => {
    expect(
      buildCutMark(joint({ axes: undefined }), undefined, { a: ZERO, b: ZERO }),
    ).toBeUndefined();
    expect(
      buildCutMark(joint({ outline: undefined }), undefined, { a: ZERO, b: ZERO }),
    ).toBeUndefined();
    expect(
      buildCutMark({ ...joint(), status: 'RETIRED', reason: 'GEOMETRY_CHANGED' }, undefined, {
        a: ZERO,
        b: ZERO,
      }),
    ).toBeUndefined();
  });
});
