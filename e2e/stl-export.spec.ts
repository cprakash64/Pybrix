import { expect, test, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';
import { isAppOrigin } from './app-origin';
import { openInspector } from './inspector';

/**
 * STL export, end to end.
 *
 * Export is entirely local: a Blob built from bytes already in memory, handed
 * to the browser's own download mechanism. These tests confirm real files come
 * out, that they are the right shape, and that nothing is uploaded to obtain
 * them.
 */

const BINARY_PREFIX_BYTES = 84;
const BINARY_FACET_BYTES = 50;

async function loadModel(page: Page, triangles: number): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'bracket.stl',
    mimeType: 'model/stl',
    buffer: binaryStl(triangles).bytes,
  });
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles.toLocaleString(), {
    timeout: 20_000,
  });
}

test('exports a binary STL of exactly the right size', async ({ page }) => {
  await page.goto('/');
  const triangles = 750;
  await loadModel(page, triangles);

  const download = page.waitForEvent('download');
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  const saved = await download;

  expect(saved.suggestedFilename()).toBe('bracket.stl');

  const stream = await saved.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);

  // 84-byte prefix plus 50 bytes per facet, exactly.
  expect(bytes.byteLength).toBe(BINARY_PREFIX_BYTES + triangles * BINARY_FACET_BYTES);
  expect(bytes.readUInt32LE(80)).toBe(triangles);
  // The header must not carry the source filename or any other user data.
  expect(bytes.subarray(0, 80).toString('ascii')).toContain('Pybrix');
});

test('exports an ASCII STL that is valid, locale-independent text', async ({ page }) => {
  await page.goto('/');
  const triangles = 120;
  await loadModel(page, triangles);

  const download = page.waitForEvent('download');
  await openInspector(page);
  await page.getByTestId('export-ascii').click();
  const saved = await download;

  expect(saved.suggestedFilename()).toBe('bracket-ascii.stl');

  const stream = await saved.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('ascii');

  expect(text.startsWith('solid pybrix')).toBe(true);
  expect(text.trimEnd().endsWith('endsolid pybrix')).toBe(true);
  expect(text.match(/facet normal/g)).toHaveLength(triangles);
  expect(text.match(/vertex /g)).toHaveLength(triangles * 3);
  // A decimal comma here would mean the writer picked up the host locale and
  // produced files no other tool can read.
  expect(text).not.toMatch(/\d,\d/);
});

test('the UI describes what CAD Fixer can now actually write', async ({ page }) => {
  await page.goto('/');
  await loadModel(page, 40);

  /*
   * STAGE 4A-2B3 MADE THIS TRUE, so the assertion changed with it rather than
   * being relaxed. Until this stage the product could read three formats and
   * write one, and the panel said exactly that; it can now write all three, and
   * saying otherwise would be the mirror-image dishonesty.
   */
  // UI-06 moved the exports out of the Model facts into the inspector's own
  // Export section, whose region is "Model export".
  await openInspector(page);
  const panel = page.getByRole('region', { name: 'Model export' });
  await expect(panel).toContainText('reads STL, OBJ and 3MF, and writes all three');
  await expect(panel).not.toContainText('STL is the only format CAD Fixer can write');
  await expect(page.getByTestId('workflow-convert')).toBeEnabled();

  // An STL source loses nothing on the ACTIVE-PART export, so its note stays away.
  await expect(page.getByTestId('export-format-note')).toHaveCount(0);
});

test('importing and exporting a model sends nothing to the network', async ({ page }) => {
  // The strongest privacy guarantee this product makes: model bytes never leave
  // the machine. Asserted over the whole import AND export cycle, because
  // export is where a naive implementation would POST the file somewhere.
  const external: string[] = [];
  page.on('request', (request) => {
    if (!isAppOrigin(request.url())) external.push(request.url());
  });

  await page.goto('/');
  await loadModel(page, 500);

  const binaryDownload = page.waitForEvent('download');
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  await binaryDownload;

  const asciiDownload = page.waitForEvent('download');
  await openInspector(page);
  await page.getByTestId('export-ascii').click();
  await asciiDownload;

  expect(external).toEqual([]);
});

test('no request ever carries a model payload, even to our own origin', async ({ page }) => {
  // Same-origin requests are allowed for application assets, so "no external
  // requests" is not sufficient on its own: a POST back to localhost would pass
  // that check. Nothing may carry a request body at all.
  const withBodies: string[] = [];
  page.on('request', (request) => {
    const method = request.method();
    if (method !== 'GET' && method !== 'HEAD') withBodies.push(`${method} ${request.url()}`);
    if (request.postData() !== null) withBodies.push(`body: ${request.url()}`);
  });

  await page.goto('/');
  await loadModel(page, 300);

  const download = page.waitForEvent('download');
  await openInspector(page);
  await page.getByTestId('export-binary').click();
  await download;

  expect(withBodies).toEqual([]);
});
