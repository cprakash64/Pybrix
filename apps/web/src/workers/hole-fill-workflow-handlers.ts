import {
  assertGeometryDocument,
  assertMeshStructure,
  computeBounds,
  createIndexArray,
  documentTriangleCount,
  documentVertexCount,
  jointRetainedBytes,
  meshByteLength,
  retireDetachedJoints,
  retiredByInstall,
  triangleCount,
  withPartMesh,
} from '@cadfixer/mesh-core';
import type { CanonicalMesh, GeometryDocument, PartId } from '@cadfixer/mesh-core';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import {
  HOLE_FILL_MAX_BOUNDARY_VERTICES,
  UndoableChangeKind,
  documentByteLength,
  isDocument,
  type OperationHandler,
  type PartDescriptor,
  type RenderSnapshot,
} from '@cadfixer/geometry-runtime';
import { invalidState, isAppError, modelUnavailable } from '@cadfixer/shared';
import {
  buildRenderSnapshot,
  describeParts,
  holeFillCandidates,
  geometryEdits,
  repairHistory,
  residentDocuments,
} from './stl-handlers';

/**
 * THE USER-FACING HOLE-FILL WORKFLOW — Stage 4B-1B2.
 *
 * Three operations sit on top of the Stage 4B-1B1 engine, and between them they
 * are everything that turns a validated candidate into something a person can
 * see and choose:
 *
 *   - `holefill/boundary-preview` draws ONE selected opening;
 *   - `holefill/patch-preview` draws the patch of ONE stored candidate;
 *   - `holefill/commit` applies ONE stored candidate.
 *
 * WHAT IS NOT HERE, and must never be. No triangulation, no planarity test, no
 * broadphase, no narrowphase, no engine import of any kind. Every geometric
 * decision was made when the candidate was built, in the disposable worker, and
 * re-deriving any of it here would mean committing something other than what
 * the user previewed. This module reads a mesh the store already holds and
 * swaps a reference.
 *
 * THE TWO PREVIEWS ARE RENDER SNAPSHOTS, in exactly the sense ADR 0008 uses the
 * word: disposable display copies that no operation accepts back. Neither can
 * become authoritative, be exported, be analysed, or be turned into a candidate
 * — not because a rule says so, but because no function in the protocol takes
 * one.
 *
 * APPLY IS THE ONLY MUTATION IN THE WHOLE WORKFLOW. Listing openings, drawing a
 * rim, running the engine, drawing a patch, cancelling and discarding all leave
 * the resident document byte-identical and its revision exactly where it was.
 *
 * AND APPLY IS OBSERVABLY ATOMIC — Stage 4B-1B2-R2. Every fallible piece of the
 * answer is built BEFORE the authoritative swap, so a caller can never be told a
 * fill failed after it succeeded. See `createHoleFillCommitHandler`.
 */

/* --------------------------------------------------- boundary preview -- */

/**
 * Draws one boundary component as line segments.
 *
 * RE-EXTRACTED RATHER THAN CACHED. The loops for a revision are deterministic
 * and cheap relative to holding a second copy of every rim in the worker, and a
 * cache would be one more thing that can describe geometry it no longer
 * matches. The identity the caller names has to resolve against the CURRENT
 * geometry or the request is refused — which is precisely the check a cache
 * would have let us skip.
 *
 * PART-LOCAL COORDINATES. The placement is applied by the viewport to the
 * object that holds this, never baked in here: a rim drawn at the document
 * origin for a part placed elsewhere marks an opening where the opening is not.
 */
