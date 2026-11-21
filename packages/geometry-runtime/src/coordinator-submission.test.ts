import { describe, expect, it, vi } from 'vitest';
import { operationCancelled, resourceLimitExceeded, type OperationId } from '@cadfixer/shared';
import { GeometryCoordinator, type ProgressUpdate } from './coordinator';
import { PROTOCOL_CHANNEL, type HostBoundMessage, type RequestMessage } from './protocol';

function rig(): {
  coordinator: GeometryCoordinator;
  attempts: HostBoundMessage[];
  accepted: HostBoundMessage[];
  diagnostic: ReturnType<typeof vi.fn>;
  closed: ReturnType<typeof vi.fn>;
  submit: (call: (message: HostBoundMessage) => void) => void;
  receive: (message: unknown) => void;
} {
  let receive: (message: unknown) => void = (): void => undefined;
  const attempts: HostBoundMessage[] = [],
    accepted: HostBoundMessage[] = [];
  let submit = (message: HostBoundMessage): void => {
    accepted.push(message);
  };
  const diagnostic = vi.fn(),
    closed = vi.fn();
  const coordinator = new GeometryCoordinator(
    {
      postMessage: (value): void => {
        const message = value as HostBoundMessage;
        attempts.push(message);
        submit(message);
      },
      addMessageListener: (listener) => {
        receive = listener;
        return (): void => {
          receive = (): void => undefined;
        };
      },
      close: closed,
    },
    { onDiagnostic: diagnostic },
  );
  return {
    coordinator,
    attempts,
    accepted,
    diagnostic,
    closed,
    submit: (call): void => {
      submit = call;
    },
    receive: (message): void => {
      receive(message);
    },
  };
}
function request(messages: readonly HostBoundMessage[]): RequestMessage {
  const last = messages.filter((m): m is RequestMessage => m.kind === 'request').at(-1);
  if (!last) throw Error('Missing fixture request');
  return last;
}
const payload = (): { bytes: ArrayBuffer; chunks: number } => ({
  bytes: new ArrayBuffer(0),
  chunks: 1,
});
function result(
  h: ReturnType<typeof rig>,
  id: OperationId,
  value: unknown = { byteLength: 0 },
): void {
  h.receive({ channel: PROTOCOL_CHANNEL, kind: 'result', id, value });
}
function reject(h: ReturnType<typeof rig>, id: OperationId): void {
  h.receive({
    channel: PROTOCOL_CHANNEL,
    kind: 'error',
    id,
    error: operationCancelled('cancelled in fixture').toSerializable(),
  });
}

