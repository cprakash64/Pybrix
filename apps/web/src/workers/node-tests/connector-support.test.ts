import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyPlacement,
  createIndexArray,
  createPositionArray,
  singlePartDocument,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { FaceBvh } from '@cadfixer/mesh-core/spatial';
import { CancellationSource, isAppError } from '@cadfixer/shared';
import {
  GeometryEditStore,
  RepairHistoryStore,
  ResidentDocumentStore,
  SplitCandidateStore,
  splitWithConnectors,
  type SplitPlane,
  type SplitRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { connectorSupportMargin } from '../../../../../packages/geometry-runtime/src/connector-policy';
import { validateSocketDepth } from '../../../../../packages/geometry-runtime/src/connector-axial';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/** The scale the worker hands the engine: a similarity's, or NaN for a placement that has none. */
const physicalScaleOf = (transform: readonly number[]): number => {
  const placement = classifyPlacement(transform);
  return placement.kind === 'SIMILARITY' ? placement.scale : Number.NaN;
};

/*
 * Release 2, Slice 2D — `support-v1` on the REAL kernel and the REAL Manifold backend.
 *
 * Every adversarial verdict of the production validator is held to an INDEPENDENT reference that shares no code with it: (K) the
 * Boolean kernel intersects the piece with a prism of the support envelope and the envelope is wholly material exactly when no
 * volume is lost; (B) a brute-force pass over EVERY non-entry face with a re-implemented exact predicate (no tree, no box test, no
 * shared helper). The margin is written out in this file, not imported.
 */

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
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
const col = (sx: number, sy: number, z0: number, z1: number, cx = 0, cy = 0): CanonicalMesh =>
  boxAt(sx, sy, z1 - z0, cx, cy, (z0 + z1) / 2);
async function boolean(
  kind: 'union' | 'difference' | 'intersection',
  a: CanonicalMesh,
  b: CanonicalMesh,
): Promise<CanonicalMesh> {
  const backend = await createManifoldBooleanBackend(binary);
  return backend.operate(kind, a, b, new CancellationSource().token);
}

// ------------------------------------------------------------------------------------------------------------ fixtures
// All are closed solids cut at z = 0, so the interface is the full 40 x 40 (or 60 x 60) section and the single pin goes at the origin.
const slab = (z0: number, z1: number): CanonicalMesh => col(40, 40, z0, z1);
/** A flank notch below the cut leaving a wall of `wall` beside the socket (radius 2.2); `both` notches the other flank too. */
const wallBeside = async (wall: number, both = false): Promise<CanonicalMesh> => {
  let m = await boolean('difference', slab(-30, 30), col(30, 60, -31, -3, 2.2 + wall + 15, 0));
  if (both) m = await boolean('difference', m, col(30, 60, -31, -3, -(2.2 + wall + 15), 0));
  return m;
};
const cavityBeside = (wall: number): Promise<CanonicalMesh> =>
  boolean('difference', slab(-30, 30), col(4, 6, -12, -2, 2.2 + wall + 2, 0));
/** The male piece (above the cut) is a flange `thickness` thick: nothing behind the pin root but that. */
const flange = (thickness: number): CanonicalMesh => slab(-30, thickness);
/** Above the cut: a shoulder 0.5 thick, then a neck 4.8 wide (0.4 beyond the pin's edge) rising from it. */
const neck = (): Promise<CanonicalMesh> =>
  boolean('union', col(40, 40, -30, 0.5), col(4.8, 4.8, 0.5, 30));
/** The male side loses its +x flank from z = 0.3 up, leaving 0.3 of wall beside the pin root on ONE side. */
const oneSidedMale = (): Promise<CanonicalMesh> =>
  boolean('difference', slab(-30, 30), col(30, 60, 0.3, 31, 2 + 0.3 + 15, 0));
/** The male side is a column 6.8 wide above the cut: the wall is 1.4 beyond the pin edge, outside the 0.7 margin. */
const farWallMale = (): Promise<CanonicalMesh> =>
  boolean('union', slab(-30, 0), col(6.8, 6.8, 0, 30));

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
  scale = 1,
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
      scale,
    );
    return { result, stages, booleans };
  } catch (error) {
    return { error, stages, booleans };
  }
}
type PinRequest = Extract<SplitRequest['connector'], { kind: 'pin' }>;
const pin = (
  count: 1 | 2 | 3 | 4,
  diameter: number,
  depth: number,
  maleSide: 'A' | 'B' = 'A',
  clearance = 0.2,
): PinRequest => ({ kind: 'pin', count, diameter, depth, clearance, maleSide });
const details = (error: unknown): Record<string, unknown> =>
  isAppError(error) ? error.details : {};
