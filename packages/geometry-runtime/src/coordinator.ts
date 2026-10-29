import {
  assertNever,
  createOperationId,
  deserializeAppError,
  internalError,
  isSharedCancellationSupported,
  operationCancelled,
  SharedCancellationSource,
  type AppError,
  type ErrorDetails,
  type OperationId,
} from '@cadfixer/shared';
import type { MessageEndpoint } from './endpoint';
import {
  isClientBoundMessage,
  PROTOCOL_CHANNEL,
  type OperationName,
  type OperationPayload,
  type OperationResult,
  type TransferHandle,
} from './protocol';

/**
 * Main-thread half of the worker boundary.
 *
 * Owns request/response correlation, progress fan-out, cancellation, and
 * teardown. It performs no geometry work itself and holds no mesh state.
 */

export interface ProgressUpdate {
  readonly fraction: number;
  readonly note?: string;
}

export interface DispatchOptions {
  readonly onProgress?: (update: ProgressUpdate) => void;
  /**
   * Buffers to move to the worker rather than copy. These are detached once
   * dispatch returns; the caller must not read them afterwards.
   */
  readonly transfer?: readonly TransferHandle[];
  /**
   * Whether this operation needs a signal that can interrupt SYNCHRONOUS work.
   *
   * Opt-in rather than automatic. Most operations are built from awaited phases
   * and are interrupted perfectly well by the `cancel` message; allocating a
   * `SharedArrayBuffer` for them would be cost without benefit. Repair is the
   * case that needs it, because its pipeline is one long synchronous pass.
   */
  readonly interruptible?: boolean;
}

export interface OperationHandle<T> {
  readonly id: OperationId;
  readonly promise: Promise<T>;
  /**
   * Requests cancellation.
   *
   * For an `interruptible` operation the shared flag is set FIRST, before any
   * message is posted, so the worker can observe it from inside a synchronous
   * loop. For every operation the `cancel` message still follows, because it is
   * what carries the lifecycle bookkeeping and what a handler between awaits
   * responds to.
   *
   * Still cooperative: the operation ends when the worker's handler next polls.
   * What `interruptible` changes is that the poll can now see a change. The
   * promise rejects with an `OPERATION_CANCELLED` error.
   */
  cancel(): void;
  /**
   * True when this operation carries a shared signal that can interrupt
   * synchronous work. False means cancellation waits for the event loop.
   */
  readonly interruptible: boolean;
}

/** Reports protocol anomalies that have no operation to reject. */
export type DiagnosticSink = (message: string, details: ErrorDetails) => void;

export interface GeometryCoordinatorOptions {
  /**
   * Required rather than optional: an unroutable message is a real defect, and
   * defaulting to a silent no-op would hide it. The application supplies a sink
   * that logs; tests supply one that records.
   */
  readonly onDiagnostic: DiagnosticSink;
}

interface PendingOperation {
  readonly operation: OperationName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AppError) => void;
  readonly onProgress?: (update: ProgressUpdate) => void;
}

export class GeometryCoordinator {
  private readonly pending = new Map<OperationId, PendingOperation>();
  /**
   * Live cancellation signals, one per interruptible operation.
   *
   * Released the moment an operation reaches a terminal message. Retaining them
   * would keep a `SharedArrayBuffer` alive per operation for the session — small
   * individually, unbounded collectively.
   */
  private readonly signals = new Map<OperationId, SharedCancellationSource>();
  private readonly endpoint: MessageEndpoint;
  private readonly unsubscribe: () => void;
  private readonly onDiagnostic: DiagnosticSink;
  private disposed = false;

