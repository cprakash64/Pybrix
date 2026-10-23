import { it, expect } from 'vitest';
import type { NormalizedGeometry } from './geometry';
import {
  groundedSourceFrame,
  groundedSourceFrameWithProvenance,
  type GroundedSourceFrameProvenance,
} from './semantic-grounded-scope';
import { resolveOwnershipSourceComponent } from './semantic-ownership-source-component';
import { inventorySourceInterfacePlanes } from './semantic-ownership-completeness';
const no = () => {};
const frame = (faces: readonly number[]): GroundedSourceFrameProvenance => ({
  normal: [1, 0, 0],
  sourceFaces: faces,
  sourceFaceVisits: faces.length,
});
const geometry = (rows: readonly { x: number; axis: number }[]): NormalizedGeometry => ({
  positions: Float32Array.from(
    rows.flatMap((r, i) =>
      r.axis === 0
        ? [r.x, i * 2, 0, r.x, i * 2, 1, r.x, i * 2 + 1, 0]
        : [i * 2, r.x, 0, i * 2 + 1, r.x, 0, i * 2, r.x, 1],
    ),
  ),
  indices: Uint32Array.from({ length: rows.length * 3 }, (_, i) => i),
  faceCount: rows.length,
  center: [0, 0, 0],
  scale: 1,
  radius: 50,
  extents: [100, 100, 1],
});
it('material-interface provenance resolves component A and retains a genuine anchor', () => {
  expect(
    resolveOwnershipSourceComponent([0, 0, 1, 1], 2, [0, 1], frame([2, 3]), 8192, no, no),
  ).toEqual({
    proven: true,
    component: 0,
    evidenceKind: 'MATERIAL_INTERFACE_SOURCE',
    anchorFace: 0,
    provenanceFacesInspected: 2,
  });
});
it('accepted grounded direction carries actual original contributors on component B', () => {
  const rows = [
      ...Array.from({ length: 8 }, () => ({ x: 0, axis: 1 })),
      ...Array.from({ length: 12 }, (_, i) => ({ x: 2 + 2 * Math.floor(i / 4), axis: 0 })),
    ],
    g = geometry(rows),
    ranks = rows.map((_, i) => (i < 8 ? 0 : 1)),
    frames = groundedSourceFrameWithProvenance(g, [[1, 0, 0]], 8192, no, no);
  expect(frames).toHaveLength(1);
  expect(frames[0]?.normal).toEqual([1, 0, 0]);
  expect(groundedSourceFrame(g, [[1, 0, 0]], 8192, no, no)).toEqual([[1, 0, 0]]);
  expect(frames[0]?.sourceFaces).toEqual(Array.from({ length: 12 }, (_, i) => i + 8));
  const resolution = resolveOwnershipSourceComponent(ranks, 2, undefined, frames[0], 8192, no, no);
  expect(resolution).toEqual({
    proven: true,
    component: 1,
    evidenceKind: 'GROUNDED_SOURCE_FRAME_SOURCE',
    provenanceFacesInspected: 12,
  });
  expect('anchorFace' in resolution).toBe(false);
});
it('proven material component restricts inventory despite unrelated coplanar source geometry', () => {
  const g = geometry([
      { x: 4, axis: 0 },
      { x: 4, axis: 0 },
      { x: 2, axis: 0 },
      { x: 4, axis: 0 },
      { x: 6, axis: 0 },
    ]),
    ranks = [0, 0, 1, 1, 1],
    resolution = resolveOwnershipSourceComponent(ranks, 2, [2, 3, 4], undefined, 8192, no, no);
  expect(resolution.proven).toBe(true);
  if (!resolution.proven) throw Error('expected source proof');
  const inventory = inventorySourceInterfacePlanes(
    g,
    [1, 0, 0],
    -1,
    ranks,
    resolution.component,
    no,
    no,
  );
  expect(inventory.valid).toBe(true);
  expect(inventory.groups.map((row) => row.offset)).toEqual([4]);
  expect(resolution.component).toBe(1);
});
it('actual grounded normal contributors spanning components fail closed rather than choosing the majority', () => {
  const g = geometry(Array.from({ length: 12 }, (_, i) => ({ x: i, axis: 0 }))),
    frames = groundedSourceFrameWithProvenance(g, [[1, 0, 0]], 8192, no, no),
    ranks = Array.from({ length: 12 }, (_, i) => (i === 11 ? 1 : 0));
  const result = resolveOwnershipSourceComponent(ranks, 2, undefined, frames[0], 8192, no, no);
  expect(result.proven).toBe(false);
  if (!result.proven) expect(result.reason).toBe('TRANSITION_SOURCE_CORRESPONDENCE_UNAVAILABLE');
});
it('missing material interface and missing authoritative frame provenance cannot select component zero', () => {
  expect(resolveOwnershipSourceComponent([0], 1, undefined, undefined, 8192, no, no).proven).toBe(
    false,
  );
  expect(resolveOwnershipSourceComponent([0], 1, undefined, frame([]), 8192, no, no).proven).toBe(
    false,
  );
});
it('invalid material provenance does not fall back to a usable unrelated frame', () => {
  expect(resolveOwnershipSourceComponent([0, 1], 2, [0, 1], frame([1]), 8192, no, no).proven).toBe(
    false,
  );
  expect(resolveOwnershipSourceComponent([0, 1], 2, [], frame([1]), 8192, no, no).proven).toBe(
    false,
  );
});
it('invalid original face IDs or unknown component labels cannot establish source correspondence', () => {
  for (const faces of [[-1], [2], [0.5]])
    expect(
      resolveOwnershipSourceComponent([0, 1], 2, undefined, frame(faces), 8192, no, no).proven,
    ).toBe(false);
  expect(resolveOwnershipSourceComponent([-1], 1, [0], undefined, 8192, no, no).proven).toBe(false);
  expect(resolveOwnershipSourceComponent([2], 2, [0], undefined, 8192, no, no).proven).toBe(false);
});
it('oversized provenance refuses instead of truncating its component proof', () => {
  const faces = Array.from({ length: 8193 }, (_, i) => i);
  expect(
    resolveOwnershipSourceComponent(new Int32Array(8193), 1, undefined, frame(faces), 8192, no, no)
      .proven,
  ).toBe(false);
});
it('cancellation during component provenance resolution aborts with source labels unchanged', () => {
  const ranks = new Int32Array(512).fill(1),
    before = ranks.slice();
  let checks = 0,
    visits = 0;
  expect(() =>
    resolveOwnershipSourceComponent(
      ranks,
      2,
      undefined,
      frame(Array.from({ length: 512 }, (_, i) => i)),
      8192,
      () => {
        if (++checks === 3) throw Error('cancelled');
      },
      () => visits++,
    ),
  ).toThrow('cancelled');
  expect(visits).toBe(256);
  expect(ranks).toEqual(before);
});
it('grounded provenance collection remains cancellable and leaves geometry unchanged', () => {
  const g = geometry(Array.from({ length: 20 }, (_, i) => ({ x: i, axis: 0 }))),
    positions = g.positions.slice(),
    indices = g.indices.slice();
  let checks = 0;
  expect(() =>
    groundedSourceFrameWithProvenance(
      g,
      [[1, 0, 0]],
      8192,
      () => {
        if (++checks === 2) throw Error('cancelled');
      },
      no,
    ),
  ).toThrow('cancelled');
  expect(g.positions).toEqual(positions);
  expect(g.indices).toEqual(indices);
});
