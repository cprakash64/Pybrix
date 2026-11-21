import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  JOINT_RETAINED_BYTES_PER_TRIANGLE,
  jointId,
  jointRetainedBytes,
  MAX_JOINT_RETAINED_BYTES,
  MAX_SUPPORTED_SPLIT_TRIANGLES,
  partId,
  triangleCount,
  withPartMesh,
  type CanonicalMesh,
  type ConnectorJoint,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import { documentByteLength, ResidentDocumentStore } from '@cadfixer/geometry-runtime';

/**
 * WHAT AN EDITABLE CONNECTOR RETAINS. NOT part of CI.
 *
 * Stage EC-1 sets a retention ceiling, so this answers four narrow questions, on dense content:
 *
 *   1. Does `jointRetainedBytes` equal the typed-array bytes the process really holds for the retained pieces? (An accounting that
 *      disagrees with reality is a ceiling that bounds nothing.)
 *   2. Does retiring a joint at install RELEASE them? Measured as the `ArrayBuffer` bytes Node reports, after a forced collection.
 *   3. What does a joint cost per triangle for INDEXED content and for UNSHARED (soup) content, against the 52-byte bound the
 *      ceiling is derived from?
 *   4. How much of the ceiling does a split at the split ceiling use?
 *
 * WHAT THIS IS NOT. A Node measurement of typed-array memory, not a browser one. It does NOT measure a Chromium renderer's
 * footprint, so it says nothing about the process peak; the Stage 6E-A4 rule that a ceiling argument must use maximally dense
 * INDEXED content applies to that measurement, and EC-3 — the first stage that actually retains bases — must make it.
 *
 * Run with `npm run bench:joint-retention`. Triangles per split source: `CADFIXER_JOINT_TRIANGLES=100000,500000,2000000`.
 */

const MIB = 1024 * 1024;
const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

/** A watertight-looking indexed grid of `2 n²` triangles: shared corners, the cheapest dense shape. */
function indexedGrid(triangles: number): CanonicalMesh {
  const n = Math.max(1, Math.round(Math.sqrt(triangles / 2)));
  const side = n + 1;
  const positions = createPositionArray(side * side * 3);
  for (let y = 0; y < side; y += 1)
    for (let x = 0; x < side; x += 1) {
      const o = (y * side + x) * 3;
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = (x * 31 + y * 17) % 7;
    }
  const indices = createIndexArray(n * n * 6);
  let k = 0;
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) {
      const a = y * side + x;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  return { positions, indices, metadata: {} };
}

/** The same count with NO shared corners: nine coordinates and three indices a triangle, the dearest shape. */
function soup(triangles: number): CanonicalMesh {
  const positions = createPositionArray(triangles * 9);
  const indices = createIndexArray(triangles * 3);
  for (let i = 0; i < triangles; i += 1) {
    positions[i * 9] = i;
    positions[i * 9 + 4] = i % 5;
    positions[i * 9 + 8] = i % 3;
    indices[i * 3] = i * 3;
    indices[i * 3 + 1] = i * 3 + 1;
    indices[i * 3 + 2] = i * 3 + 2;
  }
  return { positions, indices, metadata: {} };
}

function arrayBufferBytes(): number {
  return process.memoryUsage().arrayBuffers;
}
function collect(): void {
  // `--expose-gc` cannot be passed to a vitest fork, so ask V8 for it and reach the function through a fresh context.
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  for (let i = 0; i < 3; i += 1) gc();
}

