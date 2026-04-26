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

### 2026-04-22 RF2-Derived Advice Expansion

1. Expanded the additional-instruction inventory from the local SNOMED RF2 release instead of inventing freehand codes.
   - added specific meal-state qualifiers: `After food` and `Before food`
   - added `Warning. May cause drowsiness`
   - added common outpatient cautions such as `Use with caution` and `Follow the printed instructions...`
   - added practical topical/oral instruction qualifiers such as `Sparingly`, `Liberally`, `Dissolved under the tongue`, and `Swish and swallow`
   - added exact imperative qualifiers for `Wash`, `Insert`, `Instill`, and `Shampoo`

2. Added a generic normalized-text matcher to the advice rule DSL.
   - this lets us represent canned SNOMED instruction phrases in JSON when the clause grammar does not yet decompose them structurally
   - avoids falling back to more concept-specific TS branches

3. Added Thai text for the expanded coded advice set.
   - Thai localization for additional instructions now benefits automatically because `i18n.ts` already prefers coded advice translations by SNOMED code

4. Remaining architectural gap:
   - advice collection still comes from leftover groups in the parser core
   - terminology coverage is broader now, but a larger future step is still to mine more RF2 qualifier/instruction concepts systematically rather than ad hoc keyword passes

### 2026-04-22 Real-World Advice And Thai PRN Fixes

1. Fixed Thai PRN reason lookup at the dictionary layer.
   - default PRN reason terms now include aliases and localized `i18n` text, not only the original English source names
   - added explicit pain aliases such as `เจ็บ` and `ปวด`
   - this lets cases like `apply prn คัน` and `apply to lesion prn เจ็บ` resolve to the intended SNOMED reasons

2. Fixed PRN trailing meal suffix handling for oral sigs.
   - explicit `after food` / `before food` at the end of a PRN reason tail now preserve the correct meal relation instead of degrading to generic `with meals`

3. Expanded sparing-amount advice variants.
   - `use little`, `use little at a time`, `use minimal`, `use minimum amount`, and similar topical shorthand now map to the coded sparingly instruction
   - `liberally` remains coded as its own SNOMED qualifier

4. Added parser-level regression tests for real-world combined sigs.
   - oral `prn pain after food`
   - topical `prn คัน` with sparing advice
   - topical `prn เจ็บ` with a free-text lesion site

### 2026-04-22 Itch Subtype PRN Coding

1. Checked the local SNOMED RF2 snapshot for itch subtypes instead of guessing.
   - `Itching of eye` exists and is usable (`74776002`)
   - `Itching of lesion of skin` exists and is usable (`445329008`)
   - no clean pre-coordinated `itching of wound` concept was found in the snapshot we ship against

2. Expanded the default PRN reason dictionary accordingly.
   - `eye itch`, `itchy eye`, `itchy eyes`, and Thai aliases like `คันตา` now resolve to `Itching of eye`
   - lesion-itch variants now resolve to `Itching of lesion of skin`
   - wound-itch variants intentionally fall back to generic `Itching of skin` while preserving the original text

3. Added end-to-end parser tests for these subtype cases.

### 2026-04-22 Topical / Shampoo / Cosmetic Gap Inventory

1. Product-form nouns are still mostly treated as leftovers instead of neutral terminology.
   - examples: `cream`, `ointment`, `gel`, `shampoo`, `moisturizer`, `lotion`, `serum`, `toner`, `sunscreen`, `deodorant`, `lip balm`, `makeup remover`
   - current symptom: the clause parses, but `meta.leftoverText` still contains the product noun
   - concrete failures seen:
     - `apply cream to scalp twice daily`
     - `use shampoo daily`
     - `apply moisturizer to face every morning`
     - `apply deodorant after showering`

2. Topical/cosmetic quantity language is under-modeled.
   - countable medication units like `patch`, `drop`, and `mL` work
   - semi-structured topical quantities do not
   - concrete failures seen:
     - `1 fingertip unit` degrades into `1 U` with `fingertip` left over
     - `1 squeeze`, `1 pump`, `1 scoop`, `1 capful`, `1 application` become `Apply 1 ...`
     - `0.5 inch ribbon` loses the `ribbon` semantics
     - `applicatorful` is not represented cleanly
   - architectural conclusion:
     - do not force these into ordinary `dose`
     - add a dedicated canonical `applicationAmount` structure for topical/cosmetic quantities

3. Qualitative amount language is mixed.
   - currently good:
     - `sparingly`
     - `liberally`
     - `thin layer`
     - `pea-sized amount`
   - currently weak:
     - `small amount`
     - `generous amount`
     - `enough to cover`
     - `little at a time` outside the already-covered advice paths

4. Shampoo / cleanser / wash workflows are not modeled as first-class administration patterns.
   - concrete failures seen:
     - `use shampoo daily`
     - `shampoo scalp daily`
     - `use cleanser twice daily`
     - `use face wash morning and bedtime`
   - partial behavior:
     - `wash scalp with shampoo daily` can fall into additional instructions
     - `apply shampoo to scalp daily` parses, but treats `Shampoo` as trailing advice rather than the core product/action

5. Workflow and event instructions are still partial.
   - currently acceptable:
     - `after showering`
     - `after bathing`
     - `before intercourse`
     - `after sex`
   - currently weak or broken:
     - `leave on 5 minutes then rinse`
     - `massage into scalp and leave on for 5 minutes then rinse`
     - `after each diaper change`
     - `with each dressing change`
     - `after each bowel movement`
     - `reapply after swimming`
     - `while outdoors`
     - `before going outside`
     - `after cleansing`

6. Several cosmetic / topical phrases still misparse badly and need explicit tests.
   - `sun` can collide with Sunday in phrases like `before sun exposure`
   - `patch` can collide with dosage-unit parsing in phrases like `dry patches`
   - `under eyes`, `wet face`, `around nostrils`, `around anus` can be swallowed into crude site text instead of a better structured phrase
   - `apply ointment inside nostrils twice daily` currently makes `ointment inside nostrils` the site text
   - `apply rectal cream twice daily` currently over-infers rectal route plus `suppository`, which is wrong for cream
   - `apply vaginal cream nightly` similarly over-infers route/unit too aggressively

7. Multi-event timing for topical regimens is still incomplete.
   - currently good:
     - `nightly`
     - `every morning`
     - `before bed`
     - `morning and bedtime`
   - currently weak:
     - `qam and qhs`
     - combinations like `reapply every 2 hours while outdoors`
     - event-driven recurrence such as `after each bowel movement` or `with each dressing change`

8. Current recommended modeling direction for the next pass.
   - add a `product form` grammar class so cosmetic/topical nouns stop becoming leftovers
   - add canonical `applicationAmount`
     - `value?: number`
     - `unitText: string`
     - `normalizedUnit?: "pump" | "squeeze" | "applicatorful" | "fingertip_unit" | "ribbon_inch" | "capful" | ...`
   - keep qualitative phrases like `sparingly` / `thin layer` in advice/additional-instruction
   - add workflow/event parsing for `after X`, `before X`, `while X`, `leave on`, `rinse`, `reapply`

9. Highest-value probe cases to lock into tests before more parser work.
   - `apply cream to scalp twice daily`
   - `use shampoo daily`
   - `apply moisturizer to face every morning`
   - `apply sunscreen liberally 15 minutes before sun exposure`
   - `reapply sunscreen every 2 hours`
   - `apply 2 pumps to face every morning`
   - `apply 1 fingertip unit to scalp twice daily`
   - `insert 1 applicatorful vaginally at bedtime`
   - `apply 0.5 inch ribbon to eyelid nightly`
   - `apply hemorrhoid cream after each bowel movement`

2026-04-22 method translation / FHIR standards note

1. `Dosage.method` is the correct public field for administration technique.
   - keep `route` / `site` / `timing` / `patientInstruction` on `Dosage`
   - do not invent a public custom `productForm` field on `Dosage`

