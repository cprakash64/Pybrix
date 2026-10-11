# Auto Split at the large-mesh ceiling (AUTO-SPLIT-LARGE-MESH-02)

Status: implemented and qualified locally. **Not deployed.** The provider in every run below is the
deterministic mock; no real provider request was made, and no VPS, nginx, Redis, Docker or
runtime-isolation file was touched.

This document is the evidence for one decision: Auto Split and the exact split share ONE supported
size, **2,000,000 triangles**, and a part up to that size runs the whole chain (import, Auto Split,
Find parts, Preview, Apply, Undo, Export) without a size refusal, with Undo restoring the original
bytes.

It follows `AUTO-SPLIT-LARGE-MESH-01`, which found the real binding limit: Auto Split analysed parts
up to 1,500,000 triangles, but the exact split it hands a suggestion to refused anything above about
1,597,830 (a flat 128 MiB Manifold input budget at 84 bytes a triangle), below the 2,000,000-triangle
Boolean ceiling the same path already had. A 1.99 M-triangle truck was refused at Find parts with a
"Try again", and would have been refused again at Preview.

## 1. One ceiling

`MAX_SUPPORTED_SPLIT_TRIANGLES = 2_000_000` lives in `packages/mesh-core/src/split-limits.ts`.

| Reader                                                                       | What it decides                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `autosplit/render`, `autosplit/suggest`, `autosplit/extract-create` (worker) | the AUTHORITATIVE size check                          |
| the Split workspace (`PartDescriptor.triangleCount`), both tabs              | the courtesy pre-check, before anything runs          |
| `runValidatedBoolean` (`boolean-adapter.ts`)                                 | the per-input triangle gate of every exact split      |
| `BooleanOperationController` (`boolean-operation-controller.ts`)             | its per-operand gate, and (derived) its combined gate |
| `MAX_BOOLEAN_INPUT_BYTES`                                                    | the Manifold byte budget, by derivation (section 2)   |

The Boolean ceiling was already 2,000,000 and is **unchanged**; it now reads the shared constant
instead of restating it. 1,999,999 and 2,000,000 are allowed and 2,000,001 is refused at the worker,
the adapter, the controller and the page, and tests hold each.

## 2. The Manifold byte budget, derived

The backend copies each operand into Float64 positions and Uint32 indices before handing it to the
kernel. Per triangle of an unshared (STL soup) operand:

    9 coordinates x 8 bytes  +  3 indices x 4 bytes  =  84 bytes

`booleanKernelInputBytes(a, b)` is the SAME expression the backend always used,
`(a.positions.length + b.positions.length) * 8 + a.indices.byteLength + b.indices.byteLength`, moved
to `geometry-runtime/src/boolean-limits.ts` so the guard and its derivation read one function.

    MAX_BOOLEAN_INPUT_BYTES
      = (MAX_SUPPORTED_SPLIT_TRIANGLES + MAX_BOOLEAN_TOOL_TRIANGLES) * 84
      = (2,000,000 + 64,000) * 84
      = 173,376,000 bytes  =  165.34 MiB

- The 2,000,000-triangle operand alone is `168,000,000` bytes = **160.22 MiB**, the figure in the
  decision.
- The tool term (64,000 triangles = `MAX_TEXTURE_PRIMITIVE_TRIANGLES`, the largest tool operand any
  caller builds; 5.13 MiB) is not slack. A plane split intersects the part with a 12-triangle
  half-space, so a budget of exactly `2,000,000 * 84` would refuse the part the ceiling admits: the
  measured input of the 2,000,000-triangle cut is `168,000,336` bytes. The old budget, `134,217,728`,
  refused that input too.

What did NOT change: the overflow and malformed-input checks, `assertMeshStructure` before the kernel,
the topology-workspace limit (1 GiB; a 2,000,000-triangle part estimates 450 MiB, 44% of it), the
canonical-byte limit (384 MiB), the 5,000,000-triangle output limit, the edit-peak limit, and the
per-input triangle gate. There is no unlimited path, and a test asserts the budget still bites one
triangle past part-plus-tool.

