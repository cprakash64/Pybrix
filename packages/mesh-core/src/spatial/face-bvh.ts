/**
 * A BOUNDED, BOX-QUERYABLE BROADPHASE OVER TRIANGLE FACES — shared spatial infrastructure.
 *
 * OWNERSHIP. This module belongs to no feature. It was written for hole-fill validation (Stage 4B-1B1) and moved here,
 * unchanged apart from this comment, in Release 2 Slice 2A so that other consumers (the connector planner, later) can
 * use the SAME tree instead of growing a second one. It imports nothing, so it can never pull a feature with it.
 *
 * WHY IT IS NOT THE GEOGRAM TREE. CAD Fixer already owns a qualified broadphase, `si_bvh.h` (the abortable median-split
 * AABB tree written for Stage 3C-1A-R1). It is not reusable from TypeScript, for two independent reasons that are facts
 * about the code rather than preferences:
 *
 *   1. IT IS C++ COMPILED INTO THE GEOGRAM WASM MODULE, and its only exported surface is the flat `cf_si_*` C ABI.
 *      There is no way to call it from TypeScript, and no way to hand it a JavaScript visitor.
 *   2. ITS ONLY QUERY IS ALL-PAIRS. `for_each_overlapping_pair` enumerates every overlapping pair of ONE mesh; there
 *      is no box query, so it cannot answer "which faces of this mesh might that box hit".
 *
 * Adding a box query to `si_bvh.h` is not available either: `kernel-integrity.test.ts` pins that file BYTE-IDENTICAL to
 * `experiments/self-intersection/si_bvh.h`, and editing it would edit the evidence that describes what ships.
 *
 * SO THIS IS A PORT, NOT AN INVENTION, and it is deliberately the same tree: median split on the widest axis, leaf
 * size 8, INCLUSIVE box overlap so exact contact is never discarded, and a deterministic tie-break on face index. It is
 * validated against a brute-force all-pairs oracle in `face-bvh.test.ts` for the same reason `si_bvh.h` was — a
 * broadphase that MISSES a pair turns a defect into a clean bill of health.
 *
 * WHAT IS NOT HERE: any narrowphase, ray query or distance query. This is a candidate generator and nothing else; the
 * exactness of whatever consumes the candidates lives with the consumer.
 *
 * NO TOLERANCE ANYWHERE. Boxes are the exact min/max of the Float64 coordinates and overlap is inclusive (`<=`), so
 * faces touching exactly at a shared plane, edge or vertex remain candidates. A strict inequality would silently
 * discard every exact contact that has to be classified rather than assumed benign.
 */

/** Node fan-out below which a node becomes a leaf. Matches `si_bvh.h`. */
const LEAF_SIZE = 8;

/** Sentinel for "no child". Node 0 is the root, so 0 can mean absent. */
const NO_CHILD = 0;

export interface BroadphaseCounters {
  /** Hierarchy nodes entered. */
  nodeVisits: number;
  /** Box-versus-box overlap tests performed. */
  aabbTests: number;
  /** Face candidates emitted to the visitor. */
  candidates: number;
}

export interface BroadphaseBudget {
  readonly maxNodeVisits: number;
  readonly maxAabbTests: number;
  readonly maxCandidates: number;
}

export function createCounters(): BroadphaseCounters {
  return { nodeVisits: 0, aabbTests: 0, candidates: 0 };
}

/**
 * A read-only median-split AABB tree over a contiguous range of faces.
 *
 * The caller's arrays are never touched: the tree owns its own permutation of
 * face indices and its own boxes. Face ids are ABSOLUTE indices into the
 * caller's triangle array, so a tree built over the patch range still reports
 * the ids the rest of the caller's code uses.
 */
export class FaceBvh {
  private readonly boxLo: Float64Array;
  private readonly boxHi: Float64Array;
  private readonly order: Uint32Array;
  private readonly firstFace: number;