2. Language localization for `method` should use standard FHIR primitive extensions, not custom JSON fields.
   - `CodeableConcept.text` -> `_text.extension[url=translation]`
   - `Coding.display` -> `_display.extension[url=translation]`
   - Thai formatter should prefer those standard translations first

3. Product form is not a `Dosage` element.
   - it belongs more naturally on `Medication.doseForm` or `AdministrableProductDefinition.administrableDoseForm`
   - for this library, product-form cues can still be used internally during parsing/realization, but should not leak as a public custom `Dosage` property

4. Practical rule now:
   - parser deterministically composes method surface text from verb + product-form cues
   - public FHIR output carries that on `Dosage.method.text`
   - Thai text is carried using standard FHIR translation extensions on `method._text`
   - generic method code translations use `_display` when safe (`Apply`, `Spray`, `Insert`, `Instill`, `Swallow`, `Rinse or wash`)

5. This is the current maintainable compromise.
   - public/storage path stays FHIR-first
   - Thai round-trip stops depending purely on formatter-local hardcoded phrase guesses
   - product-form nuance is preserved when consumers keep normal FHIR `text` + primitive extensions

2026-04-22 advice grammar: elliptical meal-state fragments

1. `empty stomach` is a real clinic shorthand, not just a missing synonym.
   - it is an elliptical noun-phrase instruction
   - the right parse is an implicit relation frame: `on + empty_stomach`
   - the wrong parse is leftover free text or anatomical `site = stomach`

2. Fix shape:
   - advice terminology now carries `implicitRelation` on concepts when the noun phrase itself implies a relation
   - advice grammar has an `implicit concept instruction` production
   - clause/site grammar now refuses to steal residual or explicit site phrases that already parse as instruction grammar

3. Locked cases:
   - `drink 10 ml twice daily, empty stomach`
   - `drink 10 ml twice daily, on an empty stomach`
   - both now code SNOMED `717154004`
   - both now render:
     - English: `Drink 10 mL twice daily. On an empty stomach.`
     - Thai: `รับประทาน ครั้งละ 10 มิลลิลิตร วันละ 2 ครั้ง. ขณะท้องว่าง.`

4. Architectural note:
   - this is grammar/terminology driven, not a raw string replacement
   - the important guard is “instruction grammar outranks residual site salvage” for phrases that already have structured advice meaning

2026-04-22 PRN reason cutoff vs warning tails

1. `prn dizziness, can/may/might/could cause drowsiness` exposed a parser-boundary bug.
   - PRN reason collection was swallowing the warning tail
   - result was `asNeededFor = "dizziness, can cause drowsiness"` instead of:
     - PRN reason: `dizziness`
     - additional instruction: coded drowsiness warning

2. Fix shape:
   - drowsiness warning grammar now accepts modal variants:
     - `may cause`
     - `can cause`
     - `might cause`
     - `could cause`
   - PRN cutoff now uses structured instruction detection on comma tails
     - a comma only splits the PRN reason when the tail parses as real advice grammar
     - this avoids blindly splitting every comma-delimited reason list

3. Locked result:
   - `take 10 ml prn dizziness, can cause drowsiness`
   - `take 10 ml prn dizziness, may cause drowsiness`
   - `take 10 ml prn dizziness, might cause drowsiness`
   - `take 10 ml prn dizziness, could cause drowsiness`
   - all now render:
     - `Take 10 mL orally as needed for dizziness. May cause drowsiness.`
   - all code drowsiness warning as SNOMED `418639000`

2026-04-22 Generic advice-clause grammar unification

1. The advice parser was still structurally too “branch by concept”.
   - `avoid`, negated verb chains, `may cause`, and plain verb instructions each had their own parser entrypoint
   - that worked, but it kept the advice layer feeling heuristic-heavy even after the larger parser migration

2. Refactor shape:
   - introduced first-class `AdviceModality`
     - `may`
     - `can`
     - `might`
     - `could`
     - `should`
     - `must`
   - added those modal lexemes to `advice-terminology.json`
   - replaced the separate avoid/negated-verb/may-cause/plain-verb parsers with one generic clause parser:
     - optional modality
     - optional negation
     - verb series
     - optional relation
     - optional argument phrase
   - force is now derived deterministically from grammar features:
     - `effect` or weak modal -> warning
     - `should` -> caution
     - negation / `avoid` -> warning
     - otherwise default instruction

3. Important behavioral results:
   - `must not take with warfarin` now stays `Must not...`, not flattened to generic `Do not...`
   - uncoded modal advice now survives as structured text instead of dead leftovers:
     - `Should take with grapefruit juice`
     - `Might cause dizziness`
     - `Use caution in storms`
   - coded advice still wins when terminology exists:
     - `can cause drowsiness` still codes SNOMED `418639000`
     - `must not take with alcohol` still codes the alcohol warning

4. Verification:
   - `nvm use 22`
   - `npm run build`
   - `npm test`
   - green at `518` tests

2026-04-22 Coordinated PRN reasons

1. Surface wording like:
   - `Take 1 tablet orally as needed for pain or fever.`
   looked okay, but the structure underneath was wrong.
   - parser only stored one PRN blob: `pain or fever`
   - FHIR only emitted one `asNeededFor`

2. Structural fix:
   - widened canonical PRN shape to allow `prn.reasons[]` while keeping `prn.reason` as the original display phrase
   - added deterministic coordinated-reason expansion after PRN resolution
   - expansion only happens when every coordinated part resolves cleanly as a real PRN reason
   - public/output path stays FHIR-first:
     - `asNeededFor[0] = pain`
     - `asNeededFor[1] = fever`

3. Realization rule:
   - keep natural human wording from the original phrase when it is already clean
   - if the original combined phrase uses raw separators like `/` or `,`, prefer normalized coordinated realization from `prn.reasons[]`
   - examples now all render as:
     - `Take 1 tablet orally as needed for pain or fever.`
   - covered inputs:
     - `pain or fever`
     - `pain/fever`
     - `pain, fever`

4. Verification:
   - `nvm use 22`
   - `npm run build`
   - `npm test`
   - green at `520` tests

2026-04-22 Thai coordinated PRN localization

1. Two Thai-specific gaps showed up:
   - parser did not split PRN reasons on Thai `หรือ`
   - Thai formatter still preferred the raw combined phrase over translated split reasons when `prn.reasons[]` existed

2. Fixes:
   - PRN coordinated splitting now recognizes Thai connectors:
     - `หรือ`
     - `และ`
   - Thai PRN realization now prefers translated/joined `prn.reasons[]` when present
     - this lets coded reasons localize cleanly even if the original combined text was English

3. Locked behavior:
   - `1 tab po prn คิดฟุ้งซ่าน หรือ ทำงานไม่ได้`
     - Thai long text:
       - `รับประทาน ครั้งละ 1 เม็ด ใช้เมื่อจำเป็นสำหรับ คิดฟุ้งซ่าน หรือ ทำงานไม่ได้.`
     - FHIR:
       - `asNeededFor[0].text = คิดฟุ้งซ่าน`
       - `asNeededFor[1].text = ทำงานไม่ได้`
   - `1 tab po prn pain or fever` with `locale: "th"`
     - Thai long text:
       - `รับประทาน ครั้งละ 1 เม็ด ใช้เมื่อจำเป็นสำหรับ ปวด หรือ ไข้.`
     - FHIR still keeps structured coded reasons for pain and fever

4. Verification:
   - `nvm use 22`
   - `npm run build`
   - `npm test`
   - green at `523` tests

2026-04-22 Ambulatory PRN inventory findings

1. Current built-in PRN scope is still small:
   - `14` coded concept entries
   - roughly `57` built-in surface aliases

