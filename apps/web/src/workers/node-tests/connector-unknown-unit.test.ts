import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyPlacement,
  createIndexArray,
  createPositionArray,
  IDENTITY_PLACEMENT,
  type CanonicalMesh,
  type PlacementClass,
} from '@cadfixer/mesh-core';
import { CancellationSource, isAppError } from '@cadfixer/shared';
import {
  assertProductConnectorRequest,
  splitWithConnectors,
  withStatedUnit,
  type ProductConnectorRequest,
  type SplitPlane,
  type SplitRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { describeUnknownUnitRefusal } from '../../../../../packages/geometry-runtime/src/connector-unit-refusal';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/*
 * Release 2, Stage C03-C2 — A MODEL WITH NO UNIT HAS NO PHYSICAL CONNECTOR, AND SAYS SO.
 *
 * Phase 0 policy U1 + U2: the engine refuses (typed, one sentence, before anything is built) and never assumes millimetres, never
 * reads the millimetre number as the model's own coordinates, and never files the refusal as a finding about the cut. Every test here
 * drives the real engine on the real Manifold backend and counts the Booleans it was asked for.
 */
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const Z: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };
const SENTENCE =
  'This model has no physical units. Set the model units before adding a physical connector.';

function cube(size: number): CanonicalMesh {
  const h = size / 2,
    corners: number[] = [];
  for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) corners.push((i & (1 << k) ? 1 : -1) * h);
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
const openCube = (): CanonicalMesh => {
  const m = cube(20);
  const kept = Array.from(m.indices).slice(0, 24);
  const indices = createIndexArray(kept.length);
  indices.set(kept);
  return { positions: m.positions, indices, metadata: {} };
};

const physicalPin = (unit: string | undefined, over: object = {}): SplitRequest['connector'] => ({
  kind: 'physical-pin',
  unit,
  count: 1,
  diameterMm: 4,
  depthMm: 6,
  clearanceMm: 0.2,
  maleSide: 'A',
  ...over,
});
const automatic = (unit: string | undefined): SplitRequest['connector'] =>
  ({ kind: 'automatic', unit }) as SplitRequest['connector'];

interface Observed {
  readonly result?: SplitResult;
  readonly error?: unknown;
  readonly stages: string[];
  readonly booleans: string[];
}
async function observe(
  mesh: CanonicalMesh,
  connector: SplitRequest['connector'],
  placement: PlacementClass = IDENTITY_PLACEMENT,
  plane: SplitPlane = Z,
): Promise<Observed> {
  const base = await createManifoldBooleanBackend(binary),
    stages: string[] = [],
    booleans: string[] = [];
  try {
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, token) => {
          booleans.push(kind);
          return base.operate(kind, a, b, token);
        },
      },
      mesh,
      { plane, connector },
      new CancellationSource().token,
      (stage) => stages.push(stage),
      placement,
    );
    return { result, stages, booleans };
  } catch (error) {
    return { error, stages, booleans };
  }
}
const details = (error: unknown): Record<string, unknown> =>
  isAppError(error) ? error.details : {};
const messageOf = (error: unknown): string => (isAppError(error) ? error.message : '');
const UNKNOWN_UNITS: readonly (string | undefined)[] = [
  undefined,
  '',
  'furlong',
  'mm',
  'Millimeter',
  'constructor',
  '__proto__',
  'toString',
];

describe('the sentence, and what it does not say', () => {
  it('names what is missing and what to do, and never calls the model invalid or blames the cut', () => {
    expect(describeUnknownUnitRefusal()).toBe(SENTENCE);
    expect(SENTENCE).not.toMatch(/invalid|broken|corrupt|defect|safe|cut|printable|watertight/i);
  });
});

describe('an unknown unit is refused for a physical pin and for an automatic connector alike', () => {
  for (const unit of UNKNOWN_UNITS)
    for (const [label, connector] of [
      ['physical pin', physicalPin(unit)],
      ['automatic', automatic(unit)],
    ] as const)
      it(`${label}, unit ${JSON.stringify(unit)}: the typed refusal, its one sentence, no Boolean, nothing resolved`, async () => {
        const mesh = cube(30),
          observed = await observe(mesh, connector);
        expect(observed.result).toBeUndefined();
        expect(details(observed.error)).toEqual({ code: 'UNKNOWN_UNITS', refusal: 'UNIT_UNKNOWN' });
        expect(messageOf(observed.error)).toBe(SENTENCE);
        expect(observed.booleans).toEqual([]);
        // never filed as a geometry finding
        expect(JSON.stringify(details(observed.error))).not.toMatch(/NO_SAFE_SITE|CUT_NOT_SAFE/);
      });
});

