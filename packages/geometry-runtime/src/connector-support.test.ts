import { describe, expect, it, vi } from 'vitest';
import { CancellationSource, isAppError, type CancellationToken } from '@cadfixer/shared';
import { FaceBvh } from '@cadfixer/mesh-core/spatial';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { ConnectorRefusal } from './connector-plan';
import {
  createReceivingBroadphase,
  ENTRY_CAP_PROVENANCE,
  validateSocketDepth,
  type ReceivingPiece,
  type SocketSweep,
} from './connector-axial';
import {
  describeSupportFailure,
  SCAN_CHECKPOINT_FACES,
  validateConnectorSupport,
  type SupportValidation,
} from './connector-support';
import { connectorSupportMargin } from './connector-policy';

/*
 * Release 2, Slice 2D — `support-v1`: is there at least as much material around the socket and behind the pin root as Pybrix
 * already requires around a connector at the cut face?
 *
 * The pieces are SYNTHETIC closed solids with explicit entry-cap provenance, so each geometric relationship (a side wall, a back
 * wall, a cavity, a flange, a neighbouring edge) is chosen rather than found. The kernel-backed cases, the independent reference
 * and the oracle are in `apps/web/src/workers/node-tests/connector-support.test.ts`.
 *
 * Geometry. The female piece is a plate whose top (z = 0) is the entry: material z in [-10, 0], sockets point DOWN. The male
 * piece is the plate above it: material z in [0, 10], its entry is the bottom face, and the support envelope points UP.
 */

const TOL = 0.01;
const PIN_RADIUS = 2;
const SOCKET_RADIUS = 2.2; // pin radius + 0.2 clearance
const MARGIN = connectorSupportMargin(PIN_RADIUS, TOL); // max(0.08, 0.7) = 0.7
type P3 = readonly [number, number, number];

const CUBE_FACES: readonly (readonly [number, number, number])[] = [
  [0, 2, 3],
  [0, 3, 1],
  [4, 5, 7],
  [4, 7, 6],
  [0, 1, 5],
  [0, 5, 4],
  [2, 6, 7],
  [2, 7, 3],
  [0, 4, 6],
  [0, 6, 2],
  [1, 3, 7],
  [1, 7, 5],
];
const corners = (lo: P3, hi: P3): P3[] =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((i): P3 => [
    i & 1 ? hi[0] : lo[0],
    i & 2 ? hi[1] : lo[1],
    i & 4 ? hi[2] : lo[2],
  ]);
interface Solid {
  readonly vertices: P3[];
  readonly faces: [number, number, number][];
}
const box = (lo: P3, hi: P3): Solid => ({
  vertices: corners(lo, hi),
  faces: CUBE_FACES.map((f): [number, number, number] => [f[0], f[1], f[2]]),
});
function withCavity(outer: Solid, lo: P3, hi: P3): Solid {
  const offset = outer.vertices.length;
  return {
    vertices: [...outer.vertices, ...corners(lo, hi)],
    faces: [
      ...outer.faces,
      ...CUBE_FACES.map((f): [number, number, number] => [
        f[0] + offset,
        f[2] + offset,
        f[1] + offset,
      ]),
    ],
  };
}
function piece(solid: Solid, entry: readonly number[], closed = true): ReceivingPiece {
  const positions = createPositionArray(solid.vertices.length * 3),
    indices = createIndexArray(solid.faces.length * 3),
    provenance = new Int32Array(solid.faces.length);
  solid.vertices.forEach((v, i) => {
    positions.set(v, i * 3);
  });
  solid.faces.forEach((f, i) => {
    indices.set(f, i * 3);
    provenance[i] = entry.includes(i) ? ENTRY_CAP_PROVENANCE : i;
  });
  const mesh: CanonicalMesh = { positions, indices, metadata: {} };
  return { mesh, provenance, closed };
}
const TOP = [2, 3],
  BOTTOM = [0, 1];
const DOWN: P3 = [0, 0, -1];

/** Female plate, material z in [-10, 0] and x, y in [-10, 10] unless stated. */
const female = (lo: P3 = [-10, -10, -10], hi: P3 = [10, 10, 0]): ReceivingPiece =>
  piece(box(lo, hi), TOP);
