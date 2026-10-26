import { describe, expect, it, vi } from 'vitest';
import {
  ExactOwnerPreprocessing as Owner,
  type ExactProjectedPoint as Point,
} from './semantic-exact-owner-preprocessing';
import {
  ExactVisibilityAcceleration as Visibility,
  type ExactProjectedTriangle as Triangle,
} from './semantic-exact-visibility-acceleration';
import { oldExactGeometry } from './semantic-exact-architecture-oracle.test-helper';
import { certifyWholeInterface } from './semantic-whole-interface-certificate';
const h = oldExactGeometry(),
  q = (n: number | bigint, d = 1n): { n: bigint; d: bigint } => ({ n: BigInt(n), d }),
  p = (x: number | bigint, y: number | bigint, z: number | bigint = 0, d = 1n): Point => ({
    x: q(x, d),
    y: q(y, d),
    z: q(z, d),
  });
const base = [p(-1, -1), p(1, -1), p(0, 1)],
  square = [p(-2, -2), p(2, -2), p(2, 2), p(-2, 2)];
const concave = [p(-2, -2), p(2, -2), p(2, 2), p(0, 0), p(-2, 2)];
const digest = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
const triangle = (vs: readonly Point[]): Triangle => {
  const xs = vs.map((v) => v.x).sort(h.cmp),
    ys = vs.map((v) => v.y).sort(h.cmp),
    zs = vs.map((v) => v.z).sort(h.cmp);
  return {
    vs,
    loX: requiredValue(xs[0]),
    hiX: requiredValue(xs[2]),
    loY: requiredValue(ys[0]),
    hiY: requiredValue(ys[2]),
    area: h.cross(requiredValue(vs[0]), requiredValue(vs[1]), requiredValue(vs[2])),
    depthRange: { minDepth: requiredValue(zs[0]), maxDepth: requiredValue(zs[2]) },
  };
};
const small = (x = 0, y = 0, z = 0): Triangle =>
  triangle([p(x, y, z), p(x + 1, y, z), p(x, y + 1, z)]);
