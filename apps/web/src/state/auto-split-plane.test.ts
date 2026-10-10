import { describe, expect, it } from 'vitest';
import type { SplitPlane } from '@cadfixer/geometry-runtime';
import { PLANE_ANGLE_TOLERANCE_DEGREES, planeSettingsFor } from './auto-split-plane';
import {
  splitPlaneFor,
  type PartBoundsLike,
  type SplitAxis,
  type SplitPlaneSettings,
} from './split-presentation';

const BOUNDS: PartBoundsLike = {
  min: [-10, -6, -4],
  max: [14, 8, 30],
  center: [2, 1, 13],
};

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

describe('a suggested plane becomes Manual Split settings and back', () => {
  it('round-trips every setting the controls can express', () => {
    const axes: readonly SplitAxis[] = ['X', 'Y', 'Z'];
    let cases = 0;
    for (const axis of axes)
      for (const tilt of [0, 17, -35, 52])
        for (const roll of [0, 11, -28, 40])
          for (const flipped of [false, true])
            for (const offset of [undefined, -3, 5]) {
              const settings: SplitPlaneSettings = { axis, offset, tilt, roll, flipped };
              const plane = splitPlaneFor(settings, BOUNDS);
              const back = planeSettingsFor(plane, BOUNDS);
              expect(back.exact, JSON.stringify(settings)).toBe(true);
              const again = splitPlaneFor(back.settings, BOUNDS);
              expect(dot(again.normal, plane.normal)).toBeGreaterThan(0.999_999);
              // A steep tilt and roll make another axis dominant, and the same plane then has an
              // equally valid expression in that axis; the axis and side are asserted only where the
              // original axis is unambiguously the dominant one.
              if (Math.abs(tilt) <= 35 && Math.abs(roll) <= 40) {
                expect(back.settings.axis).toBe(axis);
                expect(back.settings.flipped).toBe(flipped);
              }
              cases += 1;
            }
    expect(cases).toBe(3 * 4 * 4 * 2 * 3);
  });

  it('maps an axis-aligned cut to an untilted, unrolled plane at the right height', () => {
    const plane: SplitPlane = { origin: [2, 1, 22.5], normal: [0, 0, 1] };
    const { settings, exact } = planeSettingsFor(plane, BOUNDS);
    expect(exact).toBe(true);
    expect(settings).toEqual({ axis: 'Z', offset: 22.5, tilt: 0, roll: 0, flipped: false });
  });

  it('keeps which side is Piece A: a normal pointing down the axis is a flipped plane', () => {
    const { settings } = planeSettingsFor({ origin: [2, 1, 20], normal: [0, 0, -1] }, BOUNDS);
    expect(settings.axis).toBe('Z');
    expect(settings.flipped).toBe(true);
  });

  it('maps an oblique cut through a point that is not on the centre line', () => {
    const normal: readonly [number, number, number] = [0.5, 0.2, 0.84];
    const length = Math.hypot(...normal);
    const unit: readonly [number, number, number] = [
      normal[0] / length,
      normal[1] / length,
      normal[2] / length,
    ];
    const plane: SplitPlane = { origin: [6, 3, 18], normal: unit };
    const result = planeSettingsFor(plane, BOUNDS);
    expect(result.exact).toBe(true);
    const produced = splitPlaneFor(result.settings, BOUNDS);
    // The suggested origin lies on the produced plane.
    expect(
      Math.abs(
        dot(produced.normal, [
          plane.origin[0] - produced.origin[0],
          plane.origin[1] - produced.origin[1],
          plane.origin[2] - produced.origin[2],
        ]),
      ),
    ).toBeLessThan(1e-9);
  });

  it('says so, rather than approximating silently, when the controls cannot express the cut', () => {
    // A plane that crosses the Z axis far outside the part's own range.
    const plane: SplitPlane = { origin: [2, 1, 400], normal: [0, 0, 1] };
    const result = planeSettingsFor(plane, BOUNDS);
    expect(result.exact).toBe(false);
    expect(result.offsetError).toBeGreaterThan(0.1);
    expect(PLANE_ANGLE_TOLERANCE_DEGREES).toBeGreaterThan(0);
  });

  it('survives a zero normal and a missing part by choosing the default plane', () => {
    const result = planeSettingsFor({ origin: [0, 0, 0], normal: [0, 0, 0] }, undefined);
    expect(result.settings.axis).toBe('Z');
    expect(Number.isFinite(result.settings.tilt)).toBe(true);
  });
});
