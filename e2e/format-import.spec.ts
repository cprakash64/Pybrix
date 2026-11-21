import { expect, test, type Page } from '@playwright/test';
import { isAppOrigin } from './app-origin';
import {
  objMultiPart,
  objTriangle,
  objWithBadIndex,
  objWithHostileName,
  objWithQuad,
  objWithRemoteMtllib,
  threeMf,
  threeMfComponentCycle,
  threeMfHostileName,
  threeMfLarge,
  threeMfNestedComponents,
  threeMfOverEntryCeiling,
  threeMfPlacements,
  threeMfSharedPlacements,
  threeMfTwoParts,
  threeMfWithDoctype,
  threeMfWithExternalReference,
  threeMfWithTexture,
  modelXml,
  zipCompressionBomb,
  zipEncryptedEntry,
  zipOverTotalBudget,
  zipWithTraversalPath,
  threeMfMissingModelPart,
  threeMfProductionExtension,
  threeMfDanglingComponent,
} from './format-fixtures';
import { binaryStl } from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * OBJ AND 3MF IMPORT, IN A REAL BROWSER.
 *
 * The parser suites test each format against its own corpus under Node. What
 * only this can answer is whether a real user opening a real file gets a real
 * model: the file chooser, the worker boundary, the built worker chunk, the
 * viewport, the part selector and Mesh Health, all at once.
 *
 * Every hostile fixture is also run HERE rather than only in the reader tests,
 * because a security property that holds in Node and not in the shipped bundle
 * is not a security property.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

async function statusText(page: Page): Promise<string> {
  return (await page.getByTestId('status-list').textContent()) ?? '';
}

/** Scene facts the viewport publishes for leak and rendering tests. */
async function readScene(page: Page): Promise<{
  drawCalls: number;
  modelObjects: number;
  sharedGeometries: number;
  geometriesCreated: number;
  geometriesDisposed: number;
  partTransforms: string;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const read = (key: string): number => Number(canvas?.dataset[key] ?? 0);
    return {
      drawCalls: read('drawCalls'),
      modelObjects: read('modelObjects'),
      sharedGeometries: read('sharedGeometries'),
      geometriesCreated: read('geometriesCreated'),
      geometriesDisposed: read('geometriesDisposed'),
      partTransforms: canvas?.dataset.partTransforms ?? '',
    };
  });
}

function translationOf(partTransforms: string, partId: string): readonly number[] | undefined {
  for (const entry of partTransforms.split('|')) {
    const [id, values] = entry.split(':');
    if (id !== partId || values === undefined) continue;
    return values.split(',').map(Number);
  }
  return undefined;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

/* ------------------------------------------------------------------ obj -- */

test('imports an OBJ and renders it', async ({ page }) => {
  await openFile(page, 'triangle.obj', objTriangle().bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText('1', { timeout: 30_000 });
  await expect(page.getByTestId('fact-units')).toContainText(/unspecified/i);

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(1);
  expect(scene.drawCalls).toBeGreaterThan(0);
});

test('an OBJ with several objects becomes several parts', async ({ page }) => {
  const fixture = objMultiPart(3);
  await openFile(page, 'assembly.obj', fixture.bytes);

  await openInspector(page);
  await expect(page.getByTestId('part-selector')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('fact-parts')).toHaveText('3');
  await expect(page.getByTestId('part-option-part-1')).toContainText('Part 1');
  await expect(page.getByTestId('part-option-part-3')).toContainText('Part 3');

  const scene = await readScene(page);
  // THREE OBJECTS DRAWN, and three distinct meshes: OBJ has no instancing.
  expect(scene.modelObjects).toBe(3);
  expect(scene.sharedGeometries).toBe(3);
});

test('refuses an OBJ polygon with an explanation, and keeps the workspace empty', async ({
  page,
}) => {
  await openFile(page, 'quad.obj', objWithQuad());

  await expect.poll(async () => statusText(page), { timeout: 30_000 }).toMatch(/triangle faces/i);
  // It says what it will not do, and why.
  expect(await statusText(page)).toMatch(/invent/i);
  await expect(page.getByTestId('model-empty')).toBeAttached();
});

test('refuses an OBJ with an impossible index rather than clamping it', async ({ page }) => {
  await openFile(page, 'bad.obj', objWithBadIndex());

  await expect.poll(async () => statusText(page), { timeout: 30_000 }).toMatch(/does not exist/i);
  await expect(page.getByTestId('model-empty')).toBeAttached();
});

test('names a material library it did not open, and makes no request for it', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });

  await openFile(page, 'materials.obj', objWithRemoteMtllib());
  await expect(page.getByTestId('fact-triangles')).toHaveText('1', { timeout: 30_000 });

  // The geometry imported, and the omission is stated rather than silent.
  await expect(page.getByTestId('model-warnings')).toContainText(/material library/i);
  // NOTHING WAS FETCHED. The library is text; nothing resolves it.
  expect(requests.filter((url) => url.includes('evil.test'))).toEqual([]);
});

