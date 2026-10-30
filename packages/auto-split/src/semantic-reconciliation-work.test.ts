import { expect, it } from 'vitest';
import type { SemanticHierarchy } from '@cadfixer/auto-split-contract';
import { annotatedPart, voxelUnion } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import { prepareSemanticGeometry } from './semantic';
import { reconcileComplementarySiblings } from './semantic-complementary';
import {
  planeObservationCache,
  planeOwnershipTelemetry,
  synthesizeSemanticPlane,
  type LocalPlaneProposal,
  type PlaneOwnershipContext,
} from './semantic-local-plane';

it('preserves differing complementary beams while avoiding repeated evidence work', async () => {
  const mesh = voxelUnion([
    { lo: [-12, -2, -2], hi: [5, 2, 2] },
    { lo: [5, -4, -3], hi: [9, 4, 3] },
  ]);
  const prepared = await prepareSemanticGeometry(mesh, fixtureDeflate);
  // Generic raster claims for two physical roles; no expected cut enters synthesis.
  const faceRank = Int32Array.from({ length: mesh.indices.length / 3 }, (_, f) =>
    [0, 1, 2].reduce(
      (s, k) => s + (mesh.positions[(mesh.indices[f * 3 + k] ?? 0) * 3] ?? 0) / 3,
      0,
    ) >= 5
      ? 0
      : 1,
  );
  const annotation = { ...prepared, labelling: { ...prepared.labelling, count: 2, faceRank } };
  const answer: SemanticHierarchy = {
    object: { label: 'Unfamiliar assembly', confidence: 0.99 },
    parts: [0, 1].map((rank) => ({
      ...annotatedPart(annotation, String(rank), 'Unfamiliar member', [rank]),
      componentIds: [],
      expectedGeometry: { kind: 'solid_part', likelySeparable: false },
    })),
  };
  const run = (
    reuse: boolean,
  ): {
    initial: LocalPlaneProposal[];
    final: LocalPlaneProposal[];
    planes: number;
    operations: number;
    work: number;
  } => {
    const c: PlaneOwnershipContext = {
      telemetry: planeOwnershipTelemetry(),
      charge: (): void => undefined,
      ...(reuse ? { observationCache: planeObservationCache() } : {}),
    };
    const proposals = new Map<string, LocalPlaneProposal>();
    for (const part of answer.parts) {
      const p = synthesizeSemanticPlane(prepared, answer, part, () => undefined, c);
      if (p) proposals.set(part.id, p);
    }
    expect(proposals.size).toBe(2);
    const initial = [...proposals.values()];
    expect(initial[0]?.finalists).not.toEqual(initial[1]?.finalists);
    const before = c.telemetry.workUnits,
      passes = c.telemetry.peerScoringPasses;
    const result = reconcileComplementarySiblings(prepared, answer, proposals, () => undefined, c);
    return {
      initial,
      final: [...proposals.values()],
      planes: result.pairs[0]?.candidates ?? 0,
      operations: c.telemetry.peerScoringPasses - passes,
      work: c.telemetry.workUnits - before,
    };
  };
  const plain = run(false),
    reused = run(true);
  expect(reused.initial).toEqual(plain.initial);
  expect(reused.final).toEqual(plain.final);
  expect(reused.planes).toBe(plain.planes);
  expect(reused.operations).toBe(plain.operations);
  // The provenance tie moves this existing candidate ahead of PEER_INTERVAL.
  expect(reused.initial[1]?.provenance?.offsetSource).toBe('TARGET_MIN');
  expect(reused.planes).toBe(4);
  expect(reused.operations).toBe(8);
  expect(reused.work).toBe(47954);
  // Frozen generic canonical reconciliation budget, including both factories.
  expect(reused.work).toBeLessThanOrEqual(103412);
  expect(reused.operations).toBe(reused.planes * 2);
  expect(reused.work).toBeLessThan(plain.work);
});
