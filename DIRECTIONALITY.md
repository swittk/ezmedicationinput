# Parser Directionality

## Product boundary (mandatory before interpreting the architecture)

**Read [AGENTS.md](AGENTS.md) first.** EZMedInput is a **fast, best-effort clinical SIG parser/suggester for clinicians who review and edit the results**; it is **not** an autonomous prescribing or comprehensive medication-safety validator.

Technical improvements here are accepted only if they help advertised or plausible clinical language **without** imposing extra cost on the common path, adding special-case refusal machinery for contrived phrases, or deleting partially understood/source/FHIR meaning. Wrong laterality, dosage, cadence, and course in ordinary inputs are real bugs; incomplete interpretation of nonsensical or highly unusual inputs does not justify bloating the grammar. Keep HPSG typed and FHIR downstream, not a second post-parse clinical interpreter. Human correction remains part of the product.


## Goal

Move `ezmedicationinput` from a single mutation-heavy parser pass toward an explicit pipeline:

1. surface scan
2. lexical normalization / expansion
3. semantic annotation
4. clause parsing
5. ambiguity scoring
6. semantic lowering to FHIR and human-readable text

The maintenance problem in this project is no longer raw recognition coverage. It is precedence drift:
- route vs site
- meal timing vs workflow timing
- explicit vs inferred schedule
- PRN reason vs trailing instruction
- clause-local semantics vs carry-forward semantics

The fix is to make those layers explicit.

## Current Direction

The parser now assembles a canonical-clause-backed `ParserState` directly and then lowers to FHIR/text from canonical outputs.

Public outputs now already depend on canonical structure:
- `ParseResult.meta.canonical.clauses`
- `ParseBatchResult.meta.canonical.clauses`
- FHIR lowering
- localized formatting

Each parsed segment becomes one `CanonicalSigClause` with:
- `dose`
- `route`
- `site`
- `schedule`
- `prn`
- `additionalInstructions`
- `warnings`
- clause `span`

That means canonical is now the parser’s semantic working surface, not just metadata hung off the side.

For the grammar layer, this repo is currently choosing an in-repo recursive-descent parser over a new runtime dependency such as Chevrotain.

Reasoning:
- the project already has its own lexer and canonical semantic model
- keeping runtime size and compatibility simple still matters for this package
- the current clause language is narrow enough that a local grammar is maintainable
- suggestions can still be derived later from grammar productions without committing the package to a larger parser toolkit today

## Language-pack boundary during native realization (2026-11-17)

Future locales must plug into language-specific lexicons, grammar licensing,
realization templates, and suggestion adapters; the canonical clinical facts,
clinical composition, execution, and FHIR adapters must remain locale-neutral.
While touching `canonical/format-course.ts`, extract hardcoded EN/TH
course-level wording behind locale-owned realization rather than expanding
language conditionals. Reuse existing locale registries; no second parser,
full language-pack framework, or ordinary-path performance regression.
The concrete EN/TH course realizers live under src/locales/course/ and use the existing SigLocalization registry.

## Native course authority (2026-11-16)

The canonical clause/regimen pipeline now continues into a complete native
clinical course **before** either public FHIR projection. The parser remains
one typed HPSG pass; this is not a second grammar or a competing parser IR.

- `canonical/course.ts` defines the version-neutral clinical facts. No native
  course or administration extends `FhirDosage` or `DosageInstruction`.
- `canonical/compile.ts` composes existing scoped clauses and parallel regimen
  phases. Syntax/source spans are evidence, not another editable dosage truth.
- `canonical/edit-course.ts` owns explicit native edits and source/generated
  text invalidation. It copies only when an edit is requested, never per query.
- `canonical/format-course.ts` renders native facts without R5 lowering.
- `execution/engine.ts` consumes native facts only. Its resolved administration
  windows separately own recurrence origin, first eligibility, exclusive end,
  completion point, and civil cap clock. Scheduling, repeat-cycle horizon, and
  supply use that same phase resolution, not three interpretations of a Date.
- `execution/calendar.ts` owns the existing timezone/DST/calendar primitives;
  it knows no medication, FHIR, or parser representation.
- `adapters/canonical-course.ts` imports R5/current R6 and exports them. Only
  R5-boundary operations invoke `dosage-course.ts` persistence reconciliation.
- `schedule.ts` is the public input-normalization facade; the old FHIR-shaped
  execution implementation and alternate flat-course phase traversal are gone.

`parseSig().meta.canonical.course` is the internal authority; `.fhir` stays R5
and `.fhirNext` stays the current R6 export. `fromFhir` imports current R6
straight into native meaning and formats that meaning; the returned R5 rows
are outputs only. Existing R5 callers remain supported and do not migrate.

Known clinical changes must override retained external data on export. Unknown
source fields stay separate as provenance and must not silently execute. Native
constraints use an owned list of scope/value/period limits, not the three
R5 maximum-dose fields. Standard clinical codes/units can remain shared enums;
sharing a stable code vocabulary is not permission to use a FHIR wire object
as the internal course model.

