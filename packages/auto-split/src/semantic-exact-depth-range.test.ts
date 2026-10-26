import type { WholeInterfaceCertificate } from './semantic-whole-interface-certificate';
import type { ExactTriangleDepthRange } from './semantic-exact-depth-range';
import { expect, it, vi } from 'vitest';
import { cameraFor, VIEW_NAMES } from '@cadfixer/auto-split-contract';
import {
  exactTriangleDepthRange as range,
  exactRangeNonCloser as reject,
  type ExactDepth,
} from './semantic-exact-depth-range';
import { certifyWholeInterface } from './semantic-whole-interface-certificate';
import { ExactVisibilityAcceleration } from './semantic-exact-visibility-acceleration';
import { InvocationExactGcdCache } from './semantic-exact-gcd-cache';
const q = (n: bigint | number, d = 1n): ExactDepth => ({ n: BigInt(n), d });
const cmp = (a: ExactDepth, b: ExactDepth): number => {
  const n = a.n * b.d - b.n * a.d;
  return n < 0n ? -1 : n > 0n ? 1 : 0;
};
const r = (zs: ExactDepth[]): ExactTriangleDepthRange =>
  range(
    zs.map((z) => ({ z })),
    cmp,
  );
const testPair = (s: number[], t: number[]): boolean =>
  reject(r(s.map((x) => q(x))), r(t.map((x) => q(x))), cmp);
