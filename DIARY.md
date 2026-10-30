# DIARY

> **PRODUCT CONTRACT — READ FIRST:** [AGENTS.md](AGENTS.md). EZMedInput is a **low-latency, clinician-reviewed medication SIG parser and suggester**, not an autonomous prescriber or exhaustive safety gate. Do not add special-case hard blockers for contrived language, repeatedly validate on the phone hot path, or erase partial clinical meaning. Fix embarrassing errors in ordinary/advertised HPSG semantics; preserve raw/FHIR data; clinicians edit and approve the suggestion. Reviewers must push back on proposals that redefine this product.


## 2026-10-23 — Typed site restrictions and shared production analysis

Implemented generic site-local relative clauses through typed HPSG signs and head-adjunct unification. `apply 1 mL to scalp where there is hair loss` and `apply 1 mL to scalp where affected` retain the coded scalp head, 1 mL, predicate/source ranges and editable text. They do not become PRN, a global clinical condition, or an invented timing schedule. The grammar also handles other sites, existential/state predicates, conjunct predicates, timing neighbors and independently restricted coordinated targets. Neither example has a phrase-specific production or a downstream clinical repair.

The restriction lives on canonical/normalized site data and is projected as a site-local FHIR extension. Multi-site projection and clone/offset operations retain each target's own restriction. Direct R5, strict R5 and R6 round trips preserve it. Native extended-R5 dose/site/timing/condition/safety/expression edits invalidate stale rendered wording through source-provenance reconciliation, without throwing away the original source or introducing a parser refusal gate. An edited component instruction is not substituted for an entire multi-phase course instruction.

Removed the default-only `SiteAtom` target workaround. Boundary ownership now consumes the selected production parse's typed administration-target group and reuses its exact ParserState for final parsing; no separate site-only parser/chart or chart-wide sweep of competing hypotheses is retained. Diagnostic production names and warning prose are not meaning authorities: dose/method/PRN/connector evidence carries its originating lexical category, and schedule evidence carries the fields actually contributed by the sign. Tests deliberately rename diagnostic labels and inject warning strings while requiring identical clinical meaning.

Validation after integration: 45 source suites, **1,986/1,986 tests**, ESM/CJS and TypeScript declarations, and **4/4 compiled entrypoint tests** pass. Independent field oracles and paired corpus/performance checks are recorded separately; no claim of universal correctness follows from test counts. The product remains a permissive, clinician-reviewed suggester with original data retained. Realistic family-neighbor cases take precedence over contrived-input quarantine tests.

Review scope: the topical suite is included because it now contains substantive new clinical oracles. Only two additional suites with import-only R5-helper rewiring are excluded; their test inputs/assertions are unchanged. All production sources and FHIR definitions remain reviewed, with an explicit lockfile exclusion and a total at the 100-file limit. Public README is unchanged.

## 2026-10-23 — CodeRabbit review scope and exact remaining architecture debt

PR #10 had 114 changed files and 108 explicitly reviewable before this change (107 if CodeRabbit's default lockfile exclusion applies). Kept **all 55 production `src/` files, all six `fhir/` StructureDefinitions, and substantive HPSG/clinical oracle suites** eligible. Consolidated three small new related spec files (FHIR timing into `test/r6-primary.spec.ts`; clock bounds and scheduling runtime into `test/schedule-family-audit.spec.ts`) without removing a single test. Excluded six still-executed bulk/adversarial test and corpus-fixture files *from CodeRabbit review only*. Net PR: **112 GitHub paths, 99 explicitly CodeRabbit-reviewable paths** (98 if default lockfile exclusion applies). All 1,866 source tests pass, the ESM/CJS/TS declaration build passes.

**Which remaining non-HPSG semantics are inherited and which were introduced by 0.2:**

- **Inherited from original master:** `src/index.ts` `canMergeTimingOnly()`, `mergeParseResults()`, and `mergeParseResultList()` exist in original pre-0.2. They coalesce compatible dosage clauses for the old public interface. They are FHIR-aware compatibility/IR infrastructure, not invented safety gates. Preserve functioning public behavior; only replace after independent before/after real SIG and phone performance evidence.
- **Introduced in 0.2 (still refactoring debt):** `src/clinical-safety.ts` `applyClinicalConstraints()` still recognizes some maximum-dose/source constraints after FHIR lowering and supplements projected maximum quantity. The upper clinical fact belongs to typed HPSG clinical-quantity/schedule features, then one FHIR lowering. No destructive quarantine should be added.
- **Introduced in 0.2 (still refactoring debt):** `src/regimen/temporal-artifact-ownership.ts` `normalizeTemporalBoundArtifacts()` handles inclusive `up to DATE` and removes procedural graph artifacts already owned by timing. `src/regimen/open-ended.ts` `normalizeOpenEndedSchedule()` similarly reclassifies recognized open-ended dates as starts and removes duplicated event instructions. They currently update canonical/FHIR after lowering; the positive temporal semantics should move into the HPSG/date-bound lexical layer, but do not discard existing date/calendar metadata or turn unsupported dates into no result.
- **Not architecture debt:** `canonicalToFhir()`, `composeRegimenPhases()` assignment of standard FHIR sequence indices, and purely structural persistence/realization are legitimate *projections* of already resolved typed semantics. They do not need to become HPSG grammar.
- **Removed in HPSG cleanup:** `annotateCanonicalClinicalAdjuncts()`, `propagateTrailingSharedSafety()`, `propagateDateTransitionEventTiming()`, and post-decision `candidate-adapter` segment stitching.

The remaining 0.2 helper paths were **not** left because they were deemed desirable; they were deliberately deferred from unrelated shared-scope refactoring to avoid destroying already-correct clinician suggestions, regressions to inclusive/calendar dates, and hot-path latency. They require their own real-SIG oracle tests and typed pre-projection changes, not a blanket deletion or new defensive gates.

## 2026-10-23 — HPSG semantic-ownership debt audit and cleanup

Product contract: clinical SIG **suggester**; no autonomous-prescriber semantics, blanket quarantine, or data loss. Code is HPSG-first with a single downstream FHIR projection.

The team and coordinator removed these genuine semantic repair passes from the PR:
- `annotateCanonicalClinicalAdjuncts()` removed. Medication conditions and calendar exclusions enter typed `clinical-adjunct-sign` lexical rules and the HPSG chart/unification/feature-structure system, including Thai `ยกเว้นกรณี` and a conditional **elliptical phase** (`then BID only if BP >160`). The canonical adjunct is projected once to FHIR. No standalone post-clause guard parsing pass remains.
- `propagateTrailingSharedSafety()` removed. A semicolon-terminal negative action is associated through typed instruction/coordination relations before FHIR lowering.
- `propagateDateTransitionEventTiming()` removed. Sequence edges license transition starts and inherited clocks/events through typed regimen phases, before FHIR.
- Sequenced administration-method inheritance moved out of FHIR mutation to typed canonical clauses.
- Clinical exclusion lists and fronted conditional scope are owned by the HPSG boundary planner *before* boundary decisions; removed `candidate-adapter` post-decision segment stitching.

Preserved the existing represented clinical meaning: full source tests **1866/1866**, built distribution tests **4/4**, and ESM/CJS+TypeScript declaration build pass. An independent 328-SIG baseline differential found one difference: the old parser erroneously treated `Mondays` as an anatomical site in `1 tablet twice daily with food except on Mondays`; dose, food timing, Monday exclusion and cadence were unchanged. No previously correct clinically meaningful fields were lost in that corpus. Cheap grammar cue selection skips constructing unnecessary adjunct signs for ordinary SIGs. Interleaved host performance comparison versus pre-refactor: ordinary BID ~0.97x, independent-eye taper ~1.02x, shared conditional ~1.07x, shared exclusion ~1.09x. The latter cases have some extra HPSG scope cost; monitor on-device, but there is no blanket normal-path validation pass.

**Residual architectural debt — do not hide, and do not 'fix' by deleting functionality:**
1. `applyClinicalConstraints()` in `src/clinical-safety.ts` still recognizes scalar daily/weekly maxima from source text and mutates `fhir.maxDosePerPeriod` after lowering. Move the *recognized maxima* to an HPSG clinical-quantity/schedule feature and lower them once, avoiding double lexical work.
2. `normalizeTemporalBoundArtifacts()` and `normalizeOpenEndedSchedule()` in `src/regimen/regimen.ts` still normalize some canonical/FHIR timing after lowering. Make their existing semantics typed before projection; preserve recurring courses, annotations and source provenance.
3. FHIR-aware coalescing in `mergeParseResults` / `canMergeTimingOnly` remains a compatibility/IR concern. Do not rewrite solely for ideology: first prove concrete ordinary SIG regressions and benchmark mobile cost. The semantics above are already protected by canonical HPSG tests.
4. Pure FHIR serializer helpers and formatting from already-decided clinical meaning are **not** semantic debt.

No extra parser refusal or post-FHIR safety veto is warranted from this audit.

## 2026-10-23 — HPSG-first clinical scope / no downstream FHIR repair

Moved local condition and exclusion recognition onto typed `CanonicalSigClause.clinicalAdjuncts` **before HPSG coordination**. The existing Boolean/clinical-calendar recognizers only supply typed local facts with source evidence; HPSG's licensed coordination construction determines which daughter receives shared condition, excluded dates or excluded weekdays. FHIR now projects those decisions once from the canonical clause. Deleted the old `propagateCoordinatedSharedConstraints()` pass that copied conditions/exclusions/weekday events between already-lowered FHIR dosages and regenerated text. Also moved licensed trailing shared-duration semantics into the typed regimen/coordination layer before projection, removing its FHIR mutation pass.

This is **not** a new strict validator or quarantine: best-effort parsing still retains dose, eye, cadence, original wording and clinician-editable FHIR data. Independent `unless` remains local when HPSG doesn't license wider scope. The provenance of inherited adjuncts records both the lexical fact and HPSG construction. Ordinary R5/R6 projection and public API shape are preserved.

Validation: 1,857/1,857 source tests; 4/4 distribution entry tests (before moving the unchanged duration function into its module); full build green. A 328-input old-vs-new corpus comparison found zero changes to key dosage/site/route/timing/condition/exclusion fields. Interleaved host parse benchmarks showed no meaningful common-path slowdown (ordinary BID 0.967x baseline; independent eye taper 1.016x; shared condition 0.995x; repeated shared-exclusion 0.991x). These are host, not on-device benchmarks.

**Remaining architectural debt, NOT grounds for new safety gates:** `propagateTrailingSharedSafety()` still distributes certain semicolon-trailing negative advice at the FHIR level; `propagateDateTransitionEventTiming()` retains its historical cross-clause projection behavior. If changed, move their *existing* semantics to typed regimen/HPSG scope with ordinary-case equivalence and performance tests. Do not remove useful suggestions or add parser refusal behavior.

## 2026-10-23 — 0.2 permissiveness / no-guard reset

Owner rejected the autonomous-validator direction. Emergency audit removed the PR-era destructive parser quarantine philosophy: partial or ambiguous SIGs must retain useful dose/site/route/timing/source data for clinician review instead of deleting timing/dose or turning parse output into a refusal. Parser/regimen/FHIR interpretation code no longer throws merely because semantic meaning is incomplete.

Implemented during the reset instead of guarding:
- event timing + exact clocks can coexist;
- OD/OS/OU remains ophthalmic in ocular context (for example Apply 1 drop OD BID);
- trailing cadence scopes across disjunctive/coordinated eye doses;
- trailing typed conditions/exclusions scope across coordinated daughters when the HPSG construction licenses a shared adjunct, without a second semantic parse pass;
- only-if owns both guard-lead tokens, so later conditional phases such as OS QID x1mo then BID only if BP >160 segment correctly;
- up to DATE is inclusive;
- Thai attached Buddhist dates and plausible Buddhist YMD years in English SIG text resolve without losing cadence;
- monthly ordinal weekday schedules actually schedule;
- recurring on/off courses actually schedule;
- ranges and incompletely constrained numeric utilities return labelled best-effort/maximum/relative quantities where meaningful instead of fabricating zero or deleting the regimen.

Remaining realistic best-effort/TODO cases — these are NOT reasons to reintroduce parser guards:
1. External event-relative starts such as starting on date of discharge need a caller-supplied/event-resolver anchor before they can be placed on an absolute calendar. Preserve the parsed regimen and source meanwhile. TODO: pluggable event-anchor resolver analogous to condition evaluation.
2. Malformed external FHIR dates/sequences and mathematically impossible absolute quantity requests may still error inside scheduling/supply APIs; those are runtime-data/numeric-contract errors, not parser refusal semantics.

The old medication-unresolved-schedule modifier contract and all active quarantine semantics were removed. Unknown external modifiers remain attached as opaque/editable data. fromFhirDosage computes requested display text without rewriting supplied FHIR source data.

Validation at this checkpoint: source tests 1856/1856, dist 4/4, build green. Final interleaved ABBA microbench: ordinary BID 1.006x baseline, PRN 0.991x, eye taper 0.568x; common-path cost is effectively flat while complex eye-course parsing is materially faster.

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

## 2026-08-22 Thai free-text segmentation and complex instruction parsing

A real-world Thai clinician instruction exposed a lexical-boundary gap rather
than a weakness in the HPSG semantic model. Thai prose without inter-word
spaces reached the grammar as opaque surface blobs, so dose units, cadence,
event timing, and safety instructions could not participate in existing rules.

What changed:
- added locale-aware Thai word segmentation at the lexer boundary using
  `Intl.Segmenter`, while retaining exact source offsets and falling back to the
  previous opaque-token behavior when the runtime lacks a segmenter
- added a canonical locale lexeme layer so stable Thai medication terms feed
  the existing HPSG grammar without translating or discarding unknown prose
- added maximal-munch recomposition of existing Thai clinical dictionary terms
  after segmentation, preserving established aliases such as PRN reasons, body
  sites, weekday groups, and natural dose units
- added a cadence-first HPSG construction for forms such as `วันละ 2 ครั้ง`
  (`daily 2 times`) so the value is a frequency, not a total-count constraint
- made workflow spans stop before explicit structured doses and before a new
  scheduled administration, preventing procedural prose from swallowing dose
  or timing semantics
- preserved workflow text from exact source ranges and allowed explicit
  free-text warning/directive clauses to survive when no safe terminology code
  exists

Regression fixture:
`เขย่าขวดก่อนใช้ เทผลิตภัณฑ์ลงฝ่ามือ 1-2 มิลลิลิตร ผสมน้ำเล็กน้อยถูให้เกิดฟอง ทำความสะอาดบริเวณภายนอกจุดซ่อนเร้น จากนั้นล้างด้วยน้ำสะอาด ใช้วันละ 2 ครั้ง เช้าเย็น (ห้ามสวนล้างช่องคลอด).`

It now yields:
- dose range 1-2 mL
- frequency 2 per 1 day with BID code
- event timings morning + evening
- preserved free-text no-douching instruction
- source-faithful preparation / cleansing patient instruction
- no unparsed-token lint issues

Verification:
- `npm run build`
- `npm test`
- `npm run test:dist`

## 2026-08-22 Procedural instruction semantic graph and bidirectional realization

The Thai free-text pass proved that extracting dose/timing while leaving the
rest as one patientInstruction string was safe but not sufficient. Complex
preparation/application instructions now project into an ordered semantic
graph that is richer than FHIR Dosage while remaining lossless.

Architecture:
- added a canonical `instructionGraph` made of ordered typed action frames
- action frames carry predicate, semantic class, polarity, relation, typed
  arguments, quantities, source spans, and multiple codings
- added the stable package-owned CodeSystem URI
  `urn:ezmedicationinput:CodeSystem:medication-instruction-action`
  and public terminology enumeration/lookup APIs plus a FHIR-shaped CodeSystem
  resource generator
- external terminology is additive: exact SNOMED mappings are attached where
  appropriate; actions without an honest SNOMED equivalent retain the internal
  action code rather than being coerced to a nearby concept
- added a FHIR extension
  `urn:ezmedicationinput:StructureDefinition:medication-instruction-graph`
  so the semantic graph survives Dosage serialization/deserialization while
  standard Dosage.text, patientInstruction and additionalInstruction remain
  conventional interoperable fallbacks
- added Thai and English realization from the same graph
- added realization -> parse action-sequence invariance tests in both languages
- preserved unparsed fragments as ordered opaque source spans; unknown text is
  emitted verbatim instead of silently disappearing or receiving invented
  semantics

Local SNOMED validation used the owner-provided International RF2 snapshot
`SnomedCT_InternationalRF2_PRODUCTION_20260401`. The archive remains local and
is ignored by Git. Confirmed active concepts used by this pass include:
- 731973001 Entire palm (region)
- 76784001 Vagina
- 21397001 Douche of vagina (procedure)
- 782155003 Rinse (administration method)
- 422152000 Wash - dosing instruction imperative (qualifier value)
- 421826007 Mix (qualifier value)

No honest generic SNOMED `pour` action was found in the supplied snapshot, so
`pour` intentionally remains an internal action with its destination separately
coded when possible.

The original torture-test instruction now yields ordered actions:
1. shake(container=bottle, before=use)
2. pour(theme=product, destination=palm[SNOMED 731973001], amount=1-2 mL)
3. mix(substance=water, amount=small)
4. rub(result=foam)
5. clean(site=external intimate area; deliberately not over-coded)
6. rinse(substance=clean water)
7. NOT douche(site=vagina[SNOMED 76784001]), with action mapping SNOMED 21397001

The same stored graph realizes to understandable Thai and English. Existing
workflow semantics were also strengthened for duration (`leave on for 10
minutes then rinse`) and temporal workflow arguments (`rinse in the morning`).
Generic medication advice such as warfarin/grapefruit cautions remains owned by
the existing advice subsystem rather than being duplicated into the procedural
graph.

Verification:
- `npm run build`
- `npm test` -> 640 tests passing
- `npm run test:dist` -> published ESM/CJS graph exports verified
- `git diff --check`

## 2026-08-22 Declarative procedural terminology and conservative leftover enrichment

The procedural semantic graph checkpoint was generalized so expanding the
language/domain vocabulary no longer requires editing imperative parser maps.

What changed:
- moved default procedural actions into `instruction-action-terminology.json`
  and a typed runtime
- default catalog now contains 50 TH/EN action concepts and aliases spanning
  preparation, cleansing, device manipulation, oral/topical workflow, and
  administration verbs
- action matching is longest-first over canonical, spaced source, and contiguous
  source forms, so aliases such as `shake well`, `pat dry`, `draw up`, and Thai
  no-space forms can resolve without ad-hoc parser branches
- added `ParseOptions.instructionActionMap` for caller-owned action concepts,
  aliases, labels, procedural scope, amount capability, and arbitrary coding
  systems
- custom action display/i18n/codings are stored in the semantic graph and FHIR
  extension, so they remain realizable after serialization without requiring
  the original custom map again
- HPSG leftovers are conservatively re-parsed only through explicitly licensed
  procedural terminology; recognized portions become graph actions and all
  remaining text stays opaque/lossless
- existing coded additional-instruction semantics retain human-realization
  precedence, avoiding degradation of mature advice such as “swallow whole; do
  not crush or chew”

Argument semantics were generalized in parallel:
- added package-owned
  `urn:ezmedicationinput:CodeSystem:medication-instruction-concept`
- moved common instruction concepts into declarative terminology: product,
  bottle, water, clean water, small amount, foam, use, event times, and the
  deliberately broad external-intimate-area concept
- added `ParseOptions.instructionConceptMap` for institution/application-owned
  argument vocabulary and arbitrary coding systems
- arguments now retain plural codings while keeping a preferred coding for
  compatibility
- local RF2 2026-04-01 confirmed `11713004 |Water (substance)|`; water therefore
  carries both the package semantic concept and exact SNOMED mapping
- `clean water` is intentionally NOT coerced to potable/sterile/purified water
  because those are stronger claims than the source text

Language improvements:
- Thai `แล้ว`, `แล้วจึง`, and `ต่อมา` normalize to sequence semantics
- English `and then` is treated as sequence glue rather than contaminating the
  prior argument
- Thai `รอยโรค` was added as a body-site alias for the existing SNOMED skin
  lesion concept, preserving natural no-space Thai parsing
- example `เช็ดรอยโรคแล้วรอ 5 นาทีแล้วล้างด้วยน้ำ` now becomes:
  wipe(site=lesion) -> wait(duration=5 min) -> rinse(substance=water), with no
  opaque sequence glue, and realizes cleanly in Thai and English

Custom terminology proof:
- a caller-defined `zap` surface can map to semantic action `phototreat`, Thai
  `ฉายแสง`, and `http://example.org/action|P1`
- a caller-defined `magicgel` can map to a substance concept, Thai `เจลวิเศษ`,
  and `http://example.org/concept|MG`
- both survive FHIR graph-extension round-trip and remain bilingual-realizable

Verification:
- `npm run build`
- `npm test` -> 646 tests passing
- `npm run test:dist` -> 3 published-entrypoint tests passing

