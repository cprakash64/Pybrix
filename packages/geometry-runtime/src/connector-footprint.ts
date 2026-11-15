/**
 * CONNECTOR FOOTPRINT CONTAINMENT (Release 2, Slice 2B).
 *
 * One physical question, and nothing else: does every connector footprint that crosses the cut plane lie inside the
 * material where the two generated pieces actually mate?
 *
 *  - THE AUTHORITY is the `GeneratedSeparationInterface` the closed-plane kernel produced: its boundary loops, in the
 *    interface's own `(u, v)` frame. Not the connector compatibility surface (which can include coplanar faces of the
 *    source that are not part of the cut — audit N2), not a bounding box, not a raster.
 *  - THE REGION is `deriveInterfaceRegion`'s even-odd nesting of those loops: material at odd depth, an opening or the
 *    exterior at even depth. The kernel's own cap triangulation uses the same parity rule, and the kernel refuses any
 *    pair of loops that touch or cross, so the loops are simple and pairwise disjoint and the rule is exact.
 *  - THE FOOTPRINT is a circle: the socket mouth, `diameter / 2 + clearance` (`roundSocketRadius`), the larger of the pin and
 *    the socket and the dimension the geometry is generated from. The generated cylinder is a polygon inscribed in that
 *    circle, so the circle is the conservative bound.
 *  - THE RULE is exact for a disk and a set of disjoint simple closed curves: the disk lies in the material if and only if
 *    its centre is at odd depth AND its distance to every loop is at least its radius. The distance is the exact
 *    point-to-segment distance; nothing is sampled and nothing is rasterised.
 *  - THE TOLERANCE is the split tolerance the kernel already returns (`ClosedPlaneClip.tolerance`, which is also the unit
 *    of the connector's own edge margin, `8 * tolerance`, and of the kernel's coplanarity test, `4 * tolerance`). A
 *    footprint that touches a loop, or passes it by less than that tolerance, is contained. No manufacturing margin is
 *    invented here: a clearance policy is a later slice.
 *
 * It decides nothing about wall thickness, depth, exterior breakthrough, units or part scale, searches for no other site,
 * and runs no Boolean. It reads the interface and the plan and returns facts; the caller refuses.
 *
 * It imports the planner's value exports and only a TYPE from the kernel, and nothing from React, Three.js, `apps/**`,
 * `mesh-hole-fill`, `file-formats` or any network API.
 */
import type { GeneratedSeparationInterface } from './closed-plane-kernel';
import {
  ConnectorRefusal,
  deriveInterfaceRegion,
  type FootprintRefusal,
  type InterfaceRegion,
  type ValidatedConnectorPlan,
} from './connector-plan';

export interface FootprintFailure {
  readonly refusal: FootprintRefusal;
  /** The pair whose footprint failed, in the order the resolver returned the sites. */
  readonly pairId: string;
  readonly footprint: { readonly u: number; readonly v: number; readonly radius: number };
  /** The boundary loop that decided the reason: the one the circle reaches past, else the nearest to its centre. */
  readonly loopId?: number;
  /** Whether the footprint's CENTRE is in material. A centre in the exterior or in an opening is never contained. */
  readonly centerInMaterial: boolean;
  /** How far the circle reaches past that loop (radius minus distance). Absent when the centre is not in material. */
  readonly overreach?: number;
}

export type FootprintContainment =
  | { readonly ok: true; readonly checked: number }
  | {
      readonly ok: false;
      readonly checked: number;
      readonly failures: readonly FootprintFailure[];
    };

/** What a person can be told. No geometry words a user would not recognise, and no claim beyond the cut surface. */
export function describeFootprintFailure(refusal: FootprintRefusal): string {
  switch (refusal) {
    case ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE:
      return 'The connector does not fit on the cut surface: part of it would fall outside the area where the two pieces meet.';
    case ConnectorRefusal.FOOTPRINT_INTERSECTS_VOID:
      return 'The connector does not fit on the cut surface: part of it would fall over an opening in the area where the two pieces meet.';
    case ConnectorRefusal.INTERFACE_REGION_UNAVAILABLE:
      return 'The area where the two pieces meet could not be established, so the connector was not added.';
  }
}

/** Point-to-segment distance in the interface plane. Exact up to double rounding. */
function segmentDistance(
  pu: number,
  pv: number,
  au: number,
  av: number,
  bu: number,
  bv: number,
): number {
  const du = bu - au,
    dv = bv - av,
    lengthSquared = du * du + dv * dv;
  if (lengthSquared === 0) return Math.hypot(pu - au, pv - av);
  const t = Math.max(0, Math.min(1, ((pu - au) * du + (pv - av) * dv) / lengthSquared));
  return Math.hypot(pu - (au + t * du), pv - (av + t * dv));
}

/**
 * Whether the derived region can be trusted as the material region. A region is refused, never repaired: it must have
 * loops, each of at least three finite vertices, and the area its nesting implies must equal the area the kernel
 * triangulated, to within the same rounding bound the kernel applies to its own cap-chain check.
 */
