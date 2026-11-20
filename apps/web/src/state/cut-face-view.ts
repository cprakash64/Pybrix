import type { JointOutline } from '@cadfixer/geometry-runtime';

/**
 * THE ARITHMETIC OF THE CUT-FACE VIEW (Stage EC-6): where the cut is drawn, and which point of the cut a pointer is over. Nothing here
 * decides whether a position is valid; that is the worker's, reached by Check change.
 *
 * The cut is in its own two axes, `u` across and `v` along, and the picture puts `u` to the right and `v` UP. SVG's y grows downward, so
 * the view negates `v` in exactly one place, `toViewY`, and `pointerToCut` undoes it; nothing else knows the picture is flipped.
 */

export interface CutView {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PointerRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The share of the cut's larger extent left empty around it, so a connector near the edge can still be grabbed and seen whole. */
export const VIEW_MARGIN = 0.12;

/** A view onto the outline's bounds with a margin, for a cut of any size and for a degenerate one with no extent along an axis. */
export function cutView(bounds: JointOutline['bounds']): CutView {
  const spanU = bounds.maxU - bounds.minU;
  const spanV = bounds.maxV - bounds.minV;
  const larger = Math.max(spanU, spanV, Number.EPSILON);
  const margin = larger * VIEW_MARGIN;
  return {
    x: bounds.minU - margin,
    y: -(bounds.maxV + margin),
    width: spanU + 2 * margin,
    height: spanV + 2 * margin,
  };
}

/** The picture's y for a cut's `v`. */
export const toViewY = (v: number): number => -v;

/**
 * The point of the cut under a pointer. The SVG keeps its aspect ratio (`xMidYMid meet`), so the view may sit inside the element with
 * empty bands at the sides or the top; the scale is the smaller of the two and the view is centred, which is what the browser does.
 */
export function pointerToCut(
  view: CutView,
  rect: PointerRect,
  clientX: number,
  clientY: number,
): { readonly u: number; readonly v: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0 || view.width <= 0 || view.height <= 0) return undefined;
  const scale = Math.min(rect.width / view.width, rect.height / view.height);
  const offsetX = (rect.width - view.width * scale) / 2;
  const offsetY = (rect.height - view.height * scale) / 2;
  const x = view.x + (clientX - rect.left - offsetX) / scale;
  const y = view.y + (clientY - rect.top - offsetY) / scale;
  return { u: x, v: -y };
}

/** One path for the whole outline; the even-odd fill rule leaves a HOLE loop empty. */
export function outlinePath(outline: JointOutline): string {
  const parts: string[] = [];
  for (const loop of outline.loops) {
    const { points } = loop;
    for (let i = 0; i + 1 < points.length; i += 2) {
      const u = points[i];
      const v = points[i + 1];
      if (u === undefined || v === undefined) continue;
      parts.push(`${i === 0 ? 'M' : 'L'}${String(u)} ${String(toViewY(v))}`);
    }
    parts.push('Z');
  }
  return parts.join(' ');
}

/** A pin or socket radius, in the cut's own units, from its millimetres. */
export const radiusInCut = (millimetres: number, mmPerCoordinate: number): number =>
  millimetres / mmPerCoordinate;
