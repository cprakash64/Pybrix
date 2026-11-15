import { describe, expect, it } from 'vitest';
import { createCounters, FaceBvh, type BroadphaseBudget } from './face-bvh';

/*
 * RELEASE 2, SLICE 2A — the move must not change a single answer.
 *
 * `FaceBvh` has a box query and nothing else: no ray, nearest-hit or distance API exists, so those categories have no
 * behaviour to retain here. What it does promise is the SET and the ORDER of candidates and the counters a budget reads.
 * The fingerprints below were computed by running this same fixture against the implementation as it stood in
 * `packages/mesh-hole-fill/src/bvh.ts` at commit c7da4cc, BEFORE the move (`golden/golden-old.mjs` in the Slice 2A
 * evidence), so they pin the moved code to the old behaviour rather than to itself.
 */

const UNBOUNDED: BroadphaseBudget = {
  maxNodeVisits: 1e9,
  maxAabbTests: 1e9,
  maxCandidates: 1e9,
};

type Box = readonly [readonly [number, number, number], readonly [number, number, number]];

function fixture(): { positions: Float64Array; triangles: Uint32Array; boxes: Box[] } {
  // a closed indexed sphere, 24 x 24 bands, Float64 positions, plus 400 deterministic query boxes
  const lat = 24,
    lon = 24,
    radius = 10;
  const point = (i: number, j: number): [number, number, number] => {
    const theta = (Math.PI * i) / lat,
      phi = (2 * Math.PI * (j % lon)) / lon,
      s = i === 0 || i === lat ? 0 : Math.sin(theta);
    return [
      radius * s * Math.cos(phi) + 0,
      radius * s * Math.sin(phi) + 0,
      (i === 0 ? radius : i === lat ? -radius : radius * Math.cos(theta)) + 0,
    ];
  };
  const vertexCount = 2 + (lat - 1) * lon,
    positions = new Float64Array(vertexCount * 3);
  positions.set(point(0, 0), 0);
  for (let i = 1; i < lat; i++)
    for (let j = 0; j < lon; j++) positions.set(point(i, j), (1 + (i - 1) * lon + j) * 3);
  positions.set(point(lat, 0), (vertexCount - 1) * 3);
  const ring = (i: number, j: number): number =>
    i === 0 ? 0 : i === lat ? vertexCount - 1 : 1 + (i - 1) * lon + (j % lon);
  const list: number[] = [];
  for (let i = 0; i < lat; i++)
    for (let j = 0; j < lon; j++) {
      const a = ring(i, j),
        b = ring(i, j + 1),
        c = ring(i + 1, j),
        d = ring(i + 1, j + 1);
      if (i === 0) list.push(a, c, d);
      else if (i === lat - 1) list.push(a, c, b);
      else list.push(a, c, d, a, d, b);
    }
  let seed = 987654321;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const boxes: Box[] = [];
  for (let q = 0; q < 400; q++) {
    const cx = next() * 24 - 12,
      cy = next() * 24 - 12,
      cz = next() * 24 - 12,
      h = 0.2 + next() * 2.5;
    boxes.push([
      [cx - h, cy - h, cz - h],
      [cx + h, cy + h, cz + h],
    ]);
  }
  return { positions, triangles: Uint32Array.from(list), boxes };
}

/** FNV-1a over 32-bit words, twice with different offsets: a stable fingerprint of an ordered integer sequence. */
function fingerprint(values: readonly number[]): string {
  let a = 0x811c9dc5,
    b = 0x01000193;
  for (const value of values) {
    a = Math.imul(a ^ (value >>> 0), 0x01000193) >>> 0;
    b = Math.imul(b ^ ((value >>> 0) + 0x9e3779b9), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function run(): {
  fingerprint: string;
  length: number;
  nodeCount: number;
  counters: { nodeVisits: number; aabbTests: number; candidates: number };
} {
  const { positions, triangles, boxes } = fixture();
  const tree = FaceBvh.build(positions, triangles, 0, triangles.length / 3);
  const counters = createCounters(),
    sequence: number[] = [];
  for (const [lo, hi] of boxes) {
    sequence.push(-1);
    tree.queryBox(
      lo,
      hi,
      (face) => {
        sequence.push(face);
        return true;
      },
      counters,
      UNBOUNDED,
    );
  }
  return {
    fingerprint: fingerprint(sequence),
    length: sequence.length,
    nodeCount: tree.nodeCount,
    counters: { ...counters },
  };
}

describe('FaceBvh keeps the behaviour it had in the feature package (golden from c7da4cc)', () => {
  it('emits the same candidates, in the same order, with the same counters and node count', () => {
    expect(run()).toEqual({
      fingerprint: '2b5c918735305253',
      length: 3270,
      nodeCount: 415,
      counters: { nodeVisits: 9256, aabbTests: 15465, candidates: 2870 },
    });
  });
  it('repeats exactly across independent builds of the same input', () => {
    expect(run()).toEqual(run());
  });
  it('breaks ties on face index: faces with identical boxes come out in one fixed order, build after build', () => {
    // 40 copies of one triangle: every box is identical, so ONLY the tie-break can order them
    const positions = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const triangles = new Uint32Array(40 * 3);
    for (let face = 0; face < 40; face++) triangles.set([0, 1, 2], face * 3);
    const emitted = (): number[] => {
      const out: number[] = [];
      FaceBvh.build(positions, triangles, 0, 40).queryBox(
        [-1, -1, -1],
        [2, 2, 2],
        (face) => {
          out.push(face);
          return true;
        },
        createCounters(),
        UNBOUNDED,
      );
      return out;
    };
    const first = emitted();
    expect([...first].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(emitted()).toEqual(first);
    expect(first).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });
  it('misses cleanly: a box that touches nothing emits nothing and still counts the work it did', () => {
    const { positions, triangles } = fixture();
    const tree = FaceBvh.build(positions, triangles, 0, triangles.length / 3);
    const counters = createCounters();
    const emitted: number[] = [];
    const finished = tree.queryBox(
      [100, 100, 100],
      [101, 101, 101],
      (face) => {
        emitted.push(face);
        return true;
      },
      counters,
      UNBOUNDED,
    );
    expect(finished).toBe(true);
    expect(emitted).toEqual([]);
    expect(counters).toEqual({ nodeVisits: 1, aabbTests: 1, candidates: 0 });
  });
});
