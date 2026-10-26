import type { Vec3 } from '@cadfixer/auto-split-contract';
import type { NormalizedGeometry } from './geometry';
import type { Checkpoint } from './checkpoint';
import type { SuggestedPlane } from './suggestions';
import type { StructuralTargetOwnershipAudit } from './semantic-structural-ownership';
import type { SemanticPlaneRefinement } from './semantic-plane';
import { structuralSeamEvidence } from './semantic-seam';
import {
  interfaceMembershipSignature,
  interfaceTriangleFraction,
} from './semantic-interface-membership';
import { sameSemanticPlane } from './semantic-native';
export interface OwnershipCompletionPlan {
  readonly kind: 'OWNERSHIP_FEASIBLE_INTERVAL';
  readonly triggered: true;
  readonly authoritativeRowsUsedDirectly: true;
  readonly existingLegalRepresentatives: 0;
  readonly intervalEndpointConvention: 'Nonfinite ownership endpoints serialize as null and are unbounded';
  readonly semanticKey: string;
  readonly normal: Vec3;
  readonly transition: readonly number[];
  readonly rowHashes: readonly string[];
  readonly ownershipInterval: readonly [number, number];
  readonly structuralInterval: readonly [number, number];
  readonly safeInterval: readonly [number, number];
  readonly existingOffsetCount: number;
  readonly remainingCapacity: number;
  readonly rowsConsidered: number;
  readonly facesInspected: number;
  readonly constraints: number;
  readonly attempted: readonly number[];
  readonly deduplicated: readonly number[];
  readonly proposals: readonly {
    readonly percentile: number;
    readonly offset: number;
    readonly plane: SuggestedPlane;
  }[];
}
const dot = (a: Vec3, b: Vec3): number => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const cut = (normal: Vec3, d: number): SuggestedPlane => ({
  normal,
  origin: normal.map((x) => x * d) as unknown as Vec3,
});
const next = (x: number, up: boolean): number => {
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, x);
  bytes.setBigUint64(0, bytes.getBigUint64(0) + (x > 0 === up ? 1n : -1n));
  return bytes.getFloat64(0);
};
/** Consumes completed producer rows only. No discovery, ownership evaluation or native work. */
export function planOwnershipCompletion(
  g: NormalizedGeometry,
  audit: StructuralTargetOwnershipAudit,
  eligibility: string,
  refinement: SemanticPlaneRefinement,
  existingRepresentatives: number,
  existingOffsetCount: number,
  existingPlanes: readonly SuggestedPlane[],
  checkpoint: Checkpoint,
  charge: () => void,
): OwnershipCompletionPlan | undefined {
  const card = audit.cardinality,
    rows = audit.resolvedInterfaces;
  const keys = new Set(
    audit.signatures.filter((s) => s.complete && s.key !== null).map((s) => requiredValue(s.key)),
  );
  const seam = structuralSeamEvidence(refinement, checkpoint);
  if (
    eligibility !== 'EXECUTABLE' ||
    card.state !== 'IDENTIFIED' ||
    card.ownershipCompleteness?.state !== 'COMPLETE' ||
    keys.size !== 1 ||
    card.ownershipSignatures !== 1 ||
    existingRepresentatives !== 0 ||
    seam.reason !== 'STABLE_SECTION_STEP' ||
    !seam.admitted ||
    !card.sourceComponentResolution?.proven ||
    !rows?.length ||
    rows.length !== card.ownershipCompleteness.inventoried ||
    rows.length > 16 ||
    rows.some(
      (r) =>
        r.conflict ||
        !['POSITIVELY_TARGET_OWNED', 'POSITIVELY_BODY_OWNED', 'PROVEN_IRRELEVANT'].includes(
          r.resolution,
        ),
    )
  )
    return undefined;
  const n = refinement.profileNormal,
    first = refinement.sectionProfile[0]?.offset,
    last = refinement.sectionProfile.at(-1)?.offset;
  if (
    first === undefined ||
    last === undefined ||
    !Number.isInteger(existingOffsetCount) ||
    existingOffsetCount < 0 ||
    existingOffsetCount > 64
  )
    return undefined;
  let lower = -Infinity,
    upper = Infinity,
    safeLower = first,
    safeUpper = last,
    faces = 0,
    constraints = 0;
  const rowHashes: string[] = [];
  for (const row of rows) {
    checkpoint();
    charge();
    let hash = 2166136261;
    for (const f of row.region.faces) {
      checkpoint();
      charge();
      hash = Math.imul(hash ^ f, 16777619);
    }
    rowHashes.push('face-id-fnv1a32:' + (hash >>> 0).toString(16));
    if (row.resolution === 'PROVEN_IRRELEVANT') continue;
    const target = row.resolution === 'POSITIVELY_TARGET_OWNED';
    if (
      row.ownership !== (target ? 'TARGET_SIDE' : 'BODY_SIDE') ||
      !row.region.faces.length ||
      row.region.faces.length > 8192
    )
      return undefined;
    for (const f of row.region.faces) {
      checkpoint();
      charge();
      if (++faces > 8192) return undefined;
      constraints++;
      if (!Number.isInteger(f) || f < 0 || f >= g.faceCount) return undefined;
      const projections = [0, 1, 2].map((k) => {
        const i = (g.indices[f * 3 + k] ?? 0) * 3;
        const x = g.positions[i],
          y = g.positions[i + 1],
          z = g.positions[i + 2];
        if (x === undefined || y === undefined || z === undefined) return undefined;
        return dot(n, [x, y, z]);
      });
      if (!projections.every((p): p is number => p !== undefined && Number.isFinite(p)))
        return undefined;
      const a = Math.min(...projections),
        b = Math.max(...projections);
      const accepted = (d: number): boolean => {
        checkpoint();
        charge();
        const v = interfaceTriangleFraction(g, f, cut(n, d));
        return target ? v >= 1 - 1e-7 : v < 1e-7;
      };
      let lo = a,
        hi = b;
      // Adjacent representable bounds preserve the production fraction's strict BODY edge.
      if (target) {
        for (let i = 0; i < 4 && !accepted(lo); i++) lo = next(lo, false);
        if (!accepted(lo)) return undefined;
      } else {
        for (let i = 0; i < 4 && !accepted(hi); i++) hi = next(hi, true);
        if (!accepted(hi)) return undefined;
      }
      for (let i = 0; i < 64; i++) {
        const mid = lo + (hi - lo) / 2;
        if (mid === lo || mid === hi) break;
        if (accepted(mid) === target) lo = mid;
        else hi = mid;
      }
      if (target) {
        upper = Math.min(upper, lo);
        safeUpper = Math.min(safeUpper, a);
      } else {
        lower = Math.max(lower, hi);
        safeLower = Math.max(safeLower, b);
      }
    }
  }
  safeLower = Math.max(safeLower, lower, first);
  safeUpper = Math.min(safeUpper, upper, last);
  const remainingCapacity = 64 - existingOffsetCount,
    attempted: number[] = [],
    deduplicated: number[] = [],
    proposals: { percentile: number; offset: number; plane: SuggestedPlane }[] = [];
  if (safeUpper > safeLower && remainingCapacity > 0)
    for (const percentile of [0.5, 0.25, 0.75]) {
      checkpoint();
      charge();
      const offset = safeLower + percentile * (safeUpper - safeLower),
        plane = cut(n, offset);
      attempted.push(offset);
      if (
        sameSemanticPlane(plane, cut(n, safeLower)) ||
        sameSemanticPlane(plane, cut(n, safeUpper)) ||
        existingPlanes.some((p) => sameSemanticPlane(p, plane)) ||
        proposals.some((p) => sameSemanticPlane(p.plane, plane))
      ) {
        deduplicated.push(offset);
        continue;
      }
      if (proposals.length >= Math.min(3, remainingCapacity)) break;
      if (
        !rows.every(
          (row) =>
            row.resolution === 'PROVEN_IRRELEVANT' ||
            interfaceMembershipSignature(g, row.region, plane, checkpoint, charge).ownership ===
              row.ownership,
        )
      )
        continue;
      proposals.push({ percentile, offset, plane });
    }
  return {
    kind: 'OWNERSHIP_FEASIBLE_INTERVAL',
    triggered: true,
    authoritativeRowsUsedDirectly: true,
    existingLegalRepresentatives: 0,
    intervalEndpointConvention: 'Nonfinite ownership endpoints serialize as null and are unbounded',
    semanticKey: requiredValue([...keys][0]),
    normal: n,
    transition: [first, last],
    rowHashes,
    ownershipInterval: [lower, upper],
    structuralInterval: [first, last],
    safeInterval: [safeLower, safeUpper],
    existingOffsetCount,
    remainingCapacity,
    rowsConsidered: rows.length,
    facesInspected: faces,
    constraints,
    attempted,
    deduplicated,
    proposals,
  };
}
export type CompletionGates = Readonly<
  Record<
    | 'semantic'
    | 'direct'
    | 'assembly'
    | 'peer'
    | 'scope'
    | 'connectivity'
    | 'seam'
    | 'membership'
    | 'key'
    | 'completeness'
    | 'source',
    (plane: SuggestedPlane) => boolean
  >
