import { useId, type ReactNode } from 'react';
import type { TextureMode, TexturePattern } from '@cadfixer/geometry-runtime';
import {
  PATTERN_OPTIONS,
  TEXTURE_COPY,
  TEXTURE_ELEMENT_LIMIT,
  TEXTURE_PRIMITIVE_LIMIT,
  describeCoverage,
  describeDepthLabel,
  describeFeatureLabel,
  describeSelectionArea,
  describeTriangles,
  patternOption,
} from '../state/texture-presentation';
import { useWorkspaceState } from '../state/store-context';
import { TexturePhase, type TextureControls } from '../state/use-texture-workflow';
import { useTextureControls } from '../state/workflow-controllers';
import {
  ActionFooter,
  ActionFooterLine,
  OutcomeAlert,
  WorkspaceOutcome,
  useRevealOnMount,
} from './shell/action-footer';
import { WorkflowId } from '../state/workflows';
import { ConnectorEditorSlot } from './ConnectorEditor';
import { UnitInterpretationPrompt } from './UnitInterpretationPrompt';
import { Icon } from './shell/Icon';
import { NumberField } from './shell/number-field';
import { PanelSection, SegmentedControl, type SegmentedOption } from './shell/primitives';

/**
 * THE SURFACE TEXTURE WORKSPACE — presentation of `useTextureControls`.
 *
 * Only what the Stage 7C engine does: one flat region chosen by clicking a
 * face, Dots / Lines / Diamond laid flat on it, raised or engraved, a layout
 * preview that builds nothing, a Boolean preview, Apply and Undo. The
 * reference's brush, lasso, angle and grow/shrink tools, image uploads,
 * curved mappings, falloff and subdivision have no engine behind them and are
 * not drawn. Stays mounted while hidden, like the other workspaces.
 */
export function TextureWorkspace(): ReactNode {
  const { model } = useWorkspaceState();
  const texture = useTextureControls();

  return (
    <div className="convert-workspace texture-workspace" data-testid="texture-workspace">
      <div className="convert-workspace__sections">
        {model === undefined || texture.part === undefined ? (
          <PanelSection title={TEXTURE_COPY.selectionSection}>
            <p className="panel__empty" data-testid="texture-empty">
              {TEXTURE_COPY.noModel}
            </p>
          </PanelSection>
        ) : (
          <>
            <SelectionSection texture={texture} />
            {texture.available ? null : (
              <p
                className="convert-workspace__caution texture-workspace__unit"
                data-testid="texture-unit"
              >
                {TEXTURE_COPY.needsMillimetres}
              </p>
            )}
            <UnitInterpretationPrompt
              reason="Texture sizes are physical, so Pybrix needs to know what this model’s numbers mean."
              testId="texture-unit-interpretation"
            />
            <SourceSection texture={texture} />
            <MappingSection texture={texture} />
            <ParametersSection texture={texture} />
            <LayoutSection texture={texture} />
            {texture.appliedRecordId === undefined ? null : <AppliedSection texture={texture} />}
          </>
        )}
        <ConnectorEditorSlot workflow={WorkflowId.Texture} />
        <WorkspaceOutcome revealKey={texture.error}>
          {texture.error === undefined ? null : (
            <OutcomeAlert testId="texture-error">
              {texture.error} The model is unchanged.
            </OutcomeAlert>
          )}
        </WorkspaceOutcome>
      </div>
      <TextureFooter texture={texture} />
    </div>
  );
}

const locked = (texture: TextureControls): boolean =>
  !texture.available ||
  texture.phase === TexturePhase.Computing ||
  texture.phase === TexturePhase.Applying;

/* ------------------------------------------------------------ selection -- */

