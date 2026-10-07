import { expect, test, type Download, type Page } from '@playwright/test';
import { holedCubeStl } from '../scripts/boundary-fill-fixture.mjs';
import { pick } from './ui-fixtures';

/**
 * REPAIR-CORE-02 — automatic filling of simple openings through the real
 * application, worker and Geogram kernel.
 *
 * FIXTURE: a closed cube of ~270,000 triangles — ABOVE the per-opening
 * engine's 250,000-face ceiling — with 6 simple flat openings and 7 branched
 * boundaries (the shape of the model that motivated the stage). No user file.
 */

const CUBE = holedCubeStl(150);
const TRIANGLES = CUBE.triangles;

test.describe.configure({ timeout: 300_000 });

async function openCube(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await pick(page, 'holed-cube.stl', 'model/stl', Buffer.from(CUBE.bytes));
  await expect(page.getByTestId('issue-list')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('repair-op-status-fill-openings')).toHaveText('6 to fill', {
    timeout: 180_000,
  });
}

async function previewAndApply(page: Page): Promise<void> {
  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 180_000 });
  await page.getByTestId('apply-repair').click();
  // The fresh analysis of the NEW revision settles the card (a complete repair has no
  // 'remaining' list at all, so waiting on that list would wait on nothing).
  await expect(page.getByTestId('repair-applied')).not.toHaveAttribute('data-outcome', 'checking', {
    timeout: 180_000,
  });
}

async function bytesOf(download: Download): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test('RCF1: Repair model is enabled on a large part when only openings qualify, and says so', async ({
  page,
}) => {
  await openCube(page);
  expect(TRIANGLES).toBeGreaterThan(250_000);
  // Every conservative operation is a no-op on this model.
  await expect(page.getByTestId('repair-op-status-remove-duplicate-faces')).toHaveText(
    'No matches',
  );
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
  await expect(page.getByTestId('repair-scope')).toHaveText(
    // REPAIR-CORE-06B: the seven pinched boundaries are repairable too (separated, then filled).
    '6 openings can be filled. 2 repairable issue types of 2 detected. You review the result before anything changes.',
  );
  await expect(page.getByTestId('issue-status-open-boundaries')).toHaveText(
    '6 fillable · 7 need attention',
  );
});

test('RCF2: preview fills thirteen — six, plus seven separated first — applies atomically, and undo restores', async ({
  page,
}) => {
  await openCube(page);
  const triangles = page.getByTestId('status-triangles');
  await expect(triangles).toHaveText(TRIANGLES.toLocaleString('en-US'));

  await page.getByTestId('preview-repair').click();
  await expect(page.getByTestId('apply-repair')).toBeEnabled({ timeout: 180_000 });
  await expect(page.getByTestId('change-count-filledOpenings')).toHaveText('13');
  // Nothing is left open: the seven pinched boundaries became simple openings and were filled.
  await expect(page.getByTestId('fill-left-open-count')).toHaveCount(0);
  // Nothing has changed yet.
  await expect(triangles).toHaveText(TRIANGLES.toLocaleString('en-US'));

  await page.getByTestId('apply-repair').click();
  // The fresh analysis of the NEW revision settles the card (a complete repair has no
  // 'remaining' list at all, so waiting on that list would wait on nothing).
  await expect(page.getByTestId('repair-applied')).not.toHaveAttribute('data-outcome', 'checking', {
    timeout: 180_000,
  });
  // Two triangles per four-point opening; nothing else changed.
  await expect(page.getByTestId('repair-applied-changes')).toContainText('13 openings filled');
  await expect(page.getByTestId('repair-applied-changes')).toContainText(
    '7 non-manifold vertices repaired',
  );
  // FRESH counts from the repaired revision: no open boundary and no pinch remains.
  await expect(page.getByTestId('issue-count-open-boundaries')).toHaveText('0');
  await expect(page.getByTestId('issue-count-non-manifold-vertices')).toHaveText('0');
  const workspace = (await page.getByTestId('repair-workspace').textContent()) ?? '';
  expect(workspace).not.toMatch(/\b(watertight|printable|fully repaired|all issues fixed)\b/i);

  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('repair-applied')).toHaveCount(0, { timeout: 180_000 });
  await expect(triangles).toHaveText(TRIANGLES.toLocaleString('en-US'));
  await expect(page.getByTestId('issue-count-open-boundaries')).toHaveText('13', {
    timeout: 180_000,
  });
});

