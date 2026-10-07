import { expect, test, type Download, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';
import { isAppOrigin } from './app-origin';
import {
  objMultiPart,
  objTriangle,
  objWithRemoteMtllib,
  threeMf,
  threeMfHostileName,
  threeMfLarge,
  threeMfSharedPlacements,
  threeMfTwoParts,
  threeMfWithTexture,
  threeMfWithMaterial,
  threeMfAwkwardName,
  modelXml,
  tetrahedronMesh,
} from './format-fixtures';
import { readObjArtifact, readStlArtifact, readThreeMfArtifact } from './artifact-oracles';
import { openInspector } from './inspector';

/**
 * STAGE 4A-2B3 — THE FORMAT CONVERSION WORKFLOW, END TO END.
 *
 * WHAT THESE PROVE THAT NOTHING ELSE CAN. The compatibility policy is a pure
 * function and is tested exhaustively in `compatibility.test.ts`; the writers
 * are tested against parse-back in their own suites. What only a real browser
 * can establish is that the whole path holds together: a user opens a file,
 * chooses a format, reads what it will keep, states a unit if one is needed,
 * presses a button, and the BROWSER hands them a file that CAD Fixer can open
 * again.
 *
 * EVERY DOWNLOAD IS REAL. Playwright captures the actual browser download,
 * these tests read its bytes, and several then feed those bytes back through
 * the production import path. Stopping at "a Blob was created" would prove
 * nothing about what lands on a user's disk.
 */

/* ---------------------------------------------------------------- helpers -- */

interface Fixture {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

async function importFile(page: Page, fixture: Fixture): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles(fixture);
  await expect(page.getByTestId('fact-triangles')).toBeAttached({ timeout: 30_000 });
}

async function openConvert(page: Page): Promise<void> {
  await openInspector(page);
  await page.getByTestId('open-convert').click();
  await expect(page.getByTestId('convert-workspace')).toBeVisible();
}

async function chooseUnit(page: Page, unit: string): Promise<void> {
  await page.getByTestId(`convert-unit-${unit}`).check();
}

/** No unit is chosen: none of the six is checked, and nothing is preselected. */
async function expectNoUnitChosen(page: Page): Promise<void> {
  await expect(page.getByTestId('convert-unit').locator('input:checked')).toHaveCount(0);
}

async function chooseTarget(page: Page, target: 'stl' | 'obj' | '3mf'): Promise<void> {
  await page.getByTestId(`convert-target-${target}`).check();
  await expect(page.getByTestId('convert-report')).toBeVisible();
}

async function bytesOf(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Presses Export and returns the file the browser actually saved. */
async function exportAndCapture(page: Page): Promise<{ download: Download; bytes: Buffer }> {
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId('convert-export').click();
  const download = await pending;
  await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 60_000 });
  return { download, bytes: await bytesOf(download) };
}

/** Re-imports a downloaded artifact through the REAL production import path. */
async function reimport(page: Page, name: string, bytes: Buffer): Promise<void> {
  await importFile(page, { name, mimeType: 'application/octet-stream', buffer: bytes });
}

const STL_TRIANGLES = 60;

/**
 * Big enough that writing, compressing and reading it back is measurable work.
 *
 * The same 60,000 the import suite uses, so the two proofs are talking about a
 * comparable model rather than each choosing its own idea of "large".
 */
const LARGE_TRIANGLES = 60_000;

const FIXTURES = {
  stl: (): Fixture => ({
    name: 'bracket.stl',
    mimeType: 'model/stl',
    buffer: binaryStl(STL_TRIANGLES).bytes,
  }),
  objSingle: (): Fixture => ({
    name: 'single.obj',
    mimeType: 'model/obj',
    buffer: objTriangle().bytes,
  }),
  objMulti: (): Fixture => ({
    name: 'assembly.obj',
    mimeType: 'model/obj',
    buffer: objMultiPart(3).bytes,
  }),
  threeMfSimple: (): Fixture => ({
    name: 'simple.3mf',
    mimeType: 'model/3mf',
    buffer: threeMf(),
  }),
  threeMfTwo: (): Fixture => ({
    name: 'twoparts.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfTwoParts(),
  }),
  threeMfShared: (count: number): Fixture => ({
    name: 'shared.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfSharedPlacements(count),
  }),
  threeMfInches: (): Fixture => ({
    name: 'inches.3mf',
    mimeType: 'model/3mf',
    buffer: threeMf(modelXml({ unit: 'inch' })),
  }),
} as const;

/* ------------------------------------------------ the workflow is reachable -- */

test('Convert is a real workflow with one primary entry point', async ({ page }) => {
  await page.goto('/');

  /*
   * ENTERABLE BEFORE A MODEL IS OPEN, AND GUARDED INSIDE (UI-07A). Stage 4A-2B3
   * drew Convert disabled with "Open a model first"; navigation now says only
   * which workspaces exist, and the workspace says what it needs while its
   * Export stays disabled until there is something to write.
   */
  await expect(page.getByTestId('workflow-convert')).toBeEnabled();
  await expect(page.getByTestId('workflow-convert')).not.toContainText('Open a model first');
  await page.getByTestId('workflow-convert').click();
  await expect(page.getByTestId('workspace-empty')).toContainText(
    'Open a 3D model to convert or export it.',
  );
  await expect(page.getByTestId('convert-export')).toBeDisabled();

  await importFile(page, FIXTURES.stl());
  await expect(page.getByTestId('workspace-empty')).toHaveCount(0);
  await page.getByTestId('workflow-repair').click();

  // And it opens the same workspace the Model panel's primary action opens.
  await page.getByTestId('workflow-convert').click();
  await expect(page.getByTestId('convert-workspace')).toBeVisible();
});

