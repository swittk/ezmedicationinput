# Shadow boundary-planner experiment

This is an **offline experiment**, not a replacement for `src/hpsg/segmenter.ts`.
The published parser, clause HPSG, carry-forward, FHIR projection, formatter, and
scheduler are unchanged. Nothing here is imported by the production entrypoint
or included in the npm package's `files` list. Do not enable it for live orders.

## Hypothesis

Repeated failures cluster at structural ownership and inter-clause scope. An
explainable boundary grammar can keep coherent lists intact, distinguish paired
clocks from shared clocks, and reduce redundant clause probes without asking one
large HPSG chart to parse a whole regimen.

This first experiment intentionally changes **only boundary planning**. The
existing downstream carry/propagation code remains in place. A failure after
correct segmentation is evidence against treating boundary cleanup alone as a
complete regimen fix.

## Architecture

- `structures.ts` obtains calendar spans from the existing date recognizer and
  composes clock/weekday lists from existing typed tokens and canonical connector
  terminology. Fraction/range and parenthesis spans retain source ownership.
- Ownership forbids **external splits**, not internal HPSG analysis. Probe windows
  obey ownership too; protecting just the final split is insufficient.
- `grammar.ts` defines typed constructions and named constraints. Surface/locale
  strings are not conditions in those constructions. Equal-priority incompatible
  proposals are reported as unresolved, not silently selected by iteration order.
- `evidence.ts` lazily obtains existing HPSG clause analyses and action frames,
  cached within one input/options context. There is no global semantic cache.
- `planner.ts` enumerates candidate seams and arbitrates ownership, grammatical
  proposals, and explicit compatibility rules. Existing comma/head and procedural
  behavior has **not** magically become a full discourse grammar: those bounded
  compatibility policies remain visible and named.
- `explain.mjs` shows selected rules, structural owners, source ranges, and rejected
  constraints. Trace mode deliberately performs more evidence work than the
  trace-disabled benchmark path. Rule priorities are policy, not probabilities.

This is HPSG-inspired typed boundary reasoning, **not** a claim to have implemented
a second complete HPSG chart or a full `CanonicalRegimen` grammar. It never calls
the legacy segmenter as a hidden fallback.

## Reproduce

From the repository root, using the existing installed development dependencies:

```sh
npm run typecheck:boundaries
npm run test:boundaries
npm run test:shadow-boundaries
npm run experiment:boundaries -- --rounds=20
npm run explain:boundaries -- 'รับประทานครั้งละ 1 เม็ด วันละครั้ง หลังอาหารเช้า. วันที่ 28/9/69, 1/10/69 และ 4/10/69 จากนั้น ทุกวันอาทิตย์' --locale=th --reference-date=2026-09-27
```

The shadow-suite config uses a test-only module substitution to run every existing
source test with the candidate planner. The runner builds baseline/candidate
bundles into ignored `.generated/`, substitutes the planner only in the candidate,
and instruments separate bundles for call/chart counters. Runtime source files
and published `dist/` are never patched by this harness.

`node experiments/boundary-planner/run.mjs --audit` runs correctness, costs, and
ablations without a timing benchmark. `--strict` also treats challenge failures as a failing exit. Historical or
metamorphic oracle failures already cause a nonzero exit in normal mode. Normal mode completes the
experiment and records failures; a zero exit is **not** a production-promotion
verdict.

## Evidence and measurement

`corpus.ts` contains independently authored expected meanings, linked to historical
fixes, plus controlled bilingual/code-switched variations and challenge cases.
The baseline is a comparator, **not the correctness oracle**. Assertions cover
dose values, dated occurrences, clocks, weekday/boundary scope, and actual
`nextDueDoses` timestamps. The differential also compares canonical clinical
fields, FHIR, leftovers, warnings, and `calculateTotalUnits`. Full suite testing
retains the broader safety/formatting/round-trip coverage.

Timing compares full `parseSig` on identical inputs in uninstrumented baseline
and candidate bundles. AB/BA round ordering limits systematic warm-up/order bias.
Counters run separately, so diagnostic work is not silently included in one
timed lane. Existing torture cases and composed cases are reported separately.
The predeclared timing gate allows 5% measurement noise on **both** mean and p95;
results outside it are not relabelled as a pass. Do not run other validation jobs
concurrently with the timing measurement. Other host activity can still add noise.

Results are retained in `results/`. The first timing attempt is preserved separately
rather than discarded when the lazy-evidence design is improved. Historical
audits retain selected diffs and test additions. File-touch and subject counts
are not defect counts and do not establish a statistical failure rate.

## Non-negotiable semantics

Numeric dates default to DMY in every locale; numeric MDY needs explicit
`datePolicy.dateOrder: "MDY"`. Named months can use either textual order.
Fractional doses and dose ranges remain medication syntax. Independent schedule
pairings must not become a Cartesian product. `and` and `then` are not
interchangeable. Unknown/conflicting syntax must not acquire invented doses.

## Promotion

No automatic production switch, release, merge, or publish is part of this
experiment. Passing old tests is necessary, not sufficient. Read `REPORT.md` and
the retained challenge failures before considering a production proposal.
