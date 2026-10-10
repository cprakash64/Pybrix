import { useId, type ReactNode } from 'react';
import { useWorkspaceState } from '../state/store-context';
import { useFileIntake } from './FileIntake';
import { WorkflowNav } from './WorkflowNav';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import {
  BRAND_LOCKUP_HEIGHT,
  BRAND_LOCKUP_URL,
  BRAND_LOCKUP_WIDTH,
  BRAND_TILE_URL,
  PRODUCT_NAME,
  PRODUCT_STATUS,
  PRODUCT_SUMMARY,
  PRODUCT_VERSION,
} from './shell/brand';
import { Icon } from './shell/Icon';
import { CompactSwitch, IconButton } from './shell/primitives';
import { useOpenConvertWorkspace } from './shell/open-convert';
import { useDismissableMenu, useShellLayout } from './shell/shell-layout';

/**
 * The application's top bar.
 *
 * EVERY CONTROL HERE IS A COMMAND THAT ALREADY EXISTS. Open is the file intake
 * every import goes through; Export goes to the Convert workspace, which is
 * what "Export" means everywhere in the product; the centred workspace
 * navigation selects workflows, and below the desktop tier the compact
 * switcher replaces it (never both at once). Controls the reference design shows that CAD
 * Fixer has no command behind — Save project, Recent files, Redo, an account
 * menu — are deliberately absent rather than drawn disabled forever. Undo is
 * absent too: each workflow owns its own undo in its panel, and a global Undo
 * that could reach only some of them would be wrong about the rest.
 */
export function TopBar(): ReactNode {
  const { model } = useWorkspaceState();
  const { openPicker, isImporting } = useFileIntake();
  const openConvert = useOpenConvertWorkspace();
  const layout = useShellLayout();

  return (
    <header className="topbar">
      {/* THREE ZONES, so the workspace navigation is centred on the bar itself
          rather than on whatever space the left-hand controls leave over. */}
      <div className="topbar__start">
        <div className="topbar__brand">
          {/* Decorative: the heading beside it carries the name, so the image
              is not announced a second time. Width and height reserve its box
              before it decodes, so the bar never shifts. */}
          <img
            className="topbar__mark"
            src={BRAND_TILE_URL}
            width={26}
            height={26}
            alt=""
            decoding="async"
            data-testid="brand-mark"
          />
          <h1 className="topbar__title">{PRODUCT_NAME}</h1>
          <span className="topbar__status" data-testid="release-stage">
            {PRODUCT_STATUS}
          </span>
        </div>
        <span className="topbar__divider topbar__divider--brand" aria-hidden="true" />

        {/* Compact tier only: CSS hides it wherever the centred navigation is
            shown, so no width ever has two workspace selectors. */}
        <div className="topbar__switcher">
          <WorkspaceSwitcher />
        </div>
        <span className="topbar__divider topbar__divider--switcher" aria-hidden="true" />

        <div className="topbar__file" role="group" aria-label="File">
          <IconButton
            label="Open a model file (STL, OBJ or 3MF)"
            icon="open"
            text="Open"
            className="topbar__action"
            onClick={openPicker}
            disabled={isImporting}
            testId="browse-button"
          />
          <IconButton
            label={
              model === undefined
                ? 'Export — open a model first'
                : 'Export the whole document as STL, OBJ or 3MF'
            }
            icon="download"
            text="Export"
            className="topbar__action"
            onClick={openConvert}
            disabled={model === undefined}
            testId="topbar-export"
          />
        </div>
      </div>

      <div className="topbar__center">
        <WorkflowNav />
      </div>

      <div className="topbar__end">
        <IconButton
          label={layout.toolDrawerOpen ? 'Hide workspace tools' : 'Show workspace tools'}
          icon="panel-left"
          className="topbar__action topbar__drawer-toggle topbar__drawer-toggle--tools"
          pressed={layout.toolDrawerOpen}
          onClick={layout.toggleToolDrawer}
          controls="tool-panel"
          testId="toggle-tool-drawer"
        />
        <IconButton
          label={layout.inspectorDrawerOpen ? 'Hide inspector' : 'Show inspector'}
          icon="panel"
          className="topbar__action topbar__drawer-toggle topbar__drawer-toggle--inspector"
          pressed={layout.inspectorDrawerOpen}
          onClick={layout.toggleInspectorDrawer}
          controls="inspector"
          testId="toggle-inspector-drawer"
        />
        <HelpMenu />
        <SettingsMenu />
      </div>
    </header>
  );
}

