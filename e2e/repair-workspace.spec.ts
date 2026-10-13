import { revealControl } from './progressive-disclosure';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { binaryStlFrom, type Point } from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * UI-02: the Repair workspace.
 *
 * The fixtures are real STL files built at test time and imported through the
 * file picker, so every count asserted here comes from the engine. Where a test
 * compares surfaces, it compares them with EACH OTHER — the list, the viewport
 * HUD and the inspector must agree — rather than with a number written here.
 */

type Triangle = readonly [Point, Point, Point];

/** A 20 mm box with its top face missing: one planar open boundary. */
function openBox(): Triangle[] {
  const s = 20;
  const v = (x: number, y: number, z: number): Point => [x * s, y * s, z * s];
  return [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0)],
    [v(0, 0, 0), v(1, 1, 0), v(1, 0, 0)],
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1)],
    [v(0, 0, 0), v(1, 0, 1), v(0, 0, 1)],
    [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1)],
    [v(0, 1, 0), v(1, 1, 1), v(1, 1, 0)],
    [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(0, 1, 1), v(0, 1, 0)],
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1)],
    [v(1, 0, 0), v(1, 1, 1), v(1, 0, 1)],
  ];
}

/** The open box with one side triangle reversed, plus a stray zero-area triangle. */
function defects(): Triangle[] {
  const triangles = openBox();
  const flipped = triangles[8];
  if (flipped === undefined) throw new Error('fixture');
  triangles[8] = [flipped[0], flipped[2], flipped[1]];
  triangles.push([
    [40, 0, 0],
    [45, 0, 0],
    [50, 0, 0],
  ]);
  return triangles;
}

async function openModel(page: Page, name: string, triangles: Triangle[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: 'model/stl',
    buffer: binaryStlFrom(triangles),
  });
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
}

const row = (page: Page, id: string): Locator => page.getByTestId(`issue-row-${id}`);

async function positions(page: Page): Promise<{ list: string; hud: string; inspector: string }> {
  return {
    list: ((await page.getByTestId('occurrence-position').textContent()) ?? '').replace(
      /^\s*·\s*/,
      '',
    ),
    hud: (await page.getByTestId('issue-hud-position').textContent()) ?? '',
    inspector: (await page.getByTestId('issue-inspector-position').textContent()) ?? '',
  };
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('A: the overview lists every real check, with counts and a health summary', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto('/');
  // With no model the primary action is already in its place, disabled.
  await expect(page.getByTestId('preview-repair')).toBeDisabled();

  await openModel(page, 'defects.stl', defects());

  for (const id of [
    'open-boundaries',
    'non-manifold-edges',
    'non-manifold-vertices',
    'winding-conflicts',
    'self-intersections',
    'degenerate-faces',
    'duplicate-faces',
    'components',
  ]) {
    await expect(row(page, id)).toBeVisible();
  }
  // Findings the fixture really has.
  await expect(row(page, 'winding-conflicts')).toHaveAttribute('data-severity', 'warning');
  await expect(row(page, 'degenerate-faces')).toHaveAttribute('data-severity', 'warning');
  await expect(row(page, 'open-boundaries')).toHaveAttribute('data-severity', 'warning');
  await expect(row(page, 'duplicate-faces')).toHaveAttribute('data-severity', 'ok');
  await expect(page.getByTestId('issue-count-components')).toHaveText('2');

  // The summary counts categories and is the status bar's too.
  const summary = page.getByTestId('health-summary');
  await expect(summary).toHaveText(/^\d+ errors? · \d+ warnings?$/);
  await expect(page.getByTestId('status-health')).toHaveText('Model details');
  // No row for checks CAD Fixer does not run.
  await expect(page.getByTestId('issue-list')).not.toContainText(/thin wall|gap/i);
  expect(problems).toEqual([]);
});

test('B, C: selecting an issue synchronizes the list, the HUD and the inspector', async ({
  page,
}) => {
  await page.goto('/');
  await openModel(page, 'defects.stl', defects());

  await row(page, 'winding-conflicts').click();
  await expect(row(page, 'winding-conflicts')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('issue-inspector-name')).toHaveText('Winding conflicts');
  await expect(page.getByTestId('issue-hud')).toBeVisible();
  await expect(page.getByTestId('issue-hud')).toContainText('Winding conflicts');

  const first = await positions(page);
  expect(first.list).toMatch(/^1 \/ \d+$/);
  expect(first.hud).toBe(first.list);
  expect(first.inspector).toBe(first.list);
  const total = Number(first.list.split('/')[1]);
  expect(total).toBeGreaterThan(1);

  // Next from the HUD moves every surface; previous from the list moves them back.
  await page.getByTestId('issue-hud-next').click();
  await expect(page.getByTestId('issue-hud-position')).toHaveText(`2 / ${String(total)}`);
  const second = await positions(page);
  expect(second.list).toBe(second.hud);
  expect(second.inspector).toBe(second.hud);
  await expect(page.getByTestId('issue-inspector-coordinates')).toHaveText(/^X .+ Y .+ Z .+$/);

  await revealControl(page, page.getByTestId('occurrence-previous'));
  await page.getByTestId('occurrence-previous').click();
  await expect(page.getByTestId('issue-hud-position')).toHaveText(`1 / ${String(total)}`);
  // Wraps backwards from the first.
  await revealControl(page, page.getByTestId('occurrence-previous'));
  await page.getByTestId('occurrence-previous').click();
  await expect(page.getByTestId('issue-hud-position')).toHaveText(
    `${String(total)} / ${String(total)}`,
  );

  // Dismiss clears the selection everywhere and deletes nothing.
  await openInspector(page);
  await revealControl(page, page.getByTestId('issue-dismiss'));
  await page.getByTestId('issue-dismiss').click();
  await expect(page.getByTestId('issue-hud')).toHaveCount(0);
  await openInspector(page);
  await expect(page.getByTestId('issue-inspector-empty')).toBeVisible();
  await expect(row(page, 'winding-conflicts')).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, 'winding-conflicts')).toHaveAttribute('data-severity', 'warning');
});

