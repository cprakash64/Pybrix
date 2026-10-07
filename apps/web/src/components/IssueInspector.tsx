import type { ReactNode } from 'react';
import { RepairOperation } from '@cadfixer/geometry-runtime';
import {
  describeBoundaryRefusal,
  HOLE_FILL_APPLY_ACTION,
  HOLE_FILL_DISCARD_ACTION,
  HOLE_FILL_PREVIEW_ACTION,
  HOLE_FILL_PREVIEW_NOT_APPLIED,
  OPENING_ELIGIBLE,
} from '../state/hole-fill-presentation';
import {
  describeCount,
  describeSeverity,
  RepairIssueId,
  type RepairIssue,
} from '../state/repair-issues';
import { useWorkspaceState } from '../state/store-context';
import { useIssueNavigation, type ResolvedIssueSelection } from '../state/use-issue-navigation';
import { useHoleFillControls, useRepairControls } from '../state/workflow-controllers';
import { HoleFillWorkState } from '../state/workspace-store';
import { PropertyRow } from './shell/primitives';

/**
 * The inspector's view of the selected issue: what it is, how many, which
 * occurrence, where — and what CAD Fixer can actually do about it.
 *
 * EVERY ACTION IS A REAL ONE, AND SAYS HOW FAR IT REACHES.
 *
 *   - An open boundary is fixed ONE AT A TIME: the action previews a fill of
 *     exactly the boundary on screen, through the same workflow as the Open
 *     boundaries list, and only when the engine can attempt it.
 *   - Degenerate faces, duplicate faces and winding conflicts are fixed by
 *     conservative repair, which acts on the WHOLE PART. The button says so,
 *     and previews rather than applies: Auto repair shows the result.
 *   - Everything else has no automatic repair in CAD Fixer, and the panel says
 *     that instead of offering a button that cannot help.
 *
 * "Dismiss" clears the selection. It hides nothing and deletes nothing: the
 * finding is still in the list.
 */
