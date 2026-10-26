import type { ExactTriangleDepthRange } from './semantic-exact-depth-range';
import type { WholeInterfaceCertificate } from './semantic-whole-interface-certificate';
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  exactOwnerOrientationSign as sign,
  type OwnerOrientationPoint as P,
  type OwnerOrientationSign as S,
} from './semantic-owner-orientation-sign';
import { InvocationExactGcdCache } from './semantic-exact-gcd-cache';
import { certifyWholeInterface } from './semantic-whole-interface-certificate';
import { exactRangeNonCloser, exactTriangleDepthRange } from './semantic-exact-depth-range';
const q = (n: bigint | number, d = 1n): { n: bigint; d: bigint } => ({ n: BigInt(n), d });
const p = (x: bigint | number, y: bigint | number, dx = 1n, dy = 1n): P => ({
  x: q(x, dx),
  y: q(y, dy),
});
const A = p(0, 0),
  B = p(2, 0),
  C = p(0, 2);
const cmp = (a: ReturnType<typeof q>, b: ReturnType<typeof q>): 0 | 1 | -1 => {
  const n = a.n * b.d - b.n * a.d;
  return n < 0n ? -1 : n > 0n ? 1 : 0;
};
function oldCross(
  a: P,
  b: P,
  c: P,
  charge = (): void => {
    // Intentionally empty hook; preserve the undefined return value.
  },
  gcdCall = (): void => {
    // Intentionally empty hook; preserve the undefined return value.
  },
): { n: bigint; d: bigint } {
  const norm = (n: bigint, d: bigint): { n: bigint; d: bigint } => {
    charge();
    if (!d) throw Error('Uncertified zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    if (!n) return q(0);
    let g: bigint;
    if ((d & (d - 1n)) === 0n) g = (n & -n) < d ? n & -n : d;
    else {
      gcdCall();
      let x = n < 0n ? -n : n,
        y = d;
      while (y) {
        charge();
        [x, y] = [y, x % y];
      }
      g = x;
    }
    return q(n / g, d / g);
  };
  const sub = (a: ReturnType<typeof q>, b: ReturnType<typeof q>): { n: bigint; d: bigint } =>
      norm(a.n * b.d - b.n * a.d, a.d * b.d),
    mul = (a: ReturnType<typeof q>, b: ReturnType<typeof q>): { n: bigint; d: bigint } =>
      norm(a.n * b.n, a.d * b.d);
  return sub(mul(sub(b.x, a.x), sub(c.y, a.y)), mul(sub(b.y, a.y), sub(c.x, a.x)));
}
const oldSign = (a: P, b: P, c: P): S => {
  const n = oldCross(a, b, c).n;
  return n < 0n ? -1 : n > 0n ? 1 : 0;
};
const run = (a = A, b = B, c = C): { result: S; work: number; fallback: number } => {
  let work = 0,
    fallback = 0;
  const result = sign(
    a,
    b,
    c,
    () => work++,
    () => {
      fallback++;
      return oldSign(a, b, c);
    },
  );
  return { result, work, fallback };
};
function inside(point: P, poly: P[], fast: boolean): boolean {
  const orient = (a: P, b: P, c: P): S => (fast ? run(a, b, c).result : oldSign(a, b, c));
  let yes = false;
  for (let i = 0; i < poly.length; i++) {
    const a = requiredValue(poly[i]),
      b = requiredValue(poly[(i + 1) % poly.length]);
    if (
      orient(a, b, point) === 0 &&
      cmp(point.x, a.x) * cmp(point.x, b.x) <= 0 &&
      cmp(point.y, a.y) * cmp(point.y, b.y) <= 0
    )
      return true;
    if (cmp(a.y, point.y) > 0 !== cmp(b.y, point.y) > 0 && orient(a, b, point) === cmp(b.y, a.y))
      yes = !yes;
  }
  return yes;
}
const square = [p(0, 0), p(4, 0), p(4, 4), p(0, 4)],
  concave = [p(0, 0), p(4, 0), p(4, 4), p(2, 2), p(0, 4)];
const polygonCase = (poly: P[], point: P, want: boolean): void => {
  expect(inside(point, poly, false)).toBe(want);
  expect(inside(point, poly, true)).toBe(want);
};
function certificate(): { result: WholeInterfaceCertificate; work: number } {
  let work = 0;
  const positions = new Float32Array([
      -0.234, 0, -0.218, 0.239, 0.113, -0.211, 0.013, 0.237, 0.247,
    ]),
    indices = new Uint32Array([0, 1, 2]);
  const result = certifyWholeInterface(
    { geometry: { positions, indices, faceCount: 1, radius: 1 }, rasters: [] } as never,
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
    () => work++,
  );
  return { result, work };
}
it('01 positive orientation', () => {
  expect(run().result).toBe(1);
});
it('02 negative orientation', () => {
  expect(run(A, C, B).result).toBe(-1);
});
it('03 exact zero orientation', () => {
  expect(run(A, B, p(1, 0)).result).toBe(0);
});
it('04 unit denominators', () => {
  expect(run().fallback).toBe(0);
});
it('05 unequal positive denominators', () => {
  expect(run(p(1, 2, 3n, 5n), p(7, 3, 11n, 13n), p(2, 9, 17n, 19n)).result).toBe(
    oldSign(p(1, 2, 3n, 5n), p(7, 3, 11n, 13n), p(2, 9, 17n, 19n)),
  );
});
it('06 negative numerators', () => {
  expect(run(p(-4, -3), p(-2, -3), p(-4, -1)).result).toBe(1);
});
it('07 mixed coordinate signs', () => {
  expect(run(p(-2, 1), p(2, -1), p(0, 3)).result).toBe(oldSign(p(-2, 1), p(2, -1), p(0, 3)));
});
it('08 very large integers', () => {
  const n = 1n << 2048n;
  expect(run(p(n, n), p(n + 1n, n), p(n, n + 1n)).result).toBe(1);
});
it('09 observed magnitude region', () => {
  const n = 1n << 372n;
  expect(run(p(-n, n), p(n, n), p(0, -n)).result).toBe(-1);
});
it('10 beyond observed magnitude', () => {
  const n = 1n << 4096n;
  expect(run(p(0, 0), p(n, 0), p(0, n)).result).toBe(1);
});
it('11 reverse order flips sign', () => {
  expect(run(A, B, C).result).toBe(-run(A, C, B).result);
});
it('12 duplicate points zero', () => {
  expect(run(A, A, C).result).toBe(0);
});
it('13 distinct collinear points zero', () => {
  expect(run(p(-7, -7), p(2, 2), p(11, 11)).result).toBe(0);
});
it('14 polygon edge exact', () => {
  polygonCase(square, p(2, 0), true);
});
it('15 polygon vertex exact', () => {
  polygonCase(square, p(0, 0), true);
});
it('16 convex interior', () => {
  polygonCase(square, p(2, 2), true);
});
it('17 convex outside', () => {
  polygonCase(square, p(5, 2), false);
});
it('18 concave interior', () => {
  polygonCase(concave, p(1, 2), true);
});
it('19 concave outside', () => {
  polygonCase(concave, p(2, 3), false);
});
it('20 concave boundary', () => {
  polygonCase(concave, p(3, 3), true);
});
it('21 winding reversal', () => {
  for (const pt of [p(2, 1), p(2, 3), p(3, 3)])
    expect(inside(pt, [...concave].reverse(), true)).toBe(inside(pt, concave, false));
});
it('22 old full cross agrees exactly', () => {
  for (let i = -8; i <= 8; i++) {
    const a = p(i, 2, 7n, 3n),
      b = p(5, i, 11n, 13n),
      c = p(-3, 7, 17n, 19n);
    expect(run(a, b, c).result).toBe(oldSign(a, b, c));
  }
});
/** Full rational cross values, rather than signs alone, must feed interval bounds. */
function fullValueIntervalInvariant(source: string): boolean {
  type Shape = string | readonly Shape[];
  const shape = (node: ts.Expression): Shape => {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
      return shape(node.expression);
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'requiredValue' &&
        node.arguments.length === 1
      ) {
        const value = node.arguments[0];
        return value ? shape(value) : 'MISSING';
      }
      return ['call', shape(node.expression), ...node.arguments.map(shape)];
    }
    if (ts.isIdentifier(node) || ts.isNumericLiteral(node)) return node.text;
    if (ts.isElementAccessExpression(node))
      return ['index', shape(node.expression), shape(node.argumentExpression)];
    if (ts.isBinaryExpression(node))
      return [
        ts.tokenToString(node.operatorToken.kind) ?? 'UNSUPPORTED',
        shape(node.left),
        shape(node.right),
      ];
    return 'UNSUPPORTED';
  };
  const file = ts.createSourceFile('certificate.ts', source, ts.ScriptTarget.Latest, true);
  let contained: ts.ArrowFunction | undefined;
  const findContained = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'contained' &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    )
      contained = node.initializer;
    ts.forEachChild(node, findContained);
  };
  findContained(file);
  if (!contained) return false;
  const values = new Map<string, Shape>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      values.set(node.name.text, shape(node.initializer));
    ts.forEachChild(node, collect);
  };
  collect(contained.body);
  const edgeStart: Shape = ['index', 'tri', 'j'];
  const edgeEnd: Shape = ['index', 'tri', ['%', ['+', 'j', '1'], '3']];
  const expected = new Map<string, Shape>([
    ['u', ['call', 'cross', edgeStart, edgeEnd, 'p']],
    ['v', ['call', 'cross', edgeStart, edgeEnd, 'r']],
    ['delta', ['call', 'sub', 'v', 'u']],
    ['bound', ['call', 'div', ['call', 'neg', 'u'], 'delta']],
  ]);
  return [...expected].every(
    ([name, value]) => JSON.stringify(values.get(name)) === JSON.stringify(value),
  );
}

