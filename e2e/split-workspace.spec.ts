import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';
import { modelXml, threeMf } from './format-fixtures';
import { readStlArtifact } from './artifact-oracles';

/**
 * UI-04: the Split & Connect workspace in the shipped application.
 *
 * Every cut here is a real Boolean split in the real worker, every export a
 * real download read back here. The fixture is an ASYMMETRIC millimetre box,
 * 40 × 20 × 60 from (5, 7, 10), so a position, a range or an area that came
 * from the wrong axis or the wrong part cannot pass by coincidence.
 */

const BOX = { min: [5, 7, 10], max: [45, 27, 70] } as const;

function boxMesh(): string {
  const [x0, y0, z0] = BOX.min;
  const [x1, y1, z1] = BOX.max;
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
  return `<mesh><vertices>${v
    .map(([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`)
    .join('')}</vertices><triangles>${t
    .map(([a, b, c]) => `<triangle v1="${String(a)}" v2="${String(b)}" v3="${String(c)}"/>`)
    .join('')}</triangles></mesh>`;
}

async function openBox(page: Page, name = 'box.3mf'): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: 'model/3mf',
    buffer: threeMf(
      modelXml({
        unit: 'millimeter',
        resources: `<object id="1" type="model" name="Box">${boxMesh()}</object>`,
      }),
    ),
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
}

async function enterSplit(page: Page): Promise<void> {
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
}

async function previewSplit(page: Page): Promise<void> {
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
}

const canvas = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-testid="viewport-canvas"] canvas');

/**
 * The arrow as drawn, in page pixels: the viewport publishes its projected base
 * and tip, so the test grabs it wherever the camera put it.
 */
async function arrowOf(page: Page): Promise<{
  base: { x: number; y: number };
  tip: { x: number; y: number };
}> {
  await expect(canvas(page)).toHaveAttribute(
    'data-edit-arrow',
    /^[-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+$/,
  );
  const raw = (await canvas(page).getAttribute('data-edit-arrow')) ?? 'none';
  const box = await canvas(page).boundingBox();
  const values = raw.split(',').map(Number);
  if (box === null || values.length !== 4 || values.some((value) => !Number.isFinite(value)))
    throw new Error(`no arrow on screen: ${raw}`);
  const [bx = 0, by = 0, tx = 0, ty = 0] = values;
  return { base: { x: box.x + bx, y: box.y + by }, tip: { x: box.x + tx, y: box.y + ty } };
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

test('A: the overview shows the real cut controls, range and plane', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openBox(page);
  await enterSplit(page);

  await expect(page.getByTestId('workspace-header')).toContainText('Split & Connect');
  await expect(page.getByTestId('split-part')).toContainText('Move the plane');
  // The range is the part's own Z extent, and the plane starts at its centre.
  await expect(page.getByTestId('split-position-slider')).toHaveAttribute('min', '10');
  await expect(page.getByTestId('split-position-slider')).toHaveAttribute('max', '70');
  await expect(page.getByTestId('split-position-range')).toHaveText('10.0 mm – 70.0 mm');
  await expect(page.getByTestId('split-hud-cut')).toContainText('XY · Z = 40.0 mm');
  await expect(canvas(page)).toHaveAttribute(
    'data-edit-plane',
    '25.0000,17.0000,40.0000|0.0000,0.0000,1.0000',
  );
  // Only the connectors the engine builds; no cut list.
  await revealControl(page, page.getByTestId('split-connector-none'));
  await expect(
    page.getByRole('radiogroup', { name: 'Connector type' }).getByRole('radio'),
  ).toHaveCount(3);
  await expect(page.getByTestId('split-workspace')).not.toContainText(/Add cut|Dovetail cut/);
  await expect(page.getByTestId('split-inspector-plane')).toHaveText('XY · Z = 40.0 mm');
  expect(errors).toEqual([]);
});

test('B: the number field, the slider, the HUD and the drawn plane move together', async ({
  page,
}) => {
  await page.goto('/');
  await openBox(page);
  await enterSplit(page);

  await revealControl(page, page.getByTestId('split-position-value'));
  await page.getByTestId('split-position-value').fill('55');
  await expect(page.getByTestId('split-position-slider')).toHaveValue('55');
  await expect(page.getByTestId('split-hud-cut')).toContainText('Z = 55.0 mm');
  await expect(canvas(page)).toHaveAttribute('data-edit-plane', /,55\.0000\|/);

  // The slider drives the same state, by keyboard.
  await page.getByTestId('split-position-slider').focus();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('split-hud-cut')).toContainText('Z = 10.0 mm');
  await expect(canvas(page)).toHaveAttribute('data-edit-plane', /,10\.0000\|/);

  // Another plane re-derives the range from the part's X extent.
  await page.getByTestId('split-plane-yz').click();
  await expect(page.getByTestId('split-position-range')).toHaveText('5.0 mm – 45.0 mm');
  await expect(canvas(page)).toHaveAttribute('data-edit-plane', /\|1\.0000,0\.0000,0\.0000$/);
});

test('C: dragging the arrow moves the same plane, and does not orbit', async ({ page }) => {
  await page.goto('/');
  await openBox(page);
  await enterSplit(page);
  const cube = page.locator('.view-cube__body');
  const orientation = await cube.getAttribute('style');

  // Grab the shaft two thirds of the way up, and pull further along the arrow.
  const { base, tip } = await arrowOf(page);
  const grab = { x: base.x + (tip.x - base.x) * 0.66, y: base.y + (tip.y - base.y) * 0.66 };
  const length = Math.hypot(tip.x - base.x, tip.y - base.y);
  const along = { x: (tip.x - base.x) / length, y: (tip.y - base.y) / length };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + along.x * 60, grab.y + along.y * 60, { steps: 8 });
  await page.mouse.up();

  // One state: the field, the HUD and the drawn plane all show the dragged position.
  const moved = Number(await page.getByTestId('split-position-value').inputValue());
  expect(moved).toBeGreaterThan(40.5);
  await expect(page.getByTestId('split-hud-cut')).toContainText(`Z = ${moved.toFixed(1)} mm`);
  // The drawn plane is written on the next rendered frame, after the field has
  // already updated, so it is polled — to the same exact value. A single read
  // raced that frame about one run in twelve (UI-06: the attribute read 58.39
  // with the field at 59.451, then 59.451 from the next frame on).
  await expect
    .poll(async () => {
      const drawn = (await canvas(page).getAttribute('data-edit-plane')) ?? '';
      return Number(drawn.split('|')[0]?.split(',')[2]);
    })
    .toBeCloseTo(moved, 3);
  // The camera did not move: the drag was the arrow's, not the orbit's.
  expect(await cube.getAttribute('style')).toBe(orientation);
});

test('D/E: a real split previews in two colours, applies as two parts, and parts are selectable', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await openBox(page);
  await enterSplit(page);
  await canvas(page).evaluate((element) => {
    element.dataset.probe = 'original';
  });

  await previewSplit(page);
  // The engine's own measurement: a 40 × 20 face, one outline.
  await expect(page.getByTestId('split-hud-detail')).toContainText('Cut face 800 mm² · 1 outline');
  await expect(canvas(page)).toHaveAttribute('data-tinted-parts', '2');
  await expect(canvas(page)).toHaveAttribute('data-section-outline-edges', /^[1-9]/);
  await expect(page.getByTestId('split-piece-a')).toContainText('24,000 mm³');
  await expect(page.getByTestId('split-piece-b')).toContainText('24,000 mm³');
  // Nothing is applied yet.
  await expect(page.getByTestId('fact-triangles')).toHaveText('12');

  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-export')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('split-inspector-part')).toHaveText('Box A');
  await expect(canvas(page)).toHaveAttribute('data-probe', 'original');

  await page.getByTestId('assembly-assembled').click();
  await page.getByTestId('split-again').click();

  // After beginning the next split the plane belongs to Piece A (z 40–70) and sits at its centre,
  // with Piece B (z 10–40) behind it: a point two arrow-lengths back along the
  // axis lies on Piece B. Picking it selects Piece B, and the inspector follows.
  const { base, tip } = await arrowOf(page);
  await page.mouse.click(base.x - (tip.x - base.x) * 2.2, base.y - (tip.y - base.y) * 2.2);
  await expect(page.getByTestId('split-inspector-part')).toHaveText('Box B');
  await expect(page.getByTestId('split-inspector-volume')).toContainText('24,000 mm³');
  expect(errors).toEqual([]);
});

test('F/G: connector parameters change the geometry, and both pieces export', async ({ page }) => {
  await page.goto('/');
  await openBox(page, 'box.3mf');
  await enterSplit(page);
  await revealControl(page, page.getByTestId('split-connector-pin'));
  await page.getByTestId('split-connector-pin').check();

  await revealControl(page, page.getByTestId('split-pin-diameter'));
  await page.getByTestId('split-pin-diameter').fill('4');
  await previewSplit(page);
  const small = (await page.getByTestId('split-piece-a').textContent()) ?? '';
  await expect(page.getByTestId('split-result-connector')).toHaveText('Round pins and sockets');

  // A bigger pin on Piece A is more material on Piece A: a real Boolean change.
  await revealControl(page, page.getByTestId('split-pin-diameter'));
  await page.getByTestId('split-pin-diameter').fill('8');
  await revealControl(page, page.getByTestId('split-clearance'));
  await page.getByTestId('split-clearance').fill('0.25');
  await expect(page.getByTestId('split-socket-size')).toContainText('socket Ø 8.5 mm');
  await previewSplit(page);
  const large = (await page.getByTestId('split-piece-a').textContent()) ?? '';
  const volume = (text: string): number =>
    Number((/([\d,]+) mm³/.exec(text)?.[1] ?? '').replace(/,/g, ''));
  expect(volume(large)).toBeGreaterThan(volume(small));

  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-export')).toHaveText('Export pieces', {
    timeout: 30_000,
  });
  const downloads: { name: string; bytes: Buffer }[] = [];
  page.on('download', (download) => {
    void (async (): Promise<void> => {
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      downloads.push({ name: download.suggestedFilename(), bytes: Buffer.concat(chunks) });
    })();
  });
  await page.getByTestId('split-export').click();
  await expect(page.getByTestId('split-export-saved')).toContainText('box_part_A.stl');
  await expect.poll(() => downloads.length).toBe(2);
  const names = downloads.map((download) => download.name).sort();
  expect(names).toEqual(['box_part_A.stl', 'box_part_B.stl']);
  for (const download of downloads) {
    // A pin or a socket makes each piece more than a plain box's 12 triangles.
    expect(readStlArtifact(download.bytes).declaredTriangles).toBeGreaterThan(12);
  }
});

test('a cut that cannot be made is refused, the model stays, and settings are kept', async ({
  page,
}) => {
  await page.goto('/');
  await openBox(page);
  await enterSplit(page);
  // At the very bottom face nothing lies below the plane.
  await revealControl(page, page.getByTestId('split-position-value'));
  await page.getByTestId('split-position-value').fill('10');
  await page.getByTestId('split-preview').click();
  const error = page.getByTestId('split-error');
  await expect(error).toBeVisible({ timeout: 60_000 });
  await expect(error).toHaveAttribute('role', 'status');
  await expect(error).toContainText("This cut can't be made safely.");
  await expect(page.getByTestId('split-position-value')).toHaveValue('10');
  await expect(page.getByTestId('fact-triangles')).toHaveText('12');
  // And a valid position still works afterwards.
  await revealControl(page, page.getByTestId('split-position-value'));
  await page.getByTestId('split-position-value').fill('30');
  await previewSplit(page);
});

test('connectors wait for the user to say how to read a model that states no unit', async ({
  page,
}) => {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'plain.stl', mimeType: 'model/stl', buffer: binaryStl(12).bytes });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
  await enterSplit(page);
  await expect(page.getByTestId('split-unit-interpretation')).toHaveCount(0);
  await revealControl(page, page.getByTestId('split-connector-pin'));
  await page.getByTestId('split-connector-pin').check();
  await expect(page.getByTestId('split-preview')).toBeDisabled();
  await expect(page.getByTestId('split-connectors-unit')).toContainText('Choose its units');
  // Nothing is preselected and nothing is guessed from the model's size.
  await expect(page.getByTestId('split-unit-interpretation').locator('input:checked')).toHaveCount(
    0,
  );
  // The range carries no invented unit.
  await expect(page.getByTestId('split-position-range')).not.toContainText('mm');
});

for (const width of [430, 390] as const) {
  test(`H: at ${String(width)} px the controls work in the drawer`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 430 ? 932 : 844 });
    await page.goto('/');
    await openBox(page);
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-option-split').click();
    await page.getByTestId('toggle-tool-drawer').click();
    const panel = page.getByTestId('tool-panel');
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(page.getByTestId('split-workspace')).toBeVisible();

    await revealControl(page, page.getByTestId('split-position-value'));
    await page.getByTestId('split-position-value').fill('50');
    await expect(page.getByTestId('split-position-slider')).toHaveValue('50');
    await revealControl(page, page.getByTestId('split-connector-pin'));
    await page.getByTestId('split-connector-pin').check();
    await expect(page.getByTestId('split-preview')).toBeVisible();
    const target = await page.getByTestId('split-position-value').boundingBox();
    expect(target?.height ?? 0).toBeGreaterThanOrEqual(38);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (let step = 0; step < 30; step += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () => document.getElementById('tool-panel')?.contains(document.activeElement) ?? false,
        ),
        `Tab ${String(step)}: ${String(await page.evaluate(() => document.activeElement?.outerHTML))}`,
      ).toBe(true);
    }
    // The HUD stays clear of the view cube.
    await page.keyboard.press('Escape');
    const hud = await page.getByTestId('split-hud').boundingBox();
    const viewCube = await page.locator('.view-cube').boundingBox();
    if (hud !== null && viewCube !== null) {
      const overlaps =
        hud.x < viewCube.x + viewCube.width &&
        hud.x + hud.width > viewCube.x &&
        hud.y < viewCube.y + viewCube.height &&
        hud.y + hud.height > viewCube.y;
      expect(overlaps).toBe(false);
    }
  });
}