2. Local SNOMED snapshot produced clean ambulatory hits for a broad first-wave expansion.
   Good candidates with stable clinic-usable concepts:

   Pain/MSK:
   - `22253000` Pain
   - `25064002` Headache
   - `37796009` Migraine
   - `161891005` Backache / back pain
   - `279039007` Low back pain
   - `57676002` Pain of joint / joint pain
   - `68962001` Muscle pain
   - `301354004` Pain of ear / earache / otalgia
   - `267102003` Sore throat
   - `29857009` Chest pain
   - `274671002` Pelvic and perineal pain
   - `266599000` Dysmenorrhea / menstrual cramps
   - `55300003` Cramp
   - `45352006` Spasm

   GI:
   - `422587007` Nausea
   - `422400008` Vomiting
   - `16932000` Nausea and vomiting
   - `62315008` Diarrhea
   - `14760008` Constipation
   - `16331000` Heartburn
   - `21522001` Abdominal pain
   - `116289008` Abdominal bloating
   - `249504006` Flatulence

   Respiratory/allergy/ENT:
   - `49727002` Cough
   - `68235000` Nasal congestion
   - `64531003` Nasal discharge / rhinorrhea
   - `267036007` Dyspnea / shortness of breath
   - `56018004` Wheezing / wheeze
   - `76067001` Sneezing
   - `61582004` Allergic rhinitis
   - `21719001` Hay fever

   Derm/ocular:
   - `418363000` Itching of skin
   - `74776002` Itching of eye
   - `445329008` Itching of lesion of skin
   - `271807003` Eruption of skin / rash / skin rash
   - `90673000` Burning sensation
   - `257553007` Irritation
   - `162290004` Dry eyes
   - `703630003` Red eye
   - `41652007` Pain in eye / eye pain
   - `52475004` Xeroderma / dry skin

   GU/OBGYN:
   - `49650001` Dysuria
   - `364198000` Frequency of urination
   - `75088002` Urgent desire to urinate
   - `271939006` Vaginal discharge
   - `161816004` Vaginal irritation
   - `34363003` Pruritus of vagina / itching of vagina

   Psych/neuro:
   - `48694002` Anxiety
   - `225624000` Panic attack
   - `24199005` Feeling agitated / agitation
   - `193462001` Insomnia
   - `79519003` Drowsiness
   - `404640003` Dizziness
   - `399153001` Vertigo
   - `7011001` Hallucinations
   - `231494001` Mania
   - `80313002` Palpitations

3. Ambiguous / trap concepts to avoid or review before adding:
   - `255339005` is `Depression - motion`, so it is wrong for psychiatric depression
   - `1806006` is morphologic `Eruption`; use `271807003` for symptom rash instead
   - `79519003` vs `271782001` for drowsiness needs one consistent choice; current code already uses `79519003`
   - plain `allergy` is too broad and low-signal; `allergic rhinitis` / `hay fever` is safer for ambulatory PRN
   - ocular irritation/redness exact concept matching is uneven; `red eye` is clean, generic `eye irritation` is not

4. Next implementation bias:
   - add the clearly clean concepts first
   - avoid inventing questionable psychiatric/depression codings
   - keep Thai output labels on every coded concept
   - add Thai free-text aliases only for the higher-frequency ambulatory symptoms first

## 2026-04-22 Ambulatory PRN expansion verified

1. Landed inventory size after the `src/maps.ts` expansion:
   - `59` unique coded PRN concepts
   - `290` normalized alias keys in `DEFAULT_PRN_REASON_DEFINITIONS`

2. Verified representative coded parsing across specialties:
   - primary care / pain: `1 tab po prn headache` -> `25064002`
   - GI: `1 tab po prn diarrhea` -> `62315008`
   - allergy / ENT: `1 tab po prn nasal congestion` -> `68235000`
   - ocular: `1 drop ou prn red eye` -> `703630003`
   - GU: `1 tab po prn dysuria` -> `49650001`
   - psych: `1 tab po prn panic attack` -> `225624000`

3. Verified Thai alias path end to end:
   - `1 tab po prn ปวดหัว` -> localized `ปวดศีรษะ`, code `25064002`
   - `1 tab po prn คัดจมูก` -> localized `คัดจมูก`, code `68235000`
   - `1 drop ou prn ตาแดง` -> localized `ตาแดง`, code `703630003`
   - `1 tab po prn แสบขัด` -> localized `แสบขัดเวลาปัสสาวะ`, code `49650001`

4. Coordinated PRN behavior after expansion:
   - partially known coordination now splits per concept instead of treating the whole phrase as one blob
   - example: `mania or depression` -> `mania` coded (`231494001`), `depression` kept as text-only
   - fully unknown coordination still splits into text-only reasons

5. Regression coverage added:
   - representative expanded ambulatory PRN codes across specialties
   - Thai alias acceptance for the expanded inventory
   - partial-known and fully-unknown coordinated PRN reasons

## 2026-04-22 ParseBatch normalized type drift

1. Found a declaration drift bug behind editor red underlining:
   - runtime `parseSig(...).meta.normalized` already included `prnReasons`
   - `ParseResult` declared it
   - `ParseBatchResult` did not, even though `parseSig()` returns `ParseBatchResult`

2. Fixed by introducing a shared `ParseNormalizedMeta` type in `src/types.ts`
   and using it for both `ParseResult.meta.normalized` and
   `ParseBatchResult.meta.normalized`.

3. This removes the duplicate normalized-shape definitions and should prevent the
   same drift from reappearing when new normalized fields are added later.

## 2026-04-22 Readonly alias compatibility

1. Found another public type-surface friction point in custom site maps:
   - tests used `as const` for `siteCodeMap`
   - nested `aliases` arrays became readonly tuples
   - exported `BodySiteDefinition.aliases` and `CodeableConceptDefinition.aliases`
     still required mutable `string[]`

2. Fixed by widening both alias fields to `readonly string[]`.
   Runtime already only iterated aliases and never mutated them, so this is the
   correct public contract and removes the need for casts in consumer code.

## 2026-04-22 PRN plus finite-duration window

1. Probe:
   - `take 1 tab po for 7 days prn vaginal itch`

2. Conclusion:
   - this is not bad form; it expresses a legitimate instruction window:
     take orally as needed for vaginal itch, limited to a 7-day course
   - parser does not currently scope it correctly

3. Current incorrect behavior:
   - `for 7 days` before `prn` gets dropped as leftovers
   - `x 7 days` is treated as `count = 7` doses, not a 7-day duration window
   - `prn vaginal itch for 7 days` swallows `for 7 days` into the PRN reason text

4. Proper target semantics:
   - dose: `1 tab`
   - route: oral
   - PRN reason: `vaginal itch` / SNOMED `34363003`
   - duration window: `7 days`

5. Architecture implication:
   - need true schedule-bound grammar for PRN courses, not a count hack
   - this should eventually lower to a timing bound/duration concept, not to a
     reason suffix or dose count

## 2026-04-22 Schedule duration regression fixed

1. Root cause:
   - local `FhirTimingRepeat` / canonical schedule model had `count` but no
     `duration`/`durationUnit`
   - parser therefore had no honest place to put `for 10 days`
   - result: `for N days` got dropped, and `x7 days` degraded into `count = 7`

2. Structural fix:
   - added `duration`, `durationMax`, `durationUnit` to local FHIR timing type
   - added matching fields to canonical schedule + parser state
   - added grammar-level duration collector for unit-bearing windows:
     `for 10 days`, `x7 days`, `x 7 days`, compact `x7d`
   - kept plain `x7` as count

3. Important guardrail:
   - duration collection is now gated on existing administration content so
     workflow text like `leave on for 10 minutes then rinse` stays in
     `patientInstruction` instead of being stolen into schedule timing

4. Verified examples after the fix:
   - `take 1 tab po od for 10 days` -> `Take 1 tablet orally once daily for 10 days.`
   - `1 tab po od for 7 days` -> `Take 1 tablet orally once daily for 7 days.`
   - `1 tab po od x7 days` -> `Take 1 tablet orally once daily for 7 days.`
   - `take 1 tab po for 7 days prn vaginal itch` ->
     `Take 1 tablet orally for 7 days as needed for vaginal itch.`
   - `take 1 tab po prn vaginal itch for 7 days` ->
     `Take 1 tablet orally for 7 days as needed for vaginal itch.`
   - `leave on for 10 minutes then rinse` stays patient-instruction text

