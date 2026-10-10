/**
 * AUTO SPLIT — THE LIMITS, stated once.
 *
 * The browser builds a request within them and the service REFUSES one outside them; the same
 * numbers are read by both, so a limit cannot be loosened on one side only.
 */

/** The semantic categories the service understands. "Other" is not one: it has no protocol. */
export const SEMANTIC_MODES = ['human', 'vehicle'] as const;
export type SemanticMode = (typeof SEMANTIC_MODES)[number];

export function isSemanticMode(value: unknown): value is SemanticMode {
  return typeof value === 'string' && (SEMANTIC_MODES as readonly string[]).includes(value);
}

/**
 * The semantic protocol each mode is analysed under, PINNED. The vehicle protocol is the research
 * protocol `VEHICLE_SEMANTIC_PROTOCOL_V0`, byte for byte (prompt, schema and request text). The human
 * protocol is the production protocol derived from the qualified direct-proposal research. A request
 * naming any other version is refused, so a stale browser cannot reach a protocol the server changed.
 */
export const PROTOCOL_VERSIONS: Readonly<Record<SemanticMode, string>> = Object.freeze({
  human: 'human-v1',
  vehicle: 'vehicle-v0',
});

/** The six canonical orthographic views, in the order the images are listed. */
export const VIEW_NAMES = ['front', 'rear', 'left', 'right', 'top', 'bottom'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

/** Every view is a square PNG of exactly this size. */
export const VIEW_IMAGE_SIZE = 512;
/** One view's PNG may not exceed this many bytes. A shaded grey render is typically 20 to 120 KiB. */
export const MAX_VIEW_PNG_BYTES = 512 * 1024;
/** The whole JSON request body: six base64 views at the per-view cap, plus a small allowance. */
export const MAX_REQUEST_BODY_BYTES =
  Math.ceil((VIEW_NAMES.length * MAX_VIEW_PNG_BYTES * 4) / 3) + 4096;

/** The request id the browser makes up for one analysis: opaque, never derived from a file. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Bounded geometry metadata. All three numbers are normalized or counts; none identifies a design. */
export const MAX_SHELLS = 100_000_000;
export const MAX_EXTENT = 1.0001;
/** The bounding-sphere radius of the normalized model: at most the half-diagonal of a unit-longest box. */
export const MAX_RADIUS = 2;

/** The service's own deadline for one provider call, and the browser's for the whole round trip. */
export const PROVIDER_TIMEOUT_MS = 150_000;
export const CLIENT_TIMEOUT_MS = 180_000;