const code = (o: Observed): unknown => details(o.error).code;
const copy = (mesh: CanonicalMesh): string =>
  `${Array.from(mesh.positions).join(',')}|${Array.from(mesh.indices).join(',')}`;
const SUPPORT_FEMALE = 'CONNECTOR_SOCKET_SUPPORT_INSUFFICIENT';
const SUPPORT_MALE = 'CONNECTOR_PIN_ROOT_SUPPORT_INSUFFICIENT';
const FOUR_STAGES = ['preparing-cut', 'intersecting', 'building-cut-surfaces', 'adding-connectors'];

// ----------------------------------------------------------------------------------- the independent reference
type V3 = readonly [number, number, number];
const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const cross = (a: readonly number[], b: readonly number[]): V3 => [
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
    length = Math.hypot(...c),
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
/** (B) Does any point of the triangle lie in { -tol <= axial <= depth + tol, radial < R - tol }? Re-implemented, shares nothing. */
function envelopeHit(
  corners: readonly V3[],
  centre: V3,
  axis: V3,
  radius: number,
  depth: number,
  tol: number,
): boolean {
  const reference = Math.abs(axis[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0],
    c = cross(axis, reference),
    ul = Math.hypot(...c),
    u = c.map((x) => x / ul),
    v = cross(axis, u);
  const clip = (poly: V3[], keep: (z: number) => number): V3[] => {
    const out: V3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length];
      if (a === undefined || b === undefined) continue;
      const da = keep(a[2]),
        db = keep(b[2]);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
      }
    }
    return out;
  };
  let poly: V3[] = corners.map((p) => {
    const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    return [dot(d, u), dot(d, v), dot(d, axis)];
  });
  poly = clip(poly, (z) => z + tol);
  if (poly.length === 0) return false;
  poly = clip(poly, (z) => depth + tol - z);
  if (poly.length === 0) return false;
  if (poly.length >= 3) {
    let pos = 0,
      neg = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length];
      if (a === undefined || b === undefined) continue;
      const cr = a[0] * b[1] - a[1] * b[0];
      if (cr > 0) pos++;
      else if (cr < 0) neg++;
    }
    if (pos === 0 || neg === 0) return true;
  }
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    if (a === undefined || b === undefined) continue;
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / l2));
    best = Math.min(best, Math.hypot(a[0] + t * dx, a[1] + t * dy));
  }
  return best < radius - tol;
}
function bruteForceContained(
  piece: CanonicalMesh,
  provenance: Int32Array,
  centre: V3,
  axis: V3,
  radius: number,
  depth: number,
  tol: number,
): boolean {
  for (let f = 0; f < piece.indices.length / 3; f++) {
    if (provenance[f] === -1) continue;
    const corner = (k: number): V3 => {
      const i = (piece.indices[f * 3 + k] ?? 0) * 3;
      return [piece.positions[i] ?? 0, piece.positions[i + 1] ?? 0, piece.positions[i + 2] ?? 0];
    };
    if (envelopeHit([corner(0), corner(1), corner(2)], centre, axis, radius, depth, tol))
      return false;
  }
  return true;
}
interface Reference {
  readonly femaleBrute: boolean;
  readonly maleBrute: boolean;
  readonly femaleKernel: boolean;
  readonly maleKernel: boolean;
}
/**
 * The reference for ONE pin at `site` (a count-1 request): is the grown socket wholly in the female piece, and the root envelope in
 * the male piece? The pieces come from a plain split, so nothing of the connector path is involved.
 */
