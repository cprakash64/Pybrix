import { expect, type Page } from '@playwright/test';

/**
 * SHARED VOCABULARY FOR THE MULTI-PART BROWSER SUITE.
 *
 * Everything here reads state the application already publishes: the harness
 * bar's scalar readout, the canvas dataset the viewport writes for leak tests,
 * and the worker-side digest. Nothing simulates production behaviour, and
 * nothing reaches into React internals.
 */

/** Ids the harness bar can load. Mirrors `apps/web/e2e-harness/fixtures.ts`. */
export const Fixture = {
  TwoIndependentParts: 'two-independent-parts',
  SharedPairApart: 'shared-pair-apart',
  SharedPairOverlapping: 'shared-pair-overlapping',
  ThreeTransformedParts: 'three-transformed-parts',
  DefectAndClean: 'defect-and-clean',
  CrossingAndOverlappingClean: 'crossing-and-overlapping-clean',
  SmallAndOversized: 'small-and-oversized',
  Shared10: 'shared-10',
  SevenSharedMillimetre: 'seven-shared-millimetre',
  Shared100: 'shared-100',
  Shared1000: 'shared-1000',
  SinglePart: 'single-part',
  MillimetreTwoParts: 'millimetre-two-parts',
  SplitCubeMillimetre: 'split-cube-millimetre',
  SplitHeavySphereMillimetre: 'split-heavy-sphere-millimetre',
  SplitSmallSphereMillimetre: 'split-small-sphere-millimetre',
  SplitLargeSphereMillimetre: 'split-large-sphere-millimetre',
  MillimetreShared1000: 'millimetre-shared-1000',
  MillimetreLargeSinglePart: 'millimetre-large-single-part',
  MillimetreSharedMedium400: 'millimetre-shared-medium-400',
  MillimetreSharedMedium1000: 'millimetre-shared-medium-1000',
  HoleFillSmall: 'hole-fill-small',
  HoleFillLarge: 'hole-fill-large',
  HoleFillPierced: 'hole-fill-pierced',
  HoleFillSharedPair: 'hole-fill-shared-pair',
  HoleFillTransformed: 'hole-fill-transformed',
  HoleFillSharedPairMillimetre: 'hole-fill-shared-pair-mm',
  HoleFillShared1000: 'hole-fill-shared-1000',
  RepairSharedPairMillimetre: 'repair-shared-pair-mm',
  RepairShared1000Millimetre: 'repair-shared-1000-mm',
  RepairSharedIndexedPairMillimetre: 'repair-shared-indexed-pair-mm',
  LocalRepairPinch: 'local-repair-pinch',
  LocalRepairResidual: 'local-repair-residual',
  LocalRepairRefusal: 'local-repair-refusal',
  LocalRepairHeavy: 'local-repair-heavy',
  LocalRepairUnsupportedEdge: 'local-repair-unsupported-edge',
} as const;

export type Fixture = (typeof Fixture)[keyof typeof Fixture];

/** Distances baked into the fixtures, asserted rather than re-derived. */
export const PART_B_OFFSET_X = 10;
export const PART_C_OFFSET_Y = 7;

export interface HarnessState {
  readonly loaded: boolean;
  readonly loadCount: number;
  readonly documentId?: string;
  readonly revision?: number;
  readonly workspaceRevision?: number;
  readonly partCount: number;
  /** First few only — see `harness-bar.tsx`. Use `partCount` for scale. */
  readonly partIds: readonly string[];
  readonly partNames: readonly (string | null)[];
  readonly meshResourceIndices: readonly number[];
  /** Distinct mesh resources across the WHOLE document, uncapped. */
  readonly distinctMeshResources: number;
  readonly triangleCounts: readonly number[];
  readonly documentTriangleCount: number;
  readonly residentBytes: number;
  readonly activePartId?: string;
  readonly analysisPartId?: string;
  readonly analysisState: string;
  readonly analysisFaceCount?: number;
  readonly analysisReportRevision?: number;
  readonly analysisHandleRevision?: number;
  readonly analysisNonManifoldVertices?: number;
  readonly analysisWindingConflicts?: number;
  readonly selfIntersectionPartId?: string;
  readonly selfIntersectionBand: string;
  readonly selfIntersectionStatus?: string;
  readonly selfIntersectionReportPartId?: string;
  readonly repairPartId?: string;
  readonly repairCandidatePartId?: string;
  /** Stage 6E-A2 — import facts, as scalars. See `harness-bar.tsx`. */
  readonly formatId?: string;
  readonly encoding?: string;
  readonly unit: string | null;
  readonly unsupportedFeatures: readonly string[];
  readonly externalReferenceCount: number;
  readonly warningCodes: readonly string[];
  readonly bounds: unknown;
  readonly vertexCount: number;
  readonly validationValid: boolean | null;
  readonly validationIssueCount: number;
  readonly renderPartCount: number;
  readonly renderVertexCount: number;
  readonly renderPositionFloats: number;
}

