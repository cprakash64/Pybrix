import { beforeAll, describe, expect, it } from 'vitest';
import type { SemanticHierarchy, SemanticPart } from '@cadfixer/auto-split-contract';
import {
  prepareSemanticGeometry,
  decomposeSemantic,
  type PreparedSemanticGeometry,
} from './semantic';
import { annotatedFixture, semanticFixture } from './fixtures/semantic';
import { fixtureDeflate } from './fixtures/deflate';
import { box } from './fixtures/solids';
import { componentPieces } from './extract';
import { required } from './required';
let vehicle: PreparedSemanticGeometry,
  fused: PreparedSemanticGeometry,
  components: SemanticHierarchy;
const rect = (x0: number, x1: number) =>
  [
    [x0, 0],
    [x1, 0],
    [x1, 1],
    [x0, 1],
  ] as const;
function half(id: string, right: boolean, cut: SemanticPart['cut']): SemanticPart {
  return {
    id,
    parentId: null,
    label: right ? 'Detached assembly' : 'Main assembly',
    importance: 'major',
    confidence: 0.99,
    instances: 1,
    componentIds: [],
    views: ['front', 'top'].map((view) => ({
      view: view as 'front' | 'top',
      polygons: [rect(right ? 0.5 : 0, right ? 1 : 0.5)],
    })),
    cut,
    expectedGeometry: { kind: 'solid_part', likelySeparable: false },
  };
}
beforeAll(async () => {
  const fixture = semanticFixture('vehicle');
  vehicle = await prepareSemanticGeometry(fixture.mesh, fixtureDeflate);
  components = annotatedFixture(vehicle, fixture);
  fused = await prepareSemanticGeometry(box([-1, -1, -1], [1, 1, 1]), fixtureDeflate);
});
describe('local semantic realization with optional provider geometry hints', () => {
  it('A/B: extracts regions without IDs and recovers exactly four repeated wheels without the body', () => {
    const answer = {
      ...components,
      parts: components.parts.map((p) => ({
        ...p,
        componentIds: [],
        cut: null,
        expectedGeometry: { ...p.expectedGeometry, likelySeparable: false },
      })),
    };
    const result = decomposeSemantic(vehicle, answer),
      wheels = required(
        result.suggestions.find((s) => s.id === 'wheels'),
        'wheels',
      );
    expect(wheels.quality).toBe('READY');
    expect(wheels.operation).toBe('COMPONENT');
    expect(wheels.components).toHaveLength(4);
    const bodyRank = vehicle.labelling.faceRank[0];
    expect(wheels.components).not.toContain(bodyRank);
    const children = result.suggestions.filter((s) => s.parentId === 'wheels');
    expect(children).toHaveLength(4);
    expect(new Set(children.flatMap((s) => s.components)).size).toBe(4);
    const split = componentPieces(
      semanticFixture('vehicle').mesh,
      vehicle.labelling,
      wheels.components,
    );
    expect(split.selected.indices.length + split.rest.indices.length).toBe(
      semanticFixture('vehicle').mesh.indices.length,
    );
    expect(result.suggestions.find((s) => s.id === 'bed')?.quality).toBe('READY');
  });
  for (const [name, cut] of [
    ['C: absent', null],
    ['D: wrong orthogonal', { normal: [0, 0, 1], origin: [0, 0, 0] }],
    ['E: correct', { normal: [1, 0, 0], origin: [0, 0, 0] }],
    ['F: reversed', { normal: [-1, 0, 0], origin: [0, 0, 0] }],
  ] as const)
    it(`${name} plane hints retain local execution authority`, () => {
      const result = decomposeSemantic(fused, {
        object: { label: 'assembly', confidence: 1 },
        parts: [half('detached', true, cut), half('main', false, null)],
      });
      const candidate = required(
        result.suggestions.find((s) => s.id === 'detached'),
        'detached',
      );
      expect(candidate.quality).toBe('READY');
      expect(candidate.operation).toBe('PLANE');
      expect(candidate.plane?.normal[0]).toBeGreaterThan(0.5);
    });
  it('uncertain object taxonomy cannot relax synthesized-plane admission', () => {
    const result = decomposeSemantic(fused, {
      object: { label: 'unknown assembly', confidence: 0.2 },
      parts: [half('detached', true, null), half('main', false, null)],
    });
    expect(result.suggestions.every((s) => s.operation === 'NONE')).toBe(true);
  });
  it('G: identical competing masks remain ambiguous and non-executable', () => {
    const part = half('first', true, null);
    const result = decomposeSemantic(fused, {
      object: { label: 'assembly', confidence: 1 },
      parts: [part, { ...part, id: 'second' }],
    });
    expect(result.suggestions.every((s) => s.operation === 'NONE' && s.quality === 'UNSAFE')).toBe(
      true,
    );
  });
  it('H: a whole-model mask is recognized without inventing a split', () => {
    const part = half('whole', true, null);
    const result = decomposeSemantic(fused, {
      object: { label: 'box', confidence: 1 },
      parts: [{ ...part, views: part.views.map((v) => ({ ...v, polygons: [rect(0, 1)] })) }],
    });
    expect(result.suggestions[0]?.operation).toBe('NONE');
  });
  it('I: fused surface detail remains recognized without executable surgery', () => {
    const part = half('door', true, null);
    const result = decomposeSemantic(fused, {
      object: { label: 'body', confidence: 1 },
      parts: [{ ...part, expectedGeometry: { kind: 'surface_part', likelySeparable: false } }],
    });
    expect(result.suggestions[0]?.operation).toBe('NONE');
  });
  it('J: cancellation interrupts local synthesis before a result is admitted', () => {
    let visits = 0;
    expect(() =>
      decomposeSemantic(
        fused,
        {
          object: { label: 'assembly', confidence: 1 },
          parts: [half('detached', true, null), half('main', false, null)],
        },
        () => {
          if (++visits > 2) throw Error('cancelled');
        },
      ),
    ).toThrow('cancelled');
  });
});
