import type { JointCutAxes, JointDescriptor } from '@cadfixer/geometry-runtime';
import { labelCutAxes } from './cut-axes-presentation';

/**
 * THE CUT MARKED ON THE MODEL (Stage EC-9): the picture of a cut, drawn where the cut is.
 *
 * The worker says where the cut's origin and axes are in the scene and how long one unit of the cut's own axes is there
 * (`cutFace.axes`). A point `(u, v)` of the cut is then `origin + scale × (u·U + v·V)`, and the outline the picture already draws can be
 * laid on the model with arithmetic alone: no mesh, interface or placement is held here. A test holds that mapping to the scene centre of
 * a pin the real kernel cut.
 *
 * WHAT IS DRAWN. The cut's outline on each piece's face (two faces when the view is exploded, one when it is assembled), a ring for the
 * pin and one for its socket for every connector of the DRAFT (so dragging one in the picture moves it on the model as it is dragged),
 * and an arrow along each of the cut's two directions with the model axis it points along, from the same labels the picture uses. It
 * decides nothing: a position is judged by the worker when the change is checked, as before.
 */
export type Vec3 = readonly [number, number, number];

export interface CutMark {
  /** Pairs of scene points: the outline of the cut on each face. */
  readonly outline: Float32Array;
  /** Pairs of scene points: a ring for each draft pin and for its socket, on each face. */
  readonly pins: Float32Array;
  /** Segments in one ring of `pins`. */
  readonly ringSegments: number;
  /** Pairs of scene points: the arrow along the cut's across direction. */
  readonly across: Float32Array;
  /** Pairs of scene points: the arrow along the cut's along direction. */
  readonly along: Float32Array;
  /** Short texts to write in the scene: the model axis each arrow points along. */
  readonly labels: readonly { readonly position: Vec3; readonly text: string }[];
}

export interface CutMarkDraft {
  readonly pins: readonly { readonly u: number; readonly v: number }[];
  readonly diameterMm: number;
  readonly clearanceMm: number;
}

/** Segments a ring is drawn with. */
export const RING_SEGMENTS = 32;
/** How long an arrow is, as a share of the cut's extent along its own direction. */
export const ARROW_SHARE = 0.45;
/** The head of an arrow: its length as a share of the arrow, and its opening half-angle. */
const HEAD_SHARE = 0.18;
const HEAD_ANGLE = (25 * Math.PI) / 180;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** The scene point of the cut's `(u, v)`. */
export function cutPointInScene(axes: JointCutAxes, u: number, v: number): Vec3 {
  const s = axes.scenePerCoordinate;
  return add(axes.origin, add(scaled(axes.u, u * s), scaled(axes.v, v * s)));
}

class Segments {
  private readonly values: number[] = [];
  public push(a: Vec3, b: Vec3): void {
    this.values.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  public toFloat32(): Float32Array {
    return Float32Array.from(this.values);
  }
}

/**
 * The mark for one attached cut, or `undefined` when the worker did not say where the cut is or described no outline. `offsets` are the
 * display offsets of the cut's two pieces (zero when the view is assembled); a face is drawn once for offsets that agree.
 */
export function buildCutMark(
  joint: JointDescriptor,
  draft: CutMarkDraft | undefined,
  offsets: { readonly a: Vec3; readonly b: Vec3 },
): CutMark | undefined {
  const face = joint.cutFace;
  const axes = face?.axes;
  const outline = face?.outline;
  if (
    joint.status !== 'ATTACHED' ||
    face === undefined ||
    axes === undefined ||
    outline === undefined
  )
    return undefined;
  const faces: Vec3[] = [offsets.a];
  if (offsets.b.some((value, k) => value !== offsets.a[k])) faces.push(offsets.b);

  const outlineSegments = new Segments();
  const pinSegments = new Segments();
  const ringRadius = (millimetres: number): number =>
    (millimetres / face.mmPerCoordinate) * axes.scenePerCoordinate;

  for (const offset of faces) {
    for (const loop of outline.loops) {
      const { points } = loop;
      const count = Math.floor(points.length / 2);
      for (let i = 0; i < count; i += 1) {
        const j = (i + 1) % count;
        outlineSegments.push(
          add(cutPointInScene(axes, points[2 * i] ?? 0, points[2 * i + 1] ?? 0), offset),
          add(cutPointInScene(axes, points[2 * j] ?? 0, points[2 * j + 1] ?? 0), offset),
        );
      }
    }
    if (draft !== undefined)
      for (const pin of draft.pins)
        for (const radius of [
          ringRadius(draft.diameterMm / 2),
          ringRadius(draft.diameterMm / 2 + draft.clearanceMm),
        ]) {
          const centre = add(cutPointInScene(axes, pin.u, pin.v), offset);
          for (let i = 0; i < RING_SEGMENTS; i += 1) {
            const a = (2 * Math.PI * i) / RING_SEGMENTS;
            const b = (2 * Math.PI * (i + 1)) / RING_SEGMENTS;
            const at = (t: number): Vec3 =>
              add(
                centre,
                add(scaled(axes.u, radius * Math.cos(t)), scaled(axes.v, radius * Math.sin(t))),
              );
            pinSegments.push(at(a), at(b));
          }
        }
  }

  // The arrows sit on the first face, from the corner of the outline's box, along its two edges.
  const { minU, maxU, minV, maxV } = outline.bounds;
  const first = faces[0] ?? [0, 0, 0];
  const corner = add(cutPointInScene(axes, minU, minV), first);
  const labels = labelCutAxes(axes);
  const arrow = (direction: Vec3, other: Vec3, length: number): Float32Array => {
    const segments = new Segments();
    const tip = add(corner, scaled(direction, length));
    segments.push(corner, tip);
    const head = length * HEAD_SHARE;
    for (const side of [1, -1])
      segments.push(
        tip,
        add(
          tip,
          add(
            scaled(direction, -head * Math.cos(HEAD_ANGLE)),
            scaled(other, side * head * Math.sin(HEAD_ANGLE)),
          ),
        ),
      );
    return segments.toFloat32();
  };
  const s = axes.scenePerCoordinate;
  const acrossLength = (maxU - minU) * s * ARROW_SHARE;
  const alongLength = (maxV - minV) * s * ARROW_SHARE;
  const textFor = (name: { readonly short: string }): string => name.short;
  return Object.freeze({
    outline: outlineSegments.toFloat32(),
    pins: pinSegments.toFloat32(),
    ringSegments: RING_SEGMENTS,
    across: arrow(axes.u, axes.v, acrossLength),
    along: arrow(axes.v, axes.u, alongLength),
    labels: Object.freeze([
      {
        position: add(corner, scaled(axes.u, acrossLength * 1.12)),
        text: textFor(labels.across),
      },
      {
        position: add(corner, scaled(axes.v, alongLength * 1.12)),
        text: textFor(labels.along),
      },
    ]),
  });
}
