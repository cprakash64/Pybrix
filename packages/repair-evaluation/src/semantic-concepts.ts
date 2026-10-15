export const SEMANTIC_SCOPE_MATCHER_MARKER = 'SEMANTIC_SCOPE_PROSPECTIVE_EVALUATOR_ONLY';
/** Prospective evaluator only: freeze the definitions before dispatch. Never repairs provider labels. */
export interface SemanticConceptDefinition {
  readonly concept: string;
  readonly phrases: readonly string[];
}
export interface SemanticConceptMatch {
  readonly concept: string | null;
  readonly reason: 'MATCH' | 'NONE' | 'AMBIGUOUS';
  readonly phrase: string | null;
}
const modifiers = new Set([
  'uppermost',
  'central',
  'separate',
  'rectangular',
  'horizontal',
  'vertical',
  'integrated',
]);
function normalize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word === 'feet'
        ? 'foot'
        : /(?:sses|ches|shes|xes|zes)$/.test(word)
          ? word.slice(0, -2)
          : word.endsWith('ies')
            ? word.slice(0, -3) + 'y'
            : word.endsWith('s') &&
                !word.endsWith('ss') &&
                !word.endsWith('us') &&
                !word.endsWith('is')
              ? word.slice(0, -1)
              : word,
    )
    .filter((word) => !modifiers.has(word));
}
export function compileSemanticConceptMatcher(
  definitions: readonly SemanticConceptDefinition[],
): (label: string) => SemanticConceptMatch {
  if (definitions.length > 24) throw Error('Concept limit exceeded');
  const phrases: { concept: string; phrase: string; tokens: readonly string[] }[] = [];
  for (const d of definitions) {
    if (!d.concept || d.phrases.length > 24) throw Error('Invalid concept definition');
    for (const raw of d.phrases) {
      if (raw.length > 96) throw Error('Phrase limit exceeded');
      const tokens = normalize(raw),
        phrase = tokens.join(' ');
      if (!tokens.length || tokens.length > 8) throw Error('Invalid concept phrase');
      if (phrases.some((p) => p.phrase === phrase && p.concept !== d.concept))
        throw Error('Ambiguous frozen concept phrase');
      phrases.push({ concept: d.concept, phrase, tokens });
    }
  }
  return (label: string): SemanticConceptMatch => {
    if (label.length > 128) return { concept: null, phrase: null, reason: 'NONE' };
    const full = normalize(label);
    const composites = phrases.filter(
      (p) =>
        p.tokens.some((t) => t === 'and' || t === 'with' || t === 'or') &&
        p.tokens.length <= full.length &&
        p.tokens.every((t, i) => t === full[full.length - p.tokens.length + i]),
    );
    if (composites.length) {
      const longest = Math.max(...composites.map((p) => p.tokens.length));
      const best = composites.filter((p) => p.tokens.length === longest);
      const concepts = new Set(best.map((p) => p.concept));
      return concepts.size === 1
        ? { concept: best[0]?.concept ?? null, phrase: best[0]?.phrase ?? null, reason: 'MATCH' }
        : { concept: null, phrase: null, reason: 'AMBIGUOUS' };
    }
    const matches = label
      .split(/\b(?:and|or|with)\b|[&/]/i)
      .map((segment) => {
        const tokens = normalize(segment);
        const eligible = phrases.filter(
          (p) =>
            p.tokens.length <= tokens.length &&
            p.tokens.every((t, i) => t === tokens[tokens.length - p.tokens.length + i]),
        );
        const length = Math.max(0, ...eligible.map((p) => p.tokens.length));
        return eligible.filter((p) => p.tokens.length === length);
      })
      .flat();
    const concepts = new Set(matches.map((p) => p.concept));
    if (concepts.size !== 1)
      return { concept: null, phrase: null, reason: concepts.size ? 'AMBIGUOUS' : 'NONE' };
    const best = matches[0];
    return { concept: best?.concept ?? null, phrase: best?.phrase ?? null, reason: 'MATCH' };
  };
}
