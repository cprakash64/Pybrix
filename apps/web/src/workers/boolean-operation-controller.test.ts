import { describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  MAX_SUPPORTED_SPLIT_TRIANGLES,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { MAX_BOOLEAN_TOOL_TRIANGLES } from '@cadfixer/geometry-runtime';
import { AppErrorCode, CancellationSource, uncancellable } from '@cadfixer/shared';
import {
  BooleanOperationController,
  MAX_BOOLEAN_KNOWN_WORK_BYTES,
  MAX_BOOLEAN_OPERAND_TRIANGLES,
  MAX_BOOLEAN_OPERATION_COPY_BYTES,
  MAX_BOOLEAN_OPERATION_INPUT_TRIANGLES,
  measureBooleanOperation,
  type BooleanWorkerFactory,
} from './boolean-operation-controller';
import type { BooleanOperationReply, BooleanOperationRequest } from './boolean-operation-protocol';

function tetra(offset = 0): CanonicalMesh {
  const positions = createPositionArray(12);
  positions.set([offset, 0, 0, offset + 1, 0, 0, offset, 1, 0, offset, 0, 1]);
  const indices = createIndexArray(12);
  indices.set([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  return { positions, indices, metadata: {} };
}

class FakeWorker {
  public terminated = false;
  public request: BooleanOperationRequest | undefined;
  private message: ((event: MessageEvent<BooleanOperationReply>) => void) | undefined;
  private error: (() => void) | undefined;
  public postMessage(message: BooleanOperationRequest): void {
    this.request = message;
  }
  public addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent<BooleanOperationReply>) => void) | (() => void),
  ): void {
    if (type === 'message') this.message = listener;
    else this.error = listener as () => void;
  }
  public terminate(): void {
    this.terminated = true;
  }
  public reply(message: BooleanOperationReply): void {
    this.message?.({ data: message } as MessageEvent<BooleanOperationReply>);
  }
  public crash(): void {
    this.error?.();
  }
}

function setup(): { controller: BooleanOperationController; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const factory: BooleanWorkerFactory = () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
  return { controller: new BooleanOperationController(factory), workers };
}

