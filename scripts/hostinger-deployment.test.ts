import { scanArtifactPaths } from './audit-artifact-paths.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BODY_BYTES, PROVIDER_TIMEOUT_MS } from '@cadfixer/auto-split-contract';
import { PRODUCTION_SECURITY_HEADERS } from '../apps/web/security-headers';

/**
 * HV-C01–HV-C20 — THE HOSTINGER DEPLOYMENT CONTRACT.
 *
 * CAD Fixer deploys as static files behind nginx on a SHARED production VPS
 * that already serves other people's live sites. Two things can go wrong here
 * that no type checker can see:
 *
 *   1. THE RELEASE ARTIFACT SHIPS SOMETHING IT SHOULD NOT. A source map, a
 *      stray fixture, an environment file — published to the internet.
 *
 *   2. THE NGINX CONFIG SILENTLY DROPS THE ISOLATION HEADERS. nginx inherits
 *      `add_header` into a location ONLY while that location sets none of its
 *      own, so adding Cache-Control to /assets/ removes COOP and COEP from
 *      every asset. SharedArrayBuffer then disappears and conservative repair
 *      fails closed — in production only.
 *
 * These tests read the real packager, the real templates and the real artifact.
 * They do not restate constants that could drift from the thing they describe.
 *
 * Tests needing the packaged artifact skip when it is absent — `npm test` runs
 * before `npm run build` in CI, and a suite that fails for a missing generated
 * directory teaches people to ignore it. Run `npm run release:build` first to
 * exercise them; the Stage 5C reports state when they were run.
 */

const REPO_ROOT = join(import.meta.dirname, '..');
const PACKAGER = join(REPO_ROOT, 'scripts', 'build-release-artifact.mjs');
const DEPLOY_DIR = join(REPO_ROOT, 'deploy', 'nginx');
const SNIPPET = join(DEPLOY_DIR, 'cad-fixer-security-headers.conf');
const SITE_TEMPLATE = join(DEPLOY_DIR, 'zz-cad-fixer.conf.template');
const SITE_DIR = join(REPO_ROOT, 'artifacts', 'release', 'site');
const MANIFEST = join(REPO_ROOT, 'artifacts', 'release', 'release-manifest.json');
const DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
const KERNEL = join(
  REPO_ROOT,
  'packages',
  'self-intersection-kernel',
  'artifacts',
  'self-intersection.wasm',
);

const EXPECTED_KERNEL_SHA256 = 'daf40745eee279df051f90b199b65f7cf26882db065e743bb8631f65d6ffaaa3';
const STAGING_PLACEHOLDER = '<CAD_FIXER_STAGING_HOST>';
const SECURITY_SNIPPET_INCLUDE = 'include /etc/nginx/snippets/cad-fixer-security-headers.conf;';

const snippetText = readFileSync(SNIPPET, 'utf8');
const templateText = readFileSync(SITE_TEMPLATE, 'utf8');
const packagerText = readFileSync(PACKAGER, 'utf8');

/**
 * nginx configuration with `#` comments removed — what nginx actually reads.
 *
 * Stripping matters more than it looks: both files EXPLAIN in prose the traps
 * they avoid (the inheritance rule, the absent CSP), so a check against raw
 * text can be satisfied by the explanation rather than by a directive. These
 * tests assert on directives.
 */
const stripComments = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      const hash = line.indexOf('#');
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join('\n');

const artifactBuilt = existsSync(SITE_DIR) && existsSync(MANIFEST);

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}
interface Manifest {
  schema: string;
  schemaVersion: number;
  source: { commit: string; workingTreeClean: boolean };
  deployable: { fileCount: number; totalBytes: number; files: ManifestFile[] };
  excluded: { fileCount: number; files: { path: string; reason: string }[] };
  kernel: { sha256: string };
}

const manifest: Manifest | undefined = artifactBuilt
  ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest)
  : undefined;

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

const siteFiles = (): string[] =>
  walk(SITE_DIR)
    .map((a) => relative(SITE_DIR, a).split('\\').join('/'))
    .sort();

