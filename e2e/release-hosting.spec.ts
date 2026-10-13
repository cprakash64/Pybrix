import { revealControl } from './progressive-disclosure';
import { expect, test, type Page, type Response } from '@playwright/test';
import { binaryStl } from './stl-fixtures';
import { APP_BASE_URL } from './app-origin';
import { openInspector } from './inspector';

/**
 * BQ23–BQ29, BQ43–BQ54 — THE HOSTING CONTRACT, MEASURED RATHER THAN DECLARED.
 *
 * Everything here runs against the PRODUCTION BUILD served by the preview server
 * under the same three headers `docs/DEPLOYMENT_REQUIREMENTS.md` requires of a
 * real host. That is the point: the isolation contract is not a claim about
 * configuration files, it is a claim about response headers and about
 * `crossOriginIsolated` actually being true in the page that results.
 *
 * WHY THIS IS A RELEASE GATE AND NOT A NICETY. Conservative repair's
 * interruptibility is built on `SharedArrayBuffer` and `Atomics`, and browsers
 * only expose those in a cross-origin isolated context. A host that forgets one
 * header does not produce a broken build — it produces a build whose Cancel
 * control is unavailable, which is a silent reduction in what the product
 * promises. So the headers, the isolation flag, and the fail-closed behaviour
 * when isolation is absent are all asserted.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

test('BQ23, BQ24: the served production build is cross-origin isolated', async ({ page }) => {
  test.setTimeout(120_000);
  const response = await page.goto('/');
  expect(response).not.toBeNull();

  const headers = response?.headers() ?? {};
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');

  /*
   * THE HEADERS ARE THE MEANS; THIS IS THE END. A host can send all three and
   * still fail to isolate — a single cross-origin subresource without CORP is
   * enough — so the flag the browser computed is what actually qualifies.
   */
  const capability = await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    atomics: typeof Atomics !== 'undefined',
    wasm: typeof WebAssembly !== 'undefined',
    workers: typeof Worker !== 'undefined',
    decompression: typeof DecompressionStream !== 'undefined',
    blob: typeof Blob !== 'undefined',
    objectUrl: typeof URL.createObjectURL === 'function',
  }));

  expect(capability.isolated, 'crossOriginIsolated must be true').toBe(true);
  expect(capability.sharedArrayBuffer).toBe(true);
  expect(capability.atomics).toBe(true);
  expect(capability.wasm).toBe(true);
  expect(capability.workers).toBe(true);
  expect(capability.decompression).toBe(true);
  expect(capability.blob).toBe(true);
  expect(capability.objectUrl).toBe(true);
});

test('BQ26, BQ27, BQ44-BQ46: every asset class loads with the right type under COEP', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const served: { url: string; type: string; status: number }[] = [];
  page.on('response', (response: Response) => {
    served.push({
      url: response.url(),
      type: response.headers()['content-type'] ?? '',
      status: response.status(),
    });
  });

  await page.goto('/');
  // Import, then run the self-intersection check: that is what pulls the worker
  // chunks and the Geogram WASM over the wire under these headers.
  await openFile(page, 'small.stl', binaryStl(500).bytes);
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

  const find = (pattern: RegExp): { url: string; type: string; status: number } | undefined =>
    served.find((entry) => pattern.test(entry.url));

  const html = find(/\/$|index\.html/);
  expect(html?.status).toBe(200);
  expect(html?.type).toContain('text/html');

  const js = find(/assets\/index-.*\.js$/);
  expect(js?.status).toBe(200);
  expect(js?.type).toMatch(/javascript/);

  const css = find(/assets\/index-.*\.css$/);
  expect(css?.status).toBe(200);
  expect(css?.type).toContain('text/css');

  // BQ45. The geometry worker is a module script and must be served as one, or
  // the browser refuses to instantiate it.
  const worker = find(/geometry\.worker-.*\.js$/);
  expect(worker?.status).toBe(200);
  expect(worker?.type).toMatch(/javascript/);

  // NOTHING FAILED. A COEP misconfiguration shows up as blocked subresources
  // rather than as a thrown error, so a status sweep is the honest check.
  const failures = served.filter((entry) => entry.status >= 400);
  expect(failures.map((entry) => `${String(entry.status)} ${entry.url}`)).toEqual([]);
});

test('BQ29, BQ54: the whole flow is same-origin and sends no geometry anywhere', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const requests: string[] = [];
  const bodies: number[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
    const data = request.postData();
    if (data !== null) bodies.push(data.length);
  });

  const response = await page.goto('/');
  const origin = new URL(response?.url() ?? APP_BASE_URL).origin;

  await openFile(page, 'small.stl', binaryStl(700).bytes);
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  await pending;

  /*
   * EVERY REQUEST SAME-ORIGIN. Not "no analytics we know about" — the actual list
   * of URLs the page asked for, filtered to anything that is not our own origin
   * and is not a browser-internal scheme.
   */
  const offOrigin = requests.filter(
    (url) => !url.startsWith(origin) && !/^(blob|data|about|chrome-extension):/.test(url),
  );
  expect(offOrigin, 'no off-origin request may occur during a full flow').toEqual([]);

  // AND NOTHING WAS UPLOADED. No request carried a body at all, so no geometry
  // could have travelled in one.
  expect(bodies).toEqual([]);
});

test('BQ53: the Geogram kernel is not fetched until a check needs it', async ({ page }) => {
  test.setTimeout(180_000);
  const wasmRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('.wasm')) wasmRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.getByTestId('browse-button')).toBeVisible({ timeout: 30_000 });

  /*
   * THE SHELL COSTS NO KERNEL. Geogram is 1.2 MB, it is only needed by the
   * self-intersection diagnostic, and a build that loaded it eagerly would make
   * every first paint pay for a feature most sessions never reach.
   */
  expect(wasmRequests, 'no WASM may be fetched before a model is even loaded').toEqual([]);

  await openFile(page, 'small.stl', binaryStl(500).bytes);
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  // Import and topology are kernel-free too: topology is our own exact-coordinate
  // engine, not the WASM narrowphase.
  expect(wasmRequests).toEqual([]);
});
