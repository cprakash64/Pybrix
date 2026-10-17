import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { requiredValue } from './semantic-invariant';
/** Source-only membership. Straddling source triangles are deliberately REFUSED: fractional face
 * area must not be approximated by a centroid. Future arbitrary plane evaluation needs clipping. */
export function planeSourceFaces(
  mesh: CanonicalMesh,
  plane: { normal: readonly number[]; origin: readonly number[] } | null,
): number[] {
  if (
    plane?.normal.length !== 3 ||
    plane.origin.length !== 3 ||
    ![...plane.normal, ...plane.origin].every(Number.isFinite) ||
    Math.hypot(...plane.normal) === 0
  )
    throw Error('INVALID_PLANE');
  const normal = plane.normal,
    origin = plane.origin,
    eps = 1e-7 * Math.hypot(...normal),
    selected: number[] = [];
  for (let face = 0; face < mesh.indices.length / 3; face++) {
    const c = [0, 1, 2].map((k) =>
      [0, 1, 2].map((a) =>
        requiredValue(mesh.positions[requiredValue(mesh.indices[face * 3 + k]) * 3 + a]),
      ),
    );
    const d = c.map((p) =>
      p.reduce((n, v, a) => n + (v - requiredValue(origin[a])) * requiredValue(normal[a]), 0),
    );
    if (Math.min(...d) < -eps && Math.max(...d) > eps)
      throw Error('STRADDLING_SOURCE_FACE_REQUIRES_CLIPPING');
    if (d.every((v) => Math.abs(v) <= eps)) {
      const a = requiredValue(c[1]).map((v, i) => v - requiredValue(requiredValue(c[0])[i])),
        b = requiredValue(c[2]).map((v, i) => v - requiredValue(requiredValue(c[0])[i]));
      const n = [
        requiredValue(a[1]) * requiredValue(b[2]) - requiredValue(a[2]) * requiredValue(b[1]),
        requiredValue(a[2]) * requiredValue(b[0]) - requiredValue(a[0]) * requiredValue(b[2]),
        requiredValue(a[0]) * requiredValue(b[1]) - requiredValue(a[1]) * requiredValue(b[0]),
      ];
      if (n.reduce((s, v, i) => s + v * requiredValue(normal[i]), 0) < 0) selected.push(face);
    } else if (Math.max(...d) > eps) selected.push(face);
  }
  return selected;
}
