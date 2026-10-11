import { useId, useState, type ReactNode } from 'react';
import {
  CONNECTOR_OPTIONS,
  PIN_COUNTS,
  SPLIT_AXES,
  SPLIT_COPY,
  MAX_SPLIT_TILT_DEGREES,
  describeConnectorResult,
  describeCut,
  describeExportParts,
  describePlaneName,
  describePositionLabel,
  describeRollLabel,
  describeTiltLabel,
  dovetailSlot,
  formatLength,
  formatVolume,
  socketDiameter,
  type ConnectorKind,
  type SplitAxis,
  type SplitPieceView,
} from '../state/split-presentation';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useAutoSplitControls, useSplitControls } from '../state/workflow-controllers';
import {
  SplitExportState,
  SplitPhase,
  type ConnectorSettings,
  type SplitControls,
} from '../state/use-split-workflow';
import { AutoSplitSections, SplitModeTabs } from './AutoSplitPanel';
import { ResourceRefusalCard, TooDetailedCard } from './SplitSizeNoticeCard';
import { useOpenConvertWorkspace } from './shell/open-convert';
import {
  ActionFooter,
  ActionFooterLine,
  OutcomeAlert,
  WorkspaceOutcome,
  useRevealAtEnd,
} from './shell/action-footer';
import { UnitInterpretationPrompt } from './UnitInterpretationPrompt';
import { Icon } from './shell/Icon';
import { NumberField } from './shell/number-field';
import { PanelSection, SegmentedControl, type SegmentedOption } from './shell/primitives';

/**
 * THE SPLIT & CONNECT WORKSPACE — presentation of `useSplitControls`.
 *
 * EVERY CONTROL IS ONE THE ENGINE HONOURS. One flat plane per split (XY, XZ or
 * YZ, one tilt), automatic connector placement, round pins or one dovetail,
 * Preview → Apply → Undo. The reference's cut list, custom planes, eleven
 * connector types, manual placement, pattern and margin controls, bed fitting
 * and orientation have no engine behind them and are not drawn.
 *
 * Stays mounted while hidden, like the other workspaces; the controller it
 * reads lives in the app-level provider either way.
 */
export function SplitWorkspace(): ReactNode {
  const { model } = useWorkspaceState();
  const split = useSplitControls();
  const auto = useAutoSplitControls();
  /*
   * OWNED HERE — WORKSPACE-UX-03. The choice is made in the scrolling content
   * and acted on from the footer; when both lived in the footer the applied
   * state was 162 px tall inside a 140 px scroll area.
   */
  const [exportMode, setExportMode] = useState<ExportMode>('stl');

  return (
    <div className="convert-workspace split-workspace" data-testid="split-workspace">
      <div className="convert-workspace__sections">
        <SplitModeTabs tab={auto.tab} onTab={auto.setTab} />
        {model === undefined || split.part === undefined ? (
          <PanelSection title={SPLIT_COPY.planeSection}>
            <p className="panel__empty" data-testid="split-empty">
              {SPLIT_COPY.noPart}
            </p>
          </PanelSection>
        ) : auto.tab === 'manual' ? (
          <div role="tabpanel" id="split-tabpanel-manual" aria-labelledby="split-tab-manual">
            {split.sizeNotice === undefined ? null : (
              <TooDetailedCard
                tool="Manual Split"
                notice={split.sizeNotice}
                testId="split-too-detailed"
              />
            )}
            <CutPlaneSection split={split} />
            <ConnectorSection split={split} />
            <ResultSection split={split} />
            <ExportSection split={split} mode={exportMode} onMode={setExportMode} />
          </div>
        ) : (
          <div role="tabpanel" id="split-tabpanel-auto" aria-labelledby="split-tab-auto">
            <AutoSplitSections
              auto={auto}
              hasPart
              onOpenManual={() => {
                auto.setTab('manual');
              }}
              editor={
                <>
                  <CutPlaneSection split={split} />
                  <ConnectorSection split={split} />
                </>
              }
            />
            <ResultSection split={split} />
            <ExportSection split={split} mode={exportMode} onMode={setExportMode} />
          </div>
        )}
        <SplitOutcome split={split} />
      </div>
      <SplitFooter
        split={split}
        exportMode={exportMode}
        previewBlock={
          auto.tab === 'auto'
            ? auto.footerBlock
            : split.sizeNotice === undefined
              ? undefined
              : SPLIT_COPY.tooDetailedHint
        }
        {...(auto.tab === 'auto' && auto.busy && auto.cancellable
          ? { onCancelAnalysis: auto.cancel }
          : {})}
      />
    </div>
  );
}