### The third guard the unit tests could not see

A three-way agreement was required, and the first end-to-end run at exactly 2,000,000 triangles found
that there were **three** copies of the ceiling, not two. `BooleanOperationController` (the nested
worker that runs Manifold) refused when `a + b` triangles exceeded a flat 2,000,000: a 2,000,000-triangle
part beside the 12-triangle half-space arrived as 2,000,012 and was refused, while a 1,992,704-triangle
part was not. The refusal reached the page as "isn't safe on this model" (and, after this stage's copy
change, as the neutral resource card). The baseline code with every other limit lifted refused the same
way, which is how it was recognised. It is now derived exactly as the byte budget is:

    combined operands  <=  MAX_SUPPORTED_SPLIT_TRIANGLES + MAX_BOOLEAN_TOOL_TRIANGLES      (2,064,000)
    each operand       <=  MAX_SUPPORTED_SPLIT_TRIANGLES                                    (2,000,000)

so raising the combined figure raises nothing about how large ONE operand may be. Its two byte guards
(256 MiB of input copy, 768 MiB of known work) were measured against a 2,000,000-triangle soup part:
96 MB and 432 MB, so the triangle count is what decides; a test asserts the headroom.

## 3. What was deliberately not done

- **No welding.** A typed-array geometry weld was proposed to fit under the old byte guard. It would
  add topology semantics for no gain once the guard was aligned, so it was not built.
- **No 2.5 M target, no change to the Boolean triangle ceiling.**
- **No provider, deployment or limiter change.** `apps/auto-split-api`, `packages/auto-split-contract`,
  `deploy/` and `docs/adr/` are byte-identical to 5272c59.

## 4. The cab/bed scorer

The vehicle plane suggestion searches 625 candidate planes for each of two seeds (25 tilts of the
normal times 25 slides) and scored each by scanning the cab and bed faces: about 1,250 passes. At two
million triangles it was 8.7 s of the 10 s local analysis.

**Compact region lists were not enough on their own.** On this truck the cab and bed regions cover most
of the faces, so lists alone gave 2.2 s to 1.0 s at 500 thousand. The measured cost after that was
`regionOf` (a `projectPoint` call allocating an array per face and view). Two changes did the work:

1. `regionOf` evaluates the SAME projection expression operand for operand with the camera's vectors
   hoisted out of the loop (bit-identical, tested through the selected plane and score).
2. The search is a **screen, then an exact confirmation.**

### Why the result is unchanged

A face's side of a plane is the sign of `t - offset` with `t = nx*x + ny*y + nz*z`: exact, in any order.
Only the ORDER of the area sums differs between a single-pass screen and the per-candidate scorer.
`screenGroup` classifies each face once per tilted normal, adds its area to one of 26 slide bins, and
reads all 25 slide scores off prefix sums. Only candidates whose screened score is within
`SCREEN_KEEP_WINDOW = 1e-6` of the best are then scored by the ORIGINAL scorer (ascending face order,
bit-identical arithmetic), and the ORIGINAL selection loop (the 1e-12 tie band, then smaller tilt, then
smaller slide) runs over them in the original order.

The tolerance, defined before the code was changed: a positive sum of n terms in any order has relative
error at most (n-1)u/(1-(n-1)u), u = 2^-53, which at the 2,000,000 faces this product supports is 2.2e-10;
a share is a ratio of two sums, so one score is within ~5e-10 of the mathematical value in either order,
and the screen and the reference differ by less than `SCREEN_SCORE_TOLERANCE = 1e-9`. The window is
1000 times that, and 1000 times the longest chain of ties 625 candidates can form (625e-12). A candidate
outside the window cannot be the selected plane (the winner of a tie chain cannot fall that far below the
best), cannot rival it, and cannot change which plane a tie is awarded to, because the first candidate
at the top replaces any winner more than 1e-12 below it. The selected plane and its reported score are
therefore bit-identical, not merely close; the argument is written beside the constants.

