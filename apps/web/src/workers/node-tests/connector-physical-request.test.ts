import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyPlacement,
  createIndexArray,
  createPositionArray,
  IDENTITY_PLACEMENT,
  type CanonicalMesh,
  type PlacementClass,
} from '@cadfixer/mesh-core';
import { CancellationSource, isAppError } from '@cadfixer/shared';
import {
  splitWithConnectors,
  type SplitConnector,
  type SplitRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/*
 * Stage C03-A — a physical pin request (millimetres + the unit the coordinates are read in) is the same operation as the coordinate
 * pin the page used to send. The engine resolves the physical request ONCE at its entry, so everything below the entry is untouched;
 * these tests hold that to the bit on the real kernel.
 */
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
function cube(size: number): CanonicalMesh {
  const h = size / 2,
    p = [-h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h, -h, -h, h, h, -h, h, -h, h, h, h, h, h],
    i = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
const X_PLANE = { origin: [0, 0, 0], normal: [1, 0, 0] } as const;
async function run(
  connector: SplitRequest['connector'],
  size = 20,
  placement: PlacementClass = IDENTITY_PLACEMENT,
): Promise<SplitResult> {
  const backend = await createManifoldBooleanBackend(binary);
  return splitWithConnectors(
    backend,
    cube(size),
    { plane: X_PLANE, connector },
    new CancellationSource().token,
    undefined,
    placement,
  );
}
const digest = (result: SplitResult): string => {
  const hash = createHash('sha256');
  for (const piece of [result.pieceA, result.pieceB]) {
    hash.update(
      Buffer.from(piece.positions.buffer, piece.positions.byteOffset, piece.positions.byteLength),
    );
    hash.update(
      Buffer.from(piece.indices.buffer, piece.indices.byteOffset, piece.indices.byteLength),
    );
  }
  hash.update(JSON.stringify(result.connector));
  hash.update(JSON.stringify(result.interface));
  return hash.digest('hex');
};
const physical = (unit: string, scaleless = 1): SplitRequest['connector'] => ({
  kind: 'physical-pin',
  unit,
  count: 1,
  diameterMm: 3 * scaleless,
  depthMm: 4 * scaleless,
  clearanceMm: 0.2 * scaleless,
  maleSide: 'A',
});

describe('a physical pin request resolves to the coordinate pin it replaces', () => {
  it('millimetre coordinates: identical to the coordinate pin, to the bit', async () => {
    const legacy: SplitConnector = {
      kind: 'pin',
      count: 1,
      diameter: 3,
      depth: 4,
      clearance: 0.2,
      maleSide: 'A',
    };
    const [a, b] = [await run(legacy), await run(physical('millimeter'))];
    expect(a.connector.kind).toBe('pin');
    expect(digest(b)).toBe(digest(a));
    expect(b.connector).toEqual(legacy);
  });
  it('centimetre coordinates: the sizes are divided by the unit once, exactly as the page used to', async () => {
    // the page's old expression, written out: millimetres / millimetres-per-unit, centimetre = 10 mm
    const legacy: SplitConnector = {
      kind: 'pin',
      count: 1,
      diameter: 3 / 10,
      depth: 4 / 10,
      clearance: 0.2 / 10,
      maleSide: 'A',
    };
    const [a, b] = [await run(legacy), await run(physical('centimeter'))];
    expect(a.connector.kind).toBe('pin');
    expect(digest(b)).toBe(digest(a));
  });
  it('inch coordinates: 25.4 mm to a unit, no rounding of its own', async () => {
    const legacy: SplitConnector = {
      kind: 'pin',
      count: 1,
      diameter: 3 / 25.4,
      depth: 4 / 25.4,
      clearance: 0.2 / 25.4,
      maleSide: 'A',
    };
    const [a, b] = [await run(legacy, 2), await run(physical('inch'), 2)];
    expect(a.connector.kind).toBe('pin');
    expect(digest(b)).toBe(digest(a));
  });
  it('KNOWN LEGACY BEHAVIOUR, pinned until the stage that changes it: a manual pin does not take the placement scale', async () => {
    const [unscaled, scaled] = [
      await run(physical('millimeter')),
      await run(
        physical('millimeter'),
        20,
        classifyPlacement([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]),
      ),
    ];
    expect(digest(scaled)).toBe(digest(unscaled));
  });
  it('an unknown unit is refused before any cut, with the typed code the automatic path uses', async () => {
    for (const unit of ['', 'furlong', 'constructor', '__proto__']) {
      let caught: unknown;
      try {
        await run(physical(unit));
      } catch (error) {
        caught = error;
      }
      expect(isAppError(caught)).toBe(true);
      if (isAppError(caught)) expect(caught.details).toMatchObject({ code: 'UNKNOWN_UNITS' });
    }
  });
  it('a size the engine refuses in coordinates is still refused by the engine, not clamped', async () => {
    // 3 mm in a metre-read model is 0.003 coordinate units, below the engine's 0.01 minimum: unchanged behaviour, refused loudly
    await expect(run(physical('meter'))).rejects.toThrow(/outside the supported range/);
  });
});