export const holeFillBoundaryPreviewHandler: OperationHandler<'holefill/boundary-preview'> = (
  payload,
  context,
) => {
  try {
    context.throwIfCancelled();

    const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
    if (isAppError(part)) throw part;

    const set = extractBoundaryLoops(part.mesh, {
      maxLoopVertices: HOLE_FILL_MAX_BOUNDARY_VERTICES,
      onBatch: () => {
        context.throwIfCancelled();
      },
    });

    const loop = set.loops.find((entry) => entry.id === payload.boundaryLoopId);
    if (loop === undefined) {
      /*
       * NOT AN ERROR ABOUT THE MODEL — an identity that does not resolve. It
       * happens when a listing is acted on after the geometry moved, which is
       * exactly the case the id exists to catch. `modelUnavailable` rather than
       * `invalidState` because the honest description is "that opening is not
       * in the geometry I hold now", and the interface's answer is to re-list.
       */
      throw modelUnavailable('That opening is not in the current version of this part.', {
        boundaryLoopId: payload.boundaryLoopId,
        partId: part.id,
        revision: payload.handle.revision,
      });
    }

    /*
     * A REFUSED COMPONENT HAS NO ORDERING TO DRAW. `extractBoundaryLoops`
     * deliberately returns an EMPTY vertex list for a branched or non-closed
     * boundary rather than a partial walk, so there is nothing here to render
     * and drawing "some of it" would show the user a rim that is not the shape
     * of their opening. Every component keeps its id and its refusal, so the
     * list can still name it; only the picture is unavailable.
     */
    const vertices = loop.vertices;
    const edgeCount = vertices.length;
    const positions = new Float32Array(edgeCount * 6);
    for (let edge = 0; edge < edgeCount; edge += 1) {
      const from = vertices[edge] ?? 0;
      const to = vertices[(edge + 1) % edgeCount] ?? 0;
      writeVertex(positions, edge * 6, part.mesh, set.vertexRepresentativeCorner, from);
      writeVertex(positions, edge * 6 + 3, part.mesh, set.vertexRepresentativeCorner, to);
    }

    return Promise.resolve({
      value: {
        handle: payload.handle,
        partId: part.id,
        boundaryLoopId: payload.boundaryLoopId,
        positions,
        vertexCount: loop.vertexCount,
        edgeCount: loop.edgeCount,
      },
      transfer: [positions.buffer],
    });
  } catch (cause) {
    return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }
};

/**
 * Copies one welded vertex's stored coordinates into the line buffer.
 *
 * Through the representative CORNER, which is how `mesh-topology` names a
 * welded vertex's position: the identity recovery maps corners to vertices, and
 * one corner per vertex is kept so the exact stored coordinate can be read back
 * without a second welding pass.
 */
function writeVertex(
  out: Float32Array,
  at: number,
  mesh: CanonicalMesh,
  representativeCorner: Uint32Array,
  vertex: number,
): void {
  const corner = representativeCorner[vertex];
  if (corner === undefined) return;
  const index = mesh.indices[corner];
  if (index === undefined) return;
  out[at] = mesh.positions[index * 3] ?? 0;
  out[at + 1] = mesh.positions[index * 3 + 1] ?? 0;
  out[at + 2] = mesh.positions[index * 3 + 2] ?? 0;
}

/* ------------------------------------------------------ patch preview -- */

/**
 * Draws the PATCH of a stored candidate, and nothing else.
 *
 * WHAT MAKES "WHAT YOU SEE IS WHAT APPLY COMMITS" TRUE. The triangles below are
 * read out of the candidate mesh the store is holding — the same object
 * `prepareCommit` will return and `withPartMesh` will install. There is no
 * second triangulation, no re-run of the engine, and no reconstruction from a
 * summary. A preview that recomputed its own patch would be a different
 * algorithm's opinion of the same hole, and the two could differ without
 * anything noticing.
 *
 * ONLY THE PATCH TRAVELS. Faces `[sourceFaceCount, candidateFaceCount)` — a few
 * kilobytes for a 512-vertex rim, whatever the part's size. Sending the whole
 * candidate would put a second copy of a 250,000-face mesh on the page for the
 * sake of drawing at most 510 triangles.
 *
 * FLAT NORMALS, computed per patch face. The patch is drawn as an overlay in
 * its own colour, so it needs enough shading to read as a surface and nothing
 * more; asking for smooth normals would mean deciding how the patch blends into
 * geometry it is not yet part of.
 */
