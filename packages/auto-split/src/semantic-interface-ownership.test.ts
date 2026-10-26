import { beforeAll, expect, it } from 'vitest';
import { cameraFor, FRAME_FILL, type SemanticPart, type Vec3 } from '@cadfixer/auto-split-contract';
import { prepareSemanticGeometry, type PreparedSemanticGeometry } from './semantic';
import { voxelUnion } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import { interfaceOwnershipEvidence } from './semantic-interface-ownership';
import type { SuggestedPlane } from './suggestions';
let prepared: PreparedSemanticGeometry;
let alternatives: readonly [SuggestedPlane, SuggestedPlane];
const part = (annotated: boolean): SemanticPart => ({
  id: 'target',
  parentId: null,
  label: 'Assembly',
  importance: 'major',
  confidence: 0.99,
  instances: 1,
  componentIds: [],
  cut: null,
  expectedGeometry: { kind: 'solid_part', likelySeparable: false },
  views: annotated
    ? ['front', 'back', 'left', 'right', 'top', 'bottom'].map((view) => ({
        view: view as SemanticPart['views'][number]['view'],
        polygons: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      }))
    : [],
});
beforeAll(async () => {
  const mesh = voxelUnion([
    { lo: [-10, -6, -5], hi: [1, 6, 5] },
    { lo: [1, -2, -2], hi: [10, 2, 2] },
  ]);
  prepared = await prepareSemanticGeometry(mesh, fixtureDeflate);
  alternatives = [1.1, 0.9].map((x) => ({
    normal: [1, 0, 0],
    origin: [(x - prepared.geometry.center[0]) / prepared.geometry.scale, 0, 0],
  })) as unknown as readonly [SuggestedPlane, SuggestedPlane];
});
it('keeps the ownership bit unknown when no observation labels a materially changed source shoulder', () => {
  const result = interfaceOwnershipEvidence(
    prepared,
    part(false),
    [],
    alternatives,
    () => undefined,
  );
  expect(result.ownership).toBe('AMBIGUOUS');
  expect(result.surfaceArea).toBeGreaterThan(0);
  expect(result.unknownPixels).toBeGreaterThan(0);
  expect(result.targetPixels).toBe(0);
  expect(result.interfaceSelectedAlternative).toBe(1);
});
it('uses explicit target and peer observations and reports contradictions', () => {
  const target = interfaceOwnershipEvidence(
    prepared,
    part(true),
    [],
    alternatives,
    () => undefined,
  );
  expect(target.ownership).toBe('TARGET_SIDE');
  expect(target.targetPixels).toBeGreaterThan(0);
  const body = interfaceOwnershipEvidence(
    prepared,
    part(false),
    [part(true)],
    alternatives,
    () => undefined,
  );
  expect(body.ownership).toBe('BODY_SIDE');
  expect(body.bodyPixels).toBeGreaterThan(0);
  const conflict = interfaceOwnershipEvidence(
    prepared,
    part(true),
    [part(true)],
    alternatives,
    () => undefined,
  );
  expect(conflict.conflict).toBe(true);
  expect(conflict.ownership).toBe('AMBIGUOUS');
});
it('does not manufacture a material interface between duplicate boundaries', () => {
  const result = interfaceOwnershipEvidence(
    prepared,
    part(false),
    [],
    [alternatives[0], alternatives[0]],
    () => undefined,
  );
  expect(result.surfaceArea).toBe(0);
  expect(result.interfaceSelectedAlternative).toBeNull();
});
it('uses corroborated positive longitudinal support behind an unannotated shoulder', () => {
  const target: SemanticPart = {
    ...part(false),
    views: ['front', 'top'].map((view) => ({
      view: view as 'front' | 'top',
      polygons: [
        [
          [0.5, 0],
          [1, 0],
          [1, 1],
          [0.5, 1],
        ],
      ],
    })),
  };
  const result = interfaceOwnershipEvidence(prepared, target, [], alternatives, () => undefined);
  expect(result.targetPixels).toBe(0);
  expect(result.positiveFrontierProof).toBe(true);
  expect(result).toMatchObject({
    evidenceLevel: 'LOCAL_TARGET_ASSOCIATION',
    ownership: 'AMBIGUOUS',
  });
  expect(result.wholeCertificate).toBeUndefined();
});
it('cancels without modifying the source geometry', () => {
  const before = prepared.geometry.positions.slice();
  expect(() =>
    interfaceOwnershipEvidence(prepared, part(false), [], alternatives, () => {
      throw Error('cancelled');
    }),
  ).toThrow('cancelled');
  expect(prepared.geometry.positions).toEqual(before);
});

it('corroborates the same longitudinal ownership evidence after rotation', async () => {
  for (const angle of [0.37, 1.03]) {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const rotate = (p: Vec3): Vec3 => [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
    const mesh = voxelUnion([
      { lo: [-10, -6, -5], hi: [1, 6, 5] },
      { lo: [1, -2, -2], hi: [10, 2, 2] },
    ]);
    for (let i = 0; i < mesh.positions.length; i += 3)
      mesh.positions.set(
        rotate([mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0]),
        i,
      );
    const p = await prepareSemanticGeometry(mesh, fixtureDeflate),
      g = p.geometry,
      normal = rotate([1, 0, 0]);
    const cut = (x: number): SuggestedPlane => {
      const origin = rotate([x, 0, 0]);
      return {
        normal,
        origin: [
          (origin[0] - g.center[0]) / g.scale,
          (origin[1] - g.center[1]) / g.scale,
          (origin[2] - g.center[2]) / g.scale,
        ],
      };
    };
    const views: SemanticPart['views'] = (['front', 'top'] as const).map((view) => {
      const camera = cameraFor(view);
      const vertices: readonly Vec3[] =
        view === 'front'
          ? [
              [0, -6, -5],
              [1, -6, -5],
              [1, -6, 5],
              [0, -6, 5],
            ]
          : [
              [0, -6, 5],
              [1, -6, 5],
              [1, 6, 5],
              [0, 6, 5],
            ];
      const polygon = vertices.map((v) => {
        const world = rotate(v),
          point: Vec3 = [
            (world[0] - g.center[0]) / g.scale,
            (world[1] - g.center[1]) / g.scale,
            (world[2] - g.center[2]) / g.scale,
          ];
        return [
          0.5 +
            (point.reduce((sum, n, a) => sum + n * (camera.right[a] ?? 0), 0) * FRAME_FILL) /
              (2 * g.radius),
          0.5 -
            (point.reduce((sum, n, a) => sum + n * (camera.up[a] ?? 0), 0) * FRAME_FILL) /
              (2 * g.radius),
        ] as const;
      });
      return { view, polygons: [polygon] };
    });
    const result = interfaceOwnershipEvidence(
      p,
      { ...part(false), views },
      [],
      [cut(1.1), cut(0.9)],
      () => undefined,
    );
    expect(result.targetPixels).toBe(0);
    expect(result.positiveFrontierProof).toBe(true);
    expect(result).toMatchObject({
      evidenceLevel: 'LOCAL_TARGET_ASSOCIATION',
      ownership: 'AMBIGUOUS',
    });
    expect(result.wholeCertificate).toBeUndefined();
  }
});
