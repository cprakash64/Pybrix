# Deployment Requirements

CAD Fixer is a static site. It has no backend, no database, and no server-side
geometry processing. Hosting it correctly is mostly a matter of sending the
right headers.

## 1. Cross-origin isolation (required)

Multithreaded WebAssembly geometry kernels need `SharedArrayBuffer` and
pthreads. Browsers only expose `SharedArrayBuffer` in a **cross-origin isolated**
context. The host must therefore serve the application document with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

and every subresource must either be same-origin or carry
`Cross-Origin-Resource-Policy` / valid CORS headers. We additionally send
`Cross-Origin-Resource-Policy: same-origin` on our own assets.

Verify with `globalThis.crossOriginIsolated === true`. The Runtime panel in the
application shows this, and the Playwright suite asserts it.

### Why this is configured now

Cross-origin isolation is easy to satisfy on an empty application and painful to
retrofit onto one that has accumulated third-party embeds. Configuring it in
Stage 0 means any resource that would break it fails immediately, in local
development, rather than during a deployment months from now.

### Local development

`apps/web/vite.config.ts` sends the same three headers from both the dev server
(`vite`) and the preview server (`vite preview`). No workaround or proxy is
needed, and development is not degraded to simulate production.

### Consequences for third-party resources

**Every future third-party resource must be evaluated for cross-origin
isolation compatibility before adoption.** Under `require-corp`, a cross-origin
resource that does not send `Cross-Origin-Resource-Policy` or appropriate CORS
headers **will not load at all**.

This rules out, by default: CDN-hosted fonts and scripts, third-party analytics
snippets, embedded iframes without CORP, and hotlinked images. The project
avoids all of these for privacy reasons anyway — see
[PRIVACY_ARCHITECTURE.md](PRIVACY_ARCHITECTURE.md) — so the two constraints
reinforce each other.

If isolation ever has to be dropped, the cost is losing multithreaded WASM.
That is an architectural decision requiring an ADR, not a hosting tweak.

## 2. Security headers (required, PR-01)

Stated once in `apps/web/security-headers.ts`, sent by `vite preview` (so every
end-to-end run exercises the product under them) and by
`deploy/nginx/cad-fixer-security-headers.conf` in production, which
`scripts/hostinger-deployment.test.ts` holds to the same values:

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=()
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

**Why each allowance exists — measured, not assumed.** The policy previously
recorded here (`connect-src 'none'`, no `wasm-unsafe-eval`) was run against the
built application in PR-01 and broke Split, Surface Texture and the
self-intersection check:

- `script-src 'wasm-unsafe-eval'` — compiling the Geogram and Manifold
  WebAssembly modules requires it. No `'unsafe-eval'`, no inline script.
- `connect-src 'self'` — each kernel's Emscripten loader `fetch()`es its own
  `.wasm` from this origin. That same-origin fetch is the only request the
  application makes after load; `'self'` still stops any connection to another
  origin, which is what makes the privacy promise browser-enforced.
- `worker-src 'self'` — every worker is a same-origin module file; no `blob:`.
- `img-src data:` — the favicon is an inline SVG data URI.

`vite dev` deliberately does not send the CSP: its hot-reload preamble is an
inline script. Anything that changes what the application loads must be re-run
under the policy — the end-to-end suite does this automatically.

## 3. Serving requirements

- **HTTPS.** `crossOriginIsolated` and workers require a secure context.
- **Correct MIME types.** `.js` as `text/javascript`, `.wasm` as
  `application/wasm`. A wrong WASM type breaks streaming compilation.
- **SPA fallback** is not needed today — the application is a single document
  with no client-side routing.
- **Immutable asset caching.** Vite emits content-hashed filenames, so
  `assets/*` can be `Cache-Control: public, max-age=31536000, immutable`.
  `index.html` must **not** be cached that way.

## 4. Build output

```bash
npm run build
```

produces `apps/web/dist/`: `index.html`, hashed assets, and the geometry worker
as its own chunk. It is fully static — any static host that can set the headers
above will serve it.

## 5. What deployment must never introduce

- A server-side geometry endpoint.
- A file upload endpoint.
- Injected third-party tags at the edge (analytics, tag managers, session
  replay). These would break both the privacy promise and, under
  `require-corp`, quite possibly the application.

## 6. Auto Split's optional service (ADR 0020)

The static site is complete without it. To offer Auto Split (Beta), deploy the analysis service
beside it, from the same commit, as described in `deploy/auto-split/README.md`:

- The service is a separate process (`apps/auto-split-api`, built to `dist/main.js`) listening on
  **127.0.0.1 only**, run unprivileged by systemd with its key in a root-owned, mode-0600 environment
  file. The key is never in the repository, the unit, the release bundle or the browser.
- nginx proxies **exactly** `/api/auto-split/analyze` (POST, body ≤ the contract's ceiling) and
  `/api/auto-split/health` (GET) to that port, sets `X-Real-IP` from the socket, forwards no credentials,
  and answers 404 for everything else under `/api/auto-split/`. The snippet is
  `deploy/nginx/cad-fixer-auto-split.conf`; the static template includes it by a glob that may match
  nothing.
- **The Content-Security-Policy is unchanged** (`connect-src 'self'`). Do not widen it for this feature.
- The mock provider and the test server are **not deployable**: the production entry refuses
  `AUTO_SPLIT_PROVIDER=mock`.
