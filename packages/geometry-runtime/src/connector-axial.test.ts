import { describe, expect, it, vi } from 'vitest';
import { CancellationSource, isAppError } from '@cadfixer/shared';
import { FaceBvh } from '@cadfixer/mesh-core/spatial';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  ConnectorRefusal,
  PRODUCED_IN_SLICE_2C,
  REFUSAL_TO_LEGACY_DETAILS_CODE,
  refusalForLegacyCode,
} from './connector-plan';
import {
  describeAxialFailure,
  ENTRY_CAP_PROVENANCE,
  triangleBreachesSocket,
  validateSocketDepth,
  type AxialValidation,
  type ReceivingPiece,
  type SocketSweep,
} from './connector-axial';

/*
 * Release 2, Slice 2C — does the socket volume have receiving material throughout?
 *
 * The receiving pieces here are SYNTHETIC closed solids with explicit entry-cap provenance, so each geometric relationship
 * (a back wall, a sloped back, a cavity, a coplanar neighbour) is chosen rather than found. The kernel-backed cases are in
 * `apps/web/src/workers/node-tests/connector-axial.test.ts`, and the production decision is also held to an independent
 * Boolean-kernel reference and to a brute-force pass over every triangle.
 */

const TOL = 0.01;
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
/** Corner order of `CUBE_FACES`: bit 0 = x, bit 1 = y, bit 2 = z. Faces 2 and 3 are the +z face. */
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
/** `inner` as a void: its faces reversed and appended, so the piece has a second, inverted shell. */
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

/** `entry` lists the faces that are the generated entry cap (provenance -1); every other face carries its own index. */
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

/** The +z face of `box` is faces 2 and 3. */
const TOP = [2, 3];
/** A 20 x 20 plate, 10 thick, whose top (z = 0) is the entry: material is z in [-10, 0]. */
const PLATE = (): ReceivingPiece => piece(box([-10, -10, -10], [10, 10, 0]), TOP);
const DOWN: P3 = [0, 0, -1];

const sweep = (
  center: P3,
  radius: number,
  depth: number,
  axis: P3 = DOWN,
  pairId = 'pin-1',
): SocketSweep => ({
  pairId,
  center,
  axis,
  radius,
  depth,
});
const live = new CancellationSource().token;
const verdict = (receiving: ReceivingPiece, ...sweeps: SocketSweep[]): AxialValidation =>
  validateSocketDepth(receiving, sweeps, TOL, live);
const verdictWith = (
  tolerance: number,
  receiving: ReceivingPiece,
  ...sweeps: SocketSweep[]
): AxialValidation => validateSocketDepth(receiving, sweeps, tolerance, live);
const passes = (result: AxialValidation): boolean => result.ok;

describe('axial depth against a back wall', () => {
  it('passes a socket that ends well before the back wall and refuses one that reaches it', () => {
    expect(passes(verdict(PLATE(), sweep([0, 0, 0], 2, 6)))).toBe(true);
    const result = verdict(PLATE(), sweep([0, 0, 0], 2, 12));
    if (result.ok || result.refusal !== ConnectorRefusal.SOCKET_BREAKTHROUGH)
      throw new Error('expected a breakthrough');
    expect(result.failures.map((f) => f.pairId)).toEqual(['pin-1']);
  });
  it('is decided by "wall remaining <= tolerance", on both sides of that line', () => {
    // the back wall is 10 away: a depth of 10 leaves none, so does 10 - tolerance/2, 10 - tolerance; more than that passes
    for (const depth of [10, 10 - TOL / 2])
      expect(passes(verdict(PLATE(), sweep([0, 0, 0], 2, depth)))).toBe(false);
    for (const depth of [10 - 1.5 * TOL, 10 - 2 * TOL, 9, 3])
      expect(passes(verdict(PLATE(), sweep([0, 0, 0], 2, depth)))).toBe(true);
  });
  it('is not fooled by the centre line: only the whole socket cross-section is judged', () => {
    // the plate's underside slopes: 7 thick at x = 0 and 0.5 thinner per unit of +x
    const wedge: Solid = {
      vertices: [
        [-10, -10, -12],
        [10, -10, -2],
        [-10, 10, -12],
        [10, 10, -2],
        [-10, -10, 0],
        [10, -10, 0],
        [-10, 10, 0],
        [10, 10, 0],
      ],
      faces: CUBE_FACES.map((f): [number, number, number] => [f[0], f[1], f[2]]),
    };
    const sloped = piece(wedge, TOP);
    // bottom plane z = -7 + 0.5 x: thickness 7 at the centre, 5.9 at x = +2.2, 8.1 at x = -2.2
    expect(passes(verdict(sloped, sweep([0, 0, 0], 2.2, 6)))).toBe(false);
    expect(passes(verdict(sloped, sweep([0, 0, 0], 1.2, 6)))).toBe(true);
    // the centre line alone would pass at depth 6 (7 thick), and so does a socket that stays inside the thicker half
    expect(passes(verdict(sloped, sweep([0, 0, 0], 0.05, 6)))).toBe(true);
    expect(passes(verdict(sloped, sweep([-3, 0, 0], 2.2, 6)))).toBe(true);
  });
});

