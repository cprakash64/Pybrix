import type { DimensionOutOfPolicy } from './connector-dimensions';

/**
 * THE ONE MAPPING FROM "WHY A CONNECTOR DIMENSION WAS REFUSED" TO WHAT A PERSON IS TOLD.
 *
 * A refusal here is about a number the person (or the planner) asked for, not about the model: it names the metric, the value
 * and the limit, in millimetres, and says nothing about the model's unit — the same physical request reads the same sentence in
 * every unit. The switches are exhaustive with no `default`, so a new dimension or reason fails to compile until it has words.
 */
function labelOf(dimension: DimensionOutOfPolicy['dimension']): string {
  switch (dimension) {
    case 'PIN_DIAMETER':
      return 'Pin diameter';
    case 'PIN_DEPTH':
      return 'Pin depth';
    case 'PIN_CLEARANCE':
      return 'Pin clearance';
  }
}

export function describeDimensionRefusal(refusal: DimensionOutOfPolicy): string {
  const label = labelOf(refusal.dimension);
  const range = `${String(refusal.minMm)}–${String(refusal.maxMm)} mm`;
  switch (refusal.reason) {
    case 'OUT_OF_RANGE':
      return Number.isFinite(refusal.valueMm)
        ? `${label} of ${String(refusal.valueMm)} mm is outside the range Pybrix can place (${range}).`
        : `${label} must be a number in the range Pybrix can place (${range}).`;
    case 'NOT_REPRESENTABLE':
      return `${label} of ${String(refusal.valueMm)} mm cannot be represented at this model's scale.`;
  }
}
