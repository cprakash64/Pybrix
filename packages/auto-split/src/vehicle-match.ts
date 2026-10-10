import {
  VEHICLE_VIEW_ORDER,
  SLOT_NAMES,
  type Box4,
  type SlotName,
  type VehicleAnswer,
  type Vec3,
  type ViewBox,
  type ViewName,
  type WheelReading,
} from '@cadfixer/auto-split-contract';
import type { ComponentDescriptor } from './descriptors';

/**
 * THE SEMANTIC-TO-COMPONENT MATCHER (the research candidate `VEHICLE_COMPONENT_MATCHER_V1_CANDIDATE`,
 * feature set F3, at its frozen setting).
 *
 * "Which local component BEST corresponds to this semantic target, and by how much?" — never "is
 * exactly one component inside the box". A body's box holds its wheels; the wheels' visible boxes are
 * small against it, so the body's own visible box is the better match and nothing is declared
 * ambiguous merely because components are nested.
 *
 * THE SCORE IS INTERPRETABLE AND HAS NO LEARNED PART: the mean, over the images in which the model
 * drew a box, of the box IoU between the model's box and the component's VISIBLE-pixel bounding box,
 * plus a small 3D-centre term. The model's side and position labels are NOT used: on the research
 * corpus they were right half the time.
 *
 * WHAT THE RESEARCH FOUND, and so what this is allowed to claim. At this frozen setting the matcher
 * made no wrong automatic choice on 45 assignments, but on a fresh holdout it accepted only 2 of 24
 * targets automatically and its best suggestion was the right component for 17 of 24. So this module
 * decides which component to SHOW, and whether the evidence is strong enough to call the suggestion
 * high-confidence. It never decides to apply anything: a person always reviews the selection.
 */
export const MIN_VIEWS = 2;
export const ASSIST_FLOOR = 0.25;
export const CENTRE_WEIGHT = 0.15;
export const CENTRE_SCALE = 0.25;
export const NEST_PAD = 0.003;
export const NEST_AREA_SHARE = 0.5;
/** The frozen high-confidence setting. */
export const TAU = 0.7;
export const MU = 0.4;
export const RHO = 0.8;
/** A wheel whose boxes sit on another entry's component by at least this share is that component's. */
export const OCCUPANT_SHARE = 0.5;

export type Family = 'wheel' | 'cab' | 'cargo' | 'body';

export interface MatchEntry {
  readonly id: string;
  readonly family: Family;
  readonly views: readonly ViewBox[];
  readonly center: Vec3 | null;
  readonly grouping: 'single_wheel' | 'wheel_group' | null;
}

const SLOT_FAMILY: Readonly<Record<SlotName, Family>> = {
  cab: 'cab',
  cargo_or_bed: 'cargo',
  chassis_or_main_body: 'body',
};

/** The semantic targets of an answer a component could stand for: PRESENT or UNCERTAIN slots, and every wheel. */
export function entriesOf(answer: VehicleAnswer): MatchEntry[] {
  const out: MatchEntry[] = [];
  for (const name of SLOT_NAMES) {
    const s = answer.parts[name];
    if (s.status === 'ABSENT') continue;
    out.push({
      id: `slot:${name}`,
      family: SLOT_FAMILY[name],
      views: s.views,
      center: s.center,
      grouping: null,
    });
  }
  for (const w of answer.wheels) out.push(wheelEntry(w));
  return out;
}

function wheelEntry(w: WheelReading): MatchEntry {
  return {
    id: `wheel:${w.id}`,
    family: 'wheel',
    views: w.views,
    center: w.center,
    grouping: w.grouping,
  };
}

export function boxIoU(a: Box4, b: Box4): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/** The views of an entry in which the model drew a usable box, in the answer's order. */
export function boxedViews(entry: MatchEntry): { view: ViewName; box: Box4 }[] {
  const out: { view: ViewName; box: Box4 }[] = [];
  for (const v of entry.views)
    if ((v.visibility === 'visible' || v.visibility === 'partially_visible') && v.box !== null)
      out.push({ view: v.view, box: v.box });
  return out;
}

