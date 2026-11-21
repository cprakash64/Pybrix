import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { exactStoredCoordinateIdentity, tableCapacityFor } from '@cadfixer/mesh-topology';

/**
 * THE KERNEL'S INDEXED INPUT, recovered from EXACT stored coordinates and nothing else.
 *
 * Manifold requires an indexed closed surface, and an STL part is triangle soup: a distinct index per
 * corner. Two corners are the same vertex here if and only if all three coordinates are equal as
 * stored (`-0` and `+0` equal): no epsilon, no welding, nothing moved. Vertices are numbered by their
 * FIRST REFERENCE in the index stream, and each keeps the exact coordinates of that first reference.
 *
 * WHY TYPED ARRAYS. This used to key a JavaScript `Map` by the string `"x,y,z"`: at two million
 * triangles that is six million strings and a million-entry map, 2.1 s and 185 MB of heap for ONE
 * operand of ONE Boolean, collected only after the kernel had already been handed its input. It is now
 * an open-addressed table of int32 slots over the same exact comparison (the hash and the `-0`
 * normalisation are `mesh-topology`'s own), four bytes per slot and no per-vertex object. The numbering
 * and every coordinate are what the `Map` produced; a test holds the two equal.
 *
 * PRECONDITION: finite coordinates and in-range indices. The only caller reaches it through
 * `runValidatedBoolean`, which asserts the mesh structure first, so neither can fail here.
 */
export function indexExactCoordinates(mesh: CanonicalMesh): {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
} {
  const corners = mesh.indices.length;
  const source = mesh.positions;
  const identity = exactStoredCoordinateIdentity;
  const mask = tableCapacityFor(corners) - 1;
  // Slot -> new vertex id, or -1.
  const table = new Int32Array(mask + 1).fill(-1);
  // New vertex id -> the SOURCE vertex whose coordinates define it (its first reference).
  const origin = new Int32Array(corners);
  const indices = new Uint32Array(corners);
  let unique = 0;
  for (let at = 0; at < corners; at += 1) {
    const base = (mesh.indices[at] ?? 0) * 3;
    const x = identity.normalize(source[base] ?? Number.NaN);
    const y = identity.normalize(source[base + 1] ?? Number.NaN);
    const z = identity.normalize(source[base + 2] ?? Number.NaN);
    let slot = identity.hash(x, y, z) & mask;
    for (;;) {
      const found = table[slot] ?? -1;
      if (found === -1) {
        table[slot] = unique;
        origin[unique] = base / 3;
        indices[at] = unique;
        unique += 1;
        break;
      }
      const at3 = (origin[found] ?? 0) * 3;
      if (
        identity.normalize(source[at3] ?? Number.NaN) === x &&
        identity.normalize(source[at3 + 1] ?? Number.NaN) === y &&
        identity.normalize(source[at3 + 2] ?? Number.NaN) === z
      ) {
        indices[at] = found;
        break;
      }
      slot = (slot + 1) & mask;
    }
  }
  const positions = new Float64Array(unique * 3);
  for (let id = 0; id < unique; id += 1) {
    const base = (origin[id] ?? 0) * 3;
    positions[id * 3] = source[base] ?? Number.NaN;
    positions[id * 3 + 1] = source[base + 1] ?? Number.NaN;
    positions[id * 3 + 2] = source[base + 2] ?? Number.NaN;
  }
  return { positions, indices };
}
