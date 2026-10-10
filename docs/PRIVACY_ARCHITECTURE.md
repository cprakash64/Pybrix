# Privacy Architecture

Pybrix's central promise is that a user's model never leaves their machine.
This document defines what that means concretely, what network traffic is
permitted, and how the constraint is enforced rather than merely intended.

**One disclosed exception exists (ADR 0020): Auto Split (Beta).** If, and only
if, a user chooses a model type, accepts a disclosure and presses Find parts,
six rendered views of the model and three bounded numbers are sent to Pybrix's
own same-origin service for AI part detection. The original file, its vertices
and its faces are never sent, and Repair, Convert and Manual Split never make a
network request. See §2 and `docs/adr/0020-auto-split-same-origin-service.md`.

## 1. The promise

**Raw user geometry stays local by default.** Files are read, parsed, repaired,
and exported entirely within the browser, using Web Workers, WebAssembly, and
the machine's own CPU and GPU. There is no server-side geometry processing and
no upload path.

The application header states this to the user. That statement is a factual
claim about the build, and it must be removed or qualified the moment it stops
being true.

## 2. Allowed network traffic

Only these are permitted, and only the first two exist today.

| Traffic                                                             | Status                        | Notes                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static application assets (HTML, JS, CSS, WASM) from our own origin | **Present**                   | The application bundle itself. Same-origin only.                                                                                                                                                      |
| Auto Split analysis (`POST /api/auto-split/analyze`, same origin)   | **Present, opt-in, Beta**     | Six clean 512 px PNGs, a mode, a protocol version and three bounded numbers. One file in the browser makes the request; the service holds the provider key. Never a model file. See ADR 0020 and §2a. |
| Application update checks                                           | Not implemented               | Version metadata only. Must never carry document state.                                                                                                                                               |
| Anonymous aggregate telemetry                                       | Not implemented, not approved | Would require an ADR, a user-facing disclosure, and the constraints in §4.                                                                                                                            |
| Authentication and billing                                          | Not implemented, out of scope | When added, must not touch the geometry pipeline.                                                                                                                                                     |

### 2a. Auto Split, exactly

- **Opt-in and disclosed.** Nothing is requested on import, on opening the Split workspace, on opening
  the Auto Split tab or on choosing a model type. The first request follows a disclosure the user
  accepts, then Find parts. Consent is held in memory for the page session only.
- **What is sent**: a request id, `human` or `vehicle`, a protocol version, six shaded 512 × 512 PNGs
  with no metadata and no interface, and the model's bounding-box extents, shell count and bounding
  radius (normalised). **What cannot be sent**: a file, a file name, a vertex, a face, a unit, a part
  name. The service refuses a request that carries any such field.
- **Derived data**: six silhouettes with shading are derived from the model. They are not the file and
  cannot be turned back into it, but they are not nothing, which is why this is disclosed rather than
  described as "not uploaded".
- **At the provider**: `store=false` is requested and the protocol is pinned server-side. Pybrix makes
  no claim about the provider's own retention beyond that.
- **Pybrix's logs**: request id, mode, protocol version, durations, HTTP statuses, token counts, an
  approximate cost. Never an image, a payload, a header or a key.
- **Cancel** aborts the browser request, which aborts the provider call, and a late answer is ignored.
- **Off by default in the sense that matters**: a deployment without the service answers 404 and Auto
  Split reports it unavailable.

## 3. Forbidden by default

These are prohibited. Introducing any of them requires an explicit, recorded
product decision — not a code review nod.

- **Uploading an imported model**, in whole or in part, to any destination. (Auto Split sends rendered views, never the model or its mesh data; see §2a.)
- **Uploading a repaired, converted, split, textured, or hollowed model.**
- **Sending geometry to analytics** in any form, including derived data such as
  vertex positions, bounding boxes, or mesh hashes that could fingerprint a
  design.
