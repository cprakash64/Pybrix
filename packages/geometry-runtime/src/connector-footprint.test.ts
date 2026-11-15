import { describe, expect, it } from 'vitest';
import type { GeneratedSeparationInterface } from './closed-plane-kernel';
import {
  ConnectorRefusal,
  PRODUCED_IN_SLICE_2B,
  draftFromRequest,
  planManualPins,
  refusalForLegacyCode,
  REFUSAL_TO_LEGACY_DETAILS_CODE,
  validateConnectorPlan,
  type ValidatedConnectorPlan,
} from './connector-plan';
import {
  containFootprints,
  describeFootprintFailure,
  type FootprintContainment,
} from './connector-footprint';
import type { SplitConnector, SplitVector } from './split-connectors';

/*
 * Release 2, Slice 2B — footprint containment against the generated interface's own loops.
 *
 * The interfaces here are SYNTHETIC: the planner and this check read only the loops, the area, the frame and the identity,
 * so the narrow thing being faked is named exactly. The kernel-backed cases (a real cut, a real plan, no Boolean on
 * refusal) are in `apps/web/src/workers/node-tests/connector-footprint.test.ts`.
 */

const TOLERANCE = 1e-4;

type Loop = readonly (readonly [number, number])[];
const square = (cx: number, cy: number, half: number): Loop => [
  [cx - half, cy - half],
  [cx + half, cy - half],
  [cx + half, cy + half],
  [cx - half, cy + half],
];
/** `loops` in kernel order; `net` is the material area (outlines minus openings, by the caller's own nesting). */
function interfaceOf(
  loops: readonly Loop[],
  net: number,
  turn = 0,
  shift: readonly [number, number] = [0, 0],
): GeneratedSeparationInterface {
  const cos = Math.cos(turn),
    sin = Math.sin(turn),
    flat: number[] = [],
    starts: number[] = [0];
  let vertices = 0;
  for (const loop of loops) {
    for (const [u, v] of loop)
      flat.push(cos * u - sin * v + shift[0], sin * u + cos * v + shift[1]);
    vertices += loop.length;
    starts.push(vertices);
  }
  return {
    document: 'doc',
    revision: 1,
    part: 'part-1',
    generation: 1,
    sourceSHA: 'bb'.repeat(32),
    frame: { O: [0, 0, 0], U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1], identity: 'frame-2b' },
    outputAnchor: [0, 0, 0],
    outputPlaneOrigin: [0, 0, 0],
    sharedRegion: {
      positions: new Float32Array(0),
      uv: Float64Array.from(flat),
      loops: Uint32Array.from(starts),
      triangles: new Uint32Array(0),
    },
    area: net,
    loopCount: loops.length,
  } as unknown as GeneratedSeparationInterface;
}

/** Sites are given in the interface's own (u, v); the fake frame makes them the local coordinates too. */
function planFor(
  face: GeneratedSeparationInterface,
  sites: readonly (readonly [number, number])[],
  radius: number,
  clearance = 0,
): ValidatedConnectorPlan {
  const connector: Extract<SplitConnector, { kind: 'pin' }> = {
    kind: 'pin',
    count: sites.length as 1 | 2 | 3 | 4,
    diameter: 2 * (radius - clearance),
    depth: 5,
    clearance,
    maleSide: 'A',
  };
  const centers: SplitVector[] = sites.map(([u, v]) => [u, v, 0]);
  const checked = validateConnectorPlan(
    planManualPins(draftFromRequest(connector, face, 1), face, connector, centers),
    face,
  );
  if (!checked.ok) throw new Error(`the fixture plan was refused: ${checked.refusal}`);
  return checked.validated;
}

const SQUARE_40 = interfaceOf([square(0, 0, 20)], 1600);
const ANNULUS = interfaceOf([square(0, 0, 30), square(0, 0, 8)], 3600 - 256);
const ISLANDS = interfaceOf([square(-20, 0, 5), square(20, 0, 5)], 200);
const NESTED = interfaceOf(
  [square(0, 0, 30), square(0, 0, 20), square(0, 0, 5)],
  3600 - 1600 + 100,
);

