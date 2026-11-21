import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tetrahedron } from '@cadfixer/mesh-topology/fixtures';
import { CancellationSource } from '@cadfixer/shared';
import {
  booleanUnion,
  booleanDifference,
  booleanIntersection,
  booleanKernelInputBytes,
  MAX_BOOLEAN_INPUT_BYTES,
  MAX_BOOLEAN_TOOL_TRIANGLES,
} from '@cadfixer/geometry-runtime';
import {
  createIndexArray,
  createPositionArray,
  MAX_SUPPORTED_SPLIT_TRIANGLES,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';
/** An unshared mesh of `triangles` zero-coordinate faces: zero pages are never touched, so it is cheap to make. */
const soup = (triangles: number): CanonicalMesh => ({
  positions: createPositionArray(triangles * 9),
  indices: createIndexArray(triangles * 3),
  metadata: {},
});
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
describe('pinned Manifold boolean artifact', () => {
  it('performs and validates union, difference, and intersection', async () => {
    const backend = await createManifoldBooleanBackend(binary);
    const a = tetrahedron(),
      b = tetrahedron([0.2, 0.2, 0.2]);
    for (const operation of [booleanUnion, booleanDifference, booleanIntersection]) {
      const result = await operation(backend, a, b, new CancellationSource().token);
      expect(result.outputReport.boundaryEdgeCount).toBe(0);
      expect(result.outputReport.nonManifoldEdgeCount).toBe(0);
      expect(result.mesh.indices.length).toBeGreaterThan(0);
    }
  });

  it('refuses an input past the derived byte budget, before the kernel sees a byte', async () => {
    let entered = false;
    const backend = await createManifoldBooleanBackend(binary, {
      onEnter: () => {
        entered = true;
      },
    });
    // The part at the ceiling beside one triangle more than the largest tool: one triangle over budget.
    const part = soup(MAX_SUPPORTED_SPLIT_TRIANGLES);
    const tool = soup(MAX_BOOLEAN_TOOL_TRIANGLES + 1);
    expect(booleanKernelInputBytes(part, tool)).toBeGreaterThan(MAX_BOOLEAN_INPUT_BYTES);
    await expect(
      backend.operate('intersection', part, tool, new CancellationSource().token),
    ).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      details: { metric: 'inputBytes', limit: MAX_BOOLEAN_INPUT_BYTES },
    });
    expect(entered).toBe(false);
  });
});
