import type { SemanticPart, Vec3 } from "@cadfixer/auto-split-contract";
import type { PreparedSemanticGeometry } from "./semantic";
import type { Checkpoint } from "./checkpoint";
import type { SuggestedPlane } from "./suggestions";
import {
  collectGroundedBoundaryWitnesses,
  groundedSourceFaceNormal,
} from "./semantic-grounded-boundary";
import {
  interfaceTriangleFraction,
  interfaceMembershipSignature,
  type MaterialInterface,
} from "./semantic-interface-membership";
import {
  interfaceOwnershipEvidence,
  type InterfaceOwnershipEvidence,
} from "./semantic-interface-ownership";
import {
  SEMANTIC_PLANE_REFINEMENT_LIMITS,
  type SemanticPlaneRefinement,
} from "./semantic-plane";
import { groundedSourceFrame } from "./semantic-grounded-scope";

export type StructuralOwnershipState =
  | "NOT_APPLICABLE"
  | "IDENTIFIED"
  | "TWO_WAY_UNRESOLVED"
  | "MULTIWAY_UNRESOLVED"
  | "INSUFFICIENT_EVIDENCE";
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
  readonly relevantInterfaces?: number;
  readonly irrelevantInterfaces?: number;
  readonly membershipComparisons?: number;
  readonly ownershipSignatures?: number;
}
const TOLERANCE = 1e-7;
const CORRESPONDENCE = 1e-6;
const FACE_LIMIT = 8192;
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Physical clipping domains are separate from complete semantic assignments.
 * Partial clipping never creates a class or transitively merges complete classes. */
export interface TargetOwnershipSignature {
  readonly candidate: number;
  readonly assignment: readonly (
    "TARGET_SIDE" | "BODY_SIDE" | "INTERMEDIATE"
  )[];
  readonly complete: boolean;
  readonly key: string | null;
}
export interface StructuralTargetOwnershipAudit {
  readonly cardinality: StructuralOwnershipCardinality;
  readonly primaryOwnership?: InterfaceOwnershipEvidence;
  readonly signatures: readonly TargetOwnershipSignature[];
}

/** Audit existing hypotheses against connected original-source transition surfaces.
 * Source-frame discovery creates no cuts. Unknown nonlocal variation remains a blocker;
 * downstream geometry is irrelevant only with invariant target inclusion and positive span. */