  private readonly nodeLo: Float64Array;
  private readonly nodeHi: Float64Array;
  private readonly nodeBegin: Uint32Array;
  private readonly nodeEnd: Uint32Array;
  private readonly nodeLeft: Uint32Array;
  private readonly nodeRight: Uint32Array;
  private nodeCountInternal = 0;

  private constructor(faceCount: number, firstFace: number) {
    this.firstFace = firstFace;
    this.boxLo = new Float64Array(faceCount * 3);
    this.boxHi = new Float64Array(faceCount * 3);
    this.order = new Uint32Array(faceCount);
    // A binary tree that halves at every split has fewer than 2N nodes.
    const capacity = Math.max(1, faceCount * 2);
    this.nodeLo = new Float64Array(capacity * 3);
    this.nodeHi = new Float64Array(capacity * 3);
    this.nodeBegin = new Uint32Array(capacity);
    this.nodeEnd = new Uint32Array(capacity);
    this.nodeLeft = new Uint32Array(capacity);
    this.nodeRight = new Uint32Array(capacity);
  }

  public get nodeCount(): number {
    return this.nodeCountInternal;
  }

  public get faceCount(): number {
    return this.order.length;
  }

  /**
   * Builds a tree over faces `[firstFace, endFace)`.
   *
   * `positions` holds one Float64 XYZ triple per TOPOLOGICAL vertex and
   * `triangles` three vertex ids per face — the same representation the exact
   * narrowphase takes, so a candidate pair means the same thing on both sides
   * of the boundary.
   */
  public static build(
    positions: Float64Array,
    triangles: Uint32Array,
    firstFace: number,
    endFace: number,
  ): FaceBvh {
    const count = Math.max(0, endFace - firstFace);
    const tree = new FaceBvh(count, firstFace);

    for (let slot = 0; slot < count; slot += 1) {
      const face = firstFace + slot;
      tree.order[slot] = slot;
      for (let axis = 0; axis < 3; axis += 1) {
        tree.boxLo[slot * 3 + axis] = Infinity;
        tree.boxHi[slot * 3 + axis] = -Infinity;
      }
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = triangles[face * 3 + corner] ?? 0;
        for (let axis = 0; axis < 3; axis += 1) {
          const value = positions[vertex * 3 + axis] ?? 0;
          if (value < (tree.boxLo[slot * 3 + axis] ?? Infinity))
            tree.boxLo[slot * 3 + axis] = value;
          if (value > (tree.boxHi[slot * 3 + axis] ?? -Infinity)) {
            tree.boxHi[slot * 3 + axis] = value;
          }
        }
      }
    }

