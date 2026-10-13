import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { binaryStlFrom, type Point } from './stl-fixtures';

/**
 * PYBRIX-08A — workspace foundations and production Manual Split, through the
 * PUBLIC UI only: a real STL file, the real worker, the real Manifold kernel.
 * Nothing here uses the harness or any test-only route.
 *
 * The fixture is an ASYMMETRIC unitless STL box, 40 × 20 × 60 from (5, 7, 10):
 * a position, range or volume taken from the wrong axis or side cannot pass by
 * coincidence. Its volume is 48,000 cubic units.
 */
const MIN = [5, 7, 10] as const;
const MAX = [45, 27, 70] as const;

const CORNERS: readonly Point[] = [
  [MIN[0], MIN[1], MIN[2]],
  [MAX[0], MIN[1], MIN[2]],
  [MIN[0], MAX[1], MIN[2]],
  [MAX[0], MAX[1], MIN[2]],
  [MIN[0], MIN[1], MAX[2]],
  [MAX[0], MIN[1], MAX[2]],
  [MIN[0], MAX[1], MAX[2]],
  [MAX[0], MAX[1], MAX[2]],
];
const FACES: readonly (readonly [number, number, number])[] = [
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
const corner = (index: number): Point => CORNERS[index] ?? [0, 0, 0];
const triangles = (faces: typeof FACES): [Point, Point, Point][] =>
  faces.map(([a, b, c]) => [corner(a), corner(b), corner(c)]);

const closedBoxStl = (): Buffer => binaryStlFrom(triangles(FACES));
/** The same box with its top face (two triangles) removed: one open boundary loop. */
const openBoxStl = (): Buffer =>
  binaryStlFrom(triangles(FACES.filter((_, i) => i !== 2 && i !== 3)));

async function openStl(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

async function openBox(page: Page, name = 'box.stl'): Promise<void> {
  await openStl(page, name, closedBoxStl());
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
}

const canvas = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-testid="viewport-canvas"] canvas');

/**
 * Opens Split & Connect the way a user does at this width: the navigation bar
 * on a wide screen, the compact switcher below 1024 px, and the tool drawer
 * below 900 px.
 */
async function enterSplit(page: Page): Promise<void> {
  const nav = page.getByTestId('workflow-split');
  if (await nav.isVisible()) {
    await nav.click();
  } else {
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-option-split').click();
  }
  const workspace = page.getByTestId('split-workspace');
  const drawer = page.getByTestId('toggle-tool-drawer');
  if (!(await workspace.isVisible()) && (await drawer.isVisible())) await drawer.click();
  await expect(workspace).toBeVisible();
}

async function chooseUnits(page: Page, unit: 'millimeter' | 'inch'): Promise<void> {
  await revealControl(page, page.getByTestId('split-connector-pin'));
  await page.getByTestId('split-connector-pin').check();
  await page.getByTestId(`split-unit-interpretation-${unit}`).check();
  await page.getByTestId('split-connector-none').check();
}
async function chooseMillimetres(page: Page): Promise<void> {
  await chooseUnits(page, 'millimeter');
}

async function previewSplit(page: Page): Promise<void> {
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
  await revealControl(page, page.getByTestId('split-piece-a'));
}

const watchErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/WebGL|GPU|GL Driver|swiftshader/i.test(message.text()))
      errors.push(message.text());
  });
  return errors;
};

const canvasWidth = async (page: Page): Promise<number> =>
  (await canvas(page).boundingBox())?.width ?? 0;

/* ------------------------------------------------------------- inspector -- */

