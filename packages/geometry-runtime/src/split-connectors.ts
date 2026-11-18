import { automaticPinPlan, type AutomaticConnectorDiagnostics } from './automatic-connectors';
import { isLengthUnit } from '@cadfixer/shared';
import { describeTransformRefusal } from './connector-transform-refusal';
import {
  assertMeshStructure,
  IDENTITY_PART_TRANSFORM,
  type PartTransform,
  computeBounds,
  createIndexArray,
  createPositionArray,
  triangleCount,
  type CanonicalMesh,
  IDENTITY_PLACEMENT,
  type PlacementClass,
  type PlacementRefusal,
} from '@cadfixer/mesh-core';
import { invalidState, throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import { analyseTopology } from '@cadfixer/mesh-topology';
import {
  choosePlaneSplitStrategy,
  splitOpenSurface,
  type PlaneSplitCapability,
} from './open-plane-split';
import {
  clipPlane,
  type ClipBinding,
  type ClosedPlaneClip,
  type GeneratedSeparationInterface,
} from './closed-plane-kernel';
import { splitMeshSHA } from './split-source-identity';
import { runValidatedBoolean, type BooleanBackend } from './boolean-adapter';
import {
  createReceivingBroadphase,
  describeAxialFailure,
  validateSocketDepth,
  type ReceivingPiece,
} from './connector-axial';
import { describeSupportFailure, validateConnectorSupport } from './connector-support';
import { containFootprints, describeFootprintFailure } from './connector-footprint';
import { connectorSupportMargin } from './connector-policy';
import {
  localToMillimetres,
  resolveConnectorDimensions,
  resolveMillimetresPerCoordinate,
  resolveModelUnit,
  type ConnectorDimensionName,
  CONNECTOR_DIMENSION_POLICY_MM,
  type ResolvedConnectorDimensions,
} from './connector-dimensions';
import { describeDimensionRefusal } from './connector-dimension-refusal';
import { describeUnknownUnitRefusal } from './connector-unit-refusal';
import {
  ConnectorRefusal,
  REFUSAL_TO_LEGACY_DETAILS_CODE,
  connectorManifestOf,
  draftFromRequest,
  planAutomaticPins,
  planManualPins,
  toLegacyAutomaticPlan,
  toLegacyConnectorPlan,
  validateConnectorPlan,
  type ConnectorManifest,
  type ConnectorPlan,
  type PhysicalFrame,
  type ValidatedConnectorPlan,
} from './connector-plan';

export type SplitVector = readonly [number, number, number];
export interface SplitPlane {
  readonly origin: SplitVector;
  readonly normal: SplitVector;
}
export type SplitConnector =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'pin';
      readonly count: 1 | 2 | 3 | 4;
      readonly diameter: number;
      readonly depth: number;
      readonly clearance: number;
      readonly maleSide: 'A' | 'B';
    }
  | {
      readonly kind: 'dovetail';
      readonly width: number;
      readonly depth: number;
      readonly length: number;
      readonly clearance: number;
      readonly maleSide: 'A' | 'B';
      readonly orientationDegrees: 0 | 90;
    };
/**
 * A round-pin request stated PHYSICALLY: every size is millimetres, and `unit` is how the part's coordinates are read.
 * The engine turns it into a coordinate pin once, at its entry, through `resolveConnectorDimensions`; nothing downstream of that
 * sees millimetres, and nothing upstream converts them.
 */
export interface PhysicalPinRequest {
  readonly kind: 'physical-pin';
  /** How the part's coordinates are read. `undefined` is "not known", which the engine refuses; it is never defaulted. */
  readonly unit: string | undefined;
  readonly count: 1 | 2 | 3 | 4;
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly clearanceMm: number;
  readonly maleSide: 'A' | 'B';
}
/** What the engine works from once a physical request has been resolved: sizes in the part's own coordinates. */
export interface EngineSplitRequest {
  readonly plane: SplitPlane;
  readonly connector: SplitConnector | { readonly kind: 'automatic'; readonly unit: string };
}
export interface SplitRequest {
  readonly plane: SplitPlane;
  readonly connector:
    SplitConnector | { readonly kind: 'automatic'; readonly unit: string } | PhysicalPinRequest;
}
/**
 * WHAT MAY CROSS THE WORKER BOUNDARY FROM THE PAGE (Stage C03-C2): no connector, an automatic connector, or a PHYSICAL pin. A connector
 * the page names always names millimetres (and the unit its coordinates are read in); a pin in raw COORDINATES is the engine's own
 * pinned legacy request, for tests and oracles, and is not a thing the page can ask for. Keeping it off the boundary means no flow can
 * route around the unit policy by sending numbers it has already converted (or has not).
 */
export type ProductConnectorRequest =
  | { readonly kind: 'none' }
  | { readonly kind: 'automatic'; readonly unit: string }
  | PhysicalPinRequest;
export interface ProductSplitRequest {
  readonly plane: SplitPlane;
  readonly connector: ProductConnectorRequest;
}
/** The connector kinds the worker accepts from the page. A message is untrusted, so the kind is checked at run time as well. */
export const PRODUCT_CONNECTOR_KINDS: readonly string[] = Object.freeze([
  'none',
  'automatic',
  'physical-pin',
]);
/** Refuses, before anything is touched, a connector request that is not stated physically. */
export function assertProductConnectorRequest(connector: { readonly kind: string }): void {
  if (!PRODUCT_CONNECTOR_KINDS.includes(connector.kind))
    throw invalidState('Connector sizes must be requested in millimetres.', {
      code:
        REFUSAL_TO_LEGACY_DETAILS_CODE[ConnectorRefusal.REQUEST_NOT_PHYSICAL] ??
        'REQUEST_NOT_PHYSICAL',
      refusal: ConnectorRefusal.REQUEST_NOT_PHYSICAL,
    });
}
/**
 * The unit a physical connector is sized in. A unit the FILE states wins over the one the request names — "a stated unit always
 * wins" is the product's rule for the page, and the worker is the authority, so a page that holds a stale mirror of the document
 * cannot size a connector in the wrong unit. A document that states none takes the one the user assigned, which the request carries.
 */
export function withStatedUnit(
  connector: ProductConnectorRequest,
  statedUnit: string | undefined,
): ProductConnectorRequest {
  if (statedUnit === undefined || connector.kind === 'none') return connector;
  return connector.unit === statedUnit ? connector : { ...connector, unit: statedUnit };
}
type PinConnector = Extract<SplitConnector, { readonly kind: 'pin' }>;

/**
 * The refusal for a model whose unit is not one the product knows: a physical connector has no physical length without one.
 * One legacy code (`UNKNOWN_UNITS`, which the page and the tests know), the typed refusal beside it, one sentence, and nothing was
 * built. Never defaulted to millimetres and never read as the model's own units.
 */
function unknownUnitError(): ReturnType<typeof invalidState> {
  return invalidState(describeUnknownUnitRefusal(), {
    code: REFUSAL_TO_LEGACY_DETAILS_CODE[ConnectorRefusal.UNIT_UNKNOWN] ?? 'UNKNOWN_UNITS',
    refusal: ConnectorRefusal.UNIT_UNKNOWN,
  });
}

/** The refusal for a placement that is not a similarity: one code, the classifier's reason beside it, one sentence. */
function unsupportedTransformError(reason: PlacementRefusal): ReturnType<typeof invalidState> {
  return invalidState(describeTransformRefusal(reason), {
    code:
      REFUSAL_TO_LEGACY_DETAILS_CODE[ConnectorRefusal.UNSUPPORTED_TRANSFORM] ??
      'UNSUPPORTED_TRANSFORM',
    refusal: ConnectorRefusal.UNSUPPORTED_TRANSFORM,
    transformReason: reason,
  });
}

