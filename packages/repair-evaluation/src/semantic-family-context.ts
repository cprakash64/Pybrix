/** Evaluator-only semantic graph. No source geometry, labels or ID spelling establish ancestry. */
export interface SemanticRecord {
  id: string;
  parentId: string | null;
  label: string;
  instances: number;
  /** Production expectedGeometry.kind, retained by evaluator adapters. */
  kind?: string;
  instanceAnnotations: readonly (readonly number[])[];
}
export interface SemanticOperation {
  id: string;
  parentId: string | null;
  /** Explicit evaluator adapter provenance for generated groups with a distinct operation ID. */
  sourceSemanticId?: string;
}
export interface FamilyContext {
  state: 'NONE' | 'FAMILY_ROOT' | 'FAMILY_MEMBER' | 'AMBIGUOUS_OR_INVALID';
  semanticFamilyRecordId: string | null;
  memberSemanticRecordId: string | null;
  sourceOperationId: string;
  provenancePath: readonly string[];
  familyRole: string | null;
  expectedFamilyId: string | null;
}
export function semanticGraph(records: readonly SemanticRecord[]): {
  recordById: Pick<ReadonlyMap<string, Readonly<SemanticRecord>>, 'get' | 'has' | 'values'>;
  context: (operation: SemanticOperation) => FamilyContext;
} {
  if (records.length > 24) throw Error('SEMANTIC_RECORD_LIMIT');
  const byId = new Map<string, Readonly<SemanticRecord>>();
  for (const record of records) {
    if (!record.id || byId.has(record.id)) throw Error('DUPLICATE_OR_EMPTY_SEMANTIC_ID');
    if (!Number.isInteger(record.instances) || record.instances < 1 || record.instances > 12)
      throw Error('INVALID_SEMANTIC_INSTANCE_COUNT');
    if (record.parentId !== null && typeof record.parentId !== 'string')
      throw Error('MISSING_EXPLICIT_PARENT');
    byId.set(record.id, Object.freeze({ ...record }));
  }
  for (const record of byId.values()) {
    const visited = new Set<string>();
    let current: Readonly<SemanticRecord> = record;
    for (;;) {
      if (visited.has(current.id)) throw Error('SEMANTIC_PARENT_CYCLE');
      visited.add(current.id);
      if (visited.size > 4) throw Error('SEMANTIC_DEPTH_LIMIT');
      if (current.parentId === null) break;
      const parent = byId.get(current.parentId);
      if (!parent) throw Error('MISSING_SEMANTIC_PARENT');
      current = parent;
    }
  }
  return {
    recordById: Object.freeze({
      get: (id: string): Readonly<SemanticRecord> | undefined => byId.get(id),
      has: (id: string): boolean => byId.has(id),
      values: (): MapIterator<Readonly<SemanticRecord>> => byId.values(),
    }),
    context(operation): FamilyContext {
      if (operation.parentId !== null && typeof operation.parentId !== 'string')
        throw Error('MISSING_OUTPUT_PARENT');
      const own = byId.get(operation.id);
      if (own && own.parentId !== operation.parentId) throw Error('OUTPUT_PARENT_CONFLICT');
      const origin = operation.sourceSemanticId
        ? byId.get(operation.sourceSemanticId)
        : (own ?? (operation.parentId === null ? undefined : byId.get(operation.parentId)));
      if ((operation.sourceSemanticId || operation.parentId !== null) && !origin)
        throw Error('MISSING_OPERATION_PROVENANCE');
      if (own && operation.sourceSemanticId && operation.sourceSemanticId !== own.id)
        throw Error('CONFLICTING_OPERATION_PROVENANCE');
      if (operation.sourceSemanticId && !own && operation.parentId !== origin?.id)
        throw Error('CONFLICTING_GENERATED_PARENT');
      const path: string[] = [];
      let current = origin;
      while (current) {
        path.push(current.id);
        if (isRepeatedFamily(current))
          return {
            state:
              current.id === origin?.id && (own || operation.sourceSemanticId)
                ? 'FAMILY_ROOT'
                : 'FAMILY_MEMBER',
            semanticFamilyRecordId: current.id,
            memberSemanticRecordId: own?.id === current.id ? null : (own?.id ?? null),
            sourceOperationId: operation.id,
            provenancePath: path,
            familyRole: current.label,
            expectedFamilyId: null,
          };
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
      return {
        state: 'NONE',
        semanticFamilyRecordId: null,
        memberSemanticRecordId: own?.id ?? null,
        sourceOperationId: operation.id,
        provenancePath: path,
        familyRole: null,
        expectedFamilyId: null,
      };
    },
  };
}

export function isRepeatedFamily(record: SemanticRecord): boolean {
  return record.instances > 1 || record.kind === 'repeated_part';
}
