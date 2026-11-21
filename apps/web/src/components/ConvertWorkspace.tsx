import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  CompatibilityDisposition,
  CompatibilityFeature,
  ExportFormat,
  isExportFormat,
  objNeedsFileSink,
  type ConversionCompatibilityReport,
} from '@cadfixer/file-formats';
import {
  BEFORE_CONVERTING_NOTE,
  CONVERSION_QUALIFIER,
  CONVERT_WORKSPACE_COPY,
  OBJECTS_LABEL,
  OUTPUT_FORMATS_NOTE,
  OUTPUT_VARIANTS,
  OutputSizeKind,
  PENDING_PREVIEW_NOTE,
  REVIEW_IN_REPAIR,
  SAVED_HEADLINE,
  UNITS_LABEL,
  UNKNOWN_SIZE_MARK,
  UNIT_ASSERTION_EXPLANATION,
  UNIT_ASSERTION_SCOPE,
  UNIT_CHOICES,
  UNIT_REQUIRED_HEADLINE,
  NO_MODEL_NOTE,
  describeConvertAction,
  describeConvertUnavailable,
  describeExportFailure,
  describeExportFailureHeadline,
  describeOutput,
  describeOutputSizeKind,
  describeOutputUnit,
  describePartCount,
  describePhase,
  describeSavedAs,
  describeSavedDetails,
  describeSizeRefusalDetails,
  describeSourceKind,
  describeSourceUnit,
  describeStatedUnit,
  describeStructure,
  describeUnrecordedUnit,
  formatExportBytes,
  type OutputVariant,
} from '../state/conversion-presentation';
import { describeSourceFormat, type LoadedModel } from '../state/model';
import { measurementUnitKey, outputSize, type OutputSize } from '../state/output-size';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useDocumentConversion, type ObjOverwritePrompt } from '../state/use-document-conversion';
import { WorkflowId } from '../state/workflows';
import { ConnectorEditorSlot } from './ConnectorEditor';
import {
  ConversionState,
  HoleFillWorkState,
  RepairCandidateState,
  refusedExportFor,
  type MeasuredExport,
} from '../state/workspace-store';
import { ConversionReport } from './ConversionReport';
import { ActionFooter } from './shell/action-footer';
import { Icon } from './shell/Icon';
import { InfoButton, InfoPanel, useInfoDisclosure, type InfoDisclosure } from './shell/info';
import { PanelSection } from './shell/primitives';

/**
 * THE CONVERT WORKSPACE — the one place a document becomes a file.
 *
 * PRESENTATION ONLY. The compatibility report is `analyseConversion`'s, the
 * wording is `conversion-presentation.ts`'s, the sizes are `output-size.ts`'s
 * and the operation is `useDocumentConversion`'s, which drives the same
 * validated export worker every document export has always used. Nothing here
 * decides what a format keeps, and nothing here writes a byte.
 *
 * ONE FORMAT PER EXPORT, and the controls say so. `DocumentExportService` runs
 * one export at a time and each export is one validated file, so the output
 * grid is a single-choice radio group rather than the reference's multi-select:
 * a multi-select over a one-at-a-time engine would be a queue the product does
 * not have. For the same reason the selected card and the card whose options
 * are shown are the same thing — there is one choice, not two.
 *
 * WHOLE DOCUMENT, ALWAYS. Every target writes every part; the active part
 * decides nothing here.
 *
 * STAYS MOUNTED WHILE HIDDEN, like every workspace panel: the conversion hook
 * cancels what it started when it unmounts, and switching tabs is not a reason
 * to throw away someone's file.
 */