function regionProblem(face: GeneratedSeparationInterface, region: InterfaceRegion): boolean {
  const { uv } = face.sharedRegion;
  if (region.loops.length === 0 || region.loops.length !== face.loopCount) return true;
  let net = 0,
    absoluteTerms = 0;
  for (const loop of region.loops) {
    if (loop.end - loop.start < 3 || loop.end * 2 > uv.length) return true;
    // Each loop's area is summed from ITS OWN first vertex, as the kernel's chain check does: a sum taken about the plane
    // origin loses precision in proportion to the loop's distance from it, and the bound below is sized for the shifted sum.
    const originU = uv[2 * loop.start] ?? NaN,
      originV = uv[2 * loop.start + 1] ?? NaN;
    let twiceArea = 0;
    for (let i = loop.start; i < loop.end; i++) {
      const j = i + 1 < loop.end ? i + 1 : loop.start,
        term =
          ((uv[2 * i] ?? NaN) - originU) * ((uv[2 * j + 1] ?? NaN) - originV) -
          ((uv[2 * j] ?? NaN) - originU) * ((uv[2 * i + 1] ?? NaN) - originV);
      if (!Number.isFinite(term)) return true;
      twiceArea += term;
      absoluteTerms += Math.abs(term);
    }
    net += (loop.role === 'OUTER' ? 1 : -1) * Math.abs(twiceArea / 2);
  }
  if (!Number.isFinite(face.area) || !(face.area > 0)) return true;
  // written so that a NaN comparison REFUSES: the region is trusted only when the two areas are shown to agree
  return !(
    Math.abs(net - face.area) <=
    128 * Number.EPSILON * (absoluteTerms + 2 * Math.abs(face.area))
  );
}

function classify(
  face: GeneratedSeparationInterface,
  region: InterfaceRegion,
  pairId: string,
  footprint: { readonly u: number; readonly v: number; readonly radius: number },
  tolerance: number,
): FootprintFailure | undefined {
  const { uv } = face.sharedRegion,
    { u: pu, v: pv, radius } = footprint,
    reach = radius - tolerance;
  let depth = 0,
    nearestId = -1,
    nearestDistance = Infinity,
    worstId = -1,
    worstDistance = Infinity;
  for (const loop of region.loops) {
    let inside = false,
      best = Infinity;
    for (let i = loop.start, j = loop.end - 1; i < loop.end; j = i++) {
      const ui = uv[2 * i] ?? NaN,
        vi = uv[2 * i + 1] ?? NaN,
        uj = uv[2 * j] ?? NaN,
        vj = uv[2 * j + 1] ?? NaN;
      if (vi > pv !== vj > pv && pu < ((uj - ui) * (pv - vi)) / (vj - vi) + ui) inside = !inside;
      best = Math.min(best, segmentDistance(pu, pv, ui, vi, uj, vj));
    }
    if (inside) depth++;
    if (best < nearestDistance) {
      nearestDistance = best;
      nearestId = loop.id;
    }
    // A loop is violated when the centre is ON it (distance 0, so the parity above means nothing) or the circle reaches it.
    if ((!(best > 0) || !(best >= reach)) && best < worstDistance) {
      worstDistance = best;
      worstId = loop.id;
    }
  }
  const base = { pairId, footprint: { u: pu, v: pv, radius } };
  if (depth % 2 === 0)
    // Not in material: in the exterior (depth 0) or inside an opening (any other even depth). Never contained.
    return {
      ...base,
      refusal:
        depth === 0
          ? ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE
          : ConnectorRefusal.FOOTPRINT_INTERSECTS_VOID,
      ...(nearestId < 0 ? {} : { loopId: nearestId }),
      centerInMaterial: false,
    };
  if (worstId < 0) return undefined;
  // The centre is in material and the circle reaches a boundary. An opening's boundary is a void; an outline's is the exterior.
  const loop = region.loops[worstId];
  return {
    ...base,
    refusal:
      loop?.role === 'HOLE'
        ? ConnectorRefusal.FOOTPRINT_INTERSECTS_VOID
        : ConnectorRefusal.FOOTPRINT_OUTSIDE_INTERFACE,
    loopId: worstId,
    centerInMaterial: true,
    overreach: radius - worstDistance,
  };
}

/**
 * Checks every footprint of a validated plan against the interface it was made for. ALL footprints are checked and every
 * failure is reported, so the caller can fail the whole plan closed: one invalid footprint refuses the plan, and no
 * connector is dropped or moved to rescue the others.
 */
export function containFootprints(
  validated: ValidatedConnectorPlan,
  face: GeneratedSeparationInterface,
  tolerance: number,
): FootprintContainment {
  const { pairs } = validated.plan;
  if (pairs.length === 0) return { ok: true, checked: 0 };
  const region = deriveInterfaceRegion(face),
    first = pairs[0];
  if (!(tolerance >= 0) || !Number.isFinite(tolerance) || regionProblem(face, region))
    return {
      ok: false,
      checked: 0,
      failures: [
        {
          refusal: ConnectorRefusal.INTERFACE_REGION_UNAVAILABLE,
          pairId: first?.pairId ?? 'pin-1',
          footprint: first?.footprint ?? { u: NaN, v: NaN, radius: NaN },
          centerInMaterial: false,
        },
      ],
    };
  const failures: FootprintFailure[] = [];
  for (const pair of pairs) {
    const failure = classify(face, region, pair.pairId, pair.footprint, tolerance);
    if (failure) failures.push(failure);
  }
  return failures.length === 0
    ? { ok: true, checked: pairs.length }
    : { ok: false, checked: pairs.length, failures };
}
