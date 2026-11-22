import {
  computeBounds,
  MAX_EDIT_REGION_TRIANGLES,
  partId,
  selectEditSurface,
} from '@cadfixer/mesh-core';
import {
  describeTextureLayout,
  isPart,
  meshSurfaceArea,
  textureSurface,
  type BooleanBackend,
  type OperationHandler,
} from '@cadfixer/geometry-runtime';
import {
  booleanOperations,
  buildRenderSnapshot,
  geometryEdits,
  residentDocuments,
} from './stl-handlers';
import type { BooleanKind } from '@cadfixer/geometry-runtime';
import type { BooleanOperationPhase } from './boolean-operation-protocol';

export interface TextureQualificationEvent {
  readonly documentId: string;
  readonly generation: number;
  readonly booleanIndex: number;
  readonly operation: BooleanKind;
  readonly phase: BooleanOperationPhase | 'TERMINAL';
  readonly at: number;
  readonly stats: {
    readonly active: number;
    readonly created: number;
    readonly terminated: number;
  };
}
let qualificationObserver: ((event: TextureQualificationEvent) => void) | undefined;
/** Harness-only observation seam; production leaves it unset. */
export function setTextureQualificationObserver(
  observer: ((event: TextureQualificationEvent) => void) | undefined,
): void {
  qualificationObserver = observer;
}

export const textureCreateHandler: OperationHandler<'texture/create'> = async (
  payload,
  context,
) => {
  context.throwIfCancelled();
  const sourcePart = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(sourcePart)) throw sourcePart;
  const ticket = geometryEdits.begin(payload.source, sourcePart.id, 'surface-texture');
  let booleanIndex = 0;
  const backend: BooleanBackend = {
    operate: (kind, a, b, cancellation) => {
      const index = booleanIndex++;
      return booleanOperations.run(kind, a, b, cancellation, {
        owner: { documentId: ticket.documentId, generation: ticket.generation },
        onPhase: (timing) =>
          qualificationObserver?.({
            documentId: ticket.documentId,
            generation: ticket.generation,
            booleanIndex: index,
            operation: kind,
            ...timing,
            stats: booleanOperations.stats,
          }),
      });
    },
  };
  try {
    context.reportProgress(0.05, 'Selecting surface');
    const textured = await textureSurface(
      backend,
      sourcePart.mesh,
      payload.request,
      context.cancellation,
    );
    context.reportProgress(0.85, 'Validating texture');
    const summary = geometryEdits.resolve(ticket, textured.mesh, undefined, context.cancellation);
    const render = geometryEdits.preview(summary.candidate, buildRenderSnapshot);
    context.reportProgress(1, 'Texture preview ready');
    const { mesh: _mesh, ...facts } = textured;
    void _mesh;
    return {
      value: { ...facts, candidate: summary.candidate, resources: summary.resources, render },
      transfer: [render.positions.buffer, render.normals.buffer],
    };
  } catch (error) {
    geometryEdits.invalidate(ticket);
    throw error;
  } finally {
    qualificationObserver?.({
      documentId: ticket.documentId,
      generation: ticket.generation,
      booleanIndex,
      operation: requestOperation(payload.request.mode),
      phase: 'TERMINAL',
      at: performance.now(),
      stats: booleanOperations.stats,
    });
  }
};

export const textureSelectHandler: OperationHandler<'texture/select'> = (payload, context) => {
  context.throwIfCancelled();
  const sourcePart = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(sourcePart)) throw sourcePart;
  const diagonal = Math.max((computeBounds(sourcePart.mesh)?.radius ?? 0) * 2, 1e-9);
  const region = selectEditSurface(
    sourcePart.mesh,
    payload.seedTriangle,
    {
      maxNormalAngleRadians: (2 * Math.PI) / 180,
      maxTriangles: MAX_EDIT_REGION_TRIANGLES,
      cancellation: context.cancellation,
    },
    Math.max(diagonal * 1e-7, 1e-9),
  );
  if (region.planarity.kind === 'NON_PLANAR')
    throw new Error(
      'This texture tool currently supports flat surfaces. Choose a flatter surface.',
    );
  return Promise.resolve({
    value: {
      source: payload.source,
      partId: payload.partId,
      triangleIds: region.triangleIds,
      planarity: region.planarity.kind,
      // Reported for display; neither decides anything.
      area: meshSurfaceArea(sourcePart.mesh, region.triangleIds),
      partArea: meshSurfaceArea(sourcePart.mesh),
    },
  });
};

/**
 * The fast preview: the engine's layout for this request, without the Boolean.
 * Synchronous and bounded by the same element and primitive ceilings as Apply.
 */
export const textureLayoutHandler: OperationHandler<'texture/layout'> = (payload, context) => {
  context.throwIfCancelled();
  const sourcePart = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(sourcePart)) throw sourcePart;
  const summary = describeTextureLayout(sourcePart.mesh, payload.request, context.cancellation);
  return Promise.resolve({
    value: { ...summary, source: payload.source, partId: payload.partId },
    transfer: [summary.footprint.buffer],
  });
};

function requestOperation(mode: 'emboss' | 'engrave'): BooleanKind {
  return mode === 'emboss' ? 'union' : 'difference';
}
