import {
  certifyWholeInterface,
  type WholeInterfaceCertificate,
} from './semantic-whole-interface-certificate';
import {
  collectMaterialInterface,
  interfaceMembershipSignature,
  interfaceCorrespondsToPoint,
  type MaterialInterface,
} from './semantic-interface-membership';
import { FRAME_FILL, type SemanticPart, type Vec3 } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import { pointInSemanticPolygon } from './semantic';
import { VIEW_NAMES } from '@cadfixer/auto-split-contract';
import {
  GROUNDED_BOUNDARY_LIMITS,
  collectGroundedBoundaryWitnesses,
} from './semantic-grounded-boundary';
import type { SuggestedPlane } from './suggestions';
import type { Checkpoint } from './checkpoint';
import type { InterfaceOwnership } from './semantic-boundary-confirmation';

export type InterfaceEvidenceLevel =
  | 'WHOLE_INTERFACE_TARGET_PROVEN'
  | 'WHOLE_INTERFACE_BODY_PROVEN'
  | 'LOCAL_TARGET_ASSOCIATION'
  | 'LOCAL_BODY_ASSOCIATION'
  | 'PROVEN_IRRELEVANT'
  | 'UNKNOWN'
  | 'CONFLICT';

export interface InterfaceObservationSupport {
  readonly view: (typeof VIEW_NAMES)[number];
  readonly visiblePixels: number;
  readonly targetPixels: number;
  readonly bodyPixels: number;
  readonly unknownPixels: number;
}

/** Whole-interface proof requires exhaustive direct evidence and a complete continuous certificate.
 * The existing grounded-boundary pixel floor counts observations, not coverage fractions.
 * An unlabeled observation supplies neither BODY evidence nor a contradiction. */
export function classifyInterfaceOwnershipSupport(
  observations: readonly InterfaceObservationSupport[],
  positiveFrontierProof: boolean,
  wholeCertificate?: Pick<WholeInterfaceCertificate, 'complete' | 'conflict'>,
): {
  readonly evidenceLevel: InterfaceEvidenceLevel;
  readonly ownership: InterfaceOwnership;
  readonly conflict: boolean;
  readonly category:
    | 'DIRECT_EXHAUSTIVE'
    | 'DIRECT_CORROBORATED'
    | 'FRONTIER_CORROBORATED'
    | 'SPARSE_UNCORROBORATED'
    | 'CONFLICTED'
    | 'UNKNOWN';
  readonly targetAxes: readonly number[];
  readonly bodyAxes: readonly number[];
} {
  const pixels = (key: 'targetPixels' | 'bodyPixels' | 'unknownPixels'): number =>
    observations.reduce((sum, row) => sum + row[key], 0);
  const target = pixels('targetPixels'),
    body = pixels('bodyPixels'),
    unknown = pixels('unknownPixels');
  const axes = (key: 'targetPixels' | 'bodyPixels'): number[] =>
    [0, 1, 2].filter((axis) =>
      observations.some(
        (row) =>
          Math.floor(VIEW_NAMES.indexOf(row.view) / 2) === axis &&
          row[key] >= GROUNDED_BOUNDARY_LIMITS.minimumPixels,
      ),
    );
  const targetAxes = axes('targetPixels'),
    bodyAxes = axes('bodyPixels');
  const conflict =
    wholeCertificate?.conflict === true || ((target > 0 || positiveFrontierProof) && body > 0);
  const exhaustive = unknown === 0 && (target > 0 || body > 0);
  const directTarget = target > 0 && (exhaustive || targetAxes.length >= 2);
  const directBody = body > 0 && (exhaustive || bodyAxes.length >= 2);
  const evidenceLevel: InterfaceEvidenceLevel = conflict
    ? 'CONFLICT'
    : wholeCertificate?.complete && exhaustive && target > 0
      ? 'WHOLE_INTERFACE_TARGET_PROVEN'
      : wholeCertificate?.complete && exhaustive && body > 0
        ? 'WHOLE_INTERFACE_BODY_PROVEN'
        : positiveFrontierProof || directTarget
          ? 'LOCAL_TARGET_ASSOCIATION'
          : directBody
            ? 'LOCAL_BODY_ASSOCIATION'
            : 'UNKNOWN';
  const ownership: InterfaceOwnership =
    evidenceLevel === 'WHOLE_INTERFACE_TARGET_PROVEN'
      ? 'TARGET_SIDE'
      : evidenceLevel === 'WHOLE_INTERFACE_BODY_PROVEN'
        ? 'BODY_SIDE'
        : 'AMBIGUOUS';
  return {
    evidenceLevel,
    ownership,
    conflict,
    targetAxes,
    bodyAxes,
    category: conflict
      ? 'CONFLICTED'
      : positiveFrontierProof
        ? 'FRONTIER_CORROBORATED'
        : exhaustive
          ? 'DIRECT_EXHAUSTIVE'
          : directTarget || directBody
            ? 'DIRECT_CORROBORATED'
            : target > 0 || body > 0
              ? 'SPARSE_UNCORROBORATED'
              : 'UNKNOWN',
  };
}

