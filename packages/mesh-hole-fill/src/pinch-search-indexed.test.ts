import { describe, expect, it } from 'vitest';
import {
  assertMeshStructure,
  createIndexArray,
  createPositionArray,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { buildFanTopology } from './pinch-topology';
import { runPinchSearch } from './pinch-search';
import { SurgeryMesh } from './surgery-mesh';

/**
 * REPAIR-CORE-05C — architectural regression for indexed formats (OBJ / 3MF shape):
 * the frozen engine must keep an indexed mesh indexed, must never write the mesh it was
 * given (so a mesh SHARED by two parts and a part carrying a placement stay intact), and
 * must produce a structurally valid canonical mesh. Not a statement that any non-STL
 * writer is wired to this engine.
 */

function indexedPair(): CanonicalMesh {
  const points = [
    [0, 0, 0],
    [1, 0, 1],
    [-0.5, 0.9, 1],
    [-0.5, -0.9, 1.1],
    [-1, 0.1, -1],
    [0.5, -0.9, -1.2],
    [0.45, 0.95, -1.1],
  ] as const;
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

function repaired(mesh: CanonicalMesh): CanonicalMesh {
  const live = SurgeryMesh.from(mesh);
  const targets = buildFanTopology(mesh).pinched.map((p) => p.vertex);
  runPinchSearch(live, targets);
  return live.toCanonical();
}

describe('frozen LS-A2 on indexed meshes', () => {
  it('keeps the result indexed (shared corners stay shared) and structurally valid', () => {
    const out = repaired(indexedPair());
    expect(out.positions.length / 3).toBeLessThan(out.indices.length);
    expect(() => assertMeshStructure(out, 'indexed')).not.toThrow();
  });

  it('never writes the mesh it was given, so a mesh shared by two parts is untouched', () => {
    const shared = indexedPair();
    const positionsBefore = Array.from(shared.positions);
    const indicesBefore = Array.from(shared.indices);
    const partA = shared;
    const partB = shared;
    repaired(partA);
    expect(partB).toBe(shared);
    expect(Array.from(partB.positions)).toEqual(positionsBefore);
    expect(Array.from(partB.indices)).toEqual(indicesBefore);
  });

  it('works in part-local coordinates: a placement is never baked in', () => {
    const mesh = indexedPair();
    const before = new Set<string>();
    for (let v = 0; v < mesh.positions.length / 3; v += 1) {
      before.add([0, 1, 2].map((k) => String(mesh.positions[v * 3 + k])).join(','));
    }
    const out = repaired(mesh);
    let fresh = 0;
    for (let v = 0; v < out.positions.length / 3; v += 1) {
      const key = [0, 1, 2].map((k) => String(out.positions[v * 3 + k])).join(',');
      if (!before.has(key)) fresh += 1;
    }
    // Only the replacement apex of the one pinch is new; no coordinate was transformed.
    expect(fresh).toBeLessThanOrEqual(2);
  });
});
