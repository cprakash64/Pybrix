/**
 * CONNECTOR PLANNING FOUNDATION (Release 2, Slice 1).
 *
 * `ConnectorDraft` (what was asked for) → `ConnectorPlan` (what it resolves to) → `ValidatedConnectorPlan` (a plan
 * bound to the generated separation interface it was made for).
 *
 * THIS MODULE DECIDES NOTHING ABOUT GEOMETRY. It re-expresses, as typed data, the decisions the existing connector code
 * already makes — where the sites are (`connectorCenters` / `automaticPinPlan`), how large the pin is, which piece is
 * male — so that later slices have one place to attach validation. It performs no Boolean, no mesh walk, no tolerance
 * test and no physical check, and `toLegacyConnectorPlan` hands the existing construction code exactly the values it
 * used before. A plan is therefore never a second source of truth for geometry: the pieces are still built from the
 * legacy connector and centres, and the plan is derived from them.
 *
 * It imports only TYPES from `split-connectors` (erased at build time, so no runtime cycle), nothing from React, Three.js,
 * `apps/**`, `mesh-hole-fill` or `file-formats`, and no network API.
 */
import { isLengthUnit } from '@cadfixer/shared';
import type { GeneratedSeparationInterface } from './closed-plane-kernel';
import type { SplitConnector, SplitRequest, SplitVector } from './split-connectors';
import { splitBufferSHA } from './split-source-identity';

/** The policy the legacy behaviour corresponds to. Versioned so a later physical policy is distinguishable from it. */
export const LEGACY_CONNECTOR_POLICY = 'legacy-v0' as const;

type PinConnector = Extract<SplitConnector, { readonly kind: 'pin' }>;

// ---------------------------------------------------------------- refusal vocabulary

/**
 * The typed refusal vocabulary of the connector planner. Tests assert CODES, never sentences.
 *
 * Slice 1 PRODUCES only `PRODUCED_IN_SLICE_1`; every other code is declared so later slices extend one set instead of
 * inventing strings, and is never emitted here.
 */
export const ConnectorRefusal = {
  /** The plan was made for a different generated interface than the one it is being applied to. */
  STALE_INTERFACE: 'STALE_INTERFACE',
  /** An automatic connector needs a known length unit. Legacy details code: `UNKNOWN_UNITS`. */
  UNIT_UNKNOWN: 'UNIT_UNKNOWN',
  /** An open surface defines no solid, so connectors are refused. Legacy details code: `OPEN_SPLIT_CONNECTOR_UNSUPPORTED`. */
  OPEN_SURFACE_UNSUPPORTED: 'OPEN_SURFACE_UNSUPPORTED',
  /** No site was proposed. Reported by the automatic path as a diagnostic reason, not thrown. */
  NO_SAFE_SITE: 'NO_SAFE_SITE',
  /** The connector would sit too close to the cut edge. Legacy details code: `CONNECTOR_TOO_CLOSE_TO_EDGE`. */
  EDGE_CLEARANCE: 'EDGE_CLEARANCE',
  /** The requested number of connectors does not fit. Legacy details code: `CONNECTOR_DOES_NOT_FIT`. */
  DOES_NOT_FIT_COUNT: 'DOES_NOT_FIT_COUNT',
  /** A plan that contradicts itself (count, roles, ids). Unreachable from the legacy resolvers. */
  INVALID_PLAN: 'INVALID_PLAN',
  // ---- declared for later slices; NOT produced by Slice 1 ----
  UNSUPPORTED_TRANSFORM: 'UNSUPPORTED_TRANSFORM',
  RESOURCE_LIMIT: 'RESOURCE_LIMIT',
  DIMENSION_OUT_OF_POLICY: 'DIMENSION_OUT_OF_POLICY',
  SITE_OUTSIDE_INTERFACE: 'SITE_OUTSIDE_INTERFACE',
  INSUFFICIENT_WALL_BEHIND: 'INSUFFICIENT_WALL_BEHIND',
  INSUFFICIENT_WALL_AROUND: 'INSUFFICIENT_WALL_AROUND',
  INSUFFICIENT_ROOT_MATERIAL: 'INSUFFICIENT_ROOT_MATERIAL',
  EXTERIOR_BREAKTHROUGH: 'EXTERIOR_BREAKTHROUGH',
  CONNECTOR_COLLISION: 'CONNECTOR_COLLISION',
  INSERTION_PATH_BLOCKED: 'INSERTION_PATH_BLOCKED',
  BOOLEAN_REFUSED: 'BOOLEAN_REFUSED',
  CANCELLED: 'CANCELLED',
} as const;
export type ConnectorRefusal = (typeof ConnectorRefusal)[keyof typeof ConnectorRefusal];

