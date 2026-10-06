import type {
  HoleFillStatus,
  HoleFillValidationSummary,
  HoleFillLimits,
} from '@cadfixer/geometry-runtime';

/**
 * THE HOLE-FILL CHANNEL PROTOCOL.
 *
 * Three participants and one bidirectional hop, and the shape exists to keep
 * the page out of the middle:
 *
 *   controller            --('port')-->        authoritative worker
 *   controller            --('port')-->        fill worker
 *   authoritative worker  ==(copy)==>          fill worker
 *   fill worker           ==(candidate)==>     authoritative worker
 *
 * THE CHANNEL CARRIES GEOMETRY IN BOTH DIRECTIONS AND THE PAGE SEES NEITHER.
 * The source copy goes out, the validated candidate comes back, and the
 * authoritative worker takes ownership of it. What reaches the main thread is a
 * candidate HANDLE and a summary of scalars — the same rule ADR 0008 states for
 * every other operation, applied to a result rather than only to an input.
 *
 * THIS DIFFERS FROM `model/send-for-diagnostic` IN ONE WAY. That operation
 * resolves as soon as the copy is posted, because a diagnostic produces only
 * numbers and the page can receive them from the diagnostic worker directly.
 * This one stays pending until the candidate arrives, because a candidate is
 * geometry and geometry has to be handed to an owner.
 */

/** Sent by the controller to either worker: here is your end of the channel. */
export interface HoleFillPortMessage {
  readonly kind: 'port';
  readonly port: MessagePort;
}

/**
 * Sent by the AUTHORITATIVE worker over the channel, carrying a DISPOSABLE copy.
 *
 * POSITIONS ARE CANONICAL Float32, not widened doubles, and that is
 * deliberate: the fill engine judges its candidate on the representation that
 * would become authoritative, and its byte-level source-preservation check
 * compares against these exact bytes. Widening here would mean validating
 * something the model never is.
 *
 * The buffers are transferred, which is safe precisely because they are a COPY.
 * The authoritative worker's own arrays are never detached.
 */
export interface HoleFillGeometryMessage {
  readonly kind: 'fill';
  readonly operationId: string;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly partId: string;
  readonly boundaryLoopId: string;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly limits: Partial<HoleFillLimits> | undefined;
}

/**
 * Sent by the FILL worker back over the channel.
 *
 * `positions` and `indices` are present ONLY for a valid candidate. Every other
 * status carries scalars alone, because every other status means no candidate
 * exists — a refusal is non-destructive, and a refusal that shipped geometry
 * would be inviting someone to use it.
 */
export type HoleFillWorkerReply =
  | {
      readonly kind: 'result';
      readonly operationId: string;
      readonly status: HoleFillStatus;
      readonly summary: HoleFillValidationSummary;
      readonly intersectionSamples: Uint32Array;
      readonly samplesTruncated: boolean;
      readonly positions?: Float32Array;
      readonly indices?: Uint32Array;
    }
  | {
      readonly kind: 'failed';
      readonly operationId: string;
      readonly reason: string;
    };

/** Fill worker to CONTROLLER. Lifecycle only; never a result, never geometry. */
export type HoleFillWorkerOutbound =
  | { readonly kind: 'ready' }
  | { readonly kind: 'started'; readonly operationId: string; readonly faceCount: number };

/* ------------------------------------------ REPAIR-CORE-02: local check -- */

/**
 * Sent by the AUTHORITATIVE worker: the LOCAL region of every admitted patch.
 *
 * NOT THE PART. Only the existing triangles whose boxes can reach a patch, their
 * distinct points welded by exact coordinates and widened to Float64, and the
 * patches appended after them. Everything else about the model stays in the
 * authoritative worker. The buffers are freshly built for this message, so
 * transferring them detaches nothing authoritative.
 */
export interface LocalVerifyMessage {
  readonly kind: 'verify-local';
  readonly operationId: string;
  readonly positions: Float64Array;
  readonly triangles: Uint32Array;
  readonly sourceFaceCount: number;
  readonly loopRanges: Uint32Array;
}

/** One verdict per loop range, in the order the ranges were sent. */
export interface LocalVerdictWire {
  readonly complete: boolean;
  readonly budgetExceeded: boolean;
  readonly testedPairs: number;
  readonly invalidPatchSourcePairs: number;
  readonly invalidPatchPatchPairs: number;
}

export type LocalVerifyReply =
  | {
      readonly kind: 'verified';
      readonly operationId: string;
      readonly verdicts: readonly LocalVerdictWire[];
    }
  | { readonly kind: 'failed'; readonly operationId: string; readonly reason: string };

/* ----------------------------------------- REPAIR-CORE-06A: local repair -- */

/**
 * Sent by the AUTHORITATIVE worker: a DISPOSABLE COPY of the mesh the local repair is to work on.
 *
 * The same arrangement as `HoleFillGeometryMessage` and for the same reasons: positions are
 * canonical Float32 so the engine judges the representation that would become authoritative, the
 * buffers are a copy so transferring them detaches nothing, and the kernel lives only here, where
 * termination is the cancel. The limits are the product's deterministic work ceilings (a caller
 * may only narrow them for a test).
 */
export interface LocalRepairMessage {
  readonly kind: 'local-repair';
  readonly operationId: string;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly limits: {
    readonly primary: number | undefined;
    readonly residual: number | undefined;
  };
}

/** Bounded progress, so a long repair is visibly alive. Scalars only. */
export interface LocalRepairProgressWire {
  readonly kind: 'local-repair-progress';
  readonly operationId: string;
  readonly phase: 'topology' | 'primary' | 'residual';
  readonly attempted: number;
  readonly total: number;
  readonly repaired: number;
  readonly primaryWorkUnits: number;
  readonly residualWorkUnits: number;
}

/**
 * The engine's answer: scalars and bounded tables, plus the PATCH — what changed, in the source
 * mesh's own slot space. Not a mesh: the authoritative worker builds the candidate with the same
 * rebuild every repair uses, and validates it itself. `patch` is absent when nothing changed.
 */
export interface LocalRepairResultWire {
  readonly kind: 'local-repair-result';
  readonly operationId: string;
  readonly outcome: {
    readonly kind: string;
    readonly cancelled: boolean;
    readonly counts: {
      readonly eligible: number;
      readonly unsupportedNonManifoldEdge: number;
      readonly repaired: number;
      readonly remaining: number;
      readonly unattempted: number;
      readonly remainingByReason: Readonly<Record<string, number>>;
    };
    readonly limitReached: 'primary' | 'residual' | undefined;
    readonly work: {
      readonly primary: { readonly used: number; readonly limit: number | undefined };
      readonly residual: { readonly used: number; readonly limit: number | undefined };
    };
    readonly residual: {
      readonly ran: boolean;
      readonly skippedBecause: 'nothing-refused' | 'primary-limit' | 'cancelled' | undefined;
      readonly linkRetriangulations: number;
      readonly primaryAfterResidual: number;
      readonly windingComponentsResolved: number;
      readonly windingFacesReversed: number;
    };
  };
  readonly patch?: {
    readonly removedSourceFaces: Uint32Array;
    readonly flippedSourceFaces: Uint32Array;
    readonly appendedPositions: Float32Array;
    readonly appendedFaces: Uint32Array;
  };
}

export type LocalRepairReply =
  | LocalRepairProgressWire
  | LocalRepairResultWire
  | { readonly kind: 'failed'; readonly operationId: string; readonly reason: string };