const busy = (split: SplitControls): boolean =>
  split.phase === SplitPhase.Computing || split.phase === SplitPhase.Applying;

/* ------------------------------------------------------------ cut plane -- */

function CutPlaneSection({ split }: { readonly split: SplitControls }): ReactNode {
  const positionId = useId();
  const tiltId = useId();
  const rollId = useId();
  const part = split.part;
  if (part === undefined) return null;
  const axis = split.plane.axis;
  const disabled = busy(split);
  const step = (split.range.max - split.range.min) / 200 || 0.01;
  const suffix = unitSuffix(split.unit);
  const suffixProp = suffix === undefined ? {} : { suffix };
  const planeOptions: readonly SegmentedOption<SplitAxis>[] = SPLIT_AXES.map((value) => ({
    value,
    label: describePlaneName(value),
    testId: `split-plane-${describePlaneName(value).toLowerCase()}`,
  }));

  return (
    <PanelSection
      title={SPLIT_COPY.planeSection}
      meta={describePlaneName(axis)}
      testId="split-plane-section"
    >
      <p className="convert-workspace__note" data-testid="split-part">
        Cutting <strong className="split-workspace__part">{part.name ?? part.partId}</strong>
      </p>
      <SegmentedControl
        label={SPLIT_COPY.planeGroup}
        options={planeOptions}
        value={axis}
        onChange={split.setAxis}
        disabled={disabled}
      />

      <div className="split-field">
        <div className="split-field__label-row">
          <label className="format-options__label" htmlFor={positionId}>
            {describePositionLabel(axis)}
          </label>
          <span className="split-field__range" data-testid="split-position-range">
            {formatLength(split.range.min, split.unit)} –{' '}
            {formatLength(split.range.max, split.unit)}
          </span>
        </div>
        <div className="split-field__row">
          <input
            id={positionId}
            className="split-field__slider"
            type="range"
            min={split.range.min}
            max={split.range.max}
            step="any"
            value={split.offset}
            disabled={disabled}
            aria-valuetext={formatLength(split.offset, split.unit)}
            onChange={(event) => {
              split.setOffset(Number(event.target.value));
            }}
            data-testid="split-position-slider"
          />
          <NumberField
            label={`${describePositionLabel(axis)} value`}
            value={split.offset}
            min={split.range.min}
            max={split.range.max}
            step={step}
            {...suffixProp}
            disabled={disabled}
            onCommit={split.setOffset}
            testId="split-position-value"
          />
        </div>
      </div>

      <div className="split-field split-field--inline">
        <label className="format-options__label" htmlFor={tiltId}>
          {describeTiltLabel(axis)}
        </label>
        <NumberField
          id={tiltId}
          label={`${describeTiltLabel(axis)}, degrees`}
          value={split.plane.tilt}
          min={-MAX_SPLIT_TILT_DEGREES}
          max={MAX_SPLIT_TILT_DEGREES}
          step={1}
          suffix="°"
          disabled={disabled}
          onCommit={split.setTilt}
          testId="split-tilt"
        />
      </div>

      <div className="split-field split-field--inline">
        <label className="format-options__label" htmlFor={rollId}>
          {describeRollLabel(axis)}
        </label>
        <NumberField
          id={rollId}
          label={`${describeRollLabel(axis)}, degrees`}
          value={split.plane.roll}
          min={-MAX_SPLIT_TILT_DEGREES}
          max={MAX_SPLIT_TILT_DEGREES}
          step={1}
          suffix="°"
          disabled={disabled}
          onCommit={split.setRoll}
          testId="split-roll"
        />
      </div>

      <div className="split-workspace__plane-actions">
        <button
          type="button"
          className="secondary-action split-workspace__reset"
          onClick={split.resetPlane}
          disabled={disabled}
          data-testid="split-reset-plane"
        >
          <Icon name="home" size={14} />
          {SPLIT_COPY.resetPlane}
        </button>
        <button
          type="button"
          className="secondary-action split-workspace__flip"
          onClick={split.flipPlane}
          disabled={disabled}
          aria-pressed={split.plane.flipped}
          title={SPLIT_COPY.flipHint}
          data-testid="split-flip-plane"
        >
          {SPLIT_COPY.flipPlane}
        </button>
      </div>
      <p className="convert-workspace__note">{SPLIT_COPY.oneCut}</p>
    </PanelSection>
  );
}

