import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { required } from '../required';

/**
 * TEST SOLIDS: closed, manifold, outward-wound, built in code so no file is needed and no licence is
 * involved. A mesh is TRIANGLE SOUP, as an STL is: three corners per face, indices 0, 1, 2, ...
 */
export type Triangle = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

export function meshOf(triangles: readonly Triangle[]): CanonicalMesh {
  const positions = createPositionArray(triangles.length * 9);
  const indices = createIndexArray(triangles.length * 3);
  triangles.forEach((t, i) => {
    t.forEach((v, k) => {
      positions.set(v, i * 9 + k * 3);
      indices[i * 3 + k] = i * 3 + k;
    });
  });
  return { positions, indices, metadata: {} };
}

export function concatMeshes(parts: readonly CanonicalMesh[]): CanonicalMesh {
  const triangles: Triangle[] = [];
  for (const m of parts)
    for (let f = 0; f < m.indices.length / 3; f += 1) {
      const corner = (k: number): [number, number, number] => {
        const v = (m.indices[f * 3 + k] ?? 0) * 3;
        return [m.positions[v] ?? 0, m.positions[v + 1] ?? 0, m.positions[v + 2] ?? 0];
      };
      triangles.push([corner(0), corner(1), corner(2)]);
    }
  return meshOf(triangles);
}

/** An axis-aligned box as 12 outward triangles. */
export function box(
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
): CanonicalMesh {
  const [x0, y0, z0] = lo;
  const [x1, y1, z1] = hi;
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const quads: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ][] = [
    [v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)], // -Z
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)], // +Z
    [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)], // -Y
    [v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)], // +Y
    [v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)], // -X
    [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)], // +X
  ];
  return meshOf(
    quads.flatMap(([a, b, c, d]): Triangle[] => [
      [a, b, c],
      [a, c, d],
    ]),
  );
}

/** A closed prism with `sides` sides about the Y axis (a wheel): radius `r`, from y0 to y1, centred at (cx, cz). */
export function wheel(
  cx: number,
  cz: number,
  r: number,
  y0: number,
  y1: number,
  sides = 16,
): CanonicalMesh {
  const ring = (y: number): [number, number, number][] =>
    Array.from({ length: sides }, (_, i): [number, number, number] => {
      const a = (2 * Math.PI * i) / sides;
      return [cx + r * Math.cos(a), y, cz + r * Math.sin(a)];
    });
  const near = ring(y0);
  const far = ring(y1);
  const triangles: Triangle[] = [];
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    const a = required(near[i], 'near corner');
    const b = required(near[j], 'near corner');
    const c = required(far[j], 'far corner');
    const d = required(far[i], 'far corner');
    // Side quad, outward.
    triangles.push([a, d, c], [a, c, b]);
    // Caps: the y0 cap faces -Y, the y1 cap faces +Y.
    triangles.push([[cx, y0, cz], a, b]);
    triangles.push([[cx, y1, cz], c, d]);
  }
  return meshOf(triangles);
}

/**
 * A single closed shell from the UNION of axis-aligned boxes on an integer grid: every exposed unit
 * face becomes two triangles. Blocky, but one manifold surface, which is what a figure that fuses its
 * head, arms and legs into one body needs. Boxes must overlap by faces, never only along an edge.
 */
export function voxelUnion(
  boxes: readonly {
    lo: readonly [number, number, number];
    hi: readonly [number, number, number];
  }[],
  cell = 1,
): CanonicalMesh {
  const occupied = new Set<string>();
  const key = (x: number, y: number, z: number): string => `${String(x)},${String(y)},${String(z)}`;
  for (const b of boxes)
    for (let x = b.lo[0]; x < b.hi[0]; x += 1)
      for (let y = b.lo[1]; y < b.hi[1]; y += 1)
        for (let z = b.lo[2]; z < b.hi[2]; z += 1) occupied.add(key(x, y, z));
  const triangles: Triangle[] = [];
  const p = (x: number, y: number, z: number): [number, number, number] => [
    x * cell,
    y * cell,
    z * cell,
  ];
  for (const k of occupied) {
    const [x, y, z] = k.split(',').map(Number) as [number, number, number];
    const open = (dx: number, dy: number, dz: number): boolean =>
      !occupied.has(key(x + dx, y + dy, z + dz));
    const quad = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
    ): void => {
      triangles.push([a, b, c], [a, c, d]);
    };
    if (open(0, 0, -1)) quad(p(x, y, z), p(x, y + 1, z), p(x + 1, y + 1, z), p(x + 1, y, z));
    if (open(0, 0, 1))
      quad(p(x, y, z + 1), p(x + 1, y, z + 1), p(x + 1, y + 1, z + 1), p(x, y + 1, z + 1));
    if (open(0, -1, 0)) quad(p(x, y, z), p(x + 1, y, z), p(x + 1, y, z + 1), p(x, y, z + 1));
    if (open(0, 1, 0))
      quad(p(x, y + 1, z), p(x, y + 1, z + 1), p(x + 1, y + 1, z + 1), p(x + 1, y + 1, z));
    if (open(-1, 0, 0)) quad(p(x, y, z), p(x, y, z + 1), p(x, y + 1, z + 1), p(x, y + 1, z));
    if (open(1, 0, 0))
      quad(p(x + 1, y, z), p(x + 1, y + 1, z), p(x + 1, y + 1, z + 1), p(x + 1, y, z + 1));
  }
  // A stable order, so a fixture is the same bytes on every run.
  triangles.sort(
    (a, b) =>
      a[0][0] - b[0][0] ||
      a[0][1] - b[0][1] ||
      a[0][2] - b[0][2] ||
      a[1][0] - b[1][0] ||
      a[1][1] - b[1][1] ||
      a[1][2] - b[1][2],
  );
  return meshOf(triangles);
}

/** Binary STL bytes: an 80-byte header, the count, and 50 bytes per facet. */
export function toBinaryStl(mesh: CanonicalMesh): Uint8Array {
  const faces = Math.floor(mesh.indices.length / 3);
  const bytes = new Uint8Array(84 + faces * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, faces, true);
  for (let f = 0; f < faces; f += 1) {
    const c = (k: number): [number, number, number] => {
      const v = (mesh.indices[f * 3 + k] ?? 0) * 3;
      return [mesh.positions[v] ?? 0, mesh.positions[v + 1] ?? 0, mesh.positions[v + 2] ?? 0];
    };
    const [a, b, d] = [c(0), c(1), c(2)];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...n) || 1;
    const at = 84 + f * 50;
    [n[0] / l, n[1] / l, n[2] / l, ...a, ...b, ...d].forEach((value, i) => {
      view.setFloat32(at + i * 4, value, true);
    });
  }
  return bytes;
}