/** Codes Slice 1 can actually emit. A test keeps this honest. */
export const PRODUCED_IN_SLICE_1: readonly ConnectorRefusal[] = Object.freeze([
  ConnectorRefusal.STALE_INTERFACE,
  ConnectorRefusal.UNIT_UNKNOWN,
  ConnectorRefusal.OPEN_SURFACE_UNSUPPORTED,
  ConnectorRefusal.NO_SAFE_SITE,
  ConnectorRefusal.EDGE_CLEARANCE,
  ConnectorRefusal.DOES_NOT_FIT_COUNT,
  ConnectorRefusal.INVALID_PLAN,
]);

/**
 * How the codes the product ALREADY throws (`AppError.details.code`) map to the typed vocabulary. The legacy code stays
 * the one on the wire; this is the typed reading of it.
 */
export const LEGACY_DETAILS_CODE_TO_REFUSAL: Readonly<Record<string, ConnectorRefusal>> =
  Object.freeze({
    UNKNOWN_UNITS: ConnectorRefusal.UNIT_UNKNOWN,
    OPEN_SPLIT_CONNECTOR_UNSUPPORTED: ConnectorRefusal.OPEN_SURFACE_UNSUPPORTED,
    CONNECTOR_TOO_CLOSE_TO_EDGE: ConnectorRefusal.EDGE_CLEARANCE,
    CONNECTOR_DOES_NOT_FIT: ConnectorRefusal.DOES_NOT_FIT_COUNT,
  });

/** The legacy `details.code` for a refusal this module can produce, so a plan failure keeps the code the page knows. */
export const REFUSAL_TO_LEGACY_DETAILS_CODE: Readonly<Partial<Record<ConnectorRefusal, string>>> =
  Object.freeze({
    [ConnectorRefusal.UNIT_UNKNOWN]: 'UNKNOWN_UNITS',
    [ConnectorRefusal.OPEN_SURFACE_UNSUPPORTED]: 'OPEN_SPLIT_CONNECTOR_UNSUPPORTED',
    [ConnectorRefusal.EDGE_CLEARANCE]: 'CONNECTOR_TOO_CLOSE_TO_EDGE',
    [ConnectorRefusal.DOES_NOT_FIT_COUNT]: 'CONNECTOR_DOES_NOT_FIT',
  });

/** The typed refusal for a legacy `details.code`, or `undefined` for a code this vocabulary does not name. */
export function refusalForLegacyCode(code: unknown): ConnectorRefusal | undefined {
  return typeof code === 'string' && Object.hasOwn(LEGACY_DETAILS_CODE_TO_REFUSAL, code)
    ? LEGACY_DETAILS_CODE_TO_REFUSAL[code]
    : undefined;
}

// ---------------------------------------------------------------- interface identity

/**
 * IDENTITY OF ONE GENERATED SEPARATION INTERFACE. Every field is a fact the kernel already stamped on it; two refs are
 * equal exactly when they name the same interface of the same source at the same revision, part and generation, cut by
 * the same plane in the same frame.
 */
export interface SeparationInterfaceRef {
  readonly document: string;
  readonly revision: number;
  readonly part: string;
  readonly generation: number;
  readonly sourceSHA: string;
  readonly frameIdentity: string;
  readonly planeOrigin: SplitVector;
  readonly planeNormal: SplitVector;
}

export function separationInterfaceRefOf(
  face: GeneratedSeparationInterface,
): SeparationInterfaceRef {
  return Object.freeze({
    document: face.document,
    revision: face.revision,
    part: face.part,
    generation: face.generation,
    sourceSHA: face.sourceSHA,
    frameIdentity: face.frame.identity,
    planeOrigin: face.outputPlaneOrigin,
    planeNormal: face.frame.N,
  });
}

const sameVector = (a: SplitVector, b: SplitVector): boolean =>
  Object.is(a[0], b[0]) && Object.is(a[1], b[1]) && Object.is(a[2], b[2]);

