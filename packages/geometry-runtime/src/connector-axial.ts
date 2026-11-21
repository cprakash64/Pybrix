/**
 * CONNECTOR AXIAL RECEIVING-MATERIAL VALIDATION (Release 2, Slice 2C).
 *
 * One physical question, and nothing else: is there receiving material throughout the socket volume the connector Boolean
 * is about to cut, or does that volume run into a boundary of the receiving piece before its full depth?
 *
 * THE SOCKET VOLUME is the right circular cylinder the Boolean subtracts: axis through the site along the female insertion
 * direction (the interface frame's normal, signed by which piece is male), radius = the socket mouth (`roundSocketRadius`),
 * axial extent `[0, depth]` from the interface plane. The caller passes the very numbers it passes to `cylinder(...)`, so the
 * validated and the constructed socket cannot differ: nothing here derives a dimension.
 *
 * THE RECEIVING PIECE is the female piece exactly as the kernel produced it, and only it. Every triangle of it is a
 * boundary of that piece except the ENTRY CAP: the faces the kernel generated where the two pieces meet, which carry
 * provenance `-1` (a source face carries its non-negative source index). Excluding by provenance and not by position is
 * the point: a ledge of the source coplanar with the cut is a real boundary and is NOT excluded (audit N2, Slice 2B).
 *
 * THE RULE. A boundary triangle T BREACHES the socket iff some point p of T has
 *
 *     axial(p) in [-tolerance, depth + tolerance]   and   radial(p) < radius - tolerance.
 *
 * `tolerance` is the split tolerance the kernel returns, the same number Slice 2B uses. The two sides are deliberately not
 * symmetric, and both are the conservative reading of that one tolerance:
 *   - axially, a boundary at or within `tolerance` BEYOND the socket end breaches: a remaining wall of zero thickness is a
 *     through-opening, and the Boolean would leave coincident faces;
 *   - radially, a boundary that reaches into the socket by at most `tolerance` does not: that is exactly the band in which
 *     Slice 2B already accepted the footprint as contained, so 2B and 2C cannot disagree about the same sliver.
 * If the receiving piece has no breaching triangle, the whole closed socket volume lies in its material: the volume is
 * connected, starts on the entry cap (material side) and meets no other boundary.
 *
 * EXACTNESS. For one triangle the test is exact up to double rounding, with no sampling: clip the triangle to the axial
 * slab (a convex polygon), project it along the axis (a convex polygon in the plane), and compare the exact distance from
 * the axis point to that polygon with `radius - tolerance`. A point is within radius of the axis iff its projection is, so
 * the polygon meets the open cylinder iff that distance is below the radius.
 *
 * `FaceBvh` is the BROADPHASE ONLY. One tree is built per PLAN over the receiving piece (lazily, by the first check that needs
 * it: `createReceivingBroadphase`) and reused by every socket of the plan AND by the Slice 2D support check, which asks the same
 * question of a larger sweep; a candidate is a triangle whose box meets the sweep's box, and is then tested exactly. Candidacy
 * proves nothing.
 *
 * It decides nothing about lateral wall thickness, root support (Slice 2D asks those of a larger sweep through the same
 * predicate), units, or another site; it runs no Boolean and searches for nothing. It imports a TYPE from the kernel family and the shared broadphase, and nothing from React, Three.js, `apps/**`,
 * `mesh-hole-fill`, `file-formats` or any network API.
 */
import { createCounters, FaceBvh, type BroadphaseBudget } from '@cadfixer/mesh-core/spatial';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import { ConnectorRefusal, type AxialRefusal } from './connector-plan';
import type { SplitVector } from './split-connectors';

/** Provenance the kernel gives a face it generated where the pieces meet (a source face has its non-negative index). */
export const ENTRY_CAP_PROVENANCE = -1;

export interface SocketSweep {
  /** The plan pair this socket belongs to. */
  readonly pairId: string;
  /** The site, in the receiving piece's coordinates. */
  readonly center: SplitVector;
  /** Unit direction from the interface INTO the receiving piece. */
  readonly axis: SplitVector;
  /** The socket mouth: the radius passed to the Boolean primitive. */
  readonly radius: number;
  /** The depth passed to the Boolean primitive. */
  readonly depth: number;
}

export interface ReceivingPiece {
  readonly mesh: CanonicalMesh;
  /** One entry per face: `ENTRY_CAP_PROVENANCE` for a generated entry-cap face, the source index otherwise. */
  readonly provenance: Int32Array;
  /** The kernel's own closed-solid verdict for this piece (valid, no boundary edge, no winding conflict). */
  readonly closed: boolean;
}

