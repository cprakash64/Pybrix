import { readFileSync, existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { pinchedPairsStl } from '../e2e/local-repair-fixtures';
import {
  applyAndSettle,
  auditConsole,
  browserRssMiB,
  counts,
  enterRepair,
  exportStlAndReadBack,
  importModel,
  jsHeapMiB,
  liveWorkers,
  readSummary,
  record,
  settled,
  waitForResult,
  type ConsoleAudit,
} from './rc';

/**
 * REPAIR-CORE-07 — A COMPACT REAL SMOKE SET, THROUGH THE PUBLIC UI OF THE PACKAGED ARTIFACT.
 *
 * The corpus stays outside git: `CADFIXER_CORPUS` names corpus-X.json and `CADFIXER_D0` the
 * development truck's corpus file. Each model runs the whole shipping path with wall times and
 * browser memory sampled from outside. Skipped when the corpus is not on the machine.
 */

const corpusPath = process.env.CADFIXER_CORPUS ?? '';
const d0Path = process.env.CADFIXER_D0 ?? '';
const expectationsDir = process.env.CADFIXER_EXPECTATIONS ?? '';
const enabled = corpusPath !== '' && existsSync(corpusPath);

function pathOf(id: string): string {
  const read = (file: string): { models: { id: string; path: string }[] } =>
    JSON.parse(readFileSync(file, 'utf8')) as { models: { id: string; path: string }[] };
  const source = id === 'D0' ? d0Path : corpusPath;
  const entry = read(source).models.find((model) => model.id === id);
  if (entry === undefined) throw new Error(`unknown model ${id}`);
  return entry.path;
}

interface Expectation {
  readonly kind: string;
  readonly faces: number;
  readonly counts: { readonly repaired: number };
  readonly before: { readonly nonManifoldVertices: number };
  readonly after?: { readonly nonManifoldVertices: number };
}

function expectationOf(id: string): Expectation | undefined {
  const file = `${expectationsDir}/${id}-06a.json`;
  return expectationsDir !== '' && existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Expectation)
    : undefined;
}

/** Samples browser RSS from outside while `body` runs; returns the peak. */
async function withPeak<T>(body: () => Promise<T>): Promise<{ value: T; peakMiB: number }> {
  let peak = browserRssMiB();
  const state = { running: true };
  const sampler = (async (): Promise<void> => {
    while (state.running) {
      peak = Math.max(peak, browserRssMiB());
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  })();
  try {
    return { value: await body(), peakMiB: (peak = Math.max(peak, browserRssMiB())) };
  } finally {
    state.running = false;
    await sampler;
    peak = Math.max(peak, browserRssMiB());
  }
}

let audit: ConsoleAudit;
test.beforeEach(async ({ page }) => {
  audit = await auditConsole(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
});
test.afterEach(() => {
  expect(audit.problems(), 'the console must stay clean').toEqual([]);
});

const mapOutcome = (kind: string): string =>
  kind === 'partial_ambiguous'
    ? 'partial-ambiguous'
    : kind === 'partial_unsupported'
      ? 'partial-unsupported'
      : kind === 'partial_limit'
        ? 'partial-limit'
        : 'complete';

async function importTimed(page: Page, file: string): Promise<number> {
  const t0 = Date.now();
  await importModel(page, file);
  await expect(page.getByTestId('status-triangles')).not.toHaveText(/^\s*$/, { timeout: 600_000 });
  await enterRepair(page);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 600_000 });
  return Date.now() - t0;
}

const SMOKE = ['D0', 'X2', 'X7', 'X8', 'X12', 'X13', 'X15', 'X17'] as const;

for (const id of SMOKE) {
  test(`REAL ${id}: import, analyse, repair, preview, apply, re-analyse, undo, export, re-import`, async ({
    page,
  }) => {
    test.skip(!enabled, 'the external corpus is not on this machine');
    test.setTimeout(1_800_000);
    const expected = expectationOf(id);
    const file = pathOf(id);
    const row: Record<string, unknown> = {
      kind: 'corpus',
      id,
      workersAtStart: await liveWorkers(page),
    };

    const peak = await withPeak(async () => {
      row.importAnalyseMs = await importTimed(page, file);
      const t0 = Date.now();
      const state = await settled(page, 1_200_000);
      row.planMs = Date.now() - t0;
      row.state = state;
      row.triangles = ((await page.getByTestId('status-triangles').textContent()) ?? '').trim();
      const before = await counts(page);
      row.before = before;
      if (expected !== undefined) {
        expect(before['non-manifold-vertices'], 'baseline pinch count').toBe(
          expected.before.nonManifoldVertices.toLocaleString('en-US'),
        );
      }
      if (state === 'nothing') {
        // A clean control (or nothing Pybrix can change): no unsafe candidate is offered.
        await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
        return;
      }

      const t1 = Date.now();
      await page.getByTestId('preview-repair').click();
      const result = await waitForResult(page, 1_200_000);
      row.candidateMs = Date.now() - t1;
      row.result = result;
      if (result !== 'candidate') {
        row.note = ((await page.getByTestId('repair-no-safe-change').textContent()) ?? '').trim();
        expect(await counts(page)).toEqual(before);
        return;
      }
      const summary = await readSummary(page);
      row.summary = summary;
      if (expected !== undefined) expect(summary.outcome).toBe(mapOutcome(expected.kind));
      // Preview is not an application.
      expect(await counts(page)).toEqual(before);
      await expect(page.locator('[role="alert"]')).toHaveCount(0);

      const t2 = Date.now();
      await applyAndSettle(page, 1_200_000);
      row.applyAndReanalyseMs = Date.now() - t2;
      const after = await counts(page);
      row.after = after;
      if (expected?.after !== undefined) {
        expect(after['non-manifold-vertices'], 'fresh post-Apply pinch count').toBe(
          expected.after.nonManifoldVertices.toLocaleString('en-US'),
        );
      }
      row.triangleCountAfter = (
        (await page.getByTestId('status-triangles').textContent()) ?? ''
      ).trim();

      const t3 = Date.now();
      const stl = await exportStlAndReadBack(page);
      row.exportMs = Date.now() - t3;
      row.exportBytes = stl.byteLength;
      await page.getByTestId('undo-repair').click();
      const t4 = Date.now();
      await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 1_200_000 });
      await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 1_200_000 });
      row.undoMs = Date.now() - t4;
      expect(await counts(page)).toEqual(before);
      expect(((await page.getByTestId('status-triangles').textContent()) ?? '').trim()).toBe(
        row.triangles,
      );

      // The exported repaired model comes back through the real importer, and stays repaired.
      const t5 = Date.now();
      await page.goto('/');
      await importModel(page, { name: `${id}-repaired.stl`, mime: 'model/stl', buffer: stl });
      await enterRepair(page);
      await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 1_200_000 });
      await settled(page, 1_200_000).catch(() => 'nothing');
      row.reimportMs = Date.now() - t5;
      row.reimported = await counts(page);
      row.reimportedTriangles = (
        (await page.getByTestId('status-triangles').textContent()) ?? ''
      ).trim();
      expect(row.reimportedTriangles).toBe(row.triangleCountAfter);
    });
    row.peakBrowserRssMiB = peak.peakMiB;
    row.jsHeapMiB = await jsHeapMiB(page);
    row.workersAtEnd = await liveWorkers(page);
    record(row);
  });
}

