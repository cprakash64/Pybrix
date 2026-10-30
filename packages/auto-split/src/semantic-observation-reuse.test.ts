import { beforeAll, expect, it } from 'vitest';
import type { SemanticHierarchy, SemanticPart } from '@cadfixer/auto-split-contract';
import { box } from './fixtures/solids';
import { fixtureDeflate } from './fixtures/deflate';
import { prepareSemanticGeometry, type PreparedSemanticGeometry } from './semantic';
import {
  planeObservationCache,
  planeOwnershipTelemetry,
  synthesizeSemanticPlane,
  semanticPlaneScorer,
} from './semantic-local-plane';

let prepared: PreparedSemanticGeometry;
const part: SemanticPart = {
  id: 'target',
  label: 'Member',
  parentId: null,
  importance: 'major',
  confidence: 0.99,
  instances: 1,
  componentIds: [],
  cut: null,
  expectedGeometry: { kind: 'solid_part', likelySeparable: false },
  views: ['front', 'top'].map((view) => ({
    view: view as 'front' | 'top',
    polygons: [
      [
        [0.5, 0],
        [1, 0],
        [1, 1],
        [0.5, 1],
      ],
    ],
  })),
};
const answer: SemanticHierarchy = {
  object: { label: 'Assembly', confidence: 0.99 },
  parts: [part],
};
const context = (): {
  observationCache: ReturnType<typeof planeObservationCache>;
  telemetry: ReturnType<typeof planeOwnershipTelemetry>;
  charge: () => void;
} => ({
  observationCache: planeObservationCache(),
  telemetry: planeOwnershipTelemetry(),
  charge: (): void => undefined,
});
const checkpoint = (): void => undefined;
beforeAll(async () => {
  prepared = await prepareSemanticGeometry(box([-2, -1, -1], [2, 1, 1]), fixtureDeflate);
});

it('reuses only exact observation inputs and recreates pristine mutable scope records', () => {
  const c = context();
  const first = synthesizeSemanticPlane(prepared, answer, part, checkpoint, c);
  const n = c.telemetry.observations;
  expect(n).toBeGreaterThan(0);
  const stored = c.observationCache.get(part);
  expect(stored).toBeDefined();
  // Scope consumers may write this field; it must never become cache input.
  for (const p of stored?.evidence.points ?? []) p.scopeOverhangWitness = true;
  const beforeReuse = c.telemetry.workUnits;
  const second = synthesizeSemanticPlane(prepared, answer, part, checkpoint, c);
  expect(second).toEqual(first);
  const reuseWork = c.telemetry.workUnits - beforeReuse;
  const uncached = { telemetry: planeOwnershipTelemetry(), charge: (): void => undefined };
  expect(synthesizeSemanticPlane(prepared, answer, part, checkpoint, uncached)).toEqual(first);
  expect(reuseWork).toBeLessThan(uncached.telemetry.workUnits);
  expect(c.telemetry.observations).toBe(n);
  expect(c.observationCache.size).toBe(1);
  synthesizeSemanticPlane({ ...prepared }, answer, part, checkpoint, c);
  expect(c.telemetry.observations).toBe(n * 2);
  // Source revision is represented by new immutable request/preparation identities.
  synthesizeSemanticPlane(prepared, { ...answer }, part, checkpoint, c);
  expect(c.telemetry.observations).toBe(n * 3);
  const other = { ...part, id: 'other' };
  synthesizeSemanticPlane(prepared, answer, other, checkpoint, c);
  expect(c.telemetry.observations).toBe(n * 4);
});

it('never memoizes candidate plane scores', () => {
  const other: SemanticPart = {
    ...part,
    id: 'other',
    views: part.views.map((v) => ({
      ...v,
      polygons: [
        [
          [0, 0],
          [0.5, 0],
          [0.5, 1],
          [0, 1],
        ],
      ],
    })),
  };
  const pair = { ...answer, parts: [part, other] };
  const c = context();
  const proposal = synthesizeSemanticPlane(prepared, pair, part, checkpoint, c);
  expect(proposal).toBeDefined();
  if (!proposal) throw Error('Expected complementary proposal');
  const score = semanticPlaneScorer(prepared, pair, part, proposal, checkpoint, c);
  const before = c.telemetry.workUnits;
  score(proposal.cut);
  const first = c.telemetry.workUnits;
  score({ ...proposal.cut, origin: [0.1, 0, 0] });
  expect(first).toBeGreaterThan(before);
  expect(c.telemetry.workUnits).toBeGreaterThan(first);
});

it('bounds entries and recomputes after eviction or a fresh worker/request context', () => {
  const c = context();
  for (let i = 0; i < 9; i++)
    synthesizeSemanticPlane(prepared, answer, { ...part, id: String(i) }, checkpoint, c);
  expect(c.observationCache.size).toBe(8);
  expect([...c.observationCache.keys()].some((p) => p.id === '0')).toBe(false);
  const fresh = context();
  synthesizeSemanticPlane(prepared, answer, part, checkpoint, fresh);
  expect(fresh.telemetry.observations).toBeGreaterThan(0);
  expect(fresh.observationCache.size).toBe(1);
  expect(() =>
    synthesizeSemanticPlane(
      prepared,
      answer,
      part,
      () => {
        throw Error('cancelled');
      },
      fresh,
    ),
  ).toThrow('cancelled');
  expect(context().observationCache.size).toBe(0);
});
