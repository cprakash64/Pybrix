import { requiredValue } from '../packages/repair-evaluation/src/semantic-invariant';
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createManifoldBooleanBackend } from '../apps/web/src/workers/manifold-boolean-backend';
import { splitWithConnectors } from '@cadfixer/geometry-runtime';
import { uncancellable } from '@cadfixer/shared';
import { controlFixture, controlRole } from '../packages/repair-evaluation/src/semantic-controls';
import {
  scoreAllOutputs,
  selectedPlaneFaces,
  type FinalOutput,
} from '../packages/repair-evaluation/src/semantic-all-output';
import { attributeSourcePlane } from '../packages/repair-evaluation/src/semantic-plane-attribution';
import {
  digest,
  meshDigest,
  auditFixtureTopology,
} from '../packages/repair-evaluation/src/semantic-fixture';
import { prevalidatePlanes } from './semantic-evaluation-native.qualify';
it('new closed manifold infrastructure prism: exact, analytical fractional positive, wrong fractional negative and coplanar stop', async () => {
  const f = controlFixture(
    'stage19-local-prism',
    [
      { role: 'bottom', lo: [0, 0, 0], hi: [3, 2, 3] },
      { role: 'top', lo: [0, 0, 3], hi: [3, 2, 6] },
    ],
    [controlRole('bottom', 'QUALIFIED_PLANE'), controlRole('top', 'QUALIFIED_PLANE')],
    144,
    1,
  );
  f.planes = [
    { role: 'top', normal: [0, 0, 1], origin: [0, 0, 3], connector: false },
    { role: 'bottom', normal: [0, 0, -1], origin: [0, 0, 3], connector: false },
  ];
  const kernel = await createManifoldBooleanBackend(
    readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm'),
  );
  const evidence = await prevalidatePlanes(f, kernel);
  for (const [z, expectedMass, error] of [
    [3, 72, 0],
    [3.05, 71, 0],
    [4.5, 42, 1],
    [1.5, 102, 1],
  ] as const) {
    const plane = { normal: [0, 0, 1] as const, origin: [0, 0, z] as const },
      proof = attributeSourcePlane(f.mesh, plane, 'top');
    expect(proof.selectedMass).toBeCloseTo(expectedMass, 10);
    if (z === 3) {
      expect(proof.status).toBe('WHOLE_FACE_EXACT');
      expect(proof.weights?.flatMap((w, i) => (w ? [i] : []))).toEqual(
        selectedPlaneFaces(f, plane),
      );
    } else {
      expect(proof.status).toBe('FRACTIONAL_CLIPPED');
      expect(proof.straddling).toBe(20);
      // Every unit-height side square contributes paired triangle weights (1-t)^2 and 1-t^2.
      const t = z % 1,
        fractions = requiredValue(proof.weights).filter((w) => w > 0 && w < 1);
      expect(fractions).toHaveLength(20);
      for (const w of fractions)
        expect(Math.min(Math.abs(w - (1 - t) ** 2), Math.abs(w - (1 - t * t)))).toBeLessThan(1e-12);
    }
    const native = await splitWithConnectors(
      kernel,
      f.mesh,
      { plane, connector: { kind: 'none' } },
      uncancellable,
    );
    for (const mesh of [native.pieceA, native.pieceB]) {
      const r = auditFixtureTopology(mesh).report;
      expect(
        r.isBoundaryFree && r.isEdgeManifold && r.isVertexManifold && r.isWindingConsistent,
      ).toBe(true);
      expect(r.totalSignedVolume).toBeGreaterThan(0);
    }
    const operation: FinalOutput = {
      id: 'top',
      parentId: null,
      quality: 'READY',
      operation: 'PLANE',
      components: [],
      plane,
      instanceCount: 1,
    };
    const input = {
      suggestions: [operation],
      faceRank: Array(144).fill(0),
      native: [
        { id: 'top', sourceHash: meshDigest(f.mesh), planeHash: digest(plane), valid: true },
      ],
      semanticRecords: [
        { id: 'top', parentId: null, label: 'top', instances: 1, instanceAnnotations: [] },
      ],
    };
    const score = scoreAllOutputs(f, evidence, input);
    expect(score.status).toBe('SCORED');
    expect(score.qualificationEligible).toBe(true);
    expect(score.metrics?.PHYSICAL_READY_ERRORS).toBe(error);
    if (score.status !== 'SCORED') throw Error(score.status);
    expect(score.operations[0]?.bestPhysicalRole?.id).toBe('top');
    expect(score.operations[0]?.bestPhysicalRole?.precision).toBeCloseTo(
      z < 3 ? 72 / expectedMass : 1,
      10,
    );
    expect(score.operations[0]?.bestPhysicalRole?.recall).toBeCloseTo(
      Math.min(expectedMass, 72) / 72,
      10,
    );
    if (z === 3.05) {
      input.suggestions = [operation, { ...operation, id: 'copy' }];
      input.semanticRecords.push({
        id: 'copy',
        parentId: null,
        label: 'top',
        instances: 1,
        instanceAnnotations: [],
      });
      const cached = scoreAllOutputs(f, evidence, input);
      expect(cached.operations.map((o) => o.sourceAttribution?.operationId)).toEqual([
        'copy',
        'top',
      ]);
      expect(cached.operations[0]?.sourceAttribution?.weights).toBe(
        cached.operations[1]?.sourceAttribution?.weights,
      );
    }
  }
  const plane = { normal: [1, 0, 0], origin: [0, 0, 0] };
  const stopped = scoreAllOutputs(f, evidence, {
    suggestions: [
      {
        id: 'top',
        parentId: null,
        quality: 'READY',
        operation: 'PLANE',
        components: [],
        plane,
        instanceCount: 1,
      },
    ],
    faceRank: Array(144).fill(0),
    native: [],
    semanticRecords: [
      { id: 'top', parentId: null, label: 'top', instances: 1, instanceAnnotations: [] },
    ],
  });
  expect(stopped).toMatchObject({
    status: 'ATTRIBUTION_UNSUPPORTED',
    qualificationEligible: false,
    metrics: null,
  });
  expect(stopped.operations[0]?.attributionStatus).toBe('UNSUPPORTED');
}, 120000);
