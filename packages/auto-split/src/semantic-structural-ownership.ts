import type { SemanticPart, Vec3 } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import type { Checkpoint } from './checkpoint';
import type { SuggestedPlane } from './suggestions';
import { groundedSourceFaceNormal } from './semantic-grounded-boundary';
import { interfaceTriangleFraction, type MaterialInterface } from './semantic-interface-membership';
import {
  interfaceOwnershipEvidence,
  type InterfaceOwnershipEvidence,
} from './semantic-interface-ownership';
import { SEMANTIC_PLANE_REFINEMENT_LIMITS } from './semantic-plane';

export type StructuralOwnershipState =
  | 'NOT_APPLICABLE'
  | 'IDENTIFIED'
  | 'TWO_WAY_UNRESOLVED'
  | 'MULTIWAY_UNRESOLVED'
  | 'INSUFFICIENT_EVIDENCE';
export interface StructuralOwnershipCardinality {
  readonly state: StructuralOwnershipState;
  readonly reason: string;
  readonly materialInterfaces: number;
  readonly interfaceComponents: number;
  readonly unresolvedClasses: number | null;
  readonly admittedCandidatesInspected: number;
  readonly sourceFaceVisits: number;
  readonly clippedOperations: number;
  readonly pixelVisits: number;
  readonly scratchBytes: number;
}
const TOLERANCE = 1e-7;
const CORRESPONDENCE = 1e-6;
const FACE_LIMIT = 8192;
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Inspect only planar source surfaces parallel and co-oriented with the supported
 * local interface, using existing admitted candidates. No planes are generated.
 * The unchanged face/feature caps bound expansion; all clipping is charged. */
export function structuralOwnershipCardinality(
  prepared: PreparedSemanticGeometry,
  target: SemanticPart,
  peers: readonly SemanticPart[],
  alternatives: readonly [SuggestedPlane, SuggestedPlane],
  candidates: readonly SuggestedPlane[],
  primary: InterfaceOwnershipEvidence | undefined,
  checkpoint: Checkpoint,
  charge: () => void,
): StructuralOwnershipCardinality {
  const g = prepared.geometry;
  let sourceFaceVisits = 0,
    clippedOperations = 0,
    pixelVisits = 0,
    scratchBytes = 0;
  const region = primary?.materialInterface;
  const result = (
    state: StructuralOwnershipState,
    reason: string,
    interfaces: number,
    classes: number | null,
  ): StructuralOwnershipCardinality => ({
    state,
    reason,
    materialInterfaces: interfaces,
    interfaceComponents: interfaces,
    unresolvedClasses: classes,
    admittedCandidatesInspected: candidates.length,
    sourceFaceVisits,
    clippedOperations,
    pixelVisits,
    scratchBytes,
  });
  if (!region || candidates.length < 2)
    return result('INSUFFICIENT_EVIDENCE', 'MATERIAL_INTERFACE_NOT_ESTABLISHED', 0, null);
  const first = region.faces[0];
  if (first === undefined) return result('INSUFFICIENT_EVIDENCE', 'EMPTY_INTERFACE', 0, null);
  const faceNormal = groundedSourceFaceNormal(g, first);
  const orientation = Math.sign(dot(faceNormal.vector, region.normal));
  const vertex = (f: number, k: number): Vec3 => {
    const i = (g.indices[f * 3 + k] ?? 0) * 3;
    return [g.positions[i] ?? 0, g.positions[i + 1] ?? 0, g.positions[i + 2] ?? 0];
  };
  const groups: { offset: number; faces: number[]; area: number }[] = [];
  // Source faces, not offsets or candidate planes, define the interface sets.
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    sourceFaceVisits++;
    const n = groundedSourceFaceNormal(g, f);
    if (!n.length || (orientation * dot(n.vector, region.normal)) / n.length < 0.99) continue;
    let low = Infinity,
      high = -Infinity;
    for (const cut of candidates) {
      checkpoint();
      charge();
      clippedOperations++;
      const fraction = interfaceTriangleFraction(g, f, cut);
      low = Math.min(low, fraction);
      high = Math.max(high, fraction);
      if (high - low > TOLERANCE) break;
    }
    if (high - low <= TOLERANCE) continue;
    const vertices = [vertex(f, 0), vertex(f, 1), vertex(f, 2)];
    const offset = vertices.reduce((s, v) => s + dot(region.normal, v), 0) / 3;
    if (vertices.some((v) => Math.abs(dot(region.normal, v) - offset) > CORRESPONDENCE))
      return result('INSUFFICIENT_EVIDENCE', 'NONPLANAR_MEMBERSHIP_DELTA', groups.length, null);
    if (!groups.some((v) => Math.abs(v.offset - offset) <= CORRESPONDENCE)) {
      if (groups.length >= SEMANTIC_PLANE_REFINEMENT_LIMITS.shoulderPlanes)
        return result('INSUFFICIENT_EVIDENCE', 'INTERFACE_FEATURE_CAP', groups.length, null);
      groups.push({ offset, faces: [], area: 0 });
    }
  }
  let retained = 0;
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    sourceFaceVisits++;
    const n = groundedSourceFaceNormal(g, f);
    if (!n.length || (orientation * dot(n.vector, region.normal)) / n.length < 1 - CORRESPONDENCE)
      continue;
    const vertices = [vertex(f, 0), vertex(f, 1), vertex(f, 2)];
    const matches = groups.filter((group) =>
      vertices.every((v) => Math.abs(dot(region.normal, v) - group.offset) <= CORRESPONDENCE),
    );
    if (matches.length > 1)
      return result('INSUFFICIENT_EVIDENCE', 'OVERLAPPING_INTERFACE_PLANES', groups.length, null);
    const group = matches[0];
    if (!group) continue;
    if (retained >= FACE_LIMIT)
      return result('INSUFFICIENT_EVIDENCE', 'INTERFACE_FACE_CAP', groups.length, null);
    retained++;
    group.faces.push(f);
    group.area += n.length / 2;
  }
  let unresolved = 0;
  for (const group of groups) {
    const parent = group.faces.map((_, i) => i),
      edges = new Map<string, number>();
    const root = (index: number): number => {
      let i = index;
      while (parent[i] !== i) {
        checkpoint();
        i = parent[i] ?? i;
      }
      return i;
    };
    for (const [i, f] of group.faces.entries()) {
      checkpoint();
      charge();
      const keys = [0, 1, 2].map((k) =>
        vertex(f, k)
          .map((x) => (x === 0 ? 0 : x))
          .join(','),
      );
      for (let k = 0; k < 3; k++) {
        const a = keys[k] ?? '',
          b = keys[(k + 1) % 3] ?? '',
          key = a < b ? a + '|' + b : b + '|' + a;
        const previous = edges.get(key);
        if (previous === undefined) edges.set(key, i);
        else parent[root(i)] = root(previous);
      }
    }
    // This is a declared storage bound, not measured allocator/heap memory.
    scratchBytes = Math.max(scratchBytes, retained * 20 + edges.size * 160);
    if (!group.faces.length || group.faces.some((_, i) => root(i) !== root(0)))
      return result('INSUFFICIENT_EVIDENCE', 'DISCONNECTED_MEMBERSHIP_DELTA', groups.length, null);
    const collected: MaterialInterface = {
      faces: group.faces,
      normal: region.normal,
      offset: group.offset,
      area: group.area,
      sourceFacesInspected: sourceFaceVisits,
      clippedOperations,
      scratchBytes,
    };
    const evidence =
      Math.abs(group.offset - region.offset) <= CORRESPONDENCE
        ? primary
        : interfaceOwnershipEvidence(
            prepared,
            target,
            peers,
            alternatives,
            checkpoint,
            charge,
            collected,
          );
    if (!evidence)
      return result('INSUFFICIENT_EVIDENCE', 'INTERFACE_EVIDENCE_MISSING', groups.length, null);
    pixelVisits += evidence.pixelVisits;
    if (evidence.conflict)
      return result(
        'INSUFFICIENT_EVIDENCE',
        'CONTRADICTORY_INTERFACE_OWNERSHIP',
        groups.length,
        null,
      );
    if (evidence.ownership === 'AMBIGUOUS') unresolved++;
  }
  if (!groups.length) return result('INSUFFICIENT_EVIDENCE', 'NO_RELEVANT_INTERFACE', 0, null);
  if (unresolved > 1)
    return result(
      'MULTIWAY_UNRESOLVED',
      'MULTIPLE_UNRESOLVED_MATERIAL_INTERFACES',
      groups.length,
      unresolved + 1,
    );
  if (groups.length > 1)
    return result(
      'INSUFFICIENT_EVIDENCE',
      'MULTIPLE_MATERIAL_INTERFACE_PLANES',
      groups.length,
      null,
    );
  return unresolved === 1
    ? result('TWO_WAY_UNRESOLVED', 'ONE_CONNECTED_UNRESOLVED_INTERFACE', 1, 2)
    : result('IDENTIFIED', 'POSITIVE_INTERFACE_OWNERSHIP', 1, 1);
}