/** The refusal for a connector dimension outside the physical range: the metric, the value and the limit, in millimetres. */
function dimensionPolicyError(
  refusal: Extract<ResolvedConnectorDimensions, { readonly refusal: 'DIMENSION_OUT_OF_POLICY' }>,
): ReturnType<typeof invalidState> {
  return invalidState(describeDimensionRefusal(refusal), {
    code:
      REFUSAL_TO_LEGACY_DETAILS_CODE[ConnectorRefusal.DIMENSION_OUT_OF_POLICY] ??
      'DIMENSION_OUT_OF_POLICY',
    refusal: ConnectorRefusal.DIMENSION_OUT_OF_POLICY,
    dimension: refusal.dimension,
    reason: refusal.reason,
    valueMm: refusal.valueMm,
    minMm: refusal.minMm,
    maxMm: refusal.maxMm,
  });
}

/**
 * Resolves a physical pin into the coordinate pin the construction code builds, through the one resolver, with the model's unit
 * AND the placement's scale; and the frame it was resolved in, which the plan records. Nothing downstream of this sees
 * millimetres. The unit and the placement were refused before this is reached, so only the physical range can fail here.
 */
function resolvePhysicalPin(
  request: PhysicalPinRequest,
  placement: PlacementClass,
): { readonly connector: PinConnector; readonly frame: PhysicalFrame } {
  const resolved = resolveConnectorDimensions(
    {
      diameterMm: request.diameterMm,
      depthMm: request.depthMm,
      clearanceMm: request.clearanceMm,
    },
    { unit: request.unit, placement },
  );
  if (!resolved.ok) {
    switch (resolved.refusal) {
      case 'DIMENSION_OUT_OF_POLICY':
        throw dimensionPolicyError(resolved);
      case 'UNSUPPORTED_TRANSFORM':
        throw unsupportedTransformError(resolved.transformReason);
      case 'UNKNOWN_UNITS':
        throw unknownUnitError();
    }
  }
  return {
    connector: {
      kind: 'pin',
      count: request.count,
      diameter: resolved.diameter,
      depth: resolved.depth,
      clearance: resolved.clearance,
      maleSide: request.maleSide,
    },
    frame: {
      unit: defined(request.unit),
      mmPerUnit: resolved.mmPerUnit,
      placementScale: resolved.placementScale,
      mmPerCoordinate: resolved.mmPerCoordinate,
      intentMm: {
        diameter: request.diameterMm,
        depth: request.depthMm,
        clearance: request.clearanceMm,
      },
    },
  };
}

/**
 * A pin whose sizes came from the physical path (a physical request, or the automatic planner's millimetre policy) was judged
 * against the PHYSICAL range already. What is left to hold in local coordinates is only that the numbers are usable.
 */
function assertRepresentablePin(pin: PinConnector, frame: PhysicalFrame | undefined): void {
  const checks: readonly [ConnectorDimensionName, number, boolean][] = [
    ['PIN_DIAMETER', pin.diameter, true],
    ['PIN_DEPTH', pin.depth, true],
    ['PIN_CLEARANCE', pin.clearance, false],
  ];
  for (const [dimension, length, positive] of checks)
    if (!Number.isFinite(length) || (positive ? !(length > 0) : !(length >= 0)))
      throw dimensionPolicyError({
        ok: false,
        refusal: 'DIMENSION_OUT_OF_POLICY',
        dimension,
        reason: 'NOT_REPRESENTABLE',
        valueMm: frame === undefined ? length : localToMillimetres(length, frame.mmPerCoordinate),
        minMm:
          dimension === 'PIN_CLEARANCE'
            ? CONNECTOR_DIMENSION_POLICY_MM.clearanceMinimum
            : CONNECTOR_DIMENSION_POLICY_MM.minimum,
        maxMm: CONNECTOR_DIMENSION_POLICY_MM.maximum,
      });
}
export interface CutSurfaceSummary {
  readonly triangleIds: readonly number[];
  readonly center: SplitVector;
  readonly spanU: number;
  readonly bounds?: { readonly min: SplitVector; readonly max: SplitVector };
  readonly spanV: number;
  /** Distance from the automatic placement point to the actual cap boundary. */
  readonly centerEdgeDistance: number;
  /** Bounded, deterministic interior samples ordered by boundary clearance. */
  readonly interiorCandidates: readonly {
    readonly point: SplitVector;
    readonly edgeDistance: number;
  }[];
  /**
   * WHAT THE CUT ACTUALLY LOOKS LIKE, reported and never decided on.
   *
   * `area` is the summed area of the cap triangles — the real cross-section
   * of the source at this plane. `loopCount` is the number of closed boundary
   * loops of that cap (an annulus has two, two separate discs have two), so it
   * is a count of OUTLINES, not of solid regions. `outline` is every boundary
   * edge as a pair of part-local points, capped at `MAX_SECTION_OUTLINE_EDGES`
   * so a dense cap cannot put an unbounded buffer on the wire; `outlineTruncated`
   * says when it was. None of these feeds placement or acceptance.
   */
  readonly area: number;
  readonly loopCount: number;
  readonly outline: Float32Array;
  readonly outlineTruncated: boolean;
}

/** Generated section geometry in the kernel's canonical frame. */
export interface GeneratedMatingInterfaceSummary extends CutSurfaceSummary {
  readonly authority: 'generated-mating-interface';
}

/** Internal inputs to the predecessor connector selection algorithm. */
export interface ConnectorCompatibilitySurface extends Pick<
  CutSurfaceSummary,
  'center' | 'spanU' | 'spanV' | 'centerEdgeDistance' | 'interiorCandidates' | 'outlineTruncated'
> {
  readonly authority: 'connector-compatibility';
}

/** Upper bound on the cap boundary edges carried back for display. */
export const MAX_SECTION_OUTLINE_EDGES = 65_536;
export interface SplitMetrics {
  /** False for surface cuts: an open surface does not define a solid volume. */
  readonly volumeInterpretable?: boolean;
  readonly sourceVolume: number;
  /**
   * The two pieces straight after the cut, BEFORE any connector — the volumes
   * the conservation check compares with the source.
   */
  readonly pieceAVolume: number;
  readonly pieceBVolume: number;
  /**
   * The finished pieces, AFTER connectors: a pin adds material to its male
   * piece and its socket removes material from the other. Equal to the cut
   * volumes when there is no connector.
   */
  readonly pieceAFinalVolume: number;
  readonly pieceBFinalVolume: number;
  readonly volumeRelativeError: number;
  readonly tolerance: number;
}
export interface PreparedPlaneSplitSource {
  readonly mesh: CanonicalMesh;
  readonly plane: SplitPlane;
  readonly transform: PartTransform;
  readonly binding: ClipBinding;
  readonly capability: PlaneSplitCapability;
  readonly meshSHA?: string;
}

export function preparePlaneSplitSource(
  mesh: CanonicalMesh,
  plane: SplitPlane,
  transform: PartTransform,
  binding: ClipBinding,
  cancellation: CancellationToken,
): PreparedPlaneSplitSource {
  const capability = choosePlaneSplitStrategy(mesh, plane, cancellation);
  return Object.freeze({
    mesh,
    plane: Object.freeze({
      origin: Object.freeze([...plane.origin] as SplitVector),
      normal: Object.freeze([...plane.normal] as SplitVector),
    }),
    transform,
    binding: Object.freeze(binding),
    capability,
    ...(capability.strategy === 'exact-solid' ? { meshSHA: splitMeshSHA(mesh, cancellation) } : {}),
  });
}