## 2026-08-22 Typed instruction relations, coverage, and conditional-vs-PRN disambiguation

The declarative instruction graph was extended from an ordered action list into
a more honest semantic graph with explicit relationships and measurable partial
understanding.

What changed:
- added typed graph relations for THEN, BEFORE, AFTER, DURING/WHILE, UNTIL, IF,
  UNLESS, and WHEN
- relations are serialized through the package FHIR graph extension and their
  source spans are rebased correctly in multi-segment parsing
- added graph semantic coverage:
  - understoodCharacters
  - opaqueCharacters
  - ratio
  - complete
- coverage survives FHIR round-trip; opaque conditional bodies are therefore
  visibly partial rather than silently counted as understood
- added common Thai conditional lexemes: ถ้า, หาก, เมื่อ, ขณะ/ขณะที่, จนกว่า,
  เว้นแต่
- added `stop / stop use / หยุด / หยุดใช้` as a procedural action and modeled
  `use` as its activity argument when present

HPSG ambiguity fixed:
- clause-leading `if/หาก ...` was previously captured by the standalone PRN
  construction even when it introduced a procedural instruction
- the PRN lexical rule now yields when a clause-leading condition is followed
  by an explicitly licensed procedural action
- classic medication shorthand such as `1 tab po if pain` remains PRN

Examples:
- `if irritation occurs stop use` -> relation IF -> stop(activity=use), with the
  condition body retained opaque and coverage ~0.2857 until its condition
  semantics are further modeled
- human realization is `if irritation occurs, stop use`
- `หากระคายเคืองให้หยุดใช้` -> the same IF -> stop(use) structure and natural
  source-language realization
- `เช็ดรอยโรคแล้วรอ 5 นาทีแล้วล้างด้วยน้ำ` remains fully understood with
  complete coverage and explicit THEN relations

Safety hardening:
- whole-clause enrichment no longer prefers a wider span merely because it
  consumes more text; overlapping same-action candidates are selected by
  structured semantic richness (quantity/coding/concept/typed argument)
- canonical dosage method semantics dominate redundant graph actions when the
  graph contributes no additional structured meaning, preventing duplicate
  `swallow`, `shampoo`, or `reapply` text

Verification:
- `npm run build`
- `npm test` -> 649 tests passing
- `npm run test:dist` -> 3 published-entrypoint tests passing

## 2026-08-22 Validated opaque-span semantic resolver seam

The instruction graph now has an optional hybrid semantic-enrichment seam for
opaque text without granting learned/remote systems authority over canonical
medication structure.

Contract:
- `ParseOptions.instructionSemanticResolvers` accepts sync or async proposal
  providers
- each provider receives exactly one deterministic `opaqueSpan` at a time,
  including its absolute source range, locale/context, and a read-only clone of
  the pre-enrichment graph
- resolver action/argument ranges are relative to that opaque source text
- proposals are locally revalidated before graph admission:
  - action must resolve to registered/custom procedural action terminology
  - argument concepts must resolve through instruction concept terminology or
    the dedicated body-site grammar
  - quantities must be finite and use accepted parser units
  - argument ranges must remain inside the proposed action range
  - action ranges must remain inside the supplied opaque span
  - resolver actions cannot overlap deterministic graph actions or one another
- unregistered, malformed, overlapping, or out-of-bounds proposals are ignored
  and source text remains opaque
- accepted actions are marked `origin: semantic-resolver` and may carry a
  separately bounded 0..1 resolver confidence
- origin/confidence survive the FHIR graph-extension round trip
- semantic coverage is recomputed after enrichment; learned confidence is never
  conflated with coverage

Execution behavior:
- synchronous resolvers may be explicitly used with `parseSig`
- Promise-returning resolvers require `parseSigAsync`, matching the package's
  existing sync/async resolver ergonomics
- `parseSigAsync` awaits semantic resolvers after deterministic PRN/site coding
  and before formatting/FHIR projection
- resolver runtime failures fail open: opaque clinician text is preserved and a
  warning is surfaced instead of emitting guessed structure
- deterministic action aliases always win first, so registered literal text
  does not need a model round trip; tests use real paraphrases such as
  `croon a song -> sing` and `murmur quietly -> hum`

This provides a safe neuro-symbolic integration point for local classifiers,
LLMs, or remote clinical NLP without permitting them to overwrite deterministic
dose, timing, route, PRN, or existing structured semantics.

Verification:
- `npm run build`
- focused instruction-graph resolver tests pass
- `npm test` -> 653 tests passing
- `npm run test:dist` -> 3 published-entrypoint tests passing

## 2026-08-22 More formal HPSG attachment, 50-case torture corpus, and performance

A researched 50-case TH/EN medication/product instruction corpus exposed that the
remaining serious errors were primarily scope and attachment errors rather than
missing dictionary entries. Real-label patterns include inhaler priming/rinsing,
mouth-rinse swish/spit warnings, topical clean/dry/apply workflows, vaginal
applicators, eye-drop precautions, patch replacement/disposal, insulin site
rotation, and Thai colloquial action sequences.

HPSG/parser changes:
- replaced repeated all-sign x all-sign chart rescans with an indexed agenda
  keyed by span boundaries
- packed chart identity by semantic state (type + span + SYNSEM), no longer by
  derivational consumed-token bookkeeping; equivalent derivations retain the
  best token coverage/score
- cached immutable chart keys and shared one procedural analysis cache across
  method/site/instruction HPSG rule families
- changed clause projection from one winning constituent to a compatible
  semantic cover, allowing non-overlapping method/dose/site/schedule signs to
  unify across deliberately opaque gaps
- introduced declarative procedural HPSG lexical constructions; they complement
  proven workflow rules rather than replacing them
- separated procedure-local site/route/method arguments from global medication
  site/route/method attachment (e.g. wash hands no longer steals Dosage.site;
  rub in gently no longer implies intranasal route)
- segment boundaries now preserve comma-linked procedural regimens when an
  action sequence continues across punctuation
- broad workflow/advice constituents yield before a new positive administration
  head so preparatory actions can compose with a later APPLY/INSTILL/etc.
- added ordinary number-word dose construction (one drop/packet/applicatorful)
  and canonical-token-aware method classification for Thai
- added typed contextual disambiguation such as Thai ให้ as auxiliary vs GIVE
- action terminology now distinguishes acceptsAmount from definesDose, allowing
  measure/swish/gargle/dissolve/pour and administration actions to promote real
  dose amounts while prime/re-prime counts stay procedure-local

The permanent `real-world-torture.spec.ts` now contains 50 semantic contracts and
passes 50/50. Together with the pre-existing suite this yields 703/703 tests.
The corpus includes explicit forbidden interpretations to catch dangerous false
structure, such as inhaler priming spray counts becoming medication dose or
procedure-local `in` becoming intranasal route.

Performance baseline on the same 50 cases before this pass (HP host, warm, 5000
parses): mean 6.22 ms, p50 3.41 ms, p95 7.52 ms, p99 119.8 ms, ~160.7 parses/s.
An intermediate packed-chart build already reached ~4.54 ms mean / 84 ms p99.
The finalized checked-in benchmark (`npm run bench:torture`, 20 warmup rounds +
100 measured rounds = 5000 parses) reached mean 3.93 ms, p50 3.37 ms, p95
8.32 ms, p99 12.49 ms, and ~254 parses/s. The former pathological topical
workflow dropped from ~99 ms average to ~12.8 ms. This is roughly 37% lower
mean latency, 58% higher throughput, and ~90% lower p99 than the pre-pass
baseline while the grammar became more expressive. The benchmark script is
checked in so future grammar changes can be compared on the same workload
without flaky CI timing assertions.

## 2026-08-22 Formal typed-feature HPSG substrate

Follow-up formalization after the 50-case HPSG/torture checkpoint:

- introduced a real typed feature-structure runtime with:
  - declared type hierarchy and multiple inheritance
  - inherited feature appropriateness constraints
  - required appropriate features
  - general graph unification
  - atom conflict detection
  - reentrancy / token-identity preservation
  - canonical serialization that emits references for shared structure
- declared the sign hierarchy (`sign`, `word-sign`, `phrase-sign`,
  `clause-sign`, lexical sign subtypes) plus typed SYNSEM / HEAD / VALENCE /
  CONT and medication-domain feature types
- every lexical HPSG sign now carries a validated typed feature graph
- phrase combination unifies daughter SYNSEM feature structures into a typed
  clause-sign mother; the existing domain-specific SYNSEM merge remains the
  leaf-value compatibility layer during migration
- chart type matching now follows formal subtype inheritance rather than flat
  string equality / clause-sign special casing
- added dedicated tests for subtype/multiple inheritance, appropriateness,
  general unification conflicts, reentrancy preservation, and existing
  medication sign materialization

Performance:
- naive typed AVM construction/unification initially cost too much: mean 5.76
  ms, p99 31.44 ms, ~174 parses/s on the 50-case benchmark
- structural SYNSEM/sign/mother AVMs are immutable and highly repetitive, so
  memoizing equivalent typed shapes recovered nearly all cost
- final formal-HPSG benchmark: mean 4.06 ms, p50 3.46 ms, p95 8.78 ms, p99
  13.08 ms, ~246 parses/s over 5000 parses
- this is ~3% slower than the immediately preceding non-formal checkpoint but
  still ~35% lower mean latency and ~89% lower p99 than the original baseline

Validation after memoization: 709/709 source tests passing, including all 50
real-world torture contracts and 6 formal typed-feature tests.

Boundary: this is now a genuine typed-feature HPSG substrate, but not yet a
fully declarative DELPH-IN-style grammar. Route refinement, schedule merging,
and several domain leaf constraints still live in specialized TypeScript
unification functions, and the semantic pivot is the medication instruction
graph rather than MRS. Those are the next formalization targets if further HPSG
purity produces measurable product value.

## 2026-08-22 Weird TH/EN safety scope and workflow-head HPSG

A second adversarial pass started from five deliberately awkward Thai clinician
instructions: four-times-daily eye drops with four event times, bedtime drops
with conditional medical advice, 0-2/day symptom-adjusted eye drops, a
wash/leave/rinse topical workflow with a wound warning, and patch application
with a menstrual warning. The same semantic families were expanded into
English, shorthand, Unicode-range, punctuation, separated-range, and TH/EN
code-switched variants.

The failures were mostly scope/attachment rather than missing vocabulary, so the
fixes intentionally moved more structure into HPSG:

- added typed `conditional-sign` and `adjustment-sign` lexical constructions
- separated conditional safety advice from PRN: `if irritation -> consult` and
  `should not use if wound` do not make the medication itself PRN
- added symptom-adjusted administration for `adjust`, `depending`, `according`,
  and safely-resolved `during <symptom> periods`
- added compact, cadence-first, and separated frequency-range constructions,
  including `0-2x/day`, `วันละ 0-2 ครั้ง`, `0 to 2 times per day`, and
  `0 ถึง 2 ครั้ง/วัน`
- prevented a number starting a separated frequency range from also becoming a
  numeric dose lexical sign
- added approximate, Unicode-dash, and separated procedural duration ranges
  (`about 5-10 min`, `5–10 minutes`, `5 to 10 minutes`)
- made the first positive method-capable workflow action the possible HPSG
  workflow head; later wash/rinse actions remain dependent procedure actions
- made generic Apply->topical a defeasible default rather than a lexical fact;
  `apply patch`/Thai `แปะ` is a specific Apply variant with transdermal route
- preserved `แปะ` as the human-facing Thai method while retaining SNOMED Apply
- tightened body-site scope around `during`, `depending`, `not`, punctuation,
  and conditional/directive boundaries
- made workflow argument and action spans source-faithful around punctuation,
  and reconciled opaque spans against richer understood action spans
- stopped instruction-graph relations from inventing THEN across arbitrary
  structured text such as medication schedule material

FHIR `Timing.repeat.frequency` is positiveInt and cannot encode the explicit
lower bound 0. The canonical graph therefore projects frequency=0 through the
package-owned extension
`urn:ezmedicationinput:StructureDefinition:medication-timing-frequency-min`
while `frequencyMax`, period, and periodUnit remain standard FHIR fields. The
extension round-trips through `fromFhirDosage()` and is exported publicly.
Negated graph actions are also projected to standard
`Dosage.additionalInstruction.text` when not already represented, so ordinary
FHIR consumers retain critical warnings even without understanding the rich
instruction-graph extension.

A new 28-case `weird-clinician-cases.json` corpus plus two dedicated FHIR
round-trip tests now contributes 30 tests. Combined with the pre-existing
50-case real-world torture corpus there are 78 adversarial directions spanning
TH/EN/code-switching. Full source validation is 739/739 tests and published
ESM/CJS validation is 3/3.

Performance remained bounded. The original pre-HPSG baseline on the old 50-case
workload was ~6.22 ms mean with ~119.8 ms p99. The formal-HPSG checkpoint was
~4.06 ms mean / 13.08 ms p99. This richer pass varies with host load around
~4.47-4.93 ms mean and ~17.8-20.3 ms p99 on the same 50 cases. The new combined
78-case benchmark measured 3.99 ms mean, 3.41 ms p50, 8.68 ms p95, 16.71 ms
p99, and ~250 parses/s over 7800 measured parses. `bench:torture` preserves the
50-case apples-to-apples workload; `bench:adversarial` runs all 78 cases.

The architecture remains intentionally hybrid rather than claiming total
DELPH-IN-style grammar purity: typed feature structures, subtype constraints,
head/valence attachment, and these new constructions are formal HPSG machinery;
some medication-specific leaf compatibility and semantic assembly remain
specialized TypeScript constraints where that is currently clearer and safer.


## 2026-08-23 Headed HPSG constructions and bidirectional realization

This pass pushed the formal HPSG core and the realization side together instead
of treating generation as a formatter afterthought.

The phrase inventory is now explicit in the live chart rather than collapsing
every successful combination to one generic clause type. Construction subtypes
include headed complement/adjunct/marker structures, coordination,
procedure-sequence/conditional structures, and administration clauses. Phrase
AVMs carry the actual `LEFT_DTR`/`RIGHT_DTR` daughter graphs; headed phrase types
add required `HEAD_DTR` and `NON_HEAD_DTR` features whose values are the real
daughter objects, preserving reentrancy/identity. Appropriateness validates
those features. Parser-time mother validation is incremental because daughters
and SYNSEM have already been validated; the full recursive validator remains
available and is exercised by the formal tests.

Construction typing initially expanded equivalent chart derivations and caused
a substantial latency regression. Chart packing now keys semantically equivalent
phrase construction alternatives under their `phrase-sign` state while retaining
the winning derivation's concrete construction subtype and daughter AVM. The
immutable type system also memoizes subtype, appropriateness, and compatible-type
queries. This keeps the formal structure without paying for every derivational
variant independently.

Conditional procedural programs gained proper scope. A leading condition whose
first governed action is procedural is represented as a nested action program,
so e.g. `if vivid dreams -> remove patch at bedtime -> apply new patch in the
morning` does not leak Apply/transdermal/MORN into the standing global Dosage.
Leading `if pain take...`/`if itchy apply...` still follows the established PRN
administration grammar. Action-local event times survive in the graph.

The instruction graph now records `primaryAdministrationSpan` and persists it in
the package FHIR graph extension. Round-trip-safe realization uses that provenance
to keep pre-administration actions before the canonical dosage and post-actions
behind it. A rich primary event can replace a generic dosage sentence when it
contains meaning FHIR cannot express, such as replacement-patch identity or
`rinse AFTER inhalation`. `THEN` is generated only from an actual graph relation;
warnings no longer become fictitious sequential actions.

`FormatOptions.realizationMode` now has an explicit `roundtrip` contract and is
forwarded through localization callbacks. Same-locale Thai graphs use their exact
source-faithful clinician wording. Pure structured Thai dosage output uses
parser-safe natural forms for event words, PRN wording, and numeric ranges.
Cross-language realization uses the typed semantic graph. Declarative Thai
terminology aliases are consumed directly by the locale lexer, but display/i18n
translations are not parse aliases unless explicitly declared; this preserves
richer compositional readings such as `ถู` + foam-result rather than collapsing
them into a coarse translated Lather label.

Generation is now a permanent semantic regression target:

- 50 English label-style parse -> realize -> reparse cases
- 25 Thai/code-switched same-language cases, including the five new clinician
  torture examples and the original complex wash/mix/lather example
- 12 TH<->EN cross-language cases whose equivalence normalizes only syntax that
  is already represented by typed argument roles/canonical administration truth

The combined generation suite is 87/87. The cross-language fingerprint remains
strict on method/route/site/dose/timing/PRN, coded arguments and quantities,
polarity/modality, real temporal/conditional relations, graph sequence relations,
and opaque information loss. It only ignores language-specific prepositions and
a redundant canonical primary graph action when FHIR already contains that
whole administration fact.

Additional hardening discovered by those corpora includes numeric action/unit
ambiguity (`2 sprays` cannot start a second Spray action), Thai `เข้า` as a real
`into` relation, `ล้างมือหลังใช้` retaining both local hand site and AFTER-use
scope, `ล้างออก` as one Rinse alias, coded `บางๆ` as a real head-adjunct
instruction, and bilingual declarative concepts for nasal spray/inhaler/device
priming and occlusive dressings.

Final validation for this checkpoint is 828/828 source tests across 18 files and
4/4 published ESM/CJS tests. The checked-in performance workloads on the HP host
measured:

- 50-case parser: 4.3956 ms mean, 3.7133 p50, 9.1160 p95, 18.8618 p99,
  ~227.5 parses/s
- 78-case combined parser: 4.0728 ms mean, 3.4333 p50, 8.0788 p95,
  18.8883 p99, ~245.5 parses/s
- 87-case parse -> round-trip-safe realization -> reparse: 11.8255 ms mean,
  6.7607 p50, 43.6639 p95, 53.3277 p99, ~84.6 complete round-trips/s

This is materially more formal HPSG than the previous checkpoint: the parser has
real typed headed constructions and daughter feature structures, not only typed
SYNSEM leaves. It is still intentionally not advertised as a fully declarative
DELPH-IN/ERG grammar because some medication-specific leaf compatibility,
semantic assembly, and terminology defaults remain explicit TypeScript domain
constraints where that is clearer and safer.


## 2026-09-28 — green experimental regimen pipeline

Branch `experiment/explainable-boundary-planner`, continuing `c9fe4fd`; production source remains untouched. Fixed retained whole-phase and totals failures, added typed finite cycle/day-range HPSG construction, shared scheduler primitives and calendar alignment, typed ownership conflict handling, FHIR anchored-bound lowering, and monthly Thai lexical round-trip coverage. Golden matrix 216/216; native and shadow source suites both 1210/1210; planner contracts 104/104; clinical/API/EN+TH round-trip/safety controls 324/324; dist 4/4; both experiment and actual transformed-candidate TypeScript pass. Final strict 30-round benchmark passes all gates. See `experiments/boundary-planner/REPORT.md` and retained JSON evidence. Initial red experiment retained under `results/initial-experiment/`. Not activated, pushed or published. Next authorized step is review/promotion, not another blind boundary exception.


## 2026-09-28 — administration-target phase generalization

Continued the explainable regimen experiment with typed administration-target evidence, target-list ownership, target-set phase transitions, singular FHIR site lowering, licensed method inheritance, and English/Thai open-ended markers. The original right-arm/right-leg case now lowers to one exact right-arm item plus two daily open-ended site items. Final native/shadow suites 1210/1210 each; planner 107/107; clinical/API/round-trip/safety 387/387; dist 4/4; integrated types pass. Final 30-round gates pass: torture +0.7% mean/+1.4% p95; fixed legacy composed ~10.3% mean/~12.1% p95 faster. Production src unchanged; no push/publish/merge.


## 2026-09-28 — administration-target phase generalization

Continuing local `experiment/explainable-boundary-planner`. Added typed administration-target evidence to the shadow regimen grammar: exact-date target changes into recurring target sets form sequence phases; coordinated target lists lower to singular FHIR `Dosage.site` items only at output; pre-coordinated `both eyes` remains singular; disjunctions remain alternatives. Added grammatical English `onward/onwards` and Thai `เป็นต้นไป` markers tied to a date plus real recurrence cadence, and explicit method inheritance across licensed omitted-head target transitions. Independent target cases now cover arm/leg expansion and reduction, right-eye→both-eyes, explicit right-eye+left-eye, wound/scalp, Thai/code-switch and marker-order variants. Anatomical warning text is tested not to become a target. Final checks: native 1210/1210, shadow 1210/1210, boundary contracts 107/107, clinical/API/round-trip/safety 389/389, dist 4/4, both typechecks green, strict 30-round correctness/performance run exit 0. Golden matrix 231/231 candidate vs 140/231 production baseline. Final performance: torture 9.075ms mean / 25.146 p95; composed 6.554 / 12.567; specialty 8.477 / 20.431; all gates pass. Production source remains unchanged; nothing pushed or published.


## 2026-09-28 — lazy temporal-relation hardening

