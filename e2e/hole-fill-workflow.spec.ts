import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  boundaryOfSizeStl,
  boxWithFlatAndNonPlanarOpeningsStl,
  boxWithOneOpeningStl,
  boxWithOnlyNonPlanarOpeningStl,
  boxWithTwoOpeningsStl,
  looseTrianglesStl,
  piercedShellStl,
  thinWallStl,
} from './hole-fill-fixtures';
import { tetrahedronStl, windingConflictStl } from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * HFUX01–HFUX32: THE OPEN-BOUNDARY WORKFLOW, END TO END, THROUGH THE REAL
 * WORKERS.
 *
 * NOTHING IS STUBBED. No mock candidate, no injected patch, no faked validation.
 * A real STL goes through the real importer, the real topology pass, the real
 * disposable fill worker and the real Geogram kernel, and what is asserted is
 * what a person would see and press.
 *
 * THE TWO CASES THE WHOLE STAGE TURNS ON:
 *
 *   - HFUX08 (HP23): a file whose patch would pierce an internal wall must
 *     produce NO preview and NO Apply, no matter what the interface does. If it
 *     ever does, the workflow has found a way around the hard gate;
 *   - HFUX09 (HP24): the same geometry with the wall a thousandth of a unit
 *     lower must SUCCEED. Without it, HP23 could be "passing" because the
 *     interface refuses everything.
 *
 * WHAT IS DELIBERATELY NEVER ASSERTED: that a filled model is watertight,
 * printable or free of other openings. Filling one opening establishes none of
 * those, and a test that asserted them would encode exactly the dishonesty this
 * product forbids.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** Imports a file and waits until the open-boundary inventory has been built. */
async function importAndList(page: Page, name: string, bytes: Buffer): Promise<void> {
  await openFile(page, name, bytes);
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('hole-fill-count')).toBeVisible({ timeout: 60_000 });
}

function opening(page: Page, index: number): Locator {
  return page.getByTestId(`opening-${String(index)}`);
}

async function selectOpening(page: Page, index: number): Promise<void> {
  await opening(page, index).getByRole('radio').check();
}

/** Builds a candidate and waits for the terminal state, whichever it is. */
async function requestPreview(page: Page): Promise<void> {
  await page.getByTestId('preview-fill').click();
  await expect(async () => {
    const ready = await page.getByTestId('hole-fill-candidate').isVisible();
    const refused = await page.getByTestId('hole-fill-refusal').isVisible();
    expect(ready || refused).toBe(true);
  }).toPass({ timeout: 120_000 });
}

async function applyFill(page: Page): Promise<void> {
  await page.getByTestId('apply-fill').click();
  await expect(page.getByTestId('hole-fill-applied')).toBeVisible({ timeout: 60_000 });
}

/** The active part's triangle count, as the Mesh Health panel reports it. */
async function triangles(page: Page): Promise<number> {
  const text = (await page.getByTestId('health-triangles').textContent()) ?? '0';
  return Number(text.replace(/[^0-9]/g, ''));
}

/** The number of open boundaries the panel currently reports. */
async function openingCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('hole-fill-count').textContent()) ?? '';
  if (text.includes('No open boundaries')) return 0;
  const match = /([0-9,]+) open bound/.exec(text);
  return Number((match?.[1] ?? '0').replace(/,/g, ''));
}

/**
 * Downloads the whole document in `target` and returns the bytes.
 *
 * Through the SAME Convert workspace a user drives, so what is measured is what
 * they would get. It goes back to Repair afterwards so the next step of a test
 * acts on the openings panel it expects.
 */
async function convert(page: Page, target: 'stl' | 'obj' | '3mf'): Promise<Buffer> {
  await openInspector(page);
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

/** Triangle count of a binary STL, read from its own header. */
function stlTriangleCount(bytes: Buffer): number {
  return bytes.readUInt32LE(80);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('browse-button')).toBeVisible({ timeout: 30_000 });
});

