/// <reference types="node" />
import type { OwnershipCompletionPlan } from './semantic-ownership-representative-completion';
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NormalizedGeometry } from './geometry';
import type { MaterialInterface } from './semantic-interface-membership';
import { interfaceMembershipSignature } from './semantic-interface-membership';
import type {
  StructuralTargetOwnershipAudit,
  ResolvedSourceOwnershipRow,
} from './semantic-structural-ownership';
import type { SemanticPlaneRefinement } from './semantic-plane';
import { ownershipCompleteness } from './semantic-ownership-completeness';
import {
  planOwnershipCompletion,
  admitOwnershipCompletion,
  type CompletionGates,
} from './semantic-ownership-representative-completion';
import { LOCAL_PLANE_LIMITS, bindRepresentativeRefinement } from './semantic-local-plane';
import { semanticNativePolicy } from './semantic-native';
const no = (): void => {
  // Intentionally empty hook; preserve the undefined return value.
};
const geometry: NormalizedGeometry = {
  positions: Float32Array.from([0.2, 0, 0, 0.2, 1, 0, 0.2, 0, 1, 0.6, 0, 0, 0.6, 1, 0, 0.6, 0, 1]),
  indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
  faceCount: 2,
  center: [0, 0, 0],
  scale: 1,
  radius: 1,
  extents: [1, 1, 1],
};
const region = (face: number): MaterialInterface => ({
  faces: [face],
  normal: [1, 0, 0],
  offset: face === 0 ? 0.2 : 0.6,
  area: 0.5,
  sourceFacesInspected: 2,
  clippedOperations: 0,
  scratchBytes: 0,
});
const body: ResolvedSourceOwnershipRow = {
  region: region(0),
  resolution: 'POSITIVELY_BODY_OWNED',
  ownership: 'BODY_SIDE',
  conflict: false,
};
const target: ResolvedSourceOwnershipRow = {
  region: region(1),
  resolution: 'POSITIVELY_TARGET_OWNED',
  ownership: 'TARGET_SIDE',
  conflict: false,
};
const refinement: SemanticPlaneRefinement = {
  cut: { normal: [1, 0, 0], origin: [0.5, 0, 0] },
  profileNormal: [1, 0, 0],
  sectionProfile: Array.from({ length: 9 }, (_, i) => ({ offset: i / 8, length: i < 4 ? 2 : 1 })),
  proposedOffset: 0.5,
  chosenOffset: 0.5,
  proposedSectionLength: 1,
  chosenSectionLength: 1,
  samples: 9,
};
const audit = (
  rows: readonly ResolvedSourceOwnershipRow[] = [body, target],
): StructuralTargetOwnershipAudit => ({
  resolvedInterfaces: rows,
  cardinality: {
    state: 'IDENTIFIED',
    reason: 'POSITIVE_SINGLE_TARGET_OWNERSHIP_CLASS',
    ownershipCompleteness: ownershipCompleteness(
      rows.map((r) => ({
        offset: r.region.offset,
        faces: r.region.faces.length,
        resolution: r.resolution,
      })),
    ),
    sourceComponentResolution: {
      proven: true,
      component: 0,
      evidenceKind: 'MATERIAL_INTERFACE_SOURCE',
      anchorFace: 0,
      provenanceFacesInspected: 1,
    },
    materialInterfaces: rows.length,
    interfaceComponents: rows.length,
    unresolvedClasses: 1,
    admittedCandidatesInspected: 2,
    sourceFaceVisits: 2,
    clippedOperations: 0,
    pixelVisits: 0,
    scratchBytes: 0,
    ownershipSignatures: 1,
  },
  signatures: [
    {
      candidate: 0,
      complete: true,
      key: rows
        .filter((r) => r.resolution !== 'PROVEN_IRRELEVANT')
        .map((r) => r.ownership)
        .join('|'),
      assignment: rows.map((r) => (r.ownership === 'AMBIGUOUS' ? 'INTERMEDIATE' : r.ownership)),
    },
  ],
});
const plan = (
  a = audit(),
  reps = 0,
  count = 2,
  existing: Parameters<typeof planOwnershipCompletion>[6] = [],
  ref = refinement,
  checkpoint = no,
  eligibility = 'EXECUTABLE',
): OwnershipCompletionPlan | undefined =>
  planOwnershipCompletion(geometry, a, eligibility, ref, reps, count, existing, checkpoint, no);
const gates = (): CompletionGates =>
  Object.fromEntries(
    [
      'semantic',
      'direct',
      'assembly',
      'peer',
      'scope',
      'connectivity',
      'seam',
      'membership',
      'key',
      'completeness',
      'source',
    ].map((k) => [k, (): true => true]),
  ) as unknown as CompletionGates;
