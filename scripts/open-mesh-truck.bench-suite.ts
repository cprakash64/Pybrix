import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { splitWithConnectors } from '@cadfixer/geometry-runtime';
import { uncancellable } from '@cadfixer/shared';
it('qualifies meaningful original and repaired truck planes', async () => {
  const bytes = readFileSync(
      process.env.OPEN_MESH_TRUCK_PATH ?? join(homedir(), 'Downloads', 'Hitem3d-1785766060812.stl'),
    ),
    dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    n = dv.getUint32(80, true),
    positions = createPositionArray(n * 9),
    indices = createIndexArray(n * 3);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 9; k++)
      positions[f * 9 + k] = dv.getFloat32(84 + f * 50 + 12 + k * 4, true);
    for (let k = 0; k < 3; k++) indices[f * 3 + k] = f * 3 + k;
  }
  const repairedP = readFileSync('artifacts/open-mesh-split-01/repaired.positions'),
    repairedI = readFileSync('artifacts/open-mesh-split-01/repaired.indices');
  const models: Record<string, CanonicalMesh> = {
    original: { positions, indices, metadata: { sourceFormat: 'stl' } },
    repaired: {
      positions: new Float32Array(
        repairedP.buffer.slice(repairedP.byteOffset, repairedP.byteOffset + repairedP.length),
      ),
      indices: new Uint32Array(
        repairedI.buffer.slice(repairedI.byteOffset, repairedI.byteOffset + repairedI.length),
      ),
      metadata: { sourceFormat: 'stl' },
    },
  };
  const rows: unknown[] = [];
  for (const [label, mesh] of Object.entries(models))
    for (const z of [0.1180868148803711, 0, 0.5, 1, -0.5]) {
      const t = performance.now();
      try {
        const r = await splitWithConnectors(
          {
            operate: () => {
              throw Error('Boolean');
            },
          },
          mesh,
          { plane: { origin: [0, 0, z], normal: [0, 0, 1] }, connector: { kind: 'none' } },
          uncancellable,
        );
        rows.push({
          label,
          z,
          ok: true,
          ms: performance.now() - t,
          facesA: r.pieceA.indices.length / 3,
          facesB: r.pieceB.indices.length / 3,
          validation: r.surfaceValidation,
        });
      } catch (e) {
        rows.push({ label, z, ok: false, ms: performance.now() - t, error: e });
      }
      writeFileSync('artifacts/open-mesh-split-01/truck-cuts.json', JSON.stringify(rows, null, 2));
      console.warn(rows.at(-1));
    }
}, 600_000);