test('the two export actions are named apart', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.stl());

  /*
   * THE AMBIGUITY THIS STAGE REMOVED. Two controls both called "Export STL",
   * one writing the document and one writing a third of it, is exactly the
   * silent loss the workflow exists to prevent.
   */
  // UI-06 moved the exports out of the Model facts into the inspector's own
  // Export section, whose region is "Model export".
  await openInspector(page);
  const panel = page.getByRole('region', { name: 'Model export' });
  await expect(panel.getByTestId('open-convert')).toHaveText('Export / Convert…');
  await expect(panel.getByTestId('export-binary')).toHaveText('Export active part as binary STL');
  await expect(panel.getByTestId('export-ascii')).toHaveText('Export active part as ASCII STL');

  // And the product no longer claims it can only write STL.
  await expect(panel).toContainText('reads STL, OBJ and 3MF, and writes all three');
});

/* ----------------------------------------------------------------- CF03/CF04 -- */

test('STL → 3MF: blocked until the user states a unit, then written and re-openable', async ({
  page,
}) => {
  await page.goto('/');
  await importFile(page, FIXTURES.stl());
  await openConvert(page);
  await chooseTarget(page, '3mf');

  // 4. The report says a unit is required.
  await expect(page.getByTestId('convert-verdict')).toHaveAttribute('data-verdict', 'BLOCKED');
  await expect(page.getByTestId('convert-blockers')).toContainText(
    'records what the measurements mean',
  );

  // 5. With no unit chosen, nothing can be exported.
  await expectNoUnitChosen(page);
  await expect(page.getByTestId('convert-export')).toBeDisabled();

  // 6/7. Choosing millimetres explains that nothing is resized.
  await expect(page.getByTestId('convert-unit')).toContainText('does not resize anything');
  await chooseUnit(page, 'millimeter');
  await expect(page.getByTestId('convert-export')).toBeEnabled();

  // 8/9/10. Validated export, then a real browser download.
  const { download, bytes } = await exportAndCapture(page);
  expect(download.suggestedFilename()).toBe('bracket.3mf');

  // 11/12/13. The artifact states millimetres and holds the same triangles.
  const artifact = readThreeMfArtifact(bytes);
  expect(artifact.unit).toBe('millimeter');
  expect(artifact.entryNames).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
  expect(artifact.objects).toHaveLength(1);
  expect(artifact.objects[0]?.triangleCount).toBe(STL_TRIANGLES);
  // A file our own reader would refuse is a file the user cannot open.
  expect(artifact.modelXml).not.toContain('<!DOCTYPE');
  expect(artifact.modelXml).not.toContain('<!ENTITY');

  // 14/15. THE MODEL IS UNCHANGED: the file still states no unit — the panel
  // shows only the user's own reading, labelled as theirs — and the export did
  // not consume a revision.
  await expect(page.getByTestId('fact-units')).toHaveText('Millimetres (your choice)');

  // And the artifact really does re-open, through the production import path.
  await reimport(page, 'roundtrip.3mf', bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText(STL_TRIANGLES.toLocaleString());
  await expect(page.getByTestId('fact-format')).toHaveText('3MF');
  await expect(page.getByTestId('fact-units')).toHaveText('millimeter');
});

/* ----------------------------------------------------------------- CF01/CF02 -- */

test('STL → STL writes the whole document and re-opens unchanged', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.stl());
  await openConvert(page);
  await chooseTarget(page, 'stl');

  await expect(page.getByTestId('convert-verdict')).toHaveAttribute(
    'data-verdict',
    'LOSSLESS_FOR_SUPPORTED_FEATURES',
  );
  await expect(page.getByTestId('convert-lossless')).toBeVisible();

  const { download, bytes } = await exportAndCapture(page);
  expect(download.suggestedFilename()).toBe('bracket.stl');

  const artifact = readStlArtifact(bytes);
  expect(artifact.declaredTriangles).toBe(STL_TRIANGLES);
  expect(artifact.byteLength).toBe(84 + STL_TRIANGLES * 50);
  // No user text in the fixed header.
  expect(artifact.header).toBe('Pybrix binary STL');
});

test('STL → OBJ states the generated name as an addition, not a loss', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.stl());
  await openConvert(page);
  await chooseTarget(page, 'obj');

  /*
   * `o part-1` IS SOMETHING THE FILE SAYS AND THE MODEL DOES NOT — an addition,
   * not a loss — so the verdict stays clear and the fact appears under what the
   * file will state.
   */
  await expect(page.getByTestId('convert-verdict')).toHaveAttribute(
    'data-verdict',
    'LOSSLESS_FOR_SUPPORTED_FEATURES',
  );
  await expect(page.getByTestId('convert-assumptions')).toContainText('generated one');

  const { download, bytes } = await exportAndCapture(page);
  expect(download.suggestedFilename()).toBe('bracket.obj');

  const artifact = readObjArtifact(bytes);
  expect(artifact.faceCount).toBe(STL_TRIANGLES);
  expect(artifact.objects).toEqual(['part-1']);
  // NO `mtllib` IS EMITTED, because naming a file we do not write would point
  // the reader at something that does not exist.
  expect(artifact.hasMtllib).toBe(false);
});

/* ----------------------------------------------------------------- CF07/CF08 -- */

