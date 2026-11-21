import { useId, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { InfoButton, InfoPanel, useInfoDisclosure, type InfoSections } from './info';

/**
 * Presentation primitives for the application shell.
 *
 * PRESENTATION ONLY, like every component: none of these holds workspace state,
 * reads the store or knows what a mesh is. Each renders a real native control —
 * a `<button>`, a `<dl>` — so keyboard behaviour and accessible names come from
 * the platform rather than from re-implemented ARIA.
 */

/* --------------------------------------------------------- icon button -- */

export interface IconButtonProps {
  /** The accessible name, and the tooltip. Required: an icon is not a label. */
  readonly label: string;
  readonly icon: IconName;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  /** Present for toggles only; a plain action must not announce a pressed state. */
  readonly pressed?: boolean;
  /** Where the tooltip opens relative to the control. */
  readonly tooltip?: 'below' | 'above' | 'right' | 'left';
  readonly className?: string;
  readonly iconSize?: number;
  readonly testId?: string;
  /** Visible text beside the icon. The accessible name is still `label`. */
  readonly text?: string;
  readonly expanded?: boolean;
  readonly controls?: string;
}

export function IconButton({
  label,
  icon,
  onClick,
  disabled = false,
  pressed,
  tooltip = 'below',
  className,
  iconSize = 16,
  testId,
  text,
  expanded,
  controls,
}: IconButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={className === undefined ? 'icon-btn' : `icon-btn ${className}`}
      aria-label={label}
      data-tooltip={label}
      data-tooltip-side={tooltip}
      disabled={disabled}
      onClick={onClick}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      {...(controls === undefined ? {} : { 'aria-controls': controls })}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <Icon name={icon} size={iconSize} />
      {text === undefined ? null : <span className="icon-btn__text">{text}</span>}
    </button>
  );
}

/* ------------------------------------------------------ panel section -- */

export interface PanelSectionProps {
  readonly title: string;
  readonly children: ReactNode;
  /** Short trailing text in the header, such as a count. */
  readonly meta?: ReactNode;
  readonly defaultOpen?: boolean;
  /**
   * CONTROLLED OPEN STATE, for a section whose owner outlives it. A section that unmounts while its owner stays (a connector editor whose
   * content is absent while a list is read) would come back collapsed; the owner then keeps the state and passes it here, with the
   * change to make when the toggle is pressed. Without both, the section keeps its own.
   */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly testId?: string;
  /**
   * An explanation behind an ⓘ beside the heading. The button sits OUTSIDE the
   * collapse toggle, so asking what a section means never opens or closes it.
   */
  readonly info?: InfoSections;
}

/**
 * A collapsible section with a heading.
 *
 * THE BODY STAYS MOUNTED WHEN COLLAPSED. Several panels this wraps own hooks
 * that start, track and release worker operations; unmounting them to hide a
 * section would cancel a running analysis or discard a validated candidate as a
 * side effect of tidying the screen. `hidden` removes the body from layout and
 * from the accessibility tree without ending anything.
 */
export function PanelSection({
  title,
  children,
  meta,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  testId,
  info,
}: PanelSectionProps): ReactNode {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const open = controlledOpen ?? ownOpen;
  const bodyId = useId();
  const infoDisclosure = useInfoDisclosure();

  return (
    <section
      className="panel-section"
      aria-label={title}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <h2 className="panel-section__heading">
        <button
          type="button"
          className="panel-section__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            if (onOpenChange === undefined) setOwnOpen((current) => !current);
            else onOpenChange(!open);
          }}
        >
          <Icon
            name={open ? 'chev-down' : 'chev-right'}
            size={14}
            className="panel-section__chevron"
          />
          <span className="panel-section__title">{title}</span>
          {meta === undefined ? null : <span className="panel-section__meta">{meta}</span>}
        </button>
        {info === undefined ? null : (
          <InfoButton
            disclosure={infoDisclosure}
            label={title}
            {...(testId === undefined ? {} : { testId: `${testId}-info` })}
          />
        )}
      </h2>
      {info === undefined ? null : (
        <InfoPanel
          disclosure={infoDisclosure}
          label={title}
          info={info}
          {...(testId === undefined ? {} : { testId: `${testId}-info-panel` })}
        />
      )}
      <div className="panel-section__body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/* --------------------------------------------------- workspace header -- */

export interface WorkspaceHeaderProps {
  readonly icon: IconName;
  readonly name: string;
  readonly description: string;
}

export function WorkspaceHeader({ icon, name, description }: WorkspaceHeaderProps): ReactNode {
  return (
    <header className="workspace-header" data-testid="workspace-header">
      <span className="workspace-header__icon">
        <Icon name={icon} size={16} />
      </span>
      <div className="workspace-header__text">
        <p className="workspace-header__name">{name}</p>
        {/* One line with an ellipsis; the full sentence is the tooltip and
            stays in the accessibility tree, so truncation hides nothing. */}
        <p className="workspace-header__description" title={description}>
          {description}
        </p>
      </div>
    </header>
  );
}

/* ---------------------------------------------------- property rows -- */

export interface PropertyRowProps {
  readonly label: string;
  readonly value: ReactNode;
  /** Numbers and measurements are set in the monospace face. */
  readonly mono?: boolean;
  readonly testId?: string;
}

/** One label/value pair. Must be placed inside a `<dl className="property-grid">`. */
export function PropertyRow({ label, value, mono = true, testId }: PropertyRowProps): ReactNode {
  return (
    <div className="property-row">
      <dt className="property-row__label">{label}</dt>
      <dd
        className={mono ? 'property-row__value property-row__value--mono' : 'property-row__value'}
        {...(testId === undefined ? {} : { 'data-testid': testId })}
      >
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------ segmented control -- */

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly testId?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Names the group for assistive technology. */
  readonly label: string;
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}

/**
 * Mutually exclusive choices as a row of pressed/unpressed buttons.
 *
 * Buttons with `aria-pressed` rather than a radio group: each option is an
 * action the user takes ("show the proposed result"), and a toggle button is
 * what a screen reader user expects to find for that.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SegmentedControlProps<T>): ReactNode {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__option"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => {
            onChange(option.value);
          }}
          {...(option.testId === undefined ? {} : { 'data-testid': option.testId })}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------ compact switch -- */

export interface CompactSwitchProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly testId?: string;
}

/** A labelled on/off switch built on a native checkbox, so it is a real form control. */
export function CompactSwitch({ label, checked, onChange, testId }: CompactSwitchProps): ReactNode {
  return (
    <label className="switch">
      <span className="switch__label">{label}</span>
      <input
        type="checkbox"
        role="switch"
        className="switch__input"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        {...(testId === undefined ? {} : { 'data-testid': testId })}
      />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
    </label>
  );
}
