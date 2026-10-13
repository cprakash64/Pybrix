import { revealControl } from '../e2e/progressive-disclosure';
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  carFused,
  carMultipart,
  humanFigure,
  openCube,
  toBinaryStl,
  truckFused,
  type ScenarioName,
} from '@cadfixer/auto-split/fixtures';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { openInspector } from '../e2e/inspector';

/**
 * AUTO SPLIT, END TO END (PYBRIX-08B-PROD-A1).
 *
 * The shipped application with the real geometry worker, the real same-origin service and a
 * deterministic provider. What these prove is what the product promises: the model is never changed by
 * an analysis, only a user's Apply changes it, one Apply is one Undo, the request carries six images and
 * three numbers and nothing else, and every failure leaves the model exactly as it was.
 */

const SERVICE = 'http://127.0.0.1:8787';
let counter = 0;

async function control(
  page: Page,
  body: { scenario?: ScenarioName; behaviour?: string; delayMs?: number },
): Promise<void> {
  const response = await page.request.post(`${SERVICE}/api/auto-split/__mock/scenario`, {
    data: body,
  });
  expect(response.ok()).toBe(true);
}
async function mockState(page: Page): Promise<{
  received: { mode: string; protocolVersion: string; imageCount: number; imageBytes: number[] }[];
  aborted: number;
  completed: number;
}> {
  const response = await page.request.get(`${SERVICE}/api/auto-split/__mock/state`);
  return (await response.json()) as never;
}

test.beforeEach(async ({ page }) => {
  counter += 1;
  // Each test is its own client as far as the rate limiter is concerned.
  await page.setExtraHTTPHeaders({
    'x-real-ip': `10.${String(counter >> 8)}.${String(counter & 255)}.7`,
  });
  await page.request.post(`${SERVICE}/api/auto-split/__mock/reset`);
  await page.goto('/');
});

async function openMesh(page: Page, name: string, mesh: CanonicalMesh): Promise<number> {
  const bytes = toBinaryStl(mesh);
  const triangles = mesh.indices.length / 3;
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 90_000,
  });
  return triangles;
}

async function enterAuto(page: Page): Promise<void> {
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  await page.getByTestId('split-tab-auto').click();
}

async function accept(page: Page, kind: 'human' | 'vehicle'): Promise<void> {
  await page.getByTestId(`auto-kind-${kind}`).check({ force: true });
  await expect(page.getByTestId('auto-disclosure')).toBeVisible();
  await page.getByTestId('auto-disclosure-continue').click();
}

async function findParts(page: Page): Promise<void> {
  await page.getByTestId('auto-analyze').click();
}

async function previewAndApply(page: Page, previewId: string): Promise<void> {
  await page.getByTestId(`auto-preview-${previewId}`).click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('split-apply')).toBeEnabled();
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-undo')).toBeVisible({ timeout: 60_000 });
}

const triangleCount = async (page: Page): Promise<string> =>
  (await page.getByTestId('fact-triangles').textContent()) ?? '';

/** Reads a PNG's signature and IHDR from base64. */
function describePng(base64: string): {
  signature: boolean;
  width: number;
  height: number;
  depth: number;
  color: number;
} {
  const bytes = Buffer.from(base64, 'base64');
  return {
    signature: bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    depth: bytes.readUInt8(24),
    color: bytes.readUInt8(25),
  };
}

