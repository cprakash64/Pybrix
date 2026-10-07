import { useCallback, useState, type ReactNode } from 'react';
import { useWorkspaceState } from '../src/state/store-context';
import { useModelImport } from '../src/state/use-model-import';
import { HarnessFixtureId, type HarnessFixtureId as FixtureId } from './fixtures';

/**
 * THE ONLY NON-PRODUCTION COMPONENT ON THE HARNESS PAGE.
 *
 * It loads a fixture and reports scalar state. It owns no geometry, holds no
 * document, and duplicates nothing: loading goes through the real
 * `useModelImport` hook, which goes through the real import service, the real
 * client, the real worker protocol and the real workspace store. What the
 * browser then draws is drawn entirely by production code.
 *
 * The readout exists because several properties under test are true or false in
 * the STORE rather than on screen — an active part id, a part count, a document
 * revision — and reading them from React state is more precise than inferring
 * them from rendered text.
 */

const FIXTURES: readonly { readonly id: FixtureId; readonly label: string }[] = [
  { id: HarnessFixtureId.LocalRepairPinch, label: 'Local repair: three pinches' },
  { id: HarnessFixtureId.LocalRepairResidual, label: 'Local repair: residual pinch' },
  { id: HarnessFixtureId.LocalRepairRefusal, label: 'Local repair: refused pinch' },
  { id: HarnessFixtureId.LocalRepairUnsupportedEdge, label: 'Local repair: unsupported edge' },
  { id: HarnessFixtureId.LocalRepairHeavy, label: 'Local repair: 400 pinches' },
  { id: HarnessFixtureId.TwoIndependentParts, label: 'Two independent parts' },
  { id: HarnessFixtureId.SharedPairApart, label: 'Shared pair, apart' },
  { id: HarnessFixtureId.SharedPairOverlapping, label: 'Shared pair, overlapping' },
  { id: HarnessFixtureId.ThreeTransformedParts, label: 'Three transformed parts' },
  { id: HarnessFixtureId.DefectAndClean, label: 'Defect + clean' },
  { id: HarnessFixtureId.CrossingAndOverlappingClean, label: 'Crossing + overlapping clean' },
  { id: HarnessFixtureId.SmallAndOversized, label: 'Small + oversized' },
  { id: HarnessFixtureId.Shared10, label: '10 shared placements' },
  { id: HarnessFixtureId.SevenSharedMillimetre, label: '7 shared parts (mm)' },
  { id: HarnessFixtureId.Shared100, label: '100 shared placements' },
  { id: HarnessFixtureId.Shared1000, label: '1000 shared placements' },
  { id: HarnessFixtureId.SinglePart, label: 'Single part' },
  { id: HarnessFixtureId.MillimetreTwoParts, label: 'Two parts (mm)' },
  { id: HarnessFixtureId.SplitCubeMillimetre, label: 'Split cube (mm)' },
  { id: HarnessFixtureId.SplitHeavySphereMillimetre, label: 'Heavy split sphere (mm)' },
  { id: HarnessFixtureId.SplitSmallSphereMillimetre, label: '10k split sphere (mm)' },
  { id: HarnessFixtureId.SplitLargeSphereMillimetre, label: '500k split sphere (mm)' },
  { id: HarnessFixtureId.MillimetreShared1000, label: '1000 shared (mm)' },
  { id: HarnessFixtureId.MillimetreLargeSinglePart, label: 'Large plate (mm)' },
  { id: HarnessFixtureId.MillimetreSharedMedium400, label: '400 medium shared (mm)' },
  { id: HarnessFixtureId.MillimetreSharedMedium1000, label: '1000 medium shared (mm)' },
  { id: HarnessFixtureId.HoleFillSmall, label: 'Hole fill: small' },
  { id: HarnessFixtureId.HoleFillLarge, label: 'Hole fill: large' },
  { id: HarnessFixtureId.HoleFillPierced, label: 'Hole fill: pierced' },
  { id: HarnessFixtureId.HoleFillSharedPair, label: 'Hole fill: shared pair' },
  { id: HarnessFixtureId.HoleFillTransformed, label: 'Hole fill: transformed' },
  { id: HarnessFixtureId.HoleFillSharedPairMillimetre, label: 'Hole fill: shared pair (mm)' },
  { id: HarnessFixtureId.HoleFillShared1000, label: 'Hole fill: 1000 shared' },
  { id: HarnessFixtureId.RepairSharedPairMillimetre, label: 'Repair: shared pair (mm)' },
  { id: HarnessFixtureId.RepairShared1000Millimetre, label: 'Repair: 1000 shared (mm)' },
  {
    id: HarnessFixtureId.RepairSharedIndexedPairMillimetre,
    label: 'Repair: shared indexed pair (mm)',
  },
];