function jointDocument(
  shape: (triangles: number) => CanonicalMesh,
  triangles: number,
): { readonly document: GeometryDocument; readonly authorityBytes: number } {
  const half = Math.floor(triangles / 2);
  const builtA = shape(half);
  const builtB = shape(half);
  const baseA = shape(half);
  const baseB = shape(half);
  // The interface authority keeps one Int32 of provenance per face of each piece.
  const provenance = [new Int32Array(half), new Int32Array(half)];
  const authorityBytes = provenance.reduce((sum, array) => sum + array.byteLength, 0);
  const a = {
    id: partId('a'),
    mesh: builtA,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] as const,
  };
  const b = {
    id: partId('b'),
    mesh: builtB,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] as const,
  };
  const joint: ConnectorJoint = {
    kind: 'joint',
    jointId: jointId('bench/joint/1'),
    a: { partId: a.id, baseMesh: baseA, builtMesh: builtA, builtTransform: a.transform },
    b: { partId: b.id, baseMesh: baseB, builtMesh: builtB, builtTransform: b.transform },
    frame: { unit: 'millimeter', mmPerUnit: 1, placementScale: 1, mmPerCoordinate: 1 },
    authority: { provenanceSHA: 'bench', retainedBytes: authorityBytes, detail: { provenance } },
    connector: undefined,
    cutNormal: [1, 0, 0],
    nextPinOrdinal: 1,
  };
  return { document: { unit: 'millimeter', parts: [a, b], joints: [joint] }, authorityBytes };
}

interface Row {
  readonly retained: number;
  readonly partsBytes: number;
  readonly held: number;
  readonly installedModel: number;
  readonly triangles: number;
}

/**
 * Everything that holds a mesh lives INSIDE this function, so the only references left when it returns are the store's. That is
 * what makes the post-retirement reading mean something: a local that still named a base would keep it alive for the whole run.
 */
function measure(
  store: ResidentDocumentStore,
  shape: (triangles: number) => CanonicalMesh,
  triangles: number,
): Row {
  const before = arrayBufferBytes();
  const { document } = jointDocument(shape, triangles);
  const held = arrayBufferBytes() - before;
  const row = {
    retained: jointRetainedBytes(document),
    partsBytes: documentByteLength({ parts: document.parts }),
    held,
    triangles: document.parts.reduce((sum, part) => sum + triangleCount(part.mesh), 0),
  };
  const handle = store.commit(document);
  // A repair-shaped change: one part's mesh is replaced, so the joint is no longer attached and the install retires it.
  const resolved = store.resolve(handle);
  if ('code' in resolved) throw resolved;
  const changed = withPartMesh(resolved, partId('a'), shape(Math.floor(triangles / 2)));
  if (changed === undefined) throw new Error('part missing');
  const replaced = store.replace(handle, changed);
  if ('code' in replaced) throw replaced;
  const installed = store.resolve(replaced);
  if ('code' in installed) throw installed;
  return { ...row, installedModel: documentByteLength(installed) };
}

it('joint retention: accounting against reality, release on retirement, and the ceiling', () => {
  const sizes = (process.env.CADFIXER_JOINT_TRIANGLES ?? '100000,500000,2000000')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const rows: string[] = [];
  for (const [label, shape] of [
    ['indexed', indexedGrid],
    ['soup   ', soup],
  ] as const)
    for (const triangles of sizes) {
      collect();
      const baseline = arrayBufferBytes();
      const store = new ResidentDocumentStore();
      const row = measure(store, shape, triangles);
      collect();
      const afterRetire = arrayBufferBytes() - baseline;
      store.releaseAll();
      rows.push(
        [
          label,
          `${String(triangles).padStart(9)} tri`,
          `retained ${mib(row.retained).padStart(10)} = ${(row.retained / row.triangles).toFixed(1).padStart(5)} B/tri (bound ${String(JOINT_RETAINED_BYTES_PER_TRIANGLE)})`,
          `process held ${mib(row.held).padStart(10)} vs model ${mib(row.partsBytes + row.retained).padStart(10)}`,
          `after retire: process ${mib(afterRetire).padStart(10)} vs model ${mib(row.installedModel).padStart(10)}`,
          `${((row.retained / MAX_JOINT_RETAINED_BYTES) * 100).toFixed(1).padStart(5)} % of ceiling`,
        ].join('  |  '),
      );
    }
  process.stdout.write(
    [
      '',
      `joint retention (Node typed-array bytes; NOT a browser footprint). Ceiling ${mib(MAX_JOINT_RETAINED_BYTES)} = ${String(MAX_SUPPORTED_SPLIT_TRIANGLES)} triangles x ${String(JOINT_RETAINED_BYTES_PER_TRIANGLE)} B`,
      ...rows,
    ].join('\n') + '\n',
  );
});
