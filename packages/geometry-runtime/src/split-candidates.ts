import { splitBufferSHA, splitMeshSHA } from './split-source-identity';
import { recordJointFromSplit, type JointNotRecorded } from './connector-rebuild';
import {
  assertGeometryDocument,
  composePartTransforms,
  documentTriangleCount,
  documentVertexCount,
  jointRetainedBytes,
  MAX_JOINT_RETAINED_BYTES,
  meshByteLength,
  partId,
  retireDetachedJoints,
  type GeometryDocument,
  type GeometryPart,
  type PartId,
} from '@cadfixer/mesh-core';
import {
  invalidState,
  isAppError,
  modelUnavailable,
  type CancellationToken,
} from '@cadfixer/shared';
import {
  documentByteLength,
  isDocument,
  type DocumentHandle,
  type DocumentId,
  type ResidentDocumentStore,
} from './resident-documents';
import {
  validateGeometryEdit,
  type GeometryEditStore,
  type GeometryEditResourceAccounting,
  type GeometryEditTicket,
} from './geometry-edit';
import type { RepairHistoryStore } from './repair-history';
import { UndoableChangeKind } from './repair-history';
import { analyseTopology } from '@cadfixer/mesh-topology';
import {
  preparePlaneSplitSource,
  type PreparedPlaneSplitSource,
  type SplitPlane,
  type SplitResult,
} from './split-connectors';

export interface SplitCandidateHandle extends GeometryEditTicket {
  readonly candidateId: string;
}
export type EditableConnectorStatus =
  | { readonly status: 'RECORDED'; readonly jointId: string; readonly pinCount: number }
  | {
      readonly status: 'NOT_RECORDED';
      readonly reason: JointNotRecorded | 'RETENTION_CEILING';
      /** Present for `RETENTION_CEILING`: what would have been retained, and the limit, so the refusal names both. */
      readonly retainedBytes?: number;
      readonly limit?: number;
    };
export interface SplitCandidateSummary {
  readonly candidate: SplitCandidateHandle;
  readonly pieceAId: PartId;
  readonly pieceBId: PartId;
  readonly resources: GeometryEditResourceAccounting;
  readonly metrics: SplitResult['metrics'];
  readonly connector: SplitResult['connector'];
  readonly interface?: SplitResult['interface'];
  /**
   * Whether this split leaves an EDITABLE connector joint behind, and if not, why. A split is never refused for it: above the retention
   * ceiling, on a unit-less model or on a placement that is not a similarity the pieces are exactly what they always were.
   */
  readonly editableConnector: EditableConnectorStatus;
  readonly automaticConnector?: SplitResult['automaticConnector'];
  /**
   * The cut's cross-section, from Piece A's cap before any connector: area,
   * boundary-loop count and a bounded part-local outline. Reported for display;
   * it decides nothing.
   */
  readonly section: {
    readonly area: number;
    readonly loopCount: number;
    readonly outline: Float32Array;
    readonly outlineTruncated: boolean;
  };
}
interface Entry {
  authorizeCommit?: () => void;
  lockedBy?: string;
  attempt: number;
  readonly source: GeometryDocument;
  readonly sourceSHA: string;
  readonly candidateSHA: string;
  readonly handle: SplitCandidateHandle;
  readonly document: GeometryDocument;
  readonly resultIdentity: object;
  readonly summary: SplitCandidateSummary;
  readonly closedPlaneAuthority?: {
    readonly interface: NonNullable<SplitResult['closedPlaneClip']>['interface'];
    readonly provenanceA: Int32Array;
    readonly provenanceB: Int32Array;
    readonly provenanceSHA: string;
  };
}

export type SplitTransactionState =
  'UNKNOWN' | 'PREPARED' | 'APPLIED_PENDING_ADOPTION' | 'FINALIZED' | 'ABORTED';