async function reference(
  mesh: CanonicalMesh,
  connector: Extract<SplitRequest['connector'], { kind: 'pin' }>,
  site: V3 = [0, 0, 0],
  plane: SplitPlane = Z,
): Promise<Reference> {
  const none = await observe(mesh, { kind: 'none' }, plane),
    plain = none.result;
  if (plain?.closedPlaneClip === undefined) throw new Error('the reference needs the plain split');
  const clip = plain.closedPlaneClip,
    tol = plain.metrics.tolerance,
    n = clip.interface.frame.N,
    aF: V3 = connector.maleSide === 'A' ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]],
    aM: V3 = [-aF[0], -aF[1], -aF[2]],
    female = connector.maleSide === 'A' ? plain.pieceB : plain.pieceA,
    fProv = connector.maleSide === 'A' ? clip.provenanceB : clip.provenanceA,
    male = connector.maleSide === 'A' ? plain.pieceA : plain.pieceB,
    mProv = connector.maleSide === 'A' ? clip.provenanceA : clip.provenanceB,
    rPin = connector.diameter / 2,
    rho = rPin + connector.clearance,
    m = Math.max(8 * tol, 0.35 * rPin);
  const contained = async (
    piece: CanonicalMesh,
    axis: V3,
    radius: number,
    depth: number,
  ): Promise<boolean> => {
    const cylinder = prism(site, axis, radius - tol, 0, depth + tol),
      inside = await boolean('intersection', piece, cylinder);
    return Math.abs(volumeOf(inside) - volumeOf(cylinder)) <= 1e-7 * volumeOf(cylinder);
  };
  return {
    femaleBrute: bruteForceContained(female, fProv, site, aF, rho + m, connector.depth + m, tol),
    maleBrute: bruteForceContained(male, mProv, site, aM, rPin + m, m, tol),
    femaleKernel: await contained(female, aF, rho + m, connector.depth + m),
    maleKernel: await contained(male, aM, rPin + m, m),
  };
}
/** The production verdict, and both independent references, must say the same about the same plan. */
async function agree(
  mesh: CanonicalMesh,
  connector: PinRequest,
  expected: 'accepted' | typeof SUPPORT_FEMALE | typeof SUPPORT_MALE,
): Promise<Observed> {
  const ref = await reference(mesh, connector),
    observed = await observe(mesh, connector);
  expect(ref.femaleBrute).toBe(ref.femaleKernel);
  expect(ref.maleBrute).toBe(ref.maleKernel);
  if (expected === 'accepted') {
    expect(ref.femaleBrute && ref.maleBrute).toBe(true);
    expect(observed.result?.connector.kind).toBe('pin');
    expect(observed.booleans.length).toBe(2);
  } else {
    expect(code(observed)).toBe(expected);
    expect(observed.result).toBeUndefined();
    expect(observed.booleans).toEqual([]);
    expect(ref.femaleBrute && ref.maleBrute).toBe(false);
    const femaleFailures = details(observed.error).femaleFailures,
      maleFailures = details(observed.error).maleFailures;
    expect(femaleFailures === 0).toBe(ref.femaleBrute);
    expect(maleFailures === 0).toBe(ref.maleBrute);
  }
  return observed;
}

describe('the margin the validator is given is the policy margin for this pin and this cut', () => {
  it('equals max(8 tol, 0.35 r_pin), which is also what the reference writes out', async () => {
    const none = await observe(slab(-30, 30), { kind: 'none' }),
      tol = none.result?.metrics.tolerance ?? NaN;
    expect(connectorSupportMargin(2, tol)).toBe(Math.max(8 * tol, 0.35 * 2));
    expect(connectorSupportMargin(2, tol)).toBe(0.7);
  });
});