export type AxialUnavailableReason =
  | 'PIECE_NOT_CLOSED'
  | 'PROVENANCE_MISMATCH'
  | 'INVALID_SWEEP'
  | 'BROADPHASE_BUDGET'
  | 'RESOURCE_LIMIT';

export interface AxialStats {
  /** Trees the shared broadphase has built so far: 0 when nothing needed one, otherwise exactly 1 per plan. */
  readonly builds: number;
  readonly queries: number;
  readonly candidates: number;
  readonly exactTests: number;
}

export interface AxialFailure {
  readonly pairId: string;
  /** The first breaching face in the broadphase's deterministic order (an index into the receiving piece). */
  readonly faceIndex: number;
  readonly radius: number;
  readonly depth: number;
}

export type AxialValidation =
  | { readonly ok: true; readonly checked: number; readonly stats: AxialStats }
  | {
      readonly ok: false;
      readonly refusal: typeof ConnectorRefusal.SOCKET_BREAKTHROUGH;
      readonly checked: number;
      readonly failures: readonly AxialFailure[];
      readonly stats: AxialStats;
    }
  | {
      readonly ok: false;
      readonly refusal: typeof ConnectorRefusal.AXIAL_VALIDATION_UNAVAILABLE;
      readonly reason: AxialUnavailableReason;
      readonly stats: AxialStats;
    };

/** What a person can be told. */
export function describeAxialFailure(refusal: AxialRefusal): string {
  switch (refusal) {
    case ConnectorRefusal.SOCKET_BREAKTHROUGH:
      return 'The connector does not fit in the receiving piece: its socket would reach another surface before its full depth.';
    case ConnectorRefusal.AXIAL_VALIDATION_UNAVAILABLE:
      return 'The material behind the connector could not be checked, so the connector was not added.';
  }
}

const NO_STATS: AxialStats = Object.freeze({ builds: 0, queries: 0, candidates: 0, exactTests: 0 });

type Vec3 = readonly [number, number, number];
const ORIGIN: Vec3 = [0, 0, 0];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** An orthonormal pair perpendicular to a unit axis, chosen deterministically from the axis alone. */
export function perpendicularBasis(axis: Vec3): { readonly u: Vec3; readonly v: Vec3 } {
  const reference: Vec3 = Math.abs(axis[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0],
    cross = (a: Vec3, b: Vec3): Vec3 => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ],
    c = cross(axis, reference),
    length = Math.hypot(c[0], c[1], c[2]),
    u: Vec3 = [c[0] / length, c[1] / length, c[2] / length];
  return { u, v: cross(axis, u) };
}

function originSegmentDistance(ax: number, ay: number, bx: number, by: number): number {
  // distance from the origin to the segment a-b
  const dx = bx - ax,
    dy = by - ay,
    lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(ax, ay);
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Sutherland-Hodgman against one axial half-space: keeps `a >= bound` (lower) or `a <= bound` (upper). */
function clipAxial(polygon: readonly Vec3[], bound: number, keepAbove: boolean): Vec3[] {
  const out: Vec3[] = [],
    inside = (p: Vec3): boolean => (keepAbove ? p[2] >= bound : p[2] <= bound);
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i] ?? ORIGIN,
      q = polygon[(i + 1) % polygon.length] ?? ORIGIN,
      pIn = inside(p),
      qIn = inside(q);
    if (pIn) out.push(p);
    if (pIn !== qIn) {
      const t = (bound - p[2]) / (q[2] - p[2]);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), bound]);
    }
  }
  return out;
}

/**
 * Whether one triangle breaches one socket. The triangle's corners are given in the receiving piece's coordinates.
 * Exported so the reference checks can hold the production decision to an independent brute-force one.
 */
export function triangleBreachesSocket(
  sweep: SocketSweep,
  basis: { readonly u: Vec3; readonly v: Vec3 },
  tolerance: number,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): boolean {
  const toLocal = (p: Vec3): Vec3 => {
    const d: Vec3 = [p[0] - sweep.center[0], p[1] - sweep.center[1], p[2] - sweep.center[2]];
    return [dot3(d, basis.u), dot3(d, basis.v), dot3(d, sweep.axis)];
  };
  const slab = clipAxial(
    clipAxial([toLocal(a), toLocal(b), toLocal(c)], -tolerance, true),
    sweep.depth + tolerance,
    false,
  );
  if (slab.length === 0) return false;
  const reach = sweep.radius - tolerance;
  // The projection of a convex planar polygon along the axis is a convex polygon (possibly a segment or a point). The axis
  // point is inside it, or its nearest point is on an edge.
  let positive = 0,
    negative = 0,
    nearest = Infinity;
  for (let i = 0; i < slab.length; i++) {
    const p = slab[i] ?? ORIGIN,
      q = slab[(i + 1) % slab.length] ?? ORIGIN;
    nearest = Math.min(nearest, originSegmentDistance(p[0], p[1], q[0], q[1]));
    const side = p[0] * q[1] - p[1] * q[0];
    if (side > 0) positive++;
    else if (side < 0) negative++;
  }
  const inside =
    slab.length >= 3 && ((positive > 0 && negative === 0) || (negative > 0 && positive === 0));
  return (inside ? 0 : nearest) < reach;
}

