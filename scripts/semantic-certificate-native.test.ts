import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createManifoldBooleanBackend } from '../apps/web/src/workers/manifold-boolean-backend';
import {
  ancestorCertificateControl,
  disjointCertificateControl,
} from '../packages/repair-evaluation/src/semantic-certificate-controls';
import { countercheckConstructionPlanes } from './semantic-certificate-native.qualify';
import { prevalidatePlanes } from './semantic-evaluation-native.qualify';
import {
  fusedControl,
  nonPlaneControl,
  controlFixture,
  controlRole,
} from '../packages/repair-evaluation/src/semantic-controls';
import {
  validateSemanticFixture,
  freezeSemanticFixture,
  meshDigest,
  type FixtureEvidence,
} from '../packages/repair-evaluation/src/semantic-fixture';
import { buildValidatedEvaluationRequest } from './semantic-evaluation-request.qualify';
import { scoreAllOutputs } from '../packages/repair-evaluation/src/semantic-all-output';
import { requiredValue as value } from '../packages/repair-evaluation/src/semantic-invariant';
const kernel = (): ReturnType<typeof createManifoldBooleanBackend> =>
  createManifoldBooleanBackend(
    readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm'),
  );
it('canonical Stage14 native contradiction remains exact90/90 with closed positive conserved volumes', async () => {
  const f = ancestorCertificateControl(),
    r = await countercheckConstructionPlanes(f, 'upper', await kernel());
  expect(r.exact).toHaveLength(1);
  const c = value(r.exact[0]);
  expect(c.plane).toEqual({ normal: [0, 0, 1], origin: [0, 0, 3] });
  expect(c.selected).toHaveLength(90);
  expect(c.agreement).toEqual({ precision: 1, recall: 1 });
  expect(c.interfaceArea).toBe(9);
  expect(c.outputTopology.map((t) => t.report.totalSignedVolume).sort()).toEqual([27, 27]);
  expect(c.outputTopology.reduce((s, t) => s + t.report.totalSignedVolume, 0)).toBe(54);
  expect(validateSemanticFixture(f).status).toBe('INVALID_FIXTURE');
  const scored = scoreAllOutputs(
    f,
    { planes: [], connectors: [] },
    {
      suggestions: [
        {
          id: 'upper',
          parentId: 'assembly',
          quality: 'READY',
          operation: 'PLANE',
          components: [],
          plane: c.plane,
          instanceCount: 1,
        },
      ],
      faceRank: Array.from({ length: 180 }, () => 0),
      native: [],
      semanticRecords: [],
    },
  );
  expect(scored.qualificationEligible).toBe(false);
  expect(scored.metrics).toBeNull();
  expect(() => freezeSemanticFixture(f)).toThrow('TARGET_DISJOINT_COMPLEMENT_REQUIRED');
}, 120000);
it('disjoint full-interior interleaving remains valid and has no exact construction-plane counterexample', async () => {
  const k = await kernel();
  for (const f of [nonPlaneControl(), disjointCertificateControl()]) {
    expect(validateSemanticFixture(f).errors).toEqual([]);
    for (const role of f.roles)
      expect((await countercheckConstructionPlanes(f, role.id, k)).exact).toHaveLength(0);
  }
}, 120000);
it('native plane attestations reject stale hashes/planes and executable non-executable contradictions before freeze', async () => {
  const f = fusedControl(true),
    e = await prevalidatePlanes(f, await kernel());
  expect(validateSemanticFixture(f, e).errors).toEqual([]);
  const freeze = freezeSemanticFixture(f, e);
  const detail = value(e.planes[0]).detail;
  value(e.planes[0]).detail = { changed: true };
  await expect(buildValidatedEvaluationRequest(f, e, freeze.sha256)).rejects.toThrow('STALE');
  value(e.planes[0]).detail = detail;
  value(e.planes[0]).sourceHash = 'stale';
  expect(validateSemanticFixture(f, e).errors).toContain('STALE_OR_UNBOUND_NATIVE_EVIDENCE:upper');
  expect(() => freezeSemanticFixture(f, e)).toThrow();
  await expect(buildValidatedEvaluationRequest(f, e, freeze.sha256)).rejects.toThrow();
  value(e.planes[0]).sourceHash = meshDigest(f.mesh);
  value(f.roles.find((r) => r.id === 'upper')).operation = 'FUSED_NONEXECUTABLE';
  expect(validateSemanticFixture(f, e).errors).toContain(
    'EXECUTABLE_OPERATION_CONTRADICTION:upper',
  );
}, 120000);
it('request revalidation catches changed valid certificate and rejects invalid overlapping certificate', async () => {
  const f = disjointCertificateControl(),
    e: FixtureEvidence = { planes: [], connectors: [] },
    freeze = freezeSemanticFixture(f, e);
  value(f.noPlane[0]).witness.roleFacesVertices.reverse();
  expect(validateSemanticFixture(f, e).errors).toEqual([]);
  await expect(buildValidatedEvaluationRequest(f, e, freeze.sha256)).rejects.toThrow('STALE');
  value(f.noPlane[0]).other = 'band';
  await expect(buildValidatedEvaluationRequest(f, e, freeze.sha256)).rejects.toThrow();
}, 15000);
it('shared-interface adjacent solids and hull-contact-only certificate cannot claim nonseparability', async () => {
  const f = fusedControl(true);
  expect((await countercheckConstructionPlanes(f, 'upper', await kernel())).exact).toHaveLength(1);
  // Full-rank hull interiors cannot overlap across a separating plane. Boundary contact is insufficient.
  const p = value(f.roles.find((r) => r.id === 'upper'));
  p.operation = 'FUSED_NONEXECUTABLE';
  f.noPlane = [
    {
      role: 'upper',
      other: 'lower',
      witness: {
        roleFacesVertices: p.faces.slice(0, 4).map((face) => ({ face, corner: 0, weight: 0.25 })),
        otherFacesVertices: value(f.roles[0])
          .faces.slice(0, 4)
          .map((face) => ({ face, corner: 0, weight: 0.25 })),
      },
    },
  ];
  expect(validateSemanticFixture(f).status).toBe('INVALID_FIXTURE');
}, 120000);
it('native automatic connectors still plan and execute matching centers; Undo attestation remains mandatory', async () => {
  const f = fusedControl(true, true),
    e = await prevalidatePlanes(f, await kernel()),
    c = value(e.connectors[0]);
  expect(
    c.automaticPlan &&
      c.centersMatch &&
      c.wallDepthClearance &&
      c.maleFemaleBoolean &&
      c.closedOutputs,
  ).toBe(true);
  expect(validateSemanticFixture(f, e).errors).toEqual(['CONNECTOR_UNQUALIFIED:upper']);
  c.sourceHash = 'stale';
  expect(validateSemanticFixture(f, e).errors).toContain(
    'STALE_OR_UNBOUND_CONNECTOR_EVIDENCE:upper',
  );
}, 120000);
it.each(['INCLUDE_CHILDREN', 'EXCLUDE_CHILDREN', 'AGGREGATE_ONLY'] as const)(
  'parent %s preserves independently executable child',
  async (policy) => {
    const f = ancestorCertificateControl(),
      parent = value(f.roles[0]),
      child = value(f.roles[1]);
    parent.parentPolicy = policy;
    if (policy === 'EXCLUDE_CHILDREN')
      parent.faces = f.provenance.flatMap((p, i) => (p.owner === 'assembly' ? [i] : []));
    child.operation = 'QUALIFIED_PLANE';
    f.noPlane = [];
    f.planes = [{ role: 'upper', normal: [0, 0, 1], origin: [0, 0, 3], connector: false }];
    const e = await prevalidatePlanes(f, await kernel());
    expect(validateSemanticFixture(f, e).errors).toEqual([]);
    expect(freezeSemanticFixture(f, e).sha256).toBeTruthy();
  },
  120000,
);
it('each native attestation must match membership even when another correct proof is present', async () => {
  const f = fusedControl(true),
    e = await prevalidatePlanes(f, await kernel());
  e.planes.push({ ...value(e.planes[0]), selected: [...value(e.planes[0]).selected.slice(1)] });
  expect(validateSemanticFixture(f, e).errors).toContain('NATIVE_EVIDENCE_MEMBERSHIP:upper');
  expect(() => freezeSemanticFixture(f, e)).toThrow();
}, 120000);
it('concave hull contact is rejected without a full-interior certificate', () => {
  const f = controlFixture(
    'concave-U-cap',
    [
      { role: 'support', lo: [0, 0, 0], hi: [4, 2, 1] },
      { role: 'support', lo: [0, 0, 1], hi: [1, 2, 3] },
      { role: 'support', lo: [3, 0, 1], hi: [4, 2, 3] },
      { role: 'cap', lo: [0, 0, 3], hi: [4, 2, 4] },
    ],
    [controlRole('support', 'QUALIFIED_PLANE'), controlRole('cap', 'FUSED_NONEXECUTABLE')],
    144,
    1,
  );
  f.fused = [{ roles: ['support', 'cap'], minimumInterfaceArea: 4 }];
  const points = (id: string): { face: number; corner: number; weight: number }[] =>
    [0, 4].flatMap((x) =>
      [0, 2].map((y) => {
        for (const face of value(f.roles.find((r) => r.id === id)).faces)
          for (let corner = 0; corner < 3; corner++) {
            const i = value(f.mesh.indices[face * 3 + corner]) * 3;
            if (
              f.mesh.positions[i] === x &&
              f.mesh.positions[i + 1] === y &&
              f.mesh.positions[i + 2] === 3
            )
              return { face, corner, weight: 0.25 };
          }
        throw Error('NO_HULL_CONTACT');
      }),
    );
  f.noPlane = [
    {
      role: 'cap',
      other: 'support',
      witness: { roleFacesVertices: points('cap'), otherFacesVertices: points('support') },
    },
  ];
  expect(validateSemanticFixture(f).errors).toContain('NO_PLANE_WITNESS:cap');
  // Native rejected this supplemental shape in the preserved diagnostic log.
  // It supplies only a certificate-rejection control, never native-valid evidence.
}, 120000);

it('multiple valid executable planes for one scope are compatible', async () => {
  const f = fusedControl(true);
  f.planes.push({ ...value(f.planes[0]), origin: [1, 0, 2] });
  const e = await prevalidatePlanes(f, await kernel());
  expect(validateSemanticFixture(f, e).errors).toEqual([]);
  expect(freezeSemanticFixture(f, e).sha256).toBeTruthy();
}, 120000);
