# EZMEDINPUT: explainable boundary-planner experiment

**Date:** 28 September 2026 (Asia/Bangkok).
**Baseline:** `ezmedicationinput@0.1.66`, commit `e63ca7b255d222034f6ac4b896d8b7ff99863838`.
**Branch:** `experiment/explainable-boundary-planner`.
**Status:** experiment implemented and measured; **not activated in production**.
**Implementation/corpus fingerprint:** `b6fa42ebd527421c4140b0b395537fbe3d508fedb1e8c8572b17e1ea85121764`.

## Decision

The experiment supports structural ownership plus typed, explainable boundary
rules as a useful replacement direction. It is not evidence that the entire
regimen problem is solved. Keep the production parser unchanged for now.

The candidate preserves all 1,210 existing source tests and fixes one additional
independently specified pairing case. It meets the predeclared performance gate
after lazy evidence evaluation. However, stricter independent oracles exposed two
shared downstream defect families: phase-wide transition scope and inconsistent
meal-clock defaults between occurrence generation and total-unit counting.

The full experiment intentionally exits **1** while those independent expectations
fail. The failed results are retained, not changed to match either implementation.

## What was built

A separate experiment under `experiments/boundary-planner/` provides:

- Reused structural recognition for dates; typed clock/weekday lists; numeric and
  parenthesis spans. Claims forbid only external splitting. Internal tokens still
  reach clause HPSG. Lookahead/probe windows also respect the claims.
- A boundary grammar with named feature constraints and explicit decisions:
  ownership, coordination, sequence, distinct date-clock pairing, adjacent doses,
  fronted adjuncts, and procedural scope. Conflicting equal-priority conclusions
  are exposed rather than silently resolved by iteration order.
- Lazy, per-input HPSG/action evidence with a bounded-lifetime cache. No cross-input
  cache, locale-derived MDY, or new medication-phrase vocabulary is introduced.
- An explanation CLI, historical and generated fixtures, test-only substitution
  of the segmenter, instrumented cost comparison, paired runtime benchmarks,
  ownership/cache ablations, a short scaling probe, and retained JSON results.

This is an HPSG-inspired typed boundary planner, **not a second full HPSG chart**.
Some existing comma/head and procedural compatibility policies remain, now named
and inspectable. Merely moving them behind typed interfaces does not prove that
all heuristics have disappeared. No runtime call falls back to the old segmenter.

## Audit basis and recurring pattern

The retained causal audit inspects ten selected historical changes, including
`5fca1fc`, `245b697`, `1f23c87`, `892e6fb`, `d03174f`, `34f7bd1`, `1f45525`,
`cb315c5`, `f7e5a2e`, and `11b34f0`. Selected diffs and test additions are in
`results/history-audit.json`.

They repeatedly concern the ownership and scope of otherwise recognized material:
omitted administration heads, a duration belonging to a group, an internal list
separator being mistaken for a clause boundary, or phase relationships recovered
after segmentation. This is a targeted engineering finding, not a statistical
ranking of every parser subsystem. File-touch counts are not defect counts.

## Validation

| Check | Result |
|---|---:|
| Unchanged production source suite | 1,210 / 1,210 pass |
| Same existing suite using candidate boundaries | 1,210 / 1,210 pass |
| Structural, explanation, determinism, cache and ownership contracts | 104 / 104 pass |
| Distribution/export tests | 4 / 4 pass |
| Production build and declaration generation | pass |
| Strict experiment TypeScript check | pass |
| Production `src/` diff | empty |
| npm dry-run package | 85 files, no experiment files |

The independent 104-case clinical corpus is **separate** from the 104 structural
contract tests. The latter verify planner invariants; they do not substitute for
clinical expectations.

| Independent clinical corpus | Baseline | Candidate |
|---|---:|---:|
| Historical fixtures | 15 / 15 | 15 / 15 |
| Controlled English/Thai/code-switch variants | 72 / 84 | 72 / 84 |
| Additional challenges | 3 / 5 | 4 / 5 |
| **Total** | **90 / 104** | **91 / 104** |

All 84 controlled variants preserve the expected dates, doses, and occurrence
lists; 12 Thai variants fail the newly added independent **total-unit** assertion.
The candidate adds no new golden-case failure relative to the baseline. Full
clinical differential output matches in 103 / 104 cases; the one change is the
corrected date-clock pairing below.

This distinction is important: before independent total assertions were added,
those variants appeared green. Comparing only baseline and candidate would also
have missed the error because both agree on zero.

## A boundary bug fixed by the design

Input:

```text
take 1 tab at 08:00 on 28/9 and 1/10, at 20:00 on 4/10 and 5/10
```

The baseline collapses both lists into one schedule with both clocks on all four
dates: eight occurrences. The candidate emits two correctly scoped items:

```text
28 September and 1 October at 08:00
4 October and 5 October at 20:00
```

That is four occurrences, not eight. No literal case-specific rule was added.
The date-list ownership keeps internal coordinators out of probe boundaries;
the existing typed date-clock construction can then see both complete operands.

## Two shared failures that boundary cleanup does not fix

### 1. Transition after a coordinated phase uses the last-written date

```text
take 1 tab at 08:00 on 4/10 and at 20:00 on 28/9
then every Sunday at 09:30 until 30/11
```

Both planners produce the same correct three segment ranges. The unchanged
`propagateDateTransitionEventTiming` then consults only the immediately preceding
item, whose date is 28 September. It sets the recurring start to 29 September.
The phase's latest exact date is 4 October, so the expected start is 5 October.
Both pipelines incorrectly include 4 October at 09:30; the expected first Sunday
is 11 October. This is **inter-clause group scope**, not a separator decision.

