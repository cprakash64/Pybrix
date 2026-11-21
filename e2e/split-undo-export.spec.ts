import { expect, test, type Page } from '@playwright/test';
import { boxModel } from './ui-fixtures';
import { binaryStlFrom, type Point } from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * EXPORT AFTER A SPLIT UNDO (RC2.1).
 *
 * After Split Apply and Undo the original part is back, but the workspace used to keep pointing at
 * Piece A, a part the restored document no longer holds. "Export active part as binary STL" then asked
 * the worker for a part that did not exist and produced no file (the activity log said
 * "That part is not in this version of the model"), and the Split workspace found nothing to cut.
 *
 * These specs run the whole sequence in the shipped application with the real worker and compare BYTES:
 * the export after Undo must be the export before the split, byte for byte, and the workspace must be
 * usable again. No provider and no Auto Split is involved.
 */

type Tri = readonly [Point, Point, Point];

/** A closed, outward cube as twelve triangles. */
function cube(x: number, y: number, z: number, s: number): Tri[] {
  const v: Point[] = [
    [x, y, z],
    [x + s, y, z],
    [x, y + s, z],
    [x + s, y + s, z],
    [x, y, z + s],
    [x + s, y, z + s],
    [x, y + s, z + s],
    [x + s, y + s, z + s],
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
  const at = (i: number | undefined): Point => {
    const point = i === undefined ? undefined : v[i];
    if (point === undefined) throw new Error('cube corner out of range');
    return point;
  };
  return t.map(([a, b, c]) => [at(a), at(b), at(c)]);
}

async function open(
  page: Page,
  name: string,
  mime: string,
  buffer: Buffer,
  triangles: number,
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: mime, buffer });
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 60_000,
  });
}

async function exportBinary(page: Page): Promise<Buffer> {
  const wait = page.waitForEvent('download', { timeout: 20_000 });
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  const chunks: Buffer[] = [];
  for await (const chunk of await (await wait).createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const facetCount = (stl: Buffer): number => stl.readUInt32LE(80);

async function splitApplyUndo(page: Page, triangles: number): Promise<void> {
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-undo')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('fact-triangles')).not.toHaveText(
    triangles.toLocaleString('en-US'),
  );
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 60_000,
  });
}

test('a closed cube: export, Split Apply, Undo, export gives the same file', async ({ page }) => {
  await page.goto('/');
  await open(page, 'cube.3mf', 'model/3mf', boxModel(), 12);

  // A. Export works before any split.
  const before = await exportBinary(page);
  expect(facetCount(before)).toBe(12);

  await splitApplyUndo(page, 12);

  // B. After Undo the SAME model is exported: same bytes, not a stale piece and not nothing.
  const after = await exportBinary(page);
  expect(facetCount(after)).toBe(12);
  expect(after.equals(before)).toBe(true);

  // And the workspace is usable again: Split names the part and can cut it a second time.
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-part')).toBeVisible();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
});

test('a model of two separate solids: Split Apply, Undo, export gives the same file, twice over', async ({
  page,
}) => {
  await page.goto('/');
  const triangles = [...cube(0, 0, 0, 20), ...cube(40, 0, 0, 20)];
  await open(page, 'two-cubes.stl', 'model/stl', binaryStlFrom(triangles), 24);

  const before = await exportBinary(page);
  expect(facetCount(before)).toBe(24);

  await splitApplyUndo(page, 24);
  const first = await exportBinary(page);
  expect(first.equals(before)).toBe(true);

  // A second round trip is no different: the restored model is exact, not merely similar.
  await splitApplyUndo(page, 24);
  const second = await exportBinary(page);
  expect(second.equals(before)).toBe(true);
});

test('export after Apply (before Undo) writes the selected piece, not the original', async ({
  page,
}) => {
  await page.goto('/');
  await open(page, 'cube.3mf', 'model/3mf', boxModel(), 12);
  const before = await exportBinary(page);
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-undo')).toBeVisible({ timeout: 60_000 });
  const piece = await exportBinary(page);
  // Piece A only: a different, smaller-or-equal file than the whole cube, and a valid one.
  expect(piece.equals(before)).toBe(false);
  expect(facetCount(piece)).toBeGreaterThan(0);
  expect(piece.byteLength).toBe(84 + facetCount(piece) * 50);
});
