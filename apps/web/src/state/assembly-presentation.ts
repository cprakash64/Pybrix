import type {
  DocumentHandle,
  PartDescriptor,
  SplitCommitResult,
  SplitCreateResult,
  SplitPlane,
} from '@cadfixer/geometry-runtime';
import type { MeshBounds } from '@cadfixer/mesh-core';
import type { ConnectorPairView } from './joint-presentation';
export type AssemblyVector = readonly [number, number, number];
export interface AssemblyInterface {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly normal: AssemblyVector;
  readonly origin: AssemblyVector;
  readonly footprint: readonly AssemblyVector[];
}
export interface AssemblyPresentation {
  readonly documentId: string;
  readonly revision: number;
  readonly exploded: boolean;
  readonly connectorMode: 'automatic' | 'unavailable' | 'plain' | 'manual';
  readonly offsets: readonly { readonly partId: string; readonly offset: AssemblyVector }[];
  readonly interfaces: readonly AssemblyInterface[];
  readonly selectedPairId?: string | undefined;
  readonly labels: Readonly<Record<string, string>>;
}
export interface SplitAssemblyContext {
  readonly sourcePartId: string;
  readonly sourceTransform: readonly number[];
  readonly plane?: SplitPlane;
  readonly label?: string;
}
const vector = (v: readonly number[]): AssemblyVector => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
export const assemblyPoint = (p: AssemblyVector, t: readonly number[]): AssemblyVector => [
  p[0] * (t[0] ?? 1) + p[1] * (t[3] ?? 0) + p[2] * (t[6] ?? 0) + (t[9] ?? 0),
  p[0] * (t[1] ?? 0) + p[1] * (t[4] ?? 1) + p[2] * (t[7] ?? 0) + (t[10] ?? 0),
  p[0] * (t[2] ?? 0) + p[1] * (t[5] ?? 0) + p[2] * (t[8] ?? 1) + (t[11] ?? 0),
];
/** Inverse-transpose, including mirrored and nonuniform source transforms. */
export function assemblyNormal(n: AssemblyVector, t: readonly number[]): AssemblyVector {
  const [a, b, c, d, e, f, g, h, i] = [
      defined(t[0]),
      defined(t[3]),
      defined(t[6]),
      defined(t[1]),
      defined(t[4]),
      defined(t[7]),
      defined(t[2]),
      defined(t[5]),
      defined(t[8]),
    ],
    det =
      defined(a) * (defined(e) * defined(i) - defined(f) * defined(h)) -
      defined(b) * (defined(d) * defined(i) - defined(f) * defined(g)) +
      defined(c) * (defined(d) * defined(h) - defined(e) * defined(g));
  const raw = [
    (defined(e) * defined(i) - defined(f) * defined(h)) * n[0] +
      (defined(f) * defined(g) - defined(d) * defined(i)) * n[1] +
      (defined(d) * defined(h) - defined(e) * defined(g)) * n[2],
    (defined(c) * defined(h) - defined(b) * defined(i)) * n[0] +
      (defined(a) * defined(i) - defined(c) * defined(g)) * n[1] +
      (defined(b) * defined(g) - defined(a) * defined(h)) * n[2],
    (defined(b) * defined(f) - defined(c) * defined(e)) * n[0] +
      (defined(c) * defined(d) - defined(a) * defined(f)) * n[1] +
      (defined(a) * defined(e) - defined(b) * defined(d)) * n[2],
  ].map((x) => x / defined(det));
  const length = Math.hypot(...raw);
  return vector(raw.map((x) => (x === 0 ? 0 : x / Math.max(length, 1e-12))));
}
/** Translation only: canonical transforms, geometry and export buffers remain untouched. */
export function explosionOffsets(
  parts: readonly PartDescriptor[],
  interfaces: readonly AssemblyInterface[],
  diagonal: number,
): AssemblyPresentation['offsets'] {
  const centers = parts.map((p) => assemblyPoint(p.bounds?.center ?? [0, 0, 0], p.transform)),
    center = vector(
      [0, 1, 2].map(
        (a) => centers.reduce((s, p) => s + defined(p[a]), 0) / Math.max(1, parts.length),
      ),
    ),
    distance = Math.max(diagonal, 1e-9) * 0.14;
  const offsets = parts.map((p, i) => {
    const edge = interfaces.findLast((e) => e.a === p.partId || e.b === p.partId);
    let direction = vector(defined(centers[i]).map((x, a) => x - defined(center[a])));
    if (parts.length === 2 && edge)
      direction = vector(edge.normal.map((v) => v * (edge.a === p.partId ? 1 : -1)));
    let length = Math.hypot(...direction);
    if (length < diagonal * 1e-6) {
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      direction = [Math.cos(angle), Math.sin(angle), 0.35 * Math.sin(angle * 0.5)];
      length = Math.hypot(...direction);
    }
    return { partId: p.partId, offset: vector(direction.map((v) => (v / length) * distance)) };
  });
  // Each genuine cut contributes an equal/opposite separation along its own normal. This retains
  // source-relative order for parallel multi-step cuts instead of translating same-side pieces together.
  if (parts.length > 2)
    for (let pass = 0; pass < 8; pass++)
      for (const edge of interfaces) {
        const ai = parts.findIndex((p) => p.partId === edge.a),
          bi = parts.findIndex((p) => p.partId === edge.b);
        if (ai < 0 || bi < 0) continue;
        const separation = edge.normal.reduce(
            (s, n, k) =>
              s +
              n *
                (defined(defined(offsets[ai]).offset[k]) - defined(defined(offsets[bi]).offset[k])),
            0,
          ),
          needed = Math.min(distance * 0.7, (diagonal * 0.28) / Math.max(1, parts.length - 1));
        if (separation < needed)
          for (const [index, sign] of [
            [ai, 1],
            [bi, -1],
          ] as const)
            offsets[index] = {
              partId: defined(parts[index]).partId,
              offset: vector(
                defined(offsets[index]).offset.map(
                  (v, k) => v + (sign * defined(edge.normal[k]) * (needed - separation)) / 2,
                ),
              ),
            };
      }
  const maximum = Math.max(0, ...offsets.map((p) => Math.hypot(...p.offset))),
    scale = maximum > diagonal * 0.35 ? (diagonal * 0.35) / maximum : 1;
  return offsets.map((p) => ({ partId: p.partId, offset: vector(p.offset.map((v) => v * scale)) }));
}
/**
 * The fields of a split result the presentation reads. A COMMIT result satisfies it, and so does a
 * PREVIEW once it is given a provisional handle: one function builds both views, so what a user
 * inspects before Apply is what the Apply will show.
 */
