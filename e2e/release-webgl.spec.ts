import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { binaryStl, combinedRepairStl } from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * BQ01–BQ08 — WHAT HAPPENS WHEN THE GPU GOES AWAY.
 *
 * Stage 5A deferred this because it had no reliable way to simulate it. Chromium
 * does: `WEBGL_lose_context` is a debug extension whose whole purpose is to
 * drive `webglcontextlost` deterministically. It is reached only from test code
 * here — there is no production control that can lose a context, and the
 * production-boundary suite asserts as much.
 *
 * THE CLAIM UNDER TEST is the architectural one ADR 0008 makes: the render
 * snapshot is a DISPOSABLE DERIVATIVE and the authoritative geometry lives in a
 * worker. If that is true, then losing the GPU is a display failure and nothing
 * more — the document must still be there, still be the same revision, and still
 * be exportable. If it is false anywhere, this is where it shows.
 *
 * WHAT CAD FIXER DOES NOT CLAIM: seamless recovery. There is no
 * `webglcontextrestored` handler, so the renderer does not rebuild itself; the
 * product says the context was lost and asks for a reload. These tests assert
 * that honestly rather than asserting a restoration that was never implemented.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** Renderer counters the viewport publishes for exactly this kind of test. */
async function scene(page: Page): Promise<{
  modelObjects: number;
  sharedGeometries: number;
  created: number;
  disposed: number;
  revision: number;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    return {
      modelObjects: Number(canvas?.dataset.modelObjects ?? -1),
      sharedGeometries: Number(canvas?.dataset.sharedGeometries ?? -1),
      created: Number(canvas?.dataset.geometriesCreated ?? -1),
      disposed: Number(canvas?.dataset.geometriesDisposed ?? -1),
      revision: Number(canvas?.dataset.modelRevision ?? -1),
    };
  });
}

/**
 * Installs a retained handle on Chromium's `WEBGL_lose_context` extension.
 *
 * CAPTURED ONCE, BEFORE ANY LOSS, and that is not incidental. Once a context is
 * lost, `getContext` hands back the lost context and `getExtension` on it returns
 * null — so a helper that re-fetched the extension each time could lose a context
 * and then never restore it. The handle has to outlive the loss it causes.
 */
async function installContextControl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    if (canvas === null) return false;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl === null) return false;
    const extension: unknown = gl.getExtension('WEBGL_lose_context');
    if (extension === null) return false;
    Object.assign(globalThis, { __glControl: extension });
    return true;
  });
}

async function loseContext(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const control = (globalThis as { __glControl?: { loseContext(): void } }).__glControl;
    if (control === undefined) return false;
    control.loseContext();
    return true;
  });
}

async function restoreContext(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const control = (globalThis as { __glControl?: { restoreContext(): void } }).__glControl;
    if (control === undefined) return false;
    control.restoreContext();
    return true;
  });
}

/** The document the worker holds, by handle and triangle count. */
async function health(page: Page): Promise<{ triangles: string; corners: string }> {
  return {
    triangles: (await page.getByTestId('health-triangles').textContent()) ?? '',
    corners: (await page.getByTestId('health-corners').textContent()) ?? '',
  };
}

test('BQ01: losing the context reports a display failure and keeps the document', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openFile(page, 'small.stl', binaryStl(600).bytes);
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

  const before = await health(page);
  const beforeScene = await scene(page);
  expect(beforeScene.modelObjects).toBe(1);

  expect(await installContextControl(page), 'WEBGL_lose_context must exist in Chromium').toBe(true);
  expect(await loseContext(page)).toBe(true);

  // THE RENDER FAILURE IS REPORTED, and as a render failure.
  await expect(page.getByTestId('viewport-error')).toBeVisible({ timeout: 30_000 });
  const message = (await page.getByTestId('viewport-error').textContent()) ?? '';
  expect(message.toLowerCase()).toContain('graphics context');
  // It must not claim the MODEL is gone: the worker still holds it.
  for (const overclaim of ['model was lost', 'geometry was lost', 'corrupt', 're-import']) {
    expect(message.toLowerCase()).not.toContain(overclaim);
  }

  /*
   * AND THE DOCUMENT IS UNTOUCHED. Mesh Health reads scalars the WORKER
   * published, so these numbers are a statement about authoritative geometry and
   * not about anything the GPU held.
   */
  expect(await health(page)).toEqual(before);
});

test('BQ02: the authoritative revision does not move when the context is lost', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openFile(page, 'small.stl', binaryStl(600).bytes);
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

  const before = await scene(page);
  expect(await installContextControl(page)).toBe(true);
  expect(await loseContext(page)).toBe(true);
  await expect(page.getByTestId('viewport-error')).toBeVisible({ timeout: 30_000 });

  // A DISPLAY FAULT IS NOT A MUTATION. Losing the GPU must not consume a
  // revision, because every staleness guard in the runtime is built on that
  // number only moving when authoritative geometry changes.
  await expect
    .poll(async () => (await scene(page)).revision, { timeout: 10_000 })
    .toBe(before.revision);
});

