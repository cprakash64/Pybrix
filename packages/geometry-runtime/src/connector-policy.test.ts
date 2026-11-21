import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_SUPPORT_POLICY,
  SUPPORT_POLICY_ID,
  connectorSupportMargin,
} from './connector-policy';

describe('support-v1 policy authority', () => {
  it('names the policy and states its two numbers, frozen', () => {
    expect(SUPPORT_POLICY_ID).toBe('support-v1');
    expect(CONNECTOR_SUPPORT_POLICY.id).toBe('support-v1');
    expect(CONNECTOR_SUPPORT_POLICY.edgeMarginPinRadiusRatio).toBe(0.35);
    expect(CONNECTOR_SUPPORT_POLICY.edgeMarginToleranceMultiple).toBe(8);
    expect(Object.isFrozen(CONNECTOR_SUPPORT_POLICY)).toBe(true);
  });

  it('is max(8 · tolerance, 0.35 · pinRadius), and each term governs on its own side', () => {
    // pin radius 2: 0.35 · 2 = 0.7 governs when the tolerance is small
    expect(connectorSupportMargin(2, 1e-4)).toBe(0.35 * 2);
    // a tolerance of 0.5 puts the floor (4) above 0.7
    expect(connectorSupportMargin(2, 0.5)).toBe(8 * 0.5);
    // the two meet at tolerance = 0.35 · r / 8
    const r = 3,
      tie = (0.35 * r) / 8;
    expect(connectorSupportMargin(r, tie)).toBe(Math.max(8 * tie, 0.35 * r));
  });

  it('is exactly the expression the manual placement rule used before it moved', () => {
    for (const [radius, tolerance] of [
      [2, 5.73e-5],
      [0.5, 4.1e-5],
      [0.118, 3.3e-3],
      [20, 1e-9],
      [1, 0],
    ] as const)
      expect(connectorSupportMargin(radius, tolerance)).toBe(
        Math.max(tolerance * 8, radius * 0.35),
      );
  });

  it('is dimensionless: scaling the pin and the tolerance together scales the margin by the same factor', () => {
    for (const factor of [0.5, 2, 4]) {
      const base = connectorSupportMargin(2, 6e-5);
      expect(connectorSupportMargin(2 * factor, 6e-5 * factor)).toBeCloseTo(base * factor, 12);
    }
  });
});
