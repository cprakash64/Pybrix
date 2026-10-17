import {
  isRepeatedFamily,
  semanticGraph,
  type FamilyContext,
  type SemanticRecord,
} from './semantic-family-context';
export type { SemanticRecord } from './semantic-family-context';
import {
  attributeSourcePlane,
  fractionalSourceAgreement,
  type SourcePlaneAttribution,
} from './semantic-plane-attribution';
import { planeSourceFaces } from './semantic-source';
import { requiredValue } from './semantic-invariant';
/** Research-only scoring. English never participates in physical attribution. */
import type {
  SemanticFixture,
  FixtureEvidence,
  PlaneTruth,
  RoleTruth,
  FixtureValidation,
} from './semantic-fixture';
import { digest, meshDigest, sourceAgreement, validateSemanticFixture } from './semantic-fixture';
export interface FinalOutput {
  id: string;
  parentId: string | null;
  quality: string;
  operation: string;
  components: readonly number[];
  plane: {
    normal: readonly number[];
    origin: readonly number[];
  } | null;
  instanceCount: number;
  sourceSemanticId?: string;
}
export interface NativeProof {
  id: string;
  sourceHash: string;
  planeHash: string;
  valid: boolean;
}
export interface RealizationInput {
  suggestions: readonly FinalOutput[];
  faceRank: readonly number[];
  native: readonly NativeProof[];
  /** IDs are actual local-output IDs; generated alternatives must not be discarded. */
  semanticRecords: readonly SemanticRecord[];
  signal?: AbortSignal;
}
const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
export function nameMatches(role: RoleTruth, label: string): boolean {
  const n = normalize(label),
    t = role.naming;
  if (t.notEquivalent.some((v) => normalize(v) === n)) return false;
  return [
    t.canonical,
    ...t.synonyms,
    ...(t.policy === 'FUNCTIONAL_OR_STRUCTURAL_ACCEPTABLE' ? t.structural : []),
  ].some((v) => normalize(v) === n);
}
/** Legacy exact-face fixture/certificate oracle. Final planes use attributeSourcePlane below. */
export function selectedPlaneFaces(f: SemanticFixture, plane: FinalOutput['plane']): number[] {
  return planeSourceFaces(f.mesh, plane);
}
const legal = (r: RoleTruth): boolean =>
  !['FUSED_NONEXECUTABLE', 'UNKNOWN_NONEXECUTABLE'].includes(r.operation);
export type AllOutputScore =
  | {
      status: 'INVALID_FIXTURE' | 'INVALID_SCORER_INPUT';
      contextError?: string;
      validation: FixtureValidation;
      qualificationEligible: boolean;
      operations: never[];
      metrics: null;
    }
  | {
      status: 'ATTRIBUTION_UNSUPPORTED' | 'ATTRIBUTION_INVALID';
      qualificationEligible: false;
      validation: FixtureValidation;
      operations: {
        id: string;
        attributionStatus: 'EXACT' | 'FRACTIONAL_CLIPPED' | 'UNSUPPORTED' | 'INVALID';
        sourceAttribution?: SourcePlaneAttribution | undefined;
        membershipError: string | null;
      }[];
      metrics: null;
    }
  | {
      status: 'SCORED';
      qualificationEligible: boolean;
      validation: FixtureValidation;
      operations: {
        id: string;
        attributionStatus: 'EXACT' | 'FRACTIONAL_CLIPPED';
        sourceAttribution?: SourcePlaneAttribution | undefined;
        parentId: string | null;
        generated: boolean;
        familyContext: FamilyContext;
        /** Nonzero source-face support. Plane scoring always uses sourceAttribution.weights. */
        selected: number[];
        operationType: string;
        scopeMatches: { precision: number; recall: number; id: string }[];
        bestPhysicalRole: { precision: number; recall: number; id: string } | null;
        secondBestRole: { precision: number; recall: number; id: string } | null;
        dominanceMargin: number;
        physicalConcept: string | null;
        attribution: string;
        membershipError: string | null;
        nativeValid: boolean;
        familyMembershipError: boolean;
        semanticLabelResult: boolean;
        physicalScopeMeasured: boolean;
        physicalReadyError: boolean;
        nativeReadyError: boolean;
        strictUnknownExecutable: boolean;
        physicalValid: boolean;
        namedValid: boolean;
      }[];
      metrics: {
        PHYSICAL_READY_ERRORS: number;
        NATIVE_READY_ERRORS: number;
        FAMILY_MEMBERSHIP_ERRORS: number;
        STRICT_UNKNOWN_EXECUTABLE: number;
        PHYSICAL_REALIZATION_RATE: { numerator: number; denominator: number; concepts: string[] };
        SEMANTICALLY_NAMED_REALIZATION_RATE: {
          numerator: number;
          denominator: number;
          concepts: string[];
        };
        SEMANTIC_RECOGNITION: { numerator: number; denominator: number; concepts: string[] };
        families: {
          id: string;
          FAMILY_ROLE_RECOGNITION: boolean;
          FAMILY_COUNT_ACCURACY: boolean;
          FAMILY_MEMBERSHIP_SEMANTIC_ACCURACY: boolean;
          OBSERVABLE_INSTANCE_COVERAGE: { numerator: number; denominator: number };
        }[];
      };
    };
