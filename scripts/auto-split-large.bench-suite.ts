import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import { describe, it } from 'vitest';
import {
  componentPieces,
  evaluateCabBedPlane,
  faceFacts,
  labelComponents,
  normalizeGeometry,
  prepareViews,
  rasteriseView,
  suggestFor,
  type Checkpoint,
} from '@cadfixer/auto-split';
import { validateVehicle, VIEW_NAMES } from '@cadfixer/auto-split-contract';
import {
  denseTruck,
  manyShellTruck,
  referenceComponentPieces,
  referenceEvaluateCabBedPlane,
  referenceLabelComponents,
  scenarioAnswer,
} from '@cadfixer/auto-split/fixtures';

/**
 * LARGE-MESH PROFILE (AUTO-SPLIT-LARGE-MESH-02): every local stage of the vehicle path in Node, by
 * triangle count, with the pre-optimisation implementation measured beside the live one where one was
 * replaced. NOT part of CI: numbers depend on the machine, and nothing here asserts.
 *
 * One size per process, and steps chosen per process, so the memory of one step is not polluted by
 * another's garbage:
 *
 *   NODE_OPTIONS=--expose-gc LM_SIZE=2000000 LM_STEPS=extract-new \
 *     npx vitest run --config vitest.bench.config.ts scripts/auto-split-large.bench-suite.ts
 *
 * LM_SHELLS=<n> adds that many floating boxes (the many-shell fixture). Results go to
 * artifacts/auto-split-large/ (gitignored).
 */
const TARGET = Number(process.env.LM_SIZE ?? '500000');
const SHELLS = Number(process.env.LM_SHELLS ?? '0');
const ALL = [
  'normalize',
  'facts',
  'raster6',
  'label-ref',
  'label-new',
  'prepare',
  'scorer-ref',
  'scorer-new',
  'suggest-new',
  'extract-ref',
  'extract-new',
  'gaps',
] as const;
const STEPS = new Set((process.env.LM_STEPS ?? ALL.join(',')).split(','));

const mb = (n: number): number => Math.round((n / 1048576) * 10) / 10;
const mem = (): { rss: number; heap: number; ab: number } => {
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed, ab: m.arrayBuffers };
};
const gc = (): void => {
  (globalThis as unknown as { gc?: () => void }).gc?.();
};

const rows: Record<string, unknown>[] = [];
function stage<T>(name: string, fn: () => T): T {
  gc();
  const before = mem();
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  // Read BEFORE any collection: the heap the stage left behind, garbage included, which is the peak a
  // synchronous stage can have reached when it did not collect mid-way.
  const after = mem();
  rows.push({
    stage: name,
    ms: Math.round(ms),
    rssBeforeMB: mb(before.rss),
    rssAfterMB: mb(after.rss),
    heapAfterMB: mb(after.heap),
    heapGrowthMB: mb(after.heap - before.heap),
    arrayBuffersMB: mb(after.ab),
  });
  return out;
}
async function stageAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  gc();
  const before = mem();
  const t0 = performance.now();
  const out = await fn();
  const ms = performance.now() - t0;
  const after = mem();
  rows.push({
    stage: name,
    ms: Math.round(ms),
    rssBeforeMB: mb(before.rss),
    rssAfterMB: mb(after.rss),
    heapAfterMB: mb(after.heap),
    heapGrowthMB: mb(after.heap - before.heap),
    arrayBuffersMB: mb(after.ab),
  });
  return out;
}

/** A checkpoint that records the longest stretch of work between two of its calls. */
function gapMeter(): { checkpoint: Checkpoint; max: () => number; calls: () => number } {
  let last = performance.now();
  let max = 0;
  let calls = 0;
  return {
    checkpoint: (): void => {
      const now = performance.now();
      max = Math.max(max, now - last);
      last = now;
      calls += 1;
    },
    max: () => max,
    calls: () => calls,
  };
}

