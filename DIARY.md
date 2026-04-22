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
