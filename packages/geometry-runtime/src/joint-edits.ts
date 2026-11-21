import {
  assertGeometryDocument,
  documentTriangleCount,
  documentVertexCount,
  jointAttachment,
  liveJoints,
  meshByteLength,
  retiredJoints,
  withPartMesh,
  type CanonicalMesh,
  type ConnectorJoint,
  type GeometryDocument,
  type JointConnectorSpec,
  type PartId,
} from '@cadfixer/mesh-core';
import {
  invalidState,
  isAppError,
  modelUnavailable,
  type CancellationToken,
} from '@cadfixer/shared';
import { analyseTopology } from '@cadfixer/mesh-topology';
import {
  jointSpecDigest,
  pinCutOfJoint,
  siteOnInterface,
  type JointRebuild,
} from './connector-rebuild';
import {
  validateGeometryEdit,
  type GeometryEditResourceAccounting,
  type GeometryEditStore,
  type GeometryEditTicket,
} from './geometry-edit';
import type { RepairHistoryStore } from './repair-history';
import { UndoableChangeKind } from './repair-history';
import {
  documentByteLength,
  isDocument,
  type DocumentHandle,
  type ResidentDocumentStore,
} from './resident-documents';

/**
 * EDITING A JOINT'S CONNECTORS AS A TRANSACTION (Stage EC-3).
 *
 * A joint edit is a CANDIDATE first and a document revision only when it is applied. `begin` resolves the joint the caller named,
 * proves it is still attached and still has the spec the caller saw, and takes a ticket on the document's one edit lifecycle, which
 * is what makes an edit, a split and every other candidate exclude one another: a newer ticket on a document invalidates the older
 * candidate before any asynchronous work can finish. `resolve` validates the rebuilt pieces and stores the candidate. `commit` is the
 * ONLY mutation.
 *
 * EVERY GUARD IS STATED BY THE CALLER AND READ AGAIN BY THE STORE. The caller says which document and revision, which joint and which
 * spec it saw; the store compares each with its own reading of the document, so a stale page cannot be made to apply an edit to a
 * joint that has changed under it, and a candidate cannot be committed against a document it was not built from. The joint named is
 * never read off the candidate (that would compare the candidate with itself).
 *
 * A REFUSED COMMIT CONSUMES NOTHING. The candidate stays resolved and retryable: consuming it on a transient race would destroy a
 * validated edit. It is consumed only after the document has been replaced.
 *
 * ATOMIC AS THE CALLER CAN OBSERVE IT. Everything fallible — the reply's render snapshot, descriptors and totals, the undo record —
 * is built BEFORE `ResidentDocumentStore.replace`, and nothing fallible follows it.
 *
 * DECIDED DIFFERENTLY FROM THE SPLIT. A split commit is a two-phase transaction because the page has to ADOPT a document with new
 * part ids, a new assembly and a new view, and can fail part way. An edit keeps every part id, name and placement, so there is
 * nothing to adopt but a revision; it commits in one step like a hole fill, and the worker dying between the swap and the reply is the
 * same boundary Policy A already covers (the page clears the model and says the session was lost).
 */

/** The codes, in `AppError.details.code`, that an edit refuses with. Tests assert these, never the sentences. */
export const JointEditRefusal = {
  /** No joint of that name in this revision of the document. */
  Unknown: 'JOINT_UNKNOWN',
  /** The joint exists only as a descriptor: its parts changed, so it can no longer be edited. */
  Retired: 'JOINT_RETIRED',
  /** The joint's connectors are not what the caller saw. */
  SpecStale: 'JOINT_SPEC_STALE',
  /** The edit would leave the joint exactly as it is. */
  NoChange: 'JOINT_EDIT_NO_CHANGE',
  /** The request names a pin the joint does not have, or names one twice. */
  UnknownPin: 'JOINT_EDIT_UNKNOWN_PIN',
} as const;
export type JointEditRefusal = (typeof JointEditRefusal)[keyof typeof JointEditRefusal];

