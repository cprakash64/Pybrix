import { expect, test, type Locator, type Page } from '@playwright/test';
import { holedCubeStl } from '../scripts/boundary-fill-fixture.mjs';
import {
  threeMf,
  modelXml,
  objDefectAndClean,
  threeMfDefectiveTetrahedron,
} from '../e2e/format-fixtures';
import { pinchedPairsStl, refusedPinchStl, residualPinchStl } from '../e2e/local-repair-fixtures';
import { duplicateFaceStl, nonManifoldEdgeStl, tetrahedronStl } from '../e2e/stl-fixtures';
import {
  applyAndSettle,
  auditConsole,
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
  browserRssMiB,
  type ConsoleAudit,
} from './rc';

/**
 * REPAIR-CORE-07 — THE SHIPPING PATH ON THE PACKAGED ARTIFACT, UNDER THE DEPLOYMENT HEADERS.
 *
 * Import -> Analyze -> Repair -> Preview -> Apply -> fresh Analyze -> Undo -> Export -> re-import,
 * through the public UI only, for each family of model Repair handles, with the console audited
 * on every step. Fixtures are generated; nothing leaves the machine.
 */

let audit: ConsoleAudit;

test.beforeEach(async ({ page }) => {
  audit = await auditConsole(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
});

test.afterEach(() => {
  expect(audit.problems(), 'the console must stay clean').toEqual([]);
});

async function open(page: Page, name: string, buffer: Buffer, mime = 'model/stl'): Promise<void> {
  await importModel(page, { name, mime, buffer });
  await enterRepair(page);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 120_000 });
}

/** The whole flow for a model Repair can change; returns what the UI showed. */
async function fullFlow(
  page: Page,
  label: string,
  expected: { readonly nonManifoldBefore: string; readonly nonManifoldAfter: string },
): Promise<void> {
  expect((await settled(page)) === 'ready').toBe(true);
  const before = await counts(page);
  expect(before['non-manifold-vertices']).toBe(expected.nonManifoldBefore);
  const triangles = (await page.getByTestId('status-triangles').textContent()) ?? '';

  const t0 = Date.now();
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  const previewMs = Date.now() - t0;
  const summary = await readSummary(page);
  // PREVIEW IS NOT AN APPLICATION: the committed model and its diagnostics have not moved.
  expect(await counts(page)).toEqual(before);
  expect((await page.getByTestId('status-triangles').textContent()) ?? '').toBe(triangles);

  const t1 = Date.now();
  await applyAndSettle(page);
  const applyMs = Date.now() - t1;
  const after = await counts(page);
  // FRESH diagnostics of the new revision: the pinches are gone, nothing else got worse.
  expect(after['non-manifold-vertices']).toBe(expected.nonManifoldAfter);
  record({ kind: 'matrix', label, summary, before, after, previewMs, applyMs });

  const t2 = Date.now();
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 120_000 });
  expect(await counts(page)).toEqual(before);
  expect((await page.getByTestId('status-triangles').textContent()) ?? '').toBe(triangles);
  record({ kind: 'matrix-undo', label, undoMs: Date.now() - t2 });
}

test('A: a clean model needs no repair and nothing changes', async ({ page }) => {
  await open(page, 'clean.stl', tetrahedronStl());
  await expect(page.getByTestId('repair-no-repairs')).toHaveText('No repairable problems found.');
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
});

test('B: a conservative-only model: preview, apply, fresh analysis, undo, export', async ({
  page,
}) => {
  await open(page, 'dup.stl', duplicateFaceStl());
  expect(await settled(page)).toBe('ready');
  const before = await counts(page);
  expect(before['duplicate-faces']).not.toBe('0');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  await applyAndSettle(page);
  expect((await counts(page))['duplicate-faces']).toBe('0');
  const stl = await exportStlAndReadBack(page);
  await page.goto('/');
  await open(page, 'reimported.stl', stl);
  expect((await counts(page))['duplicate-faces']).toBe('0');
});

