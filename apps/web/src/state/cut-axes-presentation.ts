import type { JointCutAxes } from '@cadfixer/geometry-runtime';

/**
 * HOW THE AXES OF A CUT ARE NAMED AGAINST THE MODEL'S OWN (Stage EC-8). The worker says where the cut's two axes and its normal point in
 * the scene, whose axes are the model's: nothing but a part's placement turns a model, and the placement is already in what the worker
 * sends. This file turns three unit vectors into the words a person reads beside the picture. It decides nothing about a connector.
 *
 * NAMING A DIRECTION. A direction within `EXACT_DEGREES` of a model axis is that axis: `+X`. One further off but within
 * `NEAREST_DEGREES` is named by its nearest axis and says how far it is turned, so a cut tilted 7 degrees is never called plain `+X`. A
 * direction further than that has no honest axis name, and is given as its components.
 *
 * WHAT IT SAYS ABOUT THE VIEWER. The picture has `u` to the right and `v` up, so it is seen from the side its normal points to when
 * u × v = normal, and from the other side when it is the reverse. That is computed from the three vectors, never assumed.
 */
export const EXACT_DEGREES = 1;
export const NEAREST_DEGREES = 20;

export type ModelAxis = 'X' | 'Y' | 'Z';

export interface NamedDirection {
  /** The short form drawn on the picture: `+X`, `≈−Z`, or `tilted` when no axis names it. */
  readonly short: string;
  /** The full form for a sentence: `+X`, `−Z, turned 7° from the Z axis`, or `(0.58, 0.58, 0.58) in X, Y, Z`. */
  readonly long: string;
  /** The model axis and sign when one names it, else `undefined`. */
  readonly axis: { readonly name: ModelAxis; readonly sign: 1 | -1 } | undefined;
}

const NAMES: readonly ModelAxis[] = ['X', 'Y', 'Z'];
const MINUS = '−';

const degrees = (radians: number): number => (radians * 180) / Math.PI;
const component = (value: number): string => String(Number(value.toFixed(2)) + 0);

export function nameDirection(direction: readonly [number, number, number]): NamedDirection {
  let best = 0;
  for (let i = 1; i < 3; i += 1)
    if (Math.abs(direction[i] ?? 0) > Math.abs(direction[best] ?? 0)) best = i;
  const along = direction[best] ?? 0;
  const sign: 1 | -1 = along < 0 ? -1 : 1;
  const name = NAMES[best] ?? 'X';
  // the angle to the nearest axis, from the cosine: the vector is a unit vector, so |component| is that cosine
  const off = degrees(Math.acos(Math.min(1, Math.abs(along))));
  const label = `${sign === 1 ? '+' : MINUS}${name}`;
  if (off <= EXACT_DEGREES) return { short: label, long: label, axis: { name, sign } };
  if (off <= NEAREST_DEGREES) {
    const turned = String(Number(off.toFixed(1)));
    return {
      short: `≈${label}`,
      long: `${label}, turned ${turned}° from the ${name} axis`,
      axis: { name, sign },
    };
  }
  const parts = direction.map(component).join(', ');
  return { short: 'tilted', long: `(${parts}) in X, Y, Z`, axis: undefined };
}

export interface CutAxisLabels {
  readonly across: NamedDirection;
  readonly along: NamedDirection;
  readonly normal: NamedDirection;
  /** The side the picture is seen from, as the direction toward the viewer, or `undefined` when the three vectors are not a frame. */
  readonly seenFrom: NamedDirection | undefined;
}

const cross = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function labelCutAxes(axes: Pick<JointCutAxes, 'u' | 'v' | 'normal'>): CutAxisLabels {
  const [x, y, z] = cross(axes.u, axes.v);
  const handed = x * axes.normal[0] + y * axes.normal[1] + z * axes.normal[2];
  const normal = nameDirection(axes.normal);
  // u × v is the direction toward the viewer of a picture with u to the right and v up: with the normal it is the same direction or the
  // opposite one. Anything in between is not a frame, and nothing is claimed.
  const seenFrom =
    Math.abs(handed) < 0.99
      ? undefined
      : nameDirection(
          handed > 0 ? axes.normal : [-axes.normal[0], -axes.normal[1], -axes.normal[2]],
        );
  return { across: nameDirection(axes.u), along: nameDirection(axes.v), normal, seenFrom };
}

/** The sentence under the picture: where each of its two directions points on the model, and the side it is seen from. */
export function cutAxesSentence(labels: CutAxisLabels): string {
  const side =
    labels.seenFrom === undefined ? '' : ` It is seen from the ${labels.seenFrom.long} side.`;
  return `Across runs toward ${labels.across.long} on the model, and along toward ${labels.along.long}.${side}`;
}