`proposeCabBedPlane` also stops after a seed whose best screened score cannot reach the 0.90 purity bar
(its answer would be "no plane" either way).

### Equivalence evidence

`packages/auto-split/src/large-mesh.test.ts` holds the live scorer to a frozen copy of the original
(`fixtures/reference-cab-bed.ts`), comparing the two winners' planes AND scores with `toStrictEqual`
(so `-0` and `+0` differ):

- the truck, a five-shell car, a figure, an asymmetric vehicle, a vehicle rotated 31 degrees about Z and
  12 about X, an indexed sphere, a 12 k-triangle dense truck and a 100-shell truck (at least three
  genuine comparisons on every truck-shaped model, so a "both null" pass cannot hide);
- 40 seeded perturbations of the answer per model (boxes jittered at four scales, seed planes moved);
- 40 random triangle meshes with random wide boxes and random seed planes;
- the boundaries: absent slots, no boundary plane, a zero-length normal, identical cab and bed regions,
  an empty region, a seed pointing the wrong way, and a plateau where many slides tie at exactly 1.

All pass. Where the search is used, `proposeCabBedPlane` is compared with the reference decision too.

## 5. Component extraction, labelling and the kernel's input

- **Extraction** (`extractFaces`, `componentPieces`): a JavaScript `Map` of boxed numbers and a growing
  `number[]` (593 to 734 MB of heap at two million triangles, 1.7 to 1.9 s) became an int32 renumbering
  table (four bytes per source vertex) and an int32 origin list. Same numbering (first use), same
  coordinates (`-0` kept), same faces, same errors; tests compare every byte against a frozen copy on the
  fixtures, an indexed sphere, a `-0` coordinate, invalid and repeated ranks, none and all.
- **Labelling** (`labelComponents`): the component ranking is a typed `Uint32Array` sort, not a boxed
  `Array.from(...).sort(...)`. The comparator is a total order (no two components share a first face), so
  the ranking cannot differ; tested on the same fixtures and on 40 equal-area boxes.
