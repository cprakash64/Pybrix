import { it, expect } from 'vitest';
import {
  semanticExecutionEligibility,
  guardSemanticExecution,
} from './semantic-execution-eligibility';
import type { Suggestion } from './suggestions';
it('separates strict unknown from fused known solids and explicitly separable unknown', () => {
  expect(
    semanticExecutionEligibility({ expectedGeometry: { kind: 'unknown', likelySeparable: false } })
      .state,
  ).toBe('NON_EXECUTABLE');
  expect(
    semanticExecutionEligibility({ expectedGeometry: { kind: 'unknown', likelySeparable: true } })
      .state,
  ).toBe('EXECUTABLE');
  expect(
    semanticExecutionEligibility({
      expectedGeometry: { kind: 'solid_part', likelySeparable: false },
    }).state,
  ).toBe('EXECUTABLE');
  expect(semanticExecutionEligibility(undefined).state).toBe('UNRESOLVED');
});
it('original semantic non-execution survives a geometrically ready operation', () => {
  const ready: Suggestion = {
    id: 'a',
    family: 'semantic',
    label: 'Target',
    operation: 'PLANE',
    status: 'SUGGESTED',
    reason: 'CLEAR',
    quality: 'READY',
    components: [],
    plane: { normal: [1, 0, 0], origin: [0, 0, 0] },
    semanticFinalists: [{ normal: [1, 0, 0], origin: [0, 0, 0] }],
  };
  const eligibility = semanticExecutionEligibility({
    expectedGeometry: { kind: 'unknown', likelySeparable: false },
  });
  const blocked = guardSemanticExecution(ready, eligibility);
  expect(blocked.operation).toBe('NONE');
  expect(blocked.plane).toBeNull();
  expect(blocked.quality).toBe('RECOGNIZED_NOT_SEPARABLE');
  expect(blocked.semanticFinalists).toBeUndefined();
  expect(blocked.semanticExecutionEligibility).toEqual(eligibility);
});
