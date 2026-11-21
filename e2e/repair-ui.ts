import { revealControl } from './progressive-disclosure';
import type { Page } from '@playwright/test';

/**
 * REPAIR-UX-01 disclosure helpers.
 *
 * The full Mesh Health report, the exclusions and the filling limits live in
 * the collapsed "Advanced diagnostics" section, and a repair preview's metrics
 * and change overlays behind "Preview details". A spec that asserts one of
 * those is VISIBLE, or clicks a control inside one, opens it first — exactly as
 * a user would. Reading text does not need this: a collapsed section is still
 * in the document.
 */
export async function openAdvancedDiagnostics(page: Page): Promise<void> {
  await revealControl(page, page.getByTestId('advanced-diagnostics'));
  const toggle = page
    .getByTestId('advanced-diagnostics')
    .getByRole('button', { name: 'Advanced diagnostics', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

export async function openPreviewDetails(page: Page): Promise<void> {
  await revealControl(page, page.getByTestId('repair-preview-details-toggle'));
  const toggle = page.getByTestId('repair-preview-details-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}
