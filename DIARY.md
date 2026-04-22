# DIARY

## 2026-04-21

### Immediate Goal

Lock the discussed topical/site/timing gaps into tests, then refactor the parser so site parsing no longer depends on brittle leftover-token heuristics.

### Current Failure Classes

1. Composite topical sites degrade to partial junk instead of preserving the full phrase.
   Examples:
   - `apply cream to left flank bid` -> site becomes `left`
   - `apply cream to right big toe bid` -> site becomes `right`
   - `apply cream to top of head bid` -> `top` gets stolen as topical route shorthand
   - `apply to affected areas bid` -> site becomes `affected`

2. External-surface phrases wrongly infer instillation/internal routes from a sub-phrase.
   Examples:
   - `apply to behind left ear bid` -> wrongly inferred `Otic route`
   - `apply to around anus bid` -> wrongly inferred `Per rectum`
   - `apply cream around nostrils bid` -> wrongly inferred `Nasal route`

3. Multi-site phrases are flattened badly.
   Examples:
   - `apply to scalp and forehead bid` -> `scalp forehead`
   - `apply to left arm, shoulder, and chest bid` -> one flattened phrase

4. Topical timing shorthand is incomplete.
   Examples:
   - `nightly` currently dropped
   - `qam` / `qpm` currently dropped

5. Topical workflow instructions collide with meal timing or numeric dose parsing.
   Examples:
   - `apply after showering bid` -> parsed as `after meals`
   - `apply to scalp after shampooing` -> parsed as `after meals`
   - `leave on for 10 minutes then rinse` -> parsed as dose `10`
   - `apply to scalp nightly and rinse in the morning` -> keeps `morning`, loses `nightly`

6. Ordinal anatomy can be eaten by numeric parsing.
   Example:
   - `apply cream to 2nd toe bid` -> `2` parsed as dose

### Test Matrix To Add

#### Composite site preservation

- `left flank`
- `right flank`
- `shin`
- `heel`
- `big toe`
- `right big toe`
- `2nd toe`
- `left index finger`
- `back of leg`
- `front of leg`
- `side of leg`
- `occiput`
- `top of head`
- `back of neck`
- `front of neck`
- `left side of neck`
- `right side of neck`
- `back of left ear`
- `front of right ear`
- `above left ear`
- `below right ear`
- `external genitalia`
- `vulva`
- `vulvar area`
- `foreskin`
- `cuticle`
- `nail`
- `nails`
- `nail folds`
- `eyebrows`
- `beard area`
- `moustache area`

Desired behavior for this bucket:
- preserve full site text
- prefer `Topical route` for application-style sigs unless there is an exact stronger route reason
- do not collapse the phrase to only `left`, `right`, `big`, etc.

#### Affected-area patterns

- `apply to affected area bid`
- `apply to affected areas bid`
- `apply to affected skin bid`
- `rub into affected area bid`
- Thai surface text should continue rendering `บริเวณที่เป็น`

#### Time-of-day topical patterns

- `apply to scalp in the morning`
- `apply to scalp every morning`
- `apply to scalp qam`
- `apply to scalp at night`
- `apply to scalp nightly`
- `apply to scalp qpm`
- `apply to scalp every morning and night`
- `apply to scalp morning and bedtime`
- `apply to scalp in the morning and at bedtime`

Desired behavior:
- parse into `when`
- do not drop `nightly` / `qam` / `qpm`

#### Workflow / procedure instructions

- `apply after showering bid`
- `apply after bathing bid`
- `apply after washing hair bid`
- `apply after shampooing bid`
- `apply after morning shower bid`
- `leave on for 10 minutes then rinse`
- `apply to scalp nightly and rinse in the morning`
- `apply and cover with dressing daily`
- `clean and dry affected area then apply bid`
- `wash affected area then apply bid`

Desired behavior:
- do not map these to meal timing
- do not parse the duration number as a dose
- preserve workflow text as additional instruction or equivalent structured text

#### Application qualifiers

- `apply a thin layer to affected area bid`
- `apply a thin film to affected area bid`
- `apply sparingly to affected area bid`
- `apply liberally to affected area bid`
- `apply a pea-sized amount to affected area bid`
- `apply 1 fingertip unit to affected area bid`

Desired behavior:
- no mangled output
- ideally keep qualifier text as additional instruction
- do not coerce `fingertip unit` into insulin-like `U`

### Refactor Plan

1. Replace the current site reconstruction pass with an explicit **site-phrase parser**.
   - Parse anchored spans after `to / in / into / on / onto / at`
   - Stop on real schedule / clause boundaries, not only on known site-hint tokens
   - Preserve full phrase text first, then resolve to SNOMED if possible

