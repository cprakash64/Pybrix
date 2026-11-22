import { expect, test, type Page } from '@playwright/test';
import { modelXml, threeMf } from './format-fixtures';
import { binaryStlFrom, type Point } from './stl-fixtures';

/**
 * TEXTURE-FIX-01: the two shipped defects the Stage T0 baseline found.
 *
 * D1: a model read from an STL file is triangle soup, and Surface Texture refused every one of
 * them ("No texture elements fit inside this surface"), because the layout found the face's edge
 * by vertex index. Every other texture spec imports a 3MF, which shares vertices, so none of them
 * could see it. D2/D3: a refused selection never appeared on screen.
 */

/**
 * The 40 × 20 × 60 box of texture-workspace.spec.ts, with every face cut into 5 mm squares (two
 * triangles each) on one shared lattice, so the surface is closed and manifold and each face is
 * many triangles. A bare 12-triangle box hides D1: its two triangles per face still leave room
 * for elements, only in fewer places. Indexed here; written two ways below.
 */
interface LatticeBox {
  readonly points: readonly Point[];
  readonly triangles: readonly (readonly [number, number, number])[];
}
function latticeBox(step = 5): LatticeBox {
  const origin: Point = [5, 7, 10];
  const size = [40, 20, 60] as const;
  const counts = size.map((length) => length / step);
  const points: Point[] = [];
  const triangles: [number, number, number][] = [];
  const known = new Map<string, number>();
  const lattice = (at: readonly number[]): number => {
    const key = at.join(',');
    const found = known.get(key);
    if (found !== undefined) return found;
    points.push([
      origin[0] + (at[0] ?? 0) * step,
      origin[1] + (at[1] ?? 0) * step,
      origin[2] + (at[2] ?? 0) * step,
    ]);
    known.set(key, points.length - 1);
    return points.length - 1;
  };
  // [axis the face is perpendicular to, u axis, v axis]; u × v is the +axis direction.
  const faces = [
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
  ] as const;
  for (const [axis, uAxis, vAxis] of faces)
    for (const side of [0, 1] as const)
      for (let u = 0; u < (counts[uAxis] ?? 0); u += 1)
        for (let v = 0; v < (counts[vAxis] ?? 0); v += 1) {
          const corner = (du: number, dv: number): number => {
            const at = [0, 0, 0];
            at[axis] = side === 1 ? (counts[axis] ?? 0) : 0;
            at[uAxis] = u + du;
            at[vAxis] = v + dv;
            return lattice(at);
          };
          const [a, b, c, d] = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)] as const;
          // Counter-clockwise seen from outside: u × v points out on the far side only.
          if (side === 1) triangles.push([a, b, c], [a, c, d]);
          else triangles.push([a, c, b], [a, d, c]);
        }
  return { points, triangles };
}
function latticeBoxStl(box: LatticeBox): Buffer {
  const at = (index: number): Point => {
    const found = box.points[index];
    if (found === undefined) throw new Error('bad fixture');
    return found;
  };
  return binaryStlFrom(box.triangles.map(([a, b, c]) => [at(a), at(b), at(c)]));
}
function latticeBox3mf(box: LatticeBox): Buffer {
  const vertices = box.points
    .map(([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`)
    .join('');
  const triangles = box.triangles
    .map(([a, b, c]) => `<triangle v1="${String(a)}" v2="${String(b)}" v3="${String(c)}"/>`)
    .join('');
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Box"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`,
    }),
  );
}

/** A flat plate of `side` × `side` squares, two triangles each: one connected flat region. */
function flatPlateStl(side: number): { readonly bytes: Buffer; readonly triangles: number } {
  const triangles: (readonly [Point, Point, Point])[] = [];
  for (let row = 0; row < side; row += 1)
    for (let column = 0; column < side; column += 1) {
      const a: Point = [column, row, 0];
      const b: Point = [column + 1, row, 0];
      const c: Point = [column + 1, row + 1, 0];
      const d: Point = [column, row + 1, 0];
      triangles.push([a, b, c], [a, c, d]);
    }
  return { bytes: binaryStlFrom(triangles), triangles: triangles.length };
}

