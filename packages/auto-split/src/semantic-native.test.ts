import { describe, it, expect, vi, type Mock } from 'vitest';
import { qualifySemanticFinalists } from './semantic-native';
import type { SuggestedPlane } from './suggestions';
const planes: readonly SuggestedPlane[] = [0, 1, 2, 3, 4].map((z) => ({
  normal: [0, 0, 1],
  origin: [0, 0, z],
}));
const invalid = new Error('native-invalid');
interface Controls {
  checkpoint: Mock<() => void>;
  charge: Mock<() => void>;
  isNativeInvalid: (e: unknown) => boolean;
  discard: Mock<(value: unknown) => void>;
}
const controls = (): Controls => ({
  checkpoint: vi.fn<() => void>(),
  charge: vi.fn<() => void>(),
  isNativeInvalid: (e: unknown): boolean => e === invalid,
  discard: vi.fn<(value: unknown) => void>(),
});
describe('authoritative native finalist qualification', () => {
  it('stops after the first qualified native candidate', async () => {
    const attempt = vi.fn(() => Promise.resolve({ candidate: 'native-ticket' })),
      c = controls();
    const result = await qualifySemanticFinalists(planes, attempt, c);
    expect(result?.value.candidate).toBe('native-ticket');
    expect(result?.attempts).toBe(1);
    expect(result?.failures).toBe(0);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it('uses the next already-admitted finalist without regenerating evidence', async () => {
    const c = controls(),
      attempt = vi.fn((p: SuggestedPlane) => {
        if (p === planes[0]) return Promise.reject(invalid);
        return Promise.resolve('qualified');
      });
    const before = JSON.stringify(planes),
      result = await qualifySemanticFinalists(planes, attempt, c);
    expect(result?.plane).toBe(planes[1]);
    expect(result?.attempts).toBe(2);
    expect(result?.failures).toBe(1);
    expect(result?.winnerIndex).toBe(1);
    expect(JSON.stringify(planes)).toBe(before);
  });
  it('never publishes after all three fail and never attempts a fourth', async () => {
    const attempt = vi.fn(() => Promise.reject(invalid));
    expect(await qualifySemanticFinalists(planes, attempt, controls())).toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(3);
  });
  it('does not fallback after a resource or unexpected runtime failure', async () => {
    const error = new Error('resource'),
      attempt = vi.fn(() => Promise.reject(error));
    await expect(qualifySemanticFinalists(planes, attempt, controls())).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it('cancellation during qualification discards the candidate and remaining finalists', async () => {
    let cancelled = false;
    const c = controls();
    c.checkpoint = vi.fn(() => {
      if (cancelled) throw new Error('cancelled');
    });
    const attempt = vi.fn(() => {
      cancelled = true;
      return Promise.resolve('unpublished-ticket');
    });
    await expect(qualifySemanticFinalists(planes, attempt, c)).rejects.toThrow('cancelled');
    expect(c.discard).toHaveBeenCalledWith('unpublished-ticket');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it('cancellation after native rejection prevents every remaining attempt', async () => {
    let cancelled = false;
    const c = controls();
    c.checkpoint = vi.fn(() => {
      if (cancelled) throw new Error('cancelled');
    });
    const attempt = vi.fn(() => {
      cancelled = true;
      return Promise.reject(invalid);
    });
    await expect(qualifySemanticFinalists(planes, attempt, c)).rejects.toThrow('cancelled');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it('an exhausted shared operation budget prevents native invocation', async () => {
    const c = controls();
    c.charge = vi.fn(() => {
      throw new Error('budget');
    });
    const attempt = vi.fn(() => Promise.resolve(1));
    await expect(qualifySemanticFinalists(planes, attempt, c)).rejects.toThrow('budget');
    expect(attempt).not.toHaveBeenCalled();
  });
});
