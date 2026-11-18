import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from './document';
import {
  classifyPlacement,
  PLACEMENT_CLASSIFICATION_TOLERANCE,
  PlacementRefusal,
  type PlacementClass,
} from './placement';

/*
 * Which placements may carry a connector. The canonical transform is twelve numbers: three basis vectors (the columns of the linear
 * part) and then the translation. Only a SIMILARITY has one physical scale; everything else is refused with the reason it is not
 * one. These cases were the worker's `uniformPhysicalScale` tests, ported with the classifier; the `legacy` block below holds the
 * new classifier to the old function's every number.
 */
type T12 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
const linear = (
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  t: [number, number, number] = [0, 0, 0],
): T12 => [...a, ...b, ...c, ...t];
// a rotation of 36.87 degrees about Y (sin 0.6, cos 0.8), exact enough that its axes are unit length and orthogonal
const ROT_Y = (s: number): T12 => linear([0.8 * s, 0, -0.6 * s], [0, s, 0], [0.6 * s, 0, 0.8 * s]);

const scaleOf = (transform: readonly number[]): number => {
  const placement = classifyPlacement(transform);
  return placement.kind === 'SIMILARITY' ? placement.scale : Number.NaN;
};
const reasonOf = (transform: readonly number[]): PlacementRefusal | undefined => {
  const placement = classifyPlacement(transform);
  return placement.kind === 'UNSUPPORTED' ? placement.reason : undefined;
};

