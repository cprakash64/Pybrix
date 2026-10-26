import { it, expect } from 'vitest';
import type { SemanticHierarchy } from '@cadfixer/auto-split-contract';
import { prepareSemanticGeometry, decomposeSemantic } from './semantic';
import { voxelUnion } from './fixtures/solids';
import { fixtureDeflate } from './fixtures/deflate';

// Regression for an oblique shoulder whose strongest sparse section probe
// leaves only one supported full section before its transition. Another offset
// in the same existing normal family independently establishes the real seam.
it('retains a supported shoulder offset without exceeding three refinements', async () => {
  const mesh = voxelUnion([
    { lo: [-102, -14, -10], hi: [-23, 14, 10] },
    { lo: [-23, -4, -3], hi: [51, 4, 3] },
    { lo: [51, -16, -11], hi: [150, 16, 11] },
  ]);
  const rx = 0.3723,
    ry = 0.4829,
    rz = -0.1553,
    scale = 1.4063;
  const shift = [-165.88, 122.786, -58.66];
  const cx = Math.cos(rx),
    sx = Math.sin(rx),
    cy = Math.cos(ry),
    sy = Math.sin(ry),
    cz = Math.cos(rz),
    sz = Math.sin(rz);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i] ?? 0,
      y = mesh.positions[i + 1] ?? 0,
      z = mesh.positions[i + 2] ?? 0;
    const yy = cx * y - sx * z,
      zz = sx * y + cx * z,
      xx = cy * x + sy * zz;
    mesh.positions[i] = (cz * xx - sz * yy) * scale + (shift[0] ?? 0);
    mesh.positions[i + 1] = (sz * xx + cz * yy) * scale + (shift[1] ?? 0);
    mesh.positions[i + 2] = (-sy * x + cy * zz) * scale + (shift[2] ?? 0);
  }
  const answer: SemanticHierarchy = {
    object: { label: 'Unfamiliar physical assembly', confidence: 0.99 },
    parts: [
      {
        id: 'a',
        label: 'Unfamiliar member a',
        parentId: null,
        importance: 'major',
        confidence: 0.99,
        instances: 1,
        views: [
          {
            view: 'front',
            polygons: [
              [
                [0.552734375, 0.5888671875],
                [0.580078125, 0.5283203125],
                [0.615234375, 0.4921875],
                [0.6181640625, 0.4921875],
                [0.640625, 0.50390625],
                [0.92578125, 0.6552734375],
                [0.92578125, 0.658203125],
                [0.8974609375, 0.7216796875],
                [0.8623046875, 0.7578125],
                [0.8515625, 0.75390625],
                [0.5810546875, 0.6103515625],
                [0.5517578125, 0.5947265625],
              ],
            ],
          },
          {
            view: 'right',
            polygons: [
              [
                [0.375, 0.6875],
                [0.421875, 0.529296875],
                [0.4296875, 0.525390625],
                [0.5224609375, 0.4921875],
                [0.5263671875, 0.4931640625],
                [0.55859375, 0.5556640625],
                [0.5556640625, 0.5693359375],
                [0.5107421875, 0.720703125],
                [0.5029296875, 0.724609375],
                [0.41015625, 0.7578125],
                [0.40625, 0.7568359375],
                [0.3740234375, 0.6943359375],
              ],
            ],
          },
          {
            view: 'bottom',
            polygons: [
              [
                [0.5537109375, 0.4521484375],
                [0.5810546875, 0.421875],
                [0.60546875, 0.41796875],
                [0.88671875, 0.3740234375],
                [0.8916015625, 0.375],
                [0.92578125, 0.4736328125],
                [0.92578125, 0.4775390625],
                [0.9033203125, 0.50390625],
                [0.896484375, 0.5107421875],
                [0.59765625, 0.5576171875],
                [0.5859375, 0.5576171875],
                [0.5517578125, 0.458984375],
              ],
            ],
          },
        ],
        componentIds: [],
        expectedGeometry: { kind: 'solid_part', likelySeparable: false },
        cut: null,
      },
    ],
  };
  const prepared = await prepareSemanticGeometry(mesh, fixtureDeflate);
  const result = decomposeSemantic(prepared, answer);
  const suggestion = result.suggestions.find((s) => s.id === 'a');
  expect(suggestion?.boundaryAmbiguity?.hypotheses).toHaveLength(2);
  expect(suggestion?.boundaryAmbiguity?.route).toBe('STRUCTURAL_SEAM');
  expect(new Set(suggestion?.boundaryAmbiguity?.hypotheses.map((h) => h.ownershipClass)).size).toBe(
    2,
  );
  expect(result.evidence[0]?.synthesis?.peerless?.refinements).toBeLessThanOrEqual(3);
  expect(
    result.evidence[0]?.synthesis?.peerless?.finalists?.some((c) => c.structurallyAdmitted),
  ).toBe(true);
});