test('OBJ → 3MF: multiple objects become multiple parts, with an asserted unit', async ({
  page,
}) => {
  await page.goto('/');
  await importFile(page, FIXTURES.objMulti());
  await expect(page.getByTestId('fact-parts')).toHaveText('3');

  await openConvert(page);
  await chooseTarget(page, '3mf');

  // CF07: an OBJ states no unit, so 3MF is blocked.
  await expect(page.getByTestId('convert-verdict')).toHaveAttribute('data-verdict', 'BLOCKED');
  await expect(page.getByTestId('convert-export')).toBeDisabled();

  // CF08: an explicit inch assertion unblocks it.
  await chooseUnit(page, 'inch');
  await expect(page.getByTestId('convert-export')).toBeEnabled();

  const { download, bytes } = await exportAndCapture(page);
  expect(download.suggestedFilename()).toBe('assembly.3mf');

  const artifact = readThreeMfArtifact(bytes);
  expect(artifact.unit).toBe('inch');
  // Three objects, three build items, and the names survived.
  expect(artifact.objects).toHaveLength(3);
  expect(artifact.items).toHaveLength(3);
  expect(artifact.objects.map((object) => object.name)).toEqual(['Part 1', 'Part 2', 'Part 3']);

  await reimport(page, 'assembly-roundtrip.3mf', bytes);
  await expect(page.getByTestId('fact-parts')).toHaveText('3');
  await expect(page.getByTestId('fact-units')).toHaveText('inch');
  await expect(page.getByTestId('fact-triangles')).toHaveText('12');
});

/* ------------------------------------------------------------------ CF10/CF11 -- */

test('3MF → OBJ states the unit loss and the baked placements before writing', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.threeMfTwo());
  await expect(page.getByTestId('fact-units')).toHaveText('millimeter');

  await openConvert(page);
  await chooseTarget(page, 'obj');

  // The unit is not representable, and the sentence says both halves.
  const metadata = page.getByTestId('convert-metadata');
  await expect(metadata).toContainText('stores no unit');
  await expect(metadata).toContainText('written unchanged');
  await expect(metadata).toContainText('nothing is resized');

  // The placements are baked.
  await expect(page.getByTestId('convert-transformations')).toContainText(
    'applied to the coordinates',
  );
  // The parts themselves survive, so this is not structural loss.
  await expect(page.getByTestId('convert-preserved')).toContainText('separate objects');

  const { download, bytes } = await exportAndCapture(page);
  expect(download.suggestedFilename()).toBe('twoparts.obj');

  const artifact = readObjArtifact(bytes);
  expect(artifact.objects).toEqual(['Left', 'Right']);
  expect(artifact.faceCount).toBe(8);

  /*
   * THE SECOND PART'S PLACEMENT IS IN THE COORDINATES. Its build item carried a
   * translation of 40 in X, and OBJ has no structural transform — so the world
   * position has to be in the vertex records or it is gone.
   */
  const xs = artifact.vertices.map((vertex) => vertex[0]);
  expect(Math.max(...xs)).toBeGreaterThanOrEqual(40);

  await reimport(page, 'twoparts-roundtrip.obj', bytes);
  await expect(page.getByTestId('fact-parts')).toHaveText('2');
  // OBJ STATES NO UNIT, so the re-import knows none. Nothing was rescaled to
  // hide that.
  await expect(page.getByTestId('fact-units')).toHaveText('Unspecified');
});

/* ------------------------------------------------------------------ CF12 -- */

test('3MF → STL flattens the parts and says so before writing', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.threeMfTwo());

  await openConvert(page);
  await chooseTarget(page, 'stl');

  await expect(page.getByTestId('convert-verdict')).toHaveAttribute(
    'data-verdict',
    'LOSSY_STRUCTURE',
  );
  await expect(page.getByTestId('convert-structure')).toContainText('merged into one mesh');
  await expect(page.getByTestId('convert-metadata')).toContainText('stores no unit');
  await expect(page.getByTestId('convert-metadata')).toContainText('nowhere to put a name');
  await expect(page.getByTestId('convert-transformations')).toContainText(
    'applied to the coordinates',
  );

  const { download, bytes } = await exportAndCapture(page);
  expect(download.suggestedFilename()).toBe('twoparts.stl');

  const artifact = readStlArtifact(bytes);
  // BOTH PARTS ARE IN THE FILE. Eight triangles, not four.
  expect(artifact.declaredTriangles).toBe(8);
  // And the second part's translation was baked.
  const xs = artifact.corners.filter((_value, index) => index % 3 === 0);
  expect(Math.max(...xs)).toBeGreaterThanOrEqual(40);

  await reimport(page, 'twoparts-roundtrip.stl', bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('8');
  await expect(page.getByTestId('fact-units')).toHaveText('Unspecified by STL');
  // ONE PART, because STL holds one object.
  await expect(page.getByTestId('fact-parts')).toHaveCount(0);
});

/* ------------------------------------------------------------------ CF09 -- */

test('3MF → 3MF is lossless, and is not decorated with warnings for being 3MF', async ({
  page,
}) => {
  await page.goto('/');
  await importFile(page, FIXTURES.threeMfSimple());

  await openConvert(page);
  // The source format is preselected, so this is the state the workspace opens in.
  await expect(page.getByTestId('convert-target-3mf')).toBeChecked();

  await expect(page.getByTestId('convert-verdict')).toHaveAttribute(
    'data-verdict',
    'LOSSLESS_FOR_SUPPORTED_FEATURES',
  );
  await expect(page.getByTestId('convert-lossless')).toBeVisible();
  await expect(page.getByTestId('convert-structure')).toHaveCount(0);
  await expect(page.getByTestId('convert-metadata')).toHaveCount(0);
  await expect(page.getByTestId('convert-blockers')).toHaveCount(0);
  // A known unit needs no assertion, so the question is not asked.
  await expect(page.getByTestId('convert-unit')).toHaveCount(0);

  const { bytes } = await exportAndCapture(page);
  const artifact = readThreeMfArtifact(bytes);
  expect(artifact.unit).toBe('millimeter');
  expect(artifact.objects[0]?.name).toBe('Solid');

  await reimport(page, 'simple-roundtrip.3mf', bytes);
  await expect(page.getByTestId('fact-units')).toHaveText('millimeter');
});

