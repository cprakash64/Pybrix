import { resourceLimitExceeded } from '@cadfixer/shared';
import {
  cameraFor,
  dot,
  FRAME_FILL,
  VIEW_IMAGE_SIZE,
  VIEW_NAMES,
  type Vec3,
  type ViewName,
} from '@cadfixer/auto-split-contract';
import { CHECKPOINT_STRIDE, CHECKPOINT_MASK, NO_CHECKPOINT, type Checkpoint } from './checkpoint';
import type { NormalizedGeometry } from './geometry';

/**
 * A DETERMINISTIC SOFTWARE RASTERISER for the semantic renders.
 *
 * Not the viewport, not a GPU, no browser: orthographic projection, a z-buffer and flat per-triangle
 * shading in plain arithmetic, so the same buffers give the same pixels on every machine. It exists
 * for two reasons, and they are the same picture: the image the provider reads, and the FACE-ID
 * buffer the matcher compares a semantic box with. A box drawn on image k means the same place in the
 * face-id buffer of view k, pixel for pixel.
 *
 * The scale is one per MODEL, identical in all six views: the bounding sphere fills `FRAME_FILL` of
 * the frame. The grid is supersampled 2 x and the image averages each 2 x 2.
 */
export const SUPERSAMPLE = 2;
export const GRID_SIZE = VIEW_IMAGE_SIZE * SUPERSAMPLE;

export interface Raster {
  readonly view: ViewName;
  /** The supersampled grid's side. */
  readonly size: number;
  /** Per grid pixel: the front-most face, or -1. */
  readonly face: Int32Array;
  /** Retained only for semantic correspondence; never transmitted. */
  readonly depth?: Float32Array;
}

export interface RasterWorkBudget {
  rows?: number;
  readonly rowLimit?: number;
  pixels: number;
  readonly limit: number;
}

export function rasteriseView(
  geometry: NormalizedGeometry,
  view: ViewName,
  checkpoint: Checkpoint = NO_CHECKPOINT,
  keepDepth = false,
  budget?: RasterWorkBudget,
): Raster {
  const camera = cameraFor(view);
  const size = GRID_SIZE;
  const perUnit = (size * FRAME_FILL) / (2 * geometry.radius);
  const half = size / 2;
  const face = new Int32Array(size * size).fill(-1);
  const depth = new Float32Array(size * size).fill(Infinity);
  const p = geometry.positions;
  const idx = geometry.indices;
  const { right, up, forward } = camera;
  for (let start = 0; start < geometry.faceCount; start += CHECKPOINT_STRIDE) {
    checkpoint();
    const end = Math.min(geometry.faceCount, start + CHECKPOINT_STRIDE);
    for (let t = start; t < end; t += 1) {
      const ia = (idx[t * 3] ?? 0) * 3;
      const ib = (idx[t * 3 + 1] ?? 0) * 3;
      const ic = (idx[t * 3 + 2] ?? 0) * 3;
      const ax = p[ia] ?? 0;
      const ay = p[ia + 1] ?? 0;
      const az = p[ia + 2] ?? 0;
      const bx = p[ib] ?? 0;
      const by = p[ib + 1] ?? 0;
      const bz = p[ib + 2] ?? 0;
      const cx = p[ic] ?? 0;
      const cy = p[ic + 1] ?? 0;
      const cz = p[ic + 2] ?? 0;
      const x0 = half + (ax * right[0] + ay * right[1] + az * right[2]) * perUnit;
      const y0 = half - (ax * up[0] + ay * up[1] + az * up[2]) * perUnit;
      const x1 = half + (bx * right[0] + by * right[1] + bz * right[2]) * perUnit;
      const y1 = half - (bx * up[0] + by * up[1] + bz * up[2]) * perUnit;
      const x2 = half + (cx * right[0] + cy * right[1] + cz * right[2]) * perUnit;
      const y2 = half - (cx * up[0] + cy * up[1] + cz * up[2]) * perUnit;
      const z0 = ax * forward[0] + ay * forward[1] + az * forward[2];
      const z1 = bx * forward[0] + by * forward[1] + bz * forward[2];
      const z2 = cx * forward[0] + cy * forward[1] + cz * forward[2];
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) - 0.5));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2) - 0.5));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2) - 0.5));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2) - 0.5));
      if (minX > maxX || minY > maxY) continue;
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area === 0) continue;
      const inv = 1 / area;
      for (let y = minY; y <= maxY; y += 1) {
        const py = y + 0.5;
        let rowMin = minX,
          rowMax = maxX;
        if (budget !== undefined) {
          if (budget.rowLimit !== undefined) {
            budget.rows = (budget.rows ?? 0) + 1;
            if ((budget.rows & CHECKPOINT_MASK) === 0) checkpoint();
            if (budget.rows > budget.rowLimit)
              throw resourceLimitExceeded('The analysis render exceeds the supported row limit.', {
                code: 'AUTO_SPLIT_SEMANTIC_RENDER_LIMIT',
                metric: 'rasterRows',
                value: budget.rows,
                limit: budget.rowLimit,
              });
          }
          // Conservative row clipping skips pixels outside the triangle's horizontal span.
          // The existing barycentric/depth test is unchanged and still decides every admitted pixel.
          let left = Infinity,
            right = -Infinity;
          for (let edge = 0; edge < 3; edge++) {
            const xa = edge === 0 ? x0 : edge === 1 ? x1 : x2,
              ya = edge === 0 ? y0 : edge === 1 ? y1 : y2,
              xb = edge === 0 ? x1 : edge === 1 ? x2 : x0,
              yb = edge === 0 ? y1 : edge === 1 ? y2 : y0;
            if (py < Math.min(ya, yb) - 1e-7 || py > Math.max(ya, yb) + 1e-7) continue;
            if (ya === yb) {
              left = Math.min(left, xa, xb);
              right = Math.max(right, xa, xb);
              continue;
            }
            const hit = xa + ((py - ya) * (xb - xa)) / (yb - ya);
            left = Math.min(left, hit);
            right = Math.max(right, hit);
          }
          if (left === Infinity) continue;
          rowMin = Math.max(minX, Math.ceil(left - 0.5 - 1e-7));
          rowMax = Math.min(maxX, Math.floor(right - 0.5 + 1e-7));
        }
        for (let x = rowMin; x <= rowMax; x += 1) {
          if (budget !== undefined) {
            if ((budget.pixels & CHECKPOINT_MASK) === 0) checkpoint();
            if (++budget.pixels > budget.limit)
              throw resourceLimitExceeded('The analysis render exceeds the supported work limit.', {
                code: 'AUTO_SPLIT_SEMANTIC_RENDER_LIMIT',
                metric: 'rasterPixels',
                value: budget.pixels,
                limit: budget.limit,
              });
          }
          const px = x + 0.5;
          const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
          const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * z0 + w1 * z1 + w2 * z2;
          const o = y * size + x;
          if (z < (depth[o] ?? Infinity)) {
            depth[o] = z;
            face[o] = t;
          }
        }
      }
    }
  }
  return { view, size, face, ...(keepDepth ? { depth } : {}) };
}

