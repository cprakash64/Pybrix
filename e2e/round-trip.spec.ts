import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { objMultiPart } from './format-fixtures';
import { binaryStl } from './stl-fixtures';
import { enter, gridBox, openDefects, watchErrors } from './ui-fixtures';
import { openInspector } from './inspector';

/**
 * PR-01: what CAD Fixer writes, CAD Fixer can read back — through the product.
 *
 * The writers already validate every artifact by parse-back inside the export
 * worker, and `format-conversion.spec.ts` checks artifacts against independent
 * oracles. This closes the user's loop instead: export from the Convert
 * workspace, open the downloaded file in the same application, and compare what
 * the product reports — triangles, parts, size, unit — including after Repair,
 * Split and Texture have changed the model.
 */

interface Facts {
  readonly triangles: string;
  readonly parts: number;
  readonly size: string;
  readonly unit: string;
}

const canvas = (page: Page): Locator => page.locator('[data-testid="viewport-canvas"] canvas');

async function open(page: Page, name: string, buffer: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.getByTestId('fact-filename')).toHaveText(name, { timeout: 60_000 });
}

async function facts(page: Page): Promise<Facts> {
  return {
    triangles: (await page.getByTestId('status-triangles').textContent()) ?? '',
    parts: await page.evaluate(
      () => Number(document.querySelector('[data-testid="fact-parts"]')?.textContent ?? '1') || 1,
    ),
    size: (await page.getByTestId('fact-size').textContent()) ?? '',
    unit: (await page.getByTestId('fact-units').textContent()) ?? '',
  };
}

/** Exports through Convert and returns the downloaded file's name and bytes. */
async function exportAs(
  page: Page,
  target: 'stl' | 'obj' | '3mf',
  unit?: string,
): Promise<{ name: string; bytes: Buffer }> {
  await enter(page, 'convert');
  await page.getByTestId(`convert-target-${target}`).check();
  if (unit !== undefined && (await page.getByTestId('convert-unit').count()) > 0)
    await page.getByTestId(`convert-unit-${unit}`).check();
  const pending = page.waitForEvent('download');
  await page.getByTestId('convert-export').click();
  const file = await pending;
  await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 60_000 });
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: readFileSync(path) };
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('STL, OBJ and 3MF each read back with the counts, parts, size and unit their format keeps', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');

  // A millimetre 3MF: every target keeps triangles and size; only 3MF keeps the unit.
  await open(page, 'grid.3mf', gridBox(6));
  const source = await facts(page);
  for (const target of ['stl', 'obj', '3mf'] as const) {
    await open(page, 'grid.3mf', gridBox(6));
    const written = await exportAs(page, target);
    expect(written.name).toBe(`grid.${target}`);
    await open(page, `back.${target}`, written.bytes);
    const back = await facts(page);
    expect(back.triangles, target).toBe(source.triangles);
    expect(back.size, target).toBe(source.size);
    expect(back.parts, target).toBe(1);
    if (target === '3mf') expect(back.unit).toBe(source.unit);
    else expect(back.unit, target).not.toBe(source.unit);
  }

  // A multi-part OBJ: OBJ and 3MF keep the parts; STL writes one object.
  const obj = objMultiPart(3);
  await open(page, 'parts.obj', obj.bytes);
  const multi = await facts(page);
  expect(multi.parts).toBe(3);
  for (const [target, parts] of [
    ['obj', 3],
    ['3mf', 3],
    ['stl', 1],
  ] as const) {
    await open(page, 'parts.obj', obj.bytes);
    const written = await exportAs(page, target, 'millimeter');
    await open(page, `parts-back.${target}`, written.bytes);
    const back = await facts(page);
    expect(back.triangles, target).toBe(multi.triangles);
    expect(back.parts, target).toBe(parts);
    expect(back.size, target).toBe(multi.size);
  }

  // A binary STL straight back to STL is the same geometry.
  await open(page, 'plain.stl', binaryStl(40).bytes);
  const plain = await facts(page);
  const stl = await exportAs(page, 'stl');
  await open(page, 'plain-back.stl', stl.bytes);
  expect(await facts(page)).toEqual({ ...plain });
  expect(errors).toEqual([]);
});

test('a repaired model exports as 3MF and reads back repaired', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openDefects(page);
  await page.getByTestId('issue-row-degenerate-faces').click();
  await openInspector(page);
  await page.getByTestId('issue-preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  const repaired = await facts(page);

  // An STL states no unit; 3MF needs one, asserted for this export only.
  const written = await exportAs(page, '3mf', 'millimeter');
  await open(page, 'repaired.3mf', written.bytes);
  const back = await facts(page);
  expect(back.triangles).toBe(repaired.triangles);
  expect(back.size).toBe(repaired.size);
  await enter(page, 'repair');
  await expect(page.getByTestId('issue-count-degenerate-faces')).toHaveText('0', {
    timeout: 60_000,
  });
  expect(errors).toEqual([]);
});

test('an applied split exports as a two-part 3MF and reads back as two parts', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await open(page, 'grid.3mf', gridBox(6));
  await enter(page, 'split');
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-banner')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-preview-banner')).toHaveCount(0, { timeout: 60_000 });
  const split = await facts(page);
  expect(split.parts).toBe(2);

  const written = await exportAs(page, '3mf');
  await open(page, 'split.3mf', written.bytes);
  const back = await facts(page);
  expect(back).toEqual({ ...split, unit: back.unit });
  expect(back.unit).toBe(split.unit);
  // Both pieces are closed solids: nothing open, nothing non-manifold.
  await enter(page, 'repair');
  await expect(page.getByTestId('issue-count-open-boundaries')).toHaveText('0', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('issue-count-non-manifold-edges')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('an applied texture exports as 3MF and reads back closed, with its triangles', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await open(page, 'grid.3mf', gridBox(6));
  await enter(page, 'texture');
  const box = await canvas(page).boundingBox();
  if (box === null) throw new Error('no canvas');
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 - 20);
  await expect(page.getByTestId('texture-elements')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('texture-generate').click();
  await expect(page.getByTestId('texture-preview-banner')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('texture-apply').click();
  await expect(page.getByTestId('texture-preview-banner')).toHaveCount(0, { timeout: 90_000 });
  const textured = await facts(page);
  expect(textured.triangles).not.toBe('432');

  const written = await exportAs(page, '3mf');
  await open(page, 'textured.3mf', written.bytes);
  const back = await facts(page);
  expect(back.triangles).toBe(textured.triangles);
  expect(back.parts).toBe(textured.parts);
  await enter(page, 'repair');
  await expect(page.getByTestId('issue-count-open-boundaries')).toHaveText('0', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('issue-count-non-manifold-edges')).toHaveText('0');
  expect(errors).toEqual([]);
});