/* ------------------------------------------------------------------ CF37 -- */

test('shared placements stay shared in 3MF and are expanded for STL and OBJ', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.threeMfShared(20));
  await expect(page.getByTestId('fact-parts')).toHaveText('20');

  await openConvert(page);

  // 3MF keeps one copy of the geometry and twenty placements.
  await chooseTarget(page, '3mf');
  await expect(page.getByTestId('convert-preserved')).toContainText(
    'reuse one copy of the geometry',
  );
  const shared = await exportAndCapture(page);
  const sharedArtifact = readThreeMfArtifact(shared.bytes);
  expect(sharedArtifact.objects).toHaveLength(1);
  expect(sharedArtifact.items).toHaveLength(20);

  // STL and OBJ have no instancing, and the panel says so rather than hiding it.
  await chooseTarget(page, 'stl');
  await expect(page.getByTestId('convert-structure')).toContainText('written out in full');
  const flattened = await exportAndCapture(page);
  expect(readStlArtifact(flattened.bytes).declaredTriangles).toBe(80);

  await chooseTarget(page, 'obj');
  await expect(page.getByTestId('convert-structure')).toContainText('written out in full');
  const expanded = await exportAndCapture(page);
  expect(readObjArtifact(expanded.bytes).faceCount).toBe(80);
});

/* ------------------------------------------------------------------ CF13/CF36 -- */

test('a source import loss survives, and does not move when the target changes', async ({
  page,
}) => {
  await page.goto('/');
  await importFile(page, {
    name: 'textured.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfWithTexture(),
  });

  await openConvert(page);

  for (const target of ['3mf', 'obj', 'stl'] as const) {
    await chooseTarget(page, target);
    /*
     * SHOWN SEPARATELY FROM THE TARGET'S LOSSES. The texture went when the file
     * was OPENED; implying the chosen format caused it would be blaming the
     * wrong thing, and it must not disappear because the user picked a format
     * that would have kept textures if we wrote them.
     */
    await expect(page.getByTestId('convert-source-warnings')).toContainText(
      'texture information that Pybrix did not import',
    );
    await expect(page.getByTestId('convert-source-warnings')).toContainText('cannot put it back');
  }

  // A LOSSLESS TARGET IS STILL LOSSLESS. The prior loss is disclosed, not
  // charged to this conversion.
  await chooseTarget(page, '3mf');
  await expect(page.getByTestId('convert-verdict')).toHaveAttribute(
    'data-verdict',
    'LOSSLESS_FOR_SUPPORTED_FEATURES',
  );
});

test('an unopened material library is disclosed and never fetched', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!isAppOrigin(request.url())) external.push(request.url());
  });

  await page.goto('/');
  await importFile(page, {
    name: 'materials.obj',
    mimeType: 'model/obj',
    buffer: objWithRemoteMtllib(),
  });

  await openConvert(page);
  await chooseTarget(page, 'obj');
  await expect(page.getByTestId('convert-source-warnings')).toContainText(
    'separate material library',
  );
  await expect(page.getByTestId('convert-source-warnings')).toContainText('never opens it');

  const { bytes } = await exportAndCapture(page);
  expect(readObjArtifact(bytes).hasMtllib).toBe(false);
  expect(external).toEqual([]);
});

/* ------------------------------------------------------------------ CF16/CF17 -- */

test('a unit assertion changes the file and never the model', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.stl());

  const before = await page.getByTestId('fact-size').textContent();

  await openConvert(page);
  await chooseTarget(page, '3mf');
  await chooseUnit(page, 'foot');
  const { bytes } = await exportAndCapture(page);

  /*
   * THE AUTHORITATIVE DOCUMENT IS UNTOUCHED. Its unit is still unknown, its
   * measurements are still the same numbers, and exporting consumed no
   * revision — a download is a read. The panel shows the user's reading, which is
   * labelled as theirs; the coordinates and size are what the file said.
   */
  await expect(page.getByTestId('fact-units')).toHaveText('Feet (your choice)');
  expect(await page.getByTestId('fact-size').textContent()).toBe(before);

  // And the FILE states feet, with the same coordinates.
  const artifact = readThreeMfArtifact(bytes);
  expect(artifact.unit).toBe('foot');
});

test('every one of the six units is written exactly as chosen, with no rescaling', async ({
  page,
}) => {
  await page.goto('/');
  await importFile(page, FIXTURES.stl());

  const units = ['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'] as const;
  const written: string[] = [];
  let firstCoordinates: readonly (readonly [number, number, number])[] | undefined;

  /*
   * NOTHING IS PRESELECTED. The session starts with no unit — a preselected one
   * would be CAD Fixer asserting a physical fact about the model. Within one
   * session the choice is the user's standing statement about THIS model, so
   * each cycle deliberately replaces it; a new file starts empty again, which
   * `convert-workspace.spec.ts` proves.
   */
  await openConvert(page);
  await chooseTarget(page, '3mf');
  await expectNoUnitChosen(page);

  for (const unit of units) {
    await chooseUnit(page, unit);

    const { bytes } = await exportAndCapture(page);
    const artifact = readThreeMfArtifact(bytes);
    written.push(artifact.unit ?? '');

    // THE COORDINATES DO NOT MOVE. A unit says what the numbers mean, never
    // what they are.
    const coordinates = artifact.objects[0]?.vertices ?? [];
    firstCoordinates ??= coordinates;
    expect(coordinates).toEqual(firstCoordinates);
  }

  expect(written).toEqual([...units]);
});

/* ------------------------------------------------------------------ CF23 -- */