export interface SplitResult {
  /** Worker-only proof, omitted from the preview summary. */
  readonly closedPlaneClip?: ClosedPlaneClip;
  readonly outputPlacements?: { readonly a: PartTransform; readonly b: PartTransform };
  readonly interface?: {
    readonly plane: SplitPlane;
    readonly connectorEligible: boolean;
    readonly center?: SplitVector;
    readonly bounds?: { readonly min: SplitVector; readonly max: SplitVector };
    readonly placements: readonly SplitVector[];
  };
  readonly automaticConnector?: 'applied' | 'unavailable';
  readonly automaticConnectorDiagnostics?: Readonly<AutomaticConnectorDiagnostics>;
  readonly surfaceValidation?: {
    readonly sourceFaces: number;
    readonly untouchedFaces: number;
    readonly clippedFaces: number;
    readonly sourceArea: number;
    readonly outputArea: number;
    readonly capTriangles: number;
    readonly cutLoops: number;
    readonly openChains: number;
    readonly intermediateBytes: number;
    readonly phaseMilliseconds: Readonly<Record<string, number>>;
  };
  readonly pieceA: CanonicalMesh;
  readonly pieceB: CanonicalMesh;
  readonly cutA: CutSurfaceSummary;
  readonly cutB: CutSurfaceSummary;
  readonly connector: SplitConnector;
  /**
   * Release 2, Slice 1: a bounded, JSON-safe description of the connector plan the pieces were built from. Present only
   * when connectors were applied. Descriptive, never an input to geometry.
   */
  readonly connectorPlan?: ConnectorManifest;
  readonly metrics: SplitMetrics;
  readonly placements: readonly SplitVector[];
}

export function roundSocketRadius(pinDiameter: number, radialClearance: number): number {
  return pinDiameter / 2 + radialClearance;
}
export function dovetailFemaleDimensions(
  width: number,
  length: number,
  perSideClearance: number,
): { readonly width: number; readonly length: number } {
  return { width: width + perSideClearance * 2, length: length + perSideClearance * 2 };
}

const CYLINDER_SEGMENTS = 32;
function positionsOf(values: readonly number[]): ReturnType<typeof createPositionArray> {
  const out = createPositionArray(values.length);
  out.set(values);
  return out;
}
function indicesOf(values: readonly number[]): ReturnType<typeof createIndexArray> {
  const out = createIndexArray(values.length);
  out.set(values);
  return out;
}
const dot = (a: SplitVector, b: SplitVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: SplitVector, b: SplitVector): SplitVector => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
const scale = (a: SplitVector, s: number): SplitVector => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: SplitVector, b: SplitVector): SplitVector => add(a, scale(b, -1));
const cross = (a: SplitVector, b: SplitVector): SplitVector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(v: SplitVector): SplitVector {
  const length = Math.hypot(...v);
  if (!Number.isFinite(length) || length < 1e-12)
    throw invalidState('Split plane normal must have a finite non-zero length.');
  return scale(v, 1 / length);
}
function frame(plane: SplitPlane): { n: SplitVector; u: SplitVector; v: SplitVector } {
  if (!plane.origin.every(Number.isFinite)) throw invalidState('Split plane origin is not finite.');
  const n = unit(plane.normal),
    axis: SplitVector = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0],
    u = unit(cross(axis, n));
  return { n, u, v: unit(cross(n, u)) };
}
function vertex(mesh: CanonicalMesh, id: number): SplitVector {
  const at = id * 3;
  return [mesh.positions[at] ?? NaN, mesh.positions[at + 1] ?? NaN, mesh.positions[at + 2] ?? NaN];
}
export function meshVolume(mesh: CanonicalMesh): number {
  return Math.abs(meshSignedVolume(mesh));
}
function meshSignedVolume(mesh: CanonicalMesh): number {
  let six = 0;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const a = vertex(mesh, mesh.indices[at] ?? 0),
      b = vertex(mesh, mesh.indices[at + 1] ?? 0),
      c = vertex(mesh, mesh.indices[at + 2] ?? 0);
    six += dot(a, cross(b, c));
  }
  return six / 6;
}
function outward(mesh: CanonicalMesh): CanonicalMesh {
  if (meshSignedVolume(mesh) >= 0) return mesh;
  const indices = createIndexArray(mesh.indices.length);
  for (let at = 0; at < mesh.indices.length; at += 3) {
    indices[at] = mesh.indices[at] ?? 0;
    indices[at + 1] = mesh.indices[at + 2] ?? 0;
    indices[at + 2] = mesh.indices[at + 1] ?? 0;
  }
  return { ...mesh, indices };
}
/**
 * WHY A PART IS NOT A SPLITTABLE SOLID. Typed, so a caller can test the reason
 * and the sentence can change without weakening what a test proves. The reasons
 * are independent: a part may carry several at once.
 */
export const SplitSourceReason = {
  /** At least one edge belongs to only one triangle: the surface has an opening. */
  OpenBoundaries: 'OPEN_BOUNDARIES',
  /** An edge shared by more than two triangles, or a vertex shared by separate fans. */
  NonManifold: 'NON_MANIFOLD',
  /** Neighbouring triangles disagree about which side is outside. */
  WindingConflict: 'WINDING_CONFLICT',
  /** Zero-area triangles, or triangles repeated at the same positions. */
  DegenerateOrDuplicate: 'DEGENERATE_OR_DUPLICATE',
} as const;
export type SplitSourceReason = (typeof SplitSourceReason)[keyof typeof SplitSourceReason];

/** The reasons a part is not a closed manifold solid, in a fixed order; empty when it is one. */
export function splitSourceReasons(report: {
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly nonManifoldVertexCount: number;
  readonly windingConflictEdgeCount: number;
  readonly zeroAreaFaceCount: number;
  readonly repeatedPositionFaceCount: number;
}): readonly SplitSourceReason[] {
  const reasons: SplitSourceReason[] = [];
  if (report.boundaryEdgeCount > 0) reasons.push(SplitSourceReason.OpenBoundaries);
  if (report.nonManifoldEdgeCount > 0 || report.nonManifoldVertexCount > 0)
    reasons.push(SplitSourceReason.NonManifold);
  if (report.windingConflictEdgeCount > 0) reasons.push(SplitSourceReason.WindingConflict);
  if (report.zeroAreaFaceCount > 0 || report.repeatedPositionFaceCount > 0)
    reasons.push(SplitSourceReason.DegenerateOrDuplicate);
  return reasons;
}

/** The `details.code` of the refusal `requireSolid` throws, so the page recognises it by name and not by wording. */
export const SPLIT_SOURCE_NOT_CLOSED_SOLID_CODE = 'SPLIT_SOURCE_NOT_CLOSED_SOLID';

/**
 * The sentence for a set of reasons. TRUTHFUL ABOUT REPAIR: it points at Repair
 * only when every reason is one Repair's conservative operations address
 * (winding, degenerate and duplicate triangles). An opening or a non-manifold
 * edge may or may not be fixable, so those say what Split needs and no more.
 */
export function describeSplitSourceRefusal(reasons: readonly SplitSourceReason[]): string {
  const facts: string[] = [];
  if (reasons.includes(SplitSourceReason.OpenBoundaries))
    facts.push('it still has open boundaries');
  if (reasons.includes(SplitSourceReason.NonManifold))
    facts.push('it has non-manifold edges or vertices');
  if (reasons.includes(SplitSourceReason.WindingConflict))
    facts.push('its triangles do not agree which side is outside');
  if (reasons.includes(SplitSourceReason.DegenerateOrDuplicate))
    facts.push('it has zero-area or repeated triangles');
  const base = `Manual splitting currently requires a closed solid, and this part is not one: ${facts.join('; ')}.`;
  const repairable = reasons.every(
    (reason) =>
      reason === SplitSourceReason.WindingConflict ||
      reason === SplitSourceReason.DegenerateOrDuplicate,
  );
  return repairable ? `${base} Repair can address these.` : base;
}

