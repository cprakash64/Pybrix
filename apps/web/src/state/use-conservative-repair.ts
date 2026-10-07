import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import {
  fillableOpeningCount,
  RepairAcceptance,
  type DocumentHandle,
  type RepairCandidateHandle,
  type RepairOperation,
} from '@cadfixer/geometry-runtime';
import {
  commitRepair,
  createRepairCandidate,
  discardRepairCandidate,
  planConservativeRepair,
  resolveRepairMemoryCeiling,
  resolveRepairWorkCeiling,
  undoRepair,
  type RepairCapableClient,
  type RepairMemoryCeiling,
  type RepairSession,
} from '../runtime/repair-service';
import { useGeometryClient } from '../runtime/client-context';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { presentAcceptance, RESOURCE_LIMIT_DETAIL } from './repair-presentation';
import { describeNoSafeChange, NO_SAFE_CHANGE_CODE } from './repair-preview-summary';
import {
  describeAppliedActivity,
  describeAppliedChanges,
  describeFillFailure,
} from './repair-workspace-presentation';
import {
  AnalysisState,
  RepairCandidateState,
  RepairCommitState,
  RepairPlanState,
  StatusSeverity,
  type RepairFailure,
  type RepairPreviewMode,
  type RepairToken,
} from './workspace-store';

/**
 * Binds the repair service to the workspace store.
 *
 * WHAT THIS OWNS: when a plan is requested, when a candidate is built, when a
 * candidate is released, and how a worker error becomes a sentence. What it does
 * NOT own is the transaction — every guard that decides whether a repair may
 * become authoritative lives in the worker, and this hook cannot reach past it.
 * A bug here can waste work or show the wrong label; it cannot apply a repair
 * the runtime refused.
 *
 * PLANNING IS AUTOMATIC, for the same reason analysis is: making a user press a
 * button to discover whether their model can be repaired puts a click between
 * them and the answer they came for. Planning allocates no candidate and mutates
 * nothing — that is exactly why it is safe to do on arrival.
 *
 * PREVIEWING AND APPLYING ARE NOT AUTOMATIC, for the opposite reason. One
 * allocates a second copy of the model; the other changes the user's geometry.
 */

export interface ConservativeRepairControls {
  readonly previewRepair: () => void;
  readonly cancelPreview: () => void;
  readonly discardPreview: () => void;
  readonly applyRepair: () => void;
  readonly undoLastRepair: () => void;
  readonly setOperationSelected: (operation: RepairOperation, selected: boolean) => void;
  /** Include or exclude automatic opening fills — REPAIR-CORE-02. */
  readonly setFillOpenings: (fill: boolean) => void;
  readonly setPreviewMode: (mode: RepairPreviewMode) => void;
  readonly replan: () => void;
  readonly isBusy: boolean;
  /** The ceiling in force, and whether it was narrowed below the product's. */
  readonly memoryCeiling: RepairMemoryCeiling;
  /** A narrowed automatic-repair work limit from the URL, when one is in force. */
  readonly workCeiling: number | undefined;
}

/**
 * Bounded change samples per category.
 *
 * The engine defaults to 256. Asking for more would mean more overlay geometry
 * on the GPU for a preview whose purpose is to show the user what KIND of change
 * happened and where — the exact counts are reported separately and are never
 * sampled.
 */
const CHANGE_SAMPLE_LIMIT = 256;

