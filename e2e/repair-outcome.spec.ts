import { expect, test, type Page } from '@playwright/test';
import { gridForTriangles, holedCubeStl } from '../scripts/boundary-fill-fixture.mjs';
import { boxWithOneOpeningStl } from './hole-fill-fixtures';
import { enter, pick } from './ui-fixtures';

/**
 * REPAIR-UX-04 — a successful repair and a healthy model are distinct states.
 *
 * v0.6.0 headed every applied repair "Conservative repair applied", in green,
 * beside a Health line that still read "1 error · 2 warnings". On a real
 * 2M-triangle model that filled 2 of 13 openings, that read as a repair which
 * claimed to fix the model and had not. The outcome now says whether the
 * repair was COMPLETE or PARTIAL from the analysis of the repaired mesh, lists
 * what remains per category, and leaves Health authoritative.
 *
 * THREE SMALL MODELS, none of them the 95 MiB truck: one a repair resolves
 * entirely, one it resolves in part, and one it can do nothing for.
 */

test.describe.configure({ timeout: 240_000 });

/*
 * REPAIR-CORE-06B changed what a branched boundary means to Repair: the two corner-touching
 * openings are pinched vertices, the local repair separates them, and the fill stage then closes
 * the two simple openings each one becomes. So a cube with 6 simple and 7 branched openings is
 * now repaired COMPLETELY (13 filled). What stays a partial result is a second connected piece,
 * which Pybrix reports and never repairs: `extraPiece`. And "nothing Pybrix can repair" is that
 * second piece alone.
 */
/** 6 simple and 7 branched openings, plus a separate piece Repair never touches. */
const PARTIAL = holedCubeStl(gridForTriangles(20_000), { extraPiece: true });
/** A closed cube and a separate piece: one detected issue, with no repair for it. */
const NO_FIX = holedCubeStl(gridForTriangles(20_000), {
  simple: 0,
  branched: 0,
  extraPiece: true,
});

async function open(page: Page, name: string, bytes: Uint8Array | Buffer): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await pick(page, name, 'model/stl', Buffer.from(bytes));
  await enter(page, 'repair');
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('repair-op-status-fill-openings')).not.toHaveText(/Checking/, {
    timeout: 120_000,
  });
}

async function repair(page: Page): Promise<void> {
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 180_000 });
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).not.toHaveAttribute('data-outcome', 'checking', {
    timeout: 180_000,
  });
  // The plan for the repaired mesh settles what, if anything, is left to do.
  await expect(page.getByTestId('repair-op-status-fill-openings')).not.toHaveText(/Checking/, {
    timeout: 120_000,
  });
}

const count = async (page: Page, id: string): Promise<string> =>
  (await page.getByTestId(`issue-count-${id}`).innerText()).trim();

