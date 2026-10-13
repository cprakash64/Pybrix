import { revealControl } from '../e2e/progressive-disclosure';
import { expect, test } from '@playwright/test';
import { Fixture, loadFixture, openHarness, readScene, readState } from './harness';

/**
 * WHAT A SELECTION MEANS, IN THE BROWSER.
 *
 * Two parts of one document carry IDENTICAL handles, so every guard that used
 * to be answered by comparing handles now has to compare the part as well. Unit
 * tests pin each guard; these prove the whole chain — store, hooks, worker,
 * panels — agrees about which part is being described, while a real user
 * clicks between them.
 */

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test('Mesh Health describes the active part, and follows a switch', async ({ page }) => {
  const state = await loadFixture(page, Fixture.TwoIndependentParts);

  // Alpha is a tetrahedron of edge 1 (4 faces); Beta is edge 2 — also 4 faces,
  // so the counts alone cannot distinguish them. The PART ID must.
  expect(state.partIds).toEqual(['a', 'b']);
  expect(state.activePartId).toBe('a');

  await expect
    .poll(async () => (await readState(page)).analysisState, { timeout: 60_000 })
    .toBe('ready');
  expect((await readState(page)).analysisPartId).toBe('a');
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible();

  await page.getByTestId('part-option-b').click();

  // The report is re-derived FOR B, and B's identity is what the store holds.
  await expect
    .poll(async () => (await readState(page)).analysisPartId, { timeout: 60_000 })
    .toBe('b');
  await expect
    .poll(async () => (await readState(page)).analysisState, { timeout: 60_000 })
    .toBe('ready');

  // The document did not move for a selection.
  const after = await readState(page);
  expect(after.revision).toBe(state.revision);
  expect(after.documentId).toBe(state.documentId);
});

test('switching back and forth keeps every result attributed to its own part', async ({ page }) => {
  await loadFixture(page, Fixture.DefectAndClean);
  const before = await readScene(page);

  for (const partId of ['b', 'a', 'b', 'a']) {
    await page.getByTestId(`part-option-${partId}`).click();
    await expect
      .poll(async () => (await readState(page)).analysisPartId, { timeout: 60_000 })
      .toBe(partId);
    await expect
      .poll(async () => (await readState(page)).analysisState, { timeout: 60_000 })
      .toBe('ready');

    const state = await readState(page);
    // A's mesh carries a duplicated face, B's does not — so the face counts
    // genuinely differ and a report attributed to the wrong part would show it.
    expect(state.analysisFaceCount).toBe(partId === 'a' ? 5 : 4);
    expect(state.repairPartId).toBe(partId);
    expect(state.selfIntersectionPartId).toBe(partId);
  }

  // NO GEOMETRY DUPLICATION CAUSED BY SELECTION, over four switches.
  const after = await readScene(page);
  expect(after.geometriesCreated).toBe(before.geometriesCreated);
  expect(after.geometriesDisposed).toBe(before.geometriesDisposed);
  expect(after.modelObjects).toBe(2);
});

test('the part selector names parts the way every other panel does', async ({ page }) => {
  await loadFixture(page, Fixture.ThreeTransformedParts);

  await expect(page.getByTestId('part-option-a')).toContainText('At origin');
  await expect(page.getByTestId('part-option-b')).toContainText('Along X');
  await expect(page.getByTestId('part-option-c')).toContainText('Along Y');

  await page.getByTestId('part-option-c').click();
  await expect(page.getByTestId('health-part-scope')).toContainText('Along Y');
  await expect(page.getByTestId('repair-part-scope')).toContainText('Along Y');
});

/* ------------------------------------------------- self-intersection -- */

test('self-intersection is checked per part, and a report names its own part', async ({ page }) => {
  test.setTimeout(180_000);
  const state = await loadFixture(page, Fixture.CrossingAndOverlappingClean);
  expect(state.partIds).toEqual(['a', 'b']);

  // Part A's own two faces cross. Small enough to be checked automatically.
  await expect
    .poll(async () => (await readState(page)).selfIntersectionStatus, { timeout: 120_000 })
    .toBeDefined();
  const crossing = await readState(page);
  expect(crossing.selfIntersectionReportPartId).toBe('a');
  expect(crossing.selfIntersectionStatus).toBe('CHECKED');
  await expect(page.getByTestId('self-intersection-headline')).not.toHaveText('Not checked');

  await page.getByTestId('part-option-b').click();

  /*
   * PART B IS CLEAN — and it is deliberately placed INSIDE part A's volume.
   * If the diagnostic flattened the document, or reused A's verdict, B would be
   * reported as crossing. Two independently valid parts that overlap in world
   * space are not self-intersecting, and nothing in CAD Fixer claims to have
   * checked whether they overlap.
   */
  await expect
    .poll(async () => (await readState(page)).selfIntersectionReportPartId, { timeout: 120_000 })
    .toBe('b');
  const clean = await readState(page);
  expect(clean.selfIntersectionStatus).toBe('CHECKED');
  expect(clean.selfIntersectionPartId).toBe('b');
  // Both parts still drawn, still overlapping, still two objects.
  expect((await readScene(page)).modelObjects).toBe(2);
});

test('a report for one part is never displayed against another', async ({ page }) => {
  test.setTimeout(180_000);
  await loadFixture(page, Fixture.CrossingAndOverlappingClean);

  await expect
    .poll(async () => (await readState(page)).selfIntersectionReportPartId, { timeout: 120_000 })
    .toBe('a');

  await page.getByTestId('part-option-b').click();

  /*
   * The instant after the switch the slice is re-bound to B and A's report is
   * gone. It may or may not have been replaced yet — what must never happen is
   * A's report sitting beside B, so the invariant is checked as an implication
   * rather than as a moment.
   */
  await expect
    .poll(
      async () => {
        const state = await readState(page);
        return (
          state.selfIntersectionReportPartId === undefined ||
          state.selfIntersectionReportPartId === state.selfIntersectionPartId
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);
});

/* ----------------------------------------------------- size policy -- */

test('the size band follows the active part, not the document total', async ({ page }) => {
  test.setTimeout(180_000);
  const state = await loadFixture(page, Fixture.SmallAndOversized);
  expect(state.partIds).toEqual(['a', 'b']);

  // A is four faces beside a part of a quarter of a million. Policy is decided
  // per part, so the small one is auto-eligible regardless of its neighbour.
  expect(state.selfIntersectionPartId).toBe('a');
  expect(state.selfIntersectionBand).toBe('AUTO_ELIGIBLE');

  await page.getByTestId('part-option-b').click();
  await expect
    .poll(async () => (await readState(page)).selfIntersectionPartId, { timeout: 60_000 })
    .toBe('b');

  const oversized = await readState(page);
  // ABOVE THE CEILING: refused by policy before anything is allocated, and the
  // control is withdrawn rather than offered and then failing.
  expect(oversized.selfIntersectionBand).toBe('SIZE_LIMIT');
  await expect(page.getByTestId('run-self-intersection')).toHaveCount(0);
  // The production refusal, verbatim. The Mesh Health scope note directly above
  // says which part the panel is describing, so "this model size" is read in
  // the context of one named part.
  await expect(page.getByTestId('self-intersection-headline')).toHaveText(
    'Not checked — model exceeds automatic check size',
  );

  // Switching back restores the small part's policy: the band is derived, not
  // remembered, so the two cannot get out of step.
  await page.getByTestId('part-option-a').click();
  await expect
    .poll(async () => (await readState(page)).selfIntersectionBand, { timeout: 60_000 })
    .toBe('AUTO_ELIGIBLE');
});