export type AssemblySplitResult = Pick<
  SplitCommitResult,
  | 'handle'
  | 'parentRevision'
  | 'recordId'
  | 'parts'
  | 'pieceAId'
  | 'pieceBId'
  | 'interface'
  | 'connector'
  | 'automaticConnector'
  | 'metrics'
  | 'bounds'
>;

export function assemblyAfterSplit(
  result: AssemblySplitResult,
  context: SplitAssemblyContext | undefined,
  previous: AssemblyPresentation | undefined,
): AssemblyPresentation {
  if (
    previous?.documentId !== result.handle.documentId ||
    previous.revision !== result.parentRevision
  )
    previous = undefined;
  const live = new Set(result.parts.map((p) => p.partId)),
    interfaces: AssemblyInterface[] = [],
    worldPlane = context?.plane
      ? {
          origin: assemblyPoint(context.plane.origin, context.sourceTransform),
          normal: assemblyNormal(context.plane.normal, context.sourceTransform),
        }
      : undefined;
  for (const old of previous?.interfaces ?? []) {
    let a = old.a,
      b = old.b;
    if (context && (a === context.sourcePartId || b === context.sourcePartId)) {
      if (!worldPlane) continue; // Component extraction creates no new interface; ambiguous ownership is never guessed.
      const signs = old.footprint.map((p) =>
        worldPlane.normal.reduce(
          (s, n, k) => s + n * (defined(p[k]) - defined(worldPlane.origin[k])),
          0,
        ),
      );
      const positive = signs.every((s) => s > 1e-8),
        negative = signs.every((s) => s < -1e-8);
      if (!positive && !negative) continue; // A later cut crossing an existing interface invalidates its pair mapping.
      const child = positive ? result.pieceAId : result.pieceBId;
      if (a === context.sourcePartId) a = child;
      else b = child;
    }
    if (!live.has(a) || !live.has(b)) continue;
    interfaces.push({ ...old, a, b });
  }
  if (worldPlane && context) {
    const local = result.interface,
      origin = assemblyPoint(
        local?.center ?? defined(context.plane).origin,
        context.sourceTransform,
      ),
      footprint: AssemblyVector[] = local?.bounds
        ? Array.from({ length: 8 }, (_, bits) =>
            assemblyPoint(
              vector(
                [0, 1, 2].map((k) =>
                  (bits >> k) & 1
                    ? defined(defined(local.bounds).max[k])
                    : defined(defined(local.bounds).min[k]),
                ),
              ),
              context.sourceTransform,
            ),
          )
        : [origin];
    interfaces.push({
      id: result.recordId,
      a: result.pieceAId,
      b: result.pieceBId,
      origin,
      normal: worldPlane.normal,
      footprint,
    });
  }
  const labels: Record<string, string> = {};
  for (const part of result.parts)
    labels[part.partId] = (previous?.labels[part.partId] ?? part.name ?? 'Piece').slice(0, 128);
  if (context?.label) {
    labels[result.pieceAId] = context.label.slice(0, 128);
    labels[result.pieceBId] = 'Remaining assembly';
  }
  const diagonal = result.bounds
    ? Math.hypot(...result.bounds.max.map((v, a) => v - defined(defined(result.bounds).min[a])))
    : 1;
  return {
    documentId: result.handle.documentId,
    revision: result.handle.revision,
    exploded: true,
    connectorMode:
      result.automaticConnector === 'applied'
        ? 'automatic'
        : result.automaticConnector === 'unavailable'
          ? 'unavailable'
          : result.connector.kind === 'none'
            ? 'plain'
            : 'manual',
    interfaces: interfaces.slice(-128),
    labels,
    offsets: explosionOffsets(result.parts, interfaces, diagonal),
  };
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required bounded geometry evidence is missing.');
  return value;
}

