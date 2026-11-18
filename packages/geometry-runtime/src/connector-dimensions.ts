import { type PlacementClass, type PlacementRefusal } from '@cadfixer/mesh-core';
import { isLengthUnit, millimetresPerUnit } from '@cadfixer/shared';

/**
 * THE ONE PLACE A CONNECTOR DIMENSION BECOMES A LOCAL LENGTH, AND A LOCAL LENGTH BECOMES A PHYSICAL ONE.
 *
 * A connector dimension is a PHYSICAL length in millimetres. The mesh it is cut into is measured in the part's own coordinates,
 * and the conversion between the two is one factor, `mmPerCoordinate`: how many millimetres one coordinate unit of the part is
 * once it is placed. It is the model's unit (`millimetresPerUnit`) times the placement's uniform scale, and for every connector
 * — manual or automatic, any unit, any supported placement — that is the whole of it:
 *
 *     physical mm = local length × millimetresPerUnit(unit) × placement scale        (Phase 0, Interpretation A)
 *     local length = physical mm ÷ (millimetresPerUnit(unit) × placement scale)
 *
 * Nothing else in the connector code turns millimetres into coordinates, or coordinates into millimetres: the page sends the
 * physical intent, the automatic planner asks here for its factor and for both directions of the conversion, and the engine
 * resolves a physical request here. A second `millimetresPerUnit(` beside the planner, the engine or the page is a second
 * answer to "how big is a coordinate", and the first time two of them disagreed a connector would be the wrong size without
 * anything failing (a boundary test holds the line).
 *
 * THE PHYSICAL RANGE LIVES HERE TOO (Stage C03-C1). The engine used to bound every connector dimension to 0.01 – 1000 in
 * COORDINATE units. That is a physical product limit (the panel advertises 0.01 – 1000 mm) that was applied after the conversion
 * had been skipped: it refused the default Ø4 mm pin on a model read in metres (0.004) and in microns (4,000) while accepting the
 * same pin in millimetres. The range is now checked on the millimetre intent, BEFORE conversion, so the same physical request is
 * accepted or refused for the same physical reason in every unit. What remains in local coordinates is only what is numeric: the
 * resolved values must be finite and positive (clearance may be zero). Nothing else is bounded here; whether a pin fits is
 * the geometric validators' question, answered in local geometry with the tolerance of the part itself.
 */

/** The physical range of a connector dimension, in millimetres: a product limit, never a coordinate-space number. */
export const CONNECTOR_DIMENSION_POLICY_MM = Object.freeze({
  /** Pin diameter and depth must be at least this. */
  minimum: 0.01,
  /** Every dimension is at most this. */
  maximum: 1000,
  /** Radial clearance may be zero, and no less. */
  clearanceMinimum: 0,
});

/** What a person asked for, in millimetres. */
export interface ConnectorDimensionIntent {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly clearanceMm: number;
}

/** Which dimension of a round pin a refusal is about. */
export type ConnectorDimensionName = 'PIN_DIAMETER' | 'PIN_DEPTH' | 'PIN_CLEARANCE';

/** Why a physical size could not be resolved. These are not geometry findings: nothing was examined. */
export type ConnectorScaleRefusal = 'UNKNOWN_UNITS' | 'UNSUPPORTED_TRANSFORM';

/** A model's unit, or the fact that there is none. Never defaulted, never guessed from the size of the model. */
export type ModelUnitResolution =
  | { readonly ok: true; readonly mmPerUnit: number }
  | { readonly ok: false; readonly refusal: 'UNKNOWN_UNITS' };

/** Millimetres per coordinate unit of the model's own unit, or the reason there is none. */
export function resolveModelUnit(unit: string | undefined): ModelUnitResolution {
  if (unit === undefined || !isLengthUnit(unit)) return { ok: false, refusal: 'UNKNOWN_UNITS' };
  return { ok: true, mmPerUnit: millimetresPerUnit(unit) };
}

export type MillimetresPerCoordinate =
  | {
      readonly ok: true;
      /** Millimetres one coordinate of the PLACED part is: `mmPerUnit × placementScale`. */
      readonly mmPerCoordinate: number;
      /** Its two factors, so a plan can state what it was built from instead of a product nobody can take apart. */
      readonly mmPerUnit: number;
      readonly placementScale: number;
    }
  | { readonly ok: false; readonly refusal: 'UNKNOWN_UNITS' }
  | {
      readonly ok: false;
      readonly refusal: 'UNSUPPORTED_TRANSFORM';
      /** WHY the placement is not a similarity: the classifier's own reason, carried, never recomputed or collapsed. */
      readonly transformReason: PlacementRefusal;
    };

/** What the factor depends on: the model's unit and the placement `classifyPlacement` answered. Nothing else. */
export interface ConnectorPhysicalContext {
  /** The unit the coordinates are read in. Anything that is not a known unit is refused, never defaulted. */
  readonly unit: string | undefined;
  /** The part's placement as `classifyPlacement` answered it. A mirror changes no distance, so only its scale is read. */
  readonly placement: PlacementClass;
}