## 2026-04-22 Schedule duration cap in calculations

1. Kept the external calculation API intact:
   - `calculateTotalUnits` still uses caller-supplied `durationValue` /
     `durationUnit`
   - that remains the primary calculation window by design

2. Added parsed-dosage duration as an internal cap:
   - if `dosage.timing.repeat.duration` is present, it now clamps the external
     window downward instead of replacing it
   - effective behavior is `min(external window, parsed dosage duration cap)`

3. Applied the same cap to `nextDueDoses`:
   - future dose generation now stops at the regimen duration end when there is
     a usable course anchor (`orderedAt`, otherwise `from`)

4. Verified:
   - `calculateTotalUnits(parseSig(\"1 tab po od for 7 days\"), external 30 days)`
     now returns `7`, not `30`
   - `nextDueDoses(parseSig(\"1 tab po od for 7 days\"), orderedAt Jan 1, from Jan 5)`
     now stops after the Jan 7 dose

## 2026-04-22 Non-day duration caps verified

1. Live-probed parsed duration caps across other units:
   - `1 tab po q12h for 36 hours`
   - `1 tab po weekly for 3 weeks`
   - `1 tab po monthly for 2 months`

2. Confirmed behavior:
   - hour-based caps work in both `calculateTotalUnits` and `nextDueDoses`
   - week-based caps work in both `calculateTotalUnits` and `nextDueDoses`
   - month-based caps work in both `calculateTotalUnits` and `nextDueDoses`

3. Current caveat:
   - free-text yearly duration did not parse from `yearly for 2 years`
   - scheduler stepper itself does support year units (`a`) if the FHIR timing
     already contains them, but the sig parser does not currently infer that
     free-text form

## 2026-04-22 Minute interval realization bug fixed

1. User-reported sig:
   - `1 drop ou Q15min x 8 doses`

2. Root cause:
   - parser already produced the correct schedule structure:
     - `period = 15`
     - `periodUnit = min`
     - `count = 8`
   - the failure was only in long-text realization
   - English/Thai frequency describers had hour/day/week/month handling but no
     minute branch, so formatting fell back to count-only wording

3. Fix:
   - added minute-interval realization to both `src/format.ts` and
     `src/i18n.ts`
   - also added yearly realization while touching the same switch-shaped area

4. Verified output:
   - English: `Instill 1 drop every 15 minutes for 8 doses in both eyes.`
   - Thai: `หยอด ครั้งละ 1 หยด ทุก 15 นาที จำนวน 8 ครั้ง ที่ตาทั้งสองข้าง.`

## 2026-04-22 FHIR course bounds corrected

1. Standards decision:
   - keep this library R5 `Dosage`-first for now
   - do not target R6 `DosageDetails` yet because R6 is still ballot / CI-build,
     not the current official release

2. Clean semantic split:
   - regimen/course limit like `for 7 days` now belongs in
     `Timing.repeat.boundsDuration` or `Timing.repeat.boundsRange`
   - per-administration runtime like `slow push over 5-10 minutes` is now free
     to use the real `Timing.repeat.duration/durationMax/durationUnit` fields
     later without semantic collision

3. Implementation change:
   - removed the incorrect FHIR wire use of `repeat.duration*` for course
     limits
   - canonical/internal parser state still keeps `schedule.duration*`
     unchanged
   - `canonical -> FHIR` now emits:
     - fixed course length -> `repeat.boundsDuration`
     - ranged course length -> `repeat.boundsRange`
   - `FHIR -> canonical` and scheduling math now read those bounds fields

4. Verification:
   - parser tests now assert `boundsDuration` for fixed course windows
   - FHIR import tests cover both `boundsDuration` and `boundsRange`

## 2026-04-22 Planned staged-regimen work

1. Scope judgment:
   - supporting true staged regimens like
     `Q15min x4, then Q1H x4, then Q2H for 7 days, then QID for 1 month`
     is not a tiny patch
   - but it is not a hopeless rewrite either if kept to a staged-regimen layer
     above the current multi-dosage batch model

2. Clean semantic target:
   - concurrent / continuous multi-dose regimens:
     - multiple `Dosage` entries with the same `sequence`
     - example: thyroid-style different doses on different weekdays
   - sequential / staged regimens:
     - multiple `Dosage` entries with increasing `sequence`
     - optional top-level R6-like `dosageDetails` export derived from the same
       internal regimen model

3. Architecture plan:
   - keep current item-level `Dosage` output
   - add an internal regimen grouping layer above `ParseBatchResult.items`
   - parse `then` / explicit sequencing into stage boundaries
   - mark concurrent grouped items separately from sequential stage transitions
   - serialize:
     - R5 path: `Dosage.sequence`
     - optional top-level R6-ish `dosageDetails`

4. Calculator impact:
   - existing single-dosage calculators (`calculateTotalUnits`, `nextDueDoses`)
     do not need to be replaced
   - item-level calculation can stay as-is
   - new regimen-aware calculation should sit above them:
     - same-sequence items = concurrent windows, sum results
     - increasing-sequence items = chained windows, each stage starts after the
       previous stage ends
   - this means staged-regimen support is a new orchestration layer, not a
     total rewrite of the current schedule engine

5. Recommended implementation order:
   - phase 1: internal regimen grouping metadata + `Dosage.sequence`
   - phase 2: parser support for explicit `then` stage boundaries
   - phase 3: regimen-aware total-units / due-dose helpers
   - phase 4: optional top-level `dosageDetails` serializer

## 2026-04-22 Scheduler/Calculator Audit Before Staged-Regimen Work

Verified the current `nextDueDoses` / `calculateTotalUnits` shape before adding
sequential regimen support. Two real bugs were present in the shared schedule
layer; both are now fixed and locked into tests.

1. Real bugs that were found:
   - bare `dayOfWeek` schedules like `1 tab po every monday` parsed fine but
     did not recur in `nextDueDoses`
   - `calculateTotalUnits` ignored total-count caps like:
     - `1 drop ou q15min x 8 doses`
     - `1 drop os q1/4h x4`
     - `1 tab po q0.5h x3 times`
     because `countScheduleEvents()` was not honoring `repeat.count`

2. Structural fix:
   - added a shared day-filtered series fallback in `src/schedule.ts`
     so bare weekday schedules are treated as weekly recurrences without
     changing the parser shape
   - applied count-cap logic inside `countScheduleEvents()` itself, so
     `calculateTotalUnits` now respects:
     - total schedule count
     - prior history before the evaluation window
     - the existing external duration window

3. New locked regressions:
   - `nextDueDoses(parseSig("1 tab po every monday"))`
     now yields weekly Monday timestamps as expected
   - `calculateTotalUnits(parseSig("1 drop ou q15min x 8 doses"))`
     now returns `8`
   - `calculateTotalUnits(parseSig("1 tab po q0.5h x3 times"))`
     now returns `3`
   - `calculateTotalUnits(parseSig("1 tab po every monday"))`
     now counts weekly recurrence correctly over a 4-week window

4. Healthy baseline after the fix:
   - anchored event timings
   - time-of-day schedules
   - daily frequency defaults
   - interval schedules
   - count-limited schedules
   - parsed course bounds via `boundsDuration` / `boundsRange`
   - weekly/monthly/yearly cadence with day filters
   - bare weekday recurrence

5. Verification:
   - `npx vitest run test/schedule.spec.ts`
   - `npm run build`
   - `npm test`
   - suite status after audit fix: `545` tests passing

## 2026-04-22 Single-use / event-relative dosing check

Checked whether one-time event-relative instructions are truly supported, using:
- `put in vagina 1 tab after menstruation ends`
- `insert 1 tab pv after menstruation ends`
- `insert 1 tab pv once after menstruation ends`
- `insert 1 tab pv once`

Findings:

