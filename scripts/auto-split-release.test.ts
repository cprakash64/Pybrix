import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AUTO SPLIT — WHAT SHIPS, AND WHAT MUST NOT.
 *
 * Three questions, each answered from bytes rather than from intent:
 *   1. Does the static release bundle contain a key, a provider host, a header name or any trace of the
 *      service, the mock or the test models?
 *   2. Does the service bundle contain the mock provider, the test models or a key?
 *   3. Does any tracked file in the repository contain something shaped like a provider key?
 *
 * The web build and the packaged site are scanned when they exist (`npm test` runs before `npm run
 * build`, and a suite that fails for a missing generated directory teaches people to ignore it); the
 * service bundle is built here, because it takes a second.
 */

const REPO_ROOT = join(import.meta.dirname, '..');
const SITE_DIR = join(REPO_ROOT, 'artifacts', 'release', 'site');
const DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
const API = join(REPO_ROOT, 'apps', 'auto-split-api');

/** Shaped like a provider key: `sk-` and a long token. The one fake key the service's tests use is exempt. */
const KEY_SHAPE = /sk-(?:proj-|live-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g;
const FAKE_TEST_KEY = 'sk-test-0000000000000000000000-DO-NOT-LOG';

const TEXT =
  /\.(?:js|mjs|css|html|json|map|txt|svg|md|ts|tsx|yml|yaml|conf|service|example|template)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const NEVER_IN_A_BROWSER_BUNDLE = [
  'OPENAI_API_KEY',
  'api.openai.com',
  'gpt-6.1-sol',
  '__mock',
  'test-server',
  'scenarioAnswer',
  'humanFigure',
  'carMultipart',
  'truckFused',
  'carFused',
  'openCube',
  'Bearer ',
];

describe('the browser build and the release bundle', () => {
  const roots = [DIST, SITE_DIR].filter((dir) => existsSync(dir));

  it.skipIf(roots.length === 0)('name no key, provider, mock or test model', () => {
    const offenders: string[] = [];
    for (const root of roots)
      for (const file of walk(root).filter((f) => TEXT.test(f))) {
        const text = readFileSync(file, 'utf8');
        for (const needle of NEVER_IN_A_BROWSER_BUNDLE)
          if (text.includes(needle)) offenders.push(`${relative(REPO_ROOT, file)}: ${needle}`);
        for (const match of text.matchAll(KEY_SHAPE))
          offenders.push(`${relative(REPO_ROOT, file)}: key-shaped ${match[0].slice(0, 6)}…`);
      }
    expect(offenders).toEqual([]);
  });

  it.skipIf(roots.length === 0)('contain no research corpus, provenance or screenshot', () => {
    const names = roots.flatMap((root) => walk(root).map((f) => relative(root, f).toLowerCase()));
    for (const name of names) {
      expect(name, name).not.toMatch(/research|holdout|corpus|provenance|screenshot|fixture/);
    }
  });

  it.skipIf(!existsSync(DIST))(
    'contain exactly one same-origin analysis URL and no other API path',
    () => {
      const urls = new Set<string>();
      for (const file of walk(DIST).filter((f) => /\.(?:js|html)$/.test(f))) {
        for (const match of readFileSync(file, 'utf8').matchAll(
          /["'`](\/api\/[A-Za-z0-9/_-]+)["'`]/g,
        ))
          urls.add(match[1] ?? '');
      }
      expect([...urls]).toEqual(['/api/auto-split/analyze']);
    },
  );
});

describe('the service bundle', () => {
  it('is built from the production entry alone, with no mock, no test model and no key', () => {
    const out = mkdtempSync(join(tmpdir(), 'auto-split-service-'));
    try {
      execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], {
        cwd: API,
        stdio: 'pipe',
      });
      const files = walk(out);
      expect(files.map((f) => relative(out, f))).toEqual(['main.js']);
      const text = readFileSync(join(out, 'main.js'), 'utf8');
      for (const needle of [
        '__mock',
        'test-server',
        'scenarioAnswer',
        'humanFigure',
        'carMultipart',
        'truckFused',
        'openCube',
        FAKE_TEST_KEY,
      ])
        expect(text, needle).not.toContain(needle);
      expect(text.match(KEY_SHAPE) ?? []).toEqual([]);
      // What it MUST contain: the pinned model, and the request that does not store.
      expect(text).toContain('gpt-6.1-sol');
      expect(text).toMatch(/store:\s*false/);
      expect(text).toContain('allowMock: false');
      expect(statSync(join(out, 'main.js')).size).toBeLessThan(512 * 1024);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('the repository', () => {
  it('holds no provider-key-shaped string beyond the one fake the service tests use', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(
        (f) =>
          f !== '' && TEXT.test(f) && !f.startsWith('experiments/') && !f.startsWith('research/'),
      );
    const offenders: string[] = [];
    for (const file of tracked) {
      const path = join(REPO_ROOT, file);
      if (!existsSync(path) || statSync(path).size > 4 * 1024 * 1024) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(KEY_SHAPE))
        if (match[0] !== FAKE_TEST_KEY && !match[0].startsWith('sk-test-'))
          offenders.push(`${file}: ${match[0].slice(0, 12)}…`);
    }
    expect(offenders).toEqual([]);
  });

  it('tracks no environment file with a value for the key', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => /(^|\/)\.env($|\.)|auto-split\.env/.test(f));
    for (const file of tracked) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/^OPENAI_API_KEY=\S+/m);
    }
  });
});
