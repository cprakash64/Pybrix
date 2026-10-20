import {
  cameraFor,
  FRAME_FILL,
  VIEW_NAMES,
  type SemanticPart,
  type Vec3,
} from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import { pointInSemanticPolygon } from './semantic';
import type { Checkpoint } from './checkpoint';
import type { NormalizedGeometry } from './geometry';

/** Fixed perimeter observations, not a dense candidate or source-face search.
 * Only three source-frame directions and compact extrema survive collection. */
export const GROUNDED_BOUNDARY_LIMITS = Object.freeze({
  samplesPerView: 4096,
  directions: 3,
  neighbors: 1,
  minimumPixels: 8,
  maximumAxialFaceAlignment: 0.5,
  capSamplesPerView: 4096,
});
export function groundedSourceFaceNormal(
  geometry: NormalizedGeometry,
  face: number,
): { vector: Vec3; length: number } {
  const a = (geometry.indices[face * 3] ?? 0) * 3,
    b = (geometry.indices[face * 3 + 1] ?? 0) * 3,
    c = (geometry.indices[face * 3 + 2] ?? 0) * 3;
  const edge = (i: number, axis: number): number =>
    (geometry.positions[i + axis] ?? 0) - (geometry.positions[a + axis] ?? 0);
  const u: Vec3 = [edge(b, 0), edge(b, 1), edge(b, 2)],
    v: Vec3 = [edge(c, 0), edge(c, 1), edge(c, 2)];
  const vector: Vec3 = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  return { vector, length: Math.hypot(...vector) };
}
export interface GroundedBoundaryWitness {
  readonly normal: Vec3;
  readonly low: number;
  readonly high: number;
  readonly observedAxes: readonly number[];
  readonly viewPixels: readonly number[];
  readonly pixelVisits: number;
  readonly excludedLowCapAxes?: readonly number[];
  readonly excludedHighCapAxes?: readonly number[];
}
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function collectGroundedBoundaryWitnesses(
  prepared: PreparedSemanticGeometry,
  part: SemanticPart,
  frame: readonly Vec3[],
  checkpoint: Checkpoint,
  charge: () => void,
): readonly GroundedBoundaryWitness[] {
  const directions = frame.slice(0, GROUNDED_BOUNDARY_LIMITS.directions);
  const rows = directions.map(() =>
    Array.from({ length: 6 }, () => ({ low: Infinity, high: -Infinity, pixels: 0 })),
  );
  const seen = new Uint8Array(Math.max(0, ...prepared.rasters.map((r) => r.face.length)));
  let pixelVisits = 0;
  for (const [vi, view] of VIEW_NAMES.entries()) {
    checkpoint();
    const region = part.views.find((v) => v.view === view),
      raster = prepared.rasters[vi];
    if (!region || !raster) continue;
    const edges = region.polygons
      .flatMap((polygon) =>
        polygon.map((p, i) => {
          const q = polygon[(i + 1) % polygon.length] ?? p;
          return { p, q, length: Math.hypot(q[0] - p[0], q[1] - p[1]) * raster.size };
        }),
      )
      .filter((edge) => edge.length > 0);
    const perimeter = edges.reduce((sum, e) => sum + e.length, 0);
    const samples = Math.min(GROUNDED_BOUNDARY_LIMITS.samplesPerView, Math.ceil(perimeter));
    const camera = cameraFor(view),
      k = (raster.size * FRAME_FILL) / (2 * prepared.geometry.radius);
    let edgeIndex = 0,
      start = 0;
    for (let s = 0; s < samples; s++) {
      if ((s & 63) === 0) checkpoint();
      const distance = ((s + 0.5) * perimeter) / samples;
      while (edgeIndex + 1 < edges.length && distance > start + (edges[edgeIndex]?.length ?? 0)) {
        start += edges[edgeIndex]?.length ?? 0;
        edgeIndex++;
      }
      const edge = edges[edgeIndex];
      if (!edge) continue;
      const t = (distance - start) / edge.length;
      const px = Math.floor((edge.p[0] + t * (edge.q[0] - edge.p[0])) * raster.size),
        py = Math.floor((edge.p[1] + t * (edge.q[1] - edge.p[1])) * raster.size);
      for (
        let dy = -GROUNDED_BOUNDARY_LIMITS.neighbors;
        dy <= GROUNDED_BOUNDARY_LIMITS.neighbors;
        dy++
      )
        for (
          let dx = -GROUNDED_BOUNDARY_LIMITS.neighbors;
          dx <= GROUNDED_BOUNDARY_LIMITS.neighbors;
          dx++
        ) {
          charge();
          pixelVisits++;
          const x = px + dx,
            y = py + dy;
          if (x < 0 || y < 0 || x >= raster.size || y >= raster.size) continue;
          const pixel = y * raster.size + x;
          if (seen[pixel] === vi + 1) continue;
          seen[pixel] = vi + 1;
          const depth = raster.depth?.[pixel];
          if (
            (raster.face[pixel] ?? -1) < 0 ||
            depth === undefined ||
            !Number.isFinite(depth) ||
            !region.polygons.some((poly) =>
              pointInSemanticPolygon((x + 0.5) / raster.size, (y + 0.5) / raster.size, poly),
            )
          )
            continue;
          const u = (x + 0.5 - raster.size / 2) / k,
            w = -(y + 0.5 - raster.size / 2) / k;
          const coordinate = (a: number): number =>
            (camera.right[a] ?? 0) * u + (camera.up[a] ?? 0) * w + (camera.forward[a] ?? 0) * depth;
          const point: Vec3 = [coordinate(0), coordinate(1), coordinate(2)];
          const face = groundedSourceFaceNormal(prepared.geometry, raster.face[pixel] ?? -1);
          if (!(face.length > 0)) continue;
          for (const [i, normal] of directions.entries()) {
            // End caps can project inside a semantic silhouette even when the
            // requested boundary lies beyond them. Longitudinal source faces
            // locate that boundary; the cap itself cannot corroborate ownership.
            if (
              Math.abs(dot(face.vector, normal)) / face.length >
              GROUNDED_BOUNDARY_LIMITS.maximumAxialFaceAlignment
            )
              continue;
            const row = rows[i]?.[vi];
            if (!row) continue;
            const value = dot(point, normal);
            row.low = Math.min(row.low, value);
            row.high = Math.max(row.high, value);
            row.pixels++;
          }
        }
    }
  }
  checkpoint();
  const witnesses = directions.flatMap((normal, i) => {
    const views = rows[i] ?? [];
    const axes = [0, 1, 2].flatMap((axis) => {
      const observed = views
        .slice(axis * 2, axis * 2 + 2)
        .filter((r) => r.pixels >= GROUNDED_BOUNDARY_LIMITS.minimumPixels);
      return observed.length
        ? [
            {
              axis,
              low: Math.min(...observed.map((r) => r.low)),
              high: Math.max(...observed.map((r) => r.high)),
            },
          ]
        : [];
    });
    if (axes.length < 2) return [];
    const lows = axes.map((r) => r.low).sort((a, b) => a - b),
      highs = axes.map((r) => r.high).sort((a, b) => a - b);
    return [
      {
        normal,
        low: lows[1] ?? 0,
        high: highs[highs.length - 2] ?? 0,
        observedAxes: axes.map((r) => r.axis),
        viewPixels: views.map((r) => r.pixels),
        pixelVisits,
      },
    ];
  });
  const uncertainty =
    (2 * prepared.geometry.radius) / ((prepared.rasters[0]?.size ?? 512) * FRAME_FILL);
  // An annotation may omit interior source. Only a source end face at the
  // observed frontier, visibly outside the target on two independent axes,
  // resolves the boundary uncertainty toward the interior.
  const result = witnesses.map((witness) => {
    const capRows = Array.from({ length: 2 }, () =>
      Array.from({ length: 6 }, () => ({ total: 0, target: 0, extent: 0 })),
    );
    for (const [vi, raster] of prepared.rasters.entries()) {
      const camera = cameraFor(VIEW_NAMES[vi] ?? 'front'),
        region = part.views.find((v) => v.view === VIEW_NAMES[vi]);
      const k = (raster.size * FRAME_FILL) / (2 * prepared.geometry.radius);
      const grid = Math.ceil(Math.sqrt(GROUNDED_BOUNDARY_LIMITS.capSamplesPerView));
      for (let sample = 0; sample < GROUNDED_BOUNDARY_LIMITS.capSamplesPerView; sample++) {
        if ((sample & 63) === 0) checkpoint();
        const sx = Math.floor((((sample % grid) + 0.5) * raster.size) / grid);
        const sy = Math.floor(((Math.floor(sample / grid) + 0.5) * raster.size) / grid);
        const pixel = sy * raster.size + sx;
        charge();
        const faceIndex = raster.face[pixel] ?? -1,
          depth = raster.depth?.[pixel];
        if (faceIndex < 0 || depth === undefined || !Number.isFinite(depth)) continue;
        const face = groundedSourceFaceNormal(prepared.geometry, faceIndex);
        if (!(face.length > 0)) continue;
        const alignment = dot(face.vector, witness.normal) / face.length;
        if (Math.abs(alignment) < 0.9) continue;
        const side = alignment < 0 ? 0 : 1;
        const x = (pixel % raster.size) + 0.5,
          y = Math.floor(pixel / raster.size) + 0.5;
        const u = (x - raster.size / 2) / k,
          v = -(y - raster.size / 2) / k;
        const point: Vec3 = [
          camera.right[0] * u + camera.up[0] * v + camera.forward[0] * depth,
          camera.right[1] * u + camera.up[1] * v + camera.forward[1] * depth,
          camera.right[2] * u + camera.up[2] * v + camera.forward[2] * depth,
        ];
        const extent = dot(point, witness.normal),
          frontier = side === 0 ? witness.low : witness.high;
        if (Math.abs(extent - frontier) > uncertainty * 2) continue;
        const row = capRows[side]?.[vi];
        if (!row) continue;
        row.total++;
        row.extent += extent;
        if (
          region?.polygons.some((poly) =>
            pointInSemanticPolygon(x / raster.size, y / raster.size, poly),
          )
        )
          row.target++;
      }
    }
    const excluded = capRows.map((rows) =>
      rows.flatMap((row, vi) =>
        row.total >= GROUNDED_BOUNDARY_LIMITS.minimumPixels && row.target / row.total <= 0.1
          ? [{ axis: Math.floor(vi / 2), extent: row.extent / row.total }]
          : [],
      ),
    );
    const low = excluded[0] ?? [],
      high = excluded[1] ?? [];
    const lowAxes = [...new Set(low.map((r) => r.axis))],
      highAxes = [...new Set(high.map((r) => r.axis))];
    return {
      ...witness,
      low:
        lowAxes.length >= 2
          ? Math.max(witness.low, ...low.map((r) => r.extent + 2 * uncertainty))
          : witness.low,
      high:
        highAxes.length >= 2
          ? Math.min(witness.high, ...high.map((r) => r.extent - 2 * uncertainty))
          : witness.high,
      excludedLowCapAxes: lowAxes,
      excludedHighCapAxes: highAxes,
    };
  });
  checkpoint();
  return result;
}
export function groundedBoundaryForNormal(
  witnesses: readonly GroundedBoundaryWitness[],
  normal: Vec3,
): GroundedBoundaryWitness | undefined {
  const witness = witnesses.find((w) => Math.abs(dot(w.normal, normal)) >= 1 - 1e-7);
  if (!witness) return undefined;
  return dot(witness.normal, normal) >= 0
    ? { ...witness, normal }
    : {
        ...witness,
        normal,
        low: -witness.high,
        high: -witness.low,
        excludedLowCapAxes: witness.excludedHighCapAxes ?? [],
        excludedHighCapAxes: witness.excludedLowCapAxes ?? [],
      };
}
