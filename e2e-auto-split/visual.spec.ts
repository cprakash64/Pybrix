import { revealControl } from '../e2e/progressive-disclosure';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  carMultipart,
  humanFigure,
  openCube,
  toBinaryStl,
  truckFused,
  type ScenarioName,
} from '@cadfixer/auto-split/fixtures';
import type { CanonicalMesh } from '@cadfixer/mesh-core';

/**
 * VISUAL REVIEW CAPTURE. Run on demand — `AUTO_SPLIT_SCREENSHOTS=1 npm run test:e2e:auto-split -- visual` —
 * never as part of the assertions suite. It writes PNGs of every Auto Split state at five viewport sizes
 * into `artifacts/auto-split-visual/` (not committed), for a person to look at. It asserts only the
 * invariants a screenshot cannot show: the shell does not scroll sideways at any size, and no target on
 * a phone is smaller than 40 px.
 */
const SERVICE = 'http://127.0.0.1:8787';
const OUT = join(import.meta.dirname, '..', 'artifacts', 'auto-split-visual');
const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1600, height: 900 },
  { name: 'large', width: 2200, height: 1200 },
] as const;

test.skip(process.env.AUTO_SPLIT_SCREENSHOTS !== '1', 'screenshots are captured on demand');

async function control(
  page: Page,
  body: { scenario?: ScenarioName; behaviour?: string; delayMs?: number },
): Promise<void> {
  expect(
    (await page.request.post(`${SERVICE}/api/auto-split/__mock/scenario`, { data: body })).ok(),
  ).toBe(true);
}

async function openMesh(page: Page, name: string, mesh: CanonicalMesh): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name, mimeType: 'model/stl', buffer: Buffer.from(toBinaryStl(mesh)) });
  await expect(page.getByTestId('fact-triangles')).toHaveText(
    (mesh.indices.length / 3).toLocaleString('en-US'),
    {
      timeout: 90_000,
    },
  );
}

async function enter(page: Page, opts: { manualShot?: () => Promise<void> } = {}): Promise<void> {
  // Wide windows have the workspace tabs; narrower ones a switcher, and the tool panel is a drawer.
  const direct = page.getByTestId('workflow-split');
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-option-split').click();
  }
  if (!(await page.getByTestId('tool-panel').isVisible()))
    await page.getByTestId('toggle-tool-drawer').click();
  if (opts.manualShot !== undefined) await opts.manualShot();
  await page.getByTestId('split-tab-auto').click();
}

