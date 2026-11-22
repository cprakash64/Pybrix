/**
 * THE LIMITS OF ONE SURFACE SELECTION, and the typed reasons a selection is refused for them.
 *
 * Named here so the engine that enforces a limit, the worker that passes it on and the page that
 * words it read ONE number. They are the values the selection has always used: this module moves
 * nothing. (`growEditRegion` scans the whole part to find shared edges, so its source limit is a
 * cost bound, not the document's triangle ceiling.)
 */

/** A part with more triangles than this is not scanned for a selection. */
export const MAX_EDIT_SOURCE_TRIANGLES = 1_000_000;

/** The most triangles one selected region may hold. */
export const MAX_EDIT_REGION_TRIANGLES = 100_000;

/**
 * The `AppError.details.reason` of a selection refused for size. Tests assert the code, never the
 * sentence, so the wording can change without weakening what a test proves.
 */
export const EditRefusal = {
  RegionTooLarge: 'EDIT_REGION_TOO_LARGE',
  SourceTooLarge: 'EDIT_SOURCE_TOO_LARGE',
} as const;
export type EditRefusal = (typeof EditRefusal)[keyof typeof EditRefusal];
