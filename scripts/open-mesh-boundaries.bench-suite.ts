import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology, type TopologyResult } from '@cadfixer/mesh-topology';
import { splitWithConnectors } from '@cadfixer/geometry-runtime';
import { uncancellable } from '@cadfixer/shared';
function boundaries(result: TopologyResult): Set<string> {
  const detail = result.detail;
  expect(detail.boundaryEdgesTruncated).toBe(false);
  const points = new Map<number, string>();
  for (let i = 0; i < detail.sampleVertexIds.length; i++)
    points.set(
      detail.sampleVertexIds[i] ?? 0,
      Array.from(detail.sampleVertexPositions.subarray(i * 3, i * 3 + 3), (x) =>
        x === 0 ? 0 : x,
      ).join('/'),
    );
  const keys = new Set<string>();
  for (let i = 0; i < detail.boundaryEdges.length; i += 2) {
    const a = points.get(detail.boundaryEdges[i] ?? 0),
      b = points.get(detail.boundaryEdges[i + 1] ?? 0);
    if (a === undefined || b === undefined) throw Error('missing endpoint');
    keys.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return keys;
}
it('independently proves zero newly introduced unrelated truck boundaries', async () => {
  const b = readFileSync(
      process.env.OPEN_MESH_TRUCK_PATH ?? join(homedir(), 'Downloads', 'Hitem3d-1785766060812.stl'),
    ),
    v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    n = v.getUint32(80, true),
    positions = createPositionArray(n * 9),
    indices = createIndexArray(n * 3);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 9; k++) positions[f * 9 + k] = v.getFloat32(84 + f * 50 + 12 + k * 4, true);
    for (let k = 0; k < 3; k++) indices[f * 3 + k] = f * 3 + k;
  }
  const readArray = (p: string): ArrayBuffer => {
    const b = readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const repaired: CanonicalMesh = {
    positions: new Float32Array(readArray('artifacts/open-mesh-split-01/repaired.positions')),
    indices: new Uint32Array(readArray('artifacts/open-mesh-split-01/repaired.indices')),
    metadata: {},
  };
  const analyse = (m: CanonicalMesh): TopologyResult =>
    analyseTopology(m, {
      documentId: 'independent',
      partId: 'p',
      documentRevision: 0,
      cancellation: uncancellable,
      sampleLimit: 8192,
      componentSummaryLimit: 64,
    });
  const rows: unknown[] = [];
  for (const [label, m] of [
    ['original', { positions, indices, metadata: {} }],
    ['repaired', repaired],
  ] as const) {
    const before = analyse(m),
      original = boundaries(before);
    const r = await splitWithConnectors(
      {
        operate: () => {
          throw Error('Boolean');
        },
      },
      m,
      {
        plane: { origin: [0, 0, 0.1180868148803711], normal: [0, 0, 1] },
        connector: { kind: 'none' },
      },
      uncancellable,
    );
    const a = analyse(r.pieceA),
      b = analyse(r.pieceB),
      next = new Set([...boundaries(a), ...boundaries(b)]),
      added = [...next].filter((k) => !original.has(k)),
      lost = [...original].filter((k) => !next.has(k));
    expect(added).toEqual([]);
    expect(lost).toEqual([]);
    rows.push({
      label,
      sourceBoundaryEdges: original.size,
      outputBoundaryEdges: next.size,
      newBoundaries: added.length,
      lostBoundaries: lost.length,
      before: before.report,
      afterA: a.report,
      afterB: b.report,
      validation: r.surfaceValidation,
    });
    writeFileSync(
      'artifacts/open-mesh-split-01/boundary-proof.json',
      JSON.stringify(rows, null, 2),
    );
  }
}, 600_000);