/* ------------------------------------------------- the primary workflow -- */

test('HFUX01: import, select, preview, apply, undo — the whole workflow', async ({ page }) => {
  /*
   * THE PRIMARY ACCEPTANCE TEST (§87). Every step is a thing a person does, and
   * every assertion between them is a thing they would see.
   */
  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());

  // 3. one opening, and it is fillable.
  expect(await openingCount(page)).toBe(1);
  await expect(opening(page, 1)).toHaveAttribute('data-fillable', 'true');
  const trianglesBefore = await triangles(page);
  expect(trianglesBefore).toBe(10);

  // 4-5. choose it; the rim highlights.
  await selectOpening(page, 1);
  await expect(page.getByTestId('hole-fill-selection')).toBeVisible();

  // 6-9. preview it.
  await requestPreview(page);
  await expect(page.getByTestId('hole-fill-preview-headline')).toHaveText('Fill preview ready');
  await expect(page.getByTestId('patch-preview-banner')).toBeVisible();

  // 10. THE DOCUMENT IS UNCHANGED. A preview is not an application.
  expect(await triangles(page)).toBe(trianglesBefore);
  await expect(page.getByTestId('hole-fill-preview-not-applied')).toContainText(
    'Nothing has changed yet',
  );

  // 11-13. apply.
  await applyFill(page);
  expect(await triangles(page)).toBe(trianglesBefore + 2);

  // 14. the preview is gone; the patch is ordinary geometry now.
  await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
  await expect(page.getByTestId('patch-preview-banner')).toHaveCount(0);

  // 15. THE INVENTORY IS RE-DERIVED FROM THE NEW REVISION, not decremented by
  // hand. The box is closed, so the count is genuinely zero.
  await expect.poll(async () => openingCount(page), { timeout: 60_000 }).toBe(0);

  // 16-18. undo restores exactly what was there.
  await page.getByTestId('undo-fill').click();
  await expect.poll(async () => triangles(page), { timeout: 60_000 }).toBe(trianglesBefore);
  await expect.poll(async () => openingCount(page), { timeout: 60_000 }).toBe(1);
  await expect(page.getByTestId('undo-fill')).toHaveCount(0);
});

test('HFUX02: filling one opening leaves the other exactly where it was', async ({ page }) => {
  await importAndList(page, 'two-openings.stl', boxWithTwoOpeningsStl());
  expect(await openingCount(page)).toBe(2);
  const before = await triangles(page);

  await selectOpening(page, 1);
  await requestPreview(page);
  await applyFill(page);

  // ONE OPENING CLOSED, NOT BOTH. There is no batch fill and nothing was closed
  // that the user did not choose.
  await expect.poll(async () => openingCount(page), { timeout: 60_000 }).toBe(1);
  expect(await triangles(page)).toBe(before + 2);

  // And the second is still fillable, as a NEW operation.
  await expect(opening(page, 1)).toHaveAttribute('data-fillable', 'true');
  await selectOpening(page, 1);
  await requestPreview(page);
  await applyFill(page);
  await expect.poll(async () => openingCount(page), { timeout: 60_000 }).toBe(0);
  expect(await triangles(page)).toBe(before + 4);
});

/* ---------------------------------------------------------- refusals ---- */

