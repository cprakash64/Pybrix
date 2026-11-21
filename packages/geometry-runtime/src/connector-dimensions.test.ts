import { describe, expect, it } from 'vitest';
import { IDENTITY_PLACEMENT, PlacementRefusal, type PlacementClass } from '@cadfixer/mesh-core';
import { LengthUnit, millimetresPerUnit } from '@cadfixer/shared';
import {
  CONNECTOR_DIMENSION_POLICY_MM,
  localToMillimetres,
  millimetresToLocal,
  resolveConnectorDimensions,
  resolveMillimetresPerCoordinate,
  resolveModelUnit,
} from './connector-dimensions';
import { describeDimensionRefusal } from './connector-dimension-refusal';

/*
 * THE PHYSICAL CONTRACT OF THE ONE RESOLVER (Stage C03-C1).
 *
 * The units are the six the product reads, taken from `LengthUnit`; `scripts/connector-units-boundary.test.ts` holds that list equal
 * to the 3MF reader's own. The reference table below is WRITTEN OUT HERE and is not read from the product, so "the resolver
 * agrees with itself" is never the whole of a claim: every physical check restates the equation
 *     physical mm = local × (mm per unit) × scale
 * with this table, and compares it with what the requested millimetres were.
 */
const UNITS = Object.values(LengthUnit);
const REFERENCE_MM_PER_UNIT: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  meter: 1000,
  inch: 25.4,
  foot: 304.8,
};
const SCALES = [0.25, 0.5, 1, 2, 4];
const similarity = (scale: number, mirrored = false): PlacementClass => ({
  kind: 'SIMILARITY',
  scale,
  mirrored,
});
const INTENT = { diameterMm: 4, depthMm: 6, clearanceMm: 0.2 };
/** `|a - b|` as a fraction of the larger magnitude. */
const relative = (a: number, b: number): number =>
  Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);

describe('the unit table the resolver reads', () => {
  it('the supported units are exactly the six, and the product table equals the independent reference for each', () => {
    expect([...UNITS].sort()).toEqual(Object.keys(REFERENCE_MM_PER_UNIT).sort());
    for (const unit of UNITS) expect(millimetresPerUnit(unit)).toBe(REFERENCE_MM_PER_UNIT[unit]);
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
    ]) {
      expect(resolveModelUnit(unit)).toEqual({ ok: false, refusal: 'UNKNOWN_UNITS' });
      expect(resolveMillimetresPerCoordinate({ unit, placement: IDENTITY_PLACEMENT })).toEqual({
        ok: false,
        refusal: 'UNKNOWN_UNITS',
      });
    }
  });
});

