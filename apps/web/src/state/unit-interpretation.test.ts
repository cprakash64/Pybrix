import { describe, expect, it } from 'vitest';
import { LengthUnit } from '@cadfixer/shared';
import {
  UnitBasis,
  canInterpretUnit,
  coordinatesToMillimetres,
  describeEffectiveUnit,
  effectiveUnit,
  millimetresToCoordinates,
  unitWord,
} from './unit-interpretation';

/**
 * PYBRIX-08A: the interpretation is a READING of coordinates, never a rewrite.
 * These are the semantics every workspace relies on.
 */
const stl = (documentId = 'doc-1'): Parameters<typeof effectiveUnit>[0] => ({
  handle: { documentId },
  source: { unit: undefined },
});
const threeMf = (unit: string): Parameters<typeof effectiveUnit>[0] => ({
  handle: { documentId: 'doc-1' },
  source: { unit },
});

describe('effectiveUnit', () => {
  it('is unspecified for a unitless document with no choice — nothing is guessed', () => {
    expect(effectiveUnit(stl(), undefined)).toEqual({
      unit: undefined,
      basis: UnitBasis.Unspecified,
    });
  });

  it('uses the user’s choice for a unitless document', () => {
    expect(effectiveUnit(stl(), { documentId: 'doc-1', unit: LengthUnit.Inch })).toEqual({
      unit: LengthUnit.Inch,
      basis: UnitBasis.Chosen,
    });
  });

  it('ignores a choice made for a different document', () => {
    expect(effectiveUnit(stl('doc-2'), { documentId: 'doc-1', unit: LengthUnit.Inch })).toEqual({
      unit: undefined,
      basis: UnitBasis.Unspecified,
    });
  });

  it('lets a unit the file states win over any choice', () => {
    expect(
      effectiveUnit(threeMf(LengthUnit.Millimeter), { documentId: 'doc-1', unit: LengthUnit.Inch }),
    ).toEqual({ unit: LengthUnit.Millimeter, basis: UnitBasis.File });
  });

  it('does not treat a file token it does not know as a physical unit', () => {
    expect(effectiveUnit(threeMf('furlong'), undefined).unit).toBeUndefined();
  });

  it('is unspecified with no model', () => {
    expect(effectiveUnit(undefined, { documentId: 'doc-1', unit: LengthUnit.Inch }).basis).toBe(
      UnitBasis.Unspecified,
    );
  });
});

describe('who may choose', () => {
  it('only a document whose file states no unit', () => {
    expect(canInterpretUnit(stl())).toBe(true);
    expect(canInterpretUnit(threeMf(LengthUnit.Inch))).toBe(false);
    expect(canInterpretUnit(undefined)).toBe(false);
  });
});

describe('coordinates versus physical size', () => {
  it('reads 8 coordinate units as 203.2 mm when the model is inches', () => {
    expect(coordinatesToMillimetres(8, LengthUnit.Inch)).toBeCloseTo(203.2, 10);
  });

  it('reads 8 coordinate units as 8 mm when the model is millimetres', () => {
    expect(coordinatesToMillimetres(8, LengthUnit.Millimeter)).toBe(8);
  });

  it('round-trips a physical size through the model’s units', () => {
    for (const unit of Object.values(LengthUnit))
      expect(coordinatesToMillimetres(millimetresToCoordinates(4, unit), unit)).toBeCloseTo(4, 10);
  });
});

describe('wording', () => {
  it('names a chosen unit as the user’s choice and a stated one plainly', () => {
    expect(describeEffectiveUnit({ unit: LengthUnit.Inch, basis: UnitBasis.Chosen }, 'stl')).toBe(
      'Inches (your choice)',
    );
    expect(describeEffectiveUnit({ unit: LengthUnit.Inch, basis: UnitBasis.File }, '3mf')).toBe(
      'Inches',
    );
  });

  it('keeps the existing unspecified wording when nothing is chosen', () => {
    expect(describeEffectiveUnit({ unit: undefined, basis: UnitBasis.Unspecified }, 'stl')).toBe(
      'Unspecified by STL',
    );
    expect(describeEffectiveUnit({ unit: undefined, basis: UnitBasis.Unspecified }, 'obj')).toBe(
      'Unspecified',
    );
  });

  it('has a word for every unit', () => {
    for (const unit of Object.values(LengthUnit)) expect(unitWord(unit)).not.toBe('');
  });
});
