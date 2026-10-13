import { revealControl } from './progressive-disclosure';
import { expect, test } from '@playwright/test';
import { enter, inWindow, openBox, openDefects, selectFace, watchErrors } from './ui-fixtures';
import { openInspector } from './inspector';

/**
 * UI-06: the cross-workspace audit's fixes, each reproducing the defect it
 * closes. IDs refer to the UI-06 audit matrix (docs/design/UI_SHELL.md).
 *
 * Every model is a real file through the real picker; every measurement is a
 * layout fact from a real browser.
 */

test('I-01: the shell has no scroll position, so nothing can shift it sideways', async ({
  page,
}) => {
  // The inspector drawer waits off-canvas below 1200 px. With `overflow:
  // hidden` the shell was a scroll container with that drawer's width as its
  // range, and a scroll-into-view — here, the test runner's own click through
  // the workspace menu — moved the whole application 140 px to the left.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await openBox(page);
  await enter(page, 'convert');
  await expect(page.getByTestId('convert-workspace')).toBeVisible();

  const shift = await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('.app');
    if (app === null) throw new Error('no shell');
    const before = app.scrollLeft;
    app.scrollLeft = 300;
    document.querySelector<HTMLElement>('[data-testid="close-inspector"]')?.scrollIntoView();
    return { before, after: app.scrollLeft, overflow: getComputedStyle(app).overflowX };
  });
  expect(shift).toEqual({ before: 0, after: 0, overflow: 'clip' });
  const brand = await page.locator('.topbar__brand').boundingBox();
  expect(brand?.x).toBeGreaterThanOrEqual(0);
});

test('I-02: the inspector leads with the workspace’s context, in view without scrolling', async ({
  page,
}) => {
  // A short window: the case in which the context used to sit below the fold.
  await page.setViewportSize({ width: 1280, height: 650 });
  await page.goto('/');
  await openInspector(page);
  const titles = page.locator('#inspector .panel-section__title:visible');
  // With nothing loaded there is nothing to export, so that section is hidden.
  await expect(titles).toHaveText(['Selection', 'Model', 'Runtime']);

  await openDefects(page);
  await expect(titles).toHaveText(['Selection', 'Model', 'Export', 'Runtime']);
  await revealControl(page, page.getByTestId('issue-row-winding-conflicts'));
  await page.getByTestId('issue-row-winding-conflicts').click();
  const body = page.locator('.inspector__body');
  // No scroll was needed to reach it, and none happened.
  expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await inWindow(page, page.getByTestId('issue-inspector-name'))).toBe(true);
  expect(await inWindow(page, page.getByTestId('issue-preview-repair'))).toBe(true);

  // Every other workspace's context is likewise first, and no offset leaked.
  await openBox(page);
  // A new document starts with the Inspector collapsed again.
  await openInspector(page);
  for (const [id, probe] of [
    ['convert', 'export-summary-destination'],
    ['split', 'split-inspector-plane'],
  ] as const) {
    await enter(page, id);
    expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await inWindow(page, page.getByTestId(probe))).toBe(true);
  }
});

