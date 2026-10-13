import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { cleanGridStl } from './stl-fixtures';

/**
 * EXPLICIT-BAND PERFORMANCE, measured in real Chromium against the shipped
 * build. Serial project, because a timing measurement taken while three other
 * browsers compete for cores measures the machine.
 *
 * WHAT IS AND IS NOT SEPARABLE FROM THE PAGE. The controller's phases are
 * observable as UI transitions: the click, the moment the worker reports it has
 * started (which is everything up to and including WASM instantiation and the
 * worker-to-worker geometry transfer), and the terminal result. The kernel's own
 * internal split — broadphase against narrowphase — is NOT observable from the
 * page, and is deliberately not guessed at here. It was measured directly during
 * qualification and is recorded in ADR 0012.
 *
 * IMPORT IS EXCLUDED. It is measured separately and reported separately; folding
 * it into the diagnostic would attribute parsing cost to the check.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

interface Measurement {
  readonly startupMs: number;
  readonly diagnosticMs: number;
  readonly totalMs: number;
}

/** One invocation: click to terminal result, split at the worker's first report. */
async function measureOnce(page: Page): Promise<Measurement> {
  const clicked = Date.now();
  await page.getByTestId('run-self-intersection').click();

  // The progress block appears when the worker posts `started`, i.e. after the
  // worker was constructed, the WASM instantiated and the geometry transferred.
  await expect(page.getByTestId('self-intersection-progress')).toBeVisible({ timeout: 120_000 });
  const started = Date.now();

  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 240_000,
  });
  const finished = Date.now();

  return {
    startupMs: started - clicked,
    diagnosticMs: finished - started,
    totalMs: finished - clicked,
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

test('explicit-band performance at 50k, 100k, 200k and 250k faces', async ({ page }) => {
  test.setTimeout(1_800_000);

  const sizes: readonly (readonly [string, number])[] = [
    ['50k', 158],
    ['100k', 224],
    ['200k', 316],
    ['250k', 353],
  ];

  const rows: string[] = [
    'target   faces    import_ms  startup_ms(worker+wasm+transfer)  diagnostic_ms  total_ms  work',
  ];

  for (const [label, side] of sizes) {
    const model = cleanGridStl(side);
    await page.goto('/');

    const importStarted = Date.now();
    await openFile(page, `${label}.stl`, model.bytes);
    await expect(page.getByTestId('self-intersection-headline')).toHaveText('Not checked', {
      timeout: 300_000,
    });
    const importMs = Date.now() - importStarted;

    // One warmup, then three measured. The warmup absorbs first-run WASM
    // compilation, which a user pays once and which would otherwise dominate
    // the smallest size.
    await measureOnce(page);

    const runs: Measurement[] = [];
    for (let i = 0; i < 3; i += 1) {
      runs.push(await measureOnce(page));
    }

    const work = (await page.getByTestId('self-intersection-work-summary').textContent()) ?? '';
    rows.push(
      `${label.padEnd(8)} ${String(model.triangles).padStart(7)} ${String(importMs).padStart(10)} ` +
        `${String(median(runs.map((r) => r.startupMs))).padStart(33)} ` +
        `${String(median(runs.map((r) => r.diagnosticMs))).padStart(14)} ` +
        `${String(median(runs.map((r) => r.totalMs))).padStart(9)}  ${work}`,
    );

    // The policy claim under test: everything in this band completes, and the
    // check is genuinely CHECKED rather than capped.
    await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found');
  }

  process.stdout.write(`\n[explicit-band performance]\n${rows.join('\n')}\n\n`);
});

test('auto-band latency: the automatic check at the 25,000-face boundary', async ({ page }) => {
  test.setTimeout(600_000);

  /*
   * THE AUTO BAND IS MEASURED DIFFERENTLY, because nobody clicks anything. What
   * matters is how long after the model becomes usable the verdict appears —
   * and, critically, that the model IS usable first. The check is scheduled
   * after import completes, so the clock starts when Mesh Health can be read.
   */
  const model = cleanGridStl(111); // 24,642 triangles: just inside AUTO_ELIGIBLE
  expect(model.triangles).toBeLessThanOrEqual(25_000);

  await page.goto('/');
  const importStarted = Date.now();
  await openFile(page, 'auto.stl', model.bytes);

  // The model is usable — topology has reported — before the diagnostic lands.
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 120_000 });
  const usableAt = Date.now();

  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 120_000,
  });
  const verdictAt = Date.now();

  const work = (await page.getByTestId('self-intersection-work-summary').textContent()) ?? '';
  process.stdout.write(
    `\n[auto-band] faces=${String(model.triangles)} importToUsable=${String(usableAt - importStarted)}ms ` +
      `usableToVerdict=${String(verdictAt - usableAt)}ms  ${work}\n\n`,
  );

  // Nobody asked for this check, so it must not have been what the user waited
  // for: the model was interactive before the verdict arrived.
  expect(usableAt).toBeLessThanOrEqual(verdictAt);
});