test('A: a repair that leaves nothing detected is "Repair completed"', async ({ page }) => {
  await open(page, 'one-opening.stl', boxWithOneOpeningStl());
  await expect(page.getByTestId('repair-op-status-fill-openings')).toHaveText('1 to fill');
  await expect(page.getByTestId('health-summary')).toHaveText('0 errors · 1 warning');

  await repair(page);
  const card = page.getByTestId('repair-applied');
  await expect(card).toHaveAttribute('data-outcome', 'complete');
  await expect(page.getByTestId('repair-applied-headline')).toHaveText('Repair completed');
  await expect(card).not.toContainText('Partial');
  await expect(page.getByTestId('repair-applied-changes')).toHaveText('1 opening filled');
  // REPAIR-UX-04-R1: nothing remains, so nothing is headed "Still needs
  // attention" — and no placeholder row stands where that section would be.
  await expect(page.getByTestId('repair-applied-remaining')).toHaveCount(0);
  await expect(card).toContainText('Fixed');
  await expect(card).not.toContainText('Still needs attention');
  await expect(card).not.toContainText('No issue types');
  await expect(card.locator('.repair-result__label')).toHaveCount(1);
  // Health reports the model, and now has nothing to report — no "remaining".
  await expect(page.getByTestId('health-summary')).toHaveText('No issues found');
  await expect(page.getByTestId('repair-applied-status')).toHaveText(
    'Repair completed. 1 opening filled. No detected issues remain in the checks Pybrix ran.',
  );
  // What was not checked is still said: complete is not a clean bill of health.
  await expect(page.getByTestId('repair-applied-qualifier')).toContainText(
    'have not yet been checked',
  );
  await expect(page.getByTestId('repair-applied-status')).not.toContainText(/attention/i);

  // At 1440×300 the whole result is in reach, with no gap where a section was.
  await page.setViewportSize({ width: 1440, height: 300 });
  for (const id of [
    'repair-applied-headline',
    'repair-applied-support',
    'repair-applied-changes',
    'repair-applied-qualifier',
    'undo-repair',
  ]) {
    const control = page.getByTestId(id).first();
    await control.scrollIntoViewIfNeeded();
    const probe = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      const footer = document.querySelector('[data-testid="repair-footer"]');
      if (footer === null) throw new Error('No footer');
      return {
        own: target !== null && (element === target || element.contains(target)),
        hit: target?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        bottom: rect.bottom,
        footerTop: footer.getBoundingClientRect().top,
      };
    });
    expect(probe.own, `a click at the centre of ${id} lands on ${String(probe.hit)}`).toBe(true);
    expect(probe.bottom).toBeLessThanOrEqual(probe.footerTop + 1);
  }
  // FIXED is followed directly by the qualifier: one list gap, no empty block.
  const gap = await card.evaluate((element) => {
    const fixed = element.querySelector('[data-testid="repair-applied-changes"]');
    const qualifier = element.querySelector('.repair-result__qualifier');
    if (fixed === null || qualifier === null) throw new Error('No sections');
    return {
      adjacent: fixed.nextElementSibling === qualifier,
      pixels: qualifier.getBoundingClientRect().top - fixed.getBoundingClientRect().bottom,
    };
  });
  expect(gap.adjacent).toBe(true);
  expect(gap.pixels).toBeLessThanOrEqual(12);
});

test('B: a repair that leaves detected issues is "Partial repair completed"', async ({ page }) => {
  await open(page, 'holed-cube.stl', PARTIAL.bytes);
  await expect(page.getByTestId('repair-op-status-fill-openings')).toHaveText('6 to fill');
  const before = await page.getByTestId('health-summary').innerText();
  expect(before).not.toContain('remaining');
  expect(await count(page, 'open-boundaries')).toBe('13');
  expect(await count(page, 'components')).toBe('2');

  await repair(page);
  const card = page.getByTestId('repair-applied');
  await expect(card).toHaveAttribute('data-outcome', 'partial');
  await expect(page.getByTestId('repair-applied-headline')).toHaveText('Partial repair completed');
  await expect(card).not.toContainText('Conservative repair applied');
  await expect(page.getByTestId('repair-applied-support')).toHaveText(
    'Pybrix fixed everything it can currently repair safely on this model.',
  );

  // FIXED and STILL NEEDS ATTENTION, each category with its own count.
  // The six simple openings, and the seven pinched ones the local repair separated and the fill
  // stage then closed: thirteen, each stated in its own terms.
  await expect(page.getByTestId('repair-applied-changes')).toContainText('13 openings filled');
  await expect(page.getByTestId('repair-applied-changes')).toContainText(
    '7 non-manifold vertices repaired',
  );
  expect(await count(page, 'open-boundaries')).toBe('0');
  expect(await count(page, 'components')).toBe('2');
  const pieces = page.getByTestId('repair-remaining-components');
  await expect(pieces).toContainText('2 separate components');
  await expect(pieces).toContainText('Review recommended');
  // The result card and the issue rows are one account of the model.
  for (const row of await page.locator('[data-testid^="repair-remaining-"]').all()) {
    const id = ((await row.getAttribute('data-testid')) ?? '').replace('repair-remaining-', '');
    await expect(row).toContainText(`${await count(page, id)} `);
    await expect(row).toContainText(await page.getByTestId(`issue-status-${id}`).innerText());
  }

  // Health is authoritative: the same counts and tone, marked as what is left.
  const health = page.getByTestId('health-summary');
  await expect(health).toHaveText(/^\d+ errors? · \d+ warnings? remaining$/);
  expect(await health.getAttribute('class')).not.toContain('health-summary--ok');
  // The status bar keeps the plain authoritative counts.
  await expect(page.getByTestId('status-bar')).toContainText(
    (await health.innerText()).replace(' remaining', ''),
  );

  // The disabled action says why repairing again would not help.
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('repair-no-repairs')).toHaveText(
    'Everything Pybrix can safely repair automatically has been fixed.',
  );
  // The reason is drawn in full: no line of it is cut off by the action region.
  const reason = await page.getByTestId('repair-no-repairs').evaluate((element) => {
    const footer = element.closest('[data-testid="repair-footer"]');
    if (footer === null) throw new Error('No footer');
    const style = getComputedStyle(footer);
    return {
      bottom: element.getBoundingClientRect().bottom,
      limit: footer.getBoundingClientRect().bottom - Number.parseFloat(style.paddingBottom),
      clipped: element.scrollHeight > element.clientHeight + 1,
    };
  });
  expect(reason.bottom).toBeLessThanOrEqual(reason.limit + 1);
  expect(reason.clipped).toBe(false);
  await page.getByTestId('repair-no-repairs-info').click();
  await expect(page.getByTestId('repair-no-repairs-detail')).toContainText(
    'Still detected: 2 separate components',
  );

  // One announcement, one card, and an Activity entry about what changed.
  await expect(page.getByTestId('repair-applied-status')).toHaveText(
    'Partial repair completed. 13 openings filled and 7 non-manifold vertices repaired. Some detected issues remain.',
  );
  await expect(page.getByTestId('repair-applied')).toHaveCount(1);
  await expect(page.getByTestId('status-list')).toContainText(
    'Repair applied: 13 openings filled and 7 non-manifold vertices repaired. Health shows what remains.',
  );
  // Nowhere is a total of unlike things printed.
  await expect(page.getByTestId('status-list')).not.toContainText(/found [\d,]+ issues/);
});

