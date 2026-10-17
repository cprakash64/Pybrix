import { requiredValue } from '../packages/repair-evaluation/src/semantic-invariant';
/** Offline request CONSTRUCTION only; no fetch, credentials, dispatch, retry, or provider budget.
 * Future evaluation dispatchers must enter here with a validated freeze. */
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { prepareSemanticGeometry } from '@cadfixer/auto-split';
import {
  VIEW_NAMES,
  encodeBase64,
  validateAnalyzeRequest,
  type AnalyzeRequest,
} from '@cadfixer/auto-split-contract';
import { assertFixtureDispatchable } from '../packages/repair-evaluation/src/semantic-all-output';
import type {
  SemanticFixture,
  FixtureEvidence,
} from '../packages/repair-evaluation/src/semantic-fixture';
export async function buildValidatedEvaluationRequest(
  f: SemanticFixture,
  evidence: FixtureEvidence,
  freezeHash: string,
): Promise<AnalyzeRequest> {
  assertFixtureDispatchable(f, evidence, freezeHash);
  const mesh = {
    positions: f.mesh.positions.slice(),
    indices: f.mesh.indices.slice(),
    metadata: { ...f.mesh.metadata },
  };
  const p = await prepareSemanticGeometry(mesh, (b) =>
    Promise.resolve(new Uint8Array(deflateSync(b))),
  );
  // Freeze denominators from observable source membership, never from the model's annotations.
  for (const family of f.families) {
    const rootRole = requiredValue(f.roles.find((r) => r.id === family.id));
    const observable = family.members
      .filter((id) => {
        const faces = new Set(requiredValue(f.roles.find((r) => r.id === id)).faces);
        return p.rasters.some((raster) => {
          let pixels = 0;
          for (const face of raster.face) if (faces.has(face) && ++pixels >= 16) return true;
          return false;
        });
      })
      .sort();
    if (JSON.stringify(observable) !== JSON.stringify([...rootRole.observableMembers].sort()))
      throw Error('FROZEN_VISIBILITY_MISMATCH');
  }
  const request: AnalyzeRequest = {
    requestId: randomUUID(),
    mode: 'semantic',
    protocolVersion: 'semantic-v1',
    views: VIEW_NAMES.map((view, i) => ({ view, png: encodeBase64(requiredValue(p.pngs[i])) })),
    componentViews: VIEW_NAMES.map((view, i) => ({
      view,
      png: encodeBase64(requiredValue(p.componentPngs[i])),
    })),
    semantic: { ...p.metadata, scope: 'entire-model' },
    summary: { extents: p.geometry.extents, shells: p.labelling.count, radius: p.geometry.radius },
  };
  const validation = validateAnalyzeRequest(request);
  if (!validation.ok) throw Error('PRODUCTION_REQUEST_BOUNDARY_REJECTED');
  return validation.request;
}