test('character: disclosure, six views and three numbers, a head suggestion, preview, apply and undo', async ({
  page,
}) => {
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) requests.push(request);
  });
  const thirdParty: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== new URL(page.url()).origin &&
      !url.protocol.startsWith('blob') &&
      !url.protocol.startsWith('data')
    )
      thirdParty.push(request.url());
  });

  const figure = humanFigure().mesh;
  const triangles = await openMesh(page, 'my-private-figure.stl', figure);
  await enterAuto(page);

  // Nothing has been sent: not on opening the tab, not on choosing a type.
  await page.getByTestId('auto-kind-human').check({ force: true });
  await expect(page.getByTestId('auto-disclosure-text')).toHaveText(
    /six rendered views and limited model metadata/,
  );
  expect(requests).toHaveLength(0);
  await page.getByTestId('auto-disclosure-continue').click();
  expect(requests).toHaveLength(0);

  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  expect(requests).toHaveLength(1);

  // THE PRIVACY PAYLOAD AUDIT: six images, three numbers, a mode and a version. No file, no name.
  const request = requests[0];
  expect(request?.method()).toBe('POST');
  expect(new URL(request?.url() ?? '').pathname).toBe('/api/auto-split/analyze');
  const raw = request?.postData() ?? '';
  const body = JSON.parse(raw) as {
    requestId: string;
    mode: string;
    protocolVersion: string;
    views: { view: string; png: string }[];
    summary: { extents: number[]; shells: number; radius: number };
  };
  expect(Object.keys(body).sort()).toEqual([
    'mode',
    'protocolVersion',
    'requestId',
    'summary',
    'views',
  ]);
  expect(body.mode).toBe('human');
  expect(body.views.map((v) => v.view)).toEqual([
    'front',
    'rear',
    'left',
    'right',
    'top',
    'bottom',
  ]);
  for (const view of body.views) {
    expect(Object.keys(view).sort()).toEqual(['png', 'view']);
    expect(describePng(view.png)).toEqual({
      signature: true,
      width: 512,
      height: 512,
      depth: 8,
      color: 2,
    });
  }
  expect(Object.keys(body.summary).sort()).toEqual(['extents', 'radius', 'shells']);
  expect(raw).not.toContain('my-private-figure');
  expect(raw).not.toMatch(/positions|indices|vertices|triangles|faces|"stl"/i);
  expect(raw.length).toBeLessThan(6 * 700_000);
  const server = await mockState(page);
  expect(server.received).toHaveLength(1);
  expect(server.received[0]?.imageCount).toBe(6);
  expect(thirdParty, 'nothing leaves the origin').toEqual([]);

  // The Inspector is never opened for the person: collapsed before, collapsed now.
  await expect(page.getByTestId('inspector-rail')).toBeVisible();
  await expect(page.getByTestId('inspector')).toBeHidden();

  // Suggestions are rows with a status, never a number.
  await expect(page.getByTestId('auto-row-status-head')).toHaveText('Suggested cut');
  await expect(page.getByTestId('auto-row-status-left_arm')).toHaveText('Suggested cut');
  await expect(page.getByTestId('auto-row-status-right_arm')).toHaveText('Suggested cut');
  await expect(page.getByTestId('auto-results')).not.toContainText('%');

  // READY IS NOT APPLIED: the model is exactly what was imported.
  expect(await triangleCount(page)).toBe(triangles.toLocaleString('en-US'));
  await expect(page.getByTestId('split-undo')).toHaveCount(0);

  // Preview, then the user's own Apply: one transaction.
  await previewAndApply(page, 'head');
  expect(await triangleCount(page)).not.toBe(triangles.toLocaleString('en-US'));

  await expect(page.getByTestId('inspector')).toBeHidden();

  // The remaining suggestions are stale and Re-analyze is offered.
  await expect(page.getByTestId('auto-stale')).toBeVisible();
  await expect(page.getByTestId('auto-preview-left_arm')).toBeDisabled();
  await expect(page.getByTestId('auto-reanalyze')).toBeVisible();

  // One Undo restores the exact model.
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 60_000,
  });
  expect(thirdParty).toEqual([]);
});

