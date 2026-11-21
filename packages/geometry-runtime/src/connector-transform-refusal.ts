import { PlacementRefusal } from '@cadfixer/mesh-core';

/**
 * THE ONE MAPPING FROM "WHY THIS PLACEMENT IS NOT A SIMILARITY" TO WHAT A PERSON IS TOLD.
 *
 * `classifyPlacement` (mesh-core) says WHY a placement cannot carry a connector; this is the only place that reason becomes a
 * sentence. The manual path (an `AppError` the page shows) and the automatic path (typed diagnostics any consumer may word) both
 * ask here, so the two cannot say different things about the same placement, and a new `PlacementRefusal` fails to compile until
 * it has a sentence. The switch is exhaustive on purpose and has no `default`.
 *
 * The sentences name the cause in the user's terms. They do not show a determinant, a residual, a tolerance or the name of an
 * internal classifier, and they promise no remedy this product does not have (it has no transform editor).
 */
export function describeTransformRefusal(reason: PlacementRefusal): string {
  switch (reason) {
    case PlacementRefusal.NonUniformScale:
      return 'Connectors require uniform model scale.';
    case PlacementRefusal.Shear:
      return "Connectors aren't supported on sheared model placements.";
    case PlacementRefusal.Degenerate:
      return 'This model placement has an invalid scale.';
    case PlacementRefusal.Malformed:
    case PlacementRefusal.NonFinite:
      return 'This model placement is invalid.';
  }
}
