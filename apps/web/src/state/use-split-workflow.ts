import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  OperationHandle,
  PartDescriptor,
  SplitConnector,
  SplitCreateResult,
  SplitPlane,
} from '@cadfixer/geometry-runtime';
import { useGeometryClient } from '../runtime/client-context';
import { deriveSplitPartExportName, downloadBytes } from '../runtime/download';
import {
  clampOffset,
  clampTilt,
  connectorsAvailable,
  isValidDimension,
  offsetAfterNormalDrag,
  splitPlaneFor,
  splitRange,
  type ConnectorKind,
  type SplitAxis,
  type SplitPlaneSettings,
  type SplitRange,
} from './split-presentation';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import type { LengthUnit } from '@cadfixer/shared';
import { millimetresToCoordinates, unitWord } from './unit-interpretation';
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
  Computing: 'computing',
  Preview: 'preview',
  Applying: 'applying',
} as const;
export type SplitPhase = (typeof SplitPhase)[keyof typeof SplitPhase];

export interface ConnectorSettings {
  readonly kind: ConnectorKind;
  readonly count: 1 | 2 | 3 | 4;
  readonly diameter: number;
  readonly depth: number;
  readonly clearance: number;
  readonly maleSide: 'A' | 'B';
  readonly dovetailWidth: number;
  readonly dovetailLength: number;
  readonly dovetailAngle: 0 | 90;
}

export const DEFAULT_CONNECTOR: ConnectorSettings = Object.freeze({
  kind: 'none',
  count: 1,
  diameter: 4,
  depth: 6,
  clearance: 0.2,
  maleSide: 'A',
  dovetailWidth: 8,
  dovetailLength: 12,
  dovetailAngle: 0,
});

const DEFAULT_PLANE: SplitPlaneSettings = Object.freeze({ axis: 'Z', offset: undefined, tilt: 0 });

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
  readonly preview: SplitCreateResult | undefined;
  readonly applied: AppliedSplit | undefined;
  readonly exportState: SplitExportState;
  readonly exportMessage: string | undefined;
  readonly setAxis: (axis: SplitAxis) => void;
  readonly setOffset: (value: number) => void;
  readonly setTilt: (value: number) => void;
  readonly resetPlane: () => void;
  readonly beginPlaneDrag: () => void;
  readonly dragPlane: (distanceAlongNormal: number) => void;
  readonly setConnector: (patch: Partial<ConnectorSettings>) => void;
  readonly updatePreview: () => void;
  readonly discardPreview: () => void;
  readonly apply: () => void;
  readonly cancel: () => void;
  readonly undo: () => void;
  readonly exportPieces: () => void;
}

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message !== '' ? cause.message : fallback;

/**
 * The connector request in the MODEL'S coordinate units. The panel's sizes are
 * physical (millimetres); a model read as inches has 25.4 mm to a coordinate
 * unit. Without a known unit nothing is converted, because connectors are not
 * offered then.
 */
export function connectorRequest(
  rawSettings: ConnectorSettings,
  unit: LengthUnit | undefined,
): SplitConnector {
  const toCoordinates = (millimetres: number): number =>
    unit === undefined ? millimetres : millimetresToCoordinates(millimetres, unit);
  const settings: ConnectorSettings =
    rawSettings.kind === 'none'
      ? rawSettings
      : {
          ...rawSettings,
          diameter: toCoordinates(rawSettings.diameter),
          depth: toCoordinates(rawSettings.depth),
          clearance: toCoordinates(rawSettings.clearance),
          dovetailWidth: toCoordinates(rawSettings.dovetailWidth),
          dovetailLength: toCoordinates(rawSettings.dovetailLength),
        };
  switch (settings.kind) {
    case 'none':
      return { kind: 'none' };
    case 'pin':
      return {
        kind: 'pin',
        count: settings.count,
        diameter: settings.diameter,
        depth: settings.depth,
        clearance: settings.clearance,
        maleSide: settings.maleSide,
      };
    case 'dovetail':
      return {
        kind: 'dovetail',
        width: settings.dovetailWidth,
        depth: settings.depth,
        length: settings.dovetailLength,
        clearance: settings.clearance,
        maleSide: settings.maleSide,
        orientationDegrees: settings.dovetailAngle,
      };
  }
}

