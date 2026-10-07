import { expect, test, type Page } from '@playwright/test';
import { objDefectAndClean, objMultiPart, threeMfSharedPlacements } from './format-fixtures';
import { openInspector } from './inspector';

/**
 * THE MULTI-PART WORKFLOW ON A REAL FILE.
 *
 * Stage 4A-2A proved these properties in a harness, because the shipped
 * application could only read STL and an STL is always one part — there was no
 * way to get a multi-part document in front of the real UI. That is no longer
 * true. Everything below happens the way a user would do it: an OBJ or a 3MF
 * arrives through the file chooser, the production worker parses it, and the
 * production panels describe it.
 *
 * The harness suite stays: it can construct documents no file format can
 * express, and it measures at a thousand placements. This suite answers a
 * narrower and more important question — that the path from a file on disk to
 * the screen is the same path those proofs described.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

interface SceneStats {
  readonly drawCalls: number;
  readonly modelObjects: number;
  readonly sharedGeometries: number;
  readonly geometriesCreated: number;
  readonly geometriesDisposed: number;
  readonly partTransforms: string;
}

async function readScene(page: Page): Promise<SceneStats> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    const read = (key: string): number => Number(canvas?.dataset[key] ?? 0);
    return {
      drawCalls: read('drawCalls'),
      modelObjects: read('modelObjects'),
      sharedGeometries: read('sharedGeometries'),
      geometriesCreated: read('geometriesCreated'),
      geometriesDisposed: read('geometriesDisposed'),
      partTransforms: canvas?.dataset.partTransforms ?? '',
    };
  });
}

function translationOf(stats: SceneStats, partId: string): readonly number[] {
  for (const entry of stats.partTransforms.split('|')) {
    const [id, values] = entry.split(':');
    if (id === partId && values !== undefined) return values.split(',').map(Number);
  }
  throw new Error(`no placement for ${partId} in "${stats.partTransforms}"`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

/* ------------------------------------------------- rendering and placement -- */

test('every part of an imported OBJ is drawn, in its own place', async ({ page }) => {
  await openFile(page, 'assembly.obj', objMultiPart(4).bytes);

  await expect(page.getByTestId('fact-parts')).toHaveText('4', { timeout: 30_000 });
  await expect(page.getByTestId('fact-triangles')).toHaveText('16');

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(4);
  expect(scene.drawCalls).toBeGreaterThanOrEqual(4);

  /*
   * OBJ carries no placement, so every part sits at the identity and the
   * separation lives in the COORDINATES. The published matrices are world
   * matrices, which include the viewport's display-centring offset — so the
   * assertion is that all four resolve to the SAME placement, not that each is
   * the identity. A transform invented for one part would break this.
   */
  const first = translationOf(scene, 'part-1');
  for (const partId of ['part-2', 'part-3', 'part-4']) {
    expect(translationOf(scene, partId)).toEqual(first);
  }
  // 3 gaps of 40 plus the last tetrahedron's own 10.
  await expect(page.getByTestId('fact-size')).toContainText('130');
});

test('a repeated 3MF object is uploaded once and drawn many times', async ({ page }) => {
  await openFile(page, 'repeated.3mf', threeMfSharedPlacements(64));

  await expect(page.getByTestId('fact-parts')).toHaveText('64', { timeout: 30_000 });

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(64);
  // ONE geometry for sixty-four parts. The reference count is what keeps it
  // alive while any of them is drawing from it.
  expect(scene.sharedGeometries).toBe(1);
  expect(scene.geometriesCreated - scene.geometriesDisposed).toBe(1);

  /*
   * And each placement is where the file put it. Compared as a DIFFERENCE,
   * because the published matrix is a world matrix and carries the viewport's
   * centring offset — which is common to every part and therefore cancels.
   */
  const spread =
    (translationOf(scene, 'part-64')[0] ?? 0) - (translationOf(scene, 'part-1')[0] ?? 0);
  expect(spread).toBeCloseTo(63 * 20, 3);
});

