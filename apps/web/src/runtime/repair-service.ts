import { internalError, operationCancelled } from '@cadfixer/shared';
import {
  DEFAULT_SESSION_MEMORY_BUDGET,
  type BoundaryFillPlan,
  type LocalRepairPlan,
  type ConservativeRepairPlan,
  type DocumentHandle,
  type OperationHandle,
  type ProgressUpdate,
  type RepairCandidateHandle,
  type RepairCandidateResult,
  type RepairCommitResult,
  type RepairDiscardResult,
  type RepairOperation,
  type RepairPlanOperationResult,
  type RepairUndoResult,
} from '@cadfixer/geometry-runtime';
import type { RepairCandidateOptions } from './geometry-client';
import { openFillVerifier, type FillVerifier } from './hole-fill-service';

/**
 * The one path from a loaded model to a conservative repair.
 *
 * Shaped deliberately like `analysis-service`: start it, watch progress, cancel
 * it, await the outcome. Components decide *that* a repair is planned, previewed
 * or applied; this decides *how*. No React import appears in this file, and no
 * repair algorithm does either — the engine runs in the worker and this is the
 * transport.
 *
 * WHAT CROSSES. Out: handles, revisions, operation names, a plan hash, a memory
 * ceiling and a sample cap. Back: plans, validations, counts and BOUNDED change
 * samples, plus render snapshots for the preview. The authoritative canonical
 * mesh never moves in either direction, and neither does the candidate's.
 *
 * THE TRANSACTION IS NOT HERE. This module cannot commit anything: it sends
 * `repair/commit` and the worker re-checks every guard. That separation is what
 * stops a UI bug from becoming a data-loss bug.
 */

/**
 * Worker phase names translated for the interface.
 *
 * Mapped once, here, rather than by each component that happens to show
 * progress. An unmapped phase falls through unchanged rather than being hidden,
 * so a new engine phase shows up as itself instead of silently vanishing.
 */
const PHASE_LABELS: Readonly<Record<string, string>> = {
  'planning repair': 'Planning repair',
  planned: 'Plan ready',
  analysing: 'Analysing the current model',
  'selecting faces': 'Selecting triangles to change',
  'solving winding': 'Solving relative winding',
  'building candidate': 'Building the proposed result',
  'validating candidate': 'Revalidating the proposed result',
  'checking openings': 'Checking the openings to fill',
  // REPAIR-CORE-06B: stages, never a percentage — the engine does not know what remains.
  'repairing pinched vertices': 'Building a safe repair',
  'judging candidate': 'Revalidating the proposed result',
  applied: 'Applying',
  'restoring previous version': 'Restoring the previous version',
  restored: 'Restored',
};

export function describeRepairPhase(phase: string | undefined): string {
  if (phase === undefined || phase.length === 0) return 'Working';
  return PHASE_LABELS[phase] ?? phase;
}

export interface RepairProgress {
  /** Already translated for display. */
  readonly phase: string;
  /** 0..1. */
  readonly fraction: number;
}

/**
 * The slice of the geometry client this service needs.
 *
 * Declared structurally so the service can be tested against a stand-in without
 * constructing a real `Worker`, and so the dependency is visibly five methods
 * wide rather than "the whole client".
 */
export interface RepairCapableClient {
  planRepair(
    handle: DocumentHandle,
    partId: string,
    requested: readonly RepairOperation[],
    onProgress: (update: ProgressUpdate) => void,
    memoryBudgetBytes?: number,
    fillOpenings?: boolean,
    verifierPort?: MessagePort,
    localRepair?: boolean,
  ): OperationHandle<RepairPlanOperationResult>;
  createRepairCandidate(
    handle: DocumentHandle,
    partId: string,
    requested: readonly RepairOperation[],
    planHash: string,
    onProgress: (update: ProgressUpdate) => void,
    options?: RepairCandidateOptions,
  ): OperationHandle<RepairCandidateResult>;
  commitRepair(
    candidate: RepairCandidateHandle,
    expectedSource: DocumentHandle,
    expectedPart: string,
    planHash: string,
    onProgress: (update: ProgressUpdate) => void,
  ): OperationHandle<RepairCommitResult>;
  discardRepairCandidate(candidate: RepairCandidateHandle): OperationHandle<RepairDiscardResult>;
  undoRepair(
    handle: DocumentHandle,
    recordId: string,
    onProgress: (update: ProgressUpdate) => void,
  ): OperationHandle<RepairUndoResult>;
}

