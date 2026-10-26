import { expect, it } from 'vitest';
import { InvocationExactGcdCache } from './semantic-exact-gcd-cache';
const noop = (): void => {
  // Intentionally empty hook; preserve the undefined return value.
};
const old = (a: bigint, b: bigint, tick = noop): bigint => {
  a = a < 0n ? -a : a;
  while (b) {
    tick();
    [a, b] = [b, a % b];
  }
  return a;
};
function instance(
  checkpoint = noop,
  tick = noop,
  capacity = 4,
): { gcd: (a: bigint, b: bigint) => bigint; cache: InvocationExactGcdCache; work: () => number } {
  const cache = new InvocationExactGcdCache(checkpoint, capacity);
  let work = 0;
  const gcd = (a: bigint, b: bigint): bigint => {
    const hit = cache.get(a, b);
    if (hit !== undefined) return hit;
    const start = work;
    const value = old(a, b, () => {
      tick();
      work++;
    });
    cache.store(a, b, value, work - start);
    return value;
  };
  return { gcd, cache, work: (): number => work };
}
it('01 zero/zero matches old', () => {
  expect(instance().gcd(0n, 0n)).toBe(old(0n, 0n));
});
it('02 zero/nonzero', () => {
  expect(instance().gcd(0n, 24n)).toBe(24n);
});
it('03 nonzero/zero', () => {
  expect(instance().gcd(-24n, 0n)).toBe(24n);
});
it('04 equal operands', () => {
  expect(instance().gcd(27n, 27n)).toBe(27n);
});
it('05 relatively prime', () => {
  expect(instance().gcd(31n, 17n)).toBe(1n);
});
it('06 common factor', () => {
  expect(instance().gcd(42n, 30n)).toBe(6n);
});
it('07 large oversized operands recompute exactly', () => {
  const x = instance(),
    a = (1n << 4096n) + 1n;
  expect(x.gcd(a, 3n)).toBe(old(a, 3n));
  expect(x.cache.snapshot().peakEntries).toBe(0);
  expect(x.cache.snapshot().oversizedMisses).toBe(1);
});
it('08 all observed bit buckets', () => {
  const x = instance();
  for (const bits of [1, 32, 33, 64, 65, 128, 129, 256, 257, 498, 512]) {
    const a = (1n << BigInt(bits)) - 1n;
    expect(x.gcd(a, (a >> 1n) | 1n)).toBe(old(a, (a >> 1n) | 1n));
  }
});
it('09 ordered exact input hits', () => {
  const x = instance();
  x.gcd(-42n, 30n);
  x.gcd(-42n, 30n);
  expect(x.cache.snapshot().cacheHits).toBe(1);
});
it('10 exact repeat even zero result hits', () => {
  const x = instance();
  x.gcd(0n, 0n);
  expect(x.gcd(0n, 0n)).toBe(0n);
  expect(x.cache.snapshot().cacheHits).toBe(1);
});
it('11 one-bit-different operand misses', () => {
  const x = instance();
  x.gcd(42n, 30n);
  x.gcd(43n, 30n);
  expect(x.cache.snapshot().cacheMisses).toBe(2);
});
it('12 reversed pair and different signs do not alias', () => {
  const x = instance();
  x.gcd(42n, 30n);
  x.gcd(30n, 42n);
  x.gcd(-42n, 30n);
  expect(x.cache.snapshot().cacheMisses).toBe(3);
});
it('13 unequal keys sharing the sole hash set cannot false-hit', () => {
  const x = instance();
  expect(x.gcd(42n, 30n)).toBe(6n);
  expect(x.gcd(35n, 14n)).toBe(7n);
  expect(x.cache.snapshot().cacheHits).toBe(0);
});
it('14 deterministic FIFO eviction', () => {
  const x = instance();
  for (let a = 1n; a <= 5n; a++) x.gcd(a, 17n);
  expect(x.cache.get(1n, 17n)).toBeUndefined();
  expect(x.cache.get(2n, 17n)).toBe(1n);
});
it('15 full cache recomputes safely', () => {
  const x = instance();
  for (let a = 1n; a <= 20n; a++) expect(x.gcd(a, 17n)).toBe(old(a, 17n));
  expect(x.cache.snapshot().peakEntries).toBe(4);
  expect(x.cache.snapshot().evictions).toBe(16);
});
it('16 evicted key is exact miss', () => {
  const x = instance();
  for (let a = 1n; a <= 5n; a++) x.gcd(a, 17n);
  const before = x.cache.snapshot().cacheMisses;
  expect(x.gcd(1n, 17n)).toBe(1n);
  expect(x.cache.snapshot().cacheMisses).toBe(before + 1);
});
it('17 interrupted result never cached', () => {
  let fail = true;
  const x = instance(noop, () => {
    if (fail) throw Error('interrupt');
  });
  expect(() => x.gcd(42n, 30n)).toThrow('interrupt');
  expect(x.cache.snapshot().peakEntries).toBe(0);
  fail = false;
  expect(x.gcd(42n, 30n)).toBe(6n);
  expect(x.cache.snapshot().cacheHits).toBe(0);
});
it('18 cancellation before miss', () => {
  const x = instance(() => {
    throw Error('cancel');
  });
  expect(() => x.gcd(42n, 30n)).toThrow('cancel');
  expect(x.work()).toBe(0);
  expect(x.cache.snapshot().peakEntries).toBe(0);
});
it('19 cancellation during miss', () => {
  let visits = 0;
  const x = instance(noop, () => {
    if (++visits === 2) throw Error('cancel');
  });
  expect(() => x.gcd(42n, 30n)).toThrow('cancel');
  expect(x.work()).toBe(1);
  expect(x.cache.snapshot().peakEntries).toBe(0);
});
it('20 hit-heavy execution checkpoints without iteration replay', () => {
  let cancel = false;
  const x = instance(() => {
    if (cancel) throw Error('cancel');
  });
  x.gcd(42n, 30n);
  const work = x.work();
  for (let i = 0; i < 255; i++) x.gcd(42n, 30n);
  cancel = true;
  expect(() => x.gcd(42n, 30n)).toThrow('cancel');
  expect(x.work()).toBe(work);
});
it('21 separate invocation starts empty', () => {
  const a = instance(),
    b = instance();
  a.gcd(42n, 30n);
  expect(b.cache.snapshot().peakEntries).toBe(0);
  b.gcd(42n, 30n);
  expect(b.cache.snapshot().cacheHits).toBe(0);
});
it('22 reentrant invocations isolated', () => {
  const inner = instance();
  const outer = instance(() => {
    inner.gcd(35n, 14n);
  });
  expect(outer.gcd(42n, 30n)).toBe(6n);
  expect(inner.cache.snapshot().peakEntries).toBe(1);
  expect(outer.cache.snapshot().peakEntries).toBe(1);
});
it('23 source data is not mutated or retained in primitive keys', () => {
  const source = new Uint32Array([42, 30]),
    before = source.slice(),
    x = instance();
  x.gcd(BigInt(requiredValue(source[0])), BigInt(requiredValue(source[1])));
  expect(source).toEqual(before);
  const keys = (x.cache as unknown as { keys: string[] }).keys.filter(Boolean);
  expect(keys.every((k) => typeof k === 'string')).toBe(true);
});
it('24 exact old result for every sign combination', () => {
  const x = instance();
  for (const a of [-42n, 0n, 42n])
    for (const b of [-30n, 0n, 30n]) expect(x.gcd(a, b)).toBe(old(a, b));
});
it('25 eviction history cannot change result', () => {
  const x = instance();
  for (let i = 0n; i < 40n; i++) {
    x.gcd(i, 19n);
    expect(x.gcd(42n, 30n)).toBe(6n);
  }
});
it('26 miss work count and order equal old primitive', () => {
  const a: number[] = [],
    b: number[] = [];
  let n = 0;
  old(42n, 30n, () => a.push(n++));
  n = 0;
  const x = instance(noop, () => b.push(n++));
  x.gcd(42n, 30n);
  expect(b).toEqual(a);
  expect(x.work()).toBe(a.length);
});
it('27 only a real hit avoids iterations', () => {
  const x = instance();
  x.gcd(42n, 30n);
  const work = x.work();
  x.gcd(42n, 30n);
  expect(x.work()).toBe(work);
  expect(x.cache.snapshot().avoidedHistoricalIterations).toBe(work);
  x.gcd(43n, 30n);
  expect(x.work()).toBeGreaterThan(work);
});
it('28 non-GCD surrounding charges stay unchanged', () => {
  const run = (cached: boolean): number => {
    let other = 0;
    const x = instance();
    for (let i = 0; i < 8; i++) {
      other++;
      (cached ? x.gcd : old)(42n, 30n);
      other++;
    }
    return other;
  };
  expect(run(true)).toBe(run(false));
});
it('29 capacity cannot grow and rejects unsupported sizes', () => {
  const x = instance();
  for (let i = 0n; i < 100n; i++) x.gcd(i, 17n);
  expect(x.cache.snapshot().fixedReferenceArraySlots).toBe(8);
  expect(x.cache.snapshot().peakEntries).toBe(4);
  expect(() => new InvocationExactGcdCache(noop, 65536)).toThrow();
});
it('30 deterministic repeated run', () => {
  const run = (): {
    capacity: number;
    ways: number;
    maxRetainedOperandBits: number;
    calls: number;
    cacheHits: number;
    cacheMisses: number;
    actualGcdExecutions: number;
    completedGcdIterations: number;
    avoidedHistoricalIterations: number;
    evictions: number;
    collisionMisses: number;
    oversizedMisses: number;
    peakEntries: number;
    estimatedPeakBytes: number;
    estimatedMaximumBytes: number;
    fixedReferenceArraySlots: number;
    fixedTypedArrayBytes: number;
  } => {
    const x = instance();
    for (let i = 0n; i < 40n; i++) x.gcd(i % 7n, 17n);
    return x.cache.snapshot();
  };
  expect(run()).toEqual(run());
});

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