test('vehicle: separate wheels become components that preview, apply and undo', async ({
  page,
}) => {
  await control(page, { scenario: 'vehicle-component' });
  const car = carMultipart().mesh;
  const triangles = await openMesh(page, 'car.stl', car);
  await enterAuto(page);
  await accept(page, 'vehicle');
  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  const wheel = page.locator('[data-testid^="auto-row-wheel:"]').first();
  await expect(wheel).toBeVisible();
  const testId = (await wheel.getAttribute('data-testid')) ?? '';
  const id = testId.replace('auto-row-', '');
  await expect(page.getByTestId(`auto-row-status-${id}`)).toHaveText(/Suggested cut/);

  // Highlight before preview: the eye draws the components on the model.
  await page.getByTestId(`auto-show-${id}`).click();
  await expect(page.locator('[data-testid="viewport-canvas"] canvas')).toHaveAttribute(
    'data-face-highlight-objects',
    '1',
    { timeout: 20_000 },
  );

  await previewAndApply(page, id);
  await revealControl(page, page.getByTestId('split-piece-a'));
  await expect(page.getByTestId('split-piece-a')).toBeVisible();
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 60_000,
  });
});

test('vehicle: a fused cab and bed is offered as one cut to review, and it previews and applies', async ({
  page,
}) => {
  await control(page, { scenario: 'vehicle-truck-plane' });
  const triangles = await openMesh(page, 'truck.stl', truckFused().mesh);
  await enterAuto(page);
  await accept(page, 'vehicle');
  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('auto-row-status-cab_bed')).toHaveText('Suggested cut');
  await expect(page.getByTestId('auto-row-cab_bed')).toContainText('Beta');
  // Editing it is editing Manual Split's own plane.
  await revealControl(page, page.getByTestId('auto-edit-cab_bed'));
  await page.getByTestId('auto-edit-cab_bed').click();
  await expect(page.getByTestId('split-position-slider')).toBeVisible();
  // A binary STL states no unit: analysis was allowed, and connectors stay locked until the person
  // chooses how to read the numbers.
  await revealControl(page, page.getByTestId('split-connectors-unit'));
  await expect(page.getByTestId('split-connectors-unit')).toBeVisible();
  await expect(page.getByTestId('split-connector-pin')).toBeDisabled();
  await expect(page.getByTestId('split-connector-dovetail')).toBeDisabled();
  await previewAndApply(page, 'cab_bed');
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 60_000,
  });
});

test('wheels fused into a body are "No safe split found", with nothing to preview', async ({
  page,
}) => {
  await control(page, { scenario: 'vehicle-wheels-fused' });
  await openMesh(page, 'fused-car.stl', carFused().mesh);
  await enterAuto(page);
  await accept(page, 'vehicle');
  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('[data-testid^="auto-row-status-"]').first()).toHaveText(
    'No separate part found',
  );
  await expect(page.locator('[data-testid^="auto-preview-"]').first()).toBeDisabled();
});

test('an open model has no global repair gate and can use a plain manual cut', async ({ page }) => {
  await openMesh(page, 'open.stl', openCube().mesh);
  await enterAuto(page);
  await accept(page, 'human');
  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('auto-source-not-ready')).toHaveCount(0);
  await expect(page.getByTestId('auto-row-status-head')).not.toHaveText('Repair model first');
  await page.getByTestId('split-tab-manual').click();
  await expect(page.getByTestId('split-preview')).toBeEnabled();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
});

test('cancel aborts the request, reaches the service, and leaves the model unchanged', async ({
  page,
}) => {
  await control(page, { behaviour: 'slow' });
  const figure = humanFigure().mesh;
  const triangles = await openMesh(page, 'figure.stl', figure);
  await enterAuto(page);
  await accept(page, 'human');
  await findParts(page);
  await expect(page.getByTestId('auto-progress')).toBeVisible();
  await expect(page.getByTestId('auto-status')).toContainText(/looking for parts/i, {
    timeout: 60_000,
  });
  await page.getByTestId('auto-cancel').click();
  await expect(page.getByTestId('auto-cancelled')).toBeVisible();
  await expect.poll(async () => (await mockState(page)).aborted, { timeout: 15_000 }).toBe(1);
  expect(await triangleCount(page)).toBe(triangles.toLocaleString('en-US'));
  await expect(page.getByTestId('auto-results')).toHaveCount(0);
});

