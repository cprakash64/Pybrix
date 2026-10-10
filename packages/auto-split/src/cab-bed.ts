import {
  projectPoint,
  VEHICLE_VIEW_ORDER,
  type Box4,
  type SlotName,
  type VehicleAnswer,
  type Vec3,
  type ViewName,
} from '@cadfixer/auto-split-contract';
import type { FaceFacts, NormalizedGeometry } from './geometry';
import { dot3, mid3, normalizedPlane, sub3, type NormalizedPlane } from './plane-math';

/**
 * THE TRUCK CAB / BED PLANE: the narrow, bounded proposal the research demonstrated, as an editable
 * starting point.
 *
 * The model says where the cab and the bed are in every image and, as a SEED only, where it believes
 * they join. Pybrix grows a cab REGION and a bed REGION on the mesh from those boxes, builds two seeds
 * (one from the regions, snapped to a coordinate axis when the line between them is within 30 degrees
 * of one; one from the model's own plane), searches a small window of tilts and slides around each, and
 * keeps the plane that puts the cab region on one side and the bed region on the other most completely.
 * It is offered only when the two seeds' best planes AGREE: one signal alone is not enough. It is
 * always a beta that needs review.
 *
 * Constants are the research's, unchanged; they were set on three development cases and confirmed on
 * one holdout case, so this is limited evidence and the page says "beta".
 */
export const CORE_SUPPORT = 0.83;
export const MIN_SUPPORT_DIVISOR = 4;
export const TILT_STEPS_DEGREES: readonly number[] = [-10, -5, 0, 5, 10];
export const SLIDE_STEPS: readonly number[] = Array.from(
  { length: 25 },
  (_, i) => Math.round((-0.06 + 0.005 * i) * 1000) / 1000,
);
export const AUTO_PURITY = 0.9;
export const CONSENSUS_ANGLE_DEGREES = 10;
export const CONSENSUS_OFFSET = 0.05;
export const AXIS_SNAP_DEGREES = 30;

interface SlotBoxes {
  readonly views: readonly { readonly view: ViewName; readonly box: Box4 }[];
}

function slotBoxes(answer: VehicleAnswer, slot: SlotName): SlotBoxes {
  return {
    views: answer.parts[slot].views.flatMap((v) =>
      (v.visibility === 'visible' || v.visibility === 'partially_visible') && v.box !== null
        ? [{ view: v.view, box: v.box }]
        : [],
    ),
  };
}

/** Faces whose centroid is inside the slot's box in at least CORE_SUPPORT of max(boxed views, 4) images. */
function regionOf(geometry: NormalizedGeometry, facts: FaceFacts, slot: SlotBoxes): Uint8Array {
  const out = new Uint8Array(geometry.faceCount);
  if (slot.views.length === 0) return out;
  const denominator = Math.max(slot.views.length, MIN_SUPPORT_DIVISOR);
  for (let f = 0; f < geometry.faceCount; f += 1) {
    const c: Vec3 = [
      facts.centroids[f * 3] ?? 0,
      facts.centroids[f * 3 + 1] ?? 0,
      facts.centroids[f * 3 + 2] ?? 0,
    ];
    let inside = 0;
    for (const v of slot.views) {
      const [x, y] = projectPoint(geometry.radius, v.view, c);
      if (x >= v.box[0] && x <= v.box[2] && y >= v.box[1] && y <= v.box[3]) inside += 1;
    }
    if (inside / denominator >= CORE_SUPPORT) out[f] = 1;
  }
  return out;
}

function areaCentroid(
  facts: FaceFacts,
  mask: Uint8Array,
): { count: number; centroid: Vec3 | null } {
  let area = 0;
  let count = 0;
  const sum: [number, number, number] = [0, 0, 0];
  for (let f = 0; f < mask.length; f += 1) {
    if (mask[f] !== 1) continue;
    const w = facts.areas[f] ?? 0;
    area += w;
    count += 1;
    for (let k = 0; k < 3; k += 1) sum[k] = (sum[k] ?? 0) + w * (facts.centroids[f * 3 + k] ?? 0);
  }
  return { count, centroid: area > 0 ? [sum[0] / area, sum[1] / area, sum[2] / area] : null };
}