/**
 * Strip comments, then split the template into `location` blocks by brace
 * depth. Comment stripping matters: the template EXPLAINS the inheritance trap
 * in prose, and a naive `includes()` would be satisfied by the explanation
 * rather than by the directive.
 */
function locationBlocks(text: string): { header: string; body: string }[] {
  const code = stripComments(text);

  const blocks: { header: string; body: string }[] = [];
  const re = /location\s+([^{]*)\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push({ header: (match[1] ?? '').trim(), body: code.slice(re.lastIndex, i - 1) });
  }
  return blocks;
}

const blocks = locationBlocks(templateText);

const templateCode = stripComments(templateText);

describe('HV-C01–HV-C06 — the release artifact', () => {
  it.skipIf(!artifactBuilt)('HV-C01: the manifest names the exact commit it was built from', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    expect(manifest?.source.commit).toBe(head);
    expect(manifest?.schema).toBe('cad-fixer.release-manifest');
    /*
     * The packager refuses a dirty tracked tree unless --allow-dirty is
     * passed, and records which it was. A manifest naming a commit it was not
     * built from is worse than no manifest at all.
     */
    expect(typeof manifest?.source.workingTreeClean).toBe('boolean');
  });

  it.skipIf(!artifactBuilt)('HV-C02: no source map is deployable', () => {
    expect(siteFiles().filter((p) => p.endsWith('.map'))).toEqual([]);
    expect(manifest?.excluded.files.every((f) => f.reason.length > 0)).toBe(true);
    expect(manifest?.excluded.files.some((f) => f.path.endsWith('.map'))).toBe(true);
  });

  it.skipIf(!artifactBuilt)('HV-C03: no credential or source file is deployable', () => {
    for (const path of siteFiles()) {
      expect(path).not.toMatch(/\.env($|\.)/);
      expect(path).not.toMatch(/\.dev\.vars/);
      expect(path).not.toMatch(/\.(pem|key|p12|pfx)$/);
      expect(path).not.toMatch(/(^|\/)\.git(\/|$)/);
      expect(path).not.toMatch(/node_modules/);
      expect(path).not.toMatch(/\.(ts|tsx)$/);
      expect(path).not.toMatch(/\.(test|spec)\./);
      expect(path).not.toBe('release-manifest.json');
    }
    /* The manifest describes the artifact; it is never part of it. */
    expect(existsSync(join(SITE_DIR, 'release-manifest.json'))).toBe(false);
  });

  it.skipIf(!artifactBuilt)('HV-C04: both qualified geometry kernels are deployable', () => {
    const wasm = siteFiles().filter((path) => path.endsWith('.wasm'));
    expect(wasm).toHaveLength(2);
    expect(wasm.some((path) => path.includes('self-intersection-'))).toBe(true);
    expect(wasm.some((path) => path.includes('manifold-candidate-'))).toBe(true);
  });

  it('HV-C05: the shipped kernel is the qualified artifact', () => {
    expect(sha256(KERNEL)).toBe(EXPECTED_KERNEL_SHA256);
    /* The packager enforces this itself, so the gate cannot be bypassed. */
    expect(packagerText).toContain(EXPECTED_KERNEL_SHA256);
  });

  it.skipIf(!artifactBuilt)('HV-C06: packaged bytes are identical to the build output', () => {
    expect(existsSync(DIST)).toBe(true);
    for (const path of siteFiles()) {
      const built = join(DIST, path);
      expect(existsSync(built), `${path} must exist in dist`).toBe(true);
      expect(sha256(join(SITE_DIR, path)), `${path} must not be rewritten`).toBe(sha256(built));
    }
    const recorded = manifest?.deployable.files ?? [];
    expect(recorded.map((f) => f.path)).toEqual(siteFiles());
    for (const file of recorded) {
      expect(sha256(join(SITE_DIR, file.path))).toBe(file.sha256);
      expect(statSync(join(SITE_DIR, file.path)).size).toBe(file.bytes);
    }
  });
});

