import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  combinedRepairStl,
  duplicateFaceStl,
  hiddenBoundaryDuplicateStl,
  analysisHeavyStl,
  repairHeavyStl,
  reversedDuplicateFaceStl,
  safeDegenerateStl,
  safeRepeatedPositionStl,
  tetrahedronStl,
  unsafeDegenerateStl,
  windingBlockedByVertexStl,
  windingConflictStl,
} from './stl-fixtures';
import { objDefectAndClean, threeMfDefectiveTetrahedron } from './format-fixtures';
import { openAdvancedDiagnostics, openPreviewDetails } from './repair-ui';

/**
 * The conservative repair workflow, end to end, through the REAL worker.
 *
 * NOTHING IS STUBBED. No mock plan, no mock validation, no injected candidate. A
 * mocked repair engine would prove that the mock works; what these tests
 * establish is that a file on disk becomes a correct, honestly-labelled proposal
 * on screen, that applying it changes the model exactly as promised, and that
 * every path which must NOT change the model genuinely does not.
 *
 * WHAT IS DELIBERATELY NEVER ASSERTED: that a repaired model is printable, is
 * watertight, or faces outward. The engine makes none of those claims and
 * neither do these tests — asserting them would encode the exact dishonesty this
 * stage exists to avoid.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** Waits for automatic analysis AND the repair plan derived from it. */
async function importAndPlan(page: Page, name: string, bytes: Buffer): Promise<void> {
  await openFile(page, name, bytes);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 30_000 });
}

function operation(page: Page, id: string): { verdict: Locator; reason: Locator; toggle: Locator } {
  return {
    verdict: page.getByTestId(`repair-op-verdict-${id}`),
    reason: page.getByTestId(`repair-op-reason-${id}`),
    toggle: page.getByTestId(`repair-op-toggle-${id}`),
  };
}

/** Builds a candidate and waits for it to be validated. */
async function preview(page: Page): Promise<void> {
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 30_000 });
}

async function apply(page: Page): Promise<void> {
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 30_000 });
}

/** Reads what the viewport actually drew. */
async function readSceneStats(page: Page): Promise<{
  drawCalls: number;
  renderedTriangles: number;
  modelObjects: number;
  previewObjects: number;
  overlayObjects: number;
  changeOverlayObjects: number;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    return {
      drawCalls: Number(canvas?.dataset.drawCalls ?? 0),
      renderedTriangles: Number(canvas?.dataset.renderedTriangles ?? 0),
      modelObjects: Number(canvas?.dataset.modelObjects ?? 0),
      previewObjects: Number(canvas?.dataset.previewObjects ?? 0),
      overlayObjects: Number(canvas?.dataset.overlayObjects ?? 0),
      changeOverlayObjects: Number(canvas?.dataset.changeOverlayObjects ?? 0),
    };
  });
}

/**
 * Installs a `MutationObserver` that clicks a control the instant it appears.
 *
 * Cancellation tests are otherwise a race the test can only lose: the operation
 * may complete between Playwright noticing the button and Playwright clicking
 * it, and the resulting failure looks like a product defect. Arming the click
 * before the operation starts removes the window entirely.
 */
async function armClick(page: Page, testId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const clickWhenPresent = (): boolean => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      if (button === null) return false;
      button.click();
      return true;
    };
    if (clickWhenPresent()) return;
    const observer = new MutationObserver(() => {
      if (clickWhenPresent()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, testId);
}

/* ------------------------------------------------------------------ O1 -- */

test('O1: a same-orientation duplicate is previewed, applied, and its expected side effect is labelled as expected', async ({
  page,
}) => {
  await page.goto('/');
  // One triangle written twice. Chosen deliberately: the two copies pair each
  // other's edges, so the model reports ZERO boundary edges and looks closed.
  // Removing the redundant copy REVEALS three boundary edges — the non-monotonic
  // case the change summary has to describe honestly.
  await importAndPlan(page, 'duplicate.stl', hiddenBoundaryDuplicateStl());

  await expect(page.getByTestId('topo-duplicates')).toHaveText('1');
  await expect(page.getByTestId('topo-boundary-edges')).toHaveText('0');

  const duplicates = operation(page, 'remove-duplicate-faces');
  await expect(duplicates.verdict).toHaveText('Can be repaired conservatively');
  await expect(page.getByTestId('repair-op-mutations-remove-duplicate-faces')).toHaveText('1');

  await preview(page);

  // Validated, and explicitly not applied.
  await expect(page.getByTestId('repair-candidate-headline')).toHaveText(
    'Repair validated — not applied yet',
  );
  await expect(page.getByTestId('repair-candidate-qualifier')).toHaveText(
    'Self-intersections and wall thickness have not yet been checked.',
  );
  await expect(page.getByTestId('change-count-removedDuplicates')).toHaveText('1');
  await expect(page.getByTestId('change-count-flippedFaces')).toHaveText('0');

  // THE ASSERTION THIS FIXTURE EXISTS FOR. Boundary edges go UP, and the
  // interface says the increase was expected rather than calling it damage.
  await expect(page.getByTestId('repair-before-boundaryEdges')).toHaveText('0');
  await expect(page.getByTestId('repair-after-boundaryEdges')).toHaveText('3');
  await expect(page.getByTestId('repair-delta-boundaryEdges')).toHaveText('+3 (expected)');
  await expect(page.getByTestId('repair-note-boundaryEdges')).toContainText(
    'coincident triangles pair each other',
  );
  await expect(page.getByTestId('repair-panel')).not.toContainText('boundary errors');

  // Before / After both work, and the preview is labelled while After is shown.
  await expect(page.getByTestId('preview-mode-after')).toBeChecked();
  await expect(page.getByTestId('preview-banner')).toHaveText('Repair preview — not applied');
  await page.getByTestId('preview-mode-before').check();
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  await page.getByTestId('preview-mode-after').check();
  await expect(page.getByTestId('preview-banner')).toBeVisible();

  await apply(page);

  // The model really changed, and the diagnostics describe the new revision.
  await expect(page.getByTestId('fact-triangles')).toHaveText('1');
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('topo-duplicates')).toHaveText('0');
  await expect(page.getByTestId('topo-boundary-edges')).toHaveText('3');
  // The preview is gone, and so is everything that belonged to it.
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect
    .poll(async () => (await readSceneStats(page)).previewObjects, { timeout: 10_000 })
    .toBe(0);
  await expect
    .poll(async () => (await readSceneStats(page)).changeOverlayObjects, { timeout: 10_000 })
    .toBe(0);

  // Export resolves the NEW revision: a stale handle would fail outright.
  const download = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  await download;
  await expect(page.getByTestId('status-list')).not.toContainText('out-of-date');
});

