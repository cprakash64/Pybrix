import { beforeAll, describe, expect, it } from 'vitest';
import {
  cameraFor,
  FRAME_FILL,
  type SemanticHierarchy,
  type SemanticPart,
  type Vec3,
  type ViewName,
} from '@cadfixer/auto-split-contract';
import { box } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import {
  decomposeSemantic,
  prepareSemanticGeometry,
  type PreparedSemanticGeometry,
} from './semantic';

let prepared: PreparedSemanticGeometry;
beforeAll(async () => {
  prepared = await prepareSemanticGeometry(box([-6, -3, -3], [6, 3, 3]), fixtureDeflate);
});

function region(view: ViewName, sign: number): SemanticPart['views'][number] {
  const camera = cameraFor(view);
  const projected: number[][] = [];
  for (const x of sign > 0 ? [2, 6] : [-6, -2])
    for (const y of [-3, 3])
      for (const z of [-3, 3]) {
        const point = [x, y, z].map(
          (p, axis) => (p - (prepared.geometry.center[axis] ?? 0)) / prepared.geometry.scale,
        );
        const factor = FRAME_FILL / (2 * prepared.geometry.radius);
        projected.push([
          0.5 + factor * point.reduce((n, p, a) => n + p * (camera.right[a] ?? 0), 0),
          0.5 - factor * point.reduce((n, p, a) => n + p * (camera.up[a] ?? 0), 0),
        ]);
      }
  const lo = [0, 1].map((a) => Math.min(...projected.map((p) => p[a] ?? 0)));
  const hi = [0, 1].map((a) => Math.max(...projected.map((p) => p[a] ?? 0)));
  return {
    view,
    polygons: [
      [
        [lo[0] ?? 0, lo[1] ?? 0],
        [hi[0] ?? 0, lo[1] ?? 0],
        [hi[0] ?? 0, hi[1] ?? 0],
        [lo[0] ?? 0, hi[1] ?? 0],
      ],
    ],
  };
}
function hierarchy(
  kind: 'crossed' | 'clean' | 'identical' | 'overlap',
  sign: number,
): SemanticHierarchy {
  const part = (id: string, side: number): SemanticPart => ({
    id,
    label: 'Independent solid region',
    parentId: null,
    importance: 'major',
    confidence: 0.99,
    instances: 1,
    componentIds: [],
    expectedGeometry: { kind: 'solid_part', likelySeparable: true },
    cut: { normal: [side, 0, 0] as Vec3, origin: [(side * 2) / prepared.geometry.scale, 0, 0] },
    views: [region('front', side), region('top', kind === 'crossed' ? -side : side)],
  });
  const first = part('first', sign);
  const second = part('second', kind === 'identical' || kind === 'overlap' ? sign : -sign);
  return {
    object: { label: 'Unlabeled solid', confidence: 0.99 },
    parts: [
      first,
      kind === 'overlap'
        ? {
            ...second,
            views: second.views.map((v) => ({
              ...v,
              polygons: v.polygons.map((poly) => poly.map(([x, y]) => [x + 0.001, y] as const)),
            })),
          }
        : second,
    ],
  };
}

describe.each([-1, 1])('cross-view ownership with orientation %i', (sign) => {
  it('rejects incompatible target scopes in initial synthesis, not only paired rescoring', () => {
    const result = decomposeSemantic(prepared, hierarchy('crossed', sign));
    expect(result.suggestions).toHaveLength(2);
    for (const s of result.suggestions) {
      expect(s.operation).toBe('NONE');
      expect(s.plane).toBeNull();
      expect(s.semanticFinalists ?? []).toHaveLength(0);
    }
  });
  it('retains supported cuts when the views describe the same physical region', () => {
    const result = decomposeSemantic(prepared, hierarchy('clean', sign));
    expect(result.suggestions.some((s) => s.operation === 'PLANE')).toBe(true);
  });
  it('removes every nested realization when identical sibling ownership is refused', () => {
    const result = decomposeSemantic(prepared, hierarchy('identical', sign));
    expect(result.suggestions).toHaveLength(2);
    for (const s of result.suggestions) {
      expect(s.operation).toBe('NONE');
      expect(s.plane).toBeNull();
      expect(s.components).toEqual([]);
      expect(s.semanticFinalists ?? []).toHaveLength(0);
      expect(s.semanticScopeAuthority).toBeUndefined();
      expect(s.boundaryAmbiguity).toBeUndefined();
      expect(s.boundaryConfirmation).toBeUndefined();
      expect(s.sharedBoundary).toBeUndefined();
    }
  });
  it('does not retain fallback cuts on refused overlapping sibling records', () => {
    const result = decomposeSemantic(prepared, hierarchy('overlap', sign));
    for (const s of result.suggestions.filter((s) => s.operation === 'NONE')) {
      expect(s.semanticFinalists ?? []).toHaveLength(0);
      expect(s.semanticScopeAuthority).toBeUndefined();
    }
    expect(result.suggestions.some((s) => s.operation === 'NONE')).toBe(true);
  });
});
