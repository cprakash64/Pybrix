# Format support matrix and known limitations

Capability reference for the **Pybrix v0.7.0 Technical Preview** (prepared, not
yet deployed; the live site is still v0.6.1). Import, export, Repair and
Texture are those of v0.6.0; v0.7.0 changes only what Split offers and shows —
see the [v0.7.0 notes](V0_7_0_TECHNICAL_PREVIEW_RELEASE.md). The 3MF
per-entry ceiling remains 320 MiB; model entries from 128 MiB up are read by
streaming. The live product is <https://pybrix.com>. Large 3MF export can be
refused when serialized XML exceeds the 320 MiB validation/write policy; this
does not reduce streamed import capability. See the [v0.6.0 release notes](V0_6_0_TECHNICAL_PREVIEW_RELEASE.md)
for the qualified Repair scope and safety boundaries.

Written in Stage 6D-A4 from **measured behaviour** — the production import pipeline run over
2,130 real and reference files and a deterministic mutation campaign — not from intent. Every "yes" below is
bounded by the resource policy in [RESOURCE_POLICY.md](RESOURCE_POLICY.md); every
"no" is a typed refusal that names what was not supported, never a partial
import. Evidence: `docs/design/STAGE_6D_3MF_PRODUCTION_AND_LARGE_ENTRY_ARCHITECTURE.md`,
section _Stage 6D-A4_.

## Import

| Format / feature                                         | Supported | Notes                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary STL                                               | yes       | Up to 6,710,886 triangles (the deterministic R3 gate, 320 MiB file). Attribute bytes ignored. Zero-triangle, truncated and count/payload-disagreeing files are refused by name.                                                                                                             |
| ASCII STL                                                | yes       | LF, CRLF and **CR-only** line endings (CR-only since A4), scientific notation, case-insensitive keywords, several solids (kept as groups). Non-finite values, text after end tags and missing tokens are refused as malformed: parsing is not repair.                                       |
| OBJ triangle geometry                                    | yes       | `v`/`f` with positive and negative indices, `o` → parts, `g`/`usemtl` → groups, comments, smoothing records, CRLF, scientific notation. `vt`/`vn` read and discarded.                                                                                                                       |
| OBJ quads and n-gons                                     | **no**    | Refused (`OBJ_POLYGON_UNSUPPORTED`) rather than fanned, which would invent area for concave faces. The most frequent OBJ refusal in the corpus.                                                                                                                                             |
| OBJ materials (`mtllib`)                                 | no        | Named in the import report; the file is never opened.                                                                                                                                                                                                                                       |
| Core 3MF geometry                                        | yes       | Meshes, build items, components, transforms, repeated placements (shared, not copied), all six units. Root found by OPC relationship, conventional path, or a single model part — and since A4 the relationship target need not end in `.model`.                                            |
| 3MF materials, colours, textures, thumbnails             | no        | Ignored safely and reported; geometry imports.                                                                                                                                                                                                                                              |
| 3MF Production Extension — referenced model parts        | yes       | `p:path` on root build items and root components; any number of reachable child parts; per-part object ids; package-wide budgets; unit agreement required.                                                                                                                                  |
| Slicer project metadata (Bambu/Orca/Prusa configs)       | ignored   | Not interpreted. Bambu `modifier_part` volumes are ordinary mesh objects in core 3MF, so they import and appear as parts.                                                                                                                                                                   |
| 3MF Production `p:UUID`, child `<build>`, child `.rels`  | ignored   | Normatively ignorable or producer-side; not validated (A3 decision).                                                                                                                                                                                                                        |
| Zip64 3MF packages                                       | yes       | Any size, as Bambu Studio and OrcaSlicer write them. Every ceiling applies to the resolved 64-bit value; values above 2^53, split archives and corrupt Zip64 records are refused.                                                                                                           |
| 3MF Production Alternatives (model resolution)           | **no**    | `THREEMF_MODEL_RESOLUTION_UNSUPPORTED`. Truthful unsupported.                                                                                                                                                                                                                               |
| 3MF Secure Content                                       | **no**    | Refused as a required extension Pybrix does not implement.                                                                                                                                                                                                                                  |
| Any other required 3MF extension                         | **no**    | Materials-required, slice, beam lattice, booleans, displacement, volumetric, triangle sets: `THREEMF_UNSUPPORTED_EXTENSION`. Optional (not required) extension content is ignored per core's must-ignore rule; since A4 a foreign-namespace element can no longer be read as core geometry. |
| A 3MF entry that expands beyond 320 MiB                  | **no**    | `ZIP_ENTRY_TOO_LARGE`, naming the size and the limit. Raised from 256 MiB in v0.3.0. Entries from 128 MiB up are read by streaming; the whole package still expands to at most 512 MiB, so a package cannot hold two maximum-sized parts.                                                   |
| A 3MF package expanding beyond 512 MiB, or ratio > 200:1 | no        | Resource refusals naming the metric, value and limit.                                                                                                                                                                                                                                       |

