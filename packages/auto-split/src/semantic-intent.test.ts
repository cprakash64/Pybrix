import { it, expect } from 'vitest';
import type { SemanticPart } from '@cadfixer/auto-split-contract';
import { semanticDecompositionIntent } from './semantic-intent';
const run = (
  shares: readonly number[],
  selected = 0.95,
  peers: readonly { id: string; leakage: number; views: number; independent: boolean }[] = [],
): ReturnType<typeof semanticDecompositionIntent> =>
  semanticDecompositionIntent(shares, selected, peers, () => undefined);
it('refuses whole-like target and tiny ungrounded complement without using labels', () => {
  expect(run([0.9694, 0.6729], 0.9739)).toMatchObject({
    admitted: false,
    rule: 'NO_MEANINGFUL_DECOMPOSITION',
  });
});
it('localization without independent decomposition structure is insufficient', () => {
  expect(run([0.2, 0.4], 0.3).admitted).toBe(false);
});
it('does not accept one localized view alone', () => {
  expect(run([0.2, 0.96], 0.8).admitted).toBe(false);
});
it('a tiny residual requires a grounded meaningful opposite peer', () => {
  expect(run([0.4, 0.4], 0.96).admitted).toBe(false);
  expect(
    run([0.96, 0.96], 0.95, [{ id: 'peer', leakage: 0.05, views: 2, independent: true }]).admitted,
  ).toBe(true);
});
it('ignores ungrounded or overlapping peer descriptions', () => {
  expect(
    run([0.96, 0.96], 0.95, [
      { id: 'peer', leakage: 0.6, views: 3, independent: true },
      { id: 'child', leakage: 0, views: 1, independent: false },
    ]).admitted,
  ).toBe(false);
});
it('cancellation publishes no intent result', () => {
  let calls = 0;
  expect(() =>
    semanticDecompositionIntent([0.2, 0.2], 0.2, [], () => {
      if (++calls === 2) throw Error('cancel');
    }),
  ).toThrow('cancel');
});
it('ownership descendants and detail annotations cannot self-corroborate decomposition', async () => {
  const { independentPlanePeer } = await import('./semantic-intent');
  const make = (
    id: string,
    parentId: string | null,
    importance: 'major' | 'detail' = 'major',
  ): SemanticPart => ({
    id,
    label: 'unfamiliar neutral part',
    parentId,
    importance,
    confidence: 0.99,
    instances: 1,
    componentIds: [],
    expectedGeometry: { kind: 'solid_part', likelySeparable: false },
    cut: null,
    views: [],
  });
  const target = make('a', null),
    child = make('b', 'a', 'detail'),
    sibling = make('c', null),
    answer = {
      object: { label: 'unfamiliar assembly', confidence: 0.99 },
      parts: [target, child, sibling],
    };
  const strong = { independentAxes: 2, sameSourceComponent: true };
  expect(independentPlanePeer(target, child.id, answer, strong, () => undefined)).toBe(false);
  expect(independentPlanePeer(target, sibling.id, answer, strong, () => undefined)).toBe(true);
  expect(
    independentPlanePeer(
      target,
      sibling.id,
      answer,
      { ...strong, independentAxes: 1 },
      () => undefined,
    ),
  ).toBe(false);
  expect(
    independentPlanePeer(
      target,
      sibling.id,
      answer,
      { ...strong, sameSourceComponent: false },
      () => undefined,
    ),
  ).toBe(false);
  const majorChild = { ...child, importance: 'major' as const };
  expect(
    independentPlanePeer(
      target,
      child.id,
      { ...answer, parts: [target, majorChild, sibling] },
      strong,
      () => undefined,
    ),
  ).toBe(false);
});