1. Event-relative one-time instructions are only partially supported.
   - parse layer does preserve the core administration meaning:
     - dose = `1 tab`
     - route = `Per vagina`
     - site = `vagina`
     - `after menstruation ends` is preserved as `additionalInstruction`
   - but there is no computable timing anchor for `after menstruation ends`
   - current behavior:
     - `nextDueDoses(...)` returns `[]`
     - `calculateTotalUnits(...)` returns `0`

2. `once` currently has the wrong semantics.
   - current parser maps bare `once` through the daily frequency table
   - so:
     - `insert 1 tab pv once`
     - `insert 1 tab pv once after menstruation ends`
     become `frequency=1, period=1 day`
   - current output is therefore wrong:
     - `Insert 1 tablet vaginally once daily...`
     - calculator treats it like a 30-day daily regimen over a 30-day window

3. Honest current status:
   - free-text preservation: yes
   - clinically reasonable formatting: partial
   - true one-time semantics: no
   - due-dose / total-unit calculation for event-relative single use: no

4. Correct long-term shape:
   - `once` should not be hard-mapped to `once daily`
   - one-time administration should be modeled separately from daily cadence
   - event-relative triggers like `after menstruation ends` should remain
     preserved as instruction text unless/until the engine supports external
     event anchors
   - without an actual menstruation-end date, schedule generation cannot be
     honestly computed from `Dosage` alone

## 2026-04-22 `once` / `one time` semantics corrected

Fixed the concrete wrong behavior where bare `once` was being coerced into
`once daily`.

What changed:

1. Parse semantics:
   - bare `once` now becomes a true finite occurrence count:
     - `timing.repeat.count = 1`
   - `one time` also becomes:
     - `timing.repeat.count = 1`
   - explicit daily phrases still stay daily:
     - `once daily`
     - `once a day`
   - explicit finite count paths were preserved:
     - `for 4 times`
     - `x4 doses`

2. Human formatting:
   - `insert 1 tab pv once`
     now formats as:
     - `Insert 1 tablet vaginally once.`
   - not:
     - `Insert 1 tablet vaginally once daily.`
   - event-relative one-time instructions stay finite in wording:
     - `Insert 1 tablet vaginally once. Use after menstruation ends.`

3. Scheduling / calculation boundary:
   - plain one-time schedules now behave as one dose for total-units math
   - `nextDueDoses(...)` now emits a single anchored due time for plain
     one-time schedules without opaque instruction text
   - but event-relative one-time instructions that are only anchored by
     free-text instructions like `after menstruation ends` still do not invent
     fake due timestamps

4. Scope intentionally kept narrow:
   - this pass fixed `once` / `one time`
   - did not globally redefine every bare quantifier (`twice`, `thrice`, etc.)
     into total-count semantics yet
   - the already-good explicit finite-count grammar remains intact

5. Verification:
   - `npx vitest run test/parser.spec.ts test/schedule.spec.ts`
   - `npm run build`
   - `npm test`
   - suite status after the fix: `551` tests passing

## 2026-04-22 Audit follow-up on standalone-count formatting and one-time scheduling

Verified the follow-up audit against the current code after the `once`/`one time`
work and fixed the findings that still applied.

1. Standalone-count formatting guard tightened.
   - `describeStandaloneOccurrenceCount()` and the Thai counterpart now refuse
     to emit standalone `once` / `twice` / `N times` wording when the schedule
     also contains any structured recurrence/detail fields:
     - `dayOfWeek`
     - `when`
     - `timeOfDay`
     - `duration` / `durationMax` / `durationUnit`
     - cadence fields already covered before (`frequency`, `period`, etc.)
   - this prevents suppressing explicit dose-count phrasing on structured
     schedules that are not truly standalone occurrences

2. Count parsing no longer steals cadence phrases.
   - added a cadence-follow-up guard so count parsing skips tokens like:
     - `once daily`
     - `one time daily`
     - `4 times per day`
   - bare `once` still becomes a one-time count
   - explicit finite-count grammar still works:
     - `for 4 times`
     - `x4 doses`

3. One-time scheduling with instruction text changed.
   - the one-time scheduler path no longer suppresses anchored due doses just
     because `patientInstruction` / `additionalInstruction` is present
   - if the dosage is a true one-time repeat and an anchor exists, the anchored
     due time is returned

4. Regression coverage added/updated:
   - one-time `once` schedule now asserts:
     - `count: 1`
     - no cadence fields
   - `once daily` remains cadence, not a one-time count
   - one-time schedules with instruction text now return the anchored due date

5. Verification:
   - `npx vitest run test/parser.spec.ts test/schedule.spec.ts`
   - `npm run build`
   - `npm test`
   - suite status after this audit fix: `552` tests passing

## 2026-04-22 Future shape for event-relative anchors

For sigs like:
- `insert 1 tab pv once after menstruation ends`

the correct future path is not to reuse `orderedAt` as a fake trigger time.

Preferred future design:

1. Preserve the unresolved event-relative instruction in the parsed dosage.

2. Let scheduler/calculation helpers accept an explicit external event anchor,
   e.g. a dedicated option like:
   - `anchorEventTime`
   or better
   - `instructionAnchorTime`
   - `eventAnchorTime`

3. When that explicit event anchor is provided:
   - one-time event-relative regimens can become computable
   - scheduler can emit the anchored due time
   - calculator can count the one actual administration

4. Longer-term richer option:
   - use a map/list of event anchors rather than one scalar timestamp, so
     future cases can disambiguate multiple external triggers
   - after resolution, the concrete time could also be expressed via
     `Timing.event` for downstream FHIR consumers

Short version:
- no fake fallback to `orderedAt`
- yes to explicit external event anchor input when the caller actually knows the
  trigger datetime

## 2026-04-22 Cadence continuation after `once` / `time`

Audit finding was valid.

Problem:
- `hasCadenceContinuationAfter(...)` treated adverbs/units as cadence cues, but
  not the interval lead tokens themselves
- this let count parsing fire first for supported separated-interval forms like:
  - `once every 6 hours`
  - `one time every 8 hours`
  - `once q week`
- result was mixed semantics like `count = 1` plus cadence, which formatted as:
  - `every 6 hours for 1 dose`

Fix:
- treat `EVERY_INTERVAL_TOKENS` (`q`, `every`, `each`) as cadence
  continuations in `hasCadenceContinuationAfter(...)`
- this keeps these forms on the cadence path instead of the finite-count path

Locked with parser regressions for:
- `1 tab po once every 6 hours`
- `1 tab po one time every 8 hours`
- `1 tab po once q week`

## 2026-04-25 Topical `at <site>` overlap fixed at grammar level

Main-branch bug:
- `apply before bed at lesion`
- `apply twice daily at wound`

were parsing the timing correctly but dropping the trailing site because `at`
was being consumed by the generic schedule-anchor production before site
resolution could claim it.

Bad attempted shape:
- hardcoded guard logic in the generic-anchor matcher to make it back off for
  specific topical-site tails

Actual fix:
- added an explicit `site.anchorPhrase` grammar production for overlapping
  anchor tokens (`at` / `on` / `with`)
- placed that production ahead of `schedule.genericAnchor`
- kept the broader grammar order unchanged

Why this is cleaner:
- the overlap is real lexical ambiguity between two productions
- the fix belongs in production precedence, not in a literal lesion/wound check

Verified outputs:
- `apply before bed at lesion` -> `Apply the medication at bedtime to the lesion.`
- `apply twice daily at wound` -> `Apply the medication twice daily to the wound.`

Regression check:
- narrower overlap handling does not regress nearby cases like:
  - `1 drop to OS OD`
  - `apply moisturizer to face every morning`
  - `1 drop to OS q1/4h x4`

## 2026-04-26 PRN ambulatory reason coverage expanded in terminology layer

User-facing gaps:
- `PRN acne`
- anatomy-normalized variants like `abdomen pain`
- several common ambulatory topical / GU / travel reasons were still missing

Fix shape:
- expanded `DEFAULT_PRN_REASON_SOURCE` rather than adding parser-side special
  cases