test('a model replaced during analysis never receives the old answer', async ({ page }) => {
  await control(page, { behaviour: 'ok', delayMs: 4000 });
  await openMesh(page, 'figure.stl', humanFigure().mesh);
  await enterAuto(page);
  await accept(page, 'human');
  await findParts(page);
  await expect(page.getByTestId('auto-status')).toContainText(/looking for parts/i, {
    timeout: 60_000,
  });
  // Another model is opened while the analysis is in flight.
  await openMesh(page, 'car.stl', carMultipart().mesh);
  await expect
    .poll(async () => (await mockState(page)).completed + (await mockState(page)).aborted, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('auto-results')).toHaveCount(0);
  await expect(page.getByTestId('auto-progress')).toHaveCount(0);
});

test('a failure of the service is a decision with our own sentence, and Try again recovers', async ({
  page,
}) => {
  await openMesh(page, 'figure.stl', humanFigure().mesh);
  await enterAuto(page);
  await accept(page, 'human');
  for (const [behaviour, sentence] of [
    ['malformed', /could not use/i],
    ['unavailable', /unavailable/i],
  ] as const) {
    await control(page, { behaviour });
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-error-message')).toHaveText(sentence, { timeout: 60_000 });
    await expect(page.getByTestId('auto-error-detail')).toHaveText('Your model was not changed.');
    await page.getByTestId('auto-start-over').click();
  }
  await control(page, { behaviour: 'ok' });
  await page.getByTestId('auto-analyze').click();
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
});

test('the fourth analysis from one client is refused with a wait, and Manual Split still works', async ({
  page,
}) => {
  await openMesh(page, 'figure.stl', humanFigure().mesh);
  await enterAuto(page);
  await accept(page, 'human');
  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  for (let i = 0; i < 2; i += 1) {
    await page.getByTestId('auto-reanalyze-fresh').click();
    await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  }
  await page.getByTestId('auto-reanalyze-fresh').click();
  await expect(page.getByTestId('auto-error')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('auto-error-message')).toContainText(/used a lot/i);
  await expect(page.getByTestId('auto-error-detail')).toContainText(/Try again in about/);
  // Manual Split is untouched by it.
  await page.getByTestId('split-tab-manual').click();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
});

test('Manual Split and Repair make no semantic request at all', async ({ page }) => {
  const api: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) api.push(request.url());
  });
  await openMesh(page, 'figure.stl', humanFigure().mesh);
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('split-discard').click();
  await page.getByTestId('workflow-repair').click();
  await page.waitForTimeout(1500);
  // Merely opening the Auto Split tab sends nothing either.
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await page.waitForTimeout(500);
  expect(api).toEqual([]);
});

test('keyboard only: type, disclosure, analysis and preview are all reachable, and focus is placed deliberately', async ({
  page,
}) => {
  await openMesh(page, 'figure.stl', humanFigure().mesh);
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();

  // The tabs are a roving tablist: Enter and arrows work, and the selected tab is the one in the order.
  await page.getByTestId('split-tab-manual').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('split-tab-auto')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('split-tab-auto')).toBeFocused();

  // A radio group: Space chooses, and choosing moves focus to the disclosure's heading, so a
  // keyboard or screen-reader user meets what would send data before anything else.
  await page.getByTestId('auto-kind-human').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('auto-disclosure')).toBeVisible();
  // The heading takes focus, not the group: the active element is inside the disclosure.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('[data-testid="auto-disclosure"]') !== null,
      ),
    )
    .toBe(true);
  await page.keyboard.press('Tab'); // Cancel
  await page.keyboard.press('Tab'); // Continue
  await expect(page.getByTestId('auto-disclosure-continue')).toBeFocused();
  await page.keyboard.press('Enter');

  await page.getByTestId('auto-analyze').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });

  // Every suggestion's controls are named for assistive technology, and statuses are words.
  await expect(page.getByTestId('auto-show-head')).toHaveAttribute(
    'aria-label',
    /Show on model: Head/,
  );
  await expect(page.getByTestId('auto-row-status-head')).toHaveText('Suggested cut');
  await expect(page.getByTestId('auto-preview-head')).toHaveAccessibleDescription(/clear match/i);

  await page.getByTestId('auto-preview-head').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
  // Nothing was applied by a key press that previewed.
  await expect(page.getByTestId('split-undo')).toHaveCount(0);
});