/** Male plate, material z in [0, `height`], entry = its bottom face. */
const male = (
  height = 10,
  lo: [number, number] = [-10, -10],
  hi: [number, number] = [10, 10],
): ReceivingPiece => piece(box([lo[0], lo[1], 0], [hi[0], hi[1], height]), BOTTOM);

const socket = (x: number, y: number, depth: number, pairId = 'pin-1'): SocketSweep => ({
  pairId,
  center: [x, y, 0],
  axis: DOWN,
  radius: SOCKET_RADIUS,
  depth,
});
const live = new CancellationSource().token;

interface Case {
  readonly female: ReceivingPiece;
  readonly male: ReceivingPiece;
  readonly sockets: readonly SocketSweep[];
  readonly margin?: number;
  readonly token?: CancellationToken;
}
const run = (c: Case): SupportValidation => {
  const broadphase = createReceivingBroadphase(c.female);
  return validateConnectorSupport({
    female: c.female,
    femaleBroadphase: broadphase,
    male: c.male,
    sockets: c.sockets,
    pinRadius: PIN_RADIUS,
    margin: c.margin ?? MARGIN,
    tolerance: TOL,
    cancellation: c.token ?? live,
  });
};
const failuresOf = (v: SupportValidation): readonly string[] =>
  !v.ok && 'failures' in v ? v.failures.map((f) => `${f.role}:${f.pairId}`) : [];
const dimensionsOf = (v: SupportValidation): readonly (string | undefined)[] =>
  !v.ok && 'failures' in v ? v.failures.map((f) => f.dimension) : [];

describe('the margin is the policy margin, and the envelopes are the grown socket and the root envelope', () => {
  it('uses max(8 · tolerance, 0.35 · pin radius) = 0.7 here', () => {
    expect(MARGIN).toBe(0.7);
  });
});