export function useConservativeRepair(): ConservativeRepairControls {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { model, activePartId, analysis, repair } = useWorkspaceState();

  const sessionRef = useRef<RepairSession<unknown> | undefined>(undefined);
  /**
   * The token of the operation currently in flight.
   *
   * Held so Cancel can move the store into `Cancelling` for the RIGHT attempt: a
   * cancel that arrived for a superseded operation must not transition the panel
   * for the one that replaced it.
   */
  const activeTokenRef = useRef<RepairToken | undefined>(undefined);
  /**
   * The candidate this hook is responsible for releasing.
   *
   * Held in a ref rather than read from the store at cleanup time: an effect
   * cleanup runs after the state that triggered it has already changed, so by
   * then the store no longer knows what there was to release.
   */
  const liveCandidateRef = useRef<
    { readonly handle: RepairCandidateHandle; readonly client: RepairCapableClient } | undefined
  >(undefined);

  const memoryCeiling = useMemo(() => resolveRepairMemoryCeiling(globalThis.location.search), []);
  const workCeiling = useMemo(() => resolveRepairWorkCeiling(globalThis.location.search), []);

  /* ------------------------------------------------------------- release -- */

  const releaseCandidate = useCallback((): void => {
    const live = liveCandidateRef.current;
    liveCandidateRef.current = undefined;
    if (live === undefined) return;
    discardRepairCandidate(live.client, live.handle).catch((cause: unknown) => {
      // A candidate the worker has already released, or one that died with the
      // worker, is not a fault: the release is best-effort cleanup of memory the
      // user never owned. Recorded rather than swallowed, and never surfaced as
      // an error, because there is no action a user could take about it.
      const error = toAppError(cause);
      if (error.code === AppErrorCode.ModelUnavailable) return;
      store.pushStatus(
        StatusSeverity.Info,
        `A discarded repair preview could not be released: ${error.message}`,
      );
    });
  }, [store]);

  /* ---------------------------------------------------------------- plan -- */

  const startPlan = useCallback(
    (
      handle: DocumentHandle,
      partId: string,
      selection: readonly RepairOperation[],
      fillOpenings: boolean,
    ): void => {
      if (client === undefined) return;

      sessionRef.current?.cancel();
      const token: RepairToken = store.beginRepairPlan(handle, partId, selection);

      const session = planConservativeRepair({
        handle,
        partId,
        client,
        requested: selection,
        fillOpenings,
        // ALWAYS ON, never a user option: Repair asks for every qualified safe automatic
        // capability and the worker decides what it may do. Production budgets only.
        localRepair: true,
        memoryBudgetBytes: memoryCeiling.bytes,
        onProgress: (progress) => {
          store.reportRepairProgress(token, progress.fraction, progress.phase);
        },
      });
      sessionRef.current = session;

      session.promise.then(
        (outcome) => {
          sessionRef.current = undefined;
          store.commitRepairPlan(
            token,
            outcome.handle,
            outcome.plan,
            outcome.boundaryFill,
            outcome.localRepair,
          );
        },
        (cause: unknown) => {
          sessionRef.current = undefined;
          const failure = describeFailure(cause);
          if (!store.failRepairPlan(token, failure)) return;
          // Not announced in the status log. A plan that cannot be produced is
          // explained in the repair panel beside the operations it concerns; a
          // second copy in the global log would be noise for something the user
          // is already looking at.
        },
      );
    },
    [client, memoryCeiling.bytes, store],
  );

  /**
   * Plans once per (model revision, selection) pair.
   *
   * Keyed and guarded by a ref because `StrictMode` runs effects twice in
   * development, and because a re-render from an unrelated status message must
   * not re-dispatch a plan.
   */
  const plannedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (model === undefined || client === undefined) {
      plannedForRef.current = undefined;
      return;
    }
    /*
     * THE ANALYSIS DEPENDENCY. A plan is derived from a topology report, so it
     * must not be built from a report that is still being computed, was
     * cancelled, failed, or describes a revision the model has moved past. The
     * panel explains each of those states rather than silently showing nothing.
     */
    if (activePartId === undefined) {
      plannedForRef.current = undefined;
      return;
    }

    /*
     * The report must describe THE PART being planned for. Two parts share a
     * revision, so a handle comparison alone would let part A's report drive a
     * plan for part B — and the plan would then propose removing faces that
     * only exist in the other mesh.
     */
    const reportIsCurrent =
      analysis.state === AnalysisState.Ready &&
      analysis.report !== undefined &&
      analysis.handle?.documentId === model.handle.documentId &&
      analysis.handle.revision === model.handle.revision &&
      analysis.partId === activePartId;

    if (!reportIsCurrent) {
      plannedForRef.current = undefined;
      return;
    }

    const key = `${model.handle.documentId}@${String(model.handle.revision)}/${activePartId}#${repair.selection.join(',')}#fill=${String(repair.fillOpenings)}`;
    if (plannedForRef.current === key) return;
    plannedForRef.current = key;
    startPlan(model.handle, activePartId, repair.selection, repair.fillOpenings);
  }, [
    activePartId,
    analysis.handle,
    analysis.partId,
    analysis.report,
    analysis.state,
    client,
    model,
    repair.fillOpenings,
    repair.selection,
    startPlan,
  ]);

  /**
   * Releases the candidate when the workflow is abandoned.
   *
   * THE SIMPLEST SAFE POLICY, as Part I1 asks for. A candidate holds a second
   * copy of the model in the worker; leaving one alive because the user imported
   * a different file, or closed the tab's repair column, would be an invisible
   * leak proportional to the model's size. Keyed on the model IDENTITY, so a
   * commit — which changes the revision — does not trip it, but importing a
   * different model does.
   */
  useEffect(() => {
    const documentId = model?.handle.documentId;
    return (): void => {
      const live = liveCandidateRef.current;
      if (live === undefined) return;
      if (live.handle.documentId === documentId) return;
      releaseCandidate();
    };
  }, [model?.handle.documentId, releaseCandidate]);

  // Unmount: release whatever is still held, whichever model it belongs to.
  useEffect(() => releaseCandidate, [releaseCandidate]);

  /**
   * Drops a candidate whose model went away.
   *
   * Worker loss clears the store's repair state on its own; this is what stops
   * the hook from believing it still owns something to release, and cancels an
   * in-flight session that can no longer produce anything usable.
   */
  useEffect(() => {
    if (model !== undefined) return;
    sessionRef.current?.cancel();
    sessionRef.current = undefined;
    liveCandidateRef.current = undefined;
  }, [model]);

  /* ----------------------------------------------------------- candidate -- */

  const previewRepair = useCallback((): void => {
    if (client === undefined || model === undefined || activePartId === undefined) return;
    const plan = repair.plan;
    // REPAIR-CORE-02: a plan with no conservative work may still fill openings.
    const fill =
      repair.fillOpenings &&
      repair.fillPlan !== undefined &&
      fillableOpeningCount(repair.fillPlan) > 0
        ? { planHash: repair.fillPlan.planHash }
        : undefined;
    const local =
      repair.localPlan !== undefined && repair.localPlan.eligible > 0
        ? {
            planHash: repair.localPlan.planHash,
            ...(workCeiling === undefined ? {} : { workCeiling }),
          }
        : undefined;
    if (plan === undefined || (plan.noOp && fill === undefined && local === undefined)) return;
    /*
     * THE CANDIDATE IS BUILT FOR THE PART THE PLAN WAS BUILT FOR. If the user
     * switched parts since planning, the slice was re-bound and there is no plan
     * to preview — so this cannot silently build a candidate for the new part
     * from the old part's plan.
     */
    if (repair.partId !== activePartId) return;

    // A previous preview is released before a new one is built, so at most one
    // candidate is ever resident. The worker enforces this too.
    releaseCandidate();

    const token = store.beginRepairPreview();
    if (token === undefined) return;
    if (!store.beginRepairCandidate(token)) return;
    activeTokenRef.current = token;

    const session = createRepairCandidate({
      handle: model.handle,
      partId: activePartId,
      client,
      requested: repair.selection,
      planHash: plan.planHash,
      memoryBudgetBytes: memoryCeiling.bytes,
      sampleLimit: CHANGE_SAMPLE_LIMIT,
      ...(fill === undefined ? {} : { fill }),
      ...(local === undefined ? {} : { localRepair: local }),
      onProgress: (progress) => {
        store.reportRepairProgress(token, progress.fraction, progress.phase);
      },
    });
    sessionRef.current = session;

    session.promise.then(
      (outcome) => {
        sessionRef.current = undefined;

        /*
         * A CANDIDATE IS NOT A SUCCESS. `RepairAcceptance` is the verdict, and
         * anything other than ACCEPTED means no candidate handle exists to
         * apply. The reason is shown; the model is untouched either way.
         */
        if (
          outcome.candidate === undefined ||
          outcome.validation.acceptance !== RepairAcceptance.Accepted
        ) {
          // Nothing to preview because every opening was refused by the exact
          // check: say that, rather than "no changes".
          const fillFailure =
            outcome.validation.acceptance === RepairAcceptance.NoOp
              ? describeFillFailure(outcome.boundaryFill)
              : undefined;
          if (fillFailure !== undefined) {
            store.failRepairCandidate(token, {
              message: fillFailure,
              code: 'fill-refused',
              retryable: false,
            });
            return;
          }
          // Issues were detected, the local repair looked, and nothing safe exists to change: a
          // neutral decision, not a failure.
          if (
            outcome.validation.acceptance === RepairAcceptance.NoOp &&
            (outcome.localRepair !== undefined || outcome.localRepairNotRun !== undefined)
          ) {
            store.failRepairCandidate(token, {
              message: describeNoSafeChange(outcome.localRepair?.kind, outcome.localRepairNotRun),
              code: NO_SAFE_CHANGE_CODE,
              retryable: false,
            });
            return;
          }
          const presented = presentAcceptance(
            outcome.validation.acceptance,
            outcome.validation.regressions,
          );
          store.failRepairCandidate(token, {
            message: `${presented.headline}. ${presented.detail}`,
            code: outcome.validation.acceptance,
            retryable: presented.retryable,
          });
          return;
        }

        const installed = store.commitRepairCandidate(token, {
          candidate: outcome.candidate,
          source: outcome.source,
          partId: outcome.partId,
          planHash: outcome.plan.planHash,
          validation: outcome.validation,
          counts: outcome.counts,
          samples: outcome.samples,
          render: outcome.render,
          bounds: outcome.candidateBounds,
          undoRetainedBytes: outcome.undoRetainedBytes,
          boundaryFill: outcome.boundaryFill,
          ...(outcome.patchRender === undefined ? {} : { patchRender: outcome.patchRender }),
          ...(outcome.localRepair === undefined ? {} : { localRepair: outcome.localRepair }),
          ...(outcome.localRepairNotRun === undefined
            ? {}
            : { localRepairNotRun: outcome.localRepairNotRun }),
          ...(outcome.localChange === undefined ? {} : { localChange: outcome.localChange }),
        });

        if (!installed) {
          // The model moved on while this was being built. The candidate is real
          // and worker-resident, so it is released rather than abandoned.
          discardRepairCandidate(client, outcome.candidate).catch(() => {
            // Nothing a user could act on; the model was never touched.
          });
          return;
        }

        liveCandidateRef.current = { handle: outcome.candidate, client };
      },
      (cause: unknown) => {
        sessionRef.current = undefined;
        activeTokenRef.current = undefined;
        const error = toAppError(cause);
        if (error.code === AppErrorCode.OperationCancelled) {
          // THE ACKNOWLEDGEMENT. The worker unwound and rejected, so the work has
          // genuinely stopped and nothing was published. Only now may the panel
          // say `Cancelled`.
          if (!store.cancelRepairCandidate(token)) return;
          store.pushStatus(
            StatusSeverity.Info,
            'Repair cancelled. Your model is unchanged and can be repaired again.',
          );
          return;
        }
        const failure = describeFailure(cause);
        if (!store.failRepairCandidate(token, failure)) return;
        store.pushStatus(StatusSeverity.Error, failure.message);
      },
    );
  }, [
    activePartId,
    client,
    memoryCeiling.bytes,
    model,
    releaseCandidate,
    repair.fillOpenings,
    repair.fillPlan,
    repair.localPlan,
    repair.partId,
    workCeiling,
    repair.plan,
    repair.selection,
    store,
  ]);

  /**
   * Signals cancellation and moves the panel into its transitional state.
   *
   * ORDER MATTERS AND IS INHERITED. `session.cancel()` performs the
   * `Atomics.store` before it posts anything, so the worker can observe the flag
   * from inside its current batch. The UI only claims `Cancelled` once the
   * worker acknowledges by rejecting the operation — until then it says
   * `Cancelling…`, because the work demonstrably has not stopped yet.
   */
  const cancelPreview = useCallback((): void => {
    sessionRef.current?.cancel();
    const token = activeTokenRef.current;
    if (token !== undefined) store.beginRepairCancellation(token);
  }, [store]);

  const discardPreview = useCallback((): void => {
    sessionRef.current?.cancel();
    const dropped = store.clearRepairCandidate();
    if (dropped !== undefined) releaseCandidate();
    store.pushStatus(StatusSeverity.Info, 'Repair preview discarded. Your model is unchanged.');
  }, [releaseCandidate, store]);

  /* -------------------------------------------------------------- commit -- */

  const applyRepair = useCallback((): void => {
    if (client === undefined || model === undefined) return;
    const preview = repair.candidate;
    if (preview === undefined) return;

    // The first of two independent defences against a double apply. The second
    // is in the worker, which refuses to commit a candidate twice.
    if (!store.beginRepairCommit()) return;

    const session = commitRepair({
      client,
      candidate: preview.candidate,
      expectedSource: preview.source,
      expectedPart: preview.partId,
      planHash: preview.planHash,
      onProgress: (progress) => {
        store.reportRepairCommitProgress(progress.fraction, progress.phase);
      },
    });

    session.promise.then(
      (result) => {
        // The candidate is now the model. The worker released its second
        // reference at commit, so this hook must forget it rather than discard
        // it — discarding a committed candidate is a typed error, correctly.
        liveCandidateRef.current = undefined;

        const applied = store.applyRepairResult({
          handle: result.handle,
          parentRevision: result.parentRevision,
          recordId: result.repairRecordId,
          partId: result.partId,
          appliedOperations: result.appliedOperations,
          counts: preview.counts,
          filledOpenings: preview.boundaryFill?.filledCount ?? 0,
          localRepaired: preview.localRepair?.repaired ?? 0,
          localReversed: preview.localRepair?.facesReversed ?? 0,
          undoable: result.undoable,
          render: result.render,
          parts: result.parts,
          bounds: result.bounds,
          triangleCount: result.triangleCount,
          vertexCount: result.vertexCount,
          residentBytes: result.residentBytes,
        });

        /*
         * THE DIVERGENCE CASE. The worker committed — the user's geometry really
         * did change — but the workspace could not install the result, because
         * the model it belongs to is no longer the one loaded.
         *
         * Returning quietly here would leave `commitState` at `Applying`
         * forever, freezing Apply, Discard and Undo behind a spinner for an
         * operation that has already finished. The slot is released and the
         * divergence is reported, because a user who is looking at different
         * geometry than they just repaired needs to be told.
         */
        if (!applied) {
          store.failRepairCommit({
            message:
              'The repair was applied, but the model it belongs to is no longer open. Re-open that file to see the repaired version.',
            code: AppErrorCode.ModelUnavailable,
            retryable: false,
          });
          return;
        }
        /*
         * WHAT CHANGED, AND NOTHING ABOUT WHAT REMAINS — REPAIR-UX-04. The new
         * revision has not been analysed yet, so "complete" or "partial" is not
         * known here; the result card says which once it is.
         */
        store.pushStatus(
          StatusSeverity.Info,
          describeAppliedActivity(
            describeAppliedChanges(preview.counts, preview.boundaryFill?.filledCount ?? 0, {
              repaired: preview.localRepair?.repaired ?? 0,
              reversed: preview.localRepair?.facesReversed ?? 0,
            }),
          ),
        );
      },
      (cause: unknown) => {
        const failure = describeFailure(cause);
        store.failRepairCommit(failure);
        store.pushStatus(StatusSeverity.Error, `The repair was not applied: ${failure.message}`);
      },
    );
  }, [client, model, repair.candidate, store]);

  /* ---------------------------------------------------------------- undo -- */

  const undoLastRepair = useCallback((): void => {
    if (client === undefined || model === undefined) return;
    const applied = repair.lastApplied;
    if (applied?.undoable !== true) return;
    if (!store.beginRepairUndo()) return;

    const session = undoRepair({
      client,
      handle: model.handle,
      recordId: applied.recordId,
      onProgress: (progress) => {
        store.reportRepairCommitProgress(progress.fraction, progress.phase);
      },
    });

    session.promise.then(
      (result) => {
        const restored = store.applyUndoResult({
          handle: result.handle,
          partId: result.partId,
          render: result.render,
          parts: result.parts,
          bounds: result.bounds,
          triangleCount: result.triangleCount,
          vertexCount: result.vertexCount,
          residentBytes: result.residentBytes,
        });

        // Same divergence case as commit, and the same reason it cannot be
        // silent: the undo succeeded in the worker, so leaving the slot claimed
        // would freeze the panel behind an operation that has already finished.
        if (!restored) {
          store.failRepairUndo({
            message:
              'The repair was undone, but the model it belongs to is no longer open. Re-open that file to see the restored version.',
            code: AppErrorCode.ModelUnavailable,
            retryable: false,
          });
          return;
        }
        store.pushStatus(
          StatusSeverity.Success,
          'The repair was undone. The model has been restored to its state before that repair.',
        );
      },
      (cause: unknown) => {
        const failure = describeFailure(cause);
        store.failRepairUndo(failure);
        store.pushStatus(
          StatusSeverity.Error,
          `The repair could not be undone: ${failure.message}`,
        );
      },
    );
  }, [client, model, repair.lastApplied, store]);

  /* ------------------------------------------------------------ controls -- */

  const setOperationSelected = useCallback(
    (operation: RepairOperation, selected: boolean): void => {
      // Changing the selection invalidates the candidate as well as the plan:
      // the preview on screen was built for a different set of operations.
      releaseCandidate();
      const next = selected
        ? [...new Set([...repair.selection, operation])]
        : repair.selection.filter((entry) => entry !== operation);
      store.setRepairSelection(next);
    },
    [releaseCandidate, repair.selection, store],
  );

  const setFillOpenings = useCallback(
    (fill: boolean): void => {
      // A change of scope invalidates the preview exactly as a selection does.
      releaseCandidate();
      store.setFillOpenings(fill);
    },
    [releaseCandidate, store],
  );

  const setPreviewMode = useCallback(
    (mode: RepairPreviewMode): void => {
      store.setRepairPreviewMode(mode);
    },
    [store],
  );

  const replan = useCallback((): void => {
    if (model === undefined || activePartId === undefined) return;
    plannedForRef.current = undefined;
    startPlan(model.handle, activePartId, repair.selection, repair.fillOpenings);
  }, [activePartId, model, repair.fillOpenings, repair.selection, startPlan]);

  return {
    previewRepair,
    cancelPreview,
    discardPreview,
    applyRepair,
    undoLastRepair,
    setOperationSelected,
    setFillOpenings,
    setPreviewMode,
    replan,
    isBusy:
      repair.planState === RepairPlanState.Planning ||
      repair.candidateState === RepairCandidateState.Building ||
      repair.commitState !== RepairCommitState.Idle,
    memoryCeiling,
    workCeiling,
  };
}

/**
 * Turns a worker error into something a user can act on.
 *
 * A resource refusal is singled out because it is NOT a generic failure and
 * must not read like one: the model is intact and the advice is different.
 */
function describeFailure(cause: unknown): RepairFailure {
  const error = toAppError(cause);
  if (error.code === AppErrorCode.ResourceLimitExceeded) {
    return { message: RESOURCE_LIMIT_DETAIL, code: error.code, retryable: false };
  }
  return {
    message: error.message,
    code: error.code,
    // A lifecycle refusal (already applied, already discarded, stale revision)
    // will refuse identically next time; a transient failure is worth retrying.
    retryable: error.code !== AppErrorCode.InvalidState,
  };
}