function certificate(
  sourceDepth = 0.125,
  shape = 'normal',
  checkpoint = (): void => {
    // Intentionally empty hook; preserve the undefined return value.
  },
): {
  result: WholeInterfaceCertificate;
  positions: Float32Array<ArrayBuffer>;
  before: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  work: number;
} {
  const tri =
    shape === 'degenerate'
      ? [-0.25, 0, 0, 0, 0, 0, 0.25, 0, 0]
      : [-0.25, 0, -0.25, 0.25, 0, -0.25, 0, 0, shape === 'near' ? 2 ** -40 : 0.25];
  if (shape === 'near') tri.splice(0, 9, 0, 0, 0, 0.25, 0, 0, 0.25, 0, 2 ** -40);
  const other = [-0.25, sourceDepth, -0.25, 0.25, sourceDepth, -0.25, 0, sourceDepth, 0.25];
  if (shape === 'disjoint') for (let i = 0; i < 9; i += 3) other[i] = requiredValue(other[i]) + 2;
  const positions = new Float32Array([...tri, ...other]),
    indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const prepared = { geometry: { positions, indices, faceCount: 2, radius: 1 }, rasters: [] };
  let work = 0;
  const before = positions.slice();
  const result = certifyWholeInterface(
    prepared as never,
    { faces: [0] } as never,
    [
      {
        id: 'owner',
        views: [
          {
            view: 'front',
            polygons: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
            ],
          },
        ],
      },
    ] as never,
    checkpoint,
    () => {
      work++;
    },
  );
  return { result, positions, before, indices, work };
}
// The visibility tree can reject a non-closer pair before the range stage.
// Select the supported grid fallback to test that stage's unchanged clipping/accounting contract.
function rangeFallbackCertificate(
  sourceDepth = 0.125,
  shape = 'normal',
): ReturnType<typeof certificate> {
  const build = vi
    .spyOn(ExactVisibilityAcceleration.prototype, 'build')
    .mockImplementation((): void => undefined);
  try {
    return certificate(sourceDepth, shape);
  } finally {
    build.mockRestore();
  }
}
it('01 strictly behind rejects', () => {
  expect(testPair([2, 3, 4], [-1, 0, 1])).toBe(true);
});
it('02 strictly closer passes through', () => {
  expect(testPair([-4, -3, -2], [0, 1, 2])).toBe(false);
});
it('03 overlapping ranges pass through', () => {
  expect(testPair([0, 2, 4], [1, 3, 5])).toBe(false);
});
it('04 equality preserves strict tie', () => {
  expect(testPair([1, 2, 3], [-1, 0, 1])).toBe(true);
});
it('05 coplanar tie rejects without occlusion', () => {
  const x = rangeFallbackCertificate(0);
  expect(x.result.complete).toBe(true);
  expect(x.result.rangeRejects).toBe(1);
});
it('06 crossing depth not rejected', () => {
  expect(testPair([-1, 2, 3], [0, 0, 0])).toBe(false);
});
it('07 one closer source vertex prevents reject', () => {
  expect(testPair([-1, 20, 20], [0, 0, 0])).toBe(false);
});
it('08 interface extremum changes condition', () => {
  expect(testPair([2, 2, 2], [1, 1, 1])).toBe(true);
  expect(testPair([2, 2, 2], [1, 1, 3])).toBe(false);
});
it('09 disjoint AABB uses existing broad phase', () => {
  const x = certificate(0.125, 'disjoint');
  expect(x.result.complete).toBe(true);
  expect(x.result.rangeChecks).toBe(0);
});
it('10 zero-area interface retains exclusion', () => {
  const x = certificate(0.125, 'degenerate');
  expect(x.result.complete).toBe(false);
  expect(x.result.rangeChecks).toBe(0);
});
it('11 near-degenerate exact geometry supported', () => {
  const x = rangeFallbackCertificate(0.125, 'near');
  expect(x.result.complete).toBe(true);
  expect(x.result.rangeRejects).toBe(1);
});
it('12 negative depths have no artificial near plane', () => {
  expect(testPair([-2, -2, -2], [-4, -3, -2])).toBe(true);
});
it('13 orthographic canonical cameras', () => {
  for (const view of VIEW_NAMES) {
    const c = cameraFor(view);
    expect(c.forward.reduce((s, n) => s + n * n, 0)).toBe(1);
  }
});
it('14 perspective is not a supported camera variant', () => {
  expect(VIEW_NAMES).toHaveLength(6);
  for (const v of VIEW_NAMES)
    expect(Object.keys(cameraFor(v)).sort()).toEqual(['forward', 'right', 'up', 'view']);
});
it('15 winding reversal has identical bounds', () => {
  const a = [q(-2), q(3), q(1)];
  expect(r(a)).toEqual(r([...a].reverse()));
});
it('16 different geometry same extrema same proof', () => {
  expect(r([q(1), q(2), q(3)])).toEqual(r([q(3), q(3), q(1)]));
});
it('17 large exact rational operands', () => {
  const a = (1n << 2048n) + 1n;
  expect(
    reject(r([q(a, 3n), q(a + 1n, 3n), q(a + 2n, 3n)]), r([q(a - 1n, 3n), q(a, 3n), q(0)]), cmp),
  ).toBe(true);
});
it('18 signed exact ranges', () => {
  expect(testPair([-1, 0, 1], [-4, -3, -2])).toBe(true);
});
it('19 cancellation propagates during range preparation/check', () => {
  let calls = 0;
  expect(() =>
    range([{ z: q(0) }, { z: q(1) }, { z: q(2) }], (a, b) => {
      if (++calls === 2) throw Error('cancel');
      return cmp(a, b);
    }),
  ).toThrow('cancel');
  expect(() =>
    reject(r([q(1), q(2), q(3)]), r([q(0), q(0), q(0)]), () => {
      throw Error('cancel');
    }),
  ).toThrow('cancel');
});
it('20 source immutable', () => {
  const x = certificate();
  expect(x.positions).toEqual(x.before);
});
it('21 reject bypasses actual clipping', () => {
  const x = rangeFallbackCertificate();
  expect(x.result.rangeRejects).toBe(1);
  expect(x.result.clipEntries).toBe(0);
  expect(x.result.avoidedClipEntries).toBe(1);
});
it('22 pass through executes original clip', () => {
  const x = certificate(-0.125);
  expect(x.result.rangePassThrough).toBe(1);
  expect(x.result.clipEntries).toBe(1);
  expect(x.result.complete).toBe(false);
});
it('23 GCD cache operational on pass-through path', () => {
  const spy = vi.spyOn(InvocationExactGcdCache.prototype, 'get');
  try {
    certificate(-0.125);
    expect(spy.mock.results.some((r) => r.type === 'return' && typeof r.value === 'bigint')).toBe(
      true,
    );
  } finally {
    spy.mockRestore();
  }
});
it('24 cache ordered key semantics unchanged', () => {
  const c = new InvocationExactGcdCache((): void => {
    // Intentionally empty hook; preserve the undefined return value.
  }, 4);
  c.store(-42n, 30n, 6n, 3);
  expect(c.get(-42n, 30n)).toBe(6n);
  expect(c.get(42n, 30n)).toBeUndefined();
  expect(c.get(30n, -42n)).toBeUndefined();
});
it('25 immutable semantic inputs not changed', () => {
  const s = Object.freeze([
    Object.freeze({ z: Object.freeze(q(2)) }),
    Object.freeze({ z: Object.freeze(q(3)) }),
    Object.freeze({ z: Object.freeze(q(4)) }),
  ]);
  const before = s.map((p) => p.z);
  range(s, cmp);
  expect(s.map((p) => p.z)).toEqual(before);
});
it('26 deterministic repeated certificate', () => {
  expect(certificate().result).toEqual(certificate().result);
});
it('27 range preparation has no shared object lifetime', () => {
  const zs = [{ z: q(1) }, { z: q(2) }, { z: q(3) }];
  expect(range(zs, cmp)).not.toBe(range(zs, cmp));
});
it('28 document and camera range isolation', () => {
  const first = r([q(0), q(1), q(2)]),
    second = r([q(-2), q(-1), q(0)]);
  expect(first.maxDepth).toEqual(q(2));
  expect(second.maxDepth).toEqual(q(0));
  expect(certificate().positions).not.toBe(certificate().positions);
});
it('29 rejected-pair math is charged', () => {
  const x = rangeFallbackCertificate();
  expect(x.result.depthRangePreparationWork).toBe(8);
  expect(x.result.rangeCheckWork).toBe(1);
  expect(x.result.rangeChecks).toBe(1);
  expect(x.work).toBe(x.result.workUnits);
});
it('30 pass-through math is charged without hiding old work', () => {
  const x = certificate(-0.125);
  expect(x.result.depthRangePreparationWork).toBe(8);
  expect(x.result.rangeCheckWork).toBe(1);
  expect(x.result.rangeChecks).toBe(1);
  expect(x.result.rangePassThrough).toBe(1);
  expect(x.work).toBe(x.result.workUnits);
});

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
