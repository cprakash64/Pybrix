#!/usr/bin/env node
/**
 * A minimal static server for the PRODUCTION build, owned by this repository.
 *
 * WHY THIS EXISTS WHEN `vite preview` ALREADY SERVES THE BUILD. Two reasons, and
 * only the second is about convenience:
 *
 *   1. It can serve the build WITHOUT cross-origin isolation headers. That is not
 *      a hypothetical: it is the single most likely production misconfiguration,
 *      and the only way to prove CAD Fixer fails CLOSED rather than quietly
 *      dropping interruptible repair is to actually serve it that way.
 *   2. It is a release-like reference. `vite preview` is a development tool that
 *      happens to send the right headers; a host will not be running Vite. This
 *      file states the serving contract in about a hundred lines of Node with no
 *      dependencies, so `docs/release/PRODUCTION_HOSTING_REQUIREMENTS.md` has
 *      something executable behind it.
 *
 * NOT A PRODUCTION SERVER. CAD Fixer ships as static files; this is a test and
 * documentation fixture. It adds no runtime dependency and nothing imports it.
 *
 * Usage:
 *   node scripts/release-server.mjs [--port 4180] [--no-isolation] [--root DIR]
 *                                   [--deployment-headers]
 *
 * `--deployment-headers` (REPAIR-CORE-07) applies EXACTLY the headers of the deployment template
 * `deploy/nginx/cad-fixer-security-headers.conf` — Content-Security-Policy, Permissions-Policy,
 * the cross-origin trio — so the release-candidate qualification runs the packaged artifact under
 * the policy a real host would send, not under a development server's approximation of it.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const port = Number(flag('--port', '4180'));
const isolate = !args.includes('--no-isolation');
const root = resolve(flag('--root', 'apps/web/dist'));

/** `add_header NAME "VALUE" always;` lines of the deployment template, verbatim. */
function deploymentHeaders() {
  const text = readFileSync(resolve('deploy/nginx/cad-fixer-security-headers.conf'), 'utf8');
  const headers = {};
  for (const line of text.split('\n')) {
    const match = /^\s*add_header\s+(\S+)\s+"(.*)"\s+always;\s*$/.exec(line);
    if (match !== null) headers[match[1]] = match[2];
  }
  if (!('Content-Security-Policy' in headers)) throw new Error('template has no CSP');
  return Object.freeze(headers);
}
const DEPLOYMENT = args.includes('--deployment-headers') ? deploymentHeaders() : {};

/**
 * The MIME types that matter, and every one of them is load-bearing.
 *
 * `application/wasm` is required or `WebAssembly.instantiateStreaming` refuses
 * the response outright, and a module worker served as `text/plain` will not
 * instantiate either. These are exactly the failures that appear only in
 * production, because a dev server guesses them correctly.
 */
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
});

const ISOLATION = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

/** Applied whether or not isolation is on: these are not part of the experiment. */
const ALWAYS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${String(port)}`);

  /*
   * PATH CONTAINMENT. `normalize` collapses `..` before the join, and the result
   * is checked to still be under the root — a served directory is not a place to
   * be relaxed about traversal, even in a fixture.
   */
  const requested = normalize(decodeURIComponent(url.pathname));
  let file = join(root, requested);
  if (!file.startsWith(root + sep) && file !== root) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  // SPA fallback: an unknown path serves the shell, which is what a static host
  // must do for client-side routing to work at all.
  if (!existsSync(file)) file = join(root, 'index.html');

  if (!existsSync(file)) {
    response.writeHead(404).end('Not found');
    return;
  }

  const extension = extname(file);
  const headers = {
    'Content-Type': TYPES[extension] ?? 'application/octet-stream',
    ...ALWAYS,
    ...(isolate ? ISOLATION : {}),
    ...DEPLOYMENT,
    /*
     * CACHING, as the hosting contract requires it. Hashed assets are immutable
     * by construction; the HTML must NOT be, or a browser holding an old shell
     * would keep asking for chunks a deployment has already removed.
     */
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  };

  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
});

server.listen(port, () => {
  process.stdout.write(
    `release server on http://localhost:${String(port)} ` +
      `root=${root} isolation=${isolate ? 'on' : 'OFF'}\n`,
  );
});
