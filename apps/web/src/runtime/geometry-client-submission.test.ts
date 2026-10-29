import { expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers';
import {
  PROTOCOL_CHANNEL,
  type DocumentHandle,
  type GeometryCoordinator,
  type HostBoundMessage,
  type RequestMessage,
  type SplitCandidateHandle,
} from '@cadfixer/geometry-runtime';
import { invalidState, type OperationId } from '@cadfixer/shared';
import { GeometryClient } from './geometry-client';

/** Local transport only: production client/coordinator, no Worker geometry or cloning claim. */
class SubmissionTransport extends EventTarget {
  public failures = 0;
  public readonly error = invalidState('Submission was not accepted');
  public readonly attempts: OperationId[] = [];
  public readonly accepted: RequestMessage[] = [];
  public postMessage(value: unknown): void {
    const message = value as HostBoundMessage;
    if (message.kind !== 'request') return;
    this.attempts.push(message.id);
    if (this.failures-- > 0) throw this.error;
    this.accepted.push(message);
  }
  public terminate(): void {
    // This local transport owns no Worker thread.
  }
  public respond(id: OperationId, error = false): void {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: {
          channel: PROTOCOL_CHANNEL,
          id,
          ...(error
            ? { kind: 'error', error: invalidState('Accepted operation rejected').toSerializable() }
            : { kind: 'result', value: { handle: { documentId: 'document-1', revision: 2 } } }),
        },
      }),
    );
  }
  public lose(): void {
    this.dispatchEvent(new ErrorEvent('error', { message: 'test Worker loss' }));
  }
}
function fixture(): {
  client: GeometryClient;
  coordinator: GeometryCoordinator;
  transport: SubmissionTransport;
  losses: ReturnType<typeof vi.fn>;
  commit: () => ReturnType<GeometryClient['commitSplit']>;
} {
  const transport = new SubmissionTransport(),
    losses = vi.fn();
  const client = new GeometryClient({
    createWorker: (): Worker => transport as unknown as Worker,
    onDiagnostic: (): void => undefined,
    onWorkerLost: losses,
  });
  const source = { documentId: 'document-1', revision: 1 } as DocumentHandle;
  const candidate = {
    documentId: source.documentId,
    sourceRevision: 1,
    partId: 'part-1',
    operation: 'split',
    generation: 1,
    candidateId: crypto.randomUUID() + ':split-candidate-1',
  } as SplitCandidateHandle;
  return {
    client,
    transport,
    losses,
    coordinator: (client as unknown as { coordinator: GeometryCoordinator }).coordinator,
    commit: () => client.commitSplit(candidate, source, 'part-1'),
  };
}
async function noOrphanRejections(run: () => void | Promise<void>): Promise<void> {
  const events: unknown[] = [];
  const observer = (error: unknown): void => {
    events.push(error);
  };
  process.on('unhandledRejection', observer);
  try {
    await run();
    // Observe rejection events on an event-loop turn, without sleeps or timing
    // assumptions about transport acceptance/authority.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual([]);
  } finally {
    process.off('unhandledRejection', observer);
  }
}

it.each([1, 100])(
  'C2AM: %s real client submission failures leave baseline resources and no orphan on Worker loss',
  async (count) => {
    await noOrphanRejections(() => {
      const f = fixture();
      f.transport.failures = count;
      const baseline = f.coordinator.pendingCount;
      let returned = 0;
      for (let i = 0; i < count; i++) {
        let error: unknown;
        try {
          f.commit();
          returned++;
        } catch (cause) {
          error = cause;
        }
        expect(error).toBe(f.transport.error);
        expect(f.coordinator.pendingCount).toBe(baseline);
        expect(f.coordinator.liveCancellationSignals).toBe(0);
      }
      expect(returned).toBe(0);
      expect(f.transport.accepted).toHaveLength(0);
      expect(new Set(f.transport.attempts).size).toBe(count);
      f.transport.lose();
      expect(f.losses).toHaveBeenCalledTimes(1);
      expect(f.coordinator.pendingCount).toBe(baseline);
      f.client.dispose();
    });
  },
);