/* ------------------------------------------------------------------ 3mf -- */

test('imports a 3MF and preserves its unit', async ({ page }) => {
  await openFile(page, 'part.3mf', threeMf(modelXml({ unit: 'inch' })));

  await expect(page.getByTestId('fact-triangles')).toHaveText('4', { timeout: 30_000 });
  // The unit the file stated, shown as stated — and the coordinates unchanged.
  await expect(page.getByTestId('fact-units')).toHaveText('inch');

  // AND EVERY SENTENCE THAT MENTIONS UNITS FOLLOWS THE FILE. Mesh Health used
  // to say "STL states no unit" to every user, whatever they had opened.
  await expect(page.getByTestId('mesh-health')).toContainText(
    'Areas and volumes are in the unit the file stated (inch)',
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('mesh-health')).not.toContainText('STL states no unit');
});

test('a 3MF with two build items becomes two placed parts', async ({ page }) => {
  await openFile(page, 'two.3mf', threeMfTwoParts());

  await openInspector(page);
  await expect(page.getByTestId('part-selector')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('part-option-part-1')).toContainText('Left');
  await expect(page.getByTestId('part-option-part-2')).toContainText('Right');

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(2);
  // Distinct objects, so distinct meshes.
  expect(scene.sharedGeometries).toBe(2);

  // AND THE PLACEMENT REACHED THE RENDERER. 40 along X, as the file says.
  const a = translationOf(scene.partTransforms, 'part-1');
  const b = translationOf(scene.partTransforms, 'part-2');
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect((b?.[0] ?? 0) - (a?.[0] ?? 0)).toBeCloseTo(40, 2);
});

test('repeated 3MF placements share one GPU geometry', async ({ page }) => {
  await openFile(page, 'shared.3mf', threeMfSharedPlacements(24));

  await expect(page.getByTestId('fact-parts')).toHaveText('24', { timeout: 30_000 });

  const scene = await readScene(page);
  expect(scene.modelObjects).toBe(24);
  // ONE UPLOAD FOR TWENTY-FOUR PLACEMENTS. The whole point of sharing, proven
  // in a real GPU context rather than in a unit test's bookkeeping.
  expect(scene.sharedGeometries).toBe(1);
});

test('nested 3MF components compose their transforms', async ({ page }) => {
  await openFile(page, 'nested.3mf', threeMfNestedComponents());

  await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });

  const scene = await readScene(page);
  const leaf = translationOf(scene.partTransforms, 'part-1');
  const nested = translationOf(scene.partTransforms, 'part-2');
  if (leaf === undefined || nested === undefined) {
    throw new Error(`missing placement in "${scene.partTransforms}"`);
  }

  // outer(0,+25) applied after inner(+30,0) puts the leaf at (30, 25).
  expect((nested[0] ?? 0) - (leaf[0] ?? 0)).toBeCloseTo(30, 2);
  expect((nested[1] ?? 0) - (leaf[1] ?? 0)).toBeCloseTo(25, 2);
  // BOTH SHARE ONE MESH: the component instance points at the same object.
  expect(scene.sharedGeometries).toBe(1);
});