- **Sending filenames** anywhere. A filename is user data — `client-acme-
prosthetic-v4.stl` leaks a business relationship on its own.
- **Binary model contents in error reports.** No buffer, no slice of a buffer,
  no base64 excerpt, no "first 64 bytes for debugging".
- **Third-party embeds** — fonts, CDN scripts, tag managers, session replay,
  heatmaps. Session replay is called out specifically: it would capture the
  viewport, which means capturing the user's model.

## 4. If telemetry is ever introduced

Not approved. Recorded here so the bar is known in advance:

1. Counters and enumerations only — never free text, never identifiers derived
   from user content.
2. A filename, path, or file size is never an acceptable field. File **format**
   and a coarse size **bucket** may be, and only with disclosure.
3. Error reports carry the `AppErrorCode` and our own `details` — which are
   restricted by the type system to primitives — never a `cause` chain that may
   embed user data.
4. Off by default, with a visible control.
5. An ADR recording the decision.

## 5. How this is enforced

Intent is not a control. These are the actual mechanisms:

**Lint-level ban on network APIs.** `eslint.config.js` makes `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, and `navigator.sendBeacon` errors
across the codebase. An accidental network call fails CI. Removing the ban is a
visible diff in a config file, not a quiet line in a component.

**Error details are typed as primitives.** `ErrorDetailValue` is
`string | number | boolean | null`. An `ArrayBuffer` or a mesh cannot be attached
to an `AppError` without a type error, so geometry cannot reach a log through
the normal error path.

**File reading happens in exactly one place.** `runtime/import-service.ts` is
the only module in the application that calls `File.arrayBuffer()`. That is a
privacy control as much as an architectural one: "does this application read
your file anywhere unexpected?" is answerable by reading one file. A unit test
asserts a refused file is never opened at all.

**Model bytes are moved, never broadcast.** The file buffer goes to the worker
by transfer and comes back as canonical geometry by transfer. It is never
serialised to text, never put in a URL, and never attached to an error.

**Export is a local `Blob`.** `runtime/download.ts` builds a `Blob` from bytes
already in memory and hands it to the browser's own download mechanism. No
request is made, no server is involved, and the object URL is revoked afterwards
so the buffer is not pinned for the life of the document.

**No exported file ever contains the source FILENAME.** The binary STL header is
a fixed string, the ASCII solid name is a constant, and no writer puts the file's
own name inside it — so a model shared onward cannot leak the name of the project
it came from. Tests assert this for every writer.

**OBJ and 3MF exports do carry the model's own names, and that is the point.**
Since Stage 4A-2B3 a document can be written as OBJ or 3MF, and both formats can
express part and group names. Those came from the user's file and are part of
their model: dropping them would be the loss, not the protection. (Material
references are NOT written — see ADR 0017 — so no material name reaches an
exported file at all.) What is guaranteed instead is that they are written as DATA and never
as structure —

- OBJ has no escape mechanism at all, so a name's control characters are removed
  rather than encoded: a newline inside an `o` record would end it and turn the
  rest of the name into geometry records, putting triangles in the file that the
  document never had.
- 3MF names are escaped with all five predefined XML entities, and control
  characters — which XML cannot carry — are dropped.
- Archive entry paths are a FIXED LIST the writer decides. No entry path is
  derived from a document name, a part name or a material reference.

**The DOWNLOAD name is derived from the source name and sanitised.** Directory
components are dropped, control characters, Unicode bidi overrides and
Windows-reserved characters are removed, and the length is bounded; the extension
comes from what was WRITTEN, never from the source. `../../evil.obj` exported as
STL becomes `evil.stl`, in whatever folder the browser is already saving to.

**An end-to-end test asserts network silence, twice over.** The Playwright suite
records every request the page makes across a full import AND export cycle. One
test fails if anything targets a foreign origin; a second fails if any request
carries a body or uses a method other than GET/HEAD — because "no external
requests" alone would not catch a POST back to our own origin.

**No third-party runtime dependency fetches anything but its own code.** The
JavaScript runtime tree is React, React DOM, and Three.js. The two WebAssembly
kernels (Geogram and Manifold) are loaded by Emscripten-generated loaders that
`fetch()` their own `.wasm` from the application's origin, once each, when the
worker that owns them starts; they request nothing else. The interface fonts (Figtree, Space Grotesk, JetBrains
Mono) are SELF-HOSTED: they ship inside the build as fingerprinted same-origin
assets, so loading them is a request to Pybrix's own origin and never to a
font service. See `apps/web/src/styles/tokens.css`. The Pybrix favicon, touch
icon, header mark and Help lockup are the same: fingerprinted files under
`/assets/`, never a CDN, image host or remote URL (`apps/web/src/brand/`).

## 6. Data at rest

Nothing is persisted — no localStorage, no IndexedDB, no cookies, no service
worker cache of user data. An imported model lives in memory only and is gone
when the tab closes. When local persistence is added it must be visible to the
user and clearable by them.

## 7. Threat model note

The screening step at the import boundary is a **usability filter, not a
security control**. It checks a filename extension and a declared size. It reads
no bytes and establishes no trust.

The real boundary is the PARSERS, which handle untrusted, potentially hostile
files. All of them run in a worker, treat every declared value as adversarial,
preflight every allocation against a typed budget, and reject rather than repair
what they cannot represent. Their requirements are recorded in
[ARCHITECTURE.md](ARCHITECTURE.md) §4, and the adversarial cases they are tested
against are in `packages/file-formats/src/stl/stl-reader.test.ts`,
`obj/obj-reader.test.ts` and `threemf/threemf-reader.test.ts` — the last of which
also covers the archive and the XML scanner, since a 3MF's attack surface starts
well before its geometry does.

Note what this does and does not protect against. It protects the tab from
malformed and hostile files: no unbounded allocation, no unchecked offset, no
catastrophic backtracking, no silent corruption of coordinates. It does **not**
make an untrusted model safe to trust as geometry — a structurally valid file
can still describe a nonsensical part. That is a diagnostics problem, not a
security one.

## Stage 2 — topology diagnostics

Diagnostics changed what moves between the worker and the main thread, so the
claim is restated precisely rather than left to inference.

### What crosses the worker boundary

| Direction     | Carries                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| main → worker | A model handle, a revision, and a sample cap. For import only, the file bytes. Never a mesh.  |
| worker → main | Counts, statuses, render snapshots, encoded export bytes, and **bounded diagnostic samples**. |

Diagnostic samples are geometry-derived, deliberately: an overlay cannot draw a
boundary edge without its coordinates. They are capped by a sample limit rather
than by mesh size, so the payload does not grow with the model — measured at
0.1 MiB for a 100 MiB input.

**None of this leaves the browser.** The boundary above is between two threads in
one tab.

### What leaves the machine

Nothing. Verified four ways rather than asserted:

1. **Lint** bans `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and
   `navigator.sendBeacon` repo-wide.
