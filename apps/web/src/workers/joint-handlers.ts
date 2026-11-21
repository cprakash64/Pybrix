import {
  classifyPlacement,
  documentTriangleCount,
  documentVertexCount,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import { invalidState } from '@cadfixer/shared';
import {
  describeJoints,
  documentByteLength,
  JointEditRefusal,
  rebuildJointConnectors,
  sameSpec,
  specFromEdit,
  type BooleanBackend,
  type GeometryEditTicket,
  type JointCommitResult,
  type JointDescriptor,
  type JointEditRequest,
  type OperationHandler,
} from '@cadfixer/geometry-runtime';
import {
  booleanOperations,
  buildDocumentRenderSnapshot,
  describeParts,
  documentBounds,
  documentRenderTransferables,
  holeFillCandidates,
  jointEdits,
  repairCandidates,
  residentDocuments,
} from './stl-handlers';
import { isDocument } from '@cadfixer/geometry-runtime';

/**
 * THE WORKER SIDE OF EDITING A JOINT'S CONNECTORS (Stage EC-3). Four operations; ONE of them mutates.
 *
 *   - `joint/list`    reads: descriptors, never geometry.
 *   - `joint/propose` builds a CANDIDATE by rebuilding the connectors from the retained pieces, and returns a disposable preview.
 *   - `joint/commit`  applies the stored candidate. No geometry arrives from the page: four identifiers do.
 *   - `joint/discard` releases the candidate.
 *
 * What a page may ask for is a vocabulary of NUMBERS (a male side, a size in millimetres, positions on the cut). A message is
 * untrusted, so the request is read field by field here, and nothing reaches the engine that is not a finite number in range.
 */

/** Codes for a request that is not an edit at all, as opposed to one the engine refuses. */
const MALFORMED = 'JOINT_EDIT_MALFORMED';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalidState(`The connector edit has no usable ${label}.`, { code: MALFORMED });
  return value;
}

/** Reads an untrusted `edit` into the engine's request. Bounded: no more pins than a joint holds, and every number finite. */
export function readJointEdit(value: unknown): JointEditRequest {
  if (!isRecord(value))
    throw invalidState('The connector edit is not an edit.', { code: MALFORMED });
  if (value.kind === 'REMOVE_CONNECTORS') return { kind: 'REMOVE_CONNECTORS' };
  if (value.kind !== 'SET_CONNECTORS')
    throw invalidState('The connector edit is not an edit.', { code: MALFORMED });
  const { maleSide, pins } = value;
  if (maleSide !== 'A' && maleSide !== 'B')
    throw invalidState('The connector edit names no male side.', { code: MALFORMED });
  if (!Array.isArray(pins) || pins.length < 1 || pins.length > 4)
    throw invalidState('The connector edit has a number of connectors Pybrix cannot place.', {
      code: MALFORMED,
    });
  return {
    kind: 'SET_CONNECTORS',
    maleSide,
    diameterMm: finite(value.diameterMm, 'diameter'),
    depthMm: finite(value.depthMm, 'depth'),
    clearanceMm: finite(value.clearanceMm, 'clearance'),
    pins: (pins as unknown[]).map((entry) => {
      if (!isRecord(entry))
        throw invalidState('A connector is not a connector.', { code: MALFORMED });
      const pinId = entry.pinId;
      if (
        pinId !== undefined &&
        (typeof pinId !== 'string' || pinId.length === 0 || pinId.length > 64)
      )
        throw invalidState('A connector has no usable name.', { code: MALFORMED });
      return {
        ...(pinId === undefined ? {} : { pinId }),
        u: finite(entry.u, 'position'),
        v: finite(entry.v, 'position'),
      };
    }),
  };
}

function descriptorOf(document: GeometryDocument, jointId: string): JointDescriptor {
  const found = describeJoints(document).find((descriptor) => descriptor.jointId === jointId);
  if (found === undefined) throw invalidState('The joint is not in the document it was built for.');
  return found;
}

export const jointListHandler: OperationHandler<'joint/list'> = (payload, context) => {
  context.throwIfCancelled();
  const document = residentDocuments.resolve(payload.source);
  if (!isDocument(document)) throw document;
  return Promise.resolve({ value: { joints: describeJoints(document) } });
};

/**
 * The Booleans a rebuild runs, owned by the edit's ticket so that a newer edit, a release or a cancel stops them. INJECTED: a test
 * supplies a backend that needs no worker, and the application builds exactly one handler from the production one.
 */
export type JointBooleanBackendFor = (ticket: GeometryEditTicket) => BooleanBackend;