test('HFUX03: a flat and a non-flat opening are both listed; only the flat one fills', async ({
  page,
}) => {
  /*
   * §7, AND THE DISTINCTION IT INSISTS ON. Both rims here are perfect simple
   * cycles, so BOTH are listed as attemptable — the listing answers a
   * topological question and planarity is not one. The non-flat one is refused
   * when the engine looks at it, as a DECISION with a reason, and the model is
   * untouched either way.
   */
  await importAndList(page, 'mixed.stl', boxWithFlatAndNonPlanarOpeningsStl());
  expect(await openingCount(page)).toBe(2);
  const before = await triangles(page);

  // The interface promises only an attempt, never a result.
  await expect(opening(page, 1).getByRole('radio')).toBeEnabled();
  await selectOpening(page, 1);
  await expect(page.getByTestId('hole-fill-selected-eligible')).toContainText('flat enough');

  /*
   * PREVIEW BOTH BEFORE APPLYING EITHER, deliberately. Applying re-lists the
   * inventory and renumbers what is left, so a loop that applied as it went
   * would be selecting "Opening 2" from a list that no longer has one — and the
   * point of this case is what the two openings do, not what the numbering does
   * afterwards.
   */
  let flat: number | undefined;
  let notFlat: number | undefined;
  for (const index of [1, 2]) {
    await selectOpening(page, index);
    await requestPreview(page);
    if (await page.getByTestId('hole-fill-candidate').isVisible()) {
      flat = index;
      await page.getByTestId('discard-fill').click();
      await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
    } else {
      notFlat = index;
      await expect(page.getByTestId('hole-fill-refusal')).toContainText('not flat enough');
      // A REFUSAL CHANGES NOTHING.
      await expect(page.getByTestId('hole-fill-refusal-qualifier')).toContainText(
        'Your model was not changed',
      );
    }
    // Nothing was applied by either attempt.
    expect(await triangles(page)).toBe(before);
  }
  expect(flat).toBeDefined();
  expect(notFlat).toBeDefined();

  // Now fill the flat one for real.
  await selectOpening(page, flat ?? 1);
  await requestPreview(page);
  await applyFill(page);

  // §44. The unsupported opening remains, and nothing claims the model is done.
  expect(await triangles(page)).toBe(before + 2);
  await expect.poll(async () => openingCount(page), { timeout: 60_000 }).toBe(1);
});

test('HFUX04: a model whose only opening is not flat is refused as a decision', async ({
  page,
}) => {
  await importAndList(page, 'non-planar.stl', boxWithOnlyNonPlanarOpeningStl());

  expect(await openingCount(page)).toBe(1);
  const before = await triangles(page);
  await selectOpening(page, 1);
  await requestPreview(page);

  // NO PREVIEW, NO APPLY, AND A REASON THAT SAYS WHAT CAD FIXER DECIDED.
  await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
  await expect(page.getByTestId('apply-fill')).toHaveCount(0);
  await expect(page.getByTestId('hole-fill-refusal')).toContainText('not flat enough');
  expect(await triangles(page)).toBe(before);

  // AND NOTHING SUGGESTS THE MODEL IS BROKEN. A rim that curves out of a plane
  // is an ordinary thing to model.
  const panel = (await page.getByTestId('open-boundaries').textContent()) ?? '';
  for (const banned of ['damaged', 'broken surface', 'defect', 'invalid']) {
    expect(panel.toLowerCase(), `the panel said "${banned}"`).not.toContain(banned);
  }
});

test('HFUX05, HFUX06: 512 rim points fill and 513 are refused before anything runs', async ({
  page,
}) => {
  await importAndList(page, 'rim-512.stl', boundaryOfSizeStl(512));
  await expect(opening(page, 1)).toHaveAttribute('data-fillable', 'true');
  await selectOpening(page, 1);
  await requestPreview(page);
  await expect(page.getByTestId('hole-fill-candidate')).toBeVisible();

  await importAndList(page, 'rim-513.stl', boundaryOfSizeStl(513));
  await expect(opening(page, 1)).toHaveAttribute('data-fillable', 'false');
  await selectOpening(page, 1);
  /*
   * §48. THE REFUSAL IS STATED WITHOUT SPINNING A WORKER. The vertex count is
   * already known from the listing, so there is nothing to compute — and no
   * Preview control appears to compute it with.
   */
  await expect(page.getByTestId('preview-fill')).toHaveCount(0);
  await expect(page.getByTestId('hole-fill-selected-refusal')).toContainText('512');
});

