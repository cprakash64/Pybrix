import { describe, expect, it } from 'vitest';
import type { GeneratedSeparationInterface } from './closed-plane-kernel';
import {
  ConnectorRefusal,
  LEGACY_CONNECTOR_POLICY,
  LEGACY_DETAILS_CODE_TO_REFUSAL,
  PRODUCED_IN_C03C1,
  PRODUCED_IN_SLICE_1,
  PRODUCED_IN_SLICE_2B,
  PRODUCED_IN_SLICE_2C,
  PRODUCED_IN_SLICE_2D,
  REFUSAL_TO_LEGACY_DETAILS_CODE,
  ValidatedConnectorPlan,
  connectorManifestOf,
  deriveInterfaceRegion,
  draftDigest,
  draftFromRequest,
  interfaceCoordinates,
  planAutomaticPins,
  planManualPins,
  refusalForLegacyCode,
  sameSeparationInterface,
  separationInterfaceRefOf,
  toLegacyAutomaticPlan,
  toLegacyConnectorPlan,
  validateConnectorPlan,
  type ConnectorPlan,
  type PhysicalFrame,
} from './connector-plan';
import type { SplitConnector, SplitVector } from './split-connectors';

type Pin = Extract<SplitConnector, { kind: 'pin' }>;

/**
 * A synthetic interface carrying only the fields the planner reads. The planner never touches a mesh, so a faithful kernel
 * run is not needed here (the integration tests under `apps/web` use the real kernel). The assertion is the narrow one
 * that names exactly what is being faked.
 */
function fakeInterface(
  overrides: {
    readonly revision?: number;
    readonly sourceSHA?: string;
    readonly frameIdentity?: string;
    readonly origin?: SplitVector;
    readonly normal?: SplitVector;
    readonly uv?: readonly number[];
    readonly loops?: readonly number[];
  } = {},
): GeneratedSeparationInterface {
  const uv = Float64Array.from(overrides.uv ?? [0, 0, 10, 0, 10, 10, 0, 10]);
  const loops = Uint32Array.from(overrides.loops ?? [0, uv.length / 2]);
  return {
    document: 'doc',
    revision: overrides.revision ?? 4,
    part: 'part-1',
    generation: 2,
    sourceSHA: overrides.sourceSHA ?? 'aa'.repeat(32),
    frame: {
      O: [0, 0, 5],
      U: [1, 0, 0],
      V: [0, 1, 0],
      N: overrides.normal ?? [0, 0, 1],
      identity: overrides.frameIdentity ?? 'frame-1',
    },
    outputAnchor: [0, 0, 0],
    outputPlaneOrigin: overrides.origin ?? [0, 0, 5],
    sharedRegion: { positions: new Float32Array(0), uv, loops, triangles: new Uint32Array(0) },
    area: 100,
    loopCount: loops.length - 1,
  } as unknown as GeneratedSeparationInterface;
}

const PIN: Pin = { kind: 'pin', count: 2, diameter: 4, depth: 6, clearance: 0.2, maleSide: 'A' };
const SITES: readonly SplitVector[] = [
  [2, 3, 5],
  [7, 6, 5],
];

function manualPlan(
  face = fakeInterface(),
  pin: Pin = PIN,
  centers: readonly SplitVector[] = SITES,
): ConnectorPlan {
  return planManualPins(draftFromRequest(pin, face), face, pin, centers);
}

describe('SeparationInterfaceRef', () => {
  it('is equal for the same interface and differs for every identifying field', () => {
    const base = separationInterfaceRefOf(fakeInterface());
    expect(sameSeparationInterface(base, separationInterfaceRefOf(fakeInterface()))).toBe(true);
    for (const changed of [
      fakeInterface({ revision: 5 }),
      fakeInterface({ sourceSHA: 'bb'.repeat(32) }),
      fakeInterface({ frameIdentity: 'frame-2' }),
      fakeInterface({ origin: [0, 0, 5.000001] }),
      fakeInterface({ normal: [0, 0, -1] }),
    ])
      expect(sameSeparationInterface(base, separationInterfaceRefOf(changed))).toBe(false);
  });
  it('is frozen and carries no geometry', () => {
    const ref = separationInterfaceRefOf(fakeInterface());
    expect(Object.isFrozen(ref)).toBe(true);
    expect(Object.keys(ref).sort()).toEqual(
      [
        'document',
        'frameIdentity',
        'generation',
        'part',
        'planeNormal',
        'planeOrigin',
        'revision',
        'sourceSHA',
      ].sort(),
    );
  });
});

