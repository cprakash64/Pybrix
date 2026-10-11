import type { ReactNode } from 'react';
import {
  describeTooDetailed,
  RESOURCE_REFUSAL_COPY,
  type SplitSizeNotice,
  type SplitToolName,
} from '../state/split-size-presentation';

/**
 * A MODEL TOO DETAILED TO SPLIT, as a NEUTRAL STATUS.
 *
 * It is `role="status"`, not `role="alert"`, and it has no "Try again": the part's triangle count is a
 * fact and the supported ceiling a constant, so nothing the person does with this card can change the
 * answer. It reads as a decision the product has made, in the register of every other refusal, and
 * says what is true: the size, the limit, that the model is unchanged and nothing was sent.
 */
export function TooDetailedCard({
  tool,
  notice,
  testId,
}: {
  readonly tool: SplitToolName;
  readonly notice: SplitSizeNotice;
  readonly testId: string;
}): ReactNode {
  const copy = describeTooDetailed(tool, notice);
  return (
    <div className="auto-card auto-card--notice" role="status" data-testid={testId}>
      <p className="auto-card__title" data-testid={`${testId}-heading`}>
        {copy.heading}
      </p>
      <p className="auto-card__figure" data-testid={`${testId}-size`}>
        {copy.figure}
      </p>
      <p className="auto-card__body" data-testid={`${testId}-limit`}>
        {copy.limit}
      </p>
      <p className="auto-card__body" data-testid={`${testId}-unchanged`}>
        {copy.unchanged}
      </p>
      <p className="auto-card__body" data-testid={`${testId}-others`}>
        {copy.others}
      </p>
    </div>
  );
}

/** A split the worker declined for RESOURCES: a decision with a reason, in the same neutral register. */
export function ResourceRefusalCard({ testId }: { readonly testId: string }): ReactNode {
  return (
    <div className="auto-card auto-card--notice" role="status" data-testid={testId}>
      <p className="auto-card__title">{RESOURCE_REFUSAL_COPY.heading}</p>
      <p className="auto-card__body">{RESOURCE_REFUSAL_COPY.body}</p>
      <p className="auto-card__body">{RESOURCE_REFUSAL_COPY.others}</p>
    </div>
  );
}