export function sameSeparationInterface(
  a: SeparationInterfaceRef,
  b: SeparationInterfaceRef,
): boolean {
  return (
    a.document === b.document &&
    a.revision === b.revision &&
    a.part === b.part &&
    a.generation === b.generation &&
    a.sourceSHA === b.sourceSHA &&
    a.frameIdentity === b.frameIdentity &&
    sameVector(a.planeOrigin, b.planeOrigin) &&
    sameVector(a.planeNormal, b.planeNormal)
  );
}

// ---------------------------------------------------------------- derived interface region

export interface InterfaceLoop {
  readonly id: number;
  /** Half-open range of region vertices, `[start, end)`, into `sharedRegion.uv`. */
  readonly start: number;
  readonly end: number;
  /** Shoelace area in the interface frame; the sign is the loop's winding, not its role. */
  readonly signedArea: number;
  /** Even nesting depth is an outline of material, odd depth is an opening in it. */
  readonly role: 'OUTER' | 'HOLE';
  /** The smallest loop that contains this one, if any. */
  readonly parent?: number;
  /** The outline this loop belongs to: an OUTER loop starts its own, a HOLE joins its parent's. */
  readonly componentId: number;
}
export interface InterfaceRegion {
  readonly ref: SeparationInterfaceRef;
  readonly loops: readonly InterfaceLoop[];
  readonly bounds: {
    readonly minU: number;
    readonly maxU: number;
    readonly minV: number;
    readonly maxV: number;
  };
  readonly area: number;
}

