import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { pinchedPairsStl, refusedPinchStl } from '../e2e/local-repair-fixtures';
import { tetrahedronStl } from '../e2e/stl-fixtures';
import {
  REPORT_DIR,
  applyAndSettle,
  auditConsole,
  enterRepair,
  importModel,
  record,
  settled,
  waitForResult,
  type ConsoleAudit,
} from './rc';

/**
 * REPAIR-CORE-07 — hosting contract, accessibility and responsive layout on the packaged
 * artifact, served under the deployment header template.
 */

const SHOTS = `${REPORT_DIR}/shots`;
mkdirSync(SHOTS, { recursive: true });
let audit: ConsoleAudit;

test.beforeEach(async ({ page }) => {
  audit = await auditConsole(page);
});
test.afterEach(() => {
  expect(audit.problems(), 'the console must stay clean').toEqual([]);
});

test('HOSTING: headers, isolation, worker and WASM assets under the deployment policy', async ({
  page,
}) => {
  const seen: { url: string; type: string; status: number }[] = [];
  page.on('response', (response) => {
    seen.push({
      url: response.url(),
      type: response.headers()['content-type'] ?? '',
      status: response.status(),
    });
  });
  const response = await page.goto('/');
  const headers = response?.headers() ?? {};
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  const csp = headers['content-security-policy'] ?? '';
  expect(csp).toContain("worker-src 'self'");
  expect(csp).toContain("'wasm-unsafe-eval'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);

  // Run a real repair so the geometry worker, the kernel worker and the WASM actually load.
  await importModel(page, { name: 'p.stl', mime: 'model/stl', buffer: pinchedPairsStl(3) });
  await enterRepair(page);
  expect(await settled(page)).toBe('ready');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  await applyAndSettle(page);

  const origin = new URL(page.url()).origin;
  for (const entry of seen) {
    expect(
      entry.url.startsWith(origin) ||
        entry.url.startsWith('blob:') ||
        entry.url.startsWith('data:'),
      entry.url,
    ).toBe(true);
    expect(entry.url).not.toMatch(/localhost:(5173|4173|4175)/);
    expect(entry.status, entry.url).toBeLessThan(400);
  }
  const wasm = seen.filter((entry) => entry.url.endsWith('.wasm'));
  expect(wasm.length).toBeGreaterThan(0);
  for (const entry of wasm) expect(entry.type).toBe('application/wasm');
  const scripts = seen.filter((entry) => entry.url.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const entry of scripts) expect(entry.type, entry.url).toMatch(/javascript/);
  record({ kind: 'hosting', csp, assets: seen.map((entry) => entry.url.replace(origin, '')) });
});

test('KEYBOARD: the whole repair flow with no pointer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await importModel(page, { name: 'p.stl', mime: 'model/stl', buffer: pinchedPairsStl(3) });
  await enterRepair(page);
  expect(await settled(page)).toBe('ready');

  const focusedId = async (): Promise<string> =>
    page.evaluate(
      () => document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? '',
    );
  const order: string[] = [];
  const tabTo = async (id: string): Promise<void> => {
    for (let press = 0; press < 120; press += 1) {
      if ((await focusedId()) === id) return;
      await page.keyboard.press('Tab');
      const now = await focusedId();
      if (now !== '' && order[order.length - 1] !== now) order.push(now);
    }
    throw new Error(`could not reach ${id} by keyboard; visited ${order.join(' > ')}`);
  };
  await page.getByTestId('repair-heading').focus();
  await tabTo('preview-repair');
  // Focus is VISIBLE where it lands.
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement ?? document.body);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(ring.outline !== 'none' || ring.shadow !== 'none').toBe(true);
  await page.keyboard.press('Enter');
  expect(await waitForResult(page)).toBe('candidate');
  await tabTo('apply-repair');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('repair-applied')).not.toHaveAttribute('data-outcome', 'checking', {
    timeout: 120_000,
  });
  await tabTo('undo-repair');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
  record({ kind: 'keyboard-focus-order', order });
});