test('reports a 3MF texture it did not read, and fetches nothing', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });

  await openFile(page, 'textured.3mf', threeMfWithTexture());
  await expect(page.getByTestId('fact-triangles')).toHaveText('4', { timeout: 30_000 });

  await expect(page.getByTestId('model-warnings')).toContainText(/textures/i);
  await expect(page.getByTestId('model-warnings')).toContainText(/nothing was downloaded/i);
  expect(requests.filter((url) => url.includes('evil.test'))).toEqual([]);
});

/* ------------------------------------------------------- hostile inputs -- */

test.describe('hostile files are refused in the browser, exactly as in the reader tests', () => {
  for (const [label, name, build, expected] of [
    ['a ZIP traversal path', 'traversal.3mf', zipWithTraversalPath, /unsafe file path/i],
    [
      'a compression bomb',
      'bomb.3mf',
      zipCompressionBomb,
      // The ratio and the ceiling, both in the sentence — Stage 6B-C1.
      /expands at [\d,]+:1; Pybrix's compression-ratio limit is 200:1/i,
    ],
    ['an encrypted entry', 'locked.3mf', zipEncryptedEntry, /encrypted/i],
    ['a DOCTYPE declaration', 'xxe.3mf', threeMfWithDoctype, /document type definition/i],
    [
      'an external XML reference',
      'external.3mf',
      threeMfWithExternalReference,
      /external XML resource/i,
    ],
    ['a component cycle', 'cycle.3mf', threeMfComponentCycle, /loop/i],
  ] as const) {
    test(`refuses ${label}`, async ({ page }) => {
      const requests: string[] = [];
      page.on('request', (request) => {
        requests.push(request.url());
      });

      await openFile(page, name, build());

      await expect.poll(async () => statusText(page), { timeout: 60_000 }).toMatch(expected);
      // Nothing was committed, and nothing off-origin was requested.
      await expect(page.getByTestId('model-empty')).toBeAttached();
      expect(requests.filter((url) => !isAppOrigin(url))).toEqual([]);
    });
  }
});

test.describe('untrusted names render as text, never as markup', () => {
  for (const [label, name, build] of [
    ['an OBJ object name', 'hostile.obj', objWithHostileName],
    ['a 3MF object name', 'hostile.3mf', threeMfHostileName],
  ] as const) {
    test(`escapes ${label}`, async ({ page }) => {
      await openFile(page, name, build());
      // Two parts, so the selector renders and the name is actually displayed.
      await openInspector(page);
      await expect(page.getByTestId('part-selector')).toBeVisible({ timeout: 30_000 });

      // The name is on screen as literal text...
      await expect(page.getByTestId('part-option-part-1')).toContainText('<img src=x onerror=');
      // ...and the handler never ran: no element was created, and the payload's
      // own effect did not fire.
      expect(await page.title()).not.toBe('XSS');
      // The only image on the page is the product's own header mark (BRAND-01);
      // the payload created none, and no element anywhere carries a handler.
      expect(await page.locator('img:not([data-testid="brand-mark"])').count()).toBe(0);
      expect(await page.locator('[onerror]').count()).toBe(0);
      // The whole payload survives as one text node rather than being parsed.
      const rendered = await page
        .getByTestId('part-option-part-1')
        .evaluate((element) => ({ text: element.textContent, children: element.innerHTML }));
      expect(rendered.text).toContain(`document.title='XSS'`);
      expect(rendered.children).toContain('&lt;img');
    });
  }
});

/* ---------------------------------------------------------- progress -- */

