import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import { runLocalRepair } from '@cadfixer/mesh-hole-fill';
import { createKernelNarrowphase } from '../apps/web/src/workers/hole-fill-narrowphase';
import { PRODUCTION_REPAIR_WORK_LIMITS } from '../packages/mesh-hole-fill/src/repair-work-limits';
import { buildHarnessDocument, HarnessFixtureId } from '../apps/web/e2e-harness/fixtures';
import { digest, Fixture, loadFixture, openHarness, readState, type HarnessState } from './harness';

/**
 * REPAIR-CORE-06A-BROWSER-GATE — THE LOCAL PINCH REPAIR IN REAL CHROMIUM.
 *
 * The option has no public control until 06B, so this drives the PRODUCTION repair services
 * through the harness bridge: real Web Worker, real geometry-worker protocol, the disposable
 * kernel worker with the real Geogram WASM, the candidate store, commit and Undo. The harness
 * installs results in the REAL store as the repair hook does, so the real analysis hook then
 * examines the new revision; nothing here sets a report or fakes a result.
 *
 * Fixtures are generated and bounded (`apps/web/e2e-harness/fixtures.ts`).
 */

interface LocalOutcome {
  readonly kind: string;
  readonly eligible: number;
  readonly repaired: number;
  readonly remaining: number;
  readonly unattempted: number;
  readonly limitReached?: string;
  readonly work: {
    readonly primary: { readonly used: number; readonly limit?: number };
    readonly residual: { readonly used: number; readonly limit?: number };
  };
  readonly residual: {
    readonly ran: boolean;
    readonly skippedBecause?: string;
    readonly linkRetriangulations: number;
    readonly windingComponentsResolved: number;
  };
  readonly facesRemoved: number;
  readonly facesAppended: number;
}

interface LocalResult {
  readonly status: string;
  readonly message?: string;
  readonly planHash?: string;
  readonly localPlan?: { readonly eligible: number; readonly pinchedVertices: number };
  readonly candidateId?: string;
  readonly outcome?: LocalOutcome;
  readonly notRun?: string;
  readonly acceptance?: string;
  readonly candidateTriangles?: number;
  readonly candidateNonManifoldVertices?: number;
  readonly sourceNonManifoldVertices?: number;
  readonly durationMs: number;
  readonly cancelLatencyMs?: number;
}

interface Options {
  readonly cancelAfterMs?: number;
  readonly workCeiling?: number;
  readonly failVerifierAfterMs?: number;
}

async function begin(page: Page, state: HarnessState, options: Options = {}): Promise<void> {
  await page.evaluate(
    (input) => {
      const bridge = window.cadfixerHarness;
      if (bridge === undefined) throw new Error('the harness bridge is not installed');
      bridge.beginLocalRepair(input.documentId, input.revision, input.partId, input.options);
    },
    {
      documentId: state.documentId ?? '',
      revision: state.revision ?? 0,
      partId: state.partIds[0] ?? '',
      options,
    },
  );
}

async function finish(page: Page): Promise<LocalResult> {
  return (await page.evaluate(async () => {
    const bridge = window.cadfixerHarness;
    if (bridge === undefined) throw new Error('the harness bridge is not installed');
    return bridge.awaitLocalRepair();
  })) as unknown as LocalResult;
}

async function build(page: Page, state: HarnessState, options: Options = {}): Promise<LocalResult> {
  await begin(page, state, options);
  return finish(page);
}

async function verifiers(page: Page): Promise<{ live: number; created: number }> {
  return page.evaluate(() => {
    const bridge = window.cadfixerHarness;
    if (bridge === undefined) throw new Error('the harness bridge is not installed');
    return bridge.localRepairVerifiers();
  });
}

async function apply(page: Page): Promise<Record<string, number | string | boolean>> {
  return (await page.evaluate(async () => {
    const bridge = window.cadfixerHarness;
    if (bridge === undefined) throw new Error('the harness bridge is not installed');
    return bridge.applyLocalRepair();
  })) as Record<string, number | string | boolean>;
}

