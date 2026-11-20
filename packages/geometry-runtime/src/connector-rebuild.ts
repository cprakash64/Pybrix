import {
  type CanonicalMesh,
  type ConnectorJoint,
  type JointConnectorSpec,
  type JointInterfaceAuthority,
  type JointSite,
  type PlacementClass,
  MAX_PINS_PER_JOINT,
} from '@cadfixer/mesh-core';
import { invalidState, throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import type { BooleanBackend } from './boolean-adapter';
import { connectorSupportMargin } from './connector-policy';
import type { ClosedPlaneClip } from './closed-plane-kernel';
import {
  ConnectorRefusal,
  connectorManifestOf,
  draftFromRequest,
  interfaceCoordinates,
  planManualPins,
  type ConnectorManifest,
} from './connector-plan';
import {
  assertRepresentablePin,
  constructPinConnectors,
  issuePlan,
  minimumPinSpacing,
  pinsTooClose,
  requireSolid,
  resolvePhysicalPin,
  type PhysicalPinRequest,
  type PinCut,
  type SplitConnector,
  type SplitVector,
} from './split-connectors';
import { splitBufferSHA } from './split-source-identity';

/**
 * REBUILDING A JOINT'S CONNECTORS FROM WHAT IT RETAINED (Stage EC-2).
 *
 * An edit of a connector is not an inverse of the Booleans that made it: `difference` and `union` are not inverses at the mesh
 * level, and undoing them would accumulate sliver vertices and tolerance. It is a REBUILD. Start from the two pieces the cut
 * produced before any connector, hand them and a connector spec to the same pin stage a first split uses, and take whatever comes
 * out. Because every rebuild starts from the same retained pieces, an edit never builds on a previous edit, and editing a joint
 * back to a spec it had before returns the same bytes it had before.
 *
 * ONE PIN STAGE. `constructPinConnectors` is the body that used to live inside `splitWithConnectors`: footprint containment,
 * receiving material, material support, then the Booleans. A rebuild calls it exactly as a split does, so there is no edit-only
 * validator, no edit-only relaxation and no edit-only refusal: whatever a first split refuses, an edit refuses, with the same code
 * and the same details. The differential test holds that on the real kernel.
 *
 * THIS MODULE DECIDES NOTHING ABOUT WHAT BECOMES AUTHORITATIVE. It returns a candidate (two meshes and the successor joint
 * record) and installs nothing; the transaction that applies it is the next stage.
 */

// ---------------------------------------------------------------- the retained cut

/** The cut a clip result describes, as the pin stage reads it. */
export function pinCutOf(clip: ClosedPlaneClip): PinCut {
  const closed = (report: ClosedPlaneClip['reports'][number]): boolean =>
    report.valid &&
    report.boundaryEdges === 0 &&
    report.nonManifoldVertices === 0 &&
    report.windingConflicts === 0;
  return Object.freeze({
    pieceA: clip.pieceA,
    pieceB: clip.pieceB,
    provenanceA: clip.provenanceA,
    provenanceB: clip.provenanceB,
    closedA: closed(clip.reports[0]),
    closedB: closed(clip.reports[1]),
    interface: clip.interface,
    tolerance: clip.tolerance,
  });
}

/** What the engine holds for a cut beyond the two pieces: the provenance arrays and the arrays of the generated interface. */
export function pinCutRetainedBytes(cut: PinCut): number {
  const region = cut.interface.sharedRegion;
  return (
    cut.provenanceA.byteLength +
    cut.provenanceB.byteLength +
    region.positions.byteLength +
    region.uv.byteLength +
    region.loops.byteLength +
    region.triangles.byteLength +
    region.vertexMapA.byteLength +
    region.vertexMapB.byteLength
  );
}

/** Authority details this module made. The model carries `detail` opaquely; only an object minted here is ever read back. */
const MINTED = new WeakSet<object>();
interface JointCutDetail {
  readonly cut: PinCut;
}

/** The authority a joint retains for a cut: its identity, what it costs, and the cut itself, in a form only this module reads. */
export function jointAuthorityOf(cut: PinCut): JointInterfaceAuthority {
  const detail: JointCutDetail = Object.freeze({ cut });
  MINTED.add(detail);
  return Object.freeze({
    provenanceSHA: splitBufferSHA([cut.provenanceA, cut.provenanceB]),
    retainedBytes: pinCutRetainedBytes(cut),
    detail,
  });
}

/**
 * The cut a joint was built on. Refuses an authority this module did not mint, and one whose pieces are not the joint's own bases:
 * a rebuild from a cut that disagrees with the pieces it claims to be the base of would build geometry on the wrong foundation.
 */
export function pinCutOfJoint(joint: ConnectorJoint): PinCut {
  const { detail } = joint.authority;
  if (!MINTED.has(detail))
    throw invalidState('This connector joint was not made by the connector engine.', {
      code: 'INVALID_PLAN',
      refusal: ConnectorRefusal.INVALID_PLAN,
    });
  const { cut } = detail as JointCutDetail;
  if (cut.pieceA !== joint.a.baseMesh || cut.pieceB !== joint.b.baseMesh)
    throw invalidState('This connector joint does not hold the pieces its cut was made from.', {
      code: 'INVALID_PLAN',
      refusal: ConnectorRefusal.INVALID_PLAN,
    });
  return cut;
}

// -------------------------------------------------------------------------- sites

/**
 * The site at `(u, v)` in the interface's own frame. The point is the interface plane's origin plus `u` and `v` along its two
 * axes, and the returned `u`/`v` are that point read back through `interfaceCoordinates`: the one function that says where a point
 * is in the frame. They may differ from the request by a rounding error, which is the price of `local` being the exact point
 * that gets cut. Whether the site is usable is the validators' question, not this function's.
 */
export function siteOnInterface(cut: Pick<PinCut, 'interface'>, u: number, v: number): JointSite {
  const { outputPlaneOrigin: o, frame } = cut.interface;
  const local: SplitVector = [
    o[0] + u * frame.U[0] + v * frame.V[0],
    o[1] + u * frame.U[1] + v * frame.V[1],
    o[2] + u * frame.U[2] + v * frame.V[2],
  ];
  const read = interfaceCoordinates(cut.interface, local);
  return Object.freeze({ u: read.u, v: read.v, local: Object.freeze(local) });
}

function planRefusal(message: string, extra: Record<string, string | number> = {}): Error {
  return invalidState(message, {
    code: 'INVALID_PLAN',
    refusal: ConnectorRefusal.INVALID_PLAN,
    ...extra,
  });
}

// ------------------------------------------------------------------------ rebuild

export interface JointRebuild {
  readonly pieceA: CanonicalMesh;
  readonly pieceB: CanonicalMesh;
  /** The coordinate pin the engine built, or `undefined` for a plain joint. */
  readonly connector: Extract<SplitConnector, { readonly kind: 'pin' }> | undefined;
  readonly manifest: ConnectorManifest | undefined;
  /** The joint as it would be once the candidate is installed: same bases, same frame, new built meshes, the spec it was built from. */
  readonly successor: ConnectorJoint;
}

/**
 * Builds a joint's connectors again from its retained pieces.
 *
 * `placement` is the CURRENT classification of the parts' shared placement. An attached joint guarantees it equals the one the
 * joint was built under, and the resolved frame is compared with the joint's to prove it rather than assume it. `spec` of
 * `undefined` makes the joint plain: the pieces are the retained bases themselves and no Boolean runs.
 *
 * Throws what a first split throws, in the same order: the unit and placement, the physical range, then the plan, containment,
 * receiving material, support, the Booleans and the closed-solid check. Nothing is built before the last check has passed.
 */
export async function rebuildJointConnectors(
  backend: BooleanBackend,
  joint: ConnectorJoint,
  spec: JointConnectorSpec | undefined,
  placement: PlacementClass,
  cancellation: CancellationToken,
): Promise<JointRebuild> {
  throwIfCancelled(cancellation);
  const cut = pinCutOfJoint(joint);

  if (spec === undefined)
    return Object.freeze({
      pieceA: cut.pieceA,
      pieceB: cut.pieceB,
      connector: undefined,
      manifest: undefined,
      successor: successorOf(joint, cut.pieceA, cut.pieceB, undefined),
    });

  const [first] = spec.elements;
  const count = spec.elements.length;
  if (first === undefined || count > MAX_PINS_PER_JOINT)
    throw planRefusal('The connector plan has a number of pins Pybrix cannot build.', {
      pins: count,
    });
  const ids = new Set<string>();
  for (const pin of spec.elements) {
    if (pin.pinId.length === 0 || ids.has(pin.pinId))
      throw planRefusal('The connector plan repeats or omits a pin identifier.');
    ids.add(pin.pinId);
    // One size per joint is the policy of this version; the model carries sizes per pin so that relaxing it is a policy change.
    if (
      !Object.is(pin.diameterMm, first.diameterMm) ||
      !Object.is(pin.depthMm, first.depthMm) ||
      !Object.is(pin.clearanceMm, first.clearanceMm)
    )
      throw planRefusal('The pins of one joint share one size.');
    // A site names a point and the interface says where that point is. They are derived from one another by one function, so an
    // honest pair agrees exactly; a pair that does not would have containment judged at a point the pin is not cut at.
    const read = interfaceCoordinates(cut.interface, pin.site.local);
    if (!Object.is(read.u, pin.site.u) || !Object.is(read.v, pin.site.v))
      throw planRefusal('A pin site disagrees with where its point is on the cut.', {
        pinId: pin.pinId,
      });
  }

  const request: PhysicalPinRequest = {
    kind: 'physical-pin',
    unit: joint.frame.unit,
    count: count as PhysicalPinRequest['count'],
    diameterMm: first.diameterMm,
    depthMm: first.depthMm,
    clearanceMm: first.clearanceMm,
    maleSide: spec.maleSide,
  };
  const { connector, frame } = resolvePhysicalPin(request, placement);
  if (
    !Object.is(frame.mmPerUnit, joint.frame.mmPerUnit) ||
    !Object.is(frame.placementScale, joint.frame.placementScale) ||
    !Object.is(frame.mmPerCoordinate, joint.frame.mmPerCoordinate)
  )
    throw planRefusal('The placement or unit changed since this joint was built.');
  assertRepresentablePin(connector, frame);

  const sites: readonly SplitVector[] = spec.elements.map((pin) => pin.site.local);
  // The resolver never hands the pin stage two sites closer than this, so a site set that is handed to it instead must meet the same
  // rule or an edit would be a way to build what a split refuses. The same function, the same message and the same code.
  const spacing = minimumPinSpacing(
    connector.diameter / 2 + connector.clearance,
    connectorSupportMargin(connector.diameter / 2, cut.tolerance),
  );
  for (const [index, site] of sites.entries())
    for (const other of sites.slice(index + 1))
      if (pinsTooClose(site, other, spacing))
        throw invalidState(
          'The requested connectors would overlap or sit too close to the cut edge.',
          {
            code: 'CONNECTOR_DOES_NOT_FIT',
          },
        );
  const plan = issuePlan(
    planManualPins(
      draftFromRequest(connector, cut.interface, frame),
      cut.interface,
      connector,
      sites,
    ),
    cut.interface,
  );
  const built = await constructPinConnectors({
    backend,
    cut,
    plan,
    connector,
    sites,
    cancellation,
    automaticDiagnostics: undefined,
  });
  requireSolid(built.pieceA, 'final piece A', cancellation);
  requireSolid(built.pieceB, 'final piece B', cancellation);
  return Object.freeze({
    pieceA: built.pieceA,
    pieceB: built.pieceB,
    connector,
    manifest: connectorManifestOf(plan),
    successor: successorOf(joint, built.pieceA, built.pieceB, spec),
  });
}

function successorOf(
  joint: ConnectorJoint,
  pieceA: CanonicalMesh,
  pieceB: CanonicalMesh,
  connector: JointConnectorSpec | undefined,
): ConnectorJoint {
  return Object.freeze({
    ...joint,
    a: Object.freeze({ ...joint.a, builtMesh: pieceA }),
    b: Object.freeze({ ...joint.b, builtMesh: pieceB }),
    connector,
  });
}
