import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyPlacement,
  createIndexArray,
  createPositionArray,
  type CanonicalMesh,
  type PlacementClass,
} from '@cadfixer/mesh-core';
import { CancellationSource, isAppError } from '@cadfixer/shared';
import {
  splitWithConnectors,
  type SplitPlane,
  type SplitRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { splitTolerance } from '../../../../../packages/geometry-runtime/src/split-connectors';
import { connectorSupportMargin } from '../../../../../packages/geometry-runtime/src/connector-policy';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/*
 * Release 2, Stage C03-C — THE PHYSICAL SIZE OF A CONNECTOR, MEASURED FROM THE TRIANGLES IT PRODUCED.
 *
 * This is the independent reference. It shares no code with the resolver, the planner or the engine: it reads the two pieces the real
 * kernel returned, finds the pin and the socket in them by geometry alone, and turns the local lengths it measures into millimetres
 * with a unit table WRITTEN OUT HERE and the placement scale it chose for the scenario. If the resolver were wrong in the same way
 * as the test's expectation, this would still fail, because what is compared is the produced mesh, not a number the resolver returned.
 *
 * The scenarios are one physical part re-expressed: a 40 mm cube (30 mm for automatic) written in each of the six supported units
 * and placed at each of five uniform scales, its coordinates divided by the unit factor and the scale so the PART is the same size
 * on the build plate every time. The requested pin is always Ø4 mm, 6 mm deep, 0.2 mm radial clearance.
 */
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const MM_PER_UNIT: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  meter: 1000,
  inch: 25.4,
  foot: 304.8,
};
const UNITS = Object.keys(MM_PER_UNIT);
const SCALES = [0.25, 0.5, 1, 2, 4];
const Z: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };

