import { createCounters, FaceBvh, type BroadphaseBudget } from './bvh';

/**
 * REPAIR-CORE-05D — an INCREMENTAL broadphase over the faces a sequential repair has appended.
 *
 * The qualification gate used to answer "which appended faces might touch this box" by walking
 * every appended face for every patch face of every candidate: O(sites) per query and
 * O(sites^2) per repair, with a fresh box array per face. This index answers the same
 * question from a bounding-volume tree over the committed faces plus a short unsorted buffer
 * of the newest ones, rebuilding the tree whenever the buffer fills. It is a SUPERSET
 * generator only: the caller applies the same exact box test it always applied, so the faces
 * enumerated are identical to the linear scan's, and the caller sorts the answer ascending
 * so they are visited in the identical order.
 *
 * Memory is the tree over the appended faces (a few typed arrays per face) plus the buffer;
 * nothing is retained per candidate and nothing grows with sites x faces.
 */
const UNLIMITED: BroadphaseBudget = {
  maxNodeVisits: Number.MAX_SAFE_INTEGER,
  maxAabbTests: Number.MAX_SAFE_INTEGER,
  maxCandidates: Number.MAX_SAFE_INTEGER,
};

export interface AppendedFaceIndexStats {
  rebuilds: number;
  rebuiltFaces: number;
  indexedFaces: number;
}

export class AppendedFaceIndex {
  private tree: FaceBvh | undefined;
  private readonly firstFace: number;
  private readonly rebuildEvery: number;
  /** Faces [firstFace, tree end) are in the tree; the newest are in the buffer. */
  private limit: number;
  private bufferFaces: number[] = [];
  private bufferBoxes: number[] = [];
  public readonly stats: AppendedFaceIndexStats = { rebuilds: 0, rebuiltFaces: 0, indexedFaces: 0 };

  public constructor(firstFace: number, rebuildEvery = 512) {
    this.firstFace = firstFace;
    this.limit = firstFace;
    this.rebuildEvery = rebuildEvery;
  }

  /** One past the highest face the index covers. */
  public get covered(): number {
    return this.limit;
  }

  /**
   * Covers faces [firstFace, limit) of the given arrays. Faces are indexed whether or not they
   * are alive: a face that is dead now may be revived by a rolled-back attempt, and liveness
   * is the caller's check at query time. Positions of a face never change once it exists.
   */
  public sync(positions: Float64Array, triangles: Int32Array, limit: number): void {
    for (let face = this.limit; face < limit; face += 1) {
      let lo0 = Infinity;
      let lo1 = Infinity;
      let lo2 = Infinity;
      let hi0 = -Infinity;
      let hi1 = -Infinity;
      let hi2 = -Infinity;
      for (let c = 0; c < 3; c += 1) {
        const v = triangles[face * 3 + c] ?? 0;
        const x = positions[v * 3] ?? 0;
        const y = positions[v * 3 + 1] ?? 0;
        const z = positions[v * 3 + 2] ?? 0;
        if (x < lo0) lo0 = x;
        if (y < lo1) lo1 = y;
        if (z < lo2) lo2 = z;
        if (x > hi0) hi0 = x;
        if (y > hi1) hi1 = y;
        if (z > hi2) hi2 = z;
      }
      this.bufferFaces.push(face);
      this.bufferBoxes.push(lo0, lo1, lo2, hi0, hi1, hi2);
    }
    this.stats.indexedFaces += Math.max(0, limit - this.limit);
    this.limit = Math.max(this.limit, limit);
    if (this.bufferFaces.length >= this.rebuildEvery) this.rebuild(positions, triangles);
  }

  private rebuild(positions: Float64Array, triangles: Int32Array): void {
    const count = this.limit - this.firstFace;
    const tri = Uint32Array.from(triangles.subarray(0, this.limit * 3));
    this.tree = FaceBvh.build(positions, tri, this.firstFace, this.limit);
    this.bufferFaces = [];
    this.bufferBoxes = [];
    this.stats.rebuilds += 1;
    this.stats.rebuiltFaces += count;
  }

  /**
   * Every covered face whose box meets [lo, hi] (inclusive), plus possibly more, in NO
   * particular order and without duplicates. Callers re-test and sort.
   */
  public query(
    lo: readonly [number, number, number],
    hi: readonly [number, number, number],
    out: number[],
  ): void {
    if (this.tree !== undefined) {
      this.tree.queryBox(
        lo,
        hi,
        (face) => {
          out.push(face);
          return true;
        },
        createCounters(),
        UNLIMITED,
      );
    }
    const boxes = this.bufferBoxes;
    for (let i = 0; i < this.bufferFaces.length; i += 1) {
      const o = i * 6;
      if (
        (boxes[o] ?? 0) <= hi[0] &&
        lo[0] <= (boxes[o + 3] ?? 0) &&
        (boxes[o + 1] ?? 0) <= hi[1] &&
        lo[1] <= (boxes[o + 4] ?? 0) &&
        (boxes[o + 2] ?? 0) <= hi[2] &&
        lo[2] <= (boxes[o + 5] ?? 0)
      ) {
        out.push(this.bufferFaces[i] ?? 0);
      }
    }
  }
}