test('a 3MF import says it is decompressing, in words rather than in tokens', async ({ page }) => {
  test.setTimeout(120_000);

  /*
   * WHY THIS IS WORTH A TEST. A 3MF spends real time inflating an archive, and
   * without the detail the interface says "Parsing geometry" throughout — which
   * is not what is happening yet. The note comes from the reader, so this also
   * proves the phase note survives the worker boundary.
   */
  const seen: string[] = [];
  await page.exposeFunction('__recordPhase', (text: string) => {
    seen.push(text);
  });
  await page.evaluate(() => {
    const record = (): void => {
      const phase = document.querySelector('[data-testid="import-phase"]');
      if (phase === null) return;
      const send = (window as unknown as { __recordPhase: (text: string) => void }).__recordPhase;
      send(phase.textContent);
    };
    new MutationObserver(record).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  await openFile(page, 'large.3mf', threeMfLarge(60_000));
  await expect(page.getByTestId('fact-triangles')).toHaveText('60,000', { timeout: 90_000 });

  const joined = seen.join(' | ');
  expect(joined).toMatch(/decompressing|reading the archive|reading the model part|building parts/);
  // AND NEVER THE READER'S OWN VOCABULARY. A note the interface has no words
  // for shows nothing at all rather than an internal token.
  expect(joined).not.toMatch(/parsing model|reading package|building document/);
});

/* ------------------------------------------------------ transactionality -- */

test('a failed OBJ import leaves the loaded model untouched', async ({ page }) => {
  await openFile(page, 'good.obj', objMultiPart(2).bytes);
  await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });
  const before = await readScene(page);

  await openFile(page, 'quad.obj', objWithQuad());
  await expect.poll(async () => statusText(page), { timeout: 30_000 }).toMatch(/triangle faces/i);

  // SAME MODEL, still drawn, still two parts.
  await expect(page.getByTestId('fact-parts')).toHaveText('2');
  const after = await readScene(page);
  expect(after.modelObjects).toBe(before.modelObjects);
  expect(after.sharedGeometries).toBe(before.sharedGeometries);
  await expect(page.getByTestId('part-option-part-1')).toHaveAttribute('aria-pressed', 'true');
});

test('a failed 3MF import leaves the loaded model untouched', async ({ page }) => {
  await openFile(page, 'good.3mf', threeMfTwoParts());
  await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });

  await openFile(page, 'bomb.3mf', zipCompressionBomb());
  await expect
    .poll(async () => statusText(page), { timeout: 60_000 })
    .toMatch(/expands at [\d,]+:1; Pybrix's compression-ratio limit is 200:1/i);

  await expect(page.getByTestId('fact-parts')).toHaveText('2');
  expect((await readScene(page)).modelObjects).toBe(2);
});

/* ------------------------------------------- truthful refusal semantics -- */