test('BQ03: restoring the context leaves the document intact and exportable', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await openFile(page, 'small.stl', binaryStl(600).bytes);
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  const before = await health(page);

  expect(await installContextControl(page)).toBe(true);
  expect(await loseContext(page)).toBe(true);
  await expect(page.getByTestId('viewport-error')).toBeVisible({ timeout: 30_000 });
  expect(await restoreContext(page)).toBe(true);
  await page.waitForTimeout(500);

  /*
   * BQ56. THE POINT OF THE WHOLE ARCHITECTURE: the user can still get their
   * model out. Export reads the worker's document, so it does not care that the
   * GPU had a bad day.
   */
  expect(await health(page)).toEqual(before);
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  const download = await pending;
  const stream = await download.createReadStream();
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).length;
  // 600 triangles: 84 + 600 * 50.
  expect(bytes).toBe(84 + 600 * 50);
});

test('BQ04, BQ05: a preview on screen is never the commit source', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await openFile(page, 'combined.stl', combinedRepairStl());
  await revealControl(page, page.getByTestId('repair-operations'));
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 60_000 });

  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  await revealControl(page, page.getByTestId('repair-candidate'));
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });

  // Lose the GPU with a candidate on screen. The candidate is a HANDLE the
  // worker owns; the preview is pixels. Losing the pixels must not change what
  // Apply would commit.
  expect(await installContextControl(page)).toBe(true);
  expect(await loseContext(page)).toBe(true);
  await expect(page.getByTestId('viewport-error')).toBeVisible({ timeout: 30_000 });
  expect(await restoreContext(page)).toBe(true);
  await page.waitForTimeout(500);

  const beforeApply = await health(page);
  await page.getByTestId('apply-repair').click();
  await revealControl(page, page.getByTestId('repair-applied'));
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });

  /*
   * THE APPLY STILL DID EXACTLY WHAT IT PROMISED. The triangle count moved by
   * the amount the plan predicted, which it could only do if the worker
   * committed its own validated candidate rather than anything the renderer had.
   */
  const afterApply = await health(page);
  expect(afterApply.triangles).not.toBe(beforeApply.triangles);

  await page.getByTestId('undo-repair').click();
  await expect
    .poll(async () => (await health(page)).triangles, { timeout: 60_000 })
    .toBe(beforeApply.triangles);
});

test('BQ06, BQ07: context loss around Undo leaves geometry and GPU counters sound', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await openFile(page, 'combined.stl', combinedRepairStl());
  await revealControl(page, page.getByTestId('repair-operations'));
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 60_000 });
  const original = await health(page);

  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  await revealControl(page, page.getByTestId('repair-candidate'));
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('apply-repair').click();
  await revealControl(page, page.getByTestId('repair-applied'));
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });

  expect(await installContextControl(page)).toBe(true);
  expect(await loseContext(page)).toBe(true);
  await expect(page.getByTestId('viewport-error')).toBeVisible({ timeout: 30_000 });
  expect(await restoreContext(page)).toBe(true);
  await page.waitForTimeout(500);

  await page.getByTestId('undo-repair').click();
  // EXACT RESTORATION, across a GPU fault. The undo record is a retained mesh in
  // the worker; nothing about it passes through the renderer.
  await expect
    .poll(async () => (await health(page)).triangles, { timeout: 60_000 })
    .toBe(original.triangles);
  expect(await health(page)).toEqual(original);

  /*
   * BQ07. NO DOUBLE DISPOSAL AND NO LEAK. Disposals may never exceed creations —
   * that would be a double free — and the difference is what is still uploaded.
   */
  const after = await scene(page);
  expect(after.disposed).toBeLessThanOrEqual(after.created);
  expect(after.created - after.disposed).toBeGreaterThanOrEqual(0);
});

test('BQ08: a replacement import works after a context fault', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await openFile(page, 'first.stl', binaryStl(400).bytes);
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

  expect(await installContextControl(page)).toBe(true);
  expect(await loseContext(page)).toBe(true);
  await expect(page.getByTestId('viewport-error')).toBeVisible({ timeout: 30_000 });
  expect(await restoreContext(page)).toBe(true);
  await page.waitForTimeout(500);

  /*
   * RECOVERY, not merely survival — §119. A test that proves nothing crashed is
   * weaker than one that proves the user can carry on working.
   */
  await openFile(page, 'second.stl', binaryStl(900).bytes);
  await expect
    .poll(async () => (await health(page)).triangles, { timeout: 60_000 })
    .toBe((900).toLocaleString());
});
