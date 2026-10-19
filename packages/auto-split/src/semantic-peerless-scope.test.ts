import type { PeerlessScopeEvidence } from './semantic-peerless-scope';
import { required } from './required';
import { it, expect } from 'vitest';
import {
  peerlessScopeProjection,
  peerlessScopeForCut,
  collectPeerlessScopeEnvelope,
} from './semantic-peerless-scope';
function evidence(
  views: readonly number[],
  unknown: (i: number) => number,
  side = 1,
): PeerlessScopeEvidence {
  const points: {
      view: number;
      target: boolean;
    }[] = [],
    values: number[] = [];
  for (const view of views) {
    for (let i = 0; i < 100; i++) {
      points.push({ view, target: true });
      values.push(side * (0.2 + i * 0.008));
    }
    for (let i = 0; i < 100; i++) {
      points.push({ view, target: false });
      values.push(side * unknown(i));
    }
  }
  const projected = Float64Array.from(values);
  const projection = peerlessScopeProjection(
    points,
    projected,
    () => undefined,
    () => undefined,
  );
  const rows = Array.from({ length: 6 }, () => ({ target: 0, hit: 0, selected: 0 }));
  const below = new Array<number>(6).fill(0);
  for (const [i, p] of points.entries()) {
    const row = required(rows[p.view], 'bounded peerless evidence');
    if (p.target) row.target++;
    if (required(values[i], 'bounded peerless evidence') * side >= 0) {
      row.selected++;
      if (p.target) row.hit++;
    }
    if (required(values[i], 'bounded peerless evidence') < 0 && !p.target)
      below[p.view] = required(below[p.view], 'bounded peerless evidence') + 1;
  }
  return peerlessScopeForCut(projection, rows, below, 0, side, () => undefined);
}
it('keeps substantial unlabeled foreground within target extent neutral', () => {
  const result = evidence([0, 2], (i) => 0.4 + i * 0.004);
  expect(result.state).toBe('TARGET_SCOPE_SUPPORTED');
  expect(result.rows[0]?.unlabeledSelected).toBe(100);
  expect(result.overhangAxes).toEqual([]);
});
it('requires two independent axes for material selected-side overhang in both orientations', () => {
  for (const side of [1, -1]) {
    expect(evidence([0, 2], (i) => 0.01 + i * 0.001, side).state).toBe('TARGET_SCOPE_OVERBROAD');
    expect(evidence([0, 1], (i) => 0.01 + i * 0.001, side).state).toBe('TARGET_SCOPE_AMBIGUOUS');
  }
});
it('does not interpret missing annotations as negative source evidence', () => {
  const result = evidence([0], (i) => 0.5 + i * 0.001);
  expect(result.state).toBe('TARGET_SCOPE_AMBIGUOUS');
  expect(result.overhangAxes).toEqual([]);
});
it('cancels collection without changing the sampled source', () => {
  const points = Array.from({ length: 3000 }, (_, i) => ({ view: i % 6, target: true }));
  const projected = Float64Array.from(points, (_, i) => i / 3000),
    before = projected.slice();
  let calls = 0,
    published = false;
  expect(() => {
    peerlessScopeProjection(
      points,
      projected,
      () => {
        if (++calls === 2) throw Error('cancelled scope collection');
      },
      () => undefined,
    );
    published = true;
  }).toThrow('cancelled scope collection');
  expect(published).toBe(false);
  expect(projected).toEqual(before);
});
it('recognizes selected source overhang orthogonal to the cut while leaving an unlabeled interior neutral', () => {
  const points: {
    point: readonly [number, number, number];
    view: number;
    target: boolean;
    scopeOverhangWitness?: boolean;
  }[] = [];
  for (const view of [0, 2])
    for (let i = 0; i < 100; i++) {
      points.push({
        point: [0.2 + (i % 10) * 0.08, -0.3 + Math.floor(i / 10) * 0.06, ((i % 3) - 1) * 0.2],
        view,
        target: true,
      });
      points.push({ point: [0.5, 0, 0], view, target: false });
      points.push({ point: [-0.5, 0, 0], view, target: false });
    }
  collectPeerlessScopeEnvelope(
    points,
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    () => undefined,
    () => undefined,
  );
  expect(
    points.filter((p) => !p.target && p.point[0] === 0.5).every((p) => !p.scopeOverhangWitness),
  ).toBe(true);
  expect(points.filter((p) => p.point[0] === -0.5).every((p) => p.scopeOverhangWitness)).toBe(true);
  const projected = Float64Array.from(points, (p) => p.point[1]);
  const projection = peerlessScopeProjection(
      points,
      projected,
      () => undefined,
      () => undefined,
    ),
    rows = Array.from({ length: 6 }, () => ({ target: 0, hit: 0, selected: 0 })),
    below = new Array<number>(6).fill(0),
    outside = new Array<number>(6).fill(0);
  for (const [i, p] of points.entries()) {
    const row = required(rows[p.view], 'bounded peerless evidence');
    if (p.target) row.target++;
    if (required(projected[i], 'bounded peerless evidence') >= -0.31) {
      row.selected++;
      if (p.target) row.hit++;
      if (p.scopeOverhangWitness)
        outside[p.view] = required(outside[p.view], 'bounded peerless evidence') + 1;
    } else if (!p.target) below[p.view] = required(below[p.view], 'bounded peerless evidence') + 1;
  }
  expect(
    peerlessScopeForCut(projection, rows, below, -0.31, 1, () => undefined, outside).state,
  ).toBe('TARGET_SCOPE_OVERBROAD');
});