/* ------------------------------------------------------------------ O2 -- */

test('O2: a reversed duplicate is reported and never offered for removal', async ({ page }) => {
  await page.goto('/');
  await importAndPlan(page, 'reversed.stl', reversedDuplicateFaceStl());

  // Mesh Health sees it, and sees that it is the REVERSED kind.
  await expect(page.getByTestId('topo-duplicates-reversed')).toHaveText('1');
  await expect(page.getByTestId('topo-duplicates')).toHaveText('0');

  // Conservative repair does not offer to remove it.
  const duplicates = operation(page, 'remove-duplicate-faces');
  await expect(duplicates.verdict).toHaveText('No matching issue found');
  await expect(page.getByTestId('repair-op-mutations-remove-duplicate-faces')).toHaveText('0');

  await expect(page.getByTestId('repair-no-repairs')).toBeVisible();
  // No hidden repair: the action keeps its place (REPAIR-UX-01) but cannot be
  // pressed, and there is nothing to apply.
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);

  // And the exclusion is stated, so a user knows this was a decision.
  await expect(page.getByTestId('repair-panel')).toContainText(
    'Reversed duplicates are never removed',
  );

  // The model is untouched.
  await expect(page.getByTestId('fact-triangles')).toHaveText('5');
});

/* ------------------------------------------------------------------ O3 -- */

test('O3: a safely removable degenerate triangle is previewed and applied', async ({ page }) => {
  await page.goto('/');
  await importAndPlan(page, 'zero-area.stl', safeDegenerateStl());

  await expect(page.getByTestId('topo-zero-area')).toHaveText('1');
  await expect(operation(page, 'remove-zero-area-faces').verdict).toHaveText(
    'Can be repaired conservatively',
  );

  await preview(page);
  await expect(page.getByTestId('change-count-removedZeroArea')).toHaveText('1');

  // A component legitimately disappears, because every one of its faces was
  // removed. The interface says so as a warning, not as an error.
  await expect(page.getByTestId('repair-delta-components')).toHaveText('-1 (expected)');

  await apply(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('topo-zero-area')).toHaveText('0');

  // The repeated-position variant is a SEPARATE defect and a separate counter.
  await importAndPlan(page, 'repeated.stl', safeRepeatedPositionStl());
  await expect(page.getByTestId('topo-repeated-position')).toHaveText('1');
  await expect(operation(page, 'remove-repeated-position-faces').verdict).toHaveText(
    'Can be repaired conservatively',
  );
  await preview(page);
  await expect(page.getByTestId('change-count-removedRepeatedPosition')).toHaveText('1');
  await apply(page);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('topo-repeated-position')).toHaveText('0');
});

/* ------------------------------------------------------------------ O4 -- */

test('O4: an unsafe degenerate removal is refused, with a reason, and changes nothing', async ({
  page,
}) => {
  await page.goto('/');
  // A zero-area triangle whose every edge is paired with real surface. Removing
  // it would open the model in three places, so removal is refused.
  await importAndPlan(page, 'unsafe.stl', unsafeDegenerateStl());

  await expect(page.getByTestId('topo-zero-area')).toHaveText('1');
  await expect(page.getByTestId('topo-boundary-edges')).toHaveText('0');

  const zeroArea = operation(page, 'remove-zero-area-faces');
  // A refusal, NOT an error.
  await expect(zeroArea.verdict).toHaveText('Not changed automatically');
  await expect(zeroArea.reason).toContainText('leave the surface open');
  await expect(zeroArea.toggle).toBeDisabled();
  await expect(page.getByTestId('repair-panel')).not.toContainText('failed');

  // No candidate is produced for it at all; the action is present and disabled.
  await expect(page.getByTestId('repair-no-repairs')).toBeVisible();
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);

  // The model is exactly as imported.
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');
  await expect(page.getByTestId('topo-boundary-edges')).toHaveText('0');
});

