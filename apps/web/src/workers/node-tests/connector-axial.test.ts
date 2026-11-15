import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { CancellationSource, isAppError } from '@cadfixer/shared';
import {
  splitWithConnectors,
  type SplitPlane,
  type SplitRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
// Internal API, imported by path: it is deliberately not part of the package index.
import {
  ConnectorRefusal,
  refusalForLegacyCode,
} from '../../../../../packages/geometry-runtime/src/connector-plan';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/*
 * Release 2, Slice 2C — receiving material behind the cut, on the REAL kernel and the REAL Manifold backend.
 *
 * Every verdict of the production check is held to an INDEPENDENT reference: the Boolean kernel intersects the receiving piece
 * with the socket cylinder (shrunk by the split tolerance, lengthened by it), and the socket has receiving material throughout
 * exactly when nothing of the cylinder is lost. That shares no code with the validator, the broadphase or the exact triangle
 * test.
 */

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const UP: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };

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
async function boolean(
  kind: 'union' | 'difference' | 'intersection',
  a: CanonicalMesh,
  b: CanonicalMesh,
): Promise<CanonicalMesh> {
  const backend = await createManifoldBooleanBackend(binary);
  return backend.operate(kind, a, b, new CancellationSource().token);
}

/** 40 x 40 plate, z -3..6: the cut at z = 0 leaves 6 above (piece A) and 3 below (piece B). */
const thinBack = (): CanonicalMesh => boxAt(40, 40, 9, 0, 0, 1.5);
const thick = (): CanonicalMesh => boxAt(40, 40, 30);
/** A 20 x 20 block whose underside slopes: below the cut the material is 7 thick at the centre and 0.5 thinner per unit of +x. */
async function sloped(): Promise<CanonicalMesh> {
  const half = boxAt(300, 300, 200),
    phi = -Math.atan(0.5),
    c = Math.cos(phi),
    s = Math.sin(phi);
  for (let i = 0; i < half.positions.length; i += 3) {
    const x = half.positions[i] ?? 0,
      z = (half.positions[i + 2] ?? 0) + 100;
    half.positions[i] = x * c + z * s;
    half.positions[i + 2] = -x * s + z * c - 7;
  }
  return boolean('intersection', boxAt(20, 20, 30), half);
}
/** A void 4 high whose top is 4 below the cut. */
const cavity = (): Promise<CanonicalMesh> =>
  boolean('difference', thick(), boxAt(10, 10, 4, 0, 0, -6));
/** A small void whose box overlaps the socket's box but whose nearest corner is 2.546 from the axis (radius 2.2). */
const cavityNear = (): Promise<CanonicalMesh> =>
  boolean('difference', thick(), boxAt(2.2, 2.2, 2, 2.9, 2.9, -4));
/** A void under the SECOND of two sites (-16.667, -16.667). */
const cavityUnderSecond = (): Promise<CanonicalMesh> =>
  boolean('difference', thick(), boxAt(6, 6, 4, -16.666667, -16.666667, -6));

/** The same solid turned by an exact 90 degrees about X and shifted, and scaled uniformly (connector sizes are NOT scaled). */
function moved(
  mesh: CanonicalMesh,
  options: { turnX?: boolean; shift?: readonly number[]; scale?: number; sinCosY?: boolean },
): CanonicalMesh {
  const positions = createPositionArray(mesh.positions.length),
    shift = options.shift ?? [0, 0, 0],
    k = options.scale ?? 1;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    let x = (mesh.positions[i] ?? 0) * k,
      y = (mesh.positions[i + 1] ?? 0) * k,
      z = (mesh.positions[i + 2] ?? 0) * k;
    if (options.turnX) [y, z] = [-z, y];
    if (options.sinCosY) [x, z] = [x * 0.8 + z * 0.6, -x * 0.6 + z * 0.8];
    positions[i] = x + (shift[0] ?? 0);
    positions[i + 1] = y + (shift[1] ?? 0);
    positions[i + 2] = z + (shift[2] ?? 0);
  }
  return { ...mesh, positions };
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
  plane: SplitPlane = UP,
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
  depth: number,
  maleSide: 'A' | 'B' = 'A',
): SplitRequest['connector'] => ({ kind: 'pin', count, diameter, depth, clearance: 0.2, maleSide });
const details = (error: unknown): Record<string, unknown> =>
  isAppError(error) ? error.details : {};
