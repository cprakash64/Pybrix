import { describe, it, expect, beforeAll } from 'vitest';
import {
  VIEW_NAMES,
  type SemanticHierarchy,
  type SemanticPart,
} from '@cadfixer/auto-split-contract';
import {
  prepareSemanticGeometry,
  decomposeSemantic,
  type PreparedSemanticGeometry,
} from './semantic';
import { box, concatMeshes, voxelUnion } from './fixtures';
import { annotatedPart } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { semanticRoleScope, componentSemanticExtents } from './semantic-extent';
const b = (
  lo: number[],
  hi: number[],
): { lo: [number, number, number]; hi: [number, number, number] } => ({
  lo: lo as [number, number, number],
  hi: hi as [number, number, number],
});
let p: PreparedSemanticGeometry, parent: SemanticPart, child: SemanticPart;
async function prepare(
  mesh: CanonicalMesh,
  predicate: (xyz: number[]) => boolean,
): Promise<{ p: PreparedSemanticGeometry; parent: SemanticPart; child: SemanticPart }> {
  const p = await prepareSemanticGeometry(
      concatMeshes([mesh, box([10, -1, 0], [12, 1, 2])]),
      fixtureDeflate,
    ),
    rank = p.labelling.faceRank[0] ?? 0;
  const parent = {
    ...annotatedPart(p, 'physical', 'Physical part', [rank]),
    componentIds: [],
    expectedGeometry: { kind: 'solid_part' as const, likelySeparable: true },
  };
  const child: SemanticPart = {
    ...parent,
    id: 'feature',
    label: 'Other physical part',
    parentId: parent.id,
    importance: 'detail',
    expectedGeometry: { kind: 'solid_part', likelySeparable: false },
    views: VIEW_NAMES.flatMap((view, vi) => {
      const r = p.rasters[vi];
      if (!r) return [];
      let x0 = r.size,
        y0 = r.size,
        x1 = -1,
        y1 = -1;
      for (let i = 0; i < r.face.length; i++) {
        const f = r.face[i] ?? -1;
        if (f < 0 || p.labelling.faceRank[f] !== rank) continue;
        const xyz = [0, 1, 2].map(
          (a) =>
            [0, 1, 2].reduce(
              (s, k) =>
                s + (p.geometry.positions[(p.geometry.indices[f * 3 + k] ?? 0) * 3 + a] ?? 0),
              0,
            ) / 3,
        );
        // Predicates use normalized geometry: only the relative vertical/axial boundary matters.
        const source = xyz.map((x, a) => x * p.geometry.scale + (p.geometry.center[a] ?? 0));
        if (!predicate(source)) continue;
        const x = i % r.size,
          y = Math.floor(i / r.size);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      return x1 >= x0
        ? [
            {
              view,
              polygons: [
                [
                  [x0 / r.size, y0 / r.size],
                  [(x1 + 1) / r.size, y0 / r.size],
                  [(x1 + 1) / r.size, (y1 + 1) / r.size],
                  [x0 / r.size, (y1 + 1) / r.size],
                ] as const,
              ],
            },
          ]
        : [];
    }),
  };
  return { p, parent, child };
}
const hierarchy = (parent: SemanticPart, child: SemanticPart): SemanticHierarchy => ({
  object: { label: 'Unspecified assembly', confidence: 0.95 },
  parts: [parent, child],
});
beforeAll(async () => {
  ({ p, parent, child } = await prepare(
    voxelUnion([b([-3, -2, 0], [3, 2, 4]), b([-1, -1, 4], [1, 1, 5]), b([-2, -2, 5], [2, 2, 7])]),
    (x) => (x[2] ?? 0) >= 5,
  ));
});
describe('semantic ownership before component READY', () => {
  it('blocks a localized physical child even when the parent polygon includes it', () => {
    const out = decomposeSemantic(p, hierarchy(parent, child));
    expect(out.suggestions.find((s) => s.id === parent.id)?.operation).toBe('NONE');
    expect(out.evidence.find((e) => e.id === parent.id)?.semanticExtent?.conflicts[0]?.id).toBe(
      child.id,
    );
  });
  it('uses existing calm mapping copy', () => {
    const s = decomposeSemantic(p, hierarchy(parent, child)).suggestions[0];
    expect(s?.diagnostic).toBe('MAPPING_UNCERTAIN');
    expect(s?.quality).toBe('RECOGNIZED_NOT_SEPARABLE');
  });
  it('does not erase the child semantic concept', () => {
    expect(
      decomposeSemantic(p, hierarchy(parent, child)).suggestions.some((s) => s.id === child.id),
    ).toBe(true);
  });
  it('blocks sibling physical ownership regardless of arbitrary labels and IDs', () => {
    const a = { ...parent, id: 'a', label: 'Alpha' },
      b = { ...child, id: 'b', label: 'Beta', parentId: null };
    expect(
      decomposeSemantic(p, hierarchy(a, b)).suggestions.find((s) => s.id === 'a')?.operation,
    ).toBe('NONE');
  });
  it('a single imperfect view cannot establish competing ownership', () => {
    const b = { ...child, views: child.views.slice(0, 1) };
    expect(decomposeSemantic(p, hierarchy(parent, b)).suggestions[0]?.operation).toBe('COMPONENT');
  });
  it('unannotated child geometry remains unknown rather than negative', () => {
    expect(
      decomposeSemantic(p, hierarchy(parent, { ...child, views: [] })).suggestions[0]?.operation,
    ).toBe('COMPONENT');
  });
  it('whole-region hierarchy overlap is not a localized physical competitor', () => {
    expect(
      decomposeSemantic(p, hierarchy(parent, { ...child, views: parent.views })).suggestions[0]
        ?.operation,
    ).toBe('COMPONENT');
  });
  it('decorative surface relief belongs to the body role', () => {
    expect(
      decomposeSemantic(
        p,
        hierarchy(parent, {
          ...child,
          expectedGeometry: { kind: 'surface_part', likelySeparable: false },
        }),
      ).suggestions[0]?.operation,
    ).toBe('COMPONENT');
  });
  it('aggregate intent also requires inclusive hierarchy and local support', () => {
    const assembly = { ...parent, label: 'Lid assembly' };
    expect(decomposeSemantic(p, hierarchy(assembly, child)).suggestions[0]?.operation).toBe(
      'COMPONENT',
    );
    expect(semanticRoleScope({ ...assembly, views: [] }, hierarchy(assembly, child))).toBe(
      'EXTRACTABLE_PART',
    );
  });
  it('aggregate scope does not excuse a competing sibling', () => {
    const assembly = { ...parent, label: 'Wheel assembly' },
      sibling = { ...child, id: 'sibling', parentId: null };
    const a = { ...hierarchy(assembly, child), parts: [assembly, child, sibling] };
    expect(decomposeSemantic(p, a).suggestions[0]?.operation).toBe('NONE');
  });
  for (const [name, shape, boundary] of [
    [
      'body + removable panel',
      [b([-3, -2, 0], [3, 2, 4]), b([3, -1, 1], [4, 1, 4])],
      (x: number[]): boolean => (x[0] ?? 0) >= 3,
    ],
    [
      'base + attached cap',
      [b([-3, -3, 0], [3, 3, 1]), b([-1, -1, 1], [1, 1, 4]), b([-2, -2, 4], [2, 2, 6])],
      (x: number[]): boolean => (x[2] ?? 0) >= 4,
    ],
    [
      'fused chair seat + back',
      [b([-3, -2, 3], [3, 2, 4]), b([-3, 1, 4], [3, 2, 8])],
      (x: number[]): boolean => (x[2] ?? 0) >= 4,
    ],
  ] as const)
    it(`negative ${name} remains non-READY`, async () => {
      const f = await prepare(voxelUnion([...shape]), boundary);
      expect(decomposeSemantic(f.p, hierarchy(f.parent, f.child)).suggestions[0]?.operation).toBe(
        'NONE',
      );
    });
  it('cancels before admission without source mutation', () => {
    const before = p.geometry.positions.slice();
    let visits = 0;
    expect(() =>
      decomposeSemantic(p, hierarchy(parent, child), () => {
        if (++visits > 30) throw Error('cancelled');
      }),
    ).toThrow('cancelled');
    expect(p.geometry.positions).toEqual(before);
  });
  for (const relation of ['child', 'sibling'] as const)
    it(`a refused group preserves its valid ${relation} component`, async () => {
      const mesh = concatMeshes([
        box([-4, -1, 0], [-2, 1, 3]),
        box([0, -1, 0], [2, 1, 3]),
        box([6, -4, 0], [12, 4, 5]),
      ]);
      const g = await prepareSemanticGeometry(mesh, fixtureDeflate),
        r0 = g.labelling.faceRank[0] ?? 0,
        r1 = g.labelling.faceRank[12] ?? 0;
      const broad = {
        ...annotatedPart(g, 'group', 'Physical group', [r0, r1]),
        componentIds: [],
        expectedGeometry: { kind: 'solid_part' as const, likelySeparable: true },
      };
      const narrow = {
        ...annotatedPart(g, 'specific', 'Other requested part', [r1]),
        parentId: relation === 'child' ? 'group' : null,
        componentIds: [],
        expectedGeometry: { kind: 'solid_part' as const, likelySeparable: true },
      };
      const out = decomposeSemantic(g, hierarchy(broad, narrow));
      expect(out.suggestions.find((s) => s.id === 'group')?.operation).toBe('NONE');
      expect(out.suggestions.find((s) => s.id === 'specific')?.operation).toBe('COMPONENT');
    });
  it('a true integrated lid/handle assembly retains its complete scope', async () => {
    const f = await prepare(
      voxelUnion([
        b([-4, -3, 0], [4, 3, 1]),
        b([-2, -1, 1], [-1, 1, 4]),
        b([1, -1, 1], [2, 1, 4]),
        b([-2, -1, 3], [2, 1, 4]),
      ]),
      (x) => (x[2] ?? 0) > 1,
    );
    const a = { ...f.parent, label: 'Lid assembly' };
    expect(
      decomposeSemantic(f.p, hierarchy(a, { ...f.child, label: 'Integrated handle' }))
        .suggestions[0]?.operation,
    ).toBe('COMPONENT');
  });
  it('a fused tire/spoke/hub wheel assembly retains its complete scope', async () => {
    const f = await prepare(
      voxelUnion([
        b([-4, -1, -4], [4, 1, -3]),
        b([-4, -1, 3], [4, 1, 4]),
        b([-4, -1, -3], [-3, 1, 3]),
        b([3, -1, -3], [4, 1, 3]),
        b([-3, -1, -1], [3, 1, 1]),
        b([-1, -2, -1], [1, 2, 1]),
      ]),
      (x) => Math.abs(x[0] ?? 0) <= 1 && Math.abs(x[2] ?? 0) <= 1,
    );
    const a = { ...f.parent, label: 'Wheel assembly' };
    expect(
      decomposeSemantic(f.p, hierarchy(a, { ...f.child, label: 'Central hub' })).suggestions[0]
        ?.operation,
    ).toBe('COMPONENT');
  });
  it('ownership pass cancellation publishes no partial result', () => {
    const baseline = decomposeSemantic(p, hierarchy(parent, { ...child, views: [] })),
      support = p.rasters.map((r) => new Uint32Array(r.face.length));
    let checks = 0,
      result: unknown;
    const positions = p.geometry.positions.slice();
    expect(() => {
      result = componentSemanticExtents(
        p,
        hierarchy(parent, child),
        baseline.suggestions,
        support,
        () => {
          if (++checks === 3) throw Error('cancelled');
        },
        () => undefined,
      );
    }).toThrow('cancelled');
    expect(result).toBeUndefined();
    expect(p.geometry.positions).toEqual(positions);
  });
  it('a large distinct physical child cannot hide behind the component correspondence floor', () => {
    const baseline = decomposeSemantic(p, hierarchy(parent, { ...child, views: [] }));
    const local = {
      ...p,
      rasters: p.rasters
        .slice(0, 2)
        .map((r, i) => ({ ...r, size: 8, face: new Int32Array(64).fill(i) })),
    };
    const support = local.rasters.map(() =>
      Uint32Array.from({ length: 64 }, (_, i) => (i < 56 ? 3 : 1)),
    );
    const result = componentSemanticExtents(
      local,
      hierarchy(parent, child),
      baseline.suggestions,
      support,
      () => undefined,
      () => undefined,
    );
    expect(result.get(parent.id)?.admitted).toBe(false);
    expect(result.get(parent.id)?.conflicts[0]?.id).toBe(child.id);
  });
});
