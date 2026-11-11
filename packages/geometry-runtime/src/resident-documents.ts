import { invalidState, modelUnavailable, type AppError } from '@cadfixer/shared';
import { distinctMeshes, findPart, meshByteLength } from '@cadfixer/mesh-core';
import type { GeometryDocument, GeometryPart, PartId } from '@cadfixer/mesh-core';

/**
 * The worker's registry of authoritative geometry.
 *
 * WHY THIS EXISTS. Stage 1 transferred the canonical mesh to the main thread as
 * soon as it was parsed, which made the UI the owner of the geometry. Every
 * later operation then had to send it back: export structured-cloned ~96 MiB
 * into the worker for a 2M-triangle model, and diagnostics, repair, booleans and
 * hollowing would each have paid the same toll. Ownership now stays where the
 * work happens.
 *
 * The main thread holds a `DocumentHandle` — an id and a revision — plus render
 * snapshots. It never holds the authoritative document.
 *
 * WHAT CHANGED IN STAGE 4A-2A. The unit of authority is a `GeometryDocument`
 * rather than a single `CanonicalMesh`. A one-part STL document behaves exactly
 * as the single mesh did; a multi-part document is the same transaction with
 * more parts inside it. Nothing about identity, revisions or staleness changed,
 * which was the point: see docs/adr/0013.
 *
 * ONE REVISION PER DOCUMENT, and it lives here rather than on the document
 * object. A `revision` field inside `GeometryDocument` would be a second
 * authority that could disagree with this one, and every staleness guard in the
 * product is built on there being exactly one.
 *
 * REVISIONS EXIST TO MAKE STALE OPERATIONS FAIL LOUDLY. An operation dispatched
 * against revision 3 must not silently apply to revision 4 after the document
 * has been replaced underneath it. Every geometry operation names the revision
 * it expects, and a mismatch is an error rather than a surprise. A change to ANY
 * part consumes the document's revision, so a result computed for part A is
 * invalidated by an edit to part B. That is deliberate over-invalidation: an
 * over-invalidated result is recomputed, whereas an under-invalidated one is
 * applied to geometry it was not built from.
 *
 * This module is deliberately platform-free: no DOM, no worker globals. It is
 * the worker's state, but it is testable as a plain object.
 */

declare const documentIdBrand: unique symbol;

export type DocumentId = string & { readonly [documentIdBrand]: true };

export interface DocumentHandle {
  readonly documentId: DocumentId;
  /**
   * Increments whenever the document behind `documentId` is replaced.
   *
   * ONE counter for the whole document, never one per part. See the module
   * comment for why per-part revisions were rejected.
   */
  readonly revision: number;
}

interface ResidentEntry {
  readonly document: GeometryDocument;
  readonly revision: number;
  /** Bytes of authoritative geometry held for this document. */
  readonly byteLength: number;
}

export interface ResidentDocumentStats {
  readonly documentCount: number;
  readonly totalBytes: number;
  readonly partCount: number;
}

/**
 * Bytes of DISTINCT geometry a document holds.
 *
 * Counted once per mesh OBJECT, not once per part. A document with a thousand
 * placements of one 3MF component holds one mesh; charging it for a thousand
 * would make the resident budget refuse documents that fit comfortably, and
 * would report a memory figure the process does not actually occupy.
 */
export function documentByteLength(document: GeometryDocument): number {
  let bytes = 0;
  for (const mesh of distinctMeshes(document)) bytes += meshByteLength(mesh);
  return bytes;
}

/** Narrows the store's union return without an assertion. */
export function isDocument(value: GeometryDocument | AppError): value is GeometryDocument {
  return 'parts' in value;
}

/** Narrows `resolvePart`'s union return without an assertion. */
export function isPart(value: GeometryPart | AppError): value is GeometryPart {
  return 'mesh' in value;
}

export class ResidentDocumentStore {
  private readonly documents = new Map<DocumentId, ResidentEntry>();
  private nextId = 1;
  private readonly mutationLocks = new Map<DocumentId, object>();
  public assertMutable(id: DocumentId): void {
    if (this.mutationLocks.has(id)) throw invalidState('A split transaction is awaiting adoption.');
  }
  public lockMutation(handle: DocumentHandle, owner: object): void {
    this.assertMutable(handle.documentId);
    const source = this.resolve(handle);
    if (!isDocument(source)) throw source;
    this.mutationLocks.set(handle.documentId, owner);
  }
  public unlockMutation(id: DocumentId, owner: object): void {
    if (this.mutationLocks.get(id) !== owner)
      throw invalidState('Transaction lock does not match.');
    this.mutationLocks.delete(id);
  }

