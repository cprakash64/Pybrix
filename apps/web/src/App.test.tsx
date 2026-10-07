import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { GeometryClientProvider } from './runtime/client-context';
import { GeometryClient } from './runtime/geometry-client';
import { WorkspaceProvider } from './state/store-context';
import { WORKFLOWS, WorkflowId } from './state/workflows';
import { WorkspaceStore } from './state/workspace-store';

/**
 * The worker is injected, exactly as `main.tsx` injects it. The `Worker` global
 * is stubbed in `vitest.setup.ts` and never replies, so any test that appeared
 * to receive a worker result would be reading a fake — which is why none do.
 */
function renderApp(): WorkspaceStore {
  const store = new WorkspaceStore();
  const client = new GeometryClient({ onDiagnostic: (): void => undefined });
  render(
    <WorkspaceProvider store={store}>
      <GeometryClientProvider client={client}>
        <App />
      </GeometryClientProvider>
    </WorkspaceProvider>,
  );
  return store;
}

function dropFiles(files: readonly File[]): void {
  fireEvent.drop(screen.getByTestId('drop-zone'), { dataTransfer: { files } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('application shell', () => {
  it('renders the header and the local-processing statement', () => {
    renderApp();

    expect(screen.getByRole('heading', { level: 1, name: 'Pybrix' })).toBeInTheDocument();
    expect(screen.getByTestId('privacy-badge')).toHaveTextContent(
      'Models are processed locally in your browser',
    );
  });

  it('labels the release as the Technical Preview, not an internal development stage', () => {
    // Stage 6D-A4: the header read "Stage 0 — foundation" in public releases.
    renderApp();

    // BRAND-01: the header carries the status, the status bar the version.
    expect(screen.getByTestId('release-stage')).toHaveTextContent(/^Technical Preview$/);
    expect(screen.getByTestId('release-version')).toHaveTextContent(/^v0\.6\.1$/);
    expect(document.body.textContent).not.toMatch(/Stage \d|foundation/i);
  });

  it('states the import scope honestly before a file is chosen', () => {
    renderApp();
    const zone = screen.getByTestId('drop-zone').textContent;

    expect(zone).toMatch(/geometry only/i);
    expect(zone).toMatch(/faces must be triangles/i);
    expect(zone).toMatch(/requires any other extension is refused/i);
    expect(zone).toMatch(/never uploaded/i);
    // Nothing that implies the whole of 3MF, or material fidelity, is supported.
    expect(zone).not.toMatch(/all 3MF|every 3MF|full 3MF|materials are preserved/i);
  });

  it('renders the workspace regions a user needs to orient themselves', () => {
    renderApp();

    expect(screen.getByRole('region', { name: '3D workspace' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Import a model' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Workspaces' })).toBeInTheDocument();
  });

  it('logs the viewport failure jsdom causes, and nothing else, on first render', () => {
    // jsdom has no WebGL, so mounting legitimately produces one status entry.
    // Asserting the exact contents keeps this honest: nothing else may appear
    // at startup. The empty-log-on-load case is asserted end to end, where the
    // viewport actually succeeds.
    renderApp();

    const entries = within(screen.getByTestId('status-list')).getAllByRole('listitem');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveTextContent(/3D viewport could not start/i);
  });
});

/**
 * BRAND-01. The product's display name is Pybrix everywhere a user can meet it:
 * rendered text AND the text assistive technology and tooltips read. The legacy
 * name survives on purpose in identifiers (packages, test ids, CSS classes,
 * worker names, deployment paths) and in history, so this checks what is
 * RENDERED, never the repository.
 */
const LEGACY_NAME = /cad[\s_-]*fixer/i;

/** Every user-readable string in the document: text plus the attributes read aloud or shown. */
function userReadableText(): string {
  const attributes = [
    'aria-label',
    'title',
    'alt',
    'placeholder',
    'data-tooltip',
    'aria-description',
  ];
  const parts = [document.title, document.body.textContent];
  for (const element of document.body.querySelectorAll('*'))
    for (const name of attributes) {
      const value = element.getAttribute(name);
      if (value !== null) parts.push(value);
    }
  return parts.join('\n');
}

describe('brand identity', () => {
  it('names the product Pybrix in the header, beside a decorative mark', () => {
    renderApp();

    const mark = screen.getByTestId('brand-mark');
    // Decorative: the heading beside it carries the name, so it is not read twice.
    expect(mark).toHaveAttribute('alt', '');
    expect(mark.getAttribute('src')).toMatch(/pybrix-tile-96.*\.png$/);
    // Its box is reserved before it decodes, so the header cannot shift.
    expect(mark).toHaveAttribute('width', '26');
    expect(mark).toHaveAttribute('height', '26');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Pybrix$/);
  });

  it('shows the lockup, status, version and local-processing statement in Help', () => {
    renderApp();
    fireEvent.click(screen.getByTestId('help-menu'));

    const about = screen.getByRole('region', { name: 'About Pybrix' });
    // Standalone, so the image itself carries the name — once.
    const lockup = within(about).getByRole('img', { name: 'Pybrix' });
    expect(lockup.getAttribute('src')).toMatch(/pybrix-logo-horizontal.*\.png$/);
    expect(lockup).toHaveAttribute('width', '188');
    expect(lockup).toHaveAttribute('height', '63');
    expect(within(about).getByTestId('about-status')).toHaveTextContent(
      'Technical Preview · v0.6.1',
    );
    expect(about).toHaveTextContent('Models are processed locally in your browser.');
    expect(screen.getByTestId('third-party-notices')).toHaveAttribute(
      'href',
      'third-party-notices.txt',
    );
  });

  it('exposes the legacy product name nowhere a user can read it, in any workspace', () => {
    renderApp();
    fireEvent.click(screen.getByTestId('help-menu'));
    expect(userReadableText()).not.toMatch(LEGACY_NAME);

    for (const id of [
      WorkflowId.Convert,
      WorkflowId.Split,
      WorkflowId.Texture,
      WorkflowId.Repair,
    ]) {
      fireEvent.click(screen.getByTestId(`workflow-${id}`));
      expect(userReadableText(), id).not.toMatch(LEGACY_NAME);
    }
    fireEvent.click(screen.getByTestId('settings-menu'));
    expect(userReadableText()).not.toMatch(LEGACY_NAME);
  });

  it('offers the brand line on the empty drop target, and no lockup there', () => {
    renderApp();
    const zone = screen.getByTestId('drop-zone');
    expect(within(zone).getByTestId('drop-tagline')).toHaveTextContent(
      'Repair, convert, split and texture — locally in your browser.',
    );
    expect(within(zone).queryAllByRole('img')).toHaveLength(0);
  });
});

describe('workflow navigation', () => {
  it('lists all five planned workflows', () => {
    renderApp();

    for (const workflow of WORKFLOWS) {
      expect(screen.getByTestId(`workflow-${workflow.id}`)).toHaveTextContent(workflow.label);
    }
    expect(WORKFLOWS).toHaveLength(5);
  });

  /**
   * NAVIGATION AVAILABILITY IS NOT OPERATION AVAILABILITY (UI-07A).
   *
   * Every implemented workspace can be entered on an empty workspace; what it
   * needs, it says inside itself. Until UI-07A Convert, Split and Texture were
   * drawn disabled with "Open a model first", which read as features CAD Fixer
   * does not have. The assertion is keyed off `WORKFLOWS[].implemented`, and
   * the explicit list is stated so that flipping a flag without shipping the
   * workspace fails here rather than passing quietly.
   */
  it('enables every implemented workspace with no model open, and only those', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: 'Workspaces' });

    const enabled = within(nav)
      .getAllByRole('button')
      .filter(
        (button) =>
          !(button as HTMLButtonElement).disabled &&
          button.getAttribute('aria-disabled') !== 'true',
      )
      .map((button) => button.dataset.testid);

    const implemented = WORKFLOWS.filter((workflow) => workflow.implemented).map(
      (workflow) => workflow.label,
    );

    expect(implemented).toEqual(['Repair', 'Convert', 'Split', 'Texture']);
    expect(enabled).toEqual([
      'workflow-repair',
      'workflow-convert',
      'workflow-split',
      'workflow-texture',
    ]);
  });

  it('never puts a model requirement or an internal state name in the navigation', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: 'Workspaces' });

    expect(nav).not.toHaveTextContent(/Open a model first/i);
    expect(nav).not.toHaveTextContent(/Not implemented/i);
    for (const button of within(nav).getAllByRole('button')) {
      expect(button.getAttribute('data-tooltip') ?? '').not.toMatch(/open a model/i);
    }
  });

  it('shows Hollow as coming soon: visible, focusable, announced unavailable', () => {
    renderApp();
    const hollow = screen.getByTestId('workflow-hollow');

    // `aria-disabled`, not `disabled`: keyboard focus must reach it so the
    // tooltip a pointer gets on hover is available from the keyboard too.
    expect(hollow).toBeEnabled();
    expect(hollow).toHaveAttribute('aria-disabled', 'true');
    expect(hollow).toHaveAccessibleName('Hollow — coming soon');
    expect(hollow).toHaveAttribute('data-tooltip', 'Hollow — coming soon');
    // Not by colour alone: a visible badge says it in text.
    expect(within(hollow).getByText('Soon')).toBeInTheDocument();
    expect(hollow).not.toHaveAttribute('aria-current');
  });

  it('does nothing when Hollow is activated', () => {
    const store = renderApp();
    const before = store.getSnapshot();

    fireEvent.click(screen.getByTestId('workflow-hollow'));

    expect(store.getSnapshot()).toBe(before);
    expect(screen.getByTestId('workflow-hollow')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('workflow-repair')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('workspace-header')).toHaveTextContent('Repair');
  });

  it('enters each implemented workspace without a model and says what it needs', () => {
    const store = renderApp();
    const cases = [
      [WorkflowId.Convert, 'Open a 3D model to convert or export it.'],
      [WorkflowId.Split, 'Open a 3D model to split it into parts.'],
      [WorkflowId.Texture, 'Open a 3D model to add surface texture.'],
      [WorkflowId.Repair, 'Open a 3D model to analyze and repair mesh issues.'],
    ] as const;

    for (const [id, message] of cases) {
      fireEvent.click(screen.getByTestId(`workflow-${id}`));

      expect(store.getSnapshot().selectedWorkflow).toBe(id);
      expect(screen.getByTestId(`workflow-${id}`)).toHaveAttribute('aria-current', 'page');
      const current = screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);

      // ONE empty state, the current workspace's own, with the one Open action.
      const empty = screen.getByTestId('workspace-empty');
      expect(empty).toHaveAttribute('data-workflow', id);
      expect(empty).toHaveTextContent('No model loaded');
      expect(empty).toHaveTextContent(message);
      expect(within(empty).getByRole('button', { name: 'Open model' })).toBeEnabled();

      // Entering a workspace creates no document and no part.
      expect(store.getSnapshot().model).toBeUndefined();
      expect(store.getSnapshot().activePartId).toBeUndefined();
    }
  });

  it('keeps every model-requiring command guarded in an empty workspace', () => {
    renderApp();

    fireEvent.click(screen.getByTestId('workflow-convert'));
    expect(screen.getByTestId('convert-export')).toBeDisabled();
    for (const radio of within(screen.getByTestId('convert-workspace')).getAllByRole('radio'))
      expect(radio).toBeDisabled();

    fireEvent.click(screen.getByTestId('workflow-split'));
    expect(screen.getByTestId('split-preview')).toBeDisabled();

    fireEvent.click(screen.getByTestId('workflow-texture'));
    expect(screen.getByTestId('texture-generate')).toBeDisabled();

    fireEvent.click(screen.getByTestId('workflow-repair'));
    // REPAIR-UX-01: the primary action keeps its place, disabled, like the
    // other workspaces' actions; nothing that could start work is enabled.
    expect(screen.getByTestId('preview-repair')).toBeDisabled();
    expect(screen.queryByTestId('analyze-mesh')).toBeNull();
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    expect(screen.getByTestId('topbar-export')).toBeDisabled();
  });

  it('claims no texture preview on an empty Surface Texture workspace', () => {
    // UI-07A regression: with neither a preview nor a model, the banner's two
    // identity comparisons were `undefined === undefined` and it announced
    // "Texture preview — not applied" over the empty drop target.
    renderApp();
    fireEvent.click(screen.getByTestId('workflow-texture'));

    expect(screen.queryByTestId('texture-preview-banner')).toBeNull();
  });

  it('offers the same rules in the compact switcher, which lists every workspace', () => {
    const store = renderApp();

    fireEvent.click(screen.getByTestId('workspace-switcher'));
    expect(screen.getByTestId('workspace-switcher')).toHaveAttribute('aria-expanded', 'true');
    expect(document.body).not.toHaveTextContent(/Open a model first|Not implemented/i);

    for (const id of [WorkflowId.Repair, WorkflowId.Convert, WorkflowId.Split, WorkflowId.Texture])
      expect(screen.getByTestId(`workspace-option-${id}`)).not.toHaveAttribute('aria-disabled');

    const hollow = screen.getByTestId('workspace-option-hollow');
    expect(hollow).toHaveAttribute('aria-disabled', 'true');
    expect(hollow).toHaveTextContent('Coming soon');

    // Choosing Hollow changes nothing and leaves the menu open on its badge.
    const before = store.getSnapshot();
    fireEvent.click(hollow);
    expect(store.getSnapshot()).toBe(before);
    expect(screen.getByTestId('workspace-option-hollow')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workspace-option-split'));
    expect(store.getSnapshot().selectedWorkflow).toBe(WorkflowId.Split);
    expect(screen.queryByTestId('workspace-option-hollow')).toBeNull();
    expect(screen.getByTestId('workspace-switcher')).toHaveAccessibleName(
      'Workspace: Split & Connect. Change workspace',
    );
  });

  it('describes Repair as safe automatic repair rather than as repairing everything', () => {
    renderApp();

    const summary = screen.getByText(/Safe automatic repair: remove duplicate/);
    expect(summary).toBeInTheDocument();
    // REPAIR-CORE-06B: Repair now separates pinched vertices and fills simple openings, so the
    // summary names them. It must still never promise more than that: no claim of a complete,
    // printable or guaranteed result, and the qualifier says each step is checked.
    expect(summary.textContent).toMatch(/pinched vertices/);
    expect(summary.textContent).toMatch(/only where each can be checked/);
    expect(summary.textContent).not.toMatch(/everything|all issues|printable|watertight|perfect/i);
  });
});

