import { describe, expect, it } from 'vitest';
import { prepareSemanticGeometry, decomposeSemantic } from './semantic';
import {
  synthesizeSemanticPlane,
  planeOwnershipTelemetry,
  LOCAL_PLANE_LIMITS,
} from './semantic-local-plane';
import { voxelUnion, annotatedPart, box, concatMeshes } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import type { PlaneSynthesisTrace } from './semantic-synthesis-trace';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { SemanticPart, SemanticHierarchy } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import { CancellationSource } from '@cadfixer/shared';

async function terminal(axis: 0 | 2): Promise<{
  mesh: CanonicalMesh;
  p: PreparedSemanticGeometry;
  part: SemanticPart;
  answer: SemanticHierarchy;
}> {
  const mesh = voxelUnion([
    { lo: [-9, -1, -1], hi: [2, 1, 1] },
    { lo: [2, -3, -2], hi: [6, 3, 2] },
  ]);
  if (axis === 2)
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = mesh.positions.slice(i, i + 3);
      mesh.positions.set([y ?? 0, z ?? 0, x ?? 0], i);
    }
  const p = await prepareSemanticGeometry(mesh, fixtureDeflate);
  const faceRank = Int32Array.from({ length: mesh.indices.length / 3 }, (_, f) =>
    [0, 1, 2].reduce(
      (n, k) => n + (mesh.positions[(mesh.indices[f * 3 + k] ?? 0) * 3 + axis] ?? 0) / 3,
      0,
    ) >= 2
      ? 0
      : 1,
  );
  const mock = { ...p, labelling: { ...p.labelling, count: 2, faceRank } };
  const part = {
    ...annotatedPart(mock, 'a', 'Unfamiliar region', [0]),
    componentIds: [],
    expectedGeometry: { kind: 'solid_part' as const, likelySeparable: false },
  };
  return {
    mesh,
    p,
    part,
    answer: { object: { label: 'Unfamiliar structure', confidence: 0.99 }, parts: [part] },
  };
}

describe('bounded semantic candidate discovery', () => {
  for (const axis of [0, 2] as const)
    it(`opposed end-on views cannot suppress localized synthesis on axis ${String(axis)}`, async () => {
      const { p, answer, part } = await terminal(axis);
      const result = decomposeSemantic(p, answer),
        e = result.evidence.find((e) => e.id === part.id);
      expect(result.suggestions.find((s) => s.id === part.id)?.operation).toBe('NONE');
      expect(e?.synthesis?.phase).toBe('NO_CONFIRMED_FINALIST');
      expect(e?.synthesis?.peerless?.finalists).toContainEqual(
        expect.objectContaining({
          structuralReason: 'STABLE_SECTION_STEP',
          structurallyAdmitted: true,
          confirmed: true,
          scopeState: 'TARGET_SCOPE_SUPPORTED',
        }),
      );
      expect(e?.synthesis?.interfaceOwnership).toMatchObject({
        evidenceLevel: 'LOCAL_TARGET_ASSOCIATION',
        ownership: 'AMBIGUOUS',
        wholeCertificate: { complete: false },
      });
      expect(e?.synthesis?.ownershipCardinality?.ownershipCompleteness).toMatchObject({
        state: 'INCOMPLETE_UNRESOLVED',
        semanticComplete: false,
        unrepresentedUnresolved: 1,
      });
      expect(e?.synthesis?.exactTarget).toBe(false);
      expect(e?.synthesis?.normalCandidates.length).toBeLessThanOrEqual(LOCAL_PLANE_LIMITS.normals);
      expect(e?.synthesis?.orientedOffsets).toBeLessThanOrEqual(
        2 * LOCAL_PLANE_LIMITS.normals * LOCAL_PLANE_LIMITS.offsets,
      );
      expect(e?.synthesis?.orientedOffsets).toBe(
        (e?.synthesis?.scoredCandidates ?? 0) +
          Object.values(e?.synthesis?.scoreRefusals ?? {}).reduce((a, b) => a + b, 0),
      );
      expect(e?.synthesis?.normalCandidates.some((candidate) => candidate.sources.length > 0)).toBe(
        true,
      );
      expect(e?.synthesis?.peerless?.frontier[0]?.offsetSource).toBeDefined();
      expect(e?.synthesis?.confirmed).toBeLessThanOrEqual(3);
      expect(e?.synthesis?.seamDerivedCandidates).toBe(0);
    });

  it('explains input refusal without creating a candidate', async () => {
    const { p, answer, part } = await terminal(0);
    const result = decomposeSemantic(p, {
      ...answer,
      parts: [{ ...part, views: part.views.slice(0, 1) }],
    });
    expect(result.evidence[0]?.synthesis?.inputRefusal).toBe('INSUFFICIENT_VIEWS');
    expect(result.evidence[0]?.synthesis?.normalAttempts).toBe(0);
    expect(result.suggestions[0]?.operation).toBe('NONE');
  });

  it('keeps exact independent component extraction separate', async () => {
    const mesh = concatMeshes([box([-4, -2, -2], [-1, 2, 2]), box([2, -1, -1], [4, 1, 1])]);
    const p = await prepareSemanticGeometry(mesh, fixtureDeflate);
    const part = annotatedPart(p, 'independent', 'Unfamiliar component', [
      p.labelling.faceRank[0] ?? 0,
    ]);
    const result = decomposeSemantic(p, {
      object: { label: 'Unfamiliar assembly', confidence: 0.99 },
      parts: [part],
    });
    expect(result.suggestions[0]?.operation).toBe('COMPONENT');
    expect(result.suggestions[0]?.quality).toBe('READY');
    expect(result.evidence[0]?.synthesis?.normalAttempts).toBe(0);
  });

  it('cancels the new sample-diagnostic phase without publishing or modifying source, then recovers', async () => {
    const { mesh, p, answer, part } = await terminal(0),
      before = mesh.positions.slice();
    const synthesis = new Map<string, PlaneSynthesisTrace>(),
      controller = new CancellationSource();
    let published = false;
    expect(() => {
      const result = synthesizeSemanticPlane(
        p,
        answer,
        part,
        () => {
          if (synthesis.get(part.id)?.views.length) controller.cancel();
          if (controller.token.isCancelled) throw Error('cancelled candidate diagnostics');
        },
        { telemetry: planeOwnershipTelemetry(), charge: () => undefined, synthesis },
      );
      published = Boolean(result);
    }).toThrow('cancelled candidate diagnostics');
    expect(published).toBe(false);
    expect(mesh.positions).toEqual(before);
    const recovery = new Map<string, PlaneSynthesisTrace>();
    expect(
      synthesizeSemanticPlane(p, answer, part, () => undefined, {
        telemetry: planeOwnershipTelemetry(),
        charge: () => undefined,
        synthesis: recovery,
      }),
    ).toBeUndefined();
    expect(recovery.get(part.id)?.interfaceOwnership).toMatchObject({
      evidenceLevel: 'LOCAL_TARGET_ASSOCIATION',
      ownership: 'AMBIGUOUS',
      wholeCertificate: { complete: false },
    });
    expect(recovery.get(part.id)?.ownershipCardinality?.ownershipCompleteness).toMatchObject({
      state: 'INCOMPLETE_UNRESOLVED',
      semanticComplete: false,
      unrepresentedUnresolved: 1,
    });
    expect(
      recovery
        .get(part.id)
        ?.peerless?.finalists?.some(
          (finalist) => finalist.confirmed && finalist.structurallyAdmitted,
        ),
    ).toBe(true);
    expect(mesh.positions).toEqual(before);
  });
});