export const holeFillPatchPreviewHandler: OperationHandler<'holefill/patch-preview'> = (
  payload,
) => {
  const candidate = payload.candidate;
  const mesh = holeFillCandidates.meshOf(candidate);
  if (mesh === undefined) {
    return Promise.reject(
      modelUnavailable('That fill preview is no longer available.', {
        candidateId: candidate.candidateId,
      }),
    );
  }

  const totalFaces = triangleCount(mesh);
  const start = candidate.sourceFaceCount;
  if (start > totalFaces) {
    // Would mean the candidate holds fewer faces than the source it was built
    // from, which the append-only contract forbids. A defect, not a refusal.
    return Promise.reject(
      invalidState('That fill preview does not describe a patch.', {
        candidateId: candidate.candidateId,
        sourceFaceCount: start,
        candidateFaceCount: totalFaces,
      }),
    );
  }

  const patchFaces = totalFaces - start;
  const positions = new Float32Array(patchFaces * 9);
  const normals = new Float32Array(patchFaces * 9);

  for (let face = 0; face < patchFaces; face += 1) {
    const base = (start + face) * 3;
    const out = face * 9;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[base + corner] ?? 0;
      positions[out + corner * 3] = mesh.positions[vertex * 3] ?? 0;
      positions[out + corner * 3 + 1] = mesh.positions[vertex * 3 + 1] ?? 0;
      positions[out + corner * 3 + 2] = mesh.positions[vertex * 3 + 2] ?? 0;
    }
    writeFlatNormal(normals, positions, out);
  }

  return Promise.resolve({
    value: {
      candidate,
      positions,
      normals,
      triangleCount: patchFaces,
      bounds: boundsOf(positions),
    },
    transfer: [positions.buffer, normals.buffer],
  });
};

/**
 * A face normal from the triangle's own two edges, repeated per corner.
 *
 * A DEGENERATE PATCH FACE GETS A ZERO NORMAL, never an invented direction and
 * never `NaN` — the same rule the STL writer follows for the same reason.
 * Validation already rejects a candidate containing one, so this is a display
 * safeguard rather than a path anything is expected to take.
 */
function writeFlatNormal(normals: Float32Array, positions: Float32Array, out: number): void {
  const ax = positions[out] ?? 0;
  const ay = positions[out + 1] ?? 0;
  const az = positions[out + 2] ?? 0;
  const ux = (positions[out + 3] ?? 0) - ax;
  const uy = (positions[out + 4] ?? 0) - ay;
  const uz = (positions[out + 5] ?? 0) - az;
  const vx = (positions[out + 6] ?? 0) - ax;
  const vy = (positions[out + 7] ?? 0) - ay;
  const vz = (positions[out + 8] ?? 0) - az;

  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length > 0) {
    nx /= length;
    ny /= length;
    nz /= length;
  } else {
    nx = 0;
    ny = 0;
    nz = 0;
  }
  for (let corner = 0; corner < 3; corner += 1) {
    normals[out + corner * 3] = nx;
    normals[out + corner * 3 + 1] = ny;
    normals[out + corner * 3 + 2] = nz;
  }
}

/** Bounds of a non-indexed position buffer, so the page never walks it. */
function boundsOf(positions: Float32Array): ReturnType<typeof computeBounds> {
  if (positions.length < 3) return undefined;
  return computeBounds({
    positions,
    indices: createIndexArray(0),
    metadata: {},
  });
}

/* ------------------------------------------------------------- commit -- */