test('Split opens on Manual Split, and the Auto Split tab and a cancelled disclosure cost nothing', async ({
  page,
}) => {
  const api: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) api.push(request.url());
  });
  await openMesh(page, 'figure.stl', humanFigure().mesh);
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  // The qualified, local workflow is what opens: not the cloud one.
  await expect(page.getByTestId('split-tab-manual')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('split-tab-auto')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('split-position-slider')).toBeVisible();
  await expect(page.getByTestId('auto-split-panel')).toHaveCount(0);
  await expect(page.getByTestId('auto-beta-badge')).toBeVisible();

  await page.getByTestId('split-tab-auto').click();
  await page.getByTestId('auto-kind-vehicle').check({ force: true });
  await page.getByTestId('auto-disclosure-cancel').click();
  await expect(page.getByTestId('split-tab-manual')).toBeFocused();
  await expect(page.getByTestId('split-tab-manual')).toHaveAttribute('aria-selected', 'true');
  // Only an explicit Find parts can send anything.
  expect(api).toEqual([]);
  expect((await mockState(page)).received).toHaveLength(0);
});

test('a long analysis never looks broken: honest wording, Cancel in reach, a live page, one request', async ({
  page,
}) => {
  await control(page, { behaviour: 'ok', delayMs: 12_000 });
  await openMesh(page, 'figure.stl', humanFigure().mesh);
  await enterAuto(page);
  await accept(page, 'human');
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean };
    w.__gaps = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      w.__gaps.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await findParts(page);
  await expect(page.getByTestId('auto-status')).toContainText(/looking for parts/i, {
    timeout: 30_000,
  });
  // Several seconds in: still the same honest sentence, a visible Cancel, no fake precision.
  await page.waitForTimeout(6000);
  await expect(page.getByTestId('auto-progress')).toBeVisible();
  await expect(page.getByTestId('auto-cancel')).toBeVisible();
  await expect(page.getByTestId('split-cancel-analysis')).toBeVisible();
  expect(await page.getByTestId('auto-progress').innerText()).not.toMatch(/\d\s*%/);
  await expect(page.getByTestId('auto-progress')).toContainText(
    /several seconds to a minute or more/i,
  );
  // The analyze button is gone while it runs: nothing can start a duplicate.
  await expect(page.getByTestId('auto-analyze')).toHaveCount(0);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 60_000 });
  const gaps = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean };
    w.__stop = true;
    return w.__gaps;
  });
  // The page stayed alive for the whole wait.
  expect(Math.max(...gaps)).toBeLessThan(500);
  expect((await mockState(page)).received).toHaveLength(1);
});

test('after an Apply, the list says its scope: the current part, not the rest of the original model', async ({
  page,
}) => {
  await openMesh(page, 'figure.stl', humanFigure().mesh);
  await enterAuto(page);
  await accept(page, 'human');
  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('auto-part')).toContainText('part-1');
  await previewAndApply(page, 'head');
  await expect(page.getByTestId('auto-stale')).toContainText(
    'Re-analyze looks only at the part now shown, not at the rest of the original model.',
  );
  await expect(page.getByTestId('auto-reanalyze')).toHaveText('Find again');
  // The part named is the one now shown: a piece, not the original.
  await expect(page.getByTestId('auto-part')).toContainText('Part A');
});

