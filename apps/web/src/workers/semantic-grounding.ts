import type { GroundedRegion } from '@cadfixer/auto-split';
import type { DocumentHandle } from '@cadfixer/geometry-runtime';
import type { CanonicalMesh } from '@cadfixer/mesh-core';

/**
 * THE FACES EACH RECOGNIZED PART WAS GROUNDED TO, for the one analysis that is current.
 *
 * Worker-resident like the native-finalist registry and with the same lifecycle: a new analysis, a new
 * preparation or a document change replaces it, and an answer is only given for the exact
 * (document, revision, part) AND the exact mesh object the analysis ran on. The page never holds a face
 * set; it asks for one to draw. Asking changes nothing: no document, no revision, no history, no
 * candidate, no budget.
 *
 * Memory is bounded by construction: one bit a face and at most 24 parts (a full semantic answer).
 */
const key = (source: DocumentHandle, part: string): string =>
  JSON.stringify([source.documentId, source.revision, part]);

let current:
  | {
      readonly key: string;
      readonly mesh: WeakRef<CanonicalMesh>;
      readonly preparationId: number;
      readonly regions: ReadonlyMap<string, GroundedRegion>;
    }
  | undefined;

export function clearSemanticGrounding(): void {
  current = undefined;
}

export function registerSemanticGrounding(
  source: DocumentHandle,
  part: string,
  mesh: CanonicalMesh,
  preparationId: number,
  regions: ReadonlyMap<string, GroundedRegion>,
): void {
  current = { key: key(source, part), mesh: new WeakRef(mesh), preparationId, regions };
}

export type GroundedFaces =
  | { readonly state: 'FOUND'; readonly faces: Uint32Array }
  | { readonly state: 'STALE' }
  | { readonly state: 'NOT_GROUNDED' };

/** The faces for one suggestion, or why there are none. STALE means the analysis is no longer the current one. */
export function groundedFacesFor(
  source: DocumentHandle,
  part: string,
  mesh: CanonicalMesh,
  suggestionId: string,
): GroundedFaces {
  const c = current;
  if (c?.key !== key(source, part) || c.mesh.deref() !== mesh) return { state: 'STALE' };
  const region = c.regions.get(suggestionId);
  if (region === undefined) return { state: 'NOT_GROUNDED' };
  const faces = new Uint32Array(region.faces);
  let n = 0;
  for (let word = 0; word < region.faceBits.length; word += 1) {
    let bits = region.faceBits[word] ?? 0;
    while (bits !== 0) {
      const low = bits & -bits;
      faces[n] = word * 32 + (31 - Math.clz32(low));
      n += 1;
      bits ^= low;
    }
  }
  return { state: 'FOUND', faces: n === faces.length ? faces : faces.slice(0, n) };
}
