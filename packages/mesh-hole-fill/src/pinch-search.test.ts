import { describe, expect, it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology, type TopologyReport } from '@cadfixer/mesh-topology';
import { buildFanTopology } from './pinch-topology';
import { PINCH_SEARCH_DEFAULTS, searchPinchSite, runPinchSearch } from './pinch-search';
import { liveFanCount, SurgeryMesh, SurgeryRefusal } from './surgery-mesh';

/**
 * LS-A2 / LS-B on synthetic pinches. The exact intersection gate is
 * injected and not exercised here (the qualification suite does that); these prove the
 * displacement rule, the anchor, the staggered scheme, the fidelity ceiling, depth
 * escalation, determinism and rollback.
 */

type Point = readonly [number, number, number];
type Face = readonly [number, number, number];

function indexed(points: readonly Point[], faces: readonly Face[]): CanonicalMesh {
  const positions = createPositionArray(points.length * 3);
  points.forEach((point, index) => {
    positions.set(point, index * 3);
  });
  const indices = createIndexArray(faces.length * 3);
  faces.forEach((face, index) => {
    indices.set(face, index * 3);
  });
  return { positions, indices, metadata: { sourceFormat: '3mf' } };
}

function analyse(mesh: CanonicalMesh): TopologyReport {
  return analyseTopology(mesh, {
    documentId: 'd',
    partId: 'p',
    documentRevision: 1,
    cancellation: uncancellable,
  }).report;
}

/** Two closed tetrahedra sharing ONLY the vertex V = origin. */
function tetraPair(): CanonicalMesh {
  const points: Point[] = [
    [0, 0, 0],
    [1, 0, 1],
    [-0.5, 0.9, 1],
    [-0.5, -0.9, 1.1],
    [-1, 0.1, -1],
    [0.5, -0.9, -1.2],
    [0.45, 0.95, -1.1],
  ];
  const faces: Face[] = [
    [0, 2, 1],
    [0, 3, 2],
    [0, 1, 3],
    [1, 2, 3],
    [0, 4, 5],
    [0, 5, 6],
    [0, 6, 4],
    [4, 6, 5],
  ];
  return indexed(points, faces);
}

