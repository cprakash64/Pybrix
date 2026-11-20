import { expect, test, type Download, type Page } from '@playwright/test';
import { revealControl } from './progressive-disclosure';
import { binaryStlFrom, type Point } from './stl-fixtures';
import { readStlArtifact } from './artifact-oracles';
import { modelXml, threeMf } from './format-fixtures';

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

/** The cube as a millimetre 3MF: the same eight corners and twelve triangles as `cube`, so the cut it makes is the one the STL's would. */
function threeMfCube(size: number): Buffer {
  const h = size / 2;
  const corners: Point[] = [
    [-h, -h, -h],
    [h, -h, -h],
    [-h, h, -h],
    [h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [-h, h, h],
    [h, h, h],
  ];
  const faces = [
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
  const vertices = corners
    .map(([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`)
    .join('');
  const triangles = faces
    .map(([a, b, c]) => `<triangle v1="${String(a)}" v2="${String(b)}" v3="${String(c)}"/>`)
    .join('');
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Cube"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`,
    }),
  );
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

/** Exports both pieces as STL and returns the two files. */
async function exportPieces(page: Page): Promise<Buffer[]> {
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
  return downloads;
}

/** Exports both pieces as STL and returns the net volume the pin leaves, in cubic millimetres. */
async function netVolume(page: Page): Promise<number> {
  const [a = 0, b = 0] = (await exportPieces(page)).map(volumeOf);
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

/*
 * RELEASE 2, STAGE EC-6 — MOVING AND ADDING A CONNECTOR, JUDGED BY WHERE THE FILES PUT IT.
 *
 * Moving a pin leaves the pieces' volumes exactly where they were (the same pin and socket, in the same material), so volume cannot say
 * where a connector is. Position is read from the geometry instead: the pin's tip and the socket's bottom are rings of vertices 6 mm
 * either side of the cut (the plane z = 0 of the 30 mm cube, the default Z split), and the centre of each ring is the centre of the
 * connector. The cut's own axes may be turned or flipped against the model's, so nothing here assumes which is which: a move is judged by
 * a DISTANCE, which neither a turn nor a flip changes. The distances come from the picture's own geometry (30 mm of cut across 37.2 mm of
 * view, the 12 % margin written out here) and not from a number the product reports about itself.
 */
type Centre = readonly [number, number];
function connectorCentres(files: readonly Buffer[], depth = 6): Centre[] {
  const rings: Centre[] = [];
  for (const { corners } of files.map(readStlArtifact))
    for (let i = 0; i + 2 < corners.length; i += 3) {
      const x = corners[i] ?? 0;
      const y = corners[i + 1] ?? 0;
      const z = corners[i + 2] ?? 0;
      if (Math.abs(Math.abs(z) - depth) < 0.05) rings.push([x, y]);
    }
  // group the ring vertices into connectors: a ring is at most 4.4 mm across (the socket of the default pin), so a vertex within 5 mm of
  // the first of a group is on the same ring, and the connectors these tests place are 12 mm apart or alone
  const groups: { minX: number; maxX: number; minY: number; maxY: number; at: Centre }[] = [];
  for (const point of rings) {
    const group = groups.find((g) => Math.hypot(g.at[0] - point[0], g.at[1] - point[1]) < 5);
    if (group === undefined)
      groups.push({ minX: point[0], maxX: point[0], minY: point[1], maxY: point[1], at: point });
    else {
      group.minX = Math.min(group.minX, point[0]);
      group.maxX = Math.max(group.maxX, point[0]);
      group.minY = Math.min(group.minY, point[1]);
      group.maxY = Math.max(group.maxY, point[1]);
    }
  }
  // the middle of a ring's box, not the mean of its vertices: a vertex is written once for every triangle that uses it, and the cap's
  // triangulation does not use each equally
  return groups.map((g) => [(g.minX + g.maxX) / 2, (g.minY + g.maxY) / 2] as const);
}
async function allConnectorCentres(page: Page): Promise<Centre[]> {
  // the pin's tip ring and the socket's bottom ring are concentric, so reading both files together reads one centre for one connector
  return connectorCentres(await exportPieces(page));
}
const distance = (a: Centre, b: Centre): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Millimetres of cut for a pixel, from the box the picture is drawn in and the 12 % margin the view leaves around a 30 mm cut. */
const VIEW_MM = CUBE_MM * (1 + 2 * 0.12);

async function pinPixel(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await page
    .getByTestId(`cut-face-pin-${String(index)}`)
    .locator('.cut-face__body')
    .boundingBox();
  if (box === null) throw new Error('the connector has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('moving a connector by typing its place writes the pin where it was put, and undo puts it back', async ({
  page,
}) => {
  await page.goto('/');
  await open(page);
  await splitWithDefaultPin(page);
  const [first] = await allConnectorCentres(page);
  if (first === undefined) throw new Error('the split wrote no connector');
  expect(await netVolume(page)).toBeCloseTo(net(4, 6, 0.2), 0);

  // 3 across and 4 along from wherever it was is 5 mm away, whichever way the cut's axes lie and wherever its origin is
  const u0 = Number(await page.getByTestId('connector-position-u-0').inputValue());
  const v0 = Number(await page.getByTestId('connector-position-v-0').inputValue());
  await page.getByTestId('connector-position-u-0').fill(String(u0 + 3));
  await page.getByTestId('connector-position-v-0').fill(String(v0 + 4));
  await page.getByTestId('connector-edit-check').click();
  await expect(page.getByTestId('connector-edit-preview-text')).toContainText('1 connector moved', {
    timeout: 60_000,
  });
  await page.getByTestId('connector-edit-apply').click();
  await expect(page.getByTestId('connector-edit-undo')).toBeVisible({ timeout: 60_000 });

  const [moved, ...rest] = await allConnectorCentres(page);
  if (moved === undefined) throw new Error('the edit wrote no connector');
  expect(rest).toHaveLength(0);
  expect(distance(moved, first)).toBeCloseTo(5, 1);
  expect(await netVolume(page)).toBeGreaterThan(net(4, 6, 0.2) - 0.4);
  expect(await netVolume(page)).toBeLessThan(net(4, 6, 0.2) + 0.4);

  await page.getByTestId('connector-edit-undo').click();
  await expect(page.getByTestId('connector-edit-undo')).toBeHidden({ timeout: 60_000 });
  const [back] = await allConnectorCentres(page);
  if (back === undefined) throw new Error('undo left no connector');
  expect(distance(back, first)).toBeLessThan(0.005);
});

test('dragging a connector across the picture moves the pin by the distance the pointer moved', async ({
  page,
}) => {
  await page.goto('/');
  await open(page);
  await splitWithDefaultPin(page);
  const [first] = await allConnectorCentres(page);
  if (first === undefined) throw new Error('the split wrote no connector');

  const svg = await page.getByTestId('cut-face').boundingBox();
  if (svg === null) throw new Error('the cut has no picture');
  const side = Math.min(svg.width, svg.height);
  const start = await pinPixel(page, 0);
  const dx = side * 0.2;
  const dy = -side * 0.15;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps: 4 });
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 4 });
  await page.mouse.up();
  await page.getByTestId('connector-edit-check').click();
  await expect(page.getByTestId('connector-edit-preview-label')).toHaveText(
    'Preview — not applied',
    { timeout: 60_000 },
  );
  await page.getByTestId('connector-edit-apply').click();
  await expect(page.getByTestId('connector-edit-undo')).toBeVisible({ timeout: 60_000 });

  const [moved] = await allConnectorCentres(page);
  if (moved === undefined) throw new Error('the edit wrote no connector');
  const expected = (Math.hypot(dx, dy) / side) * VIEW_MM;
  expect(Math.abs(distance(moved, first) - expected)).toBeLessThan(0.25);
});

