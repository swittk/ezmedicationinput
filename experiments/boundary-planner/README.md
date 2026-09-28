# Explainable regimen experiment

This is a development-only alternative to the production 0.1.66 pipeline.
Production `src/`, published exports, and npm package behavior remain unchanged.
The experiment now covers boundary planning, typed inter-clause phases, finite
cycle constructions, and shared scheduler primitives—not just segmentation.

## Run

```sh
npm run typecheck:boundaries
npm run typecheck:boundary-integration
npm run test:boundaries
npm run test:boundary-clinical
npm run test:shadow-boundaries
npm run experiment:boundaries -- --rounds=30
npm run explain:boundaries -- '<sig>' --locale=th --reference-date=2026-09-27
```

`test:boundaries` runs structural planner contracts. `test:boundary-clinical`
runs independent dose/date/occurrence/total oracles, negative safety cases,
sync/async/lint parity, and English/Thai realization round trips with candidate
integration enabled. `test:shadow-boundaries` runs the unchanged existing source
suite with the candidate. These configurations are deliberately separate.

The experiment command is strict: any failed golden scenario or performance gate
causes a failing exit. It writes evidence, never updates expected values, never
activates production, and never pushes or publishes.

## Components

- `planner.ts`, `structures.ts`, `evidence.ts`, `grammar.ts`: structural claims,
  bounded typed evidence, named boundary constructions, and explicit relations.
  Claims cover lookahead as well as final boundaries. A date proposal cannot
  swallow a quantity/unit constituent. Explanations retain competing constraints.
- `regimen.ts`: groups coordinated administrations and explicit sequence edges.
  A later phase uses the complete predecessor group's finite endpoint. An explicit
  phase end outranks the date of its last dose. Explicit local anchors outrank
  inheritance; heterogeneous predecessor clocks are not arbitrarily selected.
- `cycles.ts`, `cycle-lexicon.ts`: a real HPSG schedule constituent for finite,
  explicitly anchored day lists/ranges and cycle counts. Date anchors reuse the
  existing date parser, including named months and the numeric DMY policy.
  No drug/specialty lookup invents a cycle length, anchor, or dose.
- `scheduler-primitives.ts`: one clock/default and cadence implementation shared
  by occurrence generation, historical count calculation, and total-unit counting.
  It reuses the existing timezone/calendar primitives.
- `bounds.ts`: anchored exact day/week durations lower to a single FHIR bounds
  choice; multi-clock frequency is made explicit where the input left it implicit.
- `admissibility.ts`: recognized invalid cycles or contradictory phase constraints
  preserve the instruction and dose, emit a diagnostic, and do not execute a
  fabricated schedule.

`integration.mjs` is the build/test adapter, not a production runtime patcher. It
selects actual experimental modules and small audited integration seams. It
asserts that the expected source anchors exist rather than silently applying a
partial transform. `typecheck-integration.mjs` checks the transformed candidate in
an isolated mirror, in addition to ordinary source/experiment type checks.
No output is mocked to match an oracle, and the candidate does not fall back to
the old segmenter when an experiment fails.

## Corpus and acceptance

`corpus.ts` retains the original 104 historical/metamorphic/challenge scenarios.
`specialty-corpus.ts` adds 31 independently specified specialty-style seed inputs
and controlled English/Thai/code-switch/spacing variants, for 112 additional
positive scenarios. The specialty labels exist only in the tests, not the parser.

These are synthetic syntax fixtures, not patient prescriptions or treatment
recommendations. They test variable weekday doses, weekly dosing, alternate-day
and multi-week intervals, multiple clocks, anchored tapers, cross-midnight pairs,
finite treatment/rest cycles, quarter-tablets/liquids, and calendar edge cases.
Expected dates and totals are independently authored, not copied from production.

Negative cases deliberately require diagnostics instead of invented schedules:
missing/invalid cycle anchors, absent cycle length/count, invalid day ranges,
contradictory phase starts, and ambiguous inherited clocks. They are not counted
as successful medication schedules. Finite-cycle expansion is bounded (at most
100 cycles, day indices through 366, and 10,000 generated events).

Numeric dates default to DMY in every locale. Numeric MDY requires the existing
explicit caller override; English month names remain unambiguous in either order.

## Evidence and promotion

Read `REPORT.md` and `results/`. The initial red experiment is preserved under
`results/initial-experiment/`. Current evidence includes explicit expected/actual
executions and phase graphs, source fingerprints, validation results, counters,
paired performance samples, and scaling checks.

Legacy performance corpora retain their existing 5% mean/p95 tolerance. The new
specialty corpus also has a stated 100 ms p95 guard; its ratio against the old
parser is descriptive because the old parser fails many of those inputs.
Performance is measured without concurrent test/build jobs from this session and
without instrumentation in the timed bundles. Other host activity remains possible.

Passing this finite matrix is not a proof over arbitrary language or a full HL7
validator certificate. Tests check dose and executable-timing preservation across
FHIR round trips and the relevant bounds/clock choice constraints. Natural-language
realization is not intended to preserve original typography or byte-for-byte text.

Review is still required before promoting the modules into production. Do not ship
the source-transform test adapter as the production integration.

## Administration-target scope

The candidate treats changes in administration targets as regimen evidence. A coordinated multi-target phase is represented structurally and lowers to multiple FHIR Dosage items only because `Dosage.site` is singular. Pre-coordinated coded sites such as `both eyes` stay singular; explicit conjunctions such as `right eye and left eye` may lower separately. Disjunctions remain alternatives with a warning.

Open-ended recurrence markers (`onward`, `onwards`, Thai `เป็นต้นไป`) are grammar contributions tied to a preceding date and an actual recurrence cadence. Anatomical phrases inside warnings/advice remain outside target ownership and cannot become extra administration sites.

## Lazy temporal relation coverage

Calendar bounds use a shared relation vocabulary, not per-sentence exceptions. English includes `after/before/from/since/starting/beginning/as of/as from/prior to/through/till`; Thai includes `หลัง/หลังจาก/ก่อน/ก่อนถึง/ตั้งแต่/นับตั้งแต่/นับจาก/นับแต่/เริ่ม/ถึง` plus open-continuation forms `ต่อไป/เป็นต้นไป`. Cadence can appear before or after the bound. Common Thai no-space forms are supported by splitting only at numeric boundaries inside a date span already recognized from the raw input.

Bare bounds without cadence are kept incomplete rather than defaulting to daily. End bounds followed by `onwards/ต่อไป` are treated as contradictory and quarantined. Event/workflow phrases such as `after each bowel movement` are not reclassified as calendar bounds.