describe('FEMALE support on the real kernel (every verdict held to the independent reference)', () => {
  it('F1: generous lateral and far-end support is accepted, with the two connector Booleans and nothing else', async () => {
    await agree(slab(-30, 30), pin(1, 4, 6), 'accepted');
  });
  it('F2: a socket that passes Slice 2B and 2C but leaves a near-zero side wall is refused before any Boolean', async () => {
    const mesh = await wallBeside(0.05),
      before = copy(mesh),
      observed = await agree(mesh, pin(1, 4, 6), SUPPORT_FEMALE);
    expect(details(observed.error).refusal).toBe('SOCKET_SUPPORT_INSUFFICIENT');
    expect(details(observed.error).policy).toBe('support-v1');
    expect(details(observed.error).dimension).toBe('LATERAL');
    expect(details(observed.error).role).toBe('FEMALE');
    expect(isAppError(observed.error) && observed.error.message).toMatch(
      /^Not enough material around the socket/,
    );
    expect(observed.stages).toEqual(FOUR_STAGES);
    expect(copy(mesh)).toBe(before);
  });
  it('F3: a thin wall on one side only is refused, and thin on both sides is refused the same way', async () => {
    await agree(await wallBeside(0.3), pin(1, 4, 6), SUPPORT_FEMALE);
    await agree(await wallBeside(0.3, true), pin(1, 4, 6), SUPPORT_FEMALE);
  });
  it('F3b: the wall at exactly the margin (0.7) passes, a hair under it is refused', async () => {
    await agree(await wallBeside(0.7), pin(1, 4, 6), 'accepted');
    await agree(await wallBeside(0.65), pin(1, 4, 6), SUPPORT_FEMALE);
  });
  it('F4: an internal cavity within the support envelope is refused', async () => {
    await agree(await cavityBeside(0.3), pin(1, 4, 6), SUPPORT_FEMALE);
  });
  it('F5: a cavity near the socket but outside the support envelope is accepted', async () => {
    await agree(await cavityBeside(1.3), pin(1, 4, 6), 'accepted');
    await agree(await cavityBeside(2), pin(1, 4, 6), 'accepted');
  });
  it('F6: enough side wall but too little material beyond the far end is refused as the FAR END', async () => {
    // the plate is 40 x 40, z -3..6: piece B is 3 thick; a 2.5-deep socket leaves 0.5 behind it
    const mesh = boxAt(40, 40, 9, 0, 0, 1.5),
      observed = await agree(mesh, pin(1, 4, 2.5), SUPPORT_FEMALE);
    expect(details(observed.error).dimension).toBe('FAR_END');
    await agree(mesh, pin(1, 4, 2), 'accepted'); // 1.0 behind
  });
  it('F7: a boundary only in the corner (beside AND beyond the far end) is refused, and says so', async () => {
    // a void whose near corner is 0.5 out from the socket wall and 0.5 beyond a 4-deep socket's end
    const mesh = await boolean('difference', slab(-30, 30), col(4, 4, -9, -4.5, 2.2 + 0.5 + 2, 0)),
      observed = await observe(mesh, pin(1, 4, 4));
    expect(code(observed)).toBe(SUPPORT_FEMALE);
    expect(details(observed.error).dimension).toBe('CORNER');
    expect(observed.booleans).toEqual([]);
  });
});

