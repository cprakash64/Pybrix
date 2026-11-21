import type { ReactNode } from 'react';
import {
  SPLIT_COPY,
  describeConnectorResult,
  describeCut,
  describeOutlines,
  formatArea,
  formatLength,
  formatVolume,
} from '../state/split-presentation';
import { useWorkspaceState } from '../state/store-context';
import { useSplitControls } from '../state/workflow-controllers';
import { PropertyRow } from './shell/primitives';

/**
 * The inspector's Split selection: the active cut, and the selected piece.
 *
 * CONTEXTUAL, NOT A COPY OF THE PANEL. It states what the cut is and what the
 * engine measured — cross-section area, outlines, piece volumes — and for the
 * selected piece its real triangle count and extent. No bed-fit row: CAD Fixer
 * has no printer profiles, so a "fits" answer would be invented.
 */
export function SplitInspector(): ReactNode {
  const { model, activePartId } = useWorkspaceState();
  const split = useSplitControls();
  if (model === undefined || split.part === undefined)
    return <p className="panel__empty">Nothing is selected. Open a model to begin.</p>;

  const section = split.preview?.section ?? split.applied?.section;
  const metrics = split.preview?.metrics ?? split.applied?.metrics;
  const connector = split.preview?.connector ??
    split.applied?.connector ?? {
      kind: split.connector.kind,
    };
  const applied = split.applied;
  const selectedPiece =
    applied === undefined
      ? undefined
      : activePartId === applied.pieceA
        ? 'A'
        : activePartId === applied.pieceB
          ? 'B'
          : undefined;
  const part = split.part;
  const size = part.bounds?.size;

  return (
    <div className="export-summary" data-testid="split-inspector">
      <p className="export-summary__eyebrow">Active cut</p>
      <dl className="property-grid">
        <PropertyRow
          label="Plane"
          mono={false}
          value={describeCut(split.plane, split.offset, split.unit)}
          testId="split-inspector-plane"
        />
        <PropertyRow
          label="Connector"
          mono={false}
          value={describeConnectorResult(connector.kind)}
          testId="split-inspector-connector"
        />
        {section === undefined || (section.loopCount === 0 && section.area === 0) ? null : (
          <>
            <PropertyRow
              label={split.preview === undefined ? 'Last cut face' : 'Cut face'}
              value={formatArea(section.area, split.unit)}
              testId="split-inspector-area"
            />
            <PropertyRow
              label={split.preview === undefined ? 'Last outlines' : 'Outlines'}
              value={describeOutlines(section.loopCount)}
              testId="split-inspector-outlines"
            />
          </>
        )}
      </dl>

      <p className="export-summary__eyebrow">
        {selectedPiece === undefined
          ? 'Selected part'
          : selectedPiece === 'A'
            ? SPLIT_COPY.pieceA
            : SPLIT_COPY.pieceB}
      </p>
      <dl className="property-grid">
        <PropertyRow
          label="Name"
          mono={false}
          value={part.name ?? part.partId}
          testId="split-inspector-part"
        />
        <PropertyRow
          label="Triangles"
          value={part.triangleCount.toLocaleString()}
          testId="split-inspector-triangles"
        />
        {size === undefined ? null : (
          <PropertyRow
            label="Size"
            // A number never parts from its unit; the line may break only at
            // a "×" (UI-06: "60.0" and "mm" wrapped onto separate lines).
            value={size
              .map((value) => formatLength(value, split.unit).replace(' ', '\u00a0'))
              .join(' × ')}
            testId="split-inspector-size"
          />
        )}
        {metrics !== undefined &&
        metrics.volumeInterpretable !== false &&
        selectedPiece !== undefined ? (
          <PropertyRow
            label="Volume"
            value={formatVolume(
              selectedPiece === 'A' ? metrics.pieceAFinalVolume : metrics.pieceBFinalVolume,
              split.unit,
            )}
            testId="split-inspector-volume"
          />
        ) : null}
      </dl>
    </div>
  );
}
