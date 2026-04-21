# Parser Directionality

## Goal

Move `ezmedicationinput` from a single mutation-heavy parser pass toward an explicit pipeline:

1. lexer / normalizer
2. clause parser
3. ambiguity scorer
4. semantic lowering to FHIR and human-readable text

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

### 1. Lexer / Normalizer

Responsibility:
- tokenize raw text with spans
- normalize Thai/English shorthand
- classify tokens into lexical categories
- keep raw text lossless

Examples of token classes:
- `NUMBER`
- `ORDINAL`
- `UNIT`
- `ROUTE_TERM`
- `SITE_TERM`
- `SITE_MODIFIER`
- `WHEN_TERM`
- `INTERVAL_TERM`
- `PRN_TERM`
- `WORKFLOW_VERB`
- `CLAUSE_CONNECTOR`

Important rule:
- lexical inventories should be centralized and declarative
- parser behavior should consume token classes, not repeat string checks everywhere

### 2. Clause Parser

Responsibility:
- convert token streams into clause-shaped candidates
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

### 3. Ambiguity Scorer

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

### 4. Semantic Lowering

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

### Stage 2

Next:
- extract lexical classification into a dedicated layer
- centralize token class predicates and synonym normalization
- reduce repeated string-set checks across parser passes

### Stage 3

Then:
- parse into canonical clause candidates directly
- use the current parser as fallback until parity is reached

### Stage 4

After that:
- introduce an ambiguity scorer
- move precedence decisions out of ordered heuristic branches

### Stage 5

Later:
- rebuild suggestions from grammar/parser state
- optionally add tiny ML only as reranker/classifier, not as the core parser

## Immediate Design Constraint

No cloud LLM in the critical path.

If learned behavior is added later, it should be:
- local
- optional
- deterministic in integration behavior
- scoped to ambiguity resolution, not full semantic generation
