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
  splitWithConnectors,
  type SplitConnector,
  type SplitPlane,
  type SplitRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
// Internal planner API, imported by path: it is deliberately not part of the package index.
import {
  ConnectorRefusal,
  deriveInterfaceRegion,
  refusalForLegacyCode,
  sameSeparationInterface,
  separationInterfaceRefOf,
} from '../../../../../packages/geometry-runtime/src/connector-plan';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/*
 * Release 2, Slice 1 — the planner against the REAL kernel and the REAL Manifold backend.
 *
 * The pinned Boolean and stage counts below are the values the pre-change oracle recorded at 9d7262b, so a planner that
 * added a Boolean call, reordered a stage or invented a refusal fails here by number.
 */

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const Z: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };

function cube(size: number, offset: readonly [number, number, number] = [0, 0, 0]): CanonicalMesh {
  const h = size / 2,
    corners = [-h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h, -h, -h, h, h, -h, h, -h, h, h, h, h, h],
    faces = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(corners.length),
    indices = createIndexArray(faces.length);
  positions.set(corners.map((value, index) => value + (offset[index % 3] ?? 0)));
  indices.set(faces);
  return { positions, indices, metadata: {} };
}
function openCube(size: number): CanonicalMesh {
  const mesh = cube(size),
    kept = Array.from(mesh.indices).filter((_, at) => at < 24 || at >= 30),
    indices = createIndexArray(kept.length);
  indices.set(kept);
  return { ...mesh, indices };
}

