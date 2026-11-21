import { expect, test, type Page } from '@playwright/test';
import { openAdvancedDiagnostics } from './repair-ui';
import { revealControl } from './progressive-disclosure';
import { analysisHeavyStl } from './stl-fixtures';

async function settledFrames(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const canvas = document.querySelector<HTMLCanvasElement>(
              '[data-testid="viewport-canvas"] canvas',
            );
            resolve(Number(canvas?.dataset.renderedFrames));
          });
        });
      }),
  );
}

async function analyzeAgain(page: Page): Promise<void> {
  const completed = await page.getByTestId('status-list').evaluate((element) => {
    return element.textContent.match(/Mesh analysis:/g)?.length ?? 0;
  });
  await page.getByTestId('rerun-analysis').click();
  await page.waitForFunction((previous: number) => {
    const entries = document.querySelector('[data-testid="status-list"]')?.textContent;
    return (entries?.match(/Mesh analysis:/g)?.length ?? 0) > previous;
  }, completed);
  await expect(page.getByTestId('rerun-analysis')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Above the automatic self-intersection band, so the only requested change
  // after import is the topology report. No timing-specific workload or flag.
  const model = analysisHeavyStl(120);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'surface.stl', mimeType: 'model/stl', buffer: model.bytes });
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await openAdvancedDiagnostics(page);
});

test('a completed hidden diagnostic update retains the report without repainting the surface', async ({
  page,
}) => {
  const report = await page.getByTestId('health-topology').innerText();
  const before = await settledFrames(page);
  expect(before).toBeGreaterThan(0);
  await analyzeAgain(page);
  expect(await page.getByTestId('health-topology').innerText()).toBe(report);
  expect(await settledFrames(page)).toBe(before);
});

test('staged diagnostic geometry still draws, updates and clears when made visible', async ({
  page,
}) => {
  const toggle = page.getByTestId('overlay-toggle-boundaryEdges');
  const before = await settledFrames(page);
  await toggle.check();
  const shown = await settledFrames(page);
  expect(shown).toBeGreaterThan(before);
  await analyzeAgain(page);
  const updated = await settledFrames(page);
  expect(updated).toBeGreaterThan(shown);
  await toggle.uncheck();
  expect(await settledFrames(page)).toBeGreaterThan(updated);
  await expect(page.getByTestId('fact-triangles')).toHaveText('28,800');
});
