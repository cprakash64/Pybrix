import {
  adoptSplitCommit,
  recoverSplitCommit,
  SplitCommitRecoveryRequired,
} from '../runtime/split-commit-transaction';
import { assemblyForSplitPreview, preservesAssemblyInterfaces } from './assembly-presentation';
import { connectorPairsOf, currentJoints } from './joint-presentation';
import { flushSync } from 'react-dom';
import { afterPaint } from './after-paint';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  OperationHandle,
  PartDescriptor,
  ProductConnectorRequest,
  SplitCreateResult,
  SplitTransactionStatus,
  SplitPlane,
} from '@cadfixer/geometry-runtime';
import { useGeometryClient } from '../runtime/client-context';
import { deriveSplitPartExportName, downloadBytes } from '../runtime/download';
import {
  clampOffset,
  CONNECTOR_INPUT_REFUSAL_CODES,
  clampRoll,
  type SplitPieceView,
  clampTilt,
  resetPlaneSettings,
  connectorsAvailable,
  isValidDimension,
  offsetAfterNormalDrag,
  splitPlaneFor,
  splitRange,
  type OfferedConnectorKind,
  type SplitAxis,
  type SplitPlaneSettings,
  type SplitRange,
} from './split-presentation';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { AppErrorCode, isAppError, type LengthUnit } from '@cadfixer/shared';
import { notClosedReasonsOf } from './split-readiness-presentation';
import { RESOURCE_REFUSAL_COPY, splitSizeNoticeFor } from './split-size-presentation';
import type { SplitSizeNotice } from './split-size-presentation';
import { useUnitInterpretation } from './use-unit-interpretation';
import { StatusSeverity } from './workspace-store';
import { WorkflowId } from './workflows';

/**
 * THE SPLIT & CONNECT WORKFLOW, bound to the store — one instance for the app.
 *
 * It used to live inside `SplitPanel`, so nothing else could reach it. The
 * viewport's arrow, the HUD and the inspector now read and drive the SAME
 * settings through `SplitControlsProvider`: there is one plane, and the slider,
 * the number field and the arrow all write `offset` here. The viewport draws
 * `store.splitPlane`, which is published from these settings and nothing else.
 *
 * THE ENGINE IS UNCHANGED. Update Preview is explicit (a drag never starts
 * Boolean work), a preview is a worker-resident candidate, Apply commits it
 * with one transaction and Undo restores the exact previous document.
 */

export const SplitPhase = {
  Idle: 'idle',
  Preparing: 'preparing',
  Computing: 'computing',
  Preview: 'preview',
  Applying: 'applying',
  Undoing: 'undoing',
} as const;
export type SplitPhase = (typeof SplitPhase)[keyof typeof SplitPhase];

export interface ConnectorSettings {
  readonly kind: OfferedConnectorKind;
  readonly count: 1 | 2 | 3 | 4;
  readonly diameter: number;
  readonly depth: number;
  readonly clearance: number;
  readonly maleSide: 'A' | 'B';
}

export const DEFAULT_CONNECTOR: ConnectorSettings = Object.freeze({
  kind: 'none',
  count: 1,
  diameter: 4,
  depth: 6,
  clearance: 0.2,
  maleSide: 'A',
});

const DEFAULT_PLANE: SplitPlaneSettings = Object.freeze(resetPlaneSettings('Z'));

export interface AppliedSplit {
  readonly pieceA: string;
  readonly pieceB: string;
  readonly recordId: string;
  readonly metrics: SplitCreateResult['metrics'];
  readonly section: SplitCreateResult['section'];
  readonly connector: SplitCreateResult['connector'];
  /** The document revision the split produced. Anything later ends it. */
  readonly revision: number;
}

export const SplitExportState = {
  Idle: 'idle',
  Exporting: 'exporting',
  Done: 'done',
  Failed: 'failed',
} as const;
export type SplitExportState = (typeof SplitExportState)[keyof typeof SplitExportState];

