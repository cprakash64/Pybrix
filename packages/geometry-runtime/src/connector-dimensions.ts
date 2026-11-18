import { isLengthUnit, millimetresPerUnit } from '@cadfixer/shared';

/**
 * THE ONE PLACE A CONNECTOR DIMENSION BECOMES A LOCAL LENGTH.
 *
 * A connector dimension is a PHYSICAL length in millimetres. The mesh it is cut into is measured in the part's own coordinates,
 * and the conversion between the two is one factor, `mmPerCoordinate`: how many millimetres one coordinate unit of the part is.
 * It is the model's unit (`millimetresPerUnit`) and, where the placement scales the part, the placement's uniform scale.
 *
 * Nothing else in the connector code turns millimetres into coordinates, or coordinates into millimetres: the page sends the
 * physical intent, the automatic planner asks here for its factor, and the engine resolves a physical request here. A second
 * `millimetresPerUnit(` in the planner or the engine is a second answer to "how big is a coordinate", and the first time the two
 * disagreed a connector would be the wrong size without anything failing (a boundary test holds the line).
 *
 * WHAT THIS STAGE (C03-A) DELIBERATELY DOES NOT CHANGE. It is a refactor with no behaviour change:
 *  - the AUTOMATIC planner has always applied the placement scale, so it asks for `placementScaleApplied: true`;
 *  - a MANUAL pin has never applied it (the page converted millimetres by the unit alone), so it asks for `false`. That is a known
 *    inconsistency, stated here instead of hidden, and the stage that fixes it changes the manual call to `true` — one argument,
 *    one classified drift — and then deletes the parameter;
 *  - no bound is applied here: a dimension the engine would refuse is still refused by the engine's own check, in coordinates.
 * The arithmetic is exactly what each caller did before (one division by the factor, one product to form it), so results are
 * identical to the bit; the resolver's test compares it against the old expressions over a grid.
 */

/** What a person asked for, in millimetres. */
export interface ConnectorDimensionIntent {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly clearanceMm: number;
}

/** Why a physical size could not be resolved. These are not geometry findings: nothing was examined. */
export type ConnectorScaleRefusal = 'UNKNOWN_UNITS' | 'UNSUPPORTED_TRANSFORM';

export type MillimetresPerCoordinate =
  | { readonly ok: true; readonly mmPerCoordinate: number }
  | { readonly ok: false; readonly refusal: ConnectorScaleRefusal };

export interface ConnectorPhysicalContext {
  /** The unit the coordinates are read in. Anything that is not a known unit is refused, never defaulted. */
  readonly unit: string | undefined;
  /** The placement's uniform scale, or NaN when the placement has none (`classifyPlacement`). */
  readonly placementScale: number;
  /** Whether the placement scale takes part in the factor. See the note above on why this is a parameter in C03-A. */
  readonly placementScaleApplied: boolean;
}

/** Millimetres per coordinate unit, or the reason there is none. The one place the factor is formed. */
export function resolveMillimetresPerCoordinate(
  context: ConnectorPhysicalContext,
): MillimetresPerCoordinate {
  const { unit } = context;
  if (unit === undefined || !isLengthUnit(unit)) return { ok: false, refusal: 'UNKNOWN_UNITS' };
  if (!context.placementScaleApplied)
    return { ok: true, mmPerCoordinate: millimetresPerUnit(unit) };
  if (!Number.isFinite(context.placementScale) || context.placementScale <= 0)
    return { ok: false, refusal: 'UNSUPPORTED_TRANSFORM' };
  return { ok: true, mmPerCoordinate: millimetresPerUnit(unit) * context.placementScale };
}

/** A physical length in the part's own coordinates. The only mm → coordinate conversion. */
export function millimetresToLocal(millimetres: number, mmPerCoordinate: number): number {
  return millimetres / mmPerCoordinate;
}

export type ResolvedConnectorDimensions =
  | {
      readonly ok: true;
      readonly mmPerCoordinate: number;
      readonly diameter: number;
      readonly depth: number;
      readonly clearance: number;
    }
  | { readonly ok: false; readonly refusal: ConnectorScaleRefusal };

/**
 * The three sizes of a round pin, in the part's coordinates. Values are converted, not judged: a NaN, a negative or an
 * out-of-range number comes out as the same kind of number it went in as, and the engine's own bound refuses it.
 */
export function resolveConnectorDimensions(
  intent: ConnectorDimensionIntent,
  context: ConnectorPhysicalContext,
): ResolvedConnectorDimensions {
  const factor = resolveMillimetresPerCoordinate(context);
  if (!factor.ok) return factor;
  return {
    ok: true,
    mmPerCoordinate: factor.mmPerCoordinate,
    diameter: millimetresToLocal(intent.diameterMm, factor.mmPerCoordinate),
    depth: millimetresToLocal(intent.depthMm, factor.mmPerCoordinate),
    clearance: millimetresToLocal(intent.clearanceMm, factor.mmPerCoordinate),
  };
}
