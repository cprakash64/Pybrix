import {
  add,
  auditEdges,
  dot,
  faceNormal,
  len,
  liveFanCount,
  liveFans,
  sub,
  type FanChain,
  type SurgeryAccept,
  type SurgeryMesh,
  type TentativeContext,
  type Vec3,
} from './surgery-mesh';
import { inspectCandidate, type SearchConfig, type MeasuredCandidate } from './pinch-search';
import type { SurfaceFidelity } from './surface-fidelity';
import type { RepairWorkMeter } from './repair-work-budget';

/**
 * REPAIR-CORE-05E — LINK RETRIANGULATION: removing a CLOSED fan from a pinched vertex.
 *
 * A closed fan is a full disk around V. Its rim (the link) is a simple cycle of m vertices, and
 * the fan is m triangles. The same disk can be covered by m - 2 triangles that use ONLY the rim's
 * own vertices — no vertex at V, no vertex added, no vertex moved. The fan then no longer touches
 * V, which is exactly what a pinch repair needs, and the rest of the mesh is not touched.
 *
 * WHY THIS IS A DIFFERENT FAMILY FROM LS-A2. LS-A2 keeps one vertex per fan and MOVES it. When the
 * neighbourhood is dense with near-degenerate faces no placement of the new apex avoids a crossing
 * (measured by an exhaustive placement probe on the refused sites); a retriangulation moves
 * nothing, so it cannot be obstructed by something it is not near.
 *
 * WHAT IT DOES NOT DO. It never fills across anything that is not a closed fan, never touches an
 * open fan (its rim is a chain, not a cycle), never adds a vertex, and every candidate must pass
 * the SAME inspection the A2 search applies (triangle quality, locality, fidelity <= 1.0 local
 * edge) and the same exact intersection gate. Orientation is preserved by construction (the
 * polygon's own order) and re-checked per triangle.
 */

/** Hard research ceiling on the rim size, so the number of triangulations stays bounded. */
export const MAX_RETRIANGULATION_LINK = 9;

/** The exact-test budget per site, equal to the A2 search's. */
export const MAX_RETRIANGULATION_EXACT = 40;

export type Triangulation = readonly (readonly [number, number, number])[];

/**
 * Every triangulation of the convex-position polygon 0..n-1 (Catalan(n - 2) of them), in a fixed
 * order: by the apex of the triangle on edge (0, n - 1), ascending, then recursively. Index
 * triples are in polygon order, so each triangle keeps the polygon's orientation.
 */
