import { describe, expect, it } from 'vitest';
import {
  ExactVisibilityAcceleration,
  type ExactProjectedTriangle,
} from './semantic-exact-visibility-acceleration';
import type { ExactProjectedPoint } from './semantic-exact-owner-preprocessing';

const q = (n: number): { n: bigint; d: bigint } => ({ n: BigInt(n), d: 1n });
function triangle(x = 0, y = 0): ExactProjectedTriangle {
  const vs = [
    { x: q(x), y: q(y), z: q(0) },
    { x: q(x + 2), y: q(y), z: q(0) },
    { x: q(x), y: q(y + 2), z: q(0) },
  ];
  return {
    vs,
    area: q(4),
    loX: q(x),
    hiX: q(x + 2),
    loY: q(y),
    hiY: q(y + 2),
    depthRange: { minDepth: q(0), maxDepth: q(0) },
  };
}
// Independent integer separating-axis oracle. Equality allows contact but no positive-area overlap.
function oracle(a: ExactProjectedTriangle, b: ExactProjectedTriangle): boolean {
  const dot = (p: ExactProjectedPoint, x: bigint, y: bigint): bigint => p.x.n * x + p.y.n * y;
  for (const polygon of [a.vs, b.vs]) {
    for (let i = 0; i < 3; i++) {
      const p = polygon[i],
        next = polygon[(i + 1) % 3];
      if (!p || !next) throw Error('Incomplete test triangle');
      const x = p.y.n - next.y.n,
        y = next.x.n - p.x.n;
      const aa = a.vs.map((v) => dot(v, x, y)),
        bb = b.vs.map((v) => dot(v, x, y));
      const min = (values: bigint[]): bigint => values.reduce((u, v) => (u < v ? u : v));
      const max = (values: bigint[]): bigint => values.reduce((u, v) => (u > v ? u : v));
      if (max(aa) <= min(bb) || max(bb) <= min(aa)) return true;
    }
  }
  return false;
}
function measured(): { v: ExactVisibilityAcceleration; work: () => number } {
  let work = 0;
  const v = new ExactVisibilityAcceleration(
    [],
    [],
    () => {
      work++;
    },
    () => undefined,
  );
  return { v, work: (): number => work };
}
function saturate(v: ExactVisibilityAcceleration): void {
  for (let i = 0; i < 683; i++) v.separated(triangle(), triangle(4, 4));
  expect(v.snapshot().pointRecords).toBe(4096);
}

describe('immutable target separating predicate reuse', () => {
  it('preserves exact predicates across changing occluders and removes repeated work after point-map saturation', () => {
    const hot = measured(),
      cold = measured();
    saturate(hot.v);
    saturate(cold.v);
    const target = triangle(),
      source = triangle(5, 5);
    hot.v.separated(target, source);
    cold.v.separated(triangle(), source);
    const beforeHot = hot.work(),
      beforeCold = cold.work();
    for (let i = 0; i < 60; i++) {
      const other = triangle((i % 9) - 4, (i % 7) - 3),
        expected = oracle(target, other);
      expect(hot.v.separated(target, other)).toBe(expected);
      expect(cold.v.separated(triangle(), other)).toBe(expected);
    }
    expect(hot.work() - beforeHot).toBeLessThan(cold.work() - beforeCold);
    hot.v.dispose();
    cold.v.dispose();
  });
  it('invalidates on target identity changes and clears bounded retained state on disposal', () => {
    const { v } = measured();
    for (let i = 0; i < 100; i++) {
      const target = triangle(i % 5, i % 3),
        other = triangle((i % 7) - 2, 1);
      expect(v.separated(target, other)).toBe(oracle(target, other));
      expect(v.snapshot().cachedTargetBytes).toBeLessThanOrEqual(2048);
    }
    v.dispose();
    expect(v.snapshot()).toMatchObject({ cachedTargetBytes: 0, pointRecords: 0, disposed: true });
    expect(v.separated(triangle(), triangle(4, 4))).toBe(false);
  });
  it('propagates cancellation during compilation without publishing partial predicates', () => {
    for (const stop of [1, 8, 22, 40, 110, 125]) {
      let work = 0,
        cancel = true;
      const v = new ExactVisibilityAcceleration(
        [],
        [],
        () => {
          if (++work === stop && cancel) throw Error('cancel');
        },
        () => undefined,
      );
      const a = triangle(),
        b = triangle(4, 4);
      expect(() => v.separated(a, b)).toThrow('cancel');
      if (stop <= 40) expect(v.snapshot().cachedTargetBytes).toBe(0);
      expect(v.snapshot().cachedTargetBytes).toBeLessThanOrEqual(2048);
      cancel = false;
      expect(v.separated(a, b)).toBe(oracle(a, b));
      v.dispose();
      expect(v.snapshot().cachedTargetBytes).toBe(0);
    }
  });
});
