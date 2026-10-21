import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  SuggestionOperation,
  SuggestionStatus,
  sameSemanticPlane,
  type Suggestion,
} from '@cadfixer/auto-split';
import { useGeometryClient } from '../runtime/client-context';
import { createAnalysisTransport, type AnalysisTransport } from '../runtime/auto-split-transport';
import {
  AUTO_SPLIT_COPY,
  describeError,
  describeOperation,
  describePhase,
  describeStatus,
  type ErrorGuidance,
  type SuggestionStatusView,
} from './auto-split-presentation';
import {
  AutoSplitPhase,
  AutoSplitSession,
  LocalErrorCode,
  ModelKind,
  type AutoSplitTarget,
} from './auto-split-session';
import { type NotClosedCopy } from './split-readiness-presentation';
import { planeSettingsFor } from './auto-split-plane';
import { splitSizeNoticeFor, type SplitSizeNotice } from './split-size-presentation';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { SplitPhase, SplitSource, type SplitControls } from './use-split-workflow';
import { WorkflowId } from './workflows';

/**
 * AUTO SPLIT, BOUND TO THE STORE AND TO MANUAL SPLIT.
 *
 * This hook owns no geometry and no editor. It follows the model the workspace shows, runs the
 * analysis session, and turns a suggestion into a setting of the CONTROLS MANUAL SPLIT ALREADY HAS: a
 * suggested plane is loaded into the manual plane, a suggested component set becomes the manual split's
 * component source. Preview, Apply and Undo are then the manual workflow's own, so one Apply is one
 * document transaction and one Undo undoes it.
 *
 * NOTHING HERE APPLIES ANYTHING. The only action that can reach `split/commit` is the manual footer's
 * Apply, on a preview the user asked for.
 */

export type SplitTab = 'auto' | 'manual';

export interface AutoSplitRow {
  readonly sizeScore?: number;
  readonly id: string;
  readonly label: string;
  readonly operation: SuggestionOperation;
  readonly operationLabel: string;
  readonly status: SuggestionStatusView;
  /** True when Preview and Edit may be used: the part is splittable and the suggestion has a split to offer. */
  readonly executable: boolean;
  readonly shown: boolean;
  readonly selected: boolean;
  readonly suggestion: Suggestion;
}

export interface AutoSplitComponentRow {
  readonly rank: number;
  readonly label: string;
  readonly selected: boolean;
  readonly faces: number;
}

export interface AutoSplitControls {
  readonly objectLabel?: string;
  readonly tab: SplitTab;
  readonly setTab: (tab: SplitTab) => void;

  readonly phase: AutoSplitPhase;
  /** One honest sentence about what is happening or why nothing is. Never a percentage. */
  readonly statusText: string;
  readonly kind: ModelKind | undefined;
  readonly chooseKind: (kind: ModelKind) => void;
  /** The first-use disclosure is showing: a model type is chosen and the disclosure is not accepted. */
  readonly needsDisclosure: boolean;
  readonly acceptDisclosure: () => void;
  readonly declineDisclosure: () => void;

  /** The part an analysis looks at: the one now shown. Named in the panel so the scope is never implied. */
  readonly partLabel: string | undefined;
  readonly canAnalyze: boolean;
  readonly analyze: () => void;
  readonly reanalyze: () => void;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly busy: boolean;

  readonly error: ErrorGuidance | undefined;
  /**
   * Set when the part has more triangles than Auto Split supports: known BEFORE Find parts from the
   * part's descriptor (or, as a second line, from the worker's own refusal). A neutral status with no
   * retry; `error` stays undefined for it because it is not a failure.
   */
  readonly tooDetailed: SplitSizeNotice | undefined;
  /** False while a pass that cannot be interrupted runs: the Cancel control is withdrawn then. */
  readonly cancellable: boolean;
  readonly rows: readonly AutoSplitRow[];
  readonly hasResult: boolean;
  readonly stale: boolean;
  readonly appliedSinceAnalysis: boolean;

