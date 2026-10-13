import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Page, type Browser } from '@playwright/test';
import { openInspector } from '../e2e/inspector';
import { revealControl } from '../e2e/progressive-disclosure';
const OUT = 'artifacts/split-ux-simplification-01';
const TRUCK =
  process.env.OPEN_MESH_TRUCK_PATH ?? join(homedir(), 'Downloads', 'Hitem3d-1785766060812.stl');
test.skip(process.env.SPLIT_UX_TRUCK !== '1', 'requires the read-only local truck');
const SIZES = [
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1728, 1117],
  [1920, 1080],
] as const;
async function capture(page: Page, state: string): Promise<void> {
  mkdirSync(`${OUT}/screenshots`, { recursive: true });
  const collapse = page.getByTestId('collapse-inspector');
  if (await collapse.isVisible()) await collapse.click();
  const close = page.getByTestId('close-inspector');
  if (await close.isVisible()) await close.click();
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    const panel = page.getByTestId('tool-panel');
    const visiblePrimary = await panel.locator('.primary-action:visible').allTextContents();
    const text = await panel.innerText();
    log({
      state,
      width,
      height,
      visiblePrimary: visiblePrimary.map((t) => t.trim()),
      visibleText: text,
      horizontalOverflow: await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    });
    await page.screenshot({
      path: `${OUT}/screenshots/${state}-${String(width)}x${String(height)}.png`,
    });
  }
}
async function disclose(page: Page, testId: string): Promise<void> {
  const button = page.getByTestId(testId).getByRole('button').first();
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
}
/** Own Chromium process ids only; phase observations, not a whole-machine memory claim. */
async function browserRss(browser: Browser): Promise<number | undefined> {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = (await session.send('SystemInfo.getProcessInfo')) as {
      processInfo: { id: number }[];
    };
    const ids = result.processInfo
      .map((p) => p.id)
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (ids.length === 0) return undefined;
    const text = execFileSync('ps', ['-o', 'rss=', '-p', ids.join(',')], { encoding: 'utf8' });
    return (
      text
        .trim()
        .split(/\s+/)
        .map(Number)
        .reduce((sum, n) => sum + n, 0) / 1024
    );
  } catch {
    return undefined;
  } finally {
    await session.detach();
  }
}
async function exportDigest(page: Page): Promise<{ sha256: string; bytes: number }> {
  await openInspector(page);
  await expect(page.getByTestId('export-binary')).toBeEnabled({ timeout: 180_000 });
  const wait = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByTestId('export-binary').click();
  const h = createHash('sha256');
  let bytes = 0;
  for await (const b of await (await wait).createReadStream()) {
    h.update(b as Buffer);
    bytes += (b as Buffer).length;
  }
  return { sha256: h.digest('hex'), bytes };
}
async function importTruck(page: Page): Promise<void> {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(TRUCK);
  await openInspector(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText('1,988,877', { timeout: 180_000 });
}
function log(row: Record<string, unknown>): void {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(`${OUT}/truck-browser.jsonl`, `${JSON.stringify(row)}\n`);
}
async function splitChain(
  page: Page,
  browser: Browser,
  label: string,
  faces: string,
): Promise<void> {
  const before = await exportDigest(page);
  const beforeRssMiB = await browserRss(browser);
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-manual').click();
  await expect(page.getByTestId('split-preview')).toBeEnabled();
  await capture(page, `${label}-I-manual`);
  await disclose(page, 'split-advanced');
  await capture(page, `${label}-J-advanced`);
  await disclose(page, 'split-advanced');
  let t = Date.now();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 180_000 });
  const previewMs = Date.now() - t;
  await capture(page, `${label}-K-preview`);
  const previewRssMiB = await browserRss(browser);
  await page.screenshot({ path: `${OUT}/${label}-manual-preview.png` });
  expect(await exportDigest(page)).toEqual(before);
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-apply')).toBeEnabled({ timeout: 180_000 });
  t = Date.now();
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-undo')).toBeEnabled({ timeout: 180_000 });
  const applyMs = Date.now() - t;
  await capture(page, `${label}-L-applied`);
  const applyRssMiB = await browserRss(browser);
  t = Date.now();
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('split-undo')).toHaveCount(0, { timeout: 180_000 });
  const undoMs = Date.now() - t;
  const undoRssMiB = await browserRss(browser);
  await openInspector(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText(faces);
  const after = await exportDigest(page);
  expect(after).toEqual(before);
  log({
    label,
    previewMs,
    applyMs,
    undoMs,
    before,
    after,
    identity: true,
    rssMiB: {
      before: beforeRssMiB,
      preview: previewRssMiB,
      applied: applyRssMiB,
      undone: undoRssMiB,
    },
  });
}
test('original truck: plain Manual Split and a mock Vehicle plane preview', async ({
  page,
  browser,
}) => {
  test.setTimeout(900_000);
  const errors: string[] = [],
    foreign: string[] = [],
    bodies: { url: string; bytes: number }[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) foreign.push(r.url());
    if (r.postDataBuffer())
      bodies.push({ url: u.pathname, bytes: r.postDataBuffer()?.length ?? 0 });
  });
  await page.setExtraHTTPHeaders({ 'x-real-ip': '10.91.1.1' });
  await page.request.post('http://127.0.0.1:8787/api/auto-split/__mock/reset');
  await page.request.post('http://127.0.0.1:8787/api/auto-split/__mock/scenario', {
    data: { scenario: 'vehicle-open-truck' },
  });
  await importTruck(page);
  await splitChain(page, browser, 'original', '1,988,877');
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await page.getByTestId('auto-kind-vehicle').check({ force: true });
  await capture(page, 'E-auto-initial');
  await page.getByTestId('auto-disclosure-continue').click();
  await page.route('**/api/auto-split/analyze', async (route) => {
    // Hold the deterministic provider request while capturing the genuine waiting state.
    await capture(page, 'F-auto-analyzing');
    await route.continue();
  });
  await page.getByTestId('auto-analyze').click();
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 180_000 });
  await capture(page, 'G-auto-results');

  await expect(page.getByTestId('auto-preview-cab_bed')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('auto-preview-cab_bed').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 180_000 });
  const state = (await (
    await page.request.get('http://127.0.0.1:8787/api/auto-split/__mock/state')
  ).json()) as { received: { imageCount: number }[] };
  expect(state.received).toHaveLength(1);
  expect(state.received[0]?.imageCount).toBe(6);
  expect(errors).toEqual([]);
  expect(foreign).toEqual([]);
  expect(bodies.filter((r) => r.url === '/api/auto-split/analyze')).toHaveLength(1);
  log({ label: 'auto-original', preview: true, errors, foreign, bodies, received: state.received });
  // An actual local refusal for an adjusted cab/bed candidate, with other rows preserved.
  await page.getByTestId('split-discard').click();
  await revealControl(page, page.getByTestId('split-plane-yz'));
  await page.getByTestId('split-plane-yz').click();
  await page.getByTestId('split-position-slider').focus();
  await page.keyboard.press('Home');
  await page.getByTestId('auto-preview-adjusted').click();
  await expect(page.getByTestId('auto-unsafe')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('auto-row-status-cab_bed')).toContainText(
    "Can't split this area safely",
  );
  // Close explicitly opened controls before capturing the result surface.
  await page.getByRole('button', { name: 'Adjust cut', exact: true }).click();
  await capture(page, 'H-auto-unsafe-result');
});
test('current Repair, Apply, plain Split, Undo restores repaired export', async ({
  page,
  browser,
}) => {
  test.setTimeout(900_000);
  await importTruck(page);
  await page.getByTestId('workflow-repair').click();
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 180_000 });
  await capture(page, 'A-repair-ready');
  await page.getByTestId('preview-repair').click();
  await capture(page, 'B-repairing');

  await expect(page.getByTestId('repair-intent')).toContainText('Repair complete', {
    timeout: 180_000,
  });
  await capture(page, 'C-repair-complete');
  await disclose(page, 'repair-details');
  await capture(page, 'D-repair-details');
  await openInspector(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText('1,988,892', { timeout: 180_000 });
  await splitChain(page, browser, 'repaired', '1,988,892');
});
