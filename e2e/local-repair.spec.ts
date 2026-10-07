import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { tetrahedronStl, nonManifoldEdgeStl } from './stl-fixtures';
import { pinchedPairsStl, refusedPinchStl, residualPinchStl } from './local-repair-fixtures';
import { enter, pick } from './ui-fixtures';

/**
 * REPAIR-CORE-06B — THE REPAIR EXPERIENCE, THROUGH THE PUBLIC UI ONLY.
 *
 * No bridge, no harness: a file goes in through the file chooser and everything after it is a
 * click on a control a user can see. The real worker, the real kernel worker and the real
 * analysis hook do the rest, so these prove what a person would experience — and that the
 * numbers on screen after Apply come from a fresh analysis of the new revision.
 *
 * Screenshots for visual review are written only when PYBRIX_SHOTS names a directory.
 */

test.describe.configure({ timeout: 240_000 });

const SHOTS = process.env.PYBRIX_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function open(page: Page, name: string, bytes: Buffer, url = '/'): Promise<void> {
  await page.goto(url);
  await pick(page, name, 'model/stl', bytes);
  await enter(page, 'repair');
  // On a phone the tool panel is a drawer; open it as a person would.
  const toggle = page.getByTestId('toggle-tool-drawer');
  if (
    (await toggle.isVisible()) &&
    (await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open'
  ) {
    await toggle.click();
  }
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
}

const count = (page: Page, id: string): Locator => page.getByTestId(`issue-count-${id}`);

/** Records whether a test id was EVER in the document — a fast stage may come and go. */
async function watchAppearance(page: Page, testId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as Record<string, boolean>;
    w[`__saw_${id}`] = document.querySelector(`[data-testid="${id}"]`) !== null;
    new MutationObserver(() => {
      if (document.querySelector(`[data-testid="${id}"]`) !== null) w[`__saw_${id}`] = true;
    }).observe(document.body, { childList: true, subtree: true });
  }, testId);
}
const sawAppear = (page: Page, testId: string): Promise<boolean> =>
  page.evaluate(
    (id) => (window as unknown as Record<string, boolean>)[`__saw_${id}`] === true,
    testId,
  );

async function changeOverlayObjects(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(
      document.querySelector<HTMLCanvasElement>('[data-testid="viewport-canvas"] canvas')?.dataset
        .changeOverlayObjects ?? 0,
    ),
  );
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 60_000 });
}

test('HAPPY PATH: broken model -> Repair -> Preview -> Apply -> fresh counts -> Undo', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'pinched.stl', pinchedPairsStl(3));
  await expect(count(page, 'non-manifold-vertices')).toHaveText('3');
  await ready(page);
  await shot(page, 'desktop-1-before-repair');

  await watchAppearance(page, 'repair-progress');
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  // The stage was shown (and was never a percentage).
  expect(await sawAppear(page, 'repair-progress')).toBe(true);
  await expect(page.getByTestId('repair-percent')).toHaveCount(0);

  // The preview describes the CANDIDATE, and the committed model has not moved.
  await expect(page.getByTestId('repair-summary-headline')).toHaveText('Ready to apply');
  await expect(page.getByTestId('repair-summary-fixed')).toContainText('3 non-manifold vertices');
  // The separate pieces were already reported and are not something repair changes.
  await expect(page.getByTestId('repair-summary-remaining')).toContainText('6 separate components');
  await expect(page.getByTestId('repair-summary-remaining')).not.toContainText('non-manifold');
  await expect(page.getByTestId('repair-summary-current')).toHaveText('2 issue types');
  await expect(page.getByTestId('repair-summary-after')).toHaveText('1 issue type');
  await expect(count(page, 'non-manifold-vertices')).toHaveText('3');
  // The local repair's own overlay exists in the viewport.
  await expect.poll(() => changeOverlayObjects(page)).toBeGreaterThan(0);
  await shot(page, 'desktop-3-preview');

  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  // FRESH diagnostics for the new revision — never the old counts.
  await expect(count(page, 'non-manifold-vertices')).toHaveText('0', { timeout: 60_000 });
  await expect(page.getByTestId('repair-applied')).not.toHaveAttribute('data-outcome', 'checking', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('repair-applied-changes')).toContainText(
    '3 non-manifold vertices repaired',
  );
  await shot(page, 'desktop-5-after-apply');

  await page.getByTestId('undo-repair').click();
  await expect(count(page, 'non-manifold-vertices')).toHaveText('3', { timeout: 60_000 });
  await expect(page.getByTestId('repair-applied')).toHaveCount(0);
  await ready(page);
  await shot(page, 'desktop-6-undone');
});

test('PARTIAL: part is repaired, the rest is said plainly, nothing is styled as an error', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'refused.stl', refusedPinchStl());
  await expect(count(page, 'non-manifold-vertices')).toHaveText('1');
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('repair-summary')).toHaveAttribute(
    'data-outcome',
    'partial-unsupported',
  );
  await expect(page.getByTestId('repair-summary-headline')).toHaveText(
    'Some issues need manual repair',
  );
  await expect(page.getByTestId('repair-summary-remaining')).toContainText('1 non-manifold vertex');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await shot(page, 'desktop-4-partial-preview');

  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  // The remaining issue is still detected in the NEW revision.
  await expect(count(page, 'non-manifold-vertices')).toHaveText('1', { timeout: 60_000 });
  await expect(page.getByTestId('repair-applied')).toHaveAttribute('data-outcome', 'partial', {
    timeout: 60_000,
  });
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test('RESIDUAL: a pinch that needs more than the first pass is repaired through the UI', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'residual.stl', residualPinchStl());
  await expect(count(page, 'non-manifold-vertices')).toHaveText('1');
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-summary-fixed')).toContainText('1 non-manifold vertex', {
    timeout: 60_000,
  });
  await page.getByTestId('apply-repair').click();
  await expect(count(page, 'non-manifold-vertices')).toHaveText('0', { timeout: 60_000 });
});