2. **The build output** contains no such call in the application script or in
   the geometry and export workers. The only `fetch` / `XMLHttpRequest` in the
   build are the Emscripten loaders in the self-intersection, hole-fill and
   Boolean workers, which load their own `.wasm` from the same origin (PR-01
   audit). Vite's module-preload polyfill, which used to contribute a `fetch(`
   to the application script, is disabled in `vite.config.ts`.
3. **An end-to-end test** records every network request the page makes during
   import, automatic analysis, overlay use, and export, and asserts each is a
   same-origin `GET`/`HEAD` for a first-party asset with no request body and no
   model identity in the URL.
4. **The Content Security Policy** the production host sends, and `vite
preview` sends in every end-to-end run, is `connect-src 'self'` with
   `default-src 'none'`: even a defect could not open a connection to another
   origin. See `apps/web/security-headers.ts`.

### What diagnostics may log or report

- **No `console` calls exist** in application or package source.
- **Typed errors carry counts, never coordinates.** The analysis guard's details
  are position and index array _lengths_; the resource-limit refusal's details
  are face and corner counts plus byte estimates. A test asserts the refusal
  payload contains no geometry key.
- **No filename appears in any error payload or diagnostic detail.** Filenames
  are displayed in the interface, which is local, and written into exported files
  the user chose to save.
