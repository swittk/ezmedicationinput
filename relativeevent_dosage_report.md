In base FHIR R5 core, I do **not** see a clean native way to say “give this once after some arbitrary future event whose datetime is not known yet” inside `Dosage.timing`. The two core timing mechanisms are:

* `Timing.repeat.when` + `offset`, which is bound to the `EventTiming` value set of mostly daily-life anchors such as meals, waking/sleep, morning/evening, etc.
* `Timing.event`, which is a list of **specific** `dateTime` occurrences once you know them. ([hl7.org][1])

So for `once after menstruation ends`, core R5 can handle the dose, route, site, and later the resolved datetime, but not the unresolved arbitrary trigger itself. `TriggerDefinition` does exist in R5, but it is a workflow/knowledge datatype used in places like `PlanDefinition` and `EventDefinition`, not in `Dosage`; FHIR puts “when some event triggers an action” logic there, and `PlanDefinition` application typically yields requests grouped in `RequestOrchestration`. ([hl7.org][2])

My recommendation is to separate three things:

1. **Definite dosage facts** in core `Dosage`
   Keep route/site/dose/quantity structured as you already do.

2. **Literal human instruction** in `Dosage.text`
   That field is explicitly the free-text SIG. By contrast, `additionalInstruction` is for supplemental instructions/warnings, and `patientInstruction` is patient-facing wording, so neither is a great primary home for computable contingent timing. ([hl7.org][3])

3. **Unresolved contingent trigger** in either:

   * a **custom extension** on `Dosage.timing` (most practical inside a single dosage instance), and/or
   * a **workflow/domain layer** outside `Dosage` (cleanest architecture if your app tracks triggering events formally).

I would **not**:

* fake `Timing.event` from `orderedAt`
* invent a fake schedule timestamp
* convert `once` into `once daily`
* partially populate `Timing.repeat` in a way that looks more computable than it really is

If you want the most standards-friendly option beyond pure custom modeling, HL7’s extensions pack does have event-relative date extensions. The newer `relative-date` extension is defined for `date`/`dateTime`, and the older `cqf-relativeDateTime` is now deprecated in favor of a newer `relative-time` direction. But these are **not base R5 Dosage features**, they come from the HL7 extensions pack CI stream, and they are framed around a target event/resource being defined. That makes them more suitable **after** you have an actual event resource or explicit event anchor than for a completely unresolved generic future event. ([build.fhir.org][4])

So the pattern I’d use is:

```json
{
  "text": "Insert 1 tab pv once after menstruation ends",
  "route": { "...": "..." },
  "site": { "...": "..." },
  "doseAndRate": [
    {
      "doseQuantity": { "value": 1, "unit": "tablet" }
    }
  ],
  "timing": {
    "extension": [
      {
        "url": "https://example.org/fhir/StructureDefinition/event-relative-trigger",
        "extension": [
          {
            "url": "triggerCode",
            "valueCodeableConcept": { "text": "menstruation ends" }
          },
          {
            "url": "relationship",
            "valueCode": "after"
          },
          {
            "url": "offsetDuration",
            "valueDuration": {
              "value": 0,
              "system": "http://unitsofmeasure.org",
              "code": "s"
            }
          },
          {
            "url": "occurrencePolicy",
            "valueCode": "next-occurrence"
          },
          {
            "url": "resolutionStatus",
            "valueCode": "unresolved"
          }
        ]
      }
    ]
  }
}
```

Good extension fields would be:

* `triggerCode` or `triggerType`
* `relationship` (`before|after|concurrent`)
* `offset`
* `occurrencePolicy` (`next-occurrence`, `current-occurrence`, etc.)
* `triggerReference` once known
* `resolutionStatus`

That lets you preserve structure now without lying in core `Timing`.

When the trigger datetime becomes known, for this exact case the cleanest resolution is to **materialize a concrete `Timing.event`**:

```json
{
  "timing": {
    "event": ["2026-05-14T20:00:00+07:00"]
  }
}
```

That is the simplest standards-aligned end state for a one-time contingent dose. `Timing.event` is specifically for identified times when the event occurs, and the spec explicitly notes that this is how a general timing can be turned into a precise one for operational use such as a MAR. ([hl7.org][1])

For a more complex contingent regimen, once the anchor is known you can derive a normal `Timing.repeat`/`bounds` structure instead. But for **one dose after event X**, a single `Timing.event` is the cleanest resolved form.

Operationally, I would make your calculators distinguish **computable scheduled quantity** from **contingent intended quantity**:

* `nextDueDoses`
  Return **no due doses** until the trigger resolves, but include a machine-readable unresolved contingent item.

* `calculateTotalUnits`
  Do **not** make plain `0` the universal answer.
  Better model:

  * `computableUnitsInWindow = 0`
  * `dueDoses = []`
  * `contingentUnits = 1 tab`
    or `unknown/indeterminate` if your function only supports one scalar.

Using plain `0` for all meanings is risky because it conflates:

* “nothing is due yet”
  with
* “this order has no future medication quantity”

Those are not the same.

So the answer I’d implement is:

* **Inside core Dosage:** keep only what is definitely true now.
* **For the unresolved event-relative trigger:** use a custom extension and/or workflow layer.
* **When the event becomes known:** resolve to concrete `Timing.event`.
* **For schedule math before resolution:** no due doses; computable quantity is zero in the current window, but contingent quantity should remain structurally visible.

If you want, I can turn this into a concrete TypeScript shape for your parser AST plus a FHIR serialization/deserialization strategy.

[1]: https://hl7.org/fhir/R5/datatypes-definitions.html "https://hl7.org/fhir/R5/datatypes-definitions.html"
[2]: https://hl7.org/fhir/R5/metadatatypes-definitions.html "https://hl7.org/fhir/R5/metadatatypes-definitions.html"
[3]: https://hl7.org/fhir/R5/dosage.html "https://hl7.org/fhir/R5/dosage.html"
[4]: https://build.fhir.org/ig/HL7/fhir-extensions/StructureDefinition-relative-date.html "https://build.fhir.org/ig/HL7/fhir-extensions/StructureDefinition-relative-date.html"
