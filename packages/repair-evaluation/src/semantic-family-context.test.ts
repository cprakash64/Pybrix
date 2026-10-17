import { requiredValue } from './semantic-invariant';
import { expect, it } from 'vitest';
import { familyControl } from './semantic-controls';
import { faceComponents } from './semantic-fixture';
import {
  scoreAllOutputs,
  type FinalOutput,
  type RealizationInput,
  type AllOutputScore,
} from './semantic-all-output';
import { semanticGraph, type SemanticRecord } from './semantic-family-context';
const evidence = { planes: [], connectors: [] };
const fixture = familyControl();
const components = faceComponents(fixture.mesh);
const faceRank = Array.from({ length: fixture.mesh.indices.length / 3 }, (_, face) =>
  components.findIndex((c) => c.includes(face)),
);
const rank = (role: string): number =>
  requiredValue(
    faceRank[requiredValue(requiredValue(fixture.roles.find((r) => r.id === role)).faces[0])],
  );
const record = (
  id: string,
  parentId: string | null,
  label: string,
  instances = 1,
): SemanticRecord => ({ id, parentId, label, instances, instanceAnnotations: [] });
const records = [
  record('assembly', null, 'assembly'),
  record('family', 'assembly', 'supports', 2),
  record('a', 'family', 'left'),
  record('b', 'family', 'right'),
  record('host', 'assembly', 'host'),
];
const output = (
  id: string,
  parentId: string | null,
  roles: string[],
  instanceCount = 1,
): FinalOutput => ({
  id,
  parentId,
  quality: 'READY',
  operation: 'COMPONENT',
  components: roles.map(rank),
  plane: null,
  instanceCount,
});
const score = (
  semanticRecords: readonly SemanticRecord[],
  suggestions: readonly FinalOutput[],
): AllOutputScore =>
  scoreAllOutputs(fixture, evidence, { semanticRecords, suggestions, faceRank, native: [] });
