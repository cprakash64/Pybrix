import { revealControl } from '../e2e/progressive-disclosure';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { denseTruck, manyShellTruck, toBinaryStl } from '@cadfixer/auto-split/fixtures';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { openInspector } from '../e2e/inspector';

/**
 * AUTO SPLIT AT THE LARGE-MESH CEILING, IN CHROMIUM (AUTO-SPLIT-LARGE-MESH-02).
 *
 * On demand, serial and slow (a 2,000,000-triangle chain is minutes), so it is skipped unless asked for:
 *
 *   AUTO_SPLIT_LARGE=1 LM_SIZES=1992704,2000000 npm run test:e2e:auto-split -- large-mesh
 *
 * It runs the whole chain the decision requires — import, Auto Split, Vehicle, Find parts, a plane
 * suggestion, Preview, Apply, Undo, Export — and the same for a wheel (components), and it proves the
 * two properties the ceiling must not cost: Apply then Undo exports the ORIGINAL bytes, and the
 * request that leaves the page is the same bounded request at every size. Everything measured goes to
 * artifacts/auto-split-large/ as JSON lines, because a timing is evidence only if it is kept. Nothing
 * here asserts a duration: a threshold on a shared machine measures the machine.
 *
 * LM_SHELLS=<n> adds that many floating boxes; LM_TARGETS picks suggestions (default both a wheel
 * and the cab/bed cut). The provider is the deterministic mock; no key is read, nothing leaves localhost.
 */
const SERVICE = 'http://127.0.0.1:8787';
const OUT = 'artifacts/auto-split-large';
test.skip(process.env.AUTO_SPLIT_LARGE !== '1', 'the large-mesh chain is run on demand');

const SIZES = (process.env.LM_SIZES ?? '1992704,2000000').split(',').map(Number);
const TARGETS = (process.env.LM_TARGETS ?? 'wheel:wheel_1,cab_bed').split(',');
const SHELLS = (process.env.LM_SHELLS ?? '').split(',').filter(Boolean).map(Number);
const SHELL_TARGET = Number(process.env.LM_SHELL_TARGET ?? '1900000');
const TAG = process.env.LM_TAG ?? 'run';
let counter = 0;

/** Resident set of every process the test browser runs, in MiB, or -1 where `ps` cannot say. */
function browserRssMb(): number {
  try {
    const out = execSync(
      "ps -axo rss=,command= | grep -i 'ms-playwright' | grep -v grep | awk '{s+=$1} END {print s+0}'",
      { encoding: 'utf8' },
    );
    return Math.round(Number(out.trim()) / 1024);
  } catch {
    return -1;
  }
}

interface Gaps {
  readonly frames: number;
  readonly maxMs: number;
  readonly p99Ms: number;
}
async function startGaps(page: Page): Promise<void> {
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
}
async function stopGaps(page: Page): Promise<Gaps> {
  const gaps = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean };
    w.__stop = true;
    return w.__gaps;
  });
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    frames: gaps.length,
    maxMs: Math.round(sorted.at(-1) ?? 0),
    p99Ms: Math.round(sorted[Math.floor(sorted.length * 0.99)] ?? 0),
  };
}

async function exportDigest(
  page: Page,
): Promise<{ readonly bytes: number; readonly sha: string; readonly ms: number }> {
  const started = Date.now();
  const download = page.waitForEvent('download', { timeout: 900_000 });
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  const hash = createHash('sha256');
  let bytes = 0;
  const file = await download;
  for await (const chunk of await file.createReadStream()) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  // A 100 MB export kept per download is how a long chain fills a small disk: it was hashed, so it goes.
  await file.delete();
  return { bytes, sha: hash.digest('hex').slice(0, 16), ms: Date.now() - started };
}

async function importMesh(page: Page, mesh: CanonicalMesh): Promise<number> {
  const triangles = mesh.indices.length / 3;
  const dir = mkdtempSync(join(tmpdir(), 'lm02-'));
  const path = join(dir, 'truck.stl');
  writeFileSync(path, toBinaryStl(mesh));
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(path);
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString('en-US'), {
    timeout: 900_000,
  });
  rmSync(dir, { recursive: true, force: true });
  return triangles;
}

