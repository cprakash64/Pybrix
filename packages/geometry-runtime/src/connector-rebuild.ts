import {
  applyPartTransform,
  classifyPlacement,
  jointId as brandJointId,
  type CanonicalMesh,
  type ConnectorJoint,
  type JointConnectorSpec,
  type JointFrame,
  type JointInterfaceAuthority,
  type JointPin,
  type JointSite,
  type PartId,
  type PartTransform,
  type PlacementClass,
  MAX_PINS_PER_JOINT,
} from '@cadfixer/mesh-core';
import {
  invalidState,
  isLengthUnit,
  throwIfCancelled,
  type CancellationToken,
} from '@cadfixer/shared';
import type { BooleanBackend } from './boolean-adapter';
import { connectorSupportMargin } from './connector-policy';
import type { ClosedPlaneClip } from './closed-plane-kernel';
import { resolveMillimetresPerCoordinate } from './connector-dimensions';
import type { JointCutAxes, JointOutline } from './protocol';
import {
  ConnectorRefusal,
  connectorManifestOf,
  deriveInterfaceRegion,
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
  type SplitResult,
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

/**
 * Where the cut's own axes point in the scene: `u` (across), `v` (along) and the normal, as unit vectors. The interface frame is in the
 * first piece's own coordinates; the LINEAR part of that piece's placement (translation dropped) carries each direction into the scene,
 * as it does a pin's axis. The scene's axes are the model's own: nothing but the placement turns a model. `undefined` for a joint this
 * module did not make or a placement that collapses a direction, which no joint is made on.
 */
export function describeCutAxes(joint: ConnectorJoint): JointCutAxes | undefined {
  const { detail } = joint.authority;
  if (!MINTED.has(detail)) return undefined;
  const { cut } = detail as JointCutDetail;
  const t = joint.a.builtTransform;
  const linear: PartTransform = [t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], 0, 0, 0];
  const inScene = (
    local: readonly [number, number, number],
  ):
    | { readonly direction: readonly [number, number, number]; readonly length: number }
    | undefined => {
    const [x, y, z] = applyPartTransform(linear, local[0], local[1], local[2]);
    const length = Math.hypot(x, y, z);
    return length === 0 || !Number.isFinite(length)
      ? undefined
      : { direction: [x / length, y / length, z / length], length };
  };
  const u = inScene(cut.interface.frame.U);
  const v = inScene(cut.interface.frame.V);
  const normal = inScene(cut.interface.frame.N);
  if (u === undefined || v === undefined || normal === undefined) return undefined;
  const [ox, oy, oz] = cut.interface.outputPlaneOrigin;
  return Object.freeze({
    u: u.direction,
    v: v.direction,
    normal: normal.direction,
    origin: applyPartTransform(t, ox, oy, oz),
    // a similarity scales every direction alike: one scene length per unit of the cut's own axes
    scenePerCoordinate: u.length,
  });
}

/**
 * The outline of a joint's cut in the cut's own axes, for a view the page draws, or `undefined` when the joint was not made by this
 * module or has too many points to describe. The most points a description holds is a bound on what the page is sent, not a tolerance:
 * a cut with more is described as having no outline, and the editor then offers no face to place a pin on.
 */