test('a model with no open boundaries says so plainly', async ({ page }) => {
  await importAndList(page, 'closed.stl', tetrahedronStl());
  expect(await openingCount(page)).toBe(0);
  await expect(page.getByTestId('hole-fill-count')).toContainText('No open boundaries');
  await expect(page.getByTestId('preview-fill')).toHaveCount(0);
  // AND NO CLAIM FOLLOWS FROM IT. Zero open boundaries is not watertightness.
  const panel = (await page.getByTestId('open-boundaries').textContent()) ?? '';
  expect(panel.toLowerCase()).not.toContain('watertight');
  expect(panel.toLowerCase()).not.toContain('printable');
});

test('a rim whose surrounding winding disagrees is refused, not repaired', async ({ page }) => {
  await importAndList(page, 'mixed-winding.stl', windingConflictStl());
  // The two triangles traverse their shared edge the same way, so the rim has no
  // single outward side. A fill must never silently repair a winding it was not
  // asked to repair.
  await expect(opening(page, 1)).toHaveAttribute('data-fillable', 'false');
  await selectOpening(page, 1);
  await expect(page.getByTestId('preview-fill')).toHaveCount(0);
});

/* --------------------------------------------------------- the hard gate -- */

test('HFUX08 / HP23: a patch that would pierce the model is never previewable', async ({
  page,
}) => {
  /*
   * THE HARD GATE, THROUGH THE PRODUCTION INTERFACE.
   *
   * This file is topologically perfect. The rim is simple, planar and manifold;
   * the fill removes it; no non-manifold structure appears; the Euler
   * characteristic moves by exactly the right amount. Only the patch-attributed
   * intersection check against the real kernel can reject it — so if a preview
   * ever appears here, the interface has found a way around the one check that
   * could see the defect.
   */
  await importAndList(page, 'pierced.stl', piercedShellStl());
  const before = await triangles(page);

  await selectOpening(page, 1);
  await requestPreview(page);

  // NO PATCH, NO APPLY, AND A REASON.
  await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
  await expect(page.getByTestId('apply-fill')).toHaveCount(0);
  await expect(page.getByTestId('patch-preview-banner')).toHaveCount(0);
  await expect(page.getByTestId('hole-fill-refusal')).toBeVisible();
  await expect(page.getByTestId('hole-fill-refusal-qualifier')).toContainText(
    'Your model was not changed',
  );

  // AND THE MODEL IS EXACTLY WHAT IT WAS.
  expect(await triangles(page)).toBe(before);

  // RETRY IS SANE: the opening stays selected and Preview comes back, so the
  // user is not stuck.
  await expect(page.getByTestId('preview-fill')).toBeVisible();
});

test('HFUX09 / HP24: a thin wall does NOT block the fill', async ({ page }) => {
  /*
   * THE CONTROL FOR THE CASE ABOVE. The same opposing surface, stopping a
   * thousandth of a unit short. Hole filling does not prove wall thickness, and
   * inventing a clearance requirement would refuse correct geometry while still
   * proving nothing about printability.
   */
  await importAndList(page, 'thin-wall.stl', thinWallStl());
  const before = await triangles(page);

  await selectOpening(page, 1);
  await requestPreview(page);

  await expect(page.getByTestId('hole-fill-candidate')).toBeVisible();
  await applyFill(page);
  expect(await triangles(page)).toBe(before + 2);

  // NO INVENTED CLEARANCE WARNING. The engine measured no crossing and says so
  // by accepting; a warning about proximity would be a claim nothing checked.
  const panel = (await page.getByTestId('open-boundaries').textContent()) ?? '';
  expect(panel.toLowerCase()).not.toContain('clearance');
  expect(panel.toLowerCase()).not.toContain('too close');
});

/* ---------------------------------------------------------- lifecycle ---- */