  readonly sourceReady: boolean;
  /**
   * Set when the part is not a closed solid: what Pybrix found, the next step and that the original
   * model is untouched. A status, never a retry: the same file is refused the same way every time.
   */
  readonly notClosed: NotClosedCopy | undefined;
  readonly openRepair: () => void;

  readonly selected: AutoSplitRow | undefined;
  readonly components: readonly AutoSplitComponentRow[];
  readonly toggleComponent: (rank: number) => void;
  readonly toggleShown: (id: string) => void;
  /** Loads the suggestion into Manual Split's controls and asks for its preview. */
  readonly preview: (id: string) => void;
  readonly previewBoundary?: (id: string, alternativeId: string, confirm?: boolean) => void;
  readonly boundaryPreview?: { readonly candidateId: string; readonly alternativeId: string };
  /** Loads the suggestion into Manual Split's controls for editing; no preview is made. */
  readonly edit: (id: string) => void;
  /** A selected suggestion's component set changed: preview it again. */
  readonly previewSelection: () => void;
  /** True when the loaded plane is not exactly what the suggestion was (the controls cannot express it). */
  readonly planeApproximate: boolean;
  /** A preview from a suggestion failed local validation. */
  readonly checkingCut?: boolean;
  readonly unsafeCut: boolean;
  /** A preview from a suggestion was declined for resources (a limit, not a defect in the cut). */
  readonly cutNeedsMoreRoom: boolean;
  /** Why the footer's Preview cannot be used in the Auto tab, or undefined. */
  readonly footerBlock: string | undefined;
  /**
   * Whether the manual cut plane (the orange gizmo and the cut capsule) is drawn. In Manual Split it
   * always is. In Auto Split it is drawn only for a selected CUT suggestion: before one is chosen, and
   * for a suggestion that takes out components, a plane on the model would invite a cut nobody asked for.
   */
  readonly planeVisible: boolean;
  /** Faces the viewport highlights, tied to the revision they were computed for. */
  readonly highlight: { readonly faces: Uint32Array; readonly revision: number } | undefined;
}

export interface AutoSplitOptions {
  /** Test seam: the one thing the session would otherwise reach the network with. */
  readonly transport?: AnalysisTransport;
  readonly newRequestId?: () => string;
}

const randomRequestId = (): string => {
  const id = globalThis.crypto.randomUUID();
  return `req-${id}`;
};

