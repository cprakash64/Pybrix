import { describe, expect, it } from 'vitest';
import { growEditRegion } from './edit-geometry';
import { exactVertexKey } from './exact-vertex-key';
import { createIndexArray, createPositionArray, type CanonicalMesh } from './mesh';

function mesh(points: readonly number[], indices: readonly number[]): CanonicalMesh {
  const positions = createPositionArray(points.length);
  const triangles = createIndexArray(indices.length);
  positions.set(points);
  triangles.set(indices);
  return { positions, indices: triangles, metadata: {} };
}

describe('exact stored-coordinate vertex identity (TEXTURE-FIX-01)', () => {
  it('is the same for records with the same coordinates, whatever their indices', () => {
    const m = mesh([1, 2, 3, 9, 9, 9, 1, 2, 3], [0, 1, 2]);
    expect(exactVertexKey(m.positions, 0)).toBe(exactVertexKey(m.positions, 2));
    expect(exactVertexKey(m.positions, 0)).not.toBe(exactVertexKey(m.positions, 1));
  });

  it('reads -0 and +0 as one coordinate, in every axis', () => {
    const m = mesh([0, 0, 0, -0, -0, -0, 0, -0, 0], [0, 1, 2]);
    expect(exactVertexKey(m.positions, 1)).toBe(exactVertexKey(m.positions, 0));
    expect(exactVertexKey(m.positions, 2)).toBe(exactVertexKey(m.positions, 0));
  });

  it('tells apart two Float32 values that differ in the last bit, and never merges near points', () => {
    const next = Math.fround(1 + 2 ** -23);
    const m = mesh([1, 0, 0, next, 0, 0, 1, 0, 1e-30], [0, 1, 2]);
    expect(next).not.toBe(1);
    expect(exactVertexKey(m.positions, 1)).not.toBe(exactVertexKey(m.positions, 0));
    expect(exactVertexKey(m.positions, 2)).not.toBe(exactVertexKey(m.positions, 0));
  });

  it('says what region growth says: two soup triangles meeting along an edge share it', () => {
    // Two triangles of one square, no shared vertex index. Region growth joins them by coordinates.
    const soup = mesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 3, 4, 5]);
    expect(growEditRegion(soup, 0, { maxNormalAngleRadians: 0.01, maxTriangles: 2 })).toEqual([
      0, 1,
    ]);
    // Corner 2 of the first triangle and corner 1 of the second are the same point, and so are
    // the first triangle's corner 0 and the second's corner 0.
    expect(exactVertexKey(soup.positions, 2)).toBe(exactVertexKey(soup.positions, 4));
    expect(exactVertexKey(soup.positions, 0)).toBe(exactVertexKey(soup.positions, 3));
    expect(exactVertexKey(soup.positions, 1)).not.toBe(exactVertexKey(soup.positions, 5));
  });
});
