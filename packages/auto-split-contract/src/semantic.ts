function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing validated ${what}`);
  return value;
}
import { VIEW_NAMES, type ViewName } from './limits';
import type { Vec3 } from './views';
/** Structural bounds, not an object/part taxonomy. Labels remain model-specific. */
export const SEMANTIC_LIMITS = Object.freeze({
  parts: 24,
  major: 8,
  depth: 4,
  regionsPerView: 2,
  polygonPoints: 12,
  components: 64,
  instances: 12,
  label: 64,
  id: 48,
  normalPngBytes: 320 * 1024,
  overlayPngBytes: 128 * 1024,
  metadataBytes: 32 * 1024,
});
export const SEMANTIC_GEOMETRY_KINDS = [
  'solid_part',
  'surface_part',
  'repeated_part',
  'unknown',
] as const;
export type SemanticGeometryKind = (typeof SEMANTIC_GEOMETRY_KINDS)[number];
export type ImagePoint = readonly [number, number];
export interface SemanticRegion {
  readonly view: ViewName;
  readonly polygons: readonly (readonly ImagePoint[])[];
}
export interface SemanticPart {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly importance: 'major' | 'detail';
  readonly confidence: number;
  readonly instances: number;
  readonly views: readonly SemanticRegion[];
  readonly componentIds: readonly string[];
  readonly expectedGeometry: {
    readonly kind: SemanticGeometryKind;
    readonly likelySeparable: boolean;
  };
  /** An approximate plane in normalized model coordinates. Local validation remains authoritative. */
  readonly cut: {
    readonly normal: Vec3;
    readonly origin: Vec3;
  } | null;
}
export interface SemanticHierarchy {
  readonly object: {
    readonly label: string;
    readonly confidence: number;
  };
  readonly parts: readonly SemanticPart[];
}
export interface SemanticComponentMetadata {
  readonly id: string;
  readonly faceCount: number;
  readonly bounds: {
    readonly min: Vec3;
    readonly max: Vec3;
  };
  readonly centroid: Vec3;
  readonly areaShare: number;
  readonly aspect: Vec3;
  readonly color: readonly [number, number, number];
}
export interface SemanticRequestMetadata {
  readonly scope: 'entire-model' | 'selected-piece';
  readonly components: readonly SemanticComponentMetadata[];
  readonly totalComponents: number;
}
export const semanticComponentId = (rank: number): string => `c${String(rank).padStart(6, '0')}`;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const confidence = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
const integer = (v: unknown, lo: number, hi: number): v is number =>
  finite(v) && Number.isInteger(v) && v >= lo && v <= hi;
const label = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= SEMANTIC_LIMITS.label &&
  Array.from(v).every((ch) => {
    const n = ch.codePointAt(0) ?? 0;
    return n >= 32 && n !== 127;
  });
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/u.test(v);
const componentId = (v: unknown): v is string => typeof v === 'string' && /^c\d{6}$/u.test(v);
const vec = (v: unknown): v is Vec3 =>
  Array.isArray(v) &&
  v.length === 3 &&
  Array.from(v).every((x) => finite(x) && Math.abs(x) <= 1.0001);
const cross = (a: ImagePoint, b: ImagePoint, c: ImagePoint): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
/** Reject self-crossing/degenerate contours before pixel work. */
export function validSemanticPolygon(v: unknown): v is readonly ImagePoint[] {
  if (
    !Array.isArray(v) ||
    v.length < 3 ||
    v.length > SEMANTIC_LIMITS.polygonPoints ||
    !Array.from(v as unknown[]).every(
      (p) => Array.isArray(p) && p.length === 2 && Array.from(p as unknown[]).every(confidence),
    )
  )
    return false;
  const p = v as ImagePoint[];
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const a = required(p[i], 'p[i]'),
      b = required(p[(i + 1) % p.length], 'p[(i + 1) % p.length]');
    if (a[0] === b[0] && a[1] === b[1]) return false;
    area += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 2; j < p.length; j++) {
      if (i === 0 && j === p.length - 1) continue;
      const c = required(p[j], 'p[j]'),
        d = required(p[(j + 1) % p.length], 'p[(j + 1) % p.length]');
      const x = cross(a, b, c),
        y = cross(a, b, d),
        z = cross(c, d, a),
        w = cross(c, d, b);
      const on = (q: ImagePoint, start: ImagePoint, end: ImagePoint): boolean =>
        q[0] >= Math.min(start[0], end[0]) &&
        q[0] <= Math.max(start[0], end[0]) &&
        q[1] >= Math.min(start[1], end[1]) &&
        q[1] <= Math.max(start[1], end[1]);
      if (
        (x * y < 0 && z * w < 0) ||
        (x === 0 && on(c, a, b)) ||
        (y === 0 && on(d, a, b)) ||
        (z === 0 && on(a, c, d)) ||
        (w === 0 && on(b, c, d))
      )
        return false;
    }
  }
  return Math.abs(area) > 1e-6;
}
export function validateSemanticHierarchy(raw: unknown):
  | {
      readonly ok: true;
      readonly value: SemanticHierarchy;
    }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
    } {
  const bad = (): {
    readonly ok: false;
    readonly errors: readonly string[];
  } => ({
    ok: false,
    errors: ['Invalid bounded semantic hierarchy.'],
  });
  if (
    !record(raw) ||
    !exact(raw, ['object', 'parts']) ||
    !record(raw.object) ||
    !exact(raw.object, ['label', 'confidence']) ||
    !label(raw.object.label) ||
    !confidence(raw.object.confidence) ||
    !Array.isArray(raw.parts) ||
    raw.parts.length > SEMANTIC_LIMITS.parts
  )
    return bad();
  const parts: SemanticPart[] = [];
  const ids = new Set<string>();
  let majors = 0;
  for (const p of raw.parts) {
    if (
      !record(p) ||
      !exact(p, [
        'id',
        'label',
        'parentId',
        'importance',
        'confidence',
        'instances',
        'views',
        'componentIds',
        'expectedGeometry',
        'cut',
      ]) ||
      !id(p.id) ||
      ids.has(p.id) ||
      !label(p.label) ||
      (p.parentId !== null && !id(p.parentId)) ||
      typeof p.importance !== 'string' ||
      !['major', 'detail'].includes(p.importance) ||
      !confidence(p.confidence) ||
      !integer(p.instances, 1, SEMANTIC_LIMITS.instances) ||
      !Array.isArray(p.views) ||
      p.views.length > VIEW_NAMES.length ||
      !Array.isArray(p.componentIds) ||
      p.componentIds.length > SEMANTIC_LIMITS.components ||
      !Array.from(p.componentIds as unknown[]).every(componentId) ||
      new Set(p.componentIds).size !== p.componentIds.length
    )
      return bad();
    if (p.importance === 'major' && ++majors > SEMANTIC_LIMITS.major) return bad();
    const seen = new Set<string>();
    for (const v of p.views) {
      if (
        !record(v) ||
        !exact(v, ['view', 'polygons']) ||
        !VIEW_NAMES.includes(v.view as ViewName) ||
        seen.has(String(v.view)) ||
        !Array.isArray(v.polygons) ||
        v.polygons.length < 1 ||
        v.polygons.length > SEMANTIC_LIMITS.regionsPerView ||
        !Array.from(v.polygons as unknown[]).every(validSemanticPolygon)
      )
        return bad();
      seen.add(String(v.view));
    }
    const g = p.expectedGeometry;
    if (
      !record(g) ||
      !exact(g, ['kind', 'likelySeparable']) ||
      !SEMANTIC_GEOMETRY_KINDS.includes(g.kind as SemanticGeometryKind) ||
      typeof g.likelySeparable !== 'boolean'
    )
      return bad();
    if (p.cut !== null) {
      if (
        !record(p.cut) ||
        !exact(p.cut, ['normal', 'origin']) ||
        !vec(p.cut.normal) ||
        !vec(p.cut.origin) ||
        Math.hypot(...p.cut.normal) < 1e-6
      )
        return bad();
    }
    ids.add(p.id);
    parts.push(p as unknown as SemanticPart);
  }
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const p of parts) {
    let next: SemanticPart | undefined = p;
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(next.id) || visited.size >= SEMANTIC_LIMITS.depth) return bad();
      visited.add(next.id);
      if (next.parentId === null) break;
      next = byId.get(next.parentId);
      if (!next) return bad();
    }
  }
  return {
    ok: true,
    value: { object: raw.object as unknown as SemanticHierarchy['object'], parts },
  };
}
export function validateSemanticMetadata(raw: unknown): raw is SemanticRequestMetadata {
  if (
    !record(raw) ||
    !exact(raw, ['scope', 'components', 'totalComponents']) ||
    typeof raw.scope !== 'string' ||
    !['entire-model', 'selected-piece'].includes(raw.scope) ||
    !integer(raw.totalComponents, 1, 2000000) ||
    !Array.isArray(raw.components) ||
    raw.components.length > SEMANTIC_LIMITS.components ||
    raw.components.length > raw.totalComponents
  )
    return false;
  const seen = new Set<string>();
  for (const c of raw.components) {
    if (
      !record(c) ||
      !exact(c, ['id', 'faceCount', 'bounds', 'centroid', 'areaShare', 'aspect', 'color']) ||
      !componentId(c.id) ||
      seen.has(c.id) ||
      !integer(c.faceCount, 1, 2000000) ||
      !vec(c.centroid) ||
      !confidence(c.areaShare) ||
      !vec(c.aspect) ||
      !c.aspect.every((x) => x >= 0) ||
      !Array.isArray(c.color) ||
      c.color.length !== 3 ||
      !Array.from(c.color as unknown[]).every((x) => integer(x, 0, 255)) ||
      !record(c.bounds) ||
      !exact(c.bounds, ['min', 'max']) ||
      !vec(c.bounds.min) ||
      !vec(c.bounds.max)
    )
      return false;
    const maximum = c.bounds.max;
    if (!c.bounds.min.every((x, i) => x <= required(maximum[i], 'maximum[i]'))) return false;
    seen.add(c.id);
  }
  return JSON.stringify(raw).length <= SEMANTIC_LIMITS.metadataBytes;
}
