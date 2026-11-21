import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BRAND-01: the document metadata and the brand assets, at source.
 *
 * The BUILT index is checked end to end (`e2e/brand.spec.ts`) and in the
 * release gate (`scripts/hostinger-deployment.test.ts`); this pins what the
 * source says, so a stale title or a missing icon fails before a build.
 */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const LEGACY_NAME = /cad[\s_-]*fixer/i;

/** Width and height from a PNG's IHDR, which is always the first chunk. */
function pngSize(path: string): readonly [number, number] {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('index.html metadata', () => {
  it('is titled and described as Pybrix, truthfully', () => {
    expect(html).toMatch(/<title>Pybrix — 3D Print Repair &amp; Editing<\/title>/);
    expect(html).toMatch(/<meta name="application-name" content="Pybrix" \/>/);
    const description = /name="description"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(description).toMatch(/^Pybrix /);
    expect(description).toMatch(/STL, OBJ and 3MF/);
    // The one privacy claim the page makes is the one that is true of every workflow.
    expect(description).toMatch(/original 3D file stays on your device/);
    // Nothing the product cannot back up.
    expect(description).not.toMatch(/any file|every file|printable|guarantee|cloud|unlimited/i);
    expect(description).not.toMatch(/\bAI\b/);
  });

  it('declares the Pybrix icons as same-origin source paths Vite fingerprints', () => {
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="32x32" href="/src/brand/pybrix-favicon-32.png" />',
    );
    expect(html).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/src/brand/pybrix-apple-touch-icon.png" />',
    );
    // The old inline SVG favicon is gone, and nothing points off-origin.
    expect(html).not.toContain('data:image/svg+xml');
    expect(html).toContain('<link rel="canonical" href="https://pybrix.com/" />');
    const icons = html.match(/<link rel="(?:icon|apple-touch-icon)"[^>]*>/g) ?? [];
    expect(icons).toHaveLength(2);
    for (const icon of icons) expect(icon).not.toMatch(/href="https?:/);
  });

  it('keeps the browser chrome on the top bar colour and says no legacy name', () => {
    expect(html).toContain('<meta name="theme-color" content="#121b24" />');
    expect(html).not.toMatch(LEGACY_NAME);
  });
});

describe('brand assets', () => {
  const brand = (name: string): string => join(WEB, 'src', 'brand', name);

  it.each([
    ['pybrix-favicon-32.png', 32, 32],
    ['pybrix-apple-touch-icon.png', 180, 180],
    ['pybrix-tile-96.png', 96, 96],
    ['pybrix-logo-horizontal.png', 600, 202],
  ] as const)('%s is a %ix%i PNG, small enough to ship', (name, width, height) => {
    expect(pngSize(brand(name))).toEqual([width, height]);
    expect(statSync(brand(name)).size).toBeLessThan(100 * 1024);
  });

  it('keeps the untouched originals out of the shipped tree', () => {
    for (const name of [
      'pybrix-icon.png',
      'pybrix-logo-horizontal.png',
      'pybrix-logo-vertical.png',
    ]) {
      expect(statSync(join(WEB, 'brand-source', name)).isFile()).toBe(true);
    }
    // The original misspelling is not part of the production asset names.
    expect(html).not.toMatch(/verticle/i);
  });

  it('references no local filesystem path', () => {
    const brandModule = readFileSync(join(WEB, 'src', 'components', 'shell', 'brand.ts'), 'utf8');
    for (const text of [html, brandModule])
      expect(text).not.toMatch(/\/Users\/|cprakash|Documents\/CAD/);
  });
});
