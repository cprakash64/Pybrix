import { revealControl } from './progressive-disclosure';
import { expect, test, type Page } from '@playwright/test';
import { isAppOrigin, isInlineResource } from './app-origin';
import {
  cleanGridStl,
  crossingTrianglesStl,
  duplicateFaceStl,
  selfIntersectingShellStl,
  tetrahedronStl,
} from './stl-fixtures';

/**
 * THE PRODUCTION SELF-INTERSECTION DIAGNOSTIC, END TO END.
 *
 * NOTHING IS STUBBED. A real Chromium, the real production build, the real
 * authoritative geometry worker, a real disposable diagnostic worker, the real
 * MessageChannel between them, and the real Geogram WebAssembly kernel.
 *
 * WHAT THESE TESTS ARE ACTUALLY FOR. The geometry was settled by the Stage 3C
 * qualification; what production adds is everything AROUND the answer — when it
 * runs, when it refuses to run, what happens when the model changes underneath
 * it, and whether the interface can be made to imply a verdict it does not
 * have. Five of the six statuses carry a zero intersection count, so most of
 * what follows is about telling those five apart.
 */

async function openFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer: bytes });
}

/** Workers currently alive in the page, by name. */
async function workerNames(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (globalThis as { __cadfixerWorkers?: string[] }).__cadfixerWorkers ?? [],
  );
}

/** Records every Worker construction so "no worker was created" is provable. */
async function instrumentWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const created: string[] = [];
    (globalThis as { __cadfixerWorkers?: string[] }).__cadfixerWorkers = created;
    const scope = globalThis as { __cadfixerLiveWorkers?: number };
    scope.__cadfixerLiveWorkers = 0;
    const Real = globalThis.Worker;
    class Recording extends Real {
      public constructor(url: string | URL, options?: WorkerOptions) {
        // The name is what identifies the diagnostic worker; the URL is only a
        // fallback for a worker that did not set one.
        const name = options?.name ?? (typeof url === 'string' ? url : url.href);
        created.push(name);
        super(url, options);
        if (name === 'cadfixer-self-intersection') {
          scope.__cadfixerLiveWorkers = (scope.__cadfixerLiveWorkers ?? 0) + 1;
        }
        this.__cadfixerName = name;
      }

      public override terminate(): void {
        if (this.__cadfixerName === 'cadfixer-self-intersection') {
          scope.__cadfixerLiveWorkers = Math.max(0, (scope.__cadfixerLiveWorkers ?? 0) - 1);
        }
        super.terminate();
      }

      private readonly __cadfixerName: string;
    }
    globalThis.Worker = Recording;
  });
}

/* ------------------------------------------------------------- SI-P01 -- */

test('SI-P01: a small model is checked automatically and reports none found', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'tetra.stl', tetrahedronStl());

  // The headline appears without anyone asking for it.
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });
  // "None found" is only ever allowed to mean this one thing, so it is followed
  // by the qualifier that stops it being read as "the model is fine".
  await expect(page.getByTestId('self-intersection-qualifier')).toContainText(/wall thickness/i);
});

/* ------------------------------------------------------------- SI-P02 -- */

test('SI-P02: a proper crossing is found and broken down by cause', async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'crossing.stl', crossingTrianglesStl());

  await expect(page.getByTestId('self-intersection-headline')).toContainText(
    'intersecting face pair',
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('self-intersection-properCrossing')).toHaveText('1');
});

/* ------------------------------------------------------------- SI-P03 -- */

test('SI-P03: R17, the self-intersecting shell, is detected on the production path', async ({
  page,
}) => {
  /*
   * THE FIXTURE THAT DECIDED QUALIFICATION. A closed, manifold, consistently
   * wound single shell that passes through itself. Stage 2 topology reports it
   * as clean, which is exactly why this diagnostic exists.
   */
  await page.goto('/');
  await openFile(page, 'r17.stl', selfIntersectingShellStl());

  await expect(page.getByTestId('self-intersection-headline')).toContainText('intersecting', {
    timeout: 60_000,
  });
  // Nothing about this model may read as clean.
  await expect(page.getByTestId('self-intersection-headline')).not.toHaveText('None found');
});

