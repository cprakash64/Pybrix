import { assertMeshStructure, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology, type TopologyReport } from '@cadfixer/mesh-topology';
import { applyLocalRepairPatch } from '@cadfixer/mesh-repair';
import {
  buildFanTopology,
  planLocalRepair,
  PRODUCTION_REPAIR_WORK_LIMITS,
  REPAIR_WORK_UNITS,
} from '@cadfixer/mesh-hole-fill/admission';
import {
  LocalRepairOutcomeKind,
  LocalRepairWorkPhase,
  LOCAL_CHANGE_FACE_LIMIT,
  LOCAL_REPAIR_REASON_LIMIT,
  type LocalRepairChange,
  type LocalRepairOutcome,
  type LocalRepairPlan,
  type ProtocolPort,
} from '@cadfixer/geometry-runtime';
import { internalError, operationCancelled, type CancellationToken } from '@cadfixer/shared';
import type { LocalRepairMessage, LocalRepairReply } from './hole-fill-protocol';

/**
 * THE LOCAL PINCH REPAIR, AUTHORITATIVE SIDE — REPAIR-CORE-06A.
 *
 * WHAT RUNS HERE. The topology-only plan (fan topology; O(part), cooperatively cancellable), the
 * candidate build from a returned PATCH (the same `rebuildCandidate` every repair uses, so
 * representation, groups and indexing carry over) and the INDEPENDENT validation of the result.
 *
 * WHAT DOES NOT. The search, the exact gate and the residual phase. They run C++ that polls no
 * JavaScript flag, so they live in the disposable kernel worker, whose termination is the cancel.
 * Only a patch and scalars come back; the authoritative worker never takes the engine's word for
 * what the candidate looks like.
 *
 * FAIL CLOSED. No verifier channel means nothing can be verified and nothing is repaired. A
 * candidate that fails the structural check, or whose independent analysis shows ANY regression
 * against the source, is discarded and reported — never registered.
 */

/** Plans cached per document, revision and part: geometry at a revision is immutable. */
const planCache = new Map<
  string,
  { readonly mesh: CanonicalMesh; readonly plan: LocalRepairPlan }
>();
const PLAN_CACHE_ENTRIES = 4;

/** The least work one eligible vertex can cost: one candidate construction and one exact test. */
const MIN_SITE_WORK = REPAIR_WORK_UNITS.candidate + REPAIR_WORK_UNITS.exactTest;

export function releaseLocalRepairPlans(documentId: string): void {
  for (const key of [...planCache.keys()]) {
    if (key.startsWith(`${documentId}@`)) planCache.delete(key);
  }
}

function hashOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return `lr-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

export const NOT_REQUESTED_LOCAL_REPAIR_PLAN: LocalRepairPlan = Object.freeze({
  requested: false,
  pinchedVertices: 0,
  eligible: 0,
  unsupportedNonManifoldEdge: 0,
  byClass: Object.freeze({}),
  workLimit: Object.freeze({ primary: undefined, residual: undefined }),
  estimatedWorkLowerBound: 0,
  limitLikely: false,
  planHash: 'lr-not-requested',
});

/** What the local repair would attempt on `mesh`, from topology alone. */
export function planLocalRepairFor(
  key: string,
  mesh: CanonicalMesh,
  poll: () => void,
): LocalRepairPlan {
  const cached = planCache.get(key);
  if (cached?.mesh === mesh) return cached.plan;
  const facts = planLocalRepair(buildFanTopology(mesh, { poll }));
  const primary = PRODUCTION_REPAIR_WORK_LIMITS.primary;
  const lowerBound = facts.eligible * MIN_SITE_WORK;
  const plan: LocalRepairPlan = {
    requested: true,
    pinchedVertices: facts.pinchedVertices,
    eligible: facts.eligible,
    unsupportedNonManifoldEdge: facts.unsupportedNonManifoldEdge,
    byClass: facts.byClass,
    workLimit: {
      primary,
      residual: PRODUCTION_REPAIR_WORK_LIMITS.residual,
    },
    estimatedWorkLowerBound: lowerBound,
    limitLikely: primary !== undefined && lowerBound >= primary,
    planHash: hashOf(
      `${key}|${String(facts.pinchedVertices)}|${String(facts.eligible)}|${String(
        facts.unsupportedNonManifoldEdge,
      )}|${String(primary)}|${String(PRODUCTION_REPAIR_WORK_LIMITS.residual)}`,
    ),
  };
  planCache.delete(key);
  planCache.set(key, { mesh, plan });
  while (planCache.size > PLAN_CACHE_ENTRIES) {
    const oldest = planCache.keys().next().value;
    if (oldest === undefined) break;
    planCache.delete(oldest);
  }
  return plan;
}

export interface LocalRepairStageInput {
  /** The mesh to repair: the source, or the accepted conservative candidate built from it. */
  readonly mesh: CanonicalMesh;
  /** Stage 2's report of exactly `mesh`. */
  readonly report: TopologyReport;
  readonly verifierPort: ProtocolPort | undefined;
  /** May only NARROW the production primary budget; a larger value is ignored. */
  readonly workCeiling?: number;
  readonly operationId: string;
  readonly documentId: string;
  readonly partId: string;
  readonly revision: number;
  readonly cancellation: CancellationToken;
  readonly throwIfCancelled: () => void;
  readonly onProgress: (fraction: number, note: string) => void;
}

export interface LocalRepairStageResult {
  /** Only when the repair changed something and the independent validation passed. */
  readonly candidate: CanonicalMesh | undefined;
  /** Stage 2's report of `candidate`. */
  readonly after: TopologyReport | undefined;
  readonly outcome: LocalRepairOutcome;
  /** Source faces of `input.mesh` per surviving candidate face, for overlays. */
  readonly candidateToInputFace: Uint32Array | undefined;
  /**
   * The bounded change delta, with removed and reversed faces named in faces of `input.mesh`
   * (the caller maps them to source faces). Undefined when nothing changed.
   */
  readonly change: LocalRepairChange | undefined;
}

/** At most `limit` entries of `values`, by a deterministic stride across the whole list. */
function strided(values: Uint32Array, limit: number): Uint32Array {
  if (values.length <= limit) return values.slice();
  const out = new Uint32Array(limit);
  const step = values.length / limit;
  for (let i = 0; i < limit; i += 1) out[i] = values[Math.floor(i * step)] ?? 0;
  return out;
}

/**
 * The delta of one built candidate. Added faces are the LAST `appendedFaceCount` faces of the
 * candidate, because the rebuild places survivors first; their positions are copied out, so the
 * candidate itself never leaves the worker.
 */
export function describeChange(
  patch: {
    readonly removedSourceFaces: Uint32Array;
    readonly flippedSourceFaces: Uint32Array;
  },
  candidate: CanonicalMesh,
  appendedFaceCount: number,
  limit: number,
): LocalRepairChange {
  const firstAppended = candidate.indices.length / 3 - appendedFaceCount;
  const picked = Math.min(appendedFaceCount, limit);
  const step = appendedFaceCount / Math.max(picked, 1);
  const addedPositions = new Float32Array(picked * 9);
  for (let i = 0; i < picked; i += 1) {
    const face = firstAppended + Math.floor(i * step);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = candidate.indices[face * 3 + corner] ?? 0;
      for (let axis = 0; axis < 3; axis += 1) {
        addedPositions[i * 9 + corner * 3 + axis] = candidate.positions[vertex * 3 + axis] ?? 0;
      }
    }
  }
  const removed = strided(patch.removedSourceFaces, limit);
  const reversed = strided(patch.flippedSourceFaces, limit);
  return {
    removedSourceFaces: removed,
    reversedSourceFaces: reversed,
    addedPositions,
    removedCount: patch.removedSourceFaces.length,
    reversedCount: patch.flippedSourceFaces.length,
    addedCount: appendedFaceCount,
    truncated:
      removed.length < patch.removedSourceFaces.length ||
      reversed.length < patch.flippedSourceFaces.length ||
      picked < appendedFaceCount,
    sampleLimit: limit,
  };
}

/**
 * Whether `after` is no worse than `before` on every hard defect the repair is allowed to touch.
 * The repair may remove defects and may expose none: a count that rose is a regression, whatever
 * the engine reported.
 */
export function judgeLocalRepair(before: TopologyReport, after: TopologyReport): string[] {
  const regressions: string[] = [];
  const check = (name: string, was: number, now: number): void => {
    if (now > was) regressions.push(`${name}: ${String(was)} -> ${String(now)}`);
  };
  check('boundary edges', before.boundaryEdgeCount, after.boundaryEdgeCount);
  check('non-manifold edges', before.nonManifoldEdgeCount, after.nonManifoldEdgeCount);
  check('non-manifold vertices', before.nonManifoldVertexCount, after.nonManifoldVertexCount);
  check('winding conflicts', before.windingConflictEdgeCount, after.windingConflictEdgeCount);
  check(
    'same-orientation duplicates',
    before.sameOrientationDuplicateCount,
    after.sameOrientationDuplicateCount,
  );
  check(
    'reversed duplicates',
    before.reversedOrientationDuplicateCount,
    after.reversedOrientationDuplicateCount,
  );
  check('zero-area faces', before.zeroAreaFaceCount, after.zeroAreaFaceCount);
  check('components', before.componentCount, after.componentCount);
  return regressions;
}

function noRunOutcome(kind: LocalRepairOutcomeKind): LocalRepairOutcome {
  return {
    kind,
    eligible: 0,
    unsupportedNonManifoldEdge: 0,
    repaired: 0,
    remaining: 0,
    unattempted: 0,
    remainingByReason: [],
    limitReached: undefined,
    work: {
      primary: { used: 0, limit: PRODUCTION_REPAIR_WORK_LIMITS.primary },
      residual: { used: 0, limit: PRODUCTION_REPAIR_WORK_LIMITS.residual },
    },
    residual: {
      ran: false,
      skippedBecause: undefined,
      linkRetriangulations: 0,
      repairedAfterResidual: 0,
      windingComponentsResolved: 0,
      windingFacesReversed: 0,
    },
    facesRemoved: 0,
    facesAppended: 0,
    facesReversed: 0,
    reasonsTruncated: false,
  };
}

/** The smaller of the product's ceiling and a requested one; a request can never widen it. */
function narrowed(product: number | undefined, requested: number | undefined): number | undefined {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return product;
  return product === undefined ? Math.floor(requested) : Math.min(product, Math.floor(requested));
}

/** Generous, but finite: no honest repair adds more than this many faces per source face. */
const MAX_APPENDED_FACES_PER_SOURCE_FACE = 8;
const APPENDED_FACE_ALLOWANCE = 1_024;

/**
 * Checks the SHAPE of a patch before a candidate is built from it: counts bounded by the mesh,
 * every index inside the slot space it names, every coordinate finite. A violation is an internal
 * failure — never a candidate and never a partial application. The independent structural check
 * and topology analysis that follow still run on whatever passes.
 */
export function assertPatchShape(
  patch: {
    readonly removedSourceFaces: Uint32Array;
    readonly flippedSourceFaces: Uint32Array;
    readonly appendedPositions: Float32Array;
    readonly appendedFaces: Uint32Array;
  },
  mesh: CanonicalMesh,
): void {
  const invalid = (what: string): never => {
    throw internalError('The local repair returned an invalid result.', { details: { what } });
  };
  const sourceFaces = Math.floor(mesh.indices.length / 3);
  const sourceSlots = Math.floor(mesh.positions.length / 3);
  if (patch.appendedFaces.length % 3 !== 0) invalid('appended face length');
  if (patch.appendedPositions.length % 3 !== 0) invalid('appended position length');
  const appendedFaces = patch.appendedFaces.length / 3;
  if (appendedFaces > sourceFaces * MAX_APPENDED_FACES_PER_SOURCE_FACE + APPENDED_FACE_ALLOWANCE) {
    invalid('appended face count');
  }
  if (patch.removedSourceFaces.length > sourceFaces) invalid('removed face count');
  if (patch.flippedSourceFaces.length > sourceFaces) invalid('reversed face count');
  const slots = sourceSlots + patch.appendedPositions.length / 3;
  for (const face of patch.removedSourceFaces) if (face >= sourceFaces) invalid('removed index');
  for (const face of patch.flippedSourceFaces) if (face >= sourceFaces) invalid('reversed index');
  for (const slot of patch.appendedFaces) if (slot >= slots) invalid('appended corner');
  for (const value of patch.appendedPositions) if (!Number.isFinite(value)) invalid('coordinate');
}

export async function runLocalRepairStage(
  input: LocalRepairStageInput,
): Promise<LocalRepairStageResult> {
  if (input.verifierPort === undefined) {
    // FAIL CLOSED: nothing can be verified, so nothing is repaired.
    return {
      candidate: undefined,
      after: undefined,
      outcome: noRunOutcome(LocalRepairOutcomeKind.NoChange),
      candidateToInputFace: undefined,
      change: undefined,
    };
  }
  input.throwIfCancelled();
  input.onProgress(0.55, 'repairing pinched vertices');

  // A COPY: the kernel worker takes ownership of what it is sent, and the authoritative arrays
  // must survive a terminated worker.
  const positions = input.mesh.positions.slice();
  const indices = input.mesh.indices.slice();
  const message: LocalRepairMessage = {
    kind: 'local-repair',
    operationId: input.operationId,
    positions,
    indices,
    limits: {
      primary: narrowed(PRODUCTION_REPAIR_WORK_LIMITS.primary, input.workCeiling),
      residual: PRODUCTION_REPAIR_WORK_LIMITS.residual,
    },
  };
  const reply = await exchangeLocal(input.verifierPort, input.cancellation, message, (progress) => {
    const fraction = progress.total === 0 ? 1 : progress.attempted / progress.total;
    input.onProgress(0.55 + fraction * 0.25, 'repairing pinched vertices');
  });
  if (reply.kind === 'failed') {
    throw internalError('The local repair failed.', { details: { reason: reply.reason } });
  }
  const wire = reply.outcome;
  const patch = reply.patch;
  // The reply crossed a thread boundary. The kernel worker is our own code, but nothing the
  // authoritative worker builds a candidate from is trusted until its SHAPE has been checked.
  if (patch !== undefined) assertPatchShape(patch, input.mesh);
  const reasons = Object.entries(wire.counts.remainingByReason)
    .map(([reason, count]) => ({ reason, count }))
    .sort((x, y) => y.count - x.count || (x.reason < y.reason ? -1 : 1));
  const outcomeBase: LocalRepairOutcome = {
    kind: wire.kind as LocalRepairOutcomeKind,
    eligible: wire.counts.eligible,
    unsupportedNonManifoldEdge: wire.counts.unsupportedNonManifoldEdge,
    repaired: wire.counts.repaired,
    remaining: wire.counts.remaining,
    unattempted: wire.counts.unattempted,
    remainingByReason: reasons.slice(0, LOCAL_REPAIR_REASON_LIMIT),
    limitReached:
      wire.limitReached === undefined
        ? undefined
        : wire.limitReached === 'primary'
          ? LocalRepairWorkPhase.Primary
          : LocalRepairWorkPhase.Residual,
    work: wire.work,
    residual: {
      ran: wire.residual.ran,
      skippedBecause: wire.residual.skippedBecause,
      linkRetriangulations: wire.residual.linkRetriangulations,
      repairedAfterResidual: wire.residual.primaryAfterResidual,
      windingComponentsResolved: wire.residual.windingComponentsResolved,
      windingFacesReversed: wire.residual.windingFacesReversed,
    },
    facesRemoved: patch?.removedSourceFaces.length ?? 0,
    facesAppended: patch === undefined ? 0 : Math.floor(patch.appendedFaces.length / 3),
    facesReversed: patch?.flippedSourceFaces.length ?? 0,
    reasonsTruncated: reasons.length > LOCAL_REPAIR_REASON_LIMIT,
  };
  const discarded = (kind: LocalRepairOutcomeKind): LocalRepairStageResult => ({
    candidate: undefined,
    after: undefined,
    outcome: {
      ...outcomeBase,
      kind,
      repaired: 0,
      facesRemoved: 0,
      facesAppended: 0,
      facesReversed: 0,
    },
    candidateToInputFace: undefined,
    change: undefined,
  });
  if (wire.cancelled) throw operationCancelled('Repair was cancelled.');
  if (patch === undefined) {
    return {
      candidate: undefined,
      after: undefined,
      outcome: outcomeBase,
      candidateToInputFace: undefined,
      change: undefined,
    };
  }

  /* ---- the candidate and its independent verdict ---- */
  input.throwIfCancelled();
  input.onProgress(0.82, 'building candidate');
  const built = applyLocalRepairPatch(input.mesh, patch);
  assertMeshStructure(built.mesh, 'repair/create-candidate');
  input.onProgress(0.85, 'validating candidate');
  const after = analyseTopology(built.mesh, {
    documentId: input.documentId,
    documentRevision: input.revision,
    partId: input.partId,
    cancellation: input.cancellation,
    sampleLimit: 4096,
    onProgress: ({ fraction }) => {
      input.onProgress(0.85 + fraction * 0.1, 'validating candidate');
    },
  }).report;
  const regressions = judgeLocalRepair(input.report, after);
  if (regressions.length > 0) {
    // A candidate the engine stood behind and the independent analysis did not: discard it.
    // Reported as no change, never as a repair.
    return discarded(LocalRepairOutcomeKind.NoChange);
  }
  return {
    candidate: built.mesh,
    after,
    outcome: outcomeBase,
    candidateToInputFace: built.candidateToSourceFace,
    change: describeChange(patch, built.mesh, built.appendedFaceCount, LOCAL_CHANGE_FACE_LIMIT),
  };
}

/**
 * Posts the request and waits for the result, forwarding bounded progress. Settles on
 * cancellation too: a verifier terminated mid-repair never answers.
 */
async function exchangeLocal(
  port: ProtocolPort,
  cancellation: CancellationToken,
  message: LocalRepairMessage,
  onProgress: (progress: Extract<LocalRepairReply, { kind: 'local-repair-progress' }>) => void,
): Promise<
  | Extract<LocalRepairReply, { kind: 'local-repair-result' }>
  | Extract<LocalRepairReply, { kind: 'failed' }>
> {
  const channel = port as unknown as MessagePort;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      settled = true;
      channel.onmessage = null;
      unsubscribe();
    };
    const unsubscribe = cancellation.onCancelled(() => {
      if (settled) return;
      finish();
      reject(operationCancelled('Repair was cancelled.'));
    });
    channel.onmessage = (event: MessageEvent<LocalRepairReply>): void => {
      if (settled) return;
      const data = event.data;
      if (data.kind === 'local-repair-progress') {
        onProgress(data);
        return;
      }
      finish();
      // The reply is typed, but it crossed a thread boundary: compare as a plain string.
      const kind: string = data.kind;
      if (kind !== 'local-repair-result' && kind !== 'failed') {
        reject(internalError('The local repair answered with an unrecognised message.'));
        return;
      }
      resolve(data);
    };
    channel.start();
    if (cancellation.isCancelled) {
      finish();
      reject(operationCancelled('Repair was cancelled.'));
      return;
    }
    channel.postMessage(message, [message.positions.buffer, message.indices.buffer]);
  });
}