>;
export function admitOwnershipCompletion(
  plan: OwnershipCompletionPlan,
  gates: CompletionGates,
  checkpoint: Checkpoint,
  charge: () => void,
): readonly OwnershipCompletionPlan['proposals'][number][] {
  return plan.proposals.filter((p) => {
    checkpoint();
    charge();
    return Object.values(gates).every((gate) => {
      checkpoint();
      charge();
      return gate(p.plane);
    });
  });
}
/** Exact original-edge connectivity of the positive clipped source, without changing buffers. */
export function completionSourceConnected(
  g: NormalizedGeometry,
  plane: SuggestedPlane,
  checkpoint: Checkpoint,
  charge: () => void,
): boolean {
  const parent = new Map<number, number>(),
    edges = new Map<string, number>();
  const find = (f: number): number => {
    let root = f;
    while (parent.get(root) !== root) root = requiredValue(parent.get(root));
    while (parent.get(f) !== f) {
      const next = requiredValue(parent.get(f));
      parent.set(f, root);
      f = next;
    }
    return root;
  };
  for (let f = 0; f < g.faceCount; f++) {
    checkpoint();
    charge();
    if (interfaceTriangleFraction(g, f, plane) <= 1e-7) continue;
    parent.set(f, f);
    const vertices = [0, 1, 2].map((k): Vec3 | undefined => {
      const i = (g.indices[f * 3 + k] ?? 0) * 3;
      const x = g.positions[i],
        y = g.positions[i + 1],
        z = g.positions[i + 2];
      if (x === undefined || y === undefined || z === undefined) return undefined;
      return [x, y, z];
    });
    if (!vertices.every((v): v is Vec3 => v !== undefined)) return false;
    for (let k = 0; k < 3; k++) {
      const a = requiredValue(vertices[k]),
        b = requiredValue(vertices[(k + 1) % 3]);
      if (Math.max(dot(plane.normal, a), dot(plane.normal, b)) < dot(plane.normal, plane.origin))
        continue;
      const x = a.join(','),
        y = b.join(','),
        key = x < y ? x + '|' + y : y + '|' + x,
        other = edges.get(key);
      if (other === undefined) edges.set(key, f);
      else parent.set(find(f), find(other));
    }
  }
  return parent.size > 0 && new Set([...parent.keys()].map(find)).size === 1;
}

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