describe('axial depth against the side wall', () => {
  // the side wall is at x = 10
  it('passes a socket clear of it and one that touches it, refuses one that cuts through it', () => {
    expect(passes(verdict(PLATE(), sweep([7.5, 0, 0], 2, 5)))).toBe(true);
    expect(passes(verdict(PLATE(), sweep([8, 0, 0], 2, 5)))).toBe(true);
    expect(passes(verdict(PLATE(), sweep([8.5, 0, 0], 2, 5)))).toBe(false);
  });
  it('lets the side wall reach into the socket by up to the tolerance, exactly the band Slice 2B contains', () => {
    expect(passes(verdict(PLATE(), sweep([8 + TOL / 2, 0, 0], 2, 5)))).toBe(true);
    expect(passes(verdict(PLATE(), sweep([8 + TOL * 0.99, 0, 0], 2, 5)))).toBe(true);
    expect(passes(verdict(PLATE(), sweep([8 + 2 * TOL, 0, 0], 2, 5)))).toBe(false);
  });
});

describe('an internal cavity is a boundary', () => {
  const solid = (lo: P3, hi: P3): ReceivingPiece =>
    piece(withCavity(box([-20, -20, -20], [20, 20, 0]), lo, hi), TOP);
  it('refuses a socket that reaches the void before its full depth, even though no outside is reached', () => {
    // the void is z in [-8, -4], under the site
    const cavity = solid([-5, -5, -8], [5, 5, -4]);
    expect(passes(verdict(cavity, sweep([0, 0, 0], 2.2, 6)))).toBe(false);
    expect(passes(verdict(cavity, sweep([0, 0, 0], 2.2, 3)))).toBe(true);
    expect(passes(verdict(cavity, sweep([0, 0, 0], 2.2, 3.98)))).toBe(true);
  });
  it('passes a socket beside the void, and one whose box overlaps a void it never touches', () => {
    expect(passes(verdict(solid([-5, -5, -8], [5, 5, -4]), sweep([12, 0, 0], 2.2, 6)))).toBe(true);
    // nearest corner (1.8, 1.8) is 2.546 from the axis; the socket's box reaches 2.2 so the two boxes overlap
    const near = solid([1.8, 1.8, -5], [4, 4, -3]),
      result = verdict(near, sweep([0, 0, 0], 2.2, 6));
    expect(result.ok).toBe(true);
    // the exact test RAN on the void's faces and discarded them: candidacy proves nothing
    expect(result.stats.exactTests).toBeGreaterThan(0);
    // move the corner inside the radius (1.5, 1.5 is 2.12 away) and it breaches
    expect(passes(verdict(solid([1.5, 1.5, -5], [4, 4, -3]), sweep([0, 0, 0], 2.2, 6)))).toBe(
      false,
    );
  });
});

describe('the entry cap is excluded by provenance, and nothing else is', () => {
  it('excludes the generated cap and treats a coplanar face that is NOT the cap as a boundary', () => {
    const solid = box([-10, -10, -10], [10, 10, 0]);
    // the top is two triangles: with both marked as the generated cap the socket enters freely
    expect(passes(verdict(piece(solid, TOP), sweep([0, 0, 0], 2, 5)))).toBe(true);
    // the very same geometry with no cap marked: the top is a source face lying at the socket's entry, so it breaches
    expect(passes(verdict(piece(solid, []), sweep([0, 0, 0], 2, 5)))).toBe(false);
    // only one of the two top triangles is the cap: the other (a ledge, here under the site) still breaches
    const oneTriangle = verdict(piece(solid, [2]), sweep([0, 0, 0], 2, 5));
    expect(oneTriangle.ok).toBe(false);
  });
  it('does not exclude a neighbouring ledge outside the footprint, which is simply not in the way', () => {
    const ledge: Solid = {
      vertices: [...corners([-10, -10, -10], [10, 10, 0])],
      faces: CUBE_FACES.map((f): [number, number, number] => [f[0], f[1], f[2]]),
    };
    expect(passes(verdict(piece(ledge, TOP), sweep([5, 5, 0], 2, 5)))).toBe(true);
  });
});

