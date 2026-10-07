import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  triangleCount,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { CancellationSource } from '@cadfixer/shared';
import {
  SplitSourceReason,
  SplitStage,
  describeSplitSourceRefusal,
  splitWithConnectors,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/**
 * PYBRIX-08A — WHY MANUAL SPLIT ACCEPTS OR REFUSES EACH KIND OF SOURCE.
 *
 * Runs the PRODUCTION engine (the Manifold backend and the real eligibility
 * check) on six source classes. Tests assert the typed REASON, never the
 * sentence, so wording can change without weakening what is proven. The
 * sentence tests below assert only the honesty rule: Repair is named only when
 * every reason is one Repair's conservative operations address.
 */
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');

const CUBE_POSITIONS = (h: number, ox = 0, oy = 0, oz = 0): number[] => [
  -h + ox,
  -h + oy,
  -h + oz,
  h + ox,
  -h + oy,
  -h + oz,
  -h + ox,
  h + oy,
  -h + oz,
  h + ox,
  h + oy,
  -h + oz,
  -h + ox,
  -h + oy,
  h + oz,
  h + ox,
  -h + oy,
  h + oz,
  -h + ox,
  h + oy,
  h + oz,
  h + ox,
  h + oy,
  h + oz,
];
const CUBE_INDICES = [
  0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7,
  1, 7, 5,
];
function mesh(positions: readonly number[], indices: readonly number[]): CanonicalMesh {
  const p = createPositionArray(positions.length),
    i = createIndexArray(indices.length);
  p.set(positions);
  i.set(indices);
  return { positions: p, indices: i, metadata: {} };
}
const EMPTY: CanonicalMesh = mesh([], []);
const cube = (h = 10): CanonicalMesh => mesh(CUBE_POSITIONS(h), CUBE_INDICES);
/** A cube with its +Z face removed: otherwise manifold, one open boundary loop. */
const openCube = (): CanonicalMesh =>
  mesh(CUBE_POSITIONS(10), CUBE_INDICES.slice(0, 18).concat(CUBE_INDICES.slice(24)));
/** A flat grid: manifold, wholly open. */
function grid(n = 4): CanonicalMesh {
  const positions: number[] = [],
    indices: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.push(x, y, 0);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return mesh(positions, indices);
}
/** Two cubes that touch along ONE EDGE: that edge is shared by four triangles. */
function edgeSharingCubes(): CanonicalMesh {
  const second = CUBE_POSITIONS(10, 20, 20, 0);
  return mesh(
    [...CUBE_POSITIONS(10), ...second],
    [...CUBE_INDICES, ...CUBE_INDICES.map((v) => v + 8)],
  );
}
/** Two cubes that touch at ONE CORNER: a non-manifold vertex. */
function cornerSharingCubes(): CanonicalMesh {
  const a = CUBE_POSITIONS(10),
    b = CUBE_POSITIONS(10, 20, 20, 20);
  // Make the second cube's lowest corner the first cube's highest corner.
  b[0] = 10;
  b[1] = 10;
  b[2] = 10;
  return mesh([...a, ...b], [...CUBE_INDICES, ...CUBE_INDICES.map((v) => v + 8)]);
}
function twoSeparateCubes(): CanonicalMesh {
  return mesh(
    [...CUBE_POSITIONS(10, -20, 0, 0), ...CUBE_POSITIONS(10, 20, 0, 0)],
    [...CUBE_INDICES, ...CUBE_INDICES.map((v) => v + 8)],
  );
}

async function trySplit(
  source: CanonicalMesh,
  origin: readonly [number, number, number] = [0, 0, 0],
  normal: readonly [number, number, number] = [0, 0, 1],
): Promise<{ readonly result?: SplitResult; readonly reasons?: readonly SplitSourceReason[] }> {
  const backend = await createManifoldBooleanBackend(binary);
  try {
    const result = await splitWithConnectors(
      backend,
      source,
      { plane: { origin, normal }, connector: { kind: 'none' } },
      new CancellationSource().token,
    );
    return { result };
  } catch (error) {
    const details = (error as { readonly details?: { readonly reasons?: string } }).details;
    if (details?.reasons === undefined) throw error;
    return { reasons: details.reasons.split(',') as SplitSourceReason[] };
  }
}

describe('PYBRIX-08A split source audit (production engine)', () => {
  it('A: a clean closed cube splits into two closed pieces', async () => {
    const { result } = await trySplit(cube());
    expect(result).toBeDefined();
    expect(triangleCount(result?.pieceA ?? EMPTY)).toBeGreaterThan(0);
    expect(triangleCount(result?.pieceB ?? EMPTY)).toBeGreaterThan(0);
  });

  it('B: a closed mesh with a cavity-free complex outline splits (centred torus)', async () => {
    // A torus is closed and manifold with a through-hole: the cut has two outlines.
    const around = 48,
      tube = 16,
      positions: number[] = [],
      indices: number[] = [];
    for (let i = 0; i < around; i++)
      for (let j = 0; j < tube; j++) {
        const u = (i / around) * Math.PI * 2,
          v = (j / tube) * Math.PI * 2,
          r = 8 + 3 * Math.cos(v);
        positions.push(r * Math.cos(u), r * Math.sin(u), 3 * Math.sin(v));
        const ni = (i + 1) % around,
          nj = (j + 1) % tube,
          a = i * tube + j,
          b = ni * tube + j,
          c = ni * tube + nj,
          d = i * tube + nj;
        indices.push(a, b, d, b, c, d);
      }
    const { result } = await trySplit(mesh(positions, indices), [0, 0, 0], [1, 0, 0]);
    expect(result).toBeDefined();
  });

  it('C: a closed solid with one opening left (a repaired-but-incomplete model) is refused as OPEN_BOUNDARIES only', async () => {
    const { reasons } = await trySplit(openCube());
    expect(reasons).toEqual([SplitSourceReason.OpenBoundaries]);
  });

  it('D: an open manifold surface is refused as OPEN_BOUNDARIES', async () => {
    const { reasons } = await trySplit(grid(), [2, 2, 0], [1, 0, 0]);
    expect(reasons).toEqual([SplitSourceReason.OpenBoundaries]);
  });

  it('E: a model of several closed, separate components is accepted', async () => {
    // The plane x = 0 passes between the two cubes and through neither: that is
    // refused as a miss (7B-S03), so cut through one of them instead.
    const { result } = await trySplit(twoSeparateCubes(), [-20, 0, 0], [1, 0, 0]);
    expect(result).toBeDefined();
  });

  it('F: edge- and vertex-sharing solids are refused as NON_MANIFOLD', async () => {
    expect((await trySplit(edgeSharingCubes())).reasons).toContain(SplitSourceReason.NonManifold);
    expect((await trySplit(cornerSharingCubes())).reasons).toContain(SplitSourceReason.NonManifold);
  });
});

describe('PYBRIX-08A truthful refusal wording', () => {
  it('never points at Repair for an opening or a non-manifold edge', () => {
    for (const reasons of [
      [SplitSourceReason.OpenBoundaries],
      [SplitSourceReason.NonManifold],
      [SplitSourceReason.OpenBoundaries, SplitSourceReason.WindingConflict],
    ] as const)
      expect(describeSplitSourceRefusal(reasons)).not.toMatch(/Repair/);
  });

  it('names Repair only when every reason is one it addresses', () => {
    expect(describeSplitSourceRefusal([SplitSourceReason.WindingConflict])).toMatch(/Repair/);
    expect(
      describeSplitSourceRefusal([
        SplitSourceReason.WindingConflict,
        SplitSourceReason.DegenerateOrDuplicate,
      ]),
    ).toMatch(/Repair/);
  });

  it('states the open-boundary limitation plainly', () => {
    expect(describeSplitSourceRefusal([SplitSourceReason.OpenBoundaries])).toMatch(
      /open boundaries.*requires a closed solid|requires a closed solid.*open boundaries/s,
    );
  });
});

describe('PYBRIX-08A split progress stages', () => {
  async function stagesOf(
    source: CanonicalMesh,
    connector: Parameters<typeof splitWithConnectors>[2]['connector'],
  ): Promise<SplitStage[]> {
    const backend = await createManifoldBooleanBackend(binary);
    const stages: SplitStage[] = [];
    try {
      await splitWithConnectors(
        backend,
        source,
        { plane: { origin: [0, 0, 0], normal: [0, 0, 1] }, connector },
        new CancellationSource().token,
        (stage) => stages.push(stage),
      );
    } catch {
      // A refusal is the point of one test below; the stages reached are what it reads.
    }
    return stages;
  }

  it('reports preparing, intersecting and building cut surfaces, in that order', async () => {
    expect(await stagesOf(cube(), { kind: 'none' })).toEqual([
      SplitStage.PreparingCut,
      SplitStage.Intersecting,
      SplitStage.BuildingCutSurfaces,
    ]);
  });

  it('adds a connectors stage only when a connector was asked for', async () => {
    const stages = await stagesOf(cube(), {
      kind: 'pin',
      count: 1,
      diameter: 4,
      depth: 6,
      clearance: 0.2,
      maleSide: 'A',
    });
    expect(stages.at(-1)).toBe(SplitStage.AddingConnectors);
  });

  it('a refused source never reaches the intersection stage', async () => {
    expect(await stagesOf(openCube(), { kind: 'none' })).toEqual([SplitStage.PreparingCut]);
  });
});