export interface SplitControls {
  readonly part: PartDescriptor | undefined;
  readonly unit: string | undefined;
  readonly plane: SplitPlaneSettings;
  readonly range: SplitRange;
  /** The effective offset: the setting, or the part's centre when unset. */
  readonly offset: number;
  readonly splitPlane: SplitPlane;
  readonly connector: ConnectorSettings;
  readonly connectorsAvailable: boolean;
  /** Why the connector settings cannot be built, or undefined. */
  readonly connectorProblem: string | undefined;
  readonly phase: SplitPhase;
  readonly progress: string;
  readonly error: string | undefined;
  /**
   * True when `error` is the worker declining the split for RESOURCES (a limit, not a defect in the
   * cut). Shown as a neutral status, never an alert, and never as a prompt to try another way.
   */
  readonly errorIsResourceLimit: boolean;
  /** Presentation only: an unexpected runtime failure or a failed commit, rather than an unsafe cut. */
  readonly errorIsOperationFailure?: boolean;
  /**
   * True when `error` is the worker refusing what the connector was asked to BE (no unit, a placement that is not a similarity, a size
   * outside the physical range) rather than anything about the cut. Shown as its own sentence, without advice about the cut.
   */
  readonly errorIsConnectorInput?: boolean;
  /**
   * The reasons, when the worker refused the split because the part is not a closed solid. A status
   * with Repair as the next step, never an alert and never a retry.
   */
  readonly sourceNotClosed: readonly string[] | undefined;
  /**
   * Set when the part has more triangles than the exact split supports. Deterministic and known from
   * the part's descriptor, so Preview is not offered and the page says why before anything runs.
   */
  readonly sizeNotice: SplitSizeNotice | undefined;
  readonly preview: SplitCreateResult | undefined;
  readonly applied: AppliedSplit | undefined;
  /** Whether Undo split still reverses the latest change: false once a connector edit has superseded the split's own undo record. */
  readonly appliedUndoable: boolean;
  readonly exportState: SplitExportState;
  readonly exportMessage: string | undefined;
  readonly setAxis: (axis: SplitAxis) => void;
  readonly setOffset: (value: number) => void;
  readonly setTilt: (value: number) => void;
  readonly setRoll: (value: number) => void;
  readonly flipPlane: () => void;
  readonly pieceView: SplitPieceView;
  readonly setPieceView: (view: SplitPieceView) => void;
  readonly resetPlane: () => void;
  readonly beginPlaneDrag: () => void;
  readonly dragPlane: (distanceAlongNormal: number) => void;
  readonly setConnector: (patch: Partial<ConnectorSettings>) => void;
  readonly preparePreview: (load: () => void) => void;
  readonly completePreparedPreview: () => void;
  readonly updatePreview: () => void;
  readonly discardPreview: () => void;
  readonly assemblyEditing?: boolean;
  readonly beginNextSplit?: () => void;
  readonly apply: () => void;
  readonly cancel: () => void;
  readonly undo: () => void;
  readonly exportPieces: () => void;
}

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message !== '' ? cause.message : fallback;

/** The worker refused what the connector was asked to be (its unit, its placement, its size), not the cut. */
const isConnectorInputRefusal = (cause: unknown): boolean =>
  isAppError(cause) &&
  typeof cause.details.code === 'string' &&
  CONNECTOR_INPUT_REFUSAL_CODES.includes(cause.details.code);

/** The worker declined for resources: a limit it enforces, as opposed to a cut it found unsound. */
const isResourceRefusal = (cause: unknown): boolean =>
  isAppError(cause) && cause.code === AppErrorCode.ResourceLimitExceeded;

/**
 * The connector request, stated PHYSICALLY. The panel's sizes are millimetres and they are sent as millimetres, with the unit the
 * model's coordinates are read in; the engine turns them into the part's own lengths in one place (`resolveConnectorDimensions`),
 * so this function converts nothing. Without a known unit the request carries none, which the engine refuses rather than defaults —
 * connectors are not offered then, so the refusal is a guard, not a flow.
 */
export function connectorRequest(
  settings: ConnectorSettings,
  unit: LengthUnit | undefined,
): ProductConnectorRequest {
  switch (settings.kind) {
    case 'none':
      return { kind: 'none' };
    case 'pin':
      return {
        kind: 'physical-pin',
        unit,
        count: settings.count,
        diameterMm: settings.diameter,
        depthMm: settings.depth,
        clearanceMm: settings.clearance,
        maleSide: settings.maleSide,
      };
  }
}

/**
 * The first dimension the engine would refuse, named, or undefined.
 *
 * The range is PHYSICAL — millimetres, the same for every model — and nothing here converts a size into the model's units: the
 * engine's one resolver judges the millimetre intent before it converts it (Stage C03-C1), so a size that is in range is in range
 * whether the model is read as millimetres, inches or metres, and this hint says exactly that and no more.
 */
export function connectorProblemOf(settings: ConnectorSettings): string | undefined {
  if (settings.kind === 'none') return undefined;
  const checks: [number, string, boolean][] = [
    [settings.diameter, 'Pin diameter', false],
    [settings.depth, 'Depth', false],
    [settings.clearance, 'Clearance', true],
  ];
  for (const [value, label, zero] of checks)
    if (!isValidDimension(value, zero))
      return `${label} must be between ${zero ? '0' : '0.01'} and 1000 mm.`;
  return undefined;
}

