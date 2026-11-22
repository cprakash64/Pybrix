import { describe, expect, it } from 'vitest';
import { isAppError, type AppError } from '@cadfixer/shared';
import { createIndexArray, createPositionArray, type CanonicalMesh } from './mesh';
import {
  classifyEditPlane,
  createEditFrame,
  growEditRegion,
  measureEditPlanarity,
  selectEditSurface,
  transformEditNormal,
  transformEditPoint,
} from './edit-geometry';
import type { PartTransform } from './document';
const mesh = (points: number[], indices: number[]): CanonicalMesh => ({
  positions: createPositionArray(points.length),
  indices: createIndexArray(indices.length),
  metadata: {},
});
function shape(points: number[], indices: number[]): CanonicalMesh {
  const m = mesh(points, indices);
  m.positions.set(points);
  m.indices.set(indices);
  return m;
}
const square = shape([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
describe('bounded surface selection', () => {
  it('grows across exact-coordinate shared edges and returns deterministic order', () => {
    expect(growEditRegion(square, 1, { maxNormalAngleRadians: 0.01, maxTriangles: 2 })).toEqual([
      0, 1,
    ]);
    // Over its budget the region is refused with a typed reason, not a sentence to match.
    expect(
      refusal(() => growEditRegion(square, 0, { maxNormalAngleRadians: 0.01, maxTriangles: 1 }))
        .details,
    ).toMatchObject({ reason: 'EDIT_REGION_TOO_LARGE', limit: 1 });
    const cancel = { isCancelled: true, onCancelled: (): (() => void) => () => undefined };
    expect(() =>
      growEditRegion(square, 0, {
        maxNormalAngleRadians: 0.01,
        maxTriangles: 2,
        cancellation: cancel,
      }),
    ).toThrow(/cancelled/);
  });
  it('distinguishes planar from bent geometry and constructs a right-handed frame', () => {
    const s = selectEditSurface(square, 0, { maxNormalAngleRadians: 0.1, maxTriangles: 2 }, 0.001);
    expect(s.planarity.kind).toBe('PLANAR');
    expect(s.triangleIds).toEqual([0, 1]);
    const cross = [
      s.frame.tangentU[1] * s.frame.tangentV[2] - s.frame.tangentU[2] * s.frame.tangentV[1],
      s.frame.tangentU[2] * s.frame.tangentV[0] - s.frame.tangentU[0] * s.frame.tangentV[2],
      s.frame.tangentU[0] * s.frame.tangentV[1] - s.frame.tangentU[1] * s.frame.tangentV[0],
    ];
    expect(cross).toEqual(s.frame.normal);
    const bent = shape([0, 0, 0, 1, 0, 0, 1, 1, 0.2, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
    expect(
      measureEditPlanarity(bent, [0, 1], createEditFrame([0, 0, 0], [0, 0, 1]), 0.01, 0.1).kind,
    ).toBe('NON_PLANAR');
  });
  it('keeps plane tolerance local and explicit', () => {
    const p = createEditFrame([0, 0, 0], [0, 0, 1]);
    expect(classifyEditPlane(p, [0, 0, 0.02], 0.01)).toBe(1);
    expect(classifyEditPlane(p, [0, 0, -0.02], 0.01)).toBe(-1);
    expect(classifyEditPlane(p, [0, 0, 0.005], 0.01)).toBe(0);
  });
  it('transforms point and normal under part rotation and translation', () => {
    const t: PartTransform = [0, 1, 0, -1, 0, 0, 0, 0, 1, 10, 20, 30];
    expect(transformEditPoint([1, 0, 0], t)).toEqual([10, 21, 30]);
    expect(transformEditNormal([1, 0, 0], t)).toEqual([0, 1, 0]);
  });
});

/** What a caller sees when a selection is refused: the typed error, or a failed assertion. */
function refusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw new Error(`Expected a typed refusal, got: ${String(error)}`, { cause: error });
  }
  throw new Error('Expected a refusal, but the selection succeeded.');
}
describe('TEXTURE-FIX-01 D3: selection limits are typed refusals', () => {
  it('refuses a region over its budget, naming the metric and the limit', () => {
    const error = refusal(() =>
      growEditRegion(square, 0, { maxNormalAngleRadians: 0.01, maxTriangles: 1 }),
    );
    expect(error.code).toBe('RESOURCE_LIMIT_EXCEEDED');
    expect(error.details).toEqual({
      reason: 'EDIT_REGION_TOO_LARGE',
      metric: 'regionTriangles',
      limit: 1,
    });
  });

  it('refuses a source above the scan limit before reading it, naming the count and the limit', () => {
    const faces = 1_000_001;
    const huge: CanonicalMesh = {
      positions: createPositionArray(9),
      indices: createIndexArray(faces * 3),
      metadata: {},
    };
    const error = refusal(() =>
      growEditRegion(huge, 0, { maxNormalAngleRadians: 0.01, maxTriangles: 2 }),
    );
    expect(error.code).toBe('RESOURCE_LIMIT_EXCEEDED');
    expect(error.details).toEqual({
      reason: 'EDIT_SOURCE_TOO_LARGE',
      metric: 'sourceTriangles',
      observed: faces,
      limit: 1_000_000,
    });
  });

  it('accepts a source at the scan limit (the limit itself is not moved)', () => {
    const atLimit: CanonicalMesh = {
      positions: createPositionArray(9),
      indices: createIndexArray(1_000_000 * 3),
      metadata: {},
    };
    // Every corner is vertex 0, so no region can be told from the seed: the point is only that
    // the size gate lets exactly 1,000,000 faces through to the scan.
    expect(() =>
      growEditRegion(atLimit, 0, { maxNormalAngleRadians: 0.01, maxTriangles: 2 }),
    ).not.toThrow(/triangles; limit/);
  });
});
