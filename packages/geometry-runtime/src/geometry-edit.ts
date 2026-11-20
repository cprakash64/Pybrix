/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/restrict-template-expressions, @typescript-eslint/prefer-optional-chain */
import {
  assertGeometryDocument,
  assertMeshStructure,
  DEFAULT_DOCUMENT_LIMITS,
  documentTriangleCount,
  documentVertexCount,
  jointRetainedBytes,
  meshByteLength,
  retireDetachedJoints,
  retiredByInstall,
  triangleCount,
  vertexCount,
  withPartMesh,
  type CanonicalMesh,
  type GeometryDocument,
  type PartId,
} from '@cadfixer/mesh-core';
import {
  invalidState,
  isAppError,
  modelUnavailable,
  resourceLimitExceeded,
} from '@cadfixer/shared';
import { throwIfCancelled, uncancellable, type CancellationToken } from '@cadfixer/shared';
import {
  analyseTopology,
  estimateTopologyWorkspaceBytes,
  type TopologyReport,
} from '@cadfixer/mesh-topology';
import {
  documentByteLength,
  isDocument,
  type DocumentHandle,
  type DocumentId,
  type ResidentDocumentStore,
} from './resident-documents';
import type { RepairHistoryStore } from './repair-history';
import { UndoableChangeKind } from './repair-history';

/** Stage 7A edits are scoped to one immutable part mesh and one document revision. */
export interface GeometryEditTicket {
  readonly documentId: DocumentId;
  readonly sourceRevision: number;
  readonly partId: PartId;
  readonly operation: string;
  readonly generation: number;
}
export interface GeometryEditCandidateHandle extends GeometryEditTicket {
  readonly candidateId: string;
}
export interface GeometryEditResourceAccounting {
  readonly triangles: number;
  readonly vertices: number;
  readonly canonicalBytes: number;
  readonly renderBytes: number;
  readonly estimatedPeakBytes: number;
}
export interface GeometryEditCandidateSummary {
  readonly candidate: GeometryEditCandidateHandle;
  readonly resources: GeometryEditResourceAccounting;
  readonly topology: TopologyReport;
}
export interface GeometryEditCommitResult<T> {
  readonly handle: DocumentHandle;
  readonly partId: PartId;
  readonly render: T;
  readonly recordId: string;
  readonly resources: GeometryEditResourceAccounting;
}
export interface GeometryEditLimits {
  readonly maxTriangles: number;
  readonly maxVertices: number;
  readonly maxCanonicalBytes: number;
  readonly maxPreviewSnapshotBytes: number;
  readonly maxEstimatedPeakBytes: number;
}
export const DEFAULT_GEOMETRY_EDIT_LIMITS: GeometryEditLimits = {
  maxTriangles: 5_000_000,
  maxVertices: 15_000_000,
  maxCanonicalBytes: 384 * 1024 * 1024,
  maxPreviewSnapshotBytes: 384 * 1024 * 1024,
  maxEstimatedPeakBytes: 1024 * 1024 * 1024,
};
interface Entry {
  readonly handle: GeometryEditCandidateHandle;
  mesh: CanonicalMesh;
  readonly resources: GeometryEditResourceAccounting;
  readonly topology: TopologyReport;
}
const same = (a: DocumentHandle, b: DocumentHandle) =>
  a.documentId === b.documentId && a.revision === b.revision;
