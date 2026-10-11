import {
  cameraFor,
  FRAME_FILL,
  VEHICLE_VIEW_ORDER,
  type Box4,
  type SlotName,
  type VehicleAnswer,
  type Vec3,
  type ViewName,
} from '@cadfixer/auto-split-contract';
import { CHECKPOINT_STRIDE, NO_CHECKPOINT, type Checkpoint } from './checkpoint';
import type { FaceFacts, NormalizedGeometry } from './geometry';
import { dot3, mid3, normalizedPlane, sub3, type NormalizedPlane } from './plane-math';
import { required } from './required';

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

/**
 * A REGION AS A COMPACT FACE LIST.
 *
 * The scorer below is asked about 250 candidate planes, and each answer used to scan EVERY face to
 * find the few that belong to the cab or the bed: about 500 million face visits at two million
 * triangles, and half of the whole local analysis. A region is now a list of the faces it holds, in
 * ASCENDING face order, and everything that used to loop over a mask loops over that list instead.
 * Ascending order is the point: each sum then adds the same terms in the same order the mask loop
 * did, so the result is bit-for-bit the same number, not merely close to it.
 */
interface Region {
  /** The faces of the region, ascending. */
  readonly faces: Int32Array;
}

/** Faces whose centroid is inside the slot's box in at least CORE_SUPPORT of max(boxed views, 4) images. */
function regionOf(
  geometry: NormalizedGeometry,
  facts: FaceFacts,
  slot: SlotBoxes,
  checkpoint: Checkpoint,
): Region {
  if (slot.views.length === 0) return { faces: new Int32Array(0) };
  const denominator = Math.max(slot.views.length, MIN_SUPPORT_DIVISOR);
  // What `projectPoint` does for one view, hoisted: the camera's right and up vectors and the scale
  // are the same numbers for every face, so they are looked up ONCE and the expression below is the
  // one `projectPoint` evaluates, operand for operand: `0.5 + dot(c, right) * perUnit` and
  // `0.5 - dot(c, up) * perUnit`. A test holds the region to the `projectPoint` version.
  const perUnit = FRAME_FILL / (2 * Math.max(geometry.radius, 1e-9));
  const cameras = slot.views.map((v) => {
    const camera = cameraFor(v.view);
    return {
      right: camera.right,
      up: camera.up,
      lo: [v.box[0], v.box[1]] as const,
      hi: [v.box[2], v.box[3]] as const,
    };
  });
  // A face is in the region or it is not: collected in a growable typed buffer, never a boxed array.
  let faces = new Int32Array(1024);
  let count = 0;
  const { centroids } = facts;
  for (let start = 0; start < geometry.faceCount; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(geometry.faceCount, start + CHECKPOINT_STRIDE);
    for (let f = start; f < end; f += 1) {
      const c0 = centroids[f * 3] ?? 0;
      const c1 = centroids[f * 3 + 1] ?? 0;
      const c2 = centroids[f * 3 + 2] ?? 0;
      let inside = 0;
      for (const v of cameras) {
        const x = 0.5 + (c0 * v.right[0] + c1 * v.right[1] + c2 * v.right[2]) * perUnit;
        const y = 0.5 - (c0 * v.up[0] + c1 * v.up[1] + c2 * v.up[2]) * perUnit;
        if (x >= v.lo[0] && x <= v.hi[0] && y >= v.lo[1] && y <= v.hi[1]) inside += 1;
      }
      if (inside / denominator >= CORE_SUPPORT) {
        if (count === faces.length) {
          const grown = new Int32Array(faces.length * 2);
          grown.set(faces);
          faces = grown;
        }
        faces[count] = f;
        count += 1;
      }
    }
  }
  return { faces: faces.slice(0, count) };
}

function areaCentroid(facts: FaceFacts, region: Region): { count: number; centroid: Vec3 | null } {
  let area = 0;
  let count = 0;
  const sum: [number, number, number] = [0, 0, 0];
  for (const f of region.faces) {
    const w = facts.areas[f] ?? 0;
    area += w;
    count += 1;
    for (let k = 0; k < 3; k += 1) sum[k] = (sum[k] ?? 0) + w * (facts.centroids[f * 3 + k] ?? 0);
  }
  return { count, centroid: area > 0 ? [sum[0] / area, sum[1] / area, sum[2] / area] : null };
}

