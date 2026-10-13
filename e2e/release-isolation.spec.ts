import { revealControl } from './progressive-disclosure';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * BQ25, BQ57 — WHAT HAPPENS WHEN A HOST FORGETS THE ISOLATION HEADERS.
 *
 * This is the most likely production misconfiguration there is, and it is
 * dangerous precisely because it does not look like a failure. Without COOP and
 * COEP the browser withholds `SharedArrayBuffer`; conservative repair's Cancel
 * depends on it, because a flag a worker can read mid-loop is the only way to
 * interrupt a synchronous pass. A build that shrugged and carried on would offer
 * a Cancel control that cannot cancel — worse than offering none.
 *
 * SERVED WITHOUT THE HEADERS, ON PURPOSE. `scripts/release-server.mjs
 * --no-isolation` serves the same production build the rest of the suite uses,
 * minus the three headers, so this is the real browser reaching the real
 * decision rather than a mocked capability.
 */

/**
 * ONE PORT PER PLAYWRIGHT WORKER, and this is a correctness requirement rather
 * than tidiness. `beforeAll` runs once per worker process, so a single fixed port
 * meant four workers racing to bind it: one won and the other three tested
 * against a server that had failed to start. Deriving the port from the worker
 * index gives each its own, so the file is safe under the suite's default
 * parallelism.
 */
const BASE_PORT = 4186;
let server: ChildProcess | undefined;
let port = BASE_PORT;

test.beforeAll(async () => {
  // `test.info()` rather than a destructured hook argument: the fixtures object
  // is not needed here, and an empty destructuring pattern is a lint error.
  port = BASE_PORT + test.info().workerIndex;
  server = spawn('node', ['scripts/release-server.mjs', '--port', String(port), '--no-isolation'], {
    stdio: 'ignore',
  });
  // The server binds immediately; give it a moment rather than racing the first
  // navigation, which would report a connection error instead of a header result.
  await new Promise((resolve) => setTimeout(resolve, 1200));
});

test.afterAll(() => {
  server?.kill();
});

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

test('BQ25: without COOP/COEP the browser withholds SharedArrayBuffer', async ({ page }) => {
  test.setTimeout(120_000);
  const response = await page.goto(`http://localhost:${String(port)}/`);
  const headers = response?.headers() ?? {};

  // The premise: these really are absent.
  expect(headers['cross-origin-opener-policy']).toBeUndefined();
  expect(headers['cross-origin-embedder-policy']).toBeUndefined();

  const capability = await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  }));
  expect(capability.isolated).toBe(false);
  expect(capability.sharedArrayBuffer).toBe(false);
});

test('BQ25: repair refuses rather than becoming uninterruptible', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`http://localhost:${String(port)}/`);
  await openFile(page, 'small.stl', binaryStl(600).bytes);
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

  /*
   * FAIL CLOSED, AND VISIBLY. The panel states the refusal instead of rendering
   * repair controls, so there is no path to a repair that could not be stopped.
   * The primary action keeps its place (REPAIR-UX-01) but is disabled.
   */
  const refusal = page.getByTestId('repair-isolation-unavailable');
  await expect(refusal).toBeVisible();
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);

  const text = ((await refusal.textContent()) ?? '').toLowerCase();
  // It explains the cause in terms a host operator can act on...
  expect(text).toContain('cross-origin isolated');
  // ...and says what still works, so the page is not mistaken for broken.
  expect(text).toContain('export');
  // And it is announced, not merely drawn.
  await expect(refusal).toHaveAttribute('role', 'alert');
});

test('BQ25, BQ58: the rest of the product still works without isolation', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`http://localhost:${String(port)}/`);
  await openFile(page, 'small.stl', binaryStl(500).bytes);

  /*
   * FEATURE-LEVEL DEGRADATION, NOT A DEAD APPLICATION. Import, topology and
   * export do not need a cancellation signal, so refusing repair must not take
   * them down with it — that is the difference between a safe refusal and a
   * self-inflicted outage.
   */
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('health-triangles')).toHaveText((500).toLocaleString());

  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  const download = await pending;
  const stream = await download.createReadStream();
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).length;
  expect(bytes).toBe(84 + 500 * 50);
});
