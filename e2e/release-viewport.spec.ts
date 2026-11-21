import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';

/**
 * BQ09–BQ16 — HOW MUCH GPU MEMORY THE VIEWPORT IS ALLOWED TO ASK FOR.
 *
 * Stage 5A deferred this. The risk is concrete and easy to get wrong: a
 * framebuffer is `width * height * devicePixelRatio²` pixels, so a 4K viewport on
 * a DPR 3 display is 36 times the allocation of the same viewport at DPR 1. An
 * application that hands `window.devicePixelRatio` straight to the renderer is
 * one external monitor away from an allocation nobody measured.
 *
 * CAD Fixer clamps at `MAX_PIXEL_RATIO = 2`, and these tests are the evidence for
 * that number rather than a restatement of it: they drive the real browser at
 * device scale factors 1, 2 and 3 and read the canvas's actual BACKING STORE,
 * which is the thing that costs memory. The clamp is only honest if the backing
 * store stops growing at 2 — so that is what is asserted, at DPR 3, where an
 * unclamped renderer would be caught.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** The canvas's real drawing-buffer size, and the CSS box it is shown in. */
async function backingStore(page: Page): Promise<{
  drawWidth: number;
  drawHeight: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  pixels: number;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport-canvas"] canvas',
    );
    if (canvas === null) throw new Error('no canvas');
    const box = canvas.getBoundingClientRect();
    return {
      drawWidth: canvas.width,
      drawHeight: canvas.height,
      cssWidth: Math.round(box.width),
      cssHeight: Math.round(box.height),
      dpr: globalThis.devicePixelRatio,
      pixels: canvas.width * canvas.height,
    };
  });
}

/** The effective ratio the renderer actually used, derived from what it drew. */
function effectiveRatio(m: { drawWidth: number; cssWidth: number }): number {
  return m.cssWidth === 0 ? 0 : m.drawWidth / m.cssWidth;
}

for (const dpr of [1, 2, 3] as const) {
  test(`BQ09-BQ11: the backing store honours the qualified ratio ceiling at DPR ${String(dpr)}`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ deviceScaleFactor: dpr });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await openFile(page, 'small.stl', binaryStl(400).bytes);
      await revealControl(page, page.getByTestId('issue-list'));
      await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

      const measured = await backingStore(page);
      expect(measured.dpr).toBe(dpr);
      expect(measured.cssWidth).toBeGreaterThan(0);

      /*
       * THE CEILING IS 2, AND DPR 3 IS THE CASE THAT PROVES IT. At 1 and 2 a
       * clamped and an unclamped renderer are indistinguishable; at 3 they differ
       * by 125% more pixels, so this is the assertion that would fail if the
       * clamp were removed.
       */
      const ratio = effectiveRatio(measured);
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThanOrEqual(2 + 0.05);
      if (dpr <= 2) expect(ratio).toBeCloseTo(dpr, 1);
    } finally {
      await context.close();
    }
  });
}

test('BQ12, BQ13: a 4K-like viewport stays within the ratio ceiling at high DPR', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  for (const dpr of [1, 2] as const) {
    const context = await browser.newContext({
      viewport: { width: 3840, height: 2160 },
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await openFile(page, 'small.stl', binaryStl(400).bytes);
      await revealControl(page, page.getByTestId('issue-list'));
      await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

      const measured = await backingStore(page);
      expect(effectiveRatio(measured)).toBeLessThanOrEqual(2 + 0.05);

      /*
       * RECORDED AS AN ABSOLUTE BOUND TOO, because a ratio alone does not say
       * whether the allocation is survivable. 3840 x 2160 at ratio 2 is about
       * 33.2 million pixels — roughly 133 MB at 4 bytes each, before depth. The
       * bound below is the qualified envelope for this stage: the largest
       * viewport this release is qualified at, times the ratio ceiling, with
       * headroom for the browser's own chrome.
       */
      expect(measured.pixels).toBeLessThan(40_000_000);
      // And the viewport really is what we asked for, so this is not a pass by
      // accident of a small window.
      expect(measured.cssWidth).toBeGreaterThan(2000);
    } finally {
      await context.close();
    }
  }
});

test('BQ14, BQ15, BQ16: 100 resize cycles leave the canvas bounded and aligned', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await openFile(page, 'small.stl', binaryStl(600).bytes);
    await revealControl(page, page.getByTestId('issue-list'));
    await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 60_000 });

    const sizes: readonly { width: number; height: number }[] = [
      { width: 960, height: 720 },
      { width: 1600, height: 900 },
      { width: 1280, height: 1024 },
      { width: 1920, height: 1080 },
    ];

    let peakPixels = 0;
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const size = sizes[cycle % sizes.length];
      if (size === undefined) continue;
      await page.setViewportSize(size);
      if (cycle % 25 === 0) {
        const measured = await backingStore(page);
        peakPixels = Math.max(peakPixels, measured.pixels);
      }
    }

    // Settle on a known size and read the final state.
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect
      .poll(async () => (await backingStore(page)).cssWidth, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const settled = await backingStore(page);

    /*
     * NO RUNAWAY. The backing store tracks the CURRENT box, not the largest box
     * ever seen — a renderer that grew monotonically, or that never released an
     * old target, would show a final size larger than the final viewport.
     */
    expect(effectiveRatio(settled)).toBeLessThanOrEqual(2 + 0.05);
    expect(settled.drawWidth).toBeLessThanOrEqual(Math.ceil(settled.cssWidth * 2) + 2);
    expect(settled.drawHeight).toBeLessThanOrEqual(Math.ceil(settled.cssHeight * 2) + 2);
    expect(peakPixels).toBeLessThan(40_000_000);

    /*
     * BQ15. AND IT IS STILL DRAWING THE MODEL. A viewport that survived 100
     * resizes by giving up would pass every bound above.
     */
    const drawn = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '[data-testid="viewport-canvas"] canvas',
      );
      return {
        triangles: Number(canvas?.dataset.renderedTriangles ?? 0),
        objects: Number(canvas?.dataset.modelObjects ?? 0),
      };
    });
    expect(drawn.objects).toBe(1);
    expect(drawn.triangles).toBe(600);
    await expect(page.getByTestId('viewport-error')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
