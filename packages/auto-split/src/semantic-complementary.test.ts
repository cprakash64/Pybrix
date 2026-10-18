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
import { reconcileComplementarySiblings } from './semantic-complementary';
import { planeOwnershipTelemetry, type LocalPlaneProposal } from './semantic-local-plane';
import { required } from './required';
let prepared: PreparedSemanticGeometry, answer: SemanticHierarchy;
let proposals: Map<string, LocalPlaneProposal>;
let baseline: ReturnType<typeof decomposeSemantic>;
beforeAll(async () => {
  prepared = await prepareSemanticGeometry(box([-18, -5, -3], [21, 5, 3]), fixtureDeflate);
  const parts: SemanticPart[] = [1, -1].map((sign) => ({
    id: sign === 1 ? 'a' : 'b',
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
          if (sign * (world - 0.73) < 0) continue;
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
  }));
  answer = { object: { label: 'Unfamiliar structure', confidence: 0.99 }, parts };
  const result = decomposeSemantic(prepared, answer);
  baseline = result;
  proposals = new Map(
    result.evidence.flatMap((e) => (e.localPlane ? [[e.id, e.localPlane] as const] : [])),
  );
});
it('one bounded shared partition is independent of labels and semantic record order', () => {
  const a = baseline,
    b = decomposeSemantic(prepared, {
      ...answer,
      parts: answer.parts.toReversed().map((p) => ({ ...p, label: 'Changed words' })),
    });
  expect(a.complementaryPairs).toHaveLength(1);
  for (const id of ['a', 'b']) {
    const first = required(
        a.suggestions.find((s) => s.id === id),
        'first',
      ),
      second = required(
        b.suggestions.find((s) => s.id === id),
        'second',
      );
    expect(first.quality).toBe('SUGGESTED');
    expect(first.plane).toEqual(second.plane);
    expect(first.semanticFinalists).toHaveLength(3);
  }
  const left = required(a.suggestions[0]?.plane ?? undefined, 'left'),
    right = required(a.suggestions[1]?.plane ?? undefined, 'right');
  expect(left.origin).toEqual(right.origin);
  expect(left.normal.map((n) => -n)).toEqual(right.normal);
});
it.each(['nested', 'descendant', 'detail', 'weak'] as const)(
  'does not reconcile %s observations',
  (kind) => {
    const first = required(answer.parts[0], 'first'),
      second = required(answer.parts[1], 'second');
    const changed = {
      ...second,
      ...(kind === 'nested'
        ? { views: first.views }
        : kind === 'descendant'
          ? { parentId: first.id }
          : kind === 'detail'
            ? { importance: 'detail' as const }
            : { views: second.views.slice(0, 2) }),
    };
    const result = reconcileComplementarySiblings(
      prepared,
      { ...answer, parts: [first, changed] },
      new Map(proposals),
      () => undefined,
      {
        telemetry: planeOwnershipTelemetry(),
        charge: (): void => {
          /* This isolated proof test does not impose a work budget. */
        },
      },
    );
    expect(result.pairs).toHaveLength(0);
  },
);
it.each(['discovery', 'cross-score'] as const)(
  'cancels during %s without publishing a partition',
  (phase) => {
    const context = {
      telemetry: planeOwnershipTelemetry(),
      charge: (): void => {
        /* This isolated proof test does not impose a work budget. */
      },
    };
    let work = 0;
    const checkpoint = (): void => {
      if (phase === 'discovery' ? ++work === 2 : context.telemetry.peerScoringPasses > 0)
        throw Error('cancelled');
    };
    const source = prepared.geometry.positions.slice(),
      before = [...proposals];
    expect(() =>
      reconcileComplementarySiblings(prepared, answer, new Map(proposals), checkpoint, context),
    ).toThrow('cancelled');
    expect([...proposals]).toEqual(before);
    expect(prepared.geometry.positions).toEqual(source);
  },
);
