import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import { BoundaryLoopRefusal } from '@cadfixer/geometry-runtime';
import type {
  JointDescriptor,
  DocumentHandle,
  DocumentRenderSnapshot,
  HoleFillCandidateHandle,
  PartDescriptor,
} from '@cadfixer/geometry-runtime';
import { OpenBoundaryLimits, OpenBoundaryPanel } from './OpenBoundaryPanel';
import { WorkspaceProvider } from '../state/store-context';
import { HoleFillControlsProvider } from '../state/workflow-controllers';
import { WorkspaceStore, type HoleBoundaryRow } from '../state/workspace-store';
import {
  HOLE_FILL_APPLIED_QUALIFIER,
  HOLE_FILL_LIMITS,
  describeBoundaryRefusal,
} from '../state/hole-fill-presentation';
import type { LoadedModel } from '../state/model';
import {
  RETIRE_DISCLOSURE,
  RETIRE_DISCLOSURE_PLAIN_CUT,
} from '../state/connector-edit-presentation';

/**
 * HA01–HA10: THE PANEL, AND WHAT A KEYBOARD OR SCREEN-READER USER GETS.
 *
 * WHAT IS TESTED HERE AND WHAT IS NOT. The happy path — select, preview, apply,
 * undo — is covered end to end against the real worker, where it belongs; a
 * component test that stubbed a candidate would only prove the stub rendered.
 * What is worth testing at this level is what the panel OFFERS in each state,
 * because that is where an interface is tempted to enable a control that the
 * worker would then refuse, and where accessible naming is either present or
 * quietly absent.
 *
 * NO GEOMETRY CLIENT IS PROVIDED, and that is deliberate rather than
 * incidental. `useHoleFillWorkflow` lists a part's openings automatically when
 * a client exists — which is right in the product and wrong here: the
 * automatic listing would immediately supersede the state each case configures,
 * and every assertion would be made against "Finding open boundaries…". Without
 * a client the hook dispatches nothing, so what is rendered is exactly the
 * store state the case set up. The dispatch path is covered end to end against
 * the real worker, where it belongs.
 */

const PART = 'part-1';

function partDescriptor(partId = PART, triangleCount = 4): PartDescriptor {
  return {
    partId,
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount,
    vertexCount: triangleCount * 3,
    bounds: undefined,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
  };
}

function loadModel(store: WorkspaceStore, parts = [partDescriptor()]): DocumentHandle {
  const handle = { documentId: 'model-1', revision: 1 } as DocumentHandle;
  const snapshot: DocumentRenderSnapshot = {
    parts: parts.map((part) => ({
      partId: part.partId,
      transform: IDENTITY_PART_TRANSFORM,
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      vertexCount: 3,
    })),
  };
  const model: Omit<LoadedModel, 'revision'> = {
    handle,
    parts,
    render: snapshot,
    source: {
      fileName: 'part.stl',
      fileBytes: 100,
      formatId: 'stl',
      encoding: 'binary',
      unit: undefined,
      unsupportedFeatures: [],
      externalReferences: [],
      importedAt: 0,
    },
    bounds: undefined,
    triangleCount: 4,
    vertexCount: 12,
    validation: { valid: true, issueCount: 0, warningCount: 0, truncated: false, codes: [] },
    warnings: [],
    residentBytes: 192,
  };
  const token = store.beginImport('part.stl');
  store.commitImport(token, model);
  return handle;
}

const FILLABLE: HoleBoundaryRow = {
  boundaryLoopId: 'bl-7-4-0123456789abcdef',
  displayIndex: 1,
  vertexCount: 4,
  edgeCount: 4,
  fillable: true,
  refusal: undefined,
};

const REFUSED: HoleBoundaryRow = {
  boundaryLoopId: 'bl-9-6-fedcba9876543210',
  displayIndex: 2,
  vertexCount: 6,
  edgeCount: 6,
  fillable: false,
  refusal: BoundaryLoopRefusal.NonManifoldAdjacency,
};

