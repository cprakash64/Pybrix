import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import type { SemanticHierarchy, SemanticPart } from '@cadfixer/auto-split-contract';
import { fixtureDeflate } from './fixtures/deflate';
import { decomposeSemantic, prepareSemanticGeometry } from './semantic';
import { GroundingState } from './suggestions';

/**
 * v0.7.1 — THE OWNER'S DUMP TRUCK, ANALYSED OFFLINE.
 *
 * Runs only when `CADFIXER_TRUCK_STL` names a binary STL (it ships no model data) and calls no provider:
 * the hierarchy below is a DETERMINISTIC fixture whose outlines were authored by looking at the six
 * views this engine renders for the 1,988,877-triangle truck. It is not the owner's provider answer and
 * claims nothing about one. What it proves is how the REAL engine treats a ~2M-triangle model that is
 * essentially one fused shell: the work is bounded, the recognized parts are tied to faces, and the
 * grounding facts are typed.
 */
const PATH = process.env.CADFIXER_TRUCK_STL ?? '';
const px = (...p: readonly (readonly [number, number])[]): number[][] =>
  p.map(([x, y]) => [x / 512, y / 512]);
const octagon = (cx: number, cy: number, r: number): number[][] =>
  px(
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(
      (k) =>
        [
          cx + r * Math.cos((k * Math.PI) / 4 - Math.PI / 2),
          cy + r * Math.sin((k * Math.PI) / 4 - Math.PI / 2),
        ] as const,
    ),
  );

const views = (over: Record<string, number[][][]>): SemanticPart['views'] =>
  Object.entries(over).map(([view, polygons]) => ({
    view: view as 'left',
    polygons: polygons as unknown as SemanticPart['views'][number]['polygons'],
  }));

const HIERARCHY: SemanticHierarchy = {
  object: { label: 'Dump truck', confidence: 0.97 },
  parts: [
    {
      id: 'wheels',
      label: 'Road wheels',
      parentId: null,
      importance: 'major',
      confidence: 0.95,
      instances: 4,
      componentIds: [],
      expectedGeometry: { kind: 'repeated_part', likelySeparable: true },
      cut: null,
      views: views({
        left: [octagon(322, 142, 56), octagon(323, 357, 56)],
        right: [octagon(190, 142, 56), octagon(189, 357, 56)],
      }),
    },
    {
      id: 'cab',
      label: 'Cab',
      parentId: null,
      importance: 'major',
      confidence: 0.93,
      instances: 1,
      componentIds: [],
      expectedGeometry: { kind: 'solid_part', likelySeparable: true },
      cut: null,
      views: views({
        left: [px([162, 205], [162, 130], [212, 62], [262, 50], [262, 205])],
        right: [px([350, 205], [350, 130], [300, 62], [250, 50], [250, 205])],
      }),
    },
  ],
};

describe.skipIf(PATH === '')("the owner's truck, offline and without a provider", () => {
  it('bounds the work, ties recognized parts to faces and types every grounding fact', async () => {
    const buf = readFileSync(PATH);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const n = dv.getUint32(80, true);
    const positions = createPositionArray(n * 9);
    const indices = createIndexArray(n * 3);
    let o = 84;
    for (let t = 0; t < n; t += 1) {
      o += 12;
      for (let k = 0; k < 9; k += 1) {
        positions[t * 9 + k] = dv.getFloat32(o, true);
        o += 4;
      }
      o += 2;
      for (let k = 0; k < 3; k += 1) indices[t * 3 + k] = t * 3 + k;
    }
    const mesh: CanonicalMesh = { positions, indices, metadata: { sourceFormat: 'stl' } };

    const t0 = Date.now();
    const prepared = await prepareSemanticGeometry(mesh, fixtureDeflate);
    const t1 = Date.now();
    const result = decomposeSemantic(prepared, HIERARCHY);
    const t2 = Date.now();

    const regionBytes = [...result.grounding.values()].reduce(
      (n_, r) => n_ + r.faceBits.byteLength,
      0,
    );
    const rows = result.suggestions.map((s) => ({
      id: s.id,
      label: s.label,
      operation: s.operation,
      status: s.status,
      quality: s.quality,
      diagnostic: s.diagnostic,
      grounding: s.grounding,
    }));
    writeFileSync(
      process.env.TRUCK_OUT ?? 'truck-grounding.json',
      JSON.stringify(
        {
          fixture:
            'deterministic hierarchy authored from the engine-rendered views; NOT a provider answer',
          sha256: createHash('sha256').update(buf).digest('hex'),
          triangles: n,
          prepareMs: t1 - t0,
          decomposeMs: t2 - t1,
          components: prepared.labelling.count,
          groundedRegionBytes: regionBytes,
          rows,
        },
        null,
        2,
      ),
    );

    expect(result.suggestions.map((s) => s.id).sort()).toEqual(['cab', 'wheels']);
    for (const row of rows) {
      // Every recognized part states its grounding; nothing is left implicit.
      expect(row.grounding).toBeDefined();
      expect([GroundingState.Grounded, GroundingState.NotGrounded]).toContain(row.grounding?.state);
    }
    // The outlines sit on the truck, so both are tied to real faces, whether or not any cut exists.
    for (const id of ['wheels', 'cab']) {
      const region = result.grounding.get(id);
      expect(region?.faces ?? 0).toBeGreaterThan(0);
      expect(region?.faces ?? n + 1).toBeLessThan(n);
    }
    // The retained face sets are one bit a face: bounded by parts x faces / 8, nowhere near the mesh.
    expect(regionBytes).toBeLessThanOrEqual(24 * Math.ceil(n / 32) * 4);
    // Bounded work on a ~2M-triangle model (measured in seconds, not minutes).
    expect(t2 - t0).toBeLessThan(120_000);
  }, 600_000);
});
