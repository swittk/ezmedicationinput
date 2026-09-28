# EZMEDINPUT: green regimen experiment

Date: 28 September 2026 (Asia/Bangkok).
Branch: `experiment/explainable-boundary-planner`.
Baseline: production source at `e63ca7b` / version 0.1.66.
Initial experiment: `c9fe4fd`.
Implementation/corpus fingerprint: `dcbfaf1da36c052b48c6d3a1930a5ba003b9464e6efbac4bf205d8857457273e`.

A final whitespace check removed one extra blank line at the end of `corpus.ts`;
the fingerprint above identifies the measured version. No executable logic changed.

## Result

The retained failures are fixed in the experimental candidate. The expanded
positive clinical matrix is **231/231**, and all recorded correctness, type,
distribution and performance gates pass. Production source, published exports and
npm behavior remain unchanged. No push, merge, publication or production activation
was performed.

This is a measured candidate ready for code review, not a proof that arbitrary
medical prose can be interpreted without ambiguity.

## Validation

| Check | Result |
|---|---:|
| Existing suite on unchanged native parser | 1,210/1,210 |
| Same existing suite on candidate pipeline | 1,210/1,210 |
| Structural planner contracts | 107/107 |
| Clinical/API/English-and-Thai round-trip/safety controls | 477/477 |
| Distribution tests | 4/4 |
| Production build/declarations | pass |
| Experiment TypeScript | pass |
| Actual transformed candidate TypeScript | pass |
| Strict clinical/performance experiment | exit 0 |
| Runtime src diff / packaged experiment files | none / none |

The 477 clinical checks include the 231 golden scenarios, 31 sync/async/lint
comparisons, 62 English/Thai realization-reparse checks, 11 negative/safety checks,
4 independent scheduler boundary controls, and 88 dedicated lazy temporal-relation
checks covering order, spacing, synonyms, contradictions, and cadence omission. These counts overlap in inputs;
they are not claims of 477 independent prescriptions. The two 1,210-test rows are
the same existing suite run against two implementations.

### Independent golden scenarios

| Partition | Native baseline | Candidate |
|---|---:|---:|
| historical | 15/15 | 15/15 |
| metamorphic | 72/84 | 84/84 |
| challenge | 3/20 | 20/20 |
| specialty | 50/112 | 112/112 |
| **Total** | **140/231** | **231/231** |

The original 104-case corpus remains. The additional 112 specialty-style cases
come from 31 independently specified seeds and controlled language/spacing variants.
Expected dose, dates, clocks, phase bounds, occurrences and totals are not copied
from the baseline. All positive specialty inputs must parse without leftovers;
rejecting them as unsupported would fail, not turn the run green.

The fixtures are synthetic parser tests—not real patient records or recommended
treatment regimens. Specialty labels never enter runtime parsing or select drug
specific doses, cycle lengths, or defaults.

## What changed, and why

**Whole-phase scope.** Boundary decisions now retain typed coordination/sequence
relations. The regimen graph groups coordinated administrations. A sequence uses
the complete preceding group's finite endpoint, not the immediately preceding
array item. Explicit phase end limits outrank inference from the last dose date.
Anchored exact day/week durations support successive finite taper phases.

**One source of clock/cadence semantics.** Occurrence enumeration, historical
count caps and unit totals now share `scheduler-primitives.ts`. A weekday meal
schedule no longer yields eight occurrences but zero tablets. Explicit clocks do
not erase every-other-day, multi-week or monthly cadence. Querying partway through
a regimen keeps its original anchor. A timezone-dependent month-end calculation
was corrected; January 31 does not become the first of subsequent months.

**Validated structural ownership.** A date recognizer's candidate span cannot
swallow a following numeric dose plus unit. This fixes forms where an `until`
date followed by `and 1/2 tab` previously prevented a legitimate boundary. The
constraint is on typed quantity structure, not a new Thai/comma string exception.

**Finite cycle HPSG construction.** A shared constituent accepts explicitly
anchored day lists/ranges and finite cycle counts. It reuses the existing date
parser (including named months) and lowers to native exact `Timing.event` dates.
Day 1 is the written anchor; later offsets and cycles are arithmetic from the
written period. Missing information is never filled from a specialty label.

**FHIR lowering and inheritance.** An anchored exact day/week duration uses one
bounds choice rather than exporting both a duration and period. Explicit target
clocks override inherited meal/time anchors together. Multiple clocks make an
otherwise implicit frequency explicit. The relevant FHIR bounds and time/when
choice constraints are asserted across the specialty matrix.

