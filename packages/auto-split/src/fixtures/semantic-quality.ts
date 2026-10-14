/** Development-only fixtures; never a provider input or production import. */
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { createPositionArray, createIndexArray } from '@cadfixer/mesh-core';
import { box, concatMeshes, wheel, voxelUnion } from './solids';
export const SEMANTIC_QUALITY_DEVELOPMENT_MARKER = 'SEMANTIC_QUALITY_02_DEVELOPMENT_ONLY';
export type QualityDevelopmentCase =
  | 'legs'
  | 'wheels'
  | 'handles'
  | 'near-match'
  | 'asymmetric'
  | 'missing'
  | 'different-size'
  | 'overlap'
  | 'decorative'
  | 'retriangulated';
function torus(x: number, y: number, z: number): CanonicalMesh {
  const n = 20,
    m = 4,
    positions = createPositionArray(n * m * 3),
    indices = createIndexArray(n * m * 6);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const a = (i * 2 * Math.PI) / n,
        b = (j * 2 * Math.PI) / m,
        r = 1 + 0.2 * Math.cos(b),
        k = (i * m + j) * 3;
      positions.set([x + r * Math.cos(a), y + 0.2 * Math.sin(b), z + r * Math.sin(a)], k);
      const u = i * m + j,
        v = ((i + 1) % n) * m + j,
        w = ((i + 1) % n) * m + ((j + 1) % m),
        t = i * m + ((j + 1) % m);
      indices.set([u, w, v, u, t, w], (i * m + j) * 6);
    }
  return { positions, indices, metadata: {} };
}
function subdivide(mesh: CanonicalMesh): CanonicalMesh {
  const out: number[] = [],
    indices: number[] = [];
  for (let f = 0; f < mesh.indices.length; f += 3) {
    const points = [0, 1, 2].map((k) =>
      [0, 1, 2].map((a) => mesh.positions[(mesh.indices[f + k] ?? 0) * 3 + a] ?? 0),
    );
    const a = points[0] ?? [],
      b = points[1] ?? [],
      c = points[2] ?? [],
      ab = a.map((v, i) => (v + (b[i] ?? 0)) / 2),
      bc = b.map((v, i) => (v + (c[i] ?? 0)) / 2),
      ca = c.map((v, i) => (v + (a[i] ?? 0)) / 2);
    for (const tri of [
      [a, ab, ca],
      [ab, b, bc],
      [ca, bc, c],
      [ab, bc, ca],
    ])
      for (const p of tri) {
        indices.push(out.length / 3);
        out.push(...p);
      }
  }
  const positions = createPositionArray(out.length),
    index = createIndexArray(indices.length);
  positions.set(out);
  index.set(indices);
  return { positions, indices: index, metadata: {} };
}
export function qualityDevelopmentFixture(kind: QualityDevelopmentCase): {
  mesh: CanonicalMesh;
  familyFirstFaces: readonly number[];
  count: number;
} {
  const centers = [
    [-3, -2],
    [-3, 2],
    [3, -2],
    [3, 2],
  ];
  let family = centers.map(([x = 0, z = 0]) =>
    box([x - 0.3, -3, z - 0.3], [x + 0.3, -0.3, z + 0.3]),
  );
  let body = box([-2.3, 0.3, -2.6], [2.3, 0.7, 2.6]);
  if (kind === 'wheels' || kind === 'decorative') {
    family = [
      [-3, -2],
      [-3, 2],
      [3, -2],
      [3, 2],
    ].map(([x = 0, y = 0], i) =>
      kind === 'decorative' && i >= 2 ? torus(x, y, 0) : wheel(x, 0, 1.2, y - 0.2, y + 0.2, 20),
    );
    body = box([-1.5, -1.2, 1.6], [1.5, 1.2, 2.2]);
  }
  if (kind === 'handles') {
    family = [-5, 0, 5].map((x) =>
      voxelUnion([
        { lo: [x - 1, 0, 0], hi: [x, 1, 3] },
        { lo: [x + 1, 0, 0], hi: [x + 2, 1, 3] },
        { lo: [x - 1, 0, 2], hi: [x + 2, 1, 3] },
      ]),
    );
    body = box([-7, 3, -1], [7, 3.5, 3]);
  }
  if (kind === 'near-match') family[3] = box([2.4, -3, 1.7], [3.6, -0.3, 2.3]);
  if (kind === 'different-size') family[3] = box([2.64, -3.27, 1.64], [3.36, -0.03, 2.36]);
  if (kind === 'asymmetric') family[3] = box([3.7, -3, 1.1], [4.3, -0.3, 1.7]);
  if (kind === 'overlap') family[3] = box([-3.25, -3, -2.3], [-2.65, -0.3, -1.7]);
  if (kind === 'missing') family = family.slice(0, 3);
  if (kind === 'retriangulated' && family[3]) family[3] = subdivide(family[3]);
  let cursor = body.indices.length / 3;
  const familyFirstFaces = family.map((m) => {
    const start = cursor;
    cursor += m.indices.length / 3;
    return start;
  });
  const mesh = concatMeshes([body, ...family]);
  if (!['wheels', 'decorative', 'handles'].includes(kind)) {
    const angle = 0.4,
      c = Math.cos(angle),
      s = Math.sin(angle);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0,
        z = mesh.positions[i + 2] ?? 0;
      mesh.positions[i] = c * x + s * z;
      mesh.positions[i + 2] = -s * x + c * z;
    }
  }
  return {
    mesh,
    familyFirstFaces,
    count: kind === 'handles' ? 3 : 4,
  };
}