test('HFUX12: discarding a preview leaves the model untouched and the opening selected', async ({
  page,
}) => {
  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());
  const before = await triangles(page);
  await selectOpening(page, 1);
  await requestPreview(page);

  await page.getByTestId('discard-fill').click();

  await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
  await expect(page.getByTestId('patch-preview-banner')).toHaveCount(0);
  expect(await triangles(page)).toBe(before);
  expect(await openingCount(page)).toBe(1);

  // DISCARD IS NOT UNDO. Nothing was applied, so nothing is offered to reverse.
  await expect(page.getByTestId('undo-fill')).toHaveCount(0);
  // And the same opening can be previewed again.
  await expect(page.getByTestId('preview-fill')).toBeVisible();
  await requestPreview(page);
  await expect(page.getByTestId('hole-fill-candidate')).toBeVisible();
});

test('HFUX20: importing another model discards the preview and its Apply', async ({ page }) => {
  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());
  await selectOpening(page, 1);
  await requestPreview(page);
  await expect(page.getByTestId('apply-fill')).toBeVisible();

  await importAndList(page, 'closed.stl', tetrahedronStl());

  // NO CROSS-DOCUMENT CANDIDATE. The preview, its Apply and its overlay all
  // named a document that is no longer open.
  await expect(page.getByTestId('apply-fill')).toHaveCount(0);
  await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
  await expect(page.getByTestId('patch-preview-banner')).toHaveCount(0);
  expect(await openingCount(page)).toBe(0);
});

test('HFUX17: a repair applied under a preview makes that preview unusable', async ({ page }) => {
  /*
   * §54 AND §93. One coherent revision model: applying anything moves the
   * document, and a candidate built from the revision the user has left must
   * never become their geometry. The interface must remove the Apply rather
   * than let the worker refuse it.
   */
  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());
  await selectOpening(page, 1);
  await requestPreview(page);
  await expect(page.getByTestId('apply-fill')).toBeVisible();
  const before = await triangles(page);

  // A conservative repair on the same model. It is available whenever the plan
  // finds something to do; where it does not, this test still proves the
  // preview survives an unrelated re-render, which is the weaker but honest
  // claim to make about that file. Since REPAIR-UX-01 the action is always
  // present, so "available" means enabled rather than visible.
  const previewRepair = page.getByTestId('preview-repair');
  if (await previewRepair.isEnabled()) {
    await previewRepair.click();
    await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('apply-repair').click();
    await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });

    // THE FILL PREVIEW IS GONE. Not disabled, not refused on click — gone.
    await expect(page.getByTestId('apply-fill')).toHaveCount(0);
    await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
    // And the openings are re-listed against the revision the repair produced.
    await expect(page.getByTestId('hole-fill-count')).toBeVisible({ timeout: 60_000 });
  } else {
    expect(await triangles(page)).toBe(before);
    await expect(page.getByTestId('apply-fill')).toBeVisible();
  }
});

/* ------------------------------------------------------------- exports -- */

test('HFUX24, HFUX25, HFUX26: a preview is not authoritative; Apply and Undo are', async ({
  page,
}) => {
  /*
   * THE CRITICAL SEMANTIC TEST (§92). Exporting reads the AUTHORITATIVE
   * document, so a candidate on screen must not reach the file — and after
   * Apply it must, and after Undo it must not again.
   */
  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());
  const before = await triangles(page);

  await selectOpening(page, 1);
  await requestPreview(page);
  await expect(page.getByTestId('apply-fill')).toBeVisible();

  // 1-3. A PREVIEW EXISTS AND THE FILE DOES NOT CONTAIN IT.
  const previewed = await convert(page, 'stl');
  expect(stlTriangleCount(previewed)).toBe(before);

  // 4-6. Apply, and the file contains the patch.
  await applyFill(page);
  const applied = await convert(page, 'stl');
  expect(stlTriangleCount(applied)).toBe(before + 2);

  // 7-9. Undo, and it does not again.
  await page.getByTestId('undo-fill').click();
  await expect.poll(async () => triangles(page), { timeout: 60_000 }).toBe(before);
  const undone = await convert(page, 'stl');
  expect(stlTriangleCount(undone)).toBe(before);
});