export interface RepairSession<T> {
  readonly promise: Promise<T>;
  /**
   * Requests cancellation.
   *
   * INTERRUPTS RUNNING WORK, as of Stage 3B-1C. Repair operations dispatch with
   * a shared control word, so `cancel()` performs an `Atomics.store` that the
   * worker observes from inside its own synchronous loops — it does not wait for
   * a message to be dequeued. The engine polls that word at a bounded batch
   * interval, so the work stops within one batch rather than at the end of the
   * phase it happens to be in.
   *
   * What it still is NOT: pre-emption. A loop between polls finishes its batch.
   */
  cancel(): void;
}

export interface RepairPlanOutcome {
  readonly handle: DocumentHandle;
  readonly partId: string;
  readonly plan: ConservativeRepairPlan;
  /** What automatic filling would attempt — REPAIR-CORE-02. */
  readonly boundaryFill: BoundaryFillPlan;
  /** What the local pinch repair would attempt — REPAIR-CORE-06A. Absent when not requested. */
  readonly localRepair?: LocalRepairPlan;
  readonly durationMs: number;
}

export interface RepairCandidateOutcome extends RepairCandidateResult {
  readonly durationMs: number;
}

/* ------------------------------------------------------------- ceilings -- */

/**
 * The repair memory ceiling this session will ask the worker to honour.
 *
 * NARROWING ONLY, and that is enforced twice: here by `Math.min`, and again in
 * the worker by `requestRepairPeak`, which ignores any ceiling above the
 * product's own. A URL cannot buy CAD Fixer more memory; it can only make it
 * refuse sooner.
 *
 * WHY IT IS ADDRESSABLE AT ALL. The refusal path has to be exercisable on a
 * machine that is not about to run out of memory — by the end-to-end suite, and
 * by anyone diagnosing a report of a repair refusing on a constrained device.
 * The alternative was a fixture large enough to genuinely approach the limit,
 * which means deliberately pushing a browser tab towards an out-of-memory
 * condition to prove that we avoid one. This option is surfaced in the repair
 * panel whenever it is active, so it is never a hidden state.
 */
export interface RepairMemoryCeiling {
  readonly bytes: number;
  /** True when a narrower ceiling than the product default is in force. */
  readonly narrowed: boolean;
}

export const REPAIR_MEMORY_CEILING_PARAM = 'repairMemoryCeilingMiB';

export function resolveRepairMemoryCeiling(search: string): RepairMemoryCeiling {
  const productCeiling = DEFAULT_SESSION_MEMORY_BUDGET.maxRepairPeakBytes;
  let requested: number | undefined;
  try {
    const raw = new URLSearchParams(search).get(REPAIR_MEMORY_CEILING_PARAM);
    if (raw !== null && raw.length > 0) requested = Number(raw);
  } catch (cause) {
    // A malformed query string is not a reason to fail: the product ceiling is
    // the safe answer, and it is what an absent parameter would have produced.
    // Rethrowing would take down the repair panel over a typo in a URL.
    void cause;
    return { bytes: productCeiling, narrowed: false };
  }

  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return { bytes: productCeiling, narrowed: false };
  }
  const bytes = Math.min(productCeiling, Math.floor(requested * 1024 * 1024));
  return { bytes, narrowed: bytes < productCeiling };
}

/* ------------------------------------------------------------------ plan -- */

export interface RepairPlanRequest {
  readonly handle: DocumentHandle;
  /** The part to plan a repair for. Repair operates on one part at a time. */
  readonly partId: string;
  readonly client: RepairCapableClient;
  readonly requested: readonly RepairOperation[];
  readonly memoryBudgetBytes?: number;
  /** Also plan automatic filling of eligible openings. */
  readonly fillOpenings?: boolean;
  /** Also plan the local pinch repair — REPAIR-CORE-06A. Counts only; opens no worker. */
  readonly localRepair?: boolean;
  /** Injectable for tests; the application uses the real verifier. */
  readonly openVerifier?: (onFailure: () => void) => FillVerifier;
  /**
   * Declared as a property rather than a method so it can be PASSED to the
   * shared session builder without `this` ambiguity — a method shorthand read
   * as a value is exactly the unbound-method hazard the linter guards.
   */
  readonly onProgress?: (progress: RepairProgress) => void;
}

