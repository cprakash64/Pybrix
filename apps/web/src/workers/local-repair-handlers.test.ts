import { afterEach, describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  singlePartDocument,
  partId,
  type CanonicalMesh,
  type PartId,
} from '@cadfixer/mesh-core';
import {
  LocalRepairNotRun,
  LocalRepairOutcomeKind,
  RepairAcceptance,
  type RepairCandidateResult,
  type DocumentHandle,
  type OperationContext,
  type ProtocolPort,
  type RepairOperation,
} from '@cadfixer/geometry-runtime';
import {
  AppErrorCode,
  CancellationSource,
  isAppError,
  operationCancelled,
  uncancellable,
  type CancellationToken,
} from '@cadfixer/shared';
import { runLocalRepair, type LocalRepairLimits } from '@cadfixer/mesh-hole-fill';
import * as fx from '@cadfixer/mesh-hole-fill/fixtures';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { repairCandidates, repairHistory, residentDocuments } from './stl-handlers';
import {
  repairCommitHandler,
  repairCreateCandidateHandler,
  repairPlanHandler,
  repairUndoHandler,
} from './repair-handlers';
import type { LocalRepairMessage, LocalRepairResultWire } from './hole-fill-protocol';

/**
 * REPAIR-CORE-06A THROUGH THE REAL HANDLERS.
 *
 * Plan -> candidate (with a verifier channel) -> commit -> undo, in-process, against the resident
 * store the product uses. The verifier answers like the disposable kernel worker — it runs the
 * SAME `runLocalRepair` and sends the SAME patch — with the test-only reference narrowphase. What
 * the Geogram kernel decides on real geometry is qualified by `npm run qualify:repair-core-06a`.
 */

const PART = partId('part-1');
const REQUESTED: readonly RepairOperation[] = [];

type P = readonly [number, number, number];

/** `count` tetrahedron pairs, each pair sharing one corner coordinate (one pinched vertex). */
function pairs(count: number, spacing = 6): CanonicalMesh {
  const points: P[] = [];
  const faces: (readonly [number, number, number])[] = [];
  for (let i = 0; i < count; i += 1) {
    const dx = (i % 5) * spacing;
    const dy = Math.floor(i / 5) * spacing;
    const base: P[] = [
      [0, 0, 0],
      [1, 0, 1],
      [-0.5, 0.9, 1],
      [-0.5, -0.9, 1.1],
      [-1, 0.1, -1],
      [0.5, -0.9, -1.2],
      [0.45, 0.95, -1.1],
    ];
    const o = points.length;
    for (const p of base) points.push([p[0] + dx, p[1] + dy, p[2]]);
    for (const f of [
      [0, 2, 1],
      [0, 3, 2],
      [0, 1, 3],
      [1, 2, 3],
      [0, 4, 5],
      [0, 5, 6],
      [0, 6, 4],
      [4, 6, 5],
    ] as const) {
      faces.push([f[0] + o, f[1] + o, f[2] + o]);
    }
  }
  const positions = createPositionArray(points.length * 3);
  points.forEach((p, i) => {
    positions.set(p, i * 3);
  });
  const indices = createIndexArray(faces.length * 3);
  faces.forEach((f, i) => {
    indices.set(f, i * 3);
  });
  return { positions, indices, metadata: { sourceFormat: '3mf' } };
}

