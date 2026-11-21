import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE OWNERSHIP OF `FaceBvh` (Release 2, Slice 2A), asserted from source.
 *
 * `FaceBvh` is shared spatial infrastructure. Three things must stay true, and none of them is visible in review:
 *
 *   1. THERE IS ONE IMPLEMENTATION, in `@cadfixer/mesh-core/spatial`. A second tree — a connector-only fork, a
 *      compatibility copy, a shadow in a feature package — can silently disagree with the first, and a broadphase that
 *      disagrees about candidates is a broadphase that misses pairs.
 *   2. EVERY CONSUMER IMPORTS THAT ONE AUTHORITY, by its package specifier. There is no relative path into another
 *      package and no alias that keeps the old location alive.
 *   3. IT STAYS OUT OF THE PAGE BUNDLE. `@cadfixer/mesh-core` is imported by the main thread, so the broadphase is a
 *      SUBPATH that the package index does not re-export, and no main-thread file imports it.
 *
 * Checked from source, like `production-boundary.test.ts`, so the answer never depends on a build existing.
 */

const REPO_ROOT = join(import.meta.dirname, '..');
const SPATIAL_SPECIFIER = '@cadfixer/mesh-core/spatial';
const AUTHORITY = join('packages', 'mesh-core', 'src', 'spatial', 'face-bvh.ts');

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('dist-')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };
  walk(directory);
  return found;
}

/** Production sources: everything except tests, fixtures directories and the research `experiments/` tree. */
function productionSources(): string[] {
  return ['packages', 'apps', 'scripts']
    .flatMap((root) => sourceFilesUnder(join(REPO_ROOT, root)))
    .filter((file) => !/\.(test|spec)\.tsx?$/.test(file) && !file.includes(`${sep}fixtures${sep}`));
}

const read = (file: string): string => readFileSync(file, 'utf8');
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importSpecifiers = (text: string): string[] =>
  [...stripComments(text).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

describe('FaceBvh has exactly one implementation, in the neutral spatial module', () => {
  it('is declared once, in mesh-core/spatial', () => {
    const declaring = productionSources()
      .filter((file) => /\bclass\s+FaceBvh\b/.test(stripComments(read(file))))
      .map((file) => relative(REPO_ROOT, file));
    expect(declaring).toEqual([AUTHORITY]);
  });
  it('leaves nothing behind in the feature package it came from', () => {
    expect(existsSync(join(REPO_ROOT, 'packages', 'mesh-hole-fill', 'src', 'bvh.ts'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'packages', 'mesh-hole-fill', 'src', 'bvh.test.ts'))).toBe(
      false,
    );
    const holeFill = sourceFilesUnder(join(REPO_ROOT, 'packages', 'mesh-hole-fill', 'src'));
    for (const file of holeFill)
      expect(
        importSpecifiers(read(file)).filter((specifier) => /(^|\/)bvh$/.test(specifier)),
      ).toEqual([]);
  });
  it('is a leaf: it imports nothing, so it cannot carry a feature with it', () => {
    expect(importSpecifiers(read(join(REPO_ROOT, AUTHORITY)))).toEqual([]);
    expect(
      importSpecifiers(
        read(join(REPO_ROOT, 'packages', 'mesh-core', 'src', 'spatial', 'index.ts')),
      ),
    ).toEqual(['./face-bvh', './face-bvh']);
  });
});

describe('every consumer imports the one neutral authority', () => {
  const consumers = productionSources().filter(
    (file) =>
      /\bFaceBvh\b/.test(stripComments(read(file))) && relative(REPO_ROOT, file) !== AUTHORITY,
  );
  it('finds exactly the four hole-fill modules and the connector axial check', () => {
    expect(consumers.map((file) => relative(REPO_ROOT, file)).sort()).toEqual(
      [
        join('packages', 'mesh-hole-fill', 'src', 'appended-face-index.ts'),
        join('packages', 'mesh-hole-fill', 'src', 'engine.ts'),
        join('packages', 'mesh-hole-fill', 'src', 'local-intersection.ts'),
        join('packages', 'mesh-hole-fill', 'src', 'surgery-gate.ts'),
        // Release 2, Slice 2C: the connector's receiving-material check is the first consumer outside hole fill
        join('packages', 'geometry-runtime', 'src', 'connector-axial.ts'),
        join('packages', 'mesh-core', 'src', 'spatial', 'index.ts'),
      ].sort(),
    );
  });
  it('imports FaceBvh only through the package specifier', () => {
    for (const file of consumers) {
      if (file.endsWith(join('spatial', 'index.ts'))) continue;
      const specifiers = importSpecifiers(read(file));
      expect(specifiers, relative(REPO_ROOT, file)).toContain(SPATIAL_SPECIFIER);
      expect(
        specifiers.filter(
          (specifier) => specifier.includes('face-bvh') || specifier.endsWith('/bvh'),
        ),
      ).toEqual([]);
    }
  });
  it('is not re-exported by the feature package, so the old location has no alias', () => {
    const holeFillIndex = stripComments(
      read(join(REPO_ROOT, 'packages', 'mesh-hole-fill', 'src', 'index.ts')),
    );
    for (const symbol of [
      'FaceBvh',
      'faceBoxOf',
      'boxesOverlap',
      'createCounters',
      'BroadphaseCounters',
      'BroadphaseBudget',
    ])
      expect(holeFillIndex).not.toContain(symbol);
  });
});

describe('the spatial module stays out of the page bundle', () => {
  it('is not re-exported by the mesh-core index', () => {
    const index = stripComments(read(join(REPO_ROOT, 'packages', 'mesh-core', 'src', 'index.ts')));
    expect(index).not.toMatch(/spatial|FaceBvh|face-bvh/);
  });
  it('is declared as its own subpath export', () => {
    const manifest = JSON.parse(read(join(REPO_ROOT, 'packages', 'mesh-core', 'package.json'))) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports['./spatial']).toBe('./src/spatial/index.ts');
  });
  it('is imported by no main-thread file', () => {
    const root = join(REPO_ROOT, 'apps', 'web', 'src');
    const offenders = sourceFilesUnder(root)
      .filter((file) => !relative(root, file).startsWith(`workers${sep}`))
      .filter((file) =>
        importSpecifiers(read(file)).some((specifier) => specifier.startsWith(SPATIAL_SPECIFIER)),
      )
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
  it('is not reachable from the hole-fill ADMISSION subpath the authoritative geometry worker may import', () => {
    const packageSource = join(REPO_ROOT, 'packages', 'mesh-hole-fill', 'src');
    const reached = new Set<string>();
    const visit = (file: string): void => {
      if (reached.has(file)) return;
      reached.add(file);
      for (const specifier of importSpecifiers(read(join(packageSource, file)))) {
        expect(specifier.startsWith(SPATIAL_SPECIFIER), `${file} reaches the broadphase`).toBe(
          false,
        );
        if (specifier.startsWith('./')) visit(`${specifier.slice(2)}.ts`);
      }
    };
    visit('admission-entry.ts');
    expect(reached.size).toBeGreaterThan(3);
  });
});
