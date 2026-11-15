import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { CancellationSource, isAppError } from '@cadfixer/shared';
import {
  splitWithConnectors,
  type SplitPlane,
  type SplitRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { ConnectorRefusal } from '../../../../../packages/geometry-runtime/src/connector-plan';
import type * as import_axial from '../../../../../packages/geometry-runtime/src/connector-axial';
import type {
  AxialValidation,
  ReceivingPiece,
  SocketSweep,
} from '../../../../../packages/geometry-runtime/src/connector-axial';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

type RealAxial = typeof import_axial;

/*
 * Release 2, Slice 2C — the WIRING between the engine and the validator, observed from outside.
 *
 * The validator is wrapped, not replaced: it records exactly what it is given (the receiving piece, the sockets, the tolerance,
 * the cancellation token) and normally runs the real code. In `forced` mode it returns a chosen verdict, so the engine's handling of
 * "unavailable" and the automatic path's diagnostic mapping can be driven without needing a kernel that fails.
 */
interface Call {
  readonly piece: ReceivingPiece;
  readonly sweeps: readonly SocketSweep[];
  readonly tolerance: number;
  readonly token: unknown;
}
const hooks = vi.hoisted((): { mode: 'real' | 'unavailable' | 'breach'; calls: Call[] } => ({
  mode: 'real',
  calls: [],
}));
vi.mock('../../../../../packages/geometry-runtime/src/connector-axial', async (importOriginal) => {
  const real = await importOriginal<RealAxial>();
  return {
    ...real,
    validateSocketDepth: (
      piece: ReceivingPiece,
      sweeps: readonly SocketSweep[],
      tolerance: number,
      token: Parameters<typeof real.validateSocketDepth>[3],
    ): AxialValidation => {
      hooks.calls.push({ piece, sweeps, tolerance, token });
      const stats = { builds: 1, queries: 1, candidates: 0, exactTests: 0 };
      if (hooks.mode === 'unavailable')
        return {
          ok: false,
          refusal: 'AXIAL_VALIDATION_UNAVAILABLE',
          reason: 'PIECE_NOT_CLOSED',
          stats,
        };
      if (hooks.mode === 'breach')
        return {
          ok: false,
          refusal: 'SOCKET_BREAKTHROUGH',
          checked: sweeps.length,
          failures: [
            {
              pairId: sweeps[0]?.pairId ?? 'pin-1',
              faceIndex: 3,
              radius: sweeps[0]?.radius ?? 0,
              depth: sweeps[0]?.depth ?? 0,
            },
          ],
          stats,
        };
      return real.validateSocketDepth(piece, sweeps, tolerance, token);
    },
  };
});

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const UP: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };

function boxAt(
  sx: number,
  sy: number,
  sz: number,
  cx: number,
  cy: number,
  cz: number,
): CanonicalMesh {
  const corners: number[] = [],
    half = [sx / 2, sy / 2, sz / 2],
    centre = [cx, cy, cz];
  for (let i = 0; i < 8; i++)
    for (let k = 0; k < 3; k++)
      corners.push((centre[k] ?? 0) + (i & (1 << k) ? 1 : -1) * (half[k] ?? 0));
  const faces = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(corners.length),
    indices = createIndexArray(faces.length);
  positions.set(corners);
  indices.set(faces);
  return { positions, indices, metadata: {} };
}
/** 40 x 40, z -3..6: piece A (above) is 6 thick and piece B (below) is 3 thick, so the two sides cannot be confused. */
const asymmetric = (): CanonicalMesh => boxAt(40, 40, 9, 0, 0, 1.5);

interface Observed {
  readonly result?: SplitResult;
  readonly error?: unknown;
  readonly booleans: string[];
  readonly sockets: CanonicalMesh[];
}
async function observe(
  mesh: CanonicalMesh,
  connector: SplitRequest['connector'],
): Promise<Observed> {
  const base = await createManifoldBooleanBackend(binary),
    booleans: string[] = [],
    sockets: CanonicalMesh[] = [];
  try {
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, token) => {
          booleans.push(kind);
          if (kind === 'difference') sockets.push(b);
          return base.operate(kind, a, b, token);
        },
      },
      mesh,
      { plane: UP, connector },
      new CancellationSource().token,
    );
    return { result, booleans, sockets };
  } catch (error) {
    return { error, booleans, sockets };
  }
}
const pin = (depth: number, maleSide: 'A' | 'B'): SplitRequest['connector'] => ({
  kind: 'pin',
  count: 1,
  diameter: 4,
  depth,
  clearance: 0.2,
  maleSide,
});
const zRange = (mesh: CanonicalMesh): [number, number] => {
  let low = Infinity,
    high = -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) {
    low = Math.min(low, mesh.positions[i] ?? 0);
    high = Math.max(high, mesh.positions[i] ?? 0);
  }
  return [low, high];
};
const details = (error: unknown): Record<string, unknown> =>
  isAppError(error) ? error.details : {};