describe('resolveConnectorDimensions — physical size is independent of the unit and the placement scale', () => {
  it('for every unit and every scale the requested millimetres come back as millimetres, by an independent equation', () => {
    for (const unit of UNITS)
      for (const scale of SCALES) {
        const resolved = resolveConnectorDimensions(INTENT, { unit, placement: similarity(scale) });
        expect(resolved.ok, `${unit} ×${String(scale)}`).toBe(true);
        if (!resolved.ok) continue;
        const factor = (REFERENCE_MM_PER_UNIT[unit] ?? Number.NaN) * scale;
        expect(relative(resolved.diameter * factor, INTENT.diameterMm)).toBeLessThan(1e-15);
        expect(relative(resolved.depth * factor, INTENT.depthMm)).toBeLessThan(1e-15);
        expect(relative(resolved.clearance * factor, INTENT.clearanceMm)).toBeLessThan(1e-15);
        // the factor and its two components are the ones the manifest will state
        expect(resolved.mmPerUnit).toBe(REFERENCE_MM_PER_UNIT[unit]);
        expect(resolved.placementScale).toBe(scale);
        expect(resolved.mmPerCoordinate).toBe(factor);
      }
  });
  it('the same physical part written in different units resolves to physically identical pins: local values scale by the inverse of the unit', () => {
    const reference = resolveConnectorDimensions(INTENT, {
      unit: 'millimeter',
      placement: IDENTITY_PLACEMENT,
    });
    if (!reference.ok) throw new Error('reference refused');
    for (const unit of UNITS)
      for (const scale of SCALES) {
        const resolved = resolveConnectorDimensions(INTENT, { unit, placement: similarity(scale) });
        if (!resolved.ok) throw new Error('refused');
        // a model whose coordinates are k times the millimetre ones (k = 1 / (mm per unit × scale)) takes a pin k times as long
        const k = 1 / ((REFERENCE_MM_PER_UNIT[unit] ?? Number.NaN) * scale);
        expect(relative(resolved.diameter, reference.diameter * k)).toBeLessThan(1e-14);
        expect(relative(resolved.depth, reference.depth * k)).toBeLessThan(1e-14);
        expect(relative(resolved.clearance, reference.clearance * k)).toBeLessThan(1e-14);
      }
  });
  it('a unit change and an opposite scale change cancel: inch at scale 1 is millimetre at scale 25.4', () => {
    const a = resolveConnectorDimensions(INTENT, { unit: 'inch', placement: similarity(1) });
    const b = resolveConnectorDimensions(INTENT, {
      unit: 'millimeter',
      placement: similarity(25.4),
    });
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(relative(a.diameter, b.diameter)).toBeLessThan(1e-15);
    expect(relative(a.depth, b.depth)).toBeLessThan(1e-15);
  });
  it('scale 1 is the C03-A arithmetic, to the bit: millimetres divided by millimetres-per-unit', () => {
    for (const unit of UNITS)
      for (const diameterMm of [0.01, 0.2, 1, 3, 4, 6, 25.4, 1000]) {
        const resolved = resolveConnectorDimensions(
          { diameterMm, depthMm: 6, clearanceMm: 0.2 },
          { unit, placement: IDENTITY_PLACEMENT },
        );
        if (!resolved.ok) throw new Error('refused');
        expect(Object.is(resolved.diameter, diameterMm / millimetresPerUnit(unit))).toBe(true);
        expect(Object.is(resolved.depth, 6 / millimetresPerUnit(unit))).toBe(true);
        expect(Object.is(resolved.clearance, 0.2 / millimetresPerUnit(unit))).toBe(true);
      }
  });
  it('a reflection changes no length: a mirrored placement resolves exactly as its unmirrored twin', () => {
    for (const unit of UNITS)
      for (const scale of SCALES)
        expect(
          resolveConnectorDimensions(INTENT, { unit, placement: similarity(scale, true) }),
        ).toEqual(resolveConnectorDimensions(INTENT, { unit, placement: similarity(scale) }));
  });
  it('a manual size now takes the placement scale: Q425 and Q427 — a pin of 4 mm on a model placed at 2 or 0.5 is 4 mm', () => {
    for (const scale of [2, 0.5]) {
      const resolved = resolveConnectorDimensions(INTENT, {
        unit: 'millimeter',
        placement: similarity(scale),
      });
      if (!resolved.ok) throw new Error('refused');
      expect(resolved.diameter).toBe(4 / scale);
      expect(resolved.depth).toBe(6 / scale);
      expect(resolved.clearance).toBe(0.2 / scale);
    }
  });
});