function alongRange(facts: FaceFacts, mask: Uint8Array, n: Vec3): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let f = 0; f < mask.length; f += 1) {
    if (mask[f] !== 1) continue;
    const t =
      n[0] * (facts.centroids[f * 3] ?? 0) +
      n[1] * (facts.centroids[f * 3 + 1] ?? 0) +
      n[2] * (facts.centroids[f * 3 + 2] ?? 0);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return { lo, hi };
}

export function snapToAxis(n: Vec3): Vec3 {
  let axis = 0;
  for (let a = 1; a < 3; a += 1) if (Math.abs(n[a] ?? 0) > Math.abs(n[axis] ?? 0)) axis = a;
  const angle = (Math.acos(Math.min(1, Math.abs(n[axis] ?? 0))) * 180) / Math.PI;
  if (angle > AXIS_SNAP_DEGREES) return n;
  const out: [number, number, number] = [0, 0, 0];
  out[axis] = (n[axis] ?? 0) >= 0 ? 1 : -1;
  return out;
}

interface Seed {
  readonly plane: NormalizedPlane;
  /** A point on the seed plane near the middle of the cab and the bed; tilted planes pivot about it. */
  readonly pivot: Vec3;
}

function pivotOn(plane: NormalizedPlane, near: Vec3): Vec3 {
  const d = plane.offset - dot3(near, plane.normal);
  return [
    near[0] + d * plane.normal[0],
    near[1] + d * plane.normal[1],
    near[2] + d * plane.normal[2],
  ];
}

