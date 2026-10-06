import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { it } from 'vitest';
import createSelfIntersectionKernel from '@cadfixer/self-intersection-kernel';
import {
  DEFAULT_IMPORT_BUDGET,
  identifyFormat,
  registerBuiltInFormats,
  requireReader,
  writeBinaryStl,
  type FormatWriteContext,
} from '@cadfixer/file-formats';
import { distinctMeshes } from '@cadfixer/mesh-core';
import { runLocalRepair, type LocalRepairLimits } from '@cadfixer/mesh-hole-fill';
import { applyLocalRepairPatch } from '@cadfixer/mesh-repair';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { uncancellable } from '@cadfixer/shared';
import { createKernelNarrowphase } from '../apps/web/src/workers/hole-fill-narrowphase';
import { testReadContext } from '../packages/file-formats/src/test-context';
import { PRODUCTION_REPAIR_WORK_LIMITS } from '../packages/mesh-hole-fill/src/repair-work-limits';

/**
 * REPAIR-CORE-06A — the PRODUCTION local-repair engine on real models. Qualification, NOT CI.
 *
 *   CADFIXER_CORPUS=<corpus.json> CADFIXER_MODELS=X15[,X7,...] CADFIXER_QUAL_DIR=<dir> \
 *     [CADFIXER_LIMITS=unmetered|production|<primary>,<residual>] [CADFIXER_AUDIT=1] \
 *     npm run qualify:repair-core-06a
 *
 * It runs `runLocalRepair`, builds the candidate through `applyLocalRepairPatch` (the same rebuild
 * the product uses) and reports what the engine decided, what it cost in deterministic work units
 * and what the candidate's independent topology analysis says. Models stay outside git.
 */
const corpusPath = process.env.CADFIXER_CORPUS ?? '';
const wanted = (process.env.CADFIXER_MODELS ?? '').split(',').filter((s) => s !== '');
const qualDir = process.env.CADFIXER_QUAL_DIR ?? '';
const limitsSpec = process.env.CADFIXER_LIMITS ?? 'production';
const enabled = corpusPath !== '' && existsSync(corpusPath) && qualDir !== '' && wanted.length > 0;

function limits(): LocalRepairLimits {
  if (limitsSpec === 'unmetered') return { primary: undefined, residual: undefined };
  if (limitsSpec === 'production') return PRODUCTION_REPAIR_WORK_LIMITS;
  const [a, b] = limitsSpec.split(',').map(Number);
  return { primary: a, residual: b };
}

function kernelWasmPath(): string {
  const relative = join(
    'packages',
    'self-intersection-kernel',
    'artifacts',
    'self-intersection.wasm',
  );
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error('kernel artifact not found');
}

const writeContext: FormatWriteContext = {
  cancellation: uncancellable,
  progress: { report: (): void => undefined },
  budget: DEFAULT_IMPORT_BUDGET,
  yieldToEventLoop: (): Promise<void> => Promise.resolve(),
  encoding: 'binary',
};

it.skipIf(!enabled)(
  'REPAIR-CORE-06A production local repair on real models',
  async () => {
    registerBuiltInFormats();
    const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
      models: { id: string; path: string }[];
    };
    mkdirSync(qualDir, { recursive: true });
    const kernel = await createSelfIntersectionKernel({
      wasmBinary: readFileSync(kernelWasmPath()),
    });
    for (const id of wanted) {
      const entry = corpus.models.find((m) => m.id === id);
      if (entry === undefined) throw new Error(`unknown model ${id}`);
      const bytes = new Uint8Array(readFileSync(entry.path));
      const identified = identifyFormat(bytes, basename(entry.path));
      const parsed = await requireReader(identified.formatId).read(bytes, testReadContext());
      const mesh = distinctMeshes(parsed.document)[0];
      if (mesh === undefined) throw new Error('no mesh');
      const before = analyseTopology(mesh, {
        documentId: id,
        documentRevision: 1,
        partId: 'p',
        cancellation: uncancellable,
      }).report;
      const started = performance.now();
      const curve: [number, number, number, number][] = [];
      const result = runLocalRepair({
        mesh,
        makeNarrowphase: () => createKernelNarrowphase(kernel),
        limits: limits(),
        audit: process.env.CADFIXER_AUDIT === '1',
        onProgress: (p) => {
          if (p.phase !== 'topology') {
            curve.push([
              p.attempted,
              p.primaryWorkUnits,
              p.residualWorkUnits,
              Math.round(performance.now() - started),
            ]);
          }
        },
      });
      const repairMs = performance.now() - started;
      let stlSha256: string | undefined;
      let after: ReturnType<typeof analyseTopology>['report'] | undefined;
      if (result.patch !== undefined) {
        const candidate = applyLocalRepairPatch(mesh, result.patch);
        const written = await writeBinaryStl(candidate.mesh, writeContext);
        stlSha256 = createHash('sha256').update(written.bytes).digest('hex');
        after = analyseTopology(candidate.mesh, {
          documentId: id,
          documentRevision: 2,
          partId: 'p',
          cancellation: uncancellable,
        }).report;
      }
      const row = (r: typeof before | undefined): Record<string, number> | undefined =>
        r === undefined
          ? undefined
          : {
              faces: r.sourceFaceCount,
              nonManifoldVertices: r.nonManifoldVertexCount,
              nonManifoldEdges: r.nonManifoldEdgeCount,
              windingConflicts: r.windingConflictEdgeCount,
              boundaryEdges: r.boundaryEdgeCount,
              components: r.componentCount,
              duplicateFaces: r.sameOrientationDuplicateCount + r.reversedOrientationDuplicateCount,
              degenerateFaces: r.zeroAreaFaceCount + r.repeatedPositionFaceCount,
            };
      writeFileSync(
        join(qualDir, `${id}-06a.json`),
        JSON.stringify(
          {
            model: id,
            faces: Math.floor(mesh.indices.length / 3),
            kind: result.kind,
            limitReached: result.limitReached ?? null,
            counts: result.counts,
            work: result.work,
            residual: result.residual,
            gate: result.gate,
            repairMs,
            curve,
            rssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
            stlSha256,
            before: row(before),
            after: row(after),
            operations: result.operations.map((op) => ({
              vertex: op.vertex,
              depth: op.depth,
              strategy: op.strategy,
              rho: op.scale,
              anchorFan: op.selection.anchorFan,
              fanCount: op.fanCount,
              cycleSizes: op.cycleSizes,
              newVertices: op.newVertices.length,
              removedFaces: op.removedFaces.length,
              addedFaces: op.addedFaces.length,
              maxOverL: op.fidelity.maxDistanceOverLocalEdge,
            })),
          },
          null,
          1,
        ),
      );
    }
  },
  14_400_000,
);