function verdict(
  face: GeneratedSeparationInterface,
  site: readonly [number, number],
  radius: number,
  tolerance = TOLERANCE,
): FootprintContainment {
  return containFootprints(planFor(face, [site], radius), face, tolerance);
}
const refusalOf = (result: FootprintContainment): string | undefined =>
  result.ok ? undefined : result.failures[0]?.refusal;

describe('A. a footprint inside the material is contained', () => {
  it('passes a circle well inside a square outline', () => {
    expect(verdict(SQUARE_40, [0, 0], 2.2)).toEqual({ ok: true, checked: 1 });
    expect(verdict(SQUARE_40, [12, -9], 3)).toEqual({ ok: true, checked: 1 });
  });
  it('passes a circle in the ring around an opening and one inside an island', () => {
    expect(verdict(ANNULUS, [19, 0], 3).ok).toBe(true);
    expect(verdict(ISLANDS, [20, 0], 3).ok).toBe(true);
  });
  it('checks nothing and passes when the plan has no pairs', () => {
    const face = SQUARE_40,
      empty = validateConnectorPlan(
        {
          draft: draftFromRequest({ kind: 'none' }, face, 1),
          pairs: [],
          legacy: { connector: { kind: 'none' }, centers: [] },
        },
        face,
      );
    if (!empty.ok) throw new Error('expected an empty plan to validate');
    expect(containFootprints(empty.validated, face, TOLERANCE)).toEqual({ ok: true, checked: 0 });
  });
});

describe('tangency is decided by the split tolerance, in both directions', () => {
  // the centre is exactly 5 from the nearest edge
  it('accepts a circle that touches the edge and one that passes it by less than the tolerance', () => {
    expect(verdict(SQUARE_40, [15, 0], 5).ok).toBe(true);
    expect(verdict(SQUARE_40, [15, 0], 5 + TOLERANCE / 2).ok).toBe(true);
    expect(verdict(SQUARE_40, [15, 0], 5 + TOLERANCE * 0.99).ok).toBe(true);
  });
  it('refuses a circle that passes it by more', () => {
    expect(refusalOf(verdict(SQUARE_40, [15, 0], 5 + 2 * TOLERANCE))).toBe(
      ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
    );
  });
  it('never contains a footprint centred ON a loop, however small the circle', () => {
    expect(verdict(SQUARE_40, [20, 0], 0.01).ok).toBe(false);
    expect(verdict(SQUARE_40, [20, 0], TOLERANCE / 10).ok).toBe(false);
  });
  it('moves with the tolerance it is given and nothing else', () => {
    expect(verdict(SQUARE_40, [15, 0], 5.3, 0.4).ok).toBe(true);
    expect(verdict(SQUARE_40, [15, 0], 5.3, 0.1).ok).toBe(false);
  });
});

describe('B. centre inside, circle crosses the exterior edge', () => {
  it('refuses it as outside the interface and names the outline it crosses', () => {
    const result = verdict(SQUARE_40, [18, 0], 4);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      refusal: ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
      pairId: 'pin-1',
      loopId: 0,
      centerInMaterial: true,
    });
    expect(result.failures[0]?.overreach).toBeCloseTo(2, 9);
  });
});

describe('C. centre in material, circle overlaps an opening', () => {
  it('refuses it as over an opening and names the opening', () => {
    const result = verdict(ANNULUS, [10.5, 0], 3);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.failures[0]).toMatchObject({
      refusal: ConnectorRefusal.FOOTPRINT_INTERSECTS_VOID,
      loopId: 1,
      centerInMaterial: true,
    });
    expect(result.failures[0]?.overreach).toBeCloseTo(0.5, 9);
  });
  it('lets the boundary the circle reaches furthest decide, and breaks an exact tie on the lowest loop', () => {
    // a ring only 4 wide: the outline is 12 from the centre line, the opening 8
    const thin = interfaceOf([square(0, 0, 12), square(0, 0, 8)], 576 - 256);
    const nearerOpening = verdict(thin, [9.5, 0], 3);
    if (nearerOpening.ok) throw new Error('expected a refusal');
    expect(nearerOpening.failures[0]).toMatchObject({
      refusal: ConnectorRefusal.FOOTPRINT_INTERSECTS_VOID,
      loopId: 1,
    });
    const tie = verdict(thin, [10, 0], 3);
    if (tie.ok) throw new Error('expected a refusal');
    expect(tie.failures[0]).toMatchObject({
      refusal: ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
      loopId: 0,
    });
  });
});

