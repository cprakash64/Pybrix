import { expect, test, type Page } from '@playwright/test';
import { openAdvancedDiagnostics } from './repair-ui';
import { binaryStlFrom, type Point } from './stl-fixtures';
import { inWindow, pick } from './ui-fixtures';

/**
 * REPAIR-UX-01 — the Repair workspace answers "what's wrong, what can Pybrix
 * repair, what do I click" without scrolling through diagnostics.
 *
 * The fixture is SYNTHETIC and shaped like the model that exposed the problem:
 * one part above both the 250,000-face filling and self-intersection ceilings,
 * with open boundaries (one simple loop, several branched), non-manifold
 * vertices, many separate components, a winding disagreement the model's
 * topology blocks, and a few degenerate triangles conservative repair CAN
 * remove. No user file is needed.
 */

type Triangle = readonly [Point, Point, Point];

function largeDefectiveModel(side = 360): Buffer {
  const triangles: Triangle[] = [];
  // An open square sheet: one simple boundary loop, ~259,200 triangles.
  for (let i = 0; i < side; i += 1) {
    for (let j = 0; j < side; j += 1) {
      const a: Point = [i, j, 0];
      const b: Point = [i + 1, j, 0];
      const c: Point = [i + 1, j + 1, 0];
      const d: Point = [i, j + 1, 0];
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  // Bow-ties: two triangles meeting at one point. A non-manifold vertex, a
  // branched boundary and two components each.
  for (let k = 0; k < 12; k += 1) {
    const x = k * 5;
    triangles.push([
      [x, 0, 10],
      [x + 1, 0, 10],
      [x + 0.5, 1, 10],
    ]);
    triangles.push([
      [x + 1, 0, 10],
      [x + 2, 0, 10],
      [x + 1.5, -1, 10],
    ]);
  }
  // Collinear, zero-area triangles: removable by conservative repair.
  for (let k = 0; k < 3; k += 1) {
    triangles.push([
      [100 + k, 100, 5],
      [101 + k, 100, 5],
      [102 + k, 100, 5],
    ]);
  }
  return binaryStlFrom(triangles);
}

const MODEL = largeDefectiveModel();

async function openToolDrawerIfClosed(page: Page): Promise<void> {
  const toggle = page.getByTestId('toggle-tool-drawer');
  // Below 900 px the tool panel is a drawer; above it the toggle is hidden.
  if (!(await toggle.isVisible())) return;
  if ((await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open')
    await toggle.click();
  // Measured once the slide-in has finished.
  await expect
    .poll(async () => (await page.getByTestId('tool-panel').boundingBox())?.x ?? -1)
    .toBe(0);
}

async function importModel(page: Page): Promise<void> {
  await page.goto('/');
  await pick(page, 'Hitem3d-synthetic.stl', 'model/stl', MODEL);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 120_000 });
  // The plan is derived automatically from the report.
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 120_000 });
}

test.describe.configure({ timeout: 240_000 });

test('RUX01: the primary action and the main findings are in reach at every supported size', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await importModel(page);

  const sizes: readonly (readonly [number, number])[] = [
    [1920, 1080],
    [1440, 900],
    [1280, 800],
    [1024, 768],
    [1280, 640], // short-height desktop
    [768, 1024],
    [430, 932],
  ];
  for (const [width, height] of sizes) {
    await test.step(`${String(width)}×${String(height)}`, async () => {
      await page.setViewportSize({ width, height });
      await openToolDrawerIfClosed(page);
      const label = `${String(width)}×${String(height)}`;

      const primary = page.getByTestId('preview-repair');
      await expect(primary, label).toBeVisible();
      expect(await inWindow(page, primary), `${label}: primary action in the window`).toBe(true);
      await expect(page.getByTestId('health-summary'), label).toBeVisible();
      expect(await inWindow(page, page.getByTestId('health-summary')), label).toBe(true);
      await expect(page.getByTestId('issue-row-open-boundaries'), label).toBeVisible();

      // No horizontal page scroll at any width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);

      // An explanation opens inside the panel and inside the window.
      await page.getByTestId('issue-info-non-manifold-vertices').click();
      const panel = page.getByTestId('issue-info-panel-non-manifold-vertices');
      await expect(panel, label).toBeVisible();
      const box = await panel.boundingBox();
      expect(box, label).not.toBeNull();
      if (box !== null) expect(box.x + box.width, label).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
      await expect(panel, label).toBeHidden();

      // At the tall desktop sizes the whole answer fits without scrolling:
      // heading, summary, action and the main issue rows.
      if (width >= 1280 && height >= 800) {
        for (const id of ['open-boundaries', 'non-manifold-vertices', 'degenerate-faces']) {
          expect(
            await inWindow(page, page.getByTestId(`issue-row-${id}`)),
            `${label}: ${id} without scrolling`,
          ).toBe(true);
        }
      }
    });
  }
});

