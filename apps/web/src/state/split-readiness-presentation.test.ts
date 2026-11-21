import { describe, expect, it } from 'vitest';
import { invalidState, resourceLimitExceeded } from '@cadfixer/shared';
import { SPLIT_SOURCE_NOT_CLOSED_SOLID_CODE } from '@cadfixer/geometry-runtime';
import {
  allSplitReadinessCopy,
  describeNotClosed,
  describeSourceReason,
  NOT_CLOSED_COPY,
  notClosedReasonsOf,
} from './split-readiness-presentation';

describe('a model that is not a closed solid, in the person’s words', () => {
  it('says the three things a person needs, in the approved sentences', () => {
    const copy = describeNotClosed(['OPEN_BOUNDARIES']);
    expect(copy.heading).toBe('This model needs repair before it can be split.');
    expect(copy.found).toBe(
      'Pybrix found geometry that isn’t a closed solid: the surface has open edges.',
    );
    expect(copy.advice).toBe(
      'Repair the model, then try Split again. Repair may not be able to make every model splittable.',
    );
    expect(copy.unchanged).toBe('Your original model was not changed.');
    expect(copy.action).toBe('Repair model');
  });

  it('names every reason, joined, and still reads when there is none to name', () => {
    expect(describeNotClosed(['OPEN_BOUNDARIES', 'NON_MANIFOLD']).found).toBe(
      'Pybrix found geometry that isn’t a closed solid: the surface has open edges; some edges or points are shared by too many faces.',
    );
    expect(describeNotClosed([]).found).toBe('Pybrix found geometry that isn’t a closed solid.');
  });

  it('uses no engine vocabulary and promises nothing Repair cannot', () => {
    for (const phrase of allSplitReadinessCopy()) {
      expect(phrase).not.toMatch(
        /manifold|topolog|triangle soup|kernel|boolean|workspace|printable|watertight|\bhole\b/i,
      );
      // It may point at Repair; it may not say Repair will fix it.
      expect(phrase).not.toMatch(/will (fix|repair|close|make)|fixes this|guarantee/i);
    }
  });

  it('offers no retry: the same file is refused the same way every time', () => {
    for (const phrase of allSplitReadinessCopy())
      expect(phrase).not.toMatch(/try again|retry|start over/i);
  });

  it('keeps the chip beside a suggestion it cannot execute', () => {
    expect(NOT_CLOSED_COPY.chip).toBe('Repair model first');
    expect(describeSourceReason('SOMETHING_ELSE')).toBe('its surface is not closed');
  });
});

describe('recognising the worker’s refusal', () => {
  it('reads the reasons from the error’s code, never from its sentence', () => {
    const refusal = invalidState('Any wording at all.', {
      code: SPLIT_SOURCE_NOT_CLOSED_SOLID_CODE,
      reasons: 'OPEN_BOUNDARIES,NON_MANIFOLD',
    });
    expect(notClosedReasonsOf(refusal)).toEqual(['OPEN_BOUNDARIES', 'NON_MANIFOLD']);
  });

  it('is not fooled by wording, by another code, or by a resource refusal', () => {
    expect(
      notClosedReasonsOf(invalidState('Manual splitting currently requires a closed solid.')),
    ).toBeUndefined();
    expect(notClosedReasonsOf(invalidState('x', { code: 'SOMETHING_ELSE' }))).toBeUndefined();
    expect(
      notClosedReasonsOf(resourceLimitExceeded('x', { metric: 'inputBytes' })),
    ).toBeUndefined();
    expect(notClosedReasonsOf(new Error('requires a closed solid'))).toBeUndefined();
    expect(notClosedReasonsOf(undefined)).toBeUndefined();
  });
});