Extended the local experimental regimen pipeline with a typed calendar-bound vocabulary and adversarial lazy clinician surfaces. English now covers after/before/from/since/starting/beginning/as of/as from/prior to/through/till/from DATE on; Thai covers หลัง/หลังจาก/ก่อน/ก่อนถึง/ตั้งแต่/นับตั้งแต่/นับจาก/นับแต่/เริ่ม/ถึง/ต่อไป/เป็นต้นไป, including cadence before/after the bound, dangling และ before cadence, no-space `หลัง22/9`, and fully glued date forms such as `ตั้งแต่22/9/69ไป` and `หลังจาก22/9/69เป็นต้นไป`. The glued-date support is narrowly gated by an already-recognized calendar-date span. Bare bounds without cadence remain incomplete; contradictory end-bound + onward forms are quarantined. Full shadow regression caught `after each bowel movement`; temporal site-boundary logic was tightened to require an actual non-event calendar-date span, preserving workflow semantics. Final checks: native 1210/1210, candidate shadow 1210/1210, boundary contracts 107/107, clinical/adversarial 464/464, dist 4/4, both typechecks green. 75 dedicated lazy temporal checks are retained. Final 30-round performance gates pass: torture 8.412ms mean /23.848 p95 vs baseline 8.312/23.548; composed 6.331/12.453 vs 7.104/14.473; specialty 8.467/20.171 vs 10.059/24.616. Production source remains unchanged; nothing pushed or published.


## 2026-09-28 — residual shorthand and temporal ownership

Completed the lazy temporal-bound audit on the local experimental branch. Added clear shorthand synonyms: English commence/commencing, effective/effective from, prior/prior to, forward; Thai มีผลตั้งแต่, เริ่มใช้, and optional วัน/วันที่ forms. Added a narrowly bounded Thai date-token splitter that only cuts Thai/digit attachment at numeric boundaries inside an already-recognized calendar-date span, allowing forms like ตั้งแต่22/9/69ไป and หลังจาก22/9/69เป็นต้นไป without globally changing Thai tokenization. Generalized temporal ownership so non-event date-bound spans remove competing procedural instruction-graph actions; this fixes stale Thai realization such as เริ่มใช้22/9/69. Ambiguous `up to DATE` is now quarantined as non-executable instead of guessed. Final acceptance: 477/477, including 88 dedicated lazy-temporal checks; native 1210/1210, shadow 1210/1210, boundary contracts 107/107, dist 4/4, both typechecks green. Final 30-round gates pass: torture 8.655ms mean /24.077 p95 vs 8.395/23.608 baseline; composed 6.828/13.153 vs 7.443/14.791; specialty 8.640/20.255 vs 9.993/24.546. Production source remains unchanged; nothing pushed or published.


## 2026-09-28 — PR #9 CodeRabbit audit pass

Verified four substantive CodeRabbit findings against the experiment and fixed all four: normalized Vite module IDs before platform-specific source-path comparison; prevented BoundaryRelation entries from referencing empty/nonexistent predecessor or successor segments (leading `/` reproduced `from:-1` before the fix); preserved lint issues when target recognition does not actually expand the result; and regenerated the misleading stale `validation-latest.json`. Added four focused contract regressions, raising boundary contracts from 107 to 111. Post-review validation: contracts 111/111, clinical/adversarial 477/477, native 1210/1210, candidate shadow 1210/1210, dist 4/4, both typechecks green, strict correctness and 30-round performance gates green. Final fingerprint `2c21b6c2b39e3e85e9025f35709f5df8a4c507f13cc6b668ec31d1d804bb577b`. Production `src/` remains unchanged; package dry-run still contains no experiment files. Docstring-coverage warning intentionally not gamed with low-value comments.


## 2026-09-28 — PR #9 second CodeRabbit audit pass

Verified three new CodeRabbit findings and fixed all three. Finite-cycle validation now preserves the first specific error with nullish assignment, so an invalid day range is not overwritten by a later missing-anchor error. Alternative-target warnings are deduplicated on both ParseResult and canonical clauses across repeated non-expanding passes. The generated integration-typecheck mirror is deleted before every copy; this was validated by planting an intentionally invalid stale TypeScript file and confirming the typecheck removed it before compilation. Added two focused permanent contract regressions, raising boundary contracts from 111 to 113. Post-fix validation: contracts 113/113, clinical/adversarial 477/477, native 1210/1210, shadow 1210/1210, dist 4/4, both typechecks green, strict correctness and 30-round performance gates green. Final fingerprint `428903cb46f631b6c156c84e40161c6bf8bd19032405d46fa09e5c112387cfc1`. Production `src/` remains unchanged; package dry-run includes no experiment files.

## 2026-10-21 — PR #10 CodeRabbit follow-up

- Multi-clause ordinary R5-compatible directions now generate short/long display text from structured dosage rather than repeating the original shorthand. Rich R6 stages/conditions keep the exact clinician instruction because flattening them could silently omit treatment information. The display safety rule is shared with formatSig instead of being copied or invoking exceptions on normal paths.
- Whole-course roundToMultiple is applied once before container counts. The single-dosage path now also reports the exact container-unit quantity when dose and container share that unit.
- Thai ยกเว้นกรณี (unless) is no longer mistaken for a calendar exclusion; the real negated condition is retained. Infusion mcg/µg/μg is serialized with UCUM code ug. The R6 Boolean-condition extension declares URL-discriminated slicing, and the regression benchmark rebuilds before reading dist.
- Added focused regressions. Full source tests pass 1305/1305 across 41 files; ESM/CJS build and dist exports 4/4 pass. Short R6 benchmark command runs. No package publication or merge.

## 2026-10-21 — PR #10 further CodeRabbit rounding and supply parity

- Verified the new review issue: whole-course roundToMultiple updated totalUnits before container math but left estimated volume and active-ingredient amount at the unrounded stage totals. This undercounted bottles and was inconsistent with the single-dosage path. Course rounding now scales estimated usage to the rounded dispensed supply and derives the ingredient quantity from the updated estimate and product strength. Existing dosage stages/schedule remain untouched; there is no repeated parser call.
- Found and fixed adjacent fractional-package parity bug: one half-bottle dosage returned 60 mL requested from a 120 mL package, but the same dosage as a one-item course returned 120 mL despite the same single physical container. Course totalContainerQuantity now reflects requested amount, not full package capacity, matching the single-dose path.
- Added regressions for eye drops crossing bottle boundaries (with ingredient strength), parallel-course rounding, all four supported course representations and fractional package units. Full 1308/1308 source tests across 41 files pass; dist tests 4/4, CJS+ESM builds pass. No version/publish/merge.


## 2026-10-23 — 0.2 permissiveness reset: parser/suggester, not gatekeeper

Owner rejected the 0.2 quarantine/refusal direction. The parser is clinician-reviewed best effort: partial understanding must preserve useful dose, route, site, timing, source, FHIR metadata and editability instead of deleting fields or refusing the suggestion. Exact scheduling/supply may label assumptions or maximum/relative quantities when facts are incomplete, but parser uncertainty is not grounds for blanking the interpretation.

Emergency rewrite completed:
- destructive parser-level schedule/dose quarantine removed; unresolved fragments are warnings/source evidence only
- event timing and exact clock timing may coexist
- cadence/clock conflicts retain the best parsed suggestion for clinician correction
- disjunctive alternatives retain typed daughters and shared trailing cadence rather than losing timing
- OD in ophthalmic context (including generic verbs such as Apply) resolves as right eye without suppressing BID/QID cadence
- inclusive "up to/through DATE" bounds retained; Thai Buddhist attached date forms resolve correctly
- monthly ordinal weekday schedules are implemented rather than rejected
- recurring on/off courses are represented and scheduled rather than quarantined
- frequency/period ranges and incomplete numeric constraints produce useful best-effort or labelled maximum quantities where calculable
- weight-based quantities remain relative (e.g. mg/kg, ug/kg) without patient weight and become absolute when weight is supplied
- unknown/malformed R5/R6 metadata remains attached and editable; live edited fields beat stale rendered text while original snapshots remain provenance
- unbounded sequential transitions schedule only the known prefix; they do not run later phases concurrently
- old tests whose sole oracle was "throw", "timing undefined", or "quarantine" were replaced with clinical meaning/data-preservation oracles

Validation on the combined rewrite: build/type declarations pass; 1848/1848 source tests and 4/4 dist tests pass. A 353-case old-vs-new corpus inspection found apparent shape losses were corrections of old misparses (e.g. interval represented as frequency, infusion rates represented as scalar doses, dates interpreted as body sites, OD/BID interpreted as topical once-daily). Interleaved 353-case throughput benchmark is effectively flat vs old master (~0.99x new/old median time); ordinary simple and PRN paths are flat/slightly faster, multi-eye taper materially faster. A mixed event+clock case is slower only because old master aborted/quarantined it while current code actually parses and realizes both meanings.


## 2026-10-23 — structured equality and zero avoidable JSON churn

Removed JSON serialization from in-memory cloning, typed feature equality,
schedule/method comparison, chart packing, and FHIR projection comparison.
The structured comparator ignores object insertion order and absent optional
undefined fields, while preserving array order and scalar distinctions. Chart
packing uses compact candidate hashes with mandatory structural collision checks;
hash equality alone never discards a sign. Editable copies retain unknown nested
FHIR fields without serializing and parsing them. Removed thirteen throwaway
projection stringify/parse chains and the normalization-copy comparison helper.

The twelve remaining production JSON.stringify calls encode existing FHIR string
payloads/provenance or export diagnostic feature graphs. The condition bridge's
unknown-condition textual fallback remains lossless. Added a source-level test
confining serialization to those named boundary/export functions, plus regressions
for reordered feature atoms, explicit undefined edits, collision handling, editable
copy isolation, ordinary clause parsing without JSON, and R5/R6 edit preservation.

Consolidated the added candidate-adapter wrapper into its production planner,
removed its write-only global stats module, and moved single-consumer clock
normalization into FHIR lowering. No new production exclusions: 115 raw changed
paths, exactly 100 reviewable paths against master 0d096a4. The standalone
body-site qualifier API/whole-SIG ownership follow-up is not silently redefined
by this data-representation cleanup.

Validation: 1996/1996 source tests, built ESM/CJS exports 4/4, both bundles and
TypeScript declarations pass. Independent 39/39 clinical oracles pass; 181-case
comparison against the frozen pre-cleanup build has zero changes across 10889
compared fields. Balanced host measurements are broadly flat with case-specific
variation: common BID 1.3158->1.3233 ms; eye taper 4.1819->3.8195 ms. A larger
conjunction recheck measured 3.0969->3.1418 ms and the configured-map variant
3.2878->3.3774 ms. These are host results, not a universal or mobile speedup claim.
No push, merge, version change, or package publication.


## 2026-10-23 — structured FHIR extensions and shared semantic ownership

Owner rejected JSON-inside-valueString for R6-in-R5 and source preservation.
The bridge now uses named extension children for courses/steps/components,
conditions, safety, expressions and relative timing, with native FHIR value[x]
datatypes. Unknown FHIR extensions retain their complete original structures;
future native properties retain typed field/item/value children rather than an
opaque string. R6's approximate quantity comparator is represented separately
from its R5 Quantity instead of emitting an invalid native R5 comparator.

Primary and strict-R5 edit provenance now share one writer: repeated row children
with primitive structural/text fingerprints. No fingerprint lists, complete
projection snapshots, source objects or condition trees are serialized to JSON.
Simple R6 measurements/states use their native condition fields only; complex
Boolean trees use explicit all/any/not operand extensions. Diagnostic feature
graphs also return structured objects with reference identities. Production
source contains ZERO JSON.stringify and ZERO JSON.parse calls; the permanent
source audit and a parse/export/import/edit/format test enforce that boundary.

This intentionally replaces the unreleased development JSON bridge format.
Older JSON-shaped metadata is retained unchanged as source, not interpreted as
a current structured bridge. No deployed consumer/dependency was modified and
no package version, publication, push or merge is included in this checkpoint.

Site semantics now have one predicate interpreter, one typed restriction
constructor and one English/Thai realization implementation. Standalone anatomy
lookup remains useful; full-SIG HPSG lexical rules use anatomy-only lookup so
relative clauses cannot be independently reinterpreted inside lexical sites.
The existing qualifier view derives from the shared predicate. Full-SIG source
spans remain exact; normalized standalone phrases do not invent original offsets.

Sync, async and lint share regimen/scope/timing assembly; sync and async also
share result lowering without forcing Promise overhead onto synchronous calls.
Course markers are constructed directly, not by exporting and discarding full
R5 arrays. Read-only formatting projects components directly without creating
persisted metadata. Row copies remain independently editable; the first owner
reuses the already-detached marker while later owners receive detached copies.

Three added single-purpose modules were consolidated into their proper existing
owners (temporal vocabulary into the lexical registry, clinical quantity lowering
into FHIR). This offsets the typed bridge, anatomical-owner change, and grouped
source-metadata definitions: 115 raw paths / exactly 100 CodeRabbit-reviewable
paths; no new exclusions and no test-oracle deletion.

Validation: 2009/2009 source tests green, built ESM/CJS exports 4/4, both builds
and declarations pass. Independent clinical oracles 39/39. In the 181-case,
10889-field pre/post comparison, 180 cases are unchanged and one has exactly
three removed redundant JSON-condition-extension fields; its native BP >160
meaning is unchanged. Typed-extension, unknown metadata, edit isolation, source
span, and sync/async regressions are permanent. Nine StructureDefinitions were
updated/added; IDs, canonical roots and extension value-versus-child shape are
checked, but no external HL7 validator/conformance certification is claimed.

Balanced HP-host measurements: BID 1.3360->1.2954 ms, PRN 2.2592->2.1953 ms,
ordinary conjunction 3.0031->2.9668 ms, custom two-sites 11.4572->10.9741 ms.
Eye taper 3.8878->4.0404 ms (+3.9%); scalp relative cases +1.8%/+2.3%.
The earlier pre-copy-optimization eye recheck was +6.1%; it is retained in the
report rather than hidden. No universal or phone-performance claim. Full timing
run preceded only the standalone normalized-offset metadata omission; clinical
parity and final source tests cover the finished source.

Evidence is in /tmp/ezmed-structured-extensions-20261023/RESULT.json and its
referenced test/comparison reports. The original untracked probe remains untouched.


## 2026-10-24 — compositional clinical completion and explicit alternatives

Integrated the shared clinical grammar, action/realization, and FHIR editing
work on the 0.2 branch. This is a verified local implementation checkpoint,
not a claim that arbitrary clinical prose is completely understood or that the
entire implementation is a pure HPSG chart. The chart remains the typed clause
owner, with existing procedural-action, boundary/regimen, and realization
components still part of the architecture.

Concrete corrections now have permanent independent clinical assertions in
existing test files: word/numeric loading-to-maintenance counts; divided
weight-based doses; active drug versus named infusion carrier volume/rate and
FOR/OVER administration duration; event-local before/after offsets; midnight
dependent eye administration with counted pronoun ellipsis; typed source-backed
mixing materials even without known terminology; negated coordinated actions;
shared-referent SNOMED entailment; whole/entire as manner/site extent rather than
an invented dose of one; clinical Boolean all/any conditions and otherwise
hold-follow-up; non-calendar stopping instructions; exclusions; qualified sites;
and thick/thin topical semantics without fabrication.

A typed alternative edge now survives R5/R6 as a must-understand
medication-alternative-choice modifier with groupId, branchId and exactly-one
selectionBehavior. It is NOT a native concurrent R6 component interpretation.
Every alternative remains editable and both source branches survive conversion.
formatSig renders Choose one / or (or Thai equivalents). Scheduling and numeric
supply require explicit `alternativeChoices: { "choice-1": "branch-1" }`, using
ids returned by getDosageAlternativeChoice. Without a choice the execution API
reports the available group/branch ids rather than executing both; this does
not block parse, suggest, format, import or editing. Two alternative tablet
courses produce three OR six tablets over three days, not nine. Branch identity
survives array reordering and repeated strict R5/R6 save/reload. Clearing an
obsolete condition or BodyStructure reference and replacing an expression-based
dose cannot reactivate the previous executable meaning from retained provenance.

The named-infusion carrier is source-backed and uncoded unless external
terminology has actually resolved it. The existing FHIR projection retains the
material and local source span in a typed extension; canonical global source
spans are rebased separately. Generated StructureDefinition builders for this
extension and alternative choices are exported from the package entry point.
They are draft profiles: no external HL7 validator/conformance certification
has been run. No production application deployment or mobile performance claim.

Review hygiene: consolidated new single-consumer modules into their true owners
instead of hiding more paths (evidence into planner, typed bridge into course,
site-target projection into HPSG projection, shared temporal lexical code).
Entire PR is 115 changed paths minus the same 15 existing CodeRabbit exclusions
= exactly 100 reviewable files. All new clinical oracles are in existing files.
Production source contains no JSON.stringify/JSON.parse. Temporary diagnostic
logging is removed; the original untracked semantic probe is not committed.

Frozen gate at 10:27 Bangkok: 2252/2252 source tests across 45 suites, 4/4
built-package tests, ESM/CJS and TypeScript declarations pass. git diff --check
passes. One old test asserting swallowed-whole SNOMED from ONLY a prohibition
of crushing/chewing was replaced with stronger no-false-code/both-negations
assertions. OR-corpus scheduling checks now assert required branch selection
and test every selectable branch rather than silently executing both options.
No original clinical assertions were merely skipped to manufacture green.

An unchanged independent 43-case adversarial replay completed without throws,
but it is NOT 43/43 clinical correctness. Several deliberately broad/underspecified
programs remain imperfect: sparse cycle-day dosing with day-local guards,
some Thai taper/counseling constructions, complex contrary instructions, and
some auxiliary object/condition realization. Original source remains available;
these are not reasons to turn this clinician-operated suggester into a refusal
engine or to claim automatic prescribing safety. A separate older counseling
branch has additional semantics worth reconciling later, not blindly cherry-picking.

Interleaved warmed HP-host benchmark against frozen 5838312 dist (milliseconds
per parse, median of seven alternating rounds; not phone measurements): ordinary
BID 1.718 -> 1.745 (+1.6%); site relative 2.932 -> 3.107 (+6.0%); eye taper
6.364 -> 7.052 (+10.8%); loading 2.712 -> 2.798 (+3.2%); coordinated negation
5.891 -> 6.653 (+12.9%); procedure 3.286 -> 3.478 (+5.8%); compound guard
4.226 -> 6.604 (+56.3%); now-correct event alternative 6.043 -> 3.083 (-49.0%).
The compound-guard overhead is explicitly under investigation rather than
concealed behind the mostly stable ordinary case.

Local evidence: /tmp/ezmed-adversarial-semantics-final-20261024.json and
/tmp/ezmed-final-performance-20261024.json on the development host. No package
version change, publication, push, or merge in this checkpoint.


### 10:38 follow-up: condition constituent ownership and final checkpoint gates

Profiling located the compound-guard cost in redundant boundary HPSG probes at
the AND/OR inside an already recognized typed measurement guard. The production
planner now uses the SAME parseMedicationGuard constituent's exact span to own
that internal connective, with no extra recognizer invocation for ordinary
inputs without boundary candidates. It does not suppress independent regimen
alternatives outside the guard. Three permanent tests assert correct all/any,
no PRN, original dose/cadence, and zero redundant boundary clause probes.
Full source is now **2255/2255 across 45 suites**, ESM/CJS/declarations and
built-package **4/4** pass; exact review count remains100.

Identical interleaved warmed benchmark after this correction (same frozen
5838312 baseline; separate process/run, host-only): BID1.723->1.729ms(+0.3%),
site-relative3.042->3.034(-0.3%), eye-taper6.744->7.089(+5.1%),
loading2.749->2.880(+4.7%), negation6.195->6.396(+3.2%),
procedure3.165->3.450(+9.0%), compound guard4.173->3.643(-12.7%),
event alternatives5.961->3.169(-46.8%). This resolves the measured avoidable
compound-guard regression; it is not a claim that every case is faster or that
mobile behavior has been benchmarked. Both pre/post optimization reports are
retained under /tmp/ezmed-final-performance[-optimized]-20261024.json.


### 2026-10-24 14:26 — scoped conditions, counseling recovery and integrated checkpoint

Recovered the October 17 counseling semantics through the current typed
pipeline instead of importing its superseded parser: auxiliary hydration,
relative medication-event timing, and source-backed course completion remain
separate from the prescribed dose. Integrated the collaborators' qualified-site
localization, procedural material/manner preservation, and English/Thai
negation fixes. A semicolon, full stop or THEN closes the prior prohibition;
a later AND cannot reverse independently affirmative actions. Malformed cycle
day ordinals retain typed unresolved source and cannot overwrite an explicit
0.5-tablet (or other unit-bearing) dose.

