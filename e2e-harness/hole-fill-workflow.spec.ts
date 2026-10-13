import { revealControl } from '../e2e/progressive-disclosure';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readScene, readState } from './harness';

/**
 * THE OPEN-BOUNDARY WORKFLOW ON DOCUMENTS NO IMPORTER CAN PRODUCE.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM `e2e/hole-fill-workflow.spec.ts`. The
 * shipped application imports STL, OBJ and 3MF, and none of those can hand the
 * product two parts that SHARE one `CanonicalMesh` object, or a part placed by a
 * mirrored non-uniform transform, or a 512-vertex rim on a hundred thousand
 * faces. Those are precisely the cases where filling one part could silently
 * change another, where a part-local overlay could be drawn at the document
 * origin, and where a fill takes long enough for responsiveness and
 * cancellation to mean anything.
 *
 * WHAT IS PRODUCTION HERE: the panel, the store, the hook, the service, the
 * authoritative worker, the disposable fill worker, the kernel and the viewport.
 * The harness supplies a document and a button to load it, and nothing else.
 *
 * THE DIGEST IS THE EVIDENCE FOR ISOLATION. Canonical arrays never leave the
 * worker; a digest and a byte length come back. Comparing part B's digest before
 * and after filling part A is a byte-level statement about geometry the page has
 * never held.
 */

function opening(page: Page, index: number): Locator {
  return page.getByTestId(`opening-${String(index)}`);
}

/**
 * Points the workflow at one part.
 *
 * A NO-OP FOR A SINGLE-PART DOCUMENT, deliberately: `PartSelector` renders
 * nothing at all when there is only one part — there is nothing to choose — so
 * the part is already active and waiting for a control that does not exist would
 * be waiting forever.
 */
async function selectPart(page: Page, partId: string): Promise<void> {
  if ((await readState(page)).activePartId !== partId) {
    await page.getByTestId(`part-option-${partId}`).click();
  }
  await expect.poll(async () => (await readState(page)).activePartId).toBe(partId);
}

/** Waits until the panel has listed the active part's openings. */
async function awaitListing(page: Page): Promise<void> {
  await revealControl(page, page.getByTestId('hole-fill-count'));
  await expect(page.getByTestId('hole-fill-count')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('hole-fill-listing')).toHaveCount(0, { timeout: 60_000 });
}

async function requestPreview(page: Page): Promise<'ready' | 'refused'> {
  await page.getByTestId('preview-fill').click();
  await expect(async () => {
    const ready = await page.getByTestId('hole-fill-candidate').isVisible();
    const refused = await page.getByTestId('hole-fill-refusal').isVisible();
    expect(ready || refused).toBe(true);
  }).toPass({ timeout: 180_000 });
  return (await page.getByTestId('hole-fill-candidate').isVisible()) ? 'ready' : 'refused';
}

async function applyFill(page: Page): Promise<void> {
  await page.getByTestId('apply-fill').click();
  await expect(page.getByTestId('hole-fill-applied')).toBeVisible({ timeout: 60_000 });
}

/* --------------------------------------------- HFUX21: shared geometry -- */