test('D: Zoom to issue reframes the same renderer', async ({ page }) => {
  await page.goto('/');
  await openModel(page, 'defects.stl', defects());
  const canvas = page.getByTestId('viewport-canvas').locator('canvas');
  await canvas.evaluate((element) => {
    element.dataset.zoomProbe = 'original';
  });

  await row(page, 'degenerate-faces').click();
  await expect(page.getByTestId('issue-hud-zoom')).toBeEnabled();
  const before = await canvas.screenshot();
  await page.getByTestId('issue-hud-zoom').click();
  await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);

  await expect(canvas).toHaveAttribute('data-zoom-probe', 'original');
  await expect(page.getByTestId('viewport-error')).toHaveCount(0);
});

test('E: Fix this previews a real whole-part repair, and the findings are re-derived', async ({
  page,
}) => {
  await page.goto('/');
  await openModel(page, 'defects.stl', defects());
  await expect(row(page, 'degenerate-faces')).toHaveAttribute('data-severity', 'warning');

  await row(page, 'degenerate-faces').click();
  await expect(page.getByTestId('issue-suggested-fix')).toContainText('whole part');
  await openInspector(page);
  await revealControl(page, page.getByTestId('issue-preview-repair'));
  await page.getByTestId('issue-preview-repair').click();
  // The conservative repair builds and validates a candidate; nothing is applied yet.
  await expect(page.getByTestId('apply-repair')).toBeVisible({ timeout: 60_000 });
  await expect(row(page, 'degenerate-faces')).toHaveAttribute('data-severity', 'warning');

  await page.getByTestId('apply-repair').click();
  await revealControl(page, page.getByTestId('repair-applied'));
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  // Re-analysed at the new revision: the category is now clean, and the
  // selection made against the old revision has gone stale.
  await expect(row(page, 'degenerate-faces')).toHaveAttribute('data-severity', 'ok', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('issue-count-degenerate-faces')).toHaveText('0');
  await openInspector(page);
  await expect(page.getByTestId('issue-inspector-empty')).toBeVisible();
  // Winding conflicts were not selected for this repair, and remain.
  await expect(row(page, 'winding-conflicts')).toHaveAttribute('data-severity', 'warning');
});

test('E: Fix this fills ONE open boundary through the validated fill workflow', async ({
  page,
}) => {
  await page.goto('/');
  await openModel(page, 'open-box.stl', openBox());
  await expect(page.getByTestId('issue-count-open-boundaries')).toHaveText('1');

  await row(page, 'open-boundaries').click();
  await expect(page.getByTestId('issue-hud-position')).toHaveText('1 / 1');
  await expect(page.getByTestId('issue-hud-next')).toBeDisabled();
  await openInspector(page);
  await revealControl(page, page.getByTestId('issue-preview-fill'));
  await page.getByTestId('issue-preview-fill').click();
  await openInspector(page);
  await revealControl(page, page.getByTestId('issue-apply-fill'));
  await expect(page.getByTestId('issue-apply-fill')).toBeVisible({ timeout: 60_000 });
  await openInspector(page);
  await revealControl(page, page.getByTestId('issue-apply-fill'));
  await page.getByTestId('issue-apply-fill').click();

  await expect(page.getByTestId('issue-count-open-boundaries')).toHaveText('0', {
    timeout: 60_000,
  });
  await expect(row(page, 'open-boundaries')).toHaveAttribute('data-severity', 'ok');
});

test('F: the Repair workspace works in the drawer, with focus trapped and no overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'defects.stl',
    mimeType: 'model/stl',
    buffer: binaryStlFrom(defects()),
  });
  await expect(page.getByTestId('status-health')).toHaveText('Model details', { timeout: 60_000 });

  await page.getByTestId('toggle-tool-drawer').click();
  const drawer = page.getByTestId('tool-panel');
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await revealControl(page, row(page, 'winding-conflicts'));
  await row(page, 'winding-conflicts').focus();
  await page.keyboard.press('Enter');
  await expect(row(page, 'winding-conflicts')).toHaveAttribute('aria-pressed', 'true');
  expect(await drawer.evaluate((root) => root.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId('issue-hud')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
});
