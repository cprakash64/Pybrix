import { revealControl } from '../e2e/progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readScene, readState } from './harness';

/**
 * CRU11, CRU12: WHAT A REPAIR UNDO LOOKS LIKE FROM OUTSIDE THE WORKER.
 *
 * The contract suite proves the resident document holds the original mesh OBJECT
 * again. Two consequences of that are only observable here, and both are things
 * a user would eventually notice:
 *
 *   - the GPU. `SharedPartGeometry` reference-counts by position-array identity,
 *     so a document that is sharing again while the page holds two equal arrays
 *     uploads a second geometry for a picture it is already drawing;
 *   - the exported file. 3MF encodes structural sharing directly — parts that
 *     share a mesh become one `<object>` resource referenced twice — so an undo
 *     that restored bytes but lost identity would silently double the resources
 *     in every 3MF exported afterwards.
 *
 * WHY THE HARNESS. No shipped importer can produce two parts that SHARE one
 * `CanonicalMesh`, which is exactly the document the defect needed.
 */

async function selectPart(page: Page, partId: string): Promise<void> {
  if ((await readState(page)).activePartId !== partId) {
    await page.getByTestId(`part-option-${partId}`).click();
  }
  await expect.poll(async () => (await readState(page)).activePartId).toBe(partId);
}

/** Waits for the automatic plan, then previews and applies a repair. */
async function repairActivePart(page: Page): Promise<void> {
  await revealControl(page, page.getByTestId('repair-operations'));
  await expect(page.getByTestId('repair-operations')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 60_000 });
  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  await revealControl(page, page.getByTestId('repair-candidate'));
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('apply-repair').click();
  await revealControl(page, page.getByTestId('repair-applied'));
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
}

async function undoRepair(page: Page, pastRevision: number): Promise<void> {
  await page.getByTestId('undo-repair').click();
  await expect
    .poll(async () => (await readState(page)).revision ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(pastRevision);
}

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

test('CRU11: the GPU holds ONE geometry again after a repair undo', async ({ page }) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.RepairSharedPairMillimetre);
  const partA = loaded.partIds[0] ?? '';

  expect(loaded.partCount).toBe(2);
  expect(loaded.distinctMeshResources).toBe(1);
  const baseline = await readScene(page);
  // Two parts, ONE uploaded geometry.
  expect(baseline.modelObjects).toBe(2);
  expect(baseline.sharedGeometries).toBe(1);

  await selectPart(page, partA);
  await repairActivePart(page);

  // The repair genuinely un-shares, so a second geometry is correct here.
  await expect
    .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 60_000 })
    .toBe(2);
  const applied = await readState(page);

  await undoRepair(page, applied.revision ?? 0);

  // AND BACK TO ONE. Both parts draw from the same buffer again.
  await expect
    .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 60_000 })
    .toBe(1);
  const after = await readScene(page);
  expect(after.modelObjects).toBe(2);

  /*
   * NO PREMATURE AND NO DOUBLE DISPOSAL. Every geometry created has either been
   * released or is still drawn, so the two counters differ by exactly what is on
   * screen. A double dispose would push disposals past creations; a leak would
   * leave the difference above the live count.
   */
  expect(after.geometriesCreated - after.geometriesDisposed).toBe(after.sharedGeometries);
  expect(after.geometriesDisposed).toBeLessThanOrEqual(after.geometriesCreated);

  // And the document is no larger than before any of it happened.
  const restored = await readState(page);
  expect(restored.distinctMeshResources).toBe(1);
  expect(restored.residentBytes).toBe(loaded.residentBytes);
});

test('CRU12: a 3MF after a repair undo has the SAME object resources as before', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.RepairSharedPairMillimetre);
  const partA = loaded.partIds[0] ?? '';

  const before = await exportThreeMf(page);
  expect(before.status).toBe('SUCCESS');
  expect(before.partCount).toBe(2);
  // ONE resource for two placements, and the writer says so by name.
  expect(before.meshResourceCount).toBe(1);
  expect(before.observations).toContain('STRUCTURAL_SHARING_PRESERVED');

  await selectPart(page, partA);
  await repairActivePart(page);

  const appliedRevision = (await readState(page)).revision ?? 0;
  const afterApply = await exportThreeMf(page);
  expect(afterApply.status).toBe('SUCCESS');
  // The repair changed one part, so two resources is the truthful answer.
  expect(afterApply.meshResourceCount).toBe(2);

  await undoRepair(page, appliedRevision);

  const afterUndo = await exportThreeMf(page);
  expect(afterUndo.status).toBe('SUCCESS');
  expect(afterUndo.partCount).toBe(before.partCount);
  // BACK TO ONE RESOURCE, with the same triangle count and the same file size:
  // a duplicated resource would not have been free.
  expect(afterUndo.meshResourceCount).toBe(1);
  expect(afterUndo.observations).toContain('STRUCTURAL_SHARING_PRESERVED');
  expect(afterUndo.triangleCount).toBe(before.triangleCount);
  expect(afterUndo.byteLength).toBe(before.byteLength);
});