function requireSolid(mesh: CanonicalMesh, label: string, cancellation: CancellationToken): void {
  assertMeshStructure(mesh, `split/${label}`);
  const r = analyseTopology(mesh, {
    documentId: 'split',
    documentRevision: 0,
    partId: label,
    cancellation,
    sampleLimit: 0,
    componentSummaryLimit: 8,
  }).report;
  const reasons = splitSourceReasons(r);
  if (reasons.length > 0)
    throw invalidState(describeSplitSourceRefusal(reasons), {
      code: SPLIT_SOURCE_NOT_CLOSED_SOLID_CODE,
      // ErrorDetails hold scalars only, so the typed reasons travel comma-joined.
      reasons: reasons.join(','),
      label,
    });
}
const BOX_INDICES = [
  0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7,
  1, 7, 5,
];
function boxFrom(points: readonly SplitVector[]): CanonicalMesh {
  return outward({
    positions: positionsOf(points.flat()),
    indices: indicesOf(BOX_INDICES),
    metadata: {},
  });
}
function orientedBox(
  center: SplitVector,
  u: SplitVector,
  v: SplitVector,
  n: SplitVector,
  hu: number,
  hv: number,
  hn: number,
): CanonicalMesh {
  const p: SplitVector[] = [];
  for (const sn of [-1, 1])
    for (const sv of [-1, 1])
      for (const su of [-1, 1])
        p.push(add(center, add(scale(u, su * hu), add(scale(v, sv * hv), scale(n, sn * hn)))));
  return boxFrom(p);
}
function range(mesh: CanonicalMesh, axis: SplitVector): [number, number] {
  let min = Infinity,
    max = -Infinity;
  for (let at = 0; at < mesh.positions.length; at += 3) {
    const d = dot(
      [mesh.positions[at] ?? NaN, mesh.positions[at + 1] ?? NaN, mesh.positions[at + 2] ?? NaN],
      axis,
    );
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return [min, max];
}
export function splitTolerance(mesh: CanonicalMesh): number {
  const b = computeBounds(mesh);
  if (!b) throw invalidState('The selected part has no geometry.');
  const diagonal = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]),
    magnitude = Math.max(...b.min.map(Math.abs), ...b.max.map(Math.abs), 1);
  return Math.max(diagonal * 1e-6, magnitude * Number.EPSILON * 64);
}
export function buildSplitCutters(
  mesh: CanonicalMesh,
  plane: SplitPlane,
): readonly [CanonicalMesh, CanonicalMesh] {
  const { n, u, v } = frame(plane),
    [umin, umax] = range(mesh, u),
    [vmin, vmax] = range(mesh, v),
    [nmin, nmax] = range(mesh, n),
    planeN = dot(plane.origin, n),
    tol = splitTolerance(mesh);
  if (planeN <= nmin + tol || planeN >= nmax - tol)
    throw invalidState(
      'The split plane does not pass through enough of this part to create two pieces.',
      { code: 'SPLIT_PLANE_DOES_NOT_INTERSECT_PART', plane: planeN, minimum: nmin, maximum: nmax },
    );
  const margin = Math.max(umax - umin, vmax - vmin, nmax - nmin, tol * 16) * 0.1 + tol * 8,
    hu = (umax - umin) / 2 + margin,
    hv = (vmax - vmin) / 2 + margin,
    uv = add(scale(u, (umin + umax) / 2), scale(v, (vmin + vmax) / 2)),
    pd = nmax - planeN + margin,
    nd = planeN - nmin + margin;
  return [
    orientedBox(add(uv, scale(n, planeN + pd / 2)), u, v, n, hu, hv, pd / 2),
    orientedBox(add(uv, scale(n, planeN - nd / 2)), u, v, n, hu, hv, nd / 2),
  ];
}
export function identifyCutSurface(
  mesh: CanonicalMesh,
  plane: SplitPlane,
  tolerance: number,
): CutSurfaceSummary {
  const basis = frame(plane);
  return summarizeSection(mesh, plane, basis, 0, (points) =>
    points.every((point) => Math.abs(dot(sub(point, plane.origin), basis.n)) <= tolerance * 4),
  );
}

export function identifyConnectorCompatibilitySurface(
  mesh: CanonicalMesh,
  plane: SplitPlane,
  tolerance: number,
): ConnectorCompatibilitySurface {
  const { center, spanU, spanV, centerEdgeDistance, interiorCandidates, outlineTruncated } =
    identifyCutSurface(mesh, plane, tolerance);
  return {
    authority: 'connector-compatibility',
    center,
    spanU,
    spanV,
    centerEdgeDistance,
    interiorCandidates,
    outlineTruncated,
  };
}

function identifyGeneratedMatingInterface(
  mesh: CanonicalMesh,
  generated: GeneratedSeparationInterface,
): GeneratedMatingInterfaceSummary {
  const { N: n, U: u, V: v } = generated.frame;
  const plane = { origin: generated.outputPlaneOrigin, normal: n };
  return {
    ...summarizeSection(
      mesh,
      plane,
      { n, u, v },
      triangleCount(mesh) - generated.capFaces,
      () => true,
    ),
    area: generated.area,
    authority: 'generated-mating-interface',
  };
}