describe('a plan is judged whole', () => {
  it('reports only the socket that fails, checks all of them, and builds one tree', () => {
    const result = verdict(
      PLATE(),
      sweep([0, 0, 0], 2, 5, DOWN, 'pin-1'),
      sweep([0, 0, 0], 2, 12, DOWN, 'pin-2'),
      sweep([5, 5, 0], 2, 5, DOWN, 'pin-3'),
    );
    if (result.ok || result.refusal !== ConnectorRefusal.SOCKET_BREAKTHROUGH)
      throw new Error('expected a breakthrough');
    expect(result.failures.map((f) => f.pairId)).toEqual(['pin-2']);
    expect(result.checked).toBe(3);
    expect(result.stats.builds).toBe(1);
    expect(result.stats.queries).toBe(3);
  });
  it('builds nothing when there is nothing to check', () => {
    const result = validateSocketDepth(PLATE(), [], TOL, live);
    expect(result).toEqual({
      ok: true,
      checked: 0,
      stats: { builds: 0, queries: 0, candidates: 0, exactTests: 0 },
    });
  });
});

describe('the answer does not depend on the frame or the triangle order', () => {
  /** A rotation about an arbitrary axis and a shift, applied to the piece and the sweeps alike. */
  function moved(
    angle: number,
    shift: P3,
  ): { piece: ReceivingPiece; map: (p: P3) => P3; turn: (p: P3) => P3 } {
    const axis: P3 = [0.36, -0.48, 0.8],
      c = Math.cos(angle),
      s = Math.sin(angle),
      turn = (p: P3): P3 => {
        const d = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2],
          cr: P3 = [
            axis[1] * p[2] - axis[2] * p[1],
            axis[2] * p[0] - axis[0] * p[2],
            axis[0] * p[1] - axis[1] * p[0],
          ];
        return [0, 1, 2].map(
          (k) => (p[k] ?? 0) * c + (cr[k] ?? 0) * s + (axis[k] ?? 0) * d * (1 - c),
        ) as unknown as P3;
      },
      map = (p: P3): P3 => {
        const t = turn(p);
        return [t[0] + shift[0], t[1] + shift[1], t[2] + shift[2]];
      },
      base = withCavity(box([-20, -20, -20], [20, 20, 0]), [1.5, 1.5, -5], [4, 4, -3]);
    return {
      piece: piece({ vertices: base.vertices.map(map), faces: base.faces }, TOP),
      map,
      turn,
    };
  }
  const cases: readonly (readonly [string, P3, number, number])[] = [
    ['clear', [10, 10, 0], 2.2, 6],
    ['cavity in the way', [2, 2, 0], 2.2, 6],
    ['back wall', [0, 0, 0], 2.2, 25],
  ];
  for (const [name, site, radius, depth] of cases)
    it(`gives one verdict for "${name}" at every turn and shift`, () => {
      const expected = passes(
        verdict(
          piece(withCavity(box([-20, -20, -20], [20, 20, 0]), [1.5, 1.5, -5], [4, 4, -3]), TOP),
          sweep(site, radius, depth),
        ),
      );
      for (const angle of [0.3, 1.1, 2.9, -2.2])
        for (const shift of [
          [0, 0, 0],
          [500, -250, 75],
          [-3.5, 7.25, -1],
        ] as const) {
          const frame = moved(angle, shift);
          expect(
            passes(verdict(frame.piece, sweep(frame.map(site), radius, depth, frame.turn(DOWN)))),
          ).toBe(expected);
        }
    });
  it('gives the same verdict when the triangles come in another order', () => {
    const base = withCavity(box([-20, -20, -20], [20, 20, 0]), [1.5, 1.5, -5], [4, 4, -3]),
      order = [...base.faces.keys()].reverse().sort((a, b) => ((a * 7) % 5) - ((b * 7) % 5));
    const shuffled = piece(
      { vertices: base.vertices, faces: order.map((i) => base.faces[i] ?? [0, 0, 0]) },
      order.flatMap((original, at) => (TOP.includes(original) ? [at] : [])),
    );
    for (const [, site, radius, depth] of cases)
      expect(passes(verdict(shuffled, sweep(site, radius, depth)))).toBe(
        passes(verdict(piece(base, TOP), sweep(site, radius, depth))),
      );
  });
});