function listOpenings(
  store: WorkspaceStore,
  handle: DocumentHandle,
  rows: readonly HoleBoundaryRow[] = [FILLABLE, REFUSED],
  extra: {
    loopCount?: number;
    truncated?: boolean;
    partFaceCount?: number;
    inventoried?: boolean;
  } = {},
): void {
  const token = store.beginHoleFillListing(handle, PART);
  store.commitHoleFillListing(token, {
    handle,
    partId: PART,
    inventoried: extra.inventoried ?? true,
    loopCount: extra.loopCount ?? rows.length,
    rows,
    truncated: extra.truncated ?? false,
    partFaceCount: extra.partFaceCount ?? 4,
  });
}

function candidateHandle(): HoleFillCandidateHandle {
  return {
    candidateId: 'hole-fill-candidate-1',
    documentId: 'model-1',
    partId: PART,
    sourceRevision: 1,
    boundaryLoopId: FILLABLE.boundaryLoopId,
    sourceFaceCount: 4,
    generation: 1,
  } as unknown as HoleFillCandidateHandle;
}

function installCandidate(store: WorkspaceStore, handle: DocumentHandle): void {
  store.selectBoundaryLoop(FILLABLE.boundaryLoopId);
  const token = store.beginHoleFillCandidate(handle, PART, FILLABLE.boundaryLoopId);
  if (token === undefined) throw new Error('candidate slot refused');
  store.commitHoleFillCandidate(token, {
    candidate: candidateHandle(),
    source: handle,
    partId: PART,
    boundaryLoopId: FILLABLE.boundaryLoopId,
    summary: {} as never,
    patchPositions: new Float32Array(18),
    patchNormals: new Float32Array(18),
    patchTriangleCount: 2,
  });
}

function renderPanel(configure: (store: WorkspaceStore) => void = () => undefined): WorkspaceStore {
  const store = new WorkspaceStore();
  configure(store);
  render(
    <WorkspaceProvider store={store}>
      <HoleFillControlsProvider>
        <OpenBoundaryPanel />
      </HoleFillControlsProvider>
    </WorkspaceProvider>,
  );
  return store;
}

/**
 * Applies a store change and lets React render it.
 *
 * The store is a plain observable consumed through `useSyncExternalStore`, so a
 * mutation made outside `act` updates the store and leaves the tree showing the
 * previous snapshot. Wrapping is what makes the assertion afterwards describe
 * what a user would actually see.
 */
function update(run: () => void): void {
  act(() => {
    run();
  });
}

afterEach(cleanup);

describe('with no model', () => {
  it('renders nothing at all rather than an empty workflow', () => {
    renderPanel();
    expect(screen.queryByTestId('open-boundaries')).toBeNull();
    expect(screen.queryByTestId('preview-fill')).toBeNull();
    expect(screen.queryByTestId('apply-fill')).toBeNull();
  });
});

