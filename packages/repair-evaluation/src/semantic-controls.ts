import { requiredValue } from './semantic-invariant';
/** Local-only controls. Expected counts are analytic declarations, never copied from audit output. */
import {
  buildSemanticFixture,
  type RoleTruth,
  type SemanticFixture,
  type GridBox,
  type OperationClass,
} from './semantic-fixture';
export function controlRole(
  id: string,
  operation: OperationClass = 'EXACT_COMPONENT',
): Omit<RoleTruth, 'faces'> {
  return {
    id,
    scope: 'EXACT_PART',
    operation,
    naming: {
      canonical: id,
      policy: 'FUNCTIONAL_OR_STRUCTURAL_ACCEPTABLE',
      synonyms: [],
      structural: [],
      notEquivalent: [],
    },
    parent: null,
    children: [],
    parentPolicy: 'EXCLUDE_CHILDREN',
    observableMembers: [],
  };
}
export function controlFixture(
  id: string,
  boxes: GridBox[],
  roles: Omit<RoleTruth, 'faces'>[],
  triangles: number,
  components: number,
): SemanticFixture {
  return buildSemanticFixture({
    id,
    construction: { kind: 'SHARED_INTEGER_GRID', cell: 1, boxes },
    roles,
    families: [],
    planes: [],
    noPlane: [],
    fused: [],
    separate: [],
    expected: { triangles, components, closed: true, positiveOrientation: true },
    strictUnknown: false,
    units: 'unknown',
  });
}
export function independentControl(distractor = false): SemanticFixture {
  const f = controlFixture(
    distractor ? 'family-distractor' : 'independent',
    [
      { role: 'left', lo: [0, 0, 0], hi: [2, 2, 2] },
      { role: 'right', lo: [4, 0, 0], hi: [6, 2, 2] },
      ...(distractor ? [{ role: 'spare', lo: [8, 0, 0] as const, hi: [10, 2, 2] as const }] : []),
    ],
    [controlRole('left'), controlRole('right'), ...(distractor ? [controlRole('spare')] : [])],
    distractor ? 144 : 96,
    distractor ? 3 : 2,
  );
  f.separate = [
    ['left', 'right'],
    ...(distractor
      ? ([
          ['left', 'spare'],
          ['right', 'spare'],
        ] as [string, string][])
      : []),
  ];
  return f;
}
export function familyControl(distractor = false): SemanticFixture {
  const raw = controlFixture(
      distractor ? 'family-distractor' : 'family',
      [
        { role: 'left', lo: [0, 0, 0], hi: [2, 2, 2] },
        { role: 'right', lo: [4, 0, 0], hi: [6, 2, 2] },
        { role: 'host', lo: [8, 0, 0], hi: [10, 2, 2] },
        ...(distractor
          ? [{ role: 'spare', lo: [12, 0, 0] as const, hi: [14, 2, 2] as const }]
          : []),
      ],
      [
        controlRole('left'),
        controlRole('right'),
        controlRole('host'),
        ...(distractor ? [controlRole('spare')] : []),
      ],
      distractor ? 192 : 144,
      distractor ? 4 : 3,
    ),
    members = raw.roles.filter((r) => ['left', 'right'].includes(r.id));
  for (const member of members) member.parent = 'supports';
  raw.id = distractor ? 'family-distractor' : 'family';
  raw.roles.push({
    ...controlRole('supports', 'EXACT_COMPONENT_GROUP'),
    scope: 'REPEATED_FAMILY',
    children: ['left', 'right'],
    parentPolicy: 'INCLUDE_CHILDREN',
    faces: members.flatMap((r) => r.faces),
    observableMembers: ['left', 'right'],
  });
  raw.separate = [
    ['left', 'right'],
    ['left', 'host'],
    ['right', 'host'],
  ];
  raw.families = [
    {
      id: 'supports',
      count: 2,
      members: ['left', 'right'],
      subfamilies: [],
      distractors: distractor ? ['spare'] : [],
      spareRoles: distractor ? ['spare'] : [],
      rootExecutable: true,
    },
  ];
  return raw;
}
export function fusedControl(plane = false, connector = false): SemanticFixture {
  if (!plane) {
    const f = nonPlaneControl();
    f.id = 'fused-two-role';
    f.construction.cell = 2;
    requiredValue(f.fused[0]).minimumInterfaceArea = 32;
    return buildSemanticFixture({ ...f, roles: f.roles });
  }

  const f = controlFixture(
    connector ? 'connector-safe' : 'native-plane',
    [
      { role: 'lower', lo: [0, 0, 0], hi: [2, 2, 2] },
      { role: 'upper', lo: [0, 0, 2], hi: [2, 2, 4] },
    ],
    [
      controlRole('lower', 'QUALIFIED_PLANE'),
      {
        ...controlRole('upper', 'QUALIFIED_PLANE'),
        scope: 'FUSED_VISIBLE_REGION',
      },
    ],
    80,
    1,
  );
  f.fused = [{ roles: ['lower', 'upper'], minimumInterfaceArea: 4 }];
  f.planes = [
    { role: 'upper', normal: [0, 0, 1], origin: [0, 0, 2], connector },
    { role: 'lower', normal: [0, 0, -1], origin: [0, 0, 2], connector: false },
  ];
  if (connector) {
    f.construction.cell = 20;
    const rebuilt = buildSemanticFixture({ ...f, roles: f.roles });
    Object.assign(f, rebuilt);
    requiredValue(f.fused[0]).minimumInterfaceArea = 1600;
    for (const p of f.planes) p.origin = [0, 0, 40];
    f.units = 'millimeter';
  }
  return f;
}
export function nonPlaneControl(): SemanticFixture {
  const f = controlFixture(
    'non-plane-region',
    [
      { role: 'outer', lo: [0, 0, 0], hi: [2, 2, 1] },
      { role: 'middle', lo: [0, 0, 1], hi: [2, 2, 2] },
      { role: 'outer', lo: [0, 0, 2], hi: [2, 2, 3] },
    ],
    [
      { ...controlRole('middle', 'FUSED_NONEXECUTABLE'), scope: 'FUSED_VISIBLE_REGION' },
      controlRole('outer', 'FUSED_NONEXECUTABLE'),
    ],
    64,
    1,
  );
  f.fused = [{ roles: ['middle', 'outer'], minimumInterfaceArea: 8 }];
  const vertex = (
    id: string,
    x: number,
    y: number,
    z: number,
  ): { face: number; corner: number; weight: number } => {
    for (const face of requiredValue(f.roles.find((r) => r.id === id)).faces)
      for (let corner = 0; corner < 3; corner++) {
        const i = requiredValue(f.mesh.indices[face * 3 + corner]) * 3;
        if (
          f.mesh.positions[i] === x &&
          f.mesh.positions[i + 1] === y &&
          f.mesh.positions[i + 2] === z
        )
          return { face, corner, weight: 0.125 };
      }
    throw Error('NO_WITNESS_VERTEX');
  };
  f.noPlane = [
    {
      role: 'middle',
      other: 'outer',
      witness: {
        roleFacesVertices: [0, 2].flatMap((x) =>
          [0, 2].flatMap((y) => [1, 2].map((z) => vertex('middle', x, y, z))),
        ),
        otherFacesVertices: [0, 2].flatMap((x) =>
          [0, 2].flatMap((y) => [0, 3].map((z) => vertex('outer', x, y, z))),
        ),
      },
    },
  ];
  const first = requiredValue(f.noPlane[0]);
  f.noPlane.push({
    role: 'outer',
    other: 'middle',
    witness: {
      roleFacesVertices: first.witness.otherFacesVertices,
      otherFacesVertices: first.witness.roleFacesVertices,
    },
  });
  return f;
}
export function unknownControl(): SemanticFixture {
  const f = controlFixture(
    'strict-unknown',
    [{ role: 'unknown', lo: [0, 0, 0], hi: [2, 2, 2] }],
    [{ ...controlRole('unknown', 'UNKNOWN_NONEXECUTABLE'), scope: 'NON_EXECUTABLE_UNKNOWN' }],
    48,
    1,
  );
  f.strictUnknown = true;
  return f;
}
