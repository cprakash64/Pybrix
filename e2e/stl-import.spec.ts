import { expect, test, type Page } from '@playwright/test';
import { asciiStl, binaryStl, binaryStlWithSolidHeader, truncatedBinaryStl } from './stl-fixtures';

/**
 * The STL pipeline, end to end, in a real browser against the production build.
 *
 * Everything here runs through the REAL module worker and the REAL WebGL
 * viewport. Nothing is stubbed: a test that mocked the worker would prove only
 * that the mock works.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** Reads what the viewport actually drew, not what React state claims. */
async function readSceneStats(page: Page): Promise<{ drawCalls: number; triangles: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    return {
      drawCalls: Number(canvas?.dataset.drawCalls ?? 0),
      triangles: Number(canvas?.dataset.renderedTriangles ?? 0),
    };
  });
}

test('imports a binary STL and displays it', async ({ page }) => {
  await page.goto('/');
  const { bytes, triangles } = binaryStl(2000);

  await openFile(page, 'bracket.stl', bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 20_000,
  });
  await expect(page.getByTestId('fact-encoding')).toHaveText('binary');
  await expect(page.getByTestId('fact-vertices')).toHaveText((triangles * 3).toLocaleString());
  await expect(page.getByTestId('validation-summary')).toHaveText('File structure valid');

  // The empty-workspace notice must be gone and the fit control available,
  // which only happens once a model is actually in the scene.
  await expect(page.getByTestId('viewport-empty')).toHaveCount(0);
  await expect(page.getByTestId('fit-view')).toBeVisible();
});

test('actually renders geometry, not just React state', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'bracket.stl', binaryStl(1200).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('1,200', { timeout: 20_000 });

  const stats = await readSceneStats(page);

  // The renderer reports what it drew on the previous frame. A non-zero
  // triangle count proves the pipeline reached the GPU.
  expect(stats.drawCalls).toBeGreaterThan(0);
  expect(stats.triangles).toBeGreaterThan(0);
});

test('imports an ASCII STL', async ({ page }) => {
  await page.goto('/');
  const { bytes, triangles } = asciiStl(300);

  await openFile(page, 'bracket-ascii.stl', bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 20_000,
  });
  await expect(page.getByTestId('fact-encoding')).toHaveText('ascii');
});

test('detects a binary STL whose header begins with "solid"', async ({ page }) => {
  await page.goto('/');
  const { bytes, triangles } = binaryStlWithSolidHeader(500);

  await openFile(page, 'misleading.stl', bytes);

  // The classic detection failure: this file must not be read as ASCII.
  await expect(page.getByTestId('fact-encoding')).toHaveText('binary', { timeout: 20_000 });
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString());
});

test('states that STL units are unspecified rather than inventing millimetres', async ({
  page,
}) => {
  await page.goto('/');

  await openFile(page, 'bracket.stl', binaryStl(50).bytes);

  await expect(page.getByTestId('fact-units')).toHaveText('Unspecified by STL', {
    timeout: 20_000,
  });
});

test('reports bounding-box dimensions', async ({ page }) => {
  await page.goto('/');

  await openFile(page, 'bracket.stl', binaryStl(600).bytes);

  await expect(page.getByTestId('fact-size')).not.toBeEmpty({ timeout: 20_000 });
  await expect(page.getByTestId('fact-size')).toContainText('×');
});

test('fit view keeps the model on screen', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'bracket.stl', binaryStl(800).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('800', { timeout: 20_000 });

  await page.getByTestId('fit-view').click();

  const stats = await readSceneStats(page);
  expect(stats.triangles).toBeGreaterThan(0);
});

test('rejects a truncated binary STL and keeps the workspace empty', async ({ page }) => {
  await page.goto('/');

  await openFile(page, 'broken.stl', truncatedBinaryStl());

  await expect(page.getByTestId('status-list')).toContainText('truncated', { timeout: 20_000 });
  await expect(page.getByTestId('model-empty')).toBeAttached();
});

test('a failed replacement import keeps the previously loaded model', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'good.stl', binaryStl(700).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('700', { timeout: 20_000 });

  await openFile(page, 'broken.stl', truncatedBinaryStl());
  await expect(page.getByTestId('status-list')).toContainText('truncated', { timeout: 20_000 });

  // The user's loaded model must survive someone else's broken file.
  await expect(page.getByTestId('fact-filename')).toHaveText('good.stl');
  await expect(page.getByTestId('fact-triangles')).toHaveText('700');
});

test('a successful replacement import swaps the model', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'first.stl', binaryStl(400).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('400', { timeout: 20_000 });

  await openFile(page, 'second.stl', binaryStl(900).bytes);

  await expect(page.getByTestId('fact-triangles')).toHaveText('900', { timeout: 20_000 });
  await expect(page.getByTestId('fact-filename')).toHaveText('second.stl');
});

