/** Prospective source-truth evaluator only. Never imported by product realization. */
export const SEMANTIC_PHYSICAL_EVALUATOR_MARKER = 'SEMANTIC_BETA_PROSPECTIVE_EVALUATOR_ONLY';
export interface PhysicalRole {
  readonly concept: string;
  readonly faces: readonly number[];
  readonly instances?: readonly (readonly number[])[];
  readonly aggregate?: boolean;
  /** Explicit meaningful operation in an otherwise strict-unknown benchmark. */
  readonly executable?: boolean;
}
export interface PhysicalOperation {
  readonly id: string;
  readonly selected: readonly number[];
  readonly semanticConcept: string | null;
  readonly kind: 'component' | 'plane';
  readonly nativeValid: boolean;
  readonly familyMode: 'none' | 'family' | 'individual';
  readonly declaredCount: number;
  readonly familyId?: string;
}
export const PHYSICAL_ATTRIBUTION_LIMITS = Object.freeze({
  precision: 0.9,
  recall: 0.9,
  minimumMargin: 0.03,
});
export interface PhysicalScopeMatch {
  readonly concept: string;
  readonly instanceIndex: number | null;
  readonly precision: number;
  readonly recall: number;
  readonly legal: boolean;
}
export interface PhysicalAssessment {
  readonly scopeMatches: readonly PhysicalScopeMatch[];
  readonly bestRole: PhysicalScopeMatch | null;
  readonly secondBestRole: PhysicalScopeMatch | null;
  readonly dominanceMargin: number;
  readonly id: string;
  readonly physicalConcept: string | null;
  readonly semanticConcept: string | null;
  readonly instanceIndex: number | null;
  readonly precision: number;
  readonly recall: number;
  readonly sourceFaces: number;
  readonly physicalReadyError: boolean;
  readonly nativeReadyError: boolean;
  readonly familyMembershipError: boolean;
  readonly semanticLabelMiss: boolean;
  readonly physicalValid: boolean;
  readonly namedValid: boolean;
  readonly attribution: 'UNIQUE_PHYSICAL_SOURCE' | 'AMBIGUOUS' | 'UNRESOLVED';
}
function agreement(
  selected: ReadonlySet<number>,
  truth: readonly number[],
): { precision: number; recall: number } {
  const target = new Set(truth);
  let hit = 0;
  for (const face of selected) if (target.has(face)) hit++;
  return {
    precision: selected.size ? hit / selected.size : 0,
    recall: target.size ? hit / target.size : 0,
  };
}
/** Every legal physical scope competes independently of wording; ambiguity is never broken by labels. */
export function assessPhysicalOperations(
  roles: readonly PhysicalRole[],
  operations: readonly PhysicalOperation[],
  strictUnknown = false,
): readonly PhysicalAssessment[] {
  const assessed = operations.map((operation) => {
    const selected = new Set(operation.selected);
    const candidates = roles.flatMap((role) => {
      const individual = operation.familyMode !== 'family' && (role.instances?.length ?? 0) > 1;
      return (individual ? (role.instances ?? []) : [role.faces]).map((faces, index) => ({
        role,
        index: individual ? index : null,
        ...agreement(selected, faces),
      }));
    });
    const scopeMatches = candidates.map((c) => ({
      concept: c.role.concept,
      instanceIndex: c.index,
      precision: c.precision,
      recall: c.recall,
      legal: c.role.executable !== false && (!strictUnknown || c.role.executable === true),
    }));
    const legal = candidates
      .filter((c) => c.role.executable !== false && (!strictUnknown || c.role.executable === true))
      .sort(
        (a, b) =>
          Math.min(b.precision, b.recall) - Math.min(a.precision, a.recall) ||
          a.role.concept.localeCompare(b.role.concept) ||
          (a.index ?? -1) - (b.index ?? -1),
      );
    const threshold = (c: (typeof candidates)[number]): boolean =>
      c.precision >= PHYSICAL_ATTRIBUTION_LIMITS.precision &&
      c.recall >= PHYSICAL_ATTRIBUTION_LIMITS.recall;
    const qualifying = legal.filter(threshold),
      best = legal[0],
      second = legal[1];
    const dominanceMargin = best
      ? Math.min(best.precision, best.recall) -
        (second ? Math.min(second.precision, second.recall) : 0)
      : 0;
    const chosen =
      qualifying.length === 1 &&
      dominanceMargin + 1e-12 >= PHYSICAL_ATTRIBUTION_LIMITS.minimumMargin
        ? qualifying[0]
        : undefined;
    const attribution = chosen
      ? ('UNIQUE_PHYSICAL_SOURCE' as const)
      : qualifying.length > 0
        ? ('AMBIGUOUS' as const)
        : ('UNRESOLVED' as const);
    const physicalReadyError =
      !chosen || (operation.kind === 'component' && !operation.nativeValid);
    const nativeReadyError = operation.kind === 'plane' && !operation.nativeValid;
    const instances = chosen?.role.instances ?? [];
    const physicalTarget = new Set(chosen?.role.faces ?? []);
    const familyMembershipError =
      (operation.familyMode === 'individual' && (!chosen || instances.length < 2)) ||
      (operation.familyMode === 'family' &&
        (!chosen ||
          instances.length < 2 ||
          operation.declaredCount !== instances.length ||
          operation.selected.length !== selected.size ||
          operation.selected.some((face) => !physicalTarget.has(face)) ||
          instances.some((instance) => agreement(selected, instance).recall < 0.9)));
    const physicalValid = !physicalReadyError && !nativeReadyError && !familyMembershipError;
    const semanticLabelMiss =
      !physicalReadyError && operation.semanticConcept !== chosen.role.concept;
    return {
      id: operation.id,
      scopeMatches,
      bestRole: best
        ? (scopeMatches.find(
            (m) => m.concept === best.role.concept && m.instanceIndex === best.index,
          ) ?? null)
        : null,
      secondBestRole: second
        ? (scopeMatches.find(
            (m) => m.concept === second.role.concept && m.instanceIndex === second.index,
          ) ?? null)
        : null,
      dominanceMargin,
      physicalConcept: chosen?.role.concept ?? null,
      semanticConcept: operation.semanticConcept,
      instanceIndex: chosen?.index ?? null,
      precision: chosen?.precision ?? 0,
      recall: chosen?.recall ?? 0,
      sourceFaces: selected.size,
      physicalReadyError,
      nativeReadyError,
      familyMembershipError,
      semanticLabelMiss,
      physicalValid,
      namedValid: physicalValid && !semanticLabelMiss,
      attribution,
    };
  });
  // A complete group and its child alternatives intentionally share source. Individual
  // siblings within one semantic family must never duplicate physical instance ownership.
  const duplicate = new Set<string>();
  for (const [i, a] of operations.entries())
    for (const b of operations.slice(i + 1)) {
      const first = assessed[i],
        second = assessed[operations.indexOf(b)];
      if (
        a.familyMode === 'family' ||
        b.familyMode === 'family' ||
        first?.instanceIndex === null ||
        second?.instanceIndex === null ||
        !first?.physicalConcept ||
        first.physicalConcept !== second?.physicalConcept
      )
        continue;
      const selected = new Set(a.selected);
      if (b.selected.some((face) => selected.has(face))) {
        duplicate.add(a.id);
        duplicate.add(b.id);
      }
    }
  return assessed.map((row) =>
    duplicate.has(row.id)
      ? { ...row, familyMembershipError: true, physicalValid: false, namedValid: false }
      : row,
  );
}