/** A resolved frame, from a millimetres-per-unit table written out here (not read from the product). */
const MM_PER_UNIT: Record<string, number> = { millimeter: 1, inch: 25.4, meter: 1000 };
const INTENT = { diameter: 4, depth: 6, clearance: 0.2 };
const frameOf = (unit: string, scale: number, intentMm?: typeof INTENT): PhysicalFrame => ({
  unit,
  mmPerUnit: MM_PER_UNIT[unit] ?? Number.NaN,
  placementScale: scale,
  mmPerCoordinate: (MM_PER_UNIT[unit] ?? Number.NaN) * scale,
  ...(intentMm === undefined ? {} : { intentMm }),
});

describe('ConnectorDraft', () => {
  it('states what was asked for, per kind, with an honest unit context', () => {
    const face = fakeInterface();
    expect(draftFromRequest({ kind: 'none' }, face).kind).toBe('none');
    const manual = draftFromRequest(PIN, face);
    expect(manual).toMatchObject({
      kind: 'pin',
      origin: 'MANUAL',
      count: 2,
      maleSide: 'A',
      policy: LEGACY_CONNECTOR_POLICY,
    });
    // A COORDINATE request (the engine's pinned legacy form, which no product flow sends) is stated and not hidden: its size is in
    // coordinates and the part scale is NOT applied to it. Its policy label stays `legacy-v0`: its meaning has not changed.
    expect(manual.unitContext).toEqual({
      basis: 'COORDINATES',
      partScale: 1,
      partScaleApplied: false,
    });
    // A PHYSICAL manual pin (Stage C03-C1): millimetre intent resolved with the unit and the placement scale, and the manifest says so.
    const physicalManual = draftFromRequest(PIN, face, frameOf('inch', 2, INTENT));
    expect(physicalManual).toMatchObject({ kind: 'pin', origin: 'MANUAL', policy: 'units-v1' });
    expect(physicalManual.unitContext).toEqual({
      basis: 'PHYSICAL_MM',
      unit: 'inch',
      partScale: 2,
      partScaleApplied: true,
      mmPerUnit: 25.4,
      mmPerCoordinate: 50.8,
      intentMm: INTENT,
    });
    const automatic = draftFromRequest(
      { kind: 'automatic', unit: 'millimeter' },
      face,
      frameOf('millimeter', 2.5),
    );
    expect(automatic).toMatchObject({
      kind: 'automatic-pin',
      unit: 'millimeter',
      policy: 'units-v1',
    });
    expect(automatic.unitContext).toEqual({
      basis: 'REQUEST_UNIT',
      unit: 'millimeter',
      partScale: 2.5,
      partScaleApplied: true,
      mmPerUnit: 1,
      mmPerCoordinate: 2.5,
    });
    // an automatic request whose unit or placement was refused has no frame: the part scale is recorded as NaN, as it always was
    expect(draftFromRequest({ kind: 'automatic', unit: 'millimeter' }, face).unitContext).toEqual({
      basis: 'REQUEST_UNIT',
      unit: 'millimeter',
      partScale: Number.NaN,
      partScaleApplied: true,
    });
    expect(
      draftFromRequest(
        {
          kind: 'dovetail',
          width: 8,
          depth: 6,
          length: 12,
          clearance: 0.2,
          maleSide: 'A',
          orientationDegrees: 0,
        },
        face,
      ).kind,
    ).toBe('legacy-dovetail');
  });
  it('is immutable', () => {
    expect(Object.isFrozen(draftFromRequest(PIN, fakeInterface()))).toBe(true);
  });
});