export interface JointEditCandidateHandle extends GeometryEditTicket {
  readonly candidateId: string;
  readonly jointId: string;
}

/** What the page is told an edit does, in terms of pins and the pieces' size. No geometry. */
export interface JointEditSummary {
  readonly candidate: JointEditCandidateHandle;
  readonly jointId: string;
  readonly specDigestBefore: string;
  readonly specDigestAfter: string;
  readonly resources: GeometryEditResourceAccounting;
  readonly triangleCountBefore: number;
  readonly triangleCountAfter: number;
}

/** The edit in the vocabulary of the page: numbers it can state, never a point or a mesh. */
export type JointEditRequest =
  | {
      readonly kind: 'SET_CONNECTORS';
      readonly maleSide: 'A' | 'B';
      /** One size for every pin of the joint, in millimetres. */
      readonly diameterMm: number;
      readonly depthMm: number;
      readonly clearanceMm: number;
      /** The pins the joint is to have. A pin that names an existing `pinId` keeps that name; one that names none is new. */
      readonly pins: readonly { readonly pinId?: string; readonly u: number; readonly v: number }[];
    }
  | { readonly kind: 'REMOVE_CONNECTORS' };

/**
 * The spec a request describes, built against the joint's own cut.
 *
 * A pin that keeps its name AND its position keeps its site object, so an edit that changes only a size or the male side reproduces
 * every untouched pin's point to the bit. A pin that moves, or is new, is placed with `siteOnInterface`. New pins are named from the
 * joint's `nextPinOrdinal`, which only ever grows.
 */
export function specFromEdit(
  joint: ConnectorJoint,
  edit: JointEditRequest,
): { readonly spec: JointConnectorSpec | undefined; readonly nextPinOrdinal: number } {
  if (edit.kind === 'REMOVE_CONNECTORS') {
    if (joint.connector === undefined)
      throw invalidState('This joint has no connectors to remove.', {
        code: JointEditRefusal.NoChange,
      });
    return { spec: undefined, nextPinOrdinal: joint.nextPinOrdinal };
  }
  const cut = pinCutOfJoint(joint);
  const existing = new Map((joint.connector?.elements ?? []).map((pin) => [pin.pinId, pin]));
  const used = new Set<string>();
  let ordinal = joint.nextPinOrdinal;
  const elements = edit.pins.map((requested) => {
    const keeps = requested.pinId !== undefined;
    if (requested.pinId !== undefined) {
      if (!existing.has(requested.pinId) || used.has(requested.pinId))
        throw invalidState('That connector is not one this joint has.', {
          code: JointEditRefusal.UnknownPin,
        });
      used.add(requested.pinId);
    }
    const before = requested.pinId === undefined ? undefined : existing.get(requested.pinId);
    const pinId = requested.pinId ?? `pin-${String(ordinal++)}`;
    const site =
      keeps &&
      before !== undefined &&
      Object.is(before.site.u, requested.u) &&
      Object.is(before.site.v, requested.v)
        ? before.site
        : siteOnInterface(cut, requested.u, requested.v);
    return Object.freeze({
      pinId,
      site,
      diameterMm: edit.diameterMm,
      depthMm: edit.depthMm,
      clearanceMm: edit.clearanceMm,
    });
  });
  return {
    spec: Object.freeze({
      policy: 'units-v2',
      kind: 'pin',
      maleSide: edit.maleSide,
      elements: Object.freeze(elements),
    }),
    nextPinOrdinal: ordinal,
  };
}

/** True when the spec a request describes is the joint's own, to the bit. */
export function sameSpec(
  a: JointConnectorSpec | undefined,
  b: JointConnectorSpec | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.maleSide !== b.maleSide || a.elements.length !== b.elements.length) return false;
  return a.elements.every((pin, index) => {
    const other = b.elements[index];
    if (other === undefined) return false;
    return (
      pin.pinId === other.pinId &&
      Object.is(pin.diameterMm, other.diameterMm) &&
      Object.is(pin.depthMm, other.depthMm) &&
      Object.is(pin.clearanceMm, other.clearanceMm) &&
      Object.is(pin.site.u, other.site.u) &&
      Object.is(pin.site.v, other.site.v)
    );
  });
}

