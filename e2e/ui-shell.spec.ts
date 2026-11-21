import { expect, test, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';

/**
 * UI-01: the application shell.
 *
 * Geometry of the shell, its responsive tiers, and the behaviours that keep the
 * viewport usable around it. Measured in a real browser because every one of
 * these is a layout fact jsdom cannot compute.
 *
 * Two assertions here reproduce defects found while qualifying UI-01:
 *
 *   - A size token named `--text-secondary` collided with the legacy COLOUR
 *     alias of the same name, so every `font:` shorthand that used it was
 *     invalid and silently fell back — the inspector's file name rendered in
 *     the body face instead of the monospace one.
 *   - The current workspace tab's `aria-current` box-shadow replaced the focus
 *     ring, so keyboard focus on it was invisible.
 */

async function openModel(page: Page): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'shell.stl',
    mimeType: 'model/stl',
    buffer: binaryStl(400).bytes,
  });
  // The status bar is visible at every width; the Mesh Health panel is not —
  // below 900 px it lives in a closed drawer.
  await expect(page.getByTestId('status-triangles')).toHaveText('400', { timeout: 60_000 });
  await expect(page.getByTestId('issue-list')).toBeAttached({ timeout: 60_000 });
}

async function box(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await page.locator(selector).first().boundingBox();
  if (rect === null) throw new Error(`${selector} has no box`);
  return rect;
}

async function canvasWidth(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.querySelector<HTMLCanvasElement>('[data-testid="viewport-canvas"] canvas')
        ?.clientWidth ?? 0,
  );
}

test('desktop shell: 48 px top bar, 300 px tool panel, 280 px inspector, 30 px status bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openModel(page);
  // PYBRIX-08A: the Inspector starts collapsed, so the model gets its width...
  expect((await box(page, '.inspector-rail')).width).toBe(36);
  expect((await box(page, '.viewport')).width).toBe(1440 - 300 - 36);
  // ...and these are the dimensions once the user opens it.
  await page.getByTestId('expand-inspector').click();

  expect((await box(page, '.topbar')).height).toBe(48);
  expect((await box(page, '.statusbar')).height).toBe(30);
  expect((await box(page, '.tool-panel')).width).toBe(300);
  expect((await box(page, '.inspector')).width).toBe(280);

  // The viewport takes exactly what is left, between the panels.
  const viewport = await box(page, '.viewport');
  expect(viewport.x).toBe(300);
  expect(viewport.width).toBe(1440 - 300 - 280);
  expect(viewport.height).toBe(900 - 48 - 30);
  expect(await canvasWidth(page)).toBe(viewport.width);
});

test('no size in the qualified range scrolls the page horizontally or vertically', async ({
  page,
}) => {
  await page.goto('/');
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
    [1280, 800],
    [1024, 768],
    [834, 1194],
    [768, 1024],
    [430, 932],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(overflow, `${String(width)}x${String(height)}`).toEqual({ x: 0, y: 0 });
  }
});

test('opening the inspector narrows the viewport and keeps the same renderer drawing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openModel(page);
  // Collapsed by default: the rail is all the inspector takes.
  await expect(page.getByTestId('inspector-rail')).toBeVisible();
  expect((await box(page, '.inspector-rail')).width).toBe(36);
  const collapsed = await canvasWidth(page);
  await page
    .getByTestId('viewport-canvas')
    .locator('canvas')
    .evaluate((canvas) => {
      canvas.dataset.shellProbe = 'original';
    });

  await page.getByTestId('expand-inspector').click();
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect.poll(() => canvasWidth(page)).toBe(collapsed - 280 + 36);

  // The same canvas element — resized, not recreated — and still drawing.
  const canvas = page.getByTestId('viewport-canvas').locator('canvas');
  await expect(canvas).toHaveAttribute('data-shell-probe', 'original');
  await expect(canvas).toHaveAttribute('data-rendered-triangles', '400');

  await page.getByTestId('collapse-inspector').click();
  await expect.poll(() => canvasWidth(page)).toBe(collapsed);
});

