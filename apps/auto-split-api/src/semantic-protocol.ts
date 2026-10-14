import {
  SEMANTIC_LIMITS,
  VIEW_NAMES,
  VIEW_SPECS,
  type AnalyzeRequest,
} from '@cadfixer/auto-split-contract';

export const SEMANTIC_SYSTEM_PROMPT = `Describe the selected object's visible part hierarchy using natural, object-specific labels. Do not assume a vehicle or character. The first six images are shaded orthographic views in front, rear, left, right, top, bottom order. The next six are matching component maps. C00 corresponds to c000000, C01 to c000001, etc.; component colors and bounds are supplied in normalized metadata. These are observations, not authority to change geometry.
Return at most eight major parts and twenty-four total parts, hierarchy depth at most four. Group repeated parts under a family with instances, for example legs or rotor blades when actually visible; do not invent labels, counts, or hidden parts. Use conservative confidence. Polygons have normalized image coordinates with top-left origin; only annotate visible surfaces, with at most two polygons per view and twelve points per polygon. Support parts from multiple views, respecting occlusion. Component IDs identify existing connected shells, not semantic parts; a visually distinct feature can share a fused shell. Do not claim an entire fused shell is a wheel, door, or other small feature. Keep componentIds empty unless component-map evidence supports complete shells. Surface features fused into a body should have likelySeparable false and no cut. A cut is only an approximate infinite plane in normalized model coordinates, supplied only for a major assembly that it can plausibly separate; it cannot isolate a local patch. Use null otherwise. A local validator will independently decide safe realization. All schema keys are required; no prose outside the JSON.`;

const object = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const number = { type: 'number' };
const confidence = { type: 'number', minimum: 0, maximum: 1 };
const vector = { type: 'array', items: number, minItems: 3, maxItems: 3 };
const label = { type: 'string', minLength: 1, maxLength: SEMANTIC_LIMITS.label };
export function semanticJsonSchema(): Record<string, unknown> {
  return object({
    object: object({ label, confidence }),
    parts: {
      type: 'array',
      maxItems: SEMANTIC_LIMITS.parts,
      items: object({
        id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$' },
        label,
        parentId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        importance: { type: 'string', enum: ['major', 'detail'] },
        confidence,
        instances: { type: 'integer', minimum: 1, maximum: SEMANTIC_LIMITS.instances },
        views: {
          type: 'array',
          maxItems: 6,
          items: object({
            view: { type: 'string', enum: [...VIEW_NAMES] },
            polygons: {
              type: 'array',
              minItems: 1,
              maxItems: SEMANTIC_LIMITS.regionsPerView,
              items: {
                type: 'array',
                minItems: 3,
                maxItems: SEMANTIC_LIMITS.polygonPoints,
                items: { type: 'array', minItems: 2, maxItems: 2, items: confidence },
              },
            },
          }),
        },
        componentIds: {
          type: 'array',
          maxItems: SEMANTIC_LIMITS.components,
          items: { type: 'string', pattern: '^c[0-9]{6}$' },
        },
        expectedGeometry: object({
          kind: {
            type: 'string',
            enum: ['solid_part', 'surface_part', 'repeated_part', 'unknown'],
          },
          likelySeparable: { type: 'boolean' },
        }),
        cut: { anyOf: [object({ normal: vector, origin: vector }), { type: 'null' }] },
      }),
    },
  });
}
export function buildSemanticUserText(request: AnalyzeRequest): string {
  return JSON.stringify({
    requestId: request.requestId,
    cameras: VIEW_NAMES.map((view) => ({ view, description: VIEW_SPECS[view].description })),
    summary: request.summary,
    semantic: request.semantic,
  });
}