export function enumerateTriangulations(n: number): Triangulation[] {
  const memo = new Map<string, Triangulation[]>();
  const build = (i: number, j: number): Triangulation[] => {
    if (j - i < 2) return [[]];
    const key = `${String(i)},${String(j)}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const out: Triangulation[] = [];
    for (let k = i + 1; k < j; k += 1) {
      for (const left of build(i, k)) {
        for (const right of build(k, j)) {
          out.push([...left, ...right, [i, k, j]]);
        }
      }
    }
    memo.set(key, out);
    return out;
  };
  return n < 3 ? [] : build(0, n - 1);
}

export interface RetriangulationAttempt {
  readonly removed: readonly number[];
  readonly added: readonly number[];
  readonly boundary: number;
}

export interface RetriangulationPart {
  readonly fan: FanChain;
  readonly triangulation: Triangulation;
}

/**
 * What a tentative retriangulation of one OR SEVERAL closed fans of the same vertex was refused
 * for, or the attempt (mesh left installed). Several fans are installed together and judged by
 * ONE inspection and ONE exact test over the union of everything removed and added, so that two
 * disks which cross each other are seen as the crossing they are.
 */
export function tryRetriangulate(
  mesh: SurgeryMesh,
  vertex: number,
  parts: readonly RetriangulationPart[],
  accept: SurgeryAccept | undefined,
  inspect: ((context: TentativeContext) => string | undefined) | undefined,
  skipAccept = false,
): RetriangulationAttempt | string {
  const faceMark = mesh.faceCount;
  const vertexMark = mesh.vertexCount;
  const removed = parts.flatMap((p) => [...p.fan.faces]).sort((a, b) => a - b);
  const removedSet = new Set(removed);
  const fansBefore = liveFanCount(mesh, vertex);
  const before = auditEdges(mesh, removed);
  const rimFansBefore = new Map<number, number>();
  for (const part of parts) {
    for (const x of part.fan.link) rimFansBefore.set(x, liveFanCount(mesh, x));
  }
  const key = (a: number, b: number, c: number): string =>
    [a, b, c].sort((x, y) => x - y).join(',');
  const existing = new Set<string>();
  for (const x of rimFansBefore.keys()) {
    for (const g of mesh.facesAt(x)) {
      if (mesh.alive[g] !== 1 || removedSet.has(g)) continue;
      const [p, q, r] = mesh.corners(g);
      existing.add(key(p, q, r));
    }
  }
  const meanNormals = parts.map((part) => {
    let n: Vec3 = [0, 0, 0];
    for (const f of part.fan.faces) n = add(n, faceNormal(mesh, f));
    return n;
  });
  for (const f of removed) mesh.kill(f);
  const rollback = (reason: string): string => {
    for (const f of removed) mesh.revive(f);
    mesh.truncate(faceMark, vertexMark);
    return reason;
  };
  const added: number[] = [];
  const addedByPart: number[][] = [];
  for (const part of parts) {
    const mine: number[] = [];
    for (const [i, j, k] of part.triangulation) {
      const a = part.fan.link[i];
      const b = part.fan.link[j];
      const c = part.fan.link[k];
      if (a === undefined || b === undefined || c === undefined) return rollback('malformed');
      const id = mesh.addFace(a, b, c);
      mine.push(id);
      added.push(id);
    }
    addedByPart.push(mine);
  }
  // GATE 1 — nothing exactly degenerate, and nothing folded against the fan it replaces.
  for (let q = 0; q < parts.length; q += 1) {
    const mean = meanNormals[q] ?? [0, 0, 0];
    for (const f of addedByPart[q] ?? []) {
      const n = faceNormal(mesh, f);
      if (!(len(n) > 0)) return rollback('degenerate-face');
      if (!(dot(n, mean) > 0)) return rollback('flipped-face');
    }
  }
  // GATE 2 — local topology: no new boundary, non-manifold edge or winding conflict.
  const after = auditEdges(mesh, added);
  if (after.nonManifold > before.nonManifold) return rollback('new-non-manifold-edge');
  if (after.windingConflicts > before.windingConflicts) return rollback('new-winding-conflict');
  if (after.boundary !== before.boundary) return rollback('boundary-changed');
  // GATE 3 — no rim vertex gains a fan, and V loses exactly the fans that were replaced.
  for (const [x, count] of rimFansBefore) {
    if (mesh.facesAt(x).length === 0 || x === vertex) continue;
    if (liveFanCount(mesh, x) > count) return rollback('vertex-gained-fans');
  }
  if (liveFanCount(mesh, vertex) !== fansBefore - parts.length) return rollback('fan-not-removed');
  // GATE 4 — no new duplicate face.
  const own = new Set<string>();
  for (const f of added) {
    const [p, q, r] = mesh.corners(f);
    const k = key(p, q, r);
    if (existing.has(k) || own.has(k)) return rollback('new-duplicate-face');
    own.add(k);
  }
  if (inspect !== undefined) {
    const verdict = inspect({ mesh, vertex, removedFaces: removed, addedFaces: added });
    if (verdict !== undefined) return rollback(verdict);
  }
  if (accept !== undefined && !skipAccept) {
    const verdict = accept({ mesh, vertex, removedFaces: removed, addedFaces: added });
    if (verdict !== undefined) return rollback(verdict);
  }
  return { removed, added, boundary: before.boundary };
}

/** The ranking the A2 search uses, applied to retriangulation candidates. */
function compareMeasured(
  a: { fidelity: SurfaceFidelity; index: number },
  b: { fidelity: SurfaceFidelity; index: number },
): number {
  const keys: ((m: { fidelity: SurfaceFidelity }) => number)[] = [
    (m): number => m.fidelity.maxDistanceOverLocalEdge,
    (m): number => m.fidelity.p95OverLocalEdge,
    (m): number => Math.abs(m.fidelity.areaDelta),
  ];
  for (const k of keys) {
    const x = k(a);
    const y = k(b);
    const tolerance = 1e-9 * Math.max(Math.abs(x), Math.abs(y), 1e-300);
    if (Math.abs(x - y) > tolerance) return x - y;
  }
  return a.index - b.index;
}

export interface RetriangulationResult {
  /** The fans (indices into `liveFans`) that were replaced: one, or two replaced together. */
  readonly fanIndices: readonly number[];
  readonly triangulationIndices: readonly number[];
  readonly removedFaces: readonly number[];
  readonly addedFaces: readonly number[];
  readonly candidate: Pick<MeasuredCandidate, 'fidelity' | 'before' | 'after'>;
  readonly candidatesEvaluated: number;
  readonly candidatesValid: number;
  readonly exactAttempts: number;
  readonly rimSizes: readonly number[];
  readonly reasons: Readonly<Record<string, number>>;
}

export interface RetriangulationRefusal {
  readonly reasons: Readonly<Record<string, number>>;
  readonly candidatesEvaluated: number;
  readonly candidatesValid: number;
  readonly exactAttempts: number;
}

/** How many of the best single-fan candidates of each fan are combined when two fans go together. */
export const RETRIANGULATION_PAIR_WIDTH = 8;

type Measures = Pick<MeasuredCandidate, 'fidelity' | 'before' | 'after'>;

interface FanPlan {
  readonly index: number;
  readonly fan: FanChain;
  readonly triangulations: readonly Triangulation[];
  readonly valid: readonly ({ index: number } & Measures)[];
}

function medianEdge(mesh: SurgeryMesh, faces: readonly number[]): number {
  const lengths: number[] = [];
  for (const f of faces) {
    const [a, b, c] = mesh.corners(f);
    for (const [u, w] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      lengths.push(len(sub(mesh.point(u), mesh.point(w))));
    }
  }
  lengths.sort((x, y) => x - y);
  return lengths[Math.floor(lengths.length / 2)] ?? 0;
}

/**
 * Searches the closed fans of one refused site. STAGE 1 replaces ONE fan (fans in index order,
 * each fan's triangulations ranked as the A2 search ranks its candidates, the first that passes
 * the exact gate wins). STAGE 2, reached only when stage 1 found nothing, replaces TWO fans at
 * once, taking the best few single-fan candidates of each and testing the pair jointly.
 * An accepted candidate stays installed in `mesh`; on refusal the mesh is exactly as found.
 */
export function retriangulateSite(
  mesh: SurgeryMesh,
  vertex: number,
  cfg: SearchConfig,
  accept: SurgeryAccept,
  meter?: RepairWorkMeter,
): RetriangulationResult | RetriangulationRefusal {
  // The exact test is charged where it is spent; `check` is only ever called between two
  // reconstructions, where the mesh is exactly as found.
  const metered: SurgeryAccept =
    meter === undefined
      ? accept
      : (context: Parameters<SurgeryAccept>[0]): ReturnType<SurgeryAccept> => {
          meter.chargeExactTest();
          return accept(context);
        };
  const reasons = new Map<string, number>();
  const note = (r: string): void => {
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  };
  let evaluated = 0;
  let validCount = 0;
  let exact = 0;
  const found = liveFans(mesh, vertex);
  const fans = found.fans;
  const refusal = (): RetriangulationRefusal => ({
    reasons: Object.fromEntries(reasons),
    candidatesEvaluated: evaluated,
    candidatesValid: validCount,
    exactAttempts: exact,
  });
  if (found.refusal !== undefined || fans.length < 2) {
    note('no-fans');
    return refusal();
  }
  const p = mesh.point(vertex);
  const plans: FanPlan[] = [];
  for (const [fi, fan] of fans.entries()) {
    if (!fan.closed) {
      note('open-fan');
      continue;
    }
    const m = fan.link.length;
    if (m < 3 || m > MAX_RETRIANGULATION_LINK) {
      note('rim-too-large');
      continue;
    }
    const scale = medianEdge(mesh, fan.faces);
    if (!(scale > 0)) {
      note('no-scale');
      continue;
    }
    const triangulations = enumerateTriangulations(m);
    const valid: ({ index: number } & Measures)[] = [];
    triangulations.forEach((triangulation, index) => {
      meter?.check();
      meter?.chargeCandidate();
      evaluated += 1;
      const capture: { value: Measures | undefined } = { value: undefined };
      const inspect = (ctx: TentativeContext): string | undefined => {
        const verdict = inspectCandidate(ctx, cfg, p, scale);
        if (typeof verdict === 'string') return verdict;
        capture.value = verdict;
        return undefined;
      };
      const r = tryRetriangulate(mesh, vertex, [{ fan, triangulation }], undefined, inspect, true);
      if (typeof r === 'string') {
        note(r);
        return;
      }
      // Dry run: undo the install.
      for (const f of r.added) mesh.kill(f);
      for (const f of r.removed) mesh.revive(f);
      mesh.truncate(mesh.faceCount - r.added.length, mesh.vertexCount);
      if (capture.value !== undefined) valid.push({ index, ...capture.value });
    });
    validCount += valid.length;
    valid.sort(compareMeasured);
    plans.push({ index: fi, fan, triangulations, valid });
  }
  // STAGE 1: one fan.
  for (const plan of plans) {
    for (const candidate of plan.valid) {
      if (exact >= MAX_RETRIANGULATION_EXACT) break;
      meter?.check();
      meter?.chargeCandidate();
      exact += 1;
      const triangulation = plan.triangulations[candidate.index];
      if (triangulation === undefined) continue;
      const r = tryRetriangulate(
        mesh,
        vertex,
        [{ fan: plan.fan, triangulation }],
        metered,
        undefined,
      );
      if (typeof r === 'string') {
        note(r);
        continue;
      }
      return {
        fanIndices: [plan.index],
        triangulationIndices: [candidate.index],
        removedFaces: r.removed,
        addedFaces: r.added,
        candidate: {
          fidelity: candidate.fidelity,
          before: candidate.before,
          after: candidate.after,
        },
        candidatesEvaluated: evaluated,
        candidatesValid: validCount,
        exactAttempts: exact,
        rimSizes: [plan.fan.link.length],
        reasons: Object.fromEntries(reasons),
      };
    }
  }
  // STAGE 2: two fans together.
  for (let x = 0; x < plans.length; x += 1) {
    for (let y = x + 1; y < plans.length; y += 1) {
      const a = plans[x];
      const b = plans[y];
      if (a === undefined || b === undefined) continue;
      const scale = medianEdge(mesh, [...a.fan.faces, ...b.fan.faces]);
      const combos: { i: number; j: number; rank: number }[] = [];
      const ta = a.valid.slice(0, RETRIANGULATION_PAIR_WIDTH);
      const tb = b.valid.slice(0, RETRIANGULATION_PAIR_WIDTH);
      ta.forEach((ca, i) => {
        tb.forEach((cb, j) => {
          combos.push({
            i,
            j,
            rank: Math.max(
              ca.fidelity.maxDistanceOverLocalEdge,
              cb.fidelity.maxDistanceOverLocalEdge,
            ),
          });
        });
      });
      combos.sort((u, v) => u.rank - v.rank || u.i + u.j - (v.i + v.j) || u.i - v.i);
      for (const combo of combos) {
        if (exact >= MAX_RETRIANGULATION_EXACT) break;
        const ca = ta[combo.i];
        const cb = tb[combo.j];
        const tria = ca === undefined ? undefined : a.triangulations[ca.index];
        const trib = cb === undefined ? undefined : b.triangulations[cb.index];
        if (ca === undefined || cb === undefined || tria === undefined || trib === undefined) {
          continue;
        }
        meter?.check();
        meter?.chargeCandidate();
        evaluated += 1;
        const capture: { value: Measures | undefined } = { value: undefined };
        const inspect = (ctx: TentativeContext): string | undefined => {
          const verdict = inspectCandidate(ctx, cfg, p, scale);
          if (typeof verdict === 'string') return verdict;
          capture.value = verdict;
          return undefined;
        };
        // The exact test is only spent on a pair that already passed the inspection.
        const dry = tryRetriangulate(
          mesh,
          vertex,
          [
            { fan: a.fan, triangulation: tria },
            { fan: b.fan, triangulation: trib },
          ],
          undefined,
          inspect,
          true,
        );
        if (typeof dry === 'string') {
          note(dry);
          continue;
        }
        for (const f of dry.added) mesh.kill(f);
        for (const f of dry.removed) mesh.revive(f);
        mesh.truncate(mesh.faceCount - dry.added.length, mesh.vertexCount);
        const measured = capture.value;
        if (measured === undefined) {
          // The inspection said "pass" without measuring: never spend the exact test on that.
          note('internal-no-measure');
          continue;
        }
        validCount += 1;
        meter?.check();
        meter?.chargeCandidate();
        exact += 1;
        const r = tryRetriangulate(
          mesh,
          vertex,
          [
            { fan: a.fan, triangulation: tria },
            { fan: b.fan, triangulation: trib },
          ],
          metered,
          undefined,
        );
        if (typeof r === 'string') {
          note(r);
          continue;
        }
        return {
          fanIndices: [a.index, b.index],
          triangulationIndices: [ca.index, cb.index],
          removedFaces: r.removed,
          addedFaces: r.added,
          candidate: measured,
          candidatesEvaluated: evaluated,
          candidatesValid: validCount,
          exactAttempts: exact,
          rimSizes: [a.fan.link.length, b.fan.link.length],
          reasons: Object.fromEntries(reasons),
        };
      }
    }
  }
  return refusal();
}