**Numbers are read in their format's own lexical form (PR-01).** An OBJ
coordinate must be a decimal number, and a 3MF coordinate an `xs:double` and a
triangle index an `xs:nonNegativeInteger` (surrounding whitespace allowed, as
XML Schema collapses it). `0x10`, `0b11`, `0o7`, and `1e1` or `2.0` as an index
are refused (`OBJ_MALFORMED_NUMBER`, `THREEMF_MALFORMED_COORDINATE`,
`THREEMF_MALFORMED_TRIANGLE_INDEX`) rather than coerced into values the file does
not state. ASCII STL already worked this way.

## Export

| Target | Supported | Notes                                                                                                                                          |
| ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| STL    | yes       | Whole document flattened; placements baked; no units, names or parts.                                                                          |
| OBJ    | yes       | Placements baked; names and groups kept; no units. Since A4 every group boundary survives, including unnamed groups and hole-fill patch faces. |
| 3MF    | yes       | Placements, sharing, names and unit kept. A document with no unit needs an export-time unit assertion. No production structure is written.     |

Every export is read back by the production reader and compared with its source
before it is offered; there is no way to skip that.

## Known limitations of the Technical Preview

- **Conservative repair and eligible simple flat opening fills** share Repair
  model preview, atomic Apply and Undo, including large meshes. No welding,
  tolerance or remeshing. Branched/complex boundaries, non-planar reconstruction
  and non-manifold vertex repair are not supported. Intersecting or overlapping
  patches are refused; interacting openings may require another pass.
- **Selected-opening tool** retains its separate limits: up to 512 rim points
  on a part of up to 250,000 triangles. Large-mesh Repair model uses its own
  resource policy; this tool limit is not a general Repair model ceiling.
- **Split** — one selected part and one plane at a time, on an eligible closed
  manifold solid. Connector choices are None and round Pin/Socket (one to
  four); the dovetail is not offered since v0.7.0. Split Preview can be shown
  assembled or exploded; the exploded layout is display-only.
  Connector dimensions require an explicit-millimetre document. Preview,
  Apply, Cancel, individual STL piece export, and one-step Undo are supported.
- **Surface Texture** — one planar connected region on one part at a time.
  Dots, Lines, and Diamond support Emboss and Engrave, with configurable size,
  centre-to-centre spacing, height/depth, and rotation. Dimensions require an
  explicit-millimetre document. Curved conformal mapping is not supported.
- **Self-intersection is a diagnostic, not a correction.**
- **Topology is exact-coordinate.** Nothing is merged by proximity.
- **One step of undo, no redo.**
- **No unit conversion.** A unit labels numbers; nothing is ever rescaled.
- **Streaming 3MF import, above 128 MiB per model entry.** A 3MF entry above
  **320 MiB** is refused; the whole package still expands to at most 512 MiB.
  Which path an entry takes is invisible: the document, the warnings and every
  refusal are identical either way.
- **3MF extensions other than the production model-part subset are refused**,
  and colours, materials and textures are not imported or written.
- **OBJ polygons are refused**, not triangulated.
- **No 3MF CRC verification.** A damaged compressed stream is refused; a bit
  flip that still decompresses and still parses is not detected. The XML and
  mesh gates bound what such a file can do, but not what it means.
- **Chromium-based desktop browsers** on an 8 GiB machine are the qualified
  envelope; see [BROWSER_SUPPORT.md](BROWSER_SUPPORT.md). Firefox, Safari and
  mobile browsers are not qualified.
- **No universal-compatibility claim.** The qualification corpus shows the files
  it contains importing; it does not show that every file a producer can write
  will. Model size is bounded by the resource policy, not unrestricted.
- **Printer fit and printability are not guaranteed.** Connector clearances and
  texture dimensions must be checked for the intended printer and material.