function summarizeSection(
  mesh: CanonicalMesh,
  plane: SplitPlane,
  { u, v }: ReturnType<typeof frame>,
  firstFace: number,
  includes: (points: readonly SplitVector[]) => boolean,
): CutSurfaceSummary {
  const ids: number[] = [],
    capMin = [Infinity, Infinity, Infinity],
    capMax = [-Infinity, -Infinity, -Infinity];
  const edgeUse = new Map<
    string,
    {
      count: number;
      a: [number, number];
      b: [number, number];
      ai: number;
      bi: number;
    }
  >();
  let area = 0;
  let count = 0,
    minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  const faces = triangleCount(mesh);
  for (let t = firstFace; t < faces; t++) {
    const ps = [
      vertex(mesh, mesh.indices[t * 3] ?? 0),
      vertex(mesh, mesh.indices[t * 3 + 1] ?? 0),
      vertex(mesh, mesh.indices[t * 3 + 2] ?? 0),
    ];
    if (!includes(ps)) continue;
    ids.push(t);
    const [p0, p1, p2] = ps as [SplitVector, SplitVector, SplitVector];
    area += Math.hypot(...cross(sub(p1, p0), sub(p2, p0))) / 2;
    const triangle = ps.map((p) => [dot(p, u), dot(p, v)] as [number, number]);
    const vertexIds = [
      mesh.indices[t * 3] ?? 0,
      mesh.indices[t * 3 + 1] ?? 0,
      mesh.indices[t * 3 + 2] ?? 0,
    ];
    for (let edge = 0; edge < 3; edge++) {
      const ai = vertexIds[edge] ?? 0,
        bi = vertexIds[(edge + 1) % 3] ?? 0,
        key = ai < bi ? `${String(ai)}:${String(bi)}` : `${String(bi)}:${String(ai)}`,
        prior = edgeUse.get(key);
      if (prior) prior.count++;
      else
        edgeUse.set(key, {
          count: 1,
          a: triangle[edge] ?? [0, 0],
          b: triangle[(edge + 1) % 3] ?? [0, 0],
          ai,
          bi,
        });
    }
    for (const p of ps) {
      for (let axis = 0; axis < 3; axis++) {
        capMin[axis] = Math.min(defined(capMin[axis]), defined(p[axis]));
        capMax[axis] = Math.max(defined(capMax[axis]), defined(p[axis]));
      }
      const pu = dot(p, u),
        pv = dot(p, v);
      count++;
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }
  }
  if (!ids.length || !count)
    throw invalidState('The split succeeded, but its connector surface could not be identified.', {
      code: 'CONNECTOR_SURFACE_UNAVAILABLE',
    });
  const boundary = [...edgeUse.values()].filter((edge) => edge.count === 1);
  if (!boundary.length)
    throw invalidState('The split cap has no usable boundary for connector placement.', {
      code: 'CONNECTOR_SURFACE_UNAVAILABLE',
    });
  const triangles = ids.map((id) => {
    const points = [0, 1, 2].map((corner) => vertex(mesh, mesh.indices[id * 3 + corner] ?? 0));
    return points.map((p) => [dot(p, u), dot(p, v)] as [number, number]);
  });
  const inside = (point: readonly [number, number]): boolean =>
    triangles.some((triangle) => pointInTriangle(point, triangle));
  const edgeDistance = (point: readonly [number, number]): number =>
    Math.min(...boundary.map((edge) => pointSegmentDistance(point, edge.a, edge.b)));
  const candidates: [number, number][] = [];
  for (const triangle of triangles)
    candidates.push([
      ((triangle[0]?.[0] ?? 0) + (triangle[1]?.[0] ?? 0) + (triangle[2]?.[0] ?? 0)) / 3,
      ((triangle[0]?.[1] ?? 0) + (triangle[1]?.[1] ?? 0) + (triangle[2]?.[1] ?? 0)) / 3,
    ]);
  // A bounded deterministic grid finds an interior pole for concave caps and
  // caps with holes; membership is against the actual cap triangles, not a
  // bounding box or polygon centroid.
  for (let y = 0; y <= 24; y++)
    for (let x = 0; x <= 24; x++) {
      const point: [number, number] = [
        minU + ((maxU - minU) * x) / 24,
        minV + ((maxV - minV) * y) / 24,
      ];
      if (inside(point)) candidates.push(point);
    }
  const ranked = candidates
      .map((point) => ({ point, edgeDistance: edgeDistance(point) }))
      .sort(
        (a, b) =>
          b.edgeDistance - a.edgeDistance || a.point[0] - b.point[0] || a.point[1] - b.point[1],
      ),
    pole = ranked[0]?.point;
  if (!pole)
    throw invalidState('The split cap has no usable interior for connector placement.', {
      code: 'CONNECTOR_SURFACE_UNAVAILABLE',
    });
  const toWorld = (point: readonly [number, number]): SplitVector =>
    add(
      plane.origin,
      add(scale(u, point[0] - dot(plane.origin, u)), scale(v, point[1] - dot(plane.origin, v))),
    );
  const center = toWorld(pole);
  const section = describeSection(mesh, boundary);
  return {
    area,
    ...section,
    triangleIds: ids,
    center,
    spanU: maxU - minU,
    bounds: { min: capMin as unknown as SplitVector, max: capMax as unknown as SplitVector },
    spanV: maxV - minV,
    centerEdgeDistance: edgeDistance(pole),
    interiorCandidates: ranked.map((candidate) => ({
      point: toWorld(candidate.point),
      edgeDistance: candidate.edgeDistance,
    })),
  };
}
/** Loop count by union-find over boundary vertex ids, and a bounded outline. */
function describeSection(
  mesh: CanonicalMesh,
  boundary: readonly { readonly ai: number; readonly bi: number }[],
): { loopCount: number; outline: Float32Array; outlineTruncated: boolean } {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root)
      root = parent.get(root) ?? root;
    let at = x;
    while (at !== root) {
      const next = parent.get(at) ?? root;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const edge of boundary) {
    if (!parent.has(edge.ai)) parent.set(edge.ai, edge.ai);
    if (!parent.has(edge.bi)) parent.set(edge.bi, edge.bi);
    const ra = find(edge.ai),
      rb = find(edge.bi);
    if (ra !== rb) parent.set(ra, rb);
  }
  const roots = new Set<number>();
  for (const id of parent.keys()) roots.add(find(id));
  const kept = Math.min(boundary.length, MAX_SECTION_OUTLINE_EDGES);
  const outline = new Float32Array(kept * 6);
  for (let index = 0; index < kept; index++) {
    const edge = boundary[index];
    if (edge === undefined) break;
    outline.set([...vertex(mesh, edge.ai), ...vertex(mesh, edge.bi)], index * 6);
  }
  return { loopCount: roots.size, outline, outlineTruncated: kept < boundary.length };
}

function pointInTriangle(
  p: readonly [number, number],
  triangle: readonly (readonly [number, number])[],
): boolean {
  const [a, b, c] = triangle;
  if (!a || !b || !c) return false;
  const sign = (
      p1: readonly [number, number],
      p2: readonly [number, number],
      p3: readonly [number, number],
    ): number => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]),
    d1 = sign(p, a, b),
    d2 = sign(p, b, c),
    d3 = sign(p, c, a),
    hasNegative = d1 < 0 || d2 < 0 || d3 < 0,
    hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}