describe('D. centre inside an opening', () => {
  it('is never contained, whatever the radius', () => {
    for (const radius of [0.05, 1, 3, 7.9]) {
      const result = verdict(ANNULUS, [0, 0], radius);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.failures[0]).toMatchObject({
        refusal: ConnectorRefusal.FOOTPRINT_INTERSECTS_VOID,
        centerInMaterial: false,
      });
      expect(result.failures[0]?.overreach).toBeUndefined();
    }
  });
});

describe('E. centre outside the material', () => {
  it('is refused as outside the interface, in the exterior of a single outline', () => {
    const result = verdict(SQUARE_40, [50, 3], 1);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.failures[0]).toMatchObject({
      refusal: ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
      centerInMaterial: false,
      loopId: 0,
    });
  });
  it('refuses a footprint with a non-finite site rather than passing it', () => {
    expect(verdict(SQUARE_40, [NaN, 0], 1).ok).toBe(false);
    expect(verdict(SQUARE_40, [0, Infinity], 1).ok).toBe(false);
  });
});

describe('F. disconnected material islands', () => {
  it('accepts a footprint within one island', () => {
    expect(verdict(ISLANDS, [-20, 0], 3).ok).toBe(true);
    expect(verdict(ISLANDS, [20, 0], 4.9).ok).toBe(true);
  });
  it('refuses one that overflows its island, however much material the other island has', () => {
    expect(refusalOf(verdict(ISLANDS, [-20, 0], 6))).toBe(
      ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
    );
  });
  it('refuses one centred in the gap between the islands, and one that would bridge them', () => {
    expect(refusalOf(verdict(ISLANDS, [0, 0], 1))).toBe(
      ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
    );
    expect(refusalOf(verdict(ISLANDS, [-20, 0], 25))).toBe(
      ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
    );
  });
});

describe('G. nested loops honour the nesting', () => {
  // outline 60, opening 40, island 10: depths 0 | 1 material | 2 void | 3 material
  it('accepts a footprint in the ring and one on the island inside the opening', () => {
    expect(verdict(NESTED, [25, 0], 3).ok).toBe(true);
    expect(verdict(NESTED, [0, 0], 3).ok).toBe(true);
  });
  it('refuses one in the void between the island and the ring, from either side', () => {
    for (const site of [
      [12, 0],
      [-12, 0],
      [0, 15],
    ] as const) {
      const result = verdict(NESTED, site, 1);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.failures[0]).toMatchObject({
        refusal: ConnectorRefusal.FOOTPRINT_INTERSECTS_VOID,
        centerInMaterial: false,
      });
    }
  });
  it('treats an island that is too small for the circle as an outline the circle crosses', () => {
    const result = verdict(NESTED, [0, 0], 6);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.failures[0]).toMatchObject({
      refusal: ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
      loopId: 2,
      centerInMaterial: true,
    });
  });
});

describe('H. a plan with one invalid footprint fails closed', () => {
  it('checks every pair and reports only the invalid one, so the caller can refuse the whole plan', () => {
    const face = SQUARE_40,
      result = containFootprints(
        planFor(
          face,
          [
            [0, 0],
            [18, 0],
          ],
          4,
        ),
        face,
        TOLERANCE,
      );
    if (result.ok) throw new Error('expected a refusal');
    expect(result.checked).toBe(2);
    expect(result.failures.map((failure) => failure.pairId)).toEqual(['pin-2']);
  });
  it('reports every invalid pair in the order the resolver returned them', () => {
    const face = SQUARE_40,
      result = containFootprints(
        planFor(
          face,
          [
            [18, 0],
            [0, 0],
            [-19, 3],
            [8, 8],
          ],
          4,
        ),
        face,
        TOLERANCE,
      );
    if (result.ok) throw new Error('expected a refusal');
    expect(result.failures.map((failure) => failure.pairId)).toEqual(['pin-1', 'pin-3']);
  });
  it('passes only when every pair passes', () => {
    const face = SQUARE_40;
    expect(
      containFootprints(
        planFor(
          face,
          [
            [0, 0],
            [8, 8],
            [-8, 8],
            [8, -8],
          ],
          3,
        ),
        face,
        TOLERANCE,
      ).ok,
    ).toBe(true);
  });
});