export function structuralOwnershipCardinality(
  prepared: PreparedSemanticGeometry,
  target: SemanticPart,
  peers: readonly SemanticPart[],
  alternatives: readonly [SuggestedPlane, SuggestedPlane],
  candidates: readonly SuggestedPlane[],
  primary: InterfaceOwnershipEvidence | undefined,
  refinement: SemanticPlaneRefinement,
  sourceAxes: readonly Vec3[],
  transitionCandidates: readonly SuggestedPlane[],
  checkpoint: Checkpoint,
  charge: () => void,
): StructuralTargetOwnershipAudit {
  const g = prepared.geometry;
  let sourceFaceVisits = 0,
    clippedOperations = 0,
    pixelVisits = 0,
    scratchBytes = 0,
    membershipComparisons = 0,
    relevantInterfaces = 0,
    irrelevantInterfaces = 0;
  const signatures: TargetOwnershipSignature[] = [];
  const result = (
    state: StructuralOwnershipState,
    reason: string,
    interfaces: number,
    classes: number | null,
    ownership = primary,
  ): StructuralTargetOwnershipAudit => ({
    cardinality: {
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
      relevantInterfaces,
      irrelevantInterfaces,
      membershipComparisons,
      ownershipSignatures: new Set(
        signatures.flatMap((s) => (s.key === null ? [] : [s.key])),
      ).size,
    },
    ...(ownership ? { primaryOwnership: ownership } : {}),
    signatures,
  });
  const region = primary?.materialInterface;
  const sourceFrame = region
    ? [region.normal]
    : groundedSourceFrame(g, sourceAxes, FACE_LIMIT, checkpoint, charge);
  const raw = sourceFrame.toSorted(
    (a, b) =>
      Math.abs(dot(b, refinement.profileNormal)) -
      Math.abs(dot(a, refinement.profileNormal)),
  )[0];
  if (!raw || candidates.length < 2 || !transitionCandidates.length)
    return result(
      "INSUFFICIENT_EVIDENCE",
      "TRANSITION_SOURCE_CORRESPONDENCE_UNAVAILABLE",
      0,
      null,
    );
  const normal = raw.map(
    (x) => x * Math.sign(dot(raw, refinement.profileNormal)),
  ) as unknown as Vec3;
  const first = region?.faces[0];
  const step = refinement.sectionProfile.reduce((best, p, i, all) => {
    const previous = all[i - 1];
    return previous && Math.abs(p.length - previous.length) > Math.abs(best)
      ? p.length - previous.length
      : best;
  }, 0);
  const orientation =
    first === undefined
      ? step > 0
        ? -1
        : 1
      : Math.sign(dot(groundedSourceFaceNormal(g, first).vector, normal));
  const vertex = (f: number, k: number): Vec3 => {
    const i = (g.indices[f * 3 + k] ?? 0) * 3;
    return [
      g.positions[i] ?? 0,
      g.positions[i + 1] ?? 0,
      g.positions[i + 2] ?? 0,
    ];
  };
  const fraction = (f: number, cut: SuggestedPlane): number => {
    checkpoint();
    charge();
    clippedOperations++;
    return interfaceTriangleFraction(g, f, cut);
  };
  const groups: { offset: number; faces: number[]; area: number }[] = [];
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    sourceFaceVisits++;
    const n = groundedSourceFaceNormal(g, f);
    if (!n.length || (orientation * dot(n.vector, normal)) / n.length < 0.99)
      continue;
    let low = Infinity,
      high = -Infinity;
    for (const cut of candidates) {
      const x = fraction(f, cut);
      low = Math.min(low, x);
      high = Math.max(high, x);
      if (high - low > TOLERANCE) break;
    }
    if (high - low <= TOLERANCE) continue;
    const vertices = [vertex(f, 0), vertex(f, 1), vertex(f, 2)],
      offset = vertices.reduce((s, v) => s + dot(normal, v), 0) / 3;
    if (
      vertices.some((v) => Math.abs(dot(normal, v) - offset) > CORRESPONDENCE)
    )
      return result(
        "INSUFFICIENT_EVIDENCE",
        "NONPLANAR_MEMBERSHIP_DELTA",
        groups.length,
        null,
      );
    if (!groups.some((v) => Math.abs(v.offset - offset) <= CORRESPONDENCE)) {
      if (groups.length >= SEMANTIC_PLANE_REFINEMENT_LIMITS.shoulderPlanes)
        return result(
          "INSUFFICIENT_EVIDENCE",
          "INTERFACE_FEATURE_CAP",
          groups.length,
          null,
        );
      groups.push({ offset, faces: [], area: 0 });
    }
  }
  let retained = 0;
  for (let f = 0; f < g.faceCount; f++) {
    if ((f & 255) === 0) checkpoint();
    charge();
    sourceFaceVisits++;
    const n = groundedSourceFaceNormal(g, f);
    if (
      !n.length ||
      (orientation * dot(n.vector, normal)) / n.length < 1 - CORRESPONDENCE
    )
      continue;
    const vertices = [vertex(f, 0), vertex(f, 1), vertex(f, 2)];
    const matches = groups.filter((group) =>
      vertices.every(
        (v) => Math.abs(dot(normal, v) - group.offset) <= CORRESPONDENCE,
      ),
    );
    if (matches.length > 1)
      return result(
        "INSUFFICIENT_EVIDENCE",
        "OVERLAPPING_INTERFACE_PLANES",
        groups.length,
        null,
      );
    const group = matches[0];
    if (!group) continue;
    if (retained >= FACE_LIMIT)
      return result(
        "INSUFFICIENT_EVIDENCE",
        "INTERFACE_FACE_CAP",
        groups.length,
        null,
      );
    retained++;
    group.faces.push(f);
    group.area += n.length / 2;
  }
  const evidenceRows: {
    region: MaterialInterface;
    evidence: InterfaceOwnershipEvidence;
    low: number;
    high: number;
  }[] = [];
  const bandLow = Math.min(...refinement.sectionProfile.map((p) => p.offset)),
    bandHigh = Math.max(...refinement.sectionProfile.map((p) => p.offset));
  for (const group of groups) {
    const parent = group.faces.map((_, i) => i),
      edges = new Map<string, number>();
    const root = (i: number): number => {
      while (parent[i] !== i) {
        checkpoint();
        i = parent[i] ?? i;
      }
      return i;
    };
    let low = Infinity,
      high = -Infinity;
    for (const [i, f] of group.faces.entries()) {
      checkpoint();
      charge();
      sourceFaceVisits++;
      const keys = [0, 1, 2].map((k) => {
        const p = vertex(f, k),
          d = dot(refinement.profileNormal, p);
        low = Math.min(low, d);
        high = Math.max(high, d);
        return p.map((x) => (x === 0 ? 0 : x)).join(",");
      });
      for (let k = 0; k < 3; k++) {
        const a = keys[k] ?? "",
          b = keys[(k + 1) % 3] ?? "",
          key = a < b ? a + "|" + b : b + "|" + a,
          previous = edges.get(key);
        if (previous === undefined) edges.set(key, i);
        else parent[root(i)] = root(previous);
      }
    }
    // Declared storage bound, never a measured allocator/heap-memory claim.
    scratchBytes = Math.max(scratchBytes, retained * 20 + edges.size * 160);
    if (!group.faces.length || group.faces.some((_, i) => root(i) !== root(0)))
      return result(
        "INSUFFICIENT_EVIDENCE",
        "DISCONNECTED_MEMBERSHIP_DELTA",
        groups.length,
        null,
      );
    const collected: MaterialInterface = {
      ...group,
      normal,
      sourceFacesInspected: sourceFaceVisits,
      clippedOperations,
      scratchBytes,
    };
    const evidence =
      region && Math.abs(group.offset - region.offset) <= CORRESPONDENCE
        ? primary!
        : interfaceOwnershipEvidence(
            prepared,
            target,
            peers,
            alternatives,
            checkpoint,
            charge,
            collected,
          );
    pixelVisits += evidence.pixelVisits;
    if (evidence.conflict)
      return result(
        "INSUFFICIENT_EVIDENCE",
        "CONTRADICTORY_INTERFACE_OWNERSHIP",
        groups.length,
        null,
      );
    evidenceRows.push({ region: collected, evidence, low, high });
  }
  const local = evidenceRows.filter(
    (row) =>
      row.high >= bandLow - CORRESPONDENCE &&
      row.low <= bandHigh + CORRESPONDENCE,
  );
  if (local.length !== 1)
    return result(
      "INSUFFICIENT_EVIDENCE",
      "TRANSITION_INTERFACE_NOT_UNIQUE",
      groups.length,
      null,
    );
  const primaryRow = local[0]!;
  const witness = collectGroundedBoundaryWitnesses(
    prepared,
    target,
    [refinement.profileNormal],
    checkpoint,
    charge,
  )[0];
  pixelVisits += witness?.pixelVisits ?? 0;
  const relevant: typeof evidenceRows = [];
  for (const row of evidenceRows) {
    const sourceRank =
      prepared.labelling.faceRank[primaryRow.region.faces[0] ?? -1];
    const connected = row.region.faces.every(
      (f) => prepared.labelling.faceRank[f] === sourceRank,
    );
    const invariantTarget =
      row.low > bandHigh + CORRESPONDENCE &&
      connected &&
      witness &&
      witness.observedAxes.length >= 2 &&
      witness.low < row.low - CORRESPONDENCE &&
      witness.high > row.high + CORRESPONDENCE &&
      transitionCandidates.every((cut) =>
        row.region.faces.every((f) => fraction(f, cut) >= 1 - TOLERANCE),
      );
    if (row.evidence.ownership === "AMBIGUOUS" && invariantTarget) {
      irrelevantInterfaces++;
      continue;
    }
    relevant.push(row);
    relevantInterfaces++;
    // Unknown upstream/other-transition source variation is not absence-based BODY proof.
    if (row !== primaryRow && row.evidence.ownership === "AMBIGUOUS")
      return result(
        "INSUFFICIENT_EVIDENCE",
        "NONLOCAL_UNRESOLVED_TARGET_OWNERSHIP",
        groups.length,
        null,
        primaryRow.evidence,
      );
  }
  for (const [candidate, cut] of candidates.entries()) {
    const assignment: ("TARGET_SIDE" | "BODY_SIDE" | "INTERMEDIATE")[] = [];
    let complete = true;
    for (const row of relevant) {
      membershipComparisons++;
      clippedOperations += row.region.faces.length;
      const physical = interfaceMembershipSignature(
        g,
        row.region,
        cut,
        checkpoint,
        charge,
      ).ownership;
      const semantic = row.evidence.ownership;
      assignment.push(semantic === "AMBIGUOUS" ? physical : semantic);
      if (
        physical === "INTERMEDIATE" ||
        (semantic !== "AMBIGUOUS" && physical !== semantic)
      )
        complete = false;
    }
    signatures.push({
      candidate,
      assignment,
      complete,
      key: complete ? assignment.join("|") : null,
    });
  }
  const classes = new Set(
    signatures.flatMap((s) => (s.key === null ? [] : [s.key])),
  ).size;
  if (classes === 0)
    return result(
      "INSUFFICIENT_EVIDENCE",
      "COMPLETE_OWNERSHIP_REPRESENTATIVES_UNAVAILABLE",
      groups.length,
      null,
      primaryRow.evidence,
    );
  if (classes >= 3)
    return result(
      "MULTIWAY_UNRESOLVED",
      "DISTINCT_TARGET_OWNERSHIP_SIGNATURES",
      groups.length,
      classes,
      primaryRow.evidence,
    );
  if (classes === 2)
    return result(
      "TWO_WAY_UNRESOLVED",
      "TWO_COMPLETE_TARGET_OWNERSHIP_SIGNATURES",
      groups.length,
      2,
      primaryRow.evidence,
    );
  if (relevant.some((row) => row.evidence.ownership === "AMBIGUOUS"))
    return result(
      "INSUFFICIENT_EVIDENCE",
      "UNRESOLVED_CLASS_REPRESENTATIVE_MISSING",
      groups.length,
      null,
      primaryRow.evidence,
    );
  return result(
    "IDENTIFIED",
    "POSITIVE_SINGLE_TARGET_OWNERSHIP_CLASS",
    groups.length,
    1,
    primaryRow.evidence,
  );
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
    if (!n.length || Math.abs(dot(n.vector, normal) / n.length) < 0.99)
      continue;
    let lo = Infinity,
      hi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const i = (g.indices[f * 3 + k] ?? 0) * 3;
      const p: Vec3 = [
        g.positions[i] ?? 0,
        g.positions[i + 1] ?? 0,
        g.positions[i + 2] ?? 0,
      ];
      const d = dot(normal, p);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    if (
      hi >= interval[0] - CORRESPONDENCE &&
      lo <= interval[1] + CORRESPONDENCE
    ) {
      variable = true;
      break;
    }
  }
  return {
    state: variable ? "INSUFFICIENT_EVIDENCE" : "IDENTIFIED",
    reason: variable
      ? "MATERIAL_INTERFACE_IN_NECK_INTERVAL"
      : "SUPPORTED_NECK_WITH_NO_MATERIAL_INTERFACE",
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
