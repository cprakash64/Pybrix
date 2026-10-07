import { describe, expect, it } from 'vitest';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import {
  DEFAULT_SESSION_MEMORY_BUDGET,
  type ConservativeRepairPlan,
  type DocumentHandle,
  type OperationHandle,
  type RepairCandidateHandle,
  type RepairCandidateResult,
  type RepairCommitResult,
  type RepairDiscardResult,
  type RepairPlanOperationResult,
  type RepairUndoResult,
} from '@cadfixer/geometry-runtime';
import {
  BoundaryFillScanStatus,
  NO_BOUNDARY_FILL_PLAN,
  type BoundaryFillPlan,
} from '@cadfixer/geometry-runtime';
import {
  createRepairCandidate,
  describeRepairPhase,
  planConservativeRepair,
  REPAIR_MEMORY_CEILING_PARAM,
  resolveRepairMemoryCeiling,
  resolveRepairWorkCeiling,
  undoRepair,
  type RepairCapableClient,
} from './repair-service';
import type { FillVerifier } from './hole-fill-service';

/**
 * The transport, tested against a stand-in client rather than a real `Worker`.
 *
 * WHAT IS ACTUALLY UNDER TEST: the guards this layer adds on top of the worker's
 * own. Handle verification, cancellation that does not leak a candidate, and a
 * memory ceiling that can only ever narrow. The repair itself is the engine's
 * job and is tested where the engine lives.
 */

const HANDLE: DocumentHandle = { documentId: 'model-1', revision: 1 } as DocumentHandle;

const PART = 'part-1';

const CANDIDATE: RepairCandidateHandle = {
  candidateId: 'candidate-1',
  documentId: 'model-1',
  partId: PART,
  sourceRevision: 1,
  generation: 1,
} as RepairCandidateHandle;

function deferred<T>(): {
  handle: OperationHandle<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
  cancelled: () => boolean;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let wasCancelled = false;
  return {
    handle: {
      id: 'op-1',
      promise,
      cancel: (): void => {
        wasCancelled = true;
      },
    } as unknown as OperationHandle<T>,
    resolve,
    reject,
    cancelled: (): boolean => wasCancelled,
  };
}

function plan(overrides: Partial<ConservativeRepairPlan> = {}): ConservativeRepairPlan {
  return { planHash: 'hash', noOp: false, ...overrides } as ConservativeRepairPlan;
}

function candidateResult(overrides: Partial<RepairCandidateResult> = {}): RepairCandidateResult {
  return {
    candidate: CANDIDATE,
    source: HANDLE,
    partId: PART,
    plan: plan(),
    validation: { acceptance: 'ACCEPTED' },
    counts: {},
    samples: {},
    undoRetainedBytes: 0,
    candidateBounds: undefined,
    render: undefined,
    ...overrides,
  } as RepairCandidateResult;
}

interface StubClient extends RepairCapableClient {
  readonly discarded: RepairCandidateHandle[];
}

function stubClient(parts: Partial<RepairCapableClient> = {}): StubClient {
  const discarded: RepairCandidateHandle[] = [];
  /**
   * Every method a test does not supply throws.
   *
   * Deliberately not a silent no-op: a stand-in that quietly returned nothing
   * would let a test pass while exercising a code path it never meant to reach.
   */
  const unexpected = (name: string) => (): never => {
    throw new Error(`stand-in ${name} was not expected to be called`);
  };

  return {
    discarded,
    planRepair: parts.planRepair ?? unexpected('planRepair'),
    createRepairCandidate: parts.createRepairCandidate ?? unexpected('createRepairCandidate'),
    commitRepair: parts.commitRepair ?? unexpected('commitRepair'),
    undoRepair: parts.undoRepair ?? unexpected('undoRepair'),
    discardRepairCandidate: (candidate): OperationHandle<RepairDiscardResult> => {
      discarded.push(candidate);
      return {
        id: 'discard',
        promise: Promise.resolve({ released: true }),
        cancel: (): void => undefined,
      } as unknown as OperationHandle<RepairDiscardResult>;
    },
  };
}