describe('draft digest', () => {
  const face = fakeInterface();
  const digestOf = (pin: Pin, f = face): string => draftDigest(draftFromRequest(pin, f));
  it('is stable for equal drafts', () => {
    expect(digestOf(PIN)).toBe(digestOf({ ...PIN }));
    expect(digestOf(PIN)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when ANY draft field changes', () => {
    const base = digestOf(PIN);
    const variants: Pin[] = [
      { ...PIN, count: 3 },
      { ...PIN, diameter: 4.0001 },
      { ...PIN, depth: 6.5 },
      { ...PIN, clearance: 0.25 },
      { ...PIN, maleSide: 'B' },
    ];
    for (const variant of variants) expect(digestOf(variant)).not.toBe(base);
    expect(digestOf(PIN, fakeInterface({ revision: 9 }))).not.toBe(base);
    expect(digestOf(PIN, fakeInterface({ sourceSHA: 'cc'.repeat(32) }))).not.toBe(base);
    const auto = (unit: string, scale: number): string =>
      draftDigest(draftFromRequest({ kind: 'automatic', unit }, face, frameOf(unit, scale)));
    expect(auto('millimeter', 1)).not.toBe(auto('inch', 1));
    expect(auto('millimeter', 1)).not.toBe(auto('millimeter', 2));
    // a physical manual pin and the same sizes as raw coordinates are different drafts
    expect(draftDigest(draftFromRequest(PIN, face, frameOf('millimeter', 1, INTENT)))).not.toBe(
      draftDigest(draftFromRequest(PIN, face)),
    );
  });
  it('tells -0 and NaN apart from 0 so a non-finite draft cannot collide with a finite one', () => {
    expect(digestOf({ ...PIN, clearance: -0 })).not.toBe(digestOf({ ...PIN, clearance: 0 }));
    expect(digestOf({ ...PIN, clearance: Number.NaN })).not.toBe(
      digestOf({ ...PIN, clearance: 0 }),
    );
  });
});

describe('plan and validation (identity only)', () => {
  const face = fakeInterface();
  it('validates a plan against the interface it was made for and hands back exactly the legacy data', () => {
    const plan = manualPlan(face);
    const checked = validateConnectorPlan(plan, face);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const legacy = toLegacyConnectorPlan(checked.validated);
    // the SAME objects, not copies: the construction code receives what the resolver produced
    expect(legacy.connector).toBe(PIN);
    expect(legacy.centers).toBe(SITES);
    expect(checked.validated.interfaceRef).toEqual(separationInterfaceRefOf(face));
    expect(checked.validated.policy).toBe(LEGACY_CONNECTOR_POLICY);
    expect(checked.validated.draftDigest).toBe(draftDigest(plan.draft));
    expect(Object.isFrozen(checked.validated)).toBe(true);
  });
  it('REFUSES a plan made for a different interface (stale), by code', () => {
    const plan = manualPlan(face);
    for (const other of [
      fakeInterface({ revision: 5 }),
      fakeInterface({ frameIdentity: 'frame-2' }),
      fakeInterface({ sourceSHA: 'dd'.repeat(32) }),
    ]) {
      const checked = validateConnectorPlan(plan, other);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.refusal).toBe(ConnectorRefusal.STALE_INTERFACE);
    }
  });
  it('refuses an automatic draft whose unit is not a length unit, by code', () => {
    const draft = draftFromRequest({ kind: 'automatic', unit: 'furlong' }, face);
    const plan = planAutomaticPins(draft, face, {
      connector: { ...PIN, count: 2 },
      centers: SITES,
    });
    const checked = validateConnectorPlan(plan, face);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.refusal).toBe(ConnectorRefusal.UNIT_UNKNOWN);
  });
  it('refuses a plan that contradicts itself (count, side, duplicate ids, stray pairs)', () => {
    const plan = manualPlan(face);
    const tampered: ConnectorPlan[] = [
      { ...plan, pairs: plan.pairs.slice(0, 1) },
      { ...plan, pairs: plan.pairs.map((pair) => ({ ...pair, maleSide: 'B' as const })) },
      { ...plan, pairs: plan.pairs.map((pair) => ({ ...pair, pairId: 'pin-1' })) },
      { ...plan, legacy: { connector: { kind: 'none' }, centers: [] } },
    ];
    for (const bad of tampered) {
      const checked = validateConnectorPlan(bad, face);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.refusal).toBe(ConnectorRefusal.INVALID_PLAN);
    }
  });
  it('accepts a plan with no connector and no pairs', () => {
    const none: ConnectorPlan = {
      draft: draftFromRequest({ kind: 'none' }, face),
      pairs: [],
      legacy: { connector: { kind: 'none' }, centers: [] },
    };
    expect(validateConnectorPlan(none, face).ok).toBe(true);
  });
  it('recovers the automatic path shape only for an automatic plan', () => {
    const draft = draftFromRequest(
      { kind: 'automatic', unit: 'millimeter' },
      face,
      frameOf('millimeter', 1),
    );
    const checked = validateConnectorPlan(
      planAutomaticPins(draft, face, { connector: PIN, centers: SITES }),
      face,
    );
    if (!checked.ok) throw new Error('expected a valid automatic plan');
    // Slice 2D retired the automatic guard wall from the plan: material support is judged by `support-v1`, not carried here.
    expect(toLegacyAutomaticPlan(checked.validated)).toEqual({ connector: PIN, centers: SITES });
    expect('wall' in checked.validated.plan.legacy).toBe(false);
    const manual = validateConnectorPlan(manualPlan(face), face);
    if (!manual.ok) throw new Error('expected a valid manual plan');
    expect(() => toLegacyAutomaticPlan(manual.validated)).toThrow(/automatic pin plan/);
  });
});