export interface InterfaceOwnershipEvidence {
  readonly evidenceLevel?: InterfaceEvidenceLevel;
  readonly wholeCertificate?: WholeInterfaceCertificate;
  readonly observations?: readonly InterfaceObservationSupport[];
  readonly support?: ReturnType<typeof classifyInterfaceOwnershipSupport>;
  readonly interfaceSelectedAlternative: 0 | 1 | null;
  readonly ownership: InterfaceOwnership;
  readonly surfaceArea: number;
  readonly targetPixels: number;
  readonly bodyPixels: number;
  readonly unknownPixels: number;
  readonly pixelVisits: number;
  readonly faceVisits: number;
  readonly scratchBytes: number;
  readonly conflict: boolean;
  readonly positiveFrontierProof: boolean;
  readonly localSupport?: {
    readonly viewPixels: readonly number[];
    readonly observedAxes: readonly number[];
    readonly frontier: number | null;
    readonly interfaceLow: number;
    readonly uncertainty: number;
    readonly interfaceFaces: number;
  };
  readonly materialInterface?: MaterialInterface;
  readonly clippedOperations: number;
}
/** Inspect only original planar interface faces whose physical ownership differs between two
 * already-admitted candidates. Polygon absence supplies no negative evidence, including in an
 * otherwise annotated view. Coordinates and surface area are normalized source geometry. */
