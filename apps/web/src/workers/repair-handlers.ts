import {
  assertGeometryDocument,
  assertMeshStructure,
  computeBounds,
  documentTriangleCount,
  documentVertexCount,
  meshByteLength,
  triangleCount,
  withPartMesh,
} from '@cadfixer/mesh-core';
import type { CanonicalMesh, GeometryDocument, PartId } from '@cadfixer/mesh-core';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import { analyseTopology, estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import {
  executeConservativeRepair,
  planConservativeRepair,
  RepairAcceptance,
  RepairCancelled,
  VolumeComparison,
} from '@cadfixer/mesh-repair';
import {
  LocalRepairNotRun,
  NO_BOUNDARY_FILL_PLAN,
  UndoableChangeKind,
  documentByteLength,
  isDocument,
  isPart,
  requestRepairPeak,
  type DocumentHandle,
  type OperationContext,
  type OperationHandler,
  type PartDescriptor,
  type DocumentRenderSnapshot,
  type RenderSnapshot,
} from '@cadfixer/geometry-runtime';
import {
  invalidState,
  isAppError,
  operationCancelled,
  type CancellationToken,
  type resourceLimitExceeded,
} from '@cadfixer/shared';
import {
  buildRenderSnapshot,
  buildDocumentRenderSnapshot,
  documentRenderTransferables,
  describeParts,
  holeFillCandidates,
  geometryEdits,
  splitCandidates,
  repairCandidates,
  repairHistory,
  residentDocuments,
  topologyReports,
  yieldToEventLoop,
} from './stl-handlers';
import {
  fillPlanKey,
  planBoundaryFill,
  releaseFillPlans,
  runFillStage,
  verifyFillPlan,
} from './boundary-fill';
import {
  NOT_REQUESTED_LOCAL_REPAIR_PLAN,
  planLocalRepairFor,
  releaseLocalRepairPlans,
  runLocalRepairStage,
  type LocalRepairStageResult,
} from './local-repair-stage';

/**
 * WORKER HANDLERS FOR CONSERVATIVE REPAIR.
 *
 * FIVE OPERATIONS, NOT ONE. Planning must be observable without allocating a
 * candidate; applying must be a separate, explicitly confirmed act; and undoing
 * must be its own transaction rather than a view the UI can fake. A single
 * `repair/apply` would make preview impossible and would make an accidental
 * resend destructive.
 *
 * `model/analyze` is untouched. Analysis stays read-only; hiding a repair verb
 * inside it would make every diagnosis a potential mutation.
 *
 * THE AUTHORITATIVE MODEL IS NEVER WRITTEN except by `repair/commit` and
 * `repair/undo`, and only after every guard in `RepairCandidateStore` or
 * `RepairHistoryStore` has passed. A failure at any earlier point leaves the
 * current revision exactly as it was.
 *
 * NO GEOMETRY KERNEL. These are CAD Fixer's own exact-topology operations. No
 * Manifold, Geogram or PMP code is imported here or anywhere in the
 * application — the bundle scan checks it.
 */

/**
 * Builds the document that a part-level replacement produces.
 *
 * STRUCTURAL SHARING IS THE POINT, and it is why this goes through
 * `withPartMesh` rather than rebuilding a document literal: every part other
 * than the repaired one is carried across BY REFERENCE — the same
 * `GeometryPart`, the same `CanonicalMesh`, the same buffers. Repairing one
 * part of a hundred-part document allocates one part record and an array of a
 * hundred references, never a hundred copies of geometry.
 *
 * Unit, order, ids and every placement are untouched: a repair changes one
 * part's triangles and nothing else about the document.
 */
function successorDocument(
  document: GeometryDocument,
  part: PartId,
  mesh: CanonicalMesh,
  operation: string,
): GeometryDocument {
  const next = withPartMesh(document, part, mesh);
  if (next === undefined) {
    throw invalidState('That part is no longer in this model.', { partId: part, operation });
  }
  /*
   * Rule 11 at the DOCUMENT level. `assertMeshStructure` has already cleared
   * the replacement mesh; this checks what only the document can be asked —
   * that ids are still unique, placements still finite, and the result still
   * inside the resource ceilings. Meshes are not re-walked: every one of them
   * was validated when it was admitted, and the only new mesh here was
   * validated moments ago.
   */
  assertGeometryDocument(next, operation, { validateMeshes: false });
  return next;
}

/**
 * Peak the repair will hold: M0 and the candidate coexist by design.
 *
 * REFUSAL HAPPENS HERE, before any bulk array exists. `callerCeilingBytes` may
 * only narrow the product ceiling — `requestRepairPeak` enforces that — so a
 * message can make CAD Fixer more cautious and never less.
 */
function preflight(
  operation: string,
  mesh: CanonicalMesh,
  faceCount: number,
  callerCeilingBytes: number | undefined,
): ReturnType<typeof resourceLimitExceeded> | undefined {
  const authoritative = meshByteLength(mesh);
  const workspace = estimateTopologyWorkspaceBytes(faceCount, faceCount * 3);
  // Authoritative + candidate + connectivity + validation workspace.
  const peak = authoritative * 2 + faceCount * 3 * 24 + workspace;
  return requestRepairPeak(operation, peak, { faceCount, peak }, callerCeilingBytes);
}

/**
 * The topology report a repair is planned from.
 *
 * Reuses the cached report for this exact revision when there is one, and
 * analyses otherwise. Geometry at a revision is immutable — `replace` produces a
 * new revision rather than mutating in place — so a cached report describes
 * precisely the mesh this handle resolves to. The cache compares the revision
 * rather than assuming it, so a report for an earlier revision is never reused.
 *
 * Without this, opening the repair workflow analysed the model a second time and
 * building a candidate analysed it a third, all to reproduce the report the
 * application had already shown the user.
 */
function reportFor(
  mesh: CanonicalMesh,
  handle: DocumentHandle,
  part: PartId,
  cancellation: CancellationToken,
  onProgress?: (fraction: number) => void,
): TopologyReport {
  const cached = topologyReports.get(handle, part);
  if (cached !== undefined) return cached;

  /*
   * PROGRESS IS FORWARDED, because on a large model this analysis is most of
   * the wait. Without it the repair panel sat at 0% for the majority of a
   * repair and then jumped to a finished preview, which reads as a frozen
   * application and hides the phase a user is most likely to want to cancel.
   */
  const report = analyseTopology(mesh, {
    documentId: handle.documentId,
    documentRevision: handle.revision,
    partId: part,
    cancellation,
    ...(onProgress === undefined
      ? {}
      : {
          onProgress: ({ fraction }: { fraction: number }): void => {
            onProgress(fraction);
          },
        }),
  }).report;
  topologyReports.set(handle, part, report);
  return report;
}

/**
 * Refuses a repair that cannot be interrupted.
 *
 * FAIL CLOSED, DEFENCE IN DEPTH. The application already withholds the repair
 * controls when the document is not cross-origin isolated, so in a correct
 * deployment this never fires. It exists for the case the application boundary
 * cannot cover: a request that reaches the worker WITHOUT a shared control word,
 * whether through a forged message, a future caller that forgets to opt in, or a
 * regression that drops the flag.
 *
 * WHY REFUSING BEATS RUNNING. Conservative repair's contract is that a running
 * repair can be stopped. Message-only cancellation cannot stop a synchronous
 * pass, so proceeding would present a Cancel control that silently does nothing
 * on exactly the large models where it matters most. A refusal with a reason is
 * honest; a Cancel button that lies is not.
 *
 * `INVALID_STATE` rather than `INTERNAL_ERROR`: the request is well-formed and
 * CAD Fixer is not broken — it simply cannot be honoured in this context.
 */
function requireInterruptible(context: OperationContext): void {
  if (context.interruptible) return;
  throw invalidState(
    'Conservative repair needs an interruptible cancellation signal, which this context cannot provide. Pybrix must be served cross-origin isolated (COOP and COEP) so SharedArrayBuffer is available.',
  );
}

/**
 * Converts the engine's cancellation class into the protocol's cancellation
 * error, WHEREVER in a handler it was thrown.
 *
 * WHY THIS IS A WHOLE-HANDLER CONCERN AND NOT A SINGLE CALL'S. `RepairCancelled`
 * is thrown by any engine loop that polls, and since Stage 3B-1C that includes
 * the PREPARATION performed inside `planConservativeRepair`, not only the
 * pipeline inside `executeConservativeRepair`. A conversion wrapped around just
 * the pipeline let a cancel observed during preparation escape as an
 * unrecognised class, which `toAppError` then reported as an internal failure —
 * so cancelling a repair surfaced as an ERROR in the panel rather than as a
 * cancellation. A refusal is not an error, and neither is a cancellation.
 *
 * Placed at the handler boundary so every present and future engine call is
 * covered by construction rather than by remembering to wrap it.
 */
function rethrowAsProtocolError(cause: unknown): never {
  if (cause instanceof RepairCancelled) throw operationCancelled('Repair was cancelled.');
  throw cause;
}

/**
 * The combined result of conservative repair and the fill stage — REPAIR-CORE-02.
 *
 * ONE CANDIDATE, ONE VALIDATION, and the validation describes the change from
 * the SOURCE the user has to the candidate they would get: `before` is the
 * source's report, `after` is Stage 2's independent analysis of the filled
 * candidate. The fill stage has already held that analysis to its exact
 * prediction, and conservative repair held its own stage to its own; nothing
 * here decides acceptance, it only records it.
 *
 * VOLUME IS NOT COMPARED. Closing an opening changes whether a signed volume
 * means anything at all, so the comparison is reported as not interpretable
 * rather than as a change someone should worry about.
 */
function combineWithFill(
  conservative: ReturnType<typeof executeConservativeRepair>,
  sourceReport: TopologyReport,
  candidate: CanonicalMesh,
  after: TopologyReport,
  survivorMap: Uint32Array | undefined,
): ReturnType<typeof executeConservativeRepair> {
  const base = conservative.validation;
  const before = sourceReport;
  return {
    ...conservative,
    candidate,
    validation: {
      ...base,
      acceptance: RepairAcceptance.Accepted,
      before,
      after,
      deltas: {
        triangles: after.sourceFaceCount - before.sourceFaceCount,
        topologicalVertices: after.topologicalVertexCount - before.topologicalVertexCount,
        components: after.componentCount - before.componentCount,
        boundaryEdges: after.boundaryEdgeCount - before.boundaryEdgeCount,
        nonManifoldEdges: after.nonManifoldEdgeCount - before.nonManifoldEdgeCount,
        nonManifoldVertices: after.nonManifoldVertexCount - before.nonManifoldVertexCount,
        windingConflicts: after.windingConflictEdgeCount - before.windingConflictEdgeCount,
        sameOrientationDuplicates:
          after.sameOrientationDuplicateCount - before.sameOrientationDuplicateCount,
        reversedOrientationDuplicates:
          after.reversedOrientationDuplicateCount - before.reversedOrientationDuplicateCount,
        repeatedPositionFaces: after.repeatedPositionFaceCount - before.repeatedPositionFaceCount,
        zeroAreaFaces: after.zeroAreaFaceCount - before.zeroAreaFaceCount,
      },
      structurallyValid: true,
      surfaceAreaBefore: before.totalSurfaceArea,
      surfaceAreaAfter: after.totalSurfaceArea,
      signedVolumeBefore: before.totalSignedVolume,
      signedVolumeAfter: after.totalSignedVolume,
      volumeComparison: VolumeComparison.NotInterpretable,
      boundsAfter: computeBounds(candidate),
      regressions: [],
    },
    counts: {
      ...conservative.counts,
      candidateFaceCount: triangleCount(candidate),
    },
    // Patch faces have no source face; the map describes the prefix. A local repair changes which
    // source faces survive, so it supplies the map; otherwise conservative's still holds.
    candidateToSourceFace: survivorMap ?? conservative.candidateToSourceFace,
  };
}

const runRepairPlan: OperationHandler<'repair/plan'> = async (payload, context) => {
  requireInterruptible(context);
  const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
  if (!isPart(part)) throw part;
  const resolved = part.mesh;

  const faceCount = triangleCount(resolved);
  const refusal = preflight('repair/plan', resolved, faceCount, payload.memoryBudgetBytes);
  if (refusal) throw refusal;

  context.reportProgress(0, 'planning repair');
  const report = reportFor(resolved, payload.handle, part.id, context.cancellation, (fraction) => {
    context.reportProgress(fraction * 0.9, 'analysing');
  });

  // Yield once so a cancel queued during the analysis is observed rather than
  // being overtaken by the result. Planning allocates no candidate, so this is
  // the only window it needs.
  await yieldToEventLoop();
  context.throwIfCancelled();

  const { plan } = planConservativeRepair({
    mesh: resolved,
    report,
    documentId: payload.handle.documentId,
    partId: part.id,
    sourceRevision: payload.handle.revision,
    requested: payload.requested,
    cancellation: context.cancellation,
    ...(payload.memoryBudgetBytes === undefined
      ? {}
      : { memoryBudgetBytes: payload.memoryBudgetBytes }),
  });

  /*
   * REPAIR-CORE-02: what automatic filling would attempt, decided here from the
   * compact scan. Cached per revision, so replanning after an option toggle
   * does not rescan a part that has not changed.
   */
  let boundaryFill = NO_BOUNDARY_FILL_PLAN;
  if (payload.fillOpenings === true) {
    const fillKey = fillPlanKey(payload.handle.documentId, payload.handle.revision, part.id);
    const throwIfCancelled = (): void => {
      context.throwIfCancelled();
    };
    let record = planBoundaryFill(fillKey, resolved, throwIfCancelled);
    /*
     * REPAIR-RC-03: an admitted opening is not yet a fillable one. With a
     * verifier channel the exact check runs here, so the count the user is
     * shown is the count that will fill. Without one the plan says so
     * (`verified: false`) and nothing is presented as fillable.
     */
    if (!record.plan.verified && payload.verifierPort !== undefined) {
      context.reportProgress(0.95, 'checking openings');
      record = await verifyFillPlan(fillKey, record, {
        verifierPort: payload.verifierPort,
        operationId: `${fillKey}/plan`,
        cancellation: context.cancellation,
        throwIfCancelled,
      });
    }
    boundaryFill = record.plan;
  }
  /*
   * REPAIR-CORE-06A: what the local pinch repair would attempt, from topology alone and cached
   * per revision. It decides nothing about success: the meter that runs during the repair does.
   */
  const localRepair =
    payload.localRepair === true
      ? planLocalRepairFor(
          fillPlanKey(payload.handle.documentId, payload.handle.revision, part.id),
          resolved,
          () => {
            context.throwIfCancelled();
          },
        )
      : undefined;
  context.reportProgress(1, 'planned');

  return {
    value: {
      handle: payload.handle,
      partId: part.id,
      plan,
      boundaryFill,
      ...(localRepair === undefined ? {} : { localRepair }),
    },
  };
};

/**
 * CANCELLATION, and what it can honestly mean here.
 *
 * A worker handler that never returns to the event loop cannot be cancelled: the
 * cancel arrives as a MESSAGE, and the message queue is not read while a
 * synchronous handler is running, so a polled flag never changes. The repair
 * pipeline is synchronous by design — it is one deterministic pass that either
 * produces a validated candidate or does not — so this handler is `async` and
 * yields at the points where a decision can still be unmade.
 *
 * WHAT THE USER GETS. A cancel is observed at the next yield, and no candidate is
 * ever REGISTERED: the pipeline's output is dropped on the floor and the store
 * never learns it existed. So "cancelled" means exactly what it says — no
 * preview, nothing committable, nothing resident, and the model untouched.
 *
 * WHAT CHANGED IN STAGE 3B-1C. The pass is no longer merely discarded once it
 * finishes: the engine's substantial loops poll a SHARED cancellation word, so a
 * cancel is observed from inside the work itself and the pass unwinds partway
 * through. `processed < total` is asserted by test rather than assumed. The
 * yields below still matter — they are what guarantee no candidate is ever
 * registered — but they are no longer the only place a cancel can be seen.
 *
 * WHAT IT STILL DOES NOT MEAN. Cancellation remains COOPERATIVE. A section with
 * no poll runs to its end, so latency is bounded by the longest unpolled span
 * rather than being instantaneous.
 */
const runRepairCreateCandidate: OperationHandler<'repair/create-candidate'> = async (
  payload,
  context,
) => {
  requireInterruptible(context);
  const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
  if (!isPart(part)) throw part;
  const resolved = part.mesh;

  const faceCount = triangleCount(resolved);
  const refusal = preflight(
    'repair/create-candidate',
    resolved,
    faceCount,
    payload.memoryBudgetBytes,
  );
  if (refusal) throw refusal;

  context.reportProgress(0, 'analysing');
  const report = reportFor(resolved, payload.handle, part.id, context.cancellation, (fraction) => {
    context.reportProgress(fraction * 0.2, 'analysing');
  });

  // The first cancellation window: analysis is the longest phase before any
  // candidate memory is touched, so a cancel arriving during it is honoured
  // before the pipeline allocates anything at all.
  await yieldToEventLoop();
  context.throwIfCancelled();

  const { plan, view, prepared } = planConservativeRepair({
    mesh: resolved,
    report,
    documentId: payload.handle.documentId,
    partId: part.id,
    sourceRevision: payload.handle.revision,
    requested: payload.requested,
    cancellation: context.cancellation,
    ...(payload.memoryBudgetBytes === undefined
      ? {}
      : { memoryBudgetBytes: payload.memoryBudgetBytes }),
  });

  /*
   * COMMIT WHAT WAS PREVIEWED. The caller names the plan it saw; if a freshly
   * computed plan differs, the model or the request changed underneath it and
   * building a candidate would silently apply something else.
   */
  if (plan.planHash !== payload.planHash) {
    throw invalidState('The model changed since this repair was planned.', {
      expected: payload.planHash,
      computed: plan.planHash,
    });
  }

  /*
   * FILL WHAT WAS PREVIEWED — REPAIR-CORE-02. The admitted set the user saw is
   * bound by its hash; a different set now means the source changed.
   */
  const fillRequested = payload.fillOpenings === true;
  const fillKey = fillPlanKey(payload.handle.documentId, payload.handle.revision, part.id);
  let sourceFill = fillRequested
    ? planBoundaryFill(fillKey, resolved, () => {
        context.throwIfCancelled();
      })
    : undefined;
  // A verified plan evicted from the cache is re-verified before comparison:
  // the check is deterministic, so the same geometry reaches the same hash.
  if (sourceFill !== undefined && !sourceFill.plan.verified && payload.verifierPort !== undefined) {
    sourceFill = await verifyFillPlan(fillKey, sourceFill, {
      verifierPort: payload.verifierPort,
      operationId: `${fillKey}/plan`,
      cancellation: context.cancellation,
      throwIfCancelled: () => {
        context.throwIfCancelled();
      },
    });
  }
  if (sourceFill !== undefined && sourceFill.plan.planHash !== payload.fillPlanHash) {
    throw invalidState('The model changed since this repair was planned.', {
      expected: payload.fillPlanHash ?? 'none',
      computed: sourceFill.plan.planHash,
    });
  }

  /*
   * LOCAL REPAIR WHAT WAS PREVIEWED — REPAIR-CORE-06A. Bound by hash exactly like the fill plan.
   */
  const localRequested = payload.localRepair === true;
  if (localRequested) {
    const computed = planLocalRepairFor(fillKey, resolved, () => {
      context.throwIfCancelled();
    }).planHash;
    const expected = payload.localRepairPlanHash ?? NOT_REQUESTED_LOCAL_REPAIR_PLAN.planHash;
    if (computed !== expected) {
      throw invalidState('The model changed since this repair was planned.', {
        expected,
        computed,
      });
    }
  }

  // Cancellation thrown from here — or from the preparation above — is converted
  // at the handler boundary by `rethrowAsProtocolError`. M0 is untouched either
  // way: the pipeline only ever wrote to a candidate.
  const conservative = executeConservativeRepair({
    source: resolved,
    plan,
    sourceReport: report,
    cancellation: context.cancellation,
    documentId: payload.handle.documentId,
    partId: part.id,
    revision: payload.handle.revision,
    view,
    prepared,
    ...(payload.sampleLimit === undefined ? {} : { sampleLimit: payload.sampleLimit }),
    onProgress: (fraction, note) => {
      context.reportProgress(fraction, note);
    },
  });

  /*
   * THE FILL STAGE — REPAIR-CORE-02. It runs on what conservative repair
   * produced (or on the source, when that was a no-op) and only when that
   * result was ACCEPTED: filling never rescues a rejected candidate. The
   * combined result is ONE candidate, applied atomically and undone as one.
   */
  const conservativeAccepted =
    conservative.candidate !== undefined &&
    conservative.validation.acceptance === RepairAcceptance.Accepted;
  const conservativeRan = conservative.validation.acceptance !== RepairAcceptance.NoOp;
  const fillBase: CanonicalMesh | undefined = conservativeAccepted
    ? conservative.candidate
    : conservativeRan
      ? undefined
      : resolved;
  /*
   * THE LOCAL PINCH REPAIR — REPAIR-CORE-06A. On what conservative repair produced (or the
   * source), and only when that was not rejected. Its candidate, if any, is the base the fill
   * stage then works on, so the result is still ONE candidate, applied atomically, undone as one.
   */
  const baseReport: TopologyReport | undefined =
    fillBase === undefined
      ? undefined
      : fillBase === resolved
        ? report
        : conservative.validation.after;
  const local: LocalRepairStageResult | undefined =
    localRequested && fillBase !== undefined && baseReport !== undefined
      ? await runLocalRepairStage({
          mesh: fillBase,
          report: baseReport,
          verifierPort: payload.verifierPort,
          operationId: `${payload.handle.documentId}@${String(payload.handle.revision)}/${part.id}/local`,
          documentId: payload.handle.documentId,
          partId: part.id,
          revision: payload.handle.revision,
          cancellation: context.cancellation,
          throwIfCancelled: () => {
            context.throwIfCancelled();
          },
          onProgress: (fraction, note) => {
            context.reportProgress(fraction, note);
          },
        })
      : undefined;
  const localNotRun: LocalRepairNotRun | undefined = !localRequested
    ? undefined
    : fillBase === undefined
      ? LocalRepairNotRun.ConservativeRejected
      : payload.verifierPort === undefined
        ? LocalRepairNotRun.NoVerifier
        : undefined;
  const afterLocal: CanonicalMesh | undefined = local?.candidate ?? fillBase;
  const afterLocalReport: TopologyReport | undefined =
    local?.candidate === undefined ? baseReport : local.after;
  // Faces of the source that survive into `afterLocal`, in its order, when it is not the source.
  const conservativeMap = conservative.candidateToSourceFace;
  const localMap: Uint32Array | undefined =
    local?.candidateToInputFace === undefined
      ? undefined
      : fillBase === resolved || conservativeMap === undefined
        ? local.candidateToInputFace
        : local.candidateToInputFace.map((inputFace) => conservativeMap[inputFace] ?? 0);
  const fill =
    fillRequested && afterLocal !== undefined && afterLocalReport !== undefined
      ? await runFillStage({
          mesh: afterLocal,
          report: afterLocalReport,
          record: afterLocal === resolved ? sourceFill : undefined,
          verifierPort: payload.verifierPort,
          operationId: `${payload.handle.documentId}@${String(payload.handle.revision)}/${part.id}`,
          documentId: payload.handle.documentId,
          partId: part.id,
          revision: payload.handle.revision,
          cancellation: context.cancellation,
          throwIfCancelled: () => {
            context.throwIfCancelled();
          },
          onProgress: (fraction, note) => {
            context.reportProgress(fraction, note);
          },
        })
      : undefined;
  const outcome =
    fill?.candidate !== undefined && fill.after !== undefined
      ? combineWithFill(conservative, report, fill.candidate, fill.after, localMap)
      : local?.candidate !== undefined && local.after !== undefined
        ? combineWithFill(conservative, report, local.candidate, local.after, localMap)
        : conservative;

  /*
   * THE SECOND CANCELLATION WINDOW, and the load-bearing one. It sits BEFORE the
   * candidate is registered, so a cancel that arrives while the pipeline was
   * running leaves nothing in the store: no handle to commit, no geometry
   * resident, no preview. Yielding after registration would have created a
   * candidate that only a discard could clean up, and a cancel that leaks memory
   * is not a cancel.
   */
  await yieldToEventLoop();
  if (context.cancellation.isCancelled) throw operationCancelled('Repair was cancelled.');

  // A rejected or no-op result registers NO candidate, so there is nothing
  // committable lying around for a caller to find.
  const candidate =
    outcome.candidate !== undefined && outcome.validation.acceptance === RepairAcceptance.Accepted
      ? repairCandidates.create(payload.handle, part.id, outcome.candidate, outcome.validation)
      : undefined;

  /*
   * FILL-ONLY CANDIDATES SEND THE PATCH, NOT THE PART — REPAIR-CORE-02. When
   * conservative repair changed nothing, the candidate is the source plus
   * appended faces, so the preview needs only those faces. A full snapshot of
   * a 2M-triangle part is ~144 MB and a multi-second upload for a change of a
   * few dozen triangles.
   */
  const fillOnly =
    outcome.candidate !== undefined &&
    fill?.candidate === outcome.candidate &&
    afterLocal === resolved;
  const render: RenderSnapshot | undefined =
    outcome.candidate === undefined || fillOnly
      ? undefined
      : buildRenderSnapshot(outcome.candidate);
  const patchRender: RenderSnapshot | undefined = fillOnly
    ? buildRenderSnapshot({
        positions: outcome.candidate.positions,
        indices: outcome.candidate.indices.subarray(resolved.indices.length),
        metadata: outcome.candidate.metadata,
      })
    : undefined;

  return {
    value: {
      candidate,
      source: payload.handle,
      partId: part.id,
      plan,
      validation: outcome.validation,
      counts: outcome.counts,
      samples: outcome.samples,
      // WHAT UNDO WILL RETAIN if this candidate is applied — Stage 4B-1C. The
      // record holds the SOURCE mesh, so the number is that mesh's size rather
      // than a patch's.
      undoRetainedBytes: meshByteLength(resolved),
      candidateBounds:
        outcome.candidate === undefined ? undefined : computeBounds(outcome.candidate),
      render,
      boundaryFill: fill?.outcome,
      ...(local === undefined ? {} : { localRepair: local.outcome }),
      ...(localNotRun === undefined ? {} : { localRepairNotRun: localNotRun }),
      patchRender,
    },
    transfer: [render, patchRender].flatMap((snapshot) =>
      snapshot === undefined ? [] : [snapshot.positions.buffer, snapshot.normals.buffer],
    ),
  };
};

/*
 * THE EXPORTED HANDLERS. Each wraps its implementation so that a cancellation
 * observed anywhere inside — preparation, the pipeline, or the candidate's
 * revalidation — reaches the protocol as OPERATION_CANCELLED rather than as an
 * internal error.
 */

export const repairPlanHandler: OperationHandler<'repair/plan'> = async (payload, context) => {
  try {
    return await runRepairPlan(payload, context);
  } catch (cause) {
    return rethrowAsProtocolError(cause);
  }
};

export const repairCreateCandidateHandler: OperationHandler<'repair/create-candidate'> = async (
  payload,
  context,
) => {
  try {
    return await runRepairCreateCandidate(payload, context);
  } catch (cause) {
    return rethrowAsProtocolError(cause);
  }
};

/**
 * The fallible work `repair/commit` performs, INJECTED so its failure can be
 * exercised.
 *
 * The construction seam Stage 4B-1B2-R2 established for hole filling, applied
 * here for the same reason: source order proves the statements are in an order,
 * not that the handler behaves when one of them actually fails.
 * `PRODUCTION_COMMIT_WORK` is the only value the application ever uses.
 */
export interface RepairCommitWork {
  readonly buildRenderSnapshot: (mesh: CanonicalMesh) => RenderSnapshot;
  readonly describeParts: (document: GeometryDocument) => readonly PartDescriptor[];
}

export const PRODUCTION_COMMIT_WORK: RepairCommitWork = { buildRenderSnapshot, describeParts };

/**
 * Applies one validated repair candidate. THE ONLY CONSERVATIVE-REPAIR MUTATION.
 *
 * TWO PROPERTIES THIS ORDERING EXISTS FOR — Stage 4B-1C.
 *
 * ONE: THE PREVIOUS MESH IS RETAINED, NOT DESCRIBED. The undo record holds the
 * `CanonicalMesh` object the part had. It used to hold a PATCH of the removed
 * triangles and rebuild the mesh from it, which returned an indexed model as
 * triangle soup and turned one shared mesh into two byte-equal ones. Retaining
 * an immutable object is O(1) — see `UndoableInverse`.
 *
 * TWO: EVERY FALLIBLE PIECE OF THE ANSWER IS BUILT BEFORE THE SWAP.
 * `buildRenderSnapshot` allocates megabytes for a large part and can fail; when
 * it ran after `replace`, its failure threw out of the handler, the worker host
 * turned that into an ordinary error reply, and the caller was told the repair
 * had FAILED while the document had already changed. "The worker's internal
 * state was consistent" is not the guarantee that matters — the guarantee is
 * what the caller may observe, because the interface acts on it.
 *
 * Preparing early cannot introduce a stale race: `replace` compares the revision
 * against the store itself and is the only arbiter, so an answer built against a
 * document the user has moved off is discarded rather than installed. A prepared
 * snapshot is not authoritative either — it is disposable render data derived
 * from a document that does not exist yet.
 *
 * A REFUSAL AT ANY STEP LEAVES THE CANDIDATE RESOLVED AND RETRYABLE. Consuming
 * it before the swap succeeded would destroy a valid repair over a transient
 * race.
 */
export function createRepairCommitHandler(
  work: RepairCommitWork,
): OperationHandler<'repair/commit'> {
  return (payload, context) => {
    const source = residentDocuments.resolve(payload.expectedSource);
    if (!isDocument(source)) throw source;

    const currentRevision = residentDocuments.revisionOf(payload.expectedSource.documentId);
    const prepared = repairCandidates.prepareCommit(
      {
        candidate: payload.candidate,
        expectedSource: payload.expectedSource,
        expectedPart: payload.expectedPart as PartId,
        planHash: payload.planHash,
      },
      currentRevision,
    );
    if (isAppError(prepared)) throw prepared;

    const repairedPart = payload.candidate.partId;
    const validation = repairCandidates.validationOf(payload.candidate);

    /*
     * THE PRE-REPAIR MESH, captured BEFORE the swap, for the undo record.
     *
     * THE OBJECT ITSELF. Read from the RESIDENT part rather than reconstructed
     * from anything, so the record holds the geometry that is actually being
     * replaced — indexing, sharing and all.
     */
    const currentPart = source.parts.find((part) => part.id === repairedPart);
    if (currentPart === undefined) {
      throw invalidState('That part is no longer in this model.', {
        partId: repairedPart,
        operation: 'repair/commit',
      });
    }
    const previousMesh = currentPart.mesh;

    const successor = successorDocument(source, repairedPart, prepared, 'repair/commit');

    /* ---- EVERYTHING THAT CAN FAIL, BEFORE ANYTHING CHANGES ---- */
    const render = work.buildRenderSnapshot(prepared);
    const parts = work.describeParts(successor);
    const residentBytes = documentByteLength(successor);
    const totalTriangles = documentTriangleCount(successor);
    const totalVertices = documentVertexCount(successor);
    const bounds = computeBounds(prepared);
    const inverse = {
      previousMesh,
      sourceFaceCount: triangleCount(previousMesh),
      sourceIndexCount: previousMesh.indices.length,
      byteLength: meshByteLength(previousMesh),
    };

    // Reported BEFORE the swap and worded for what is true at this moment.
    // Saying "applied" here would claim something that has not happened; saying
    // it afterwards would put a fallible transport call inside the committed
    // region.
    context.reportProgress(0.9, 'applying');

    /* ---- THE COMMIT. Nothing below may fail. ---- */
    const next = residentDocuments.replace(payload.expectedSource, successor);
    if (isAppError(next)) throw next;
    repairCandidates.markCommitted(payload.candidate);

    // Deterministic identity: lineage, parent and plan. NOT a wall clock — two
    // repairs a millisecond apart must still be distinguishable by what they
    // did, not by when they happened.
    const repairRecordId = `${next.documentId}/${repairedPart}@${String(payload.expectedSource.revision)}->${String(next.revision)}#${payload.planHash}`;

    const entry = repairHistory.record({
      recordId: repairRecordId,
      kind: UndoableChangeKind.ConservativeRepair,
      source: payload.expectedSource,
      part: repairedPart,
      result: next,
      appliedOperations: validation?.applied ?? [],
      planHash: payload.planHash,
      inverse,
    });

    /*
     * A HOLE-FILL PREVIEW DOES NOT SURVIVE A REPAIR — Stage 4B-1B2. The commit
     * above moved the revision, so any candidate for this document was built
     * from geometry that is no longer authoritative and every guard in
     * `prepareCommit` would refuse it. Releasing it here frees a whole part's
     * geometry rather than leaving it resident until something notices.
     */
    holeFillCandidates.releaseDocument(next.documentId);
    geometryEdits.releaseDocument(next.documentId);
    releaseFillPlans(next.documentId);
    releaseLocalRepairPlans(next.documentId);

    return Promise.resolve({
      value: {
        handle: next,
        parentRevision: payload.expectedSource.revision,
        repairRecordId,
        partId: repairedPart,
        appliedOperations: validation?.applied ?? [],
        render,
        parts,
        residentBytes,
        // DOCUMENT totals: the panel reports the model the user now has, not
        // just the part that changed.
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
export const repairCommitHandler = createRepairCommitHandler(PRODUCTION_COMMIT_WORK);

export const repairDiscardHandler: OperationHandler<'repair/discard'> = (payload) => {
  return Promise.resolve({ value: { released: repairCandidates.discard(payload.candidate) } });
};

/**
 * UNDO — the inverse transaction, for whichever change was the most recent one.
 *
 * ONE UNDO, TWO KINDS OF CHANGE — Stage 4B-1B2. A conservative repair and a hole
 * fill are both recorded in `repairHistory`, and this reverses whichever of them
 * the document's single undoable record names. A separate hole-fill undo would
 * have been a second answer to "what does Undo do next", and two answers to that
 * question is how a user ends up undoing a change they did not make last.
 *
 * ONE RECONSTRUCTION FOR BOTH KINDS — Stage 4B-1C. Every record RETAINS THE
 * MESH the part held, and undo puts that same object back. It was two
 * mechanisms: hole filling retained a reference (Stage 4B-1B2-R1) and a repair
 * rebuilt from a patch of removed triangles. The rebuild reproduced the bytes
 * of a SOUP source and, for an indexed one, not even that — an indexed OBJ or
 * 3MF came back flattened, with a different vertex count and different bytes —
 * and in every case it produced a NEW object, so a document whose parts shared
 * one mesh came back holding two. Structural sharing and indexing are both part
 * of the document contract, so restoring bytes is not restoring the document.
 *
 * A NEW MONOTONIC REVISION, not a revival of the old one, for either kind.
 * Reactivating revision N after N+1 existed would make "is this handle stale?"
 * unanswerable: two different meshes would have worn the same revision number,
 * and every guard in the runtime is built on that number only ever moving
 * forwards. See ADR 0011.
 *
 * The result is validated like any other geometry output. A retained mesh was
 * authoritative when it was retained and has been immutable since — but rule 11
 * has no exemption for geometry we recognise, and "the record held the right
 * object" is a claim, not a check.
 *
 * AND UNDO IS OBSERVABLY ATOMIC — Stage 4B-1B2-R2. Every fallible piece of the
 * answer is built BEFORE the authoritative swap, so a caller can never be told
 * an undo failed after it succeeded.
 */
/**
 * The fallible work `repair/undo` performs, INJECTED so its failure can be
 * exercised.
 *
 * The same construction seam `createHoleFillCommitHandler` uses, and for the
 * same reason: source order proves the statements are in an order, not that the
 * handler behaves when one of them fails. `PRODUCTION_UNDO_WORK` is the only
 * value the application ever uses.
 */
export interface RepairUndoWork {
  readonly buildRenderSnapshot: (mesh: CanonicalMesh) => RenderSnapshot;
  readonly buildDocumentRenderSnapshot?: (document: GeometryDocument) => DocumentRenderSnapshot;
  readonly describeParts: (document: GeometryDocument) => readonly PartDescriptor[];
}

export const PRODUCTION_UNDO_WORK: RepairUndoWork = {
  buildRenderSnapshot,
  buildDocumentRenderSnapshot,
  describeParts,
};

export function createRepairUndoHandler(work: RepairUndoWork): OperationHandler<'repair/undo'> {
  return (payload, context) => {
    const current = residentDocuments.resolve(payload.handle);
    if (!isDocument(current)) throw current;

    const currentRevision = residentDocuments.revisionOf(payload.handle.documentId);
    const preparation = repairHistory.prepareUndo(
      payload.recordId,
      payload.handle,
      currentRevision,
    );
    if (isAppError(preparation)) throw preparation;

    /*
     * UNDO PUTS GEOMETRY BACK WHERE IT CAME FROM. The part is read from the
     * RECORD, not from anything the caller sent and not from whatever part the UI
     * happens to have selected — the patch was computed against one specific
     * part's mesh, and applying it to another would reconstruct nonsense.
     */
    const repairedPart = preparation.entry.partId;

    context.reportProgress(0.1, 'restoring previous version');
    const inverse = preparation.inverse;

    /*
     * BOTH KINDS RESTORE A REFERENCE — Stage 4B-1C.
     *
     * The record holds the object the part held before the change, so putting it
     * back restores the document's INDEXING and its SHARING as well as its
     * bytes: a sibling that still references it is once again sharing with this
     * part, and every layer that keys on mesh identity — the render snapshot's
     * per-mesh buffers, the GPU geometry, the 3MF object resources — follows
     * from that without anyone comparing coordinates.
     *
     * A repair used to rebuild from a patch here, which returned an indexed
     * model as soup and a shared mesh as two byte-equal copies. There is now ONE
     * reconstruction, so the two kinds cannot drift.
     */
    const restored = inverse.previousMesh;

    // Rule 11: the output of a geometry operation is validated before it is
    // accepted, no matter how confident the operation is. A retained mesh was
    // validated when it was admitted, and it is checked again here rather than
    // trusted — the rule does not have an exemption for geometry we recognise.
    assertMeshStructure(restored, 'repair/undo');

    /*
     * THE POSTCONDITION, and the reason the record keeps two counts it never
     * uses to rebuild anything. A retained reference is only correct if it is
     * the reference that was retained: comparing the mesh's own shape against
     * what the commit recorded catches a record wired to the wrong part or built
     * from the wrong mesh, at O(1), before it replaces geometry.
     */
    if (triangleCount(restored) !== inverse.sourceFaceCount) {
      throw invalidState('The restored model does not have the expected number of triangles.', {
        expected: inverse.sourceFaceCount,
        actual: triangleCount(restored),
      });
    }
    if (restored.indices.length !== inverse.sourceIndexCount) {
      throw invalidState('The retained previous version does not match what was recorded.', {
        expected: inverse.sourceIndexCount,
        actual: restored.indices.length,
      });
    }

    const successor =
      inverse.previousDocument ?? successorDocument(current, repairedPart, restored, 'repair/undo');

    /*
     * ---- EVERYTHING THAT CAN FAIL, BEFORE ANYTHING CHANGES ---- Stage 4B-1B2-R2.
     *
     * `buildRenderSnapshot` allocates: for a large part it copies megabytes and
     * derives per-vertex normals. When it ran AFTER the swap, its failure threw
     * out of the handler and the caller was told the UNDO had failed — while the
     * document had already been restored. A user told their undo failed will press
     * it again, or trust a screen that is showing the wrong revision.
     *
     * So the whole answer is built against the PROPOSED document first, and the
     * swap is the last thing that can go either way. `replace` re-checks the
     * revision itself, so preparing early cannot introduce a stale race: an answer
     * built against a document the user has moved off is discarded here.
     */
    const render = work.buildRenderSnapshot(restored);
    const documentRender = inverse.previousDocument
      ? work.buildDocumentRenderSnapshot?.(successor)
      : undefined;
    if (inverse.previousDocument && documentRender === undefined)
      throw invalidState('Split undo requires a whole-document render builder.');
    const parts = work.describeParts(successor);
    const residentBytes = documentByteLength(successor);
    const totalTriangles = documentTriangleCount(successor);
    const totalVertices = documentVertexCount(successor);
    const bounds = computeBounds(restored);

    /*
     * ---- THE COMMIT. Nothing below may fail. ----
     *
     * A bounded map write, another bounded map write, and an object literal built
     * from values that already exist.
     */
    const next = residentDocuments.replace(payload.handle, successor);
    if (isAppError(next)) throw next;
    repairHistory.markUndone(payload.recordId);
    // The revision moved, so any hole-fill candidate for this document is stale.
    holeFillCandidates.releaseDocument(next.documentId);
    geometryEdits.releaseDocument(next.documentId);
    splitCandidates.releaseDocument(next.documentId);

    return Promise.resolve({
      value: {
        handle: next,
        revertedRevision: payload.handle.revision,
        restoredRevision: preparation.entry.parentRevision,
        recordId: payload.recordId,
        kind: preparation.entry.kind,
        partId: repairedPart,
        appliedOperations: preparation.entry.appliedOperations,
        render,
        ...(documentRender === undefined ? {} : { documentRender }),
        parts,
        residentBytes,
        triangleCount: totalTriangles,
        vertexCount: totalVertices,
        bounds,
      },
      transfer:
        documentRender === undefined
          ? [render.positions.buffer, render.normals.buffer]
          : documentRenderTransferables(documentRender),
    });
  };
}

/** The application's undo handler. The only one the product ever registers. */
export const repairUndoHandler = createRepairUndoHandler(PRODUCTION_UNDO_WORK);
