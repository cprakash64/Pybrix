import { revealControl } from '../e2e/progressive-disclosure';
import { expect, test } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readScene, readState } from './harness';

/**
 * REPAIRING ONE PART OF A DOCUMENT, THROUGH THE REAL WORKFLOW.
 *
 * Nothing here is a shortcut: the plan, the preview, Apply and Undo are the
 * production controls, driven by clicking them. What the harness supplies is
 * only the document — a repairable part beside a clean one, which no STL can
 * express.
 *
 * The claim under test is the one a user would care about most: repairing one
 * part must leave the rest of the model exactly as it was, byte for byte, and
 * must not be able to land on the wrong part.
 */

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test('repairing part A leaves part B byte-identical and still on screen', async ({ page }) => {
  test.setTimeout(240_000);

  const loaded = await loadFixture(page, Fixture.DefectAndClean);
  expect(loaded.partIds).toEqual(['a', 'b']);
  expect(loaded.activePartId).toBe('a');

  const before = await digest(page, loaded);
  const bBefore = before.parts.find((part) => part.partId === 'b');
  expect(bBefore).toBeDefined();

  // The plan is derived from A's report, which has to arrive first.
  await expect
    .poll(async () => (await readState(page)).analysisState, { timeout: 120_000 })
    .toBe('ready');
  await expect(page.getByTestId('repair-part-scope')).toContainText('Defective');

  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  const preview = page.getByTestId('advanced-preview-repair');
  await expect(preview).toBeEnabled({ timeout: 120_000 });
  await preview.click();

  // The candidate belongs to A, and the panel says so.
  await revealControl(page, page.getByTestId('repair-candidate-headline'));
  await expect(page.getByTestId('repair-candidate-headline')).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(async () => (await readState(page)).repairCandidatePartId, { timeout: 60_000 })
    .toBe('a');

  // BOTH PARTS ARE STILL DRAWN during a preview. A preview replaces one part's
  // mesh on screen; it does not empty the scene.
  const previewing = await readScene(page);
  expect(previewing.modelObjects).toBe(2);

  const apply = page.getByTestId('apply-repair');
  await expect(apply).toBeEnabled();
  await apply.click();
  await revealControl(page, page.getByTestId('repair-applied-headline'));
  await expect(page.getByTestId('repair-applied-headline')).toBeVisible({ timeout: 120_000 });

  const applied = await readState(page);
  // ONE new document revision for the whole document.
  expect(applied.revision).toBe((loaded.revision ?? 0) + 1);
  expect(applied.documentId).toBe(loaded.documentId);
  expect(applied.partCount).toBe(2);
  expect(applied.partIds).toEqual(['a', 'b']);
  // The selection survived the transaction.
  expect(applied.activePartId).toBe('a');

  const after = await digest(page, applied);
  const aAfter = after.parts.find((part) => part.partId === 'a');
  const bAfter = after.parts.find((part) => part.partId === 'b');

  // A CHANGED — the duplicate face is gone, so its buffers are shorter.
  expect(aAfter?.positionDigest).not.toBe(
    before.parts.find((part) => part.partId === 'a')?.positionDigest,
  );

  // B DID NOT. Byte-for-byte, via a digest taken where the bytes live.
  expect(bAfter?.positionDigest).toBe(bBefore?.positionDigest);
  expect(bAfter?.indexDigest).toBe(bBefore?.indexDigest);
  expect(bAfter?.positionBytes).toBe(bBefore?.positionBytes);
  expect(bAfter?.indexBytes).toBe(bBefore?.indexBytes);
  expect(bAfter?.transform).toEqual(bBefore?.transform);

  // And it is still being drawn.
  expect((await readScene(page)).modelObjects).toBe(2);
});

test('undo restores part A as a new revision and leaves part B alone', async ({ page }) => {
  test.setTimeout(240_000);

  const loaded = await loadFixture(page, Fixture.DefectAndClean);
  const before = await digest(page, loaded);
  const aBefore = before.parts.find((part) => part.partId === 'a');
  const bBefore = before.parts.find((part) => part.partId === 'b');

  await expect
    .poll(async () => (await readState(page)).analysisState, { timeout: 120_000 })
    .toBe('ready');
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 120_000 });
  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId('apply-repair').click();
  await revealControl(page, page.getByTestId('repair-applied-headline'));
  await expect(page.getByTestId('repair-applied-headline')).toBeVisible({ timeout: 120_000 });

  const applied = await readState(page);
  const undo = page.getByTestId('undo-repair');
  await expect(undo).toBeEnabled();
  await undo.click();

  await expect
    .poll(async () => (await readState(page)).revision, { timeout: 120_000 })
    .toBe((applied.revision ?? 0) + 1);

  const undone = await readState(page);
  const restored = await digest(page, undone);

  // A NEW, HIGHER revision — never a rewind to the one before the repair.
  expect(undone.revision).toBe((loaded.revision ?? 0) + 2);
  // A's coordinates are back exactly.
  expect(restored.parts.find((part) => part.partId === 'a')?.positionDigest).toBe(
    aBefore?.positionDigest,
  );
  // B was never involved, through the repair AND the undo.
  expect(restored.parts.find((part) => part.partId === 'b')?.positionDigest).toBe(
    bBefore?.positionDigest,
  );
  expect((await readScene(page)).modelObjects).toBe(2);
});

test('switching parts mid-preview withdraws Apply rather than retargeting it', async ({ page }) => {
  test.setTimeout(240_000);

  const loaded = await loadFixture(page, Fixture.DefectAndClean);
  const before = await digest(page, loaded);
  const bBefore = before.parts.find((part) => part.partId === 'b');

  await expect
    .poll(async () => (await readState(page)).analysisState, { timeout: 120_000 })
    .toBe('ready');
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 120_000 });
  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  await revealControl(page, page.getByTestId('repair-candidate-headline'));
  await expect(page.getByTestId('repair-candidate-headline')).toBeVisible({ timeout: 120_000 });

  // Now select the OTHER part while a candidate for A exists.
  await page.getByTestId('part-option-b').click();
  await expect
    .poll(async () => (await readState(page)).repairPartId, { timeout: 60_000 })
    .toBe('b');

  /*
   * APPLY IS GONE, not repointed. The candidate was computed from A's mesh; the
   * one thing that must never happen is it landing on B. The interface removes
   * the control rather than leaving a button whose target has silently changed.
   */
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);

  // And the document is untouched: no revision was consumed by any of this.
  const after = await readState(page);
  expect(after.revision).toBe(loaded.revision);

  const digested = await digest(page, after);
  expect(digested.parts.find((part) => part.partId === 'b')?.positionDigest).toBe(
    bBefore?.positionDigest,
  );
});