/** A stable two-sided neck has one physical decomposition only when its entire
 * admitted minimum interval contains no material planar ownership transition. */
export function structuralNeckOwnershipCardinality(
  prepared: PreparedSemanticGeometry,
  normal: Vec3,
  interval: readonly [number, number],
  admittedCandidates: number,
  checkpoint: Checkpoint,
  charge: () => void,
): StructuralOwnershipCardinality {
  const g = prepared.geometry;
  let visits = 0,
    variable = false;
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    visits++;
    const n = groundedSourceFaceNormal(g, f);
    if (!n.length || Math.abs(dot(n.vector, normal) / n.length) < 0.99) continue;
    let lo = Infinity,
      hi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const i = (g.indices[f * 3 + k] ?? 0) * 3;
      const p: Vec3 = [g.positions[i] ?? 0, g.positions[i + 1] ?? 0, g.positions[i + 2] ?? 0];
      const d = dot(normal, p);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    if (hi >= interval[0] - CORRESPONDENCE && lo <= interval[1] + CORRESPONDENCE) {
      variable = true;
      break;
    }
  }
  return {
    state: variable ? 'INSUFFICIENT_EVIDENCE' : 'IDENTIFIED',
    reason: variable
      ? 'MATERIAL_INTERFACE_IN_NECK_INTERVAL'
      : 'SUPPORTED_NECK_WITH_NO_MATERIAL_INTERFACE',
    materialInterfaces: variable ? 1 : 0,
    interfaceComponents: 0,
    unresolvedClasses: variable ? null : 1,
    admittedCandidatesInspected: admittedCandidates,
    sourceFaceVisits: visits,
    clippedOperations: 0,
    pixelVisits: 0,
    scratchBytes: 0,
  };
}