describe('refusal precedence: the unit is judged FIRST, as it always was', () => {
  const NON_UNIFORM = classifyPlacement([2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  it('wins over an unsupported placement, an out-of-range size, an open surface and a plane that misses the part', async () => {
    const cases: readonly [
      string,
      CanonicalMesh,
      SplitRequest['connector'],
      PlacementClass,
      SplitPlane,
    ][] = [
      ['placement', cube(30), physicalPin('furlong'), NON_UNIFORM, Z],
      ['size', cube(30), physicalPin('furlong', { diameterMm: 0.001 }), IDENTITY_PLACEMENT, Z],
      ['open surface', openCube(), physicalPin('furlong'), IDENTITY_PLACEMENT, Z],
      [
        'plane',
        cube(30),
        physicalPin('furlong'),
        IDENTITY_PLACEMENT,
        { origin: [0, 0, 50], normal: [0, 0, 1] },
      ],
      ['automatic placement', cube(30), automatic('furlong'), NON_UNIFORM, Z],
      ['automatic open surface', openCube(), automatic('furlong'), IDENTITY_PLACEMENT, Z],
    ];
    for (const [name, mesh, connector, placement, plane] of cases) {
      const observed = await observe(mesh, connector, placement, plane);
      expect(details(observed.error).code, name).toBe('UNKNOWN_UNITS');
      expect(observed.booleans, name).toEqual([]);
    }
  });
  it('is judged AFTER nothing that it used to follow: a known unit with an unsupported placement is still the transform refusal (C03-B)', async () => {
    const observed = await observe(cube(30), physicalPin('millimeter'), NON_UNIFORM);
    expect(details(observed.error)).toMatchObject({
      code: 'CONNECTOR_UNSUPPORTED_TRANSFORM',
      transformReason: 'NON_UNIFORM_SCALE',
    });
  });
});

describe('a known unit is never a refusal, and a plain cut needs no unit at all', () => {
  it('a plain cut needs none (a split without connectors is always available)', async () => {
    const observed = await observe(cube(30), { kind: 'none' });
    expect(observed.result?.connector.kind).toBe('none');
  });
  it('every supported unit takes the same physical pin', async () => {
    for (const unit of ['micron', 'millimeter', 'centimeter', 'meter', 'inch', 'foot']) {
      const factor: Record<string, number> = {
        micron: 0.001,
        millimeter: 1,
        centimeter: 10,
        meter: 1000,
        inch: 25.4,
        foot: 304.8,
      };
      const size = 30 / (factor[unit] ?? Number.NaN);
      const observed = await observe(cube(size), physicalPin(unit));
      expect(observed.result?.connector.kind, unit).toBe('pin');
    }
  });
});

describe('the worker boundary accepts a physical request only', () => {
  it('a coordinate pin and a dovetail are refused with the typed code, whatever else they carry', () => {
    for (const connector of [
      { kind: 'pin', count: 1, diameter: 4, depth: 6, clearance: 0.2, maleSide: 'A' },
      { kind: 'dovetail' },
      { kind: '__proto__' },
      { kind: 'constructor' },
      { kind: '' },
    ])
      try {
        assertProductConnectorRequest(connector);
        throw new Error('not refused');
      } catch (error) {
        expect(details(error)).toEqual({
          code: 'CONNECTOR_REQUEST_NOT_PHYSICAL',
          refusal: 'REQUEST_NOT_PHYSICAL',
        });
        expect(messageOf(error)).toBe('Connector sizes must be requested in millimetres.');
      }
  });
  it('none, automatic and a physical pin pass', () => {
    for (const kind of ['none', 'automatic', 'physical-pin'])
      expect(() => {
        assertProductConnectorRequest({ kind });
      }).not.toThrow();
  });
});

describe('the unit the file states wins over the one a request names', () => {
  const pin = physicalPin('inch') as ProductConnectorRequest;
  const auto: ProductConnectorRequest = { kind: 'automatic', unit: 'inch' };
  it('replaces a different unit, in a physical pin and in an automatic request', () => {
    expect(withStatedUnit(pin, 'millimeter')).toMatchObject({
      kind: 'physical-pin',
      unit: 'millimeter',
    });
    expect(withStatedUnit(auto, 'meter')).toEqual({ kind: 'automatic', unit: 'meter' });
  });
  it('fills in the unit a request lacks, and leaves an agreeing request as the SAME object', () => {
    expect(
      withStatedUnit(physicalPin(undefined) as ProductConnectorRequest, 'micron'),
    ).toMatchObject({
      unit: 'micron',
    });
    expect(withStatedUnit(pin, 'inch')).toBe(pin);
  });
  it("changes nothing when the file states none (the user's assignment is the request's) and nothing for a plain cut", () => {
    expect(withStatedUnit(pin, undefined)).toBe(pin);
    const none: ProductConnectorRequest = { kind: 'none' };
    expect(withStatedUnit(none, 'millimeter')).toBe(none);
  });
});