**Lexical round-trip coverage.** The Thai formatter's `เดือนละครั้ง` now maps to
the existing monthly frequency meaning. This is a lexical entry, not a formatting
regex or segmentation exception. Numeric DMY remains the universal default; MDY
still requires explicit opt-in. Named-month anchors accept either textual order.

## Administration-target phases and open-ended bounds

The latest adversarial family is now explicit in the model rather than handled as an arm/leg phrase patch.

`Apply to right arm on 21/09/2026 and right arm and right leg on 22/09/2026 onwards daily`

now becomes one exact-date right-arm Dosage plus two open-ended daily Dosage items (right arm and right leg) starting 22 September. The outer `and` is a typed `regimen.target-phase-transition`; the inner target conjunction is owned as one target-list construction and only splits during FHIR lowering because `Dosage.site` is singular.

The same machinery covers target reduction, right-eye to both-eyes changes, explicit right-eye + left-eye lowering, wound/scalp expansion, Thai/code-switch variants, and omitted `Apply`/`Instill` method inheritance across a licensed target transition. Pre-coordinated `both eyes` remains one coded target. Disjunctive targets are not expanded into simultaneous administrations.

Open-ended markers are grammatical timing evidence rather than leftover cleanup. English `onward`/`onwards` and Thai `เป็นต้นไป` support `daily from DATE onwards`, `from DATE onwards daily`, and `on DATE daily onwards`. A bare `on DATE onwards` with no recurrence cadence is retained unresolved and does not invent daily recurrence.

The target recognizer is bounded and cue-gated: only coordinators with resolvable body-site atoms on both sides trigger compound-target analysis. Anatomical text in warnings such as “avoid face and eyes” is not promoted to administration targets; disjunctive targets remain alternatives instead of fabricated simultaneous sites. This recovered the legacy performance gate after an initial ~30% ordinary-input regression exposed by benchmarking.

## Lazy temporal-relation audit

The temporal bound surface is now normalized through one typed relation vocabulary rather than phrase-order patches. Positive coverage includes English `after`, `before`, `from`, `since`, `starting`, `beginning`, `as of`, `as from`, `prior to`, `through`, `till`, and `from DATE on`; Thai covers `หลัง`, `หลังจาก`, `ก่อน`, `ก่อนถึง`, `ตั้งแต่`, `นับตั้งแต่`, `นับจาก`, `นับแต่`, `เริ่ม`, `เริ่มใช้`, `มีผลตั้งแต่`, `ถึง`, `ต่อไป`, and `เป็นต้นไป`. Cadence may precede or follow the bound, a dangling `and/และ` before cadence no longer contaminates the site, and common Thai no-space forms are exercised.

The experiment also handles date-bound text glued directly to Thai text when the raw calendar recognizer already confirms the date span, e.g. `ตั้งแต่22/9/69ไป` and `หลังจาก22/9/69เป็นต้นไป`. This uses a bounded lexical split at the recognized numeric date boundaries, not a general Thai/digit split.

Bare `after X / before X / หลัง X / ก่อน X` without cadence is recognized as a bound but remains incomplete; no daily frequency is invented. Contradictory forms such as `before DATE onwards` or `ถึง DATE ต่อไป` are quarantined as non-executable instead of guessed. Workflow timing such as `after each bowel movement` remains distinct from calendar-date bounds; the full 1,210-case shadow suite explicitly caught and protected that distinction. Ambiguous `up to DATE` is quarantined rather than assigned inclusive or exclusive semantics.

## Harder coverage

The new scenarios include variable weekday half-tablet doses; weekly rather than
daily administration; alternating days and multi-week intervals; distinct
clock-specific doses; finite steroid-style tapers; renal weekday schedules;
ophthalmic clock tapers; cross-midnight pairs; treatment/rest cycles; quarter-tablets
and fractional liquids; and night/week skin-care patterns. English, Thai lexemes,
fully Thai examples, code switching and lazy spacing are exercised.

Representative positive inputs:

```text
take 4 tab daily at 08:00 from 28/9 for 3 days
then 2 tab daily at 08:00 for 3 days
then 1 tab daily at 08:00 for 3 days

take 1 tab at 08:00 and 20:00 on days 1-14
every 21 days starting 28/9/2026 for 2 cycles

รับประทาน .5 เม็ด เวลา 08:00 วันที่ของรอบ 1,8,15
ทุก 28 วัน เริ่มวันที่ 28/9/69 จำนวน 2 รอบ
```