it('23 full-value interval callers retain cross', () => {
  const s = readFileSync(
    new URL('./semantic-whole-interface-certificate.ts', import.meta.url),
    'utf8',
  );
  expect(fullValueIntervalInvariant(s)).toBe(true);
});
it('24 unknown consumers default to unchanged full cross', () => {
  const s = readFileSync(
    new URL('./semantic-whole-interface-certificate.ts', import.meta.url),
    'utf8',
  );
  expect(s).toContain('const cross = (a: P, b: P, c: P): Q =>');
  expect(s).toContain('cross(a, b, p).n === 0n');
  expect(s).toContain('area = cross(a, b, c)');
});
it('25 unsupported denominator invokes full fallback', () => {
  const a = p(1, 0, -3n);
  expect(run(a, B, C)).toMatchObject({ result: oldSign(a, B, C), fallback: 1 });
  expect(() => run(p(1, 0, 0n), B, C)).toThrow('zero denominator');
});
it('26 supported sign path does not call GCD', () => {
  const gcd = vi.fn(),
    fallback = vi.fn((): S => {
      gcd();
      return 0;
    });
  expect(
    sign(
      p(1, 2, 3n, 5n),
      B,
      C,
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      fallback,
    ),
  ).toBe(oldSign(p(1, 2, 3n, 5n), B, C));
  expect(fallback).not.toHaveBeenCalled();
  expect(gcd).not.toHaveBeenCalled();
});
it('27 full-value product path still executes GCD', () => {
  const spy = vi.spyOn(InvocationExactGcdCache.prototype, 'get');
  try {
    expect(certificate().result.complete).toBe(true);
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
it('28 immutable source coordinates preserved', () => {
  const a = Object.freeze({ x: Object.freeze(q(-3, 5n)), y: Object.freeze(q(7, 11n)) });
  const before = [a.x.n, a.x.d, a.y.n, a.y.d];
  run(a, B, C);
  expect([a.x.n, a.x.d, a.y.n, a.y.d]).toEqual(before);
});
it('29 cancellation propagates before returning sign', () => {
  let n = 0;
  expect(() =>
    sign(
      A,
      B,
      C,
      () => {
        if (++n === 10) throw Error('cancel');
      },
      () => 0,
    ),
  ).toThrow('cancel');
  expect(n).toBe(10);
});
it('30 deterministic repeat', () => {
  expect(run()).toEqual(run());
});
it('31 inherited GCD key behavior', () => {
  const cache = new InvocationExactGcdCache((): void => {
    // Intentionally empty hook; preserve the undefined return value.
  }, 4);
  cache.store(-42n, 30n, 6n, 3);
  expect(cache.get(-42n, 30n)).toBe(6n);
  expect(cache.get(42n, 30n)).toBeUndefined();
  expect(cache.get(30n, -42n)).toBeUndefined();
});
it('32 inherited range behavior', () => {
  const r = (a: number[]): ExactTriangleDepthRange =>
    exactTriangleDepthRange(
      a.map((n) => ({ z: q(n) })),
      cmp,
    );
  expect(exactRangeNonCloser(r([1, 2, 3]), r([-1, 0, 1]), cmp)).toBe(true);
  expect(exactRangeNonCloser(r([-1, 2, 3]), r([0, 0, 0]), cmp)).toBe(false);
});
it('33 sign path exact operation accounting', () => {
  expect(run().work).toBe(31);
  expect(run(A, C, B).work).toBe(30);
  expect(run(A, B, p(1, 0)).work).toBe(31);
});
it('34 full path old normalization accounting', () => {
  let n = 0;
  expect(oldCross(A, B, C, () => n++)).toEqual(q(4));
  expect(n).toBe(7);
  const x = certificate();
  expect(x.result.workUnits).toBe(x.work);
});
it('35 no floating arithmetic in sign helper', () => {
  const s = readFileSync(new URL('./semantic-owner-orientation-sign.ts', import.meta.url), 'utf8');
  expect(s).not.toMatch(/Number\(|parseFloat|Math\.|epsilon|toFixed/);
  expect(s).toContain('x: bigint, y: bigint');
});
it('36 zero after large rational cancellation', () => {
  const n = 1n << 1024n;
  const a = p(-n, -n, 3n, 3n),
    b = p(n, n, 5n, 5n),
    c = p(7n * n, 7n * n, 11n, 11n);
  expect(run(a, b, c)).toEqual({ result: 0, work: 31, fallback: 0 });
});

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
