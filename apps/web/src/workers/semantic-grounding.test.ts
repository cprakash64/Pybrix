import { describe, expect, it } from 'vitest';
import { box } from '@cadfixer/auto-split/fixtures';
import type { GroundedRegion } from '@cadfixer/auto-split';
import type { DocumentHandle } from '@cadfixer/geometry-runtime';
import {
  clearSemanticGrounding,
  groundedFacesFor,
  registerSemanticGrounding,
} from './semantic-grounding';

const source = { documentId: 'grounding-test', revision: 3 } as DocumentHandle;

function regionOf(faces: readonly number[], faceCount: number): GroundedRegion {
  const faceBits = new Uint32Array(Math.ceil(faceCount / 32));
  for (const f of faces) faceBits[f >>> 5] = (faceBits[f >>> 5] ?? 0) | (1 << (f & 31));
  return { faceBits, faces: faces.length, views: 2 };
}

describe('the worker-resident grounded face sets', () => {
  const faces = [0, 5, 31, 32, 63, 64, 100, 199];

  it('returns the faces ascending, exactly those set, for the current analysis', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticGrounding(source, 'part', mesh, 1, new Map([['wheels', regionOf(faces, 200)]]));
    const found = groundedFacesFor(source, 'part', mesh, 'wheels');
    expect(found.state).toBe('FOUND');
    if (found.state === 'FOUND') expect(Array.from(found.faces)).toEqual(faces);
  });

  it('reading is free of side effects: a second read is identical and the stored set is unchanged', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    const region = regionOf(faces, 200);
    const before = Array.from(region.faceBits);
    registerSemanticGrounding(source, 'part', mesh, 1, new Map([['wheels', region]]));
    const a = groundedFacesFor(source, 'part', mesh, 'wheels');
    const b = groundedFacesFor(source, 'part', mesh, 'wheels');
    expect(a.state === 'FOUND' && b.state === 'FOUND' ? Array.from(a.faces) : []).toEqual(
      b.state === 'FOUND' ? Array.from(b.faces) : [1],
    );
    expect(Array.from(region.faceBits)).toEqual(before);
  });

  it('is STALE for another revision, another part, another mesh object, or after clearing', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticGrounding(source, 'part', mesh, 1, new Map([['wheels', regionOf(faces, 200)]]));
    expect(groundedFacesFor({ ...source, revision: 4 }, 'part', mesh, 'wheels').state).toBe(
      'STALE',
    );
    expect(groundedFacesFor(source, 'other', mesh, 'wheels').state).toBe('STALE');
    expect(groundedFacesFor(source, 'part', { ...mesh }, 'wheels').state).toBe('STALE');
    clearSemanticGrounding();
    expect(groundedFacesFor(source, 'part', mesh, 'wheels').state).toBe('STALE');
  });

  it('says NOT_GROUNDED for a part the analysis never tied to faces, and invents nothing', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticGrounding(source, 'part', mesh, 1, new Map([['wheels', regionOf(faces, 200)]]));
    expect(groundedFacesFor(source, 'part', mesh, 'antenna').state).toBe('NOT_GROUNDED');
  });

  it('a new analysis replaces the previous one entirely: nothing accumulates', () => {
    const mesh = box([-1, -1, -1], [1, 1, 1]);
    registerSemanticGrounding(source, 'part', mesh, 1, new Map([['wheels', regionOf(faces, 200)]]));
    registerSemanticGrounding(source, 'part', mesh, 2, new Map([['cab', regionOf([7], 200)]]));
    expect(groundedFacesFor(source, 'part', mesh, 'wheels').state).toBe('NOT_GROUNDED');
    const cab = groundedFacesFor(source, 'part', mesh, 'cab');
    expect(cab.state === 'FOUND' ? Array.from(cab.faces) : []).toEqual([7]);
  });
});
