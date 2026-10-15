import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import {
  AUTO_SPLIT_COPY,
  MODEL_KIND_ORDER,
  describeModelKind,
  describeReason,
  describeScope,
  describeSemanticUnavailable,
} from '../state/auto-split-presentation';
import { SuggestionOperation } from '@cadfixer/auto-split';
import { AutoSplitPhase, ModelKind } from '../state/auto-split-session';
import type { AutoSplitControls, AutoSplitRow, SplitTab } from '../state/use-auto-split';
import { Icon } from './shell/Icon';
import { PanelSection } from './shell/primitives';
import { ResourceRefusalCard, TooDetailedCard } from './SplitSizeNoticeCard';

/**
 * AUTO SPLIT — PRESENTATION of `useAutoSplit`.
 *
 * It decides nothing. Every sentence comes from `auto-split-presentation.ts`, every state from the
 * controller, and the only things a button here can do are the controller's: choose a model type,
 * accept the disclosure, find parts, cancel, show a suggestion, load one into Manual Split's own
 * controls and ask for its preview. Nothing here applies a split: Apply is the manual footer's.
 *
 * ACCESSIBLE WITHOUT COLOUR. A status is a word beside an icon, never a tint alone; the progress
 * region is a polite live region that is written only when its sentence changes; focus moves to the
 * heading of whatever replaces the control the user just used (the disclosure, an error), and keyboard
 * order follows reading order.
 */