Conditional withholding is an explicit lexical argument-grammar effect, not a
match on arbitrary action names or a blanket interpretation of `retain`.
Affirmative HOLD/OMIT/SKIP/WITHHOLD and a newly configured DEFER verb compose
through the same HPSG rule. Negative withholding and physical holding do not
become medication guards. Prefix and postfix IF share the same typed effect;
nominal morning/evening/all/both targets bind to the related regimen daughters
before FHIR lowering. R5/R6 preserve the condition and scheduling evaluates the
selected dose only. An unbound reference remains source-backed and reviewable
rather than becoming an executable predicate on the wrong administration.
The existing numeric comparison grammar now supplies both guard recognition
and measurement operators, retaining the original text while normalizing the
copula. Its source range owns 'no more than' as a comparison, not a dosage cap.

Frozen source snapshot at 14:21 was verified unchanged after all validation:
- canonical npm test: 45 suites, 2450/2450 passed;
- npm run test:dist: ESM/CJS, TypeScript declarations and 4/4 exports passed;
- git diff --check clean; no JSON.stringify/JSON.parse under src;
- 115 changed paths minus the existing 15 review exclusions = 100 reviewed.
The unrelated pre-existing untracked test/__tmp_open_semantic_probe.ts remains
outside the staged path set. No version change, publication, merge or push.

Independent compatibility smoke compared 521 literal examples extracted from
origin/master 0.1.67 tests with current source. It reported no new throws, lost
previously populated clinical fields or lost administration rows. Ten changed
results were reviewed, predominantly additional inherited method coding and
more explicit coordinated targets. One shared-timing inheritance case remains
a follow-up. This is not certification of all deployed 0.1.x versions or APIs.

Latest interleaved HP-host benchmark against frozen 779a8bc, 18 clinical cases,
3 warmups and 11 measured rounds: simple BID 3.82->3.81ms, routine oral
5.46->5.62ms, Thai taper 19.17->12.27ms. More complex supported paths cost more:
scoped insulin 12.63->16.50ms, Thai negated procedure 3.14->4.68ms, outcome/stop
counseling 8.21->12.49ms. These absolute/relative regressions are recorded,
not hidden by the green suite. Measurements are host-only, not mobile evidence.

Release scope is a clinician-reviewed suggester, not universal clinical NLP.
Unsupported clauses may remain explicit editable advice/source without invented
coding, dose, timing or opposite directives. No symptom-outcome evaluator or
arbitrary discourse expansion is required for this checkpoint. Remaining
architecture follow-up: event-timing ellipsis still inspects lexical provenance
rule names and reconstructs event expressions outside the primary chart;
replace that with typed event features in a focused change, without weakening
its existing functional tests. External HL7 profile validation and remote
CodeRabbit review have not been performed for this local checkpoint.


### 2026-10-24 15:29 — bounded final clinical rendering and infusion corrections

Completed a focused three-worker cleanup with coordinator integration against
fb860f2. This is a local implementation checkpoint, not a new release or a
claim of universal clinical-language understanding.

- Qualified Thai prohibition targets retain the complete bruised-site or
  open-wound restriction. The existing site-relative lexical ambiguity and
  BodySiteRestriction machinery supply typed arguments and bilingual wording;
  an unknown relative qualifier stays one complete source-backed argument.
  A noun between a primary administration head and its matching amount no
  longer becomes an invented later procedure. Raw source and editable leftovers
  remain available; this does not introduce medication-name recognition.
- An exact volume-over-elapsed-time constituent can be selected by an omitted
  inherited administration head in a later infusion stage. The 50 mL/30 min
  then 25 mL/60 min case now retains two per-administration durations and rate
  ratios through R5/R6. Separately owned course duration remains independent.
  A coordinator review corrected optional schedule-field ownership handling;
  dedicated projection oracles distinguish absent evidence from a true course.
- Noncalendar course-end instructions retain lexical source provenance and
  their position before subsequent actions. Formatting cannot replace complete
  editable advice merely because a graph covers its source text. English and
  Thai save/reload preserve order without duplicating the conditional phrase
  or appending a redundant standalone stopping instruction. No automatic
  symptom-end evaluator or synthetic executable condition was added.

Twenty-one permanent tests were added in four existing test files, including
independent intended clinical oracles, nearby ordinary controls, and public
R5/R6 formatting/reload checks. No original assertions were removed or weakened.
Final Node 22 validation after the last localization correction:
45 source suites, 2471/2471 tests PASS; ESM/CJS build, TypeScript declarations,
and 4/4 packaged export tests PASS. Source/test snapshot drift is checked
before commit. Runtime source still has zero JSON.parse/JSON.stringify calls;
whitespace checks pass. Whole PR remains 115 raw paths minus the same 15
existing exclusions = exactly 100 CodeRabbit-reviewable paths. No new excluded
files or test paths. The old untracked diagnostic probe remains uncommitted.

Paired warmed host benchmark versus the original fb860f2 bundle (Node 22,
9 alternating rounds of 20 parses; milliseconds per parse):
- simple BID: 1.463 -> 1.481 (+1.2%).
- Thai prohibition: 17.793 -> 16.911 (-5.0%).
- topical prohibition: 11.243 -> 11.765 (+4.6%).
- sequential infusion: 9.242 -> 8.418 (-8.9%).
- course counseling: 14.789 -> 15.989 (+8.1%).
- independent eyes: 8.035 -> 8.006 (-0.4%).
These are host-only measurements, not mobile latency evidence. The counseling
case's approximately 1.2 ms overhead is recorded rather than hidden behind the
green tests. Unsupported advice is retained verbatim; some cross-language
output, including compound site wording, remains mixed-language rather than
being claimed fully translated. Unanchored multi-stage execution utilities
still require suitable phase anchors; both editable stages remain in the
parser/FHIR outputs. No unrelated scheduling or broad grammar redesign was
included. External HL7 validation and remote review are not claimed.

Local evidence: /tmp/ezmed-finalfix-freeze-20261024.json,
/tmp/ezmed-finalfix-perf-20261024.json, and the three final worker handoffs.
No package version change, push, merge, publication, or consumer deployment.


### 2026-10-24 16:49 +0700 — evidence-backed Thai locale realization through FHIR and typed sites

This bounded completion repairs the prior local checkpoint 5b4d897 without new
clinical execution semantics. Two read-only GPT-5.6 Sol / xhigh auditors independently
confirmed the failure classes and posted to the existing shared BB.

The HPSG already composed Thai abdomen-or-thigh and preserved anatomical OR,
but default FHIR Dosage.site omitted the composed primitive translation when
no parse locale was requested. The standard FHIR _text translation is now kept
for typed site coordination by default, including strict R5 and R6 reload.
The body-site lexicon gained properly localized arm/forearm/leg bilateral and
laterality entries, allowing existing typed site coordination to distinguish
either arm OR leg (one site choice, not simultaneous administrations), both
arms AND legs (two separately coded site targets), and left forearm AND right
calf (right calf kept deliberately **uncoded**, never equated to lower leg).
The original clinical quantity, timings, and exact source remain intact.

The Thai instruction renderer now falls back atomically to the complete
source action only when a **nominal Object/Theme remains genuinely opaque**
to existing argument localization; it does not splice a Thai verb onto an
English opaque complement (e.g. 'rotate which site each night'). Typed
quantity/manner/time/activity terms still translate normally. An initially
overbroad fallback caused five real regressions in swallow-whole, chew, and
tablet-manner cases; it was narrowed and all original controls recovered.

Typed source-evidenced or coded clinical advice, such as 'until itching
resolves', now retains its proper Thai translation through default FHIR
additionalInstruction._text and strict round-trips. Unstructured free-form
advice does not acquire a fabricated incomplete Thai translation extension,
so 'use caution in storms' keeps its old exact text-only shape. The expression
'stop unless rash returns' remains a complete editable unstructured English
clause, not an invented executable symptom evaluator or half-translation.
Likewise unsupported forehead/eyelid negatives remain source-preserved.

Permanent regression oracles were added **only to already CodeRabbit-reviewed
test files** (body-site grammar, instruction graph, advanced composition).
Initial four site tests and one opaque-action test were RED before changes
and GREEN after; final source suite **2476/2476** across 45 test files PASS
(process proc-ecbca4a9-52db-4066-ac65-b21b32e19e2d).
Latest npm run test:dist (process proc-153c154e-ea30-4f83-8665-3a564d036152)
PASS: ESM/CJS, tsc declarations and packaged **4/4**.
Direct rebuilt-package Thai formatting checked through default R5, R6,
strict R5 conversion for sites and conditional course-end advice.
CodeRabbit raw115 minus existing15 exclusions = **100 reviewable files**;
no new review paths/exclusions. No src JSON.parse/JSON.stringify;
no unrelated untracked diagnostic probe staged or edited.
No push, merge, publication, deployment, or version bump.


### 2026-10-24 — Supported clinical Thai/English near-neighbor HPSG completion

User requested genuinely embarrassing in-scope clinical errors be fixed before
full bilingual SIG persistence. Earlier GPT-5.6 Sol/xhigh coordinator and
specialist workers integrated source-backed lexical/HPSG/regimen corrections
for Thai written/fractional/Unicode numbers, compact dayparts/frequency,
course-versus-meal offsets, independent undelimited OD/OS dose boundaries,
independent Thai ocular/topical follow-up phases and dose-local conditions.
Product remains a fast clinician-reviewed suggester, not autonomous prescribing
or universal clinical NLP. Unsupported instructions remain editable/source-backed.

Independent current-SOURCE clinical audit, not stale dist, passed 1195/1195
asserted checks: all 54 original realistic close variants, 55 additional
clinical inputs, and 16 independent near-neighbors including correct dose,
site, time, condition, PRN cap, alternatives and direct/strict R5/R6 parity.
The simple 54-case packaged runner has two false oracle REDs: an after-breakfast
plus after-dinner schedule correctly uses PCM+PCV without a redundant
frequency field; an English night-time administration correctly uses NIGHT.
Its clinically intended 54/54 behavior was independently verified.

Other bounded corrections:
- A registered administration-site noun phrase preempts a shorter product-form
  interpretation. Alternate injection sites no longer fabricates IV; real
  products (e.g. nasal spray) retain the correct route.
- a/an/one/1 procedural-duration quantity and explicit FOR lead are owned by a
  typed source-backed Duration, independent of treatment-course bounds or
  medication dose. Exact-head HPSG ownership is suppressed only when the
  quantified procedural Duration truly owns the phrase; old coordinated
  crush/chew and avoid-broken-skin advice continue unchanged.
- A final coordinator RED-first correction of ordinary mouthwash/rinse
  instructions distinguishes elapsed FOR one/a/two minutes from a physical
  rinsing Substance. It removes duplicate partial Rinse for and false PRN
  reason a using existing typed Duration in HPSG instruction/PRN source
  ownership and the existing bilingual site-relation realizer. Rinse with
  water remains a distinct Substance. Added seven permanent tests including
  direct and FHIR-reloaded EN/TH procedural output, non-medication duration,
  and no accidental PRN/cap. No surface literal patch/FHIR meaning repair.

Integrity: the old 17 whole-course quantity/supply tests with 58 expectations
were migrated byte-for-byte from test/whole-course-quantity.spec.ts lines8-291
into test/schedule-family-audit.spec.ts lines1054-1337, and are GREEN once,
not deleted or duplicated. The original test path is intentionally absent.
Three independent GPT-5.6 Sol/xhigh read-only reviewers signed off on current
clinical semantics, retained tests and HPSG architecture. No original
assertions were weakened and no new skip/todo was introduced.

Final tracked-source gates after the last rinse correction:
- Node22 source test proc-cf9269b2-038c-44db-8d81-6e69358320a3:
  44 suites 2623/2623 PASS.
- Final npm run test:dist proc-b85d40d1-f347-4b76-be00-c52276dbda53:
  ESM/CJS build, TypeScript declarations and packaged 4/4 PASS.
- Final packaged 54 close variants / 55 real-world smoke checked; zero throws
  and all previously identified supported-domain semantic failures corrected.
- Actual PR10 base 0d096a4cc913565c0344025d92ce2f96a8cedc42:
  115 raw changed paths less 15 unchanged configured CodeRabbit exclusions =
  EXACT100 reviewable files. No new runtime src JSON.parse/JSON.stringify or
  classes. Original untracked test/__tmp_open_semantic_probe.ts untouched.
- Paired warmed host baseline0615241 versus current Node22, in
  /tmp/ezmed-realworld-final-perf-20261024.json:
  routine English BID2.519 -> 2.669ms, routine Thai numeric2.816->2.900,
  Thai spelled cadence5.531->4.754, undelimited eyes3.335->3.040,
  Thai phase13.915->7.097, established eye taper4.026->4.002,
  Thai condition10.607->10.405, article course3.187->3.196.
  These timings are host medians, not phone guarantees.

Remaining known non-blocking rough presentation: a source-backed Thai duration
lead นาน may remain as a leftover beside a correct topical taper; unsupported
counseling may retain its exact untranslated Thai/English source. No additional
incorrect executable dose, eye/site, timing, phase, condition, PRN or FHIR
roundtrip was reproduced in the bounded realistic checks. First-class
clinician-approved complete EN/TH instruction storage remains separate.
No push, merge, registry publication, or downstream consumer deployment performed.


### 2026-10-24 — HPSG supported clinical grammar and source fidelity final integration

Continued from local f8c2961 and the shared hardcut BB. This pass corrected
the following genuine, bounded user-plausible clinical semantic failures:
- Positive glucose IF with negative OTHERWISE action, and weight-threshold
  conditional 2-tab versus ELSE 1-tab, remain exactly-one alternative doses.
  Terminal period/comma no longer discards the alternative or changes the
  dose to 70kg. OR-linked upper/lower SBP thresholds share the typed subject.
- Spoken 1-and-a-half tablets, Thai halves, plural weekdays, Sunday exclusions,
  two independent OD/OS instructions, source-backed multi-phase ocular/topical
  tapers, shared treatment-course duration, delayed second administration
  relative R6 start, PRN caps and meal-specific insulin withholding are
  preserved as typed source evidence through extended/strict R5 and R6.
- Original dependent OPD repeat action and time dependency remain a single
  typed action. A bounded procedural-object owner now stops at an independent
  semicolon, preserving a second explicit repeat-cycle medication order.
- Source-backed ocular internal lower-eyelid ointment uses ophthalmic route
  and the measured centimetre/cm ribbon unit. External eyelid skin remains
  nonocular/topical, without inventing an anatomical SNOMED code.
- An existing typed discourse-connector graph prevents a false temporal THEN
  for BUT-qualified medication advice. Full fasting/dialysis-day conditions
  remain attached in patient-visible EN/TH text. A second typed WITH Object
  such as clean tissue is retained instead of being silently dropped.
- Negated procedural dietary instructions are NOT medication meal timing.
  Declarative NEVER polarity and MISS/skip omission lexemes enable six
  red-first realistic do-not-miss / never-skip meals/breakfast cases to
  preserve complete counseling without inventing C or CM medication WHEN.
  Positive take-with-meals and after-breakfast retain correct medication
  event timing. Never miss a dose remains legible patient advice.

Previously-RED and historical test assertions were retained; no broad raw
formatter shortcut, invented clinical parser, refusal gate, new classes, or
production JSON.parse/JSON.stringify introduced. Final Node22 canonical full
source: 44 suites and 2750/2750 PASS, process
proc-e81b122c-acb7-44e4-9a70-09d02a31a336.
Final npm run test:dist: ESM/CJS build and TypeScript declarations PASS,
packaged exports 4/4 PASS, process proc-d0ac0588-6b85-4255-868a-3afbb4fcc90d.
Current downstream consumer adapter worktree left unchanged: EZMed R5+
interop 28/28 PASS and direct five current EZMed0.2 -> downstream adapter -> FHIR R5
round-trips preserve doses, sites, routes, conditions, choice membership,
relative delays and course metadata. Replayed 54 near-neighbor plus 55
realistic EN/TH clinical test inputs without exceptions or newly reproduced
incorrect supported semantic structures. Two older near54 simple-oracle
flags are known overly restrictive on valid PCM+PCV versus redundant
frequency and NIGHT versus EVE/HS. Independent legacy source-corpus
521/521 no crashes and no lost populated primary dose (not comprehensive
0.1.x semantic equivalence).

Host-only paired performance medians vs immutable 0615241 baseline in
/tmp/ezmed-realworld-final-perf-20261024.json: English BID 2.543 ->
2.898ms (+13.9%), Thai numeric 2.786 -> 3.126 (+12.2%), Thai word
frequency 4.939 -> 5.339 (+8.1%), independent eyes 3.187 -> 3.359
(+5.4%), Thai complex taper 13.971 -> 7.992 (-42.8%), established
English taper 4.197 -> 4.532 (+8.0%), Thai insulin condition 10.962 ->
11.941 (+8.9%), English article course 3.014 -> 3.322 (+10.2%).
The routine modest overhead is disclosed, not silently labeled zero; no
catastrophic latency/memory increase measured. Production phone performance
is unmeasured and remains a separate optimization consideration.

PR10 base 0d096a4cc913565c0344025d92ce2f96a8cedc42:
115 raw paths minus same 15 existing exclusions = EXACTLY 100
CodeRabbit-reviewable. git diff --check PASS; no new exclusions.
Untracked test/__tmp_open_semantic_probe.ts untouched and unstaged.
No push, PR revision, merge, publish, deployment, or downstream consumer worktree
mutation. Release scope remains fast clinician-reviewed suggestions with
editable unsupported counseling, not universal clinical NLP or autonomous
ordering. Whole-course clinician-approved EN/TH bilingual persistence is
a separate follow-up.


## 2026-10-25 — Typed multiweek regimen and administration execution checkpoint

Completed the realistic mixed-dose/titration audit through source parsing,
actual administration execution, supply calculation and downstream schema
round-trips. This checkpoint extends the earlier 4c1f7e7 baseline; it does
not claim unrestricted clinical language coverage.

- Labelled weeks, fronted finite-course phases and independently timed
  fractional doses retain source-owned phase boundaries and dose amounts.
  Same-day THEN is distinct from a true multiweek treatment transition.
- Waking-hour interval execution uses a typed event window, not a WAKE point
  event. Caller-provided waking/sleep clocks control the window. The original
  unrestricted interval and independent calendar/parallel-track tests remain.
- Previous-time references are contributed by the existing timing-anaphora
  lexicon and resolved against agreed predecessor recurrence. They do not
  copy the previous finite course. An unresolved same-time preference remains
  visible editable advice rather than inventing clocks or disappearing.
- ADD versus REPLACE is a typed source regimen operation in formal HPSG
  content, unification and canonical projection. ADD continues the previous
  phase before the single FHIR projection, while replacement does not retain
  obsolete administrations. Ordinal treatment-relative onsets prevent a
  week-two addition from occurring in week one. Equal antecedent doses can
  license an omitted amount; unequal antecedents do not license a guess.
- Existing event-preposition grammar now understands upon waking, allowing
  the existing shared trailing-duration construction to cover both waking
  and bedtime doses. No partial-FHIR-component endpoint inference is used.
- Positive adjustment operations cannot escape a negated directive. Negative
  ADD objects/event complements remain advice and cannot create a positive
  bedtime dosage. ADD retains its local predicate and exact published SNOMED
  dosing-fragment code 422106007; phase relationships are not clinical events.
- Supplemental nominal quantities such as an extra half tablet remain
  distinct from the standing regimen and carry their own conditional scope.
  The old Thai primary-two-tablet plus secondary-relative-one-tablet control
  is retained: a secondary amount owned by after-first-administration must
  not outscore or overwrite the primary dose. Minimum delay is not made exact.

Final official Node 22 source gate: 44 suites, 2861/2861 PASS
(proc-85953e48-f74e-4bae-9ad5-a025b1eeef3f). Final ESM/CJS build and TypeScript
declaration generation PASS (proc-bd3efb92-acd3-4d70-9c7c-f339ef574308), built
exports 4/4 PASS (proc-0ba5eb2e-ca53-45bf-b797-5c274231b722). All original
parallel-regimen, Thai-relative-instruction and clinical correctness assertions
are retained; no acceptance gate was weakened to make these results green.

Actual final built package -> downstream dosage converters -> schema
validation -> FHIR reload: six/six source cases PASS, including original
source retention, exact day-one/day-eight/day-fifteen next administrations,
and supply parity with native R6. Three week-two additions produce expected
77, 56 and 70 tablets over 21 days; a finite noon addition gives 31.5 tablets
and stops after day 14; same-time replacement gives 35 tablets over 21 days;
a waking interval plus optional extra bedtime dose gives maximum 31.5 tablets
over seven days. Downstream adapter fixture suite 28/28 PASS. The downstream
worktree was not modified by these checks.

Interleaved shared-host Node 22 medians against immutable 4c1f7e7 bundle,
50 warmups then nine alternating trials of 60 parses, with explicit GC:
- 1 tab PO BID: 1.160873 -> 1.166286 ms (1.0047x).
- 1 drop OD QID: 1.239772 -> 1.223577 ms (0.9869x).
- Asymmetric morning/bedtime seven-day course: 15.360208 -> 15.820321 ms
  (1.0300x).
