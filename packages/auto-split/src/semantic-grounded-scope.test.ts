import { SharedCancellationSource, throwIfCancelled } from '@cadfixer/shared';
import { expect, it } from 'vitest';
import { required } from './required';
import type { Vec3 } from '@cadfixer/auto-split-contract';
import {
  collectGroundedScopeEnvelope,
  groundedScopeProjection,
  groundedScopeForCut,
} from './semantic-grounded-scope';
const axes: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
function samples(foreign = false): {
  point: Vec3;
  view: number;
  target: boolean;
  peerMask: number;
  rank: number;
  scopeOverhangWitness: boolean;
}[] {
  return [0, 1, 4, 5].flatMap((view) =>
    Array.from({ length: 64 }, (_, i) => ({
      point: [
        foreign && i < 16 ? 0.08 : 0.2 + (i % 16) * 0.016,
        ((i % 4) - 1.5) * 0.03,
        ((Math.floor(i / 4) % 4) - 1.5) * 0.02,
      ] as Vec3,
      view,
      target: !(foreign && i < 16) && !(i % 16 >= 6 && i % 16 <= 9),
      peerMask: 0,
      rank: 0,
      scopeOverhangWitness: false,
    })),
  );
}
function assess(
  points: ReturnType<typeof samples>,
  offset: number,
): ReturnType<typeof groundedScopeForCut> {
  const uncertainty = collectGroundedScopeEnvelope(
    points,
    axes,
    0.6,
    512,
    () => undefined,
    () => undefined,
  );
  const projected = Float64Array.from(points, (p) => p.point[0]);
  const projection = groundedScopeProjection(
    points,
    projected,
    () => undefined,
    () => undefined,
  );
  const rows = Array.from({ length: 6 }, () => ({ target: 0, hit: 0, selected: 0 })),
    below = Array<number>(6).fill(0),
    outside = Array<number>(6).fill(0);
  for (const p of points) {
    const row = required(rows[p.view], 'view');
    if (p.target) row.target++;
    if (p.point[0] >= offset) {
      row.selected++;
      if (p.target) row.hit++;
      if (p.scopeOverhangWitness) outside[p.view] = (outside[p.view] ?? 0) + 1;
    } else if (!p.target) below[p.view] = (below[p.view] ?? 0) + 1;
  }
  return groundedScopeForCut(
    projection,
    rows,
    below,
    outside,
    offset,
    1,
    uncertainty,
    () => undefined,
  );
}
it('retains a meaningful unlabelled interior without treating it as foreign', () => {
  const p = samples();
  expect(p.filter((v) => !v.target).length / p.length).toBeGreaterThan(0.2);
  expect(assess(p, 0.2).state).toBe('TARGET_SCOPE_SUPPORTED');
});
it('rejects a moved boundary that includes corroborated source beyond the target', () => {
  const p = samples(true);
  expect(assess(p, 0.2).state).toBe('TARGET_SCOPE_SUPPORTED');
  const moved = assess(p, 0.05);
  expect(moved.state).toBe('TARGET_SCOPE_OVERBROAD');
  expect(moved.overhangAxes).toEqual([0, 2]);
});
it('cancels scope collection without changing source coordinates', () => {
  const p = Array.from({ length: 20 }, () => samples()).flat();
  const before = p.map((v) => [...v.point]);
  const controller = new SharedCancellationSource();
  let checks = 0;
  expect(() =>
    collectGroundedScopeEnvelope(
      p,
      axes,
      0.6,
      512,
      () => {
        if (++checks === 3) controller.cancel();
        throwIfCancelled(controller.token);
      },
      () => undefined,
    ),
  ).toThrow();
  expect(p.map((v) => [...v.point])).toEqual(before);
});
it('requires corroborated overhang without letting peer labels erase source scope', () => {
  const outside = (views: readonly number[], peerMask: number): ReturnType<typeof samples> =>
    views.flatMap((view) =>
      Array.from({ length: 16 }, (_, i) => ({
        point: [0.7, ((i % 4) - 1.5) * 0.03, ((Math.floor(i / 4) % 4) - 1.5) * 0.02] as Vec3,
        view,
        target: false,
        rank: 0,
        peerMask,
        scopeOverhangWitness: false,
      })),
    );
  expect(assess([...samples(), ...outside([0, 1, 4, 5], 0)], 0.2).state).toBe(
    'TARGET_SCOPE_OVERBROAD',
  );
  const oneAxis = assess([...samples(), ...outside([0, 1], 0)], 0.2);
  expect(oneAxis.state).toBe('TARGET_SCOPE_SUPPORTED');
  expect(oneAxis.supportedAxes).toEqual([0, 2]);
  expect(
    assess(
      samples().filter((p) => p.view < 2),
      0.2,
    ).state,
  ).toBe('TARGET_SCOPE_AMBIGUOUS');
  // A peer label cannot erase corroborated original source outside target scope.
  expect(assess([...samples(), ...outside([0, 1, 4, 5], 1)], 0.2).state).toBe(
    'TARGET_SCOPE_OVERBROAD',
  );
});
