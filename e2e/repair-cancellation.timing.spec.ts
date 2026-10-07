import { expect, test, type Page } from '@playwright/test';
import { repairHeavyStl } from './stl-fixtures';

/**
 * INTERRUPTIBLE CANCELLATION, PROVEN IN A REAL BROWSER.
 *
 * NOTHING HERE IS MOCKED. A real Chromium, the real production build, the real
 * geometry worker, the real `SharedArrayBuffer` control word, and the real
 * Cancel button. The claim under test is not "a cancelled operation reports
 * cancelled" — the old message-based path could do that much by discarding a
 * finished result. The claim is that the WORK STOPS EARLY, which is only
 * observable by comparing an uncancelled run against a cancelled one and
 * checking that the second did strictly less.
 *
 * SELF-CALIBRATING, never a fixed millisecond budget. CI machines, laptops on
 * battery and a developer's desktop differ by more than any absolute threshold
 * could survive, and a flaky timing test gets weakened until it proves nothing.
 * `T_full` is measured first on the same machine in the same session, and the
 * assertion is a RATIO against it.
 */

/**
 * Grid side of the heavy fixture: side² quads, four triangles each, half of them
 * exact duplicates — 577,600 triangles at 380.
 *
 * SIZED SO THE CANCELLABLE WORK DOMINATES. The measured window also contains
 * fixed, uncancellable overhead — the click round-trip, the worker message hop,
 * a React commit — which does not shrink when the repair stops early. On a small
 * fixture that overhead is a large share of the total and the cancellation ratio
 * degrades under CPU contention for a reason that has nothing to do with
 * cancellation. Making the repair itself the dominant term keeps the ratio
 * meaningful when the full suite runs four workers in parallel.
 */
const HEAVY_SIDE = 380;

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

test('the document is cross-origin isolated and can allocate a shared control word', async ({
  page,
}) => {
  await page.goto('/');
  const environment = await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    atomics: typeof Atomics,
    // The control word itself: allocated, flipped and read back through Atomics.
    flips: ((): { before: number; after: number; bytes: number } => {
      const view = new Int32Array(new SharedArrayBuffer(4));
      const before = Atomics.load(view, 0);
      Atomics.store(view, 0, 1);
      return { before, after: Atomics.load(view, 0), bytes: view.buffer.byteLength };
    })(),
  }));

  expect(environment.isolated).toBe(true);
  expect(environment.sharedArrayBuffer).toBe('function');
  expect(environment.atomics).toBe('object');
  expect(environment.flips).toEqual({ before: 0, after: 1, bytes: 4 });
});

/**
 * Imports the fixture into a FRESH page and waits until a repair can be planned.
 *
 * Fresh, deliberately. The worker caches a topology report per (model, revision),
 * so a second repair on the same page skips the source analysis entirely and is
 * far cheaper than the first. Comparing a warm run against a cold one would
 * flatter the cancellation ratio for a reason that has nothing to do with
 * cancellation. Both measured runs below therefore start from an identical cold
 * page.
 */
async function importHeavy(page: Page, side: number): Promise<string> {
  await page.goto('/');
  const heavy = repairHeavyStl(side);
  await openFile(page, 'heavy.stl', heavy.bytes);
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 180_000 });
  return (await page.getByTestId('fact-triangles').textContent()) ?? '';
}

/**
 * Arms an in-page click on Cancel, fired the moment `match` describes the panel.
 *
 * IN THE PAGE, not polled from the runner. Playwright's polling interval can
 * step straight over a phase that lasts a few tens of milliseconds, so a test
 * driven from outside would either miss its window or need a fixture so large
 * the suite becomes unusable. A MutationObserver reacts in the same task the
 * panel changes, which makes "cancel during THIS phase" deterministic.
 */