export function planConservativeRepair(
  request: RepairPlanRequest,
): RepairSession<RepairPlanOutcome> {
  return runSession(request.onProgress, (report, register, isCancelled) => async () => {
    const startedAt = Date.now();
    const operation = request.client.planRepair(
      request.handle,
      request.partId,
      request.requested,
      report,
      request.memoryBudgetBytes,
      request.fillOpenings === true,
      undefined,
      request.localRepair === true,
    );
    register(operation);

    let result = await operation.promise;
    if (isCancelled()) throw operationCancelled('Repair planning was cancelled.');
    assertSameModel(result.handle, request.handle, 'repair plan');
    assertSamePart(result.partId, request.partId, 'repair plan');

    /*
     * VERIFY WHAT WILL BE PROMISED — REPAIR-RC-03. Admission is topology and
     * planarity; only the exact check can say an opening fills. When the plan
     * admits any, the disposable verifier is opened for this plan alone and
     * the worker plans again, now counting only openings that passed. Nothing
     * is opened for a part with no admitted opening. If the verifier dies the
     * plan stays unverified, which the interface never presents as fillable.
     */
    if (
      request.fillOpenings === true &&
      result.boundaryFill.admittedCount > 0 &&
      !result.boundaryFill.verified
    ) {
      const verifierState = { failed: false };
      let cancelVerify: (() => void) | undefined;
      const verifier = (request.openVerifier ?? openFillVerifier)(() => {
        verifierState.failed = true;
        cancelVerify?.();
      });
      try {
        const verify = request.client.planRepair(
          request.handle,
          request.partId,
          request.requested,
          report,
          request.memoryBudgetBytes,
          true,
          verifier.port,
          request.localRepair === true,
        );
        cancelVerify = (): void => {
          verify.cancel();
        };
        register({
          cancel: (): void => {
            verifier.dispose();
            verify.cancel();
          },
        });
        try {
          const verified = await verify.promise;
          if (isCancelled()) throw operationCancelled('Repair planning was cancelled.');
          assertSameModel(verified.handle, request.handle, 'repair plan');
          assertSamePart(verified.partId, request.partId, 'repair plan');
          result = verified;
        } catch (cause) {
          if (!verifierState.failed || isCancelled()) throw cause;
          // The verifier died. Keep the UNVERIFIED plan: it is truthful as long
          // as nothing presents its admitted count as fillable, and nothing does.
        }
      } finally {
        verifier.dispose();
      }
    }

    return {
      handle: result.handle,
      partId: result.partId,
      plan: result.plan,
      boundaryFill: result.boundaryFill,
      ...(result.localRepair === undefined ? {} : { localRepair: result.localRepair }),
      durationMs: Date.now() - startedAt,
    };
  });
}

/* ------------------------------------------------------------- candidate -- */

export interface RepairCandidateRequest {
  readonly handle: DocumentHandle;
  /** The part the candidate will replace. Bound into the candidate handle. */
  readonly partId: string;
  readonly client: RepairCapableClient;
  readonly requested: readonly RepairOperation[];
  /** The plan the user saw. The worker refuses if it no longer matches. */
  readonly planHash: string;
  readonly memoryBudgetBytes?: number;
  readonly sampleLimit?: number;
  /**
   * Fill the openings the plan admitted — REPAIR-CORE-02. When set, a
   * disposable verifier worker is opened for this preview only, and closed
   * when it settles or is cancelled.
   */
  readonly fill?: { readonly planHash: string };
  /**
   * Run the local pinch repair — REPAIR-CORE-06A. The same disposable kernel worker is opened for
   * this preview only; without it nothing could be verified and nothing would be repaired.
   */
  readonly localRepair?: {
    readonly planHash: string;
    /** Narrows the primary work budget; the worker takes the smaller of this and the product's. */
    readonly workCeiling?: number;
  };
  /** Injectable for tests; the application uses the real verifier. */
  readonly openVerifier?: (onFailure: () => void) => FillVerifier;
  /**
   * Declared as a property rather than a method so it can be PASSED to the
   * shared session builder without `this` ambiguity — a method shorthand read
   * as a value is exactly the unbound-method hazard the linter guards.
   */
  readonly onProgress?: (progress: RepairProgress) => void;
}