/** The first dimension the engine would refuse, named, or undefined. */
export function connectorProblemOf(
  settings: ConnectorSettings,
  unit?: LengthUnit,
): string | undefined {
  if (settings.kind === 'none') return undefined;
  const checks: [number, string, boolean][] =
    settings.kind === 'pin'
      ? [
          [settings.diameter, 'Pin diameter', false],
          [settings.depth, 'Depth', false],
          [settings.clearance, 'Clearance', true],
        ]
      : [
          [settings.dovetailWidth, 'Width', false],
          [settings.dovetailLength, 'Length', false],
          [settings.depth, 'Depth', false],
          [settings.clearance, 'Clearance', true],
        ];
  for (const [value, label, zero] of checks) {
    if (!isValidDimension(value, zero))
      return `${label} must be between ${zero ? '0' : '0.01'} and 1000 mm.`;
    // The engine bounds the dimension in the MODEL'S units, which differ from
    // millimetres for a model read as inches, metres and so on.
    if (unit !== undefined && !isValidDimension(millimetresToCoordinates(value, unit), zero))
      return `${label} is outside the range Pybrix can build in a model read as ${unitWord(unit).toLowerCase()}.`;
  }
  return undefined;
}

export function useSplitWorkflow(): SplitControls {
  const { selectedWorkflow, model, activePartId } = useWorkspaceState();
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
    { readonly key: string; readonly message: string } | undefined
  >(undefined);
  const [previewState, setPreviewState] = useState<
    { readonly key: string; readonly result: SplitCreateResult } | undefined
  >(undefined);
  const [appliedState, setApplied] = useState<AppliedSplit | undefined>(undefined);
  const [exportRecord, setExportRecord] = useState<
    | { readonly recordId: string; readonly state: SplitExportState; readonly message?: string }
    | undefined
  >(undefined);
  const running = useRef<OperationHandle<SplitCreateResult> | undefined>(undefined);
  const previewRef = useRef<SplitCreateResult | undefined>(undefined);
  const dragStart = useRef<number | undefined>(undefined);

  const error = errorState?.key === session ? errorState.message : undefined;
  const preview = previewState?.key === session ? previewState.result : undefined;
  const rawPhase = work.session === session ? work.phase : SplitPhase.Idle;
  const progress = work.session === session ? work.progress : '';
  const phase =
    rawPhase === SplitPhase.Preview && preview === undefined ? SplitPhase.Idle : rawPhase;
  /* The applied split ends when the document moves on — Undo, another edit, a new file. */
  const applied = appliedState?.revision === model?.revision ? appliedState : undefined;
  const exportState =
    applied !== undefined && exportRecord?.recordId === applied.recordId
      ? exportRecord.state
      : SplitExportState.Idle;
  const exportMessage =
    applied !== undefined && exportRecord?.recordId === applied.recordId
      ? exportRecord.message
      : undefined;

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
  const connectorProblem = available ? connectorProblemOf(connector, unitValue) : undefined;

  const setError = useCallback(
    (message: string | undefined): void => {
      setErrorState(message === undefined ? undefined : { key: session, message });
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
    release();
    setPreviewState(undefined);
    setPhase(SplitPhase.Idle);
  }, [release, setPhase]);

  /*
   * A NEW SESSION RELEASES THE OLD ONE'S RESOURCES — another part, another
   * document, or leaving the workspace — and so does unmounting. Nothing
   * unapplied outlives the session it was made in.
   */
  useEffect(() => release, [release, session]);

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
      invalidate();
      setError(undefined);
      setPlane(next);
    },
    [invalidate, setError, setPlane],
  );

  const setAxis = useCallback(
    (axis: SplitAxis) => {
      edit(() => ({ axis, offset: undefined, tilt: 0 }));
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
  const resetPlane = useCallback(() => {
    edit((current) => ({ axis: current.axis, offset: undefined, tilt: 0 }));
  }, [edit]);

  const beginPlaneDrag = useCallback(() => {
    invalidate();
    dragStart.current = offset;
  }, [invalidate, offset]);
  const dragPlane = useCallback(
    (distance: number) => {
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
      invalidate();
      setError(undefined);
      setConnectorState((current) => ({ ...current, ...patch }));
    },
    [invalidate, setError],
  );

  const updatePreview = useCallback((): void => {
    if (client === undefined || model === undefined || part === undefined) return;
    if (connector.kind !== 'none' && (!available || connectorProblem !== undefined)) return;
    invalidate();
    setError(undefined);
    setPhase(SplitPhase.Computing, 'Checking split…');
    const operation = client.createSplit(
      model.handle,
      part.partId,
      { plane: splitPlane, connector: connectorRequest(connector, unitValue) },
      (update) => {
        setProgress(update.note ?? 'Computing…');
      },
    );
    running.current = operation;
    operation.promise.then(
      (result) => {
        if (running.current !== operation) return;
        running.current = undefined;
        previewRef.current = result;
        setPreviewState({ key: session, result });
        store.setSplitPreview(model.handle, result.render, result.parts);
        setPhase(SplitPhase.Preview);
      },
      (cause: unknown) => {
        if (running.current !== operation) return;
        running.current = undefined;
        const message = messageOf(cause, 'The split could not be completed.');
        setPhase(SplitPhase.Idle);
        setError(message);
        store.pushStatus(StatusSeverity.Error, message);
      },
    );
  }, [
    available,
    client,
    connector,
    connectorProblem,
    unitValue,
    invalidate,
    model,
    part,
    session,
    setError,
    setPhase,
    setProgress,
    splitPlane,
    store,
  ]);

  const apply = useCallback((): void => {
    if (client === undefined || model === undefined || part === undefined) return;
    const current = previewRef.current;
    if (current === undefined) return;
    setPhase(SplitPhase.Applying);
    client.commitSplit(current.candidate, model.handle, part.partId).promise.then(
      (result) => {
        if (!store.applySplitResult(result)) {
          setPhase(SplitPhase.Preview);
          setError('The model changed before the split could be applied.');
          return;
        }
        previewRef.current = undefined;
        setPreviewState(undefined);
        setPhase(SplitPhase.Idle);
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
      },
      (cause: unknown) => {
        const message = messageOf(cause, 'The split could not be applied.');
        setPhase(SplitPhase.Preview);
        setError(message);
        store.pushStatus(StatusSeverity.Error, message);
      },
    );
  }, [client, model, part, setError, setPhase, store]);

  /**
   * CANCEL ABANDONS THE SPLIT: the preview is released and the plane and
   * connector go back to their defaults, as the Stage 7B panel's Cancel did.
   * Merely switching workspace keeps them, because that is looking elsewhere,
   * not giving up.
   */
  const cancel = useCallback((): void => {
    invalidate();
    setError(undefined);
    setPlaneState({ key: '', settings: DEFAULT_PLANE });
    setConnectorState(DEFAULT_CONNECTOR);
    store.selectWorkflow(undefined);
  }, [invalidate, setError, store]);

  const undo = useCallback((): void => {
    if (client === undefined || model === undefined || applied === undefined) return;
    client
      .undoRepair(model.handle, applied.recordId, () => undefined)
      .promise.then(
        (result) => {
          if (!store.applyUndoResult(result)) {
            setError('The model changed before Undo completed.');
            return;
          }
          setApplied(undefined);
          store.pushStatus(StatusSeverity.Success, 'Split undone.');
        },
        (cause: unknown) => {
          const message = messageOf(cause, 'The split could not be undone.');
          setError(message);
          store.pushStatus(StatusSeverity.Error, message);
        },
      );
  }, [applied, client, model, setError, store]);

  /**
   * Each piece through the existing one-part binary STL export, one after the
   * other, each downloaded as it is written. A failure stops the rest and says
   * which piece; the document is not touched either way.
   */
  const exportPieces = useCallback((): void => {
    if (client === undefined || model === undefined || applied === undefined) return;
    const handle = model.handle;
    const sourceName = model.source.fileName;
    const recordId = applied.recordId;
    setExportRecord({ recordId, state: SplitExportState.Exporting });
    const pieces: readonly ['A' | 'B', string][] = [
      ['A', applied.pieceA],
      ['B', applied.pieceB],
    ];
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
      const name = deriveSplitPartExportName(sourceName, letter);
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
    preview,
    applied,
    exportState,
    exportMessage,
    setAxis,
    setOffset,
    setTilt,
    resetPlane,
    beginPlaneDrag,
    dragPlane,
    setConnector,
    updatePreview,
    discardPreview: invalidate,
    apply,
    cancel,
    undo,
    exportPieces,
  };
}
