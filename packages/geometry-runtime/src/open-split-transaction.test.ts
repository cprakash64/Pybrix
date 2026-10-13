import { expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  partId,
  singlePartDocument,
} from '@cadfixer/mesh-core';
import { isAppError, uncancellable } from '@cadfixer/shared';
import { ResidentDocumentStore } from './resident-documents';
import { RepairHistoryStore } from './repair-history';
import { GeometryEditStore } from './geometry-edit';
import { SplitCandidateStore } from './split-candidates';
import { splitOpenSurface } from './open-plane-split';
it('fallback Preview, failed validation, failed Apply and Undo preserve the exact source document', () => {
  const positions = createPositionArray(9),
    indices = createIndexArray(3);
  positions.set([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  indices.set([0, 1, 2]);
  const mesh = { positions, indices, metadata: { sourceFormat: 'stl' } },
    doc = singlePartDocument(mesh),
    resident = new ResidentDocumentStore(),
    history = new RepairHistoryStore(),
    edit = new GeometryEditStore(resident, history),
    splits = new SplitCandidateStore(resident, history, edit),
    source = resident.commit(doc);
  const result = splitOpenSurface(mesh, { origin: [0, 0, 0], normal: [1, 0, 0] }, uncancellable);
  let ticket = splits.begin(source, partId('part-1'));
  const invalidPositions = createPositionArray(result.pieceA.positions.length);
  invalidPositions.set(result.pieceA.positions);
  invalidPositions[0] = NaN;
  expect(() =>
    splits.resolve(
      ticket,
      { ...result, pieceA: { ...result.pieceA, positions: invalidPositions } },
      uncancellable,
    ),
  ).toThrow();
  splits.fail(ticket);
  expect(resident.resolve(source)).toBe(doc);
  expect(splits.stats().candidateCount).toBe(0);
  ticket = splits.begin(source, partId('part-1'));
  const summary = splits.resolve(ticket, result, uncancellable);
  expect(resident.resolve(source)).toBe(doc);
  expect(() =>
    splits.commit(summary.candidate, source, partId('part-1'), () => {
      throw Error('forced Apply failure');
    }),
  ).toThrow('forced Apply failure');
  expect(resident.resolve(source)).toBe(doc);
  expect(history.undoableFor(source.documentId)).toBeUndefined();
  const applied = splits.commit(summary.candidate, source, partId('part-1'), (d) => d.parts.length);
  const undo = history.prepareUndo(applied.recordId, applied.handle, applied.handle.revision);
  if (isAppError(undo)) throw undo;
  expect(undo.inverse.previousDocument).toBe(doc);
  const restored = resident.replace(applied.handle, undo.inverse.previousDocument ?? doc);
  if (isAppError(restored)) throw restored;
  expect(resident.resolve(restored)).toBe(doc);
});