export function createRepairCandidate(
  request: RepairCandidateRequest,
): RepairSession<RepairCandidateOutcome> {
  return runSession(request.onProgress, (report, register, isCancelled) => async () => {
    const startedAt = Date.now();
    // A record, because it is written from a callback: a plain `let` would be
    // narrowed to `false` at every read.
    const verifierState = { failed: false };
    let cancelOperation: (() => void) | undefined;
    const verifier =
      request.fill === undefined && request.localRepair === undefined
        ? undefined
        : (request.openVerifier ?? openFillVerifier)(() => {
            // The verifier died: stop the repair rather than wait for an
            // answer that cannot come.
            verifierState.failed = true;
            cancelOperation?.();
          });
    try {
      const operation = request.client.createRepairCandidate(
        request.handle,
        request.partId,
        request.requested,
        request.planHash,
        report,
        {
          ...(request.memoryBudgetBytes === undefined
            ? {}
            : { memoryBudgetBytes: request.memoryBudgetBytes }),
          ...(request.sampleLimit === undefined ? {} : { sampleLimit: request.sampleLimit }),
          ...(request.fill === undefined
            ? {}
            : { fillOpenings: true, fillPlanHash: request.fill.planHash }),
          ...(request.localRepair === undefined
            ? {}
            : {
                localRepair: true,
                localRepairPlanHash: request.localRepair.planHash,
                ...(request.localRepair.workCeiling === undefined
                  ? {}
                  : { localRepairWorkCeiling: request.localRepair.workCeiling }),
              }),
          ...(verifier === undefined ? {} : { verifierPort: verifier.port }),
        },
      );
      cancelOperation = (): void => {
        operation.cancel();
      };
      register({
        cancel: (): void => {
          // Termination is the verifier's cancel; the operation's own flag
          // stops the geometry worker.
          verifier?.dispose();
          operation.cancel();
        },
      });

      let result: RepairCandidateResult;
      try {
        result = await operation.promise;
      } catch (cause) {
        if (verifierState.failed)
          throw internalError('The worker checking the openings stopped unexpectedly.');
        throw cause;
      }

      /*
       * A CANCEL THAT LANDS WHILE THE RESULT IS IN FLIGHT MUST NOT PRODUCE A
       * PREVIEW. The candidate is real and worker-resident at this point, so it is
       * discarded rather than abandoned — otherwise cancelling would leave a
       * multi-hundred-megabyte candidate in the worker that nothing will ever
       * commit or release.
       */
      if (isCancelled()) {
        if (result.candidate !== undefined) {
          request.client.discardRepairCandidate(result.candidate).promise.catch(() => {
            // Discarding an already-gone candidate is not a fault, and there is no
            // user-facing consequence either way: the model was never touched.
          });
        }
        throw operationCancelled('Repair was cancelled.');
      }

      assertSameModel(result.source, request.handle, 'repair candidate');
      assertSamePart(result.partId, request.partId, 'repair candidate');

      return { ...result, durationMs: Date.now() - startedAt };
    } finally {
      verifier?.dispose();
    }
  });
}

/* ---------------------------------------------------------------- commit -- */

export interface RepairCommitRequest {
  readonly client: RepairCapableClient;
  readonly candidate: RepairCandidateHandle;
  readonly expectedSource: DocumentHandle;
  /** The part the caller believes it is replacing. Re-checked in the worker. */
  readonly expectedPart: string;
  readonly planHash: string;
  /**
   * Declared as a property rather than a method so it can be PASSED to the
   * shared session builder without `this` ambiguity — a method shorthand read
   * as a value is exactly the unbound-method hazard the linter guards.
   */
  readonly onProgress?: (progress: RepairProgress) => void;
}