export const PRODUCTION_JOINT_BACKEND: JointBooleanBackendFor = (ticket) => ({
  operate: (kind, a, b, cancellation) =>
    booleanOperations.run(kind, a, b, cancellation, {
      owner: { documentId: ticket.documentId, generation: ticket.generation },
    }),
});

export function createJointProposeHandler(
  backendFor: JointBooleanBackendFor,
): OperationHandler<'joint/propose'> {
  return async (payload, context) => {
    context.throwIfCancelled();
    const edit = readJointEdit(payload.edit);
    if (typeof payload.jointId !== 'string' || typeof payload.expectedSpecDigest !== 'string')
      throw invalidState('The connector edit names no joint.', { code: MALFORMED });
    const session = jointEdits.begin(payload.source, payload.jointId, payload.expectedSpecDigest);
    try {
      context.reportProgress(0.05, 'Preparing connectors…');
      const { spec, nextPinOrdinal } = specFromEdit(session.joint, edit);
      if (sameSpec(spec, session.joint.connector))
        throw invalidState('This would leave the connectors as they are.', {
          code: JointEditRefusal.NoChange,
        });
      const partA = session.document.parts.find((part) => part.id === session.joint.a.partId);
      if (partA === undefined) throw invalidState('A part of this joint is no longer present.');
      context.reportProgress(0.1, 'Checking connectors…');
      const rebuilt = await rebuildJointConnectors(
        backendFor(session.ticket),
        session.joint,
        spec,
        classifyPlacement(partA.transform),
        context.cancellation,
        nextPinOrdinal,
      );
      context.reportProgress(0.85, 'Checking parts…');
      const summary = jointEdits.resolve(session, rebuilt, context.cancellation);
      const preview = jointEdits.preview(summary.candidate, (document) => ({
        render: buildDocumentRenderSnapshot(document),
        parts: describeParts(document),
        after: descriptorOf(document, summary.jointId),
      }));
      context.reportProgress(1, 'Preparing preview…');
      return {
        value: { ...summary, ...preview },
        transfer: documentRenderTransferables(preview.render),
      };
    } catch (error) {
      jointEdits.fail(session.ticket);
      throw error;
    }
  };
}

export const jointProposeHandler: OperationHandler<'joint/propose'> =
  createJointProposeHandler(PRODUCTION_JOINT_BACKEND);

/**
 * The fallible work `joint/commit` performs, INJECTED so a test can make it fail on demand: source order proves an ordering, not that
 * the handler copes when a step actually fails. The application builds exactly one handler, from `PRODUCTION_JOINT_COMMIT_WORK`.
 */
export interface JointCommitWork {
  readonly build: (
    document: GeometryDocument,
  ) => Omit<JointCommitResult, 'handle' | 'parentRevision' | 'recordId' | 'summary'>;
}

export const PRODUCTION_JOINT_COMMIT_WORK: JointCommitWork = {
  build: (document) => ({
    render: buildDocumentRenderSnapshot(document),
    parts: describeParts(document),
    joints: describeJoints(document),
    residentBytes: documentByteLength(document),
    triangleCount: documentTriangleCount(document),
    vertexCount: documentVertexCount(document),
    bounds: documentBounds(document),
  }),
};

export function createJointCommitHandler(work: JointCommitWork): OperationHandler<'joint/commit'> {
  return (payload, context) => {
    context.throwIfCancelled();
    if (
      typeof payload.expectedJointId !== 'string' ||
      typeof payload.expectedSpecDigest !== 'string'
    )
      throw invalidState('The connector edit names no joint.', { code: MALFORMED });
    // Everything fallible is inside `commit`, ahead of the swap, and a refusal leaves the candidate resolved.
    const committed = jointEdits.commit(
      payload.candidate,
      payload.expectedSource,
      payload.expectedJointId,
      payload.expectedSpecDigest,
      (document) => work.build(document),
    );
    // The revision moved, so a candidate of any other kind for this document is stale.
    holeFillCandidates.releaseDocument(committed.handle.documentId);
    repairCandidates.releaseDocument(committed.handle.documentId);
    const { value } = committed;
    return Promise.resolve({
      value: {
        handle: committed.handle,
        parentRevision: payload.expectedSource.revision,
        recordId: committed.recordId,
        summary: committed.summary,
        ...value,
      },
      transfer: documentRenderTransferables(value.render),
    });
  };
}

export const jointCommitHandler: OperationHandler<'joint/commit'> = createJointCommitHandler(
  PRODUCTION_JOINT_COMMIT_WORK,
);

export const jointDiscardHandler: OperationHandler<'joint/discard'> = (payload) =>
  Promise.resolve({ value: { released: jointEdits.discard(payload.candidate) } });
