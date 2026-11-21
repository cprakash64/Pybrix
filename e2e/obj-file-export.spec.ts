import { test, expect, type Page } from '@playwright/test';
import { binaryStl } from './stl-fixtures';

type SinkMode = 'save' | 'cancel' | 'disk' | 'permission' | 'closed' | 'blocked';
interface SinkWindow extends Window {
  showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
  exportTest: {
    mode: SinkMode;
    picks: number;
    writes: number;
    maxBytes: number;
    handle?: FileSystemFileHandle;
  };
}
async function installSink(page: Page, mode: SinkMode): Promise<void> {
  await page.addInitScript((initial) => {
    const host = window as unknown as SinkWindow;
    host.exportTest = { mode: initial, picks: 0, writes: 0, maxBytes: 0 };
    host.showDirectoryPicker = async (): Promise<FileSystemDirectoryHandle> => {
      host.exportTest.picks += 1;
      if (host.exportTest.mode === 'cancel') throw new DOMException('cancel', 'AbortError');
      const root = await navigator.storage.getDirectory();
      const lookup = root.getFileHandle.bind(root);
      root.getFileHandle = async (name, options): Promise<FileSystemFileHandle> => {
        const handle = await lookup(name, options);
        host.exportTest.handle = handle;
        const nativeCreate = handle.createWritable.bind(handle);
        handle.createWritable = async (configuration): Promise<FileSystemWritableFileStream> => {
          const stream = await nativeCreate(configuration);
          const nativeWrite = stream.write.bind(stream);
          stream.write = async (chunk): Promise<void> => {
            host.exportTest.writes += 1;
            const bytes = chunk as Uint8Array;
            host.exportTest.maxBytes = Math.max(host.exportTest.maxBytes, bytes.byteLength);
            if (host.exportTest.mode === 'blocked') {
              await new Promise<void>(() => undefined);
              return;
            }
            if (host.exportTest.mode !== 'save')
              throw new DOMException(
                'injected sink failure',
                host.exportTest.mode === 'permission'
                  ? 'NotAllowedError'
                  : host.exportTest.mode === 'disk'
                    ? 'QuotaExceededError'
                    : 'InvalidStateError',
              );
            await nativeWrite(chunk);
          };
          return stream;
        };
        return handle;
      };
      return root;
    };
  }, mode);
}
async function load(page: Page, triangles = 250_000): Promise<void> {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'mesh.stl', mimeType: 'model/stl', buffer: binaryStl(triangles).bytes });
  await expect(page.getByTestId('fact-triangles')).toBeAttached({ timeout: 90_000 });
  await page.getByTestId('workflow-convert').click();
  await page.getByTestId('convert-target-obj').check();
}
async function stagingCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('pybrix-export-staging', { create: true });
    let count = 0;
    for await (const entry of directory.values()) {
      if (entry.kind === 'file') count += 1;
    }
    return count;
  });
}