test('cancelling a large export saves nothing and leaves the workspace usable', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await importFile(page, {
    name: 'large.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfLarge(LARGE_TRIANGLES),
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText(LARGE_TRIANGLES.toLocaleString(), {
    timeout: 120_000,
  });

  let downloaded = 0;
  page.on('download', () => {
    downloaded += 1;
  });

  await openConvert(page);

  /*
   * BOTH TEXT TARGETS, because they cancel differently. OBJ is a long
   * serialisation loop that polls between batches; 3MF spends part of its time
   * inside `CompressionStream`, which polls no flag of ours — which is exactly
   * why cancellation is TERMINATION of a disposable worker rather than a
   * cooperative token.
   *
   * STL IS NOT INCLUDED, and that is a statement rather than an omission: a
   * binary STL of this size is a fixed-width write of a few megabytes and
   * finishes faster than a click, so a "cancellation" test on it would be
   * measuring the test's own timing rather than the product's.
   */
  for (const target of ['obj', '3mf'] as const) {
    await chooseTarget(page, target);
    await page.getByTestId('convert-export').click();
    // The export really started before Cancel was pressed.
    await expect(page.getByTestId('convert-progress')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('convert-cancel').click();

    // NO PARTIAL FILE. A truncated artifact with no indication it is truncated
    // is worse than no file at all.
    await expect(page.getByTestId('convert-failure')).toContainText('Export cancelled');
    // The full sentence is behind ⓘ (Convert P1).
    await expect(page.getByTestId('convert-outcome-details')).toContainText('model is unchanged');
    expect(downloaded, `${target} produced a download despite being cancelled`).toBe(0);

    // THE WORKSPACE STAYS USABLE, and the chosen target survives.
    await expect(page.getByTestId('convert-workspace')).toBeVisible();
    await expect(page.getByTestId('convert-export')).toBeEnabled();
  }

  // AND THE DOCUMENT IS UNTOUCHED by a cancelled export.
  await expect(page.getByTestId('fact-triangles')).toHaveText(LARGE_TRIANGLES.toLocaleString());

  // A RETRY SUCCEEDS. Cancelling left nothing behind that blocks the next run.
  await openConvert(page);
  await chooseTarget(page, 'stl');
  const { bytes } = await exportAndCapture(page);
  expect(readStlArtifact(bytes).declaredTriangles).toBe(LARGE_TRIANGLES);
  expect(downloaded).toBe(1);
});

/* ------------------------------------------------------------------ CF24 -- */

test('a model that changes while Convert is open cannot be exported from the old one', async ({
  page,
}) => {
  await page.goto('/');
  await importFile(page, FIXTURES.threeMfTwo());

  await openConvert(page);
  await chooseTarget(page, 'stl');
  await expect(page.getByTestId('convert-structure')).toContainText('merged into one mesh');

  /*
   * REPLACING THE MODEL RESETS THE SESSION, rather than leaving a report from
   * revision N able to authorise an export at revision N+1. The import happens
   * with the Convert workspace on screen.
   */
  await importFile(page, FIXTURES.stl());

  await openConvert(page);
  await chooseTarget(page, 'stl');
  // The report now describes the NEW model: one part, so nothing is merged.
  await expect(page.getByTestId('convert-structure')).toHaveCount(0);
  await expect(page.getByTestId('convert-verdict')).toHaveAttribute(
    'data-verdict',
    'LOSSLESS_FOR_SUPPORTED_FEATURES',
  );

  const { bytes } = await exportAndCapture(page);
  expect(readStlArtifact(bytes).declaredTriangles).toBe(STL_TRIANGLES);
});

/* ------------------------------------------------------------------ CF25 -- */

test('hostile names render as text and never reach the download name', async ({ page }) => {
  await page.goto('/');
  await importFile(page, {
    name: '../../etc/<script>evil</script>.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfHostileName(),
  });

  await openConvert(page);
  await chooseTarget(page, 'stl');

  // The workspace contains the characters as TEXT and no element made from them.
  await expect(page.getByTestId('convert-source')).toContainText('<script>');
  expect(await page.locator('[data-testid="convert-workspace"] script').count()).toBe(0);
  expect(await page.title()).not.toBe('XSS');

  const { download } = await exportAndCapture(page);
  /*
   * THE NAME IS SANITISED AND THE EXTENSION COMES FROM THE WRITER. Directory
   * components are dropped, reserved characters are removed, and a `.3mf`
   * exported as STL is called `.stl`.
   */
  const suggested = download.suggestedFilename();
  expect(suggested.endsWith('.stl')).toBe(true);
  expect(suggested).not.toContain('/');
  expect(suggested).not.toContain('..');
  expect(suggested).not.toContain('<');
  expect(suggested).not.toContain('>');
});

/* ------------------------------------------------------------------ CF34 -- */

test('changing the active part does not change what the document export writes', async ({
  page,
}) => {
  await page.goto('/');
  await importFile(page, FIXTURES.threeMfTwo());

  const facts = async (): Promise<string | null> => {
    await openConvert(page);
    await chooseTarget(page, 'stl');
    return page.getByTestId('convert-report').textContent();
  };

  const withFirst = await facts();

  // Select the second part, which is workspace state and not geometry identity.
  await openInspector(page);
  await page.getByTestId('part-option-part-2').click();

  const withSecond = await facts();
  expect(withSecond).toBe(withFirst);

  // And the file still contains BOTH parts.
  await openConvert(page);
  await chooseTarget(page, 'stl');
  const { bytes } = await exportAndCapture(page);
  expect(readStlArtifact(bytes).declaredTriangles).toBe(8);
});

/* ------------------------------------------------------------------ CF31 -- */

test('exporting never modifies the document, whatever the target', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.threeMfInches());

  const before = {
    triangles: await page.getByTestId('fact-triangles').textContent(),
    units: await page.getByTestId('fact-units').textContent(),
    size: await page.getByTestId('fact-size').textContent(),
  };

  await openConvert(page);
  for (const target of ['stl', 'obj', '3mf'] as const) {
    await chooseTarget(page, target);
    await exportAndCapture(page);
  }

  expect(await page.getByTestId('fact-triangles').textContent()).toBe(before.triangles);
  expect(await page.getByTestId('fact-units').textContent()).toBe(before.units);
  expect(await page.getByTestId('fact-size').textContent()).toBe(before.size);
});

