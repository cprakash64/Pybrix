import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  createViewport,
  NavigationMode,
  ViewDirection,
  type ViewportHandle,
} from '../viewport/create-viewport';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import {
  HoleFillWorkState,
  RepairCandidateState,
  RepairPreviewMode,
  StatusSeverity,
} from '../state/workspace-store';
import { overlayForIssue } from '../state/repair-issues';
import { useIssueNavigation } from '../state/use-issue-navigation';
import { useSplitControls, useTextureControls } from '../state/workflow-controllers';
import { WorkflowId } from '../state/workflows';
import { analysisKey } from '../state/workspace-store';
import { IssueHud } from './IssueHud';
import { SplitHud } from './SplitHud';
import { TextureHud } from './TextureHud';
import { OutputSizeCard } from './OutputSizeCard';
import { Icon } from './shell/Icon';
import { IconButton, SegmentedControl, type SegmentedOption } from './shell/primitives';

/**
 * React owns the container element; `createViewport` owns everything inside it.
 *
 * The viewport instance is created once and kept in a ref. Model changes are
 * pushed into it imperatively rather than by recreating it, so switching models
 * does not tear down and rebuild the WebGL context.
 */
export function ViewportPanel(): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ViewportHandle | undefined>(undefined);
  /**
   * The view cube's rotating element. Written DIRECTLY from the viewport's
   * orientation callback, never through React state: that callback fires on
   * every orbit step, and routing it through state would re-render this panel
   * — and everything below the store subscription — once per pointer move.
   */
  const cubeRef = useRef<HTMLDivElement>(null);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>(NavigationMode.Orbit);
  const store = useWorkspaceStore();
  const {
    viewportFailure,
    model,
    activePartId,
    analysis,
    overlays,
    repair,
    holeFill,
    splitPreview,
    splitPlane,
    texturePreview,
    textureSelection,
    selectedWorkflow,
    frameRequest,
  } = useWorkspaceState();
  const navigation = useIssueNavigation();
  const split = useSplitControls();
  const splitWorkspace = selectedWorkflow === WorkflowId.Split;
  /*
   * Read through refs by callbacks the viewport was created with once: the
   * arrow's drag reaches the CURRENT controller, and a model swap knows which
   * workspace it happened in without rebuilding the model on a tab change.
   */
  const texture = useTextureControls();
  const textureWorkspace = selectedWorkflow === WorkflowId.Texture;
  const splitRef = useRef(split);
  const textureRef = useRef(texture);
  const splitWorkspaceRef = useRef(splitWorkspace);
  // Declared before the model effect, so a model swap already sees the
  // workspace it happened in.
  useEffect(() => {
    splitRef.current = split;
    textureRef.current = texture;
    splitWorkspaceRef.current = splitWorkspace;
  });
  const issueSelection = navigation.selection;
  const repairWorkspace = selectedWorkflow === undefined || selectedWorkflow === WorkflowId.Repair;
  /**
   * The selected issue's own overlay is drawn whatever the Mesh Health toggles
   * say: selecting "Winding conflicts" must show every sampled conflict, with
   * the active one marked. The user's toggles are not changed — this is what
   * is DRAWN, not what is stored.
   */
  const focusedOverlay =
    repairWorkspace && issueSelection !== undefined
      ? overlayForIssue(issueSelection.issue.id)
      : undefined;

  /**
   * The candidate the viewport may legitimately draw.
   *
   * Four conditions, all necessary. It must be READY — a building or failed
   * candidate has nothing to show. It must carry a render snapshot. It must
   * belong to the model that is actually loaded: a candidate for a model the
   * user has replaced describes geometry that is no longer on screen. And it
   * must belong to the PART that is selected — two parts share a revision, so
   * without that check a candidate for part A would be drawn in part B's frame,
   * on top of geometry it says nothing about.
   */
  const previewable =
    repair.candidateState === RepairCandidateState.Ready &&
    (repair.candidate?.render !== undefined || repair.candidate?.patchRender !== undefined) &&
    repair.candidate.source.documentId === model?.handle.documentId &&
    repair.candidate.source.revision === model.handle.revision &&
    repair.candidate.partId === activePartId
      ? repair.candidate
      : undefined;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    try {
      const viewport = createViewport(container, {
        onPick: (hit) => {
          store.selectPart(hit.partId);
          // Surface Texture's one selection tool: the worker grows the flat
          // region from this face. Nothing else listens for the click.
          if (store.getSnapshot().selectedWorkflow === WorkflowId.Texture)
            textureRef.current.pick(hit);
        },
        onOrientationChange: (orientation) => {
          const cube = cubeRef.current;
          if (cube !== null) cube.style.transform = `matrix3d(${orientation.join(',')})`;
        },
        onEditPlaneDrag: (phase, distance) => {
          // The arrow reports; the controller's one `offset` moves; the plane
          // comes back through `setEditPlane` like any other change.
          if (phase === 'start') splitRef.current.beginPlaneDrag();
          else splitRef.current.dragPlane(distance);
        },
        onContextLost: () => {
          // The model lives in a worker and is untouched, and a reload would
          // discard applied work — so the advice is to export first (PR-01).
          store.setViewportFailure(
            'The graphics context was lost, so the 3D view has stopped. Your model is unaffected. If you have applied changes, export them first, then reload the page to restore the view.',
          );
          store.pushStatus(StatusSeverity.Error, 'The 3D viewport lost its graphics context.');
        },
      });
      viewportRef.current = viewport;
      store.setViewportFailure(undefined);
      return (): void => {
        viewportRef.current = undefined;
        viewport.dispose();
      };
    } catch (cause) {
      /*
       * Surfaced, not swallowed: without WebGL the viewport genuinely cannot
       * run. The user gets what still works and what to do; the renderer's own
       * wording ("THREE.WebGLRenderer: Error creating WebGL context.") names a
       * library, not a remedy, and stays out of the sentence (PR-01). The
       * activity log keeps a short cause for support.
       */
      store.setViewportFailure(
        'The 3D viewport could not start because this browser did not provide WebGL graphics. Models can still be opened, checked and exported. To see them, turn on hardware acceleration or use a current Chromium-based browser, then reload.',
      );
      store.pushStatus(
        StatusSeverity.Error,
        cause instanceof Error && /webgl/i.test(cause.message)
          ? 'The 3D viewport could not start: WebGL is unavailable in this browser.'
          : 'The 3D viewport could not start.',
      );
      return undefined;
    }
  }, [store]);

  // Depends on the model object itself, which is safe precisely because the
  // store replaces it only on a successful import — unrelated updates such as a
  // status message keep the same reference, so this does not rebuild GPU
  // buffers every time something else in the workspace changes.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    if (model === undefined) {
      viewport.setModel(undefined);
      return;
    }

    /*
     * The render snapshot and the part descriptors are joined here rather than
     * in the worker, because they travel for different reasons: the buffers are
     * transferred and the bounds are scalars the panel also displays. Joining by
     * part id keeps the two in step without sending either twice.
     */
    const previewIsCurrent =
      splitPreview?.source.documentId === model.handle.documentId &&
      splitPreview.source.revision === model.handle.revision;
    const shownRender = previewIsCurrent ? splitPreview.render : model.render;
    const shownParts = previewIsCurrent ? splitPreview.parts : model.parts;
    const descriptorsById = new Map(shownParts.map((part) => [part.partId, part]));

    viewport.setModel(
      {
        parts: shownRender.parts.map((part) => {
          const descriptor = descriptorsById.get(part.partId);
          return {
            partId: part.partId,
            transform: part.transform,
            positions: part.positions,
            normals: part.normals,
            center: descriptor?.bounds?.center ?? [0, 0, 0],
            radius: descriptor?.bounds?.radius ?? 1,
          };
        }),
        center: model.bounds?.center ?? [0, 0, 0],
        radius: model.bounds?.radius ?? 1,
        revision: model.revision,
      },
      {
        // In Split & Connect, a preview or an applied split is the same document
        // seen differently: the camera the cut was chosen from stays put.
        preserveView: splitWorkspaceRef.current,
      },
    );
  }, [model, splitPreview]);

  /**
   * Points the overlay, preview and change-overlay frame at the active part.
   *
   * SEPARATE FROM THE MODEL EFFECT, and that separation is the whole point. A
   * selection change is not a model change: routing it through `setModel`
   * disposed and re-uploaded every part's GPU geometry on a click — four
   * uploads for a two-part document where two were correct, and two thousand
   * for a thousand-placement one.
   *
   * `model` is a dependency because a new document resets the viewport's
   * selection to none, and this is what installs the new one.
   */
  useEffect(() => {
    viewportRef.current?.setActivePart(activePartId);
    // A split preview is installed with `setModel` too, which resets the
    // viewport's selection; it has to be pointed back at the part being cut.
  }, [activePartId, model, splitPreview]);

  useEffect(() => {
    viewportRef.current?.setEditPlane(splitPlane);
    // Re-pushed after a preview is installed or removed: `setModel` hides it.
  }, [splitPlane, model, splitPreview]);

  /*
   * The engine's cross-section outline and the Piece A / Piece B colours, in
   * Split & Connect only. Both are presentation: neither changes geometry,
   * and outside the workspace the model is one colour again.
   */
  const splitOutline = splitWorkspace ? split.preview?.section.outline : undefined;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;
    viewport.setSectionOutline(
      splitOutline === undefined || model === undefined
        ? undefined
        : { segments: splitOutline, revision: model.revision },
    );
  }, [model, splitOutline, splitPreview]);

  const tintA = splitWorkspace ? (split.preview?.pieceAId ?? split.applied?.pieceA) : undefined;
  const tintB = splitWorkspace ? (split.preview?.pieceBId ?? split.applied?.pieceB) : undefined;
  useEffect(() => {
    viewportRef.current?.setPartTints(
      tintA === undefined || tintB === undefined
        ? undefined
        : new Map([
            [tintA, 'a'],
            [tintB, 'b'],
          ]),
    );
  }, [model, splitPreview, tintA, tintB]);

  useEffect(() => {
    viewportRef.current?.setNavigationMode(navigationMode);
  }, [navigationMode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const selection = textureSelection;
    if (
      !viewport ||
      !model ||
      selectedWorkflow !== 'texture' ||
      selection?.source.documentId !== model.handle.documentId ||
      selection.source.revision !== model.handle.revision ||
      selection.partId !== activePartId ||
      // A built preview replaces the face; the highlight would hide it.
      texturePreview !== undefined
    ) {
      viewport?.setTextureSelection(undefined);
      return;
    }
    const source = model.render.parts.find((part) => part.partId === activePartId)?.positions;
    if (!source) {
      viewport.setTextureSelection(undefined);
      return;
    }
    // Render-only extraction from the worker's qualified triangle ids. This
    // does not make a geometry decision or alter canonical data.
    const positions = new Float32Array(selection.triangleIds.length * 9);
    selection.triangleIds.forEach((triangleId, index) => {
      positions.set(source.subarray(triangleId * 9, triangleId * 9 + 9), index * 9);
    });
    viewport.setTextureSelection({ positions, revision: model.revision });
  }, [activePartId, model, selectedWorkflow, textureSelection, texturePreview]);

  /*
   * THE FAST PREVIEW: the engine's layout outlines, drawn on the face until a
   * geometry preview replaces them. Part-local, like the selection.
   */
  const footprint =
    textureWorkspace && texture.preview === undefined ? texture.layout.result : undefined;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;
    viewport.setTextureFootprint(
      model === undefined || footprint?.source.revision !== model.handle.revision
        ? undefined
        : { segments: footprint.footprint, revision: model.revision },
    );
  }, [footprint, model]);

  /**
   * Pushes diagnostic overlays for the model that is actually displayed.
   *
   * THE STALE-REPORT GUARD. `analysis.handle` is compared against the loaded
   * model's handle before anything is drawn. An analysis of M0 that completes
   * after M1 has been imported carries M0's handle, fails this comparison, and
   * clears the overlays instead of decorating M1 with M0's defects. The viewport
   * repeats the check on revision, so neither layer relies on the other.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    const detail = analysis.detail;
    const belongsToLoadedModel =
      model !== undefined &&
      analysis.handle?.documentId === model.handle.documentId &&
      analysis.handle.revision === model.handle.revision &&
      // Samples are part-local. Drawing part A's defects while part B is
      // selected would put markers at coordinates that mean nothing.
      analysis.partId === activePartId;

    if (detail === undefined || !belongsToLoadedModel) {
      viewport.setOverlays(undefined);
      return;
    }

    viewport.setOverlays({
      samples: {
        boundaryEdges: detail.boundaryEdges,
        nonManifoldEdges: detail.nonManifoldEdges,
        windingConflictEdges: detail.windingConflictEdges,
        degenerateFaces: detail.degenerateFaces,
        sampleVertexIds: detail.sampleVertexIds,
        sampleVertexPositions: detail.sampleVertexPositions,
      },
      visibility: focusedOverlay === undefined ? overlays : { ...overlays, [focusedOverlay]: true },
      revision: model.revision,
    });
  }, [
    activePartId,
    analysis.detail,
    analysis.handle,
    analysis.partId,
    focusedOverlay,
    model,
    overlays,
  ]);

  /**
   * The active occurrence's marker. ONE small object, moved — never a rebuild
   * of the diagnostic geometry, which the overlay above already owns.
   */
  const focusLocation = repairWorkspace ? issueSelection?.location : undefined;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;
    viewport.setIssueFocus(
      focusLocation === undefined || model === undefined
        ? undefined
        : { center: focusLocation.center, radius: focusLocation.radius, revision: model.revision },
    );
  }, [focusLocation, model]);

  /**
   * Frame requests are COMMANDS: each has a new sequence, so this runs once per
   * request. One whose key names another revision or part is ignored — the
   * place it names is not on screen any more.
   */
  const handledFrameRef = useRef(0);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined || frameRequest === undefined) return;
    // Each sequence is handled once, so a later model or part change cannot
    // replay a request made for what was on screen before.
    if (frameRequest.sequence === handledFrameRef.current) return;
    handledFrameRef.current = frameRequest.sequence;
    if (frameRequest.key !== analysisKey(model?.handle, activePartId)) return;
    viewport.frameRegion(frameRequest.center, frameRequest.radius);
  }, [activePartId, frameRequest, model]);

  /**
   * Pushes the repair preview.
   *
   * Depends on `previewMode` as well as the candidate, because switching Before
   * and After is a change to what is drawn — but `setPreview` rebuilds nothing
   * when only the mode changed, so the toggle costs a visibility flag and a
   * redraw rather than a GPU upload.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    const currentTexture = texturePreview;
    const currentModel = model;
    const texture =
      selectedWorkflow === 'texture' &&
      currentTexture?.source.documentId === currentModel?.handle.documentId &&
      currentTexture?.source.revision === currentModel?.handle.revision &&
      currentTexture?.partId === activePartId
        ? currentTexture
        : undefined;
    const textureIsCurrent = texture !== undefined;
    // A fill-only candidate has no full render: its patch is drawn as an
    // overlay beside the unchanged model instead (see the hole-fill effect).
    const render = texture?.render ?? previewable?.render;
    if (render === undefined || model === undefined) {
      viewport.setPreview(undefined);
      return;
    }

    viewport.setPreview({
      positions: render.positions,
      normals: render.normals,
      // Candidate bounds when the worker measured them; the source bounds
      // otherwise. Conservative repair only removes and reorders, so the
      // source's sphere always contains the candidate — it is a safe fallback
      // rather than a guess.
      center: (textureIsCurrent
        ? model.parts.find((part) => part.partId === activePartId)?.bounds?.center
        : previewable?.bounds?.center) ??
        model.bounds?.center ?? [0, 0, 0],
      radius:
        (textureIsCurrent
          ? model.parts.find((part) => part.partId === activePartId)?.bounds?.radius
          : previewable?.bounds?.radius) ??
        model.bounds?.radius ??
        1,
      showing:
        textureIsCurrent || repair.previewMode === RepairPreviewMode.After ? 'after' : 'before',
      revision: model.revision,
      generation: texture?.generation ?? previewable?.candidate.generation ?? 0,
    });
  }, [activePartId, model, previewable, repair.previewMode, selectedWorkflow, texturePreview]);

  /**
   * Pushes the repair change overlays.
   *
   * Built from the SOURCE render snapshot in every case, because every change
   * sample is a source face index. The viewport hides the removal categories
   * when the proposed result is being shown, since those triangles do not exist
   * there.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    if (previewable === undefined || model === undefined) {
      viewport.setChangeOverlays(undefined);
      return;
    }

    viewport.setChangeOverlays({
      samples: {
        removedDuplicates: previewable.samples.removedDuplicateFaces,
        removedRepeatedPosition: previewable.samples.removedRepeatedPositionFaces,
        removedZeroArea: previewable.samples.removedZeroAreaFaces,
        flippedFaces: mergeFlipped(
          previewable.samples.flippedFaces,
          previewable.localChange?.reversedSourceFaces,
        ),
        ...(previewable.localChange === undefined
          ? {}
          : {
              localRemoved: previewable.localChange.removedSourceFaces,
              localAdded: previewable.localChange.addedPositions,
            }),
      },
      visibility: repair.changeOverlays,
      view: repair.previewMode === RepairPreviewMode.After ? 'after' : 'before',
      revision: model.revision,
      generation: previewable.candidate.generation,
    });
  }, [model, previewable, repair.changeOverlays, repair.previewMode]);

  /**
   * Pushes the selected opening's rim and the proposed patch.
   *
   * THE SAME FOUR CONDITIONS THE REPAIR PREVIEW USES, and for the same reasons.
   * Both buffers are part-local and describe ONE revision of ONE part, so a rim
   * from a document the user has replaced, from a revision they have moved off,
   * or from a part they are no longer looking at would mark an opening where
   * there is none. The viewport repeats the revision check, so neither layer
   * relies on the other.
   *
   * THE PATCH IS SHOWN ONLY WHILE A CANDIDATE IS READY. Once Apply commits, the
   * patch is ordinary source geometry drawn by the model itself — the overlay
   * would be a second copy of triangles already on screen — and the store has
   * cleared the candidate by then, so this clears with it.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;

    if (model === undefined || activePartId === undefined) {
      viewport.setHoleFillOverlays(undefined);
      return;
    }

    const rim = holeFill.rim;
    const rimBelongs =
      rim?.source.documentId === model.handle.documentId &&
      rim.source.revision === model.handle.revision &&
      rim.partId === activePartId &&
      rim.boundaryLoopId === holeFill.selectedLoopId;

    const candidate = holeFill.candidate;
    const patchBelongs =
      holeFill.workState === HoleFillWorkState.Ready &&
      candidate?.source.documentId === model.handle.documentId &&
      candidate.source.revision === model.handle.revision &&
      candidate.partId === activePartId;

    /*
     * REPAIR-CORE-02: a fill-only repair preview is drawn the same way — the
     * patch beside the unchanged model — and only while "After" is showing.
     */
    const repairPatch =
      previewable?.patchRender !== undefined && repair.previewMode === RepairPreviewMode.After
        ? previewable.patchRender
        : undefined;

    if (!rimBelongs && !patchBelongs && repairPatch === undefined) {
      viewport.setHoleFillOverlays(undefined);
      return;
    }

    viewport.setHoleFillOverlays({
      boundaryPositions: rimBelongs ? rim.positions : undefined,
      patchPositions: patchBelongs ? candidate.patchPositions : repairPatch?.positions,
      patchNormals: patchBelongs ? candidate.patchNormals : repairPatch?.normals,
      revision: model.revision,
      generation: patchBelongs
        ? candidate.candidate.generation
        : repairPatch === undefined
          ? 0
          : (previewable?.candidate.generation ?? 0),
    });
  }, [
    activePartId,
    holeFill.candidate,
    holeFill.rim,
    holeFill.selectedLoopId,
    holeFill.workState,
    model,
    previewable,
    repair.previewMode,
  ]);

  const showingPreview =
    previewable !== undefined && repair.previewMode === RepairPreviewMode.After;

  /**
   * A patch on screen that has NOT been applied.
   *
   * The same rule the repair preview banner enforces: never let proposed
   * geometry be mistaken for the model. Text with a role, not a colour, so a
   * user who cannot see the green tint still learns nothing has changed.
   */
  const showingPatch =
    holeFill.workState === HoleFillWorkState.Ready &&
    holeFill.candidate?.patchPositions !== undefined;
  const currentTexture = texturePreview;
  const currentModel = model;
  /*
   * THE MODEL MUST EXIST. With neither a preview nor a model the identity
   * comparisons were `undefined === undefined`, and the banner claimed a
   * texture preview on an empty workspace — unreachable until UI-07A let the
   * workspace be entered without a model.
   */
  const showingTexture =
    selectedWorkflow === 'texture' &&
    currentModel !== undefined &&
    currentTexture?.source.documentId === currentModel.handle.documentId &&
    currentTexture.source.revision === currentModel.handle.revision;

  /** A split preview on screen: the pieces are candidates, not the model. */
  const showingSplit = splitWorkspace && split.preview !== undefined;

  const viewport = (): ViewportHandle | undefined => viewportRef.current;
  const modelShown = model !== undefined && viewportFailure === undefined;

  return (
    <section className="viewport" aria-label="3D workspace">
      <div className="viewport__canvas" ref={containerRef} data-testid="viewport-canvas" />

      {/* TOP-CENTRE HUD. Contextual status for whatever the workspace is doing.
          PART E4 lives here: never let a preview be mistaken for the model. Each
          banner is text with a role, not a colour, so a user who cannot see the
          tint still learns that nothing has been applied.

          ONE RULE FOR EVERY GENERATED PREVIEW (UI-06): this pill, naming the
          operation, is where "not applied" is said. The workspace HUDs above it
          describe what is selected or measured and do not repeat it. */}
      <div className="viewport__hud">
        {repairWorkspace && issueSelection !== undefined && modelShown ? (
          <IssueHud navigation={navigation} />
        ) : null}
        {splitWorkspace && modelShown ? <SplitHud /> : null}
        {textureWorkspace && modelShown ? <TextureHud /> : null}
        {showingPreview ? (
          <p className="viewport__preview-banner" role="status" data-testid="preview-banner">
            Repair preview — not applied
          </p>
        ) : null}

        {showingPatch && !showingPreview ? (
          <p className="viewport__preview-banner" role="status" data-testid="patch-preview-banner">
            Fill preview — not applied
          </p>
        ) : null}

        {showingSplit && !showingPreview ? (
          <p className="viewport__preview-banner" role="status" data-testid="split-preview-banner">
            Split preview — not applied
          </p>
        ) : null}

        {showingTexture && !showingPreview ? (
          <p
            className="viewport__preview-banner"
            role="status"
            data-testid="texture-preview-banner"
          >
            Texture preview — not applied
          </p>
        ) : null}
      </div>

      {viewportFailure !== undefined ? (
        <p className="viewport__error" role="alert" data-testid="viewport-error">
          {viewportFailure}
        </p>
      ) : model === undefined ? (
        <p className="viewport__empty" data-testid="viewport-empty">
          Empty workspace — open an STL, OBJ or 3MF file to view it.
        </p>
      ) : null}

      {modelShown ? (
        <>
          {/* LEFT: how a drag moves the camera. Every button calls the
              viewport; none of them changes geometry. */}
          <div
            className="viewport__tools"
            role="toolbar"
            aria-label="View navigation"
            aria-orientation="vertical"
          >
            <IconButton
              label="Orbit — left-drag rotates the view"
              icon="orbit"
              tooltip="right"
              iconSize={17}
              className="viewport__tool"
              pressed={navigationMode === NavigationMode.Orbit}
              onClick={() => {
                setNavigationMode(NavigationMode.Orbit);
              }}
              testId="nav-orbit"
            />
            <IconButton
              label="Pan — left-drag moves the view"
              icon="pan"
              tooltip="right"
              iconSize={17}
              className="viewport__tool"
              pressed={navigationMode === NavigationMode.Pan}
              onClick={() => {
                setNavigationMode(NavigationMode.Pan);
              }}
              testId="nav-pan"
            />
            <span className="viewport__tools-divider" aria-hidden="true" />
            <IconButton
              label="Zoom to fit, keeping this angle"
              icon="fit"
              tooltip="right"
              iconSize={17}
              className="viewport__tool"
              onClick={() => viewport()?.zoomToFit()}
              testId="zoom-to-fit"
            />
          </div>

          {/* TOP-LEFT, Convert only: how big the chosen output is, as far as
              CAD Fixer knows. An overlay that reads scalars; choosing a format
              touches nothing in the renderer. */}
          {selectedWorkflow === WorkflowId.Convert ? <OutputSizeCard /> : null}

          {/* TOP-RIGHT: orientation. The cube turns with the camera and each
              face frames the model from that side. */}
          <div className="viewport__orientation">
            <div className="view-cube" role="group" aria-label="Standard views">
              <div className="view-cube__body" ref={cubeRef}>
                {CUBE_FACES.map((face) => (
                  <button
                    key={face.direction}
                    type="button"
                    className={`view-cube__face view-cube__face--${face.direction}`}
                    aria-label={`View from ${face.direction}`}
                    onClick={() => viewport()?.viewFrom(face.direction)}
                    data-testid={`view-${face.direction}`}
                  >
                    {face.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="viewport__orientation-row">
              <IconButton
                label="Home view"
                icon="home"
                tooltip="left"
                iconSize={14}
                className="viewport__home"
                onClick={() => viewport()?.fitView()}
                testId="fit-view"
              />
              {/* A label, not a switch: the viewport has one camera, and it is a
                  perspective one. An orthographic toggle here would do nothing. */}
              <span className="viewport__projection" data-testid="projection-label">
                Perspective
              </span>
            </div>
          </div>

          {/* BOTTOM-CENTRE: workspace actions on the view. Present only when a
              workspace has one to offer, so it never shows an empty frame. */}
          {previewable !== undefined ? (
            <div className="viewport__actions" role="toolbar" aria-label="Viewport actions">
              <span className="viewport__actions-label">
                <Icon name="compare" size={16} />
                Compare
              </span>
              <SegmentedControl
                label="Compare the model with the proposed repair"
                options={COMPARE_OPTIONS}
                value={repair.previewMode}
                onChange={(mode) => {
                  // The same store call the repair panel's own toggle makes, so
                  // the two controls cannot disagree about what is shown.
                  store.setRepairPreviewMode(mode);
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const CUBE_FACES: readonly { readonly direction: ViewDirection; readonly label: string }[] = [
  { direction: ViewDirection.Front, label: 'FRONT' },
  { direction: ViewDirection.Back, label: 'BACK' },
  { direction: ViewDirection.Right, label: 'RIGHT' },
  { direction: ViewDirection.Left, label: 'LEFT' },
  { direction: ViewDirection.Top, label: 'TOP' },
  { direction: ViewDirection.Bottom, label: 'BOTTOM' },
];

const COMPARE_OPTIONS: readonly SegmentedOption<RepairPreviewMode>[] = [
  { value: RepairPreviewMode.Before, label: 'Before', testId: 'compare-before' },
  { value: RepairPreviewMode.After, label: 'After', testId: 'compare-after' },
];

/**
 * The conservative flips and the local repair's reversed faces, as ONE list of source faces for
 * the orientation markers. Deduplicated, so a face both repairs touched is drawn once; the
 * exact counts are reported elsewhere and never read from this bounded list.
 */
function mergeFlipped(conservative: Uint32Array, local: Uint32Array | undefined): Uint32Array {
  if (local === undefined || local.length === 0) return conservative;
  if (conservative.length === 0) return local;
  return Uint32Array.from(new Set([...conservative, ...local]));
}
