import { LengthUnit, isLengthUnit, millimetresPerUnit } from '@cadfixer/shared';

/**
 * MODEL UNIT INTERPRETATION (PYBRIX-08A).
 *
 * WHAT THIS IS. A statement by the user about how to READ a unitless model's
 * coordinates — "these numbers are inches" — held as workspace metadata beside
 * the document. It is NOT a unit conversion and NOT a geometry edit: no
 * coordinate is rewritten, no revision is consumed, and the authoritative
 * `GeometryDocument.unit` is untouched (so an STL document still says it stated
 * nothing, and nothing is exported as having stated a unit it never did).
 *
 * WHY NOT A DOCUMENT EDIT. A document edit would consume a revision, which
 * invalidates every analysis and candidate for the whole document — re-running
 * topology on a two-million-triangle model to change a label. The interpretation
 * is keyed by `documentId`, which is stable across revisions, so Repair, Split,
 * Texture and Undo all see the same reading and none can discard it. A new
 * import has a new `documentId`, so a stale reading can never apply to it.
 *
 * PRECEDENCE. A unit the FILE states always wins and cannot be overridden here:
 * the user has no business re-reading a 3MF that says millimetres. The
 * interpretation applies only when the file states none.
 *
 * NOTHING IS GUESSED. There is no inference from bounding-box size. The
 * interface may OFFER the common choices; it never presents one as a fact.
 */
export interface UnitInterpretation {
  readonly documentId: string;
  readonly unit: LengthUnit;
}

/** Where the unit now in force came from. */
export const UnitBasis = {
  /** The file states it. Authoritative. */
  File: 'file',
  /** The user chose it for this unitless document. */
  Chosen: 'chosen',
  /** Nothing states it. */
  Unspecified: 'unspecified',
} as const;
export type UnitBasis = (typeof UnitBasis)[keyof typeof UnitBasis];

export interface EffectiveUnit {
  readonly unit: LengthUnit | undefined;
  readonly basis: UnitBasis;
}

interface UnitSubject {
  readonly handle: { readonly documentId: string };
  readonly source: { readonly unit?: string | undefined };
}

/**
 * The unit physical-size features should use for `model`, and why.
 *
 * A file-stated unit that is not one of the six core units is returned as
 * `Unspecified` for the purpose of PHYSICAL features: the model panel still
 * shows the file's own token, but the arithmetic below needs a unit it knows.
 */
export function effectiveUnit(
  model: UnitSubject | undefined,
  interpretation: UnitInterpretation | undefined,
): EffectiveUnit {
  if (model === undefined) return { unit: undefined, basis: UnitBasis.Unspecified };
  const stated = model.source.unit;
  if (stated !== undefined) {
    return isLengthUnit(stated)
      ? { unit: stated, basis: UnitBasis.File }
      : { unit: undefined, basis: UnitBasis.Unspecified };
  }
  if (interpretation?.documentId === model.handle.documentId)
    return { unit: interpretation.unit, basis: UnitBasis.Chosen };
  return { unit: undefined, basis: UnitBasis.Unspecified };
}

/** Whether the user may choose an interpretation: only a document that states none. */
export function canInterpretUnit(model: UnitSubject | undefined): boolean {
  return model !== undefined && model.source.unit === undefined;
}

/**
 * Converts a PHYSICAL length in millimetres into this document's coordinate
 * units. 8 mm in an inch-read model is 8 / 25.4 coordinate units. The mesh is
 * not touched; only a parameter the user typed in physical terms is expressed in
 * the space the mesh lives in.
 */
export function millimetresToCoordinates(millimetres: number, unit: LengthUnit): number {
  return millimetres / millimetresPerUnit(unit);
}

/** The reverse: a length measured in coordinate units, as millimetres. */
export function coordinatesToMillimetres(length: number, unit: LengthUnit): number {
  return length * millimetresPerUnit(unit);
}

/* ---------------------------------------------------------------- copy -- */

export const UNIT_INTERPRETATION_COPY = Object.freeze({
  heading: 'This model does not state its units',
  question: 'How should Pybrix read its dimensions?',
  note: 'This only tells Pybrix what the numbers mean. The model is not rescaled.',
  changeLabel: 'Change units',
  groupLabel: 'Read dimensions as',
});

/** The three choices offered inline; every unit is available from the list. */
export const COMMON_UNIT_CHOICES: readonly LengthUnit[] = Object.freeze([
  LengthUnit.Millimeter,
  LengthUnit.Centimeter,
  LengthUnit.Inch,
]);

/** "Millimetres", "Inches" — the word, for the buttons and the summary. */
export function unitWord(unit: LengthUnit): string {
  switch (unit) {
    case LengthUnit.Micron:
      return 'Microns';
    case LengthUnit.Millimeter:
      return 'Millimetres';
    case LengthUnit.Centimeter:
      return 'Centimetres';
    case LengthUnit.Meter:
      return 'Metres';
    case LengthUnit.Inch:
      return 'Inches';
    case LengthUnit.Foot:
      return 'Feet';
  }
}

/** The line the model panel shows for a unit, naming where it came from. */
export function describeEffectiveUnit(effective: EffectiveUnit, formatId: string): string {
  const { unit } = effective;
  if (unit === undefined || effective.basis === UnitBasis.Unspecified)
    return formatId === 'stl' ? 'Unspecified by STL' : 'Unspecified';
  return effective.basis === UnitBasis.Chosen ? `${unitWord(unit)} (your choice)` : unitWord(unit);
}