test.beforeEach(async ({ page }) => {
  counter += 1;
  await page.setExtraHTTPHeaders({
    'x-real-ip': `10.77.${String(counter >> 8)}.${String(counter & 255)}`,
  });
  await page.request.post(`${SERVICE}/api/auto-split/__mock/reset`);
  await page.request.post(`${SERVICE}/api/auto-split/__mock/scenario`, {
    data: { scenario: 'vehicle-truck-plane' },
  });
  await page.goto('/');
});

/** Everything the page asks the network for, so "nothing but the bounded request" is a fact, not a belief. */
function watchNetwork(page: Page): {
  readonly analyze: { method: string; bytes: number }[];
  readonly foreign: string[];
  readonly bigBodies: string[];
} {
  const record = {
    analyze: [] as { method: string; bytes: number }[],
    foreign: [] as string[],
    bigBodies: [] as string[],
  };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
      record.foreign.push(request.url());
    const body = request.postDataBuffer();
    if (url.pathname === '/api/auto-split/analyze')
      record.analyze.push({ method: request.method(), bytes: body?.length ?? 0 });
    else if (body !== null && body.length > 4096)
      record.bigBodies.push(`${request.method()} ${url.pathname} ${String(body.length)}`);
  });
  return record;
}

async function chain(page: Page, mesh: CanonicalMesh, label: string): Promise<void> {
  const log = (row: Record<string, unknown>): void => {
    mkdirSync(OUT, { recursive: true });
    const line = JSON.stringify({ label, ...row });
    appendFileSync(`${OUT}/browser-${TAG}.jsonl`, `${line}\n`);
    console.warn(line);
  };
  const problems: string[] = [];
  page.on('crash', () => problems.push('PAGE CRASH'));
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message.slice(0, 160)}`));
  const network = watchNetwork(page);
  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, browserRssMb());
  }, 400);
  try {
    const rssStart = browserRssMb();
    let t = Date.now();
    const triangles = await importMesh(page, mesh);
    log({
      phase: 'import',
      triangles,
      ms: Date.now() - t,
      rssMB: browserRssMb(),
      rssStartMB: rssStart,
    });
    // Let the automatic topology work settle so it does not pollute the timings that follow.
    await page.waitForTimeout(3000);
    const original = await exportDigest(page);
    log({ phase: 'export-original', ...original, rssMB: browserRssMb() });

    await page.getByTestId('workflow-split').click();
    await page.getByTestId('split-tab-auto').click();
    // The verdict precedes the question: a part within the ceiling shows no size card.
    await expect(page.getByTestId('auto-too-detailed')).toHaveCount(0);
    await revealControl(page, page.getByTestId('auto-kind-vehicle'));
    await page.getByTestId('auto-kind-vehicle').check({ force: true });
    await page.getByTestId('auto-disclosure-continue').click();
    await startGaps(page);
    t = Date.now();
    await page.getByTestId('auto-analyze').click();
    // The phases the person reads, observed as they pass.
    const seen: string[] = [];
    const watcher = setInterval(() => {
      void page
        .getByTestId('auto-status')
        .textContent({ timeout: 200 })
        .then((text) => {
          const note = (text ?? '').trim();
          if (note !== '' && seen.at(-1) !== note) seen.push(note);
        })
        .catch(() => undefined);
    }, 150);
    await expect(
      page.locator('[data-testid="auto-results"], [data-testid="auto-error"]').first(),
    ).toBeVisible({ timeout: 900_000 });
    clearInterval(watcher);
    const find = { ms: Date.now() - t, gaps: await stopGaps(page) };
    const state = (await (
      await page.request.get(`${SERVICE}/api/auto-split/__mock/state`)
    ).json()) as {
      received: { imageCount: number; imageBytes: number[] }[];
    };
    log({
      phase: 'find-parts',
      ...find,
      errorShown: (await page.getByTestId('auto-error').count()) > 0,
      phasesSeen: seen,
      providerRequests: state.received.length,
      imageCount: state.received[0]?.imageCount,
      analyzeRequests: network.analyze,
      rssMB: browserRssMb(),
    });
    expect(await page.getByTestId('auto-error').count()).toBe(0);
    // No size refusal, no retry, and the request is the bounded one: six images and three numbers.
    expect(state.received).toHaveLength(1);
    expect(state.received[0]?.imageCount).toBe(6);
    expect(network.analyze).toHaveLength(1);
    expect(network.analyze[0]?.bytes ?? Infinity).toBeLessThan(1_000_000);
    const statuses: Record<string, string> = {};
    for (const element of await page.locator('[data-testid^="auto-row-status-"]').all())
      statuses[
        ((await element.getAttribute('data-testid')) ?? '').replace('auto-row-status-', '')
      ] = ((await element.textContent()) ?? '').trim();
    log({ phase: 'suggestions', statuses });

    for (const id of TARGETS) {
      if (id !== TARGETS[0]) {
        // Undo moved the revision on: the list is stale, so look again at the part now shown.
        await page.getByTestId('workflow-split').click();
        await page.getByTestId('split-tab-auto').click();
        const again = page.getByTestId('auto-reanalyze');
        if ((await again.count()) > 0) {
          t = Date.now();
          await again.click();
          await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 900_000 });
          await expect(page.getByTestId('auto-stale')).toHaveCount(0, { timeout: 900_000 });
          log({ phase: 'reanalyze-after-undo', ms: Date.now() - t, rssMB: browserRssMb() });
        }
      }
      const preview = page.getByTestId(`auto-preview-${id}`);
      if ((await preview.count()) === 0 || !(await preview.isEnabled())) {
        log({ phase: `preview-${id}`, skipped: true });
        continue;
      }
      await startGaps(page);
      t = Date.now();
      await preview.click();
      let refused: string | undefined;
      for (;;) {
        if ((await page.getByTestId('split-preview-label').count()) > 0) break;
        const note = page
          .locator(
            '[role=alert], [data-testid="auto-needs-room"], [data-testid="split-resource-limit"]',
          )
          .first();
        if ((await note.count()) > 0) {
          refused = ((await note.textContent()) ?? '').slice(0, 220);
          break;
        }
        if (Date.now() - t > 900_000) {
          refused = 'TIMEOUT';
          break;
        }
        await page.waitForTimeout(500);
      }
      log({
        phase: `preview-${id}`,
        ms: Date.now() - t,
        refused,
        gaps: await stopGaps(page),
        rssMB: browserRssMb(),
      });
      expect(refused, `Preview of ${id} was refused`).toBeUndefined();

      await startGaps(page);
      t = Date.now();
      await page.getByTestId('split-apply').click();
      await expect(page.getByTestId('split-undo')).toBeVisible({ timeout: 900_000 });
      log({
        phase: `apply-${id}`,
        ms: Date.now() - t,
        gaps: await stopGaps(page),
        rssMB: browserRssMb(),
      });

      await startGaps(page);
      t = Date.now();
      await page.getByTestId('split-undo').click();
      await expect(page.getByTestId('split-undo')).toHaveCount(0, { timeout: 900_000 });
      await expect(page.getByTestId('fact-triangles')).toHaveText(
        triangles.toLocaleString('en-US'),
      );
      log({
        phase: `undo-${id}`,
        ms: Date.now() - t,
        gaps: await stopGaps(page),
        rssMB: browserRssMb(),
      });

      const after = await exportDigest(page);
      const identical = after.sha === original.sha && after.bytes === original.bytes;
      log({
        phase: `export-after-undo-${id}`,
        ...after,
        byteIdenticalToOriginal: identical,
        rssMB: browserRssMb(),
      });
      expect(identical, `export after Undo of ${id} differs from the original export`).toBe(true);
    }
    // Nothing but the bounded request left the page, and nothing left localhost.
    expect(network.foreign).toEqual([]);
    expect(network.bigBodies).toEqual([]);
    log({ phase: 'end', peakRssMB: peakRss, problems, analyzeRequests: network.analyze.length });
    expect(problems).toEqual([]);
  } finally {
    clearInterval(sampler);
  }
}

for (const size of SIZES)
  test(`the whole chain at ${String(size)} triangles`, async ({ page }) => {
    test.setTimeout(3_600_000);
    await chain(page, denseTruck(size).mesh, `chain-${String(size)}`);
  });

for (const shells of SHELLS)
  test(`the whole chain with ${String(shells)} extra shells near the ceiling`, async ({ page }) => {
    test.setTimeout(3_600_000);
    await chain(page, manyShellTruck(SHELL_TARGET, shells).mesh, `shells-${String(shells)}`);
  });

/**
 * CANCEL REACHES THE LONG LOCAL PASSES. The page shows "Cancelled" at once whatever the worker does, so
 * the page cannot say whether the worker stopped. What can be measured from outside is how soon the
 * worker is FREE: it handles one request at a time, so a fresh analysis only starts producing progress
 * once the cancelled one has ended. The time from starting a fresh run, immediately after a Cancel, to
 * its first "view n of 6" note, minus the same time with nothing to cancel, is an upper bound on how
 * long the cancelled pass kept running. (The engine's own bound, the longest stretch between two
 * checkpoints, is measured in Node by `scripts/auto-split-large.bench-suite.ts`.)
 *
 * The notes are timed IN THE PAGE by a MutationObserver: Playwright's own polling backs off to hundreds
 * of milliseconds and would miss notes that last a few hundred.
 */
async function observeStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __notes: { t: number; text: string }[] };
    w.__notes = [];
    const read = (): void => {
      const text = document.querySelector('[data-testid="auto-status"]')?.textContent.trim() ?? '';
      if (text !== '' && w.__notes.at(-1)?.text !== text)
        w.__notes.push({ t: performance.now(), text });
    };
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}
/** Clicks inside the page and returns the page's own clock at the click. */
async function clickAt(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const at = performance.now();
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`no element ${id}`);
    element.click();
    return at;
  }, testId);
}
async function firstNoteAfter(page: Page, since: number, pattern: RegExp): Promise<number> {
  for (let attempt = 0; attempt < 6000; attempt += 1) {
    const found = await page.evaluate(
      ([from, source]) => {
        const notes = (window as unknown as { __notes: { t: number; text: string }[] }).__notes;
        return notes.find((n) => n.t >= from && new RegExp(source).test(n.text))?.t;
      },
      [since, pattern.source] as const,
    );
    if (found !== undefined) return found;
    await page.waitForTimeout(50);
  }
  throw new Error(`no status note matching ${String(pattern)}`);
}

test(`Cancel is observed by the worker, not just shown, at ${process.env.LM_CANCEL_SIZE ?? '2000000'} triangles`, async ({
  page,
}) => {
  test.setTimeout(1_800_000);
  const size = Number(process.env.LM_CANCEL_SIZE ?? '2000000');
  await importMesh(page, denseTruck(size).mesh);
  await page.waitForTimeout(3000);
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await revealControl(page, page.getByTestId('auto-kind-vehicle'));
  await page.getByTestId('auto-kind-vehicle').check({ force: true });
  await page.getByTestId('auto-disclosure-continue').click();
  await observeStatus(page);
  const view = /view \d of 6/;

  // The reference: a fresh run to its first progress note, with nothing in the way.
  const referenceClick = await clickAt(page, 'auto-analyze');
  const referenceNote = await firstNoteAfter(page, referenceClick, view);
  const reference = referenceNote - referenceClick;
  // Cancel in the middle of the renders, and start again at once.
  await page.waitForTimeout(250);
  const cancelClick = await clickAt(page, 'auto-cancel');
  await expect(page.getByTestId('auto-cancelled')).toBeVisible();
  const restartClick = await clickAt(page, 'auto-analyze');
  const restartNote = await firstNoteAfter(page, restartClick, view);
  const afterRender = restartNote - restartClick;

  // Let this run reach the local suggestion pass, cancel in it, and start again at once.
  const reviewing = await firstNoteAfter(page, restartClick, /Reviewing candidate cuts/);
  await page.waitForTimeout(200);
  const cancelOffered = (await page.getByTestId('auto-cancel').count()) > 0;
  let afterReview: number | undefined;
  if (cancelOffered) {
    await clickAt(page, 'auto-cancel');
    await expect(page.getByTestId('auto-cancelled')).toBeVisible();
    const again = await clickAt(page, 'auto-analyze');
    afterReview = (await firstNoteAfter(page, again, view)) - again;
  }
  mkdirSync(OUT, { recursive: true });
  const row = {
    label: `cancel-${String(size)}`,
    referenceFirstViewMs: Math.round(reference),
    afterCancelDuringRenderMs: Math.round(afterRender),
    extraOverReferenceRenderMs: Math.round(afterRender - reference),
    cancelClickToRestartClickMs: Math.round(restartClick - cancelClick),
    reviewingNoteAtMs: Math.round(reviewing - restartClick),
    cancelStillOfferedWhileReviewing: cancelOffered,
    afterCancelDuringReviewMs: afterReview === undefined ? undefined : Math.round(afterReview),
    extraOverReferenceReviewMs:
      afterReview === undefined ? undefined : Math.round(afterReview - reference),
  };
  appendFileSync(`${OUT}/browser-${TAG}.jsonl`, `${JSON.stringify(row)}\n`);
  console.warn(JSON.stringify(row));
  // A generous bound: a measured one on a loaded machine is a report, not a gate.
  expect(afterRender - reference).toBeLessThan(2_000);
  if (afterReview !== undefined) expect(afterReview - reference).toBeLessThan(2_000);
});

test('2,000,001 triangles: a neutral status before anything runs, and the provider is never asked', async ({
  page,
}) => {
  test.setTimeout(1_800_000);
  const network = watchNetwork(page);
  const triangles = await importMesh(page, denseTruck(2_000_001).mesh);
  expect(triangles).toBe(2_000_001);
  const before = await exportDigest(page);
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  const card = page.getByTestId('auto-too-detailed');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('auto-too-detailed-size')).toHaveText('2,000,001 triangles');
  await expect(page.getByTestId('auto-too-detailed-unchanged')).toHaveText(
    'Your model is unchanged and nothing was sent.',
  );
  // A fact, not a failure: no alert, no retry, no way to start the analysis.
  await expect(page.locator('[role=alert]')).toHaveCount(0);
  for (const id of ['auto-analyze', 'auto-try-again', 'auto-start-over', 'auto-cancel'])
    await expect(page.getByTestId(id)).toHaveCount(0);
  // Manual Split says the same, and does not ask the worker.
  await page.getByTestId('split-tab-manual').click();
  await expect(page.getByTestId('split-too-detailed')).toBeVisible();
  await expect(page.getByTestId('split-preview')).toBeDisabled();
  const state = (await (
    await page.request.get(`${SERVICE}/api/auto-split/__mock/state`)
  ).json()) as {
    received: unknown[];
  };
  // Provider attempts at refusal: zero, and the browser made no request to the service either.
  expect(state.received).toHaveLength(0);
  expect(network.analyze).toHaveLength(0);
  expect(network.foreign).toEqual([]);
  // The model is untouched: it exports the same bytes.
  const after = await exportDigest(page);
  expect(after.sha).toBe(before.sha);
  mkdirSync(OUT, { recursive: true });
  appendFileSync(
    `${OUT}/browser-${TAG}.jsonl`,
    `${JSON.stringify({ label: 'refusal-2000001', providerRequests: 0, browserAnalyzeRequests: 0, exportIdentical: true })}\n`,
  );
});

/**
 * SCREENSHOTS of the states this stage added, for review: the size notice in both tabs, the three
 * phases the person reads, and the results at the ceiling. On demand (`LM_SHOTS=1`), written to
 * artifacts/auto-split-large/screens/ (git-ignored).
 */
test('screenshots: the size notice, the phases and the results at the ceiling', async ({
  page,
}) => {
  test.skip(process.env.LM_SHOTS !== '1', 'screenshots are captured on demand');
  test.setTimeout(1_800_000);
  const dir = `${OUT}/screens`;
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. A model one triangle over the ceiling: the notice, in Auto Split and in Manual Split.
  await importMesh(page, denseTruck(2_000_001).mesh);
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await expect(page.getByTestId('auto-too-detailed')).toBeVisible();
  await page.screenshot({ path: `${dir}/01-auto-too-detailed.png` });
  await page.getByTestId('split-tab-manual').click();
  await expect(page.getByTestId('split-too-detailed')).toBeVisible();
  await page.screenshot({ path: `${dir}/02-manual-too-detailed.png` });

  // 2. The same model, but within the ceiling and with a slow provider: each phase as it is read.
  await page.goto('/');
  await page.request.post(`${SERVICE}/api/auto-split/__mock/scenario`, {
    data: { scenario: 'vehicle-truck-plane', behaviour: 'ok', delayMs: 4000 },
  });
  await importMesh(page, denseTruck(2_000_000).mesh);
  await page.waitForTimeout(3000);
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await revealControl(page, page.getByTestId('auto-kind-vehicle'));
  await page.getByTestId('auto-kind-vehicle').check({ force: true });
  await page.screenshot({ path: `${dir}/03-auto-disclosure.png` });
  await page.getByTestId('auto-disclosure-continue').click();
  await page.screenshot({ path: `${dir}/04-auto-ready.png` });
  await page.getByTestId('auto-analyze').click();
  await expect(page.getByTestId('auto-status')).toContainText(/Preparing model/, {
    timeout: 60_000,
  });
  await page.screenshot({ path: `${dir}/05-preparing-model.png` });
  await expect(page.getByTestId('auto-status')).toContainText(/Looking for parts/, {
    timeout: 120_000,
  });
  await page.screenshot({ path: `${dir}/06-looking-for-parts.png` });
  await expect(page.getByTestId('auto-status')).toContainText(/Reviewing candidate cuts/, {
    timeout: 120_000,
  });
  await page.screenshot({ path: `${dir}/07-reviewing-candidate-cuts.png` });
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 300_000 });
  await page.screenshot({ path: `${dir}/08-results-at-the-ceiling.png` });
  await page.getByTestId('auto-preview-cab_bed').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 600_000 });
  await page.screenshot({ path: `${dir}/09-cab-bed-preview-at-the-ceiling.png` });
});

/**
 * THE REPORTED FILE, READ-ONLY. `LM_FILE=<path to a binary STL>` tests size acceptance separately
 * from closed-solid readiness. Import and Find parts must run without a size refusal. An open input
 * must receive the plain topology status in both tabs, offer safe Repair navigation, and export the
 * original bytes after refusal. A closed input can additionally Preview, Apply, Undo and export.
 * The deterministic mock describes the synthetic truck; it does not promise usable cuts on every
 * real model. The separate closed 2M fixture proves the complete exact-split chain.
 */
test('the reported file: size acceptance and topology-aware splitting preserve the original export', async ({
  page,
}) => {
  const file = process.env.LM_FILE;
  test.skip(file === undefined, 'set LM_FILE to a binary STL to run this on a real model');
  if (file === undefined) return;
  test.setTimeout(3_600_000);
  const log = (row: Record<string, unknown>): void => {
    mkdirSync(OUT, { recursive: true });
    const line = JSON.stringify({ label: 'real-file', ...row });
    appendFileSync(`${OUT}/browser-${TAG}.jsonl`, `${line}\n`);
    console.warn(line);
  };
  const network = watchNetwork(page);
  const problems: string[] = [];
  page.on('crash', () => problems.push('PAGE CRASH'));
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message.slice(0, 160)}`));
  let t = Date.now();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(file);
  await expect(page.getByTestId('fact-triangles')).toHaveText(/^[\d,]+$/, { timeout: 900_000 });
  const triangleText = ((await page.getByTestId('fact-triangles').textContent()) ?? '').trim();
  log({ phase: 'import', triangles: triangleText, ms: Date.now() - t, rssMB: browserRssMb() });
  await page.waitForTimeout(3000);
  const original = await exportDigest(page);
  log({ phase: 'export-original', ...original, rssMB: browserRssMb() });

  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await expect(page.getByTestId('auto-too-detailed')).toHaveCount(0);
  await revealControl(page, page.getByTestId('auto-kind-vehicle'));
  await page.getByTestId('auto-kind-vehicle').check({ force: true });
  await page.getByTestId('auto-disclosure-continue').click();
  await startGaps(page);
  t = Date.now();
  await page.getByTestId('auto-analyze').click();
  await expect(
    page
      .locator(
        '[data-testid="auto-results"], [data-testid="auto-error"], [data-testid="auto-source-not-ready"]',
      )
      .first(),
  ).toBeVisible({ timeout: 900_000 });
  log({
    phase: 'find-parts',
    ms: Date.now() - t,
    gaps: await stopGaps(page),
    errorShown: (await page.getByTestId('auto-error').count()) > 0,
    sourceNotReady: (await page.getByTestId('auto-source-not-ready').count()) > 0,
    rssMB: browserRssMb(),
  });
  expect(await page.getByTestId('auto-error').count()).toBe(0);
  const statuses: Record<string, string> = {};
  for (const element of await page.locator('[data-testid^="auto-row-status-"]').all())
    statuses[((await element.getAttribute('data-testid')) ?? '').replace('auto-row-status-', '')] =
      ((await element.textContent()) ?? '').trim();
  log({ phase: 'suggestions', statuses });

  const applyUndo = async (label: string, start: () => Promise<void>): Promise<void> => {
    await startGaps(page);
    t = Date.now();
    await start();
    await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 900_000 });
    log({
      phase: `preview-${label}`,
      ms: Date.now() - t,
      gaps: await stopGaps(page),
      rssMB: browserRssMb(),
    });
    t = Date.now();
    await page.getByTestId('split-apply').click();
    await expect(page.getByTestId('split-undo')).toBeVisible({ timeout: 900_000 });
    log({ phase: `apply-${label}`, ms: Date.now() - t, rssMB: browserRssMb() });
    t = Date.now();
    await page.getByTestId('split-undo').click();
    await expect(page.getByTestId('split-undo')).toHaveCount(0, { timeout: 900_000 });
    log({ phase: `undo-${label}`, ms: Date.now() - t, rssMB: browserRssMb() });
    const after = await exportDigest(page);
    const identical = after.sha === original.sha && after.bytes === original.bytes;
    log({ phase: `export-after-undo-${label}`, ...after, byteIdenticalToOriginal: identical });
    expect(identical, `export after Undo of ${label} differs from the original export`).toBe(true);
  };

  const notClosed = (await page.getByTestId('auto-source-not-ready').count()) > 0;
  if (notClosed) {
    // A property of the FILE, not of its size: a surface with openings cannot be split by either
    // tool until it is repaired. What must hold is that this is said as what it is, that no size verdict
    // is given, and that the attempt leaves the model exactly as it was.
    const autoNotice = page.getByTestId('auto-source-not-ready');
    await expect(autoNotice).toHaveAttribute('role', 'status');
    await expect(autoNotice).toContainText('Your original model was not changed.');
    await expect(autoNotice).toContainText('This model needs repair before it can be split.');
    expect(await autoNotice.textContent()).not.toMatch(
      /manifold|topology|triangle soup|workspace|try again/i,
    );
    await expect(page.getByTestId('auto-run-repair')).toBeVisible();
    await page.getByTestId('auto-run-repair').click();
    await expect(page.getByTestId('preview-repair')).toBeVisible();
    await page.getByTestId('workflow-split').click();
    await page.getByTestId('split-tab-manual').click();
    await page.getByTestId('split-preview').click();
    const refusal = page.getByTestId('split-not-closed');
    await expect(refusal).toBeVisible({ timeout: 300_000 });
    const text = ((await refusal.textContent()) ?? '').trim();
    log({
      phase: 'manual-preview-refused',
      text: text.slice(0, 300),
      sizeVerdict: /too detailed|more room/i.test(text),
    });
    await expect(refusal).toHaveAttribute('role', 'status');
    await expect(refusal).toContainText('Your original model was not changed.');
    await expect(page.getByTestId('split-error')).toHaveCount(0);
    expect(text).not.toMatch(
      /too detailed|more room|limit|manifold|topology|triangle soup|workspace|try again/i,
    );
    const unchanged = await exportDigest(page);
    log({
      phase: 'export-after-refusal',
      ...unchanged,
      byteIdenticalToOriginal: unchanged.sha === original.sha,
    });
    expect(unchanged.sha).toBe(original.sha);
  } else {
    let executed = 0;
    for (const id of Object.keys(statuses)) {
      if (executed >= 2) break;
      const preview = page.getByTestId(`auto-preview-${id}`);
      if ((await preview.count()) === 0 || !(await preview.isEnabled())) continue;
      executed += 1;
      await applyUndo(`auto-${id.replace(':', '_')}`, async () => {
        await preview.click();
      });
      // Undo moved the revision on, so the list is stale: look at the part now shown before the next one.
      await page.getByTestId('workflow-split').click();
      await page.getByTestId('split-tab-auto').click();
      const again = page.getByTestId('auto-reanalyze');
      if ((await again.count()) > 0) {
        await again.click();
        await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 900_000 });
        await expect(page.getByTestId('auto-stale')).toHaveCount(0, { timeout: 900_000 });
      }
    }
    log({ phase: 'auto-suggestions-executed', executed });
    // Manual Split through the middle: independent of the provider, so the exact split at this size is
    // exercised on this file even if no suggestion was executable.
    await page.getByTestId('split-tab-manual').click();
    await applyUndo('manual-centre', async () => {
      await page.getByTestId('split-preview').click();
    });
  }
  expect(network.analyze.length).toBeLessThanOrEqual(3);
  expect(network.foreign).toEqual([]);
  expect(network.bigBodies).toEqual([]);
  log({ phase: 'end', problems, analyzeRequests: network.analyze });
  expect(problems).toEqual([]);
});