describe('ValidatedConnectorPlan cannot be constructed except through validateConnectorPlan', () => {
  const plan = manualPlan();
  it('refuses a forged issue token', () => {
    expect(() => ValidatedConnectorPlan.issue(Symbol('forged') as never, plan)).toThrow(
      /only be issued by validateConnectorPlan/,
    );
  });
  it('refuses a direct constructor call even though `private` is erased at runtime', () => {
    const construct = ValidatedConnectorPlan as unknown as new (
      token: symbol,
      plan: ConnectorPlan,
    ) => unknown;
    expect(() => new construct(Symbol('forged'), plan)).toThrow(
      /only be issued by validateConnectorPlan/,
    );
    const bare = ValidatedConnectorPlan as unknown as new (plan: ConnectorPlan) => unknown;
    expect(() => new bare(plan)).toThrow(/only be issued by validateConnectorPlan/);
  });
});

describe('pairs', () => {
  it('derive site (u,v), identity, roles and the zero axial clearance from the resolver output', () => {
    const plan = manualPlan();
    expect(plan.pairs.map((pair) => pair.pairId)).toEqual(['pin-1', 'pin-2']);
    const [first] = plan.pairs;
    expect(first?.site).toEqual({ u: 2, v: 3, local: SITES[0] });
    expect(first?.nominal).toEqual({ diameter: 4, depth: 6 });
    expect(first?.clearance).toEqual({ radial: 0.2, axial: 0 });
    expect(first?.footprint).toEqual({ kind: 'circle', u: 2, v: 3, radius: 2.2 });
    expect(Object.isFrozen(plan.pairs)).toBe(true);
  });
  it('projects a part-local point into the interface frame', () => {
    const face = fakeInterface();
    expect(interfaceCoordinates(face, [3, -4, 9])).toEqual({ u: 3, v: -4 });
    const rotated = {
      ...fakeInterface(),
      frame: { O: [0, 0, 0], U: [0, -1, 0], V: [1, 0, 0], N: [0, 0, 1], identity: 'x' },
      outputPlaneOrigin: [0, 0, 7] as SplitVector,
    } as unknown as GeneratedSeparationInterface;
    expect(interfaceCoordinates(rotated, [7, -20, 7])).toEqual({ u: 20, v: 7 });
  });
});