- **No analytics, telemetry, or crash reporting of any kind exists.**

### Untrusted content

Part names, group names, material references and filenames come from files the
user opened and are treated as untrusted text. They are rendered as React
children, which escapes them, and the application contains no `innerHTML`,
`dangerouslySetInnerHTML`, `eval`, or `Function` constructor.

The conversion report deliberately carries **counts, not names**: a fact that
held a part name would be a fact that could carry hostile text into markup, and
it would be a second place display copy lived. The panel says "3 part names are
not written", never which.

On STL export, **solid names are generated, never copied from the source**. On
OBJ and 3MF export names ARE copied, because they are the user's model structure
— see above for what is done to make that safe.

---

## Stage 3B-1B — conservative repair

Repair changes the user's geometry. It changes nothing about where that geometry
goes, and this section records what was checked rather than asserting it.

### What crosses the worker boundary

| Direction     | Repair carries                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main → worker | a model handle and revision, operation names, a plan hash, a candidate id, a repair record id, a memory ceiling, a sample cap. **No geometry, in any operation.** |
| worker → main | a plan, a validation verdict, counts, warnings, BOUNDED change samples, and render snapshots for the preview and the committed result.                            |

The change samples are face indices, capped at 256 per category by the engine.
The render snapshots are display data — the same category of thing import has
returned since Stage 1 — and they are what the GPU needs in order to draw
anything at all.

**Authoritative canonical geometry never moves in either direction, and neither
does the candidate's.** A candidate is a second worker-resident mesh; the main
thread names it with a handle it cannot export.

### What leaves the machine

Nothing. Verified end to end rather than argued: `O16` drives a complete repair
workflow — import, analysis, planning, preview, view switching, overlay toggling,
apply, undo and export — while recording every network request the page makes,
and asserts that each one is a first-party asset, carries no body, uses GET or
HEAD, and does not contain the model's filename in its URL.

The repair engine, the undo patches and the topology reports all live in the
worker. There is no code path that could send them anywhere, because there is no
network API in the codebase at all.

### The narrowing-only memory option

`?repairMemoryCeilingMiB=N` lowers the ceiling at which a repair is refused before
allocating. It is recorded here because it is the one runtime-addressable
configuration this stage added, and the privacy-relevant facts about it are:

- it can only ever make Pybrix refuse **sooner** — `requestRepairPeak` in the
  worker ignores any value above the product ceiling, so it is enforced on the
  side that does not trust the message;
- it carries no data anywhere, and reads nothing;
- it is **surfaced in the repair panel whenever it is active**, so it is never
  hidden state.

### What repair may log or report

Counts, statuses, byte estimates and face indices. Never coordinates, never a
filename, never a solid name. The resource-refusal error carries `faceCount` and
a modelled peak; the commit record id is built from a model id, two revisions and
a plan hash — all identifiers this session generated, none derived from the file's
contents.

### Untrusted content

Unchanged from Stage 2 and re-checked for the repair surface: no repair-derived
string reaches the DOM except as a text node. There is no `innerHTML`,
`dangerouslySetInnerHTML`, `document.write` or `eval` anywhere in the
application, and no repair path constructs a URL from file contents.

---

## Stage 4A-2B1 — OBJ and 3MF import

Two new formats reach the parser boundary, and both of them can NAME things
outside themselves in a way STL cannot. This section records what was checked.

### The new references, and what Pybrix does with them

