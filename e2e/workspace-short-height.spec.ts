import { expect, test, type Page } from '@playwright/test';
import { gridForTriangles, holedCubeStl } from '../scripts/boundary-fill-fixture.mjs';
import { canvas, enter, openBox, pick } from './ui-fixtures';

/**
 * WORKSPACE-UX-03 — the sticky action region is bounded in EVERY workspace.
 *
 * v0.6.0's release qualification stopped on this: at 1440×300 the workspace's
 * scroll area is 140 px, and the Repair, Split and Texture footers grew with
 * their state until they took all of it. After a repair was applied the Undo
 * button sat underneath the footer and a click at its centre landed on the
 * footer; after a split the footer was TALLER than the scroll area.
 *
 * VISIBILITY IS NOT THE ASSERTION. An element under a sticky footer is visible
 * to every `isVisible` check and unusable to a person, so each control here is
 * brought into view the way a browser does it and then hit-tested at its
 * centre with `elementFromPoint`. The undo controls are also really clicked.
 */

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 1280, height: 640 },
  { width: 1440, height: 440 },
  { width: 1440, height: 380 },
  { width: 1440, height: 340 },
  { width: 1280, height: 360 },
  { width: 1440, height: 300 },
  { width: 1280, height: 300 },
  { width: 768, height: 1024 },
  { width: 430, height: 932 },
] as const;

// With a separate piece, so the repaired model keeps one detected issue and the card has a
// 'remaining' list to bring into reach (REPAIR-CORE-06B repairs the branched boundaries).
const CUBE = holedCubeStl(gridForTriangles(20_000), { extraPiece: true });

test.describe.configure({ timeout: 240_000 });

interface Frame {
  readonly scroller: { top: number; bottom: number };
  readonly footer: { top: number; bottom: number; height: number };
  readonly activityTop: number;
  /** `--action-footer-max`, the cap the stylesheet gives every action region. */
  readonly cap: number;
  readonly bounded: boolean;
  readonly horizontalOverflow: boolean;
  readonly scrollsToTop: boolean;
  readonly scrollsToEnd: boolean;
}

