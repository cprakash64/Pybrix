import { expect, test, type Page } from '@playwright/test';
import { enter, openBox, openDefects } from './ui-fixtures';
import { openInspector } from './inspector';

/**
 * PR-01: release-readiness behaviours of the shipped application.
 *
 *   - The licences of everything the build distributes are shipped AND
 *     reachable from the interface.
 *   - Without WebGL the product says what still works and what to do, in words
 *     rather than a library's error string, and import and export still work.
 *   - Leaving the page asks first ONLY while applied work exists nowhere else.
 *   - At 200 % browser zoom the critical controls stay usable.
 */

/**
 * Whether the page's handlers would stop an unload right now. Dispatching a
 * cancellable event asks exactly the question the browser asks, without the
 * test runner treating a cancelled navigation as one still in flight.
 */
async function wouldAskBeforeLeaving(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function download(page: Page, trigger: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download');
  await trigger();
  return (await pending).suggestedFilename();
}

test('third-party notices are shipped, complete, and linked from Help', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('help-menu').click();
  const link = page.getByTestId('third-party-notices');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'third-party-notices.txt');
  await expect(link).toHaveAttribute('rel', /noopener/);
  const href = await link.evaluate((element) => (element as HTMLAnchorElement).href);
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  const text = await response.text();
  for (const component of [
    'SIL OPEN FONT LICENSE',
    'Lucide',
    'React 19',
    'scheduler',
    'three.js',
    'Geogram',
    'Jean-loup Gailly and Mark Adler',
    'Apache License',
    'Emscripten',
    'musl',
  ])
    expect(text, component).toContain(component);
});

test('without WebGL the product explains itself, and import and export still work', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Read through the descriptor: the original is called below with the
    // canvas as `this`, never detached from it.
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
      ?.value as (this: HTMLCanvasElement, ...args: unknown[]) => unknown;
    // Emulates a browser that provides no WebGL (disabled acceleration, a
    // blocklisted GPU): every WebGL context request fails.
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (type.startsWith('webgl') || type === 'experimental-webgl') return null;
      return original.call(this, type, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const failure = page.getByTestId('viewport-error');
  await expect(failure).toContainText('did not provide WebGL graphics');
  await expect(failure).toContainText('hardware acceleration');
  // A remedy, not a library's error string.
  await expect(failure).not.toContainText('THREE');

  await openBox(page);
  await enter(page, 'convert');
  const name = await download(page, () => page.getByTestId('convert-export').click());
  // Convert starts on the source's own format.
  expect(name).toBe('box.3mf');
  await expect(page.getByTestId('convert-saved')).toBeVisible();
});

test('leaving the page asks first only while applied work is unexported', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const prompts: string[] = [];
  page.on('dialog', (dialog) => {
    prompts.push(dialog.type());
    void dialog.dismiss();
  });

  // An untouched model: the file is still on disk, so nothing asks.
  await openDefects(page);
  expect(await wouldAskBeforeLeaving(page)).toBe(false);
  await page.reload();
  expect(prompts).toEqual([]);

  // Apply a real repair.
  await openDefects(page);
  await page.getByTestId('issue-row-degenerate-faces').click();
  await openInspector(page);
  await page.getByTestId('issue-preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });

  // Now leaving would discard it, so the page asks...
  expect(await wouldAskBeforeLeaving(page)).toBe(true);
  // ...and a real attempt to leave raises the browser's own prompt. Closing
  // with `runBeforeUnload` is Playwright's documented way to exercise it:
  // dismissing the prompt keeps the page, and the session in it.
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => prompts).toEqual(['beforeunload']);
  expect(page.isClosed()).toBe(false);
  await expect.poll(() => wouldAskBeforeLeaving(page)).toBe(true);

  // Once that exact revision is exported, nothing is lost by leaving.
  await enter(page, 'convert');
  await download(page, () => page.getByTestId('convert-export').click());
  await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 60_000 });
  expect(await wouldAskBeforeLeaving(page)).toBe(false);
  await page.reload();
  expect(prompts).toEqual(['beforeunload']);
  await expect(page.getByTestId('model-empty')).toBeAttached();
});

test('at 200% browser zoom the critical controls stay usable', async ({ browser }) => {
  // A 1440 × 900 window at 200 % zoom lays out as 720 × 450 CSS pixels.
  const context = await browser.newContext({
    viewport: { width: 720, height: 450 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto('/');
  await openBox(page);

  for (const id of ['repair', 'convert', 'split', 'texture'] as const) {
    await page.keyboard.press('Escape');
    await page.getByTestId('workspace-switcher').click();
    const menu = await page.locator('.workspace-switcher__menu').boundingBox();
    expect(menu === null ? Infinity : menu.y + menu.height).toBeLessThanOrEqual(450);
    await page.getByTestId(`workspace-option-${id}`).click();
    if ((await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open')
      await page.getByTestId('toggle-tool-drawer').click();
    const primary = page.getByTestId(
      {
        repair: 'preview-repair',
        convert: 'convert-export',
        split: 'split-preview',
        texture: 'texture-generate',
      }[id],
    );
    await primary.scrollIntoViewIfNeeded();
    const box = await primary.boundingBox();
    expect(box, id).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0), id).toBeLessThanOrEqual(450);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await context.close();
});
