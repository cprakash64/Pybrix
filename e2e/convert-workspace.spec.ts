import { expect, test, type Download, type Page } from '@playwright/test';
import { binaryStlFrom, type Point } from './stl-fixtures';
import { readObjArtifact, readStlArtifact, readThreeMfArtifact } from './artifact-oracles';

/**
 * UI-03: the Convert workspace.
 *
 * Every fixture is a real file imported through the file picker and every
 * download is a real browser download whose bytes are read back here, so what
 * is asserted is what lands on a user's disk. Format POLICY is proven in
 * `format-conversion.spec.ts` and `compatibility.test.ts`; this suite proves
 * the workspace around it — what it shows, what it lets a user do, and that it
 * leaves the model and the viewport alone.
 */

type Triangle = readonly [Point, Point, Point];

/**
 * An ASYMMETRIC solid: a tetrahedron with every coordinate distinct on every
 * axis, off the origin. A swapped axis, a mirrored one, a rescale or a
 * recentre all change at least one number here, so an accidental transform
 * cannot pass as a no-op.
 */
const A: Point = [3, 1, 2];
const B: Point = [17, 4, 5];
const C: Point = [6, 13, 7];
const D: Point = [8, 5, 23];
const ASYMMETRIC: Triangle[] = [
  [A, C, B],
  [A, B, D],
  [B, C, D],
  [C, A, D],
];
const CORNERS: readonly Point[] = [A, B, C, D];

async function openModel(page: Page, name: string, triangles: Triangle[]): Promise<Buffer> {
  const buffer = binaryStlFrom(triangles);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer });
  // The FILE NAME, not only the triangle count: a second model with the same
  // count would satisfy the count before it replaced the first one, and the
  // assertions after it would then run against the previous model.
  await expect(page.getByTestId('fact-filename')).toHaveText(name, { timeout: 60_000 });
  await expect(page.getByTestId('fact-triangles')).toHaveText(String(triangles.length), {
    timeout: 60_000,
  });
  return buffer;
}

async function enterConvert(page: Page): Promise<void> {
  await page.getByTestId('workflow-convert').click();
  await expect(page.getByTestId('convert-workspace')).toBeVisible();
}

async function bytesOf(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function convertAndCapture(page: Page): Promise<{ download: Download; bytes: Buffer }> {
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId('convert-export').click();
  const download = await pending;
  await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 60_000 });
  return { download, bytes: await bytesOf(download) };
}

/** Sorted distinct points, so file order does not matter to a comparison. */
function distinct(points: readonly (readonly number[])[]): string[] {
  return [...new Set(points.map((point) => point.join(',')))].sort();
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('A: the overview shows the real source and only formats CAD Fixer writes', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  const source = await openModel(page, 'bracket.stl', ASYMMETRIC);
  await enterConvert(page);

  // The source card is the import's own facts.
  await expect(page.getByTestId('convert-source')).toHaveText('bracket.stl');
  const meta = page.getByTestId('convert-source-meta');
  await expect(meta).toContainText('STL · Binary');
  await expect(meta).toContainText(`${String(source.byteLength)} B`);
  await expect(meta).toContainText('4 triangles');
  await expect(page.getByTestId('convert-source-parts')).toHaveText('1 part');
  await expect(page.getByTestId('convert-source-unit')).toHaveText('No unit stated');
  await expect(page.getByTestId('convert-source-section')).not.toContainText(/no colou?rs/i);

  // Every enabled card is a writer; ASCII STL is shown as unavailable HERE.
  const outputs = page.getByRole('radiogroup', { name: 'Output format' });
  await expect(outputs.getByRole('radio')).toHaveCount(4);
  for (const target of ['stl', 'obj', '3mf']) {
    await expect(page.getByTestId(`convert-target-${target}`)).toBeEnabled();
  }
  await expect(page.getByTestId('convert-target-stl-ascii')).toBeDisabled();
  await expect(outputs).not.toContainText(/PLY|AMF|GLB|FBX/);

  // The source format is preselected, and nothing has been written.
  await expect(page.getByTestId('convert-target-stl')).toBeChecked();
  await expect(page.getByTestId('convert-progress')).toHaveCount(0);

  // The size card: the real source length, and binary STL's exact size.
  await expect(page.getByTestId('output-size-source')).toContainText(
    `${String(source.byteLength)} B`,
  );
  await expect(page.getByTestId('output-size-target')).toHaveAttribute('data-kind', 'exact');
  await expect(page.getByTestId('output-size-target')).toContainText(`${String(84 + 50 * 4)} B`);

  // The inspector's summary names a destination, not a path.
  await expect(page.getByTestId('export-summary-destination')).toHaveText('Browser downloads');
  expect(errors).toEqual([]);
});

