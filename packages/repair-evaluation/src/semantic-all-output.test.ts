import { requiredValue } from './semantic-invariant';
import { it, expect } from 'vitest';
import {
  familyControl,
  independentControl,
  fusedControl,
  unknownControl,
} from './semantic-controls';
import { faceComponents, digest, meshDigest, type FixtureEvidence } from './semantic-fixture';
import {
  scoreAllOutputs,
  selectedPlaneFaces,
  type FinalOutput,
  type RealizationInput,
} from './semantic-all-output';
const evidence: FixtureEvidence = { planes: [], connectors: [] };
function input(f: ReturnType<typeof independentControl>): RealizationInput {
  const components = faceComponents(f.mesh),
    faceRank = Array.from({ length: f.mesh.indices.length / 3 }, (_, i) =>
      components.findIndex((c) => c.includes(i)),
    );
  return { suggestions: [], faceRank, native: [], semanticRecords: [] };
}
const component = (
  id: string,
  ranks: number[],
  parentId: string | null = null,
  count = 1,
): FinalOutput => ({
  id,
  parentId,
  quality: 'READY',
  operation: 'COMPONENT',
  components: ranks,
  plane: null,
  instanceCount: count,
});
it('physical realization and exact source attribution are independent of labels and root record existence', () => {
  const f = independentControl(),
    i = input(f);
  i.suggestions = [component('generated-left', [0]), component('authored-right', [1])];
  i.semanticRecords = [
    {
      id: 'authored-right',
      parentId: null,
      label: 'novel neutral support',
      instances: 1,
      instanceAnnotations: [],
    },
  ];
  const r = scoreAllOutputs(f, evidence, i);
  expect(r.status).toBe('SCORED');
  if (r.status !== 'SCORED') throw Error('Expected SCORED');
  expect(r.operations).toHaveLength(2);
  expect(r.operations.filter((o) => o.generated)).toHaveLength(1);
  expect(r.metrics.PHYSICAL_READY_ERRORS).toBe(0);
  expect(r.metrics.PHYSICAL_REALIZATION_RATE).toMatchObject({ numerator: 2, denominator: 2 });
  expect(r.metrics.SEMANTICALLY_NAMED_REALIZATION_RATE.numerator).toBe(0);
  expect(r.operations.find((o) => o.id === 'generated-left')).toMatchObject({
    bestPhysicalRole: { id: 'left', precision: 1, recall: 1 },
    secondBestRole: { id: 'right' },
    dominanceMargin: 1,
  });
  i.semanticRecords = [
    { id: 'authored-right', parentId: null, label: 'right', instances: 1, instanceAnnotations: [] },
  ];
  expect(
    scoreAllOutputs(f, evidence, i).metrics?.SEMANTICALLY_NAMED_REALIZATION_RATE.numerator,
  ).toBe(1);
});
it('every READY alternative competes; reservations and non-READY outputs do not realize concepts', () => {
  const f = familyControl(true),
    i = input(f);
  i.suggestions = [
    component('family', [0, 1], null, 2),
    component('child-a', [0], 'family'),
    component('child-b', [1], 'family'),
    { ...component('reservation', [2]), quality: 'SUGGESTED' },
  ];
  i.semanticRecords = [
    {
      id: 'family',
      parentId: null,
      label: 'supports',
      instances: 2,
      instanceAnnotations: [requiredValue(f.roles.find((r) => r.id === 'left')).faces],
    },
  ];
  const r = scoreAllOutputs(f, evidence, i);
  if (r.status !== 'SCORED') throw Error('Expected SCORED');
  expect(r.operations).toHaveLength(3);
  expect(r.operations.filter((o) => o.generated)).toHaveLength(2);
  expect(r.metrics.PHYSICAL_READY_ERRORS).toBe(0);
  expect(r.metrics.FAMILY_MEMBERSHIP_ERRORS).toBe(0);
  expect(r.metrics.PHYSICAL_REALIZATION_RATE.concepts).toContain('supports');
  expect(r.metrics.PHYSICAL_REALIZATION_RATE.concepts).not.toContain('spare');
  expect(r.metrics.families[0]).toMatchObject({
    FAMILY_ROLE_RECOGNITION: true,
    FAMILY_COUNT_ACCURACY: true,
    FAMILY_MEMBERSHIP_SEMANTIC_ACCURACY: true,
    OBSERVABLE_INSTANCE_COVERAGE: { numerator: 1, denominator: 2 },
  });
});
it('partial children never count as complete-family realization, duplicate sibling ownership fails', () => {
  const f = familyControl(),
    i = input(f);
  i.suggestions = [component('a', [0], 'root')];
  i.semanticRecords = [
    { id: 'root', parentId: null, label: 'supports', instances: 2, instanceAnnotations: [] },
  ];
  const r = scoreAllOutputs(f, evidence, i);
  expect(r.metrics?.PHYSICAL_REALIZATION_RATE.concepts).toEqual(['left']);
  i.suggestions = [...i.suggestions, component('b', [0], 'root')];
  expect(scoreAllOutputs(f, evidence, i).metrics?.FAMILY_MEMBERSHIP_ERRORS).toBe(2);
});
it('spares and foreign source cannot become family members through naming', () => {
  const f = familyControl(true),
    i = input(f);
  i.suggestions = [component('root', [0, 2], null, 2)];
  i.semanticRecords = [
    {
      id: 'root',
      parentId: null,
      label: 'supports',
      instances: 2,
      instanceAnnotations: [
        requiredValue(f.roles.find((r) => r.id === 'left')).faces,
        requiredValue(f.roles.find((r) => r.id === 'spare')).faces,
      ],
    },
  ];
  const r = scoreAllOutputs(f, evidence, i);
  expect(r.metrics?.PHYSICAL_READY_ERRORS).toBe(1);
  expect(r.metrics?.families[0]?.FAMILY_MEMBERSHIP_SEMANTIC_ACCURACY).toBe(false);
});
it('count errors, native errors, physical errors, unknown execution remain distinct', () => {
  const f = familyControl(),
    i = input(f);
  i.suggestions = [component('family', [0, 1], null, 3)];
  const r = scoreAllOutputs(f, evidence, i);
  expect(r.metrics).toMatchObject({
    PHYSICAL_READY_ERRORS: 0,
    NATIVE_READY_ERRORS: 0,
    FAMILY_MEMBERSHIP_ERRORS: 1,
    STRICT_UNKNOWN_EXECUTABLE: 0,
  });
  const u = unknownControl(),
    ui = input(u);
  ui.suggestions = [component('unknown', [0])];
  expect(scoreAllOutputs(u, evidence, ui).metrics?.STRICT_UNKNOWN_EXECUTABLE).toBe(1);
});
it('recognition of refused fused visible regions survives no executable realization', () => {
  const f = fusedControl(),
    i = input(f);
  i.semanticRecords = [
    { id: 'u', parentId: null, label: 'middle', instances: 1, instanceAnnotations: [] },
  ];
  const r = scoreAllOutputs(f, evidence, i);
  expect(r.metrics?.SEMANTIC_RECOGNITION.numerator).toBe(1);
  expect(r.metrics?.PHYSICAL_REALIZATION_RATE).toMatchObject({ numerator: 0, denominator: 0 });
});
it('a plane with a novel name is physically valid; native proof binds actual plane and source', () => {
  const f = fusedControl(true),
    i = input(f),
    p = requiredValue(f.planes[0]),
    plane = { normal: p.normal, origin: p.origin },
    selected = selectedPlaneFaces(f, plane),
    e: FixtureEvidence = {
      planes: [
        {
          role: 'upper',
          selected,
          complement: i.faceRank.flatMap((_, n) => (selected.includes(n) ? [] : [n])),
          plane: p,
          sourceHash: meshDigest(f.mesh),
          nativeValid: true,
          closedOutputs: true,
          detail: { unitTestDouble: true },
        },
      ],
      connectors: [],
    };
  const lower = requiredValue(f.planes.find((p) => p.role === 'lower')),
    lowerSelected = selectedPlaneFaces(f, lower);
  e.planes.push({
    role: 'lower',
    selected: lowerSelected,
    complement: i.faceRank.flatMap((_, n) => (lowerSelected.includes(n) ? [] : [n])),
    plane: lower,
    sourceHash: meshDigest(f.mesh),
    nativeValid: true,
    closedOutputs: true,
    detail: { unitTestDouble: true },
  });
  i.suggestions = [
    {
      id: 'top',
      parentId: null,
      operation: 'PLANE',
      quality: 'READY',
      components: [],
      plane,
      instanceCount: 1,
    },
  ];
  i.semanticRecords = [
    {
      id: 'top',
      parentId: null,
      label: 'new neutral phrase',
      instances: 1,
      instanceAnnotations: [],
    },
  ];
  i.native = [{ id: 'top', sourceHash: meshDigest(f.mesh), planeHash: digest(plane), valid: true }];
  expect(scoreAllOutputs(f, e, i).metrics).toMatchObject({
    PHYSICAL_READY_ERRORS: 0,
    NATIVE_READY_ERRORS: 0,
    PHYSICAL_REALIZATION_RATE: { numerator: 1 },
    SEMANTICALLY_NAMED_REALIZATION_RATE: { numerator: 0 },
  });
  i.native = [{ ...requiredValue(i.native[0]), planeHash: 'different' }];
  expect(scoreAllOutputs(f, e, i).metrics?.NATIVE_READY_ERRORS).toBe(1);
});
it('ambiguous legal scopes remain ambiguous despite an exact semantic name', () => {
  const f = fusedControl(true),
    p = requiredValue(f.planes[0]),
    plane = { normal: p.normal, origin: p.origin },
    i = input(f);
  const upper = requiredValue(f.roles[1]);
  upper.parent = 'aggregate';
  f.roles.push({
    ...upper,
    id: 'aggregate',
    scope: 'ASSEMBLY_SCOPE',
    parent: null,
    children: ['upper'],
    parentPolicy: 'AGGREGATE_ONLY',
    naming: { ...upper.naming, canonical: 'aggregate' },
  });
  f.planes.push({ ...p, role: 'aggregate' });
  const planes = f.planes.map((p) => ({
    role: p.role,
    selected: selectedPlaneFaces(f, p),
    complement: i.faceRank.flatMap((_, n) => (selectedPlaneFaces(f, p).includes(n) ? [] : [n])),
    plane: p,
    sourceHash: meshDigest(f.mesh),
    nativeValid: true,
    closedOutputs: true,
    detail: { unitTestDouble: true },
  }));
  i.suggestions = [
    {
      id: 'top',
      parentId: null,
      operation: 'PLANE',
      quality: 'READY',
      components: [],
      plane,
      instanceCount: 1,
    },
  ];
  i.semanticRecords = [
    { id: 'top', parentId: null, label: 'upper', instances: 1, instanceAnnotations: [] },
  ];
  const r = scoreAllOutputs(f, { planes, connectors: [] }, i);
  expect(r.status).toBe('SCORED');
  if (r.status !== 'SCORED') throw Error('Expected SCORED');
  expect(r.operations[0]?.attribution).toBe('AMBIGUOUS');
  expect(r.operations[0]?.dominanceMargin).toBe(0);
});
it('source membership map cannot be forged to merge/split components', () => {
  const f = independentControl(),
    i = input(f);
  i.faceRank = i.faceRank.map(() => 0);
  expect(() => scoreAllOutputs(f, evidence, i)).toThrow('COMPONENT_MAP');
});
it('invalid fixtures produce INVALID_FIXTURE rather than semantic safety counts', () => {
  const f = familyControl();
  f.expected.components = 20;
  const r = scoreAllOutputs(f, evidence, input(f));
  expect(r.status).toBe('INVALID_FIXTURE');
  expect(r.metrics).toBeNull();
});
it('Feet and lower-limb assembly are not globally interchangeable', () => {
  const f = independentControl();
  requiredValue(f.roles[0]).naming = {
    canonical: 'Lower-limb assembly',
    policy: 'REQUIRED_FUNCTIONAL_NAME',
    synonyms: ['Leg assembly'],
    structural: [],
    notEquivalent: ['Feet'],
  };
  const i = input(f);
  i.suggestions = [component('a', [0])];
  i.semanticRecords = [
    { id: 'a', parentId: null, label: 'Feet', instances: 1, instanceAnnotations: [] },
  ];
  const r = scoreAllOutputs(f, evidence, i);
  expect(r.metrics?.PHYSICAL_READY_ERRORS).toBe(0);
  if (r.status !== 'SCORED') throw Error('Expected SCORED');
  expect(r.operations[0]?.namedValid).toBe(false);
});
it('straddling source faces are refused rather than centroid-attributed', () => {
  const f = independentControl();
  expect(() => selectedPlaneFaces(f, { normal: [1, 1, 0], origin: [1, 0, 0] })).toThrow(
    'STRADDLING',
  );
});
it('prospective ontology is contextual and forbids broad extent substitutions', async () => {
  const { CONTEXTUAL_NAMING } = await import('./semantic-ontology');
  const f = independentControl(),
    role = requiredValue(f.roles[0]);
  const { nameMatches } = await import('./semantic-all-output');
  role.naming = structuredClone(requiredValue(CONTEXTUAL_NAMING.chair_armrests));
  expect(nameMatches(role, 'Armrests')).toBe(true);
  expect(nameMatches(role, 'Upper limbs')).toBe(false);
  role.naming = structuredClone(requiredValue(CONTEXTUAL_NAMING.ambiguous_upper_block));
  expect(nameMatches(role, 'Upper block')).toBe(true);
  expect(nameMatches(role, 'Whole pedestal')).toBe(false);
  role.naming = structuredClone(requiredValue(CONTEXTUAL_NAMING.lower_limb_assembly));
  expect(nameMatches(role, 'Feet')).toBe(false);
});