describe('disposable Boolean operation controller', () => {
  it('terminates and settles cancellation, then recovers for success', async () => {
    const { controller, workers } = setup();
    const cancellation = new CancellationSource();
    const cancelled = controller.run('union', tetra(), tetra(0.2), cancellation.token);
    cancellation.cancel();
    await expect(cancelled).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
    expect(workers[0]?.terminated).toBe(true);
    const successful = controller.run('union', tetra(), tetra(0.2), uncancellable);
    const request = workers[1]?.request;
    expect(request).toBeDefined();
    if (request === undefined) return;
    workers[1]?.reply({
      kind: 'result',
      operationId: request.operationId,
      positions: tetra().positions,
      indices: tetra().indices,
    });
    await expect(successful).resolves.toMatchObject({ indices: { length: 12 } });
    expect(controller.stats).toEqual({ active: 0, created: 2, terminated: 2 });
  });

  it('terminates a superseded worker and refuses an over-budget input before spawn', async () => {
    const { controller, workers } = setup();
    const first = controller.run('union', tetra(), tetra(0.2), uncancellable);
    const second = controller.run('difference', tetra(), tetra(0.2), uncancellable);
    await expect(first).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
    expect(workers[0]?.terminated).toBe(true);
    // An operand one triangle over the shared ceiling is refused on its own, before a worker is spawned.
    const huge = { ...tetra(), indices: new Uint32Array((MAX_SUPPORTED_SPLIT_TRIANGLES + 1) * 3) };
    expect(() => controller.run('union', huge, tetra(), uncancellable)).toThrow(
      /left operand triangles are 2000001; limit is 2000000/,
    );
    expect(workers).toHaveLength(2);
    controller.dispose();
    await expect(second).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
  });

  it('refuses pre-cancel before spawn and terminates on document release', async () => {
    const { controller, workers } = setup();
    const alreadyCancelled = new CancellationSource();
    alreadyCancelled.cancel();
    expect(() => controller.run('union', tetra(), tetra(0.2), alreadyCancelled.token)).toThrow(
      /cancelled/i,
    );
    expect(workers).toHaveLength(0);
    const active = controller.run('union', tetra(), tetra(0.2), uncancellable, {
      owner: { documentId: 'doc-1', generation: 1 },
    });
    controller.cancelDocument('doc-1');
    await expect(active).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
    expect(controller.stats.active).toBe(0);
  });

  it('maps a child crash to internal failure and releases the worker', async () => {
    const { controller, workers } = setup();
    const result = controller.run('intersection', tetra(), tetra(0.2), uncancellable);
    workers[0]?.crash();
    await expect(result).rejects.toMatchObject({ code: AppErrorCode.Internal });
    expect(controller.stats.active).toBe(0);
    expect(workers[0]?.terminated).toBe(true);
  });

  describe('the triangle ceilings are the shared split ceiling, and agree with the adapter', () => {
    const triangles = (n: number): CanonicalMesh => ({
      positions: createPositionArray(9),
      indices: new Uint32Array(n * 3),
      metadata: {},
    });

    it('derives its limits from the shared ceiling and the largest tool', () => {
      expect(MAX_BOOLEAN_OPERAND_TRIANGLES).toBe(2_000_000);
      expect(MAX_BOOLEAN_OPERATION_INPUT_TRIANGLES).toBe(
        MAX_SUPPORTED_SPLIT_TRIANGLES + MAX_BOOLEAN_TOOL_TRIANGLES,
      );
    });

    it('leaves the two byte guards room at the ceiling, so the triangle count is what decides', () => {
      // An unshared (STL soup) part at the ceiling beside the half-space: the worst shape for bytes.
      const part: CanonicalMesh = {
        positions: createPositionArray(MAX_SUPPORTED_SPLIT_TRIANGLES * 9),
        indices: createIndexArray(MAX_SUPPORTED_SPLIT_TRIANGLES * 3),
        metadata: {},
      };
      const accounting = measureBooleanOperation(part, triangles(12));
      expect(accounting.inputCopyBytes).toBeLessThan(MAX_BOOLEAN_OPERATION_COPY_BYTES);
      expect(accounting.knownOperationBytes).toBeLessThan(MAX_BOOLEAN_KNOWN_WORK_BYTES);
      // Comfortably: the binding limit at the ceiling is the triangle count, not these.
      expect(accounting.knownOperationBytes / MAX_BOOLEAN_KNOWN_WORK_BYTES).toBeLessThan(0.6);
    });

    it('lets a part of exactly 2,000,000 triangles through beside a 12-triangle half-space', () => {
      // The regression: 2,000,000 + 12 was refused here as "input triangles are 2000012; limit is
      // 2000000" while 1,992,704 + 12 was not, so the exact split refused the very part the ceiling admits.
      const { controller, workers } = setup();
      const operation = controller.run(
        'intersection',
        triangles(MAX_SUPPORTED_SPLIT_TRIANGLES),
        triangles(12),
        uncancellable,
      );
      // It got past every guard and spawned its worker.
      expect(workers).toHaveLength(1);
      controller.dispose();
      return expect(operation).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
    });

    it('refuses 2,000,001 as the part, and the largest tool plus one beside a full part', () => {
      const { controller, workers } = setup();
      expect(() =>
        controller.run(
          'intersection',
          triangles(MAX_SUPPORTED_SPLIT_TRIANGLES + 1),
          triangles(12),
          uncancellable,
        ),
      ).toThrow(/left operand triangles are 2000001/);
      expect(() =>
        controller.run(
          'intersection',
          triangles(MAX_SUPPORTED_SPLIT_TRIANGLES),
          triangles(MAX_BOOLEAN_TOOL_TRIANGLES + 1),
          uncancellable,
        ),
      ).toThrow(/input triangles are 2064001; limit is 2064000/);
      expect(workers).toHaveLength(0);
    });
  });
});
