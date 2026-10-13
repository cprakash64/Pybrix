import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { openAdvancedDiagnostics } from './repair-ui';
import {
  analysisHeavyStl,
  bowTieStl,
  degenerateFaceStl,
  nonManifoldEdgeStl,
  singleTriangleStl,
  tetrahedronStl,
  windingConflictStl,
} from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * Topology diagnostics, end to end, through the REAL worker.
 *
 * Nothing about the analysis is stubbed. A mocked topology engine would prove
 * that the mock works; what these tests establish is that a file on disk becomes
 * a correct report on screen, and that the report cannot be attached to the
 * wrong model.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** Waits for automatic analysis to produce a report for the loaded model. */
async function waitForReport(page: Page): Promise<void> {
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 30_000 });
}

/**
 * Imports, waits for the report, and opens the full Mesh Health report, which
 * REPAIR-UX-01 moved into the collapsed Advanced diagnostics section.
 */
async function importAndAnalyse(page: Page, name: string, bytes: Buffer): Promise<void> {
  await openFile(page, name, bytes);
  await waitForReport(page);
  await openAdvancedDiagnostics(page);
}

/**
 * Installs a `MutationObserver` that clicks a control the instant it appears.
 *
 * Cancellation tests are otherwise a race the test can only lose: the operation
 * may complete between Playwright noticing the button and Playwright clicking
 * it, and the resulting failure looks like a product defect. Arming the click
 * before the operation starts removes the window entirely.
 */
async function armCancelClick(page: Page, testId: string): Promise<void> {
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

/** Reads what the viewport actually drew. */
async function readSceneStats(
  page: Page,
): Promise<{ drawCalls: number; modelObjects: number; overlayObjects: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    return {
      drawCalls: Number(canvas?.dataset.drawCalls ?? 0),
      modelObjects: Number(canvas?.dataset.modelObjects ?? 0),
      overlayObjects: Number(canvas?.dataset.overlayObjects ?? 0),
    };
  });
}

/* ------------------------------------------------------------------ H1 -- */

test('H1: a clean closed model is analysed automatically and never called printable', async ({
  page,
}) => {
  await page.goto('/');
  // No "Analyze" button is pressed anywhere in this test. Analysis must start
  // on its own after import.
  await importAndAnalyse(page, 'tetrahedron.stl', tetrahedronStl());

  await expect(page.getByTestId('topology-headline')).toHaveText('No topological defects detected');
  await expect(page.getByTestId('topology-qualifier')).toHaveText(
    'Self-intersections and wall thickness have not yet been checked.',
  );

  await expect(page.getByTestId('topo-boundary-edges')).toHaveText('0');
  await expect(page.getByTestId('topo-nonmanifold-edges')).toHaveText('0');
  await expect(page.getByTestId('topo-nonmanifold-vertices')).toHaveText('0');
  await expect(page.getByTestId('topo-winding')).toHaveText('0');
  await expect(page.getByTestId('topo-vertices')).toHaveText('4');
  await expect(page.getByTestId('topo-edges')).toHaveText('6');

  await expect(page.getByTestId('health-selfintersection')).toHaveText('Not checked');
  await expect(page.getByTestId('health-thickness')).toHaveText('Not checked');
  await expect(page.getByTestId('health-printability')).toHaveText('Not yet determined');

  // The claim this whole stage exists to avoid.
  await expect(page.getByTestId('mesh-health')).not.toContainText('Printable');
  await expect(page.getByTestId('mesh-health')).not.toContainText('Watertight');
});

/* ------------------------------------------------------------------ H2 -- */