interface Entry {
  readonly handle: JointEditCandidateHandle;
  readonly source: GeometryDocument;
  /** The joint as the source held it, by reference: the store's own reading at commit is compared with THIS object. */
  readonly sourceJoint: ConnectorJoint;
  readonly document: GeometryDocument;
  readonly summary: JointEditSummary;
}

/** The session `begin` hands back: what an edit is built from. */
export interface JointEditSession {
  readonly ticket: GeometryEditTicket;
  readonly joint: ConnectorJoint;
  readonly document: GeometryDocument;
}

export class JointEditStore {
  private readonly candidates = new Map<string, Entry>();
  private readonly active = new Map<string, string>();
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

  /**
   * Starts an edit of one joint. Refuses an unknown or retired joint and a joint whose connectors are not what the caller saw,
   * each with its own code; takes the document's edit ticket, which invalidates any other candidate on it.
   */
  public begin(
    source: DocumentHandle,
    jointId: string,
    expectedSpecDigest: string,
  ): JointEditSession {
    this.resident.assertMutable(source.documentId);
    const document = this.resident.resolve(source);
    if (!isDocument(document)) throw document;
    const joint = liveJoints(document).find((candidate) => candidate.jointId === jointId);
    if (joint === undefined) {
      const retired = retiredJoints(document).find((record) => record.jointId === jointId);
      if (retired !== undefined)
        throw invalidState('The connectors of this joint can no longer be edited.', {
          code: JointEditRefusal.Retired,
          reason: retired.reason,
        });
      throw modelUnavailable('That joint is not in this version of the model.', {
        code: JointEditRefusal.Unknown,
      });
    }
    const attachment = jointAttachment(document, joint);
    if (!attachment.attached)
      throw invalidState('The connectors of this joint can no longer be edited.', {
        code: JointEditRefusal.Retired,
        reason: attachment.reason,
      });
    if (jointSpecDigest(joint) !== expectedSpecDigest)
      throw invalidState('The connectors of this joint are not what was last shown.', {
        code: JointEditRefusal.SpecStale,
      });
    const old = this.active.get(source.documentId);
    if (old !== undefined) this.discardById(old);
    const ticket = this.lifecycle.begin(source, joint.a.partId, 'joint-edit');
    return { ticket, joint, document };
  }

