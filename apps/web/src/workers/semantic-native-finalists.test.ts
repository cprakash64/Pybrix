import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { describe, it, expect } from 'vitest';
import { isAppError } from '@cadfixer/shared';
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
  recordSemanticNativeRefusal,
  recordBoundaryPreview,
  requireConfirmedBoundary,
} from './semantic-native-finalists';
import type { SplitCandidateHandle } from '@cadfixer/geometry-runtime';
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
  /*
   * v0.7.1: the allowance is PER SELECTION. It used to be counted across the whole analysis, so on a
   * large model the first part previewed spent everything and every later part was refused with the
   * words "No safe split found" without ever being examined. These tests hold the new contract.
   */
  const codeOf = (action: () => unknown): { code: unknown; message: string } => {
    try {
      action();
    } catch (error) {
      if (isAppError(error)) return { code: error.details.code, message: error.message };
      throw error;
    }
    throw new Error('expected the action to throw');
  };
  it('bounds ONE request to six attempts of three finalists, and each part gets its own request', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    // Four different parts in turn: every one is examined, none is refused for the others' sake.
    for (const id of ['a', 'b', 'c', 'd']) {
      const plan = planFor(payload(id), mesh);
      expect(plan.planes).toHaveLength(3);
      for (let i = 0; i < 6; i++) plan.charge();
    }
    // The bound inside one request is unchanged: a seventh attempt is a LIMIT, and says so.
    const plan = planFor(payload('a'), mesh);
    for (let i = 0; i < 6; i++) plan.charge();
    const seventh = codeOf(() => {
      plan.charge();
    });
    expect(seventh.code).toBe('SEMANTIC_NATIVE_BUDGET_EXHAUSTED');
    expect(seventh.message).not.toMatch(/no safe split/i);
  });
  it('near-2M models: one candidate and one native attempt PER SELECTION, never three truck cuts', () => {
    const mesh = { ...box([-1, -1, -1], [1, 1, 1]), indices: new Uint32Array(3 * 1_999_999) };
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    const plan = planFor(payload(), mesh);
    expect(plan.planes).toHaveLength(1);
    plan.charge();
    // Inside the request the bound is exactly as before, and it is a limit, not a finding.
    const second = codeOf(() => {
      plan.charge();
    });
    expect(second.code).toBe('SEMANTIC_NATIVE_BUDGET_EXHAUSTED');
    expect(second.message).not.toMatch(/no safe split/i);
    // A DIFFERENT part is a new selection with its own bounded envelope: examined, not refused.
    const other = planFor(payload('b'), mesh);
    expect(other.planes).toHaveLength(1);
  });
  it('repeated selection accumulates nothing: a hundred requests across four parts stay one candidate each', () => {
    const mesh = { ...box([-1, -1, -1], [1, 1, 1]), indices: new Uint32Array(3 * 1_999_999) };
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    for (let i = 0; i < 100; i++) {
      const plan = planFor(payload(['a', 'b', 'c', 'd'][i % 4]), mesh);
      expect(plan.planes).toHaveLength(1);
      plan.charge();
    }
  });
  it('a part whose every finalist was refused stays a COMPLETED analysis, repeated without work', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    planFor(payload('a'), mesh);
    recordSemanticNativeRefusal(payload('a'));
    const again = codeOf(() => planFor(payload('a'), mesh));
    expect(again.code).toBe('SEMANTIC_NATIVE_FINALISTS_REFUSED');
    expect(again.message).toBe('No safe split found.');
    // Another part is unaffected.
    expect(planFor(payload('b'), mesh).planes).toHaveLength(3);
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
  it('one shared fallback winner binds both identities to opposite sides without a second search', () => {
    const mesh = box([-1, -1, -1], [1, 1, 3]);
    const opposite = (p: (typeof planes)[number]): NonNullable<Suggestion['plane']> => ({
      origin: p.origin,
      normal: [-p.normal[0], -p.normal[1], -p.normal[2]] as const,
    });
    const pair = suggestions.slice(0, 2).map((s, i) => ({
      ...s,
      sharedBoundary: {
        key: 'pair',
        primaryId: 'a',
        complementId: 'b',
        side: i === 0 ? ('PRIMARY' as const) : ('COMPLEMENT' as const),
      },
      plane: i === 0 ? required(planes[0]) : opposite(required(planes[0])),
      semanticFinalists: i === 0 ? planes : planes.map(opposite),
    }));
    registerSemanticNativeFinalists(source, 'part', mesh, 7, pair);
    const first = planFor(payload(), mesh);
    first.charge();
    first.charge();
    expect(recordSemanticNativeWinner(payload(), required(planes[1]))).toBe(true);
    const bPayload = {
      ...payload('b'),
      request: { plane: opposite(required(planes[0])), connector: { kind: 'none' as const } },
    };
    expect(planFor(bPayload, mesh).planes).toEqual([opposite(required(planes[1]))]);
    expect(planFor(payload(), mesh).planes).toEqual([planes[1]]);
    expect(() => {
      planFor(bPayload, mesh).charge();
    }).not.toThrow();
  });
  it('retiring an analysis invalidates all of its candidate identities', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, suggestions);
    clearSemanticNativeFinalists();
    expect(() => planFor(payload(), mesh)).toThrow();
  });
});