    if (count > 0) tree.buildNode(0, count);
    return tree;
  }

  /**
   * Visits every face whose box overlaps `[lo, hi]`.
   *
   * STREAMING, NEVER ACCUMULATING. `visit` returns false to stop, and the stop
   * propagates all the way out of the descent — no list of candidate faces is
   * ever materialised, so memory does not grow with the number of overlaps.
   * Returns false when the traversal was stopped, either by the visitor or by a
   * budget.
   *
   * DETERMINISTIC ORDER: the left child is always descended before the right,
   * and leaf members are visited in the tree's own permutation order, which is
   * itself deterministic. The same query on the same tree always emits the same
   * candidates in the same sequence.
   */
  public queryBox(
    lo: readonly [number, number, number],
    hi: readonly [number, number, number],
    visit: (face: number) => boolean,
    counters: BroadphaseCounters,
    budget: BroadphaseBudget,
  ): boolean {
    if (this.nodeCountInternal === 0) return true;
    // An explicit stack rather than recursion: a degenerate tree must not be
    // able to exhaust the JavaScript call stack.
    const stack: number[] = [0];
    while (stack.length > 0) {
      const node = stack.pop() ?? 0;
      counters.nodeVisits += 1;
      if (counters.nodeVisits > budget.maxNodeVisits) return false;

      counters.aabbTests += 1;
      if (counters.aabbTests > budget.maxAabbTests) return false;
      if (!this.nodeOverlaps(node, lo, hi)) continue;

      const left = this.nodeLeft[node] ?? NO_CHILD;
      if (left !== NO_CHILD) {
        // Pushed right-then-left so the left child is popped first.
        stack.push(this.nodeRight[node] ?? NO_CHILD);
        stack.push(left);
        continue;
      }

      const begin = this.nodeBegin[node] ?? 0;
      const end = this.nodeEnd[node] ?? 0;
      for (let index = begin; index < end; index += 1) {
        const slot = this.order[index] ?? 0;
        counters.aabbTests += 1;
        if (counters.aabbTests > budget.maxAabbTests) return false;
        if (!this.slotOverlaps(slot, lo, hi)) continue;
        counters.candidates += 1;
        if (counters.candidates > budget.maxCandidates) return false;
        if (!visit(this.firstFace + slot)) return false;
      }
    }
    return true;
  }

  /** The exact box of one face, for use as a query. */
  public faceBox(face: number): { lo: [number, number, number]; hi: [number, number, number] } {
    const slot = face - this.firstFace;
    return {
      lo: [this.boxLo[slot * 3] ?? 0, this.boxLo[slot * 3 + 1] ?? 0, this.boxLo[slot * 3 + 2] ?? 0],
      hi: [this.boxHi[slot * 3] ?? 0, this.boxHi[slot * 3 + 1] ?? 0, this.boxHi[slot * 3 + 2] ?? 0],
    };
  }

  private nodeOverlaps(
    node: number,
    lo: readonly [number, number, number],
    hi: readonly [number, number, number],
  ): boolean {
    for (let axis = 0; axis < 3; axis += 1) {
      if ((this.nodeLo[node * 3 + axis] ?? 0) > (hi[axis] ?? 0)) return false;
      if ((lo[axis] ?? 0) > (this.nodeHi[node * 3 + axis] ?? 0)) return false;
    }
    return true;
  }

  private slotOverlaps(
    slot: number,
    lo: readonly [number, number, number],
    hi: readonly [number, number, number],
  ): boolean {
    for (let axis = 0; axis < 3; axis += 1) {
      if ((this.boxLo[slot * 3 + axis] ?? 0) > (hi[axis] ?? 0)) return false;
      if ((lo[axis] ?? 0) > (this.boxHi[slot * 3 + axis] ?? 0)) return false;
    }
    return true;
  }

  private buildNode(begin: number, end: number): number {
    const node = this.nodeCountInternal;
    this.nodeCountInternal += 1;
    this.nodeBegin[node] = begin;
    this.nodeEnd[node] = end;
    this.nodeLeft[node] = NO_CHILD;
    this.nodeRight[node] = NO_CHILD;

    for (let axis = 0; axis < 3; axis += 1) {
      this.nodeLo[node * 3 + axis] = Infinity;
      this.nodeHi[node * 3 + axis] = -Infinity;
    }
    for (let index = begin; index < end; index += 1) {
      const slot = this.order[index] ?? 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const low = this.boxLo[slot * 3 + axis] ?? 0;
        const high = this.boxHi[slot * 3 + axis] ?? 0;
        if (low < (this.nodeLo[node * 3 + axis] ?? Infinity)) this.nodeLo[node * 3 + axis] = low;
        if (high > (this.nodeHi[node * 3 + axis] ?? -Infinity)) {
          this.nodeHi[node * 3 + axis] = high;
        }
      }
    }

    if (end - begin <= LEAF_SIZE) return node;

    let axis = 0;
    let widest = -1;
    for (let candidate = 0; candidate < 3; candidate += 1) {
      const width =
        (this.nodeHi[node * 3 + candidate] ?? 0) - (this.nodeLo[node * 3 + candidate] ?? 0);
      if (width > widest) {
        widest = width;
        axis = candidate;
      }
    }

    const mid = begin + ((end - begin) >> 1);
    this.selectNth(begin, mid, end, axis);
    this.nodeLeft[node] = this.buildNode(begin, mid);
    this.nodeRight[node] = this.buildNode(mid, end);
    return node;
  }

  /**
   * Partial sort placing the element that belongs at `nth` there, with smaller
   * keys before it — `std::nth_element`, which is what `si_bvh.h` uses.
   *
   * A FULL SORT PER NODE WOULD BE O(n log² n) OVERALL and was measured too slow
   * at the 250,000-face ceiling. Quickselect keeps the build linear per level.
   *
   * DETERMINISTIC BY CONSTRUCTION: the pivot is the median of three fixed
   * positions, never a random one, and ties break on face slot exactly as the
   * C++ comparator does — which is what makes the candidate ORDER reproducible
   * across runs and machines.
   */
  private selectNth(begin: number, nth: number, end: number, axis: number): void {
    let low = begin;
    let high = end - 1;
    while (low < high) {
      const pivot = this.medianOfThree(low, high, axis);
      let left = low;
      let right = high;
      while (left <= right) {
        while (this.compare(this.order[left] ?? 0, pivot, axis) < 0) left += 1;
        while (this.compare(this.order[right] ?? 0, pivot, axis) > 0) right -= 1;
        if (left <= right) {
          const swap = this.order[left] ?? 0;
          this.order[left] = this.order[right] ?? 0;
          this.order[right] = swap;
          left += 1;
          right -= 1;
        }
      }
      if (nth <= right) high = right;
      else if (nth >= left) low = left;
      else return;
    }
  }

  private medianOfThree(low: number, high: number, axis: number): number {
    const middle = low + ((high - low) >> 1);
    const a = this.order[low] ?? 0;
    const b = this.order[middle] ?? 0;
    const c = this.order[high] ?? 0;
    if (this.compare(a, b, axis) < 0) {
      if (this.compare(b, c, axis) < 0) return b;
      return this.compare(a, c, axis) < 0 ? c : a;
    }
    if (this.compare(a, c, axis) < 0) return a;
    return this.compare(b, c, axis) < 0 ? c : b;
  }

  /** Orders by box centre on `axis`, breaking exact ties on slot index. */
  private compare(left: number, right: number, axis: number): number {
    const centreLeft = (this.boxLo[left * 3 + axis] ?? 0) + (this.boxHi[left * 3 + axis] ?? 0);
    const centreRight = (this.boxLo[right * 3 + axis] ?? 0) + (this.boxHi[right * 3 + axis] ?? 0);
    if (centreLeft !== centreRight) return centreLeft < centreRight ? -1 : 1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
}

/**
 * The exact box of a face, computed without a tree.
 *
 * Used for the patch queries themselves, so a query box and a stored box are
 * produced by the same arithmetic and an exact touch cannot fall between them.
 */
export function faceBoxOf(
  positions: Float64Array,
  triangles: Uint32Array,
  face: number,
): { lo: [number, number, number]; hi: [number, number, number] } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 3; corner += 1) {
    const vertex = triangles[face * 3 + corner] ?? 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[vertex * 3 + axis] ?? 0;
      if (value < (lo[axis] ?? Infinity)) lo[axis] = value;
      if (value > (hi[axis] ?? -Infinity)) hi[axis] = value;
    }
  }
  return { lo, hi };
}

/** Inclusive box overlap, matching `si_bvh.h`'s `boxes_overlap`. */
export function boxesOverlap(
  aLo: readonly [number, number, number],
  aHi: readonly [number, number, number],
  bLo: readonly [number, number, number],
  bHi: readonly [number, number, number],
): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((aLo[axis] ?? 0) > (bHi[axis] ?? 0)) return false;
    if ((bLo[axis] ?? 0) > (aHi[axis] ?? 0)) return false;
  }
  return true;
}