export interface MatchContext {
  readonly components: readonly ComponentDescriptor[];
  /** The diagonal of the model's bounding box, normalized. */
  readonly diagonal: number;
  readonly counts: (view: ViewName, box: Box4) => Int32Array;
}

export interface RawMatch {
  readonly entryId: string;
  readonly family: Family;
  /** Views in which the model drew a usable box. */
  readonly views: number;
  /** The best component and the set it stands for (the primary plus nested parts for a wheel). */
  readonly primary: number;
  readonly set: readonly number[];
  readonly s1: number;
  /** Best score among components outside the chosen set. */
  readonly s2: number;
  /** Mean share of the chosen primary's visible pixels that the entry's boxes cover. */
  readonly recall: number;
  /** The component with most visible pixels inside the entry's boxes, and its share of the covered pixels. */
  readonly occupant: { readonly rank: number; readonly share: number } | null;
  /** The best few components, best first, for a selection list. */
  readonly ranking: readonly { readonly rank: number; readonly score: number }[];
}

/** Smaller components whose bounds lie inside the primary's and whose surface is under half of it. */
export function nestedParts(
  components: readonly ComponentDescriptor[],
  primary: ComponentDescriptor,
): number[] {
  const out: number[] = [];
  for (const c of components) {
    if (
      c.rank === primary.rank ||
      c.faces >= primary.faces ||
      c.area >= NEST_AREA_SHARE * primary.area
    )
      continue;
    let inside = true;
    for (let a = 0; a < 3; a += 1)
      if (
        (c.lo[a] ?? 0) < (primary.lo[a] ?? 0) - NEST_PAD ||
        (c.hi[a] ?? 0) > (primary.hi[a] ?? 0) + NEST_PAD
      )
        inside = false;
    if (inside) out.push(c.rank);
  }
  return out.sort((a, b) => a - b);
}

const KEEP = 8;

export function rawMatch(entry: MatchEntry, ctx: MatchContext): RawMatch {
  const views = boxedViews(entry);
  const n = ctx.components.length;
  const viewIndex = new Map(VEHICLE_VIEW_ORDER.map((v, i) => [v, i] as const));
  const inside = views.map((v) => ctx.counts(v.view, v.box));
  const occupancy = new Float64Array(n);
  let covered = 0;
  for (const counted of inside)
    for (let r = 0; r < n; r += 1) {
      occupancy[r] = (occupancy[r] ?? 0) + (counted[r] ?? 0);
      covered += counted[r] ?? 0;
    }
  let occRank = -1;
  for (let r = 0; r < n; r += 1)
    if ((occupancy[r] ?? 0) > (occRank < 0 ? 0 : (occupancy[occRank] ?? 0))) occRank = r;
  const occupant =
    occRank >= 0 && covered > 0 && views.length > 0
      ? { rank: occRank, share: (occupancy[occRank] ?? 0) / covered }
      : null;

  const scored = ctx.components.map((c) => {
    let sum = 0;
    let recallSum = 0;
    let recallViews = 0;
    views.forEach((v, k) => {
      const view = c.views[viewIndex.get(v.view) ?? -1];
      sum += view?.box ? boxIoU(v.box, view.box) : 0;
      if (view && view.pixels > 0) {
        recallSum += (inside[k]?.[c.rank] ?? 0) / view.pixels;
        recallViews += 1;
      }
    });
    const box = views.length === 0 ? 0 : sum / views.length;
    let score = box;
    if (entry.center !== null) {
      const d =
        Math.hypot(
          entry.center[0] - c.centroid[0],
          entry.center[1] - c.centroid[1],
          entry.center[2] - c.centroid[2],
        ) / Math.max(ctx.diagonal, 1e-9);
      score = (1 - CENTRE_WEIGHT) * box + CENTRE_WEIGHT * Math.exp(-((d / CENTRE_SCALE) ** 2));
    }
    return { rank: c.rank, score, recall: recallViews === 0 ? 0 : recallSum / recallViews };
  });
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  const best = scored[0];
  if (best === undefined)
    return {
      entryId: entry.id,
      family: entry.family,
      views: views.length,
      primary: -1,
      set: [],
      s1: 0,
      s2: 0,
      recall: 0,
      occupant,
      ranking: [],
    };
  const primary = ctx.components.find((c) => c.rank === best.rank);
  const nested =
    entry.family === 'wheel' && primary !== undefined ? nestedParts(ctx.components, primary) : [];
  const set = [best.rank, ...nested].sort((a, b) => a - b);
  const inSet = new Set(set);
  const rival = scored.find((c) => !inSet.has(c.rank));
  return {
    entryId: entry.id,
    family: entry.family,
    views: views.length,
    primary: best.rank,
    set,
    s1: best.score,
    s2: rival?.score ?? 0,
    recall: best.recall,
    occupant,
    ranking: scored.slice(0, KEEP).map((c) => ({ rank: c.rank, score: c.score })),
  };
}

