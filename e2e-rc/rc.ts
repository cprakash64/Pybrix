import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared steps for the release-candidate qualification — REPAIR-CORE-07.
 *
 * Everything drives the PUBLIC UI of the packaged artifact. Nothing here reaches into the
 * application: it reads what a person reads, and measures from outside.
 */

export const REPORT_DIR = process.env.RC_REPORT_DIR ?? '/tmp/pybrix-rc';
mkdirSync(REPORT_DIR, { recursive: true });

export function record(entry: Record<string, unknown>): void {
  appendFileSync(`${REPORT_DIR}/report.jsonl`, `${JSON.stringify(entry)}\n`);
}

/* ----------------------------------------------------------- console audit -- */

export interface ConsoleAudit {
  readonly problems: () => readonly string[];
  readonly violations: () => readonly string[];
  /** Browser GL-driver diagnostics: recorded for the report, not application output. */
  readonly driver: () => readonly string[];
}

/**
 * Collects everything the console audit forbids: errors, warnings, uncaught exceptions,
 * unhandled rejections, CSP violations and failed requests. Intentional bounded logs are not
 * among them, because the product emits none.
 */
export async function auditConsole(page: Page): Promise<ConsoleAudit> {
  const problems: string[] = [];
  const violations: string[] = [];
  const driver: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = message.text().slice(0, 300);
      // The browser's own GL driver diagnostics (a bare WebGL canvas read back by Playwright
      // produces the same line) are not application output. They are recorded, never hidden.
      if (text.includes('GL Driver Message')) {
        driver.push(text);
        return;
      }
      problems.push(`${message.type()}: ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message.slice(0, 300)}`);
  });
  page.on('requestfailed', (request) => {
    problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return { problems: () => problems, violations: () => violations, driver: () => driver };
}

/* ----------------------------------------------------------------- process -- */

/** Sum of resident set sizes of the browser processes Playwright launched, in MiB. */
export function browserRssMiB(): number {
  try {
    const out = execFileSync('ps', ['-axo', 'rss=,command='], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
    let kib = 0;
    for (const line of out.split('\n')) {
      if (!/chromium_headless_shell|chrome-headless-shell/.test(line)) continue;
      kib += Number(line.trim().split(/\s+/)[0]) || 0;
    }
    return Math.round(kib / 1024);
  } catch {
    return 0;
  }
}

export async function jsHeapMiB(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.round(
      ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
        0) / 1048576,
    ),
  );
}

/** Live dedicated workers in the page, from the browser's own target list. */
export async function workerUrls(page: Page): Promise<string[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = (await session.send('Target.getTargets')) as {
      targetInfos: { type: string; url: string }[];
    };
    return targetInfos
      .filter((target) => target.type === 'worker')
      .map((target) => target.url.replace(/^https?:\/\/[^/]+/, ''));
  } finally {
    await session.detach();
  }
}

export async function liveWorkers(page: Page): Promise<number> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = (await session.send('Target.getTargets')) as {
      targetInfos: { type: string }[];
    };
    return targetInfos.filter((target) => target.type === 'worker').length;
  } finally {
    await session.detach();
  }
}

/* --------------------------------------------------------------------- UI -- */

export const count = (page: Page, id: string): Locator => page.getByTestId(`issue-count-${id}`);

export async function openDrawerIfNeeded(page: Page): Promise<void> {
  const toggle = page.getByTestId('toggle-tool-drawer');
  if (
    (await toggle.isVisible()) &&
    (await page.locator('.app').getAttribute('data-tool-drawer')) !== 'open'
  ) {
    await toggle.click();
  }
}

export type Source =
  { readonly name: string; readonly mime: string; readonly buffer: Buffer } | string;

async function closeDrawerIfOpen(page: Page): Promise<void> {
  const toggle = page.getByTestId('toggle-tool-drawer');
  if (
    (await toggle.isVisible()) &&
    (await page.locator('.app').getAttribute('data-tool-drawer')) === 'open'
  ) {
    // The open drawer sits under a scrim, which is how a phone user dismisses it: tap outside.
    const size = page.viewportSize();
    await page.mouse.click((size?.width ?? 390) - 4, (size?.height ?? 800) / 2);
    await expect(page.locator('.app')).toHaveAttribute('data-tool-drawer', 'closed', {
      timeout: 5_000,
    });
  }
}

