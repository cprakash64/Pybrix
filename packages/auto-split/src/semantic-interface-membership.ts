import type { Vec3 } from '@cadfixer/auto-split-contract';
import type { NormalizedGeometry } from './geometry';
import type { SuggestedPlane } from './suggestions';
import type { Checkpoint } from './checkpoint';
import { groundedSourceFaceNormal } from './semantic-grounded-boundary';

const TOLERANCE = 1e-7;
const CORRESPONDENCE = 1e-6;
const FACE_LIMIT = 8192;
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vertex = (g: NormalizedGeometry, f: number, k: number): Vec3 => {
  const i = (g.indices[f * 3 + k] ?? 0) * 3;
  return [g.positions[i] ?? 0, g.positions[i + 1] ?? 0, g.positions[i + 2] ?? 0];
};
const area = (a: Vec3, b: Vec3, c: Vec3): number => {
  const u = b.map((x, i) => x - (a[i] ?? 0)),
    v = c.map((x, i) => x - (a[i] ?? 0));
  return (
    Math.hypot(
      (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
      (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
      (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
    ) / 2
  );
};
/** Exact clipped fraction of one original triangle. Constant-sized polygon scratch. */
export function interfaceTriangleFraction(
  g: NormalizedGeometry,
  f: number,
  cut: SuggestedPlane,
): number {
  const input = [vertex(g, f, 0), vertex(g, f, 1), vertex(g, f, 2)],
    out: Vec3[] = [];
  const distance = (p: Vec3): number => dot(cut.normal, p) - dot(cut.normal, cut.origin);
  for (let i = 0; i < 3; i++) {
    const a = input[i]!,
      b = input[(i + 1) % 3]!,
      da = distance(a),
      db = distance(b);
    if (da >= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  const total = area(input[0]!, input[1]!, input[2]!);
  let selected = 0;
  for (let i = 1; i + 1 < out.length; i++) selected += area(out[0]!, out[i]!, out[i + 1]!);
  return total > 0 ? Math.max(0, Math.min(1, selected / total)) : 0;
}
export interface MaterialInterface {
  readonly faces: readonly number[];
  readonly normal: Vec3;
  readonly offset: number;
  readonly area: number;
  readonly sourceFacesInspected: number;
  readonly clippedOperations: number;
  readonly scratchBytes: number;
}
/** Complete a single connected planar source interface; never bridge disconnected coplanar caps. */
export function collectMaterialInterface(
  g: NormalizedGeometry,
  cuts: readonly [SuggestedPlane, SuggestedPlane],
  checkpoint: Checkpoint,
  charge: () => void,
): MaterialInterface | undefined {
  let anchor: Vec3 | undefined,
    normal: Vec3 | undefined,
    clips = 0;
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    const n = groundedSourceFaceNormal(g, f);
    if (!n.length) continue;
    const unit = n.vector.map((x) => x / n.length) as unknown as Vec3;
    if (!cuts.every((c) => Math.abs(dot(unit, c.normal)) >= 0.99)) continue;
    clips += 2;
    if (
      Math.abs(
        interfaceTriangleFraction(g, f, cuts[0]) - interfaceTriangleFraction(g, f, cuts[1]),
      ) <= TOLERANCE
    )
      continue;
    const p = vertex(g, f, 0);
    if (!normal) {
      normal = dot(unit, cuts[0].normal) >= 0 ? unit : (unit.map((x) => -x) as unknown as Vec3);
      anchor = p;
    } else if (
      Math.abs(dot(normal, unit)) < 1 - CORRESPONDENCE ||
      Math.abs(dot(normal, p) - dot(normal, anchor!)) > CORRESPONDENCE
    )
      return undefined;
  }
  if (!normal || !anchor) return undefined;
  const offset = dot(normal, anchor),
    faces: number[] = [];
  let surface = 0;
  const parent: number[] = [],
    edges = new Map<string, number>();
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    const n = groundedSourceFaceNormal(g, f);
    if (!n.length || Math.abs(dot(normal, n.vector) / n.length) < 1 - CORRESPONDENCE) continue;
    const vertices = [vertex(g, f, 0), vertex(g, f, 1), vertex(g, f, 2)];
    if (vertices.some((p) => Math.abs(dot(normal!, p) - offset) > CORRESPONDENCE)) continue;
    if (faces.length >= FACE_LIMIT) return undefined;
    const index = faces.length;
    parent.push(index);
    faces.push(f);
    surface += n.length / 2;
    const keys = vertices.map((p) => p.map((x) => (x === 0 ? 0 : x)).join(','));
    for (let k = 0; k < 3; k++) {
      const a = keys[k]!,
        b = keys[(k + 1) % 3]!,
        key = a < b ? a + '|' + b : b + '|' + a,
        other = edges.get(key);
      if (other !== undefined) parent[root(index)] = root(other);
      else edges.set(key, index);
    }
  }
  checkpoint();
  if (!faces.length || faces.some((_f, i) => root(i) !== root(0))) return undefined;
  return {
    faces,
    normal,
    offset,
    area: surface,
    sourceFacesInspected: g.faceCount * 2,
    clippedOperations: clips,
    scratchBytes: faces.length * 20 + edges.size * 160,
  };
}
export interface InterfaceMembershipSignature {
  readonly ownership: 'TARGET_SIDE' | 'BODY_SIDE' | 'INTERMEDIATE';
  readonly selectedArea: number;
  readonly excludedArea: number;
  readonly partialFaces: number;
  readonly clippedOperations: number;
}
export function interfaceMembershipSignature(
  g: NormalizedGeometry,
  region: MaterialInterface,
  cut: SuggestedPlane,
  checkpoint: Checkpoint,
  charge: () => void,
): InterfaceMembershipSignature {
  let selectedArea = 0,
    partialFaces = 0,
    all = true,
    none = true;
  for (const f of region.faces) {
    checkpoint();
    charge();
    const fraction = interfaceTriangleFraction(g, f, cut),
      n = groundedSourceFaceNormal(g, f);
    selectedArea += (fraction * n.length) / 2;
    if (fraction < TOLERANCE) all = false;
    else if (fraction < 1 - TOLERANCE) {
      partialFaces++;
      all = false;
      none = false;
    } else none = false;
  }
  return {
    ownership: all ? 'TARGET_SIDE' : none ? 'BODY_SIDE' : 'INTERMEDIATE',
    selectedArea,
    excludedArea: Math.max(0, region.area - selectedArea),
    partialFaces,
    clippedOperations: region.faces.length,
  };
}
/** Lateral correspondence to an actual interface triangle, using the existing raster uncertainty. */
export function interfaceCorrespondsToPoint(
  g: NormalizedGeometry,
  region: MaterialInterface,
  p: Vec3,
  uncertainty: number,
  checkpoint: Checkpoint,
  charge: () => void,
): boolean {
  const d = dot(region.normal, p) - region.offset,
    q = p.map((x, i) => x - d * (region.normal[i] ?? 0)) as unknown as Vec3;
  for (const f of region.faces) {
    checkpoint();
    charge();
    const a = vertex(g, f, 0),
      b = vertex(g, f, 1),
      c = vertex(g, f, 2);
    const total = area(a, b, c);
    const perimeter =
      Math.hypot(...b.map((x, i) => x - (a[i] ?? 0))) +
      Math.hypot(...c.map((x, i) => x - (b[i] ?? 0))) +
      Math.hypot(...a.map((x, i) => x - (c[i] ?? 0)));
    if (area(q, a, b) + area(q, b, c) + area(q, c, a) <= total + uncertainty * perimeter)
      return true;
  }
  return false;
}
