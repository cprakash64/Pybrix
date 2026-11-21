import { expect, test, type Page, type Request } from '@playwright/test';
import { isAppOrigin, isInlineResource } from './app-origin';
import {
  objTriangle,
  objWithBadIndex,
  threeMf,
  threeMfCorruptDeflate,
  threeMfDanglingComponent,
  threeMfProductionExtension,
  threeMfProductionLarge,
  threeMfRequiresUnknownExtension,
  threeMfZip64CorruptRecord,
  threeMfZip64Production,
  zipOverTotalBudget,
} from './format-fixtures';
import { binaryStl, truncatedBinaryStl } from './stl-fixtures';
import { openInspector } from './inspector';

/**
 * STAGE 6D-A4 — RECOVERY, SUPERSESSION AND LOCALITY, IN A REAL BROWSER.
 *
 * The reader suites prove what each reader returns; the mutation campaign
 * proves every outcome is typed. What only the running application can prove
 * is what the USER is left with: that a refusal of any kind leaves the model
 * they already had, that the very next file imports normally, that a file
 * replaced mid-import never lands, and that none of it touched the network.
 */

interface Fixture {
  readonly name: string;
  readonly buffer: Buffer;
}

async function choose(page: Page, fixture: Fixture): Promise<void> {
  // The input, not the button: the button is disabled while an import runs,
  // and a second file arriving mid-import is exactly what supersession tests.
  await page
    .getByTestId('file-input')
    .setInputFiles({ ...fixture, mimeType: 'application/octet-stream' });
}

async function statusText(page: Page): Promise<string> {
  return (await page.getByTestId('status-list').textContent()) ?? '';
}

async function expectLoaded(page: Page, name: string, triangles: string): Promise<void> {
  await expect(page.getByTestId('fact-filename')).toHaveText(name, { timeout: 60_000 });
  await expect(page.getByTestId('fact-triangles')).toHaveText(triangles);
  await expect(page.getByTestId('import-progress')).toHaveCount(0);
}

const VALID_STL: Fixture = { name: 'valid.stl', buffer: binaryStl(24).bytes };
const VALID_PRODUCTION: Fixture = {
  name: 'valid-production.3mf',
  buffer: threeMfProductionExtension(),
};

/**
 * One refusal per class the stage names, each with the sentence fragment the
 * user must see. The fragment is asserted so a regression back to an untyped
 * error — which rendered as the file name and an EMPTY message for a corrupt
 * deflate stream before this stage — cannot pass.
 */