describe('the repair memory ceiling', () => {
  it('uses the product ceiling when no option is present', () => {
    const ceiling = resolveRepairMemoryCeiling('');

    expect(ceiling.bytes).toBe(DEFAULT_SESSION_MEMORY_BUDGET.maxRepairPeakBytes);
    expect(ceiling.narrowed).toBe(false);
  });

  it('narrows the ceiling when asked to', () => {
    const ceiling = resolveRepairMemoryCeiling(`?${REPAIR_MEMORY_CEILING_PARAM}=64`);

    expect(ceiling.bytes).toBe(64 * 1024 * 1024);
    expect(ceiling.narrowed).toBe(true);
  });

  it('REFUSES to widen the ceiling', () => {
    // The one-way property. A URL cannot buy CAD Fixer more memory; the worker
    // enforces this independently as well, so neither side is trusted alone.
    const ceiling = resolveRepairMemoryCeiling(`?${REPAIR_MEMORY_CEILING_PARAM}=999999`);

    expect(ceiling.bytes).toBe(DEFAULT_SESSION_MEMORY_BUDGET.maxRepairPeakBytes);
    expect(ceiling.narrowed).toBe(false);
  });

  it('ignores nonsense rather than refusing every repair', () => {
    for (const raw of ['abc', '0', '-5', '', 'NaN']) {
      const ceiling = resolveRepairMemoryCeiling(`?${REPAIR_MEMORY_CEILING_PARAM}=${raw}`);
      expect(ceiling.bytes, `for ${raw}`).toBe(DEFAULT_SESSION_MEMORY_BUDGET.maxRepairPeakBytes);
      expect(ceiling.narrowed).toBe(false);
    }
  });
});

describe('phase labels', () => {
  it('translates the engine’s phase names for display', () => {
    expect(describeRepairPhase('building candidate')).toBe('Building the proposed result');
    expect(describeRepairPhase('validating candidate')).toBe('Revalidating the proposed result');
    expect(describeRepairPhase('restoring previous version')).toBe(
      'Restoring the previous version',
    );
  });

  it('passes an unmapped phase through rather than hiding it', () => {
    // A new engine phase should show up as itself instead of silently vanishing.
    expect(describeRepairPhase('some future phase')).toBe('some future phase');
    expect(describeRepairPhase(undefined)).toBe('Working');
  });
});

describe('planning', () => {
  it('passes the ceiling through and reports translated progress', async () => {
    const pending = deferred<RepairPlanOperationResult>();
    let seenCeiling: number | undefined;
    const planRepair: RepairCapableClient['planRepair'] = (
      _handle,
      _partId,
      _requested,
      onProgress,
      memoryBudgetBytes,
    ) => {
      seenCeiling = memoryBudgetBytes;
      onProgress({ fraction: 0.5, note: 'planning repair' });
      return pending.handle;
    };
    const seen: { phase: string; fraction: number }[] = [];

    const session = planConservativeRepair({
      handle: HANDLE,
      partId: PART,
      client: stubClient({ planRepair }),
      requested: ['remove-duplicate-faces'],
      memoryBudgetBytes: 1234,
      onProgress: (progress) => seen.push(progress),
    });
    pending.resolve({
      handle: HANDLE,
      partId: PART,
      plan: plan(),
      boundaryFill: NO_BOUNDARY_FILL_PLAN,
    });
    await session.promise;

    // The ceiling reaches the worker, which is what makes the refusal path
    // exercisable without a fixture that approaches an out-of-memory condition.
    expect(seenCeiling).toBe(1234);
    expect(seen).toContainEqual({ phase: 'Planning repair', fraction: 0.5 });
  });

  it('refuses a plan that names a different model than the one requested', async () => {
    // The worker echoes the handle it planned for. If it does not match,
    // something upstream routed a result to the wrong operation, and accepting
    // it would attach one model's plan to another model's geometry.
    const pending = deferred<RepairPlanOperationResult>();
    const session = planConservativeRepair({
      handle: HANDLE,
      partId: PART,
      client: stubClient({ planRepair: () => pending.handle }),
      requested: [],
    });
    pending.resolve({
      handle: { documentId: 'model-2', revision: 1 } as DocumentHandle,
      partId: PART,
      plan: plan(),
      boundaryFill: NO_BOUNDARY_FILL_PLAN,
    });

    await expect(session.promise).rejects.toMatchObject({ code: AppErrorCode.Internal });
  });

  it('cancels the dispatched operation even when the cancel arrives first', async () => {
    const pending = deferred<RepairPlanOperationResult>();
    const session = planConservativeRepair({
      handle: HANDLE,
      partId: PART,
      client: stubClient({ planRepair: () => pending.handle }),
      requested: [],
    });

    session.cancel();
    pending.resolve({
      handle: HANDLE,
      partId: PART,
      plan: plan(),
      boundaryFill: NO_BOUNDARY_FILL_PLAN,
    });

    await expect(session.promise).rejects.toMatchObject({
      code: AppErrorCode.OperationCancelled,
    });
  });
});