describe('I / J. the decision does not depend on the frame the interface is expressed in', () => {
  const cases: readonly (readonly [string, readonly [number, number], number])[] = [
    ['contained', [12, -9], 3],
    ['crosses the outline', [28, 0], 4],
    ['over the opening', [10.5, 0], 3],
    ['in the opening', [0, 0], 1],
    ['in the exterior', [50, 3], 1],
  ];
  const turns = [0, Math.PI / 6, Math.PI / 2, 2.3, Math.PI, -0.7];
  for (const [name, site, radius] of cases)
    it(`gives one verdict for "${name}" at every turn and shift`, () => {
      const expected = refusalOf(verdict(ANNULUS, site, radius));
      for (const turn of turns)
        for (const shift of [
          [0, 0],
          [1000, -250],
          [-3.5, 7.25],
        ] as const) {
          const cos = Math.cos(turn),
            sin = Math.sin(turn),
            moved = interfaceOf([square(0, 0, 30), square(0, 0, 8)], 3600 - 256, turn, shift),
            [u, v] = site,
            at: readonly [number, number] = [
              cos * u - sin * v + shift[0],
              sin * u + cos * v + shift[1],
            ];
          expect(refusalOf(verdict(moved, at, radius))).toBe(expected);
        }
    });
});

describe('the interface region must be trustworthy, or the connector is not added', () => {
  const refused = (face: GeneratedSeparationInterface): FootprintContainment =>
    containFootprints(planFor(face, [[0, 0]], 2.2), face, TOLERANCE);
  it('refuses when the nesting implies a different area than the kernel triangulated', () => {
    const result = refused(interfaceOf([square(0, 0, 20)], 1700));
    if (result.ok) throw new Error('expected a refusal');
    expect(result.failures[0]?.refusal).toBe(ConnectorRefusal.INTERFACE_REGION_UNAVAILABLE);
    expect(result.checked).toBe(0);
  });
  it('refuses an interface with no loops, a loop of two vertices, or a non-finite coordinate', () => {
    const none = interfaceOf([], 100),
      thin = interfaceOf(
        [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        1,
      ),
      broken = interfaceOf(
        [
          [
            [0, 0],
            [10, 0],
            [NaN, 10],
            [0, 10],
          ],
        ],
        100,
      );
    for (const face of [none, thin, broken]) {
      const result = containFootprints(planFor(SQUARE_40, [[0, 0]], 2.2), face, TOLERANCE);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.failures[0]?.refusal).toBe(ConnectorRefusal.INTERFACE_REGION_UNAVAILABLE);
    }
  });
  it('refuses a tolerance that is not a finite, non-negative number', () => {
    for (const bad of [NaN, -1, Infinity]) {
      const result = containFootprints(planFor(SQUARE_40, [[0, 0]], 2.2), SQUARE_40, bad);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.failures[0]?.refusal).toBe(ConnectorRefusal.INTERFACE_REGION_UNAVAILABLE);
    }
  });
  it('accepts a region whose nesting and area agree, at the same rounding bound the kernel uses', () => {
    const result = containFootprints(planFor(ANNULUS, [[19, 0]], 2.2), ANNULUS, TOLERANCE);
    expect(result).toEqual({ ok: true, checked: 1 });
  });
});

describe('the result is a pure function of its inputs', () => {
  it('repeats exactly, does not mutate the interface, and does not depend on call order', () => {
    const before = Float64Array.from(NESTED.sharedRegion.uv),
      a = containFootprints(
        planFor(
          NESTED,
          [
            [25, 0],
            [12, 0],
          ],
          3,
        ),
        NESTED,
        TOLERANCE,
      ),
      b = containFootprints(
        planFor(
          NESTED,
          [
            [25, 0],
            [12, 0],
          ],
          3,
        ),
        NESTED,
        TOLERANCE,
      );
    expect(a).toEqual(b);
    expect(NESTED.sharedRegion.uv).toEqual(before);
  });
});

