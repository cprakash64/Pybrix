import type { Checkpoint } from './checkpoint';
import type { GroundedSourceFrameProvenance } from './semantic-grounded-scope';

export type OwnershipSourceEvidenceKind =
  'MATERIAL_INTERFACE_SOURCE' | 'GROUNDED_SOURCE_FRAME_SOURCE';
export type OwnershipSourceComponentResolution =
  | {
      readonly proven: true;
      readonly component: number;
      readonly evidenceKind: OwnershipSourceEvidenceKind;
      readonly provenanceFacesInspected: number;
      readonly anchorFace?: number;
    }
  | {
      readonly proven: false;
      readonly reason: 'TRANSITION_SOURCE_CORRESPONDENCE_UNAVAILABLE';
      readonly provenanceFacesInspected: number;
    };
/** Prove one original component from all direction/interface contributors, never
 * from a default component, nearby geometry, or a manufactured interface. */
export function resolveOwnershipSourceComponent(
  faceRanks: ArrayLike<number>,
  componentCount: number,
  materialSourceFaces: readonly number[] | undefined,
  groundedFrame: GroundedSourceFrameProvenance | undefined,
  sourceFaceLimit: number,
  checkpoint: Checkpoint,
  charge: () => void,
): OwnershipSourceComponentResolution {
  checkpoint();
  let visits = 0;
  const refusal = (): OwnershipSourceComponentResolution => ({
    proven: false,
    reason: 'TRANSITION_SOURCE_CORRESPONDENCE_UNAVAILABLE',
    provenanceFacesInspected: visits,
  });
  const faces = materialSourceFaces ?? groundedFrame?.sourceFaces;
  if (!faces?.length || faces.length > sourceFaceLimit) return refusal();
  let component: number | undefined;
  for (const face of faces) {
    if ((visits & 255) === 0) checkpoint();
    charge();
    visits++;
    if (!Number.isInteger(face) || face < 0 || face >= faceRanks.length) return refusal();
    const rank = faceRanks[face];
    if (rank === undefined || !Number.isInteger(rank) || rank < 0 || rank >= componentCount)
      return refusal();
    if (component !== undefined && component !== rank) return refusal();
    component = rank;
  }
  checkpoint();
  if (component === undefined) return refusal();
  return {
    proven: true,
    component,
    evidenceKind: materialSourceFaces
      ? 'MATERIAL_INTERFACE_SOURCE'
      : 'GROUNDED_SOURCE_FRAME_SOURCE',
    provenanceFacesInspected: visits,
    ...(materialSourceFaces ? { anchorFace: materialSourceFaces[0] } : {}),
  };
}
