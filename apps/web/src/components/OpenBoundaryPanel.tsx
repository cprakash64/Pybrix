import { useEffect, useRef, type ReactNode } from 'react';
import { ISSUE_INFO, HOLE_FILL_SIZE_LIMIT_LINE } from '../state/repair-workspace-presentation';
import { RepairIssueId } from '../state/repair-issues';
import { InfoButton, InfoPanel, useInfoDisclosure } from './shell/info';
import { PanelSection } from './shell/primitives';
import { HOLE_FILL_MAX_PART_FACES } from '@cadfixer/geometry-runtime';
import { useWorkspaceState } from '../state/store-context';
import { currentJoints } from '../state/joint-presentation';
import { disclosureFor } from '../state/connector-edit-presentation';
import { useHoleFillControls } from '../state/workflow-controllers';
import {
  HOLE_FILL_APPLIED_QUALIFIER,
  HOLE_FILL_APPLY_ACTION,
  HOLE_FILL_CANCEL_ACTION,
  HOLE_FILL_DISCARD_ACTION,
  HOLE_FILL_LIMITS,
  HOLE_FILL_PREVIEW_ACTION,
  HOLE_FILL_PREVIEW_NOT_APPLIED,
  HOLE_FILL_PREVIEW_READY,
  HOLE_FILL_SECTION_TITLE,
  HOLE_FILL_UNDO_ACTION,
  OPENING_ELIGIBLE,
  OPENING_ELIGIBLE_DETAIL,
  OPENING_INELIGIBLE,
  describeBoundaryRefusal,
  describeOpening,
  describeOpeningCount,
  describeOpeningSize,
  describePartSizeRefusal,
  describeUninventoriedPart,
  describeTruncatedInventory,
} from '../state/hole-fill-presentation';
import {
  HoleFillCommitState,
  HoleFillInventoryState,
  HoleFillWorkState,
  type HoleBoundaryRow,
} from '../state/workspace-store';
import { describeActivePart } from '../state/part-presentation';

/**
 * THE OPEN-BOUNDARY WORKFLOW.
 *
 * PRESENTATION AND DISPATCH ONLY. Every sentence comes from
 * `hole-fill-presentation.ts`, every decision from the store, and no geometry
 * comes here at all — the page holds a handle, some counts, and two disposable
 * render buffers it hands straight to the viewport.
 *
 * THIS COMPONENT CANNOT FILL ANYTHING. `Apply fill` calls a hook that calls the
 * worker, and the worker re-checks the candidate's existence, its document, its
 * part, its opening, its lifecycle state and the revision before it swaps a
 * single reference. A defect here can show a wrong label; it cannot change
 * geometry.
 *
 * WHAT THE SCREEN IS FOR, in this order: which openings this part has, which of
 * them CAD Fixer can close and which it will not and why, what a proposed fill
 * looks like, and what filling one does NOT establish. Making the model look
 * closed is not one of the goals — a boundary loop may be exactly what the user
 * modelled.
 *
 * THE DISPLAY INDEX IS A LABEL, NOT AN IDENTITY. A row reads "Opening 3" because
 * it is third in a deterministic order; every request carries the
 * `boundaryLoopId` the worker produced from the geometry it holds. The two can
 * never be confused, because the index is never sent anywhere.
 */
