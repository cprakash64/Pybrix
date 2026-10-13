import { describe, expect, it } from 'vitest';
import { ANALYZE_ERROR_MESSAGES, AnalyzeErrorCode } from '@cadfixer/auto-split-contract';
import {
  SuggestionOperation,
  SuggestionReason,
  SuggestionStatus,
  type Suggestion,
} from '@cadfixer/auto-split';
import {
  allAutoSplitCopy,
  AUTO_SPLIT_COPY,
  describeError,
  describeOperation,
  describeStatus,
} from './auto-split-presentation';
import { LocalErrorCode } from './auto-split-session';

const suggestion = (patch: Partial<Suggestion>): Suggestion => ({
  id: 'head',
  family: 'head',
  label: 'Head',
  operation: SuggestionOperation.Plane,
  status: SuggestionStatus.Suggested,
  reason: SuggestionReason.Clear,
  plane: null,
  components: [],
  ...patch,
});

describe('what Auto Split may say', () => {
  const BANNED: readonly RegExp[] = [
    /printable/i,
    /watertight/i,
    /\bholes?\b/i,
    /confidence/i,
    /accura/i,
    /\d\s*%/,
    /perfect/i,
    /every part/i,
    /all parts/i,
    /one-click/i,
    /automatically (separat|split|apply)/i,
    /gpt/i,
    /astra/i,
    /openai/i,
    /holdout/i,
    /matcher/i,
    /research/i,
    /semantic/i,
    /protocol/i,
    /\bAPI\b/,
    /\bmodel (found|knows)/i,
  ];

  it('uses none of the banned wording anywhere', () => {
    for (const phrase of allAutoSplitCopy())
      for (const banned of BANNED)
        expect(phrase, `${banned.source} in "${phrase}"`).not.toMatch(banned);
  });

  it('carries the approved disclosure and tagline exactly', () => {
    expect(AUTO_SPLIT_COPY.tagline).toBe(
      'AI finds likely parts and prepares editable splits for you to review.',
    );
    expect(AUTO_SPLIT_COPY.disclosure).toBe(
      'Auto Split uses AI to identify parts. Your original 3D file stays on your device. Auto Split sends six rendered views and limited model metadata for AI analysis. Repair and Manual Split remain local.',
    );
    expect(AUTO_SPLIT_COPY.claim).toBe(
      'AI-assisted part detection with editable split suggestions.',
    );
    expect(AUTO_SPLIT_COPY.badge).toBe('Beta');
    expect(AUTO_SPLIT_COPY.unsafeCut).toBe(
      "This cut can't be made safely. Try moving the cut or choose another part.",
    );
    expect(AUTO_SPLIT_COPY.needsRepairHeading).toBe(
      'This model needs repair before it can be split.',
    );
  });

  it('makes no zero-retention or deletion promise it cannot keep', () => {
    for (const phrase of allAutoSplitCopy()) {
      expect(phrase).not.toMatch(/delet|zero.?retention|never stored|not stored|forgotten/i);
    }
  });
});

describe('the four statuses', () => {
  it('names a strong suggestion, a cut to review, a selection to review, and no safe split', () => {
    expect(describeStatus(suggestion({}), true).label).toBe('Suggested');
    expect(
      describeStatus(suggestion({ status: SuggestionStatus.NeedsAdjustment }), true).label,
    ).toBe('Review cut');
    expect(
      describeStatus(
        suggestion({
          operation: SuggestionOperation.Component,
          status: SuggestionStatus.NeedsAdjustment,
        }),
        true,
      ).label,
    ).toBe('Review selection');
    expect(
      describeStatus(
        suggestion({ status: SuggestionStatus.Unavailable, operation: SuggestionOperation.None }),
        true,
      ).label,
    ).toBe('No safe split found');
  });

  it('says "Repair model first" instead of "Suggested" when the source cannot be split', () => {
    expect(describeStatus(suggestion({}), false).label).toBe('Repair model first');
    expect(
      describeStatus(suggestion({ status: SuggestionStatus.NeedsAdjustment }), false).label,
    ).toBe('Repair model first');
    // A part that has no safe split is that, whatever the source.
    expect(describeStatus(suggestion({ status: SuggestionStatus.Unavailable }), false).label).toBe(
      'No safe split found',
    );
  });

  it('never carries a number', () => {
    for (const ready of [true, false])
      for (const status of Object.values(SuggestionStatus))
        expect(describeStatus(suggestion({ status }), ready).label).not.toMatch(/\d/);
    for (const operation of Object.values(SuggestionOperation))
      expect(describeOperation(operation)).not.toMatch(/\d/);
  });
});

describe('errors', () => {
  it('shows our own sentence for every service code and offers retry where it helps', () => {
    for (const code of Object.values(AnalyzeErrorCode)) {
      const view = describeError({ code, message: ANALYZE_ERROR_MESSAGES[code] });
      expect(view.message).toBe(ANALYZE_ERROR_MESSAGES[code]);
      expect(typeof view.canRetry).toBe('boolean');
    }
    expect(
      describeError({ code: AnalyzeErrorCode.UnsupportedProtocol, message: 'x' }).canRetry,
    ).toBe(false);
    expect(describeError({ code: AnalyzeErrorCode.Network, message: 'x' }).canRetry).toBe(true);
    expect(describeError({ code: LocalErrorCode.SourceChanged, message: 'x' }).canRetry).toBe(true);
  });

  it('tells a person only that Auto Split is at capacity: no wait, count, cost or limit', () => {
    const view = describeError({
      code: AnalyzeErrorCode.AtCapacity,
      message: ANALYZE_ERROR_MESSAGES[AnalyzeErrorCode.AtCapacity],
      retryAfterSeconds: 600,
    });
    expect(view.message).toBe('Auto Split is temporarily at capacity. Try again later.');
    expect(view.canRetry).toBe(true);
    expect(view.detail).toBe('Repair and Manual Split are not affected.');
    expect(`${view.message} ${view.detail ?? ''}`).not.toMatch(
      /\d|minute|second|hour|limit|cost|\$|token/i,
    );
  });

  it('turns a retry delay into words', () => {
    expect(
      describeError({ code: AnalyzeErrorCode.RateLimited, message: 'x', retryAfterSeconds: 45 })
        .detail,
    ).toBe('Try again in about 45 seconds.');
    expect(
      describeError({ code: AnalyzeErrorCode.RateLimited, message: 'x', retryAfterSeconds: 1800 })
        .detail,
    ).toBe('Try again in about 30 minutes.');
    expect(
      describeError({ code: AnalyzeErrorCode.RateLimited, message: 'x', retryAfterSeconds: 60 })
        .detail,
    ).toBe('Try again in about 60 seconds.');
  });
});