test('a repair undo restores every part byte for byte, and the sibling never moves', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.RepairSharedPairMillimetre);
  const partA = loaded.partIds[0] ?? '';
  const partB = loaded.partIds[1] ?? '';
  const before = await digest(page, loaded);

  await selectPart(page, partA);
  await repairActivePart(page);

  const applied = await readState(page);
  const appliedDigest = await digest(page, applied);
  const digestBBefore = before.parts.find((part) => part.partId === partB);
  const digestBApplied = appliedDigest.parts.find((part) => part.partId === partB);
  // The repair touched A and nothing else.
  expect(digestBApplied?.positionDigest).toBe(digestBBefore?.positionDigest);
  expect(digestBApplied?.indexDigest).toBe(digestBBefore?.indexDigest);
  expect(appliedDigest.distinctMeshes).toBe(2);

  await undoRepair(page, applied.revision ?? 0);

  const restored = await digest(page, await readState(page));
  for (const part of restored.parts) {
    const original = before.parts.find((entry) => entry.partId === part.partId);
    expect(part.positionDigest, `${part.partId} positions`).toBe(original?.positionDigest);
    expect(part.indexDigest, `${part.partId} indices`).toBe(original?.indexDigest);
    expect(part.positionBytes, `${part.partId} position bytes`).toBe(original?.positionBytes);
    expect(part.indexBytes, `${part.partId} index bytes`).toBe(original?.indexBytes);
    expect(part.transform, `${part.partId} placement`).toEqual(original?.transform);
  }
  // ONE mesh again, observed through the resource index every part reports.
  expect(restored.distinctMeshes).toBe(1);
  expect(restored.parts[0]?.meshResourceIndex).toBe(restored.parts[1]?.meshResourceIndex);
});

/**
 * CRT/§43, §44: WHAT A REPAIR AND AN UNDO COST AT A THOUSAND PLACEMENTS.
 *
 * Retaining the pre-repair MESH rather than a patch of removed triangles is the
 * whole Stage 4B-1C change, and the obvious question about it is what the
 * retention costs. At a thousand placements the answer is visible rather than
 * argued: the document holds ONE mesh, a repair of one placement adds exactly
 * one more, and the record retains the object the other nine hundred and
 * ninety-nine are still drawing from — so it costs nothing that was not already
 * resident. An undo hands that object back and the document is the size it was.
 *
 * The failure this rules out is the one that would not show up at two parts: a
 * thousand-and-one meshes, or a retained copy that outlives the undo.
 */
test('§43/§44: a repair and an undo at 1,000 placements return the document to its size', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.RepairShared1000Millimetre);
  expect(loaded.partCount).toBe(1_000);
  // A THOUSAND PLACEMENTS, ONE MESH — before anything happens.
  expect(loaded.distinctMeshResources).toBe(1);
  const baseline = await readScene(page);
  expect(baseline.sharedGeometries).toBe(1);

  await selectPart(page, loaded.partIds[0] ?? '');
  const startedAt = Date.now();
  await repairActivePart(page);
  const applyMs = Date.now() - startedAt;

  const applied = await readState(page);
  // EXACTLY ONE MORE. The repaired placement left the shared mesh; the other 999
  // did not follow it, and no copy was made for the undo record either.
  expect(applied.distinctMeshResources).toBe(2);
  await expect
    .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 120_000 })
    .toBe(2);

  const undoStartedAt = Date.now();
  await undoRepair(page, applied.revision ?? 0);
  const undoMs = Date.now() - undoStartedAt;

  const restored = await readState(page);
  // BACK TO ONE MESH AND THE ORIGINAL SIZE. Not "about the same": the same
  // number, because the object that came back is the object that left.
  expect(restored.partCount).toBe(1_000);
  expect(restored.distinctMeshResources).toBe(1);
  expect(restored.residentBytes).toBe(loaded.residentBytes);

  // AND THE SECOND GPU GEOMETRY IS RELEASED, not merely unreferenced: creations
  // minus disposals is what is still on screen.
  await expect
    .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 120_000 })
    .toBe(1);
  const after = await readScene(page);
  expect(after.geometriesCreated - after.geometriesDisposed).toBe(after.sharedGeometries);
  expect(after.modelObjects).toBe(1_000);

  /*
   * REPORTED, NEVER ASSERTED. A wall-clock number measured beside a thousand
   * placements on whatever machine happens to be running is evidence for a
   * report and would be a flake as a threshold.
   */
  test.info().annotations.push({
    type: 'measurement',
    description: `1,000 placements — apply ${String(applyMs)} ms, undo ${String(undoMs)} ms, resident ${String(loaded.residentBytes)} bytes`,
  });
});