/**
 * The fixture id, delivered the way a file is.
 *
 * A `File` because that is what `useModelImport` takes, which is what makes the
 * production import path reachable at all. Its bytes are the identifier text —
 * no geometry travels — and the `.stl` extension exists only so the production
 * filename screen, which reads nothing, lets it through to the worker.
 */
function fixtureFile(id: FixtureId): File {
  return new File([new TextEncoder().encode(id)], `${id}.stl`, { type: 'model/stl' });
}

export function HarnessBar(): ReactNode {
  const { model, activePartId, analysis, selfIntersection, repair } = useWorkspaceState();
  const { importFile, isImporting } = useModelImport();
  const [loadCount, setLoadCount] = useState(0);

  const load = useCallback(
    (id: FixtureId): void => {
      importFile(fixtureFile(id));
      setLoadCount((previous) => previous + 1);
    },
    [importFile],
  );

  /*
   * PER-PART ARRAYS ARE CAPPED, and that cap is not cosmetic.
   *
   * This readout is re-stringified on every store update. At a thousand
   * placements the uncapped version serialised several thousand entries into the
   * DOM during the very load a responsiveness test is measuring — so the probe
   * was contributing to the number it reported. A probe must not perturb what it
   * measures.
   *
   * `partCount` is uncapped and is what the assertions on scale use; the arrays
   * exist to identify a handful of parts by name, which never needs a thousand.
   */
  const SAMPLE = 8;
  const sample = <T,>(values: readonly T[] | undefined): readonly T[] =>
    (values ?? []).slice(0, SAMPLE);

  const state = {
    loaded: model !== undefined,
    loadCount,
    documentId: model?.handle.documentId,
    revision: model?.handle.revision,
    workspaceRevision: model?.revision,
    partCount: model?.parts.length ?? 0,
    partIds: sample(model?.parts.map((part) => part.partId)),
    partNames: sample(model?.parts.map((part) => part.name ?? null)),
    meshResourceIndices: sample(model?.parts.map((part) => part.meshResourceIndex)),
    triangleCounts: sample(model?.parts.map((part) => part.triangleCount)),
    distinctMeshResources: new Set(model?.parts.map((part) => part.meshResourceIndex)).size,
    documentTriangleCount: model?.triangleCount ?? 0,
    residentBytes: model?.residentBytes ?? 0,
    activePartId,
    analysisPartId: analysis.partId,
    analysisState: analysis.state,
    analysisFaceCount: analysis.report?.sourceFaceCount,
    analysisReportRevision: analysis.report?.documentRevision,
    analysisHandleRevision: analysis.handle?.revision,
    analysisNonManifoldVertices: analysis.report?.nonManifoldVertexCount,
    analysisWindingConflicts: analysis.report?.windingConflictEdgeCount,
    selfIntersectionPartId: selfIntersection.partId,
    selfIntersectionBand: selfIntersection.band,
    selfIntersectionStatus: selfIntersection.report?.status,
    selfIntersectionReportPartId: selfIntersection.report?.partId,
    repairPartId: repair.partId,
    repairCandidatePartId: repair.candidate?.partId,
    /*
     * STAGE 6E-A2 — what an import produced, as SCALARS, so a spec can compare
     * a buffered and a streamed import of one file field by field through the
     * whole pipeline: source facts, statistics, validation, and the render
     * snapshot the page actually received. Sums and counts, never coordinates.
     */
    formatId: model?.source.formatId,
    encoding: model?.source.encoding,
    unit: model?.source.unit ?? null,
    unsupportedFeatures: model?.source.unsupportedFeatures ?? [],
    externalReferenceCount: model?.source.externalReferences.length ?? 0,
    warningCodes: (model?.warnings ?? []).map((warning) => warning.code),
    bounds: model?.bounds ?? null,
    vertexCount: model?.vertexCount ?? 0,
    validationValid: model?.validation.valid ?? null,
    validationIssueCount: model?.validation.issueCount ?? 0,
    renderPartCount: model?.render.parts.length ?? 0,
    renderVertexCount: (model?.render.parts ?? []).reduce((sum, part) => sum + part.vertexCount, 0),
    renderPositionFloats: (model?.render.parts ?? []).reduce(
      (sum, part) => sum + part.positions.length,
      0,
    ),
  };

  return (
    <section data-testid="harness-bar" style={{ padding: '8px', fontSize: '12px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        {FIXTURES.map((fixture) => (
          <button
            key={fixture.id}
            type="button"
            data-testid={`harness-load-${fixture.id}`}
            disabled={isImporting}
            onClick={() => {
              load(fixture.id);
            }}
          >
            {fixture.label}
          </button>
        ))}
      </div>
      {/* Scalar state only. No geometry reaches this element. */}
      <pre data-testid="harness-state" style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(state)}
      </pre>
    </section>
  );
}
