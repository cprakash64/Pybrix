import { useCallback, useEffect, useRef, useState } from 'react';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import type {
  DocumentHandle,
  JointDescriptor,
  JointEditRequest,
  JointProposeResult,
  OperationHandle,
} from '@cadfixer/geometry-runtime';
import { useGeometryClient } from '../runtime/client-context';
import { CONNECTOR_EDIT_COPY, describeEditRefusal } from './connector-edit-presentation';
import { currentJoints } from './joint-presentation';
import { isValidDimension } from './split-presentation';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { StatusSeverity } from './workspace-store';

/**
 * CHANGING THE CONNECTORS OF A CUT (Stage EC-5): the draft, the check, the apply and the undo, over `joint/propose` and `joint/commit`.
 *
 * What it edits is a size (diameter, depth, clearance), the male side, or whether the connectors are there at all. Where a connector sits
 * is not editable here: a position is a point on a cut the user cannot see by its two numbers, and a control for it belongs with a
 * handle on the model, not with a pair of fields.
 *
 * THE STATE IS THE WORKER'S. The editor holds a DRAFT of four values and a CANDIDATE handle, never geometry: `joint/propose` builds the
 * candidate in the worker, rebuilding the connectors from the pieces the cut left before any and running every check a split runs, and
 * `joint/commit` applies the one it built. The draft states the digest of the connectors it started from, so a change made against
 * connectors that have since changed is refused by the worker and not applied to them.
 *
 * ALL OF IT IS KEYED BY THE CONNECTORS IT WAS MADE FOR. A draft, a candidate and a refusal belong to one revision of one joint with one
 * set of connectors; the moment any of those moves, they read as nothing, so a candidate for last revision's connectors cannot be shown
 * beside this revision's.
 */

export const ConnectorEditPhase = {
  Idle: 'idle',
  Checking: 'checking',
  Ready: 'ready',
  Applying: 'applying',
} as const;
export type ConnectorEditPhase = (typeof ConnectorEditPhase)[keyof typeof ConnectorEditPhase];

export interface ConnectorDraft {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly clearanceMm: number;
  readonly maleSide: 'A' | 'B';
}

type Kind = 'SET' | 'REMOVE';

interface Candidate {
  readonly kind: Kind;
  readonly result: JointProposeResult;
}

interface EditState {
  /** The connectors this state was made for: document, revision, joint and the digest of what it holds. */
  readonly key: string;
  readonly draft: ConnectorDraft | undefined;
  readonly phase: ConnectorEditPhase;
  readonly candidate: Candidate | undefined;
  /** A refusal, or a failure, in a sentence. Shown until the next action. */
  readonly message: string | undefined;
}

const IDLE = (key: string): EditState => ({
  key,
  draft: undefined,
  phase: ConnectorEditPhase.Idle,
  candidate: undefined,
  message: undefined,
});

export interface ConnectorEditControls {
  /** The attached cut with connectors that the active piece belongs to, or `undefined` when there is none to change. */
  readonly joint: JointDescriptor | undefined;
  /** What the fields show: the draft where there is one, the connectors as they are where there is not. */
  readonly draft: ConnectorDraft | undefined;
  /** Whether the draft differs from the connectors as they are. */
  readonly changed: boolean;
  /** The first value the worker would refuse for being out of range, in a sentence, or `undefined`. */
  readonly problem: string | undefined;
  readonly phase: ConnectorEditPhase;
  /** What the pending candidate is: a new size, or the removal of the connectors. */
  readonly kind: Kind | undefined;
  /** The cut as the pending candidate would leave it, for the sentence that says what changes. */
  readonly after: JointDescriptor | undefined;
  readonly message: string | undefined;
  /** An undo for the change that was last applied to THIS revision, or `undefined`. */
  readonly undoable: boolean;
  /** What was said when the change last applied to THIS revision was applied, or `undefined`. */
  readonly appliedSentence: string | undefined;
  readonly undoing: boolean;
  readonly setDraft: (change: Partial<ConnectorDraft>) => void;
  readonly check: () => void;
  readonly checkRemoval: () => void;
  readonly cancelCheck: () => void;
  readonly apply: () => void;
  readonly discard: () => void;
  readonly undo: () => void;
}

