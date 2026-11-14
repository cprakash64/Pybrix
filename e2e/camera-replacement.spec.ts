import { expect, test, type Page } from '@playwright/test';
import { binaryStlFrom, type Point } from './stl-fixtures';

/**
 * v0.7.1 — an entirely new document must be framed once, from its own bounds.
 *
 * The owner's reproduction: open model A, then open model B without refreshing; B loads but the
 * camera keeps A's framing. The viewport publishes three facts for this, so a test reads what the
 * camera actually did rather than guessing from a screenshot:
 *
 *  - `data-document-fit-count`: how many times a newly installed document was framed;
 *  - `data-camera-distance`:    camera-to-target distance;
 *  - `data-camera-fit-ratio`:   model radius over the radius the camera sees. It is exactly
 *                               1 / FIT_PADDING (1.35) when the camera is fitted to the model, and
 *                               far from it when another model's framing was kept.
 */

const FITTED = 1 / 1.35;
const FIT_TOLERANCE = 0.02;

/** A closed cube of the given edge, centred on `at`. 12 triangles, wound outward. */
function cube(edge: number, at: Point): Buffer {
  const h = edge / 2;
  const v = (x: number, y: number, z: number): Point => [
    at[0] + x * h,
    at[1] + y * h,
    at[2] + z * h,
  ];
  const p = [
    v(-1, -1, -1),
    v(1, -1, -1),
    v(1, 1, -1),
    v(-1, 1, -1),
    v(-1, -1, 1),
    v(1, -1, 1),
    v(1, 1, 1),
    v(-1, 1, 1),
  ] as const;
  const faces: readonly (readonly [number, number, number])[] = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [2, 3, 7],
    [2, 7, 6],
    [1, 2, 6],
    [1, 6, 5],
    [3, 0, 4],
    [3, 4, 7],
  ];
  const corner = (index: number): Point => {
    const point = p[index];
    if (point === undefined) throw new Error(`cube corner ${String(index)} does not exist`);
    return point;
  };
  return binaryStlFrom(faces.map(([a, b, c]) => [corner(a), corner(b), corner(c)]));
}

const SMALL = (): Buffer => cube(10, [0, 0, 0]);
const HUGE = (): Buffer => cube(2000, [1500, -900, 400]);
const MEDIUM = (): Buffer => cube(80, [-30, 12, 7]);

const canvas = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-testid="viewport-canvas"] canvas');

interface CameraFacts {
  readonly fits: number;
  readonly distance: number;
  readonly ratio: number;
  readonly frames: number;
}

async function camera(page: Page): Promise<CameraFacts> {
  const read = async (name: string): Promise<number> =>
    Number((await canvas(page).getAttribute(name)) ?? 'NaN');
  return {
    fits: await read('data-document-fit-count'),
    distance: await read('data-camera-distance'),
    ratio: await read('data-camera-fit-ratio'),
    frames: await read('data-rendered-frames'),
  };
}

/** Opens a file through the top bar's Open control, as the owner did, and waits for it to be framed. */
async function open(page: Page, name: string, bytes: Buffer, fitsBefore: number): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
  // The document is installed when the viewport counts one more fit for it.
  await expect
    .poll(async () => (await camera(page)).fits, { timeout: 60_000 })
    .toBeGreaterThan(fitsBefore);
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
}

async function zoomOutAndOrbit(page: Page): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (box === null) throw new Error('no viewport canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 - 60, { steps: 6 });
  await page.mouse.up();
}

function expectFitted(facts: CameraFacts): void {
  expect(Math.abs(facts.ratio - FITTED)).toBeLessThan(FIT_TOLERANCE);
}

test('CAMERA-REPLACE-01: opening model B without a refresh frames B, once', async ({ page }) => {
  await page.goto('/');
  await open(page, 'small.stl', SMALL(), 0);
  const first = await camera(page);
  expect(first.fits).toBe(1);
  expectFitted(first);

  // A non-default camera: zoomed out and orbited, as a person who has been looking at A leaves it.
  await zoomOutAndOrbit(page);
  expect((await camera(page)).distance).not.toBeCloseTo(first.distance, 1);

  await open(page, 'huge.stl', HUGE(), first.fits);
  const second = await camera(page);
  expect(second.fits).toBe(first.fits + 1);
  expectFitted(second);

  // Fitted ONCE: nothing refits afterwards, however long the page runs.
  await page.waitForTimeout(800);
  const later = await camera(page);
  expect(later.fits).toBe(second.fits);
  expect(later.distance).toBeCloseTo(second.distance, 3);
});

test('CAMERA-REPLACE-01b: the same replacement while the Split workspace is open', async ({
  page,
}) => {
  await page.goto('/');
  await open(page, 'small.stl', SMALL(), 0);
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  const before = await camera(page);
  await zoomOutAndOrbit(page);

  await open(page, 'huge.stl', HUGE(), before.fits);
  const after = await camera(page);
  expect(after.fits).toBe(before.fits + 1);
  expectFitted(after);
});

test('CAMERA-REPLACE-02: a large model replaced by a small one is framed too', async ({ page }) => {
  await page.goto('/');
  await open(page, 'huge.stl', HUGE(), 0);
  const big = await camera(page);
  expectFitted(big);
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();

  await open(page, 'medium.stl', MEDIUM(), big.fits);
  const medium = await camera(page);
  expect(medium.fits).toBe(big.fits + 1);
  expectFitted(medium);
  // The camera moved in to the smaller model's scale; it did not stay where the large one was.
  expect(medium.distance).toBeLessThan(big.distance / 5);
});

test('CAMERA-FIRST-01: a fresh page and a replacement frame the same model identically', async ({
  browser,
  page,
}) => {
  await page.goto('/');
  await open(page, 'small.stl', SMALL(), 0);
  await open(page, 'huge.stl', HUGE(), 1);
  const replaced = await camera(page);

  const fresh = await browser.newPage();
  await fresh.goto('/');
  await open(fresh, 'huge.stl', HUGE(), 0);
  const direct = await camera(fresh);
  await fresh.close();

  expect(direct.fits).toBe(1);
  expect(Math.abs(replaced.ratio - direct.ratio)).toBeLessThan(0.005);
  expect(Math.abs(replaced.distance - direct.distance) / direct.distance).toBeLessThan(0.005);
});

test('CAMERA-NO-REFIT-01: ordinary interaction and re-rendering never reframe the document', async ({
  page,
}) => {
  await page.goto('/');
  await open(page, 'small.stl', SMALL(), 0);
  await zoomOutAndOrbit(page);
  const set = await camera(page);

  for (const workspace of ['workflow-convert', 'workflow-split', 'workflow-repair']) {
    await page.getByTestId(workspace).click();
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
  const after = await camera(page);
  expect(after.fits).toBe(set.fits);
  expect(after.distance).toBeCloseTo(set.distance, 3);
});
