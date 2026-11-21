import { MAX_SUPPORTED_SPLIT_TRIANGLES, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  MAX_BOOLEAN_TOOL_TRIANGLES,
  type BooleanBackend,
  type BooleanKind,
} from '@cadfixer/geometry-runtime';
import {
  internalError,
  invalidState,
  operationCancelled,
  resourceLimitExceeded,
  throwIfCancelled,
  type CancellationToken,
} from '@cadfixer/shared';
import type {
  BooleanOperationPhase,
  BooleanOperationReply,
  BooleanOperationRequest,
} from './boolean-operation-protocol';

export const MAX_BOOLEAN_OPERATION_COPY_BYTES = 256 * 1024 * 1024;
/**
 * THE TRIANGLES BOTH OPERANDS MAY HOLD TOGETHER: the split ceiling plus the largest tool beside it.
 *
 * This was a flat 2,000,000 over `a + b`, a THIRD copy of the ceiling that disagreed with the other two
 * by exactly the size of the tool: a plane split intersects the part with a 12-triangle half-space, so
 * a part of exactly 2,000,000 triangles arrived here as 2,000,012 and was refused, while 1,992,704 was
 * not. It is derived the way the Manifold byte budget is (`boolean-limits.ts`): the part the ceiling
 * admits plus the largest tool any caller builds. Each operand is still held to the ceiling ON ITS OWN
 * (`MAX_BOOLEAN_OPERAND_TRIANGLES`), exactly as `runValidatedBoolean` holds it, so raising the
 * combined figure raises nothing about how large one operand may be.
 */
export const MAX_BOOLEAN_OPERATION_INPUT_TRIANGLES =
  MAX_SUPPORTED_SPLIT_TRIANGLES + MAX_BOOLEAN_TOOL_TRIANGLES;
/** One operand's triangles: the shared split ceiling, the same figure the adapter's per-input gate reads. */
export const MAX_BOOLEAN_OPERAND_TRIANGLES = MAX_SUPPORTED_SPLIT_TRIANGLES;
export const MAX_BOOLEAN_KNOWN_WORK_BYTES = 768 * 1024 * 1024;
export interface BooleanOperationAccounting {
  readonly inputCopyBytes: number;
  readonly exactIndexedInputBytes: number;
  readonly wasmInputBytes: number;
  readonly knownOperationBytes: number;
}

export function measureBooleanOperation(
  a: CanonicalMesh,
  b: CanonicalMesh,
): BooleanOperationAccounting {
  const positionBytes = a.positions.byteLength + b.positions.byteLength;
  const indexBytes = a.indices.byteLength + b.indices.byteLength;
  const inputCopyBytes = positionBytes + indexBytes;
  const exactIndexedInputBytes = positionBytes * 2 + indexBytes;
  const wasmInputBytes = exactIndexedInputBytes;
  return {
    inputCopyBytes,
    exactIndexedInputBytes,
    wasmInputBytes,
    knownOperationBytes: inputCopyBytes + exactIndexedInputBytes + wasmInputBytes,
  };
}

interface WorkerLike {
  postMessage(message: BooleanOperationRequest, transfer: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<BooleanOperationReply>) => void,
  ): void;
  addEventListener(type: 'error', listener: () => void): void;
  terminate(): void;
}
export type BooleanWorkerFactory = () => WorkerLike;
export interface BooleanOperationTiming {
  readonly phase: BooleanOperationPhase;
  readonly at: number;
}
export interface BooleanOperationOwner {
  readonly documentId: string;
  readonly generation: number;
}
export interface BooleanOperationOptions {
  readonly owner?: BooleanOperationOwner;
  readonly onPhase?: (timing: BooleanOperationTiming) => void;
  readonly testCrash?: boolean;
}

interface Active {
  readonly id: string;
  readonly worker: WorkerLike;
  readonly owner?: BooleanOperationOwner;
  readonly reject: (cause: unknown) => void;
  unsubscribe: () => void;
  settled: boolean;
}

let nextOperation = 1;