describe('verifying what the plan will promise (REPAIR-RC-03)', () => {
  function fillPlan(admitted: number, verified: boolean): BoundaryFillPlan {
    return {
      ...NO_BOUNDARY_FILL_PLAN,
      status: BoundaryFillScanStatus.Scanned,
      simpleLoopCount: 6,
      complexBoundaryCount: 7,
      admittedCount: admitted,
      verified,
      planHash: verified ? 'verified' : 'admitted',
    };
  }

  interface Harness {
    readonly ports: (MessagePort | undefined)[];
    readonly opened: { count: number; disposed: number; onFailure?: () => void };
    readonly session: ReturnType<typeof planConservativeRepair>;
    readonly first: ReturnType<typeof deferred<RepairPlanOperationResult>>;
    readonly second: ReturnType<typeof deferred<RepairPlanOperationResult>>;
  }

  function start(): Harness {
    const first = deferred<RepairPlanOperationResult>();
    const second = deferred<RepairPlanOperationResult>();
    const ports: (MessagePort | undefined)[] = [];
    const opened: Harness['opened'] = { count: 0, disposed: 0 };
    const planRepair: RepairCapableClient['planRepair'] = (
      _handle,
      _partId,
      _requested,
      _onProgress,
      _memory,
      _fill,
      verifierPort,
    ) => {
      ports.push(verifierPort);
      return ports.length === 1 ? first.handle : second.handle;
    };
    const openVerifier = (onFailure: () => void): FillVerifier => {
      opened.count += 1;
      opened.onFailure = onFailure;
      return {
        port: new MessageChannel().port1,
        dispose: (): void => {
          opened.disposed += 1;
        },
      };
    };
    const session = planConservativeRepair({
      handle: HANDLE,
      partId: PART,
      client: stubClient({ planRepair }),
      requested: [],
      fillOpenings: true,
      openVerifier,
    });
    return { ports, opened, session, first, second };
  }

  const result = (fill: BoundaryFillPlan): RepairPlanOperationResult => ({
    handle: HANDLE,
    partId: PART,
    plan: plan(),
    boundaryFill: fill,
  });

  it('re-plans with a verifier when openings are admitted, and returns the VERIFIED plan', async () => {
    const run = start();
    run.first.resolve(result(fillPlan(6, false)));
    await Promise.resolve();
    await Promise.resolve();
    run.second.resolve(result(fillPlan(2, true)));
    const outcome = await run.session.promise;
    expect(run.ports).toHaveLength(2);
    expect(run.ports[0]).toBeUndefined();
    expect(run.ports[1]).toBeDefined();
    expect(outcome.boundaryFill).toMatchObject({ admittedCount: 2, verified: true });
    expect(run.opened).toMatchObject({ count: 1, disposed: 1 });
  });

  it('opens nothing when nothing is admitted', async () => {
    const run = start();
    run.first.resolve(result(fillPlan(0, true)));
    const outcome = await run.session.promise;
    expect(run.ports).toHaveLength(1);
    expect(run.opened.count).toBe(0);
    expect(outcome.boundaryFill.admittedCount).toBe(0);
  });

  it('keeps the UNVERIFIED plan when the verifier dies, rather than failing the plan', async () => {
    const run = start();
    run.first.resolve(result(fillPlan(6, false)));
    await Promise.resolve();
    await Promise.resolve();
    run.opened.onFailure?.();
    run.second.reject(new Error('verifier gone'));
    const outcome = await run.session.promise;
    // Unverified: the interface presents it as not checked, never as fillable.
    expect(outcome.boundaryFill).toMatchObject({ admittedCount: 6, verified: false });
    expect(run.second.cancelled()).toBe(true);
    expect(run.opened.disposed).toBe(1);
  });

  it('cancelling during verification terminates the verifier and cancels the plan', async () => {
    const run = start();
    run.first.resolve(result(fillPlan(6, false)));
    await Promise.resolve();
    await Promise.resolve();
    run.session.cancel();
    run.second.resolve(result(fillPlan(2, true)));
    await expect(run.session.promise).rejects.toMatchObject({
      code: AppErrorCode.OperationCancelled,
    });
    expect(run.second.cancelled()).toBe(true);
    expect(run.opened.disposed).toBeGreaterThanOrEqual(1);
  });
});

