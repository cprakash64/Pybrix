/** Prospective source-truth evaluator only. Never imported by product realization. */
export const SEMANTIC_PHYSICAL_EVALUATOR_MARKER = 'SEMANTIC_BETA_PROSPECTIVE_EVALUATOR_ONLY';
export interface PhysicalRole {
  readonly concept: string;
  readonly faces: readonly number[];
  readonly instances?: readonly (readonly number[])[];
  readonly aggregate?: boolean;
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
export interface PhysicalAssessment {
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
  readonly attribution: 'FROZEN_LABEL_AND_SOURCE' | 'UNIQUE_EXACT_SOURCE' | 'UNRESOLVED';
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
/** A wording fallback is permitted only for one EXACT frozen physical scope. Approximate
 * source matches cannot silently reassign a wrongly selected role to a different role. */
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
    const bound = candidates.filter(
      (c) => c.role.concept === operation.semanticConcept && c.precision >= 0.9 && c.recall >= 0.9,
    );
    const exact = candidates.filter(
      (c) => !c.role.aggregate && c.precision === 1 && c.recall === 1,
    );
    const chosen = bound.length === 1 ? bound[0] : exact.length === 1 ? exact[0] : undefined;
    const attribution =
      bound.length === 1
        ? ('FROZEN_LABEL_AND_SOURCE' as const)
        : exact.length === 1
          ? ('UNIQUE_EXACT_SOURCE' as const)
          : ('UNRESOLVED' as const);
    const physicalReadyError =
      strictUnknown || !chosen || (operation.kind === 'component' && !operation.nativeValid);
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