describe('MALE root support on the real kernel (every verdict held to the independent reference)', () => {
  it('M1: broad support is accepted', async () => {
    await agree(slab(-30, 30), pin(1, 4, 6), 'accepted');
  });
  it('M2: a shoulder 0.5 deep and then a narrow neck right beside the pin root is refused', async () => {
    const observed = await agree(await neck(), pin(1, 4, 6), SUPPORT_MALE);
    expect(details(observed.error).role).toBe('MALE');
    expect(details(observed.error).dimension).toBeUndefined();
    expect(isAppError(observed.error) && observed.error.message).toMatch(
      /^Not enough material around the pin base/,
    );
  });
  it('M3: a thin flange behind the root is refused; a flange of 2 is accepted', async () => {
    await agree(flange(0.5), pin(1, 4, 6), SUPPORT_MALE);
    await agree(flange(2), pin(1, 4, 6), 'accepted');
  });
  it('M4: thin support on one side of the root only is refused', async () => {
    await agree(await oneSidedMale(), pin(1, 4, 6), SUPPORT_MALE);
  });
  it('M5: a boundary near the root but outside the required envelope is accepted', async () => {
    await agree(await farWallMale(), pin(1, 4, 6), 'accepted');
  });
  it('the mirrored cut (male B) reads the other piece for each side', async () => {
    // slab(-0.5, 30): piece B (below) is the 0.5 flange; male B puts the pin on it
    const mesh = slab(-0.5, 30);
    const observed = await observe(mesh, pin(1, 4, 6, 'B'));
    expect(code(observed)).toBe(SUPPORT_MALE);
    expect(observed.booleans).toEqual([]);
  });
});

describe('FEMALE and MALE support are independent invariants', () => {
  it('valid female / invalid male, invalid female / valid male, both valid, both invalid', async () => {
    const both = async (): Promise<CanonicalMesh> =>
      boolean('difference', flange(0.5), col(30, 60, -31, -3, 2.2 + 0.3 + 15, 0));
    const verdicts = await Promise.all(
      [
        ['both valid', slab(-30, 30)],
        ['valid female, invalid male', flange(0.5)],
        ['invalid female, valid male', await wallBeside(0.3)],
        ['both invalid', await both()],
      ].map(async ([name, mesh]) => {
        const o = await observe(mesh as CanonicalMesh, pin(1, 4, 6));
        return [
          name,
          o.result ? 'ok' : String(code(o)),
          details(o.error).femaleFailures ?? 0,
          details(o.error).maleFailures ?? 0,
        ];
      }),
    );
    expect(verdicts).toEqual([
      ['both valid', 'ok', 0, 0],
      ['valid female, invalid male', SUPPORT_MALE, 0, 1],
      ['invalid female, valid male', SUPPORT_FEMALE, 1, 0],
      ['both invalid', SUPPORT_FEMALE, 1, 1],
    ]);
  });
});

describe('a plan is validated whole, before any Boolean', () => {
  it('four pins, three supported and one not: refused with nothing built; the same four on a clean solid are applied', async () => {
    const ample = boxAt(60, 60, 60),
      accepted = await observe(ample, pin(4, 3, 6));
    expect(accepted.result?.placements).toHaveLength(4);
    expect(accepted.booleans).toHaveLength(8);
    const sites = accepted.result?.connectorPlan?.pairs.map((p) => p.site.local) ?? [];
    expect(sites).toHaveLength(4);
    const last = sites[3];
    if (!last) throw new Error('no fourth site');
    // a void under the fourth site only, whose top is 6.4 below the cut: the 6-deep socket passes Slice 2C and has 0.4 behind it
    const mesh = await boolean('difference', ample, col(6, 6, -9, -6.4, last[0], last[1])),
      observed = await observe(mesh, pin(4, 3, 6));
    expect(code(observed)).toBe(SUPPORT_FEMALE);
    expect(details(observed.error).pairId).toBe('pin-4');
    expect(details(observed.error).invalidPairs).toBe(1);
    expect(details(observed.error).checkedPairs).toBe(4);
    expect(details(observed.error).dimension).toBe('FAR_END');
    expect(observed.booleans).toEqual([]);
    expect(observed.result).toBeUndefined();
  });
});

