# HPSG Implementation Guide For `ezmedicationinput`

Last updated: 2026-04-26

## Why this file exists

This repo is moving away from a mutation-order parser toward a typed,
constraint-based grammar.

The goal is not to imitate every detail of textbook HPSG. The goal is to adopt
the parts that matter for a hand-built, production parser:

- typed feature structures as the source of truth
- declarative constraints instead of procedural special cases
- lexical/construction separation
- parse and realization driven from the same semantic structure
- ambiguity represented structurally, not erased early by pass order

This note is the implementation reference for that migration.

## Research baseline

The most useful implementation-oriented sources were:

- DELPH-IN formalism notes on computational HPSG and the Joint Reference
  Formalism:
  [Formalisms](https://delph-in.github.io/docs/howto/DelphinTutorial_Formalisms/)
- DELPH-IN grammar overview:
  [Grammars](https://delph-in.github.io/docs/howto/DelphinTutorial_Grammars/)
- Grammar Matrix documentation:
  [MatrixDocTop](https://delph-in.github.io/docs/matrix/MatrixDocTop/)
- HPSG handbook landing page:
  [HPSG Handbook](https://hpsg.hu-berlin.de/Projects/HPSG-handbook/)
- Müller’s HPSG synopsis PDF:
  [HeadDrivenPhraseStructureGrammar.pdf](https://www.its.caltech.edu/~matilde/HeadDrivenPhraseStructureGrammar.pdf)
- DELPH-IN grammar scale-up discussion:
  [TomarGrammarScaleUp](https://delph-in.github.io/docs/summits/TomarGrammarScaleUp/)

These were chosen because they are either HPSG/DELPH-IN primary sources or
direct grammar-engineering practice notes from the community that actually
implements large grammars.

## What “proper HPSG” means here

For this codebase, the key commitments are:

1. A grammar has a **signature** and a **theory**.
   The signature is the type system and appropriateness conditions.
   The theory is the licensed constraints/constructions over those types.

2. Linguistic objects are modeled as **typed feature structures**.
   Not strings plus side tables.

3. Constraints should be **declarative** and as **mono-stratal** as possible.
   Input should be assigned a structure directly, rather than being repeatedly
   rewritten by unrelated passes.

4. Grammar should be **lexicalist**.
   Lexical items contribute rich typed information.
   Phrase structure rules combine those contributions.

5. Implemented HPSG in practice is not “one magical universal rule”.
   DELPH-IN-style grammars use a **rich inventory of constructions**, not a tiny
   theoretical rule set plus procedural rescue code.

6. Computational HPSG implementations are usually **more conservative** than the
   full theoretical literature.
   DELPH-IN explicitly warns against leaning on broad logical disjunction,
   negation, complex antecedent implication, cyclic structures, and similar
   devices if the goal is an implementable engineering grammar.

## Core dos

### 1. Do design the type system first

Before adding more rules, decide:

- which objects exist
- which features are appropriate to each type
- which features are inherited

For this parser, that means explicitly typing things like:

- `sign`
- `clause-sign`
- `word-sign`
- `phrase-sign`
- `dose-sign`
- `schedule-sign`
- `route-sign`
- `site-sign`
- `prn-reason-sign`
- `additional-instruction-sign`

And below those:

- `site-nominal`
- `site-partitive`
- `site-locative`
- `reason-symptom`
- `reason-locative`
- `event-trigger`

### 2. Do make feature structures the single source of truth

If a site/reason/schedule distinction matters:

- parser recognition should see it
- coding should see it
- formatter should see it

Do not let one layer know the structure while another layer only sees a flat
string.

### 3. Do encode compatibility as unification-style merging

Prefer:

- “otic route licenses ear/ear canal targets”
- “topical administration + symptom-at-site may support finding-site coding”
- “partitive site inherits whole-site anatomical properties”

Over:

- “if route is ear and text contains canal then…”
- “if site text equals scalp itch then…”

### 4. Do keep lexical inventory and constructions separate

Lexical data should live in terminology tables / JSON / maps.

Constructions should state how those lexical items combine.

For example:

- lexical entries:
  - `inside` -> locative relation
  - `back` -> partitive head
  - `palm` -> anatomical nominal
  - `itchiness` -> symptom head
- constructions:
  - `LOCATIVE-PHRASE -> RELATION + SITE-NP`
  - `PARTITIVE-SITE -> PART + of + SITE-NP`
  - `PRN-REASON -> SYMPTOM (+ LOCATIVE-COMPLEMENT)`

### 5. Do keep parse and realization coupled through shared structure

The same feature structure should support:

- parse
- coding
- English generation
- Thai generation

This is one of the strongest HPSG engineering lessons from DELPH-IN practice:
the grammar should be usable for more than one downstream task.

### 6. Do grow the grammar against curated examples and regression suites

Grammar Matrix documentation and DELPH-IN practice both emphasize regular
testing.

For this repo that means:

- keep positive examples
- keep negative/should-not-parse examples
- keep parse-to-FHIR-to-format round-trip tests
- keep schedule math tests

### 7. Do treat lexicon growth and grammar growth as coupled

The DELPH-IN scale-up notes explicitly warn against pretending lexicon and
grammar are independent.

For this repo:

- adding new body sites can require construction updates
- adding new PRN symptoms can require reason grammar updates
- adding new workflow events can require event-trigger grammar updates

### 8. Do keep a semantic interface explicit

Even if this repo does not use full MRS, it still needs an explicit semantic
interface.

Concretely, every successful parse should map to a typed canonical structure
with stable fields, not ad hoc parser locals.

## Core don’ts

### 1. Don’t let collector order be the meaning system

If interpretation depends mainly on which parser function ran first, the grammar
is still procedural.

Order can still exist, but it should be a control strategy over typed analyses,
not the main semantics.

### 2. Don’t duplicate the same phenomenon in parser, formatter, and coder

Examples of bad architecture:

- parser knows `inside ear`
- formatter separately regexes `inside`
- PRN coding separately tries to recover `ear`

That means the grammar is fragmented.

### 3. Don’t conflate lookup form, canonical form, and realized form

These must be distinct:

- **lookup identity**:
  used for custom terminology maps and selections
- **canonical semantic identity**:
  used for feature compatibility and coding
- **surface realization**:
  used for English/Thai output

If these collapse into one string field, custom overrides and canonical
semantics will fight each other.

### 4. Don’t add efficiency tricks into the core representation too early

The DELPH-IN scale-up discussion is blunt here: many “efficiency hacks” in the
grammar core become debugging nightmares and collaboration barriers.

Implementation rule for this repo:

- first get the type system and constraints clear
- only then optimize hot paths
- do not encode optimization assumptions into the grammar model itself

### 5. Don’t overuse powerful logical machinery just because HPSG literature allows it

Computational HPSG practice is intentionally conservative.

Avoid as default design tools:

- broad logical disjunction
- negation in core grammar descriptions
- complex implication antecedents
- cyclic feature structures
- hidden procedural backdoors pretending to be constraints

### 6. Don’t make formatter text the only representation of semantics

If a nuance matters clinically, it must exist before formatting.

Bad:

- “we can reconstruct that from text later”

Good:

- parse into typed features first
- then render

## Practical implementation guidance for this repo

## 1. Signature we should aim for

At minimum, the whole parser should converge on feature structures like:

```ts
type ClauseSign = {
  synsem: {
    head: {
      method?: MethodHead;
      route?: RouteHead;
      dosage?: DoseHead;
      schedule?: ScheduleHead;
      polarity?: "affirm" | "negated";
    };
    valence?: {
      target?: SiteSign;
      prnReason?: ReasonSign;
      eventTrigger?: EventTriggerSign;
      instruction?: InstructionSign[];
    };
    cont: {
      clauseKind: "administration";
    };
  };
  evidence: Evidence[];
};
```

With subtypes such as:

```ts
type SiteSign =
  | { kind: "nominal"; canonical: string; coding?: FhirCoding }
  | { kind: "partitive"; part: string; whole: SiteSign }
  | { kind: "locative"; relation: "behind" | "inside" | "around" | ...; target: SiteSign };

type ReasonSign =
  | { kind: "symptom"; head: string; coding?: FhirCoding }
  | { kind: "located-symptom"; symptom: ReasonSign; site: SiteSign };

type EventTriggerSign = {
  relation: "before" | "after" | "during" | "on" | "until";
  anchorText: string;
  anchorCoding?: FhirCoding;
  offset?: { value: number; unit: FhirPeriodUnit; polarity: "+" | "-" };
};
```

## 2. Whole-parser migration rule

Each parser terminal/construction should produce a **typed contribution**, not
directly mutate arbitrary state.

Preferred shape:

```ts
type ClauseContribution = {
  consumedTokenIndices: number[];
  signDelta: Partial<ClauseSign>;
  warnings?: string[];
};
```

Then the parser core should do:

1. recognize a lexical item or construction
2. build a typed contribution
3. unify/merge it with the current clause sign
4. only then commit token consumption

## 3. What should count as “whole parser” progress

The parser should eventually be organized around typed constituents:

- `METHOD-TERM`
- `ROUTE-TERM`
- `DOSE-TERM`
- `COUNT-TERM`
- `SCHEDULE-TERM`
- `SITE-NP`
- `PRN-REASON-NP`
- `EVENT-TRIGGER`
- `ADDITIONAL-INSTRUCTION`

And phrase-level constructions:

- `SITE-PARTITIVE`
- `SITE-LOCATIVE`
- `PRN-LOCATIVE-REASON`
- `EVENT-RELATIVE-INSTRUCTION`
- `MULTICLAUSE-SEQUENCE`

## 4. Ambiguity policy

Do not collapse ambiguity too early.

If a phrase can plausibly be:

- schedule anchor
- or site anchor

then the grammar should represent competing analyses or at least delay the
commit until typed compatibility can decide.

This matters directly for current pain points like:

- `at lesion`
- `inside ear`
- `before bed at wound`
- `pain at hand`

## 5. Coding policy

FHIR/SNOMED coding should be a lowering step over typed semantics:

- exact pre-coordinated code wins
- else well-formed postcoordination
- else broader code + exact text
- else text only

This policy belongs **after** structured parse, not inside ad hoc token logic.

## 6. Realization policy

English and Thai realization should consume the same typed sign.

For example, Thai should not need its own special-case parser semantics just to
avoid bad wording. The realization layer should be able to read:

- method
- route
- site
- site relation
- partitive structure
- prn reason
- event trigger

And generate from that.

## Immediate codebase rules

Until the full rewrite is complete:

1. New phenomena should be added in shared typed modules first when possible.
2. No new formatter regexes for semantics already present in parser data.
3. No new PRN/site special cases that bypass shared site/reason structures.
4. If a new phenomenon needs custom behavior, write down:
   - its lexical types
   - its construction
   - its feature contribution
   before adding code.

## Current architectural interpretation for `ezmedicationinput`

The current parser entrypoint is now HPSG-only: `src/parser.ts` delegates clause
recognition to the typed chart/unification grammar in `src/hpsg/*`.

The remaining work is not migration off a legacy agenda anymore. It is grammar
coverage and modularization inside the HPSG layer:

1. Expand typed constituents for every old supported phenomenon:
   PRN reason, additional instructions, product form methods, event triggers,
   route display phrases, day/week ranges, time-of-day lists, and site probes.

2. Keep all new behavior as lexical entries or construction constraints under
   `src/hpsg/*`.

3. Do not reintroduce parser-local collector passes, contribution adapters, or
   ordered mutation agenda logic.

4. Restore regression coverage only after the missing HPSG constructions are
   represented.

5. Realization should consume typed structures directly once the parse coverage
   is rebuilt.

## Concrete dos and don’ts for future edits in this repo

### Do

- add types before rules
- add rules before string cleanup
- share typed structures across parse/coding/formatting
- preserve original text separately from canonical semantics
- test both parse coverage and round-trip behavior
- keep treebank/regression-style discipline

### Don’t

- add semantic regex patches in formatters
- add literal phrase hacks if a construction exists
- overload one field to mean lookup form + semantic form + display form
- hide semantics in post-processing
- “optimize” the grammar core before the analysis is clear

## Source notes

These are the specific points taken from the sources above:

- DELPH-IN formalism notes:
  computational HPSG implementations should favor implementable typed feature
  constraints and avoid overly expressive devices that hurt engineering.
- DELPH-IN grammar notes:
  implemented HPSG is declarative, mono-stratal, lexicalist, and uses rich
  constructions; mature grammars pair with treebanks and explicit semantic
  interfaces.
- Grammar Matrix docs:
  test constantly, maintain grammatical/ungrammatical examples, inspect shared
  core types before inventing new machinery, and reuse existing libraries where
  possible.
- Tomar grammar scale-up discussion:
  grammar and lexicon evolve together, generation testing is valuable, and core
  efficiency hacks often become long-term maintenance debt.
- HPSG synopsis / handbook:
  grammar engineering starts from the signature, typed feature structures, and
  explicit modeling commitments rather than from procedural rewrite code.