export function useAutoSplit(
  split: SplitControls,
  options: AutoSplitOptions = {},
): AutoSplitControls {
  const {
    source: splitSource,
    setComponentSource,
    loadSuggestedPlane,
    preparePreview,
    completePreparedPreview,
    discardPreview,
    phase: splitPhase,
    error: splitError,
  } = split;
  const { model, activePartId } = useWorkspaceState();
  const store = useWorkspaceStore();
  const geometry = useGeometryClient();
  const [tab, setTabState] = useState<SplitTab>('manual');

  // ONE SESSION for the app: it outlives a tab switch and dies with the page.
  const [session] = useState<AutoSplitSession>(
    () =>
      new AutoSplitSession({
        transport: options.transport ?? createAnalysisTransport(),
        newRequestId: options.newRequestId ?? randomRequestId,
      }),
  );
  // The geometry client is handed to the session whenever there is one; a run reads it when it STARTS.
  useEffect(() => {
    session.attachClient(geometry);
  }, [geometry, session]);
  useEffect(
    () => (): void => {
      session.dispose();
    },
    [session],
  );
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  const part = model?.parts.find((candidate) => candidate.partId === activePartId);
  const target: AutoSplitTarget | undefined = useMemo(
    () =>
      model === undefined || part === undefined
        ? undefined
        : {
            handle: model.handle,
            partId: part.partId,
            triangleCount: part.triangleCount,
            scope: model.parts.length === 1 ? 'entire-model' : 'selected-piece',
          },
    [model, part],
  );

  // The session follows the model the workspace shows: a revision change stales the list, another
  // document or part clears it, and a run in flight for anything else is cancelled.
  useEffect(() => {
    session.follow(target);
  }, [session, target]);

  /* ------------------------------------------------------------ rows -- */

  const result = snap.result;
  // Both operations have local capabilities: a plane chooses its split strategy in the worker;
  // component extraction partitions existing triangles. Global closed-solid status gates neither.
  const stale = snap.stale;

  const rows: readonly AutoSplitRow[] = useMemo(
    () =>
      (result?.suggestions ?? []).map((suggestion) => ({
        id: suggestion.id,
        label: suggestion.label,
        sizeScore: suggestion.components.reduce(
          (sum, rank) => sum + (result?.components.find((c) => c.rank === rank)?.areaShare ?? 0),
          0,
        ),
        operation: suggestion.operation,
        operationLabel: describeOperation(suggestion.operation),
        status: describeStatus(suggestion, true),
        executable:
          splitPhase !== SplitPhase.Preparing &&
          splitPhase !== SplitPhase.Computing &&
          splitPhase !== SplitPhase.Applying &&
          splitPhase !== SplitPhase.Undoing &&
          !stale &&
          suggestion.status !== SuggestionStatus.Unavailable &&
          suggestion.operation !== SuggestionOperation.None,
        shown: snap.shownId === suggestion.id,
        selected: snap.selectedId === suggestion.id,
        suggestion:
          stale && suggestion.quality !== undefined
            ? { ...suggestion, quality: 'STALE' as const }
            : suggestion,
      })),
    [result, snap.selectedId, snap.shownId, stale, splitPhase],
  );
  const selected = rows.find((row) => row.selected);
  useEffect(() => {
    const proof = split.preview?.semanticQualification;
    if (splitPhase === SplitPhase.Preview && proof) session.nativeQualified(proof);
    else if (
      selected?.suggestion.quality === 'SUGGESTED' &&
      splitError &&
      !split.errorIsResourceLimit &&
      !split.errorIsOperationFailure
    )
      session.nativeRefused(selected.id);
  }, [
    session,
    splitPhase,
    split.preview,
    selected?.id,
    selected?.suggestion.quality,
    splitError,
    split.errorIsResourceLimit,
    split.errorIsOperationFailure,
  ]);

  const components: readonly AutoSplitComponentRow[] = useMemo(() => {
    if (selected?.operation !== SuggestionOperation.Component || result === undefined) return [];
    const chosen = new Set(snap.selection ?? []);
    return result.components.map((component) => ({
      rank: component.rank,
      label: component.rank === 0 ? 'Largest component' : `Component ${String(component.rank + 1)}`,
      selected: chosen.has(component.rank),
      faces: component.faces,
    }));
  }, [result, selected, snap.selection]);

  /* ----------------------------------------------------------- phase -- */

  const derived: AutoSplitPhase = ((): AutoSplitPhase => {
    switch (snap.run) {
      case 'idle':
        return AutoSplitPhase.Idle;
      case 'preparing':
        return AutoSplitPhase.PreparingViews;
      case 'analyzing':
        return AutoSplitPhase.Analyzing;
      case 'error':
        return AutoSplitPhase.Error;
      case 'cancelled':
        return AutoSplitPhase.Cancelled;
      case 'ready':
        if (splitPhase === SplitPhase.Applying) return AutoSplitPhase.Applying;
        if (
          selected !== undefined &&
          (splitPhase === SplitPhase.Preparing ||
            splitPhase === SplitPhase.Computing ||
            splitPhase === SplitPhase.Preview)
        )
          return AutoSplitPhase.Previewing;
        return AutoSplitPhase.SuggestionsReady;
    }
  })();

  /* --------------------------------------------------- loading a cut -- */

  // A preview is asked for AFTER the suggestion is loaded: the tick makes the next render, whose
  // `updatePreview` closes over the loaded plane or components, the one that starts it.
  const [previewTick, setPreviewTick] = useState(0);
  const handledTick = useRef(0);
  const [approximate, setApproximate] = useState(false);
  useEffect(() => {
    if (previewTick === handledTick.current) return;
    handledTick.current = previewTick;
    completePreparedPreview();
  }, [previewTick, completePreparedPreview]);

  const load = useCallback(
    (id: string, thenPreview: boolean): void => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row?.executable) return;
      const boundaryAlternative = row.suggestion.boundaryConfirmation?.alternatives.find(
        (alternative) =>
          row.suggestion.plane !== null &&
          sameSemanticPlane(alternative.plane, row.suggestion.plane),
      );
      if (row.suggestion.boundaryConfirmation && !boundaryAlternative) return;
      if (
        thenPreview &&
        row.selected &&
        splitPhase === SplitPhase.Preview &&
        split.preview?.semanticQualification?.candidateId === id &&
        split.preview.semanticQualification.preparationId ===
          row.suggestion.semanticPreparationId &&
        row.suggestion.plane !== null &&
        sameSemanticPlane(split.preview.semanticQualification.plane, row.suggestion.plane)
      )
        return;
      const loadCut = (): void => {
        session.select(id);
        setApproximate(false);
        if (
          row.suggestion.operation === SuggestionOperation.Plane &&
          row.suggestion.plane !== null
        ) {
          const loaded = loadSuggestedPlane(
            {
              origin: row.suggestion.plane.origin,
              normal: row.suggestion.plane.normal,
            },
            row.label,
            row.suggestion.semanticPreparationId === undefined
              ? undefined
              : {
                  preparationId: row.suggestion.semanticPreparationId,
                  candidateId: row.id,
                  ...(boundaryAlternative
                    ? {
                        boundaryChoice: 'CONFIRM' as const,
                        boundaryAlternativeId: boundaryAlternative.id,
                      }
                    : {}),
                },
          );
          setApproximate(loaded?.exact === false);
        } else {
          setComponentSource(row.suggestion.components, row.label);
        }
        if (thenPreview) setPreviewTick((tick) => tick + 1);
      };
      if (thenPreview) preparePreview(loadCut);
      else loadCut();
    },
    [
      loadSuggestedPlane,
      rows,
      session,
      setComponentSource,
      preparePreview,
      splitPhase,
      split.preview,
    ],
  );
  const previewBoundary = useCallback(
    (id: string, alternativeId: string, confirm = false): void => {
      if (
        stale ||
        snap.run === 'preparing' ||
        snap.run === 'analyzing' ||
        !part ||
        splitPhase === SplitPhase.Preparing ||
        splitPhase === SplitPhase.Computing ||
        splitPhase === SplitPhase.Applying ||
        splitPhase === SplitPhase.Undoing
      )
        return;
      const row = rows.find((candidate) => candidate.id === id);
      const alternative = row?.suggestion.boundaryConfirmation?.alternatives.find(
        (candidate) => candidate.id === alternativeId,
      );
      const preparationId = row?.suggestion.semanticPreparationId;
      if (
        !row ||
        !alternative ||
        preparationId === undefined ||
        !planeSettingsFor(alternative.plane, part.bounds).exact
      )
        return;
      const proof = split.preview?.semanticQualification;
      if (
        confirm &&
        (proof?.boundaryChoice !== 'PREVIEW' ||
          proof.candidateId !== id ||
          proof.preparationId !== preparationId ||
          proof.boundaryAlternativeId !== alternativeId ||
          !sameSemanticPlane(proof.plane, alternative.plane))
      )
        return;
      preparePreview(() => {
        if (confirm) session.select(id);
        else session.previewBoundary(id, alternativeId);
        setApproximate(false);
        const loaded = loadSuggestedPlane(alternative.plane, row.label, {
          preparationId,
          candidateId: id,
          boundaryAlternativeId: alternativeId,
          boundaryChoice: confirm ? 'CONFIRM' : 'PREVIEW',
        });
        if (loaded?.exact) setPreviewTick((tick) => tick + 1);
      });
    },
    [
      stale,
      snap.run,
      part,
      splitPhase,
      rows,
      split.preview,
      preparePreview,
      session,
      loadSuggestedPlane,
    ],
  );
  const preview = useCallback(
    (id: string): void => {
      load(id, true);
    },
    [load],
  );
  const edit = useCallback(
    (id: string): void => {
      load(id, false);
    },
    [load],
  );

  const toggleComponent = useCallback(
    (rank: number): void => {
      session.toggleComponent(rank);
    },
    [session],
  );
  const previewSelection = useCallback((): void => {
    const next = session.getSnapshot().selection;
    if (next === undefined || next.length === 0) return;
    preparePreview(() => {
      setComponentSource(next);
      setPreviewTick((tick) => tick + 1);
    });
  }, [session, setComponentSource, preparePreview]);

  const toggleShown = useCallback(
    (id: string): void => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined || stale) return;
      if (
        row.operation === SuggestionOperation.Plane &&
        row.executable &&
        row.suggestion.plane !== null &&
        !row.shown
      ) {
        // Showing a cut is loading it into the manual plane: that is where the plane is drawn.
        session.select(id);
        const loaded = loadSuggestedPlane({
          origin: row.suggestion.plane.origin,
          normal: row.suggestion.plane.normal,
        });
        setApproximate(loaded?.exact === false);
        return;
      }
      session.toggleShown(id);
    },
    [loadSuggestedPlane, rows, session, stale],
  );

  /* ---------------------------------------------------------- tabs -- */

  const setTab = useCallback(
    (next: SplitTab): void => {
      setTabState(next);
      // The manual tab always cuts with a plane: a component source belongs to a suggestion.
      if (next === 'manual' && splitSource === SplitSource.Components)
        setComponentSource(undefined);
    },
    [setComponentSource, splitSource],
  );

  /* ------------------------------------------------------- analysis -- */

  const kind = snap.kind;
  // The size is a fact the page already holds, so the verdict precedes the click.
  const tooDetailed: SplitSizeNotice | undefined =
    splitSizeNoticeFor(part?.triangleCount) ??
    (snap.error?.code === LocalErrorCode.TooDetailed ? snap.error.size : undefined);
  const canAnalyze =
    target !== undefined &&
    snap.disclosureAccepted &&
    (kind === ModelKind.Automatic || kind === ModelKind.Character || kind === ModelKind.Vehicle) &&
    tooDetailed === undefined &&
    snap.run !== 'preparing' &&
    snap.run !== 'analyzing';
  const analyze = useCallback((): void => {
    if (target !== undefined) session.analyze(target);
  }, [session, target]);
  const reanalyze = useCallback((): void => {
    if (target !== undefined) session.analyze(target, true);
  }, [session, target]);
  const chooseKind = useCallback(
    (next: ModelKind): void => {
      session.chooseKind(next);
      discardPreview();
    },
    [session, discardPreview],
  );

  // Cancelling an analysis never touches a preview, and starting one does not either; but a preview
  // made from a suggestion is released when the suggestion is dismissed.
  const cancel = useCallback((): void => {
    session.cancel();
  }, [session]);
  const reset = useCallback((): void => {
    session.reset();
    discardPreview();
  }, [discardPreview, session]);

  const openRepair = useCallback((): void => {
    store.selectWorkflow(WorkflowId.Repair);
  }, [store]);

  /* ------------------------------------------------------ highlight -- */

  const [highlightState, setHighlightState] = useState<
    { readonly key: string; readonly faces: Uint32Array; readonly revision: number } | undefined
  >(undefined);
  const shownRow = rows.find((row) => row.shown);
  const wantedRanks: readonly number[] | undefined =
    shownRow?.operation === SuggestionOperation.Component &&
    !stale &&
    splitPhase === SplitPhase.Idle
      ? shownRow.selected
        ? (snap.selection ?? shownRow.suggestion.components)
        : shownRow.suggestion.components
      : undefined;
  const wantedKey =
    wantedRanks === undefined || model === undefined || part === undefined
      ? undefined
      : `${model.handle.documentId}@${String(model.revision)}/${part.partId}/${wantedRanks.join(',')}`;
  const wantedHandle = model?.handle;
  const wantedPart = part?.partId;
  useEffect(() => {
    const client = geometry;
    if (
      wantedKey === undefined ||
      wantedRanks === undefined ||
      wantedHandle === undefined ||
      wantedPart === undefined ||
      client === undefined
    )
      return;
    let current = true;
    const operation = client.autoSplitComponentFaces(wantedHandle, wantedPart, wantedRanks);
    operation.promise.then(
      (out) => {
        if (current)
          setHighlightState({ key: wantedKey, faces: out.faces, revision: wantedHandle.revision });
      },
      () => {
        if (current) setHighlightState(undefined);
      },
    );
    return (): void => {
      current = false;
      operation.cancel();
    };
  }, [geometry, wantedHandle, wantedKey, wantedPart, wantedRanks]);
  const highlight =
    wantedKey !== undefined && highlightState?.key === wantedKey
      ? { faces: highlightState.faces, revision: highlightState.revision }
      : undefined;

  /* ------------------------------------------------------- outputs -- */

  // Too detailed is a status, not a failure: it has its own card and never reaches the alert.
  const error =
    snap.error === undefined || snap.error.code === LocalErrorCode.TooDetailed
      ? undefined
      : describeError(snap.error);
  const statusText = describePhase(derived, snap.note);

  const footerBlock: string | undefined =
    tooDetailed !== undefined
      ? AUTO_SPLIT_COPY.tooDetailedHint
      : snap.run === 'analyzing' || snap.run === 'preparing'
        ? 'Looking for parts…'
        : result === undefined
          ? 'Find parts first, or switch to Manual Split.'
          : stale
            ? AUTO_SPLIT_COPY.stale
            : selected === undefined
              ? 'Choose a suggestion to preview.'
              : undefined;

  return {
    ...(result?.objectLabel === undefined ? {} : { objectLabel: result.objectLabel }),
    tab,
    setTab,
    phase: derived,
    statusText,
    kind,
    chooseKind,
    needsDisclosure: kind !== undefined && kind !== ModelKind.Other && !snap.disclosureAccepted,
    acceptDisclosure: (): void => {
      session.acceptDisclosure();
    },
    declineDisclosure: (): void => {
      session.declineDisclosure();
      session.chooseKind(undefined);
      setTabState('manual');
    },
    partLabel: part === undefined ? undefined : (part.name ?? part.partId),
    canAnalyze,
    analyze,
    reanalyze,
    cancel,
    reset,
    busy: snap.run === 'preparing' || snap.run === 'analyzing',
    error,
    tooDetailed,
    cancellable: snap.cancellable,
    rows,
    hasResult: result !== undefined,
    stale,
    appliedSinceAnalysis: stale && split.applied !== undefined,
    sourceReady: true,
    notClosed: undefined,
    openRepair,
    selected,
    components,
    toggleComponent,
    toggleShown,
    preview,
    previewBoundary,
    ...(split.preview?.semanticQualification?.boundaryChoice === 'PREVIEW' &&
    split.preview.semanticQualification.boundaryAlternativeId !== undefined
      ? {
          boundaryPreview: {
            candidateId: split.preview.semanticQualification.candidateId,
            alternativeId: split.preview.semanticQualification.boundaryAlternativeId,
          },
        }
      : {}),
    edit,
    previewSelection,
    planeApproximate: approximate && selected?.operation === SuggestionOperation.Plane,
    checkingCut:
      (selected?.operation === SuggestionOperation.Plane ||
        selected?.suggestion.boundaryConfirmation !== undefined) &&
      (splitPhase === SplitPhase.Preparing || splitPhase === SplitPhase.Computing),
    unsafeCut:
      tab === 'auto' &&
      selected !== undefined &&
      splitError !== undefined &&
      !split.errorIsResourceLimit,
    cutNeedsMoreRoom:
      tab === 'auto' &&
      selected !== undefined &&
      splitError !== undefined &&
      split.errorIsResourceLimit,
    footerBlock,
    planeVisible:
      tab === 'manual' ||
      selected?.operation === SuggestionOperation.Plane ||
      selected?.suggestion.boundaryConfirmation !== undefined,
    highlight,
  };
}