describe('HV-C21 — the Pybrix identity in the artifact (BRAND-01)', () => {
  const TEXT = /\.(html|js|css|txt|json|svg)$/;

  it.skipIf(!artifactBuilt)('HV-C21a: both declared icons are shipped, fingerprinted files', () => {
    const shell = readFileSync(join(SITE_DIR, 'index.html'), 'utf8');
    for (const rel of ['icon', 'apple-touch-icon']) {
      const href = new RegExp(`<link rel="${rel}"[^>]*href="/(assets/pybrix-[^"]+\\.png)"`).exec(
        shell,
      )?.[1];
      expect(href, rel).toBeDefined();
      expect(siteFiles()).toContain(href);
    }
  });

  it.skipIf(!artifactBuilt)(
    'HV-C21b: the shell is titled Pybrix and names no legacy product',
    () => {
      const shell = readFileSync(join(SITE_DIR, 'index.html'), 'utf8');
      expect(shell).toMatch(/<title>Pybrix — /);
      expect(shell).toContain('<meta name="application-name" content="Pybrix" />');
      expect(shell).toContain('<link rel="canonical" href="https://pybrix.com/" />');
      expect(shell).not.toMatch(/cad[\s_-]*fixer/i);
    },
  );

  it.skipIf(!artifactBuilt)('HV-C21c: no deployable file carries a local filesystem path', () => {
    for (const path of siteFiles()) {
      expect(scanArtifactPaths(readFileSync(join(SITE_DIR, path))), path).toEqual([]);
      if (TEXT.test(path)) {
        const text = readFileSync(join(SITE_DIR, path), 'utf8');
        expect(text, path).not.toMatch(/\/Users\/|cprakash|Documents\/CAD|brand-source/);
      }
    }
  });

  it.skipIf(!artifactBuilt)(
    'HV-C21e: no shipped text names the legacy product (identifiers excepted)',
    () => {
      // The display name has a space; the retained identifiers never do
      // (`cadfixer.geometry.v1`, `cadfixer-geometry`). Checking the BUILT text
      // catches a name split across a `+` in source, which the bundler joins:
      // exactly how one sentence escaped the source-level audit.
      for (const path of siteFiles().filter((p) => TEXT.test(p))) {
        const text = readFileSync(join(SITE_DIR, path), 'utf8');
        expect(text, path).not.toMatch(/CAD\s+Fixer/i);
      }
    },
  );

  it.skipIf(!artifactBuilt)(
    'HV-C21d: only the used brand derivatives ship, never a source original',
    () => {
      const brand = siteFiles().filter((p) => /pybrix/i.test(p));
      expect(brand.map((p) => p.replace(/-[A-Za-z0-9_-]{8}\.png$/, '.png')).sort()).toEqual([
        'assets/pybrix-apple-touch-icon.png',
        'assets/pybrix-favicon-32.png',
        'assets/pybrix-logo-horizontal.png',
        'assets/pybrix-tile-96.png',
      ]);
      const bytes = brand.reduce((sum, p) => sum + statSync(join(SITE_DIR, p)).size, 0);
      expect(bytes).toBeLessThan(160 * 1024);
    },
  );
});