function boxAt(sx: number, sy: number, sz: number, cx = 0, cy = 0, cz = 0): CanonicalMesh {
  const h = [sx / 2, sy / 2, sz / 2],
    centre = [cx, cy, cz],
    corners: number[] = [];
  for (let i = 0; i < 8; i++)
    for (let k = 0; k < 3; k++)
      corners.push((centre[k] ?? 0) + (i & (1 << k) ? 1 : -1) * (h[k] ?? 0));
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
const cube = (size: number): CanonicalMesh => boxAt(size, size, size);
function scaled(mesh: CanonicalMesh, k: number): CanonicalMesh {
  const positions = createPositionArray(mesh.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = (mesh.positions[i] ?? 0) * k;
  return { positions, indices: mesh.indices, metadata: mesh.metadata };
}
async function boolean(
  kind: 'union' | 'difference',
  a: CanonicalMesh,
  b: CanonicalMesh,
): Promise<CanonicalMesh> {
  const backend = await createManifoldBooleanBackend(binary);
  return backend.operate(kind, a, b, new CancellationSource().token);
}
const placementAt = (scale: number, mirror = false): PlacementClass =>
  classifyPlacement(
    mirror
      ? [-scale, 0, 0, 0, scale, 0, 0, 0, scale, 5, 6, 7]
      : [scale, 0, 0, 0, scale, 0, 0, 0, scale, 5, 6, 7],
  );
/** The coordinate factor that keeps a part the same physical size: millimetres over (mm per unit × placement scale). */
const coordinateFactor = (unit: string, scale: number): number =>
  1 / ((MM_PER_UNIT[unit] ?? Number.NaN) * scale);
const physicalPin = (unit: string): SplitRequest['connector'] => ({
  kind: 'physical-pin',
  unit,
  count: 1,
  diameterMm: 4,
  depthMm: 6,
  clearanceMm: 0.2,
  maleSide: 'A',
});

interface Outcome {
  readonly result?: SplitResult;
  readonly error?: unknown;
}
async function split(
  mesh: CanonicalMesh,
  connector: SplitRequest['connector'],
  placement: PlacementClass,
  plane: SplitPlane = Z,
): Promise<Outcome> {
  const backend = await createManifoldBooleanBackend(binary);
  try {
    return {
      result: await splitWithConnectors(
        backend,
        mesh,
        { plane, connector },
        new CancellationSource().token,
        undefined,
        placement,
      ),
    };
  } catch (error) {
    return { error };
  }
}
const codeOf = (outcome: Outcome): string =>
  outcome.result !== undefined
    ? outcome.result.connector.kind === 'none'
      ? `plain:${outcome.result.automaticConnector ?? ''}`
      : 'pin'
    : isAppError(outcome.error)
      ? String((outcome.error.details as { code?: unknown }).code)
      : 'ERROR';

interface Measured {
  readonly pinDiameterMm: number;
  readonly pinDepthMm: number;
  readonly socketMouthDiameterMm: number;
  readonly socketDepthMm: number;
  readonly clearanceMm: number;
  readonly pinVertices: number;
  readonly socketVertices: number;
}
/**
 * The pin and the socket, read from the produced pieces for a plane with normal +Z through the part's local origin. The pin points
 * the way the engine documents (A is male: toward -normal). Millimetres per local coordinate is `phys`, chosen by the caller.
 */
function measure(result: SplitResult, phys: number): Measured {
  const clip = result.closedPlaneClip;
  if (clip === undefined) throw new Error('no clip');
  const anchor = clip.outputAnchor;
  const site0 = result.placements[0];
  if (site0 === undefined) throw new Error('no site');
  const site = [site0[0] - anchor[0], site0[1] - anchor[1], site0[2] - anchor[2]] as const;
  const origin = [-anchor[0], -anchor[1], -anchor[2]] as const;
  const axis = [0, 0, -1] as const; // maleSide A: the pin points toward -normal
  let window = Infinity;
  for (let i = 1; i < result.placements.length; i++) {
    const other = result.placements[i];
    if (other !== undefined)
      window = Math.min(
        window,
        Math.hypot(other[0] - site0[0], other[1] - site0[1], other[2] - site0[2]) / 2,
      );
  }
  const extent = (mesh: CanonicalMesh): number => {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      lo = Math.min(lo, mesh.positions[i] ?? 0);
      hi = Math.max(hi, mesh.positions[i] ?? 0);
    }
    return hi - lo;
  };
  window = Math.min(window, 0.2 * extent(result.pieceA));
  const eps = 1e-6 * extent(result.pieceA);
  const probe = (
    mesh: CanonicalMesh,
    beyond: boolean,
  ): { rad: number; depth: number; n: number } => {
    let rad = 0,
      depth = 0,
      n = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0,
        y = mesh.positions[i + 1] ?? 0,
        z = mesh.positions[i + 2] ?? 0;
      const t = (z - origin[2]) * axis[2];
      const radial = Math.hypot(x - site[0], y - site[1]);
      if (radial > window) continue;
      if (beyond ? t <= eps : t < -eps) continue;
      rad = Math.max(rad, radial);
      depth = Math.max(depth, t);
      n++;
    }
    return { rad, depth, n };
  };
  const pin = probe(result.pieceA, true),
    socket = probe(result.pieceB, false);
  return {
    pinDiameterMm: 2 * pin.rad * phys,
    pinDepthMm: pin.depth * phys,
    socketMouthDiameterMm: 2 * socket.rad * phys,
    socketDepthMm: socket.depth * phys,
    clearanceMm: (socket.rad - pin.rad) * phys,
    pinVertices: pin.n,
    socketVertices: socket.n,
  };
}
const near = (actual: number, expected: number, relativeTolerance = 2e-5): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(relativeTolerance * Math.abs(expected));
};
/** The result of an outcome that must have succeeded. */
function resultOf(outcome: Outcome): SplitResult {
  if (outcome.result === undefined) throw new Error('the split was refused');
  return outcome.result;
}