Do not add wire-extension decoding, R5/R6 conversion, or a second phase-boundary
implementation to native compilation, formatting, or execution. Architecture
and native-edit tests enforce those boundaries in addition to the established
clinical regression corpus.

## Target Pipeline

### 1. Surface Scan

Responsibility:
- scan raw text directly
- emit exact tokens with exact spans
- preserve separators and punctuation as structural surface facts
- keep raw text lossless and authoritative

Examples of surface token kinds:
- `TEXT`
- `SEPARATOR`
- `PUNCTUATION`

Important rule:
- source spans come from scanning, not from rematching rewritten text
- no medication-domain semantics belong in surface token kinds

### 2. Lexical Normalization / Expansion

Responsibility:
- classify surface text into coarse lexical kinds
- split compact forms while preserving provenance
- keep lexical kinds generic and non-domain-specific

Examples of lexical kinds:
- `WORD`
- `NUMBER`
- `NUMBER_RANGE`
- `ORDINAL`
- `TIME_LIKE`
- `SEPARATOR`
- `PUNCTUATION`

Important rule:
- lexical kinds stay coarse
- no irreversible semantic decisions happen here

### 3. Semantic Annotation

Responsibility:
- attach medication meaning as reusable candidates and word classes
- preserve ambiguity instead of collapsing it early
- centralize domain lexicons so parser passes stop repeating ad hoc string checks

Examples of current annotation buckets:
- `routeCandidates`
- `siteCandidates`
- `timingAbbreviation`
- `eventTiming`
- `dayOfWeek`
- connector roles
- workflow / application / count word classes

Important rule:
- specialty knowledge should be one producer of generic candidates, not a dedicated schema branch

### 4. Clause Parser

Responsibility:
- convert annotated token streams into clause-shaped candidates
- produce explicit semantic structure instead of mutating FHIR fields directly

Core IR:
- `CanonicalSigClause`

Later likely sub-expressions:
- `DoseExpr`
- `RouteExpr`
- `SiteExpr`
- `ScheduleExpr`
- `PrnExpr`
- `AdditionalInstructionExpr`

Examples:
- `1 tab po bid`
- `apply cream to scalp nightly`
- `1 drop OD qid`

Each clause should preserve:
- raw text
- source span
- parsed structure
- unresolved text when present

### 5. Ambiguity Scorer

Responsibility:
- rank competing interpretations
- keep precedence rules out of parser rule ordering

Examples of ambiguity to score:
- `od` = once daily vs right eye
- `after` = meal timing vs topical workflow
- route implied by site vs site implied by route
- attachment of trailing text to PRN vs additional instruction
- carry-forward vs local reset in multi-clause sigs

Useful scoring principles:
- explicit beats inferred
- fewer leftovers beats more leftovers
- route/site coherence gets a bonus
- improbable clinical combinations get penalties
- preserve raw free text even when structure is uncertain

### 6. Semantic Lowering

Responsibility:
- convert canonical clauses into:
  - FHIR `Dosage`
  - localized text
  - suggestions / completions

Important rule:
- grammar and lexical code should not mutate FHIR directly
- FHIR is an output format, not the parser’s working memory

## Suggestions Direction

Suggestions should eventually come from parser state:
- valid next token classes
- valid next semantic transitions
- active clause expectations

Not from:
- broad cartesian assembly of whole phrases
- global string-product generation followed by filtering

## Migration Plan

### Stage 1

Done or in progress:
- preserve deterministic parser behavior
- add `canonical.clauses` adapter on parse results
- keep existing parser as the source of truth

Definition of done:
- exact source spans are authoritative in the token path
- compatibility parser remains behaviorally stable against the locked test corpus
- canonical clause storage exists as the parser’s real semantic state, not only a post-parse scaffold

### Stage 2

Next:
- finish moving parser hot paths to shared annotation helpers first
- centralize token class predicates and semantic lexicons
- reduce repeated string-set checks across parser passes

Current footing:
- `lexInput()` remains lexical only
- parser-facing `tokenize()` now adds a semantic annotation layer on top
- annotations use generic candidate buckets such as `siteCandidates` and `routeCandidates`
- specialty shorthand like ocular abbreviations is now one producer of generic candidates, not a dedicated schema slot

Definition of done:
- parser hot paths no longer reach directly into timing/route/day raw maps when a shared annotation helper exists
- repeated connector / workflow / site-modifier / count-word string sets are removed from the compatibility parser
- ambiguity such as `od` remains preserved in annotations until parser/scoring time

### Stage 3

Then:
- finish moving clause assembly into explicit collectors and native canonical state
- keep removing mutation-heavy inline precedence blobs from the parser entrypoint

Definition of done:
- `parseClauseState()` is an explicit ordered collector pipeline rather than one giant inline mutation loop
- canonical clause fields are written directly during parsing
- leftover collection, warnings, and advice/site resolution remain post-collectors rather than inline branch clutter
- no parser step reconstructs semantic truth from an older duplicate shell

