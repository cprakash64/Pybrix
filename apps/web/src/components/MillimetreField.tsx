import { useId, type ReactNode } from 'react';
import { NumberField } from './shell/number-field';

/**
 * A labelled size in millimetres, committed on blur or Enter and held to the physical range every connector dimension is judged in
 * (0.01 to 1000 mm, or 0 to 1000 where zero is allowed). Shared by the split's connector settings and the connector editor, so one
 * size reads and is limited the same wherever it is typed.
 */
export function MillimetreField({
  label,
  value,
  step = 0.1,
  allowZero = false,
  disabled,
  onCommit,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly step?: number;
  readonly allowZero?: boolean;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
  readonly testId: string;
}): ReactNode {
  const id = useId();
  return (
    <div className="split-params__field">
      <label className="split-params__label" htmlFor={id}>
        {label}
      </label>
      <NumberField
        id={id}
        label={`${label}, millimetres`}
        value={value}
        min={allowZero ? 0 : 0.01}
        max={1000}
        step={step}
        suffix="mm"
        disabled={disabled}
        onCommit={onCommit}
        testId={testId}
      />
    </div>
  );
}
