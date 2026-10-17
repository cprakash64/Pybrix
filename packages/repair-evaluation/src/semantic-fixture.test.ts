import { requiredValue } from './semantic-invariant';
import { describe, it, expect } from 'vitest';
import { meshOf, voxelUnion, box, concatMeshes } from '../../auto-split/src/fixtures/solids';
import {
  buildGridSource,
  validateSemanticFixture,
  freezeSemanticFixture,
  meshDigest,
  digest,
  auditFixtureTopology,
} from './semantic-fixture';
import {
  independentControl,
  familyControl,
  fusedControl,
  nonPlaneControl,
  unknownControl,
} from './semantic-controls';
import { assertFixtureDispatchable } from './semantic-all-output';
describe('audited construction and topology', () => {
  it.each([
    independentControl(),
    familyControl(),
    familyControl(true),
    fusedControl(),
    nonPlaneControl(),
    unknownControl(),
  ])('validates $id and stable freeze', (f) => {
    const v = validateSemanticFixture(f);
    expect(v.errors).toEqual([]);
    const freeze = freezeSemanticFixture(f);
    expect(freezeSemanticFixture(f).sha256).toBe(freeze.sha256);
    assertFixtureDispatchable(f, { planes: [], connectors: [] }, freeze.sha256);
    expect(v.topology.report.boundaryEdgeCount).toBe(0);
    expect(v.topology.report.nonManifoldVertexCount).toBe(0);
    expect(v.topology.components.every((c) => c.bounds.lo.every(Number.isFinite))).toBe(true);
    requiredValue(f.roles[0]).naming.canonical = 'changed';
    expect(() => {
      assertFixtureDispatchable(f, { planes: [], connectors: [] }, freeze.sha256);
    }).toThrow('STALE');
  });
  it('rejects different fractional grid phases at construction', () => {
    expect(() => buildGridSource([{ role: 'a', lo: [0.2, 0, 0], hi: [2.2, 2, 2] }])).toThrow(
      'GRID',
    );
  });
  it('overlap within one role is idempotent, across roles is ambiguous', () => {
    const a = { role: 'a', lo: [0, 0, 0] as const, hi: [2, 2, 2] as const };
    expect(meshDigest(buildGridSource([a, a]).mesh)).toBe(meshDigest(buildGridSource([a]).mesh));
    expect(() => buildGridSource([a, { ...a, role: 'b' }])).toThrow('OWNERSHIP');
  });
  it('records removed interfaces, never assigns their caps by centroid', () => {
    const f = fusedControl();
    expect(f.interfaces).toHaveLength(4);
    expect(f.interfaces.reduce((s, x) => s + x.area, 0)).toBe(4);
    expect(f.provenance).toHaveLength(80);
    expect(f.provenance.some((p) => p.cell[2] === 1 && p.axis === 2 && p.side === 1)).toBe(false);
  });
  it('detects bow-tie vertex and edge seams even on shared integer grids', () => {
    const f = independentControl();
    const boxes = [
      { role: 'left', lo: [0, 0, 0] as const, hi: [1, 1, 1] as const },
      { role: 'right', lo: [1, 1, 1] as const, hi: [2, 2, 2] as const },
    ];
    Object.assign(f, buildGridSource(boxes));
    f.construction.boxes = boxes;
    expect(validateSemanticFixture(f).errors).toContain('TOPOLOGY_DEFECT');
  });
});
describe('mandatory invalid controls cannot freeze', () => {
  const cases: Record<string, () => ReturnType<typeof independentControl>> = {
    A_fractional_union: () => {
      const f = fusedControl();
      f.mesh = voxelUnion([
        { lo: [0, 0, 0], hi: [2, 2, 2] },
        { lo: [0.25, 0, 1], hi: [2.25, 2, 3] },
      ]);
      return f;
    },
    B_intersecting_shells: () => {
      const f = independentControl();
      f.mesh = concatMeshes([box([0, 0, 0], [2, 2, 2]), box([1, 1, 1], [3, 3, 3])]);
      return f;
    },
    C_component_count: () => {
      const f = independentControl();
      f.expected.components = 1;
      return f;
    },
    D_reversed_winding: () => {
      const f = independentControl();
      for (let i = 0; i < f.mesh.indices.length; i += 3) {
        const v = requiredValue(f.mesh.indices[i]);
        f.mesh.indices[i] = requiredValue(f.mesh.indices[i + 1]);
        f.mesh.indices[i + 1] = v;
      }
      return f;
    },
    E_nonmanifold_seam: () => {
      const f = independentControl();
      f.mesh = meshOf([
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        [
          [1, 0, 0],
          [0, 0, 0],
          [0, 0, 1],
        ],
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, -1, 0],
        ],
      ]);
      return f;
    },
    F_centroid_ownership: () => {
      const f = fusedControl();
      const face = requiredValue(requiredValue(f.roles[0]).faces.pop());
      requiredValue(f.roles[1]).faces.push(face);
      return f;
    },
    G_duplicate_membership: () => {
      const f = independentControl();
      requiredValue(f.roles[1]).faces.push(requiredValue(requiredValue(f.roles[0]).faces[0]));
      return f;
    },
    H_missing_family_member: () => {
      const f = familyControl();
      requiredValue(f.families[0]).members[1] = 'missing';
      return f;
    },
    I_unproven_connector: () => fusedControl(true, true),
  };
  for (const [id, make] of Object.entries(cases))
    it(id, () => {
      const f = make(),
        v = validateSemanticFixture(f);
      expect(v.status).toBe('INVALID_FIXTURE');
      expect(v.errors.length).toBeGreaterThan(0);
      expect(() => freezeSemanticFixture(f)).toThrow('INVALID_FIXTURE');
    });
  it('reports actual fractional shell mismatch independently of truth', () => {
    const f = requiredValue(cases.A_fractional_union)();
    const t = auditFixtureTopology(f.mesh);
    expect(t.report.componentCount).toBeGreaterThan(1);
    expect(t.report.sourceFaceCount).toBe(f.mesh.indices.length / 3);
  });
  it('rejects forged validation and stale geometry evidence', () => {
    const f = independentControl(),
      a = freezeSemanticFixture(f);
    f.mesh.positions[0] = 100;
    expect(() => {
      assertFixtureDispatchable(f, { planes: [], connectors: [] }, a.sha256);
    }).toThrow();
    expect(digest(f.mesh)).not.toBe(a.sha256);
  });
});
it('legacy invalid union is rejected before any scoring, never reported as semantic safety failure', async () => {
  const { auditUnprovenFixture } = await import('./semantic-fixture');
  const mesh = voxelUnion([
    { lo: [0, 0, 0], hi: [2, 2, 2] },
    { lo: [0.25, 0, 1], hi: [2.25, 2, 3] },
  ]);
  const audit = auditUnprovenFixture(mesh, 1);
  expect(audit.status).toBe('INVALID_FIXTURE');
  expect(audit.errors).toContain('INTENDED_COMPONENT_COUNT_MISMATCH');
  expect(audit.metrics).toBeNull();
});

it('a complete object cannot masquerade as a meaningful exact-component split', () => {
  const f = unknownControl();
  requiredValue(f.roles[0]).scope = 'WHOLE_OBJECT';
  requiredValue(f.roles[0]).operation = 'EXACT_COMPONENT';
  expect(validateSemanticFixture(f).errors).toContain('EMPTY_COMPONENT_COMPLEMENT:unknown');
});

it('plane truth cannot borrow membership from an unrelated plane despite a native-valid claim', () => {
  const f = fusedControl(true),
    p = requiredValue(f.planes[0]);
  p.normal = [1, 0, 0];
  p.origin = [1, 0, 0];
  const selected = requiredValue(f.roles.find((r) => r.id === 'upper')).faces,
    complement = f.provenance.flatMap((_, i) => (selected.includes(i) ? [] : [i]));
  const e = {
    planes: [
      {
        role: 'upper',
        plane: p,
        sourceHash: meshDigest(f.mesh),
        selected,
        complement,
        nativeValid: true,
        closedOutputs: true,
        detail: { unitTestDouble: true },
      },
    ],
    connectors: [],
  };
  expect(validateSemanticFixture(f, e).errors).toContain('PLANE_UNQUALIFIED:upper');
});
