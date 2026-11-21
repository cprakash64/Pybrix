import { writeFileSync } from 'node:fs';
import { revealControl } from '../e2e/progressive-disclosure';
import { expect, test } from '@playwright/test';
import { Fixture, loadFixture, openHarness, readState } from './harness';
import type { CDPSession, Page } from '@playwright/test';

/*
 * WHAT AN EDITABLE CONNECTOR RETAINS, IN CHROMIUM. A QUALIFICATION, NOT A TEST: skipped unless `CADFIXER_QUALIFY_JOINT=1`, and it
 * asserts nothing about timing. It exists because Stage EC-1 measured the retention in Node typed-array bytes only, and the Stage
 * 6E-A4 rule is that a memory argument for a browser needs a browser.
 *
 * THE MEASUREMENT. The geometry worker's own ArrayBuffer backing store, from CDP `Runtime.getHeapUsage` on the worker target, after a
 * forced collection: that is where the canonical meshes, the retained bases and the interface authority live. Two splits of the same
 * 500k-triangle sphere in fresh pages:
 *
 *   - PLAIN cut: the pieces ARE the bases (one object each), so the joint retains only its interface authority;
 *   - PIN cut: the pieces carry a connector, so the joint retains a second copy of both, as bases.
 *
 * The difference between the two worker footprints is therefore what retaining the bases costs, and it is compared with what the
 * accounting says (`retainedBytes` of each joint descriptor). EXCLUDES the page, the GPU process and the browser process: render
 * snapshots live in the page and are not what retention changes.
 *
 * Run: CADFIXER_QUALIFY_JOINT=1 CADFIXER_QUALIFY_JOINT_OUT=<file> npm run test:e2e:harness -- e2e-harness/joint-retention.qualify.spec.ts
 */
test.skip(process.env.CADFIXER_QUALIFY_JOINT !== '1', 'qualification run only');
test.setTimeout(600_000);

const MIB = 1024 * 1024;

interface WorkerProbe {
  readonly collect: () => Promise<void>;
  readonly backingStorage: () => Promise<number>;
}

async function probeWorker(page: Page): Promise<WorkerProbe> {
  const browser = page.context().browser();
  if (browser === null) throw new Error('no browser');
  const session: CDPSession = await browser.newBrowserCDPSession();
  const { targetInfos } = await session.send('Target.getTargets');
  const worker = targetInfos.find(
    (target) => target.type === 'worker' && target.url.includes('harness.worker'),
  );
  if (worker === undefined) throw new Error('harness worker target not found');
  const { sessionId } = await session.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: false,
  });
  let next = 1;
  const pending = new Map<
    number,
    (message: { result?: unknown; error?: { message: string } }) => void
  >();
  session.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message) as {
      id: number;
      result?: unknown;
      error?: { message: string };
    };
    const settle = pending.get(message.id);
    if (settle !== undefined) {
      pending.delete(message.id);
      settle(message);
    }
  });
  const call = (method: string): Promise<Record<string, number>> =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, (message) => {
        if (message.error) reject(new Error(message.error.message));
        else resolve((message.result ?? {}) as Record<string, number>);
      });
      void session
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params: {} }),
        })
        .catch(reject);
    });
  await call('Runtime.enable');
  await call('HeapProfiler.enable').catch(() => ({}));
  return {
    collect: async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) await call('HeapProfiler.collectGarbage').catch(() => ({}));
    },
    backingStorage: async (): Promise<number> =>
      (await call('Runtime.getHeapUsage')).backingStorageSize ?? 0,
  };
}

async function splitLarge(
  page: Page,
  pin: boolean,
): Promise<{ before: number; after: number; retained: number; pinCount: number; parts: number }> {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitLargeSphereMillimetre);
  const probe = await probeWorker(page);
  await probe.collect();
  const before = await probe.backingStorage();
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  if (pin) {
    await revealControl(page, page.getByTestId('split-connector-pin'));
    await page.getByTestId('split-connector-pin').check();
  }
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-apply')).toBeEnabled({ timeout: 300_000 });
  await page.getByTestId('split-apply').click();
  await expect.poll(async () => (await readState(page)).partCount, { timeout: 120_000 }).toBe(2);
  const state = await readState(page);
  const joints = await page.evaluate(
    ({ id, revision }) => window.cadfixerHarness?.listTestJoints(id, revision) ?? [],
    { id: state.documentId ?? '', revision: state.revision ?? 0 },
  );
  await probe.collect();
  const after = await probe.backingStorage();
  return {
    before,
    after,
    retained: joints[0]?.retainedBytes ?? 0,
    pinCount: joints[0]?.pinCount ?? -1,
    parts: state.partCount,
  };
}

test('retention in Chromium: pin cut versus plain cut of the same 500k-triangle sphere', async ({
  browser,
}) => {
  const results: Record<string, unknown> = {};
  for (const [label, pin] of [
    ['plain', false],
    ['pin', true],
  ] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    results[label] = await splitLarge(page, pin);
    await context.close();
  }
  const plain = results.plain as Awaited<ReturnType<typeof splitLarge>>;
  const withPin = results.pin as Awaited<ReturnType<typeof splitLarge>>;
  const observed = withPin.after - withPin.before - (plain.after - plain.before);
  const accounted = withPin.retained - plain.retained;
  const report = {
    plain: {
      ...plain,
      grewMiB: (plain.after - plain.before) / MIB,
      retainedMiB: plain.retained / MIB,
    },
    pin: {
      ...withPin,
      grewMiB: (withPin.after - withPin.before) / MIB,
      retainedMiB: withPin.retained / MIB,
    },
    observedExtraMiB: observed / MIB,
    accountedExtraMiB: accounted / MIB,
    ratio: accounted === 0 ? null : observed / accounted,
  };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (process.env.CADFIXER_QUALIFY_JOINT_OUT !== undefined)
    writeFileSync(process.env.CADFIXER_QUALIFY_JOINT_OUT, `${text}\n`);
  expect(plain.pinCount).toBe(0);
  expect(withPin.pinCount).toBeGreaterThan(0);
});