  /**
   * Takes ownership of a document and returns its handle.
   *
   * The caller must not retain a reference to the document afterwards; the
   * store is the owner from this point.
   */
  public commit(document: GeometryDocument): DocumentHandle {
    if (this.mutationLocks.size)
      throw invalidState('Resolve the pending split before importing another document.');
    const documentId = `document-${String(this.nextId)}` as DocumentId;
    this.nextId += 1;
    this.documents.set(documentId, {
      document,
      revision: 1,
      byteLength: documentByteLength(document),
    });
    return { documentId, revision: 1 };
  }

  /**
   * Resolves a handle to its document, refusing stale or unknown handles.
   *
   * Returns an `AppError` rather than throwing so callers can add operation
   * context; every caller throws it.
   */
  public resolve(handle: DocumentHandle): GeometryDocument | AppError {
    const entry = this.documents.get(handle.documentId);
    if (entry === undefined) {
      return modelUnavailable(
        'That model is no longer available. It may have been replaced or released.',
        { documentId: handle.documentId, requestedRevision: handle.revision },
      );
    }
    if (entry.revision !== handle.revision) {
      // The specific failure this guard exists for: an operation queued against
      // an older revision must not apply to whatever replaced it.
      return modelUnavailable('That operation refers to an out-of-date version of the model.', {
        documentId: handle.documentId,
        requestedRevision: handle.revision,
        currentRevision: entry.revision,
      });
    }
    return entry.document;
  }

  /**
   * Resolves a handle AND a part in one step.
   *
   * THE PART-TARGETED GUARD. Every operation that inspects or modifies one mesh
   * goes through here, so a request naming a part that does not exist at this
   * revision fails in one place rather than in each handler's own way. A result
   * for part A can therefore never be produced against part B's request.
   */
  public resolvePart(handle: DocumentHandle, part: PartId): GeometryPart | AppError {
    const document = this.resolve(handle);
    if (!isDocument(document)) return document;

    const found = findPart(document, part);
    if (found === undefined) {
      return modelUnavailable('That part is not in this version of the model.', {
        documentId: handle.documentId,
        requestedRevision: handle.revision,
        partId: part,
      });
    }
    return found;
  }

  public has(handle: DocumentHandle): boolean {
    return this.documents.get(handle.documentId)?.revision === handle.revision;
  }

  /**
   * Replaces a document, producing a NEW revision.
   *
   * THE TRANSACTIONAL STEP. Repair validates a candidate, builds the successor
   * document around it, and then calls this with the revision it started from.
   * If the document has moved on in the meantime the swap is refused, so a
   * repair computed against revision 3 can never land on revision 4's geometry.
   *
   * Atomic by construction: the map entry is replaced in one assignment. There
   * is no window in which a half-updated document is authoritative, because the
   * successor was built separately and only the reference moves. There is no
   * partial multi-part commit — one assignment publishes every part or none.
   */
  public replace(expected: DocumentHandle, document: GeometryDocument): DocumentHandle | AppError {
    this.assertMutable(expected.documentId);
    const entry = this.documents.get(expected.documentId);
    if (entry === undefined) {
      return modelUnavailable('That model is no longer available.', {
        documentId: expected.documentId,
        requestedRevision: expected.revision,
      });
    }
    if (entry.revision !== expected.revision) {
      return modelUnavailable('That operation refers to an out-of-date version of the model.', {
        documentId: expected.documentId,
        requestedRevision: expected.revision,
        currentRevision: entry.revision,
      });
    }
    const revision = entry.revision + 1;
    this.documents.set(expected.documentId, {
      document,
      revision,
      byteLength: documentByteLength(document),
    });
    return { documentId: expected.documentId, revision };
  }

  /** Current revision of a document, or `undefined` when it is not resident. */
  public revisionOf(documentId: DocumentId): number | undefined {
    return this.documents.get(documentId)?.revision;
  }

  /** Releases a document. Returns whether anything was actually released. */
  public release(documentId: DocumentId): boolean {
    this.assertMutable(documentId);
    return this.documents.delete(documentId);
  }

  /** Releases everything. Used when the runtime is torn down. */
  public releaseAll(): void {
    if (this.mutationLocks.size) throw invalidState('A split transaction is awaiting adoption.');
    this.documents.clear();
  }

  public stats(): ResidentDocumentStats {
    let totalBytes = 0;
    let partCount = 0;
    for (const entry of this.documents.values()) {
      totalBytes += entry.byteLength;
      partCount += entry.document.parts.length;
    }
    return { documentCount: this.documents.size, totalBytes, partCount };
  }
}