export function ConvertWorkspace({ active }: { readonly active: boolean }): ReactNode {
  const { model, conversion, repair, holeFill } = useWorkspaceState();
  const store = useWorkspaceStore();
  const {
    report,
    start,
    chooseTarget,
    chooseUnit,
    convert,
    cancel,
    destinationName,
    setDestinationName,
    folderName,
    chooseFolder,
    destinationNote,
    overwrite,
    confirmOverwrite,
  } = useDocumentConversion();

  /*
   * A SESSION STARTS WHEN THE WORKSPACE IS SHOWN FOR A MODEL, preselecting the
   * source format. Starting it earlier would preselect a target for a model
   * nobody has asked to convert; the report it enables is pure and costs a
   * walk over part descriptors, and no export worker exists until Convert is
   * pressed.
   */
  useEffect(() => {
    if (active && model !== undefined) start();
  }, [active, model, start]);

  const working = conversion.state === ConversionState.Working;
  const target =
    conversion.target !== undefined && isExportFormat(conversion.target)
      ? conversion.target
      : undefined;
  const exportable = report?.exportable === true;
  const pendingPreview =
    repair.candidateState === RepairCandidateState.Ready ||
    holeFill.workState === HoleFillWorkState.Ready;
  /*
   * REFUSED FOR SIZE AT THIS REVISION, TARGET AND UNIT — Convert P1. The same
   * three can only be refused again, so the action is disabled with the reason
   * beside it rather than offered for another four-second wait.
   */
  const refusedForSize =
    model !== undefined &&
    target !== undefined &&
    refusedExportFor(
      conversion.refused,
      model.handle,
      target,
      measurementUnitKey(model, target, conversion.unitAssertion),
    ) !== undefined
      ? target
      : undefined;
  const outcomeInfo = useInfoDisclosure();

  return (
    <div className="convert-workspace" data-testid="convert-workspace">
      <div className="convert-workspace__sections">
        <PanelSection title={CONVERT_WORKSPACE_COPY.sourceSection} testId="convert-source-section">
          {model === undefined ? <EmptySource /> : <SourceCard model={model} />}
        </PanelSection>

        <ConnectorEditorSlot workflow={WorkflowId.Convert} />

        <PanelSection
          title={CONVERT_WORKSPACE_COPY.outputsSection}
          meta={CONVERT_WORKSPACE_COPY.outputsMeta}
          testId="convert-outputs"
        >
          <OutputGrid
            model={model}
            target={target}
            unitAssertion={conversion.unitAssertion}
            measured={conversion.measured}
            disabled={working || model === undefined}
            onChoose={chooseTarget}
          />
          <p className="convert-workspace__note">{OUTPUT_FORMATS_NOTE}</p>
        </PanelSection>

        <PanelSection
          title={CONVERT_WORKSPACE_COPY.optionsSection}
          meta={target === undefined ? undefined : describeOutput(target)}
          testId="convert-options"
        >
          {model === undefined || target === undefined || report === undefined ? (
            <p className="panel__empty">{CONVERT_WORKSPACE_COPY.optionsEmpty}</p>
          ) : (
            <FormatOptions
              model={model}
              target={target}
              report={report}
              unitAssertion={conversion.unitAssertion}
              disabled={working}
              onChooseUnit={chooseUnit}
            />
          )}
        </PanelSection>

        {target === 'obj' && model !== undefined && objNeedsFileSink(model.parts) ? (
          <PanelSection title="Save destination" testId="convert-destination">
            <label className="format-options__field">
              Filename
              <input
                type="text"
                aria-label="OBJ filename"
                value={destinationName}
                disabled={working}
                onChange={(event) => {
                  setDestinationName(event.target.value);
                }}
                data-testid="convert-filename"
              />
            </label>
            <button
              type="button"
              className="secondary-action"
              disabled={working}
              onClick={chooseFolder}
              data-testid="convert-folder"
            >
              {folderName === undefined ? 'Choose folder' : `Folder: ${folderName}`}
            </button>
            <p className="convert-workspace__note" data-testid="convert-destination-note">
              {destinationNote}
            </p>
          </PanelSection>
        ) : null}
        {overwrite === undefined ? null : (
          <PanelSection
            title={
              overwrite.changed
                ? 'File changed — confirm replacement again'
                : 'Replace existing file?'
            }
            testId="convert-overwrite"
          >
            <p className="convert-workspace__note">
              {overwrite.name} · {String(overwrite.size)} bytes. The existing file stays unchanged
              until saving finishes.
            </p>
          </PanelSection>
        )}
        <PanelSection title={CONVERT_WORKSPACE_COPY.beforeSection} testId="convert-before">
          <p className="convert-workspace__note">{BEFORE_CONVERTING_NOTE}</p>
          {pendingPreview ? (
            <p className="convert-workspace__caution" data-testid="convert-pending-preview">
              {PENDING_PREVIEW_NOTE}
            </p>
          ) : null}
          <button
            type="button"
            className="secondary-action"
            disabled={model === undefined}
            onClick={() => {
              store.selectWorkflow(WorkflowId.Repair);
            }}
            data-testid="convert-review-repair"
          >
            <Icon name="repair" size={14} />
            {REVIEW_IN_REPAIR}
          </button>
        </PanelSection>

        <SavedResult
          active={active}
          model={model}
          folderName={
            target === 'obj' && model !== undefined && objNeedsFileSink(model.parts)
              ? folderName
              : undefined
          }
        />
        <OutcomeDetails disclosure={outcomeInfo} target={target} refusedForSize={refusedForSize} />
      </div>

      <ConvertFooter
        hasModel={model !== undefined}
        sourceFormat={model?.source.formatId}
        target={target}
        exportable={exportable}
        refusedForSize={refusedForSize}
        outcomeInfo={outcomeInfo}
        onConvert={convert}
        onCancel={cancel}
        overwrite={overwrite}
        onConfirmOverwrite={confirmOverwrite}
      />
    </div>
  );
}