export function commitRepair(request: RepairCommitRequest): RepairSession<RepairCommitResult> {
  return runSession(request.onProgress, (report, register) => async () => {
    const operation = request.client.commitRepair(
      request.candidate,
      request.expectedSource,
      request.expectedPart,
      request.planHash,
      report,
    );
    register(operation);
    const result = await operation.promise;

    /*
     * NOT CANCELLABLE AFTER THE FACT. A commit that has already replaced the
     * authoritative revision cannot be un-done by throwing here — the model
     * really did change. Treating a late cancel as a failure would leave the
     * interface showing the previous revision while the worker holds the new
     * one, which is the one inconsistency that matters most.
     */
    if (
      result.handle.documentId !== request.expectedSource.documentId ||
      result.partId !== request.expectedPart
    ) {
      throw internalError('A repair commit returned a different model than the one requested.');
    }
    return result;
  });
}

/* ------------------------------------------------------------------ undo -- */

export interface RepairUndoRequest {
  readonly client: RepairCapableClient;
  readonly handle: DocumentHandle;
  readonly recordId: string;
  /**
   * Declared as a property rather than a method so it can be PASSED to the
   * shared session builder without `this` ambiguity — a method shorthand read
   * as a value is exactly the unbound-method hazard the linter guards.
   */
  readonly onProgress?: (progress: RepairProgress) => void;
}

export function undoRepair(request: RepairUndoRequest): RepairSession<RepairUndoResult> {
  return runSession(request.onProgress, (report, register) => async () => {
    const operation = request.client.undoRepair(request.handle, request.recordId, report);
    register(operation);
    const result = await operation.promise;
    if (result.handle.documentId !== request.handle.documentId) {
      throw internalError('An undo returned a different model than the one requested.');
    }
    return result;
  });
}

/* --------------------------------------------------------------- discard -- */

/**
 * Releases a candidate's worker-resident geometry.
 *
 * Deliberately NOT a session: discarding is not cancellable and has no progress.
 * It is also idempotent in the worker, so a double discard is not an error.
 */
export function discardRepairCandidate(
  client: RepairCapableClient,
  candidate: RepairCandidateHandle,
): Promise<RepairDiscardResult> {
  return client.discardRepairCandidate(candidate).promise;
}

/* -------------------------------------------------------------- plumbing -- */

/**
 * Shared session construction: progress translation, cancellation, and a cancel
 * that lands before dispatch still taking effect.
 *
 * The flag is read through a function so TypeScript does not narrow it to
 * permanently false across the closure boundary.
 */
function runSession<T>(
  onProgress: ((progress: RepairProgress) => void) | undefined,
  build: (
    report: (update: ProgressUpdate) => void,
    register: (operation: { cancel(): void }) => void,
    isCancelled: () => boolean,
  ) => () => Promise<T>,
): RepairSession<T> {
  let cancelled = false;
  let dispatchCancel: (() => void) | undefined;

  const isCancelled = (): boolean => cancelled;

  const report = (update: ProgressUpdate): void => {
    onProgress?.({ phase: describeRepairPhase(update.note), fraction: update.fraction });
  };

  const register = (operation: { cancel(): void }): void => {
    dispatchCancel = (): void => {
      operation.cancel();
    };
    // A cancel requested before dispatch returned still has to reach the worker.
    if (isCancelled()) operation.cancel();
  };

  return {
    promise: build(report, register, isCancelled)(),
    cancel(): void {
      cancelled = true;
      dispatchCancel?.();
    },
  };
}

/**
 * THE HANDLE IS VERIFIED, NOT TRUSTED.
 *
 * The worker echoes the handle it worked on; if it does not match what was asked
 * for, something upstream routed a result to the wrong operation and the only
 * safe response is to refuse it. Silently accepting would attach one model's
 * repair plan to another model's geometry.
 */
function assertSameModel(actual: DocumentHandle, expected: DocumentHandle, what: string): void {
  if (actual.documentId !== expected.documentId || actual.revision !== expected.revision) {
    throw internalError(`A ${what} arrived for a different model than the one requested.`);
  }
}

/**
 * The PART guard, which the handle check cannot stand in for.
 *
 * Two parts of one document carry identical handles, so a result routed to the
 * wrong part would pass `assertSameModel` unchanged and then be displayed
 * against geometry it does not describe.
 */
function assertSamePart(actual: string, expected: string, what: string): void {
  if (actual !== expected) {
    throw internalError(`A ${what} arrived for a different part than the one requested.`);
  }
}