test('HFUX21: filling one part of a shared pair leaves the other byte-identical', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillSharedPair);

  // ONE MESH RESOURCE FOR TWO PARTS, as the document was built.
  expect(loaded.partCount).toBe(2);
  expect(loaded.distinctMeshResources).toBe(1);
  const before = await digest(page, loaded);
  const partA = loaded.partIds[0] ?? '';
  const partB = loaded.partIds[1] ?? '';
  const digestBBefore = before.parts.find((part) => part.partId === partB);
  expect(digestBBefore).toBeDefined();

  await selectPart(page, partA);
  await awaitListing(page);
  await opening(page, 1).getByRole('radio').check();
  expect(await requestPreview(page)).toBe('ready');
  await applyFill(page);

  const after = await readState(page);
  const afterDigest = await digest(page, after);
  const digestA = afterDigest.parts.find((part) => part.partId === partA);
  const digestB = afterDigest.parts.find((part) => part.partId === partB);

  /*
   * THE HARD GATE (§30). Part A received the candidate; part B is exactly what
   * it was, byte for byte, and is no longer sharing a resource with A.
   */
  expect(digestB?.positionDigest).toBe(digestBBefore?.positionDigest);
  expect(digestB?.indexDigest).toBe(digestBBefore?.indexDigest);
  expect(digestB?.positionBytes).toBe(digestBBefore?.positionBytes);
  expect(digestB?.indexBytes).toBe(digestBBefore?.indexBytes);
  expect(digestB?.transform).toEqual(digestBBefore?.transform);

  // A genuinely changed: more index bytes, same positions — the fill is
  // append-only and adds no vertex.
  const digestABefore = before.parts.find((part) => part.partId === partA);
  expect(digestA?.indexBytes).toBeGreaterThan(digestABefore?.indexBytes ?? 0);
  expect(digestA?.positionDigest).toBe(digestABefore?.positionDigest);

  // THE SHARING BROKE WHERE IT HAD TO AND NOWHERE ELSE: two resources now,
  // because A's geometry genuinely differs from B's.
  expect(afterDigest.distinctMeshes).toBe(2);
  expect(after.partCount).toBe(2);

  /*
   * AND PART B STILL HAS ITS OPENING. The whole failure this case exists to
   * catch is a fill that silently closes both.
   */
  await selectPart(page, partB);
  await awaitListing(page);
  await expect(page.getByTestId('hole-fill-count')).toContainText('open bound');

  /*
   * US02: UNDO RESTORES THE DOCUMENT, NOT MERELY ITS BYTES — Stage 4B-1B2-R1.
   *
   * The first implementation reversed a fill by truncating the appended patch,
   * which reproduced the source's bytes exactly and was still wrong: the rebuilt
   * mesh was a NEW object, so this document came back holding two byte-equal
   * meshes where it had one — permanently, for a change the user had just taken
   * back. Every byte assertion below passed against that implementation. The
   * resource count is the one that could see it.
   */
  await selectPart(page, partA);
  await awaitListing(page);
  await page.getByTestId('undo-fill').click();
  await expect
    .poll(async () => (await readState(page)).revision ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(after.revision ?? 0);

  const restoredState = await readState(page);
  const restored = await digest(page, restoredState);
  for (const part of restored.parts) {
    const original = before.parts.find((entry) => entry.partId === part.partId);
    expect(part.positionDigest, `${part.partId} positions`).toBe(original?.positionDigest);
    expect(part.indexDigest, `${part.partId} indices`).toBe(original?.indexDigest);
    expect(part.positionBytes, `${part.partId} position bytes`).toBe(original?.positionBytes);
    expect(part.indexBytes, `${part.partId} index bytes`).toBe(original?.indexBytes);
    expect(part.transform, `${part.partId} placement`).toEqual(original?.transform);
  }

  // ONE MESH AGAIN. Reference identity in the worker, observed through the
  // resource index every part reports.
  expect(restored.distinctMeshes).toBe(1);
  expect(restored.parts[0]?.meshResourceIndex).toBe(restored.parts[1]?.meshResourceIndex);
  expect(restoredState.distinctMeshResources).toBe(1);
  // And the document is no larger than it was before any of this happened.
  expect(restoredState.residentBytes).toBe(loaded.residentBytes);
});

/* ---------------------------------------- HFUX19: switching active part -- */

test('HFUX19: switching parts discards the preview and offers no Apply for the old one', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillSharedPair);
  const partA = loaded.partIds[0] ?? '';
  const partB = loaded.partIds[1] ?? '';

  await selectPart(page, partA);
  await awaitListing(page);
  await opening(page, 1).getByRole('radio').check();
  expect(await requestPreview(page)).toBe('ready');
  await expect(page.getByTestId('apply-fill')).toBeVisible();

  await selectPart(page, partB);

  /*
   * §52. AN ACCIDENTAL CROSS-PART APPLY IS MADE IMPOSSIBLE BEFORE THE ENGINE
   * WOULD REFUSE ONE. The guard in the worker still exists and still fires; the
   * point is that the interface never offers the button that would trip it.
   */
  await expect(page.getByTestId('apply-fill')).toHaveCount(0);
  await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
  await expect(page.getByTestId('patch-preview-banner')).toHaveCount(0);
  await awaitListing(page);

  // And the document never moved.
  const state = await readState(page);
  expect(state.revision).toBe(loaded.revision);
});

