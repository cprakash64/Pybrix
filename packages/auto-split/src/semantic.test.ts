import { rasteriseView } from './raster';
import { normalizeGeometry } from './geometry';
import { required } from './required';
import { fixtureDeflate } from './fixtures/deflate';
import { describe, expect, it } from 'vitest';
import {
  encodeBase64,
  validateAnalyzeRequest,
  validateSemanticHierarchy,
  VIEW_NAMES,
  PROTOCOL_VERSIONS,
  type SemanticHierarchy,
} from '@cadfixer/auto-split-contract';
import { prepareSemanticGeometry, decomposeSemantic } from './semantic';
import { annotatedFixture, annotatedPart, semanticFixture } from './fixtures/semantic';
import { box, concatMeshes } from './fixtures/solids';
import { componentPieces } from './extract';
const deflate = fixtureDeflate;
describe('semantic decomposition with independent geometry truth', () => {
  for (const category of ['vehicle', 'chair', 'character', 'mechanical', 'unknown'] as const)
    it(`adapts free labels and source component groups to ${category}`, async () => {
      const fixture = semanticFixture(category),
        prepared = await prepareSemanticGeometry(fixture.mesh, deflate),
        answer = annotatedFixture(prepared, fixture);
      expect(validateSemanticHierarchy(answer).ok).toBe(true);
      const result = decomposeSemantic(prepared, answer);
      expect(result.objectLabel).toBe(fixture.label);
      for (const group of fixture.groups) {
        const candidate = required(
          result.suggestions.find((s) => s.id === group.id),
          'result.suggestions.find((s) => s.id === group.id)',
        );
        expect(
          candidate.quality,
          `${category}: ${JSON.stringify(result.evidence.find((e) => e.id === group.id))}`,
        ).toBe('READY');
        expect(candidate.operation).toBe('COMPONENT');
        expect(candidate.components).toEqual(
          group.sources
            .map((s) =>
              required(prepared.labelling.faceRank[s * 12], 'prepared.labelling.faceRank[s * 12]'),
            )
            .sort((a, b) => a - b),
        );
        const pieces = componentPieces(fixture.mesh, prepared.labelling, candidate.components);
        expect(pieces.selected.indices.length + pieces.rest.indices.length).toBe(
          fixture.mesh.indices.length,
        );
        // Extraction preserves every coordinate exactly; triangle ownership is checked against truth.
        const coordinates = (mesh: typeof fixture.mesh): string[] =>
          Array.from(mesh.indices, (i) =>
            [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]].join(','),
          ).sort();
        expect([...coordinates(pieces.selected), ...coordinates(pieces.rest)].sort()).toEqual(
          coordinates(fixture.mesh),
        );
        if ((group.instances ?? 1) > 1)
          expect(result.suggestions.filter((s) => s.parentId === group.id)).toHaveLength(
            required(group.instances, 'group.instances'),
          );
      }
      expect(decomposeSemantic(prepared, answer).suggestions).toEqual(result.suggestions);
    });
  it('keeps symmetry as measured supporting evidence and never fabricates missing instances', async () => {
    const f = semanticFixture('chair'),
      p = await prepareSemanticGeometry(f.mesh, deflate),
      a = annotatedFixture(p, f);
    const result = decomposeSemantic(p, a),
      instances = result.evidence.find((e) => e.id === 'legs')?.instances;
    expect(instances).toHaveLength(4);
    expect(instances?.every((i) => i.mirroredAxes.length >= 1)).toBe(true);
    const fewer = {
      ...a,
      parts: a.parts.map((part) => (part.id === 'legs' ? { ...part, instances: 6 } : part)),
    };
    expect(
      decomposeSemantic(p, fewer).suggestions.filter((s) => s.parentId === 'legs'),
    ).toHaveLength(0);
  });
  it('bounds twelve images and rejects nested raw geometry', async () => {
    const f = semanticFixture('unknown'),
      p = await prepareSemanticGeometry(f.mesh, deflate);
    const request = {
      requestId: 'semantic-test-001',
      mode: 'semantic',
      protocolVersion: PROTOCOL_VERSIONS.semantic,
      views: VIEW_NAMES.map((view, i) => ({
        view,
        png: encodeBase64(required(p.pngs[i], 'p.pngs[i]')),
      })),
      componentViews: VIEW_NAMES.map((view, i) => ({
        view,
        png: encodeBase64(required(p.componentPngs[i], 'p.componentPngs[i]')),
      })),
      semantic: p.metadata,
      summary: {
        extents: p.geometry.extents,
        shells: p.labelling.count,
        radius: p.geometry.radius,
      },
    };
    const checked = validateAnalyzeRequest(request);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.pngs).toHaveLength(12);
    expect(
      validateAnalyzeRequest({ ...request, semantic: { ...p.metadata, positions: [0, 0, 0] } }),
    ).toMatchObject({ ok: false, code: 'RAW_GEOMETRY_REJECTED' });
    expect(p.cameras.every((c) => c.projection.length === 16)).toBe(true);
  });
  it('refuses overlapping siblings and refuses unsupported fused relief', async () => {
    const f = semanticFixture('unknown'),
      p = await prepareSemanticGeometry(f.mesh, deflate),
      a = annotatedFixture(p, f),
      part = required(a.parts[0], 'a.parts[0]');
    const overlap = decomposeSemantic(p, {
      ...a,
      parts: [part, { ...part, id: 'duplicate', label: 'Duplicated attachment' }],
    });
    expect(overlap.suggestions.every((s) => s.quality === 'UNSAFE' && s.operation === 'NONE')).toBe(
      true,
    );
    const fused = await prepareSemanticGeometry(box([-1, -1, -1], [1, 1, 1]), deflate);
    const door = annotatedPart(fused, 'door', 'Embossed panel', [0]);
    const result = decomposeSemantic(fused, {
      object: { label: 'container', confidence: 0.99 },
      parts: [{ ...door, expectedGeometry: { kind: 'surface_part', likelySeparable: false } }],
    });
    expect(result.suggestions[0]).toMatchObject({
      quality: 'RECOGNIZED_NOT_SEPARABLE',
      operation: 'NONE',
      geometryConfidence: 0,
    });
  });
  it('rejects malformed regions, cycle/depth overflow, and low-confidence execution', async () => {
    const f = semanticFixture('unknown'),
      p = await prepareSemanticGeometry(f.mesh, deflate),
      a = annotatedFixture(p, f),
      part = required(a.parts[0], 'a.parts[0]');
    expect(
      validateSemanticHierarchy({
        ...a,
        parts: [
          {
            ...part,
            views: [
              {
                view: 'front',
                polygons: [
                  [
                    [0, 0],
                    [1, 1],
                    [0, 1],
                    [1, 0],
                  ],
                ],
              },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(validateSemanticHierarchy({ ...a, parts: [{ ...part, parentId: part.id }] }).ok).toBe(
      false,
    );
    expect(
      decomposeSemantic(p, { ...a, parts: [{ ...part, confidence: 0.2 }] }).suggestions[0]?.quality,
    ).toBe('LOW_CONFIDENCE');
    expect(
      decomposeSemantic(p, { ...a, parts: [{ ...part, confidence: 0.2 }] }).suggestions[0]
        ?.geometryConfidence,
    ).toBeGreaterThan(0.8);
    const wrong: SemanticHierarchy = {
      ...a,
      parts: [
        {
          ...part,
          views: part.views.map((v) => ({
            ...v,
            polygons: [
              [
                [0, 0],
                [0.01, 0],
                [0.01, 0.01],
                [0, 0.01],
              ],
            ],
          })),
        },
      ],
    };
    expect(decomposeSemantic(p, wrong).suggestions[0]?.operation).toBe('NONE');
  });
  it('uses front-most depth and multiple views rather than overlapping image projections', async () => {
    const mesh = concatMeshes([
        box([-1, -1, -1], [1, 1, 1]),
        box([-0.5, -0.5, 2], [0.5, 0.5, 2.5]),
      ]),
      p = await prepareSemanticGeometry(mesh, deflate);
    const small = required(p.labelling.faceRank[12], 'p.labelling.faceRank[12]'),
      a = annotatedPart(p, 'rear', 'Rear attachment', [small]);
    const result = decomposeSemantic(p, {
      object: { label: 'assembly', confidence: 1 },
      parts: [a],
    });
    expect(result.suggestions[0]?.components).toEqual([small]);
    expect(
      decomposeSemantic(p, {
        object: { label: 'assembly', confidence: 1 },
        parts: [{ ...a, views: a.views.slice(0, 1) }],
      }).suggestions[0]?.operation,
    ).toBe('NONE');
  });
  it('checks cancellation inside preprocessing and correspondence', async () => {
    const f = semanticFixture('unknown');
    let calls = 0;
    await expect(
      prepareSemanticGeometry(f.mesh, deflate, () => {
        if (++calls > 3) throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    const p = await prepareSemanticGeometry(f.mesh, deflate);
    calls = 0;
    expect(() =>
      decomposeSemantic(p, annotatedFixture(p, f), () => {
        if (++calls > 3) throw new Error('cancelled');
      }),
    ).toThrow('cancelled');
  });
  it('validates complementary semantic planes but refuses overlapping sibling cuts', async () => {
    const p = await prepareSemanticGeometry(box([-1, -1, -1], [1, 1, 1]), deflate);
    const base = annotatedPart(p, 'right', 'Right assembly', [0]);
    const right = {
      ...base,
      componentIds: [],
      views: ['front', 'top'].map((view) => ({
        view: view as 'front' | 'top',
        polygons: [
          [
            [0.5, 0],
            [1, 0],
            [1, 1],
            [0.5, 1],
          ] as const,
        ],
      })),
      cut: { normal: [1, 0, 0] as const, origin: [0, 0, 0] as const },
    };
    const left = {
      ...right,
      id: 'left',
      label: 'Left assembly',
      views: right.views.map((v) => ({
        ...v,
        polygons: [
          [
            [0, 0],
            [0.5, 0],
            [0.5, 1],
            [0, 1],
          ] as const,
        ],
      })),
      cut: { normal: [-1, 0, 0] as const, origin: [0, 0, 0] as const },
    };
    const object = { label: 'simple object', confidence: 1 };
    expect(
      decomposeSemantic(p, {
        object,
        parts: [
          {
            ...right,
            views: right.views.map((v) => ({
              ...v,
              polygons: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 1],
                ],
              ],
            })),
          },
        ],
      }).suggestions[0]?.operation,
    ).toBe('NONE');
    expect(
      decomposeSemantic(p, { object, parts: [right, left] }).suggestions.every(
        (s) => s.operation === 'PLANE',
      ),
    ).toBe(true);
    expect(
      decomposeSemantic(p, {
        object,
        parts: [right, { ...right, id: 'duplicate' }],
      }).suggestions.every((s) => s.quality === 'UNSAFE' && s.operation === 'NONE'),
    ).toBe(true);
  });
  it('bounds raster overlap work and preserves rendering when the semantic budget is not used', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]),
      geometry = normalizeGeometry(mesh.positions, mesh.indices);
    expect(() =>
      rasteriseView(geometry, 'front', () => undefined, true, { pixels: 0, limit: 8 }),
    ).toThrow();
    const plain = rasteriseView(geometry, 'front'),
      budget = { pixels: 0, limit: 128000000 },
      bounded = rasteriseView(geometry, 'front', () => undefined, true, budget);
    expect(bounded.face).toEqual(plain.face);
    expect(budget.pixels).toBeGreaterThan(8);
    expect(bounded.depth).toBeDefined();
  });
});
