## EZMedInput product contract — check before reviewing or merging

**Read [AGENTS.md](../AGENTS.md).** EZMedInput is a **fast, clinician-reviewed medication SIG parser/suggester**, **not** an autonomous prescriber or an exhaustive safety gate. The clinician examines, edits and accepts suggestions. Do not expand this product into a defensive validator for contrived prescriber wording.

For any behavior-changing parser, grammar, scheduler, or FHIR change, explicitly record the product decision:

- [ ] **Real clinical use:** Which advertised or plausible competent-clinician SIG does this change improve? (Mark N/A for housekeeping.)
- [ ] **Expected meaning:** Is there an independent clinical oracle for dose, site/laterality, cadence, stage, PRN, and FHIR? Could a near-neighbor become embarrassingly wrong?
- [ ] **Best-effort suggestion:** Is partial meaning, raw source text, and editability preserved? Does this avoid replacing recognized information with zero/blank, or adding a hard stop for weird prose?
- [ ] **Cheap by default:** Does the normal parsing hot path remain fast on phones? No duplicate parsing, repeated validations, added runtime safety passes, or grammar one-offs merely for adversarial strings.
- [ ] **Architecture:** HPSG owns grammar/scope, typed regimen owns stages, FHIR is a meaning-preserving projection; no post-FHIR semantic fixes.
- [ ] **CodeRabbit discipline:** Address or push back on individual review comments against the product contract; reply to original threads before requesting full review.

**A contrived corpus case is an investigative probe, NOT a feature specification.** A valid clinician suggestion may be imperfect. The product bar is correctness of reasonable/advertised semantics, good partial suggestions, throughput, and data preservation.
