import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { liveFans, SurgeryMesh, type SurgeryAccept } from './surgery-mesh';
import {
  enumerateTriangulations,
  retriangulateSite,
  tryRetriangulate,
} from './link-retriangulation';
import { inspectCandidate, resolveSearchConfig } from './pinch-search';

/**
 * REPAIR-CORE-05E — link retriangulation: a CLOSED fan is removed from a pinched vertex by covering
 * its rim with rim-only triangles. These tests pin the mechanics and, as importantly, the cases it
 * must REFUSE.
 */
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

/** A closed cone of `n` faces around vertex `apex`, rim on a circle of radius `r` at height `h`. */
function cone(
  points: P[],
  faces: F[],
  apex: number,
  n: number,
  r: number,
  h: number,
  phase = 0,
): void {
  const base = points.length;
  for (let k = 0; k < n; k += 1) {
    const a = phase + (2 * Math.PI * k) / n;
    points.push([r * Math.cos(a), r * Math.sin(a), h]);
  }
  for (let k = 0; k < n; k += 1) {
    // Orientation: apex, then rim k, k+1 in rim order.
    faces.push(
      h >= 0 ? [apex, base + k, base + ((k + 1) % n)] : [apex, base + ((k + 1) % n), base + k],
    );
  }
}

/** Two flat-ish cones sharing only the apex, one above and one below. */
function bowtie(n = 6, hA = 0.05, hB = -0.05): CanonicalMesh {
  const points: P[] = [[0, 0, 0]];
  const faces: F[] = [];
  cone(points, faces, 0, n, 1, hA);
  cone(points, faces, 0, n, 1, hB, 0.3);
  return meshOf(points, faces);
}

const catalan = (n: number): number => {
  let c = 1;
  for (let i = 0; i < n; i += 1) c = (c * 2 * (2 * i + 1)) / (i + 2);
  return Math.round(c);
};
const acceptAll: SurgeryAccept = () => undefined;

describe('enumerateTriangulations', () => {
  it('lists exactly Catalan(n - 2) triangulations of n - 2 triangles each, in polygon order', () => {
    for (const n of [3, 4, 5, 6, 7, 8]) {
      const all = enumerateTriangulations(n);
      expect(all).toHaveLength(catalan(n - 2));
      for (const t of all) {
        expect(t).toHaveLength(n - 2);
        for (const [i, j, k] of t) expect(i < j && j < k).toBe(true);
      }
      // All distinct.
      expect(new Set(all.map((t) => JSON.stringify(t))).size).toBe(all.length);
    }
    expect(enumerateTriangulations(2)).toEqual([]);
  });
});