2. Add a **site phrase normalization** layer.
   - Normalize `affected areas` -> `affected area`
   - Preserve composite phrases like `back of neck`, `right big toe`, `2nd toe`
   - Keep source text stable for unresolved anatomy

3. Add **external-surface route protection**.
   - Phrases containing modifiers like `around`, `behind`, `front of`, `back of`, `top of`, `side of`, `above`, `below`, `external`
     should not partial-match into `otic`, `nasal`, `per rectum`, etc.
   - For application-style sigs with unresolved site phrases, default toward `Topical route`

4. Add **application-context route fallback**.
   - If route is still unset and the clause clearly uses topical application verbs (`apply`, `rub`, `massage`, etc.), use `Topical route`

5. Add **timing/workflow separation**.
   - Bare `after` / `before` should only become meal anchors when followed by meal-compatible tokens
   - Topical workflow phrases (`after showering`, `leave on`, `rinse`, `cover with dressing`) should survive as instructions

6. Fix **ordinal token handling**.
   - Prevent `2nd`, `3rd`, etc. from being split into numeric dose candidates

7. Reduce heuristic duplication.
   - Move site phrase parsing, site normalization, and route-safety logic into dedicated helpers/module(s)
   - Keep formatter preposition choice data-driven where possible

### Completed In This Pass

1. Added deterministic site-phrase extraction in `src/parser.ts`.
   - Explicit anchored parsing now handles phrases after `to / in / into / on / onto / at / under / around / behind / above / below / beneath / near`
   - Composite unresolved phrases are preserved as full text instead of collapsing to one token

2. Replaced the worst leftover-token site heuristics with scored fallback groups.
   - Site extraction now prefers anchored phrases and site-shaped residual groups
   - It no longer depends on a separate handwritten site regex inventory

3. Added structural route-safety rules.
   - `top of head` no longer loses `top` to topical route shorthand
   - External-surface phrases like `behind left ear`, `around nostrils`, `around anus` no longer partial-match into otic/nasal/rectal routes
   - Application-context fallback now assigns `Topical route` when appropriate

4. Split workflow timing from meal timing.
   - Bare `after` / `before` only become meal anchors when followed by meal-compatible tokens
   - `nightly`, `qam`, and `qpm` now map into `when`
   - Workflow phrases like `after showering` and `rinse in the morning` no longer pollute the medication schedule

5. Prevented numeric/duration collisions.
   - Ordinals like `2nd` are preserved as anatomy tokens
   - `for 10 minutes` no longer becomes a dose

6. Added route-implied site seeding where the parser already has a route but clinic sigs still expect site text.
   - `rectal` -> `rectum`
   - `vaginal` -> `vagina`

7. Locked the new behavior into tests.
   - Composite topical sites
   - External-surface phrases
   - `affected areas`
   - `qam` / `qpm` / `nightly`
   - workflow instructions and duration phrases

8. Added the first canonical IR foothold.
   - New public `ParseResult.meta.canonical.clauses`
   - New public `ParseBatchResult.meta.canonical.clauses`
   - Backed by a minimal adapter in `src/ir.ts`
   - Current implementation is one canonical clause per parsed segment

9. Wrote a dedicated architecture overview in `DIRECTIONALITY.md`.
   - Documents the target lexer -> clause parser -> scorer -> FHIR pipeline
   - Clarifies that the new canonical clause layer is an adapter during migration

## 2026-04-22

### Completed In This Architecture Pass

1. Replaced the semantic lexer spike with a real two-step token pipeline.
   - `src/lexer/surface.ts` now scans the original string directly and preserves exact spans.
   - `src/lexer/lex.ts` now performs normalization/expansion separately, with provenance.
   - No medication-domain-specific token kinds remain in the lexer.

2. Moved medication meaning out of token kinds.
   - `src/lexer/meaning.ts` now handles day/timing/route-ish meaning checks.
   - Parser logic no longer depends on semantic token-kind flags.

3. Removed source-span reconstruction by `indexOf` from the core token path.
   - Token spans now come from direct scanning.
   - Token-range calculation for parser highlights now uses token spans instead of re-finding rewritten text.

4. Expanded canonical clause structure.
   - Canonical clauses now include `raw`, `leftovers`, `evidence`, and `confidence`.
   - Evidence spans are cloned so rebasing does not mutate shared references.

5. Added regression coverage for the new boundaries.
   - Exact surface-token spans
   - Provenance after compact-token expansion
   - Thai-safe loose phrase normalization
   - Existing parser corpus still passing

### Next Architecture Slice

