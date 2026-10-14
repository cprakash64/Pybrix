import { required } from '@cadfixer/auto-split/fixtures';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { openInspector } from '../e2e/inspector';
const source = '/Users/cprakash/Downloads/Hitem3d-1785766060812.stl',
  out = 'artifacts/semantic-auto-decompose-01';
test.skip(process.env.SEMANTIC_TRUCK !== '1', 'requires the read-only actual truck');
const sourceSha = (): string => createHash('sha256').update(readFileSync(source)).digest('hex');
async function digest(page: Page): Promise<string> {
  await openInspector(page);
  await expect(page.getByTestId('export-binary')).toBeEnabled({ timeout: 180000 });
  const wait = page.waitForEvent('download', { timeout: 180000 });
  await page.getByTestId('export-binary').click();
  const hash = createHash('sha256');
  for await (const bytes of await (await wait).createReadStream()) hash.update(bytes as Buffer);
  return hash.digest('hex');
}
async function rss(browser: Browser): Promise<number> {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = (await session.send('SystemInfo.getProcessInfo')) as {
      processInfo: {
        id: number;
      }[];
    };
    return (
      execFileSync('ps', ['-o', 'rss=', '-p', result.processInfo.map((p) => p.id).join(',')], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .map(Number)
        .reduce((a, b) => a + b, 0) / 1024
    );
  } finally {
    await session.detach();
  }
}
for (const [index, id] of ['bed', 'cabin'].entries())
  test(`actual truck semantic ${id}: honest geometry preview, Apply, stale state and exact Undo`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(600000);
    mkdirSync(out, { recursive: true });
    const sourceBefore = sourceSha();
    expect(sourceBefore).toBe('3b9d3aaa3523f75c8e1a079e3aa3e50086d0f2cf9c5abbf78b8790df0a143e73');
    await page.setExtraHTTPHeaders({ 'x-real-ip': `10.112.4.${String(index + 1)}` });
    await page.request.post('http://127.0.0.1:8787/api/auto-split/__mock/reset');
    await page.request.post('http://127.0.0.1:8787/api/auto-split/__mock/scenario', {
      data: { scenario: 'semantic-truck' },
    });
    const foreign: string[] = [],
      errors: string[] = [],
      audit: unknown[] = [];
    let requestAt = 0,
      roundTripMs = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (r) => {
      if (
        !r.url().startsWith('http://localhost:4173') &&
        !r.url().startsWith('http://127.0.0.1:4173') &&
        !r.url().startsWith('blob:') &&
        !r.url().startsWith('data:')
      )
        foreign.push(r.url());
      if (!r.url().endsWith('/api/auto-split/analyze')) return;
      requestAt = Date.now();
      const raw = required(r.postData(), 'r.postData()');
      expect(raw).not.toMatch(/"(?:positions|indices|vertices|stl|filename|path)"\s*:/);
      const body = JSON.parse(raw) as {
        views: {
          png: string;
        }[];
        componentViews: {
          png: string;
        }[];
        semantic: unknown;
      };
      const images = [...body.views, ...body.componentViews];
      expect(images).toHaveLength(12);
      const imageBytes = images.map((v) => Buffer.from(v.png, 'base64').length);
      for (const image of images) {
        const png = Buffer.from(image.png, 'base64');
        expect(png.readUInt32BE(16)).toBe(512);
        expect(png.readUInt32BE(20)).toBe(512);
      }
      audit.push({
        images: images.length,
        imageBytes,
        base64Bytes: images.reduce((n, v) => n + v.png.length, 0),
        metadataBytes: Buffer.byteLength(JSON.stringify(body.semantic)),
        requestBytes: Buffer.byteLength(raw),
      });
    });
    page.on('response', (r) => {
      if (r.url().endsWith('/api/auto-split/analyze')) roundTripMs = Date.now() - requestAt;
    });
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('browse-button').click();
    await (await chooser).setFiles(source);
    await openInspector(page);
    await expect(page.getByTestId('fact-triangles')).toHaveText('1,988,877', { timeout: 180000 });
    const before = await digest(page),
      rssImported = await rss(browser);
    await page.getByTestId('workflow-split').click();
    await page.getByTestId('split-tab-auto').click();
    await page.getByTestId('auto-disclosure-continue').click();
    let t = Date.now();
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 180000 });
    const analysisMs = Date.now() - t,
      rssAnalyzed = await rss(browser);
    await expect(page.getByTestId('auto-results')).toContainText('Dump truck');
    await expect(page.getByTestId('auto-row-wheels')).toContainText(
      'Recognized, but no safe split was found',
    );
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
      [1920, 1080],
    ]) {
      await page.setViewportSize({
        width: required(width, 'width'),
        height: required(height, 'height'),
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${out}/semantic-${id}-results-${String(width)}x${String(height)}.png`,
      });
    }
    t = Date.now();
    await page.getByTestId(`auto-preview-${id}`).click();
    await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 180000 });
    const previewMs = Date.now() - t,
      rssPreview = await rss(browser);
    await page.screenshot({ path: `${out}/semantic-${id}-preview.png` });
    expect(await digest(page)).toBe(before);
    t = Date.now();
    await page.getByTestId('split-apply').click();
    await expect(page.getByTestId('split-undo')).toBeVisible({ timeout: 180000 });
    const applyMs = Date.now() - t;
    await page.getByTestId('split-again').click();
    await page.getByTestId('split-tab-auto').click();
    await expect(page.getByTestId('auto-stale')).toBeVisible();
    await expect(page.getByTestId(`auto-preview-${id}`)).toBeDisabled();
    t = Date.now();
    await page.getByTestId('split-cancel').click();
    await page.getByTestId('split-undo').click();
    await expect(page.getByTestId('split-undo')).not.toBeVisible({ timeout: 180000 });
    const undoMs = Date.now() - t;
    const after = await digest(page);
    expect(after).toBe(before);
    expect(before).toBe('aa659d2289b32d5a17224164085c8dcfbc4abadd150282ddcb1d184efdb042b2');
    expect(sourceSha()).toBe(sourceBefore);
    expect(errors).toEqual([]);
    expect(foreign).toEqual([]);
    writeFileSync(
      `${out}/semantic-${id}-browser.json`,
      JSON.stringify(
        {
          sourceBefore,
          before,
          after,
          analysisMs,
          roundTripMs,
          previewMs,
          applyMs,
          undoMs,
          rssImported,
          rssAnalyzed,
          rssPreview,
          audit,
          errors,
          foreign,
        },
        null,
        2,
      ),
    );
  });
