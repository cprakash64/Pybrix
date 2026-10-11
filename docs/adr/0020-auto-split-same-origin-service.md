# 0020 — Auto Split: assisted part detection through one same-origin service

Status: **Accepted for the Auto Split (Beta) product candidate, PYBRIX-08B-PROD-A1. Not deployed.**

Date: 2026-10-10

Builds on ADRs 0008 (worker-resident geometry), 0014 (multi-part documents) and the
Stage 7A/7B split transaction. Lifts the repository's network ban **narrowly** and for one purpose.
Supersedes the sentence in `docs/PRIVACY_ARCHITECTURE.md` that said no network request beyond static
assets exists.

## Context

Research (PYBRIX-08B, V1S) established what an AI-assisted split can honestly be:

- The provider can say **roughly where** a part is and which way a figure or vehicle faces; it cannot be
  trusted to **draw a cut**. Its left/right labels were no better than chance (~49%) and its
  localisation was right for 17 of 24 held-out vehicle targets, with automatic coverage of 8%.
- Therefore the product is **assisted only**: the AI proposes, Pybrix turns the proposal into an
  editable suggestion checked against the real geometry, the user previews and edits it, and only the
  user's Apply changes the model. No accuracy figure is shown to users.

The product is a static, local-first site (ADR 0007's privacy promise, `docs/PRIVACY_ARCHITECTURE.md`).
A model provider cannot be called from the browser: the key would ship in the bundle. So this feature
needs, for the first time, a server component. This ADR is the narrowest one that is safe.

## Decision

### 1. Browser → same-origin service → provider. Nothing else.

```
browser ──POST /api/auto-split/analyze──▶ nginx ──▶ 127.0.0.1:8787 (apps/auto-split-api) ──▶ provider
```

- The browser makes **one** kind of request, to **its own origin**, from **one file**
  (`apps/web/src/runtime/auto-split-transport.ts`). ESLint's network ban stays on everywhere else; this
  file, the service's provider adapter and the service's own tests are the exemptions, and
  `scripts/production-boundary.test.ts` asserts that no other file in the application, the packages or
  the service names `fetch`, that the transport names no absolute URL, host, query string or second
  endpoint, that it sends no credentials or referrer, and that no worker can import it.
- **The Content-Security-Policy does not change.** `connect-src 'self'` already allows a same-origin
  request, so no directive was widened to make this work.
- The geometry **never leaves the worker**. The page asks the worker for six renders; the worker returns
  PNGs and three numbers; the page sends those. The page still holds no `CanonicalMesh`.

### 2. What is sent, and what cannot be

`AnalyzeRequest` (`packages/auto-split-contract`) has exactly: a request id, a mode (`human` or
`vehicle`), a protocol version, six PNGs and a summary of three numbers (bounding-box extents of the
normalised model, the number of separate shells, the bounding radius). It has no field for a file, a
name, a vertex or a face, and the service validates the body **strictly**:

- exact keys at every level; unknown keys refused; a deny-list of mesh-looking keys
  (`positions`, `indices`, `vertices`, `faces`, `triangles`, `stl`, `obj`, `3mf`, ...) refused as
  `RAW_GEOMETRY_REJECTED`, never stripped;
- exactly six images, in the contract's view order, each a **clean** 512 × 512 8-bit RGB PNG (only
  `IHDR`, `IDAT`, `IEND`, CRC-checked — no text chunk, no ancillary chunk, no metadata);
- strict base64, per-image and whole-body size ceilings, JSON content type, same-origin check
  (`Sec-Fetch-Site` / `Origin` against `Host`), bounded numbers.

The renders are deterministic shaded greys with no interface chrome and no file name. A model's
**original file is not uploaded**, and neither is anything from which it could be rebuilt; six 512 px
orthographic silhouettes with shading are, however, **derived from the model**, and the user is told
exactly that before the first request (§5). That is why Auto Split is opt-in, disclosed, and the only
feature with a network path.

### 3. The service

`apps/auto-split-api` is a dependency-free Node HTTP service (no framework, no SDK; Node's `http` and
global `fetch` only). It owns everything the browser must not control:

- **The provider key**, read once from `OPENAI_API_KEY`, held in a closure, never logged, echoed or
  returned; refused at start-up if it is not printable ASCII. It is not a `VITE_*` variable and appears
  in no bundle (a boundary test greps for it).
- **The prompts, schemas and model**, pinned in server code: model `gpt-6.1-sol`, the Responses API,
  strict structured output, `store: false`, a protocol version per mode. The vehicle protocol is the
  research `VEHICLE_SEMANTIC_PROTOCOL_V0` byte for byte (its three hashes are asserted by a test); the
  human protocol is the production `human-v1`. A request naming another version is refused, so a stale
  browser cannot reach a protocol the server changed. The browser supplies no prompt, model or URL.
