import { VIEW_NAMES, type ViewName } from './limits';

/**
 * THE VEHICLE ANSWER: its vocabulary, its types and the local validator.
 *
 * This is the research protocol VEHICLE_SEMANTIC_PROTOCOL_V0, unchanged: localisation only. The model
 * says WHERE the parts of a vehicle are (a box per image, a rough normalized 3D centre) and never
 * which operation to run or which component it means. The validator is local and never trusts the
 * provider to have enforced the schema: an answer that fails it is not an answer.
 *
 * The prompt and the JSON Schema live in the service, not here: the browser has no use for them and
 * must never be able to change them.
 */
export const VEHICLE_PROTOCOL_NAME = 'VEHICLE_SEMANTIC_PROTOCOL_V0';
export const VEHICLE_PROMPT_VERSION = 'pv.0';
export const VEHICLE_SCHEMA_VERSION = 'sv.0';

export const VEHICLE_VIEW_ORDER: readonly ViewName[] = VIEW_NAMES;

export const MAX_WHEELS = 12;

export const VEHICLE_KINDS = ['car', 'truck', 'other_vehicle', 'not_a_vehicle', 'unclear'] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

/** A direction along one of the MODEL FILE's axes, or unclear. */
export const AXIS_DIRECTIONS = ['+X', '-X', '+Y', '-Y', '+Z', '-Z', 'unclear'] as const;
export type AxisDirection = (typeof AXIS_DIRECTIONS)[number];

export const SLOT_NAMES = ['cab', 'cargo_or_bed', 'chassis_or_main_body'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export const STATUS = ['PRESENT', 'UNCERTAIN', 'ABSENT'] as const;
export type Status = (typeof STATUS)[number];
export const VISIBILITY = ['visible', 'partially_visible', 'not_visible'] as const;
export type Visibility = (typeof VISIBILITY)[number];

export const WHEEL_IDS = Array.from(
  { length: MAX_WHEELS },
  (_, i) => `wheel_${i + 1}`,
) as readonly string[];
export const GROUPING = ['single_wheel', 'wheel_group'] as const;
export type Grouping = (typeof GROUPING)[number];
export const SIDES = ['subject_left', 'subject_right', 'center_or_unknown'] as const;
export type Side = (typeof SIDES)[number];
export const LONGITUDINAL = ['front', 'middle', 'rear', 'unknown'] as const;
export type Longitudinal = (typeof LONGITUDINAL)[number];
export const BOUNDARY_STATUS = ['PRESENT', 'UNCERTAIN', 'ABSENT'] as const;

// ---- The local validator --------------------------------------------------------------

export type Box4 = readonly [number, number, number, number];
export type Vec3T = readonly [number, number, number];

export interface ViewBox {
  readonly view: ViewName;
  readonly visibility: Visibility;
  /** Only a box that is a real rectangle wholly inside the image; otherwise null. */
  readonly box: Box4 | null;
}

export interface SlotReading {
  readonly status: Status;
  readonly center: Vec3T | null;
  readonly extent: Vec3T | null;
  readonly views: readonly ViewBox[];
}

export interface WheelReading {
  readonly id: string;
  readonly grouping: Grouping;
  readonly side: Side;
  readonly longitudinal: Longitudinal;
  readonly center: Vec3T | null;
  readonly extent: Vec3T | null;
  readonly views: readonly ViewBox[];
}

export interface BoundaryReading {
  readonly status: (typeof BOUNDARY_STATUS)[number];
  readonly segments: readonly { readonly view: ViewName; readonly segment: Box4 | null }[];
  readonly planeNormal: Vec3T | null;
  readonly planeOffset: number | null;
}

export interface VehicleAnswer {
  readonly kind: VehicleKind;
  readonly forward: AxisDirection;
  readonly up: AxisDirection;
  readonly parts: Readonly<Record<SlotName, SlotReading>>;
  readonly wheels: readonly WheelReading[];
  readonly boundary: BoundaryReading;
}

export type VehicleValidation =
  | { readonly ok: true; readonly value: VehicleAnswer }
  | { readonly ok: false; readonly errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  (list as readonly unknown[]).includes(v);

function exactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const k of keys) if (!(k in obj)) errors.push(`${path}.${k} is missing`);
  for (const k of Object.keys(obj))
    if (!keys.includes(k)) errors.push(`${path}.${k} is not allowed`);
}

