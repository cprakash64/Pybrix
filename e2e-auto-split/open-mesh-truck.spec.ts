import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Page, type Browser } from '@playwright/test';
import { openInspector } from '../e2e/inspector';
const OUT = 'artifacts/open-mesh-split-01';
const TRUCK =
  process.env.OPEN_MESH_TRUCK_PATH ?? join(homedir(), 'Downloads', 'Hitem3d-1785766060812.stl');
test.skip(process.env.OPEN_MESH_TRUCK !== '1', 'requires the read-only local truck');
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
  let t = Date.now();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 180_000 });
  const previewMs = Date.now() - t;
  const previewRssMiB = await browserRss(browser);
  await page.screenshot({ path: `${OUT}/${label}-manual-preview.png` });
  expect(await exportDigest(page)).toEqual(before);
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-apply')).toBeEnabled({ timeout: 180_000 });
  t = Date.now();
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-undo')).toBeEnabled({ timeout: 180_000 });
  const applyMs = Date.now() - t;
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
  await page.getByTestId('auto-disclosure-continue').click();
  await page.getByTestId('auto-analyze').click();
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 180_000 });
  await page.screenshot({ path: `${OUT}/original-auto-suggestions.png` });
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
});
test('current Repair, Apply, plain Split, Undo restores repaired export', async ({
  page,
  browser,
}) => {
  test.setTimeout(900_000);
  await importTruck(page);
  await page.getByTestId('workflow-repair').click();
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 180_000 });
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 180_000 });
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 180_000 });
  await openInspector(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText('1,988,892', { timeout: 180_000 });
  await splitChain(page, browser, 'repaired', '1,988,892');
});