function pointSegmentDistance(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function cylinder(
  center: SplitVector,
  axis: SplitVector,
  radius: number,
  depth: number,
): CanonicalMesh {
  const { u, v, n } = frame({ origin: center, normal: axis }),
    positions: number[] = [];
  for (const side of [-1, 1])
    for (let i = 0; i < CYLINDER_SEGMENTS; i++) {
      const a = (i / CYLINDER_SEGMENTS) * Math.PI * 2;
      positions.push(
        ...add(
          add(center, scale(n, (side * depth) / 2)),
          add(scale(u, Math.cos(a) * radius), scale(v, Math.sin(a) * radius)),
        ),
      );
    }
  const indices: number[] = [];
  for (let i = 1; i + 1 < CYLINDER_SEGMENTS; i++)
    indices.push(0, i + 1, i, CYLINDER_SEGMENTS, CYLINDER_SEGMENTS + i, CYLINDER_SEGMENTS + i + 1);
  for (let i = 0; i < CYLINDER_SEGMENTS; i++) {
    const j = (i + 1) % CYLINDER_SEGMENTS;
    indices.push(i, j, CYLINDER_SEGMENTS + j, i, CYLINDER_SEGMENTS + j, CYLINDER_SEGMENTS + i);
  }
  return outward({ positions: positionsOf(positions), indices: indicesOf(indices), metadata: {} });
}
function dovetail(
  center: SplitVector,
  plane: SplitPlane,
  width: number,
  length: number,
  depth: number,
  orientation: 0 | 90,
): CanonicalMesh {
  const f = frame(plane),
    u = orientation === 0 ? f.u : f.v,
    v = orientation === 0 ? f.v : f.u,
    points: SplitVector[] = [];
  for (const sn of [-1, 1]) {
    const w = sn < 0 ? width * 0.65 : width;
    for (const sv of [-1, 1])
      for (const su of [-1, 1])
        points.push(
          add(
            center,
            add(
              scale(u, (su * length) / 2),
              add(scale(v, (sv * w) / 2), scale(f.n, (sn * depth) / 2)),
            ),
          ),
        );
  }
  return boxFrom(points);
}
function dimension(value: number, label: string, zero = false): void {
  if (!Number.isFinite(value) || value < (zero ? 0 : 0.01) || value > 1000)
    throw invalidState(`${label} is outside the supported range.`, { value });
}
export function connectorCenters(
  cut: ConnectorCompatibilitySurface,
  count: number,
  radius: number,
  margin: number,
): SplitVector[] {
  const need = radius + margin;
  if (cut.spanU < need * 2 || cut.spanV < need * 2 || cut.centerEdgeDistance < need)
    throw invalidState(
      'The connector does not fit inside the cut surface with the required edge margin.',
      { code: 'CONNECTOR_TOO_CLOSE_TO_EDGE' },
    );
  const eligible = cut.interiorCandidates.filter((candidate) => candidate.edgeDistance >= need),
    selected: SplitVector[] = [],
    minimumSpacing = radius * 2 + margin;
  while (selected.length < count) {
    const next = eligible
      .filter((candidate) =>
        selected.every((chosen) => Math.hypot(...sub(candidate.point, chosen)) >= minimumSpacing),
      )
      .sort((a, b) => {
        const distanceA = selected.length
            ? Math.min(...selected.map((chosen) => Math.hypot(...sub(a.point, chosen))))
            : a.edgeDistance,
          distanceB = selected.length
            ? Math.min(...selected.map((chosen) => Math.hypot(...sub(b.point, chosen))))
            : b.edgeDistance;
        return distanceB - distanceA;
      })[0];
    if (!next) break;
    selected.push(next.point);
  }
  if (selected.length !== count)
    throw invalidState('The requested connectors would overlap or sit too close to the cut edge.', {
      code: 'CONNECTOR_DOES_NOT_FIT',
    });
  return selected;
}

/**
 * The stages of a split, reported as they BEGIN. These are facts about where the
 * work is, not a percentage: the kernel calls inside a stage are synchronous and
 * poll nothing, so a fraction between stages would be invented.
 */
export const SplitStage = {
  PreparingCut: 'preparing-cut',
  Intersecting: 'intersecting',
  BuildingCutSurfaces: 'building-cut-surfaces',
  AddingConnectors: 'adding-connectors',
} as const;
export type SplitStage = (typeof SplitStage)[keyof typeof SplitStage];

export async function splitWithConnectors(
  backend: BooleanBackend,
  source: CanonicalMesh,
  requested: SplitRequest,
  cancellation: CancellationToken,
  onStage?: (stage: SplitStage) => void,
  placement: PlacementClass = IDENTITY_PLACEMENT,
  prepared?: PreparedPlaneSplitSource,
): Promise<SplitResult> {
  throwIfCancelled(cancellation);
  // A physical pin on a model with no known unit is refused FIRST, as it always was: with no unit there is no physical length, and the
  // refusal must not depend on anything else about the request. The sizes themselves are resolved later, once the placement is known.
  if (requested.connector.kind === 'physical-pin' && !resolveModelUnit(requested.connector.unit).ok)
    throw unknownUnitError();
  const request = requested;
  onStage?.(SplitStage.PreparingCut);
  const preparation =
    prepared ??
    preparePlaneSplitSource(
      source,
      request.plane,
      IDENTITY_PART_TRANSFORM,
      { document: 'split', revision: 0, part: 'source', generation: 0 },
      cancellation,
    );
  if (
    preparation.mesh !== source ||
    !preparation.plane.origin.every((value, index) => value === request.plane.origin[index]) ||
    !preparation.plane.normal.every((value, index) => value === request.plane.normal[index])
  )
    throw invalidState('The prepared split source no longer matches.');
  const { capability } = preparation;
  if (capability.strategy === 'unsupported') throw invalidState('This cut cannot be made safely.');
  if (request.connector.kind === 'automatic' && !isLengthUnit(request.connector.unit))
    throw unknownUnitError();
  if (capability.strategy === 'open-surface') {
    if (request.connector.kind !== 'none' && request.connector.kind !== 'automatic')
      throw invalidState('Choose None for this split.', {
        code: 'OPEN_SPLIT_CONNECTOR_UNSUPPORTED',
      });
    onStage?.(SplitStage.Intersecting);
    const result = splitOpenSurface(source, request.plane, cancellation);
    onStage?.(SplitStage.BuildingCutSurfaces);
    return {
      ...result,
      interface: { plane: request.plane, connectorEligible: false, placements: [] },
      ...(request.connector.kind === 'automatic'
        ? {
            automaticConnector: 'unavailable' as const,
            automaticConnectorDiagnostics: {
              reason: 'UNSUPPORTED_INTERFACE' as const,
              proposedSites: 0,
              placementAttempts: 0,
              rayTriangleVisits: 0,
              milliseconds: 0,
              scratchBytes: 0,
            },
          }
        : {}),
    };
  }
  // RELEASE 2, SLICE 2D. The support of a connector is a distance in the part's own coordinates. It means the same thing in the
  // world only if the part's placement is a similarity (translation, rotation, reflection, one uniform scale); the worker
  // classifies the placement once and hands it here. A pin on a part whose placement is not one is refused before any work is done,
  // and (Stage C03-B) the refusal carries WHY: one code, `CONNECTOR_UNSUPPORTED_TRANSFORM`, with the classifier's reason beside it.
  // This is a refusal, not an interpretation.
  if (
    (request.connector.kind === 'pin' || request.connector.kind === 'physical-pin') &&
    placement.kind === 'UNSUPPORTED'
  )
    throw unsupportedTransformError(placement.reason);
  onStage?.(SplitStage.Intersecting);
  const clip = clipPlane(source, preparation.plane, {
    binding: preparation.binding,
    sourceSHA: defined(preparation.meshSHA),
    sourceReport: { volume: Math.abs(capability.topology.totalSignedVolume) },
    placement: preparation.transform,
    cancellation,
  });
  if (clip.status === 'REFUSED') {
    const message =
      clip.reason === 'EMPTY_PIECE'
        ? 'The split plane does not pass through enough of this part to create two pieces.'
        : 'This cut cannot be made safely. Try a different plane.';
    throw invalidState(message, { code: 'CUT_NOT_SAFE', reason: clip.reason });
  }
  const { tolerance, sourceVolume, volumeError: volumeRelativeError } = clip;
  const [pieceAVolume, pieceBVolume] = clip.volumes;
  const plane = { origin: clip.interface.outputPlaneOrigin, normal: clip.interface.frame.N };
  let { pieceA, pieceB }: { pieceA: CanonicalMesh; pieceB: CanonicalMesh } = clip;
  onStage?.(SplitStage.BuildingCutSurfaces);
  const cutA = identifyGeneratedMatingInterface(pieceA, clip.interface);
  const cutB = identifyGeneratedMatingInterface(pieceB, clip.interface);
  const selection =
    request.connector.kind === 'none'
      ? undefined
      : identifyConnectorCompatibilitySurface(
          pieceA,
          { origin: sub(request.plane.origin, clip.outputAnchor), normal: request.plane.normal },
          splitTolerance(source),
        );
  const automatic = request.connector.kind === 'automatic';
  if (automatic && !isLengthUnit(request.connector.unit)) throw unknownUnitError();
  const automaticDiagnostics: AutomaticConnectorDiagnostics = {
    reason: 'NO_SAFE_SITE',
    proposedSites: 0,
    placementAttempts: 0,
    rayTriangleVisits: 0,
    milliseconds: 0,
    scratchBytes: 0,
  };
  // PLANNING FOUNDATION (Release 2, Slice 1). The draft states what was asked for against the generated interface it
  // is being cut from. The resolvers below are the existing ones, called with the same arguments in the same order;
  // the plan re-expresses their answer and `toLegacy…` hands the construction code exactly what it used before.
  // An automatic request's frame: the same factor the planner will ask for, recorded in the plan. A refused unit or placement has none
  // (the plan then records the part scale as NaN, as it always has). A MANUAL draft is built where the pin's sizes are known.
  const physicalFactor =
    request.connector.kind === 'automatic'
      ? resolveMillimetresPerCoordinate({ unit: request.connector.unit, placement })
      : undefined;
  const automaticFrame: PhysicalFrame | undefined =
    request.connector.kind === 'automatic' && physicalFactor?.ok
      ? {
          unit: request.connector.unit,
          mmPerUnit: physicalFactor.mmPerUnit,
          placementScale: physicalFactor.placementScale,
          mmPerCoordinate: physicalFactor.mmPerCoordinate,
        }
      : undefined;
  const draft =
    request.connector.kind === 'automatic'
      ? draftFromRequest(request.connector, clip.interface, automaticFrame)
      : undefined;
  let validatedPlan: ValidatedConnectorPlan | undefined;
  const proposal =
    request.connector.kind === 'automatic'
      ? automaticPinPlan(
          pieceA,
          pieceB,
          defined(selection),
          plane.normal,
          request.connector.unit,
          placement,
          tolerance,
          cancellation,
          automaticDiagnostics,
        )
      : undefined;
  if (proposal)
    validatedPlan = issuePlan(
      planAutomaticPins(defined(draft), clip.interface, proposal),
      clip.interface,
    );
  const plan = validatedPlan ? toLegacyAutomaticPlan(validatedPlan) : undefined;
  let c: SplitConnector | PhysicalPinRequest =
    request.connector.kind === 'automatic'
      ? (plan?.connector ?? { kind: 'none' })
      : request.connector;
  const placements: SplitVector[] = [],
    plainA = pieceA,
    plainB = pieceB;
  try {
    if (c.kind !== 'none') onStage?.(SplitStage.AddingConnectors);
    // A PHYSICAL pin is resolved here, where the first size check always happened, so a refusal keeps its place in the order: after the
    // cut, before any centre is chosen. The frame is what the plan records about how a millimetre became a local length.
    let frame: PhysicalFrame | undefined = automaticFrame;
    if (c.kind === 'physical-pin') {
      const resolved = resolvePhysicalPin(c, placement);
      c = resolved.connector;
      frame = resolved.frame;
    }
    if (c.kind === 'pin') {
      // Only the engine's pinned COORDINATE request (which no product flow sends) is bounded in coordinates; every connector whose
      // sizes are physical was judged against the physical range, so what is left is that its numbers are usable.
      if (request.connector.kind === 'pin') {
        dimension(c.diameter, 'Pin diameter');
        dimension(c.depth, 'Pin depth');
        dimension(c.clearance, 'Pin clearance', true);
      } else assertRepresentablePin(c, frame);
      const r = c.diameter / 2;
      let sites = plan?.centers;
      if (!sites) {
        const centers = connectorCenters(
          defined(selection),
          c.count,
          r + c.clearance,
          connectorSupportMargin(r, tolerance),
        );
        validatedPlan = issuePlan(
          planManualPins(draftFromRequest(c, clip.interface, frame), clip.interface, c, centers),
          clip.interface,
        );
        sites = toLegacyConnectorPlan(validatedPlan).centers;
      }
      // RELEASE 2, SLICE 2B. The ONE footprint-containment check, for the manual sites just resolved and the automatic sites
      // proposed above alike. It reads the GENERATED interface (not the compatibility surface the resolvers searched) and
      // runs after every earlier refusal and before the first Boolean, so a refused plan has built nothing. It does not
      // search for another site: the sites the existing resolvers chose are validated, or the plan is refused whole.
      const containment = containFootprints(defined(validatedPlan), clip.interface, tolerance);
      if (!containment.ok) {
        const [failure] = containment.failures;
        const refusal = defined(failure).refusal;
        if (automatic)
          automaticDiagnostics.reason =
            refusal === ConnectorRefusal.INTERFACE_REGION_UNAVAILABLE
              ? 'INTERFACE_REGION_UNAVAILABLE'
              : 'FOOTPRINT_NOT_CONTAINED';
        throw invalidState(describeFootprintFailure(refusal), {
          code: REFUSAL_TO_LEGACY_DETAILS_CODE[refusal] ?? refusal,
          refusal,
          pairId: defined(failure).pairId,
          footprintU: defined(failure).footprint.u,
          footprintV: defined(failure).footprint.v,
          footprintRadius: defined(failure).footprint.radius,
          centerInMaterial: defined(failure).centerInMaterial,
          ...(failure?.loopId === undefined ? {} : { loopId: failure.loopId }),
          ...(failure?.overreach === undefined ? {} : { overreach: failure.overreach }),
          invalidPairs: containment.failures.length,
          checkedPairs: containment.checked,
        });
      }
      // RELEASE 2, SLICE 2C. Is there receiving material throughout the socket the Booleans below will cut? The socket's
      // axis, radius and depth are decided HERE, once, and the same three values are handed to the validator and to the
      // primitive: nothing is derived twice. Every socket of the plan is checked against the receiving piece as the kernel
      // produced it (before any socket of this plan is cut), so a plan with one bad socket builds nothing.
      const socketVolume = {
        axis: c.maleSide === 'A' ? scale(unit(plane.normal), -1) : unit(plane.normal),
        radius: roundSocketRadius(c.diameter, c.clearance),
        depth: c.depth,
      };
      const planPairs = defined(validatedPlan).plan.pairs;
      const femaleSide: ReceivingPiece =
          c.maleSide === 'A'
            ? {
                mesh: clip.pieceB,
                provenance: clip.provenanceB,
                closed: isClosedSolid(clip.reports[1]),
              }
            : {
                mesh: clip.pieceA,
                provenance: clip.provenanceA,
                closed: isClosedSolid(clip.reports[0]),
              },
        maleSide: ReceivingPiece =
          c.maleSide === 'A'
            ? {
                mesh: clip.pieceA,
                provenance: clip.provenanceA,
                closed: isClosedSolid(clip.reports[0]),
              }
            : {
                mesh: clip.pieceB,
                provenance: clip.provenanceB,
                closed: isClosedSolid(clip.reports[1]),
              },
        // ONE female tree per plan, built by whichever of the two checks below needs it first.
        femaleBroadphase = createReceivingBroadphase(femaleSide),
        socketSweeps = sites.map((center, index) => ({
          pairId: planPairs[index]?.pairId ?? `pin-${String(index + 1)}`,
          center,
          ...socketVolume,
        }));
      const axial = validateSocketDepth(
        femaleSide,
        socketSweeps,
        tolerance,
        cancellation,
        femaleBroadphase,
      );
      if (!axial.ok) {
        const refusal = axial.refusal;
        if (automatic)
          automaticDiagnostics.reason =
            refusal === ConnectorRefusal.SOCKET_BREAKTHROUGH
              ? 'SOCKET_BREAKTHROUGH'
              : 'AXIAL_VALIDATION_UNAVAILABLE';
        const first = 'failures' in axial ? axial.failures[0] : undefined;
        throw invalidState(describeAxialFailure(refusal), {
          code: REFUSAL_TO_LEGACY_DETAILS_CODE[refusal] ?? refusal,
          refusal,
          socketRadius: socketVolume.radius,
          socketDepth: socketVolume.depth,
          ...('reason' in axial ? { reason: axial.reason } : {}),
          ...(first === undefined ? {} : { pairId: first.pairId, faceIndex: first.faceIndex }),
          ...('failures' in axial
            ? { invalidPairs: axial.failures.length, checkedPairs: axial.checked }
            : {}),
        });
      }
      // RELEASE 2, SLICE 2D. `support-v1`: is there at least as much material around the socket and behind the pin root as Pybrix
      // already requires around a connector at the cut face? The same shared validator for a manual and an automatic plan, run
      // after every earlier check and before the first Boolean, over EVERY socket of the plan: one unsupported socket refuses the
      // whole plan with nothing built. No other site, size or depth is tried.
      const supportMargin = connectorSupportMargin(r, tolerance);
      const support = validateConnectorSupport({
        female: femaleSide,
        femaleBroadphase,
        male: maleSide,
        sockets: socketSweeps,
        pinRadius: r,
        margin: supportMargin,
        tolerance,
        cancellation,
      });
      if (!support.ok) {
        const refusal = support.refusal;
        if (automatic)
          automaticDiagnostics.reason =
            refusal === ConnectorRefusal.SOCKET_SUPPORT_INSUFFICIENT
              ? 'SOCKET_SUPPORT_INSUFFICIENT'
              : refusal === ConnectorRefusal.PIN_ROOT_SUPPORT_INSUFFICIENT
                ? 'PIN_ROOT_SUPPORT_INSUFFICIENT'
                : 'SUPPORT_VALIDATION_UNAVAILABLE';
        const first = 'failures' in support ? support.failures[0] : undefined;
        throw invalidState(describeSupportFailure(refusal), {
          code: REFUSAL_TO_LEGACY_DETAILS_CODE[refusal] ?? refusal,
          refusal,
          policy: support.policy,
          pinRadius: r,
          socketRadius: socketVolume.radius,
          socketDepth: socketVolume.depth,
          ...('margin' in support ? { margin: support.margin } : {}),
          ...('reason' in support ? { reason: support.reason, role: support.role } : {}),
          ...(first === undefined
            ? {}
            : {
                role: first.role,
                pairId: first.pairId,
                faceIndex: first.faceIndex,
                ...(first.dimension === undefined ? {} : { dimension: first.dimension }),
              }),
          ...('failures' in support
            ? {
                invalidPairs: new Set(support.failures.map((failure) => failure.pairId)).size,
                checkedPairs: support.checked,
                femaleFailures: support.failures.filter((failure) => failure.role === 'FEMALE')
                  .length,
                maleFailures: support.failures.filter((failure) => failure.role === 'MALE').length,
              }
            : {}),
        });
      }
      for (const center of sites) {
        if (automatic) automaticDiagnostics.placementAttempts++;
        throwIfCancelled(cancellation);
        placements.push(center);
        const axis = socketVolume.axis,
          overlap = Math.max(tolerance * 8, c.depth * 1e-4),
          primitiveDepth = c.depth + overlap,
          primitiveCenter = add(center, scale(axis, (c.depth - overlap) / 2)),
          male = cylinder(primitiveCenter, axis, r, primitiveDepth),
          socket = cylinder(primitiveCenter, axis, socketVolume.radius, primitiveDepth);
        if (c.maleSide === 'A') {
          pieceA = (await runValidatedBoolean(backend, 'union', pieceA, male, cancellation)).mesh;
          pieceB = (await runValidatedBoolean(backend, 'difference', pieceB, socket, cancellation))
            .mesh;
        } else {
          pieceB = (await runValidatedBoolean(backend, 'union', pieceB, male, cancellation)).mesh;
          pieceA = (await runValidatedBoolean(backend, 'difference', pieceA, socket, cancellation))
            .mesh;
        }
      }
    } else if (c.kind === 'dovetail') {
      dimension(c.width, 'Dovetail width');
      dimension(c.depth, 'Dovetail depth');
      dimension(c.length, 'Dovetail length');
      dimension(c.clearance, 'Dovetail clearance', true);
      const need = Math.max(c.width, c.length) / 2 + c.clearance;
      const [placement] = connectorCenters(
        defined(selection),
        1,
        need,
        Math.max(tolerance * 8, need * 0.25),
      );
      if (!placement) throw invalidState('No safe dovetail placement was found.');
      placements.push(placement);
      const axis = c.maleSide === 'A' ? scale(unit(plane.normal), -1) : unit(plane.normal),
        overlap = Math.max(tolerance * 8, c.depth * 1e-4),
        primitiveDepth = c.depth + overlap,
        mc = add(defined(selection).center, scale(axis, (c.depth - overlap) / 2)),
        male = dovetail(
          mc,
          { origin: mc, normal: axis },
          c.width,
          c.length,
          primitiveDepth,
          c.orientationDegrees,
        ),
        female = dovetailFemaleDimensions(c.width, c.length, c.clearance),
        socket = dovetail(
          mc,
          { origin: mc, normal: axis },
          female.width,
          female.length,
          primitiveDepth,
          c.orientationDegrees,
        );
      if (c.maleSide === 'A') {
        pieceA = (await runValidatedBoolean(backend, 'union', pieceA, male, cancellation)).mesh;
        pieceB = (await runValidatedBoolean(backend, 'difference', pieceB, socket, cancellation))
          .mesh;
      } else {
        pieceB = (await runValidatedBoolean(backend, 'union', pieceB, male, cancellation)).mesh;
        pieceA = (await runValidatedBoolean(backend, 'difference', pieceA, socket, cancellation))
          .mesh;
      }
    }
    if (c.kind !== 'none') {
      requireSolid(pieceA, 'final piece A', cancellation);
      requireSolid(pieceB, 'final piece B', cancellation);
    }
  } catch (error) {
    throwIfCancelled(cancellation);
    if (!automatic) throw error;
    if (automaticDiagnostics.reason === 'AVAILABLE') automaticDiagnostics.reason = 'NO_SAFE_SITE';
    pieceA = plainA;
    pieceB = plainB;
    c = { kind: 'none' };
    placements.length = 0;
  }
  const pieceAFinalVolume = c.kind === 'none' ? pieceAVolume : meshVolume(pieceA),
    pieceBFinalVolume = c.kind === 'none' ? pieceBVolume : meshVolume(pieceB);
  return {
    pieceA,
    pieceB,
    closedPlaneClip: clip,
    ...(prepared
      ? { outputPlacements: Object.freeze({ a: clip.outputPlacement, b: clip.outputPlacement }) }
      : {}),
    cutA: translateCutSurface(cutA, clip.outputAnchor),
    cutB: translateCutSurface(cutB, clip.outputAnchor),
    connector: c,
    ...(c.kind === 'pin' && validatedPlan
      ? { connectorPlan: connectorManifestOf(validatedPlan) }
      : {}),
    interface: {
      plane: request.plane,
      connectorEligible: true,
      placements: placements.map((point) => add(point, clip.outputAnchor)),
      center: add(cutA.center, clip.outputAnchor),
      bounds: {
        min: add(defined(cutA.bounds).min, clip.outputAnchor),
        max: add(defined(cutA.bounds).max, clip.outputAnchor),
      },
    },
    ...(automatic
      ? {
          automaticConnector: c.kind === 'none' ? ('unavailable' as const) : ('applied' as const),
          automaticConnectorDiagnostics: automaticDiagnostics,
        }
      : {}),
    placements: placements.map((point) => add(point, clip.outputAnchor)),
    metrics: {
      sourceVolume,
      pieceAVolume,
      pieceBVolume,
      pieceAFinalVolume,
      pieceBFinalVolume,
      volumeRelativeError,
      tolerance,
    },
  };
}

function translateCutSurface(cut: CutSurfaceSummary, offset: SplitVector): CutSurfaceSummary {
  if (offset.every((value) => value === 0)) return cut;
  const outline = cut.outline.map((value, index) => value + defined(offset[index % 3]));
  return {
    ...cut,
    center: add(cut.center, offset),
    ...(cut.bounds
      ? { bounds: { min: add(cut.bounds.min, offset), max: add(cut.bounds.max, offset) } }
      : {}),
    interiorCandidates: cut.interiorCandidates.map(({ point, edgeDistance }) => ({
      point: add(point, offset),
      edgeDistance,
    })),
    outline,
  };
}

/** The kernel's own closed-solid verdict for one output piece. */
function isClosedSolid(report: {
  readonly valid: boolean;
  readonly boundaryEdges: number;
  readonly nonManifoldVertices: number;
  readonly windingConflicts: number;
}): boolean {
  return (
    report.valid &&
    report.boundaryEdges === 0 &&
    report.nonManifoldVertices === 0 &&
    report.windingConflicts === 0
  );
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required bounded geometry evidence is missing.');
  return value;
}

/** Identity-only validation of a plan; a refusal keeps the legacy `details.code` the page already knows. */
function issuePlan(
  plan: ConnectorPlan,
  face: GeneratedSeparationInterface,
): ValidatedConnectorPlan {
  const checked = validateConnectorPlan(plan, face);
  if (!checked.ok)
    throw invalidState(checked.message, {
      code: REFUSAL_TO_LEGACY_DETAILS_CODE[checked.refusal] ?? checked.refusal,
      refusal: checked.refusal,
    });
  return checked.validated;
}