const code = (n: string): string => readFileSync(new URL(n, import.meta.url), 'utf8');
it('01 existing legal representative suppresses completion', () => {
  expect(plan(audit(), 1)).toBeUndefined();
});
it('02 TARGET defines exact upper interval', () => {
  const p = requiredValue(plan(audit([target])));
  expect(p.safeInterval[1]).toBeCloseTo(0.6);
  expect(p.proposals.length).toBe(3);
});
it('03 BODY defines exact lower interval', () => {
  expect(requiredValue(plan(audit([body]))).safeInterval[0]).toBeCloseTo(0.2);
});
it('04 TARGET and BODY admit a nonempty interval', () => {
  const p = requiredValue(plan());
  expect(p.safeInterval[0]).toBeLessThan(p.safeInterval[1]);
});
it('05 incompatible TARGET/BODY produce no offsets', () => {
  const p = requiredValue(
    plan(
      audit([
        { ...target, region: region(0) },
        { ...body, region: region(1) },
      ]),
    ),
  );
  expect(p.proposals).toEqual([]);
});
it('06 irrelevant row adds no constraint', () => {
  const p = requiredValue(
    plan(audit([target, { ...body, resolution: 'PROVEN_IRRELEVANT', ownership: 'AMBIGUOUS' }])),
  );
  expect(p.safeInterval[0]).toBe(0);
});
it('07 unknown relevant row forbids completion', () => {
  expect(
    plan(audit([{ ...target, resolution: 'UNREPRESENTED_UNRESOLVED', ownership: 'AMBIGUOUS' }])),
  ).toBeUndefined();
});
it('08 conflict forbids completion', () => {
  expect(plan(audit([{ ...target, conflict: true }]))).toBeUndefined();
});
it('09 two-way forbids completion', () => {
  const a = audit();
  Object.assign(a, { cardinality: { ...a.cardinality, state: 'TWO_WAY_UNRESOLVED' } });
  expect(plan(a)).toBeUndefined();
});
it('10 multiway forbids completion', () => {
  const a = audit();
  Object.assign(a, { cardinality: { ...a.cardinality, state: 'MULTIWAY_UNRESOLVED' } });
  expect(plan(a)).toBeUndefined();
});
it('11 incomplete unresolved forbids completion', () => {
  const a = audit();
  Object.assign(a, {
    cardinality: {
      ...a.cardinality,
      ownershipCompleteness: {
        ...requiredValue(a.cardinality.ownershipCompleteness),
        state: 'INCOMPLETE_UNRESOLVED',
      },
    },
  });
  expect(plan(a)).toBeUndefined();
});
it('12 exact production fraction membership is preserved', () => {
  const p = requiredValue(plan());
  for (const x of p.proposals)
    for (const r of [body, target])
      expect(interfaceMembershipSignature(geometry, r.region, x.plane, no, no).ownership).toBe(
        r.ownership,
      );
});
it('13 STEP intersection remains within existing samples', () => {
  const p = requiredValue(plan(audit([target])));
  expect(p.safeInterval[0]).toBe(requiredValue(refinement.sectionProfile[0]).offset);
  expect(p.safeInterval[1]).toBeLessThanOrEqual(
    requiredValue(refinement.sectionProfile.at(-1)).offset,
  );
});
it('14 safe interior excludes fractional clipping strips', () => {
  const g = {
    ...geometry,
    positions: Float32Array.from([0, 0, 0, 1, 1, 0, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]),
    faceCount: 1,
  };
  const row = { ...target, region: { ...region(0), faces: [0] } };
  const p = requiredValue(
    planOwnershipCompletion(
      g,
      audit([row]),
      'EXECUTABLE',
      {
        ...refinement,
        sectionProfile: refinement.sectionProfile.map((x) => ({ ...x, offset: x.offset - 0.5 })),
      },
      0,
      0,
      [],
      no,
      no,
    ),
  );
  expect(p.ownershipInterval[1]).toBeGreaterThan(p.safeInterval[1]);
  expect(p.safeInterval[1]).toBe(0);
});
it('15 fixed midpoint quarter three-quarter order', () => {
  const p = requiredValue(plan());
  expect(p.proposals.map((x) => x.percentile)).toEqual([0.5, 0.25, 0.75]);
  const [a, b] = p.safeInterval;
  expect(requiredValue(p.proposals[0]).offset).toBe(a + 0.5 * (b - a));
});
it('16 equivalent existing offset is removed', () => {
  const mid = requiredValue(requiredValue(plan()).proposals[0]).plane;
  expect(requiredValue(plan(audit(), 0, 2, [mid])).proposals).toHaveLength(2);
});
it('17 existing64 cap remains unchanged', () => {
  expect(requiredValue(plan(audit(), 0, 64)).proposals).toHaveLength(0);
  expect(requiredValue(plan(audit(), 0, 63)).proposals).toHaveLength(1);
});
it('18 existing candidates are never evicted', () => {
  const planes = [{ normal: [1, 0, 0] as const, origin: [0.1, 0, 0] as const }];
  const before = JSON.stringify(planes);
  plan(audit(), 0, 2, planes);
  expect(JSON.stringify(planes)).toBe(before);
});
it('19 exact winning normal is reused', () => {
  const p = requiredValue(plan());
  expect(p.normal).toBe(refinement.profileNormal);
  for (const x of p.proposals) expect(x.plane.normal).toBe(refinement.profileNormal);
});
it('20 helper never invokes global generation or refinement', () => {
  const s = code('./semantic-ownership-representative-completion.ts');
  expect(s).not.toContain('synthesizeSemanticPlane(');
  expect(s).not.toContain('refineSemanticPlanes(');
});
it('21 direct semantic gate is independently rerun', () => {
  const direct = vi.fn(() => false);
  expect(
    admitOwnershipCompletion(requiredValue(plan()), { ...gates(), direct }, no, no),
  ).toHaveLength(0);
  expect(direct).toHaveBeenCalledTimes(3);
});
it('22 scope failure remains failure', () => {
  expect(
    admitOwnershipCompletion(requiredValue(plan()), { ...gates(), scope: () => false }, no, no),
  ).toHaveLength(0);
});
it('23 seam failure remains failure', () => {
  expect(
    admitOwnershipCompletion(requiredValue(plan()), { ...gates(), seam: () => false }, no, no),
  ).toHaveLength(0);
});
it('24 membership mismatch remains failure', () => {
  expect(
    admitOwnershipCompletion(
      requiredValue(plan()),
      { ...gates(), membership: () => false },
      no,
      no,
    ),
  ).toHaveLength(0);
});
it('25 connectivity failure remains failure', () => {
  expect(
    admitOwnershipCompletion(
      requiredValue(plan()),
      { ...gates(), connectivity: () => false },
      no,
      no,
    ),
  ).toHaveLength(0);
});
it('26 semantic key is preserved and verified', () => {
  const p = requiredValue(plan());
  expect(p.semanticKey).toBe('BODY_SIDE|TARGET_SIDE');
  expect(admitOwnershipCompletion(p, { ...gates(), key: () => false }, no, no)).toHaveLength(0);
});
it('27 multiple keys cannot invent confirmation', () => {
  const a = audit();
  Object.assign(a, {
    signatures: [
      ...a.signatures,
      {
        candidate: 1,
        key: 'TARGET_SIDE|TARGET_SIDE',
        complete: true,
        assignment: ['TARGET_SIDE', 'TARGET_SIDE'],
      },
    ],
  });
  expect(plan(a)).toBeUndefined();
});
it('28 native cap unchanged', () => {
  expect(LOCAL_PLANE_LIMITS.finalists).toBe(3);
  expect(semanticNativePolicy(100).finalistsPerPart).toBe(3);
});
it('29 no generation occurs after downstream rejection', () => {
  const p = requiredValue(plan()),
    before = JSON.stringify(p.proposals);
  admitOwnershipCompletion(p, { ...gates(), direct: () => false }, no, no);
  expect(JSON.stringify(p.proposals)).toBe(before);
  expect(code('./semantic-ownership-representative-completion.ts')).not.toContain(
    'splitWithConnectors',
  );
});
it('30 interval construction cancellation propagates', () => {
  expect(() =>
    plan(audit(), 0, 2, [], refinement, () => {
      throw Error('cancelled');
    }),
  ).toThrow('cancelled');
});
it('31 completion scoring cancellation propagates', () => {
  expect(() =>
    admitOwnershipCompletion(
      requiredValue(plan()),
      gates(),
      () => {
        throw Error('cancelled');
      },
      no,
    ),
  ).toThrow('cancelled');
});
it('32 source byte identity preserved before Apply', () => {
  const before = geometry.positions.slice(),
    indices = geometry.indices.slice();
  admitOwnershipCompletion(requiredValue(plan()), gates(), no, no);
  expect(geometry.positions).toEqual(before);
  expect(geometry.indices).toEqual(indices);
});
it('33 selected metadata binds actual candidate section', () => {
  const p = requiredValue(requiredValue(plan()).proposals[1]),
    bound = bindRepresentativeRefinement(geometry, refinement, p.plane, no, no);
  expect(bound.cut).toBe(p.plane);
  expect(bound.chosenOffset).toBe(p.offset);
  expect(bound.sectionProfile).toBe(refinement.sectionProfile);
});
it('34 STEP with ordinary representative is unchanged', () => {
  expect(plan(audit(), 2)).toBeUndefined();
  expect(plan(audit(), 0, 2, [], refinement, no, 'NON_EXECUTABLE')).toBeUndefined();
});
it('35 minimum-route behavior receives no completion', () => {
  const ref = {
    ...refinement,
    sectionProfile: refinement.sectionProfile.map((x, i) => ({
      ...x,
      length: i < 2 || i > 6 ? 2 : 1,
    })),
  };
  expect(plan(audit(), 0, 2, [], ref)).toBeUndefined();
});
it('36 product logic contains no benchmark witness truth', () => {
  const s =
    code('./semantic-ownership-representative-completion.ts') + code('./semantic-local-plane.ts');
  for (const token of [
    's26-10',
    'P352',
    'Q50',
    '0.054127338972350426',
    '0.9214749245359564',
    'clippedAgreement',
  ])
    expect(s).not.toContain(token);
});

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