function SelectionSection({ texture }: { readonly texture: TextureControls }): ReactNode {
  const selection = texture.selection;
  const toolDetailId = useId();
  return (
    <PanelSection
      title={TEXTURE_COPY.selectionSection}
      meta={
        selection === undefined ? undefined : describeSelectionArea(selection.area, texture.unit)
      }
      testId="texture-selection"
    >
      <div className="texture-tools" role="group" aria-label={TEXTURE_COPY.selectionGroup}>
        {/* The one real tool, stated rather than drawn as a button that
            could only ever be pressed: CAD Fixer has no other to switch to. */}
        <span
          className="texture-tool"
          aria-describedby={toolDetailId}
          data-testid="texture-tool-region"
        >
          <Icon name="target" size={15} />
          Tool: {TEXTURE_COPY.regionTool}
        </span>
        <button
          type="button"
          className="secondary-action texture-tools__clear"
          disabled={selection === undefined && !texture.selecting}
          onClick={texture.clearSelection}
          data-testid="texture-clear"
        >
          {TEXTURE_COPY.clearSelection}
        </button>
      </div>
      <p className="convert-workspace__note" id={toolDetailId}>
        {TEXTURE_COPY.regionToolDetail}
      </p>
      {texture.selecting ? (
        <p className="split-footer__progress" data-testid="texture-selecting">
          <Icon name="loader" size={14} className="spin" />
          Selecting the connected flat region…
        </p>
      ) : selection === undefined ? (
        <p className="panel__empty" data-testid="texture-no-selection">
          {TEXTURE_COPY.noSelection}
        </p>
      ) : (
        <dl className="property-grid" data-testid="texture-selection-metrics">
          <div className="property-row">
            <dt className="property-row__label">Area</dt>
            <dd
              className="property-row__value property-row__value--mono"
              data-testid="texture-area"
            >
              {describeSelectionArea(selection.area, texture.unit)}
            </dd>
          </div>
          <div className="property-row">
            <dt className="property-row__label">Faces</dt>
            <dd
              className="property-row__value property-row__value--mono"
              data-testid="texture-triangles"
            >
              {describeTriangles(selection.triangleIds.length)}
            </dd>
          </div>
          {describeCoverage(selection.area, selection.partArea) === undefined ? null : (
            <div className="property-row">
              <dt className="property-row__label">Coverage</dt>
              <dd
                className="property-row__value property-row__value--mono"
                data-testid="texture-coverage"
              >
                {describeCoverage(selection.area, selection.partArea)}
              </dd>
            </div>
          )}
        </dl>
      )}
    </PanelSection>
  );
}

/* --------------------------------------------------------------- source -- */