export function SplitModeTabs({
  tab,
  onTab,
}: {
  readonly tab: SplitTab;
  readonly onTab: (tab: SplitTab) => void;
}): ReactNode {
  const refs = useRef<Record<SplitTab, HTMLButtonElement | null>>({ auto: null, manual: null });
  const order: readonly SplitTab[] = ['auto', 'manual'];
  const onKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = order.indexOf(tab);
    let next: SplitTab | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = order[(index + 1) % 2];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = order[(index + 1) % 2];
    else if (event.key === 'Home') next = 'auto';
    else if (event.key === 'End') next = 'manual';
    if (next === undefined) return;
    event.preventDefault();
    onTab(next);
    refs.current[next]?.focus();
  };
  const tabs: readonly { id: SplitTab; label: string }[] = [
    { id: 'auto', label: AUTO_SPLIT_COPY.autoTab },
    { id: 'manual', label: AUTO_SPLIT_COPY.manualTab },
  ];
  return (
    <div
      className="split-mode-tabs"
      role="tablist"
      aria-label={AUTO_SPLIT_COPY.tabsLabel}
      data-testid="split-mode-tabs"
    >
      {tabs.map((entry) => (
        <button
          key={entry.id}
          ref={(node) => {
            refs.current[entry.id] = node;
          }}
          type="button"
          role="tab"
          id={`split-tab-${entry.id}`}
          aria-selected={tab === entry.id}
          aria-controls={`split-tabpanel-${entry.id}`}
          tabIndex={tab === entry.id ? 0 : -1}
          className="split-mode-tabs__tab"
          onClick={() => {
            onTab(entry.id);
          }}
          onKeyDown={onKey}
          data-testid={`split-tab-${entry.id}`}
        >
          {entry.label}
          {entry.id === 'auto' ? (
            <span className="beta-badge" data-testid="auto-beta-badge">
              {AUTO_SPLIT_COPY.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The Auto Split sections. `editor` is Manual Split's own plane and connector controls, shown here when
 * a CUT suggestion is selected: editing a suggestion is editing the manual plane, so there is no second
 * editor to drift from the first.
 */
export function AutoSplitSections({
  auto,
  hasPart,
  onOpenManual,
  editor,
}: {
  readonly auto: AutoSplitControls;
  readonly hasPart: boolean;
  readonly onOpenManual: () => void;
  readonly editor: ReactNode;
}): ReactNode {
  const editorRef = useRef<HTMLDivElement>(null);
  /** An element id to focus once it exists: where focus goes when the disclosure closes. */
  const focusAfter = useRef<string | undefined>(undefined);
  const selectedId = auto.selected?.id;
  // Choosing a cut to edit brings the manual controls that edit it into view: they sit below the list,
  // and a person who pressed Edit should not have to find them.
  useEffect(() => {
    const node = editorRef.current;
    if (selectedId !== undefined && node !== null && typeof node.scrollIntoView === 'function')
      node.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);
  // Runs after every render, and only acts when a close has asked for focus and the target now exists.
  useEffect(() => {
    const id = focusAfter.current;
    if (id === undefined) return;
    const target = document.getElementById(id);
    if (target === null) return;
    focusAfter.current = undefined;
    target.focus();
  });
  if (!hasPart)
    return (
      <PanelSection title={AUTO_SPLIT_COPY.name} testId="auto-split-panel">
        <p className="panel__empty" data-testid="auto-empty">
          {AUTO_SPLIT_COPY.noModel}
        </p>
      </PanelSection>
    );
  const showKinds = !auto.busy && !auto.hasResult && auto.error === undefined;
  return (
    <>
      {showKinds ? (
        <PanelSection title="Split model" testId="auto-split-panel">
          {auto.tooDetailed === undefined ? (
            <KindChoice auto={auto} disabled={auto.busy} compact={false} />
          ) : (
            <TooDetailedCard
              tool="Auto Split"
              notice={auto.tooDetailed}
              testId="auto-too-detailed"
            />
          )}
          {auto.kind === ModelKind.Other ? <OtherKind onOpenManual={onOpenManual} /> : null}
          {auto.tooDetailed === undefined && auto.needsDisclosure ? (
            <Disclosure
              auto={auto}
              onAccepted={() => {
                focusAfter.current = 'auto-analyze';
              }}
            />
          ) : null}
          <Start auto={auto} />
        </PanelSection>
      ) : null}
      <Progress auto={auto} />
      <Failure auto={auto} />
      <Results auto={auto} />
      {!auto.busy ? (
        <PanelSection title="Details" defaultOpen={false} testId="auto-details">
          {auto.tooDetailed === undefined && !showKinds ? (
            <KindChoice auto={auto} disabled={auto.busy} compact={true} />
          ) : null}
          <p data-testid="auto-part">{auto.partLabel}</p>
          <p data-testid="auto-tagline">{AUTO_SPLIT_COPY.tagline}</p>
          <p>{auto.statusText}</p>
          {auto.planeApproximate ? (
            <p data-testid="auto-approximate">{AUTO_SPLIT_COPY.approximateCut}</p>
          ) : null}
          {auto.appliedSinceAnalysis ? <p>{AUTO_SPLIT_COPY.afterApply}</p> : null}
        </PanelSection>
      ) : null}
      {auto.selected?.operation === SuggestionOperation.Component ? (
        <Components auto={auto} />
      ) : null}
      {auto.selected?.operation === SuggestionOperation.Plane ? (
        <PanelSection title="Adjust cut" defaultOpen={false}>
          <div ref={editorRef}>{editor}</div>
        </PanelSection>
      ) : null}
      {auto.cutNeedsMoreRoom ? <ResourceRefusalCard testId="auto-needs-room" /> : null}
    </>
  );
}

/* ------------------------------------------------------------ model kind -- */

function KindChoice({
  auto,
  disabled,
  compact,
}: {
  readonly auto: AutoSplitControls;
  readonly disabled: boolean;
  readonly compact: boolean;
}): ReactNode {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="auto-kinds" data-compact={compact ? 'true' : 'false'}>
      <p className="format-options__label" id={labelId}>
        {AUTO_SPLIT_COPY.kindHeading}
      </p>
      <div
        className="auto-kinds__chips"
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={hintId}
      >
        {MODEL_KIND_ORDER.map((kind) => (
          <label
            key={kind}
            className="auto-chip"
            data-selected={auto.kind === kind ? 'true' : 'false'}
            data-disabled={disabled ? 'true' : 'false'}
          >
            <input
              type="radio"
              name="auto-split-kind"
              className="auto-chip__input"
              value={kind}
              checked={auto.kind === kind}
              disabled={disabled}
              onChange={() => {
                auto.chooseKind(kind);
              }}
              data-testid={`auto-kind-${kind}`}
            />
            <span className="auto-chip__label">{describeModelKind(kind)}</span>
          </label>
        ))}
      </div>
      <p className="auto-kinds__hint" id={hintId}>
        {auto.kind === undefined || auto.kind === ModelKind.Other
          ? AUTO_SPLIT_COPY.kindHint
          : describeScope(auto.kind)}
      </p>
    </div>
  );
}

function OtherKind({ onOpenManual }: { readonly onOpenManual: () => void }): ReactNode {
  return (
    <div className="auto-card" data-testid="auto-other">
      <p className="auto-card__title">{AUTO_SPLIT_COPY.otherHeading}</p>
      <p className="auto-card__body">{AUTO_SPLIT_COPY.otherBody}</p>
      <button
        type="button"
        className="primary-action auto-card__action"
        onClick={onOpenManual}
        data-testid="auto-open-manual"
      >
        {AUTO_SPLIT_COPY.openManual}
      </button>
    </div>
  );
}

/* ---------------------------------------------------------- disclosure -- */

function Disclosure({
  auto,
  onAccepted,
}: {
  readonly auto: AutoSplitControls;
  readonly onAccepted: () => void;
}): ReactNode {
  const headingId = useId();
  const bodyId = useId();
  const heading = useRef<HTMLParagraphElement>(null);
  // Focus lands on the disclosure when it appears, so a keyboard or screen-reader user meets it
  // before anything that would send data.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div
      className="auto-card auto-card--disclosure"
      role="group"
      aria-labelledby={headingId}
      aria-describedby={bodyId}
      data-testid="auto-disclosure"
    >
      <p className="auto-card__title" id={headingId} tabIndex={-1} ref={heading}>
        {AUTO_SPLIT_COPY.disclosureHeading}
      </p>
      <p className="auto-card__body" id={bodyId} data-testid="auto-disclosure-text">
        {AUTO_SPLIT_COPY.disclosure}
      </p>
      <div className="auto-card__actions">
        <button
          type="button"
          className="secondary-action"
          onClick={() => {
            auto.declineDisclosure();
            // Cancel leaves for Manual Split: its tab is always on screen, so focus can go there now.
            document.getElementById('split-tab-manual')?.focus();
          }}
          data-testid="auto-disclosure-cancel"
        >
          {AUTO_SPLIT_COPY.disclosureCancel}
        </button>
        <button
          type="button"
          className="primary-action auto-card__primary"
          onClick={() => {
            onAccepted();
            auto.acceptDisclosure();
          }}
          data-testid="auto-disclosure-continue"
        >
          {AUTO_SPLIT_COPY.disclosureContinue}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- start -- */

function Start({ auto }: { readonly auto: AutoSplitControls }): ReactNode {
  const ready =
    auto.tooDetailed === undefined &&
    auto.kind !== undefined &&
    auto.kind !== ModelKind.Other &&
    !auto.needsDisclosure &&
    !auto.busy &&
    !auto.hasResult &&
    auto.error === undefined;
  if (!ready) return null;
  return (
    <div className="auto-start">
      {auto.phase === AutoSplitPhase.Cancelled ? (
        <p className="convert-workspace__note" role="status" data-testid="auto-cancelled">
          {auto.statusText}
        </p>
      ) : null}
      <button
        type="button"
        id="auto-analyze"
        className="primary-action auto-start__button"
        disabled={!auto.canAnalyze}
        onClick={auto.analyze}
        data-testid="auto-analyze"
      >
        <Icon name="scan" size={16} />
        <span>{AUTO_SPLIT_COPY.analyze}</span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ progress -- */

function Progress({ auto }: { readonly auto: AutoSplitControls }): ReactNode {
  if (!auto.busy) return null;
  return (
    <div className="auto-progress" data-testid="auto-progress" aria-busy="true">
      {/* A polite live region, written when the phase sentence changes, never per tick. */}
      <p className="auto-progress__line" role="status" aria-live="polite" data-testid="auto-status">
        <Icon name="loader" size={14} className="spin" />
        <span>{auto.statusText}</span>
      </p>
      <p className="auto-progress__hint">{AUTO_SPLIT_COPY.waitHint}</p>
      {auto.cancellable ? (
        <button
          type="button"
          className="secondary-action auto-progress__cancel"
          onClick={auto.cancel}
          data-testid="auto-cancel"
        >
          {AUTO_SPLIT_COPY.cancel}
        </button>
      ) : (
        // A control that cannot stop the work is not shown as one: the step is named and left to finish.
        <p className="auto-progress__hint" data-testid="auto-cancel-unavailable">
          {AUTO_SPLIT_COPY.cancelUnavailable}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- failure -- */

function Failure({ auto }: { readonly auto: AutoSplitControls }): ReactNode {
  const heading = useRef<HTMLParagraphElement>(null);
  const message = auto.error?.message;
  useEffect(() => {
    if (message !== undefined) heading.current?.focus();
  }, [message]);
  if (auto.error === undefined) return null;
  return (
    <div className="auto-card auto-card--failure" role="alert" data-testid="auto-error">
      <p className="auto-card__title" tabIndex={-1} ref={heading} data-testid="auto-error-message">
        {auto.error.message}
      </p>
      {auto.error.detail === undefined ? null : (
        <PanelSection title="Details" defaultOpen={false}>
          <p className="auto-card__body" data-testid="auto-error-detail">
            {auto.error.detail}
          </p>
        </PanelSection>
      )}
      <div className="auto-card__actions">
        <button
          type="button"
          className="secondary-action"
          onClick={auto.reset}
          data-testid="auto-start-over"
        >
          {AUTO_SPLIT_COPY.startOver}
        </button>
        {auto.error.canRetry ? (
          <button
            type="button"
            className="primary-action auto-card__primary"
            onClick={auto.reanalyze}
            data-testid="auto-try-again"
          >
            {AUTO_SPLIT_COPY.tryAgain}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- results -- */

function Results({ auto }: { readonly auto: AutoSplitControls }): ReactNode {
  if (!auto.hasResult) return null;
  return (
    <PanelSection
      title={AUTO_SPLIT_COPY.resultsHeading}
      meta={String(auto.rows.length)}
      testId="auto-results"
    >
      {auto.objectLabel ? <p>{auto.objectLabel}</p> : null}
      {auto.rows.some((row) => row.suggestion.importance !== undefined) ? <p>Major parts</p> : null}
      {auto.stale ? (
        <div className="auto-card auto-card--stale" role="status" data-testid="auto-stale">
          <p className="auto-card__body">The model changed. Find parts again to continue.</p>
          <button
            type="button"
            className="primary-action auto-card__action"
            disabled={!auto.canAnalyze}
            onClick={auto.reanalyze}
            data-testid="auto-reanalyze"
          >
            {AUTO_SPLIT_COPY.reanalyze}
          </button>
        </div>
      ) : null}
      {auto.rows.length === 0 ? (
        <p className="panel__empty" data-testid="auto-none">
          {AUTO_SPLIT_COPY.noSuggestions}
        </p>
      ) : (
        <>
          <ul className="auto-list" aria-label={AUTO_SPLIT_COPY.resultsHeading}>
            {auto.rows
              .filter(
                (row) =>
                  row.suggestion.importance === undefined ||
                  (row.suggestion.importance === 'major' && row.suggestion.parentId === null),
              )
              .sort((a, b) =>
                a.suggestion.importance === undefined || b.suggestion.importance === undefined
                  ? 0
                  : Number(b.executable) - Number(a.executable) ||
                    (b.suggestion.semanticConfidence ?? 0) -
                      (a.suggestion.semanticConfidence ?? 0) ||
                    (b.suggestion.geometryConfidence ?? 0) -
                      (a.suggestion.geometryConfidence ?? 0) ||
                    (b.sizeScore ?? 0) - (a.sizeScore ?? 0),
              )
              .slice(0, 8)
              .map((row) => (
                <SemanticRow key={row.id} row={row} auto={auto} depth={0} />
              ))}
          </ul>
          {auto.rows.some(
            (row) => row.suggestion.importance === 'detail' && row.suggestion.parentId === null,
          ) ? (
            <details data-testid="auto-more-parts">
              <summary>More parts</summary>
              <ul className="auto-list">
                {auto.rows
                  .filter(
                    (row) =>
                      row.suggestion.importance === 'detail' && row.suggestion.parentId === null,
                  )
                  .map((row) => (
                    <SemanticRow key={row.id} row={row} auto={auto} depth={0} />
                  ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      {!auto.stale ? (
        <button
          type="button"
          className="secondary-action auto-card__action"
          disabled={!auto.canAnalyze}
          onClick={auto.reanalyze}
          data-testid="auto-reanalyze-fresh"
        >
          {AUTO_SPLIT_COPY.reanalyze}
        </button>
      ) : null}
    </PanelSection>
  );
}

function SemanticRow({
  row,
  auto,
  depth,
}: {
  readonly row: AutoSplitRow;
  readonly auto: AutoSplitControls;
  readonly depth: number;
}): ReactNode {
  const children =
    depth < 3 ? auto.rows.filter((child) => child.suggestion.parentId === row.id) : [];
  return (
    <Row row={row} auto={auto}>
      {children.length > 0 ? (
        <details>
          <summary>Show parts</summary>
          <ul className="auto-list">
            {children.map((child) => (
              <SemanticRow key={child.id} row={child} auto={auto} depth={depth + 1} />
            ))}
          </ul>
        </details>
      ) : null}
    </Row>
  );
}

function Row({
  row,
  auto,
  children,
}: {
  readonly row: AutoSplitRow;
  readonly auto: AutoSplitControls;
  readonly children?: ReactNode;
}): ReactNode {
  const reasonId = useId();
  const canToggle = !auto.stale && row.suggestion.operation !== SuggestionOperation.None;
  return (
    <li
      className="auto-row"
      data-selected={row.selected ? 'true' : 'false'}
      data-tone={row.status.tone}
      data-testid={`auto-row-${row.id}`}
    >
      <div className="auto-row__head">
        <span className="auto-row__name" data-testid={`auto-row-name-${row.id}`}>
          {row.label}
          {(row.suggestion.instanceCount ?? 1) > 1
            ? ` (${String(row.suggestion.instanceCount)})`
            : null}
        </span>
      </div>
      <p className="auto-row__status" data-testid={`auto-row-status-${row.id}`}>
        {auto.stale
          ? 'Find parts again'
          : row.selected && auto.unsafeCut
            ? "Can't split this area safely"
            : row.selected && auto.checkingCut
              ? 'Checking cut…'
              : row.suggestion.family === 'semantic' && row.suggestion.quality === 'READY'
                ? 'Ready'
                : row.executable || row.suggestion.quality === 'SUGGESTED'
                  ? 'Suggested cut'
                  : row.suggestion.family === 'semantic' &&
                      (row.suggestion.quality === 'RECOGNIZED_NOT_SEPARABLE' ||
                        row.suggestion.quality === 'LOW_CONFIDENCE')
                    ? describeSemanticUnavailable(row.suggestion.diagnostic)
                    : row.suggestion.quality === 'LOW_CONFIDENCE'
                      ? 'Needs a closer look'
                      : row.suggestion.quality === 'UNSAFE'
                        ? "Can't separate this safely"
                        : 'No separate part found'}
      </p>
      {children}
      <PanelSection title="Details" defaultOpen={false}>
        <p className="auto-row__reason" id={reasonId}>
          {row.suggestion.family === 'semantic' && !row.executable
            ? describeSemanticUnavailable(row.suggestion.diagnostic)
            : describeReason(row.suggestion.reason, auto.sourceReady)}
        </p>
        <p>
          {row.operationLabel} · {row.status.label}
        </p>

        <button
          type="button"
          className="auto-row__icon"
          aria-pressed={row.shown}
          aria-label={`${row.shown ? AUTO_SPLIT_COPY.hide : AUTO_SPLIT_COPY.show}: ${row.label}`}
          disabled={!canToggle || !row.executable}
          onClick={() => {
            auto.toggleShown(row.id);
          }}
          data-testid={`auto-show-${row.id}`}
        >
          <Icon name={row.shown ? 'target' : 'cube'} size={15} />
        </button>
        <button
          type="button"
          className="secondary-action auto-row__button"
          disabled={!row.executable}
          aria-describedby={reasonId}
          onClick={() => {
            auto.edit(row.id);
          }}
          data-testid={`auto-edit-${row.id}`}
        >
          {AUTO_SPLIT_COPY.edit}
        </button>
      </PanelSection>
      <div className="auto-row__actions">
        <button
          type="button"
          className={`${auto.selected?.operation !== SuggestionOperation.Component && row.id === auto.rows.find((candidate) => candidate.executable && !(candidate.selected && auto.unsafeCut))?.id ? 'primary-action' : 'secondary-action'} auto-row__button`}
          disabled={!row.executable || (row.selected && auto.unsafeCut)}
          aria-describedby={reasonId}
          onClick={() => {
            auto.preview(row.id);
          }}
          data-testid={`auto-preview-${row.id}`}
        >
          {AUTO_SPLIT_COPY.preview}
        </button>
      </div>
    </li>
  );
}

/* ---------------------------------------------------------- components -- */

function Components({ auto }: { readonly auto: AutoSplitControls }): ReactNode {
  const hintId = useId();
  const count = auto.components.filter((component) => component.selected).length;
  return (
    <PanelSection
      title={AUTO_SPLIT_COPY.componentsHeading}
      meta={String(count)}
      testId="auto-components"
      defaultOpen={auto.kind !== ModelKind.Automatic}
    >
      <p className="convert-workspace__note" id={hintId}>
        {AUTO_SPLIT_COPY.componentsHint}
      </p>
      <ul className="auto-list auto-list--components" aria-describedby={hintId}>
        {auto.components.map((component) => (
          <li key={component.rank} className="auto-component">
            <label className="auto-component__label">
              <input
                type="checkbox"
                checked={component.selected}
                onChange={() => {
                  auto.toggleComponent(component.rank);
                }}
                data-testid={`auto-component-${String(component.rank)}`}
              />
              <span>
                {component.label}
                <span className="auto-component__faces">
                  {` · ${component.faces.toLocaleString('en-US')} triangles`}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="primary-action auto-card__action"
        disabled={count === 0 || auto.rows.every((row) => !row.executable)}
        onClick={auto.previewSelection}
        data-testid="auto-preview-selection"
      >
        {AUTO_SPLIT_COPY.previewSelection}
      </button>
      <p className="auto-start__note">{AUTO_SPLIT_COPY.componentsNoConnectors}</p>
    </PanelSection>
  );
}