The first has separate September 28–30, October 1–3 and October 4–6 phases,
with totals 12, 6 and 3 tablets. The treatment/rest example produces 56 occurrences,
not continuous daily dosing through the rest week. The Thai cycle example produces
six explicit occurrences, totaling three tablets for the synthetic half-tablet dose.

Negative tests cover absent/invalid cycle anchors, missing period or cycle count,
invalid/out-of-cycle day ranges, contradictory explicit phase starts, ambiguous
inherited clocks, and preservation of PRN/ranged-dose semantics. Invalid recognized
schedules retain original text and dose with diagnostics; they do not become a
fabricated recurring schedule. These are negative checks, not supported protocols.

Scheduler controls directly test DST wall-clock stability, month-end anchoring,
historical count caps on non-daily cadence, and duplicate date/clock deduplication.
Default after-breakfast times in fixtures are scheduler configuration, not medical
recommendations.

## Performance

Paired AB/BA full `parseSig` calls, 30 rounds, with instrumentation disabled in the
timed bundles. The legacy corpora are unchanged. No tests/build jobs from this
session ran concurrently; other host activity remains possible.

| Corpus | Native mean ms | Candidate mean ms | Native p95 ms | Candidate p95 ms | Gate |
|---|---:|---:|---:|---:|---|
| torture (50 cases) | 8.395 | 8.655 | 23.608 | 24.077 | pass |
| composed (20 cases) | 7.443 | 6.828 | 14.791 | 13.153 | pass |
| new challenges (15 cases) | 7.409 | 9.173 | 12.188 | 16.018 | pass* |
| specialty (112 cases) | 9.993 | 8.640 | 24.546 | 20.255 | pass* |

The ordinary-input result remains within the legacy tolerance (~3.1% slower mean / ~2.0% slower p95). The fixed
20-case legacy composed corpus is faster (~8.3% mean / ~11.1% p95). New-challenge
and specialty ratios are descriptive because the old parser is wrong on many of
those inputs; those sets use the stated candidate p95 <100 ms guard. The fixed
legacy torture/composed corpora retain the 5% mean/p95 gate.

Across the 231 golden scenarios, speculative HPSG probes fall from
**433 to 308** and total clause parses from
**841 to 703**. Both lanes have zero chart truncations.
The small 16-administration scaling check is retained separately; it is not an
asymptotic complexity proof.

Both new-generation performance runs are retained, along with the original
experiment's measurements. No claim of improved correctness is inferred from
speed: independent oracles and execution checks establish the measured correctness.

## Architecture and delivery boundary

This remains a bounded clause HPSG plus an explainable boundary/regimen layer,
not one unbounded chart over an entire prescription. Some existing compatibility
rules and carry-forward behavior remain; this is not a claim to have removed all
heuristics or solved arbitrary discourse.

The test/build adapter selects real experimental modules and verified integration
seams without editing production files. The transformed implementation itself is
typechecked in a separate mirror. The adapter must not be shipped as a production
runtime source patcher; reviewed integration should move the components into their
proper source modules.

FHIR tests verify relevant structure and executable round trips, not byte-identical
natural-language output or a complete official HL7 validation certificate. Anchored
finite day/week phase inference and finite cycle/day-offset syntax have explicit
scope; unspecified future clinical decisions are not guessed.

## Reproduction and retained evidence

```sh
npm run typecheck:boundary-integration
npm run test:boundaries
npm run test:boundary-clinical
npm run test:shadow-boundaries
npm run experiment:boundaries -- --rounds=30
npm run explain:boundaries -- '<sig>' --locale=th --reference-date=2026-09-27
```

`results/clinical-executions.json` contains expected and actual executable timelines
and phase graphs. `correctness.json`, `validation.json`, `performance.json`,
`costs.json`, `scaling.json`, and `promotion-gates.json` record the checks.
The initial red experiment is preserved under `results/initial-experiment/`.
All code and evidence remain on the local experiment branch; no BPP was performed.

## Source notes

FHIR R5 datatype definitions specify the single `Timing.repeat.bounds[x]` choice
and the `when`/`timeOfDay` constraint (tim-10):
https://hl7.org/fhir/R5/datatypes-definitions.html#Timing.repeat.bounds_x_

The broad weekly/cycle syntax categories were informed by public NHS methotrexate
and NCI chemotherapy descriptions. Exact test inputs and quantities above were
independently authored and are not clinical protocols from those sources:
https://www.nhs.uk/medicines/methotrexate/how-and-when-to-take-methotrexate/
https://www.cancer.gov/about-cancer/treatment/types/chemotherapy