/** Millimetres per coordinate of the placed part, or the reason there is none. The one place the factor is formed. */
export function resolveMillimetresPerCoordinate(
  context: ConnectorPhysicalContext,
): MillimetresPerCoordinate {
  const resolved = resolveModelUnit(context.unit);
  if (!resolved.ok) return resolved;
  const { placement } = context;
  if (placement.kind === 'UNSUPPORTED')
    return { ok: false, refusal: 'UNSUPPORTED_TRANSFORM', transformReason: placement.reason };
  return {
    ok: true,
    mmPerCoordinate: resolved.mmPerUnit * placement.scale,
    mmPerUnit: resolved.mmPerUnit,
    placementScale: placement.scale,
  };
}

/** A physical length in the part's own coordinates. The only mm → coordinate conversion. */
export function millimetresToLocal(millimetres: number, mmPerCoordinate: number): number {
  return millimetres / mmPerCoordinate;
}

/** A length in the part's own coordinates as physical millimetres. The only coordinate → mm conversion. */
export function localToMillimetres(local: number, mmPerCoordinate: number): number {
  return local * mmPerCoordinate;
}

/** Why a requested dimension was refused: it is outside the physical range, or it cannot be represented in local coordinates. */
export type DimensionRefusalReason = 'OUT_OF_RANGE' | 'NOT_REPRESENTABLE';

export interface DimensionOutOfPolicy {
  readonly ok: false;
  readonly refusal: 'DIMENSION_OUT_OF_POLICY';
  readonly dimension: ConnectorDimensionName;
  readonly reason: DimensionRefusalReason;
  /** What was asked for. */
  readonly valueMm: number;
  /** The physical range it was held to. */
  readonly minMm: number;
  readonly maxMm: number;
}

export type ResolvedConnectorDimensions =
  | {
      readonly ok: true;
      readonly mmPerCoordinate: number;
      readonly mmPerUnit: number;
      readonly placementScale: number;
      readonly diameter: number;
      readonly depth: number;
      readonly clearance: number;
    }
  | Exclude<MillimetresPerCoordinate, { readonly ok: true }>
  | DimensionOutOfPolicy;

/**
 * The three sizes of a round pin, in the part's coordinates.
 *
 * Judged in this order, and the first failure is the answer: the unit, the placement, then each dimension's PHYSICAL range
 * (diameter, depth, clearance), then whether each resolved local length is a usable number. Nothing is clamped.
 */
export function resolveConnectorDimensions(
  intent: ConnectorDimensionIntent,
  context: ConnectorPhysicalContext,
): ResolvedConnectorDimensions {
  const factor = resolveMillimetresPerCoordinate(context);
  if (!factor.ok) return factor;
  const { minimum, maximum, clearanceMinimum } = CONNECTOR_DIMENSION_POLICY_MM;
  const checks: readonly [ConnectorDimensionName, number, number][] = [
    ['PIN_DIAMETER', intent.diameterMm, minimum],
    ['PIN_DEPTH', intent.depthMm, minimum],
    ['PIN_CLEARANCE', intent.clearanceMm, clearanceMinimum],
  ];
  for (const [dimension, valueMm, minMm] of checks)
    if (!Number.isFinite(valueMm) || valueMm < minMm || valueMm > maximum)
      return {
        ok: false,
        refusal: 'DIMENSION_OUT_OF_POLICY',
        dimension,
        reason: 'OUT_OF_RANGE',
        valueMm,
        minMm,
        maxMm: maximum,
      };
  const diameter = millimetresToLocal(intent.diameterMm, factor.mmPerCoordinate),
    depth = millimetresToLocal(intent.depthMm, factor.mmPerCoordinate),
    clearance = millimetresToLocal(intent.clearanceMm, factor.mmPerCoordinate);
  const local: readonly [ConnectorDimensionName, number, number, boolean][] = [
    ['PIN_DIAMETER', diameter, intent.diameterMm, true],
    ['PIN_DEPTH', depth, intent.depthMm, true],
    ['PIN_CLEARANCE', clearance, intent.clearanceMm, false],
  ];
  for (const [dimension, length, valueMm, positive] of local)
    if (!Number.isFinite(length) || (positive ? !(length > 0) : !(length >= 0)))
      return {
        ok: false,
        refusal: 'DIMENSION_OUT_OF_POLICY',
        dimension,
        reason: 'NOT_REPRESENTABLE',
        valueMm,
        minMm: dimension === 'PIN_CLEARANCE' ? clearanceMinimum : minimum,
        maxMm: maximum,
      };
  return {
    ok: true,
    mmPerCoordinate: factor.mmPerCoordinate,
    mmPerUnit: factor.mmPerUnit,
    placementScale: factor.placementScale,
    diameter,
    depth,
    clearance,
  };
}
