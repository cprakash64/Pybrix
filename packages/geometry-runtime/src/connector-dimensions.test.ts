import { describe, expect, it } from 'vitest';
import { IDENTITY_PLACEMENT, PlacementRefusal, type PlacementClass } from '@cadfixer/mesh-core';
import { LengthUnit, millimetresPerUnit } from '@cadfixer/shared';
import {
  millimetresToLocal,
  resolveConnectorDimensions,
  resolveMillimetresPerCoordinate,
} from './connector-dimensions';

const UNITS = Object.values(LengthUnit);
const similarity = (scale: number): PlacementClass => ({
  kind: 'SIMILARITY',
  scale,
  mirrored: false,
});
const VALUES = [0.01, 0.2, 1, 3, 4, 6, 25.4, 1000, 0, -1, Number.NaN, Infinity, 1e-300, 1e300];

describe('resolveConnectorDimensions — the one conversion', () => {
  it('a manual size is the old page expression, to the bit: millimetres divided by millimetres-per-unit', () => {
    for (const unit of UNITS)
      for (const diameterMm of VALUES)
        for (const depthMm of [6, 0.5]) {
          const resolved = resolveConnectorDimensions(
            { diameterMm, depthMm, clearanceMm: 0.2 },
            { unit, placementScaleApplied: false },
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
          placement: similarity(scale),
          placementScaleApplied: true,
        });
        expect(factor.ok).toBe(true);
        if (factor.ok)
          expect(Object.is(factor.mmPerCoordinate, millimetresPerUnit(unit) * scale)).toBe(true);
      }
  });
  it('a manual size does not take the placement scale (KNOWN LEGACY BEHAVIOUR, pinned until the stage that changes it)', () => {
    const intent = { diameterMm: 4, depthMm: 6, clearanceMm: 0.2 };
    // The unscaled context states no placement at all; the applied one is what a placement scale reaches.
    const manual = resolveConnectorDimensions(intent, {
      unit: 'millimeter',
      placementScaleApplied: false,
    });
    const scaled = resolveConnectorDimensions(intent, {
      unit: 'millimeter',
      placement: similarity(2),
      placementScaleApplied: true,
    });
    expect(manual.ok && scaled.ok).toBe(true);
    if (manual.ok && scaled.ok) {
      expect(manual.mmPerCoordinate).toBe(1);
      expect(scaled.mmPerCoordinate).toBe(2);
    }
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
          resolveMillimetresPerCoordinate(
            applied
              ? { unit, placement: IDENTITY_PLACEMENT, placementScaleApplied: true }
              : { unit, placementScaleApplied: false },
          ),
        ).toEqual({ ok: false, refusal: 'UNKNOWN_UNITS' });
  });
  it("a placement with no uniform scale is refused only where the scale is applied, with the classifier's own reason, and the unit is judged first", () => {
    for (const reason of Object.values(PlacementRefusal))
      expect(
        resolveMillimetresPerCoordinate({
          unit: 'millimeter',
          placement: { kind: 'UNSUPPORTED', reason },
          placementScaleApplied: true,
        }),
      ).toEqual({ ok: false, refusal: 'UNSUPPORTED_TRANSFORM', transformReason: reason });
    expect(
      resolveMillimetresPerCoordinate({
        unit: 'furlong',
        placement: { kind: 'UNSUPPORTED', reason: PlacementRefusal.NonFinite },
        placementScaleApplied: true,
      }),
    ).toEqual({ ok: false, refusal: 'UNKNOWN_UNITS' });
    // not applied: no placement is stated, so none can refuse
    expect(
      resolveMillimetresPerCoordinate({ unit: 'millimeter', placementScaleApplied: false }),
    ).toEqual({ ok: true, mmPerCoordinate: 1 });
  });
  it('a mirrored similarity has the same factor as its unmirrored twin: a mirror changes no distance', () => {
    const plain = resolveMillimetresPerCoordinate({
      unit: 'inch',
      placement: similarity(2),
      placementScaleApplied: true,
    });
    const mirrored = resolveMillimetresPerCoordinate({
      unit: 'inch',
      placement: { kind: 'SIMILARITY', scale: 2, mirrored: true },
      placementScaleApplied: true,
    });
    expect(mirrored).toEqual(plain);
  });
  it('the local length is a single division, and the resolver never judges a value', () => {
    expect(millimetresToLocal(6, 25.4)).toBe(6 / 25.4);
    const resolved = resolveConnectorDimensions(
      { diameterMm: Number.NaN, depthMm: -3, clearanceMm: Infinity },
      { unit: 'inch', placementScaleApplied: false },
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.diameter).toBeNaN();
      expect(resolved.depth).toBe(-3 / 25.4);
      expect(resolved.clearance).toBe(Infinity);
    }
  });
});