/** Why a piece cannot be examined, or `undefined` when it can. The same preconditions guard every check that reads a piece. */
export function pieceProblem(
  piece: ReceivingPiece,
  tolerance: number,
): AxialUnavailableReason | undefined {
  const faces = piece.mesh.indices.length / 3;
  if (!piece.closed) return 'PIECE_NOT_CLOSED';
  if (!Number.isInteger(faces) || faces < 4 || piece.provenance.length !== faces)
    return 'PROVENANCE_MISMATCH';
  if (!Number.isFinite(tolerance) || !(tolerance >= 0)) return 'INVALID_SWEEP';
  return undefined;
}

/** Whether a sweep can be tested at all: finite, a unit axis, a radius above the tolerance, a positive depth. */
export function sweepIsUsable(sweep: SocketSweep, tolerance: number): boolean {
  return (
    sweep.center.every(Number.isFinite) &&
    sweep.axis.every(Number.isFinite) &&
    Math.abs(Math.hypot(...sweep.axis) - 1) <= 1e-9 &&
    Number.isFinite(sweep.radius) &&
    sweep.radius > tolerance &&
    Number.isFinite(sweep.depth) &&
    sweep.depth > 0
  );
}

/** The box of a sweep (a cylinder): its two end centres' box, grown by the end disc's extent on each axis, plus the tolerance. */
export function sweepBox(
  sweep: SocketSweep,
  tolerance: number,
): { readonly lo: [number, number, number]; readonly hi: [number, number, number] } {
  const near: Vec3 = [
      sweep.center[0] - sweep.axis[0] * tolerance,
      sweep.center[1] - sweep.axis[1] * tolerance,
      sweep.center[2] - sweep.axis[2] * tolerance,
    ],
    far: Vec3 = [
      sweep.center[0] + sweep.axis[0] * (sweep.depth + tolerance),
      sweep.center[1] + sweep.axis[1] * (sweep.depth + tolerance),
      sweep.center[2] + sweep.axis[2] * (sweep.depth + tolerance),
    ],
    lo: [number, number, number] = [0, 0, 0],
    hi: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const spread = sweep.radius * Math.sqrt(Math.max(0, 1 - (sweep.axis[k] ?? 0) ** 2)) + tolerance;
    lo[k] = Math.min(near[k] ?? 0, far[k] ?? 0) - spread;
    hi[k] = Math.max(near[k] ?? 0, far[k] ?? 0) + spread;
  }
  return { lo, hi };
}

/** A built broadphase over one receiving piece: the tree and the Float64 positions it was built from. */
export interface BuiltBroadphase {
  readonly tree: FaceBvh;
  readonly positions: Float64Array;
}

/**
 * THE ONE FEMALE BROADPHASE OF A PLAN. Created cheaply (nothing is built); the first `acquire` builds the tree, every later one
 * returns the same object, so the Slice 2C depth check and the Slice 2D support check share exactly one build, whichever asks
 * first. `builds` is the number of trees built so far (0 or 1) and is what the stats report.
 * The build is one synchronous pass that cannot poll a flag: a Cancel is honoured before it, not inside it.
 */
export interface ReceivingBroadphase {
  readonly builds: number;
  acquire(cancellation: CancellationToken): BuiltBroadphase | 'RESOURCE_LIMIT';
}

export function createReceivingBroadphase(piece: ReceivingPiece): ReceivingBroadphase {
  let built: BuiltBroadphase | 'RESOURCE_LIMIT' | undefined,
    builds = 0;
  return {
    get builds(): number {
      return builds;
    },
    acquire(cancellation: CancellationToken): BuiltBroadphase | 'RESOURCE_LIMIT' {
      if (built !== undefined) return built;
      throwIfCancelled(cancellation);
      const { mesh } = piece;
      try {
        const positions = Float64Array.from(mesh.positions);
        const tree = FaceBvh.build(positions, mesh.indices, 0, mesh.indices.length / 3);
        builds = 1;
        built = { tree, positions };
      } catch (error) {
        // An allocation failure is a resource refusal of THIS check, never a pass and never an untyped internal failure.
        if (error instanceof RangeError) {
          built = 'RESOURCE_LIMIT';
          return built;
        }
        throw error;
      }
      return built;
    },
  };
}