export function useSplitWorkflow(): SplitControls {
  const { selectedWorkflow, model, activePartId, assembly, joints, connectorEditRevision } =
    useWorkspaceState();
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const part = model?.parts.find((candidate) => candidate.partId === activePartId);
  const { unit: unitValue } = useUnitInterpretation();
  const active = selectedWorkflow === WorkflowId.Split;

  /*
   * A NEW PART OR A NEW DOCUMENT IS A NEW CUT. Everything that describes one
   * cut — the plane, a preview, an error — is stored WITH the part it was made
   * for and read back only for that part, so switching parts shows the new
   * part's defaults at once rather than one render after an effect resets them.
   */
  const partKey =
    model === undefined || part === undefined ? '' : `${model.handle.documentId}/${part.partId}`;

  const [planeState, setPlaneState] = useState<{
    readonly key: string;
    readonly settings: SplitPlaneSettings;
  }>({ key: '', settings: DEFAULT_PLANE });
  const plane = planeState.key === partKey ? planeState.settings : DEFAULT_PLANE;
  const [connectorState, setConnectorState] = useState<ConnectorSettings>(DEFAULT_CONNECTOR);
  /*
   * WORK IS SCOPED TO A SESSION: this part, while the workspace is shown.
   * Phase, progress, preview and error are stored with the session they were
   * made in and read back only for it, so leaving the workspace or selecting
   * another part retires them without an effect having to reset anything. The
   * worker-side resources they held are released by the cleanup below.
   */
  // The reading of the units is part of the session: connector sizes mean something
  // else under a different one, so a preview made under the old reading is retired.
  const session = active ? `${partKey}|${unitValue ?? ''}` : '';
  const [work, setWork] = useState<{
    readonly session: string;
    readonly phase: SplitPhase;
    readonly progress: string;
  }>({ session: '', phase: SplitPhase.Idle, progress: '' });
  const [errorState, setErrorState] = useState<
    | {
        readonly key: string;
        readonly message: string;
        readonly resource: boolean;
        readonly failure?: boolean;
        /** Set when the worker refused what the connector was asked to be (its unit, its placement or its size). */
        readonly connectorInput?: boolean;
        /** Set when the worker refused because the part is not a closed solid: the reasons it gave. */
        readonly notClosed?: readonly string[];
      }
    | undefined
  >(undefined);
  const [previewState, setPreviewState] = useState<
    { readonly key: string; readonly result: SplitCreateResult } | undefined
  >(undefined);
  const [appliedState, setApplied] = useState<AppliedSplit | undefined>(undefined);
  const [exportRecord, setExportRecord] = useState<
    | { readonly recordId: string; readonly state: SplitExportState; readonly message?: string }
    | undefined
  >(undefined);
  const running = useRef<OperationHandle<unknown> | undefined>(undefined);
  const previewRef = useRef<SplitCreateResult | undefined>(undefined);
  const action = useRef<{ phase: SplitPhase } | undefined>(undefined);
  const [assemblyEditing, setAssemblyEditing] = useState(false);
  const dragStart = useRef<number | undefined>(undefined);

  const error = errorState?.key === session ? errorState.message : undefined;
  const errorIsResourceLimit = errorState?.key === session && errorState.resource;
  const sourceNotClosed = errorState?.key === session ? errorState.notClosed : undefined;
  const partTriangles = part?.triangleCount;
  const sizeNotice = useMemo(() => splitSizeNoticeFor(partTriangles), [partTriangles]);
  const preview = previewState?.key === session ? previewState.result : undefined;
  const rawPhase =
    work.phase === SplitPhase.Applying ||
    work.phase === SplitPhase.Undoing ||
    work.session === session
      ? work.phase
      : SplitPhase.Idle;
  const progress =
    work.phase === SplitPhase.Applying ||
    work.phase === SplitPhase.Undoing ||
    work.session === session
      ? work.progress
      : '';
  const phase =
    rawPhase === SplitPhase.Preview && preview === undefined ? SplitPhase.Idle : rawPhase;
  /* The applied split ends when the document moves on — Undo, another edit, a new file. */
  const stillHere = appliedState?.revision === model?.revision;
  // A connector edit, or the undo of one, replaces the cut's two meshes and nothing else: the split's result (the pieces, Export) is
  // still true of that revision. Undoing the SPLIT is not: its record has been superseded by the edit, so only `stillHere` offers it.
  const continuedByConnectorEdit =
    appliedState !== undefined &&
    model !== undefined &&
    connectorEditRevision === model.revision &&
    model.parts.some((part) => part.partId === appliedState.pieceA) &&
    model.parts.some((part) => part.partId === appliedState.pieceB);
  const applied =
    rawPhase === SplitPhase.Undoing || stillHere || continuedByConnectorEdit
      ? appliedState
      : undefined;
  const exportState =
    applied !== undefined && exportRecord?.recordId === applied.recordId
      ? exportRecord.state
      : SplitExportState.Idle;
  const exportMessage =
    applied !== undefined && exportRecord?.recordId === applied.recordId
      ? exportRecord.message
      : undefined;

  /* Which piece of a preview is drawn: presentation, scoped to the session like a preview. */
  const [pieceViewState, setPieceViewState] = useState<{
    readonly key: string;
    readonly view: SplitPieceView;
  }>({ key: '', view: 'both' });
  const pieceView: SplitPieceView = pieceViewState.key === session ? pieceViewState.view : 'both';
  const setPieceView = useCallback(
    (view: SplitPieceView): void => {
      setPieceViewState({ key: session, view });
    },
    [session],
  );

  const bounds = part?.bounds;
  const range = useMemo(() => splitRange(plane.axis, bounds), [bounds, plane.axis]);
  const offset = plane.offset ?? range.center;
  const splitPlane = useMemo(() => splitPlaneFor(plane, bounds), [bounds, plane]);
  const available = connectorsAvailable(unitValue);
  /* Connectors that cannot be built are never the selected kind. */
  const connector: ConnectorSettings = useMemo(
    () => (available ? connectorState : { ...connectorState, kind: 'none' }),
    [available, connectorState],
  );
  const connectorProblem = available ? connectorProblemOf(connector) : undefined;

  const setError = useCallback(
    (message: string | undefined, failure = false): void => {
      setErrorState(
        message === undefined ? undefined : { key: session, message, resource: false, failure },
      );
    },
    [session],
  );
  /** A refusal because the part is not a closed solid: the same slot, with the reasons the worker gave. */
  const setNotClosedError = useCallback(
    (message: string, reasons: readonly string[]): void => {
      setErrorState({ key: session, message, resource: false, notClosed: reasons });
    },
    [session],
  );
  /** A refusal about what the connector was asked to be: the same slot, marked so the page does not blame the cut. */
  const setConnectorInputError = useCallback(
    (message: string): void => {
      setErrorState({ key: session, message, resource: false, connectorInput: true });
    },
    [session],
  );
  /** A refusal for RESOURCES: the same slot, marked so the page can show it as a decision. */
  const setResourceError = useCallback(
    (message: string): void => {
      setErrorState({ key: session, message, resource: true });
    },
    [session],
  );
  const setPlane = useCallback(
    (next: (current: SplitPlaneSettings) => SplitPlaneSettings): void => {
      setPlaneState((current) => ({
        key: partKey,
        settings: next(current.key === partKey ? current.settings : DEFAULT_PLANE),
      }));
    },
    [partKey],
  );

  const setPhase = useCallback(
    (phase: SplitPhase, note = ''): void => {
      setWork({ session, phase, progress: note });
    },
    [session],
  );
  const setProgress = useCallback(
    (note: string): void => {
      setWork((current) =>
        current.session === session ? { ...current, progress: note } : current,
      );
    },
    [session],
  );

  /**
   * Releases what lives OUTSIDE React: the running operation, the worker-side
   * candidate and the store's preview. Sets no React state, so an effect's
   * cleanup may call it.
   */
  const release = useCallback((): void => {
    running.current?.cancel();
    running.current = undefined;
    const candidate = previewRef.current?.candidate;
    if (candidate !== undefined && client !== undefined) {
      client.discardSplit(candidate).promise.catch((cause: unknown) => {
        store.pushStatus(
          StatusSeverity.Warning,
          messageOf(cause, 'A discarded split preview could not be released.'),
        );
      });
    }
    previewRef.current = undefined;
    store.clearSplitPreview();
  }, [client, store]);

  /** Release, and retire this session's preview — for the user's own edits. */
  const invalidate = useCallback((): void => {
    if (
      action.current?.phase === SplitPhase.Applying ||
      action.current?.phase === SplitPhase.Undoing
    )
      return;
    release();
    setPreviewState(undefined);
    if (action.current?.phase !== SplitPhase.Preparing) {
      action.current = undefined;
      setPhase(SplitPhase.Idle);
    }
  }, [release, setPhase]);

  /*
   * A NEW SESSION RELEASES THE OLD ONE'S RESOURCES — another part, another
   * document, or leaving the workspace — and so does unmounting. Nothing
   * unapplied outlives the session it was made in.
   */
  useEffect(
    () => (): void => {
      if (
        action.current?.phase !== SplitPhase.Applying &&
        action.current?.phase !== SplitPhase.Undoing
      )
        action.current = undefined;
      release();
    },
    [release, session],
  );

  /* The ONE plane the viewport draws, published from these settings only. */
  useEffect(() => {
    if (!active || model === undefined || part === undefined) {
      store.setSplitPlane(undefined);
      return;
    }
    store.setSplitPlane({ ...splitPlane, revision: model.revision });
  }, [active, model, part, splitPlane, store]);

  const edit = useCallback(
    (next: (current: SplitPlaneSettings) => SplitPlaneSettings): void => {
      if (action.current !== undefined && action.current.phase !== SplitPhase.Preparing) return;
      invalidate();
      setError(undefined);
      setPlane(next);
    },
    [invalidate, setError, setPlane],
  );

  const setAxis = useCallback(
    (axis: SplitAxis) => {
      edit(() => resetPlaneSettings(axis));
    },
    [edit],
  );
  const setOffset = useCallback(
    (value: number) => {
      edit((current) => ({
        ...current,
        offset: clampOffset(value, range, current.offset ?? range.center),
      }));
    },
    [edit, range],
  );
  const setTilt = useCallback(
    (value: number) => {
      edit((current) => ({ ...current, tilt: clampTilt(value, current.tilt) }));
    },
    [edit],
  );
  const setRoll = useCallback(
    (value: number) => {
      edit((current) => ({ ...current, roll: clampRoll(value, current.roll) }));
    },
    [edit],
  );
  const flipPlane = useCallback(() => {
    edit((current) => ({ ...current, flipped: !current.flipped }));
  }, [edit]);
  const resetPlane = useCallback(() => {
    edit((current) => resetPlaneSettings(current.axis));
  }, [edit]);

  const beginPlaneDrag = useCallback(() => {
    if (action.current !== undefined) return;
    invalidate();
    dragStart.current = offset;
  }, [invalidate, offset]);
  const dragPlane = useCallback(
    (distance: number) => {
      // The viewport sends move events after start: suppress both while an action owns the plane.
      if (action.current !== undefined) return;
      const start = dragStart.current ?? offset;
      setPlane((current) => ({
        ...current,
        offset: offsetAfterNormalDrag(start, distance, splitPlane, current.axis, range),
      }));
    },
    [offset, range, setPlane, splitPlane],
  );

  const setConnector = useCallback(
    (patch: Partial<ConnectorSettings>) => {
      if (action.current !== undefined && action.current.phase !== SplitPhase.Preparing) return;
      invalidate();
      setError(undefined);
      setConnectorState((current) => ({ ...current, ...patch }));
    },
    [invalidate, setError],
  );

  const runPreview = useCallback(
    (prepared = false): void => {
      if (prepared ? action.current?.phase !== SplitPhase.Preparing : action.current !== undefined)
        return;
      const abandonPreparation = (): void => {
        if (prepared) {
          action.current = undefined;
          setPhase(SplitPhase.Idle);
        }
      };
      if (client === undefined || model === undefined || part === undefined) {
        abandonPreparation();
        return;
      }
      // Above the supported size nothing can be previewed: the page already says so, and the worker
      // would only refuse. Asking it would turn a known fact into a failure.
      if (sizeNotice !== undefined) {
        abandonPreparation();
        return;
      }
      if (
        assembly?.documentId === model.handle.documentId &&
        assembly.revision === model.handle.revision &&
        assembly.interfaces.length >= 128
      ) {
        abandonPreparation();
        setError(
          'This assembly has reached the supported connection limit. Export the pieces to continue in a new document.',
        );
        return;
      }

      // The interfaces are the layout's, and only the current revision's; the connectors are the worker's own list for this revision.
      const layout =
        assembly?.documentId === model.handle.documentId &&
        assembly.revision === model.handle.revision
          ? assembly
          : undefined;
      if (
        !preservesAssemblyInterfaces(
          layout,
          part.partId,
          splitPlane,
          part.transform,
          connectorPairsOf(currentJoints(joints, model.handle)),
        )
      ) {
        abandonPreparation();
        setError('This cut crosses an existing connection. Move the cut between connections.');
        return;
      }

      if (connector.kind !== 'none' && (!available || connectorProblem !== undefined)) {
        abandonPreparation();
        return;
      }
      const token = { phase: SplitPhase.Computing };
      action.current = token;
      const showBusy = (): void => {
        setError(undefined);
        setPhase(SplitPhase.Computing, 'Checking split…');
      };
      if (prepared) showBusy();
      else flushSync(showBusy);
      void (async (): Promise<void> => {
        try {
          await afterPaint();
          if (action.current !== token) return;
          release();
          setPreviewState(undefined);
          const onProgress = (update: { readonly note?: string }): void => {
            setProgress(update.note ?? 'Computing…');
          };
          const operation = client.createSplit(
            model.handle,
            part.partId,
            { plane: splitPlane, connector: connectorRequest(connector, unitValue) },
            onProgress,
          );
          running.current = operation;
          const result = await operation.promise;
          {
            if (running.current !== operation) return;
            running.current = undefined;
            previewRef.current = result;
            setPreviewState({ key: session, result });
            store.setSplitPreview(
              model.handle,
              result.render,
              result.parts,
              assemblyForSplitPreview(
                model.handle,
                result,
                {
                  sourcePartId: part.partId,
                  sourceTransform: part.transform,
                  plane: result.interface?.plane ?? splitPlane,
                },
                store.getSnapshot().assembly,
              ),
            );
            await afterPaint();
            if (action.current === token) setPhase(SplitPhase.Preview);
          }
        } catch (cause: unknown) {
          if (action.current !== token) return;
          running.current = undefined;
          setPhase(SplitPhase.Idle);
          const notClosed = notClosedReasonsOf(cause);
          if (notClosed !== undefined) {
            // A fact about the file, not a failure: a status with a way forward, never an error.
            setNotClosedError("This cut can't be made safely.", notClosed);
            store.pushStatus(StatusSeverity.Info, "This cut can't be made safely.");
            return;
          }
          if (isConnectorInputRefusal(cause)) {
            // A decision about what was asked for, with the worker's own sentence for it; the cut was never examined.
            const refused = messageOf(cause, 'This connector could not be sized.');
            setConnectorInputError(refused);
            store.pushStatus(StatusSeverity.Info, refused);
            return;
          }
          if (isResourceRefusal(cause)) {
            // A decision, not a defect: neutral words that name no limit's internals and no other way.
            setResourceError(RESOURCE_REFUSAL_COPY.body);
            store.pushStatus(StatusSeverity.Info, RESOURCE_REFUSAL_COPY.heading);
            return;
          }
          const message = messageOf(cause, 'The split could not be completed.');
          setError(message, !isAppError(cause) || cause.code === AppErrorCode.Internal);
          store.pushStatus(StatusSeverity.Error, message);
        } finally {
          if (action.current === token) action.current = undefined;
        }
      })();
    },
    [
      assembly,
      joints,
      available,
      client,
      connector,
      connectorProblem,
      unitValue,
      release,
      model,
      part,
      session,
      setError,
      setPhase,
      setProgress,
      setConnectorInputError,
      setNotClosedError,
      setResourceError,
      sizeNotice,
      splitPlane,
      store,
    ],
  );

  const updatePreview = useCallback((): void => {
    runPreview();
  }, [runPreview]);
  const completePreparedPreview = useCallback((): void => {
    runPreview(true);
  }, [runPreview]);
  const preparePreview = useCallback(
    (load: () => void): void => {
      if (action.current !== undefined) return;
      const token = { phase: SplitPhase.Preparing };
      action.current = token;
      flushSync(() => {
        setPhase(SplitPhase.Preparing, 'Checking split…');
      });
      void (async (): Promise<void> => {
        try {
          await afterPaint();
          if (action.current === token) load();
        } catch (cause: unknown) {
          if (action.current !== token) return;
          action.current = undefined;
          setPhase(SplitPhase.Idle);
          const message = messageOf(cause, 'The split could not be completed.');
          setError(message);
          store.pushStatus(StatusSeverity.Error, message);
        }
      })();
    },
    [setPhase, setError, store],
  );

  const apply = useCallback((): void => {
    if (client === undefined || model === undefined || part === undefined) return;
    const current = previewRef.current;
    if (current === undefined) return;
    if (action.current !== undefined) return;
    const token = { phase: SplitPhase.Applying };
    action.current = token;
    flushSync(() => {
      setPhase(SplitPhase.Applying);
    });
    let dispatched = false;
    let commitTransactionId: string | undefined;
    // Only completed local adoption lets a dispatched commit's preview survive.
    let successfullyAdopted = false;
    const recovery: { required: boolean } = { required: false };
    let failureMessage = 'The split could not be applied. Preview the piece again.';
    const withdrawFailedApply = (): void => {
      const safely = (effect: () => void): void => {
        try {
          effect();
        } catch {
          /* Cleanup cannot revive the old capability. */
        }
      };
      if (previewRef.current === current) {
        previewRef.current = undefined;
        safely(() => {
          setPreviewState(undefined);
        });
        safely(() => {
          store.clearSplitPreview();
        });
      }
      if (action.current === token || action.current === undefined)
        safely(() => {
          setPhase(SplitPhase.Idle);
        });
      safely(() => {
        setError(failureMessage, true);
      });
      safely(() => {
        store.pushStatus(StatusSeverity.Error, failureMessage);
      });
      try {
        void client.discardSplit(current.candidate).promise.catch(() => undefined);
      } catch {
        /* Best effort only. */
      }
    };
    const awaitRecovery = (transactionId: string): void => {
      recovery.required = true;
      if (client.isLost) {
        setPhase(SplitPhase.Idle);
        action.current = undefined;
        setError('The geometry worker ended. Reload and re-import the model.', true);
        return;
      }
      client.onSplitCommitRecovered(transactionId, (status: SplitTransactionStatus): void => {
        if (action.current !== token) return;
        if (status.state === 'FINALIZED') {
          previewRef.current = undefined;
          setPreviewState(undefined);
          setAssemblyEditing(false);
          const adopted = store.getSnapshot().model,
            finalizedHandle = status.handle;
          if (!adopted || !finalizedHandle) {
            setPhase(SplitPhase.Idle);
            action.current = undefined;
            return;
          }
          if (
            status.recordId &&
            adopted.handle.documentId === finalizedHandle.documentId &&
            adopted.handle.revision === finalizedHandle.revision
          ) {
            setApplied({
              pieceA: current.pieceAId,
              pieceB: current.pieceBId,
              recordId: status.recordId,
              metrics: current.metrics,
              section: current.section,
              connector: current.connector,
              revision: adopted.revision,
            });
            setError('');
          }
        } else {
          failureMessage = 'The split was not applied. Preview the part again.';
          withdrawFailedApply();
        }
        setPhase(SplitPhase.Idle);
        action.current = undefined;
      });
      setError('Reconnect the split transaction before editing can continue.', true);
    };
    void (async (): Promise<void> => {
      try {
        await afterPaint();
        if (action.current !== token) return;
        commitTransactionId = client.reserveSplitCommit(current.candidate, model.handle);
        const operation = client.commitSplit(
          current.candidate,
          model.handle,
          part.partId,
          commitTransactionId,
        );
        // A returned handle follows synchronous transport submission. A throw
        // before return leaves this Preview retryable; later outcomes may have
        // consumed Worker authority and must retain fail-closed recovery.
        dispatched = true;
        const rollback = store.splitAdoptionCheckpoint(commitTransactionId);
        const result = await adoptSplitCommit(
          client,
          operation,
          (prepared) =>
            store.applySplitResult(prepared, {
              sourcePartId: part.partId,
              sourceTransform: part.transform,
              plane: splitPlane,
            }),
          rollback,
        );
        {
          previewRef.current = undefined;
          setPreviewState(undefined);

          setAssemblyEditing(false);
          setApplied({
            pieceA: result.pieceAId,
            pieceB: result.pieceBId,
            recordId: result.recordId,
            metrics: result.metrics,
            section: result.section,
            connector: result.connector,
            revision: store.getSnapshot().model?.revision ?? -1,
          });
          store.pushStatus(StatusSeverity.Success, 'Split applied. Piece A and Piece B are ready.');
          await afterPaint();
          if (action.current === token) setPhase(SplitPhase.Idle);
          successfullyAdopted = true;
        }
      } catch (cause: unknown) {
        if (!dispatched && commitTransactionId) {
          try {
            const status = await recoverSplitCommit(client, commitTransactionId, false);
            if (status.state === 'FINALIZED')
              throw new SplitCommitRecoveryRequired(commitTransactionId);
            dispatched = status.state === 'ABORTED';
            client.confirmSplitReceipt(commitTransactionId, status.state !== 'UNKNOWN');
          } catch {
            awaitRecovery(commitTransactionId);
            return;
          }
        }
        if (cause instanceof SplitCommitRecoveryRequired) {
          awaitRecovery(cause.transactionId);
          return;
        }
        failureMessage = messageOf(cause, 'The split could not be applied.');
        setPhase(SplitPhase.Preview);
        setError(failureMessage, true);
        store.pushStatus(StatusSeverity.Error, failureMessage);
      } finally {
        if (!recovery.required && dispatched && !successfullyAdopted) withdrawFailedApply();
        if (!recovery.required && action.current === token) action.current = undefined;
      }
    })();
  }, [client, model, part, splitPlane, setError, setPhase, store]);

  /**
   * CANCEL ABANDONS THE SPLIT: the preview is released and the plane and
   * connector go back to their defaults, as the Stage 7B panel's Cancel did.
   * Merely switching workspace keeps them, because that is looking elsewhere,
   * not giving up.
   */
  const cancel = useCallback((): void => {
    if (
      action.current?.phase === SplitPhase.Applying ||
      action.current?.phase === SplitPhase.Undoing
    )
      return;
    action.current = undefined;
    invalidate();
    setError(undefined);
    setPlaneState({ key: '', settings: DEFAULT_PLANE });
    setConnectorState(DEFAULT_CONNECTOR);
    store.selectWorkflow(undefined);
  }, [invalidate, setError, store]);

  const undo = useCallback((): void => {
    if (
      client === undefined ||
      model === undefined ||
      applied === undefined ||
      action.current !== undefined
    )
      return;
    const token = { phase: SplitPhase.Undoing };
    action.current = token;
    flushSync(() => {
      setError(undefined);
      setPhase(SplitPhase.Undoing, 'Undoing split…');
    });
    void (async (): Promise<void> => {
      try {
        await afterPaint();
        if (action.current !== token) return;
        const result = await client.undoRepair(model.handle, applied.recordId, () => undefined)
          .promise;
        if (!store.applyUndoResult(result))
          throw new Error('The model changed before Undo completed.');
        store.pushStatus(StatusSeverity.Success, 'Split undone.');
        await afterPaint();
        setApplied(undefined);
      } catch (cause: unknown) {
        const message = messageOf(cause, 'The split could not be undone.');
        setError(message);
        store.pushStatus(StatusSeverity.Error, message);
      } finally {
        if (action.current === token) {
          action.current = undefined;
          setPhase(SplitPhase.Idle);
        }
      }
    })();
  }, [applied, client, model, setError, setPhase, store]);

  /**
   * Each piece through the existing one-part binary STL export, one after the
   * other, each downloaded as it is written. A failure stops the rest and says
   * which piece; the document is not touched either way.
   */
  const exportPieces = useCallback((): void => {
    if (client === undefined || model === undefined || applied === undefined) return;
    if (action.current !== undefined) return;
    const handle = model.handle;
    const sourceName = model.source.fileName;
    const recordId = applied.recordId;
    setExportRecord({ recordId, state: SplitExportState.Exporting });
    const pieces: readonly [string, string][] =
      model.parts.length === 2
        ? [
            ['A', applied.pieceA],
            ['B', applied.pieceB],
          ]
        : model.parts.map((p, index) => [String(index + 1), p.partId]);
    const saved: string[] = [];
    const next = (index: number): void => {
      const piece = pieces[index];
      if (piece === undefined) {
        setExportRecord({
          recordId,
          state: SplitExportState.Done,
          message: `Saved ${saved.join(' and ')}.`,
        });
        store.pushStatus(StatusSeverity.Success, `Saved ${saved.join(' and ')}.`);
        return;
      }
      const [letter, id] = piece;
      const name =
        letter === 'A' || letter === 'B'
          ? deriveSplitPartExportName(sourceName, letter)
          : deriveSplitPartExportName(sourceName, 'A').replace(
              '_part_A.stl',
              `_part_${letter}.stl`,
            );
      client
        .exportModel(handle, id, 'binary', () => undefined)
        .promise.then(
          (result) => {
            downloadBytes(new Uint8Array(result.bytes), name, 'model/stl');
            saved.push(name);
            next(index + 1);
          },
          (cause: unknown) => {
            const message = `Piece ${letter} was not saved: ${messageOf(cause, 'the export failed')}.${
              saved.length === 0 ? '' : ` Already saved: ${saved.join(', ')}.`
            }`;
            setExportRecord({ recordId, state: SplitExportState.Failed, message });
            store.pushStatus(StatusSeverity.Error, message);
          },
        );
    };
    next(0);
  }, [applied, client, model, store]);

  return {
    part,
    unit: unitValue,
    plane,
    range,
    offset,
    splitPlane,
    connector,
    connectorsAvailable: available,
    connectorProblem,
    phase,
    progress,
    error,
    errorIsResourceLimit,
    errorIsOperationFailure: errorState?.key === session && errorState.failure === true,
    errorIsConnectorInput: errorState?.key === session && errorState.connectorInput === true,
    sourceNotClosed,
    sizeNotice,
    preview,
    applied,
    appliedUndoable: stillHere,
    exportState,
    exportMessage,
    setAxis,
    setOffset,
    setTilt,
    setRoll,
    flipPlane,
    pieceView,
    setPieceView,
    resetPlane,
    beginPlaneDrag,
    dragPlane,
    setConnector,
    preparePreview,
    completePreparedPreview,
    updatePreview,
    discardPreview: invalidate,
    assemblyEditing,
    beginNextSplit: (): void => {
      setAssemblyEditing(true);
    },
    apply,
    cancel,
    undo,
    exportPieces,
  };
}