- Thai BID after-meal instruction: 5.825081 -> 5.780783 ms (0.9924x).
These are host samples, not phone latency guarantees. Phase lexical
inventories are indexed once instead of allocating per token. Reused the
existing timing-anaphora inventory rather than maintaining duplicate data.

Review limit remains 115 raw paths minus the same 15 existing configured
exclusions = 100 reviewable files. No new exclusions. Whitespace clean;
existing untracked test/__tmp_open_semantic_probe.ts remains outside the
commit. No remote push, merge, publication, deployment or downstream UI
migration is claimed by this local validation checkpoint.


### 2026-10-25 — Parkinson-style phase and execution semantic correction

Independent clinically reasonable multi-dose/taper examples exposed wrong
week-labelled adjustments, finite-duration ownership, optional additions,
same-times anaphora, waking-hour limits and some meal/clock combinations.
Follow-up implementation and formal regression coverage now distinguish:
- source-licensed ADD versus REPLACE operations on regimen phases; ADD carries
  explicitly prior scheduled doses forward and adds only the new dose after
  the stated boundary, while REPLACE does not accidentally retain old doses
- labelled English and Thai week phases, explicit starting week, per-dose
  clock times and inherited "at the same times" from a preceding typed phase;
  unresolved "same time" without an antecedent remains reviewable advice,
  never an invented exact clock
- the full predecessor regimen's shared course end, including mixed WAKE and
  bedtime administrations, not merely the last dosage component's end
- a recurring daily waking-hours window distinct from a punctual WAKE event;
  structured start WAKE/end HS clinical event codes are carried through
  the HPSG signature, canonical schedule, typed FHIR extension and scheduler.
  The scheduler never infers event windows from free text and uses explicitly
  configured patient/event clocks; without provided wake and sleep clocks no
  fixed waking times are fabricated
- nonuniform doses at independent absolute clocks, meal-relative events and
  bedtime; secondary 0.5-tablet doses, PRN conditional counsel and quantity
  maxima remain distinct from the baseline dose, including "an extra half"
- source-faithful Thai second-dose relative instructions; first 2-tablet dose
  no longer disappears. "At least one week" remains a minimum/not a fabricated
  exact seven-day appointment. Negated "never add" must not add a dosage.

Independent clinical executable oracles compare actual day-one/second-week/
third-week administrations, per-dose amounts and supply (21-,14-,7-day windows)
for native R6, strict R5 and FHIR roundtrips. Formerly failing Parkinsonian
cases including three daily clocks -> four starting week two, an added 0.5tab
at 22:00, continued waking+bedtime with added noon from second week, and
half-to-whole dose at the same times are now green. The original 521-example
backward-compatibility smoke found and resolved the Thai primary-dose loss.
The HPSG test suite includes negative cases for prohibited additions, unequal
preceding amounts and original source preservation.

Verified SNOMED CT **422106007**, "Add - dosing instruction fragment
(qualifier value)" is present as an external coding alongside the existing
local typed ADD instruction action. Clinical action graph and direct/strict
R5 import/export roundtrips retain both codings. This external dosing-action
qualifier does not purport to encode calendar boundaries, relative time,
conditional source clauses or patient-specific medication semantics. Do not
invent anatomical or timing SNOMED concepts where none is warranted.

Final independent Node22 source test on committed implementation 276b0fa:
44 suites, 2861/2861 PASS (including the new standard ADD coding
direct/strict-R5 import/export oracle). ESM/CJS builds, TypeScript
declarations and packaged 4/4 distribution tests PASS.
The 100-file CodeRabbit review cap is unchanged (115 raw paths less the same
15 existing configured exclusions). Original untracked diagnostic probe
remains untouched and unstaged. No remote push, publication, merge or
deployment performed.


## 2026-10-25 — Source-relative edits, overnight schedules and FHIR display

- A source-licensed `From week 2` time header now belongs to the following
  complete ADD daughter. The boundary planner does not strand the header on
  the previous dose or construct a second empty seam before ADD.
- Regimen composition retains the explicit treatment-relative onset as an
  independent R6 step start and propagates it to each unaffected administration
  continued into an ADD or clock-targeted replacement phase. Editing the
  preceding stage from seven to five days does **not** move a new dose
  prescribed for the second week onto day six. Strict R5 persists this meaning.
- Natural punctuation and lexical sequencing variants use existing typed phase
  relationships; same-day conjunction and independent parallel-dose controls
  remain distinct. Source, dose, cadence and calendar information are never
  reconstructed from FHIR text.
- An explicit STOP interval is an administration-free treatment gap. Daylight
  and overnight WAKE→HS recurring windows execute in both native R6 and
  strict R5, including after-midnight administrations owned by the previous
  waking-day window.
- Source-less R6 treatment-day start/end and medication-free gaps display
  legibly in English and Thai. Multiclock, mixed-dose three-week and pause
  cases preserve exact day ranges, amount distinctions and their 56/35-tablet
  clinical totals across R6/R5. Authored text still wins when supplied;
  unknown modifiers remain untouched, without warnings invented by display.
- The retained R6-in-R5 course marker now omits invalid explicit `undefined`
  optional fields in both public `parseSig().fhir` and
  `toFhirR5Dosages()`. The shared structural copy is restricted to those
  uncommon markers; ordinary dosage parsing is unaffected. No JSON string
  serializer or second clinical interpreter was introduced.

Final local Node22 source gate before PR review: 44 suites,
**2924/2924 PASS**, with independent next-dose/supply/edit-stability controls.
ESM/CJS build, declaration generation and packaged exports 4/4 PASS.
Downstream FHIR dosage-schema validation and actual administration parity
checks were green on the repaired staged cases. CodeRabbit remains at exactly
100 reviewable paths under the same existing exclusion configuration.
The original untracked diagnostic probe is neither staged nor deleted.
The branch is ready for updated remote review; npm publication, merge and
deployment are separate operations.


## 2026-10-25 — Final typed-authority and realistic-regimen release gate

This checkpoint closes the reproduced ordinary clinical failures and removes
competing semantic interpretation in the guard, repeating-course, and one-shot
relative-event paths. It is a bounded clinician-operated suggestion release,
not a claim to understand every possible instruction.

- Medication guard meaning is composed by typed HPSG predicate, coordinator,
  head-complement and guard-head constructions. AND/OR precedence, comparison
  head ellipsis, UNLESS and predicate NOT have retained daughter/provenance
  graphs. The old standalone Boolean interpreter was removed; the public
  guard entry point delegates to that single HPSG producer. Lexical marker
  ownership prevents ONLY IF from also becoming an independent PRN phrase.
- Recurring active/rest/repeat meaning is a typed HPSG construction in the
  timing grammar. The separate regimen/cycles source module was removed,
  not hidden behind a review exclusion. Exactly declared cycle counts stop;
  explicit finite tails crossing repeat boundaries remain executable. The
  scheduler merges overlapping occurrences without losing multiplicity and
  supply calculations use the same source bounds.
- One-shot administration-relative timing is represented by the existing
  activityTiming model. The scheduler no longer reparses unrelated patient
  counseling to decide whether a one-time dose can execute. Known anchors
  are preserved through FHIR, while unresolved real event instants remain
  unresolved instead of becoming invented dates or daily recurrence.
- Generic procedural attachment keeps the Thai post-application caution on
  its intended non-administration action. Its original clinical oracle was
  retained unchanged. Three earlier opaque-storage assertions were migrated
  to stronger typed-anchor, original-source and strict-R5 persistence checks;
  unrecognized workflow text retains its old editable advice behavior.
- Realistic conditional extra doses retain tablet amounts independently of
  body-weight or creatinine observations. Fronted and postfixed conditions
  attach to the intended extra administration, not the standing dose. Caller
  supplied contextual day membership remains a condition, not an invented
  procedure date or a patient-problem code.
- Independent weekday complements, exclusions, meal/snack doses, multiple
  distinct meal offsets, monthly fourth-versus-last ordinals, time windows,
  unequal multiweek doses, later ADD/targeted changes and STOP/resume retain
  their clinical values in native R6 and strict R5. Explicit treatment-relative
  onset remains fixed when a prior phase is subsequently edited.
- Source-less R6 display preserves stage bounds, real gaps, overlap, recurrence,
  finite count, Boolean grouping and negation in English and Thai. Known
  nested extension values are JSON-compatible for direct schema validation;
  unfamiliar modifier extensions are not reinterpreted or converted into
  warnings or refusal gates.

Final frozen source gate: Node 22, 44 suites, 3148/3148 PASS at 10:22:40 Bangkok
(proc-9038ed88-0454-4b67-ab88-c0d19a1d7dce). Prior matching full pass was
proc-50857362-2b5c-4b8b-9ad3-59997fe84b4a. TypeScript, ESM/CJS and declarations
passed; packaged export checks passed 4/4. The source/test fingerprint used
for the final gate is d213bc2c849ebfbf745f3059244319e6411ab567f801c09690a0aa426745a697.

The commercial 521-input replay against the immutable pre-change bundle had
zero new exceptions, original-source loss, complete populated-dose loss, or
changed dose-row counts. This is compatibility evidence, not a universal
semantic proof. Independent reviewers also replayed 59 realistic inputs with
462 assertions and 14 actual downstream schema round trips successfully.
Coordinator replay of the final built package covered 13 clinical families
through both parser R5 and strict R5 output (26 routes): dosage-schema
validation, source retention, exact date/time execution and independent supply
expectations. The formal suite contains the finer field and polarity checks.

Matched esbuild, warmed alternating Node 22 host medians against the immutable
pre-change bundle: routine BID 1.306 -> 1.362 ms (1.042x), OD QID 1.302 ->
1.349 ms (1.036x), Thai BID 3.786 -> 3.906 ms (1.032x), Boolean numeric guard
9.767 -> 8.975 ms (0.919x), finite three-cycle SIG 5.251 -> 5.130 ms (0.977x).
Shared-host measurements are not phone latency guarantees. No new repeated
schema validation, JSON serialization, or source reparsing was added to the
ordinary suggestion path.

Review limit: 114 raw changed paths minus the same 15 existing exclusions =
99 reviewable files. No additional exclusions. The existing untracked
__tmp_open_semantic_probe.ts is not part of this checkpoint. Public package
publication, merge and deployment are not performed by this validation;
manual review must refer to the final pushed revision, not an older green
status whose description says Review paused.


## 2026-10-25 — HPSG authority closure and packaged release checks

The final closure keeps grammatical ownership in the typed HPSG derivation
and carries it through the instruction graph, regimen and FHIR projections.
The accepted clinical cases and all existing source tests are now green.

- Typed predicate boundaries keep an action word inside a day predicate from
  becoming a conditional consequent. A dialysis-day HOLD retains its NOT and
  selected dose; unaffected administrations remain scheduled.
- An undosed meal directive after an explicitly clocked prescription is
  counseling on those doses. With caller meal clocks and a before-food offset,
  the accepted 07:00/12:00/18:00 seven-day instructions produce exactly 21
  tablets. A genuinely independent, quantified meal dose remains independent.
- HPSG condition scope now survives canonical projection. Graph relations use
  the closed constituent's source and target ranges, and action sorting remaps
  relation indices by action identity. The old nearest-action reconstruction
  no longer overrides that grammatical decision. Conditional NOTIFY DOCTOR
  remains advice while the preceding medication keeps its standing schedule.
- Existing pure dose constituents recognize an amount before its administration
  verb, preserving all 24 Thai modal/timing/PRN/dose orderings. A symptom-onset
  trigger following a complete quantified administration stays with that dose
  when a later REPEAT action occurs; the repeat delay and total count survive.
- Registered Thai negative directives retain polarity, modality, contact theme
  and target. Household-spoon and bottle/tube-tip nominals stay intact; positive
  recapping and handwashing remain separate from preceding prohibitions.
  Permanent tests cover the actual oral, liquid, topical and ocular labels
  across native R6, parser R5, strict R5 and reopened R6, including laterality,
  raw source, schedule and independent quantities.
- The original review findings have permanent regression coverage for monthly
  weekday ordinals after a later order-time anchor, nested Boolean NOT and
  grouping without source prose, and method-only inheritance into PRN phases.

Final source gate: **3,329/3,329 tests in 44 suites**, plus TypeScript. All 165
source, test, FHIR profile and configuration file hashes were unchanged during
verification and package generation. Source fingerprint:
`d14f37d45b061fcb50d7f42c586fe952a1ff0cca281b7722082c23fcf4c18741`.
ES6 ESM/CJS builds, declarations and all **4/4** packaged-export tests passed.
Built ESM fingerprint:
`fc9c9160a4aa898a779bd2abb91dcfba89ca308d42496ddf96c9a1ffb278dbd9`.

The actual built package passed 117 authority/round-trip checks, 79 mixed
schedule checks, 24 configured-label/consumer checks, 18 further actual
consumer round trips and 462 assertions over 59 clinical inputs. The existing
521-input compatibility corpus had zero exceptions, source loss, complete
populated-dose loss, dose-value-array changes or dose-row-count changes against
the immutable comparison bundle. These are bounded regression and clinical
oracle results, not a claim of universal language understanding.

Matched ES6 Node 22.22.1 host medians (30 warmups, seven alternating batches
of 50 parses with GC) against the immutable comparison bundle were: BID
1.454 -> 1.468 ms; OD QID 1.420 -> 1.497 ms; Thai BID 3.301 -> 3.389 ms;
two-phase course 3.760 -> 3.877 ms; numeric HOLD 4.409 -> 4.502 ms.
The measured changes were +1.0% to +5.4%, or +0.014 to +0.117 ms. These
shared-host measurements do not establish phone latency. No new general
parse or schema-validation pass was added for the closure fixes.

Review scope remains **99 files**: 114 changed paths minus the same 15
configured exclusions. The exclusions were not widened. The original
untracked diagnostic probe remains untouched and outside the commit.


## 2026-10-25 — HPSG scope, clinical shorthand and cycle eligibility closure

The follow-up addresses ordinary supported SIGs exposed by the full review and
an independent shorthand audit. Each correction retains a precise dose, cadence,
course or source-coordinate oracle and positive controls. These changes extend
the existing lexical and constituent grammar; the FHIR and scheduling consumers
do not reinterpret the prose.

- A named cycle-day constituent owns its complete temporal nominal. `1 cap PV
  HS days 16-25 of menstrual cycle` retains one capsule, vaginal site and bedtime
  timing; the day ordinals cannot become a 16–25-capsule dose or a body site.
  Missing cycle anchor/period information travels as a typed cycle-day
  constraint through canonical state, a known FHIR modifier and reopening.
  Formatting and editing retain the known fields and qualifier. Only scheduling
  and numeric supply require the unresolved cycle eligibility to be completed.
  A fully anchored three-cycle example still yields its exact 30 capsules.
- The existing marked-count daughter now serves total-dose and recurring-course
  counts. `repeat x3 cycles`, `repeat x 3 cycles` and `repeat for 3 cycles` retain
  three active courses and their intervening pauses: three 21-day daily courses
  separated by seven-day rests yield 63 tablets, without a fourth course.
- MISS is a distinct lexical meaning, separate from medication withholding. Its
  prohibitive directive sense requires negative polarity, after existing shared
  negation composition. `Do not miss meals` keeps its meal object as advice;
  positive MISS inside `If you miss a dose` stays in the antecedent rather than
  becoming the commanded action. The permanent regression checks the complete
  antecedent and TAKE target, not only the unaffected medication quantity.
  HPSG also shares the entire conditional action program between lexical
  ownership and closure. Supplemental-dose nominals remain distinct from the
  standing dose. The accepted counseling family retains one scheduled tablet
  daily and seven tablets over seven days under either condition callback value.
- Thai morning/evening daughters license their conventional hyphen/slash
  conjunction inside the existing meal-event constituent. Both relation orders
  retain breakfast and dinner, including an explicit twice-daily cadence.
  The previously wrong 7- or 21-tablet outputs are now 14 tablets over seven
  days. Numeric `1-0-1` meal-dose slots retain their separate construction.
- Fixed clocks can head a schedule whose adjacent meal-relative daughter is a
  qualifier. HPSG uses the daughters' typed field provenance and source
  adjacency; explicit conjunction and separately quantified administrations
  still introduce additional events. `1 tab PO at 07:00, 12:00 and 18:00 before
  meals x7d` therefore retains those three exact daily times and 21 tablets,
  with the meal qualifier preserved as an instruction in English and Thai.
  Already-owned duration/cadence daughters may bridge the clock and meal
  constituents, so `at 07:00, 12:00 and 18:00 for 7 days before meals` and
  its semicolon variant also retain 21 tablets. The original external oracles
  were kept unchanged. Imported native FHIR
  containing an explicit clock/event union is unchanged by this grammar rule.
- A bounded three-token multiplication daughter recognizes spaced `1 x 3` and
  `1x 3`. The count construction cannot independently claim its incomplete
  `1 x` prefix. With the supplied tablet-form context, every accepted spelling
  retains one tablet three times daily for five days, totaling 15 tablets.
  An explicit once-daily total-count instruction and fractional doses remain
  covered by independent controls. The glyph `½` is one additional entry in
  the existing HPSG fraction lexicon, preserving its original source and the
  same half-tablet meaning as `1/2` and `0.5`, without Unicode source rewriting.
- Delayed-target inheritance now fills an omitted recipient dose while retaining
  an explicitly authored quantity. The right/left-eye examples keep 1/2 or 2/1
  drops at 08:00/08:05; omitted amounts still inherit. Site source ranges rebase
  with the other canonical ranges. Planner event ownership requires explicit
  `when` field evidence, including when an evidence record lacks that field list.
- Three FHIR extension differentials now follow base-element and depth-first
  ordering. All element definitions keyed by id and all profile metadata remain
  unchanged. Tests check ordering, contiguous descendants, unique ids, canonical
  URLs and the existing value constraints. No full external HL7 validator run
  is claimed.

Final frozen gate: **3,410/3,410 tests across 44 suites**, plus TypeScript.
All 167 source, test, profile and configuration file hashes remained unchanged
through the full gate, build, actual-consumer checks and performance run.
Source fingerprint:
`da386be1d1511b5aaf6ed9522c5f0445004ee5b6ca417eb96d075320a0f76333`.
ES6 ESM/CJS bundles, declaration generation and **4/4 packaged-export tests**
passed. ESM fingerprint:
`b9fe516f96314931556d2904b3ce022895194b55cf5a6856639fdc212be50212`.

The actual built package passed the unchanged **84/84** independent shorthand
oracles, **117** authority/round-trip checks, **18** consumer round trips,
**462 assertions over 59 inputs**, and **20** ESM/CJS instruction-ownership and
fraction checks. Independent consumer batches passed **221/221** mixed
schedule, counseling, configured-label, cycle and reordered-meal checks,
**16/16** dose/cycle/fraction round trips and **10/10** bilingual clock/meal
round trips. These batches overlap in clinical families and are not presented
as a unique-input total. The immutable **521-input compatibility replay** had
zero exceptions, original-source loss, populated-dose-value changes or
changed dose-row counts.

Matched ES6 Node 22.22.0 medians used 30 warmups and seven alternating batches
of 50 parses with GC, after all other correctness jobs finished:

| Input family | Baseline ms | Current ms | Change |
| --- | ---: | ---: | ---: |
| Routine BID | 1.416 | 1.414 | -0.2% |
| Ocular QID | 1.551 | 1.526 | -1.6% |
| Thai BID | 3.443 | 3.462 | +0.6% |
| Two-phase course | 3.892 | 4.089 | +5.0% |
| Numeric HOLD | 4.587 | 4.519 | -1.5% |

The largest measured increase was 0.196 ms. These shared-host measurements
are not phone measurements. No additional general parse, schema-validation
or serialization pass was added to the ordinary suggestion path.

Review scope remains **99 files**: 114 changed paths minus the same 15 existing
exclusions. No exclusion was widened and no production grammar was hidden from
review. The original untracked diagnostic probe remains unchanged and outside
this commit. These are bounded clinical regression and consumer results, not a
claim that the parser understands arbitrary clinical prose.

## 2026-10-25 — Fresh review: calendar bounds and retained scope data

The incremental review of `3c66055` exposed two data-restoration defects and
one loss of course bounds. Each reproduced against a supported clinical or
structured-data contract. The corrections retain the typed information already
present in the grammar or FHIR object.

- FHIR-to-parser-state restoration now carries a defined administration offset,
  including zero, through the existing getter. It retains independent schedule
  fields and supports a modifier-only object. Five new regressions first showed
  the missing 0/5/720-minute and modifier-only 15-minute values, then verified
  exact shifted execution after re-export. The invalid-unit control remains
  unchanged; the complete R6 suite contains 152 passing tests.
