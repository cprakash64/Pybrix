import { required } from './required';
import type { Vec3 } from '@cadfixer/auto-split-contract';
import type { NormalizedGeometry } from './geometry';
import type { Checkpoint } from './checkpoint';
import { SEMANTIC_PLANE_REFINEMENT_LIMITS } from './semantic-plane';
/** Five sparse section probes rank at most eight already scope-supported entries.
 * They never admit a seam or move a plane. Full nine-section refinement still
 * decides admission for at most three finalists. Fixed block sampling avoids
 * always selecting the same triangle of a triangulated surface pair. */
export function probePeerlessSections(
  geometry: NormalizedGeometry,
  cuts: readonly {
    normal: Vec3;
    offset: number;
  }[],
  faceLimit: number,
  checkpoint: Checkpoint,
): {
  profiles: readonly {
    lengths: readonly number[];
    contrast: number;
  }[];
  triangleVisits: number;
  projectionVisits: number;
} {
  if (cuts.length > 8 || faceLimit < 2) throw Error('Invalid bounded peerless section probe.');
  const profiles = cuts.map(() => [0, 0, 0, 0, 0]);
  if (cuts.length === 0) return { profiles: [], triangleVisits: 0, projectionVisits: 0 };
  const relevant = new Uint32Array(cuts.length),
    seen = new Uint32Array(cuts.length);
  let triangleVisits = 0,
    projectionVisits = 0;
  // Count only faces intersecting each local probe band. This streaming prepass
  // needs no face-index reservoir, and avoids spending a small sample budget on
  // distant source surfaces that cannot contribute to any requested section.
  for (let pass = 0; pass < 2; pass++)
    for (let face = 0; face < geometry.faceCount; face++) {
      if ((face & 255) === 0) checkpoint();
      const va = (geometry.indices[face * 3] ?? 0) * 3,
        vb = (geometry.indices[face * 3 + 1] ?? 0) * 3,
        vc = (geometry.indices[face * 3 + 2] ?? 0) * 3;
      for (const [index, cut] of cuts.entries()) {
        projectionVisits++;
        const depth = (v: number): number =>
          cut.normal[0] * (geometry.positions[v] ?? 0) +
          cut.normal[1] * (geometry.positions[v + 1] ?? 0) +
          cut.normal[2] * (geometry.positions[v + 2] ?? 0) -
          cut.offset;
        const da = depth(va),
          db = depth(vb),
          dc = depth(vc),
          low = Math.min(da, db, dc),
          high = Math.max(da, db, dc);
        if (
          low >= SEMANTIC_PLANE_REFINEMENT_LIMITS.band ||
          high <= -SEMANTIC_PLANE_REFINEMENT_LIMITS.band
        )
          continue;
        if (pass === 0) {
          relevant[index] = (relevant[index] ?? 0) + 1;
          continue;
        }
        const rank = seen[index] ?? 0;
        seen[index] = rank + 1;
        const pair = Math.floor(rank / 2),
          pairs = Math.ceil((relevant[index] ?? 0) / 2),
          strata = Math.min(pairs, Math.floor(faceLimit / 2)),
          stratum = Math.floor((pair * strata) / pairs),
          start = Math.ceil((stratum * pairs) / strata),
          end = Math.ceil(((stratum + 1) * pairs) / strata);
        let hash = stratum + 1;
        hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
        hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
        hash ^= hash >>> 16;
        if (pair !== start + ((hash >>> 0) % (end - start))) continue;
        triangleVisits++;
        const vertices = [va, vb, vc],
          distances = [da, db, dc];
        for (let sample = 0; sample < 5; sample++) {
          const delta = ((sample - 2) * SEMANTIC_PLANE_REFINEMENT_LIMITS.band) / 2;
          if (low >= delta || high <= delta) continue;
          let first: number[] | undefined;
          for (let edge = 0; edge < 3; edge++) {
            const next = (edge + 1) % 3,
              a = (distances[edge] ?? 0) - delta,
              b = (distances[next] ?? 0) - delta;
            if (a >= 0 === b >= 0) continue;
            const x = vertices[edge] ?? 0,
              y = vertices[next] ?? 0,
              t = a / (a - b);
            const point = [0, 1, 2].map(
              (axis) =>
                (geometry.positions[x + axis] ?? 0) +
                t * ((geometry.positions[y + axis] ?? 0) - (geometry.positions[x + axis] ?? 0)),
            );
            if (!first) first = point;
            else {
              const row = required(profiles[index], 'bounded peerless evidence');
              row[sample] =
                (row[sample] ?? 0) +
                (end - start) * Math.hypot(...point.map((v, i) => v - (first?.[i] ?? 0)));
              break;
            }
          }
        }
      }
    }
  return {
    profiles: profiles.map((lengths) => {
      // Ranking only: a localized change should dominate residual variation,
      // whereas a smooth oblique slice spreads its change across the interval.
      const positive = lengths.filter((x) => x > 1e-8);
      let dominant = 0,
        total = 0,
        split = 0;
      for (let i = 1; i < lengths.length; i++) {
        const a = lengths[i - 1] ?? 0,
          b = lengths[i] ?? 0;
        if (a <= 1e-8 || b <= 1e-8) continue;
        const step = Math.abs(a - b);
        total += step;
        if (step > dominant) {
          dominant = step;
          split = i;
        }
      }
      const before = lengths[split - 1] ?? 0,
        after = lengths[split] ?? 0;
      const step =
        split >= 1 && lengths.length - split >= 1
          ? Math.max(0, dominant - (total - dominant)) / Math.max(before, after, 1e-8)
          : 0;
      const center = lengths[2] ?? 0,
        left = lengths[0] ?? 0,
        right = lengths[4] ?? 0;
      const neck =
        center > 1e-8 && positive.length >= 3
          ? Math.max(
              0,
              Math.min(
                (left - center) / Math.max(left, 1e-8),
                (right - center) / Math.max(right, 1e-8),
              ),
            )
          : 0;
      return { lengths, contrast: Math.max(step, neck) };
    }),
    triangleVisits,
    projectionVisits,
  };
}