/**
 * The fallible work `holefill/commit` performs, INJECTED so its failure can be
 * exercised.
 *
 * WHY A SEAM AND NOT A FLAG — Stage 4B-1B2-R2. The atomicity claim below is that
 * no ordinary fallible operation runs after the authoritative swap. Asserting
 * that by reading source order proves the statements are in that order; it does
 * not prove the handler behaves correctly when one of them actually fails.
 * Making a large allocation fail on demand is the only way to test the path, and
 * a production flag that could disable or divert real work is exactly the bypass
 * hook the boundary scan forbids.
 *
 * So the two ALLOCATING steps arrive as functions. `PRODUCTION_COMMIT_WORK` is
 * the only value the application ever uses — the exported handler is built from
 * it at module scope and nothing in the product can select another — and a test
 * can build a second handler whose snapshot builder throws. A CONSTRUCTION SEAM,
 * exactly as `HoleFillWorkerFactory` is, not a fault switch.
 */
export interface HoleFillCommitWork {
  /** Drawable buffers for the committed part. Allocates; can fail. */
  readonly buildRenderSnapshot: (mesh: CanonicalMesh) => RenderSnapshot;
  /** Scalar metadata for the whole successor document. Allocates; can fail. */
  readonly describeParts: (document: GeometryDocument) => readonly PartDescriptor[];
}

export const PRODUCTION_COMMIT_WORK: HoleFillCommitWork = {
  buildRenderSnapshot,
  describeParts,
};

/**
 * Applies ONE stored, validated candidate. THE ONLY HOLE-FILL MUTATION.
 *
 * THE TRANSACTION, in order, and the order is the point:
 *
 *   1. resolve the document the caller named;
 *   2. `prepareCommit` applies every identity, lifecycle and staleness guard
 *      and returns the candidate's mesh — or a typed refusal, in which case
 *      nothing below runs;
 *   3. `assertMeshStructure` — rule 11. The candidate was validated when it was
 *      built, but a mesh is checked before it is accepted, every time;
 *   4. `withPartMesh` builds the SUCCESSOR document, sharing every other part by
 *      reference, and `assertGeometryDocument` checks what only a document can
 *      be asked;
 *   5. EVERY FALLIBLE PIECE OF THE ANSWER IS BUILT — the render snapshot, the
 *      part descriptors, the totals, the undo record's contents. See below;
 *   6. `residentDocuments.replace` re-checks the revision and swaps ONE map
 *      entry. That single swap is the atomic step: before it the user has the
 *      old document, after it the new one, and there is no moment in between
 *      where the revision has moved but the part has not;
 *   7. the candidate is consumed and the undo record written — both bounded map
 *      writes — and the already-built answer is returned.
 *
 * WHY THE ANSWER IS BUILT BEFORE THE SWAP — Stage 4B-1B2-R2, and this is the
 * whole point of the ordering.
 *
 * `buildRenderSnapshot` allocates: for a 250,000-face part it copies megabytes
 * and derives per-vertex normals. It can fail. When it ran AFTER the swap, its
 * failure threw out of the handler, the worker host turned that into an ordinary
 * error reply, and the caller was told the fill had FAILED — while the
 * authoritative document had already changed. "The worker's internal state was
 * consistent" is not the guarantee that matters: the guarantee that matters is
 * what the caller may observe, and observing a failure for a change that
 * happened is a lie the interface would then act on.
 *
 * So everything that can fail happens first, against the PROPOSED document, and
 * the swap is the last thing that can go either way. If it refuses — because the
 * revision moved while the answer was being built — the prepared snapshot is
 * discarded and nothing has changed. Preparing early cannot introduce a stale
 * race, because `replace` compares the revision itself and is the only arbiter.
 *
 * PREPARING A SNAPSHOT DOES NOT MAKE IT AUTHORITATIVE. It is disposable render
 * data derived from a document that does not exist yet; only the store's
 * replacement defines the mutation, and a refused swap means the snapshot
 * described something that never happened.
 *
 * A REFUSAL AT ANY STEP LEAVES EVERYTHING AS IT WAS, and specifically leaves the
 * candidate RESOLVED and retryable. Consuming it before the swap succeeded
 * would destroy a validated fill because of a transient race.
 *
 * NO GEOMETRY ARRIVES FROM THE PAGE. The payload is four identifiers. The page
 * could not send a mesh if it wanted to — it has never held one.
 */