test('C: a model with nothing Pybrix can repair shows no outcome at all', async ({ page }) => {
  await open(page, 'piece-only.stl', NO_FIX.bytes);
  await expect(page.getByTestId('repair-op-status-fill-openings')).toHaveText('None eligible');
  await expect(page.getByTestId('repair-applied')).toHaveCount(0);
  await expect(page.getByTestId('repair-applied-status')).toHaveCount(0);
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('repair-no-repairs')).toHaveText(
    'No safe automatic repairs are available for the detected issues.',
  );
  const health = page.getByTestId('health-summary');
  await expect(health).toHaveText(/^\d+ errors? · \d+ warnings?$/);
  await expect(page.getByTestId('issue-status-open-boundaries')).toHaveText('No issue');
});

test('D: Undo restores the geometry and takes every post-repair wording with it', async ({
  page,
}) => {
  await open(page, 'holed-cube.stl', PARTIAL.bytes);
  const healthBefore = await page.getByTestId('health-summary').innerText();
  const trianglesBefore = await page.getByTestId('status-triangles').innerText();
  await repair(page);
  await expect(page.getByTestId('health-summary')).toContainText('remaining');

  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId('repair-op-status-fill-openings')).toHaveText('6 to fill', {
    timeout: 120_000,
  });
  expect(await count(page, 'open-boundaries')).toBe('13');
  await expect(page.getByTestId('status-triangles')).toHaveText(trianglesBefore);
  await expect(page.getByTestId('health-summary')).toHaveText(healthBefore);
  await expect(page.getByTestId('repair-applied-status')).toHaveCount(0);
  await expect(page.getByTestId('repair-workspace')).not.toContainText('has been fixed');
  await expect(page.getByTestId('preview-repair')).toBeEnabled();

  // RETRY: the same repair gives the same result — once.
  await repair(page);
  await expect(page.getByTestId('repair-applied')).toHaveCount(1);
  await expect(page.getByTestId('repair-applied-headline')).toHaveText('Partial repair completed');
  await expect(page.getByTestId('repair-applied-changes')).toContainText('13 openings filled');
  expect(await count(page, 'open-boundaries')).toBe('0');
  await expect(page.getByTestId('repair-applied-status')).toHaveCount(1);
});