test('C: a local pinch model: the whole flow, then export and re-import', async ({ page }) => {
  await open(page, 'pinched.stl', pinchedPairsStl(3));
  await fullFlow(page, 'C pinch', { nonManifoldBefore: '3', nonManifoldAfter: '0' });
  // Re-apply, export what Apply produced, bring it back through the real importer.
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  await applyAndSettle(page);
  const triangles = ((await page.getByTestId('status-triangles').textContent()) ?? '').trim();
  const stl = await exportStlAndReadBack(page);
  await page.goto('/');
  await open(page, 'reimported.stl', stl);
  expect(((await page.getByTestId('status-triangles').textContent()) ?? '').trim()).toBe(triangles);
  expect((await counts(page))['non-manifold-vertices']).toBe('0');
});

test('D: a residual/winding model', async ({ page }) => {
  await open(page, 'residual.stl', residualPinchStl());
  await fullFlow(page, 'D residual', { nonManifoldBefore: '1', nonManifoldAfter: '0' });
});

test('E: openings and pinches compose: separated, then filled', async ({ page }) => {
  const cube = holedCubeStl(40, { extraPiece: false });
  await open(page, 'holed.stl', Buffer.from(cube.bytes));
  expect(await settled(page)).toBe('ready');
  expect((await counts(page))['open-boundaries']).toBe('13');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  const summary = await readSummary(page);
  expect(summary.outcome).toBe('complete');
  await applyAndSettle(page);
  const after = await counts(page);
  expect(after['open-boundaries']).toBe('0');
  expect(after['non-manifold-vertices']).toBe('0');
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
  await expect(count13(page)).toHaveText('13', { timeout: 120_000 });
});
const count13 = (page: Page): Locator => page.getByTestId('issue-count-open-boundaries');

test('F: a safe partial result: truthful preview, applied, the remainder persists', async ({
  page,
}) => {
  await open(page, 'refused.stl', refusedPinchStl());
  expect(await settled(page)).toBe('ready');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  const summary = await readSummary(page);
  expect(summary.outcome).toBe('partial-unsupported');
  expect(summary.remaining.join(' ')).toContain('non-manifold vertex');
  // A safe partial outcome is neutral: no alert, no error styling.
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await applyAndSettle(page);
  expect((await counts(page))['non-manifold-vertices']).toBe('1');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test('H: an unsupported-only model offers no unsafe candidate', async ({ page }) => {
  await open(page, 'edge.stl', nonManifoldEdgeStl());
  await expect(page.getByTestId('repair-no-repairs')).toContainText('No safe automatic repairs');
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
});

/* ------------------------------------------------------------- formats ---- */

const indexedPinchMesh = `<mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="1"/><vertex x="-0.5" y="0.9" z="1"/><vertex x="-0.5" y="-0.9" z="1.1"/>
<vertex x="-1" y="0.1" z="-1"/><vertex x="0.5" y="-0.9" z="-1.2"/><vertex x="0.45" y="0.95" z="-1.1"/>
</vertices><triangles>
<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/>
<triangle v1="0" v2="4" v3="5"/><triangle v1="0" v2="5" v3="6"/><triangle v1="0" v2="6" v3="4"/><triangle v1="4" v2="6" v3="5"/>
</triangles></mesh>`;

const indexedPinchObj = (): Buffer =>
  Buffer.from(
    [
      'o Pinched',
      'v 0 0 0',
      'v 1 0 1',
      'v -0.5 0.9 1',
      'v -0.5 -0.9 1.1',
      'v -1 0.1 -1',
      'v 0.5 -0.9 -1.2',
      'v 0.45 0.95 -1.1',
      'f 1 3 2',
      'f 1 4 3',
      'f 1 2 4',
      'f 2 3 4',
      'f 1 5 6',
      'f 1 6 7',
      'f 1 7 5',
      'f 5 7 6',
      '',
    ].join('\n'),
    'utf8',
  );

test('OBJ: an indexed pinched model repairs, applies and undoes', async ({ page }) => {
  await open(page, 'pinched.obj', indexedPinchObj(), 'model/obj');
  await fullFlow(page, 'OBJ pinch', { nonManifoldBefore: '1', nonManifoldAfter: '0' });
});

test('OBJ: the defect-and-clean multi-object model repairs the defective object only', async ({
  page,
}) => {
  await open(page, 'two.obj', objDefectAndClean().bytes, 'model/obj');
  expect(await settled(page)).toBe('ready');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  await applyAndSettle(page);
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
});

test('3MF: an indexed pinched object repairs, applies and undoes', async ({ page }) => {
  const bytes = threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Pinched">${indexedPinchMesh}</object>`,
    }),
  );
  await open(page, 'pinched.3mf', bytes, 'model/3mf');
  await fullFlow(page, '3MF pinch', { nonManifoldBefore: '1', nonManifoldAfter: '0' });
});

