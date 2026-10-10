import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { box, concatMeshes, voxelUnion, wheel } from './solids';

/**
 * THE TEST MODELS. Generated here, owned by this repository, with no third-party geometry in them.
 * Each says where its parts are (`truth`) in the model file's own coordinates, so a scenario can describe
 * them the way a semantic provider would and a test can say what the right answer is.
 *
 * FORWARD / UP, for the two vehicles: forward is +X and up is +Z, so the vehicle's own left is +Y.
 * THE FIGURE faces -Y (toward the front camera); its own left arm is therefore on +X.
 */
export interface FixtureModel {
  readonly name: string;
  readonly mesh: CanonicalMesh;
}

/** A blocky figure fused into ONE closed shell: head, neck, torso, two arms, two legs. */
export const FIGURE_CELLS = {
  legs: [
    { lo: [-4, -2, 0], hi: [-1, 2, 10] },
    { lo: [1, -2, 0], hi: [4, 2, 10] },
  ],
  torso: { lo: [-5, -3, 10], hi: [5, 3, 24] },
  neck: { lo: [-1, -1, 24], hi: [1, 1, 26] },
  head: { lo: [-3, -3, 26], hi: [3, 3, 34] },
  /** The figure's own left arm: +X, because it faces -Y. */
  leftArm: { lo: [5, -1, 20], hi: [17, 2, 23] },
  rightArm: { lo: [-17, -1, 20], hi: [-5, 2, 23] },
} as const;

export function humanFigure(): FixtureModel {
  const f = FIGURE_CELLS;
  return {
    name: 'human-figure',
    mesh: voxelUnion([...f.legs, f.torso, f.neck, f.head, f.leftArm, f.rightArm]),
  };
}

/** The figure's bounding box centre and longest side, which fix its normalized coordinates. */
export const FIGURE_FRAME = { center: [0, 0, 17] as const, scale: 34 };

/** A car as FIVE separate closed shells, in this order: body, then four wheels. */
export const CAR = {
  body: { lo: [-30, -12, 4], hi: [30, 12, 16] },
  wheels: [
    { name: 'front-left', cx: 18, y0: 12.5, y1: 16.5 },
    { name: 'front-right', cx: 18, y0: -16.5, y1: -12.5 },
    { name: 'rear-left', cx: -18, y0: 12.5, y1: 16.5 },
    { name: 'rear-right', cx: -18, y0: -16.5, y1: -12.5 },
  ],
  radius: 5,
  centreZ: 5,
} as const;

export function carMultipart(): FixtureModel {
  const parts: CanonicalMesh[] = [box(CAR.body.lo, CAR.body.hi)];
  for (const w of CAR.wheels) parts.push(wheel(w.cx, CAR.centreZ, CAR.radius, w.y0, w.y1));
  return { name: 'car-multipart', mesh: concatMeshes(parts) };
}

/** The car's bounding box: x -30..30, y -16.5..16.5, z 0..16. */
export const CAR_FRAME = { center: [0, 0, 8] as const, scale: 60 };

/**
 * A car whose wheels are FUSED into the body: one closed shell. A wheel here is a block grown out of the
 * body, so no component is "the wheel" and no plane takes one off. Wheels are the corners x 13..23 and
 * y 12..16 (and their mirrors), z 0..10.
 */
export const CAR_FUSED = {
  wheelBlocks: [
    { name: 'front-left', lo: [13, 12, 0], hi: [23, 16, 10] },
    { name: 'front-right', lo: [13, -16, 0], hi: [23, -12, 10] },
    { name: 'rear-left', lo: [-23, 12, 0], hi: [-13, 16, 10] },
    { name: 'rear-right', lo: [-23, -16, 0], hi: [-13, -12, 10] },
  ],
} as const;

export function carFused(): FixtureModel {
  return {
    name: 'car-fused',
    mesh: voxelUnion([
      { lo: [-30, -12, 4], hi: [30, 12, 16] },
      ...CAR_FUSED.wheelBlocks.map((w) => ({ lo: w.lo, hi: w.hi })),
    ]),
  };
}

/**
 * A truck: ONE fused shell for chassis, bed and cab (the cab is the front, +X, upper block), plus four
 * separate wheels. The cab and the bed are not separate components, so only a plane can separate them.
 */
export const TRUCK = {
  chassisAndBed: { lo: [-30, -8, 4], hi: [30, 8, 14] },
  cab: { lo: [10, -8, 14], hi: [30, 8, 26] },
  /** The cab meets the bed at x = 10. */
  joinX: 10,
  wheels: [
    { name: 'front-left', cx: 20, y0: 8.5, y1: 12.5 },
    { name: 'front-right', cx: 20, y0: -12.5, y1: -8.5 },
    { name: 'rear-left', cx: -20, y0: 8.5, y1: 12.5 },
    { name: 'rear-right', cx: -20, y0: -12.5, y1: -8.5 },
  ],
  radius: 5,
  centreZ: 5,
} as const;

export function truckFused(): FixtureModel {
  const body = voxelUnion([TRUCK.chassisAndBed, TRUCK.cab]);
  const parts: CanonicalMesh[] = [body];
  for (const w of TRUCK.wheels) parts.push(wheel(w.cx, TRUCK.centreZ, TRUCK.radius, w.y0, w.y1));
  return { name: 'truck-fused', mesh: concatMeshes(parts) };
}

/** The truck's bounding box: x -30..30, y -12.5..12.5, z 0..26. */
export const TRUCK_FRAME = { center: [0, 0, 13] as const, scale: 60 };

/** A cube with one face missing: an open boundary, so not a solid and not ready to split. */
export function openCube(): FixtureModel {
  const full = box([0, 0, 0], [20, 20, 20]);
  const faces = full.indices.length / 3;
  // Drop the last two triangles (the +X face).
  const keep = faces - 2;
  return {
    name: 'open-cube',
    mesh: {
      positions: full.positions.slice(0, keep * 9),
      indices: full.indices.slice(0, keep * 3),
      metadata: {},
    },
  };
}