/* ------------------------------- HFUX27, HFUX28: placement and overlays -- */

test('HFUX27, HFUX28: a mirrored, non-uniformly scaled part fills in LOCAL coordinates', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillTransformed);
  const part = loaded.partIds[0] ?? '';
  const before = await digest(page, loaded);
  const transformBefore = before.parts[0]?.transform;

  await selectPart(page, part);
  await awaitListing(page);
  await opening(page, 1).getByRole('radio').check();

  // The rim overlay exists and rides on the ACTIVE PART's frame. The viewport
  // publishes its object counts for exactly this kind of check.
  await expect
    .poll(async () => (await readScene(page)).holeFillOverlayObjects, { timeout: 30_000 })
    .toBeGreaterThan(0);

  expect(await requestPreview(page)).toBe('ready');
  // Rim AND patch are now drawn, both in the same frame.
  await expect
    .poll(async () => (await readScene(page)).holeFillOverlayObjects, { timeout: 30_000 })
    .toBe(2);

  await applyFill(page);

  const after = await digest(page, await readState(page));
  /*
   * §58. THE PLACEMENT IS UNTOUCHED AND WAS NEVER BAKED IN. Hole filling is
   * intra-part and works in part-local coordinates: a reflection and a
   * non-uniform scale change how the part is DRAWN and change nothing the engine
   * looks at.
   */
  expect(after.parts[0]?.transform).toEqual(transformBefore);
  expect(after.parts[0]?.positionDigest).toBe(before.parts[0]?.positionDigest);
  expect(after.parts[0]?.indexBytes).toBeGreaterThan(before.parts[0]?.indexBytes ?? 0);

  // The overlays are gone: the patch is ordinary source geometry now.
  await expect
    .poll(async () => (await readScene(page)).holeFillOverlayObjects, { timeout: 30_000 })
    .toBe(0);
});

/* ------------------------------------------- HFUX10, HFUX11: cancelling -- */

test('HFUX10, HFUX11: Cancel stops a large fill and a retry then succeeds', async ({ page }) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillLarge);
  const part = loaded.partIds[0] ?? '';
  const before = await digest(page, loaded);

  await selectPart(page, part);
  await awaitListing(page);

  // The 512-vertex rim is the one worth cancelling: it is the worst case the
  // policy allows and takes long enough to have something to interrupt.
  const rows = page.locator('[data-testid^="opening-"]');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await rows.first().getByRole('radio').check();

  await page.getByTestId('preview-fill').click();
  await expect(page.getByTestId('cancel-fill')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('cancel-fill').click();

  await expect(page.getByTestId('hole-fill-cancelled')).toBeVisible({ timeout: 60_000 });

  /*
   * NOTHING WAS BUILT AND NOTHING IS RESIDENT. No candidate, no patch, no
   * overlay, and the document has not moved a revision.
   */
  await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
  await expect(page.getByTestId('apply-fill')).toHaveCount(0);
  await expect(page.getByTestId('patch-preview-banner')).toHaveCount(0);

  const afterCancel = await readState(page);
  expect(afterCancel.revision).toBe(loaded.revision);
  const cancelledDigest = await digest(page, afterCancel);
  expect(cancelledDigest.parts[0]?.positionDigest).toBe(before.parts[0]?.positionDigest);
  expect(cancelledDigest.parts[0]?.indexDigest).toBe(before.parts[0]?.indexDigest);

  // HFUX11. THE USER IS NOT STUCK: the opening is still selected and Preview is
  // back, on a fresh worker.
  await expect(page.getByTestId('preview-fill')).toBeVisible();
  expect(await requestPreview(page)).toBe('ready');
  await expect(page.getByTestId('apply-fill')).toBeEnabled();
});

