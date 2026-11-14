import lockupUrl from '../../brand/pybrix-logo-horizontal.png';
import tileUrl from '../../brand/pybrix-tile-96.png';

/**
 * THE PRODUCT'S IDENTITY, IN ONE PLACE.
 *
 * The display name is Pybrix (BRAND-01). Package names, test ids, CSS classes,
 * worker names, environment variables and deployment paths keep their legacy
 * `cadfixer` / `cad-fixer` spelling on purpose — they are identifiers, not
 * identity, and renaming them is an infrastructure migration of its own.
 *
 * The header, Help and the status bar read these constants so they cannot say
 * three different things. Imported artwork is fingerprinted by Vite into
 * `/assets/`: same-origin, immutable, within `img-src 'self'`.
 */
export const PRODUCT_NAME = 'Pybrix';

/** Secondary to the name, never louder than it. */
export const PRODUCT_STATUS = 'Technical Preview';

export const PRODUCT_VERSION = 'v0.7.0';

/** What Pybrix does, in one line. Used where explanation helps, not everywhere. */
export const PRODUCT_SUMMARY =
  'Repair, convert, split and texture 3D-print models — locally in your browser.';

/**
 * The mark on its white tile, 96 px for 26 CSS px (3× displays and below). The
 * mark's "P" is a transparent cut-out and its right face is navy, so on the dark
 * chrome it is only legible on the ground it was drawn on.
 */
export const BRAND_TILE_URL: string = tileUrl;

/**
 * The horizontal lockup, 600 × 202. Its wordmark is navy #011A47, so it is only
 * ever placed on the light brand plate — never directly on the dark chrome.
 */
export const BRAND_LOCKUP_URL: string = lockupUrl;
export const BRAND_LOCKUP_WIDTH = 188;
export const BRAND_LOCKUP_HEIGHT = 63;
