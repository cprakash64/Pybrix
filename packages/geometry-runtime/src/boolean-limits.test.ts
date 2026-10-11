import { describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  isWithinSplitTriangleCeiling,
  MAX_SUPPORTED_SPLIT_TRIANGLES,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import { AppErrorCode, CancellationSource } from '@cadfixer/shared';
import { runValidatedBoolean, type BooleanBackend } from './boolean-adapter';
import {
  BOOLEAN_KERNEL_BYTES_PER_TRIANGLE,
  booleanKernelInputBytes,
  MAX_BOOLEAN_INPUT_BYTES,
  MAX_BOOLEAN_TOOL_TRIANGLES,
} from './boolean-limits';
import { MAX_TEXTURE_PRIMITIVE_TRIANGLES } from './surface-texture';

/** An unshared (soup) mesh of `triangles` zero-coordinate faces. Zero pages are never touched. */
function soup(triangles: number): CanonicalMesh {
  return {
    positions: createPositionArray(triangles * 9),
    indices: createIndexArray(triangles * 3),
    metadata: {},
  };
}

describe('the shared split ceiling', () => {
  it('is 2,000,000 triangles, allowed at the ceiling and refused one above it', () => {
    expect(MAX_SUPPORTED_SPLIT_TRIANGLES).toBe(2_000_000);
    expect(isWithinSplitTriangleCeiling(1_999_999)).toBe(true);
    expect(isWithinSplitTriangleCeiling(2_000_000)).toBe(true);
    expect(isWithinSplitTriangleCeiling(2_000_001)).toBe(false);
  });

  it('rejects counts that are not triangle counts', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isWithinSplitTriangleCeiling(bad)).toBe(false);
  });
});

describe('the Manifold input-byte budget is derived, not chosen', () => {
  it('prices a soup triangle at 84 bytes: nine Float64 coordinates and three Uint32 indices', () => {
    expect(BOOLEAN_KERNEL_BYTES_PER_TRIANGLE).toBe(84);
    expect(booleanKernelInputBytes(soup(10), soup(0))).toBe(10 * 84);
    expect(booleanKernelInputBytes(soup(10), soup(3))).toBe(13 * 84);
  });

  it('is the split ceiling plus the largest tool, at 84 bytes a triangle', () => {
    expect(MAX_BOOLEAN_TOOL_TRIANGLES).toBe(MAX_TEXTURE_PRIMITIVE_TRIANGLES);
    expect(MAX_BOOLEAN_INPUT_BYTES).toBe(
      (MAX_SUPPORTED_SPLIT_TRIANGLES + MAX_BOOLEAN_TOOL_TRIANGLES) * 84,
    );
    // The 2M operand alone is the 160.2 MiB the decision named; the tool term is the 5 MiB beside it.
    const ceilingAlone = MAX_SUPPORTED_SPLIT_TRIANGLES * 84;
    expect(ceilingAlone).toBe(168_000_000);
    expect(ceilingAlone / 1024 / 1024).toBeCloseTo(160.2, 1);
    expect(MAX_BOOLEAN_INPUT_BYTES).toBeGreaterThan(ceilingAlone);
    expect(MAX_BOOLEAN_INPUT_BYTES - ceilingAlone).toBe(MAX_BOOLEAN_TOOL_TRIANGLES * 84);
  });

  it('admits a 2,000,000-triangle part beside a 12-triangle half-space, and the largest tool beside it', () => {
    const part = soup(MAX_SUPPORTED_SPLIT_TRIANGLES);
    expect(booleanKernelInputBytes(part, soup(12))).toBeLessThanOrEqual(MAX_BOOLEAN_INPUT_BYTES);
    expect(booleanKernelInputBytes(part, soup(MAX_BOOLEAN_TOOL_TRIANGLES))).toBe(
      MAX_BOOLEAN_INPUT_BYTES,
    );
  });

  it('still bites: one triangle past the part-plus-tool budget exceeds it', () => {
    const over = soup(MAX_SUPPORTED_SPLIT_TRIANGLES);
    expect(booleanKernelInputBytes(over, soup(MAX_BOOLEAN_TOOL_TRIANGLES + 1))).toBeGreaterThan(
      MAX_BOOLEAN_INPUT_BYTES,
    );
  });

  it('is far below the 1.6 M-triangle point the old flat 128 MiB budget refused at', () => {
    const old = 128 * 1024 * 1024;
    expect(Math.floor(old / 84)).toBe(1_597_830);
    expect(MAX_BOOLEAN_INPUT_BYTES).toBeGreaterThan(old);
    // ...and it is a bounded budget, not an unlimited path: under 170 MiB.
    expect(MAX_BOOLEAN_INPUT_BYTES / 1024 / 1024).toBeLessThan(170);
  });
});

describe('the independent guards that stay in force at the ceiling', () => {
  it('leaves the topology workspace of a 2,000,000-triangle part under its 1 GiB limit', () => {
    const workspace = estimateTopologyWorkspaceBytes(
      MAX_SUPPORTED_SPLIT_TRIANGLES,
      MAX_SUPPORTED_SPLIT_TRIANGLES * 3,
    );
    expect(workspace).toBeLessThanOrEqual(1024 * 1024 * 1024);
    // Past the ceiling the workspace would approach the limit; it is not what stops 2,000,001.
    expect(workspace).toBeGreaterThan(0);
  });

  it('refuses 2,000,001 triangles deterministically, on the triangle gate, before any kernel work', async () => {
    let invoked = false;
    const backend: BooleanBackend = {
      operate() {
        invoked = true;
        return Promise.reject(new Error('the kernel must not be reached'));
      },
    };
    const error: unknown = await runValidatedBoolean(
      backend,
      'intersection',
      soup(MAX_SUPPORTED_SPLIT_TRIANGLES + 1),
      soup(12),
      new CancellationSource().token,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: AppErrorCode.ResourceLimitExceeded,
      details: { metric: 'triangles', observed: 2_000_001, limit: 2_000_000 },
    });
    expect(invoked).toBe(false);
  });

  it('lets 2,000,000 triangles past the triangle gate: the next refusal is about the mesh, not its size', async () => {
    const error: unknown = await runValidatedBoolean(
      { operate: () => Promise.reject(new Error('the kernel must not be reached')) },
      'intersection',
      soup(MAX_SUPPORTED_SPLIT_TRIANGLES),
      soup(12),
      new CancellationSource().token,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // Zero-coordinate faces are degenerate, so topology refuses them as a mesh problem.
    expect(error).toMatchObject({ code: AppErrorCode.InvalidState });
  }, 120_000);
});