/**
 * WHAT THE CURRENT REPAIR DOES FOR THE REPORTED FILE: an OBSERVATION, not a promise. `LM_FILE` and
 * `LM_REPAIR=1`: open the file read-only, look at what Repair offers, build its conservative candidate
 * and apply it (in memory; the file on disk is never written), then ask Split whether the part is ready.
 * It decides nothing about Repair's scope; it records what Repair does today.
 */
test('the reported file in Repair: does the current Repair make it splittable', async ({
  page,
}) => {
  const file = process.env.LM_FILE;
  test.skip(file === undefined || process.env.LM_REPAIR !== '1', 'set LM_FILE and LM_REPAIR=1');
  if (file === undefined) return;
  test.setTimeout(3_600_000);
  const dir = `${OUT}/screens`;
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const log = (row: Record<string, unknown>): void => {
    mkdirSync(OUT, { recursive: true });
    const line = JSON.stringify({ label: 'real-repair', ...row });
    appendFileSync(`${OUT}/browser-${TAG}.jsonl`, `${line}\n`);
    console.warn(line);
  };
  const readiness = async (): Promise<Record<string, unknown>> => {
    await page.getByTestId('workflow-split').click();
    await page.getByTestId('split-tab-auto').click();
    await revealControl(page, page.getByTestId('auto-kind-vehicle'));
    await page.getByTestId('auto-kind-vehicle').check({ force: true });
    if ((await page.getByTestId('auto-disclosure-continue').count()) > 0)
      await page.getByTestId('auto-disclosure-continue').click();
    await page.getByTestId('auto-analyze').click();
    await expect(
      page.locator('[data-testid="auto-results"], [data-testid="auto-error"]').first(),
    ).toBeVisible({ timeout: 900_000 });
    const notReady = (await page.getByTestId('auto-source-not-ready').count()) > 0;
    const text = notReady
      ? ((await page.getByTestId('auto-source-not-ready').textContent()) ?? '').trim()
      : '';
    return { splitReady: !notReady, notReadyText: text };
  };
  const counts = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const element of await page.locator('[data-testid^="issue-count-"]').all())
      out[((await element.getAttribute('data-testid')) ?? '').replace('issue-count-', '')] = (
        (await element.textContent()) ?? ''
      ).trim();
    return out;
  };

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(file);
  await expect(page.getByTestId('fact-triangles')).toHaveText(/^[\d,]+$/, { timeout: 900_000 });
  await page.waitForTimeout(4000);
  const original = await exportDigest(page);
  await page.getByTestId('workflow-repair').click();
  await page.waitForTimeout(5000);
  await openInspector(page);
  log({ phase: 'before', counts: await counts() });
  await page.screenshot({ path: `${dir}/20-real-repair-before.png` });

  let t = Date.now();
  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  const outcome = page.locator(
    '[data-testid="apply-repair"], [data-testid="repair-no-safe-change"], [data-testid="repair-plan-error"], [data-testid="repair-candidate-error"]',
  );
  await expect(outcome.first()).toBeVisible({ timeout: 900_000 });
  const applyOffered = (await page.getByTestId('apply-repair').count()) > 0;
  log({
    phase: 'repair-preview',
    ms: Date.now() - t,
    applyOffered,
    noSafeChange: (await page.getByTestId('repair-no-safe-change').count()) > 0,
    planError: (await page.getByTestId('repair-plan-error').count()) > 0,
    candidateError: (await page.getByTestId('repair-candidate-error').count()) > 0,
    notes: await page.getByTestId('repair-plan-warnings').allTextContents(),
  });
  await page.screenshot({ path: `${dir}/21-real-repair-preview.png` });
  let after: Record<string, unknown> = {};
  if (applyOffered) {
    t = Date.now();
    await page.getByTestId('apply-repair').click();
    await revealControl(page, page.getByTestId('repair-applied'));
    await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 900_000 });
    await page.waitForTimeout(8000);
    log({ phase: 'repair-applied', ms: Date.now() - t, counts: await counts() });
    await page.screenshot({ path: `${dir}/22-real-repair-applied.png` });
    after = await readiness();
    log({ phase: 'split-readiness-after-repair', ...after });
    await page.screenshot({ path: `${dir}/23-real-split-after-repair.png` });
  }
  const verdict = applyOffered
    ? after.splitReady === true
      ? 'REPAIR_MAKES_SPLITTABLE'
      : 'REPAIR_IMPROVES_OR_CHANGES_BUT_NOT_SPLITTABLE'
    : 'REPAIR_DOES_NOT_RESOLVE_TOPOLOGY';
  log({ phase: 'verdict', verdict, originalSha: original.sha });
});