test('small OBJ keeps automatic download without a save picker', async ({ page }) => {
  await installSink(page, 'cancel');
  await load(page, 10_000);
  const pending = page.waitForEvent('download');
  await page.getByTestId('convert-export').click();
  expect((await pending).suggestedFilename()).toBe('mesh.obj');
  await expect(page.getByTestId('convert-saved')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as SinkWindow).exportTest.picks)).toBe(0);
});
test('large native writable export repeats, bounds chunks and cleans staging', async ({ page }) => {
  test.setTimeout(180_000);
  await installSink(page, 'save');
  await load(page);
  let size = 0;
  for (let run = 0; run < 3; run += 1) {
    await page.getByTestId('convert-export').click();
    if (run > 0) await page.getByTestId('convert-overwrite-confirm').click();
    await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 90_000 });
    const result = await page.evaluate(async () => {
      const state = (window as unknown as SinkWindow).exportTest;
      if (state.handle === undefined) throw new Error('No selected file');
      const file = await state.handle.getFile();
      return { size: file.size, head: await file.slice(0, 64).text(), maxBytes: state.maxBytes };
    });
    expect(result.head).toContain('# Written by Pybrix');
    expect(result.size).toBeGreaterThan(10_000_000);
    expect(result.maxBytes).toBeLessThanOrEqual(256 * 1024);
    if (run > 0) expect(result.size).toBe(size);
    size = result.size;
    await expect.poll(() => stagingCount(page)).toBe(0);
  }
});
test('save picker cancellation starts no export worker and creates no output', async ({ page }) => {
  await installSink(page, 'cancel');
  await load(page);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  expect(workers.filter((url) => url.includes('export.worker'))).toHaveLength(0);
  expect(await stagingCount(page)).toBe(0);
});
for (const mode of ['disk', 'permission', 'closed'] as const) {
  test(`large ${mode} failure aborts and the next export succeeds`, async ({ page }) => {
    test.setTimeout(180_000);
    await installSink(page, mode);
    await load(page);
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-failure')).toBeVisible({ timeout: 90_000 });
    expect(
      await page.evaluate(async () => {
        try {
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle('mesh.obj', { create: false });
          return false;
        } catch (cause) {
          return cause instanceof DOMException && cause.name === 'NotFoundError';
        }
      }),
    ).toBe(true);
    await expect.poll(() => stagingCount(page)).toBe(0);
    await page.evaluate(() => {
      (window as unknown as SinkWindow).exportTest.mode = 'save';
    });
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 90_000 });
  });
}
test('large export can be cancelled from the sticky footer at 300px height', async ({ page }) => {
  await installSink(page, 'save');
  await load(page, 500_000);
  await page.setViewportSize({ width: 1200, height: 300 });
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-cancel')).toBeInViewport();
  await page.getByTestId('convert-cancel').click();
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  await expect.poll(() => stagingCount(page)).toBe(0);
  expect(
    await page.evaluate(async () => {
      try {
        await (await navigator.storage.getDirectory()).getFileHandle('mesh.obj', { create: false });
        return false;
      } catch (cause) {
        return cause instanceof DOMException && cause.name === 'NotFoundError';
      }
    }),
  ).toBe(true);
});

test('missing file access reports the capability requirement without starting a worker', async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-failure')).toBeVisible();
  await page.getByTestId('convert-failure-info').click();
  await expect(page.getByTestId('convert-outcome-details')).toContainText(
    'desktop Chromium file access',
  );
  expect(workers.filter((url) => url.includes('export.worker'))).toHaveLength(0);
});

test('replacing a document cancels a blocked native write and exports the new model', async ({
  page,
}) => {
  await installSink(page, 'save');
  await load(page);
  await page.evaluate(() => {
    (window as unknown as SinkWindow).exportTest.mode = 'blocked';
  });
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-progress')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (
    await chooser
  ).setFiles({ name: 'replacement.stl', mimeType: 'model/stl', buffer: binaryStl(12).bytes });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 90_000 });
  await page.getByTestId('workflow-convert').click();
  await page.getByTestId('convert-target-obj').check();
  const pending = page.waitForEvent('download');
  await page.getByTestId('convert-export').click();
  expect((await pending).suggestedFilename()).toBe('replacement.obj');
  expect(
    await page.evaluate(async () => {
      try {
        await (await navigator.storage.getDirectory()).getFileHandle('mesh.obj', { create: false });
        return false;
      } catch (cause) {
        return cause instanceof DOMException && cause.name === 'NotFoundError';
      }
    }),
  ).toBe(true);
});

test('existing lookup and declined overwrite preserve bytes; filename and folder edits reclassify', async ({
  page,
}) => {
  await installSink(page, 'save');
  await load(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('mesh.obj', { create: true });
    const writer = await file.createWritable();
    await writer.write('KEEP ORIGINAL');
    await writer.close();
  });
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.getByTestId('convert-folder').click();
  await expect(page.getByTestId('convert-destination-note')).toContainText('Existing file');
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-overwrite')).toContainText('mesh.obj');
  expect(workers.filter((url) => url.includes('export.worker'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Keep existing file', exact: true }).click();
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  await page.getByTestId('convert-filename').fill('模型');
  await expect(page.getByTestId('convert-destination-note')).toHaveText('New file');
  await page.evaluate(() => {
    (window as unknown as SinkWindow).showDirectoryPicker =
      async (): Promise<FileSystemDirectoryHandle> =>
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('other-folder', { create: true });
  });
  await page.getByTestId('convert-folder').click();
  await expect(page.getByTestId('convert-folder')).toHaveText('Folder: other-folder');
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-saved')).toContainText('模型.obj', { timeout: 90_000 });
  const files = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return {
      original: await (await (await root.getFileHandle('mesh.obj')).getFile()).text(),
      saved: (
        await (
          await (await root.getDirectoryHandle('other-folder')).getFileHandle('模型.obj')
        ).getFile()
      ).size,
    };
  });
  expect(files.original).toBe('KEEP ORIGINAL');
  expect(files.saved).toBeGreaterThan(10_000_000);
});