test('adding a second connector writes a second pin where it was put, and the volumes count both', async ({
  page,
}) => {
  await page.goto('/');
  await open(page);
  await splitWithDefaultPin(page);
  await page.getByTestId('connector-position-u-0').fill('-6');
  await page.getByTestId('connector-position-v-0').fill('0');
  await page.getByTestId('connector-edit-add').click();
  await page.getByTestId('connector-position-u-1').fill('6');
  await page.getByTestId('connector-position-v-1').fill('0');
  await page.getByTestId('connector-edit-check').click();
  await expect(page.getByTestId('connector-edit-preview-text')).toContainText('1 connector added', {
    timeout: 60_000,
  });
  await page.getByTestId('connector-edit-apply').click();
  await expect(page.getByTestId('connector-edit-undo')).toBeVisible({ timeout: 60_000 });

  const centres = await allConnectorCentres(page);
  expect(centres).toHaveLength(2);
  const [a, b] = centres;
  if (a === undefined || b === undefined) throw new Error('two connectors expected');
  expect(distance(a, b)).toBeCloseTo(12, 1);
  const total = await netVolume(page);
  expect(total).toBeGreaterThan(2 * net(4, 6, 0.2) - 0.8);
  expect(total).toBeLessThan(2 * net(4, 6, 0.2) + 0.8);
});

test('a place off the material is refused in the worker’s words, and the pieces are the ones they were', async ({
  page,
}) => {
  await page.goto('/');
  await open(page);
  await splitWithDefaultPin(page);
  await page.getByTestId('connector-position-u-0').fill('40');
  await page.getByTestId('connector-edit-check').click();
  await expect(page.getByTestId('connector-edit-refusal')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('connector-edit-preview-label')).toHaveCount(0);
  expect(await netVolume(page)).toBeCloseTo(net(4, 6, 0.2), 0);
});

test('a plain cut takes its first connector from the picture, and the pieces then write a pin', async ({
  page,
}) => {
  await page.goto('/');
  // a plain cut is recorded for editing only when the model STATES its unit, and an STL states none: so this one is a 3MF in millimetres
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'cube.3mf', mimeType: 'model/3mf', buffer: threeMfCube(CUBE_MM) });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('connector-editor')).toBeVisible({ timeout: 60_000 });
  expect(Math.abs(await netVolume(page))).toBeLessThan(0.4);
  await expect(page.getByTestId('connector-edit-remove')).toHaveCount(0);

  await page.getByTestId('connector-edit-add').click();
  await page.getByTestId('connector-edit-check').click();
  await expect(page.getByTestId('connector-edit-preview-text')).toContainText('1 connector added', {
    timeout: 60_000,
  });
  await page.getByTestId('connector-edit-apply').click();
  await expect(page.getByTestId('connector-edit-undo')).toBeVisible({ timeout: 60_000 });
  const total = await netVolume(page);
  expect(total).toBeGreaterThan(net(4, 6, 0.2) - 0.4);
  expect(total).toBeLessThan(net(4, 6, 0.2) + 0.4);
});