/* ------------------------------------------------------------------ O5 -- */

test('O5: a winding conflict is unified relative to its neighbours, never outward', async ({
  page,
}) => {
  await page.goto('/');
  await importAndPlan(page, 'winding.stl', windingConflictStl());

  await expect(page.getByTestId('topo-winding')).toHaveText('1');
  await expect(operation(page, 'unify-winding').verdict).toHaveText(
    'Can be repaired conservatively',
  );

  await preview(page);
  await expect(page.getByTestId('change-count-flippedFaces')).toHaveText('1');
  await expect(page.getByTestId('repair-delta-windingConflicts')).toHaveText('-1 (expected)');
  // Signed volume moves because orientation moved. That is recorded as such and
  // never presented as the model gaining or losing material.
  await openPreviewDetails(page);
  await expect(page.getByTestId('repair-volume-status')).toBeVisible();

  await apply(page);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('topo-winding')).toHaveText('0');
  await expect(page.getByTestId('topo-winding-consistent')).toHaveText('Yes');

  /*
   * THE CLAIM THAT MUST NEVER APPEAR. Winding was made consistent RELATIVE to
   * neighbours; nothing here established which side is outside.
   *
   * The word "outward" DOES appear on this panel, in a sentence that disclaims
   * it — "not turned outward" — so a bare substring check would fail for exactly
   * the wrong reason. What is asserted instead is that no sentence CLAIMS
   * outwardness, and that the disclaimer is present.
   */
  const panel = page.getByTestId('repair-panel');
  await expect(panel).not.toContainText('faces outward');
  await expect(panel).not.toContainText('facing outward');
  await expect(panel).not.toContainText('outward-facing');
  await expect(panel).not.toContainText('now correctly oriented');
  await expect(panel).toContainText('never decides which side is outside');
  // The exclusions moved to Advanced diagnostics (REPAIR-UX-01); still stated.
  await expect(page.getByTestId('repair-exclusions')).toContainText('not turned outward');
  await expect(panel).toContainText('RELATIVE');
});

/* ------------------------------------------------------------------ O6 -- */

test('O6: winding unification is blocked by a non-manifold vertex, with an explanation', async ({
  page,
}) => {
  await page.goto('/');
  await importAndPlan(page, 'blocked.stl', windingBlockedByVertexStl());

  await expect(page.getByTestId('topo-winding')).toHaveText('1');
  await expect(page.getByTestId('topo-nonmanifold-vertices')).toHaveText('1');
  await expect(page.getByTestId('topo-nonmanifold-edges')).toHaveText('0');

  const winding = operation(page, 'unify-winding');
  await expect(winding.verdict).toHaveText('Blocked by the model’s topology');
  await expect(winding.reason).toContainText('do not form a single continuous fan');
  await expect(winding.toggle).toBeDisabled();

  // REPAIR-CORE-06B: the winding operation is still blocked (it needs one continuous fan), but
  // the pinched vertex itself is now something Repair can attempt, so Repair is available and
  // nothing has changed until it is applied.
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  await expect(page.getByTestId('repair-no-repairs')).toHaveCount(0);
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');
});

/* ------------------------------------------------------------------ O7 -- */

test('O7: a model with all three defects runs the pipeline in order and validates', async ({
  page,
}) => {
  await page.goto('/');
  await importAndPlan(page, 'combined.stl', combinedRepairStl());

  await expect(page.getByTestId('topo-duplicates')).toHaveText('1');
  await expect(page.getByTestId('topo-zero-area')).toHaveText('1');
  await expect(page.getByTestId('topo-winding')).toHaveText('2');

  for (const id of ['remove-duplicate-faces', 'remove-zero-area-faces', 'unify-winding']) {
    await expect(operation(page, id).verdict).toHaveText('Can be repaired conservatively');
  }

  await preview(page);

  // Deterministic, exact, and attributed to the right operation.
  await expect(page.getByTestId('change-count-removedDuplicates')).toHaveText('1');
  await expect(page.getByTestId('change-count-removedZeroArea')).toHaveText('1');
  await expect(page.getByTestId('change-count-removedRepeatedPosition')).toHaveText('0');
  await expect(page.getByTestId('change-count-flippedFaces')).toHaveText('1');
  await expect(page.getByTestId('repair-before-triangles')).toHaveText('6');
  await expect(page.getByTestId('repair-after-triangles')).toHaveText('4');

  // Change overlays are real GPU objects, and bounded.
  await expect
    .poll(async () => (await readSceneStats(page)).changeOverlayObjects, { timeout: 10_000 })
    .toBeGreaterThan(0);

  await apply(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('topo-duplicates')).toHaveText('0');
  await expect(page.getByTestId('topo-zero-area')).toHaveText('0');
  await expect(page.getByTestId('topo-winding')).toHaveText('0');
});