function permutations<T>(values: readonly T[]): T[][] {
  return values.length
    ? values.flatMap((v, i) =>
        permutations(values.filter((_, j) => i !== j)).map((rest) => [v, ...rest]),
      )
    : [[]];
}
it('all 120 record permutations, all 24 output permutations and all 2880 combined permutations are identical', () => {
  const suggestions = [
    output('family', 'assembly', ['left', 'right'], 2),
    output('generated-a', 'family', ['left']),
    output('generated-b', 'family', ['right']),
    output('host', 'assembly', ['host']),
  ];
  const expected = score(records, suggestions);
  expect(expected.status).toBe('SCORED');
  expect(expected.metrics?.FAMILY_MEMBERSHIP_ERRORS).toBe(0);
  expect(expected.operations).toHaveLength(4);
  const recordOrders = permutations(records),
    outputOrders = permutations(suggestions);
  expect(recordOrders).toHaveLength(120);
  expect(outputOrders).toHaveLength(24);
  for (const order of recordOrders) expect(score(order, suggestions)).toEqual(expected);
  for (const order of outputOrders) expect(score(records, order)).toEqual(expected);
  for (const rs of recordOrders)
    for (const os of outputOrders) expect(score(rs, os)).toEqual(expected);
}, 60000);
it.each([
  ['correct authored child', output('a', 'family', ['left']), 0, true],
  ['foreign authored child', output('a', 'family', ['host']), 1, true],
  ['complete family', output('family', 'assembly', ['left', 'right'], 2), 0, true],
  ['foreign complete group', output('family', 'assembly', ['left', 'right', 'host'], 2), 1, false],
  ['wrong count', output('family', 'assembly', ['left', 'right'], 3), 1, true],
  ['generated true child', output('generated', 'family', ['left']), 0, true],
  ['generated foreign child', output('generated', 'family', ['host']), 1, true],
  [
    'generated complete group',
    { ...output('generated', 'family', ['left', 'right'], 2), sourceSemanticId: 'family' },
    0,
    true,
  ],
  [
    'generated foreign group',
    { ...output('generated', 'family', ['left', 'right', 'host'], 2), sourceSemanticId: 'family' },
    1,
    false,
  ],
  ['ordinary standalone', output('standalone', null, ['host']), 0, true],
] as const)('%s is invariant for all record orders', (_name, suggestion, errors, physicalValid) => {
  const expected = score(records, [suggestion]);
  expect(expected.status).toBe('SCORED');
  expect(expected.metrics?.FAMILY_MEMBERSHIP_ERRORS).toBe(errors);
  expect(expected.operations[0]?.physicalValid).toBe(physicalValid);
  if (errors) {
    expect(expected.operations[0]?.namedValid).toBe(false);
    expect(expected.metrics?.PHYSICAL_REALIZATION_RATE.concepts).not.toContain('supports');
  }
  for (const rs of permutations(records)) expect(score(rs, [suggestion])).toEqual(expected);
});
it('duplicate source members cannot satisfy ownership; source extraction stays physical', () => {
  const os = [output('x', 'family', ['left']), output('y', 'family', ['left'])];
  for (const rs of permutations(records))
    for (const order of permutations(os)) {
      const r = score(rs, order);
      expect(r.metrics?.FAMILY_MEMBERSHIP_ERRORS).toBe(2);
      expect(r.operations.every((o) => o.physicalValid && !o.namedValid)).toBe(true);
      expect(r.metrics?.PHYSICAL_REALIZATION_RATE.concepts).not.toContain('supports');
    }
});
it('nearest family wins through intermediate assemblies and does not skip a nested family', () => {
  const rs = [
    record('assembly', null, 'assembly'),
    record('outer', 'assembly', 'outer family', 2),
    record('inner', 'outer', 'supports', 2),
    record('a', 'inner', 'left'),
  ];
  for (const order of permutations(rs)) {
    const r = score(order, [output('a', 'inner', ['left'])]);
    expect(r.metrics?.FAMILY_MEMBERSHIP_ERRORS).toBe(0);
    expect(r.operations[0]?.familyContext).toMatchObject({
      state: 'FAMILY_MEMBER',
      semanticFamilyRecordId: 'inner',
      provenancePath: ['a', 'inner'],
      expectedFamilyId: 'supports',
    });
  }
  const graph = semanticGraph([
    record('assembly', null, 'assembly'),
    record('middle', 'assembly', 'subassembly'),
    record('family', 'middle', 'supports', 2),
    record('a', 'family', 'left'),
  ]);
  expect(graph.context(output('a', 'family', ['left'])).semanticFamilyRecordId).toBe('family');
  const viaIntermediate = semanticGraph([
    record('family', null, 'supports', 2),
    record('middle', 'family', 'middle'),
    record('a', 'middle', 'left'),
  ]);
  expect(viaIntermediate.context(output('a', 'middle', ['left'])).provenancePath).toEqual([
    'a',
    'middle',
    'family',
  ]);
});
it('nonfamily ancestry and identical ordinary labels never create family ancestry', () => {
  const rs = records.map((r) => ({ ...r, label: r.id === 'host' ? 'supports' : r.label }));
  for (const order of permutations(rs)) {
    const r = score(order, [output('host', 'assembly', ['host'])]);
    expect(r.operations[0]?.familyContext.state).toBe('NONE');
    expect(r.metrics?.FAMILY_MEMBERSHIP_ERRORS).toBe(0);
  }
  const rs2 = [
    record('one', null, 'identical', 2),
    record('two', null, 'identical', 2),
    record('a', 'one', 'same'),
    record('b', 'two', 'same'),
  ];
  for (const order of permutations(rs2)) {
    const graph = semanticGraph(order);
    expect(graph.context(output('a', 'one', ['left'])).semanticFamilyRecordId).toBe('one');
    expect(graph.context(output('b', 'two', ['right'])).semanticFamilyRecordId).toBe('two');
  }
});
it.each([
  ['duplicate ID', [requiredValue(records[0]), requiredValue(records[0])]],
  ['missing parent', [record('a', 'missing', 'left')]],
  ['cycle', [record('a', 'b', 'left'), record('b', 'a', 'right')]],
  ['self parent', [record('a', 'a', 'left')]],
  [
    'depth five',
    [
      record('a', null, 'a'),
      record('b', 'a', 'b'),
      record('c', 'b', 'c'),
      record('d', 'c', 'd'),
      record('e', 'd', 'e'),
    ],
  ],
  [
    'ambiguous matching roots',
    [record('one', null, 'supports', 2), record('two', null, 'supports', 2)],
  ],
] as const)('%s fails closed for every permutation', (_name, rs) => {
  for (const order of permutations(rs)) {
    const r = score(order, []);
    expect(r.status).toBe('INVALID_SCORER_INPUT');
    expect(r.qualificationEligible).toBe(false);
    expect(r.metrics).toBeNull();
    expect(r.operations).toEqual([]);
  }
});
it('missing and contradictory generated provenance fail closed', () => {
  for (const suggestion of [
    output('g', 'missing', ['host']),
    { ...output('g', 'family', ['left', 'right'], 2), sourceSemanticId: 'missing' },
    output('a', 'assembly', ['left']),
    { ...output('g', 'assembly', ['left', 'right'], 2), sourceSemanticId: 'family' },
  ]) {
    const r = score(records, [suggestion]);
    expect(r.status).toBe('INVALID_SCORER_INPUT');
    expect(r.metrics).toBeNull();
  }
});
it('family A/B/C/D remain separate, including a declared repeated family with incorrect singleton count', () => {
  const root = {
    ...record('family', null, 'supports', 1),
    kind: 'repeated_part',
    instanceAnnotations: [requiredValue(fixture.roles.find((r) => r.id === 'left')).faces],
  };
  const r = score([root], []);
  expect(r.metrics?.families[0]).toEqual({
    id: 'supports',
    FAMILY_ROLE_RECOGNITION: true,
    FAMILY_COUNT_ACCURACY: false,
    FAMILY_MEMBERSHIP_SEMANTIC_ACCURACY: true,
    OBSERVABLE_INSTANCE_COVERAGE: { numerator: 1, denominator: 2 },
  });
});
it('missing explicit semantic parent metadata fails closed rather than guessing', () => {
  const invalid = {
    id: 'family',
    label: 'supports',
    instances: 2,
    instanceAnnotations: [],
  } as unknown as SemanticRecord;
  const input: RealizationInput = {
    semanticRecords: [invalid],
    suggestions: [],
    faceRank,
    native: [],
  };
  expect(scoreAllOutputs(fixture, evidence, input)).toMatchObject({
    status: 'INVALID_SCORER_INPUT',
    qualificationEligible: false,
    metrics: null,
  });
});

