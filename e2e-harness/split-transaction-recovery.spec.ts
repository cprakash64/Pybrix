import { expect, test } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readState } from './harness';

for (const fault of [
  'delivery',
  'adoption-false',
  'adoption-throw',
  'after-write-throw',
  'ack-delivery',
  'commit-drop',
  'ack-drop',
] as const) {
  test(`split transaction: ${fault}, real worker/UI convergence and subsequent Undo`, async ({
    page,
  }) => {
    await openHarness(page);
    await loadFixture(page, Fixture.SplitCubeMillimetre);
    const before = await readState(page),
      bytes = await digest(page, before);
    await page.getByTestId('workflow-split').click();
    await page.getByTestId('split-preview').click();
    await expect(page.getByTestId('split-apply')).toBeEnabled({ timeout: 30000 });
    await page.evaluate((fault) => window.cadfixerHarness?.setSplitTransactionFault(fault), fault);
    await page.getByTestId('split-apply').click();
    if (fault === 'commit-drop' || fault === 'ack-drop') {
      await expect
        .poll(() =>
          page.evaluate(async () =>
            (await window.cadfixerHarness?.splitTransactionStates())?.map((s) => s.state),
          ),
        )
        .toContain(fault === 'commit-drop' ? 'APPLIED_PENDING_ADOPTION' : 'FINALIZED');
      await page.evaluate(() => window.cadfixerHarness?.reconnectSplitTransactions());
    }
    if (fault === 'ack-delivery' || fault === 'ack-drop') {
      await expect.poll(async () => (await readState(page)).partCount).toBe(2);
      await expect(page.getByTestId('split-undo')).toBeEnabled();
    } else {
      await expect(page.getByTestId('split-preview-label')).toBeHidden();
      const recovered = await readState(page);
      expect(recovered.documentId).toBe(before.documentId);
      expect(recovered.revision).toBe(before.revision);
      expect(recovered.partIds).toEqual(before.partIds);
      expect(recovered.partNames).toEqual(before.partNames);
      expect(await digest(page, recovered)).toEqual(bytes);
      await page.getByTestId('split-preview').click();
      await expect(page.getByTestId('split-apply')).toBeEnabled({ timeout: 30000 });
      await page.getByTestId('split-apply').click();
      await expect.poll(async () => (await readState(page)).partCount).toBe(2);
    }
    await page.getByTestId('split-undo').click();
    await expect.poll(async () => (await readState(page)).partCount).toBe(1);
    const restored = await readState(page);
    expect(await digest(page, restored)).toEqual(bytes);
    expect(restored.revision).toBeGreaterThan(before.revision ?? 0);
  });
}