/* ------------------------------------------------------------------ O8 -- */

test('O8: discarding a preview leaves the model authoritative and exportable', async ({ page }) => {
  await page.goto('/');
  await importAndPlan(page, 'combined.stl', combinedRepairStl());
  await preview(page);

  // Switch views, to prove the discard works from either one.
  await page.getByTestId('preview-mode-before').check();
  await page.getByTestId('preview-mode-after').check();
  await expect(page.getByTestId('preview-banner')).toBeVisible();
  await expect
    .poll(async () => (await readSceneStats(page)).previewObjects, { timeout: 10_000 })
    .toBe(1);

  await page.getByTestId('discard-preview').click();

  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  // The preview's GPU resources went with it.
  await expect
    .poll(async () => (await readSceneStats(page)).previewObjects, { timeout: 10_000 })
    .toBe(0);
  await expect
    .poll(async () => (await readSceneStats(page)).changeOverlayObjects, { timeout: 10_000 })
    .toBe(0);
  const stats = await readSceneStats(page);
  expect(stats.modelObjects).toBe(1);

  // M0 is still the model: unchanged, analysed, exportable, and repairable again.
  await expect(page.getByTestId('fact-triangles')).toHaveText('6');
  await expect(page.getByTestId('preview-repair')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  await download;
});

/* ------------------------------------------------------------------ O9 -- */

test('O9: cancelling preparation leaves no candidate and no preview', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');

  const heavy = repairHeavyStl(120);
  await openFile(page, 'heavy.stl', heavy.bytes);
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 120_000 });

  // ARMED BEFORE THE CLICK that starts the work, so the cancel lands in the same
  // microtask the control appears rather than on Playwright's polling interval.
  // Waiting for the button and then clicking it is a race the test loses on a
  // fast machine, and the failure looks like a product bug rather than a test one.
  await armClick(page, 'cancel-repair');
  await page.getByTestId('preview-repair').click();

  await expect(page.getByTestId('repair-cancelled')).toBeVisible({ timeout: 120_000 });

  // Nothing was produced and nothing is committable.
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  await expect
    .poll(async () => (await readSceneStats(page)).previewObjects, { timeout: 10_000 })
    .toBe(0);

  // The model is untouched, and the repair can be attempted again.
  await expect(page.getByTestId('fact-triangles')).toHaveText(heavy.triangles.toLocaleString());
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
});

/* ----------------------------------------------------------------- O10 -- */

test('O10: importing another model invalidates the candidate it did not belong to', async ({
  page,
}) => {
  await page.goto('/');
  await importAndPlan(page, 'first.stl', combinedRepairStl());
  await preview(page);
  await expect(page.getByTestId('preview-banner')).toBeVisible();

  // M1 arrives while M0's candidate is live.
  await openFile(page, 'second.stl', tetrahedronStl());
  await expect(page.getByTestId('fact-triangles')).toHaveText('4', { timeout: 30_000 });
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });

  // M0's candidate is gone: no preview, no overlays, nothing to apply.
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect
    .poll(async () => (await readSceneStats(page)).previewObjects, { timeout: 10_000 })
    .toBe(0);
  await expect
    .poll(async () => (await readSceneStats(page)).changeOverlayObjects, { timeout: 10_000 })
    .toBe(0);
  const stats = await readSceneStats(page);
  expect(stats.modelObjects).toBe(1);

  // M1 has its own plan, from its own analysis. The tetrahedron is clean.
  await expect(page.getByTestId('health-filename')).toHaveText('second.stl');
  await expect(page.getByTestId('repair-no-repairs')).toBeVisible();
});

/* ----------------------------------------------------------------- O11 -- */

test('O11: losing the worker clears the model, the preview, and every overlay', async ({
  page,
}) => {
  await page.goto('/');
  await importAndPlan(page, 'combined.stl', combinedRepairStl());
  await preview(page);
  await expect(page.getByTestId('preview-banner')).toBeVisible();

  // A GENUINE crash, not a simulated one. The error is thrown inside the real
  // worker; an uncaught worker error fires the `error` event on the parent's
  // Worker object, which is exactly the path the client listens on. No test hook
  // exists in production code for this.
  const workers = page.workers();
  expect(workers.length).toBeGreaterThan(0);
  const geometryWorker = workers[0];
  expect(geometryWorker).toBeDefined();
  if (geometryWorker === undefined) return;
  await geometryWorker.evaluate(() => {
    setTimeout(() => {
      throw new Error('simulated geometry worker crash');
    }, 0);
  });

  // Policy A: the model goes, and so does everything that named it.
  await expect(page.getByTestId('model-empty')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('repair-overview')).toHaveCount(0);
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('repair-candidate')).toHaveCount(0);
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  await expect
    .poll(async () => (await readSceneStats(page)).previewObjects, { timeout: 10_000 })
    .toBe(0);
  await expect
    .poll(async () => (await readSceneStats(page)).changeOverlayObjects, { timeout: 10_000 })
    .toBe(0);
  await expect(page.getByTestId('status-list')).toContainText('worker');

  // Re-import recovers the session.
  await importAndPlan(page, 'again.stl', combinedRepairStl());
  await expect(page.getByTestId('preview-repair')).toBeVisible();
});