### 2. Meal-clock defaults disagree between scheduling APIs

For the bounded Thai Sunday phase after the explicit dates, the emitted FHIR has
`frequency: 1`, `period: 1`, `periodUnit: "wk"`, `dayOfWeek: ["sun"]`,
`when: ["PCM"]`, bounds 5 October through 30 November, and dose 0.5 tablet.

`nextDueDoses` emits eight after-breakfast Sunday occurrences. In the same window,
`calculateTotalUnits` returns **0**, rather than **4 tablets**. Supplying
`eventClock: { CM: "08:00" }` or an explicit `timeOfDay: ["08:30:00"]` returns 4.
The failure is shared by baseline and candidate; it survives identical segmentation
and FHIR. See `results/totals-diagnostic.json` for the controlled comparison.

The 08:30 timestamps in this experiment are the scheduler's default-clock fixture,
not a medically required breakfast time. No production fix is smuggled into this
boundary experiment.

## Explanation example

For the originally reported Thai date list, the actual CLI reports:

```text
KEEP  ","       [64..65] structure.no-external-split
      owner: calendar-date-list [50..85]
KEEP  "และ"     [74..77] structure.no-external-split
      owner: calendar-date-list [50..85]
SPLIT "จากนั้น" [86..93] regimen.sequence
      left: administration with dates
      right: complete recurring schedule, omitted head
```

Source offsets are JavaScript string offsets. Use `--json` to inspect selected
and rejected constraints, alternative proposals, and cost counters. Trace mode
may collect additional evidence and is excluded from runtime timing claims.

## Performance

Measurements use Node `v24.14.1` on `Intel(R) Xeon(R) W-2195 CPU @ 2.30GHz`. Both lanes execute full
`parseSig` in uninstrumented bundles. AB/BA rounds use identical inputs and options;
counters are collected separately. No test/build jobs were running concurrently
from this session. Other host activity and normal timing noise remain possible.

| Corpus | Baseline mean ms | Candidate mean ms | Baseline p95 ms | Candidate p95 ms | Gate |
|---|---:|---:|---:|---:|---|
| torture (50 cases) | 8.419 | 8.247 | 23.948 | 24.233 | pass |
| composed (20 cases) | 7.199 | 6.298 | 14.429 | 12.159 | pass |

There are 1,000 measured parses per lane for torture and 400 per lane for composed
cases, plus warm-ups. The predeclared gate permits 5% variation on both mean and
p95. Ordinary-input p95 is slightly higher, not a proven improvement; composed
cases improve materially in this sample. These are not cross-machine guarantees.

The first, eager-evidence attempt missed the torture p95 gate (about +5.7%). It is
retained as `results/performance-first.json`. Lazy evaluation removed unnecessary
HPSG probes before this result; the intermediate measurement is retained too.
No unfavorable measurement was deleted or relabelled as passing.

The 1/2/4/8/16-administration sanity probe retained the correct item count in both
lanes. At 16 items, baseline median was 104.74 ms versus candidate 67.22 ms in the
final run. Five samples per size are not enough to establish a complexity bound.
See `results/scaling.json`.

## Cost counters and ablations

Across the independent 104-case corpus:

| Counter | Baseline | Candidate |
|---|---:|---:|
| speculativeProbes | 199 | 184 |
| clauseCalls | 395 | 381 |
| lexicalCalls | 2,188 | 2,033 |
| chartSigns | 7,208 | 7,075 |
| combinationAttempts | 17,860 | 17,455 |
| chartTruncations | 0 | 0 |

Speculative probes decrease by about 7.5%, a useful but **modest** reduction, not
an order-of-magnitude result. The planner lexes once for its own walk, but the
unchanged downstream parser and action analyses still re-lex. This is not a claim
that the complete pipeline is now one lexical pass.

Ownership-disabled segmentation changed these historical fixtures:
`shared-clocks-shared-dates`. For the original Thai case, other grammatical
constraints now independently retain the correct segmentation even with ownership
disabled; it takes extra evidence work. We therefore do not claim the ablation
must reproduce that original bug in every version of the experiment.

Cache-disabled segment outputs all match: **true**. Ablations
compare the same trace-disabled mode and report probe counts separately from
correctness. No timing advantage is credited to instrumentation overhead.

## Recommended next experiment

Use the successful boundary planner as the experimental front end, then represent
coordinated administration groups and sequence edges explicitly. Test inheritance
and the latest date across a whole predecessor phase, not just adjacent result
indices. Separately unify the effective timing defaults/counting behavior so that
unit totals agree with occurrence enumeration under the same configuration.

Keep production on 0.1.66 until those independent failures are fixed, the complete
pipeline is revalidated, and the change is reviewed. Do not replace the current
clause parser with a single whole-prescription chart as part of this experiment.

## Reproduction

```sh
npm run typecheck:boundaries
npm run test:boundaries
npm run test:shadow-boundaries
npm run experiment:boundaries -- --rounds=20
npm run explain:boundaries -- '<sig>' --locale=th --reference-date=2026-09-27
```

The experiment command currently returns a nonzero exit for the retained clinical
oracle failures. All evidence is under `experiments/boundary-planner/results/`;
`validation.json` summarizes the executed suite results and package isolation is
recorded separately. Implementation, tests, and documentation remain local to the
experiment branch; no push, release, or production activation is included.