test.describe('Inspector', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('A: starts collapsed, and a loaded model does not open it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('inspector-rail')).toBeVisible();
    await expect(page.getByTestId('inspector')).toBeHidden();
    await openBox(page);
    await expect(page.getByTestId('inspector-rail')).toBeVisible();
    await expect(page.getByTestId('inspector')).toBeHidden();
  });

  test('B: opens and closes without resetting the camera, and gives the model its width back', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page);
    const closedWidth = await canvasWidth(page);
    const cube = page.locator('.view-cube__body');
    const orientation = await cube.getAttribute('style');
    await canvas(page).evaluate((el) => {
      el.dataset.probe = 'same-canvas';
    });

    await page.getByTestId('expand-inspector').click();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect.poll(() => canvasWidth(page)).toBeLessThan(closedWidth);
    expect(await cube.getAttribute('style')).toBe(orientation);

    await page.getByTestId('collapse-inspector').click();
    await expect(page.getByTestId('inspector')).toBeHidden();
    await expect.poll(() => canvasWidth(page)).toBe(closedWidth);
    expect(await cube.getAttribute('style')).toBe(orientation);
    // The same canvas, resized and not recreated.
    await expect(canvas(page)).toHaveAttribute('data-probe', 'same-canvas');
  });

  test('C: the collapsed control is a named, keyboard-operable disclosure', async ({ page }) => {
    await page.goto('/');
    await openBox(page);
    const rail = page.getByTestId('expand-inspector');
    await expect(rail).toHaveAccessibleName('Show inspector');
    await expect(rail).toHaveAttribute('aria-expanded', 'false');
    await rail.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inspector')).toBeVisible();
  });

  test('D: selecting a finding, switching workspace and repairing never open it', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await page.getByTestId('workflow-texture').click();
    await page.getByTestId('workflow-repair').click();
    await expect(page.getByTestId('inspector')).toBeHidden();
  });

  test('E: a new document starts collapsed again, even if the user had opened it', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page, 'first.stl');
    await page.getByTestId('expand-inspector').click();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await openStl(page, 'second.stl', closedBoxStl());
    await expect(page.getByTestId('inspector-rail')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('inspector')).toBeHidden();
  });

  test('F: below 1200 px it is a drawer and takes no width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await openBox(page);
    await expect(page.getByTestId('inspector')).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });
});

/* ----------------------------------------------------------------- units -- */

test.describe('Unit interpretation', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('G: a unitless STL asks how to read it, and nothing is preselected', async ({ page }) => {
    await page.goto('/');
    await openBox(page);
    await expect(page.getByTestId('fact-units')).toHaveText('Unspecified by STL');
    await enterSplit(page);
    await expect(page.getByTestId('split-unit-interpretation')).toHaveCount(0);
    await expect(page.getByTestId('split-preview')).toBeEnabled();
    await revealControl(page, page.getByTestId('split-connector-pin'));
    await page.getByTestId('split-connector-pin').check();
    await expect(
      page.getByTestId('split-unit-interpretation').locator('input:checked'),
    ).toHaveCount(0);
    await expect(page.getByTestId('split-preview')).toBeDisabled();
    await page.getByTestId('split-connector-none').check();
    // The model itself still works: a plain cut needs no unit.
    await expect(page.getByTestId('split-preview')).toBeEnabled();
  });

  test('H: choosing millimetres enables connectors, labels the unit, and rescales nothing', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseMillimetres(page);
    await expect(page.getByTestId('split-connector-pin')).toBeEnabled();
    await expect(page.getByTestId('split-position-range')).toHaveText('10.0 mm – 70.0 mm');
    await expect(page.getByTestId('fact-units')).toHaveText('Millimetres (your choice)');
    // Coordinates are what the file said: same triangles, same revision.
    await expect(page.getByTestId('fact-triangles')).toHaveText('12');
  });

  test('I: inches reads the same coordinates as 25.4 times larger', async ({ page }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseUnits(page, 'inch');
    // The numbers are the file's own: 10 to 70. Only their meaning changed.
    await expect(page.getByTestId('split-position-range')).toHaveText('10.0 in – 70.0 in');
    await expect(page.getByTestId('fact-units')).toHaveText('Inches (your choice)');
  });

  test('J: the reading is the same in Split, Texture, Convert, and back in Split', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseUnits(page, 'inch');

    await page.getByTestId('workflow-texture').click();
    await expect(page.getByTestId('texture-unit-interpretation-inch')).toBeChecked();
    await expect(page.getByTestId('texture-unit')).toHaveCount(0);

    await page.getByTestId('workflow-convert').click();
    // Convert asks for a unit only when the target is 3MF; it is already answered.
    await page.getByTestId('convert-target-3mf').check();
    await expect(page.getByTestId('convert-unit-inch')).toBeChecked();

    await enterSplit(page);
    await revealControl(page, page.getByTestId('split-connector-pin'));
    await page.getByTestId('split-connector-pin').check();
    await expect(page.getByTestId('split-unit-interpretation-inch')).toBeChecked();
    await expect(page.getByTestId('split-position-range')).toHaveText('10.0 in – 70.0 in');
  });

  test('K: opening another file does not inherit the reading', async ({ page }) => {
    await page.goto('/');
    await openBox(page, 'one.stl');
    await enterSplit(page);
    await chooseMillimetres(page);
    await openStl(page, 'two.stl', closedBoxStl());
    await expect(page.getByTestId('fact-units')).toHaveText('Unspecified by STL', {
      timeout: 60_000,
    });
    await expect(
      page.getByTestId('split-unit-interpretation').locator('input:checked'),
    ).toHaveCount(0);
  });
});

