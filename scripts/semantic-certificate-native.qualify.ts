/** Offline bounded construction-plane countercheck. Not an exhaustive plane search.
 * Candidate membership comes from exact production source faces; validity from production Booleans. */
import type { BooleanBackend } from '../packages/geometry-runtime/src/boolean-adapter';
import type { Point } from '../packages/repair-evaluation/src/geometry';
import { splitWithConnectors } from '@cadfixer/geometry-runtime';
import { uncancellable } from '@cadfixer/shared';
import {
  auditFixtureTopology,
  sourceAgreement,
  type SemanticFixture,
} from '../packages/repair-evaluation/src/semantic-fixture';
import { selectedPlaneFaces } from '../packages/repair-evaluation/src/semantic-all-output';
export interface ConstructionPlaneCountercheck {
  role: string;
  exact: {
    plane: { normal: Point; origin: Point };
    selected: number[];
    agreement: { precision: number; recall: number };
    outputTopology: ReturnType<typeof auditFixtureTopology>[];
    metrics: Awaited<ReturnType<typeof splitWithConnectors>>['metrics'];
    interfaceArea: number;
  }[];
  refused: { plane: { normal: Point; origin: Point }; error: string }[];
  claim: 'BOUNDED_AXIS_ALIGNED_CONSTRUCTION_PLANES_ONLY';
}
export async function countercheckConstructionPlanes(
  f: SemanticFixture,
  role: string,
  kernel: BooleanBackend,
): Promise<ConstructionPlaneCountercheck> {
  const target = f.roles.find((r) => r.id === role);
  if (!target) throw Error('UNKNOWN_COUNTERCHECK_ROLE');
  const coordinates = [0, 1, 2].map((axis) => [
    ...new Set(
      f.construction.boxes
        .flatMap((b) => [b.lo[axis], b.hi[axis]])
        .map((v) => Number(v) * f.construction.cell),
    ),
  ]);
  if (coordinates.reduce((s, c) => s + c.length * 2, 0) > 192)
    throw Error('COUNTERCHECK_CANDIDATE_BUDGET');
  const exact = [],
    refused = [];
  for (const [axis, values] of coordinates.entries())
    for (const coordinate of values)
      for (const sign of [-1, 1]) {
        const normal = [0, 0, 0],
          origin = [0, 0, 0];
        normal[axis] = sign;
        origin[axis] = coordinate;
        const plane = { normal: normal as unknown as Point, origin: origin as unknown as Point };
        let selected: number[];
        try {
          selected = selectedPlaneFaces(f, plane);
        } catch {
          continue;
        }
        const agreement = sourceAgreement(selected, target.faces);
        if (agreement.precision !== 1 || agreement.recall !== 1) continue;
        try {
          const native = await splitWithConnectors(
            kernel,
            f.mesh,
            { plane, connector: { kind: 'none' } },
            uncancellable,
          );
          const outputTopology = [
            auditFixtureTopology(native.pieceA),
            auditFixtureTopology(native.pieceB),
          ];
          const valid = outputTopology.every(
            (t) =>
              t.report.isBoundaryFree &&
              t.report.isEdgeManifold &&
              t.report.isVertexManifold &&
              t.report.isWindingConsistent &&
              t.report.components.every((c) => c.signedVolume > 0),
          );
          if (valid)
            exact.push({
              plane,
              selected,
              agreement,
              outputTopology,
              metrics: native.metrics,
              interfaceArea: Math.min(native.cutA.area, native.cutB.area),
            });
        } catch (error) {
          refused.push({ plane, error: String(error) });
        }
      }
  return { role, exact, refused, claim: 'BOUNDED_AXIS_ALIGNED_CONSTRUCTION_PLANES_ONLY' as const };
}