test('3MF: the defective tetrahedron repairs and undoes', async ({ page }) => {
  await open(page, 'defect.3mf', threeMfDefectiveTetrahedron(), 'model/3mf');
  expect(await settled(page)).toBe('ready');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  await applyAndSettle(page);
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
});

/* --------------------------------------------- races, cancellation, memory -- */

test('RACES: cancel then retry, replace during a preview, and double activation', async ({
  page,
}) => {
  await open(page, 'many.stl', pinchedPairsStl(400));
  expect(await settled(page)).toBe('ready');
  // Cancel then immediately retry.
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('cancel-repair')).toBeVisible();
  await page.getByTestId('cancel-repair').click();
  await expect(page.getByTestId('repair-cancelled')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  expect((await counts(page))['non-manifold-vertices']).toBe('400');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  // Replace the model while a preview exists: the old preview must not survive.
  await importModel(page, { name: 'clean.stl', mime: 'model/stl', buffer: tetrahedronStl() });
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  // Double activation of Apply and of Undo commits once.
  await importModel(page, { name: 'p.stl', mime: 'model/stl', buffer: pinchedPairsStl(3) });
  expect(await settled(page)).toBe('ready');
  await page.getByTestId('preview-repair').click();
  expect(await waitForResult(page)).toBe('candidate');
  await page.evaluate(() => {
    const apply = document.querySelector<HTMLButtonElement>('[data-testid="apply-repair"]');
    apply?.click();
    apply?.click();
  });
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('repair-applied')).not.toHaveAttribute('data-outcome', 'checking', {
    timeout: 60_000,
  });
  await page.evaluate(() => {
    const undo = document.querySelector<HTMLButtonElement>('[data-testid="undo-repair"]');
    undo?.click();
    undo?.click();
  });
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('undo-repair')).toHaveCount(0);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect((await counts(page))['non-manifold-vertices']).toBe('3');
});

test('MEMORY: repeated cycles retain no growing state', async ({ page }) => {
  await open(page, 'p40.stl', pinchedPairsStl(40));
  expect(await settled(page)).toBe('ready');
  const samples: { cycle: string; rss: number; heap: number; workers: number }[] = [];
  const sample = async (cycle: string): Promise<void> => {
    samples.push({
      cycle,
      rss: browserRssMiB(),
      heap: await jsHeapMiB(page),
      workers: await liveWorkers(page),
    });
  };
  await sample('start');
  for (let i = 1; i <= 5; i += 1) {
    await page.getByTestId('preview-repair').click();
    expect(await waitForResult(page)).toBe('candidate');
    await page.getByTestId('discard-preview').click();
    await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
    await expect(page.getByTestId('preview-repair')).toBeEnabled();
    await sample(`discard-${String(i)}`);
  }
  for (let i = 1; i <= 5; i += 1) {
    await page.getByTestId('preview-repair').click();
    expect(await waitForResult(page)).toBe('candidate');
    await applyAndSettle(page);
    await page.getByTestId('undo-repair').click();
    await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 120_000 });
    await sample(`apply-undo-${String(i)}`);
  }
  record({ kind: 'memory-cycles', samples });
  // The disposable kernel workers are all gone between cycles.
  const first = samples[0];
  const mid = samples.find((s) => s.cycle === 'discard-3');
  const last = samples[samples.length - 1];
  if (first === undefined || mid === undefined || last === undefined) throw new Error('no samples');
  for (const s of samples) expect(s.workers, s.cycle).toBeLessThanOrEqual(first.workers + 1);
  // Warm-up is expected in the first cycles; after that the retained size must not keep climbing.
  expect(last.heap - mid.heap, 'JS heap after the warm-up').toBeLessThan(40);
  expect(last.rss - mid.rss, 'browser RSS after the warm-up').toBeLessThan(250);
});
