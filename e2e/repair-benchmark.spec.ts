import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { repairHeavyStl } from './stl-fixtures';

/**
 * Real browser timings for the conservative repair workflow, recorded rather
 * than asserted.
 *
 * WHY SEPARATE FROM `browser-benchmark.spec.ts`. That one measures the path a
 * user takes to SEE their model. This one measures the path they take to CHANGE
 * it, which has a different shape: a plan, a candidate that doubles resident
 * geometry, a preview swap that must not cost a GPU upload, a commit, and the
 * re-analysis that follows it.
 *
 * DELIBERATELY NOT A PERFORMANCE GATE. There is one assertion per run and it is
 * a correctness one: the repair actually completed. Turning wall-clock numbers
 * into CI thresholds on shared hardware produces flaky builds and teaches people
 * to ignore failures. The numbers are printed for
 * `docs/PERFORMANCE_BASELINE.md` and reviewed by a person.
 *
 * Skipped unless `CADFIXER_BROWSER_BENCH=1`, because it is slow and belongs to a
 * deliberate measuring session rather than to every end-to-end run.
 */

const ENABLED = process.env.CADFIXER_BROWSER_BENCH === '1';

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/**
 * Typed-array bytes the page is holding for geometry, counted from the objects
 * themselves.
 *
 * NOT process RSS, and not `performance.memory`. RSS includes the renderer, the
 * GPU driver and every other tab's share of a shared process; `performance.memory`
 * is Chromium-only, heap-only, and excludes the off-heap allocations that typed
 * arrays mostly are. What CAN be measured honestly is what WE allocated, and
 * that is what the Stage 3B-1A estimator models — so that is what is compared.
 *
 * `measureUserAgentSpecificMemory` is used when the page is cross-origin isolated
 * (it is: the preview server sends COOP/COEP), and it is reported separately and
 * labelled as what it is: a whole-agent figure, not our buffers.
 */
async function measureAgentMemory(page: Page): Promise<number | undefined> {
  return page.evaluate(async () => {
    const measure = (
      performance as unknown as {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      }
    ).measureUserAgentSpecificMemory;
    if (typeof measure !== 'function') return undefined;
    try {
      return (await measure.call(performance)).bytes;
    } catch {
      // Unsupported or refused. Reported as absent rather than as zero, which
      // would read as a measurement of nothing.
      return undefined;
    }
  });
}

/** Longest gap between animation frames since sampling started. */
async function startFrameSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.assign(globalThis, { __repairGaps: [] as number[] });
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      (globalThis as unknown as { __repairGaps: number[] }).__repairGaps.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readFrameGaps(page: Page): Promise<{ longestMs: number; frames: number }> {
  const gaps = await page.evaluate(
    () => (globalThis as unknown as { __repairGaps: number[] }).__repairGaps,
  );
  return {
    longestMs: gaps.reduce((worst, gap) => Math.max(worst, gap), 0),
    frames: gaps.length,
  };
}

