import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { CancellationSource, isAppError } from '@cadfixer/shared';
import {
  splitWithConnectors,
  type SplitRequest,
  type SplitPlane,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
// Internal API, imported by path: it is deliberately not part of the package index.
import {
  ConnectorRefusal,
  refusalForLegacyCode,
} from '../../../../../packages/geometry-runtime/src/connector-plan';
import { identifyConnectorCompatibilitySurface } from '../../../../../packages/geometry-runtime/src/split-connectors';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/*
 * Release 2, Slice 2B — footprint containment on the REAL kernel and the REAL Manifold backend.
 *
 * The fixtures are closed solids whose plane is coplanar with a ledge. The ledge's faces belong to ONE piece, so the
 * connector COMPATIBILITY surface (every coplanar face of that piece) is the whole ledge, while the GENERATED interface (the
 * cap the kernel made where the pieces meet) is only the small block's footprint. The legacy site search reads the former;
 * Slice 2B refuses a footprint that is not inside the latter.
 */

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const UP: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };
// normal DOWN puts the ledge on piece A, the piece the legacy site selection reads
const DOWN: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, -1] };

function box(sx: number, sy: number, sz: number, cx = 0, cy = 0, cz = 0): CanonicalMesh {
  const hx = sx / 2,
    hy = sy / 2,
    hz = sz / 2,
    corners = [
      -hx,
      -hy,
      -hz,
      hx,
      -hy,
      -hz,
      -hx,
      hy,
      -hz,
      hx,
      hy,
      -hz,
      -hx,
      -hy,
      hz,
      hx,
      -hy,
      hz,
      -hx,
      hy,
      hz,
      hx,
      hy,
      hz,
    ],
    faces = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(corners.length),
    indices = createIndexArray(faces.length);
  const centre = [cx, cy, cz];
  positions.set(corners.map((value, index) => value + (centre[index % 3] ?? 0)));
  indices.set(faces);
  return { positions, indices, metadata: {} };
}
async function boolean(
  kind: 'union' | 'difference',
  a: CanonicalMesh,
  b: CanonicalMesh,
): Promise<CanonicalMesh> {
  const backend = await createManifoldBooleanBackend(binary);
  return await backend.operate(kind, a, b, new CancellationSource().token);
}
/** A 60x60x10 base with a 20x20x10 block centred on it: the plane z=0 is coplanar with the 60x60 ledge. */
const ledge = (): Promise<CanonicalMesh> =>
  boolean('union', box(60, 60, 10, 0, 0, -5), box(20, 20, 10, 0, 0, 5));
/** The same, with the block turned and moved by an exact 90 degrees about X and an integer shift. */
async function ledgeTurned(): Promise<CanonicalMesh> {
  const mesh = await ledge(),
    positions = createPositionArray(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = (mesh.positions[i] ?? 0) + 100;
    positions[i + 1] = -(mesh.positions[i + 2] ?? 0) - 50;
    positions[i + 2] = (mesh.positions[i + 1] ?? 0) + 30;
  }
  return { ...mesh, positions };
}
/** A 60x60x40 base, a 20x20 stem, and a 60x60 cap held over the ledge: there IS material above the ledge, but not at the stem. */
async function mushroom(): Promise<CanonicalMesh> {
  return boolean(
    'union',
    await boolean('union', box(60, 60, 40, 0, 0, -20), box(20, 20, 10, 0, 0, 5)),
    box(60, 60, 10, 0, 0, 15),
  );
}
/** A plate with a 16x16 opening through it. */
const plateWithOpening = (): Promise<CanonicalMesh> =>
  boolean('difference', box(60, 60, 20), box(16, 16, 40));