/* ----------------------------------------------------------------- O12 -- */

test('O12: a repair above the memory ceiling is refused before anything is allocated', async ({
  page,
}) => {
  // The ceiling is narrowed through the documented URL option. It can only ever
  // LOWER the product limit — the worker enforces that independently — so this
  // exercises the real refusal path without pushing a browser tab anywhere near
  // an out-of-memory condition.
  await page.goto('/?repairMemoryCeilingMiB=1');

  const model = analysisHeavyStl(60);
  await openFile(page, 'big.stl', model.bytes);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

  // The narrowed ceiling is visible, not hidden state.
  await expect(page.getByTestId('repair-memory-note')).toContainText('can only lower the limit');

  // A resource refusal, worded as a limit rather than as a fault.
  const refusal = page.getByTestId('repair-plan-error');
  await expect(refusal).toBeVisible({ timeout: 30_000 });
  await expect(refusal).toContainText('safety limit');
  await expect(refusal).toContainText('still loaded');
  await expect(refusal).not.toContainText('reload');

  // No candidate, nothing to apply: the action is present and disabled.
  await expect(page.getByTestId('preview-repair')).toBeDisabled();
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);

  // The model remains fully usable: visible, analysed, and exportable.
  await expect(page.getByTestId('fact-triangles')).toHaveText(model.triangles.toLocaleString());
  await openAdvancedDiagnostics(page);
  await expect(page.getByTestId('topo-boundary-edges')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  await download;
});

/* ----------------------------------------------------------------- O13 -- */

test('O13: a double Apply commits exactly one revision', async ({ page }) => {
  await page.goto('/');
  await importAndPlan(page, 'combined.stl', combinedRepairStl());
  await preview(page);

  // Both clicks in ONE task, so nothing can re-render between them. This is the
  // hostile case: two synchronous dispatches from the same button.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="apply-repair"]');
    button?.click();
    button?.click();
  });

  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');

  // Exactly one commit happened: one success message, and no failure beside it.
  const successes = await page
    .getByTestId('status-list')
    .locator('li', { hasText: 'Repair applied' })
    .count();
  expect(successes).toBe(1);
  await expect(page.getByTestId('status-list')).not.toContainText('already been applied');
  await expect(page.getByTestId('status-list')).not.toContainText('was not applied');
});

/* ----------------------------------------------------------------- O14 -- */

test('O14: repairing again after a repair finds nothing left to do', async ({ page }) => {
  await page.goto('/');
  await importAndPlan(page, 'duplicate.stl', duplicateFaceStl());

  await expect(page.getByTestId('topo-duplicates')).toHaveText('1');
  await preview(page);
  await apply(page);

  // The plan is recomputed against the repaired revision, automatically.
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('repair-no-repairs')).toBeVisible({ timeout: 30_000 });
  // The duplicate was the only issue, so nothing is left to repair.
  await expect(page.getByTestId('repair-no-repairs')).toHaveText('No repairable problems found.');
  await expect(page.getByTestId('preview-repair')).toBeDisabled();

  // Every operation reports nothing to do, rather than disappearing.
  for (const id of [
    'remove-duplicate-faces',
    'remove-repeated-position-faces',
    'remove-zero-area-faces',
    'unify-winding',
  ]) {
    await expect(operation(page, id).verdict).toHaveText('No matching issue found');
  }
});

/* ----------------------------------------------------------------- O15 -- */

test('O15: undo restores the pre-repair geometry as a new revision', async ({ page }) => {
  await page.goto('/');
  await importAndPlan(page, 'combined.stl', combinedRepairStl());

  // M0's exact state, recorded so the restoration can be compared against it.
  await expect(page.getByTestId('fact-triangles')).toHaveText('6');
  await expect(page.getByTestId('topo-duplicates')).toHaveText('1');
  await expect(page.getByTestId('topo-zero-area')).toHaveText('1');
  await expect(page.getByTestId('topo-winding')).toHaveText('2');
  await expect(page.getByTestId('topo-components')).toHaveText('2');
  const boundsBefore = await page.getByTestId('fact-size').textContent();

  await preview(page);
  await apply(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });

  // M1 is exportable in its own right before the undo.
  const repaired = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  await repaired;

  await page.getByTestId('undo-repair').click();

  // M2 reproduces M0's geometry exactly: same triangles, same topology, same
  // bounding box. Not a hidden copy swapped back in React — the worker rebuilt
  // it from the inverse patch and revalidated it.
  await expect(page.getByTestId('fact-triangles')).toHaveText('6', { timeout: 30_000 });
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('topo-duplicates')).toHaveText('1');
  await expect(page.getByTestId('topo-zero-area')).toHaveText('1');
  await expect(page.getByTestId('topo-winding')).toHaveText('2');
  await expect(page.getByTestId('topo-components')).toHaveText('2');
  await expect(page.getByTestId('fact-size')).toHaveText(boundsBefore ?? '');

  // The undone repair is no longer offered for undo, and M1's handle is stale:
  // nothing on screen still refers to it.
  await expect(page.getByTestId('repair-applied')).toHaveCount(0);
  await expect(page.getByTestId('undo-repair')).toHaveCount(0);

  // Export resolves the restored revision.
  const restored = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  await restored;
  await expect(page.getByTestId('status-list')).not.toContainText('out-of-date');

  // And the same repair is offered again, because the defects are back.
  await expect(page.getByTestId('preview-repair')).toBeVisible({ timeout: 30_000 });
  await expect(operation(page, 'remove-duplicate-faces').verdict).toHaveText(
    'Can be repaired conservatively',
  );
});

