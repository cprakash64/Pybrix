import { beforeAll, expect, it } from 'vitest';
import {
  VIEW_NAMES,
  cameraFor,
  FRAME_FILL,
  type SemanticHierarchy,
  type SemanticPart,
} from '@cadfixer/auto-split-contract';
import { box } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import {
  decomposeSemantic,
  prepareSemanticGeometry,
  type PreparedSemanticGeometry,
} from './semantic';
import { majorSiblingConsistencyScorer } from './semantic-local-plane';
import { required } from './required';
let prepared: PreparedSemanticGeometry;
function member(id: string, low: number, high: number): SemanticPart {
  return {
    id,
    label: 'Unfamiliar member',
    parentId: null,
    importance: 'major',
    confidence: 0.99,
    instances: 1,
    componentIds: [],
    expectedGeometry: { kind: 'solid_part', likelySeparable: false },
    cut: null,
    views: VIEW_NAMES.flatMap((view, vi) => {
      const r = required(prepared.rasters[vi], 'raster'),
        camera = cameraFor(view),
        k = (r.size * FRAME_FILL) / (2 * prepared.geometry.radius);
      let x0 = r.size,
        y0 = r.size,
        x1 = -1,
        y1 = -1;
      for (let y = 0; y < r.size; y++)
        for (let x = 0; x < r.size; x++) {
          const j = y * r.size + x;
          if ((r.face[j] ?? -1) < 0) continue;
          const depth = r.depth?.[j];
          if (depth === undefined) continue;
          const world =
            ((camera.right[0] * (x + 0.5 - r.size / 2)) / k -
              (camera.up[0] * (y + 0.5 - r.size / 2)) / k +
              camera.forward[0] * depth) *
              prepared.geometry.scale +
            prepared.geometry.center[0];
          if (world < low || world > high) continue;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      return x1 < 0
        ? []
        : [
            {
              view,
              polygons: [
                [
                  [x0 / r.size, y0 / r.size],
                  [(x1 + 1) / r.size, y0 / r.size],
                  [(x1 + 1) / r.size, (y1 + 1) / r.size],
                  [x0 / r.size, (y1 + 1) / r.size],
                ],
              ],
            },
          ];
    }),
  };
}
beforeAll(async () => {
  prepared = await prepareSemanticGeometry(box([-47, -10, -7], [53, 10, 7]), fixtureDeflate);
});
function hierarchy(third: SemanticPart, fourth?: SemanticPart): SemanticHierarchy {
  return {
    object: { label: 'Unfamiliar assembly', confidence: 0.99 },
    parts: [member('a', 0.7, 100), member('b', -100, 0.7), third, ...(fourth ? [fourth] : [])],
  };
}
it('preserves a harmless third and fourth major while refusing a raw sibling with no executable proposal', () => {
  const harmless = decomposeSemantic(prepared, hierarchy(member('c', -11, 0.7)));
  expect(harmless.suggestions.find((s) => s.id === 'a')?.quality).toBe('SUGGESTED');
  const four = decomposeSemantic(prepared, hierarchy(member('c', -11, -5), member('d', -5, 0.7)));
  expect(four.suggestions.find((s) => s.id === 'a')?.quality).toBe('SUGGESTED');
  const bad = decomposeSemantic(prepared, hierarchy(member('c', -100, 16)));
  expect(bad.suggestions.find((s) => s.id === 'a')?.operation).toBe('NONE');
  expect(bad.evidence.find((e) => e.id === 'a')?.majorSiblingConsistency?.outcome).toBe(
    'CONTRADICTORY',
  );
  expect(bad.complementaryPairs).toHaveLength(0);
});
it('does not allow a target-side competing scope or a later fourth sibling to escape', () => {
  for (const h of [
    hierarchy(member('c', 18, 45)),
    hierarchy(member('c', -11, 0.7), member('d', -4, 40)),
  ]) {
    const q = decomposeSemantic(prepared, h);
    expect(q.suggestions.find((s) => s.id === 'a')?.operation).toBe('NONE');
  }
});
it('is invariant to record order and labels and excludes detail and unrelated contexts', () => {
  const original = hierarchy(member('c', -100, 16));
  const run = (h: SemanticHierarchy): string | undefined =>
    decomposeSemantic(prepared, h).suggestions.find((s) => s.id === 'a')?.operation;
  expect(run(original)).toBe('NONE');
  expect(
    run({
      ...original,
      parts: original.parts.toReversed().map((p) => ({ ...p, label: 'Different words' })),
    }),
  ).toBe('NONE');
  for (const change of [
    { importance: 'detail' as const },
    { parentId: 'a' },
    { parentId: 'other' },
  ]) {
    const changed = {
      ...original,
      parts: original.parts.map((p) => (p.id === 'c' ? { ...p, ...change } : p)),
    };
    const score = majorSiblingConsistencyScorer(
      prepared,
      changed,
      required(changed.parts[0], 'target'),
      () => undefined,
    );
    expect(
      score({
        normal: [1, 0, 0],
        origin: [(0.7 - prepared.geometry.center[0]) / prepared.geometry.scale, 0, 0],
      }).siblings.map((p) => p.id),
    ).not.toContain('c');
  }
});
it('cancels during collection and candidate scoring without altering source', () => {
  const h = hierarchy(member('c', -11, 0.7)),
    a = required(h.parts[0], 'target'),
    before = prepared.geometry.positions.slice();
  let calls = 0;
  expect(() =>
    majorSiblingConsistencyScorer(prepared, h, a, () => {
      if (++calls === 10) throw Error('cancel collection');
    }),
  ).toThrow('cancel collection');
  let scoring = false,
    steps = 0;
  const score = majorSiblingConsistencyScorer(prepared, h, a, () => {
    if (scoring && ++steps === 5) throw Error('cancel scoring');
  });
  scoring = true;
  expect(() => score({ normal: [1, 0, 0], origin: [0, 0, 0] })).toThrow('cancel scoring');
  expect(prepared.geometry.positions).toEqual(before);
});
it('uses candidate-relative shared support when a broad sibling dilutes its own selected fraction', () => {
  const a = member('target', 35, 100),
    b = member('complement', -100, 35),
    c = member('competitor', -100, 40),
    answer: SemanticHierarchy = {
      object: { label: 'Unfamiliar assembly', confidence: 0.99 },
      parts: [a, b, c],
    },
    cut = {
      normal: [1, 0, 0] as const,
      origin: [(35 - prepared.geometry.center[0]) / prepared.geometry.scale, 0, 0] as const,
    },
    result = majorSiblingConsistencyScorer(prepared, answer, a, () => undefined)(cut),
    competitor = required(
      result.siblings.find((s) => s.id === c.id),
      'competitor',
    );
  expect(result.outcome).toBe('CONTRADICTORY');
  expect(competitor.ownership).toBe('COMPETING');
  expect(competitor.competingAxes).toBeGreaterThanOrEqual(2);
  expect(
    competitor.views.filter((v) => v.total >= 8).every((v) => v.selected / v.total < 0.2),
  ).toBe(true);
  const weak: SemanticHierarchy = {
    ...answer,
    parts: [a, b, { ...c, views: c.views.filter((v) => v.view === 'front' || v.view === 'rear') }],
  };
  const uncertain = majorSiblingConsistencyScorer(prepared, weak, a, () => undefined)(cut);
  expect(uncertain.outcome).toBe('AMBIGUOUS');
  expect(uncertain.siblings.find((s) => s.id === c.id)?.ownership).toBe('INSUFFICIENT_EVIDENCE');
});
