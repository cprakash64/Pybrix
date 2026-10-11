import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { tetrahedron } from '@cadfixer/mesh-topology/fixtures';
import { carMultipart, denseTruck, humanFigure, truckFused } from '@cadfixer/auto-split/fixtures';
import { indexExactCoordinates } from '../exact-index';

/**
 * The kernel's indexed input, held to the `Map<string, number>` it replaced. The reference below is
 * that code, verbatim: a vertex per distinct `"x,y,z"` key in order of first reference, carrying the
 * first reference's own coordinates.
 */
function reference(mesh: CanonicalMesh): { positions: Float64Array; indices: Uint32Array } {
  const map = new Map<string, number>(),
    out: number[] = [],
    indices = new Uint32Array(mesh.indices.length);
  for (let at = 0; at < mesh.indices.length; at++) {
    const from = (mesh.indices[at] ?? 0) * 3,
      x = mesh.positions[from] ?? NaN,
      y = mesh.positions[from + 1] ?? NaN,
      z = mesh.positions[from + 2] ?? NaN;
    const key = `${String(x)},${String(y)},${String(z)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(x, y, z);
    }
    indices[at] = id;
  }
  return { positions: Float64Array.from(out), indices };
}

/** Bit-for-bit, so a `-0` kept where `+0` was written is a failure, not a tie. */
function bits(a: ArrayBufferView): string {
  return Buffer.from(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength).toString('base64');
}
function expectSame(mesh: CanonicalMesh): void {
  const live = indexExactCoordinates(mesh);
  const old = reference(mesh);
  expect(live.positions.length).toBe(old.positions.length);
  expect(bits(live.positions)).toBe(bits(old.positions));
  expect(bits(live.indices)).toBe(bits(old.indices));
}

function mesh(positions: number[], indices: number[]): CanonicalMesh {
  const p = createPositionArray(positions.length);
  p.set(positions);
  const i = createIndexArray(indices.length);
  i.set(indices);
  return { positions: p, indices: i, metadata: {} };
}

describe('exact-coordinate indexing equals the Map it replaced', () => {
  it('on a tetrahedron, a soup car, a figure and a fused truck', () => {
    for (const m of [tetrahedron(), carMultipart().mesh, humanFigure().mesh, truckFused().mesh])
      expectSame(m);
  });

  it('on a 100,000-triangle truck of shared edges, with the same unique count', () => {
    const { mesh: dense } = denseTruck(100_000);
    expectSame(dense);
    // Soup in, shared vertices out: far fewer vertices than corners.
    expect(indexExactCoordinates(dense).positions.length / 3).toBeLessThan(
      dense.indices.length / 2,
    );
  });

  it('on an INDEXED mesh with a duplicate coordinate and an unreferenced vertex', () => {
    // Vertices 0 and 3 are the same point; vertex 4 is referenced by nothing.
    const m = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 9, 9, 9], [0, 1, 2, 3, 2, 1]);
    expectSame(m);
    const live = indexExactCoordinates(m);
    // Three distinct points are referenced; the unreferenced one is dropped, the duplicate merged.
    expect(live.positions.length / 3).toBe(3);
    expect(Array.from(live.indices)).toEqual([0, 1, 2, 0, 2, 1]);
  });

  it('numbers by first reference in the INDEX stream, not by position order', () => {
    // The index stream visits vertex 2 first: it is new vertex 0.
    const m = mesh([5, 5, 5, 6, 6, 6, 1, 2, 3], [2, 0, 1]);
    expectSame(m);
    expect(Array.from(indexExactCoordinates(m).positions.slice(0, 3))).toEqual([1, 2, 3]);
  });

  it('treats -0 and +0 as one coordinate and keeps the first reference’s own sign', () => {
    const m = mesh([-0, 1, 1, 0, 1, 1, 2, 2, 2], [0, 1, 2]);
    expectSame(m);
    const live = indexExactCoordinates(m);
    expect(live.positions.length / 3).toBe(2);
    expect(Object.is(live.positions[0], -0)).toBe(true);
    expect(Array.from(live.indices)).toEqual([0, 0, 1]);
  });

  it('keeps two coordinates one ULP apart as two vertices: nothing is welded', () => {
    const next = Math.fround(1 + 2 ** -23);
    const m = mesh([1, 0, 0, next, 0, 0, 0, 1, 0], [0, 1, 2]);
    expectSame(m);
    expect(indexExactCoordinates(m).positions.length / 3).toBe(3);
  });

  it('on adversarial lattices where a hash would collide', () => {
    // Axis-aligned grids and repeated offsets: the structured data CAD meshes are made of.
    const positions: number[] = [];
    const indices: number[] = [];
    let n = 0;
    for (let x = 0; x < 40; x += 1)
      for (let y = 0; y < 40; y += 1)
        for (const z of [0, 0.5, 1, 4096, 1e-7]) {
          positions.push(x, y, z);
          indices.push(n);
          n += 1;
        }
    while (indices.length % 3 !== 0) indices.pop();
    expectSame(mesh(positions, indices));
  });

  it('on an empty mesh', () => {
    expectSame(mesh([], []));
  });
});
