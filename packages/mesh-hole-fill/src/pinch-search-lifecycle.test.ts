import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { buildFanTopology } from './pinch-topology';
import {
  growRegion,
  liveFans,
  SurgeryMesh,
  tryReconstruct,
  type CandidateBaseline,
  type TentativeContext,
} from './surgery-mesh';
import { runPinchSearch } from './pinch-search';

type Point = readonly [number, number, number];
type Face = readonly [number, number, number];

function tetraPairAt(dx: number, dy: number, dz: number): { points: Point[]; faces: Face[] } {
  const base: Point[] = [
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
  return { points: base.map((p) => [p[0] + dx, p[1] + dy, p[2] + dz] as const), faces };
}

/** Several pinches, some close enough for their stars to interact. */
function cluster(count: number, spacing: number): CanonicalMesh {
  const points: Point[] = [];
  const faces: Face[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = tetraPairAt((i % 3) * spacing, Math.floor(i / 3) * spacing, 0);
    const offset = points.length;
    points.push(...t.points);
    for (const f of t.faces) faces.push([f[0] + offset, f[1] + offset, f[2] + offset]);
  }
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

describe('candidate baseline cache', () => {
  it('returns the same baseline-derived verdicts and geometry as recomputing it for every candidate', () => {
    const mesh = cluster(1, 1);
    const live = SurgeryMesh.from(mesh);
    const vertex = buildFanTopology(mesh).pinched[0]?.vertex ?? 0;
    const fans = liveFans(live, vertex).fans;
    const regions = fans.map((f) => growRegion(live, vertex, f, 1));
    const edges = fans.map(() => 1);
    const record = (cache: Map<string, CandidateBaseline> | undefined): unknown[] => {
      const out: unknown[] = [];
      for (const rho of [0.1, 0.2, 0.3]) {
        const offsets = fans.map((_, i) => [0, 0, (i === 0 ? 1 : -1) * rho] as const);
        let captured: TentativeContext | undefined;
        const r = tryReconstruct(live, vertex, fans, regions, 1, offsets, edges, undefined, {
          minSeparation: 0,
          dryRun: true,
          truncate: true,
          ...(cache === undefined ? {} : { baselineCache: cache }),
          inspect: (c) => {
            captured = c;
            return undefined;
          },
        });
        out.push(
          typeof r === 'string' ? r : [r.removed, r.added.length, r.newVertices.length, r.boundary],
        );
        out.push(captured === undefined ? null : captured.addedFaces.length);
      }
      return out;
    };
    const plain = record(undefined);
    const shared = new Map<string, CandidateBaseline>();
    const cached = record(shared);
    expect(cached).toEqual(plain);
    expect(shared.size).toBe(1);
    // After every dry run the mesh is exactly as found.
    expect(live.faceCount).toBe(SurgeryMesh.from(mesh).faceCount);
  });
});

describe('cancellation', () => {
  it('stops at a site boundary with every accepted operation complete and no tentative face left', () => {
    const mesh = cluster(9, 6);
    const live = SurgeryMesh.from(mesh);
    const targets = buildFanTopology(mesh).pinched.map((p) => p.vertex);
    let polls = 0;
    const result = runPinchSearch(live, targets, { cancelled: () => ++polls > 3 });
    expect(result.cancelled).toBe(true);
    expect(result.operations.length).toBeLessThan(targets.length);
    // Complete operations only: the live mesh still holds exactly its alive faces, and a fresh
    // run on a fresh mesh is unaffected by the cancelled one.
    const fresh = SurgeryMesh.from(mesh);
    const full = runPinchSearch(fresh, targets, {});
    expect(full.cancelled).toBe(false);
    expect(full.operations.length).toBe(targets.length);
    const partial = live.toCanonical();
    expect(partial.indices.length / 3).toBe(live.aliveFaceCount());
  });
});
