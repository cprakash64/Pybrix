import { SuggestionOperation } from '@cadfixer/auto-split';
import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  CONNECTOR_OPTIONS,
  PIN_COUNTS,
  SPLIT_AXES,
  SPLIT_COPY,
  describeSplitChecks,
  MAX_SPLIT_TILT_DEGREES,
  describeConnectorResult,
  describeCut,
  describePlaneName,
  describePositionLabel,
  describeRollLabel,
  describeTiltLabel,
  formatLength,
  formatVolume,
  socketDiameter,
  type OfferedConnectorKind,
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
 * YZ, one tilt), automatic connector placement, round pins (no dovetail: it cannot be assembled),
 * Preview → Apply → Undo. The reference's cut list, custom planes, eleven
 * connector types, manual placement, pattern and margin controls, bed fitting
 * and orientation have no engine behind them and are not drawn.
 *
 * Stays mounted while hidden, like the other workspaces; the controller it
 * reads lives in the app-level provider either way.
 */
export function SplitWorkspace(): ReactNode {
  const { model, assembly, activePartId } = useWorkspaceState();
  const store = useWorkspaceStore();
  const split = useSplitControls();
  const auto = useAutoSplitControls();
  /*
   * OWNED HERE — WORKSPACE-UX-03. The choice is made in the scrolling content
   * and acted on from the footer; when both lived in the footer the applied
   * state was 162 px tall inside a 140 px scroll area.
   */
  const [editingPreview, setEditingPreview] = useState<string | undefined>(undefined);
  const previewKey =
    split.preview === undefined
      ? undefined
      : `${split.preview.candidate.documentId}/${String(split.preview.candidate.generation)}/${split.preview.candidate.candidateId}`;
  const adjustCut = previewKey !== undefined && editingPreview === previewKey;
  const [editingApplied, setEditingApplied] = useState<string | undefined>(undefined);
  const splitAgain = split.applied !== undefined && editingApplied === split.applied.recordId;
  const [connectorIntent, setConnectorIntent] = useState<
    { readonly documentId: string | undefined; readonly kind: OfferedConnectorKind } | undefined
  >(undefined);
  const pendingConnector =
    connectorIntent?.documentId === model?.handle.documentId &&
    connectorIntent !== undefined &&
    connectorIntent.kind !== split.connector.kind
      ? connectorIntent.kind
      : 'none';
  const setPendingConnector = (kind: OfferedConnectorKind): void => {
    setConnectorIntent({ documentId: model?.handle.documentId, kind });
  };
  const { connectorsAvailable, setConnector, connector } = split;
  useEffect(() => {
    if (pendingConnector !== 'none' && connectorsAvailable && connector.kind !== pendingConnector)
      setConnector({ kind: pendingConnector });
  }, [pendingConnector, connectorsAvailable, connector.kind, setConnector]);
  const [exportMode, setExportMode] = useState<ExportMode>('stl');

  return (
    <div className="convert-workspace split-workspace" data-testid="split-workspace">
      <div className="convert-workspace__sections">
        {split.automaticUnitPrompt ? (
          <section aria-label="Connector units">
            <UnitInterpretationPrompt
              reason="Automatic connectors need physical dimensions."
              commonOnly
              testId="automatic-connector-units"
            />
            <button
              type="button"
              className="secondary-action"
              onClick={split.applyWithoutConnectors}
            >
              Separate without connectors
            </button>
          </section>
        ) : null}
        {(split.preview === undefined && (split.applied === undefined || splitAgain)) ||
        adjustCut ? (
          <SplitModeTabs tab={auto.tab} onTab={auto.setTab} />
        ) : null}
        {split.preview !== undefined || (split.applied !== undefined && !splitAgain) ? (
          <section className="workflow-intent" data-testid="split-intent">
            <h2>
              {split.preview !== undefined && auto.selected?.suggestion.family === 'semantic'
                ? auto.selected.label
                : split.preview !== undefined
                  ? 'Preview'
                  : 'Split complete'}
            </h2>
            <p
              data-testid={
                split.preview === undefined ? 'split-applied-label' : 'split-preview-label'
              }
            >
              {split.preview !== undefined
                ? '2 pieces'
                : `${String(model?.parts.length ?? 2)} pieces created.`}
            </p>
            {split.preview === undefined ? (
              <button
                type="button"
                className="secondary-action"
                data-testid="split-again"
                onClick={() => {
                  setEditingApplied(split.applied?.recordId);
                  split.beginNextSplit?.();
                  auto.setTab('manual');
                }}
              >
                Split again
              </button>
            ) : null}
            {split.preview !== undefined ? (
              <button
                type="button"
                className="secondary-action"
                onClick={() => {
                  setEditingPreview(adjustCut ? undefined : previewKey);
                }}
              >
                Adjust cut
              </button>
            ) : null}
          </section>
        ) : null}
        {split.applied &&
        !splitAgain &&
        assembly &&
        assembly.revision === model?.handle.revision ? (
          <section
            className="assembly-result"
            aria-label="Assembly pieces"
            data-testid="assembly-pieces"
          >
            <h3>Pieces</h3>
            {model.parts.map((piece, index) => (
              <button
                key={piece.partId}
                type="button"
                className="secondary-action"
                aria-pressed={activePartId === piece.partId}
                onClick={() => store.selectPart(piece.partId)}
              >
                {assembly.labels[piece.partId] ?? `Piece ${String(index + 1)}`}
              </button>
            ))}
            <h3>Connectors</h3>
            <p>
              {assembly.connectorPairs.length
                ? assembly.connectorMode === 'manual'
                  ? 'Paired'
                  : 'Automatic'
                : !assembly.interfaces.length
                  ? 'No new cut interface'
                  : assembly.connectorMode === 'unavailable'
                    ? 'Unavailable for this split'
                    : 'Not added'}
            </p>
            {assembly.connectorPairs.map((pair, index) => (
              <button
                key={pair.id}
                type="button"
                className="secondary-action"
                aria-pressed={assembly.selectedPairId === pair.id}
                onClick={() => {
                  store.selectConnectorPair(
                    assembly.selectedPairId === pair.id ? undefined : pair.id,
                  );
                }}
              >{`Connection ${String(index + 1)}: ${assembly.labels[pair.a] ?? 'Piece'} and ${assembly.labels[pair.b] ?? 'Piece'}`}</button>
            ))}
          </section>
        ) : null}
        <div
          hidden={
            (split.preview !== undefined || (split.applied !== undefined && !splitAgain)) &&
            !adjustCut &&
            auto.boundaryPreview === undefined &&
            auto.scopePreview === undefined
          }
        >
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
              <ConnectorSection
                split={split}
                pending={pendingConnector}
                onPending={setPendingConnector}
              />
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
                    <ConnectorSection
                      split={split}
                      pending={pendingConnector}
                      onPending={setPendingConnector}
                    />
                    <button
                      type="button"
                      className="secondary-action"
                      data-testid="auto-preview-adjusted"
                      disabled={
                        busy(split) || auto.footerBlock !== undefined || pendingConnector !== 'none'
                      }
                      onClick={split.updatePreview}
                    >
                      Preview adjusted cut
                    </button>
                  </>
                }
              />
            </div>
          )}
        </div>
        {split.preview !== undefined || split.applied !== undefined ? (
          <PanelSection title="Details" defaultOpen={false} testId="split-details">
            <ResultSection split={split} />
            <ExportSection split={split} mode={exportMode} onMode={setExportMode} />
          </PanelSection>
        ) : null}
        {auto.tab === 'manual' ||
        (split.failedSemanticApply !== undefined && split.error !== undefined) ||
        (auto.hasResult && auto.selected !== undefined && !split.errorIsResourceLimit) ||
        split.exportState === SplitExportState.Failed ? (
          <SplitOutcome split={split} autoMode={auto.tab === 'auto'} />
        ) : null}
      </div>
      <SplitFooter
        componentSeparation={
          auto.selected?.suggestion.family === 'semantic' &&
          auto.selected.operation === SuggestionOperation.Component
        }
        split={split}
        pendingPhysical={pendingConnector !== 'none'}
        onClearPending={() => {
          setConnectorIntent(undefined);
        }}
        splitAgain={splitAgain}
        onEndSplitAgain={() => {
          setEditingApplied(undefined);
        }}
        hideIdle={auto.tab === 'auto'}
        exportMode={exportMode}
        previewBlock={
          split.applied && !splitAgain
            ? undefined
            : pendingConnector !== 'none'
              ? 'Choose model units to add the connector.'
              : auto.tab === 'auto'
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
  split.phase === SplitPhase.Preparing ||
  split.phase === SplitPhase.Computing ||
  split.phase === SplitPhase.Applying ||
  split.phase === SplitPhase.Undoing;

/* ------------------------------------------------------------ cut plane -- */

function CutPlaneSection({ split }: { readonly split: SplitControls }): ReactNode {
  const positionId = useId();
  const exactPositionId = useId();
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
    <PanelSection title={SPLIT_COPY.planeSection} testId="split-plane-section">
      <p className="convert-workspace__note" data-testid="split-part">
        Move the plane to where you want the model separated.
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
        </div>
      </div>
      <PanelSection title="Advanced" defaultOpen={false} testId="split-advanced">
        <div className="split-field split-field--inline">
          <label className="format-options__label" htmlFor={exactPositionId}>
            Position
          </label>
          <NumberField
            id={exactPositionId}
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
      </PanelSection>
    </PanelSection>
  );
}

