import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { VIEW_NAMES, type HumanAnswer, type VehicleAnswer } from '@cadfixer/auto-split-contract';
import { labelComponents } from './components';
import { faceFacts, normalizeGeometry } from './geometry';
import { suggestHuman } from './human-suggest';
import { rasteriseView } from './raster';
import type { SuggestionResult } from './suggestions';
import { suggestVehicle } from './vehicle-suggest';

/**
 * THE ENTRY POINT THE GEOMETRY WORKER CALLS FOR SUGGESTIONS: a pure function of a part's canonical mesh
 * and a validated semantic answer. It builds a working copy, returns suggestions and keeps nothing; the
 * canonical buffers are read, never written.
 */
export type SemanticAnswer =
  | { readonly mode: 'human'; readonly human: HumanAnswer }
  | { readonly mode: 'vehicle'; readonly vehicle: VehicleAnswer };

export function suggestFor(mesh: CanonicalMesh, answer: SemanticAnswer): SuggestionResult {
  const geometry = normalizeGeometry(mesh.positions, mesh.indices);
  const facts = faceFacts(geometry);
  if (answer.mode === 'human')
    return {
      suggestions: suggestHuman(geometry, facts, answer.human),
      components: [],
      componentCount: 0,
      faceCount: geometry.faceCount,
    };
  // Vehicles need the face-id buffers; the images are not needed here and are not encoded.
  const rasters = VIEW_NAMES.map((view) => rasteriseView(geometry, view));
  const labelling = labelComponents(mesh, facts);
  return suggestVehicle({ geometry, facts, labelling, rasters, answer: answer.vehicle });
}