describe('ConnectorManifest', () => {
  it('is JSON-safe, bounded and carries no geometry', () => {
    const face = fakeInterface();
    const checked = validateConnectorPlan(manualPlan(face), face);
    if (!checked.ok) throw new Error('expected a valid plan');
    const manifest = connectorManifestOf(checked.validated);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'connectorKind',
        'draftDigest',
        'interfaceRef',
        'pairs',
        'policy',
        'unitContext',
        'version',
      ].sort(),
    );
    const text = JSON.stringify(manifest);
    for (const banned of ['positions', 'indices', 'triangles', 'uv"', 'loops', 'Float32Array'])
      expect(text).not.toContain(banned);
    expect(text.length).toBeLessThan(4096);
    expect(manifest.draftDigest).toBe(checked.validated.draftDigest);
    expect(manifest.pairs).toHaveLength(2);
  });
});

describe('typed refusal vocabulary', () => {
  it('Slice 1 produces only codes the existing code already distinguishes', () => {
    expect([...PRODUCED_IN_SLICE_1].sort()).toEqual(
      [
        'DOES_NOT_FIT_COUNT',
        'EDGE_CLEARANCE',
        'INVALID_PLAN',
        'NO_SAFE_SITE',
        'OPEN_SURFACE_UNSUPPORTED',
        'STALE_INTERFACE',
        'UNIT_UNKNOWN',
      ].sort(),
    );
    const declared = Object.values(ConnectorRefusal);
    for (const code of PRODUCED_IN_SLICE_1) expect(declared).toContain(code);
    // the codes later slices need exist, and are NOT produced yet
    for (const later of ['EXTERIOR_BREAKTHROUGH', 'RESOURCE_LIMIT'] as const) {
      expect(declared).toContain(later);
      expect(PRODUCED_IN_SLICE_1).not.toContain(later);
    }
  });
  it('Slice 2D produces exactly the support and transform codes, disjoint from every earlier slice', () => {
    expect([...PRODUCED_IN_SLICE_2D].sort()).toEqual(
      [
        'PIN_ROOT_SUPPORT_INSUFFICIENT',
        'SOCKET_SUPPORT_INSUFFICIENT',
        'SUPPORT_VALIDATION_UNAVAILABLE',
        'UNSUPPORTED_TRANSFORM',
      ].sort(),
    );
    const declared = Object.values(ConnectorRefusal);
    for (const code of PRODUCED_IN_SLICE_2D) {
      expect(declared).toContain(code);
      for (const earlier of [PRODUCED_IN_SLICE_1, PRODUCED_IN_SLICE_2B, PRODUCED_IN_SLICE_2C])
        expect(earlier).not.toContain(code);
    }
    // the reserved wall names were replaced by the codes that are actually produced, not left to carry a second meaning
    for (const retired of [
      'INSUFFICIENT_WALL_BEHIND',
      'INSUFFICIENT_WALL_AROUND',
      'INSUFFICIENT_ROOT_MATERIAL',
    ])
      expect(declared).not.toContain(retired);
  });
  it('Stage C03-C1 produces exactly the dimension-policy code, disjoint from every earlier slice, and it has a legacy code both ways', () => {
    expect([...PRODUCED_IN_C03C1]).toEqual(['DIMENSION_OUT_OF_POLICY']);
    for (const earlier of [
      PRODUCED_IN_SLICE_1,
      PRODUCED_IN_SLICE_2B,
      PRODUCED_IN_SLICE_2C,
      PRODUCED_IN_SLICE_2D,
    ])
      expect(earlier).not.toContain('DIMENSION_OUT_OF_POLICY');
    expect(refusalForLegacyCode('CONNECTOR_DIMENSION_OUT_OF_POLICY')).toBe(
      ConnectorRefusal.DIMENSION_OUT_OF_POLICY,
    );
    expect(REFUSAL_TO_LEGACY_DETAILS_CODE[ConnectorRefusal.DIMENSION_OUT_OF_POLICY]).toBe(
      'CONNECTOR_DIMENSION_OUT_OF_POLICY',
    );
  });
  it('maps every legacy details.code the product throws to its typed refusal, and back', () => {
    expect(refusalForLegacyCode('UNKNOWN_UNITS')).toBe(ConnectorRefusal.UNIT_UNKNOWN);
    expect(refusalForLegacyCode('OPEN_SPLIT_CONNECTOR_UNSUPPORTED')).toBe(
      ConnectorRefusal.OPEN_SURFACE_UNSUPPORTED,
    );
    expect(refusalForLegacyCode('CONNECTOR_TOO_CLOSE_TO_EDGE')).toBe(
      ConnectorRefusal.EDGE_CLEARANCE,
    );
    expect(refusalForLegacyCode('CONNECTOR_DOES_NOT_FIT')).toBe(
      ConnectorRefusal.DOES_NOT_FIT_COUNT,
    );
    for (const [legacy, typed] of Object.entries(LEGACY_DETAILS_CODE_TO_REFUSAL))
      expect(REFUSAL_TO_LEGACY_DETAILS_CODE[typed]).toBe(legacy);
  });
  it('names nothing for a code outside the vocabulary, including inherited object keys', () => {
    for (const code of [
      'CUT_NOT_SAFE',
      'constructor',
      '__proto__',
      'toString',
      '',
      undefined,
      7,
      null,
    ])
      expect(refusalForLegacyCode(code)).toBeUndefined();
  });
});