function gate(metric: string, observed: number, limit: number): void {
  if (!Number.isFinite(observed) || observed > limit)
    throw resourceLimitExceeded(`Geometry edit ${metric} is ${observed}; limit is ${limit}.`, {
      metric,
      observed,
      limit,
    });
}
/** Shared post-edit gate, run before a candidate can be previewed or committed. */
export function validateGeometryEdit(
  mesh: CanonicalMesh,
  source: GeometryDocument,
  part: PartId,
  limits: GeometryEditLimits = DEFAULT_GEOMETRY_EDIT_LIMITS,
  cancellation: CancellationToken = uncancellable,
  preservedSourceDefects?: Pick<TopologyReport, 'zeroAreaFaceCount' | 'repeatedPositionFaceCount'>,
): {
  document: GeometryDocument;
  resources: GeometryEditResourceAccounting;
  topology: TopologyReport;
} {
  throwIfCancelled(cancellation);
  assertMeshStructure(mesh, 'geometry/edit');
  const triangles = triangleCount(mesh),
    vertices = vertexCount(mesh),
    canonicalBytes = meshByteLength(mesh),
    renderBytes = triangles * 3 * 3 * 4 * 2;
  // The estimate counts resident source + candidate + expanded render + a
  // bounded validation workspace. It is an allocation gate, not process RSS.
  const estimatedPeakBytes =
    documentByteLength(source) +
    canonicalBytes +
    renderBytes +
    Math.max(canonicalBytes, triangles * 24);
  gate('triangle count', triangles, limits.maxTriangles);
  gate('vertex count', vertices, limits.maxVertices);
  gate('canonical bytes', canonicalBytes, limits.maxCanonicalBytes);
  gate('render snapshot bytes', renderBytes, limits.maxPreviewSnapshotBytes);
  gate('estimated peak bytes', estimatedPeakBytes, limits.maxEstimatedPeakBytes);
  const topologyWorkspaceBytes = estimateTopologyWorkspaceBytes(triangles, mesh.indices.length);
  gate('topology workspace bytes', topologyWorkspaceBytes, limits.maxEstimatedPeakBytes);
  const topology = analyseTopology(mesh, {
    documentId: 'geometry-edit',
    documentRevision: 0,
    partId: part,
    cancellation,
    sampleLimit: 0,
    componentSummaryLimit: 1,
  }).report;
  if (
    topology.zeroAreaFaceCount > (preservedSourceDefects?.zeroAreaFaceCount ?? 0) ||
    topology.repeatedPositionFaceCount > (preservedSourceDefects?.repeatedPositionFaceCount ?? 0)
  )
    throw invalidState('Geometry edit candidate contains degenerate faces.', {
      zeroAreaFaces: topology.zeroAreaFaceCount,
      repeatedPositionFaces: topology.repeatedPositionFaceCount,
    });
  throwIfCancelled(cancellation);
  const document = withPartMesh(source, part, mesh);
  if (document === undefined)
    throw modelUnavailable('The selected part is no longer in this document.', { partId: part });
  assertGeometryDocument(document, 'geometry/edit', { validateMeshes: false });
  gate(
    'document triangles',
    documentTriangleCount(document),
    DEFAULT_DOCUMENT_LIMITS.maxTotalTriangles,
  );
  gate(
    'document vertices',
    documentVertexCount(document),
    DEFAULT_DOCUMENT_LIMITS.maxTotalVertices,
  );
  return {
    document,
    resources: { triangles, vertices, canonicalBytes, renderBytes, estimatedPeakBytes },
    topology,
  };
}

