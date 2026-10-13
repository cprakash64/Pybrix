import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { enter, openBox, openDefects, selectFace } from './ui-fixtures';
import { openInspector } from './inspector';

/**
 * UI-06: the visual-regression foundation.
 *
 * NOT PIXEL SNAPSHOTS. The viewport is WebGL, rendered on the CPU in headless
 * Chromium, and its anti-aliasing is not a property of CAD Fixer; a screenshot
 * baseline would fail on GPU noise and pass a real regression hidden under a
 * mask. These tests assert the INVARIANTS that make the four workspaces one
 * product — shell geometry, the one card family, the one primary and one
 * secondary button, the one number field, the inspector's order, where a HUD
 * may sit and what a phone gets — measured as computed style and layout in a
 * real browser. The rules they hold are written in docs/design/UI_SHELL.md.
 *
 * Dimensions that legitimately follow content (a card's width, a panel's
 * height) are NOT compared; shape, weight, borders and minimum sizes are.
 */

const WORKSPACES = ['repair', 'convert', 'split', 'texture'] as const;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function rect(page: Page, selector: string): Promise<Rect> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} is not laid out`);
  return box;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Computed properties of every VISIBLE element matching `selector`. */
async function styles(
  page: Page,
  selector: string,
  properties: readonly string[],
): Promise<Record<string, string>[]> {
  return page.evaluate(
    ({ selector, properties }) =>
      [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'
          );
        })
        .map((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          const out: Record<string, string> = {
            height: String(Math.round(box.height)),
            width: String(Math.round(box.width)),
          };
          for (const property of properties) out[property] = style.getPropertyValue(property);
          return out;
        }),
    { selector, properties },
  );
}

function distinct(values: readonly Record<string, string>[], property: string): string[] {
  return [...new Set(values.map((value) => value[property] ?? ''))];
}

test('shell geometry and drawer tiers hold at every breakpoint', async ({ page }) => {
  const tiers = [
    { width: 1440, tool: 300, inspector: 280, toolDrawer: false, inspectorDrawer: false },
    { width: 1300, tool: 280, inspector: 250, toolDrawer: false, inspectorDrawer: false },
    { width: 1100, tool: 280, inspector: undefined, toolDrawer: false, inspectorDrawer: true },
    { width: 800, tool: undefined, inspector: undefined, toolDrawer: true, inspectorDrawer: true },
    { width: 390, tool: undefined, inspector: undefined, toolDrawer: true, inspectorDrawer: true },
  ];
  await page.goto('/');
  // Collapsed by default (PYBRIX-08A); the docked tiers below measure it open.
  const rail = page.getByTestId('expand-inspector');
  if (await rail.isVisible()) await rail.click();
  for (const tier of tiers) {
    await page.setViewportSize({ width: tier.width, height: 844 });
    const top = await rect(page, '.topbar');
    const status = await rect(page, '.statusbar');
    expect(top.height, `top bar at ${String(tier.width)}`).toBe(tier.width < 600 ? 52 : 48);
    expect(status.height, `status bar at ${String(tier.width)}`).toBe(30);
    const positions = await page.evaluate(() => ({
      tool: getComputedStyle(document.querySelector('#tool-panel') ?? document.body).position,
      inspector: getComputedStyle(document.querySelector('#inspector') ?? document.body).position,
    }));
    expect(positions.tool === 'absolute', `tool drawer at ${String(tier.width)}`).toBe(
      tier.toolDrawer,
    );
    expect(positions.inspector === 'absolute', `inspector drawer at ${String(tier.width)}`).toBe(
      tier.inspectorDrawer,
    );
    if (tier.tool !== undefined) expect((await rect(page, '#tool-panel')).width).toBe(tier.tool);
    if (tier.inspector !== undefined)
      expect((await rect(page, '#inspector')).width).toBe(tier.inspector);
    // Docked or not, nothing scrolls sideways.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});

test('the four workspaces share one control family', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openBox(page);

  const titles: Record<string, string>[] = [];
  const primaries: Record<string, string>[] = [];
  const secondaries: Record<string, string>[] = [];
  const cards: Record<string, string>[] = [];
  const numbers: Record<string, string>[] = [];
  const font = ['font-family', 'font-weight', 'font-size', 'white-space'];
  const shape = ['border-top-left-radius', 'border-top-width', 'font-weight', 'font-size'];
  for (const id of WORKSPACES) {
    await enter(page, id);
    titles.push(...(await styles(page, '#tool-panel .panel-section__title', font)));
    primaries.push(
      ...(await styles(page, '#tool-panel .primary-action, #tool-panel .action--primary', shape)),
    );
    secondaries.push(
      ...(await styles(
        page,
        '#tool-panel .secondary-action, #tool-panel .action:not(.action--primary)',
        ['border-top-left-radius', 'border-top-width', 'font-weight'],
      )),
    );
    cards.push(
      ...(await styles(page, '#tool-panel .format-card', [
        'border-top-left-radius',
        'border-top-width',
        'padding-top',
        'padding-left',
      ])),
    );
    numbers.push(
      ...(await styles(page, '#tool-panel .split-number', [
        'border-top-left-radius',
        'border-top-width',
        'background-color',
      ])),
    );
  }

  // One heading style, on one line, in every workspace.
  expect(titles.length).toBeGreaterThanOrEqual(8);
  for (const property of font) expect(distinct(titles, property), property).toHaveLength(1);
  expect(distinct(titles, 'white-space')).toEqual(['nowrap']);

  // One primary action: 36 px, the control radius, one weight and size.
  // Repair keeps its action even with nothing to repair (disabled, REPAIR-UX-01).
  expect(primaries.length).toBeGreaterThanOrEqual(3);
  expect(distinct(primaries, 'height')).toEqual(['36']);
  for (const property of shape) expect(distinct(primaries, property), property).toHaveLength(1);

  // One secondary button: shape and weight agree; height follows its row (a
  // compact inline control, the control height, or its primary's 36 px).
  expect(secondaries.length).toBeGreaterThanOrEqual(4);
  for (const property of ['border-top-left-radius', 'border-top-width', 'font-weight'])
    expect(distinct(secondaries, property), property).toHaveLength(1);
  for (const secondary of secondaries) expect(['30', '32', '36']).toContain(secondary.height ?? '');

  // Format, connector and pattern cards are one family: radius, border,
  // padding; each at least a comfortable target.
  expect(cards.length).toBeGreaterThanOrEqual(10);
  for (const property of [
    'border-top-left-radius',
    'border-top-width',
    'padding-top',
    'padding-left',
  ])
    expect(distinct(cards, property), property).toHaveLength(1);
  for (const card of cards) {
    expect(Number(card.height)).toBeGreaterThanOrEqual(40);
    expect(Number(card.width)).toBeGreaterThanOrEqual(40);
  }

  // Every NumberField is the same field.
  expect(numbers.length).toBeGreaterThanOrEqual(5);
  for (const property of [
    'height',
    'border-top-left-radius',
    'border-top-width',
    'background-color',
  ])
    expect(distinct(numbers, property), property).toHaveLength(1);
});

test('a selected card reads the same in every workspace, and not by colour alone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openBox(page);
  for (const id of ['convert', 'split', 'texture'] as const) {
    await enter(page, id);
    // Scoped to the workspace: the others stay mounted, hidden, with their own
    // selected cards.
    const scope = `[data-testid="${id}-workspace"] .format-card[data-selected="true"]`;
    const card = page.locator(scope).first();
    await expect(card).toBeVisible();
    // The check mark is the non-colour cue, and the radio is really checked.
    await expect(card.locator('.format-card__check')).toBeVisible();
    await expect(card.locator('input')).toBeChecked();
    // The accent border and its soft fill, as the tokens define them. The
    // retrying assertion waits out the card's border-colour transition.
    await expect(card).toHaveCSS('border-top-color', 'rgb(18, 160, 251)');
    await expect(card).toHaveCSS('background-color', 'rgba(18, 160, 251, 0.14)');
    // Keyboard focus shows the shared ring on the card, not just the input.
    await card.locator('input').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(card.locator('input')).toBeFocused();
    await expect(card).not.toHaveCSS('box-shadow', 'none');
  }
});

test('the inspector keeps one order, context first, in every workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openInspector(page);
  const order = ['Selection', 'Model', 'Export', 'Runtime'];
  // Export appears only once there is a model to export.
  await expect(page.locator('#inspector .panel-section__title:visible')).toHaveText([
    'Selection',
    'Model',
    'Runtime',
  ]);
  await openBox(page);
  for (const id of WORKSPACES) {
    await enter(page, id);
    await expect(page.locator('#inspector .panel-section__title:visible')).toHaveText(order);
  }
});

test('HUDs stay in their band, clear of the toolbar and the view cube', async ({ page }) => {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [834, 1194],
    [430, 932],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await openDefects(page);
    // An issue with occurrences: its HUD shows in Repair.
    if (width < 900) await page.getByTestId('toggle-tool-drawer').click();
    await revealControl(page, page.getByTestId('issue-row-degenerate-faces'));
    await page.getByTestId('issue-row-degenerate-faces').click();
    if (width < 900) await page.keyboard.press('Escape');
    await expect(page.getByTestId('issue-hud')).toBeVisible();
    const hud = await rect(page, '[data-testid="issue-hud"]');
    const tools = await rect(page, '.viewport__tools');
    const cube = await rect(page, '.viewport__orientation');
    const viewport = await rect(page, '.viewport');
    expect(overlaps(hud, tools), `HUD × toolbar at ${String(width)}`).toBe(false);
    expect(overlaps(hud, cube), `HUD × view cube at ${String(width)}`).toBe(false);
    expect(hud.x).toBeGreaterThanOrEqual(viewport.x);
    expect(hud.x + hud.width).toBeLessThanOrEqual(viewport.x + viewport.width);
  }
});

test('on a phone every workspace’s drawer fits, and its primary action is reachable and touch-sized', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openBox(page);
  const primaryFor = {
    repair: 'preview-repair',
    convert: 'convert-export',
    split: 'split-preview',
    texture: 'texture-generate',
  } as const;
  for (const id of WORKSPACES) {
    await enter(page, id);
    // Convert opens its own drawer; the others are opened here.
    if ((await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open')
      await page.getByTestId('toggle-tool-drawer').click();
    // Measured once the slide-in has finished.
    await expect.poll(async () => (await rect(page, '#tool-panel')).x).toBe(0);
    const drawer = await rect(page, '#tool-panel');
    expect(drawer.width).toBeLessThanOrEqual(390 * 0.88 + 1);
    const action = page.getByTestId(primaryFor[id]);
    await action.scrollIntoViewIfNeeded();
    const box = await action.boundingBox();
    if (box === null) throw new Error(`${id} has no primary action`);
    expect(box.height, `${id} action height`).toBeGreaterThanOrEqual(40);
    expect(box.y).toBeGreaterThanOrEqual(drawer.y);
    expect(box.y + box.height).toBeLessThanOrEqual(drawer.y + drawer.height);
    // The whole shell is still where it was: nothing was scrolled sideways.
    expect(await page.evaluate(() => document.querySelector('.app')?.scrollLeft)).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.keyboard.press('Escape');
  }
  // Top-bar controls meet the tier's target size.
  const topControls = await styles(page, '.topbar button', []);
  for (const control of topControls) expect(Number(control.height)).toBeGreaterThanOrEqual(40);
});

test('on a phone the texture HUD sits above the status bar, clear of the viewport controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openBox(page);
  await enter(page, 'texture');
  await page.keyboard.press('Escape');
  await selectFace(page);
  const hud = await rect(page, '[data-testid="texture-hud"]');
  const tools = await rect(page, '.viewport__tools');
  const cube = await rect(page, '.viewport__orientation');
  const status = await rect(page, '.statusbar');
  expect(overlaps(hud, tools)).toBe(false);
  expect(overlaps(hud, cube)).toBe(false);
  expect(hud.y + hud.height).toBeLessThanOrEqual(status.y);
});