describe('classifyPlacement — the placements that may carry a connector', () => {
  it('identity is a similarity of scale 1', () => {
    expect(classifyPlacement(IDENTITY_PART_TRANSFORM)).toEqual({ kind: 'SIMILARITY', scale: 1 });
  });
  it('a translation does not change it, however far', () => {
    expect(scaleOf(linear([1, 0, 0], [0, 1, 0], [0, 0, 1], [100, -50, 30]))).toBe(1);
    expect(scaleOf(linear([1, 0, 0], [0, 1, 0], [0, 0, 1], [1e9, -1e9, 1e9]))).toBe(1);
  });
  it('a rotation is scale 1 (a quarter turn about X, and an oblique turn about Y)', () => {
    expect(scaleOf(linear([1, 0, 0], [0, 0, 1], [0, -1, 0]))).toBe(1);
    expect(scaleOf(ROT_Y(1))).toBeCloseTo(1, 12);
  });
  it('a uniform scale is that scale, alone or with a rotation and a translation', () => {
    for (const s of [0.5, 2, 4, 25.4])
      expect(scaleOf(linear([s, 0, 0], [0, s, 0], [0, 0, s]))).toBe(s);
    const turned = ROT_Y(2);
    turned[9] = 7;
    turned[10] = 8;
    turned[11] = 9;
    expect(scaleOf(turned)).toBeCloseTo(2, 12);
  });
  it('a reflection is a similarity: it preserves every distance', () => {
    expect(scaleOf(linear([-1, 0, 0], [0, 1, 0], [0, 0, 1]))).toBe(1);
    expect(scaleOf(linear([-3, 0, 0], [0, 3, 0], [0, 0, 3]))).toBe(3);
  });
  it('a non-uniform scale is refused as such, along any axis, and a turn does not hide it', () => {
    for (const t of [
      linear([2, 0, 0], [0, 1, 0], [0, 0, 1]),
      linear([1, 0, 0], [0, 2, 0], [0, 0, 1]),
      linear([1, 0, 0], [0, 1, 0], [0, 0, 0.5]),
    ])
      expect(reasonOf(t)).toBe(PlacementRefusal.NonUniformScale);
    const turned = ROT_Y(1);
    turned[4] = 1.5;
    expect(reasonOf(turned)).toBe(PlacementRefusal.NonUniformScale);
  });
  it('a shear is refused as such: the axes are no longer orthogonal, even when they keep their lengths', () => {
    // lengths are judged before angles, so a matrix whose axes differ in length is reported as the scale it is, whatever else it does
    expect(reasonOf(linear([1, 0, 0], [0.5, 1, 0], [0, 0, 1]))).toBe(
      PlacementRefusal.NonUniformScale,
    );
    // two unit axes 60 degrees apart: equal lengths, not orthogonal
    expect(reasonOf(linear([1, 0, 0], [0.5, Math.sqrt(3) / 2, 0], [0, 0, 1]))).toBe(
      PlacementRefusal.Shear,
    );
  });
  it('a degenerate placement is refused as degenerate: a collapsed axis, a zero scale', () => {
    expect(reasonOf(linear([0, 0, 0], [0, 0, 0], [0, 0, 0]))).toBe(PlacementRefusal.Degenerate);
    expect(reasonOf(linear([1, 0, 0], [0, 0, 0], [0, 0, 1]))).toBe(PlacementRefusal.Degenerate);
    expect(reasonOf(linear([0, 0, 0], [0, 1, 0], [0, 0, 1]))).toBe(PlacementRefusal.Degenerate);
  });
  it('a non-finite entry is refused as non-finite, and so is a scale that overflows', () => {
    expect(reasonOf(linear([Number.NaN, 0, 0], [0, 1, 0], [0, 0, 1]))).toBe(
      PlacementRefusal.NonFinite,
    );
    expect(reasonOf(linear([Infinity, 0, 0], [0, Infinity, 0], [0, 0, Infinity]))).toBe(
      PlacementRefusal.NonFinite,
    );
    expect(reasonOf(linear([1.7e308, 1.7e308, 0], [0, 1, 0], [0, 0, 1]))).toBe(
      PlacementRefusal.NonFinite,
    );
    expect(reasonOf(linear([1, 0, 0], [0, 1, 0], [0, 0, 1], [Number.NaN, 0, 0]))).toBeUndefined();
  });
  it('anything that is not twelve numbers is refused as malformed', () => {
    expect(reasonOf([])).toBe(PlacementRefusal.Malformed);
    expect(reasonOf([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(PlacementRefusal.Malformed);
    expect(reasonOf([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0])).toBe(PlacementRefusal.Malformed);
  });
  it('keeps the tolerance this check has always had: one part in a million agrees, one in a hundred thousand does not', () => {
    expect(PLACEMENT_CLASSIFICATION_TOLERANCE).toBe(1e-6);
    expect(scaleOf(linear([1, 0, 0], [0, 1 + 5e-7, 0], [0, 0, 1 - 5e-7]))).toBeGreaterThan(0.999);
    expect(reasonOf(linear([1, 0, 0], [0, 1 + 1e-5, 0], [0, 0, 1]))).toBe(
      PlacementRefusal.NonUniformScale,
    );
    // axes that deviate from orthogonal by 5e-7 are accepted, by 1e-5 are not
    expect(scaleOf(linear([1, 0, 0], [5e-7, 1, 0], [0, 0, 1]))).toBeGreaterThan(0.999);
    expect(reasonOf(linear([1, 0, 0], [1e-5, 1, 0], [0, 0, 1]))).toBe(PlacementRefusal.Shear);
  });
  it('is pure and its answers are frozen', () => {
    const t = ROT_Y(2);
    const before = [...t];
    const a = classifyPlacement(t);
    expect(classifyPlacement(t)).toEqual(a);
    expect([...t]).toEqual(before);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(classifyPlacement([]))).toBe(true);
  });
});

/**
 * THE FUNCTION THIS CLASSIFIER REPLACED, copied verbatim as an oracle (`uniformPhysicalScale`, Slice 2D). Stage C03-A is a
 * refactor; the claim is that the scale is the same number to the bit, and NaN exactly where this returned NaN.
 */
function legacyUniformPhysicalScale(transform: readonly number[]): number {
  if (transform.length !== 12) return Number.NaN;
  const axes: readonly (readonly [number, number, number])[] = [
      [transform[0] ?? Number.NaN, transform[1] ?? Number.NaN, transform[2] ?? Number.NaN],
      [transform[3] ?? Number.NaN, transform[4] ?? Number.NaN, transform[5] ?? Number.NaN],
      [transform[6] ?? Number.NaN, transform[7] ?? Number.NaN, transform[8] ?? Number.NaN],
    ],
    lengths = axes.map((axis) => Math.hypot(...axis)),
    scale = lengths[0] ?? Number.NaN;
  if (
    !(scale > 0) ||
    !Number.isFinite(scale) ||
    lengths.some((x) => !(Math.abs(x - scale) <= scale * 1e-6))
  )
    return Number.NaN;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const a = axes[i],
        b = axes[j];
      if (a === undefined || b === undefined) return Number.NaN;
      if (!(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) <= scale * scale * 1e-6))
        return Number.NaN;
    }
  return scale;
}