function shoelace(uv: Float64Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    const j = i + 1 < end ? i + 1 : start;
    sum += (uv[2 * i] ?? 0) * (uv[2 * j + 1] ?? 0) - (uv[2 * j] ?? 0) * (uv[2 * i + 1] ?? 0);
  }
  return sum / 2;
}
function insideLoop(uv: Float64Array, start: number, end: number, pu: number, pv: number): boolean {
  let inside = false;
  for (let i = start, j = end - 1; i < end; j = i++) {
    const ui = uv[2 * i] ?? 0,
      vi = uv[2 * i + 1] ?? 0,
      uj = uv[2 * j] ?? 0,
      vj = uv[2 * j + 1] ?? 0;
    if (vi > pv !== vj > pv && pu < ((uj - ui) * (pv - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

/**
 * Derives loop structure from the interface's own arrays. Cost is proportional to the interface boundary (and the
 * number of loops squared for nesting), never to the source triangle count. NOT called by the split itself: nothing
 * in Slice 1 consumes it, and a derivation that could throw has no place on a path that works today.
 */
export function deriveInterfaceRegion(face: GeneratedSeparationInterface): InterfaceRegion {
  const { uv, loops } = face.sharedRegion;
  const count = Math.max(0, loops.length - 1);
  const ranges = Array.from({ length: count }, (_, id) => ({
    id,
    start: loops[id] ?? 0,
    end: loops[id + 1] ?? 0,
  })).map((range) => ({ ...range, signedArea: shoelace(uv, range.start, range.end) }));
  const entries = ranges.map((range) => {
    const probe = { u: uv[2 * range.start] ?? 0, v: uv[2 * range.start + 1] ?? 0 };
    const containers = ranges
      .filter(
        (other) =>
          other.id !== range.id &&
          Math.abs(other.signedArea) > Math.abs(range.signedArea) &&
          insideLoop(uv, other.start, other.end, probe.u, probe.v),
      )
      .sort((a, b) => Math.abs(a.signedArea) - Math.abs(b.signedArea));
    return { range, containers };
  });
  const roleOf = new Map<number, 'OUTER' | 'HOLE'>(),
    componentOf = new Map<number, number>();
  // largest first, so a loop's containers are classified before it is
  for (const { range, containers } of [...entries].sort(
    (a, b) => Math.abs(b.range.signedArea) - Math.abs(a.range.signedArea),
  )) {
    const role = containers.length % 2 === 0 ? 'OUTER' : 'HOLE';
    roleOf.set(range.id, role);
    const parent = containers[0];
    componentOf.set(
      range.id,
      role === 'OUTER'
        ? range.id
        : parent === undefined
          ? range.id
          : (componentOf.get(parent.id) ?? parent.id),
    );
  }
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    minU = Math.min(minU, uv[i] ?? Infinity);
    maxU = Math.max(maxU, uv[i] ?? -Infinity);
    minV = Math.min(minV, uv[i + 1] ?? Infinity);
    maxV = Math.max(maxV, uv[i + 1] ?? -Infinity);
  }
  return Object.freeze({
    ref: separationInterfaceRefOf(face),
    loops: Object.freeze(
      entries.map(({ range, containers }): InterfaceLoop => {
        const parent = containers[0];
        return Object.freeze({
          id: range.id,
          start: range.start,
          end: range.end,
          signedArea: range.signedArea,
          role: roleOf.get(range.id) ?? 'OUTER',
          ...(parent === undefined ? {} : { parent: parent.id }),
          componentId: componentOf.get(range.id) ?? range.id,
        });
      }),
    ),
    bounds: Object.freeze({ minU, maxU, minV, maxV }),
    area: face.area,
  });
}

/** A part-local point as `(u, v)` in the interface's own frame. Derived; the frame is exact, so this is bookkeeping. */
export function interfaceCoordinates(
  face: GeneratedSeparationInterface,
  local: SplitVector,
): { readonly u: number; readonly v: number } {
  const o = face.outputPlaneOrigin,
    { U, V } = face.frame,
    d: SplitVector = [local[0] - o[0], local[1] - o[1], local[2] - o[2]];
  return { u: d[0] * U[0] + d[1] * U[1] + d[2] * U[2], v: d[0] * V[0] + d[1] * V[1] + d[2] * V[2] };
}

// ---------------------------------------------------------------- unit context

/**
 * What the sizes in a draft are measured in. Slice 1 RECORDS this and changes no conversion.
 *
 *  - `REQUEST_UNIT`: an automatic request names a unit, and the automatic planner applies it with the part scale.
 *  - `COORDINATES`: a manual request is already in model coordinates (the page converted millimetres by the document
 *    unit). The part scale is NOT applied to it — audit C03 — which `partScaleApplied: false` states instead of hiding.
 */
export interface UnitContext {
  readonly basis: 'REQUEST_UNIT' | 'COORDINATES';
  readonly unit?: string;
  readonly partScale: number;
  readonly partScaleApplied: boolean;
}

// ---------------------------------------------------------------- draft

interface DraftBase {
  readonly interfaceRef: SeparationInterfaceRef;
  readonly unitContext: UnitContext;
  readonly policy: typeof LEGACY_CONNECTOR_POLICY;
}
export type ConnectorDraft =
  | (DraftBase & { readonly kind: 'none' })
  | (DraftBase & {
      readonly kind: 'pin';
      readonly origin: 'MANUAL';
      readonly count: 1 | 2 | 3 | 4;
      readonly diameter: number;
      readonly depth: number;
      readonly clearance: number;
      readonly maleSide: 'A' | 'B';
    })
  | (DraftBase & { readonly kind: 'automatic-pin'; readonly unit: string })
  /** The engine still names a dovetail; it is carried, never planned, and never offered (see the Release 2 policy). */
  | (DraftBase & { readonly kind: 'legacy-dovetail' });

export function draftFromRequest(
  connector: SplitRequest['connector'],
  face: GeneratedSeparationInterface,
  physicalScale: number,
): ConnectorDraft {
  const interfaceRef = separationInterfaceRefOf(face);
  const base = { interfaceRef, policy: LEGACY_CONNECTOR_POLICY } as const;
  switch (connector.kind) {
    case 'none':
      return Object.freeze({
        ...base,
        kind: 'none',
        unitContext: Object.freeze({ basis: 'COORDINATES', partScale: 1, partScaleApplied: false }),
      });
    case 'pin':
      return Object.freeze({
        ...base,
        kind: 'pin',
        origin: 'MANUAL',
        count: connector.count,
        diameter: connector.diameter,
        depth: connector.depth,
        clearance: connector.clearance,
        maleSide: connector.maleSide,
        unitContext: Object.freeze({ basis: 'COORDINATES', partScale: 1, partScaleApplied: false }),
      });
    case 'automatic':
      return Object.freeze({
        ...base,
        kind: 'automatic-pin',
        unit: connector.unit,
        unitContext: Object.freeze({
          basis: 'REQUEST_UNIT',
          unit: connector.unit,
          partScale: physicalScale,
          partScaleApplied: true,
        }),
      });
    case 'dovetail':
      return Object.freeze({
        ...base,
        kind: 'legacy-dovetail',
        unitContext: Object.freeze({ basis: 'COORDINATES', partScale: 1, partScaleApplied: false }),
      });
  }
}

/** Stable, injective serialisation of a draft's fields, hashed with the repository's own SHA-256. */
export function draftDigest(draft: ConnectorDraft): string {
  const text = JSON.stringify(draft, (_key, value: unknown) =>
    typeof value === 'number' && !Number.isFinite(value)
      ? `n:${String(value)}`
      : Object.is(value, -0)
        ? 'n:-0'
        : value,
  );
  const units = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  return splitBufferSHA([units]);
}

// ---------------------------------------------------------------- plan

export interface ConnectorPair {
  /** Stable within a plan: `pin-1`, `pin-2`, … in the order the legacy resolver returned the sites. */
  readonly pairId: string;
  readonly kind: 'pin';
  readonly maleSide: 'A' | 'B';
  /** The site in the interface frame, and in part-local (rebased) coordinates exactly as the resolver returned it. */
  readonly site: { readonly u: number; readonly v: number; readonly local: SplitVector };
  readonly nominal: { readonly diameter: number; readonly depth: number };
  /** Pin clearance is radial only; the axial clearance is zero by construction (audit N6), stated rather than assumed. */
  readonly clearance: { readonly radial: number; readonly axial: 0 };
  /** The socket's footprint on the interface plane: the legacy socket radius, `diameter / 2 + clearance`. */
  readonly footprint: {
    readonly kind: 'circle';
    readonly u: number;
    readonly v: number;
    readonly radius: number;
  };
}

/** What a draft resolves to. `legacy` is the exact data the existing construction code consumes. */
export interface ConnectorPlan {
  readonly draft: ConnectorDraft;
  readonly pairs: readonly ConnectorPair[];
  readonly legacy: {
    readonly connector: SplitConnector;
    readonly centers: readonly SplitVector[];
    /** Present for automatic plans only: the guard wall the automatic path proves around each site. */
    readonly wall?: number;
  };
}

function pairsFor(
  face: GeneratedSeparationInterface,
  connector: PinConnector,
  centers: readonly SplitVector[],
): readonly ConnectorPair[] {
  return Object.freeze(
    centers.map((local, index) => {
      const { u, v } = interfaceCoordinates(face, local);
      return Object.freeze({
        pairId: `pin-${String(index + 1)}`,
        kind: 'pin' as const,
        maleSide: connector.maleSide,
        site: Object.freeze({ u, v, local }),
        nominal: Object.freeze({ diameter: connector.diameter, depth: connector.depth }),
        clearance: Object.freeze({ radial: connector.clearance, axial: 0 as const }),
        footprint: Object.freeze({
          kind: 'circle' as const,
          u,
          v,
          radius: connector.diameter / 2 + connector.clearance,
        }),
      });
    }),
  );
}

/** A manual pin plan from the sites `connectorCenters` returned. `centers` is kept by reference, not copied. */
export function planManualPins(
  draft: ConnectorDraft,
  face: GeneratedSeparationInterface,
  connector: PinConnector,
  centers: readonly SplitVector[],
): ConnectorPlan {
  return Object.freeze({
    draft,
    pairs: pairsFor(face, connector, centers),
    legacy: Object.freeze({ connector, centers }),
  });
}

/** An automatic pin plan from what `automaticPinPlan` returned. */
export function planAutomaticPins(
  draft: ConnectorDraft,
  face: GeneratedSeparationInterface,
  proposal: {
    readonly connector: PinConnector;
    readonly wall: number;
    readonly centers: readonly SplitVector[];
  },
): ConnectorPlan {
  return Object.freeze({
    draft,
    pairs: pairsFor(face, proposal.connector, proposal.centers),
    legacy: Object.freeze({
      connector: proposal.connector,
      centers: proposal.centers,
      wall: proposal.wall,
    }),
  });
}

// ---------------------------------------------------------------- validated plan

/** Module-private: only `validateConnectorPlan` holds it, so only it can mint a `ValidatedConnectorPlan`. */
const ISSUE: unique symbol = Symbol('ValidatedConnectorPlan.issue');

export class ValidatedConnectorPlan {
  readonly plan: ConnectorPlan;
  readonly interfaceRef: SeparationInterfaceRef;
  readonly policy: typeof LEGACY_CONNECTOR_POLICY;
  readonly draftDigest: string;

  /** Not for callers: it refuses everything but `validateConnectorPlan`'s token. Use that function. */
  static issue(token: typeof ISSUE, plan: ConnectorPlan): ValidatedConnectorPlan {
    return new ValidatedConnectorPlan(token, plan);
  }
  private constructor(token: typeof ISSUE, plan: ConnectorPlan) {
    // Enforced at runtime as well as in the type: `private` is erased, so a cast could otherwise `new` one.
    if (token !== ISSUE)
      throw new Error('A ValidatedConnectorPlan can only be issued by validateConnectorPlan.');
    this.plan = plan;
    this.interfaceRef = plan.draft.interfaceRef;
    this.policy = plan.draft.policy;
    this.draftDigest = draftDigest(plan.draft);
    Object.freeze(this);
  }
}

export type ConnectorPlanValidation =
  | { readonly ok: true; readonly validated: ValidatedConnectorPlan }
  | { readonly ok: false; readonly refusal: ConnectorRefusal; readonly message: string };

/**
 * IDENTITY CHECKS ONLY. It proves the plan belongs to the interface it is applied to, that its unit context is the one
 * the request named, and that it does not contradict itself. It measures nothing about material, depth, clearance or
 * collisions: those are later slices, and nothing here may stand in for them.
 */
export function validateConnectorPlan(
  plan: ConnectorPlan,
  face: GeneratedSeparationInterface,
): ConnectorPlanValidation {
  const refuse = (refusal: ConnectorRefusal, message: string): ConnectorPlanValidation => ({
    ok: false,
    refusal,
    message,
  });
  if (!sameSeparationInterface(plan.draft.interfaceRef, separationInterfaceRefOf(face)))
    return refuse(
      ConnectorRefusal.STALE_INTERFACE,
      'The connector plan was made for a different cut.',
    );
  if (plan.draft.kind === 'automatic-pin' && !isLengthUnit(plan.draft.unit))
    return refuse(
      ConnectorRefusal.UNIT_UNKNOWN,
      'A known unit is required for automatic connectors.',
    );
  const { connector } = plan.legacy;
  if (connector.kind === 'pin') {
    const ids = new Set(plan.pairs.map((pair) => pair.pairId));
    if (
      plan.pairs.length !== connector.count ||
      plan.legacy.centers.length !== connector.count ||
      ids.size !== plan.pairs.length ||
      plan.pairs.some(
        (pair, i) =>
          pair.maleSide !== connector.maleSide || pair.site.local !== plan.legacy.centers[i],
      )
    )
      return refuse(ConnectorRefusal.INVALID_PLAN, 'The connector plan is inconsistent.');
  } else if (plan.pairs.length !== 0)
    return refuse(ConnectorRefusal.INVALID_PLAN, 'The connector plan is inconsistent.');
  return { ok: true, validated: ValidatedConnectorPlan.issue(ISSUE, plan) };
}

/** What the existing construction code takes: the connector, its sites, and (automatic) the guard wall. */
export function toLegacyConnectorPlan(validated: ValidatedConnectorPlan): ConnectorPlan['legacy'] {
  return validated.plan.legacy;
}

/** The automatic path's own shape (`automaticPinPlan`'s return type), recovered from a validated automatic plan. */
export function toLegacyAutomaticPlan(validated: ValidatedConnectorPlan): {
  readonly connector: PinConnector;
  readonly wall: number;
  readonly centers: readonly SplitVector[];
} {
  const { connector, centers, wall } = validated.plan.legacy;
  if (connector.kind !== 'pin' || wall === undefined)
    throw new Error('Only a validated automatic pin plan carries a guard wall.');
  return { connector, wall, centers };
}

// ---------------------------------------------------------------- manifest

/** Bounded, JSON-safe description of a validated plan. Carries no geometry and is never read back to build any. */
export interface ConnectorManifest {
  readonly version: 1;
  readonly policy: typeof LEGACY_CONNECTOR_POLICY;
  readonly draftDigest: string;
  readonly interfaceRef: SeparationInterfaceRef;
  readonly unitContext: UnitContext;
  readonly connectorKind: SplitConnector['kind'];
  readonly pairs: readonly ConnectorPair[];
}

export function connectorManifestOf(validated: ValidatedConnectorPlan): ConnectorManifest {
  return Object.freeze({
    version: 1,
    policy: validated.policy,
    draftDigest: validated.draftDigest,
    interfaceRef: validated.interfaceRef,
    unitContext: validated.plan.draft.unitContext,
    connectorKind: validated.plan.legacy.connector.kind,
    pairs: validated.plan.pairs,
  });
}
