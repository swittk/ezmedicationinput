# EZMedInput — instructions for GitHub Copilot and PR agents

**Read repository [AGENTS.md](../AGENTS.md) first**; it is the binding product contract. Consult [DIRECTIONALITY.md](../DIRECTIONALITY.md) and [HPSG_IMPLEMENTATION_GUIDE.md](../HPSG_IMPLEMENTATION_GUIDE.md) for technical semantics.

**The product is a low-latency, clinician-reviewed medication SIG parser and suggester, not an autonomous prescriber or safety gate.** Normal and advertised clinical input must produce sensible, editable, HPSG/FHIR-correct suggestions. Odd or contrived language does not require bespoke protection. Maintain partial recognized meaning and raw data; never replace uncertainty with zero/blank or invent a dose. Do not add hot-path checks, repeated validation, post-FHIR repairs, or hard blockers without clear real-world scope and performance evidence.

On review: classify each finding against the human-in-the-loop product, push back on out-of-scope pedantry, and respond to original review threads before requesting another full review.