describe('exception-safe generic coordinator submission', () => {
  it('rolls back pending/progress/shared cancellation ownership and rethrows the exact error', () => {
    const h = rig(),
      original = Error('submission failed'),
      progress = vi.fn<(p: ProgressUpdate) => void>();
    h.submit(() => {
      throw original;
    });
    let thrown: unknown,
      returned = false;
    try {
      h.coordinator.dispatch('runtime/self-test', payload(), {
        interruptible: true,
        onProgress: progress,
      });
      returned = true;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(original);
    expect(returned).toBe(false);
    expect(h.accepted).toHaveLength(0);
    expect(request(h.attempts).cancellation).toBeInstanceOf(SharedArrayBuffer);
    expect(h.coordinator.pendingCount).toBe(0);
    expect(h.coordinator.liveCancellationSignals).toBe(0);
    h.receive({
      channel: PROTOCOL_CHANNEL,
      kind: 'progress',
      id: request(h.attempts).id,
      fraction: 0.5,
    });
    result(h, request(h.attempts).id);
    expect(progress).not.toHaveBeenCalled();
    expect(h.diagnostic).toHaveBeenCalledTimes(2);
    h.coordinator.failAllPending(resourceLimitExceeded('lost'));
    h.coordinator.dispose();
  });

  it('keeps both operation resource counts at baseline after each of 100 failed submissions', () => {
    const h = rig(),
      original = Error('not submitted');
    const ids = new Set<OperationId>();
    h.submit(() => {
      throw original;
    });
    for (let i = 0; i < 100; i++) {
      expect(() =>
        h.coordinator.dispatch('runtime/self-test', payload(), { interruptible: true }),
      ).toThrow(original);
      ids.add(request(h.attempts).id);
      expect(h.coordinator.pendingCount).toBe(0);
      expect(h.coordinator.liveCancellationSignals).toBe(0);
    }
    expect(ids.size).toBe(100);
    expect(h.accepted).toHaveLength(0);
    h.coordinator.failAllPending(resourceLimitExceeded('lost after failures'));
    h.coordinator.dispose();
    expect(h.coordinator.pendingCount).toBe(0);
  });

  it('failed IDs cannot receive progress or settle a subsequent accepted request', async () => {
    const h = rig(),
      progress = vi.fn<(p: ProgressUpdate) => void>();
    h.submit(() => {
      throw Error('not submitted');
    });
    expect(() =>
      h.coordinator.dispatch('runtime/self-test', payload(), { onProgress: progress }),
    ).toThrow();
    const old = request(h.attempts).id;
    h.submit((m) => {
      h.accepted.push(m);
    });
    const handle = h.coordinator.dispatch('runtime/self-test', payload());
    expect(handle.id).not.toBe(old);
    h.receive({ channel: PROTOCOL_CHANNEL, kind: 'progress', id: old, fraction: 1 });
    result(h, old, { stale: true });
    reject(h, old);
    expect(progress).not.toHaveBeenCalled();
    expect(h.coordinator.pendingCount).toBe(1);
    result(h, handle.id, { byteLength: 42 });
    await expect(handle.promise).resolves.toEqual({ byteLength: 42 });
    expect(h.coordinator.pendingCount).toBe(0);
    h.coordinator.dispose();
  });

  it('preserves a different accepted operation when another submission rolls back, then rejects only the live handle on loss', async () => {
    const h = rig();
    const live = h.coordinator.dispatch('runtime/self-test', payload(), { interruptible: true });
    const settlement = vi.fn();
    const observed = live.promise.catch((error: unknown) => {
      settlement(error);
    });
    h.submit(() => {
      throw Error('other request not submitted');
    });
    for (let i = 0; i < 2; i++) {
      expect(() =>
        h.coordinator.dispatch('runtime/self-test', payload(), { interruptible: true }),
      ).toThrow();
      expect(h.coordinator.pendingCount).toBe(1);
      expect(h.coordinator.liveCancellationSignals).toBe(1);
    }
    const loss = resourceLimitExceeded('actual accepted operation lost');
    h.coordinator.failAllPending(loss);
    await observed;
    expect(settlement).toHaveBeenCalledExactlyOnceWith(loss);
    expect(h.coordinator.pendingCount).toBe(0);
    expect(h.coordinator.liveCancellationSignals).toBe(0);
    h.coordinator.failAllPending(loss);
    h.coordinator.dispose();
    expect(settlement).toHaveBeenCalledTimes(1);
  });

  it('two failed submissions then one accepted success have pending counts 0, 0, 1, 0', async () => {
    const h = rig();
    h.submit(() => {
      throw Error('not submitted');
    });
    for (let i = 0; i < 2; i++) {
      expect(() => h.coordinator.dispatch('runtime/self-test', payload())).toThrow();
      expect(h.coordinator.pendingCount).toBe(0);
    }
    h.submit((m) => {
      h.accepted.push(m);
    });
    const handle = h.coordinator.dispatch('runtime/self-test', payload());
    expect(h.accepted).toHaveLength(1);
    expect(h.coordinator.pendingCount).toBe(1);
    result(h, handle.id, { byteLength: 17 });
    await expect(handle.promise).resolves.toEqual({ byteLength: 17 });
    expect(h.coordinator.pendingCount).toBe(0);
    h.coordinator.dispose();
  });

  it.each(['result', 'error'] as const)(
    'keeps pre-registration for synchronous progress and %s response before handle return',
    async (terminal) => {
      const h = rig(),
        progress = vi.fn<(p: ProgressUpdate) => void>();
      h.submit((m) => {
        h.accepted.push(m);
        expect(h.coordinator.pendingCount).toBe(1);
        h.receive({ channel: PROTOCOL_CHANNEL, kind: 'progress', id: m.id, fraction: 0.5 });
        if (terminal === 'result') result(h, m.id);
        else reject(h, m.id);
        expect(h.coordinator.pendingCount).toBe(0);
        expect(h.coordinator.liveCancellationSignals).toBe(0);
      });
      const handle = h.coordinator.dispatch('runtime/self-test', payload(), {
        interruptible: true,
        onProgress: progress,
      });
      expect(progress).toHaveBeenCalledExactlyOnceWith({ fraction: 0.5 });
      if (terminal === 'result') await expect(handle.promise).resolves.toEqual({ byteLength: 0 });
      else await expect(handle.promise).rejects.toThrow('cancelled in fixture');
      result(h, handle.id);
      reject(h, handle.id);
      expect(h.diagnostic).toHaveBeenCalledTimes(2);
      h.coordinator.dispose();
    },
  );

  it('accepted rejection cleans once and still rejects its returned promise', async () => {
    const h = rig(),
      terminal = vi.fn();
    const handle = h.coordinator.dispatch('runtime/self-test', payload(), { interruptible: true });
    const observed = handle.promise.catch((error: unknown) => {
      terminal(error);
    });
    reject(h, handle.id);
    reject(h, handle.id);
    result(h, handle.id);
    await observed;
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(h.coordinator.pendingCount).toBe(0);
    expect(h.coordinator.liveCancellationSignals).toBe(0);
    h.coordinator.dispose();
  });

  it('accepted cancellation keeps pending until its terminal response and releases the shared signal', async () => {
    const h = rig();
    const handle = h.coordinator.dispatch('runtime/self-test', payload(), { interruptible: true });
    const buffer = request(h.accepted).cancellation;
    if (!buffer) throw Error('Missing shared cancellation fixture');
    const observed = handle.promise.catch((error: unknown) => error);
    handle.cancel();
    expect(Atomics.load(new Int32Array(buffer), 0)).toBe(1);
    expect(h.accepted.at(-1)?.kind).toBe('cancel');
    expect(h.coordinator.pendingCount).toBe(1);
    reject(h, handle.id);
    await observed;
    expect(h.coordinator.pendingCount).toBe(0);
    expect(h.coordinator.liveCancellationSignals).toBe(0);
    const count = h.accepted.length;
    handle.cancel();
    expect(h.accepted).toHaveLength(count);
    h.coordinator.dispose();
  });

  it('re-entrant cancellation of an existing handle during another submission settles each operation once', async () => {
    const h = rig();
    const older = h.coordinator.dispatch('runtime/self-test', payload());
    const olderObserved = older.promise.catch((error: unknown) => error);
    h.submit((m) => {
      h.accepted.push(m);
      if (m.kind === 'cancel') reject(h, m.id);
      else {
        older.cancel();
        result(h, m.id, { byteLength: 2 });
      }
    });
    const newer = h.coordinator.dispatch('runtime/self-test', payload());
    await expect(olderObserved).resolves.toMatchObject({ code: 'OPERATION_CANCELLED' });
    await expect(newer.promise).resolves.toEqual({ byteLength: 2 });
    expect(h.coordinator.pendingCount).toBe(0);
    h.coordinator.dispose();
  });

  it('rollback removes only the failed ID while a nested independent dispatch stays live', async () => {
    const h = rig();
    let inner: ReturnType<GeometryCoordinator['dispatch']> | undefined;
    h.submit((outer) => {
      h.submit((m) => {
        h.accepted.push(m);
      });
      inner = h.coordinator.dispatch('runtime/self-test', payload());
      expect(inner.id).not.toBe(outer.id);
      throw Error('outer request was not accepted');
    });
    expect(() => h.coordinator.dispatch('runtime/self-test', payload())).toThrow(
      'outer request was not accepted',
    );
    if (!inner) throw Error('Missing nested operation');
    expect(h.coordinator.pendingCount).toBe(1);
    result(h, inner.id);
    await inner.promise;
    expect(h.coordinator.pendingCount).toBe(0);
    h.coordinator.dispose();
  });

  it('dispose rejects an accepted returned handle and ignores failed submissions, exactly once', async () => {
    const h = rig();
    h.submit(() => {
      throw Error('not submitted');
    });
    expect(() =>
      h.coordinator.dispatch('runtime/self-test', payload(), { interruptible: true }),
    ).toThrow();
    h.submit((m) => {
      h.accepted.push(m);
    });
    const handle = h.coordinator.dispatch('runtime/self-test', payload(), { interruptible: true });
    const rejected = vi.fn();
    const observed = handle.promise.catch((error: unknown) => {
      rejected(error);
    });
    h.coordinator.dispose();
    h.coordinator.dispose();
    await observed;
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(h.coordinator.pendingCount).toBe(0);
    expect(h.coordinator.liveCancellationSignals).toBe(0);
    expect(h.closed).toHaveBeenCalledTimes(1);
    expect(() => h.coordinator.dispatch('runtime/self-test', payload())).toThrow('disposed');
  });
});
