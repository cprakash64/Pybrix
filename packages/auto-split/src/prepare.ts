import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { AnalyzeSummary, ViewName } from '@cadfixer/auto-split-contract';
import { type Checkpoint, NO_CHECKPOINT } from './checkpoint';
import { labelComponents } from './components';
import { faceFacts, normalizeGeometry } from './geometry';
import type { Deflate } from './png';
import { renderSemanticViews } from './render';

export interface PreparedViews {
  readonly pngs: readonly Uint8Array[];
  readonly summary: AnalyzeSummary;
}

/**
 * THE SIX VIEWS AND THE BOUNDED METADATA a semantic request carries, built from a part's canonical
 * mesh. The summary is three numbers about the bounding box, the shell count and the bounding radius:
 * nothing that names or reproduces the design.
 */
export async function prepareViews(
  mesh: CanonicalMesh,
  deflate: Deflate,
  onView?: (view: ViewName, index: number) => void,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): Promise<PreparedViews> {
  const geometry = normalizeGeometry(mesh.positions, mesh.indices, checkpoint);
  const render = await renderSemanticViews(geometry, deflate, {
    checkpoint,
    ...(onView === undefined ? {} : { onView }),
  });
  const shells = labelComponents(mesh, faceFacts(geometry, checkpoint), checkpoint).count;
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    pngs: render.pngs,
    summary: {
      extents: [round(geometry.extents[0]), round(geometry.extents[1]), round(geometry.extents[2])],
      shells,
      radius: round(geometry.radius),
    },
  };
}
