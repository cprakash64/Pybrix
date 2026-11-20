import { expect, test, type Download, type Page } from '@playwright/test';
import { revealControl } from './progressive-disclosure';
import { binaryStlFrom, type Point } from './stl-fixtures';
import { readStlArtifact } from './artifact-oracles';

/**
 * RELEASE 2, STAGE EC-5 — CHANGING A CONNECTOR, THROUGH THE SHIPPED APPLICATION, JUDGED BY THE FILES IT WRITES.
 *
 * A real file, the real picker, the real worker, the real Manifold kernel, and the two exported pieces read back here. As in the Stage
 * C03-C check, nothing depends on a number the product computes about its own pins: the pieces' volumes are added up with the divergence
 * theorem (written out here), the cube they were cut from is subtracted, and what is left is the pin minus its socket:
 *
 *   volume(A) + volume(B) − volume(cube)  =  depth × 16 sin(π/16) × (r² − (r + clearance)²)
 *
 * for a 32-sided cylinder of radius r. That is −15.733 mm³ for the default Ø4 / 6 / 0.2 mm pin, −11.992 mm³ once the diameter is changed
 * to 3, and exactly nothing once the connectors are taken off. An editor that rebuilt on top of the old pin, left the old socket, or
 * undid nothing would be out by more than the whole value.
 */
const CUBE_MM = 30;
const net = (diameter: number, depth: number, clearance: number): number =>
  depth * 16 * Math.sin(Math.PI / 16) * ((diameter / 2) ** 2 - (diameter / 2 + clearance) ** 2);

type Tri = readonly [Point, Point, Point];
function cube(size: number): Tri[] {
  const h = size / 2;
  const c: Point[] = [
    [-h, -h, -h],
    [h, -h, -h],
    [-h, h, -h],
    [h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [-h, h, h],
    [h, h, h],
  ];
  const f: readonly (readonly [number, number, number])[] = [
    [0, 2, 3],
    [0, 3, 1],
    [4, 5, 7],
    [4, 7, 6],
    [0, 1, 5],
    [0, 5, 4],
    [2, 6, 7],
    [2, 7, 3],
    [0, 4, 6],
    [0, 6, 2],
    [1, 3, 7],
    [1, 7, 5],
  ];
  return f.map(([a, b, d]) => [c[a] ?? [0, 0, 0], c[b] ?? [0, 0, 0], c[d] ?? [0, 0, 0]]);
}
function volumeOf(bytes: Buffer): number {
  const { corners } = readStlArtifact(bytes);
  let sum = 0;
  for (let i = 0; i < corners.length; i += 9) {
    const [ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0] = corners.slice(
      i,
      i + 9,
    );
    sum += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return sum;
}

async function open(page: Page): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'cube.stl',
    mimeType: 'model/stl',
    buffer: binaryStlFrom(cube(CUBE_MM)),
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
}

async function splitWithDefaultPin(page: Page): Promise<void> {
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  await revealControl(page, page.getByTestId('split-connector-pin'));
  await page.getByTestId('split-connector-pin').check();
  await page.getByTestId('split-unit-interpretation-millimeter').check();
  await revealControl(page, page.getByTestId('split-pin-diameter'));
  await page.getByTestId('split-pin-diameter').fill('4');
  await revealControl(page, page.getByTestId('split-depth'));
  await page.getByTestId('split-depth').fill('6');
  await revealControl(page, page.getByTestId('split-clearance'));
  await page.getByTestId('split-clearance').fill('0.2');
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('connector-editor')).toBeVisible({ timeout: 60_000 });
}

/** Exports both pieces as STL and returns the net volume the pin leaves, in cubic millimetres. */
async function netVolume(page: Page): Promise<number> {
  const downloads: Buffer[] = [];
  const listener = (download: Download): void => {
    void (async (): Promise<void> => {
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      downloads.push(Buffer.concat(chunks));
    })();
  };
  page.on('download', listener);
  await page.getByTestId('split-export').click();
  await expect.poll(() => downloads.length, { timeout: 60_000 }).toBe(2);
  page.off('download', listener);
  const [a = 0, b = 0] = downloads.map(volumeOf);
  return a + b - CUBE_MM ** 3;
}

async function checkAndApply(
  page: Page,
  press: 'connector-edit-check' | 'connector-edit-remove',
): Promise<void> {
  await page.getByTestId(press).click();
  await expect(page.getByTestId('connector-edit-preview-label')).toHaveText(
    'Preview — not applied',
    {
      timeout: 60_000,
    },
  );
  await page.getByTestId('connector-edit-apply').click();
  await expect(page.getByTestId('connector-edit-undo')).toBeVisible({ timeout: 60_000 });
}

test('changing a connector in the application changes the pieces it writes, and undo puts them back', async ({
  page,
}) => {
  await page.goto('/');
  await open(page);
  await splitWithDefaultPin(page);
  expect(await netVolume(page)).toBeCloseTo(net(4, 6, 0.2), 0);

  // size: the diameter becomes 3 mm. The model is untouched until Apply, and the preview says so.
  await page.getByTestId('connector-edit-diameter').fill('3');
  await page.getByTestId('connector-edit-check').click();
  await expect(page.getByTestId('connector-edit-preview-text')).toContainText(
    'Pin diameter 4 to 3 mm',
    {
      timeout: 60_000,
    },
  );
  expect(await netVolume(page)).toBeCloseTo(net(4, 6, 0.2), 0);
  await page.getByTestId('connector-edit-apply').click();
  await expect(page.getByTestId('connector-edit-undo')).toBeVisible({ timeout: 60_000 });
  const changed = await netVolume(page);
  expect(changed).toBeGreaterThan(net(3, 6, 0.2) - 0.4);
  expect(changed).toBeLessThan(net(3, 6, 0.2) + 0.4);

  // the applied change is reported as checked, with what the check was not
  await expect(page.getByTestId('connector-edit-applied')).toContainText(
    'Connectors changed and checked',
  );

  // undo: the earlier pieces, exactly
  await page.getByTestId('connector-edit-undo').click();
  await expect(page.getByTestId('connector-edit-undo')).toBeHidden({ timeout: 60_000 });
  const restored = await netVolume(page);
  expect(restored).toBeGreaterThan(net(4, 6, 0.2) - 0.4);
  expect(restored).toBeLessThan(net(4, 6, 0.2) + 0.4);
});

test('taking the connectors off leaves the plain cut: the pieces write no pin and no socket', async ({
  page,
}) => {
  await page.goto('/');
  await open(page);
  await splitWithDefaultPin(page);
  await checkAndApply(page, 'connector-edit-remove');
  expect(Math.abs(await netVolume(page))).toBeLessThan(0.4);
});

test('a size the worker refuses is explained and nothing changes', async ({ page }) => {
  await page.goto('/');
  await open(page);
  await splitWithDefaultPin(page);
  // deeper than the piece is: the socket would run through it
  await page.getByTestId('connector-edit-depth').fill('40');
  await page.getByTestId('connector-edit-check').click();
  await expect(page.getByTestId('connector-edit-refusal')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('connector-edit-preview-label')).toHaveCount(0);
  expect(await netVolume(page)).toBeCloseTo(net(4, 6, 0.2), 0);
});
