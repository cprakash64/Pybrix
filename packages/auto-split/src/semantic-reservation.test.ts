import { beforeAll, describe, expect, it } from 'vitest';
import {
  VIEW_NAMES,
  type SemanticHierarchy,
  type SemanticPart,
} from '@cadfixer/auto-split-contract';
import { box, concatMeshes, fixtureDeflate } from './fixtures';
import {
  prepareSemanticGeometry,
  type PreparedSemanticGeometry,
  type SemanticEvidence,
} from './semantic';
import { buildSemanticReservations, type SemanticReservation } from './semantic-reservation';
import { componentSemanticExtents } from './semantic-extent';
import {
  completeSemanticFamily,
  familySignatures,
  type FamilyPolygon,
  type FamilyScore,
} from './semantic-family';
import type { Suggestion } from './suggestions';
const noop = (): void => undefined;
const role = (id: string, patch: Partial<SemanticPart> = {}): SemanticPart => ({
  id,
  label: id,
  parentId: null,
  importance: 'major',
  confidence: 0.99,
  instances: 1,
  componentIds: [],
  cut: null,
  expectedGeometry: { kind: 'solid_part', likelySeparable: true },
  views: VIEW_NAMES.slice(0, 2).map((view) => ({
    view,
    polygons: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ],
  })),
  ...patch,
});
const hierarchy = (...parts: SemanticPart[]): SemanticHierarchy => ({
  object: { label: 'Structure', confidence: 0.99 },
  parts,
});
const candidate = (part: SemanticPart, components: readonly number[]): Suggestion => ({
  id: part.id,
  family: 'semantic',
  label: part.label,
  parentId: part.parentId,
  operation: 'COMPONENT',
  status: 'SUGGESTED',
  reason: 'CLEAR',
  quality: 'READY',
  plane: null,
  components,
});
function ownershipFixture(
  selected: readonly number[],
  inclusive = false,
  sibling = false,
  repeated = true,
): {
  p: PreparedSemanticGeometry;
  answer: SemanticHierarchy;
  suggestions: Suggestion[];
  support: Uint32Array[];
  reservations: SemanticReservation[];
} {
  const parent = role('target', { label: inclusive ? 'Physical assembly' : 'Physical part' });
  const child = role('reserved', {
    parentId: sibling ? null : parent.id,
    instances: repeated ? 3 : 1,
    expectedGeometry: { kind: repeated ? 'repeated_part' : 'solid_part', likelySeparable: true },
  });
  // Four source components, twelve foreground samples each, two independent views.
  const faces = Int32Array.from({ length: 48 }, (_, i) => Math.floor(i / 12));
  const p = {
    metadata: { components: [{}, {}, {}, {}] },
    labelling: { faceRank: Int32Array.from([0, 1, 2, 3]) },
    rasters: [{ face: faces }, { face: faces }],
  } as unknown as PreparedSemanticGeometry;
  const support = [0, 1].map(() =>
    Uint32Array.from(
      faces,
      (rank) => (selected.includes(rank) ? 1 : 0) | ([1, 2].includes(rank) ? 2 : 0),
    ),
  );
  return {
    p,
    answer: hierarchy(parent, child),
    suggestions: [candidate(parent, selected)],
    support,
    reservations: [
      { id: child.id, components: [1, 2], multiViewComponents: [1, 2], corroboratedComponents: [] },
    ],
  };
}
function admitted(f: ReturnType<typeof ownershipFixture>, reserve = true): boolean | undefined {
  return componentSemanticExtents(
    f.p,
    f.answer,
    f.suggestions,
    f.support,
    noop,
    noop,
    reserve ? f.reservations : [],
  ).get('target')?.admitted;
}
let p: PreparedSemanticGeometry,
  evidence: SemanticEvidence,
  repeated: SemanticPart,
  ranks: number[],
  polygons: FamilyPolygon[],
  scores: FamilyScore[];