describe('file intake at the UI boundary', () => {
  it('rejects an obviously unsupported extension', () => {
    renderApp();

    dropFiles([new File(['x'], 'drawing.zip', { type: 'application/zip' })]);

    const log = screen.getByTestId('status-list');
    expect(within(log).getByText(/\.zip files are not supported/)).toBeInTheDocument();
  });

  it('rejects a file with no extension', () => {
    renderApp();

    dropFiles([new File(['x'], 'model')]);

    expect(screen.getByTestId('status-list')).toHaveTextContent(/supported extension/i);
  });

  it('starts a real import for an OBJ file rather than refusing it', async () => {
    /*
     * OBJ IMPORT IS IMPLEMENTED as of Stage 4A-2B1, so the file is genuinely
     * read — the opposite of the Stage 1 assertion this replaces. What the
     * worker then makes of the contents is the parser's business and is tested
     * against it directly; what matters here is that the interface no longer
     * refuses the format at the door.
     */
    renderApp();
    const file = new File(['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'], 'part.obj');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');

    dropFiles([file]);

    expect(await screen.findByTestId('import-progress')).toBeInTheDocument();
    expect(readAsBuffer).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('status-list').textContent).not.toMatch(/not implemented/i);
  });

  it('starts a real import for a 3MF file rather than refusing it', async () => {
    renderApp();
    // A ZIP signature is enough to reach the worker; the archive's validity is
    // the reader's business, and it is tested against the reader.
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'part.3mf');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');

    dropFiles([file]);

    expect(await screen.findByTestId('import-progress')).toBeInTheDocument();
    expect(readAsBuffer).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('status-list').textContent).not.toMatch(/not implemented/i);
  });

  it('starts a real import for an STL file and reads it locally', async () => {
    // STL import IS implemented as of Stage 1, so the file is genuinely read —
    // the opposite of the Stage 0 assertion this replaces.
    renderApp();
    const file = new File([new Uint8Array(84)], 'bracket.stl');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');

    dropFiles([file]);

    expect(await screen.findByTestId('import-progress')).toBeInTheDocument();
    expect(readAsBuffer).toHaveBeenCalledTimes(1);
  });

  it('does not claim the model is loaded while the import is still running', async () => {
    // The worker stub never replies, so the import stays pending forever. That
    // is the point: nothing may report success before a result arrives.
    renderApp();

    dropFiles([new File([new Uint8Array(84)], 'bracket.stl')]);
    await screen.findByTestId('import-progress');

    expect(screen.getByTestId('model-empty')).toBeInTheDocument();
    expect(screen.getByTestId('status-list').textContent).not.toMatch(
      /loaded|imported|ready to repair/i,
    );
  });

  it('never reads a file it has already refused', () => {
    renderApp();
    const file = new File(['x'], 'drawing.zip');
    const readAsBuffer = vi.spyOn(file, 'arrayBuffer');
    const readAsText = vi.spyOn(file, 'text');

    dropFiles([file]);

    // Screening is a filename check, and a refused file must never be opened.
    expect(readAsBuffer).not.toHaveBeenCalled();
    expect(readAsText).not.toHaveBeenCalled();
  });

  it('uses only the first file of a multi-file drop and says so', () => {
    // One model is open at a time, so silently ignoring the rest would be
    // confusing.
    renderApp();

    dropFiles([new File(['a'], 'first.obj'), new File(['b'], 'second.stl')]);

    const log = screen.getByTestId('status-list');
    expect(within(log).getByText(/Only one model can be open at a time/i)).toBeInTheDocument();
    // And the FIRST file is the one that was taken, not the last or the one
    // that happens to be a format the application has supported longest.
    expect(log.textContent).toMatch(/first\.obj/i);
  });

  it('reports an empty drop instead of doing nothing', () => {
    renderApp();

    dropFiles([]);

    expect(screen.getByTestId('status-list')).toHaveTextContent(/no file was received/i);
  });
});