1. Move from the current compatibility parser onto true layered parsing.
   - Surface scan is now explicit and exact-span based.
   - Normalization/expansion is now separate from semantic lookup.
   - The next step is to make parser passes consume explicit annotations/candidates instead of ad hoc map checks.

2. Replace token-semantic shortcuts with proper annotation collectors.
   - Keep `LexKind` coarse and lexical only.
   - Emit route/site/timing/PRN candidates in dedicated passes.
   - Preserve ambiguity like `od` until scoring instead of deciding in lexing.

3. Promote canonical IR from adapter to native parser output.
   - Canonical clauses now carry raw spans, leftovers, evidence, and confidence.
   - Lowering should eventually flow `candidates -> canonical clause -> internal/FHIR`.
   - Remove duplicated mutable meaning between `ParsedSigInternal` and canonical clause once parity is reached.

4. Rebuild suggestion generation from parser state.
   - Current suggestion logic still predates the new token architecture.
   - Long term it should complete clause slots, not stitch together phrase permutations.

5. Extract the new site-phrase logic into a dedicated module.
   - Goal: separate token classification, phrase extraction, route-safety, and site normalization.

6. Replace more lexical string sets with deterministic token classes.
   - Examples: ordinal recognition, side/laterality, surface modifiers, connector roles, workflow verbs.
   - Keep lexical inventories centralized and declarative instead of scattering string checks through parser passes.

7. Add a compositional anatomy layer.
   - `back of left ear`
   - `front of neck`
   - `left flank`
   - per-digit finger/toe phrases
   - This should be phrase grammar plus modifier ordering rules, not another manual exhaustive list.

8. Improve additional-instruction capture beyond trailing-only collection.
   - Needed for phrases like `pea-sized amount`, `thin layer`, `fingertip unit`, and mid-clause workflow instructions.

### Likely Files To Touch Next

- `test/parser.spec.ts`
- `src/parser.ts`
- `src/maps.ts`
- `src/format.ts`
- `src/i18n.ts`

### Guardrails

- Do not add another giant regex list.
- Do not rely on partial n-gram site matching for external-surface phrases.
- Prefer preserving a full unresolved site phrase over producing a wrong route/site.
- Keep SNOMED-based Thai translation as the primary path for coded sites.

### 2026-04-22 Addendum

1. Moved token meaning toward generic annotation buckets.
   - `lexInput()` stays purely lexical.
   - parser-facing `tokenize()` now applies semantic annotations on top of lexical tokens.
   - token annotations now use generic `siteCandidates` and `routeCandidates` instead of specialty-specific fields.

2. Stopped re-deriving hot-path token meaning inside the parser.
   - timing abbreviation lookup now reads token annotations first
   - event timing lookup now reads token annotations first
   - day-of-week lookup and day-range expansion now use the shared meaning layer
   - single-token route lookup now reads route candidates from annotations

3. Centralized several parser word classes into shared meaning helpers.
   - workflow instruction words
   - application verbs
   - count keywords
   - site anchors/list connectors/surface modifiers
   - meal-context connectors

4. Important architecture correction:
   - no dedicated `eyeSite` annotation field
   - ocular abbreviations are now just one producer of generic site/route candidates
   - future specialty shorthand should extend candidate producers, not mutate the token schema

5. Midpoint audit follow-up:
   - `DIRECTIONALITY.md` now matches the real layered pipeline:
     `surface scan -> lexical normalization/expansion -> semantic annotation -> clause parsing -> ambiguity scoring -> lowering`
   - stage sections now include explicit definition-of-done criteria instead of only directional notes

6. Extracted site phrase decision logic into a dedicated module.
   - new `src/site-phrases.ts`
   - explicit-site capture and residual site-group selection now live outside `parser.ts`
   - route-hint inference from site text now also lives in the site module
   - `parser.ts` still owns mutation/application for compatibility, but the site detection logic is no longer buried inline in the main pass

7. Tightened the site slice one step closer to native clause assembly.
   - the site module now returns structured `SitePhraseCandidate` objects instead of forcing parser call sites to rebuild token-index arrays ad hoc
   - compatibility parser now applies site candidates, rather than treating the site module as raw token-index plumbing

### 2026-04-22 Canonical Cutover

1. Public parse outputs are no longer built from `ParsedSigInternal`.
   - `parseSig()` / `parseSigAsync()` now still use the compatibility parser for token consumption and lookup collection, but `fhir`, `shortText`, `longText`, and `meta.normalized` are derived from canonical clauses.
   - `buildParseResult()` now computes canonical clauses first, then formats and lowers from the primary canonical clause.