describe('FEMALE support', () => {
  it('F1: generous lateral and far-end support passes', () => {
    expect(run({ female: female(), male: male(), sockets: [socket(0, 0, 4)] }).ok).toBe(true);
  });
  it('F2: a socket that passes Slice 2C but leaves a near-zero side wall is refused', () => {
    // the side wall is at x = 10; the socket's edge is at 7.7 + 2.2 = 9.9: 0.1 of material beside it
    const f = female(),
      sockets = [socket(7.7, 0, 4)];
    expect(validateSocketDepth(f, sockets, TOL, live).ok).toBe(true);
    const verdict = run({ female: f, male: male(10, [-30, -30], [30, 30]), sockets });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe(ConnectorRefusal.SOCKET_SUPPORT_INSUFFICIENT);
    expect(dimensionsOf(verdict)).toEqual(['LATERAL']);
  });
  it('F3: a thin wall on ONE side only is enough to refuse, and the three thick sides do not hide it', () => {
    // thin toward +x (0.1), and 7.9 / 17.7 / 7.9 away on the other three sides
    const verdict = run({ female: female(), male: male(), sockets: [socket(7.7, 0, 4)] });
    expect(verdict.ok).toBe(false);
    // the mirror image, thin toward -y
    const mirrored = run({ female: female(), male: male(), sockets: [socket(0, -7.7, 4)] });
    expect(mirrored.ok).toBe(false);
  });
  it('F4: an internal cavity inside the support envelope is refused', () => {
    // a void at x in [2.5, 6]: 0.3 beyond the socket wall (2.2), inside the 0.7 margin
    const solid = withCavity(box([-10, -10, -10], [10, 10, 0]), [2.5, -2, -8], [6, 2, -1]);
    const verdict = run({ female: piece(solid, TOP), male: male(), sockets: [socket(0, 0, 4)] });
    expect(verdict.ok).toBe(false);
    expect(dimensionsOf(verdict)).toEqual(['LATERAL']);
  });
  it('F5: a cavity that is near but outside the support envelope passes', () => {
    // the void starts 1.3 beyond the wall (x = 3.5 against 2.2): outside the 0.7 margin
    const solid = withCavity(box([-10, -10, -10], [10, 10, 0]), [3.5, -2, -8], [6, 2, -1]);
    const f = piece(solid, TOP);
    expect(validateSocketDepth(f, [socket(0, 0, 4)], TOL, live).ok).toBe(true);
    expect(run({ female: f, male: male(), sockets: [socket(0, 0, 4)] }).ok).toBe(true);
  });
  it('F6: enough lateral wall but too little material BEYOND the far end is refused as the far end', () => {
    // plate 10 deep, socket 9.5 deep: 0.5 left behind it, against a margin of 0.7; every side wall is ample
    const f = female(),
      sockets = [socket(0, 0, 9.5)];
    expect(validateSocketDepth(f, sockets, TOL, live).ok).toBe(true);
    const verdict = run({ female: f, male: male(), sockets });
    expect(verdict.ok).toBe(false);
    expect(dimensionsOf(verdict)).toEqual(['FAR_END']);
    expect(run({ female: f, male: male(), sockets: [socket(0, 0, 9)] }).ok).toBe(true); // 1.0 behind
  });
  it('is decided at the margin, to the tolerance: lateral exactly at the margin passes, behind it is refused', () => {
    // lateral: wall exactly MARGIN beside the socket edge (centre 10 - 2.2 - 0.7 = 7.1)
    expect(run({ female: female(), male: male(), sockets: [socket(7.1, 0, 4)] }).ok).toBe(true);
    expect(run({ female: female(), male: male(), sockets: [socket(7.1 + 2 * TOL, 0, 4)] }).ok).toBe(
      false,
    );
    // far end: material exactly MARGIN behind is refused by one tolerance; two tolerances more passes
    const behind = (remaining: number): boolean =>
      run({ female: female(), male: male(), sockets: [socket(0, 0, 10 - remaining)] }).ok;
    expect(behind(MARGIN)).toBe(false);
    expect(behind(MARGIN + TOL / 2)).toBe(false);
    expect(behind(MARGIN + 2 * TOL)).toBe(true);
  });
  it('a boundary beside AND beyond the far end (the corner) is refused and says so', () => {
    // a notch whose corner sits 0.5 out and 0.5 beyond the end of a 4-deep socket, with neither alone inside the margin
    const solid = withCavity(box([-10, -10, -10], [10, 10, 0]), [2.7, -2, -6], [6, 2, -4.5]);
    const verdict = run({
      female: piece(solid, TOP),
      male: male(),
      sockets: [socket(0, 0, 4)],
    });
    expect(verdict.ok).toBe(false);
    expect(dimensionsOf(verdict)).toEqual(['CORNER']);
  });
});

