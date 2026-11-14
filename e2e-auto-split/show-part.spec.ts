import { openInspector } from '../e2e/inspector';
import { binaryStl } from '../e2e/stl-fixtures';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { semanticFixture, toBinaryStl } from '@cadfixer/auto-split/fixtures';

/**
 * v0.7.1 — "SHOW PART" IN THE REAL APPLICATION.
 *
 * A recognized part can be looked at without a split candidate: the worker returns the faces its
 * outline was grounded to and the viewport highlights them. Nothing about it may touch the document,
 * the history or the camera, and nothing recognized for one model may survive onto the next.
 */
const service = 'http://127.0.0.1:8787';
const canvas = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-testid="viewport-canvas"] canvas');
const attr = async (page: Page, name: string): Promise<string> =>
  (await canvas(page).getAttribute(name)) ?? '';

async function exportHash(page: Page): Promise<string> {
  await openInspector(page);
  const download = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  const item = await download;
  const stream = await item.createReadStream();
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

test('Show part highlights a recognized part and changes nothing else; replacing the model clears it', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ 'x-real-ip': '10.111.7.1' });
  await page.request.post(`${service}/api/auto-split/__mock/reset`);
  await page.request.post(`${service}/api/auto-split/__mock/scenario`, {
    data: { scenario: 'semantic-chair' },
  });
  await page.goto('/');
  const f = semanticFixture('chair');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'chair.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from(toBinaryStl(f.mesh)),
  });
  await openInspector(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText('72');
  const documentBefore = await exportHash(page);

  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await page.getByTestId('auto-disclosure-continue').click();
  await page.getByTestId('auto-analyze').click();
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 90000 });
  // The count is of what was RECOGNIZED, not of what can be split.
  await expect(page.getByTestId('auto-results')).toContainText('Parts recognized');

  const showPart = page.getByTestId('auto-showpart-legs');
  await expect(showPart).toBeVisible();
  const before = {
    revision: await attr(page, 'data-model-revision'),
    fits: await attr(page, 'data-document-fit-count'),
    distance: await attr(page, 'data-camera-distance'),
    highlight: await attr(page, 'data-face-highlight-objects'),
  };
  expect(before.highlight).toBe('0');

  await showPart.click();
  await expect(canvas(page)).toHaveAttribute('data-face-highlight-objects', '1', {
    timeout: 60000,
  });
  // Display only: same revision, same fit count, the camera did not move, no Apply, no Undo.
  expect(await attr(page, 'data-model-revision')).toBe(before.revision);
  expect(await attr(page, 'data-document-fit-count')).toBe(before.fits);
  expect(await attr(page, 'data-camera-distance')).toBe(before.distance);
  await expect(page.getByTestId('split-undo')).not.toBeVisible();
  await expect(page.getByTestId('split-preview-label')).not.toBeVisible();

  // Hiding restores ordinary rendering.
  await showPart.click();
  await expect(canvas(page)).toHaveAttribute('data-face-highlight-objects', '0');
  expect(await exportHash(page)).toBe(documentBefore);

  // Show it again, then open ANOTHER model without a refresh: nothing recognized for the chair survives.
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await page.getByTestId('auto-showpart-legs').click();
  await expect(canvas(page)).toHaveAttribute('data-face-highlight-objects', '1', {
    timeout: 60000,
  });
  const fitsBeforeReplace = Number(await attr(page, 'data-document-fit-count'));
  const next = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await next
  ).setFiles({ name: 'other.stl', mimeType: 'model/stl', buffer: binaryStl(12).bytes });
  await expect(canvas(page)).toHaveAttribute(
    'data-document-fit-count',
    String(fitsBeforeReplace + 1),
    { timeout: 60000 },
  );
  await expect(canvas(page)).toHaveAttribute('data-face-highlight-objects', '0');
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await expect(page.getByTestId('auto-row-legs')).toHaveCount(0);
  await expect(page.getByTestId('auto-showpart-legs')).toHaveCount(0);
});
