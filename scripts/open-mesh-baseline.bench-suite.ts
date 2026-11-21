import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  computeBounds,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { analyseTopology, scanBoundaries } from '@cadfixer/mesh-topology';
import { uncancellable } from '@cadfixer/shared';
import { splitWithConnectors } from '@cadfixer/geometry-runtime';
import {
  executeConservativeRepair,
  planConservativeRepair,
  RepairOperation,
  applyLocalRepairPatch,
} from '@cadfixer/mesh-repair';
import {
  runLocalRepair,
  admitBoundaryLoops,
  buildLocalPatchProblem,
  classifyLocalPatches,
  appendPatches,
  judgeFilledCandidate,
  DEFAULT_BOUNDARY_FILL_LIMITS,
} from '@cadfixer/mesh-hole-fill';
import createKernel from '@cadfixer/self-intersection-kernel';
import { createKernelNarrowphase } from '../apps/web/src/workers/hole-fill-narrowphase';
import { PRODUCTION_REPAIR_WORK_LIMITS } from '../packages/mesh-hole-fill/src/repair-work-limits';
it('records the unmodified truck and every production repair transformation', async () => {
  const file = readFileSync(
    process.env.OPEN_MESH_TRUCK_PATH ?? join(homedir(), 'Downloads', 'Hitem3d-1785766060812.stl'),
  );
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const n = dv.getUint32(80, true);
  const positions = createPositionArray(n * 9),
    indices = createIndexArray(n * 3);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 9; k++)
      positions[f * 9 + k] = dv.getFloat32(84 + f * 50 + 12 + k * 4, true);
    for (let k = 0; k < 3; k++) indices[f * 3 + k] = f * 3 + k;
  }
  let mesh: CanonicalMesh = { positions, indices, metadata: { sourceFormat: 'stl' } };
  const stages: unknown[] = [];
  const analyse = (m: CanonicalMesh): ReturnType<typeof analyseTopology>['report'] =>
    analyseTopology(m, {
      documentId: 'truck',
      documentRevision: 0,
      partId: 'part-1',
      cancellation: uncancellable,
      sampleLimit: 0,
      componentSummaryLimit: 64,
    }).report;
  const record = (
    label: string,
    m: CanonicalMesh,
  ): ReturnType<typeof analyseTopology>['report'] => {
    const report = analyse(m);
    const scan = scanBoundaries(m, { limits: DEFAULT_BOUNDARY_FILL_LIMITS });
    const row = {
      label,
      report,
      scan: {
        edges: scan.boundaryEdgeCount,
        loops: scan.loops.map((l) => ({
          id: l.id,
          edges: l.edgeCount,
          vertices: l.vertexCount,
          refusal: l.refusal,
        })),
      },
      bounds: computeBounds(m),
    };
    stages.push(row);
    writeFileSync(
      'artifacts/open-mesh-split-01/baseline-stages.json',
      JSON.stringify(
        { inputSha256: createHash('sha256').update(file).digest('hex'), stages },
        null,
        2,
      ),
    );
    console.warn(
      label,
      report.sourceFaceCount,
      report.boundaryEdgeCount,
      scan.loops.length,
      report.nonManifoldVertexCount,
    );
    return report;
  };
  let report = record('original', mesh);
  const bounds = computeBounds(mesh);
  if (bounds === undefined) throw new Error('empty truck');
  const plane = {
    origin: [(bounds.min[0] + bounds.max[0]) / 2, 0, 0] as const,
    normal: [1, 0, 0] as const,
  };
  try {
    await splitWithConnectors(
      {
        operate: () => {
          throw Error('Boolean unexpectedly reached');
        },
      },
      mesh,
      { plane, connector: { kind: 'none' } },
      uncancellable,
    );
  } catch (e) {
    writeFileSync(
      'artifacts/open-mesh-split-01/baseline-manual-refusal.json',
      JSON.stringify(e, null, 2),
    );
  }
  const planned = planConservativeRepair({
    mesh,
    report,
    documentId: 'truck',
    partId: 'part-1',
    sourceRevision: 0,
    requested: Object.values(RepairOperation),
    cancellation: uncancellable,
  });
  const conservative = executeConservativeRepair({
    source: mesh,
    sourceReport: report,
    documentId: 'truck',
    partId: 'part-1',
    revision: 0,
    cancellation: uncancellable,
    ...planned,
  });
  writeFileSync(
    'artifacts/open-mesh-split-01/conservative.json',
    JSON.stringify(
      { plan: planned.plan, counts: conservative.counts, validation: conservative.validation },
      null,
      2,
    ),
  );
  mesh = conservative.candidate ?? mesh;
  record('conservative', mesh);
  const kernel = await createKernel({
    wasmBinary: readFileSync('packages/self-intersection-kernel/artifacts/self-intersection.wasm'),
  });
  const local = runLocalRepair({
    mesh,
    limits: PRODUCTION_REPAIR_WORK_LIMITS,
    makeNarrowphase: () => createKernelNarrowphase(kernel),
  });
  writeFileSync(
    'artifacts/open-mesh-split-01/local-repair.json',
    JSON.stringify(
      {
        ...local,
        patch:
          local.patch === undefined
            ? null
            : {
                removed: Array.from(local.patch.removedSourceFaces),
                flipped: Array.from(local.patch.flippedSourceFaces),
                appendedPositions: Array.from(local.patch.appendedPositions),
                appendedFaces: Array.from(local.patch.appendedFaces),
              },
      },
      null,
      2,
    ),
  );
  if (local.patch !== undefined) mesh = applyLocalRepairPatch(mesh, local.patch).mesh;
  report = record('local-repair', mesh);
  const admission = admitBoundaryLoops(
    mesh,
    scanBoundaries(mesh, { limits: DEFAULT_BOUNDARY_FILL_LIMITS }),
  );
  const problem = buildLocalPatchProblem(mesh, admission.admitted, {
    maxFaces: DEFAULT_BOUNDARY_FILL_LIMITS.maxLocalFaces,
  });
  const verdicts = classifyLocalPatches(problem, createKernelNarrowphase(kernel));
  writeFileSync(
    'artifacts/open-mesh-split-01/fill.json',
    JSON.stringify({ decisions: admission.decisions, verdicts }, null, 2),
  );
  const passing = admission.admitted.filter((_, i) => {
    const v = verdicts[i];
    return (
      v?.complete &&
      !v.budgetExceeded &&
      v.invalidPatchSourcePairs === 0 &&
      v.invalidPatchPatchPairs === 0
    );
  });
  if (passing.length > 0) {
    const candidate = appendPatches(mesh, passing);
    if (judgeFilledCandidate(report, analyse(candidate), passing).length === 0) mesh = candidate;
  }
  record('filled-final', mesh);
  writeFileSync(
    'artifacts/open-mesh-split-01/repaired.positions',
    Buffer.from(mesh.positions.buffer),
  );
  writeFileSync('artifacts/open-mesh-split-01/repaired.indices', Buffer.from(mesh.indices.buffer));
}, 1_800_000);
