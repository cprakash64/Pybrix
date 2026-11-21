import type { JointDescriptor, PartDescriptor } from '@cadfixer/geometry-runtime';

/**
 * THE PAGE'S VIEW OF THE CONNECTOR JOINTS (Stage EC-4): a projection of what the worker lists, never an authority.
 *
 * Before this stage the page kept its own record of every connector, a list inside the assembly layout, built from the size the
 * split asked for and a transform-norm bound, and carried across later cuts by a sign test with a hard-coded `1e-8` that silently
 * dropped what it could not place. That was a second authority holding facts about geometry, bound to no identity of the geometry. It is
 * gone. What the page knows about a connector is what `joint/list` says about the revision it is looking at, and a later change to a
 * piece retires the joint in the worker, exactly, with no tolerance: the connector then stops being shown as editable rather than being
 * guessed onto a new piece.
 *
 * FRAMEWORK-FREE and geometry-free in the sense that matters: the numbers here are positions, directions and lengths in the SCENE's own
 * coordinates, which the worker computed under the placement, so the page lays them against what it draws without holding a mesh, a
 * placement inverse or an interface.
 */

export type Vec3 = readonly [number, number, number];

/** The joints of ONE revision of ONE document. A slice whose handle is not the model's is stale and is read as nothing. */
export type JointsSlice =
  | {
      readonly status: 'READY';
      readonly documentId: string;
      readonly revision: number;
      readonly joints: readonly JointDescriptor[];
    }
  | { readonly status: 'UNAVAILABLE'; readonly documentId: string; readonly revision: number };

/** What is known about this model's joints right now. `undefined` means not yet listed, or listed for another revision. */
export function jointsFor(
  slice: JointsSlice | undefined,
  handle: { readonly documentId: string; readonly revision: number } | undefined,
): JointsSlice | undefined {
  if (slice === undefined || handle === undefined) return undefined;
  return slice.documentId === handle.documentId && slice.revision === handle.revision
    ? slice
    : undefined;
}

/** The descriptors for this model, or none: a missing, stale or unavailable list shows no connector as editable. */
export function currentJoints(
  slice: JointsSlice | undefined,
  handle: { readonly documentId: string; readonly revision: number } | undefined,
): readonly JointDescriptor[] {
  const current = jointsFor(slice, handle);
  return current?.status === 'READY' ? current.joints : [];
}

/** One connector as the viewport and the inspector use it, in scene units. */
export interface ConnectorPairView {
  /** `jointId/pinId`: stable while the pin exists, and gone with it. */
  readonly id: string;
  readonly jointId: string;
  readonly pinId: string;
  readonly a: string;
  readonly b: string;
  readonly center: Vec3;
  /** Unit direction the pin points from the cut. */
  readonly axis: Vec3;
  readonly maleSide: 'A' | 'B';
  readonly diameter: number;
  readonly depth: number;
  readonly clearance: number;
  /**
   * How far from the centre a plane may pass without cutting into the connector: the socket's reach, with the same 0.01 percent of
   * depth the engine adds so the primitive overlaps its piece. A GUARD, so it errs outward; it replaces a transform-norm upper bound
   * that was only ever a bound.
   */
  readonly guardRadiusWorld: number;
}

/** The connectors of the ATTACHED joints, in the order the worker listed them. */
export function connectorPairsOf(joints: readonly JointDescriptor[]): readonly ConnectorPairView[] {
  const pairs: ConnectorPairView[] = [];
  for (const joint of joints) {
    const connector = joint.status === 'ATTACHED' ? joint.connector : undefined;
    if (connector === undefined) continue;
    const scene = (millimetres: number): number => millimetres / connector.mmPerSceneUnit;
    for (const pin of connector.pins) {
      const diameter = scene(pin.diameterMm),
        depth = scene(pin.depthMm),
        clearance = scene(pin.clearanceMm);
      pairs.push({
        id: `${joint.jointId}/${pin.pinId}`,
        jointId: joint.jointId,
        pinId: pin.pinId,
        a: joint.aPartId,
        b: joint.bPartId,
        center: pin.center,
        axis: connector.axis,
        maleSide: connector.maleSide,
        diameter,
        depth,
        clearance,
        guardRadiusWorld: Math.hypot(depth * (1 + 1e-4), diameter / 2 + clearance),
      });
    }
  }
  return pairs;
}

/**
 * The one connector whose pin or socket a picked point lies on, on `part`, or `undefined` when none or several do.
 *
 * Measured in the scene: along the pin's axis from the cut, and across it, with a little padding so a click on the edge of a pin still
 * finds it. Everything is already in scene units, so there is no placement to invert and no unit to convert.
 */
export function connectorAtPoint(
  pairs: readonly ConnectorPairView[],
  part: Pick<PartDescriptor, 'partId'>,
  point: Vec3,
): string | undefined {
  const matches: string[] = [];
  for (const pair of pairs) {
    if (pair.a !== part.partId && pair.b !== part.partId) continue;
    const diff: Vec3 = [
      point[0] - pair.center[0],
      point[1] - pair.center[1],
      point[2] - pair.center[2],
    ];
    const along = diff[0] * pair.axis[0] + diff[1] * pair.axis[1] + diff[2] * pair.axis[2];
    const padding = pair.diameter * 0.03;
    const radius = pair.diameter / 2 + pair.clearance + padding;
    const across = diff[0] * diff[0] + diff[1] * diff[1] + diff[2] * diff[2] - along * along;
    if (along >= -padding && along <= pair.depth + padding && across <= radius * radius)
      matches.push(pair.id);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