- **The kernel's exact-coordinate indexing** (`indexExactCoordinates`, used by the Manifold backend): a
  `Map<string, number>` keyed by `"x,y,z"` (2.1 s and 185 MB of heap per operand at two million
  triangles, the larger operand of each Boolean) became an open-addressed int32 table over the same
  exact comparison (`mesh-topology`'s own hash and `-0` rule): 0.30 s and 5 MB of heap. Numbering by
  first reference in the INDEX stream and each vertex's own first-reference coordinates are what the
  `Map` produced, and a test holds it for soup, an indexed mesh with a duplicate point and an unreferenced
  vertex, `-0`, two points one ULP apart (never merged), lattices and an empty mesh. End to end the cut
  of the 2,000,000-triangle truck produces the same pieces (395,266 and 1,604,482 triangles, the same
  volume error 7.2129e-13) before and after.

## 6. Cancellation

`autosplit/render`, `autosplit/suggest` and `autosplit/extract-create` are dispatched `interruptible`:
the shared cancellation word is visible from inside synchronous work. Every long pass takes a
`Checkpoint` (`context.throwIfCancelled` in the worker) every `CHECKPOINT_STRIDE = 32,768` units. A
checkpoint never changes a result: the same numbers are computed in the same order (tested by counting
checkpoints and comparing with an unchecked run, and by a throwing checkpoint stopping each pass).

Where a pass cannot be interrupted (a page without cross-origin isolation, which production is not),
the session withdraws the Cancel control and says "Almost done: finishing on this device. This step
cannot be cancelled." rather than leave a button that lies. A cancel during the suggestion pass used to
cancel only the page's WAIT for it (the operation handle was never cancelled); it now cancels the worker.

**Two measured regressions were found and fixed on the way.** The first version tested the checkpoint
with `n % STRIDE === 0` in the hot loops: an integer division per iteration, `normalizeGeometry` 3x
slower and a render 1.5x slower at two million triangles. The mask version was no better, because a
call inside the loop body made V8 optimise it differently (the loops lost scalar replacement). The loops
are now CHUNKED: an outer loop over blocks of 32,768 calls the checkpoint, and the inner loops are the
original call-free loops. `normalizeGeometry` 50 ms (original), 165 ms (first version), 55 ms (chunked).

### Measured

|                                 | longest stretch between two checkpoints (Node, 2,000,000 triangles) |
| ------------------------------- | ------------------------------------------------------------------- |
| local suggestion pass           | 51 ms                                                               |
| six renders and the shell count | 74 to 89 ms                                                         |

In Chromium at 2,000,000 triangles, starting a fresh analysis the instant after a Cancel reaches its
first progress note in 225 ms against 270 ms for a run with nothing to cancel when the Cancel hit the
renders, and 168 ms when it hit the local suggestion pass (negative extra: the cancelled pass was gone
before the new one began; the worker is single-threaded, so this bounds how long the cancelled pass
kept running). The decision's bar is 250 ms.

## 7. The person's view

- **The size verdict precedes the question.** A part above the ceiling is told so before Find parts, in
  both tabs, from `PartDescriptor.triangleCount`: a neutral `role="status"` card with the size, the
  limit, "Your model is unchanged and nothing was sent.", and no retry, no analysis, no disclosure.
  2,000,001 is written out in full against 2,000,000 so a sentence never says a number exceeds a limit it
  prints equal to. The worker's check is still the authority (`AUTO_SPLIT_TOO_DETAILED`) and maps to the
  same status, never to the alert.
- **A resource refusal never says "use Manual Split".** Manual Split meets the same limits. A split the
  worker declines for resources is a neutral card ("This split needs more room than Pybrix allows ...
  Repair, Convert and Export have their own limits."); the old "adjust the cut or use Manual Split" stays
  for a cut that is merely unsound.
- **Phases, in words, with no percentage:** "Preparing model... view n of 6", "Looking for parts...",
  "Reviewing candidate cuts...". No implementation vocabulary (tested).

## 8. Qualification

Host: an 8 GiB Mac under heavy, pre-existing memory pressure (the compressor held about 3 GiB, swap was
15.0 of 16.4 GiB used and growing during runs, 4 to 6 GiB of disk free). Load averages were high for
parts of the session (macOS system daemons), which is why every browser figure below is the median of at
least two runs and the range is shown. The baseline is the unmodified 5272c59 build with ONLY the two
limits lifted that previously refused at these sizes (an experiment-only patch, never committed), run in
the same session, interleaved with the new build.

Fixtures are deterministic (`fixtures/dense.ts`): the reference truck refined by midpoint subdivision
and centroid splits to an exact count, binary STL.

### End to end in Chromium (median of 2 to 4 runs; ms; the range is in the artifacts)

| triangles | build  | import | Find parts | Preview wheel | Preview cab/bed         | Apply  | Undo   | Export |
| --------- | ------ | ------ | ---------- | ------------- | ----------------------- | ------ | ------ | ------ |
| 500,000   | before | 2,648  | 4,280      | 2,958         | 7,446                   | 1,742  | 2,728  | 1,031  |
|           | after  | 2,454  | **1,945**  | 2,088         | 5,943                   | 1,744  | 2,844  | 1,011  |
| 1,000,000 | before | 4,409  | 6,560      | 4,434         | 12,674                  | 3,504  | 5,167  | 2,305  |
|           | after  | 4,670  | **2,896**  | 4,034         | 11,053                  | 3,114  | 5,034  | 2,238  |
| 1,500,000 | before | 6,094  | 9,064      | 6,774         | 19,226                  | 4,256  | 8,374  | 4,064  |
|           | after  | 6,896  | **4,300**  | 5,996         | 16,929                  | 4,710  | 9,016  | 4,969  |
| 1,992,704 | before | 9,252  | 13,407     | 10,270        | 31,384                  | 6,596  | 11,794 | 5,100  |
|           | after  | 9,646  | **5,524**  | 8,535         | **24,117**              | 6,435  | 13,593 | 5,660  |
| 2,000,000 | before | 8,769  | 13,489     | 10,684        | **refused** (3.9 s)     | n/a    | n/a    | n/a    |
|           | after  | 10,998 | **6,774**  | 10,297        | 29,319 (22.7 to 36.0 s) | 10,234 | 13,860 | 5,278  |

Every export after Undo is byte-identical to the original export, for the wheel (components) and the
cab/bed plane, at every size, in every run.

Main-thread frame gaps (largest gap between animation frames; the page is responsive while Auto Split
works): during Find parts the median largest gap is **22 to 57 ms** at every size (26 ms at 1.99 M; the
worst single run 86 ms), where the baseline's worst was 137 ms. During
Preview, Apply and Undo the gaps are seconds (1.99 M: 3.4 s, 6.2 s, 7.9 s). They are IDENTICAL in the
baseline (3.8 s, 6.3 s, 7.5 s, measured with the same instrument): that time is the viewport rebuilding
its scene from a render snapshot on the main thread, which this stage did not touch. It is a residual
risk, below.

Peak browser RSS (all processes), median 907 and 972 MB at 1.99 and 2 M (range 873 to 1,098 MB), against
940 and 952 MB (range 792 to 1,191 MB) for the baseline.

### The local passes (Node; ms; one process per row, `gc` between stages)

| triangles | six views      | local analysis (before to after) | cab/bed scorer (before to after) | extraction (before to after) | extraction heap (before to after) |
| --------- | -------------- | -------------------------------- | -------------------------------- | ---------------------------- | --------------------------------- |
| 500,000   | 464 to 462     | 2,787 to 335                     | 2,436 to 115                     | 230 to 24                    | 182 MB to 0.1 MB                  |
| 1,000,000 | 722 to 687     | 4,798 to 626                     | 4,232 to 149                     | 675 to 39                    | 258 MB to 1.1 MB                  |
| 1,500,000 | 990 to 867     | 6,987 to 792                     | 6,088 to 164                     | 1,134 to 58                  | 461 MB to 0 MB                    |
| 1,992,704 | 1,368 to 1,319 | 9,877 to 1,160                   | 9,003 to 323                     | 1,648 to 71                  | 685 MB to 0 MB                    |
| 2,000,000 | 1,305 to 1,418 | 9,990 to 1,305                   | 8,747 to 296                     | 1,674 to 71                  | 593 MB to 1.1 MB                  |

("Local analysis" is the whole `suggestFor` pass: normalise, facts, six face-id renders, labelling and
the suggestions.) Six views are the same work as before and about the same time.

### The exact split in Node at 2,000,000 triangles (the real Manifold WASM)

|                                                          | before the kernel's input indexing | after           |
| -------------------------------------------------------- | ---------------------------------- | --------------- |
| total (two Booleans, validation, candidate registration) | 25.0 s                             | 18.6 s          |
| each Boolean                                             | 5.1 s and 5.7 s                    | 3.0 s and 3.9 s |
| input bytes handed to the kernel                         | 168,000,336                        | 168,000,336     |
| kernel input limit                                       | 134,217,728 (refused)              | 173,376,000     |
| candidate registration and its validation                |                                    | 1.9 s           |
| peak process RSS                                         | 844 MB                             | 833 to 873 MB   |

The plane Preview in the browser improved by 14 to 23% at 1.5 to 2 M (31.4 s to 24.1 s at 1.99 M),
about half of what the Node figure suggests: the browser adds the Boolean worker's input copy, the
render snapshot of both pieces, their transfer, and the viewport's scene rebuild. Most of the remaining
time is NOT the kernel: in Node the two Booleans are 7 of 18.6 s.

### The reported file, read-only

The reported 1,988,877-triangle vehicle exists locally (`~/Downloads/Hitem3d-1785766060812.stl`, 99,443,934
bytes; two other copies sit in `~/Developer/cadfixer-05a-artifacts`). It was opened by the browser and
read, never written (its size and modification time are unchanged), and run through `LM_FILE=... npm run
test:e2e:auto-split-large`:

- imported (1,988,877 triangles) and exported byte-for-byte as it was read;
- **Find parts ran at this size with no size refusal** (11 to 19 s on a loaded host; largest frame gap
  134 to 147 ms) and listed its suggestions;
- the file is **not a closed solid** (open boundaries and non-manifold edges), so Preview is disabled on
  every suggestion ("Repair model first") and Manual Split refuses it as "requires a closed solid ... it still
  has open boundaries; it has non-manifold edges or vertices", which is the file's own property and has
  nothing to do with its size (asserted: no size wording, and the export after the attempt is unchanged);
- the Preview, Apply, Undo and Export chain therefore runs on the closed 1,992,704- and 2,000,000-triangle
  fixtures above, which carry the same size and the same shape of work. Repair is the way into the real
  file, and was not part of this stage.
- Its request body was **734,676 bytes**, against 26,135 for the synthetic fixtures at every size: the
  request does not depend on the triangle count but its six PNGs depend on what the views contain, and a
  detailed real model compresses worse than flat-shaded boxes. Both are far inside the request limits, and
  the earlier 0.4 to 0.5 MiB figure for real models is the same effect.

## 9. Residual risks

- **Preview, Apply and Undo block the page for seconds at 1.5 to 2 M.** Unchanged by this stage and
  identical in the baseline: the viewport rebuilds its scene on the main thread. At 1.99 M a gap of
  about 6 to 8 s during Apply and Undo. A progress state is shown, but the page does not repaint during
  the gap.
- **A plane Preview at 2 M takes 23 to 36 s** and its time varies with memory pressure on a small
  machine: the median over two runs was 29 s with a spread of 13 s.
- The cab/bed search's equivalence rests on the argument and the evidence in section 4, not on
  exhaustive proof; the evidence is strong (planes and scores bit-identical across every fixture,
  perturbation and random case) but is not a proof for inputs nobody tried. `SCREEN_KEEP_WINDOW` is
  1,000 times larger than anything the argument needs.
- **Many shells.** See section 10.
- **No lower-memory device was available.** See section 11.

## 10. Many shells

The truck above has five shells. `manyShellTruck` adds small closed boxes floating in the free air
above the bed (same bounding box, so the same normalized frame), for a part near the ceiling:
1,900,000 triangles with 5, 105 and 1,005 components.

| components | six views | labelling | cab/bed scorer | local analysis | extraction before to after                                | exact split | its second Boolean |
| ---------- | --------- | --------- | -------------- | -------------- | --------------------------------------------------------- | ----------- | ------------------ |
| 5          | 1,195 ms  | 414 ms    | 319 ms         | 1,106 ms       | 1,564 ms, 685 MB heap, 794 MB peak to 71 ms, 1 MB, 567 MB | 18.6 s      | 3.5 s              |
| 105        | 1,150 ms  | 416 ms    | 275 ms         | 1,063 ms       | 1,636 ms, 183 MB, 842 MB to 63 ms, 0.1 MB, 784 MB         | 21.7 s      | 6.0 s              |
| 1,005      | 1,199 ms  | 424 ms    | 310 ms         | 1,128 ms       | 1,536 ms, 721 MB, 1,449 MB to 62 ms, 0.1 MB, 887 MB       | 38.7 s      | 24.4 s             |

- The local analysis does not grow with the shell count. The extraction's old heap and peak grew with it
  (1.45 GB peak at 1,005 shells); the typed version stays at 0.1 MB of heap.
- In Chromium the whole chain (Find parts, wheel and cab/bed Preview, Apply, Undo, byte-identical Export)
  passes with 105 and with 1,005 components. Find parts 5.4 s and 5.0 s. Cab/bed Preview 24.2 s with 105
  shells and **40.6 s with 1,005**. A first 1,005-shell run during a memory-pressure spike took 101 s for
  the Preview and 83 s for the Undo; the repeat on a quiet machine took 40.6 s and 10.8 s, so those
  figures are the machine's, not the code's.
- **No guard was hit and nothing was refused.** What shell count exposes is TIME, not a resource limit:
  the half-space intersection with a thousand disjoint shells takes Manifold 24.4 s against 3.5 s, and the
  pieces carry them. Nothing was raised to make this pass, and no limit on shells was added; the Preview
  progress note ("Intersecting model...") says what is happening.

## 11. Lower memory

The strongest reproducible constrained-memory condition SAFELY available on this host:

- **The host itself.** An 8 GiB Mac that was already past its comfortable limit for the whole session:
  at the start of the 2,000,000-triangle run only 4,038 free pages (63 MB), the compressor held 196,508
  pages (3.0 GiB), swap was 15.0 GiB used of 16.4 and grew to 16.5 of 17.4 GiB during the run, and
  4 to 5 GiB of disk was free. The chain completed, with byte-identical exports, no crash and no OOM, and
  a peak of 929 MB across every browser process (Find parts 5.7 s, plane Preview 25.8 s, Undo 11.3 s).
  Every browser figure in section 8 was taken in this condition.
- **A V8 heap cap was tried and DISCARDED.** `--js-flags=--max-old-space-size=512` (passed to Chromium
  through a throwaway launch option that is not in the repository) completed the chain,
  but a positive control showed it constrains nothing: the baseline build (593 to 734 MB of extraction
  heap) also completed with the cap at 512 MB and at 96 MB. Most of that heap is garbage a collector
  reclaims under a cap, and the cap is not the limit that matters for typed-array geometry. It is not
  claimed as evidence.
- **Ballast and a container were NOT used.** macOS has no per-process memory limit; a ballast process
  takes physical memory but not a hard cap, and with 1 GB of swap and 4 GB of disk left, pushing further
  risked the host rather than measuring the product. Docker was installed and not running; its VM size
  would be the constraint, not a 4 GiB device.

**This is NOT a 4 GiB qualification and is not claimed as one.** What it establishes is that a
2,000,000-triangle chain runs to completion on a machine that is already out of free memory, and that
the browser's own footprint peaks near 1 GB (929 to 1,098 MB at 1.99 to 2 M, against 940 to 1,191 MB for
the previous 1.99 M build). Whether the chain fits a real 4 GiB device is a question for one: a Linux
cgroup run or a real low-memory machine. `LARGE_MESH_MEMORY_BLOCKED` was not returned because no run
crashed, ran out of memory or was refused, not because a 4 GiB bar was cleared.

## 12. Privacy is unchanged

`apps/auto-split-api`, `packages/auto-split-contract` and `deploy/` are byte-identical to 5272c59, so
`store: false`, the strict schema, the per-client and service-wide limits and the key handling are the
same code. The request is the same request at every size:

|                                            | body                           | images             | other                                                              |
| ------------------------------------------ | ------------------------------ | ------------------ | ------------------------------------------------------------------ |
| 500,000 to 2,000,000 triangles (synthetic) | **26,135 bytes** at every size | six 512 x 512 PNGs | three bounded numbers, the mode, a protocol version, a request id  |
| the reported 1,988,877-triangle file       | 734,676 bytes                  | six 512 x 512 PNGs | the same: size follows the images' content, not the triangle count |
| with 105 and 1,005 shells                  | 26,197 and 26,246 bytes        | six                | the digits of the bounding numbers differ                          |

The browser-side capture of the large runs asserts that nothing but that one request leaves the page: a
single `POST /api/auto-split/analyze` per analysis, under 1 MB, six images at the mock service, no request
to any host but the local origin, no other request body above 4 KiB, no filename, path, vertex, triangle
or key. The 2,000,001-triangle refusal made **zero** requests to the service and the service saw **zero**
provider attempts. The unit and end-to-end suites that audit the payload, the key shape and the release
artefacts pass unchanged.