  /**
   * Stores the candidate a rebuild produced, after the same gates a split's pieces pass: structure, resource ceilings, degenerate
   * faces (against what the base pieces already carried, since a cut of a defective model keeps its defects), and the document gate.
   */
  public resolve(
    session: JointEditSession,
    rebuilt: JointRebuild,
    cancellation: CancellationToken,
  ): JointEditSummary {
    const { ticket, joint } = session;
    if (!this.lifecycle.isCurrent(ticket))
      throw modelUnavailable('A newer edit superseded this result.');
    const sourceHandle: DocumentHandle = {
      documentId: ticket.documentId,
      revision: ticket.sourceRevision,
    };
    const source = this.resident.resolve(sourceHandle);
    if (!isDocument(source)) throw source;
    if (liveJoints(source).find((candidate) => candidate.jointId === joint.jointId) !== joint)
      throw modelUnavailable('The joint changed while the edit was being built.');
    const allowance = (
      mesh: CanonicalMesh,
      partId: PartId,
    ): { zeroAreaFaceCount: number; repeatedPositionFaceCount: number } => {
      const report = analyseTopology(mesh, {
        documentId: 'joint-edit',
        documentRevision: ticket.sourceRevision,
        partId,
        cancellation,
        sampleLimit: 0,
        componentSummaryLimit: 1,
      }).report;
      return {
        zeroAreaFaceCount: report.zeroAreaFaceCount,
        repeatedPositionFaceCount: report.repeatedPositionFaceCount,
      };
    };
    const baseA = allowance(joint.a.baseMesh, joint.a.partId);
    const baseB = allowance(joint.b.baseMesh, joint.b.partId);
    const aValidation = validateGeometryEdit(
      rebuilt.pieceA,
      source,
      joint.a.partId,
      undefined,
      cancellation,
      baseA,
    );
    const bValidation = validateGeometryEdit(
      rebuilt.pieceB,
      source,
      joint.b.partId,
      undefined,
      cancellation,
      baseB,
    );
    if (
      aValidation.topology.zeroAreaFaceCount + bValidation.topology.zeroAreaFaceCount >
        baseA.zeroAreaFaceCount + baseB.zeroAreaFaceCount ||
      aValidation.topology.repeatedPositionFaceCount +
        bValidation.topology.repeatedPositionFaceCount >
        baseA.repeatedPositionFaceCount + baseB.repeatedPositionFaceCount
    )
      throw invalidState('This edit introduced degenerate faces.');
    const withA = withPartMesh(source, joint.a.partId, rebuilt.pieceA);
    const withBoth =
      withA === undefined ? undefined : withPartMesh(withA, joint.b.partId, rebuilt.pieceB);
    if (withBoth === undefined)
      throw modelUnavailable('A part of this joint is no longer present.');
    const document: GeometryDocument = {
      ...withBoth,
      joints: (source.joints ?? []).map((record) =>
        record.kind === 'joint' && record.jointId === joint.jointId ? rebuilt.successor : record,
      ),
    };
    // The two pieces were validated above and every other mesh was validated when it entered, so the document gate does not walk
    // them again; everything about the document and its joints is checked.
    assertGeometryDocument(document, 'joint edit', { validateMeshes: false });
    if (!this.lifecycle.isCurrent(ticket) || !this.resident.has(sourceHandle))
      throw modelUnavailable('The edit became stale during validation.');
    const handle: JointEditCandidateHandle = {
      ...ticket,
      candidateId: `joint-edit-candidate-${String(this.nextId++)}`,
      jointId: joint.jointId,
    };
    const canonicalBytes = meshByteLength(rebuilt.pieceA) + meshByteLength(rebuilt.pieceB);
    const resources: GeometryEditResourceAccounting = {
      triangles: documentTriangleCount(document),
      vertices: documentVertexCount(document),
      canonicalBytes,
      renderBytes: aValidation.resources.renderBytes + bValidation.resources.renderBytes,
      estimatedPeakBytes:
        documentByteLength(source) +
        canonicalBytes +
        aValidation.resources.renderBytes +
        bValidation.resources.renderBytes,
    };
    const summary: JointEditSummary = {
      candidate: handle,
      jointId: joint.jointId,
      specDigestBefore: jointSpecDigest(joint),
      specDigestAfter: jointSpecDigest(rebuilt.successor),
      resources,
      triangleCountBefore: documentTriangleCount(source),
      triangleCountAfter: documentTriangleCount(document),
    };
    this.candidates.set(handle.candidateId, {
      handle,
      source,
      sourceJoint: joint,
      document,
      summary,
    });
    this.active.set(ticket.documentId, handle.candidateId);
    return summary;
  }

  /** A disposable view of the candidate's document, built by the caller. Nothing about the candidate changes. */
  public preview<T>(
    handle: JointEditCandidateHandle,
    build: (document: GeometryDocument, summary: JointEditSummary) => T,
  ): T {
    const entry = this.requireReady(handle);
    return build(entry.document, entry.summary);
  }