async function undo(page: Page): Promise<Record<string, number | string | boolean>> {
  return (await page.evaluate(async () => {
    const bridge = window.cadfixerHarness;
    if (bridge === undefined) throw new Error('the harness bridge is not installed');
    return bridge.undoLocalRepair();
  })) as Record<string, number | string | boolean>;
}

/** Waits for the REAL analysis hook to finish for the CURRENT document revision. */
async function analysed(page: Page): Promise<HarnessState> {
  await expect
    .poll(
      async () => {
        const state = await readState(page);
        return (
          state.analysisState === 'ready' &&
          state.analysisHandleRevision === state.revision &&
          state.analysisReportRevision === state.revision
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return readState(page);
}

async function heapBytes(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      0,
  );
}

function kernelWasmPath(): string {
  const relative = join(
    'packages',
    'self-intersection-kernel',
    'artifacts',
    'self-intersection.wasm',
  );
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error('kernel artifact not found');
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test('CASE A: a supported pinch is repaired, previewed, applied, re-analysed and undone exactly', async ({
  page,
}) => {
  const loaded = await loadFixture(page, Fixture.LocalRepairPinch);
  const before = await analysed(page);
  expect(before.analysisNonManifoldVertices).toBe(3);
  const originalDigest = await digest(page, before);
  const heapStart = await heapBytes(page);

  const built = await build(page, before);
  expect(built.status).toBe('CANDIDATE');
  expect(built.localPlan?.eligible).toBe(3);
  expect(built.outcome?.kind).toBe('complete');
  expect(built.outcome?.repaired).toBe(3);
  expect(built.sourceNonManifoldVertices).toBe(3);
  expect(built.candidateNonManifoldVertices).toBe(0);
  expect(built.acceptance).toBe('ACCEPTED');
  expect((await verifiers(page)).live).toBe(0);

  // A preview is not an application: the resident model and the page's diagnostics are unchanged.
  const duringPreview = await readState(page);
  expect(duringPreview.revision).toBe(before.revision);
  expect(duringPreview.analysisNonManifoldVertices).toBe(3);
  expect(await digest(page, duringPreview)).toEqual(originalDigest);

  // APPLY commits the PREVIEWED candidate: the same handle, and nothing rebuilt on the way.
  const applied = await apply(page);
  expect(applied.installed).toBe(true);
  expect(applied.committedCandidateId).toBe(built.candidateId);
  expect(applied.previewCandidateId).toBe(built.candidateId);
  expect(applied.triangleCount).toBe(built.candidateTriangles);
  expect(applied.previewTriangles).toBe(built.candidateTriangles);
  expect(applied.revision as number).toBeGreaterThan(before.revision ?? 0);

  // FRESH ANALYSIS of the NEW revision, run by the real hook — never carried across.
  const justAfter = await readState(page);
  if (justAfter.analysisReportRevision !== undefined) {
    expect(justAfter.analysisReportRevision).toBe(justAfter.revision);
  }
  const after = await analysed(page);
  expect(after.revision).toBe(applied.revision);
  expect(after.analysisNonManifoldVertices).toBe(0);
  expect(after.documentTriangleCount).toBe(built.candidateTriangles);
  const repairedDigest = await digest(page, after);
  expect(repairedDigest).not.toEqual(originalDigest);

  // UNDO restores the retained mesh object: the same bytes, the same triangle count.
  const undone = await undo(page);
  expect(undone.installed).toBe(true);
  expect(undone.revision as number).toBeGreaterThan(applied.revision as number);
  const restored = await analysed(page);
  expect(restored.analysisNonManifoldVertices).toBe(3);
  expect(restored.documentTriangleCount).toBe(loaded.documentTriangleCount);
  expect(await digest(page, restored)).toEqual({
    ...originalDigest,
    parts: originalDigest.parts,
  });

  // RETRY after Undo builds the same candidate again.
  const again = await build(page, restored);
  expect(again.status).toBe('CANDIDATE');
  expect(again.outcome?.repaired).toBe(3);
  expect(again.outcome?.work).toEqual(built.outcome?.work);
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());

  // RESOURCES: every kernel worker built for these operations has been terminated.
  const resources = await verifiers(page);
  expect(resources.live).toBe(0);
  expect(resources.created).toBeGreaterThanOrEqual(2);
  const heapEnd = await heapBytes(page);
  if (heapStart > 0) expect(heapEnd - heapStart).toBeLessThan(150 * 1024 * 1024);
});

test('CASE B: the residual phase repairs a pinch the primary search cannot', async ({ page }) => {
  await loadFixture(page, Fixture.LocalRepairResidual);
  const before = await analysed(page);
  expect(before.analysisNonManifoldVertices).toBe(1);
  expect(before.analysisWindingConflicts).toBeGreaterThan(0);

  const built = await build(page, before);
  expect(built.status).toBe('CANDIDATE');
  expect(built.outcome?.kind).toBe('complete');
  expect(built.outcome?.residual.ran).toBe(true);
  expect(built.outcome?.residual.windingComponentsResolved).toBeGreaterThanOrEqual(1);
  expect(built.outcome?.residual.linkRetriangulations).toBeGreaterThanOrEqual(1);
  expect(built.outcome?.work.residual.used).toBeGreaterThan(0);

  const applied = await apply(page);
  const after = await analysed(page);
  expect(after.revision).toBe(applied.revision);
  expect(after.analysisNonManifoldVertices).toBe(0);
  expect(after.analysisWindingConflicts).toBe(0);
  expect((await verifiers(page)).live).toBe(0);
});

test('CASE C: pinches the engine cannot repair safely are refused and nothing unsafe is exposed', async ({
  page,
}) => {
  // C1: a non-manifold edge at the pinch. Unsupported, so nothing is attempted and no candidate exists.
  await loadFixture(page, Fixture.LocalRepairUnsupportedEdge);
  const first = await analysed(page);
  const firstDigest = await digest(page, first);
  const refused = await build(page, first);
  expect(refused.outcome?.kind).toBe('no_change');
  expect(refused.outcome?.repaired).toBe(0);
  expect(refused.candidateId).toBeUndefined();
  expect(refused.status).toBe('NO_CANDIDATE');
  expect(await digest(page, await readState(page))).toEqual(firstDigest);

  // C2: a fan that is not one consistent chain. The vertex is refused; the only thing the engine
  // may offer is a validated winding-only candidate, which changes nothing until Apply.
  await loadFixture(page, Fixture.LocalRepairRefusal);
  const before = await analysed(page);
  const originalDigest = await digest(page, before);
  const built = await build(page, before);
  expect(['partial_unsupported', 'partial_ambiguous']).toContain(built.outcome?.kind);
  expect(built.outcome?.repaired).toBe(0);
  expect(built.outcome?.facesAppended).toBe(0);
  expect(built.outcome?.facesRemoved).toBe(0);
  if (built.candidateId !== undefined) {
    expect(built.acceptance).toBe('ACCEPTED');
    expect(built.candidateNonManifoldVertices).toBe(built.sourceNonManifoldVertices);
  }
  const unchanged = await readState(page);
  expect(unchanged.revision).toBe(before.revision);
  expect(unchanged.analysisNonManifoldVertices).toBe(before.analysisNonManifoldVertices);
  expect(await digest(page, unchanged)).toEqual(originalDigest);
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());
  await expect(page.getByTestId('harness-bar')).toBeVisible();

  // The page is still usable: another model loads and repairs.
  await loadFixture(page, Fixture.LocalRepairPinch);
  const ready = await analysed(page);
  expect((await build(page, ready)).outcome?.kind).toBe('complete');
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());
  expect((await verifiers(page)).live).toBe(0);
});