2. Canonical clauses are now the public formatting source of truth.
   - `src/format.ts` was rewritten so `formatCanonicalClause()` is the real formatter.
   - `formatInternal()` now only adapts internal parser state into the first canonical clause for compatibility.
   - localization context now exposes `clause`, not `internal`.

3. Canonical clauses are now the public FHIR lowering source of truth.
   - `src/fhir.ts` now exposes `canonicalToFhir()` and `canonicalFromFhir()`.
   - `toFhir()` is now only a compatibility adapter that canonicalizes first and then lowers.
   - `formatSig()` / `fromFhirDosage()` now round-trip through canonical clauses instead of `internalFromFhir()`.

4. Removed the wrong-way bridge.
   - deleted the unused canonical-to-internal lowering bridge from `src/ir.ts`
   - this keeps the migration moving toward deleting `ParsedSigInternal`, not preserving it

5. Hard cleanup rules enforced in the touched cutover path.
   - removed the remaining touched-file `as any` cast from `src/index.ts`
   - no `as any` / `as unknown` / `as never` remain in the rewritten public path modules

6. Current boundary after the cutover.
   - `ParsedSigInternal` still exists inside `src/parser.ts`, carry-forward handling, and internal compatibility helpers
   - public parse semantics now flow through canonical clauses
   - next real deletion target is shrinking or replacing `ParsedSigInternal` inside the parser itself, not in public output assembly

### 2026-04-22 Parser Core Follow-Through

1. Parser semantic storage is no longer plain `ParsedSigInternal` field storage.
   - `parseInternal()` now creates a clause-backed compatibility object in `src/parser.ts`
   - dose / route / site / schedule / PRN scalar fields are stored through accessors that write into the canonical clause during parsing
   - `dayOfWeek` / `when` arrays are now shared directly with the canonical clause schedule while parsing

2. Canonical is now assembled during parsing, not only reconstructed after parsing.
   - the parser finalization step now stamps canonical `rawText`, `span`, `raw`, `leftovers`, `warnings`, and `confidence`
   - `buildCanonicalSigClauses()` in `src/ir.ts` now returns parser-built canonical clauses when they already exist

3. Remaining compatibility boundary after this pass.
   - helper functions in `src/parser.ts` still accept `ParsedSigInternal`-shaped state, but that state is now clause-backed
   - `ParsedSigInternal` still exists as the parser-compatibility shell and for some older helper/tests
   - the next cleanup target is reducing the parser helper signatures and resolver/carry-forward paths so they stop naming `ParsedSigInternal` at all

### 2026-04-22 Advice Grammar And Terminology Extraction

1. Replaced the old `maps.ts` additional-instruction phrase bag with data + grammar.
   - added `src/advice-terminology.json` as the maintainable vocabulary source for advice lexemes and concepts
   - added `src/advice.ts` as the grammar/data layer for additional instructions
   - removed `DEFAULT_ADDITIONAL_INSTRUCTION_SOURCE` and related lookup tables from `src/maps.ts`

2. Additional instructions are no longer parsed as trailing exact-text label lookup.
   - parser now scans every leftover token group, not only the trailing tail
   - advice parsing now produces generic `AdviceFrame[]` structures first
   - coding is assigned afterward through frame-matching rules, not direct phrase equality

3. Reverse coding lookup is now advice-owned instead of map-owned.
   - `findAdditionalInstructionDefinitionByCoding()` now lives in `src/advice.ts`
   - coded FHIR round-trips can now hydrate advice frames from the coding rule templates

4. Canonical output now preserves structured advice.
   - canonical clause `additionalInstructions[]` now carry `frames`
   - parser/fhir paths preserve those frames instead of flattening them immediately back to text
   - regression tests now lock structured frames for:
     - `do not crush or chew`
     - `no alcohol`
     - `after showering`
     - `leave on for 10 minutes then rinse`
     - `rinse in the morning`

5. Current remaining parser-core debt after this slice.
   - the parser state object is still named `ParsedSigInternal`
   - the central parse loop is still a large ordered collector/mutator, even though public outputs are canonical-first
   - next cleanup target is renaming/removing the old parser-state shell and pushing more collector decisions into explicit native clause assembly/scoring

### 2026-04-22 Parser Core State Cutover

1. Deleted the old parser shell file.
   - removed `src/internal-types.ts`
   - replaced it with `src/parser-state.ts`
   - parser state is now explicitly a canonical-clause-backed `ParserState` object

