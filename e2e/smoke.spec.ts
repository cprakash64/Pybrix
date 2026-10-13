import { expect, test } from '@playwright/test';
import { isAppOrigin } from './app-origin';
import { openInspector } from './inspector';

/**
 * End-to-end smoke tests against the production build served by `vite preview`.
 *
 * These cover the things jsdom cannot: real WebGL, a real module worker, real
 * structured cloning with buffer transfer, and the cross-origin isolation
 * headers the deployment must send.
 */

test('the application opens and renders the shell', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Pybrix' })).toBeVisible();
  await expect(page.getByRole('region', { name: '3D workspace' })).toBeVisible();
  await expect(page.getByTestId('drop-zone')).toBeVisible();
});

test('no console errors are logged on load', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await expect(page.getByTestId('viewport-canvas').locator('canvas')).toBeAttached();

  expect(errors).toEqual([]);
});

test('the viewport acquires a real WebGL context', async ({ page }) => {
  await page.goto('/');

  // In a real browser the viewport must succeed, so the failure notice that
  // jsdom triggers must be absent here.
  await expect(page.getByTestId('viewport-canvas').locator('canvas')).toBeAttached();
  await expect(page.getByTestId('viewport-error')).toHaveCount(0);
  await expect(page.getByTestId('viewport-empty')).toBeVisible();

  // Because the viewport starts cleanly in a real browser, the status log has
  // nothing to report on load.
  await expect(page.getByTestId('status-empty')).toHaveCount(0);
  await expect(page.getByTestId('status-list')).toHaveCount(0);
});

test('the viewport canvas is sized to its container and does not overflow the page', async ({
  page,
}) => {
  // Regression test. `WebGLRenderer.setSize(w, h, false)` skips updating the
  // canvas CSS size, so the element is laid out from its width/height
  // attributes — which include the device pixel ratio. On a HiDPI display that
  // rendered the canvas at twice its intended size, pushing the scene off
  // centre and overflowing the layout horizontally.
  await page.goto('/');
  const canvas = page.getByTestId('viewport-canvas').locator('canvas');
  await expect(canvas).toBeAttached();

  const layout = await page.evaluate(() => {
    const container = document.querySelector('[data-testid="viewport-canvas"]');
    const element = container?.querySelector('canvas');
    return {
      containerWidth: container?.clientWidth ?? 0,
      canvasWidth: element?.clientWidth ?? 0,
      canvasHeight: element?.clientHeight ?? 0,
      containerHeight: container?.clientHeight ?? 0,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    };
  });

  expect(layout.containerWidth).toBeGreaterThan(0);
  expect(layout.canvasWidth).toBe(layout.containerWidth);
  expect(layout.canvasHeight).toBe(layout.containerHeight);
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth);
});

test('the document is cross-origin isolated, so multithreaded WASM will be possible', async ({
  page,
}) => {
  await page.goto('/');

  // Asserted both in the page and in the UI, because the headers are a
  // deployment requirement that is easy to lose silently.
  await expect(page.getByTestId('isolation-state')).toHaveText('yes');
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
});

test('the geometry worker round-trips a transferred buffer', async ({ page }) => {
  await page.goto('/');

  await openInspector(page);
  await page.getByTestId('run-self-test').click();

  await expect(page.getByTestId('self-test-state')).toHaveText('passed', { timeout: 15_000 });
  await expect(page.getByTestId('status-list')).toContainText('Worker self-test passed');
});

/**
 * This assertion has moved three times — each time to describe the new truth
 * rather than to accommodate it.
 *
 * UI-07A: NAVIGATION SAYS WHICH WORKSPACES EXIST, and nothing else. Every
 * implemented workspace can be entered on an empty workspace, and says inside
 * itself what it needs; a workspace that does not exist is shown, announced
 * unavailable and badged "coming soon". A feature drawn disabled because no
 * model is open reads as a feature that is not there.
 */
test('every implemented workspace can be entered; Hollow is coming soon', async ({ page }) => {
  await page.goto('/');

  for (const workflow of ['repair', 'convert', 'split', 'texture']) {
    const item = page.getByTestId(`workflow-${workflow}`);
    await expect(item).toBeEnabled();
    await expect(item).not.toHaveAttribute('aria-disabled');
    await expect(item).not.toContainText(/Open a model first|Not implemented/);
  }

  const hollow = page.getByTestId('workflow-hollow');
  await expect(hollow).toHaveAttribute('aria-disabled', 'true');
  await expect(hollow).toHaveAccessibleName('Hollow — coming soon');
});

test('the page issues no network requests beyond its own assets', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!isAppOrigin(request.url())) external.push(request.url());
  });

  await page.goto('/');
  await openInspector(page);
  await page.getByTestId('run-self-test').click();
  await expect(page.getByTestId('self-test-state')).toHaveText('passed', { timeout: 15_000 });

  expect(external).toEqual([]);
});
