import { expect, type Page } from '@playwright/test';

/**
 * Opens the Inspector the way a user does, at whatever width the page is.
 *
 * PYBRIX-08A made the Inspector collapsed by default, so a test that reads or
 * operates one of ITS controls (the Model facts, the export buttons, the part
 * selector, a selected finding) must open it first. Idempotent: an Inspector
 * that is already open is left alone.
 *
 * Wide screens dock it behind a rail button; below 1200 px it is a drawer behind
 * the top bar's toggle. Nothing here reaches into the application's state.
 */
export async function openInspector(page: Page): Promise<void> {
  const inspector = page.getByTestId('inspector');
  if (await inspector.isVisible()) return;
  const rail = page.getByTestId('expand-inspector');
  const drawer = page.getByTestId('toggle-inspector-drawer');
  if (await rail.isVisible()) await rail.click();
  else if (await drawer.isVisible()) await drawer.click();
  await expect(inspector).toBeVisible();
}
