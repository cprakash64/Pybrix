import { expect, test, type Locator, type Page } from '@playwright/test';
import { pinchedPairsStl } from '../e2e/local-repair-fixtures';
import { enter, pick } from '../e2e/ui-fixtures';

/**
 * REPAIR-CORE-07 — THE COMPLEXITY LIMIT THROUGH THE PUBLIC UI, ON THE HARNESS PAGE.
 *
 * The production application has no way to narrow its work limit (a public URL option was removed
 * in REPAIR-CORE-07). The harness page can, through an internal context, so a small model reaches
 * the typed limit; everything the user sees and does is still the real application UI.
 *
 * No bridge: a file goes in through the file chooser and everything after it is a click on a
 * control a user can see. The real worker, kernel worker and analysis hook do the rest.
 */

test.describe.configure({ timeout: 240_000 });

async function open(page: Page, name: string, bytes: Buffer, url = '/'): Promise<void> {
  await page.goto(url);
  await pick(page, name, 'model/stl', bytes);
  await enter(page, 'repair');
  // On a phone the tool panel is a drawer; open it as a person would.
  const toggle = page.getByTestId('toggle-tool-drawer');
  if (
    (await toggle.isVisible()) &&
    (await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open'
  ) {
    await toggle.click();
  }
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
}

const count = (page: Page, id: string): Locator => page.getByTestId(`issue-count-${id}`);

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 60_000 });
}

test('LIMIT: a complex model reaches the safe limit, shown as a partial result, and can be applied', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // A narrowed limit (URL option, narrowing only) so a small model reaches the typed limit.
  await open(page, 'many.stl', pinchedPairsStl(120), '/?repairWorkCeiling=1500');
  await expect(count(page, 'non-manifold-vertices')).toHaveText('120');
  await expect(page.getByTestId('repair-work-ceiling-note')).toBeVisible();
  await ready(page);
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('repair-summary')).toHaveAttribute('data-outcome', 'partial-limit');
  await expect(page.getByTestId('repair-summary-support')).toContainText(
    'too complex for this automatic repair pass',
  );
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  // Some, not all, are repaired: the model is valid and the rest is still reported.
  await expect
    .poll(async () => Number(await count(page, 'non-manifold-vertices').textContent()), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  expect(Number(await count(page, 'non-manifold-vertices').textContent())).toBeLessThan(120);
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
});