test('B/C: one format is selected at a time, and the options follow it', async ({ page }) => {
  await page.goto('/');
  await openModel(page, 'bracket.stl', ASYMMETRIC);
  await enterConvert(page);

  await page.getByTestId('convert-target-3mf').check();
  await expect(page.getByRole('radio', { name: '3MF, core model package' })).toBeChecked();
  await expect(page.getByTestId('convert-target-stl')).not.toBeChecked();

  // 3MF asks for a unit, because this STL states none; STL and OBJ do not.
  await expect(page.getByTestId('convert-unit')).toBeVisible();
  await expect(page.getByTestId('convert-unit').locator('input:checked')).toHaveCount(0);
  await expect(page.getByTestId('convert-export')).toBeDisabled();
  await expect(page.getByTestId('convert-export')).toHaveText('Convert to 3MF');
  await expect(page.getByTestId('convert-unavailable')).toBeVisible();
  await expect(page.getByTestId('export-summary-output')).toHaveText('3MF · Package');
  await expect(page.getByTestId('output-size-target')).toHaveAttribute('data-kind', 'unknown');

  // Choosing OBJ replaces the choice: a single-choice group, not a queue.
  await page.getByTestId('convert-target-obj').check();
  await expect(page.getByTestId('convert-target-3mf')).not.toBeChecked();
  await expect(page.getByTestId('convert-unit')).toHaveCount(0);
  await expect(page.getByTestId('convert-unit-fact')).toContainText('OBJ has no unit field');
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  await expect(page.getByTestId('convert-export')).toHaveText('Convert to OBJ');
  await expect(page.getByTestId('convert-options')).not.toContainText(/Y-up|Merge objects/);
});

test('D: converting downloads one validated file with the right name and geometry', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openModel(page, 'bracket.part.stl', ASYMMETRIC);
  await enterConvert(page);
  await page.getByTestId('convert-target-obj').check();

  const { download, bytes } = await convertAndCapture(page);
  // The last extension is replaced, never appended: not `bracket.part.stl.obj`.
  expect(download.suggestedFilename()).toBe('bracket.part.obj');

  // The same four corners, exactly: no axis swap, no mirror, no rescale.
  const obj = readObjArtifact(bytes);
  expect(obj.hasMtllib).toBe(false);
  expect(distinct(obj.vertices)).toEqual(distinct(CORNERS));

  // The size is now MEASURED, and it is the size of the file that was saved.
  const size = page.getByTestId('output-size-target');
  await expect(size).toHaveAttribute('data-kind', 'measured');
  await expect(size).toContainText(`${String(bytes.byteLength)} B`);
  await expect(page.getByTestId('convert-size-obj')).toHaveText(`${String(bytes.byteLength)} B`);
  await expect(page.getByTestId('export-summary-last')).toContainText('bracket.part.obj');

  // Exporting is a read: the model is exactly what it was.
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');

  // STL next: exact size, and the file really is that size.
  await page.getByTestId('convert-target-stl').check();
  await expect(page.getByTestId('convert-export')).toHaveText('Export STL');
  const stl = await convertAndCapture(page);
  expect(stl.download.suggestedFilename()).toBe('bracket.part.stl');
  expect(stl.bytes.byteLength).toBe(84 + 50 * 4);
  expect(distinct(chunk(readStlArtifact(stl.bytes).corners))).toEqual(distinct(CORNERS));
  expect(errors).toEqual([]);
});

function chunk(values: readonly number[]): number[][] {
  const points: number[][] = [];
  for (let index = 0; index < values.length; index += 3) {
    points.push(values.slice(index, index + 3));
  }
  return points;
}

test('E: a stated unit labels the 3MF and never moves a coordinate', async ({ page }) => {
  await page.goto('/');
  await openModel(page, 'bracket.stl', ASYMMETRIC);
  await enterConvert(page);
  await page.getByTestId('convert-target-3mf').check();
  await page.getByTestId('convert-unit-inch').check();
  await expect(page.getByTestId('export-summary-units')).toHaveText(
    'Inches (in), stated for this file',
  );

  const { download, bytes } = await convertAndCapture(page);
  expect(download.suggestedFilename()).toBe('bracket.3mf');
  const artifact = readThreeMfArtifact(bytes);
  expect(artifact.unit).toBe('inch');
  // The numbers are the numbers: inch labels them, it does not scale them.
  expect(distinct(artifact.objects[0]?.vertices ?? [])).toEqual(distinct(CORNERS));
  // The model still states no unit: the panel shows the user's own reading,
  // labelled as theirs, and the exported coordinates above are unchanged.
  await expect(page.getByTestId('fact-units')).toHaveText('Inches (your choice)');

  // A NEW FILE STARTS WITH NO UNIT: the statement was about the previous model.
  await openModel(page, 'other.stl', ASYMMETRIC);
  await page.getByTestId('convert-target-3mf').check();
  await expect(page.getByTestId('convert-unit').locator('input:checked')).toHaveCount(0);
  await expect(page.getByTestId('convert-export')).toBeDisabled();
});

