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
  it('a manual pin takes the placement scale (Stage C03-C1): 3 mm on a model placed at 2 is the coordinate pin of 3 / 2, to the bit', async () => {
    const at = (scale: number): PlacementClass =>
      classifyPlacement([scale, 0, 0, 0, scale, 0, 0, 0, scale, 0, 0, 0]);
    const unscaled = await run(physical('millimeter'), 100);
    for (const scale of [2, 0.5, 4, 0.25]) {
      const scaled = await run(physical('millimeter'), 100, at(scale));
      // the independent expression: millimetres over (millimetres per unit × scale), written out
      const equivalent: SplitConnector = {
        kind: 'pin',
        count: 1,
        diameter: 3 / scale,
        depth: 4 / scale,
        clearance: 0.2 / scale,
        maleSide: 'A',
      };
      expect(scaled.connector, `scale ${String(scale)}`).toEqual(equivalent);
      expect(digest(scaled)).toBe(digest(await run(equivalent, 100)));
      // and it is NOT the unscaled pin any more: that was the defect
      expect(digest(scaled)).not.toBe(digest(unscaled));
    }
  });
  it('the plan states how the millimetres became local lengths, under the physical policy label', async () => {
    const scaled = await run(
      physical('inch', 2),
      20,
      classifyPlacement([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]),
    );
    expect(scaled.connectorPlan).toMatchObject({
      version: 1,
      policy: 'units-v1',
      unitContext: {
        basis: 'PHYSICAL_MM',
        unit: 'inch',
        partScale: 2,
        partScaleApplied: true,
        mmPerUnit: 25.4,
        mmPerCoordinate: 50.8,
        intentMm: { diameter: 6, depth: 8, clearance: 0.4 },
      },
    });
    // a COORDINATE pin keeps the legacy label and says it applied nothing
    const coordinate = await run({
      kind: 'pin',
      count: 1,
      diameter: 3,
      depth: 4,
      clearance: 0.2,
      maleSide: 'A',
    });
    expect(coordinate.connectorPlan).toMatchObject({
      policy: 'legacy-v0',
      unitContext: { basis: 'COORDINATES', partScale: 1, partScaleApplied: false },
    });
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
  it('metre and micron models place the default pin (Stage C03-C1): the physical range is judged in millimetres, not in coordinates', async () => {
    // 3 mm in a metre-read model is 0.003 coordinate units, which the old coordinate bound refused; it is 3 mm
    const meter = await run(physical('meter'));
    expect(meter.connector).toMatchObject({ kind: 'pin', diameter: 3 / 1000, depth: 4 / 1000 });
    // and 3 mm in a micron-read model is 3,000 coordinate units, which it refused from above
    const micron = await run(physical('micron'), 20_000);
    expect(micron.connector).toMatchObject({ kind: 'pin', diameter: 3 / 0.001, depth: 4 / 0.001 });
  });
  it('a size outside the PHYSICAL range is refused with the metric, the value and the limit, before any centre is chosen, in every unit', async () => {
    for (const unit of ['millimeter', 'meter', 'micron'])
      for (const [over, dimension, text] of [
        [{ diameterMm: 0.001 }, 'PIN_DIAMETER', /Pin diameter of 0.001 mm is outside the range/],
        [{ depthMm: 2000 }, 'PIN_DEPTH', /Pin depth of 2000 mm is outside the range/],
        [{ clearanceMm: -1 }, 'PIN_CLEARANCE', /Pin clearance of -1 mm is outside the range/],
      ] as const) {
        let caught: unknown;
        try {
          await run({ ...(physical(unit) as object), ...over } as SplitRequest['connector']);
        } catch (error) {
          caught = error;
        }
        expect(isAppError(caught), `${unit} ${dimension}`).toBe(true);
        if (isAppError(caught)) {
          expect(caught.details).toMatchObject({
            code: 'CONNECTOR_DIMENSION_OUT_OF_POLICY',
            refusal: 'DIMENSION_OUT_OF_POLICY',
            dimension,
            reason: 'OUT_OF_RANGE',
            maxMm: 1000,
          });
          expect(caught.message).toMatch(text);
        }
      }
  });
  it("the engine's pinned COORDINATE request keeps its coordinate bound (no product flow sends it): 0.003 coordinate units is still refused", async () => {
    await expect(
      run({
        kind: 'pin',
        count: 1,
        diameter: 0.003,
        depth: 0.004,
        clearance: 0.0002,
        maleSide: 'A',
      }),
    ).rejects.toThrow(/outside the supported range/);
  });
});