beforeAll(async () => {
  const pieces = [
    box([-7, -2, 5], [7, 2, 6]),
    ...[-4, 0, 4].map((x) => box([x - 0.35, -0.35, 0], [x + 0.35, 0.35, 4])),
    box([7 - 0.35, 3 - 0.35, 7], [7 + 0.35, 3 + 0.35, 11]),
  ];
  p = await prepareSemanticGeometry(concatMeshes(pieces), fixtureDeflate);
  ranks = [12, 24, 36].map((f) => p.labelling.faceRank[f] ?? -1);
  repeated = role('repeated', {
    instances: 3,
    expectedGeometry: { kind: 'repeated_part', likelySeparable: true },
  });
  scores = p.facts.map((f) => ({
    rank: f.rank,
    strongViews: ranks.slice(0, 2).includes(f.rank) ? 2 : ranks.includes(f.rank) ? 1 : 0,
    viewCoverage: ranks.includes(f.rank) ? [1, 1, -1, -1, -1, -1] : [0, 0, -1, -1, -1, -1],
  }));
  polygons = [
    { view: 0, ranks: [ranks[0] ?? -1], purity: 1 },
    { view: 1, ranks: [ranks[0] ?? -1], purity: 1 },
    { view: 2, ranks: [ranks[1] ?? -1], purity: 1 },
    { view: 3, ranks: [ranks[1] ?? -1], purity: 1 },
    { view: 3, ranks: [ranks[2] ?? -1], purity: 1 },
  ];
  evidence = {
    id: repeated.id,
    components: scores,
    regionInstances: polygons.map((poly, polygon) => ({
      ...poly,
      polygon,
      view: VIEW_NAMES[poly.view] ?? 'front',
    })),
    multiViewFaces: 0,
    visibleFaces: 0,
    planePurity: null,
    reason: 'Controlled independent source observations',
  };
});
describe('ownership reservation is independent of execution', () => {
  it('refuses a parent containing one reserved child despite globally diluted family support', () => {
    const f = ownershipFixture([0, 1]);
    expect(admitted(f, false)).toBe(true);
    expect(admitted(f)).toBe(false);
  });
  it('a refused count-mismatched family still reserves only its directly grounded members', () => {
    const signatures = familySignatures(p, noop);
    const family = completeSemanticFamily(
      p,
      repeated,
      [],
      scores,
      polygons,
      () => signatures,
      noop,
    );
    expect(family?.ranks).toEqual([]);
    const claims = buildSemanticReservations(
      p,
      hierarchy(repeated),
      [evidence],
      () => signatures,
      noop,
      noop,
    );
    expect(claims.reservations[0]?.components).toEqual([...ranks].sort((a, b) => a - b));
    expect(claims.reservations[0]?.corroboratedComponents).toEqual(ranks.slice(2));
    expect(claims.components).toBe(3);
    expect(claims.scratchBytes).toBe(p.metadata.components.length);
  });
  it('allows a declared inclusive assembly with multi-view contained child evidence', () => {
    expect(admitted(ownershipFixture([0, 1, 2], true))).toBe(true);
  });
  it('a broad label alone does not grant inclusive scope', () => {
    expect(admitted(ownershipFixture([0, 1, 2]))).toBe(false);
  });
  it.each([false, true])(
    'protects a non-repeated physical child/sibling (sibling=%s)',
    (sibling) => {
      expect(admitted(ownershipFixture([0, 1], false, sibling, false))).toBe(false);
    },
  );
  it('an unrelated sibling reservation does not contaminate an exact target', () => {
    expect(admitted(ownershipFixture([0], false, true))).toBe(true);
  });
  it.each(['surface_part', 'unknown'] as const)(
    'does not reserve a %s role from a whole-component mask',
    (kind) => {
      const part = {
        ...repeated,
        expectedGeometry: { kind, likelySeparable: true },
        instances: 1,
      };
      const claims = buildSemanticReservations(
        p,
        hierarchy(part),
        [evidence],
        () => familySignatures(p, noop),
        noop,
        noop,
      );
      expect(claims.reservations).toEqual([]);
    },
  );
  it('does not create a separate child reservation from indistinguishable whole-component hierarchy masks', () => {
    const rank = ranks[0] ?? -1;
    const parent = role('parent');
    const child = role('child', { parentId: parent.id });
    const own: SemanticEvidence = {
      ...evidence,
      id: parent.id,
      components: scores.map((s) => ({
        ...s,
        strongViews: s.rank === rank ? 2 : 0,
        viewCoverage: s.rank === rank ? [1, 1, -1, -1, -1, -1] : [0, 0, -1, -1, -1, -1],
      })),
      regionInstances: [0, 1].map((view) => ({
        view: VIEW_NAMES[view] ?? 'front',
        polygon: 0,
        ranks: [rank],
        purity: 1,
      })),
    };
    const claims = buildSemanticReservations(
      p,
      hierarchy(parent, child),
      [own, { ...own, id: child.id }],
      () => familySignatures(p, noop),
      noop,
      noop,
    );
    expect(claims.reservations.map((r) => r.id)).toEqual([parent.id]);
  });
  it('does not reserve a low-confidence physical role', () => {
    expect(
      buildSemanticReservations(
        p,
        hierarchy({ ...repeated, confidence: 0.6 }),
        [evidence],
        () => familySignatures(p, noop),
        noop,
        noop,
      ).reservations,
    ).toEqual([]);
  });
  it('does not reserve from one noisy polygon without independent grounding', () => {
    const e = {
      ...evidence,
      components: scores.map((s) => ({ ...s, strongViews: s.rank === ranks[0] ? 1 : 0 })),
      regionInstances: evidence.regionInstances?.slice(0, 1) ?? [],
    };
    expect(
      buildSemanticReservations(
        p,
        hierarchy(repeated),
        [e],
        () => familySignatures(p, noop),
        noop,
        noop,
      ).reservations,
    ).toEqual([]);
  });
  it('cancellation publishes no partial reservation and does not mutate source', () => {
    const before = p.geometry.positions.slice();
    let visits = 0,
      published: ReturnType<typeof buildSemanticReservations> | undefined;
    expect(() => {
      published = buildSemanticReservations(
        p,
        hierarchy(repeated),
        [evidence],
        () => familySignatures(p, noop),
        () => {
          if (++visits === 3) throw Error('cancelled');
        },
        noop,
      );
    }).toThrow('cancelled');
    expect(published).toBeUndefined();
    expect(p.geometry.positions).toEqual(before);
  });
});