describe('the broadphase never decides: it agrees with a pass over every triangle', () => {
  /** A UV sphere of 40 x 20 bands (1,600 triangles) with its top polar cap standing in for the entry. */
  function sphere(): { receiving: ReceivingPiece; triangles: readonly (readonly [P3, P3, P3])[] } {
    const lat = 20,
      lon = 40,
      radius = 10,
      vertices: P3[] = [[0, 0, radius]];
    for (let i = 1; i < lat; i++)
      for (let j = 0; j < lon; j++) {
        const th = (Math.PI * i) / lat,
          ph = (2 * Math.PI * j) / lon;
        vertices.push([
          radius * Math.sin(th) * Math.cos(ph),
          radius * Math.sin(th) * Math.sin(ph),
          radius * Math.cos(th),
        ]);
      }
    vertices.push([0, 0, -radius]);
    const ring = (i: number, j: number): number =>
        i === 0 ? 0 : i === lat ? vertices.length - 1 : 1 + (i - 1) * lon + (j % lon),
      faces: [number, number, number][] = [];
    for (let i = 0; i < lat; i++)
      for (let j = 0; j < lon; j++) {
        const a = ring(i, j),
          b = ring(i, j + 1),
          c = ring(i + 1, j),
          d = ring(i + 1, j + 1);
        if (i === 0) faces.push([a, c, d]);
        else if (i === lat - 1) faces.push([a, c, b]);
        else faces.push([a, c, d], [a, d, b]);
      }
    const receiving = piece(
      { vertices, faces },
      [...faces.keys()].filter((f) => f < lon),
    );
    return {
      receiving,
      triangles: faces.map(
        (f) =>
          [
            vertices[f[0]] ?? [0, 0, 0],
            vertices[f[1]] ?? [0, 0, 0],
            vertices[f[2]] ?? [0, 0, 0],
          ] as const,
      ),
    };
  }
  it('gives the verdict of testing every non-entry triangle, for sockets of every size and depth', () => {
    const { receiving, triangles } = sphere();
    let breached = 0,
      cleared = 0;
    for (const x of [0, 2, 4, 6, 8])
      for (const radius of [0.5, 1.5, 3])
        for (const depth of [1, 4, 8, 12]) {
          const s = sweep([x, 0.3, 9.9], radius, depth, [0, 0, -1]),
            fast = passes(verdict(receiving, s)),
            basis = { u: [1, 0, 0] as P3, v: [0, 1, 0] as P3 },
            slow = !triangles.some(
              (t, f) =>
                receiving.provenance[f] !== ENTRY_CAP_PROVENANCE &&
                triangleBreachesSocket(s, basis, TOL, t[0], t[1], t[2]),
            );
          expect(fast).toBe(slow);
          if (fast) cleared++;
          else breached++;
        }
    // both outcomes occur, so the comparison is not vacuous
    expect(breached).toBeGreaterThan(5);
    expect(cleared).toBeGreaterThan(5);
  });
});

describe('a socket that cannot be examined is not passed', () => {
  const unavailable = (result: AxialValidation): string => {
    if (result.ok || result.refusal !== ConnectorRefusal.AXIAL_VALIDATION_UNAVAILABLE)
      throw new Error('expected the check to be unavailable');
    return result.reason;
  };
  it('fails closed on a piece that is not a closed solid, or whose provenance does not match its faces', () => {
    expect(unavailable(verdict({ ...PLATE(), closed: false }, sweep([0, 0, 0], 2, 5)))).toBe(
      'PIECE_NOT_CLOSED',
    );
    expect(
      unavailable(verdict({ ...PLATE(), provenance: new Int32Array(3) }, sweep([0, 0, 0], 2, 5))),
    ).toBe('PROVENANCE_MISMATCH');
  });
  it('fails closed on a sweep that is not a usable cylinder', () => {
    const bad: SocketSweep[] = [
      sweep([NaN, 0, 0], 2, 5),
      sweep([0, 0, 0], NaN, 5),
      sweep([0, 0, 0], TOL, 5),
      sweep([0, 0, 0], 2, 0),
      sweep([0, 0, 0], 2, Infinity),
      sweep([0, 0, 0], 2, 5, [0, 0, -2]),
    ];
    for (const s of bad) expect(unavailable(verdict(PLATE(), s))).toBe('INVALID_SWEEP');
    for (const tolerance of [NaN, -1, Infinity])
      expect(
        unavailable(validateSocketDepth(PLATE(), [sweep([0, 0, 0], 2, 5)], tolerance, live)),
      ).toBe('INVALID_SWEEP');
  });
});

