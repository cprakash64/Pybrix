import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';
import type { splitWithConnectors } from '@cadfixer/geometry-runtime';
const root = process.env.OPEN_MESH_BASELINE_ROOT ?? '';
/** Read-only frozen cdcca23 import: the feature worktree cannot stand in for baseline evidence. */
it.skipIf(root === '')(
  'reproduces deployed-source refusals before any Boolean on both truck states',
  async () => {
    const module = (await import(`${root}/packages/geometry-runtime/src/split-connectors.ts`)) as {
      splitWithConnectors: typeof splitWithConnectors;
    };
    const file =
      process.env.OPEN_MESH_TRUCK_PATH ?? join(homedir(), 'Downloads', 'Hitem3d-1785766060812.stl');
    const b = readFileSync(file),
      v = new DataView(b.buffer, b.byteOffset, b.byteLength),
      n = v.getUint32(80, true),
      positions = createPositionArray(n * 9),
      indices = createIndexArray(n * 3);
    for (let f = 0; f < n; f++) {
      for (let k = 0; k < 9; k++)
        positions[f * 9 + k] = v.getFloat32(84 + f * 50 + 12 + k * 4, true);
      for (let k = 0; k < 3; k++) indices[f * 3 + k] = f * 3 + k;
    }
    const array = (p: string): ArrayBuffer => {
      const data = readFileSync(p);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    };
    const meshes: Record<string, CanonicalMesh> = {
      original: { positions, indices, metadata: {} },
      repaired: {
        positions: new Float32Array(array('artifacts/open-mesh-split-01/repaired.positions')),
        indices: new Uint32Array(array('artifacts/open-mesh-split-01/repaired.indices')),
        metadata: {},
      },
    };
    const rows: unknown[] = [];
    let booleanCalls = 0;
    for (const [label, mesh] of Object.entries(meshes)) {
      try {
        await module.splitWithConnectors(
          {
            operate: () => {
              booleanCalls++;
              throw Error('Boolean reached');
            },
          },
          mesh,
          {
            plane: { origin: [0, 0, 0.1180868148803711], normal: [0, 0, 1] },
            connector: { kind: 'none' },
          },
          uncancellable,
        );
        throw Error('baseline unexpectedly accepted');
      } catch (e) {
        expect(e).toMatchObject({ details: { code: 'SPLIT_SOURCE_NOT_CLOSED_SOLID' } });
        rows.push({ label, refusal: e });
      }
    }
    expect(booleanCalls).toBe(0);
    const paths = [
        'packages/geometry-runtime/src/split-connectors.ts',
        'apps/web/src/state/use-auto-split.ts',
        'apps/web/src/workers/auto-split-handlers.ts',
      ],
      hashes = Object.fromEntries(
        paths.map((p) => [
          p,
          createHash('sha256')
            .update(readFileSync(`${root}/${p}`))
            .digest('hex'),
        ]),
      );
    writeFileSync(
      'artifacts/open-mesh-split-01/frozen-baseline-refusal.json',
      JSON.stringify(
        {
          baselineSha: 'cdcca239bdd70af4baf2aa2338522c0c53751ee5',
          sourceRoot: root,
          sourceHashes: hashes,
          booleanCalls,
          rows,
        },
        null,
        2,
      ),
    );
  },
  600_000,
);