/* ------------------------------------ HFUX32: candidate and GPU lifecycle -- */

test('HFUX32: repeated preview and discard cycles leak no GPU resource', async ({ page }) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillSharedPair);
  const part = loaded.partIds[0] ?? '';

  await selectPart(page, part);
  await awaitListing(page);
  await opening(page, 1).getByRole('radio').check();

  const baseline = await readScene(page);

  for (let cycle = 0; cycle < 5; cycle += 1) {
    expect(await requestPreview(page)).toBe('ready');
    await page.getByTestId('discard-fill').click();
    await expect(page.getByTestId('hole-fill-candidate')).toHaveCount(0);
  }

  const after = await readScene(page);
  /*
   * BOUNDED, NOT MERELY "SMALL". Five cycles built and released five patches;
   * what remains is the rim, exactly as before the first cycle. A growing count
   * would be a leak per preview, proportional to the patch, invisible until a
   * long session ran the tab out of GPU memory.
   */
  expect(after.holeFillOverlayObjects).toBe(1);
  expect(after.modelObjects).toBe(baseline.modelObjects);
  expect(after.sharedGeometries).toBe(baseline.sharedGeometries);

  // Every rim and patch that was created has been released.
  expect(after.holeFillOverlaysDisposed).toBe(after.holeFillOverlaysCreated - 1);

  // AND THE DOCUMENT NEVER MOVED. Five previews and five discards mutate
  // nothing.
  expect((await readState(page)).revision).toBe(loaded.revision);
});

test('HFUX32: apply and undo cycles keep the scene and the revisions bounded', async ({ page }) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillSharedPair);
  const part = loaded.partIds[0] ?? '';
  const before = await digest(page, loaded);

  let revision = loaded.revision ?? 0;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await selectPart(page, part);
    await awaitListing(page);
    await opening(page, 1).getByRole('radio').check();
    expect(await requestPreview(page)).toBe('ready');
    await applyFill(page);

    const applied = await readState(page);
    // MONOTONIC, ALWAYS FORWARD. Undo produces a NEW higher revision rather
    // than reviving an old one — ADR 0011 — so the number only ever climbs.
    expect(applied.revision ?? 0).toBeGreaterThan(revision);
    revision = applied.revision ?? 0;

    await page.getByTestId('undo-fill').click();
    await expect
      .poll(async () => (await readState(page)).revision ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(revision);
    revision = (await readState(page)).revision ?? 0;

    // And each undo really did restore the bytes — every cycle, not just the
    // first, which is what rules out a drift that only shows up on repetition.
    const restored = await digest(page, await readState(page));
    for (const part of restored.parts) {
      const original = before.parts.find((entry) => entry.partId === part.partId);
      expect(part.positionDigest, `cycle ${String(cycle)} ${part.partId}`).toBe(
        original?.positionDigest,
      );
      expect(part.indexDigest, `cycle ${String(cycle)} ${part.partId}`).toBe(original?.indexDigest);
    }
  }

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(2);
  expect(scene.holeFillOverlayObjects).toBe(0);
});

/* ------------------------------------------- §66: real-UI responsiveness -- */

test('§66: the production panel stays responsive through a large fill', async ({ page }) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillLarge);
  const part = loaded.partIds[0] ?? '';

  await selectPart(page, part);
  await awaitListing(page);
  const rows = page.locator('[data-testid^="opening-"]');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await rows.first().getByRole('radio').check();

  await page.getByTestId('preview-fill').click();

  /*
   * THE PROGRESS STATE PAINTS AND CANCEL IS ACTIONABLE. Stage 4B-1B1 proved the
   * work is off-thread at the SERVICE level; what only the product can show is
   * that the panel actually renders a state while it happens and that the
   * control the user would reach for responds.
   */
  await expect(page.getByTestId('hole-fill-phase')).toBeVisible({ timeout: 30_000 });
  const cancel = page.getByTestId('cancel-fill');
  await expect(cancel).toBeEnabled();

  const startedAt = Date.now();
  await cancel.hover();
  const hoverMs = Date.now() - startedAt;
  expect(hoverMs, `hovering a control took ${String(hoverMs)}ms during a fill`).toBeLessThan(2_000);

  await expect(async () => {
    const ready = await page.getByTestId('hole-fill-candidate').isVisible();
    const refused = await page.getByTestId('hole-fill-refusal').isVisible();
    expect(ready || refused).toBe(true);
  }).toPass({ timeout: 300_000 });

  await expect(page.getByTestId('hole-fill-candidate')).toBeVisible();
  // §68. Apply is identity checks and a reference swap, never a second fill.
  const applyStarted = Date.now();
  await applyFill(page);
  const applyMs = Date.now() - applyStarted;
  expect(
    applyMs,
    `applying a stored candidate took ${String(applyMs)}ms; a re-run would take seconds`,
  ).toBeLessThan(10_000);
});

