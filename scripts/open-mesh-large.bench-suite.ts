import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { denseTruck } from '@cadfixer/auto-split/fixtures';
import {
  createIndexArray,
  createPositionArray,
  singlePartDocument,
  partId,
} from '@cadfixer/mesh-core';
import { uncancellable, isAppError } from '@cadfixer/shared';
import {
  splitWithConnectors,
  ResidentDocumentStore,
  RepairHistoryStore,
  GeometryEditStore,
  SplitCandidateStore,
} from '@cadfixer/geometry-runtime';
it('qualifies a near-2M open surface and the normal transaction bounds', async () => {
  const closed = denseTruck(2_000_000).mesh;
  const indices = createIndexArray(closed.indices.length);
  indices.set(closed.indices.subarray(3));
  const positions = createPositionArray(closed.positions.length + 9);
  positions.set(closed.positions);
  positions.set([80, 80, 80, 81, 80, 80, 80, 81, 80], closed.positions.length);
  const vertexOffset = closed.positions.length / 3;
  indices.set([vertexOffset, vertexOffset + 1, vertexOffset + 2], indices.length - 3);
  const mesh = { ...closed, positions, indices };
  const resident = new ResidentDocumentStore(),
    history = new RepairHistoryStore(),
    edit = new GeometryEditStore(resident, history),
    splits = new SplitCandidateStore(resident, history, edit),
    doc = singlePartDocument(mesh),
    source = resident.commit(doc),
    ticket = splits.begin(source, partId('part-1'));
  const started = performance.now();
  const result = await splitWithConnectors(
    {
      operate: () => {
        throw Error('exact backend reached');
      },
    },
    mesh,
    { plane: { origin: [10.13, 0, 0], normal: [1, 0, 0] }, connector: { kind: 'none' } },
    uncancellable,
  );
  const splitMs = performance.now() - started;
  let t = performance.now();
  const summary = splits.resolve(ticket, result, uncancellable);
  const resolveMs = performance.now() - t;
  t = performance.now();
  splits.preview(summary.candidate, (document) => document.parts.length);
  const previewMs = performance.now() - t;
  expect(resident.resolve(source)).toBe(doc);
  t = performance.now();
  const applied = splits.commit(
    summary.candidate,
    source,
    partId('part-1'),
    (document) => document.parts.length,
  );
  const applyMs = performance.now() - t;
  t = performance.now();
  const undo = history.prepareUndo(applied.recordId, applied.handle, applied.handle.revision);
  if (isAppError(undo)) throw undo;
  const restored = resident.replace(applied.handle, undo.inverse.previousDocument ?? doc);
  if (isAppError(restored)) throw restored;
  const undoMs = performance.now() - t;
  expect(resident.resolve(restored)).toBe(doc);
  writeFileSync(
    'artifacts/open-mesh-split-01/large-open.json',
    JSON.stringify(
      {
        sourceTriangles: mesh.indices.length / 3,
        splitMs,
        phaseMilliseconds: result.surfaceValidation?.phaseMilliseconds,
        resolveMs,
        previewMs,
        applyMs,
        undoMs,
        resources: summary.resources,
        validation: result.surfaceValidation,
        rssMiB: process.memoryUsage().rss / 1048576,
        maxRssMiB: process.resourceUsage().maxRSS / 1024,
        heapMiB: process.memoryUsage().heapUsed / 1048576,
        arrayBufferMiB: process.memoryUsage().arrayBuffers / 1048576,
        undoMeshIdentity: true,
      },
      null,
      2,
    ),
  );
}, 600_000);
