import { describe, expect, it } from 'vitest';
import { distinctReviewPlanes, MAX_REVIEW_ALTERNATIVES } from './semantic-review-alternatives';
import type { SuggestedPlane } from './suggestions';
const plane = (x: number): SuggestedPlane => ({ normal: [1, 0, 0], origin: [x, 0, 0] });
describe('bounded physical review publication', () => {
  it('deduplicates exact physical identity while retaining existing order', () => {
    const first = plane(1),
      second = plane(2);
    expect(distinctReviewPlanes([first, { normal: [2, 0, 0], origin: [1, 3, 9] }, second])).toEqual(
      [first, second],
    );
  });
  it('caps metadata without introducing another plane or changing order', () => {
    const input = [plane(3), plane(1), plane(2), plane(4)];
    const selected = distinctReviewPlanes(input);
    expect(selected).toEqual(input.slice(0, MAX_REVIEW_ALTERNATIVES));
    selected.forEach((p) => {
      expect(input).toContain(p);
    });
  });
  it('retains the opposite intended physical piece as a distinct oriented choice', () => {
    expect(
      distinctReviewPlanes([plane(1), { normal: [-1, 0, 0], origin: [1, 0, 0] }]),
    ).toHaveLength(2);
  });
  it('rejects invalid numeric planes instead of publishing a review choice', () => {
    expect(() => distinctReviewPlanes([{ normal: [0, 0, 0], origin: [0, 0, 0] }])).toThrow();
    expect(() => distinctReviewPlanes([plane(NaN)])).toThrow();
  });
});