test('HFUX25: OBJ and 3MF exports carry the filled geometry too', async ({ page }) => {
  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());
  const before = await triangles(page);
  await selectOpening(page, 1);
  await requestPreview(page);
  await applyFill(page);
  const after = before + 2;

  // OBJ: one `f` line per triangle. Counted rather than parsed, because what is
  // being established is that the filled geometry reached the file — the
  // exporters' own correctness is qualified in Stage 4A-2B2.
  const obj = (await convert(page, 'obj')).toString('utf8');
  const faceLines = obj.split('\n').filter((line) => line.startsWith('f ')).length;
  expect(faceLines).toBe(after);

  // 3MF needs a unit, and an STL states none. The workspace blocks it and says so —
  // which is the Stage 4A-2B3 behaviour, unchanged by this stage. Asserting the
  // block is what proves the fill did not quietly invent one.
  await openInspector(page);
  await page.getByTestId('open-convert').click();
  await expect(page.getByTestId('convert-workspace')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('convert-target-3mf').check();
  await expect(page.getByTestId('convert-report')).toBeVisible();
  await expect(page.getByTestId('convert-export')).toBeDisabled();
});

/* --------------------------------------------------------- many openings -- */

test('HFUX31: an inventory of thousands stays bounded and reports the true total', async ({
  page,
}) => {
  /*
   * §9, §65. A mesh of loose triangles has one boundary component per face. The
   * list is capped so the page never renders thousands of rows; the COUNT is
   * not, because a truncated list must never become a smaller number of
   * openings.
   */
  const faces = 4_000;
  await importAndList(page, 'loose.stl', looseTrianglesStl(faces));

  expect(await openingCount(page)).toBe(faces);
  await expect(page.getByTestId('hole-fill-truncated')).toBeVisible();
  const rows = await page.locator('[data-testid^="opening-"]').count();
  expect(rows).toBeLessThanOrEqual(256);
  expect(rows).toBeGreaterThan(0);

  // AND THE PAGE IS STILL USABLE. A row can be selected and the panel responds.
  await selectOpening(page, 1);
  await expect(page.getByTestId('hole-fill-selection')).toBeVisible({ timeout: 15_000 });
});

/* ------------------------------------------------------- honest interface -- */

test('nothing in the workflow claims the model is watertight or printable', async ({ page }) => {
  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());
  await selectOpening(page, 1);
  await requestPreview(page);
  await applyFill(page);

  /*
   * SCOPED TO THIS WORKFLOW AND THE STATUS LOG, which is what this test is about.
   * The navigation carries future-tense summaries for workflows that do not
   * exist yet — Texture promises displacement on "printable faces" — and those
   * are that stage's copy to answer for, tested where they live.
   */
  const panel = (await page.getByTestId('open-boundaries').textContent()) ?? '';
  const log = (await page.getByTestId('status-list').textContent()) ?? '';
  const lower = `${panel} ${log}`.toLowerCase();
  for (const banned of [
    'watertight',
    'printable',
    'ready to print',
    'model repaired',
    'all errors fixed',
    'fully repaired',
  ]) {
    expect(lower, `the interface said "${banned}"`).not.toContain(banned);
  }

  // The strongest thing it may say, and the qualifier that must accompany it.
  await expect(page.getByTestId('hole-fill-applied-headline')).toHaveText(
    'Selected opening filled and validated',
  );
  await expect(page.getByTestId('hole-fill-applied-qualifier')).toContainText('were not examined');
});