test('changed existing metadata requires a fresh confirmation before worker creation', async ({
  page,
}) => {
  await installSink(page, 'save');
  await load(page);
  const change = async (text: string): Promise<void> => {
    await page.evaluate(async (value) => {
      const file = await (
        await navigator.storage.getDirectory()
      ).getFileHandle('mesh.obj', { create: true });
      const writer = await file.createWritable();
      await writer.write(value);
      await writer.close();
    }, text);
  };
  await change('old');
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-overwrite')).toContainText('3 bytes');
  await change('changed externally');
  await page.getByTestId('convert-overwrite-confirm').click();
  await expect(page.getByTestId('convert-overwrite')).toContainText('18 bytes');
  await expect(page.getByTestId('convert-footer')).toContainText('File changed.');
  expect(workers.filter((url) => url.includes('export.worker'))).toHaveLength(0);
  await page.getByTestId('convert-overwrite-confirm').click();
  await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 90_000 });
});

test('invalid filename fails before invoking a directory picker', async ({ page }) => {
  await installSink(page, 'save');
  await load(page);
  await page.getByTestId('convert-filename').fill('../unsafe');
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-failure')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as SinkWindow).exportTest.picks)).toBe(0);
});

/*
 * CONVERT-UX-02. After a successful large native export the saved result used
 * to live in the sticky footer, which grew to ~133 px inside a ~140 px scroll
 * area: the destination controls could not be scrolled out from under it, and
 * a click at the folder button's centre landed on Export.
 */