test('MF-P24: a thousand real placements share one geometry, within document limits', async ({
  page,
}) => {
  test.setTimeout(180_000);

  /*
   * THE HARNESS ALREADY PROVES THIS AT A THOUSAND PLACEMENTS — with a document
   * it constructs directly. What it cannot prove is that a real 3MF, read by
   * the production reader and carried across the worker boundary by
   * `postMessage`, still arrives as ONE mesh a thousand parts point at.
   *
   * Structured clone preserves shared references within a single message. If it
   * did not, or if the reader materialised a mesh per build item, this would be
   * a thousand uploads instead of one — and nothing in a unit test would show
   * it, because the sharing would still be correct on the worker's side.
   */
  await openFile(page, 'thousand.3mf', threeMfSharedPlacements(1000));

  await expect(page.getByTestId('fact-parts')).toHaveText('1,000', { timeout: 120_000 });

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(1000);
  expect(scene.sharedGeometries).toBe(1);
  expect(scene.geometriesCreated - scene.geometriesDisposed).toBe(1);

  // AND THE INTERFACE IS STILL USABLE. A thousand parts is metadata, not a
  // thousand meshes: the selector renders and a part can still be chosen.
  await openInspector(page);
  await expect(page.getByTestId('part-option-part-1000')).toBeVisible();
  await openInspector(page);
  await page.getByTestId('part-option-part-500').click();
  await expect(page.getByTestId('part-option-part-500')).toHaveAttribute('aria-pressed', 'true');
  // Selecting is not a model change, so no geometry moved.
  const after = await readScene(page);
  expect(after.geometriesCreated).toBe(scene.geometriesCreated);
  expect(after.geometriesDisposed).toBe(scene.geometriesDisposed);
});

test('loading a second document frees the first document’s geometry', async ({ page }) => {
  await openFile(page, 'repeated.3mf', threeMfSharedPlacements(16));
  await expect(page.getByTestId('fact-parts')).toHaveText('16', { timeout: 30_000 });
  const first = await readScene(page);
  expect(first.geometriesCreated - first.geometriesDisposed).toBe(1);

  await openFile(page, 'assembly.obj', objMultiPart(3).bytes);
  await expect(page.getByTestId('fact-parts')).toHaveText('3', { timeout: 30_000 });

  const second = await readScene(page);
  // THE OLD ONE WENT. Three live geometries, not four, and the disposal count
  // moved — a shared geometry that outlived its document is a leak that grows
  // with every file the user opens.
  expect(second.geometriesCreated - second.geometriesDisposed).toBe(3);
  expect(second.geometriesDisposed).toBeGreaterThan(first.geometriesDisposed);
  expect(second.modelObjects).toBe(3);
});

/* ----------------------------------------------- selection and attribution -- */

test('Mesh Health and the repair panel describe the part the user selected', async ({ page }) => {
  await openFile(page, 'mixed.obj', objDefectAndClean().bytes);

  await openInspector(page);
  await expect(page.getByTestId('part-selector')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('fact-parts')).toHaveText('2');
  // The document total, in the panel that describes the document.
  await expect(page.getByTestId('fact-triangles')).toHaveText('9');

  // Part 1 is the defective tetrahedron: five faces, one of them a duplicate.
  await expect(page.getByTestId('health-part-scope')).toContainText('Defective');
  await expect(page.getByTestId('repair-part-scope')).toContainText('Defective');
  await expect(page.getByTestId('health-triangles')).toHaveText('5', { timeout: 30_000 });
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });

  await openInspector(page);
  await page.getByTestId('part-option-part-2').click();

  // Every scoped surface follows, and the counts genuinely differ.
  await expect(page.getByTestId('health-part-scope')).toContainText('Clean');
  await expect(page.getByTestId('repair-part-scope')).toContainText('Clean');
  await expect(page.getByTestId('health-triangles')).toHaveText('4', { timeout: 30_000 });
  // The document did not change because a selection did.
  await expect(page.getByTestId('fact-triangles')).toHaveText('9');
  await expect(page.getByTestId('fact-parts')).toHaveText('2');
});

