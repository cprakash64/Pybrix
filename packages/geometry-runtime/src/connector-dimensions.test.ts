import { describe, expect, it } from 'vitest';
import { LengthUnit, millimetresPerUnit } from '@cadfixer/shared';
import {
  millimetresToLocal,
  resolveConnectorDimensions,
  resolveMillimetresPerCoordinate,
} from './connector-dimensions';

const UNITS = Object.values(LengthUnit);
const VALUES = [0.01, 0.2, 1, 3, 4, 6, 25.4, 1000, 0, -1, Number.NaN, Infinity, 1e-300, 1e300];

describe('resolveConnectorDimensions — the one conversion', () => {
  it('a manual size is the old page expression, to the bit: millimetres divided by millimetres-per-unit', () => {
    for (const unit of UNITS)
      for (const diameterMm of VALUES)
        for (const depthMm of [6, 0.5]) {
          const resolved = resolveConnectorDimensions(
            { diameterMm, depthMm, clearanceMm: 0.2 },
            { unit, placementScale: Number.NaN, placementScaleApplied: false },
          );
          expect(resolved.ok).toBe(true);
          if (!resolved.ok) continue;
          // the expression that lived in `connectorRequest`, restated independently
          expect(Object.is(resolved.diameter, diameterMm / millimetresPerUnit(unit))).toBe(true);
          expect(Object.is(resolved.depth, depthMm / millimetresPerUnit(unit))).toBe(true);
          expect(Object.is(resolved.clearance, 0.2 / millimetresPerUnit(unit))).toBe(true);
          expect(resolved.mmPerCoordinate).toBe(millimetresPerUnit(unit));
        }
  });
  it('the automatic factor is the old planner expression, to the bit: millimetres-per-unit times the placement scale', () => {
    for (const unit of UNITS)
      for (const scale of [1, 0.5, 2, 3, 25.4, 1e-3, 1 + 1e-9]) {
        const factor = resolveMillimetresPerCoordinate({
          unit,
          placementScale: scale,
          placementScaleApplied: true,
        });
        expect(factor.ok).toBe(true);
        if (factor.ok)
          expect(Object.is(factor.mmPerCoordinate, millimetresPerUnit(unit) * scale)).toBe(true);
      }
  });
  it('a manual size does not take the placement scale (KNOWN LEGACY BEHAVIOUR, pinned until the stage that changes it)', () => {
    const intent = { diameterMm: 4, depthMm: 6, clearanceMm: 0.2 };
    const a = resolveConnectorDimensions(intent, {
      unit: 'millimeter',
      placementScale: 1,
      placementScaleApplied: false,
    });
    const b = resolveConnectorDimensions(intent, {
      unit: 'millimeter',
      placementScale: 2,
      placementScaleApplied: false,
    });
    expect(b).toEqual(a);
  });
  it('an unknown unit is refused, never defaulted — including names an object table would answer to', () => {
    for (const unit of [
      undefined,
      '',
      'mm',
      'Millimeter',
      'furlong',
      'constructor',
      '__proto__',
      'toString',
    ])
      for (const applied of [true, false])
        expect(
          resolveMillimetresPerCoordinate({
            unit,
            placementScale: 1,
            placementScaleApplied: applied,
          }),
        ).toEqual({ ok: false, refusal: 'UNKNOWN_UNITS' });
  });
  it('a placement with no uniform scale is refused only where the scale is applied, and the unit is judged first', () => {
    for (const scale of [Number.NaN, 0, -1, Infinity])
      expect(
        resolveMillimetresPerCoordinate({
          unit: 'millimeter',
          placementScale: scale,
          placementScaleApplied: true,
        }),
      ).toEqual({ ok: false, refusal: 'UNSUPPORTED_TRANSFORM' });
    expect(
      resolveMillimetresPerCoordinate({
        unit: 'furlong',
        placementScale: Number.NaN,
        placementScaleApplied: true,
      }),
    ).toEqual({ ok: false, refusal: 'UNKNOWN_UNITS' });
    expect(
      resolveMillimetresPerCoordinate({
        unit: 'millimeter',
        placementScale: Number.NaN,
        placementScaleApplied: false,
      }),
    ).toEqual({ ok: true, mmPerCoordinate: 1 });
  });
  it('the local length is a single division, and the resolver never judges a value', () => {
    expect(millimetresToLocal(6, 25.4)).toBe(6 / 25.4);
    const resolved = resolveConnectorDimensions(
      { diameterMm: Number.NaN, depthMm: -3, clearanceMm: Infinity },
      { unit: 'inch', placementScale: 1, placementScaleApplied: false },
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.diameter).toBeNaN();
      expect(resolved.depth).toBe(-3 / 25.4);
      expect(resolved.clearance).toBe(Infinity);
    }
  });
});
