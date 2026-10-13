import {
  assertGeometryDocument,
  documentTriangleCount,
  documentVertexCount,
  meshByteLength,
  partId,
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
import type { SplitResult } from './split-connectors';

export interface SplitCandidateHandle extends GeometryEditTicket {
  readonly candidateId: string;
}
export interface SplitCandidateSummary {
  readonly candidate: SplitCandidateHandle;
  readonly pieceAId: PartId;
  readonly pieceBId: PartId;
  readonly resources: GeometryEditResourceAccounting;
  readonly metrics: SplitResult['metrics'];
  readonly connector: SplitResult['connector'];
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
  readonly handle: SplitCandidateHandle;
  readonly document: GeometryDocument;
  readonly summary: SplitCandidateSummary;
}

/** Two-piece specialization of the Stage 7 worker-resident candidate transaction. */
export class SplitCandidateStore {
  private readonly candidates = new Map<string, Entry>();
  private readonly active = new Map<DocumentId, string>();
  private nextId = 1;
  private readonly resident: ResidentDocumentStore;
  private readonly history: RepairHistoryStore;
  private readonly lifecycle: GeometryEditStore;
  public constructor(
    resident: ResidentDocumentStore,
    history: RepairHistoryStore,
    lifecycle: GeometryEditStore,
  ) {
    this.resident = resident;
    this.history = history;
    this.lifecycle = lifecycle;
  }
  public begin(source: DocumentHandle, sourcePart: PartId): GeometryEditTicket {
    const old = this.active.get(source.documentId);
    if (old) this.discardById(old);
    return this.lifecycle.begin(source, sourcePart, 'split');
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
    const aId = uniquePartId(source, `${ticket.partId}-A`),
      bId = uniquePartId(source, `${ticket.partId}-B`, new Set([aId]));
    const a: GeometryPart = {
        ...original,
        id: aId,
        mesh: result.pieceA,
        name: `${original.name ?? 'Part'} A`,
      },
      b: GeometryPart = {
        ...original,
        id: bId,
        mesh: result.pieceB,
        name: `${original.name ?? 'Part'} B`,
      };
    const parts = source.parts.slice();
    parts.splice(index, 1, a, b);
    const document: GeometryDocument = { ...source, parts };
    assertGeometryDocument(document, 'split candidate');
    if (!this.lifecycle.isCurrent(ticket))
      throw modelUnavailable('The split became stale during validation.');
    const handle: SplitCandidateHandle = {
      ...ticket,
      candidateId: `split-candidate-${String(this.nextId++)}`,
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
      section: {
        area: result.cutA.area,
        loopCount: result.cutA.loopCount,
        outline: result.cutA.outline,
        outlineTruncated: result.cutA.outlineTruncated,
      },
    };
    this.candidates.set(handle.candidateId, { handle, document, summary });
    this.active.set(ticket.documentId, handle.candidateId);
    return summary;
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
      next = this.resident.replace(expected, e.document);
    if (isAppError(next)) throw next;
    this.candidates.delete(handle.candidateId);
    this.active.delete(handle.documentId);
    const recordId = `${next.documentId}/${expectedPart}@${String(expected.revision)}->${String(next.revision)}#split`;
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
    return { handle: next, recordId, value, summary: e.summary };
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
    if (!e) return false;
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