describe('HA01, HA03: the opening list', () => {
  it('is a single-select radio group, keyboard reachable by construction', () => {
    renderPanel((store) => {
      const handle = loadModel(store);
      listOpenings(store, handle);
    });

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(2);
    // ONE GROUP, so arrow keys move between openings and only one is chosen.
    expect(options.every((option) => option.getAttribute('name') === 'open-boundary')).toBe(true);
    for (const option of options) expect(option).toBeEnabled();
  });

  it('HA02: exposes the selected opening through the platform, not through colour', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    update(() => store.selectBoundaryLoop(FILLABLE.boundaryLoopId));

    const options = screen.getAllByRole('radio');
    expect(options[0]).toBeChecked();
    expect(options[1]).not.toBeChecked();
  });

  it('HA03: associates the refusal reason with the option it describes', () => {
    renderPanel((store) => {
      const handle = loadModel(store);
      listOpenings(store, handle);
    });

    const refusedRow = screen.getByTestId('opening-2');
    const input = within(refusedRow).getByRole('radio');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();

    /*
     * THE REASON IS PART OF THE OPTION, not a paragraph elsewhere on the page.
     * A screen-reader user hears why an opening is unavailable as they move onto
     * it, rather than having to go looking for an explanation.
     */
    const reason = document.getElementById(describedBy ?? '');
    expect(reason?.textContent).toContain(
      describeBoundaryRefusal(BoundaryLoopRefusal.NonManifoldAdjacency),
    );
  });

  it('lists a refused opening rather than hiding it', () => {
    /*
     * §7 AND §44. Hiding it would leave a user counting openings in their viewer
     * and finding fewer here. It is listed, explained, and offers no Preview.
     */
    renderPanel((store) => {
      const handle = loadModel(store);
      listOpenings(store, handle);
    });

    expect(screen.getByTestId('opening-1')).toHaveAttribute('data-fillable', 'true');
    expect(screen.getByTestId('opening-2')).toHaveAttribute('data-fillable', 'false');
  });

  it('never shows the loop identity as the label', () => {
    // §13. The hash is the identity; the index is the label.
    renderPanel((store) => {
      const handle = loadModel(store);
      listOpenings(store, handle);
    });
    expect(screen.getByTestId('open-boundaries').textContent).not.toContain('bl-7-4-');
  });

  it('discloses a capped listing without shrinking the count', () => {
    renderPanel((store) => {
      const handle = loadModel(store);
      listOpenings(store, handle, [FILLABLE], { loopCount: 20_165, truncated: true });
    });

    const note = screen.getByTestId('hole-fill-truncated');
    expect(note).toHaveTextContent('20,165');
    expect(screen.getByTestId('hole-fill-count')).toHaveTextContent('20,165');
  });
});

describe('HA04, HA06: what the panel offers, and when', () => {
  it('offers Preview fill for a fillable opening only', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });

    // Nothing selected: no Preview.
    expect(screen.queryByTestId('preview-fill')).toBeNull();

    update(() => store.selectBoundaryLoop(REFUSED.boundaryLoopId));
    expect(screen.queryByTestId('preview-fill')).toBeNull();
    expect(screen.getByTestId('hole-fill-selected-refusal')).toHaveTextContent(
      describeBoundaryRefusal(BoundaryLoopRefusal.NonManifoldAdjacency),
    );

    update(() => store.selectBoundaryLoop(FILLABLE.boundaryLoopId));
    const preview = screen.getByTestId('preview-fill');
    expect(preview).toBeEnabled();
    expect(preview).toHaveAccessibleName('Preview fill');
  });

  it('HA06: never offers Apply until a validated candidate exists', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    update(() => store.selectBoundaryLoop(FILLABLE.boundaryLoopId));

    // A selection is not a candidate.
    expect(screen.queryByTestId('apply-fill')).toBeNull();
    expect(screen.queryByTestId('discard-fill')).toBeNull();
  });

  it('offers Apply and Discard once a candidate is ready, and says nothing changed', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    update(() => {
      installCandidate(store, { documentId: 'model-1', revision: 1 } as DocumentHandle);
    });

    expect(screen.getByTestId('apply-fill')).toBeEnabled();
    expect(screen.getByTestId('discard-fill')).toBeEnabled();
    // §25. "Ready" must never read as "done".
    expect(screen.getByTestId('hole-fill-preview-headline')).toHaveTextContent(
      'Fill preview ready',
    );
    expect(screen.getByTestId('hole-fill-preview-not-applied')).toHaveTextContent(
      /nothing has changed yet/i,
    );
    // And Preview is gone: there is one candidate at a time.
    expect(screen.queryByTestId('preview-fill')).toBeNull();
  });

  it('says, before Apply, what the fill does to the connectors recorded on this piece', () => {
    const cut = (pins: number, part = PART): JointDescriptor => ({
      jointId: 'model-1/joint/1',
      aPartId: part,
      bPartId: 'other-piece',
      status: 'ATTACHED',
      pinCount: pins,
      retainedBytes: 0,
      specDigest: 'digest',
    });
    const handle = { documentId: 'model-1', revision: 1 } as DocumentHandle;
    const open = (joints: readonly JointDescriptor[]): WorkspaceStore => {
      const store = renderPanel((configured) => {
        const loaded = loadModel(configured);
        listOpenings(configured, loaded);
        configured.setJoints({ status: 'READY', documentId: 'model-1', revision: 1, joints });
      });
      update(() => {
        installCandidate(store, handle);
      });
      return store;
    };
    open([cut(2)]);
    expect(screen.getByTestId('hole-fill-connector-note')).toHaveTextContent(RETIRE_DISCLOSURE);
    cleanup();
    open([cut(0)]);
    expect(screen.getByTestId('hole-fill-connector-note')).toHaveTextContent(
      RETIRE_DISCLOSURE_PLAIN_CUT,
    );
    cleanup();
    open([cut(2, 'some-other-piece')]);
    expect(screen.queryByTestId('hole-fill-connector-note')).toBeNull();
    cleanup();
    open([]);
    expect(screen.queryByTestId('hole-fill-connector-note')).toBeNull();
  });

  it('says the openings were not looked for, and shows no list, above the ceiling', () => {
    /*
     * STAGE 6D-R3. The walk is the largest allocation an import can trigger by
     * itself, so it is skipped for a part nothing could be filled in — and the
     * panel must say that rather than render an empty, reassuring list.
     */
    renderPanel((configured) => {
      const handle = loadModel(configured, [partDescriptor(PART, 6_291_454)]);
      listOpenings(configured, handle, [], {
        inventoried: false,
        loopCount: 0,
        partFaceCount: 6_291_454,
      });
    });

    expect(screen.getByTestId('hole-fill-not-inventoried')).toHaveTextContent('6,291,454');
    // No count, no list, no selection: nothing here describes the part's
    // boundaries, because nothing looked at them.
    expect(screen.queryByTestId('hole-fill-count')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByTestId('preview-fill')).toBeNull();
  });

  it('states a part-size refusal before anything is started, and offers no Preview', () => {
    // §49, §48. The triangle count already decides this.
    const store = renderPanel((configured) => {
      const handle = loadModel(configured, [partDescriptor(PART, 400_000)]);
      listOpenings(configured, handle, [FILLABLE], { partFaceCount: 400_000 });
    });
    update(() => store.selectBoundaryLoop(FILLABLE.boundaryLoopId));

    expect(screen.getByTestId('hole-fill-part-too-large')).toHaveTextContent('400,000');
    expect(screen.queryByTestId('preview-fill')).toBeNull();
    // Every opening is still listed and still explained. Nothing else is disabled.
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });
});

