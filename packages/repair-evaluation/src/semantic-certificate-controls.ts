/** Offline regression controls, never semantic model holdouts. */
import { buildSemanticFixture, type NonPlaneTruth, type SemanticFixture } from './semantic-fixture';
import { controlRole, controlFixture } from './semantic-controls';
import { requiredValue } from './semantic-invariant';
export function ancestorCertificateControl(): SemanticFixture {
  const f = buildSemanticFixture({
    id: 'diagnostic-ancestor-certificate',
    construction: {
      kind: 'SHARED_INTEGER_GRID',
      cell: 1,
      boxes: [
        { role: 'assembly', lo: [0, 0, 0], hi: [3, 3, 3] },
        { role: 'upper', lo: [0, 0, 3], hi: [3, 3, 6] },
      ],
    },
    roles: [
      {
        ...controlRole('assembly', 'UNKNOWN_NONEXECUTABLE'),
        scope: 'WHOLE_OBJECT',
        children: ['upper'],
        parentPolicy: 'INCLUDE_CHILDREN',
      },
      {
        ...controlRole('upper', 'FUSED_NONEXECUTABLE'),
        scope: 'FUSED_VISIBLE_REGION',
        parent: 'assembly',
      },
    ],
    families: [],
    planes: [],
    noPlane: [],
    fused: [{ roles: ['assembly', 'upper'], minimumInterfaceArea: 9 }],
    separate: [],
    expected: { triangles: 180, components: 1, closed: true, positiveOrientation: true },
    strictUnknown: false,
    units: 'unknown',
  });
  const vertex = (
    id: string,
    x: number,
    y: number,
    z: number,
    weight: number,
  ): NonPlaneTruth['witness']['roleFacesVertices'][number] => {
    for (const face of requiredValue(f.roles.find((r) => r.id === id)).faces)
      for (let corner = 0; corner < 3; corner++) {
        const i = requiredValue(f.mesh.indices[face * 3 + corner]) * 3;
        if (
          f.mesh.positions[i] === x &&
          f.mesh.positions[i + 1] === y &&
          f.mesh.positions[i + 2] === z
        )
          return { face, corner, weight };
      }
    throw Error('NO_VERTEX');
  };
  f.noPlane = [
    {
      role: 'upper',
      other: 'assembly',
      witness: {
        roleFacesVertices: [0, 3].flatMap((x) =>
          [0, 3].flatMap((y) => [3, 6].map((z) => vertex('upper', x, y, z, 1 / 8))),
        ),
        otherFacesVertices: [0, 3].flatMap((x) =>
          [0, 3].flatMap((y) =>
            [0, 6].map((z) => vertex('assembly', x, y, z, z === 0 ? 1 / 16 : 3 / 16)),
          ),
        ),
      },
    },
  ];
  return f;
}

/** New uneven interleaving: the middle band cannot be isolated by one plane. */
export function disjointCertificateControl(): SemanticFixture {
  const f = controlFixture(
    'closure-interleaved-3x4x5',
    [
      { role: 'ends', lo: [0, 0, 0], hi: [3, 4, 2] },
      { role: 'band', lo: [0, 0, 2], hi: [3, 4, 3] },
      { role: 'ends', lo: [0, 0, 3], hi: [3, 4, 5] },
    ],
    [controlRole('band', 'FUSED_NONEXECUTABLE'), controlRole('ends', 'FUSED_NONEXECUTABLE')],
    188,
    1,
  );
  f.fused = [{ roles: ['band', 'ends'], minimumInterfaceArea: 24 }];
  const vertices = (id: string, zs: number[]): NonPlaneTruth['witness']['roleFacesVertices'] =>
    [0, 3].flatMap((x) =>
      [0, 4].flatMap((y) =>
        zs.map((z) => {
          for (const face of requiredValue(f.roles.find((r) => r.id === id)).faces)
            for (let corner = 0; corner < 3; corner++) {
              const i = requiredValue(f.mesh.indices[face * 3 + corner]) * 3;
              if (
                f.mesh.positions[i] === x &&
                f.mesh.positions[i + 1] === y &&
                f.mesh.positions[i + 2] === z
              )
                return { face, corner, weight: 1 / 8 };
            }
          throw Error('NO_VERTEX');
        }),
      ),
    );
  const band = vertices('band', [2, 3]),
    ends = vertices('ends', [0, 5]);
  f.noPlane = [
    { role: 'band', other: 'ends', witness: { roleFacesVertices: band, otherFacesVertices: ends } },
    { role: 'ends', other: 'band', witness: { roleFacesVertices: ends, otherFacesVertices: band } },
  ];
  return f;
}
