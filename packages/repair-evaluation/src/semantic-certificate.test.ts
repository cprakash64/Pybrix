import { it, expect } from 'vitest';
import {
  ancestorCertificateControl,
  disjointCertificateControl,
} from './semantic-certificate-controls';
import {
  nonPlaneControl,
  independentControl,
  familyControl,
  unknownControl,
} from './semantic-controls';
import {
  validateSemanticFixture,
  freezeSemanticFixture,
  meshDigest,
  type SemanticFixture,
} from './semantic-fixture';
import { scoreAllOutputs } from './semantic-all-output';
import { requiredValue as value } from './semantic-invariant';
const reject = (f: SemanticFixture, code: string): void => {
  const v = validateSemanticFixture(f);
  expect(v.status).toBe('INVALID_FIXTURE');
  expect(v.errors.some((e) => e.startsWith(code))).toBe(true);
  expect(() => freezeSemanticFixture(f)).toThrow('INVALID_FIXTURE');
  const score = scoreAllOutputs(
    f,
    { planes: [], connectors: [] },
    { suggestions: [], faceRank: [], native: [], semanticRecords: [] },
  );
  expect(score.qualificationEligible).toBe(false);
  expect(score.metrics).toBeNull();
};
it('rejects exact Stage14 target-versus-ancestor certificate before freeze/scoring', () => {
  reject(ancestorCertificateControl(), 'TARGET_DISJOINT_COMPLEMENT_REQUIRED');
});
it.each(['INCLUDE_CHILDREN', 'AGGREGATE_ONLY'] as const)(
  'hierarchy policy %s cannot certify separability',
  (policy) => {
    const f = ancestorCertificateControl();
    value(f.roles[0]).parentPolicy = policy;
    reject(f, 'TARGET_DISJOINT_COMPLEMENT_REQUIRED');
  },
);
it('EXCLUDE_CHILDREN derives only own faces, not a containing ancestor hull', () => {
  const f = ancestorCertificateControl(),
    parent = value(f.roles[0]);
  parent.parentPolicy = 'EXCLUDE_CHILDREN';
  parent.faces = f.provenance.flatMap((p, i) => (p.owner === 'assembly' ? [i] : []));
  reject(f, 'NO_PLANE_WITNESS');
});
it.each(['identical', 'subset', 'empty'] as const)('rejects %s opposing geometry', (kind) => {
  const f = nonPlaneControl(),
    n = value(f.noPlane[0]),
    target = value(f.roles.find((r) => r.id === n.role)),
    other = value(f.roles.find((r) => r.id === n.other));
  other.faces =
    kind === 'empty' ? [] : kind === 'identical' ? [...target.faces] : target.faces.slice(0, 4);
  reject(f, 'EMPTY_WITNESS_COMPLEMENT');
});
it('target == witness rejects even without alias role', () => {
  const f = nonPlaneControl();
  value(f.noPlane[0]).other = value(f.noPlane[0]).role;
  reject(f, 'EMPTY_WITNESS_COMPLEMENT');
});
it('partial overlap cannot supply independent opposing evidence', () => {
  const f = nonPlaneControl(),
    a = value(f.roles[0]),
    b = value(f.roles[1]);
  b.faces.push(...a.faces.slice(0, Math.floor(a.faces.length / 2)));
  reject(f, 'TARGET_DISJOINT_COMPLEMENT_REQUIRED');
});
it('fresh interleaved shared-grid role has meaningful disjoint fused complement', () => {
  const rebuilt = disjointCertificateControl();
  expect(validateSemanticFixture(rebuilt).errors).toEqual([]);
  expect(freezeSemanticFixture(rebuilt).sha256).toBeTruthy();
  const [a, b] = rebuilt.roles;
  expect(value(a).faces.every((face) => !value(b).faces.includes(face))).toBe(true);
});
it('exact component cannot be declared fused non-executable', () => {
  const f = independentControl(),
    r = value(f.roles[0]);
  r.operation = 'FUSED_NONEXECUTABLE';
  reject(f, 'EXECUTABLE_OPERATION_CONTRADICTION');
});
it('exact component group cannot be declared fused non-executable', () => {
  const f = familyControl();
  value(f.roles.find((r) => r.id === 'supports')).operation = 'FUSED_NONEXECUTABLE';
  reject(f, 'EXECUTABLE_OPERATION_CONTRADICTION');
});
it('executable aliases of identical physical scope contradict non-executable truth', () => {
  const f = nonPlaneControl(),
    a = value(f.roles[0]);
  f.roles.push({ ...a, id: 'executable-alias', operation: 'QUALIFIED_PLANE' });
  reject(f, 'EXECUTABLE_OPERATION_CONTRADICTION');
});
it('strict unknown is distinct from proven non-plane truth', () => {
  expect(validateSemanticFixture(unknownControl()).errors).toEqual([]);
});
it('disconnected but overlapping hulls do not prove fused nonseparability', () => {
  const f = nonPlaneControl();
  f.fused = [];
  reject(f, 'NONPLANE_OPPOSING_FUSION_REQUIRED');
});
it('source mutation invalidates certificate provenance', () => {
  const f = nonPlaneControl();
  f.mesh.positions[0] = 99;
  reject(f, 'GEOMETRY_PROVENANCE_MISMATCH');
});
it('opposing certificate vertices cannot borrow a target-owned face', () => {
  const f = nonPlaneControl();
  value(value(f.noPlane[0]).witness.otherFacesVertices[0]).face = value(value(f.roles[0]).faces[0]);
  reject(f, 'NO_PLANE_WITNESS');
});
it('empty complement cannot freeze with misleading native evidence', () => {
  const f = ancestorCertificateControl(),
    p = { role: 'upper', normal: [0, 0, 1] as const, origin: [0, 0, 3] as const, connector: false },
    selected = value(f.roles[1]).faces;
  const e = {
    planes: [
      {
        role: 'upper',
        sourceHash: meshDigest(f.mesh),
        plane: p,
        selected,
        complement: value(f.roles[0]).faces.filter((x) => !selected.includes(x)),
        nativeValid: true,
        closedOutputs: true,
        detail: { offline: true },
      },
    ],
    connectors: [],
  };
  expect(validateSemanticFixture(f, e).errors).toContain(
    'EXECUTABLE_OPERATION_CONTRADICTION:upper',
  );
  expect(() => freezeSemanticFixture(f, e)).toThrow();
});
it('a genuinely contained child cannot oppose its containing target parent', () => {
  const f = ancestorCertificateControl(),
    parent = value(f.roles[0]),
    child = value(f.roles[1]),
    n = value(f.noPlane[0]);
  parent.operation = 'FUSED_NONEXECUTABLE';
  child.operation = 'UNKNOWN_NONEXECUTABLE';
  child.scope = 'NON_EXECUTABLE_UNKNOWN';
  f.noPlane = [
    {
      role: 'assembly',
      other: 'upper',
      witness: {
        roleFacesVertices: n.witness.otherFacesVertices,
        otherFacesVertices: n.witness.roleFacesVertices,
      },
    },
  ];
  reject(f, 'EMPTY_WITNESS_COMPLEMENT');
});

it('near-identical scopes cannot manufacture meaningful independent geometry', () => {
  const f = nonPlaneControl(),
    a = value(f.roles[0]),
    b = value(f.roles[1]);
  b.faces = [...a.faces.slice(0, -1), value(b.faces[0])];
  reject(f, 'TARGET_DISJOINT_COMPLEMENT_REQUIRED');
});