describe('explicit boundary confirmation plan', () => {
  it('keeps an unconfirmed preview uncommittable after the semantic analysis is cleared', () => {
    const candidate = {
      documentId: source.documentId,
      candidateId: 'boundary-preview',
    } as SplitCandidateHandle;
    recordBoundaryPreview(candidate, true);
    expect(() => {
      requireConfirmedBoundary(candidate);
    }).toThrow('Choose a boundary');
    clearSemanticNativeFinalists();
    expect(() => {
      requireConfirmedBoundary(candidate);
    }).toThrow('Choose a boundary');
    recordBoundaryPreview(candidate, false);
    expect(() => {
      requireConfirmedBoundary(candidate);
    }).not.toThrow();
  });
  function setup(): CanonicalMesh {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    const base = required(suggestions[0]);
    registerSemanticNativeFinalists(source, 'part', mesh, 7, [
      {
        ...base,
        operation: SuggestionOperation.None,
        plane: null,
        quality: 'NEEDS_BOUNDARY_CONFIRMATION',
        status: SuggestionStatus.NeedsBoundaryConfirmation,
        boundaryConfirmation: {
          status: 'NEEDS_BOUNDARY_CONFIRMATION',
          targetId: 'a',
          route: 'STRUCTURAL_SEAM',
          ambiguityReason: 'UNRESOLVED_INTERFACE_OWNERSHIP',
          alternatives: [0, 1].map((index) => ({
            id: `option-${String(index)}`,
            plane: required(planes[index]),
            selectedSide: 'POSITIVE',
            nativeProof: { valid: true, sourcePreserved: true, partitionCount: 2 },
            previewMetadata: { label: index === 0 ? 'Option A' : 'Option B' },
          })) as unknown as NonNullable<Suggestion['boundaryConfirmation']>['alternatives'],
        },
      },
    ]);
    return mesh;
  }
  it('refuses an unspecified choice and never substitutes another option', () => {
    const mesh = setup();
    expect(() => semanticNativePlan(payload(), mesh)).toThrow('Choose a boundary');
    const request = {
      ...payload(),
      semanticQualification: {
        preparationId: 7,
        candidateId: 'a',
        boundaryAlternativeId: 'option-1',
        boundaryChoice: 'CONFIRM' as const,
      },
      request: { plane: required(planes[1]), connector: { kind: 'none' as const } },
    };
    expect(() => planFor(request, mesh)).toThrow('Choose a boundary');
    expect(
      planFor(
        {
          ...request,
          semanticQualification: {
            ...request.semanticQualification,
            boundaryChoice: 'PREVIEW' as const,
          },
        },
        mesh,
      ).planes,
    ).toEqual([planes[1]]);
    expect(() => planFor({ ...request, request: payload().request }, mesh)).toThrow();
    expect(recordSemanticNativeWinner(request, required(planes[1]))).toBe(true);
  });
  it('allows connector-free option preview and rejects connectors before an explicit decision', () => {
    const mesh = setup();
    const preview = {
      ...payload(),
      semanticQualification: {
        preparationId: 7,
        candidateId: 'a',
        boundaryAlternativeId: 'option-0',
        boundaryChoice: 'PREVIEW' as const,
      },
    };
    expect(planFor(preview, mesh).planes).toEqual([planes[0]]);
    const withConnector = {
      ...preview,
      request: { ...preview.request, connector: { kind: 'automatic' as const, unit: 'mm' } },
    };
    expect(() => planFor(withConnector, mesh)).toThrow();
  });
});

it('scope authority never treats confidence, complementary peers, or a different refined plane as IDENTIFIED', async () => {
  const { semanticScopeBinding } = await import('./semantic-native-finalists');
  const mesh = box([-1, -1, -1], [1, 1, 1]);
  const base = required(suggestions[0]);
  const plane = required(planes[0]);
  registerSemanticNativeFinalists(source, 'part', mesh, 7, [
    { ...base, semanticConfidence: 1, geometryConfidence: 1 },
  ]);
  expect(semanticScopeBinding(payload(), mesh, plane).automatic).toBe(false);
  registerSemanticNativeFinalists(source, 'part', mesh, 7, [
    { ...base, semanticScopeAuthority: { state: 'STRUCTURAL_IDENTIFIED', plane } },
  ]);
  expect(semanticScopeBinding(payload(), mesh, plane).automatic).toBe(true);
  expect(
    semanticScopeBinding(payload(), mesh, {
      ...plane,
      origin: [plane.origin[0], plane.origin[1], plane.origin[2] + 1e-10],
    }).automatic,
  ).toBe(false);
});
