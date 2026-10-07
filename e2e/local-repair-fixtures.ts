import { binaryStlFrom, type Point } from './stl-fixtures';

/**
 * Generated, bounded STL fixtures for the local pinch repair — REPAIR-CORE-06B.
 *
 * Triangle soup that shares EXACT corner coordinates, which is how an STL says two surfaces
 * meet at a point: the pinched vertex is recovered from stored coordinates alone. Nothing here
 * is committed geometry from a real model.
 */
type Tri = readonly [Point, Point, Point];

/** `count` tetrahedron pairs, each pair sharing one corner: one pinched vertex each. */
export function pinchedPairsStl(count: number): Buffer {
  const base: Point[] = [
    [0, 0, 0],
    [1, 0, 1],
    [-0.5, 0.9, 1],
    [-0.5, -0.9, 1.1],
    [-1, 0.1, -1],
    [0.5, -0.9, -1.2],
    [0.45, 0.95, -1.1],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [0, 1, 3],
    [1, 2, 3],
    [0, 4, 5],
    [0, 5, 6],
    [0, 6, 4],
    [4, 6, 5],
  ] as const;
  const triangles: Tri[] = [];
  for (let i = 0; i < count; i += 1) {
    const dx = (i % 20) * 6;
    const dy = Math.floor(i / 20) * 6;
    const at = (index: number): Point => {
      const p = base[index] ?? [0, 0, 0];
      return [p[0] + dx, p[1] + dy, p[2]];
    };
    for (const [a, b, c] of faces) triangles.push([at(a), at(b), at(c)]);
  }
  return binaryStlFrom(triangles);
}

/** Two closed cones of `n` faces meeting at one point; `reversed` face indices are flipped. */
export function bowtieStl(
  n: number,
  heightA: number,
  heightB: number,
  reversed: readonly number[],
  extra: readonly Tri[] = [],
): Buffer {
  const apex: Point = [0, 0, 0];
  const ring = (height: number, phase: number): Point[] =>
    Array.from({ length: n }, (_, k) => {
      const angle = phase + (2 * Math.PI * k) / n;
      return [Math.cos(angle), Math.sin(angle), height] as const;
    });
  const triangles: Tri[] = [];
  for (const [height, phase] of [
    [heightA, 0],
    [heightB, 0.3],
  ] as const) {
    const points = ring(height, phase);
    for (let k = 0; k < n; k += 1) {
      const a = points[k] ?? apex;
      const b = points[(k + 1) % n] ?? apex;
      triangles.push(height >= 0 ? [apex, a, b] : [apex, b, a]);
    }
  }
  const flipped = triangles.map((t, index): Tri =>
    reversed.includes(index) ? [t[0], t[2], t[1]] : t,
  );
  return binaryStlFrom([...flipped, ...extra]);
}

/** A pinch that needs the residual phase: one reversed face in one cone. */
export const residualPinchStl = (): Buffer => bowtieStl(6, 0.05, -0.05, [1]);

/** A pinch whose fan is not one consistent chain: the vertex is refused, not repaired. */
export const refusedPinchStl = (): Buffer => bowtieStl(4, 0.5, -0.5, [1, 4]);