const PIECE_VIEW_OPTIONS: readonly SegmentedOption<SplitPieceView>[] = [
  { value: 'both', label: 'Both', testId: 'split-view-both' },
  { value: 'a', label: 'Piece A', testId: 'split-view-a' },
  { value: 'b', label: 'Piece B', testId: 'split-view-b' },
];

/* ------------------------------------------------------------ connectors -- */

function ConnectorSection({ split }: { readonly split: SplitControls }): ReactNode {
  const noteId = useId();
  const disabled = busy(split);
  const connector = split.connector;
  return (
    <PanelSection
      title={SPLIT_COPY.connectorsSection}
      meta={SPLIT_COPY.connectorsMeta}
      testId="split-connectors"
    >
      <UnitInterpretationPrompt
        reason="Connector sizes are physical, so Pybrix needs to know what this model’s numbers mean."
        testId="split-unit-interpretation"
      />
      <div
        className="connector-grid"
        role="radiogroup"
        aria-label={SPLIT_COPY.connectorsGroup}
        {...(split.connectorsAvailable ? {} : { 'aria-describedby': noteId })}
      >
        {CONNECTOR_OPTIONS.map((option) => {
          const unavailable = option.kind !== 'none' && !split.connectorsAvailable;
          const selected = connector.kind === option.kind;
          return (
            <label
              key={option.kind}
              className="format-card connector-card"
              data-selected={selected ? 'true' : 'false'}
              data-unavailable={unavailable ? 'true' : 'false'}
            >
              <input
                type="radio"
                name="split-connector"
                className="format-card__input"
                value={option.kind}
                checked={selected}
                disabled={disabled || unavailable}
                aria-label={`${option.name}, ${option.detail.toLowerCase()}`}
                onChange={() => {
                  split.setConnector({ kind: option.kind });
                }}
                data-testid={`split-connector-${option.kind}`}
              />
              <ConnectorSchematic kind={option.kind} />
              <span className="format-card__name">{option.name}</span>
              <span className="format-card__variant">{option.detail}</span>
              {selected ? (
                <span className="format-card__check" aria-hidden="true">
                  <Icon name="ok" size={13} />
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {split.connectorsAvailable ? null : (
        <p className="convert-workspace__caution" id={noteId} data-testid="split-connectors-unit">
          {SPLIT_COPY.connectorsNeedMillimetres}
        </p>
      )}
      {connector.kind === 'none' ? null : (
        <ConnectorParameters split={split} connector={connector} disabled={disabled} />
      )}
      <p className="convert-workspace__note">{SPLIT_COPY.placementNote}</p>
    </PanelSection>
  );
}

/** A small line drawing of each connector as it sits across the cut. */
function ConnectorSchematic({ kind }: { readonly kind: ConnectorKind }): ReactNode {
  return (
    <svg className="connector-card__schematic" viewBox="0 0 48 24" aria-hidden="true">
      <line x1="2" y1="12" x2="46" y2="12" className="connector-card__cut" />
      {kind === 'pin' ? (
        <>
          <rect x="16" y="4" width="6" height="16" rx="1.5" className="connector-card__male" />
          <rect x="28" y="4" width="6" height="16" rx="1.5" className="connector-card__male" />
        </>
      ) : null}
      {kind === 'dovetail' ? (
        <path d="M18 12 L14 4 L34 4 L30 12 Z" className="connector-card__male" />
      ) : null}
    </svg>
  );
}

function ConnectorParameters({
  split,
  connector,
  disabled,
}: {
  readonly split: SplitControls;
  readonly connector: ConnectorSettings;
  readonly disabled: boolean;
}): ReactNode {
  const set = split.setConnector;
  const countOptions: readonly SegmentedOption<string>[] = PIN_COUNTS.map((count) => ({
    value: String(count),
    label: String(count),
    testId: `split-pin-count-${String(count)}`,
  }));
  const sideOptions: readonly SegmentedOption<'A' | 'B'>[] = [
    { value: 'A', label: SPLIT_COPY.pieceA, testId: 'split-male-a' },
    { value: 'B', label: SPLIT_COPY.pieceB, testId: 'split-male-b' },
  ];
  const angleOptions: readonly SegmentedOption<string>[] = [
    { value: '0', label: '0°', testId: 'split-dovetail-0' },
    { value: '90', label: '90°', testId: 'split-dovetail-90' },
  ];
  const slot = dovetailSlot(connector.dovetailWidth, connector.dovetailLength, connector.clearance);

  return (
    <div className="split-params" data-testid="split-connector-parameters">
      {connector.kind === 'pin' ? (
        <>
          <p className="format-options__label">Count per cut</p>
          <SegmentedControl
            label="Pin count"
            options={countOptions}
            value={String(connector.count)}
            onChange={(value) => {
              set({ count: Number(value) as 1 | 2 | 3 | 4 });
            }}
            disabled={disabled}
          />
          <div className="split-params__grid">
            <MillimetreField
              label="Pin diameter"
              value={connector.diameter}
              disabled={disabled}
              onCommit={(diameter) => {
                set({ diameter });
              }}
              testId="split-pin-diameter"
            />
            <MillimetreField
              label="Depth"
              value={connector.depth}
              disabled={disabled}
              onCommit={(depth) => {
                set({ depth });
              }}
              testId="split-depth"
            />
            <MillimetreField
              label="Clearance, per side"
              value={connector.clearance}
              step={0.05}
              allowZero
              disabled={disabled}
              onCommit={(clearance) => {
                set({ clearance });
              }}
              testId="split-clearance"
            />
          </div>
          <p className="split-params__derived" data-testid="split-socket-size">
            Pin Ø {formatNumber2(connector.diameter)} mm → socket Ø{' '}
            {formatNumber2(socketDiameter(connector.diameter, connector.clearance))} mm (radial
            clearance, applied once per side)
          </p>
        </>
      ) : (
        <>
          <div className="split-params__grid">
            <MillimetreField
              label="Width"
              value={connector.dovetailWidth}
              disabled={disabled}
              onCommit={(dovetailWidth) => {
                set({ dovetailWidth });
              }}
              testId="split-dovetail-width"
            />
            <MillimetreField
              label="Length"
              value={connector.dovetailLength}
              disabled={disabled}
              onCommit={(dovetailLength) => {
                set({ dovetailLength });
              }}
              testId="split-dovetail-length"
            />
            <MillimetreField
              label="Depth"
              value={connector.depth}
              disabled={disabled}
              onCommit={(depth) => {
                set({ depth });
              }}
              testId="split-depth"
            />
            <MillimetreField
              label="Clearance, per side"
              value={connector.clearance}
              step={0.05}
              allowZero
              disabled={disabled}
              onCommit={(clearance) => {
                set({ clearance });
              }}
              testId="split-clearance"
            />
          </div>
          <p className="split-params__derived" data-testid="split-slot-size">
            Slot {formatNumber2(slot.width)} × {formatNumber2(slot.length)} mm (each side grows by
            the clearance)
          </p>
          <p className="format-options__label">Orientation on the cut</p>
          <SegmentedControl
            label="Dovetail orientation"
            options={angleOptions}
            value={String(connector.dovetailAngle)}
            onChange={(value) => {
              set({ dovetailAngle: value === '90' ? 90 : 0 });
            }}
            disabled={disabled}
          />
        </>
      )}
      <p className="format-options__label">Male side</p>
      <SegmentedControl
        label="Male connector side"
        options={sideOptions}
        value={connector.maleSide}
        onChange={(maleSide) => {
          set({ maleSide });
        }}
        disabled={disabled}
      />
      {split.connectorProblem === undefined ? null : (
        <p className="convert-footer__failure" role="alert" data-testid="split-connector-problem">
          {split.connectorProblem}
        </p>
      )}
      <p className="convert-workspace__note">{SPLIT_COPY.fitNote}</p>
    </div>
  );
}

/** The document's unit symbol for a field suffix, or nothing when it states none. */
const unitSuffix = (unit: string | undefined): string | undefined => {
  const text = formatLength(0, unit);
  const space = text.indexOf(' ');
  return space < 0 ? undefined : text.slice(space + 1);
};

const formatNumber2 = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toFixed(2))) : '—';

function MillimetreField({
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

/* ---------------------------------------------------------------- result -- */

function ResultSection({ split }: { readonly split: SplitControls }): ReactNode {
  const { model } = useWorkspaceState();
  const preview = split.preview;
  const applied = split.applied;
  if (preview === undefined && applied === undefined) return null;
  const parts = preview?.parts ?? model?.parts ?? [];
  const aId = preview?.pieceAId ?? applied?.pieceA;
  const bId = preview?.pieceBId ?? applied?.pieceB;
  const metrics = preview?.metrics ?? applied?.metrics;
  const triangles = (id: string | undefined): string =>
    parts.find((candidate) => candidate.partId === id)?.triangleCount.toLocaleString() ?? '—';

  return (
    <PanelSection
      title={SPLIT_COPY.resultSection}
      meta={preview === undefined ? 'Applied' : 'Preview'}
      testId="split-result"
    >
      {preview === undefined ? null : (
        <>
          <p className="split-result__badge" data-testid="split-preview-label">
            {SPLIT_COPY.previewLabel}
          </p>
          <SegmentedControl
            label={SPLIT_COPY.viewGroup}
            options={PIECE_VIEW_OPTIONS}
            value={split.pieceView}
            onChange={split.setPieceView}
          />
        </>
      )}
      <dl className="property-grid">
        <div className="property-row">
          <dt className="property-row__label">
            <span className="piece-swatch piece-swatch--a" aria-hidden="true" />
            {SPLIT_COPY.pieceA}
          </dt>
          <dd className="property-row__value property-row__value--mono" data-testid="split-piece-a">
            {triangles(aId)} triangles
            {metrics === undefined
              ? ''
              : ` · ${formatVolume(metrics.pieceAFinalVolume, split.unit)}`}
          </dd>
        </div>
        <div className="property-row">
          <dt className="property-row__label">
            <span className="piece-swatch piece-swatch--b" aria-hidden="true" />
            {SPLIT_COPY.pieceB}
          </dt>
          <dd className="property-row__value property-row__value--mono" data-testid="split-piece-b">
            {triangles(bId)} triangles
            {metrics === undefined
              ? ''
              : ` · ${formatVolume(metrics.pieceBFinalVolume, split.unit)}`}
          </dd>
        </div>
        {preview === undefined ? null : (
          <>
            <div className="property-row">
              <dt className="property-row__label">Connector</dt>
              <dd className="property-row__value" data-testid="split-result-connector">
                {describeConnectorResult(preview.connector.kind)}
              </dd>
            </div>
            <div className="property-row">
              <dt className="property-row__label">Checks</dt>
              <dd className="property-row__value" data-testid="split-result-validation">
                {SPLIT_COPY.piecesValidated}
              </dd>
            </div>
            <div className="property-row">
              <dt className="property-row__label">Volume check</dt>
              <dd className="property-row__value property-row__value--mono">
                {(preview.metrics.volumeRelativeError * 100).toFixed(5)}% difference
              </dd>
            </div>
          </>
        )}
      </dl>
    </PanelSection>
  );
}

/* ---------------------------------------------------------------- export -- */

type ExportMode = 'stl' | '3mf';

/**
 * How the two pieces leave: a choice, so it scrolls with the other choices.
 * Shown once a split is applied, directly beneath the pieces it will write.
 */
function ExportSection({
  split,
  mode,
  onMode,
}: {
  readonly split: SplitControls;
  readonly mode: ExportMode;
  readonly onMode: (mode: ExportMode) => void;
}): ReactNode {
  const { model } = useWorkspaceState();
  const applied = split.applied !== undefined && split.phase === SplitPhase.Idle;
  const saved =
    split.exportMessage !== undefined && split.exportState === SplitExportState.Done
      ? split.exportMessage
      : undefined;
  // The export choice appears where the result just did; a saved file likewise.
  const ref = useRevealAtEnd<HTMLDivElement>(applied ? `applied${saved ?? ''}` : undefined);
  if (!applied) return null;
  const options: readonly SegmentedOption<ExportMode>[] = [
    { value: 'stl', label: SPLIT_COPY.exportStls, testId: 'split-export-stls' },
    { value: '3mf', label: SPLIT_COPY.exportThreeMf, testId: 'split-export-3mf' },
  ];
  return (
    <div ref={ref}>
      <PanelSection title={SPLIT_COPY.exportSection} testId="split-export-section">
        <SegmentedControl label="Export mode" options={options} value={mode} onChange={onMode} />
        <p className="split-footer__note" data-testid="split-export-note">
          {mode === 'stl'
            ? 'Each piece as its own binary STL, one download each.'
            : `One 3MF of the whole model — all ${String(model?.parts.length ?? 0)} parts — through Convert, which asks for a unit if the model states none.`}
        </p>
        {/* Announced once, when a file is written; never part of the footer. */}
        <div aria-live="polite">
          {saved === undefined ? null : (
            <p className="convert-footer__saved" data-testid="split-export-saved">
              <Icon name="ok" size={14} />
              <span>{saved}</span>
            </p>
          )}
        </div>
      </PanelSection>
    </div>
  );
}

/* --------------------------------------------------------------- outcome -- */

/** Every failure in full, at the end of the scrolling content. */
function SplitOutcome({ split }: { readonly split: SplitControls }): ReactNode {
  const exportFailure =
    split.exportState === SplitExportState.Failed ? split.exportMessage : undefined;
  const key = [split.error, exportFailure].filter((message) => message !== undefined).join('|');
  return (
    <WorkspaceOutcome revealKey={key === '' ? undefined : key}>
      {split.error === undefined ? null : split.errorIsResourceLimit ? (
        // A limit the worker enforces is a decision with a reason, not a defect: a status, not an alert.
        <ResourceRefusalCard testId="split-resource-limit" />
      ) : (
        <OutcomeAlert testId="split-error">{split.error} The model is unchanged.</OutcomeAlert>
      )}
      {exportFailure === undefined ? null : (
        <OutcomeAlert testId="split-export-failure">{exportFailure}</OutcomeAlert>
      )}
    </WorkspaceOutcome>
  );
}

/* ---------------------------------------------------------------- footer -- */

/**
 * The shared bounded action region: the action row and ONE line — progress,
 * else a failure's headline, else the preview state, else why the action is
 * unavailable. The pieces, the export choice and every message in full are in
 * the scrolling content above.
 */
function SplitFooter({
  split,
  exportMode,
  previewBlock,
  onCancelAnalysis,
}: {
  readonly split: SplitControls;
  readonly exportMode: ExportMode;
  /** While an Auto Split analysis runs, the footer's Cancel cancels THAT, not the whole split. */
  readonly onCancelAnalysis?: () => void;
  /** Why Preview cannot be asked for in the Auto Split tab, or undefined. Never blocks Apply or Undo. */
  readonly previewBlock: string | undefined;
}): ReactNode {
  const { model } = useWorkspaceState();
  const store = useWorkspaceStore();
  const openConvert = useOpenConvertWorkspace();
  const hintId = useId();
  const hasPart = model !== undefined && split.part !== undefined;
  const applied = split.applied;
  const piecesPresent =
    applied !== undefined &&
    model !== undefined &&
    model.parts.some((part) => part.partId === applied.pieceA) &&
    model.parts.some((part) => part.partId === applied.pieceB);
  const connectorBlocked =
    split.connector.kind !== 'none' &&
    (!split.connectorsAvailable || split.connectorProblem !== undefined);

  const previewBlocked = previewBlock !== undefined && split.phase === SplitPhase.Idle;
  const hint = !hasPart
    ? SPLIT_COPY.noPart
    : previewBlocked
      ? previewBlock
      : connectorBlocked
        ? (split.connectorProblem ?? SPLIT_COPY.connectorsNeedMillimetres)
        : undefined;
  const working = split.phase === SplitPhase.Computing || split.phase === SplitPhase.Applying;
  const failureLine =
    split.error !== undefined && !split.errorIsResourceLimit
      ? SPLIT_COPY.failedLine
      : split.exportState === SplitExportState.Failed && split.exportMessage !== undefined
        ? SPLIT_COPY.exportFailedLine
        : undefined;
  const line = working ? (
    <p className="split-footer__progress action-footer__line" data-testid="split-progress">
      <Icon name="loader" size={14} className="spin" />
      <span>{split.phase === SplitPhase.Applying ? SPLIT_COPY.applying : split.progress}</span>
    </p>
  ) : failureLine !== undefined ? (
    <ActionFooterLine tone="failure" testId="split-failure-line">
      {failureLine}
    </ActionFooterLine>
  ) : split.phase === SplitPhase.Preview ? (
    <ActionFooterLine testId="split-preview-ready" title={SPLIT_COPY.previewReady}>
      {SPLIT_COPY.previewReady}
    </ActionFooterLine>
  ) : undefined;

  return (
    <ActionFooter testId="split-footer" className="split-footer">
      <div className="convert-footer__status" aria-live="polite">
        {line}
      </div>

      {applied !== undefined && split.phase === SplitPhase.Idle ? (
        <div className="convert-footer__actions">
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={split.undo}
            data-testid="split-undo"
          >
            {SPLIT_COPY.undoButton}
          </button>
          <button
            type="button"
            className="primary-action convert-footer__primary"
            disabled={!piecesPresent || split.exportState === SplitExportState.Exporting}
            aria-busy={split.exportState === SplitExportState.Exporting}
            onClick={() => {
              if (exportMode === 'stl') {
                split.exportPieces();
                return;
              }
              store.setConversionTarget('3mf');
              openConvert();
            }}
            data-testid="split-export"
          >
            <Icon name="download" size={16} />
            <span>
              {exportMode === 'stl' ? describeExportParts(2) : SPLIT_COPY.exportThreeMfAction}
            </span>
          </button>
        </div>
      ) : (
        <div className="convert-footer__actions">
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={
              onCancelAnalysis ??
              (split.phase === SplitPhase.Preview ? split.discardPreview : split.cancel)
            }
            data-testid={
              onCancelAnalysis
                ? 'split-cancel-analysis'
                : split.phase === SplitPhase.Preview
                  ? 'split-discard'
                  : 'split-cancel'
            }
          >
            {onCancelAnalysis
              ? 'Cancel analysis'
              : split.phase === SplitPhase.Preview
                ? SPLIT_COPY.discardButton
                : SPLIT_COPY.cancelButton}
          </button>
          {split.phase === SplitPhase.Preview || split.phase === SplitPhase.Applying ? (
            <button
              type="button"
              className="primary-action convert-footer__primary"
              disabled={split.phase === SplitPhase.Applying}
              aria-busy={split.phase === SplitPhase.Applying}
              onClick={split.apply}
              data-testid="split-apply"
            >
              <Icon name="ok" size={16} />
              <span>{SPLIT_COPY.applyButton}</span>
            </button>
          ) : (
            <button
              type="button"
              className="primary-action convert-footer__primary"
              disabled={
                !hasPart ||
                connectorBlocked ||
                previewBlocked ||
                split.phase === SplitPhase.Computing
              }
              aria-busy={split.phase === SplitPhase.Computing}
              {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
              onClick={split.updatePreview}
              data-testid="split-preview"
            >
              <Icon name="split" size={16} />
              <span>
                {split.phase === SplitPhase.Computing ? 'Computing…' : SPLIT_COPY.previewButton}
              </span>
            </button>
          )}
        </div>
      )}
      {hint === undefined ? null : (
        <p
          // ONE LINE AT A TIME: drawn only when nothing else occupies the region.
          className={line === undefined ? 'convert-footer__hint' : 'visually-hidden'}
          id={hintId}
          title={hint}
          data-testid="split-unavailable"
        >
          {hint}
        </p>
      )}
      {model !== undefined && split.part !== undefined ? (
        <p className="visually-hidden" aria-live="polite" data-testid="split-announce">
          {split.phase === SplitPhase.Preview
            ? `Preview ready. ${describeCut(split.plane, split.offset, split.unit)}.`
            : applied !== undefined
              ? 'Split applied. Piece A and Piece B are separate parts.'
              : ''}
        </p>
      ) : null}
    </ActionFooter>
  );
}
