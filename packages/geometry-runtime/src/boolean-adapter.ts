/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/restrict-template-expressions */
import {
  assertMeshStructure,
  MAX_SUPPORTED_SPLIT_TRIANGLES,
  meshByteLength,
  triangleCount,
  singlePartDocument,
  partId,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import {
  analyseTopology,
  estimateTopologyWorkspaceBytes,
  type TopologyReport,
} from '@cadfixer/mesh-topology';
import {
  invalidState,
  resourceLimitExceeded,
  throwIfCancelled,
  type CancellationToken,
} from '@cadfixer/shared';
import { validateGeometryEdit, DEFAULT_GEOMETRY_EDIT_LIMITS } from './geometry-edit';

export type BooleanKind = 'union' | 'difference' | 'intersection';
/** Backend is deliberately worker-only. It must never alter either input. */
export interface BooleanBackend {
  operate(
    kind: BooleanKind,
    a: CanonicalMesh,
    b: CanonicalMesh,
    cancellation: CancellationToken,
  ): Promise<CanonicalMesh>;
}
export interface BooleanResult {
  readonly mesh: CanonicalMesh;
  readonly inputReports: readonly [TopologyReport, TopologyReport];
  readonly outputReport: TopologyReport;
}
/** One authoritative split ceiling (Stage AUTO-SPLIT-LARGE-MESH-02): the value is unchanged, the source is shared. */
const MAX_BOOLEAN_INPUT_TRIANGLES = MAX_SUPPORTED_SPLIT_TRIANGLES;
const MAX_BOOLEAN_WORKSPACE_BYTES = 1024 * 1024 * 1024;
function topology(
  mesh: CanonicalMesh,
  label: string,
  cancellation: CancellationToken,
): TopologyReport {
  throwIfCancelled(cancellation);
  assertMeshStructure(mesh, `boolean/${label}`);
  const triangles = triangleCount(mesh);
  if (triangles > MAX_BOOLEAN_INPUT_TRIANGLES)
    throw resourceLimitExceeded(
      `Boolean ${label} triangle count is ${triangles}; limit is ${MAX_BOOLEAN_INPUT_TRIANGLES}.`,
      { metric: 'triangles', observed: triangles, limit: MAX_BOOLEAN_INPUT_TRIANGLES },
    );
  const workspace = estimateTopologyWorkspaceBytes(triangles, triangles * 3);
  if (workspace > MAX_BOOLEAN_WORKSPACE_BYTES)
    throw resourceLimitExceeded(
      `Boolean ${label} topology workspace is ${workspace} bytes; limit is ${MAX_BOOLEAN_WORKSPACE_BYTES} bytes.`,
      { metric: 'topologyWorkspaceBytes', observed: workspace, limit: MAX_BOOLEAN_WORKSPACE_BYTES },
    );
  const report = analyseTopology(mesh, {
    documentId: 'boolean-check',
    documentRevision: 0,
    partId: label,
    cancellation,
    sampleLimit: 0,
    componentSummaryLimit: 1,
  }).report;
  if (
    report.boundaryEdgeCount > 0 ||
    report.nonManifoldEdgeCount > 0 ||
    report.nonManifoldVertexCount > 0 ||
    report.windingConflictEdgeCount > 0 ||
    report.zeroAreaFaceCount > 0 ||
    report.repeatedPositionFaceCount > 0 ||
    report.sameOrientationDuplicateCount > 0 ||
    report.reversedOrientationDuplicateCount > 0
  )
    throw invalidState(
      `Boolean ${label} requires a closed, manifold, consistently oriented mesh.`,
      {
        boundaryEdges: report.boundaryEdgeCount,
        nonManifoldEdges: report.nonManifoldEdgeCount,
        nonManifoldVertices: report.nonManifoldVertexCount,
        windingConflicts: report.windingConflictEdgeCount,
        degenerateFaces: report.zeroAreaFaceCount + report.repeatedPositionFaceCount,
        duplicateFaces:
          report.sameOrientationDuplicateCount + report.reversedOrientationDuplicateCount,
      },
    );
  return report;
}
/** One CAD Fixer-owned gate around any approved Boolean kernel. */
export async function runValidatedBoolean(
  backend: BooleanBackend,
  kind: BooleanKind,
  a: CanonicalMesh,
  b: CanonicalMesh,
  cancellation: CancellationToken,
): Promise<BooleanResult> {
  const inputBytes = meshByteLength(a) + meshByteLength(b);
  if (inputBytes > DEFAULT_GEOMETRY_EDIT_LIMITS.maxCanonicalBytes)
    throw resourceLimitExceeded(
      `Boolean input canonical bytes are ${inputBytes}; limit is ${DEFAULT_GEOMETRY_EDIT_LIMITS.maxCanonicalBytes}.`,
      {
        metric: 'canonicalBytes',
        observed: inputBytes,
        limit: DEFAULT_GEOMETRY_EDIT_LIMITS.maxCanonicalBytes,
      },
    );
  const ar = topology(a, 'left input', cancellation),
    br = topology(b, 'right input', cancellation);
  throwIfCancelled(cancellation);
  const mesh = await backend.operate(kind, a, b, cancellation);
  throwIfCancelled(cancellation);
  // The kernel's success claim is not an acceptance criterion. A resulting mesh
  // must pass CAD Fixer's own storage, topology and resource gates.
  const result = validateGeometryEdit(
    mesh,
    singlePartDocument(a, { id: partId('boolean-result') }),
    partId('boolean-result'),
  );
  void result;
  const outputReport = topology(mesh, 'output', cancellation);
  return { mesh, inputReports: [ar, br], outputReport };
}
export const booleanUnion = (
  backend: BooleanBackend,
  a: CanonicalMesh,
  b: CanonicalMesh,
  cancellation: CancellationToken,
) => runValidatedBoolean(backend, 'union', a, b, cancellation);
export const booleanDifference = (
  backend: BooleanBackend,
  a: CanonicalMesh,
  b: CanonicalMesh,
  cancellation: CancellationToken,
) => runValidatedBoolean(backend, 'difference', a, b, cancellation);
export const booleanIntersection = (
  backend: BooleanBackend,
  a: CanonicalMesh,
  b: CanonicalMesh,
  cancellation: CancellationToken,
) => runValidatedBoolean(backend, 'intersection', a, b, cancellation);