test('below 1200 px the inspector is a drawer over the viewport, closed by Esc', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await openModel(page);
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toBeHidden();
  const before = await canvasWidth(page);

  await page.getByTestId('toggle-inspector-drawer').click();
  await expect(inspector).toBeVisible();
  // An overlay: the viewport does not resize under it.
  expect(await canvasWidth(page)).toBe(before);

  await page.keyboard.press('Escape');
  await expect(inspector).toBeHidden();
});

test('below 900 px only one drawer is open at a time', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/');
  await openModel(page);

  await page.getByTestId('toggle-tool-drawer').click();
  await expect(page.getByTestId('tool-panel')).toBeVisible();
  // While a drawer is open it is a modal: the top bar, and with it the other
  // drawer's toggle, is inert, so a second drawer cannot be stacked on it.
  await expect(page.locator('.app__contents').first()).toHaveJSProperty('inert', true);

  await page.getByTestId('close-tool-panel').click();
  await expect(page.getByTestId('tool-panel')).toBeHidden();
  await page.getByTestId('toggle-inspector-drawer').click();
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('tool-panel')).toBeHidden();
});

test('the workspace menu closes on Esc and returns focus to its trigger', async ({ page }) => {
  // The compact switcher is the navigation below the desktop tier only.
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/');
  const trigger = page.getByTestId('workspace-switcher');
  await trigger.click();
  await expect(page.getByTestId('workspace-option-hollow')).toContainText('Coming soon');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('workspace-option-hollow')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('keyboard focus on the CURRENT workspace tab shows the focus ring', async ({ page }) => {
  await page.goto('/');
  const current = page.getByTestId('workflow-repair');
  // Reach it by keyboard so :focus-visible applies.
  await page.getByTestId('topbar-export').focus();
  for (let step = 0; step < 6; step += 1) {
    if (await current.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(current).toBeFocused();
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect
    .poll(() => current.evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain('rgba(18, 160, 251, 0.75)');
});

test('shell type is set in its own faces, not the fallback', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openModel(page);
  const name = page.getByTestId('fact-filename');
  const font = await name.evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
  });
  expect(font.family).toContain('JetBrains Mono');
  expect(font).toMatchObject({ size: '12px', weight: '600' });
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((face) => face.status === 'loaded').map((f) => f.family);
    }),
  ).toEqual(expect.arrayContaining(['Figtree', 'Space Grotesk', 'JetBrains Mono']));
});

/* ------------------------------------------------ responsive drawer focus -- */

for (const drawer of [
  { name: 'tool panel', width: 768, toggle: 'toggle-tool-drawer', panel: 'tool-panel' },
  { name: 'inspector', width: 1024, toggle: 'toggle-inspector-drawer', panel: 'inspector' },
] as const) {
  test(`the ${drawer.name} drawer is a modal: focus moves in, Tab wraps both ways, Esc returns it`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: drawer.width, height: 900 });
    await page.goto('/');
    await openModel(page);
    const trigger = page.getByTestId(drawer.toggle);
    const panel = page.getByTestId(drawer.panel);

    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(panel).toHaveAttribute('aria-modal', 'true');

    const insidePanel = (): Promise<boolean> =>
      panel.evaluate((root) => root.contains(document.activeElement));
    // 1. Focus starts inside, on the drawer's first control.
    await expect.poll(insidePanel).toBe(true);
    const first = await page.evaluate(() => document.activeElement?.outerHTML ?? '');

    // 2. The rest of the page is out of reach.
    await expect(page.locator('.app__contents').first()).toHaveJSProperty('inert', true);
    expect(
      await page.evaluate(() => document.querySelector<HTMLElement>('.app__main')?.inert ?? false),
    ).toBe(true);

    // 3. Forward: many more presses than there are controls, never leaving.
    let wrappedForward = false;
    for (let press = 0; press < 80; press += 1) {
      await page.keyboard.press('Tab');
      expect(await insidePanel()).toBe(true);
      if ((await page.evaluate(() => document.activeElement?.outerHTML ?? '')) === first) {
        wrappedForward = true;
        break;
      }
    }
    expect(wrappedForward).toBe(true);

    // 4. Backward from the first control goes to the last, still inside.
    await page.keyboard.press('Shift+Tab');
    expect(await insidePanel()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.outerHTML ?? '')).not.toBe(first);
    for (let press = 0; press < 5; press += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await insidePanel()).toBe(true);
    }

    // 5. Esc closes it and hands focus back to the control that opened it.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(panel).not.toHaveAttribute('role', 'dialog');
    await expect(trigger).toBeFocused();
    expect(
      await page.evaluate(() => document.querySelector<HTMLElement>('.app__main')?.inert ?? true),
    ).toBe(false);
  });
}