function context(cancellation: CancellationToken = uncancellable): OperationContext {
  return {
    cancellation,
    interruptible: true,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

interface Verifier {
  readonly port: ProtocolPort;
  readonly requests: LocalRepairMessage[];
  close(): void;
}

/** A verifier that answers like the kernel worker — or never, when `silent`. */
function verifier(
  options: { readonly silent?: boolean; readonly limits?: LocalRepairLimits } = {},
): Verifier {
  const channel = new MessageChannel();
  const requests: LocalRepairMessage[] = [];
  channel.port2.onmessage = (event: MessageEvent<LocalRepairMessage>): void => {
    const message = event.data;
    requests.push(message);
    if (options.silent === true) return;
    const result = runLocalRepair({
      mesh: { positions: message.positions, indices: message.indices, metadata: {} },
      makeNarrowphase: () => fx.referenceNarrowphase(),
      limits: options.limits ?? message.limits,
    });
    const patch = result.patch;
    const reply: LocalRepairResultWire = {
      kind: 'local-repair-result',
      operationId: message.operationId,
      outcome: {
        kind: result.kind,
        cancelled: result.cancelled,
        counts: {
          eligible: result.counts.eligible,
          unsupportedNonManifoldEdge: result.counts.unsupportedNonManifoldEdge,
          repaired: result.counts.repaired,
          remaining: result.counts.remaining,
          unattempted: result.counts.unattempted,
          remainingByReason: result.counts.remainingByReason,
        },
        limitReached: result.limitReached,
        work: {
          primary: { used: result.work.primary.used, limit: result.work.primary.limit },
          residual: { used: result.work.residual.used, limit: result.work.residual.limit },
        },
        residual: {
          ran: result.residual.ran,
          skippedBecause: result.residual.skippedBecause,
          linkRetriangulations: result.residual.linkRetriangulations,
          primaryAfterResidual: result.residual.primaryAfterResidual,
          windingComponentsResolved: 0,
          windingFacesReversed: 0,
        },
      },
      ...(patch === undefined ? {} : { patch }),
    };
    channel.port2.postMessage(reply);
  };
  return {
    port: channel.port1,
    requests,
    close: (): void => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function resident(handle: DocumentHandle, part: PartId = PART): CanonicalMesh {
  const resolved = residentDocuments.resolvePart(handle, part);
  if (isAppError(resolved)) throw resolved;
  return resolved.mesh;
}

function nonManifoldVertices(mesh: CanonicalMesh): number {
  return analyseTopology(mesh, {
    documentId: 'd',
    documentRevision: 1,
    partId: 'p',
    cancellation: uncancellable,
  }).report.nonManifoldVertexCount;
}

async function plan(handle: DocumentHandle): Promise<{ planHash: string; localHash: string }> {
  const planned = (
    await repairPlanHandler(
      { handle, partId: PART, requested: REQUESTED, localRepair: true },
      context(),
    )
  ).value;
  const local = planned.localRepair;
  if (local === undefined) throw new Error('no local plan');
  return { planHash: planned.plan.planHash, localHash: local.planHash };
}

afterEach(() => {
  residentDocuments.releaseAll();
  repairCandidates.releaseAll();
  repairHistory.releaseAll();
});

describe('local repair planning', () => {
  it('counts pinched vertices from topology alone and opens nothing', async () => {
    const handle = residentDocuments.commit(singlePartDocument(pairs(3)));
    const planned = (
      await repairPlanHandler(
        { handle, partId: PART, requested: REQUESTED, localRepair: true },
        context(),
      )
    ).value;
    expect(planned.localRepair?.requested).toBe(true);
    expect(planned.localRepair?.pinchedVertices).toBe(3);
    expect(planned.localRepair?.eligible).toBe(3);
    expect(planned.localRepair?.estimatedWorkLowerBound).toBeGreaterThan(0);
  });

  it('plans nothing when the local repair is not asked for', async () => {
    const handle = residentDocuments.commit(singlePartDocument(pairs(1)));
    const planned = await repairPlanHandler(
      { handle, partId: PART, requested: REQUESTED },
      context(),
    );
    expect(planned.value.localRepair).toBeUndefined();
  });
});

describe('local repair candidate, commit and undo', () => {
  it('builds ONE validated candidate, commits atomically and undo restores the exact object', async () => {
    const mesh = pairs(3);
    const handle = residentDocuments.commit(singlePartDocument(mesh));
    const { planHash, localHash } = await plan(handle);
    const check = verifier();
    const built = await repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash,
        localRepair: true,
        localRepairPlanHash: localHash,
        verifierPort: check.port,
      },
      context(),
    );
    check.close();
    const value = built.value;
    expect(value.validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(value.localRepair?.kind).toBe(LocalRepairOutcomeKind.Complete);
    expect(value.localRepair?.repaired).toBe(3);
    // A COPY crossed to the verifier: the authoritative arrays are still usable.
    expect(check.requests).toHaveLength(1);
    expect(mesh.positions.length).toBeGreaterThan(0);
    const candidate = value.candidate;
    if (candidate === undefined) throw new Error('no candidate');

    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, planHash },
      context(),
    );
    expect(nonManifoldVertices(resident(committed.value.handle))).toBe(0);
    const undone = await repairUndoHandler(
      { handle: committed.value.handle, recordId: committed.value.repairRecordId },
      context(),
    );
    expect(resident(undone.value.handle)).toBe(mesh);
    expect(nonManifoldVertices(mesh)).toBe(3);
  });

  it('reports a work limit as a typed outcome, never an error, and applies a whole-operation prefix', async () => {
    const mesh = pairs(10);
    const handle = residentDocuments.commit(singlePartDocument(mesh));
    const { planHash, localHash } = await plan(handle);
    const check = verifier({ limits: { primary: 500, residual: undefined } });
    const built = await repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash,
        localRepair: true,
        localRepairPlanHash: localHash,
        verifierPort: check.port,
      },
      context(),
    );
    check.close();
    const outcome = built.value.localRepair;
    expect(outcome?.kind).toBe(LocalRepairOutcomeKind.PartialLimit);
    expect(outcome?.limitReached).toBe('primary');
    expect(outcome?.unattempted).toBeGreaterThan(0);
    // No half operation: whatever was repaired is whole, and the candidate is still valid.
    expect(built.value.validation.acceptance).toBe(RepairAcceptance.Accepted);
    const candidate = built.value.candidate;
    if (candidate === undefined) throw new Error('no candidate');
    expect(outcome?.repaired).toBeGreaterThan(0);
    expect(outcome?.repaired).toBeLessThan(10);
  });

  it('FINAL GEOMETRY SAFETY: whatever limit stops the run, the candidate is whole and valid', async () => {
    for (const cap of [200, 400, 800, 1_200, 2_000, 1_000_000]) {
      const mesh = pairs(6);
      const handle = residentDocuments.commit(singlePartDocument(mesh));
      const { planHash, localHash } = await plan(handle);
      const check = verifier({ limits: { primary: cap, residual: undefined } });
      const built = await repairCreateCandidateHandler(
        {
          handle,
          partId: PART,
          requested: REQUESTED,
          planHash,
          localRepair: true,
          localRepairPlanHash: localHash,
          verifierPort: check.port,
        },
        context(),
      );
      check.close();
      const outcome = built.value.localRepair;
      if (outcome === undefined) throw new Error('no outcome');
      const candidate = built.value.candidate;
      if (outcome.repaired === 0) {
        expect(candidate).toBeUndefined();
        continue;
      }
      if (candidate === undefined) throw new Error(`no candidate at cap ${String(cap)}`);
      const committed = await repairCommitHandler(
        { candidate, expectedSource: handle, expectedPart: PART, planHash },
        context(),
      );
      // Exactly the sites reported repaired are repaired, and none is half-done.
      expect(nonManifoldVertices(resident(committed.value.handle))).toBe(6 - outcome.repaired);
      residentDocuments.releaseAll();
      repairCandidates.releaseAll();
      repairHistory.releaseAll();
    }
  });

  it('STALE RESULT: a candidate for a revision the user has left cannot be applied twice', async () => {
    const handle = residentDocuments.commit(singlePartDocument(pairs(3)));
    const { planHash, localHash } = await plan(handle);
    const build = async (): Promise<NonNullable<RepairCandidateResult['candidate']>> => {
      const check = verifier();
      const built = await repairCreateCandidateHandler(
        {
          handle,
          partId: PART,
          requested: REQUESTED,
          planHash,
          localRepair: true,
          localRepairPlanHash: localHash,
          verifierPort: check.port,
        },
        context(),
      );
      check.close();
      if (built.value.candidate === undefined) throw new Error('no candidate');
      return built.value.candidate;
    };
    const first = await build();
    await repairCommitHandler(
      { candidate: first, expectedSource: handle, expectedPart: PART, planHash },
      context(),
    );
    // The document moved on: the candidate describes geometry that no longer exists.
    await expect(
      (async (): ReturnType<typeof repairCommitHandler> =>
        repairCommitHandler(
          { candidate: first, expectedSource: handle, expectedPart: PART, planHash },
          context(),
        ))(),
    ).rejects.toMatchObject({ code: AppErrorCode.ModelUnavailable });
  });

  it('a work ceiling may only NARROW the product budget, never widen it', async () => {
    const handle = residentDocuments.commit(singlePartDocument(pairs(2)));
    const { planHash, localHash } = await plan(handle);
    const sent: (number | undefined)[] = [];
    for (const ceiling of [500, 50_000_000]) {
      const check = verifier();
      await repairCreateCandidateHandler(
        {
          handle,
          partId: PART,
          requested: REQUESTED,
          planHash,
          localRepair: true,
          localRepairPlanHash: localHash,
          localRepairWorkCeiling: ceiling,
          verifierPort: check.port,
        },
        context(),
      );
      check.close();
      sent.push(check.requests[0]?.limits.primary);
      repairCandidates.releaseAll();
    }
    expect(sent[0]).toBe(500);
    expect(sent[1]).toBe(1_200_000);
  });

  it('fails closed without a verifier: nothing is repaired and the reason is typed', async () => {
    const handle = residentDocuments.commit(singlePartDocument(pairs(2)));
    const { planHash, localHash } = await plan(handle);
    const built = await repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash,
        localRepair: true,
        localRepairPlanHash: localHash,
      },
      context(),
    );
    expect(built.value.candidate).toBeUndefined();
    expect(built.value.localRepairNotRun).toBe(LocalRepairNotRun.NoVerifier);
  });

  it('refuses a candidate whose local plan no longer matches the source', async () => {
    const handle = residentDocuments.commit(singlePartDocument(pairs(2)));
    const { planHash } = await plan(handle);
    const check = verifier();
    await expect(
      repairCreateCandidateHandler(
        {
          handle,
          partId: PART,
          requested: REQUESTED,
          planHash,
          localRepair: true,
          localRepairPlanHash: 'lr-stale',
          verifierPort: check.port,
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    check.close();
    expect(check.requests).toHaveLength(0);
  });

  it('a cancel while the kernel worker is running leaves nothing registered', async () => {
    const handle = residentDocuments.commit(singlePartDocument(pairs(2)));
    const { planHash, localHash } = await plan(handle);
    const check = verifier({ silent: true });
    const source = new CancellationSource();
    const pending = repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash,
        localRepair: true,
        localRepairPlanHash: localHash,
        verifierPort: check.port,
      },
      context(source.token),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    source.cancel();
    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    check.close();
    expect(check.requests).toHaveLength(1);
  });
});