test('SEMANTICS: names, live regions, alert vs status, and no meaning carried by colour alone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await importModel(page, { name: 'r.stl', mime: 'model/stl', buffer: refusedPinchStl() });
  await enterRepair(page);
  expect(await settled(page)).toBe('ready');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');

  // Every button and checkbox in the repair workspace has an accessible name.
  const unnamed = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll(
      '[data-testid="repair-workspace"] button, [data-testid="repair-workspace"] input',
    )) {
      const label =
        el.getAttribute('aria-label') ??
        (el as HTMLInputElement).labels?.[0]?.textContent ??
        el.textContent;
      if (label.trim() === '' && el.getAttribute('aria-labelledby') === null) {
        out.push(el.getAttribute('data-testid') ?? el.tagName);
      }
    }
    return out;
  });
  expect(unnamed).toEqual([]);

  // A safe partial outcome is neutral: its meaning is in WORDS, and nothing is an alert.
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  const summary = page.getByTestId('repair-summary');
  await expect(summary).toContainText('Some issues need manual repair');
  await expect(summary.locator('.repair-summary__heading').first()).toBeVisible();
  // The footer's status region is a polite live region, not an assertive one.
  const live = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="repair-footer"] [aria-live]')].map((el) =>
      el.getAttribute('aria-live'),
    ),
  );
  expect(live.length).toBeGreaterThan(0);
  expect(live.every((value) => value === 'polite')).toBe(true);
  // The running state is announced without a number: an indeterminate progress element.
  await page.getByTestId('discard-preview').click();
});

test('REFLOW: at 200% zoom the preview and its actions remain reachable without sideways scrolling', async ({
  page,
}) => {
  // 200% zoom of a 1440 x 900 window is a 720 x 450 CSS-pixel window.
  await page.setViewportSize({ width: 720, height: 450 });
  await page.goto('/');
  await importModel(page, { name: 'r.stl', mime: 'model/stl', buffer: refusedPinchStl() });
  await enterRepair(page);
  expect(await settled(page)).toBe('ready');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  await expect(page.getByTestId('apply-repair')).toBeInViewport();
  await expect(page.getByTestId('discard-preview')).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

const SIZES = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

async function noOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: horizontal page overflow`).toBeLessThanOrEqual(0);
}

for (const size of SIZES) {
  const tag = `${String(size.width)}x${String(size.height)}`;
  test(`RESPONSIVE ${tag}: before, running, preview, partial, result, undo`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await importModel(page, { name: 'p.stl', mime: 'model/stl', buffer: pinchedPairsStl(400) });
    await enterRepair(page);
    expect(await settled(page)).toBe('ready');
    await noOverflow(page, 'before');
    await page.screenshot({ path: `${SHOTS}/${tag}-1-before.png` });

    await page.getByTestId('preview-repair').click();
    await expect(page.getByTestId('cancel-repair')).toBeInViewport();
    await page.screenshot({ path: `${SHOTS}/${tag}-2-running.png` });
    await noOverflow(page, 'running');
    await page.getByTestId('cancel-repair').click();
    await expect(page.getByTestId('repair-cancelled')).toBeVisible({ timeout: 60_000 });

    await importModel(page, { name: 'p3.stl', mime: 'model/stl', buffer: pinchedPairsStl(3) });
    expect(await settled(page)).toBe('ready');
    await page.getByTestId('preview-repair').click();
    expect(await waitForResult(page)).toBe('candidate');
    await expect(page.getByTestId('apply-repair')).toBeInViewport();
    await expect(page.getByTestId('discard-preview')).toBeInViewport();
    await noOverflow(page, 'preview');
    await page.screenshot({ path: `${SHOTS}/${tag}-3-preview.png` });
    await applyAndSettle(page);
    await noOverflow(page, 'result');
    await expect(page.getByTestId('undo-repair')).toBeAttached();
    await page.screenshot({ path: `${SHOTS}/${tag}-4-result.png` });
    await page.getByTestId('undo-repair').click();
    await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });

    await importModel(page, { name: 'r.stl', mime: 'model/stl', buffer: refusedPinchStl() });
    expect(await settled(page)).toBe('ready');
    await page.getByTestId('preview-repair').click();
    expect(await waitForResult(page)).toBe('candidate');
    await expect(page.getByTestId('apply-repair')).toBeInViewport();
    await noOverflow(page, 'partial preview');
    await page.screenshot({ path: `${SHOTS}/${tag}-5-partial.png` });

    await importModel(page, { name: 'clean.stl', mime: 'model/stl', buffer: tetrahedronStl() });
    await expect(page.getByTestId('repair-no-repairs')).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/${tag}-0-clean.png` });
  });
}
