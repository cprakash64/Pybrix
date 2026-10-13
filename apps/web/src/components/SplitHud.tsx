import type { ReactNode } from 'react';
import { SPLIT_COPY, describeCut, describeSection } from '../state/split-presentation';
import { useAutoSplitControls, useSplitControls } from '../state/workflow-controllers';
import { SplitPhase } from '../state/use-split-workflow';

/**
 * The viewport's cut capsule: which cut, where, and — once the engine has
 * computed one — the cross-section it actually produces.
 *
 * ONLY MEASURED METRICS. The position is the setting; the area and outline
 * count exist only after a preview, because only the Boolean split knows them.
 * Before that the second line is the arrow hint rather than an estimate.
 * Piece identity is written in words beside each colour swatch, so it never
 * rests on colour alone.
 */
export function SplitHud(): ReactNode {
  const split = useSplitControls();
  const auto = useAutoSplitControls();
  // A cut capsule for a cut nobody has chosen, or for components that need no cut, would mislead.
  if (split.part === undefined || !auto.planeVisible) return null;
  const section = split.preview?.section ?? split.applied?.section;
  const showingPieces = split.preview !== undefined || split.applied !== undefined;

  return (
    <div
      className="issue-hud split-hud"
      role="group"
      aria-label="Active cut"
      data-testid="split-hud"
    >
      <details className="split-hud__disclosure">
        <summary tabIndex={0}>{showingPieces ? 'Cut details' : 'Cut plane'}</summary>
        <div className="split-hud__lines">
          <p className="split-hud__cut" data-testid="split-hud-cut">
            <span className="split-hud__name">Cut</span>{' '}
            {describeCut(split.plane, split.offset, split.unit)}
          </p>
          <p className="split-hud__detail" data-testid="split-hud-detail">
            {section !== undefined && split.phase !== SplitPhase.Computing
              ? describeSection(section, split.unit, split.preview === undefined)
              : SPLIT_COPY.hintDrag}
          </p>
        </div>
      </details>
      {!showingPieces ? <p className="split-hud__detail">{SPLIT_COPY.hintDrag}</p> : null}
      {showingPieces ? (
        <p className="split-hud__legend">
          <span className="piece-swatch piece-swatch--a" aria-hidden="true" />
          {SPLIT_COPY.pieceA}
          <span className="piece-swatch piece-swatch--b" aria-hidden="true" />
          {SPLIT_COPY.pieceB}
        </p>
      ) : null}
    </div>
  );
}
