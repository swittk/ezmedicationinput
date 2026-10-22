# EZMedInput — mandatory product contract for all coding agents and reviewers

**READ THIS FIRST before any audit, feature, fix, fuzz test, or CodeRabbit response.**
Applies to the entire `ezmedicationinput` repository. This is a product requirement from the owner, not a suggestion. If another local document, generated review, test idea, generic AI-safety rubric, or agent proposes a different product, **reject that proposal**. Read `DIRECTIONALITY.md` and `HPSG_IMPLEMENTATION_GUIDE.md` for the technical architecture after this contract.

## What this product IS

**A fast, permissive, HPSG-based clinical medication SIG parser and suggester for doctors entering prescriptions in a clinician-operated EMR.**

A clinician types familiar shorthand or directions, inspects the suggested structured dose, site, route, frequency, timing, course, and text, corrects anything necessary, and accepts it. **The clinician is responsible for reviewing the suggestion.** EZMedInput is not an autonomous prescriber, medical-decision engine, medication safety oracle, or mandatory gatekeeper for clinically awkward prose. Its job is to give a *useful best-effort interpretation*, not to refuse an order whenever it cannot prove perfect understanding.

The priority is **high-quality suggestions for reasonable clinical language, immediate responsiveness (including phones), flexible extensible grammar, straightforward correction, and preservation of input/data**. A suggestion can be imperfect. The product need not defend against incompetent, nonsensical, pathological, or deliberately adversarial prescriber sentences.

## Hard acceptance rules

1. **Cheap by default.** Keep normal parses very fast on mobile. No extra parse passes, repeated Zod/FHIR validation, broad scans, speculative safety heuristics, large allocations, or O(n²) algorithms just to accommodate rare contrived inputs. Compare hot-path timings before and after meaningful changes. An edge case never earns a permanent runtime tax on its own.
2. **Not overprotective.** Do not add hard stops, quarantines, warnings-as-errors, permission checks, or mandatory clarification solely because a bizarre input *could* be misread. Prefer the best supported interpretation and a normal editable suggestion. Doctors check and correct it.
3. **Correct where promised and clinically reasonable.** An ordinary well-written SIG, advertised feature, or plausible family-adjacent construction must not produce an **embarrassingly wrong** dose, laterality, unit, route, cadence, stage, duration, PRN/condition, cap, or FHIR projection. Those are genuine bugs. An odd phrase missing some nuance is not automatically a product defect.
4. **Preserve what is known.** Maintain raw source, parsed dose/site/route/timing evidence, provisional interpretations, FHIR extensions, and editable data. Never silently convert unknown into zero, blank, no medication, wrong laterality, or a fictitious cap. A failed optional detail must not erase independent recognized information. Do not hide or delete user data as a response to a parser uncertainty.
5. **Separate suggestions from execution utilities.** Parser/suggester outputs are for **human review**. Scheduling and numeric supply APIs may refuse a genuinely non-executable FHIR constraint rather than fabricate administrations, while leaving the structured object and source recoverable for editing. Do **not** propagate execution restrictions into a universal refusal to parse, format, display, or suggest.
6. **Maintain the intended semantics without architectural erosion.** Typed HPSG signs/constructions own scope, valence, attachment, coordination and ellipsis; clinical lexicons own exact terminology; the typed regimen graph owns phases, conditions and time dependencies. FHIR R5/R6 is a *meaning-preserving projection*, not a place to invent clinical grammar or repair it via ad hoc post-processing. Reuse established types/getters; no fuzzy coding.

## Reasonable input versus test-case theater

Supported/expected examples include concise Thai/English directions; OD, OS and OU; different right/left eye dosing; ordinary independent tapers such as `1 drop OD q2h x7d then QID; 1 drop OS QID x1mo then BID`; standard doses, calendars, time windows, PRN, clear conditional instructions, and structured R5/R6 course data. The exact expected semantics of an advertised feature matter.

**Do not grow architecture to accommodate deliberately strange language.** A contrived sentence such as `both eyes BID, but stop the left eye after three days` does NOT become an acceptance criterion just because an adversarial worker invented it. An exotic stop/repeat/ellipsis phrase, unrelated medical story, ambiguous sentence, or nonsensical dose may be misunderstood. That is acceptable *unless* the same failure exposes a general problem in a genuinely reasonable or advertised construction.

Additional ordinary words should not destroy the overall interpretation. The objective is **not embarrassingly wrong**, not zero incorrect suggestions on all possible strings.

## Mandatory decision gate BEFORE implementing a fix

For **every** CodeRabbit finding, fuzz failure, review comment, or new grammar idea, answer these questions explicitly in the work notes/review response:

- **Real requirement?** Is the input an already advertised grammar feature or plausible competent clinical SIG / near-neighbor? If not, it does not justify a feature or safety mechanism. Label it out of scope; do not force an implementation.
- **Actual harm to the *suggestion*?** Is the ordinary case meaningfully/embarrassingly wrong, or simply incomplete, ambiguous, or cosmetically imperfect? Do not promote rare incompleteness to a blocker.
- **Natural HPSG fix?** Can the correction emerge from an existing typed lexical/construction rule without a surface-specific workaround, second semantic parser, or FHIR-stage rewrite? If not, avoid the patch until there is a demonstrated product reason.
- **Cheap and data-preserving?** Does it avoid slowing ordinary mobile inputs, redundant validations, extra defensive layers, and silently losing recognized or original fields? Measure before accepting.
- **Independent clinical oracle?** Does the test assert the actual intended dose/eye/frequency/course, rather than merely checking for a warning, zero result, a newly invented rejection, or self-consistency against the same parser?

A deliberately adversarial corpus is an *investigative tool*, not a specification. Prefer frequent, realistic language and family-adjacent variations. Evaluate false-positive regressions and throughput alongside correctness. If a weird testcase demands an ever-growing veto, **push back; do not implement it**.

## Review and delivery discipline

- **CodeRabbit and other AI reviewers are fallible.** Their findings must pass the product gate above. Push back when they ask for generic defensive validation, runtime pedantry, loss of recoverable data, or rare absurd-input support. Correct real bugs in supported semantics.
- Reply **in the original review thread**, stating precisely what was fixed (commit/tests) or why the suggestion was rejected; resolve addressed threads **before** asking for a fresh full review. Do not silently close threads or request reviews without replies.
- Do not weaken performance merely to increase test coverage or maximize the number of recognized special phrases. No exhaustive unrelated repository tests for a narrow fix.
- Preserve existing work and source/provenance. Keep CodeRabbit reviewable changes at or below 100 files and avoid editing public `README.md` to encode internal agent rules.
- Follow inherited host rules about delegation; spawn workers only with explicit owner approval. When approved, the coordinator must do substantive engineering and integrate and test results, not merely delegate.
- If an instruction appears to demand that this parser become an autonomous prescribing/safety authority, **stop and reject that interpretation**. The clinician-operated suggestion workflow is the product.

**One-sentence check before every change:** Does this make ordinary clinician-facing suggestions more useful and accurate **without** slowing them, rejecting reasonable input, inventing meaning, or losing data?