export function interfaceOwnershipEvidence(
  prepared: PreparedSemanticGeometry,
  target: SemanticPart,
  peers: readonly SemanticPart[],
  alternatives: readonly [SuggestedPlane, SuggestedPlane],
  checkpoint: Checkpoint,
  charge: () => void = (): void => undefined,
  collectedInterface?: MaterialInterface,
): InterfaceOwnershipEvidence {
  const { geometry } = prepared;
  const faces = new Uint8Array(geometry.faceCount);
  let workUnits = 0;
  const chargeVisit = (): void => {
    workUnits++;
    charge();
  };
  const selectedBy = new Set<0 | 1>();
  let interfaceLow = Infinity;
  let surfaceArea = 0,
    targetPixels = 0,
    bodyPixels = 0,
    unknownPixels = 0;
  const signed = (plane: SuggestedPlane, p: Vec3): number =>
    plane.normal.reduce(
      (sum, n, axis) => sum + n * ((p[axis] ?? 0) - (plane.origin[axis] ?? 0)),
      0,
    );
  const region =
    collectedInterface ?? collectMaterialInterface(geometry, alternatives, checkpoint, chargeVisit);
  if (region) {
    surfaceArea = region.area;
    const signatures = alternatives.map((c) =>
      interfaceMembershipSignature(geometry, region, c, checkpoint, chargeVisit),
    );
    signatures.forEach((signature, i) => {
      if (signature.ownership === 'TARGET_SIDE') selectedBy.add(i as 0 | 1);
    });
    for (const face of region.faces) {
      faces[face] = 1;
      for (let corner = 0; corner < 3; corner++) {
        const first = (geometry.indices[face * 3 + corner] ?? 0) * 3;
        interfaceLow = Math.min(
          interfaceLow,
          region.normal.reduce((sum, n, a) => sum + n * (geometry.positions[first + a] ?? 0), 0),
        );
      }
    }
  }
  // Existing frontier collection is retained verbatim. A corroborated positive target frontier
  // supplies LOCAL association only; it never forces whole-interface ownership. Use the actual cut
  // direction and the complete projected interface interval, including its angular spread.
  // Missing silhouette coverage supplies no converse BODY proof.
  const inspectFrontier =
    surfaceArea > 0 &&
    Math.abs(
      alternatives[0].normal.reduce((sum, n, a) => sum + n * (alternatives[1].normal[a] ?? 0), 0) -
        1,
    ) <= 1e-7;
  const pixelUncertainty =
    (2 * geometry.radius) / ((prepared.rasters[0]?.size ?? 512) * FRAME_FILL);
  const frontier = inspectFrontier
    ? collectGroundedBoundaryWitnesses(
        prepared,
        target,
        [requiredValue(region).normal],
        checkpoint,
        chargeVisit,
        (point, normal) =>
          signed({ normal, origin: [0, 0, 0] }, point) < interfaceLow - pixelUncertainty - 1e-8 &&
          interfaceCorrespondsToPoint(
            geometry,
            requiredValue(region),
            point,
            pixelUncertainty,
            checkpoint,
            chargeVisit,
          ),
      )[0]
    : undefined;

  const positiveFrontierProof = Boolean(
    frontier &&
    frontier.observedAxes.length >= 2 &&
    frontier.low < interfaceLow - pixelUncertainty - 1e-8,
  );
  const observations: InterfaceObservationSupport[] = [];
  for (const raster of prepared.rasters) {
    let visible = 0,
      viewTarget = 0,
      viewBody = 0,
      viewUnknown = 0;
    const targetRegions = target.views.filter((r) => r.view === raster.view);
    const bodyRegions = peers.flatMap((p) => p.views.filter((r) => r.view === raster.view));
    for (let i = 0; i < raster.face.length; i++) {
      chargeVisit();
      if ((i & 1023) === 0) checkpoint();
      const face = raster.face[i] ?? -1;
      if (face < 0 || !faces[face]) continue;
      visible++;
      const x = ((i % raster.size) + 0.5) / raster.size;
      const y = (Math.floor(i / raster.size) + 0.5) / raster.size;
      const contains = (regions: SemanticPart['views']): boolean =>
        regions.some((r) => r.polygons.some((p) => pointInSemanticPolygon(x, y, p)));
      const ownedTarget = contains(targetRegions),
        ownedBody = contains(bodyRegions);
      if (ownedTarget) {
        targetPixels++;
        viewTarget++;
      }
      if (ownedBody) {
        bodyPixels++;
        viewBody++;
      }
      if (!ownedTarget && !ownedBody) {
        unknownPixels++;
        viewUnknown++;
      }
    }
    observations.push({
      view: raster.view,
      visiblePixels: visible,
      targetPixels: viewTarget,
      bodyPixels: viewBody,
      unknownPixels: viewUnknown,
    });
  }
  checkpoint();
  const consistentExhaustive =
    unknownPixels === 0 &&
    ((targetPixels > 0 && bodyPixels === 0) ||
      (bodyPixels > 0 && targetPixels === 0 && !positiveFrontierProof));
  const wholeCertificate =
    region && consistentExhaustive
      ? certifyWholeInterface(
          prepared,
          region,
          targetPixels > 0 ? [target] : peers,
          checkpoint,
          charge,
          targetPixels > 0 ? peers : [target],
        )
      : undefined;
  const support = classifyInterfaceOwnershipSupport(
    observations,
    positiveFrontierProof,
    wholeCertificate,
  );
  return {
    evidenceLevel: support.evidenceLevel,
    ...(wholeCertificate ? { wholeCertificate } : {}),
    observations,
    support,
    interfaceSelectedAlternative: selectedBy.size === 1 ? (selectedBy.has(0) ? 0 : 1) : null,
    ownership: support.ownership,
    surfaceArea,
    targetPixels,
    bodyPixels,
    unknownPixels,
    pixelVisits: workUnits,
    faceVisits: region?.sourceFacesInspected ?? geometry.faceCount,
    clippedOperations: (region?.clippedOperations ?? 0) + (region?.faces.length ?? 0) * 2,
    // The corroborated-frontier collector also owns one reusable raster visitation mask.
    scratchBytes:
      faces.byteLength +
      (wholeCertificate?.scratchBytes ?? 0) +
      (region?.scratchBytes ?? 0) +
      (inspectFrontier ? Math.max(0, ...prepared.rasters.map((r) => r.face.length)) : 0),
    conflict: support.conflict,
    positiveFrontierProof,
    ...(region
      ? {
          materialInterface: region,
          localSupport: {
            viewPixels: frontier?.viewPixels ?? [],
            observedAxes: frontier?.observedAxes ?? [],
            frontier: frontier?.low ?? null,
            interfaceLow,
            uncertainty: pixelUncertainty,
            interfaceFaces: region.faces.length,
          },
        }
      : {}),
  };
}

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
