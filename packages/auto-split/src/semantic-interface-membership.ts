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
    const a = requiredValue(input[i]),
      b = requiredValue(input[(i + 1) % 3]),
      da = distance(a),
      db = distance(b);
    if (da >= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  const total = area(requiredValue(input[0]), requiredValue(input[1]), requiredValue(input[2]));
  let selected = 0;
  for (let i = 1; i + 1 < out.length; i++)
    selected += area(requiredValue(out[0]), requiredValue(out[i]), requiredValue(out[i + 1]));
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
  readonly completion?: SourceInterfaceCompletionTelemetry;
}
export interface SourceInterfaceCompletionTelemetry {
  readonly seedFaces: number;
  readonly candidateFaces: number;
  readonly completedFaces: number;
  readonly adjacencyTraversals: number;
  readonly sourceFaceVisits: number;
}
export type SourceInterfaceCompletion =
  | {
      readonly valid: true;
      readonly faces: readonly number[];
      readonly area: number;
      readonly scratchBytes: number;
      readonly telemetry: SourceInterfaceCompletionTelemetry;
    }
  | {
      readonly valid: false;
      readonly reason:
        | 'INTERFACE_FACE_CAP'
        | 'INTERFACE_SEED_UNAVAILABLE'
        | 'OPPOSED_INTERFACE_ORIENTATION'
        | 'AMBIGUOUS_SOURCE_ADJACENCY'
        | 'DISCONNECTED_MEMBERSHIP_DELTA';
      readonly telemetry: SourceInterfaceCompletionTelemetry;
    };
/** Strict normals identify seeds; complete membership follows exact original-source edges.
 * Every completion vertex must correspond to the SAME fitted plane. Normal sign preserves winding;
 * a local normal's angular accuracy cannot remove an otherwise corresponding tiny source triangle.
 * All eligible components are retained for the connectivity check: none is silently discarded. */
export function completeSourceInterface(
  g: NormalizedGeometry,
  normal: Vec3,
  offset: number,
  seeds: readonly number[],
  checkpoint: Checkpoint,
  charge: () => void,
): SourceInterfaceCompletion {
  let visits = 0,
    traversals = 0,
    completed = 0;
  const eligible: number[] = [],
    faceEdges: string[][] = [],
    edges = new Map<string, number[]>();
  const telemetry = (): SourceInterfaceCompletionTelemetry => ({
    seedFaces: seeds.length,
    candidateFaces: eligible.length,
    completedFaces: completed,
    adjacencyTraversals: traversals,
    sourceFaceVisits: visits,
  });
  const refuse = (
    reason: Extract<SourceInterfaceCompletion, { valid: false }>['reason'],
  ): SourceInterfaceCompletion => ({ valid: false, reason, telemetry: telemetry() });
  const first = seeds[0];
  if (first === undefined) return refuse('INTERFACE_SEED_UNAVAILABLE');
  const seedNormal = groundedSourceFaceNormal(g, first);
  const orientation = Math.sign(dot(seedNormal.vector, normal));
  if (!orientation) return refuse('OPPOSED_INTERFACE_ORIENTATION');
  const keys = (f: number): string[] => {
    const vertices = [0, 1, 2].map((k) =>
      vertex(g, f, k)
        .map((x) => (x === 0 ? 0 : x))
        .join(','),
    );
    return vertices.map((a, k) => {
      const b = requiredValue(vertices[(k + 1) % 3]);
      return a < b ? a + '|' + b : b + '|' + a;
    });
  };
  let surface = 0;
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    visits++;
    if ([0, 1, 2].some((k) => Math.abs(dot(normal, vertex(g, f, k)) - offset) > CORRESPONDENCE))
      continue;
    const n = groundedSourceFaceNormal(g, f);
    if (!n.length || orientation * dot(n.vector, normal) <= 0)
      return refuse('OPPOSED_INTERFACE_ORIENTATION');
    if (eligible.length >= FACE_LIMIT) return refuse('INTERFACE_FACE_CAP');
    const index = eligible.length;
    eligible.push(f);
    surface += n.length / 2;
    const row = keys(f);
    faceEdges.push(row);
    for (const edge of row) {
      const adjacent = edges.get(edge) ?? [];
      adjacent.push(index);
      if (adjacent.length > 2) return refuse('AMBIGUOUS_SOURCE_ADJACENCY');
      edges.set(edge, adjacent);
    }
  }
  // A third original face on an eligible edge is ambiguous even if that face lies off-plane.
  const incidences = new Map<string, number>();
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    visits++;
    for (const edge of keys(f))
      if (edges.has(edge)) {
        const count = (incidences.get(edge) ?? 0) + 1;
        if (count > 2) return refuse('AMBIGUOUS_SOURCE_ADJACENCY');
        incidences.set(edge, count);
      }
  }
  const start = eligible.indexOf(first);
  const eligibleSet = new Set(eligible);
  if (start < 0 || seeds.some((f) => !eligibleSet.has(f)))
    return refuse('INTERFACE_SEED_UNAVAILABLE');
  const seen = new Uint8Array(eligible.length),
    pending = [start];
  seen[start] = 1;
  while (pending.length) {
    checkpoint();
    charge();
    const i = requiredValue(pending.pop());
    completed++;
    for (const edge of requiredValue(faceEdges[i]))
      for (const next of edges.get(edge) ?? []) {
        traversals++;
        charge();
        if (!seen[next]) {
          seen[next] = 1;
          pending.push(next);
        }
      }
  }
  if (completed !== eligible.length) return refuse('DISCONNECTED_MEMBERSHIP_DELTA');
  return {
    valid: true,
    faces: eligible,
    area: surface,
    scratchBytes: eligible.length * 24 + edges.size * 192,
    telemetry: telemetry(),
  };
}