- kept the solution in the coded terminology dictionary where it belongs

Added coded PRN coverage:
- acne
- eczema / atopic dermatitis
- psoriasis
- hives / urticaria
- cold sore / herpes labialis
- mouth ulcer / aphthous ulcer / canker sore
- dandruff
- scalp itching
- hemorrhoids
- vaginal dryness
- motion sickness
- dry mouth

Alias normalization tightened:
- `abdomen pain` now maps to the existing abdominal-pain concept instead of
  missing just because the adjective/noun form changed

Locked with parser regressions for:
- `apply prn acne`
- `apply prn hives`
- `insert 1 supp pr prn hemorrhoids`
- `1 tab po prn motion sickness`
- `apply prn mouth ulcer`
- `1 tab po prn abdomen pain`
- Thai aliases like `สิว` and `เมารถ`

## 2026-04-26 PRN `symptom at site` now keeps full text and prefers exact combined concepts

Problem shape:
- phrases like `ulcer at mouth` and `pain at abdomen` were grammatically a
  head symptom plus a locative complement
- the old behavior either missed the exact combined concept or collapsed back
  to the generic symptom coding only

Actual fix:
- kept the original PRN text intact for FHIR `asNeededFor.text`
- when PRN parsing sees a trailing locative site phrase, it now derives a
  combined canonical from the parsed structure (`site + symptom-head`) before
  falling back to the bare symptom head
- this stays in the PRN grammar/analysis layer, not in ad hoc lookup hacks

Result:
- `ulcer at mouth` now resolves through the same mouth-ulcer concept as
  `mouth ulcer`
- `pain at abdomen` resolves through the abdominal-pain concept
- generic locative forms like `pain at hands` / `pain at buttock` /
  `pain at anus` keep the full phrase text across parse -> FHIR -> round-trip,
  while still using the generic `Pain` code when no exact combined concept is
  available

## 2026-04-26 Generic `PRN symptom at site` now falls back to SNOMED postcoordination

The user was right to push here: once the parser has already recognized a PRN
head symptom plus a locative site complement, stopping at a generic symptom
code is underspecified.

New fallback:
- if there is no exact pre-coordinated concept for the combined meaning
- and the symptom head plus site both have SNOMED concepts
- emit a compositional grammar expression using `363698007 | Finding site |`

Examples:
- `pain at hands` -> `22253000:363698007=85562004`
- `pain at buttock` -> `22253000:363698007=46862004`
- `pain at anus` -> `22253000:363698007=181262009`
- `irritation at rectum` -> `257553007:363698007=34402009`
- `irritation at vagina` -> `257553007:363698007=76784001`

Still preserved:
- the original phrase remains in `asNeededFor.text`
- exact pre-coordinated concepts still win over postcoordination when available

## 2026-04-26 Site normalization for interior/surface anatomy phrases

The parser was still leaving several common topical/otic site phrases as raw
text, which made the long text sound machine-generated and also blocked more
specific site coding for PRN symptom-at-site phrases.

Fixed with terminology-backed normalization instead of formatter-only hacks:
- `inside ear` now normalizes to the coded `ear` site
- `inside ear canal` now normalizes to coded `ear canal`
- common proper surface/body sub-sites are now bundled too:
  - `back of hand` / `both backs of hands`
  - `palm` / `both palms`
  - `sole of foot` / `both soles`
  - `heel` / `left heel` / `right heel` / `both heels`
  - `back of foot` / `dorsum of foot`
  - `back of head`
- generic itchiness aliases were widened so `itchiness` can participate in the
  existing PRN `symptom + site` grammar and SNOMED postcoordination fallback

Formatting cleanup paired with that:
- `Apply the medication to the inside ear canal.` -> `Apply the medication in
  the ear canal.`
- `Apply the medication to the inside ear.` -> `Apply the medication in the
  ear.`
- unresolved locative site phrases now realize more naturally too:
  - `behind left ear` -> `behind the left ear`
  - `top of head` -> `to the top of the head`

## 2026-04-26 Body-site feature grammar foundation

The old weak point was that anatomical/site handling still lived in three
different places:
- parser normalization
- PRN symptom-at-site coding
- formatter English realization

That kept producing the same pathology over and over: one path knew the site
structure, another only saw a flattened string, and a third had late regex
cleanup bolted on top.

This is now moved onto one shared body-site grammar module:
- `src/body-site-grammar.ts`

It is not a full HPSG parser for the whole sig language yet, but it is an
HPSG-ish typed feature-structure slice for site NPs and locative complements:
- nominal sites
- partitives like `back of hand`, `sole of foot`
- locatives like `behind left ear`

Shared consequences:
- parser site lookup keeps two identities separate:
  - lookup identity for code resolution / custom maps
  - semantic display identity for canonical meaning / realization
- PRN `symptom at site` fallback now reuses the same site analysis
- English site realization no longer relies on the new regex glue that had been
  added in `src/format.ts`
- custom `siteCodeMap` behavior still works because lookup canonical and display
  canonical are no longer conflated

This is the right shape for the larger rewrite too:
- whole-parser migration should generalize this pattern to other clause
  constituents
- dose / schedule / route / method / PRN should become typed feature
  structures with unification-like compatibility rules
- then the central parser can stop depending so heavily on ordered collector
  passes

Also fixed along the way:
- exact abdomen/temple surface forms are stabilized (`abdomen`, `both temples`)
- otic English realization no longer falls back to `via otic`; it now formats
  as `Instill ... in the right ear.`

## 2026-04-26 HPSG implementation reference added

Added:
- `HPSG_IMPLEMENTATION_GUIDE.md`

Purpose:
- give this repo a concrete, implementation-oriented HPSG reference instead of
  relying on memory or vague theory talk
- define whole-parser migration rules:
  - typed feature structures first
  - lexical/construction separation
  - contribution/unification style parser core
  - no new semantic formatter hacks
  - no conflating lookup form, canonical meaning, and realization

Research basis used for the note:
- DELPH-IN formalism and grammar docs
- Grammar Matrix docs
- DELPH-IN grammar scale-up discussion
- HPSG handbook / HPSG synopsis material

## 2026-04-26 Parser-core contribution layer: first whole-parser slice

Started the real parser-core migration away from direct collector mutation.

Added:
- `src/clause-features.ts`

This is the first shared typed contribution layer for clause semantics:
- `method`
- `route`
- `site`
- `schedule`
- warnings
- consumed token indices

Parser core changes in `src/parser.ts`:
- added contribution compatibility checks:
  - `canApplyScheduleContribution(...)`
  - `canApplyClauseContribution(...)`
- added contribution application:
  - `applyScheduleContribution(...)`
  - `applyClauseContribution(...)`
- added feature-terminal dispatch:
  - `applyGrammarFeatureTerminal(...)`
- added descriptor-to-schedule contribution helper:
  - `buildScheduleContributionFromDescriptor(...)`

Migrated first-wave low-risk terminals from direct mutation to typed
contributions:
- schedule:
  - `schedule.bldMeal`
  - `schedule.odTimingAbbreviation`
  - `schedule.timingAbbreviation`
  - `schedule.eventTiming`
  - `schedule.dayOfWeek`
  - `schedule.phraseWordFrequency`
  - `schedule.wordFrequency`
- method:
  - `method.verb`
- site:
  - `site.abbreviation`
- count:
  - `count.singleOccurrence`

Why these first:
- they map cleanly to independent typed schedule/method/site/count
  contributions
- they do not depend on the more entangled interval/count-limit parsers
- they let the parser start behaving like contribution + compatibility merge
  instead of pure mutation order, without destabilizing the harder cadence
  machinery in the same change

Important regression caught/fixed while doing this:
- ophthalmic side abbreviations like `OS` were initially blocked because the
  new site-abbreviation contribution was also trying to force a route
- fixed by matching the old semantics exactly:
  - contribution route only when `state.routeCode` is not already set
- same fix applied to method-verb route contributions