describe('MANUAL physical pin: Ø4 / 6 / 0.2 mm is Ø4 / 6 / 0.2 mm in every unit at every placement scale', () => {
  for (const unit of UNITS)
    for (const scale of SCALES)
      it(`${unit}, placed at ×${String(scale)}`, async () => {
        const mesh = scaled(cube(40), coordinateFactor(unit, scale));
        const outcome = await split(mesh, physicalPin(unit), placementAt(scale));
        expect(codeOf(outcome)).toBe('pin');
        const phys = (MM_PER_UNIT[unit] ?? Number.NaN) * scale;
        const m = measure(resultOf(outcome), phys);
        expect(m.pinVertices).toBeGreaterThan(8);
        expect(m.socketVertices).toBeGreaterThan(8);
        near(m.pinDiameterMm, 4);
        near(m.pinDepthMm, 6);
        near(m.socketMouthDiameterMm, 4.4);
        near(m.socketDepthMm, 6);
        near(m.clearanceMm, 0.2, 1e-3);
      });
  it('with the coordinates NOT compensated, a placement scale changes the part but never the pin: Ø4 on a 120-unit cube at ×0.25, ×2 and ×4', async () => {
    for (const unit of ['millimeter', 'inch'])
      for (const scale of [0.25, 2, 4]) {
        const mesh = scaled(cube(120), 1 / (MM_PER_UNIT[unit] ?? Number.NaN));
        const outcome = await split(mesh, physicalPin(unit), placementAt(scale));
        expect(codeOf(outcome), `${unit} ×${String(scale)}`).toBe('pin');
        const m = measure(resultOf(outcome), (MM_PER_UNIT[unit] ?? Number.NaN) * scale);
        near(m.pinDiameterMm, 4);
        near(m.socketMouthDiameterMm, 4.4);
        near(m.pinDepthMm, 6);
      }
  });
  it('a reflection changes no length: mirrored placements give the same physical pin, mouth, depth and clearance', async () => {
    for (const unit of ['millimeter', 'inch', 'meter', 'micron'])
      for (const scale of [0.5, 2]) {
        const mesh = scaled(cube(40), coordinateFactor(unit, scale));
        const plain = await split(mesh, physicalPin(unit), placementAt(scale));
        const mirrored = await split(mesh, physicalPin(unit), placementAt(scale, true));
        expect(codeOf(mirrored)).toBe('pin');
        expect(codeOf(plain)).toBe('pin');
        // identical output, not merely equal measurements: the engine works in local coordinates, where there is no reflection
        const a = resultOf(plain),
          b = resultOf(mirrored);
        expect(
          Buffer.from(b.pieceA.positions.buffer).equals(Buffer.from(a.pieceA.positions.buffer)),
        ).toBe(true);
        expect(
          Buffer.from(b.pieceB.positions.buffer).equals(Buffer.from(a.pieceB.positions.buffer)),
        ).toBe(true);
      }
  });
});

describe('AUTOMATIC connector: the same physical part gets the same physical connector in every unit at every placement scale', () => {
  // the automatic policy on a 30 mm cube: Ø min(6, 0.12 × 30) = 3.6 mm, depth min(6, 1.5 × 3.6) = 5.4 mm, clearance 0.2 mm
  for (const unit of UNITS)
    for (const scale of SCALES)
      it(`${unit}, placed at ×${String(scale)}`, async () => {
        const mesh = scaled(cube(30), coordinateFactor(unit, scale));
        const outcome = await split(mesh, { kind: 'automatic', unit }, placementAt(scale));
        expect(outcome.result?.automaticConnector, codeOf(outcome)).toBe('applied');
        const m = measure(resultOf(outcome), (MM_PER_UNIT[unit] ?? Number.NaN) * scale);
        near(m.pinDiameterMm, 3.6);
        near(m.pinDepthMm, 5.4);
        near(m.socketMouthDiameterMm, 4.0);
        near(m.clearanceMm, 0.2, 1e-3);
      });
});