async function shot(page: Page, size: string, state: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${size}-${state}.png`) });
}

let ip = 0;
/** A client address of its own for each stage: the service allows three analyses per address. */
async function freshClient(page: Page): Promise<void> {
  ip += 1;
  await page.setExtraHTTPHeaders({
    'x-real-ip': `10.${String(200 + (ip >> 8))}.${String(ip & 255)}.9`,
  });
}

for (const size of SIZES) {
  test(`${size.name}: every Auto Split state`, async ({ page }) => {
    await freshClient(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.request.post(`${SERVICE}/api/auto-split/__mock/reset`);
    await page.goto('/');
    await openMesh(page, 'figure.stl', humanFigure().mesh);
    await enter(page, { manualShot: () => shot(page, size.name, '00-manual-default') });

    await shot(page, size.name, '01-empty');
    await revealControl(page, page.getByTestId('auto-kind-human'));
    await page.getByTestId('auto-kind-human').check({ force: true });
    await shot(page, size.name, '02-disclosure');
    await page.getByTestId('auto-disclosure-continue').click();
    await shot(page, size.name, '03-ready');

    await control(page, { behaviour: 'slow' });
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-status')).toContainText('Looking for parts…', {
      timeout: 60_000,
    });
    await shot(page, size.name, '04-analyzing');
    await page.getByTestId('auto-cancel').click();
    await shot(page, size.name, '05-cancelled');

    await control(page, { behaviour: 'unavailable' });
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-error')).toBeVisible({ timeout: 60_000 });
    await shot(page, size.name, '06-error');
    await page.getByTestId('auto-start-over').click();

    await control(page, { behaviour: 'ok', scenario: 'human-ok' });
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
    await shot(page, size.name, '07-human-suggestions');
    await revealControl(page, page.getByTestId('auto-edit-left_arm'));
    await page.getByTestId('auto-edit-left_arm').click();
    await shot(page, size.name, '08-plane-edit');
    await page.getByTestId('auto-preview-head').click();
    await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
    await shot(page, size.name, '09-preview');

    if (size.name === 'phone') {
      // The touch-target floor (UI-06): every button and chip is at least 40 px tall on a phone.
      const small = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[data-testid^="auto-"] button, .auto-chip, .split-mode-tabs__tab',
          ),
        ]
          .map((el) => ({
            id: el.getAttribute('data-testid') ?? el.className,
            h: el.getBoundingClientRect().height,
          }))
          .filter((x) => x.h > 0 && x.h < 40),
      );
      expect(small).toEqual([]);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // A vehicle, with its component highlight, and a model that must be repaired first.
    await freshClient(page);
    await page.goto('/');
    await control(page, { scenario: 'vehicle-component' });
    await openMesh(page, 'car.stl', carMultipart().mesh);
    await enter(page);
    await revealControl(page, page.getByTestId('auto-kind-vehicle'));
    await page.getByTestId('auto-kind-vehicle').check({ force: true });
    await page.getByTestId('auto-disclosure-continue').click();
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
    const wheel = page.locator('[data-testid^="auto-row-wheel:"]').first();
    const id = ((await wheel.getAttribute('data-testid')) ?? '').replace('auto-row-', '');
    await page.getByTestId(`auto-show-${id}`).click();
    await page.waitForTimeout(600);
    await shot(page, size.name, '10-vehicle-component-highlight');

    await control(page, { scenario: 'vehicle-ambiguous-wheel' });
    await freshClient(page);
    await page.goto('/');
    await openMesh(page, 'car2.stl', carMultipart().mesh);
    await enter(page);
    await revealControl(page, page.getByTestId('auto-kind-vehicle'));
    await page.getByTestId('auto-kind-vehicle').check({ force: true });
    await page.getByTestId('auto-disclosure-continue').click();
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
    const loose = page.locator('[data-testid^="auto-edit-wheel:"]').first();
    await loose.click();
    await expect(page.getByTestId('auto-components')).toBeVisible();
    await shot(page, size.name, '10b-review-selection');

    await control(page, { scenario: 'vehicle-truck-plane' });
    await freshClient(page);
    await page.goto('/');
    await openMesh(page, 'truck.stl', truckFused().mesh);
    await enter(page);
    await revealControl(page, page.getByTestId('auto-kind-vehicle'));
    await page.getByTestId('auto-kind-vehicle').check({ force: true });
    await page.getByTestId('auto-disclosure-continue').click();
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
    await revealControl(page, page.getByTestId('auto-edit-cab_bed'));
    await page.getByTestId('auto-edit-cab_bed').click();
    await shot(page, size.name, '11-vehicle-cab-bed-plane');

    await freshClient(page);
    await page.goto('/');
    await control(page, { scenario: 'human-ok' });
    await openMesh(page, 'open.stl', openCube().mesh);
    await enter(page);
    await revealControl(page, page.getByTestId('auto-kind-human'));
    await page.getByTestId('auto-kind-human').check({ force: true });
    await page.getByTestId('auto-disclosure-continue').click();
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('auto-source-not-ready')).toHaveCount(0);
    await shot(page, size.name, '12-open-source-ready');

    await revealControl(page, page.getByTestId('auto-kind-other'));
    await page.getByTestId('auto-kind-other').check({ force: true });
    await shot(page, size.name, '13-other-kind');
  });
}
