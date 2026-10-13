import type { ReactNode } from 'react';
import { describeUnit } from '../state/model';
import { useWorkspaceState } from '../state/store-context';
import { useIssueNavigation } from '../state/use-issue-navigation';
import { AnalysisState, ImportState } from '../state/workspace-store';
import { describePhase } from './ImportDropZone';
import { Icon, type IconName } from './shell/Icon';
import { PRODUCT_VERSION } from './shell/brand';
import { useShellLayout } from './shell/shell-layout';

/**
 * The status bar: what the application is doing, and the loaded model's size.
 *
 * EVERY VALUE IS READ FROM THE STORE. Triangle and vertex counts are the ones
 * the worker measured at import; the unit is the document's own statement,
 * worded by the same `describeUnit` the Model panel uses; the topology entry
 * reflects an analysis that actually ran. Nothing here is estimated, and
 * nothing is shown for a model that is not loaded.
 *
 * THE UNIT IS A STATUS, NOT A SWITCH. CAD Fixer never converts or rescales
 * units, so a control that looked as though it could would be a false promise.
 *
 * THE HEALTH ENTRY IS THE MESH ANALYSIS SUMMARY, from the same derivation
 * (`deriveHealthSummary`), and it carries the same qualifier — as its tooltip
 * and in its accessible name — so "No issues found" is never read without what
 * the checks do not cover.
 */
export function StatusBar(): ReactNode {
  const { model, importProgress, analysis } = useWorkspaceState();
  const layout = useShellLayout();

  const importing =
    importProgress.state === ImportState.Screening ||
    importProgress.state === ImportState.Reading ||
    importProgress.state === ImportState.Parsing ||
    importProgress.state === ImportState.Validating;
  const analysing = analysis.state === AnalysisState.Analyzing;
  // The same summary the Mesh analysis section shows, from the same derivation.
  const { summary } = useIssueNavigation();
  const health: HealthEntry | undefined =
    model === undefined
      ? undefined
      : summary.tone === 'neutral'
        ? {
            text: 'Model details',
            tooltip: summary.qualifier,
            tone: 'neutral',
            icon: 'info',
          }
        : {
            text: 'Model details',
            tooltip: summary.qualifier,
            tone: 'neutral',
            icon: 'info',
          };

  return (
    <footer className="statusbar" data-testid="status-bar">
      <div className="statusbar__job" role="status" data-testid="status-bar-job">
        {importing ? (
          <>
            <span className="statusbar__spinner" aria-hidden="true">
              <Icon name="loader" size={13} />
            </span>
            <span className="statusbar__job-label">{describePhase(importProgress.state)}</span>
            <span className="statusbar__mono">{Math.round(importProgress.fraction * 100)}%</span>
          </>
        ) : analysing ? (
          <>
            <span className="statusbar__spinner" aria-hidden="true">
              <Icon name="loader" size={13} />
            </span>
            <span className="statusbar__job-label">Checking model…</span>
          </>
        ) : (
          <>
            <span className="statusbar__dot" aria-hidden="true" />
            <span>Ready</span>
          </>
        )}
      </div>

      <p className="statusbar__privacy" data-testid="privacy-badge">
        <Icon name="lock" size={12} />
        <span>Your 3D file stays on this device</span>
      </p>

      <span className="statusbar__spacer" />

      {model === undefined ? null : (
        <>
          <span className="statusbar__stat">
            Triangles{' '}
            <b className="statusbar__mono" data-testid="status-triangles">
              {model.triangleCount.toLocaleString()}
            </b>
          </span>
          <span className="statusbar__stat statusbar__stat--vertices">
            Vertices{' '}
            <b className="statusbar__mono" data-testid="status-vertices">
              {model.vertexCount.toLocaleString()}
            </b>
          </span>
          <span
            className="statusbar__unit"
            data-testid="status-unit"
            title="Unit stated by the file"
          >
            {describeUnit(model.source)}
          </span>
          {health === undefined ? null : (
            <button
              type="button"
              className={`statusbar__health statusbar__health--${health.tone}`}
              data-tooltip={health.tooltip}
              data-tooltip-side="above"
              aria-label={`${health.text}. ${health.tooltip} Open the Inspector.`}
              onClick={() => {
                layout.showInspector();
              }}
              data-testid="status-health"
            >
              <Icon name={health.icon} size={12} />
              {health.text}
            </button>
          )}
        </>
      )}

      {/* The version only: the header already says Technical Preview, and
          Help → About says both. */}
      <span className="statusbar__release" data-testid="release-version">
        {PRODUCT_VERSION}
      </span>
    </footer>
  );
}

interface HealthEntry {
  readonly text: string;
  readonly tooltip: string;
  readonly tone: 'neutral' | 'warning' | 'error' | 'ok';
  readonly icon: IconName;
}