- **Limits**: body size, image count and dimensions, MIME, mode, schema; a provider deadline (150 s), one
  bounded retry of a transient failure; **rate limiting per client address** (default 8 analyses per
  hour, one at a time per client, six at once overall) and a cost guard through those ceilings.
- **Cancellation propagates**: the browser aborts its request, the connection closes, and the service
  aborts its provider call when the connection does. A response that arrives after is never read.
- **Sanitised errors**: the response carries a code and a sentence Pybrix wrote; provider text, headers
  and bodies never cross, and the browser re-derives the sentence from the code anyway.
- **Logging with no payload field**: a request id, the mode, durations, statuses, the provider's HTTP
  status, token counts, an approximate cost and the protocol version. The logger's type has no field for
  an image, a base64 string, a header, a key or a response, and drops any value that is not a short plain
  token. No analytics system exists or was added.
- **No zero-retention claim.** `store: false` is requested; what the provider does beyond that is the
  provider's policy, and the interface says only what Pybrix does ("six rendered views and limited
  geometry metadata are sent; your original 3D file is not uploaded").

### 4. The local half

Everything that decides what a suggestion **is** happens in the geometry worker, against the real mesh:

- `autosplit/render` — the six views (`packages/auto-split`), deterministic;
- `autosplit/suggest` — the provider's answer is **data**: re-validated, then matched to the part's own
  geometry (the frozen component matcher for vehicles; a bounded plane refinement for figures) into
  suggestions with a status (`Suggested`, `Review cut`, `No safe split found`, `Repair model first`) and
  no number;
- `autosplit/component-faces` — which faces a component suggestion would take out, for highlighting;
- `autosplit/extract-create` — a **split candidate** for a set of components, registered in the same
  `SplitCandidateStore` that `split/create` uses.

**None of these commits.** Apply is the existing `split/commit`, Undo the existing `repair/undo`: one
Apply is one document transaction and one Undo restores the exact previous mesh objects. A boundary test
asserts that the Auto Split handler module reaches no `replace`, `commit` or history call, and another
that a provider answer cannot name a part, revision, handle or operation.

A plane suggestion is **loaded into Manual Split's own controls** (`planeSettingsFor`, round-trip
tested against `splitPlaneFor`, the only function that turns settings into a plane). There is no second
plane editor. The source gate is Manual Split's own closed-solid check: if a part fails it the
suggestions are shown, Preview and Edit are disabled, and the interface says
"Part found, but this model needs Repair before it can be split."

### 5. The disclosure

Before the first request, in the interface, with Continue and Cancel:

> Auto Split uses AI to identify parts. Your original 3D file stays on your device. Auto Split sends six
> rendered views and limited model metadata for AI analysis. Repair and Manual Split remain local.

Consent is kept **in memory for the page session only**; nothing is written to storage, so it is asked
again after a reload. "Other" model types never reach the disclosure: they have no analysis, and the
interface says so and offers Manual Split. The "processed locally" statements elsewhere in the
interface were qualified to match.

### 6. Deployment

The static release bundle contains **no server, no key and none of this service**. The service is built
separately (`npm run build --workspace @cadfixer/auto-split-api` → `dist/main.js`) and deployed behind
an **optional** nginx snippet (`deploy/nginx/cad-fixer-auto-split.conf`) that proxies exactly
`/api/auto-split/analyze` and `/health` to loopback; the static template still proxies nothing and
includes the snippet by a glob that may match nothing. Without it Auto Split reports the service
unavailable and everything else is unchanged. `deploy/auto-split/` holds a hardened systemd unit and an
environment example with an empty key. `scripts/hostinger-deployment.test.ts` (HV-C30–C37) holds all of
it.

### 7. Test seams that must never ship

A deterministic mock provider and test models exist so CI can exercise the real service and the real
browser without a key or a network. They live in `packages/auto-split/src/fixtures` and
`apps/auto-split-api/src/test-server.ts`, with their own build output (`dist-test`, git-ignored). The
production entry (`main.ts`) is `allowMock: false`, a config error refuses the mock in a production
build, and boundary tests assert that nothing that ships imports either.

## Consequences

- Pybrix now has one optional server process and one outbound dependency (the provider). Both are
  declared here, in `docs/PRIVACY_ARCHITECTURE.md` and in `docs/DEPLOYMENT_REQUIREMENTS.md`.
- The statement "nothing is uploaded" is no longer unconditional. It was replaced everywhere it appeared
  by "your original 3D file stays on your device" plus the one disclosed exception.
- Auto Split can be switched off by not installing the snippet; nothing else depends on it.
- A future change to what is sent (a seventh view, another number, a name) is a change to
  `AnalyzeRequest`, the service validator, the disclosure and this ADR together, and must be treated as a
  privacy change.

## Not decided here

Accuracy claims, pricing, accounts, analytics, a persistent cache of analyses, model files uploaded for
any reason, any provider other than the one pinned, an assist for models that are neither figures nor
vehicles, and any automatic application of a suggestion. Each would need its own decision.