describe('S145 and S148: the two Slice 2C closest-passing fixtures, judged by exact geometry', () => {
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
  const cavityNear = (): Promise<CanonicalMesh> =>
    boolean('difference', slab(-30, 30), boxAt(2.2, 2.2, 2, 2.9, 2.9, -4));
  it('S145 (sloped back, socket 1.2 wide): it passes the depth check; the support envelope DOES enter the slope; two independent references agree', async () => {
    const mesh = await sloped(),
      connector = pin(1, 2, 6),
      none = await observe(mesh, { kind: 'none' }),
      plainResult = none.result;
    if (plainResult?.closedPlaneClip === undefined) throw new Error('no plain split');
    const clip = plainResult.closedPlaneClip;
    expect(
      validateSocketDepth(
        { mesh: plainResult.pieceB, provenance: clip.provenanceB, closed: true },
        [{ pairId: 'pin-1', center: [0, 0, 0], axis: [0, 0, -1], radius: 1.2, depth: 6 }],
        plainResult.metrics.tolerance,
        new CancellationSource().token,
      ).ok,
    ).toBe(true);
    const ref = await reference(mesh, connector);
    expect(ref.femaleBrute).toBe(false);
    expect(ref.femaleKernel).toBe(false);
    expect(ref.maleBrute && ref.maleKernel).toBe(true);
    const observed = await observe(mesh, connector);
    expect(code(observed)).toBe(SUPPORT_FEMALE);
    expect(details(observed.error).dimension).toBe('CORNER');
    expect(observed.booleans).toEqual([]);
  });
  it('S148 (a void whose nearest corner is 0.346 from the socket wall): refused as LATERAL, as both references say', async () => {
    const mesh = await cavityNear(),
      ref = await reference(mesh, pin(1, 4, 6));
    expect(ref.femaleBrute).toBe(false);
    expect(ref.femaleKernel).toBe(false);
    const observed = await observe(mesh, pin(1, 4, 6));
    expect(code(observed)).toBe(SUPPORT_FEMALE);
    expect(details(observed.error).dimension).toBe('LATERAL');
  });
});

describe('the same relationship in another frame is the same verdict', () => {
  /** A 90-degree turn about X, an oblique turn about Y (sin 0.6, cos 0.8), an offset, and a uniform scale of the SOLID. */
  function moved(
    mesh: CanonicalMesh,
    o: { turnX?: boolean; oblique?: boolean; shift?: V3; scale?: number },
  ): CanonicalMesh {
    const positions = createPositionArray(mesh.positions.length),
      k = o.scale ?? 1,
      s = o.shift ?? [0, 0, 0];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      let x = (mesh.positions[i] ?? 0) * k,
        y = (mesh.positions[i + 1] ?? 0) * k,
        z = (mesh.positions[i + 2] ?? 0) * k;
      if (o.turnX) [y, z] = [-z, y];
      if (o.oblique) [x, z] = [x * 0.8 + z * 0.6, -x * 0.6 + z * 0.8];
      positions[i] = x + s[0];
      positions[i + 1] = y + s[1];
      positions[i + 2] = z + s[2];
    }
    return { ...mesh, positions };
  }
  const frames: readonly [string, Parameters<typeof moved>[1], SplitPlane][] = [
    [
      'rotated 90 degrees and translated',
      { turnX: true, shift: [100, -50, 30] },
      { origin: [100, -50, 30], normal: [0, -1, 0] },
    ],
    ['oblique cut', { oblique: true }, { origin: [0, 0, 0], normal: [0.6, 0, 0.8] }],
    [
      'translated only',
      { shift: [1000, -500, 300] },
      { origin: [1000, -500, 300], normal: [0, 0, 1] },
    ],
  ];
  for (const [frame, transform, plane] of frames)
    it(`${frame}: wall 0.3 refused (female), flange 0.5 refused (male), thick accepted`, async () => {
      const wall = await observe(moved(await wallBeside(0.3), transform), pin(1, 4, 6), plane);
      expect(code(wall)).toBe(SUPPORT_FEMALE);
      expect(wall.booleans).toEqual([]);
      const thin = await observe(moved(flange(0.5), transform), pin(1, 4, 6), plane);
      expect(code(thin)).toBe(SUPPORT_MALE);
      expect(thin.booleans).toEqual([]);
      const thickOk = await observe(moved(slab(-30, 30), transform), pin(1, 4, 6), plane);
      expect(thickOk.result?.connector.kind).toBe('pin');
      expect(thickOk.booleans).toHaveLength(2);
    });
  it('uniform scale of the model AND the connector (0.5, 2, 4) keeps every classification', async () => {
    for (const k of [0.5, 2, 4]) {
      const connector = pin(1, 4 * k, 6 * k, 'A', 0.2 * k);
      const wall = await observe(moved(await wallBeside(0.3), { scale: k }), connector);
      expect(code(wall)).toBe(SUPPORT_FEMALE);
      const thin = await observe(moved(flange(0.5), { scale: k }), connector);
      expect(code(thin)).toBe(SUPPORT_MALE);
      const ok = await observe(moved(slab(-30, 30), { scale: k }), connector);
      expect(ok.result?.connector.kind).toBe('pin');
    }
  });
});