test('X11 COMPLEXITY LIMIT: bounded, responsive, valid, usable afterwards', async ({ page }) => {
  test.skip(!enabled, 'the external corpus is not on this machine');
  test.setTimeout(1_800_000);
  const row: Record<string, unknown> = { kind: 'x11' };
  await importTimed(page, pathOf('X11'));
  await settled(page, 1_200_000);
  const before = await counts(page);
  row.before = before;
  // Frame gaps WITH timestamps, and the moment the preview appeared: the gap while the repair
  // computes (which must stay off the main thread) is judged separately from the one-off upload
  // of the candidate's render snapshot, which is the documented first-frame GPU upload.
  await page.evaluate(() => {
    const w = window as unknown as {
      __gaps: { at: number; gap: number }[];
      __appeared?: number;
    };
    w.__gaps = [];
    let previous = performance.now();
    const tick = (): void => {
      const now = performance.now();
      w.__gaps.push({ at: now, gap: now - previous });
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new MutationObserver(() => {
      if (
        w.__appeared === undefined &&
        document.querySelector('[data-testid="repair-candidate"]') !== null
      ) {
        w.__appeared = performance.now();
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.waitForTimeout(2_000);
  const idleGap = await page.evaluate(() =>
    Math.max(...(window as unknown as { __gaps: { gap: number }[] }).__gaps.map((g) => g.gap)),
  );
  const started = Date.now();
  const peak = await withPeak(async () => {
    await page.getByTestId('preview-repair').click();
    // Visible activity at once, and Cancel stays within reach for the whole run.
    await expect(page.getByTestId('cancel-repair')).toBeVisible({ timeout: 30_000 });
    expect(await waitForResult(page, 1_200_000)).toBe('candidate');
  });
  row.wallMs = Date.now() - started;
  row.peakBrowserRssMiB = peak.peakMiB;
  const gaps = await page.evaluate(() => {
    const w = window as unknown as { __gaps: { at: number; gap: number }[]; __appeared?: number };
    const appeared = w.__appeared ?? Number.POSITIVE_INFINITY;
    // A gap that ENDS at or after the preview appeared is the upload; earlier ones are the compute.
    const computing = w.__gaps.filter((g) => g.at < appeared).map((g) => g.gap);
    const uploading = w.__gaps.filter((g) => g.at >= appeared).map((g) => g.gap);
    return {
      computing: Math.max(...computing),
      uploading: uploading.length === 0 ? 0 : Math.max(...uploading),
    };
  });
  row.idleFrameGapMs = idleGap;
  row.computeFrameGapMs = gaps.computing;
  row.previewUploadFrameGapMs = gaps.uploading;
  const summary = await readSummary(page);
  row.summary = summary;
  expect(summary.outcome).toBe('partial-limit');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  // The repository's own self-scaling bound (ten times idle, never below 250 ms) and its 1 s cap,
  // applied to the part of the run that is the repair itself.
  expect(gaps.computing).toBeLessThan(Math.max(idleGap * 10, 250));
  expect(gaps.computing).toBeLessThan(1_000);
  // The valid partial candidate applies; its fresh counts are lower; Undo restores the source.
  await applyAndSettle(page, 1_200_000);
  const after = await counts(page);
  row.after = after;
  const pinches = (value: string | undefined): number => Number((value ?? '').replaceAll(',', ''));
  expect(pinches(after['non-manifold-vertices'])).toBeLessThan(
    pinches(before['non-manifold-vertices']),
  );
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 1_200_000 });
  expect(await counts(page)).toEqual(before);
  // The application is usable: another model repairs normally.
  await importModel(page, { name: 'p.stl', mime: 'model/stl', buffer: pinchedPairsStl(3) });
  expect(await settled(page)).toBe('ready');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  row.workersAtEnd = await liveWorkers(page);
  record(row);
});