/** Existing paired geometry may only be split where its interface and connector guards survive intact. */
export function preservesAssemblyInterfaces(
  assembly: AssemblyPresentation | undefined,
  sourcePartId: string,
  plane: SplitPlane,
  transform: readonly number[],
  /** The connectors the worker lists for this revision. They guard the plane; the page keeps no record of its own. */
  pairs: readonly ConnectorPairView[],
): boolean {
  const origin = assemblyPoint(plane.origin, transform),
    normal = assemblyNormal(plane.normal, transform);
  for (const edge of assembly?.interfaces ?? []) {
    if (edge.a !== sourcePartId && edge.b !== sourcePartId) continue;
    const signed = edge.footprint.map((p) =>
      normal.reduce((s, n, k) => s + n * (defined(p[k]) - defined(origin[k])), 0),
    );
    if (!signed.length || !(signed.every((s) => s > 1e-8) || signed.every((s) => s < -1e-8)))
      return false;
  }
  // A connector guards the plane by its own reach, and the worker, not this layout, says which connectors exist.
  for (const pair of pairs) {
    if (pair.a !== sourcePartId && pair.b !== sourcePartId) continue;
    const distance = Math.abs(
      normal.reduce((s, n, k) => s + n * (defined(pair.center[k]) - defined(origin[k])), 0),
    );
    if (distance <= pair.guardRadiusWorld) return false;
  }
  return true;
}

/** The part-local boxes of `parts`, placed by each part's own transform, as one world box. */
function worldBoundsOf(parts: readonly PartDescriptor[]): MeshBounds | undefined {
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const part of parts) {
    if (!part.bounds) continue;
    for (let bits = 0; bits < 8; bits++) {
      const corner = assemblyPoint(
        vector(
          [0, 1, 2].map((k) =>
            defined((bits >> k) & 1 ? part.bounds?.max[k] : part.bounds?.min[k]),
          ),
        ),
        part.transform,
      );
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(defined(min[k]), defined(corner[k]));
        max[k] = Math.max(defined(max[k]), defined(corner[k]));
      }
      any = true;
    }
  }
  if (!any) return undefined;
  const size = vector(max.map((v, k) => v - defined(min[k]))),
    center = vector(max.map((v, k) => (v + defined(min[k])) / 2));
  return { min, max, size, center, radius: Math.hypot(...size) / 2 };
}

/**
 * THE ASSEMBLY OF A SPLIT PREVIEW. Display-only, like everything in this module: it reads the
 * worker's preview result, builds offsets and pair descriptions with `assemblyAfterSplit` itself, and
 * touches no geometry, transform, revision, history or transaction. The handle is PROVISIONAL (the
 * revision Apply would produce) and the record id is marked `#preview`; neither is ever sent anywhere.
 * It is always returned assembled: whether to show it exploded is a separate, purely visual choice.
 */
export function assemblyForSplitPreview(
  source: DocumentHandle,
  preview: Pick<
    SplitCreateResult,
    | 'candidate'
    | 'parts'
    | 'pieceAId'
    | 'pieceBId'
    | 'interface'
    | 'connector'
    | 'automaticConnector'
    | 'metrics'
  >,
  context: SplitAssemblyContext | undefined,
  previous: AssemblyPresentation | undefined,
): AssemblyPresentation {
  const bounds = worldBoundsOf(preview.parts);
  return {
    ...assemblyAfterSplit(
      {
        handle: { documentId: source.documentId, revision: source.revision + 1 },
        parentRevision: source.revision,
        recordId: `${preview.candidate.candidateId}#preview`,
        parts: preview.parts,
        pieceAId: preview.pieceAId,
        pieceBId: preview.pieceBId,
        connector: preview.connector,
        metrics: preview.metrics,
        bounds,
        ...(preview.interface ? { interface: preview.interface } : {}),
        ...(preview.automaticConnector ? { automaticConnector: preview.automaticConnector } : {}),
      },
      context,
      previous,
    ),
    exploded: false,
  };
}
