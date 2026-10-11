import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { required } from '../required';
import { TRUCK } from './models';
import { voxelUnion, wheel } from './solids';

/**
 * DENSE TEST VEHICLES: the reference truck (one fused cab-and-bed shell and four separate wheels),
 * refined to a requested triangle count, deterministically.
 *
 * Built by uniform midpoint subdivision, which keeps the surface a closed manifold and the same
 * SHAPE at every size, so a result at 500 thousand and at two million triangles describes the same
 * truck. Shared edges get bit-identical midpoints (the midpoint is rounded to Float32 once, from the
 * same two operands in either direction), so refinement never opens a seam. Nothing here is a
 * product path: it generates inputs for the large-mesh tests and benchmarks and nothing imports it
 * from production code.
 */
type Soup = Float32Array; // nine floats per triangle

function soupOf(mesh: CanonicalMesh): Soup {
  const n = Math.floor(mesh.indices.length / 3);
  const out = new Float32Array(n * 9);
  for (let f = 0; f < n; f += 1)
    for (let k = 0; k < 3; k += 1) {
      const v = (mesh.indices[f * 3 + k] ?? 0) * 3;
      out[f * 9 + k * 3] = mesh.positions[v] ?? 0;
      out[f * 9 + k * 3 + 1] = mesh.positions[v + 1] ?? 0;
      out[f * 9 + k * 3 + 2] = mesh.positions[v + 2] ?? 0;
    }
  return out;
}

/** One level of midpoint subdivision, winding preserved: one triangle becomes four. */
function subdivide(s: Soup): Soup {
  const n = s.length / 9;
  const out = new Float32Array(n * 36);
  const mid = (a: number, b: number): number => Math.fround((a + b) / 2);
  let w = 0;
  const put = (x: number, y: number, z: number): void => {
    out[w] = x;
    out[w + 1] = y;
    out[w + 2] = z;
    w += 3;
  };
  for (let t = 0; t < n; t += 1) {
    const o = t * 9;
    const ax = s[o] ?? 0,
      ay = s[o + 1] ?? 0,
      az = s[o + 2] ?? 0;
    const bx = s[o + 3] ?? 0,
      by = s[o + 4] ?? 0,
      bz = s[o + 5] ?? 0;
    const cx = s[o + 6] ?? 0,
      cy = s[o + 7] ?? 0,
      cz = s[o + 8] ?? 0;
    const abx = mid(ax, bx),
      aby = mid(ay, by),
      abz = mid(az, bz);
    const bcx = mid(bx, cx),
      bcy = mid(by, cy),
      bcz = mid(bz, cz);
    const cax = mid(cx, ax),
      cay = mid(cy, ay),
      caz = mid(cz, az);
    put(ax, ay, az);
    put(abx, aby, abz);
    put(cax, cay, caz);
    put(abx, aby, abz);
    put(bx, by, bz);
    put(bcx, bcy, bcz);
    put(cax, cay, caz);
    put(bcx, bcy, bcz);
    put(cx, cy, cz);
    put(abx, aby, abz);
    put(bcx, bcy, bcz);
    put(cax, cay, caz);
  }
  return out;
}

function level(s: Soup, k: number): Soup {
  let r = s;
  for (let i = 0; i < k; i += 1) r = subdivide(r);
  return r;
}

/**
 * Replaces `count` triangles, taken from the START of the soup, each by three that share its centroid
 * (1 to 3, so +2 triangles apiece). The three outer edges are the original's, so the surface stays a
 * closed manifold and the shape does not move; this is how a refinement lands on an EXACT count
 * instead of the nearest power of four.
 */
function centroidSplit(s: Soup, count: number): Soup {
  const n = s.length / 9;
  if (count > n) throw new RangeError('Cannot split more triangles than the mesh has.');
  const out = new Float32Array(s.length + count * 18);
  let w = 0;
  const put = (x: number, y: number, z: number): void => {
    out[w] = x;
    out[w + 1] = y;
    out[w + 2] = z;
    w += 3;
  };
  for (let t = 0; t < n; t += 1) {
    const o = t * 9;
    const ax = s[o] ?? 0,
      ay = s[o + 1] ?? 0,
      az = s[o + 2] ?? 0;
    const bx = s[o + 3] ?? 0,
      by = s[o + 4] ?? 0,
      bz = s[o + 5] ?? 0;
    const cx = s[o + 6] ?? 0,
      cy = s[o + 7] ?? 0,
      cz = s[o + 8] ?? 0;
    if (t >= count) {
      put(ax, ay, az);
      put(bx, by, bz);
      put(cx, cy, cz);
      continue;
    }
    const gx = Math.fround((ax + bx + cx) / 3),
      gy = Math.fround((ay + by + cy) / 3),
      gz = Math.fround((az + bz + cz) / 3);
    put(ax, ay, az);
    put(bx, by, bz);
    put(gx, gy, gz);
    put(bx, by, bz);
    put(cx, cy, cz);
    put(gx, gy, gz);
    put(cx, cy, cz);
    put(ax, ay, az);
    put(gx, gy, gz);
  }
  return out;
}

function meshFromSoup(soup: Soup): CanonicalMesh {
  const n = soup.length / 9;
  const indices = createIndexArray(n * 3);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  const positions = createPositionArray(soup.length);
  positions.set(soup);
  return { positions, indices, metadata: {} };
}