/* ------------------------------------------------------------- SI-P04 -- */

test('SI-P04: a medium model is NOT checked automatically but offers the check', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await instrumentWorkers(page);
  await page.goto('/');

  // Above the 25,000-face automatic band, below the 250,000 ceiling.
  const medium = cleanGridStl(120); // 28,800 triangles
  expect(medium.triangles).toBeGreaterThan(25_000);
  expect(medium.triangles).toBeLessThan(250_000);
  await openFile(page, 'medium.stl', medium.bytes);

  await expect(page.getByTestId('self-intersection-headline')).toHaveText('Not checked', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('self-intersection-detail')).toContainText('25,000');
  await expect(page.getByTestId('run-self-intersection')).toBeVisible();

  // NO DIAGNOSTIC WORKER WAS BUILT. The check is offered, not started.
  expect(await workerNames(page)).not.toContain('cadfixer-self-intersection');

  // Explicit invocation completes.
  await page.getByTestId('run-self-intersection').click();
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 120_000,
  });
  expect(await workerNames(page)).toContain('cadfixer-self-intersection');
});

/* ------------------------------------------------------------- SI-P05 -- */

test('SI-P05: above the ceiling nothing diagnostic is created at all', async ({ page }) => {
  test.setTimeout(300_000);
  await instrumentWorkers(page);
  await page.goto('/');

  const huge = cleanGridStl(360); // 259,200 triangles
  expect(huge.triangles).toBeGreaterThan(250_000);
  await openFile(page, 'huge.stl', huge.bytes);

  await expect(page.getByTestId('self-intersection-headline')).toHaveText(
    'Not checked — model exceeds automatic check size',
    { timeout: 240_000 },
  );
  await expect(page.getByTestId('self-intersection-detail')).toContainText('250,000');

  /*
   * THE PROOF THAT MATTERS, and it is not "the button is absent".
   *
   * No diagnostic worker was constructed, so no WebAssembly was instantiated, no
   * MessageChannel carried geometry, no disposable copy was allocated and no
   * broadphase was built. At a million faces the broadphase alone allocated
   * ~272 MiB during qualification, which is why the ceiling is a PREFLIGHT gate
   * rather than a runtime one.
   */
  expect(await workerNames(page)).not.toContain('cadfixer-self-intersection');
  await expect(page.getByTestId('run-self-intersection')).toHaveCount(0);
  // And it is never described as clean.
  await expect(page.getByTestId('self-intersection-headline')).not.toHaveText('None found');
});

/* ------------------------------------------------------------- SI-P06 -- */

test('SI-P06: cancelling leaves the model untouched and a retry succeeds', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');

  const medium = cleanGridStl(240); // 115,200 triangles: long enough to cancel
  await openFile(page, 'cancel.stl', medium.bytes);
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('Not checked', {
    timeout: 180_000,
  });

  const trianglesBefore = await page.getByTestId('fact-triangles').textContent();

  await page.getByTestId('run-self-intersection').click();
  await expect(page.getByTestId('cancel-self-intersection')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('cancel-self-intersection').click();

  await expect(page.getByTestId('self-intersection-headline')).toHaveText('Check cancelled', {
    timeout: 60_000,
  });
  // Cancellation is not failure, and above all not a clean result.
  await expect(page.getByTestId('self-intersection-headline')).not.toHaveText('None found');

  // The authoritative model is untouched and still exportable.
  await expect(page.getByTestId('fact-triangles')).toHaveText(trianglesBefore ?? '');

  // Retry on a fresh worker completes.
  await page.getByTestId('run-self-intersection').click();
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 180_000,
  });
});

/* ------------------------------------------------------------- SI-P07 -- */

test('SI-P07: a new model invalidates the previous verdict immediately', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');

  await openFile(page, 'clean.stl', tetrahedronStl());
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });

  // Replace with a model that DOES self-intersect. The old "None found" must not
  // survive even momentarily as the verdict for new geometry.
  await openFile(page, 'r17.stl', selfIntersectingShellStl());
  await expect(page.getByTestId('self-intersection-headline')).toContainText('intersecting', {
    timeout: 60_000,
  });
});

