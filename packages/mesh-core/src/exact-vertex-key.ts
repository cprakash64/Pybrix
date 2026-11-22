import type { PositionArray } from './mesh';

/**
 * THE EXACT STORED-COORDINATE IDENTITY OF ONE VERTEX, as a string.
 *
 * Two vertex records are the same point here if and only if all three coordinates are equal as
 * stored (`-0` and `+0` equal, because a number renders as `0` either way). No tolerance, no
 * welding, nothing moved: this is ADR 0009's connectivity, the same one `growEditRegion` uses to
 * decide which triangles share an edge. Anything that asks "is this edge shared?" about a mesh
 * that may be STL triangle soup must ask it with this identity and never with vertex indices:
 * an STL import gives every corner its own index, so index pairs say no two triangles touch.
 *
 * PRECONDITION: finite coordinates and an in-range vertex (the mesh structure has been
 * asserted). An out-of-range vertex reads as `NaN`, which keys to `NaN,NaN,NaN`.
 */
export function exactVertexKey(positions: PositionArray, vertex: number): string {
  const at = vertex * 3;
  return `${String(positions[at] ?? Number.NaN)},${String(positions[at + 1] ?? Number.NaN)},${String(positions[at + 2] ?? Number.NaN)}`;
}
