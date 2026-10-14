import { describe, it, expect, beforeAll } from 'vitest';
import { VIEW_NAMES, type SemanticPart } from '@cadfixer/auto-split-contract';
import {
  prepareSemanticGeometry,
  decomposeSemantic,
  type PreparedSemanticGeometry,
} from './semantic';
import { annotatedPart } from './fixtures/semantic';
import { qualityDevelopmentFixture } from './fixtures/semantic-quality';
import { fixtureDeflate } from './fixtures/deflate';
import { familySignatures, completeSemanticFamily, type FamilySignatures } from './semantic-family';
import { NO_CHECKPOINT } from './checkpoint';
import { required } from './required';
import { componentPieces } from './extract';
let prepared: PreparedSemanticGeometry,
  signatures: FamilySignatures,
  part: SemanticPart,
  ranks: number[];
function observation(
  p: PreparedSemanticGeometry,
  rs: readonly number[],
  count: number,
): SemanticPart {
  const annotations = rs.map((r) => annotatedPart(p, 'anchor', 'Support', [r]));
  return {
    ...required(annotations[0], 'annotation'),
    id: 'family',
    label: 'Supports',
    instances: count,
    componentIds: [],
    expectedGeometry: { kind: 'repeated_part', likelySeparable: false },
    views: VIEW_NAMES.flatMap((view) => {
      const polygons = annotations.flatMap((a) =>
        a.views.filter((v) => v.view === view).flatMap((v) => v.polygons),
      );
      return polygons.length ? [{ view, polygons }] : [];
    }),
  };
}
beforeAll(async () => {
  const f = qualityDevelopmentFixture('legs');
  prepared = await prepareSemanticGeometry(f.mesh, fixtureDeflate);
  ranks = f.familyFirstFaces.map((f) => prepared.labelling.faceRank[f] ?? -1);
  signatures = familySignatures(prepared, NO_CHECKPOINT);
  const observations = ranks.map((r) => annotatedPart(prepared, 'anchor', 'Support', [r]));
  part = {
    ...observation(prepared, ranks.slice(0, 2), 4),
    views: (['rear', 'right', 'front'] as const).map((view) => ({
      view,
      polygons: observations
        .slice(view === 'front' ? 2 : 0, view === 'front' ? 4 : 2)
        .flatMap((p) => p.views.filter((v) => v.view === view).flatMap((v) => v.polygons)),
    })),
  };
});
const scores = (
  rs: readonly number[],
): { rank: number; strongViews: number; viewCoverage: number[] }[] =>
  rs.map((rank, i) => ({
    rank,
    strongViews: i < 2 ? 2 : 1,
    viewCoverage: i < 2 ? [0, 1, -1, 1, -1, -1] : [1, 0, -1, 0, -1, -1],
  }));
const polygons = (rs: readonly number[]): { view: number; ranks: number[]; purity: number }[] =>
  rs.flatMap((rank, i) =>
    (i < 2 ? [1, 3] : [0]).map((view) => ({ view, ranks: [rank], purity: 1 })),
  );