interface Observed {
  readonly result?: SplitResult;
  readonly error?: unknown;
  readonly stages: string[];
  readonly booleans: string[];
}
async function observe(
  mesh: CanonicalMesh,
  connector: SplitRequest['connector'],
  plane: SplitPlane = Z,
  placement: PlacementClass = IDENTITY_PLACEMENT,
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
const pin = (
  count: 1 | 2 | 3 | 4,
  diameter: number,
  depth: number,
  maleSide: 'A' | 'B',
): SplitConnector => ({
  kind: 'pin',
  count,
  diameter,
  depth,
  clearance: 0.2,
  maleSide,
});
const detailsCode = (error: unknown): unknown =>
  isAppError(error) ? error.details.code : undefined;

function insideOuterLoop(
  uv: Float64Array,
  start: number,
  end: number,
  pu: number,
  pv: number,
): boolean {
  let inside = false;
  for (let i = start, j = end - 1; i < end; j = i++) {
    const ui = uv[2 * i] ?? 0,
      vi = uv[2 * i + 1] ?? 0,
      uj = uv[2 * j] ?? 0,
      vj = uv[2 * j + 1] ?? 0;
    if (vi > pv !== vj > pv && pu < ((uj - ui) * (pv - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

describe('Slice 1 planner on the real kernel', () => {
  it('describes a manual two-pin split: pairs, sites in the interface, bound to the generated interface', async () => {
    const { result, stages, booleans } = await observe(cube(40), pin(2, 3, 5, 'A'));
    const plan = result?.connectorPlan;
    if (!result || !plan || !result.closedPlaneClip) throw new Error('expected a connector plan');
    expect(plan.connectorKind).toBe('pin');
    expect(plan.pairs.map((pair) => pair.pairId)).toEqual(['pin-1', 'pin-2']);
    expect(plan.pairs.every((pair) => pair.maleSide === 'A')).toBe(true);
    // bound to THIS interface, field for field
    const face = result.closedPlaneClip.interface;
    expect(sameSeparationInterface(plan.interfaceRef, separationInterfaceRefOf(face))).toBe(true);
    expect(plan.interfaceRef.frameIdentity).toBe(face.frame.identity);
    // every site is where the existing code put it, and lies inside the interface's own outline
    expect(plan.pairs.map((pair) => pair.site.local)).toHaveLength(result.placements.length);
    const region = deriveInterfaceRegion(face);
    const [outline] = region.loops;
    for (const pair of plan.pairs) {
      expect(pair.site.u).toBeGreaterThanOrEqual(region.bounds.minU);
      expect(pair.site.u).toBeLessThanOrEqual(region.bounds.maxU);
      expect(pair.site.v).toBeGreaterThanOrEqual(region.bounds.minV);
      expect(pair.site.v).toBeLessThanOrEqual(region.bounds.maxV);
      expect(
        insideOuterLoop(
          face.sharedRegion.uv,
          outline?.start ?? 0,
          outline?.end ?? 0,
          pair.site.u,
          pair.site.v,
        ),
      ).toBe(true);
    }
    // numbers the oracle pinned at 9d7262b: same stages, and exactly two Booleans per pair
    expect(stages).toEqual([
      'preparing-cut',
      'intersecting',
      'building-cut-surfaces',
      'adding-connectors',
    ]);
    expect(booleans).toEqual(['union', 'difference', 'union', 'difference']);
  });
  it('keeps world placements equal to the plan sites plus the output anchor on an offset part', async () => {
    const mesh = cube(40, [1000, -500, 300]);
    const { result } = await observe(mesh, pin(1, 4, 6, 'B'), {
      origin: [1000, -500, 300],
      normal: [0, 0, 1],
    });
    const plan = result?.connectorPlan,
      face = result?.closedPlaneClip?.interface;
    if (!result || !plan || !face) throw new Error('expected a connector plan');
    const [pair] = plan.pairs;
    const site = pair?.site.local ?? [NaN, NaN, NaN];
    expect(face.outputAnchor.some((value) => value !== 0)).toBe(true);
    expect(result.placements[0]).toEqual([
      site[0] + face.outputAnchor[0],
      site[1] + face.outputAnchor[1],
      site[2] + face.outputAnchor[2],
    ]);
    expect(pair?.maleSide).toBe('B');
  });
  it('describes an automatic pin plan with its unit context and records the pairs it applied', async () => {
    const { result, booleans } = await observe(cube(30), { kind: 'automatic', unit: 'millimeter' });
    const plan = result?.connectorPlan;
    if (!result || !plan) throw new Error('expected an automatic connector plan');
    expect(result.automaticConnector).toBe('applied');
    expect(plan.unitContext).toEqual({
      basis: 'REQUEST_UNIT',
      unit: 'millimeter',
      partScale: 1,
      partScaleApplied: true,
      mmPerUnit: 1,
      mmPerCoordinate: 1,
    });
    // the sizes were resolved physically (Stage C03-C1), so the plan carries the physical policy label
    expect(plan.policy).toBe('units-v1');
    expect(plan.pairs).toHaveLength(result.placements.length);
    // oracle S10: two automatic pairs, two Booleans each (the union and the difference). Slice 2D retired the two guard
    // intersections each pair used to run first: material support is judged by `support-v1` before any Boolean, not by a Boolean.
    expect(booleans).toHaveLength(4);
  });
  it("states, instead of hiding, that a COORDINATE size ignores the part scale (the engine's legacy request; no product flow sends it)", async () => {
    const { result } = await observe(
      cube(40),
      pin(1, 4, 6, 'A'),
      Z,
      classifyPlacement([2.5, 0, 0, 0, 2.5, 0, 0, 0, 2.5, 0, 0, 0]),
    );
    expect(result?.connectorPlan?.unitContext).toEqual({
      basis: 'COORDINATES',
      partScale: 1,
      partScaleApplied: false,
    });
    expect(result?.connectorPlan?.policy).toBe('legacy-v0');
  });
  it('a PHYSICAL manual pin states the unit, the placement scale, the factor and the millimetres it was asked for', async () => {
    const { result } = await observe(
      cube(40),
      {
        kind: 'physical-pin',
        unit: 'millimeter',
        count: 1,
        diameterMm: 4,
        depthMm: 6,
        clearanceMm: 0.2,
        maleSide: 'A',
      },
      Z,
      classifyPlacement([2.5, 0, 0, 0, 2.5, 0, 0, 0, 2.5, 0, 0, 0]),
    );
    expect(result?.connectorPlan?.policy).toBe('units-v1');
    expect(result?.connectorPlan?.unitContext).toEqual({
      basis: 'PHYSICAL_MM',
      unit: 'millimeter',
      partScale: 2.5,
      partScaleApplied: true,
      mmPerUnit: 1,
      mmPerCoordinate: 2.5,
      intentMm: { diameter: 4, depth: 6, clearance: 0.2 },
    });
    expect(result?.connector).toMatchObject({ diameter: 4 / 2.5, depth: 6 / 2.5 });
  });
  it('adds no plan, and no Boolean, when no connector was applied', async () => {
    for (const [mesh, connector, expectedKeys] of [
      [cube(20), { kind: 'none' }, undefined],
      [cube(4), { kind: 'automatic', unit: 'millimeter' }, undefined],
      [cube(30), { kind: 'automatic', unit: 'millimeter' }, 'nan-scale'],
    ] as const) {
      const { result, booleans } = await observe(
        mesh,
        connector,
        Z,
        expectedKeys === 'nan-scale'
          ? classifyPlacement([2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
          : IDENTITY_PLACEMENT,
      );
      expect(result).toBeDefined();
      expect(result?.connectorPlan).toBeUndefined();
      expect(Object.keys(result ?? {})).not.toContain('connectorPlan');
      expect(booleans).toEqual([]);
    }
  });
  it('restores the plain split and drops the plan when an automatic connector Boolean fails', async () => {
    const base = await createManifoldBooleanBackend(binary);
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, token) => {
          if (kind === 'difference') throw new Error('Controlled socket failure');
          return base.operate(kind, a, b, token);
        },
      },
      cube(30),
      { plane: Z, connector: { kind: 'automatic', unit: 'millimeter' } },
      new CancellationSource().token,
    );
    expect(result.connector).toEqual({ kind: 'none' });
    expect(result.automaticConnector).toBe('unavailable');
    expect(result.connectorPlan).toBeUndefined();
  });
  it('does not plan an open surface or a legacy dovetail', async () => {
    const open = await observe(openCube(20), { kind: 'none' });
    expect(open.result?.connectorPlan).toBeUndefined();
    const dovetail = await observe(cube(40), {
      kind: 'dovetail',
      width: 8,
      depth: 6,
      length: 12,
      clearance: 0.2,
      maleSide: 'A',
      orientationDegrees: 0,
    });
    expect(dovetail.result?.connector.kind).toBe('dovetail');
    expect(dovetail.result?.connectorPlan).toBeUndefined();
  });
});

describe('refusal parity: every existing refusal keeps its code, and has a typed reading', () => {
  it('connector does not fit near the edge', async () => {
    const { error, booleans, stages } = await observe(cube(40), pin(1, 1000, 6, 'A'));
    expect(detailsCode(error)).toBe('CONNECTOR_TOO_CLOSE_TO_EDGE');
    expect(refusalForLegacyCode(detailsCode(error))).toBe(ConnectorRefusal.EDGE_CLEARANCE);
    expect(booleans).toEqual([]);
    // the stage was announced BEFORE the refusal, exactly as before the planner existed
    expect(stages.at(-1)).toBe('adding-connectors');
  });
  it('requested connectors do not fit together', async () => {
    const { error } = await observe(cube(30), pin(2, 9, 4, 'B'));
    expect(detailsCode(error)).toBe('CONNECTOR_DOES_NOT_FIT');
    expect(refusalForLegacyCode(detailsCode(error))).toBe(ConnectorRefusal.DOES_NOT_FIT_COUNT);
  });
  it('an unknown unit for an automatic connector', async () => {
    const { error, stages } = await observe(cube(30), { kind: 'automatic', unit: 'furlong' });
    expect(detailsCode(error)).toBe('UNKNOWN_UNITS');
    expect(refusalForLegacyCode(detailsCode(error))).toBe(ConnectorRefusal.UNIT_UNKNOWN);
    expect(stages).toEqual(['preparing-cut']);
  });
  it('a connector on an open surface', async () => {
    const { error } = await observe(openCube(20), pin(1, 4, 6, 'A'));
    expect(detailsCode(error)).toBe('OPEN_SPLIT_CONNECTOR_UNSUPPORTED');
    expect(refusalForLegacyCode(detailsCode(error))).toBe(
      ConnectorRefusal.OPEN_SURFACE_UNSUPPORTED,
    );
  });
  it('an out-of-range dimension is still refused BEFORE any site is looked for', async () => {
    const { error, booleans } = await observe(cube(40), pin(1, 0.001, 6, 'A'));
    expect(isAppError(error) && error.message).toBe('Pin diameter is outside the supported range.');
    expect(booleans).toEqual([]);
  });
  it('a cut that cannot be made keeps its code and reason', async () => {
    const { error } = await observe(
      cube(20),
      { kind: 'none' },
      { origin: [0, 0, 30], normal: [0, 0, 1] },
    );
    expect(detailsCode(error)).toBe('CUT_NOT_SAFE');
    expect(isAppError(error) && error.details.reason).toBe('EMPTY_PIECE');
  });
});

describe('module boundary (G7)', () => {
  const text = readFileSync('packages/geometry-runtime/src/connector-plan.ts', 'utf8');
  // Comments describe the boundary; the boundary is what the code imports and calls.
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...source.matchAll(/^import(?: type)?[^;]*?from '([^']+)';/gms)].map(
    (m) => m[1],
  );
  it('imports only what a worker-side geometry module may', () => {
    expect([...imports].sort()).toEqual(
      [
        './closed-plane-kernel',
        // the one sentence for a model with no unit: a leaf module that imports nothing (Stage C03-C2)
        './connector-unit-refusal',
        './split-connectors',
        './split-source-identity',
        '@cadfixer/shared',
      ].sort(),
    );
    expect(
      readFileSync('packages/geometry-runtime/src/connector-unit-refusal.ts', 'utf8'),
    ).not.toMatch(/^import /m);
  });
  it('takes only TYPES from split-connectors, so there is no runtime import cycle', () => {
    expect(source).toMatch(/^import type \{[^}]*\} from '\.\/split-connectors';/m);
    expect(source).toMatch(/^import type \{[^}]*\} from '\.\/closed-plane-kernel';/m);
  });
  it('names no UI, renderer, network, storage or sibling-engine API', () => {
    for (const forbidden of [
      'react',
      'three',
      'mesh-hole-fill',
      'file-formats',
      'apps/',
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'localStorage',
      'Worker(',
      'runValidatedBoolean',
      'manifold',
    ])
      expect(source).not.toContain(forbidden);
  });
});