export function OpenBoundaryPanel(): ReactNode {
  const { model, activePartId, holeFill, joints } = useWorkspaceState();
  // Said before Apply: what this fill does to the connectors recorded on this piece, when it touches any.
  const connectorNote =
    activePartId === undefined
      ? undefined
      : disclosureFor(currentJoints(joints, model?.handle), activePartId);
  const controls = useHoleFillControls();
  const statusRef = useRef<HTMLDivElement>(null);

  const { inventory, selectedLoopId, candidate, workState, commitState, lastApplied } = holeFill;

  /**
   * Moves focus to the status region whenever the button in hand disappears.
   *
   * THREE TRANSITIONS, and all three are the same problem. A keyboard user
   * presses `Preview fill`, `Cancel` or `Apply fill`; each of those controls is
   * gone by the time the operation settles, and the browser's answer to focus on
   * a removed element is to drop it on the document body — losing the user's
   * place on the page entirely, with no indication of what happened. The live
   * region is where the outcome is, so that is where focus goes.
   *
   * Only on a genuine settle, never on an arbitrary re-render: a status message
   * elsewhere must not steal focus from wherever the user has moved it to.
   */
  const previousWork = useRef<HoleFillWorkState>(workState);
  const previousCommit = useRef<HoleFillCommitState>(commitState);
  useEffect(() => {
    const workSettled =
      workState === HoleFillWorkState.Ready ||
      workState === HoleFillWorkState.Failed ||
      workState === HoleFillWorkState.Cancelled;
    const wasWorking =
      previousWork.current === HoleFillWorkState.Generating ||
      previousWork.current === HoleFillWorkState.Cancelling;

    // Apply and Undo end the same way: the control that was pressed is gone and
    // the outcome is in the live region.
    const commitSettled = commitState === HoleFillCommitState.Idle;
    const wasCommitting = previousCommit.current !== HoleFillCommitState.Idle;

    previousWork.current = workState;
    previousCommit.current = commitState;
    if ((workSettled && wasWorking) || (commitSettled && wasCommitting)) {
      statusRef.current?.focus();
    }
  }, [commitState, workState]);

  if (model === undefined) return null;

  const generating =
    workState === HoleFillWorkState.Generating || workState === HoleFillWorkState.Cancelling;
  const previewReady = workState === HoleFillWorkState.Ready && candidate !== undefined;
  const committing = commitState !== HoleFillCommitState.Idle;
  const selectedRow = inventory.rows.find((row) => row.boundaryLoopId === selectedLoopId);
  const partTooLarge = controls.partTooLarge;

  return (
    <PanelSection
      title={HOLE_FILL_SECTION_TITLE}
      testId="open-boundaries"
      info={ISSUE_INFO[RepairIssueId.OpenBoundaries]}
      {...(inventory.state === HoleFillInventoryState.Ready
        ? { meta: inventory.loopCount.toLocaleString() }
        : {})}
    >
      <div className="holefill" data-testid="hole-fill-body">
        {/* THE SCOPE OF EVERY NUMBER BELOW, stated where the numbers are. Openings
          belong to one mesh, so on a multi-part document this list describes ONE
          part. */}
        {model.parts.length > 1 ? (
          <p className="panel__note" data-testid="hole-fill-part-scope">
            Openings of <strong>{describeActivePart(model.parts, activePartId)}</strong> only, of{' '}
            {model.parts.length.toLocaleString()} parts. Filling one changes that part and nothing
            else.
          </p>
        ) : null}

        {/* --- inventory lifecycle ----------------------------------------- */}
        {inventory.state === HoleFillInventoryState.Listing ? (
          <p className="panel__note" role="status" data-testid="hole-fill-listing">
            Finding open boundaries…
          </p>
        ) : null}

        {inventory.state === HoleFillInventoryState.Failed && inventory.error !== undefined ? (
          <div className="repair__blocked" role="alert" data-testid="hole-fill-listing-error">
            <p className="repair__error-message">{inventory.error.message}</p>
            {inventory.error.retryable ? (
              <div className="panel__actions">
                <button
                  type="button"
                  className="action"
                  onClick={controls.refreshOpenings}
                  data-testid="hole-fill-retry-listing"
                >
                  Look again
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* THE WALK WAS NOT PERFORMED, and that is what this says — Stage 6D-R3.
          Deliberately NOT "no openings found": nothing looked. One short line;
          the numbers and the reason are behind the ⓘ. */}
        {inventory.state === HoleFillInventoryState.NotInventoried ? (
          <SizeLimitNotice
            detail={describeUninventoriedPart(inventory.partFaceCount)}
            detailTestId="hole-fill-not-inventoried"
          />
        ) : null}

        {inventory.state === HoleFillInventoryState.Ready ? (
          <>
            <p className="panel__note" data-testid="hole-fill-count">
              {describeOpeningCount(inventory.loopCount)}
            </p>

            {/* A RESOURCE REFUSAL, STATED BEFORE ANYTHING IS STARTED. The part's
              triangle count already decides this, so spinning up a worker to be
              told the same thing would be work nobody needs done. */}
            {partTooLarge ? (
              <SizeLimitNotice
                detail={describePartSizeRefusal(inventory.partFaceCount)}
                detailTestId="hole-fill-part-too-large"
              />
            ) : null}

            {inventory.truncated ? (
              <p className="panel__note" data-testid="hole-fill-truncated">
                {describeTruncatedInventory(inventory.rows.length, inventory.loopCount)}
              </p>
            ) : null}

            {inventory.rows.length > 0 ? (
              <OpeningList
                rows={inventory.rows}
                selectedLoopId={selectedLoopId}
                disabled={generating || committing || partTooLarge}
                onSelect={controls.selectOpening}
              />
            ) : null}
          </>
        ) : null}

        {/* --- the selected opening ---------------------------------------- */}
        {selectedRow !== undefined ? (
          <div className="holefill__selection" data-testid="hole-fill-selection">
            <h3 className="panel__subtitle">{describeOpening(selectedRow.displayIndex)}</h3>
            <p className="panel__note" data-testid="hole-fill-selected-size">
              {describeOpeningSize(selectedRow.vertexCount)}
            </p>

            {selectedRow.fillable ? (
              /* WHAT IS STILL UNKNOWN, stated before the button is pressed. §7:
               the listing answers a topological question exactly and a
               geometric one not at all, and the interface must not blur the
               two into a promise. */
              <p className="panel__note" data-testid="hole-fill-selected-eligible">
                {OPENING_ELIGIBLE_DETAIL}
              </p>
            ) : (
              <p className="repair__operation-reason" data-testid="hole-fill-selected-refusal">
                {selectedRow.refusal === undefined
                  ? OPENING_INELIGIBLE
                  : describeBoundaryRefusal(selectedRow.refusal)}
              </p>
            )}

            {selectedRow.fillable && !previewReady && !generating && !partTooLarge ? (
              <div className="panel__actions">
                <button
                  type="button"
                  className="action action--primary"
                  onClick={controls.previewFill}
                  disabled={committing}
                  data-testid="preview-fill"
                >
                  {HOLE_FILL_PREVIEW_ACTION}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* --- generation --------------------------------------------------- */}
        {generating ? (
          <div className="holefill__progress" data-testid="hole-fill-progress">
            {/*
            INDETERMINATE, DELIBERATELY. The fill is one synchronous pass in a
            worker that cannot report from inside itself, so a bar filling to a
            measured percentage does not exist to be shown. A `progress` element
            with no `value` is exactly the "we are working and cannot say how
            far" the platform already has a control for — and it beats inventing
            a number.
          */}
            <p role="status" data-testid="hole-fill-phase">
              {holeFill.phase ?? 'Preparing'}…
            </p>
            <progress className="import__bar" aria-label="Preparing a fill preview" />
            <button
              type="button"
              className="import__cancel"
              onClick={controls.cancelPreview}
              disabled={workState === HoleFillWorkState.Cancelling}
              data-testid="cancel-fill"
            >
              {HOLE_FILL_CANCEL_ACTION}
            </button>
            {workState === HoleFillWorkState.Cancelling ? (
              <p className="panel__note" role="status" data-testid="hole-fill-cancelling">
                Stopping…
              </p>
            ) : null}
          </div>
        ) : null}

        {/*
        THE OUTCOME REGION. A live region so a screen-reader user learns what
        happened without hunting for it, and focusable so a keyboard user is not
        dropped on the document body when the button they pressed disappears.
      */}
        <div
          className="holefill__status"
          role="status"
          aria-live="polite"
          tabIndex={-1}
          ref={statusRef}
          data-testid="hole-fill-status"
        >
          {workState === HoleFillWorkState.Cancelled ? (
            <p className="panel__note" data-testid="hole-fill-cancelled">
              Fill cancelled. Your model is unchanged, and you can try this opening again.
            </p>
          ) : null}

          {workState === HoleFillWorkState.Failed && holeFill.candidateError !== undefined ? (
            <div className="repair__blocked" data-testid="hole-fill-refusal">
              <p className="repair__error-message">{holeFill.candidateError.message}</p>
              <p className="panel__note" data-testid="hole-fill-refusal-qualifier">
                Your model was not changed.
              </p>
            </div>
          ) : null}

          {previewReady ? (
            <div className="holefill__candidate" data-testid="hole-fill-candidate">
              <p className="repair__headline" data-testid="hole-fill-preview-headline">
                {HOLE_FILL_PREVIEW_READY}
              </p>
              <p className="panel__note" data-testid="hole-fill-preview-not-applied">
                {HOLE_FILL_PREVIEW_NOT_APPLIED}
              </p>
              <p className="panel__note" data-testid="hole-fill-patch-size">
                The new surface is{' '}
                {candidate.patchTriangleCount === 1
                  ? '1 triangle'
                  : `${candidate.patchTriangleCount.toLocaleString()} triangles`}
                . No points were added, and none of yours were moved.
              </p>
              {connectorNote === undefined ? null : (
                <p className="panel__note" data-testid="hole-fill-connector-note">
                  {connectorNote}
                </p>
              )}

              <div className="panel__actions">
                <button
                  type="button"
                  className="action action--primary"
                  onClick={controls.applyFill}
                  disabled={committing}
                  data-testid="apply-fill"
                >
                  {commitState === HoleFillCommitState.Applying
                    ? 'Applying…'
                    : HOLE_FILL_APPLY_ACTION}
                </button>
                <button
                  type="button"
                  className="action"
                  onClick={controls.discardPreview}
                  disabled={committing}
                  data-testid="discard-fill"
                >
                  {HOLE_FILL_DISCARD_ACTION}
                </button>
              </div>
            </div>
          ) : null}

          {lastApplied !== undefined ? (
            <div className="holefill__applied" data-testid="hole-fill-applied">
              <p className="repair__headline" data-testid="hole-fill-applied-headline">
                Selected opening filled and validated
              </p>
              {/* THE QUALIFIER TRAVELS WITH THE CLAIM, always. A success line on
                its own is exactly where an unearned statement about the whole
                model would take hold. */}
              <p className="panel__note" data-testid="hole-fill-applied-qualifier">
                {HOLE_FILL_APPLIED_QUALIFIER}
              </p>
              {lastApplied.undoable ? (
                <div className="panel__actions">
                  <button
                    type="button"
                    className="action"
                    onClick={controls.undoLastFill}
                    disabled={committing}
                    data-testid="undo-fill"
                  >
                    {commitState === HoleFillCommitState.Undoing
                      ? 'Undoing…'
                      : HOLE_FILL_UNDO_ACTION}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {holeFill.commitError !== undefined ? (
            <p className="repair__error-message" role="alert" data-testid="hole-fill-commit-error">
              {holeFill.commitError.message}
            </p>
          ) : null}
        </div>
      </div>
    </PanelSection>
  );
}

/**
 * The part-size refusal, as one short line with the numbers behind an ⓘ.
 * REPAIR-UX-01: the limit is a fact the user needs; the policy is not.
 */
function SizeLimitNotice({
  detail,
  detailTestId,
}: {
  readonly detail: string;
  readonly detailTestId: string;
}): ReactNode {
  const info = useInfoDisclosure();
  return (
    <>
      <div className="holefill__limit">
        <p className="holefill__limit-line" data-testid="hole-fill-size-limit">
          {HOLE_FILL_SIZE_LIMIT_LINE}
        </p>
        <InfoButton disclosure={info} label="the size limit" testId="hole-fill-size-limit-info" />
      </div>
      <InfoPanel disclosure={info} label="the size limit">
        <p className="info-panel__text" data-testid={detailTestId}>
          {detail}
        </p>
      </InfoPanel>
    </>
  );
}

/** What automatic filling does and does not do. Shown in Advanced diagnostics. */
export function OpenBoundaryLimits(): ReactNode {
  return (
    <>
      <h3 className="panel__subtitle">What automatic filling does and does not do</h3>
      <ul className="repair__exclusions" data-testid="hole-fill-limits">
        {HOLE_FILL_LIMITS.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
    </>
  );
}

/* -------------------------------------------------------------- listing -- */

interface OpeningListProps {
  readonly rows: readonly HoleBoundaryRow[];
  readonly selectedLoopId: string | undefined;
  readonly disabled: boolean;
  readonly onSelect: (boundaryLoopId: string | undefined) => void;
}

/**
 * The openings of the active part, as a single-select radio group.
 *
 * A RADIO GROUP RATHER THAN A LIST OF BUTTONS, because that is what this is:
 * exactly one opening is chosen at a time, and the platform's radio semantics
 * give arrow-key navigation, a group label and a spoken "3 of 7" for free.
 * Rebuilding that from buttons and `aria-selected` would be less correct and
 * more code.
 *
 * A REFUSED OPENING IS STILL LISTED AND STILL SELECTABLE. Hiding it would leave
 * a user counting openings in their viewer and finding fewer here; disabling it
 * would remove the explanation along with the row. It is selectable, it
 * highlights in the viewport, it says why it cannot be filled, and it offers no
 * Preview button.
 *
 * THE REASON IS ASSOCIATED WITH THE INPUT through `aria-describedby`, so a
 * screen-reader user hears why an opening is unavailable as part of the option
 * rather than having to find a paragraph elsewhere on the page.
 */
function OpeningList({ rows, selectedLoopId, disabled, onSelect }: OpeningListProps): ReactNode {
  return (
    <fieldset className="holefill__openings" data-testid="hole-fill-openings">
      <legend className="panel__subtitle">Choose one opening</legend>
      {rows.map((row) => {
        const reasonId = `opening-reason-${row.boundaryLoopId}`;
        return (
          <label
            className="holefill__opening"
            key={row.boundaryLoopId}
            data-testid={`opening-${String(row.displayIndex)}`}
            data-fillable={row.fillable ? 'true' : 'false'}
          >
            <input
              type="radio"
              name="open-boundary"
              value={row.boundaryLoopId}
              checked={selectedLoopId === row.boundaryLoopId}
              disabled={disabled}
              aria-describedby={reasonId}
              onChange={() => {
                onSelect(row.boundaryLoopId);
              }}
            />
            <span className="holefill__opening-name">{describeOpening(row.displayIndex)}</span>
            <span className="holefill__opening-size">{describeOpeningSize(row.vertexCount)}</span>
            {/* MEANING IN WORDS, NEVER ONLY IN COLOUR. The row tint is an aid;
                this sentence is the information. */}
            <span className="holefill__opening-verdict" id={reasonId}>
              {row.fillable
                ? OPENING_ELIGIBLE
                : row.refusal === undefined
                  ? OPENING_INELIGIBLE
                  : `${OPENING_INELIGIBLE}. ${describeBoundaryRefusal(row.refusal)}`}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** Re-exported so a test can assert the ceiling the panel actually enforces. */
export { HOLE_FILL_MAX_PART_FACES };
