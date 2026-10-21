import { beforeEach, expect, it, vi } from 'vitest';
import type {
  DocumentHandle,
  OperationContext,
  SplitCreatePayload,
} from '@cadfixer/geometry-runtime';
import { uncancellable, invalidState } from '@cadfixer/shared';
import type { Suggestion } from '@cadfixer/auto-split';
const mocks = vi.hoisted(() => ({
  create:
    vi.fn<
      (
        payload: SplitCreatePayload,
        context: OperationContext,
      ) => Promise<{ value: { candidate: { candidateId: string } } }>
    >(),
  discard: vi.fn(),
}));
vi.mock('./split-handlers', () => ({ splitCreateHandler: mocks.create }));
vi.mock('./stl-handlers', () => ({ splitCandidates: { discard: mocks.discard } }));
import { qualifySemanticBoundaries } from './semantic-boundary-qualification';
const source = { documentId: 'boundary-worker', revision: 0 } as DocumentHandle;
const suggestion: Suggestion = {
  id: 'part',
  family: 'semantic',
  label: 'Assembly',
  operation: 'NONE',
  status: 'UNAVAILABLE',
  reason: 'CLEAR',
  plane: null,
  components: [],
  quality: 'RECOGNIZED_NOT_SEPARABLE',
  boundaryAmbiguity: {
    targetId: 'part',
    route: 'STRUCTURAL_SEAM',
    interfaceOwnership: 'AMBIGUOUS',
    materialUnknownInterface: true,
    hypotheses: [0, 1].map((x) => ({
      plane: { normal: [1, 0, 0], origin: [x, 0, 0] },
      ownershipClass: x === 0 ? 'TARGET_SIDE' : 'BODY_SIDE',
      semanticAdmission: true,
      preservesPositiveEvidence: true,
      respectsKnownOwnership: true,
    })),
  },
};
const context = (): OperationContext => ({
  cancellation: uncancellable,
  interruptible: false,
  reportProgress: () => undefined,
  throwIfCancelled: () => undefined,
});
beforeEach(() => {
  mocks.create.mockReset();
  mocks.discard.mockReset();
  mocks.create.mockImplementation(() =>
    Promise.resolve({ value: { candidate: { candidateId: 'temporary' } } }),
  );
});
it('validates without connectors, discards both temporary previews, and publishes only scalar choices', async () => {
  const result = await qualifySemanticBoundaries(
    source,
    'source-part',
    100,
    [suggestion],
    context(),
  );
  expect(result.attempts).toBe(2);
  expect(result.partIds).toEqual(['part']);
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.discard).toHaveBeenCalledTimes(2);
  for (const call of mocks.create.mock.calls) {
    expect(call[0].source).toBe(source);
    expect(call[0].request.connector).toEqual({ kind: 'none' });
    expect(call[0].semanticQualification).toBeUndefined();
  }
  expect(result.suggestions[0]?.quality).toBe('NEEDS_BOUNDARY_CONFIRMATION');
  expect(result.suggestions[0]?.operation).toBe('NONE');
  expect(result.suggestions[0]?.plane).toBeNull();
  expect(result.suggestions[0]?.boundaryAmbiguity).toBeUndefined();
  expect(result.suggestions[0]?.boundaryConfirmation?.alternatives).toHaveLength(2);
});
it('does not turn native failure into a one-option confirmation or automatic READY', async () => {
  mocks.create.mockRejectedValueOnce(invalidState('native invalid'));
  const result = await qualifySemanticBoundaries(
    source,
    'source-part',
    100,
    [suggestion],
    context(),
  );
  expect(result.suggestions[0]?.quality).toBe('RECOGNIZED_NOT_SEPARABLE');
  expect(result.suggestions[0]?.boundaryConfirmation).toBeUndefined();
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it('discards the second native preview when cancellation arrives before confirmation', async () => {
  let cancelled = false,
    attempts = 0;
  mocks.create.mockImplementation(() => {
    if (++attempts === 2) cancelled = true;
    return Promise.resolve({ value: { candidate: { candidateId: 'temporary' } } });
  });
  const control = {
    ...context(),
    throwIfCancelled: (): void => {
      if (cancelled) throw Error('cancelled');
    },
  };
  await expect(
    qualifySemanticBoundaries(source, 'source-part', 100, [suggestion], control),
  ).rejects.toThrow('cancelled');
  expect(mocks.discard).toHaveBeenCalledTimes(2);
});
it('preserves the one-attempt large-source ceiling and does not publish an unvalidated choice', async () => {
  const result = await qualifySemanticBoundaries(
    source,
    'source-part',
    500_000,
    [suggestion],
    context(),
  );
  expect(result.attempts).toBe(0);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(result.suggestions[0]?.boundaryConfirmation).toBeUndefined();
});
