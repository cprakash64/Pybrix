import { expect, it } from 'vitest';
import { required } from './required';
import type { SuggestedPlane } from './suggestions';
import {
  qualifyBoundaryConfirmation,
  selectBoundaryAlternative,
  type BoundaryAmbiguity,
  type BoundaryAlternative,
} from './semantic-boundary-confirmation';
const plane = (x: number): SuggestedPlane => ({
  normal: [1, 0, 0] as const,
  origin: [x, 0, 0] as const,
});
const ambiguity = (): BoundaryAmbiguity => ({
  targetId: 'part',
  route: 'STRUCTURAL_SEAM',
  interfaceOwnership: 'AMBIGUOUS',
  materialUnknownInterface: true,
  hypotheses: [0, 1].map((x) => ({
    plane: plane(x),
    ownershipClass: x === 0 ? 'TARGET_SIDE' : 'BODY_SIDE',
    semanticAdmission: true,
    preservesPositiveEvidence: true,
    respectsKnownOwnership: true,
  })),
});
const proof: BoundaryAlternative['nativeProof'] = {
  valid: true,
  sourcePreserved: true,
  partitionCount: 2,
};
it('publishes exactly two native-proven choices and requires an explicit matching selection', async () => {
  const attempted: number[] = [];
  const result = await qualifyBoundaryConfirmation(ambiguity(), {
    checkpoint: () => undefined,
    charge: () => undefined,
    validate: (cut) => {
      attempted.push(cut.origin[0]);
      return Promise.resolve(proof);
    },
    isNativeInvalid: () => false,
  });
  expect(attempted).toEqual([0, 1]);
  expect(result?.status).toBe('NEEDS_BOUNDARY_CONFIRMATION');
  expect(result?.alternatives.map((a) => a.previewMetadata.label)).toEqual([
    'Option A',
    'Option B',
  ]);
  expect(result && selectBoundaryAlternative(result, 'missing')).toBeUndefined();
  expect(result && selectBoundaryAlternative(result, 'part:boundary:1')?.plane).toEqual(plane(1));
});
it('never publishes one valid alternative when the second fails native validation', async () => {
  let attempts = 0;
  expect(
    await qualifyBoundaryConfirmation(ambiguity(), {
      checkpoint: () => undefined,
      charge: () => undefined,
      validate: () => {
        if (++attempts === 2) throw Error('native invalid');
        return Promise.resolve(proof);
      },
      isNativeInvalid: () => true,
    }),
  ).toBeUndefined();
  expect(attempts).toBe(2);
});
it('deduplicates ownership representatives and refuses equivalent planes or an oversized pool', async () => {
  let attempts = 0;
  const control: Parameters<typeof qualifyBoundaryConfirmation>[1] = {
    checkpoint: () => undefined,
    charge: () => undefined,
    validate: () => {
      attempts++;
      return Promise.resolve(proof);
    },
    isNativeInvalid: () => false,
  };
  const a = ambiguity();
  expect(
    await qualifyBoundaryConfirmation(
      { ...a, hypotheses: a.hypotheses.map((h) => ({ ...h, plane: plane(0) })) },
      control,
    ),
  ).toBeUndefined();
  expect(
    await qualifyBoundaryConfirmation(
      { ...a, hypotheses: [...a.hypotheses, ...a.hypotheses] },
      control,
    ),
  ).toBeUndefined();
  expect(attempts).toBe(0);
  expect(
    (
      await qualifyBoundaryConfirmation(
        { ...a, hypotheses: [...a.hypotheses, required(a.hypotheses[0], 'hypothesis')] },
        control,
      )
    )?.alternatives,
  ).toHaveLength(2);
  expect(attempts).toBe(2);
});
for (const cancellation of ['detection', 'alternative2', 'publication'] as const)
  it(`does not publish confirmation after cancellation at ${cancellation}`, async () => {
    let cancelled = cancellation === 'detection',
      attempts = 0;
    const checkpoint = (): void => {
      if (cancelled) throw Error('cancelled');
    };
    await expect(
      qualifyBoundaryConfirmation(ambiguity(), {
        checkpoint,
        charge: () => undefined,
        validate: () => {
          attempts++;
          if (attempts === 2) {
            cancelled = true;
            if (cancellation === 'alternative2') checkpoint();
          }
          return Promise.resolve(proof);
        },
        isNativeInvalid: () => true,
      }),
    ).rejects.toThrow('cancelled');
    expect(attempts).toBe(cancellation === 'detection' ? 0 : 2);
  });
it('propagates unexpected failures without a confirmation result', async () => {
  await expect(
    qualifyBoundaryConfirmation(ambiguity(), {
      checkpoint: () => undefined,
      charge: () => undefined,
      validate: () => {
        throw Error('unexpected');
      },
      isNativeInvalid: () => false,
    }),
  ).rejects.toThrow('unexpected');
});