test('H2: an open model shows boundary edges, a loop, and a working overlay', async ({ page }) => {
  await page.goto('/');
  await importAndAnalyse(page, 'triangle.stl', singleTriangleStl());

  await expect(page.getByTestId('topo-boundary-edges')).toHaveText('3');
  await expect(page.getByTestId('topo-boundary-loops')).toHaveText('1');
  // Never described as a hole: an opening may be intended.
  await expect(page.getByTestId('mesh-health')).not.toContainText('Hole');

  const toggle = page.getByTestId('overlay-toggle-boundaryEdges');
  await expect(toggle).toBeEnabled();

  const before = await readSceneStats(page);
  await toggle.check();
  await expect(toggle).toBeChecked();

  // The overlay is a real GPU object, not just a checkbox that flipped.
  await expect
    .poll(async () => (await readSceneStats(page)).overlayObjects, { timeout: 10_000 })
    .toBeGreaterThan(0);

  // The model is still drawn, and the viewport still works.
  const after = await readSceneStats(page);
  expect(after.modelObjects).toBe(before.modelObjects);
  expect(after.drawCalls).toBeGreaterThan(0);
  await expect(page.getByTestId('fit-view')).toBeVisible();
});

/* ------------------------------------------------------------------ H3 -- */

test('H3: three triangles sharing an edge report one non-manifold edge', async ({ page }) => {
  await page.goto('/');
  await importAndAnalyse(page, 'nonmanifold.stl', nonManifoldEdgeStl());

  await expect(page.getByTestId('topo-nonmanifold-edges')).toHaveText('1');
  await expect(page.getByTestId('topo-edge-manifold')).toHaveText('No');

  const toggle = page.getByTestId('overlay-toggle-nonManifoldEdges');
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await expect
    .poll(async () => (await readSceneStats(page)).overlayObjects, { timeout: 10_000 })
    .toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ H4 -- */

test('H4: the bow-tie reaches the UI as a VERTEX defect with no edge defect', async ({ page }) => {
  await page.goto('/');
  await importAndAnalyse(page, 'bowtie.stl', bowTieStl());

  // The whole point: every edge has at most two faces, so an interface that
  // reduced manifoldness to an edge count would show this model as clean.
  await expect(page.getByTestId('topo-nonmanifold-edges')).toHaveText('0');
  await expect(page.getByTestId('topo-nonmanifold-vertices')).toHaveText('1');
  await expect(page.getByTestId('topo-components')).toHaveText('2');

  // Edge and vertex manifoldness are reported separately, not collapsed.
  await expect(page.getByTestId('topo-edge-manifold')).toHaveText('Yes');
  await expect(page.getByTestId('topo-vertex-manifold')).toHaveText('No');

  await expect(page.getByTestId('topology-headline')).toHaveText('Topological issues detected');
});

/* ------------------------------------------------------------------ H5 -- */

test('H5: wrongly wound neighbours report a winding conflict with an overlay', async ({ page }) => {
  await page.goto('/');
  await importAndAnalyse(page, 'winding.stl', windingConflictStl());

  await expect(page.getByTestId('topo-winding')).toHaveText('1');
  await expect(page.getByTestId('topo-winding-consistent')).toHaveText('No');

  const toggle = page.getByTestId('overlay-toggle-windingConflictEdges');
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await expect
    .poll(async () => (await readSceneStats(page)).overlayObjects, { timeout: 10_000 })
    .toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ H6 -- */

test('H6: a collinear triangle is reported as zero-area with an overlay', async ({ page }) => {
  await page.goto('/');
  await importAndAnalyse(page, 'degenerate.stl', degenerateFaceStl());

  await expect(page.getByTestId('topo-zero-area')).toHaveText('1');
  await expect(page.getByTestId('topo-repeated-position')).toHaveText('0');

  const toggle = page.getByTestId('overlay-toggle-degenerateFaces');
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await expect
    .poll(async () => (await readSceneStats(page)).overlayObjects, { timeout: 10_000 })
    .toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ H7 -- */

test('H7: cancelling analysis keeps the model and installs no partial report', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const heavy = analysisHeavyStl(300);

  // ARMED BEFORE THE IMPORT, so the click lands in the same microtask the
  // control appears rather than on Playwright's polling interval. Waiting for
  // the button and then clicking it is a race the test loses on a fast machine:
  // analysis can finish inside the gap, and the failure looks like a product
  // bug rather than a test one.
  await armCancelClick(page, 'cancel-analysis');

  await openFile(page, 'heavy.stl', heavy.bytes);

  await expect(page.getByTestId('analysis-cancelled')).toBeVisible({ timeout: 60_000 });

  // The model survived, and no report was installed.
  await expect(page.getByTestId('fact-triangles')).toHaveText(heavy.triangles.toLocaleString());
  await expect(page.getByTestId('topology-headline')).toHaveCount(0);
  await openInspector(page);
  await expect(page.getByTestId('export-binary')).toBeEnabled();

  // And the user can run it again, from the workspace's primary action.
  const rerun = page.getByTestId('analyze-mesh');
  await expect(rerun).toBeVisible();
  await rerun.click();
  await waitForReport(page);
});

/* ------------------------------------------------------------------ H8 -- */

test('H8: a superseded analysis cannot populate the replacement model', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');

  // M0 is heavy, so its analysis is still running when M1 arrives. Whether it
  // is still running does not actually decide the outcome — that is the point.
  // Even if M0's analysis completes, its report names M0 and must be refused.
  const heavy = analysisHeavyStl(300);
  await openFile(page, 'first.stl', heavy.bytes);
  await expect(page.getByTestId('health-filename')).toHaveText('first.stl', { timeout: 60_000 });

  // M1 is a tetrahedron: four triangles, unmistakable numbers.
  await openFile(page, 'second.stl', tetrahedronStl());
  await expect(page.getByTestId('fact-triangles')).toHaveText('4', { timeout: 60_000 });

  await waitForReport(page);

  // M1's own report, not M0's. M0 has tens of thousands of boundary edges; the
  // tetrahedron has none.
  await expect(page.getByTestId('topo-boundary-edges')).toHaveText('0');
  await expect(page.getByTestId('topo-vertices')).toHaveText('4');
  await expect(page.getByTestId('health-filename')).toHaveText('second.stl');

  // No overlay from M0 survived into M1's scene.
  await expect
    .poll(async () => (await readSceneStats(page)).overlayObjects, { timeout: 10_000 })
    .toBe(0);
  const stats = await readSceneStats(page);
  expect(stats.modelObjects).toBe(1);
});

/* ------------------------------------------------------------------ H9 -- */

test('H9: losing the worker clears the model, the report, and the overlays', async ({ page }) => {
  await page.goto('/');
  await importAndAnalyse(page, 'triangle.stl', singleTriangleStl());
  await page.getByTestId('overlay-toggle-boundaryEdges').check();
  await expect
    .poll(async () => (await readSceneStats(page)).overlayObjects, { timeout: 10_000 })
    .toBeGreaterThan(0);

  // A GENUINE crash, not a simulated one. The error is thrown inside the real
  // worker; an uncaught worker error fires the `error` event on the parent's
  // Worker object, which is exactly the path the client listens on. No test
  // hook exists in production code for this — exposing the Worker on a global
  // so a test could poke it would be a back door that outlives the test.
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

  // Policy A: the model is discarded rather than left on screen looking usable.
  await expect(page.getByTestId('model-empty')).toBeAttached({ timeout: 20_000 });
  await expect(page.getByTestId('repair-overview')).toHaveCount(0);
  await expect(page.getByTestId('issue-list')).toHaveCount(0);
  await expect(page.getByTestId('topology-headline')).toHaveCount(0);
  await expect
    .poll(async () => (await readSceneStats(page)).overlayObjects, { timeout: 10_000 })
    .toBe(0);

  // Re-import recovers the session.
  await importAndAnalyse(page, 'tetrahedron.stl', tetrahedronStl());
  await expect(page.getByTestId('topo-boundary-edges')).toHaveText('0');
});

/* ----------------------------------------------------------------- H10 -- */

test('H10: nothing leaves the browser during import, analysis, overlays, or export', async ({
  page,
}) => {
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on('request', (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      body: request.postData(),
    });
  });

  await page.goto('/');
  await importAndAnalyse(page, 'bowtie.stl', bowTieStl());
  // Boundary edges, not non-manifold edges: the bow-tie's defect is a VERTEX,
  // so its non-manifold-edge count is zero and that toggle is correctly
  // disabled. Picking it here would have been testing the wrong thing.
  await page.getByTestId('overlay-toggle-boundaryEdges').check();

  const download = page.waitForEvent('download');
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  await download;

  // Every request must be a first-party asset fetched by the document itself.
  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    expect(request.url.startsWith(origin), `unexpected origin: ${request.url}`).toBe(true);
    // No request may carry a body at all: nothing here should ever POST.
    expect(request.body, `unexpected request body on ${request.url}`).toBeNull();
    expect(['GET', 'HEAD'], `unexpected method on ${request.url}`).toContain(request.method);
    // And no model identity may leak through a query string.
    expect(request.url).not.toContain('bowtie');
  }
});

/* ----------------------------------------------------------------- H11 -- */

test('H11: viewport controls keep working with overlays visible', async ({ page }) => {
  await page.goto('/');
  await importAndAnalyse(page, 'triangle.stl', singleTriangleStl());
  await page.getByTestId('overlay-toggle-boundaryEdges').check();
  await expect
    .poll(async () => (await readSceneStats(page)).overlayObjects, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const canvas = page.locator('[data-testid="viewport-canvas"] canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;

  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;

  // Orbit.
  await page.mouse.move(centreX, centreY);
  await page.mouse.down();
  await page.mouse.move(centreX + 80, centreY + 40, { steps: 8 });
  await page.mouse.up();

  // Zoom.
  await page.mouse.move(centreX, centreY);
  await page.mouse.wheel(0, -240);

  // Pan (right-drag with OrbitControls' default mapping).
  await page.mouse.move(centreX, centreY);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(centreX - 60, centreY - 30, { steps: 6 });
  await page.mouse.up({ button: 'right' });

  await page.getByTestId('fit-view').click();

  // Still drawing both the model and its overlay after all of that.
  const stats = await readSceneStats(page);
  expect(stats.drawCalls).toBeGreaterThan(0);
  expect(stats.modelObjects).toBe(1);
  expect(stats.overlayObjects).toBeGreaterThan(0);
});

/* ----------------------------------------------------------------- H12 -- */

test('H12: diagnostics are reachable and operable from the keyboard', async ({ page }) => {
  await page.goto('/');
  await importAndAnalyse(page, 'triangle.stl', singleTriangleStl());

  // A named landmark with a heading, so the section is findable.
  const panel = page.getByRole('region', { name: 'Mesh Health' });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Mesh Health' })).toBeVisible();

  // Overlay toggles are real checkboxes with accessible names, operable by
  // keyboard rather than by click only.
  const toggle = page.getByTestId('overlay-toggle-boundaryEdges');
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();

  const named = page.getByRole('checkbox', { name: /Boundary edges/ });
  await expect(named).toHaveCount(1);

  // The file picker works without drag and drop.
  await expect(page.getByTestId('browse-button')).toBeVisible();

  // Cancellation is reachable from the keyboard while an analysis runs.
  //
  // Checked by a MutationObserver armed before the import rather than by
  // waiting and then focusing: the analysis can finish inside the gap between
  // Playwright seeing the button and Playwright focusing it, and the failure
  // would look like an accessibility defect instead of a test race.
  await page.evaluate(() => {
    const inspect = (): boolean => {
      const button = document.querySelector<HTMLElement>('[data-testid="cancel-analysis"]');
      if (button === null) return false;
      button.focus();
      Object.assign(globalThis, {
        __cancelAccessible:
          button.tagName === 'BUTTON' &&
          document.activeElement === button &&
          button.textContent.trim().length > 0,
      });
      return true;
    };
    if (inspect()) return;
    const observer = new MutationObserver(() => {
      if (inspect()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  await openFile(page, 'heavy.stl', analysisHeavyStl(300).bytes);

  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (globalThis as unknown as { __cancelAccessible?: boolean }).__cancelAccessible,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
});

/* ------------------------------------------- J1: responsiveness ---------- */