describe('typed vocabulary', () => {
  it('declares exactly the three codes Slice 2B produces, and keeps their legacy details codes', () => {
    expect([...PRODUCED_IN_SLICE_2B].sort()).toEqual(
      [
        'FOOTPRINT_INTERSECTS_VOID',
        'FOOTPRINT_OUTSIDE_INTERFACE',
        'INTERFACE_REGION_UNAVAILABLE',
      ].sort(),
    );
    for (const code of PRODUCED_IN_SLICE_2B) {
      expect(Object.values(ConnectorRefusal)).toContain(code);
      const legacy = REFUSAL_TO_LEGACY_DETAILS_CODE[code];
      expect(legacy).toMatch(/^CONNECTOR_/);
      expect(refusalForLegacyCode(legacy)).toBe(code);
    }
  });
  it('gives a plain-language reason that makes no claim beyond the cut surface', () => {
    for (const code of PRODUCED_IN_SLICE_2B) {
      const sentence = describeFootprintFailure(code);
      expect(sentence.length).toBeGreaterThan(20);
      for (const banned of [
        'hole',
        'printable',
        'watertight',
        'wall',
        'depth',
        'unit',
        'Geogram',
        'kernel',
      ])
        expect(sentence.toLowerCase()).not.toContain(banned);
    }
  });
});

describe('the distance and parity code on loops that are not axis-aligned convex squares', () => {
  it('measures to the SEGMENT, not the line through it: the nearest point of an opening is its corner', () => {
    // opening corner (8,8): a circle at (10,10) is 2.83 from it, though only 2 from the infinite line x = 8
    expect(verdict(ANNULUS, [10, 10], 2.5).ok).toBe(true);
    const result = verdict(ANNULUS, [10, 10], 3);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.failures[0]).toMatchObject({
      refusal: ConnectorRefusal.FOOTPRINT_INTERSECTS_VOID,
      loopId: 1,
    });
    expect(result.failures[0]?.overreach).toBeCloseTo(3 - Math.hypot(2, 2), 9);
  });
  it('counts a crossing exactly once when the test ray passes through a vertex', () => {
    const diamond = interfaceOf(
      [
        [
          [20, 0],
          [0, 20],
          [-20, 0],
          [0, -20],
        ],
      ],
      800,
    );
    // the +u ray from (5,0) runs exactly through the vertex (20,0); the half-open rule must still say "inside"
    expect(verdict(diamond, [5, 0], 2).ok).toBe(true);
    expect(verdict(diamond, [0, 5], 2).ok).toBe(true);
    expect(verdict(diamond, [30, 0], 1).ok).toBe(false);
  });
  it('reads a concave outline: inside the notch is outside the material, and the reflex corner is respected', () => {
    // an L: the lower arm is x 0..30, y 0..10, the upper arm x 0..10, y 10..30 (area 500)
    const L = interfaceOf(
      [
        [
          [0, 0],
          [30, 0],
          [30, 10],
          [10, 10],
          [10, 30],
          [0, 30],
        ],
      ],
      500,
    );
    expect(verdict(L, [4, 4], 3).ok).toBe(true);
    expect(verdict(L, [8, 18], 1.5).ok).toBe(true);
    const crossing = verdict(L, [8, 18], 2.5);
    if (crossing.ok) throw new Error('expected a refusal');
    expect(crossing.failures[0]?.overreach).toBeCloseTo(0.5, 9);
    expect(refusalOf(verdict(L, [15, 15], 1))).toBe(ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE);
    // 2 below the notch edge y = 10, so a circle of 2.2 reaches it
    expect(refusalOf(verdict(L, [12, 8], 2.2))).toBe(ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE);
    expect(verdict(L, [12, 8], 1.9).ok).toBe(true);
  });
  it('does not fail on a repeated vertex (a zero-length segment)', () => {
    const repeated = interfaceOf(
      [
        [
          [-20, -20],
          [20, -20],
          [20, -20],
          [20, 20],
          [-20, 20],
        ],
      ],
      1600,
    );
    expect(verdict(repeated, [0, 0], 2).ok).toBe(true);
    expect(verdict(repeated, [19, 0], 2).ok).toBe(false);
  });
});

