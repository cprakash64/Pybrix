# Auto Split (Beta) — assisted product candidate (PYBRIX-08B-PROD-A1)

Status: **local product candidate. Not pushed, not deployed.** Decision record: `docs/adr/0020-auto-split-same-origin-service.md`.

## What it is

AI finds likely parts and prepares editable splits for the user to review. In the Split workspace a second
tab, **Auto Split (Beta)**, sits beside **Manual Split** (which stays the default tab and is unchanged).
The user chooses what the model is (Character / Human, Vehicle, Other), accepts a disclosure, and presses
Find parts. Pybrix renders six views locally, sends them with three bounded numbers to its own service,
and turns the answer into a list of suggestions. A suggestion is **previewed** and **edited** with Manual
Split's own controls and **applied** through Manual Split's own transaction. Nothing is applied by the
analysis, by a response, or by a key press that previews.

## Lineage

Built on `68b2d1e` (the qualified 08A split foundation, itself a descendant of Repair RC `99b30f1`); the
research branch `research/auto-split-08b-r2a-real-geometry` was **not merged** and none of its files or
history are here. The matcher constants and the vehicle protocol (prompt, request text, schema) are ported
and pinned by tests (`67dc609d…`, `01666185…`, `49c6ac21…`); the human protocol is new (`human-v1`).

## Parts

| Piece             | Where                                                                        | Role                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wire contract     | `packages/auto-split-contract`                                               | Request/response types, strict validators, PNG inspector, the six cameras, limits, error codes                                                   |
| Engine            | `packages/auto-split`                                                        | Six deterministic renders, component labelling, the matcher, plane refinement, cab/bed plane, component extraction. Runs in the geometry worker. |
| Service           | `apps/auto-split-api`                                                        | Same-origin HTTP service: validation, limits, pinned prompts, OpenAI Responses call, logging                                                     |
| Worker ops        | `apps/web/src/workers/auto-split-handlers.ts`                                | `autosplit/render`, `suggest`, `component-faces`, `extract-create` — reads and a candidate, never a commit                                       |
| Browser transport | `apps/web/src/runtime/auto-split-transport.ts`                               | The one same-origin `fetch`                                                                                                                      |
| Session           | `apps/web/src/state/auto-split-session.ts`                                   | Framework-free analysis machine: consent, run, cancel, cache, revision following                                                                 |
| Controller + UI   | `use-auto-split.ts`, `AutoSplitPanel.tsx`, `auto-split-presentation.ts`      | State machine phases, rows, copy                                                                                                                 |
| Test seams        | `packages/auto-split/src/fixtures`, `apps/auto-split-api/src/test-server.ts` | Deterministic mock provider and test models; never shipped                                                                                       |

## Scope

- **Human:** head, left arm, right arm (no hip-attached leg), each a plane suggestion refined locally
  within a bounded window; arms are always "Review cut".
- **Vehicle:** wheels (grouped by wheel/axle), cab, bed/cargo, chassis/body as **components** when they are
  already separate shells; a fused cab and bed as one beta "Review cut" plane; no fused doors, curved panels
  or enclosed fused wheels ("No safe split found").
- **Other:** explained as unsupported; Manual Split offered. No call is made.

## Verified

Everything below was run on this commit's lineage; numbers are from this machine (Apple, Node 22,
Chromium via Playwright) and are not thresholds.

- Unit/integration: `npm run verify` — format, lint, typecheck, all Vitest projects, build.
- `npm run test:e2e:auto-split` — 11 browser tests against the real service and the real worker:
  character and vehicle flows (preview → Apply → Undo restores the triangle count), cab/bed plane, fused
  wheels, source-not-ready, cancel (reaches the service), model replaced mid-analysis, service failures and
  Try again, rate limit, Manual Split and Repair making **zero** `/api/` requests, keyboard-only flow,
  and a payload audit of the exact request (six clean 512×512 RGB PNGs and three numbers, no name, no
  mesh key, nothing third-party).
- Regression: `npm run test:e2e` (425 passed, 2 skipped), `test:e2e:timing`, `test:e2e:harness`.
- Local cost (mock provider, Chromium): click-to-results 0.9 s up to 100k triangles, 1.4 s at 290k, 4.0 s
  at 1M, 6.0 s at 1.49M (the analysis ceiling was 1.5M at A1; since AUTO-SPLIT-LARGE-MESH-02 it is the shared
  2,000,000-triangle split ceiling, see `AUTO_SPLIT_LARGE_MESH.md`); longest main-thread frame gap ≤ 48 ms throughout.
  The request body is ≈0.4–0.5 MiB. The provider's own latency is not measured: the interface tells the user
  to expect a minute or longer.

## Live provider (RC1)

`AUTO_SPLIT_LIVE=1 npm run smoke:auto-split-live` ran the production service in-process against the real
provider with two generated models (one figure, one car), provider retries off, hard-capped at four
calls; two were made.

|                               | Human (generated figure)                 | Vehicle (generated car)                     |
| ----------------------------- | ---------------------------------------- | ------------------------------------------- |
| Result                        | HTTP 200, answer parsed and valid        | HTTP 200, answer parsed and valid           |
| Model sent / echoed           | `gpt-6.1-sol` / `gpt-6.1-sol`            | `gpt-6.1-sol` / `gpt-6.1-sol`               |
| `store` sent / echoed         | `false` / `false`                        | `false` / `false`                           |
| Schema                        | `json_schema`, strict                    | `json_schema`, strict                       |
| Images                        | 6                                        | 6                                           |
| Latency                       | 9.3 s                                    | 25.8 s                                      |
| Tokens (in / out / reasoning) | 3,410 / 407 / 185                        | 4,582 / 2,086 / 257                         |
| Approx. cost                  | $0.0109                                  | $0.0300                                     |
| Local suggestions             | head Suggested; arms No safe split found | four wheels and body Suggested (components) |

The contract worked on the first live attempt; no provider-contract correction was needed. The smoke
stops at suggestions: it never touches a document. The suggestions are not an accuracy measurement and
no prompt was tuned from them (the figure's arms were not located; that is recorded, not corrected).

## Not verified

- **The full browser flow against the live provider.** The live request cap (two, after a passing smoke)
  was spent on the contract; the browser flow was exercised end to end against the deterministic provider,
  which speaks the same validated contract.
- Accuracy. Nothing here measures how often a provider finds the right part, and the interface claims none.
- Deployment: the nginx snippet and systemd unit are contract-tested as text, not installed.
- Real customer models: only generated models were used.

## Known limits and risks

- Consent is in memory: asked again after every reload (deliberate; nothing is stored).
- A rate limit is per client address and in memory: a restart resets it, and many users behind one NAT share
  a bucket. The service's global concurrency cap bounds cost; there is no spend meter.
- After an Apply the list is stale and Re-analyze analyses the part now shown (Piece A), which is the part
  the user is looking at, not the remainder.
- The shared panel-section header is now 40 px tall below 600 px (it was 37).
- `7B-PERF` (harness, 500k split preview frame gap) is documented as environment-sensitive; it failed once at
  1,150 ms against its 1,000 ms ceiling and passed three reruns at 767–883 ms. `stl-import` "main thread
  stays responsive" timed out once under whole-machine load and passes alone and in a quiet full run.
