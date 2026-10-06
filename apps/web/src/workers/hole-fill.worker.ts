/// <reference lib="webworker" />

import {
  classifyLocalPatches,
  runHoleFill,
  runLocalRepair,
  HoleFillStatus,
} from '@cadfixer/mesh-hole-fill';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { createKernelNarrowphase, loadHoleFillKernel } from './hole-fill-narrowphase';
import type {
  HoleFillGeometryMessage,
  HoleFillPortMessage,
  HoleFillWorkerOutbound,
  HoleFillWorkerReply,
  LocalRepairMessage,
  LocalRepairResultWire,
  LocalVerifyMessage,
  LocalVerifyReply,
} from './hole-fill-protocol';

/**
 * THE DISPOSABLE HOLE-FILL WORKER.
 *
 * WHY IT IS DISPOSABLE, and why that is not laziness. The fill runs as ONE
 * synchronous pass — loop resolution, triangulation, topology, broadphase, and
 * a long sequence of exact C++ narrowphase calls that poll no JavaScript flag.
 * A cooperative token could not be read until the pass returned, so a Cancel
 * button backed by one would quietly do nothing. Cancellation here is
 * `terminate()` from the controller, which stops the thread wherever it is.
 *
 * WHAT IT NEVER TOUCHES. The authoritative geometry worker is a different
 * worker and is never terminated. This one receives a DISPOSABLE COPY over a
 * MessageChannel and sends a candidate back the same way, so killing this
 * thread can take nothing authoritative with it — a refusal, a crash and a
 * cancellation all leave the user's model exactly as it was.
 *
 * THE KERNEL IS LOADED HERE AND ONLY HERE, for this operation. A user who never
 * fills a hole never pays for the WebAssembly, because this module is
 * constructed on demand.
 */

const post = (message: HoleFillWorkerOutbound): void => {
  self.postMessage(message);
};

/** Rebuilds the canonical mesh from the copy. No welding, no reordering. */
function meshFrom(message: HoleFillGeometryMessage): CanonicalMesh {
  return {
    positions: message.positions,
    indices: message.indices,
    // Honest: the copy carries geometry and nothing else. A source format the
    // fill did not read is not something to claim.
    metadata: {},
  };
}

async function runFill(port: MessagePort, message: HoleFillGeometryMessage): Promise<void> {
  const faceCount = Math.floor(message.indices.length / 3);
  post({ kind: 'started', operationId: message.operationId, faceCount });

  const module = await loadHoleFillKernel();
  const narrowphase = createKernelNarrowphase(module);

  const result = runHoleFill({
    source: meshFrom(message),
    request: {
      operationId: message.operationId,
      documentId: message.documentId,
      revision: message.documentRevision,
      partId: message.partId,
      boundaryLoopId: message.boundaryLoopId,
    },
    narrowphase,
    ...(message.limits === undefined ? {} : { limits: message.limits }),
    now: () => performance.now(),
  });

  const candidate = result.candidate;
  if (candidate === undefined || result.outcome.status !== HoleFillStatus.ValidCandidate) {
    const reply: HoleFillWorkerReply = {
      kind: 'result',
      operationId: message.operationId,
      status: result.outcome.status,
      summary: result.outcome.summary,
      intersectionSamples: result.outcome.intersectionSamples,
      samplesTruncated: result.outcome.samplesTruncated,
    };
    port.postMessage(reply, [result.outcome.intersectionSamples.buffer]);
    return;
  }

  /*
   * THE CANDIDATE'S POSITION BUFFER IS THE ONE THAT ARRIVED, shared by
   * reference because the triangulator adds no vertex and moves none. It is
   * copied here before transfer for one reason: the source mesh and the
   * candidate hold the SAME buffer, and transferring it once would detach it
   * from both. A fresh copy keeps the transfer list honest.
   */
  const positions = new Float32Array(candidate.positions);
  const indices = new Uint32Array(candidate.indices);
  const reply: HoleFillWorkerReply = {
    kind: 'result',
    operationId: message.operationId,
    status: result.outcome.status,
    summary: result.outcome.summary,
    intersectionSamples: result.outcome.intersectionSamples,
    samplesTruncated: result.outcome.samplesTruncated,
    positions,
    indices,
  };
  port.postMessage(reply, [
    positions.buffer,
    indices.buffer,
    result.outcome.intersectionSamples.buffer,
  ]);
}

