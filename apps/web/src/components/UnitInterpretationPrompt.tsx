import { useId, type ReactNode } from 'react';
import { UNIT_CHOICES } from '../state/conversion-presentation';
import { UNIT_INTERPRETATION_COPY, unitWord } from '../state/unit-interpretation';
import { useUnitInterpretation } from '../state/use-unit-interpretation';

/**
 * Asks how a unitless model's dimensions should be READ (PYBRIX-08A).
 *
 * Shown only for a document whose file states no unit. Nothing is preselected,
 * and nothing is guessed from the model's size: a value appears selected only
 * after the user chose it. Choosing rescales nothing — the note says so.
 *
 * ONE STATEMENT, SHARED: Split connectors, Surface Texture and Convert all read
 * the same answer, so this renders the same control wherever it is needed.
 */
export function UnitInterpretationPrompt({
  reason,
  testId = 'unit-interpretation',
}: {
  /** Why this workspace asks: what it cannot do until the answer is known. */
  readonly reason: string;
  readonly testId?: string;
}): ReactNode {
  const { unit, canChoose, choose } = useUnitInterpretation();
  const headingId = useId();
  if (!canChoose) return null;
  return (
    <fieldset className="format-options__field unit-chooser" data-testid={testId}>
      <legend className="format-options__label" id={headingId}>
        {UNIT_INTERPRETATION_COPY.groupLabel}
      </legend>
      <p className="format-options__value">
        {unit === undefined
          ? UNIT_INTERPRETATION_COPY.heading
          : `Reading dimensions as ${unitWord(unit).toLowerCase()}`}
      </p>
      <p className="convert-workspace__note" data-testid={`${testId}-reason`}>
        {unit === undefined ? `${reason} ${UNIT_INTERPRETATION_COPY.question}` : reason}
      </p>
      <div className="unit-chooser__options" role="radiogroup" aria-labelledby={headingId}>
        {UNIT_CHOICES.map((choice) => (
          <label
            key={choice.value}
            className="unit-chooser__option"
            data-selected={unit === choice.value ? 'true' : 'false'}
            title={choice.label}
          >
            <input
              type="radio"
              name={`${testId}-unit`}
              className="unit-chooser__input"
              value={choice.value}
              checked={unit === choice.value}
              aria-label={choice.label}
              onChange={() => {
                choose(choice.value);
              }}
              data-testid={`${testId}-${choice.value}`}
            />
            <span aria-hidden="true">{choice.symbol}</span>
          </label>
        ))}
      </div>
      <p className="convert-workspace__note">{UNIT_INTERPRETATION_COPY.note}</p>
    </fieldset>
  );
}
