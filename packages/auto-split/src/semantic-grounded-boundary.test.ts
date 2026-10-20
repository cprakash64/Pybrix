import { SharedCancellationSource, throwIfCancelled } from '@cadfixer/shared';
import { beforeAll, expect, it } from 'vitest';
import {
  cameraFor,
  FRAME_FILL,
  VIEW_NAMES,
  type SemanticPart,
  type Vec3,
} from '@cadfixer/auto-split-contract';
import { box } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import { prepareSemanticGeometry, type PreparedSemanticGeometry } from './semantic';
import {
  collectGroundedBoundaryWitnesses,
  groundedBoundaryForNormal,
  GROUNDED_BOUNDARY_LIMITS,
} from './semantic-grounded-boundary';
import { required } from './required';
let prepared: PreparedSemanticGeometry, part: SemanticPart;
const frame: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  boundary = 0.0315;
const digest = (p: PreparedSemanticGeometry): string => {
  let checksum = 2166136261;
  const update = (bytes: Uint8Array): void => {
    for (const byte of bytes) checksum = Math.imul(checksum ^ byte, 16777619);
  };
  update(new Uint8Array(p.geometry.positions.buffer));
  update(new Uint8Array(p.geometry.indices.buffer));
  for (const r of p.rasters) {
    update(new Uint8Array(r.face.buffer));
    if (r.depth) update(new Uint8Array(r.depth.buffer));
  }
  return String(checksum >>> 0);
};
beforeAll(async () => {
  prepared = await prepareSemanticGeometry(box([-8, -3, -2], [8, 3, 2]), fixtureDeflate);
  part = {
    id: 'target',
    label: 'Physical terminal',
    parentId: null,
    importance: 'major',
    confidence: 0.99,
    instances: 1,
    componentIds: [],
    cut: null,
    expectedGeometry: { kind: 'solid_part', likelySeparable: true },
    views: VIEW_NAMES.flatMap((view, vi) => {
      const raster = required(prepared.rasters[vi], 'view'),
        camera = cameraFor(view),
        k = (raster.size * FRAME_FILL) / (2 * prepared.geometry.radius);
      let loX = raster.size,
        loY = raster.size,
        hiX = -1,
        hiY = -1;
      for (let pixel = 0; pixel < raster.face.length; pixel++) {
        const depth = raster.depth?.[pixel];
        if ((raster.face[pixel] ?? -1) < 0 || depth === undefined) continue;
        const x = pixel % raster.size,
          y = Math.floor(pixel / raster.size);
        const px =
          (camera.right[0] * (x + 0.5 - raster.size / 2)) / k -
          (camera.up[0] * (y + 0.5 - raster.size / 2)) / k +
          camera.forward[0] * depth;
        if (px < boundary) continue;
        loX = Math.min(loX, x);
        loY = Math.min(loY, y);
        hiX = Math.max(hiX, x);
        hiY = Math.max(hiY, y);
      }
      return hiX < 0
        ? []
        : [
            {
              view,
              polygons: [
                [
                  [loX / raster.size, loY / raster.size],
                  [(hiX + 1) / raster.size, loY / raster.size],
                  [(hiX + 1) / raster.size, (hiY + 1) / raster.size],
                  [loX / raster.size, (hiY + 1) / raster.size],
                ],
              ],
            },
          ];
    }),
  };
});
it('recovers independently seen mask boundaries without scanning a candidate grid or mutating source', () => {
  const before = digest(prepared);
  const witnesses = collectGroundedBoundaryWitnesses(
    prepared,
    part,
    frame,
    () => undefined,
    () => undefined,
  );
  const witness = required(groundedBoundaryForNormal(witnesses, [1, 0, 0]), 'terminal boundary');
  const pixel = (2 * prepared.geometry.radius) / (512 * FRAME_FILL);
  expect(witness.low).toBeGreaterThanOrEqual(boundary - pixel);
  expect(witness.low).toBeLessThanOrEqual(boundary + pixel);
  expect(witness.observedAxes.length).toBeGreaterThanOrEqual(2);
  expect(witness.pixelVisits).toBeLessThanOrEqual(GROUNDED_BOUNDARY_LIMITS.samplesPerView * 9 * 6);
  expect(digest(prepared)).toBe(before);
});
it('opposite normal equations use the same observed boundary', () => {
  const witnesses = collectGroundedBoundaryWitnesses(
    prepared,
    part,
    frame,
    () => undefined,
    () => undefined,
  );
  const a = required(groundedBoundaryForNormal(witnesses, [1, 0, 0]), 'forward'),
    b = required(groundedBoundaryForNormal(witnesses, [-1, 0, 0]), 'reverse');
  expect(b.low).toBe(-a.high);
  expect(b.high).toBe(-a.low);
});
it('cancels perimeter collection without publishing or altering source', () => {
  const before = digest(prepared),
    controller = new SharedCancellationSource();
  let checks = 0;
  expect(() =>
    collectGroundedBoundaryWitnesses(
      prepared,
      part,
      frame,
      () => {
        if (++checks === 4) controller.cancel();
        throwIfCancelled(controller.token);
      },
      () => undefined,
    ),
  ).toThrow();
  expect(digest(prepared)).toBe(before);
});
it('bounds and cancels the separate source end-face observation pass', () => {
  const before = digest(prepared);
  let work = 0;
  const witnesses = collectGroundedBoundaryWitnesses(
    prepared,
    part,
    frame,
    () => undefined,
    () => work++,
  );
  const perimeterWork = witnesses[0]?.pixelVisits ?? 0;
  expect(witnesses.length).toBeGreaterThan(0);
  expect(work).toBeLessThanOrEqual(
    perimeterWork + 3 * 6 * GROUNDED_BOUNDARY_LIMITS.capSamplesPerView,
  );
  const controller = new SharedCancellationSource();
  let cancelledWork = 0;
  expect(() =>
    collectGroundedBoundaryWitnesses(
      prepared,
      part,
      frame,
      () => {
        if (cancelledWork > perimeterWork + 64) controller.cancel();
        throwIfCancelled(controller.token);
      },
      () => cancelledWork++,
    ),
  ).toThrow();
  expect(cancelledWork).toBeGreaterThan(perimeterWork);
  expect(digest(prepared)).toBe(before);
});
