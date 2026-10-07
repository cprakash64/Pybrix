# REPAIR-CORE-07 — release-candidate qualification record

Branch `repair-core-07-release-candidate`, from `432b637` (REPAIR-CORE-06B). Not pushed, merged,
deployed or tagged. No repair geometry semantics, algorithm, or work budget changed in this stage.

## What changed in this stage (and only this)

| change                                                                                                                                           | why                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The public `?repairWorkCeiling=N` option was **removed**; the ceiling is narrowed only by an internal context the never-shipped harness provides | A link could make automatic repair stop early. No product requirement. The worker still takes the smaller of any request and its own budget, so nothing can raise the limit |
| The kernel worker's patch and reply are **shape-validated** before a candidate is built                                                          | The reply crossed a thread boundary; counts, indices and coordinates are checked, an unknown message is refused                                                             |
| Stale "Conservative repair" user-facing strings reworded                                                                                         | Repair is no longer conservative-only                                                                                                                                       |
| `release-server.mjs --deployment-headers` and `playwright.rc.config.ts` + `e2e-rc/`                                                              | Qualify the PACKAGED artifact under the deployment header template                                                                                                          |
| An Apply-truthfulness unit test                                                                                                                  | The committed mesh is the previewed object                                                                                                                                  |

## Clean diff audit (origin/main 6184ca4 → RC)

76 files. By class: geometry engine `packages/mesh-hole-fill` (25), worker/protocol (5 workers +
3 geometry-runtime), repair service/state (9 state, 3 runtime), preview/render delta (2 viewport),
UI (4 components + 1 shell + 1 stylesheet), tests/e2e/harness/RC (rest), scripts (4:
qualification bench, fixture, boundary test, release server), `package.json` (two script lines),
documentation (3). **No dependency changed.** Searched the production diff for `console.*`,
TODO/FIXME, `eslint-disable`, `ts-ignore`, `.only`, `debugger`, hard-coded model ids and paths,
`dangerouslySetInnerHTML`, `eval`, `new Function`, `fetch`/network APIs: none outside comments that
name the qualification models while explaining a measurement. `skipIf` appears only in the
env-gated corpus bench suite. No timeout or threshold was changed.

## Trust-boundary audit

- Work ceilings: client input can only narrow (`narrowed()`), tested with a value above the budget.
- Render delta: capped at 2,048 faces per kind in the worker; geometry cannot bypass it.
- Patch from the kernel worker: lengths multiple of 3, appended count bounded by the mesh,
  indices inside the slot space, coordinates finite; failures are internal errors with no
  candidate (tested for five malformed shapes and an unrecognised message).
- Candidate lifecycle: stale/consumed/discarded candidates are refused (existing tests, plus the
  double-Apply and race specs on the packaged build).
- No user geometry is interpreted as markup; no dynamic code; names render as text.

## Evidence (packaged artifact, deployment headers)

Served by `release-server.mjs --root artifacts/release/site --deployment-headers`, which applies
exactly the header template a host would: CSP (`worker-src 'self'`, `script-src 'self'
'wasm-unsafe-eval'`, no `unsafe-eval`, no inline script), COOP/COEP/CORP, Permissions-Policy.
Cross-origin isolation true; every response same-origin, status < 400; `.wasm` served
`application/wasm`; scripts `text/javascript`; no CSP violation; no external request.

Generated matrix (public UI, console audited): clean; conservative-only; local pinch; residual /
winding; openings + pinch (13 filled); safe partial; unsupported-only; OBJ and 3MF indexed pinch;
export → re-import (STL) with unchanged triangle count and zero pinches; races (cancel then retry,
replace during preview, double Apply, double Undo). Memory: five Repair→Preview→Discard and five
Repair→Apply→Undo cycles, and twenty apply/undo cycles, show an RSS plateau (419–492 MiB, no
trend), a constant 10 MiB JS heap and only the two resident workers between cycles.

Real smoke set (`corpus.spec.ts`; production budgets; D0 and X-series):

| model              | triangles | outcome             | NM vertices before → after | candidate | apply+reanalyse | undo   | peak browser RSS |
| ------------------ | --------- | ------------------- | -------------------------- | --------- | --------------- | ------ | ---------------- |
| X2 clean control   | 1,112     | nothing to repair   | 0                          | –         | –               | –      | 558 MiB          |
| X7                 | 2,396     | complete            | 829 → 0                    | 7.3 s     | 0.5 s           | 0.2 s  | 727 MiB          |
| X15                | 32,642    | complete            | 144 → 0                    | 3.5 s     | 0.4 s           | 0.4 s  | 589 MiB          |
| X8                 | 102,936   | partial (ambiguous) | 43 → 1                     | 1.2 s     | 0.8 s           | 0.9 s  | 774 MiB          |
| X17                | 201,842   | partial (ambiguous) | 18 → 1                     | 2.3 s     | 1.2 s           | 3.1 s  | 545 MiB          |
| X12                | 471,462   | complete            | 360 → 0                    | 17.6 s    | 2.7 s           | 3.7 s  | 858 MiB          |
| X13 (large normal) | 602,628   | complete            | 35 → 0                     | 4.7 s     | 3.0 s           | 4.3 s  | 812 MiB          |
| D0                 | 1,988,877 | complete            | 155 → 0                    | 16.3 s    | 7.4 s           | 12.7 s | 1,121 MiB        |

Each row also imported, exported to STL and re-imported through the real importer, with the same
triangle count and the repaired counts. Every row agrees with the qualified 06A expectation
(`complete` / `partial-ambiguous` mapping and the post-Apply pinch counts).

**X11** (complexity-limit fixture, production budget): 22.3 s wall, `partial-limit`, 9,240 → 9,188
pinches (52 repaired, as qualified), peak browser RSS 681 MiB, Cancel visible throughout, frame gap
while computing 24 ms (idle 18 ms), source valid, partial candidate applied and undone exactly,
another model repaired afterwards. The one-off **1.32 s frame gap occurs when the 732k-face
candidate's render snapshot is uploaded**, which is the first-frame GPU upload documented in
`docs/PERFORMANCE_BASELINE.md` (1.36 s at 405k triangles); it is not repair compute.

## Release notes (internal draft — not published)

Pybrix Repair can now safely repair conservative mesh issues, many non-manifold vertex (pinch)
cases, certain winding-linked topology, and simple openings, each only where the result can be
checked. It shows a Preview of the exact candidate (what is fixed, what remains), lets you apply
it and undo it exactly, and re-analyses the model after every change. Some models are repaired
only in part; the result says so.

## Known limitations (MVP)

Limitations (by design, not bugs):

- Ambiguous geometry is left untouched (the result says so).
- Exact-intersection cases that no safe move avoids are left untouched.
- Extremely dense, refusal-heavy meshes reach the automatic complexity limit and retain issues.
- The preview overlay may sample faces visually; every count is exact.
- Components, self-intersections and wall thickness are reported, not repaired.
- No manual repair editor; no "Focus changes" action; no user-adjustable tolerances.
- The candidate's render upload on very large models is a one-off main-thread stall (baseline).

Not known bugs. Nothing in this list is a defect found in qualification.

## Not done, and why

- No automated accessibility engine is installed in the repository (no axe-core), and none was
  added. Keyboard-only flow, focus visibility, accessible names, live regions, `status` vs `alert`
  and 200 % reflow are asserted by `e2e-rc/shell.spec.ts` instead.
- `npm audit` was not run: it sends the dependency list to the registry, and no dependency changed.
