# REPAIR-CORE-06A — clean production engine integration

Branch `repair-core-06a-production-engine`, from `origin/main` (6184ca4). Nothing here is pushed,
merged, deployed or tagged, and no public UI or wording changed.

## What was ported, and where it sits

The qualified research geometry (LS-A2 local pinch surgery, exact fail-closed gate, fidelity
inspection, link retriangulation, component winding resolution, bounded residual orchestration)
was re-implemented on production conventions, file by file; the research branch chain was not
merged or cherry-picked.

| Qualified research source (REPAIR-CORE-05D-2 / 05E)          | Production file                                                    | Test                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------- |
| local-pinch-surgery (mesh, `describePatch`)                  | `packages/mesh-hole-fill/src/surgery-mesh.ts`                      | `local-repair.test.ts`                      |
| fan topology / classification                                | `pinch-topology.ts`                                                | `pinch-topology.test.ts`                    |
| LS-A2 search (chains, probes, anchors, dependency-box retry) | `pinch-search.ts`                                                  | `pinch-search*.test.ts` (3 files)           |
| surface fidelity, appended-face index                        | `surface-fidelity.ts`, `appended-face-index.ts`                    | their own tests                             |
| exact gate with baseline cache, batched classification       | `surgery-gate.ts`                                                  | exercised by every search/orchestrator test |
| link retriangulation (rim ≤ 9)                               | `link-retriangulation.ts`                                          | `link-retriangulation.test.ts`              |
| component winding resolution                                 | `winding-resolution.ts`                                            | `winding-resolution.test.ts`                |
| residual orchestration                                       | `residual-repair.ts`                                               | `residual-repair.test.ts`                   |
| deterministic work meter                                     | `repair-work-budget.ts`, `repair-work-limits.ts`                   | `repair-work-budget.test.ts`                |
| orchestrator, typed outcome                                  | `local-repair.ts`                                                  | `local-repair.test.ts`                      |
| candidate build from a patch                                 | `packages/mesh-repair/src/local-patch.ts`                          | handler tests                               |
| wire contract                                                | `packages/geometry-runtime/src/local-repair.ts`                    | compile-time `Exactly<>` mirrors            |
| kernel-worker message                                        | `apps/web/src/workers/hole-fill.worker.ts`                         | qualification (real Geogram)                |
| authoritative stage + planner                                | `apps/web/src/workers/local-repair-stage.ts`, `repair-handlers.ts` | `local-repair-handlers.test.ts`             |

Deliberately **not** ported: the A1 comparison path, the research executor/parallel pool, the
retry-always equivalence check and all profiling scaffolding. None is a product behaviour.

## Architecture

- The surgery runs in the **existing disposable kernel worker** (`hole-fill.worker.ts`), on a copy
  of the part. Cancel is `terminate()`; the exact C++ calls poll no JS flag, so a cooperative token
  alone would be a lie.
- It returns a **slot-space patch** (removed faces, reversed faces, appended vertices and faces),
  not a mesh. The authoritative worker applies it with the existing `rebuildCandidate` (Policy B:
  surviving faces keep their index triplets, nothing is welded, groups rebuilt), then runs
  `assertMeshStructure` and an **independent** topology analysis. Any rise in boundary edges,
  non-manifold edges or vertices, winding conflicts, duplicates, zero-area faces or components
  discards the candidate.
- The authoritative worker imports only `@cadfixer/mesh-hole-fill/admission` (fan topology and the
  work constants). The boundary test now holds that for `local-repair-stage.ts` as well.
- One candidate: conservative repair → local repair → hole fill compose into ONE candidate, which is
  the preview, is applied atomically by `repair/commit` and is undone exactly (the retained mesh
  object is restored, sharing and indexing included). The commit path is unchanged.
- Planning counts pinched vertices from topology alone, caches per revision and binds the request
  by `planHash`; a changed model refuses the candidate. No verifier channel → nothing is repaired
  and the outcome says `no_verifier`.
- The service and client carry `localRepair` / `localRepairPlanHash` and open the kernel worker only
  when a preview with local repair starts. **Default off and no UI control**: exposing it is 06B.

## The work budget

Units are integers charged by the engine itself and are independent of the machine:

- one candidate construction = 1; one exact test = 8 fixed + ⌈pairs classified / 10⌉; winding = 1
  per 64 faces visited. Checked only at safe points (between two reconstructions), so a limit never
  leaves a half operation. Charging never throws.

**Why pairs are charged.** First version: exact test = 8. X11 showed that is wrong by ~30×: its
tests cost the same ~13 ms as X12's but there are 100,862 of them; at the flat price X11 ran 22
minutes to 2,000,000 units while X12 spent 940k units in 28 s. Charging the narrowphase pairs
(~3 µs each; a candidate is ~15–40 µs) fixes the exchange rate. Qualification outputs were
unchanged by the re-pricing (19/19 identical STL hashes), only the meter moved.

Measured, unmetered, 19 models (D0 + 18 Thingi10K):

|                        | primary units | residual units |
| ---------------------- | ------------- | -------------- |
| X12 (471k faces, 28 s) | 940,072       | 0              |
| X7                     | 287,461       | 1,188          |
| D0                     | 52,202        | 0              |
| X15                    | 92,188        | 18,350         |
| X8 (ambiguous)         | 24,131        | 5,429          |
| X17 (ambiguous)        | 14,738        | 2,388          |

Limits: **primary 1,200,000** (1.28× the largest completed model), **residual 40,000** (2.2× the
largest completed residual). With them: all 19 results are byte-identical to the unmetered run and
to the research oracle; **X11 stops with `partial_limit` after 30.7 s** (1,200,197 units, 52 of
9,240 pinched vertices repaired, 9,125 unattempted, 431 MiB RSS). Unmetered it needs hours.
X11's growth: the first 25 sites cost 614k units, 193 sites cost 3.0M.

## X11 policy

X11-class models (many closed fans, expensive exact tests) are an explicit **MVP complexity limit**,
not a special case: the same general bound applies to every model. The outcome is a typed
`partial_limit` naming the budget, with `repaired` / `remaining` / `unattempted` counts. The residual
phase is skipped when the primary budget is exhausted. Whatever was repaired before the stop is
whole and validated; nothing is half-done.

## Outcomes

`complete`, `partial_unsupported`, `partial_limit`, `partial_ambiguous`, `no_change` — never an error.
A limit is data, not a failure. No claim wording changed: nothing says watertight, printable or
"repairs every mesh".

## Cancellation and stale results

Engine polls between sites and rounds (tests: primary, residual); the kernel worker is terminated
for exact work. The authoritative side rejects on cancel with nothing registered. A candidate whose
revision, part or plan hash no longer matches is refused at create and at commit.

## Helper worker pool

Not shipped. The research pool was semantics-preserving but not browser-qualified in this stage;
the work budget, not parallelism, is the product's bound. Recorded as debt for a later stage.

## Debt and risks

- The qualification evidence is Node + Geogram WASM. The kernel-worker message handler itself is
  type-checked and shares its code path with the qualified engine, but its in-browser run is
  covered only by the e2e/harness suites, not a dedicated real-model browser run.
- Change samples/overlays describe conservative changes only; local-repair removed/appended faces
  are not yet sampled (06B UI).
- Limits are calibrated on 19 models; a model with expensive per-site cost can reach the primary
  limit with little repaired. That is the intended behaviour, and the plan's `limitLikely` is
  advisory only.