describe('HA05, HA07: generation is announced and cancellable', () => {
  it('shows an indeterminate indicator, a phase, and a reachable Cancel', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    let token: ReturnType<WorkspaceStore['beginHoleFillCandidate']> = undefined;
    update(() => {
      store.selectBoundaryLoop(FILLABLE.boundaryLoopId);
      token = store.beginHoleFillCandidate(
        { documentId: 'model-1', revision: 1 } as DocumentHandle,
        PART,
        FILLABLE.boundaryLoopId,
      );
    });
    const started = token as ReturnType<WorkspaceStore['beginHoleFillCandidate']>;
    if (started === undefined) throw new Error('candidate slot refused');

    const phase = screen.getByTestId('hole-fill-phase');
    expect(phase).toHaveAttribute('role', 'status');
    expect(phase).toHaveTextContent('Preparing');

    /*
     * INDETERMINATE, DELIBERATELY. §20 — the operation reports no fraction, so
     * the bar must not show one. A `progress` with no `value` is the platform's
     * own way to say "working, and I cannot say how far".
     */
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('value');

    const cancel = screen.getByTestId('cancel-fill');
    expect(cancel).toBeEnabled();
    expect(cancel).toHaveAccessibleName('Cancel');

    // The list is not interactable while a fill runs, so a click cannot start a
    // second one for a different opening.
    for (const option of screen.getAllByRole('radio')) expect(option).toBeDisabled();

    // Cancelling moves to the transitional state and disables the button.
    update(() => store.beginHoleFillCancellation(started));
    expect(screen.getByTestId('hole-fill-cancelling')).toHaveTextContent('Stopping');
    expect(screen.getByTestId('cancel-fill')).toBeDisabled();
  });

  it('HA08: reports a refusal in a live region, and says the model was not changed', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    update(() => {
      store.selectBoundaryLoop(FILLABLE.boundaryLoopId);
      const token = store.beginHoleFillCandidate(
        { documentId: 'model-1', revision: 1 } as DocumentHandle,
        PART,
        FILLABLE.boundaryLoopId,
      );
      if (token === undefined) throw new Error('candidate slot refused');
      store.failHoleFillCandidate(token, {
        message: 'This opening is not flat enough to fill automatically.',
        code: 'REFUSED_NON_PLANAR',
        retryable: false,
      });
    });

    const region = screen.getByTestId('hole-fill-status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(within(region).getByTestId('hole-fill-refusal')).toHaveTextContent('not flat enough');
    expect(within(region).getByTestId('hole-fill-refusal-qualifier')).toHaveTextContent(
      'Your model was not changed.',
    );
    // AND NO APPLY. A refusal produced no candidate.
    expect(screen.queryByTestId('apply-fill')).toBeNull();
    // The code never reaches the user.
    expect(region.textContent).not.toContain('REFUSED_NON_PLANAR');
  });

  it('HA10: keeps focus inside the panel when a fill settles', () => {
    /*
     * A keyboard user pressed Preview; that button has now gone. Without this
     * the browser would drop focus on the document body and lose their place
     * entirely. The live region is where the outcome is, so focus goes there.
     */
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    /*
     * TWO SEPARATE RENDERS, because that is what actually happens: the panel
     * paints "Preparing…" with a Cancel button, the user presses it, and the
     * button disappears. Batching both into one update would never render the
     * generating state, and the focus move exists precisely for the transition
     * OUT of it.
     */
    let token: ReturnType<WorkspaceStore['beginHoleFillCandidate']> = undefined;
    update(() => {
      store.selectBoundaryLoop(FILLABLE.boundaryLoopId);
      token = store.beginHoleFillCandidate(
        { documentId: 'model-1', revision: 1 } as DocumentHandle,
        PART,
        FILLABLE.boundaryLoopId,
      );
    });
    const settled = token as ReturnType<WorkspaceStore['beginHoleFillCandidate']>;
    if (settled === undefined) throw new Error('candidate slot refused');
    expect(screen.getByTestId('cancel-fill')).toBeEnabled();

    update(() => store.cancelHoleFillCandidate(settled));

    expect(document.activeElement).toBe(screen.getByTestId('hole-fill-status'));
  });
});

