import { expect, test, type Page } from '@playwright/test';
import { revealControl } from './progressive-disclosure';
import { binaryStlFrom, type Point } from './stl-fixtures';

/**
 * RELEASE 2, STAGE EC-4 — THE CONNECTORS THE APPLICATION SHOWS ARE THE WORKER'S, THROUGH THE SHIPPED BUILD.
 *
 * A real file, the real picker, the real worker, the real Manifold kernel. After a pin split is applied the inspector lists the
 * connection the worker says exists for that revision; undoing the split moves the model to a revision for which the worker lists
 * none, and the list goes with it. The page keeps no record of its own that could outlive either.
 */
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

async function open(page: Page): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'cube.stl',
    mimeType: 'model/stl',
    buffer: binaryStlFrom(cube(30)),
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
}

async function splitWithPin(page: Page): Promise<void> {
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  await revealControl(page, page.getByTestId('split-connector-pin'));
  await page.getByTestId('split-connector-pin').check();
  await page.getByTestId('split-unit-interpretation-millimeter').check();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('assembly-pieces')).toBeVisible({ timeout: 30_000 });
}

test('an applied pin split lists the connection the worker reports, selecting it works, and undo takes the list with it', async ({
  page,
}) => {
  await page.goto('/');
  await open(page);
  await splitWithPin(page);
  const connection = page.getByRole('button', { name: /^Connection 1:/ });
  await expect(connection).toBeVisible({ timeout: 30_000 });
  await expect(connection).toHaveAttribute('aria-pressed', 'false');
  await connection.click();
  await expect(connection).toHaveAttribute('aria-pressed', 'true');
  await connection.click();
  await expect(connection).toHaveAttribute('aria-pressed', 'false');
  // no sentence anywhere offers an edit of it
  await expect(page.getByTestId('assembly-pieces')).not.toContainText(/\bedit/i);

  await page.getByTestId('split-undo').click();
  // back to the cube the file held: twelve triangles, where the two cut pieces and their pin carry more
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Connection \d/ })).toHaveCount(0);
});
