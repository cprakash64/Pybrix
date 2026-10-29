import { describe, it, expect, vi } from 'vitest';
import {
  issueScopeReceipt,
  confirmScopeReceipt,
  cancelScopeReceipt,
} from './semantic-scope-authority';
import { semanticPlaneIdentity } from '@cadfixer/auto-split';
import type { SplitCreateResult } from '@cadfixer/geometry-runtime';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing fixture');
  return value;
}
function fixture(automatic = false): {
  physical: object;
  preview: SplitCreateResult;
  issued: ReturnType<typeof issueScopeReceipt>;
  id: string;
  stale: () => void;
} {
  let current = true;
  const physical = {};
  const preview = {
    candidate: {
      documentId: 'd',
      sourceRevision: 1,
      partId: 'p',
      generation: 1,
      candidateId: crypto.randomUUID(),
    },
    semanticQualification: {
      preparationId: 1,
      candidateId: 'semantic',
      plane: { normal: [1, 0, 0], origin: [2, 0, 0] },
      attempts: 1,
      failures: 0,
      winnerIndex: 0,
      milliseconds: 1,
    },
  } as unknown as SplitCreateResult;
  const issued = issueScopeReceipt(preview, physical, { automatic, current: () => current });
  const id = required(issued.proof.scopeConfirmation).receiptId;
  return {
    physical,
    preview,
    issued,
    id,
    stale: (): void => {
      current = false;
    },
  };
}
describe('physical scope authority', () => {
  it('fails closed before choice and reuses the exact immutable result', () => {
    const f = fixture();
    expect(f.issued.proof.scopeConfirmation?.state).toBe('REQUIRED');
    expect(() => {
      f.issued.authorizeCommit();
    }).toThrow();
    const confirmed = confirmScopeReceipt(f.id, () => f.physical);
    expect(confirmed.candidate).toBe(f.preview.candidate);
    expect(confirmed.proof.scopeConfirmation?.state).toBe('CONFIRMED');
    f.issued.authorizeCommit();
    expect(() => {
      f.issued.authorizeCommit();
    }).toThrow();
    expect(() => confirmScopeReceipt(f.id, () => f.physical)).toThrow();
  });
  it('rejects guessed malformed wrong-candidate and altered-result receipts', () => {
    const f = fixture();
    for (const id of ['', 'guessed', f.id + 'x'])
      expect(() => confirmScopeReceipt(id, () => f.physical)).toThrow();
    expect(() => confirmScopeReceipt(f.id, () => ({}))).toThrow();
  });
  it('invalidates on source revision part preparation or generation change', () => {
    for (const reason of ['document', 'revision', 'mesh', 'part', 'preparation', 'generation']) {
      const f = fixture();
      f.stale();
      expect(() => confirmScopeReceipt(f.id, () => f.physical), reason).toThrow();
      expect(() => {
        f.issued.authorizeCommit();
      }).toThrow();
    }
  });
  it('cancellation and a different physical result invalidate old authority', () => {
    const a = fixture();
    confirmScopeReceipt(a.id, () => a.physical);
    cancelScopeReceipt(a.preview.candidate);
    expect(() => {
      a.issued.authorizeCommit();
    }).toThrow();
    const b = fixture();
    fixture();
    expect(() => confirmScopeReceipt(b.id, () => b.physical)).toThrow();
    expect(() => {
      b.issued.authorizeCommit();
    }).toThrow();
  });
  it('only trusted IDENTIFIED exemption skips user confirmation, still one-use', () => {
    const f = fixture(true);
    expect(f.issued.proof.scopeConfirmation?.state).toBe('AUTOMATIC_IDENTIFIED');
    f.issued.authorizeCommit();
    expect(() => {
      f.issued.authorizeCommit();
    }).toThrow();
  });
  it('canonicalizes signed zero and identical hyperplanes without merging refined planes or sides', () => {
    const a = semanticPlaneIdentity({ normal: [1, 0, -0], origin: [2, 0, 0] });
    expect(semanticPlaneIdentity({ normal: [2, -0, 0], origin: [2, 5, 9] })).toEqual(a);
    const reverse = semanticPlaneIdentity({ normal: [-4, 0, 0], origin: [2, 0, 0] });
    expect(reverse.hyperplane).toBe(a.hyperplane);
    expect(reverse.positiveSide).not.toBe(a.positiveSide);
    expect(
      semanticPlaneIdentity({ normal: [1, 0, 0], origin: [2.000000000000001, 0, 0] }),
    ).not.toEqual(a);
  });
});

it('expires an opaque receipt and releases its lookup without reviving ticket authority', () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    vi.advanceTimersByTime(240_001);
    expect(() => confirmScopeReceipt(f.id, () => f.physical)).toThrow();
    expect(() => {
      f.issued.authorizeCommit();
    }).toThrow();
  } finally {
    vi.useRealTimers();
  }
});

it('client-like confirmed flags on a Preview never create trusted authority', () => {
  const f = fixture();
  expect(f.issued.proof.scopeConfirmation?.state).toBe('REQUIRED');
  const forged = {
    ...f.preview,
    semanticQualification: {
      ...required(f.preview.semanticQualification),
      boundaryChoice: 'CONFIRM' as const,
      scopeConfirmation: { receiptId: 'client-created', state: 'CONFIRMED' as const },
    },
  };
  const issued = issueScopeReceipt(forged, f.physical, { automatic: false, current: () => true });
  expect(issued.proof.scopeConfirmation?.state).toBe('REQUIRED');
  expect(issued.proof.scopeConfirmation?.receiptId).not.toBe('client-created');
  expect(() => {
    issued.authorizeCommit();
  }).toThrow();
  cancelScopeReceipt(forged.candidate);
});

it('the worker confirm endpoint rejects client geometry, result identity and source fields', async () => {
  const { splitConfirmScopeHandler } = await import('./split-handlers');
  const { uncancellable } = await import('@cadfixer/shared');
  const f = fixture();
  const context = {
    cancellation: uncancellable,
    interruptible: false,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => undefined,
  };
  for (const extra of [
    { plane: f.preview.semanticQualification?.plane },
    { candidateId: 'other' },
    { documentId: 'other' },
    { revision: 9 },
    { preparationId: 9 },
    { resultHash: 'invented' },
    { confirmed: true },
  ]) {
    const payload = { receiptId: f.id, ...extra } as unknown as Parameters<
      typeof splitConfirmScopeHandler
    >[0];
    expect(() => splitConfirmScopeHandler(payload, context)).toThrow(
      'Choose the current physical preview',
    );
  }
  cancelScopeReceipt(f.preview.candidate);
});
