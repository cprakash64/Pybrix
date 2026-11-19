import { describe, expect, it } from 'vitest';
import {
  applyPartTransform,
  IDENTITY_PART_TRANSFORM,
  placeMesh,
  type PartTransform,
} from './document';
import { createIndexArray, createPositionArray, type CanonicalMesh } from './mesh';
import {
  classifyPlacement,
  placementLinearDeterminant,
  placementReversesOrientation,
} from './placement';

/*
 * Stage C03-D. A placement is applied to a mesh in ONE place, and whether it turns the mesh inside out is answered in ONE place.
 * The solid used here is a tetrahedron with three different edge lengths, wound outward, so a mirror is visible in both its
 * positions and its orientation; a cube is symmetric and would hide the very thing these tests are about.
 */
const CORNERS = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 20, 0],
  [0, 0, 30],
] as const;
const FACES = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
] as const;
function tetrahedron(): CanonicalMesh {
  const positions = createPositionArray(12);
  const indices = createIndexArray(12);
  positions.set(CORNERS.flat());
  indices.set(FACES.flat());
  return { positions, indices, metadata: {} };
}
/** Signed volume by the divergence theorem, over the mesh's own indices. */
function signedVolume(mesh: CanonicalMesh): number {
  let sum = 0;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const corner = (k: number): [number, number, number] => {
      const v = (mesh.indices[at + k] ?? 0) * 3;
      return [mesh.positions[v] ?? 0, mesh.positions[v + 1] ?? 0, mesh.positions[v + 2] ?? 0];
    };
    const [ax, ay, az] = corner(0);
    const [bx, by, bz] = corner(1);
    const [cx, cy, cz] = corner(2);
    sum += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return sum;
}
const T = (...values: number[]): PartTransform => values as unknown as PartTransform;

describe('the determinant and the orientation question', () => {
  it('reads the triple product of the three basis vectors', () => {
    expect(placementLinearDeterminant(T(1, 0, 0, 0, 1, 0, 0, 0, 1, 7, 8, 9))).toBe(1);
    expect(placementLinearDeterminant(T(2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0))).toBe(24);
    expect(placementLinearDeterminant(T(-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0))).toBe(-1);
  });
  it('says a placement reverses orientation exactly when the determinant is negative', () => {
    expect(placementReversesOrientation(T(-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0))).toBe(true);
    expect(placementReversesOrientation(T(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0))).toBe(false);
    // two mirrors are a rotation
    expect(placementReversesOrientation(T(-1, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0))).toBe(false);
  });
  it('is independent of whether a connector could be cut into the part', () => {
    const nonUniformMirror = T(-2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
    expect(classifyPlacement(nonUniformMirror).kind).toBe('UNSUPPORTED');
    expect(placementReversesOrientation(nonUniformMirror)).toBe(true);
  });
  it('reverses nothing for a collapsed or non-finite placement', () => {
    expect(placementReversesOrientation(T(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(false);
    expect(placementReversesOrientation(T(Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0))).toBe(
      false,
    );
  });
  it('agrees with the classifier on every similarity it classifies', () => {
    for (const t of [
      T(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0),
      T(-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0),
      T(0, 2, 0, -2, 0, 0, 0, 0, 2, 5, 5, 5),
      T(0, -2, 0, -2, 0, 0, 0, 0, 2, 5, 5, 5),
    ]) {
      const c = classifyPlacement(t);
      expect(c.kind === 'SIMILARITY' && c.mirrored).toBe(placementReversesOrientation(t));
    }
  });
});

describe('placeMesh', () => {
  it('returns the placed positions, narrowed once from Float64, in the source vertex order', () => {
    const transform = T(0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1, 1.5, -2.25, 3.125);
    const placed = placeMesh(tetrahedron(), transform);
    CORNERS.forEach((corner, index) => {
      const [x, y, z] = applyPartTransform(transform, corner[0], corner[1], corner[2]);
      expect([...placed.positions.slice(index * 3, index * 3 + 3)]).toEqual([
        Math.fround(x),
        Math.fround(y),
        Math.fround(z),
      ]);
    });
  });
  it('keeps the triangles as they were when the placement does not mirror', () => {
    const mesh = tetrahedron();
    const placed = placeMesh(mesh, T(2, 0, 0, 0, 2, 0, 0, 0, 2, 5, 6, 7));
    expect([...placed.indices]).toEqual([...mesh.indices]);
    expect(signedVolume(placed)).toBeCloseTo(8000, 3);
  });
  it('turns the triangles when the placement mirrors, so the solid still faces outward', () => {
    const mesh = tetrahedron();
    const placed = placeMesh(mesh, T(-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0));
    expect(signedVolume(placed)).toBeCloseTo(1000, 3);
    // the same mesh, with the positions mirrored but the corners NOT turned, is inside out: that is the defect this prevents
    const insideOut: CanonicalMesh = { ...placed, indices: mesh.indices };
    expect(signedVolume(insideOut)).toBeCloseTo(-1000, 3);
  });
  it('is exactly the identity for the identity placement, negative zero included', () => {
    const mesh = tetrahedron();
    const placed = placeMesh(mesh, IDENTITY_PART_TRANSFORM);
    expect([...placed.positions]).toEqual([...mesh.positions]);
    expect([...placed.indices]).toEqual([...mesh.indices]);
  });
  it('is a copy: it neither shares nor changes the source buffers, and carries the groups', () => {
    const mesh: CanonicalMesh = {
      ...tetrahedron(),
      groups: [
        { name: 'g', indexCount: 12 } as unknown as NonNullable<CanonicalMesh['groups']>[number],
      ],
    };
    const before = [...mesh.positions];
    const placed = placeMesh(mesh, T(-1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 3, 3));
    expect(placed.positions).not.toBe(mesh.positions);
    expect(placed.indices).not.toBe(mesh.indices);
    expect([...mesh.positions]).toEqual(before);
    expect(placed.groups).toBe(mesh.groups);
  });
});
