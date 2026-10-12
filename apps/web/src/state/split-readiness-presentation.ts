import { SPLIT_SOURCE_NOT_CLOSED_SOLID_CODE } from '@cadfixer/geometry-runtime';
import { isAppError } from '@cadfixer/shared';

/**
 * WHAT THE PAGE SAYS ABOUT A MODEL THAT IS NOT A CLOSED SOLID, in one file, for BOTH split tabs.
 *
 * Both tools cut a closed solid and nothing else, and refuse anything with open edges, edges shared by
 * more than two faces, faces that disagree about which side is outside, or zero-area or repeated faces.
 * That is a property of the model, not of its size and not of the moment: the same file is refused the
 * same way every time, so this is a neutral STATUS (never an alert), it offers no retry, and it says the
 * two things a person needs. The model was not changed, and Repair is where to go next.
 *
 * WHAT IT MAY CLAIM. That Repair is the next step, and not that Repair will succeed: Repair is
 * conservative and does not close every opening, so the sentence says it may not make every model
 * splittable. It uses no engine vocabulary (no manifold, no topology, no triangle soup, no kernel).
 */

export const NOT_CLOSED_COPY = Object.freeze({
  heading: 'This model needs repair before it can be split.',
  advice:
    'Repair the model, then try Split again. Repair may not be able to make every model splittable.',
  unchanged: 'Your original model was not changed.',
  action: 'Repair model',
  /** The status chip beside a suggestion the model cannot yet execute. */
  chip: 'Repair model first',
});

/** One reason from the local gate, in plain words. */
export function describeSourceReason(reason: string): string {
  switch (reason) {
    case 'OPEN_BOUNDARIES':
      return 'the surface has open edges';
    case 'NON_MANIFOLD':
      return 'some edges or points are shared by too many faces';
    case 'WINDING_CONFLICT':
      return 'some faces disagree about which side is outside';
    case 'DEGENERATE_OR_DUPLICATE':
      return 'it has zero-area or repeated faces';
    default:
      return 'its surface is not closed';
  }
}

export interface NotClosedCopy {
  readonly heading: string;
  readonly found: string;
  readonly advice: string;
  readonly unchanged: string;
  readonly action: string;
}

export function describeNotClosed(reasons: readonly string[]): NotClosedCopy {
  const facts = reasons.map(describeSourceReason);
  return {
    heading: NOT_CLOSED_COPY.heading,
    found:
      facts.length === 0
        ? 'Pybrix found geometry that isn’t a closed solid.'
        : `Pybrix found geometry that isn’t a closed solid: ${facts.join('; ')}.`,
    advice: NOT_CLOSED_COPY.advice,
    unchanged: NOT_CLOSED_COPY.unchanged,
    action: NOT_CLOSED_COPY.action,
  };
}

/**
 * The reasons the worker refused a split for, when `cause` is its "not a closed solid" refusal, or
 * undefined for anything else. Recognised by `details.code`, never by the sentence.
 */
export function notClosedReasonsOf(cause: unknown): readonly string[] | undefined {
  if (!isAppError(cause) || cause.details.code !== SPLIT_SOURCE_NOT_CLOSED_SOLID_CODE)
    return undefined;
  const joined = cause.details.reasons;
  return typeof joined === 'string' && joined !== '' ? joined.split(',') : [];
}

/** Every string above, flattened, for the banned-wording tests. */
export function allSplitReadinessCopy(): readonly string[] {
  const phrases: string[] = [...Object.values(NOT_CLOSED_COPY)];
  const all = [
    'OPEN_BOUNDARIES',
    'NON_MANIFOLD',
    'WINDING_CONFLICT',
    'DEGENERATE_OR_DUPLICATE',
    'X',
  ];
  for (const reason of all) phrases.push(describeSourceReason(reason));
  const copy = describeNotClosed(all);
  phrases.push(copy.heading, copy.found, copy.advice, copy.unchanged, copy.action);
  phrases.push(describeNotClosed([]).found);
  return phrases;
}