export const Decision = {
  /** High confidence: the research's frozen automatic rule. Still only a SUGGESTION here. */
  Strong: 'STRONG',
  /** A component is suggested and needs a person's review. */
  Review: 'REVIEW',
  /** The part exists but no single component corresponds (fused into something else). */
  NoComponent: 'NO_COMPONENT',
  InsufficientEvidence: 'INSUFFICIENT_EVIDENCE',
  /** The box covers only a piece of the best component. */
  PartialCoverage: 'PARTIAL_COVERAGE',
  /** The chosen set is every component: nothing would be left behind. */
  WholeModel: 'WHOLE_MODEL',
  /** The chosen set owns a wheel the model also reports. */
  WheelsFused: 'WHEELS_FUSED',
  /** Two different slots chose the same component. */
  SharedClaim: 'SHARED_CLAIM',
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

export interface Decided {
  readonly decision: Decision;
  readonly primary: number;
  readonly set: readonly number[];
  readonly s1: number;
  readonly margin: number;
  readonly recall: number;
}

/** One entry on its own: the thresholds and the recall gate. The cross-entry rules are in `decideVehicle`. */
export function decide(raw: RawMatch): Decided {
  const base = {
    primary: raw.primary,
    set: raw.set,
    s1: raw.s1,
    margin: raw.s1 - raw.s2,
    recall: raw.recall,
  };
  if (raw.views < MIN_VIEWS) return { ...base, decision: Decision.InsufficientEvidence };
  if (raw.s1 >= TAU && raw.s1 - raw.s2 >= MU) {
    if (raw.recall < RHO) return { ...base, decision: Decision.PartialCoverage };
    return { ...base, decision: Decision.Strong };
  }
  if (raw.s1 >= ASSIST_FLOOR) return { ...base, decision: Decision.Review };
  return { ...base, decision: Decision.NoComponent };
}

/** Every entry of ONE vehicle, with the cross-entry rules applied to the strong ones. */
export function decideVehicle(raws: readonly RawMatch[], componentCount: number): Decided[] {
  const decided = raws.map(decide);
  // The components wheel entries stand on.
  const wheelOwners = new Set<number>();
  for (const r of raws)
    if (
      r.family === 'wheel' &&
      r.views >= MIN_VIEWS &&
      r.occupant !== null &&
      r.occupant.share >= OCCUPANT_SHARE
    )
      wheelOwners.add(r.occupant.rank);
  // Slot entries that are strong and chose the same primary.
  const claims = new Map<number, number>();
  raws.forEach((r, i) => {
    if (r.family === 'wheel' || decided[i]?.decision !== Decision.Strong) return;
    claims.set(r.primary, (claims.get(r.primary) ?? 0) + 1);
  });
  return decided.map((d, i) => {
    const r = raws[i];
    if (r === undefined || d.decision !== Decision.Strong) return d;
    if (d.set.length >= componentCount) return { ...d, decision: Decision.WholeModel };
    if (r.family !== 'wheel' && d.set.some((c) => wheelOwners.has(c)))
      return { ...d, decision: Decision.WheelsFused };
    if (r.family !== 'wheel' && (claims.get(r.primary) ?? 0) > 1)
      return { ...d, decision: Decision.SharedClaim };
    return d;
  });
}