export const MAX_OUTLINE_POINTS = 4096;
export function describeCutOutline(
  joint: ConnectorJoint,
  /** The most points to describe. A parameter so a test can reach the limit on a cut of ordinary size; the page is sent the default. */
  maxPoints: number = MAX_OUTLINE_POINTS,
): JointOutline | undefined {
  const { detail } = joint.authority;
  if (!MINTED.has(detail)) return undefined;
  const { cut } = detail as JointCutDetail;
  const region = deriveInterfaceRegion(cut.interface);
  if (region.loops.length === 0) return undefined;
  let points = 0;
  for (const loop of region.loops) points += loop.end - loop.start;
  if (points > maxPoints) return undefined;
  const { uv } = cut.interface.sharedRegion;
  return Object.freeze({
    bounds: region.bounds,
    loops: Object.freeze(
      region.loops.map((loop) =>
        Object.freeze({
          role: loop.role,
          points: Object.freeze(Array.from(uv.subarray(2 * loop.start, 2 * loop.end))),
        }),
      ),
    ),
  });
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
  /** The joint's next pin ordinal once this edit lands. It only ever grows: a pin id is never reused. */
  nextPinOrdinal: number = joint.nextPinOrdinal,
): Promise<JointRebuild> {
  throwIfCancelled(cancellation);
  const cut = pinCutOfJoint(joint);
  if (!Number.isSafeInteger(nextPinOrdinal) || nextPinOrdinal < joint.nextPinOrdinal)
    throw planRefusal('A joint never gives a pin the name a pin once had.');

  if (spec === undefined)
    return Object.freeze({
      pieceA: cut.pieceA,
      pieceB: cut.pieceB,
      connector: undefined,
      manifest: undefined,
      successor: successorOf(joint, cut.pieceA, cut.pieceB, undefined, nextPinOrdinal),
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
    successor: successorOf(joint, built.pieceA, built.pieceB, spec, nextPinOrdinal),
  });
}

function successorOf(
  joint: ConnectorJoint,
  pieceA: CanonicalMesh,
  pieceB: CanonicalMesh,
  connector: JointConnectorSpec | undefined,
  nextPinOrdinal: number,
): ConnectorJoint {
  return Object.freeze({
    ...joint,
    a: Object.freeze({ ...joint.a, builtMesh: pieceA }),
    b: Object.freeze({ ...joint.b, builtMesh: pieceB }),
    connector,
    nextPinOrdinal,
  });
}

// ------------------------------------------------------------- recording a joint

/** Why a split left no editable joint behind. The split itself is never refused for it. */
export type JointNotRecorded =
  | 'NOT_A_CLOSED_PLANE_CUT'
  | 'UNIT_UNKNOWN'
  | 'UNSUPPORTED_TRANSFORM'
  | 'LEGACY_CONNECTOR'
  | 'FRAME_DISAGREES';

export type JointRecording =
  | { readonly recorded: true; readonly joint: ConnectorJoint }
  | { readonly recorded: false; readonly reason: JointNotRecorded };

/**
 * The editable joint a split leaves behind, assembled from the split's own result. Nothing is measured and no geometry is touched: the
 * pieces the pin stage started from (the clip's) become the bases, the pieces the split returned become the built meshes, and the
 * pins become the sites the plan recorded.
 *
 * The frame is resolved HERE, through the one resolver, from the document's unit and the source part's placement, for a plain cut as
 * much as for one with connectors: a plain joint has to know how a millimetre becomes a coordinate if connectors are added to it later.
 * When the split carries a plan, the frame it was resolved in must be the same one; if the two disagreed there would be two answers to
 * "how big is a coordinate", and nothing is recorded.
 *
 * A manual pin's sizes are the millimetres that were asked for. An automatic pin's are its coordinates read back as millimetres, which
 * reproduce those coordinates to the bit (the rebuild test holds it) but need not be the round figure the planner proposed.
 */