test.describe('a valid file CAD Fixer cannot read is not called a broken one', () => {
  /*
   * STAGE 6B-C1, IN A REAL BROWSER.
   *
   * A beta tester was told their working multi-material 3MF "contains a
   * component that refers to an object which does not exist". The file was not
   * damaged; CAD Fixer reads one model part and that one does not hold the
   * object. These two tests are the pair that has to stay distinguishable.
   */
  test('a production-extension 3MF imports its referenced geometry', async ({ page }) => {
    /*
     * STAGE 6D-A2, IN A REAL BROWSER. This test used to assert the refusal;
     * what it asserted UNDERNEATH was that a valid file is never described as a
     * broken one, and importing it is the better way to keep that promise.
     *
     * The root model part of this package declares NO mesh at all, so a part
     * arriving on screen means the second model part was opened, parsed and
     * placed — through the worker, the document gate and the render snapshot,
     * none of which the unit tests exercise.
     */
    await openFile(page, 'good.3mf', threeMfTwoParts());
    await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });

    await openFile(page, 'multipart.3mf', threeMfProductionExtension());
    await expect(page.getByTestId('fact-filename')).toHaveText('multipart.3mf', {
      timeout: 60_000,
    });
    /*
     * ASSERTED ON THE TRIANGLE COUNT, NOT ON `fact-parts`. This package builds
     * ONE part and the panel shows a part count only above one — so waiting for
     * `fact-parts` here waits for an element the interface is right not to
     * render. The tetrahedron in the referenced model part has four faces, and
     * the root model part declares no mesh at all, so four triangles on screen
     * IS the proof that the second part was opened and placed.
     */
    await expect(page.getByTestId('fact-triangles')).toHaveText('4');
    // It is DRAWN, not merely accepted: the geometry reached the viewport.
    expect((await readScene(page)).modelObjects).toBe(1);

    // NOTHING TELLS THE USER THE EXTENSION IS UNSUPPORTED. That sentence would
    // send them to re-export a file that just opened.
    const shown = await statusText(page);
    expect(shown).not.toMatch(/several model parts/i);
    expect(shown).not.toMatch(/does not exist/i);

    // And a valid file still imports afterwards.
    await openFile(page, 'next.3mf', threeMfSharedPlacements(4));
    await expect(page.getByTestId('fact-parts')).toHaveText('4', { timeout: 60_000 });
  });

  test('a package whose referenced part is missing is refused, and keeps the open model', async ({
    page,
  }) => {
    /*
     * THE TRANSACTIONAL HALF THE TEST ABOVE USED TO CARRY, moved to a package
     * that still refuses. A multi-part refusal is the interesting case: by the
     * time it fires the reader has opened the archive, parsed the root and
     * resolved a reference, so "the model you had open is untouched" is a claim
     * about a read that got most of the way through.
     */
    await openFile(page, 'good.3mf', threeMfTwoParts());
    await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 30_000 });
    const before = await readScene(page);

    await openFile(page, 'incomplete.3mf', threeMfMissingModelPart());
    await expect
      .poll(async () => statusText(page), { timeout: 60_000 })
      .toMatch(/does not contain/i);

    await expect(page.getByTestId('fact-parts')).toHaveText('2');
    await expect(page.getByTestId('fact-filename')).toHaveText('good.3mf');
    const after = await readScene(page);
    expect(after.modelObjects).toBe(before.modelObjects);
    expect(after.geometriesCreated).toBe(before.geometriesCreated);

    await openFile(page, 'next.3mf', threeMfSharedPlacements(4));
    await expect(page.getByTestId('fact-parts')).toHaveText('4', { timeout: 60_000 });
  });

  test('a genuinely dangling component is still refused, and now says where', async ({ page }) => {
    await openFile(page, 'dangling.3mf', threeMfDanglingComponent());
    await expect
      .poll(async () => statusText(page), { timeout: 60_000 })
      .toMatch(/Object 17, component 2 refers to missing object 42/i);

    await expect(page.getByTestId('model-empty')).toBeAttached();
  });
});

/* ------------------------------------------------------- resource bounds -- */

