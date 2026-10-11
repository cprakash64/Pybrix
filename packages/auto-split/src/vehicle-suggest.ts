import {
  VEHICLE_VIEW_ORDER,
  type AxisDirection,
  type Vec3,
  type VehicleAnswer,
} from '@cadfixer/auto-split-contract';
import { NO_CHECKPOINT, type Checkpoint } from './checkpoint';
import { componentFacts, type ComponentLabelling } from './components';
import { describeComponents, pixelCounter, type ComponentDescriptor } from './descriptors';
import { toSourcePoint, type FaceFacts, type NormalizedGeometry } from './geometry';
import { proposeCabBedPlane } from './cab-bed';
import type { Raster } from './raster';
import {
  MAX_SELECTABLE_COMPONENTS,
  SuggestionOperation,
  SuggestionReason,
  SuggestionStatus,
  type ComponentSummary,
  type Suggestion,
  type SuggestionResult,
} from './suggestions';
import {
  ASSIST_FLOOR,
  Decision,
  decideVehicle,
  entriesOf,
  rawMatch,
  RHO,
  type Decided,
} from './vehicle-match';
import { required } from './required';

/**
 * VEHICLE SUGGESTIONS: wheels, cab, bed or cargo and chassis or body, as component selections the user
 * reviews, plus one beta cab/bed cut for a truck whose cab and bed are not separate components.
 *
 * "Show the best component and say how sure" — never "choose it". When the matcher is unsure, the best
 * component is still SHOWN and labelled for review; nothing is hidden, and nothing is chosen quietly.
 * A part that is built into a bigger component (a wheel fused into a body, a cab that is part of the
 * body shell) is not offered as that component: the research counted those as wrong choices, and an
 * honest "No safe split found" is better than a plausible wrong highlight.
 */
export interface VehicleSuggestInput {
  readonly geometry: NormalizedGeometry;
  readonly facts: FaceFacts;
  readonly labelling: ComponentLabelling;
  readonly rasters: readonly Raster[];
  readonly answer: VehicleAnswer;
  /** Read at safe boundaries inside the long passes; throws to cancel. Never changes a result. */
  readonly checkpoint?: Checkpoint;
}

/** A cab or cargo entry is shown as a component only when its evidence is this good: below it, a fused cab looks like a plausible body. */
const SLOT_SCORE_FLOOR = 0.6;

const axisVector = (d: AxisDirection): Vec3 | null =>
  d === '+X'
    ? [1, 0, 0]
    : d === '-X'
      ? [-1, 0, 0]
      : d === '+Y'
        ? [0, 1, 0]
        : d === '-Y'
          ? [0, -1, 0]
          : d === '+Z'
            ? [0, 0, 1]
            : d === '-Z'
              ? [0, 0, -1]
              : null;

const crossProduct = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Side and position words for a wheel, from the answer's own forward and up (which the research found reliable) and the component's own place. */
function wheelWords(
  answer: VehicleAnswer,
  extents: Vec3,
  centroid: Vec3,
): { side: 'left' | 'right' | null; position: 'front' | 'middle' | 'rear' | null } {
  const forward = axisVector(answer.forward);
  const up = axisVector(answer.up);
  if (forward === null || up === null) return { side: null, position: null };
  const left = crossProduct(up, forward);
  if (Math.hypot(...left) < 0.5) return { side: null, position: null };
  const along = (v: Vec3): number =>
    Math.abs(v[0]) * extents[0] + Math.abs(v[1]) * extents[1] + Math.abs(v[2]) * extents[2];
  const lateral =
    (centroid[0] * left[0] + centroid[1] * left[1] + centroid[2] * left[2]) /
    Math.max(along(left), 1e-9);
  const length =
    (centroid[0] * forward[0] + centroid[1] * forward[1] + centroid[2] * forward[2]) /
    Math.max(along(forward), 1e-9);
  return {
    side: lateral > 0.05 ? 'left' : lateral < -0.05 ? 'right' : null,
    position: length > 1 / 6 ? 'front' : length < -1 / 6 ? 'rear' : 'middle',
  };
}

const SLOT_LABEL: Readonly<Record<string, string>> = {
  'slot:cab': 'Cab',
  'slot:cargo_or_bed': 'Bed or cargo',
  'slot:chassis_or_main_body': 'Chassis or body',
};