describe('InterfaceRegion (derived)', () => {
  const square = (u0: number, v0: number, size: number): number[] => [
    u0,
    v0,
    u0 + size,
    v0,
    u0 + size,
    v0 + size,
    u0,
    v0 + size,
  ];
  it('classifies an annulus: one outline and one opening that belongs to it', () => {
    const outer = square(0, 0, 20),
      hole = square(5, 5, 8);
    const region = deriveInterfaceRegion(
      fakeInterface({ uv: [...outer, ...hole], loops: [0, 4, 8] }),
    );
    const [first, second] = region.loops;
    expect(first).toMatchObject({ id: 0, role: 'OUTER', componentId: 0, start: 0, end: 4 });
    expect(first?.parent).toBeUndefined();
    expect(second).toMatchObject({
      id: 1,
      role: 'HOLE',
      parent: 0,
      componentId: 0,
      start: 4,
      end: 8,
    });
    expect(Math.abs(first?.signedArea ?? 0)).toBe(400);
    expect(Math.abs(second?.signedArea ?? 0)).toBe(64);
    expect(region.bounds).toEqual({ minU: 0, maxU: 20, minV: 0, maxV: 20 });
  });
  it('keeps separate outlines separate', () => {
    const region = deriveInterfaceRegion(
      fakeInterface({ uv: [...square(0, 0, 10), ...square(30, 0, 10)], loops: [0, 4, 8] }),
    );
    expect(region.loops.map((loop) => loop.role)).toEqual(['OUTER', 'OUTER']);
    expect(region.loops.map((loop) => loop.componentId)).toEqual([0, 1]);
  });
  it('alternates by nesting depth: an island inside an opening is an outline again', () => {
    const region = deriveInterfaceRegion(
      fakeInterface({
        uv: [...square(0, 0, 40), ...square(5, 5, 30), ...square(10, 10, 10)],
        loops: [0, 4, 8, 12],
      }),
    );
    expect(region.loops.map((loop) => loop.role)).toEqual(['OUTER', 'HOLE', 'OUTER']);
    expect(region.loops[2]).toMatchObject({ parent: 1, componentId: 2 });
    expect(region.loops[1]).toMatchObject({ parent: 0, componentId: 0 });
  });
  it('is frozen, carries the interface ref, and reports an empty interface without throwing', () => {
    const empty = deriveInterfaceRegion(fakeInterface({ uv: [], loops: [0] }));
    expect(empty.loops).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
    expect(sameSeparationInterface(empty.ref, separationInterfaceRefOf(fakeInterface()))).toBe(
      true,
    );
  });
});