/** Everything the viewport publishes about what it actually drew. */
export interface SceneStats {
  readonly drawCalls: number;
  readonly renderedTriangles: number;
  /** One per PART. A shared mesh still produces one object per placement. */
  readonly modelObjects: number;
  /** Distinct GPU geometries currently uploaded. Shared parts collapse here. */
  readonly sharedGeometries: number;
  readonly geometriesCreated: number;
  readonly geometriesDisposed: number;
  readonly previewObjects: number;
  readonly overlayObjects: number;
  /** Rim and patch objects currently drawn. Stage 4B-1B2. */
  readonly holeFillOverlayObjects: number;
  /** Cumulative rim/patch uploads and releases, so a leak is visible. */
  readonly holeFillOverlaysCreated: number;
  readonly holeFillOverlaysDisposed: number;
  /** The workspace model revision the viewport has actually drawn. */
  readonly modelRevision: number;
  /** `partId:x,y,z` per part, from `matrixWorld`. World placement, as drawn. */
  readonly partTransforms: string;
}

export interface PartDigest {
  readonly partId: string;
  readonly meshResourceIndex: number;
  readonly transform: readonly number[];
  readonly positionBytes: number;
  readonly indexBytes: number;
  readonly positionDigest: string;
  readonly indexDigest: string;
}

export interface DocumentDigest {
  readonly ok: boolean;
  readonly distinctMeshes?: number;
  readonly parts: readonly PartDigest[];
}

export async function readState(page: Page): Promise<HarnessState> {
  const text = await page.getByTestId('harness-state').textContent();
  return JSON.parse(text ?? '{}') as HarnessState;
}

export async function readScene(page: Page): Promise<SceneStats> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const read = (key: string): number => Number(canvas?.dataset[key] ?? 0);
    return {
      drawCalls: read('drawCalls'),
      renderedTriangles: read('renderedTriangles'),
      modelObjects: read('modelObjects'),
      sharedGeometries: read('sharedGeometries'),
      geometriesCreated: read('geometriesCreated'),
      geometriesDisposed: read('geometriesDisposed'),
      previewObjects: read('previewObjects'),
      overlayObjects: read('overlayObjects'),
      holeFillOverlayObjects: read('holeFillOverlayObjects'),
      holeFillOverlaysCreated: read('holeFillOverlaysCreated'),
      holeFillOverlaysDisposed: read('holeFillOverlaysDisposed'),
      modelRevision: read('modelRevision'),
      partTransforms: canvas?.dataset.partTransforms ?? '',
    };
  });
}

/**
 * The world translation the renderer resolved for one part.
 *
 * Read from `matrixWorld`, so it reflects the display-centring offset composed
 * with the part's own placement — which is what the user actually sees, and what
 * a transposed matrix convention would get wrong.
 */
export function worldTranslation(
  stats: SceneStats,
  partId: string,
): readonly [number, number, number] | undefined {
  for (const entry of stats.partTransforms.split('|')) {
    const [id, values] = entry.split(':');
    if (id !== partId || values === undefined) continue;
    const parts = values.split(',').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  }
  return undefined;
}

export async function digest(page: Page, state: HarnessState): Promise<DocumentDigest> {
  const documentId = state.documentId;
  const revision = state.revision;
  if (documentId === undefined || revision === undefined) {
    throw new Error('cannot digest: no document is loaded');
  }
  return page.evaluate(
    async (target: { readonly id: string; readonly revision: number }) => {
      const harness = window.cadfixerHarness;
      if (harness === undefined) throw new Error('harness bridge is missing');
      return harness.digest(target.id, target.revision);
    },
    { id: documentId, revision },
  );
}

/**
 * Loads a fixture and waits until BOTH the workspace and the viewport hold it.
 *
 * THREE SYNCHRONISATION POINTS, and each one is load-bearing:
 *
 *   1. the click registered — the harness bar's own counter;
 *   2. a NEW DOCUMENT is committed. Not "a document is loaded": that is already
 *      true of the previous one, and an import is asynchronous, so a poll on it
 *      returns immediately with the old document's state. Every import commits a
 *      fresh document id, which cannot collide;
 *   3. the VIEWPORT has drawn that document. Part count is not a
 *      synchronisation point either — two consecutive fixtures can have the same
 *      number of parts — so this waits on the monotonic model revision echoed by
 *      the layer that actually drew it.
 *
 * Getting any of these wrong measures the previous document while believing it
 * is measuring this one, which is precisely how a lifecycle test reports
 * numbers that look plausible and mean nothing.
 */
export async function loadFixture(page: Page, fixture: Fixture): Promise<HarnessState> {
  const before = await readState(page);
  await page.getByTestId(`harness-load-${fixture}`).click();

  await expect
    .poll(async () => (await readState(page)).loadCount, { timeout: 60_000 })
    .toBe(before.loadCount + 1);

  await expect
    .poll(
      async () => {
        const state = await readState(page);
        return state.loaded && state.documentId !== before.documentId;
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  const loaded = await readState(page);
  await expect
    .poll(async () => (await readScene(page)).modelRevision, { timeout: 60_000 })
    .toBe(loaded.workspaceRevision);
  await expect
    .poll(async () => (await readScene(page)).modelObjects, { timeout: 60_000 })
    .toBe(loaded.partCount);

  return loaded;
}

export async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('harness-bar')).toBeVisible({ timeout: 60_000 });
  // Cross-origin isolation is a precondition for the repair workflow, and a
  // harness that quietly lost it would exercise the fail-closed path instead.
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
}