describe('status log', () => {
  it('clears entries on request', () => {
    renderApp();
    dropFiles([new File(['x'], 'drawing.zip')]);
    expect(screen.queryByTestId('status-empty')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('clear-status'));

    expect(screen.getByTestId('status-empty')).toBeInTheDocument();
  });

  it('disables the clear control once the log is empty', () => {
    renderApp();

    fireEvent.click(screen.getByTestId('clear-status'));

    expect(screen.getByTestId('status-empty')).toBeInTheDocument();
    expect(screen.getByTestId('clear-status')).toBeDisabled();
  });
});

describe('viewport', () => {
  beforeEach(() => {
    // Three.js logs a WebGL acquisition failure before throwing; the test
    // asserts on our handling of the throw, not on that noise.
    vi.spyOn(console, 'error').mockImplementation((): void => {
      // Discarded: Three.js logs its own WebGL acquisition failure.
    });
  });

  it('surfaces a graphics failure instead of rendering a blank panel', () => {
    // jsdom provides no WebGL context, which is exactly the failure a user on a
    // machine without WebGL would hit.
    renderApp();

    expect(screen.getByTestId('viewport-error')).toHaveTextContent(/3D viewport could not start/i);
  });
});

describe('runtime diagnostics', () => {
  it('exposes a self-test that is idle until it is run', () => {
    renderApp();

    expect(screen.getByTestId('self-test-state')).toHaveTextContent('idle');
    expect(screen.getByTestId('run-self-test')).toBeEnabled();
    expect(screen.getByTestId('cancel-self-test')).toBeDisabled();
  });

  it('reports cross-origin isolation as a fact about the environment', () => {
    renderApp();

    // jsdom is not cross-origin isolated, and the panel must say so rather than
    // assuming the capability is present.
    expect(screen.getByTestId('isolation-state')).toHaveTextContent('no');
  });
});
