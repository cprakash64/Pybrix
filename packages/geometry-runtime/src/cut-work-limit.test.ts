import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { AppErrorCode, isAppError, uncancellable } from '@cadfixer/shared';
import { splitWithConnectors, type SplitPlane } from './split-connectors';

/**
 * v0.8.0 scale-limit truthfulness. The exact closed-solid cut meters its own work, and a closed model large enough to exhaust that
 * budget is refused. The page words that refusal as the resource refusal it is, and it recognises it by the worker's TYPED error, so
 * this pins the typed error: an `invalid-state` AppError whose details are `code: CUT_NOT_SAFE` and `reason: WORK_LIMIT`. Changing
 * either value, or the budget's decision for this fixture, fails here instead of silently reverting the page's wording.
 *
 * The fixture is the one the heavy-gate qualification measured: a closed UV sphere written as unshared triangles (as an STL import
 * holds it), 1,560,000 triangles, which the budget refuses while 1,499,400 is cut. It is built here, not read from a file.
 */

/** A closed, outward-wound UV sphere of `2 * lon * (lat - 1)` unshared triangles. */
function sphereSoup(lon: number, lat: number): CanonicalMesh {
  const radius = 40;
  const point = (ring: number, step: number): readonly [number, number, number] => {
    if (ring === 0) return [0, 0, radius];
    if (ring === lat) return [0, 0, -radius];
    const theta = (Math.PI * ring) / lat;
    const phi = (2 * Math.PI * (step % lon)) / lon;
    return [
      radius * Math.sin(theta) * Math.cos(phi),
      radius * Math.sin(theta) * Math.sin(phi),
      radius * Math.cos(theta),
    ];
  };
  const corners: (readonly [number, number])[][] = [];
  for (let step = 0; step < lon; step += 1)
    corners.push([
      [0, 0],
      [1, step],
      [1, step + 1],
    ]);
  for (let ring = 1; ring < lat - 1; ring += 1)
    for (let step = 0; step < lon; step += 1)
      corners.push(
        [
          [ring, step],
          [ring + 1, step],
          [ring, step + 1],
        ],
        [
          [ring, step + 1],
          [ring + 1, step],
          [ring + 1, step + 1],
        ],
      );
  for (let step = 0; step < lon; step += 1)
    corners.push([
      [lat, 0],
      [lat - 1, step + 1],
      [lat - 1, step],
    ]);
  const positions = createPositionArray(corners.length * 9);
  const indices = createIndexArray(corners.length * 3);
  let offset = 0;
  corners.forEach((triangle, face) => {
    for (const [ring, step] of triangle) {
      const [x, y, z] = point(ring, step);
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
      offset += 3;
    }
    indices[face * 3] = face * 3;
    indices[face * 3 + 1] = face * 3 + 1;
    indices[face * 3 + 2] = face * 3 + 2;
  });
  return { positions, indices, metadata: {} };
}

const plane: SplitPlane = { origin: [0, 0, -5.6], normal: [0, 0, 1] };
const noBoolean = {
  operate: (): never => {
    throw Error('a plain cut of a closed model must not reach the Boolean');
  },
};

describe('the exact cut refuses a closed model that exhausts its work budget, as a typed WORK_LIMIT', () => {
  it('1,560,000 triangles: invalid-state, CUT_NOT_SAFE, reason WORK_LIMIT', async () => {
    const mesh = sphereSoup(1250, 625);
    expect(mesh.indices.length / 3).toBe(1_560_000);
    const refusal = await splitWithConnectors(
      noBoolean,
      mesh,
      { plane, connector: { kind: 'none' } },
      uncancellable,
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(isAppError(refusal)).toBe(true);
    if (!isAppError(refusal)) return;
    expect(refusal.code).toBe(AppErrorCode.InvalidState);
    expect(refusal.details.code).toBe('CUT_NOT_SAFE');
    expect(refusal.details.reason).toBe('WORK_LIMIT');
  }, 120_000);
});