test('CASE D: the deterministic work limit is a typed partial result, never a half operation', async ({
  page,
}) => {
  await loadFixture(page, Fixture.LocalRepairHeavy);
  const before = await analysed(page);
  expect(before.analysisNonManifoldVertices).toBe(400);
  const originalDigest = await digest(page, before);

  const built = await build(page, before, { workCeiling: 1_000 });
  expect(built.status).toBe('CANDIDATE');
  expect(built.outcome?.kind).toBe('partial_limit');
  expect(built.outcome?.limitReached).toBe('primary');
  expect(built.outcome?.work.primary.limit).toBe(1_000);
  expect(built.outcome?.repaired).toBeGreaterThan(0);
  expect(built.outcome?.repaired).toBeLessThan(400);
  expect(built.outcome?.unattempted).toBeGreaterThan(0);
  expect(built.outcome?.residual.ran).toBe(false);
  // A whole-operation prefix: exactly the sites reported repaired are gone.
  expect(built.candidateNonManifoldVertices).toBe(400 - (built.outcome?.repaired ?? 0));

  const applied = await apply(page);
  const after = await analysed(page);
  expect(after.revision).toBe(applied.revision);
  expect(after.analysisNonManifoldVertices).toBe(400 - (built.outcome?.repaired ?? 0));
  const undone = await undo(page);
  expect(undone.installed).toBe(true);
  expect(await digest(page, await analysed(page))).toEqual(originalDigest);

  // A narrower ceiling is the ONLY direction a request can move: a huge one changes nothing.
  const wide = await build(page, await readState(page), { workCeiling: 500_000_000 });
  expect(wide.outcome?.work.primary.limit).toBe(PRODUCTION_REPAIR_WORK_LIMITS.primary);
  expect(wide.outcome?.kind).toBe('complete');
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());
  expect((await verifiers(page)).live).toBe(0);
});