async function frame(page: Page, footerId: string): Promise<Frame> {
  return page.evaluate((id) => {
    const need = (selector: string): HTMLElement => {
      const found = document.querySelector(selector);
      if (!(found instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      return found;
    };
    const scroller = need('.tool-panel__body');
    const footer = need(`[data-testid="${id}"]`);
    const before = scroller.scrollTop;
    scroller.scrollTop = 0;
    const scrollsToTop = scroller.scrollTop === 0;
    scroller.scrollTop = scroller.scrollHeight;
    const scrollsToEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    scroller.scrollTop = before;
    const s = scroller.getBoundingClientRect();
    const f = footer.getBoundingClientRect();
    return {
      scroller: { top: s.top, bottom: s.bottom },
      footer: { top: f.top, bottom: f.bottom, height: f.height },
      activityTop: need('.tool-panel__footer').getBoundingClientRect().top,
      cap: Number.parseFloat(getComputedStyle(scroller).getPropertyValue('--action-footer-max')),
      bounded: footer.classList.contains('action-footer'),
      horizontalOverflow:
        scroller.scrollWidth > scroller.clientWidth ||
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scrollsToTop,
      scrollsToEnd,
    };
  }, footerId);
}

/**
 * Brings a control into reach as the browser would, and requires that a click
 * at its centre reaches IT — not the footer, the Activity log or a neighbour.
 */
async function expectClickable(
  page: Page,
  state: string,
  id: string,
  footerId: string,
): Promise<void> {
  const control = page.getByTestId(id).first();
  await control.scrollIntoViewIfNeeded();
  const probe = await control.evaluate((element, footer) => {
    // A visually hidden radio is operated through the label that draws it.
    const surface =
      element.getBoundingClientRect().width < 4 ? (element.closest('label') ?? element) : element;
    const rect = surface.getBoundingClientRect();
    const target = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    const region = document.querySelector(`[data-testid="${footer}"]`);
    if (region === null) throw new Error('No footer');
    return {
      own: target !== null && (surface === target || surface.contains(target)),
      hit: target?.closest('[data-testid]')?.getAttribute('data-testid') ?? target?.tagName ?? null,
      top: rect.top,
      bottom: rect.bottom,
      footerTop: region.getBoundingClientRect().top,
      scrollerTop:
        document.querySelector('.tool-panel__body')?.getBoundingClientRect().top ?? Number.NaN,
      insideFooter: region.contains(element),
    };
  }, footerId);
  expect(probe.own, `${state}: a click at the centre of ${id} lands on ${String(probe.hit)}`).toBe(
    true,
  );
  if (probe.insideFooter) return;
  // A control that fits above the pinned region is brought wholly above it.
  if (probe.bottom - probe.top <= probe.footerTop - probe.scrollerTop) {
    expect(probe.bottom, `${state}: ${id} is under the action region`).toBeLessThanOrEqual(
      probe.footerTop + 1,
    );
  }
}

/** The pinned region is bounded, inside its scroll area, and clear of Activity. */
async function expectBounded(page: Page, state: string, footerId: string): Promise<void> {
  const layout = await frame(page, footerId);
  expect.soft(layout.bounded, `${state}: the footer is the shared bounded region`).toBe(true);
  expect.soft(layout.cap, `${state}: the cap is defined`).toBeGreaterThan(0);
  expect
    .soft(layout.footer.height, `${state}: footer height against its cap`)
    .toBeLessThanOrEqual(layout.cap);
  expect
    .soft(layout.footer.top, `${state}: footer starts inside the scroll area`)
    .toBeGreaterThanOrEqual(layout.scroller.top - 1);
  // What is left of the scroll area holds a whole control.
  expect
    .soft(
      layout.footer.top - layout.scroller.top,
      `${state}: scroll area left above the action region`,
    )
    .toBeGreaterThanOrEqual(44);
  expect
    .soft(layout.footer.bottom, `${state}: footer against Activity`)
    .toBeLessThanOrEqual(layout.activityTop + 1);
  expect.soft(layout.horizontalOverflow, `${state}: horizontal overflow`).toBe(false);
  expect
    .soft(layout.scrollsToTop && layout.scrollsToEnd, `${state}: scrolls end to end`)
    .toBe(true);
}

async function expectState(
  page: Page,
  state: string,
  footerId: string,
  controls: readonly string[],
): Promise<void> {
  // The symptom first, so the pre-fix build fails on what a person would see.
  for (const id of controls) await expectClickable(page, state, id, footerId);
  await expectBounded(page, state, footerId);
}

/** Focus, as Tab delivers it, never leaves a control under the action region. */
async function expectFocusClear(
  page: Page,
  state: string,
  id: string,
  footerId: string,
): Promise<void> {
  await page.getByTestId(id).first().focus();
  await expect(page.getByTestId(id).first()).toBeFocused();
  const rects = await page
    .getByTestId(id)
    .first()
    .evaluate((element, footer) => {
      const region = document.querySelector(`[data-testid="${footer}"]`);
      const scroller = document.querySelector('.tool-panel__body');
      if (region === null || scroller === null) throw new Error('No layout');
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        limitTop: scroller.getBoundingClientRect().top,
        limitBottom: region.contains(element)
          ? region.getBoundingClientRect().bottom
          : region.getBoundingClientRect().top,
      };
    }, footerId);
  expect(rects.top, `${state}: focused ${id} above the scroll area`).toBeGreaterThanOrEqual(
    rects.limitTop - 1,
  );
  expect(rects.bottom, `${state}: focused ${id} under the action region`).toBeLessThanOrEqual(
    rects.limitBottom + 1,
  );
}

/** Sizes the window, and opens the tool drawer where the panel is one. */
async function resize(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  const toggle = page.getByTestId('toggle-tool-drawer');
  if (
    (await toggle.isVisible()) &&
    (await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open'
  ) {
    await toggle.click();
  }
  // The drawer slides in. A control probed mid-slide is off the screen, so the
  // panel must be open AND at rest before anything is hit-tested.
  const panel = page.getByTestId('tool-panel');
  await expect(panel).toBeVisible();
  let previous = Number.NaN;
  await expect
    .poll(async () => {
      const left = (await panel.boundingBox())?.x ?? Number.NaN;
      const settled = left === previous && left >= 0;
      previous = left;
      return settled;
    })
    .toBe(true);
}

for (const viewport of VIEWPORTS) {
  const size = `${String(viewport.width)}×${String(viewport.height)}`;

  test(`Repair keeps its controls and Undo in reach at ${size}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await pick(page, 'holed-cube.stl', 'model/stl', Buffer.from(CUBE.bytes));
    await enter(page, 'repair');
    await expect(page.getByTestId('issue-list')).toBeAttached({ timeout: 120_000 });
    await resize(page, viewport);
    await expect(page.getByTestId('repair-op-status-fill-openings')).toContainText('to fill', {
      timeout: 120_000,
    });

    // INITIAL / CONFIGURED: the plan is ready and the options are in reach.
    await expectState(page, 'repair/ready', 'repair-footer', [
      'repair-heading',
      'issue-status-open-boundaries',
      'repair-op-toggle-fill-openings',
      'preview-repair',
    ]);

    // PREVIEW, then CANCELLED: discarding returns to the same usable state.
    await page.getByTestId('preview-repair').click();
    await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 180_000 });
    await expectState(page, 'repair/preview', 'repair-footer', [
      'issue-status-open-boundaries',
      'repair-candidate-headline',
      'repair-preview-details-toggle',
      'discard-preview',
      'apply-repair',
    ]);
    await expectFocusClear(page, 'repair/preview', 'discard-preview', 'repair-footer');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('apply-repair')).toBeFocused();
    await page.getByTestId('discard-preview').click();
    await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 60_000 });
    await expectState(page, 'repair/preview-cancelled', 'repair-footer', [
      'repair-op-toggle-fill-openings',
      'preview-repair',
    ]);

    // APPLIED: the result is content, and everything above it still scrolls.
    await page.getByTestId('preview-repair').click();
    await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId('apply-repair').click();
    // The fresh analysis of the NEW revision settles the card (a complete repair has no
    // 'remaining' list at all, so waiting on that list would wait on nothing).
    await expect(page.getByTestId('repair-applied')).not.toHaveAttribute(
      'data-outcome',
      'checking',
      {
        timeout: 180_000,
      },
    );
    expect(
      await page
        .getByTestId('repair-footer')
        .evaluate((footer) => footer.querySelector('[data-testid="repair-applied"]') !== null),
    ).toBe(false);
    await expectState(page, 'repair/applied', 'repair-footer', [
      'undo-repair',
      'repair-heading',
      'issue-status-open-boundaries',
      'repair-op-status-fill-openings',
      'repair-applied-headline',
      'repair-applied-changes',
      'repair-applied-remaining',
      'preview-repair',
    ]);
    await expectFocusClear(page, 'repair/applied', 'undo-repair', 'repair-footer');

    // And Undo is not merely reachable: pressing it undoes.
    await page.getByTestId('undo-repair').click();
    await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId('repair-op-status-fill-openings')).toContainText('to fill', {
      timeout: 120_000,
    });
    await expectState(page, 'repair/undone', 'repair-footer', [
      'repair-op-toggle-fill-openings',
      'preview-repair',
    ]);
  });

  test(`Split keeps its controls, pieces, Export and Undo in reach at ${size}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await openBox(page);
    await enter(page, 'split');
    await resize(page, viewport);
    await expect(page.getByTestId('split-workspace')).toBeVisible();

    await expectState(page, 'split/initial', 'split-footer', [
      'split-position-slider',
      'split-connector-pin',
      'split-preview',
    ]);

    // CONFIGURED: a connector with its own parameters.
    await page.getByTestId('split-connector-pin').scrollIntoViewIfNeeded();
    await page.getByTestId('split-connector-pin').check({ force: true });
    await expectState(page, 'split/configured', 'split-footer', [
      'split-position-slider',
      'split-pin-diameter',
      'split-preview',
    ]);

    await page.getByTestId('split-preview').click();
    await expect(page.getByTestId('split-apply')).toBeEnabled({ timeout: 120_000 });
    await expectState(page, 'split/preview', 'split-footer', [
      'split-position-slider',
      'split-pin-diameter',
      'split-piece-a',
      'split-result-connector',
      'split-discard',
      'split-apply',
    ]);
    await expectFocusClear(page, 'split/preview', 'split-discard', 'split-footer');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('split-apply')).toBeFocused();

    // CANCELLED: the preview is discarded and the configuration is still there.
    await page.getByTestId('split-discard').click();
    await expect(page.getByTestId('split-preview')).toBeEnabled();
    await expectState(page, 'split/preview-cancelled', 'split-footer', [
      'split-pin-diameter',
      'split-preview',
    ]);

    await page.getByTestId('split-preview').click();
    await expect(page.getByTestId('split-apply')).toBeEnabled({ timeout: 120_000 });
    await page.getByTestId('split-apply').click();
    await expect(page.getByTestId('split-export')).toBeVisible({ timeout: 120_000 });
    // The export choice is configuration: it scrolls, it is not pinned.
    expect(
      await page
        .getByTestId('split-footer')
        .evaluate(
          (footer) =>
            footer.querySelector(
              '[data-testid="split-export-stls"], [data-testid="split-export-note"]',
            ) !== null,
        ),
    ).toBe(false);
    await expectState(page, 'split/applied', 'split-footer', [
      'split-piece-a',
      'split-piece-b',
      'split-export-stls',
      'split-export-3mf',
      'split-export-note',
      'split-undo',
      'split-export',
    ]);
    await expectFocusClear(page, 'split/applied', 'split-export', 'split-footer');
    await expectFocusClear(page, 'split/applied', 'split-undo', 'split-footer');

    await page.getByTestId('split-undo').click();
    await expect(page.getByTestId('split-preview')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('status-triangles')).toHaveText('12', { timeout: 60_000 });
    // After Undo the one restored part is not yet the split target; the action
    // region is what this state has to keep in reach.
    await expectState(page, 'split/undone', 'split-footer', ['split-preview']);
  });

  test(`Texture keeps its controls, result and Undo in reach at ${size}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await openBox(page);
    await enter(page, 'texture');
    await expect(page.getByTestId('texture-workspace')).toBeVisible();
    // The face is picked on a full-height canvas; the states are what is sized.
    const box = await canvas(page).boundingBox();
    if (box === null) throw new Error('no canvas');
    await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 - 20);
    await expect(page.getByTestId('texture-selection-metrics')).toBeVisible({ timeout: 30_000 });
    await resize(page, viewport);

    await expectState(page, 'texture/selected', 'texture-footer', [
      'texture-pattern-lines',
      'texture-spacing',
      'texture-feature-size',
      'texture-reset',
      'texture-generate',
    ]);

    await page.getByTestId('texture-generate').click();
    await expect(page.getByTestId('texture-apply')).toBeEnabled({ timeout: 180_000 });
    await expectState(page, 'texture/preview', 'texture-footer', [
      'texture-spacing',
      'texture-result-triangles',
      'texture-discard',
      'texture-apply',
    ]);
    await expectFocusClear(page, 'texture/preview', 'texture-discard', 'texture-footer');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('texture-apply')).toBeFocused();

    await page.getByTestId('texture-discard').click();
    await expect(page.getByTestId('texture-generate')).toBeEnabled({ timeout: 60_000 });
    await expectState(page, 'texture/preview-cancelled', 'texture-footer', [
      'texture-spacing',
      'texture-generate',
    ]);

    await page.getByTestId('texture-generate').click();
    await expect(page.getByTestId('texture-apply')).toBeEnabled({ timeout: 180_000 });
    await page.getByTestId('texture-apply').click();
    await expect(page.getByTestId('texture-undo')).toBeVisible({ timeout: 180_000 });
    expect(
      await page
        .getByTestId('texture-footer')
        .evaluate((footer) => footer.querySelector('[data-testid="texture-undo"]') !== null),
    ).toBe(false);
    await expectState(page, 'texture/applied', 'texture-footer', [
      'texture-undo',
      'texture-applied',
      'texture-pattern-lines',
      'texture-spacing',
      'texture-feature-size',
      'texture-depth',
      'texture-generate',
    ]);
    await expectFocusClear(page, 'texture/applied', 'texture-undo', 'texture-footer');

    await page.getByTestId('texture-undo').click();
    await expect(page.getByTestId('texture-undo')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId('status-triangles')).toHaveText('12', { timeout: 60_000 });
  });
}