for (const target of ['stl', 'obj', '3mf'] as const) {
  test(`RCF3-${target}: the filled openings stay filled through ${target.toUpperCase()} export and re-import`, async ({
    page,
  }) => {
    if (target === 'obj') {
      await page.addInitScript(() => {
        const host = window as unknown as {
          showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
          savedObj?: FileSystemFileHandle;
        };
        host.showDirectoryPicker = async (): Promise<FileSystemDirectoryHandle> => {
          const root = await navigator.storage.getDirectory();
          const get = root.getFileHandle.bind(root);
          root.getFileHandle = async (name, options): Promise<FileSystemFileHandle> => {
            const handle = await get(name, options);
            host.savedObj = handle;
            return handle;
          };
          return root;
        };
      });
    }
    await openCube(page);
    await previewAndApply(page);
    // What the repaired model holds is read from the application, not computed here: the
    // round trip must give back exactly this.
    const repairedTriangles = (await page.getByTestId('status-triangles').innerText()).trim();
    expect(repairedTriangles).not.toBe(TRIANGLES.toLocaleString('en-US'));

    await page.getByTestId('workflow-convert').click();
    await page.getByTestId(`convert-target-${target}`).check();
    if (target === '3mf') await page.getByTestId('convert-unit-millimeter').check();
    const pending = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByTestId('convert-export').click();
    if (target === 'obj') {
      await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 120_000 });
      // Test-only capture of the closed native file for the unchanged round-trip
      // assertions. Large production export does not create a browser download.
      await page.evaluate(async () => {
        const host = window as unknown as { savedObj?: FileSystemFileHandle };
        if (host.savedObj === undefined) throw new Error('No native OBJ destination');
        const file = await host.savedObj.getFile();
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 0);
      });
    }
    const bytes = await bytesOf(await pending);

    await page.getByTestId('workflow-repair').click();
    await pick(
      page,
      `reimported.${target}`,
      target === 'stl' ? 'model/stl' : target === 'obj' ? 'model/obj' : 'model/3mf',
      bytes,
    );
    await expect(page.getByTestId('status-triangles')).toHaveText(repairedTriangles, {
      timeout: 180_000,
    });
    // REPAIR-CORE-06B: all thirteen openings were closed, and they stay closed.
    await expect(page.getByTestId('issue-count-open-boundaries')).toHaveText('0', {
      timeout: 180_000,
    });
  });
}

test('RCF4: cancelling a preview that would fill openings leaves the model untouched', async ({
  page,
}) => {
  await openCube(page);
  await page.getByTestId('preview-repair').click();
  await page.getByTestId('cancel-repair').click();
  await expect(page.getByTestId('repair-cancelled')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('apply-repair')).toHaveCount(0);
  await expect(page.getByTestId('status-triangles')).toHaveText(TRIANGLES.toLocaleString('en-US'));
  // The workflow is usable again.
  await expect(page.getByTestId('preview-repair')).toBeEnabled();
});

test('RCF5: switching filling off leaves the openings alone; Repair still has the pinched vertices to attempt', async ({
  page,
}) => {
  await openCube(page);
  await page.getByTestId('repair-op-toggle-fill-openings').uncheck();
  // The seven pinched vertices are still work for Repair, so it is not disabled.
  await expect(page.getByTestId('preview-repair')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('repair-no-repairs')).toHaveCount(0);
  await expect(page.getByTestId('issue-status-open-boundaries')).toHaveText(
    'Automatic filling not selected',
  );
});
