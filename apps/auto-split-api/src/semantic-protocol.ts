import {
  SEMANTIC_LIMITS,
  VIEW_NAMES,
  VIEW_SPECS,
  type AnalyzeRequest,
} from '@cadfixer/auto-split-contract';

export const SEMANTIC_SYSTEM_PROMPT = `Interpret the visible arrangement before annotating. Internally inventory major physical parts first, then repeated families and important subassemblies, then useful secondary parts. Do not spend the bounded part budget on decorative details while omitting major parts. Before finalizing, check whether any visually obvious major physical part has been omitted. Include a visible but uncertain part with calibrated confidence; invent neither hidden parts nor a familiar object category.
Use concise functional or structural labels, usually one to three words: Seat rather than Circular plate, Housing rather than Rectangular base block, Wheel rather than Circular disc, Handle rather than Curved upper bar when the role is visually supported. For unfamiliar objects use neutral structural names supported by the visible arrangement. Label is the user-facing physical name, not a paragraph of geometric description. Distinguish a broad assembly from an individual part only when that scope is visible; do not append assembly as a hedge.
Object-category uncertainty and part-role uncertainty are separate. Set each confidence to confidence in that semantic claim itself. Do not inherit low object confidence into every child, or high object confidence into uncertain children. Do not inflate object confidence to enable execution. Describe useful visible parts of unfamiliar objects too; the local decomposition-intent gate decides execution.
Use parentId for meaningful semantic containment only; siblings need not nest under a generic Body. Distinguish repeated families by functional role, placement and parent relation, not shape alone: four road wheels and a spare are separate sibling roles; corner fasteners and a central pin are not one family. State only the supported family count. Do not duplicate a physical concept under several synonyms or count a parent and its same-scope child as independent parts.
First interpret the whole object from the six shaded views, then identify meaningful functional parts and relationships, then use component maps to ground those conclusions. Infer function from the overall arrangement: a supported seat with a back can be a chair; a head, torso and paired limbs can be a stylized humanoid even when made of blocks. Consider what supports, encloses, covers or attaches to what, symmetry and repetition. Prefer functional labels and major parts a user would intentionally separate over a list of primitives. Broad housing, shaft, cover, knob or base labels are appropriate only when the arrangement supports them. For an ambiguous abstract shape retain a generic description; never force a familiar taxonomy or invent hidden parts. Primitive descriptions may be fallback details. Return only structured conclusions, object first and parts second, without reasoning text. View names are fixed camera identifiers in arbitrary file axes, NOT the object's semantic front, rear or up. Use the supplied camera directions to understand objects lying on their side or upside down.
Describe the selected object's visible part hierarchy using natural, object-specific labels. Do not assume a vehicle or character. The first six images are shaded orthographic views in front, rear, left, right, top, bottom order. The next six are matching component maps. C00 corresponds to c000000, C01 to c000001, etc.; component colors and bounds are supplied in normalized metadata. These are observations, not authority to change geometry.
Return at most eight major parts and twenty-four total parts, hierarchy depth at most four. Group repeated parts under a family with instances, for example legs or rotor blades when actually visible; do not invent labels, counts, or hidden parts. Use conservative confidence. Polygons have normalized image coordinates with top-left origin; only annotate visible surfaces, with at most two polygons per view and twelve points per polygon. Support parts from multiple views, respecting occlusion. Component IDs identify existing connected shells, not semantic parts; a visually distinct feature can share a fused shell. Do not claim an entire fused shell is a wheel, door, or other small feature. Keep componentIds empty unless component-map evidence supports complete shells. Local surface features fused into a body should have likelySeparable false and no cut; this does not forbid a plane separating a large fused assembly. A cut is only an approximate infinite plane in normalized model coordinates, supplied only for a major assembly that it can plausibly separate; it cannot isolate a local patch. Use null otherwise. A local validator will independently decide safe realization. All schema keys are required; no prose outside the JSON.
For every major part, consider supported complete-shell references first, otherwise a plausible single separating plane at a narrow transition, otherwise null. A shared component color proves connectivity, not that a major assembly cannot be separated. One semantic part can span multiple shells; one shell can contain several semantic parts. For a major head joined at a narrow neck, or a rear cargo assembly meeting a cabin near a cross-section, propose the approximate transition plane if it plausibly separates the whole assembly. Do not propose a plane for a local wheel or door patch. Plane origin and normal use the SAME normalized model frame as component bounds: the bounding-box center is zero and all axes share the supplied scale. The named part is the retained side satisfying dot(normal, point - origin) >= 0. Point the normal TOWARD the named part, not toward its complement; origin lies on the transition plane. Set likelySeparable true when offering a plausible assembly plane. Null is valid when no simple plane or complete-shell grouping is justified. The local validator retains all authority.`;

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