  /**
   * THE ONLY MUTATION. Guards first, then every fallible output, then the swap.
   *
   * `expectedSource`, `expectedJointId` and `expectedSpecDigest` are the caller's, and each is compared with the store's own reading
   * of the document. The candidate stays resolved unless the document was replaced.
   */
  public commit<T>(
    handle: JointEditCandidateHandle,
    expected: DocumentHandle,
    expectedJointId: string,
    expectedSpecDigest: string,
    build: (document: GeometryDocument, summary: JointEditSummary) => T,
  ): { handle: DocumentHandle; recordId: string; value: T; summary: JointEditSummary } {
    const entry = this.requireReady(handle);
    if (
      expected.documentId !== handle.documentId ||
      expected.revision !== handle.sourceRevision ||
      expectedJointId !== handle.jointId
    )
      throw modelUnavailable('The edit targets a different model revision or joint.');
    const source = this.resident.resolve(expected);
    if (!isDocument(source)) throw source;
    const joint = liveJoints(source).find((candidate) => candidate.jointId === expectedJointId);
    if (joint === undefined || joint !== entry.sourceJoint)
      throw modelUnavailable('The joint is no longer the one this edit was built from.');
    if (!jointAttachment(source, joint).attached)
      throw invalidState('The connectors of this joint can no longer be edited.', {
        code: JointEditRefusal.Retired,
      });
    const current = jointSpecDigest(joint);
    if (current !== expectedSpecDigest || current !== entry.summary.specDigestBefore)
      throw invalidState('The connectors of this joint are not what was last shown.', {
        code: JointEditRefusal.SpecStale,
      });
    assertGeometryDocument(entry.document, 'joint edit', { validateMeshes: false });
    const partA = source.parts.find((part) => part.id === joint.a.partId);
    if (partA === undefined) throw modelUnavailable('A part of this joint is no longer present.');

    const value = build(entry.document, entry.summary);
    const next: DocumentHandle = {
      documentId: expected.documentId,
      revision: expected.revision + 1,
    };
    const recordId = `${next.documentId}/${joint.jointId}@${String(expected.revision)}->${String(next.revision)}#joint-edit`;
    const restoreHistory = this.history.checkpoint();
    try {
      this.history.record({
        recordId,
        kind: UndoableChangeKind.GeometryEdit,
        source: expected,
        part: joint.a.partId,
        result: next,
        appliedOperations: [],
        planHash: 'joint-edit',
        inverse: {
          previousMesh: partA.mesh,
          sourceFaceCount: partA.mesh.indices.length / 3,
          sourceIndexCount: partA.mesh.indices.length,
          previousDocument: source,
          byteLength: documentByteLength(source),
        },
      });
      const installed = this.resident.replace(expected, entry.document);
      if (isAppError(installed)) throw installed;
    } catch (cause) {
      restoreHistory();
      throw cause;
    }
    this.candidates.delete(handle.candidateId);
    this.active.delete(handle.documentId);
    return { handle: next, recordId, value, summary: entry.summary };
  }

  /** A failed build: drops this ticket's candidate if one was stored, and releases the document's edit ticket. */
  public fail(ticket: GeometryEditTicket): void {
    const active = this.active.get(ticket.documentId);
    const entry = active === undefined ? undefined : this.candidates.get(active);
    if (active !== undefined && entry?.handle.generation === ticket.generation)
      this.discardById(active);
    this.lifecycle.invalidate(ticket);
  }

  public discard(handle: JointEditCandidateHandle): boolean {
    return this.discardById(handle.candidateId);
  }

  public releaseDocument(documentId: string): void {
    const old = this.active.get(documentId);
    if (old !== undefined) this.discardById(old);
  }

  public stats(): { readonly candidateCount: number } {
    return { candidateCount: this.candidates.size };
  }

  private requireReady(handle: JointEditCandidateHandle): Entry {
    const unavailable = (): Error =>
      modelUnavailable('This edit candidate is stale or unavailable.');
    const entry = this.candidates.get(handle.candidateId);
    if (entry === undefined) throw unavailable();
    if (
      entry.handle.generation !== handle.generation ||
      entry.handle.documentId !== handle.documentId ||
      entry.handle.sourceRevision !== handle.sourceRevision ||
      entry.handle.jointId !== handle.jointId ||
      !this.lifecycle.isCurrent(handle)
    )
      throw unavailable();
    return entry;
  }

  private discardById(id: string): boolean {
    const entry = this.candidates.get(id);
    if (entry === undefined) return false;
    this.candidates.delete(id);
    if (this.active.get(entry.handle.documentId) === id)
      this.active.delete(entry.handle.documentId);
    return true;
  }
}
