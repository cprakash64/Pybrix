import { decodeBase64 } from './base64';
import { AnalyzeErrorCode } from './errors';
import {
  isSemanticMode,
  MAX_EXTENT,
  MAX_RADIUS,
  MAX_SHELLS,
  MAX_VIEW_PNG_BYTES,
  PROTOCOL_VERSIONS,
  REQUEST_ID_PATTERN,
  VIEW_IMAGE_SIZE,
  VIEW_NAMES,
  type SemanticMode,
  type ViewName,
} from './limits';
import { inspectPng } from './png';

/**
 * THE ANALYSIS REQUEST, and the validator the service runs before it spends anything.
 *
 * It carries ONLY: the semantic mode, six rendered PNG views, bounded normalized metadata, the pinned
 * protocol version and an opaque request id. There is no field for a model file, a vertex or face
 * array, a file name, a prompt or a system message, and the validator refuses any key it does not
 * name — at every level. A key that looks like mesh data or a file is refused with its own code so a
 * client bug that tries to send one is loud, not stripped and forgotten.
 */
export interface AnalyzeRequestView {
  readonly view: ViewName;
  /** Standard base64 of a clean 512 x 512 PNG, with no `data:` prefix. */
  readonly png: string;
}

export interface AnalyzeSummary {
  /** Bounding-box size along X, Y and Z in normalized units (the longest side is 1). */
  readonly extents: readonly [number, number, number];
  /** The number of separate connected shells. */
  readonly shells: number;
  /** The bounding-sphere radius of the normalized model. */
  readonly radius: number;
}

export interface AnalyzeRequest {
  readonly requestId: string;
  readonly mode: SemanticMode;
  readonly protocolVersion: string;
  readonly views: readonly AnalyzeRequestView[];
  readonly summary: AnalyzeSummary;
}

/** Key names that mean "a model" or "a file". Their presence anywhere is refused as raw geometry. */
const RAW_GEOMETRY_KEYS: ReadonlySet<string> = new Set([
  'positions',
  'position',
  'vertices',
  'vertex',
  'indices',
  'index',
  'faces',
  'face',
  'triangles',
  'triangle',
  'mesh',
  'meshes',
  'normals',
  'stl',
  'obj',
  '3mf',
  'threemf',
  'file',
  'files',
  'filename',
  'fileName',
  'name',
  'path',
  'bytes',
  'buffer',
  'model',
  'document',
  'prompt',
  'system',
  'instructions',
  'messages',
]);

export type ValidatedRequest =
  | {
      readonly ok: true;
      readonly request: AnalyzeRequest;
      /** The decoded PNGs, in view order. */
      readonly pngs: readonly Uint8Array[];
    }
  | { readonly ok: false; readonly code: AnalyzeErrorCode };

const REQUEST_KEYS = ['requestId', 'mode', 'protocolVersion', 'views', 'summary'] as const;
const VIEW_KEYS = ['view', 'png'] as const;
const SUMMARY_KEYS = ['extents', 'shells', 'radius'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The refusal for an object that carries a key outside `allowed`, or null when it carries none. */
function unexpectedKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): AnalyzeErrorCode | null {
  let unexpected = false;
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (RAW_GEOMETRY_KEYS.has(key)) return AnalyzeErrorCode.RawGeometryRejected;
    unexpected = true;
  }
  return unexpected ? AnalyzeErrorCode.InvalidRequest : null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function invalid(code: AnalyzeErrorCode = AnalyzeErrorCode.InvalidRequest): ValidatedRequest {
  return { ok: false, code };
}

export function validateAnalyzeRequest(raw: unknown): ValidatedRequest {
  if (!isRecord(raw)) return invalid();
  const keyProblem = unexpectedKey(raw, REQUEST_KEYS);
  if (keyProblem !== null) return invalid(keyProblem);
  for (const key of REQUEST_KEYS) if (!(key in raw)) return invalid();

  const { requestId, mode, protocolVersion, views, summary } = raw;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) return invalid();
  if (!isSemanticMode(mode)) return invalid(AnalyzeErrorCode.UnsupportedMode);
  if (protocolVersion !== PROTOCOL_VERSIONS[mode])
    return invalid(AnalyzeErrorCode.UnsupportedProtocol);

  if (!Array.isArray(views) || views.length !== VIEW_NAMES.length) return invalid();
  const pngs: Uint8Array[] = [];
  const viewList: AnalyzeRequestView[] = [];
  for (let i = 0; i < VIEW_NAMES.length; i += 1) {
    const entry: unknown = views[i];
    if (!isRecord(entry)) return invalid();
    const problem = unexpectedKey(entry, VIEW_KEYS);
    if (problem !== null) return invalid(problem);
    const expected = VIEW_NAMES[i];
    if (entry.view !== expected || typeof entry.png !== 'string') return invalid();
    if (entry.png.length > Math.ceil((MAX_VIEW_PNG_BYTES * 4) / 3) + 8)
      return invalid(AnalyzeErrorCode.PayloadTooLarge);
    const bytes = decodeBase64(entry.png);
    if (bytes === null || bytes.length > MAX_VIEW_PNG_BYTES) return invalid();
    const info = inspectPng(bytes);
    if (
      !info.ok ||
      info.info.width !== VIEW_IMAGE_SIZE ||
      info.info.height !== VIEW_IMAGE_SIZE ||
      info.info.bitDepth !== 8 ||
      info.info.colorType !== 2
    )
      return invalid();
    pngs.push(bytes);
    viewList.push({ view: expected as ViewName, png: entry.png });
  }

  if (!isRecord(summary)) return invalid();
  const summaryProblem = unexpectedKey(summary, SUMMARY_KEYS);
  if (summaryProblem !== null) return invalid(summaryProblem);
  const { extents, shells, radius } = summary;
  if (
    !Array.isArray(extents) ||
    extents.length !== 3 ||
    !extents.every((x): x is number => finite(x) && x >= 0 && x <= MAX_EXTENT)
  )
    return invalid();
  if (!Number.isInteger(shells) || (shells as number) < 1 || (shells as number) > MAX_SHELLS)
    return invalid();
  if (!finite(radius) || radius <= 0 || radius > MAX_RADIUS) return invalid();

  return {
    ok: true,
    pngs,
    request: {
      requestId,
      mode,
      protocolVersion,
      views: viewList,
      summary: {
        extents: [extents[0] as number, extents[1] as number, extents[2] as number],
        shells: shells as number,
        radius,
      },
    },
  };
}