describe('the validator is handed exactly what the engine builds the socket from', () => {
  it('male A: the lower piece, axis down, the primitive radius and depth, the kernel tolerance and the caller token', async () => {
    hooks.mode = 'real';
    hooks.calls.length = 0;
    const token = new CancellationSource().token,
      base = await createManifoldBooleanBackend(binary),
      sockets: CanonicalMesh[] = [],
      result = await splitWithConnectors(
        {
          operate: (kind, a, b, t) => {
            if (kind === 'difference') sockets.push(b);
            return base.operate(kind, a, b, t);
          },
        },
        asymmetric(),
        { plane: UP, connector: pin(2, 'A') },
        token,
      );
    expect(result.connector.kind).toBe('pin');
    const [call] = hooks.calls,
      [socket] = sockets,
      [sweep] = call?.sweeps ?? [];
    if (!call || !sweep || !socket) throw new Error('the validator or the socket was not reached');
    expect(hooks.calls).toHaveLength(1);
    // the receiving piece is B: 3 thick, z in [-3, 0]; its closedness is the kernel's verdict; its provenance covers its faces
    const [low, high] = zRange(call.piece.mesh);
    expect(low).toBeCloseTo(-3, 6);
    expect(high).toBeCloseTo(0, 6);
    expect(call.piece.closed).toBe(true);
    expect(call.piece.provenance.length).toBe(call.piece.mesh.indices.length / 3);
    expect(call.piece.mesh).toBe(result.closedPlaneClip?.pieceB);
    expect(call.piece.provenance).toBe(result.closedPlaneClip?.provenanceB);
    // the tolerance and the token are the engine's own
    expect(call.tolerance).toBe(result.metrics.tolerance);
    expect(call.token).toBe(token);
    // the socket described to the validator is the socket that was cut
    expect(sweep.axis.map((v) => v + 0)).toEqual([0, 0, -1]);
    expect(sweep.depth).toBe(2);
    expect(sweep.radius).toBe(4 / 2 + 0.2);
    let radius = 0,
      deepest = Infinity;
    for (let i = 0; i < socket.positions.length; i += 3) {
      radius = Math.max(radius, Math.hypot(socket.positions[i] ?? 0, socket.positions[i + 1] ?? 0));
      deepest = Math.min(deepest, socket.positions[i + 2] ?? 0);
    }
    expect(radius).toBeCloseTo(sweep.radius, 6);
    expect(deepest).toBeCloseTo(-sweep.depth, 6);
    expect(sweep.center).toEqual(result.placements[0]);
  });
  it('male B: the upper piece, axis up', async () => {
    hooks.mode = 'real';
    hooks.calls.length = 0;
    const observed = await observe(asymmetric(), pin(2, 'B')),
      [call] = hooks.calls,
      [sweep] = call?.sweeps ?? [];
    if (!call || !sweep) throw new Error('the validator was not reached');
    const [low, high] = zRange(call.piece.mesh);
    expect(low).toBeCloseTo(0, 6);
    expect(high).toBeCloseTo(6, 6);
    expect(call.piece.mesh).toBe(observed.result?.closedPlaneClip?.pieceA);
    expect(call.piece.provenance).toBe(observed.result?.closedPlaneClip?.provenanceA);
    expect(sweep.axis.map((v) => v + 0)).toEqual([0, 0, 1]);
  });
});

describe('a verdict that is not a pass is handled as one', () => {
  it('maps "unavailable" to a typed manual refusal with its reason and no Boolean', async () => {
    hooks.mode = 'unavailable';
    try {
      const { error, booleans } = await observe(asymmetric(), pin(2, 'A'));
      expect(details(error).code).toBe('CONNECTOR_AXIAL_VALIDATION_UNAVAILABLE');
      expect(details(error).refusal).toBe(ConnectorRefusal.AXIAL_VALIDATION_UNAVAILABLE);
      expect(details(error).reason).toBe('PIECE_NOT_CLOSED');
      expect(details(error).socketDepth).toBe(2);
      expect(booleans).toEqual([]);
    } finally {
      hooks.mode = 'real';
    }
  });
  it('maps the automatic path to an unavailable connector with the matching diagnostic, never a connector', async () => {
    const thick = boxAt(40, 40, 30, 0, 0, 0);
    for (const [mode, reason] of [
      ['unavailable', 'AXIAL_VALIDATION_UNAVAILABLE'],
      ['breach', 'SOCKET_BREAKTHROUGH'],
    ] as const) {
      hooks.mode = mode;
      try {
        const { result, booleans } = await observe(thick, {
          kind: 'automatic',
          unit: 'millimeter',
        });
        expect(result?.automaticConnector).toBe('unavailable');
        expect(result?.automaticConnectorDiagnostics?.reason).toBe(reason);
        expect(result?.connector).toEqual({ kind: 'none' });
        expect(booleans).toEqual([]);
      } finally {
        hooks.mode = 'real';
      }
    }
  });
});