interface Observed {
  readonly result?: SplitResult;
  readonly error?: unknown;
  readonly stages: string[];
  readonly booleans: string[];
}
async function observe(
  mesh: CanonicalMesh,
  connector: SplitRequest['connector'],
  plane: SplitPlane,
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
    );
    return { result, stages, booleans };
  } catch (error) {
    return { error, stages, booleans };
  }
}
const pin = (
  count: 1 | 2 | 3 | 4,
  diameter: number,
  maleSide: 'A' | 'B' = 'A',
): SplitRequest['connector'] => ({
  kind: 'pin',
  count,
  diameter,
  depth: 5,
  clearance: 0.2,
  maleSide,
});
const details = (error: unknown): Record<string, unknown> =>
  isAppError(error) ? error.details : {};
const copy = (mesh: CanonicalMesh): string =>
  `${Array.from(mesh.positions).join(',')}|${Array.from(mesh.indices).join(',')}`;

describe('a footprint that is not on the generated interface is refused BEFORE any Boolean', () => {
  it('refuses a manual pin the legacy search put on the ledge, with a typed reason and a truthful sentence', async () => {
    const mesh = await ledge(),
      before = copy(mesh),
      { error, booleans, stages, result } = await observe(mesh, pin(2, 4), DOWN);
    expect(result).toBeUndefined();
    expect(details(error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    expect(details(error).refusal).toBe(ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE);
    expect(refusalForLegacyCode(details(error).code)).toBe(
      ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
    );
    expect(details(error).pairId).toBe('pin-2');
    expect(isAppError(error) && error.code).toBe('INVALID_STATE');
    expect(isAppError(error) && error.message).toContain('does not fit on the cut surface');
    // precedence and ordering are the existing ones: the stage was announced, then the refusal; and not one Boolean ran
    expect(stages).toEqual([
      'preparing-cut',
      'intersecting',
      'building-cut-surfaces',
      'adding-connectors',
    ]);
    expect(booleans).toEqual([]);
    // the input the caller holds is untouched
    expect(copy(mesh)).toBe(before);
  });
  it('fails the WHOLE plan closed: four pins where one site is valid still run no Boolean and drop nothing silently', async () => {
    const { error, booleans } = await observe(await ledge(), pin(4, 3, 'B'), DOWN);
    expect(details(error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    // pin-1 sits at the centre of the 20x20 cap and is valid on its own: the plan is refused regardless
    expect(details(error).invalidPairs).toBe(3);
    expect(details(error).checkedPairs).toBe(4);
    expect(booleans).toEqual([]);
  });
  it('does not rescue the plan by choosing another site: the same request is refused the same way every time', async () => {
    const mesh = await ledge(),
      first = await observe(mesh, pin(2, 4), DOWN),
      second = await observe(mesh, pin(2, 4), DOWN);
    expect(details(first.error)).toEqual(details(second.error));
  });
});

/** The block sits off-centre, so the legacy pole (the middle of the 60x60 ledge) is INSIDE the cap, 2 units from its edge. */
const ledgeOffset = (): Promise<CanonicalMesh> =>
  boolean('union', box(60, 60, 10, 0, 0, -5), box(20, 20, 10, 8, 0, 5));

describe('centre inside the interface, circle crosses its exterior edge (case B, on the real kernel)', () => {
  it('refuses a pin whose centre is on the interface but whose socket mouth is not, naming the outline and the overreach', async () => {
    const { error, booleans, result } = await observe(await ledgeOffset(), pin(1, 6), DOWN);
    expect(result).toBeUndefined();
    expect(details(error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    expect(details(error).centerInMaterial).toBe(true);
    expect(details(error).loopId).toBe(0);
    // socket mouth 3.2 against an edge 2 away
    expect(details(error).footprintRadius).toBeCloseTo(3.2, 9);
    expect(details(error).overreach as number).toBeCloseTo(1.2, 6);
    expect(booleans).toEqual([]);
  });
  it('decides on the SOCKET mouth, not the smaller pin: a pin that fits alone is refused for its clearance', async () => {
    // pin radius 1.9 clears an edge 2 away; the socket mouth 1.9 + 0.2 = 2.1 does not
    const { error } = await observe(await ledgeOffset(), pin(1, 3.8), DOWN);
    expect(details(error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    expect(details(error).overreach as number).toBeCloseTo(0.1, 6);
    // a pin whose socket mouth (1.3 + 0.2) clears the edge by more than the cut-face margin (0.35 r) is accepted
    const smaller = await observe(await ledgeOffset(), pin(1, 2.6), DOWN);
    expect(smaller.result?.connector.kind).toBe('pin');
    // a socket mouth that fits the interface (1.9 against an edge 2 away) but not with the support margin beside it is NOT a
    // footprint failure: it is refused by Slice 2D, which is the point of keeping the two questions apart
    const tight = await observe(await ledgeOffset(), pin(1, 3.4), DOWN);
    expect(tight.result).toBeUndefined();
    expect(details(tight.error).code).toBe('CONNECTOR_SOCKET_SUPPORT_INSUFFICIENT');
    expect(tight.booleans).toEqual([]);
  });
  it('accepts the same solid when the ledge is on the other piece, where the pole is the middle of the cap itself', async () => {
    const { result } = await observe(await ledgeOffset(), pin(1, 6), UP);
    expect(result?.placements).toEqual([[8, 0, 0]]);
  });
});

const exactPin = (diameter: number): SplitRequest['connector'] => ({
  kind: 'pin',
  count: 1,
  diameter,
  depth: 5,
  clearance: 0,
  maleSide: 'A',
});
const footprintRefused = (error: unknown): boolean =>
  String(details(error).code).startsWith('CONNECTOR_FOOTPRINT_');

describe('the tolerance is the kernel split tolerance, at the call site', () => {
  // the legacy pole sits 2 from the cap edge; the real tolerance on this solid is about 9e-5
  it('contains a socket mouth that reaches past the edge by less than the tolerance, and refuses one that reaches past by more', async () => {
    const within = await observe(await ledgeOffset(), exactPin(4.00005), DOWN);
    expect(footprintRefused(within.error)).toBe(false);
    const beyond = await observe(await ledgeOffset(), exactPin(4.0004), DOWN);
    expect(details(beyond.error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    expect(details(beyond.error).overreach as number).toBeCloseTo(2e-4, 5);
    expect(beyond.booleans).toEqual([]);
  });
});

/** The block is off-centre in BOTH axes, so a flipped or swapped (u, v) mapping would put the cap centre outside the cap. */
const ledgeOffsetBoth = (): Promise<CanonicalMesh> =>
  boolean('union', box(60, 60, 10, 0, 0, -5), box(20, 20, 10, 8, 6, 5));

describe('the site is mapped into the interface frame without a flip or a swap', () => {
  it('accepts the cap centre when it is neither on an axis nor at the origin', async () => {
    const { result } = await observe(await ledgeOffsetBoth(), pin(1, 4), UP);
    expect(result?.placements).toEqual([[8, 6, 0]]);
  });
  it('refuses the origin pole, which is inside the cap but 2 from its edge, on the contaminated piece', async () => {
    const { error } = await observe(await ledgeOffsetBoth(), pin(1, 6), DOWN);
    expect(details(error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    expect(details(error).centerInMaterial).toBe(true);
  });
});

describe('the decision uses the generated interface, never the coplanar neighbour (R5V4)', () => {
  it('shows the contamination the legacy surface carries, and the interface that is actually generated', async () => {
    const { result } = await observe(await ledge(), { kind: 'none' }, DOWN);
    const clip = result?.closedPlaneClip;
    if (!result || !clip) throw new Error('expected a clip');
    // the interface is the 20x20 cap: 400, not the 3,600 of the whole ledge, and not an inflated 500/600-style figure
    expect(clip.interface.area).toBe(400);
    expect(result.cutA.area).toBe(400);
    const compat = identifyConnectorCompatibilitySurface(
      result.pieceA,
      DOWN,
      result.metrics.tolerance,
    );
    expect(compat.spanU).toBe(60);
    expect(compat.spanV).toBe(60);
  });
  it('still accepts the pin the generated interface can hold, on the contaminated piece', async () => {
    const { result, booleans } = await observe(await ledge(), pin(1, 4), DOWN);
    expect(result?.connector.kind).toBe('pin');
    expect(result?.placements).toEqual([[0, 0, 0]]);
    expect(booleans).toEqual(['union', 'difference']);
  });
  it('accepts every footprint when the ledge is on the OTHER piece, because the surface is then the cap itself', async () => {
    for (const [count, expected] of [
      [1, 2],
      [2, 4],
      [4, 8],
    ] as const) {
      const { result, booleans } = await observe(
        await ledge(),
        pin(count, count === 4 ? 3 : 4),
        UP,
      );
      expect(result?.placements).toHaveLength(count);
      expect(booleans).toHaveLength(expected);
    }
  });
});

describe('contained footprints are accepted exactly as before', () => {
  it('a plate with an opening, islands and nested loops keep their placements and Boolean counts', async () => {
    const plate = await observe(await plateWithOpening(), pin(4, 3, 'B'), UP);
    expect(plate.result?.placements).toHaveLength(4);
    expect(plate.booleans).toHaveLength(8);
    const solid = await observe(box(40, 40, 40), pin(2, 3), UP);
    expect(solid.result?.placements).toHaveLength(2);
  });
});

describe('automatic connectors go through the same check, and nothing is searched for instead', () => {
  it('reports the automatic connector as unavailable with the typed reason, restores the plain split and runs no Boolean', async () => {
    const { result, booleans, stages } = await observe(
      await mushroom(),
      { kind: 'automatic', unit: 'millimeter' },
      DOWN,
    );
    expect(result?.automaticConnector).toBe('unavailable');
    expect(result?.automaticConnectorDiagnostics?.reason).toBe('FOOTPRINT_NOT_CONTAINED');
    expect(result?.connector).toEqual({ kind: 'none' });
    expect(result?.connectorPlan).toBeUndefined();
    expect(result?.placements).toEqual([]);
    expect(booleans).toEqual([]);
    expect(stages.at(-1)).toBe('adding-connectors');
  });
  it('still applies an automatic connector whose sites are all on the interface', async () => {
    const { result } = await observe(await ledge(), { kind: 'automatic', unit: 'millimeter' }, UP);
    expect(result?.automaticConnector).toBe('applied');
  });
});

describe('the same decision in a turned and shifted frame (translation / rotation)', () => {
  it('refuses the same pair for the same reason, and accepts the same single pin', async () => {
    const turned = { origin: [100, -50, 30], normal: [0, 1, 0] } as const satisfies SplitPlane;
    const refused = await observe(await ledgeTurned(), pin(2, 4), turned);
    expect(details(refused.error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    expect(details(refused.error).pairId).toBe('pin-2');
    expect(refused.booleans).toEqual([]);
    const accepted = await observe(await ledgeTurned(), pin(1, 4), turned);
    expect(accepted.result?.connector.kind).toBe('pin');
  });
});

describe('an oblique plane', () => {
  /** The ledge solid turned about Y so that sin = 0.6, cos = 0.8; the plane is turned with it. */
  async function oblique(): Promise<CanonicalMesh> {
    const mesh = await ledge(),
      positions = createPositionArray(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0,
        z = mesh.positions[i + 2] ?? 0;
      positions[i] = x * 0.8 + z * 0.6;
      positions[i + 1] = mesh.positions[i + 1] ?? 0;
      positions[i + 2] = -x * 0.6 + z * 0.8;
    }
    return { ...mesh, positions };
  }
  const tilted: SplitPlane = { origin: [0, 0, 0], normal: [-0.6, 0, -0.8] };
  it('judges the footprint in the interface frame, not in world axes', async () => {
    const refused = await observe(await oblique(), pin(2, 4), tilted);
    expect(details(refused.error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    expect(refused.booleans).toEqual([]);
    const accepted = await observe(await oblique(), pin(1, 4), tilted);
    expect(accepted.result?.connector.kind).toBe('pin');
  });
});

describe('what Slice 2B does not touch', () => {
  it('an open surface keeps its refusal and its automatic diagnostic', async () => {
    const closed = box(20, 20, 20),
      kept = Array.from(closed.indices).filter((_, at) => at < 24 || at >= 30),
      indices = createIndexArray(kept.length);
    indices.set(kept);
    // two faces of the cube are dropped: an open surface, which defines no solid
    const open: CanonicalMesh = { ...closed, indices };
    const manual = await observe(open, pin(1, 4), UP);
    expect(details(manual.error).code).toBe('OPEN_SPLIT_CONNECTOR_UNSUPPORTED');
    const auto = await observe(open, { kind: 'automatic', unit: 'millimeter' }, UP);
    expect(auto.result?.automaticConnectorDiagnostics?.reason).toBe('UNSUPPORTED_INTERFACE');
  });
  it('earlier refusals still win: a dimension that is out of range is refused before any footprint is looked at', async () => {
    const { error } = await observe(await ledge(), pin(2, 0.001), DOWN);
    expect(isAppError(error) && error.message).toBe('Pin diameter is outside the supported range.');
  });
  it('a connector that does not fit near the edge keeps its code, because the legacy resolver speaks first', async () => {
    const { error } = await observe(await ledge(), pin(1, 1000), DOWN);
    expect(details(error).code).toBe('CONNECTOR_TOO_CLOSE_TO_EDGE');
  });
});

describe('module boundary and ownership', () => {
  const sourceDir = join('packages', 'geometry-runtime', 'src');
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = (name: string): string => strip(readFileSync(join(sourceDir, name), 'utf8'));
  it('imports only the planner and a type from the kernel, and names no UI, network or other engine', () => {
    const text = code('connector-footprint.ts');
    const imports = [...text.matchAll(/^import(?: type)?[^;]*?from '([^']+)';/gms)].map(
      (m) => m[1],
    );
    expect([...imports].sort()).toEqual(['./closed-plane-kernel', './connector-plan']);
    expect(text).toMatch(/^import type \{[^}]*\} from '\.\/closed-plane-kernel';/m);
    for (const forbidden of [
      'react',
      'three',
      'mesh-hole-fill',
      'file-formats',
      'apps/',
      'fetch(',
      'WebSocket',
      'Worker(',
      'runValidatedBoolean',
      'FaceBvh',
      'mesh-core',
    ])
      expect(text).not.toContain(forbidden);
  });
  it('is the ONLY containment check: one call site in the engine, no second implementation', () => {
    const sources = readdirSync(sourceDir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const callers = sources.filter(
      (name) => /\bcontainFootprints\(/.test(code(name)) && name !== 'connector-footprint.ts',
    );
    expect(callers).toEqual(['split-connectors.ts']);
    expect(code('split-connectors.ts').match(/\bcontainFootprints\(/g)).toHaveLength(1);
    const distance = sources.filter(
      (name) =>
        /connector|split-connectors/.test(name) && /function segmentDistance\b/.test(code(name)),
    );
    expect(distance).toEqual(['connector-footprint.ts']);
  });
  it('uses no spatial index: the broadphase is for later checks, not for 2-D interface geometry', () => {
    for (const name of [
      'connector-footprint.ts',
      'connector-plan.ts',
      'split-connectors.ts',
      'automatic-connectors.ts',
    ])
      expect(code(name)).not.toMatch(/FaceBvh|mesh-core\/spatial/);
  });
  it('is not part of the package index, so the page bundle cannot reach it', () => {
    expect(code('index.ts')).not.toMatch(/connector-footprint|containFootprints/);
  });
});
