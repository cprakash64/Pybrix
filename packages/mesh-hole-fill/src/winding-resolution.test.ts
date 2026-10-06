import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { SurgeryMesh } from './surgery-mesh';
import { resolveComponentWinding } from './winding-resolution';

/**
 * REPAIR-CORE-05E — component-relative winding resolution. What it fixes, and what it must refuse.
 */
type F = readonly [number, number, number];

function strip(width: number, flipped: readonly number[] = [], twist = false): CanonicalMesh {
  // A (width x 1) grid of quads, two triangles each, consistently wound; some faces then reversed.
  const points: [number, number, number][] = [];
  for (let i = 0; i <= width; i += 1) points.push([i, 0, 0], [i, 1, 0]);
  const faces: F[] = [];
  for (let i = 0; i < width; i += 1) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    faces.push([a, c, d], [a, d, b]);
  }
  if (twist) {
    // A half twist: identify the last column with the first, swapped (last bottom = first top,
    // last top = first bottom). The shared edge is then traversed the same way by both faces.
    const last = width * 2;
    for (let i = 0; i < faces.length; i += 1) {
      const t = faces[i];
      if (t === undefined) continue;
      faces[i] = t.map((v) => (v === last ? 1 : v === last + 1 ? 0 : v)) as unknown as F;
    }
  }
  flipped.forEach((f) => {
    const t = faces[f];
    if (t !== undefined) faces[f] = [t[0], t[2], t[1]];
  });
  const positions = createPositionArray(points.length * 3);
  points.forEach((p, i) => {
    positions.set(p, i * 3);
  });
  const indices = createIndexArray(faces.length * 3);
  faces.forEach((f, i) => {
    indices.set(f, i * 3);
  });
  return { positions, indices, metadata: { sourceFormat: '3mf' } };
}

function conflicts(mesh: SurgeryMesh): number {
  const seen = new Map<string, boolean[]>();
  for (let f = 0; f < mesh.faceCount; f += 1) {
    if (mesh.alive[f] !== 1) continue;
    const [a, b, c] = mesh.corners(f);
    for (const [u, w] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = u < w ? `${String(u)},${String(w)}` : `${String(w)},${String(u)}`;
      const list = seen.get(key) ?? [];
      list.push(u < w);
      seen.set(key, list);
    }
  }
  let n = 0;
  for (const list of seen.values()) if (list.length === 2 && list[0] === list[1]) n += 1;
  return n;
}

describe('resolveComponentWinding', () => {
  it('reverses exactly the minority patch, after which no edge conflicts', () => {
    const mesh = SurgeryMesh.from(strip(10, [7, 8]));
    expect(conflicts(mesh)).toBeGreaterThan(0);
    const r = resolveComponentWinding(mesh, 0);
    expect(r.outcome).toBe('resolved');
    expect(r.flips).toEqual([7, 8]);
    expect(r.seedFace).toBe(0);
    for (const f of r.flips) mesh.flipFace(f);
    expect(conflicts(mesh)).toBe(0);
  });

  it('is a no-op on a consistently wound component', () => {
    const r = resolveComponentWinding(SurgeryMesh.from(strip(6)), 3);
    expect(r.outcome).toBe('already-consistent');
    expect(r.flips).toEqual([]);
  });

  it('refuses a non-orientable component instead of choosing', () => {
    const r = resolveComponentWinding(SurgeryMesh.from(strip(6, [], true)), 0);
    expect(r.outcome).toBe('non-orientable');
    expect(r.flips).toEqual([]);
  });

  it('refuses a solution that would invert most of the component', () => {
    // The seed (face 0) is in the minority patch, so the seed rule would reverse everything else.
    const mesh = SurgeryMesh.from(strip(10, [0, 1]));
    const r = resolveComponentWinding(mesh, 5);
    expect(r.outcome).toBe('flips-not-a-small-minority');
    expect(r.flips.length).toBeGreaterThan(10);
  });

  it('refuses a flip set above the hard ceiling even when it is a minority', () => {
    const mesh = SurgeryMesh.from(strip(40, [30, 31, 32, 33]));
    expect(resolveComponentWinding(mesh, 0, 10).outcome).toBe('resolved');
    expect(resolveComponentWinding(mesh, 0, 3).outcome).toBe('flips-not-a-small-minority');
  });

  it('ignores a non-manifold VERTEX: only edges constrain orientation', () => {
    // Two strips touching at one vertex are two components; the conflict in one is fixed alone.
    const a = strip(6, [3]);
    const offset = a.positions.length / 3;
    const points: number[] = [...a.positions];
    const idx: number[] = [...a.indices];
    const b = strip(6);
    for (let i = 0; i < b.positions.length; i += 1)
      points.push((b.positions[i] ?? 0) + (i % 3 === 2 ? 5 : 0));
    for (const v of b.indices) idx.push(v + offset);
    // Weld the last corner of strip A onto the first corner of strip B (a pinch).
    const keep = idx.map((v) => (v === offset ? 12 : v));
    const positions = createPositionArray(points.length);
    positions.set(points);
    const indices = createIndexArray(keep.length);
    indices.set(keep);
    const mesh = SurgeryMesh.from({ positions, indices, metadata: { sourceFormat: '3mf' } });
    const r = resolveComponentWinding(mesh, 0);
    expect(r.outcome).toBe('resolved');
    expect(r.flips).toEqual([3]);
  });
});