/**
 * REPAIR-CORE-02: the exact check over a LOCAL region, one verdict per loop.
 *
 * The same kernel and the same patch-attributed question as `runFill`, asked of
 * the small region the authoritative worker collected rather than of a copy of
 * the whole part. Nothing comes back but scalars: the patches themselves stay
 * with the authoritative worker, which decides what to append.
 */
async function runLocalVerify(port: MessagePort, message: LocalVerifyMessage): Promise<void> {
  const module = await loadHoleFillKernel();
  const verdicts = classifyLocalPatches(
    {
      positions: message.positions,
      triangles: message.triangles,
      sourceFaceCount: message.sourceFaceCount,
      loopRanges: message.loopRanges,
      loopIds: [],
      excluded: [],
    },
    createKernelNarrowphase(module),
  );
  const reply: LocalVerifyReply = {
    kind: 'verified',
    operationId: message.operationId,
    verdicts: verdicts.map((verdict) => ({ ...verdict })),
  };
  port.postMessage(reply);
}

/**
 * REPAIR-CORE-06A: the whole local pinch repair — the primary search and the bounded residual
 * phase — on a disposable COPY of the part, with the exact kernel in this worker.
 *
 * Only a PATCH comes back: which faces went, which were reversed, and what was appended, in the
 * source's own slot space. The authoritative worker builds and validates the candidate itself.
 * Cancellation is `terminate()` from the controller; the engine also polls between sites for the
 * cooperative case, and its deterministic work meter stops it at a safe point.
 */
async function runLocalRepairMessage(
  port: MessagePort,
  message: LocalRepairMessage,
): Promise<void> {
  const module = await loadHoleFillKernel();
  const result = runLocalRepair({
    mesh: { positions: message.positions, indices: message.indices, metadata: {} },
    makeNarrowphase: () => createKernelNarrowphase(module),
    limits: message.limits,
    onProgress: (progress) => {
      port.postMessage({
        kind: 'local-repair-progress',
        operationId: message.operationId,
        phase: progress.phase,
        attempted: progress.attempted,
        total: progress.total,
        repaired: progress.repaired,
        primaryWorkUnits: progress.primaryWorkUnits,
        residualWorkUnits: progress.residualWorkUnits,
      });
    },
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
        windingComponentsResolved: result.residual.windingResolutions.filter(
          (w) => w.outcome === 'resolved',
        ).length,
        windingFacesReversed: result.residual.windingResolutions.reduce(
          (sum, w) => sum + (w.outcome === 'resolved' ? w.flips : 0),
          0,
        ),
      },
    },
    ...(patch === undefined ? {} : { patch }),
  };
  port.postMessage(
    reply,
    patch === undefined
      ? []
      : [
          patch.removedSourceFaces.buffer,
          patch.flippedSourceFaces.buffer,
          patch.appendedPositions.buffer,
          patch.appendedFaces.buffer,
        ],
  );
}

self.addEventListener('message', (event: MessageEvent<HoleFillPortMessage>) => {
  const port = event.data.port;
  port.onmessage = (
    geometry: MessageEvent<HoleFillGeometryMessage | LocalVerifyMessage | LocalRepairMessage>,
  ): void => {
    if (geometry.data.kind === 'local-repair') {
      const request = geometry.data;
      void runLocalRepairMessage(port, request).catch((cause: unknown) => {
        // A failure is still an answer; the authoritative side is awaiting it.
        port.postMessage({
          kind: 'failed',
          operationId: request.operationId,
          reason: cause instanceof Error ? cause.message : 'the local repair failed',
        });
      });
      return;
    }
    if (geometry.data.kind === 'verify-local') {
      const request = geometry.data;
      void runLocalVerify(port, request).catch((cause: unknown) => {
        // A failure is still an answer; the authoritative side is awaiting it.
        const failure: LocalVerifyReply = {
          kind: 'failed',
          operationId: request.operationId,
          reason: cause instanceof Error ? cause.message : 'the local check failed',
        };
        port.postMessage(failure);
      });
      return;
    }
    const fill = geometry.data;
    void runFill(port, fill).catch((cause: unknown) => {
      /*
       * A FAILURE IS STILL AN ANSWER. The authoritative worker is awaiting this
       * channel; staying silent would leave its operation pending forever and
       * the panel saying "filling…" with nothing running.
       */
      const failure: HoleFillWorkerReply = {
        kind: 'failed',
        operationId: fill.operationId,
        reason: cause instanceof Error ? cause.message : 'the hole-fill engine failed',
      };
      port.postMessage(failure);
    });
  };
  port.start();
  post({ kind: 'ready' });
});

export {};