/** Worker-resident candidate lifecycle. No canonical geometry crosses the page. */
export class GeometryEditStore {
  private readonly candidates = new Map<string, Entry>();
  private readonly current = new Map<DocumentId, number>();
  private readonly active = new Map<DocumentId, string>();
  private nextId = 1;
  private readonly resident: ResidentDocumentStore;
  private readonly history: RepairHistoryStore;
  public constructor(resident: ResidentDocumentStore, history: RepairHistoryStore) {
    this.resident = resident;
    this.history = history;
  }
  /** Start invalidates a prior candidate before asynchronous work can finish. */
  public begin(source: DocumentHandle, partId: PartId, operation: string): GeometryEditTicket {
    this.resident.assertMutable(source.documentId);
    const part = this.resident.resolvePart(source, partId);
    if (isAppError(part)) throw part;
    if (!operation || operation.length > 80)
      throw invalidState('Geometry edit operation name is invalid.');
    const old = this.active.get(source.documentId);
    if (old) this.discardById(old);
    const generation = (this.current.get(source.documentId) ?? 0) + 1;
    this.current.set(source.documentId, generation);
    return {
      documentId: source.documentId,
      sourceRevision: source.revision,
      partId,
      operation,
      generation,
    };
  }
  /** A late A result is refused if B was requested, even before B finishes. */
  public resolve(
    ticket: GeometryEditTicket,
    mesh: CanonicalMesh,
    limits?: GeometryEditLimits,
    cancellation: CancellationToken = uncancellable,
  ): GeometryEditCandidateSummary {
    const source: DocumentHandle = {
      documentId: ticket.documentId,
      revision: ticket.sourceRevision,
    };
    if (this.current.get(ticket.documentId) !== ticket.generation)
      throw modelUnavailable('A newer geometry edit superseded this result.');
    const document = this.resident.resolve(source);
    if (!isDocument(document)) throw document;
    const { resources, topology } = validateGeometryEdit(
      mesh,
      document,
      ticket.partId,
      limits,
      cancellation,
    );
    if (this.current.get(ticket.documentId) !== ticket.generation || !this.resident.has(source))
      throw modelUnavailable('The geometry edit became stale during validation.');
    const handle: GeometryEditCandidateHandle = {
      ...ticket,
      candidateId: `edit-candidate-${this.nextId++}`,
    };
    this.candidates.set(handle.candidateId, { handle, mesh, resources, topology });
    this.active.set(ticket.documentId, handle.candidateId);
    return { candidate: handle, resources, topology };
  }
  public preview<T>(candidate: GeometryEditCandidateHandle, build: (mesh: CanonicalMesh) => T): T {
    const entry = this.requireReady(candidate);
    return build(entry.mesh);
  }
  /** All fallible work, including the render snapshot, precedes the atomic swap. */
  public commit<T>(
    candidate: GeometryEditCandidateHandle,
    expected: DocumentHandle,
    expectedPart: PartId,
    build: (mesh: CanonicalMesh, document: GeometryDocument) => T,
  ): GeometryEditCommitResult<T> {
    const entry = this.requireReady(candidate);
    if (
      !same(expected, { documentId: candidate.documentId, revision: candidate.sourceRevision }) ||
      expectedPart !== candidate.partId
    )
      throw modelUnavailable('The edit targets a different model revision or part.');
    const source = this.resident.resolve(expected);
    if (!isDocument(source)) throw source;
    const prior = source.parts.find((p) => p.id === expectedPart);
    if (!prior) throw modelUnavailable('The selected part is no longer present.');
    // Retire before reporting (Stage EC-3): a joint over the part this edit replaces is retired when the store installs the document,
    // so what `build` reports is the document as it will be held. The store retires again at the same revision and finds nothing.
    const document = retireDetachedJoints(
      validateGeometryEdit(entry.mesh, source, expectedPart).document,
      expected.revision + 1,
    );
    const render = build(entry.mesh, document);
    const previousMesh = prior.mesh;
    const inverse = {
      previousMesh,
      sourceFaceCount: triangleCount(previousMesh),
      sourceIndexCount: previousMesh.indices.length,
      byteLength: meshByteLength(previousMesh),
      // A change that retires a joint keeps the document it came from, so Undo can bring the joint back (Stage EC-3).
      ...(retiredByInstall(source, document) > 0
        ? {
            previousDocument: source,
            byteLength: meshByteLength(previousMesh) + jointRetainedBytes(source),
          }
        : {}),
    };
    const next = this.resident.replace(expected, document);
    if (isAppError(next)) throw next;
    this.candidates.delete(candidate.candidateId);
    this.active.delete(candidate.documentId);
    const recordId = `${next.documentId}/${expectedPart}@${expected.revision}->${next.revision}#${candidate.operation}`;
    this.history.record({
      recordId,
      kind: UndoableChangeKind.GeometryEdit,
      source: expected,
      part: expectedPart,
      result: next,
      appliedOperations: [],
      planHash: candidate.operation,
      inverse,
    });
    return { handle: next, partId: expectedPart, render, recordId, resources: entry.resources };
  }
  public discard(candidate: GeometryEditCandidateHandle): boolean {
    return this.discardById(candidate.candidateId);
  }
  /** Shared currency check for multi-output specializations such as Split. */
  public isCurrent(ticket: GeometryEditTicket): boolean {
    return (
      this.current.get(ticket.documentId) === ticket.generation &&
      this.resident.has({ documentId: ticket.documentId, revision: ticket.sourceRevision })
    );
  }
  /** Invalidate this operation only when it is still the latest request. */
  public invalidate(ticket: GeometryEditTicket): void {
    if (this.current.get(ticket.documentId) !== ticket.generation) return;
    const active = this.active.get(ticket.documentId);
    if (active) this.discardById(active);
    this.current.set(ticket.documentId, ticket.generation + 1);
  }
  public releaseDocument(documentId: DocumentId): void {
    const active = this.active.get(documentId);
    if (active) this.discardById(active);
    this.current.delete(documentId);
  }
  public stats(): { candidateCount: number; totalBytes: number } {
    let totalBytes = 0,
      candidateCount = 0;
    for (const e of this.candidates.values()) {
      candidateCount++;
      totalBytes += e.resources.canonicalBytes;
    }
    return { candidateCount, totalBytes };
  }
  private requireReady(handle: GeometryEditCandidateHandle): Entry {
    const entry = this.candidates.get(handle.candidateId);
    if (
      !entry ||
      entry.handle.generation !== handle.generation ||
      entry.handle.documentId !== handle.documentId ||
      entry.handle.partId !== handle.partId ||
      entry.handle.sourceRevision !== handle.sourceRevision ||
      entry.handle.operation !== handle.operation ||
      this.current.get(handle.documentId) !== handle.generation ||
      !this.resident.has({ documentId: handle.documentId, revision: handle.sourceRevision })
    )
      throw modelUnavailable('This geometry edit candidate is stale or unavailable.');
    return entry;
  }
  private discardById(id: string): boolean {
    const e = this.candidates.get(id);
    if (!e) return false;
    this.candidates.delete(id);
    if (this.active.get(e.handle.documentId) === id) this.active.delete(e.handle.documentId);
    return true;
  }
}
