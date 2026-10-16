import { it, expect } from 'vitest';
import { box, concatMeshes, meshOf, type Triangle } from './fixtures/solids';
import { annotatedPart } from './fixtures/semantic';
import { fixtureDeflate } from './fixtures/deflate';
import { prepareSemanticGeometry, decomposeSemantic } from './semantic';
import { required } from './required';
it('allows unfamiliar abstract geometry with independently proved base/ring/plate components', async () => {
  const point = (i: number, j: number): [number, number, number] => {
      const a = (i * 2 * Math.PI) / 16,
        b = (j * 2 * Math.PI) / 8,
        r = 2 + 0.5 * Math.cos(b);
      return [r * Math.cos(a), r * Math.sin(a), 0.5 * Math.sin(b)];
    },
    triangles: Triangle[] = [];
  for (let i = 0; i < 16; i++)
    for (let j = 0; j < 8; j++)
      triangles.push(
        [point(i, j), point((i + 1) % 16, j), point((i + 1) % 16, (j + 1) % 8)],
        [point(i, j), point((i + 1) % 16, (j + 1) % 8), point(i, (j + 1) % 8)],
      );
  const source = concatMeshes([
      box([-9, -2, -1], [-5, 2, 1]),
      meshOf(triangles),
      box([5, -2, -0.25], [9, 2, 0.25]),
    ]),
    p = await prepareSemanticGeometry(source, fixtureDeflate),
    before = source.positions.slice(),
    parts = ['Base', 'Ring', 'Plate'].map((label, i) =>
      annotatedPart(p, label.toLowerCase(), label, [
        required(p.labelling.faceRank[i === 0 ? 0 : i === 1 ? 12 : 268], 'control rank'),
      ]),
    );
  const result = decomposeSemantic(p, {
    object: { label: 'Unfamiliar abstract sculpture', confidence: 0.99 },
    parts,
  });
  expect(
    result.suggestions.filter((s) => s.operation === 'COMPONENT' && s.quality === 'READY'),
  ).toHaveLength(3);
  expect(source.positions).toEqual(before);
});
