import { describe, expect, it } from 'vitest';
import { compareSemanticPlanes, type SemanticPlaneOrderCandidate } from './semantic-plane-order';

const candidate = (
  offset: number,
  offsetSource: SemanticPlaneOrderCandidate['offsetSource'] = 'SEMANTIC_TRANSITION',
): SemanticPlaneOrderCandidate => ({
  normal: [0, 0, -1],
  offset,
  offsetSource,
  section: 0,
  score: { clean: true, worstLeakage: 0, recall: 1, purity: 1, fraction: 0.8 },
});
const sign = (n: number): number => Math.sign(n);

describe('semantic plane evidence-only final tie resolution', () => {
  it.each([
    ['simple', -0.12, -0.11],
    ['occluded', -0.09, -0.08],
    ['asymmetric', -0.14, -0.13],
    ['thin supported proposal', 0.1, 0.11],
  ])('retains an existing target frontier for the %s tied pattern', (_name, low, high) => {
    const positional = candidate(low);
    const anchor = candidate(high, 'TARGET_MIN');
    expect({ ...positional, offset: anchor.offset, offsetSource: anchor.offsetSource }).toEqual(
      anchor,
    );
    expect(positional.offset - anchor.offset).toBeLessThan(0);
    expect(compareSemanticPlanes(positional, anchor)).toBeGreaterThan(0);
    expect(
      compareSemanticPlanes(
        { ...positional, offsetSource: 'PROVIDER_HINT' },
        {
          ...anchor,
          offsetSource: 'PROVIDER_HINT',
        },
      ),
    ).toBeLessThan(0);
  });

  it.each(['TARGET_MIN', 'TARGET_MAX'] as const)(
    'treats %s as the same frontier evidence class',
    (source) => {
      const anchor = candidate(0.2, source);
      expect(compareSemanticPlanes(anchor, candidate(0.1))).toBeLessThan(0);
      expect(compareSemanticPlanes(anchor, { ...anchor, offsetSource: 'TARGET_MAX' })).toBe(0);
    },
  );

  it('does not override higher-priority quality, section or normal terms', () => {
    const anchor = candidate(0.2, 'TARGET_MIN');
    const preferred = candidate(0.1);
    const worse: SemanticPlaneOrderCandidate[] = [
      { ...anchor, score: { ...anchor.score, clean: false } },
      { ...anchor, score: { ...anchor.score, recall: 0.99 } },
      { ...anchor, score: { ...anchor.score, purity: 0.99 } },
      { ...anchor, score: { ...anchor.score, worstLeakage: 0.01 } },
      { ...anchor, score: { ...anchor.score, fraction: 0.9 } },
      { ...anchor, section: 1 },
      { ...anchor, normal: [1, 0, 0] },
    ];
    for (const c of worse) expect(compareSemanticPlanes(preferred, c)).toBeLessThan(0);
  });

  it('preserves localization and corroborated frontier priorities', () => {
    const scope = {
      intrinsicFrontier: 0.1,
      pixelUncertainty: 0.001,
      boundaryWitness: { observedAxes: [0, 1] },
    };
    const a = { ...candidate(0.1), groundedScope: scope, localization: 0.8 };
    const b = { ...candidate(0.2, 'TARGET_MIN'), groundedScope: scope, localization: 0.7 };
    expect(compareSemanticPlanes(a, b)).toBeLessThan(0);
    expect(compareSemanticPlanes(a, { ...b, localization: 0.8 })).toBeLessThan(0);
  });

  it('has antisymmetry, transitivity and deterministic permutation-independent order', () => {
    const cs = [
      candidate(0.1),
      candidate(0.2, 'TARGET_MIN'),
      candidate(0.3, 'TARGET_MAX'),
      candidate(0.4, 'PROVIDER_HINT'),
      candidate(0.5),
    ];
    for (const a of cs) {
      expect(compareSemanticPlanes(a, a)).toBe(0);
      for (const b of cs) {
        expect(sign(compareSemanticPlanes(a, b)) + sign(compareSemanticPlanes(b, a))).toBe(0);
        for (const c of cs)
          if (compareSemanticPlanes(a, b) < 0 && compareSemanticPlanes(b, c) < 0)
            expect(compareSemanticPlanes(a, c)).toBeLessThan(0);
      }
    }
    const expected = [...cs].sort(compareSemanticPlanes);
    expect([...expected].sort(compareSemanticPlanes)).toEqual(expected);
    expect([...cs].reverse().sort(compareSemanticPlanes)).toEqual(expected);
    expect(
      [cs[2], cs[4], cs[0], cs[3], cs[1]]
        .filter((c): c is SemanticPlaneOrderCandidate => !!c)
        .sort(compareSemanticPlanes),
    ).toEqual(expected);
  });

  it('preserves same-normal ordering under common translation and min/max relabeling', () => {
    const a = candidate(0.1),
      b = candidate(0.2, 'TARGET_MIN');
    for (const delta of [-1000, 37, 1000])
      expect(
        sign(
          compareSemanticPlanes(
            { ...a, offset: a.offset + delta },
            {
              ...b,
              offset: b.offset + delta,
            },
          ),
        ),
      ).toBe(sign(compareSemanticPlanes(a, b)));
    expect(compareSemanticPlanes(b, { ...b, offsetSource: 'TARGET_MAX' })).toBe(0);
    expect(compareSemanticPlanes(a, { ...a, normal: [0, 0, 1] })).not.toBe(0);
  });
});