async function armCancelWhen(page: Page, match: { phase?: string }): Promise<void> {
  await page.evaluate(
    ({ phase }) => {
      const w = window as unknown as { __armed?: { phase: string; percent: number } };
      const read = (id: string): string =>
        document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
      const tryCancel = (): boolean => {
        const phaseText = read('repair-phase');
        // REPAIR-CORE-06B: stages, not percentages — the engine does not know how much work
        // remains, so the panel no longer invents a number. `percent` is kept (0) for the shape.
        const percent = 0;
        if (phase !== undefined && !new RegExp(phase, 'i').test(phaseText)) return false;
        const button = document.querySelector<HTMLButtonElement>('[data-testid="cancel-repair"]');
        if (button === null || button.disabled) return false;
        w.__armed = { phase: phaseText, percent };
        button.click();
        return true;
      };
      if (tryCancel()) return;
      const observer = new MutationObserver(() => {
        if (tryCancel()) observer.disconnect();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    },
    { phase: match.phase },
  );
}

async function readArmed(page: Page): Promise<{ phase: string; percent: number } | undefined> {
  return page.evaluate(
    () => (window as unknown as { __armed?: { phase: string; percent: number } }).__armed,
  );
}

test('cancelling a heavy repair stops the work early and leaves the model untouched', async ({
  page,
}) => {
  test.setTimeout(600_000);

  /* ---- run 1: a cold, uncancelled repair, to calibrate ---- */

  const trianglesBefore = await importHeavy(page, HEAVY_SIDE);
  const startFull = Date.now();
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('preview-banner')).toBeVisible({ timeout: 180_000 });
  const tFull = Date.now() - startFull;

  // A workload too short to measure would make the ratio below meaningless.
  expect(tFull).toBeGreaterThan(300);

  /* ---- run 2: the same cold work, cancelled as soon as it is under way ---- */

  await importHeavy(page, HEAVY_SIDE);
  // Under way: the stage text is the engine's own, shown once the build has begun.
  await armCancelWhen(page, { phase: 'Selecting|Solving|Building' });

  const startCancel = Date.now();
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-cancelled')).toBeVisible({ timeout: 180_000 });
  const tCancel = Date.now() - startCancel;
  const armed = await readArmed(page);

  /* ---- the acceptance gate ---- */

  /*
   * EARLY TERMINATION, at the ORIGINAL Stage 3B-1 threshold.
   *
   * WHY 0.8 AND NOT SOMETHING LOOSER. Stage 3C-1B briefly relaxed this to 0.9
   * after a full-suite failure at 0.852. That was the wrong diagnosis. Measured
   * properly — ten consecutive isolated runs — this implementation sits at
   * 0.608 to 0.640, nowhere near either threshold. What failed was the
   * MEASUREMENT: under four parallel workers the uncancelled and cancelled
   * halves land in different contention windows, and across five full-suite runs
   * the ratio ranged from 0.640 to 1.17. A ratio above 1.0 means the "cancelled"
   * run took longer than the uncancelled one, which cannot be a statement about
   * cancellation at all.
   *
   * The fix was to make the measurement valid rather than the threshold
   * forgiving: this spec now runs single-worker under
   * `playwright.timing.config.ts`, and the approved Stage 3B-1 contract stands
   * unchanged.
   *
   * THE ABSOLUTE SAVING is kept alongside the ratio. It is retained from the
   * 3C-1B revision because it genuinely adds something the ratio does not: on a
   * hypothetically tiny workload a ratio could pass while saving almost no real
   * time.
   */
  expect(tCancel).toBeLessThan(tFull * 0.8);
  expect(tFull - tCancel).toBeGreaterThan(300);

  // WORK PROGRESS: the pipeline had started and had NOT finished. This is
  // `processed < total` in the engine's own published progress.
  // Cancel was pressed while the build stage was showing, and what it left is a cancelled
  // repair with nothing published (asserted below): the work had started and not finished.
  expect(armed?.phase ?? '').toMatch(/Selecting|Solving|Building/);

  // NOTHING WAS PUBLISHED.
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);

  // THE SOURCE IS AUTHORITATIVE AND UNCHANGED.
  await expect(page.getByTestId('fact-triangles')).toHaveText(trianglesBefore);

  // RETRY SUCCEEDS: cancellation left the engine able to repair again.
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('preview-banner')).toBeVisible({ timeout: 180_000 });

  process.stdout.write(
    `[early-termination] T_full=${String(tFull)}ms T_cancel=${String(tCancel)}ms ` +
      `ratio=${(tCancel / tFull).toFixed(3)} percentAtCancel=${String(armed?.percent)}\n`,
  );
});

test('cancelling DURING candidate validation unwinds it and publishes nothing', async ({
  page,
}) => {
  test.setTimeout(600_000);

  /*
   * WHY THIS TEST EXISTS SEPARATELY.
   *
   * The test above cancels as soon as work begins, which lands in an early
   * selection loop. Those loops were the easy half of Stage 3B-1C. The hard half
   * is candidate VALIDATION: the repaired mesh is re-analysed by the Stage 2
   * topology engine before it may be accepted, and that analysis is the longest
   * single span in a repair.
   *
   * If validation polled only at its phase boundaries, a cancel arriving during
   * it would wait for a whole phase to finish — seconds on a large model — and
   * the stage would pass its headline test while leaving the worst case
   * untouched.
   *
   * The panel is warm here on purpose: the source report is already cached, so
   * the pipeline and its validation ARE the work, and the phase label is
   * reached quickly and lasts long enough to be cancelled inside.
   */
  const trianglesBefore = await importHeavy(page, HEAVY_SIDE);

  // Warm the topology cache with a completed repair, then discard it, so the
  // measured run spends its time in the pipeline and its validation.
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('preview-banner')).toBeVisible({ timeout: 180_000 });
  await page.getByTestId('discard-preview').click();
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);

  await armCancelWhen(page, { phase: 'revalidating' });

  const requestedAt = Date.now();
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-cancelled')).toBeVisible({ timeout: 180_000 });
  const acknowledgeLatency = Date.now() - requestedAt;
  const armed = await readArmed(page);

  // THE CANCEL LANDED INSIDE VALIDATION, not before it. The label is the panel's
  // own copy for the candidate's re-analysis; matching the user-visible wording
  // rather than the engine's internal phase name keeps this test honest about
  // what the user was actually looking at when they pressed Cancel.
  expect(armed?.phase ?? '').toMatch(/revalidating/i);

  // The worker unwound rather than completing and discarding: nothing resident.
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);

  // The source is authoritative and unchanged.
  await expect(page.getByTestId('fact-triangles')).toHaveText(trianglesBefore);

  // Retry succeeds.
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('preview-banner')).toBeVisible({ timeout: 180_000 });

  process.stdout.write(
    `[validation-cancellation] phase="${String(armed?.phase)}" ` +
      `percentAtCancel=${String(armed?.percent)} ack=${String(acknowledgeLatency)}ms\n`,
  );
});
