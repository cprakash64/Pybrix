import { useEffect, useRef, type ReactNode } from 'react';
import { useWorkspaceState } from '../state/store-context';
import { WorkflowId } from '../state/workflows';
import { ExportSummary } from './ExportSummary';
import { ModelExportPanel, ModelPanel } from './ModelPanel';
import { IssueInspector } from './IssueInspector';
import { SplitInspector } from './SplitInspector';
import { TextureInspector } from './TextureInspector';
import { PartSelector } from './PartSelector';
import { RuntimePanel } from './RuntimePanel';
import { Icon } from './shell/Icon';
import { keepTabWithin } from './shell/focus-trap';
import { IconButton, PanelSection } from './shell/primitives';
import { useShellLayout } from './shell/shell-layout';

/**
 * The right-hand inspector: facts about what is open.
 *
 * COLLAPSING HIDES, IT DOES NOT UNMOUNT. The Export section owns the active-part
 * export, whose hook tracks a running export; dropping it to save a few pixels
 * would orphan that operation. The collapsed rail is a separate element beside
 * the hidden panel.
 *
 * Below 1200 px the same element becomes an overlay drawer. CSS decides which
 * presentation applies; React only records the two flags.
 */
export function Inspector({ inert = false }: { readonly inert?: boolean }): ReactNode {
  const { model, selectedWorkflow } = useWorkspaceState();
  const repairWorkspace = selectedWorkflow === undefined || selectedWorkflow === WorkflowId.Repair;
  const convertWorkspace = selectedWorkflow === WorkflowId.Convert;
  const splitWorkspace = selectedWorkflow === WorkflowId.Split;
  const textureWorkspace = selectedWorkflow === WorkflowId.Texture;
  const layout = useShellLayout();
  const collapsed = layout.inspectorCollapsed;
  const panelRef = useRef<HTMLElement>(null);
  const modal = layout.modalDrawer === 'inspector';

  // A NEW DOCUMENT STARTS A NEW SESSION: the panel returns to its collapsed
  // default. Within one document the user's own open/close is respected, and
  // nothing else (a load, a selection, a repair, a workspace change) opens it.
  const documentId = model?.handle.documentId;
  const lastDocumentId = useRef<string | undefined>(undefined);
  const { setInspectorCollapsed } = layout;
  useEffect(() => {
    if (documentId !== undefined && documentId !== lastDocumentId.current) {
      if (lastDocumentId.current !== undefined) setInspectorCollapsed(true);
      lastDocumentId.current = documentId;
    }
  }, [documentId, setInspectorCollapsed]);

  return (
    <>
      <aside
        ref={panelRef}
        id="inspector"
        className="inspector"
        aria-label="Inspector"
        data-collapsed={collapsed ? 'true' : 'false'}
        data-drawer-open={layout.inspectorDrawerOpen ? 'true' : 'false'}
        data-testid="inspector"
        inert={inert}
        tabIndex={-1}
        {...(modal ? { role: 'dialog', 'aria-modal': true } : {})}
        onKeyDown={(event) => {
          if (modal && panelRef.current !== null) keepTabWithin(event, panelRef.current);
        }}
      >
        <div className="inspector__header">
          <h2 className="inspector__title">Inspector</h2>
          <IconButton
            label="Collapse inspector"
            icon="panel"
            tooltip="left"
            iconSize={15}
            className="inspector__collapse"
            onClick={() => {
              layout.setInspectorCollapsed(true);
            }}
            testId="collapse-inspector"
          />
          <IconButton
            label="Close inspector"
            icon="x"
            tooltip="left"
            iconSize={15}
            className="inspector__close"
            onClick={layout.closeDrawers}
            testId="close-inspector"
          />
        </div>

        {/*
          CONTEXT FIRST, THEN FACTS, THEN OPERATIONS ON THE FILE (UI-06).

          What the current workspace is pointing at — the selected finding, the
          output about to be written, the active cut, the selected surface — is
          the one thing that changes as the user works, so it leads. The model's
          facts follow, then the two exports, then runtime diagnostics. With the
          Model section first, every workspace's context sat below the fold on a
          900 px screen, and Repair scrolled the inspector to reach it — an
          offset that then leaked into every other workspace.
        */}
        <div className="inspector__body">
          <PanelSection title="Selection">
            {model !== undefined && model.parts.length > 1 ? <PartSelector /> : null}
            {/* The selected finding is Repair's; Convert's selection is the
                output it will write. Other workspaces keep their own selection
                surfaces for now. */}
            {repairWorkspace ? (
              <IssueInspector />
            ) : convertWorkspace ? (
              <ExportSummary />
            ) : splitWorkspace ? (
              <SplitInspector />
            ) : textureWorkspace ? (
              <TextureInspector />
            ) : model === undefined ? (
              <p className="panel__empty">Nothing is selected. Open a model to begin.</p>
            ) : model.parts.length <= 1 ? (
              <p className="panel__note" data-testid="selection-single-part">
                This model has one part, so every workflow acts on the whole model.
              </p>
            ) : null}
          </PanelSection>

          <PanelSection title="Model">
            <ModelPanel />
          </PanelSection>

          {/* Hidden, not unmounted, with no model: there is nothing to
              export, and the hook inside tracks any export in flight. */}
          <div hidden={model === undefined} data-testid="inspector-export-section">
            <PanelSection title="Export">
              <ModelExportPanel />
            </PanelSection>
          </div>

          <PanelSection title="Runtime">
            <RuntimePanel />
          </PanelSection>
        </div>
      </aside>

      {collapsed ? (
        <aside
          className="inspector-rail"
          aria-label="Inspector (collapsed)"
          data-testid="inspector-rail"
        >
          <button
            type="button"
            className="icon-btn inspector-rail__expand"
            aria-label="Show inspector"
            aria-expanded={false}
            aria-controls="inspector"
            data-tooltip="Show inspector"
            data-tooltip-side="left"
            onClick={() => {
              layout.setInspectorCollapsed(false);
            }}
            data-testid="expand-inspector"
          >
            <Icon name="panel" size={15} />
          </button>
          <span className="inspector-rail__label" aria-hidden="true">
            INSPECTOR
          </span>
        </aside>
      ) : null}
    </>
  );
}