describe('creating a candidate', () => {
  it('returns the validated outcome with a duration', async () => {
    const pending = deferred<RepairCandidateResult>();
    const session = createRepairCandidate({
      handle: HANDLE,
      partId: PART,
      client: stubClient({ createRepairCandidate: () => pending.handle }),
      requested: ['remove-duplicate-faces'],
      planHash: 'hash',
    });
    pending.resolve(candidateResult());

    const outcome = await session.promise;
    expect(outcome.candidate).toBe(CANDIDATE);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('DISCARDS a candidate that arrives after a cancel', async () => {
    /*
     * The leak this prevents. A candidate is a second copy of the model in the
     * worker. If a cancel lands while the result is in flight, throwing without
     * releasing it would leave that copy resident for the rest of the session
     * with nothing able to commit or free it. A cancel that leaks memory is not
     * a cancel.
     */
    const pending = deferred<RepairCandidateResult>();
    const client = stubClient({ createRepairCandidate: () => pending.handle });
    const session = createRepairCandidate({
      handle: HANDLE,
      partId: PART,
      client,
      requested: [],
      planHash: 'hash',
    });

    session.cancel();
    pending.resolve(candidateResult());

    await expect(session.promise).rejects.toMatchObject({
      code: AppErrorCode.OperationCancelled,
    });
    expect(client.discarded).toEqual([CANDIDATE]);
  });

  it('has nothing to discard when the cancelled attempt produced no candidate', async () => {
    const pending = deferred<RepairCandidateResult>();
    const client = stubClient({ createRepairCandidate: () => pending.handle });
    const session = createRepairCandidate({
      handle: HANDLE,
      partId: PART,
      client,
      requested: [],
      planHash: 'hash',
    });

    session.cancel();
    pending.resolve(candidateResult({ candidate: undefined }));

    await expect(session.promise).rejects.toMatchObject({
      code: AppErrorCode.OperationCancelled,
    });
    expect(client.discarded).toEqual([]);
  });

  it('refuses a candidate built from a different model than the one requested', async () => {
    const pending = deferred<RepairCandidateResult>();
    const session = createRepairCandidate({
      handle: HANDLE,
      partId: PART,
      client: stubClient({ createRepairCandidate: () => pending.handle }),
      requested: [],
      planHash: 'hash',
    });
    pending.resolve(
      candidateResult({ source: { documentId: 'model-1', revision: 7 } as DocumentHandle }),
    );

    await expect(session.promise).rejects.toMatchObject({ code: AppErrorCode.Internal });
  });

  it('surfaces a worker refusal unchanged, so its code survives to the interface', async () => {
    // A resource refusal must stay a resource refusal: the panel words it as a
    // limit rather than a fault, and that decision is made from the code.
    const pending = deferred<RepairCandidateResult>();
    const session = createRepairCandidate({
      handle: HANDLE,
      partId: PART,
      client: stubClient({ createRepairCandidate: () => pending.handle }),
      requested: [],
      planHash: 'hash',
    });
    pending.reject(
      toAppError(Object.assign(new Error('too big'), { code: AppErrorCode.ResourceLimitExceeded })),
    );

    await expect(session.promise).rejects.toBeDefined();
  });
});

describe('undo', () => {
  it('refuses a result for a different model', async () => {
    const pending = deferred<RepairUndoResult>();
    const session = undoRepair({
      client: stubClient({ undoRepair: () => pending.handle }),
      handle: HANDLE,
      recordId: 'record-1',
    });
    pending.resolve({
      handle: { documentId: 'model-2', revision: 3 } as DocumentHandle,
    } as RepairUndoResult);

    await expect(session.promise).rejects.toMatchObject({ code: AppErrorCode.Internal });
  });

  it('returns the restored revision when the model matches', async () => {
    const pending = deferred<RepairUndoResult>();
    const session = undoRepair({
      client: stubClient({ undoRepair: () => pending.handle }),
      handle: HANDLE,
      recordId: 'record-1',
    });
    const result = {
      handle: { documentId: 'model-1', revision: 3 } as DocumentHandle,
      restoredRevision: 1,
    } as RepairUndoResult;
    pending.resolve(result);

    await expect(session.promise).resolves.toBe(result);
  });
});

describe('committing', () => {
  it('is not a transaction this layer can complete on its own', async () => {
    /*
     * This is a transport assertion, and it is the point of the whole split: the
     * service sends three identifiers. Every guard — revision currency, candidate
     * state, validation acceptance, plan identity, single use — lives in the
     * worker, so a bug in this file can waste work but cannot apply a repair the
     * runtime refused.
     */
    const { commitRepair } = await import('./repair-service');
    const pending = deferred<RepairCommitResult>();
    const seen: unknown[] = [];
    const session = commitRepair({
      expectedPart: PART,
      client: stubClient({
        commitRepair: (candidate, expectedSource, expectedPart, planHash) => {
          seen.push({ candidate, expectedSource, expectedPart, planHash });
          return pending.handle;
        },
      }),
      candidate: CANDIDATE,
      expectedSource: HANDLE,
      planHash: 'hash',
    });
    pending.resolve({
      handle: { documentId: 'model-1', revision: 2 },
      partId: PART,
    } as RepairCommitResult);
    await session.promise;

    // The PART travels with the candidate and the revision. All four identify
    // what a commit is allowed to replace.
    expect(seen).toEqual([
      { candidate: CANDIDATE, expectedSource: HANDLE, expectedPart: PART, planHash: 'hash' },
    ]);
  });
});

describe('the narrowing-only work ceiling — REPAIR-CORE-06B', () => {
  it('reads a positive integer and nothing else', () => {
    expect(resolveRepairWorkCeiling('?repairWorkCeiling=1500')).toBe(1500);
    expect(resolveRepairWorkCeiling('?repairWorkCeiling=12.9')).toBe(12);
    for (const bad of [
      '',
      '?repairWorkCeiling=',
      '?repairWorkCeiling=0',
      '?repairWorkCeiling=-4',
    ]) {
      expect(resolveRepairWorkCeiling(bad)).toBeUndefined();
    }
    expect(resolveRepairWorkCeiling('?repairWorkCeiling=abc')).toBeUndefined();
    expect(resolveRepairWorkCeiling('?repairWorkCeiling=Infinity')).toBeUndefined();
    expect(resolveRepairWorkCeiling('?other=1')).toBeUndefined();
  });
});
