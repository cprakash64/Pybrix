import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { toBinaryStl } from '@cadfixer/auto-split/fixtures';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';

/**
 * AUTO SPLIT IN A REAL BROWSER: how long the person waits before the request can leave, and whether the
 * page stays responsive while the worker renders. Run on demand —
 * `AUTO_SPLIT_PERF=1 npm run test:e2e:auto-split -- perf` — and read the printed numbers; the only
 * assertions are generous ones (the page was not frozen), because a timing threshold on a shared
 * machine measures the machine (see `playwright.timing.config.ts`).
 *
 * The provider's own latency is not measured: the interface says to expect 30–70+ seconds and the mock
 * answers immediately. This is the part Pybrix controls.
 */
const SERVICE = 'http://127.0.0.1:8787';
test.skip(process.env.AUTO_SPLIT_PERF !== '1', 'timings are collected on demand');

function sphere(rings: number): CanonicalMesh {
  const segments = rings * 2;
  const vertexTotal = 2 + (rings - 1) * segments;
  const triangleTotal = segments * 2 + (rings - 2) * segments * 2;
  const positions = createPositionArray(vertexTotal * 3);
  const indices = createIndexArray(triangleTotal * 3);
  positions.set([0, 0, 20], 0);
  let p = 3;
  for (let ring = 1; ring < rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2;
      positions.set(
        [
          Math.cos(theta) * Math.sin(phi) * 20,
          Math.sin(theta) * Math.sin(phi) * 20,
          Math.cos(phi) * 20,
        ],
        p,
      );
      p += 3;
    }
  }
  positions.set([0, 0, -20], (vertexTotal - 1) * 3);
  let at = 0;
  for (let segment = 0; segment < segments; segment += 1) {
    indices.set([0, 1 + segment, 1 + ((segment + 1) % segments)], at);
    at += 3;
  }
  for (let ring = 0; ring < rings - 2; ring += 1) {
    const row = 1 + ring * segments;
    const next = row + segments;
    for (let segment = 0; segment < segments; segment += 1) {
      const s2 = (segment + 1) % segments;
      indices.set([row + segment, next + segment, row + s2], at);
      at += 3;
      indices.set([row + s2, next + segment, next + s2], at);
      at += 3;
    }
  }
  const south = vertexTotal - 1;
  const last = 1 + (rings - 2) * segments;
  for (let segment = 0; segment < segments; segment += 1) {
    indices.set([south, last + ((segment + 1) % segments), last + segment], at);
    at += 3;
  }
  return { positions, indices, metadata: {} };
}

async function open(page: Page, mesh: CanonicalMesh): Promise<void> {
  // A file on disk, not a buffer: Playwright refuses an in-memory upload above 50 MB.
  const dir = mkdtempSync(join(tmpdir(), 'auto-split-perf-'));
  const path = join(dir, 'sphere.stl');
  writeFileSync(path, toBinaryStl(mesh));
  try {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('browse-button').click();
    await (await chooser).setFiles(path);
    await expect(page.getByTestId('fact-triangles')).toHaveText(
      (mesh.indices.length / 3).toLocaleString('en-US'),
      { timeout: 240_000 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const rings of [60, 160, 270, 500, 610]) {
  test(`${String(rings * rings * 4)} triangles: time to request, and main-thread gaps`, async ({
    page,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-real-ip': `10.77.${String(rings)}.1` });
    await page.request.post(`${SERVICE}/api/auto-split/__mock/reset`);
    await page.goto('/');
    const mesh = sphere(rings);
    await open(page, mesh);
    await page.getByTestId('workflow-split').click();
    await page.getByTestId('split-tab-auto').click();
    await page.getByTestId('auto-kind-human').check({ force: true });
    await page.getByTestId('auto-disclosure-continue').click();
    await page.evaluate(() => {
      const w = window as unknown as { __gaps: number[]; __stop: boolean };
      w.__gaps = [];
      w.__stop = false;
      let last = performance.now();
      const tick = (): void => {
        const now = performance.now();
        w.__gaps.push(now - last);
        last = now;
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const started = Date.now();
    await page.getByTestId('auto-analyze').click();
    await expect(page.getByTestId('auto-results')).toBeVisible({ timeout: 240_000 });
    const total = Date.now() - started;
    const gaps = await page.evaluate(() => {
      const w = window as unknown as { __gaps: number[]; __stop: boolean };
      w.__stop = true;
      return w.__gaps;
    });
    const sorted = [...gaps].sort((a, b) => a - b);
    // `warn` is the one console method the repository allows; this spec exists to print its numbers.
    console.warn(
      JSON.stringify({
        triangles: mesh.indices.length / 3,
        clickToResultsMs: total,
        frames: gaps.length,
        maxGapMs: Math.round(sorted[sorted.length - 1] ?? 0),
        p99GapMs: Math.round(sorted[Math.floor(sorted.length * 0.99)] ?? 0),
      }),
    );
    // Not frozen: no single gap approaches the length of the render.
    expect(sorted[sorted.length - 1] ?? 0).toBeLessThan(Math.max(1500, total * 0.5));
  });
}