describe('conservative component admission and omitted-instance corroboration', () => {
  it('low object confidence permits a high-confidence exact leaf without changing the part floor', () => {
    const leaf = {
      ...annotatedPart(prepared, 'leaf', 'Independent support', [ranks[0] ?? -1]),
      componentIds: [],
    };
    const answer = { object: { label: 'unknown assembly', confidence: 0.2 }, parts: [leaf] };
    const result = decomposeSemantic(prepared, answer);
    expect(result.suggestions[0]?.operation).toBe('COMPONENT');
    expect(result.evidence[0]?.confidence?.objectConfidence).toBe(0.2);
    expect(
      decomposeSemantic(prepared, { ...answer, parts: [{ ...leaf, confidence: 0.71 }] })
        .suggestions[0]?.operation,
    ).toBe('NONE');
  });
  it('does not admit an uncertain compound parent by borrowing its leaf evidence', () => {
    const leaf = {
      ...annotatedPart(prepared, 'parent', 'Assembly', [ranks[0] ?? -1]),
      componentIds: [],
    };
    const child = { ...leaf, id: 'child', parentId: 'parent', views: leaf.views.slice(0, 1) };
    expect(
      decomposeSemantic(prepared, {
        object: { label: 'unknown', confidence: 0.3 },
        parts: [leaf, child],
      }).suggestions.find((s) => s.id === 'parent')?.operation,
    ).toBe('NONE');
  });
  it('recovers the exact four-member family from two semantic anchors without provider IDs', () => {
    const result = decomposeSemantic(prepared, {
      object: { label: 'furniture', confidence: 0.95 },
      parts: [part],
    });
    const family = result.suggestions.find((s) => s.id === 'family');
    expect(family?.components.slice().sort()).toEqual(ranks.slice().sort());
    expect(family?.quality).toBe('READY');
    const completion = result.evidence[0]?.familyCompletion;
    expect(completion?.anchors).toHaveLength(2);
    expect(completion?.propagated).toHaveLength(2);
    expect(result.suggestions.filter((s) => s.parentId === 'family')).toHaveLength(4);
    expect(
      result.evidence[0]?.viewEvidence?.some((e) =>
        e.views.some((v) => v.state === 'FAMILY_INSTANCE_OMITTED'),
      ),
    ).toBe(true);
    const f = qualityDevelopmentFixture('legs'),
      split = componentPieces(f.mesh, prepared.labelling, family?.components ?? []);
    expect(split.selected.indices.length + split.rest.indices.length).toBe(f.mesh.indices.length);
    expect(new Set(family?.components).size).toBe(4);
  });
  it('records omitted views independently of observable contradictory annotations', () => {
    const leaf = annotatedPart(prepared, 'leaf', 'Support', [ranks[0] ?? -1]);
    const result = decomposeSemantic(prepared, {
      object: { label: 'structure', confidence: 1 },
      parts: [{ ...leaf, views: leaf.views.slice(0, 2) }],
    });
    expect(
      result.evidence[0]?.viewEvidence?.some((e) => e.views.some((v) => v.state === 'OMITTED')),
    ).toBe(true);
    const bad = {
      ...part,
      views: [
        ...part.views,
        {
          view: 'bottom' as const,
          polygons:
            annotatedPart(prepared, 'body', 'Body', [prepared.labelling.faceRank[0] ?? 0]).views[0]
              ?.polygons ??
            part.views[0]?.polygons ??
            [],
        },
      ],
    };
    // A supplied polygon must corroborate a family member; it is never silently omitted.
    const completion = completeSemanticFamily(
      prepared,
      bad,
      [],
      scores(ranks),
      [...polygons(ranks), { view: 5, ranks: [prepared.labelling.faceRank[0] ?? 0], purity: 1 }],
      () => signatures,
      NO_CHECKPOINT,
    );
    expect(completion?.ranks).toEqual([]);
    expect(completion?.reason).toContain('Contradictory');
  });
  it('a real contradictory view cannot be converted to an omitted-instance view', () => {
    const body = annotatedPart(prepared, 'body', 'Body', [prepared.labelling.faceRank[0] ?? 0]);
    const wrong = required(
      body.views.find((v) => part.views.some((p) => p.view === v.view)),
      'contradictory view',
    );
    const contradictory = {
      ...part,
      views: part.views.map((v) => (v.view === wrong.view ? wrong : v)),
    };
    const result = decomposeSemantic(prepared, {
      object: { label: 'furniture', confidence: 0.95 },
      parts: [contradictory],
    });
    expect(result.suggestions.find((s) => s.id === 'family')?.operation).toBe('NONE');
    expect(
      result.evidence[0]?.viewEvidence?.some((e) =>
        e.views.some((v) => v.state === 'CONTRADICTORY'),
      ),
    ).toBe(true);
  });
  for (const kind of ['legs', 'wheels', 'handles', 'retriangulated'] as const)
    it(`bounded development ${kind} completes equivalent isolated members`, async () => {
      const f = qualityDevelopmentFixture(kind),
        p = await prepareSemanticGeometry(f.mesh, fixtureDeflate),
        rs = f.familyFirstFaces.map((f) => p.labelling.faceRank[f] ?? -1),
        s = familySignatures(p, NO_CHECKPOINT);
      const completion = completeSemanticFamily(
        p,
        { ...part, instances: f.count },
        [],
        scores(rs),
        polygons(rs),
        () => s,
        NO_CHECKPOINT,
      );
      expect(completion?.ranks.slice().sort(), JSON.stringify(completion)).toEqual(
        rs.slice().sort(),
      );
      expect(completion?.comparisons).toBeLessThanOrEqual(64 + 66);
      expect(s.bytes).toBeLessThanOrEqual(16968);
    });
  for (const kind of [
    'near-match',
    'asymmetric',
    'missing',
    'different-size',
    'overlap',
    'decorative',
  ] as const)
    it(`negative ${kind} cannot fabricate a completed family`, async () => {
      const f = qualityDevelopmentFixture(kind),
        p = await prepareSemanticGeometry(f.mesh, fixtureDeflate),
        rs = f.familyFirstFaces.map((f) => p.labelling.faceRank[f] ?? -1),
        s = familySignatures(p, NO_CHECKPOINT);
      const completion = completeSemanticFamily(
        p,
        part,
        [],
        scores(rs),
        polygons(rs),
        () => s,
        NO_CHECKPOINT,
      );
      expect(completion?.ranks ?? []).toEqual([]);
    });
  it('an unannotated near-identical component cannot be invented as a sibling', () => {
    const incomplete = scores(ranks).map((s, i) =>
      i === 3 ? { ...s, strongViews: 0, viewCoverage: [0, 0, -1, -1, -1, -1] } : s,
    );
    const completion = completeSemanticFamily(
      prepared,
      part,
      [],
      incomplete,
      polygons(ranks).filter((p) => p.ranks[0] !== ranks[3]),
      () => signatures,
      NO_CHECKPOINT,
    );
    expect(completion?.ranks).toEqual([]);
  });
  it('one anchor and absence of a repeated family cannot propagate', () => {
    const one = scores(ranks).map((s, i) => ({ ...s, strongViews: i === 0 ? 2 : 0 }));
    expect(
      completeSemanticFamily(
        prepared,
        part,
        [],
        one,
        polygons(ranks),
        () => signatures,
        NO_CHECKPOINT,
      ),
    ).toBeUndefined();
    expect(
      completeSemanticFamily(
        prepared,
        { ...part, instances: 1 },
        [],
        scores(ranks),
        polygons(ranks),
        () => signatures,
        NO_CHECKPOINT,
      ),
    ).toBeUndefined();
  });
  it('cancellation interrupts both signature construction and propagation without source mutation', () => {
    const before = prepared.geometry.positions.slice();
    expect(() =>
      familySignatures(prepared, () => {
        throw Error('cancelled');
      }),
    ).toThrow('cancelled');
    let polls = 0;
    expect(() =>
      completeSemanticFamily(
        prepared,
        part,
        [],
        scores(ranks),
        polygons(ranks),
        () => signatures,
        () => {
          if (++polls === 2) throw Error('cancelled');
        },
      ),
    ).toThrow('cancelled');
    expect(prepared.geometry.positions).toEqual(before);
  });
});