function concat(parts: readonly Soup[]): Soup {
  const merged = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    merged.set(p, at);
    at += p.length;
  }
  return merged;
}

interface Plan {
  readonly bodyLevel: number;
  readonly wheelLevels: readonly number[];
  readonly triangles: number;
}

/** The levels whose total triangle count is nearest `target` without exceeding it when possible. */
function planFor(target: number, bodyTris: number, wheelTris: readonly number[]): Plan {
  let best: (Plan & { err: number }) | undefined;
  for (let a = 0; a <= 9; a += 1)
    for (let b0 = 0; b0 <= 9; b0 += 1)
      for (let b1 = 0; b1 <= 9; b1 += 1)
        for (let b2 = 0; b2 <= 9; b2 += 1)
          for (let b3 = 0; b3 <= 9; b3 += 1) {
            const levels = [b0, b1, b2, b3];
            const count =
              bodyTris * 4 ** a +
              levels.reduce((sum, b, i) => sum + (wheelTris[i] ?? 0) * 4 ** b, 0);
            if (count > target) continue;
            const err = target - count;
            if (best === undefined || err < best.err)
              best = { bodyLevel: a, wheelLevels: levels, triangles: count, err };
          }
  return required(best, 'a refinement plan at or below the target');
}

function baseTruck(): { body: Soup; wheels: Soup[] } {
  return {
    body: soupOf(voxelUnion([TRUCK.chassisAndBed, TRUCK.cab])),
    wheels: TRUCK.wheels.map((w) => soupOf(wheel(w.cx, TRUCK.centreZ, TRUCK.radius, w.y0, w.y1))),
  };
}

/**
 * The reference truck refined to the closest count AT OR BELOW `target` that uniform subdivision
 * reaches, then padded by centroid splits of the body to land on `target` exactly. A closed manifold
 * has an even triangle count, so an odd `target` is reached by adding ONE detached triangle to the
 * count below it: that mesh is exactly `target` triangles and is not a closed solid, which is all a
 * size boundary needs to prove.
 */
export function denseTruck(target: number): { mesh: CanonicalMesh; plan: string } {
  const { body, wheels } = baseTruck();
  const even = target % 2 === 0 ? target : target - 1;
  const plan = planFor(
    even,
    body.length / 9,
    wheels.map((w) => w.length / 9),
  );
  let bodySoup = level(body, plan.bodyLevel);
  const pad = (even - plan.triangles) / 2;
  if (pad > 0) bodySoup = centroidSplit(bodySoup, pad);
  const parts: Soup[] = [bodySoup, ...wheels.map((w, i) => level(w, plan.wheelLevels[i] ?? 0))];
  if (target % 2 === 1) parts.push(Float32Array.of(40, 40, 40, 41, 40, 40, 40, 41, 40));
  return {
    mesh: meshFromSoup(concat(parts)),
    plan: `body x4^${String(plan.bodyLevel)} + ${String(Math.max(0, pad))} centroid splits; wheels x4^${plan.wheelLevels.join('/')}`,
  };
}

/**
 * The same truck with `shells` extra small closed boxes floating in free space above the bed (the cab
 * is at +X; nothing else occupies that air), so the part has `5 + shells` components and the same
 * bounding box, and therefore the same normalized frame, as the plain truck. The truck itself is
 * refined so the total lands near `target`.
 */
export function manyShellTruck(
  target: number,
  shells: number,
): { mesh: CanonicalMesh; plan: string } {
  if (!Number.isSafeInteger(shells) || shells < 0 || shells > 5_000)
    throw new RangeError('The air above the bed holds between 0 and 5,000 boxes.');
  const dense = denseTruck(Math.max(12, target - shells * 12));
  const boxes: Soup[] = [];
  let placed = 0;
  // A lattice of 0.4-unit boxes, one every unit: x -29..9, y -7..7, z 15..24 (the bed top is z = 14).
  for (let z = 15; z <= 24 && placed < shells; z += 1)
    for (let y = -7; y <= 7 && placed < shells; y += 1)
      for (let x = -29; x <= 9 && placed < shells; x += 1) {
        boxes.push(unitBox(x, y, z, 0.4));
        placed += 1;
      }
  return {
    mesh: meshFromSoup(concat([soupOf(dense.mesh), ...boxes])),
    plan: `${dense.plan}; ${String(shells)} floating boxes`,
  };
}

/** A closed axis-aligned box of 12 outward triangles. */
function unitBox(x: number, y: number, z: number, size: number): Soup {
  const [x0, y0, z0] = [x, y, z].map(Math.fround) as [number, number, number];
  const [x1, y1, z1] = [x + size, y + size, z + size].map(Math.fround) as [number, number, number];
  const quads: readonly (readonly [number, number, number][])[] = [
    [
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y0, z0],
    ],
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
    ],
    [
      [x0, y1, z0],
      [x0, y1, z1],
      [x1, y1, z1],
      [x1, y1, z0],
    ],
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ],
    [
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x1, y0, z1],
    ],
  ];
  const out: number[] = [];
  for (const q of quads) {
    const [a, b, c, d] = q as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return Float32Array.from(out);
}