function SourceSection({ texture }: { readonly texture: TextureControls }): ReactNode {
  const disabled = locked(texture);
  return (
    <PanelSection
      title={TEXTURE_COPY.sourceSection}
      meta={patternOption(texture.settings.pattern).name}
      testId="texture-source"
    >
      <div className="connector-grid" role="radiogroup" aria-label={TEXTURE_COPY.sourceGroup}>
        {PATTERN_OPTIONS.map((option) => {
          const selected = texture.settings.pattern === option.pattern;
          return (
            <label
              key={option.pattern}
              className="format-card texture-card"
              data-selected={selected ? 'true' : 'false'}
              data-unavailable={disabled && !selected ? 'true' : 'false'}
            >
              <input
                type="radio"
                name="texture-pattern"
                className="format-card__input"
                value={option.pattern}
                checked={selected}
                disabled={disabled}
                aria-label={`${option.name}, ${option.detail.toLowerCase()}`}
                onChange={() => {
                  texture.setSettings({ pattern: option.pattern });
                }}
                data-testid={`texture-pattern-${option.pattern}`}
              />
              <PatternThumbnail pattern={option.pattern} />
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
    </PanelSection>
  );
}

/** A small static drawing of each pattern. SVG, drawn once; no raster, no canvas. */
function PatternThumbnail({ pattern }: { readonly pattern: TexturePattern }): ReactNode {
  const marks: ReactNode[] = [];
  if (pattern === 'dots') {
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 5; col++)
        marks.push(
          <circle
            key={`${String(row)}-${String(col)}`}
            cx={6 + col * 9}
            cy={5 + row * 7}
            r={2.2}
          />,
        );
  } else {
    const lines = pattern === 'lines' ? [0] : [45, -45];
    for (const angle of lines)
      for (let index = -4; index <= 4; index++)
        marks.push(
          <rect
            key={`${String(angle)}-${String(index)}`}
            x={22 + index * 7 - 1.4}
            y={-10}
            width={2.8}
            height={44}
            transform={`rotate(${String(angle === 0 ? 90 : angle)} 22 12)`}
          />,
        );
  }
  return (
    <svg className="texture-card__thumb" viewBox="0 0 44 24" aria-hidden="true">
      <g className="texture-card__marks">{marks}</g>
    </svg>
  );
}

/* -------------------------------------------------------------- mapping -- */

function MappingSection({ texture }: { readonly texture: TextureControls }): ReactNode {
  const option = patternOption(texture.settings.pattern);
  return (
    <PanelSection title={TEXTURE_COPY.mappingSection} meta="Flat" testId="texture-mapping">
      <div className="format-options__field">
        <p className="format-options__label">Projection</p>
        <p className="format-options__value" data-testid="texture-projection">
          {TEXTURE_COPY.mappingProjection}
        </p>
      </div>
      {option.rotates ? (
        <MillimetreLikeField
          label="Rotation"
          unitLabel="degrees"
          suffix="°"
          value={texture.settings.rotationDegrees}
          min={0}
          max={180}
          step={1}
          disabled={locked(texture)}
          onCommit={(rotationDegrees) => {
            texture.setSettings({ rotationDegrees });
          }}
          testId="texture-rotation"
        />
      ) : (
        <p className="convert-workspace__note" data-testid="texture-rotation-na">
          Dots are round, so they have no rotation.
        </p>
      )}
      <p className="convert-workspace__note">{TEXTURE_COPY.mappingNote}</p>
    </PanelSection>
  );
}

/* ----------------------------------------------------------- parameters -- */

function ParametersSection({ texture }: { readonly texture: TextureControls }): ReactNode {
  const disabled = locked(texture);
  const settings = texture.settings;
  const directions: readonly SegmentedOption<TextureMode>[] = [
    { value: 'emboss', label: TEXTURE_COPY.raised, testId: 'texture-raised' },
    { value: 'engrave', label: TEXTURE_COPY.engraved, testId: 'texture-engraved' },
  ];
  return (
    <PanelSection title={TEXTURE_COPY.parametersSection} testId="texture-parameters">
      <p className="format-options__label">{TEXTURE_COPY.directionGroup}</p>
      <SegmentedControl
        label="Texture direction"
        options={directions}
        value={settings.mode}
        onChange={(mode) => {
          texture.setSettings({ mode });
        }}
        disabled={disabled}
      />
      <div className="split-params__grid texture-params">
        <MillimetreLikeField
          label={describeFeatureLabel(settings.pattern)}
          unitLabel="millimetres"
          suffix="mm"
          value={settings.featureSize}
          min={0.01}
          max={1000}
          step={0.1}
          disabled={disabled}
          onCommit={(featureSize) => {
            texture.setSettings({ featureSize });
          }}
          testId="texture-feature-size"
        />
        <MillimetreLikeField
          label="Spacing, centre to centre"
          unitLabel="millimetres"
          suffix="mm"
          value={settings.spacing}
          min={0.01}
          max={1000}
          step={0.1}
          disabled={disabled}
          onCommit={(spacing) => {
            texture.setSettings({ spacing });
          }}
          testId="texture-spacing"
        />
        <MillimetreLikeField
          label={describeDepthLabel(settings.mode)}
          unitLabel="millimetres"
          suffix="mm"
          value={settings.heightOrDepth}
          min={0.01}
          max={1000}
          step={0.1}
          disabled={disabled}
          onCommit={(heightOrDepth) => {
            texture.setSettings({ heightOrDepth });
          }}
          testId="texture-depth"
        />
      </div>
      <p className="convert-workspace__note">
        {settings.mode === 'emboss'
          ? 'Raised elements stand on the face along its outward normal.'
          : 'Engraved elements are cut into the face along its inward normal.'}
      </p>
      {texture.settingsProblem === undefined ? null : (
        <p className="convert-footer__failure" role="alert" data-testid="texture-settings-problem">
          {texture.settingsProblem}
        </p>
      )}
    </PanelSection>
  );
}

function MillimetreLikeField({
  label,
  unitLabel,
  suffix,
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
  testId,
}: {
  readonly label: string;
  readonly unitLabel: string;
  readonly suffix: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
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
        label={`${label}, ${unitLabel}`}
        value={value}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        disabled={disabled}
        onCommit={onCommit}
        testId={testId}
      />
    </div>
  );
}

/* --------------------------------------------------------------- layout -- */

function LayoutSection({ texture }: { readonly texture: TextureControls }): ReactNode {
  const layout = texture.layout;
  const result = layout.result;
  return (
    <PanelSection title={TEXTURE_COPY.estimateSection} meta="Fast preview" testId="texture-layout">
      {texture.selection === undefined ? (
        <p className="panel__empty">Select a flat face to see where the elements go.</p>
      ) : layout.pending ? (
        <p className="split-footer__progress" data-testid="texture-layout-pending">
          <Icon name="loader" size={14} className="spin" />
          Laying out elements…
        </p>
      ) : layout.error !== undefined ? (
        <p className="convert-footer__failure" role="alert" data-testid="texture-layout-error">
          {layout.error} Try a larger spacing, smaller elements or a smaller face.
        </p>
      ) : result === undefined ? (
        <p className="panel__empty">Nothing to lay out yet.</p>
      ) : (
        <>
          <dl className="property-grid">
            <div className="property-row">
              <dt className="property-row__label">Elements</dt>
              <dd
                className="property-row__value property-row__value--mono"
                data-testid="texture-elements"
              >
                {result.elementCount.toLocaleString()} of {TEXTURE_ELEMENT_LIMIT.toLocaleString()}{' '}
                allowed
              </dd>
            </div>
            <div className="property-row">
              <dt className="property-row__label">Element triangles</dt>
              <dd
                className="property-row__value property-row__value--mono"
                data-testid="texture-primitive-triangles"
              >
                {result.estimatedPrimitiveTriangles.toLocaleString()} of{' '}
                {TEXTURE_PRIMITIVE_LIMIT.toLocaleString()}
              </dd>
            </div>
            {texture.preview === undefined ? null : (
              <div className="property-row">
                <dt className="property-row__label">Result</dt>
                <dd
                  className="property-row__value property-row__value--mono"
                  data-testid="texture-result-triangles"
                >
                  {texture.preview.candidateTriangleCount.toLocaleString()} triangles
                </dd>
              </div>
            )}
          </dl>
          <p className="convert-workspace__note">{TEXTURE_COPY.fastPreviewNote}</p>
          <p className="convert-workspace__note">
            The final triangle count is known once the preview is generated: it depends on how the
            elements meet the face.
          </p>
        </>
      )}
    </PanelSection>
  );
}

/* -------------------------------------------------------------- applied -- */

/**
 * THE APPLIED TEXTURE, and its Undo — WORKSPACE-UX-03.
 *
 * SCROLLING CONTENT. Undo used to be a second button row inside the pinned
 * footer, which made the applied state 120 px of a 140 px scroll area. It is
 * the result's own action, so it sits with the result; the card is brought
 * into view once, when the texture is applied, and the scroller's padding
 * keeps Undo clear of the action region whenever it is focused or scrolled to.
 *
 * Shown for exactly as long as the undo record exists: a new model, a new
 * revision or an undo retires it.
 */
function AppliedSection({ texture }: { readonly texture: TextureControls }): ReactNode {
  const ref = useRevealOnMount<HTMLDivElement>();
  return (
    <div ref={ref}>
      <PanelSection title={TEXTURE_COPY.appliedSection} testId="texture-applied-section">
        <div className="texture-applied" role="status" data-testid="texture-applied">
          <p className="texture-applied__headline">
            <Icon name="ok" size={14} />
            {TEXTURE_COPY.appliedHeadline}
          </p>
          <p className="convert-workspace__note">{TEXTURE_COPY.appliedNote}</p>
          <button
            type="button"
            className="secondary-action texture-applied__undo"
            onClick={texture.undo}
            data-testid="texture-undo"
          >
            {TEXTURE_COPY.undoButton}
          </button>
        </div>
      </PanelSection>
    </div>
  );
}

/* --------------------------------------------------------------- footer -- */

/**
 * The shared bounded action region: the action row and ONE line — progress,
 * else a failure's headline, else the preview state, else why the action is
 * unavailable. Counts, the applied result and Undo are scrolling content.
 */
function TextureFooter({ texture }: { readonly texture: TextureControls }): ReactNode {
  const { model } = useWorkspaceState();
  const hintId = useId();
  const ready =
    model !== undefined &&
    texture.part !== undefined &&
    texture.available &&
    texture.selection !== undefined &&
    texture.settingsProblem === undefined &&
    texture.layout.error === undefined;
  const hint =
    model === undefined || texture.part === undefined
      ? TEXTURE_COPY.noModel
      : !texture.available
        ? TEXTURE_COPY.needsMillimetres
        : texture.selection === undefined
          ? 'Select a flat face first.'
          : (texture.settingsProblem ??
            (texture.layout.error === undefined ? undefined : 'The layout above was refused.'));
  const inPreview =
    texture.phase === TexturePhase.Preview || texture.phase === TexturePhase.Applying;
  const working =
    texture.phase === TexturePhase.Computing || texture.phase === TexturePhase.Applying;
  const previewLine =
    texture.preview === undefined
      ? TEXTURE_COPY.previewLabel
      : `${TEXTURE_COPY.previewLabel}: ${texture.preview.elementCount.toLocaleString()} elements, ${texture.preview.candidateTriangleCount.toLocaleString()} triangles.`;
  const line = working ? (
    <p className="split-footer__progress action-footer__line" data-testid="texture-progress">
      <Icon name="loader" size={14} className="spin" />
      <span>
        {texture.phase === TexturePhase.Applying ? TEXTURE_COPY.applying : texture.progress}
      </span>
    </p>
  ) : texture.error !== undefined ? (
    <ActionFooterLine tone="failure" testId="texture-failure-line">
      {TEXTURE_COPY.failedLine}
    </ActionFooterLine>
  ) : texture.phase === TexturePhase.Preview ? (
    <ActionFooterLine testId="texture-preview-ready" title={previewLine}>
      {previewLine}
    </ActionFooterLine>
  ) : undefined;

  return (
    <ActionFooter testId="texture-footer" className="texture-footer">
      <div className="convert-footer__status" aria-live="polite">
        {line}
      </div>
      <div className="convert-footer__actions">
        <button
          type="button"
          className="secondary-action convert-footer__cancel"
          onClick={inPreview ? texture.discardPreview : texture.reset}
          disabled={texture.phase === TexturePhase.Applying}
          data-testid={inPreview ? 'texture-discard' : 'texture-reset'}
        >
          {inPreview ? TEXTURE_COPY.discardButton : TEXTURE_COPY.resetButton}
        </button>
        {inPreview ? (
          <button
            type="button"
            className="primary-action convert-footer__primary"
            disabled={texture.phase === TexturePhase.Applying}
            aria-busy={texture.phase === TexturePhase.Applying}
            onClick={texture.apply}
            data-testid="texture-apply"
          >
            <Icon name="ok" size={16} />
            <span>{TEXTURE_COPY.applyButton}</span>
          </button>
        ) : (
          <button
            type="button"
            className="primary-action convert-footer__primary"
            disabled={!ready || texture.phase === TexturePhase.Computing}
            aria-busy={texture.phase === TexturePhase.Computing}
            {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
            onClick={texture.generate}
            data-testid="texture-generate"
          >
            <Icon name="texture" size={16} />
            <span>
              {texture.phase === TexturePhase.Computing ? 'Building…' : TEXTURE_COPY.previewButton}
            </span>
          </button>
        )}
      </div>
      {hint === undefined ? null : (
        <p
          // ONE LINE AT A TIME: drawn only when nothing else occupies the region.
          className={line === undefined ? 'convert-footer__hint' : 'visually-hidden'}
          id={hintId}
          title={hint}
          data-testid="texture-unavailable"
        >
          {hint}
        </p>
      )}
    </ActionFooter>
  );
}