describe('UNSUPPORTED_TRANSFORM: a placement that is not a similarity is refused, not reinterpreted', () => {
  const linear = (...v: number[]): number[] => [...v, 0, 0, 0];
  const placements: readonly [string, number[], boolean][] = [
    ['identity', linear(1, 0, 0, 0, 1, 0, 0, 0, 1), true],
    ['translation', [1, 0, 0, 0, 1, 0, 0, 0, 1, 40, -20, 5], true],
    ['rotation', linear(1, 0, 0, 0, 0, 1, 0, -1, 0), true],
    ['uniform scale 2', linear(2, 0, 0, 0, 2, 0, 0, 0, 2), true],
    ['reflection', linear(-1, 0, 0, 0, 1, 0, 0, 0, 1), true],
    ['non-uniform scale', linear(2, 0, 0, 0, 1, 0, 0, 0, 1), false],
    ['shear', linear(1, 0, 0, 0.5, 1, 0, 0, 0, 1), false],
    ['zero scale', linear(0, 0, 0, 0, 0, 0, 0, 0, 0), false],
  ];
  for (const [name, transform, allowed] of placements)
    it(`${name}: ${allowed ? 'a connector is added' : 'refused, nothing built, input untouched'}`, async () => {
      const mesh = slab(-30, 30),
        before = copy(mesh),
        observed = await observe(mesh, pin(1, 4, 6), Z, physicalScaleOf(transform));
      if (allowed) {
        expect(observed.result?.connector.kind).toBe('pin');
        expect(observed.booleans).toHaveLength(2);
      } else {
        expect(observed.result).toBeUndefined();
        expect(code(observed)).toBe('CONNECTOR_UNSUPPORTED_TRANSFORM');
        expect(details(observed.error).refusal).toBe('UNSUPPORTED_TRANSFORM');
        expect(observed.booleans).toEqual([]);
        // refused before any work: the cut was not even started
        expect(observed.stages).toEqual(['preparing-cut']);
      }
      expect(copy(mesh)).toBe(before);
    });
  it('the automatic path refuses the same placements, as a typed unavailable connector and no Boolean', async () => {
    const observed = await observe(
      boxAt(30, 30, 30),
      { kind: 'automatic', unit: 'millimeter' },
      Z,
      physicalScaleOf([2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    );
    expect(observed.result?.automaticConnector).toBe('unavailable');
    expect(observed.result?.automaticConnectorDiagnostics?.reason).toBe('UNSUPPORTED_TRANSFORM');
    expect(observed.result?.connector).toEqual({ kind: 'none' });
    expect(observed.booleans).toEqual([]);
  });
  it('a plain cut and an open-surface cut are not refused for their placement: only a connector depends on it', async () => {
    const observed = await observe(slab(-30, 30), { kind: 'none' }, Z, Number.NaN);
    expect(observed.result?.connector.kind).toBe('none');
  });
});

describe('one validator, one female tree, no male tree, and the automatic guard retired', () => {
  it('builds the female FaceBvh exactly once per plan for a manual plan', async () => {
    const spy = vi.spyOn(FaceBvh, 'build');
    try {
      const observed = await observe(slab(-30, 30), pin(2, 4, 6));
      expect(observed.result?.placements).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('builds it exactly once for an automatic plan, and runs no guard intersection: only the union and the difference of each pair', async () => {
    const spy = vi.spyOn(FaceBvh, 'build');
    try {
      const observed = await observe(boxAt(30, 30, 30), { kind: 'automatic', unit: 'millimeter' });
      expect(observed.result?.automaticConnector).toBe('applied');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(observed.booleans).not.toContain('intersection');
      expect(observed.booleans).toHaveLength(2 * (observed.result?.placements.length ?? 0));
    } finally {
      spy.mockRestore();
    }
  });
  it('builds nothing when the plan is refused before the support check, and one tree when it is refused by it', async () => {
    const spy = vi.spyOn(FaceBvh, 'build');
    try {
      const early = await observe(slab(-30, 30), pin(1, 4, 6), Z, Number.NaN);
      expect(code(early)).toBe('CONNECTOR_UNSUPPORTED_TRANSFORM');
      expect(spy).toHaveBeenCalledTimes(0);
      const refused = await observe(await wallBeside(0.3), pin(1, 4, 6));
      expect(code(refused)).toBe(SUPPORT_FEMALE);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a refused support plan leaves the workspace exactly as it was (no mutation, no history, no transaction)', () => {
  /** The handler's own sequence: begin a ticket on the resident part, run the split, fail the ticket when it throws. */
  async function refusedRun(
    mesh: CanonicalMesh,
    connector: PinRequest,
  ): Promise<{
    resident: ResidentDocumentStore;
    history: RepairHistoryStore;
    store: SplitCandidateStore;
    source: ReturnType<ResidentDocumentStore['commit']>;
    error: unknown;
    part: ReturnType<ResidentDocumentStore['resolvePart']>;
  }> {
    const resident = new ResidentDocumentStore(),
      history = new RepairHistoryStore(),
      edits = new GeometryEditStore(resident, history),
      store = new SplitCandidateStore(resident, history, edits),
      source = resident.commit(singlePartDocument(mesh)),
      document = resident.resolve(source);
    if (isAppError(document)) throw document;
    const id = document.parts[0]?.id;
    if (id === undefined) throw new Error('no part');
    const ticket = store.begin(source, id);
    let error: unknown;
    try {
      await splitWithConnectors(
        await createManifoldBooleanBackend(binary),
        mesh,
        { plane: Z, connector },
        new CancellationSource().token,
      );
    } catch (caught) {
      error = caught;
      store.fail(ticket);
    }
    return { resident, history, store, source, error, part: resident.resolvePart(source, id) };
  }
  it('a plan refused for support publishes no candidate, no transaction and no history, and the resident part is the same object at the same revision', async () => {
    const mesh = await wallBeside(0.3),
      { resident, history, store, source, error, part } = await refusedRun(mesh, pin(1, 4, 6));
    expect(details(error).code).toBe(SUPPORT_FEMALE);
    expect(resident.revisionOf(source.documentId)).toBe(source.revision);
    expect(isAppError(part)).toBe(false);
    if (!isAppError(part)) expect(part.mesh).toBe(mesh);
    expect(store.stats().candidateCount).toBe(0);
    expect(store.commitTransactionStats()).toMatchObject({ pending: 0, receipts: 0 });
    expect(history.undoableFor(source.documentId)).toBeUndefined();
    expect(history.stats()).toEqual(new RepairHistoryStore().stats());
  });
  it('the same holds for a pin root refused for support', async () => {
    const male = await refusedRun(flange(0.5), pin(1, 4, 6));
    expect(details(male.error).code).toBe(SUPPORT_MALE);
    expect(male.resident.revisionOf(male.source.documentId)).toBe(male.source.revision);
    expect(male.store.stats().candidateCount).toBe(0);
    expect(male.history.undoableFor(male.source.documentId)).toBeUndefined();
  });
});