export function createHoleFillCommitHandler(
  work: HoleFillCommitWork,
): OperationHandler<'holefill/commit'> {
  return (payload, context) => {
    const source = residentDocuments.resolve(payload.expectedSource);
    if (!isDocument(source)) throw source;

    const currentRevision = residentDocuments.revisionOf(payload.expectedSource.documentId);
    const prepared = holeFillCandidates.prepareCommit(
      {
        candidate: payload.candidate,
        expectedSource: payload.expectedSource,
        expectedPart: payload.expectedPart as PartId,
        expectedLoopId: payload.expectedLoopId,
      },
      currentRevision,
    );
    if (isAppError(prepared)) throw prepared;

    const filledPart = payload.candidate.partId;

    /*
     * THE PRE-FILL MESH, captured BEFORE the swap, for the undo record.
     *
     * THE OBJECT ITSELF, not a copy and not a description of one — Stage
     * 4B-1B2-R1. Undo has to put the document back the way it was, and for a
     * document whose parts SHARE a mesh that means restoring the same reference
     * the sibling still holds. A rebuilt mesh with identical bytes would leave
     * the document permanently holding two equal meshes where it had one.
     *
     * O(1) AND SAFE. Canonical meshes are immutable, so retaining one costs a
     * pointer and nothing is copied, compared or mutated. When a sibling still
     * references it the retention adds no memory at all; when the filled part
     * was its only owner the record keeps it alive until it is undone,
     * superseded or released, which is one part's geometry bounded by the
     * one-undoable-change rule.
     *
     * Read from the RESIDENT part rather than from the candidate's handle, so
     * the record holds the geometry that is actually being replaced.
     */
    const currentPart = source.parts.find((part) => part.id === filledPart);
    if (currentPart === undefined) {
      throw invalidState('That part is no longer in this model.', {
        partId: filledPart,
        operation: 'holefill/commit',
      });
    }
    const previousMesh = currentPart.mesh;
    const sourceFaceCount = triangleCount(previousMesh);
    const sourceIndexCount = previousMesh.indices.length;
    const patchFaceCount = triangleCount(prepared) - sourceFaceCount;

    // Rule 11. A returned mesh is not success, however confident its producer is.
    assertMeshStructure(prepared, 'holefill/commit');

    // Retire before reporting (Stage EC-3): the joint over a part whose mesh this fill replaces is retired when the store installs the
    // document, so what is reported is the document as it will be held.
    const successor = retireDetachedJoints(
      successorDocument(source, filledPart, prepared),
      payload.expectedSource.revision + 1,
    );

    /*
     * ---- EVERYTHING THAT CAN FAIL, BEFORE ANYTHING CHANGES ----
     *
     * Both of these allocate, and both are built from the PROPOSED document. If
     * either throws, the handler rejects and the resident store has not been
     * touched: the caller sees a failure for an operation that genuinely did not
     * happen, which is the whole point.
     */
    const render = work.buildRenderSnapshot(prepared);
    const parts = work.describeParts(successor);
    const residentBytes = documentByteLength(successor);
    const totalTriangles = documentTriangleCount(successor);
    const totalVertices = documentVertexCount(successor);
    const bounds = computeBounds(prepared);
    const inverse = {
      previousMesh,
      sourceFaceCount,
      sourceIndexCount,
      // The mesh's own size. An UPPER BOUND on what this record costs, not a
      // claim about what it adds — see `RepairHistoryEntry.retainedBytes`.
      byteLength: meshByteLength(previousMesh),
      // A change that retires a joint keeps the document it came from, so Undo can bring the joint back (Stage EC-3).
      ...(retiredByInstall(source, successor) > 0
        ? {
            previousDocument: source,
            byteLength: meshByteLength(previousMesh) + jointRetainedBytes(source),
          }
        : {}),
    };

    // Reported BEFORE the swap and worded for what is actually true at this
    // moment. Saying "applied" here would be a claim about something that has
    // not happened; saying it afterwards would put a fallible transport call
    // after the commit, which is exactly what this ordering removes.
    context.reportProgress(0.9, 'applying');

    /*
     * ---- THE COMMIT. Nothing below may fail. ----
     *
     * `replace` is the atomic step and the last thing that can refuse: it
     * re-checks the revision against the store itself, so an answer built
     * against a document the user has since moved off is discarded here rather
     * than installed. Everything after it is a bounded map write, a string
     * concatenation or an object literal — see `AT05`, which enumerates them.
     */
    const next = residentDocuments.replace(payload.expectedSource, successor);
    if (isAppError(next)) throw next;
    holeFillCandidates.markCommitted(payload.candidate);
    geometryEdits.releaseDocument(next.documentId);

    /*
     * A DETERMINISTIC RECORD ID: lineage, part, both revisions and the opening.
     * Not a wall clock — two fills a millisecond apart must be distinguishable
     * by WHAT they did, not by when. The same rule `repair/commit` follows.
     */
    const recordId = `${next.documentId}/${filledPart}@${String(payload.expectedSource.revision)}->${String(next.revision)}#${payload.expectedLoopId}`;

    const entry = repairHistory.record({
      recordId,
      kind: UndoableChangeKind.HoleFill,
      source: payload.expectedSource,
      part: filledPart,
      result: next,
      // A fill is not one of the four conservative operations, and claiming one
      // here would put a repair's name on a different change.
      appliedOperations: [],
      planHash: payload.expectedLoopId,
      boundaryLoopId: payload.expectedLoopId,
      inverse,
    });

    return Promise.resolve({
      value: {
        handle: next,
        parentRevision: payload.expectedSource.revision,
        recordId,
        partId: filledPart,
        boundaryLoopId: payload.expectedLoopId,
        patchFaceCount,
        render,
        parts,
        residentBytes,
        // DOCUMENT totals, so the panel reports the model the user now has
        // rather than only the part that changed.
        triangleCount: totalTriangles,
        vertexCount: totalVertices,
        bounds,
        undoable: entry.undoable,
      },
      transfer: [render.positions.buffer, render.normals.buffer],
    });
  };
}

