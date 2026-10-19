import { required } from './required';
import { it, expect } from 'vitest';
import { probePeerlessSections } from './semantic-peerless-frontier';
import { normalizeGeometry } from './geometry';
import { voxelUnion, box } from './fixtures';
import type { Vec3 } from '@cadfixer/auto-split-contract';
it('stratified sparse previews retain a real step through rotation and quarter-band shifts', () => {
  for (const angle of [0, 0.337, 0.811]) {
    const mesh = voxelUnion([
      { lo: [-12, -2, -3], hi: [2, 2, 3] },
      { lo: [2, -7, -5], hi: [11, 7, 5] },
    ]);
    const c = Math.cos(angle),
      s = Math.sin(angle);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = required(mesh.positions[i], 'bounded peerless evidence'),
        y = required(mesh.positions[i + 1], 'bounded peerless evidence');
      mesh.positions[i] = c * x - s * y;
      mesh.positions[i + 1] = s * x + c * y;
    }
    const geometry = normalizeGeometry(mesh.positions, mesh.indices),
      normal: Vec3 = [c, s, 0];
    const sourceOrigin = [2 * c, 2 * s, 0],
      boundary = normal.reduce(
        (sum, n, a) =>
          sum +
          (n *
            (required(sourceOrigin[a], 'bounded peerless evidence') -
              required(geometry.center[a], 'bounded peerless evidence'))) /
            geometry.scale,
        0,
      );
    const cuts = [-0.012, 0.009].map((shift) => ({ normal, offset: boundary + shift }));
    const sampled = probePeerlessSections(geometry, cuts, 512, () => undefined),
      full = probePeerlessSections(geometry, cuts, geometry.faceCount, () => undefined);
    expect(sampled.triangleVisits).toBeLessThanOrEqual(512 * cuts.length);
    for (let i = 0; i < cuts.length; i++) {
      expect(required(full.profiles[i], 'bounded peerless evidence').contrast).toBeGreaterThan(0.4);
      expect(
        Math.abs(
          required(sampled.profiles[i], 'bounded peerless evidence').contrast -
            required(full.profiles[i], 'bounded peerless evidence').contrast,
        ),
      ).toBeLessThan(0.15);
    }
  }
});
it('a constant section does not gain a seam from sampling or an exact source-edge zero', () => {
  const mesh = box([-1, -1, -1], [1, 1, 1]),
    geometry = normalizeGeometry(mesh.positions, mesh.indices);
  const result = probePeerlessSections(
    geometry,
    [{ normal: [1, 0, 0], offset: 0 }],
    8192,
    () => undefined,
  );
  expect(required(result.profiles[0], 'bounded peerless evidence').contrast).toBeLessThan(1e-8);
});
it('cancels sparse structural ranking before publishing and leaves source intact', () => {
  const mesh = box([-1, -1, -1], [1, 1, 1]),
    geometry = normalizeGeometry(mesh.positions, mesh.indices),
    before = geometry.positions.slice();
  let published = false;
  expect(() => {
    probePeerlessSections(geometry, [{ normal: [1, 0, 0], offset: 0 }], 8192, () => {
      throw Error('cancelled structural ranking');
    });
    published = true;
  }).toThrow('cancelled structural ranking');
  expect(published).toBe(false);
  expect(geometry.positions).toEqual(before);
});