/* ----------------------------------------------------------------- O16 -- */

test('O16: nothing leaves the browser during planning, preview, apply, undo, or export', async ({
  page,
}) => {
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on('request', (request) => {
    requests.push({ url: request.url(), method: request.method(), body: request.postData() });
  });

  await page.goto('/');
  await importAndPlan(page, 'private-part.stl', combinedRepairStl());
  await preview(page);
  await page.getByTestId('preview-mode-before').check();
  await page.getByTestId('preview-mode-after').check();
  await openPreviewDetails(page);
  await page.getByTestId('change-overlay-toggle-flippedFaces').uncheck();
  await page.getByTestId('change-overlay-toggle-flippedFaces').check();
  await apply(page);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText('6', { timeout: 30_000 });

  const download = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  await download;

  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    expect(request.url.startsWith(origin), `unexpected origin: ${request.url}`).toBe(true);
    // No request may carry a body at all: nothing here should ever POST.
    expect(request.body, `unexpected request body on ${request.url}`).toBeNull();
    expect(['GET', 'HEAD'], `unexpected method on ${request.url}`).toContain(request.method);
    // And no model identity may leak through a query string.
    expect(request.url).not.toContain('private-part');
  }
});

/* ----------------------------------------------------------------- O17 -- */

test('O17: the repair workflow is operable from the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await importAndPlan(page, 'combined.stl', combinedRepairStl());

  // Named sections, so the workflow is findable (REPAIR-UX-01).
  await expect(page.getByRole('region', { name: 'Detected issues' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Repair options' })).toBeVisible();

  // The navigation item is a real control that moves attention to the workspace.
  await page.getByTestId('workflow-repair').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('repair-heading')).toBeFocused();

  // Operations are native checkboxes with accessible names and an associated
  // reason, operable by keyboard rather than by click only.
  const toggle = page.getByTestId('repair-op-toggle-remove-duplicate-faces');
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Remove duplicate triangles/ })).toHaveCount(1);

  // Preview, the view switch, the overlays, Apply and Undo are all reachable and
  // operable without a pointer.
  const previewButton = page.getByTestId('preview-repair');
  await previewButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 30_000 });

  const before = page.getByTestId('preview-mode-before');
  await before.focus();
  await page.keyboard.press('Space');
  await expect(before).toBeChecked();

  const details = page.getByTestId('repair-preview-details-toggle');
  await details.focus();
  await page.keyboard.press('Enter');
  const overlay = page.getByTestId('change-overlay-toggle-removedDuplicates');
  await overlay.focus();
  await page.keyboard.press('Space');
  await expect(overlay).not.toBeChecked();

  const applyButton = page.getByTestId('apply-repair');
  await applyButton.focus();
  await expect(applyButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 30_000 });

  const undoButton = page.getByTestId('undo-repair');
  await undoButton.focus();
  await expect(undoButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('fact-triangles')).toHaveText('6', { timeout: 30_000 });
});

/* ----------------------------------------------------------------- O18 -- */

test('O18: the repair workflow stays usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/');
  await importAndPlan(page, 'combined.stl', combinedRepairStl());

  // The viewport is still drawn and still the working area.
  await expect(page.getByTestId('viewport-canvas')).toBeVisible();
  const stats = await readSceneStats(page);
  expect(stats.drawCalls).toBeGreaterThan(0);

  // Every critical control is reachable — by scrolling its own column, not by
  // widening the window — and none of them is obscured.
  const previewButton = page.getByTestId('preview-repair');
  await previewButton.scrollIntoViewIfNeeded();
  await expect(previewButton).toBeVisible();
  await previewButton.click();
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 30_000 });

  for (const id of [
    'preview-mode-before',
    'preview-mode-after',
    'apply-repair',
    'discard-preview',
  ]) {
    const control = page.getByTestId(id);
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
  }

  // The preview label is legible at this width too.
  await page.getByTestId('preview-mode-after').check();
  await expect(page.getByTestId('preview-banner')).toBeVisible();

  const applyButton = page.getByTestId('apply-repair');
  await applyButton.scrollIntoViewIfNeeded();
  await applyButton.click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 30_000 });
});

