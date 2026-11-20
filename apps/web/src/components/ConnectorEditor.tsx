import { useEffect, useState, type ReactNode } from 'react';
import {
  CONNECTOR_EDIT_COPY,
  connectorLimitSentence,
  describeChange,
} from '../state/connector-edit-presentation';
import { ConnectorEditPhase } from '../state/use-connector-edit';
import { useConnectorEditControls } from '../state/workflow-controllers';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { DEFAULT_WORKSPACE } from './shell/workspaces';
import { WorkflowId } from '../state/workflows';
import { CutFace } from './CutFace';
import { MillimetreField } from './MillimetreField';
import { cutAxesSentence, labelCutAxes } from '../state/cut-axes-presentation';
import { NumberField } from './shell/number-field';
import { PanelSection, SegmentedControl, type SegmentedOption } from './shell/primitives';

/**
 * CHANGING THE CONNECTORS OF A CUT (Stage EC-5).
 *
 * The size of the pin, how deep it goes, the clearance around it, which piece carries it, and WHERE each connector sits on the cut: a
 * picture of the cut to drag a connector on, the same two numbers to type, a button to add one and one to take one out. The picture
 * and the fields edit one draft, so they cannot disagree. A change is CHECKED first, by the worker, which rebuilds the connectors from
 * the pieces the cut left and runs every check a split runs (it, and not the picture, decides whether a place has room), and only then
 * applied: the screen between the two is labelled "Preview — not applied" and the model is untouched until Apply.
 *
 * It claims what was checked and what was not. After an apply the status line says the connectors were "changed and checked", with the
 * same qualifier a split carries: a geometric check of the material around each connector, not a claim about strength.
 */