export function recordJointFromSplit(input: {
  readonly jointId: string;
  readonly unit: string | undefined;
  readonly sourceTransform: PartTransform;
  readonly result: SplitResult;
  readonly a: { readonly partId: PartId; readonly transform: PartTransform };
  readonly b: { readonly partId: PartId; readonly transform: PartTransform };
}): JointRecording {
  const { result } = input;
  const clip = result.closedPlaneClip;
  if (clip === undefined) return { recorded: false, reason: 'NOT_A_CLOSED_PLANE_CUT' };
  if (result.connector.kind === 'dovetail') return { recorded: false, reason: 'LEGACY_CONNECTOR' };
  // The unit the connectors were sized in: the document's when it states one, else the one the user asserted for this split, which
  // the plan records. A plain cut on a unit-less model has neither, and records nothing.
  const unit = input.unit ?? result.connectorPlan?.unitContext.unit;
  const resolved = resolveMillimetresPerCoordinate({
    unit,
    placement: classifyPlacement(input.sourceTransform),
  });
  if (!resolved.ok)
    return {
      recorded: false,
      reason: resolved.refusal === 'UNKNOWN_UNITS' ? 'UNIT_UNKNOWN' : 'UNSUPPORTED_TRANSFORM',
    };
  if (unit === undefined || !isLengthUnit(unit)) return { recorded: false, reason: 'UNIT_UNKNOWN' };
  const frame: JointFrame = Object.freeze({
    unit,
    mmPerUnit: resolved.mmPerUnit,
    placementScale: resolved.placementScale,
    mmPerCoordinate: resolved.mmPerCoordinate,
  });
  const cut = pinCutOf(clip);

  let connector: JointConnectorSpec | undefined;
  let pinCount = 0;
  const manifest = result.connectorPlan;
  if (result.connector.kind === 'pin') {
    const pin = result.connector;
    if (manifest === undefined) return { recorded: false, reason: 'FRAME_DISAGREES' };
    const context = manifest.unitContext;
    if (
      !Object.is(context.mmPerUnit, frame.mmPerUnit) ||
      !Object.is(context.partScale, frame.placementScale) ||
      !Object.is(context.mmPerCoordinate, frame.mmPerCoordinate)
    )
      return { recorded: false, reason: 'FRAME_DISAGREES' };
    const intent = context.intentMm;
    const pins: JointPin[] = manifest.pairs.map((pair) =>
      Object.freeze({
        pinId: pair.pairId,
        site: Object.freeze({ u: pair.site.u, v: pair.site.v, local: pair.site.local }),
        diameterMm: intent?.diameter ?? pin.diameter * frame.mmPerCoordinate,
        depthMm: intent?.depth ?? pin.depth * frame.mmPerCoordinate,
        clearanceMm: intent?.clearance ?? pin.clearance * frame.mmPerCoordinate,
      }),
    );
    pinCount = pins.length;
    connector = Object.freeze({
      policy: 'units-v2',
      kind: 'pin',
      maleSide: pin.maleSide,
      elements: Object.freeze(pins),
    });
  }
  return {
    recorded: true,
    joint: Object.freeze({
      kind: 'joint',
      jointId: brandJointId(input.jointId),
      a: Object.freeze({
        partId: input.a.partId,
        baseMesh: cut.pieceA,
        builtMesh: result.pieceA,
        builtTransform: input.a.transform,
      }),
      b: Object.freeze({
        partId: input.b.partId,
        baseMesh: cut.pieceB,
        builtMesh: result.pieceB,
        builtTransform: input.b.transform,
      }),
      frame,
      authority: jointAuthorityOf(cut),
      connector,
      cutNormal: Object.freeze([...clip.interface.frame.N] as [number, number, number]),
      nextPinOrdinal: pinCount + 1,
    }),
  };
}

// ----------------------------------------------------------------------- digest

/**
 * The identity of what a joint's connectors ARE: the spec and the frame it is sized in, serialised in a fixed order and hashed with
 * the repository's own SHA-256. DERIVED ON DEMAND, never stored, so it cannot disagree with the spec it names. A caller states the
 * digest it saw when it asks for an edit, and the store compares it with its own reading at commit.
 */
export function jointSpecDigest(joint: Pick<ConnectorJoint, 'connector' | 'frame'>): string {
  const text = JSON.stringify(
    { frame: joint.frame, connector: joint.connector ?? null },
    (_key, value: unknown) =>
      typeof value === 'number' && !Number.isFinite(value)
        ? `n:${String(value)}`
        : Object.is(value, -0)
          ? 'n:-0'
          : value,
  );
  const units = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i += 1) units[i] = text.charCodeAt(i);
  return splitBufferSHA([units]);
}