function alongRange(facts: FaceFacts, region: Region, n: Vec3): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of region.faces) {
    const t =
      n[0] * (facts.centroids[f * 3] ?? 0) +
      n[1] * (facts.centroids[f * 3 + 1] ?? 0) +
      n[2] * (facts.centroids[f * 3 + 2] ?? 0);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return { lo, hi };
}

/**
 * The faces of the cab and the bed as ONE ascending list with their centroid, area and membership,
 * copied beside each other so every candidate plane reads them sequentially. A face in both regions
 * (the boxes may overlap) carries both bits, exactly as the two masks did.
 */
interface ScoringSet {
  readonly count: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly area: Float64Array;
  /** Bit 1: in the cab region. Bit 2: in the bed region. */
  readonly member: Uint8Array;
}

function scoringSet(facts: FaceFacts, cab: Region, bed: Region): ScoringSet {
  const total = cab.faces.length + bed.faces.length;
  const x = new Float64Array(total);
  const y = new Float64Array(total);
  const z = new Float64Array(total);
  const area = new Float64Array(total);
  const member = new Uint8Array(total);
  let n = 0;
  let i = 0;
  let j = 0;
  // A merge of two ascending lists: ascending overall, equal faces joined into one entry.
  while (i < cab.faces.length || j < bed.faces.length) {
    const fc = i < cab.faces.length ? (cab.faces[i] ?? 0) : Infinity;
    const fb = j < bed.faces.length ? (bed.faces[j] ?? 0) : Infinity;
    const f = Math.min(fc, fb);
    let bits = 0;
    if (fc === f) {
      bits |= 1;
      i += 1;
    }
    if (fb === f) {
      bits |= 2;
      j += 1;
    }
    x[n] = facts.centroids[f * 3] ?? 0;
    y[n] = facts.centroids[f * 3 + 1] ?? 0;
    z[n] = facts.centroids[f * 3 + 2] ?? 0;
    area[n] = facts.areas[f] ?? 0;
    member[n] = bits;
    n += 1;
  }
  return { count: n, x, y, z, area, member };
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

/** One tilted normal and the slides searched along it: 25 candidate planes sharing a normal and a tilt. */
interface TiltGroup {
  readonly normal: Vec3;
  readonly tilt: number;
  /** `base + slide` for each slide, in the order of SLIDE_STEPS: ascending, so non-decreasing as doubles. */
  readonly offsets: Float64Array;
}

function family(seed: Seed): TiltGroup[] {
  const n0 = seed.plane.normal;
  const [u, v] = basis(n0);
  const out: TiltGroup[] = [];
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
      out.push({
        normal: tilted.normal,
        tilt,
        offsets: Float64Array.from(SLIDE_STEPS, (slide) => base + slide),
      });
    }
  return out;
}

