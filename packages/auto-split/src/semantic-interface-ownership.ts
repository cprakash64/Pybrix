import {
  collectMaterialInterface,
  interfaceMembershipSignature,
  interfaceCorrespondsToPoint,
  type MaterialInterface,
} from './semantic-interface-membership';
import { FRAME_FILL, type SemanticPart, type Vec3 } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import { pointInSemanticPolygon } from './semantic';
import { collectGroundedBoundaryWitnesses } from './semantic-grounded-boundary';
import type { SuggestedPlane } from './suggestions';
import type { Checkpoint } from './checkpoint';
import type { InterfaceOwnership } from './semantic-boundary-confirmation';

export interface InterfaceOwnershipEvidence {
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
  const region = collectMaterialInterface(geometry, alternatives, checkpoint, chargeVisit);
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
  // With parallel hypotheses, preserving a corroborated positive target frontier behind EVERY
  // changed interface vertex forces that interface into the target halfspace. Use the actual cut
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
        [region!.normal],
        checkpoint,
        chargeVisit,
        (point, normal) =>
          signed({ normal, origin: [0, 0, 0] }, point) < interfaceLow - pixelUncertainty - 1e-8 &&
          interfaceCorrespondsToPoint(
            geometry,
            region!,
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
  for (const raster of prepared.rasters) {
    const targetRegions = target.views.filter((r) => r.view === raster.view);
    const bodyRegions = peers.flatMap((p) => p.views.filter((r) => r.view === raster.view));
    for (let i = 0; i < raster.face.length; i++) {
      chargeVisit();
      if ((i & 1023) === 0) checkpoint();
      const face = raster.face[i] ?? -1;
      if (face < 0 || !faces[face]) continue;
      const x = ((i % raster.size) + 0.5) / raster.size;
      const y = (Math.floor(i / raster.size) + 0.5) / raster.size;
      const contains = (regions: SemanticPart['views']): boolean =>
        regions.some((r) => r.polygons.some((p) => pointInSemanticPolygon(x, y, p)));
      const ownedTarget = contains(targetRegions),
        ownedBody = contains(bodyRegions);
      if (ownedTarget) targetPixels++;
      if (ownedBody) bodyPixels++;
      if (!ownedTarget && !ownedBody) unknownPixels++;
    }
  }
  checkpoint();
  return {
    interfaceSelectedAlternative: selectedBy.size === 1 ? (selectedBy.has(0) ? 0 : 1) : null,
    ownership:
      (targetPixels > 0 || positiveFrontierProof) && bodyPixels === 0
        ? 'TARGET_SIDE'
        : bodyPixels > 0 && targetPixels === 0 && !positiveFrontierProof
          ? 'BODY_SIDE'
          : 'AMBIGUOUS',
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
      (region?.scratchBytes ?? 0) +
      (inspectFrontier ? Math.max(0, ...prepared.rasters.map((r) => r.face.length)) : 0),
    conflict: (targetPixels > 0 || positiveFrontierProof) && bodyPixels > 0,
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