2. Canonical clause storage is now the parser core, not a reconstructed mirror.
   - `ParserState` owns one primary canonical clause plus parser metadata (`consumed`, lookups, warnings, token spans)
   - scalar parser fields (`dose`, `routeCode`, `siteText`, `timingCode`, `additionalInstructions`, etc.) are now accessors over the canonical clause, not duplicated semantic storage
   - `src/ir.ts` no longer rebuilds clauses from parser state; `buildCanonicalSigClauses()` now just returns `state.clauses`

3. The parser entrypoint was renamed and decomposed into explicit passes.
   - `parseInternal()` became `parseClauseState()`
   - PRN prelude detection is now a named pass
   - multiplicative cadence collection is now a named pass
   - post-token defaults (unit/frequency/timing reconciliation) are now a named pass
   - PRN tail capture is now a named pass
   - site/advice/warning collection is now a named pass

4. Downstream paths now read parser state directly.
   - parse-result assembly in `src/index.ts` now reads `state.clauses` directly
   - FHIR lowering in `src/fhir.ts` now reads `state.clauses` directly
   - formatter fallback in `src/format.ts` now reads `state.clauses` directly

5. Current remaining debt after this parser-core cutover.
   - the main sequential token scan in `parseClauseState()` is still heuristic-heavy and remains the biggest blob
   - the next true endgame step is replacing that main scan with more explicit collector/scoring stages for dose/route/schedule/site ambiguity, not just more helper extraction

### 2026-04-22 Parser Core Collector Rewrite

1. Replaced the giant inline `parseClauseState()` token loop with an explicit collector pipeline.
   - introduced `ClauseParseContext`
   - introduced a named `CLAUSE_COLLECTORS` precedence list
   - parser entrypoint now does:
     - tokenize
     - detect PRN prelude
     - collect multiplicative cadence
     - run clause collectors
     - apply defaults
     - collect PRN tail
     - collect site/advice/warnings
     - finalize canonical clause

2. Route lookup setup is now built once up front.
   - custom route phrase lookup and normalized descriptor lookup are created by dedicated helpers
   - `parseClauseState()` no longer builds these through inline array transforms

3. The collector rewrite moved the main precedence decisions into named units.
   - timing / anchor collectors
   - route synonym collector
   - site abbreviation collector
   - count collector
   - dose collectors
   - generic connector collector

4. The parser core is materially cleaner now, but not mathematically “full CFG” yet.
   - precedence is now explicit and auditable in the collector list instead of buried in one long loop
   - the next true endgame step is still ambiguity scoring and more phrase-level collectors so hard cases stop depending only on collector order

### 2026-04-22 Recursive-Descent Clause Grammar

1. Replaced the collector list with real clause productions in `src/parser.ts`.
   - `parseClauseGrammar()`
   - `parseCoreTerm()`
   - `parseScheduleTerm()`
   - `parseRouteTerm()`
   - `parseSiteTerm()`
   - `parseCountTerm()`
   - `parseDoseTerm()`
   - `parseConnectorTerm()`

2. Added grammar evidence recording.
   - successful productions now append rule evidence onto the canonical clause
   - this gives the parser an auditable semantic trace instead of “it happened because branch order”

3. Moved more formerly heuristic patterns into grammar terms.
   - phrase-level schedule parsing such as `twice daily`
   - multiplicative cadence such as `1x3` / `1.5 x3`
   - PRN schedule peel-off for suffixes like `tid` / `hs`

4. Chose not to add Chevrotain at this stage.
   - researched it as the obvious JS grammar toolkit candidate
   - rejected it for now because this repo already has a lexer, wants a small runtime footprint, and the local recursive-descent grammar is enough for the current clause language without adding a new runtime/parser dependency

### 2026-04-22 Advice Rule DSL

1. Moved coded additional-instruction semantics out of handwritten TS matcher closures.
   - added `src/advice-rules.json` as the declarative rule inventory
   - `src/advice.ts` now maps JSON rule data into typed matcher trees and evaluates them generically

2. Reduced concept-specific phrase branches in the advice parser.
   - drowsiness/next-day detection now uses concept ids from terminology data instead of literal phrase checks
   - negated activity detection such as `no driving` now resolves through verb lexemes instead of hardcoded string pairs
   - added lemma coverage like `driving` and `causes` into `src/advice-terminology.json`

3. Locked the data-driven rule layer with direct advice-module tests.
   - added `test/advice.spec.ts`
   - covers JSON-backed coding resolution, negated substance advice, and frame reconstruction from coded definitions

4. This addresses the `AUDIT_ADDITIONAL_INST_2` complaint about rule semantics living in TS.
   - advice collection is still leftover-group based in the main parser
   - bilingual terminology breadth is still limited
   - but the coded advice inventory is now maintainable as data instead of expanding matcher code
