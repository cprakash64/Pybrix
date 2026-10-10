import type { Box4, ViewName } from '@cadfixer/auto-split-contract';
import type { ComponentFacts } from './components';
import type { Raster } from './raster';
import type { ComponentLabelling } from './components';

/**
 * WHERE EACH COMPONENT IS IN EACH IMAGE: how many of its pixels are the front-most surface, and the
 * bounding box of those pixels in the image's own normalized coordinates (x from the left edge, y
 * from the top, 0 to 1) — the convention a semantic answer uses. Product-available: it reads the
 * geometry and its own render, never an annotation.
 */
export interface ViewVisibility {
  readonly pixels: number;
  /** The box of the visible pixels, or null when the component is not visible in this view. */
  readonly box: Box4 | null;
}

export interface ComponentDescriptor extends ComponentFacts {
  readonly views: readonly ViewVisibility[];
}

export function describeComponents(
  facts: readonly ComponentFacts[],
  labelling: ComponentLabelling,
  rasters: readonly Raster[],
): ComponentDescriptor[] {
  const n = facts.length;
  const perView = rasters.map((raster) => {
    const { face, size } = raster;
    const pixels = new Int32Array(n);
    const box = new Float64Array(n * 4);
    for (let c = 0; c < n; c += 1) {
      box[c * 4] = size;
      box[c * 4 + 1] = size;
      box[c * 4 + 2] = -1;
      box[c * 4 + 3] = -1;
    }
    for (let y = 0; y < size; y += 1) {
      const row = y * size;
      for (let x = 0; x < size; x += 1) {
        const t = face[row + x] ?? -1;
        if (t < 0) continue;
        const c = labelling.faceRank[t] ?? -1;
        if (c < 0) continue;
        pixels[c] = (pixels[c] ?? 0) + 1;
        const o = c * 4;
        if (x < (box[o] ?? size)) box[o] = x;
        if (y < (box[o + 1] ?? size)) box[o + 1] = y;
        if (x > (box[o + 2] ?? -1)) box[o + 2] = x;
        if (y > (box[o + 3] ?? -1)) box[o + 3] = y;
      }
    }
    return { pixels, box, size };
  });
  return facts.map((f): ComponentDescriptor => ({
    ...f,
    views: perView.map((v): ViewVisibility => {
      const count = v.pixels[f.rank] ?? 0;
      const o = f.rank * 4;
      return {
        pixels: count,
        box:
          count > 0
            ? [
                (v.box[o] ?? 0) / v.size,
                (v.box[o + 1] ?? 0) / v.size,
                ((v.box[o + 2] ?? 0) + 1) / v.size,
                ((v.box[o + 3] ?? 0) + 1) / v.size,
              ]
            : null,
      };
    }),
  }));
}

/** Visible pixels of every component inside a box of one view, from that view's own raster. */
export function pixelCounter(
  rasters: readonly Raster[],
  views: readonly ViewName[],
  labelling: ComponentLabelling,
): (view: ViewName, box: Box4) => Int32Array {
  const index = new Map(views.map((v, i) => [v, i] as const));
  const cache = new Map<string, Int32Array>();
  return (view, box) => {
    const key = `${view}:${box.join(',')}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const out = new Int32Array(labelling.count);
    const raster = rasters[index.get(view) ?? -1];
    if (raster) {
      const { size, face } = raster;
      const x0 = Math.max(0, Math.floor(box[0] * size));
      const x1 = Math.min(size, Math.ceil(box[2] * size));
      const y0 = Math.max(0, Math.floor(box[1] * size));
      const y1 = Math.min(size, Math.ceil(box[3] * size));
      for (let y = y0; y < y1; y += 1)
        for (let x = x0; x < x1; x += 1) {
          const t = face[y * size + x] ?? -1;
          if (t < 0) continue;
          const r = labelling.faceRank[t];
          if (r !== undefined) out[r] = (out[r] ?? 0) + 1;
        }
    }
    cache.set(key, out);
    return out;
  };
}