- Canonical rebasing shifts both the source and target ranges of a closed HPSG
  instruction scope. Two ordinary later-segment prescriptions previously left
  their IF and TAKE ranges local while the action graph was input-absolute.
  The regressions require the exact antecedent/consequent source slices,
  retained action identity and the intended 21-tablet clinical totals through
  native R6, parser R5, strict R5 and reopening. The 309 affected review and
  instruction-graph tests pass.
- Anchored month/year courses materialize the inclusive calendar endpoint from
  the existing clamped, exclusive anniversary policy. January 31 plus one month
  stops before February 28 in a non-leap year and before February 29 in a leap
  year. This preserves the 28/29-tablet totals instead of an open-ended 40-day
  supply. A leap-day one-year course contains 365 daily administrations. The
  next phase starts at the same calendar boundary; the tested one-month course
  followed by seven days at two tablets yields 42 tablets.
- FHIR retains the authored course quantity or range in the recognized
  `medication-anchored-course-duration` modifier alongside `boundsPeriod`.
  This respects the single `Timing.repeat.bounds[x]` choice while retaining
  month/year units, partial-day durations, ranges and an earlier duration cap
  within a later explicit end date. The existing duration-cap executor and both
  import paths consume this shared typed getter. They do not reinterpret source
  prose or approximate calendar months as a fixed number of days.
- HPSG course quantities share the existing temporal-unit vocabulary, with a
  declared course-unit license. This supplies the previously missing ordinary
  `for 1 year` meaning while keeping procedural seconds on their instruction.
  The complete suite exposed that unit-ownership interaction during integration;
  the unchanged patch-pressing realization oracle and all 91 generation tests
  pass after the lexical license correction.

TypeScript and **3,426/3,426 source tests across 44 suites** pass. The final
frozen gate covers 166 tracked source/test/profile/configuration inputs plus the
untouched original diagnostic probe. All 167 hashes remained unchanged through
the gate, package generation, actual consumers and performance. Source manifest:
`2bcc57d889cf08b744d4a9f98517308b2ffd1291f786ad077029661539c78e98`.

ES6 ESM/CJS bundles, declarations and **4/4 packaged-export tests** pass. The ESM
package fingerprint is `4139e005780182b10ac68a330a486cb12f6557ce6b1da388415c1b8dee3def83`.

Actual-package verification passed the unchanged **84/84 independent shorthand
oracles**, **117** authority/round-trip checks, **18** actual-consumer round trips,
**462 assertions over 59 clinical inputs**, and **20** ESM/CJS ownership/fraction
checks. The existing consumer runners passed **221/221** mixed-schedule, label,
counseling, cycle and reordered-meal checks, **16/16** dose/cycle/fraction checks,
and **10/10** bilingual clock/meal checks. The added **22/22 review-closure
consumer paths** cover nine calendar/fraction/range/phase oracles through the
actual external schema/converter and four later-segment ESM/CJS scope checks.
These batches overlap in clinical families and are not a unique-input total.

The immutable **521-input compatibility replay** reported zero exceptions,
original-source loss, populated-dose-value changes or dose-row-count changes.
Profile ordering has structural regressions; a separate full HL7 validator run
is not claimed.

After all correctness jobs finished, the quiet matched ES6 Node 22.22.0 run used
30 warmups and seven alternating batches of 50 parses with GC against the same
immutable baseline (`12c309762191281425e3be739b260e1f63916081111c9b1dd1cb8248f8ac2652`):

| Input family | Baseline ms | Current ms | Change |
| --- | ---: | ---: | ---: |
| Routine BID | 1.399 | 1.444 | +3.2% |
| Ocular QID | 1.399 | 1.553 | +11.0% |
| Thai BID | 3.327 | 3.487 | +4.8% |
| Two-phase course | 3.921 | 4.122 | +5.1% |
| Numeric HOLD | 4.401 | 4.625 | +5.1% |

The increases in this run were 0.045–0.224 ms per parse; the largest
relative increase was 11.0% on the ocular input. These are shared-host
measurements, not phone measurements or a claim of zero runtime regression.
No additional general parse or schema-validation pass was added.

The full PR remains **99 reviewable files**: 114 changed paths minus the same
15 configured exclusions. The original untracked diagnostic probe remains
unchanged. These fixes address all three findings from the completed review;
they do not imply a new automated review of the follow-up commit.


## 2026-10-25 — Compact R5 persistence with row-local course metadata

Replaced the emitted per-row complete-course snapshot with the existing typed
extension codec carrying local phase metadata and only component fields that
native R5 cannot represent. Shared course metadata has one owner. Ordinary
native dose, timing, route and site fields stay authoritative; `.fhir` remains
the primary R5-shaped persistence surface and `.fhirNext` remains derived.
Historical complete-course markers remain readable and re-export compactly.

The six-row independent eye taper
`1 drop OD q2h x7d then qid; 1 drop OS qid x1mo then bid` now serializes to
**9,926 UTF-8 JSON bytes**, down from **51,000** (**80.5% smaller**), through both
primary and strict R5 exports. Native R6 remains **5,800 bytes**, structurally
unchanged. The actual downstream schema/converter save-and-reload result is
**10,604 bytes**. New size and growth regressions failed against the previous
writer before the compact implementation was introduced.

Row deletion and reordering retain surviving phase starts, component identities,
conditions, safety data, unknown extensions and bilingual realization. Explicit
native field edits supersede retained expressions. Source instruction provenance
has one owner. Missing required shared cycle/safety context or an unanchored
predecessor remains typed and editable; numeric scheduling and supply report
`missing-course-context` until that context is restored. A separately persisted
matching `.course` object can restore the shared owner. The enclosing-course
counted-dose helper now uses its resolved local execution copy, preserving the
existing additional-dose totals without reinterpreting that row in isolation.

**3,439/3,439 source tests across 44 test files**, TypeScript, the package build
and **4/4 packaged-export tests** pass. The 13 added regressions cover compact
size, linear growth, deletion, reorder, explicit native edits, conflicting and
missing shared owners, unknown markers and ten byte-stable save/reopen cycles.
The final gate ran in the main checkout; all 244 tracked input hashes plus the
original diagnostic probe stayed unchanged through tests, types, build,
consumers and performance. This diary update followed the gate. The built ESM
SHA-256 is
`886a3dd527b0a2e9955f06c95fe2af96206f82e7f1a765a622f63bd8ddd8de19`.
The main declaration build caught two new `Array.flatMap` calls beyond the ES6
library target that the isolated build had accepted. Both calls were replaced
with equivalent ES6 iteration before this final full gate; the type target was
preserved.

Actual-package consumers passed **70 checks** in four batches (14 compact
persistence checks and the unchanged 18, 22 and 16 checks). They cover the real
schema/converter, English and Thai rendering, schedules and the eye-taper totals
of **296** drops, **388** after a dose edit and **184** after deleting its first
phase. The unchanged **521-input compatibility replay** reports zero failures,
populated-dose-value changes or dose-row-count changes. These batches overlap
and are not a unique-input total. A separate full HL7 validator run is not claimed.

Matched Node measurements compared the prior built package with the new
one in one process after warmup, alternating old/new order and taking the median
of seven batch means:

| Operation | Previous ms | Compact ms | Change |
| --- | ---: | ---: | ---: |
| Ordinary parse | 1.820 | 1.741 | -4.4% |
| Ocular parse | 1.771 | 1.830 | +3.3% |
| Conditional parse | 6.193 | 6.276 | +1.3% |
| Independent-taper parse | 6.027 | 5.285 | -12.3% |
| Thai parse | 6.738 | 6.912 | +2.6% |
| Taper export | 0.769 | 0.276 | -64.1% |
| Taper reopen | 0.512 | 0.277 | -45.9% |
| Taper schedule | 5.623 | 5.252 | -6.6% |
| Taper supply | 10.365 | 10.202 | -1.6% |
| Ordinary suggestions | 0.862 | 0.907 | +5.2% |
| Ocular suggestions | 0.902 | 0.907 | +0.6% |

These are shared-host measurements, not phone measurements or a claim of zero
runtime regression. This work changes persistence and reconstruction, without
expanding the grammar. The PR remains **99 reviewable files**: 114 changed paths
minus the existing 15 configured exclusions. No new reviewable path was added.


## 2026-10-25 — Conflicting compact phase edits require explicit resolution

Independent audit found a real omission in the compact persistence checks.
Editing only one phase-two row in the independent eye taper from treatment day
7 to day 8 left its peer row at day 7. Reconciliation retained both variants and
warned, but chose the first source row for the entire phase. On the built
package this removed all eight day-seven administrations and changed the
30-day supply from 296 to 288 drops. The previous green suite did not exercise
this same-phase executable disagreement; the concern was independently reproduced.

Executable disagreements in start, end, count, safety or modifier metadata now
retain a typed unresolved-context marker on the affected phase. Scheduling and
supply raise `conflicting-course-phase` until the conflict is resolved. IDs and
non-modifier annotations remain non-blocking, all row data and both source
variants remain available, and unaffected phases remain independently usable.
Reordering, R6 import, JSON persistence and re-export cannot silently remove the
conflict. Correcting the original disagreeing live row restores the 296-drop
course. After persistence, manually aligning both phase rows and removing the
acknowledged conflict marker restores the eight day-seven doses and 296-drop
total; this low-level recovery was verified through the actual downstream
schema/converter. At this point there was no public confirmation helper, and
editing the saved phase fields alone remained blocked. The follow-up below
adds that API. The existing extension profile documents the reserved marker.

Four primary/strict × right/left start-edit regressions failed against the prior
implementation before the fix. All five added tests, including harmless
annotation differences, pass. The final main-checkout gate passed
**3,444/3,444 source tests across 44 files**, TypeScript, ES6 ESM/CJS bundles and
declarations, and **4/4 packaged-export checks**. The unchanged **70 consumer
checks** and **521-input compatibility replay** pass. Four additional actual
schema/converter scenarios retain the conflict over three save/reopen cycles,
keep English and Thai rendering available, and verify explicit recovery.

All 245 tracked/probe input hashes stayed unchanged through the full gate and
consumers; the diary and a definition-only profile clarification followed it.
The profile's structural JSON is otherwise identical. All 91 built files
remained unchanged. Final ESM SHA-256:
`5d0cd5f826fec1a60531e695689760189155abe14dac7a28a3e01db2a8698995`.
The ordinary eye taper remains **9,926 bytes** in primary/strict R5 and
**10,604 bytes** after the actual schema save/reload. The PR remains
**99 reviewable files** (114 raw paths, 15 configured exclusions).

## 2026-10-25 — HPSG calendar days, weekly clocks and saved-phase recovery

Four ordinary clinical defects required changes to typed grammar, calendar
execution and course reconciliation. The 28-day examples below use an order
starting 2026-11-01 in Asia/Bangkok.

| Instruction / workflow | Previous behavior | Corrected behavior |
| --- | --- | --- |
| `1 tab PV HS twice weekly x28d` | 4 tablets | 8 tablets |
| `1 tab PO three times weekly HS x28d` | 4 tablets | 12 tablets |
| Daily bedtime for 14 days, then twice weekly | 16 tablets in 28 days | 18 tablets |
| `1 tab PO QD on days 1-14 of each month` | Calendar range became a dose range; 392 tablets | One tablet on each selected day; 14 tablets |
| Explicit cycle dates, November 3–7, without a redundant daily frequency | Supply rejected executable dates | 5 tablets; 3 when queried from November 5 |
| Correcting both rows of a previously saved phase conflict | Still blocked unless callers edited the reserved marker themselves | Explicit public confirmation restores eight day-seven administrations and 296 drops over 30 days |

### Typed ownership and execution

HPSG now owns `dayOfMonth` through a bounded monthly-day constituent: a headed
day noun, its ordinal/range or coordinated ordinals, and an explicit monthly
complement. Calendar numbers cannot become tablet amounts in this constituent.
The feature passes through unification, canonical projection and coordination.
An indexed prefix lookup keeps unrelated inputs on a short path; no general
reparse or additional schema-validation pass was added.

FHIR uses repeated `Timing.repeat.extension` entries with the standard
[`timing-dayOfMonth` URL](https://build.fhir.org/ig/HL7/fhir-extensions/StructureDefinition-timing-dayOfMonth.html)
and `valuePositiveInt`. Imports retain unrelated metadata. English and Thai,
short and long rendering, produce grammar-backed monthly phrases. Source-less
range, single-day and separated-day forms reparse into a single dosage of one tablet
with the same calendar membership.

Scheduling, supply and occurrence-cap history share typed calendar selection.
This includes elapsed intervals and explicit weekday intersections. Days absent
from a shorter month are omitted rather than moved to another date. Exact
dated events remain authoritative: a supplied month-day mask can restrict them,
but a query anchor cannot invent a weekday ordinal and discard their dates.

Weekly frequencies with bedtime, explicit clocks or meal events now use the
existing per-period distribution policy. Clock anchors retain the full
frequency. Offsets crossing midnight remain inside their actual query window,
and later queries consume the occurrence cap using the same schedule.
Finite exact-date courses no longer require an invented repeat frequency.

### Resolving a saved phase conflict

After correcting the live saved rows, callers can explicitly acknowledge the
affected phase through the existing public import function:

```ts
const course = toDosageDetails(correctedRows, undefined, undefined, {
  resolvedPhaseSequences: [2]
});
```

Only the selected phase's old conflict flag is eligible to clear. The current
rows are still compared, so confirming a phase whose live executable fields
disagree does not make it executable. Other missing course context stays
unresolved. The previous markers and unfamiliar extensions remain available as
source provenance, and plain import/save operations cannot silently clear the
conflict. This replaces the need for callers to remove a reserved extension
child themselves; it does not add a parser or preview refusal gate.

### Verification of the combined implementation

The main checkout passed **3,485/3,485 source tests across 44 files**, with no
skips or failures, TypeScript checking, ES6 ESM/CJS bundles and declarations,
and **4/4 packaged-export checks**. The follow-up adds 41 source regressions:
23 scheduling/supply checks, 13 HPSG/calendar-rendering checks and five saved
phase-recovery checks. Failures were reproduced before their corresponding
fixes, including the interval count/history and formatting integration defects.

All **15 built consumer batches** passed. The new **38 scenarios per module
format** traverse the actual downstream schema/converter for three save/reopen
cycles each. They cover weekly clocks, monthly days, leap and short months,
explicit dates, and correction of saved phase conflicts. The existing authority,
clinical-family, shorthand, ownership, API, clock/meal, label/cycle, compact
persistence and phase-conflict checks also pass. These batches overlap in
clinical inputs and are not a unique-input total.

The immutable **521-input compatibility replay** reports zero failures,
populated-dose-value changes or dose-row-count changes. The compact persistence
work remains intact: the independent eye taper is **9,926 bytes** in primary
and strict R5, versus **51,000 bytes** before compaction; after the actual schema
save/reload it is **10,604 bytes**. Native R6 remains **5,800 bytes**. Its
296-drop total, 388 after a dose edit and 184 after removing the first phase
remain verified. A separate full HL7 validator run is not claimed.

### Runtime measurements

After correctness jobs finished, sequential matched Node 22.22.0 runs compared
independent module instances with warmup, alternating execution order and the
median of seven batch means. The incremental five-input run used 30 warmups
and 50 parses per batch against the immediately preceding built package:

| Input | Previous ms | Current ms | Change |
| --- | ---: | ---: | ---: |
| Routine BID | 1.525 | 1.542 | +1.1% |
| Ocular QID | 1.406 | 1.422 | +1.1% |
| Thai BID | 3.555 | 3.508 | -1.3% |
| Two-phase course | 4.006 | 4.154 | +3.7% |
| Numeric HOLD | 4.606 | 4.415 | -4.2% |

The broader comparison against the package before compact persistence also
measured export, reopen, scheduling, supply and suggestions:

| Operation | Previous ms | Current ms | Change |
| --- | ---: | ---: | ---: |
| parse ordinary | 1.636 | 1.826 | +11.6% |
| parse eye | 1.818 | 1.765 | -3.0% |
| parse conditional | 6.085 | 6.127 | +0.7% |
| parse independent taper | 5.452 | 5.186 | -4.9% |
| parse Thai | 7.006 | 7.029 | +0.3% |
| export taper | 0.813 | 0.288 | -64.6% |
| reopen taper | 0.547 | 0.271 | -50.5% |
| schedule taper | 6.653 | 6.054 | -9.0% |
| supply taper | 12.637 | 12.075 | -4.5% |
| suggest ordinary | 0.865 | 0.887 | +2.4% |
| suggest eye | 0.879 | 0.863 | -1.8% |

The incremental changes range from -4.2% to +3.7%. The broader run observed
a 0.190 ms increase (+11.6%) for ordinary finite-BID parsing, while taper export
and reopen improved by 64.6% and 50.5%. These are shared-host measurements,
not phone measurements or a claim of zero runtime regression.

All **245 tracked/probe input hashes**, **91 built files**, and the consumer
harness/schema hashes remained unchanged through the gates and measurements.
This diary clarification followed verification. The original untracked probe
is unchanged and excluded from the commit. Final ESM SHA-256:
`933b2839f2d6634769a5930451c84d4da0f420aba1474bae7cde2841015ffe3e`.
The PR still has **99 reviewable files**: 114 changed paths minus the same
15 configured exclusions. No new path or exclusion was added.


## 2026-10-26 — EU/US terminology boundary (exact semantics, not label-matching)

Audited remaining local clinical codes against HL7 FHIR R5 structured Dosage, Timing, action relationships/conditions, SNOMED dosing-instruction fragments, EDQM, EMA SPOR units of presentation and UCUM. Official references:
- https://www.hl7.org/fhir/R4B/valueset-administration-method-codes.html
- https://hl7.org/fhir/R5/codesystem-action-relationship-type.html
- https://pms.ema.europa.eu/fhir/ig/CodeSystem-200000000014.html

Actual standards changes: eight SNOMED conditional/temporal instruction fragments (with, before, during, then, until, if, when, to) now serialize as standard Coding; action-to-action before/after uses HL7 ActionRelationshipType, not generic event/meal timing. Seven reference phrases (each dose, injection, use, administration; first use; before first use; after first administration) and broken skin now serialize coded constituents rather than invented whole-phrase Codings. The broken-skin SNOMED concept is explicitly a DISORDER/finding, not an anatomical Dosage.site. Eight EMA presentation units were added only when no EDQM mapping already existed.

Remaining locally encoded **actions: 62**. These are 1) 9 context-sensitive control/advice directives (notify, avoid, observe, wait, miss, double, adjust, repeat, pause-use); 2) 39 product, site, container and device manipulation verbs (recap, pour, rub, spread, dab, lather, clean, douche, dry, cover, leave, wipe, swab, discard, spit, prime, draw_up, attach, detach, rotate, reapply, moisten, part, stir, hold, close, press, warm, keep, pump, fold, pinch, aim, touch, change, squeeze, pull, wear, open); 3) 11 posture/respiration/site-care actions (remain-upright, exhale, blow, tilt, blink, lie-down, blow-nose, keep-ear-upward, keep-ear-dry, aim-away-from, wash-hair-out); 4) three context-composed instructions (shake, drink, eat-food). Many have a standard code for an ENTIRE qualified instruction (e.g. shake-before-use) or a PERFORMED procedure, but the isolated verb is not itself that concept. Do not substitute a performed-procedure code for a future patient directive.

Remaining locally encoded **concepts: 23**. Unresolved references/quantities/result states: medication-dose, supply-exhausted, whole, same-time, administration-site, product, area, use, clean-result, needed, absorbed, dissolved. Ambiguous device/container objects: bottle-tip, tube-tip, nasal_spray, occlusive_dressing, foam. Nonspecific site/substance: external_intimate_area, alcohol. Activity references: breath, washing, showering, going_outdoors. For example, SNOMED nasal-spray 385157007 is a PHARMACEUTICAL DOSE FORM for FHIR Medication.doseForm, not necessarily the physical device in a priming instruction. Do not attach that code to the ambiguous object.

Remaining **grammatical relation surfaces: 9**: without, after, between, for, in, into, on, unless, while. The before/after action-edges are now standard-coded; as a standalone adjective it may mean a meal or temporal anchor, not a PlanDefinition action edge. Unless is conditional negation, not automatically a contraindication. Remaining eleven anatomical locative surfaces: around, near, outside, between, along, left side, right side, both sides, bilateral sides, at, where. The L/R/bilateral semantics already use SNOMED laterality on the site itself; the others do not have an exact matching anatomical modifier in all of their supported contexts.

Remaining **nonstandard unit labels: 26/81** (29 EDQM, 8 EMA, 18 UCUM directly coded): pump, click (device calibrated); dropperful, capful, scoop, pea-sized amount, shot glass, finger length, FTU (product-dependent); drop/min, cm ribbon, inch ribbon, cm strip, cm line, inch line, palm, handprint, % BSA (compound dose quantities, with physical dimension/method/site to be represented separately rather than mis-coding the entire unit); ovule, enema, wipe, stick-pack, softgel, nebule, respule, pod (names are often dose forms or package-specific aliases, not verified general units of presentation). Two typed internal medication-condition discriminators measurement/expression remain for the R5 modifier expression tree; these do not claim that underlying measurements or symptoms lack SNOMED/LOINC coding.