function componentSuggestion(
  d: Decided,
  label: string,
  id: string,
  family: Suggestion['family'],
): Suggestion {
  const strong = d.decision === Decision.Strong;
  return {
    id,
    family,
    label,
    operation: SuggestionOperation.Component,
    status: strong ? SuggestionStatus.Suggested : SuggestionStatus.NeedsAdjustment,
    reason: strong ? SuggestionReason.Clear : SuggestionReason.ReviewSelection,
    plane: null,
    components: d.set,
  };
}

const unavailable = (
  id: string,
  family: Suggestion['family'],
  label: string,
  reason: SuggestionReason,
): Suggestion => ({
  id,
  family,
  label,
  operation: SuggestionOperation.None,
  status: SuggestionStatus.Unavailable,
  reason,
  plane: null,
  components: [],
});

const reviewable = (d: Decided): boolean =>
  d.decision === Decision.Strong ||
  d.decision === Decision.Review ||
  d.decision === Decision.PartialCoverage ||
  d.decision === Decision.SharedClaim;

export function suggestVehicle(input: VehicleSuggestInput): SuggestionResult {
  const { geometry, facts, labelling, rasters, answer } = input;
  const checkpoint = input.checkpoint ?? NO_CHECKPOINT;
  const descriptors: ComponentDescriptor[] = describeComponents(
    componentFacts(labelling, facts, geometry),
    labelling,
    rasters,
  );
  const counts = pixelCounter(rasters, VEHICLE_VIEW_ORDER, labelling);
  const diagonal = Math.hypot(...geometry.extents);
  const ctx = { components: descriptors, diagonal, counts };
  const entries = entriesOf(answer);
  const raws = entries.map((e) => rawMatch(e, ctx));
  const decided = decideVehicle(raws, labelling.count);
  const byId = new Map(
    entries.map((e, i) => [e.id, { entry: e, d: required(decided[i], 'decision') }] as const),
  );

  const out: Suggestion[] = [];

  // ---- wheels: one row per distinct component set, with the unavailable ones gathered into one row.
  const wheelGroups = new Map<number, { ids: string[]; d: Decided }>();
  const fusedWheels: string[] = [];
  const unlocated: string[] = [];
  for (const e of entries) {
    if (e.family !== 'wheel') continue;
    const d = (byId.get(e.id) as { d: Decided }).d;
    if (!reviewable(d)) {
      (d.decision === Decision.InsufficientEvidence ? unlocated : fusedWheels).push(e.id);
      continue;
    }
    const group = wheelGroups.get(d.primary);
    if (group) group.ids.push(e.id);
    else wheelGroups.set(d.primary, { ids: [e.id], d });
  }
  const wheelRows: { label: string; suggestion: Suggestion; order: number }[] = [];
  for (const [primary, group] of wheelGroups) {
    const component = descriptors[primary];
    const words = component
      ? wheelWords(answer, geometry.extents, component.centroid)
      : { side: null, position: null };
    const grouped = group.ids.length > 1;
    const position =
      words.position === null
        ? ''
        : `${words.position[0]?.toUpperCase() ?? ''}${words.position.slice(1)}`;
    const base = grouped
      ? position === ''
        ? 'Wheels'
        : `${position} wheels`
      : words.side === null || position === ''
        ? 'Wheel'
        : `${position}-${words.side} wheel`;
    const first = required(group.ids[0], 'group id');
    wheelRows.push({
      label: base,
      order: component
        ? component.centroid[0] * 3 + component.centroid[1] * 2 + component.centroid[2]
        : 0,
      suggestion: componentSuggestion(group.d, base, first, 'wheel'),
    });
  }
  wheelRows.sort((a, b) => a.label.localeCompare(b.label) || a.order - b.order);
  // Two rows that would read the same get a number.
  const seen = new Map<string, number>();
  for (const row of wheelRows) {
    const n = (seen.get(row.label) ?? 0) + 1;
    seen.set(row.label, n);
  }
  const counter = new Map<string, number>();
  for (const row of wheelRows) {
    const total = seen.get(row.label) ?? 1;
    const n = (counter.get(row.label) ?? 0) + 1;
    counter.set(row.label, n);
    out.push(
      total > 1 ? { ...row.suggestion, label: `${row.label} ${String(n)}` } : row.suggestion,
    );
  }
  if (fusedWheels.length > 0)
    out.push(
      unavailable(
        'wheels:fused',
        'wheel',
        fusedWheels.length > 1 ? 'Wheels' : 'Wheel',
        SuggestionReason.FusedIntoBody,
      ),
    );
  if (unlocated.length > 0 && fusedWheels.length === 0)
    out.push(unavailable('wheels:unlocated', 'wheel', 'Wheels', SuggestionReason.NotLocated));

  // ---- cab and bed: components when the evidence is good, else one beta cut for the pair.
  const credible = (id: string): boolean => {
    const e = byId.get(id);
    return (
      e !== undefined &&
      reviewable(e.d) &&
      (e.d.decision === Decision.Strong ||
        (e.d.s1 >= SLOT_SCORE_FLOOR && e.d.recall >= RHO && e.d.margin >= 0))
    );
  };
  const cab = byId.get('slot:cab');
  const cargo = byId.get('slot:cargo_or_bed');
  const cabOk = cab !== undefined && credible('slot:cab');
  const cargoOk = cargo !== undefined && credible('slot:cargo_or_bed');
  const pairPlane =
    cab !== undefined && cargo !== undefined && !cabOk && !cargoOk
      ? proposeCabBedPlane(geometry, facts, answer, checkpoint)
      : null;
  if (cab !== undefined && cabOk)
    out.push(
      componentSuggestion(cab.d, required(SLOT_LABEL['slot:cab'], 'slot label'), 'cab', 'cab'),
    );
  if (cargo !== undefined && cargoOk)
    out.push(
      componentSuggestion(
        cargo.d,
        required(SLOT_LABEL['slot:cargo_or_bed'], 'slot label'),
        'cargo_or_bed',
        'cargo',
      ),
    );
  if (pairPlane !== null) {
    out.push({
      id: 'cab_bed',
      family: 'cab_bed',
      label: 'Cab and bed',
      operation: SuggestionOperation.Plane,
      status: SuggestionStatus.NeedsAdjustment,
      reason: SuggestionReason.BetaCut,
      plane: {
        origin: toSourcePoint(geometry, [
          pairPlane.normal[0] * pairPlane.offset,
          pairPlane.normal[1] * pairPlane.offset,
          pairPlane.normal[2] * pairPlane.offset,
        ]),
        // Piece A is the bed side; the user can swap sides.
        normal: pairPlane.normal,
      },
      components: [],
    });
  } else {
    if (cab !== undefined && !cabOk)
      out.push(
        unavailable(
          'cab',
          'cab',
          required(SLOT_LABEL['slot:cab'], 'slot label'),
          SuggestionReason.FusedIntoBody,
        ),
      );
    if (cargo !== undefined && !cargoOk)
      out.push(
        unavailable(
          'cargo_or_bed',
          'cargo',
          required(SLOT_LABEL['slot:cargo_or_bed'], 'slot label'),
          SuggestionReason.FusedIntoBody,
        ),
      );
  }

  // ---- chassis or body: a component to review, or nothing safe.
  const body = byId.get('slot:chassis_or_main_body');
  if (body !== undefined) {
    if (reviewable(body.d) && body.d.s1 >= ASSIST_FLOOR)
      out.push(
        componentSuggestion(
          body.d,
          required(SLOT_LABEL['slot:chassis_or_main_body'], 'slot label'),
          'chassis_or_main_body',
          'body',
        ),
      );
    else
      out.push(
        unavailable(
          'chassis_or_main_body',
          'body',
          required(SLOT_LABEL['slot:chassis_or_main_body'], 'slot label'),
          body.d.decision === Decision.WholeModel
            ? SuggestionReason.WholeModel
            : SuggestionReason.FusedIntoBody,
        ),
      );
  }

  // ---- the selection list: the biggest components, plus anything a suggestion selects.
  const wanted = new Set<number>(out.flatMap((s) => s.components));
  const bySize = [...descriptors].sort((a, b) => b.area - a.area || a.rank - b.rank);
  const listed: ComponentSummary[] = [];
  for (const c of bySize) {
    if (listed.length >= MAX_SELECTABLE_COMPONENTS && !wanted.has(c.rank)) continue;
    listed.push({ rank: c.rank, areaShare: c.areaShare, faces: c.faces });
  }
  return {
    suggestions: out,
    components: listed.sort((a, b) => b.areaShare - a.areaShare || a.rank - b.rank),
    componentCount: labelling.count,
    faceCount: geometry.faceCount,
  };
}