const BACKGROUND: readonly [number, number, number] = [236, 236, 236];
const BASE: readonly [number, number, number] = [150, 160, 176];
const KEY_LIGHT: Vec3 = ((): Vec3 => {
  const l = Math.hypot(-0.45, 0.6, 0.66);
  return [-0.45 / l, 0.6 / l, 0.66 / l];
})();

/** Shaded grey RGB, 512 x 512: each pixel averages the 2 x 2 grid samples under it. */
export function shadeView(geometry: NormalizedGeometry, raster: Raster): Uint8Array {
  const camera = cameraFor(raster.view);
  const toward: Vec3 = [-camera.forward[0], -camera.forward[1], -camera.forward[2]];
  const p = geometry.positions;
  const idx = geometry.indices;
  const out = new Uint8Array(VIEW_IMAGE_SIZE * VIEW_IMAGE_SIZE * 3);
  const s = SUPERSAMPLE;
  const colour = (t: number): [number, number, number] => {
    const ia = (idx[t * 3] ?? 0) * 3;
    const ib = (idx[t * 3 + 1] ?? 0) * 3;
    const ic = (idx[t * 3 + 2] ?? 0) * 3;
    const ux = (p[ib] ?? 0) - (p[ia] ?? 0);
    const uy = (p[ib + 1] ?? 0) - (p[ia + 1] ?? 0);
    const uz = (p[ib + 2] ?? 0) - (p[ia + 2] ?? 0);
    const vx = (p[ic] ?? 0) - (p[ia] ?? 0);
    const vy = (p[ic + 1] ?? 0) - (p[ia + 1] ?? 0);
    const vz = (p[ic + 2] ?? 0) - (p[ia + 2] ?? 0);
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    }
    // Two-sided: a reversed triangle is shaded as if it faced the camera.
    if (dot([nx, ny, nz], toward) < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const n: Vec3 = [
      dot([nx, ny, nz], camera.right),
      dot([nx, ny, nz], camera.up),
      dot([nx, ny, nz], toward),
    ];
    const diffuse = Math.max(0, n[0] * KEY_LIGHT[0] + n[1] * KEY_LIGHT[1] + n[2] * KEY_LIGHT[2]);
    const k = Math.min(1, 0.32 + 0.52 * diffuse + 0.2 * Math.max(0, n[2]));
    return [BASE[0] * k, BASE[1] * k, BASE[2] * k];
  };
  // A face's colour is the same everywhere it is seen: compute it once per face that appears.
  const cache = new Map<number, [number, number, number]>();
  for (let y = 0; y < VIEW_IMAGE_SIZE; y += 1) {
    for (let x = 0; x < VIEW_IMAGE_SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < s; sy += 1)
        for (let sx = 0; sx < s; sx += 1) {
          const t = raster.face[(y * s + sy) * raster.size + (x * s + sx)] ?? -1;
          if (t < 0) {
            r += BACKGROUND[0];
            g += BACKGROUND[1];
            b += BACKGROUND[2];
          } else {
            let c = cache.get(t);
            if (c === undefined) {
              c = colour(t);
              cache.set(t, c);
            }
            r += c[0];
            g += c[1];
            b += c[2];
          }
        }
      const o = (y * VIEW_IMAGE_SIZE + x) * 3;
      out[o] = Math.round(r / (s * s));
      out[o + 1] = Math.round(g / (s * s));
      out[o + 2] = Math.round(b / (s * s));
    }
  }
  return out;
}

export { VIEW_NAMES };