it('C2AM: two real client failures then one success have pending counts 0,0,1,0', async () => {
  await noOrphanRejections(async () => {
    const f = fixture();
    f.transport.failures = 2;
    for (let i = 0; i < 2; i++) {
      expect(f.commit).toThrow(f.transport.error);
      expect(f.coordinator.pendingCount).toBe(0);
    }
    const operation = f.commit();
    expect(f.transport.accepted).toHaveLength(1);
    expect(f.coordinator.pendingCount).toBe(1);
    f.transport.respond(operation.id);
    await expect(operation.promise).resolves.toMatchObject({ handle: { revision: 2 } });
    expect(f.coordinator.pendingCount).toBe(0);
    f.transport.lose();
    f.client.dispose();
  });
});

it('C2AM: an accepted real client operation still rejects normally and is removed exactly once', async () => {
  const f = fixture(),
    rejected = vi.fn();
  const operation = f.commit();
  const observed = operation.promise.catch((error: unknown) => {
    rejected(error);
    return error;
  });
  expect(f.coordinator.pendingCount).toBe(1);
  f.transport.respond(operation.id, true);
  await expect(observed).resolves.toMatchObject({ message: 'Accepted operation rejected' });
  f.transport.respond(operation.id, true);
  expect(rejected).toHaveBeenCalledTimes(1);
  expect(f.coordinator.pendingCount).toBe(0);
  f.client.dispose();
});

it.each([0, 2])(
  'C2AM: Worker loss after %s failed submissions rejects only the genuinely accepted pending handle',
  async (failures) => {
    await noOrphanRejections(async () => {
      const f = fixture();
      f.transport.failures = failures;
      for (let i = 0; i < failures; i++) {
        expect(f.commit).toThrow(f.transport.error);
        expect(f.coordinator.pendingCount).toBe(0);
      }
      const operation = f.commit(),
        rejected = vi.fn();
      const observed = operation.promise.catch((error: unknown) => {
        rejected(error);
        return error;
      });
      expect(f.coordinator.pendingCount).toBe(1);
      f.transport.lose();
      await expect(observed).resolves.toMatchObject({
        message: 'The geometry worker crashed: test Worker loss',
      });
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(f.transport.accepted).toHaveLength(1);
      expect(f.coordinator.pendingCount).toBe(0);
      expect(f.losses).toHaveBeenCalledTimes(1);
      f.transport.lose();
      f.client.dispose();
      expect(rejected).toHaveBeenCalledTimes(1);
    });
  },
);

it.each([false, true])(
  'C2AM: dispose after failed submissions cleans only live returned handles (accepted=%s)',
  async (accept) => {
    await noOrphanRejections(async () => {
      const f = fixture();
      f.transport.failures = 2;
      for (let i = 0; i < 2; i++) expect(f.commit).toThrow(f.transport.error);
      expect(f.coordinator.pendingCount).toBe(0);
      let observed: Promise<unknown> | undefined;
      if (accept) observed = f.commit().promise.catch((error: unknown) => error);
      f.client.dispose();
      f.client.dispose();
      if (observed) await expect(observed).resolves.toMatchObject({ code: 'OPERATION_CANCELLED' });
      expect(f.coordinator.pendingCount).toBe(0);
      expect(f.coordinator.liveCancellationSignals).toBe(0);
    });
  },
);

it('C2AM: the real non-split client RPC uses the same exception-safe generic dispatch', async () => {
  const f = fixture();
  f.transport.failures = 1;
  const progress = vi.fn();
  expect(() => f.client.runSelfTest(new ArrayBuffer(0), 1, progress)).toThrow(f.transport.error);
  expect(f.coordinator.pendingCount).toBe(0);
  const operation = f.client.runSelfTest(new ArrayBuffer(0), 1, progress);
  expect(f.transport.accepted[0]?.operation).toBe('runtime/self-test');
  f.transport.respond(operation.id);
  await operation.promise;
  expect(f.coordinator.pendingCount).toBe(0);
  f.client.dispose();
});
