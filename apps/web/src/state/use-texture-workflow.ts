import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  OperationHandle,
  PartDescriptor,
  SurfaceTextureRequest,
  TextureCreateResult,
  TextureLayoutResult,
} from '@cadfixer/geometry-runtime';
import { useGeometryClient } from '../runtime/client-context';
import type { PartPick } from '../viewport/pick-part';
import {
  DEFAULT_TEXTURE_SETTINGS,
  textureAvailable,
  textureSettingsProblem,
  type TextureSettings,
} from './texture-presentation';
import type { LengthUnit } from '@cadfixer/shared';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { millimetresToCoordinates } from './unit-interpretation';
import { useUnitInterpretation } from './use-unit-interpretation';
import { StatusSeverity, type TextureSelectionState } from './workspace-store';
import { WorkflowId } from './workflows';

/**
 * THE SURFACE TEXTURE WORKFLOW — one instance, shared by the panel, the
 * viewport (picking, highlight, footprints), the HUD and the inspector.
 *
 * ONE SELECTION, AND IT IS THE WORKER'S. A click sends the picked face to the
 * authoritative worker, which grows the flat connected region and returns its
 * triangle ids, its area and the part's area. Those ids are stored once, in
 * the workspace store, where the viewport draws them; the panel, HUD and
 * inspector read only the summary.
 *
 * A SELECTION BELONGS TO ONE REVISION OF ONE PART. Its face ids index that
 * exact mesh, so the session key includes the document revision: applying a
 * texture, an undo, a repair or another part's selection retires it by
 * derivation, and no stale id can reach a request.
 *
 * TWO PREVIEWS, AND THEY ARE DIFFERENT THINGS. The FAST preview is the
 * engine's own layout step run alone (`texture/layout`): the exact outline of
 * every element that would be placed, plus the element count and the admission
 * estimate — debounced, and no geometry is built. GENERATE PREVIEW runs the
 * real Boolean and holds a validated candidate; only Apply commits it.
 */

export const TexturePhase = {
  Idle: 'idle',
  Computing: 'computing',
  Preview: 'preview',
  Applying: 'applying',
} as const;
export type TexturePhase = (typeof TexturePhase)[keyof typeof TexturePhase];

export type TextureSelection = TextureSelectionState;

export interface TextureLayoutState {
  readonly pending: boolean;
  readonly result: TextureLayoutResult | undefined;
  readonly error: string | undefined;
}

export interface TextureControls {
  readonly part: PartDescriptor | undefined;
  readonly unit: string | undefined;
  readonly available: boolean;
  readonly settings: TextureSettings;
  readonly settingsProblem: string | undefined;
  readonly selection: TextureSelection | undefined;
  readonly selecting: boolean;
  readonly layout: TextureLayoutState;
  readonly phase: TexturePhase;
  readonly progress: string;
  readonly error: string | undefined;
  readonly preview: TextureCreateResult | undefined;
  readonly appliedRecordId: string | undefined;
  readonly pick: (hit: PartPick) => void;
  readonly clearSelection: () => void;
  readonly setSettings: (patch: Partial<TextureSettings>) => void;
  readonly generate: () => void;
  readonly discardPreview: () => void;
  readonly apply: () => void;
  readonly reset: () => void;
  readonly undo: () => void;
}

const LAYOUT_DEBOUNCE_MS = 200;

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message !== '' ? cause.message : fallback;

export function textureRequest(
  selection: TextureSelection,
  settings: TextureSettings,
  unit?: LengthUnit,
): SurfaceTextureRequest {
  // The panel's sizes are physical (millimetres); the engine works in the
  // model's coordinate units. A model read as inches has 25.4 mm to a unit.
  const toCoordinates = (millimetres: number): number =>
    unit === undefined ? millimetres : millimetresToCoordinates(millimetres, unit);
  return {
    seedTriangle: selection.seedTriangle,
    pattern: settings.pattern,
    mode: settings.mode,
    featureSize: toCoordinates(settings.featureSize),
    spacing: toCoordinates(settings.spacing),
    heightOrDepth: toCoordinates(settings.heightOrDepth),
    // Dots ignore rotation in the engine; sending 0 keeps the layout key stable.
    rotationDegrees: settings.pattern === 'dots' ? 0 : settings.rotationDegrees,
  };
}

