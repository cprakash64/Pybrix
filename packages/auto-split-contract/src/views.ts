import { VIEW_NAMES, type ViewName } from './limits';

/**
 * THE SIX CANONICAL CAMERAS.
 *
 * Orthographic, in the MODEL FILE'S OWN axes (no assumption about which way is up), looking at the
 * model's bounding-box centre. The engine renders with them, the service describes them to the
 * provider, and the browser's tests project with them; one table, so the picture the provider reads
 * and the geometry Pybrix matches against are the same projection.
 *
 * Camera positions (the name says where the camera sits):
 *   front  = at -Y looking +Y      rear   = at +Y looking -Y
 *   left   = at -X looking +X      right  = at +X looking -X
 *   top    = at +Z looking -Z      bottom = at -Z looking +Z
 */
export type Vec3 = readonly [number, number, number];

export interface ViewSpec {
  readonly name: ViewName;
  /** Unit vector from the model centre toward the camera. */
  readonly toCamera: Vec3;
  readonly up: Vec3;
  readonly description: string;
}

export const VIEW_SPECS: Readonly<Record<ViewName, ViewSpec>> = Object.freeze({
  front: {
    name: 'front',
    toCamera: [0, -1, 0],
    up: [0, 0, 1],
    description: 'camera at -Y looking toward +Y; image right = +X, image up = +Z',
  },
  rear: {
    name: 'rear',
    toCamera: [0, 1, 0],
    up: [0, 0, 1],
    description: 'camera at +Y looking toward -Y; image right = -X, image up = +Z',
  },
  left: {
    name: 'left',
    toCamera: [-1, 0, 0],
    up: [0, 0, 1],
    description: 'camera at -X looking toward +X; image right = -Y, image up = +Z',
  },
  right: {
    name: 'right',
    toCamera: [1, 0, 0],
    up: [0, 0, 1],
    description: 'camera at +X looking toward -X; image right = +Y, image up = +Z',
  },
  top: {
    name: 'top',
    toCamera: [0, 0, 1],
    up: [0, 1, 0],
    description: 'camera at +Z looking toward -Z; image right = +X, image up = +Y',
  },
  bottom: {
    name: 'bottom',
    toCamera: [0, 0, -1],
    up: [0, -1, 0],
    description: 'camera at -Z looking toward +Z; image right = +X, image up = -Y',
  },
});

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface Camera {
  readonly view: ViewName;
  readonly right: Vec3;
  readonly up: Vec3;
  /** The direction the camera looks along. */
  readonly forward: Vec3;
}

export function cameraFor(view: ViewName): Camera {
  const spec = VIEW_SPECS[view];
  const forward = unit([-spec.toCamera[0], -spec.toCamera[1], -spec.toCamera[2]]);
  const right = unit(cross(forward, unit(spec.up)));
  const up = cross(right, forward);
  return { view, right, up, forward };
}

/** How much of the image the bounding sphere fills. The rasteriser and every projection share it. */
export const FRAME_FILL = 0.92;

/**
 * A normalized-model point in a view's NORMALIZED IMAGE coordinates: x from the left edge, y from the
 * top edge, both 0 to 1 — the convention the provider answers in. `radius` is the bounding-sphere
 * radius of the normalized model, which sets the one scale every view shares.
 */
export function projectPoint(
  radius: number,
  view: ViewName,
  point: Vec3,
): readonly [number, number] {
  const camera = cameraFor(view);
  const perUnit = FRAME_FILL / (2 * Math.max(radius, 1e-9));
  return [0.5 + dot(point, camera.right) * perUnit, 0.5 - dot(point, camera.up) * perUnit];
}

export { VIEW_NAMES };
