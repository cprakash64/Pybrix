import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { buildFanTopology, classifyPinch, PinchClass, planLocalRepair } from './pinch-topology';

type P = readonly [number, number, number];
type F = readonly [number, number, number];

function meshOf(points: readonly P[], faces: readonly F[]): CanonicalMesh {
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

/** Two tetrahedra sharing ONE corner coordinate: two closed fans from separate shells. */
function tetraPair(): CanonicalMesh {
  return meshOf(
    [
      [0, 0, 0],
      [1, 0, 1],
      [-0.5, 0.9, 1],
      [-0.5, -0.9, 1.1],
      [-1, 0.1, -1],
      [0.5, -0.9, -1.2],
      [0.45, 0.95, -1.1],
    ],
    [
      [0, 2, 1],
      [0, 3, 2],
      [0, 1, 3],
      [1, 2, 3],
      [0, 4, 5],
      [0, 5, 6],
      [0, 6, 4],
      [4, 6, 5],
    ],
  );
}

/** Three faces on one edge: a non-manifold edge at the vertex, which movement cannot separate. */
function nonManifoldEdge(): CanonicalMesh {
  return meshOf(
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, -1, 0],
    ],
    [
      [0, 1, 2],
      [0, 1, 3],
      [0, 1, 4],
    ],
  );
}

describe('buildFanTopology', () => {
  it('finds the pinched vertex of two shells, and its two fans', () => {
    const topology = buildFanTopology(tetraPair());
    expect(topology.pinched).toHaveLength(1);
    const v = topology.pinched[0];
    expect(v?.fans).toHaveLength(2);
    expect(v?.fans.map((f) => f.faces.length)).toEqual([3, 3]);
    expect(v?.nonManifoldEdge).toBe(false);
    expect(topology.componentFaceCount).toEqual([4, 4]);
  });

  it('finds nothing on a manifold mesh', () => {
    const closedTetra = meshOf(
      [
        [0, 0, 0],
        [1, 0, 1],
        [-0.5, 0.9, 1],
        [-0.5, -0.9, 1.1],
      ],
      [
        [0, 2, 1],
        [0, 3, 2],
        [0, 1, 3],
        [1, 2, 3],
      ],
    );
    expect(buildFanTopology(closedTetra).pinched).toEqual([]);
  });

  it('marks a vertex with a non-manifold edge, which the repair never attempts', () => {
    const topology = buildFanTopology(nonManifoldEdge());
    expect(topology.pinched.some((v) => v.nonManifoldEdge)).toBe(true);
  });

  it('is deterministic and reads without writing the mesh', () => {
    const mesh = tetraPair();
    const before = Array.from(mesh.positions);
    const a = buildFanTopology(mesh);
    const b = buildFanTopology(mesh);
    expect(a.pinched).toEqual(b.pinched);
    expect(Array.from(mesh.positions)).toEqual(before);
  });
});

describe('classifyPinch and planLocalRepair', () => {
  it('classes two separate closed shells meeting at a point as separate-shell contacts', () => {
    const topology = buildFanTopology(tetraPair());
    const v = topology.pinched[0];
    if (v === undefined) throw new Error('no pinch');
    expect(classifyPinch(v, topology)).toBe(PinchClass.SeparateShells);
  });

  it('counts eligible vertices by class and the unsupported non-manifold-edge ones separately', () => {
    const plan = planLocalRepair(buildFanTopology(tetraPair()));
    expect(plan.pinchedVertices).toBe(1);
    expect(plan.eligible).toBe(1);
    expect(plan.unsupportedNonManifoldEdge).toBe(0);
    expect(plan.byClass[PinchClass.SeparateShells]).toBe(1);
    const bad = planLocalRepair(buildFanTopology(nonManifoldEdge()));
    expect(bad.eligible).toBe(0);
    expect(bad.unsupportedNonManifoldEdge).toBeGreaterThan(0);
  });
});
