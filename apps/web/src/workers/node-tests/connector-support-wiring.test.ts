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
import { connectorSupportMargin } from '../../../../../packages/geometry-runtime/src/connector-policy';
import type * as AxialModule from '../../../../../packages/geometry-runtime/src/connector-axial';
import type * as SupportModule from '../../../../../packages/geometry-runtime/src/connector-support';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

type RealSupport = typeof SupportModule;
type RealAxial = typeof AxialModule;

/*
 * Release 2, Slice 2D — the WIRING between the engine and the support validator, observed from outside.
 *
 * Both validators are wrapped, not replaced: each records exactly what it is given and normally runs the real code. In a forced
 * mode the support validator returns a chosen verdict, so the engine's handling of every outcome and the automatic path's
 * diagnostic mapping can be driven without a kernel that fails.
 */
type Mode = 'real' | 'female' | 'male' | 'unavailable';
const hooks = vi.hoisted(
  (): {
    mode: Mode;
    support: unknown[];
    depth: { broadphase: unknown; sweeps: unknown; piece: unknown; tolerance: number }[];
  } => ({ mode: 'real', support: [], depth: [] }),
);
vi.mock('../../../../../packages/geometry-runtime/src/connector-axial', async (importOriginal) => {
  const real = await importOriginal<RealAxial>();
  return {
    ...real,
    validateSocketDepth: (
      ...args: Parameters<RealAxial['validateSocketDepth']>
    ): ReturnType<RealAxial['validateSocketDepth']> => {
      const [piece, sweeps, tolerance, , broadphase] = args;
      hooks.depth.push({ broadphase, sweeps, piece, tolerance });
      return real.validateSocketDepth(...args);
    },
  };
});
vi.mock(
  '../../../../../packages/geometry-runtime/src/connector-support',
  async (importOriginal) => {
    const real = await importOriginal<RealSupport>();
    return {
      ...real,
      validateConnectorSupport: (
        input: Parameters<RealSupport['validateConnectorSupport']>[0],
      ): ReturnType<RealSupport['validateConnectorSupport']> => {
        hooks.support.push(input);
        const stats = {
          femaleBuilds: 1,
          femaleQueries: 1,
          femaleCandidates: 0,
          femaleExactTests: 0,
          maleFacesExamined: 0,
          maleBoxCandidates: 0,
          maleExactTests: 0,
          maleCheckpoints: 0,
        };
        const first = input.sockets[0]?.pairId ?? 'pin-1';
        if (hooks.mode === 'female')
          return {
            ok: false,
            refusal: 'SOCKET_SUPPORT_INSUFFICIENT',
            policy: 'support-v1',
            margin: input.margin,
            checked: input.sockets.length,
            failures: [
              {
                role: 'FEMALE',
                pairId: first,
                faceIndex: 3,
                radius: 1,
                depth: 1,
                dimension: 'FAR_END',
              },
            ],
            stats,
          };
        if (hooks.mode === 'male')
          return {
            ok: false,
            refusal: 'PIN_ROOT_SUPPORT_INSUFFICIENT',
            policy: 'support-v1',
            margin: input.margin,
            checked: input.sockets.length,
            failures: [{ role: 'MALE', pairId: first, faceIndex: 5, radius: 1, depth: 1 }],
            stats,
          };
        if (hooks.mode === 'unavailable')
          return {
            ok: false,
            refusal: 'SUPPORT_VALIDATION_UNAVAILABLE',
            policy: 'support-v1',
            reason: 'PIECE_NOT_CLOSED',
            role: 'MALE',
            stats,
          };
        return real.validateConnectorSupport(input);
      },
    };
  },
);

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const Z: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };
function cube(size: number): CanonicalMesh {
  const h = size / 2,
    corners: number[] = [];
  for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) corners.push(i & (1 << k) ? h : -h);
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
interface Observed {
  readonly result?: SplitResult;
  readonly error?: unknown;
  readonly booleans: string[];
}
async function observe(
  mesh: CanonicalMesh,
  connector: SplitRequest['connector'],
): Promise<Observed> {
  const base = await createManifoldBooleanBackend(binary),
    booleans: string[] = [];
  hooks.support.length = 0;
  hooks.depth.length = 0;
  try {
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, token) => {
          booleans.push(kind);
          return base.operate(kind, a, b, token);
        },
      },
      mesh,
      { plane: Z, connector },
      new CancellationSource().token,
    );
    return { result, booleans };
  } catch (error) {
    return { error, booleans };
  }
}
const pin = (
  maleSide: 'A' | 'B',
  diameter = 4,
  count: 1 | 2 | 3 | 4 = 1,
): SplitRequest['connector'] => ({
  kind: 'pin',
  count,
  diameter,
  depth: 6,
  clearance: 0.2,
  maleSide,
});
const details = (error: unknown): Record<string, unknown> =>
  isAppError(error) ? error.details : {};

