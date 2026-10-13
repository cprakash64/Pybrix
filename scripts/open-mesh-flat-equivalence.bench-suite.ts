import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createPositionArray, createIndexArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { uncancellable } from '@cadfixer/shared';
import { splitOpenSurface, type SplitResult } from '@cadfixer/geometry-runtime';
const digest = (mesh: CanonicalMesh): string =>
  createHash('sha256')
    .update(new Uint8Array(mesh.positions.buffer))
    .update(new Uint8Array(mesh.indices.buffer))
    .digest('hex');
it('flat scratch traversal preserves the qualified truck output byte-for-byte', async () => {
  const reference = (await import(
    pathToFileURL(resolve('artifacts/open-mesh-split-01/pre-flat-loop-reference.mjs')).href
  )) as { splitOpenSurface: typeof splitOpenSurface };
  const file =
      process.env.OPEN_MESH_TRUCK_PATH ?? join(homedir(), 'Downloads', 'Hitem3d-1785766060812.stl'),
    b = readFileSync(file),
    v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    n = v.getUint32(80, true),
    positions = createPositionArray(n * 9),
    indices = createIndexArray(n * 3);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 9; k++) positions[f * 9 + k] = v.getFloat32(84 + f * 50 + 12 + k * 4, true);
    for (let k = 0; k < 3; k++) indices[f * 3 + k] = f * 3 + k;
  }
  const rows: unknown[] = [];
  const mesh = { positions, indices, metadata: {} };
  for (const normal of [
    [0, 0, 1],
    [0, 0, -1],
  ] as const) {
    const plane = { origin: [0, 0, 0.1180868148803711] as const, normal };
    const before: SplitResult = reference.splitOpenSurface(mesh, plane, uncancellable),
      after = splitOpenSurface(mesh, plane, uncancellable);
    expect(digest(after.pieceA)).toBe(digest(before.pieceA));
    expect(digest(after.pieceB)).toBe(digest(before.pieceB));
    expect(after.cutA.outline).toEqual(before.cutA.outline);
    rows.push({
      normal,
      pieceASha256: digest(after.pieceA),
      pieceBSha256: digest(after.pieceB),
      sameGeometry: true,
      phaseMilliseconds: after.surfaceValidation?.phaseMilliseconds,
    });
  }
  writeFileSync(
    'artifacts/open-mesh-split-01/flat-loop-equivalence.json',
    JSON.stringify(rows, null, 2),
  );
}, 600_000);
it('a sub-ULP cut fragment is refused without changing any source coordinate', () => {
  const positions = createPositionArray(9),
    indices = createIndexArray(3);
  positions.set([-1, -1, 1, 1, -1, 1, 0, 1, -1]);
  indices.set([0, 1, 2]);
  const mesh = { positions, indices, metadata: {} },
    before = digest(mesh);
  let error: unknown;
  try {
    splitOpenSurface(mesh, { origin: [0, 0, 1 - 2 ** -30], normal: [0, 0, 1] }, uncancellable);
  } catch (e) {
    error = e;
  }
  expect(error).toMatchObject({
    details: { code: 'CUT_NOT_SAFE', reason: 'unrepresentable-cut-fragment' },
  });
  expect(digest(mesh)).toBe(before);
});
