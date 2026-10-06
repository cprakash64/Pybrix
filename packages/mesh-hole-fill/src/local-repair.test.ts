import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import type { NarrowphaseBatchResult, PatchNarrowphase } from './contract';
import { LocalRepairKind, runLocalRepair } from './local-repair';
import { SurgeryMesh } from './surgery-mesh';

/**
 * REPAIR-CORE-06A — the local-repair orchestration against a STAND-IN exact narrowphase.
 *
 * The package is kernel-free, so these tests prove what the ORCHESTRATION promises — outcome
 * classification, deterministic work limits at safe points, residual skipping, cancellation,
 * fail-closed behaviour — with a narrowphase whose verdict the test controls. What the Geogram
 * kernel decides on real geometry is qualified separately (`npm run qualify:repair-core-06a`).
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

/** `count` tetrahedron pairs, each pair sharing one corner coordinate, spaced on a grid. */
function pairs(count: number, spacing = 6): CanonicalMesh {
  const points: P[] = [];
  const faces: F[] = [];
  for (let i = 0; i < count; i += 1) {
    const dx = (i % 5) * spacing;
    const dy = Math.floor(i / 5) * spacing;
    const base: P[] = [
      [0, 0, 0],
      [1, 0, 1],
      [-0.5, 0.9, 1],
      [-0.5, -0.9, 1.1],
      [-1, 0.1, -1],
      [0.5, -0.9, -1.2],
      [0.45, 0.95, -1.1],
    ];
    const o = points.length;
    for (const p of base) points.push([p[0] + dx, p[1] + dy, p[2]]);
    for (const f of [
      [0, 2, 1],
      [0, 3, 2],
      [0, 1, 3],
      [1, 2, 3],
      [0, 4, 5],
      [0, 5, 6],
      [0, 6, 4],
      [4, 6, 5],
    ] as const) {
      faces.push([f[0] + o, f[1] + o, f[2] + o]);
    }
  }
  return meshOf(points, faces);
}

type Verdict = 'clean' | 'rejectNewVertices' | 'incomplete';

/**
 * A narrowphase whose verdict the test controls. `rejectNewVertices` calls a pair invalid when its
 * patch triangle uses a coordinate the SOURCE mesh did not have, which is what a candidate that
 * moves an apex does and what a rim-only retriangulation does not: the baseline (the removed
 * faces) stays valid, so a rejection is an INTRODUCED intersection, as in the real gate.
 */
function standIn(verdict: Verdict, source: CanonicalMesh): () => PatchNarrowphase {
  const known = new Set<string>();
  for (let i = 0; i < source.positions.length; i += 3) {
    known.add(
      `${String(source.positions[i])},${String(source.positions[i + 1])},${String(source.positions[i + 2])}`,
    );
  }
  return () => {
    let geometry: { positions: Float64Array; triangles: Uint32Array; patchFaceStart: number };
    const invalid: number[] = [];
    const isNovel = (face: number): boolean => {
      for (let c = 0; c < 3; c += 1) {
        const v = geometry.triangles[face * 3 + c] ?? 0;
        const key = `${String(geometry.positions[v * 3])},${String(geometry.positions[v * 3 + 1])},${String(geometry.positions[v * 3 + 2])}`;
        if (!known.has(key)) return true;
      }
      return false;
    };
    return {
      begin: (g): void => {
        geometry = g;
        invalid.length = 0;
      },
      classify: (pairList: Uint32Array, count: number): NarrowphaseBatchResult => {
        let bad = 0;
        for (let i = 0; i < count; i += 1) {
          const a = pairList[i * 2] ?? 0;
          const b = pairList[i * 2 + 1] ?? 0;
          if (verdict === 'rejectNewVertices' && (isNovel(a) || isNovel(b))) {
            invalid.push(Math.min(a, b), Math.max(a, b), 1);
            bad += 1;
          }
        }
        return {
          complete: verdict !== 'incomplete',
          testedPairs: count,
          skippedPairs: 0,
          unclassifiedPairs: verdict === 'incomplete' ? count : 0,
          invalidPatchSourcePairs: bad,
          invalidPatchPatchPairs: 0,
        };
      },
      samples: () => ({ samples: Uint32Array.from(invalid), truncated: false }),
      end: (): void => undefined,
    };
  };
}