The audit stops only at the semantic boundary: external code equivalence MUST preserve the same role (dose form vs device, disorder vs anatomy, timing event vs lexical preposition, planned instruction vs performed procedure). No new NLP passes, hard stops, or runtime terminology-service calls. No assertion that the entire international SNOMED ontology has been exhaustively searched.


## 2026-10-26 — Owner correction: ALL local codings retained, standards additive

OWNER'S NON-NEGOTIABLE DIRECTION: never delete proprietary codes, typed
semantics or source. Use exact standard codings *in addition* when present;
replace a local code only when the owner authorizes an equivalent and no
meaning is lost. The preceding commit 4964e76 mistakenly removed local
action/concept fallback Codings and R6 measurement/expression discriminator
Codings. This has been reversed. Complete typed clinical FHIR is the product;
a bare predicate lemma is NOT a substitute for its established local Coding.

Restored the original action and concept coding functions from de0dfa0.
Kept exact LOINC measurement codes as additional Codings behind the original
local medication-condition/measurement Coding; expression retains its local
Coding and structured extension. New bottle-tip, tube-tip, and occlusive
dressing compositions retain the original local whole-object Coding (including
Thai translation), plus their independently coded SNOMED constituents. SNOMED
Use stays alongside, not instead of, the original local use Coding. The
local CodeSystem definitions continue listing these complete-phrase codes.

Verified against an isolated BUILD of exact de0dfa0, not guessed source:
- 112 existing instruction actions / 121 prior Codings: 0 removed.
- 81 instruction concepts / 75 prior Codings: 0 removed.
- Action local CodeSystem 62 -> 62 and concept CodeSystem 23 -> 23;
  no removed concept IDs; existing coded components preserved.
- 235 distinct real clinical SIGs, 705 comparisons across primary FHIR,
  native R6 and strict R5: 3,415 previously emitted coding instances retained,
  0 missing; 19 additional coding instances, zero clinical structural changes,
  zero new parsing exceptions.
- Full 44-suite source tests 3,654/3,654 PASS. The giant absence-of-local-code
  tests introduced by the incorrect commit were removed, not retained; focused
  clinical tests verify rich bottle-tip/verb coding, swallow-with-water and
  R6 measurement local+LOINC round trips.
- Existing unrelated / pre-existing untracked probe remains untouched.

Retain the real CodeRabbit accompaniment fix (water is not the drug referent)
and the Thai activity source lookup. No new validation layers, no subagents,
no package publishing/merging. No code, comments, review messages or PRs
should claim local medical codings are disposable.


## 2026-10-26 — Additive terminology second pass + post-restoration CodeRabbit review

OWNER CONTRACT: NEVER delete, replace, or suppress rich local clinical Codings; add exact external equivalents next to them. In particular: 62 proprietary action CodeSystem members and 23 proprietary concept CodeSystem members must remain after applying external mappings. No new mandatory parsing or terminology server requests.

New verifiable US/EU codings: official HL7 THO UCUM common list documents [drp]/min; UCUM cm, [in_i], and % cover lengths of medication ribbons/strips/lines and percent body surface area, with original full unit labels retained. Drop factor and topical FTU quantities are device/product-dependent; this coding pass does not infer a gtt/mL conversion, or assert FTU has an exact universal mass. NLM MeSH 2026 descriptors: Blinking D001767, Exhalation D045853, Drinking D004326, Eating D004435, Breath Holding D062485 (only when the HOLD action is attached to the typed BREATH object). All action entries keep the original full local Coding as primary with NLM mapping additional. SNOMED CT 255503000 Entire qualifier supplements, not replaces, the local whole-tablet manner code. NLM FHIR canonical CodeSystem URL verified as https://www.nlm.nih.gov/mesh by HL7 THO. Sources: https://meshb.nlm.nih.gov/ , https://terminology.hl7.org/ , https://hl7.org/fhir/us/mcode/STU2/ValueSet-mcode-radiotherapy-treatment-location-qualifier-vs.html .

Researched but NOT blindly assigned: FDA/NCI Thesaurus C38286 Occlusive Dressing Technique is a FULL topical administration technique, not a code for the dressing object or isolated cover verb. MeSH Baths is broader than washing/showering, not an exact standalone event. EDQM/EMA SPOR unit list 200000000014 lacks exact wiped/softgel/nebule/respule/ovule/FTU/pump/click presentation units, so no lookalike codes were attached.

Three latest CodeRabbit review findings (all reasonable and reproduced): explicit year-first Buddhist date now honors datePolicy.calendars when Gregorian-only; source-less guarded/max-dose FHIR renders true condition and date exclusions in formatSig and imported short/long text. No FHIR Coding touched in these fixes. Direct built FHIR and date-policy probes pass. Complete 44-file source suite 3654/3654 green; npm build ESM/CJS + TS declarations and packaged exports 4/4 passed. Frozen pre-destructive de0dfa0 vs current: 235 distinct realistic SIGs x primary/native R6/strict R5 = 705 checks, 3415 old coding instances retained, zero missing, +28 external instances, no clinical structure changes. Independent CodeSystem comparison: action 62->62, concept 23->23, no deletion. Host-only seven-case median parse deltas -4.4% to +6.4%, no additional parser or validation pass. User explicitly rejects useless regression-test proliferation; no test files added in this pass.


## 2026-10-26 20:33 ICT — EU/US terminology exact-equivalence audit, additive only
Authoritative release/lookup coverage: NCIt 26.09d official NCI EVS REST concept search + definitions, US SNOMED CT 2026-03-01 same endpoint and FSN types, NLM MeSH, HL7 THO, FHIR R5, EDQM/EMA SPOR, and UCUM. Multiple separate lexical/alias/context queries were made for all previously unmapped instructions, concepts, relations and units. Explicit matches are additional; never delete own full local Codes. This is an exhaustive *practical* pass over the available concepts in these relevant sources, not proof no code exists in any extension/edition anywhere.
Code additions since bb74df5: NCIt topical product dosing units FTU C71321, capful C102405, pump C111984, nebule C71204; SNOMED product usage units dropperful 421954001, scoop 415505006, pea-sized amount 769392001, enema presentation 1382282001. Complete topical APPLY+COVER WITH OCCLUSIVE DRESSING has HL7 v3 RouteOfAdministration OCDRESTA, NCIt C38286 and SNOMED CT 447056002 in the method/route Codings; the object has MeSH D009779 and its previous original local identifier plus SNOMED head. Negative cover and unrelated oral scenarios never acquire that technique. Further direct NCIt action codes added with local identifier first (notify, avoid, shake, spread, clean, douche, dry, cover, discard, observe, stir, change, wear, repeat), SNOMED event Dabbing 1254782007, Double 1305003; NCIt dose adjustment C82495 only for adjust + explicit medication-dose. NCIt concept Dose C25488, Exhausted C200475, Application Site C77676, Product C51980, Monitoring C61256; SNOMED Breath 11891009, Needed 410525008 and coded constituents for washing and outdoors. Exactly-coded adjective/spatial relations now include SNOMED Without 45169001, After 255234002, For 86495002, In 18720000, Into 30507006, On 420862001 and NCI Between C94545; anatomical around/near/outside/between/at and bilateral/left/right; While is deliberately local because using the SAME code as During caused ambiguous reverse FHIR roundtrips.
Remaining local-only action categories (42):
- device / container manipulation, whose object or dose-dependent meaning cannot be inferred from the bare verb: recap, pour, prime, draw_up, attach, detach, pump, fold, pinch, aim, squeeze, pull, open, close
- patient positioning and topical/site-care verbs; found possible *objects, findings or performed procedures*, not equivalent patient dosing imperatives: rub, lather, leave, wipe, swab, spit, moisten, part, press, warm, remain-upright, keep, touch, blow, tilt, lie-down, blow-nose, keep-ear-upward, keep-ear-dry, aim-away-from, wash-hair-out
- conditional/temporal/administration-control lexemes whose coding requires argument, polarity or event scope: wait, rotate, reapply, hold, miss, adjust, pause-use
Remain direct/independently referenced concepts (9): absorbed, alcohol, area, clean-result, dissolved, external_intimate_area, foam, nasal_spray, same-time. Reasons: alcohol ambiguous ethanol vs alcoholic beverage; same-time requires a linked second event; area has no referent; foam is lather product, not pharmaceutical foam; external_intimate_area lacks an exact sex/site-specific structure; nasal_spray could be device or dose form; clean-result denotes resulting state, not a Wash action; absorbed/dissolved require material, site, process and completion context. Current coded components for other concepts are retained.
Remaining uncoded unit labels (11): shot glass, finger length, palm, handprint, ovule, wipe, stick-pack, softgel, respule, pod, click. Context limitations: variable volumes/device calibrations (shot glass, click), vague body-area proxies (finger length, palm, handprint), and form/package/brand terms without a directly verified **unit of presentation** (ovule, wipe, stick-pack, softgel, respule, pod). NCI Softgel pharmaceutical dose form, SNOMED Foam basic dose form, Shower physical object, Spitting observable, Injection-site morphologic abnormality, and SNOMED Hold meaning **withhold administration** were *not* mislabeled as equivalents to unrelated patient instructions.
Remaining grammatical relations: Unless (compositional negated conditional), While (overlap/event condition); spatial Along (axis depends on target), Where (symptom referent grammar). These keep original local FHIR graph meaning. Full custom local CodeSystem resources/action IDs/Thai+English outputs are NEVER replaced by standard components. No new global parser passes, terminology network calls, safety checks, or forced data removal.

Final qualification of this exact standards pass: 112 actions = 70 direct external coding matches and 42 local-only, several of which have context-specific coded combinations; 81 concepts = 56 direct external, 16 externally composed, nine standalone local-only. 81 dose-unit labels = 70 coded, 11 device/brand/product context-dependent. 17 advice relations = 15 standardized; 26 site relations = 24 standardized. See preceding categorized remaining lists. This is NOT a claim that any future US/EU edition or focused terminology extension cannot add more.

Independent frozen prior-code auditor compared 235 realistic source inputs across primary, native R6 and strict R5 representations (705 distinct wire outputs): all 3,415 historical Coding occurrences retained, zero missing, 124 additional Coding occurrences in this sample, no compared clinical structure changes, zero parser exceptions. Definition auditor confirms no loss of the original 121 action Codings and 75 concept Codings (full 112/81 lexicons), and both local CodeSystem enumerations remain 62/23 entries. 44 source suites 3656/3656 PASS, ESM/CJS and TypeScript declarations build PASS, packaged exports4/4 PASS; all new source paths already in the 100-reviewable-file PR scope. No unreviewed new production modules or new dependencies. Matched warm nine-input host Node24 medians compared to immutable de0dfa0 bundle: routine/everyday cases -2.8% to -0.3%, multi-site eye taper -2.8%, specific coded instructions -2.9% to +2.4%. Generated FHIR clinical metadata increases only for additionally coded cases; original dose, source and local vocab never removed. This performance test is host-side, not a mobile benchmark.


## 2026-10-26 — Standard-coded action constituents and anatomy (post-audit)
Verified against SNOMED CT US 2026-03-01 and NCIt 26.09d terminology.
Finding/posture codes MUST NOT be substituted as equivalent imperative codes.
True SNOMED postcoordination requires valid MRCM domain, attribute and range rules.
Added independent semantic components to action graph predicates with an explicit role;
they survive R5 graph FHIR serialization, without being merged into predicate.codings.
Original in-house action codes remain unchanged and all components are additive.
- remain-upright: NCIt C86043 Upright (target-state).
- lie-down: SNOMED 102538003 Recumbent body position (target-state).
- spit: SNOMED 12405001 Spitting (activity).
- swab: NCIt C17627 Swab (technique).
- reapply: NCIt C47886 Repeat plus SNOMED 738991002 Apply (operation, technique).
- blow-nose: NCIt C12756 Nose (target-site).
- keep-ear-upward and keep-ear-dry: NCIt C12394 Ear (target-site).
Registered SNOMED 77142006 External genitalia structure alongside original
local external_intimate_area Coding; added the same exact site alias to the
primary dosage-site terminology. Existing canonical site mappings remain.
These constituents are standards-coded structured semantics, NOT certified
SNOMED postcoordinated expressions; unresolved action codes are not claimed
to have exact whole-instruction equivalents. No terminology network runtime.


## 2026-10-26 23:02 ICT — context-accurate terminology constituents, additive only

Real requirement and independent oracle: "rotate injection sites" is alternation of application sites; "rotate bottle" is physical rotation. The initial unconditional SNOMED 49572008 Alternating would have misrepresented the second ordinary clinical instruction, so it was replaced by typed contextualSemanticComponents keyed to existing parsed conceptId administration-site (49572008 Alternating) or bottle (257912008 Rotation - action). The same generic argument matcher now serves both contextual coding and constituent mapping, in both primary HPSG and optional semantic-resolver paths. No new lexical pass, tokenizer, FHIR reinterpretation, network lookup, guard, dependency or data-loss fallback.

Verified against official NCI EVS SNOMED CT US 2026-03-01 and NCIt 26.09d: action components added to rub (Friction physical force 263762005), press (Pressure - action 257893003), squeeze (Compression - action 263720003), moisten (Wet 17461003), part hair (Hair structure 386045008), wash-hair-out (NCIt Rinse C65120 plus Hair structure), keep-ear-upward (Upward 353734004), keep-ear-dry (Dry 13880007), pause-use (Hold dosing fragment 421139008), miss (Missed dose situation 1269470004), close (Closed qualifier 29179001), recap (Cap physical object 228254002). Whole-action lexical "Open" has exact SNOMED 312336005 Opening - action alongside the explicit original local Coding, not replacing it. Existing local codings remain authoritative where the external item is merely a state, finding, qualifier, procedure fragment, substance or anatomical constituent.

Hold breath: existing MeSH D062485 retained; NCIt C192566 Voluntary Breath Holding is a second exact contextual coding only for a typed breath object. Generic "hold eye closed" does not gain either breath-holding code. The clinical term Breath Holding NCIt C121558 was specifically rejected because it defines involuntary pediatric breath-holding spells, not an instructed maneuver.

The original local whole-concept Coding is explicitly retained for nasal_spray (SNOMED 738948007 Nasal intended-site constituent), absorbed (NCIt C71731 Material Absorption underlying process), and dissolved (NCIt C64929 Dissolve underlying process). These constituent mappings do NOT assert equivalence to the entire nasal spray device/product or completed/result state. Remaining local-only concepts: alcohol (ambiguous chemical vs beverage), same-time (missing linked event), area (missing referent), foam (lather vs pharmaceutical dose form), clean-result (a resulting state, not NCIt Clean action). Do not attach misleading lookalike codes.

Twenty-two currently unmapped action lexemes remain with no verified exact whole-action/constituent mapping in this pass; candidates such as SNOMED Hold for holding an object, fracture Fold, oral Rinse administration for washing medication out, specialized traction therapy for pulling a cap, and dose-form Foam for lather were rejected as different kinds of thing. Externally coded semantic components are structured FHIR graph extension parts, NOT MRCM-certified SNOMED postcoordination expressions. Any future formal SNOMED expression still needs official MRCM validation. All previous action/concept identifiers checked additively against prechange HEAD with zero deletions; parser and FHIR round-trip probes cover actual argument contrast.


## 2026-10-27 — Review follow-up: Thai site-anchor ambiguity and combined oral rinse routes
Addressed CodeRabbit PR#10 comment 4378045429: Thai ที่ has BOTH locative anchor and site-relative WHERE lexical readings. Keep both signs only for a declared SITE_ANCHOR; other relative markers preserve the previous marker-only behavior. Verified directly from real tokenize() + siteLexicalRule() for ทาครีมที่แขนวันละ 2 ครั้ง: both lexical signs present, coded arm site 302538001 and frequency BID retained. Existing other site and language tests remain.

Official HL7 THO RouteOfAdministration SWISHSPIT and SWISHSWAL, and NCIt C38302/C38303 respectively, now annotate COMPLETE ordered, positive oromucosal techniques. Swish+spit is not attached if a different primary oral/topical route/method already exists. Swish+swallow is only annotated for the source-consistent mL liquid dose with swallow method, not for tablet/capsule ingestion, spitting, or a mixed take+swish instruction. Original local SWISH/SPIT and other graphical action codings, dose values, route and bilingual realization are always retained. Both techniques explicitly round-trip into strict R5 and native R6 without datatype reparse.
NCIt C149756 Pessary Dosage Unit now codes pharmaceutical ovule counts, preserving the specific original ovule unit label. This is a presentation-unit code, not an ovulation finding.
Only existing PR reviewable source and test paths changed. No new runtime terminology lookup, backward compatibility hacks, novel parser pass, or global safety gate. The untouched pre-existing untracked test/__tmp_open_semantic_probe.ts remains in place.


## 2026-10-27 — Second cross-system terminology audit (additive)

Audited the remaining 22 generic action lexemes, five concept lexemes, ten dose labels and four relations. Sources: NCI EVS REST NCIt 26.09d, SNOMED CT US 2026-03-01 including the 390-descendant Action qualifier hierarchy and 48-descendant Additional dosage instruction hierarchy; NLM MeSH terms, published HL7 v3 ActCode (1302), ActClass (126), EntityHandling (18), ActRelationshipType (141), RoleCode (413); EDQM presentation/dose form (2025 open CodeSystem, 2026-01-30 released edition identified); FDA SPL units. Source versions: the current US September 2026 and International October 2026 releases were noted, but the public NCI EVS API exposes March 2026 US SNOMED, so this is not an exhaustive proof about the newer extensions or editions.

Exact action equivalences found and added, always AFTER the existing local coding: attach = NCIt C61470 Attachment ("The act of affixing one thing to another"); detach = NCIt C212037 Disconnect ("To break the connection of or between things"); adjust = SNOMED 129426002 Adjustment - action (qualifier value) and NCIt C49157 Adjustment (the act of making necessary corrections or modifications). Existing contextual NCIt C82495 Dose Adjustment remains for explicit dose arguments; generic actions never require optional arguments to justify a generic coding.

Additional independently coded constituents, NOT alternatives for whole action and NOT necessarily SNOMED postcoordination: warm = SNOMED 88999006 Heat (physical force) mechanism; pull = SNOMED 129411004 Traction - action (qualifier value) constituent rather than specific therapeutic traction; tilt = SNOMED 257912008 Rotation - action (qualifier value) constituent rather than a complete tilt instruction.

New unit coding: respule = NCIt C71204 Nebule Dosing Unit, supported by current manufacturer-published descriptions of Respules as single-dose plastic containers for nebulizer solution. Source amount and unit label remain, with no universal fixed mL conversion. EDQM generic Capsule UOP, FDA CAPSULE and NCIt Softgel pharmaceutical dose form do not by themselves preserve the full meaning of a Softgel unit without modeling both count and formulation. Wipe is not automatically Pad/Swab, click is not automatically delivered Actuation.

Rejected misleading direct action equivalences:
- NCIt C103237 Decant is liquid transferred between containers, narrower than generic pour (which can be poured onto a surface).
- NCIt C25476 Delay is a waiting time/state, not the patient waiting action.
- NCIt C38535 Touch is a tactile sensation, not generic contact action.
- SNOMED Fold is a morphologic abnormality; Pinch grip is not arbitrary pinching; clinical therapeutic traction procedure is not simply pulling a device.
- Device detachment problem terms describe device failures, not patient device-disconnection instructions.
- Heat findings are not warming actions.

Additional unresolved concepts/relations:
- SNOMED 79970003 Simultaneous and NCIt C25456 Concurrent are valid, but the registered same-time lexeme includes usual time and a consistent clock-time each day, which need not mean simultaneous administration. Do not assign these unconditionally.
- NCIt C2190 Alcohol chemical versus alcoholic beverages; SNOMED 42798000 Area is not a resolved anatomical region; SNOMED Foam basic dose form is not soap lather; NCIt Clean is an action, not the resulting state.
- While can be temporal overlap or conditional scope; do not confuse with existing During. Unless, Along, Where retain their typed grammar semantics.
- Remaining device/package/body area units retain their original labels; no approximate conversions or silently broadened unit codes.

Every original identifier must remain; no parser pass, validation gate, runtime terminology fetch or new dependency. Use typed constituents where exact wholes do not exist. MRCM certification is necessary before claiming a formally valid SNOMED postcoordinated expression.
Verification: exact generic attach/detach/adjust actions parse with no optional argument; typed instruction graph external/local Codings survive FHIR serialization; explicit medication dose adjustment adds its previously verified contextual NCIt C82495. Warm/pull/tilt standard-coded components round-trip independently of the original local predicate codes. Respule and nebule both encode NCIt C71204, with independent source unit labels and no click→actuation substitution. Frozen pre-edit action 112/112 and concept 81/81 definitions and all historical direct local/external Codings preserved. All 44 source suites 3696/3696, ESM/CJS + TypeScript build, packaged exports 4/4 PASS; git diff --check clean. Remaining 16 generic action lexemes lack direct or constituent exact standards in this mapping pass; five concepts and nine unit labels remain unmapped, plus four logical/spatial relation kinds. No additional production source files.