async function openStl(page: Page, name: string, bytes: Buffer, triangles: number): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 120_000,
  });
}

const canvas = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-testid="viewport-canvas"] canvas');

async function enterTextureReadingMillimetres(page: Page): Promise<void> {
  await page.getByTestId('workflow-texture').click();
  await expect(page.getByTestId('texture-workspace')).toBeVisible();
  // An STL states no unit; the person says how to read it.
  await page.getByTestId('texture-unit-interpretation-millimeter').check();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

async function layoutElementCount(page: Page): Promise<number> {
  await expect(page.getByTestId('texture-elements')).toBeVisible({ timeout: 30_000 });
  return Number(
    ((await page.getByTestId('texture-elements').textContent()) ?? '').split(' of ')[0],
  );
}

async function selectLargeFace(page: Page): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (box === null) throw new Error('no canvas');
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 - 20);
  await expect(page.getByTestId('texture-selection-metrics')).toBeVisible({ timeout: 30_000 });
}

test('D1: a box imported from an STL file is laid out like the same box imported indexed', async ({
  page,
}) => {
  const box = latticeBox();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  // The same solid as an indexed 3MF: the reference answer.
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'box.3mf',
    mimeType: 'model/3mf',
    buffer: latticeBox3mf(box),
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText(
    box.triangles.length.toLocaleString(),
    {
      timeout: 60_000,
    },
  );
  await page.getByTestId('workflow-texture').click();
  await selectLargeFace(page);
  const indexedElements = await layoutElementCount(page);
  expect(indexedElements).toBeGreaterThan(0);

  // The same solid as an STL: no shared vertex, and the same elements.
  await page.goto('/');
  await openStl(page, 'box.stl', latticeBoxStl(box), box.triangles.length);
  await enterTextureReadingMillimetres(page);
  await selectLargeFace(page);
  await expect(page.getByTestId('texture-layout-error')).toHaveCount(0);
  expect(await layoutElementCount(page)).toBe(indexedElements);

  // And it can be made, applied and undone.
  await page.getByTestId('texture-generate').click();
  await expect(page.getByTestId('texture-preview-banner')).toBeVisible({ timeout: 60_000 });
  const result = Number(
    ((await page.getByTestId('texture-result-triangles').textContent()) ?? '').replace(/\D/g, ''),
  );
  expect(result).toBeGreaterThan(box.triangles.length);
  await expect(page.getByTestId('fact-triangles')).toHaveText(
    box.triangles.length.toLocaleString(),
  );
  await page.getByTestId('texture-apply').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(result.toLocaleString(), {
    timeout: 60_000,
  });
  await page.getByTestId('texture-undo').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(
    box.triangles.length.toLocaleString(),
    {
      timeout: 60_000,
    },
  );
  expect(errors).toEqual([]);
});

test('D2/D3: a surface too large to select is refused on screen, in words, with the model unchanged', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // 224 × 224 squares: 100,352 coplanar triangles, just over the 100,000 one selection may hold.
  const plate = flatPlateStl(224);
  expect(plate.triangles).toBeGreaterThan(100_000);
  await page.goto('/');
  await openStl(page, 'plate.stl', plate.bytes, plate.triangles);
  await enterTextureReadingMillimetres(page);

  const box = await canvas(page).boundingBox();
  if (box === null) throw new Error('no canvas');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const alert = page.getByTestId('texture-error');
  await expect(alert).toBeVisible({ timeout: 60_000 });
  await expect(alert).toContainText((100_000).toLocaleString());
  await expect(alert).toContainText('The model is unchanged.');
  // The sentence says what the limit is; it does not print one number as exceeding itself.
  await expect(alert).not.toContainText('limit is');
  await expect(page.getByTestId('texture-no-selection')).toBeVisible();
  await expect(page.getByTestId('fact-triangles')).toHaveText(plate.triangles.toLocaleString());
});
