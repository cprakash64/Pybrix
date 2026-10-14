import { openInspector } from '../e2e/inspector';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { semanticFixture, toBinaryStl } from '@cadfixer/auto-split/fixtures';
const service = 'http://127.0.0.1:8787';
async function exportHash(page: Page): Promise<string> {
  await openInspector(page);
  const download = page.waitForEvent('download');
  await page.getByTestId('export-binary').click();
  const item = await download,
    stream = await item.createReadStream();
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
test('generic chair: twelve-image privacy contract, repeated family extraction, stale results and exact Undo', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ 'x-real-ip': '10.111.3.1' });
  await page.request.post(`${service}/api/auto-split/__mock/reset`);
  await page.request.post(`${service}/api/auto-split/__mock/scenario`, {
    data: { scenario: 'semantic-chair' },
  });
  const uploaded: unknown[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/auto-split/analyze')) uploaded.push(r.postDataJSON());
  });
  await page.goto('/');
  const f = semanticFixture('chair'),
    chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({
    name: 'chair.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from(toBinaryStl(f.mesh)),
  });
  await openInspector(page);
  await expect(page.getByTestId('fact-triangles')).toHaveText('72');
  const before = await exportHash(page);
  await page.getByTestId('workflow-split').click();
  await page.getByTestId('split-tab-auto').click();
  await expect(page.getByTestId('auto-kind-semantic')).toBeChecked();
  await page.getByTestId('auto-disclosure-continue').click();
  await page.getByTestId('auto-analyze').click();
  await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId('auto-row-legs')).toContainText('Legs (4)');
  await page.getByTestId('auto-row-legs').locator('details > summary').click();
  await expect(page.getByTestId('auto-row-legs:instance-1')).toBeVisible();
  expect(uploaded).toHaveLength(1);
  const payload = uploaded[0] as {
    mode: string;
    views: unknown[];
    componentViews: unknown[];
    semantic: unknown;
  };
  expect(payload.mode).toBe('semantic');
  expect(payload.views).toHaveLength(6);
  expect(payload.componentViews).toHaveLength(6);
  expect(JSON.stringify(payload)).not.toMatch(
    /"(?:positions|indices|vertices|triangles|stl|filename|path)"\s*:/,
  );
  await page.getByTestId('auto-preview-legs').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId('split-apply')).toHaveText('Separate');
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('split-undo')).toBeVisible();
  await page.getByTestId('split-again').click();
  await page.getByTestId('split-tab-auto').click();
  await expect(page.getByTestId('auto-stale')).toBeVisible();
  await expect(page.getByTestId('fact-triangles')).toHaveText('72');
  await page.getByTestId('split-cancel').click();
  await page.getByTestId('split-undo').click();
  await expect(page.getByTestId('split-undo')).not.toBeVisible();
  expect(await exportHash(page)).toBe(before);
});