  public constructor(endpoint: MessageEndpoint, options: GeometryCoordinatorOptions) {
    this.endpoint = endpoint;
    this.onDiagnostic = options.onDiagnostic;
    this.unsubscribe = endpoint.addMessageListener((message) => {
      this.handleMessage(message);
    });
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Cancellation signals currently held, one per live interruptible operation.
   *
   * A diagnostic in the same spirit as `pendingCount`: four bytes each is
   * nothing until a long session keeps every one, and a leak here is invisible
   * without a way to observe it.
   */
  public get liveCancellationSignals(): number {
    return this.signals.size;
  }

  public dispatch<K extends OperationName>(
    operation: K,
    payload: OperationPayload<K>,
    options: DispatchOptions = {},
  ): OperationHandle<OperationResult<K>> {
    if (this.disposed) {
      throw internalError('Cannot dispatch on a disposed GeometryCoordinator.', {
        details: { operation },
      });
    }

    const id = createOperationId();
    let settle: PendingOperation | undefined;

    const promise = new Promise<OperationResult<K>>((resolve, reject) => {
      settle = {
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      };
    });

    // The executor above runs synchronously, so this is always defined. The
    // check exists so the invariant is enforced rather than assumed.
    if (settle === undefined) {
      throw internalError('Promise executor did not run synchronously.', {
        details: { operation },
      });
    }

    /*
     * The shared cancel flag is created BEFORE the request is posted, so the
     * worker receives it in the same message that starts the work. Creating it
     * afterwards would leave a window in which the operation is running and
     * uncancellable.
     */
    const signal =
      options.interruptible === true && isSharedCancellationSupported()
        ? new SharedCancellationSource()
        : undefined;
    if (signal !== undefined) this.signals.set(id, signal);

    this.pending.set(id, settle);
    try {
      this.endpoint.postMessage(
        {
          channel: PROTOCOL_CHANNEL,
          kind: 'request',
          id,
          operation,
          payload,
          // SHARED, never transferred: a SharedArrayBuffer in a transfer list
          // would detach the sender's view of the flag it has to set.
          ...(signal === undefined ? {} : { cancellation: signal.buffer }),
        },
        options.transfer ?? [],
      );
    } catch (error) {
      // Register before submission so re-entrant responses can find the request.
      // A throwing submission returns no handle: remove its settlement owners
      // without rejecting an inaccessible promise, then preserve the exact error.
      this.pending.delete(id);
      this.signals.delete(id);
      throw error;
    }

    return {
      id,
      promise,
      interruptible: signal !== undefined,
      cancel: (): void => {
        this.requestCancel(id);
      },
    };
  }

  /**
   * Rejects every in-flight operation with `error`.
   *
   * Required because some transport failures produce no protocol message at
   * all — a worker script that fails to load, a structured-clone failure, or a
   * crashed worker. Without this, those operations would hang forever and the
   * interface would sit on a spinner. The transport adapter is responsible for
   * calling it when it observes such a failure.
   */
  public failAllPending(error: AppError): void {
    const abandoned = [...this.pending.values()];
    this.pending.clear();
    this.signals.clear();
    for (const operation of abandoned) operation.reject(error);
  }

  /**
   * Rejects every in-flight operation and detaches from the endpoint.
   *
   * Callers own the endpoint's lifetime; `dispose` closes it only if the
   * endpoint exposes `close`.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();

    const abandoned = [...this.pending.values()];
    this.pending.clear();
    // Every in-flight worker loop is told to stop before the endpoint closes, so
    // a torn-down runtime does not leave a worker burning a core on a result
    // nothing will ever receive.
    for (const signal of this.signals.values()) signal.cancel();
    this.signals.clear();
    for (const operation of abandoned) {
      operation.reject(
        operationCancelled('Geometry runtime shut down before the operation completed.'),
      );
    }

    this.endpoint.close?.();
  }

  /**
   * THE ATOMIC STORE HAPPENS FIRST. Deliberately, and the order is the whole
   * correctness argument: `postMessage` cannot reach a worker that is inside a
   * synchronous loop, so posting first and storing second would make the flag's
   * visibility depend on the very mechanism it exists to bypass. The store is
   * unconditional and cheap; the message follows for bookkeeping.
   */
  private requestCancel(id: OperationId): void {
    if (!this.pending.has(id) || this.disposed) return;
    this.signals.get(id)?.cancel();
    // The pending entry is intentionally kept: the worker still owes a terminal
    // message, and removing it here would make that message unroutable.
    this.endpoint.postMessage({ channel: PROTOCOL_CHANNEL, kind: 'cancel', id }, []);
  }

  private handleMessage(message: unknown): void {
    if (!isClientBoundMessage(message)) {
      this.onDiagnostic('Geometry worker sent a message outside the protocol.', {
        received: describeShape(message),
      });
      return;
    }

    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.onDiagnostic('Geometry worker sent a message for an unknown operation.', {
        operationId: message.id,
        kind: message.kind,
      });
      return;
    }

    switch (message.kind) {
      case 'progress':
        pending.onProgress?.({
          fraction: message.fraction,
          ...(message.note === undefined ? {} : { note: message.note }),
        });
        return;
      case 'result':
        this.pending.delete(message.id);
        this.signals.delete(message.id);
        pending.resolve(message.value);
        return;
      case 'error':
        this.pending.delete(message.id);
        this.signals.delete(message.id);
        pending.reject(deserializeAppError(message.error));
        return;
      default:
        assertNever(message, 'GeometryCoordinator.handleMessage');
    }
  }
}

/** Describes an unexpected value without echoing its contents into a log. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