## 2026-10-27 — Open English WordNet 2025 external sense anchors (additive)

The publisher's RDF Lexicon / ConceptSet URI is https://en-word.net/ . All Open English WordNet Coding.version values are 2025. Coding.code is the exact WN-LMF synset identifier, e.g., oewn-02073479-v. All 17 distinct synsets were checked against the original pinned 2025 XML release, not just the changing live web API. Attribution: Open English WordNet community, https://en-word.net/; CC BY 4.0, https://creativecommons.org/licenses/by/4.0/ . CILI references are available in this release but are deliberately not duplicated into additional Coding entries.

Exact external equivalents now accompany, never replace, the original local action code in predicate.codings: pour 02073479-v, lather 00513124-v, leave 00136799-v, wait 02647547-v, fold 01280538-v, pinch 01459400-v, aim 01153576-v, touch 01208838-v (all prefixed oewn-). Partial meanings remain in semanticComponents, not in the alternative whole-action Coding array: wipe -> rub with pressure 01252288-v, draw_up -> remove liquid from container 01858118-v, pump -> operate pump mechanism 01228248-v, blow -> exhale forcefully 00007012-v, blow-nose -> clear by blowing 00034941-v, aim-away-from -> aim 01153576-v (direction separately typed). WordNet's circular-only wipe sense and priming-liquid/gun senses are too narrow; prime only gains SNOMED Preparation - action 367559008 as a constituent.

Bare hold is ambiguous, so its original local coding remains without a WordNet synonym: breath takes oewn-00004492-v in addition to preexisting MeSH and NCIt; typed bottle/inhaler/syringe arguments take oewn-01219234-v (grip); hold dose never gains a physical-holding WordNet code. Keep remains local without a verified exact whole-meaning synonym. For instruction result concepts, foam has oewn-09462117-n (soap/detergent froth) and clean-result has oewn-00418932-a (clean state), both with original local code first. Alcohol (chemical vs beverage), same-time (simultaneous vs usual clock time), and area (anaphoric referent) remain locally coded, not mislabeled.

FHIR Coding.version is preserved by existing CodeableConcept/graph serialization and typed clone paths. No new parser pass, dependency, network call or extra semantic engine. Roundtrip tests cover exact vs partial meanings, two hold senses and holding a dose, whole-code and constituent meanings, and a real parsed FHIR dosage. 44 suites: 3714/3714 source tests pass; ESM/CJS + TypeScript declarations build; four packaged export tests pass. Comparison against frozen HEAD confirms all 112 action, 81 concept definitions and all prior identifiers retained. Created as a <=100-file stacked review slice because existing PR #10 already exceeds 100 files.

CodeRabbit's latest PR #10 missing-oracle-ID test-collection suggestion was reviewed, replied to and resolved as unnecessary defensive test-only logic: inconsistent checked-in corpus identifiers already fail the suite, with no connection to clinical parser correctness.

## 2026-10-28 — PR #10 review: typed before-drinking reconstitution; exact HL7 EntityHandling displays

**Decision gate.** These are supported clinical inputs, not hostile test strings: ordinary instructions to dissolve/mix medication in water *before drinking* are semantically the same preparation-before-consumption relationship as before taking, while "without water", "after drinking", no timing, and negated instructions are not. Parsed HPSG action frames already carry positive `dissolve`/`mix`, `water` substance with IN/WITH, and separate `drinking-activity` typed BEFORE argument. The declarative SNOMED `417995008` matcher previously accepted only `medication-administration`, causing a false negative. The same matcher now accepts both recognized consumption activities with its existing material, polarity, temporal gates unchanged. No second parse pass, keyword-only inference, special-case FHIR repair, additional dependency, or source information loss. The prior test expecting *no* code for "dissolve in water before drinking, may cause vomiting" was updated to the supported clinical interpretation, while material/negation/temporal negative controls remain present. Strict R5 export/import and graph argument preservation tested.

**HL7 coded meaning vs patient-facing text.** Checked official HL7 Terminology v3 EntityHandling CodeSystem: PRTL `Protect from Light`, DRY `dry`, UPR `upright`, REF `Refrigerated temperature`, plus PSA `do not shake`. The action entries now use official `Coding.display` strings while retaining all existing `definition.display`, EN/TH `i18n`, aliases, concepts, and parser semantics. The advice-rule PRTL and PSA coded display strings are also corrected, preserving their exact patient-facing `text` and `thai` fields. No original code ID or coding system removed. Reference: https://terminology.hl7.org/7.4.0/CodeSystem-v3-EntityHandling.html . SNOMED official R5 additional instruction display for 417995008: https://www.hl7.org/fhir/R5/valueset-additional-instruction-codes.html .

Validation: 44 source suites `3769/3769` passed, ESM/CJS build + TS declarations passed, packaged exports `4/4` passed. All changed files were pre-existing in PR #10's 100 CodeRabbit-reviewable files; the raw PR file count remains 119. The unrelated untracked `test/__tmp_open_semantic_probe.ts` was not modified or staged.

## 2026-10-28 — PR #10 CodeRabbit: QOD lexical ambiguity and open-wound morphology

**Thai QOD and holiday exclusion.** The review identified a real alternative lexical sign: broad substring matching on `เว้น` treated bare `วันเว้นวัน` (QOD/every other day) as an unresolved calendar exclusion. The alleged lost QOD schedule did not reproduce in the selected full parser output: an actual `รับประทาน 1 เม็ด วันเว้นวัน ยกเว้นวันหยุด` retained period=2d and the independent, source-preserved unresolved holiday exclusion. Nonetheless the extra chart sign was wrong and wasteful. The correction reuses the existing typed `EXCLUSION_CUE` in `calendarExclusionLexicalRule` instead of its broad independent regex. A direct lexical RED/green test confirms no exclusion sign for bare QOD, and clinical/FHIR tests verify two-day cadence alongside recognized Sunday exclusions or unresolved source-defined holidays. No new parse pass, validation gate, or fabricated holiday calendar.

**SNOMED open wound coding — preserve site morphology, not a trauma diagnosis.** The review proposed replacing `59091005` with `125643001` in the two SITE definitions. Verified the concepts are not equivalent: `59091005` is SNOMED CT **Open wound (morphologic abnormality)**; `125643001` is **Open wound (disorder)**, a disorder defined by open-wound morphology **and a traumatic-event etiology**. EZMed's site entries apply to instructions such as `Apply ointment to open wounds` / `Do not apply to open wounds`; this source does not establish a diagnosis or trauma. Keep the original `59091005` morphological site descriptor and original English/Thai labels rather than overasserting a disorder in Dosage.site or an instruction-graph site argument. This is a semantically grounded rejection of the suggested substitution, not a missed missing-code lookup. Verified using SNOMED structural records: https://termhub.atlassian.net/wiki/spaces/SnomedExpo/pages/27838738 and https://termhub.atlassian.net/wiki/spaces/SnomedExpo/pages/27939615 . Existing real clinical site tests check the retained code. No original terminology coding was deleted.

Validation: 44 source suites `3773/3773` passed, ESM/CJS + TypeScript declarations build passed, packaged-export tests `4/4` passed. Changed only already-reviewed files; 100 reviewable file limit remains. The unrelated untracked `test/__tmp_open_semantic_probe.ts` remains untouched.

## 2026-10-28 — PR #10: four source/clinical data-integrity review fixes

**PRN infusion caps.** Ordinary `Infuse 25 mL IV over 1 hour as needed for pain` previously projected `timing.repeat.count: 1`, inventing an absolute administration limit for an uncadenced PRN treatment. The existing typed clinical-quantity projection now infers a one-occurrence count only if neither HPSG nor ParserState denotes PRN. Explicit one-time counts and recurring schedules remain unchanged; the administration-duration daughter still projects as duration, never as a course bound.

**Inherited coordinated site provenance.** A later dose segment inheriting the previous `scalp and forehead` target group retained the donor's site and target ranges, causing `rebaseParseResult` to shift those ranges into unrelated full-input offsets. Only the inherited group's semantic values remain; the recipient drops all donor-local group/target ranges, evidence, and restriction/marker/predicate ranges. The recipient group and nested restrictions are copied without sharing donor reference objects. The first clause retains its own exact ranges. Sync and async full-input projection tests verify dose, site coding, and source-coordinate isolation.

**Thai compact fractional dose.** `รับประทาน ๐.๕เม็ด วันละ 2 ครั้ง` previously split at the Thai decimal point and parsed zero plus a separate five-tablet clause: a real wrong-dose defect. The existing surface sentence-boundary guard now treats Thai digits as numeric neighbors, as it already did for ASCII digits. The Thai lexer subsequently recognizes 0.5 as one numeric token with the original exact source span. Tests cover compact Thai, spaced Thai and compact ASCII fractions and the correct single-dose FHIR output.

**Timing.code text-only round-trip.** Local regimen abbreviation identities `QHS`, `QAM`, `QPM`, and `BLD` were emitted in FHIR `Timing.code.text` but lost on `canonicalFromFhir` / `parserStateFromFhir` import. Extended the existing anchored text-code recognizer by only these four registered local abbreviations; coded GTS identities and arbitrary prose are unaffected. Tests cover R5/R6 export/import and original timing features.

All four were demonstrated RED before edits and GREEN afterward. Full source suite: 44 suites, 3783/3783 tests PASS; ESM/CJS builds, TS declarations, and packaged exports 4/4 PASS. No new reviewable files, network runtime, parse pass, warnings-as-errors, or mandatory safety gate. PR #10 remains at 119 raw files, 100 CodeRabbit-reviewed. The unrelated untracked `test/__tmp_open_semantic_probe.ts` was left untouched.

## 2026-10-28 — PR #10 review: monthly cadence, weekday exclusions, exclusion scope and method evidence

**Monthly-day schedule is a real supported clinical SIG.** `Take 1 tablet on days 1-5 of each month` previously retained `dayOfMonth=[1..5]` but had no frequency/period, so due-dose generation returned no administrations. A typed post-unification HPSG default supplies one administration per selected calendar day **only when** there is no independent frequency, interval, occurrence cap, event or clock. A separate BID in either position remains BID. Independent supply and due-date oracles validate 5 daily administrations in November plus 5 in December 2026, and 10 per month with BID, through both direct FHIR and strict R5/R6 representations. No FHIR-stage invented cadence or added parse pass.

**Weekday-only cadence is sufficient for a real exact-date exception.** `Take 1 tablet M/W/F except 2026-11-04` previously dropped the date exclusion and scheduled a dose on the excluded Wednesday. The typed clinical adjunct projection now accepts a declared day-of-week/day-of-month/calendar-event schedule as an administration cadence in addition to numeric frequency and clock anchors. FHIR preserves `excludedDates=["2026-11-04"]`; due-dose oracle excludes that Wednesday while retaining the surrounding Mondays/Fridays.

**Anchor each calendar-exclusion sign and retain following cadence.** The prior `matchCalendarExclusion` always considered the first cue in the full text, even when a later HPSG lexical sign was being constructed. The optional source-offset parameter now anchors the correct cue. For an unresolved holiday exclusion, the existing timing lexical signs locate the first following complete cadence and limit the scope before that sign, using the already installed `timingLexicalRule` and `countFrequencyRule`. Example: `Take 1 tablet except holidays BID` now retains BID while preserving `except holidays` as unresolved/editable source; `except public holidays twice daily` also preserves its BID-equivalent cadence; a known `except Sunday BID` remains a recognized Sunday exclusion with BID. The extra lexical-sign check runs only when an explicit calendar-exclusion rule is invoked, not on ordinary SIG input. This is not a second overall parsing pass.

**Method provenance.** `shiftCanonicalSigClauses` now rebases method evidence exactly like route, site and dose evidence, using its existing `WeakSet` to avoid double-shifting shared spans. A direct realistic method evidence oracle was RED before the change and GREEN after it.

Decision gate: all four findings are supported clinician-facing input/known typed provenance, with confirmed wrong or missing semantics; no automatic prescribing guard, hard stop, parsing dependency, or original coding/source loss. Full source suite `3790/3790` across 44 suites PASS, TypeScript + ESM/CJS declarations build PASS, packaged exports `4/4` PASS. Existing PR #10 review cap remains exactly 100 files; unrelated `test/__tmp_open_semantic_probe.ts` untouched.

## 2026-10-29 — PR #10 CodeRabbit review loop

Four current review findings verified against real parsing/clinical examples and fixed in existing layers:
- Coded swallow-whole (SNOMED 418693002) previously reconstructed only negative crush/chew from the advice template. Add the affirmative swallow/manner=whole frame so an imported coded instruction retains both the positive and negative meaning. Test imports coded FHIR Dosage, not just source text.
- Registered anatomical site alias "where it hurts" was blocked by a broad relative-marker boundary in bare-site lexical recognition, losing the site and BID in "Apply where it hurts BID". Allow relative marker tokens only in the bare lexical candidate path, still require a real registered site, and preserve the qualifier behavior of "skin where it hurts". No new body-site code is invented.
- Caller-configured six-word action aliases could not be sampled when the default verb has only a four-word span. Use the existing configured surfaces/aliases/locale aliases when determining the maximum span, retaining the original fast no-custom-map path. Validate precedence against the built-in "apply" verb, actual graph and FHIR round-trip.
- Thai distributive period expressions "ต่อวันละ"/"ต่อสัปดาห์ละ"/"ต่อเดือนละ" were split into a period plus orphan "ละ", potentially losing the explicit twice-per-period frequency. Extend existing Thai phrase inventory with the complete three-token lexemes. Tests assert original spans, FHIR 2/day, 2/week, and 2/month, and no lost text.

During independent cadence validation, also found established monthly/yearly FHIR repeat frequency=2 was rendered as "once monthly/yearly". Fix only existing English/Thai period frequency realization, without changing cadence semantics. These are normal competent SIGs and the previous display was clinically wrong. All changes are additive, cheap, and preserve source, existing clinical codings and typed graph. No new parsing pass, dependency, refusal guard, or safety-stop.

Validation after changes: 4 targeted suites 352/352; all 44 source suites 3801/3801; ESM/CJS and TypeScript declarations built; 4 packaged-export tests passed. All 11 edited code/test files were already in PR #10; unrelated untracked test/__tmp_open_semantic_probe.ts belongs to another worker and was not modified or staged.

## 2026-10-29 — PR #10 CodeRabbit: untimed weight-based daily total explicitly divided into doses

**Real clinical requirement and harm:** Reproduced a wrong-dose/wrong-cadence output for ordinary `10 mg/kg daily divided into 3 doses`: pre-fix exported one 10 mg/kg administration per day. The already-supported `10 mg/kg/day divided into 3 doses` correctly exported three 10/3 mg/kg administrations. A reviewable dosage suggestion must not silently lose its explicit division count.

**Typed HPSG fix:** In existing `unifySynsem`, a daily schedule plus an explicit `divisionCount` may turn a `resolved`, untimed `dose` clinical quantity into a daily total. Retain the existing mass numerator, patient-mass denominator and `requiresPatientWeight` flag, append one 1-day time denominator, derive the per-administration dose and replace the default daily frequency with the stated divided count. Ordinary nonclinical scalar totals continue the existing branch. Rates and already-timed clinical quantities remain excluded, preventing a second division. This feature is gated by the explicit divided-dose count; there is no new token scan, extra parsing stage, post-FHIR repair, rejection policy or swallowed source text.

**Independent evidence:** Five ordinary surface variants (bare daily, divided doses reordered, explicit PO, QD, and once daily) failed RED and passed GREEN, asserting 10 mg/kg/day total, 10/3 mg/kg administered TID, patient-mass denominator, original text/leftovers, and both direct and strict FHIR R5 projections. Existing /day, once-daily without a split, BID, and infusion-rate tests remain intact. Focused 483/483; full 44 suites 3806/3806 PASS; ESM/CJS and TypeScript declarations build PASS; packaged exports 4/4 PASS. Mobile-hot-path check: benchmarked ordinary 1-tablet, ocular taper, and weight-based BID inputs both before and after; no added O(n) work without explicit division, though single-run timing variation is too noisy to claim a measured speedup.

**Review boundaries:** One existing HPSG source file and its existing clinical-quantity test file changed, plus these internal notes. No new PR, new runtime dependency, background parser, or changes to local/clinical terminology codes. Other worker's `test/__tmp_open_semantic_probe.ts` remains untouched.

## 2026-10-30 — PR #10 CodeRabbit: monthly date selection and typed infusion duration

Product gate: three ordinary clinician-facing issues reproduced RED. A source-less FHIR Timing.repeat with monthly period, unspecified frequency and selected days 1/15 incorrectly formatted "once monthly" / "เดือนละครั้ง"; English/Thai short and long now retain exact selected dates without asserting one dose monthly or falling back to Q1MO. Re-entered text preserves both dates. Explicit frequency and single-day interpretation remain unchanged.

"Infuse at 125 mL/h over 8 hours" previously projected a rate plus timing duration but lacked administrationDuration on the typed rate; durationAfter now reuses the existing over/for lead set within its bounded scan. Fixed-rate and patient-weight rate expressions retain correct rate dimensions and their 8-hour administration duration (not a course), including strict FHIR R5 output.

Fourth review item, "daily except all days" needing a mandatory modifier extension, deliberately rejected in the original review thread: contradictory source beyond ordinary competent instructions. Original text, seven excluded weekday codes and zero scheduled doses are preserved; partial exclusions still export the positive allowed weekdays. No additional conformance burden or hard stop for a pathological case.

RED/GREEN clinical-oracle regressions, full source suites 3811/3811, ESM/CJS and TypeScript declaration build, and packaged exports 4/4 PASS. All changed source/test files already belong to PR #10; no new PR, parser pass, runtime dependency, destructive transformation or change to the unrelated temporary probe.

## 2026-10-30 — PR #10 review: keep infusion duration within its own action

**Clinical requirement (RED):** Ordinary "Infuse at 100 mL/h and observe for 30 minutes" was incorrectly projected as a 30-minute infusion because the bounded HPSG rate-duration scan skipped an independent observation action. Also reproduced for "then observe", comma+and, and semicolon. This changes an actual infusion duration, not merely its formatting.

**Typed HPSG fix:** The existing durationAfter helper remains a bounded eight-token lexical scan, but now stops at unrelated lexical/action boundaries. It allows only existing for/over duration leads plus optional IV route markers and commas immediately preceding those markers or duration leads. Original text and all coded rate semantics stay recoverable. No extra parse pass, runtime dependency, mandatory safety check, or FHIR-stage reinterpretation.

**Independent oracles:** Four negative examples failed RED and passed GREEN; four corresponding positive for/over/IV/comma variants retain legitimate infusion duration. An additional per-kg rate example (5 mcg/kg/min with separate observation) preserves patient-weight rate semantics without turning observation time into infusion duration. All 44 source suites passed 3820/3820; ESM/CJS plus TypeScript declarations build passed; packaged export tests passed 4/4. Only pre-existing files in PR #10 changed; the unrelated temporary probe remains untouched.

## 2026-10-30 — PR #10 CodeRabbit: distinguish SNOMED dosage fragments from whole actions

**Product decision gate.** Supported clinician-facing action phrases such as "omit the next dose", "do not add a dose", and "double the next dose" were exporting SNOMED 421139008 (Hold - dosing instruction fragment), 422106007 (Add - dosing instruction fragment), and 1305003 (Double - qualifier value) in FHIR predicate Codings as if they were equivalent whole actions. This is a genuine coding-meaning mismatch in interoperable clinical instruction graphs, not an adversarial grammar input. No need to refuse or reinterpret the original text.

**Correction.** Keep local EZMed action identifiers, original aliases, grammar, polarity, and English/Thai realization unchanged. The three SNOMED codes are moved only into typed semanticComponents with the existing operation role. The whole predicate uses its original local EZMed identity (existing direct local double code, normal fallback for withhold-administration and add). No new CodeSystem, parse pass, runtime terminology lookup or FHIR repair layer. Existing FHIR graph extensions preserve and restore both Codings and SNOMED components. Compared all 112 source action definitions against previous HEAD: every original standard/local coding identifier retained, no unrelated action semantics changed.

**Raw HPSG test fixture:** The date-interpretation test helper now supplies the same sourceText callback as production for accurate source-dependent grammar combinations. This is test fixture parity; there was no verified production crash, and no extra production validation or hot-path cost.

**Oracles:** Three exact-vs-fragment test cases failed RED and passed GREEN, covering typed local action, SNOMED constituents, and FHIR graph round trip. Existing clinician-oracle tests were amended to assert both parts, not delete the external code. Full 44 source suites 3823/3823, ESM/CJS and TypeScript declaration build, and packaged exports 4/4 all passed. Five pre-existing tracked files in PR #10 plus this excluded internal note; unrelated untracked temporary probe untouched. No separate PR.