This is not yet full HPSG/unification for the whole parser, but it is the
first actual whole-parser center-of-gravity move:
- collectors can now emit typed semantic contributions
- parser core can accept/reject them by compatibility instead of only mutation
  sequencing
- the next slices should migrate the harder terminals:
  - explicit site phrases
  - route synonyms
  - numeric/separated/compact cadence
  - count limits
  - dose structures

## 2026-04-26 Parser-core contribution layer: second family migration

Pushed a bigger parser-core family migration instead of another isolated
terminal patch.

Moved these clause-grammar families onto typed contributions in `src/parser.ts`:
- route:
  - `route.synonym`
- site:
  - `site.anchorPhrase` (explicit site phrases)
- schedule/count/duration:
  - `count.limit`
  - `schedule.duration`
  - `dose.countBasedFrequency`

This matters because these are not tiny leaf cases:
- route/site phrase resolution is a major ambiguity center
- finite count/duration/cadence structure is one of the main schedule families
- count-based frequency (`once daily`, `3 times per day`, `one time weekly`)
  was still sitting on the old mutation path

Important architectural changes:
- added route refinement semantics instead of treating all route differences as
  flat conflicts
- parser now recognizes that:
  - `Topical -> Per vagina / Per rectum / Ophthalmic / Otic / Nasal`
  - `Oral -> Buccal / Sublingual`
  - `Ophthalmic -> Ocular / Intravitreal`
  are compatible lexical-semantic refinements, not contradictions
- explicit site-phrase contributions can now carry:
  - consumed tokens
  - site token indices
  - site lookup request
  - route upgrades inferred from site semantics

This fixed a real regression uncovered by the rewrite:
- `apply cream to vagina once daily`
- `apply vaginal cream nightly`
had started collapsing back to generic topical route because the new
contribution compatibility layer treated `Topical` vs `Per vagina` as a hard
conflict
- that is now modeled correctly as refinement

Net effect:
- a whole lexical family is now off the old mutation-only path in core clause
  parsing
- route/site/cadence/count/duration now participate in typed compatibility
  checks instead of only collector ordering
- the remaining old center is more clearly concentrated in:
  - separated/compact/numeric interval cadence
  - explicit route/default reconciliation
  - dose/unit structure
  - some post-parse cleanup passes

## 2026-04-26 Clause sign inventory and candidate selection

Addressed the biggest remaining “cheating” point in the parser core:
- even after contribution migration, `parseCoreTerm(...)` was still choosing
  rule families by hardcoded control flow:
  - `parseScheduleTerm -> parseMethodTerm -> parseRouteTerm -> ...`

That is no longer the core dispatch model.

Added:
- `ParserState.clone()` in `src/parser-state.ts`

Parser-core changes in `src/parser.ts`:
- added a declarative `CLAUSE_GRAMMAR_RULES` inventory
- added preview for both:
  - feature rules
  - imperative legacy rules
- rule preview now uses cloned parser state for imperative rules, so candidate
  evaluation does not mutate the live state
- added candidate ranking based on:
  - longest span
  - consumed-token coverage
  - grammar precedence
  - feature/state delta richness
- `parseCoreTerm(...)` now selects the best compatible clause sign candidate
  from the inventory instead of calling category parsers in fixed order

Important consequences:
- rule choice is no longer identical to parser control-flow order
- explicit verb heads can now outrank weaker route inferences on the same token
- lexical refinements like `Topical -> Per vagina` are modeled as compatible
  route refinement, not hard conflict

Real regression uncovered/fixed while doing this:
- `po 10 ml twice daily, drink slowly`
  initially regressed because the candidate scorer preferred a route-like
  analysis of `drink` over the explicit method-verb analysis
- fixed by making grammar precedence outrank raw feature-count after
  span/coverage, which is closer to actual headed lexical analysis

This is materially closer to an HPSG-style parser center because:
- rule inventory is declarative
- candidate evaluation is separate from commitment
- compatibility is feature-based
- live state mutation happens only after candidate selection

Still not “full HPSG” yet:
- no full chart / parse forest
- no true branching ambiguity retention beyond best-candidate commitment
- many higher-order construction families are still implemented by legacy
  procedural matchers

But the center is no longer just a deterministic term-order walker.

## 2026-04-26 Active clause inventory is now feature-only

Pushed the parser center one step further:
- the active `CLAUSE_GRAMMAR_RULES` inventory is now feature-only

What changed:
- introduced `ClauseDoseContribution` in `src/clause-features.ts`
- extended clause contribution application/compatibility to include:
  - dose value
  - dose range
  - unit
- added `buildContributionFromStateDelta(...)`
- added `liftImperativeMatcherToContribution(...)`

Meaning:
- the remaining legacy procedural builders can still exist internally
- but they are no longer active parser-center rules in their raw imperative
  form
- they are lifted into typed clause contributions before the sign inventory sees
  them

This also fixed an important bug in the contribution layer:
- schedule-only PRN probes parse subarrays of tokens
- contribution application was incorrectly assuming `token.index === current
  array position`
- that broke cases like:
  - `1 tab po prn q4-6hr for pain`
- fixed by resolving consumed token identities by token index, not array slot

Architectural consequence:
- the active clause parser now chooses among typed sign contributions only
- legacy matcher procedures are reduced to lower-level construction helpers
  rather than being the active grammar formalism themselves

Still not complete:
- contribution generation for some families is still obtained by lifting state
  deltas from legacy procedures instead of being born directly from fully
  declarative lexical/construction constraints
- that is the next cleanup target if this continues

## 2026-04-26 Removed lifted state-delta rules from the active clause grammar

This is the cleanup the HPSG guide demanded.

What changed:
- removed the active parser-center dependence on:
  - `ParserState.clone()`
  - `buildContributionFromStateDelta(...)`
  - `liftImperativeMatcherToContribution(...)`
  - imperative preview/ranking branches
- removed the dead unused `parseScheduleTerm()` / `parseDoseTerm()`-style
  wrapper path that still referenced imperative terminals
- simplified `ClauseGrammarRule` so the active sign inventory is native
  contribution rules only
- replaced the remaining lifted active families with direct contribution
  constructors for:
  - separated interval cadence
  - time-based schedule
  - numeric cadence
  - compact `q...` interval cadence
  - multiplicative cadence
  - combo event timings
  - meal-anchor sequences
  - custom `when`
  - day ranges
  - dose range / numeric dose / times-dose
  - timing/generic connectors and anchors

Meaning:
- the active parser center no longer previews mutated legacy state to infer
  clause features
- active clause analysis now selects among native typed contributions directly
- remaining old imperative helpers may still exist as lower-level support or
  inactive compatibility code, but they are no longer the active grammar
  formalism used by `parseCoreTerm()`

Verification:
- `npm run build`
- `npm test`
- 566 tests passing

## 2026-04-26 HPSG core substrate is live, but full parser deletion is not done

The latest work moved the live clause terminal path onto typed HPSG signs:

- added [src/hpsg/signature.ts](src/hpsg/signature.ts)
- added [src/hpsg/unification.ts](src/hpsg/unification.ts)
- added [src/hpsg/projection.ts](src/hpsg/projection.ts)
- added [src/hpsg/chart.ts](src/hpsg/chart.ts)
- added [src/hpsg/terminal-adapter.ts](src/hpsg/terminal-adapter.ts)
- added [src/hpsg/method-lexicon.ts](src/hpsg/method-lexicon.ts)

What is now true:

- clause terminals are converted into typed signs before they can affect
  parser state
- compatibility now goes through feature-structure unification, including
  route refinement, site identity, dose identity, and schedule identity
- state mutation is centralized through HPSG sign projection
- the old direct `apply*Contribution` / `canApply*Contribution` procedural path
  was deleted from `clause-grammar-engine.ts`
- the active rule executor now uses an agenda over licensed signs instead of a
  single direct left-to-right mutation loop
- count/cadence ambiguity is constrained structurally:
  `once every 6 hours`, `one time every 8 hours`, and `once q week` now consume
  the frequency marker as part of the cadence construction with no leftover text

