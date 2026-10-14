import { describe, expect, it } from 'vitest';
import {
  validateSemanticHierarchy,
  validateSemanticMetadata,
  validSemanticPolygon,
  type SemanticPart,
  type SemanticHierarchy,
} from './semantic';
const part = (id = 'part'): SemanticPart => ({
  id,
  label: '自由形状 attachment',
  parentId: null,
  importance: 'major',
  confidence: 0.9,
  instances: 1,
  views: [
    {
      view: 'front',
      polygons: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    },
  ],
  componentIds: ['c000001'],
  expectedGeometry: { kind: 'unknown', likelySeparable: false },
  cut: null,
});
const hierarchy = (parts: readonly SemanticPart[]): SemanticHierarchy => ({
  object: { label: 'Unclassified object', confidence: 0.8 },
  parts,
});
describe('bounded free semantic hierarchy', () => {
  it('accepts free labels without a taxonomy but requires exact structural keys', () => {
    expect(validateSemanticHierarchy(hierarchy([part()])).ok).toBe(true);
    for (const wrong of [
      { ...hierarchy([part()]), extra: true },
      hierarchy([{ ...part(), confidence: NaN }]),
      hierarchy([{ ...part(), componentIds: ['filename'] }]),
      hierarchy([{ ...part(), cut: { normal: [0, 0, 0], origin: [0, 0, 0] } }]),
    ])
      expect(validateSemanticHierarchy(wrong).ok).toBe(false);
  });
  it('rejects too many parts, majors, points, instances and overlong text', () => {
    expect(
      validateSemanticHierarchy(
        hierarchy(
          Array.from({ length: 25 }, (_, i) => ({
            ...part(`p${String(i)}`),
            importance: 'detail',
          })),
        ),
      ).ok,
    ).toBe(false);
    expect(
      validateSemanticHierarchy(
        hierarchy(Array.from({ length: 9 }, (_, i) => part(`p${String(i)}`))),
      ).ok,
    ).toBe(false);
    for (const wrong of [
      { ...part(), instances: 13 },
      { ...part(), label: 'x'.repeat(65) },
      { ...part(), id: 'x'.repeat(49) },
      { ...part(), label: 'invalid\nlabel' },
    ])
      expect(validateSemanticHierarchy(hierarchy([wrong])).ok).toBe(false);
    expect(
      validSemanticPolygon(
        Array.from({ length: 13 }, (_, i) => [0.5 + 0.2 * Math.cos(i), 0.5 + 0.2 * Math.sin(i)]),
      ),
    ).toBe(false);
  });
  it('requires unique IDs, existing parents, acyclic hierarchy and depth no greater than four', () => {
    expect(validateSemanticHierarchy(hierarchy([part(), part()])).ok).toBe(false);
    expect(validateSemanticHierarchy(hierarchy([{ ...part(), parentId: 'missing' }])).ok).toBe(
      false,
    );
    expect(
      validateSemanticHierarchy(
        hierarchy([
          { ...part('a'), parentId: 'b' },
          { ...part('b'), parentId: 'a' },
        ]),
      ).ok,
    ).toBe(false);
    const chain = Array.from({ length: 5 }, (_, i) => ({
      ...part(`p${String(i)}`),
      importance: 'detail' as const,
      parentId: i ? `p${String(i - 1)}` : null,
    }));
    expect(validateSemanticHierarchy(hierarchy(chain.slice(0, 4))).ok).toBe(true);
    expect(validateSemanticHierarchy(hierarchy(chain)).ok).toBe(false);
  });
  it('allows a concave contour with disjoint collinear edges and rejects crossings, holes and degeneracy', () => {
    expect(
      validSemanticPolygon([
        [0, 0],
        [1, 0],
        [1, 1],
        [0.8, 1],
        [0.8, 0.2],
        [0.6, 0.2],
        [0.6, 1],
        [0, 1],
      ]),
    ).toBe(true);
    for (const wrong of [
      [
        [0, 0],
        [1, 1],
        [0, 1],
        [1, 0],
      ],
      [
        [0, 0],
        [0, 0],
        [1, 1],
      ],
      [
        [0, 0],
        [2, 0],
        [1, 1],
      ],
      new Array(4),
    ])
      expect(validSemanticPolygon(wrong)).toBe(false);
  });
  it('admits only bounded scalar component metadata', () => {
    const component = {
      id: 'c000000',
      faceCount: 12,
      bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      centroid: [0, 0, 0],
      areaShare: 0.5,
      aspect: [1, 1, 1],
      color: [100, 110, 120],
    };
    const metadata = { scope: 'selected-piece', totalComponents: 1, components: [component] };
    expect(validateSemanticMetadata(metadata)).toBe(true);
    for (const wrong of [
      { ...metadata, positions: [0] },
      { ...metadata, components: [{ ...component, faceCount: 0 }] },
      { ...metadata, components: [{ ...component, bounds: { min: [1, 1, 1], max: [0, 0, 0] } }] },
      {
        ...metadata,
        totalComponents: 65,
        components: Array.from({ length: 65 }, (_, i) => ({
          ...component,
          id: `c${String(i).padStart(6, '0')}`,
        })),
      },
    ])
      expect(validateSemanticMetadata(wrong)).toBe(false);
  });
});