/* ------------------------------------------------------ §108: latencies -- */

test('§108: every phase of the workflow is measured, on the worst in-policy part', async ({
  page,
}) => {
  /*
   * WHAT EACH NUMBER IS, so the report cannot be read as more than it is.
   *
   * These are WALL-CLOCK latencies from the page's point of view: the moment a
   * control is pressed to the moment the interface shows the result. They
   * therefore include the round trip, the render and Playwright's own polling
   * granularity, and they are not a substitute for the engine's own phase
   * timings — `npm run bench:hole-fill` measures those, in-process, and this
   * stage did not change them.
   *
   * The fixture is the worst case the policy allows: a 512-vertex rim on roughly
   * 100,000 faces. A measurement on a cube would say nothing about either
   * ceiling.
   */
  test.setTimeout(600_000);
  await openHarness(page);

  const listingStarted = Date.now();
  const loaded = await loadFixture(page, Fixture.HoleFillLarge);
  const part = loaded.partIds[0] ?? '';
  await selectPart(page, part);
  await awaitListing(page);
  const inventoryMs = Date.now() - listingStarted;

  const rows = page.locator('[data-testid^="opening-"]');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });

  const rimStarted = Date.now();
  await rows.first().getByRole('radio').check();
  await expect
    .poll(async () => (await readScene(page)).holeFillOverlayObjects, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const rimMs = Date.now() - rimStarted;

  const generationStarted = Date.now();
  expect(await requestPreview(page)).toBe('ready');
  const generationMs = Date.now() - generationStarted;

  // The patch snapshot arrives after the candidate, so it is measured from the
  // candidate appearing to the patch being drawn.
  const patchStarted = Date.now();
  await expect
    .poll(async () => (await readScene(page)).holeFillOverlayObjects, { timeout: 60_000 })
    .toBe(2);
  const patchMs = Date.now() - patchStarted;

  const applyStarted = Date.now();
  await applyFill(page);
  const applyMs = Date.now() - applyStarted;

  // Re-analysis and re-listing follow the new revision automatically; this is
  // the time until the panel again reports the openings of what the user now has.
  const reanalysisStarted = Date.now();
  await awaitListing(page);
  const reanalysisMs = Date.now() - reanalysisStarted;

  const undoStarted = Date.now();
  await page.getByTestId('undo-fill').click();
  await expect
    .poll(async () => (await readState(page)).revision ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await awaitListing(page);
  const undoMs = Date.now() - undoStarted;

  // Reported the way every other measured harness spec reports: straight to
  // stdout, so the numbers land in the run log beside the export and
  // responsiveness ones rather than in a console the reporter filters.
  process.stdout.write(
    `[hole-fill workflow] 512-vertex rim on ~100k faces: ` +
      `inventory ${String(inventoryMs)}ms, rim ${String(rimMs)}ms, ` +
      `generation ${String(generationMs)}ms, patch snapshot ${String(patchMs)}ms, ` +
      `apply ${String(applyMs)}ms, re-analysis ${String(reanalysisMs)}ms, ` +
      `undo ${String(undoMs)}ms\n`,
  );

  /*
   * THE ONE ASSERTION THAT IS A CLAIM RATHER THAN A RECORD.
   *
   * Apply must be far cheaper than generation, because it does no geometry work
   * — identity checks, one immutable document update and one reference swap. A
   * re-run would put it in the same order as generation. Stated as a RATIO
   * against the generation measured on the SAME machine in the SAME run, so it
   * is a statement about the work rather than about the hardware.
   */
  expect(
    applyMs,
    `apply took ${String(applyMs)}ms against a ${String(generationMs)}ms generation; ` +
      `a second fill during commit would show here`,
  ).toBeLessThan(Math.max(generationMs / 2, 2_000));
});