/** A deterministic generator, so the grid is the same on every machine. */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
type V3 = readonly [number, number, number];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit3 = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** Gram-Schmidt of two random vectors and their cross product: a rotation, up to rounding. */
function rotationFrom(u: () => number): readonly [V3, V3, V3] {
  const first: V3 = [u() - 0.5, u() - 0.5, u() - 0.5],
    second: V3 = [u() - 0.5, u() - 0.5, u() - 0.5];
  const e0 = unit3(first),
    along = dot3(second, e0),
    e1 = unit3([second[0] - along * e0[0], second[1] - along * e0[1], second[2] - along * e0[2]]);
  return [e0, e1, cross3(e0, e1)];
}

describe('classifyPlacement against the function it replaced', () => {
  it('returns the identical scale, to the bit, and refuses exactly where that function returned NaN', () => {
    const u = sequence(20261117);
    const cases: number[][] = [];
    const roundings: readonly (number | undefined)[] = [undefined, 9, 7, 6, 5, 4];
    const scales: readonly number[] = [1, 0.5, 2, 25.4, 1e-3, 1e3];
    for (let n = 0; n < 4000; n++) {
      const axes = rotationFrom(u);
      const scale = scales[n % scales.length] ?? 1;
      const jitter = n % 7 === 0 ? 1 + (u() - 0.5) * 4e-6 : 1;
      const digits = roundings[n % roundings.length];
      const round = (x: number): number => (digits === undefined ? x : Number(x.toFixed(digits)));
      const reflect = n % 5 === 0 ? -1 : 1;
      const row = (axis: V3, index: number): number[] =>
        axis.map((x) =>
          round(x * scale * (index === 1 ? jitter : 1) * (index === 0 ? reflect : 1)),
        );
      cases.push([
        ...row(axes[0], 0),
        ...row(axes[1], 1),
        ...row(axes[2], 2),
        u() * 100,
        u() * 100,
        u() * 100,
      ]);
    }
    for (const special of [
      [...IDENTITY_PART_TRANSFORM],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [1, 0, 0, 0, 1, 0, 0, 0, 1, Number.NaN, 0, 0],
      [Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      [Infinity, 0, 0, 0, Infinity, 0, 0, 0, Infinity, 0, 0, 0],
      [1.7e308, 1.7e308, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      [-Infinity, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      [1, 0, 0, 0.5, 1, 0, 0, 0, 1, 0, 0, 0],
      [2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      [-0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      [],
      [1, 2, 3],
    ])
      cases.push(special);
    let similarities = 0,
      refusals = 0;
    for (const transform of cases) {
      const legacy = legacyUniformPhysicalScale(transform);
      const now: PlacementClass = classifyPlacement(transform);
      if (Number.isNaN(legacy)) {
        refusals++;
        expect(now.kind).toBe('UNSUPPORTED');
      } else {
        similarities++;
        expect(now.kind).toBe('SIMILARITY');
        if (now.kind === 'SIMILARITY') expect(Object.is(now.scale, legacy)).toBe(true);
      }
    }
    // the grid exercises both sides, or it would prove nothing
    expect(similarities).toBeGreaterThan(500);
    expect(refusals).toBeGreaterThan(500);
  });
});