export interface SplitTransactionStatus {
  readonly transactionId: string;
  readonly state: SplitTransactionState;
  readonly source?: DocumentHandle;
  readonly handle?: DocumentHandle;
  readonly candidateId?: string;
  readonly generation?: number;
  readonly partId?: PartId;
  readonly sourceSHA?: string;
  readonly recordId?: string;
}
interface Transaction {
  status: SplitTransactionStatus;
  readonly candidate: SplitCandidateHandle;
  readonly expected: DocumentHandle;
  readonly part: PartId;
  readonly lock: object;
}
const MAX_PENDING_SPLIT_TRANSACTIONS = 32;
const MAX_TERMINAL_SPLIT_RECEIPTS = 64;
/** Caller can derive this BEFORE any mutating/staging request. Attempt is monotonic per candidate. */
export function splitTransactionId(candidate: SplitCandidateHandle, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw invalidState('Invalid transaction attempt.');
  return `${candidate.candidateId}/commit/${String(attempt)}`;
}
function candidateMeshSHA(document: GeometryDocument, a: PartId, b: PartId): string {
  return document.parts
    .filter((p) => p.id === a || p.id === b)
    .map((p) => `${p.id}:${JSON.stringify(p.transform)}:${splitMeshSHA(p.mesh)}`)
    .join('/');
}

