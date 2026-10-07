/**
 * REPAIR-CORE-02 — the deterministic, non-proprietary large-model fixture.
 *
 * A CLOSED CUBE whose six faces are each subdivided into an N × N grid of unit
 * quads (two triangles each, 12·N² triangles in all), on EXACT integer
 * coordinates so every shared edge welds without any tolerance, wound
 * consistently outward. Then, to match the shape of the model that motivated
 * the stage (6 simple openings, 7 complex boundaries):
 *
 *   - `simple` openings: one quad removed from a face — a 4-point planar rim,
 *     far from every other opening;
 *   - `branched` boundaries: two quads removed that touch only at a corner — a
 *     rim that meets itself at one point, which the scan must classify as
 *     branched and admission must never fill.
 *
 *   - `extraPiece` (REPAIR-CORE-06B): a small closed tetrahedron far from the cube. It is a second
 *     connected component, which Pybrix reports and never repairs, so a model that REPAIR fully
 *     handles still has one detected issue left afterwards — a stable "partial" fixture now that
 *     the local repair separates and fills the branched boundaries.
 *
 * Used by the Chromium qualification (`boundary-fill.qualify.mjs`) and mirrored
 * in `e2e/repair-core.spec.ts`. No user model is needed anywhere.
 */

/** Grid size for a target triangle count. */
export function gridForTriangles(target) {
  return Math.max(8, Math.round(Math.sqrt(target / 12)));
}

/**
 * Builds the binary STL. Returns `{ bytes, triangles, simple, branched }`.
 */
export function holedCubeStl(n, options = {}) {
  const simple = options.simple ?? 6;
  const branched = options.branched ?? 7;

  // Openings are chosen per face on a coarse lattice so they are far apart.
  const removed = new Set();
  const key = (face, i, j) => `${face}:${i}:${j}`;
  const spots = [];
  const step = Math.max(4, Math.floor(n / 4));
  for (let face = 0; face < 6; face += 1) {
    for (let a = step; a < n - 2; a += step) {
      for (let b = step; b < n - 2; b += step) spots.push([face, a, b]);
    }
  }
  let cursor = 0;
  for (let k = 0; k < simple && cursor < spots.length; k += 1, cursor += 1) {
    const [face, i, j] = spots[cursor];
    removed.add(key(face, i, j));
  }
  for (let k = 0; k < branched && cursor < spots.length; k += 1, cursor += 1) {
    const [face, i, j] = spots[cursor];
    removed.add(key(face, i, j));
    removed.add(key(face, i + 1, j + 1));
  }

  // Each face: origin + u·U + v·V, with normal U × V pointing outward.
  const faces = [
    { o: [0, 0, n], U: [1, 0, 0], V: [0, 1, 0] }, // +Z
    { o: [0, n, 0], U: [1, 0, 0], V: [0, -1, 0] }, // -Z (origin at y=n so U×V = -Z)
    { o: [n, 0, 0], U: [0, 1, 0], V: [0, 0, 1] }, // +X
    { o: [0, 0, 0], U: [0, 0, 1], V: [0, 1, 0] }, // -X
    { o: [0, n, 0], U: [0, 0, 1], V: [1, 0, 0] }, // +Y
    { o: [0, 0, 0], U: [1, 0, 0], V: [0, 0, 1] }, // -Y
  ];

  const piece = options.extraPiece === true;
  let triangles = 12 * n * n - removed.size * 2 + (piece ? 4 : 0);
  const bytes = Buffer.alloc(84 + triangles * 50);
  bytes.write('pybrix repair-core-02 holed cube', 0, 'ascii');
  bytes.writeUInt32LE(triangles, 80);
  let offset = 84;
  const point = (f, u, v) => [
    f.o[0] + u * f.U[0] + v * f.V[0],
    f.o[1] + u * f.U[1] + v * f.V[1],
    f.o[2] + u * f.U[2] + v * f.V[2],
  ];
  const write = (a, b, c) => {
    offset += 12; // zero normal: advisory, ignored by the engine
    for (const p of [a, b, c]) {
      bytes.writeFloatLE(p[0], offset);
      bytes.writeFloatLE(p[1], offset + 4);
      bytes.writeFloatLE(p[2], offset + 8);
      offset += 12;
    }
    offset += 2;
  };
  for (let face = 0; face < 6; face += 1) {
    const f = faces[face];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (removed.has(key(face, i, j))) continue;
        const a = point(f, i, j);
        const b = point(f, i + 1, j);
        const c = point(f, i + 1, j + 1);
        const d = point(f, i, j + 1);
        write(a, b, c);
        write(a, c, d);
      }
    }
  }
  if (piece) {
    // A closed tetrahedron, wound outward, well away from the cube (which spans 0..n).
    const o = n * 3;
    const a = [o, 0, 0];
    const b = [o + 4, 0, 0];
    const c = [o, 4, 0];
    const d = [o, 0, 4];
    write(a, c, b);
    write(a, b, d);
    write(b, c, d);
    write(a, d, c);
  }
  if (offset !== bytes.length) throw new Error('holed cube: size mismatch');
  return { bytes, triangles, simple, branched };
}