const FAILURES: readonly (Fixture & { readonly says: RegExp })[] = [
  { name: 'truncated.stl', buffer: truncatedBinaryStl(), says: /truncated|shorter|declares/i },
  { name: 'bad-index.obj', buffer: objWithBadIndex(), says: /does not exist|cannot read/i },
  { name: 'dangling.3mf', buffer: threeMfDanglingComponent(), says: /does not exist/i },
  {
    name: 'unknown-extension.3mf',
    buffer: threeMfRequiresUnknownExtension(),
    says: /requires a 3MF extension/i,
  },
  { name: 'over-budget.3mf', buffer: zipOverTotalBudget(), says: /expansion limit|limit is/i },
  {
    name: 'zip64-corrupt.3mf',
    buffer: threeMfZip64CorruptRecord(),
    says: /directory is corrupt/i,
  },
  { name: 'corrupt-deflate.3mf', buffer: threeMfCorruptDeflate(), says: /damaged/i },
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('A4-R: every refusal leaves the loaded model, and the next file imports', () => {
  for (const failure of FAILURES) {
    test(`recovers from ${failure.name}`, async ({ page }) => {
      // A model is already open.
      await choose(page, VALID_STL);
      await expectLoaded(page, 'valid.stl', '24');

      // The failing file is refused with a specific, readable reason...
      await choose(page, failure);
      await expect(page.getByTestId('status-list')).toContainText(failure.name, {
        timeout: 60_000,
      });
      await expect(page.getByTestId('import-progress')).toHaveCount(0);
      const status = await statusText(page);
      expect(status).toMatch(failure.says);
      expect(status).not.toMatch(new RegExp(`${failure.name}:\\s*(Loaded|$)`));
      expect(status).not.toMatch(/internal|unexpected/i);

      // ...the model that was open is still the model on screen...
      await expect(page.getByTestId('fact-filename')).toHaveText('valid.stl');
      await expect(page.getByTestId('fact-triangles')).toHaveText('24');
      await expect(page.getByTestId('session-lost')).toHaveCount(0);

      // ...and the worker is healthy: the next file, of another format, lands.
      await choose(page, VALID_PRODUCTION);
      await expectLoaded(page, 'valid-production.3mf', '4');
    });
  }

  test('imports a Zip64 production package — the shape Bambu Studio and OrcaSlicer write', async ({
    page,
  }) => {
    await choose(page, { name: 'zip64.3mf', buffer: threeMfZip64Production() });
    await expectLoaded(page, 'zip64.3mf', '4');
    await expect(page.getByTestId('fact-units')).toContainText(/millimet/i);
  });
});

test.describe('A4-S: a multi-model-part import that is superseded or cancelled never lands', () => {
  test('a second file chosen mid-import wins, and the first never overwrites it', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const large: Fixture = {
      name: 'large-production.3mf',
      buffer: threeMfProductionLarge(6, 60_000),
    };

    await choose(page, large);
    await expect(page.getByTestId('import-progress')).toBeVisible();
    await choose(page, VALID_STL);

    await expectLoaded(page, 'valid.stl', '24');
    // Give the abandoned import every chance to finish and misbehave.
    await page.waitForTimeout(3_000);
    await expect(page.getByTestId('fact-filename')).toHaveText('valid.stl');
    await expect(page.getByTestId('fact-triangles')).toHaveText('24');
    expect(await statusText(page)).not.toMatch(/Loaded large-production\.3mf/);
    await expect(page.getByTestId('session-lost')).toHaveCount(0);
  });

  test('cancelling a multi-model-part import keeps the open model and the worker usable', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await choose(page, VALID_STL);
    await expectLoaded(page, 'valid.stl', '24');

    await choose(page, { name: 'large-production.3mf', buffer: threeMfProductionLarge(6, 60_000) });
    await expect(page.getByTestId('import-progress')).toBeVisible();
    await page.getByTestId('cancel-import').click();

    await expect(page.getByTestId('status-list')).toContainText(
      'Import of large-production.3mf was cancelled.',
      { timeout: 120_000 },
    );
    await expect(page.getByTestId('fact-filename')).toHaveText('valid.stl');
    await expect(page.getByTestId('fact-triangles')).toHaveText('24');

    await choose(page, VALID_PRODUCTION);
    await expectLoaded(page, 'valid-production.3mf', '4');
  });
});

test.describe('A4-P: import and export in every format stay on this origin', () => {
  test('no request leaves the application origin', async ({ page }) => {
    test.setTimeout(300_000);
    const offOrigin: string[] = [];
    const record = (request: Request): void => {
      const url = request.url();
      if (!isAppOrigin(url) && !isInlineResource(url)) offOrigin.push(url);
    };
    page.on('request', record);

    const obj = objTriangle();
    const imports: readonly (Fixture & { readonly triangles: string })[] = [
      { name: 'part.stl', buffer: binaryStl(24).bytes, triangles: '24' },
      { name: 'part.obj', buffer: obj.bytes, triangles: String(obj.triangles) },
      { name: 'part.3mf', buffer: threeMf(), triangles: '4' },
      { name: 'production.3mf', buffer: threeMfProductionExtension(), triangles: '4' },
      { name: 'zip64.3mf', buffer: threeMfZip64Production(), triangles: '4' },
    ];

    for (const fixture of imports) {
      await choose(page, fixture);
      await expectLoaded(page, fixture.name, fixture.triangles);

      // Export the whole document to all three formats and take the downloads.
      await openInspector(page);
      await page.getByTestId('open-convert').click();
      await expect(page.getByTestId('convert-workspace')).toBeVisible();
      for (const target of ['stl', 'obj', '3mf'] as const) {
        await page.getByTestId(`convert-target-${target}`).check();
        const unit = page.getByTestId('convert-unit');
        if ((await unit.count()) > 0 && (await unit.locator('input:checked').count()) === 0) {
          await page.getByTestId('convert-unit-millimeter').check();
        }
        const download = page.waitForEvent('download', { timeout: 60_000 });
        await page.getByTestId('convert-export').click();
        await download;
        await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 60_000 });
      }
    }

    expect(offOrigin).toEqual([]);
  });
});