describe('a centre on a loop is never contained, on either side of the crossing rule', () => {
  it('refuses a tiny footprint centred on the left edge, on the right edge and on an opening edge', () => {
    for (const [face, site] of [
      [SQUARE_40, [-20, 0]],
      [SQUARE_40, [20, 0]],
      [ANNULUS, [8, 0]],
      [ANNULUS, [-8, 0]],
    ] as const)
      expect(verdict(face, site, TOLERANCE / 10).ok).toBe(false);
  });
});

describe('region guards that fail closed', () => {
  const plan = (face: GeneratedSeparationInterface): FootprintContainment =>
    containFootprints(planFor(SQUARE_40, [[0, 0]], 2.2), face, TOLERANCE);
  it('refuses a non-finite or zero area, and a loop count that disagrees with the loops', () => {
    for (const area of [NaN, 0, -5, Infinity]) {
      const result = plan(interfaceOf([square(0, 0, 20)], area));
      if (result.ok) throw new Error(`expected a refusal for area ${String(area)}`);
      expect(result.failures[0]?.refusal).toBe(ConnectorRefusal.INTERFACE_REGION_UNAVAILABLE);
    }
    const lying = {
      ...interfaceOf([square(0, 0, 20)], 1600),
      loopCount: 2,
    } as GeneratedSeparationInterface;
    expect(plan(lying).ok).toBe(false);
  });
  it('accepts a tolerance of exactly zero, and then an exact touch is contained', () => {
    expect(verdict(SQUARE_40, [15, 0], 5, 0).ok).toBe(true);
    expect(verdict(SQUARE_40, [15, 0], 5.000001, 0).ok).toBe(false);
  });
  it('does not mistake rounding for disagreement when a SMALL loop lies far from the plane origin in a turned frame', () => {
    // the failure this pins: area summed about the plane origin lost ~1e-9 of a 4-unit area at offset 5000, far above the bound
    for (const [turn, shift] of [
      [2.3, [5000, -3000]],
      [0.4, [1e5, 1e5]],
      [-1.1, [-250, 4000]],
    ] as const) {
      const raw = interfaceOf([square(0, 0, 1)], 4, turn, shift),
        uv = raw.sharedRegion.uv,
        // the kernel's cap area is the area of the loops AS STORED; at this offset rounding the coordinates changes the
        // polygon by ~1e-11, so the stored loop's own area (summed about its first vertex) is the honest figure
        area =
          Math.abs(
            [0, 1, 2, 3].reduce((sum, i) => {
              const j = (i + 1) % 4;
              return (
                sum +
                ((uv[2 * i] ?? 0) - (uv[0] ?? 0)) * ((uv[2 * j + 1] ?? 0) - (uv[1] ?? 0)) -
                ((uv[2 * j] ?? 0) - (uv[0] ?? 0)) * ((uv[2 * i + 1] ?? 0) - (uv[1] ?? 0))
              );
            }, 0),
          ) / 2,
        face = { ...raw, area } as GeneratedSeparationInterface,
        at: readonly [number, number] = [shift[0], shift[1]];
      expect(containFootprints(planFor(face, [at], 0.3), face, TOLERANCE)).toEqual({
        ok: true,
        checked: 1,
      });
    }
  });
});

describe('what a person is told, and in what order failures come back', () => {
  it('gives each reason its own sentence', () => {
    const sentences = PRODUCED_IN_SLICE_2B.map((code) => describeFootprintFailure(code));
    expect(new Set(sentences).size).toBe(sentences.length);
  });
  it('reports failures in the order of the pairs, whatever order the sites are listed in', () => {
    const face = SQUARE_40,
      forward = containFootprints(
        planFor(
          face,
          [
            [18, 0],
            [0, 0],
            [-19, 3],
          ],
          4,
        ),
        face,
        TOLERANCE,
      ),
      backward = containFootprints(
        planFor(
          face,
          [
            [-19, 3],
            [0, 0],
            [18, 0],
          ],
          4,
        ),
        face,
        TOLERANCE,
      );
    if (forward.ok || backward.ok) throw new Error('expected refusals');
    expect(forward.failures.map((f) => f.pairId)).toEqual(['pin-1', 'pin-3']);
    expect(backward.failures.map((f) => f.pairId)).toEqual(['pin-1', 'pin-3']);
    expect(forward.failures.map((f) => f.footprint.u).sort()).toEqual(
      backward.failures.map((f) => f.footprint.u).sort(),
    );
  });
});
