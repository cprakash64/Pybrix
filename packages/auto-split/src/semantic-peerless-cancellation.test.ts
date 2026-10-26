import { required } from './required';
import { beforeAll, it, expect } from 'vitest';
import {
  prepareSemanticGeometry,
  decomposeSemantic,
  type PreparedSemanticGeometry,
} from './semantic';
import { synthesizeSemanticPlane, planeOwnershipTelemetry } from './semantic-local-plane';
import { voxelUnion, annotatedPart } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import { CancellationSource, throwIfCancelled, isAppError, AppErrorCode } from '@cadfixer/shared';
import type { PlaneSynthesisTrace } from './semantic-synthesis-trace';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { SemanticHierarchy } from '@cadfixer/auto-split-contract';
let mesh: CanonicalMesh, p: PreparedSemanticGeometry, answer: SemanticHierarchy;
beforeAll(async () => {
  mesh = voxelUnion([
    { lo: [-13, -2, -2], hi: [3, 2, 2] },
    { lo: [3, -5, -4], hi: [12, 5, 4] },
  ]);
  p = await prepareSemanticGeometry(mesh, fixtureDeflate);
  const faceRank = Int32Array.from({ length: mesh.indices.length / 3 }, (_, f) =>
    [0, 1, 2].reduce(
      (s, k) =>
        s +
        (mesh.positions[required(mesh.indices[f * 3 + k], 'bounded peerless evidence') * 3] ?? 0) /
          3,
      0,
    ) >= 3
      ? 0
      : 1,
  );
  const part = {
    ...annotatedPart(
      { ...p, labelling: { ...p.labelling, count: 2, faceRank } },
      'a',
      'Distinct attachment',
      [0],
    ),
    componentIds: [],
    cut: null,
    expectedGeometry: { kind: 'solid_part' as const, likelySeparable: false },
  };
  answer = { object: { label: 'Unfamiliar assembly', confidence: 0.99 }, parts: [part] };
});
for (const phase of [
  'COLLECT_SCOPE',
  'BUILD_FRONTIER',
  'STRUCTURAL_RANKING',
  'REFINEMENT',
] as const)
  it('cancels ' + phase + ' without publication or source mutation and recovers', () => {
    const positions = mesh.positions.slice(),
      indices = mesh.indices.slice(),
      controller = new CancellationSource(),
      synthesis = new Map<string, PlaneSynthesisTrace>();
    let published = false,
      visited = false,
      caught: unknown;
    try {
      synthesizeSemanticPlane(
        p,
        answer,
        required(answer.parts[0], 'bounded peerless evidence'),
        () => {
          if (synthesis.get('a')?.peerless?.phase === phase) {
            visited = true;
            controller.cancel();
          }
          throwIfCancelled(controller.token);
        },
        { telemetry: planeOwnershipTelemetry(), charge: () => undefined, synthesis },
      );
      published = true;
    } catch (error) {
      caught = error;
    }
    expect(visited).toBe(true);
    expect(isAppError(caught) && caught.code).toBe(AppErrorCode.OperationCancelled);
    expect(published).toBe(false);
    expect(mesh.positions).toEqual(positions);
    expect(mesh.indices).toEqual(indices);
    const recovery = decomposeSemantic(p, answer);
    expect(recovery.suggestions[0]?.operation).toBe('NONE');
    expect(recovery.evidence[0]?.synthesis?.interfaceOwnership).toMatchObject({
      evidenceLevel: 'LOCAL_TARGET_ASSOCIATION',
      ownership: 'AMBIGUOUS',
      wholeCertificate: { complete: false },
    });
    expect(
      recovery.evidence[0]?.synthesis?.ownershipCardinality?.ownershipCompleteness,
    ).toMatchObject({
      state: 'INCOMPLETE_UNRESOLVED',
      semanticComplete: false,
      unrepresentedUnresolved: 1,
    });
    expect(
      recovery.evidence[0]?.synthesis?.peerless?.finalists?.some(
        (finalist) => finalist.confirmed && finalist.structurallyAdmitted,
      ),
    ).toBe(true);
    expect(mesh.positions).toEqual(positions);
    expect(mesh.indices).toEqual(indices);
  });
