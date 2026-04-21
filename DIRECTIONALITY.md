# Parser Directionality

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

The current parser still produces `ParsedSigInternal` directly and then lowers to FHIR. That remains the compatibility path.

This pass introduces a minimal canonical IR surface on top of the existing parser:

- `ParseResult.meta.canonical.clauses`
- `ParseBatchResult.meta.canonical.clauses`

Right now this is an adapter, not a new parser. Each parsed segment becomes one `CanonicalSigClause` with:
- `dose`
- `route`
- `site`
- `schedule`
- `prn`
- `additionalInstructions`
- `warnings`
- clause `span`

That gives us a stable place to migrate semantics without forcing consumers onto FHIR-shaped intermediate data.

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
- canonical clause adapter exists as an honest post-parse migration scaffold

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
- parse into canonical clause candidates directly
- use the current parser as fallback until parity is reached

Definition of done:
- at least one meaningful vertical slice parses natively into canonical clause structures before `ParsedSigInternal` finalization
- that slice preserves spans, leftovers, evidence, and unresolved text without reconstructing them post hoc
- compatibility parser can still be used as fallback outside the migrated slice

Current native slice:
- additional-instruction/advice parsing now runs through `src/advice.ts`
- vocabulary lives in `src/advice-terminology.json`
- advice is parsed into `AdviceFrame[]` first and then coded by rule matching
- the old `maps.ts` additional-instruction phrase bag has been removed

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