describe('MALE root support', () => {
  it('M1: broad support passes', () => {
    expect(run({ female: female(), male: male(), sockets: [socket(0, 0, 4)] }).ok).toBe(true);
  });
  it('M2: a pin root next to the exterior edge is refused', () => {
    // the male plate's wall is at x = 10; the root is at 9: 1 away from the centre, 2 radius: it overhangs
    const verdict = run({
      female: female([-30, -30, -10], [30, 30, 0]),
      male: male(10),
      sockets: [socket(8.4, 0, 4)],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe(ConnectorRefusal.PIN_ROOT_SUPPORT_INSUFFICIENT);
    expect(failuresOf(verdict)).toEqual(['MALE:pin-1']);
  });
  it('M3: a thin flange behind the root is refused', () => {
    const verdict = run({ female: female(), male: male(0.5), sockets: [socket(0, 0, 4)] });
    expect(verdict.ok).toBe(false);
    expect(failuresOf(verdict)).toEqual(['MALE:pin-1']);
    // a flange as thick as the margin plus two tolerances passes (behind-the-root material is refused within one tolerance)
    expect(
      run({ female: female(), male: male(MARGIN + 2 * TOL), sockets: [socket(0, 0, 4)] }).ok,
    ).toBe(true);
    expect(run({ female: female(), male: male(MARGIN), sockets: [socket(0, 0, 4)] }).ok).toBe(
      false,
    );
  });
  it('M4: thin support on only one side is refused', () => {
    // the male plate is 20 wide but ends 2.3 from the root's centre on the +y side only (pin radius 2: 0.3 of material)
    const verdict = run({
      female: female([-30, -30, -10], [30, 30, 0]),
      male: male(10, [-10, -10], [10, 2.3]),
      sockets: [socket(0, 0, 4)],
    });
    expect(verdict.ok).toBe(false);
    expect(failuresOf(verdict)).toEqual(['MALE:pin-1']);
  });
  it('M5: a boundary near the root but outside the required envelope passes', () => {
    // the wall is 1.4 beyond the pin edge (centre 3.4): outside the 0.7 margin
    expect(
      run({
        female: female([-30, -30, -10], [30, 30, 0]),
        male: male(10, [-10, -10], [3.4, 10]),
        sockets: [socket(0, 0, 4)],
      }).ok,
    ).toBe(true);
  });
  it('uses the PIN radius, not the socket radius: clearance is not support', () => {
    // wall 2.75 from the centre: beyond pin radius + margin (2.7) but inside socket radius + margin (2.9)
    const m = male(10, [-10, -10], [2.75, 10]);
    const f = female([-30, -30, -10], [30, 30, 0]);
    expect(run({ female: f, male: m, sockets: [socket(0, 0, 4)] }).ok).toBe(true);
    expect(
      run({ female: f, male: male(10, [-10, -10], [2.65, 10]), sockets: [socket(0, 0, 4)] }).ok,
    ).toBe(false);
  });
});

describe('FEMALE and MALE support are independent', () => {
  // the female plate is 20 wide; the "wide" male plate is 60 wide, so a socket 0.1 from the female wall is far from any male wall
  const wideMale = (): ReceivingPiece => male(10, [-30, -30], [30, 30]);
  const cases: readonly [string, ReceivingPiece, ReceivingPiece, number, readonly string[]][] = [
    ['both valid', female(), wideMale(), 0, []],
    ['valid female, invalid male', female(), male(0.5), 0, ['MALE:pin-1']],
    ['invalid female, valid male', female(), wideMale(), 7.7, ['FEMALE:pin-1']],
    ['both invalid', female(), male(0.5), 7.7, ['FEMALE:pin-1', 'MALE:pin-1']],
  ];
  for (const [name, f, m, x, expected] of cases) {
    it(name, () => {
      const verdict = run({ female: f, male: m, sockets: [socket(x, 0, 4)] });
      expect(failuresOf(verdict)).toEqual(expected);
      expect(verdict.ok).toBe(expected.length === 0);
      if (!verdict.ok && 'failures' in verdict)
        expect(verdict.refusal).toBe(
          expected[0]?.startsWith('FEMALE')
            ? ConnectorRefusal.SOCKET_SUPPORT_INSUFFICIENT
            : ConnectorRefusal.PIN_ROOT_SUPPORT_INSUFFICIENT,
        );
    });
  }
});

describe('a plan is validated whole', () => {
  it('four sockets, three supported and one not: the plan is refused and names the one', () => {
    const f = female([-30, -30, -10], [30, 30, 0]),
      m = male(10, [-60, -60], [60, 60]),
      sockets = [
        socket(-15, -15, 4, 'pin-1'),
        socket(15, -15, 4, 'pin-2'),
        socket(-15, 15, 4, 'pin-3'),
        socket(27.7, 15, 4, 'pin-4'), // 0.1 from the +x wall at 30
      ];
    const verdict = run({ female: f, male: m, sockets });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok && 'failures' in verdict) {
      expect(verdict.checked).toBe(4);
      expect(verdict.failures.map((x) => x.pairId)).toEqual(['pin-4']);
    }
    // the same four, all supported
    expect(
      run({ female: f, male: m, sockets: [...sockets.slice(0, 3), socket(15, 15, 4, 'pin-4')] }).ok,
    ).toBe(true);
  });
  it('an empty plan has nothing to check and builds nothing', () => {
    const broadphase = createReceivingBroadphase(female());
    const verdict = validateConnectorSupport({
      female: female(),
      femaleBroadphase: broadphase,
      male: male(),
      sockets: [],
      pinRadius: PIN_RADIUS,
      margin: MARGIN,
      tolerance: TOL,
      cancellation: live,
    });
    expect(verdict.ok).toBe(true);
    expect(broadphase.builds).toBe(0);
  });
});

describe('the entry cap is excluded by provenance and by nothing else', () => {
  it('female: the same top faces marked as source faces (a coplanar ledge) ARE a boundary', () => {
    const cap = female();
    const ledge = piece(box([-10, -10, -10], [10, 10, 0]), []); // no face is the entry
    expect(run({ female: cap, male: male(), sockets: [socket(0, 0, 4)] }).ok).toBe(true);
    expect(run({ female: ledge, male: male(), sockets: [socket(0, 0, 4)] }).ok).toBe(false);
  });
  it('male: the same bottom faces marked as source faces are a boundary; marked as the entry they are not', () => {
    const ledge = piece(box([-10, -10, 0], [10, 10, 10]), []);
    expect(run({ female: female(), male: male(), sockets: [socket(0, 0, 4)] }).ok).toBe(true);
    const verdict = run({ female: female(), male: ledge, sockets: [socket(0, 0, 4)] });
    expect(verdict.ok).toBe(false);
    expect(failuresOf(verdict)).toEqual(['MALE:pin-1']);
  });
});

describe('ONE female tree per plan across the depth check and the support check, and none for the male piece', () => {
  it('builds the female tree once and no other', () => {
    const f = female(),
      m = male(),
      broadphase = createReceivingBroadphase(f),
      spy = vi.spyOn(FaceBvh, 'build'),
      sockets = [socket(0, 0, 4)];
    try {
      expect(validateSocketDepth(f, sockets, TOL, live, broadphase).ok).toBe(true);
      expect(broadphase.builds).toBe(1);
      const verdict = validateConnectorSupport({
        female: f,
        femaleBroadphase: broadphase,
        male: m,
        sockets,
        pinRadius: PIN_RADIUS,
        margin: MARGIN,
        tolerance: TOL,
        cancellation: live,
      });
      expect(verdict.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(broadphase.builds).toBe(1);
      if (verdict.ok) {
        expect(verdict.stats.femaleBuilds).toBe(1);
        expect(verdict.stats.femaleQueries).toBe(1);
      }
    } finally {
      spy.mockRestore();
    }
  });
  it('is the same when the support check is the first to need the tree', () => {
    const f = female(),
      spy = vi.spyOn(FaceBvh, 'build');
    try {
      const verdict = run({ female: f, male: male(), sockets: [socket(0, 0, 4)] });
      expect(verdict.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('the male pass keeps no per-face index: it reads each face of the male piece once', () => {
    const m = male(),
      verdict = run({
        female: female(),
        male: m,
        sockets: [socket(0, 0, 4), socket(5, 5, 4, 'pin-2')],
      });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.stats.maleFacesExamined).toBe(12);
      expect(verdict.stats.maleCheckpoints).toBe(1);
    }
  });
});

describe('cancellation during the male scan', () => {
  /** A male piece with many faces far from every envelope: closed is a caller's claim, so the geometry only has to be plentiful. */
  function manyFaces(count: number): ReceivingPiece {
    const base = box([-10, -10, 0], [10, 10, 10]),
      extra: P3[] = [],
      faces: [number, number, number][] = [...base.faces];
    for (let i = 0; i < count; i++) {
      const o = base.vertices.length + extra.length;
      extra.push([100 + i, 100, 100], [100 + i, 101, 100], [100 + i, 100, 101]);
      faces.push([o, o + 1, o + 2]);
    }
    return piece({ vertices: [...base.vertices, ...extra], faces }, BOTTOM);
  }
  it('polls the token every SCAN_CHECKPOINT_FACES faces', () => {
    const faces = 3 * SCAN_CHECKPOINT_FACES + 17,
      m = manyFaces(faces - 12),
      verdict = run({ female: female(), male: m, sockets: [socket(0, 0, 4)] });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.stats.maleFacesExamined).toBe(faces);
      expect(verdict.stats.maleCheckpoints).toBe(Math.ceil(faces / SCAN_CHECKPOINT_FACES));
    }
  });
  it('a Cancel that arrives mid-scan is honoured within one stride, and nothing is returned', () => {
    const m = manyFaces(5 * SCAN_CHECKPOINT_FACES);
    let polls = 0;
    // the token reports cancelled from its fifth read: the female check reads it a few times, then the scan
    const token: CancellationToken = {
      get isCancelled(): boolean {
        polls++;
        return polls > 6;
      },
      onCancelled: () => () => undefined,
    };
    let thrown: unknown;
    try {
      run({ female: female(), male: m, sockets: [socket(0, 0, 4)], token });
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    // the scan was stopped well short of the end: at most a handful of checkpoints were read
    expect(polls).toBeLessThan(12);
  });
  it('a token that is already cancelled stops the support check before the tree is built', () => {
    const source = new CancellationSource();
    source.cancel();
    const spy = vi.spyOn(FaceBvh, 'build');
    try {
      expect(() =>
        run({ female: female(), male: male(), sockets: [socket(0, 0, 4)], token: source.token }),
      ).toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('what cannot be examined fails closed, typed, and is never a pass', () => {
  const refused = (v: SupportValidation): string =>
    !v.ok && 'reason' in v ? `${v.role}:${v.reason}` : 'passed-or-other';
  it('a female piece that is not a closed solid', () => {
    expect(
      refused(
        run({ female: { ...female(), closed: false }, male: male(), sockets: [socket(0, 0, 4)] }),
      ),
    ).toBe('FEMALE:PIECE_NOT_CLOSED');
  });
  it('a male piece that is not a closed solid', () => {
    expect(
      refused(
        run({ female: female(), male: { ...male(), closed: false }, sockets: [socket(0, 0, 4)] }),
      ),
    ).toBe('MALE:PIECE_NOT_CLOSED');
  });
  it('provenance that does not match the faces', () => {
    const bad = { ...male(), provenance: new Int32Array(3) };
    expect(refused(run({ female: female(), male: bad, sockets: [socket(0, 0, 4)] }))).toBe(
      'MALE:PROVENANCE_MISMATCH',
    );
  });
  it('an unusable margin, pin radius or sweep', () => {
    for (const margin of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        refused(run({ female: female(), male: male(), sockets: [socket(0, 0, 4)], margin })),
      ).toBe('PLAN:INVALID_SWEEP');
    const sweep = { ...socket(0, 0, 4), axis: [0, 0, -2] as P3 };
    expect(refused(run({ female: female(), male: male(), sockets: [sweep] }))).toBe(
      'PLAN:INVALID_SWEEP',
    );
  });
  it('an allocation failure while building the female tree is a typed resource refusal', () => {
    const spy = vi.spyOn(FaceBvh, 'build').mockImplementation(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    try {
      const verdict = run({ female: female(), male: male(), sockets: [socket(0, 0, 4)] });
      expect(refused(verdict)).toBe('FEMALE:RESOURCE_LIMIT');
      if (!verdict.ok)
        expect(verdict.refusal).toBe(ConnectorRefusal.SUPPORT_VALIDATION_UNAVAILABLE);
    } finally {
      spy.mockRestore();
    }
  });
  it('a broadphase that stops on its budget is a typed refusal', () => {
    const spy = vi.spyOn(FaceBvh.prototype, 'queryBox').mockReturnValue(false);
    try {
      expect(refused(run({ female: female(), male: male(), sockets: [socket(0, 0, 4)] }))).toBe(
        'FEMALE:BROADPHASE_BUDGET',
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('what a person is told', () => {
  it('names what was checked and claims nothing about strength, printing or millimetres', () => {
    for (const refusal of [
      ConnectorRefusal.SOCKET_SUPPORT_INSUFFICIENT,
      ConnectorRefusal.PIN_ROOT_SUPPORT_INSUFFICIENT,
      ConnectorRefusal.SUPPORT_VALIDATION_UNAVAILABLE,
    ] as const) {
      const text = describeSupportFailure(refusal);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(
        /printable|watertight|strong|strength|durable|\bsafe\b|manufactur|\bmm\b|millimet|BVH|triangle|topolog/i,
      );
    }
    expect(describeSupportFailure(ConnectorRefusal.SOCKET_SUPPORT_INSUFFICIENT)).toMatch(
      /^Not enough material around the socket/,
    );
    expect(describeSupportFailure(ConnectorRefusal.PIN_ROOT_SUPPORT_INSUFFICIENT)).toMatch(
      /^Not enough material around the pin base/,
    );
  });
});