test('keyboard: Cancel stops an analysis, and a component selection is usable with the keys', async ({
  page,
}) => {
  await control(page, { scenario: 'vehicle-component', behaviour: 'slow' });
  await openMesh(page, 'car.stl', carMultipart().mesh);
  await enterAuto(page);
  await accept(page, 'vehicle');
  await page.getByTestId('auto-analyze').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('auto-cancel')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('auto-cancel').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('auto-cancelled')).toBeVisible();

  await control(page, { scenario: 'vehicle-component', behaviour: 'ok' });
  await page.getByTestId('auto-analyze').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  const wheel = page.locator('[data-testid^="auto-row-wheel:"]').first();
  const id = ((await wheel.getAttribute('data-testid')) ?? '').replace('auto-row-', '');
  await page.getByTestId(`auto-edit-${id}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('auto-components')).toBeVisible();
  const box = page.locator('[data-testid^="auto-component-"]').nth(2);
  await box.focus();
  const before = await box.isChecked();
  await page.keyboard.press('Space');
  expect(await box.isChecked()).toBe(!before);
  await page.getByTestId('auto-preview-selection').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
});

/** The active part as a binary STL, read from the download the application produces. */
async function exportActivePart(page: Page): Promise<Buffer> {
  const wait = page.waitForEvent('download', { timeout: 20_000 });
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  const chunks: Buffer[] = [];
  for await (const chunk of await (await wait).createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test('RC2.1, character: the model is exported identically before Auto Split and after Apply and Undo', async ({
  page,
}) => {
  const figure = humanFigure().mesh;
  const triangles = await openMesh(page, 'figure.stl', figure);
  const original = await exportActivePart(page);
  expect(original.readUInt32LE(80)).toBe(triangles);

  await enterAuto(page);
  await accept(page, 'human');
  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  // Source unchanged while the suggestions are on screen.
  expect((await exportActivePart(page)).equals(original)).toBe(true);

  await previewAndApply(page, 'head');
  expect(await triangleCount(page)).not.toBe(triangles.toLocaleString('en-US'));
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 60_000,
  });
  // Undo restored the exact model, and the workspace points at it: export works and is byte-identical.
  expect((await exportActivePart(page)).equals(original)).toBe(true);
});

test('RC2.1, vehicle: the same holds when Auto Split took components out', async ({ page }) => {
  await control(page, { scenario: 'vehicle-component' });
  const triangles = await openMesh(page, 'car.stl', carMultipart().mesh);
  const original = await exportActivePart(page);
  expect(original.readUInt32LE(80)).toBe(triangles);

  await enterAuto(page);
  await accept(page, 'vehicle');
  await findParts(page);
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 120_000 });
  const wheel = page.locator('[data-testid^="auto-row-wheel:"]').first();
  const id = ((await wheel.getAttribute('data-testid')) ?? '').replace('auto-row-', '');
  await previewAndApply(page, id);
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 60_000,
  });
  expect((await exportActivePart(page)).equals(original)).toBe(true);
});

test('RC2.2: a service-wide capacity refusal reaches the person as such, and the other workflows carry on', async ({
  page,
}) => {
  // The real service's wire format for a capacity refusal, served by the page's route table so that no
  // paid or mock provider is involved: this proves the BROWSER's handling of the response.
  await page.route('**/api/auto-split/analyze', async (route) => {
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'retry-after': '600', 'cache-control': 'no-store' },
      body: JSON.stringify({
        ok: false,
        error: {
          code: 'AT_CAPACITY',
          message: 'Auto Split is temporarily at capacity. Try again later.',
          retryAfterSeconds: 600,
        },
      }),
    });
  });
  const triangles = await openMesh(page, 'figure.stl', humanFigure().mesh);
  await enterAuto(page);
  await accept(page, 'human');
  await findParts(page);
  await expect(page.getByTestId('auto-error-message')).toHaveText(
    'Auto Split is temporarily at capacity. Try again later.',
  );
  await expect(page.getByTestId('auto-error-detail')).toHaveText(
    'Repair and Manual Split are not affected.',
  );
  await expect(page.getByTestId('auto-error')).not.toContainText(/\d|minute|hour|limit|cost/i);
  expect(await triangleCount(page)).toBe(triangles.toLocaleString('en-US'));
  // Manual Split works as usual.
  await page.getByTestId('split-tab-manual').click();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 120_000 });
});
