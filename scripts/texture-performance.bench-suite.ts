import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { CancellationSource } from '@cadfixer/shared';
import {
  textureSurface,
  type BooleanBackend,
  type BooleanKind,
  type SurfaceTextureRequest,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../apps/web/src/workers/manifold-boolean-backend';

function griddedBox(
  divisions: number,
  size = 20,
  depth = 5,
): { mesh: CanonicalMesh; seed: number } {
  const side = divisions + 1,
    planeVertices = side * side,
    positions = createPositionArray(planeVertices * 2 * 3),
    index = (layer: 0 | 1, x: number, y: number): number => layer * planeVertices + y * side + x;
  let positionAt = 0;
  for (const z of [0, depth])
    for (let y = 0; y <= divisions; y++)
      for (let x = 0; x <= divisions; x++) {
        positions.set([(x * size) / divisions, (y * size) / divisions, z], positionAt);
        positionAt += 3;
      }
  const faces: number[] = [];
  for (let y = 0; y < divisions; y++)
    for (let x = 0; x < divisions; x++) {
      const a = index(0, x, y),
        b = index(0, x + 1, y),
        c = index(0, x + 1, y + 1),
        d = index(0, x, y + 1);
      faces.push(a, c, b, a, d, c);
    }
  const seed = faces.length / 3;
  for (let y = 0; y < divisions; y++)
    for (let x = 0; x < divisions; x++) {
      const a = index(1, x, y),
        b = index(1, x + 1, y),
        c = index(1, x + 1, y + 1),
        d = index(1, x, y + 1);
      faces.push(a, b, c, a, c, d);
    }
  for (let x = 0; x < divisions; x++) {
    let b0 = index(0, x, 0),
      b1 = index(0, x + 1, 0),
      t0 = index(1, x, 0),
      t1 = index(1, x + 1, 0);
    faces.push(b0, t1, t0, b0, b1, t1);
    b0 = index(0, x, divisions);
    b1 = index(0, x + 1, divisions);
    t0 = index(1, x, divisions);
    t1 = index(1, x + 1, divisions);
    faces.push(b0, t0, t1, b0, t1, b1);
  }
  for (let y = 0; y < divisions; y++) {
    let b0 = index(0, 0, y),
      b1 = index(0, 0, y + 1),
      t0 = index(1, 0, y),
      t1 = index(1, 0, y + 1);
    faces.push(b0, t0, t1, b0, t1, b1);
    b0 = index(0, divisions, y);
    b1 = index(0, divisions, y + 1);
    t0 = index(1, divisions, y);
    t1 = index(1, divisions, y + 1);
    faces.push(b0, t1, t0, b0, b1, t1);
  }
  const indices = createIndexArray(faces.length);
  indices.set(faces);
  return { mesh: { positions, indices, metadata: {} }, seed };
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const summary = (values: readonly number[]): string =>
  `${Math.min(...values).toFixed(0)}/${median(values).toFixed(0)}/${Math.max(...values).toFixed(0)}`;

describe('Stage 7C Texture performance qualification', () => {
  it('records three trials for 10k and 100k sources across small, medium, and large layouts', async () => {
    const wasm = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm'),
      base = await createManifoldBooleanBackend(wasm),
      rows = [
        { label: '10k', ...griddedBox(50) },
        { label: '100k', ...griddedBox(157) },
      ],
      workloads = [
        { label: 'small', spacing: 4 },
        { label: 'medium', spacing: 2 },
        { label: 'large', spacing: 1 },
      ];
    for (const row of rows)
      for (const workload of workloads) {
        const totals: number[] = [],
          booleans: number[] = [];
        let elements = 0;
        for (let trial = 0; trial < 3; trial++) {
          let booleanMs = 0;
          const measured: BooleanBackend = {
            operate: async (kind: BooleanKind, a, b, cancellation) => {
              const started = performance.now(),
                result = await base.operate(kind, a, b, cancellation);
              booleanMs += performance.now() - started;
              return result;
            },
          };
          const request: SurfaceTextureRequest = {
            seedTriangle: row.seed,
            pattern: 'dots',
            mode: 'emboss',
            featureSize: 0.4,
            spacing: workload.spacing,
            heightOrDepth: 0.3,
            rotationDegrees: 0,
          };
          const started = performance.now();
          const result = await textureSurface(
            measured,
            row.mesh,
            request,
            new CancellationSource().token,
          );
          totals.push(performance.now() - started);
          booleans.push(booleanMs);
          elements = result.elementCount;
        }
        console.warn(
          `[texture] ${row.label} ${String(row.mesh.indices.length / 3)} tri ${workload.label} ${String(elements)} elements: boolean ${summary(booleans)}ms; total ${summary(totals)}ms; region+layout+mesh+validation ${summary(totals.map((value, index) => value - (booleans[index] ?? 0)))}ms`,
        );
        expect(totals.every(Number.isFinite)).toBe(true);
      }
  }, 120_000);

  it('documents the bounded 500k omission: its planar region exceeds the qualified 100k selection ceiling', async () => {
    const row = griddedBox(353);
    expect(row.mesh.indices.length / 3).toBeGreaterThan(500_000);
    await expect(
      textureSurface(
        { operate: () => Promise.reject(new Error('must not spawn Boolean')) },
        row.mesh,
        {
          seedTriangle: row.seed,
          pattern: 'dots',
          mode: 'emboss',
          featureSize: 1,
          spacing: 4,
          heightOrDepth: 0.3,
          rotationDegrees: 0,
        },
        new CancellationSource().token,
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      details: { reason: 'EDIT_REGION_TOO_LARGE', limit: 100_000 },
    });
  });
});
