import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE SHIPPED NOTICES AND THE SOURCE-TREE LICENCES MAY NOT DRIFT.
 *
 * Third-party artwork carries its licence beside it in the source tree, as
 * vendored code does (`workers/third-party/manifold/LICENSE`). Everything the
 * application DISTRIBUTES — fonts, icons, the bundled npm packages and the
 * WebAssembly kernels with their runtime — has its notice shipped too, as
 * `apps/web/public/third-party-notices.txt`, a static file Vite copies beside
 * the application, never part of its code. Two copies of a licence can
 * disagree; this holds them to each other, and holds every shipped font to a
 * notice that names it.
 */

const ROOT = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const SHIPPED = 'apps/web/public/third-party-notices.txt';
const FONT_DIR = 'apps/web/src/styles/fonts';

describe('third-party notices', () => {
  const shipped = read(SHIPPED);

  it('ships the font licence exactly as it sits beside the fonts', () => {
    expect(shipped).toContain(read(`${FONT_DIR}/LICENSE`).trim());
    expect(shipped).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('ships the icon licence exactly as it sits beside the icons', () => {
    const beside = read('apps/web/src/components/shell/LICENSE-lucide');
    const licence = beside.slice(beside.indexOf('ISC License')).trim();
    expect(licence.length).toBeGreaterThan(0);
    expect(shipped).toContain(licence);
    // Lucide includes Feather's MIT notice; both must travel.
    expect(shipped).toContain('Copyright (c) 2013-present Cole Bemis');
  });

  /*
   * PR-01: THE CODE SHIPS TOO. Before this, the notices covered only fonts and
   * icons, while every deployment also redistributed React, three.js and two
   * WebAssembly kernels whose licences require their text to travel with
   * binary copies. Each licence is held VERBATIM to the file it came from —
   * `node_modules` for the npm packages, and the texts vendored beside the
   * kernels from their pinned upstream commits.
   */
  it.each([
    'packages/geometry-runtime/src/third-party/LICENSE',
    'node_modules/react/LICENSE',
    'node_modules/react-dom/LICENSE',
    'node_modules/scheduler/LICENSE',
    'node_modules/three/LICENSE',
    'packages/self-intersection-kernel/licenses/geogram-LICENSE',
    'packages/self-intersection-kernel/licenses/zlib-NOTICE',
    'apps/web/src/workers/third-party/manifold/LICENSE',
    'apps/web/src/workers/third-party/emscripten/LICENSE',
    'apps/web/src/workers/third-party/emscripten/musl-COPYRIGHT',
  ])('ships %s verbatim', (path) => {
    expect(shipped).toContain(read(path).trimEnd());
  });

  /*
   * An upgrade must revisit the notice. Every runtime package the application
   * bundles is named at its INSTALLED version — the application's own runtime
   * dependencies and React DOM's — so a version bump fails here rather than
   * shipping under a stale entry.
   */
  it('names every bundled npm package at its installed version', () => {
    const manifest = (path: string): { version: string; dependencies?: Record<string, string> } =>
      JSON.parse(read(path)) as { version: string; dependencies?: Record<string, string> };
    const direct = Object.keys(manifest('apps/web/package.json').dependencies ?? {}).filter(
      (name) => !name.startsWith('@cadfixer/'),
    );
    const transitive = Object.keys(
      manifest('node_modules/react-dom/package.json').dependencies ?? {},
    );
    const bundled = [...new Set([...direct, ...transitive])];
    expect(bundled.sort()).toEqual(['react', 'react-dom', 'scheduler', 'three']);
    for (const name of bundled) {
      const { version } = manifest(`node_modules/${name}/package.json`);
      const label =
        name === 'three'
          ? 'three.js'
          : name === 'react'
            ? 'React'
            : name === 'react-dom'
              ? 'React DOM'
              : name;
      expect(shipped, name).toContain(`${label} ${version}`);
    }
  });

  it('names every font file the application ships', () => {
    const fonts = readdirSync(join(ROOT, FONT_DIR)).filter((name) => name.endsWith('.woff2'));
    expect(fonts.length).toBeGreaterThan(0);
    const beside = read(`${FONT_DIR}/LICENSE`);
    for (const font of fonts) expect(beside, font).toContain(`(${font}):`);
  });
});