function vec(v: unknown, path: string, errors: string[]): Vec3T | null {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) {
    errors.push(`${path} must be three numbers or null`);
    return null;
  }
  const [x, y, z] = v as [number, number, number];
  return [x, y, z];
}

/** A box is kept only if it is a real rectangle wholly inside the image. */
export function usableBox(b: readonly number[]): Box4 | null {
  if (b.length !== 4 || !b.every((x) => x >= 0 && x <= 1)) return null;
  const [x0, y0, x1, y1] = b as [number, number, number, number];
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

function viewBoxes(v: unknown, path: string, errors: string[]): ViewBox[] {
  const out: ViewBox[] = [];
  if (!Array.isArray(v) || v.length !== VEHICLE_VIEW_ORDER.length) {
    errors.push(`${path} must hold exactly ${VEHICLE_VIEW_ORDER.length} entries`);
    return out;
  }
  const seen = new Set<string>();
  v.forEach((e: unknown, i: number) => {
    const w = `${path}[${i}]`;
    if (!isRecord(e)) {
      errors.push(`${w} must be an object`);
      return;
    }
    exactKeys(e, ['view', 'visibility', 'box'], w, errors);
    if (!oneOf(VEHICLE_VIEW_ORDER, e.view)) {
      errors.push(`${w}.view is not allowed`);
      return;
    }
    if (seen.has(e.view)) errors.push(`${w}.view repeats ${e.view}`);
    seen.add(e.view);
    if (!oneOf(VISIBILITY, e.visibility)) {
      errors.push(`${w}.visibility is not allowed`);
      return;
    }
    let box: Box4 | null = null;
    if (e.box !== null) {
      if (!Array.isArray(e.box) || e.box.length !== 4 || !e.box.every(finite))
        errors.push(`${w}.box must be four numbers or null`);
      else box = usableBox(e.box);
    }
    out.push({ view: e.view, visibility: e.visibility, box });
  });
  return out;
}

function slot(v: unknown, path: string, errors: string[]): SlotReading | null {
  if (!isRecord(v)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  exactKeys(v, ['status', 'center', 'extent', 'views'], path, errors);
  if (!oneOf(STATUS, v.status)) {
    errors.push(`${path}.status is not allowed`);
    return null;
  }
  return {
    status: v.status,
    center: vec(v.center, `${path}.center`, errors),
    extent: vec(v.extent, `${path}.extent`, errors),
    views: viewBoxes(v.views, `${path}.views`, errors),
  };
}

/** Structural validation of a parsed answer. Coordinates need only be finite; unusable boxes become null. */
export function validateVehicle(raw: unknown): VehicleValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['response is not an object'] };
  exactKeys(raw, ['vehicle', 'parts', 'wheels', 'cab_bed_boundary'], '$', errors);
  let kind: VehicleKind = 'unclear';
  let forward: AxisDirection = 'unclear';
  let up: AxisDirection = 'unclear';
  const veh = raw.vehicle;
  if (!isRecord(veh)) errors.push('$.vehicle must be an object');
  else {
    exactKeys(veh, ['kind', 'forward_direction', 'up_direction'], '$.vehicle', errors);
    if (oneOf(VEHICLE_KINDS, veh.kind)) kind = veh.kind;
    else errors.push('$.vehicle.kind is not allowed');
    if (oneOf(AXIS_DIRECTIONS, veh.forward_direction)) forward = veh.forward_direction;
    else errors.push('$.vehicle.forward_direction is not allowed');
    if (oneOf(AXIS_DIRECTIONS, veh.up_direction)) up = veh.up_direction;
    else errors.push('$.vehicle.up_direction is not allowed');
  }
  const parts: Partial<Record<SlotName, SlotReading>> = {};
  if (!isRecord(raw.parts)) errors.push('$.parts must be an object');
  else {
    exactKeys(raw.parts, SLOT_NAMES, '$.parts', errors);
    for (const name of SLOT_NAMES) {
      const s = slot(raw.parts[name], `$.parts.${name}`, errors);
      if (s) parts[name] = s;
    }
  }
  const wheels: WheelReading[] = [];
  if (!Array.isArray(raw.wheels) || raw.wheels.length > MAX_WHEELS)
    errors.push(`$.wheels must be a list of at most ${MAX_WHEELS}`);
  else {
    const ids = new Set<string>();
    raw.wheels.forEach((w: unknown, i: number) => {
      const where = `$.wheels[${i}]`;
      if (!isRecord(w)) {
        errors.push(`${where} must be an object`);
        return;
      }
      exactKeys(
        w,
        ['semantic_id', 'grouping', 'side', 'longitudinal', 'center', 'extent', 'views'],
        where,
        errors,
      );
      if (!oneOf(WHEEL_IDS, w.semantic_id)) errors.push(`${where}.semantic_id is not allowed`);
      else if (ids.has(w.semantic_id)) errors.push(`${where}.semantic_id repeats ${w.semantic_id}`);
      else ids.add(w.semantic_id);
      if (!oneOf(GROUPING, w.grouping)) errors.push(`${where}.grouping is not allowed`);
      if (!oneOf(SIDES, w.side)) errors.push(`${where}.side is not allowed`);
      if (!oneOf(LONGITUDINAL, w.longitudinal)) errors.push(`${where}.longitudinal is not allowed`);
      const views = viewBoxes(w.views, `${where}.views`, errors);
      const center = vec(w.center, `${where}.center`, errors);
      const extent = vec(w.extent, `${where}.extent`, errors);
      if (
        oneOf(WHEEL_IDS, w.semantic_id) &&
        oneOf(GROUPING, w.grouping) &&
        oneOf(SIDES, w.side) &&
        oneOf(LONGITUDINAL, w.longitudinal)
      )
        wheels.push({
          id: w.semantic_id,
          grouping: w.grouping,
          side: w.side,
          longitudinal: w.longitudinal,
          center,
          extent,
          views,
        });
    });
  }
  let boundary: BoundaryReading = {
    status: 'ABSENT',
    segments: [],
    planeNormal: null,
    planeOffset: null,
  };
  const b = raw.cab_bed_boundary;
  if (!isRecord(b)) errors.push('$.cab_bed_boundary must be an object');
  else {
    exactKeys(
      b,
      ['status', 'segments', 'plane_normal', 'plane_offset'],
      '$.cab_bed_boundary',
      errors,
    );
    if (!oneOf(BOUNDARY_STATUS, b.status)) errors.push('$.cab_bed_boundary.status is not allowed');
    const segs: { view: ViewName; segment: Box4 | null }[] = [];
    if (!Array.isArray(b.segments) || b.segments.length !== VEHICLE_VIEW_ORDER.length)
      errors.push(
        `$.cab_bed_boundary.segments must hold exactly ${VEHICLE_VIEW_ORDER.length} entries`,
      );
    else
      b.segments.forEach((s: unknown, i: number) => {
        const w = `$.cab_bed_boundary.segments[${i}]`;
        if (!isRecord(s)) {
          errors.push(`${w} must be an object`);
          return;
        }
        exactKeys(s, ['view', 'segment'], w, errors);
        if (!oneOf(VEHICLE_VIEW_ORDER, s.view)) {
          errors.push(`${w}.view is not allowed`);
          return;
        }
        let seg: Box4 | null = null;
        if (s.segment !== null) {
          if (!Array.isArray(s.segment) || s.segment.length !== 4 || !s.segment.every(finite))
            errors.push(`${w}.segment must be four numbers or null`);
          else if (s.segment.every((x) => x >= 0 && x <= 1)) seg = s.segment as unknown as Box4;
        }
        segs.push({ view: s.view, segment: seg });
      });
    const off = b.plane_offset;
    if (off !== null && !finite(off))
      errors.push('$.cab_bed_boundary.plane_offset must be a number or null');
    if (oneOf(BOUNDARY_STATUS, b.status))
      boundary = {
        status: b.status,
        segments: segs,
        planeNormal: vec(b.plane_normal, '$.cab_bed_boundary.plane_normal', errors),
        planeOffset: finite(off) ? off : null,
      };
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { kind, forward, up, parts: parts as Record<SlotName, SlotReading>, wheels, boundary },
  };
}