describe('HV-C07–HV-C11 — the nginx site template', () => {
  it('HV-C07: declares no default_server', () => {
    /*
     * The audited VPS marks NO vhost default_server, so nginx uses the first
     * block loaded per listen socket. A default_server here would take the bare
     * IP away from a live site; the `zz-` filename keeps us loading last.
     */
    expect(templateCode).not.toMatch(/default_server/);
    expect(templateCode).toMatch(/listen\s+80\s*;/);
  });

  it('HV-C08: uses the staging-host placeholder and no real hostname', () => {
    expect(templateCode).toContain(STAGING_PLACEHOLDER);
    const serverNames = [...templateCode.matchAll(/server_name\s+([^;]+);/g)].map((m) =>
      (m[1] ?? '').trim(),
    );
    expect(serverNames).toEqual([STAGING_PLACEHOLDER]);
    /* No real domain, and no server address, may appear in a public template. */
    expect(templateCode).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  it('HV-C09: the static template proxies nothing — Auto Split is a separate, optional snippet', () => {
    expect(templateCode).not.toMatch(/proxy_pass/);
    expect(templateCode).not.toMatch(/upstream\s/);
    // The ONLY way the template reaches the service is an optional include whose glob may match nothing.
    const includes = [...templateCode.matchAll(/^\s*include\s+([^;]+);/gm)].map((m) => m[1]);
    expect(includes).toContain('/etc/nginx/snippets/cad-fixer-auto-split*.conf');
  });

  it('HV-C10: no PHP, FastCGI, uWSGI, SCGI or directory listing', () => {
    expect(templateCode).not.toMatch(/fastcgi/i);
    expect(templateCode).not.toMatch(/uwsgi_pass/i);
    expect(templateCode).not.toMatch(/scgi_pass/i);
    expect(templateCode).not.toMatch(/\.php/i);
    expect(templateCode).toMatch(/autoindex\s+off\s*;/);
  });

  it('HV-C11: a missing path 404s — there is no SPA fallback', () => {
    /*
     * CAD Fixer has no client router. A catch-all rewrite to the shell would
     * return HTML under a JavaScript content type for a missing chunk, which is
     * a confusing failure instead of a clear one.
     */
    expect(templateCode).not.toMatch(/try_files[^;]*\/index\.html\s*;/);
    expect(templateCode).not.toMatch(/=200/);
    const catchAll = blocks.find((b) => b.header === '/');
    expect(catchAll, 'template must define location /').toBeDefined();
    expect(catchAll?.body).toMatch(/try_files[^;]*=404\s*;/);
    for (const block of blocks) {
      expect(block.body, `location ${block.header} must end in =404`).toMatch(/=404/);
    }
  });
});

describe('HV-C12–HV-C19 — headers, inheritance and cache policy', () => {
  const directive = (name: string): string | undefined => {
    const pattern = new RegExp(`^\\s*add_header\\s+${name}\\s+"([^"]*)"\\s+always;`, 'm');
    return pattern.exec(snippetText)?.[1];
  };

  it('HV-C12: Cross-Origin-Opener-Policy is exactly same-origin', () => {
    expect(directive('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('HV-C13: Cross-Origin-Embedder-Policy is exactly require-corp', () => {
    expect(directive('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  it('HV-C14: Cross-Origin-Resource-Policy is exactly same-origin', () => {
    expect(directive('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('HV-C15: X-Content-Type-Options is exactly nosniff', () => {
    expect(directive('X-Content-Type-Options')).toBe('nosniff');
  });

  it('HV-C16: Referrer-Policy is exactly no-referrer', () => {
    expect(directive('Referrer-Policy')).toBe('no-referrer');
  });

  it('HV-C12-16: every directive uses `always`', () => {
    const headers = [...snippetText.matchAll(/^\s*add_header\s+(\S+)/gm)].map((m) => m[1]);
    expect(headers).toEqual([
      'Cross-Origin-Opener-Policy',
      'Cross-Origin-Embedder-Policy',
      'Cross-Origin-Resource-Policy',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Content-Security-Policy',
      'Permissions-Policy',
      'X-Frame-Options',
    ]);
    /* `always` is what puts the headers on a 404 as well as a 200. */
    // Parsed as name, QUOTED value, `always` — the CSP's value contains `;`.
    const count = [...snippetText.matchAll(/^\s*add_header\s+\S+\s+"[^"]*"\s+always;/gm)].length;
    expect(count).toBe(8);
  });

  /*
   * PR-01 REVERSES THE 5C-1A DEFERRAL, ON EVIDENCE. The policy is stated once,
   * in apps/web/security-headers.ts; `vite preview` sends it, so every
   * end-to-end run exercises the product under it, and this holds production
   * to the same values rather than to a second hand-written copy.
   */
  it('PR01-H1: the snippet sends exactly the security headers the application states', () => {
    for (const [name, value] of Object.entries(PRODUCTION_SECURITY_HEADERS))
      expect(directive(name), name).toBe(value);
  });

  it('PR01-H2: the CSP allows what the product needs and nothing broader', () => {
    const csp = directive('Content-Security-Policy') ?? '';
    // The kernels compile WebAssembly and their loaders fetch their own .wasm.
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self'");
    // Never eval, never inline script, never a remote origin, never framed.
    expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'|https?:|\*/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
  });

  it('HV-C17: every location setting a header re-includes the security snippet', () => {
    /*
     * THE LOAD-BEARING TEST. nginx drops all inherited add_headers from a
     * location that defines one of its own, so a Cache-Control without this
     * include would silently remove COOP and COEP from that location.
     */
    const setsHeaders = blocks.filter((b) => b.body.includes('add_header'));
    expect(setsHeaders.length).toBeGreaterThan(0);
    for (const block of setsHeaders) {
      expect(
        block.body,
        `location ${block.header} sets a header and must re-include the snippet`,
      ).toContain(SECURITY_SNIPPET_INCLUDE);
    }
    /* And the server level includes it for every location that sets none. */
    const serverLevel = templateCode.slice(0, templateCode.indexOf('location'));
    expect(serverLevel).toContain(SECURITY_SNIPPET_INCLUDE);
  });

  it('HV-C18: the HTML shell is revalidated and never immutable', () => {
    const html = blocks.find((b) => b.header === '= /index.html');
    expect(html, 'template must define location = /index.html').toBeDefined();
    expect(html?.body).toMatch(/add_header\s+Cache-Control\s+"no-cache"\s+always;/);
    expect(html?.body).not.toMatch(/immutable/);
  });

  it('HV-C19: hashed assets are immutably cacheable', () => {
    const assets = blocks.find((b) => b.header === '/assets/');
    expect(assets, 'template must define location /assets/').toBeDefined();
    expect(assets?.body).toMatch(
      /add_header\s+Cache-Control\s+"public, max-age=31536000, immutable"\s+always;/,
    );
  });
});

describe('HV-C20 — provider isolation', () => {
  it('HV-C20: no active Cloudflare deployment artifact or dependency exists', () => {
    for (const path of [
      'wrangler.jsonc',
      'wrangler.toml',
      'wrangler.json',
      join('apps', 'web', 'public', '_headers'),
      join('apps', 'web', 'public', '.assetsignore'),
      join('scripts', 'cloudflare-deployment.test.ts'),
    ]) {
      expect(existsSync(join(REPO_ROOT, path)), `${path} must not exist`).toBe(false);
    }

    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    for (const name of names) {
      expect(name).not.toBe('wrangler');
      expect(name.startsWith('@cloudflare/')).toBe(false);
    }

    /*
     * Historical documents discuss the Cloudflare research accurately and must
     * keep doing so. This test is about ACTIVE deployment configuration, so it
     * looks at the deployment templates and the packager only.
     */
    for (const text of [templateText, snippetText, packagerText]) {
      expect(text.toLowerCase()).not.toContain('cloudflare');
      expect(text.toLowerCase()).not.toContain('wrangler');
    }
  });
});

describe("HV-C30–HV-C37 — Auto Split's optional same-origin service (ADR 0020)", () => {
  const AUTO_SPLIT_SNIPPET = join(DEPLOY_DIR, 'cad-fixer-auto-split.conf');
  const UNIT = join(REPO_ROOT, 'deploy', 'auto-split', 'cad-fixer-auto-split.service');
  const ENV_EXAMPLE = join(REPO_ROOT, 'deploy', 'auto-split', 'auto-split.env.example');
  const snippetCode = stripComments(readFileSync(AUTO_SPLIT_SNIPPET, 'utf8'));
  const proxyBlocks = locationBlocks(readFileSync(AUTO_SPLIT_SNIPPET, 'utf8'));
  const body = (header: string): string => proxyBlocks.find((b) => b.header === header)?.body ?? '';

  it('HV-C30: defines exactly the analyze and health locations and a 404 for the rest', () => {
    expect(proxyBlocks.map((b) => b.header).sort()).toEqual(
      ['/api/auto-split/', '= /api/auto-split/analyze', '= /api/auto-split/health'].sort(),
    );
    expect(body('/api/auto-split/').trim()).toBe('return 404;');
  });

  it('HV-C31: proxies only to the one loopback port, with no variable and no upstream', () => {
    const targets = [...snippetCode.matchAll(/proxy_pass\s+([^;]+);/g)].map((m) => m[1]);
    expect(targets).toEqual(['http://127.0.0.1:8787', 'http://127.0.0.1:8787']);
    expect(snippetCode).not.toMatch(/proxy_pass\s+[^;]*\$/);
    expect(snippetCode).not.toMatch(/upstream\s/);
    expect(snippetCode).not.toMatch(/\brewrite\b/);
    expect(snippetCode).not.toMatch(/proxy_cache/);
  });

  it('HV-C32: the analysis location takes POST only, and a body no larger than the contract allows', () => {
    const analyze = body('= /api/auto-split/analyze');
    expect(analyze).toMatch(/limit_except\s+POST\s*\{\s*deny\s+all;\s*\}/);
    const size = /client_max_body_size\s+(\d+)k;/.exec(analyze);
    expect(size, 'client_max_body_size must be stated in KiB').not.toBeNull();
    const bytes = Number(size?.[1]) * 1024;
    // Not below what a valid request needs, and not a generous multiple of it.
    expect(bytes).toBeGreaterThanOrEqual(MAX_REQUEST_BODY_BYTES);
    expect(bytes).toBeLessThan(MAX_REQUEST_BODY_BYTES * 1.1);
  });

  it('HV-C33: waits for the provider deadline plus a margin, and releases the provider when the browser leaves', () => {
    const analyze = body('= /api/auto-split/analyze');
    const read = /proxy_read_timeout\s+(\d+)s;/.exec(analyze);
    expect(Number(read?.[1])).toBeGreaterThan(PROVIDER_TIMEOUT_MS / 1000);
    expect(Number(read?.[1])).toBeLessThanOrEqual(300);
    expect(analyze).toMatch(/proxy_ignore_client_abort\s+off;/);
    expect(analyze).toMatch(/proxy_buffering\s+off;/);
  });

  it('HV-C34: the client address is set from the socket and credentials are never forwarded', () => {
    const analyze = body('= /api/auto-split/analyze');
    expect(analyze).toMatch(/proxy_set_header\s+X-Real-IP\s+\$remote_addr;/);
    expect(analyze).toMatch(/proxy_set_header\s+X-Forwarded-For\s+"";/);
    expect(analyze).toMatch(/proxy_set_header\s+Authorization\s+"";/);
    expect(analyze).toMatch(/proxy_set_header\s+Cookie\s+"";/);
  });

  it('HV-C35: every location that sets a header re-includes the security snippet, and nothing is cached', () => {
    for (const block of proxyBlocks.filter((b) => b.body.includes('add_header'))) {
      expect(block.body, block.header).toContain(SECURITY_SNIPPET_INCLUDE);
      expect(block.body, block.header).toMatch(/Cache-Control\s+"no-store"/);
    }
  });

  it('HV-C36: the service runs unprivileged, from a root-owned environment file, with no key in the unit', () => {
    const unit = stripComments(readFileSync(UNIT, 'utf8'));
    expect(unit).toMatch(/^User=(?!root\b)\S+/m);
    expect(unit).toMatch(/^EnvironmentFile=\/etc\/cad-fixer\/auto-split\.env$/m);
    expect(unit).toMatch(/^NoNewPrivileges=true$/m);
    expect(unit).toMatch(/^ProtectSystem=strict$/m);
    expect(unit).not.toMatch(/OPENAI_API_KEY/);
    expect(unit).not.toMatch(/sk-/);
  });

  it('HV-C37: the environment example holds no secret and listens on loopback only', () => {
    const env = stripComments(readFileSync(ENV_EXAMPLE, 'utf8'));
    expect(env).toMatch(/^OPENAI_API_KEY=$/m);
    expect(env).toMatch(/^AUTO_SPLIT_HOST=127\.0\.0\.1$/m);
    expect(env).toMatch(/^AUTO_SPLIT_PROVIDER=openai$/m);
    expect(env).not.toMatch(/sk-[A-Za-z0-9]/);
    // The mock provider is not a deployable setting.
    expect(env).not.toMatch(/AUTO_SPLIT_PROVIDER=mock/);
  });
});