/** How completely a plane puts the cab region on one side and the bed region on the other: the lesser of the two shares. */
function purity(set: ScoringSet, plane: NormalizedPlane): number {
  let cabPos = 0;
  let cabNeg = 0;
  let bedPos = 0;
  let bedNeg = 0;
  const [nx, ny, nz] = plane.normal;
  const { x, y, z, area, member } = set;
  for (let i = 0; i < set.count; i += 1) {
    const w = area[i] ?? 0;
    const d = nx * (x[i] ?? 0) + ny * (y[i] ?? 0) + nz * (z[i] ?? 0) - plane.offset;
    const bits = member[i] ?? 0;
    if ((bits & 1) !== 0) {
      if (d >= 0) cabPos += w;
      else cabNeg += w;
    }
    if ((bits & 2) !== 0) {
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

/**
 * HOW FAR A SCREENING SCORE MAY BE FROM THE EXACT ONE, AND WHY.
 *
 * The screen classifies every face by the sign of `t - offset` with the SAME arithmetic the exact
 * scorer uses, so which side a face is on is never in doubt; what differs is only the ORDER the areas
 * are added in (a screen adds them per slide bin, the exact scorer in face order). Adding n positive
 * terms in any order has a relative error of at most (n-1)u/(1-(n-1)u), u = 2^-53; at the 2,000,000
 * faces this product supports that is 2.2e-10 for a sum, and a share is a ratio of two sums, so one
 * score is within about 5e-10 of the mathematical value in EITHER order. Two such scores differ by
 * less than 1e-9, which is the figure used.
 */
export const SCREEN_SCORE_TOLERANCE = 1e-9;

/**
 * Candidates whose SCREENED score is within this of the best screened score are scored EXACTLY. Far
 * wider than any quantity that decides a selection: the screen's own error (1e-9), the 1e-12 tie
 * band of `best`, and the longest chain of ties the 625 candidates of one seed can form (625e-12). A
 * candidate this far below the best can never be the selected plane, can never become the selected
 * plane's rival, and cannot move which plane a tie is awarded to, so scoring only the rest picks the
 * same plane with the same bit-for-bit score as scoring all of them.
 */
export const SCREEN_KEEP_WINDOW = 1e-6;

/** The score a plane earns from the four side sums: the same expression `purity` ends with. */
function shareScore(cabPos: number, cabNeg: number, bedPos: number, bedNeg: number): number {
  const cabTotal = cabPos + cabNeg;
  const bedTotal = bedPos + bedNeg;
  if (cabTotal <= 0 || bedTotal <= 0) return 0;
  if (cabPos >= cabNeg === bedPos >= bedNeg) return 0;
  return Math.min(Math.max(cabPos, cabNeg) / cabTotal, Math.max(bedPos, bedNeg) / bedTotal);
}

/**
 * The scores of every slide along ONE tilted normal from a SINGLE pass over the cab and bed faces.
 *
 * A face's side of a slide is the sign of `t - offset` with `t = nx*x + ny*y + nz*z`, evaluated here
 * exactly as `purity` evaluates it. The offsets are non-decreasing, so a face is on the positive side
 * of the first `k` slides and the negative side of the rest, where `k` is how many offsets are `<= t`:
 * its area is added to ONE bin, and every slide's four sums are prefix and suffix sums of 26 bin
 * values. One pass replaces 25, and the sides are the ones the exact scorer would have chosen.
 */
function screenGroup(set: ScoringSet, group: TiltGroup, checkpoint: Checkpoint): Float64Array {
  const [nx, ny, nz] = group.normal;
  const { offsets } = group;
  const slides = offsets.length;
  const last = offsets[slides - 1] ?? 0;
  const first = offsets[0] ?? 0;
  const cabBin = new Float64Array(slides + 1);
  const bedBin = new Float64Array(slides + 1);
  const { x, y, z, area, member } = set;
  for (let start = 0; start < set.count; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(set.count, start + CHECKPOINT_STRIDE);
    for (let i = start; i < end; i += 1) {
      const t = nx * (x[i] ?? 0) + ny * (y[i] ?? 0) + nz * (z[i] ?? 0);
      let k = 0;
      if (t >= last) k = slides;
      else if (t >= first) {
        // The count of offsets <= t, by bisection: only faces within the slide window ever get here.
        let lo = 0;
        let hi = slides;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((offsets[mid] ?? 0) <= t) lo = mid + 1;
          else hi = mid;
        }
        k = lo;
      }
      const bits = member[i] ?? 0;
      const w = area[i] ?? 0;
      if ((bits & 1) !== 0) cabBin[k] = (cabBin[k] ?? 0) + w;
      if ((bits & 2) !== 0) bedBin[k] = (bedBin[k] ?? 0) + w;
    }
  }
  const scores = new Float64Array(slides);
  let cabTotal = 0;
  let bedTotal = 0;
  for (let k = 0; k <= slides; k += 1) {
    cabTotal += cabBin[k] ?? 0;
    bedTotal += bedBin[k] ?? 0;
  }
  // `neg` of slide j is the bins 0..j (faces with fewer than j+1 offsets <= t); `pos` is the rest.
  let cabNeg = 0;
  let bedNeg = 0;
  for (let j = 0; j < slides; j += 1) {
    cabNeg += cabBin[j] ?? 0;
    bedNeg += bedBin[j] ?? 0;
    scores[j] = shareScore(cabTotal - cabNeg, cabNeg, bedTotal - bedNeg, bedNeg);
  }
  return scores;
}

export interface SeedSearchOptions {
  /**
   * Give up, returning null, when no candidate can reach this score. A caller that will throw the
   * result away below a threshold passes it, so a hopeless seed costs one screen and not a search.
   */
  readonly abandonBelow?: number;
}

/**
 * The best plane of one seed's family: the candidate with the highest score, ties to the smaller
 * tilt and then the smaller slide. The SELECTION is the original loop over the original order with
 * the original `purity`; what is new is that only candidates that could matter are scored: every
 * candidate is first screened (`screenGroup`), and the exact loop runs over those within
 * `SCREEN_KEEP_WINDOW` of the best screen. See that constant for why the result is unchanged.
 */
function best(
  set: ScoringSet,
  groups: readonly TiltGroup[],
  checkpoint: Checkpoint,
  options: SeedSearchOptions,
): { plane: NormalizedPlane; score: number } | null {
  const screens = groups.map((group) => screenGroup(set, group, checkpoint));
  let top = -Infinity;
  for (const scores of screens) for (const score of scores) top = Math.max(top, score);
  if (options.abandonBelow !== undefined && top < options.abandonBelow - SCREEN_SCORE_TOLERANCE)
    return null;
  let winner: { plane: NormalizedPlane; tilt: number; slide: number; score: number } | null = null;
  for (const [g, group] of groups.entries()) {
    const scores = screens[g];
    for (const [j, slide] of SLIDE_STEPS.entries()) {
      if ((scores?.[j] ?? -Infinity) < top - SCREEN_KEEP_WINDOW) continue;
      checkpoint();
      const plane: NormalizedPlane = { normal: group.normal, offset: group.offsets[j] ?? 0 };
      const score = purity(set, plane);
      if (
        winner === null ||
        score > winner.score + 1e-12 ||
        (Math.abs(score - winner.score) <= 1e-12 &&
          (group.tilt < winner.tilt - 1e-12 ||
            (Math.abs(group.tilt - winner.tilt) <= 1e-12 &&
              Math.abs(slide) < Math.abs(winner.slide) - 1e-12)))
      )
        winner = { plane, tilt: group.tilt, slide, score };
    }
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

/** What the two seeds' searches found, before any threshold or agreement decides whether to offer it. */
export interface CabBedEvaluation {
  readonly first: { readonly plane: NormalizedPlane; readonly score: number };
  readonly second: { readonly plane: NormalizedPlane; readonly score: number };
  /** The midpoint of the two regions' centroids, where the two planes must agree. */
  readonly middle: Vec3;
}

/**
 * The two seeded searches, or null when there is nothing to search (a slot or the boundary absent, an
 * empty region, a degenerate axis, fewer than two seeds). Exported so the equivalence tests can hold
 * the scores themselves, not just the plane that survives the thresholds.
 */
export function evaluateCabBedPlane(
  geometry: NormalizedGeometry,
  facts: FaceFacts,
  answer: VehicleAnswer,
  checkpoint: Checkpoint = NO_CHECKPOINT,
  options: SeedSearchOptions = {},
): CabBedEvaluation | null {
  if (answer.parts.cab.status === 'ABSENT' || answer.parts.cargo_or_bed.status === 'ABSENT')
    return null;
  if (answer.boundary.status === 'ABSENT') return null;
  const cab = regionOf(geometry, facts, slotBoxes(answer, 'cab'), checkpoint);
  const bed = regionOf(geometry, facts, slotBoxes(answer, 'cargo_or_bed'), checkpoint);
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
  const set = scoringSet(facts, cab, bed);
  const first = best(set, family(required(seeds[0], 'first seed')), checkpoint, options);
  // A seed that cannot reach the bar ends the search: the caller would discard the pair anyway.
  if (first === null) return null;
  const second = best(set, family(required(seeds[1], 'second seed')), checkpoint, options);
  if (second === null) return null;
  return { first, second, middle };
}

/**
 * The plane that separates the cab from the bed, in NORMALIZED coordinates with its normal pointing
 * from the cab toward the bed, or null when the two seeds do not agree or no plane is pure enough.
 */
export function proposeCabBedPlane(
  geometry: NormalizedGeometry,
  facts: FaceFacts,
  answer: VehicleAnswer,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): NormalizedPlane | null {
  // Below the purity bar the answer is "no plane", so a seed that cannot reach it stops the search.
  const found = evaluateCabBedPlane(geometry, facts, answer, checkpoint, {
    abandonBelow: AUTO_PURITY,
  });
  if (found === null) return null;
  const { first, second, middle } = found;
  if (first.score < AUTO_PURITY || second.score < AUTO_PURITY) return null;
  if (!agree(first.plane, second.plane, middle)) return null;
  return first.plane;
}

export { VEHICLE_VIEW_ORDER };
