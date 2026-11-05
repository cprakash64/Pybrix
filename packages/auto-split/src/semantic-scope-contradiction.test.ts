import { beforeAll, describe, expect, it } from 'vitest';
import type { SemanticHierarchy, SemanticPart, Vec3 } from '@cadfixer/auto-split-contract';
import { prepareSemanticGeometry, type PreparedSemanticGeometry } from './semantic';
import {
  planeObservationCache,
  planeOwnershipTelemetry,
  semanticPlaneScorer,
  type LocalPlaneProposal,
} from './semantic-local-plane';
import { box } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import { required } from './required';

let prepared: PreparedSemanticGeometry;
beforeAll(async () => {
  prepared = await prepareSemanticGeometry(box([-5, -5, -5], [5, 5, 5]), fixtureDeflate);
});

function scorer(axis: number, scale: number, kind: 'clean' | 'conflict' | 'small' | 'shared') {
  const part = (id: string): SemanticPart => ({
    id,
    label: 'Independent physical role',
    parentId: null,
    importance: 'major',
    confidence: 0.99,
    instances: 1,
    componentIds: [],
    expectedGeometry: { kind: 'solid_part', likelySeparable: true },
    cut: null,
    views: [],
  });
  const target = part(`selected-${String(axis)}-${String(scale)}`),
    peer = part(`neighbor-${String(scale)}`),
    answer: SemanticHierarchy = {
      object: { label: 'Synthetic complementary roles', confidence: 0.99 },
      parts: [target, peer],
    };
  const point = (position: number): Vec3 =>
    [0, 1, 2].map((a) => (a === axis ? position * scale : 0)) as unknown as Vec3;
  const normal = [0, 1, 2].map((a) => (a === axis ? 1 : 0)) as unknown as Vec3;
  const observationCache = planeObservationCache();
  type Evidence = NonNullable<ReturnType<typeof observationCache.get>>['evidence'];
  const points: Evidence['points'][number][] = [];
  const count = kind === 'small' ? 128 : 32;
  for (let view = 0; view < 6; view++) {
    const selectedPeers = view === 4 ? (kind === 'conflict' ? 24 : kind === 'small' ? 8 : 0) : 0;
    for (let i = 0; i < count; i++) {
      points.push({
        point: point(3),
        view,
        target: true,
        rank: 0,
        peerMask: kind === 'shared' && view === 4 ? 1 : 0,
      });
      points.push({
        point: point(i < selectedPeers ? 1 : -3),
        view,
        target: false,
        rank: 0,
        peerMask: 1,
      });
    }
  }
  observationCache.set(target, {
    prepared,
    answer,
    evidence: {
      points,
      peers: [{ part: peer, exactRanks: [], fused: true }],
      typedBytes: 0,
      exactTarget: false,
      fusedTarget: true,
    },
  });
  const previous: LocalPlaneProposal = {
    cut: { normal, origin: point(0) },
    confidence: 1,
    scope: 'part',
    alignment: 'focused',
    samples: points.length,
    candidates: 2,
    sectionSamples: 0,
    capturedFraction: 0.5,
    views: [],
    ownership: {
      admitted: true,
      rule: 'CLEAN_PHYSICAL_EXTENT',
      targetRecall: 1,
      semanticPurity: 1,
      worstPeerLeakage: 0,
      peers: [],
      comparableCleanerCandidates: 0,
      frontierCandidates: 2,
    },
  };
  const score = semanticPlaneScorer(prepared, answer, target, previous, () => undefined, {
    observationCache,
    telemetry: planeOwnershipTelemetry(),
    charge: () => undefined,
  });
  return (offset: number): LocalPlaneProposal | undefined =>
    score({ normal, origin: point(offset) });
}

describe.each([0, 1, 2].flatMap((axis) => [0.4, 7].map((scale) => ({ axis, scale }))))(
  'ownership scope on axis $axis at scale $scale',
  ({ axis, scale }) => {
    it('retains a supported single-view constraint in published ownership evidence', () => {
      const result = required(scorer(axis, scale, 'small')(0), 'supported low leakage');
      expect(result.ownership.worstPeerLeakage).toBeCloseTo(8 / 128);
      expect(result.ownership.peers[0]?.leakage).toBeCloseTo(8 / 128);
      expect(result.ownership.semanticPurity).toBeCloseTo(128 / 136);
      expect(result.views.find((v) => v.view === 4)?.semanticPurity).toBeCloseTo(128 / 136);
    });
    it('rejects a contradictory complementary boundary despite five supporting views', () => {
      const score = scorer(axis, scale, 'conflict');
      expect(score(0)).toBeUndefined();
      expect(score(2)?.ownership.rule).toBe('CLEAN_PHYSICAL_EXTENT');
    });
    it('preserves valid non-contradictory complementary boundaries', () => {
      const result = required(scorer(axis, scale, 'clean')(0), 'clean boundary');
      expect(result.ownership.semanticPurity).toBe(1);
      expect(result.ownership.worstPeerLeakage).toBe(0);
    });
    it('preserves the closest-control pattern of one shared-only ambiguous view', () => {
      const result = required(scorer(axis, scale, 'shared')(0), 'shared-only boundary');
      expect(result.ownership.rule).toBe('CLEAN_PHYSICAL_EXTENT');
      expect(result.views.find((v) => v.view === 4)?.semanticPurity).toBe(0);
      expect(result.views.find((v) => v.view === 4)?.rawPurity).toBe(1);
    });
  },
);
