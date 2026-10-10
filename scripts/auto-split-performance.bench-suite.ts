import { performance } from 'node:perf_hooks';
import { describe, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  componentPieces,
  faceFacts,
  labelComponents,
  normalizeGeometry,
  prepareViews,
  suggestFor,
  type Deflate,
} from '@cadfixer/auto-split';
import { encodeBase64 } from '@cadfixer/auto-split-contract';
import { carMultipart, humanFigure, scenarioAnswer } from '@cadfixer/auto-split/fixtures';
import { validateHuman, validateVehicle } from '@cadfixer/auto-split-contract';

/**
 * AUTO SPLIT'S LOCAL COST, measured in Node (the worker's own engine, no browser): the six renders,
 * the suggestion pass and the component extraction, by triangle count. NOT part of CI — numbers depend
 * on the machine — and asserting nothing, per `vitest.bench.config.ts`.
 *
 *   npm run bench:auto-split
 *
 * The provider's latency is not measured here and is not ours: it is the 30–70+ s the interface says
 * to expect. What this measures is the part Pybrix controls: how long the page waits, off its thread,
 * before the request can leave, and what the request weighs.
 */

const deflate: Deflate = async (raw) => {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(raw)).then(() => writer.close());
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (value) parts.push(value);
    if (done) break;
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A closed, indexed UV sphere with about `target` triangles. */
function sphere(target: number): CanonicalMesh {
  const rings = Math.max(4, Math.round(Math.sqrt(target / 2)));
  const segments = rings * 2;
  const vertexTotal = 2 + (rings - 1) * segments;
  const triangleTotal = segments * 2 + (rings - 2) * segments * 2;
  const positions = createPositionArray(vertexTotal * 3);
  const indices = createIndexArray(triangleTotal * 3);
  positions.set([0, 0, 20], 0);
  let p = 3;
  for (let ring = 1; ring < rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2;
      positions.set(
        [
          Math.cos(theta) * Math.sin(phi) * 20,
          Math.sin(theta) * Math.sin(phi) * 20,
          Math.cos(phi) * 20,
        ],
        p,
      );
      p += 3;
    }
  }
  positions.set([0, 0, -20], (vertexTotal - 1) * 3);
  let at = 0;
  for (let segment = 0; segment < segments; segment += 1) {
    indices.set([0, 1 + segment, 1 + ((segment + 1) % segments)], at);
    at += 3;
  }
  for (let ring = 0; ring < rings - 2; ring += 1) {
    const row = 1 + ring * segments;
    const next = row + segments;
    for (let segment = 0; segment < segments; segment += 1) {
      const s2 = (segment + 1) % segments;
      indices.set([row + segment, next + segment, row + s2], at);
      at += 3;
      indices.set([row + s2, next + segment, next + s2], at);
      at += 3;
    }
  }
  const south = vertexTotal - 1;
  const last = 1 + (rings - 2) * segments;
  for (let segment = 0; segment < segments; segment += 1) {
    indices.set([south, last + ((segment + 1) % segments), last + segment], at);
    at += 3;
  }
  return { positions, indices, metadata: {} };
}

const ms = (since: number): number => Number((performance.now() - since).toFixed(1));

describe('Auto Split local cost', () => {
  it('six renders, request weight, and suggestion passes by triangle count', async () => {
    const rows: Record<string, unknown>[] = [];
    for (const target of [12_000, 100_000, 400_000, 1_000_000, 1_500_000]) {
      const mesh = sphere(target);
      const triangles = mesh.indices.length / 3;
      const t0 = performance.now();
      const prepared = await prepareViews(mesh, deflate);
      const renderMs = ms(t0);
      const body = JSON.stringify({
        views: prepared.pngs.map((png) => encodeBase64(png)),
        summary: prepared.summary,
      }).length;
      const t1 = performance.now();
      const geometry = normalizeGeometry(mesh.positions, mesh.indices);
      const labelling = labelComponents(mesh, faceFacts(geometry));
      const labelMs = ms(t1);
      rows.push({
        triangles,
        renderMs,
        bodyKiB: Math.round(body / 1024),
        labelMs,
        shells: labelling.count,
      });
    }
    // `warn` is the one console method the repository allows; a bench exists to print.
    console.warn(JSON.stringify({ kind: 'render+label', rows }));
  });

  it('suggestions and component extraction on the test models', () => {
    const human = humanFigure().mesh;
    const car = carMultipart().mesh;
    const humanAnswer = validateHuman(scenarioAnswer('human-ok'));
    const carAnswer = validateVehicle(scenarioAnswer('vehicle-component'));
    if (!humanAnswer.ok || !carAnswer.ok) throw new Error('fixture answers do not validate');
    const t0 = performance.now();
    suggestFor(human, { mode: 'human', human: humanAnswer.value });
    const humanMs = ms(t0);
    const t1 = performance.now();
    suggestFor(car, { mode: 'vehicle', vehicle: carAnswer.value });
    const vehicleMs = ms(t1);
    const labelling = labelComponents(
      car,
      faceFacts(normalizeGeometry(car.positions, car.indices)),
    );
    const t2 = performance.now();
    componentPieces(car, labelling, [1]);
    const extractMs = ms(t2);
    console.warn(JSON.stringify({ kind: 'suggest', humanMs, vehicleMs, extractMs }));
  });
});
