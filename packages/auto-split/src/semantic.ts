import {
  reconcileComplementarySiblings,
  type ComplementarySiblingPair,
} from './semantic-complementary';
import type { PlaneSynthesisTrace } from './semantic-synthesis-trace';
import { structuralSeamEvidence, seamSupportsPlane } from './semantic-seam';
import { qualifyFamilyIdentity, familyIdentityTimings } from './semantic-family-identity';
import {
  qualifyPartialFamilyMembership,
  type PartialFamilyMembership,
} from './semantic-partial-membership';
import { resolveSemanticFamilySubset, type FamilySubset } from './semantic-family-subset';
import {
  semanticDecompositionIntent,
  SEMANTIC_INTENT_LIMITS,
  independentPlanePeer,
  type SemanticDecompositionIntent,
} from './semantic-intent';
import { directSemanticFamily, type DirectSemanticFamily } from './semantic-direct-family';
import { buildSemanticReservations, type SemanticReservation } from './semantic-reservation';
import { componentSemanticExtents, type SemanticExtent } from './semantic-extent';
import {
  completeSemanticFamily,
  familySignatures,
  type FamilyCompletion,
  type FamilySignatures,
} from './semantic-family';
import {
  synthesizeSemanticPlane,
  planeOwnershipTelemetry,
  confirmSemanticPlane,
  type LocalPlaneProposal,
} from './semantic-local-plane';
import { refineSemanticPlanes, type SemanticPlaneRefinement } from './semantic-plane';
import { required } from './required';
import type { SemanticCandidate } from './semantic-candidate';
import {
  SEMANTIC_LIMITS,
  semanticComponentId,
  VIEW_NAMES,
  VIEW_IMAGE_SIZE,
  cameraFor,
  FRAME_FILL,
  validateSemanticMetadata,
  validateSemanticHierarchy,
  type SemanticHierarchy,
  type SemanticComponentMetadata,
  type SemanticRequestMetadata,
  type ImagePoint,
  type Vec3,
  type ViewName,
} from '@cadfixer/auto-split-contract';
import { MAX_SUPPORTED_SPLIT_TRIANGLES, type CanonicalMesh } from '@cadfixer/mesh-core';
import { invalidState, resourceLimitExceeded } from '@cadfixer/shared';
import {
  labelComponents,
  componentFacts,
  type ComponentLabelling,
  type ComponentFacts,
} from './components';
import { faceFacts, normalizeGeometry, toSourcePoint, type NormalizedGeometry } from './geometry';
import { rasteriseView, shadeView, SUPERSAMPLE, type Raster } from './raster';
import { encodePng, type Deflate } from './png';
import { NO_CHECKPOINT, CHECKPOINT_STRIDE, type Checkpoint } from './checkpoint';
import {
  SuggestionOperation,
  SuggestionStatus,
  SuggestionReason,
  type Suggestion,
  type SuggestionResult,
} from './suggestions';
export const SEMANTIC_WORK_LIMITS = Object.freeze({
  rasterPixels: 128000000,
  rasterRows: 64000000,
  components: 8192,
  candidates: SEMANTIC_LIMITS.parts * (SEMANTIC_LIMITS.instances + 1),
  regionPixels: 64000000,
  scoredFaces: 48000000,
  strongViews: 2,
  coverage: 0.82,
  semanticConfidence: 0.72,
  planePurity: 0.72,
});
export interface PreparedSemanticGeometry {
  readonly geometry: NormalizedGeometry;
  readonly labelling: ComponentLabelling;
  readonly facts: readonly ComponentFacts[];
  readonly rasters: readonly Raster[];
  readonly pngs: readonly Uint8Array[];
  readonly componentPngs: readonly Uint8Array[];
  readonly metadata: SemanticRequestMetadata;
  readonly cameras: readonly {
    readonly view: ViewName;
    readonly camera: ReturnType<typeof cameraFor>;
    readonly size: number;
    readonly center: Vec3;
    readonly scale: number;
    readonly radius: number;
    /** Row-major homogeneous normalized-model to normalized-image/depth transform. */
    readonly projection: readonly number[];
  }[];
  readonly visibleTotals: readonly Uint32Array[];
  /** Analytic front-facing projected area, in raster pixels, before inter-component occlusion. */
  readonly projectedTotals: readonly Float64Array[];
  readonly timings: Readonly<Record<string, number>>;
}
const elapsed = (start: number): number => Date.now() - start;
const rounded = (x: number): number => Math.round(x * 1e6) / 1e6;
export function semanticComponentColor(rank: number): readonly [number, number, number] {
  const n = ((rank + 1) * 2654435761) >>> 0;
  return [48 + (n & 159), 48 + ((n >>> 8) & 159), 48 + ((n >>> 16) & 159)];
}
/** Tiny internal analysis labels. No viewport/UI asset or network dependency. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  C: ['111', '100', '100', '100', '111'],
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};
function componentImage(
  raster: Raster,
  labelling: ComponentLabelling,
  admitted: number,
  checkpoint: Checkpoint,
): Uint8Array {
  const rgb = new Uint8Array(VIEW_IMAGE_SIZE * VIEW_IMAGE_SIZE * 3).fill(236);
  const colors = Array.from({ length: admitted }, (_, r) => semanticComponentColor(r));
  const count = new Uint32Array(admitted),
    sx = new Float64Array(admitted),
    sy = new Float64Array(admitted);
  for (let y = 0; y < VIEW_IMAGE_SIZE; y++) {
    if ((y & 31) === 0) checkpoint();
    for (let x = 0; x < VIEW_IMAGE_SIZE; x++) {
      const f = raster.face[y * SUPERSAMPLE * raster.size + x * SUPERSAMPLE] ?? -1;
      if (f < 0) continue;
      const rank = labelling.faceRank[f] ?? -1;
      const c = colors[rank] ?? [130, 130, 130];
      const i = (y * VIEW_IMAGE_SIZE + x) * 3;
      rgb.set(c, i);
      if (rank >= 0 && rank < admitted) {
        count[rank] = (count[rank] ?? 0) + 1;
        sx[rank] = (sx[rank] ?? 0) + x;
        sy[rank] = (sy[rank] ?? 0) + y;
      }
    }
  }
  for (let r = 0; r < admitted; r++) {
    if ((count[r] ?? 0) < 64) continue;
    const x = Math.round((sx[r] ?? 0) / (count[r] ?? 0)),
      y = Math.round((sy[r] ?? 0) / (count[r] ?? 0));
    const text = 'C' + String(r).padStart(2, '0');
    for (let n = 0; n < text.length; n++) {
      const glyph = required(GLYPHS[required(text[n], 'text[n]')], 'GLYPHS[text[n]!]');
      for (let gy = 0; gy < 5; gy++)
        for (let gx = 0; gx < 3; gx++) {
          const px = x + n * 4 + gx,
            py = y + gy;
          if (px >= 0 && px < VIEW_IMAGE_SIZE && py >= 0 && py < VIEW_IMAGE_SIZE)
            rgb.fill(
              required(glyph[gy], 'glyph[gy]')[gx] === '1' ? 15 : 245,
              (py * VIEW_IMAGE_SIZE + px) * 3,
              (py * VIEW_IMAGE_SIZE + px) * 3 + 3,
            );
        }
    }
  }
  return rgb;
}
export async function prepareSemanticGeometry(
  mesh: CanonicalMesh,
  deflate: Deflate,
  checkpoint: Checkpoint = NO_CHECKPOINT,
  onView?: (view: ViewName, index: number) => void,
): Promise<PreparedSemanticGeometry> {
  const start = Date.now();
  if (mesh.indices.length / 3 > MAX_SUPPORTED_SPLIT_TRIANGLES)
    throw resourceLimitExceeded('This part exceeds the supported split size.');
  const geometry = normalizeGeometry(mesh.positions, mesh.indices, checkpoint);
  const face = faceFacts(geometry, checkpoint);
  const labelling = labelComponents(mesh, face, checkpoint);
  if (labelling.count > SEMANTIC_WORK_LIMITS.components)
    throw resourceLimitExceeded('This model has too many separate pieces to analyze safely.');
  const facts = componentFacts(labelling, face, geometry, checkpoint);
  const admitted = Math.min(facts.length, SEMANTIC_LIMITS.components);
  const lo = new Float64Array(admitted * 3).fill(Infinity),
    hi = new Float64Array(admitted * 3).fill(-Infinity);
  for (let f = 0; f < geometry.faceCount; f++) {
    if (f % CHECKPOINT_STRIDE === 0) checkpoint();
    const r = labelling.faceRank[f] ?? -1;
    if (r < 0 || r >= admitted) continue;
    for (let c = 0; c < 3; c++) {
      const i = (geometry.indices[f * 3 + c] ?? 0) * 3;
      for (let a = 0; a < 3; a++) {
        const v = geometry.positions[i + a] ?? 0;
        lo[r * 3 + a] = Math.min(lo[r * 3 + a] ?? 0, v);
        hi[r * 3 + a] = Math.max(hi[r * 3 + a] ?? 0, v);
      }
    }
  }
  const components: SemanticComponentMetadata[] = facts.slice(0, admitted).map((f) => {
    const min: [number, number, number] = [
        lo[f.rank * 3] ?? 0,
        lo[f.rank * 3 + 1] ?? 0,
        lo[f.rank * 3 + 2] ?? 0,
      ],
      max: [number, number, number] = [
        hi[f.rank * 3] ?? 0,
        hi[f.rank * 3 + 1] ?? 0,
        hi[f.rank * 3 + 2] ?? 0,
      ];
    const size = max.map((v, i) => v - (min[i] ?? 0)),
      longest = Math.max(...size, 1e-9);
    return {
      id: semanticComponentId(f.rank),
      faceCount: f.faces,
      bounds: {
        min: min.map(rounded) as unknown as Vec3,
        max: max.map(rounded) as unknown as Vec3,
      },
      centroid: f.centroid.map(rounded) as unknown as Vec3,
      areaShare: rounded(f.areaShare),
      aspect: size.map((x) => rounded(x / longest)) as unknown as Vec3,
      color: semanticComponentColor(f.rank),
    };
  });
  const metadata: SemanticRequestMetadata = {
    scope: 'selected-piece',
    components,
    totalComponents: labelling.count,
  };
  if (!validateSemanticMetadata(metadata))
    throw invalidState('This model has invalid component bounds for analysis.');
  // Only the admitted component vocabulary can become an extraction candidate (at most 24).
  const projectedTotals = VIEW_NAMES.map(() => new Float64Array(admitted));
  const pixelScale = ((VIEW_IMAGE_SIZE * SUPERSAMPLE * FRAME_FILL) / (2 * geometry.radius)) ** 2;
  const directions = VIEW_NAMES.map((view) => cameraFor(view).forward);
  for (let f = 0; f < geometry.faceCount; f++) {
    if (f % CHECKPOINT_STRIDE === 0) checkpoint();
    const rank = labelling.faceRank[f] ?? -1;
    if (rank < 0 || rank >= admitted) continue;
    const a = (geometry.indices[f * 3] ?? 0) * 3,
      b = (geometry.indices[f * 3 + 1] ?? 0) * 3,
      c = (geometry.indices[f * 3 + 2] ?? 0) * 3,
      ux = (geometry.positions[b] ?? 0) - (geometry.positions[a] ?? 0),
      uy = (geometry.positions[b + 1] ?? 0) - (geometry.positions[a + 1] ?? 0),
      uz = (geometry.positions[b + 2] ?? 0) - (geometry.positions[a + 2] ?? 0),
      vx = (geometry.positions[c] ?? 0) - (geometry.positions[a] ?? 0),
      vy = (geometry.positions[c + 1] ?? 0) - (geometry.positions[a + 1] ?? 0),
      vz = (geometry.positions[c + 2] ?? 0) - (geometry.positions[a + 2] ?? 0),
      nx = (uy * vz - uz * vy) / 2,
      ny = (uz * vx - ux * vz) / 2,
      nz = (ux * vy - uy * vx) / 2;
    for (const [vi, direction] of directions.entries()) {
      const area = Math.max(0, -(nx * direction[0] + ny * direction[1] + nz * direction[2]));
      const totals = defined(projectedTotals[vi]);
      totals[rank] = (totals[rank] ?? 0) + area * pixelScale;
    }
  }
  const preprocessing = elapsed(start),
    renderStart = Date.now();
  const rasters: Raster[] = [],
    pngs: Uint8Array[] = [],
    componentPngs: Uint8Array[] = [],
    visibleTotals: Uint32Array[] = [];
  const rasterBudget = {
    pixels: 0,
    limit: SEMANTIC_WORK_LIMITS.rasterPixels,
    rows: 0,
    rowLimit: SEMANTIC_WORK_LIMITS.rasterRows,
  };
  for (const [index, view] of VIEW_NAMES.entries()) {
    checkpoint();
    const raster = rasteriseView(geometry, view, checkpoint, true, rasterBudget);
    rasters.push(raster);
    const normal = await encodePng(
      VIEW_IMAGE_SIZE,
      VIEW_IMAGE_SIZE,
      shadeView(geometry, raster),
      deflate,
    );
    const ids = await encodePng(
      VIEW_IMAGE_SIZE,
      VIEW_IMAGE_SIZE,
      componentImage(raster, labelling, admitted, checkpoint),
      deflate,
    );
    if (
      normal.length > SEMANTIC_LIMITS.normalPngBytes ||
      ids.length > SEMANTIC_LIMITS.overlayPngBytes
    )
      throw resourceLimitExceeded('The analysis images exceed the supported request size.');
    pngs.push(normal);
    componentPngs.push(ids);
    const totals = new Uint32Array(labelling.count);
    for (let i = 0; i < raster.face.length; i++) {
      if (i % CHECKPOINT_STRIDE === 0) checkpoint();
      const f = raster.face[i] ?? -1;
      if (f >= 0) {
        const r = labelling.faceRank[f] ?? -1;
        totals[r] = (totals[r] ?? 0) + 1;
      }
    }
    visibleTotals.push(totals);
    onView?.(view, index);
  }
  return {
    geometry,
    labelling,
    facts,
    rasters,
    pngs,
    componentPngs,
    visibleTotals,
    projectedTotals,
    metadata,
    cameras: VIEW_NAMES.map((view) => ({
      view,
      camera: cameraFor(view),
      size: VIEW_IMAGE_SIZE,
      center: geometry.center,
      scale: geometry.scale,
      radius: geometry.radius,
      projection: ((): readonly number[] => {
        const c = cameraFor(view),
          k = FRAME_FILL / (2 * geometry.radius);
        return [
          k * c.right[0],
          k * c.right[1],
          k * c.right[2],
          0.5,
          -k * c.up[0],
          -k * c.up[1],
          -k * c.up[2],
          0.5,
          ...c.forward,
          0,
          0,
          0,
          0,
          1,
        ];
      })(),
    })),
    timings: {
      preprocessing,
      render: elapsed(renderStart),
      rasterPixels: rasterBudget.pixels,
      rasterRows: rasterBudget.rows,
    },
  };
}
export function pointInSemanticPolygon(x: number, y: number, p: readonly ImagePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = required(p[i], 'p[i]'),
      b = required(p[j], 'p[j]');
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
export interface SemanticEvidence {
  readonly partialFamilyMembership?: PartialFamilyMembership;
  readonly decompositionIntent?: SemanticDecompositionIntent;
  readonly semanticExtent?: SemanticExtent;
  readonly id: string;
  readonly components: readonly {
    readonly rank: number;
    readonly viewCoverage: readonly number[];
    readonly strongViews: number;
  }[];
  readonly regionInstances?: readonly {
    readonly view: ViewName;
    readonly polygon: number;
    readonly ranks: readonly number[];
    readonly purity?: number;
    readonly pixels?: number;
    readonly support?: readonly { readonly rank: number; readonly pixels: number }[];
  }[];
  readonly confidence?: {
    readonly objectConfidence: number;
    readonly partSemanticConfidence: number;
    readonly geometryConfidence: number;
    readonly realizationConfidence: number;
  };
  readonly familyCompletion?: FamilyCompletion;
  readonly directFamily?: DirectSemanticFamily;
  readonly familySubset?: FamilySubset;
  readonly viewEvidence?: readonly {
    readonly rank: number;
    readonly views: readonly {
      readonly view: ViewName;
      readonly state:
        'POSITIVE' | 'CONTRADICTORY' | 'OMITTED' | 'OCCLUDED' | 'FAMILY_INSTANCE_OMITTED';
      readonly coverage: number;
    }[];
  }[];
  readonly multiViewFaces: number;
  readonly visibleFaces: number;
  readonly refinement?: SemanticPlaneRefinement;
  readonly instances?: readonly {
    centroid: Vec3;
    area: number;
    faces: number;
    mirroredAxes: readonly number[];
  }[];
  readonly planePurity: number | null;
  readonly localPlane?: LocalPlaneProposal;
  readonly synthesis?: PlaneSynthesisTrace;
  readonly visibility?: readonly {
    readonly rank: number;
    readonly observableViews: readonly number[];
    readonly occludedViews: readonly number[];
  }[];
  readonly reason: string;
}
export interface SemanticDecomposition extends SuggestionResult {
  readonly complementaryPairs?: readonly ComplementarySiblingPair[];
  readonly ambiguousComplementaryPairs?: readonly string[];
  readonly complementaryPairingDiagnostic?: 'AMBIGUOUS_COMPLEMENTARY_PAIR';
  readonly reservations?: readonly SemanticReservation[];
  readonly candidates: readonly SemanticCandidate[];
  readonly objectLabel: string;
  readonly evidence: readonly SemanticEvidence[];
  readonly timings: Readonly<Record<string, number>>;
}
const bits = (n: number): number => {
  let count = 0;
  for (; n; n >>>= 1) count += n & 1;
  return count;
};
function instanceGroups(
  ranks: readonly number[],
  count: number,
  facts: readonly ComponentFacts[],
  checkpoint: Checkpoint,
): number[][] | undefined {
  if (count === 1) return [[...ranks]];
  if (ranks.length < count) return undefined;
  const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const ordered = [...ranks].sort((a, b) => {
    const x = required(facts[a], 'facts[a]').centroid,
      y = required(facts[b], 'facts[b]').centroid;
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a - b;
  });
  const seeds: Vec3[] = [required(facts[ordered[0] ?? 0], 'facts[ordered[0]!]').centroid];
  while (seeds.length < count) {
    checkpoint();
    let best = -1,
      far = -1;
    for (const r of ordered) {
      const d = Math.min(...seeds.map((s) => distance(s, required(facts[r], 'facts[r]').centroid)));
      if (d > far) {
        far = d;
        best = r;
      }
    }
    if (far < 0.015) return undefined;
    seeds.push(required(facts[best], 'facts[best]').centroid);
  }
  let groups: number[][] = [];
  for (let pass = 0; pass < 6; pass++) {
    checkpoint();
    groups = seeds.map(() => []);
    for (const r of ordered) {
      let best = 0,
        d = Infinity;
      seeds.forEach((s, i) => {
        const next = distance(s, required(facts[r], 'facts[r]').centroid);
        if (next < d) {
          best = i;
          d = next;
        }
      });
      required(groups[best], 'groups[best]').push(r);
    }
    if (groups.some((g) => g.length === 0)) return undefined;
    groups.forEach((g, i) => {
      const total = g.reduce((a, r) => a + required(facts[r], 'facts[r]').area, 0) || 1;
      seeds[i] = [0, 1, 2].map(
        (a) =>
          g.reduce(
            (s, r) =>
              s +
              (required(facts[r], 'facts[r]').centroid[a] ?? 0) *
                required(facts[r], 'facts[r]').area,
            0,
          ) / total,
      ) as unknown as Vec3;
    });
  }
  const minGap = Math.min(
    ...seeds.flatMap((a, i) => seeds.slice(i + 1).map((b) => distance(a, b))),
  );
  if (
    groups.some((g, i) =>
      g.some(
        (r) =>
          distance(required(facts[r], 'facts[r]').centroid, required(seeds[i], 'seeds[i]')) >
          minGap * 0.35,
      ),
    )
  )
    return undefined;
  // Similarity is supporting evidence after visibility/membership and spatial separation.
  const areas = groups.map((g) =>
    g.reduce((sum, r) => sum + required(facts[r], 'facts[r]').area, 0),
  );
  const faces = groups.map((g) =>
    g.reduce((sum, r) => sum + required(facts[r], 'facts[r]').faces, 0),
  );
  if (Math.max(...areas) > Math.min(...areas) * 4 || Math.max(...faces) > Math.min(...faces) * 4)
    return undefined;
  return groups;
}
/** No arbitrary surface operation: unsupported local cuts are explicit future candidates only. */
export function decomposeSemantic(
  prepared: PreparedSemanticGeometry,
  raw: unknown,
  checkpoint: Checkpoint = NO_CHECKPOINT,
): SemanticDecomposition {
  const checked = validateSemanticHierarchy(raw);
  if (!checked.ok) throw invalidState('The analysis did not match the expected shape.');
  const answer: SemanticHierarchy = checked.value;
  const start = Date.now();
  const { geometry, labelling, rasters, visibleTotals, facts } = prepared;
  const evidence: SemanticEvidence[] = [],
    suggestions: Suggestion[] = [];
  const partialFamilies = new Map<string, readonly number[]>();
  const partById = new Map(answer.parts.map((p) => [p.id, p]));
  let work = 0,
    faceWork = 0;
  let signatures: FamilySignatures | undefined;
  const getSignatures = (): FamilySignatures => {
    if (!signatures) {
      if (faceWork + geometry.faceCount > SEMANTIC_WORK_LIMITS.scoredFaces)
        throw resourceLimitExceeded(
          'The semantic correspondence exceeds the supported work limit.',
        );
      faceWork += geometry.faceCount;
      signatures = familySignatures(prepared, checkpoint);
    }
    return signatures;
  };
  const ownershipSupport = rasters.map((r) => new Uint32Array(r.face.length));
  const planeOwnership = planeOwnershipTelemetry();
  let planeOwnershipMilliseconds = 0;
  const planeContext = {
    synthesis: new Map<string, PlaneSynthesisTrace>(),
    telemetry: planeOwnership,
    charge: (): void => {
      if (++work > SEMANTIC_WORK_LIMITS.regionPixels)
        throw resourceLimitExceeded('The semantic regions exceed the supported work limit.');
    },
  };
  const localPlanes = new Map<string, LocalPlaneProposal>();
  for (const part of answer.parts) {
    checkpoint();
    const planeStarted = Date.now();
    const proposal = synthesizeSemanticPlane(prepared, answer, part, checkpoint, planeContext);
    planeOwnershipMilliseconds += Date.now() - planeStarted;
    if (proposal) localPlanes.set(part.id, proposal);
  }
  const complementary = reconcileComplementarySiblings(
    prepared,
    answer,
    localPlanes,
    checkpoint,
    planeContext,
  );
  const pairedIds = new Set(complementary.pairs.flatMap((p) => [p.primaryId, p.complementId]));
  const localParts = answer.parts.map((part) => {
    const proposal = localPlanes.get(part.id);
    return proposal
      ? {
          ...part,
          cut: proposal.cut,
          expectedGeometry: { ...part.expectedGeometry, likelySeparable: true },
        }
      : part;
  });
  const refinement = refineSemanticPlanes(
    geometry,
    localParts.filter(
      (p) =>
        !pairedIds.has(p.id) &&
        Math.min(answer.object.confidence, p.confidence) >= SEMANTIC_WORK_LIMITS.semanticConfidence,
    ),
    checkpoint,
  );
  for (const observedPart of localParts) {
    let refined = refinement.refinements.get(observedPart.id);
    const originalProposal = localPlanes.get(observedPart.id);
    if (refined && originalProposal) {
      const planeStarted = Date.now();
      const confirmed = confirmSemanticPlane(
        prepared,
        answer,
        observedPart,
        refined.cut,
        originalProposal,
        checkpoint,
        planeContext,
      );
      planeOwnershipMilliseconds += Date.now() - planeStarted;
      if (confirmed) localPlanes.set(observedPart.id, confirmed);
      else refined = undefined;
    }
    const part = refined ? { ...observedPart, cut: refined.cut } : observedPart;
    checkpoint();
    const partBit = 1 << answer.parts.findIndex((p) => p.id === part.id);
    const mask = new Uint8Array(geometry.faceCount);
    const hits: Uint32Array[] = VIEW_NAMES.map(() => new Uint32Array(labelling.count));
    const mentioned = new Set(part.views.map((v) => v.view));
    const regionInstances: {
      view: ViewName;
      polygon: number;
      ranks: number[];
      purity: number;
      pixels: number;
      support: { rank: number; pixels: number }[];
    }[] = [];
    for (const region of part.views) {
      const vi = VIEW_NAMES.indexOf(region.view),
        raster = required(rasters[vi], 'rasters[vi]');
      const size = raster.size;
      for (const [polygonIndex, polygon] of region.polygons.entries()) {
        const polygonHits = new Uint32Array(labelling.count);
        const xs = polygon.map((p) => p[0]),
          ys = polygon.map((p) => p[1]);
        const x0 = Math.max(0, Math.floor(Math.min(...xs) * size)),
          x1 = Math.min(size, Math.ceil(Math.max(...xs) * size)),
          y0 = Math.max(0, Math.floor(Math.min(...ys) * size)),
          y1 = Math.min(size, Math.ceil(Math.max(...ys) * size));
        for (let y = y0; y < y1; y++) {
          checkpoint();
          for (let x = x0; x < x1; x++) {
            if (++work > SEMANTIC_WORK_LIMITS.regionPixels)
              throw resourceLimitExceeded('The semantic regions exceed the supported work limit.');
            const f = raster.face[y * size + x] ?? -1;
            if (f < 0 || !pointInSemanticPolygon((x + 0.5) / size, (y + 0.5) / size, polygon))
              continue;
            const rank = labelling.faceRank[f] ?? -1;
            required(hits[vi], 'hits[vi]')[rank] = (required(hits[vi], 'hits[vi]')[rank] ?? 0) + 1;
            const pixel = y * size + x;
            const owners = required(ownershipSupport[vi], 'ownership support');
            owners[pixel] = (owners[pixel] ?? 0) | partBit;
            polygonHits[rank] = (polygonHits[rank] ?? 0) + 1;
            mask[f] = (mask[f] ?? 0) | (1 << vi);
          }
        }
        const polygonTotal = polygonHits.reduce((a, b) => a + b, 0);
        const polygonMax = polygonHits.reduce((a, b) => Math.max(a, b), 0);
        regionInstances.push({
          pixels: polygonTotal,
          support: Array.from(polygonHits, (pixels, rank) => ({ rank, pixels })).filter(
            (x) => x.pixels > 0,
          ),
          purity: polygonTotal ? polygonMax / polygonTotal : 0,
          view: region.view,
          polygon: polygonIndex,
          ranks: prepared.metadata.components
            .map((c) => Number(c.id.slice(1)))
            .filter(
              (rank) =>
                (visibleTotals[vi]?.[rank] ?? 0) >= 8 &&
                (polygonHits[rank] ?? 0) / (visibleTotals[vi]?.[rank] ?? 1) >=
                  SEMANTIC_WORK_LIMITS.coverage,
            ),
        });
      }
    }
    // Count each visible pixel once even if the provider polygons overlap, by rescanning their union.
    if (part.views.some((v) => v.polygons.length > 1)) {
      for (const region of part.views) {
        const vi = VIEW_NAMES.indexOf(region.view),
          raster = required(rasters[vi], 'rasters[vi]');
        required(hits[vi], 'hits[vi]').fill(0);
        for (let i = 0; i < raster.face.length; i++) {
          if (i % CHECKPOINT_STRIDE === 0) checkpoint();
          if (++work > SEMANTIC_WORK_LIMITS.regionPixels)
            throw resourceLimitExceeded('The semantic regions exceed the supported work limit.');
          const f = raster.face[i] ?? -1;
          if (f < 0) continue;
          const x = ((i % raster.size) + 0.5) / raster.size,
            y = (Math.floor(i / raster.size) + 0.5) / raster.size;
          if (region.polygons.some((p) => pointInSemanticPolygon(x, y, p))) {
            const rank = labelling.faceRank[f] ?? -1;
            required(hits[vi], 'hits[vi]')[rank] = (required(hits[vi], 'hits[vi]')[rank] ?? 0) + 1;
          }
        }
      }
    }
    const scores = prepared.metadata.components.map((c) => {
      const rank = Number(c.id.slice(1));
      const coverage = VIEW_NAMES.map((v, i) =>
        mentioned.has(v) && (required(visibleTotals[i], 'visibleTotals[i]')[rank] ?? 0) >= 8
          ? Math.min(
              1,
              (required(hits[i], 'hits[i]')[rank] ?? 0) /
                (required(visibleTotals[i], 'visibleTotals[i]')[rank] ?? 0),
            )
          : -1,
      );
      return {
        rank,
        viewCoverage: coverage,
        strongViews: coverage.filter((c) => c >= SEMANTIC_WORK_LIMITS.coverage).length,
      };
    });
    const visibility = scores.map((score) => {
      const observableViews: number[] = [],
        occludedViews: number[] = [];
      for (const [vi, view] of VIEW_NAMES.entries()) {
        if (!mentioned.has(view)) continue;
        const visible = visibleTotals[vi]?.[score.rank] ?? 0;
        const projected = prepared.projectedTotals[vi]?.[score.rank] ?? 0;
        // The analytic projected area is an upper bound: concavity makes this test conservative.
        // A non-trivial visible pixel count can never be dismissed as occlusion.
        if (visible < 8 || (visible < 64 && projected >= 8 && visible / projected < 0.1))
          occludedViews.push(vi);
        else observableViews.push(vi);
      }
      return { rank: score.rank, observableViews, occludedViews };
    });
    let ranks = scores
      .filter((score) => {
        const v = defined(visibility.find((v) => v.rank === score.rank));
        const usual =
          score.strongViews >= SEMANTIC_WORK_LIMITS.strongViews &&
          score.viewCoverage.filter((v) => v >= 0).every((v) => v >= 0.65);
        const occlusionProven =
          score.strongViews >= 1 &&
          part.views.length >= 2 &&
          v.occludedViews.length > 0 &&
          v.observableViews.length > 0 &&
          v.observableViews.every(
            (vi) => (score.viewCoverage[vi] ?? -1) >= SEMANTIC_WORK_LIMITS.coverage,
          );
        return usual || occlusionProven;
      })
      .map((score) => score.rank);
    if (part.instances > 1)
      ranks = ranks.filter((rank) => regionInstances.some((region) => region.ranks.includes(rank)));
    const familyPolygons = regionInstances.map((r) => ({
      view: VIEW_NAMES.indexOf(r.view),
      ranks: r.ranks,
      purity: r.purity,
      pixels: r.pixels,
      support: r.support,
    }));
    const directFamily = directSemanticFamily(
      part,
      scores.filter((score) => (facts[score.rank]?.areaShare ?? 1) < 0.995),
      familyPolygons,
      checkpoint,
      () => {
        if (++work > SEMANTIC_WORK_LIMITS.regionPixels)
          throw resourceLimitExceeded('The semantic regions exceed the supported work limit.');
      },
    );
    const exactFamilyCompletion =
      directFamily.state === 'COMPLETE'
        ? undefined
        : completeSemanticFamily(
            prepared,
            part,
            ranks,
            scores,
            familyPolygons,
            getSignatures,
            checkpoint,
          );
    const familySubset =
      directFamily.state !== 'COMPLETE' && !exactFamilyCompletion?.ranks.length
        ? resolveSemanticFamilySubset(
            prepared,
            part,
            directFamily.ranks,
            scores,
            familyPolygons,
            getSignatures,
            checkpoint,
            planeContext.charge,
          )
        : undefined;
    const familyCompletion = familySubset?.ranks.length ? familySubset : exactFamilyCompletion;
    if (directFamily.state === 'COMPLETE') ranks = [...directFamily.ranks];
    else if (familyCompletion) ranks = [...familyCompletion.ranks];
    // References are optional priors. Only local source evidence can admit a rank;
    // unavailable or contradictory provider IDs never enter the resulting group.
    const hitTotals = hits.map((h) => h.reduce((a, b) => a + b, 0));
    const regionPurity = VIEW_NAMES.map((_v, i) => {
      const total = hitTotals[i] ?? 0;
      return total >= 8
        ? ranks.reduce((n, r) => n + (required(hits[i], 'hits[i]')[r] ?? 0), 0) / total
        : -1;
    });
    const coherentRegion =
      regionPurity.filter((v) => v >= 0.72).length >=
        (ranks.every(
          (rank) => (visibility.find((v) => v.rank === rank)?.occludedViews.length ?? 0) > 0,
        )
          ? 1
          : 2) && regionPurity.filter((v) => v >= 0).every((v) => v >= 0.55);
    if (!coherentRegion) ranks = [];
    let multiViewFaces = 0,
      visibleFaces = 0;
    for (let f = 0; f < geometry.faceCount; f++) {
      if (f % CHECKPOINT_STRIDE === 0) checkpoint();
      if (++faceWork > SEMANTIC_WORK_LIMITS.scoredFaces)
        throw resourceLimitExceeded(
          'The semantic correspondence exceeds the supported work limit.',
        );
      if ((mask[f] ?? 0) > 0) visibleFaces++;
      if (bits(mask[f] ?? 0) >= 2) multiViewFaces++;
    }
    const sourceShare = ranks.reduce((s, r) => s + required(facts[r], 'facts[r]').areaShare, 0);
    if (sourceShare >= 0.995 || sourceShare <= 0) ranks = [];
    // Independent views validate a plane's visible selected halfspace. Occluded pixels never vote.
    // Different visible faces of a component can corroborate it; an axis-aligned face need not appear twice.
    const planeCoverage: number[] = [];
    const targetSilhouetteShares: number[] = [];
    if (part.cut) {
      for (const region of part.views) {
        const vi = VIEW_NAMES.indexOf(region.view),
          raster = required(rasters[vi], 'rasters[vi]'),
          camera = cameraFor(region.view),
          size = raster.size,
          scale = (size * FRAME_FILL) / (2 * geometry.radius);
        let modelPixels = 0,
          selectedPixels = 0,
          regionPixels = 0,
          agreed = 0;
        for (let i = 0; i < raster.face.length; i++) {
          if (i % CHECKPOINT_STRIDE === 0) checkpoint();
          if (++work > SEMANTIC_WORK_LIMITS.regionPixels)
            throw resourceLimitExceeded('The semantic regions exceed the supported work limit.');
          if ((raster.face[i] ?? -1) < 0) continue;
          const z = raster.depth?.[i];
          if (z === undefined || !Number.isFinite(z)) continue;
          const x = ((i % size) + 0.5 - size / 2) / scale,
            y = -(Math.floor(i / size) + 0.5 - size / 2) / scale;
          let signed = 0;
          for (let a = 0; a < 3; a++)
            signed +=
              ((camera.right[a] ?? 0) * x +
                (camera.up[a] ?? 0) * y +
                (camera.forward[a] ?? 0) * z -
                (part.cut.origin[a] ?? 0)) *
              (part.cut.normal[a] ?? 0);
          const inside = region.polygons.some((p) =>
            pointInSemanticPolygon(
              ((i % size) + 0.5) / size,
              (Math.floor(i / size) + 0.5) / size,
              p,
            ),
          );
          modelPixels++;
          if (inside) regionPixels++;
          if (signed < 0) continue;
          selectedPixels++;
          if (inside) agreed++;
        }
        if (modelPixels >= 8) targetSilhouetteShares.push(regionPixels / modelPixels);
        if (selectedPixels >= 8 && regionPixels >= 8)
          planeCoverage.push(Math.min(agreed / selectedPixels, agreed / regionPixels));
      }
    }
    const semanticConfidence = part.confidence;
    const planeSemanticConfidence = Math.min(answer.object.confidence, part.confidence);
    let quality: NonNullable<Suggestion['quality']> = 'RECOGNIZED_NOT_SEPARABLE',
      reason = 'No independent geometry boundary';
    let operation: SuggestionOperation = SuggestionOperation.None,
      plane: Suggestion['plane'] = null;
    const purity =
      planeCoverage.length > 0
        ? planeCoverage.reduce((a, b) => a + b, 0) / planeCoverage.length
        : null;
    const componentConfidence = ranks.length
      ? Math.min(
          ...ranks.map((rank) => {
            const score = required(
                scores.find((s) => s.rank === rank),
                'component score',
              ),
              visible = visibility.find((v) => v.rank === rank)?.observableViews ?? [],
              values = visible
                .map((i) => score.viewCoverage[i] ?? -1)
                .filter((v) =>
                  familyCompletion?.ranks.length || directFamily.state === 'COMPLETE'
                    ? v >= SEMANTIC_WORK_LIMITS.coverage
                    : v >= 0,
                );
            if (values.length) return values.reduce((a, b) => a + b, 0) / values.length;
            // A positive view can be analytically occluded at low resolution. A complete proven
            // family still requires direct strong polygon support for every source member.
            return familyCompletion?.ranks.length ? SEMANTIC_WORK_LIMITS.coverage : 0;
          }),
        )
      : 0;
    const exactLeafEvidence =
      !answer.parts.some((child) => child.parentId === part.id) &&
      ranks.every(
        (rank) =>
          Boolean(familyCompletion?.ranks.length) ||
          directFamily.state === 'COMPLETE' ||
          (visibility.find((v) => v.rank === rank)?.observableViews ?? []).every(
            (vi) =>
              (scores.find((s) => s.rank === rank)?.viewCoverage[vi] ?? 0) >=
              SEMANTIC_WORK_LIMITS.coverage,
          ),
      );
    // Geometric evidence is measured independently even when the semantic label is uncertain.
    const localPlane = localPlanes.get(part.id);
    const seam = localPlane ? structuralSeamEvidence(refined, checkpoint) : undefined;
    const independentAxes = localPlane
      ? new Set(
          localPlane.views
            .filter((v) => v.recall >= 0.9 && v.agreement >= SEMANTIC_WORK_LIMITS.coverage)
            .map((v) => Math.floor(v.view / 2)),
        ).size
      : 0;
    const decompositionIntent = localPlane
      ? semanticDecompositionIntent(
          targetSilhouetteShares,
          localPlane.capturedFraction,
          localPlane.ownership.peers.map((peer) => ({
            ...peer,
            independent: independentPlanePeer(part, peer.id, answer, peer, checkpoint),
          })),
          checkpoint,
          seam ? { seam, independentAxes } : undefined,
        )
      : undefined;
    const supportedPlane = Boolean(localPlane) && decompositionIntent?.admitted === true;
    let geometryConfidence =
      componentConfidence > 0 ? componentConfidence : (localPlane?.confidence ?? 0);
    if (semanticConfidence < SEMANTIC_WORK_LIMITS.semanticConfidence) {
      quality = 'LOW_CONFIDENCE';
      reason = 'Semantic evidence is uncertain';
    } else if (
      ranks.length > 0 &&
      (answer.object.confidence >= SEMANTIC_WORK_LIMITS.semanticConfidence ||
        (componentConfidence >= SEMANTIC_WORK_LIMITS.coverage && exactLeafEvidence))
    ) {
      quality = 'READY';
      operation = SuggestionOperation.Component;
      geometryConfidence = componentConfidence;
      reason =
        directFamily.state === 'COMPLETE'
          ? 'Independent semantic instance footprints define exact family source membership'
          : familyCompletion?.ranks.length
            ? familyCompletion.reason
            : 'Independent source components supported in multiple visible views';
    } else if (
      planeSemanticConfidence >= SEMANTIC_WORK_LIMITS.semanticConfidence &&
      supportedPlane &&
      part.cut &&
      part.importance === 'major' &&
      part.instances === 1 &&
      part.expectedGeometry.kind !== 'surface_part'
    ) {
      quality = 'READY';
      operation = SuggestionOperation.Plane;
      const magnitude = Math.hypot(...part.cut.normal);
      plane = {
        normal: part.cut.normal.map((n) => n / magnitude) as unknown as Vec3,
        origin: toSourcePoint(geometry, part.cut.origin),
      };
      geometryConfidence = localPlane?.confidence ?? purity ?? 0;
      reason = 'Approximate semantic boundary supported locally; Preview must validate the cut';
    }
    const groups =
      operation === SuggestionOperation.Component && part.instances > 1
        ? directFamily.state === 'COMPLETE'
          ? (instanceGroups(ranks, part.instances, facts, checkpoint) ??
            ranks.map((rank) => [rank]))
          : instanceGroups(ranks, part.instances, facts, checkpoint)
        : undefined;
    if (operation === SuggestionOperation.Component && part.instances > 1 && !groups) {
      operation = SuggestionOperation.None;
      quality = 'LOW_CONFIDENCE';
      geometryConfidence = 0;
      reason =
        'Repeated instances are not independently resolved by spatial and similarity evidence';
    }
    const dominant = facts.find((f) => f.areaShare >= 0.995);
    const confirmedFused =
      operation === SuggestionOperation.None &&
      semanticConfidence >= SEMANTIC_WORK_LIMITS.semanticConfidence &&
      part.expectedGeometry.kind !== 'solid_part' &&
      dominant !== undefined &&
      hitTotals.filter(
        (total, vi) =>
          total >= 8 &&
          (hits[vi]?.[dominant.rank] ?? 0) / total >= 0.98 &&
          (scores.find((s) => s.rank === dominant.rank)?.viewCoverage[vi] ?? 1) <
            SEMANTIC_WORK_LIMITS.coverage,
      ).length >= 2;
    const mappingEvidence =
      (part.instances > 1 && scores.some((score) => score.strongViews > 0)) ||
      (sourceShare > 0 && sourceShare < 0.995) ||
      familyCompletion !== undefined ||
      part.cut !== null ||
      part.componentIds.length > 0;
    const s: Suggestion = {
      id: part.id,
      family: 'semantic',
      label:
        operation === SuggestionOperation.Plane &&
        localPlane?.scope === 'assembly' &&
        !/\bassembly\b/i.test(part.label)
          ? `${part.label.slice(0, 55)} assembly`
          : part.label,
      operation,
      status: quality === 'READY' ? SuggestionStatus.Suggested : SuggestionStatus.Unavailable,
      reason: quality === 'READY' ? SuggestionReason.Clear : SuggestionReason.FusedIntoBody,
      plane,
      ...(operation === SuggestionOperation.Plane
        ? {
            semanticFinalists: [
              ...(plane ? [plane] : []),
              ...(localPlane?.finalists ?? [])
                .filter(
                  (cut) =>
                    cut.independentComplement ||
                    ((decompositionIntent?.rule === 'STRUCTURAL_SEAM' ||
                      decompositionIntent?.rule === 'BOTH') &&
                      cut.capturedFraction <=
                        SEMANTIC_INTENT_LIMITS.maximumSelectedSourceSampleShare &&
                      seamSupportsPlane(refined, cut, seam)),
                )
                .map((cut) => ({
                  normal: cut.normal,
                  origin: toSourcePoint(geometry, cut.origin),
                })),
            ]
              .filter(
                (cut, index, all) =>
                  all.findIndex((c) => JSON.stringify(c) === JSON.stringify(cut)) === index,
              )
              .slice(0, 3),
          }
        : {}),
      components: operation === SuggestionOperation.Component ? ranks : [],
      parentId: part.parentId,
      importance: part.importance,
      semanticConfidence,
      geometryConfidence,
      quality,
      // Missing/unsupported grounding is not proof of fusion. This field only selects copy.
      ...(operation === SuggestionOperation.None
        ? {
            diagnostic: confirmedFused
              ? ('CONFIRMED_FUSED' as const)
              : mappingEvidence
                ? ('MAPPING_UNCERTAIN' as const)
                : ('NO_REALIZATION_PROPOSAL' as const),
          }
        : {}),
      instanceCount: part.instances,
    };
    suggestions.push(s);
    evidence.push({
      id: part.id,
      synthesis: required(planeContext.synthesis.get(part.id), 'plane synthesis diagnostics'),
      ...(decompositionIntent ? { decompositionIntent } : {}),
      confidence: {
        objectConfidence: answer.object.confidence,
        partSemanticConfidence: part.confidence,
        geometryConfidence,
        realizationConfidence:
          operation === SuggestionOperation.None
            ? 0
            : Math.min(part.confidence, geometryConfidence),
      },
      ...(familyCompletion ? { familyCompletion } : {}),
      ...(directFamily.evaluated ? { directFamily } : {}),
      ...(familySubset ? { familySubset } : {}),
      viewEvidence: scores.map((score) => ({
        rank: score.rank,
        views: VIEW_NAMES.map((view, vi) => {
          const visible = visibleTotals[vi]?.[score.rank] ?? 0,
            projected = prepared.projectedTotals[vi]?.[score.rank] ?? 0,
            coverage = score.viewCoverage[vi] ?? -1;
          const state =
            visible < 8 || (visible < 64 && projected >= 8 && visible / projected < 0.1)
              ? ('OCCLUDED' as const)
              : !mentioned.has(view)
                ? ('OMITTED' as const)
                : coverage >= SEMANTIC_WORK_LIMITS.coverage
                  ? ('POSITIVE' as const)
                  : familyCompletion?.ranks.includes(score.rank) && coverage === 0
                    ? ('FAMILY_INSTANCE_OMITTED' as const)
                    : ('CONTRADICTORY' as const);
          return { view, state, coverage };
        }),
      })),
      visibility,
      regionInstances,
      ...(localPlane ? { localPlane } : {}),
      ...(refined ? { refinement: refined } : {}),
      components: scores,
      multiViewFaces,
      visibleFaces,
      planePurity: purity,
      reason,
    });
    if (operation === SuggestionOperation.None && directFamily.state === 'PARTIAL') {
      let depth = 1,
        parent = part.parentId;
      while (parent !== null) {
        depth++;
        parent = partById.get(parent)?.parentId ?? null;
      }
      if (depth < SEMANTIC_LIMITS.depth) {
        partialFamilies.set(part.id, directFamily.ranks);
      }
    }
    if (operation === SuggestionOperation.Component && part.instances > 1) {
      if (groups) {
        const instances = groups.map((group) => {
          const area = group.reduce((sum, r) => sum + required(facts[r], 'facts[r]').area, 0);
          return {
            centroid: [0, 1, 2].map(
              (a) =>
                group.reduce(
                  (sum, r) =>
                    sum +
                    (required(facts[r], 'facts[r]').centroid[a] ?? 0) *
                      required(facts[r], 'facts[r]').area,
                  0,
                ) / area,
            ) as unknown as Vec3,
            area,
            faces: group.reduce((sum, r) => sum + required(facts[r], 'facts[r]').faces, 0),
            mirroredAxes: [] as number[],
          };
        });
        const centre = [0, 1, 2].map(
          (a) => instances.reduce((sum, i) => sum + (i.centroid[a] ?? 0), 0) / instances.length,
        );
        for (const instance of instances)
          for (let axis = 0; axis < 3; axis++) {
            const reflected = instance.centroid.map((x, a) =>
              a === axis ? 2 * (centre[a] ?? 0) - x : x,
            );
            if (Math.abs((instance.centroid[axis] ?? 0) - (centre[axis] ?? 0)) < 0.015) continue;
            if (
              instances.some(
                (other) =>
                  other !== instance &&
                  Math.max(other.area, instance.area) / Math.min(other.area, instance.area) < 1.5 &&
                  Math.hypot(...other.centroid.map((x, a) => x - (reflected[a] ?? 0))) < 0.025,
              )
            )
              instance.mirroredAxes.push(axis);
          }
        evidence[evidence.length - 1] = {
          ...required(evidence[evidence.length - 1], 'evidence[evidence.length - 1]'),
          instances,
        };
        let depth = 1,
          parent = part.parentId;
        while (parent !== null) {
          depth++;
          parent = partById.get(parent)?.parentId ?? null;
        }
        if (depth < SEMANTIC_LIMITS.depth)
          for (const [i, group] of groups.entries())
            suggestions.push({
              ...s,
              id: `${s.id}:instance-${String(i + 1)}`,
              label: `${s.label.slice(0, 60)} ${String(i + 1)}`,
              parentId: s.id,
              importance: 'detail',
              components: group,
              instanceCount: 1,
            });
      }
    }
  }
  // Collect the unchanged negative-ownership claims before membership scoping, so a
  // candidate cannot use its own post-membership family reservation as corroboration.
  const identityClaims =
    partialFamilies.size > 0 && [...partialFamilies.values()].some((ranks) => ranks.length <= 2)
      ? buildSemanticReservations(
          prepared,
          answer,
          evidence,
          getSignatures,
          checkpoint,
          planeContext.charge,
          false,
        )
      : undefined;
  // Physical mapping is complete; qualify membership before creating any partial child.
  for (const [id, physicalRanks] of [...partialFamilies]) {
    checkpoint();
    const part = required(partById.get(id), 'partial family');
    let membership = qualifyPartialFamilyMembership(
      prepared,
      part,
      physicalRanks,
      answer.parts,
      evidence,
      getSignatures,
      checkpoint,
      planeContext.charge,
    );
    if (physicalRanks.length <= 2) {
      const identity = qualifyFamilyIdentity(
        prepared,
        part,
        required(
          evidence.find((e) => e.id === id),
          'identity evidence',
        ),
        membership,
        identityClaims?.reservations ?? [],
        getSignatures,
        checkpoint,
        planeContext.charge,
      );
      membership = {
        ...membership,
        identity,
        qualifiedRanks: identity.qualifiedRanks,
        rejectedRanks: physicalRanks.filter((rank) => !identity.qualifiedRanks.includes(rank)),
      };
    }
    const ei = evidence.findIndex((e) => e.id === id);
    evidence[ei] = {
      ...required(evidence[ei], 'partial evidence'),
      partialFamilyMembership: membership,
    };
    const si = suggestions.findIndex((s) => s.id === id),
      root = required(suggestions[si], 'partial root');
    partialFamilies.delete(id);
    if (!membership.qualifiedRanks.length) continue;
    partialFamilies.set(id, membership.qualifiedRanks);
    suggestions[si] = {
      ...root,
      label: `${root.label.slice(0, 50)} (${String(membership.qualifiedRanks.length)} parts found)`,
    };
    for (const rank of membership.qualifiedRanks) {
      checkpoint();
      const i = physicalRanks.indexOf(rank),
        coverage =
          required(evidence[ei], 'partial evidence')
            .components.find((s) => s.rank === rank)
            ?.viewCoverage.filter((v) => v >= SEMANTIC_WORK_LIMITS.coverage) ?? [];
      suggestions.push({
        id: `${id}:instance-${String(i + 1)}`,
        family: 'semantic',
        label: `${root.label.slice(0, 60)} ${String(i + 1)}`,
        parentId: id,
        importance: 'detail',
        operation: SuggestionOperation.Component,
        status: SuggestionStatus.Suggested,
        reason: SuggestionReason.Clear,
        quality: 'READY',
        plane: null,
        components: [rank],
        semanticConfidence: part.confidence,
        geometryConfidence: coverage.reduce((n, v) => n + v, 0) / coverage.length,
        instanceCount: 1,
      });
    }
  }
  const suggestionById = new Map(suggestions.map((s) => [s.id, s]));
  const ancestor = (a: Suggestion, b: Suggestion): boolean => {
    let parent = b.parentId;
    for (let depth = 0; parent && depth < SEMANTIC_LIMITS.depth; depth++) {
      if (parent === a.id) return true;
      parent = suggestionById.get(parent)?.parentId;
    }
    return false;
  };
  let ownershipWork = 0;
  const ownershipStart = Date.now();
  const chargeOwnership = (): void => {
    ownershipWork++;
    if (++work > SEMANTIC_WORK_LIMITS.regionPixels)
      throw resourceLimitExceeded('The semantic regions exceed the supported work limit.');
  };
  const reservation = buildSemanticReservations(
    prepared,
    answer,
    evidence,
    getSignatures,
    checkpoint,
    chargeOwnership,
  );
  const ownershipSuggestions = suggestions.map((s) => {
    const components = partialFamilies.get(s.id);
    return components
      ? { ...s, operation: SuggestionOperation.Component, quality: 'READY' as const, components }
      : s;
  });
  const extents = componentSemanticExtents(
    prepared,
    answer,
    ownershipSuggestions,
    ownershipSupport,
    checkpoint,
    chargeOwnership,
    reservation.reservations,
  );
  const ownershipMilliseconds = Date.now() - ownershipStart;
  const extentRefused = new Set([...extents].filter(([, e]) => !e.admitted).map(([id]) => id));
  for (const s of suggestions)
    if (!partById.has(s.id) && s.parentId && extentRefused.has(s.parentId)) extentRefused.add(s.id);
  const ambiguousEvidence = new Set<string>();
  const refused = new Set<string>(extentRefused);
  for (let i = 0; i < answer.parts.length; i++)
    for (let j = i + 1; j < answer.parts.length; j++) {
      const a = defined(answer.parts[i]),
        b = defined(answer.parts[j]);
      if (
        a.parentId === b.parentId &&
        JSON.stringify(a.views) === JSON.stringify(b.views) &&
        a.views.length > 0
      ) {
        refused.add(a.id);
        refused.add(b.id);
        ambiguousEvidence.add(a.id);
        ambiguousEvidence.add(b.id);
      }
    }
  for (let i = 0; i < suggestions.length; i++)
    for (let j = i + 1; j < suggestions.length; j++) {
      const a = required(suggestions[i], 'suggestions[i]'),
        b = required(suggestions[j], 'suggestions[j]');
      if (
        a.operation === SuggestionOperation.Component &&
        b.operation === SuggestionOperation.Component &&
        !extentRefused.has(a.id) &&
        !extentRefused.has(b.id) &&
        !ancestor(a, b) &&
        !ancestor(b, a) &&
        a.components.some((r) => b.components.includes(r))
      ) {
        refused.add(a.id);
        refused.add(b.id);
      }
    }
  const checkSiblingOwnership = (
    choices: readonly Suggestion[],
    initial: ReadonlySet<string>,
  ): Set<string> => {
    const suggestions = choices;
    const refused = new Set(initial);
    // One bounded source-face pass rejects shared sibling ownership across component and plane paths.
    // Plane boundaries may share preview caps intentionally, but no source face is claimed by two sibling interiors.
    const planes = suggestions.filter((s) => s.operation === SuggestionOperation.Plane && s.plane);
    if (planes.length > 0) {
      const owners = new Map<number, Suggestion[]>();
      for (const s of suggestions)
        if (s.operation === SuggestionOperation.Component && !refused.has(s.id))
          for (const rank of s.components) owners.set(rank, [...(owners.get(rank) ?? []), s]);
      const claimed: Suggestion[] = [];
      const coefficients = planes.map((s) => {
        const p = required(s.plane, 's.plane');
        return {
          suggestion: s,
          normal: p.normal,
          offset: p.normal.reduce(
            (sum, n, a) =>
              sum + (n * ((p.origin[a] ?? 0) - (geometry.center[a] ?? 0))) / geometry.scale,
            0,
          ),
        };
      });
      for (let f = 0; f < geometry.faceCount; f++) {
        if (f % CHECKPOINT_STRIDE === 0) checkpoint();
        if (!planes.some((s) => !refused.has(s.id))) break;
        let x = 0,
          y = 0,
          z = 0;
        for (let k = 0; k < 3; k++) {
          const v = (geometry.indices[f * 3 + k] ?? 0) * 3;
          x += (geometry.positions[v] ?? 0) / 3;
          y += (geometry.positions[v + 1] ?? 0) / 3;
          z += (geometry.positions[v + 2] ?? 0) / 3;
        }
        claimed.length = 0;
        for (const p of coefficients)
          if (
            !refused.has(p.suggestion.id) &&
            x * p.normal[0] + y * p.normal[1] + z * p.normal[2] - p.offset > 1e-7
          )
            claimed.push(p.suggestion);
        const componentOwners = owners.get(labelling.faceRank[f] ?? -1);
        if (componentOwners) for (const owner of componentOwners) claimed.push(owner);
        for (let i = 0; i < claimed.length; i++)
          for (let j = i + 1; j < claimed.length; j++) {
            const a = required(claimed[i], 'claimed[i]'),
              b = required(claimed[j], 'claimed[j]');
            if (!ancestor(a, b) && !ancestor(b, a)) {
              // Exact source groups take precedence. Conflicting synthesized cuts are alternatives,
              // not simultaneously owned source faces: retain only the stronger supported proposal.
              if (a.operation === SuggestionOperation.Component) refused.add(b.id);
              else if (b.operation === SuggestionOperation.Component) refused.add(a.id);
              else {
                const order =
                  (a.semanticConfidence ?? 0) - (b.semanticConfidence ?? 0) ||
                  (a.geometryConfidence ?? 0) - (b.geometryConfidence ?? 0) ||
                  b.id.localeCompare(a.id);
                refused.add(order >= 0 ? b.id : a.id);
              }
            }
          }
      }
    }
    return refused;
  };
  const initialRefused = new Set(refused);
  const planes = suggestions.filter((s) => s.operation === SuggestionOperation.Plane && s.plane);
  for (const id of checkSiblingOwnership(suggestions, initialRefused)) refused.add(id);
  const shared = new Map<string, NonNullable<Suggestion['sharedBoundary']>>();
  const sharedPools = new Map<string, NonNullable<Suggestion['semanticFinalists']>>();
  for (const pair of complementary.pairs) {
    checkpoint();
    const a = suggestions.find((s) => s.id === pair.primaryId),
      b = suggestions.find((s) => s.id === pair.complementId);
    if (
      !a ||
      !b ||
      a.operation !== SuggestionOperation.Plane ||
      b.operation !== SuggestionOperation.Plane ||
      refused.has(a.id) ||
      refused.has(b.id)
    ) {
      refused.add(pair.primaryId);
      refused.add(pair.complementId);
      continue;
    }
    const pool = (a.semanticFinalists ?? []).filter((cut, index) => {
      if (index === 0) return true;
      faceWork += geometry.faceCount;
      if (faceWork > SEMANTIC_WORK_LIMITS.scoredFaces)
        throw resourceLimitExceeded(
          'The semantic correspondence exceeds the supported work limit.',
        );
      const complement = {
        normal: cut.normal.map((n) => -n) as unknown as Vec3,
        origin: cut.origin,
      };
      const checked = checkSiblingOwnership(
        suggestions.map((s) =>
          s.id === a.id ? { ...s, plane: cut } : s.id === b.id ? { ...s, plane: complement } : s,
        ),
        initialRefused,
      );
      return (
        !checked.has(a.id) && !checked.has(b.id) && [...checked].every((id) => refused.has(id))
      );
    });
    if (!pool.length) {
      refused.add(a.id);
      refused.add(b.id);
      continue;
    }
    sharedPools.set(a.id, pool);
    sharedPools.set(
      b.id,
      pool.map((cut) => ({
        normal: [-cut.normal[0], -cut.normal[1], -cut.normal[2]],
        origin: cut.origin,
      })),
    );
    shared.set(a.id, { key: pair.key, primaryId: a.id, complementId: b.id, side: 'PRIMARY' });
    shared.set(b.id, { key: pair.key, primaryId: a.id, complementId: b.id, side: 'COMPLEMENT' });
  }
  for (const e of evidence)
    if (refused.has(e.id)) {
      const index = evidence.indexOf(e);
      evidence[index] = {
        ...e,
        reason: extentRefused.has(e.id)
          ? 'Semantic part extent could not be isolated reliably'
          : 'Overlapping sibling source membership refused',
      };
    }
  const resolved = suggestions.map((s) =>
    refused.has(s.id)
      ? {
          ...s,
          operation: SuggestionOperation.None,
          status: SuggestionStatus.Unavailable,
          quality:
            extentRefused.has(s.id) && !ambiguousEvidence.has(s.id)
              ? ('RECOGNIZED_NOT_SEPARABLE' as const)
              : ('UNSAFE' as const),
          ...(extentRefused.has(s.id) && !ambiguousEvidence.has(s.id)
            ? { diagnostic: 'MAPPING_UNCERTAIN' as const }
            : {}),
          plane: null,
          components: [],
          geometryConfidence: 0,
        }
      : s,
  );
  // READY for exact component partitions; planes need authoritative Preview first.
  const published = resolved.map((s) =>
    s.operation === SuggestionOperation.Plane && s.quality === 'READY'
      ? {
          ...s,
          quality: 'SUGGESTED' as const,
          ...(shared.has(s.id)
            ? { sharedBoundary: required(shared.get(s.id), 'shared boundary') }
            : {}),
          semanticFinalists:
            sharedPools.get(s.id) ??
            (s.semanticFinalists ?? []).filter((cut, index) => {
              if (index === 0 || !s.plane) return true;
              // A fallback cannot introduce ownership outside this already-admitted source selection.
              const epsilon = geometry.scale * 1e-7;
              for (let f = 0; f < geometry.faceCount; f++) {
                if ((f & 255) === 0) checkpoint();
                if (++faceWork > SEMANTIC_WORK_LIMITS.scoredFaces)
                  throw resourceLimitExceeded(
                    'The semantic correspondence exceeds the supported work limit.',
                  );
                let before = 0,
                  after = 0;
                for (let a = 0; a < 3; a++) {
                  let x = 0;
                  for (let k = 0; k < 3; k++)
                    x += (geometry.positions[(geometry.indices[f * 3 + k] ?? 0) * 3 + a] ?? 0) / 3;
                  x = x * geometry.scale + (geometry.center[a] ?? 0);
                  before += (x - (s.plane.origin[a] ?? 0)) * (s.plane.normal[a] ?? 0);
                  after += (x - (cut.origin[a] ?? 0)) * (cut.normal[a] ?? 0);
                }
                if (after > epsilon && before < -epsilon) return false;
              }
              return true;
            }),
        }
      : s,
  );
  return {
    complementaryPairs: complementary.pairs.filter((p) => shared.has(p.primaryId)),
    ambiguousComplementaryPairs: [...complementary.ambiguous].sort(),
    ...(complementary.diagnostic
      ? { complementaryPairingDiagnostic: complementary.diagnostic }
      : {}),
    reservations: reservation.reservations,
    suggestions: published,
    candidates: published.map((s) => ({
      id: s.id,
      label: s.label,
      parentId: s.parentId ?? null,
      semanticConfidence: s.semanticConfidence ?? 0,
      geometryConfidence: s.geometryConfidence ?? 0,
      instances: s.instanceCount ?? 1,
      quality: s.quality ?? 'UNSAFE',
      realization:
        s.operation === SuggestionOperation.Component
          ? { kind: 'existing-components' as const, ranks: s.components }
          : s.operation === SuggestionOperation.Plane && s.plane
            ? { kind: 'plane-cut' as const, ...s.plane }
            : s.quality !== 'RECOGNIZED_NOT_SEPARABLE'
              ? { kind: 'unavailable' as const, executable: false as const }
              : partById.get(s.id)?.expectedGeometry.kind === 'surface_part'
                ? { kind: 'recognized-feature' as const, executable: false as const }
                : {
                    kind: 'local-cut-required' as const,
                    regions: partById.get(s.id)?.views ?? [],
                    executable: false as const,
                  },
    })),
    components: prepared.metadata.components.map((c) => ({
      rank: Number(c.id.slice(1)),
      faces: c.faceCount,
      areaShare: c.areaShare,
    })),
    componentCount: labelling.count,
    faceCount: geometry.faceCount,
    objectLabel: answer.object.label,
    evidence: evidence.map((e) => {
      const result = published.find((s) => s.id === e.id);
      return e.confidence
        ? {
            ...e,
            ...(extents.has(e.id)
              ? { semanticExtent: required(extents.get(e.id), 'semantic extent') }
              : {}),
            confidence: {
              ...e.confidence,
              realizationConfidence:
                result?.quality === 'READY'
                  ? Math.min(result.semanticConfidence ?? 0, result.geometryConfidence ?? 0)
                  : 0,
            },
          }
        : e;
    }),
    timings: {
      ...prepared.timings,
      correspondence: elapsed(start) - refinement.milliseconds,
      refinement: refinement.milliseconds,
      refinementTriangleVisits: refinement.triangleVisits,
      regionPixels: work,
      scoredFaces: faceWork,
      familySubsetCount: evidence.reduce((n, e) => n + (e.familySubset?.subsets ?? 0), 0),
      familySubsetComparisons: evidence.reduce((n, e) => n + (e.familySubset?.comparisons ?? 0), 0),
      familySubsetWork: evidence.reduce((n, e) => n + (e.familySubset?.workUnits ?? 0), 0),
      familySubsetMilliseconds: evidence.reduce((n, e) => n + (e.familySubset?.workerMs ?? 0), 0),
      familySubsetTypedScratchBytes: 0,
      partialMembershipDirectMembers: evidence.reduce(
        (n, e) => n + (e.partialFamilyMembership?.physicalRanks.length ?? 0),
        0,
      ),
      partialMembershipSubsets: evidence.reduce(
        (n, e) => n + (e.partialFamilyMembership?.subsets ?? 0),
        0,
      ),
      partialMembershipOutliers: evidence.reduce(
        (n, e) => n + (e.partialFamilyMembership?.rejectedRanks.length ?? 0),
        0,
      ),
      partialMembershipComparisons: evidence.reduce(
        (n, e) => n + (e.partialFamilyMembership?.comparisons ?? 0),
        0,
      ),
      partialMembershipWork: evidence.reduce(
        (n, e) => n + (e.partialFamilyMembership?.workUnits ?? 0),
        0,
      ),
      partialMembershipTypedScratchBytes: 0,
      partialMembershipMilliseconds: evidence.reduce(
        (n, e) => n + (e.partialFamilyMembership?.milliseconds ?? 0),
        0,
      ),
      semanticIntentWork: evidence.reduce((n, e) => n + (e.decompositionIntent?.workUnits ?? 0), 0),
      semanticIntentTypedScratchBytes: 0,
      directFamilyMembersEvaluated: evidence.reduce(
        (n, e) => n + (e.directFamily?.evaluated ?? 0),
        0,
      ),
      directFamilyMembersProven: evidence.reduce(
        (n, e) => n + (e.directFamily?.ranks.length ?? 0),
        0,
      ),
      directFamilyWork: evidence.reduce((n, e) => n + (e.directFamily?.workUnits ?? 0), 0),
      directFamilyComparisons: evidence.reduce((n, e) => n + (e.directFamily?.comparisons ?? 0), 0),
      directFamilyTypedScratchBytes: 0,
      directFamilyMilliseconds: evidence.reduce(
        (n, e) => n + (e.directFamily?.milliseconds ?? 0),
        0,
      ),
      familyCandidatesConsidered: evidence.reduce(
        (n, e) => n + (e.familyCompletion?.candidatesConsidered ?? 0),
        0,
      ),
      familySimilarityComparisons: evidence.reduce(
        (n, e) => n + (e.familyCompletion?.comparisons ?? 0),
        0,
      ),
      familyCompletionMilliseconds: evidence.reduce(
        (n, e) => n + (e.familyCompletion?.workerMs ?? 0),
        0,
      ),
      familySignatureFaces: signatures?.facesVisited ?? 0,
      familySignatureBytes: signatures?.bytes ?? 0,
      complementaryDiscoveryMilliseconds: complementary.discoveryMilliseconds,
      complementaryCrossScoreMilliseconds: complementary.crossScoreMilliseconds,
      complementaryPairs: complementary.pairs.length,
      complementaryMaxCandidates: Math.max(0, ...complementary.pairs.map((p) => p.candidates)),
      semanticPlaneOwnershipWork: planeOwnership.workUnits,
      semanticPlaneOwnershipMilliseconds: planeOwnershipMilliseconds,
      semanticPlaneOwnershipPeers: planeOwnership.peers,
      semanticPlaneOwnershipNormals: planeOwnership.normals,
      semanticPlaneOwnershipOffsets: planeOwnership.offsets,
      semanticPlaneOwnershipHistogramBins: planeOwnership.histogramBins,
      semanticPlaneOwnershipTypedScratchUpperBoundBytes: planeOwnership.scratchBytes,
      semanticPlaneOwnershipObservations: planeOwnership.observations,
      semanticPlaneOwnershipFinalists: planeOwnership.finalists,
      semanticPlaneOwnershipPeerScoringPasses: planeOwnership.peerScoringPasses,
      semanticPlaneOwnershipRankingComparisons: planeOwnership.rankingComparisons,
      semanticReservationParts: reservation.reservations.length,
      semanticReservedComponents: reservation.components,
      ...familyIdentityTimings(evidence, identityClaims),
      semanticReservationWork: reservation.workUnits + (identityClaims?.workUnits ?? 0),
      semanticReservationTypedScratchBytes: reservation.scratchBytes,
      semanticReservationMilliseconds: reservation.milliseconds,
      semanticOwnershipWork: ownershipWork,
      semanticOwnershipMilliseconds: ownershipMilliseconds,
      semanticOwnershipScratchUpperBoundBytes:
        ownershipSupport.reduce((n, b) => n + b.byteLength, 0) +
        rasters.length *
          prepared.metadata.components.length *
          (1 + answer.parts.length + (answer.parts.length * (answer.parts.length - 1)) / 2) *
          4 +
        rasters.length * answer.parts.length * 4 +
        answer.parts.length,
      siblingMembershipFaces: planes.length > 0 ? geometry.faceCount : 0,
    },
  };
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required bounded geometry evidence is missing.');
  return value;
}