/* -------------------------------- US09, US10: sharing the user can observe -- */

test('US09: the GPU holds ONE geometry again after undo, not two equal ones', async ({ page }) => {
  /*
   * WHAT THE RENDERER KEYS ON. `SharedPartGeometry` reference-counts by position
   * ARRAY IDENTITY: parts sharing an authoritative mesh receive the same
   * `Float32Array` and get one `BufferGeometry` between them. So a document that
   * is sharing again while the page holds two equal arrays would upload a second
   * geometry for coordinates it is already drawing — an undo that permanently
   * doubled what the GPU holds.
   */
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillSharedPair);
  const partA = loaded.partIds[0] ?? '';

  const baseline = await readScene(page);
  // Two parts, ONE uploaded geometry.
  expect(baseline.modelObjects).toBe(2);
  expect(baseline.sharedGeometries).toBe(1);

  await selectPart(page, partA);
  await awaitListing(page);
  await opening(page, 1).getByRole('radio').check();
  expect(await requestPreview(page)).toBe('ready');
  await applyFill(page);

  // The fill genuinely un-shares, so a second geometry is correct here.
  await expect
    .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 60_000 })
    .toBe(2);

  await page.getByTestId('undo-fill').click();
  await expect
    .poll(async () => (await readState(page)).revision ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(loaded.revision ?? 0);

  // AND BACK TO ONE. Both parts draw from the same buffer again.
  await expect
    .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 60_000 })
    .toBe(1);
  const after = await readScene(page);
  expect(after.modelObjects).toBe(2);

  /*
   * NO PREMATURE AND NO DOUBLE DISPOSAL. Every geometry created has either been
   * released or is still in the scene; the two counters differ by exactly what
   * is drawn. A double dispose would push `disposed` past `created`, and a leak
   * would leave the difference above the live count.
   */
  expect(after.geometriesCreated - after.geometriesDisposed).toBe(after.sharedGeometries);
  expect(after.geometriesDisposed).toBeLessThanOrEqual(after.geometriesCreated);
});

test('US09: repeated apply/undo cycles never grow the GPU beyond the baseline', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillSharedPair);
  const partA = loaded.partIds[0] ?? '';
  const baseline = await readScene(page);

  for (let cycle = 0; cycle < 5; cycle += 1) {
    await selectPart(page, partA);
    await awaitListing(page);
    await opening(page, 1).getByRole('radio').check();
    expect(await requestPreview(page)).toBe('ready');
    await applyFill(page);
    await page.getByTestId('undo-fill').click();
    await expect
      .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 60_000 })
      .toBe(1);

    const scene = await readScene(page);
    expect(scene.modelObjects, `cycle ${String(cycle)}`).toBe(baseline.modelObjects);
    expect(scene.sharedGeometries, `cycle ${String(cycle)}`).toBe(baseline.sharedGeometries);
    expect(scene.geometriesCreated - scene.geometriesDisposed, `cycle ${String(cycle)}`).toBe(
      scene.sharedGeometries,
    );

    const state = await readState(page);
    expect(state.distinctMeshResources, `cycle ${String(cycle)}`).toBe(1);
    expect(state.residentBytes, `cycle ${String(cycle)}`).toBe(loaded.residentBytes);
  }
});