export function IssueInspector(): ReactNode {
  const { model } = useWorkspaceState();
  const navigation = useIssueNavigation();
  const selection = navigation.selection;
  /*
   * NO SCROLLING. The Selection section is the inspector's first section
   * (UI-06), so a newly selected issue is already in view. The scroll this
   * replaced moved the inspector's body to reach a section below the Model
   * facts, and the offset then persisted into every other workspace.
   */
  if (model === undefined) {
    return <p className="panel__empty">Nothing is selected. Open a model to begin.</p>;
  }
  if (selection === undefined) {
    return (
      <p className="panel__empty" data-testid="issue-inspector-empty">
        Select a detected issue in Repair to see where it is and what can be done about it.
      </p>
    );
  }

  const { issue, occurrence, location } = selection;
  return (
    <div className="issue-inspector" data-testid="issue-inspector">
      <p className="issue-inspector__title">
        <span className={`severity-dot severity-dot--${issue.severity}`} aria-hidden="true" />
        <span className="issue-inspector__name" data-testid="issue-inspector-name">
          {issue.label}
        </span>
        <span className={`issue-inspector__severity issue-inspector__severity--${issue.severity}`}>
          {describeSeverity(issue.severity)}
        </span>
      </p>
      <p className="panel__note">{issue.help}</p>

      <dl className="property-grid">
        <PropertyRow label="Count" value={describeCount(issue)} testId="issue-inspector-count" />
        {occurrence === undefined ? null : (
          <PropertyRow
            label="Location"
            value={`${String(occurrence + 1)} / ${issue.occurrenceCount.toLocaleString()}`}
            testId="issue-inspector-position"
          />
        )}
      </dl>
      {location === undefined ? null : (
        <p className="issue-inspector__coordinates" data-testid="issue-inspector-coordinates">
          {formatPoint(location.center, model.source.unit)}
        </p>
      )}
      {location === undefined ? null : (
        <p className="issue-inspector__coordinates-note">
          Part coordinates, as stored in the file.
        </p>
      )}

      <FixAction issue={issue} selection={selection} />

      <div className="issue-inspector__actions">
        <button
          type="button"
          className="secondary-action"
          onClick={navigation.dismiss}
          data-testid="issue-dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function FixAction({
  issue,
  selection,
}: {
  readonly issue: RepairIssue;
  readonly selection: ResolvedIssueSelection;
}): ReactNode {
  const { holeFill: holeFillState } = useWorkspaceState();
  const holeFill = useHoleFillControls();
  const repair = useRepairControls();

  switch (issue.id) {
    case RepairIssueId.OpenBoundaries: {
      const row =
        selection.occurrence === undefined
          ? undefined
          : holeFillState.inventory.rows[selection.occurrence];
      if (row === undefined)
        return <SuggestedFix text="Select a boundary to see what can be done with it." />;
      if (holeFillState.workState === HoleFillWorkState.Ready) {
        return (
          <SuggestedFix text={HOLE_FILL_PREVIEW_NOT_APPLIED}>
            <button
              type="button"
              className="primary-action"
              onClick={holeFill.applyFill}
              disabled={holeFill.isBusy}
              data-testid="issue-apply-fill"
            >
              {HOLE_FILL_APPLY_ACTION}
            </button>
            <button
              type="button"
              className="secondary-action"
              onClick={holeFill.discardPreview}
              disabled={holeFill.isBusy}
            >
              {HOLE_FILL_DISCARD_ACTION}
            </button>
          </SuggestedFix>
        );
      }
      if (!row.fillable) {
        return (
          <SuggestedFix
            text={
              row.refusal === undefined
                ? 'Pybrix cannot attempt this boundary.'
                : describeBoundaryRefusal(row.refusal)
            }
          />
        );
      }
      return (
        <SuggestedFix
          text={`${OPENING_ELIGIBLE}: a flat fill of this one boundary, previewed before anything changes.`}
        >
          <button
            type="button"
            className="primary-action"
            onClick={holeFill.previewFill}
            disabled={holeFill.isBusy || holeFill.partTooLarge}
            aria-busy={holeFillState.workState === HoleFillWorkState.Generating}
            data-testid="issue-preview-fill"
          >
            {HOLE_FILL_PREVIEW_ACTION}
          </button>
        </SuggestedFix>
      );
    }
    case RepairIssueId.DegenerateFaces:
    case RepairIssueId.DuplicateFaces:
    case RepairIssueId.WindingConflicts: {
      const operations = operationsFor(issue.id);
      const scope =
        issue.id === RepairIssueId.WindingConflicts
          ? 'Makes neighbouring triangles agree on winding across the whole part.'
          : `Removes all ${describeCount(issue)} of this kind from the whole part${
              issue.id === RepairIssueId.DuplicateFaces ? ' (reversed duplicates are kept)' : ''
            }.`;
      return (
        <SuggestedFix
          text={`${scope} Repair previews the result first; nothing changes until you apply it.`}
        >
          <button
            type="button"
            className="primary-action"
            onClick={() => {
              repair.previewOperations(operations);
            }}
            disabled={repair.isBusy || issue.count === 0}
            data-testid="issue-preview-repair"
          >
            Preview repair (whole part)
          </button>
        </SuggestedFix>
      );
    }
    case RepairIssueId.NonManifoldEdges:
    case RepairIssueId.NonManifoldVertices:
    case RepairIssueId.SelfIntersections:
    case RepairIssueId.Components:
      return (
        <SuggestedFix text="Pybrix has no automatic repair for this. Its location is shown so it can be fixed in the source model." />
      );
  }
}

function SuggestedFix({
  text,
  children,
}: {
  readonly text: string;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <div className="suggested-fix" data-testid="issue-suggested-fix">
      <p className="suggested-fix__eyebrow">What Pybrix can do</p>
      <p className="suggested-fix__text">{text}</p>
      {children === undefined ? null : <div className="suggested-fix__actions">{children}</div>}
    </div>
  );
}

function operationsFor(id: RepairIssueId): readonly RepairOperation[] {
  switch (id) {
    case RepairIssueId.DegenerateFaces:
      return [RepairOperation.RemoveRepeatedPositionFaces, RepairOperation.RemoveZeroAreaFaces];
    case RepairIssueId.DuplicateFaces:
      return [RepairOperation.RemoveDuplicateFaces];
    case RepairIssueId.WindingConflicts:
      return [RepairOperation.UnifyWinding];
    default:
      return [];
  }
}

const UNIT_SYMBOL: Readonly<Record<string, string>> = {
  micron: 'µm',
  millimeter: 'mm',
  centimeter: 'cm',
  inch: 'in',
  foot: 'ft',
  meter: 'm',
};

/** Three decimals, trailing zeros dropped; a unit only when the file states one. */
function formatPoint(point: readonly [number, number, number], unit: string | undefined): string {
  const symbol = unit === undefined ? '' : ` ${UNIT_SYMBOL[unit] ?? unit}`;
  const format = (value: number): string => {
    const fixed = value.toFixed(3).replace(/\.?0+$/, '');
    return fixed === '-0' ? '0' : fixed;
  };
  const [x, y, z] = point;
  return `X ${format(x)}  Y ${format(y)}  Z ${format(z)}${symbol}`;
}