describe('the physical range is one physical verdict in every unit (the meter and micron legacy bound is gone)', () => {
  it('the default pin Ø4 / 6 / 0.2 mm is accepted in EVERY unit, including the two the old coordinate bound refused', () => {
    for (const unit of ['meter', 'micron'])
      expect(resolveConnectorDimensions(INTENT, { unit, placement: IDENTITY_PLACEMENT }).ok).toBe(
        true,
      );
  });
  it('the boundary values are accepted, and the first values beyond them are refused, with the SAME reason in every unit', () => {
    const { minimum, maximum, clearanceMinimum } = CONNECTOR_DIMENSION_POLICY_MM;
    expect([minimum, maximum, clearanceMinimum]).toEqual([0.01, 1000, 0]);
    const cases: readonly [string, typeof INTENT, boolean, string?][] = [
      ['diameter at the floor', { ...INTENT, diameterMm: minimum }, true],
      ['diameter at the ceiling', { ...INTENT, diameterMm: maximum }, true],
      ['depth at the floor', { ...INTENT, depthMm: minimum }, true],
      ['depth at the ceiling', { ...INTENT, depthMm: maximum }, true],
      ['clearance zero', { ...INTENT, clearanceMm: 0 }, true],
      ['clearance at the ceiling', { ...INTENT, clearanceMm: maximum }, true],
      ['diameter below the floor', { ...INTENT, diameterMm: 0.0099 }, false, 'PIN_DIAMETER'],
      ['diameter above the ceiling', { ...INTENT, diameterMm: 1000.01 }, false, 'PIN_DIAMETER'],
      ['depth below the floor', { ...INTENT, depthMm: 0.001 }, false, 'PIN_DEPTH'],
      ['depth above the ceiling', { ...INTENT, depthMm: 2000 }, false, 'PIN_DEPTH'],
      ['negative clearance', { ...INTENT, clearanceMm: -1 }, false, 'PIN_CLEARANCE'],
      ['clearance above the ceiling', { ...INTENT, clearanceMm: 2000 }, false, 'PIN_CLEARANCE'],
      ['diameter NaN', { ...INTENT, diameterMm: Number.NaN }, false, 'PIN_DIAMETER'],
      ['depth infinite', { ...INTENT, depthMm: Infinity }, false, 'PIN_DEPTH'],
    ];
    for (const [name, intent, accepted, dimension] of cases)
      for (const unit of UNITS)
        for (const scale of [0.25, 1, 4]) {
          const resolved = resolveConnectorDimensions(intent, {
            unit,
            placement: similarity(scale),
          });
          expect(resolved.ok, `${name} in ${unit} ×${String(scale)}`).toBe(accepted);
          if (!accepted && !resolved.ok)
            expect(resolved).toMatchObject({
              refusal: 'DIMENSION_OUT_OF_POLICY',
              dimension,
              reason: 'OUT_OF_RANGE',
              maxMm: maximum,
            });
        }
  });
  it('a refusal names the metric, the value and the limit in millimetres, whatever the unit', () => {
    const refused = resolveConnectorDimensions(
      { ...INTENT, diameterMm: 0.004 },
      { unit: 'meter', placement: IDENTITY_PLACEMENT },
    );
    if (refused.ok || refused.refusal !== 'DIMENSION_OUT_OF_POLICY') throw new Error('not refused');
    expect(describeDimensionRefusal(refused)).toBe(
      'Pin diameter of 0.004 mm is outside the range Pybrix can place (0.01–1000 mm).',
    );
    const nan = resolveConnectorDimensions(
      { ...INTENT, depthMm: Number.NaN },
      { unit: 'inch', placement: IDENTITY_PLACEMENT },
    );
    if (nan.ok || nan.refusal !== 'DIMENSION_OUT_OF_POLICY') throw new Error('not refused');
    expect(describeDimensionRefusal(nan)).toBe(
      'Pin depth must be a number in the range Pybrix can place (0.01–1000 mm).',
    );
    const clearance = resolveConnectorDimensions(
      { ...INTENT, clearanceMm: -1 },
      { unit: 'micron', placement: IDENTITY_PLACEMENT },
    );
    if (clearance.ok || clearance.refusal !== 'DIMENSION_OUT_OF_POLICY')
      throw new Error('not refused');
    expect(describeDimensionRefusal(clearance)).toContain('0–1000 mm');
  });
  it('what is left in local coordinates is only numeric: a length that overflows or underflows is NOT_REPRESENTABLE, not clamped', () => {
    const tiny = resolveConnectorDimensions(INTENT, {
      unit: 'millimeter',
      placement: similarity(1e-320),
    });
    expect(tiny).toMatchObject({
      ok: false,
      refusal: 'DIMENSION_OUT_OF_POLICY',
      reason: 'NOT_REPRESENTABLE',
    });
    const huge = resolveConnectorDimensions(INTENT, {
      unit: 'foot',
      placement: similarity(1e306),
    });
    expect(huge).toMatchObject({
      ok: false,
      refusal: 'DIMENSION_OUT_OF_POLICY',
      reason: 'NOT_REPRESENTABLE',
    });
    // a clearance that is exactly zero stays representable, however the model is placed
    expect(
      resolveConnectorDimensions(
        { ...INTENT, clearanceMm: 0 },
        { unit: 'micron', placement: similarity(1e6) },
      ).ok,
    ).toBe(true);
  });
});

describe('order of refusal is the order it has always had: unit, then placement, then the dimensions', () => {
  it('an unknown unit wins over an unsupported placement, which wins over an out-of-range dimension', () => {
    const bad = { ...INTENT, diameterMm: 0.001 };
    const unsupported: PlacementClass = { kind: 'UNSUPPORTED', reason: PlacementRefusal.Shear };
    expect(resolveConnectorDimensions(bad, { unit: 'furlong', placement: unsupported })).toEqual({
      ok: false,
      refusal: 'UNKNOWN_UNITS',
    });
    for (const reason of Object.values(PlacementRefusal))
      expect(
        resolveConnectorDimensions(bad, {
          unit: 'millimeter',
          placement: { kind: 'UNSUPPORTED', reason },
        }),
      ).toEqual({ ok: false, refusal: 'UNSUPPORTED_TRANSFORM', transformReason: reason });
    expect(
      resolveConnectorDimensions(bad, { unit: 'millimeter', placement: IDENTITY_PLACEMENT }),
    ).toMatchObject({ refusal: 'DIMENSION_OUT_OF_POLICY' });
  });
});

describe('the two directions of the one conversion', () => {
  it('a local length is one division and the inverse is one multiplication; they round-trip', () => {
    expect(millimetresToLocal(6, 25.4)).toBe(6 / 25.4);
    expect(localToMillimetres(6, 25.4)).toBe(6 * 25.4);
    for (const unit of UNITS)
      for (const scale of SCALES) {
        const factor = resolveMillimetresPerCoordinate({ unit, placement: similarity(scale) });
        if (!factor.ok) throw new Error('refused');
        expect(
          relative(
            localToMillimetres(
              millimetresToLocal(3.7, factor.mmPerCoordinate),
              factor.mmPerCoordinate,
            ),
            3.7,
          ),
        ).toBeLessThan(1e-15);
      }
  });
});