test('CANCELLATION: planning and candidate construction stop, leak nothing, and retry succeeds', async ({
  page,
}) => {
  await loadFixture(page, Fixture.LocalRepairHeavy);
  const before = await analysed(page);
  const originalDigest = await digest(page, before);

  for (const cancelAfterMs of [1, 400]) {
    const cancelled = await build(page, before, { cancelAfterMs });
    expect(cancelled.status, cancelled.message).not.toBe('CANDIDATE');
    expect(cancelled.candidateId).toBeUndefined();
    expect(cancelled.cancelLatencyMs ?? 0).toBeLessThan(5_000);
    expect((await verifiers(page)).live).toBe(0);
    const state = await readState(page);
    expect(state.revision).toBe(before.revision);
    expect(await digest(page, state)).toEqual(originalDigest);
  }

  const retry = await build(page, before);
  expect(retry.status).toBe('CANDIDATE');
  expect(retry.outcome?.kind).toBe('complete');
  expect(retry.outcome?.repaired).toBe(400);
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());
  expect((await verifiers(page)).live).toBe(0);
});

test('STALE: replacing the model while a repair runs rejects the old result', async ({ page }) => {
  await loadFixture(page, Fixture.LocalRepairHeavy);
  const old = await analysed(page);
  await begin(page, old);

  // Replace the model before the result can arrive.
  const replacement = await loadFixture(page, Fixture.LocalRepairPinch);
  const stale = await finish(page);
  expect(replacement.documentId).not.toBe(old.documentId);

  // Whatever the old operation reported, it cannot be applied to the model now open.
  await expect(
    page.evaluate(async () => window.cadfixerHarness?.applyLocalRepair()),
  ).rejects.toThrow();
  const current = await analysed(page);
  expect(current.documentId).toBe(replacement.documentId);
  expect(current.analysisNonManifoldVertices).toBe(3);
  expect(current.revision).toBe(replacement.revision);
  expect(stale.status).toBeDefined();
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair().catch(() => false));
  expect((await verifiers(page)).live).toBe(0);

  // And the new model repairs normally.
  expect((await build(page, current)).outcome?.kind).toBe('complete');
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());
});

