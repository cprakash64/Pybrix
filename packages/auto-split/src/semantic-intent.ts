import type { SemanticHierarchy, SemanticPart } from '@cadfixer/auto-split-contract';
import type { StructuralSeamEvidence } from './semantic-seam';
import type { Checkpoint } from './checkpoint';
/** Compact local evidence only. Names, taxonomy and provider component IDs never vote. */
export const SEMANTIC_INTENT_LIMITS = Object.freeze({
  maximumTargetSilhouetteShare: 0.8,
  maximumSelectedSourceSampleShare: 0.85,
  maximumOppositePeerLeakage: 0.2,
  minimumIndependentViews: 2,
});
export interface SemanticDecompositionIntent {
  readonly admitted: boolean;
  readonly rule: 'GROUNDED_COMPLEMENT' | 'STRUCTURAL_SEAM' | 'BOTH' | 'NO_MEANINGFUL_DECOMPOSITION';
  readonly structuralSeam: StructuralSeamEvidence | null;
  readonly independentAxes: number;
  readonly targetSilhouetteShares: readonly number[];
  readonly selectedSourceSampleShare: number;
  readonly groundedComplementPeers: readonly string[];
  readonly peerEvidence: readonly {
    readonly id: string;
    readonly leakage: number;
    readonly views: number;
    readonly independent: boolean;
  }[];
  readonly localizedViews: number;
  readonly workUnits: number;
  readonly scratchBytes: number;
}
export function semanticDecompositionIntent(
  targetSilhouetteShares: readonly number[],
  selectedSourceSampleShare: number,
  peers: readonly {
    readonly id: string;
    readonly leakage: number;
    readonly views: number;
    readonly independent: boolean;
  }[],
  checkpoint: Checkpoint,
  structure?: { readonly seam: StructuralSeamEvidence; readonly independentAxes: number },
): SemanticDecompositionIntent {
  let localizedViews = 0,
    workUnits = 0;
  for (const share of targetSilhouetteShares) {
    checkpoint();
    workUnits++;
    if (share > 0 && share <= SEMANTIC_INTENT_LIMITS.maximumTargetSilhouetteShare) localizedViews++;
  }
  const groundedComplementPeers: string[] = [];
  for (const peer of peers) {
    checkpoint();
    workUnits++;
    if (
      peer.independent &&
      peer.views >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews &&
      peer.leakage <= SEMANTIC_INTENT_LIMITS.maximumOppositePeerLeakage
    )
      groundedComplementPeers.push(peer.id);
  }
  const localized =
    localizedViews >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews &&
    selectedSourceSampleShare > 0 &&
    selectedSourceSampleShare <= SEMANTIC_INTENT_LIMITS.maximumSelectedSourceSampleShare;
  const seamAdmitted =
    localized && structure?.seam.admitted === true && structure.independentAxes >= 2;
  checkpoint();
  return {
    structuralSeam: structure?.seam ?? null,
    independentAxes: structure?.independentAxes ?? 0,
    admitted: groundedComplementPeers.length > 0 || seamAdmitted,
    rule: groundedComplementPeers.length
      ? seamAdmitted
        ? 'BOTH'
        : 'GROUNDED_COMPLEMENT'
      : seamAdmitted
        ? 'STRUCTURAL_SEAM'
        : 'NO_MEANINGFUL_DECOMPOSITION',
    targetSilhouetteShares,
    selectedSourceSampleShare,
    groundedComplementPeers,
    peerEvidence: peers.map(({ id, leakage, views, independent }) => ({
      id,
      leakage,
      views,
      independent,
    })),
    localizedViews,
    workUnits: workUnits + (structure?.seam.workUnits ?? 0),
    scratchBytes: 0,
  };
}

/** Ownership exclusions may include descendants/details. They are not independent intent. */
export function independentPlanePeer(
  target: SemanticPart,
  peerId: string,
  answer: SemanticHierarchy,
  evidence: { readonly independentAxes: number; readonly sameSourceComponent: boolean },
  checkpoint: Checkpoint,
): boolean {
  const peer = answer.parts.find((part) => part.id === peerId);
  if (
    !peer ||
    peer.id === target.id ||
    peer.importance !== 'major' ||
    !evidence.sameSourceComponent ||
    evidence.independentAxes < 2
  )
    return false;
  const ancestor = (parent: string, child: SemanticPart): boolean => {
    let id = child.parentId;
    for (let depth = 0; id && depth < 4; depth++) {
      checkpoint();
      if (id === parent) return true;
      id = answer.parts.find((part) => part.id === id)?.parentId ?? null;
    }
    return false;
  };
  return !ancestor(target.id, peer) && !ancestor(peer.id, target);
}
