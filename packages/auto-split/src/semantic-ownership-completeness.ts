import type { Vec3 } from '@cadfixer/auto-split-contract';
import type { Checkpoint } from './checkpoint';
import type { NormalizedGeometry } from './geometry';
import { groundedSourceFaceNormal } from './semantic-grounded-boundary';
import { SEMANTIC_PLANE_REFINEMENT_LIMITS } from './semantic-plane';

export type InterfaceResolution =
  | 'POSITIVELY_TARGET_OWNED'
  | 'POSITIVELY_BODY_OWNED'
  | 'PROVEN_IRRELEVANT'
  | 'REPRESENTED_UNRESOLVED'
  | 'UNREPRESENTED_UNRESOLVED'
  | 'CONFLICTED';
export interface OwnershipInterfaceResolution {
  readonly offset: number;
  readonly faces: number;
  readonly resolution: InterfaceResolution;
}
export interface OwnershipCompleteness {
  readonly state: 'COMPLETE' | 'INCOMPLETE_UNRESOLVED' | 'INCOMPLETE_CONFLICTED' | 'NOT_APPLICABLE';
  readonly reason: string;
  readonly inventoried: number;
  readonly resolvedTarget: number;
  readonly resolvedBody: number;
  readonly provenIrrelevant: number;
  readonly representedUnresolved: number;
  readonly unrepresentedUnresolved: number;
  readonly conflicted: number;
  readonly inventoryLimit: number;
  readonly interfaces: readonly OwnershipInterfaceResolution[];
}
/** Candidate membership can resolve an inventoried row, but cannot delete it. */
export function ownershipCompleteness(
  interfaces: readonly OwnershipInterfaceResolution[],
  inventoryFailure?: string,
): OwnershipCompleteness {
  const count = (kind: InterfaceResolution): number =>
    interfaces.filter((row) => row.resolution === kind).length;
  const conflicted = count('CONFLICTED'),
    unrepresented = count('UNREPRESENTED_UNRESOLVED');
  const capped = interfaces.length > SEMANTIC_PLANE_REFINEMENT_LIMITS.shoulderPlanes;
  return {
    state: conflicted
      ? 'INCOMPLETE_CONFLICTED'
      : inventoryFailure || capped || unrepresented
        ? 'INCOMPLETE_UNRESOLVED'
        : 'COMPLETE',
    reason:
      inventoryFailure ??
      (capped
        ? 'INTERFACE_FEATURE_CAP'
        : conflicted
          ? 'CONTRADICTORY_INTERFACE_OWNERSHIP'
          : unrepresented
            ? 'UNREPRESENTED_UNRESOLVED_SOURCE_INTERFACE'
            : 'ALL_RELEVANT_SOURCE_INTERFACES_ACCOUNTED_FOR'),
    inventoried: interfaces.length,
    resolvedTarget: count('POSITIVELY_TARGET_OWNED'),
    resolvedBody: count('POSITIVELY_BODY_OWNED'),
    provenIrrelevant: count('PROVEN_IRRELEVANT'),
    representedUnresolved: count('REPRESENTED_UNRESOLVED'),
    unrepresentedUnresolved: unrepresented,
    conflicted,
    inventoryLimit: SEMANTIC_PLANE_REFINEMENT_LIMITS.shoulderPlanes,
    interfaces,
  };
}
export function resolveOwnershipInterface(
  ownership: 'TARGET_SIDE' | 'BODY_SIDE' | 'AMBIGUOUS',
  conflict: boolean,
  provenIrrelevant: boolean,
  representedTarget: boolean,
  representedBody: boolean,
): InterfaceResolution {
  if (conflict) return 'CONFLICTED';
  if (ownership === 'TARGET_SIDE') return 'POSITIVELY_TARGET_OWNED';
  if (ownership === 'BODY_SIDE') return 'POSITIVELY_BODY_OWNED';
  if (provenIrrelevant) return 'PROVEN_IRRELEVANT';
  return representedTarget && representedBody
    ? 'REPRESENTED_UNRESOLVED'
    : 'UNREPRESENTED_UNRESOLVED';
}
export function exhaustiveOwnershipPublication(
  completeness: OwnershipCompleteness,
  classes: number,
  identified: boolean,
): boolean {
  return (
    completeness.state === 'COMPLETE' && (classes === 1 ? identified : classes === 2 && !identified)
  );
}
export interface SourceInterfacePlaneInventory {
  readonly valid: boolean;
  readonly reason: string;
  readonly groups: readonly { readonly offset: number }[];
  readonly sourceFaceVisits: number;
}
/** One existing source-frame family on one original connected component. Interior,
 * consistently oriented supporting surfaces are inventoried independently of cuts.
 * Global end caps have no two-sided interior source transition and are not rows.
 * The existing16 source-plane cap bounds all grouping comparisons; no plane is proposed. */
export function inventorySourceInterfacePlanes(
  g: NormalizedGeometry,
  normal: Vec3,
  orientation: number,
  faceRanks: ArrayLike<number>,
  sourceRank: number,
  checkpoint: Checkpoint,
  charge: () => void,
): SourceInterfacePlaneInventory {
  const groups: { offset: number }[] = [];
  let low = Infinity,
    high = -Infinity,
    visits = 0;
  const projection = (f: number, k: number): number => {
    const i = (g.indices[f * 3 + k] ?? 0) * 3;
    return normal.reduce((sum, n, a) => sum + n * (g.positions[i + a] ?? 0), 0);
  };
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    visits++;
    if (faceRanks[f] !== sourceRank) continue;
    for (let k = 0; k < 3; k++) {
      const x = projection(f, k);
      low = Math.min(low, x);
      high = Math.max(high, x);
    }
  }
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    visits++;
    if (faceRanks[f] !== sourceRank) continue;
    const n = groundedSourceFaceNormal(g, f);
    if (
      !n.length ||
      (orientation * normal.reduce((sum, x, a) => sum + x * (n.vector[a] ?? 0), 0)) / n.length <
        0.99
    )
      continue;
    const xs = [0, 1, 2].map((k) => projection(f, k)),
      offset = xs.reduce((s, x) => s + x, 0) / 3;
    if (offset <= low + 1e-6 || offset >= high - 1e-6) continue;
    if (xs.some((x) => Math.abs(x - offset) > 1e-6))
      return {
        valid: false,
        reason: 'NONPLANAR_SOURCE_INTERFACE',
        groups,
        sourceFaceVisits: visits,
      };
    if (!groups.some((row) => Math.abs(row.offset - offset) <= 1e-6)) {
      if (groups.length >= SEMANTIC_PLANE_REFINEMENT_LIMITS.shoulderPlanes)
        return { valid: false, reason: 'INTERFACE_FEATURE_CAP', groups, sourceFaceVisits: visits };
      groups.push({ offset });
    }
  }
  checkpoint();
  return {
    valid: groups.length > 0,
    reason: groups.length
      ? 'SOURCE_INTERFACE_PLANES_INVENTORIED'
      : 'SOURCE_INTERFACE_CORRESPONDENCE_UNAVAILABLE',
    groups,
    sourceFaceVisits: visits,
  };
}