test('FAIL CLOSED: a kernel worker that dies produces a bounded error and no candidate', async ({
  page,
}) => {
  await loadFixture(page, Fixture.LocalRepairHeavy);
  const before = await analysed(page);
  const originalDigest = await digest(page, before);

  const failed = await build(page, before, { failVerifierAfterMs: 150 });
  expect(failed.status).not.toBe('CANDIDATE');
  expect(failed.candidateId).toBeUndefined();
  expect(failed.message ?? '').toMatch(/stopped unexpectedly|cancel/i);
  expect((await verifiers(page)).live).toBe(0);
  const state = await readState(page);
  expect(state.revision).toBe(before.revision);
  expect(await digest(page, state)).toEqual(originalDigest);

  const retry = await build(page, before);
  expect(retry.status).toBe('CANDIDATE');
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());
});

test('BUDGET PARITY: the browser charges exactly the work Node charges for the same geometry', async ({
  page,
}) => {
  const kernel = await createSelfIntersectionKernel({ wasmBinary: readFileSync(kernelWasmPath()) });
  const cases: readonly { readonly fixture: Fixture; readonly id: HarnessFixtureId }[] = [
    { fixture: Fixture.LocalRepairPinch, id: HarnessFixtureId.LocalRepairPinch },
    { fixture: Fixture.LocalRepairResidual, id: HarnessFixtureId.LocalRepairResidual },
    { fixture: Fixture.LocalRepairRefusal, id: HarnessFixtureId.LocalRepairRefusal },
    {
      fixture: Fixture.LocalRepairUnsupportedEdge,
      id: HarnessFixtureId.LocalRepairUnsupportedEdge,
    },
  ];
  for (const { fixture, id } of cases) {
    const mesh = buildHarnessDocument(id).parts[0]?.mesh;
    if (mesh === undefined) throw new Error('fixture has no mesh');
    const expected = runLocalRepair({
      mesh,
      makeNarrowphase: () => createKernelNarrowphase(kernel),
      limits: PRODUCTION_REPAIR_WORK_LIMITS,
    });
    await loadFixture(page, fixture);
    const built = await build(page, await analysed(page));
    expect(built.outcome?.kind, fixture).toBe(expected.kind);
    expect(built.outcome?.work.primary.used, fixture).toBe(expected.work.primary.used);
    expect(built.outcome?.work.residual.used, fixture).toBe(expected.work.residual.used);
    await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());
  }
});

test('RESPONSIVENESS: the main thread keeps painting while the repair runs off-thread', async ({
  page,
}) => {
  await loadFixture(page, Fixture.LocalRepairHeavy);
  const ready = await analysed(page);
  const probe = async (run: () => Promise<unknown>): Promise<{ worst: number; frames: number }> => {
    await page.evaluate(() => {
      const gaps: number[] = [];
      let previous = performance.now();
      let running = true;
      const tick = (): void => {
        if (!running) return;
        const now = performance.now();
        gaps.push(now - previous);
        previous = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      Object.assign(globalThis, {
        __stopLocalProbe: (): { worst: number; frames: number } => {
          running = false;
          return { worst: gaps.length === 0 ? 0 : Math.max(...gaps), frames: gaps.length };
        },
      });
    });
    await run();
    return page.evaluate(() =>
      (
        globalThis as unknown as { __stopLocalProbe: () => { worst: number; frames: number } }
      ).__stopLocalProbe(),
    );
  };
  const idle = await probe(() => page.waitForTimeout(1_500));
  const busy = await probe(async () => {
    await begin(page, ready);
    return finish(page);
  });
  const ceiling = Math.max(idle.worst * 10, 250);
  expect(busy.frames).toBeGreaterThan(2);
  expect(
    busy.worst,
    `${busy.worst.toFixed(0)}ms against idle ${idle.worst.toFixed(0)}ms`,
  ).toBeLessThan(ceiling);
  expect(busy.worst).toBeLessThan(1_000);
  await page.evaluate(async () => window.cadfixerHarness?.discardLocalRepair());
});