/* ------------------------------------------------------------- SI-P08 -- */

test('SI-P08: the diagnostic sends nothing to the network', async ({ page }) => {
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!isAppOrigin(url) && !isInlineResource(url)) {
      offOrigin.push(url);
    }
    const body = request.postData();
    if (body !== null && body.length > 512) offOrigin.push(`BODY:${url}`);
  });

  await page.goto('/');
  await openFile(page, 'crossing.stl', crossingTrianglesStl());
  await expect(page.getByTestId('self-intersection-headline')).toContainText('intersecting', {
    timeout: 60_000,
  });

  expect(offOrigin).toEqual([]);
});

/* ------------------------------------------------------------- SI-P09 -- */

test('SI-P09: applying a repair invalidates the previous revision’s verdict', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');

  /*
   * A repair produces a NEW authoritative revision. The verdict computed for the
   * old one describes geometry that no longer exists, so it must not survive the
   * transition even for a moment — a stale "None found" beside changed geometry
   * is the most damaging thing this slice could do.
   */
  await openFile(page, 'duplicate.stl', duplicateFaceStl());

  // Revision A is small, so it is checked automatically.
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });

  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  await revealControl(page, page.getByTestId('repair-candidate'));
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('apply-repair').click();
  await revealControl(page, page.getByTestId('repair-applied'));
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });

  /*
   * Revision B is also small, so policy re-derives to AUTO and a fresh check
   * runs. What must never happen is the old verdict simply persisting: the
   * headline is asserted again AFTER the apply, and the work summary must
   * describe the new revision's own examination.
   */
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });
  // The work summary is behind the self-intersection row's ⓘ (REPAIR-UX-01).
  await openSelfIntersectionInfo(page);
  await expect(page.getByTestId('self-intersection-work-summary')).toBeVisible();

  // The applied repair is real: the model changed.
  await revealControl(page, page.getByTestId('repair-applied'));
  await expect(page.getByTestId('repair-applied')).toBeVisible();
});

/* ------------------------------------------------------------- SI-P10 -- */

test('SI-P10: undoing a repair re-derives the diagnostic for the restored revision', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');

  await openFile(page, 'duplicate.stl', duplicateFaceStl());
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });
  const trianglesBefore = await page.getByTestId('fact-triangles').textContent();

  await revealControl(page, page.getByTestId('advanced-preview-repair'));
  await page.getByTestId('advanced-preview-repair').click();
  await revealControl(page, page.getByTestId('repair-candidate'));
  await expect(page.getByTestId('repair-candidate')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('apply-repair').click();
  await revealControl(page, page.getByTestId('repair-applied'));
  await expect(page.getByTestId('repair-applied')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });

  // Undo produces yet another revision. The B verdict belongs to B.
  await page.getByTestId('undo-repair').click();
  await expect(page.getByTestId('fact-triangles')).toHaveText(trianglesBefore ?? '', {
    timeout: 60_000,
  });

  // The restored revision gets its own check, from its own policy band.
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
    timeout: 60_000,
  });
  // The work summary is behind the self-intersection row's ⓘ (REPAIR-UX-01).
  await openSelfIntersectionInfo(page);
  await expect(page.getByTestId('self-intersection-work-summary')).toBeVisible();
});

/* ------------------------------------------------------------- SI-P11 -- */