test('RUX02: the default view is concise; explanations and the full report are one deliberate click away', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await importModel(page);

  // Issue TYPES, not occurrences.
  await expect(page.getByTestId('health-summary')).toHaveText('1 error · 4 warnings');
  await expect(page.getByTestId('file-structure')).toHaveText('File structure valid');

  // Nothing long is on screen by default.
  for (const id of [
    'repair-exclusions',
    'hole-fill-limits',
    'health-topology',
    'component-table',
  ]) {
    await expect(page.getByTestId(id), id).toBeHidden();
  }
  const advancedToggle = page
    .getByTestId('advanced-diagnostics')
    .getByRole('button', { name: 'Advanced diagnostics', exact: true });
  await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');

  // ⓘ by keyboard: Enter opens, Escape closes and focus returns to the button.
  const info = page.getByTestId('issue-info-open-boundaries');
  await info.focus();
  await page.keyboard.press('Enter');
  await expect(info).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('issue-info-panel-open-boundaries')).toContainText(
    'What Pybrix can do',
  );
  await page.keyboard.press('Escape');
  await expect(info).toHaveAttribute('aria-expanded', 'false');
  await expect(info).toBeFocused();

  await openAdvancedDiagnostics(page);
  await expect(advancedToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('health-topology')).toBeVisible();
  await expect(page.getByTestId('topo-nonmanifold-vertices')).toHaveText('12');
  await expect(page.getByTestId('repair-exclusions')).toBeVisible();
});

test('RUX03: a large model is described honestly — limits stated, nothing implied', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await importModel(page);

  await expect(page.getByTestId('issue-count-self-intersections')).toHaveText('—');
  await expect(page.getByTestId('self-intersection-headline')).toHaveText(
    'Not checked — model exceeds automatic check size',
  );
  await expect(page.getByTestId('run-self-intersection')).toHaveCount(0);

  // REPAIR-CORE-02: part size no longer decides. The sheet's rim has 1,440
  // points (over the 512-point loop limit) and the bow-ties are branched, so
  // the worker admits nothing — and says so.
  await expect(page.getByTestId('issue-status-open-boundaries')).toHaveText(
    'Not automatically fillable',
    { timeout: 120_000 },
  );
  await expect(page.getByTestId('issue-detail-open-boundaries')).toContainText('complex');
  await expect(page.getByTestId('hole-fill-size-limit')).toBeVisible();
  // REPAIR-CORE-06B: pinched vertices are what the local repair attempts.
  await expect(page.getByTestId('issue-status-non-manifold-vertices')).toHaveText(
    /^(Repair available|Partly repairable)$/,
  );
  await expect(page.getByTestId('issue-status-components')).toContainText('Review recommended');
  await expect(page.getByTestId('issue-status-degenerate-faces')).toHaveText('Repair available');

  // The action covers what it covers, and says the rest needs attention.
  await expect(page.getByTestId('repair-scope')).toHaveText(
    /^2 repairable issue types of \d+ detected\. \d+ types will need other attention\.$/,
  );
  const workspace = (await page.getByTestId('repair-workspace').textContent()) ?? '';
  expect(workspace).not.toMatch(/\b(watertight|printable|fix all|fully repaired|perfect)\b/i);
});

test('RUX04: Repair model previews; Cancel discards; Apply commits; the result is truthful; Undo restores', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await importModel(page);
  const triangles = page.getByTestId('status-triangles');
  await expect(triangles).toHaveText('259,227');

  // Repair model builds a validated candidate — it does not commit.
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId('repair-preview-ready')).toBeVisible();
  await expect(triangles).toHaveText('259,227');

  // Cancel preview discards and returns the action.
  await page.getByTestId('discard-preview').click();
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  await expect(triangles).toHaveText('259,227');

  // Apply commits the validated candidate.
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 120_000 });
  await expect(triangles).toHaveText('259,224');
  await expect(page.getByTestId('repair-applied-changes')).toContainText(
    '3 degenerate triangles removed',
  );
  await expect(page.getByTestId('repair-applied-changes')).toContainText(
    'non-manifold vertices repaired',
  );
  // "Remaining" comes from the new revision's analysis, and it is not empty.
  await expect(page.getByTestId('repair-applied-remaining')).toContainText('open boundaries', {
    timeout: 120_000,
  });
  // The twelve pinched vertices were repaired, and the fresh analysis no longer lists them.
  await expect(page.getByTestId('repair-applied-remaining')).not.toContainText(
    'non-manifold vertices',
  );
  // With nothing safe left, the action stays where it is — disabled, with why.
  // REPAIR-UX-04: issues remain, so the outcome is PARTIAL and says so once.
  await expect(page.getByTestId('repair-applied-headline')).toHaveText('Partial repair completed');
  await expect(page.getByTestId('repair-applied-status')).toHaveText(
    /^Partial repair completed\. .* Some detected issues remain\.$/,
  );
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('repair-no-repairs')).toHaveText(
    'Everything Pybrix can safely repair automatically has been fixed.',
  );

  // Undo restores the prior document.
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
  await expect(triangles).toHaveText('259,227');
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 120_000 });
});
