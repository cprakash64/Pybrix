import {
  SEMANTIC_SYSTEM_PROMPT,
  semanticJsonSchema,
  buildSemanticUserText,
} from './semantic-protocol';
import {
  PROTOCOL_VERSIONS,
  VIEW_NAMES,
  type AnalyzeRequest,
  type SemanticMode,
} from '@cadfixer/auto-split-contract';
import { buildHumanUserText, humanJsonSchema, HUMAN_SYSTEM_PROMPT } from './human-protocol';
import {
  buildUserText as buildVehicleUserText,
  SYSTEM_PROMPT as VEHICLE_SYSTEM_PROMPT,
  vehicleJsonSchema,
} from './vehicle-protocol';

/**
 * WHAT THE PROVIDER IS ASKED, per mode, from the pinned protocol and nothing the browser sent but
 * the request id and two bounded numbers. There is no channel for a prompt, a system message or a
 * file name in a request, so there is none here.
 */
export interface ProtocolPlan {
  readonly mode: SemanticMode;
  readonly protocolVersion: string;
  readonly instructions: string;
  readonly userText: string;
  readonly schemaName: string;
  readonly schema: Record<string, unknown>;
}

export function planFor(request: AnalyzeRequest): ProtocolPlan {
  if (request.mode === 'semantic')
    return {
      mode: 'semantic',
      protocolVersion: PROTOCOL_VERSIONS.semantic,
      instructions: SEMANTIC_SYSTEM_PROMPT,
      userText: buildSemanticUserText(request),
      schemaName: 'semantic_hierarchy',
      schema: semanticJsonSchema(),
    };
  if (request.mode === 'human')
    return {
      mode: 'human',
      protocolVersion: PROTOCOL_VERSIONS.human,
      instructions: HUMAN_SYSTEM_PROMPT,
      userText: buildHumanUserText(request.requestId, {
        extents: request.summary.extents,
        shells: request.summary.shells,
      }),
      schemaName: 'human_observation',
      schema: humanJsonSchema(),
    };
  return {
    mode: 'vehicle',
    protocolVersion: PROTOCOL_VERSIONS.vehicle,
    instructions: VEHICLE_SYSTEM_PROMPT,
    userText: buildVehicleUserText(request.requestId, {
      extents: request.summary.extents,
      components: request.summary.shells,
    }),
    schemaName: 'vehicle_observation',
    schema: vehicleJsonSchema(),
  };
}

export { VIEW_NAMES };