/* --------------------------------------------------------------- CXR01-CXR05 -- */

test('CXR: every artifact re-opens through the production import path', async ({ page }) => {
  await page.goto('/');

  /*
   * THE STRONGEST EVIDENCE THIS SUITE CAN GATHER. Parse-back validation already
   * ran inside the export worker; this repeats it through the whole
   * application — file chooser, format identification from BYTES, reader,
   * document gate, commit — which is the path a user's own re-open takes.
   */
  const cases: readonly {
    readonly id: string;
    readonly source: Fixture;
    readonly target: 'stl' | 'obj' | '3mf';
    readonly unit?: string;
    readonly expectedTriangles: number;
    readonly expectedUnit: string;
  }[] = [
    {
      id: 'CXR01',
      source: FIXTURES.stl(),
      target: 'obj',
      expectedTriangles: STL_TRIANGLES,
      expectedUnit: 'Unspecified',
    },
    {
      id: 'CXR02',
      source: FIXTURES.stl(),
      target: '3mf',
      unit: 'millimeter',
      expectedTriangles: STL_TRIANGLES,
      expectedUnit: 'millimeter',
    },
    {
      id: 'CXR03',
      source: FIXTURES.threeMfTwo(),
      target: 'obj',
      expectedTriangles: 8,
      expectedUnit: 'Unspecified',
    },
    {
      id: 'CXR04',
      source: FIXTURES.threeMfTwo(),
      target: 'stl',
      expectedTriangles: 8,
      expectedUnit: 'Unspecified by STL',
    },
    {
      id: 'CXR05',
      source: FIXTURES.objMulti(),
      target: '3mf',
      unit: 'inch',
      expectedTriangles: 12,
      expectedUnit: 'inch',
    },
  ];

  for (const testCase of cases) {
    await importFile(page, testCase.source);
    await openConvert(page);
    await chooseTarget(page, testCase.target);
    if (testCase.unit !== undefined) {
      await chooseUnit(page, testCase.unit);
    }
    const { bytes } = await exportAndCapture(page);
    await reimport(page, `${testCase.id}.${testCase.target}`, bytes);

    await expect(page.getByTestId('fact-triangles'), `${testCase.id} triangle count`).toHaveText(
      testCase.expectedTriangles.toLocaleString(),
    );
    await expect(page.getByTestId('fact-units'), `${testCase.id} unit`).toHaveText(
      testCase.expectedUnit,
    );
  }
});

/* --------------------------------------------------------------------- CF32/CF33 -- */