test('F: a failed export keeps the settings and the model, says so, and can be retried', async ({
  page,
}) => {
  await page.goto('/');
  await openModel(page, 'bracket.stl', ASYMMETRIC);
  await enterConvert(page);
  await page.getByTestId('convert-target-3mf').check();
  await page.getByTestId('convert-unit-millimeter').check();

  /*
   * A REAL FAILURE, NOT A STUB: the export worker's script cannot load, so the
   * worker errors exactly as it would if the browser refused it. Nothing in
   * the application is told this is a test.
   */
  await page.route('**/export.worker-*', (route) => route.abort());
  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  await page.getByTestId('convert-export').click();

  const failure = page.getByTestId('convert-failure');
  await expect(failure).toBeVisible({ timeout: 30_000 });
  await expect(failure).toHaveAttribute('role', 'alert');
  // One line in the footer; the sentence is behind ⓘ (Convert P1).
  await expect(failure).toHaveText('Export failed — nothing saved');
  await expect(page.getByTestId('convert-outcome-details')).toContainText('Nothing was saved');
  expect(downloads).toBe(0);

  // Settings survive, the model is untouched, and Convert is available again.
  await expect(page.getByTestId('convert-target-3mf')).toBeChecked();
  await expect(page.getByTestId('convert-unit-millimeter')).toBeChecked();
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');
  await expect(page.getByTestId('convert-export')).toBeEnabled();

  await page.unroute('**/export.worker-*');
  const { bytes } = await convertAndCapture(page);
  expect(readThreeMfArtifact(bytes).unit).toBe('millimeter');
  await expect(page.getByTestId('convert-failure')).toHaveCount(0);
});

for (const width of [430, 390] as const) {
  test(`G: at ${String(width)} px the workspace is usable in its drawer`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 430 ? 932 : 844 });
    await page.goto('/');
    await openModel(page, 'bracket.stl', ASYMMETRIC);

    // The top bar's Export goes to Convert and opens the drawer it lives in.
    await page.getByTestId('topbar-export').click();
    const panel = page.getByTestId('tool-panel');
    await expect(panel).toHaveAttribute('data-drawer-open', 'true');
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(page.getByTestId('convert-workspace')).toBeVisible();

    // The priorities, in order, are all reachable.
    await expect(page.getByTestId('convert-source')).toBeVisible();
    await page.getByTestId('convert-target-obj').check();
    await expect(page.getByTestId('convert-export')).toBeVisible();
    await expect(page.getByTestId('convert-export')).toBeEnabled();

    // No horizontal overflow anywhere on the page.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // Focus stays inside the drawer while it is modal.
    for (let step = 0; step < 30; step += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () => document.getElementById('tool-panel')?.contains(document.activeElement) ?? false,
        ),
      ).toBe(true);
    }

    // It converts from the drawer.
    const pending = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('convert-export').click();
    expect((await pending).suggestedFilename()).toBe('bracket.obj');

    // Closing the drawer shows the model with only the compact size card over it.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveAttribute('data-drawer-open', 'false');
    const card = await page.getByTestId('output-size-card').boundingBox();
    const viewport = await page.getByTestId('viewport-canvas').boundingBox();
    expect(card).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (card !== null && viewport !== null) {
      expect(card.width * card.height).toBeLessThan(viewport.width * viewport.height * 0.15);
    }
  });
}

test('H: the same renderer keeps the same view through format choice and export', async ({
  page,
}) => {
  await page.goto('/');
  await openModel(page, 'bracket.stl', ASYMMETRIC);
  await enterConvert(page);

  const canvas = page.locator('[data-testid="viewport-canvas"] canvas');
  await canvas.evaluate((element) => {
    element.dataset.probe = 'original';
  });
  // The centre of the view, away from the overlays at its corners.
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  const clip = {
    x: box.x + box.width * 0.3,
    y: box.y + box.height * 0.3,
    width: box.width * 0.4,
    height: box.height * 0.4,
  };
  const before = await page.screenshot({ clip });

  for (const target of ['obj', '3mf', 'stl', 'obj'] as const) {
    await page.getByTestId(`convert-target-${target}`).check();
  }
  await convertAndCapture(page);

  // Not recreated, and not moved.
  await expect(canvas).toHaveAttribute('data-probe', 'original');
  await expect(canvas).toHaveCount(1);
  expect((await page.screenshot({ clip })).equals(before)).toBe(true);

  // The size card takes pointer events only inside its own box: a drag beside
  // it still reaches the canvas and orbits the view.
  const card = await page.getByTestId('output-size-card').boundingBox();
  if (card === null) throw new Error('no size card');
  await page.mouse.move(box.x + box.width / 2, card.y + card.height + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, card.y + card.height + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await page.screenshot({ clip })).equals(before)).toBe(false);
});

