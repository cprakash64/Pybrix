import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { SurgeryMesh, SurgeryRefusal, type SurgeryRefusalRecord } from './surgery-mesh';
import { runResidualRepair } from './residual-repair';

/**
 * REPAIR-CORE-05E — the residual phase touches ONLY the sites it is handed, and only through
 * operations that carry their own refusals.
 */
type F = readonly [number, number, number];

function meshOf(
  points: readonly (readonly [number, number, number])[],
  faces: readonly F[],
): CanonicalMesh {
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

/** A strip of 6 quads whose ends are identified with a half twist: non-orientable. */
function mobius(): CanonicalMesh {
  const points: [number, number, number][] = [];
  for (let i = 0; i <= 6; i += 1) points.push([i, 0, 0], [i, 1, 0]);
  const faces: F[] = [];
  for (let i = 0; i < 6; i += 1) {
    const a = i * 2;
    faces.push([a, a + 2, a + 3], [a, a + 3, a + 1]);
  }
  const twisted = faces.map((t) => t.map((v) => (v === 12 ? 1 : v === 13 ? 0 : v)) as unknown as F);
  return meshOf(points, twisted);
}

const refusal = (vertex: number, reason: SurgeryRefusalRecord['reason']): SurgeryRefusalRecord => ({
  vertex,
  reason,
  detail: '',
  attempts: 0,
});

describe('runResidualRepair', () => {
  it('does nothing, and changes no byte, when handed no refused site', () => {
    const mesh = SurgeryMesh.from(mobius());
    const before = Array.from(mesh.tri.slice(0, mesh.faceCount * 3));
    const r = runResidualRepair(mesh, [], { search: {}, accept: () => undefined });
    expect(r.operations).toEqual([]);
    expect(r.windingResolutions).toEqual([]);
    expect(Array.from(mesh.tri.slice(0, mesh.faceCount * 3))).toEqual(before);
  });

  it('reports a non-orientable chain, flips nothing and repairs nothing', () => {
    const mesh = SurgeryMesh.from(mobius());
    const before = Array.from(mesh.tri.slice(0, mesh.faceCount * 3));
    const r = runResidualRepair(mesh, [refusal(0, SurgeryRefusal.InconsistentFan)], {
      search: {},
      accept: () => undefined,
    });
    expect(r.windingResolutions).toHaveLength(1);
    expect(r.windingResolutions[0]?.outcome).toBe('non-orientable');
    expect(r.operations).toEqual([]);
    expect(Array.from(mesh.tri.slice(0, mesh.faceCount * 3))).toEqual(before);
  });

  it('attempts winding resolution once per component, not once per refused vertex', () => {
    const mesh = SurgeryMesh.from(mobius());
    const r = runResidualRepair(
      mesh,
      [
        refusal(0, SurgeryRefusal.InconsistentFan),
        refusal(2, SurgeryRefusal.InconsistentFan),
        refusal(4, SurgeryRefusal.InconsistentFan),
      ],
      { search: {}, accept: () => undefined },
    );
    expect(r.windingResolutions).toHaveLength(1);
  });
});
