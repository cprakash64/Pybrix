import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { safeDegenerateStl, tetrahedronStl } from './stl-fixtures';
import { openInspector } from './inspector';

async function open(page: Page, bytes: Buffer): Promise<void> {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name: 'local-model.stl', mimeType: 'model/stl', buffer: bytes });
}
async function digest(page: Page): Promise<string> {
  await openInspector(page);
  const download = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  const hash = createHash('sha256');
  for await (const bytes of await (await download).createReadStream()) hash.update(bytes as Buffer);
  const collapse = page.getByTestId('collapse-inspector');
  if (await collapse.isVisible()) await collapse.click();
  return hash.digest('hex');
}
test('one Repair model action improves the model; Undo restores the exact export', async ({
  page,
}) => {
  await open(page, safeDegenerateStl());
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  const before = await digest(page);
  await expect(page.getByTestId('issue-list')).toBeHidden();
  await expect(page.getByTestId('repair-operations')).toBeHidden();
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-intent')).toContainText('Repair complete');
  await expect(page.getByTestId('repair-continue')).toBeEnabled();
  await page.getByTestId('repair-intent-undo').click();
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  expect(await digest(page)).toBe(before);
});
test('Manual hides numerical controls; keyboard disclosure reveals them; Preview replaces setup', async ({
  page,
}) => {
  await open(page, tetrahedronStl());
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-position-slider')).toBeVisible();
  await expect(page.getByTestId('split-position-value')).toBeHidden();
  await expect(page.getByTestId('split-roll')).toBeHidden();
  await expect(page.getByTestId('split-unit-interpretation')).toHaveCount(0);
  const advanced = page.getByTestId('split-advanced').getByRole('button', { name: 'Advanced' });
  await advanced.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('split-position-value')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible();
  await expect(page.getByTestId('split-position-slider')).toBeHidden();
  await expect(page.getByTestId('split-apply')).toBeEnabled();
  await page.getByTestId('split-discard').click();
  await expect(page.getByTestId('split-position-slider')).toBeVisible();
});

test('successive cuts retain the qualified Preview, Apply and latest Undo behavior', async ({
  page,
}) => {
  await open(page, tetrahedronStl());
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-apply')).toBeEnabled();
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-undo')).toBeEnabled();
  const afterFirst = await digest(page);
  await page.getByTestId('split-again').click();
  await expect(page.getByTestId('split-preview')).toBeEnabled();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-apply')).toBeEnabled();
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-undo')).toBeEnabled();
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('split-undo')).toHaveCount(0);
  expect(await digest(page)).toBe(afterFirst);
});

test('200% text sizing keeps the primary action and disclosures usable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, safeDegenerateStl());
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  await page.evaluate(() => {
    const sized = [...document.querySelectorAll<HTMLElement>('body *')].map((element) => ({
      element,
      size: parseFloat(getComputedStyle(element).fontSize),
    }));
    for (const { element, size } of sized)
      if (Number.isFinite(size)) element.style.fontSize = `${String(size * 2)}px`;
  });
  const primary = page.getByTestId('preview-repair');
  await primary.scrollIntoViewIfNeeded();
  await expect(primary).toBeVisible();
  const box = await primary.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? Infinity) + (box?.height ?? Infinity)).toBeLessThanOrEqual(720);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  const details = page
    .getByTestId('repair-details')
    .getByRole('button', { name: 'Details', exact: true });
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('issue-list')).toBeVisible();
});