test('docked panels at desktop widths are never modal and never make the page inert', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openModel(page);
  for (const id of ['tool-panel', 'inspector']) {
    await expect(page.getByTestId(id)).not.toHaveAttribute('role', 'dialog');
    await expect(page.getByTestId(id)).not.toHaveAttribute('aria-modal', 'true');
  }
  expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0);
});

/* ------------------------------------------ full-size interaction smoke -- */

/**
 * The real editor at a real desktop size, under a real interaction.
 *
 * NOT A MICROBENCHMARK. The per-frame limit lives in the fixed-size 7C
 * benchmark (e2e-harness/texture-workflow.spec.ts), because headless Chromium
 * renders WebGL on the CPU and frame cost there follows canvas area. At
 * 1440x900 the canvas is 860x822, and single frames of several hundred
 * milliseconds were measured on a loaded host with no regression anywhere. The
 * guard here is for a FREEZE: two seconds without a frame means the page
 * stopped, which no amount of machine load explains.
 */
const FREEZE_GUARD_MS = 2_000;

test('full-size editor: orbit, pan and zoom keep the renderer alive and frames flowing', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('crash', () => problems.push('page crashed'));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openModel(page);
  const canvas = page.getByTestId('viewport-canvas').locator('canvas');
  await canvas.evaluate((element) => {
    element.dataset.smokeProbe = 'original';
  });
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('viewport canvas has no box');
  const cube = page.locator('.view-cube__body');
  const orientationBefore = await cube.evaluate((element) => element.style.transform);

  await page.evaluate(() => {
    const probe = window as unknown as { frames: number[]; frameLoop: number };
    probe.frames = [];
    const tick = (now: number): void => {
      probe.frames.push(now);
      probe.frameLoop = requestAnimationFrame(tick);
    };
    probe.frameLoop = requestAnimationFrame(tick);
  });

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 160, y + 60, { steps: 20 });
  await page.mouse.up();
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x - 80, y, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(300);

  const frames = await page.evaluate(() => {
    const probe = window as unknown as { frames: number[]; frameLoop: number };
    cancelAnimationFrame(probe.frameLoop);
    return probe.frames;
  });
  const gaps = frames.slice(1).map((time, index) => time - (frames[index] ?? time));

  // The camera really moved, and the same renderer is still drawing the model.
  expect(await cube.evaluate((element) => element.style.transform)).not.toBe(orientationBefore);
  await expect(canvas).toHaveAttribute('data-smoke-probe', 'original');
  await expect(canvas).toHaveAttribute('data-rendered-triangles', '400');
  await expect(page.getByTestId('viewport-error')).toHaveCount(0);

  // Frames kept arriving through the whole interaction.
  expect(frames.length).toBeGreaterThan(10);
  expect(Math.max(...gaps)).toBeLessThan(FREEZE_GUARD_MS);
  expect(problems).toEqual([]);
});