describe('tryRetriangulate', () => {
  it('removes one closed fan from the vertex, moves nothing and adds no vertex', () => {
    const mesh = SurgeryMesh.from(bowtie());
    const fans = liveFans(mesh, 0).fans;
    expect(fans).toHaveLength(2);
    const fan = fans[0];
    if (fan === undefined) throw new Error('no fan');
    const vertices = mesh.vertexCount;
    const before = Array.from(mesh.pos.slice(0, vertices * 3));
    const r = tryRetriangulate(
      mesh,
      0,
      [{ fan, triangulation: enumerateTriangulations(6)[0] ?? [] }],
      acceptAll,
      undefined,
    );
    expect(typeof r).not.toBe('string');
    if (typeof r === 'string') return;
    expect(r.removed).toHaveLength(6);
    expect(r.added).toHaveLength(4);
    expect(mesh.vertexCount).toBe(vertices);
    expect(Array.from(mesh.pos.slice(0, vertices * 3))).toEqual(before);
    expect(liveFans(mesh, 0).fans).toHaveLength(1);
  });

  it('leaves the mesh exactly as found when the exact gate refuses', () => {
    const mesh = SurgeryMesh.from(bowtie());
    const fan = liveFans(mesh, 0).fans[0];
    if (fan === undefined) throw new Error('no fan');
    const faces = mesh.faceCount;
    const alive = Array.from(mesh.alive.slice(0, faces));
    const r = tryRetriangulate(
      mesh,
      0,
      [{ fan, triangulation: enumerateTriangulations(6)[3] ?? [] }],
      () => 'introduces-intersection',
      undefined,
    );
    expect(r).toBe('introduces-intersection');
    expect(mesh.faceCount).toBe(faces);
    expect(Array.from(mesh.alive.slice(0, faces))).toEqual(alive);
    expect(liveFans(mesh, 0).fans).toHaveLength(2);
  });

  it('refuses a covering that would duplicate a face that already exists', () => {
    // A tetrahedron corner: the 3-face cone's rim triangle IS the tetrahedron's base face.
    const mesh = SurgeryMesh.from(
      meshOf(
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
      ),
    );
    const fans = liveFans(mesh, 0).fans;
    const results = fans.map((fan) =>
      tryRetriangulate(
        mesh,
        0,
        [{ fan, triangulation: enumerateTriangulations(3)[0] ?? [] }],
        undefined,
        undefined,
      ),
    );
    expect(results).toEqual(['new-duplicate-face', 'new-duplicate-face']);
    expect(mesh.faceCount).toBe(8);
  });

  it('refuses a diagonal that would make an existing edge non-manifold', () => {
    const points: P[] = [[0, 0, 0]];
    const faces: F[] = [];
    cone(points, faces, 0, 4, 1, 0.05);
    // Rim vertices are 1..4. Give the would-be diagonal 1-3 two faces of its own elsewhere.
    points.push([0, 0, 3], [0, 0, -3]);
    faces.push([1, 3, 5], [3, 1, 6]);
    const mesh = SurgeryMesh.from(meshOf(points, faces));
    const fans = liveFans(mesh, 0).fans;
    const fan = fans[0];
    if (fan === undefined) throw new Error('no fan');
    const outcomes = enumerateTriangulations(4).map((t) =>
      tryRetriangulate(mesh, 0, [{ fan, triangulation: t }], undefined, undefined, true),
    );
    // One triangulation uses diagonal rim[0]-rim[2] = vertices 1-3: refused. The other is fine.
    expect(outcomes.filter((o) => o === 'new-non-manifold-edge')).toHaveLength(1);
    expect(outcomes.filter((o) => typeof o !== 'string')).toHaveLength(1);
  });

  it("refuses a cone too tall for a flat covering by the engine's own fidelity ceiling", () => {
    const mesh = SurgeryMesh.from(bowtie(6, 5, -0.05));
    const fan = liveFans(mesh, 0).fans[0];
    if (fan === undefined) throw new Error('no fan');
    const cfg = resolveSearchConfig({});
    const inspect = (
      ctx: Parameters<NonNullable<Parameters<typeof tryRetriangulate>[4]>>[0],
    ): string | undefined => {
      const v = inspectCandidate(ctx, cfg, mesh.point(0), 1);
      return typeof v === 'string' ? v : undefined;
    };
    const verdicts = enumerateTriangulations(6).map((t) =>
      tryRetriangulate(mesh, 0, [{ fan, triangulation: t }], undefined, inspect, true),
    );
    expect(verdicts.every((v) => typeof v === 'string')).toBe(true);
    // Refused by the engine's fidelity limits (either normaliser), never accepted.
    expect(verdicts.some((v) => typeof v === 'string' && v.startsWith('deviation-ceiling'))).toBe(
      true,
    );
  });
});

describe('retriangulateSite', () => {
  it('repairs a closed-fan pinch and reports which fan went', () => {
    const mesh = SurgeryMesh.from(bowtie());
    const r = retriangulateSite(mesh, 0, resolveSearchConfig({}), acceptAll);
    expect('fanIndices' in r).toBe(true);
    if (!('fanIndices' in r)) return;
    expect(r.fanIndices).toHaveLength(1);
    expect(r.candidate.fidelity.maxDistanceOverLocalEdge).toBeLessThanOrEqual(1);
    expect(liveFans(mesh, 0).fans).toHaveLength(1);
  });

  it('refuses a rim above the ceiling, an open fan, and a vertex with no pinch', () => {
    // Rim of 10 > ceiling 9 on both fans.
    const big = SurgeryMesh.from(bowtie(10));
    const refusal = retriangulateSite(big, 0, resolveSearchConfig({}), acceptAll);
    expect('fanIndices' in refusal).toBe(false);
    expect(
      (refusal as { reasons: Record<string, number> }).reasons['rim-too-large'],
    ).toBeGreaterThan(0);
    // An open fan: delete one face of a cone.
    const points: P[] = [[0, 0, 0]];
    const faces: F[] = [];
    cone(points, faces, 0, 5, 1, 0.05);
    cone(points, faces, 0, 5, 1, -0.05, 0.3);
    faces.splice(2, 1);
    const open = SurgeryMesh.from(meshOf(points, faces));
    const r2 = retriangulateSite(open, 0, resolveSearchConfig({}), acceptAll);
    expect((r2 as { reasons: Record<string, number> }).reasons['open-fan']).toBeGreaterThan(0);
    // A vertex that is not pinched.
    const solo = SurgeryMesh.from(meshOf(points.slice(0, 7), faces.slice(0, 5)));
    const r3 = retriangulateSite(solo, 0, resolveSearchConfig({}), acceptAll);
    expect((r3 as { reasons: Record<string, number> }).reasons['no-fans']).toBe(1);
  });

  it('never leaves a tentative face behind, whatever the gate says', () => {
    const mesh = SurgeryMesh.from(bowtie());
    const faces = mesh.faceCount;
    const r = retriangulateSite(mesh, 0, resolveSearchConfig({}), () => 'introduces-intersection');
    expect('fanIndices' in r).toBe(false);
    expect(mesh.faceCount).toBe(faces);
    expect(mesh.aliveFaceCount()).toBe(faces);
  });
});