export async function importModel(page: Page, source: Source, mime = 'model/stl'): Promise<void> {
  // On a phone the open drawer covers the top bar, exactly as it would for a person.
  await closeDrawerIfOpen(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  const handle = await chooser;
  if (typeof source === 'string') await handle.setFiles(source);
  else if (source.buffer.byteLength > 40 * 1024 * 1024) {
    // Playwright refuses buffers over 50 MB; a large file is handed over by path, as a person's is.
    const path = `${REPORT_DIR}/upload-${source.name}`;
    writeFileSync(path, source.buffer);
    await handle.setFiles(path);
  } else
    await handle.setFiles({
      name: source.name,
      mimeType: source.mime || mime,
      buffer: source.buffer,
    });
  // Reopen the tools the way a person would, so what follows can read the workspace.
  await openDrawerIfNeeded(page);
}

export async function enterRepair(page: Page): Promise<void> {
  await closeDrawerIfOpen(page);
  const tab = page.getByTestId('workflow-repair');
  if (await tab.isVisible()) await tab.click();
  else {
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-option-repair').click();
  }
  await openDrawerIfNeeded(page);
}

/** Waits until the repair action has settled into a state a person could act on. */
export async function settled(page: Page, timeout = 300_000): Promise<'ready' | 'nothing'> {
  const ready = page.getByTestId('preview-repair');
  const nothing = page.getByTestId('repair-no-repairs');
  await expect(ready.or(nothing).first()).toBeVisible({ timeout });
  // A model that was just replaced may still be showing the previous model's state for a moment;
  // an answer only counts once it has HELD, unchanged, across a short window.
  let last = '';
  let since = 0;
  await expect
    .poll(
      async () => {
        const now = (await ready.isEnabled())
          ? 'ready'
          : (await nothing.isVisible())
            ? 'nothing'
            : '';
        if (now !== last) {
          last = now;
          since = Date.now();
        }
        return now !== '' && Date.now() - since >= 700;
      },
      { timeout, intervals: [150] },
    )
    .toBe(true);
  return last === 'ready' ? 'ready' : 'nothing';
}

export async function waitForResult(
  page: Page,
  timeout = 600_000,
): Promise<'candidate' | 'note' | 'cancelled'> {
  const candidate = page.getByTestId('repair-candidate');
  const note = page.getByTestId('repair-no-safe-change');
  const cancelled = page.getByTestId('repair-cancelled');
  await expect(candidate.or(note).or(cancelled)).toBeVisible({ timeout });
  if (await candidate.isVisible()) return 'candidate';
  return (await note.isVisible()) ? 'note' : 'cancelled';
}

export async function readSummary(page: Page): Promise<{
  outcome: string | null;
  headline: string;
  fixed: string[];
  remaining: string[];
  current: string;
  after: string;
}> {
  const text = async (id: string): Promise<string> =>
    ((await page.getByTestId(id).textContent()) ?? '').trim();
  const list = async (id: string): Promise<string[]> =>
    (await page.getByTestId(id).locator('li').allTextContents()).map((t) => t.trim());
  return {
    outcome: await page.getByTestId('repair-summary').getAttribute('data-outcome'),
    headline: await text('repair-summary-headline'),
    fixed: await list('repair-summary-fixed'),
    remaining: await list('repair-summary-remaining'),
    current: await text('repair-summary-current'),
    after: await text('repair-summary-after'),
  };
}

export async function applyAndSettle(page: Page, timeout = 600_000): Promise<void> {
  await page.getByTestId('apply-repair').click();
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout });
  await expect(page.getByTestId('repair-applied')).not.toHaveAttribute('data-outcome', 'checking', {
    timeout,
  });
}

export async function counts(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of [
    'open-boundaries',
    'non-manifold-edges',
    'non-manifold-vertices',
    'winding-conflicts',
    'degenerate-faces',
    'duplicate-faces',
    'components',
  ]) {
    const locator = count(page, id);
    out[id] = (await locator.count()) === 0 ? '?' : ((await locator.textContent()) ?? '').trim();
  }
  return out;
}

export async function exportStlAndReadBack(page: Page): Promise<Buffer> {
  await page.getByTestId('workflow-convert').click();
  await page.getByTestId('convert-target-stl').check();
  const pending = page.waitForEvent('download', { timeout: 300_000 });
  await page.getByTestId('convert-export').click();
  const download = await pending;
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  await page.getByTestId('workflow-repair').click();
  return Buffer.concat(chunks);
}