/** One disposable nested worker per non-cooperative Manifold call. */
export class BooleanOperationController implements BooleanBackend {
  private readonly createWorker: BooleanWorkerFactory;
  private active: Active | undefined;
  private created = 0;
  private terminated = 0;
  public constructor(
    createWorker: BooleanWorkerFactory = () =>
      new Worker(new URL('./boolean-operation.worker.ts', import.meta.url), {
        type: 'module',
        name: 'cadfixer-boolean-operation',
      }),
  ) {
    this.createWorker = createWorker;
  }
  public get stats(): { active: number; created: number; terminated: number } {
    return {
      active: this.active === undefined ? 0 : 1,
      created: this.created,
      terminated: this.terminated,
    };
  }
  public operate(
    kind: BooleanKind,
    a: CanonicalMesh,
    b: CanonicalMesh,
    cancellation: CancellationToken,
  ): Promise<CanonicalMesh> {
    return this.run(kind, a, b, cancellation);
  }
  public run(
    kind: BooleanKind,
    a: CanonicalMesh,
    b: CanonicalMesh,
    cancellation: CancellationToken,
    options: BooleanOperationOptions = {},
  ): Promise<CanonicalMesh> {
    throwIfCancelled(cancellation);
    const triangles = a.indices.length / 3 + b.indices.length / 3;
    const accounting = measureBooleanOperation(a, b);
    for (const [label, operand] of [
      ['left', a],
      ['right', b],
    ] as const) {
      const operandTriangles = operand.indices.length / 3;
      if (operandTriangles > MAX_BOOLEAN_OPERAND_TRIANGLES)
        throw resourceLimitExceeded(
          `Boolean operation ${label} operand triangles are ${String(operandTriangles)}; limit is ${String(MAX_BOOLEAN_OPERAND_TRIANGLES)}.`,
          {
            metric: 'operandTriangles',
            observed: operandTriangles,
            limit: MAX_BOOLEAN_OPERAND_TRIANGLES,
          },
        );
    }
    if (triangles > MAX_BOOLEAN_OPERATION_INPUT_TRIANGLES)
      throw resourceLimitExceeded(
        `Boolean operation input triangles are ${String(triangles)}; limit is ${String(MAX_BOOLEAN_OPERATION_INPUT_TRIANGLES)}.`,
        {
          metric: 'inputTriangles',
          observed: triangles,
          limit: MAX_BOOLEAN_OPERATION_INPUT_TRIANGLES,
        },
      );
    if (accounting.inputCopyBytes > MAX_BOOLEAN_OPERATION_COPY_BYTES)
      throw resourceLimitExceeded(
        `Boolean operation input copy bytes are ${String(accounting.inputCopyBytes)}; limit is ${String(MAX_BOOLEAN_OPERATION_COPY_BYTES)}.`,
        {
          metric: 'inputCopyBytes',
          observed: accounting.inputCopyBytes,
          limit: MAX_BOOLEAN_OPERATION_COPY_BYTES,
        },
      );
    if (accounting.knownOperationBytes > MAX_BOOLEAN_KNOWN_WORK_BYTES)
      throw resourceLimitExceeded(
        `Boolean known operation bytes are ${String(accounting.knownOperationBytes)}; limit is ${String(MAX_BOOLEAN_KNOWN_WORK_BYTES)}.`,
        {
          metric: 'knownOperationBytes',
          observed: accounting.knownOperationBytes,
          limit: MAX_BOOLEAN_KNOWN_WORK_BYTES,
        },
      );
    this.cancelActive('A newer Boolean operation superseded this one.');
    const operationId = `boolean-${String(nextOperation++)}`;
    const worker = this.createWorker();
    this.created += 1;
    const aPositions = new Float32Array(a.positions),
      aIndices = new Uint32Array(a.indices),
      bPositions = new Float32Array(b.positions),
      bIndices = new Uint32Array(b.indices);
    return new Promise<CanonicalMesh>((resolve, reject) => {
      const active: Active = {
        id: operationId,
        worker,
        ...(options.owner === undefined ? {} : { owner: options.owner }),
        reject,
        unsubscribe: () => undefined,
        settled: false,
      };
      this.active = active;
      const finish = (): void => {
        if (active.settled) return;
        active.settled = true;
        active.unsubscribe();
        worker.terminate();
        this.terminated += 1;
        if (this.active === active) this.active = undefined;
      };
      active.unsubscribe = cancellation.onCancelled(() => {
        if (active.settled) return;
        finish();
        reject(operationCancelled('Boolean operation was cancelled.'));
      });
      worker.addEventListener('message', (event) => {
        const message = event.data;
        if (message.operationId !== operationId || active.settled) return;
        if (message.kind === 'phase') {
          options.onPhase?.({ phase: message.phase, at: message.at });
          return;
        }
        if (message.kind === 'failed') {
          finish();
          reject(message.expected ? invalidState(message.message) : internalError(message.message));
          return;
        }
        finish();
        resolve({ positions: message.positions, indices: message.indices, metadata: {} });
      });
      worker.addEventListener('error', () => {
        if (active.settled) return;
        finish();
        reject(internalError('The Boolean operation worker failed.'));
      });
      worker.postMessage(
        {
          kind: 'run',
          operationId,
          operation: kind,
          aPositions,
          aIndices,
          bPositions,
          bIndices,
          ...(options.testCrash === true ? { testCrash: true } : {}),
        },
        [aPositions.buffer, aIndices.buffer, bPositions.buffer, bIndices.buffer],
      );
    });
  }
  public cancelDocument(documentId: string): void {
    if (this.active?.owner?.documentId === documentId)
      this.cancelActive('The source document was released.');
  }
  public cancelGeneration(documentId: string, generation: number): void {
    const owner = this.active?.owner;
    if (owner?.documentId === documentId && owner.generation !== generation)
      this.cancelActive('A newer Boolean operation superseded this one.');
  }
  public dispose(): void {
    this.cancelActive('Boolean operation controller was disposed.');
  }
  private cancelActive(message: string): void {
    const active = this.active;
    if (active === undefined || active.settled) return;
    active.settled = true;
    active.unsubscribe();
    active.worker.terminate();
    this.terminated += 1;
    this.active = undefined;
    active.reject(operationCancelled(message));
  }
}