function draftOf(joint: JointDescriptor): ConnectorDraft | undefined {
  const [first] = joint.connector?.pins ?? [];
  if (joint.connector === undefined || first === undefined) return undefined;
  return {
    diameterMm: first.diameterMm,
    depthMm: first.depthMm,
    clearanceMm: first.clearanceMm,
    maleSide: joint.connector.maleSide,
  };
}

/** The first size outside the range the worker judges a connector in, named, or `undefined`. Same range, same sentence as the split's. */
export function draftProblem(draft: ConnectorDraft): string | undefined {
  const checks: readonly (readonly [number, string, boolean])[] = [
    [draft.diameterMm, CONNECTOR_EDIT_COPY.diameter, false],
    [draft.depthMm, CONNECTOR_EDIT_COPY.depth, false],
    [draft.clearanceMm, CONNECTOR_EDIT_COPY.clearance, true],
  ];
  for (const [value, label, zero] of checks)
    if (!isValidDimension(value, zero))
      return `${label} must be between ${zero ? '0' : '0.01'} and 1000 mm.`;
  return undefined;
}

function sameRevision(a: DocumentHandle | undefined, b: DocumentHandle | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.documentId === b.documentId && a.revision === b.revision;
}

function sameDraft(a: ConnectorDraft, b: ConnectorDraft): boolean {
  return (
    Object.is(a.diameterMm, b.diameterMm) &&
    Object.is(a.depthMm, b.depthMm) &&
    Object.is(a.clearanceMm, b.clearanceMm) &&
    a.maleSide === b.maleSide
  );
}