describe('the validator is handed exactly what the engine builds the connector from', () => {
  for (const side of ['A', 'B'] as const)
    it(`male ${side}: the pin radius from the request, the policy margin, the depth check's own sockets, its pieces and ONE shared tree`, async () => {
      hooks.mode = 'real';
      const observed = await observe(cube(40), pin(side, 4, 2));
      expect(observed.result?.connector.kind).toBe('pin');
      expect(hooks.support).toHaveLength(1);
      expect(hooks.depth).toHaveLength(1);
      const input = hooks.support[0] as Parameters<RealSupport['validateConnectorSupport']>[0],
        depth = hooks.depth[0],
        clip = observed.result?.closedPlaneClip;
      if (!depth || !clip) throw new Error('the validators were not reached');
      expect(input.pinRadius).toBe(2);
      expect(input.tolerance).toBe(observed.result.metrics.tolerance);
      expect(input.margin).toBe(connectorSupportMargin(2, input.tolerance));
      // the sockets are the very ones the depth check received (one source of the radius, depth and axis)
      expect(input.sockets).toBe(depth.sweeps);
      // ONE broadphase object serves both checks, and its tree was built once
      expect(input.femaleBroadphase).toBe(depth.broadphase);
      expect((input.femaleBroadphase as { builds: number }).builds).toBe(1);
      // the female piece is the one the depth check examined; the male piece is the other kernel piece
      expect(input.female).toBe(depth.piece);
      expect(input.female.mesh).toBe(side === 'A' ? clip.pieceB : clip.pieceA);
      expect(input.male.mesh).toBe(side === 'A' ? clip.pieceA : clip.pieceB);
      expect(input.male.provenance).toBe(side === 'A' ? clip.provenanceA : clip.provenanceB);
      // the socket volume is the one cut: radius pin + clearance, depth as requested
      for (const socket of input.sockets) {
        expect(socket.radius).toBe(2.2);
        expect(socket.depth).toBe(6);
      }
    });
  it("the AUTOMATIC path calls the same validator, with the automatic proposal's own pin radius", async () => {
    hooks.mode = 'real';
    const observed = await observe(cube(30), { kind: 'automatic', unit: 'millimeter' });
    expect(observed.result?.automaticConnector).toBe('applied');
    expect(hooks.support).toHaveLength(1);
    const input = hooks.support[0] as Parameters<RealSupport['validateConnectorSupport']>[0],
      connector = observed.result?.connector;
    if (connector?.kind !== 'pin') throw new Error('no pin');
    expect(input.pinRadius).toBe(connector.diameter / 2);
    expect(input.margin).toBe(connectorSupportMargin(connector.diameter / 2, input.tolerance));
    expect(input.sockets).toBe(hooks.depth[0]?.sweeps);
  });
});

describe('every verdict is handled as one, with nothing built', () => {
  it('a female refusal is a typed manual error with the policy, the margin, the dimension and no Boolean', async () => {
    hooks.mode = 'female';
    try {
      const { error, booleans } = await observe(cube(40), pin('A'));
      expect(details(error).code).toBe('CONNECTOR_SOCKET_SUPPORT_INSUFFICIENT');
      expect(details(error).refusal).toBe('SOCKET_SUPPORT_INSUFFICIENT');
      expect(details(error).policy).toBe('support-v1');
      expect(details(error).dimension).toBe('FAR_END');
      expect(details(error).role).toBe('FEMALE');
      expect(details(error).femaleFailures).toBe(1);
      expect(details(error).maleFailures).toBe(0);
      expect(details(error).pinRadius).toBe(2);
      expect(details(error).socketRadius).toBe(2.2);
      expect(details(error).margin).toBeCloseTo(0.7, 12);
      expect(booleans).toEqual([]);
    } finally {
      hooks.mode = 'real';
    }
  });
  it('a male refusal is its own typed error', async () => {
    hooks.mode = 'male';
    try {
      const { error, booleans } = await observe(cube(40), pin('B'));
      expect(details(error).code).toBe('CONNECTOR_PIN_ROOT_SUPPORT_INSUFFICIENT');
      expect(details(error).role).toBe('MALE');
      expect(details(error).maleFailures).toBe(1);
      expect(booleans).toEqual([]);
    } finally {
      hooks.mode = 'real';
    }
  });
  it('"could not be examined" fails closed with its reason and the piece it concerns', async () => {
    hooks.mode = 'unavailable';
    try {
      const { error, booleans } = await observe(cube(40), pin('A'));
      expect(details(error).code).toBe('CONNECTOR_SUPPORT_VALIDATION_UNAVAILABLE');
      expect(details(error).reason).toBe('PIECE_NOT_CLOSED');
      expect(details(error).role).toBe('MALE');
      expect(booleans).toEqual([]);
    } finally {
      hooks.mode = 'real';
    }
  });
  it('the automatic path maps each verdict to its own diagnostic, never to a connector, a retry or another site', async () => {
    for (const [mode, reason] of [
      ['female', 'SOCKET_SUPPORT_INSUFFICIENT'],
      ['male', 'PIN_ROOT_SUPPORT_INSUFFICIENT'],
      ['unavailable', 'SUPPORT_VALIDATION_UNAVAILABLE'],
    ] as const) {
      hooks.mode = mode;
      try {
        const { result, booleans } = await observe(cube(30), {
          kind: 'automatic',
          unit: 'millimeter',
        });
        expect(result?.automaticConnector).toBe('unavailable');
        expect(result?.automaticConnectorDiagnostics?.reason).toBe(reason);
        expect(result?.connector).toEqual({ kind: 'none' });
        expect(booleans).toEqual([]);
        // exactly one attempt: the plan was refused whole, not retried
        expect(hooks.support).toHaveLength(1);
      } finally {
        hooks.mode = 'real';
      }
    }
  });
});