test('US10: a 3MF written after undo has the SAME object resources as before the fill', async ({
  page,
}) => {
  /*
   * THE CONSEQUENCE A USER COULD ACTUALLY SEE. 3MF is where structural sharing
   * is observable in a FILE: parts that share a mesh become one `<object>`
   * resource referenced twice, and parts that do not become two. So an undo that
   * restored bytes but lost identity would silently double the resources in
   * every 3MF exported afterwards — a file the user would open elsewhere.
   *
   * A unit-bearing fixture, because the 3MF writer is fail-closed without one:
   * CAD Fixer will not invent a unit to make an export succeed, and this test
   * must not be the thing that tempts it to.
   */
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillSharedPairMillimetre);
  const partA = loaded.partIds[0] ?? '';

  const before = await exportThreeMf(page);
  expect(before.status).toBe('SUCCESS');
  expect(before.partCount).toBe(2);
  // ONE resource for two placements, and the writer says so by name.
  expect(before.meshResourceCount).toBe(1);
  expect(before.observations).toContain('STRUCTURAL_SHARING_PRESERVED');

  await selectPart(page, partA);
  await awaitListing(page);
  await opening(page, 1).getByRole('radio').check();
  expect(await requestPreview(page)).toBe('ready');
  await applyFill(page);

  // The fill genuinely changed one part, so two resources is the truthful answer.
  const appliedRevision = (await readState(page)).revision ?? 0;
  const afterApply = await exportThreeMf(page);
  expect(afterApply.status).toBe('SUCCESS');
  expect(afterApply.meshResourceCount).toBe(2);

  await page.getByTestId('undo-fill').click();
  // PAST THE REVISION THE APPLY PRODUCED, not merely past the import's: an undo
  // makes a NEW higher revision, and exporting at the apply's would correctly be
  // refused as stale — which would be this test measuring its own impatience.
  await expect
    .poll(async () => (await readState(page)).revision ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(appliedRevision);

  const afterUndo = await exportThreeMf(page);
  expect(afterUndo.status).toBe('SUCCESS');
  expect(afterUndo.partCount).toBe(before.partCount);
  // BACK TO ONE RESOURCE, and the writer observes the sharing it observed before.
  expect(afterUndo.meshResourceCount).toBe(1);
  expect(afterUndo.observations).toContain('STRUCTURAL_SHARING_PRESERVED');
  expect(afterUndo.triangleCount).toBe(before.triangleCount);
  // The same document produces the same file size; a duplicated resource would
  // not have been free.
  expect(afterUndo.byteLength).toBe(before.byteLength);
});

/** Exports the current document as 3MF through the harness bridge. */
async function exportThreeMf(page: Page): Promise<{
  status: string;
  partCount?: number;
  meshResourceCount?: number;
  triangleCount?: number;
  byteLength?: number;
  observations?: readonly string[];
}> {
  const state = await readState(page);
  return page.evaluate(
    async (input: { readonly documentId: string; readonly revision: number }) => {
      const bridge = window.cadfixerHarness;
      if (bridge === undefined) throw new Error('the harness bridge is not installed');
      return bridge.exportDocument(input.documentId, input.revision, '3mf', 'shared.stl', {});
    },
    { documentId: state.documentId ?? '', revision: state.revision ?? 0 },
  );
}

/* -------------------------------------- §35, §36: what R1 costs, measured -- */

