import { describe, it, expect } from 'vitest';
import {
  assessPhysicalOperations,
  type PhysicalOperation,
  type PhysicalRole,
} from './semantic-physical';
const roles: PhysicalRole[] = [
  { concept: 'plate', faces: [0, 1] },
  {
    concept: 'wheels',
    faces: [2, 3, 4, 5],
    instances: [
      [2, 3],
      [4, 5],
    ],
  },
];
const op = (patch: Partial<PhysicalOperation> = {}): PhysicalOperation => ({
  id: 'part',
  selected: [0, 1],
  semanticConcept: 'plate',
  kind: 'component',
  nativeValid: true,
  familyMode: 'none',
  declaredCount: 1,
  ...patch,
});
describe('prospective attributed physical versus naming qualification', () => {
  it('exact physical geometry with an unmatched harmless phrase is a label miss only', () => {
    expect(assessPhysicalOperations(roles, [op({ semanticConcept: null })])[0]).toMatchObject({
      physicalReadyError: false,
      semanticLabelMiss: true,
      physicalValid: true,
      namedValid: false,
      attribution: 'UNIQUE_EXACT_SOURCE',
    });
  });
  it('an exact different physical scope is naming quality, not an invented CAD error', () => {
    expect(assessPhysicalOperations(roles, [op({ semanticConcept: 'wheels' })])[0]).toMatchObject({
      physicalConcept: 'plate',
      physicalReadyError: false,
      semanticLabelMiss: true,
    });
  });
  it('overbroad geometry is a physical error, never an exact-scope wording fallback', () => {
    expect(
      assessPhysicalOperations(roles, [op({ selected: [0, 1, 2] })])[0]?.physicalReadyError,
    ).toBe(true);
  });
  it('does not rescue a small tabletop plus one large leg as the leg via approximate fallback', () => {
    const physical = [
      { concept: 'top', faces: [0, 1] },
      { concept: 'leg', faces: Array.from({ length: 20 }, (_, i) => i + 2) },
    ];
    expect(
      assessPhysicalOperations(physical, [
        op({ semanticConcept: 'top', selected: Array.from({ length: 22 }, (_, i) => i) }),
      ])[0]?.physicalReadyError,
    ).toBe(true);
  });
  it('native-invalid final plane READY has its own safety error', () => {
    expect(
      assessPhysicalOperations(roles, [op({ kind: 'plane', nativeValid: false })])[0],
    ).toMatchObject({ physicalReadyError: false, nativeReadyError: true, physicalValid: false });
  });
  it('wrong declared family count is independently unsafe despite correct union', () => {
    expect(
      assessPhysicalOperations(roles, [
        op({
          selected: [2, 3, 4, 5],
          semanticConcept: 'wheels',
          familyMode: 'family',
          declaredCount: 3,
        }),
      ])[0],
    ).toMatchObject({
      physicalReadyError: false,
      familyMembershipError: true,
      physicalValid: false,
    });
  });
  it('missing family member is not complete', () => {
    expect(
      assessPhysicalOperations(roles, [
        op({ selected: [2, 3], semanticConcept: 'wheels', familyMode: 'family', declaredCount: 2 }),
      ])[0]?.familyMembershipError,
    ).toBe(true);
  });
  it('partial independently proven members may be physically valid without a complete root', () => {
    expect(
      assessPhysicalOperations(roles, [
        op({
          selected: [2, 3],
          semanticConcept: 'wheels',
          familyMode: 'individual',
          familyId: 'wheels',
        }),
      ])[0],
    ).toMatchObject({ physicalValid: true, physicalConcept: 'wheels', instanceIndex: 0 });
  });
  it('duplicate individual membership flags both children', () => {
    const child = op({
      selected: [2, 3],
      semanticConcept: 'wheels',
      familyMode: 'individual',
      familyId: 'wheels',
    });
    expect(
      assessPhysicalOperations(roles, [child, { ...child, id: 'second' }]).every(
        (r) => r.familyMembershipError && !r.physicalValid,
      ),
    ).toBe(true);
  });
  it('does not flag the intentional complete group/individual alternatives as duplicates', () => {
    const child = op({
        selected: [2, 3],
        semanticConcept: 'wheels',
        familyMode: 'individual',
        familyId: 'wheels',
      }),
      root = op({
        id: 'root',
        selected: [2, 3, 4, 5],
        semanticConcept: 'wheels',
        familyMode: 'family',
        declaredCount: 2,
        familyId: 'wheels',
      });
    expect(assessPhysicalOperations(roles, [root, child]).every((r) => r.physicalValid)).toBe(true);
  });
  it('strict unknown refuses every executable operation', () => {
    expect(
      assessPhysicalOperations(
        [{ concept: 'whole', faces: [0, 1] }],
        [op({ semanticConcept: 'whole' })],
        true,
      )[0]?.physicalReadyError,
    ).toBe(true);
  });
  it('ambiguous exact scopes cannot be assigned by arbitrary order', () => {
    expect(
      assessPhysicalOperations(
        [...roles, { concept: 'other', faces: [0, 1] }],
        [op({ semanticConcept: null })],
      )[0]?.physicalReadyError,
    ).toBe(true);
  });
  it('surface membership standards stay at90 percent for a frozen named scope', () => {
    const role = { concept: 'plate', faces: Array.from({ length: 10 }, (_, i) => i) };
    expect(
      assessPhysicalOperations(
        [role],
        [op({ selected: Array.from({ length: 9 }, (_, i) => i) })],
      )[0]?.physicalValid,
    ).toBe(true);
    expect(
      assessPhysicalOperations(
        [role],
        [op({ selected: Array.from({ length: 8 }, (_, i) => i) })],
      )[0]?.physicalValid,
    ).toBe(false);
  });
});

it('rejects a component with failed exact source partition qualification', () => {
  expect(assessPhysicalOperations(roles, [op({ nativeValid: false })])[0]).toMatchObject({
    physicalReadyError: true,
    nativeReadyError: false,
  });
});
it('rejects any extra physical family member even within the90 percent face standard', () => {
  const family = {
    concept: 'members',
    faces: Array.from({ length: 20 }, (_, i) => i),
    instances: [
      Array.from({ length: 10 }, (_, i) => i),
      Array.from({ length: 10 }, (_, i) => i + 10),
    ],
  };
  expect(
    assessPhysicalOperations(
      [family],
      [
        op({
          semanticConcept: 'members',
          familyMode: 'family',
          declaredCount: 2,
          selected: Array.from({ length: 21 }, (_, i) => i),
        }),
      ],
    )[0],
  ).toMatchObject({ familyMembershipError: true, physicalValid: false });
});
it('does not reassign a repeated individual to a non-family body scope', () => {
  expect(
    assessPhysicalOperations(roles, [
      op({ semanticConcept: 'wheels', familyMode: 'individual' }),
    ])[0]?.familyMembershipError,
  ).toBe(true);
});

it('scores raw singly named repeated members against one frozen physical instance', () => {
  expect(
    assessPhysicalOperations(roles, [
      op({ selected: [2, 3], semanticConcept: 'wheels', familyMode: 'none' }),
    ])[0],
  ).toMatchObject({ physicalValid: true, instanceIndex: 0 });
});
it('flags duplicate raw singly named family members even with different semantic IDs', () => {
  const a = op({ id: 'left', selected: [2, 3], semanticConcept: 'wheels', familyMode: 'none' });
  expect(
    assessPhysicalOperations(roles, [a, { ...a, id: 'right' }]).every(
      (r) => r.familyMembershipError,
    ),
  ).toBe(true);
});