| Reference in the file                      | What Pybrix does                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| OBJ `mtllib path/to/materials.mtl`         | records the name, reports it, opens nothing                                                           |
| OBJ `usemtl name`                          | kept as an opaque string on the mesh group                                                            |
| 3MF `<texture2d path="…">`                 | records that textures exist, reports it, fetches nothing                                              |
| 3MF material and colour resources          | recorded as unsupported; their ids are read so a `pid` can be checked, and nothing else about them is |
| 3MF `object@pid`                           | required to be a positive integer naming a resource that EXISTS, else refused (Stage 4A-2B3-R1)       |
| 3MF `_rels` relationship targets           | resolved only WITHIN the archive, never off it                                                        |
| XML `SYSTEM` / `PUBLIC` / DOCTYPE / ENTITY | refused before any element is parsed                                                                  |

**Nothing in any of these paths is dereferenced.** There is no file-system read
of a sibling file, no URL resolution, and no network call — which the repo-wide
ESLint ban on `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and
`sendBeacon` makes structurally impossible rather than merely intended.

The browser suite asserts the negative directly: `e2e/format-import.spec.ts`
imports an OBJ whose `mtllib` is `https://evil.test/materials.mtl` and a 3MF
whose `texture2d` path is `https://evil.test/skin.png`, records every request
the page makes, and asserts none of them went off-origin — while also asserting
the omission is REPORTED to the user rather than hidden.

### External XML entities

The model part is scanned by our own bounded scanner, never `DOMParser`, and
`describeUnsafeXml` refuses a DOCTYPE, ENTITY, SYSTEM or PUBLIC identifier
BEFORE parsing begins. Fail-closed by construction: the refusal does not depend
on a parser being configured correctly and cannot regress when a platform
default changes. The classic XXE payloads — `file:///etc/passwd`, a remote DTD,
a billion-laughs expansion — are refused at that gate, in the reader suite and
again in the browser.

### Untrusted content, extended

OBJ object and group names, 3MF object names, material references and archive
entry paths join STL solid names as untrusted text. They are rendered as React
children, and browser tests import files whose object names are
`<img src=x onerror="document.title='XSS'">` and assert the payload survives as
a text node with no element created and no handler run.

**Archive paths are refused, not sanitised.** A path is rejected for traversal,
absoluteness, a drive letter, a backslash, a URL shape, percent encoding or ANY
control character. Nothing writes to the file system, so this is defence in
depth rather than the only thing standing between an archive and a file — but a
path that could name something outside the archive has no legitimate reason to
be in a 3MF.

### Resource exhaustion

A 50 MiB 3MF is a 4.3 MiB file: model XML compresses about 12:1. The archive
reader therefore enforces its total and ratio budgets DURING inflation, chunk by
chunk, rather than trusting the uncompressed size the directory declares — a
declared size is a claim by whoever wrote the archive. A component graph that
would expand past the part ceiling is refused before the expansion, because a
few hundred bytes of XML can describe an enormous document.

---

## Stage 4A-2B3 — format conversion

Conversion made two new things reachable from the product: writing OBJ and 3MF,
and a dialog that reads the user's model to decide what to say about it. Neither
changes where anything goes.

- **Every conversion is local.** The document snapshot travels worker to worker
  over a `MessageChannel`; the finished file comes back to the page and becomes
  a `Blob`. An end-to-end test drives the whole workflow — open, choose a
  target, choose a unit, export to all three formats — while recording every
  request the page makes, and fails if anything reaches a foreign origin or
  carries a body.
- **Nothing referenced by a file is ever followed.** An OBJ `mtllib` is recorded
  as text and disclosed in the conversion report; it is never opened. A 3MF
  texture's path is reported and never fetched. A test imports a model naming a
  remote material library, converts it, and asserts zero external requests.
- **No telemetry was added, and none may be.** In particular nothing records
  which formats are used, which unit a user chose, what their model is called,
  how large it is, or what a conversion warned about. ESLint still bans the
  browser's network APIs outright.
- **The unit a user states never leaves the export.** It rides on a disposable
  snapshot into the export worker, is written into that one file, and is not
  stored anywhere — not in the document, not in the workspace beyond the open
  dialog, and not on disk.