export interface TreeQuery {
  /** The first breaching face in the broadphase's deterministic order, or -1. */
  readonly breach: number;
  /** False when the broadphase stopped on its budget before the traversal finished. */
  readonly finished: boolean;
  readonly candidates: number;
  readonly exactTests: number;
}

/**
 * One sweep against the shared tree: the box query, then the exact test of every candidate that is not the entry cap.
 * Slice 2C calls it with the socket as it is; Slice 2D calls it with the socket grown by the support margin.
 */
export function queryTreeForBreach(
  built: BuiltBroadphase,
  piece: ReceivingPiece,
  sweep: SocketSweep,
  tolerance: number,
): TreeQuery {
  const faces = piece.mesh.indices.length / 3,
    { tree, positions } = built,
    indices = piece.mesh.indices,
    // A correct traversal enters each node once and tests each leaf face once, so these can never fire spuriously; they guard
    // a defect in the tree, which must fail closed rather than pass a socket unexamined.
    budget: BroadphaseBudget = {
      maxNodeVisits: tree.nodeCount,
      maxAabbTests: tree.nodeCount + faces,
      maxCandidates: faces,
    },
    basis = perpendicularBasis(sweep.axis),
    { lo, hi } = sweepBox(sweep, tolerance),
    counters = createCounters();
  let breach = -1,
    exactTests = 0;
  const finished = tree.queryBox(
    lo,
    hi,
    (face) => {
      if (piece.provenance[face] === ENTRY_CAP_PROVENANCE) return true;
      exactTests++;
      const ia = (indices[face * 3] ?? 0) * 3,
        ib = (indices[face * 3 + 1] ?? 0) * 3,
        ic = (indices[face * 3 + 2] ?? 0) * 3;
      if (
        triangleBreachesSocket(
          sweep,
          basis,
          tolerance,
          [positions[ia] ?? 0, positions[ia + 1] ?? 0, positions[ia + 2] ?? 0],
          [positions[ib] ?? 0, positions[ib + 1] ?? 0, positions[ib + 2] ?? 0],
          [positions[ic] ?? 0, positions[ic + 1] ?? 0, positions[ic + 2] ?? 0],
        )
      ) {
        breach = face;
        return false;
      }
      return true;
    },
    counters,
    budget,
  );
  return { breach, finished, candidates: counters.candidates, exactTests };
}

export function validateSocketDepth(
  piece: ReceivingPiece,
  sweeps: readonly SocketSweep[],
  tolerance: number,
  cancellation: CancellationToken,
  broadphase: ReceivingBroadphase = createReceivingBroadphase(piece),
): AxialValidation {
  if (sweeps.length === 0) return { ok: true, checked: 0, stats: NO_STATS };
  const unavailable = (
    reason: AxialUnavailableReason,
    stats: AxialStats = NO_STATS,
  ): AxialValidation => ({
    ok: false,
    refusal: ConnectorRefusal.AXIAL_VALIDATION_UNAVAILABLE,
    reason,
    stats,
  });
  const problem = pieceProblem(piece, tolerance);
  if (problem !== undefined) return unavailable(problem);
  for (const sweep of sweeps)
    if (!sweepIsUsable(sweep, tolerance)) return unavailable('INVALID_SWEEP');

  // ONE tree per plan, over the receiving piece alone, bound to this exact mesh object. Positions are widened to Float64
  // (exact); nothing is cached beyond the plan. The build cannot poll a flag, so a Cancel is honoured before it and between sockets.
  throwIfCancelled(cancellation);
  const built = broadphase.acquire(cancellation);
  if (built === 'RESOURCE_LIMIT') return unavailable('RESOURCE_LIMIT');
  let queries = 0,
    candidates = 0,
    exactTests = 0;
  const stats = (): AxialStats => ({ builds: broadphase.builds, queries, candidates, exactTests });
  const failures: AxialFailure[] = [];
  for (const sweep of sweeps) {
    throwIfCancelled(cancellation);
    const result = queryTreeForBreach(built, piece, sweep, tolerance);
    queries++;
    candidates += result.candidates;
    exactTests += result.exactTests;
    if (result.breach >= 0)
      failures.push({
        pairId: sweep.pairId,
        faceIndex: result.breach,
        radius: sweep.radius,
        depth: sweep.depth,
      });
    else if (!result.finished) return unavailable('BROADPHASE_BUDGET', stats());
  }
  return failures.length === 0
    ? { ok: true, checked: sweeps.length, stats: stats() }
    : {
        ok: false,
        refusal: ConnectorRefusal.SOCKET_BREAKTHROUGH,
        checked: sweeps.length,
        failures,
        stats: stats(),
      };
}