/* ------------------------------ Stage 4B-1C: exact undo, in the product -- */

/**
 * CRU03, CRT/§36: EXACT UNDO AND THE FILES THAT PROVE IT.
 *
 * The contract suite asserts the resident document holds the original mesh
 * OBJECT again after an undo. This is the same claim from where a user stands:
 * an INDEXED OBJ goes in, a repair is previewed, applied and undone, and the
 * file exported afterwards is the file that would have been exported before.
 *
 * Repair's undo used to rebuild the pre-repair mesh from a patch of removed
 * triangles, writing nine coordinates per face and an identity index buffer.
 * For an STL — soup already — that round-tripped exactly, which is why the
 * defect survived every STL test in this file. For an OBJ it did not: four
 * shared corners came back as twelve, and every export afterwards carried the
 * flattening.
 *
 * WHY BYTES AND NOT COUNTS. A triangle count cannot distinguish a restored mesh
 * from a re-derived one that happens to describe the same surface. Two files
 * that differ are two files a user would see differ.
 */
test('CRU03: an indexed OBJ survives repair and undo, and exports as it imported', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await openFile(page, 'indexed.obj', objDefectAndClean().bytes);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 60_000 });

  /*
   * GENUINELY INDEXED, and that is the whole point of this fixture: four corners
   * shared across five faces. Soup describing the same faces needs fifteen, so
   * this number is what the defect destroyed and what the assertion after the
   * undo is really about.
   */
  expect(await readFact(page, 'health-corners')).toBe(4);
  expect(await readFact(page, 'health-triangles')).toBe(5);

  const beforeObj = await exportAs(page, 'obj');
  const beforeStl = await exportAs(page, 'stl');

  // BEFORE APPLY, A PREVIEW IS NOT AN APPLICATION — including on the way out to
  // a file. Exporting with a candidate on screen must write the old geometry.
  await preview(page);
  expect((await exportAs(page, 'obj')).equals(beforeObj)).toBe(true);
  await expect(page.getByTestId('repair-candidate')).toBeVisible();

  await apply(page);
  // The repair really did something: the duplicate face is gone.
  await expect.poll(async () => readFact(page, 'health-triangles'), { timeout: 60_000 }).toBe(4);

  /*
   * CRP02, §61: THE REPAIRED MODEL IS STILL INDEXED — Stage 4B-1D.
   *
   * Four corners for four faces. Before Stage 4B-1D this read TWELVE: the
   * candidate was rebuilt as triangle soup, so removing one duplicate face
   * tripled the vertex count of a model the user had not otherwise changed, and
   * every export afterwards carried the flattening.
   */
  expect(await readFact(page, 'health-corners')).toBe(4);
  expect(await readFact(page, 'health-corners')).not.toBe(
    (await readFact(page, 'health-triangles')) * 3,
  );

  const appliedObj = await exportAs(page, 'obj');
  expect(appliedObj.equals(beforeObj)).toBe(false);
  /*
   * §38: AND THE EXPORTED FILE IS NOT BLOATED EITHER. An OBJ writes one `v` line
   * per canonical vertex, so a de-indexed candidate is visible in the file as
   * well as in the panel — this is the same claim measured where a user would
   * actually feel it.
   */
  // EIGHT `v` LINES FOR TWO TETRAHEDRA, four each — the conversion dialog writes
  // the whole document, and the clean sibling contributes four of its own. Under
  // the soup rebuild the repaired part alone wrote twelve, for sixteen in total.
  expect(countLines(appliedObj, 'v ')).toBe(8);
  expect(countLines(appliedObj, 'f ')).toBe(8);

  await page.getByTestId('undo-repair').click();
  await expect.poll(async () => readFact(page, 'health-triangles'), { timeout: 60_000 }).toBe(5);

  /*
   * STILL INDEXED. Four corners, not twelve — the assertion the patch
   * reconstruction failed, and the one a triangle count cannot make.
   */
  expect(await readFact(page, 'health-corners')).toBe(4);

  expect(countLines(await exportAs(page, 'obj'), 'v ')).toBe(8);

  // AND THE FILES ARE THE SAME FILES. Not "the same shape": the same bytes,
  // which is what a user would diff. Both writers, because OBJ is the one that
  // carries the indexing and STL is the one that never could.
  expect((await exportAs(page, 'obj')).equals(beforeObj)).toBe(true);
  expect((await exportAs(page, 'stl')).equals(beforeStl)).toBe(true);
});

/** Reads a whole number out of a Mesh Health fact row. */
async function readFact(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).textContent()) ?? '';
  return Number(text.replace(/[^0-9]/g, ''));
}

/**
 * Saves the WHOLE document through the Convert workspace and returns the file,
 * then goes back to Repair so the next step acts on the panels it expects.
 */
async function exportAs(page: Page, target: 'stl' | 'obj' | '3mf'): Promise<Buffer> {
  await page.getByTestId('open-convert').click();
  await expect(page.getByTestId('convert-workspace')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`convert-target-${target}`).check();
  await expect(page.getByTestId('convert-report')).toBeVisible();

  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId('convert-export').click();
  const download = await pending;
  await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 60_000 });

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  await page.getByTestId('workflow-repair').click();
  return Buffer.concat(chunks);
}

