/**
 * THE HUMAN ANSWER (protocol `human-v1`): its vocabulary, its types and the local validator.
 *
 * Derived from the qualified direct-proposal research: three FIXED slots, always reported, with the
 * figure's OWN anatomical left and right. For each the model gives a status and, where it can, a rough
 * centre and size in normalized model coordinates and the plane that would take the part off the body
 * (a unit normal pointing from the body into the part, and an offset). Every value is an approximate
 * hint that Pybrix refines and the user reviews: nothing here is a coordinate to be trusted.
 *
 * NOT asked for: legs, hands, hips, clothing, accessories. The scope is the head and the two arms.
 */
export const HUMAN_PROTOCOL_NAME = 'HUMAN_SEMANTIC_PROTOCOL_V1';

export const HUMAN_SLOTS = ['head', 'left_arm', 'right_arm'] as const;
export type HumanSlot = (typeof HUMAN_SLOTS)[number];

export const HUMAN_FIGURE_KINDS = ['humanoid_figure', 'other_object', 'unclear'] as const;
export type HumanFigureKind = (typeof HUMAN_FIGURE_KINDS)[number];

export const HUMAN_STATUS = ['PRESENT', 'UNCERTAIN', 'ABSENT'] as const;
export type HumanStatus = (typeof HUMAN_STATUS)[number];

export type HumanVec3 = readonly [number, number, number];

export interface HumanPartReading {
  readonly status: HumanStatus;
  readonly center: HumanVec3 | null;
  readonly extent: HumanVec3 | null;
  /** A unit normal pointing from the body into the part, or null. */
  readonly planeNormal: HumanVec3 | null;
  /** The plane is `normal . x = offset` in normalized model coordinates, or null. */
  readonly planeOffset: number | null;
}

export interface HumanAnswer {
  readonly kind: HumanFigureKind;
  readonly parts: Readonly<Record<HumanSlot, HumanPartReading>>;
}

export type HumanValidation =
  | { readonly ok: true; readonly value: HumanAnswer }
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

function vec(v: unknown, path: string, errors: string[]): HumanVec3 | null {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) {
    errors.push(`${path} must be three numbers or null`);
    return null;
  }
  const [x, y, z] = v as [number, number, number];
  return [x, y, z];
}

/** Structural validation of a parsed human answer. Values need only be finite; the engine drops what is out of frame. */
export function validateHuman(raw: unknown): HumanValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['response is not an object'] };
  exactKeys(raw, ['figure', 'parts'], '$', errors);
  let kind: HumanFigureKind = 'unclear';
  const figure = raw.figure;
  if (!isRecord(figure)) errors.push('$.figure must be an object');
  else {
    exactKeys(figure, ['kind'], '$.figure', errors);
    if (oneOf(HUMAN_FIGURE_KINDS, figure.kind)) kind = figure.kind;
    else errors.push('$.figure.kind is not allowed');
  }
  const parts: Partial<Record<HumanSlot, HumanPartReading>> = {};
  if (!isRecord(raw.parts)) errors.push('$.parts must be an object');
  else {
    exactKeys(raw.parts, HUMAN_SLOTS, '$.parts', errors);
    for (const slot of HUMAN_SLOTS) {
      const where = `$.parts.${slot}`;
      const part = raw.parts[slot];
      if (!isRecord(part)) {
        errors.push(`${where} must be an object`);
        continue;
      }
      exactKeys(
        part,
        ['status', 'center', 'extent', 'plane_normal', 'plane_offset'],
        where,
        errors,
      );
      if (!oneOf(HUMAN_STATUS, part.status)) {
        errors.push(`${where}.status is not allowed`);
        continue;
      }
      const offset = part.plane_offset;
      if (offset !== null && !finite(offset))
        errors.push(`${where}.plane_offset must be a number or null`);
      parts[slot] = {
        status: part.status,
        center: vec(part.center, `${where}.center`, errors),
        extent: vec(part.extent, `${where}.extent`, errors),
        planeNormal: vec(part.plane_normal, `${where}.plane_normal`, errors),
        planeOffset: finite(offset) ? offset : null,
      };
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { kind, parts: parts as Record<HumanSlot, HumanPartReading> } };
}