describe('a large face covering the axis, which is not on a triangle diagonal', () => {
  // the plate's faces are two triangles each, split along the diagonal x = y; a socket off that diagonal sits in the middle of one
  // triangle of the back wall, so only the "axis point is inside the projected polygon" branch can see it
  const reversed = (): ReceivingPiece => {
    const solid = box([-10, -10, -10], [10, 10, 0]);
    return piece(
      {
        vertices: solid.vertices,
        faces: solid.faces.map((f): [number, number, number] => [f[0], f[2], f[1]]),
      },
      TOP,
    );
  };
  it('breaches through the middle of the back wall, for either winding of the faces', () => {
    for (const receiving of [PLATE(), reversed()]) {
      expect(passes(verdict(receiving, sweep([3, -1, 0], 2, 12)))).toBe(false);
      expect(passes(verdict(receiving, sweep([-4, 1.5, 0], 2, 12)))).toBe(false);
      expect(passes(verdict(receiving, sweep([3, -1, 0], 2, 6)))).toBe(true);
    }
  });
});

describe('exact ties, on a tolerance that is exact in binary', () => {
  const T = 0.25;
  it('radially: reaching into the socket by exactly the tolerance passes, by anything more breaches', () => {
    // the side wall is at x = 10; radius 2 at x = 8.25 puts it 1.75 = radius - tolerance away
    expect(verdictWith(T, PLATE(), sweep([8.25, 0, 0], 2, 5)).ok).toBe(true);
    expect(verdictWith(T, PLATE(), sweep([8.26, 0, 0], 2, 5)).ok).toBe(false);
    expect(verdictWith(T, PLATE(), sweep([8.24, 0, 0], 2, 5)).ok).toBe(true);
  });
  it('axially, at the far end: a wall exactly tolerance beyond the end breaches, a hair further passes', () => {
    expect(verdictWith(T, PLATE(), sweep([0, 0, 0], 2, 9.75)).ok).toBe(false);
    expect(verdictWith(T, PLATE(), sweep([0, 0, 0], 2, 9.74)).ok).toBe(true);
  });
  it('axially, at the entry: a boundary face exactly tolerance behind the entry plane breaches, a hair further behind does not', () => {
    // an UNMARKED top at z = +0.25 is axial -0.25 for a socket entering at z = 0
    const top = (z: number): ReceivingPiece => piece(box([-10, -10, -10], [10, 10, z]), []);
    expect(verdictWith(T, top(0.25), sweep([0, 0, 0], 2, 5)).ok).toBe(false);
    expect(verdictWith(T, top(0.26), sweep([0, 0, 0], 2, 5)).ok).toBe(true);
    // and the cap, marked, is excluded whatever its height
    expect(
      verdictWith(T, piece(box([-10, -10, -10], [10, 10, 0.25]), TOP), sweep([0, 0, 0], 2, 5)).ok,
    ).toBe(true);
  });
  it('is sharp to one percent of the tolerance on the realistic scale', () => {
    expect(passes(verdict(PLATE(), sweep([8 + 1.01 * TOL, 0, 0], 2, 5)))).toBe(false);
    expect(passes(verdict(PLATE(), sweep([8 + 0.99 * TOL, 0, 0], 2, 5)))).toBe(true);
    expect(passes(verdict(PLATE(), sweep([0, 0, 0], 2, 10 - 0.99 * TOL)))).toBe(false);
    expect(passes(verdict(PLATE(), sweep([0, 0, 0], 2, 10 - 1.01 * TOL)))).toBe(true);
  });
});