/**
 * How to drive the viewport. Static facts about the camera controls, which are
 * OrbitControls' mapping plus the navigation mode in the viewport toolbar.
 *
 * The triggers here are plain buttons rather than `IconButton`s because they
 * carry `aria-expanded`, which the menu hook uses to return focus on Esc. They
 * are DISCLOSURES, not ARIA menus: what they reveal is text, a switch or a list
 * of ordinary buttons, so `aria-haspopup` — which promises a `role="menu"` with
 * arrow-key navigation — would announce behaviour that is not there.
 */
function HelpMenu(): ReactNode {
  const { open, toggle, containerRef } = useDismissableMenu();
  const menuId = useId();
  return (
    <div className="topbar__menu" ref={containerRef}>
      <button
        type="button"
        className="icon-btn topbar__action"
        aria-label="Help"
        data-tooltip="Help"
        data-tooltip-side="below"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        data-testid="help-menu"
      >
        <Icon name="help" size={16} />
      </button>
      {open ? (
        <div className="menu menu--end" id={menuId}>
          <p className="menu__eyebrow">Viewport controls</p>
          <dl className="menu__shortcuts">
            <div>
              <dt>Orbit</dt>
              <dd>Left-drag · one finger</dd>
            </div>
            <div>
              <dt>Pan</dt>
              <dd>Right-drag · two fingers</dd>
            </div>
            <div>
              <dt>Zoom</dt>
              <dd>Scroll · pinch</dd>
            </div>
            <div>
              <dt>Pan with left-drag</dt>
              <dd>Pan tool in the viewport</dd>
            </div>
          </dl>
          {/* ABOUT — the one place the full lockup appears. Its wordmark is
              navy, so it sits on the light brand plate rather than on the dark
              menu. Standalone, so the image itself is named. */}
          <section className="about" aria-label={`About ${PRODUCT_NAME}`} data-testid="about">
            <div className="about__plate">
              <img
                className="about__lockup"
                src={BRAND_LOCKUP_URL}
                width={BRAND_LOCKUP_WIDTH}
                height={BRAND_LOCKUP_HEIGHT}
                alt={PRODUCT_NAME}
                decoding="async"
                data-testid="about-lockup"
              />
            </div>
            <p className="about__status" data-testid="about-status">
              {PRODUCT_STATUS} · {PRODUCT_VERSION}
            </p>
            <p className="about__summary">{PRODUCT_SUMMARY}</p>
            <p className="menu__note">
              Models are processed locally in your browser. Your files are never uploaded. If you
              choose Auto Split (Beta), six rendered views of the model and limited geometry
              metadata are sent for AI analysis; Repair, Convert and Manual Split stay local.
            </p>
          </section>
          {/* The licences of the third-party code and artwork this build
              ships, as a static file beside the application. Relative, so it
              resolves under any deployment path. */}
          <a
            className="menu__link"
            href="third-party-notices.txt"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="third-party-notices"
          >
            Third-party notices
          </a>
        </div>
      ) : null}
    </div>
  );
}

function SettingsMenu(): ReactNode {
  const { open, toggle, containerRef } = useDismissableMenu();
  const layout = useShellLayout();
  const menuId = useId();
  return (
    <div className="topbar__menu" ref={containerRef}>
      <button
        type="button"
        className="icon-btn topbar__action topbar__settings"
        aria-label="Settings"
        data-tooltip="Settings"
        data-tooltip-side="below"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        data-testid="settings-menu"
      >
        <Icon name="settings" size={16} />
      </button>
      {open ? (
        <div className="menu menu--end" id={menuId}>
          <p className="menu__eyebrow">Preferences</p>
          <CompactSwitch
            label="Inspector panel"
            checked={!layout.inspectorCollapsed}
            onChange={(checked) => {
              layout.setInspectorCollapsed(!checked);
            }}
            testId="setting-inspector"
          />
        </div>
      ) : null}
    </div>
  );
}
