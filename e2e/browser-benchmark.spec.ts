import { expect, test, type Page } from '@playwright/test';
import { analysisHeavyStl } from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * Real browser timings, recorded rather than asserted.
 *
 * Stage 1 had Node measurements only, which tell you what the algorithms cost
 * and nothing about what a user waits for. This measures the thing the user
 * actually experiences: file to first pixel, and file to a usable report.
 *
 * DELIBERATELY NOT A PERFORMANCE GATE. There is exactly one assertion, and it is
 * a correctness one: the run must actually complete. Turning wall-clock numbers
 * into CI thresholds on shared hardware produces flaky builds and teaches people
 * to ignore failures. The numbers are printed for `docs/PERFORMANCE_BASELINE.md`
 * and reviewed by a person.
 *
 * Skipped unless `CADFIXER_BROWSER_BENCH=1`, because it is slow and belongs to a
 * deliberate measuring session, not to every E2E run.
 */

const ENABLED = process.env.CADFIXER_BROWSER_BENCH === '1';

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

test.describe('browser benchmark', () => {
  test.skip(!ENABLED, 'Set CADFIXER_BROWSER_BENCH=1 to run.');

  test('records import, first paint, analysis, and export timings', async ({ page, browser }) => {
    test.setTimeout(600_000);

    const sizes = (process.env.CADFIXER_BROWSER_BENCH_SIDES ?? '150,300,450')
      .split(',')
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry) && entry > 0);

    const lines: string[] = [
      '',
      `browser: ${browser.browserType().name()} ${browser.version()}`,
      `user agent: ${await page.evaluate(() => navigator.userAgent)}`,
      `hardware concurrency: ${String(await page.evaluate(() => navigator.hardwareConcurrency))}`,
      `device memory (GiB, coarse): ${String(
        await page.evaluate(() => (navigator as { deviceMemory?: number }).deviceMemory ?? 0),
      )}`,
      `run at ${new Date().toISOString()}`,
      '',
    ];

    for (const side of sizes) {
      const model = analysisHeavyStl(side);
      await page.goto('/');

      // Frame-gap sampling runs for the whole import + analysis window, so
      // "did the UI stay responsive" is measured rather than asserted from
      // architecture.
      await page.evaluate(() => {
        Object.assign(globalThis, { __gaps: [] as number[] });
        let last = performance.now();
        const tick = (): void => {
          const now = performance.now();
          (globalThis as unknown as { __gaps: number[] }).__gaps.push(now - last);
          last = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      const startedAt = Date.now();
      await openFile(page, `bench-${String(side)}.stl`, model.bytes);

      // First visible: the model facts appear only after the worker has parsed,
      // committed, and returned a render snapshot.
      await expect(page.getByTestId('fact-triangles')).toHaveText(
        model.triangles.toLocaleString(),
        { timeout: 300_000 },
      );
      const firstVisibleMs = Date.now() - startedAt;

      await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 300_000 });
      const healthReadyMs = Date.now() - startedAt;

      const gaps = await page.evaluate(
        () => (globalThis as unknown as { __gaps: number[] }).__gaps,
      );
      const longestGapMs = gaps.reduce((worst, gap) => Math.max(worst, gap), 0);
      const framesObserved = gaps.length;

      // Responsiveness, checked by interaction rather than by inference: a
      // control that answers a click is a control the user can reach.
      const interactionStart = Date.now();
      await page.getByTestId('fit-view').click();
      const interactionMs = Date.now() - interactionStart;

      const exportStart = Date.now();
      const download = page.waitForEvent('download');
      await openInspector(page);
      await page.getByTestId('export-binary').click();
      await download;
      const exportMs = Date.now() - exportStart;

      lines.push(
        `--- ${model.triangles.toLocaleString()} triangles ` +
          `(${(model.bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB) ---`,
        `  file to model visible      ${String(firstVisibleMs)} ms`,
        `  file to Mesh Health ready  ${String(healthReadyMs)} ms`,
        `  analysis window            ${String(healthReadyMs - firstVisibleMs)} ms`,
        `  binary export              ${String(exportMs)} ms`,
        `  longest main-thread gap    ${longestGapMs.toFixed(0)} ms over ${String(framesObserved)} frames`,
        `  fit-view click responded   ${String(interactionMs)} ms`,
        '',
      );

      // The only assertion: the run completed and produced a report.
      expect(healthReadyMs).toBeGreaterThan(0);
    }

    process.stdout.write(`${lines.join('\n')}\n`);
  });
});
