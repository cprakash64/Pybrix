import type { RepairWorkMeter } from './repair-work-budget';
import type { SurgeryMesh } from './surgery-mesh';

/**
 * REPAIR-CORE-05E — COMPONENT-RELATIVE WINDING RESOLUTION for a refused oriented-chain site.
 *
 * THE DEADLOCK THIS RESOLVES. The pinch surgery refuses a vertex whose fan is "not one
 * consistently oriented chain": two faces around it traverse a shared edge the SAME way. The
 * product's relative winding unification would fix that — but it refuses any mesh with a
 * non-manifold vertex, and the vertex being repaired IS one. Each operation waits for the other.
 *
 * WHY IT IS SAFE TO WAIVE THE VERTEX PRECONDITION HERE. Orientation consistency is a constraint
 * on EDGES: every edge shared by exactly two faces must be traversed in opposite directions. A
 * pinched vertex adds no such constraint, so the parity system, and therefore its solution set,
 * is the same with or without it. The solver below is `solveWinding`'s algorithm: two-colour the
 * face graph over ordinary (two-face) edges, seed = lowest face of the edge-connected component,
 * so the answer is deterministic and RELATIVE (it claims nothing about which side is outside).
 *
 * WHAT IS REFUSED, so this never becomes a global re-orientation:
 *  - a NON-ORIENTABLE component (two paths demand opposite parity): no choice is made;
 *  - a solution that flips MORE than half of the component, or more than `maxFlips` faces:
 *    the seed rule would then invert most of a shell, and that is a decision about the model,
 *    not a repair of a vertex.
 * Flipping a face reverses its winding only: no vertex moves, no face is added or removed.
 */
export const DEFAULT_MAX_WINDING_FLIPS = 1024;

export type WindingResolutionOutcome =
  'resolved' | 'already-consistent' | 'non-orientable' | 'flips-not-a-small-minority';

export interface WindingResolution {
  readonly outcome: WindingResolutionOutcome;
  readonly componentFaces: number;
  readonly seedFace: number;
  /** Faces whose winding the resolution reverses (empty unless `resolved`). */
  readonly flips: readonly number[];
}

/** Ordinary-edge neighbours of `face`: [other face, parity demanded]. Parity 1 = currently conflicting. */
function neighbours(mesh: SurgeryMesh, face: number): [number, number][] {
  const out: [number, number][] = [];
  const [a, b, c] = mesh.corners(face);
  for (const [u, w] of [
    [a, b],
    [b, c],
    [c, a],
  ] as const) {
    const others: { face: number; forward: boolean }[] = [];
    for (const g of mesh.facesAt(u)) {
      if (g === face || mesh.alive[g] !== 1) continue;
      const [x, y, z] = mesh.corners(g);
      for (const [p, q] of [
        [x, y],
        [y, z],
        [z, x],
      ] as const) {
        if (p === u && q === w) others.push({ face: g, forward: true });
        else if (p === w && q === u) others.push({ face: g, forward: false });
      }
    }
    // Total faces on the edge = this one + the others; only exactly-two-face edges constrain.
    if (others.length !== 1) continue;
    const other = others[0];
    if (other === undefined) continue;
    out.push([other.face, other.forward ? 1 : 0]);
  }
  return out;
}

export function resolveComponentWinding(
  mesh: SurgeryMesh,
  startFace: number,
  maxFlips: number = DEFAULT_MAX_WINDING_FLIPS,
  meter?: RepairWorkMeter,
): WindingResolution {
  // A SAFE POINT: nothing has been touched yet. The traversal itself reads and never writes.
  meter?.check();
  // Pass 1: the edge-connected component and its lowest face (the seed).
  const component = new Set<number>([startFace]);
  // A queue that grows while it is walked: `for...of` over an array visits appended items too.
  const queue = [startFace];
  for (const f of queue) {
    for (const [g] of neighbours(mesh, f)) {
      if (!component.has(g)) {
        component.add(g);
        queue.push(g);
      }
    }
  }
  meter?.chargeWindingFaces(component.size);
  let seed = startFace;
  for (const f of component) if (f < seed) seed = f;
  // Pass 2: two-colour from the seed.
  const flip = new Map<number, 0 | 1>([[seed, 0]]);
  const order = [seed];
  let contradiction = false;
  for (const f of order) {
    for (const [g, parity] of neighbours(mesh, f)) {
      const want = ((flip.get(f) ?? 0) ^ parity) as 0 | 1;
      const have = flip.get(g);
      if (have === undefined) {
        flip.set(g, want);
        order.push(g);
      } else if (have !== want) contradiction = true;
    }
  }
  meter?.chargeWindingFaces(order.length);
  const base = { componentFaces: component.size, seedFace: seed };
  if (contradiction) return { outcome: 'non-orientable', ...base, flips: [] };
  const flips = order.filter((f) => flip.get(f) === 1).sort((a, b) => a - b);
  if (flips.length === 0) return { outcome: 'already-consistent', ...base, flips: [] };
  if (flips.length > maxFlips || flips.length * 2 >= component.size) {
    return { outcome: 'flips-not-a-small-minority', ...base, flips };
  }
  return { outcome: 'resolved', ...base, flips };
}
