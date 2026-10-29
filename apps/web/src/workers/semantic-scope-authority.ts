import type { SplitCreateResult } from '@cadfixer/geometry-runtime';
import { invalidState } from '@cadfixer/shared';
import { semanticPlaneIdentity } from '@cadfixer/auto-split';

type Proof = NonNullable<SplitCreateResult['semanticQualification']>;
interface Receipt {
  readonly id: string;
  readonly candidate: SplitCreateResult['candidate'];
  readonly proof: Proof;
  readonly physicalPlane: ReturnType<typeof semanticPlaneIdentity>;
  readonly current: () => boolean;
  readonly physicalResult: object;
  readonly automatic: boolean;
  readonly expiresAt: number;
  readonly expiresAtEpoch: number;
  confirmed: boolean;
  consumed: boolean;
  cancelled: boolean;
}
// One current physical preview. Superseded entries remain guarded by their native ticket closure,
// but cannot be looked up or reconfirmed. No mesh copy is retained here.
let receipt: Receipt | undefined;
let receiptSequence = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;
export function releaseScopeReceipt(documentId?: string): void {
  if (!receipt || (documentId !== undefined && receipt.candidate.documentId !== documentId)) return;
  receipt.cancelled = true;
  receipt = undefined;
  if (expiry !== undefined) clearTimeout(expiry);
  expiry = undefined;
}
const stale = (): never => {
  throw invalidState('Preview and choose the current physical piece before applying this cut.');
};
function validate(r: Receipt): void {
  if (r.cancelled || r.consumed || performance.now() >= r.expiresAt || !r.current()) stale();
}
export function issueScopeReceipt(
  preview: SplitCreateResult,
  physicalResult: object,
  binding: { readonly automatic: boolean; readonly current: () => boolean },
): { readonly proof: Proof; readonly authorizeCommit: () => void } {
  if (!preview.semanticQualification) return stale();
  releaseScopeReceipt();
  const r: Receipt = {
    id: `${crypto.randomUUID()}.${String(++receiptSequence)}`,
    candidate: preview.candidate,
    proof: preview.semanticQualification,
    physicalPlane: semanticPlaneIdentity(preview.semanticQualification.plane),
    physicalResult,
    automatic: binding.automatic,
    expiresAt: performance.now() + 240_000,
    expiresAtEpoch: Date.now() + 240_000,
    confirmed: false,
    consumed: false,
    cancelled: false,
    current: binding.current,
  };
  receipt = r;
  expiry = setTimeout(() => {
    if (receipt === r) releaseScopeReceipt();
  }, 240_000);
  return {
    proof: receiptProof(r),
    authorizeCommit: (): void => {
      validate(r);
      if (!r.automatic && !r.confirmed) stale();
      r.consumed = true;
      if (receipt === r) releaseScopeReceipt();
    },
  };
}
function receiptProof(r: Receipt): Proof {
  return {
    ...r.proof,
    ...(r.proof.boundaryAlternativeId
      ? { boundaryChoice: r.confirmed ? ('CONFIRM' as const) : ('PREVIEW' as const) }
      : {}),
    scopeConfirmation: {
      receiptId: r.id,
      expiresAt: r.expiresAtEpoch,
      state: r.automatic ? 'AUTOMATIC_IDENTIFIED' : r.confirmed ? 'CONFIRMED' : 'REQUIRED',
    },
  };
}
export function confirmScopeReceipt(
  id: string,
  physical: (candidate: SplitCreateResult['candidate']) => object,
): { readonly candidate: SplitCreateResult['candidate']; readonly proof: Proof } {
  const r = receipt;
  if (typeof id !== 'string' || id.length > 96 || id !== r?.id || r.confirmed || r.automatic)
    return stale();
  validate(r);
  if (physical(r.candidate) !== r.physicalResult) return stale();
  r.confirmed = true;
  return { candidate: r.candidate, proof: receiptProof(r) };
}
export function cancelScopeReceipt(candidate: SplitCreateResult['candidate']): void {
  if (
    receipt?.candidate.candidateId === candidate.candidateId &&
    receipt.candidate.documentId === candidate.documentId
  )
    releaseScopeReceipt(candidate.documentId);
}
