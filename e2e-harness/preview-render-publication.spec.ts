import { expect, test } from '@playwright/test';
import { digest, Fixture, loadFixture, openHarness, readScene, readState } from './harness';

test('VR01: one preview publication draws only the complete final scene', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const probe = window as unknown as { previewRenderProbe: { active: boolean; clears: number } };
    probe.previewRenderProbe = { active: false, clears: 0 };
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const original = Object.getOwnPropertyDescriptor(prototype, 'clear')?.value as
        ((mask: number) => void) | undefined;
      if (original === undefined) throw Error('Native clear method unavailable');
      prototype.clear = function (mask: number): void {
        if (probe.previewRenderProbe.active) probe.previewRenderProbe.clears++;
        Reflect.apply(original, this, [mask]);
      };
    }
  });
  await openHarness(page);
  await loadFixture(page, Fixture.SplitSmallSphereMillimetre);
  const before = await digest(page, await readState(page));
  await page.getByTestId('workflow-split').click();
  // Settle the plane and initial workspace presentation before observing publication.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          }),
        ),
      ),
  );
  await page.evaluate(() => {
    const probe = (window as unknown as { previewRenderProbe: { active: boolean; clears: number } })
      .previewRenderProbe;
    probe.clears = 0;
    probe.active = true;
  });
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-apply')).toBeEnabled();
  await expect(page.getByTestId('split-preview-label')).toBeVisible();
  // Observe actual presentation after readiness, not just the button's state.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              resolve();
            }),
          ),
        ),
      ),
  );
  const clears = await page.evaluate(() => {
    const probe = (window as unknown as { previewRenderProbe: { active: boolean; clears: number } })
      .previewRenderProbe;
    probe.active = false;
    return probe.clears;
  });
  expect(await digest(page, await readState(page))).toEqual(before);
  expect((await readScene(page)).modelObjects).toBe(2);
  await page
    .getByTestId('viewport-canvas')
    .locator('canvas')
    .screenshot({ path: info.outputPath('preview.png') });
  expect(clears).toBe(1);
  await page.getByTestId('split-apply').click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(2);
  await page.getByTestId('split-undo').click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(1);
  expect(await digest(page, await readState(page))).toEqual(before);
});
