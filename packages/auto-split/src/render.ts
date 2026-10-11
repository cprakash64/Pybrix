import { VIEW_IMAGE_SIZE, VIEW_NAMES, type ViewName } from '@cadfixer/auto-split-contract';
import { NO_CHECKPOINT, type Checkpoint } from './checkpoint';
import type { NormalizedGeometry } from './geometry';
import { encodePng, type Deflate } from './png';
import { rasteriseView, shadeView, type Raster } from './raster';

/**
 * THE SIX CANONICAL RGB VIEWS a semantic request carries, and nothing else: no interface chrome, no
 * file name, no overlay, a neutral background and one fixed light. The rasters are returned beside the
 * images so the matcher can reuse them without a second pass.
 */
export interface SemanticRender {
  readonly rasters: readonly Raster[];
  readonly pngs: readonly Uint8Array[];
}

export async function renderSemanticViews(
  geometry: NormalizedGeometry,
  deflate: Deflate,
  options: {
    readonly keepRasters?: boolean;
    readonly onView?: (view: ViewName, index: number) => void;
    readonly checkpoint?: Checkpoint;
  } = {},
): Promise<SemanticRender> {
  const checkpoint = options.checkpoint ?? NO_CHECKPOINT;
  const rasters: Raster[] = [];
  const pngs: Uint8Array[] = [];
  for (const [index, view] of VIEW_NAMES.entries()) {
    checkpoint();
    const raster = rasteriseView(geometry, view, checkpoint);
    pngs.push(
      await encodePng(VIEW_IMAGE_SIZE, VIEW_IMAGE_SIZE, shadeView(geometry, raster), deflate),
    );
    if (options.keepRasters === true) rasters.push(raster);
    options.onView?.(view, index);
  }
  return { rasters, pngs };
}
