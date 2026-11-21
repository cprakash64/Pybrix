import { isWithinSplitTriangleCeiling, MAX_SUPPORTED_SPLIT_TRIANGLES } from '@cadfixer/mesh-core';

/**
 * WHAT THE PAGE SAYS ABOUT A MODEL TOO DETAILED TO SPLIT, in one file.
 *
 * Every split path shares ONE triangle ceiling (`MAX_SUPPORTED_SPLIT_TRIANGLES`), so a part above it
 * cannot be cut, and the page says that BEFORE the user starts anything. It is a deterministic outcome, not a failure: the part's triangle count is a fact
 * the page already holds (`PartDescriptor.triangleCount`) and the ceiling is a constant, so repeating
 * the action cannot change the answer. It is therefore shown as a neutral STATUS, never an alert, and
 * carries no "Try again".
 *
 * WHAT IT MAY CLAIM. That the model is unchanged and nothing was sent (both true: the check is a
 * comparison of two numbers on the page). It does not say what the model is "too" anything for
 * beyond the product's current limit, and it names the other workflows only to say they have their OWN
 * limits, because whether Repair, Convert or Export accepts a particular model is not decided here.
 */

export interface SplitSizeNotice {
  readonly triangles: number;
  readonly limit: number;
}

/** The notice for a part, or undefined when it is within the ceiling (or its size is not yet known). */
export function splitSizeNoticeFor(triangles: number | undefined): SplitSizeNotice | undefined {
  if (triangles === undefined || isWithinSplitTriangleCeiling(triangles)) return undefined;
  return { triangles, limit: MAX_SUPPORTED_SPLIT_TRIANGLES };
}

const millions = (n: number): string => `${(n / 1_000_000).toFixed(2)}M`;

/**
 * The part's size and the limit, each as people say it (`2.01M`). When the short forms would read the
 * same — 2,000,001 against 2,000,000 are both "2.00M" — both are written out in full instead, so the
 * sentence can never say a number exceeds a limit it is printed equal to.
 */
export function describeSplitSizes(notice: SplitSizeNotice): {
  readonly size: string;
  readonly limit: string;
} {
  const size = millions(notice.triangles);
  const limit = millions(notice.limit);
  return size === limit
    ? {
        size: notice.triangles.toLocaleString('en-US'),
        limit: notice.limit.toLocaleString('en-US'),
      }
    : { size, limit };
}

export type SplitToolName = 'Manual Split';

export interface SplitSizeCopy {
  readonly heading: string;
  readonly figure: string;
  readonly limit: string;
  readonly unchanged: string;
  readonly others: string;
}

export function describeTooDetailed(tool: SplitToolName, notice: SplitSizeNotice): SplitSizeCopy {
  const sizes = describeSplitSizes(notice);
  return {
    heading: `This model is too detailed for ${tool} right now.`,
    figure: `${sizes.size} triangles`,
    limit: `${tool} currently supports models up to ${sizes.limit} triangles.`,
    unchanged: 'Your model is unchanged and nothing was sent.',
    others: 'Repair, Convert and Export have their own limits.',
  };
}

/**
 * The words for a split the worker refused for RESOURCES (a limit other than the part's own size:
 * the cut's result, its working room). Neutral, and it does not point at Manual Split: whether
 * Manual Split can place a cut the exact split just declined is exactly what was not possible.
 */
export const RESOURCE_REFUSAL_COPY = Object.freeze({
  heading: 'This operation is too large to process safely with the current limits.',
  body: 'Pybrix stopped before it could prepare a preview of this cut. Try a smaller model or a simpler operation. Your model is unchanged.',
  others: 'Repair, Convert and Export have their own limits.',
});

/** Every string above, flattened, for the banned-wording tests. */
export function allSplitSizeCopy(): readonly string[] {
  const phrases: string[] = [...Object.values(RESOURCE_REFUSAL_COPY)];
  for (const tool of ['Manual Split'] as const) {
    for (const triangles of [2_010_000, 2_000_001]) {
      const copy = describeTooDetailed(tool, { triangles, limit: 2_000_000 });
      phrases.push(copy.heading, copy.figure, copy.limit, copy.unchanged, copy.others);
    }
  }
  return phrases;
}
