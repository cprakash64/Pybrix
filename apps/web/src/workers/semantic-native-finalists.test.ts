import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { describe, it, expect } from 'vitest';
import { box } from '@cadfixer/auto-split/fixtures';
import {
  SuggestionOperation,
  SuggestionStatus,
  SuggestionReason,
  type Suggestion,
} from '@cadfixer/auto-split';
import type { DocumentHandle, SplitCreatePayload } from '@cadfixer/geometry-runtime';
import {
  registerSemanticNativeFinalists,
  semanticNativePlan,
  clearSemanticNativeFinalists,
  recordSemanticNativeWinner,
} from './semantic-native-finalists';
const source = { documentId: 'finalist-test', revision: 0 } as DocumentHandle;
const planes = [0, 1, 2].map((z) => ({ origin: [0, 0, z] as const, normal: [0, 0, 1] as const }));
const suggestions: Suggestion[] = ['a', 'b', 'c', 'd'].map((id) => ({
  id,
  label: id,
  family: 'semantic',
  operation: SuggestionOperation.Plane,
  status: SuggestionStatus.Suggested,
  reason: SuggestionReason.Clear,
  quality: 'SUGGESTED',
  plane: required(planes[0]),
  components: [],
  semanticFinalists: planes,
}));
const payload = (id = 'a'): SplitCreatePayload => ({
  source,
  partId: 'part',
  request: { plane: required(planes[0]), connector: { kind: 'none' } },
  semanticQualification: { preparationId: 7, candidateId: id },
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
function planFor(
  payload: SplitCreatePayload,
  mesh: CanonicalMesh,
): NonNullable<ReturnType<typeof semanticNativePlan>> {
  return required(semanticNativePlan(payload, mesh));
}
describe('revision-scoped scalar native finalist plan', () => {
  it('accepts the current source and rejects stale revisions and preparation identities', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    expect(planFor(payload(), mesh).planes).toHaveLength(3);
    expect(() => planFor({ ...payload(), source: { ...source, revision: 1 } }, mesh)).toThrow();
    expect(() =>
      planFor(
        { ...payload(), semanticQualification: { preparationId: 6, candidateId: 'a' } },
        mesh,
      ),
    ).toThrow();
  });
  it('never treats a different mesh or arbitrary edited plane as the same candidate', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    expect(() => planFor(payload(), { ...mesh })).toThrow();
    expect(() =>
      planFor(
        {
          ...payload(),
          request: { plane: { normal: [1, 0, 0], origin: [0, 0, 0] }, connector: { kind: 'none' } },
        },
        mesh,
      ),
    ).toThrow();
  });
  it('compares plane equations, including a tangentially shifted controls origin', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    expect(
      planFor(
        {
          ...payload(),
          request: {
            plane: { normal: [0, 0, 1], origin: [10, 20, 0] },
            connector: { kind: 'none' },
          },
        },
        mesh,
      ).planes[0],
    ).toEqual(planes[0]);
  });
  it('caps native work to six attempts and three distinct parts per analysis', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    for (const id of ['a', 'b', 'c']) {
      const plan = planFor(payload(id), mesh);
      plan.charge();
      plan.charge();
    }
    expect(() => planFor(payload('d'), mesh)).toThrow();
    expect(() => {
      planFor(payload('a'), mesh).charge();
    }).toThrow();
  });
  it('near-2M models get one candidate and one native attempt, never three truck cuts', () => {
    const mesh = { ...box([-1, -1, -1], [1, 1, 1]), indices: new Uint32Array(3 * 1_999_999) };
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    const plan = planFor(payload(), mesh);
    expect(plan.planes).toHaveLength(1);
    plan.charge();
    expect(() => {
      plan.charge();
    }).toThrow();
    expect(() => planFor(payload('b'), mesh)).toThrow();
  });
  it('an explicit later connector Preview rechecks only the qualified winner without fallback search', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    const plan = planFor(payload(), mesh);
    for (let i = 0; i < 6; i++) plan.charge();
    expect(recordSemanticNativeWinner(payload(), required(planes[1]))).toBe(true);
    const refresh = planFor(
      { ...payload(), request: { plane: required(planes[1]), connector: { kind: 'none' } } },
      mesh,
    );
    expect(refresh.planes).toEqual([planes[1]]);
    expect(() => {
      refresh.charge();
    }).not.toThrow();
  });
  it('retiring an analysis invalidates all of its candidate identities', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    clearSemanticNativeFinalists();
    expect(() => planFor(payload(), mesh)).toThrow();
  });
});