it('a generated complete group cannot invent repeated-root provenance from a standalone semantic part', () => {
  const rs = [record('ordinary', null, 'supports')];
  const result = score(rs, [
    { ...output('generated', 'ordinary', ['left', 'right'], 2), sourceSemanticId: 'ordinary' },
  ]);
  expect(result.metrics?.FAMILY_MEMBERSHIP_ERRORS).toBe(1);
  expect(result.operations[0]?.physicalValid).toBe(true);
  expect(result.operations[0]?.namedValid).toBe(false);
  expect(result.metrics?.PHYSICAL_REALIZATION_RATE.concepts).not.toContain('supports');
});
it('the index exposes immutable record snapshots and production record/count bounds', () => {
  const root = record('family', null, 'supports', 2);
  const graph = semanticGraph([root]);
  root.instances = 1;
  root.label = 'changed';
  expect(graph.recordById.get('family')).toMatchObject({ instances: 2, label: 'supports' });
  expect(Object.isFrozen(graph.recordById)).toBe(true);
  expect(Object.isFrozen(graph.recordById.get('family'))).toBe(true);
  expect('set' in graph.recordById).toBe(false);
  expect(() =>
    semanticGraph(Array.from({ length: 25 }, (_, n) => record(`r${String(n)}`, null, 'part'))),
  ).toThrow('RECORD_LIMIT');
  expect(() => semanticGraph([record('bad', null, 'part', 13)])).toThrow('INSTANCE_COUNT');
});
