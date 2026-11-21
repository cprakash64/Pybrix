import type { ReactNode } from 'react';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { Icon } from './shell/Icon';

/**
 * Status log. Uses a polite live region so screen readers announce new entries
 * without interrupting, which suits a log of results rather than alerts.
 *
 * Shown in the tool panel's footer in every workspace. It is headed "Activity",
 * not "History": it records what happened, and CAD Fixer keeps no multi-step
 * undo history that the word would suggest.
 */
export function StatusPanel(): ReactNode {
  const { status } = useWorkspaceState();
  const store = useWorkspaceStore();

  if (status.length === 0) return null;
  return (
    <details className="activity-disclosure">
      <summary tabIndex={0}>Activity</summary>
      <section className="status" aria-label="Status">
        <div className="status__bar">
          <h2 className="status__heading">
            <Icon name="history" size={12} />
            Activity
          </h2>
          <button
            type="button"
            className="status__clear"
            onClick={() => {
              store.clearStatus();
            }}
            disabled={status.length === 0}
            data-testid="clear-status"
          >
            Clear
          </button>
        </div>
        <ol className="status__list" aria-live="polite" data-testid="status-list">
          {status.length === 0 ? (
            <li className="status__empty" data-testid="status-empty">
              No activity yet.
            </li>
          ) : (
            status.map((entry) => (
              <li key={entry.id} className={`status__entry status__entry--${entry.severity}`}>
                <span className="status__severity">{entry.severity}</span>
                <span className="status__message" title={entry.message}>
                  {entry.message}
                </span>
              </li>
            ))
          )}
        </ol>
      </section>
    </details>
  );
}