function owner(poly: readonly Point[] = square): Owner {
  const o = new Owner(
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
  );
  o.build([poly]);
  return o;
}
function visibility(
  ts: readonly Triangle[] = [triangle(base)],
  faces = ts.map((_, i) => i),
): Visibility {
  const v = new Visibility(
    ts,
    faces,
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
  );
  v.build();
  return v;
}
function positiveArea(a: Triangle, b: Triangle): boolean {
  const ps = h.clip([...a.vs], [...b.vs]);
  let area = h.zero;
  for (let i = 1; i + 1 < ps.length; i++)
    area = h.add(
      area,
      h.cross(requiredValue(ps[0]), requiredValue(ps[i]), requiredValue(ps[i + 1])),
    );
  return area.n !== 0n;
}
function oldVisible(a: Triangle, b: Triangle): boolean {
  const ps = h.clip([...a.vs], [...b.vs]);
  return (
    !positiveArea(a, b) || !ps.some((x) => h.cmp(h.depth(x, [...b.vs]), h.depth(x, [...a.vs])) < 0)
  );
}
function leaves(v: Visibility): number[] {
  const walk = (n: unknown): number[] => {
    if (!n || typeof n !== 'object') return [];
    const ids: unknown = Reflect.get(n, 'ids');
    if (Array.isArray(ids)) return ids as number[];
    return [...walk(Reflect.get(n, 'left')), ...walk(Reflect.get(n, 'right'))];
  };
  return walk(Reflect.get(v, 'tree'));
}
describe('B exact owner preprocessing', () => {
  it('01 convex triangular owner', () => {
    const poly = [p(-3, -3), p(3, -3), p(0, 3)];
    expect(owner(poly).contains([p(0, 0), p(1, 0), p(0, 1)], poly)).toBe(true);
  });
  it('02 convex quadrilateral', () => {
    expect(owner().contains(base, square)).toBe(true);
  });
  it('03 larger convex octagon', () => {
    const poly = [p(-4, -2), p(-2, -4), p(2, -4), p(4, -2), p(4, 2), p(2, 4), p(-2, 4), p(-4, 2)];
    expect(owner(poly).contains(base, poly)).toBe(true);
  });
  it('04 clockwise', () => {
    const poly = [...square].reverse();
    expect(owner(poly).contains(base, poly)).toBe(true);
  });
  it('05 counterclockwise', () => {
    expect(owner().contains([...base].reverse(), square)).toBe(true);
  });
  it('06 edge closed', () => {
    expect(owner().contains([p(-2, -2), p(2, -2), p(0, 0)], square)).toBe(true);
  });
  it('07 vertex closed', () => {
    expect(owner().contains([p(-2, -2), p(-1, -2), p(-2, -1)], square)).toBe(true);
  });
  it('08 inside exact old parity', () => {
    const tri = [p(0, 0), p(1, 0), p(0, 1)];
    expect(owner().contains(tri, square)).toBe(h.contained(tri, [...square]));
  });
  it('09 outside requests fallback', () => {
    expect(owner().contains([p(3, 3), p(4, 3), p(3, 4)], square)).toBeUndefined();
  });
  it('10 concave requests fallback', () => {
    expect(owner(concave).contains(base, concave)).toBeUndefined();
  });
  it('11 collinear requests fallback', () => {
    const poly = [p(0, 0), p(1, 0), p(2, 0)];
    expect(owner(poly).contains(base, poly)).toBeUndefined();
  });
  it('12 less than3', () => {
    const poly = [p(0, 0), p(1, 0)];
    expect(owner(poly).snapshot().records).toBe(0);
  });
  it('13 greater than256', () => {
    expect(owner(Array.from({ length: 257 }, (_, i) => p(i, i))).snapshot().records).toBe(0);
  });
  it('14 nonpositive denominator', () => {
    const poly = [p(0, 0, 0, 0n), p(1, 0), p(0, 1)];
    expect(owner(poly).snapshot().records).toBe(0);
  });
  it('15 build work guard exact crossing', () => {
    const o = new Owner(
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    Reflect.set(o, 'buildWork', 2_000_000);
    o.build([square]);
    expect(o.snapshot().buildWork).toBe(2_000_001);
    expect(o.snapshot().records).toBe(0);
  });
  it('16 retained edge guard', () => {
    const o = new Owner(
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    Reflect.set(o, 'retainedEdges', 2048);
    o.build([square]);
    expect(o.snapshot().records).toBe(0);
  });
  it('17 retained memory guard', () => {
    const o = new Owner(
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    Reflect.set(o, 'retainedBytes', 4 * 1024 * 1024);
    o.build([square]);
    expect(o.snapshot().records).toBe(0);
  });
  it('18 previous records survive later limit', () => {
    const o = owner();
    Reflect.set(o, 'retainedEdges', 2048);
    o.build([[p(0, 0), p(1, 0), p(0, 1)]]);
    expect(o.contains(base, square)).toBe(true);
  });
  it('19 cancellation build propagates', () => {
    let work = 0;
    const o = new Owner(
      () => {
        if (++work === 10) throw Error('cancel');
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    expect(() => {
      o.build([square]);
    }).toThrow('cancel');
    o.dispose();
    expect(o.snapshot().records).toBe(0);
  });
  it('20 cancellation query propagates', () => {
    let cancel = false;
    const o = new Owner(
      () => {
        if (cancel) throw Error('cancel');
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    o.build([square]);
    cancel = true;
    expect(() => o.contains(base, square)).toThrow('cancel');
    o.dispose();
  });
  it('21 source preservation', () => {
    const before = digest([base, square]);
    owner().contains(base, square);
    expect(digest([base, square])).toBe(before);
  });
  it('22 boundary old contained parity', () => {
    const tri = [p(-2, -2), p(2, -2), p(0, 2)];
    expect(h.contained(tri, [...square])).toBe(true);
    expect(owner().contains(tri, square)).toBe(true);
  });
  it('23 disposal clears ownership references', () => {
    const o = owner();
    o.dispose();
    expect(o.snapshot()).toMatchObject({
      records: 0,
      retainedEdges: 0,
      retainedBytes: 0,
      scratchBytes: 0,
      disposed: true,
    });
    expect(o.contains(base, square)).toBeUndefined();
  });
  it('24 identity and work deterministic', () => {
    const a = owner(),
      b = owner();
    a.contains(base, square);
    b.contains(base, square);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.contains(base, [...square])).toBeUndefined();
  });
});
describe('E exact spatial BVH', () => {
  it('01 exact interface union', () => {
    const ts = [small(-5), small(5)];
    expect(leaves(visibility(ts))).toEqual([0, 1]);
  });
  it('02 outside union excluded safely', () => {
    const ts = [small(), small(10)];
    const v = visibility(ts, [0]);
    expect(leaves(v)).toEqual([0]);
    expect(positiveArea(requiredValue(ts[0]), requiredValue(ts[1]))).toBe(false);
  });
  it('03 touch only source', () => {
    const ts = [small(), small(1)];
    expect(leaves(visibility(ts, [0]))).toEqual([0]);
  });
  it('04 stable x order', () => {
    const ts = Array.from({ length: 20 }, (_, i) => small((19 - i) * 4));
    expect(leaves(visibility(ts))).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i));
  });
  it('05 stable y order', () => {
    const ts = Array.from({ length: 20 }, (_, i) => small(0, (19 - i) * 4));
    expect(leaves(visibility(ts))).toEqual([
      15, 16, 17, 18, 19, 10, 11, 12, 13, 14, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4,
    ]);
  });
  it('06 source ID tie', () => {
    expect(leaves(visibility(Array.from({ length: 20 }, () => small())))).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });
  it('07 identical centers deterministic', () => {
    const ts = Array.from({ length: 17 }, () => small());
    expect(digest(Reflect.get(visibility(ts), 'tree'))).toBe(
      digest(Reflect.get(visibility(ts), 'tree')),
    );
  });
  it('08 wider x span', () => {
    const ts = Array.from({ length: 20 }, (_, i) => small(i * 4, 19 - i));
    expect(leaves(visibility(ts))).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
  it('09 wider y span', () => {
    const ts = Array.from({ length: 20 }, (_, i) => small(i, (19 - i) * 4));
    expect(leaves(visibility(ts))).toEqual([
      15, 16, 17, 18, 19, 10, 11, 12, 13, 14, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4,
    ]);
  });
  it('10 exact axis tie selects x', () => {
    const ts = Array.from({ length: 20 }, (_, i) => small(i, 19 - i));
    expect(leaves(visibility(ts))).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
  it('11 balanced recursion source count', () => {
    const v = visibility(Array.from({ length: 65 }, (_, i) => small(i)));
    expect(v.snapshot().nodes).toBe(17);
    expect(leaves(v)).toHaveLength(65);
  });
  it('12 leaf8', () => {
    expect(visibility(Array.from({ length: 8 }, () => small())).snapshot().nodes).toBe(1);
  });
  it('13 entry limit fallback', () => {
    const t = small();
    const v = visibility(
      Array.from({ length: 65537 }, () => t),
      [0],
    );
    expect(v.needsGrid()).toBe(true);
    expect(v.snapshot().entries).toBe(0);
  });
  it('14 node guard fallback', () => {
    const v = new Visibility(
      [small()],
      [0],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    Reflect.set(v, 'nodes', 65535);
    v.build();
    expect(v.needsGrid()).toBe(true);
  });
  it('15 build work guard exact crossing', () => {
    const v = new Visibility(
      [small()],
      [0],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    Reflect.set(v, 'buildWork', 16_000_000);
    v.build();
    expect(v.snapshot().buildWork).toBe(16_000_001);
    expect(v.needsGrid()).toBe(true);
  });
  it('16 memory guard fallback', () => {
    const v = new Visibility(
      [small()],
      [0],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    Reflect.set(v, 'indexBytes', 32 * 1024 * 1024);
    v.build();
    expect(v.needsGrid()).toBe(true);
  });
  it('17 every source once', () => {
    const v = visibility(Array.from({ length: 33 }, (_, i) => small(i)));
    expect(new Set(leaves(v)).size).toBe(33);
    expect(leaves(v)).toHaveLength(33);
  });
  it('18 self excluded exactly', () => {
    const ts = [small(0, 0), small(0, 0, -1)];
    expect([...visibility(ts).candidates(requiredValue(ts[0]), 0, () => new Set())]).toEqual([1]);
  });
  it('19 XY rejection', () => {
    expect([...visibility().candidates(small(10), -1, () => new Set([0]))]).toEqual([]);
  });
  it('20 depth rejection', () => {
    const ts = [small(), small(0, 0, 1)];
    expect([...visibility(ts).candidates(requiredValue(ts[0]), 0, () => new Set([1]))]).toEqual([]);
  });
  it('21 unresolved descends', () => {
    const ts = Array.from({ length: 20 }, () => small(0, 0, -1));
    expect(visibility(ts).candidates(small(), -1, () => new Set()).size).toBe(20);
  });
  it('22 leaf fallback candidates', () => {
    const ts = [small(0, 0, -1)];
    expect([...visibility(ts).candidates(small(), -1, () => new Set())]).toEqual([0]);
  });
  it('23 partition boundary retained', () => {
    const ts = Array.from({ length: 9 }, (_, i) => small(i - 4, 0, -1));
    const v = visibility(ts);
    expect(leaves(v).includes(4)).toBe(true);
  });
  it('24 negative coordinates', () => {
    expect(leaves(visibility([small(-50, -50)]))).toEqual([0]);
  });
  it('25 large Float32 exact values', () => {
    const n = 1n << 120n;
    const t = triangle([p(-n, -n), p(n, -n), p(0, n)]);
    expect(visibility([t]).needsGrid()).toBe(false);
  });
  it('26 unsupported conversion fallback', () => {
    const t = triangle([p(0, 0, 0, 3n), p(1, 0, 0, 3n), p(0, 1, 0, 3n)]);
    expect(visibility([t]).needsGrid()).toBe(true);
  });
  it('27 cancellation build', () => {
    let n = 0;
    const v = new Visibility(
      [small()],
      [0],
      () => {
        if (++n === 5) throw Error('cancel');
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    expect(() => {
      v.build();
    }).toThrow('cancel');
    v.dispose();
    expect(v.snapshot().sourceReferences).toBe(0);
  });
  it('28 cancellation traversal', () => {
    let cancel = false;
    const t = small(0, 0, -1),
      v = new Visibility(
        [t],
        [0],
        () => {
          if (cancel) throw Error('cancel');
        },
        (): void => {
          // Intentionally empty hook; preserve the undefined return value.
        },
      );
    v.build();
    cancel = true;
    expect(() => v.candidates(small(), -1, () => new Set())).toThrow('cancel');
    v.dispose();
  });
  it('29 source preserved', () => {
    const ts = [small(), small(0, 0, -1)],
      before = digest(ts);
    visibility(ts).candidates(requiredValue(ts[0]), 0, () => new Set());
    expect(digest(ts)).toBe(before);
  });
  it('30 disposal and repeated tree', () => {
    const ts = [small(), small(0, 0, -1)],
      a = visibility(ts),
      b = visibility(ts);
    expect(digest(Reflect.get(a, 'tree'))).toBe(digest(Reflect.get(b, 'tree')));
    a.dispose();
    expect(a.snapshot()).toMatchObject({
      nodes: 0,
      entries: 0,
      indexBytes: 0,
      pointRecords: 0,
      sourceReferences: 0,
      interfaceReferences: 0,
      disposed: true,
    });
  });
});
describe('I exact separating edge', () => {
  const a = triangle(base),
    disjoint = triangle([p(-3, -3, -1), p(-3, 0, -1), p(0, -3, -1)]);
  it('01 interface edge separation', () => {
    expect(visibility().separated(a, small(3, 3))).toBe(true);
  });
  it('02 source edge separation', () => {
    expect(visibility().separated(a, disjoint)).toBe(true);
    expect(positiveArea(a, disjoint)).toBe(false);
  });
  it('03 point touch', () => {
    expect(visibility().separated(a, triangle([p(1, -1), p(3, -1), p(2, 1)]))).toBe(true);
  });
  it('04 edge touch', () => {
    expect(visibility().separated(a, triangle([p(-1, -1), p(1, -1), p(0, -2)]))).toBe(true);
  });
  it('05 positive area overlap', () => {
    expect(visibility().separated(a, small())).toBe(false);
  });
  it('06 identical triangles', () => {
    expect(visibility().separated(a, a)).toBe(false);
  });
  it('07 triangle containment', () => {
    expect(visibility().separated(triangle([p(-4, -4), p(4, -4), p(0, 4)]), a)).toBe(false);
  });
  it('08 crossing triangles', () => {
    expect(visibility().separated(a, triangle([p(-1, 1), p(1, 1), p(0, -1)]))).toBe(false);
  });
  it('09 reversed winding', () => {
    expect(visibility().separated(triangle([...base].reverse()), disjoint)).toBe(true);
  });
  it('10 degenerate source fallback', () => {
    expect(visibility().separated(a, triangle([p(0, 0), p(1, 0), p(2, 0)]))).toBe(false);
  });
  it('11 degenerate interface fallback', () => {
    expect(visibility().separated(triangle([p(0, 0), p(1, 0), p(2, 0)]), a)).toBe(false);
  });
  it('12 large exact Float32 values', () => {
    const n = 1n << 120n;
    expect(
      visibility().separated(
        triangle([p(-n, -n), p(n, -n), p(0, n)]),
        triangle([p(2n * n, 2n * n), p(3n * n, 2n * n), p(2n * n, 3n * n)]),
      ),
    ).toBe(true);
  });
  it('13 negative coordinates', () => {
    expect(visibility().separated(small(-10, -10), small(-20, -20))).toBe(true);
  });
  it('14 exact divisibility', () => {
    expect(
      visibility().separated(
        triangle([p(0, 0, 0, 8n), p(1, 0, 0, 8n), p(0, 1, 0, 8n)]),
        small(3, 3),
      ),
    ).toBe(true);
  });
  it('15 unsupported conversion fallback', () => {
    expect(
      visibility().separated(
        triangle([p(0, 0, 0, 3n), p(1, 0, 0, 3n), p(0, 1, 0, 3n)]),
        small(3, 3),
      ),
    ).toBe(false);
  });
  it('16 cache hit avoids conversion', () => {
    const v = visibility();
    v.separated(a, disjoint);
    const n = v.snapshot().pointConversions;
    v.separated(a, disjoint);
    expect(v.snapshot().pointConversions).toBe(n);
  });
  it('17 overflow exact uncached', () => {
    const v = visibility();
    for (let i = 0; i < 700; i++)
      v.separated(triangle([...base.map((x) => ({ ...x }))]), small(3, 3));
    expect(v.snapshot().pointRecords).toBe(4096);
    const n = v.snapshot().pointConversions;
    expect(v.separated(a, disjoint)).toBe(true);
    expect(v.snapshot().pointConversions).toBeGreaterThan(n);
  });
  it('18 capacity4096 boundary', () => {
    const v = visibility();
    for (let i = 0; i < 683; i++) v.separated(triangle(base.map((x) => ({ ...x }))), small(3, 3));
    expect(v.snapshot().pointRecords).toBe(4096);
    expect(v.snapshot().pointBytes).toBe(4096 * 448);
  });
  it('19 no separation invokes old clip', () => {
    const v = visibility(),
      clip = vi.fn(() => h.clip([...a.vs], [...a.vs]));
    if (!v.separated(a, a)) clip();
    expect(clip).toHaveBeenCalledOnce();
  });
  it('20 separating proof skips old clip', () => {
    const clip = vi.fn();
    if (!visibility().separated(a, disjoint)) clip();
    expect(clip).not.toHaveBeenCalled();
  });
  it('21 cancellation propagates', () => {
    let cancel = false;
    const v = new Visibility(
      [a],
      [0],
      () => {
        if (cancel) throw Error('cancel');
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    v.build();
    cancel = true;
    expect(() => v.separated(a, disjoint)).toThrow('cancel');
    v.dispose();
  });
  it('22 source preservation', () => {
    const before = digest([a, disjoint]);
    visibility().separated(a, disjoint);
    expect(digest([a, disjoint])).toBe(before);
  });
  it('23 all positive facts imply old zero-area', () => {
    for (let i = -4; i <= 4; i++) {
      const b = small(i, 3 - i);
      if (visibility().separated(a, b)) expect(positiveArea(a, b)).toBe(false);
    }
  });
  it('24 cache released per view', () => {
    const v = visibility();
    v.separated(a, disjoint);
    expect(v.snapshot().pointRecords).toBeGreaterThan(0);
    v.dispose();
    expect(v.snapshot().pointRecords).toBe(0);
    expect(visibility().snapshot().pointRecords).toBe(0);
  });
});
function integrated(
  b: boolean,
  e: boolean,
  i: boolean,
): { whole: boolean; expected: boolean; o: Owner; v: Visibility } {
  const ts = [
      triangle(base),
      i
        ? triangle([p(-3, -3, -1), p(-3, 0, -1), p(0, -3, -1)])
        : triangle(base.map((x) => ({ ...x, z: q(-1) }))),
    ],
    o = new Owner(
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
    v = new Visibility(
      ts,
      [0],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
  if (!b) Reflect.set(o, 'buildWork', 2_000_000);
  if (!e) Reflect.set(v, 'buildWork', 16_000_000);
  try {
    o.build([square]);
    v.build();
    const owned = o.contains(base, square) === true || h.contained([...base], [...square]);
    const ids = v.candidates(requiredValue(ts[0]), 0, () => new Set([1]));
    let visible = true;
    for (const f of ids)
      if (
        !v.separated(requiredValue(ts[0]), requiredValue(ts[f])) &&
        !oldVisible(requiredValue(ts[0]), requiredValue(ts[f]))
      )
        visible = false;
    return {
      whole: owned && visible,
      expected:
        h.contained([...base], [...square]) &&
        oldVisible(requiredValue(ts[0]), requiredValue(ts[1])),
      o,
      v,
    };
  } finally {
    o.dispose();
    v.dispose();
  }
}
describe('integration and resource ownership', () => {
  for (const b of [false, true])
    for (const e of [false, true])
      for (const i of [false, true])
        it(`matrix B=${String(b)} E=${String(e)} I=${String(i)}`, () => {
          const x = integrated(b, e, i);
          expect(x.whole).toBe(x.expected);
          expect(x.o.snapshot().records).toBe(0);
          expect(x.v.snapshot().sourceReferences).toBe(0);
        });
  it('09 shared work exception not converted to fallback', () => {
    const v = new Visibility(
      [small()],
      [0],
      () => {
        throw Error('shared-work');
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    expect(() => {
      v.build();
    }).toThrow('shared-work');
    v.dispose();
  });
  it('10 checkpoint cancellation not swallowed', () => {
    const o = new Owner(
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      () => {
        throw Error('cancel');
      },
    );
    expect(() => {
      o.build([square]);
    }).toThrow('cancel');
    o.dispose();
  });
  it('11 B guard after prior valid polygon', () => {
    const o = owner();
    Reflect.set(o, 'retainedBytes', 4 * 1024 * 1024);
    o.build([[p(0, 0), p(1, 0), p(0, 1)]]);
    expect(o.contains(base, square)).toBe(true);
    o.dispose();
  });
  it('12 I memory guard requests exact old fallback', () => {
    const v = visibility();
    Reflect.set(v, 'pointBytes', 4 * 1024 * 1024);
    expect(v.separated(triangle(base), small(3, 3))).toBe(false);
    v.dispose();
  });
  it('13 distinct source ID domains isolated', () => {
    const a = visibility([small(0, 0, -1)]),
      b = visibility([small(10, 10, -1)]);
    expect(a.candidates(small(), -1, () => new Set()).size).toBe(1);
    expect(b.candidates(small(), -1, () => new Set()).size).toBe(0);
    a.dispose();
    b.dispose();
  });
  it('14 repeated requests release maps and trees', () => {
    for (let i = 0; i < 20; i++) {
      const x = integrated(true, true, true);
      expect(
        x.o.snapshot().records +
          x.v.snapshot().nodes +
          x.v.snapshot().pointRecords +
          x.v.snapshot().sourceReferences,
      ).toBe(0);
    }
  });
  it('15 geometry immutable across all fallback combinations', () => {
    const before = digest([base, square]);
    for (const b of [false, true])
      for (const e of [false, true]) for (const i of [false, true]) integrated(b, e, i);
    expect(digest([base, square])).toBe(before);
  });
  it('16 deterministic complete composition', () => {
    expect(integrated(true, true, true).whole).toBe(integrated(true, true, true).whole);
  });
  it('17 cache does not bleed between views', () => {
    const a = visibility();
    a.separated(triangle(base), small(3, 3));
    a.dispose();
    const b = visibility();
    expect(b.snapshot().pointRecords).toBe(0);
    b.dispose();
  });
  it('18 failed source conversion never claims a tree', () => {
    const t = triangle([p(0, 0, 0, 3n), p(1, 0, 0, 3n), p(0, 1, 0, 3n)]),
      v = visibility([t]);
    const old = vi.fn(() => new Set([7]));
    expect([...v.candidates(t, 0, old)]).toEqual([7]);
    expect(old).toHaveBeenCalledOnce();
    v.dispose();
  });
  it('19 real certificate source preservation and whole proof', () => {
    const positions = new Float32Array([
        -0.234, 0, -0.218, 0.239, 0.113, -0.211, 0.013, 0.237, 0.247,
      ]),
      indices = new Uint32Array([0, 1, 2]),
      before = digest([Array.from(positions), Array.from(indices)]);
    const r = certifyWholeInterface(
      {
        geometry: { positions, indices, faceCount: 1, radius: 1 },
        rasters: [],
      } as never,
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
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
    expect(r.complete).toBe(true);
    expect(digest([Array.from(positions), Array.from(indices)])).toBe(before);
  });
  it('20 real certificate shared work abort', () => {
    const positions = new Float32Array([
      -0.234, 0, -0.218, 0.239, 0.113, -0.211, 0.013, 0.237, 0.247,
    ]);
    let work = 0;
    expect(() =>
      certifyWholeInterface(
        {
          geometry: {
            positions,
            indices: new Uint32Array([0, 1, 2]),
            faceCount: 1,
            radius: 1,
          },
          rasters: [],
        } as never,
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
        (): void => {
          // Intentionally empty hook; preserve the undefined return value.
        },
        () => {
          if (++work === 50) throw Error('shared-work');
        },
      ),
    ).toThrow('shared-work');
  });
});

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
