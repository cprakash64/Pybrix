import { expect, test, type Locator, type Page } from '@playwright/test';
import { modelXml, threeMf } from './format-fixtures';
import { openInspector } from './inspector';

/**
 * UI-06: one model through all four workspaces in one session.
 *
 * Each workspace has its own suite; this one asks what none of them can — whether
 * the application is still ONE healthy application after visiting all four:
 * the same renderer, a camera nobody reset, no preview or tint left behind by
 * a workspace the user has left, nothing applied that was not applied, and no
 * console or page error on the way.
 *
 * The model is two disjoint millimetre boxes: a real Repair finding (two
 * separate components) on geometry that is still a valid solid, so the same
 * file can be split and textured.
 */

function box(
  min: readonly number[],
  max: readonly number[],
  base: number,
): {
  vertices: string;
  triangles: string;
} {
  const [x0 = 0, y0 = 0, z0 = 0] = min;
  const [x1 = 0, y1 = 0, z1 = 0] = max;
  const v = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x0, y1, z0],
    [x1, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x0, y1, z1],
    [x1, y1, z1],
  ];
  const t = [
    [0, 2, 3],
    [0, 3, 1],
    [4, 5, 7],
    [4, 7, 6],
    [0, 1, 5],
    [0, 5, 4],
    [2, 6, 7],
    [2, 7, 3],
    [0, 4, 6],
    [0, 6, 2],
    [1, 3, 7],
    [1, 7, 5],
  ];
  return {
    vertices: v
      .map(([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`)
      .join(''),
    triangles: t
      .map(
        ([a = 0, b = 0, c = 0]) =>
          `<triangle v1="${String(a + base)}" v2="${String(b + base)}" v3="${String(c + base)}"/>`,
      )
      .join(''),
  };
}

function twoBoxes(): Buffer {
  const a = box([5, 7, 10], [45, 27, 70], 0);
  const b = box([60, 7, 10], [70, 17, 20], 8);
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Two boxes"><mesh><vertices>${a.vertices}${b.vertices}</vertices><triangles>${a.triangles}${b.triangles}</triangles></mesh></object>`,
    }),
  );
}

const canvas = (page: Page): Locator => page.locator('[data-testid="viewport-canvas"] canvas');

/** The camera's orientation as the view cube shows it — written from the camera each frame. */
async function camera(page: Page): Promise<string> {
  return page
    .locator('.view-cube__body')
    .evaluate((element) => (element as HTMLElement).style.transform);
}

async function orbit(page: Page, dx: number): Promise<void> {
  const rect = await canvas(page).boundingBox();
  if (rect === null) throw new Error('no canvas');
  const x = rect.x + rect.width * 0.2;
  const y = rect.y + rect.height * 0.8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y - 20, { steps: 8 });
  await page.mouse.up();
}

test('one model through Repair, Convert, Split and Texture leaves one healthy application', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'two-boxes.3mf', mimeType: 'model/3mf', buffer: twoBoxes() });
  await expect(page.getByTestId('status-triangles')).toHaveText('24', { timeout: 60_000 });
  await canvas(page).evaluate((element) => {
    element.dataset.probe = 'original';
  });

  // A camera the user chose, which no workspace switch may take away.
  await orbit(page, 90);
  const chosen = await camera(page);
  expect(chosen).not.toBe('');

  // REPAIR: inspect a real finding. "Separate components" is known as a count
  // only, so the inspector describes it and the viewport HUD — which exists to
  // step through occurrences — rightly stays away (UI-02: nothing is invented).
  // It is the only kind of finding this model can carry: Split and Texture
  // refuse any part that is not a closed manifold solid, and every finding with
  // occurrences to step through makes it one. HUD stepping is covered by
  // repair-workspace.spec.ts.
  await page.getByTestId('workflow-repair').click();
  await expect(page.getByTestId('issue-count-components')).toHaveText('2', { timeout: 60_000 });
  const finding = page.getByTestId('issue-row-components');
  await finding.click();
  await expect(page.getByTestId('issue-inspector-name')).toHaveText('Separate components');
  await expect(page.getByTestId('issue-hud')).toHaveCount(0);

  // CONVERT: select a format, then return. Nothing is written.
  await page.getByTestId('workflow-convert').click();
  await openInspector(page);
  await expect(page.getByTestId('export-summary-destination')).toBeVisible();
  await page.getByTestId('convert-target-obj').check();
  await expect(page.getByTestId('convert-export')).toHaveText('Convert to OBJ');
  await page.getByTestId('workflow-repair').click();
  // The selection survived the round trip: a workspace switch changes neither
  // the document revision nor the active part, so it still describes the model
  // on screen. (A real geometry change retires it — the analysis key moves.)
  await expect(page.getByTestId('issue-inspector-name')).toHaveText('Separate components');
  await expect(finding).toHaveAttribute('aria-pressed', 'true');
  expect(await camera(page)).toBe(chosen);

  // SPLIT: configure, preview, discard.
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('issue-inspector-name')).toHaveCount(0);
  await page.getByTestId('split-position-value').fill('30');
  await expect(page.getByTestId('split-hud-cut')).toContainText('30');
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-banner')).toBeVisible({ timeout: 60_000 });
  await expect(canvas(page)).toHaveAttribute('data-tinted-parts', '2');
  await page.getByTestId('split-discard').click();
  await expect(page.getByTestId('split-preview-banner')).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute('data-tinted-parts', '0');
  await expect(page.getByTestId('status-triangles')).toHaveText('24');

  // TEXTURE: select a real surface, pick a pattern, preview, discard.
  await page.getByTestId('workflow-texture').click();
  // Nothing from Split followed the user here.
  await expect(page.getByTestId('split-hud')).toHaveCount(0);
  await expect(canvas(page)).toHaveAttribute('data-edit-plane', 'none');
  await page.getByTestId('fit-view').click();
  const rect = await canvas(page).boundingBox();
  if (rect === null) throw new Error('no canvas');
  await page.mouse.click(rect.x + rect.width / 2 - 40, rect.y + rect.height / 2 - 10);
  await expect(page.getByTestId('texture-hud-selection')).toContainText('Selected', {
    timeout: 30_000,
  });
  await page.getByTestId('texture-pattern-lines').check();
  await expect(page.getByTestId('texture-elements')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('texture-generate').click();
  await expect(page.getByTestId('texture-preview-banner')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('texture-discard').click();
  await expect(page.getByTestId('texture-preview-banner')).toHaveCount(0);
  await page.getByTestId('texture-clear').click();
  await expect(canvas(page)).toHaveAttribute('data-texture-selection-triangles', '0');

  // Back to Repair: no texture outline, no preview, the model unchanged, and
  // the finding still selected after visiting every other workspace.
  await page.getByTestId('workflow-repair').click();
  await expect(page.getByTestId('texture-hud')).toHaveCount(0);
  await expect(page.getByTestId('issue-inspector-name')).toHaveText('Separate components');
  await expect(canvas(page)).toHaveAttribute('data-texture-footprint-edges', '0');
  await expect(canvas(page)).toHaveAttribute('data-preview-objects', '0');
  await expect(page.getByTestId('status-triangles')).toHaveText('24');

  // The same renderer throughout, and it still answers the mouse.
  await expect(canvas(page)).toHaveAttribute('data-probe', 'original');
  const before = await camera(page);
  await orbit(page, -120);
  expect(await camera(page)).not.toBe(before);
  await expect(page.getByTestId('viewport-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