export function useConnectorEdit(): ConnectorEditControls {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { model, activePartId, joints } = useWorkspaceState();
  const handle = model?.handle;

  const listed = currentJoints(joints, handle);
  const joint = listed.find(
    (candidate) =>
      candidate.status === 'ATTACHED' &&
      candidate.connector !== undefined &&
      candidate.specDigest !== undefined &&
      (candidate.aPartId === activePartId || candidate.bPartId === activePartId),
  );
  const key =
    handle === undefined || joint === undefined
      ? ''
      : `${handle.documentId}/${String(handle.revision)}/${joint.jointId}/${joint.specDigest ?? ''}`;

  const [state, setState] = useState<EditState>(IDLE(''));
  // State for other connectors is not state for these: it reads as the idle state, and is replaced on the next action.
  const current = state.key === key ? state : IDLE(key);

  const [applied, setApplied] = useState<
    | {
        readonly handle: DocumentHandle;
        readonly recordId: string;
        /** What was said when it was applied, kept beside the control so it is read where the change was made. */
        readonly sentence: string;
      }
    | undefined
  >(undefined);
  const [undoing, setUndoing] = useState(false);
  // The change last applied is undoable while the model is still at the revision that change produced.
  const appliedHere = sameRevision(applied?.handle, handle) ? applied : undefined;
  const undoable = appliedHere !== undefined;

  // One operation at a time, and a late answer for an operation that was superseded is dropped.
  const running = useRef<OperationHandle<unknown> | undefined>(undefined);
  const generation = useRef(0);
  const live = useRef<{ key: string; candidate: Candidate | undefined }>({
    key: '',
    candidate: undefined,
  });
  // Written after the render, never during it: what the cleanup below reads is the candidate the screen is showing.
  const heldCandidate = current.candidate;
  useEffect(() => {
    live.current = { key, candidate: heldCandidate };
  }, [key, heldCandidate]);

  /*
   * Releasing a candidate is best-effort cleanup of memory the user never owned. A candidate the worker already dropped, or one that died
   * with the worker, is not a fault; anything else is recorded, as an Info line and never as an error, because no action of the user's
   * could help.
   */
  const release = useCallback(
    (candidate: JointProposeResult['candidate']): void => {
      if (client === undefined) return;
      client.discardJointEdit(candidate).promise.catch((cause: unknown) => {
        const error = toAppError(cause);
        if (error.code === AppErrorCode.ModelUnavailable) return;
        store.pushStatus(
          StatusSeverity.Info,
          `A discarded connector change could not be released: ${error.message}`,
        );
      });
    },
    [client, store],
  );

  const fields = joint === undefined ? undefined : draftOf(joint);
  const draft = current.draft ?? fields;
  const changed = draft !== undefined && fields !== undefined && !sameDraft(draft, fields);
  const problem = draft === undefined ? undefined : draftProblem(draft);

  const replace = useCallback(
    (next: Omit<EditState, 'key'>): void => {
      setState({ key, ...next });
    },
    [key, setState],
  );

  const setDraft = useCallback(
    (change: Partial<ConnectorDraft>): void => {
      if (fields === undefined) return;
      // Changing a value discards what was checked for the old one: a candidate describes the values it was built from.
      const stale = live.current.candidate;
      if (stale !== undefined) release(stale.result.candidate);
      setState({
        key,
        draft: { ...(current.draft ?? fields), ...change },
        phase: ConnectorEditPhase.Idle,
        candidate: undefined,
        message: undefined,
      });
    },
    [current.draft, fields, key, release, setState],
  );

  const propose = useCallback(
    (kind: Kind): void => {
      if (
        client === undefined ||
        handle === undefined ||
        joint === undefined ||
        draft === undefined
      )
        return;
      if (kind === 'SET' && (problem !== undefined || !changed)) return;
      const edit: JointEditRequest =
        kind === 'REMOVE'
          ? { kind: 'REMOVE_CONNECTORS' }
          : {
              kind: 'SET_CONNECTORS',
              maleSide: draft.maleSide,
              diameterMm: draft.diameterMm,
              depthMm: draft.depthMm,
              clearanceMm: draft.clearanceMm,
              // Every pin keeps its name and its place: the editor changes what the connectors are, not where they sit.
              pins: (joint.connector?.pins ?? []).map((pin) => ({
                pinId: pin.pinId,
                u: pin.u,
                v: pin.v,
              })),
            };
      const mine = ++generation.current;
      const operation = client.proposeJointEdit(
        handle,
        joint.jointId,
        joint.specDigest ?? '',
        edit,
      );
      running.current = operation;
      setState({
        key,
        draft: current.draft,
        phase: ConnectorEditPhase.Checking,
        candidate: undefined,
        message: undefined,
      });
      operation.promise.then(
        (result) => {
          if (generation.current !== mine) {
            // Superseded while it ran: the worker's candidate is nobody's, so it is released.
            release(result.candidate);
            return;
          }
          running.current = undefined;
          setState({
            key,
            draft: current.draft,
            phase: ConnectorEditPhase.Ready,
            candidate: { kind, result },
            message: undefined,
          });
        },
        (cause: unknown) => {
          if (generation.current !== mine) return;
          running.current = undefined;
          const error = toAppError(cause);
          // A cancel is the user's own act and needs no sentence.
          if (error.code === AppErrorCode.OperationCancelled) {
            setState({
              key,
              draft: current.draft,
              phase: ConnectorEditPhase.Idle,
              candidate: undefined,
              message: undefined,
            });
            return;
          }
          setState({
            key,
            draft: current.draft,
            phase: ConnectorEditPhase.Idle,
            candidate: undefined,
            message: describeEditRefusal(error.details.code, error.message),
          });
        },
      );
    },
    [changed, client, current.draft, draft, handle, joint, key, problem, release, setState],
  );

  const check = useCallback((): void => {
    propose('SET');
  }, [propose]);
  const checkRemoval = useCallback((): void => {
    propose('REMOVE');
  }, [propose]);

  const cancelCheck = useCallback((): void => {
    if (current.phase !== ConnectorEditPhase.Checking) return;
    generation.current += 1;
    running.current?.cancel();
    running.current = undefined;
    replace({
      draft: current.draft,
      phase: ConnectorEditPhase.Idle,
      candidate: undefined,
      message: undefined,
    });
  }, [current.draft, current.phase, replace]);

  const discard = useCallback((): void => {
    const candidate = current.candidate;
    if (candidate === undefined) return;
    release(candidate.result.candidate);
    replace({
      draft: current.draft,
      phase: ConnectorEditPhase.Idle,
      candidate: undefined,
      message: undefined,
    });
  }, [current.candidate, current.draft, release, replace]);

  const apply = useCallback((): void => {
    const candidate = current.candidate;
    if (
      candidate === undefined ||
      client === undefined ||
      handle === undefined ||
      joint === undefined ||
      current.phase !== ConnectorEditPhase.Ready
    )
      return;
    const mine = ++generation.current;
    setState({ ...current, key, phase: ConnectorEditPhase.Applying, message: undefined });
    client
      .commitJointEdit({
        candidate: candidate.result.candidate,
        expectedSource: handle,
        expectedJointId: joint.jointId,
        expectedSpecDigest: joint.specDigest ?? '',
      })
      .promise.then(
        (result) => {
          if (generation.current !== mine) return;
          const adopted = store.applyJointEditResult(result);
          if (!adopted) {
            replace({
              draft: undefined,
              phase: ConnectorEditPhase.Idle,
              candidate: undefined,
              message: describeEditRefusal('JOINT_SPEC_STALE', ''),
            });
            return;
          }
          const sentence = `${candidate.kind === 'REMOVE' ? CONNECTOR_EDIT_COPY.removed : CONNECTOR_EDIT_COPY.applied}. ${CONNECTOR_EDIT_COPY.qualifier}`;
          setApplied({ handle: result.handle, recordId: result.recordId, sentence });
          store.pushStatus(StatusSeverity.Success, sentence);
        },
        (cause: unknown) => {
          if (generation.current !== mine) return;
          const error = toAppError(cause);
          replace({
            draft: current.draft,
            phase: ConnectorEditPhase.Idle,
            candidate: undefined,
            message: describeEditRefusal(error.details.code, error.message),
          });
        },
      );
  }, [client, current, handle, joint, key, replace, setApplied, setState, store]);

  const undo = useCallback((): void => {
    if (appliedHere === undefined || client === undefined || handle === undefined) return;
    setUndoing(true);
    client
      .undoRepair(handle, appliedHere.recordId, () => undefined)
      .promise.then(
        (result) => {
          setUndoing(false);
          setApplied(undefined);
          if (store.applyUndoResult(result)) {
            store.noteConnectorEditUndone();
            store.pushStatus(StatusSeverity.Info, CONNECTOR_EDIT_COPY.undone);
          }
        },
        (cause: unknown) => {
          setUndoing(false);
          const error = toAppError(cause);
          store.pushStatus(
            StatusSeverity.Error,
            `The change could not be undone: ${error.message}`,
          );
        },
      );
  }, [appliedHere, client, handle, setApplied, setUndoing, store]);

  // A candidate left in the worker when the editor goes away, or when its connectors move on, is released: nothing can apply it then.
  useEffect(() => {
    return (): void => {
      const held = live.current.candidate;
      if (held !== undefined) release(held.result.candidate);
    };
  }, [release]);

  return {
    joint,
    draft,
    changed,
    problem,
    phase: current.phase,
    kind: current.candidate?.kind,
    after: current.candidate?.result.after,
    message: current.message,
    undoable,
    appliedSentence: appliedHere?.sentence,
    undoing,
    setDraft,
    check,
    checkRemoval,
    cancelCheck,
    apply,
    discard,
    undo,
  };
}