function basis(n: Vec3): readonly [Vec3, Vec3] {
  const helper: Vec3 =
    Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2])
      ? [1, 0, 0]
      : Math.abs(n[1]) <= Math.abs(n[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const u = norm(cross(n, helper));
  return [u, norm(cross(n, u))];
}

function family(seed: Seed): { plane: NormalizedPlane; tilt: number; slide: number }[] {
  const n0 = seed.plane.normal;
  const [u, v] = basis(n0);
  const out: { plane: NormalizedPlane; tilt: number; slide: number }[] = [];
  for (const a of TILT_STEPS_DEGREES)
    for (const b of TILT_STEPS_DEGREES) {
      const ta = Math.tan((a * Math.PI) / 180);
      const tb = Math.tan((b * Math.PI) / 180);
      const tilted = normalizedPlane(
        [
          n0[0] + ta * u[0] + tb * v[0],
          n0[1] + ta * u[1] + tb * v[1],
          n0[2] + ta * u[2] + tb * v[2],
        ],
        0,
      );
      if (tilted === null) continue;
      const base = dot3(tilted.normal, seed.pivot);
      const tilt = (Math.atan(Math.hypot(ta, tb)) * 180) / Math.PI;
      for (const s of SLIDE_STEPS)
        out.push({ plane: { normal: tilted.normal, offset: base + s }, tilt, slide: s });
    }
  return out;
}

/** How completely a plane puts the cab region on one side and the bed region on the other: the lesser of the two shares. */
function purity(
  facts: FaceFacts,
  cab: Uint8Array,
  bed: Uint8Array,
  plane: NormalizedPlane,
): number {
  let cabPos = 0;
  let cabNeg = 0;
  let bedPos = 0;
  let bedNeg = 0;
  const [nx, ny, nz] = plane.normal;
  for (let f = 0; f < cab.length; f += 1) {
    const isCab = cab[f] === 1;
    const isBed = bed[f] === 1;
    if (!isCab && !isBed) continue;
    const w = facts.areas[f] ?? 0;
    const d =
      nx * (facts.centroids[f * 3] ?? 0) +
      ny * (facts.centroids[f * 3 + 1] ?? 0) +
      nz * (facts.centroids[f * 3 + 2] ?? 0) -
      plane.offset;
    if (isCab) {
      if (d >= 0) cabPos += w;
      else cabNeg += w;
    }
    if (isBed) {
      if (d >= 0) bedPos += w;
      else bedNeg += w;
    }
  }
  const cabTotal = cabPos + cabNeg;
  const bedTotal = bedPos + bedNeg;
  if (cabTotal <= 0 || bedTotal <= 0) return 0;
  if (cabPos >= cabNeg === bedPos >= bedNeg) return 0;
  return Math.min(Math.max(cabPos, cabNeg) / cabTotal, Math.max(bedPos, bedNeg) / bedTotal);
}

function best(
  facts: FaceFacts,
  cab: Uint8Array,
  bed: Uint8Array,
  candidates: readonly { plane: NormalizedPlane; tilt: number; slide: number }[],
): { plane: NormalizedPlane; score: number } | null {
  let winner: { plane: NormalizedPlane; tilt: number; slide: number; score: number } | null = null;
  for (const c of candidates) {
    const score = purity(facts, cab, bed, c.plane);
    if (
      winner === null ||
      score > winner.score + 1e-12 ||
      (Math.abs(score - winner.score) <= 1e-12 &&
        (c.tilt < winner.tilt - 1e-12 ||
          (Math.abs(c.tilt - winner.tilt) <= 1e-12 &&
            Math.abs(c.slide) < Math.abs(winner.slide) - 1e-12)))
    )
      winner = { ...c, score };
  }
  return winner === null ? null : { plane: winner.plane, score: winner.score };
}

function agree(a: NormalizedPlane, b: NormalizedPlane, at: Vec3): boolean {
  const c = Math.min(1, Math.abs(dot3(a.normal, b.normal)));
  if ((Math.acos(c) * 180) / Math.PI > CONSENSUS_ANGLE_DEGREES) return false;
  const sign = dot3(a.normal, b.normal) >= 0 ? 1 : -1;
  return (
    Math.abs(dot3(a.normal, at) - a.offset - sign * (dot3(b.normal, at) - b.offset)) <=
    CONSENSUS_OFFSET
  );
}

/**
 * The plane that separates the cab from the bed, in NORMALIZED coordinates with its normal pointing
 * from the cab toward the bed, or null when the two seeds do not agree or no plane is pure enough.
 */
export function proposeCabBedPlane(
  geometry: NormalizedGeometry,
  facts: FaceFacts,
  answer: VehicleAnswer,
): NormalizedPlane | null {
  if (answer.parts.cab.status === 'ABSENT' || answer.parts.cargo_or_bed.status === 'ABSENT')
    return null;
  if (answer.boundary.status === 'ABSENT') return null;
  const cab = regionOf(geometry, facts, slotBoxes(answer, 'cab'));
  const bed = regionOf(geometry, facts, slotBoxes(answer, 'cargo_or_bed'));
  const c = areaCentroid(facts, cab);
  const b = areaCentroid(facts, bed);
  if (c.count === 0 || b.count === 0 || c.centroid === null || b.centroid === null) return null;
  const axis = sub3(b.centroid, c.centroid);
  const middle = mid3(c.centroid, b.centroid);
  const seeds: Seed[] = [];
  if (Math.hypot(axis[0], axis[1], axis[2]) > 1e-6) {
    const unitAxis = normalizedPlane(axis, 0);
    if (unitAxis !== null) {
      const n = snapToAxis(unitAxis.normal);
      const cr = alongRange(facts, cab, n);
      const br = alongRange(facts, bed, n);
      const offset =
        br.lo > cr.hi ? (cr.hi + br.lo) / 2 : (dot3(c.centroid, n) + dot3(b.centroid, n)) / 2;
      const plane: NormalizedPlane = { normal: n, offset };
      seeds.push({ plane, pivot: pivotOn(plane, middle) });
    }
  }
  const raw = answer.boundary.planeNormal;
  const rawOffset = answer.boundary.planeOffset;
  if (raw !== null && rawOffset !== null) {
    let plane = normalizedPlane(raw, rawOffset);
    if (plane !== null) {
      // The seed must point from the cab toward the bed; flip it if the regions say otherwise.
      if (dot3(plane.normal, axis) < 0)
        plane = {
          normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
          offset: -plane.offset,
        };
      seeds.push({ plane, pivot: pivotOn(plane, middle) });
    }
  }
  if (seeds.length !== 2) return null;
  const winners = seeds.map((s) => best(facts, cab, bed, family(s)));
  const [first, second] = winners;
  if (!first || !second || first.score < AUTO_PURITY || second.score < AUTO_PURITY) return null;
  if (!agree(first.plane, second.plane, middle)) return null;
  return first.plane;
}

export { VEHICLE_VIEW_ORDER };