test('loading many models does not grow the scene graph', async ({ page }) => {
  await page.goto('/');

  for (const triangles of [100, 200, 300, 400]) {
    await openFile(page, `model-${String(triangles)}.stl`, binaryStl(triangles).bytes);
    await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
      timeout: 20_000,
    });
  }

  // One model object, regardless of how many have been loaded. A leak here
  // would mean every import left its GPU buffers behind.
  const objects = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    return Number(canvas?.dataset.modelObjects ?? -1);
  });
  expect(objects).toBe(1);
});

test('the main thread stays responsive while a large STL parses', async ({ page }) => {
  await page.goto('/');

  // WHY THIS SHAPE. The previous version of this test asserted that the progress
  // indicator was still visible while it poked at the page — which is a race:
  // on a fast machine the import finishes first and the assertion fails for a
  // reason unrelated to responsiveness.
  //
  // Instead this measures the LONGEST GAP between consecutive animation frames
  // across the whole import, and compares it against the import's own duration.
  // That comparison is self-scaling: it has no millisecond threshold in it, and
  // it fails hard for the one reason we care about. If parsing ran on the main
  // thread, the frame loop would be starved for the entire parse, so the
  // longest gap would approach the whole duration. With the parse in a worker,
  // frames keep arriving at display cadence no matter how slow the machine is.
  const { bytes, triangles } = binaryStl(900_000);
  await openFile(page, 'large.stl', bytes);

  // The sampler starts AFTER the file has been handed to the page. Playwright
  // materialising a 45 MB File is its own multi-second main-thread stall, and
  // measuring it would say nothing about our code.
  //
  // It also stops the moment the model appears. That bound matters: a
  // measurement running past the import picks up a ~1 s stall that occurs after
  // the model is already on screen — garbage collection of the detached file
  // buffer and the ~75 MB of geometry that replaced it. That stall is real and
  // recorded in docs/PERFORMANCE_BASELINE.md, but it has nothing to do with
  // whether parsing blocked the interface, which is what this test exists to
  // prove.
  await page.evaluate(() => {
    const gaps: number[] = [];
    let previous = performance.now();
    const startedAt = previous;
    let running = true;
    let finishedAt: number | undefined;

    const tick = (): void => {
      if (!running) return;
      const now = performance.now();
      if (finishedAt === undefined) gaps.push(now - previous);
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // The deterministic end of the import window: the moment the model's
    // triangle count is in the document.
    const observer = new MutationObserver(() => {
      if (finishedAt !== undefined) return;
      if (document.querySelector('[data-testid="fact-triangles"]') !== null) {
        finishedAt = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    Object.assign(globalThis, {
      __stopFrames: (): { frames: number; longestGapMs: number; durationMs: number } => {
        running = false;
        observer.disconnect();
        return {
          frames: gaps.length,
          longestGapMs: gaps.length === 0 ? 0 : Math.max(...gaps),
          durationMs: (finishedAt ?? performance.now()) - startedAt,
        };
      },
    });
  });

  // Wait on the operation actually completing — a deterministic signal — rather
  // than on a transient UI state.
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 120_000,
  });

  const measurement = await page.evaluate(() =>
    (
      globalThis as unknown as {
        __stopFrames: () => { frames: number; longestGapMs: number; durationMs: number };
      }
    ).__stopFrames(),
  );

  // The frame loop kept running throughout the import.
  expect(measurement.frames).toBeGreaterThan(5);
  // And no single stall came close to swallowing it. A main-thread parse would
  // produce a gap on the order of the whole import duration.
  expect(measurement.longestGapMs).toBeLessThan(measurement.durationMs / 3);
});

test('a cancelled import leaves the previous model in place', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'keep-me.stl', binaryStl(500).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('500', { timeout: 20_000 });

  // The cancel click is driven by a MutationObserver installed BEFORE the import
  // starts, so it fires in the same microtask the control appears rather than on
  // Playwright's polling interval. That removes the window in which a fast
  // machine could finish the import before the test managed to click.
  await page.evaluate(() => {
    const clickWhenPresent = (): boolean => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="cancel-import"]');
      if (button === null) return false;
      button.click();
      return true;
    };
    if (clickWhenPresent()) return;
    const observer = new MutationObserver(() => {
      if (clickWhenPresent()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  await openFile(page, 'huge.stl', binaryStl(900_000).bytes);

  await expect(page.getByTestId('status-list')).toContainText('cancelled', { timeout: 60_000 });
  await expect(page.getByTestId('fact-filename')).toHaveText('keep-me.stl');
  await expect(page.getByTestId('fact-triangles')).toHaveText('500');
});
