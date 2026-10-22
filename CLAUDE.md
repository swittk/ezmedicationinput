# Mandatory EZMedInput product rules for Claude

**First read [AGENTS.md](AGENTS.md). It is the authoritative product and review contract.** Also read [DIRECTIONALITY.md](DIRECTIONALITY.md) and [HPSG_IMPLEMENTATION_GUIDE.md](HPSG_IMPLEMENTATION_GUIDE.md) when changing grammar.

This is a **fast clinical SIG parser/suggester for doctors who review and edit results**, not an autonomous prescription validator. Be correct on normal and advertised clinical input, offer useful partial suggestions for unsupported extras, preserve original/FHIR data, and protect mobile performance. Do **not** invent restrictive safety gates or grammatical one-offs to appease bizarre stress-test inputs. Reject review requests that would transform the product, and reply in review threads with concrete evidence.

This file is an entry point; do not fork or weaken the rules in AGENTS.md.