describe(`large truck, target ${String(TARGET)}, ${String(SHELLS)} extra shells`, () => {
  it('profiles the local stages of the vehicle path', async () => {
    const built = stage('build fixture (not part of the product)', () =>
      SHELLS > 0 ? manyShellTruck(TARGET, SHELLS) : denseTruck(TARGET),
    );
    const mesh = built.mesh;
    const faces = Math.floor(mesh.indices.length / 3);
    const checked = validateVehicle(scenarioAnswer('vehicle-truck-plane'));
    if (!checked.ok) throw new Error('scenario answer invalid');
    const answer = checked.value;
    const deflate = (raw: Uint8Array): Promise<Uint8Array> =>
      Promise.resolve(new Uint8Array(deflateSync(raw)));

    const geometry = normalizeGeometry(mesh.positions, mesh.indices);
    const facts = faceFacts(geometry);
    if (STEPS.has('normalize'))
      stage('normalizeGeometry', () => normalizeGeometry(mesh.positions, mesh.indices));
    if (STEPS.has('facts')) stage('faceFacts', () => faceFacts(geometry));
    if (STEPS.has('raster6'))
      stage('rasterise 6 views (face-id buffers)', () =>
        VIEW_NAMES.map((v) => rasteriseView(geometry, v)),
      );
    let labelling = labelComponents(mesh, facts);
    if (STEPS.has('label-ref'))
      stage('labelComponents (reference)', () => referenceLabelComponents(mesh, facts));
    if (STEPS.has('label-new'))
      labelling = stage('labelComponents (live)', () => labelComponents(mesh, facts));
    if (STEPS.has('prepare'))
      await stageAsync('prepareViews = normalize + 6 render/shade/PNG + shells', () =>
        prepareViews(mesh, deflate),
      );
    if (STEPS.has('scorer-ref'))
      stage('cab/bed scorer (reference: full scans)', () =>
        referenceEvaluateCabBedPlane(geometry, facts, answer),
      );
    if (STEPS.has('scorer-new'))
      stage('cab/bed scorer (live: region lists)', () =>
        evaluateCabBedPlane(geometry, facts, answer),
      );
    let suggestions: readonly string[] = [];
    if (STEPS.has('suggest-new'))
      suggestions = stage('suggestFor vehicle (live, whole local pass)', () =>
        suggestFor(mesh, { mode: 'vehicle', vehicle: answer }),
      ).suggestions.map((s) => `${s.id}:${s.status}`);
    // The smallest-rank component is a wheel on this truck: extract it.
    const wheelRank = Math.max(1, labelling.count - 1);
    if (STEPS.has('extract-ref') && labelling.count > 1)
      stage('componentPieces (reference: Map + number[])', () =>
        referenceComponentPieces(mesh, labelling, [wheelRank]),
      );
    if (STEPS.has('extract-new') && labelling.count > 1)
      stage('componentPieces (live: typed arrays)', () =>
        componentPieces(mesh, labelling, [wheelRank]),
      );
    const gaps: {
      suggestFor?: { maxGapMs: number; checkpoints: number };
      prepareViews?: { maxGapMs: number; checkpoints: number };
    } = {};
    if (STEPS.has('gaps')) {
      const suggest = gapMeter();
      suggestFor(mesh, { mode: 'vehicle', vehicle: answer }, { checkpoint: suggest.checkpoint });
      gaps.suggestFor = { maxGapMs: Math.round(suggest.max()), checkpoints: suggest.calls() };
      const prepare = gapMeter();
      await prepareViews(mesh, deflate, undefined, prepare.checkpoint);
      gaps.prepareViews = { maxGapMs: Math.round(prepare.max()), checkpoints: prepare.calls() };
    }
    gc();
    const summary = {
      triangles: faces,
      plan: built.plan,
      shells: labelling.count,
      suggestions,
      gaps,
      peakRssMB: mb(process.resourceUsage().maxRSS * 1024),
      stages: rows,
    };
    const tag = `${String(TARGET)}${SHELLS > 0 ? `-shells${String(SHELLS)}` : ''}-${[...STEPS].join('+').slice(0, 60)}`;
    mkdirSync('artifacts/auto-split-large', { recursive: true });
    writeFileSync(`artifacts/auto-split-large/node-${tag}.json`, JSON.stringify(summary, null, 1));
    console.warn(JSON.stringify(summary));
  }, 1_800_000);
});