const refusedAxially = (o: Observed): boolean =>
  details(o.error).code === 'CONNECTOR_SOCKET_BREAKTHROUGH';
const copy = (mesh: CanonicalMesh): string =>
  `${Array.from(mesh.positions).join(',')}|${Array.from(mesh.indices).join(',')}`;

// ----------------------------------------------------------------------------------- the independent reference
const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const cross = (a: readonly number[], b: readonly number[]): number[] => [
  (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
  (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
  (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
];
function volumeOf(mesh: CanonicalMesh): number {
  let volume = 0;
  const at = (i: number): number[] => [
    mesh.positions[(mesh.indices[i] ?? 0) * 3] ?? 0,
    mesh.positions[(mesh.indices[i] ?? 0) * 3 + 1] ?? 0,
    mesh.positions[(mesh.indices[i] ?? 0) * 3 + 2] ?? 0,
  ];
  for (let f = 0; f < mesh.indices.length; f += 3)
    volume += dot(at(f), cross(at(f + 1), at(f + 2))) / 6;
  return volume;
}
/** A closed prism of `segments` sides from axial `from` to `to` about the axis through `centre`. */
function prism(
  centre: readonly number[],
  axis: readonly number[],
  radius: number,
  from: number,
  to: number,
  segments = 128,
): CanonicalMesh {
  const reference = Math.abs(axis[0] ?? 0) < 0.8 ? [1, 0, 0] : [0, 1, 0],
    c = cross(axis, reference),
    length = Math.hypot(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0),
    u = c.map((x) => x / length),
    v = cross(axis, u),
    points: number[] = [],
    list: number[] = [];
  for (const a of [from, to])
    for (let i = 0; i < segments; i++) {
      const t = (2 * Math.PI * i) / segments;
      for (let k = 0; k < 3; k++)
        points.push(
          (centre[k] ?? 0) +
            (axis[k] ?? 0) * a +
            radius * (Math.cos(t) * (u[k] ?? 0) + Math.sin(t) * (v[k] ?? 0)),
        );
    }
  for (let i = 1; i + 1 < segments; i++)
    list.push(0, i + 1, i, segments, segments + i, segments + i + 1);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    list.push(i, j, segments + j, i, segments + j, segments + i);
  }
  const positions = createPositionArray(points.length),
    indices = createIndexArray(list.length);
  positions.set(points);
  indices.set(list);
  const mesh: CanonicalMesh = { positions, indices, metadata: {} };
  if (volumeOf(mesh) < 0)
    for (let f = 0; f < list.length; f += 3) {
      const t = indices[f + 1] ?? 0;
      indices[f + 1] = indices[f + 2] ?? 0;
      indices[f + 2] = t;
    }
  return mesh;
}
/**
 * Does the receiving piece hold the WHOLE socket (shrunk by the tolerance, lengthened by it)? Decided by the Boolean kernel.
 * The sites are the legacy resolver's (they do not depend on the depth, so a shallow plan reveals them).
 */
async function referenceHolds(
  mesh: CanonicalMesh,
  connector: Extract<SplitRequest['connector'], { kind: 'pin' }>,
  plane: SplitPlane = UP,
): Promise<boolean> {
  const shallow = await observe(mesh, { ...connector, depth: 0.5 }, plane),
    none = await observe(mesh, { kind: 'none' }, plane),
    plain = none.result,
    sites = shallow.result?.connectorPlan?.pairs.map((p) => p.site.local);
  if (!plain?.closedPlaneClip || !sites)
    throw new Error('the reference needs the plain split and the sites');
  const normal = plain.closedPlaneClip.interface.frame.N,
    axis = connector.maleSide === 'A' ? normal.map((x) => -x) : [...normal],
    female = connector.maleSide === 'A' ? plain.pieceB : plain.pieceA,
    tolerance = plain.metrics.tolerance,
    radius = connector.diameter / 2 + connector.clearance;
  for (const site of sites) {
    const cylinder = prism(site, axis, radius - tolerance, 0, connector.depth + tolerance),
      inside = await boolean('intersection', female, cylinder);
    if (Math.abs(volumeOf(inside) - volumeOf(cylinder)) > 1e-7 * volumeOf(cylinder)) return false;
  }
  return true;
}
const PIN_A = (
  depth: number,
  diameter = 4,
): Extract<SplitRequest['connector'], { kind: 'pin' }> => ({
  kind: 'pin',
  count: 1,
  diameter,
  depth,
  clearance: 0.2,
  maleSide: 'A',
});

/** Euler characteristic V - E + F of an indexed closed mesh: 2 for a ball, 0 with one through-hole. */
function eulerCharacteristic(mesh: CanonicalMesh): number {
  const edges = new Set<string>();
  for (let f = 0; f < mesh.indices.length; f += 3)
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[f + k] ?? 0,
        b = mesh.indices[f + ((k + 1) % 3)] ?? 0;
      edges.add(a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`);
    }
  return mesh.positions.length / 3 - edges.size + mesh.indices.length / 3;
}

describe('the historical defect: a socket deeper than the receiving material', () => {
  it('is what the Boolean path does when nothing stops it: the socket opens the back and the piece gains a through-hole', async () => {
    // the receiving piece (B, 3 thick) with the socket cut exactly as the connector Boolean cuts it
    const none = await observe(thinBack(), { kind: 'none' }),
      female = none.result?.pieceB;
    if (!female) throw new Error('no piece');
    const socket = prism([0, 0, 0], [0, 0, -1], 2.2, -1e-3, 6),
      cut = await boolean('difference', female, socket);
    // a closed ball has Euler characteristic 2, a solid with one through-hole 0
    expect(eulerCharacteristic(cut)).toBe(0);
    const plain = await boolean(
      'difference',
      (await observe(thick(), { kind: 'none' })).result?.pieceB ?? female,
      socket,
    );
    expect(eulerCharacteristic(plain)).toBe(2);
  });
  it('is refused BEFORE any Boolean, with a typed reason, and leaves the input untouched', async () => {
    const mesh = thinBack(),
      before = copy(mesh),
      { error, result, booleans, stages } = await observe(mesh, pin(1, 4, 6));
    expect(result).toBeUndefined();
    expect(details(error).code).toBe('CONNECTOR_SOCKET_BREAKTHROUGH');
    expect(details(error).refusal).toBe(ConnectorRefusal.SOCKET_BREAKTHROUGH);
    expect(refusalForLegacyCode(details(error).code)).toBe(ConnectorRefusal.SOCKET_BREAKTHROUGH);
    expect(details(error).pairId).toBe('pin-1');
    expect(details(error).invalidPairs).toBe(1);
    expect(details(error).checkedPairs).toBe(1);
    expect(isAppError(error) && error.code).toBe('INVALID_STATE');
    expect(isAppError(error) && error.message).toContain('does not fit in the receiving piece');
    expect(booleans).toEqual([]);
    expect(stages).toEqual([
      'preparing-cut',
      'intersecting',
      'building-cut-surfaces',
      'adding-connectors',
    ]);
    expect(copy(mesh)).toBe(before);
  });
  it('is refused for the other male side too: a socket whose end meets the back face leaves no wall at all', async () => {
    // male B, so piece A (6 thick) receives a socket 6 deep
    const { error, booleans } = await observe(thinBack(), pin(1, 4, 6, 'B'));
    expect(details(error).code).toBe('CONNECTOR_SOCKET_BREAKTHROUGH');
    expect(booleans).toEqual([]);
    expect((await observe(thinBack(), pin(1, 4, 4, 'B'))).result?.connector.kind).toBe('pin');
  });
});

describe('fixtures: the verdict of the production check equals the Boolean-kernel reference', () => {
  const cases: readonly (readonly [
    string,
    () => Promise<CanonicalMesh> | CanonicalMesh,
    Extract<SplitRequest['connector'], { kind: 'pin' }>,
    boolean,
  ])[] = [
    ['thin back wall, depth 6 into 3', thinBack, PIN_A(6), false],
    ['thin back wall, depth 2 into 3', thinBack, PIN_A(2), true],
    ['thick solid, depth 6', thick, PIN_A(6), true],
    ['sloped back, socket 2.2 wide (edge reaches the slope early)', sloped, PIN_A(6), false],
    ['sloped back, socket 1.2 wide (stays inside the thicker part)', sloped, PIN_A(6, 2), true],
    ['internal cavity under the site, depth 6', cavity, PIN_A(6), false],
    ['internal cavity under the site, depth 3', cavity, PIN_A(3), true],
    ['cavity beside the socket but inside its bounding box', cavityNear, PIN_A(6), true],
  ];
  for (const [name, make, connector, holds] of cases)
    it(`${name}: ${holds ? 'accepted' : 'refused'}, as the reference says`, async () => {
      const mesh = await make();
      expect(await referenceHolds(mesh, connector)).toBe(holds);
      const observed = await observe(mesh, connector);
      expect(refusedAxially(observed)).toBe(!holds);
      expect(observed.booleans.length).toBe(holds ? 2 : 0);
      if (holds) expect(observed.result?.connector.kind).toBe('pin');
    });
});

describe('the numbers the validator is given are the numbers the primitive is built from', () => {
  it('is sharp to the split tolerance at the call site: a wall left of half a tolerance breaches, of two tolerances does not', async () => {
    const tolerance = (await observe(thinBack(), { kind: 'none' })).result?.metrics.tolerance;
    if (tolerance === undefined) throw new Error('no tolerance');
    // piece B is 3 thick
    expect(refusedAxially(await observe(thinBack(), PIN_A(3 - tolerance / 2)))).toBe(true);
    expect(refusedAxially(await observe(thinBack(), PIN_A(3 - 2 * tolerance)))).toBe(false);
  });
  it('separates the socket mouth (2.2) from the pin (2.0) and from the validated depth: the slope reaches 5.9 at the mouth, 6.0 at the pin', async () => {
    const mesh = await sloped();
    expect(await referenceHolds(mesh, PIN_A(5.95))).toBe(false);
    expect(refusedAxially(await observe(mesh, PIN_A(5.95)))).toBe(true);
    // 5.85 clears the slope at the mouth (5.9) by more than the tolerance
    expect(refusedAxially(await observe(mesh, PIN_A(5.85)))).toBe(false);
  });
});

describe('a thick solid is accepted EXACTLY as before', () => {
  it('builds the same socket: the primitive receives the validated radius, depth and axis', async () => {
    const spy: CanonicalMesh[] = [],
      base = await createManifoldBooleanBackend(binary);
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, token) => {
          if (kind === 'difference') spy.push(b);
          return base.operate(kind, a, b, token);
        },
      },
      thick(),
      { plane: UP, connector: pin(1, 4, 6) },
      new CancellationSource().token,
    );
    expect(result.connector.kind).toBe('pin');
    const [socket] = spy;
    if (!socket) throw new Error('no socket primitive');
    // measure the primitive that was actually cut: radius about the axis and axial extent (the axis is -z for male A)
    let radius = 0,
      lowest = Infinity;
    for (let i = 0; i < socket.positions.length; i += 3) {
      radius = Math.max(radius, Math.hypot(socket.positions[i] ?? 0, socket.positions[i + 1] ?? 0));
      lowest = Math.min(lowest, socket.positions[i + 2] ?? 0);
    }
    expect(radius).toBeCloseTo(2.2, 5);
    expect(lowest).toBeCloseTo(-6, 5);
    // and the validator was given those same numbers: a breach reports them
    const refused = await observe(thinBack(), pin(1, 4, 6));
    expect(details(refused.error).socketRadius).toBeCloseTo(2.2, 12);
    expect(details(refused.error).socketDepth).toBe(6);
  });
});

describe('the whole plan is judged before any socket is cut', () => {
  it('refuses a two-pin plan when only the second socket breaks through, with no Boolean at all', async () => {
    const ok = await observe(thick(), pin(2, 4, 6));
    expect(ok.result?.placements).toHaveLength(2);
    const { error, booleans, result } = await observe(await cavityUnderSecond(), pin(2, 4, 6));
    expect(result).toBeUndefined();
    expect(details(error).code).toBe('CONNECTOR_SOCKET_BREAKTHROUGH');
    expect(details(error).pairId).toBe('pin-2');
    expect(details(error).invalidPairs).toBe(1);
    expect(details(error).checkedPairs).toBe(2);
    // pin-1 was valid on its own, and not one Boolean ran for it
    expect(booleans).toEqual([]);
    // shallower, the very same plan is accepted: the plan was refused for the depth, not for the site
    expect(
      (await observe(await cavityUnderSecond(), pin(2, 4, 3))).result?.placements,
    ).toHaveLength(2);
  });
});

describe('the verdict does not depend on the frame', () => {
  const shift = [100, -50, 30] as const;
  it('is the same after an exact turn and a shift, an oblique cut, and a uniform scale of the solid', async () => {
    const turned = { origin: shift, normal: [0, -1, 0] } as const satisfies SplitPlane,
      oblique = { origin: [0, 0, 0], normal: [0.6, 0, 0.8] } as const satisfies SplitPlane;
    for (const [make, connector, holds] of [
      [thinBack, pin(1, 4, 6), false],
      [thick, pin(1, 4, 6), true],
      [thinBack, pin(1, 4, 2), true],
    ] as const) {
      const base = make();
      for (const [mesh, plane] of [
        [moved(base, { turnX: true, shift }), turned],
        [moved(base, { sinCosY: true }), oblique],
      ] as const) {
        const observed = await observe(mesh, connector, plane);
        expect(refusedAxially(observed)).toBe(!holds);
        expect(observed.booleans.length).toBe(holds ? 2 : 0);
      }
    }
    // the oblique slope: a socket whose centre line is fine and whose edge is not
    const slopedOblique = await observe(
      moved(await sloped(), { sinCosY: true }),
      pin(1, 4, 6),
      oblique,
    );
    expect(refusedAxially(slopedOblique)).toBe(true);
    // uniform scale of the SOLID, connector sizes unchanged: the back wall is 6 (touching the socket end) at x2 and 9 at x3
    expect(refusedAxially(await observe(moved(thinBack(), { scale: 2 }), pin(1, 4, 6)))).toBe(true);
    expect(refusedAxially(await observe(moved(thinBack(), { scale: 3 }), pin(1, 4, 6)))).toBe(
      false,
    );
    expect(await referenceHolds(moved(thinBack(), { scale: 3 }), PIN_A(6))).toBe(true);
    expect(await referenceHolds(moved(thinBack(), { scale: 2 }), PIN_A(6))).toBe(false);
  });
  it('is the same when the triangles of the input come in another order', async () => {
    for (const [make, expected] of [
      [thinBack, true],
      [thick, false],
    ] as const) {
      const mesh = make(),
        count = mesh.indices.length / 3,
        indices = createIndexArray(mesh.indices.length);
      for (let f = 0; f < count; f++) {
        const from = (f * 5 + 3) % count;
        indices.set(mesh.indices.subarray(from * 3, from * 3 + 3), f * 3);
      }
      expect(refusedAxially(await observe({ ...mesh, indices }, pin(1, 4, 6)))).toBe(expected);
    }
  });
});

describe('precedence and neighbours', () => {
  it('an out-of-range dimension, a site that does not fit, and a footprint off the interface all still come first', async () => {
    expect(isAppError((await observe(thinBack(), pin(1, 0.001, 6))).error)).toBe(true);
    expect((await observe(thinBack(), pin(1, 0.001, 6))).error).toMatchObject({
      message: 'Pin diameter is outside the supported range.',
    });
    expect(details((await observe(thinBack(), pin(1, 1000, 6))).error).code).toBe(
      'CONNECTOR_TOO_CLOSE_TO_EDGE',
    );
    // a plan that fails BOTH Slice 2B and Slice 2C reports the footprint, which is checked first
    const ledge = await boolean('union', boxAt(60, 60, 10, 0, 0, -5), boxAt(20, 20, 10, 8, 0, 5)),
      both = await observe(ledge, pin(1, 6, 30), { origin: [0, 0, 0], normal: [0, 0, -1] });
    expect(details(both.error).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    expect(both.booleans).toEqual([]);
  });
  it('a ledge of the source coplanar with the cut is a boundary of the receiving piece, and is not part of the entry', async () => {
    // normal down: the ledge faces belong to piece A. Male B makes A the RECEIVING piece, so the ledge is in the piece examined.
    const ledge = await boolean('union', boxAt(60, 60, 10, 0, 0, -5), boxAt(20, 20, 10, 0, 0, 5)),
      down: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, -1] },
      plain = await observe(ledge, { kind: 'none' }, down),
      clip = plain.result?.closedPlaneClip;
    if (!plain.result || !clip) throw new Error('expected a clip');
    // the ledge exists in the receiving piece: source faces (provenance >= 0) lying in the cut plane
    let ledgeFaces = 0;
    for (let f = 0; f < clip.pieceA.indices.length / 3; f++) {
      const onPlane = [0, 1, 2].every(
        (k) =>
          Math.abs(clip.pieceA.positions[(clip.pieceA.indices[f * 3 + k] ?? 0) * 3 + 2] ?? 1) <
          1e-6,
      );
      if (onPlane && (clip.provenanceA[f] ?? -1) >= 0) ledgeFaces++;
    }
    expect(ledgeFaces).toBeGreaterThan(0);
    // a socket on the 20 x 20 cap, well inside it, is not near the ledge: accepted. The same ledge in a plate with no room is not the entry.
    const accepted = await observe(ledge, pin(1, 4, 4, 'B'), down);
    expect(accepted.result?.connector.kind).toBe('pin');
    expect(accepted.result?.closedPlaneClip?.interface.area).toBe(400);
    // and the receiving piece's cap faces are exactly the ones the kernel marked -1, the LAST capFaces faces of that piece
    const marked = Array.from(clip.provenanceA).filter((v) => v === -1).length;
    expect(marked).toBe(clip.interface.capFaces);
    expect(
      Array.from(clip.provenanceA)
        .slice(-clip.interface.capFaces)
        .every((v) => v === -1),
    ).toBe(true);
    expect(Array.from(clip.provenanceB).filter((v) => v === -1).length).toBe(
      clip.interface.capFaces,
    );
  });
  it('an open surface keeps its refusal', async () => {
    const closed = boxAt(20, 20, 20),
      kept = Array.from(closed.indices).filter((_, at) => at < 24 || at >= 30),
      indices = createIndexArray(kept.length);
    indices.set(kept);
    expect(details((await observe({ ...closed, indices }, pin(1, 4, 6))).error).code).toBe(
      'OPEN_SPLIT_CONNECTOR_UNSUPPORTED',
    );
  });
});

describe('an automatic connector goes through the same check', () => {
  it('is reported unavailable, with the typed reason and no Boolean, when a socket would break through', async () => {
    // a void under the socket but between the automatic planner's sample rays, so its own tests do not see it
    const mesh = await boolean('difference', thick(), boxAt(0.8, 0.8, 3, 1.2, 0.9, -5)),
      observed = await observe(mesh, { kind: 'automatic', unit: 'millimeter' });
    expect(observed.result?.connector).toEqual({ kind: 'none' });
    expect(observed.result?.automaticConnector).toBe('unavailable');
    expect(observed.result?.automaticConnectorDiagnostics?.reason).toBe('SOCKET_BREAKTHROUGH');
    expect(observed.booleans).toEqual([]);
    // and a solid with material throughout still gets its connector
    expect(
      (await observe(thick(), { kind: 'automatic', unit: 'millimeter' })).result
        ?.automaticConnector,
    ).toBe('applied');
  });
});

describe('ownership and boundaries (source scans)', () => {
  const sourceDir = join('packages', 'geometry-runtime', 'src');
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = (name: string): string => strip(readFileSync(join(sourceDir, name), 'utf8'));
  const sources = readdirSync(sourceDir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  it('has ONE axial validator and ONE call site, shared by the manual and the automatic path', () => {
    expect(
      sources.filter(
        (name) => /\bvalidateSocketDepth\(/.test(code(name)) && name !== 'connector-axial.ts',
      ),
    ).toEqual(['split-connectors.ts']);
    expect(code('split-connectors.ts').match(/\bvalidateSocketDepth\(/g)).toHaveLength(1);
    expect(sources.filter((name) => /function triangleBreachesSocket\b/.test(code(name)))).toEqual([
      'connector-axial.ts',
    ]);
  });
  it('derives the socket once: the radius, depth and axis the primitive gets are the ones validated', () => {
    const engine = code('split-connectors.ts');
    expect(engine.match(/\broundSocketRadius\(/g)).toHaveLength(2); // the definition and the single use
    expect(engine).toMatch(/const socketVolume = \{/);
    expect(engine).toMatch(/socketVolume\.radius/);
    expect(engine).toMatch(/const axis = socketVolume\.axis/);
  });
  it('uses the shared broadphase only through its package subpath, and only as a broadphase', () => {
    const text = code('connector-axial.ts'),
      imports = [...text.matchAll(/^import(?: type)?[^;]*?from '([^']+)';/gms)].map((m) => m[1]);
    expect([...imports].sort()).toEqual([
      './connector-plan',
      './split-connectors',
      '@cadfixer/mesh-core',
      '@cadfixer/mesh-core/spatial',
      '@cadfixer/shared',
    ]);
    expect(text).toMatch(/FaceBvh\.build\(/);
    expect(text.match(/FaceBvh\.build\(/g)).toHaveLength(1);
    expect(text).toMatch(/\.queryBox\(/);
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
    ])
      expect(text).not.toContain(forbidden);
  });
  it('is the ONLY geometry-runtime module that reaches the shared broadphase', () => {
    expect(sources.filter((name) => code(name).includes('@cadfixer/mesh-core/spatial'))).toEqual([
      'connector-axial.ts',
    ]);
  });
  it('samples nothing: no trigonometry and no angular loop in the validator', () => {
    const text = code('connector-axial.ts');
    expect(text).not.toMatch(/Math\.(sin|cos|atan2?|random)\(/);
    expect(text).not.toMatch(/\bsample/i);
  });
  it('is not part of the package index, so the page bundle cannot reach it', () => {
    expect(code('index.ts')).not.toMatch(/connector-axial|validateSocketDepth/);
  });
});