/* ---------------------------------------------------------- manual split -- */

test.describe('Manual Split', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('L: a closed box splits into two real parts that apply and undo exactly', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseMillimetres(page);

    await previewSplit(page);
    await expect(page.getByTestId('split-preview-label')).toHaveText('2 pieces');
    await expect(page.getByTestId('split-piece-a')).toContainText('24,000 mm³');
    await expect(page.getByTestId('split-piece-b')).toContainText('24,000 mm³');
    await expect(page.getByTestId('split-result-validation')).toContainText('closed');
    await expect(canvas(page)).toHaveAttribute('data-tinted-parts', '2');
    // The source is untouched while previewing.
    await expect(page.getByTestId('fact-triangles')).toHaveText('12');

    await page.getByTestId('split-apply').click();
    await expect(page.getByTestId('split-undo')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('fact-parts')).not.toHaveText('1');

    await page.getByTestId('split-undo').click();
    await expect(page.getByTestId('fact-parts')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('fact-triangles')).toHaveText('12');
    // The reading of the units is not an edit; Undo cannot discard it.
    await expect(page.getByTestId('fact-units')).toHaveText('Millimetres (your choice)');
    expect(errors).toEqual([]);
  });

  test('M: moving the plane changes the result — the cut goes where it was put', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseMillimetres(page);
    await revealControl(page, page.getByTestId('split-position-value'));
    await page.getByTestId('split-position-value').fill('25');
    await page.getByTestId('split-position-value').blur();
    await previewSplit(page);
    // z = 25 on a box spanning z 10..70: 15 high below, 45 high above.
    const volumes = [
      await page.getByTestId('split-piece-a').innerText(),
      await page.getByTestId('split-piece-b').innerText(),
    ].join('|');
    expect(volumes).toContain('36,000 mm³');
    expect(volumes).toContain('12,000 mm³');
  });

  test('N: a tilted and rolled plane makes a different, volume-conserving cut', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseMillimetres(page);
    await revealControl(page, page.getByTestId('split-position-value'));
    await page.getByTestId('split-position-value').fill('30');
    await page.getByTestId('split-position-value').blur();
    await revealControl(page, page.getByTestId('split-tilt'));
    await page.getByTestId('split-tilt').fill('15');
    await page.getByTestId('split-tilt').blur();
    await revealControl(page, page.getByTestId('split-roll'));
    await page.getByTestId('split-roll').fill('10');
    await page.getByTestId('split-roll').blur();
    await expect(page.getByTestId('split-hud-cut')).toContainText('tilted 15.0°');
    await expect(page.getByTestId('split-hud-cut')).toContainText('rolled 10.0°');
    await previewSplit(page);
    const text = async (id: string): Promise<number> =>
      Number(/([\d,]+) mm³/.exec(await page.getByTestId(id).innerText())?.[1]?.replace(/,/g, ''));
    const a = await text('split-piece-a');
    const b = await text('split-piece-b');
    expect(a + b).toBeGreaterThan(47_900);
    expect(a + b).toBeLessThan(48_100);
    // Not the flat cut at the same position (36,000 / 12,000 would be z = 25).
    expect(Math.abs(a - 30_000)).toBeGreaterThan(1);
  });

  test('O: swap sides exchanges Piece A and Piece B without moving the cut', async ({ page }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseMillimetres(page);
    await revealControl(page, page.getByTestId('split-position-value'));
    await page.getByTestId('split-position-value').fill('25');
    await page.getByTestId('split-position-value').blur();
    await previewSplit(page);
    const before = await page.getByTestId('split-piece-a').innerText();
    await revealControl(page, page.getByTestId('split-flip-plane'));
    await page.getByTestId('split-flip-plane').click();
    // Changing the cut retires the preview; a new one swaps the sides.
    await expect(page.getByTestId('split-preview-label')).toHaveCount(0);
    await previewSplit(page);
    const after = await page.getByTestId('split-piece-a').innerText();
    expect(after).not.toBe(before);
    expect(after).toContain('12,000 mm³');
  });

  test('P: the preview can show both pieces, only A or only B', async ({ page }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseMillimetres(page);
    await previewSplit(page);
    await expect(canvas(page)).toHaveAttribute('data-hidden-parts', '0');
    await revealControl(page, page.getByTestId('split-view-a'));
    await page.getByTestId('split-view-a').click();
    await expect(canvas(page)).toHaveAttribute('data-hidden-parts', '1');
    await revealControl(page, page.getByTestId('split-view-b'));
    await page.getByTestId('split-view-b').click();
    await expect(canvas(page)).toHaveAttribute('data-hidden-parts', '1');
    await revealControl(page, page.getByTestId('split-view-both'));
    await page.getByTestId('split-view-both').click();
    await expect(canvas(page)).toHaveAttribute('data-hidden-parts', '0');
    // Presentation only: nothing was applied.
    await expect(page.getByTestId('fact-triangles')).toHaveText('12');
  });

  test('Q: discarding a preview leaves the source unchanged and lets the user retry', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseMillimetres(page);
    await previewSplit(page);
    await page.getByTestId('split-discard').click();
    await expect(page.getByTestId('split-preview-label')).toHaveCount(0);
    await expect(page.getByTestId('fact-triangles')).toHaveText('12');
    await previewSplit(page);
    await expect(page.getByTestId('split-piece-a')).toContainText('24,000 mm³');
  });

  test('R: a pin connector builds in a model read as inches, from physical sizes', async ({
    page,
  }) => {
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseUnits(page, 'inch');
    // The box is 40 x 20 x 60 UNITS, i.e. inches: the default 4 mm pin fits easily.
    await revealControl(page, page.getByTestId('split-connector-pin'));
    await page.getByTestId('split-connector-pin').check();
    await previewSplit(page);
    await expect(page.getByTestId('split-result-connector')).toHaveText('Round pins and sockets');
  });

  test('S: an opening away from the cut permits Preview, Apply and exact Undo', async ({
    page,
  }) => {
    await page.goto('/');
    await openStl(page, 'open.stl', openBoxStl());
    await expect(page.getByTestId('fact-triangles')).toHaveText('10', { timeout: 60_000 });
    await enterSplit(page);
    await chooseMillimetres(page);
    await page.getByTestId('split-preview').click();
    await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('split-not-closed')).toHaveCount(0);
    await expect(page.getByTestId('fact-triangles')).toHaveText('10');
    await expect(page.getByTestId('split-apply')).toBeEnabled();
    await page.getByTestId('split-apply').click();
    await expect(page.getByTestId('split-undo')).toBeEnabled();
    await page.getByTestId('split-undo').click();
    await expect(page.getByTestId('split-undo')).toHaveCount(0);
    await expect(page.getByTestId('fact-triangles')).toHaveText('10');
  });
});

