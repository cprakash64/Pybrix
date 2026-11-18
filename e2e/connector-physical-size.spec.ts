import { expect, test, type Page } from '@playwright/test';
import { revealControl } from './progressive-disclosure';
import { binaryStlFrom, type Point } from './stl-fixtures';
import { modelXml, threeMf } from './format-fixtures';
import { readStlArtifact } from './artifact-oracles';

/**
 * RELEASE 2, STAGE C03-C — A CONNECTOR IS THE SIZE IT WAS ASKED TO BE, THROUGH THE SHIPPED APPLICATION.
 *
 * Real files through the real file picker, the real worker, the real Manifold kernel, and the real exported pieces read back here.
 * The check does not depend on any number the product computes about its own pins. It reads the two exported pieces, adds up their
 * volumes with the divergence theorem (written out here), subtracts the volume of the cube they were cut from, and turns the local
 * difference into cubic millimetres with the unit and placement scale the TEST chose for the file.
 *
 *   volume(A) + volume(B) − volume(cube)  =  pin volume − socket volume
 *
 * For a round pin of Ø4 mm, 6 mm deep with 0.2 mm radial clearance, built from a 32-sided cylinder, that is
 *   6 × 16 sin(π/16) × (2² − 2.2²)  =  −15.733 mm³
 * whatever the model is written in. A pin that came out twice as wide would give about −126 mm³; one that came out in the wrong
 * unit, a thousand times that or its millionth. Millimetre cubes were always right; the cases here are the ones that were not.
 */
const CUBE_MM = 30;
const NET_MM3 = 6 * 16 * Math.sin(Math.PI / 16) * (2 * 2 - 2.2 * 2.2);
const MM_PER_UNIT: Readonly<Record<string, number>> = {
  millimeter: 1,
  meter: 1000,
  micron: 0.001,
  inch: 25.4,
};

type Tri = readonly [Point, Point, Point];
function cubeTriangles(size: number): Tri[] {
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
const stlOf = (size: number): Buffer => binaryStlFrom(cubeTriangles(size));
function threeMfOf(unit: string, size: number, transform: string): Buffer {
  const v = cubeTriangles(size);
  const vertices = [...new Set(v.flatMap((t) => t.map((p) => p.join(','))))];
  const index = (p: Point): number => vertices.indexOf(p.join(','));
  const mesh =
    `<mesh><vertices>${vertices
      .map((s) => s.split(',').map(Number))
      .map(([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`)
      .join('')}</vertices>` +
    `<triangles>${v
      .map(
        ([a, b, c]) =>
          `<triangle v1="${String(index(a))}" v2="${String(index(b))}" v3="${String(index(c))}"/>`,
      )
      .join('')}</triangles></mesh>`;
  return threeMf(
    modelXml({
      unit,
      resources: `<object id="1" type="model" name="Cube">${mesh}</object>`,
      build: `<item objectid="1" transform="${transform}"/>`,
    }),
  );
}
/** Signed volume of a binary STL, by the divergence theorem (corners are nine floats a triangle). */
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

async function open(page: Page, name: string, mime: string, buffer: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: mime, buffer });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
}

/** Cut through the middle with a Ø4 / 6 / 0.2 mm round pin, apply, and return the two exported pieces' volumes. */
async function cutAndExport(page: Page, unit: string | undefined): Promise<number[]> {
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  await revealControl(page, page.getByTestId('split-connector-pin'));
  await page.getByTestId('split-connector-pin').check();
  if (unit !== undefined) await page.getByTestId(`split-unit-interpretation-${unit}`).check();
  await revealControl(page, page.getByTestId('split-pin-diameter'));
  await page.getByTestId('split-pin-diameter').fill('4');
  await revealControl(page, page.getByTestId('split-depth'));
  await page.getByTestId('split-depth').fill('6');
  await revealControl(page, page.getByTestId('split-clearance'));
  await page.getByTestId('split-clearance').fill('0.2');
  await expect(page.getByTestId('split-connector-problem')).toHaveCount(0);
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-export')).toHaveText('Export pieces', { timeout: 30_000 });
  const downloads: Buffer[] = [];
  page.on('download', (download) => {
    void (async (): Promise<void> => {
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      downloads.push(Buffer.concat(chunks));
    })();
  });
  await page.getByTestId('split-export').click();
  await expect.poll(() => downloads.length).toBe(2);
  return downloads.map(volumeOf);
}

function expectNetPinVolume(
  pieces: number[],
  localCube: number,
  millimetresPerCoordinate: number,
): void {
  const [a = 0, b = 0] = pieces;
  const netMm3 = (a + b - localCube ** 3) * millimetresPerCoordinate ** 3;
  // 0.4 mm³ is 2.5 % of the pin's net volume and ten thousand times the float32 rounding of the cube; a pin that was twice as wide
  // (or half as deep, or in the wrong unit) is out by more than the whole value.
  expect(netMm3).toBeGreaterThan(NET_MM3 - 0.4);
  expect(netMm3).toBeLessThan(NET_MM3 + 0.4);
}

test.describe('a STL that states no unit, read by the user as...', () => {
  for (const unit of ['inch', 'meter', 'micron'] as const)
    test(`${unit}: the default pin is placed, and it is 4 mm`, async ({ page }) => {
      await page.goto('/');
      const local = CUBE_MM / (MM_PER_UNIT[unit] ?? Number.NaN);
      await open(page, `cube-${unit}.stl`, 'model/stl', stlOf(local));
      const pieces = await cutAndExport(page, unit);
      expectNetPinVolume(pieces, local, MM_PER_UNIT[unit] ?? Number.NaN);
    });
});

test.describe('a 3MF placed at a uniform scale', () => {
  for (const [unit, scale] of [
    ['millimeter', 2],
    ['millimeter', 0.5],
    ['inch', 0.5],
    ['meter', 4],
  ] as const)
    test(`${unit} at ×${String(scale)}: the pin is 4 mm on the build plate, not ${String(scale)} times that`, async ({
      page,
    }) => {
      await page.goto('/');
      const factor = (MM_PER_UNIT[unit] ?? Number.NaN) * scale;
      const local = CUBE_MM / factor;
      await open(
        page,
        `cube-${unit}-x${String(scale)}.3mf`,
        'model/3mf',
        threeMfOf(
          unit,
          local,
          `${String(scale)} 0 0 0 ${String(scale)} 0 0 0 ${String(scale)} 0 0 0`,
        ),
      );
      // the file states its unit: the page does not ask for one
      await page.getByTestId('workflow-split').click();
      await expect(page.getByTestId('split-unit-interpretation')).toHaveCount(0);
      const pieces = await cutAndExport(page, undefined);
      expectNetPinVolume(pieces, local, factor);
    });
});