Current native slice:
- additional-instruction/advice parsing now runs through `src/advice.ts`
- vocabulary lives in `src/advice-terminology.json`
- advice is parsed into `AdviceFrame[]` first and then coded by rule matching
- the old `maps.ts` additional-instruction phrase bag has been removed
- `parseClauseState()` now runs through a recursive-descent clause grammar
- `CoreTerm` is split into schedule / route / site / count / dose / connector productions
- phrase-level schedule grammar now owns cases like `twice daily`
- multiplicative cadence like `1x3` / `1.5 x3` is now a grammar term rather than a parser pre-scan
- custom route phrase/descriptor lookup is built once up front instead of inside the main token loop

### Stage 4

After that:
- introduce an ambiguity scorer
- move precedence decisions out of ordered heuristic branches

Definition of done:
- `od` ocular vs once-daily is resolved through explicit candidate/scoring logic
- `after` / `before` meal-vs-workflow handling is resolved through explicit candidate/scoring logic
- PRN tail attachment and clause carry-forward stop depending primarily on branch order

### Stage 5

Later:
- rebuild suggestions from grammar/parser state
- optionally add tiny ML only as reranker/classifier, not as the core parser

Definition of done:
- suggestions come from parser/clause state, not broad phrase permutation products
- any learned component is optional, local, and constrained to reranking/classification

## Immediate Design Constraint

No cloud LLM in the critical path.

If learned behavior is added later, it should be:
- local
- optional
- deterministic in integration behavior
- scoped to ambiguity resolution, not full semantic generation


## 2026-11-17 — Native model review and hard merge gates

- Understood clinical concepts require explicit typed fields. Known safety
  scopes, limits and exclusive quantity/count/expression choices, site
  references, and event anchors are now typed. Truly unknown wire metadata
  remains opaque provenance only, never executable clinical data.
- Outputs are immutable **by caller contract**, not by defensive copying or
  freezing. The explicit edit API creates a new course. Do not cache an
  externally supplied wire input across imports: reimporting a changed input
  must read its current contents, per existing editable-input tests.
- Performance acceptance: no reproducible >4% slowdown in ANY parser,
  import, formatter, scheduling or supply domain versus origin/master;
  target faster in every domain, with no aggregate-median waiver.
- Original audit blocker (resolved in the later direct-adapter checkpoint):
  native-to-R5 used to construct R6 first. Complete R5 and R6 sibling
  projection/import now independently own their source-compatibility codecs.
  The historical issue remains documented here as context, not an active gate.
- Preserve the original PR #13. Update stacked PR #14 only after source,
  compatibility and per-domain performance acceptance is verified.


## 2026-11-17 — Direct sibling adapters and course localization (supersedes prior R5 blocker)

The historical CanonicalCourse -> R6 -> R5 blocker above was resolved
at the complete interchange boundary, not hidden behind a limited fast
path. Native clinical course remains the sole internal authority:

- adapters/r5-course.ts emits strict R5 fields and complete retained edit
  metadata directly from native facts.
- adapters/r5-import.ts reconciles live R5 rows directly. It may decode an
  R6-shaped historical *source snapshot* embedded in an older R5 extension,
  but does not construct a new R6 processing intermediate.
- adapters/canonical-course.ts imports/projects current R6 independently.
  Native parsing, formatting, scheduling and supply do not transit either
  external version on their internal paths.
- Opaque source remains recoverable and inert; understood clinical fields
  are explicit typed values, not generic executable property bags.

Whole-course EN/TH words are a typed CourseLanguage facet on the existing
SigLocalization registry. Shared canonical code computes clinical facts,
dates, conditions and dose/rate scope only. Locale-owned modules in
locales/course/ supply calendars, stages, temporal units, conjunctions,
conditions, exclusions, rate/dose labels and technical fallbacks. A third
language test covers registration and inheritance without a second parser.

The all-public benchmark covers all legacy exports including autocomplete
(suggestSig), date and locale registration, graph encode/decode, R5/R6
interchange, scheduling and supply, not only parseSig/formatSig.
The 4% regression ceiling applies independently to each measured domain
against the exact built origin/master, never to an aggregate median.


## 2026-11-17 — Chronological overlap and source replay ownership

Overlapping capped repeat cycles MUST accept actual administrations
in timestamp order, independent of source cycle ordinal. A typed
min-heap is used ONLY when a full first-cycle horizon proves real
overlap; ordinary capped one-stage courses use a cheap structural
non-overlap proof and their established fast path. Supply and nextDue
consume identical accepted timestamps and their clinical rolling-cap
and finite-count allowance; neither makes a second calendar engine.

FHIR R5 and current R6 are independent projections from canonical
meaning. The ancillary instruction graph can lack an Amount even
when the HPSG primary dosage owns an authored quantity. Source
roundtrip may reuse that old text only with source evidence or
verified persisted R5 projection. Editing a quantity invalidates
its evidence and uses the typed canonical realizer. An inferred
default does not claim to be an authored source quantity.
Persisted source evidence is verified without reparsing or emitting
a new FHIR metadata field; the ordinary parsing and formatting
hot paths never pay a second realization/graph traversal.