/* ------------------------------------------------------------ keyboard -- */

test('T: the whole manual cut is operable from the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openBox(page);
  await enterSplit(page);
  await chooseMillimetres(page);

  await revealControl(page, page.getByTestId('split-position-value'));
  await page.getByTestId('split-position-value').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('30');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('split-hud-cut')).toContainText('Z = 30.0 mm');

  await revealControl(page, page.getByTestId('split-flip-plane'));
  await page.getByTestId('split-flip-plane').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('split-flip-plane')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('split-preview').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('split-apply').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('split-undo')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('split-undo').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 30_000 });
});

/* ---------------------------------------------------------- responsive -- */

for (const [width, height] of [
  [390, 844],
  [768, 1024],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`U: at ${String(width)}x${String(height)} the cut controls and actions are reachable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await openBox(page);
    await enterSplit(page);
    await chooseMillimetres(page);
    for (const id of ['split-position-value', 'split-tilt', 'split-roll', 'split-flip-plane']) {
      await revealControl(page, page.getByTestId(id));
      await page.getByTestId(id).scrollIntoViewIfNeeded();
    }
    await expect(page.getByTestId('split-preview')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    // The viewport keeps real width when the inspector is collapsed.
    expect(await canvasWidth(page)).toBeGreaterThan(width >= 900 ? 400 : 200);
  });
}