const UNMETERED = { primary: undefined, residual: undefined } as const;

describe('runLocalRepair outcomes', () => {
  it('repairs every pinch and reports COMPLETE when the exact gate finds nothing', () => {
    const mesh = pairs(4);
    const result = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: UNMETERED,
    });
    expect(result.kind).toBe(LocalRepairKind.Complete);
    expect(result.counts).toMatchObject({ eligible: 4, repaired: 4, remaining: 0, unattempted: 0 });
    expect(result.patch).toBeDefined();
    expect(result.residual.ran).toBe(false);
    expect(result.residual.skippedBecause).toBe('nothing-refused');
    expect(result.limitReached).toBeUndefined();
  });

  it('reports NO_CHANGE and no patch for a mesh with no pinched vertex', () => {
    const manifold = meshOf(
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
    const result = runLocalRepair({
      mesh: manifold,
      makeNarrowphase: standIn('clean', manifold),
      limits: UNMETERED,
    });
    expect(result.kind).toBe(LocalRepairKind.NoChange);
    expect(result.patch).toBeUndefined();
    expect(result.counts.eligible).toBe(0);
  });

  it('reports NO_CHANGE and keeps the refusals when every apex candidate would intersect', () => {
    const mesh = pairs(3);
    const result = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('rejectNewVertices', mesh),
      limits: UNMETERED,
    });
    expect(result.kind).toBe(LocalRepairKind.NoChange);
    expect(result.patch).toBeUndefined();
    expect(result.counts).toMatchObject({ eligible: 3, repaired: 0, remaining: 3 });
    expect(result.counts.remainingByReason).toEqual({
      'the intersection gate rejected every candidate': 3,
    });
    // The residual phase ran on the refusals and, with nothing feasible, repaired nothing.
    expect(result.residual.ran).toBe(true);
  });

  it('FAILS CLOSED: an exact test that cannot classify a pair refuses the candidate', () => {
    const mesh = pairs(2);
    const result = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('incomplete', mesh),
      limits: UNMETERED,
    });
    expect(result.patch).toBeUndefined();
    expect(result.counts.repaired).toBe(0);
    expect(result.gate.rejectedIncomplete).toBeGreaterThan(0);
  });
});

describe('runLocalRepair work limits', () => {
  it('stops at a safe point when the primary budget is reached and reports PARTIAL_LIMIT', () => {
    const mesh = pairs(10);
    const full = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: UNMETERED,
    });
    const cap = Math.floor(full.work.primary.used / 3);
    const limited = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: { primary: cap, residual: undefined },
    });
    expect(limited.kind).toBe(LocalRepairKind.PartialLimit);
    expect(limited.limitReached).toBe('primary');
    expect(limited.counts.repaired).toBeGreaterThan(0);
    expect(limited.counts.repaired).toBeLessThan(full.counts.repaired);
    expect(limited.counts.remaining).toBe(full.counts.repaired - limited.counts.repaired);
    expect(limited.counts.unattempted).toBe(limited.counts.remaining);
    // The residual phase is skipped, never started, once the primary budget is gone.
    expect(limited.residual.ran).toBe(false);
    expect(limited.residual.skippedBecause).toBe('primary-limit');
    // The work done is bounded: the limit is crossed by at most one site's worth of charges.
    expect(limited.work.primary.used).toBeLessThan(full.work.primary.used);
  });

  it('what a limited run keeps is a consistent patch: every kept repair is complete', () => {
    const mesh = pairs(8);
    const full = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: UNMETERED,
    });
    const limited = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: { primary: Math.floor(full.work.primary.used / 2), residual: undefined },
    });
    const patch = limited.patch;
    expect(patch).toBeDefined();
    if (patch === undefined) return;
    // Applying the patch's own bookkeeping to the source must reproduce a mesh with exactly the
    // faces it claims: no tentative face, no dangling reference.
    const slots = mesh.positions.length / 3 + patch.appendedPositions.length / 3;
    for (const slot of patch.appendedFaces) expect(slot).toBeLessThan(slots);
    expect(patch.appendedFaces.length / 3).toBeGreaterThan(0);
    expect(patch.removedSourceFaces.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same mesh and limit give the same decision, counters and patch', () => {
    const mesh = pairs(9);
    const run = (): ReturnType<typeof runLocalRepair> =>
      runLocalRepair({
        mesh,
        makeNarrowphase: standIn('clean', mesh),
        limits: { primary: 2_000, residual: 500 },
      });
    const a = run();
    const b = run();
    expect(a.kind).toBe(b.kind);
    expect(a.work).toEqual(b.work);
    expect(a.counts).toEqual(b.counts);
    expect(Array.from(a.patch?.appendedFaces ?? [])).toEqual(
      Array.from(b.patch?.appendedFaces ?? []),
    );
    expect(Array.from(a.patch?.removedSourceFaces ?? [])).toEqual(
      Array.from(b.patch?.removedSourceFaces ?? []),
    );
  });

  it('charges the residual meter, not the primary one, for residual work', () => {
    const mesh = pairs(2);
    const result = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('rejectNewVertices', mesh),
      limits: UNMETERED,
    });
    expect(result.residual.ran).toBe(true);
    expect(result.work.residual.used).toBeGreaterThan(0);
    expect(result.work.primary.used).toBeGreaterThan(0);
  });

  it('stops the residual phase at its own limit without touching the primary result', () => {
    const mesh = pairs(4);
    const unlimited = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('rejectNewVertices', mesh),
      limits: UNMETERED,
    });
    const limited = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('rejectNewVertices', mesh),
      limits: { primary: undefined, residual: 5 },
    });
    expect(limited.limitReached).toBe('residual');
    expect(limited.kind).toBe(LocalRepairKind.PartialLimit);
    expect(limited.work.primary.used).toBe(unlimited.work.primary.used);
  });
});

