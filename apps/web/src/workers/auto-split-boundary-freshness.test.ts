import { afterEach, expect, it, vi } from 'vitest';
import type { Suggestion } from '@cadfixer/auto-split';
import type { OperationContext } from '@cadfixer/geometry-runtime';
import { uncancellable } from '@cadfixer/shared';
import { box } from '@cadfixer/auto-split/fixtures';
import { singlePartDocument, partId } from '@cadfixer/mesh-core';
const mock = vi.hoisted(() => ({
  qualify: vi.fn<
    () => Promise<{
      suggestions: readonly Suggestion[];
      attempts: number;
      partIds: readonly string[];
    }>
  >(),
}));
vi.mock('./semantic-boundary-qualification', () => ({ qualifySemanticBoundaries: mock.qualify }));
import { autoSplitRenderHandler, autoSplitSuggestHandler } from './auto-split-handlers';
import { residentDocuments } from './stl-handlers';
const context = (): OperationContext => ({
  cancellation: uncancellable,
  interruptible: false,
  reportProgress: () => undefined,
  throwIfCancelled: () => undefined,
});
afterEach(() => {
  residentDocuments.releaseAll();
  mock.qualify.mockReset();
});
it('does not publish an older confirmation after a newer source preparation completes', async () => {
  const source = residentDocuments.commit(singlePartDocument(box([-1, -1, -1], [1, 1, 1]))),
    part = partId('part-1'),
    payload = { source, partId: part, mode: 'semantic' as const };
  const prepared = await autoSplitRenderHandler(payload, context());
  if (prepared.value.preparationId === undefined) throw Error('Missing semantic preparation.');
  let finish: (() => void) | undefined;
  mock.qualify.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = (): void => {
          resolve({ suggestions: [], attempts: 0, partIds: [] });
        };
      }),
  );
  const pending = autoSplitSuggestHandler(
    {
      ...payload,
      preparationId: prepared.value.preparationId,
      analysis: {
        object: { label: 'Assembly', confidence: 0.99 },
        parts: [
          {
            id: 'part',
            label: 'Attachment',
            parentId: null,
            importance: 'major',
            confidence: 0.99,
            instances: 1,
            componentIds: [],
            cut: null,
            expectedGeometry: { kind: 'solid_part', likelySeparable: false },
            views: ['front', 'top'].map((view) => ({
              view,
              polygons: [
                [
                  [0.5, 0],
                  [1, 0],
                  [1, 1],
                  [0.5, 1],
                ],
              ],
            })),
          },
        ],
      },
    },
    context(),
  );
  expect(finish).toBeDefined();
  const rejection = expect(pending).rejects.toMatchObject({
    details: { code: 'AUTO_SPLIT_SOURCE_STALE' },
  });
  await autoSplitRenderHandler(payload, context());
  if (!finish) throw Error('Qualification did not reach the asynchronous boundary.');
  finish();
  await rejection;
});