test('§85: the fill worker is constructed only by a Preview or a plan verifying an admitted opening, and never left running', async ({
  page,
}) => {
  /*
   * LAZY, AND MEASURED RATHER THAN ASSERTED. The hole-fill worker carries the
   * triangulator, the broadphase and every validator; constructing one on page
   * load — or on opening the panel, or on selecting an opening — would spend
   * that on every user who never fills anything.
   *
   * `Worker` is wrapped BEFORE any page script runs, so what is counted is every
   * real construction the production code performs. Nothing is stubbed: the
   * wrapper delegates to the genuine constructor and the app is unaware of it.
   */
  await page.addInitScript(() => {
    const created: string[] = [];
    const terminated: string[] = [];
    (
      window as unknown as { __workerLog: { created: string[]; terminated: string[] } }
    ).__workerLog = { created, terminated };
    const Original = window.Worker;
    class CountingWorker extends Original {
      public constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        created.push(options?.name ?? String(url));
        const terminate = this.terminate.bind(this);
        this.terminate = (): void => {
          terminated.push(options?.name ?? String(url));
          terminate();
        };
      }
    }
    window.Worker = CountingWorker;
  });

  const workers = async (): Promise<{ created: string[]; terminated: string[] }> =>
    page.evaluate(
      () =>
        (window as unknown as { __workerLog: { created: string[]; terminated: string[] } })
          .__workerLog,
    );
  const fillWorkers = (names: readonly string[]): number =>
    names.filter((name) => name.includes('hole-fill')).length;

  await page.goto('/');
  await expect(page.getByTestId('browse-button')).toBeVisible({ timeout: 30_000 });
  // App load: none.
  expect(fillWorkers((await workers()).created)).toBe(0);

  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());
  /*
   * REPAIR-RC-03: Repair model's plan VERIFIES the opening it admits, so the
   * count it shows is one the exact check has passed — which takes exactly one
   * disposable verifier, closed as soon as the plan settles. Listing openings
   * is still a read in the AUTHORITATIVE worker and touches no fill worker.
   */
  await expect
    .poll(async () => fillWorkers((await workers()).created), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(async () => fillWorkers((await workers()).terminated), { timeout: 30_000 })
    .toBe(1);

  await selectOpening(page, 1);
  await expect(page.getByTestId('hole-fill-selection')).toBeVisible();
  // Selecting one, and drawing its rim: none more.
  expect(fillWorkers((await workers()).created)).toBe(1);

  await requestPreview(page);
  const afterPreview = await workers();
  expect(fillWorkers(afterPreview.created)).toBe(2);

  // AND IT IS DISPOSABLE. The service terminates it on every terminal outcome,
  // so nothing is left running after the candidate exists.
  await expect
    .poll(async () => fillWorkers((await workers()).terminated), { timeout: 30_000 })
    .toBe(2);

  // Apply builds NONE: it consumes the stored candidate, and the new revision
  // has no opening left for a plan to verify.
  await applyFill(page);
  await page.waitForTimeout(2_000);
  expect(fillWorkers((await workers()).created)).toBe(2);

  // Undo builds none either — but it brings the opening back at a NEW
  // revision, whose plan verifies it once, and closes that verifier.
  await page.getByTestId('undo-fill').click();
  await expect.poll(async () => openingCount(page), { timeout: 60_000 }).toBe(1);
  await expect
    .poll(async () => fillWorkers((await workers()).created), { timeout: 30_000 })
    .toBe(3);
  await expect
    .poll(async () => fillWorkers((await workers()).terminated), { timeout: 30_000 })
    .toBe(3);
});

test('the workflow issues no network request at any point', async ({ page }) => {
  /*
   * §83, §111. Hole filling is local, and this is the only way to establish it
   * rather than assert it: watch every request the page makes for the whole
   * workflow and require that none of them leaves the origin.
   */
  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (new URL(url).origin === new URL(page.url()).origin) return;
    external.push(url);
  });

  await importAndList(page, 'open-box.stl', boxWithOneOpeningStl());
  await selectOpening(page, 1);
  await requestPreview(page);
  await applyFill(page);
  await page.getByTestId('undo-fill').click();
  await expect.poll(async () => openingCount(page), { timeout: 60_000 }).toBe(1);

  expect(external, 'geometry or telemetry left the origin').toEqual([]);
});