test.describe('repair browser benchmark', () => {
  test.skip(!ENABLED, 'Set CADFIXER_BROWSER_BENCH=1 to run.');

  test('records plan, candidate, preview, apply, undo and memory', async ({ page, browser }) => {
    test.setTimeout(900_000);

    const sides = (process.env.CADFIXER_REPAIR_BENCH_SIDES ?? '60,120,200')
      .split(',')
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry) && entry > 0);

    const lines: string[] = [
      '',
      `browser: ${browser.browserType().name()} ${browser.version()}`,
      `user agent: ${await page.evaluate(() => navigator.userAgent)}`,
      `hardware concurrency: ${String(await page.evaluate(() => navigator.hardwareConcurrency))}`,
      `run at ${new Date().toISOString()}`,
      '',
      'Fixture: a height-varying quad grid with EVERY triangle duplicated, so the',
      'model is half redundant and duplicate removal has real work to do.',
      '',
    ];

    /*
     * A WARM-UP PASS, discarded.
     *
     * The first repair of a session carries costs that belong to the session and
     * not to the repair: module evaluation, JIT warm-up, the first GPU upload,
     * and the first worker round trip. Measured, they showed up as a 1.9-second
     * main-thread gap on a 14,400-triangle model — while a second run of the SAME
     * model on the SAME page reported 17-40 ms. Reporting the first number would
     * have attributed a session cost to the repair and pointed an investigation
     * at the wrong code.
     */
    {
      const warmUp = repairHeavyStl(20);
      await page.goto('/');
      await openFile(page, 'warm-up.stl', warmUp.bytes);
      await revealControl(page, page.getByTestId('repair-operations'));
      await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 600_000 });
      await revealControl(page, page.getByTestId('advanced-preview-repair'));
      await page.getByTestId('advanced-preview-repair').click();
      await revealControl(page, page.getByTestId('repair-candidate'));
      await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 600_000 });
      await page.getByTestId('apply-repair').click();
      await revealControl(page, page.getByTestId('repair-applied'));
      await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 600_000 });
    }

    for (const side of sides) {
      const model = repairHeavyStl(side);
      await page.goto('/');

      await openFile(page, `repair-${String(side)}.stl`, model.bytes);
      await expect(page.getByTestId('fact-triangles')).toHaveText(
        model.triangles.toLocaleString(),
        { timeout: 600_000 },
      );
      const importedAt = Date.now();

      // Analysis runs automatically; the plan follows it. Both are measured from
      // the moment the model became visible, because that is when a user could
      // first have asked for a repair.
      await revealControl(page, page.getByTestId('issue-list'));
      await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 600_000 });
      const analysisMs = Date.now() - importedAt;

      await revealControl(page, page.getByTestId('repair-operations'));
      await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 600_000 });
      const planMs = Date.now() - importedAt - analysisMs;

      const memoryBeforeCandidate = await measureAgentMemory(page);

      // Candidate creation and validation, with frame sampling across the whole
      // window: this is where the heavy work happens and where a main-thread
      // regression would show up.
      await startFrameSampling(page);
      const candidateStart = Date.now();
      await revealControl(page, page.getByTestId('advanced-preview-repair'));
      await page.getByTestId('advanced-preview-repair').click();
      await revealControl(page, page.getByTestId('repair-candidate'));
      await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 600_000 });
      const candidateMs = Date.now() - candidateStart;
      const preparation = await readFrameGaps(page);

      /*
       * The preview is already showing AFTER when the candidate lands, so the
       * first draw is included above. What is measured here is the SWITCH, which
       * must be a visibility flag rather than a second GPU upload.
       *
       * READ AS AN UPPER BOUND. Both figures include Playwright's own polling
       * interval for the assertion that follows the click, which is a fixed
       * floor of roughly 200 ms on the direction that waits for an element to
       * DISAPPEAR. What the numbers establish is that the switch does not scale
       * with mesh size — the same bound at 57,600 and 230,400 triangles — which
       * is the property the shared-transform preview design exists to give.
       */
      const beforeSwitchStart = Date.now();
      await page.getByTestId('preview-mode-before').check();
      await expect(page.getByTestId('preview-banner')).toHaveCount(0);
      const toBeforeMs = Date.now() - beforeSwitchStart;

      const afterSwitchStart = Date.now();
      await page.getByTestId('preview-mode-after').check();
      await expect(page.getByTestId('preview-banner')).toBeVisible();
      const toAfterMs = Date.now() - afterSwitchStart;

      const memoryDuringPreview = await measureAgentMemory(page);

      // What the page is actually holding, from the objects rather than from a
      // process figure. Both render snapshots are live at this point: the
      // authoritative model's and the candidate's.
      const renderBytes = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '[data-testid="viewport-canvas"] canvas',
        );
        return {
          modelObjects: Number(canvas?.dataset.modelObjects ?? 0),
          previewObjects: Number(canvas?.dataset.previewObjects ?? 0),
          changeOverlayObjects: Number(canvas?.dataset.changeOverlayObjects ?? 0),
        };
      });

      const applyStart = Date.now();
      await page.getByTestId('apply-repair').click();
      await revealControl(page, page.getByTestId('repair-applied'));
      await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 600_000 });
      const applyMs = Date.now() - applyStart;

      /*
       * Measured from the Apply CLICK, not from the moment the banner appeared.
       *
       * Two earlier attempts split this into "commit" and "post-commit analysis"
       * and both were unreliable: the banner and the re-analysis complete inside
       * one Playwright polling interval on a fast machine, so the split reported
       * 890 ms / 6 ms on one model and 74 ms / 358 ms on another — the same total
       * work, attributed differently by timing luck. What is actually meaningful
       * to a user is Apply-to-usable, so that is what is reported.
       *
       * The wait is on a value that can ONLY be true of the new report: zero
       * duplicates is reachable only after the repaired revision was analysed.
       */
      await expect(page.getByTestId('topo-duplicates')).toHaveText('0', { timeout: 600_000 });
      await expect(page.getByTestId('repair-no-repairs')).toBeVisible({ timeout: 600_000 });
      const applyToReadyMs = Date.now() - applyStart;

      const undoStart = Date.now();
      await page.getByTestId('undo-repair').click();
      await expect(page.getByTestId('fact-triangles')).toHaveText(
        model.triangles.toLocaleString(),
        { timeout: 600_000 },
      );
      const undoMs = Date.now() - undoStart;

      const memoryAfterUndo = await measureAgentMemory(page);

      const asMiB = (bytes: number | undefined): string =>
        bytes === undefined ? 'unavailable' : `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;

      lines.push(
        `--- ${model.triangles.toLocaleString()} triangles ` +
          `(${(model.bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB, half duplicates) ---`,
        `  topology analysis            ${String(analysisMs)} ms`,
        `  repair plan                  ${String(planMs)} ms`,
        `  candidate + validation       ${String(candidateMs)} ms`,
        `  preview switch After->Before ${String(toBeforeMs)} ms`,
        `  preview switch Before->After ${String(toAfterMs)} ms`,
        `  apply: click to banner       ${String(applyMs)} ms`,
        `  apply: click to reanalysed   ${String(applyToReadyMs)} ms`,
        `  undo                         ${String(undoMs)} ms`,
        `  longest main-thread gap during preparation ` +
          `${preparation.longestMs.toFixed(0)} ms over ${String(preparation.frames)} frames`,
        `  scene during preview: model=${String(renderBytes.modelObjects)} ` +
          `preview=${String(renderBytes.previewObjects)} ` +
          `changeOverlays=${String(renderBytes.changeOverlayObjects)}`,
        `  whole-agent memory before candidate ${asMiB(memoryBeforeCandidate)}`,
        `  whole-agent memory during preview   ${asMiB(memoryDuringPreview)}`,
        `  whole-agent memory after undo       ${asMiB(memoryAfterUndo)}`,
        '',
      );

      // The only assertion: the repair completed and was reversed.
      expect(undoMs).toBeGreaterThan(0);
    }

    lines.push(
      'Whole-agent memory is reported for scale only. It is NOT a measurement of',
      'CAD Fixer’s buffers: it includes the renderer, the JIT and everything else',
      'in the agent. The buffer model that the resource preflight actually uses is',
      'in packages/geometry-runtime/src/memory-budget.ts and is asserted by unit',
      'test against the estimator, not against a process figure.',
      '',
    );

    process.stdout.write(`${lines.join('\n')}\n`);
  });
});