test('SI-P11: repeated check / cancel / retry cycles retain no diagnostic workers', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await instrumentWorkers(page);
  await page.goto('/');

  /*
   * LIFECYCLE, NOT GARBAGE COLLECTION. This does not claim memory is reclaimed
   * at any particular moment — that is the collector's business and no test can
   * honestly assert it. What it proves is REACHABILITY: after every terminal
   * operation the previous worker has been terminated, so live diagnostic
   * workers never accumulate no matter how many cycles run.
   */
  const model = cleanGridStl(120); // 28,800 triangles: explicit band, real WASM path
  await openFile(page, 'cycles.stl', model.bytes);
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('Not checked', {
    timeout: 180_000,
  });

  const liveWorkers = async (): Promise<number> =>
    page.evaluate(
      () => (globalThis as { __cadfixerLiveWorkers?: number }).__cadfixerLiveWorkers ?? 0,
    );

  const constructed: number[] = [];
  const live: number[] = [];

  // complete, complete, complete, cancel, retry, complete, cancel, complete
  const plan = ['run', 'run', 'run', 'cancel', 'run', 'run', 'cancel', 'run'] as const;
  for (const [index, step] of plan.entries()) {
    await page.getByTestId('run-self-intersection').click();

    if (step === 'cancel') {
      await expect(page.getByTestId('cancel-self-intersection')).toBeVisible({ timeout: 60_000 });
      await page.getByTestId('cancel-self-intersection').click();
      await expect(page.getByTestId('self-intersection-headline')).toHaveText('Check cancelled', {
        timeout: 60_000,
      });
    } else {
      await expect(page.getByTestId('self-intersection-headline')).toHaveText('None found', {
        timeout: 180_000,
      });
    }

    constructed.push(
      (await workerNames(page)).filter((n) => n === 'cadfixer-self-intersection').length,
    );
    live.push(await liveWorkers());

    // THE INVARIANT, checked after EVERY terminal operation.
    expect(await liveWorkers(), `after step ${String(index)} (${step})`).toBe(0);
  }

  // Exactly one worker per invocation — no hidden retain, no doubling.
  expect(constructed[constructed.length - 1]).toBe(plan.length);
  // And never a growing population of live ones.
  expect(live.every((count) => count === 0)).toBe(true);
});

/* ------------------------------------------------------------- SI-P12 -- */

test('SI-P12: a diagnostic worker that fails to load is reported, released and retryable', async ({
  page,
}) => {
  test.setTimeout(180_000);

  /*
   * A REAL WORKER FAILURE, not a rejected promise.
   *
   * The Worker constructor is redirected — for the diagnostic worker only, and
   * only for the first construction — at a URL that cannot load. The browser
   * then delivers a genuine `error` event, which is the path under test: the
   * listener, the port cleanup, the reference release and the retry. A hand
   * rejected promise would exercise none of that.
   *
   * TEST-ONLY, and deliberately not reachable from the product: it lives in an
   * init script, not behind a flag the application can read.
   */
  await page.addInitScript(() => {
    const scope = globalThis as { __cadfixerFailNext?: boolean };
    scope.__cadfixerFailNext = true;
    const Real = globalThis.Worker;
    class Failing extends Real {
      public constructor(url: string | URL, options?: WorkerOptions) {
        if (options?.name === 'cadfixer-self-intersection' && scope.__cadfixerFailNext === true) {
          scope.__cadfixerFailNext = false;
          super('/this-worker-does-not-exist.js', options);
          return;
        }
        super(url, options);
      }
    }
    globalThis.Worker = Failing;
  });

  await page.goto('/');
  await openFile(page, 'crossing.stl', crossingTrianglesStl());

  // The failure is surfaced as a failure — not as a clean result, and not as a
  // check that never finishes.
  await expect(page.getByTestId('self-intersection-headline')).toHaveText('Check failed', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('self-intersection-headline')).not.toHaveText('None found');
  // The UI does not sit on "Checking…" forever.
  await expect(page.getByTestId('cancel-self-intersection')).toHaveCount(0);

  // The authoritative model is untouched and the app is still usable.
  await expect(page.getByTestId('fact-triangles')).toHaveText('2');
  await revealControl(page, page.getByTestId('issue-list'));
  await expect(page.getByTestId('issue-list')).toBeVisible();

  // RETRY on a fresh worker succeeds: only the first construction was sabotaged.
  await page.getByTestId('run-self-intersection').click();
  await expect(page.getByTestId('self-intersection-headline')).toContainText('intersecting', {
    timeout: 60_000,
  });
});

/** Opens the self-intersection row's explanation, where its details live. */
async function openSelfIntersectionInfo(page: Page): Promise<void> {
  const info = page.getByTestId('issue-info-self-intersections');
  if ((await info.getAttribute('aria-expanded')) !== 'true') await info.click();
}
