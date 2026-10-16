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
  readonly rule: 'GROUNDED_COMPLEMENT' | 'LOCALIZED_TARGET' | 'NO_MEANINGFUL_DECOMPOSITION';
  readonly targetSilhouetteShares: readonly number[];
  readonly selectedSourceSampleShare: number;
  readonly groundedComplementPeers: readonly string[];
  readonly localizedViews: number;
  readonly workUnits: number;
  readonly scratchBytes: number;
}
export function semanticDecompositionIntent(
  targetSilhouetteShares: readonly number[],
  selectedSourceSampleShare: number,
  peers: readonly { readonly id: string; readonly leakage: number; readonly views: number }[],
  checkpoint: Checkpoint,
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
      peer.views >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews &&
      peer.leakage <= SEMANTIC_INTENT_LIMITS.maximumOppositePeerLeakage
    )
      groundedComplementPeers.push(peer.id);
  }
  const localized =
    localizedViews >= SEMANTIC_INTENT_LIMITS.minimumIndependentViews &&
    selectedSourceSampleShare > 0 &&
    selectedSourceSampleShare <= SEMANTIC_INTENT_LIMITS.maximumSelectedSourceSampleShare;
  checkpoint();
  return {
    admitted: groundedComplementPeers.length > 0 || localized,
    rule: groundedComplementPeers.length
      ? 'GROUNDED_COMPLEMENT'
      : localized
        ? 'LOCALIZED_TARGET'
        : 'NO_MEANINGFUL_DECOMPOSITION',
    targetSilhouetteShares,
    selectedSourceSampleShare,
    groundedComplementPeers,
    localizedViews,
    workUnits,
    scratchBytes: 0,
  };
}