test('I-03: the top-bar pop-ups are disclosures, not ARIA menus', async ({ page }) => {
  // The compact workspace switcher exists only below the desktop tier
  // (UI-07A), so each trigger is exercised at a width that shows it.
  for (const [id, width] of [
    ['workspace-switcher', 768],
    ['help-menu', 1440],
    ['settings-menu', 1440],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const trigger = page.getByTestId(id);
    // No `aria-haspopup`: it promises role="menu" and arrow-key navigation,
    // and what opens is a list of buttons, a switch or text.
    await expect(trigger).not.toHaveAttribute('aria-haspopup');
    await expect(trigger).not.toHaveAttribute('aria-controls');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const controlled = await trigger.getAttribute('aria-controls');
    expect(controlled).not.toBeNull();
    await expect(page.locator(`[id="${controlled ?? ''}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  }
});

test('I-04: phone touch targets meet the tier’s 40 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openDefects(page);
  await page.getByTestId('toggle-tool-drawer').click();
  const clear = await page.getByTestId('clear-status').boundingBox();
  expect(clear?.height).toBeGreaterThanOrEqual(40);
  const row = await page
    .locator('.repair-option__label')
    .filter({ has: page.getByTestId('repair-op-toggle-unify-winding') })
    .boundingBox();
  expect(row?.height).toBeGreaterThanOrEqual(40);
});

test('I-05: the inspector’s route into Convert is not a second primary action', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openBox(page);
  await enter(page, 'convert');
  // The workspace's own export is the one filled Pybrix-blue button: the
  // accent fill, as the stylesheet defines it, and nothing else carries it.
  const accent = 'rgb(0, 77, 249)';
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  await expect(page.getByTestId('convert-export')).toHaveCSS('background-color', accent);
  await expect(page.getByTestId('open-convert')).not.toHaveCSS('background-color', accent);
});

test('I-06: every generated preview says "not applied" in one place, and the texture states are named', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openBox(page);

  // Split: the shared status pill, and the HUD no longer repeats it.
  await enter(page, 'split');
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
  const splitBanner = page.getByTestId('split-preview-banner');
  await expect(splitBanner).toHaveText('Split preview — not applied');
  await expect(splitBanner).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('split-hud')).not.toContainText('not applied');
  await page.getByTestId('split-discard').click();
  await expect(splitBanner).toHaveCount(0);

  // Texture: A (layout outlines), then B (generated geometry, banner).
  await enter(page, 'texture');
  await selectFace(page);
  await expect(page.getByTestId('texture-elements')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('texture-hud-detail')).toHaveText(
    'Layout outlines only — no geometry built',
  );
  await expect(page.getByTestId('texture-preview-banner')).toHaveCount(0);
  await page.getByTestId('texture-generate').click();
  await expect(page.getByTestId('texture-preview-banner')).toHaveText(
    'Texture preview — not applied',
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('texture-hud-detail')).toHaveText('Generated texture geometry');
  await expect(page.getByTestId('texture-hud')).not.toContainText('not applied');
  expect(errors).toEqual([]);
});

test('I-07: on a phone the HUD spans the viewport instead of half of it', async ({ page }) => {
  // At `left: 50%` the HUD's width resolved against half the canvas and the
  // selection summary wrapped onto three lines at 430 px.
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto('/');
  await openBox(page);
  await enter(page, 'texture');
  await page.keyboard.press('Escape');
  await selectFace(page);
  const hud = await page.getByTestId('texture-hud').boundingBox();
  expect(hud?.width).toBeGreaterThan(430 / 2 + 60);
  const summary = page.getByTestId('texture-hud-selection');
  // One line is 1.2–1.4 font sizes tall; the defect's three lines were ~4.
  const fontSize = await summary.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  const height = (await summary.boundingBox())?.height ?? 0;
  expect(height).toBeLessThan(fontSize * 2);
});

test('I-08: legacy and workspace secondary buttons are one control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openDefects(page);
  // The Repair workspace's secondary action: Cancel preview, beside Apply.
  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  const legacy = page.getByTestId('discard-preview');
  await expect(legacy).toBeVisible({ timeout: 60_000 });
  await openInspector(page);
  const inspector = page.getByTestId('open-convert');
  for (const property of ['border-radius', 'font-weight', 'background-color', 'border-top-color']) {
    const value = await legacy.evaluate(
      (element, name) => getComputedStyle(element).getPropertyValue(name),
      property,
    );
    await expect(inspector).toHaveCSS(property, value);
  }
  expect((await inspector.boundingBox())?.height).toBeGreaterThanOrEqual(32);
  // The shared focus ring, not a bare outline.
  await inspector.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(inspector).toBeFocused();
  await expect(inspector).not.toHaveCSS('box-shadow', 'none');
});

test('I-09: on a short window the activity log keeps to a few lines', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 650 });
  await page.goto('/');
  await openDefects(page);
  const footer = await page.locator('.tool-panel__footer').boundingBox();
  expect(footer?.height).toBeLessThanOrEqual(97);
});

test('I-10: the page names its icon and theme colour and asks the server for no favicon', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(new URL(request.url()).pathname));
  await page.goto('/');
  await expect(page.getByTestId('browse-button')).toBeVisible();
  // BRAND-01: a fingerprinted same-origin Pybrix PNG, no longer an inline SVG.
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    /^\/assets\/pybrix-favicon-32-[\w-]+\.png$/,
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#121b24');
  expect(requested).not.toContain('/favicon.ico');
});
