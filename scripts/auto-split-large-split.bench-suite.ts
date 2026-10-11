import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'vitest';
import { denseTruck, manyShellTruck } from '@cadfixer/auto-split/fixtures';
import { CancellationSource } from '@cadfixer/shared';
import {
  MAX_BOOLEAN_INPUT_BYTES,
  booleanKernelInputBytes,
  splitWithConnectors,
  type BooleanBackend,
  type BooleanKind,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../apps/web/src/workers/manifold-boolean-backend';
import { residentDocuments, splitCandidates } from '../apps/web/src/workers/stl-handlers';
import { partId, singlePartDocument } from '@cadfixer/mesh-core';

/**
 * THE EXACT SPLIT AT THE CEILING (AUTO-SPLIT-LARGE-MESH-02), in Node, with the pinned Manifold WASM the
 * worker ships: does a 2,000,000-triangle truck cut along the cab/bed plane, how long does each Boolean
 * take, what does the kernel's input cost and how big does the process get. NOT in CI; asserts nothing.
 *
 *   NODE_OPTIONS=--expose-gc LM_SIZE=2000000 \
 *     npx vitest run --config vitest.bench.config.ts scripts/auto-split-large-split.bench-suite.ts
 *
 * The plane is the truck's own cab/bed join, x = 10 in the part's coordinates, normal +X.
 */
const SIZE = Number(process.env.LM_SIZE ?? '500000');
const SHELLS = Number(process.env.LM_SHELLS ?? '0');
const mb = (n: number): number => Math.round((n / 1048576) * 10) / 10;

describe(`exact split of a ${String(SIZE)}-triangle truck`, () => {
  it('cuts it, and says what it cost', async () => {
    const wasm = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
    const base = await createManifoldBooleanBackend(wasm);
    const { mesh } = SHELLS > 0 ? manyShellTruck(SIZE, SHELLS) : denseTruck(SIZE);
    const triangles = mesh.indices.length / 3;
    const boolean: { kind: string; ms: number; inputBytes: number; rssMB: number }[] = [];
    const measured: BooleanBackend = {
      operate: async (kind: BooleanKind, a, b, cancellation) => {
        const started = performance.now();
        const inputBytes = booleanKernelInputBytes(a, b);
        const result = await base.operate(kind, a, b, cancellation);
        boolean.push({
          kind,
          ms: Math.round(performance.now() - started),
          inputBytes,
          rssMB: mb(process.memoryUsage().rss),
        });
        return result;
      },
    };
    (globalThis as unknown as { gc?: () => void }).gc?.();
    const started = performance.now();
    // Where each stage BEGINS, in ms from the start: the gaps between them are what each stage cost.
    const stages: { stage: string; atMs: number }[] = [];
    let outcome: Record<string, unknown>;
    try {
      const result = await splitWithConnectors(
        measured,
        mesh,
        { plane: { origin: [10, 0, 0], normal: [1, 0, 0] }, connector: { kind: 'none' } },
        new CancellationSource().token,
        (stage) => {
          stages.push({ stage, atMs: Math.round(performance.now() - started) });
        },
      );
      outcome = {
        ok: true,
        pieceATriangles: result.pieceA.indices.length / 3,
        pieceBTriangles: result.pieceB.indices.length / 3,
        volumeRelativeError: result.metrics.volumeRelativeError,
      };
      // The step the worker takes next, and the one a 2,000,000-triangle preview could be refused at:
      // the candidate's own validation, resource accounting and document gates.
      const handle = residentDocuments.commit(singlePartDocument(mesh));
      const ticket = splitCandidates.begin(handle, partId('part-1'));
      const resolveStarted = performance.now();
      try {
        const summary = splitCandidates.resolve(ticket, result, new CancellationSource().token);
        outcome = {
          ...outcome,
          resolved: true,
          resolveMs: Math.round(performance.now() - resolveStarted),
          resources: summary.resources,
        };
      } catch (error: unknown) {
        outcome = {
          ...outcome,
          resolved: false,
          resolveMs: Math.round(performance.now() - resolveStarted),
          resolveError: error instanceof Error ? error.message : String(error),
          resolveDetails: (error as { details?: unknown }).details,
        };
      }
    } catch (error: unknown) {
      outcome = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        details: (error as { details?: unknown }).details,
      };
    }
    const summary = {
      triangles,
      shells: SHELLS,
      maxBooleanInputBytes: MAX_BOOLEAN_INPUT_BYTES,
      totalMs: Math.round(performance.now() - started),
      stages,
      boolean,
      peakRssMB: mb(process.resourceUsage().maxRSS * 1024),
      outcome,
    };
    mkdirSync('artifacts/auto-split-large', { recursive: true });
    writeFileSync(
      `artifacts/auto-split-large/split-${String(SIZE)}-${String(SHELLS)}.json`,
      JSON.stringify(summary, null, 1),
    );
    console.warn(JSON.stringify(summary));
  }, 1_800_000);
});