test('repair then export writes the repaired revision, and undo then export writes the restored one', async ({
  page,
}) => {
  await page.goto('/');
  /*
   * A DOCUMENT WITH ONE REMOVABLE DEFECT: a tetrahedron carrying an exact
   * duplicate face, so the triangle count is a visible, exact witness to which
   * revision was written.
   */
  const duplicated = threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Defective"><mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>
     <vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
     <triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
     <triangle v1="0" v2="2" v3="1"/>
    </triangles>
   </mesh></object>`,
    }),
  );

  await importFile(page, { name: 'defect.3mf', mimeType: 'model/3mf', buffer: duplicated });
  await expect(page.getByTestId('fact-triangles')).toHaveText('5');

  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText('4', { timeout: 60_000 });

  // CF32: the export is of the CURRENT, repaired revision.
  await openConvert(page);
  await chooseTarget(page, 'stl');
  const repaired = await exportAndCapture(page);
  expect(readStlArtifact(repaired.bytes).declaredTriangles).toBe(4);
  await page.getByTestId('workflow-repair').click();

  // CF33: undo produces a NEW higher revision, and the export follows it.
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText('5', { timeout: 60_000 });

  await openConvert(page);
  await chooseTarget(page, 'stl');
  const restored = await exportAndCapture(page);
  expect(readStlArtifact(restored.bytes).declaredTriangles).toBe(5);
});

/* ------------------------------------------------------------------- CF30 -- */

test('a conversion that cannot fit is refused with a reason, and the others stay available', async ({
  page,
}) => {
  await page.goto('/');
  /*
   * A DOCUMENT TOO LARGE FOR ONE TARGET AND NOT FOR ANOTHER cannot be built
   * cheaply in a browser, so this asserts the weaker, real property: a target's
   * report is computed independently, and choosing one that is blocked does not
   * disable the others.
   */
  await importFile(page, FIXTURES.stl());

  await openConvert(page);
  await chooseTarget(page, '3mf');
  await expect(page.getByTestId('convert-export')).toBeDisabled();

  // ANOTHER TARGET IS STILL AVAILABLE. One target's requirement is not a
  // property of the document.
  await chooseTarget(page, 'obj');
  await expect(page.getByTestId('convert-export')).toBeEnabled();
});

/* ---------------------------------------------------------------- privacy -- */

test('the whole conversion workflow sends nothing to the network', async ({ page }) => {
  /*
   * THE STRONGEST GUARANTEE THIS PRODUCT MAKES, asserted over the workflow that
   * most invites a violation: an exporter is exactly where a naive
   * implementation would POST the file somewhere to convert it.
   */
  const external: string[] = [];
  const withBodies: string[] = [];
  page.on('request', (request) => {
    if (!isAppOrigin(request.url())) external.push(request.url());
    if ((request.postData() ?? '').length > 0) withBodies.push(request.url());
  });

  await page.goto('/');
  await importFile(page, FIXTURES.threeMfTwo());

  await openConvert(page);
  for (const target of ['stl', 'obj', '3mf'] as const) {
    await chooseTarget(page, target);
    await exportAndCapture(page);
  }

  expect(external).toEqual([]);
  expect(withBodies).toEqual([]);
});

/* ------------------------------------------------------------ lazy worker -- */

test('the export worker is not constructed until an export starts', async ({ page }) => {
  /*
   * OPENING THE DIALOG MUST COST NOTHING. Reading a compatibility summary is a
   * pure computation over scalars the page already holds; constructing a worker
   * — and with it the whole serialisation chunk — to render a panel would make
   * every glance at the format list pay for an export nobody asked for.
   */
  await page.goto('/');
  await page.evaluate(() => {
    const created: string[] = [];
    (globalThis as unknown as { __workers: string[] }).__workers = created;
    const Original = Worker;
    class Counting extends Original {
      public constructor(url: string | URL, options?: WorkerOptions) {
        created.push(String(url));
        super(url, options);
      }
    }
    (globalThis as unknown as { Worker: typeof Worker }).Worker = Counting;
  });

  await importFile(page, FIXTURES.stl());

  const exportWorkers = async (): Promise<number> =>
    page.evaluate(
      () =>
        (globalThis as unknown as { __workers: string[] }).__workers.filter((url) =>
          url.includes('export'),
        ).length,
    );

  await openConvert(page);
  await chooseTarget(page, 'obj');
  await chooseTarget(page, '3mf');
  await chooseUnit(page, 'millimeter');
  expect(await exportWorkers()).toBe(0);

  await exportAndCapture(page);
  expect(await exportWorkers()).toBe(1);
});

/* ------------------------------------------------- responsiveness of the UI -- */

test('the main thread stays responsive while a large conversion runs', async ({ page }) => {
  test.setTimeout(300_000);
  /*
   * B2'S HARNESS EVIDENCE IS NO LONGER SUFFICIENT, because the feature is now
   * user-visible: a user presses Export in the real application, and the page
   * has to stay interactive while the file is written, compressed and read back.
   * Measured through the production UI, on the production build.
   *
   * THE MEASUREMENT IS A RATIO, NOT A THRESHOLD, and deliberately so — the same
   * shape as the STL import proof. It compares the longest gap between animation
   * frames against the export's own duration, which is self-scaling: it has no
   * millisecond constant in it, and it fails hard for the one reason that
   * matters. A main-thread serialisation would starve the frame loop for the
   * whole export, so the longest gap would approach the whole duration.
   */
  await page.goto('/');
  await importFile(page, {
    name: 'large.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfLarge(LARGE_TRIANGLES),
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText(LARGE_TRIANGLES.toLocaleString(), {
    timeout: 120_000,
  });

  await openConvert(page);
  await chooseTarget(page, 'obj');

  await page.evaluate(() => {
    const gaps: number[] = [];
    let previous = performance.now();
    const startedAt = previous;
    let running = true;

    const tick = (): void => {
      if (!running) return;
      const now = performance.now();
      gaps.push(now - previous);
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    Object.assign(globalThis, {
      __stopFrames: (): { frames: number; longestGapMs: number; durationMs: number } => {
        running = false;
        return {
          frames: gaps.length,
          longestGapMs: gaps.length === 0 ? 0 : Math.max(...gaps),
          durationMs: performance.now() - startedAt,
        };
      },
    });
  });

  const pending = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByTestId('convert-export').click();

  // The Cancel control and the progress state are on screen WHILE the export
  // runs, which they could not be if the thread were blocked.
  await expect(page.getByTestId('convert-cancel')).toBeVisible();
  await expect(page.getByTestId('convert-progress')).toBeVisible();

  await pending;
  await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 180_000 });

  const measurement = await page.evaluate(() =>
    (
      globalThis as unknown as {
        __stopFrames: () => { frames: number; longestGapMs: number; durationMs: number };
      }
    ).__stopFrames(),
  );

  // The frame loop kept running throughout.
  expect(measurement.frames).toBeGreaterThan(5);
  // And no single stall came close to swallowing the export.
  expect(measurement.longestGapMs).toBeLessThan(measurement.durationMs / 3);
});

/* ------------------------------------------------- PR09: property references -- */

test('PR09: a real 3MF download from a model with a material reference carries no pid', async ({
  page,
}) => {
  /*
   * THE CONFORMANCE DEFECT, CLOSED THROUGH THE REAL USER-VISIBLE WORKFLOW.
   *
   * The source states `<basematerials id="7">` and an object with `pid="7"`, so
   * the reference RESOLVES and the file is valid — CAD Fixer imports it and
   * carries the reference on the part. The writer used to reproduce that
   * reference on the way out, with no property resource behind it, producing a
   * dangling `pid` in a file CAD Fixer had itself created.
   */
  await page.goto('/');
  await importFile(page, {
    name: 'materials.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfWithMaterial(),
  });

  await openConvert(page);
  await chooseTarget(page, '3mf');

  // 3. The loss is stated BEFORE the export, and 3MF is no longer "lossless".
  await expect(page.getByTestId('convert-metadata')).toContainText('refer to a material by name');
  await expect(page.getByTestId('convert-metadata')).toContainText('would make the file invalid');
  /*
   * TWO DIFFERENT FACTS, SAID ONCE EACH. The source section reports that the
   * file's material DEFINITIONS were never imported; this reports that the
   * REFERENCE the part carries is not written out. Neither restates the other.
   */
  await expect(page.getByTestId('convert-source-warnings')).toContainText(
    'colour or material definitions',
  );
  await expect(page.getByTestId('convert-verdict')).not.toHaveAttribute(
    'data-verdict',
    'LOSSLESS_FOR_SUPPORTED_FEATURES',
  );

  const { download, bytes } = await exportAndCapture(page);
  expect(download.suggestedFilename()).toBe('materials.3mf');

  // 6/7. The independent oracle finds no property reference at all.
  const artifact = readThreeMfArtifact(bytes);
  expect(artifact.propertyReferences).toEqual([]);
  expect(artifact.referenceProblems).toEqual([]);
  expect(artifact.modelXml).not.toContain('pid=');
  expect(artifact.modelXml).not.toContain('pindex=');

  // 8/9. It re-opens, with geometry, unit, name and placement intact.
  await reimport(page, 'materials-roundtrip.3mf', bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');
  await expect(page.getByTestId('fact-units')).toHaveText('millimeter');
});

test('PR09: every target drops the material reference and none writes a pid', async ({ page }) => {
  await page.goto('/');
  await importFile(page, {
    name: 'materials.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfWithMaterial(),
  });

  await openConvert(page);
  for (const target of ['stl', 'obj', '3mf'] as const) {
    await chooseTarget(page, target);
    await expect(page.getByTestId('convert-metadata')).toContainText('refer to a material by name');
    const { bytes } = await exportAndCapture(page);
    if (target === '3mf') {
      expect(readThreeMfArtifact(bytes).propertyReferences).toEqual([]);
    } else if (target === 'obj') {
      // OBJ names no material library either, so nothing points at nothing.
      expect(readObjArtifact(bytes).hasMtllib).toBe(false);
      expect(readObjArtifact(bytes).materials).toEqual([]);
    }
  }
});

test('a 3MF the reader accepts is one whose property references resolve', async ({ page }) => {
  /*
   * THE OTHER HALF OF THE READER CONTRACT, through the real import path: an
   * UNSUPPORTED property resource is a valid file, and a DANGLING reference is
   * not. Confusing the two would either refuse legitimate files or keep
   * accepting the malformed ones.
   */
  await page.goto('/');

  // Valid: the resource exists, the geometry imports, the loss is disclosed.
  await importFile(page, {
    name: 'materials.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfWithMaterial(),
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');

  await openConvert(page);
  await chooseTarget(page, '3mf');
  await expect(page.getByTestId('convert-source-warnings')).toContainText(
    'colour or material definitions',
  );

  // Malformed: `pid` names nothing, and the import is refused outright.
  const dangling = threeMf(
    modelXml({
      resources: `<object id="1" type="model" pid="7">${tetrahedronMesh()}</object>`,
    }),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'dangling.3mf',
    mimeType: 'model/3mf',
    buffer: dangling,
  });

  await expect(page.getByTestId('status-list')).toContainText('property resource', {
    timeout: 20_000,
  });
  // AND THE PREVIOUS MODEL SURVIVES. A refused import is transactional.
  await expect(page.getByTestId('fact-triangles')).toHaveText('4');
});

/* ------------------------------------------- NS08-NS10: name sanitization -- */

test('NS08-NS10: a name that cannot be written exactly is disclosed before export', async ({
  page,
}) => {
  /*
   * A DOUBLE SPACE IS LEGAL IN A 3MF AND UNREPRESENTABLE IN AN OBJ: a reader
   * splits on whitespace, so the name comes back collapsed. Small, real, and
   * silent until now.
   */
  await page.goto('/');
  await importFile(page, {
    name: 'awkward.3mf',
    mimeType: 'model/3mf',
    buffer: threeMfAwkwardName(),
  });

  await openConvert(page);

  // NS08: stated before the export, for the target it applies to.
  await chooseTarget(page, 'obj');
  await expect(page.getByTestId('convert-transformations')).toContainText(
    'cannot store exactly, so they will be adjusted',
  );
  /*
   * ASSERTED ON THE SENTENCE, NOT ON THE SECTION. This document also has a
   * non-identity placement, so STL and OBJ legitimately report a baked
   * transform — requiring the whole section to be absent would be asserting
   * that a different, correct fact had gone missing.
   */
  const sanitization = 'cannot store exactly';

  // NOT for the target that can carry it — XML keeps a double space.
  await chooseTarget(page, '3mf');
  await expect(page.getByTestId('convert-report')).not.toContainText(sanitization);

  // NS05: STL drops names entirely and does not warn twice about it.
  await chooseTarget(page, 'stl');
  await expect(page.getByTestId('convert-metadata')).toContainText('nowhere to put a name');
  await expect(page.getByTestId('convert-report')).not.toContainText(sanitization);

  // NS09: the downloaded OBJ carries the writer's sanitized value.
  await chooseTarget(page, 'obj');

  // NS06: ONE of the two names is affected, and the count says one.
  await expect(page.getByTestId('convert-transformations')).toContainText('1 part name');

  const { bytes } = await exportAndCapture(page);
  const artifact = readObjArtifact(bytes);
  // NS09: the file carries the writer's sanitized value, and the other name is
  // untouched.
  expect(artifact.objects).toEqual(['Left Bracket', 'Right Bracket']);

  // NS07: the panel disclosed a COUNT and never the name itself.
  const panel = await page.getByTestId('convert-transformations').textContent();
  expect(panel).not.toContain('Left');
  expect(panel).not.toContain('Bracket');

  // NS10: the source document still holds the name exactly as it was read.
  await expect(page.getByTestId('fact-triangles')).toHaveText('8');
  await expect(page.getByTestId('part-option-part-1')).toContainText('Left  Bracket');
});

test('an ordinary name produces no sanitization warning at all', async ({ page }) => {
  await page.goto('/');
  await importFile(page, FIXTURES.threeMfSimple());

  await openConvert(page);
  for (const target of ['obj', '3mf'] as const) {
    await chooseTarget(page, target);
    await expect(page.getByTestId('convert-report')).not.toContainText('cannot store exactly');
  }
});
