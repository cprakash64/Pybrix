import type { ReactNode } from 'react';
import { CONNECTOR_EDIT_COPY, describeChange } from '../state/connector-edit-presentation';
import { ConnectorEditPhase, useConnectorEdit } from '../state/use-connector-edit';
import { MillimetreField } from './MillimetreField';
import { PanelSection, SegmentedControl, type SegmentedOption } from './shell/primitives';

/**
 * CHANGING THE CONNECTORS OF A CUT (Stage EC-5).
 *
 * Four values and two actions. The size of the pin, how deep it goes, the clearance around it and which piece carries it can be
 * changed, and the connectors can be taken off; where they sit cannot, and the section says so in its own first sentence. A change is
 * CHECKED first, by the worker, which rebuilds the connectors from the pieces the cut left and runs every check a split runs, and only
 * then applied: the screen between the two is labelled "Preview — not applied" and the model is untouched until Apply.
 *
 * It claims what was checked and what was not. After an apply the status line says the connectors were "changed and checked", with the
 * same qualifier a split carries: a geometric check of the material around each connector, not a claim about strength.
 */
export function ConnectorEditor({
  labels,
}: {
  readonly labels: Readonly<Record<string, string>>;
}): ReactNode {
  const edit = useConnectorEdit();
  const { joint, draft } = edit;
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

  const sideLabel = (side: 'A' | 'B'): string =>
    labels[side === 'A' ? joint.aPartId : joint.bPartId] ?? (side === 'A' ? 'Piece A' : 'Piece B');
  const sideOptions: readonly SegmentedOption<'A' | 'B'>[] = [
    { value: 'A', label: sideLabel('A'), testId: 'connector-edit-male-a' },
    { value: 'B', label: sideLabel('B'), testId: 'connector-edit-male-b' },
  ];

  return (
    <PanelSection title={CONNECTOR_EDIT_COPY.section}>
      <div data-testid="connector-editor">
        <p className="convert-workspace__note">{CONNECTOR_EDIT_COPY.intro}</p>
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
              disabled={!edit.changed || edit.problem !== undefined}
              data-testid="connector-edit-check"
            >
              {CONNECTOR_EDIT_COPY.check}
            </button>
            <button
              type="button"
              className="secondary-action"
              onClick={edit.checkRemoval}
              data-testid="connector-edit-remove"
            >
              {CONNECTOR_EDIT_COPY.remove}
            </button>
          </div>
        ) : null}
        {undo}
      </div>
    </PanelSection>
  );
}