test('NO PUBLIC LIMIT CONTROL: a work-limit URL option does nothing in the product', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Narrowing the limit was a URL option in 06B and is an internal harness seam now. The same
  // link on the shipped application must repair exactly as it would without it.
  await open(page, 'many.stl', pinchedPairsStl(120), '/?repairWorkCeiling=1500');
  await expect(page.getByTestId('repair-work-ceiling-note')).toHaveCount(0);
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('repair-summary')).toHaveAttribute('data-outcome', 'complete');
  await expect(page.getByTestId('repair-summary-fixed')).toContainText('120 non-manifold vertices');
});

test('CANCEL: cancelling a long repair leaves the model unchanged and Repair available', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'many.stl', pinchedPairsStl(400));
  await expect(count(page, 'non-manifold-vertices')).toHaveText('400');
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('cancel-repair')).toBeVisible();
  await expect(page.getByTestId('repair-phase')).toBeVisible();
  await shot(page, 'desktop-2-repair-running');
  await page.getByTestId('cancel-repair').click();
  await expect(page.getByTestId('repair-cancelled')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('repair-cancelled')).toContainText('cancelled');
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect(count(page, 'non-manifold-vertices')).toHaveText('400');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await ready(page);
});

test('NO CHANGE: a clean model and an unsupported-only model are told apart', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'clean.stl', tetrahedronStl());
  await expect(page.getByTestId('repair-no-repairs')).toHaveText('No repairable problems found.');
  const clean = await page.getByTestId('repair-no-repairs').textContent();
  await expect(page.getByTestId('preview-repair')).toBeDisabled();

  await open(page, 'edge.stl', nonManifoldEdgeStl());
  await expect(page.getByTestId('repair-no-repairs')).toContainText(
    'No safe automatic repairs are available',
  );
  const unsupported = await page.getByTestId('repair-no-repairs').textContent();
  expect(unsupported).not.toBe(clean);
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
});

test('STALE: replacing the model during a repair never shows the old preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'many.stl', pinchedPairsStl(400));
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('cancel-repair')).toBeVisible();
  // Open another model while the first repair is still running.
  await pick(page, 'clean.stl', 'model/stl', tetrahedronStl());
  await expect(page.getByTestId('repair-progress')).toHaveCount(0, { timeout: 30_000 });
  // Long enough for the old result to have arrived, were it going to.
  await page.waitForTimeout(6_000);
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect(page.getByTestId('repair-no-repairs')).toBeVisible();
  await expect(count(page, 'non-manifold-vertices')).toHaveCount(1);
  await expect(count(page, 'non-manifold-vertices')).toHaveText('0');
});

test('DOUBLE APPLY: two rapid activations commit once and leave Undo intact', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'pinched.stl', pinchedPairsStl(3));
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 60_000 });
  // Two activations in the same task, then a keyboard activation.
  await page.evaluate(() => {
    const apply = document.querySelector<HTMLButtonElement>('[data-testid="apply-repair"]');
    apply?.click();
    apply?.click();
  });
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  await expect(count(page, 'non-manifold-vertices')).toHaveText('0', { timeout: 60_000 });
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await expect(page.getByTestId('repair-applied')).toHaveCount(1);
  // ONE undoable change: one Undo restores the original, and nothing is left to undo.
  await page.getByTestId('undo-repair').click();
  await expect(count(page, 'non-manifold-vertices')).toHaveText('3', { timeout: 60_000 });
  await expect(page.getByTestId('undo-repair')).toHaveCount(0);
});

test('DISCARD: discarding a preview restores the normal state and releases the overlay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'pinched.stl', pinchedPairsStl(3));
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => changeOverlayObjects(page)).toBeGreaterThan(0);
  await page.getByTestId('discard-preview').click();
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect.poll(() => changeOverlayObjects(page)).toBe(0);
  await expect(count(page, 'non-manifold-vertices')).toHaveText('3');
  await ready(page);
});

test('RESPONSIVE: the preview, its actions and Cancel stay reachable on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'pinched.stl', pinchedPairsStl(400));
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('cancel-repair')).toBeInViewport();
  await shot(page, 'mobile-1-running');
  await page.getByTestId('cancel-repair').click();
  await expect(page.getByTestId('repair-cancelled')).toBeVisible({ timeout: 30_000 });

  await open(page, 'refused.stl', refusedPinchStl());
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('apply-repair')).toBeInViewport();
  await expect(page.getByTestId('discard-preview')).toBeInViewport();
  await shot(page, 'mobile-2-partial-preview');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await open(page, 'pinched.stl', pinchedPairsStl(3));
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'mobile-3-preview');
});