test('E: opening another model takes the previous outcome with it', async ({ page }) => {
  await open(page, 'holed-cube.stl', PARTIAL.bytes);
  await repair(page);
  await expect(page.getByTestId('health-summary')).toContainText('remaining');

  await pick(page, 'piece-only.stl', 'model/stl', Buffer.from(NO_FIX.bytes));
  await expect(page.getByTestId('fact-filename')).toHaveText('piece-only.stl', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('repair-op-status-fill-openings')).toHaveText('None eligible', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('repair-applied')).toHaveCount(0);
  await expect(page.getByTestId('repair-applied-status')).toHaveCount(0);
  await expect(page.getByTestId('health-summary')).not.toContainText('remaining');
  // The reason is the new model's own: nothing was repaired on it.
  await expect(page.getByTestId('repair-no-repairs')).toHaveText(
    'No safe automatic repairs are available for the detected issues.',
  );
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 1440, height: 380 },
  { width: 1440, height: 300 },
  { width: 1280, height: 300 },
  { width: 768, height: 1024 },
  { width: 430, height: 932 },
]) {
  test(`F: the partial result is fully reachable at ${String(viewport.width)}×${String(viewport.height)}`, async ({
    page,
  }) => {
    await open(page, 'holed-cube.stl', PARTIAL.bytes);
    await repair(page);
    await page.setViewportSize(viewport);
    const toggle = page.getByTestId('toggle-tool-drawer');
    if (
      (await toggle.isVisible()) &&
      (await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open'
    ) {
      await toggle.click();
    }
    const panel = page.getByTestId('tool-panel');
    let previous = Number.NaN;
    await expect
      .poll(async () => {
        const left = (await panel.boundingBox())?.x ?? Number.NaN;
        const settled = left === previous && left >= 0;
        previous = left;
        return settled;
      })
      .toBe(true);

    // Every part of the account can be brought above the action region and is
    // what a click at its centre would reach.
    for (const id of [
      'repair-heading',
      'health-summary',
      'repair-applied-headline',
      'repair-applied-support',
      'repair-applied-changes',
      'repair-remaining-components',
      'undo-repair',
      'repair-no-repairs',
      'repair-no-repairs-info',
    ]) {
      const control = page.getByTestId(id).first();
      await control.scrollIntoViewIfNeeded();
      const probe = await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const target = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        const footer = document.querySelector('[data-testid="repair-footer"]');
        const scroller = document.querySelector('.tool-panel__body');
        const activity = document.querySelector('.tool-panel__footer');
        if (footer === null || scroller === null || activity === null) throw new Error('No layout');
        const region = footer.getBoundingClientRect();
        return {
          own: target !== null && (element === target || element.contains(target)),
          hit: target?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
          inFooter: footer.contains(element),
          bottom: rect.bottom,
          height: rect.height,
          footerTop: region.top,
          room: region.top - scroller.getBoundingClientRect().top,
          footerClear: region.bottom <= activity.getBoundingClientRect().top + 1,
          footerHeight: region.height,
          cap: Number.parseFloat(
            getComputedStyle(scroller).getPropertyValue('--action-footer-max'),
          ),
        };
      });
      expect(probe.own, `a click at the centre of ${id} lands on ${String(probe.hit)}`).toBe(true);
      if (!probe.inFooter && probe.height <= probe.room) {
        expect(probe.bottom, `${id} is under the action region`).toBeLessThanOrEqual(
          probe.footerTop + 1,
        );
      }
      expect(probe.footerClear, 'action region clear of Activity').toBe(true);
      expect(probe.footerHeight).toBeLessThanOrEqual(probe.cap);
    }
    await expect(page.getByTestId('repair-applied-headline')).toHaveText(
      'Partial repair completed',
    );
    // And Undo is not merely reachable.
    await page.getByTestId('undo-repair').click();
    await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
  });
}