/** Two-piece specialization of the Stage 7 worker-resident candidate transaction. */
export class SplitCandidateStore {
  // Worker replacement can repeat every source/ticket counter. Namespace the
  // executable Map key with local cryptographic identity for this store lifetime.
  // Keep the platform boundary structural: this package has no DOM dependency.
  private readonly runtimeId = (
    globalThis as typeof globalThis & { crypto: { randomUUID(): string } }
  ).crypto.randomUUID();
  private readonly candidates = new Map<string, Entry>();
  private readonly active = new Map<DocumentId, string>();
  private readonly prepared = new WeakMap<GeometryEditTicket, PreparedPlaneSplitSource>();
  private nextId = 1;
  private nextJoint = 1;
  private readonly transactions = new Map<string, Transaction>();
  private readonly resident: ResidentDocumentStore;
  private readonly history: RepairHistoryStore;
  private readonly lifecycle: GeometryEditStore;
  /**
   * The most an editable joint may retain. A CONSTRUCTION SEAM, not a switch: the application builds one store with the default,
   * which is derived from the split ceiling, and a test builds another with a small one to prove a split is not refused for it.
   */
  private readonly maxJointRetainedBytes: number;
  public constructor(
    resident: ResidentDocumentStore,
    history: RepairHistoryStore,
    lifecycle: GeometryEditStore,
    maxJointRetainedBytes: number = MAX_JOINT_RETAINED_BYTES,
  ) {
    this.maxJointRetainedBytes = maxJointRetainedBytes;
    this.resident = resident;
    this.history = history;
    this.lifecycle = lifecycle;
  }
  public begin(source: DocumentHandle, sourcePart: PartId): GeometryEditTicket {
    this.resident.assertMutable(source.documentId);
    const old = this.active.get(source.documentId);
    if (old) this.discardById(old);
    return this.lifecycle.begin(source, sourcePart, 'split');
  }
  public preparePlaneSource(
    ticket: GeometryEditTicket,
    plane: SplitPlane,
    cancellation: CancellationToken,
  ): PreparedPlaneSplitSource {
    if (!this.lifecycle.isCurrent(ticket)) throw modelUnavailable('The split source is stale.');
    const part = this.resident.resolvePart(
      { documentId: ticket.documentId, revision: ticket.sourceRevision },
      ticket.partId,
    );
    if (isAppError(part)) throw part;
    const prepared = preparePlaneSplitSource(
      part.mesh,
      plane,
      part.transform,
      {
        document: ticket.documentId,
        revision: ticket.sourceRevision,
        part: ticket.partId,
        generation: ticket.generation,
      },
      cancellation,
    );
    this.prepared.set(ticket, prepared);
    return prepared;
  }
  public resolve(
    ticket: GeometryEditTicket,
    result: SplitResult,
    cancellation: CancellationToken,
  ): SplitCandidateSummary {
    if (!this.lifecycle.isCurrent(ticket))
      throw modelUnavailable('A newer split superseded this result.');
    const sourceHandle: DocumentHandle = {
        documentId: ticket.documentId,
        revision: ticket.sourceRevision,
      },
      source = this.resident.resolve(sourceHandle);
    if (!isDocument(source)) throw source;
    const index = source.parts.findIndex((p) => p.id === ticket.partId),
      original = source.parts[index];
    if (index < 0 || !original) throw modelUnavailable('The selected part is no longer present.');
    const prepared = this.prepared.get(ticket);
    const clip = result.closedPlaneClip;
    if (
      prepared &&
      (prepared.mesh !== original.mesh ||
        prepared.transform !== original.transform ||
        (prepared.capability.strategy === 'exact-solid' &&
          (clip?.interface.frame.binding !== prepared.binding ||
            clip.interface.sourceSHA !== prepared.meshSHA ||
            clip.outputPlacement !== result.outputPlacements?.a ||
            clip.outputPlacement !== result.outputPlacements.b)))
    )
      throw modelUnavailable('The prepared split source is stale.');
    if (result.outputPlacements && !prepared)
      throw modelUnavailable('The split placements have no matching prepared source.');
    this.prepared.delete(ticket);
    const sourceDefects =
      result.surfaceValidation === undefined
        ? undefined
        : analyseTopology(original.mesh, {
            documentId: 'split-source',
            documentRevision: ticket.sourceRevision,
            partId: ticket.partId,
            cancellation,
            sampleLimit: 0,
            componentSummaryLimit: 1,
          }).report;
    const aValidation = validateGeometryEdit(
        result.pieceA,
        source,
        ticket.partId,
        undefined,
        cancellation,
        sourceDefects,
      ),
      bValidation = validateGeometryEdit(
        result.pieceB,
        source,
        ticket.partId,
        undefined,
        cancellation,
        sourceDefects,
      );
    if (
      sourceDefects !== undefined &&
      (aValidation.topology.zeroAreaFaceCount + bValidation.topology.zeroAreaFaceCount >
        sourceDefects.zeroAreaFaceCount ||
        aValidation.topology.repeatedPositionFaceCount +
          bValidation.topology.repeatedPositionFaceCount >
          sourceDefects.repeatedPositionFaceCount)
    )
      throw invalidState('This cut introduced degenerate faces.');
    const offset = clip?.outputAnchor;
    const rebased = offset?.some((value) => value !== 0)
      ? composePartTransforms(original.transform, [1, 0, 0, 0, 1, 0, 0, 0, 1, ...offset])
      : original.transform;
    const outputPlacements = result.outputPlacements ?? { a: rebased, b: rebased };
    const aId = uniquePartId(source, `${ticket.partId}-A`),
      bId = uniquePartId(source, `${ticket.partId}-B`, new Set([aId]));
    const a: GeometryPart = {
        ...original,
        id: aId,
        mesh: result.pieceA,
        transform: outputPlacements.a,
        name: `${original.name ?? 'Part'} A`,
      },
      b: GeometryPart = {
        ...original,
        id: bId,
        mesh: result.pieceB,
        transform: outputPlacements.b,
        name: `${original.name ?? 'Part'} B`,
      };
    const parts = source.parts.slice();
    parts.splice(index, 1, a, b);
    let document: GeometryDocument = { ...source, parts };
    // THE EDITABLE JOINT (Stage EC-3). Recorded from the split's own result; the pieces are not touched and the split is never
    // refused for it. The retention ceiling is judged on the document AS IT WILL BE INSTALLED, so a joint this very cut is about to
    // retire (a cut of a piece that already had connectors) is not counted against the new one.
    const recording = recordJointFromSplit({
      jointId: `${ticket.documentId}/joint/${String(this.nextJoint++)}`,
      unit: source.unit,
      sourceTransform: original.transform,
      result,
      a: { partId: aId, transform: a.transform },
      b: { partId: bId, transform: b.transform },
    });
    let editableConnector: EditableConnectorStatus;
    if (recording.recorded) {
      const withJoint: GeometryDocument = {
        ...document,
        joints: [...(document.joints ?? []), recording.joint],
      };
      const retained = jointRetainedBytes(
        retireDetachedJoints(withJoint, ticket.sourceRevision + 1),
      );
      if (retained > this.maxJointRetainedBytes)
        editableConnector = {
          status: 'NOT_RECORDED',
          reason: 'RETENTION_CEILING',
          retainedBytes: retained,
          limit: this.maxJointRetainedBytes,
        };
      else {
        document = withJoint;
        editableConnector = {
          status: 'RECORDED',
          jointId: recording.joint.jointId,
          pinCount: recording.joint.connector?.elements.length ?? 0,
        };
      }
    } else editableConnector = { status: 'NOT_RECORDED', reason: recording.reason };
    // The candidate is stored AS IT WILL BE INSTALLED: a joint over the part this cut replaces is retired here, at the revision it will
    // be installed as, so every figure a commit reports describes the document that is held and not one that still carries geometry
    // about to be released. Installation retires again at the same revision and installs this very object.
    document = retireDetachedJoints(document, ticket.sourceRevision + 1);
    assertGeometryDocument(document, 'split candidate');
    if (!this.lifecycle.isCurrent(ticket))
      throw modelUnavailable('The split became stale during validation.');
    const handle: SplitCandidateHandle = {
      ...ticket,
      candidateId: `${this.runtimeId}:split-candidate-${String(this.nextId++)}`,
    };
    const canonicalBytes = meshByteLength(result.pieceA) + meshByteLength(result.pieceB),
      triangles = documentTriangleCount(document),
      vertices = documentVertexCount(document);
    const resources: GeometryEditResourceAccounting = {
      triangles,
      vertices,
      canonicalBytes,
      renderBytes: aValidation.resources.renderBytes + bValidation.resources.renderBytes,
      estimatedPeakBytes:
        documentByteLength(source) +
        canonicalBytes +
        aValidation.resources.renderBytes +
        bValidation.resources.renderBytes,
    };
    const summary: SplitCandidateSummary = {
      candidate: handle,
      pieceAId: aId,
      pieceBId: bId,
      resources,
      metrics: result.metrics,
      connector: result.connector,
      ...(result.interface ? { interface: result.interface } : {}),
      editableConnector,
      ...(result.automaticConnector ? { automaticConnector: result.automaticConnector } : {}),
      section: {
        area: result.cutA.area,
        loopCount: result.cutA.loopCount,
        outline: result.cutA.outline,
        outlineTruncated: result.cutA.outlineTruncated,
      },
    };
    this.candidates.set(handle.candidateId, {
      handle,
      document,
      summary,
      resultIdentity: Object.freeze({}),
      attempt: 0,
      source,
      sourceSHA: prepared?.meshSHA ?? splitMeshSHA(original.mesh),
      ...(clip && result.connector.kind === 'none'
        ? {
            closedPlaneAuthority: {
              interface: clip.interface,
              provenanceA: clip.provenanceA,
              provenanceB: clip.provenanceB,
              provenanceSHA: splitBufferSHA([clip.provenanceA, clip.provenanceB], cancellation),
            },
          }
        : {}),
      candidateSHA: candidateMeshSHA(document, aId, bId),
    });
    this.active.set(ticket.documentId, handle.candidateId);
    return summary;
  }
  /** Opaque identity of this validated immutable result; holds no geometry buffers. */
  public resultIdentity(handle: SplitCandidateHandle): object {
    return this.require(handle).resultIdentity;
  }
  /** Trusted worker policy attached to this exact immutable result; never supplied by a client. */
  public authorizeCommit(handle: SplitCandidateHandle, authorize: () => void): void {
    this.require(handle).authorizeCommit = authorize;
  }
  public preview<T>(
    handle: SplitCandidateHandle,
    build: (document: GeometryDocument, summary: SplitCandidateSummary) => T,
  ): T {
    const e = this.require(handle);
    return build(e.document, e.summary);
  }
  public commit<T>(
    handle: SplitCandidateHandle,
    expected: DocumentHandle,
    expectedPart: PartId,
    build: (document: GeometryDocument, summary: SplitCandidateSummary) => T,
  ): { handle: DocumentHandle; recordId: string; value: T; summary: SplitCandidateSummary } {
    const e = this.require(handle);
    if (e.lockedBy) throw invalidState('Candidate is locked by a split transaction.');
    e.authorizeCommit?.();
    if (
      expected.documentId !== handle.documentId ||
      expected.revision !== handle.sourceRevision ||
      expectedPart !== handle.partId
    )
      throw modelUnavailable('The split targets a different model revision or part.');
    const source = this.resident.resolve(expected);
    if (!isDocument(source)) throw source;
    const original = source.parts.find((p) => p.id === expectedPart);
    if (!original) throw modelUnavailable('The selected part is no longer present.');
    assertGeometryDocument(e.document, 'split commit');
    const value = build(e.document, e.summary),
      next = { documentId: expected.documentId, revision: expected.revision + 1 },
      restoreHistory = this.history.checkpoint();
    const recordId = `${next.documentId}/${expectedPart}@${String(expected.revision)}->${String(next.revision)}#split`;
    try {
      this.history.record({
        recordId,
        kind: UndoableChangeKind.GeometryEdit,
        source: expected,
        part: expectedPart,
        result: next,
        appliedOperations: [],
        planHash: 'split',
        inverse: {
          previousMesh: original.mesh,
          sourceFaceCount: original.mesh.indices.length / 3,
          sourceIndexCount: original.mesh.indices.length,
          previousDocument: source,
          byteLength: documentByteLength(source),
        },
      });
      const installed = this.resident.replace(expected, e.document);
      if (isAppError(installed)) throw installed;
    } catch (cause) {
      restoreHistory();
      throw cause;
    }
    this.candidates.delete(handle.candidateId);
    this.active.delete(handle.documentId);
    return { handle: next, recordId, value, summary: e.summary };
  }
  public commitTransactionStats(): {
    pending: number;
    receipts: number;
    maxPending: number;
    maxReceipts: number;
  } {
    return {
      pending: [...this.transactions.values()].filter(
        (t) => t.status.state === 'PREPARED' || t.status.state === 'APPLIED_PENDING_ADOPTION',
      ).length,
      receipts: this.transactions.size,
      maxPending: MAX_PENDING_SPLIT_TRANSACTIONS,
      maxReceipts: MAX_PENDING_SPLIT_TRANSACTIONS + MAX_TERMINAL_SPLIT_RECEIPTS,
    };
  }
  public transactionStatus(transactionId: string): SplitTransactionStatus {
    const status = this.transactions.get(transactionId)?.status ?? {
      transactionId,
      state: 'UNKNOWN' as const,
    };
    return Object.freeze({
      ...status,
      ...(status.source ? { source: Object.freeze({ ...status.source }) } : {}),
      ...(status.handle ? { handle: Object.freeze({ ...status.handle }) } : {}),
    });
  }
  public prepareCommit<T>(
    transactionId: string,
    handle: SplitCandidateHandle,
    expected: DocumentHandle,
    part: PartId,
    build: (document: GeometryDocument, summary: SplitCandidateSummary) => T,
  ): { handle: DocumentHandle; recordId: string; value: T; summary: SplitCandidateSummary } {
    if (typeof transactionId !== 'string' || transactionId.length > 512)
      throw invalidState('Invalid split transaction identity.');
    const prior = this.transactions.get(transactionId);
    if (prior) {
      if (
        JSON.stringify(prior.candidate) !== JSON.stringify(handle) ||
        prior.expected.documentId !== expected.documentId ||
        prior.expected.revision !== expected.revision ||
        prior.part !== part
      )
        throw modelUnavailable('Transaction binding does not match.');
      if (prior.status.state !== 'APPLIED_PENDING_ADOPTION')
        throw invalidState('Transaction is already terminal.');
      const e = this.require(handle);
      this.checkTransactionSource(e, expected, part);
      return this.preparedValue(e, expected, build);
    }
    if (this.transactions.size >= MAX_PENDING_SPLIT_TRANSACTIONS + MAX_TERMINAL_SPLIT_RECEIPTS)
      throw invalidState('Split transaction receipts need reconciliation.');
    const e = this.require(handle),
      prefix = `${handle.candidateId}/commit/`,
      attempt = Number(transactionId.slice(prefix.length));
    if (
      !transactionId.startsWith(prefix) ||
      transactionId !== splitTransactionId(handle, attempt) ||
      attempt !== e.attempt + 1
    )
      throw invalidState('Transaction identity is stale or belongs to another candidate.');
    if (e.lockedBy) throw invalidState('Candidate is locked by a split transaction.');
    this.checkTransactionSource(e, expected, part);
    if (
      [...this.transactions.values()].filter(
        (t) => t.status.state === 'APPLIED_PENDING_ADOPTION' || t.status.state === 'PREPARED',
      ).length >= MAX_PENDING_SPLIT_TRANSACTIONS
    )
      throw invalidState('Too many unresolved split transactions.');
    e.authorizeCommit?.();
    const lock = Object.freeze({});
    this.resident.lockMutation(expected, lock);
    e.lockedBy = transactionId;
    e.attempt = attempt;
    const transaction: Transaction = {
      candidate: { ...handle },
      expected: { ...expected },
      part,
      lock,
      status: {
        transactionId,
        state: 'PREPARED',
        source: { ...expected },
        candidateId: handle.candidateId,
        generation: handle.generation,
        partId: part,
        sourceSHA: e.sourceSHA,
      },
    };
    this.transactions.set(transactionId, transaction);
    try {
      const value = this.preparedValue(e, expected, build);
      transaction.status = {
        ...transaction.status,
        state: 'APPLIED_PENDING_ADOPTION',
        handle: value.handle,
        recordId: value.recordId,
      };
      return value;
    } catch (cause) {
      this.abortCommit(transactionId);
      throw cause;
    }
  }
  private preparedValue<T>(
    e: Entry,
    expected: DocumentHandle,
    build: (d: GeometryDocument, s: SplitCandidateSummary) => T,
  ): { handle: DocumentHandle; recordId: string; value: T; summary: SplitCandidateSummary } {
    const handle = { documentId: expected.documentId, revision: expected.revision + 1 };
    return {
      handle,
      recordId: `${handle.documentId}/${e.handle.partId}@${String(expected.revision)}->${String(handle.revision)}#split`,
      value: build(e.document, e.summary),
      summary: e.summary,
    };
  }
  private checkTransactionSource(e: Entry, expected: DocumentHandle, part: PartId): void {
    if (
      expected.documentId !== e.handle.documentId ||
      expected.revision !== e.handle.sourceRevision ||
      part !== e.handle.partId
    )
      throw modelUnavailable('The split targets a different model revision or part.');
    const source = this.resident.resolve(expected),
      original = e.source.parts.find((p) => p.id === part);
    if (
      source !== e.source ||
      !original ||
      splitMeshSHA(original.mesh) !== e.sourceSHA ||
      candidateMeshSHA(e.document, e.summary.pieceAId, e.summary.pieceBId) !== e.candidateSHA
    )
      throw modelUnavailable('Prepared split authority changed. Preview the part again.');
  }
  public ackCommit(transactionId: string): SplitTransactionStatus {
    const t = this.transactions.get(transactionId);
    if (!t) throw modelUnavailable('Unknown split transaction.');
    if (t.status.state === 'FINALIZED') return this.transactionStatus(transactionId);
    if (t.status.state !== 'APPLIED_PENDING_ADOPTION')
      throw invalidState('Cannot acknowledge an aborted or unprepared transaction.');
    const e = this.require(t.candidate);
    this.checkTransactionSource(e, t.expected, t.part);
    this.resident.unlockMutation(t.expected.documentId, t.lock);
    delete e.lockedBy;
    try {
      const authorize = e.authorizeCommit;
      delete e.authorizeCommit; // consumed exactly once when this transaction acquired authority
      let result;
      try {
        result = this.commit(t.candidate, t.expected, t.part, () => undefined);
      } catch (cause) {
        if (authorize) e.authorizeCommit = authorize;
        throw cause;
      }
      t.status = {
        ...t.status,
        state: 'FINALIZED',
        handle: result.handle,
        recordId: result.recordId,
      };
      return this.transactionStatus(transactionId);
    } catch (cause) {
      // commit prepares all fallible geometry before its single resident swap.
      // If that did not happen, retain explicit recovery authority.
      if (this.resident.has(t.expected)) {
        this.resident.lockMutation(t.expected, t.lock);
        e.lockedBy = transactionId;
      }
      throw cause;
    }
  }
  public abortCommit(transactionId: string): SplitTransactionStatus {
    const t = this.transactions.get(transactionId);
    if (!t) throw modelUnavailable('Unknown split transaction.');
    if (t.status.state === 'ABORTED' || t.status.state === 'FINALIZED')
      return this.transactionStatus(transactionId);
    this.resident.unlockMutation(t.expected.documentId, t.lock);
    const e = this.candidates.get(t.candidate.candidateId);
    if (e?.lockedBy === transactionId) {
      delete e.lockedBy;
      this.discard(t.candidate); // abort consumes the Preview; recovery never depends on its reuse
    }
    t.status = { ...t.status, state: 'ABORTED', handle: { ...t.expected } };
    return this.transactionStatus(transactionId);
  }
  /** Only a caller that has observed a terminal receipt releases it. Lost ACKs
   * retain their receipt; unrelated edits cannot evict recovery authority. */
  public releaseCommitReceipt(transactionId: string): SplitTransactionStatus {
    const status = this.transactionStatus(transactionId);
    if (status.state !== 'FINALIZED' && status.state !== 'ABORTED')
      throw invalidState('Unresolved transaction cannot be released.');
    this.transactions.delete(transactionId);
    return status;
  }
  public discard(handle: SplitCandidateHandle): boolean {
    const released = this.discardById(handle.candidateId);
    if (released) this.lifecycle.invalidate(handle);
    return released;
  }
  /** Failure cleanup preserves the document's monotonic shared generation. */
  public fail(ticket: GeometryEditTicket): void {
    const active = this.active.get(ticket.documentId),
      entry = active === undefined ? undefined : this.candidates.get(active);
    if (active !== undefined && entry?.handle.generation === ticket.generation)
      this.discardById(active);
    this.lifecycle.invalidate(ticket);
  }
  public releaseDocument(id: DocumentId): void {
    this.resident.assertMutable(id);
    for (const [key, t] of this.transactions)
      if (t.expected.documentId === id) this.transactions.delete(key);
    const active = this.active.get(id);
    if (active) this.discardById(active);
    this.lifecycle.releaseDocument(id);
  }
  public stats(): { candidateCount: number; totalBytes: number } {
    let totalBytes = 0;
    for (const e of this.candidates.values()) totalBytes += e.summary.resources.canonicalBytes;
    return { candidateCount: this.candidates.size, totalBytes };
  }
  private require(h: SplitCandidateHandle): Entry {
    const e = this.candidates.get(h.candidateId);
    if (
      e?.handle.generation !== h.generation ||
      e.handle.documentId !== h.documentId ||
      e.handle.partId !== h.partId ||
      e.handle.sourceRevision !== h.sourceRevision ||
      !this.lifecycle.isCurrent(h)
    )
      throw modelUnavailable('This split candidate is stale or unavailable.');
    return e;
  }
  private discardById(id: string): boolean {
    const e = this.candidates.get(id);
    if (!e || e.lockedBy) return false;
    this.candidates.delete(id);
    if (this.active.get(e.handle.documentId) === id) this.active.delete(e.handle.documentId);
    return true;
  }
}
function uniquePartId(
  document: GeometryDocument,
  base: string,
  extra: Set<PartId> = new Set<PartId>(),
): PartId {
  const used = new Set<PartId>(document.parts.map((p) => p.id));
  for (const id of extra) used.add(id);
  for (let suffix = 0; suffix < 10000; suffix++) {
    const candidate = partId(suffix === 0 ? base : `${base}-${String(suffix + 1)}`);
    if (!used.has(candidate)) return candidate;
  }
  throw invalidState('Could not allocate stable identities for split pieces.');
}
