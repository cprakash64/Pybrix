import { modelUnavailable } from '@cadfixer/shared';
import type { SplitCommitResult, SplitTransactionStatus } from '@cadfixer/geometry-runtime';
import type { GeometryClient } from './geometry-client';

type SplitCommitTransport = Pick<
  GeometryClient,
  'ackSplitCommit' | 'abortSplitCommit' | 'splitCommitStatus'
> &
  Partial<Pick<GeometryClient, 'confirmSplitReceipt' | 'trackSplitAdoption'>>;

/** An unresolved transport is not an aborted edit. Keep its pre-known identity. */
export class SplitCommitRecoveryRequired extends Error {
  public readonly transactionId: string;
  public constructor(transactionId: string) {
    super('The split transaction needs reconnection before editing can continue.');
    this.transactionId = transactionId;
  }
}
export async function recoverSplitCommit(
  client: SplitCommitTransport,
  transactionId: string,
  adopted: boolean,
): Promise<SplitTransactionStatus> {
  // Retries concern delivery, never geometry or provider execution. Status is
  // authoritative; an ACK response loss must never become an automatic Abort.
  for (let retry = 0; retry < 3; retry++) {
    try {
      const result = await (
        adopted ? client.ackSplitCommit(transactionId) : client.abortSplitCommit(transactionId)
      ).promise;
      if (result.transactionId !== transactionId)
        throw modelUnavailable('Split transaction response does not match.');
      if (result.state === 'FINALIZED' || result.state === 'ABORTED') return result;
    } catch {
      /* Query a possibly executed request before deciding anything. */
    }
    try {
      const status = await client.splitCommitStatus(transactionId).promise;
      if (status.transactionId !== transactionId)
        throw modelUnavailable('Split transaction response does not match.');
      if (status.state === 'FINALIZED' || status.state === 'ABORTED') return status;
      if (status.state === 'UNKNOWN' && !adopted) return status; // prepare never acquired authority
    } catch {
      /* No inference from a missing response. */
    }
  }
  throw new SplitCommitRecoveryRequired(transactionId);
}

/** Actual UI adoption is inside this protocol, not an action after worker commit. */
export async function adoptSplitCommit(
  client: SplitCommitTransport,
  operation: ReturnType<GeometryClient['commitSplit']>,
  adopt: (result: SplitCommitResult) => boolean,
  rollback: (() => void) & { publish?: () => void },
): Promise<SplitCommitResult> {
  client.trackSplitAdoption?.(operation.transactionId, rollback, false);
  let result: SplitCommitResult;
  try {
    result = await operation.promise;
  } catch (cause) {
    const state = await recoverSplitCommit(client, operation.transactionId, false);
    if (state.state === 'FINALIZED') throw new SplitCommitRecoveryRequired(operation.transactionId);
    rollback();
    client.confirmSplitReceipt?.(operation.transactionId, state.state !== 'UNKNOWN');
    throw cause;
  }
  client.trackSplitAdoption?.(operation.transactionId, rollback, false);
  let accepted: boolean;
  try {
    accepted = adopt(result);
  } catch (cause) {
    const state = await recoverSplitCommit(client, operation.transactionId, false);
    if (state.state === 'FINALIZED') throw new SplitCommitRecoveryRequired(operation.transactionId);
    rollback();
    client.confirmSplitReceipt?.(operation.transactionId, state.state !== 'UNKNOWN');
    throw cause;
  }
  if (!accepted) {
    const state = await recoverSplitCommit(client, operation.transactionId, false);
    if (state.state === 'FINALIZED') throw new SplitCommitRecoveryRequired(operation.transactionId);
    rollback();
    client.confirmSplitReceipt?.(operation.transactionId, state.state !== 'UNKNOWN');
    throw modelUnavailable('The model changed before the split could be applied.');
  }
  client.trackSplitAdoption?.(operation.transactionId, rollback, true);
  const state = await recoverSplitCommit(client, operation.transactionId, true);
  if (state.state === 'ABORTED') {
    rollback();
    client.confirmSplitReceipt?.(operation.transactionId);
    throw modelUnavailable('The split transaction was aborted before finalization.');
  }
  if (
    state.state !== 'FINALIZED' ||
    state.handle?.documentId !== result.handle.documentId ||
    state.handle.revision !== result.handle.revision
  )
    throw new SplitCommitRecoveryRequired(operation.transactionId);
  rollback.publish?.();
  client.confirmSplitReceipt?.(operation.transactionId);
  return result;
}