/**
 * CRP19, CRP20, CRP22: REPRESENTATION AND SHARING, ASKED OF THE SAME APPLY.
 *
 * Stage 4B-1D made the repaired candidate keep the source's indexed structure.
 * That raises a question the contract suite cannot answer on its own: a shared
 * mesh, a real worker, a real render pipeline, and one part repaired — does the
 * candidate stay compact, does the sibling stay exactly where it was, and does
 * undo still put them back on one object?
 *
 * WHY THE HARNESS. No shipped importer can produce two parts that SHARE one
 * `CanonicalMesh`, and the shared mesh is the whole point: `withPartRender`
 * reuses a sibling's buffers when the worker says the parts share, and that path
 * now carries EXPANDED render buffers over an INDEXED canonical mesh — two
 * different sizes for the same part, which is exactly where a wrong assumption
 * would show.
 */
test('CRP19, CRP20: repairing a shared indexed mesh keeps the candidate indexed', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openHarness(page);
  const loaded = await loadFixture(page, Fixture.RepairSharedIndexedPairMillimetre);
  const partA = loaded.partIds[0] ?? '';
  const partB = loaded.partIds[1] ?? '';

  expect(loaded.partCount).toBe(2);
  expect(loaded.distinctMeshResources).toBe(1);
  const before = await digest(page, loaded);
  const sourceA = before.parts.find((part) => part.partId === partA);
  // FOUR VERTICES, FIVE FACES: 48 bytes of positions and 60 of indices.
  expect(sourceA?.positionBytes).toBe(48);
  expect(sourceA?.indexBytes).toBe(60);

  await selectPart(page, partA);
  await repairActivePart(page);

  const applied = await readState(page);
  const appliedDigest = await digest(page, applied);
  const repairedA = appliedDigest.parts.find((part) => part.partId === partA);
  const siblingB = appliedDigest.parts.find((part) => part.partId === partB);

  /*
   * CRP20. THE CANDIDATE IS STILL INDEXED — the assertion this whole stage is
   * for. One face gone, so the index buffer drops by twelve bytes; the POSITION
   * buffer does not move at all, because every one of the four corners is still
   * used by a surviving face.
   *
   * Under the soup rebuild this read 144 bytes of positions — twelve vertices
   * for four faces — and the document grew because one duplicate triangle was
   * deleted.
   */
  expect(repairedA?.positionBytes).toBe(48);
  expect(repairedA?.indexBytes).toBe(48);

  // CRP19. THE SIBLING WAS NOT TOUCHED, byte for byte and placement included.
  expect(siblingB?.positionDigest).toBe(sourceA?.positionDigest);
  expect(siblingB?.indexDigest).toBe(sourceA?.indexDigest);
  expect(siblingB?.transform).toEqual(
    before.parts.find((part) => part.partId === partB)?.transform,
  );
  // The repair genuinely un-shared, which is what isolating part A means.
  expect(appliedDigest.distinctMeshes).toBe(2);

  /*
   * AND WHAT THE DOCUMENT GREW BY IS EXACTLY THE CANDIDATE.
   *
   * Repairing one part of a shared pair necessarily un-shares it, so the
   * document goes from holding one mesh (108 bytes, counted once however many
   * parts reference it) to holding two: the sibling's original 108 plus the
   * candidate's 96. That growth is the isolation, not waste.
   *
   * THE NUMBER IS THE POINT. Under the soup rebuild the candidate was 144 bytes
   * of positions plus 48 of indices, so the document went to 300 — and a repair
   * that DELETED a triangle made the model bigger than it started.
   */
  expect(applied.residentBytes).toBe(loaded.residentBytes + 96);
  expect(applied.residentBytes).toBeLessThan(300);

  /*
   * THE GPU FOLLOWED THE UN-SHARING: two geometries where there was one, and one
   * object per part throughout.
   *
   * NOT A TRIANGLE COUNT. `renderedTriangles` reports what survived FRUSTUM
   * CULLING, and applying a repair reframes the camera, so on a two-part
   * document a sibling can legitimately leave the count. That the expanded
   * snapshot draws every face of an indexed mesh is asserted where it is
   * unambiguous — the single-part browser gate in `e2e/conservative-repair.spec.ts`.
   */
  await expect
    .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 60_000 })
    .toBe(2);
  expect((await readScene(page)).modelObjects).toBe(2);

  await undoRepair(page, applied.revision ?? 0);

  // CRP22. BACK TO ONE MESH, and to the exact bytes.
  const restored = await digest(page, await readState(page));
  expect(restored.distinctMeshes).toBe(1);
  for (const part of restored.parts) {
    const original = before.parts.find((entry) => entry.partId === part.partId);
    expect(part.positionDigest, `${part.partId} positions`).toBe(original?.positionDigest);
    expect(part.indexDigest, `${part.partId} indices`).toBe(original?.indexDigest);
  }
  expect((await readState(page)).residentBytes).toBe(loaded.residentBytes);
  // ONE GPU GEOMETRY AGAIN, and every geometry created has been released or is
  // still drawn.
  await expect
    .poll(async () => (await readScene(page)).sharedGeometries, { timeout: 60_000 })
    .toBe(1);
  const scene = await readScene(page);
  expect(scene.geometriesCreated - scene.geometriesDisposed).toBe(scene.sharedGeometries);
});