/*
 * CONVERT P1 — THE PRIMARY ACTION STAYS IN REACH AFTER A FAILED EXPORT.
 *
 * Reported on the real 94.8 MiB STL: the refusal paragraph lived INSIDE the
 * sticky footer, and on a squeezed window the workspace's scroll area became
 * shorter than that footer. A sticky element taller than its scrollport is
 * pinned by its TOP, so the button slid under the Activity log with only its
 * top edge showing. Reproduced at 1440×380 with the real refusal on v0.5.0 and
 * on the unfixed tree; with this fixture's shorter failure line the old footer
 * leaves the panel at 300 px, and this test fails there against v0.5.0.
 *
 * A real failure (the export worker cannot load, as in F) on a model whose 3MF
 * report carries the unit notes, then every size below. The button must be
 * inside the viewport AND inside the workspace's own scroll area, and the point
 * at its centre and near its bottom edge must hit the button itself — not the
 * Activity log or the status bar drawn over it.
 */
for (const [width, height] of [
  [1440, 900],
  [1280, 800],
  [1280, 640],
  [1024, 768],
  [1440, 380],
  [1440, 340],
  [1280, 360],
  // Where v0.5.0's footer, with this shorter failure line, leaves the panel.
  [1440, 300],
  [1280, 300],
] as const) {
  test(`I: after a failed export the Convert action is fully reachable at ${String(width)}×${String(height)}`, async ({
    page,
  }) => {
    await page.goto('/');
    // Two files opened, as a session does: the Activity log fills to its cap,
    // which is what squeezed the workspace in the reported window.
    await openModel(page, 'first.stl', ASYMMETRIC.slice(0, 3));
    await openModel(page, 'bracket.stl', ASYMMETRIC);
    await expect
      .poll(() => page.getByTestId('status-list').locator('li.status__entry').count(), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(4);
    await enterConvert(page);
    await page.getByTestId('convert-target-3mf').check();
    await page.getByTestId('convert-unit-millimeter').check();
    await page.route('**/export.worker-*', (route) => route.abort());
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-failure')).toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);

    const geometry = await page.evaluate(() => {
      const rect = (element: Element | null): DOMRect | undefined =>
        element?.getBoundingClientRect();
      const button = rect(document.querySelector('[data-testid="convert-export"]'));
      const body = rect(document.querySelector('.tool-panel__body'));
      if (button === undefined || body === undefined) return undefined;
      const hits = (y: number): boolean =>
        document
          .elementFromPoint(button.left + button.width / 2, y)
          ?.closest('[data-testid="convert-export"]') !== null;
      const scroller = document.querySelector('.tool-panel__body');
      return {
        button: { top: button.top, bottom: button.bottom },
        body: { top: body.top, bottom: body.bottom },
        viewport: window.innerHeight,
        centreHits: hits(button.top + button.height / 2),
        bottomHits: hits(button.bottom - 3),
        scrollable: scroller !== null && scroller.scrollHeight > scroller.clientHeight,
      };
    });
    expect(geometry).toBeDefined();
    if (geometry === undefined) return;
    expect(geometry.button.top).toBeGreaterThanOrEqual(geometry.body.top);
    expect(geometry.button.bottom).toBeLessThanOrEqual(
      Math.min(geometry.body.bottom, geometry.viewport),
    );
    expect(geometry.centreHits).toBe(true);
    expect(geometry.bottomHits).toBe(true);
    // The content above the footer scrolls on its own, and the explanation is
    // reachable in it.
    expect(geometry.scrollable).toBe(true);
    await page.getByTestId('convert-failure-info').click();
    await expect(page.getByTestId('convert-outcome-details')).toBeVisible();
    await expect(page.getByTestId('convert-outcome-details')).toBeInViewport({ ratio: 0.1 });
    // And the action still works: with the worker restored, the retry saves.
    await page.unroute('**/export.worker-*');
    await convertAndCapture(page);
  });
}