const PIECE_VIEW_OPTIONS: readonly SegmentedOption<SplitPieceView>[] = [
  { value: 'both', label: 'Both', testId: 'split-view-both' },
  { value: 'a', label: 'Piece A', testId: 'split-view-a' },
  { value: 'b', label: 'Piece B', testId: 'split-view-b' },
];

/* ------------------------------------------------------------ connectors -- */

function ConnectorSection({
  split,
  pending,
  onPending,
}: {
  readonly split: SplitControls;
  readonly pending: OfferedConnectorKind;
  readonly onPending: (kind: OfferedConnectorKind) => void;
}): ReactNode {
  const noteId = useId();
  const disabled = busy(split);
  const connector = split.connector;
  return (
    <PanelSection
      title={
        pending === 'none' && split.connector.kind === 'none' ? 'Connector · None' : 'Connector'
      }
      defaultOpen={false}
      testId="split-connectors"
    >
      {connector.kind === 'none' && pending === 'none' ? null : (
        <UnitInterpretationPrompt
          reason="Connector sizes are physical, so Pybrix needs to know what this model’s numbers mean."
          testId="split-unit-interpretation"
        />
      )}
      <div
        className="connector-grid"
        role="radiogroup"
        aria-label={SPLIT_COPY.connectorsGroup}
        {...(split.connectorsAvailable ? {} : { 'aria-describedby': noteId })}
      >
        {CONNECTOR_OPTIONS.map((option) => {
          const unavailable = option.kind !== 'none' && !split.connectorsAvailable;
          const selected = (pending === 'none' ? connector.kind : pending) === option.kind;
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
                disabled={disabled}
                aria-label={`${option.name}, ${option.detail.toLowerCase()}`}
                onChange={() => {
                  if (unavailable) {
                    onPending(option.kind);
                    return;
                  }
                  onPending('none');
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
      {split.connectorsAvailable || (connector.kind === 'none' && pending === 'none') ? null : (
        <p className="convert-workspace__caution" id={noteId} data-testid="split-connectors-unit">
          {SPLIT_COPY.connectorsNeedMillimetres}
        </p>
      )}
      <p className="convert-workspace__note">{SPLIT_COPY.placementNote}</p>
      {connector.kind === 'none' ? null : (
        <ConnectorParameters split={split} connector={connector} disabled={disabled} />
      )}
    </PanelSection>
  );
}

/** A small line drawing of each connector as it sits across the cut. */
function ConnectorSchematic({ kind }: { readonly kind: OfferedConnectorKind }): ReactNode {
  return (
    <svg className="connector-card__schematic" viewBox="0 0 48 24" aria-hidden="true">
      <line x1="2" y1="12" x2="46" y2="12" className="connector-card__cut" />
      {kind === 'pin' ? (
        <>
          <rect x="16" y="4" width="6" height="16" rx="1.5" className="connector-card__male" />
          <rect x="28" y="4" width="6" height="16" rx="1.5" className="connector-card__male" />
        </>
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
  return (
    <div className="split-params" data-testid="split-connector-parameters">
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
          <p className="split-result__badge" data-testid="split-preview-detail-label">
            Preview details
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
            {metrics === undefined || metrics.volumeInterpretable === false
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
            {metrics === undefined || metrics.volumeInterpretable === false
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
                {describeSplitChecks(preview.metrics.volumeInterpretable)}
              </dd>
            </div>
            {preview.metrics.volumeInterpretable === false ? null : (
              <div className="property-row">
                <dt className="property-row__label">Volume check</dt>
                <dd className="property-row__value property-row__value--mono">
                  {(preview.metrics.volumeRelativeError * 100).toFixed(5)}% difference
                </dd>
              </div>
            )}
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
  const applied =
    split.applied !== undefined &&
    (split.phase === SplitPhase.Idle || split.phase === SplitPhase.Undoing);
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
function SplitOutcome({
  split,
  autoMode,
}: {
  readonly split: SplitControls;
  readonly autoMode: boolean;
}): ReactNode {
  const exportFailure =
    split.exportState === SplitExportState.Failed ? split.exportMessage : undefined;
  const key = [split.error, exportFailure].filter((message) => message !== undefined).join('|');
  return (
    <WorkspaceOutcome revealKey={key === '' ? undefined : key}>
      {split.error === undefined ? null : split.errorIsResourceLimit ? (
        <ResourceRefusalCard testId="split-resource-limit" />
      ) : split.errorIsOperationFailure ? (
        <OutcomeAlert testId="split-error">
          Split could not be completed. Your model is unchanged.
          <PanelSection title="Details" defaultOpen={false}>
            <p>{split.error}</p>
          </PanelSection>
        </OutcomeAlert>
      ) : (
        <section className="workflow-limitation" role="status" data-testid="split-error">
          <div data-testid={autoMode ? 'auto-unsafe' : undefined}>
            <p>This cut can't be made safely.</p> <p>Try moving the cut or choose another part.</p>
          </div>
          <PanelSection title="Details" defaultOpen={false}>
            <p>{split.error}</p>
            {split.sourceNotClosed === undefined ? null : (
              <ul>
                {split.sourceNotClosed.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </PanelSection>
        </section>
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
  componentSeparation,
  exportMode,
  previewBlock,
  onCancelAnalysis,
  hideIdle,
  splitAgain,
  onEndSplitAgain,
  pendingPhysical,
  onClearPending,
}: {
  readonly split: SplitControls;
  readonly componentSeparation: boolean;
  readonly exportMode: ExportMode;
  readonly hideIdle: boolean;
  readonly splitAgain: boolean;
  readonly onEndSplitAgain: () => void;
  readonly pendingPhysical: boolean;
  readonly onClearPending: () => void;
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
    pendingPhysical ||
    (split.connector.kind !== 'none' &&
      (!split.connectorsAvailable || split.connectorProblem !== undefined));

  const previewBlocked = previewBlock !== undefined && split.phase === SplitPhase.Idle;
  const hint = !hasPart
    ? SPLIT_COPY.noPart
    : previewBlocked
      ? previewBlock
      : connectorBlocked
        ? (split.connectorProblem ?? SPLIT_COPY.connectorsNeedMillimetres)
        : undefined;
  const working =
    split.phase === SplitPhase.Preparing ||
    split.phase === SplitPhase.Computing ||
    split.phase === SplitPhase.Applying ||
    split.phase === SplitPhase.Undoing;
  const failureLine =
    split.error !== undefined && split.errorIsOperationFailure === true
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
      {split.preview?.semanticQualification?.boundaryChoice === 'PREVIEW' ||
      split.preview?.semanticQualification?.scopeConfirmation?.state === 'REQUIRED'
        ? 'Review the geometry, then choose this option.'
        : SPLIT_COPY.previewReady}
    </ActionFooterLine>
  ) : undefined;

  return (
    <ActionFooter testId="split-footer" className="split-footer">
      <div
        hidden={
          (hideIdle || previewBlock !== undefined) &&
          !working &&
          split.phase === SplitPhase.Idle &&
          applied === undefined
        }
      >
        <div className="convert-footer__status" aria-live="polite">
          {line}
        </div>

        {applied !== undefined &&
        !splitAgain &&
        (split.phase === SplitPhase.Idle || split.phase === SplitPhase.Undoing) ? (
          <div className="convert-footer__actions">
            <button
              type="button"
              className="secondary-action convert-footer__cancel"
              disabled={working}
              aria-busy={split.phase === SplitPhase.Undoing}
              onClick={split.undo}
              data-testid="split-undo"
            >
              {SPLIT_COPY.undoButton}
            </button>
            <button
              type="button"
              className="primary-action convert-footer__primary"
              disabled={
                working || !piecesPresent || split.exportState === SplitExportState.Exporting
              }
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
              <span>{exportMode === 'stl' ? 'Export pieces' : SPLIT_COPY.exportThreeMfAction}</span>
            </button>
          </div>
        ) : (
          <div className="convert-footer__actions">
            <button
              type="button"
              className="secondary-action convert-footer__cancel"
              disabled={split.phase === SplitPhase.Applying}
              onClick={
                onCancelAnalysis ??
                (split.phase === SplitPhase.Preview
                  ? split.discardPreview
                  : splitAgain && split.phase === SplitPhase.Idle
                    ? onEndSplitAgain
                    : (): void => {
                        onClearPending();
                        split.cancel();
                      })
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
                disabled={
                  split.phase === SplitPhase.Applying ||
                  pendingPhysical ||
                  split.preview?.semanticQualification?.boundaryChoice === 'PREVIEW' ||
                  split.preview?.semanticQualification?.scopeConfirmation?.state === 'REQUIRED'
                }
                aria-busy={split.phase === SplitPhase.Applying}
                onClick={split.apply}
                data-testid="split-apply"
              >
                <Icon name="ok" size={16} />
                <span>{componentSeparation ? 'Separate' : SPLIT_COPY.applyButton}</span>
              </button>
            ) : (
              <button
                type="button"
                className="primary-action convert-footer__primary"
                disabled={!hasPart || connectorBlocked || previewBlocked || working}
                aria-busy={working}
                {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
                onClick={split.updatePreview}
                data-testid="split-preview"
              >
                <Icon name="split" size={16} />
                <span>{working ? 'Computing…' : SPLIT_COPY.previewButton}</span>
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
      </div>
    </ActionFooter>
  );
}
