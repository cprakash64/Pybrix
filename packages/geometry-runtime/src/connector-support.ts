/**
 * CONNECTOR MATERIAL-SUPPORT VALIDATION (Release 2, Slice 2D) — the `support-v1` rule, and the ONE implementation of it.
 *
 * `support-v1` (see `connector-policy.ts`) says: material support below the generated mating interface is no weaker,
 * geometrically, than the margin Pybrix already requires around the connector at that interface. It is a consistency invariant.
 * It claims nothing about strength, printability or manufacturing, and reads no unit, no clearance and no placement scale.
 *
 * TWO QUESTIONS, ONE PREDICATE. Both are the Slice 2C question ("does a boundary of the piece enter this cylinder?") asked of a
 * larger cylinder, with the SAME exact triangle test (`triangleBreachesSocket`), the SAME entry-cap exclusion by kernel
 * provenance, the SAME axis semantics and the SAME split tolerance. Nothing here is a second wall-thickness algorithm.
 *
 *   FEMALE. The socket volume (radius `r_socket`, depth `d_socket`: the very objects Slice 2C received) grown laterally to
 *     `r_socket + m` and beyond its far end to `d_socket + m`. The entry end is not grown: it lies on the interface.
 *   MALE.   The envelope behind the pin root: radius `r_pin + m`, depth `m`, measured from the interface INTO the male piece
 *     (the axis is the socket's, reversed). The pin radius comes from the request, never from the socket: clearance is not
 *     support.
 *
 * with `m = connectorSupportMargin(r_pin, tolerance)`. A piece passes iff NO non-entry boundary face enters its envelope. The
 * decision is taken directly at `m`; the numerical maximum margin is never computed in production.
 *
 * BROADPHASES. The female check reuses the tree Slice 2C already built over the female piece (`ReceivingBroadphase`): ONE female
 * tree per plan across both checks. The male check builds NO tree and keeps NO per-face index: it makes one linear pass over the
 * male piece's faces with a box test against each envelope, then the exact test on the survivors. A tree over a million faces is a
 * synchronous half-second pass that cannot be interrupted; at the few sockets a plan carries a linear pass is an order of
 * magnitude cheaper, allocates nothing proportional to the mesh, and polls the cancellation token every `SCAN_CHECKPOINT_FACES`
 * faces so a Cancel is honoured within one stride. Candidacy proves nothing in either: every candidate is tested exactly.
 *
 * It runs no Boolean, searches for no other site, shrinks nothing, and imports nothing from React, Three.js, `apps/**`,
 * `mesh-hole-fill`, `file-formats` or any network API.
 */
import { throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import {
  ENTRY_CAP_PROVENANCE,
  perpendicularBasis,
  pieceProblem,
  queryTreeForBreach,
  sweepBox,
  sweepIsUsable,
  triangleBreachesSocket,
  type AxialUnavailableReason,
  type BuiltBroadphase,
  type ReceivingBroadphase,
  type ReceivingPiece,
  type SocketSweep,
} from './connector-axial';
import { ConnectorRefusal, type SupportRefusal } from './connector-plan';
import { SUPPORT_POLICY_ID } from './connector-policy';
import type { SplitVector } from './split-connectors';

/**
 * How often the male scan polls the cancellation token, in faces. Polling is a cheap read of a shared word; 4,096 faces is ~30 µs of
 * scanning, so a Cancel is honoured within well under a millisecond of work, and a pass over two million faces polls ~490 times.
 */
export const SCAN_CHECKPOINT_FACES = 4096;

/**
 * Which part of the grown socket envelope holds a female failure: beside it, beyond its far end, both, or only in the corner
 * where the two meet (a boundary that neither the sideways growth nor the far-end growth reaches on its own).
 */
export type SupportDimension = 'LATERAL' | 'FAR_END' | 'LATERAL_AND_FAR_END' | 'CORNER';

export type SupportUnavailableReason = AxialUnavailableReason;

export interface SupportFailure {
  readonly role: 'FEMALE' | 'MALE';
  readonly pairId: string;
  /** The first breaching face (an index into that role's piece): lowest face index for the male scan, tree order for the female. */
  readonly faceIndex: number;
  /** Radius and depth of the envelope that was tested. */
  readonly radius: number;
  readonly depth: number;
  /** Female only: where in the grown socket the boundary is. */
  readonly dimension?: SupportDimension;
}

export interface SupportStats {
  /** Trees the shared female broadphase has built so far (0 or 1). The male check builds none. */
  readonly femaleBuilds: number;
  readonly femaleQueries: number;
  readonly femaleCandidates: number;
  readonly femaleExactTests: number;
  /** The male pass: faces read, faces that met an envelope's box, exact tests, and cancellation polls. */
  readonly maleFacesExamined: number;
  readonly maleBoxCandidates: number;
  readonly maleExactTests: number;
  readonly maleCheckpoints: number;
}

export type SupportValidation =
  | {
      readonly ok: true;
      readonly policy: typeof SUPPORT_POLICY_ID;
      readonly margin: number;
      readonly checked: number;
      readonly stats: SupportStats;
    }
  | {
      readonly ok: false;
      readonly refusal: Exclude<
        SupportRefusal,
        typeof ConnectorRefusal.SUPPORT_VALIDATION_UNAVAILABLE
      >;
      readonly policy: typeof SUPPORT_POLICY_ID;
      readonly margin: number;
      readonly checked: number;
      /** Every failure found, female before male, so a plan that is wrong in both ways says so. */
      readonly failures: readonly SupportFailure[];
      readonly stats: SupportStats;
    }
  | {
      readonly ok: false;
      readonly refusal: typeof ConnectorRefusal.SUPPORT_VALIDATION_UNAVAILABLE;
      readonly policy: typeof SUPPORT_POLICY_ID;
      readonly reason: SupportUnavailableReason;
      readonly role: 'FEMALE' | 'MALE' | 'PLAN';
      readonly stats: SupportStats;
    };

export interface SupportInput {
  /** The female (receiving) piece, exactly as the kernel produced it: the same object Slice 2C examined. */
  readonly female: ReceivingPiece;
  /** The broadphase Slice 2C built over `female`; it is built by whichever check asks first, and only once. */
  readonly femaleBroadphase: ReceivingBroadphase;
  /** The piece the pin grows from. */
  readonly male: ReceivingPiece;
  /** The sockets, as Slice 2C received them: centre, axis INTO the female piece, socket radius and depth. */
  readonly sockets: readonly SocketSweep[];
  /** The pin radius from the request (`diameter / 2`): clearance is not part of it. */
  readonly pinRadius: number;
  /** `connectorSupportMargin(pinRadius, tolerance)`; passed in so a test can hold the validator to any margin. */
  readonly margin: number;
  readonly tolerance: number;
  readonly cancellation: CancellationToken;
}

/** What a person can be told. No distance, no unit, no strength: only what was checked. */
export function describeSupportFailure(refusal: SupportRefusal): string {
  switch (refusal) {
    case ConnectorRefusal.SOCKET_SUPPORT_INSUFFICIENT:
      return 'Not enough material around the socket: it would leave less material beside or behind it than Pybrix already requires at the cut surface.';
    case ConnectorRefusal.PIN_ROOT_SUPPORT_INSUFFICIENT:
      return 'Not enough material around the pin base: it would sit on less material than Pybrix already requires around a connector at the cut surface.';
    case ConnectorRefusal.SUPPORT_VALIDATION_UNAVAILABLE:
      return 'The material around the connector could not be checked, so the connector was not added.';
  }
}

const NO_STATS: SupportStats = Object.freeze({
  femaleBuilds: 0,
  femaleQueries: 0,
  femaleCandidates: 0,
  femaleExactTests: 0,
  maleFacesExamined: 0,
  maleBoxCandidates: 0,
  maleExactTests: 0,
  maleCheckpoints: 0,
});

const reverse = (axis: SplitVector): SplitVector => [-axis[0] + 0, -axis[1] + 0, -axis[2] + 0];

interface LinearScan {
  readonly failures: Map<number, number>;
  readonly facesExamined: number;
  readonly boxCandidates: number;
  readonly exactTests: number;
  readonly checkpoints: number;
}

/**
 * One checkpointed pass over a piece for every sweep at once: a face is read, its box is compared with each live sweep's box, and
 * the survivors get the exact test. A sweep that has breached is retired (its first, lowest-indexed breaching face is kept), so
 * the pass ends early once none is live. Nothing is allocated per face.
 */
function scanPieceLinear(
  piece: ReceivingPiece,
  sweeps: readonly SocketSweep[],
  tolerance: number,
  cancellation: CancellationToken,
): LinearScan {
  const { positions, indices } = piece.mesh,
    faces = indices.length / 3,
    boxes = sweeps.map((sweep) => ({
      sweep,
      basis: perpendicularBasis(sweep.axis),
      ...sweepBox(sweep, tolerance),
    })),
    failures = new Map<number, number>();
  let live = boxes.length,
    boxCandidates = 0,
    exactTests = 0,
    checkpoints = 0,
    examined = 0;
  for (let face = 0; face < faces && live > 0; face++) {
    if (face % SCAN_CHECKPOINT_FACES === 0) {
      throwIfCancelled(cancellation);
      checkpoints++;
    }
    examined++;
    if (piece.provenance[face] === ENTRY_CAP_PROVENANCE) continue;
    const ia = (indices[face * 3] ?? 0) * 3,
      ib = (indices[face * 3 + 1] ?? 0) * 3,
      ic = (indices[face * 3 + 2] ?? 0) * 3;
    for (let b = 0; b < boxes.length; b++) {
      if (failures.has(b)) continue;
      const box = boxes[b];
      if (box === undefined) continue;
      let outside = false;
      for (let k = 0; k < 3; k++) {
        const x = positions[ia + k] ?? 0,
          y = positions[ib + k] ?? 0,
          z = positions[ic + k] ?? 0;
        if (Math.max(x, y, z) < (box.lo[k] ?? 0) || Math.min(x, y, z) > (box.hi[k] ?? 0)) {
          outside = true;
          break;
        }
      }
      if (outside) continue;
      boxCandidates++;
      exactTests++;
      if (
        triangleBreachesSocket(
          box.sweep,
          box.basis,
          tolerance,
          [positions[ia] ?? 0, positions[ia + 1] ?? 0, positions[ia + 2] ?? 0],
          [positions[ib] ?? 0, positions[ib + 1] ?? 0, positions[ib + 2] ?? 0],
          [positions[ic] ?? 0, positions[ic + 1] ?? 0, positions[ic + 2] ?? 0],
        )
      ) {
        failures.set(b, face);
        live--;
      }
    }
  }
  return { failures, facesExamined: examined, boxCandidates, exactTests, checkpoints };
}

/**
 * Where in the grown socket the boundary is, by two more queries of the same shared tree: the socket grown only sideways, and
 * only beyond its far end. They run on a refusal only. Which of the two a boundary is found by does not depend on how the kernel
 * happened to triangulate a wall (a single breaching face can straddle both), which is why the answer is asked of the whole
 * piece and not of the first face the broadphase offered.
 */
function classifyFemaleFailure(
  built: BuiltBroadphase,
  piece: ReceivingPiece,
  socket: SocketSweep,
  margin: number,
  tolerance: number,
): SupportDimension {
  const lateral =
      queryTreeForBreach(built, piece, { ...socket, radius: socket.radius + margin }, tolerance)
        .breach >= 0,
    farEnd =
      queryTreeForBreach(built, piece, { ...socket, depth: socket.depth + margin }, tolerance)
        .breach >= 0;
  if (lateral && farEnd) return 'LATERAL_AND_FAR_END';
  if (lateral) return 'LATERAL';
  if (farEnd) return 'FAR_END';
  return 'CORNER';
}

export function validateConnectorSupport(input: SupportInput): SupportValidation {
  const { female, femaleBroadphase, male, sockets, pinRadius, margin, tolerance, cancellation } =
    input;
  const unavailable = (
    reason: SupportUnavailableReason,
    role: 'FEMALE' | 'MALE' | 'PLAN',
    stats: SupportStats = NO_STATS,
  ): SupportValidation => ({
    ok: false,
    refusal: ConnectorRefusal.SUPPORT_VALIDATION_UNAVAILABLE,
    policy: SUPPORT_POLICY_ID,
    reason,
    role,
    stats,
  });
  if (sockets.length === 0)
    return { ok: true, policy: SUPPORT_POLICY_ID, margin, checked: 0, stats: NO_STATS };
  if (
    !Number.isFinite(margin) ||
    !(margin > 0) ||
    !Number.isFinite(pinRadius) ||
    !(pinRadius > 0) ||
    !Number.isFinite(tolerance) ||
    !(tolerance >= 0)
  )
    return unavailable('INVALID_SWEEP', 'PLAN');
  const femaleProblem = pieceProblem(female, tolerance);
  if (femaleProblem !== undefined) return unavailable(femaleProblem, 'FEMALE');
  const maleProblem = pieceProblem(male, tolerance);
  if (maleProblem !== undefined) return unavailable(maleProblem, 'MALE');

  // The envelopes. Female: the socket the caller validated, grown. Male: the pin root's disc grown, pointing into the male piece.
  const femaleSweeps: SocketSweep[] = sockets.map((socket) => ({
      ...socket,
      radius: socket.radius + margin,
      depth: socket.depth + margin,
    })),
    maleSweeps: SocketSweep[] = sockets.map((socket) => ({
      pairId: socket.pairId,
      center: socket.center,
      axis: reverse(socket.axis),
      radius: pinRadius + margin,
      depth: margin,
    }));
  for (const sweep of [...sockets, ...femaleSweeps, ...maleSweeps])
    if (!sweepIsUsable(sweep, tolerance)) return unavailable('INVALID_SWEEP', 'PLAN');

  // FEMALE — the shared tree, one query per socket.
  throwIfCancelled(cancellation);
  const built = femaleBroadphase.acquire(cancellation);
  if (built === 'RESOURCE_LIMIT') return unavailable('RESOURCE_LIMIT', 'FEMALE');
  let femaleQueries = 0,
    femaleCandidates = 0,
    femaleExactTests = 0;
  const failures: SupportFailure[] = [];
  const stats = (male_: Partial<SupportStats> = {}): SupportStats => ({
    ...NO_STATS,
    femaleBuilds: femaleBroadphase.builds,
    femaleQueries,
    femaleCandidates,
    femaleExactTests,
    ...male_,
  });
  for (const [index, sweep] of femaleSweeps.entries()) {
    throwIfCancelled(cancellation);
    const result = queryTreeForBreach(built, female, sweep, tolerance),
      socket = sockets[index];
    femaleQueries++;
    femaleCandidates += result.candidates;
    femaleExactTests += result.exactTests;
    if (result.breach >= 0 && socket !== undefined)
      failures.push({
        role: 'FEMALE',
        pairId: sweep.pairId,
        faceIndex: result.breach,
        radius: sweep.radius,
        depth: sweep.depth,
        dimension: classifyFemaleFailure(built, female, socket, margin, tolerance),
      });
    else if (!result.finished) return unavailable('BROADPHASE_BUDGET', 'FEMALE', stats());
  }

  // MALE — one checkpointed linear pass, no tree.
  const scan = scanPieceLinear(male, maleSweeps, tolerance, cancellation);
  for (const [index, face] of [...scan.failures.entries()].sort((x, y) => x[0] - y[0])) {
    const sweep = maleSweeps[index];
    if (sweep !== undefined)
      failures.push({
        role: 'MALE',
        pairId: sweep.pairId,
        faceIndex: face,
        radius: sweep.radius,
        depth: sweep.depth,
      });
  }
  const finalStats = stats({
    maleFacesExamined: scan.facesExamined,
    maleBoxCandidates: scan.boxCandidates,
    maleExactTests: scan.exactTests,
    maleCheckpoints: scan.checkpoints,
  });
  if (failures.length === 0)
    return {
      ok: true,
      policy: SUPPORT_POLICY_ID,
      margin,
      checked: sockets.length,
      stats: finalStats,
    };
  const firstFemale = failures.some((failure) => failure.role === 'FEMALE');
  return {
    ok: false,
    refusal: firstFemale
      ? ConnectorRefusal.SOCKET_SUPPORT_INSUFFICIENT
      : ConnectorRefusal.PIN_ROOT_SUPPORT_INSUFFICIENT,
    policy: SUPPORT_POLICY_ID,
    margin,
    checked: sockets.length,
    failures,
    stats: finalStats,
  };
}
