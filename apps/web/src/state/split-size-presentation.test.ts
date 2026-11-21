import { describe, expect, it } from 'vitest';
import {
  allSplitSizeCopy,
  describeSplitSizes,
  describeTooDetailed,
  splitSizeNoticeFor,
} from './split-size-presentation';

describe('the split size notice', () => {
  it('is absent at and below the ceiling, and while the size is unknown', () => {
    expect(splitSizeNoticeFor(undefined)).toBeUndefined();
    expect(splitSizeNoticeFor(0)).toBeUndefined();
    expect(splitSizeNoticeFor(1_999_999)).toBeUndefined();
    expect(splitSizeNoticeFor(2_000_000)).toBeUndefined();
  });

  it('is present one triangle above it, carrying the count and the shared limit', () => {
    expect(splitSizeNoticeFor(2_000_001)).toEqual({ triangles: 2_000_001, limit: 2_000_000 });
  });

  it('says sizes the way people do, and never prints a number equal to the limit it exceeds', () => {
    expect(describeSplitSizes({ triangles: 2_010_000, limit: 2_000_000 })).toEqual({
      size: '2.01M',
      limit: '2.00M',
    });
    // 2,000,001 and 2,000,000 are both "2.00M": written out in full instead of contradicting.
    expect(describeSplitSizes({ triangles: 2_000_001, limit: 2_000_000 })).toEqual({
      size: '2,000,001',
      limit: '2,000,000',
    });
  });

  it('tells the person what is true: the size, the limit, that nothing changed or was sent', () => {
    const copy = describeTooDetailed('Manual Split', { triangles: 2_010_000, limit: 2_000_000 });
    expect(copy.heading).toBe('This model is too detailed for Manual Split right now.');
    expect(copy.figure).toBe('2.01M triangles');
    expect(copy.limit).toBe('Manual Split currently supports models up to 2.00M triangles.');
    expect(copy.unchanged).toBe('Your model is unchanged and nothing was sent.');
  });

  it('does not offer a retry, and does not point at another tool', () => {
    for (const tool of ['Manual Split'] as const) {
      const text = Object.values(
        describeTooDetailed(tool, { triangles: 2_500_000, limit: 2_000_000 }),
      ).join(' ');
      expect(text).not.toMatch(/try again|retry|use manual split|use auto split/i);
      expect(text).toContain('Repair, Convert and Export have their own limits.');
    }
  });

  it('carries none of the words the product must never use', () => {
    for (const phrase of allSplitSizeCopy())
      expect(phrase).not.toMatch(
        /printable|watertight|manifold|scorer|triangle soup|provider|error free|\bhole\b/i,
      );
  });
});