test('switching parts repeatedly creates and disposes no geometry', async ({ page }) => {
  await openFile(page, 'mixed.obj', objDefectAndClean().bytes);
  await openInspector(page);
  await expect(page.getByTestId('part-selector')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  const before = await readScene(page);

  for (const partId of ['part-2', 'part-1', 'part-2', 'part-1']) {
    await page.getByTestId(`part-option-${partId}`).click();
    await expect(page.getByTestId(`part-option-${partId}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  }

  const after = await readScene(page);
  expect(after.geometriesCreated).toBe(before.geometriesCreated);
  expect(after.geometriesDisposed).toBe(before.geometriesDisposed);
  expect(after.modelObjects).toBe(2);
});

/* --------------------------------------------------- repairing ONE part -- */

test('a repair changes the selected part and leaves the other one alone', async ({ page }) => {
  test.setTimeout(180_000);
  await openFile(page, 'mixed.obj', objDefectAndClean().bytes);

  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('repair-part-scope')).toContainText('Defective');

  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  // A preview is not an application: nothing has been committed yet.
  await expect(page.getByTestId('fact-triangles')).toHaveText('9');

  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });

  // THE DUPLICATE IS GONE FROM PART 1 ONLY: 5 - 1 = 4, and the document 9 - 1 = 8.
  await expect(page.getByTestId('health-triangles')).toHaveText('4', { timeout: 60_000 });
  await expect(page.getByTestId('fact-triangles')).toHaveText('8');
  await expect(page.getByTestId('fact-parts')).toHaveText('2');

  await openInspector(page);
  await page.getByTestId('part-option-part-2').click();
  // Part 2 was never touched.
  await expect(page.getByTestId('health-triangles')).toHaveText('4', { timeout: 60_000 });
  expect((await readScene(page)).modelObjects).toBe(2);
});

test('undo restores the repaired part without disturbing the other', async ({ page }) => {
  test.setTimeout(180_000);
  await openFile(page, 'mixed.obj', objDefectAndClean().bytes);

  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('fact-triangles')).toHaveText('8', { timeout: 60_000 });

  await page.getByTestId('undo-repair').click();

  // Back to nine, with both parts still present and still drawn.
  await expect(page.getByTestId('fact-triangles')).toHaveText('9', { timeout: 60_000 });
  await expect(page.getByTestId('health-triangles')).toHaveText('5', { timeout: 60_000 });
  await expect(page.getByTestId('fact-parts')).toHaveText('2');
  expect((await readScene(page)).modelObjects).toBe(2);
  // One undo only. Redo does not exist and must not appear.
  await expect(page.getByTestId('undo-repair')).toHaveCount(0);
});

/* ------------------------------------------------------------ size policy -- */

test('the single-part export states, before the click, what it leaves out', async ({ page }) => {
  await openFile(page, 'assembly.obj', objMultiPart(3).bytes);
  await expect(page.getByTestId('fact-parts')).toHaveText('3', { timeout: 30_000 });

  await openInspector(page);
  const note = page.getByTestId('export-part-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('The other 2 parts are not included');
  // And it points at the control that DOES write the whole document.
  await expect(note).toContainText('Export / Convert');
  // The format note, because an OBJ was read and an STL will be written.
  await expect(page.getByTestId('export-format-note')).toContainText('read from OBJ');

  /*
   * THE TWO EXPORTS ARE NAMED APART. Stage 4A-2B3 added a whole-document
   * conversion beside this one, and two controls both called "Export STL" —
   * one writing three parts and one writing a third of them — would be exactly
   * the silent loss the workflow exists to remove.
   */
  await expect(page.getByTestId('export-binary')).toHaveText('Export active part as binary STL');
  await expect(page.getByTestId('open-convert')).toHaveText('Export / Convert…');
  await expect(page.getByTestId('workflow-convert')).toBeEnabled();
});

test('a 3MF that states a unit says so, and says STL will not carry it', async ({ page }) => {
  await openFile(page, 'repeated.3mf', threeMfSharedPlacements(2));
  await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });

  await expect(page.getByTestId('fact-units')).toHaveText('millimeter');
  await expect(page.getByTestId('export-format-note')).toContainText(
    "the source's stated unit (millimeter) is not written into the file",
  );
});