What is still not done:

- `parser.ts` still contains the legacy `collect*Contribution` terminal
  inventory
- the HPSG chart parser exists and runs in shadow mode, but is not yet the sole
  clause parser
- PRN reason grammar and additional-instruction grammar are still separate
  token-segment grammars rather than unified HPSG sign families
- the remaining deletion target is to replace each `collect*Contribution`
  family with real HPSG lexical entries and phrase constructions, then remove
  the adapter layer

Live replacement attempt:

- direct projection from the new chart parser was attempted and intentionally
  rolled back to shadow mode after it produced broad regressions
- the regressions were not random; they identified missing HPSG construction
  families:
  - dose-times-frequency constructions such as `1.5 x3`
  - one-time schedule constructions such as bare `once`
  - time-of-day list constructions such as `at 9:00, 22:00`
  - route display phrase spans across all SNOMED route synonyms
  - site/probe constructions including `{mole scalp}` range handling
  - coordinated day/weekend constructions
  - product-form method constructions such as `use shampoo`
- conclusion: projecting the new chart before these families are complete would
  be fake HPSG and worse than the existing behavior

Current measured footprint:

- `src/parser.ts`: 7193 lines
- `src/clause-grammar-engine.ts`: 268 lines
- `src/hpsg/*.ts`: 1871 lines

Real-world probes checked in this pass:

- `apply before bed at lesion`
- `apply twice daily at wound`
- `po 10 ml twice daily, drink slowly`
- `drink 10 ml twice daily, empty stomach`
- `take 10 ml prn dizziness, can cause drowsiness`
- `take 1 tab po prn pain, do not take with alcohol`
- `apply to head prn itchy head`
- `apply to back of hand prn itchiness`
- `apply inside ear canal`
- `apply inside ear`
- `1 tab po once every 6 hours`
- `insert 1 tab pv once after menstruation ends`

Known probe weakness:

- `apply to skin twice daily morning and evening, only at affected areas`
  currently chooses `affected area` as the final site and leaves `to skin , only`
  as leftover. The semantic target should be represented as body site `skin`
  plus a restriction/precondition like "only affected areas" rather than
  overwriting the site.

Verification:

- `npm run build`
- `npm test`
- 566 tests passing

## 2026-04-26 Replaced PRN/advice tail cutoffs with token-segment tail grammar

The user was correct that these functions were not grammar:
- `findPrnReasonSeparator(...)`
- `determinePrnReasonCutoff(...)`
- `findStructuredPrnReasonCommaSeparator(...)`
- `hasLeadingModalAdditionalInstruction(...)`
- `hasInstructionSeparatorBeforeRange(...)`

They were post-hoc placement heuristics over raw strings.

What changed:
- added [src/clause-tail-grammar.ts](src/clause-tail-grammar.ts)
- PRN tail splitting now uses token segments plus structured-instruction
  detection instead of character-offset separator hunting
- additional-instruction collection now parses token segments rather than one
  big raw-text group with ad hoc separator checks

Meaning:
- PRN reason vs instruction/warning tail boundaries now come from token
  segmentation and typed instruction parsing, not substring cutoffs
- this is still not the final HPSG shape, but it removes one of the most
  obviously non-grammar procedural blocks from the live parser path

Measured footprint after this cut:
- `src/parser.ts`: 7205 lines
- `src/clause-tail-grammar.ts`: 193 lines
- `src/clause-grammar-engine.ts`: 429 lines
- `src/clause-timing-lexicon.ts`: 283 lines

Verification:
- `npm run build`
- `npm test`
- 566 tests passing

## 2026-04-26 Pulled the live clause engine and timing lexicon out of parser.ts

The user complaint was correct: even with typed contributions, leaving the
active engine and lexical timing inventory embedded inside `parser.ts` still
was not an HPSG-shaped implementation.

What changed:
- moved live clause rule application / candidate preview / compatibility /
  application into [src/clause-grammar-engine.ts](src/clause-grammar-engine.ts)
- rewired `parseCoreTerm()` so `parser.ts` no longer owns the live candidate
  loop
- moved interval/count/frequency lexical inventory and schedule normalization
  helpers into [src/clause-timing-lexicon.ts](src/clause-timing-lexicon.ts)
  including:
  - interval lead tokens
  - count/frequency lexical sets
  - period normalization
  - duration/count normalization
  - interval/frequency unit mapping

Meaning:
- `parser.ts` is still too large, but less of its size is now active grammar
  engine or lexical timing inventory
- the center is now split into:
  - parser orchestration
  - clause grammar engine
  - timing/count lexicon + normalization
- this is closer to the HPSG requirement that lexicon, constraints, and parser
  control not collapse into one file

Current measured footprint after this extraction:
- `src/parser.ts`: 7378 lines
- `src/clause-grammar-engine.ts`: 429 lines
- `src/clause-timing-lexicon.ts`: 283 lines

Verification:
- `npm run build`
- `npm test`
- 566 tests passing

## 2026-04-26 Removed the legacy clause parser path

The active parser entrypoint has now been cut over to an HPSG-only shape.

What changed:
- replaced the 7k-line `src/parser.ts` body with a 395-line orchestration layer
  that only tokenizes, invokes the HPSG chart parser, and finalizes canonical
  output
- deleted the old ordered agenda/collector layer:
  - `src/clause-grammar-engine.ts`
  - `src/clause-features.ts`
  - `src/segment.ts`
  - `src/hpsg/terminal-adapter.ts`
- moved timing lexical features under `src/hpsg/timing-lexicon.ts`
- moved multi-clause segmentation under `src/hpsg/segmenter.ts`
- added typed HPSG PRN feature support so PRN reason scope and locative site
  information live in the sign structure instead of being only a post-parse
  string tail
- scrubbed parser-facing references to the old contribution/collector/legacy
  vocabulary

Current measured footprint:
- `src/parser.ts`: 395 lines
- `src/hpsg/*.ts`: 2247 lines
- deleted old clause agenda files: 512 lines removed

Important caveat:
- this is the HPSG shape cutover, not restored behavior parity
- rule coverage is now intentionally incomplete until each old supported
  phenomenon is rebuilt as HPSG lexical entries/constructions
- `npm test` was deliberately not used as the target during this step because
  the user explicitly asked to fix shape first, behavior parity second

Verification:
- `npm run build`

## 2026-04-26 PRN coordination moved into HPSG sign structure

The PRN weak point after the HPSG cutover was that a PRN sign still projected a
single lookup request. That meant coordinated reasons and located symptoms could
collapse to one generic reason or leave comma-separated reasons as leftovers.

What changed:
- widened `HpsgPrnFeature` so it can carry multiple reason signs and multiple
  lookup requests
- added a token-level PRN reason grammar for:
  - coordinated reasons: `pain or fever`, `pain, fever`, `pain/fever`
  - located symptoms: `pain at hand`, `itch at foot`
  - coordinated located symptoms: `pain at hand or itch at foot`
  - ellipsis over shared symptom heads: `pain at hands or feet`
  - adjectival located symptoms: `itchy head`
- changed PRN resolution to code each HPSG reason request separately into
  `asNeededFor[]`
- preserved SNOMED postcoordination per reason when the symptom and body site
  both have codes
- made `/` a clause boundary only when it introduces a likely new clause,
  otherwise it can act as a PRN coordinator

Checked smoke cases:
- `1 tab po prn pain, fever` -> two coded `asNeededFor` entries
- `1 tab po prn pain/fever` -> two coded `asNeededFor` entries
- `apply prn pain at hands or itch at feet` -> two postcoordinated coded
  `asNeededFor` entries
- `apply prn pain at hands or feet` -> two postcoordinated coded entries using
  the shared `pain` head
- `apply to head prn itchy head` -> postcoordinated itch-at-head reason
- `take prn dizziness, can cause drowsiness` still stops PRN before the
  instruction tail instead of swallowing it as a reason

Verification:
- `npm run build`