describe('HA09: after a fill is applied', () => {
  it('keeps focus inside the panel when Apply settles', () => {
    /*
     * THE SAME PROBLEM AS HA10, ONE CONTROL LATER. `Apply fill` is gone the
     * moment the commit lands; without this the browser drops focus on the
     * document body and a keyboard user loses their place with no indication of
     * what happened.
     */
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    update(() => {
      installCandidate(store, { documentId: 'model-1', revision: 1 } as DocumentHandle);
    });
    update(() => store.beginHoleFillCommit());
    expect(screen.getByTestId('apply-fill')).toHaveTextContent('Applying');

    update(() => {
      store.applyHoleFillResult({
        handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
        parentRevision: 1,
        recordId: 'fill-1',
        partId: PART,
        boundaryLoopId: FILLABLE.boundaryLoopId,
        patchFaceCount: 2,
        undoable: true,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        parts: [partDescriptor(PART, 6)],
        bounds: undefined,
        triangleCount: 6,
        vertexCount: 18,
        residentBytes: 256,
      });
    });

    expect(document.activeElement).toBe(screen.getByTestId('hole-fill-status'));
  });

  it('states what was filled with its qualifier, and offers Undo', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    update(() => {
      installCandidate(store, { documentId: 'model-1', revision: 1 } as DocumentHandle);
      store.beginHoleFillCommit();
      store.applyHoleFillResult({
        handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
        parentRevision: 1,
        recordId: 'fill-1',
        partId: PART,
        boundaryLoopId: FILLABLE.boundaryLoopId,
        patchFaceCount: 2,
        undoable: true,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        parts: [partDescriptor(PART, 6)],
        bounds: undefined,
        triangleCount: 6,
        vertexCount: 18,
        residentBytes: 256,
      });
    });

    expect(screen.getByTestId('hole-fill-applied-headline')).toHaveTextContent(
      'Selected opening filled and validated',
    );
    // §41. The qualifier travels with the claim, always.
    expect(screen.getByTestId('hole-fill-applied-qualifier')).toHaveTextContent(
      HOLE_FILL_APPLIED_QUALIFIER,
    );
    const undo = screen.getByTestId('undo-fill');
    expect(undo).toBeEnabled();
    expect(undo).toHaveAccessibleName('Undo fill');

    // The preview is gone: it was consumed.
    expect(screen.queryByTestId('apply-fill')).toBeNull();
    expect(screen.queryByTestId('hole-fill-candidate')).toBeNull();
  });

  it('offers no Undo for a record the worker says is not reversible', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    update(() => {
      installCandidate(store, { documentId: 'model-1', revision: 1 } as DocumentHandle);
      store.beginHoleFillCommit();
      store.applyHoleFillResult({
        handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
        parentRevision: 1,
        recordId: 'fill-1',
        partId: PART,
        boundaryLoopId: FILLABLE.boundaryLoopId,
        patchFaceCount: 2,
        undoable: false,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        parts: [partDescriptor(PART, 6)],
        bounds: undefined,
        triangleCount: 6,
        vertexCount: 18,
        residentBytes: 256,
      });
    });

    expect(screen.getByTestId('hole-fill-applied')).toBeInTheDocument();
    expect(screen.queryByTestId('undo-fill')).toBeNull();
  });
});