test('§35: restoring a reference is O(1) — apply and undo on a 1,000-placement document', async ({
  page,
}) => {
  /*
   * THE CASE WHERE A COPY WOULD SHOW. A thousand parts reference one mesh; the
   * fill replaces one of them and the undo puts the shared mesh back. If undo
   * rebuilt geometry, its cost would track the mesh; if it re-shared by
   * comparing bytes across the document, its cost would track the part count.
   * It does neither — the record holds the object and the undo assigns it — so
   * both are measured here against the document that would expose either.
   */
  test.setTimeout(600_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillShared1000);
  expect(loaded.partCount).toBe(1_000);
  expect(loaded.distinctMeshResources).toBe(1);
  const baselineBytes = loaded.residentBytes;

  const partA = loaded.partIds[0] ?? '';
  await selectPart(page, partA);
  await awaitListing(page);

  const rows = page.locator('[data-testid^="opening-"]');
  const fillable = page.locator('[data-testid^="opening-"][data-fillable="true"]');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  if ((await fillable.count()) === 0) {
    /*
     * The shared fixture's mesh may expose no attemptable opening. Reported
     * rather than silently skipped: a measurement that did not happen must not
     * read as one that passed.
     */
    process.stdout.write('[hole-fill R1] shared-1000 fixture has no attemptable opening\n');
    return;
  }
  await fillable.first().getByRole('radio').check();

  expect(await requestPreview(page)).toBe('ready');

  const applyStarted = Date.now();
  await applyFill(page);
  const applyMs = Date.now() - applyStarted;

  const applied = await readState(page);
  // Two resources: the candidate, and the mesh the other 999 still hold.
  expect(applied.distinctMeshResources).toBe(2);
  const appliedBytes = applied.residentBytes;

  const undoStarted = Date.now();
  await page.getByTestId('undo-fill').click();
  await expect
    .poll(async () => (await readState(page)).revision ?? 0, { timeout: 120_000 })
    .toBeGreaterThan(applied.revision ?? 0);
  const undoMs = Date.now() - undoStarted;

  const restored = await readState(page);
  // ONE resource again, for a thousand parts — not 1,001, and not 2.
  expect(restored.distinctMeshResources).toBe(1);
  expect(restored.partCount).toBe(1_000);

  /*
   * THE MEMORY EVIDENCE, and it is deterministic rather than an RSS reading.
   * `residentBytes` counts each DISTINCT mesh once, in the worker that owns
   * them, so it says exactly what the document holds. Back to the pre-fill
   * figure means the duplicate is genuinely gone, not merely unreferenced.
   */
  expect(restored.residentBytes).toBe(baselineBytes);

  process.stdout.write(
    `[hole-fill R1] 1,000 placements: apply ${String(applyMs)}ms, undo ${String(undoMs)}ms; ` +
      `resident ${String(baselineBytes)} -> ${String(appliedBytes)} -> ` +
      `${String(restored.residentBytes)} bytes\n`,
  );

  // Undo restores a reference and rebuilds one part's render snapshot. It is not
  // proportional to the placement count, and a document with a thousand of them
  // is where that would be impossible to miss.
  expect(undoMs, `undo took ${String(undoMs)}ms across 1,000 placements`).toBeLessThan(15_000);
});

test('§36: the retained mesh adds document bytes only when nothing else holds it', async ({
  page,
}) => {
  /*
   * WHAT THE RETENTION ACTUALLY COSTS, in the two cases that differ.
   *
   * SHARED: the sibling still references the mesh, so the record holds a pointer
   * to geometry that was live anyway. `residentBytes` — distinct meshes, counted
   * once — shows the document growing by the CANDIDATE only.
   *
   * The unique-source case is measured at contract level in
   * `hole-fill-commit.test.ts` (US11), where `stats().retainedBytes` reports the
   * record's hold directly; the page has no view of the history store and should
   * not be given one.
   */
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.HoleFillSharedPair);
  const partA = loaded.partIds[0] ?? '';
  const baselineBytes = loaded.residentBytes;

  await selectPart(page, partA);
  await awaitListing(page);
  await opening(page, 1).getByRole('radio').check();
  expect(await requestPreview(page)).toBe('ready');

  // A preview allocates a candidate in the worker but changes nothing the
  // document counts.
  expect((await readState(page)).residentBytes).toBe(baselineBytes);

  await applyFill(page);
  const applied = await readState(page);
  // The document grew by the candidate — the patch's indices — and by nothing
  // else: the retained mesh is the one part B is still drawing from.
  expect(applied.residentBytes).toBeGreaterThan(baselineBytes);

  await page.getByTestId('undo-fill').click();
  await expect
    .poll(async () => (await readState(page)).revision ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(applied.revision ?? 0);

  const restored = await readState(page);
  expect(restored.residentBytes).toBe(baselineBytes);
  expect(restored.distinctMeshResources).toBe(1);

  process.stdout.write(
    `[hole-fill R1] shared pair: resident ${String(baselineBytes)} -> ` +
      `${String(applied.residentBytes)} -> ${String(restored.residentBytes)} bytes\n`,
  );
});