describe('every socket of a plan is judged, and the broadphase failing closed is never a pass', () => {
  it('reports two breaching sockets of three, in plan order', () => {
    const result = verdict(
      PLATE(),
      sweep([0, 0, 0], 2, 12, DOWN, 'pin-1'),
      sweep([5, 5, 0], 2, 5, DOWN, 'pin-2'),
      sweep([-5, -5, 0], 2, 12, DOWN, 'pin-3'),
    );
    if (result.ok || result.refusal !== ConnectorRefusal.SOCKET_BREAKTHROUGH)
      throw new Error('expected a breakthrough');
    expect(result.failures.map((f) => f.pairId)).toEqual(['pin-1', 'pin-3']);
    expect(result.checked).toBe(3);
  });
  it('is unavailable, not a pass, when the broadphase stops before it finished', () => {
    const spy = vi.spyOn(FaceBvh.prototype, 'queryBox').mockReturnValue(false);
    try {
      const result = verdict(PLATE(), sweep([0, 0, 0], 2, 12));
      if (result.ok || result.refusal !== ConnectorRefusal.AXIAL_VALIDATION_UNAVAILABLE)
        throw new Error('expected the check to be unavailable');
      expect(result.reason).toBe('BROADPHASE_BUDGET');
    } finally {
      spy.mockRestore();
    }
  });
  it('is a typed resource refusal, not an untyped failure, when the tree cannot be allocated', () => {
    const spy = vi.spyOn(FaceBvh, 'build').mockImplementation(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    try {
      const result = verdict(PLATE(), sweep([0, 0, 0], 2, 5));
      if (result.ok || result.refusal !== ConnectorRefusal.AXIAL_VALIDATION_UNAVAILABLE)
        throw new Error('expected the check to be unavailable');
      expect(result.reason).toBe('RESOURCE_LIMIT');
    } finally {
      spy.mockRestore();
    }
    // anything that is not an allocation failure is not swallowed
    const other = vi.spyOn(FaceBvh, 'build').mockImplementation(() => {
      throw new Error('a defect');
    });
    try {
      expect(() => verdict(PLATE(), sweep([0, 0, 0], 2, 5))).toThrow('a defect');
    } finally {
      other.mockRestore();
    }
  });
  it('honours a cancel before it builds anything', () => {
    const source = new CancellationSource();
    source.cancel();
    const spy = vi.spyOn(FaceBvh, 'build');
    try {
      let thrown: unknown;
      try {
        validateSocketDepth(PLATE(), [sweep([0, 0, 0], 2, 5)], TOL, source.token);
      } catch (error) {
        thrown = error;
      }
      expect(isAppError(thrown)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it('also refuses a provenance array that is longer than the faces, and a piece too small to be a solid', () => {
    const plate = PLATE(),
      longer = { ...plate, provenance: new Int32Array(plate.provenance.length + 1) };
    const result = verdict(longer, sweep([0, 0, 0], 2, 5));
    if (result.ok || result.refusal !== ConnectorRefusal.AXIAL_VALIDATION_UNAVAILABLE)
      throw new Error('expected unavailable');
    expect(result.reason).toBe('PROVENANCE_MISMATCH');
  });
});

describe('the broadphase reaches the LAST face', () => {
  it('finds a breach whose only boundary is the final triangle of the piece', () => {
    // the plate with its faces reordered so the back wall is last: dropping the last face from the tree would pass the socket
    const solid = box([-10, -10, -10], [10, 10, 0]),
      back = [0, 1],
      order = [...solid.faces.keys()].filter((f) => !back.includes(f)).concat(back),
      receiving = piece(
        { vertices: solid.vertices, faces: order.map((i) => solid.faces[i] ?? [0, 0, 0]) },
        order.flatMap((original, at) => (TOP.includes(original) ? [at] : [])),
      );
    expect(passes(verdict(receiving, sweep([0, 0, 0], 2, 12)))).toBe(false);
    expect(passes(verdict(receiving, sweep([0, 0, 0], 2, 6)))).toBe(true);
  });
});

describe('typed vocabulary', () => {
  it('declares exactly the two codes Slice 2C produces, mapped to legacy details codes and back', () => {
    expect([...PRODUCED_IN_SLICE_2C].sort()).toEqual([
      'AXIAL_VALIDATION_UNAVAILABLE',
      'SOCKET_BREAKTHROUGH',
    ]);
    for (const code of PRODUCED_IN_SLICE_2C) {
      expect(Object.values(ConnectorRefusal)).toContain(code);
      const legacy = REFUSAL_TO_LEGACY_DETAILS_CODE[code];
      expect(legacy).toMatch(/^CONNECTOR_/);
      expect(refusalForLegacyCode(legacy)).toBe(code);
    }
  });
  it('gives each reason its own plain sentence, with no engine vocabulary', () => {
    const sentences = PRODUCED_IN_SLICE_2C.map((code) => describeAxialFailure(code));
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences)
      for (const banned of [
        'bvh',
        'broadphase',
        'tolerance',
        'hole',
        'printable',
        'watertight',
        'kernel',
      ])
        expect(sentence.toLowerCase()).not.toContain(banned);
  });
});