/** The application's commit handler. The only one the product ever registers. */
export const holeFillCommitHandler = createHoleFillCommitHandler(PRODUCTION_COMMIT_WORK);

/**
 * The successor document a part-level replacement produces.
 *
 * STRUCTURAL SHARING IS THE POINT, and it is why this goes through
 * `withPartMesh` rather than rebuilding a document literal: every part other
 * than the filled one is carried across BY REFERENCE — the same `GeometryPart`,
 * the same `CanonicalMesh`, the same buffers. Filling a hole in one of two parts
 * that SHARE a mesh gives the filled part the candidate and leaves the other
 * holding the original object, untouched and still open.
 *
 * Unit, part order, ids, names and every placement are untouched: a fill changes
 * one part's triangles and nothing else about the document.
 */
function successorDocument(
  document: GeometryDocument,
  part: PartId,
  mesh: CanonicalMesh,
): GeometryDocument {
  const next = withPartMesh(document, part, mesh);
  if (next === undefined) {
    throw invalidState('That part is no longer in this model.', {
      partId: part,
      operation: 'holefill/commit',
    });
  }
  /*
   * Rule 11 at the DOCUMENT level. Meshes are not re-walked: every one of them
   * was validated when it was admitted, and the only new mesh here was
   * validated moments ago.
   */
  assertGeometryDocument(next, 'holefill/commit', { validateMeshes: false });
  return next;
}

export { successorDocument as holeFillSuccessorDocument };
