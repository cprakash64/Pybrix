import { requiredValue } from './semantic-invariant';
import { it, expect } from 'vitest';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  attributeSourcePlane as attribute,
  fractionalSourceAgreement as agreement,
} from './semantic-plane-attribution';
import { sourceAgreement } from './semantic-fixture';
const mesh = (p: number[][]): CanonicalMesh =>
  ({
    positions: new Float32Array(p.flat()),
    indices: new Uint32Array(p.map((_, i) => i)),
    metadata: { units: 'unknown' },
  }) as CanonicalMesh;
const plane = { normal: [1, 0, 0], origin: [0, 0, 0] };
it('analytical one positive and two negative, both sides and operation binding', () => {
  const m = mesh([
      [1, 0, 0],
      [-1, 0, 0],
      [-1, 2, 0],
    ]),
    a = attribute(m, plane, 'A'),
    b = attribute(m, plane, 'B', 'NEGATIVE');
  expect(a.status).toBe('FRACTIONAL_CLIPPED');
  expect(a.weights).toEqual([0.25]);
  expect(b.weights).toEqual([0.75]);
  expect(attribute(m, { ...plane, normal: [-1, 0, 0] }, 'C', 'NEGATIVE').weights).toEqual(
    a.weights,
  );
  expect(a.operationId).toBe('A');
  expect(b.operationId).toBe('B');
  expect(a.sourceHash).toBe(b.sourceHash);
});
it('mixed nonuniform triangles retain unit face mass rather than surface area mass', () => {
  const a = attribute(
    mesh([
      [1, 0, 0],
      [-1, 0, 0],
      [-1, 2, 0],
      [1, 0, 0],
      [2, 0, 0],
      [1, 200, 0],
    ]),
    plane,
    'A',
  );
  expect(a.weights).toEqual([0.25, 1]);
  expect(agreement(requiredValue(a.weights), [0])).toEqual({ precision: 0.2, recall: 0.25 });
  expect(a.selectedSurfaceArea).toBeCloseTo(100.5);
});
it.each([
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
  ],
  [
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
  ],
  [
    [1e-12, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
  ],
])('vertex and edge boundaries conserve without division by zero: %j', (...p) => {
  const a = attribute(mesh(p), plane, 'A');
  expect(a.status).toBe('WHOLE_FACE_EXACT');
  expect(a.weights).toEqual([1]);
  expect(a.complementWeights).toEqual([0]);
});
it('coplanar, zero area, invalid index, invalid plane and abort refuse metrics', () => {
  expect(
    attribute(
      mesh([
        [0, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
      plane,
      'A',
    ),
  ).toMatchObject({ status: 'UNSUPPORTED_COPLANAR', weights: null });
  expect(
    attribute(
      mesh([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
      plane,
      'A',
    ).status,
  ).toBe('INVALID_SOURCE');
  const m = mesh([
    [1, 0, 0],
    [2, 0, 0],
    [1, 1, 0],
  ]);
  m.indices[1] = 999;
  expect(attribute(m, plane, 'A').status).toBe('INVALID_SOURCE');
  expect(attribute(m, { ...plane, normal: [0, 0, 0] }, 'A').status).toBe('INVALID_PLANE');
  expect(attribute(m, plane, 'A', 'POSITIVE', AbortSignal.abort()).reason).toBe('ABORTED');
});
it('large coordinates, tiny distances, nonunit normals and exact binary metric controls', () => {
  const m = mesh([
    [1, 0, 0],
    [-1, 0, 0],
    [-1, 2, 0],
  ]);
  expect(attribute(m, { ...plane, normal: [1e100, 0, 0] }, 'A').weights).toEqual([0.25]);
  const large = mesh([
    [1000001, 0, 0],
    [999999, 0, 0],
    [999999, 2, 0],
  ]);
  expect(attribute(large, { ...plane, origin: [1000000, 0, 0] }, 'A').weights).toEqual([0.25]);
  const tiny = mesh([
    [1e-12, 0, 0],
    [-1e-12, 0, 0],
    [-1e-12, 2, 0],
  ]);
  expect(attribute(tiny, plane, 'A').weights?.[0]).toBeCloseTo(0.25, 12);
  for (const target of [[0], [1], [0, 1], [2], []])
    expect(agreement([1, 0, 1], target)).toEqual(sourceAgreement([0, 2], target));
});
it('scorer invalid attribution emits no safety counts and no empty selected row', async () => {
  const { independentControl } = await import('./semantic-controls');
  const { faceComponents } = await import('./semantic-fixture');
  const { scoreAllOutputs } = await import('./semantic-all-output');
  const f = independentControl(),
    components = faceComponents(f.mesh);
  const score = scoreAllOutputs(
    f,
    { planes: [], connectors: [] },
    {
      suggestions: [
        {
          id: 'bad',
          parentId: null,
          quality: 'READY',
          operation: 'PLANE',
          components: [],
          plane: { normal: [0, 0, 0], origin: [0, 0, 0] },
          instanceCount: 1,
        },
      ],
      semanticRecords: [
        { id: 'bad', parentId: null, label: 'bad', instances: 1, instanceAnnotations: [] },
      ],
      native: [],
      faceRank: Array.from({ length: f.mesh.indices.length / 3 }, (_, i) =>
        components.findIndex((c) => c.includes(i)),
      ),
    },
  );
  expect(score).toMatchObject({
    status: 'ATTRIBUTION_INVALID',
    qualificationEligible: false,
    metrics: null,
  });
  expect(score.operations[0]).toMatchObject({ id: 'bad', attributionStatus: 'INVALID' });
  expect(score.operations[0]).not.toHaveProperty('selected');
  expect(score.operations[0]).not.toHaveProperty('physicalReadyError');
});
it('supported plane without a legal target has no invented physical mismatch; strict unknown remains distinct', async () => {
  const { unknownControl } = await import('./semantic-controls');
  const { scoreAllOutputs } = await import('./semantic-all-output');
  const { meshDigest, digest } = await import('./semantic-fixture');
  const f = unknownControl(),
    plane = { normal: [0, 0, 1], origin: [0, 0, 1] };
  const score = scoreAllOutputs(
    f,
    { planes: [], connectors: [] },
    {
      suggestions: [
        {
          id: 'unknown',
          parentId: null,
          quality: 'READY',
          operation: 'PLANE',
          components: [],
          plane,
          instanceCount: 1,
        },
      ],
      faceRank: Array(48).fill(0),
      semanticRecords: [
        { id: 'unknown', parentId: null, label: 'unknown', instances: 1, instanceAnnotations: [] },
      ],
      native: [
        { id: 'unknown', sourceHash: meshDigest(f.mesh), planeHash: digest(plane), valid: true },
      ],
    },
  );
  expect(score.status).toBe('SCORED');
  expect(score.metrics?.PHYSICAL_READY_ERRORS).toBe(0);
  expect(score.metrics?.STRICT_UNKNOWN_EXECUTABLE).toBe(1);
  if (score.status !== 'SCORED') throw Error('Expected SCORED');
  expect(score.operations[0]).toMatchObject({
    physicalScopeMeasured: false,
    physicalReadyError: false,
    physicalValid: false,
    strictUnknownExecutable: true,
  });
});