/**
 * CRU04, §17: THE SAME GATE FOR 3MF, WHICH IS WHERE INDEXING IS NATIVE.
 *
 * A 3MF `<mesh>` is vertices plus triangles referencing them, so an import is
 * indexed by construction and a de-indexing undo is a change to the FILE FORMAT'S
 * own structure, not merely to our buffers. Four vertices and five triangles go
 * in; four vertices must come back.
 *
 * Millimetres, because the 3MF writer refuses a document that states no unit and
 * CAD Fixer will not invent one — so this is also the only one of the three
 * targets whose export can be compared at all here.
 */
test('CRU04: an indexed 3MF survives repair and undo, and exports as it imported', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await openFile(page, 'indexed.3mf', threeMfDefectiveTetrahedron());
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 60_000 });

  expect(await readFact(page, 'health-corners')).toBe(4);
  expect(await readFact(page, 'health-triangles')).toBe(5);

  const before = await exportAs(page, '3mf');

  await preview(page);
  await apply(page);
  await expect.poll(async () => readFact(page, 'health-triangles'), { timeout: 60_000 }).toBe(4);
  /*
   * CRP03, §62: STILL INDEXED AFTER APPLY, through the format where indexing is
   * native. A 3MF `<mesh>` is vertices plus triangles referencing them, so a
   * de-indexed candidate is a change to the file format's own structure.
   */
  expect(await readFact(page, 'health-corners')).toBe(4);

  await page.getByTestId('undo-repair').click();
  await expect.poll(async () => readFact(page, 'health-triangles'), { timeout: 60_000 }).toBe(5);

  // FOUR VERTICES, not twelve. The §17 gate.
  expect(await readFact(page, 'health-corners')).toBe(4);
  // And the archive is the archive: same bytes, so same `<vertices>` block.
  expect((await exportAs(page, '3mf')).equals(before)).toBe(true);
});

/** Counts the lines of an exported text artifact that start with `prefix`. */
function countLines(bytes: Buffer, prefix: string): number {
  let count = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.startsWith(prefix)) count += 1;
  }
  return count;
}

/**
 * CRP18, §63: HARD EDGES SURVIVE THE REPAIR — the rendering half of Stage 4B-1D.
 *
 * Giving repair candidates the source's shared corners raises a question that
 * has nothing to do with geometry: a shared vertex belongs to several faces, and
 * a renderer that averages their normals rounds off exactly the edges a
 * mechanical part is defined by. A cube would come out looking like a pebble,
 * purely because CAD Fixer had started storing it properly.
 *
 * The answer is that the render snapshot is EXPANDED at the render boundary and
 * the canonical mesh is not: three corners per face, each carrying its own
 * face's normal. So this test asserts what the GPU was actually asked to draw —
 * a count no shading choice can fake — before and after a repair.
 *
 * IT ALSO COVERS A DEFECT OLDER THAN THIS STAGE. The snapshot used to be the
 * vertex TABLE with no index buffer, drawn non-indexed, so every indexed OBJ and
 * 3MF ever imported was drawn as a few stray triangles out of the vertex pool.
 * No test had ever compared the drawn triangle count with the model's.
 */
test('CRP18: an indexed model draws every triangle, before and after a repair', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  /*
   * ONE PART, DELIBERATELY. `renderer.info.render.triangles` counts what
   * survived FRUSTUM CULLING, and applying a repair reframes the camera — so on
   * a multi-part document a distant sibling can legitimately drop out of the
   * count and a total would be measuring the camera rather than the geometry.
   * With one part every drawn triangle belongs to the model under repair.
   */
  await openFile(page, 'indexed.3mf', threeMfDefectiveTetrahedron());
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 60_000 });

  /*
   * FIVE TRIANGLES DRAWN FOR A FIVE-TRIANGLE MODEL. The mesh has four vertices,
   * so drawing the vertex table non-indexed — what the snapshot used to hand the
   * GPU — would have produced ONE.
   */
  await expect
    .poll(async () => (await readSceneStats(page)).renderedTriangles, { timeout: 60_000 })
    .toBe(5);

  await preview(page);
  await apply(page);
  await expect.poll(async () => readFact(page, 'health-triangles'), { timeout: 60_000 }).toBe(4);

  // ONE FEWER FACE, AND EVERY REMAINING ONE STILL DRAWN — from a candidate that
  // is now indexed, which is the combination Stage 4B-1D had to make work.
  await expect
    .poll(async () => (await readSceneStats(page)).renderedTriangles, { timeout: 60_000 })
    .toBe(4);
  expect(await readFact(page, 'health-corners')).toBe(4);

  await page.getByTestId('undo-repair').click();
  await expect.poll(async () => readFact(page, 'health-triangles'), { timeout: 60_000 }).toBe(5);
  await expect
    .poll(async () => (await readSceneStats(page)).renderedTriangles, { timeout: 60_000 })
    .toBe(5);
});