export function scoreAllOutputs(
  f: SemanticFixture,
  evidence: FixtureEvidence,
  input: RealizationInput,
): AllOutputScore {
  const validation = validateSemanticFixture(f, evidence);
  if (validation.status !== 'VALID_FIXTURE')
    return {
      status: 'INVALID_FIXTURE' as const,
      validation,
      qualificationEligible: false,
      operations: [],
      metrics: null,
    };
  let graph: ReturnType<typeof semanticGraph>;
  const contexts = new Map<string, FamilyContext>();
  const familyRecords = new Map<string, SemanticRecord>();
  const expectedFamilyByRecord = new Map<string, string>();
  try {
    graph = semanticGraph(input.semanticRecords);
    if (new Set(input.suggestions.map((s) => s.id)).size !== input.suggestions.length)
      throw Error('DUPLICATE_OUTPUT_ID');
    // Match ontology only AFTER a graph node has independently established repeated-root status.
    for (const record of graph.recordById.values()) {
      if (!isRepeatedFamily(record)) continue;
      const candidates = f.families.filter((family) =>
        nameMatches(requiredValue(f.roles.find((r) => r.id === family.id)), record.label),
      );
      if (candidates.length > 1) throw Error('AMBIGUOUS_FROZEN_FAMILY');
      const family = candidates[0];
      if (family) {
        if (familyRecords.has(family.id)) throw Error('AMBIGUOUS_SEMANTIC_FAMILY');
        familyRecords.set(family.id, record);
        expectedFamilyByRecord.set(record.id, family.id);
      }
    }
    for (const output of input.suggestions) {
      const context = graph.context(output);
      if (context.semanticFamilyRecordId) {
        context.expectedFamilyId =
          expectedFamilyByRecord.get(context.semanticFamilyRecordId) ?? null;
      }
      contexts.set(output.id, Object.freeze(context));
    }
  } catch (error) {
    return {
      status: 'INVALID_SCORER_INPUT',
      contextError: String(error),
      validation,
      qualificationEligible: false,
      operations: [],
      metrics: null,
    };
  }
  const sourceHash = input.suggestions.some((s) => s.quality === 'READY' && s.operation === 'PLANE')
    ? meshDigest(f.mesh)
    : null;
  if (
    input.faceRank.length !== f.mesh.indices.length / 3 ||
    input.faceRank.some((v) => !Number.isInteger(v) || v < 0)
  )
    throw Error('INVALID_SOURCE_COMPONENT_MAP');
  // Require the exact equivalence relation, not trusted component numbers supplied by an adapter.
  const ranks = new Set<number>();
  for (const c of validation.topology.components) {
    const s = new Set(c.faces.map((v) => input.faceRank[v]));
    if (s.size !== 1 || ranks.has(requiredValue([...s][0])))
      throw Error('INVALID_SOURCE_COMPONENT_MAP');
    ranks.add(requiredValue([...s][0]));
  }
  const final = input.suggestions.filter((s) => s.quality === 'READY');
  if (new Set(input.suggestions.map((s) => s.id)).size !== input.suggestions.length)
    throw Error('DUPLICATE_OUTPUT_ID');
  const cache = new Map<string, SourcePlaneAttribution>();
  const attributed = final.map((s) => {
    if (s.operation === 'PLANE') {
      const key = `${requiredValue(sourceHash)}:${digest(s.plane)}:POSITIVE`;
      let proof = cache.get(key);
      if (!proof) {
        proof = attributeSourcePlane(f.mesh, s.plane, s.id, 'POSITIVE', input.signal);
        cache.set(key, proof);
      }
      const sourceAttribution = { ...proof, operationId: s.id };
      const attributionStatus =
        proof.status === 'WHOLE_FACE_EXACT'
          ? ('EXACT' as const)
          : proof.status === 'FRACTIONAL_CLIPPED'
            ? ('FRACTIONAL_CLIPPED' as const)
            : proof.status === 'UNSUPPORTED_COPLANAR'
              ? ('UNSUPPORTED' as const)
              : ('INVALID' as const);
      return {
        id: s.id,
        attributionStatus,
        sourceAttribution,
        membershipError: proof.reason ?? null,
      };
    }
    const valid =
      s.operation === 'COMPONENT' &&
      s.components.length > 0 &&
      new Set(s.components).size === s.components.length &&
      s.components.every((r) => ranks.has(r));
    return {
      id: s.id,
      attributionStatus: valid ? ('EXACT' as const) : ('INVALID' as const),
      membershipError: valid ? null : 'INVALID_COMPONENT_REFERENCE',
    };
  });
  if (
    attributed.some(
      (a) => a.attributionStatus === 'UNSUPPORTED' || a.attributionStatus === 'INVALID',
    )
  )
    return {
      status: attributed.some((a) => a.attributionStatus === 'INVALID')
        ? 'ATTRIBUTION_INVALID'
        : 'ATTRIBUTION_UNSUPPORTED',
      qualificationEligible: false,
      validation,
      operations: attributed,
      metrics: null,
    };
  const operations = final.map((s, index) => {
    const a = requiredValue(attributed[index]);
    const weights = a.sourceAttribution?.weights;
    const selected = weights
      ? weights.flatMap((w, i) => (w > 0 ? [i] : []))
      : input.faceRank.flatMap((r, i) => (s.components.includes(r) ? [i] : []));
    const agreement = (target: readonly number[]): ReturnType<typeof sourceAgreement> =>
      weights ? fractionalSourceAgreement(weights, target) : sourceAgreement(selected, target);
    const membershipError = null;
    const scopes = f.roles
      .filter(
        (r) =>
          legal(r) &&
          (s.operation === 'PLANE'
            ? r.operation === 'QUALIFIED_PLANE'
            : ['EXACT_COMPONENT', 'EXACT_COMPONENT_GROUP'].includes(r.operation)),
      )
      .map((r) => ({ id: r.id, ...agreement(r.faces) }))
      .sort(
        (a, b) =>
          Math.min(b.precision, b.recall) - Math.min(a.precision, a.recall) ||
          a.id.localeCompare(b.id),
      );
    const best = scopes[0] ?? null,
      second = scopes[1] ?? null,
      margin = best
        ? Math.min(best.precision, best.recall) -
          (second ? Math.min(second.precision, second.recall) : 0)
        : 0;
    const threshold = (r: (typeof scopes)[number]): boolean =>
      s.operation === 'COMPONENT'
        ? r.precision === 1 && r.recall === 1
        : r.precision >= 0.9 && r.recall >= 0.9;
    const matches = scopes.filter(threshold),
      chosen = matches.length === 1 && margin + 1e-12 >= 0.03 ? matches[0] : null;
    const nativeValid =
      s.operation === 'COMPONENT' ||
      Boolean(
        input.native.find(
          (p) =>
            p.id === s.id &&
            p.sourceHash === sourceHash &&
            p.planeHash === digest(s.plane) &&
            p.valid,
        ),
      );
    const family = f.families.find((v) => v.id === chosen?.id),
      memberFamily = f.families.find((v) => v.members.includes(chosen?.id ?? ''));
    let familyMembershipError =
      Boolean(
        family &&
        (s.instanceCount !== family.count ||
          family.members.some(
            (id) => agreement(requiredValue(f.roles.find((r) => r.id === id)).faces).recall !== 1,
          )),
      ) || Boolean(memberFamily && s.instanceCount !== 1);
    const familyContext = requiredValue(contexts.get(s.id));
    const semantic =
      graph.recordById.get(s.id) ?? graph.recordById.get(s.sourceSemanticId ?? s.parentId ?? '');
    const claimedFamily = f.families.find((v) => v.id === familyContext.expectedFamilyId);
    if (s.instanceCount > 1 && !family) familyMembershipError = true;
    if (family && familyContext.state !== 'FAMILY_ROOT') familyMembershipError = true;
    if (
      familyContext.state !== 'NONE' &&
      (!claimedFamily ||
        (familyContext.state === 'FAMILY_ROOT'
          ? chosen?.id !== claimedFamily.id
          : !claimedFamily.members.includes(chosen?.id ?? '')))
    )
      familyMembershipError = true;
    const role = f.roles.find((r) => r.id === chosen?.id),
      familyRole = memberFamily ? f.roles.find((r) => r.id === memberFamily.id) : undefined;
    const semanticLabelResult = Boolean(
      semantic &&
      role &&
      (nameMatches(role, semantic.label) ||
        (familyRole && nameMatches(familyRole, semantic.label))),
    );
    // A plane without any legal comparison scope has no measured precision/recall.
    // Preserve non-plane semantics; unknown execution remains a separate supported-source signal.
    const physicalReadyError = !chosen && (s.operation !== 'PLANE' || scopes.length > 0),
      nativeReadyError = s.operation === 'PLANE' && !nativeValid,
      strictUnknownExecutable = f.strictUnknown;
    const physicalValid =
      Boolean(chosen) && !physicalReadyError && !nativeReadyError && !strictUnknownExecutable;
    return {
      id: s.id,
      attributionStatus: a.attributionStatus as 'EXACT' | 'FRACTIONAL_CLIPPED',
      sourceAttribution: a.sourceAttribution,
      parentId: s.parentId,
      generated: !graph.recordById.has(s.id),
      familyContext,
      selected,
      operationType: s.operation,
      scopeMatches: scopes,
      bestPhysicalRole: best,
      secondBestRole: second,
      dominanceMargin: margin,
      physicalConcept: chosen?.id ?? null,
      attribution: chosen ? 'UNIQUE_PHYSICAL_SOURCE' : matches.length ? 'AMBIGUOUS' : 'UNRESOLVED',
      membershipError,
      nativeValid,
      familyMembershipError,
      semanticLabelResult,
      physicalScopeMeasured: scopes.length > 0,
      physicalReadyError,
      nativeReadyError,
      strictUnknownExecutable,
      physicalValid,
      namedValid: physicalValid && !familyMembershipError && semanticLabelResult,
    };
  });
  // Duplicate individual alternatives within the same family are ownership errors, while a complete
  // group and its children are intentionally permitted alternatives.
  for (const family of f.families)
    for (const id of family.members) {
      const duplicate = operations.filter((o) => o.physicalConcept === id);
      if (duplicate.length > 1)
        for (const row of duplicate) {
          row.familyMembershipError = true;
          row.namedValid = false;
        }
    }
  const concepts = f.roles.filter((r) => legal(r) && r.scope !== 'DETAIL'),
    realized = concepts.filter((r) =>
      operations.some(
        (o) =>
          o.physicalConcept === r.id &&
          o.physicalValid &&
          (!f.families.some((family) => family.id === r.id) || !o.familyMembershipError),
      ),
    ),
    named = concepts.filter((r) =>
      operations.some((o) => o.physicalConcept === r.id && o.namedValid),
    );
  const recognized = f.roles.filter(
    (r) =>
      r.scope !== 'NON_EXECUTABLE_UNKNOWN' &&
      input.semanticRecords.some((p) => nameMatches(r, p.label)),
  );
  const familyMetrics = f.families.map((family) => {
    const role = requiredValue(f.roles.find((r) => r.id === family.id)),
      record = familyRecords.get(family.id);
    const visible = new Set(role.observableMembers);
    const matches = (record?.instanceAnnotations ?? []).map((selected) => {
      const candidates = f.roles
        .filter((r) => family.members.includes(r.id))
        .filter((r) => {
          const a = sourceAgreement(selected, r.faces);
          return a.precision >= 0.9 && a.recall >= 0.9;
        });
      return candidates.length === 1 ? candidates[0]?.id : null;
    });
    const annotated = new Set(matches.filter((id): id is string => typeof id === 'string'));
    return {
      id: family.id,
      FAMILY_ROLE_RECOGNITION: Boolean(record),
      FAMILY_COUNT_ACCURACY: record?.instances === family.count,
      FAMILY_MEMBERSHIP_SEMANTIC_ACCURACY: record
        ? matches.every((id) => id !== null) && new Set(matches).size === matches.length
        : false,
      OBSERVABLE_INSTANCE_COVERAGE: {
        numerator: [...visible].filter((id) => annotated.has(id)).length,
        denominator: visible.size,
      },
    };
  });
  return {
    status: 'SCORED' as const,
    qualificationEligible: true,
    validation,
    operations: operations.sort((a, b) => a.id.localeCompare(b.id)),
    metrics: {
      PHYSICAL_READY_ERRORS: operations.filter((o) => o.physicalReadyError).length,
      NATIVE_READY_ERRORS: operations.filter((o) => o.nativeReadyError).length,
      FAMILY_MEMBERSHIP_ERRORS: operations.filter((o) => o.familyMembershipError).length,
      STRICT_UNKNOWN_EXECUTABLE: operations.filter((o) => o.strictUnknownExecutable).length,
      PHYSICAL_REALIZATION_RATE: {
        numerator: realized.length,
        denominator: concepts.length,
        concepts: realized.map((r) => r.id),
      },
      SEMANTICALLY_NAMED_REALIZATION_RATE: {
        numerator: named.length,
        denominator: concepts.length,
        concepts: named.map((r) => r.id),
      },
      SEMANTIC_RECOGNITION: {
        numerator: recognized.length,
        denominator: f.roles.filter((r) => r.scope !== 'NON_EXECUTABLE_UNKNOWN').length,
        concepts: recognized.map((r) => r.id),
      },
      families: familyMetrics,
    },
  };
}
/** Gate for a future dispatcher: accept ONLY a current validated frozen envelope, then build the
 * production request from its own renderer/metadata path. Never spread this payload into a request. */
export function assertFixtureDispatchable(
  f: SemanticFixture,
  evidence: FixtureEvidence,
  freezeHash: string,
): void {
  // Lazy cycle avoided: equivalent to freezeSemanticFixture's documented payload.
  const validation = validateSemanticFixture(f, evidence);
  const payload = {
    version: 1,
    fixture: {
      ...f,
      mesh: {
        positions: Array.from(f.mesh.positions),
        indices: Array.from(f.mesh.indices),
        metadata: f.mesh.metadata,
      },
    },
    evidence,
    validation,
  };
  if (validation.status !== 'VALID_FIXTURE' || digest(payload) !== freezeHash)
    throw Error('UNVALIDATED_OR_STALE_FIXTURE');
}
export type { PlaneTruth };
