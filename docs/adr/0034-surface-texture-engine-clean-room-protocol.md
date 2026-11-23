# ADR 0034 — Clean-room protocol for the Surface Texture engine

Status: accepted (owner decision O-1, 2026-11-21); text sanitized for repository inclusion 2026-11-22 and revised 2026-11-22
(the implementer's copy carries no description, licence statement, address or path of the third-party tool). Governs
TEXTURE-ENGINE-01 and every later texture stage. It changes no product behaviour.

## Context

Pybrix is proprietary software, and `CLAUDE.md` rule 17 governs which licences its runtime code may carry. The owner decided (O-1)
to build the Surface Texture engine clean-room, from independently sourced technical references, so that no source, constant,
parameter, layout or asset of a third-party tool enters it, and to record who has seen what. The third-party tool this protocol
keeps out of the codebase is identified only by the three strings that the boundary test of section 6 scans for. This text says
nothing else about it, and neither does any document an implementer is given (section 6a).

Some people or sessions who contributed to the planning of this engine have read implementation material of that tool (section 6a).
They are called **observers** below. The detailed record of what they saw is held by the owner **outside this repository** and is
deliberately not reproduced here: a list of specific numbers or files is itself a disclosure.

## Decision

### 1. Two roles, and they do not mix

- **Observers** are sessions or people who have read implementation material of the tool (section 6a). Observers may write
  requirements, tests and measurements. They do **not** write engine code for any algorithm the other tool also implements.
- **Implementers** have not read that material, and do not during the work. They work only from the allowed sources below, in a
  session that holds no record of an observer's exposure. Where the same person must do both, the engine code is reviewed by
  someone who has not read that material, and the review says so.

### 2. Allowed sources for an implementer

1. The Pybrix repository, its ADRs and `CLAUDE.md`.
2. The owner's written requirements and the sanitized specification derived from them.
3. Published technical literature and standards, cited by title and checked against the primary source before reliance (rule 6).
   The bibliographic details below are **not verified here**; the implementer verifies each before it is cited in code:
   - Garland and Heckbert, "Surface Simplification Using Quadric Error Metrics" (SIGGRAPH 1997).
   - Dey, Edelsbrunner, Guha and Nekhayev, "Topology Preserving Edge Contraction" (1999), for the link condition.
   - Bank, Sherman and Weiser, regular local mesh refinement (1983); Rivara, longest-edge bisection (1984).
   - Cook, "Shade Trees" (SIGGRAPH 1984), displacement mapping; Heckbert, "Survey of Texture Mapping" (IEEE CG&A 1986).
   - Perlin, "An Image Synthesizer" (1985) and "Improving Noise" (2002); Worley, "A Cellular Texture Basis Function" (1996).
   - The 3MF Core and Production Extension specifications and the STL format description already used by the readers and writers.
   - ECMA-262 and IEEE 754 for numerical behaviour.
   - Printer and material manufacturers' published process limits, for minimum-feature guidance.
4. Pybrix's own measurements.

### 3. Forbidden for an implementer

- Opening, cloning, searching or reading any source code, script, stylesheet, markup, build output, asset, commit history or issue
  discussion of the tool identified in section 6, or of any copy or derivative of it.
- Using any constant, threshold, default, parameter name, function decomposition, file layout, comment text or test fixture
  because that tool has it.
- Importing, converting, re-rendering or being inspired by any texture asset obtained from that tool.
- Using that tool's name, logo or a "compatible with" claim.
- Searching the web for other texturing or displacement tools to compare against. Web use is for verifying literature, standards
  and library documentation.

Reading the public product description of such a tool to understand what users expect is an observer activity. It is not an
implementer's input.

### 4. Every engine constant carries a derivation

Each numeric constant, default and threshold in the texture engine has an entry in `docs/design/TEXTURE_ENGINE_PROVENANCE.md`
stating how it was derived: **measured** (with the run), **standard** (with the citation), **derived from a Pybrix invariant**
(with the invariant), or **chosen** (with the reasoning and the test that would catch it being wrong). "Another tool uses it" is
not a derivation. An entry is required before the constant merges. Each entry also states its status: whether it is a provisional
evaluation target, an owner decision, an unverified derivation, or pending a decision. No entry may call a number independently
approved or verified unless that was documented.

### 5. Restricted records

The observers' exposure record, and any document that lists material traceable to the other tool, are kept by the owner outside
the repository and outside any implementer's reach. They are never committed, never attached to an implementer session, and never
summarised to one. An implementer session starts fresh: it is not a fork of any session that read the material, and it loads no
memory or notes that name the other tool. A session that finds such material in its own context stops and reports it.

### 6. Enforcement

- TEXTURE-ENGINE-01 adds a boundary test that fails if `bumpmesh`, `stlTexturizer` or `CNCKitchen` appears in `packages/**`,
  `apps/web/src/**`, `scripts/**` or `e2e*/**` (documentation and this ADR are exempt). The test holds each name as fragments in
  separate string literals and joins them at run time, so that no file contains a name contiguously and the test cannot trip
  itself; it has a self-test that proves both outcomes.
- Asset provenance: every shipped texture has a record with source, licence identifier, author, attribution text, changes made, a
  hash of the source and the reviewer. CC0 and CC BY 4.0 sources are admissible after review; unclear or missing licences are
  excluded. Attribution text ships in `third-party-notices.txt` under the release invariant PR-01.
- The specification an implementer receives is reviewed for leakage by a session that has not seen the other tool, before
  handoff, and the review record is kept.
- A change that adds texture code is reviewed against sections 2 to 4 of this ADR by someone other than its author.

### 6a. An identifier is not exposure

The three strings of section 6 are IDENTIFIERS. They exist so that a static check can keep the tool out of the codebase and so
that a person or session can tell whether it has met the tool. Seeing them, writing the check that scans for them, running that
check, or reading the fragments in the specification's test requirements is NOT exposure and does not make a session an observer.

EXPOSURE is reading implementation material of the tool identified by those strings: its source code, scripts, styles, markup,
build output, assets, constants, parameters, file layout, commit history or issue discussion, or any description, comparison or
write-up of how it works. A session that has been exposed in that sense is an observer; a session that has seen only the
identifiers is not. This text deliberately says nothing else about the tool, and the isolation requirement of sections 1 and 5 is
unchanged by this distinction.

## Consequences

- The sanitized specification, not the planning documents, is the implementers' starting point.
- Independent derivation costs time: every constant needs a reason and a measurement. That is the price of a proprietary product.
- The patent landscape was not assessed, and this ADR does not address it.
- The protocol does not prove independence; it makes independence checkable. If an implementer realises they have seen the other
  tool's implementation material, they say so and the affected module is rewritten by someone who has not.