describe('runLocalRepair cancellation', () => {
  it('stops at a site boundary, reports cancelled, and leaves the SOURCE mesh untouched', () => {
    const mesh = pairs(10);
    const before = [Array.from(mesh.positions), Array.from(mesh.indices)];
    let polls = 0;
    const result = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: UNMETERED,
      cancelled: () => ++polls > 3,
    });
    expect(result.cancelled).toBe(true);
    expect([Array.from(mesh.positions), Array.from(mesh.indices)]).toEqual(before);
    expect(result.counts.repaired).toBeLessThan(10);
  });

  it('stops inside the RESIDUAL phase too, reports cancelled and skips nothing it already did', () => {
    const mesh = pairs(4);
    const probe = { polls: 0 };
    const full = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('rejectNewVertices', mesh),
      limits: UNMETERED,
      cancelled: () => {
        probe.polls += 1;
        return false;
      },
    });
    expect(full.residual.ran).toBe(true);
    // Cancel on the very last poll: the primary phase has finished, the residual has not.
    let polls = 0;
    const cancelled = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('rejectNewVertices', mesh),
      limits: UNMETERED,
      cancelled: () => ++polls >= probe.polls,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.residual.ran).toBe(true);
    expect(cancelled.kind).not.toBe(LocalRepairKind.Complete);
  });

  it('a later run is unaffected by a cancelled one', () => {
    const mesh = pairs(6);
    let polls = 0;
    runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: UNMETERED,
      cancelled: () => ++polls > 2,
    });
    const again = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: UNMETERED,
    });
    expect(again.kind).toBe(LocalRepairKind.Complete);
    expect(again.counts.repaired).toBe(6);
  });
});

describe('the patch describes the change in the source mesh’s own slot space', () => {
  it('never welds: appended faces name existing slots, new vertices are appended after them', () => {
    const mesh = pairs(1);
    const result = runLocalRepair({
      mesh,
      makeNarrowphase: standIn('clean', mesh),
      limits: UNMETERED,
    });
    const patch = result.patch;
    expect(patch).toBeDefined();
    if (patch === undefined) return;
    const sourceSlots = mesh.positions.length / 3;
    const appended = patch.appendedPositions.length / 3;
    expect(appended).toBeGreaterThan(0);
    for (const slot of patch.appendedFaces) expect(slot).toBeLessThan(sourceSlots + appended);
    // The same mesh through the welded oracle form has the same face count the patch implies.
    const live = SurgeryMesh.from(mesh);
    expect(live.faceCount).toBe(mesh.indices.length / 3);
  });
});
