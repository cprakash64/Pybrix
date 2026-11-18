import { throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import type { CanonicalMesh, PlacementClass, PlacementRefusal } from '@cadfixer/mesh-core';
import {
  localToMillimetres,
  millimetresToLocal,
  resolveMillimetresPerCoordinate,
} from './connector-dimensions';
import {
  connectorCenters,
  type ConnectorCompatibilitySurface,
  type SplitConnector,
  type SplitVector,
} from './split-connectors';
/**
 * The automatic planner's PHYSICAL policy. Every `…Mm` value is millimetres of the printed part, never a coordinate: it is converted
 * to the part's own coordinates by `millimetresToLocal` with the factor the one resolver forms, and a part's coordinates are
 * converted back by `localToMillimetres`. No literal length stands in the planner's arithmetic; the fractions and ratios (a share of
 * the cut's span, a share of the pin diameter) are dimensionless and are the same in every unit.
 */
export const AUTOMATIC_CONNECTOR_LIMITS = Object.freeze({
  rayTriangleVisits: 8000000,
  maximumPairs: 3,
  minimumDiameterMm: 1,
  maximumDiameterMm: 6,
  clearanceMm: 0.2,
  /** The least wall left around a socket, before the dimensionless share of the diameter takes over. */
  wallMinimumMm: 0.6,
  /** The deepest pin proposed. */
  depthMaximumMm: 6,
  /** A cut at least this wide (its shorter span) takes two pins, and at least `threePinSpanMm` takes three. */
  twoPinSpanMm: 20,
  threePinSpanMm: 45,
});
export type AutomaticConnectorReason =
  | 'AVAILABLE'
  | 'UNKNOWN_UNITS'
  | 'INSUFFICIENT_CLEARANCE'
  | 'INSUFFICIENT_WALL'
  | 'UNSUPPORTED_INTERFACE'
  | 'NO_SAFE_SITE'
  /** Release 2, Slice 2B: a proposed site's footprint is not inside the generated interface. Typed detail is on the refusal. */
  | 'FOOTPRINT_NOT_CONTAINED'
  /** Release 2, Slice 2B: the generated interface could not be read as a material region, so no footprint was judged. */
  | 'INTERFACE_REGION_UNAVAILABLE'
  /** Release 2, Slice 2C: the socket volume meets another boundary of the receiving piece before its full depth. */
  | 'SOCKET_BREAKTHROUGH'
  /** Release 2, Slice 2C: the receiving piece could not be examined, so no socket was judged. */
  | 'AXIAL_VALIDATION_UNAVAILABLE'
  /** Release 2, Slice 2D: the grown socket (`support-v1`) reaches another boundary of the receiving piece. */
  | 'SOCKET_SUPPORT_INSUFFICIENT'
  /** Release 2, Slice 2D: the envelope behind the pin root (`support-v1`) reaches another boundary of the male piece. */
  | 'PIN_ROOT_SUPPORT_INSUFFICIENT'
  /** Release 2, Slice 2D: a piece could not be examined for support, so no connector was judged. */
  | 'SUPPORT_VALIDATION_UNAVAILABLE'
  /**
   * Release 2, Slice 2D: the part's placement is not a similarity; no connector is proposed. Stage C03-B: the diagnostics' `transformReason`
   * says which kind of placement it is.
   */
  | 'UNSUPPORTED_TRANSFORM';
export interface AutomaticConnectorDiagnostics {
  reason: AutomaticConnectorReason;
  /** Present exactly when `reason` is `UNSUPPORTED_TRANSFORM`: why the placement cannot carry a connector (`classifyPlacement`). */
  transformReason?: PlacementRefusal;
  proposedSites: number;
  placementAttempts: number;
  rayTriangleVisits: number;
  milliseconds: number;
  scratchBytes: number;
}
type Pin = Extract<SplitConnector, { kind: 'pin' }>;
function exitDistance(
  mesh: CanonicalMesh,
  origin: SplitVector,
  direction: SplitVector,
  budget: { visits: number },
  cancellation: CancellationToken,
): number | undefined {
  let nearest = Infinity;
  for (let f = 0; f < mesh.indices.length / 3; f++) {
    if ((f & 4095) === 0) throwIfCancelled(cancellation);
    if (++budget.visits > AUTOMATIC_CONNECTOR_LIMITS.rayTriangleVisits) return undefined;
    const ai = (mesh.indices[f * 3] ?? 0) * 3,
      bi = (mesh.indices[f * 3 + 1] ?? 0) * 3,
      ci = (mesh.indices[f * 3 + 2] ?? 0) * 3;
    const ax = mesh.positions[ai] ?? 0,
      ay = mesh.positions[ai + 1] ?? 0,
      az = mesh.positions[ai + 2] ?? 0;
    const ux = (mesh.positions[bi] ?? 0) - ax,
      uy = (mesh.positions[bi + 1] ?? 0) - ay,
      uz = (mesh.positions[bi + 2] ?? 0) - az;
    const vx = (mesh.positions[ci] ?? 0) - ax,
      vy = (mesh.positions[ci + 1] ?? 0) - ay,
      vz = (mesh.positions[ci + 2] ?? 0) - az;
    const px = direction[1] * vz - direction[2] * vy,
      py = direction[2] * vx - direction[0] * vz,
      pz = direction[0] * vy - direction[1] * vx,
      det = ux * px + uy * py + uz * pz;
    if (Math.abs(det) < 1e-12) continue;
    const tx = origin[0] - ax,
      ty = origin[1] - ay,
      tz = origin[2] - az,
      inv = 1 / det,
      u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * uz - tz * uy,
      qy = tz * ux - tx * uz,
      qz = tx * uy - ty * ux,
      v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (vx * qx + vy * qy + vz * qz) * inv;
    if (t > 1e-7) nearest = Math.min(nearest, t);
  }
  return Number.isFinite(nearest) ? nearest : undefined;
}
/**
 * A bounded conservative PROPOSAL: where the sites could go and how large a pin to try. It decides nothing about material support.
 *
 * SIZING, NOT VERIFICATION (Slice 2D). `wall` below is a sizing allowance the proposal leaves around its own sites and behind its own
 * depth; the old Boolean guard-volume test that used to PROVE it in `splitWithConnectors` is retired, and the one verdict on material
 * support is `support-v1` (`connector-support.ts`), applied to manual and automatic plans alike. The millimetre terms in this file
 * (the 0.6 mm part of `wall`, the 6 mm depth, the 1–6 mm diameter range, the 0.2 mm clearance) are automatic-connector SIZING
 * defaults: they choose what to propose, they refuse nothing on physical grounds, and they are the absolute connector sizing audit
 * C03 still owns. A proposal that is too thin is refused by `support-v1`, in coordinates, with no unit.
 */
export function automaticPinPlan(
  a: CanonicalMesh,
  b: CanonicalMesh,
  cut: ConnectorCompatibilitySurface,
  normal: SplitVector,
  unit: string,
  placement: PlacementClass,
  tolerance: number,
  cancellation: CancellationToken,
  diagnostics?: AutomaticConnectorDiagnostics,
): { connector: Pin; centers: readonly SplitVector[] } | undefined {
  const started = Date.now(),
    budget = { visits: 0 };
  const record = (reason: AutomaticConnectorReason): void => {
    if (diagnostics) {
      diagnostics.reason = reason;
      diagnostics.rayTriangleVisits = budget.visits;
      diagnostics.milliseconds = Date.now() - started;
    }
  };
  const refuse = (
    reason: AutomaticConnectorReason,
    transformReason?: PlacementRefusal,
  ): undefined => {
    record(reason);
    if (diagnostics && transformReason !== undefined) diagnostics.transformReason = transformReason;
    return undefined;
  };
  throwIfCancelled(cancellation);
  /*
   * The unit and the part's placement arrive as two facts; the one factor that joins them is formed in `connector-dimensions`
   * (millimetres per coordinate unit, the placement scale applied) and nowhere in this file. A unit that is not a known one and a
   * placement that is not a similarity each refuse BEFORE anything is proposed, the latter with the classifier's own reason.
   */
  const physical = resolveMillimetresPerCoordinate({ unit, placement });
  if (!physical.ok) {
    if (physical.refusal === 'UNSUPPORTED_TRANSFORM')
      refuse(physical.refusal, physical.transformReason);
    else refuse(physical.refusal);
    return;
  }
  if (cut.outlineTruncated) {
    refuse('UNSUPPORTED_INTERFACE');
    return;
  }
  const mm = physical.mmPerCoordinate,
    span = localToMillimetres(Math.min(cut.spanU, cut.spanV), mm);
  const clearance = millimetresToLocal(AUTOMATIC_CONNECTOR_LIMITS.clearanceMm, mm),
    diameterMm = Math.min(
      AUTOMATIC_CONNECTOR_LIMITS.maximumDiameterMm,
      span * 0.12,
      localToMillimetres(cut.interiorCandidates[0]?.edgeDistance ?? cut.centerEdgeDistance, mm) *
        0.8,
    );
  if (diameterMm < AUTOMATIC_CONNECTOR_LIMITS.minimumDiameterMm) {
    refuse('INSUFFICIENT_CLEARANCE');
    return;
  }
  const diameter = millimetresToLocal(diameterMm, mm),
    wall = Math.max(
      millimetresToLocal(AUTOMATIC_CONNECTOR_LIMITS.wallMinimumMm, mm),
      diameter * 0.3,
    ),
    count: 1 | 2 | 3 =
      span >= AUTOMATIC_CONNECTOR_LIMITS.threePinSpanMm
        ? 3
        : span >= AUTOMATIC_CONNECTOR_LIMITS.twoPinSpanMm
          ? 2
          : 1;
  let points: SplitVector[];
  try {
    points = connectorCenters(
      cut,
      count,
      diameter / 2 + clearance + wall,
      Math.max(tolerance * 8, diameter / 4),
    );
  } catch {
    refuse('INSUFFICIENT_CLEARANCE');
    return;
  }
  if (diagnostics) diagnostics.proposedSites = points.length;
  const length = Math.hypot(...normal),
    n: SplitVector = [normal[0] / length, normal[1] / length, normal[2] / length],
    reference: SplitVector = Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const cross: SplitVector = [
      n[1] * reference[2] - n[2] * reference[1],
      n[2] * reference[0] - n[0] * reference[2],
      n[0] * reference[1] - n[1] * reference[0],
    ],
    cl = Math.hypot(...cross),
    u: SplitVector = [cross[0] / cl, cross[1] / cl, cross[2] / cl],
    v: SplitVector = [
      n[1] * u[2] - n[2] * u[1],
      n[2] * u[0] - n[0] * u[2],
      n[0] * u[1] - n[1] * u[0],
    ];
  let depth = Math.min(
    millimetresToLocal(AUTOMATIC_CONNECTOR_LIMITS.depthMaximumMm, mm),
    diameter * 1.5,
  );
  for (const center of points)
    for (let sample = 0; sample < 9; sample++) {
      throwIfCancelled(cancellation);
      const radius = sample === 0 ? 0 : diameter / 2 + clearance + wall,
        angle = ((sample - 1) * Math.PI) / 4,
        point: SplitVector = [0, 1, 2].map(
          (axis) =>
            defined(center[axis]) +
            radius * (Math.cos(angle) * defined(u[axis]) + Math.sin(angle) * defined(v[axis])),
        ) as unknown as SplitVector;
      for (const [mesh, sign] of [
        [a, 1],
        [b, -1],
      ] as const) {
        const direction: SplitVector = [n[0] * sign, n[1] * sign, n[2] * sign],
          origin: SplitVector = [
            point[0] + direction[0] * tolerance * 8,
            point[1] + direction[1] * tolerance * 8,
            point[2] + direction[2] * tolerance * 8,
          ],
          distance = exitDistance(mesh, origin, direction, budget, cancellation);
        if (distance === undefined) {
          refuse('NO_SAFE_SITE');
          return;
        }
        depth = Math.min(depth, distance - wall);
      }
    }
  if (depth < diameter) {
    refuse('INSUFFICIENT_WALL');
    return;
  }
  record('AVAILABLE');
  return {
    centers: points,
    connector: { kind: 'pin', count, diameter, depth, clearance, maleSide: 'A' },
  };
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required bounded geometry evidence is missing.');
  return value;
}