describe('the panel is honest about what it does not do', () => {
  it('states the limits on screen, not only in a document', () => {
    // REPAIR-UX-01: the limits live in Advanced diagnostics, not beneath the
    // openings list, and are rendered by their own component there.
    render(<OpenBoundaryLimits />);

    const limits = screen.getByTestId('hole-fill-limits');
    for (const entry of HOLE_FILL_LIMITS) expect(limits).toHaveTextContent(entry);
  });

  it('scopes the openings to the ACTIVE PART on a multi-part document', () => {
    renderPanel((store) => {
      const handle = loadModel(store, [partDescriptor(PART), partDescriptor('part-2')]);
      listOpenings(store, handle);
    });

    expect(screen.getByTestId('hole-fill-part-scope')).toHaveTextContent(/only, of 2 parts/i);
  });

  it('says nothing about scope for a single-part document', () => {
    renderPanel((store) => {
      const handle = loadModel(store);
      listOpenings(store, handle);
    });
    expect(screen.queryByTestId('hole-fill-part-scope')).toBeNull();
  });

  it('never claims the model is closed, watertight or printable', () => {
    const store = renderPanel((configured) => {
      const handle = loadModel(configured);
      listOpenings(configured, handle);
    });
    update(() => {
      installCandidate(store, { documentId: 'model-1', revision: 1 } as DocumentHandle);
      store.beginHoleFillCommit();
      store.applyHoleFillResult({
        handle: { documentId: 'model-1', revision: 2 } as DocumentHandle,
        parentRevision: 1,
        recordId: 'fill-1',
        partId: PART,
        boundaryLoopId: FILLABLE.boundaryLoopId,
        patchFaceCount: 2,
        undoable: true,
        render: { positions: new Float32Array(9), normals: new Float32Array(9), vertexCount: 3 },
        parts: [partDescriptor(PART, 6)],
        bounds: undefined,
        triangleCount: 6,
        vertexCount: 18,
        residentBytes: 256,
      });
    });

    const text = screen.getByTestId('open-boundaries').textContent.toLowerCase();
    for (const banned of [
      'watertight',
      'printable',
      'model repaired',
      'all errors',
      'ready to print',
      'fully closed',
    ]) {
      expect(text, `the panel said "${banned}"`).not.toContain(banned);
    }
  });
});