/** Complete a single connected planar source interface; never bridge disconnected coplanar caps. */
export function collectMaterialInterface(
  g: NormalizedGeometry,
  cuts: readonly [SuggestedPlane, SuggestedPlane],
  checkpoint: Checkpoint,
  charge: () => void,
): MaterialInterface | undefined {
  // Fit the supporting plane from the changed surface, rather than amplifying
  // one small triangle's floating-point normal error over the whole interface.
  // The correspondence bound and complete connected expansion stay unchanged.
  const changed: number[] = [],
    sum = [0, 0, 0],
    center = [0, 0, 0];
  let total = 0,
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
    if (changed.length >= FACE_LIMIT) return undefined;
    changed.push(f);
    const sign = Math.sign(dot(unit, cuts[0].normal));
    for (let a = 0; a < 3; a++) {
      sum[a] = (sum[a] ?? 0) + sign * (n.vector[a] ?? 0);
      center[a] =
        (center[a] ?? 0) +
        (n.length *
          ((vertex(g, f, 0)[a] ?? 0) + (vertex(g, f, 1)[a] ?? 0) + (vertex(g, f, 2)[a] ?? 0))) /
          3;
    }
    total += n.length;
  }
  const magnitude = Math.hypot(...sum);
  if (!changed.length || !(magnitude > 0) || !(total > 0)) return undefined;
  const normal = sum.map((x) => x / magnitude) as unknown as Vec3;
  const anchor = center.map((x) => x / total) as unknown as Vec3;
  const seeds: number[] = [];
  const offset = dot(normal, anchor);
  for (const f of changed) {
    checkpoint();
    charge();
    if ([0, 1, 2].some((k) => Math.abs(dot(normal, vertex(g, f, k)) - offset) > CORRESPONDENCE))
      return undefined;
    const n = groundedSourceFaceNormal(g, f);
    if (Math.abs(dot(normal, n.vector) / n.length) >= 1 - CORRESPONDENCE) seeds.push(f);
  }
  const completion = completeSourceInterface(g, normal, offset, seeds, checkpoint, charge);
  if (!completion.valid) return undefined;
  return {
    faces: completion.faces,
    normal,
    offset,
    area: completion.area,
    sourceFacesInspected: g.faceCount + completion.telemetry.sourceFaceVisits,
    clippedOperations: clips,
    scratchBytes: completion.scratchBytes + changed.length * 8,
    completion: completion.telemetry,
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

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