/* ---------------------------------------------------------- source card -- */

function EmptySource(): ReactNode {
  // The Open action is the workspace's empty state above this section
  // (UI-07A); a second one here would be the same command twice.
  return (
    <div className="source-card source-card--empty" data-testid="convert-source-empty">
      <p className="convert-workspace__note">{NO_MODEL_NOTE}</p>
    </div>
  );
}

/**
 * The file this workspace is converting, as the file itself describes it.
 *
 * EVERY VALUE IS THE IMPORT'S. Nothing here says "no colours" or "no
 * materials", because CAD Fixer does not read colours and a model with no
 * material REFERENCE may still have had materials in a form that was never
 * imported — which the report's source warnings state when it happened. The
 * chips show only what the document actually records.
 */
function SourceCard({ model }: { readonly model: LoadedModel }): ReactNode {
  const { source } = model;
  const partCount = model.parts.length;
  const materialRefs = model.parts.some(
    (part) => part.materialRef !== undefined || part.groupMaterialRefCount > 0,
  );
  const kind = describeSourceKind(describeSourceFormat(source), source.formatId, source.encoding);

  return (
    <div className="source-card">
      <span className="source-card__thumb" aria-hidden="true">
        <Icon name="cube" size={20} />
      </span>
      <div className="source-card__text">
        {/* User-supplied text, rendered as text. Never markup, never a path. */}
        <p
          className="source-card__name"
          title={source.fileName}
          data-testid="convert-source"
          aria-label={`Source file: ${source.fileName}`}
        >
          {source.fileName}
        </p>
        <p className="source-card__meta" data-testid="convert-source-meta">
          {kind} · {formatExportBytes(source.fileBytes)} · {model.triangleCount.toLocaleString()}{' '}
          triangles
        </p>
        <ul className="source-card__chips" aria-label={CONVERT_WORKSPACE_COPY.chipsLabel}>
          <li className="chip" data-testid="convert-source-parts">
            {describePartCount(partCount)}
          </li>
          <li className="chip" data-testid="convert-source-unit">
            {describeSourceUnit(source.unit)}
          </li>
          {materialRefs ? (
            <li className="chip" data-testid="convert-source-materials">
              {CONVERT_WORKSPACE_COPY.materialReferences}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- output grid -- */

interface OutputGridProps {
  readonly model: LoadedModel | undefined;
  readonly target: ExportFormat | undefined;
  readonly unitAssertion: string | undefined;
  readonly measured: readonly MeasuredExport[];
  readonly disabled: boolean;
  readonly onChoose: (format: ExportFormat) => void;
}

/**
 * The output cards: a native radio group, drawn as tiles.
 *
 * NATIVE RADIOS, so arrow keys move between cards, Tab enters and leaves the
 * group once, and the checked state is announced by the platform. The input is
 * visually hidden inside a `<label>` that is the card; focus shows on the card.
 * The selected card carries a check mark as well as the accent border, so the
 * state never depends on colour.
 */
function OutputGrid({
  model,
  target,
  unitAssertion,
  measured,
  disabled,
  onChoose,
}: OutputGridProps): ReactNode {
  return (
    <div className="format-grid" role="radiogroup" aria-label={CONVERT_WORKSPACE_COPY.outputsGroup}>
      {OUTPUT_VARIANTS.map((variant) => (
        <FormatCard
          key={variant.id}
          variant={variant}
          selected={variant.format !== undefined && variant.format === target}
          disabled={disabled || variant.format === undefined}
          size={
            model === undefined || variant.format === undefined
              ? undefined
              : outputSize(model, variant.format, unitAssertion, measured)
          }
          onChoose={onChoose}
        />
      ))}
    </div>
  );
}

function FormatCard({
  variant,
  selected,
  disabled,
  size,
  onChoose,
}: {
  readonly variant: OutputVariant;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly size: OutputSize | undefined;
  readonly onChoose: (format: ExportFormat) => void;
}): ReactNode {
  const detailId = useId();
  const format = variant.format;
  const unavailable = format === undefined;
  /*
   * A CARD IS TOO NARROW FOR "On export", so an unknown or unavailable size is
   * a dash — never alone: the accessible description and the tooltip carry the
   * sentence saying why.
   */
  const sizeText =
    unavailable || size === undefined || size.kind === OutputSizeKind.Unknown
      ? UNKNOWN_SIZE_MARK
      : formatExportBytes(size.bytes);
  const detail = unavailable
    ? (variant.unavailableReason ?? '')
    : size === undefined
      ? ''
      : describeOutputSizeKind(size.kind);

  return (
    <label
      className="format-card"
      data-selected={selected ? 'true' : 'false'}
      data-unavailable={unavailable ? 'true' : 'false'}
      title={detail === '' ? undefined : detail}
    >
      <input
        type="radio"
        name="convert-target"
        className="format-card__input"
        value={variant.id}
        checked={selected}
        disabled={disabled}
        aria-label={variant.accessibleName}
        {...(detail === '' ? {} : { 'aria-describedby': detailId })}
        onChange={() => {
          if (format !== undefined) onChoose(format);
        }}
        data-testid={`convert-target-${variant.id}`}
      />
      <span className="format-card__name">{variant.name}</span>
      <span className="format-card__variant">{variant.variant}</span>
      <span
        className={`format-card__size format-card__size--${unavailable ? 'unavailable' : (size?.kind ?? 'none')}`}
        data-testid={`convert-size-${variant.id}`}
      >
        {sizeText}
      </span>
      {selected ? (
        <span className="format-card__check" aria-hidden="true">
          <Icon name="ok" size={13} />
        </span>
      ) : null}
      {detail === '' ? null : (
        <span className="visually-hidden" id={detailId}>
          {detail}
        </span>
      )}
    </label>
  );
}

/* ------------------------------------------------------- format options -- */

/**
 * What the chosen format will do with THIS model.
 *
 * NO CONTROL APPEARS UNLESS IT CHANGES THE FILE. The one real option is the
 * unit a 3MF must state when the model states none — and it labels the numbers,
 * it never rescales them. Everything else here is a FACT about the output
 * rather than a switch: CAD Fixer has no axis conversion, no unit conversion,
 * no merge option, and writes no colours, materials, textures, thumbnails or
 * 3MF metadata, so none of those has a control that would pretend otherwise.
 */
function FormatOptions({
  model,
  target,
  report,
  unitAssertion,
  disabled,
  onChooseUnit,
}: {
  readonly model: LoadedModel;
  readonly target: ExportFormat;
  readonly report: ConversionCompatibilityReport;
  readonly unitAssertion: string | undefined;
  readonly disabled: boolean;
  readonly onChooseUnit: (unit: string | undefined) => void;
}): ReactNode {
  /*
   * THE UNIT CONTROL STAYS ONCE IT HAS BEEN ANSWERED. It is shown whenever the
   * unit is a question this target asks of this document — unanswered it is a
   * blocker, answered it is an assumption — derived from the report so the
   * workspace never holds a second opinion about when a unit is required.
   */
  const asksForUnit =
    report.blockers.some(
      (fact) =>
        fact.feature === CompatibilityFeature.PhysicalUnit &&
        fact.disposition === CompatibilityDisposition.RequiresUserAssertion,
    ) || report.assumptions.some((fact) => fact.feature === CompatibilityFeature.PhysicalUnit);

  return (
    <div className="format-options">
      {model.parts.length > 1 ? (
        <p className="convert-workspace__note" data-testid="convert-whole-document">
          {CONVERT_WORKSPACE_COPY.wholeDocument}
        </p>
      ) : null}

      {asksForUnit ? (
        <UnitChooser value={unitAssertion} disabled={disabled} onChoose={onChooseUnit} />
      ) : (
        <div className="format-options__field" data-testid="convert-unit-fact">
          <p className="format-options__label">{UNITS_LABEL}</p>
          <p className="format-options__value">
            {describeOutputUnit(target, model.source.unit, unitAssertion)}
          </p>
          <p className="convert-workspace__note">
            {target === ExportFormat.ThreeMf && model.source.unit !== undefined
              ? describeStatedUnit(model.source.unit)
              : describeUnrecordedUnit(target)}
          </p>
        </div>
      )}

      <div className="format-options__field" data-testid="convert-objects-fact">
        <p className="format-options__label">{OBJECTS_LABEL}</p>
        <p className="format-options__value">{describeStructure(target, model.parts.length)}</p>
      </div>

      <ConversionReport report={report} />
      <p className="convert__qualifier">{CONVERSION_QUALIFIER}</p>
    </div>
  );
}

/**
 * The six 3MF units as a single-choice group with NOTHING SELECTED until the
 * user chooses. A preselected unit would be CAD Fixer asserting a physical fact
 * about the model on the user's behalf — the one thing this flow exists to
 * prevent — so no radio starts checked and nothing is remembered from a
 * previous model.
 */
function UnitChooser({
  value,
  disabled,
  onChoose,
}: {
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly onChoose: (unit: string) => void;
}): ReactNode {
  const headingId = useId();
  return (
    <fieldset className="format-options__field unit-chooser" data-testid="convert-unit">
      <legend className="format-options__label" id={headingId}>
        {UNITS_LABEL}
      </legend>
      <p className="format-options__value">{UNIT_REQUIRED_HEADLINE}</p>
      <div className="unit-chooser__options" role="radiogroup" aria-labelledby={headingId}>
        {UNIT_CHOICES.map((choice) => (
          <label
            key={choice.value}
            className="unit-chooser__option"
            data-selected={value === choice.value ? 'true' : 'false'}
            title={choice.label}
          >
            <input
              type="radio"
              name="convert-unit"
              className="unit-chooser__input"
              value={choice.value}
              checked={value === choice.value}
              disabled={disabled}
              aria-label={choice.label}
              onChange={() => {
                onChoose(choice.value);
              }}
              data-testid={`convert-unit-${choice.value}`}
            />
            <span aria-hidden="true">{choice.symbol}</span>
          </label>
        ))}
      </div>
      <p className="convert-workspace__note">{UNIT_ASSERTION_EXPLANATION}</p>
      <p className="convert-workspace__note">{UNIT_ASSERTION_SCOPE}</p>
    </fieldset>
  );
}

/* --------------------------------------------------------------- footer -- */

/**
 * The primary action and what is needed to act on it right now.
 *
 * STICKY AT THE BOTTOM OF THE PANEL, so the action is reachable however long
 * the report above it is. Its label says what pressing it does — "Convert to
 * 3MF", or "Export STL" when the format does not change — and when it cannot
 * be pressed the reason is written beside it rather than left to a disabled
 * style.
 *
 * A BOUNDED HEIGHT, BY STRUCTURE — CONVERT-UX-02. This region is pinned over
 * the scrolling content, so every pixel it takes is taken from the controls
 * above it, and on a short window that is nearly all of them. It therefore
 * holds the action row and AT MOST ONE LINE about it: the overwrite question,
 * or the progress of a running export, or the headline of a failure, or the
 * reason the action is unavailable. The four are exclusive. Anything longer —
 * the saved result, a refusal's explanation — lives in the scrolling content.
 * `shell.css` caps the region as well, and gives the action row the space
 * first, so a line that somehow ran long would be clipped before a button was.
 * Since WORKSPACE-UX-03 this is the contract of EVERY workspace's footer —
 * see `shell/action-footer.tsx`.
 */
function ConvertFooter({
  hasModel,
  sourceFormat,
  target,
  exportable,
  refusedForSize,
  outcomeInfo,
  onConvert,
  onCancel,
  overwrite,
  onConfirmOverwrite,
}: {
  readonly hasModel: boolean;
  readonly sourceFormat: string | undefined;
  readonly target: ExportFormat | undefined;
  readonly exportable: boolean;
  readonly refusedForSize: ExportFormat | undefined;
  readonly outcomeInfo: InfoDisclosure;
  readonly onConvert: () => void;
  readonly onCancel: () => void;
  readonly overwrite: ObjOverwritePrompt | undefined;
  readonly onConfirmOverwrite: () => void;
}): ReactNode {
  const { conversion } = useWorkspaceState();
  const hintId = useId();
  const working = conversion.state === ConversionState.Working;
  const unavailable = describeConvertUnavailable(
    hasModel,
    target !== undefined,
    exportable,
    refusedForSize,
  );
  const failure = conversion.state === ConversionState.Failed ? conversion.failure : undefined;
  const percent = Math.round(conversion.fraction * 100);

  return (
    <ActionFooter testId="convert-footer">
      {/* PROGRESS, announced politely, and only the PHASE — a percentage read
          out on every update would drown everything else. A refusal is an
          alert below; a saved file is announced by its own card. */}
      <div className="convert-footer__status" aria-live="polite">
        {overwrite !== undefined ? (
          <p className="convert-footer__failure-text">
            {overwrite.changed ? 'File changed. ' : ''}Replace {overwrite.name}?
          </p>
        ) : working ? (
          <div className="convert-footer__progress" data-testid="convert-progress">
            <div className="convert-footer__progress-row">
              {/* THE PHASE IS THE WRITER'S OWN, not a fabricated animation. */}
              <span data-testid="convert-phase">{describePhase(conversion.phase)}</span>
              <span data-testid="convert-percent" aria-hidden="true">
                {percent}%
              </span>
            </div>
            <progress
              className="import__bar"
              max={100}
              value={percent}
              aria-label={`Export progress: ${String(percent)}%`}
            />
          </div>
        ) : null}
      </div>
      {/* ONE LINE, NEVER A PARAGRAPH — Convert P1. The full sentence is behind
          ⓘ, in the scrolling content: a paragraph here grew the sticky footer
          until the button left the panel on a short window. */}
      {failure !== undefined ? (
        <div className="convert-footer__failure" role="alert" data-testid="convert-failure">
          <span className="convert-footer__failure-text">
            {describeExportFailureHeadline(failure.status, target)}
          </span>
          {refusedForSize === undefined ? (
            <InfoButton
              disclosure={outcomeInfo}
              label="this export"
              testId="convert-failure-info"
            />
          ) : (
            <InfoButton
              disclosure={outcomeInfo}
              label="this export limit"
              testId="convert-refusal-info"
            />
          )}
        </div>
      ) : null}

      <div className="convert-footer__actions">
        {working ? (
          <button
            type="button"
            className="secondary-action convert-footer__cancel"
            onClick={onCancel}
            data-testid="convert-cancel"
          >
            {overwrite === undefined ? CONVERT_WORKSPACE_COPY.cancel : 'Keep existing file'}
          </button>
        ) : null}
        <button
          type="button"
          className="primary-action convert-footer__primary"
          onClick={overwrite === undefined ? onConvert : onConfirmOverwrite}
          disabled={(working && overwrite === undefined) || unavailable !== undefined}
          aria-busy={working}
          {...(unavailable === undefined ? {} : { 'aria-describedby': hintId })}
          data-testid={overwrite === undefined ? 'convert-export' : 'convert-overwrite-confirm'}
        >
          <Icon name="convert" size={16} />
          <span>
            {overwrite === undefined
              ? describeConvertAction(sourceFormat, target, working)
              : 'Replace file'}
          </span>
        </button>
      </div>
      {unavailable === undefined || working ? null : failure !== undefined ? (
        /* ONE LINE AT A TIME. The failure headline above is the line on
           screen; the reason still describes the button for a screen reader. */
        <p className="visually-hidden" id={hintId} data-testid="convert-unavailable">
          {unavailable}
        </p>
      ) : (
        <div className="convert-footer__hint-row">
          <p
            className="convert-footer__hint"
            id={hintId}
            title={unavailable}
            data-testid="convert-unavailable"
          >
            {unavailable}
          </p>
          {refusedForSize === undefined ? null : (
            <InfoButton
              disclosure={outcomeInfo}
              label="this export limit"
              testId="convert-refusal-info"
            />
          )}
        </div>
      )}
    </ActionFooter>
  );
}

/* --------------------------------------------------------- saved result -- */

/**
 * THE FILE THAT WAS JUST WRITTEN — CONVERT-UX-02.
 *
 * IN THE SCROLLING CONTENT, NEVER IN THE STICKY FOOTER. It used to be a
 * sentence inside the footer, and after a large native export on a 300 px
 * window that sentence made the footer 133 px of a 140 px scroll area: the
 * filename and folder controls could not be scrolled out from under it, and a
 * click on the folder button landed on Export. Here it can be as tall as it
 * needs to be and takes nothing from the controls above it.
 *
 * NEVER IN THE WAY. Nothing has to be dismissed: editing the filename, the
 * folder, the format or the unit retires it, and so does the next export.
 *
 * ONLY FOR THE REVISION ON SCREEN, as the inspector's summary is: a file
 * written before a repair describes geometry the user has moved off.
 *
 * REVEALED ONCE, WHEN IT ARRIVES, by setting the panel's own scroller — never
 * `scrollIntoView`, which would also scroll every clipped ancestor.
 */
function SavedResult({
  active,
  model,
  folderName,
}: {
  readonly active: boolean;
  readonly model: LoadedModel | undefined;
  readonly folderName: string | undefined;
}): ReactNode {
  const { conversion } = useWorkspaceState();
  const details = useInfoDisclosure();
  const ref = useRef<HTMLDivElement>(null);
  const result =
    conversion.state === ConversionState.Saved &&
    model !== undefined &&
    conversion.result?.source.documentId === model.handle.documentId &&
    conversion.result.source.revision === model.handle.revision
      ? conversion.result
      : undefined;

  useEffect(() => {
    if (result === undefined || !active) return;
    const scroller = ref.current?.closest('.tool-panel__body');
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight;
  }, [result, active]);

  // The details of a result that is gone do not stay open for the next one.
  const { open, close } = details;
  useEffect(() => {
    if (open && result === undefined) close();
  }, [open, result, close]);

  return (
    <div ref={ref} className="convert-result">
      {/* ALWAYS MOUNTED, so the region exists before its content does and the
          result is announced once, when it appears — not on every render. */}
      <div className="convert-result__live" aria-live="polite">
        {result === undefined ? null : (
          <div className="convert-result__card" data-testid="convert-saved">
            <Icon name="ok" size={16} />
            <div className="convert-result__text">
              <p className="convert-result__headline">{SAVED_HEADLINE}</p>
              {/* User-supplied text, rendered as text. */}
              <p className="convert-result__file" title={result.fileName}>
                {describeSavedAs(result.fileName)}
              </p>
            </div>
            <InfoButton disclosure={details} label="this file" testId="convert-saved-info" />
          </div>
        )}
      </div>
      <InfoPanel disclosure={details} label="this file" testId="convert-saved-details">
        {result === undefined
          ? null
          : describeSavedDetails(
              result.target,
              result.byteLength,
              result.triangleCount,
              folderName,
            ).map((text) => (
              <p key={text} className="info-panel__text">
                {text}
              </p>
            ))}
      </InfoPanel>
    </div>
  );
}

/* ------------------------------------------------------ outcome details -- */

/**
 * WHAT THE LAST EXPORT MEANT, in full, behind the footer's ⓘ — Convert P1.
 *
 * IN THE SCROLLING CONTENT, directly above the sticky footer, never inside it:
 * the footer holds only bounded content so the action cannot be pushed out of
 * the panel, while this can be as long as the explanation needs. Opening it
 * scrolls the panel's own scroll area to the end so it lands beside the button
 * — the panel's scroller, set directly, never `scrollIntoView`, which would
 * also scroll every clipped ancestor and move the whole application shell.
 */
function OutcomeDetails({
  disclosure,
  target,
  refusedForSize,
}: {
  readonly disclosure: InfoDisclosure;
  readonly target: ExportFormat | undefined;
  readonly refusedForSize: ExportFormat | undefined;
}): ReactNode {
  const { conversion } = useWorkspaceState();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!disclosure.open) return;
    const scroller = ref.current?.closest('.tool-panel__body');
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight;
  }, [disclosure.open]);

  const failure = conversion.state === ConversionState.Failed ? conversion.failure : undefined;
  const paragraphs =
    refusedForSize !== undefined
      ? describeSizeRefusalDetails(refusedForSize)
      : failure !== undefined
        ? [describeExportFailure(failure.status, failure.reason)]
        : [];
  // Nothing left to explain — the outcome was replaced — so nothing stays open.
  const empty = paragraphs.length === 0;
  const { open, close } = disclosure;
  useEffect(() => {
    if (open && empty) close();
  }, [open, empty, close]);
  const label =
    failure === undefined ? 'this export' : describeExportFailureHeadline(failure.status, target);

  return (
    <div ref={ref} className="convert-outcome-details">
      <InfoPanel disclosure={disclosure} label={label} testId="convert-outcome-details">
        {paragraphs.map((text) => (
          <p key={text} className="info-panel__text">
            {text}
          </p>
        ))}
      </InfoPanel>
    </div>
  );
}
