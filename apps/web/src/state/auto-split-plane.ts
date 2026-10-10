import type { SplitPlane } from '@cadfixer/geometry-runtime';
import {
  axisIndex,
  clampOffset,
  clampRoll,
  clampTilt,
  splitPlaneFor,
  splitRange,
  type PartBoundsLike,
  type SplitAxis,
  type SplitPlaneSettings,
} from './split-presentation';

/**
 * A SUGGESTED CUT, EXPRESSED IN MANUAL SPLIT'S OWN CONTROLS.
 *
 * Auto Split has no plane editor of its own. A suggestion is a plane in the part's coordinates; this
 * turns it into the axis, position, tilt, roll and side that Manual Split already has, so editing a
 * suggestion IS editing the manual plane and `splitPlaneFor` stays the only function that turns
 * settings into a plane. The mapping is analytic and then CHECKED: the plane the settings produce is
 * compared with the suggested one and the difference is returned, so a suggestion the controls cannot
 * express (an offset outside the part's range, a tilt past the limit) is reported rather than
 * silently approximated.
 */
export interface SuggestedPlaneSettings {
  readonly settings: SplitPlaneSettings;
  /** Angle between the suggested normal and the plane the settings produce, in degrees. */
  readonly angleErrorDegrees: number;
  /** Distance between the two planes at the suggested origin, as a fraction of the part's diagonal. */
  readonly offsetError: number;
  /** True when the settings reproduce the suggestion to within the tolerances below. */
  readonly exact: boolean;
}

export const PLANE_ANGLE_TOLERANCE_DEGREES = 0.05;
export const PLANE_OFFSET_TOLERANCE = 1e-4;

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

const degrees = (radians: number): number => (radians * 180) / Math.PI;

export function planeSettingsFor(
  plane: SplitPlane,
  bounds: PartBoundsLike | undefined,
): SuggestedPlaneSettings {
  const length = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  const n: readonly [number, number, number] =
    length > 0
      ? [plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length]
      : [0, 0, 1];
  // The dominant axis first: it is the one whose tilt and roll stay smallest. Another axis is tried
  // only when the dominant one cannot place the plane inside the part's range, and the first
  // expression that reproduces the suggestion wins; otherwise the closest one is returned, marked
  // inexact.
  const order = (['Z', 'Y', 'X'] as const)
    .slice()
    .sort((a, b) => Math.abs(n[axisIndex(b)]) - Math.abs(n[axisIndex(a)]));
  let best: SuggestedPlaneSettings | undefined;
  for (const axis of order) {
    if (Math.abs(n[axisIndex(axis)]) < 1e-6) continue;
    const candidate = settingsOnAxis(plane, n, axis, bounds);
    if (candidate.exact) return candidate;
    if (
      best === undefined ||
      candidate.angleErrorDegrees / 90 + candidate.offsetError <
        best.angleErrorDegrees / 90 + best.offsetError
    )
      best = candidate;
  }
  return best ?? settingsOnAxis(plane, n, 'Z', bounds);
}

function settingsOnAxis(
  plane: SplitPlane,
  n: readonly [number, number, number],
  axis: SplitAxis,
  bounds: PartBoundsLike | undefined,
): SuggestedPlaneSettings {
  const index = axisIndex(axis);
  const flipped = n[index] < 0;
  const m: readonly [number, number, number] = flipped ? [-n[0], -n[1], -n[2]] : n;

  // The inverse of `splitPlaneFor`'s tilt then roll, per axis. `m` is the unflipped normal.
  let tilt: number;
  let roll: number;
  if (axis === 'Z') {
    tilt = degrees(Math.asin(Math.max(-1, Math.min(1, m[0]))));
    roll = degrees(Math.atan2(-m[1], m[2]));
  } else if (axis === 'Y') {
    tilt = degrees(Math.asin(Math.max(-1, Math.min(1, m[2]))));
    roll = degrees(Math.atan2(-m[0], m[1]));
  } else {
    tilt = degrees(Math.asin(Math.max(-1, Math.min(1, m[1]))));
    roll = degrees(Math.atan2(-m[2], m[0]));
  }
  // A roll that is zero is exactly zero: `splitPlaneFor` skips the roll then, and a sliver of
  // floating-point noise would take the unqualified path out of its way.
  if (Math.abs(roll) < 1e-9) roll = 0;
  if (Math.abs(tilt) < 1e-9) tilt = 0;

  // `splitPlaneFor` puts the plane through the part's centre with only the axis coordinate moved to
  // the offset; solve for the offset that makes that plane pass through the suggested origin.
  const center = bounds?.center ?? [0, 0, 0];
  const range = splitRange(axis, bounds);
  const toOrigin: readonly number[] = [
    plane.origin[0] - center[0],
    plane.origin[1] - center[1],
    plane.origin[2] - center[2],
  ];
  const component = n[index];
  const rawOffset = center[index] + dot(n, toOrigin) / (component === 0 ? 1 : component);
  const settings: SplitPlaneSettings = {
    axis,
    offset: clampOffset(rawOffset, range, range.center),
    tilt: clampTilt(tilt, 0),
    roll: clampRoll(roll, 0),
    flipped,
  };

  const produced = splitPlaneFor(settings, bounds);
  const producedLength = Math.hypot(produced.normal[0], produced.normal[1], produced.normal[2]);
  const cosine = Math.max(-1, Math.min(1, dot(produced.normal, n) / (producedLength || 1)));
  const angleErrorDegrees = degrees(Math.acos(cosine));
  const diagonal = bounds
    ? Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      )
    : 1;
  const offsetError =
    Math.abs(
      dot(produced.normal, [
        plane.origin[0] - produced.origin[0],
        plane.origin[1] - produced.origin[1],
        plane.origin[2] - produced.origin[2],
      ]) / (producedLength || 1),
    ) / (diagonal || 1);
  return {
    settings,
    angleErrorDegrees,
    offsetError,
    exact:
      angleErrorDegrees <= PLANE_ANGLE_TOLERANCE_DEGREES && offsetError <= PLANE_OFFSET_TOLERANCE,
  };
}
