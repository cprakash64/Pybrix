import type { Locator, Page } from '@playwright/test';

/** Open the existing controls as a user would before exercising an advanced capability. */
export async function revealControl(page: Page, target: Locator): Promise<void> {
  await target.waitFor({ state: 'attached' });
  if (
    await target.evaluate(
      (element) =>
        element.closest('details:not([open])')?.classList.contains('activity-disclosure') === true,
    )
  )
    await page.locator('.activity-disclosure > summary').click();
  const adjust = page.getByRole('button', { name: 'Adjust cut', exact: true });
  if (!(await target.isVisible()) && (await adjust.isVisible())) await adjust.click();
  const buttons = await target.evaluate((element) => {
    const ancestors: Element[] = [];
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (parent.matches('.panel-section')) ancestors.unshift(parent);
    }
    return ancestors
      .map((section) => section.querySelector(':scope > h2 > button'))
      .filter((button): button is Element => button !== null)
      .map((button) => button.getAttribute('aria-controls'))
      .filter((id): id is string => id !== null);
  });
  for (const id of buttons) {
    const button = page.locator(`button[aria-controls="${id}"]`);
    if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
  }
}
