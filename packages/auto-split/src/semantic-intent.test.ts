import { it, expect } from 'vitest';
import { semanticDecompositionIntent } from './semantic-intent';
const run = (
  shares: readonly number[],
  selected = 0.95,
  peers: readonly { id: string; leakage: number; views: number }[] = [],
): ReturnType<typeof semanticDecompositionIntent> =>
  semanticDecompositionIntent(shares, selected, peers, () => undefined);
it('refuses whole-like target and tiny ungrounded complement without using labels', () => {
  expect(run([0.9694, 0.6729], 0.9739)).toMatchObject({
    admitted: false,
    rule: 'NO_MEANINGFUL_DECOMPOSITION',
  });
});
it('permits a localized lid with a substantial unnamed body', () => {
  expect(run([0.2, 0.4], 0.3).admitted).toBe(true);
});
it('does not accept one localized view alone', () => {
  expect(run([0.2, 0.96], 0.8).admitted).toBe(false);
});
it('a tiny residual requires a grounded meaningful opposite peer', () => {
  expect(run([0.4, 0.4], 0.96).admitted).toBe(false);
  expect(run([0.96, 0.96], 0.95, [{ id: 'peer', leakage: 0.05, views: 2 }]).admitted).toBe(true);
});
it('ignores ungrounded or overlapping peer descriptions', () => {
  expect(
    run([0.96, 0.96], 0.95, [
      { id: 'peer', leakage: 0.6, views: 3 },
      { id: 'child', leakage: 0, views: 1 },
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