interface ShortHeightGeometry {
  readonly scroller: { top: number; bottom: number; clientHeight: number; scrollHeight: number };
  readonly footer: { top: number; bottom: number; height: number };
  /** `--action-footer-max`, the cap the stylesheet gives the sticky region. */
  readonly footerCap: number;
  readonly activity: { top: number; bottom: number };
  readonly savedInsideFooter: boolean;
  readonly horizontalOverflow: boolean;
}
async function shortHeightGeometry(page: Page): Promise<ShortHeightGeometry> {
  return page.evaluate(() => {
    const need = (selector: string): HTMLElement => {
      const found = document.querySelector(selector);
      if (!(found instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      return found;
    };
    const scroller = need('.tool-panel__body');
    const footer = need('[data-testid="convert-footer"]');
    const activity = need('.tool-panel__footer');
    const box = (element: HTMLElement): { top: number; bottom: number; height: number } => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
      scroller: {
        ...box(scroller),
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
      },
      footer: box(footer),
      footerCap: Number.parseFloat(
        getComputedStyle(scroller).getPropertyValue('--action-footer-max'),
      ),
      activity: box(activity),
      savedInsideFooter: footer.querySelector('[data-testid="convert-saved"]') !== null,
      horizontalOverflow:
        scroller.scrollWidth > scroller.clientWidth ||
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}
/** Scrolls a control into reach and reports what a click at its centre would hit. */
async function hitAtCentre(page: Page, testId: string): Promise<{ hit: string; y: number }> {
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  return page.getByTestId(testId).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(rect.left + rect.width / 2, y);
    const owner = target?.closest('[data-testid]');
    return { hit: owner?.getAttribute('data-testid') ?? '(none)', y };
  });
}
/**
 * The sticky action region stays inside its cap, and what it leaves of the
 * scroll area is taller than the tallest destination control.
 */
function expectBoundedFooter(geometry: ShortHeightGeometry): void {
  expect(geometry.footerCap).toBeGreaterThan(0);
  expect(geometry.footer.height).toBeLessThanOrEqual(geometry.footerCap);
  expect(geometry.footer.top - geometry.scroller.top).toBeGreaterThanOrEqual(44);
}
async function expectDestinationReachable(page: Page): Promise<void> {
  // THE SYMPTOM FIRST: a click at a control's centre reaches that control.
  for (const control of ['convert-filename', 'convert-folder']) {
    const { hit, y } = await hitAtCentre(page, control);
    expect(hit, `pointer target at the centre of ${control}`).toBe(control);
    const after = await shortHeightGeometry(page);
    expect(y).toBeGreaterThanOrEqual(after.scroller.top);
    expect(y).toBeLessThan(after.footer.top);
  }
  expect((await hitAtCentre(page, 'convert-export')).hit).toBe('convert-export');
  // THEN THE CAUSE: the pinned region is bounded and sits clear of Activity.
  const geometry = await shortHeightGeometry(page);
  expect(geometry.horizontalOverflow).toBe(false);
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.activity.top + 1);
  expectBoundedFooter(geometry);
}

for (const viewport of [
  { width: 1440, height: 300 },
  { width: 1280, height: 300 },
  { width: 1280, height: 360 },
  { width: 1440, height: 440 },
]) {
  test(`destination controls stay reachable after a native export at ${String(viewport.width)}×${String(viewport.height)}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await installSink(page, 'save');
    await load(page);
    await page.setViewportSize(viewport);
    await expectDestinationReachable(page);
    await page.getByTestId('convert-folder').click();
    await expect(page.getByTestId('convert-folder')).toContainText('Folder:');
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-saved')).toBeVisible({ timeout: 90_000 });

    const geometry = await shortHeightGeometry(page);
    expect(geometry.savedInsideFooter).toBe(false);
    await expectDestinationReachable(page);

    // The whole content is reachable by scrolling the one workspace scroller.
    const ends = await page.evaluate(() => {
      const scroller = document.querySelector('.tool-panel__body');
      if (!(scroller instanceof HTMLElement)) throw new Error('No scroller');
      scroller.scrollTop = 0;
      const top = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      return { top, end: scroller.scrollTop + scroller.clientHeight, total: scroller.scrollHeight };
    });
    expect(ends.top).toBe(0);
    expect(ends.end).toBeGreaterThanOrEqual(ends.total - 1);
    await page.getByTestId('convert-saved').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('convert-saved')).toBeInViewport();
    await expect(page.getByTestId('convert-source')).toBeAttached();

    // Keyboard: each control is brought clear of the sticky region when focused.
    await page.getByTestId('convert-filename').focus();
    for (const control of ['convert-filename', 'convert-folder']) {
      await expect(page.getByTestId(control)).toBeFocused();
      const focused = await page.getByTestId(control).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const footer = document.querySelector('[data-testid="convert-footer"]');
        const scroller = document.querySelector('.tool-panel__body');
        if (footer === null || scroller === null) throw new Error('No layout');
        return {
          top: rect.top,
          bottom: rect.bottom,
          limitTop: scroller.getBoundingClientRect().top,
          limitBottom: footer.getBoundingClientRect().top,
        };
      });
      expect(focused.top).toBeGreaterThanOrEqual(focused.limitTop - 1);
      expect(focused.bottom).toBeLessThanOrEqual(focused.limitBottom + 1);
      await page.keyboard.press('Tab');
    }

    // Repeated export without reload: a new name, then the same name replaced.
    await page.getByTestId('convert-filename').fill('second');
    await expect(page.getByTestId('convert-saved')).toHaveCount(0);
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-saved')).toContainText('second.obj', {
      timeout: 90_000,
    });
    await expectDestinationReachable(page);
  });
}

test('an existing target can be kept at 300px height and stays byte-identical', async ({
  page,
}) => {
  await installSink(page, 'save');
  await load(page);
  await page.setViewportSize({ width: 1440, height: 300 });
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writer = await (await root.getFileHandle('mesh.obj', { create: true })).createWritable();
    await writer.write('SENTINEL');
    await writer.close();
  });
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-overwrite')).toContainText('mesh.obj');
  const keep = page.getByRole('button', { name: 'Keep existing file', exact: true });
  await expect(keep).toBeInViewport();
  await expect(page.getByTestId('convert-overwrite-confirm')).toBeInViewport();
  expectBoundedFooter(await shortHeightGeometry(page));
  await keep.click();
  await expect(page.getByTestId('convert-export')).toBeEnabled();
  expect(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return (await (await root.getFileHandle('mesh.obj')).getFile()).text();
    }),
  ).toBe('SENTINEL');
  await expect.poll(() => stagingCount(page)).toBe(0);
  await expectDestinationReachable(page);
});

test('a failed native export keeps the destination controls reachable at 300px height', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await installSink(page, 'disk');
  await load(page);
  await page.setViewportSize({ width: 1440, height: 300 });
  await page.getByTestId('convert-export').click();
  await expect(page.getByTestId('convert-failure')).toBeVisible({ timeout: 90_000 });
  await expectDestinationReachable(page);
  // Editing the destination retires the outcome of the previous attempt.
  await page.getByTestId('convert-filename').fill('retry');
  await expect(page.getByTestId('convert-failure')).toHaveCount(0);
});

/*
 * CONVERT-UX-02, every state at every qualified size. One model per viewport,
 * walked through the whole destination flow: initial, folder chosen, existing
 * target, running, cancelled, failed and saved. After each, the filename and
 * folder controls must be reachable and hit-testable above the action region.
 */
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1280, height: 640 },
  { width: 1024, height: 768 },
  { width: 1440, height: 440 },
  { width: 1440, height: 380 },
  { width: 1440, height: 340 },
  { width: 1280, height: 360 },
  { width: 1440, height: 300 },
  { width: 1280, height: 300 },
  { width: 768, height: 1024 },
  { width: 430, height: 932 },
]) {
  test(`every destination state is usable at ${String(viewport.width)}×${String(viewport.height)}`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await installSink(page, 'save');
    await load(page);
    await page.setViewportSize(viewport);
    // Below 900 px the tool panel is a drawer.
    if (
      (await page.getByTestId('toggle-tool-drawer').isVisible()) &&
      (await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open'
    ) {
      await page.getByTestId('toggle-tool-drawer').click();
    }
    const setMode = async (mode: SinkMode): Promise<void> => {
      await page.evaluate((next) => {
        (window as unknown as SinkWindow).exportTest.mode = next;
      }, mode);
    };

    // A. Initial.
    await expectDestinationReachable(page);

    // B. Folder chosen.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const writer = await (
        await root.getFileHandle('mesh.obj', { create: true })
      ).createWritable();
      await writer.write('SENTINEL');
      await writer.close();
    });
    await page.getByTestId('convert-folder').click();
    await expect(page.getByTestId('convert-destination-note')).toContainText('Existing file');
    await expectDestinationReachable(page);

    // C. Existing target: both answers in reach, and declining writes nothing.
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-overwrite')).toContainText('mesh.obj');
    const keep = page.getByRole('button', { name: 'Keep existing file', exact: true });
    await expect(keep).toBeInViewport();
    await expect(page.getByTestId('convert-overwrite-confirm')).toBeInViewport();
    expectBoundedFooter(await shortHeightGeometry(page));
    await keep.click();
    await expect(page.getByTestId('convert-export')).toBeEnabled();
    expect(
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        return (await (await root.getFileHandle('mesh.obj')).getFile()).text();
      }),
    ).toBe('SENTINEL');
    await expectDestinationReachable(page);

    // D. Running: Cancel is a button, in view and on top.
    await page.getByTestId('convert-filename').fill('matrix');
    await expect(page.getByTestId('convert-destination-note')).toHaveText('New file');
    await setMode('blocked');
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-progress')).toBeVisible({ timeout: 90_000 });
    const cancel = page
      .getByTestId('convert-footer')
      .getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeInViewport();
    expectBoundedFooter(await shortHeightGeometry(page));
    expect((await hitAtCentre(page, 'convert-cancel')).hit).toBe('convert-cancel');

    // F. Cancelled.
    await cancel.click();
    await expect(page.getByTestId('convert-export')).toBeEnabled();
    await expect.poll(() => stagingCount(page)).toBe(0);
    await expectDestinationReachable(page);

    // G. Failed.
    await setMode('disk');
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-failure')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('convert-failure')).toBeInViewport();
    await expectDestinationReachable(page);

    // E. Saved.
    await setMode('save');
    await page.getByTestId('convert-export').click();
    await expect(page.getByTestId('convert-saved')).toContainText('matrix.obj', {
      timeout: 90_000,
    });
    await expect(page.getByTestId('convert-failure')).toHaveCount(0);
    await expect(page.getByTestId('convert-saved')).toBeInViewport();
    await expect(page.getByTestId('convert-destination-note')).toContainText('Existing file');
    expect((await shortHeightGeometry(page)).savedInsideFooter).toBe(false);
    await expectDestinationReachable(page);
    expect(
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        return (await (await root.getFileHandle('mesh.obj')).getFile()).text();
      }),
    ).toBe('SENTINEL');
  });
}