describe('every SAFETY verdict is the same physical verdict in every unit (Slices 2B, 2C and 2D, and the split tolerance)', () => {
  const FIXTURES: readonly [string, () => Promise<CanonicalMesh>, string][] = [
    ['a clear block', (): Promise<CanonicalMesh> => Promise.resolve(boxAt(40, 40, 60)), 'pin'],
    // 2D: a flank notch leaving 0.05 / 0.3 mm of wall beside the socket (margin max(8·tol, 0.35·2) = 0.7 mm), and 2.2 mm of it
    [
      'a 0.05 mm wall beside the socket',
      (): Promise<CanonicalMesh> =>
        boolean('difference', boxAt(40, 40, 60), boxAt(30, 60, 28, 2.2 + 0.05 + 15, 0, -17)),
      'CONNECTOR_SOCKET_SUPPORT_INSUFFICIENT',
    ],
    [
      'a 0.3 mm wall beside the socket',
      (): Promise<CanonicalMesh> =>
        boolean('difference', boxAt(40, 40, 60), boxAt(30, 60, 28, 2.2 + 0.3 + 15, 0, -17)),
      'CONNECTOR_SOCKET_SUPPORT_INSUFFICIENT',
    ],
    [
      'a 2.2 mm wall beside the socket',
      (): Promise<CanonicalMesh> =>
        boolean('difference', boxAt(40, 40, 60), boxAt(30, 60, 28, 2.2 + 2.2 + 15, 0, -17)),
      'pin',
    ],
    // 2C: the receiving piece is 4 mm thick behind the cut for a 6 mm socket, and 16 mm
    [
      'a receiving piece 4 mm deep',
      (): Promise<CanonicalMesh> => Promise.resolve(boxAt(40, 40, 34, 0, 0, 13)),
      'CONNECTOR_SOCKET_BREAKTHROUGH',
    ],
    [
      'a receiving piece 16 mm deep',
      (): Promise<CanonicalMesh> => Promise.resolve(boxAt(40, 40, 46, 0, 0, 7)),
      'pin',
    ],
    // 2B / the edge margin: a 5 mm cube cannot take a Ø4 pin with its edge margin
    [
      'a 5 mm cube',
      (): Promise<CanonicalMesh> => Promise.resolve(boxAt(5, 5, 5)),
      'CONNECTOR_TOO_CLOSE_TO_EDGE',
    ],
  ];
  for (const [name, make, expected] of FIXTURES)
    it(`${name}: ${expected}`, async () => {
      const base = await make();
      for (const unit of UNITS)
        for (const scale of [0.5, 1, 2]) {
          const outcome = await split(
            scaled(base, coordinateFactor(unit, scale)),
            physicalPin(unit),
            placementAt(scale),
          );
          expect(codeOf(outcome), `${unit} ×${String(scale)}`).toBe(expected);
        }
    });
  it('the split tolerance means the same PHYSICAL length in every unit, and the support margin binds on the same branch', () => {
    const base = boxAt(40, 40, 60);
    const physical: number[] = [];
    for (const unit of UNITS)
      for (const scale of [0.25, 1, 4]) {
        const mesh = scaled(base, coordinateFactor(unit, scale));
        const phys = (MM_PER_UNIT[unit] ?? Number.NaN) * scale;
        const tolerance = splitTolerance(mesh);
        physical.push(tolerance * phys);
        // the physical radius of a 4 mm pin, and the margin the validator uses for it, expressed back in millimetres
        const radiusLocal = 2 / phys;
        const margin = connectorSupportMargin(radiusLocal, tolerance);
        near(margin * phys, Math.max(8 * tolerance * phys, 0.35 * 2), 1e-12);
        // 8·tol is 8 × 1e-6 × the part's diagonal (~84 mm): about 7e-4 mm, so the pin term (0.7 mm) is the one that binds
        expect(8 * tolerance * phys).toBeLessThan(0.35 * 2);
      }
    for (const value of physical) near(value, physical[0] ?? Number.NaN, 1e-5);
  });
});