test.describe('a document that cannot be held is refused without disturbing the one that is', () => {
  /*
   * THE TWO OVERFLOW MODES ADDED IN STAGE 4A-2B1-R1, in a real browser.
   *
   * Both are refused far from the geometry: one while walking a component
   * graph, the other while accounting inflated bytes. Neither reaches the
   * document gate, and — the property that actually matters to a user — neither
   * takes away the model they already had open.
   */
  test('refuses more parts than a document may hold', async ({ page }) => {
    test.setTimeout(180_000);

    await openFile(page, 'good.3mf', threeMfTwoParts());
    await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 60_000 });
    await expect(page.getByTestId('part-option-part-1')).toHaveAttribute('aria-pressed', 'true');
    const before = await readScene(page);

    // 4,097 placements of one object: a few kilobytes describing a document
    // nothing can hold.
    await openFile(page, 'toomany.3mf', threeMfPlacements(4_097));
    await expect
      .poll(async () => statusText(page), { timeout: 120_000 })
      .toMatch(/expands to more than 4,096 parts, which is Pybrix's limit/i);

    // THE PREVIOUS MODEL IS UNTOUCHED: same parts, same selection, same scene.
    await expect(page.getByTestId('fact-parts')).toHaveText('2');
    await expect(page.getByTestId('fact-filename')).toHaveText('good.3mf');
    await expect(page.getByTestId('part-option-part-1')).toHaveAttribute('aria-pressed', 'true');
    const after = await readScene(page);
    expect(after.modelObjects).toBe(before.modelObjects);
    expect(after.sharedGeometries).toBe(before.sharedGeometries);
    // No fragment of the refused document was drawn.
    expect(after.geometriesCreated).toBe(before.geometriesCreated);

    // And a valid file still imports afterwards.
    await openFile(page, 'next.obj', objMultiPart(3).bytes);
    await expect(page.getByTestId('fact-parts')).toHaveText('3', { timeout: 60_000 });
  });

  test('refuses an archive that expands past the total budget', async ({ page }) => {
    test.setTimeout(180_000);

    await openFile(page, 'good.3mf', threeMfTwoParts());
    await expect(page.getByTestId('fact-parts')).toHaveText('2', { timeout: 60_000 });
    const before = await readScene(page);

    await openFile(page, 'oversized.3mf', zipOverTotalBudget());
    await expect
      .poll(async () => statusText(page), { timeout: 120_000 })
      /*
       * BOTH SIZES IN ONE SENTENCE — the whole point of Stage 6B-C1. A beta
       * tester read "too large" on a file that was small on disk and had no way
       * to learn the ceiling was about expanded bytes.
       */
      .toMatch(
        /on disk but expands to [\d.]+ [KMG]iB in total; Pybrix's total expansion limit is 512 MiB/i,
      );

    await expect(page.getByTestId('fact-parts')).toHaveText('2');
    await expect(page.getByTestId('fact-filename')).toHaveText('good.3mf');
    const after = await readScene(page);
    expect(after.modelObjects).toBe(before.modelObjects);
    expect(after.geometriesCreated).toBe(before.geometriesCreated);

    await openFile(page, 'next.3mf', threeMfSharedPlacements(4));
    await expect(page.getByTestId('fact-parts')).toHaveText('4', { timeout: 60_000 });
  });

  test('imports a document that reaches the part ceiling exactly', async ({ page }) => {
    test.setTimeout(180_000);

    // The other side of the boundary, through the real UI: 4,096 placements is
    // a document CAD Fixer holds, draws, and still shares one geometry for.
    await openFile(page, 'atlimit.3mf', threeMfPlacements(4_096));
    await expect(page.getByTestId('fact-parts')).toHaveText('4,096', { timeout: 120_000 });

    const scene = await readScene(page);
    expect(scene.modelObjects).toBe(4_096);
    expect(scene.sharedGeometries).toBe(1);
  });
});

/* --------------------------------------------------------- STL unchanged -- */

test('STL import is unchanged by the arrival of other formats', async ({ page }) => {
  const stl = binaryStl(64);
  await openFile(page, 'bracket.stl', stl.bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText('64', { timeout: 30_000 });
  await expect(page.getByTestId('fact-encoding')).toHaveText('binary');
  await expect(page.getByTestId('fact-units')).toContainText(/unspecified by stl/i);
  // One part, and therefore no selector: the STL user's experience is the same.
  await expect(page.getByTestId('part-selector')).toHaveCount(0);
  expect((await readScene(page)).modelObjects).toBe(1);
});

/* ------------------------------------------------- 6E-A2 eligibility -- */

test('6E-A4: a 3MF entry declared past the per-entry ceiling is refused by the shipped application', async ({
  page,
}) => {
  // Stage 6E-A2 productionised streamed ingestion and switched NOTHING on: the
  // shipped worker reads 3MF buffered, under the unchanged per-entry ceiling.
  await openFile(page, 'over-ceiling.3mf', threeMfOverEntryCeiling());
  await expect(page.getByTestId('status-list')).toContainText(
    /per-entry expansion limit is 320 MiB/i,
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('model-empty')).toBeAttached();
});
