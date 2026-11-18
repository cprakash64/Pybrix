/** Node/browser shared prevalidation oracle. Imports production safety paths without changing them. */
import { splitWithConnectors } from '@cadfixer/geometry-runtime';
import { IDENTITY_PLACEMENT } from '@cadfixer/mesh-core';
import {
  identifyConnectorCompatibilitySurface,
  splitTolerance,
} from '../packages/geometry-runtime/src/split-connectors';
import { automaticPinPlan } from '../packages/geometry-runtime/src/automatic-connectors';
import type { BooleanBackend } from '../packages/geometry-runtime/src/boolean-adapter';
import { uncancellable } from '@cadfixer/shared';
import {
  auditFixtureTopology,
  meshDigest,
  type SemanticFixture,
  type PlaneEvidence,
  type FixtureEvidence,
  type ConnectorEvidence,
} from '../packages/repair-evaluation/src/semantic-fixture';
import { selectedPlaneFaces } from '../packages/repair-evaluation/src/semantic-all-output';
export async function prevalidatePlanes(
  f: SemanticFixture,
  kernel: BooleanBackend,
): Promise<FixtureEvidence> {
  const planes: PlaneEvidence[] = [],
    connectors: ConnectorEvidence[] = [];
  for (const p of f.planes) {
    const plane = { normal: p.normal, origin: p.origin },
      plain = await splitWithConnectors(
        kernel,
        f.mesh,
        { plane, connector: { kind: 'none' } },
        uncancellable,
      );
    const selected = selectedPlaneFaces(f, plane),
      complement = Array.from({ length: f.mesh.indices.length / 3 }, (_, i) => i).filter(
        (i) => !selected.includes(i),
      );
    const closed = (mesh: typeof f.mesh): boolean => {
      const t = auditFixtureTopology(mesh).report;
      return (
        t.isBoundaryFree &&
        t.isEdgeManifold &&
        t.isVertexManifold &&
        t.isWindingConsistent &&
        t.components.every((c) => c.signedVolume > 0)
      );
    };
    const detail = {
      metrics: plain.metrics,
      cutArea: plain.cutA.area,
      selectedSize: selected.length,
      complementSize: complement.length,
      outputHashes: [meshDigest(plain.pieceA), meshDigest(plain.pieceB)],
    };
    planes.push({
      role: p.role,
      selected,
      complement,
      plane: p,
      sourceHash: meshDigest(f.mesh),
      nativeValid: true,
      closedOutputs: closed(plain.pieceA) && closed(plain.pieceB),
      detail,
    });
    if (p.connector) {
      const plan = automaticPinPlan(
        plain.pieceA,
        plain.pieceB,
        identifyConnectorCompatibilitySurface(plain.pieceA, plane, splitTolerance(f.mesh)),
        p.normal,
        'millimeter',
        IDENTITY_PLACEMENT,
        plain.metrics.tolerance,
        uncancellable,
      );
      const automatic = await splitWithConnectors(
        kernel,
        f.mesh,
        { plane, connector: { kind: 'automatic', unit: 'millimeter' } },
        uncancellable,
      );
      const centersMatch = Boolean(
        plan && JSON.stringify(plan.centers) === JSON.stringify(automatic.placements),
      );
      const c = automatic.connector,
        successful = c.kind === 'pin' && automatic.automaticConnector === 'applied';
      connectors.push({
        role: p.role,
        sourceHash: meshDigest(f.mesh),
        plane: p,
        knownUnits: f.units === 'millimeter',
        closedOutputs: closed(automatic.pieceA) && closed(automatic.pieceB),
        interfaceArea: Math.min(plain.cutA.area, plain.cutB.area),
        wallDepthClearance: successful,
        automaticPlan: Boolean(plan),
        centersMatch,
        maleFemaleBoolean:
          successful &&
          automatic.metrics.pieceAFinalVolume > automatic.metrics.pieceAVolume &&
          automatic.metrics.pieceBFinalVolume < automatic.metrics.pieceBVolume,
        undoExact: false,
        detail: {
          ...detail,
          plan,
          connector: c,
          placements: automatic.placements,
          diagnostics: automatic.automaticConnectorDiagnostics,
          metrics: automatic.metrics,
          undo: 'REQUIRES_PRODUCTION_UI_TRANSACTION_PROOF',
        },
      });
    }
  }
  return { planes, connectors };
}