/** A triangular-lattice hexagon of side `radius`, centred on its first vertex. */
function hexDisk(radius: number, basisU: Point, basisV: Point): { points: Point[]; faces: Face[] } {
  const ids = new Map<string, number>();
  const points: Point[] = [];
  const at = (i: number, j: number): number | undefined => {
    if (Math.max(Math.abs(i), Math.abs(j), Math.abs(i + j)) > radius) return undefined;
    const key = `${String(i)},${String(j)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = points.length;
      ids.set(key, id);
      points.push([
        i * basisU[0] + j * basisV[0],
        i * basisU[1] + j * basisV[1],
        i * basisU[2] + j * basisV[2],
      ]);
    }
    return id;
  };
  at(0, 0);
  const faces: Face[] = [];
  for (let i = -radius - 1; i <= radius; i += 1) {
    for (let j = -radius - 1; j <= radius; j += 1) {
      const t1 = [at(i, j), at(i + 1, j), at(i, j + 1)];
      if (t1.every((x) => x !== undefined)) faces.push(t1 as unknown as Face);
      const t2 = [at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (t2.every((x) => x !== undefined)) faces.push(t2 as unknown as Face);
    }
  }
  return { points, faces };
}

/** Two hexagonal sheets through one shared centre. */
function sheetPair(radius: number): CanonicalMesh {
  const a = hexDisk(radius, [1, 0, 0], [0.5, 0.8660254037844386, 0]);
  const b = hexDisk(radius, [0.31, 0.93, 0.11], [-0.83, 0.23, 0.71]);
  const points: Point[] = [...a.points];
  const offset = points.length - 1;
  b.points.forEach((p, i) => {
    if (i > 0) points.push(p);
  });
  const faces: Face[] = [...a.faces];
  for (const f of b.faces) {
    faces.push(f.map((x) => (x === 0 ? 0 : x + offset)) as unknown as Face);
  }
  return indexed(points, faces);
}

/**
 * THE 05A FIDELITY OUTLIER, in miniature. One shell is a closed tetrahedron with unit
 * edges at V. The other is a single triangle whose two spokes are 100 long and whose
 * far edge is 1 long: a needle. 05A scaled the apex offset by that fan's distance to
 * its link centroid (about 100), so a quarter of it was ~25 local edges.
 */
function needleAndTetra(): CanonicalMesh {
  const points: Point[] = [
    [0, 0, 0],
    [1, 0, 1],
    [-0.5, 0.9, 1],
    [-0.5, -0.9, 1.1],
    [0, 0.5, -100],
    [0, -0.5, -100],
  ];
  const faces: Face[] = [
    [0, 2, 1],
    [0, 3, 2],
    [0, 1, 3],
    [1, 2, 3],
    [0, 4, 5],
  ];
  return indexed(points, faces);
}

/** Three single-triangle sheets leaving V in almost the same direction (a thin wedge). */
function thinWedge(): CanonicalMesh {
  const points: Point[] = [[0, 0, 0]];
  const faces: Face[] = [];
  [0, 0.02, 0.04].forEach((tilt, i) => {
    points.push([1, 0, tilt], [0, 1, tilt]);
    faces.push([0, 1 + i * 2, 2 + i * 2]);
  });
  return indexed(points, faces);
}

function surgeon(mesh: CanonicalMesh): { live: SurgeryMesh; targets: number[] } {
  const live = SurgeryMesh.from(mesh);
  const targets = buildFanTopology(mesh).pinched.map((p) => p.vertex);
  return { live, targets };
}

function vertexSet(mesh: CanonicalMesh): Set<string> {
  const out = new Set<string>();
  for (let v = 0; v < mesh.positions.length / 3; v += 1) {
    out.add(
      [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]
        .map((x) => String(x))
        .join(','),
    );
  }
  return out;
}

describe('LS-A2 — displacement is derived from local scale, never from a fan extent', () => {
  it('separates two closed shells and leaves a clean manifold topology', () => {
    const source = tetraPair();
    expect(analyse(source).nonManifoldVertexCount).toBe(1);
    const { live, targets } = surgeon(source);
    const result = runPinchSearch(live, targets);
    expect(result.operations).toHaveLength(1);
    expect(result.refusals).toHaveLength(0);
    const report = analyse(live.toCanonical());
    expect(report.nonManifoldVertexCount).toBe(0);
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.windingConflictEdgeCount).toBe(0);
    expect(report.componentCount).toBe(2);
    expect(report.sourceFaceCount).toBe(8);
  });

  it('never moves a displacement beyond rho_max local scale, even beside a needle', () => {
    const source = needleAndTetra();
    const { live, targets } = surgeon(source);
    const result = runPinchSearch(live, targets);
    expect(result.operations).toHaveLength(1);
    const op = result.operations[0];
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(op.selection.rho).toBeLessThanOrEqual(PINCH_SEARCH_DEFAULTS.maxRho);
    expect(op.fidelity.maxDistanceOverLocalEdge).toBeLessThanOrEqual(
      PINCH_SEARCH_DEFAULTS.deviationCeiling,
    );
    for (const v of op.newVertices.slice(0, op.movedFans)) {
      const p = live.point(v);
      const away = Math.hypot(p[0] - op.point[0], p[1] - op.point[1], p[2] - op.point[2]);
      expect(away).toBeLessThanOrEqual(
        PINCH_SEARCH_DEFAULTS.maxRho * op.localScale * 1.0001 * op.movedFans,
      );
    }
    expect(analyse(live.toCanonical()).nonManifoldVertexCount).toBe(0);
  });

  it('leaves an anchored fan exactly as it was', () => {
    const source = sheetPair(2);
    const { live, targets } = surgeon(source);
    const result = runPinchSearch(live, targets);
    const op = result.operations[0];
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(op.depth).toBe(1);
    if (op.selection.anchorFan >= 0) {
      expect(op.movedFans).toBe(op.fanCount - 1);
      expect(liveFanCount(live, op.vertex)).toBe(1);
    }
    expect(analyse(live.toCanonical()).nonManifoldVertexCount).toBe(0);
  });

  it('separates a thin wedge whose fans share one direction, by staggering magnitudes', () => {
    const source = thinWedge();
    expect(buildFanTopology(source).pinched).toHaveLength(1);
    const { live, targets } = surgeon(source);
    const result = runPinchSearch(live, targets);
    expect(result.refusals).toHaveLength(0);
    expect(result.operations).toHaveLength(1);
    const report = analyse(live.toCanonical());
    expect(report.nonManifoldVertexCount).toBe(0);
    expect(report.sourceFaceCount).toBe(3);
  });

  it('changes no coordinate it was not asked to change', () => {
    const source = sheetPair(2);
    const before = vertexSet(source);
    const { live, targets } = surgeon(source);
    runPinchSearch(live, targets);
    const after = vertexSet(live.toCanonical());
    // Every surviving source coordinate is byte-identical; only the fresh apexes are new.
    let kept = 0;
    for (const key of after) if (before.has(key)) kept += 1;
    expect(kept).toBeGreaterThanOrEqual(before.size - 1);
  });

  it('is deterministic', () => {
    const run = (): CanonicalMesh => {
      const { live, targets } = surgeon(sheetPair(3));
      runPinchSearch(live, targets);
      return live.toCanonical();
    };
    const a = run();
    const b = run();
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
});

describe('LS-B — deeper regions, one ring at a time', () => {
  it('rebuilds a ring-2 region with graded interior vertices when asked to start at depth 2', () => {
    const source = sheetPair(3);
    const { live, targets } = surgeon(source);
    const result = runPinchSearch(live, targets, { minDepth: 2 });
    const op = result.operations[0];
    expect(op?.depth).toBe(2);
    expect(op?.displacedInteriorVertices ?? 0).toBeGreaterThan(0);
    const report = analyse(live.toCanonical());
    expect(report.nonManifoldVertexCount).toBe(0);
    expect(report.boundaryEdgeCount).toBe(analyse(source).boundaryEdgeCount);
    expect(op?.fidelity.maxDistanceOverLocalEdge ?? 99).toBeLessThanOrEqual(1);
  });

  it('stops at the minimum successful depth', () => {
    const { live, targets } = surgeon(sheetPair(3));
    const result = runPinchSearch(live, targets);
    expect(result.operations[0]?.depth).toBe(1);
  });
});

describe('LS-A2 gates and rollback', () => {
  it('refuses, naming the gate, when no candidate can stay under the deviation ceiling', () => {
    const { live, targets } = surgeon(tetraPair());
    const site = searchPinchSite(live, targets[0] ?? 0, { deviationCeiling: 1e-9 });
    expect(site.operation).toBeUndefined();
    expect(site.refusal?.reason).toBe(SurgeryRefusal.NoUsableDirection);
    expect(site.refusal?.detail).toContain('deviation-ceiling');
  });

  it('leaves the live mesh exactly as found when the injected exact gate refuses everything', () => {
    const { live, targets } = surgeon(tetraPair());
    const faces = live.faceCount;
    const vertices = live.vertexCount;
    const alive = live.aliveFaceCount();
    const site = searchPinchSite(live, targets[0] ?? 0, {
      accept: () => 'introduces-intersection',
    });
    expect(site.operation).toBeUndefined();
    expect(site.refusal?.reason).toBe(SurgeryRefusal.Rejected);
    expect(live.faceCount).toBe(faces);
    expect(live.vertexCount).toBe(vertices);
    expect(live.aliveFaceCount()).toBe(alive);
    expect(liveFanCount(live, targets[0] ?? 0)).toBe(2);
  });

  it('refuses a vertex that is already manifold', () => {
    const { live } = surgeon(tetraPair());
    const site = searchPinchSite(live, 1, {});
    expect(site.operation).toBeUndefined();
  });
});