export function useTextureWorkflow(): TextureControls {
  const { selectedWorkflow, model, activePartId, textureSelection } = useWorkspaceState();
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const active = selectedWorkflow === WorkflowId.Texture;
  const part = model?.parts.find((candidate) => candidate.partId === activePartId);
  const { unit: unitValue } = useUnitInterpretation();
  const unit: string | undefined = unitValue;
  const available = textureAvailable(unit);
  const session =
    active && model !== undefined && part !== undefined
      ? `${model.handle.documentId}@${String(model.handle.revision)}/${part.partId}|${unitValue ?? ''}`
      : '';

  const [settings, setSettingsState] = useState<TextureSettings>(DEFAULT_TEXTURE_SETTINGS);
  const [selectingKey, setSelectingKey] = useState<string | undefined>(undefined);
  const [layoutState, setLayoutState] = useState<
    | {
        readonly key: string;
        readonly result?: TextureLayoutResult;
        readonly error?: string;
      }
    | undefined
  >(undefined);
  const [work, setWork] = useState<{
    readonly session: string;
    readonly phase: TexturePhase;
    readonly progress: string;
  }>({ session: '', phase: TexturePhase.Idle, progress: '' });
  const [errorState, setErrorState] = useState<
    { readonly key: string; readonly message: string } | undefined
  >(undefined);
  const [previewState, setPreviewState] = useState<
    { readonly key: string; readonly result: TextureCreateResult } | undefined
  >(undefined);
  const [applied, setApplied] = useState<
    { readonly recordId: string; readonly revision: number } | undefined
  >(undefined);
  const running = useRef<OperationHandle<TextureCreateResult> | undefined>(undefined);
  const selectingOp = useRef<OperationHandle<unknown> | undefined>(undefined);
  const layoutOp = useRef<OperationHandle<TextureLayoutResult> | undefined>(undefined);
  const previewRef = useRef<TextureCreateResult | undefined>(undefined);

  /*
   * The store holds the one selection; it is THIS session's only when it names
   * the loaded revision and the active part. Anything else — a selection made
   * before an Apply, an Undo or a repair — indexes a different mesh.
   */
  const selection =
    session !== '' &&
    model !== undefined &&
    textureSelection?.source.documentId === model.handle.documentId &&
    textureSelection.source.revision === model.handle.revision &&
    textureSelection.partId === activePartId
      ? textureSelection
      : undefined;
  const selecting = selectingKey === session && session !== '';
  const error = errorState?.key === session ? errorState.message : undefined;
  const preview = previewState?.key === session ? previewState.result : undefined;
  const rawPhase = work.session === session ? work.phase : TexturePhase.Idle;
  const phase =
    rawPhase === TexturePhase.Preview && preview === undefined ? TexturePhase.Idle : rawPhase;
  const progress = work.session === session ? work.progress : '';
  const appliedRecordId =
    applied !== undefined && applied.revision === model?.revision ? applied.recordId : undefined;
  const settingsProblem = textureSettingsProblem(settings);

  const request = useMemo(
    () => (selection === undefined ? undefined : textureRequest(selection, settings, unitValue)),
    [selection, settings, unitValue],
  );
  const layoutKey =
    request === undefined || !available || settingsProblem !== undefined
      ? ''
      : `${session}|${JSON.stringify(request)}`;
  const layout: TextureLayoutState =
    layoutKey === ''
      ? { pending: false, result: undefined, error: undefined }
      : layoutState?.key === layoutKey
        ? { pending: false, result: layoutState.result, error: layoutState.error }
        : { pending: true, result: undefined, error: undefined };

  const setPhase = useCallback(
    (next: TexturePhase, note = ''): void => {
      setWork({ session, phase: next, progress: note });
    },
    [session],
  );
  const setError = useCallback(
    (message: string | undefined): void => {
      setErrorState(message === undefined ? undefined : { key: session, message });
    },
    [session],
  );

  /** Releases what lives outside React. Sets no React state. */
  const releaseCandidate = useCallback((): void => {
    running.current?.cancel();
    running.current = undefined;
    const candidate = previewRef.current?.candidate;
    if (candidate !== undefined && client !== undefined) {
      client.discardGeometryEdit(candidate).promise.catch((cause: unknown) => {
        store.pushStatus(
          StatusSeverity.Warning,
          messageOf(cause, 'A discarded texture preview could not be released.'),
        );
      });
    }
    previewRef.current = undefined;
    store.clearTexturePreview();
  }, [client, store]);

  /*
   * A NEW SESSION — another part, another revision, or leaving the workspace —
   * releases the old one's worker work, candidate, preview and highlight.
   */
  useEffect(
    () => (): void => {
      releaseCandidate();
      selectingOp.current?.cancel();
      selectingOp.current = undefined;
      store.clearTextureSelection();
    },
    [releaseCandidate, session, store],
  );

  /** The user's own edits: release, and retire this session's preview. */
  const invalidate = useCallback((): void => {
    releaseCandidate();
    setPreviewState(undefined);
    setPhase(TexturePhase.Idle);
  }, [releaseCandidate, setPhase]);

  /*
   * THE FAST PREVIEW, debounced. Only the engine's layout step runs — no
   * operand, no Boolean — and a newer request cancels an older one, so typing
   * a number produces one layout, not one per keystroke.
   */
  useEffect(() => {
    if (layoutKey === '' || client === undefined || model === undefined || part === undefined)
      return undefined;
    if (request === undefined) return undefined;
    const handle = model.handle;
    const partId = part.partId;
    const timer = setTimeout(() => {
      const operation = client.describeTextureLayout(handle, partId, request);
      layoutOp.current = operation;
      operation.promise.then(
        (result) => {
          if (layoutOp.current === operation) setLayoutState({ key: layoutKey, result });
        },
        (cause: unknown) => {
          if (layoutOp.current === operation)
            setLayoutState({
              key: layoutKey,
              error: messageOf(cause, 'The texture layout could not be computed.'),
            });
        },
      );
    }, LAYOUT_DEBOUNCE_MS);
    return (): void => {
      clearTimeout(timer);
      layoutOp.current?.cancel();
      layoutOp.current = undefined;
    };
  }, [client, layoutKey, model, part, request]);

  const pick = useCallback(
    (hit: PartPick): void => {
      const snapshot = store.getSnapshot();
      if (snapshot.selectedWorkflow !== WorkflowId.Texture) return;
      const current = snapshot.model;
      if (client === undefined || current === undefined) return;
      invalidate();
      setError(undefined);
      selectingOp.current?.cancel();
      const key = `${current.handle.documentId}@${String(current.handle.revision)}/${hit.partId}`;
      setSelectingKey(key);
      const operation = client.selectTextureSurface(current.handle, hit.partId, hit.triangleIndex);
      selectingOp.current = operation;
      operation.promise.then(
        (result) => {
          if (selectingOp.current !== operation) return;
          selectingOp.current = undefined;
          setSelectingKey(undefined);
          store.setTextureSelection({
            source: result.source,
            partId: result.partId,
            seedTriangle: hit.triangleIndex,
            triangleIds: result.triangleIds,
            area: result.area,
            partArea: result.partArea,
            planarity: result.planarity,
          });
        },
        (cause: unknown) => {
          if (selectingOp.current !== operation) return;
          selectingOp.current = undefined;
          setSelectingKey(undefined);
          const message = messageOf(cause, 'That surface could not be selected.');
          setErrorState({ key, message });
        },
      );
    },
    [client, invalidate, setError, store],
  );

  const clearSelection = useCallback((): void => {
    invalidate();
    selectingOp.current?.cancel();
    selectingOp.current = undefined;
    setSelectingKey(undefined);
    setError(undefined);
    store.clearTextureSelection();
  }, [invalidate, setError, store]);

  const setSettings = useCallback(
    (patch: Partial<TextureSettings>): void => {
      invalidate();
      setError(undefined);
      setSettingsState((current) => ({ ...current, ...patch }));
    },
    [invalidate, setError],
  );

  const generate = useCallback((): void => {
    if (client === undefined || model === undefined || part === undefined) return;
    if (request === undefined || !available || settingsProblem !== undefined) return;
    invalidate();
    setError(undefined);
    setPhase(TexturePhase.Computing, 'Building the texture…');
    const operation = client.createSurfaceTexture(model.handle, part.partId, request, (update) => {
      setWork((current) =>
        current.session === session
          ? { ...current, progress: update.note ?? 'Computing…' }
          : current,
      );
    });
    running.current = operation;
    operation.promise.then(
      (result) => {
        if (running.current !== operation) return;
        running.current = undefined;
        previewRef.current = result;
        setPreviewState({ key: session, result });
        store.setTexturePreview(
          model.handle,
          part.partId,
          result.render,
          result.candidate.generation,
        );
        setPhase(TexturePhase.Preview);
      },
      (cause: unknown) => {
        if (running.current !== operation) return;
        running.current = undefined;
        const message = messageOf(cause, 'The texture could not be built.');
        setPhase(TexturePhase.Idle);
        setError(message);
        store.pushStatus(StatusSeverity.Error, message);
      },
    );
  }, [
    available,
    client,
    invalidate,
    model,
    part,
    request,
    session,
    setError,
    setPhase,
    settingsProblem,
    store,
  ]);

  const apply = useCallback((): void => {
    if (client === undefined || model === undefined || part === undefined) return;
    const current = previewRef.current;
    if (current === undefined) return;
    setPhase(TexturePhase.Applying);
    client.commitGeometryEdit(current.candidate, model.handle, part.partId).promise.then(
      (result) => {
        if (!store.applyGeometryEditResult(result)) {
          setPhase(TexturePhase.Preview);
          setError('The model changed before the texture could be applied.');
          return;
        }
        previewRef.current = undefined;
        setPreviewState(undefined);
        setApplied({
          recordId: result.recordId,
          revision: store.getSnapshot().model?.revision ?? -1,
        });
        store.pushStatus(StatusSeverity.Success, 'Surface texture applied and validated.');
      },
      (cause: unknown) => {
        const message = messageOf(cause, 'The texture could not be applied.');
        setPhase(TexturePhase.Preview);
        setError(message);
        store.pushStatus(StatusSeverity.Error, message);
      },
    );
  }, [client, model, part, setError, setPhase, store]);

  /** Reset: the preview and the settings, never committed geometry. */
  const reset = useCallback((): void => {
    invalidate();
    setError(undefined);
    setSettingsState(DEFAULT_TEXTURE_SETTINGS);
  }, [invalidate, setError]);

  const undo = useCallback((): void => {
    if (client === undefined || model === undefined || appliedRecordId === undefined) return;
    client
      .undoRepair(model.handle, appliedRecordId, () => undefined)
      .promise.then(
        (result) => {
          if (!store.applyUndoResult(result)) {
            setError('The model changed before Undo completed.');
            return;
          }
          setApplied(undefined);
          store.pushStatus(StatusSeverity.Success, 'Surface texture undone.');
        },
        (cause: unknown) => {
          const message = messageOf(cause, 'The texture could not be undone.');
          setError(message);
          store.pushStatus(StatusSeverity.Error, message);
        },
      );
  }, [appliedRecordId, client, model, setError, store]);

  return {
    part,
    unit,
    available,
    settings,
    settingsProblem,
    selection,
    selecting,
    layout,
    phase,
    progress,
    error,
    preview,
    appliedRecordId,
    pick,
    clearSelection,
    setSettings,
    generate,
    discardPreview: invalidate,
    apply,
    reset,
    undo,
  };
}