export function ConnectorEditor({
  labels,
  defaultOpen = true,
}: {
  readonly labels: Readonly<Record<string, string>>;
  /** Open in the Split workspace, where the cut is the subject; closed in the others, where it is one section among several. */
  readonly defaultOpen?: boolean;
}): ReactNode {
  const edit = useConnectorEditControls();
  const { joint, draft } = edit;
  const [selected, setSelected] = useState<number | undefined>(undefined);
  // What the person chose by pressing the heading; until then the section is open where the cut is the subject, and open whenever there is
  // a change to undo, so the sentence that says what was done and its Undo are never behind a closed heading. Kept HERE, not in the
  // section, because the section is absent for the moment after an apply while the list of connectors is read again.
  const [chosenOpen, setChosenOpen] = useState<boolean | undefined>(undefined);
  const store = useWorkspaceStore();
  const open = chosenOpen ?? (defaultOpen || edit.undoable);
  // While the editor is open on a cut that can be placed in the scene, that cut is marked on the model (Stage EC-9). The request is the
  // store's, so the viewport reads it without knowing about the editor, and it is withdrawn when the editor closes or goes.
  const marking =
    open && joint !== undefined && draft !== undefined && joint.cutFace?.axes !== undefined;
  useEffect(() => {
    store.setCutMarkShown(marking);
    return (): void => {
      store.setCutMarkShown(false);
    };
  }, [store, marking]);
  const busy =
    edit.phase === ConnectorEditPhase.Checking || edit.phase === ConnectorEditPhase.Applying;

  const undo = edit.undoable ? (
    <div className="panel__actions">
      <p className="panel__note" role="status" data-testid="connector-edit-applied">
        {edit.appliedSentence}
      </p>
      <button
        type="button"
        className="secondary-action"
        onClick={edit.undo}
        disabled={edit.undoing}
        data-testid="connector-edit-undo"
      >
        {edit.undoing ? CONNECTOR_EDIT_COPY.undoing : CONNECTOR_EDIT_COPY.undo}
      </button>
    </div>
  ) : null;

  if (joint === undefined || draft === undefined) return undo;

  const outline = joint.cutFace?.outline;
  const axes = joint.cutFace?.axes === undefined ? undefined : labelCutAxes(joint.cutFace.axes);
  const mmPerCoordinate = joint.cutFace?.mmPerCoordinate ?? 1;
  const maxPins = joint.cutFace?.maxPins ?? 4;
  const sideLabel = (side: 'A' | 'B'): string =>
    labels[side === 'A' ? joint.aPartId : joint.bPartId] ?? (side === 'A' ? 'Piece A' : 'Piece B');
  const sideOptions: readonly SegmentedOption<'A' | 'B'>[] = [
    { value: 'A', label: sideLabel('A'), testId: 'connector-edit-male-a' },
    { value: 'B', label: sideLabel('B'), testId: 'connector-edit-male-b' },
  ];

  return (
    <PanelSection title={CONNECTOR_EDIT_COPY.section} open={open} onOpenChange={setChosenOpen}>
      <div data-testid="connector-editor">
        <p className="convert-workspace__note">{CONNECTOR_EDIT_COPY.intro}</p>
        {outline === undefined ? (
          <p className="convert-workspace__note" data-testid="connector-edit-no-face">
            {CONNECTOR_EDIT_COPY.noFace}
          </p>
        ) : (
          <>
            <p className="format-options__label">{CONNECTOR_EDIT_COPY.facePictureGroup}</p>
            <CutFace
              outline={outline}
              mmPerCoordinate={mmPerCoordinate}
              pins={draft.pins}
              diameterMm={draft.diameterMm}
              clearanceMm={draft.clearanceMm}
              selected={selected}
              {...(axes === undefined
                ? {}
                : { axisLabels: { across: axes.across.short, along: axes.along.short } })}
              disabled={busy}
              onSelect={setSelected}
              onMove={edit.movePin}
              onRemove={(index) => {
                edit.removePin(index);
                setSelected(undefined);
              }}
            />
            <p className="panel__note">{CONNECTOR_EDIT_COPY.facePicture}</p>
            {axes === undefined ? null : (
              <p className="panel__note" data-testid="cut-face-axes">
                {cutAxesSentence(axes)}
              </p>
            )}
            {draft.pins.length === 0 ? (
              <p className="panel__note" data-testid="connector-edit-none-yet">
                {CONNECTOR_EDIT_COPY.noConnectorsYet}
              </p>
            ) : (
              <ul className="connector-positions" data-testid="connector-positions">
                {draft.pins.map((pin, index) => (
                  <li
                    key={pin.pinId ?? `new-${String(index)}`}
                    className={`connector-positions__row${selected === index ? ' connector-positions__row--selected' : ''}`}
                    data-testid={`connector-position-${String(index)}`}
                  >
                    <span className="connector-positions__name">{`Connector ${String(index + 1)}`}</span>
                    <PositionField
                      label={CONNECTOR_EDIT_COPY.across}
                      direction={axes?.across.short}
                      index={index}
                      axis="u"
                      value={pin.u * mmPerCoordinate}
                      disabled={busy}
                      onCommit={(millimetres) => {
                        edit.movePin(index, millimetres / mmPerCoordinate, pin.v);
                      }}
                    />
                    <PositionField
                      label={CONNECTOR_EDIT_COPY.along}
                      direction={axes?.along.short}
                      index={index}
                      axis="v"
                      value={pin.v * mmPerCoordinate}
                      disabled={busy}
                      onCommit={(millimetres) => {
                        edit.movePin(index, pin.u, millimetres / mmPerCoordinate);
                      }}
                    />
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={busy}
                      onClick={() => {
                        edit.removePin(index);
                        setSelected(undefined);
                      }}
                      aria-label={`${CONNECTOR_EDIT_COPY.removeOne} connector ${String(index + 1)}`}
                      data-testid={`connector-position-remove-${String(index)}`}
                    >
                      {CONNECTOR_EDIT_COPY.removeOne}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="panel__actions">
              <button
                type="button"
                className="secondary-action"
                disabled={busy || draft.pins.length >= maxPins}
                onClick={() => {
                  setSelected(edit.addPin());
                }}
                data-testid="connector-edit-add"
              >
                {CONNECTOR_EDIT_COPY.addConnector}
              </button>
            </div>
            <p className="panel__note" data-testid="connector-edit-add-note">
              {draft.pins.length >= maxPins
                ? connectorLimitSentence(maxPins)
                : CONNECTOR_EDIT_COPY.addConnectorNote}
            </p>
          </>
        )}
        <div className="split-params__grid">
          <MillimetreField
            label={CONNECTOR_EDIT_COPY.diameter}
            value={draft.diameterMm}
            disabled={busy}
            onCommit={(diameterMm) => {
              edit.setDraft({ diameterMm });
            }}
            testId="connector-edit-diameter"
          />
          <MillimetreField
            label={CONNECTOR_EDIT_COPY.depth}
            value={draft.depthMm}
            disabled={busy}
            onCommit={(depthMm) => {
              edit.setDraft({ depthMm });
            }}
            testId="connector-edit-depth"
          />
          <MillimetreField
            label={CONNECTOR_EDIT_COPY.clearance}
            value={draft.clearanceMm}
            step={0.05}
            allowZero
            disabled={busy}
            onCommit={(clearanceMm) => {
              edit.setDraft({ clearanceMm });
            }}
            testId="connector-edit-clearance"
          />
        </div>
        <p className="format-options__label">{CONNECTOR_EDIT_COPY.maleSide}</p>
        <SegmentedControl
          label={CONNECTOR_EDIT_COPY.maleSideGroup}
          options={sideOptions}
          value={draft.maleSide}
          onChange={(maleSide) => {
            edit.setDraft({ maleSide });
          }}
          disabled={busy}
        />
        {edit.problem === undefined ? null : (
          <p className="convert-footer__failure" role="alert" data-testid="connector-edit-problem">
            {edit.problem}
          </p>
        )}
        {edit.message === undefined ? null : (
          <p className="convert-footer__failure" role="alert" data-testid="connector-edit-refusal">
            {edit.message}
          </p>
        )}

        {edit.phase === ConnectorEditPhase.Ready &&
        edit.kind === 'SET' &&
        edit.after !== undefined ? (
          <div data-testid="connector-edit-preview">
            <p className="repair__headline" data-testid="connector-edit-preview-label">
              {CONNECTOR_EDIT_COPY.previewLabel}
            </p>
            <p className="panel__note" data-testid="connector-edit-preview-text">
              {describeChange(joint, edit.after, sideLabel)}
            </p>
          </div>
        ) : null}
        {edit.phase === ConnectorEditPhase.Ready && edit.kind === 'REMOVE' ? (
          <div data-testid="connector-edit-preview">
            <p className="repair__headline" data-testid="connector-edit-preview-label">
              {CONNECTOR_EDIT_COPY.previewLabel}
            </p>
            <p className="panel__note" data-testid="connector-edit-preview-text">
              {CONNECTOR_EDIT_COPY.removeReady}
            </p>
          </div>
        ) : null}

        {edit.phase === ConnectorEditPhase.Checking ? (
          <div className="panel__actions">
            <progress className="import__bar" aria-label={CONNECTOR_EDIT_COPY.checking} />
            <button
              type="button"
              className="secondary-action"
              onClick={edit.cancelCheck}
              data-testid="connector-edit-cancel-check"
            >
              {CONNECTOR_EDIT_COPY.cancelChecking}
            </button>
          </div>
        ) : null}

        {edit.phase === ConnectorEditPhase.Ready || edit.phase === ConnectorEditPhase.Applying ? (
          <div className="panel__actions">
            <button
              type="button"
              className="primary-action"
              onClick={edit.apply}
              disabled={edit.phase === ConnectorEditPhase.Applying}
              aria-busy={edit.phase === ConnectorEditPhase.Applying}
              data-testid="connector-edit-apply"
            >
              {edit.phase === ConnectorEditPhase.Applying
                ? CONNECTOR_EDIT_COPY.applying
                : CONNECTOR_EDIT_COPY.apply}
            </button>
            <button
              type="button"
              className="secondary-action"
              onClick={edit.discard}
              disabled={edit.phase === ConnectorEditPhase.Applying}
              data-testid="connector-edit-discard"
            >
              {CONNECTOR_EDIT_COPY.discard}
            </button>
          </div>
        ) : null}

        {edit.phase === ConnectorEditPhase.Idle ? (
          <div className="panel__actions">
            <button
              type="button"
              className="primary-action"
              onClick={edit.check}
              disabled={!edit.canCheck}
              data-testid="connector-edit-check"
            >
              {CONNECTOR_EDIT_COPY.check}
            </button>
            {joint.connector === undefined ? null : (
              <button
                type="button"
                className="secondary-action"
                onClick={edit.checkRemoval}
                data-testid="connector-edit-remove"
              >
                {CONNECTOR_EDIT_COPY.remove}
              </button>
            )}
          </div>
        ) : null}
        {undo}
      </div>
    </PanelSection>
  );
}

/** One signed position, in millimetres from the cut's own origin, typed. Committing moves the connector in the draft, like a drag. */
function PositionField({
  label,
  direction,
  index,
  axis,
  value,
  disabled,
  onCommit,
}: {
  readonly label: string;
  /** Where this direction points on the model (`+X`), shown beside the label, or `undefined` when it is not known. */
  readonly direction: string | undefined;
  readonly index: number;
  readonly axis: 'u' | 'v';
  readonly value: number;
  readonly disabled: boolean;
  readonly onCommit: (millimetres: number) => void;
}): ReactNode {
  return (
    <div className="split-params__field">
      <span className="split-params__label">
        {direction === undefined ? label : `${label} (${direction})`}
      </span>
      <NumberField
        label={`Connector ${String(index + 1)}, ${label.toLowerCase()}, millimetres`}
        value={value}
        min={-100000}
        max={100000}
        step={0.1}
        suffix="mm"
        disabled={disabled}
        onCommit={onCommit}
        testId={`connector-position-${axis}-${String(index)}`}
      />
    </div>
  );
}

/**
 * THE EDITOR WHEREVER A PIECE OF AN ATTACHED CUT IS IN VIEW (Stage EC-7). Every workspace mounts one of these and exactly one of them
 * draws: the workspaces stay mounted while hidden, so an editor in each would be four copies of one set of controls with one id each.
 * The draft, the candidate and the undo are the shared controller's, so a draft survives moving between workspaces and an edit made in
 * one can be undone from another.
 */
export function ConnectorEditorSlot({ workflow }: { readonly workflow: WorkflowId }): ReactNode {
  const { selectedWorkflow, assembly } = useWorkspaceState();
  if ((selectedWorkflow ?? DEFAULT_WORKSPACE) !== workflow) return null;
  return (
    <ConnectorEditor labels={assembly?.labels ?? {}} defaultOpen={workflow === WorkflowId.Split} />
  );
}
