import { equalStructuredValues, cloneStructuredValue } from "../src/stable-structure";
import { describe, expect, it } from "vitest";
import conditionalDoseProfile from "../fhir/r5/medication-conditional-dose.json";
import renderedInstructionProfile from "../fhir/r5/medication-rendered-instruction.json";
import conditionLogicProfile from "../fhir/r6/medication-r6-condition-logic.json";
import {
  parseSig, parseSigAsync, fromFhir, formatSig, formatSigBatch, formatParseBatch, nextDueDoses, calculateTotalUnits,
  toDosageDetails, toFhirR5Dosages, toEzDosages, fromDosageDetails,
  evaluateMedicationCondition, setDosageCondition, getDosageCondition,
  type FhirR6DosageDetails, type FhirExtension, type EzDosage, type MedicationCondition,
  EventTiming, FhirPeriodUnit
} from "../src/index";
import {
  canonicalFromFhir, parserStateFromFhir, TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
  toFhir as parserStateToFhir, getAdministrationOffsetMinutes, ADMINISTRATION_OFFSET_EXTENSION_URL,
  buildInfusionCarrierMaterialStructureDefinition
} from "../src/fhir";
import { parseMedicationGuard } from "../src/medication-condition";
import {
  DOSAGE_ALTERNATIVE_CHOICE_URL, getDosageAlternativeChoice,
  setDosageAlternativeChoice, buildDosageAlternativeChoiceStructureDefinition
} from "../src/dosage-course";

describe("EZMED extended R5 dosage and R6 projection", () => {
  it("returns flat extended R5-ish dosages and a separate native R6 course", () => {
    const result = parseSig("1 tab po bid");
    expect(result.fhir).toHaveLength(1);
    expect(result.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({value:1,unit:"tab"});
    expect(result.fhirNext).toMatchObject({
      renderedInstruction: "1 tab po bid",
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }]
    });
    expect(result.fhirNext.step[0].component[0]).not.toHaveProperty("sequence");
    expect(result.fhirNext.step[0].component[0]).not.toHaveProperty("asNeededBoolean");
  });

  it("distinguishes sequential taper stages from concurrent components", () => {
    const result = parseSig("1 drop OD q2h x1wk then qid x1wk then bid x1wk");
    expect(result.fhirNext.step.map(step => step.component.length)).toEqual([1, 1, 1]);
    expect(result.fhirNext.step[0].component[0].site?.concept?.text).toBe("right eye");
    const r5 = toFhirR5Dosages(result.fhirNext);
    expect(r5.map(dosage => dosage.sequence)).toEqual([1, 2, 3]);
    expect(toDosageDetails(r5)).toEqual(result.fhirNext);
  });

  it("imports R6 as structured data rather than reparsing generated text", () => {
    const original = parseSig("1 drop OD q2h x1wk then qid x1wk then bid x1wk").fhirNext;
    const imported = fromFhir(JSON.parse(JSON.stringify(original)));
    expect(imported.fhirNext).toEqual(original);
    expect(imported.fhir.map(v => v.sequence)).toEqual([1, 2, 3]);
    expect(imported.count).toBe(3);
    expect(formatSig(imported.fhirNext)).toBe(original.renderedInstruction);
  });

  it("retains R6 conditional semantics and R5 modifier bridge", () => {
    const result = parseSig("Take 1 tablet BID only if BP >160, otherwise hold");
    expect(result.fhirNext.step[0].component[0].condition?.[0]).toMatchObject({
      operation: "gt", valueQuantity: { value: 160 }
    });
    const r5 = toFhirR5Dosages(result.fhirNext);
    expect(r5).toHaveLength(1);
    expect(r5[0].modifierExtension?.length).toBeGreaterThan(0);
    expect(toDosageDetails(r5)).toEqual(result.fhirNext);
    const options = {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 2
    };
    expect(nextDueDoses(result, options)).toEqual([
      "2026-10-19T08:00:00+07:00",
      "2026-10-19T20:00:00+07:00"
    ]);
    expect(nextDueDoses(result, {
      ...options,
      evaluateCondition: condition => evaluateMedicationCondition(condition, { bp: 160 })
    })).toEqual([]);
  });

  it("uses the same full-course scheduler for R6 and R5 conversions", () => {
    const result = parseSig("1 drop OD q2h x1wk then qid x1wk then bid x1wk");
    const options = {
      from: "2026-11-02T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 2
    };
    const nextR6 = nextDueDoses(result, options);
    expect(nextR6).toEqual([
      "2026-11-02T08:00:00+07:00",
      "2026-11-02T20:00:00+07:00"
    ]);
    // A caller that understands the local R5 course modifier can schedule
    // this finite taper with the same semantics as native R6.
    expect(nextDueDoses(toFhirR5Dosages(result.fhirNext), options)).toEqual(nextR6);
  });

  it("preserves and best-effort schedules an R6 whole-course repeat cycle", () => {
    const base = parseSig("1 tab daily").fhirNext;
    const course = { ...base, repeatCycle: { value: 28, unit: "d" } };
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
    expect(nextDueDoses(course, {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 4
    })).toEqual([
      "2026-10-19T09:00:00+07:00",
      "2026-10-20T09:00:00+07:00",
      "2026-10-21T09:00:00+07:00",
      "2026-10-22T09:00:00+07:00"
    ]);
  });

  it("recovers retained R6 meaning while preserving malformed and conflicting provenance", () => {
    const expected = parseSig(
      "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid"
    ).fhirNext;
    const semantics = (course: FhirR6DosageDetails) => course.step.map(step => ({
      start: step.start?.offsetDuration,
      end: step.end?.offsetDuration,
      component: step.component.map(component => ({
        site: component.site?.concept?.text,
        timingCode: component.timing?.code?.text,
        dose: component.doseAndRate?.[0]?.doseQuantity
      }))
    }));
    const r5 = JSON.parse(JSON.stringify(toFhirR5Dosages(expected))) as
      ReturnType<typeof toFhirR5Dosages>;
    expect(r5).toHaveLength(6);
    const first = r5[0].modifierExtension?.find(ext => ext.url.includes("course-details"));
    first!.extension![0].valueString = "{bad";
    const recovered = toDosageDetails(r5);
    expect(recovered.renderedInstruction).toBe(expected.renderedInstruction);
    expect(semantics(recovered)).toEqual(semantics(expected));
    expect(recovered.extension).toContainEqual(expect.objectContaining({
      url: expect.stringContaining("medication-course-reconciliation-warning"),
      valueString: expect.stringContaining("Malformed retained R6 course metadata")
    }));
    const recoveredSources = recovered.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")
    ) ?? [];
    expect(recoveredSources).toHaveLength(2);
    expect(recoveredSources.some(extension => extension.extension?.[0].extension?.[0].valueString === "{bad")).toBe(true);

    const conflicting = JSON.parse(JSON.stringify(toFhirR5Dosages(expected))) as
      ReturnType<typeof toFhirR5Dosages>;
    const second = conflicting[1].modifierExtension?.find(ext => ext.url.includes("course-details"));
    const structured = second!.extension!.find(child => child.url === "dosageDetails")!;
    const firstStep = structured.extension!.find(child => child.url === "step")!;
    const end = firstStep.extension!.find(child => child.url === "end")!;
    end.extension!.find(child => child.url === "offsetDuration")!.valueQuantity!.value = 8;
    const reconciled = toDosageDetails(conflicting);
    expect(semantics(reconciled)).toEqual(semantics(expected));
    expect(reconciled.extension).toContainEqual(expect.objectContaining({
      url: expect.stringContaining("medication-course-reconciliation-warning"),
      valueString: expect.stringContaining("snapshots differ")
    }));
    const conflictingSources = reconciled.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")
    ) ?? [];
    expect(conflictingSources).toHaveLength(2);
    expect(equalStructuredValues(conflictingSources[0], conflictingSources[1])).toBe(false);
    expect(conflictingSources.every(extension => extension.extension?.length && extension.valueString === undefined)).toBe(true);
  });

  it("keeps optional real R6 semantics on normal EZMED dosages", () => {
    const course: FhirR6DosageDetails = {
      renderedInstruction: "Dose guided by weight",
      step: [{
        component: [{
          condition: [{ code: { text: "Only if tolerated" }, text: "Only if tolerated" }],
          safety: { doseLimit: [{
            scope: "administration", valueQuantity: { value: 5, unit: "mg" }
          }] },
          doseAndRate: [{
            doseExpression: { language: "text/fhirpath", expression: "%patient.weight * 0.5" }
          }],
          site: { reference: { reference: "BodyStructure/123" } }
        }]
      }]
    };
    const imported = fromDosageDetails(course);
    expect(imported.dosages).toMatchObject([{
      condition: [{ text: "Only if tolerated" }],
      safety: { doseLimit: [{ scope: "administration" }] },
      doseAndRate: [{
        doseExpression: { expression: "%patient.weight * 0.5" }
      }],
      siteReference: { reference: "BodyStructure/123" }
    }]);
    expect(toDosageDetails(imported.dosages, undefined, imported.course)).toEqual(course);
    const r5 = toFhirR5Dosages(imported.dosages, imported.course);
    expect(r5[0]).not.toHaveProperty("condition");
    expect(r5[0]).not.toHaveProperty("safety");
    expect(r5[0]).not.toHaveProperty("siteReference");
    expect(r5[0].doseAndRate?.[0]).not.toHaveProperty("doseExpression");
    expect(toDosageDetails(r5)).toEqual(course);
  });

  it("lifts missing R5 safety independently of existing R6 site metadata", () => {
    const input = {
      siteReference: { reference: "BodyStructure/example" },
      maxDosePerAdministration: { value: 2, unit: "tab" },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const lifted = toEzDosages([input])[0];
    expect(lifted.siteReference).toEqual(input.siteReference);
    expect(lifted.safety?.doseLimit?.[0]).toMatchObject({
      scope: "administration", valueQuantity: { value: 2, unit: "tab" }
    });
  });

  it("retains R6-only approximate safety without illegally lowering it to R5 SimpleQuantity", () => {
    const original: FhirR6DosageDetails = {
      renderedInstruction: "Maximum is approximate and requires review",
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }],
        safety: { doseLimit: [
          { scope: "administration", valueQuantity: {
            value: 5, unit: "mg", comparator: "~"
          }},
          { scope: "period", valueQuantity: {
            value: 15, unit: "mg", comparator: "ad"
          }, period: { value: 1, unit: "d" } }
        ] }
      }] }]
    };
    const r5 = toFhirR5Dosages(original);
    expect(r5).toHaveLength(1);
    expect(r5[0].maxDosePerAdministration).toBeUndefined();
    expect(r5[0].maxDosePerPeriod?.[0]?.numerator.comparator).toBe("ad");
    expect(toDosageDetails(r5)).toEqual(original);
    // R5 representation retains non-representable R6 semantics as a
    // modifier, not as falsely precise maxima.
    expect(r5[0].modifierExtension).toContainEqual(expect.objectContaining({
      url: expect.stringContaining("medication-r6-course-details")
    }));
  });

  it("composes independent site tapers into concurrent, bounded global steps", () => {
    const input = "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid";
    const parsed = parseSig(input);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.fhir.map(dose => dose.sequence)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2, 2]);
    expect(parsed.fhirNext.step[0].end?.offsetDuration?.value).toBe(7);
    expect(parsed.fhirNext.step[1].end?.offsetDuration?.code).toBe("mo");
    expect(nextDueDoses(parsed, {
      from: "2026-11-19T12:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 4
    })).toEqual([
      "2026-11-19T12:00:00+07:00", "2026-11-19T16:00:00+07:00",
      "2026-11-19T20:00:00+07:00", "2026-11-19T20:00:00+07:00"
    ]);
  });

  it("has the same R6 result shape through the asynchronous entry point", async () => {
    const a = parseSig("1 drop OS qid");
    const b = await parseSigAsync("1 drop OS qid");
    expect(b.fhir).toEqual(a.fhir);
    expect(b.fhirNext).toEqual(a.fhirNext);
  });
});

const timingFamilyOptions = {
  from: "2026-10-21T00:00:00+07:00",
  orderedAt: "2026-10-21T00:00:00+07:00",
  timeZone: "Asia/Bangkok",
  limit: 8
};

describe("FHIR R5 Timing invariant and clinical scheduling safety", () => {
  it("preserves event timing and exact clocks together for clinician review", () => {
    const text = "1 tab po before breakfast and at 08:00";
    const parsed = parseSig(text);
    const repeat = parsed.fhir[0].timing?.repeat;
    expect(repeat?.when).toEqual(["ACM"]);
    expect(repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.warnings).toEqual([]);
    expect(nextDueDoses(parsed.fhir, timingFamilyOptions).length).toBeGreaterThan(0);
  });

  it("keeps a daily cadence plus two explicit clocks instead of erasing timing", () => {
    const text = "1 tab po daily at 08:00 and 20:00";
    const parsed = parseSig(text);
    expect(parsed.fhir[0].timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      timeOfDay: ["08:00:00", "20:00:00"]
    });
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
  });

  it("permits two explicit BID clocks without inventing an extra dose", () => {
    const text = "1 tab po BID at 08:00 and 20:00";
    const parsed = parseSig(text);
    expect(parsed.warnings.some(w => w.includes("frequency-clock-count-conflict")))
      .toBe(false);
    expect(parsed.fhir[0].timing?.repeat?.timeOfDay)
      .toEqual(["08:00:00", "20:00:00"]);
    expect(parsed.fhir[0].timing?.repeat?.frequency).toBe(2);
  });

  it("identifies standard HL7 timing abbreviations with the official coding system", () => {
    const parsed = parseSig("1 tab po BID");
    expect(parsed.fhir[0].timing?.code?.coding?.[0]).toMatchObject({
      system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation",
      code: "BID"
    });
  });

  it("round-trips local text-only Q12H without inventing a coded terminology identity", () => {
    const dosage = parseSig("1 tab PO Q12H").fhir[0];
    expect(dosage.timing?.code?.coding).toBeUndefined();
    expect(canonicalFromFhir(dosage).schedule?.timingCode).toBe("Q12H");
    expect(parserStateFromFhir(dosage).timingCode).toBe("Q12H");
  });

  it("does not promote arbitrary FHIR timing prose to a lexical timing code", () => {
    const dosage = { timing: { code: { text: "before breakfast when awake" } } };
    expect(canonicalFromFhir(dosage).schedule?.timingCode).toBeUndefined();
    expect(parserStateFromFhir(dosage).timingCode).toBeUndefined();
  });

  it("does not misrepresent local Q12H as a standard GTS abbreviation", () => {
    const parsed = parseSig("1 tab po Q12H");
    const code = parsed.fhir[0].timing?.code;
    expect(code?.coding?.some(entry =>
      entry.system === "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation")).not.toBe(true);
    expect(code?.text).toBe("Q12H");
  });
});


describe("R5 edit versus retained R6 executable expression ownership", () => {
  const original: FhirR6DosageDetails = {
    renderedInstruction: "Adjust the dose by body weight twice daily",
    step: [{ component: [{
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
      doseAndRate: [{
        doseExpression: {
          language: "text/fhirpath", expression: "%patient.weight * 0.5"
        },
        rateExpression: {
          language: "text/fhirpath", expression: "%patient.weight / 24"
        }
      }]
    }] }]
  };

  it("retains each R6 expression when an unrelated R5 timing field changes", () => {
    const rows = toFhirR5Dosages(original);
    rows[0].timing!.repeat!.frequency = 3;
    const restored = toDosageDetails(rows);
    const component = restored.step[0].component[0];
    expect(component.timing?.repeat?.frequency).toBe(3);
    expect(component.doseAndRate).toHaveLength(1);
    expect(component.doseAndRate?.[0].doseExpression?.expression)
      .toBe("%patient.weight * 0.5");
    expect(component.doseAndRate?.[0].rateExpression?.expression)
      .toBe("%patient.weight / 24");
  });

  it("never activates a previous weight formula beside a clinician-edited numeric dose", () => {
    const rows = toFhirR5Dosages(original);
    rows[0].doseAndRate![0].doseQuantity = { value: 2, unit: "mg" };
    const restored = toDosageDetails(rows);
    const component = restored.step[0].component[0];
    expect(component.doseAndRate).toHaveLength(1);
    expect(component.doseAndRate?.[0].doseQuantity).toEqual({ value: 2, unit: "mg" });
    expect(component.doseAndRate?.[0].doseExpression).toBeUndefined();
    // Editing dose does not supersede a distinct rate expression.
    expect(component.doseAndRate?.[0].rateExpression?.expression)
      .toBe("%patient.weight / 24");
    expect(restored.renderedInstruction).toBeUndefined();
    expect(restored.extension).toContainEqual(expect.objectContaining({
      url: expect.stringContaining("medication-course-reconciliation-warning"),
      valueString: expect.stringContaining("superseded by edited R5 dose fields")
    }));
    const provenance = restored.extension?.filter(extension =>
      extension.url.endsWith("medication-course-reconciliation-source")) ?? [];
    expect(provenance).not.toHaveLength(0);
    // The original formula stays inert in the structured source snapshot.
    const originalSnapshot = provenance.find(extension =>
      extension.extension?.[0]?.url?.includes("course-details"));
    expect(originalSnapshot).toBeDefined();
    const encodedOriginal = originalSnapshot?.extension?.[0]
      ?.extension?.find(extension => extension.url === "dosageDetails");
    expect(encodedOriginal).toBeDefined();
    // Persisting the updated R6 course as strict R5 and reopening it cannot
    // resurrect the old expression as a second executable dose.
    const reopened = toDosageDetails(toFhirR5Dosages(restored));
    const live = reopened.step[0].component[0];
    expect(live.doseAndRate).toHaveLength(1);
    expect(live.doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(live.doseAndRate?.[0].doseExpression).toBeUndefined();
    // The public app import must consume the same edited dose, not revive the
    // original formula hidden inside immutable source-provenance markers.
    const reopenedByApp = fromFhir(toDosageDetails(toFhirR5Dosages(restored)));
    expect(reopenedByApp.fhirNext.step[0].component[0].doseAndRate)
      .toHaveLength(1);
    expect(reopenedByApp.fhirNext.step[0].component[0].doseAndRate?.[0]
      .doseQuantity?.value).toBe(2);
    expect(reopenedByApp.fhirNext.step[0].component[0].doseAndRate?.[0]
      .doseExpression).toBeUndefined();
  });

  it("supersedes only the edited rate while retaining an unchanged dose expression", () => {
    const rows = toFhirR5Dosages(original);
    rows[0].doseAndRate![0].rateQuantity = { value: 10, unit: "mL/h" };
    const restored = toDosageDetails(rows);
    const active = restored.step[0].component[0].doseAndRate;
    expect(active).toHaveLength(1);
    expect(active?.[0].rateQuantity).toEqual({ value: 10, unit: "mL/h" });
    expect(active?.[0].rateExpression).toBeUndefined();
    expect(active?.[0].doseExpression?.expression)
      .toBe("%patient.weight * 0.5");
    expect(restored.extension?.some(extension =>
      extension.url.endsWith("medication-course-reconciliation-source"))).toBe(true);
  });
});


describe("FHIR R5/R6 coded instruction and source-edit invariants", () => {
  it("keeps an edited stopping instruction authoritative while archiving the original", () => {
    const code = (value: string, display: string) => ({
      coding: [{ system: "http://snomed.info/sct", code: value, display }],
      text: display
    });
    const original: FhirR6DosageDetails = {
      renderedInstruction: "Take 1 tablet twice daily; do not stop without doctor approval",
      step: [{ start: { offsetDuration: { value: 0, unit: "d" } }, component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
        patientInstruction: "Do not stop without doctor approval",
        additionalInstruction: [code("419444006",
          "Do not stop taking this medicine except on your doctor's advice")]
      }] }]
    };
    const rows = toFhirR5Dosages(original);
    rows[0].additionalInstruction = [code("1287353006", "Until symptoms improve")];
    rows[0].patientInstruction = "Continue until symptoms improve";
    const updated = toDosageDetails(rows);
    const live = updated.step[0].component[0];
    expect(live.additionalInstruction?.map(instruction => instruction.coding?.[0]?.code))
      .toEqual(["1287353006"]);
    expect(live.patientInstruction).toBe("Continue until symptoms improve");
    expect(live.timing?.repeat?.boundsPeriod).toBeUndefined();
    expect(updated.renderedInstruction).toBeUndefined();
    const historic = updated.extension?.find(extension =>
      extension.url.endsWith("medication-course-reconciliation-source"));
    expect(historic).toBeDefined();
    const containsOriginalCodedAdvice = (extension: FhirExtension): boolean =>
      extension.valueCodeableConcept?.coding?.some(coding =>
        coding.code === "419444006") === true ||
      extension.extension?.some(containsOriginalCodedAdvice) === true;
    expect(containsOriginalCodedAdvice(historic!)).toBe(true);
    const reopened = toDosageDetails(toFhirR5Dosages(updated));
    expect(reopened.step[0].component[0].additionalInstruction?.[0].coding?.[0]?.code)
      .toBe("1287353006");
    expect(reopened.step[0].component[0].patientInstruction)
      .toBe("Continue until symptoms improve");
  });

  it("preserves the Boolean expression rather than converting AND into R6 condition OR", () => {
    const original = parseSig("1 tablet twice daily").fhir[0];
    const together = {
      kind: "all" as const,
      conditions: [
        { kind: "measurement" as const, name: "systolic BP",
          operation: "gt" as const, value: 160, text: "systolic BP > 160" },
        { kind: "measurement" as const, name: "heart rate",
          operation: "ge" as const, value: 60, text: "heart rate >= 60" }
      ]
    };
    // R5 expresses this as one nested structural modifier. R6 condition[]
    // is disjunctive, so the entire AND remains one native R6 condition.
    setDosageCondition(original, together);
    const course = toDosageDetails([original]);
    expect(course.step[0].component[0].condition).toHaveLength(1);
    const reread = toFhirR5Dosages(course);
    expect(getDosageCondition(reread[0])).toEqual(together);
    expect(getDosageCondition(toFhirR5Dosages(toDosageDetails(reread))[0]))
      .toEqual(together);
    expect(course.step[0].component[0].asNeeded).toBeUndefined();
  });
});

describe("R5 expression reconciliation repeat-save invariants", () => {
  it("does not grow the original expression snapshot across repeated R5 edit/save cycles", () => {
    const formula: FhirR6DosageDetails = {
      renderedInstruction: "Weight-adjusted twice daily",
      step: [{ component: [{
        doseAndRate: [{
          doseExpression: { language: "text/fhirpath", expression: "%patient.weight * 0.5" }
        }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } }
      }] }]
    };
    let rows = toFhirR5Dosages(formula);
    rows[0].doseAndRate![0].doseQuantity = { value: 2, unit: "mg" };
    let baseline: { sources: number; warnings: number; markers: number } | undefined;
    for (let cycle = 0; cycle < 6; cycle++) {
      const reloaded = toDosageDetails(rows);
      const active = reloaded.step[0].component[0].doseAndRate;
      expect(active).toHaveLength(1);
      expect(active?.[0].doseExpression).toBeUndefined();
      expect(active?.[0].doseQuantity?.value).toBe(2);
      const evidence = {
        sources: reloaded.extension?.filter(ext => ext.url.endsWith("medication-course-reconciliation-source")).length ?? 0,
        warnings: reloaded.extension?.filter(ext => ext.url.endsWith("medication-course-reconciliation-warning")).length ?? 0,
        markers: rows[0].modifierExtension?.filter(ext => ext.url.includes("medication-r6-course-details")).length ?? 0
      };
      if (!baseline) baseline = evidence;
      else expect(evidence).toEqual(baseline);
      rows = toFhirR5Dosages(reloaded);
    }
  });
});


describe("FHIR event-local timing projection invariants", () => {
  it("retains event-local offsets as typed FHIR extensions without inventing a global offset", () => {
    const activity = (relation: "before" | "after", minutes: number) => ({
      url: "https://solublelabs.com/fhir/StructureDefinition/medication-timing-activity-window",
      extension: [
        { url: "relation", valueCode: relation },
        { url: "activity", valueCodeableConcept: { text: "meal" } },
        { url: "offset", valueQuantity: {
          value: minutes, unit: "minutes",
          system: "http://unitsofmeasure.org", code: "min"
        } }
      ]
    });
    const original: FhirR6DosageDetails = {
      renderedInstruction: "Two distinct event windows require clinician review",
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 5, unit: "U" } }],
        timing: { repeat: {
          extension: [activity("before", 15), activity("after", 0)]
        } }
      }] }]
    };
    const flattened = toFhirR5Dosages(original);
    expect(flattened[0].timing?.repeat?.offset).toBeUndefined();
    const imported = toDosageDetails(flattened);
    expect(imported.step[0].component[0].timing?.repeat?.extension)
      .toEqual(original.step[0].component[0].timing?.repeat?.extension);
    expect(imported.step[0].component[0].timing?.repeat?.offset).toBeUndefined();
    // The existing activity-window extension preserves each local offset.
    // It has NO OR/choice semantics: callers must not infer a two-branch
    // executable regimen from this alone without upstream typed composition.
    const again = toDosageDetails(toFhirR5Dosages(imported));
    expect(again.step[0].component[0].timing?.repeat?.extension)
      .toEqual(original.step[0].component[0].timing?.repeat?.extension);
  });
});


describe("clinician editing R6 BodyStructure reference through an R5 dosage", () => {
  const original: FhirR6DosageDetails = {
    step: [{ component: [{
      site: {
        concept: { text: "right eye" },
        reference: { reference: "BodyStructure/OD" }
      },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }]
    }] }]
  };

  it("retains the BodyStructure reference when the strict R5 client did not edit it", () => {
    const dosages = toFhirR5Dosages(original);
    const restored = toDosageDetails(dosages);
    expect(restored.step[0].component[0].site?.reference?.reference)
      .toBe("BodyStructure/OD");
    expect(restored.step[0].component[0].site?.concept?.text)
      .toBe("right eye");
  });

  it("allows an explicit R6-native reference removal without resurrecting old data", () => {
    const dosages = toFhirR5Dosages(original);
    const edited = { ...dosages[0], siteReference: undefined } as EzDosage;
    const restored = toDosageDetails([edited]);
    expect(restored.step[0].component[0].site?.concept?.text).toBe("right eye");
    expect(restored.step[0].component[0].site?.reference).toBeUndefined();
    expect(restored.extension?.some(extension =>
      extension.url.endsWith("medication-course-reconciliation-source"))).toBe(true);
    const reopened = toDosageDetails(toFhirR5Dosages(restored));
    expect(reopened.step[0].component[0].site?.concept?.text).toBe("right eye");
    expect(reopened.step[0].component[0].site?.reference).toBeUndefined();
  });

  it("accepts a new explicit BodyStructure reference while keeping its site concept", () => {
    const dosages = toFhirR5Dosages(original);
    const edited = {
      ...dosages[0], siteReference: { reference: "BodyStructure/right-eye-corrected" }
    } as EzDosage;
    const restored = toDosageDetails([edited]);
    expect(restored.step[0].component[0].site?.concept?.text).toBe("right eye");
    expect(restored.step[0].component[0].site?.reference?.reference)
      .toBe("BodyStructure/right-eye-corrected");
    const reopened = toDosageDetails(toFhirR5Dosages(restored));
    expect(reopened.step[0].component[0].site?.reference?.reference)
      .toBe("BodyStructure/right-eye-corrected");
  });
});

describe("explicit R6 conditional edit precedence over retained R5 bridges", () => {
  const original: FhirR6DosageDetails = {
    renderedInstruction: "Take one tablet BID only when BP is high",
    step: [{
      component: [{
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }],
        condition: [{
          code: { text: "systolic BP" }, operation: "gt",
          valueQuantity: { value: 160 }, text: "Only if systolic BP > 160"
        }]
      }]
    }]
  };

  it("retains a coded condition across unrelated R5 timing edits", () => {
    const flattened = toFhirR5Dosages(original);
    flattened[0].timing!.repeat!.frequency = 3;
    const restored = toDosageDetails(flattened);
    expect(restored.step[0].component[0].condition).toHaveLength(1);
    expect(getDosageCondition(toFhirR5Dosages(restored)[0])).toMatchObject({
      kind: "measurement", name: "systolic BP", operation: "gt", value: 160
    });
  });

  it("treats an explicit empty R6 condition list as a clinician clearing an old condition", () => {
    const flattened = toFhirR5Dosages(original);
    const edited = { ...flattened[0], condition: [] } as EzDosage;
    expect(getDosageCondition(edited)).toBeUndefined();
    const throughFlatAdapter = toEzDosages([edited])[0];
    expect(throughFlatAdapter.condition).toEqual([]);
    expect(getDosageCondition(throughFlatAdapter)).toBeUndefined();
    expect(toDosageDetails([throughFlatAdapter]).step[0].component[0].condition)
      .toBeUndefined();
    const restored = toDosageDetails([edited]);
    expect(restored.step[0].component[0].condition).toBeUndefined();
    expect(restored.step[0].component[0].modifierExtension?.some(ext =>
      ext.url.endsWith("medication-conditional-dose"))).not.toBe(true);
    expect(restored.extension?.some(ext =>
      ext.url.endsWith("medication-course-reconciliation-source"))).toBe(true);
    const reloaded = toDosageDetails(toFhirR5Dosages(restored));
    expect(reloaded.step[0].component[0].condition).toBeUndefined();
    expect(getDosageCondition(toFhirR5Dosages(reloaded)[0])).toBeUndefined();
  });

  it("uses explicit condition replacement instead of the original stale bridge", () => {
    const flattened = toFhirR5Dosages(original);
    const edited = { ...flattened[0], condition: [{
      code: { text: "Glucose tolerance" }, text: "Only if tolerated"
    }] } as EzDosage;
    const restored = toDosageDetails([edited]);
    expect(restored.step[0].component[0].condition).toEqual(edited.condition);
    const reloaded = toDosageDetails(toFhirR5Dosages(restored));
    expect(reloaded.step[0].component[0].condition).toEqual(edited.condition);
  });
});


describe("Boolean guard follow-up clause boundaries", () => {
  it.each([
    ["Take 1 tablet twice daily only if systolic BP > 160 AND heart rate at least 60; otherwise hold and contact clinic.", "all", "systolic bp", "heart rate"],
    ["Take 1 tablet twice daily only if systolic BP > 160 OR heart rate at least 60; otherwise hold and contact clinic.", "any", "systolic bp", "heart rate"],
    ["รับประทาน 1 เม็ด วันละ 2 ครั้ง เฉพาะเมื่อความดันมากกว่า 160 และชีพจรอย่างน้อย 60 มิฉะนั้นงดยาและติดต่อคลินิก", "all", "ความดัน", "ชีพจร"],
    ["รับประทาน 1 เม็ด วันละ 2 ครั้ง เฉพาะเมื่อความดันมากกว่า 160 หรือชีพจรอย่างน้อย 60 ไม่เช่นนั้นหยุดยาแล้วติดต่อคลินิก", "any", "ความดัน", "ชีพจร"]
  ] as const)("preserves a %s condition despite coordinated advice after hold", (input, kind, pressure, pulse) => {
    const guard = parseMedicationGuard(input);
    expect(guard?.condition).toMatchObject({
      kind, conditions: [
        { kind: "measurement", name: pressure, operation: "gt", value: 160 },
        { kind: "measurement", name: pulse, operation: "ge", value: 60 }
      ]
    });
    expect(guard?.otherwiseHold).toBe(true);
    expect(guard?.otherwise).toBeDefined();
    const tail = input.slice(guard!.otherwise!.end);
    expect(tail).toMatch(/contact|ติดต่อ/u);
    expect(guard!.text).not.toMatch(/contact|ติดต่อ|otherwise|มิฉะนั้น|ไม่เช่นนั้น/u);
    const parsed = parseSig(input);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);
    expect(parsed.fhir[0].timing?.repeat?.frequency).toBe(2);
    expect(parsed.fhir[0].asNeeded).not.toBe(true);
    expect(getDosageCondition(parsed.fhir[0])).toEqual(guard!.condition);
    const wire = toFhirR5Dosages(parsed.fhirNext);
    expect(getDosageCondition(wire[0])).toEqual(guard!.condition);
    expect(getDosageCondition(toFhirR5Dosages(toDosageDetails(wire))[0]))
      .toEqual(guard!.condition);
    expect(parsed.input).toBe(input);
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(evaluateMedicationCondition(guard!.condition, { [pressure]: 170, [pulse]: 65 })).toBe(true);
    expect(evaluateMedicationCondition(guard!.condition, { [pressure]: 150, [pulse]: 65 })).toBe(kind === "any");
    expect(evaluateMedicationCondition(guard!.condition, { [pressure]: 170, [pulse]: 55 })).toBe(kind === "any");
    expect(evaluateMedicationCondition(guard!.condition, { [pressure]: 150, [pulse]: 55 })).toBe(false);
  });

  it.each([
    "Only if SBP > 160, take 1 tab BID, otherwise hold then call clinic",
    "Take 1 tab BID only if SBP > 160, otherwise skip and recheck tomorrow",
    "Take 1 tab BID only if SBP > 160; otherwise do not take; contact clinic"
  ])("keeps the positive administration separate from no-dose and follow-up clauses: %s", input => {
    const guard = parseMedicationGuard(input);
    expect(guard?.condition).toMatchObject({ kind: "measurement", name: "sbp", operation: "gt", value: 160 });
    expect(guard?.otherwiseHold).toBe(true);
    expect(guard?.text).not.toMatch(/call|recheck|contact/u);
    const parsed = parseSig(input);
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);
    expect(parsed.fhir[0].timing?.repeat?.frequency).toBe(2);
    expect(parsed.fhir[0].asNeeded).not.toBe(true);
    expect(getDosageCondition(parsed.fhir[0])).toMatchObject({ kind: "measurement", name: "sbp", value: 160 });
  });

  it("does not claim an alternative positive dose as an otherwise-hold instruction", () => {
    const source = "Take 1 tablet BID only if SBP > 160, otherwise take 2 tablets";
    expect(parseMedicationGuard(source)?.otherwiseHold).not.toBe(true);
    expect(parseMedicationGuard("Take 1 tablet as needed for pain")).toBeUndefined();
    const prn = parseSig("Take 1 tablet as needed for pain");
    expect(prn.fhir[0].asNeeded).toBe(true);
    expect(getDosageCondition(prn.fhir[0])).toBeUndefined();
  });
});


describe("typed alternative-choice FHIR membership", () => {
  function alternativeCourse(language: "en" | "th" = "en"): FhirR6DosageDetails {
    const result: FhirR6DosageDetails = {
      renderedInstruction: language === "en"
        ? "Either inhale 2 puffs OR nebulize 2.5 mg, not both"
        : "สูดยา 2 ครั้ง หรือพ่นละอองยา 2.5 มก. เลือกอย่างใดอย่างหนึ่ง",
      step: [{ component: [
        { id: "inhaler", method: { text: "Inhale" },
          doseAndRate: [{ doseQuantity: { value: 2, unit: "puff" } }] },
        { id: "nebulizer", method: { text: "Nebulize" },
          doseAndRate: [{ doseQuantity: { value: 2.5, unit: "mg" } }] }
      ] }]
    };
    result.step[0].component.forEach((component, index) => {
      setDosageAlternativeChoice(component, {
        groupId: "choice-0", branchId: String(index), selectionBehavior: "exactly-one"
      });
    });
    return result;
  }

  it.each(["en", "th"] as const)("preserves explicit %s choice meaning without abusing concurrent components or conditions", language => {
    const original = alternativeCourse(language);
    let rows = toFhirR5Dosages(original);
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(rows).toHaveLength(2);
      expect(rows.map(row => row.sequence)).toEqual([1, 1]);
      expect(rows.map(getDosageAlternativeChoice)).toEqual([
        { groupId: "choice-0", branchId: "0", selectionBehavior: "exactly-one" },
        { groupId: "choice-0", branchId: "1", selectionBehavior: "exactly-one" }
      ]);
      expect(rows[0].doseAndRate?.[0].doseQuantity).toEqual({ value: 2, unit: "puff" });
      expect(rows[1].doseAndRate?.[0].doseQuantity).toEqual({ value: 2.5, unit: "mg" });
      for (const row of rows) {
        expect(row.asNeeded).not.toBe(true);
        expect(getDosageCondition(row)).toBeUndefined();
        expect(row.modifierExtension?.filter(extension =>
          extension.url === DOSAGE_ALTERNATIVE_CHOICE_URL)).toHaveLength(1);
        expect(row.extension?.some(extension =>
          extension.url === DOSAGE_ALTERNATIVE_CHOICE_URL)).not.toBe(true);
      }
      const restored = toDosageDetails(rows);
      expect(restored.renderedInstruction).toBe(original.renderedInstruction);
      expect(restored.step[0].component.map(getDosageAlternativeChoice))
        .toEqual(original.step[0].component.map(getDosageAlternativeChoice));
      rows = toFhirR5Dosages(restored);
    }
  });

  it("supports three alternatives without assuming a binary pair or changing their quantities", () => {
    const original = alternativeCourse();
    const third: FhirR6DosageDetails["step"][number]["component"][number] = {
      id: "third-option", doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }]
    };
    setDosageAlternativeChoice(third, {
      groupId: "choice-0", branchId: "2", selectionBehavior: "exactly-one"
    });
    original.step[0].component.push(third);
    const restored = toDosageDetails(toFhirR5Dosages(original));
    expect(restored.step[0].component.map(component =>
      getDosageAlternativeChoice(component)?.branchId)).toEqual(["0", "1", "2"]);
    expect(restored.step[0].component[2].doseAndRate?.[0].doseQuantity?.value).toBe(1);
  });

  it("preserves original branch identities when dosage rows are edited and reordered", () => {
    const rows = toFhirR5Dosages(alternativeCourse());
    rows.reverse();
    rows[0].doseAndRate![0].doseQuantity!.value = 3;
    const restored = toDosageDetails(rows);
    expect(restored.step[0].component.map(getDosageAlternativeChoice)).toEqual([
      { groupId: "choice-0", branchId: "1", selectionBehavior: "exactly-one" },
      { groupId: "choice-0", branchId: "0", selectionBehavior: "exactly-one" }
    ]);
    expect(restored.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(3);
  });

  it("keeps R6-only anatomical references with their alternative branches when both doses are edited and reordered", () => {
    const original: FhirR6DosageDetails = {
      step: [{ component: [
        { site: { reference: { reference: "BodyStructure/left-arm" } },
          doseAndRate: [{ doseQuantity: { value: 5, unit: "U" } }] },
        { site: { reference: { reference: "BodyStructure/right-arm" } },
          doseAndRate: [{ doseQuantity: { value: 8, unit: "U" } }] }
      ] }]
    };
    original.step[0].component.forEach((component, index) => {
      setDosageAlternativeChoice(component, {
        groupId: "choice-0", branchId: String(index), selectionBehavior: "exactly-one"
      });
    });
    const rows = toFhirR5Dosages(original).reverse();
    rows[0].doseAndRate![0].doseQuantity!.value = 10;
    rows[1].doseAndRate![0].doseQuantity!.value = 6;
    const restored = toDosageDetails(rows);
    const components = restored.step[0].component;
    expect(components.map(component => getDosageAlternativeChoice(component)?.branchId))
      .toEqual(["1", "0"]);
    expect(components.map(component => component.site?.reference?.reference))
      .toEqual(["BodyStructure/right-arm", "BodyStructure/left-arm"]);
    expect(components.map(component => component.doseAndRate?.[0].doseQuantity?.value))
      .toEqual([10, 6]);
    const reopened = toDosageDetails(toFhirR5Dosages(restored));
    expect(reopened.step[0].component.map(component => component.site?.reference?.reference))
      .toEqual(["BodyStructure/right-arm", "BodyStructure/left-arm"]);
  });

  it("does not mistake plain concurrent doses or the word OR alone for typed membership", () => {
    const input: FhirR6DosageDetails = {
      renderedInstruction: "Original source may contain OR without a recognized choice construction",
      step: [{ component: [
        { doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }] },
        { doseAndRate: [{ doseQuantity: { value: 2, unit: "drop" } }] }
      ] }]
    };
    const rows = toFhirR5Dosages(input);
    expect(rows.map(getDosageAlternativeChoice)).toEqual([undefined, undefined]);
    expect(toDosageDetails(rows).step[0].component.map(getDosageAlternativeChoice))
      .toEqual([undefined, undefined]);
  });

  it("lets a clinician select one branch without resurrecting the discarded option from source metadata", () => {
    const original = alternativeCourse();
    original.step[0].start = { offsetDuration: { value: 0, unit: "d" } };
    const rows = toFhirR5Dosages(original);
    const selected = rows[0];
    setDosageAlternativeChoice(selected, undefined);
    const updated = toDosageDetails([selected]);
    expect(updated.step[0].component).toHaveLength(1);
    expect(getDosageAlternativeChoice(updated.step[0].component[0])).toBeUndefined();
    expect(updated.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual({ value: 2, unit: "puff" });
    const reopened = toDosageDetails(toFhirR5Dosages(updated));
    expect(reopened.step[0].component).toHaveLength(1);
    expect(getDosageAlternativeChoice(reopened.step[0].component[0])).toBeUndefined();
    expect(updated.extension?.some(extension =>
      extension.url.endsWith("medication-course-reconciliation-source"))).toBe(true);
  });

  it("does not erase unrelated modifier data when membership is replaced or cleared", () => {
    const other = { url: "https://example.test/other-modifier", valueString: "retain me" };
    const dosage = { modifierExtension: [other] };
    setDosageAlternativeChoice(dosage, { groupId: "a", branchId: "b", selectionBehavior: "exactly-one" });
    setDosageAlternativeChoice(dosage, { groupId: "a", branchId: "c", selectionBehavior: "exactly-one" });
    expect(dosage.modifierExtension).toHaveLength(2);
    expect(getDosageAlternativeChoice(dosage)?.branchId).toBe("c");
    setDosageAlternativeChoice(dosage, undefined);
    expect(dosage.modifierExtension).toEqual([other]);
  });

  it("declares exactly-one semantics as a modifier with required typed membership fields", () => {
    const profile = buildDosageAlternativeChoiceStructureDefinition();
    expect(profile.resourceType).toBe("StructureDefinition");
    expect(profile.url).toBe(DOSAGE_ALTERNATIVE_CHOICE_URL);
    const elements = profile.differential.element;
    expect(elements).toContainEqual(expect.objectContaining({
      id: "Extension", isModifier: true, isModifierReason: expect.any(String)
    }));
    for (const name of ["groupId", "branchId", "selectionBehavior"]) {
      expect(elements).toContainEqual(expect.objectContaining({
        id: "Extension.extension:" + name, min: 1, max: "1"
      }));
    }
    expect(elements).toContainEqual(expect.objectContaining({
      id: "Extension.extension:selectionBehavior.value[x]", fixedCode: "exactly-one"
    }));
    expect(elements).toContainEqual(expect.objectContaining({ id: "Extension.value[x]", max: "0" }));
  });
});


describe("choice execution over reloaded branch groups", () => {
  const clock = {
    from: "2026-10-24T00:00:00+07:00", orderedAt: "2026-10-24T00:00:00+07:00",
    timeZone: "Asia/Bangkok", limit: 4
  };
  const component = (value: number, time: string, groupId: string, branchId: string) => {
    const dosage: FhirR6DosageDetails["step"][number]["component"][number] = {
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: "d", timeOfDay: [time] } }
    };
    setDosageAlternativeChoice(dosage, { groupId, branchId, selectionBehavior: "exactly-one" });
    return dosage;
  };

  it("executes every component of one selected branch, not one component nor every alternative", () => {
    const course: FhirR6DosageDetails = {
      step: [{ component: [
        component(1, "08:00:00", "schedule-choice", "split-dose"),
        component(2, "20:00:00", "schedule-choice", "split-dose"),
        component(4, "12:00:00", "schedule-choice", "single-dose")
      ] }]
    };
    const before = cloneStructuredValue(course);
    const rows = toFhirR5Dosages(course);
    const reloaded = toDosageDetails(rows);
    const opts = { ...clock, alternativeChoices: { "schedule-choice": "split-dose" } };
    const expected = [
      "2026-10-24T08:00:00+07:00", "2026-10-24T20:00:00+07:00",
      "2026-10-25T08:00:00+07:00", "2026-10-25T20:00:00+07:00"
    ];
    for (const input of [course, rows, reloaded]) {
      expect(nextDueDoses(input, opts)).toEqual(expected);
      expect(calculateTotalUnits({ ...opts, dosage: input, durationValue: 3, durationUnit: "d" }).totalUnits)
        .toBe(9);
    }
    const single = { ...clock, alternativeChoices: { "schedule-choice": "single-dose" } };
    expect(calculateTotalUnits({ ...single, dosage: reloaded, durationValue: 3, durationUnit: "d" }).totalUnits)
      .toBe(12);
    expect(course).toEqual(before);
    expect(rows.map(getDosageAlternativeChoice).every(choice => choice !== undefined)).toBe(true);
  });

  it("resolves independent choice groups separately without leaking a selection across groups", () => {
    const course: FhirR6DosageDetails = {
      step: [{ component: [
        component(1, "08:00:00", "first", "small"),
        component(2, "12:00:00", "first", "large"),
        component(3, "16:00:00", "second", "small"),
        component(4, "20:00:00", "second", "large")
      ] }]
    };
    const opts = { ...clock, alternativeChoices: { first: "small", second: "large" } };
    const rows = toFhirR5Dosages(course).reverse();
    for (const input of [course, rows, toDosageDetails(rows)]) {
      expect(nextDueDoses(input, opts)).toEqual([
        "2026-10-24T08:00:00+07:00", "2026-10-24T20:00:00+07:00",
        "2026-10-25T08:00:00+07:00", "2026-10-25T20:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ ...opts, dosage: input, durationValue: 3, durationUnit: "d" }).totalUnits)
        .toBe(15);
    }
    expect(() => nextDueDoses(course, { ...clock, alternativeChoices: { first: "small" } }))
      .toThrow(/second/u);
    expect(course.step[0].component).toHaveLength(4);
  });
});


describe("dimensioned infusion carrier noun phrase composition", () => {
  it.each([
    ["Infuse 20 mg drug in 500 mL over four hours IV", 20, 500, 4, undefined],
    ["Infuse 20 mg drug in 500 mL normal saline over four hours IV", 20, 500, 4, "normal saline"],
    ["Infuse 20 mg medication in 500 mL carrier solution over 4 hours IV", 20, 500, 4, "carrier solution"],
    ["Infuse 20 mg in 500 mL diluent over 4 hours IV", 20, 500, 4, "diluent"],
    ["Infuse 20 mg drug in 500 mL normal saline IV over 4 hours", 20, 500, 4, "normal saline"],
    ["Infuse 5 mg drug in 100 mL infusion fluid over 2 hours IV", 5, 100, 2, "infusion fluid"],
    ["Infuse 20 mg drug in 500 mL normal saline for four hours IV", 20, 500, 4, "normal saline"],
    ["Infuse 5 mg drug in 100 mL diluent for 2 hours IV", 5, 100, 2, "diluent"]
  ] as const)("unifies active dose, carrier volume and infusion duration in %s", (input, mass, volume, hours, material) => {
    const result = parseSig(input);
    const clause = result.meta.canonical.clauses[0];
    expect(result.items).toHaveLength(1);
    expect(clause.clinicalQuantity?.carrierMaterial?.text).toBe(material);
    if (material) {
      const range = clause.clinicalQuantity?.carrierMaterial?.range;
      expect(range).toBeDefined();
      expect(input.slice(range!.start, range!.end)).toBe(material);
    }
    expect(clause.clinicalQuantity).toMatchObject({
      representation: "dose-with-rate-ratio",
      status: "resolved",
      projectedDose: { value: mass, unit: "mg" },
      rateNumerator: { value: volume, unit: "mL" },
      administrationDuration: { value: hours, unit: "h" }
    });
    expect(result.items[0].fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: mass, unit: "mg" },
      rateRatio: {
        numerator: { value: volume, unit: "mL" },
        denominator: { value: hours, unit: "h" }
      }
    });
    expect(result.items[0].fhir.timing?.repeat?.duration).toBe(hours);
    expect(result.items[0].fhir.timing?.repeat?.durationUnit).toBe("h");
    expect(result.items[0].fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(result.items[0].fhir.route?.text).toBe("intravenous");
    expect(result.items[0].fhir.text).toBe(input);
    expect(result.meta.leftoverText).toBeUndefined();
    const strictR5 = toFhirR5Dosages(result.fhirNext);
    const carrierExt = strictR5[0].extension?.find(extension =>
      extension.url.endsWith("medication-infusion-carrier-material"));
    if (material) {
      expect(carrierExt?.extension).toContainEqual({
        url: "material", valueString: material
      });
      const canonicalReload = canonicalFromFhir(strictR5[0]);
      expect(canonicalReload.clinicalQuantity?.carrierMaterial?.text).toBe(material);
      expect(canonicalReload.clinicalQuantity?.rateNumerator).toEqual({
        value: volume, unit: "mL"
      });
      expect(parserStateFromFhir(strictR5[0]).primaryClause
        .clinicalQuantity?.carrierMaterial?.text).toBe(material);
      const roundtrip = toDosageDetails(strictR5);
      expect(roundtrip.step[0].component[0].extension).toContainEqual(carrierExt);
    } else {
      expect(carrierExt).toBeUndefined();
    }
    const reloaded = toDosageDetails(strictR5);
    expect(reloaded.step[0].component[0].doseAndRate?.[0]).toEqual(
      result.fhirNext.step[0].component[0].doseAndRate?.[0]
    );
    expect(reloaded.step[0].component[0].timing?.repeat?.duration).toBe(hours);
  });

  it("keeps canonical carrier spans global but strict R5 dosage extension spans row-local", () => {
    const input = "Give one tablet daily | Infuse 20 mg drug in 500 mL diluent over 4 hours IV";
    const result = parseSig(input);
    expect(result.items).toHaveLength(2);
    const carrier = result.meta.canonical.clauses[1]?.clinicalQuantity?.carrierMaterial;
    const globalStart = input.indexOf("diluent");
    expect(carrier?.text).toBe("diluent");
    expect(carrier?.range).toEqual({
      start: globalStart, end: globalStart + "diluent".length
    });
    const row = result.items[1].fhir;
    const localStart = (row.text ?? "").indexOf("diluent");
    const extension = row.extension?.find(ext =>
      ext.url.endsWith("medication-infusion-carrier-material"));
    expect(localStart).toBeGreaterThan(0);
    expect(extension?.extension).toEqual(expect.arrayContaining([
      { url: "material", valueString: "diluent" },
      { url: "start", valueInteger: localStart },
      { url: "end", valueInteger: localStart + "diluent".length }
    ]));
    expect(canonicalFromFhir(toFhirR5Dosages(result.fhirNext)[1])
      .clinicalQuantity?.carrierMaterial?.text).toBe("diluent");
  });

  it("uses an explicit infusion FOR duration as administration time, never regimen bounds", () => {
    const source = "Infuse 50 mL for 30 minutes IV";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 50, unit: "mL" },
      rateRatio: {
        numerator: { value: 50, unit: "mL" },
        denominator: { value: 30, unit: "min" }
      }
    });
    expect(parsed.items[0].fhir.timing?.repeat).toMatchObject({
      duration: 30, durationUnit: "min"
    });
    expect(parsed.items[0].fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.items[0].fhir.timing?.repeat?.frequency).toBeUndefined();
  });

  it("does not reinterpret a noninfusion medication amount and fluid as an IV carrier rate", () => {
    const result = parseSig("Take 20 mg drug in 500 mL water over four hours");
    expect(result.items[0].fhir.doseAndRate?.[0]?.rateRatio).toBeUndefined();
    expect(result.items[0].fhir.route?.text).not.toBe("intravenous");
  });

  it("publishes a draft extension definition matching the uncoded vehicle child contract", () => {
    const profile = buildInfusionCarrierMaterialStructureDefinition();
    expect(profile).toMatchObject({
      resourceType: "StructureDefinition",
      type: "Extension",
      context: [{ type: "element", expression: "Dosage" }]
    });
    expect(profile.differential.element).toContainEqual(
      expect.objectContaining({ id: "Extension", isModifier: false })
    );
    expect(profile.differential.element).toContainEqual(expect.objectContaining({
      id: "Extension.extension:material", min: 1
    }));
    expect(profile.differential.element).toContainEqual(expect.objectContaining({
      id: "Extension.extension:start", min: 0
    }));
    expect(profile.differential.element).toContainEqual(expect.objectContaining({
      id: "Extension.extension:end", min: 0
    }));
    expect(profile.differential.element).toContainEqual(expect.objectContaining({
      id: "Extension.url", fixedUri: profile.url
    }));
  });

  it("keeps unknown or inconsistent carrier values editable instead of inventing a rate", () => {
    const base = parseSig("Infuse 20 mg drug in 500 mL normal saline over 4 hours IV");
    const dosage = base.items[0].fhir;
    const withoutRate = { ...dosage, doseAndRate: [{
      doseQuantity: { value: 2, unit: "mg" }
    }] };
    expect(canonicalFromFhir(withoutRate).clinicalQuantity).toBeUndefined();
    expect(withoutRate.extension?.some(extension =>
      extension.url.endsWith("medication-infusion-carrier-material"))).toBe(true);
    expect(withoutRate.text).toBe(base.input);
  });

  it("retains an independent pause directive without assigning its threshold to infusion rate", () => {
    const input =
      "Infuse 20 mg drug in 500 mL normal saline over four hours IV; pause only if SBP falls below 90";
    const parsed = parseSig(input);
    expect(parsed.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(20);
    expect(parsed.items[0].fhir.doseAndRate?.[0]?.rateRatio?.numerator?.value).toBe(500);
    expect(parsed.items[0].fhir.doseAndRate?.[0]?.rateRatio?.denominator?.value).toBe(4);
    expect(parsed.items[0].fhir.timing?.repeat?.duration).toBe(4);
    expect(parsed.items[0].fhir.timing?.repeat?.frequency).toBeUndefined();
    expect(parsed.items[0].fhir.text).toBe(input);
    expect(parsed.items[0].fhir.additionalInstruction?.some(value =>
      /pause|hold/iu.test(value.text ?? ""))).toBe(true);
  });
});


describe("hydration advice is entailed, not guessed from the word water", () => {
  const hydrationCode = "419303009";
  const hasPlentyCode = (source: string): boolean => parseSig(source).fhir.some(dosage =>
    dosage.additionalInstruction?.some(instruction =>
      instruction.coding?.some(coding => coding.system === "http://snomed.info/sct" &&
        coding.code === hydrationCode)
    )
  );
  it.each([
    "Do not drink water for 30 minutes",
    "Drink water, then take one tablet",
    "Take 1 tablet with water",
    "Do not take 1 tablet with plenty of water"
  ])("does not assert affirmative plentiful-water instructions without entailment: %s", source => {
    expect(hasPlentyCode(source)).toBe(false);
  });
  it.each([
    "Drink plenty of water",
    "Drink lots of water",
    "Take 1 tablet with plenty of water",
    "ดื่มน้ำตามมากๆ"
  ])("retains positively specified plentiful-water counseling in the typed FHIR advice: %s", source => {
    expect(hasPlentyCode(source)).toBe(true);
    const parsed = parseSig(source);
    const strictR5 = toFhirR5Dosages(toDosageDetails(parsed.fhir));
    expect(strictR5.some(dosage => dosage.additionalInstruction?.some(item =>
      item.coding?.some(coding => coding.code === hydrationCode)
    ))).toBe(true);
    if (!/tablet/u.test(source)) {
      expect(parsed.fhir.every(dosage => dosage.doseAndRate?.[0]?.doseQuantity?.value === undefined)).toBe(true);
    }
  });
  it.each([
    "Drink plenty of water",
    "ดื่มน้ำตามมากๆ",
    "ดื่มน้ำตามมาก ๆ",
    "ดื่มน้ำเยอะๆ"
  ])("keeps hydration-only counseling outside medication dose/method/route: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.every(dosage =>
      dosage.doseAndRate?.[0]?.doseQuantity?.value === undefined &&
      dosage.method === undefined && dosage.route === undefined &&
      !(dosage.timing?.repeat?.when ?? []).includes("IMD")
    )).toBe(true);
    const actions = parsed.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []
    );
    expect(actions.some(action =>
      action.predicate.lemma === "drink" &&
      action.polarity !== "negate" &&
      action.args.some(arg => arg.role === "substance" &&
        arg.conceptId === "plenty-of-water")
    )).toBe(true);
    const strictR5 = toFhirR5Dosages(toDosageDetails(parsed.fhir));
    expect(strictR5[0]?.additionalInstruction?.some(item =>
      item.coding?.some(coding => coding.code === hydrationCode)
    )).toBe(true);
    const en = formatSig(parsed.fhir, "long", { locale: "en" }).toLowerCase();
    const th = formatSig(parsed.fhir, "long", { locale: "th" });
    expect(en).toMatch(/drink.*water/u);
    expect(en).not.toMatch(/drink the medication|take the medication orally/u);
    expect(th).toContain("น้ำ");
  });
  it("keeps true oral medicine administration separate from accompanying plentiful water", () => {
    const parsed = parseSig("Take 1 tablet with plenty of water twice daily");
    expect(parsed.fhir[0]?.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir[0]?.timing?.repeat?.frequency).toBe(2);
    expect(parsed.fhir[0]?.additionalInstruction?.some(item =>
      item.coding?.some(coding => coding.code === hydrationCode)
    )).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it("keeps the negative drinking action negative when hydration advice is prohibited", () => {
    const parsed = parseSig("Do not drink water for 30 minutes");
    expect(parsed.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: expect.objectContaining({ lemma: "drink" }), polarity: "negate" })
    ]));
    expect(parsed.fhir[0]?.text?.toLowerCase()).toContain("do not drink");
  });
});


describe("complete bilingual medication counseling composes once", () => {
  it("retains one executable dose and independent typed counseling through R5/R6", () => {
    const source = "Take 1 tablet orally twice daily after breakfast and dinner. " +
      "กินหลังอาหารทันที ดื่มน้ำตามมากๆ ไม่ควรนอนราบทันทีหลังกินยา กินต่อเนื่องจนหมด";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1, unit: "tab"
    });
    expect(parsed.fhir[0].timing?.repeat).toMatchObject({
      frequency: 2, period: 1, periodUnit: "d",
      when: ["PCM", "PCV"], offset: 0
    });
    expect(parsed.meta.leftoverText).toBeUndefined();
    const actions = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? []);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: expect.objectContaining({ lemma: "drink" }) }),
      expect.objectContaining({ predicate: expect.objectContaining({ lemma: "lie-down" }),
        polarity: "negate", relation: "after", modality: "should" }),
      expect.objectContaining({ predicate: expect.objectContaining({ lemma: "continue-treatment" }),
        relation: "until" })
    ]));
    const strict = toFhirR5Dosages(toDosageDetails(parsed.fhir));
    expect(strict).toHaveLength(1);
    expect(strict[0]?.timing?.repeat).toMatchObject({ when: ["PCM", "PCV"], offset: 0 });
    const en = formatSig(parsed.fhir, "long", {locale: "en"});
    const th = formatSig(parsed.fhir, "long", {locale: "th"});
    expect(en).toContain("immediately after breakfast");
    expect(en.toLowerCase()).toContain("drink plenty of water");
    expect(th).toContain("หลังอาหารเช้าทันที");
    expect(th).toContain("ดื่มน้ำตามมากๆ");
  });
});

describe("clinical counseling remains procedural and event-scoped across languages", () => {
  it.each([
    "Should not lie down immediately after taking medication",
    "ไม่ควรนอนราบทันทีหลังกินยา"
  ])("keeps post-medication positional advice negative and out of stat dosing: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.every(dosage => !(dosage.timing?.repeat?.when ?? []).includes("IMD"))).toBe(true);
    expect(parsed.fhir.every(dosage => dosage.doseAndRate?.[0]?.doseQuantity?.value === undefined)).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const lie = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
      .find(a => a.predicate.lemma === "lie-down");
    expect(lie).toMatchObject({ polarity: "negate", modality: "should", relation: "after" });
    expect(lie?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "time", conceptId: "immediacy" }),
      expect.objectContaining({ role: "activity", conceptId: "medication-administration" })
    ]));
    expect(parsed.input).toBe(source);
  });
  it.each([
    "continue taking medication until finished",
    "กินต่อเนื่องจนหมด",
    "รับประทานยาต่อเนื่องจนหมด"
  ])("retains treatment continuation until supply is used without fabricating a duration: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.every(dosage =>
      dosage.timing?.repeat?.count === undefined &&
      dosage.timing?.repeat?.duration === undefined &&
      dosage.doseAndRate?.[0]?.doseQuantity?.value === undefined
    )).toBe(true);
    const continueAction = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
      .find(a => a.predicate.lemma === "continue-treatment");
    expect(continueAction?.relation).toBe("until");
    expect(continueAction?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "result", conceptId: "supply-exhausted" })
    ]));
    expect(continueAction?.predicate.codings).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: "http://snomed.info/sct", code: "306806004" })
    ]));
  });
});


describe("Parkinsonian staged clock-cadence compatibility", () => {
  it.each([
    "Take 1 tablet at 07:00, 11:00, 15:00 and 19:00 for 7 days, then three times daily for 7 days.",
    "รับประทาน 1 เม็ดเวลา 07:00 11:00 15:00 19:00 เป็นเวลา 7 วัน แล้วลดเหลือวันละสามครั้งอีก 7 วัน"
  ])("does not transfer four explicit predecessor clocks to a new three-dose phase: %s", input => {
    const result = parseSig(input);
    expect(result.fhir).toHaveLength(2);
    expect(result.fhir[0].timing?.repeat?.timeOfDay).toHaveLength(4);
    expect(result.fhir[1].timing?.repeat?.frequency).toBe(3);
    expect(result.fhir[1].timing?.repeat?.timeOfDay).toBeUndefined();
    const strict = toFhirR5Dosages(result.fhirNext);
    expect(strict).toHaveLength(2);
    expect(strict[1].timing?.repeat?.frequency).toBe(3);
    expect(strict[1].timing?.repeat?.timeOfDay).toBeUndefined();
    expect(result.fhirNext.step[1].component[0].timing?.repeat?.timeOfDay).toBeUndefined();
    expect(result.fhirNext.renderedInstruction).toBe(input);
  });

  it("keeps inherited clocks when the next phase explicitly retains the same cadence", () => {
    const result = parseSig(
      "Take 1 tablet at 07:00, 11:00, 15:00 and 19:00 for 7 days, then four times daily for 7 days."
    );
    expect(result.fhir).toHaveLength(2);
    expect(result.fhir[1].timing?.repeat).toMatchObject({
      frequency: 4,
      timeOfDay: ["07:00:00", "11:00:00", "15:00:00", "19:00:00"]
    });
  });

  it("keeps new explicit clock anchors instead of donor's four clocks", () => {
    const result = parseSig(
      "Take 1 tablet four times daily at 07:00, 11:00, 15:00 and 19:00 for 2 weeks, then take 1 tablet three times daily at 07:00, 13:00 and 19:00."
    );
    expect(result.fhir).toHaveLength(2);
    expect(result.fhir[1].timing?.repeat?.timeOfDay)
      .toEqual(["07:00:00", "13:00:00", "19:00:00"]);
  });
});


describe("typed within-phase duration sharing for Parkinsonian schedules", () => {
  it("bounds both concurrent doses in the final seven-day phase", () => {
    const input = "Take half a tablet in the morning and one tablet at bedtime for 7 days, then one tablet in the morning and one tablet at bedtime for 7 days.";
    const result = parseSig(input);
    expect(result.fhirNext.step).toHaveLength(2);
    expect(result.input).toBe(input);
    // Equal-dose daughters may lower as one component with two event anchors,
    // so expand the typed anchors to assert each actual administration amount.
    expect(result.fhirNext.step.map(step => step.component.flatMap(component =>
      (component.timing?.repeat?.when ?? []).map(when => ({
        when,
        dose: component.doseAndRate?.[0]?.doseQuantity?.value
      }))
    ))).toEqual([
      [{ when: EventTiming.Morning, dose: 0.5 }, { when: EventTiming["Before Sleep"], dose: 1 }],
      [{ when: EventTiming.Morning, dose: 1 }, { when: EventTiming["Before Sleep"], dose: 1 }]
    ]);
    const secondPhase = result.meta.canonical.clauses.find(clause =>
      clause.span.start === input.indexOf("one tablet in the morning", 70) &&
      clause.schedule?.when?.length === 2
    );
    expect(secondPhase?.schedule).toMatchObject({ duration: 7, durationUnit: "d" });
    expect(secondPhase?.evidence).toContainEqual(expect.objectContaining({
      rule: "hpsg.cx.coordination.dosed-head-ellipsis-with-trailing-course-duration",
      spans: [{ start: 103, end: 106, text: "and" }],
      scheduleFields: ["duration", "durationUnit"]
    }));

    const strict = toFhirR5Dosages(result.fhirNext);
    expect(strict.every(d => d.timing?.repeat?.boundsDuration?.value === 7)).toBe(true);
    const eventClock = {
      [EventTiming.Morning]: "08:00",
      [EventTiming["Before Sleep"]]: "22:00"
    };
    for (const dosage of [result.fhirNext, strict]) {
      const orderedAt = "2026-11-02T00:00:00+07:00";
      const common = { orderedAt, timeZone: "Asia/Bangkok", eventClock };
      const dueOn = (date: string) => nextDueDoses(dosage, {
        ...common, from: `${date}T00:00:00+07:00`, limit: 8
      }).filter(timestamp => timestamp.slice(0, 10) === date);
      expect(dueOn("2026-11-02")).toEqual([
        "2026-11-02T08:00:00+07:00", "2026-11-02T22:00:00+07:00"
      ]);
      expect(dueOn("2026-11-09")).toEqual([
        "2026-11-09T08:00:00+07:00", "2026-11-09T22:00:00+07:00"
      ]);
      expect(dueOn("2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({
        dosage, ...common, from: orderedAt, durationValue: 21,
        durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(24.5);
    }
  });

  it.each(["and", "; instill"])(
    "does not overwrite explicit per-eye course lengths across %s tracks",
    connector => {
      const input = "Instill 1 drop in the right eye four times daily for 14 days " +
        `${connector} 1 drop in the left eye twice daily for 7 days.`;
      const result = parseSig(input);
      expect(result.input).toBe(input);
      expect(result.fhir.map(dosage => ({
        site: dosage.site?.text,
        duration: dosage.timing?.repeat?.boundsDuration?.value
      }))).toEqual([
        { site: "right eye", duration: 14 },
        { site: "left eye", duration: 7 }
      ]);
      expect(result.fhirNext.step.flatMap(step => step.component).map(dosage => ({
        site: dosage.site?.concept?.text,
        duration: dosage.timing?.repeat?.boundsDuration?.value
      }))).toEqual([
        { site: "right eye", duration: 14 },
        { site: "left eye", duration: 7 }
      ]);
      expect(toFhirR5Dosages(result.fhirNext).map(dosage =>
        dosage.timing?.repeat?.boundsDuration?.value
      )).toEqual([14, 7]);
    }
  );
});



describe("source-less R6 treatment-relative step display", () => {
  const relativeDay = (value: number) => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] },
    offsetDuration: { value, unit: "d", code: "d" }
  });
  const tablet = (value: number) => ({
    timing: { repeat: { timeOfDay: ["08:00:00"] } },
    doseAndRate: [{ doseQuantity: { value, unit: "tab" } }]
  });

  it("displays both finite phase windows in source-less EN/TH R6 and strict R5", () => {
    const course: FhirR6DosageDetails = {
      step: [
        { end: relativeDay(7), component: [tablet(1)] },
        { start: relativeDay(7), end: relativeDay(14), component: [tablet(2)] }
      ]
    };
    for (const input of [course, toDosageDetails(toFhirR5Dosages(course))]) {
      expect(formatSig(input, "long", { locale: "en" })).toContain("Days 1–7");
      expect(formatSig(input, "long", { locale: "en" })).toContain("Days 8–14");
      expect(formatSig(input, "long", { locale: "th" })).toContain("วันที่ 1–7");
      expect(formatSig(input, "long", { locale: "th" })).toContain("วันที่ 8–14");
    }
    expect(formatSigBatch(toFhirR5Dosages(course), "long", { locale: "en" }))
      .toContain("Days 8–14");
  });

  it("makes a seven-day STOP/RESUME gap explicit rather than joining identical doses", () => {
    const course: FhirR6DosageDetails = {
      step: [
        { end: relativeDay(7), component: [tablet(1)] },
        { start: relativeDay(14), end: relativeDay(21), component: [tablet(1)] }
      ]
    };
    for (const input of [course, toDosageDetails(toFhirR5Dosages(course))]) {
      const en = formatSig(input, "long", { locale: "en" });
      const th = formatSig(input, "long", { locale: "th" });
      expect(en).toContain("No doses on days 8–14");
      expect(en).toContain("Days 15–21");
      expect(th).toContain("งดยาในวันที่ 8–14");
      expect(th).toContain("วันที่ 15–21");
    }
    expect(formatSigBatch(toFhirR5Dosages(course), "long", { locale: "en" }))
      .toContain("No doses on days 8–14");
  });

  it("does not misrepresent an unknown relative-time context as treatment-day timing", () => {
    const course: FhirR6DosageDetails = {
      step: [{
        start: {
          contextDefinition: "dialysis",
          offsetDuration: { value: 2, unit: "d" },
          text: "two days after dialysis"
        },
        component: [tablet(1)]
      }]
    };
    expect(formatSig(course, "long", { locale: "en" }))
      .toContain("two days after dialysis");
    expect(formatSig(course, "long", { locale: "en" }))
      .not.toContain("from day 3");
  });
});

describe("source-less repeating and overlapping treatment windows", () => {
  const boundary = (value: number) => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] },
    offsetDuration: { value, unit: "d", code: "d" }
  });
  const tablet = (value: number) => ({
    doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
    timing: { repeat: { timeOfDay: ["08:00:00"] } }
  });
  const step = (start: number, end: number, amount: number) => ({
    start: boundary(start), end: boundary(end), component: [tablet(amount)]
  });
  const variants = (course: FhirR6DosageDetails) => [
    course, toDosageDetails(toFhirR5Dosages(course)), toFhirR5Dosages(course)
  ];

  it("renders the repeat period and medication-free tail of a recurring course in both locales", () => {
    const course: FhirR6DosageDetails = {
      repeatCycle: { value: 14, unit: "d", code: "d" }, step: [step(0, 7, 1)]
    };
    const before = cloneStructuredValue(course);
    for (const input of variants(course)) {
      const en = formatSig(input, "long", { locale: "en" });
      const th = formatSig(input, "long", { locale: "th" });
      expect(en).toContain("every 14 days");
      expect(en).toContain("within each cycle");
      expect(en).toContain("No doses on days 8–14");
      expect(th).toContain("ทุก 14 วัน");
      expect(th).toContain("ในแต่ละรอบ");
      expect(th).toContain("งดยาในวันที่ 8–14");
      const options = {
        timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00", limit: 4
      };
      expect(nextDueDoses(input, { ...options, from: "2026-11-09T00:00:00+07:00" })[0])
        .toBe("2026-11-16T08:00:00+07:00");
      expect(calculateTotalUnits({
        dosage: input, ...options, from: options.orderedAt,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(14);
    }
    expect(course).toEqual(before);
  });

  it.each([false, true])("does not prescribe a global pause across a continuing parallel component (reordered=%s)", reordered => {
    const stages = [step(0, 21, 1), step(0, 7, 0.5), step(14, 21, 0.5)];
    const course: FhirR6DosageDetails = { step: reordered ? [stages[1], stages[2], stages[0]] : stages };
    for (const input of variants(course)) {
      expect(formatSig(input, "long", { locale: "en" })).not.toContain("No doses");
      expect(formatSig(input, "long", { locale: "th" })).not.toContain("งดยา");
      expect(nextDueDoses(input, {
        timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00",
        from: "2026-11-09T00:00:00+07:00", limit: 1
      })).toEqual(["2026-11-09T08:00:00+07:00"]);
    }
  });

  it("describes only the genuinely uncovered days of a partly overlapped pause", () => {
    const course: FhirR6DosageDetails = { step: [step(0, 10, 1), step(0, 7, 0.5), step(14, 21, 0.5)] };
    for (const input of variants(course)) {
      const text = formatSig(input, "long", { locale: "en" });
      expect(text).toContain("No doses on days 11–14");
      expect(text).not.toContain("No doses on days 8–14");
    }
  });

  it("does not invent a pause when a concurrent component has no finite end", () => {
    const course: FhirR6DosageDetails = {
      step: [{ start: boundary(0), component: [tablet(1)] }, step(0, 7, 0.5), step(14, 21, 0.5)]
    };
    for (const input of variants(course)) {
      expect(formatSig(input, "long", { locale: "en" })).not.toContain("No doses");
    }
  });
  it("keeps every rendered pause faithful to the union across 36 adjacent interval combinations", () => {
    const intervals = [[0, 7], [7, 14], [14, 21], [3, 10], [0, 21], [7, 21]] as const;
    for (const left of intervals) for (const right of intervals) {
      const ranges = [[0, 7], left, right] as const;
      const course: FhirR6DosageDetails = {
        step: [step(0, 7, 1), step(left[0], left[1], 0.5), step(right[0], right[1], 0.25)]
      };
      const end = Math.max(...ranges.map(range => range[1]));
      const uncovered = Array.from({ length: end }, (_, day) => day)
        .filter(day => ranges.every(([start, finish]) => day < start || day >= finish))
        .map(day => day + 1);
      for (const input of variants(course)) {
        const en = formatSig(input, "long", { locale: "en" });
        const stated: number[] = [];
        for (const match of en.matchAll(/No doses on days (\d+)–(\d+)/gu)) {
          for (let day = Number(match[1]); day <= Number(match[2]); day++) stated.push(day);
        }
        expect(stated).toEqual(uncovered);
        expect(calculateTotalUnits({
          dosage: input, timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00",
          from: "2026-11-02T00:00:00+07:00", durationValue: 28, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(7 + (left[1] - left[0]) * 0.5 + (right[1] - right[0]) * 0.25);
      }
    }
  });

  it("preserves week units and leaves nonrepeating courses nonrepeating", () => {
    const course: FhirR6DosageDetails = {
      repeatCycle: { value: 2, unit: "wk", code: "wk" }, step: [step(0, 7, 1)]
    };
    for (const input of variants(course)) {
      expect(formatSig(input, "long", { locale: "en" })).toContain("every 2 weeks");
      expect(formatSig(input, "long", { locale: "th" })).toContain("ทุก 2 สัปดาห์");
    }
    expect(formatSig({ step: course.step }, "long", { locale: "en" }))
      .not.toContain("Repeat this schedule");
  });

  it("does not derive a global pause from a stage exceeding its repeat period", () => {
    const course: FhirR6DosageDetails = {
      repeatCycle: { value: 14, unit: "d", code: "d" }, step: [step(7, 21, 1)]
    };
    for (const input of variants(course)) {
      const en = formatSig(input, "long", { locale: "en" });
      expect(en).toContain("every 14 days");
      expect(en).not.toContain("No doses");
      // This presentation control does not define execution for an overlong
      // cycle. Preserve its declared range and period without inventing a pause.
      expect(en).toContain("Days 8–21");
    }
  });

});

describe("source-less calendar-relative treatment steps", () => {
  const relative = (value: number, code: string) => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] }, offsetDuration: { value, code, unit: code }
  });
  const tablet = (value: number) => ({
    doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
    timing: { repeat: { timeOfDay: ["08:00:00"] } }
  });

  it("retains exact calendar-month boundaries instead of substituting a fixed day count", () => {
    const course: FhirR6DosageDetails = { step: [
      { end: relative(1, "mo"), component: [tablet(1)] },
      { start: relative(1, "mo"), end: relative(2, "mo"), component: [tablet(0.5)] }
    ] };
    for (const input of [course, toFhirR5Dosages(course), toDosageDetails(toFhirR5Dosages(course))]) {
      const en = formatSig(input, "long", { locale: "en" });
      const th = formatSig(input, "long", { locale: "th" });
      expect(en).toContain("1 month after treatment start");
      expect(en).toContain("2 months after treatment start");
      expect(en).not.toContain("requires review");
      expect(en).not.toContain("30 days");
      expect(th).toContain("1 เดือนหลังเริ่มการรักษา");
      expect(th).toContain("2 เดือนหลังเริ่มการรักษา");
      expect(th).not.toContain("ต้องตรวจสอบ");
      const options = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00", limit: 1 };
      expect(nextDueDoses(input, { ...options, from: "2026-12-02T00:00:00+07:00" }))
        .toEqual(["2026-12-02T08:00:00+07:00"]);
      expect(nextDueDoses(input, { ...options, from: "2027-01-02T00:00:00+07:00" })).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...options, from: options.orderedAt,
        durationValue: 2, durationUnit: FhirPeriodUnit.Month }).totalUnits).toBe(45.5);
    }
  });

  it("keeps year and mixed day/month offsets visible without inventing conversion factors", () => {
    const courses: FhirR6DosageDetails[] = [
      { step: [{ start: relative(1, "a"), end: relative(2, "a"), component: [tablet(1)] }] },
      { step: [{ start: relative(7, "d"), end: relative(1, "mo"), component: [tablet(1)] }] }
    ];
    expect(formatSig(courses[0], "long", { locale: "en" })).toContain("1 year after treatment start");
    expect(formatSig(courses[0], "long", { locale: "th" })).toContain("2 ปีหลังเริ่มการรักษา");
    const text = formatSig(courses[1], "long", { locale: "en" });
    expect(text).toContain("7 days after treatment start");
    expect(text).toContain("1 month after treatment start");
    expect(text).not.toContain("30 days");
  });
});


describe("source-less Boolean condition display preserves nested scope", () => {
  const state = (name: string): MedicationCondition => ({ kind: "state", name, text: name, expected: true });
  const variants = (condition: MedicationCondition) => {
    const row: EzDosage = { timing: { repeat: { timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    setDosageCondition(row, condition);
    const course = toDosageDetails([row]);
    const strict = toFhirR5Dosages(course);
    expect(getDosageCondition(strict[0])).toEqual(condition);
    return [row, course, strict] as const;
  };

  it("keeps a nested NOT inside an OR in native and strict FHIR", () => {
    const condition: MedicationCondition = { kind: "any", conditions: [
      { kind: "not", condition: state("fever") }, state("nausea")
    ] };
    for (const input of variants(condition)) {
      expect(formatSig(input, "long", { locale: "en" })).toContain("only if not (fever) or nausea");
      expect(formatSig(input, "long", { locale: "th" })).toContain("ไม่ (fever) หรือ nausea");
    }
  });

  it("keeps nested AND/OR grouping visible rather than changing logical precedence", () => {
    const condition: MedicationCondition = { kind: "all", conditions: [
      { kind: "any", conditions: [state("fever"), state("nausea")] },
      { kind: "not", condition: state("fasting") }
    ] };
    for (const input of variants(condition)) {
      expect(formatSig(input, "long", { locale: "en" }))
        .toContain("only if (fever or nausea) and not (fasting)");
      expect(formatSig(input, "long", { locale: "th" }))
        .toContain("(fever หรือ nausea) และ ไม่ (fasting)");
    }
  });

  it("retains top-level unless without accidentally adding double negation", () => {
    const condition: MedicationCondition = { kind: "not", condition: state("fasting") };
    for (const input of variants(condition)) {
      const text = formatSig(input, "long", { locale: "en" });
      expect(text).toContain("unless fasting");
      expect(text).not.toContain("unless not");
    }
  });
});


describe("method-only inheritance remains reachable for PRN successors", () => {
  it.each([
    ["Instill 1 drop in right eye daily for 7 days, then 1 drop in left eye as needed.", "Instill"],
    ["Apply 1 mL to scalp nightly for 7 days, then 1 mL to scalp as needed.", "Apply"]
  ])("inherits the source method without fabricating recurring successor times: %s", (source, method) => {
    const parsed = parseSig(source);
    expect(parsed.fhir).toHaveLength(2);
    expect(parsed.fhir[1].method?.text).toBe(method);
    expect(parsed.fhir[1].timing?.repeat).toBeUndefined();
    expect(parsed.fhir[1].asNeeded).toBe(true);
    expect(parsed.meta.canonical.clauses[1].evidence.some(item =>
      item.rule === "hpsg.cx.regimen.shared-administration-method")).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(toFhirR5Dosages(parsed.fhirNext)[1].method?.text).toBe(method);
  });
});


describe("native R6 label-only condition text", () => {
  it("does not confuse a source-less condition label with its Boolean or numeric meaning", () => {
    const cases: Array<{ condition: NonNullable<FhirR6DosageDetails["step"][number]["component"][number]["condition"]>[number]; expected: string }> = [
      { condition: { code: { coding: [{ code: "problem-presents" }] },
        details: { text: "fasting" }, valueBoolean: false }, expected: "only if not fasting" },
      { condition: { code: { text: "systolic BP" }, operation: "gt",
        valueQuantity: { value: 100, unit: "mmHg" } }, expected: "only if systolic BP > 100 mmHg" }
    ];
    for (const { condition, expected } of cases) {
      const course: FhirR6DosageDetails = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { timeOfDay: ["08:00:00"] } }, condition: [condition]
      }] }] };
      const before = cloneStructuredValue(course);
      for (const input of [course, toFhirR5Dosages(course)]) {
        expect(formatSig(input, "long", { locale: "en" })).toContain(expected);
      }
      expect(course).toEqual(before);
    }
  });
});

describe("cached parse-batch formatting retains course-wide semantics", () => {
  const relative = (value: number) => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] },
    offsetDuration: { value, code: "d", unit: "d" }
  });
  const tablet = (value: number) => ({
    timing: { repeat: { timeOfDay: ["08:00:00"] } },
    doseAndRate: [{ doseQuantity: { value, unit: "tab" } }]
  });

  it.each(["en", "th"])("keeps finite phases and a medication-free week in %s, for both styles", locale => {
    const course: FhirR6DosageDetails = {
      step: [
        { end: relative(7), component: [tablet(1)] },
        { start: relative(14), end: relative(21), component: [tablet(2)] }
      ]
    };
    for (const input of [course, toDosageDetails(toFhirR5Dosages(course))]) {
      const batch = fromFhir(input, { locale });
      for (const style of ["short", "long"] as const) {
        const text = formatParseBatch(batch, style);
        expect(text).toContain(locale === "th" ? "วันที่ 1–7" : "Days 1–7");
        expect(text).toContain(locale === "th" ? "วันที่ 15–21" : "Days 15–21");
        expect(text).toContain(locale === "th" ? "งดยาในวันที่ 8–14" : "No doses on days 8–14");
        expect(text).toContain("2");
        expect(formatParseBatch(batch, style, " | ")).toBe(text);
      }
    }
  });

  it("does not reduce repeating finite courses to an unqualified daily dose", () => {
    const course: FhirR6DosageDetails = {
      repeatCycle: { value: 14, code: "d", unit: "d" },
      step: [{ start: relative(0), end: relative(7), count: 2, component: [tablet(1)] }]
    };
    const batch = fromFhir(course, { locale: "en" });
    const text = formatParseBatch(batch, "long");
    expect(text).toContain("Days 1–7");
    expect(text).toContain("No doses on days 8–14");
    expect(text).toMatch(/14 days/);
    expect(text).toMatch(/2 cycles/);
  });
});

describe("parse-batch alternatives keep the selected display language", () => {
  it.each(["en", "th"])("keeps mutually exclusive source-less doses in %s", locale => {
    const course: FhirR6DosageDetails = {
      step: [{ component: [1, 2].map(value => ({
        doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
        timing: { repeat: { timeOfDay: ["08:00:00"] } }
      })) }]
    };
    course.step[0].component.forEach((component, index) => {
      setDosageAlternativeChoice(component, {
        groupId: "dose-option", branchId: String(index), selectionBehavior: "exactly-one"
      });
    });
    const batch = fromFhir(course, { locale });
    for (const style of ["short", "long"] as const) {
      const text = formatParseBatch(batch, style, " | ");
      expect(text).toContain(locale === "th" ? "เลือกอย่างใดอย่างหนึ่ง" : "Choose one");
      expect(text).toContain(locale === "th" ? " หรือ " : " or ");
      expect(text).toContain(locale === "th" ? "1 เม็ด" : style === "long" ? "1 tablet" : "1 tab");
      expect(text).toContain(locale === "th" ? "2 เม็ด" : style === "long" ? "2 tablets" : "2 tab");
      if (locale === "th") expect(text).not.toContain("Choose one");
    }
  });
});

describe("public batch displays preserve ordinary R5 stage ordering", () => {
  const row = (sequence: number | undefined, value: number, clock: string): EzDosage => ({
    sequence,
    timing: { repeat: { timeOfDay: [clock], boundsDuration: { value: 7, code: "d", unit: "d" } } },
    doseAndRate: [{ doseQuantity: { value, unit: "tab" } }]
  });
  const rows = () => [row(1, 2, "08:00:00"), row(1, 0.5, "20:00:00"), row(2, 1, "08:00:00")];

  it.each(["en", "th"])("keeps parallel members within their stage and sequences the next stage in %s", locale => {
    const dosages = rows();
    const marker = locale === "th" ? "จากนั้น" : "then";
    for (const style of ["short", "long"] as const) {
      const text = formatSigBatch(dosages, style, { locale });
      expect(text.split(marker)).toHaveLength(2);
      expect(text.indexOf("0.5")).toBeLessThan(text.indexOf(marker));
      expect(text.slice(text.indexOf(marker))).toContain(locale === "th" ? "1 เม็ด" : "1 tab");
      const imported = fromFhir(toDosageDetails(dosages), { locale });
      expect(formatParseBatch(imported, style).split(marker)).toHaveLength(2);
      // Input array order must not reverse the explicit sequence relationship.
      expect(formatSigBatch([dosages[2], dosages[0], dosages[1]], style, { locale })).toBe(text);
    }
  });

  it("does not turn simultaneous or unsequenced administrations into a taper", () => {
    for (const sequence of [undefined, 1]) {
      const dosages = [row(sequence, 1, "08:00:00"), row(sequence, 0.5, "20:00:00")];
      const text = formatSigBatch(dosages, "long", { locale: "en", separator: " | " });
      expect(text.split(" | ")).toHaveLength(2);
      expect(text).not.toContain("then");
    }
  });
});

it("normalizes ordinary staged R5 batches by default without changing native course round-trip preference", () => {
  const source = "1 drop OD q2h x1wk then qid x1wk";
  const parsed = parseSig(source);
  const r5 = toFhirR5Dosages(parsed.fhirNext);
  const text = formatSigBatch(r5, "long");
  expect(text).toMatch(/every 2 hours[\s\S]*four times daily/iu);
  expect(text).toContain("right eye");
  expect(formatSig(parsed.fhirNext, "long")).toBe(source);
  expect(formatSigBatch(r5, "long", { locale: "th" })).toContain("ตาขวา");
});

describe("activity timing markers are usable by in-memory FHIR consumers", () => {
  function expectDefined(value: unknown, path: string): void {
    expect(value, path).not.toBeUndefined();
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) expectDefined(child, path + "." + key);
    }
  }

  it.each([
    "Insert 1 tablet vaginally once after menstruation ends.",
    "Take 1 tablet once after dialysis.",
    "รับประทาน 1 เม็ด ครั้งเดียวหลังฟอกไต"
  ])("omits undefined datatype fields without losing source, coding or translations: %s", input => {
    const parsed = parseSig(input);
    for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      const marker = rows[0].timing?.repeat?.extension?.find(e => e.url === TIMING_ACTIVITY_WINDOW_EXTENSION_URL);
      expect(marker).toBeDefined();
      expectDefined(marker, "activity-marker");
      const concept = marker?.extension?.find(e => e.url === "activity")?.valueCodeableConcept;
      expect(concept?.text).toBe(input.includes("menstruation") ? "menstruation ends" : "dialysis");
      if (!input.includes("menstruation")) expect(concept?.coding?.[0]?.code).toBe("108241001");
      expect(rows[0].text).toBe(parsed.fhir[0].text);
    }
  });

  it("does not normalize, drop or label unrelated unknown modifiers", () => {
    const course = parseSig("Take 1 tablet once after dialysis.").fhirNext;
    const opaque: FhirExtension = { url: "urn:external:opaque", extension: [
      { url: "count", valueInteger: 0 }, { url: "active", valueBoolean: false }
    ] };
    course.step[0].component[0].modifierExtension = [opaque];
    const rows = toFhirR5Dosages(course);
    expect(rows[0].modifierExtension?.find(e => e.url === opaque.url)).toEqual(opaque);
    expect(fromFhir(toDosageDetails(rows)).warnings).toEqual([]);
  });
});


describe("cycle-day constraints survive source-less FHIR import", () => {
  const base = {
    from: "2026-11-02T00:00:00+07:00", orderedAt: "2026-11-02T00:00:00+07:00",
    timeZone: "Asia/Bangkok", eventClock: { HS: "22:00" }, limit: 4
  };

  it.each([
    "1 cap PV HS on cycle days 16-25 for 3 cycles",
    "1 cap PV HS days 16-25 of menstrual cycle",
    "1 cap PV HS on cycle days 16-25 of every 28-day cycle",
    "1 cap PV HS x10d starting on cycle day 16"
  ])("keeps editable known fields but never executes an unanchored cycle: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict).toHaveLength(1);
    const row = strict[0];
    expect(row.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(row.doseAndRate?.[0]?.doseRange).toBeUndefined();
    expect(row.site?.text).toBe("vagina");
    expect(row.timing?.repeat?.when).toContain("HS");
    // Ordinary structured FHIR import may have no authored display text or
    // source-provenance extension. Eligibility must remain in its own typed
    // modifier rather than depend on reparsing warnings or original prose.
    const standalone = {
      doseAndRate: cloneStructuredValue(row.doseAndRate),
      route: cloneStructuredValue(row.route),
      site: cloneStructuredValue(row.site),
      timing: cloneStructuredValue(row.timing),
      modifierExtension: cloneStructuredValue(row.modifierExtension?.filter(extension =>
        extension.url.endsWith("medication-cycle-day-eligibility")))
    };
    expect(standalone.modifierExtension).toHaveLength(1);
    expect(formatSig(standalone, "long").trim().length).toBeGreaterThan(0);
    const canonical = canonicalFromFhir(standalone);
    expect(canonical.dose?.value).toBe(1);
    expect(canonical.site?.text).toBe("vagina");
    expect(canonical.schedule?.cycleDayConstraint?.days[0]).toBe(16);
    expect(parserStateFromFhir(standalone).primaryClause.schedule?.cycleDayConstraint)
      .toEqual(canonical.schedule?.cycleDayConstraint);
    // fromFhir imports native R6; the public R5 bridge supplies that input.
    const imported = fromFhir(toDosageDetails([standalone]));
    for (const dosage of [standalone, [standalone], imported.fhirNext, imported.fhir,
      toFhirR5Dosages(imported.fhirNext)]) {
      expect(() => nextDueDoses(dosage, base)).toThrow(/cycle|anchor|eligib/i);
      expect(() => calculateTotalUnits({ dosage, ...base,
        durationValue: 84, durationUnit: FhirPeriodUnit.Day })).toThrow(/cycle|anchor|eligib/i);
    }
  });

  it("has the same source-preserving unresolved-cycle meaning in the asynchronous parser", async () => {
    const source = "1 cap PV HS on cycle days 16-25 for 3 cycles";
    const sync = parseSig(source);
    const asyncResult = await parseSigAsync(source);
    expect(asyncResult.fhir).toEqual(sync.fhir);
    expect(asyncResult.fhirNext).toEqual(sync.fhirNext);
    expect(asyncResult.fhirNext.renderedInstruction).toBe(source);
    expect(() => nextDueDoses(asyncResult, base)).toThrow(/cycle|anchor|eligib/i);
  });

  it("does not retain an unresolved constraint after the clinician supplies the cycle anchor", () => {
    const source = "1 cap PV HS on days 16-25 of every 28-day cycle starting 2026-11-01 for 3 cycles";
    const parsed = parseSig(source);
    const expected: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) for (let day = 16; day <= 25; day++) {
      expected.push(Date.parse("2026-11-01T22:00:00+07:00") + (cycle * 28 + day - 1) * 86400000);
    }
    for (const dosage of [parsed.fhirNext, parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...base, limit: 60 }).map(value => Date.parse(value))).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 100,
        durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(30);
    }
    expect(parsed.fhir.some(row => row.modifierExtension?.some(extension =>
      extension.url.endsWith("medication-cycle-day-eligibility")))).toBe(false);
    const ordinary = parseSig("1 cap PV HS x10d");
    expect(calculateTotalUnits({ dosage: ordinary.fhirNext, ...base,
      durationValue: 30, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(10);
  });
});


describe("delayed target preserves independently stated recipient quantities", () => {
  it.each([
    ["Instill 1 drop right eye at 08:00, wait 5 minutes, then 2 drops left eye", 1, 2],
    ["Instill 2 drops left eye at 08:00, wait 5 minutes, then 1 drop right eye", 2, 1],
    ["Instill 2 drops right eye at 08:00, wait 5 minutes, then left eye", 2, 2]
  ] as const)("inherits only missing dose semantics: %s", (source, firstDose, secondDose) => {
    const parsed = parseSig(source);
    expect(parsed.fhir).toHaveLength(2);
    expect(parsed.fhir.map(row => row.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([firstDose, secondDose]);
    expect(parsed.fhir.every(row => row.doseAndRate?.[0]?.doseQuantity?.unit === "drop")).toBe(true);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component).toHaveLength(2);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const anchor = "2026-11-02T00:00:00+07:00";
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const next = nextDueDoses(dosage, { orderedAt: anchor, from: anchor,
        timeZone: "Asia/Bangkok", limit: 2 });
      expect(next).toEqual(["2026-11-02T08:00:00+07:00", "2026-11-02T08:05:00+07:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt: anchor, from: anchor,
        timeZone: "Asia/Bangkok", durationValue: 1, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(firstDose + secondDose);
    }
  });

  it("does not replace a separately supplied recipient schedule with an inherited wait", () => {
    const source = "Instill 1 drop right eye at 08:00, wait 5 minutes, then 2 drops left eye at 09:00";
    const parsed = parseSig(source);
    expect(parsed.fhir.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(parsed.fhir[1].timing?.repeat?.timeOfDay).toEqual(["09:00:00"]);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("FHIR extension profile differential base order", () => {
  // HL7 StructureDefinition 5.4.6: preserve base element order and traverse
  // descendants depth-first; extension slices precede the parent's URL/value.
  it.each([
    ["R5 conditional dosage", conditionalDoseProfile],
    ["R5 rendered instruction", renderedInstructionProfile],
    ["R6 condition logic", conditionLogicProfile]
  ] as const)("keeps %s snapshot-generator ordering without changing its constraints", (_name, profile) => {
    const elements = profile.differential.element;
    const ranks: Record<string, number> = { id: 0, extension: 1, url: 2, "value[x]": 3 };
    const priorRank = new Map<string, number>();
    expect(new Set(elements.map(element => element.id)).size).toBe(elements.length);
    elements.forEach((element, index) => {
      const split = element.id.lastIndexOf(".");
      if (split >= 0) {
        const parent = element.id.slice(0, split);
        const field = element.id.slice(split + 1).split(":")[0];
        const rank = ranks[field];
        if (rank !== undefined) {
          expect(rank, element.id + " follows base Extension order")
            .toBeGreaterThanOrEqual(priorRank.get(parent) ?? -1);
          priorRank.set(parent, rank);
        }
      }
      // Every explicitly listed descendant must stay inside its parent's
      // contiguous depth-first subtree, including deeply nested operand slices.
      const prefix = element.id + ".";
      const descendants = elements.map((child, childIndex) => ({ child, childIndex }))
        .filter(({ child }) => child.id.startsWith(prefix));
      if (descendants.length) {
        const last = descendants[descendants.length - 1].childIndex;
        expect(descendants[0].childIndex).toBe(index + 1);
        expect(elements.slice(index + 1, last + 1).every(child => child.id.startsWith(prefix))).toBe(true);
      }
    });
    expect(elements.find(element => element.id === "Extension.url"))
      .toMatchObject({ fixedUri: profile.url });
    expect(elements.find(element => element.id === "Extension.value[x]"))
      .toMatchObject({ max: "0" });
  });
});


describe("multiplicative dose-frequency whitespace keeps clinical arithmetic", () => {
  it.each(["1x3", "1 x3", "1x 3", "1 x 3", "1*3", "1 tab 1x3"])(
    "keeps the same supplied tablet context for %s", shorthand => {
      const source = shorthand + " po pc x5d";
      const parsed = parseSig(source, { context: { dosageForm: "tablet" } });
      expect(parsed.fhir).toHaveLength(1);
      expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(parsed.fhir[0].timing?.repeat?.frequency).toBe(3);
      expect(parsed.fhir[0].timing?.repeat?.boundsDuration?.value).toBe(5);
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
      const start = "2026-11-02T00:00:00+07:00";
      const options = { from: start, orderedAt: start, timeZone: "Asia/Bangkok",
        eventClock: { CM: "08:00", CD: "12:30", CV: "18:30" },
        mealOffsets: { PCM: 30, PCD: 30, PCV: 30, PC: 30 }, limit: 30 };
      const strict = toFhirR5Dosages(parsed.fhirNext);
      for (const dosage of [parsed.fhirNext, strict, toDosageDetails(strict)]) {
        const times = nextDueDoses(dosage, options);
        expect(times).toHaveLength(15);
        expect(times.filter(stamp => stamp.startsWith("2026-11-02")).map(stamp => stamp.slice(11,16)))
          .toEqual(["08:30", "13:00", "19:00"]);
        expect(times[times.length - 1].slice(0,10)).toBe("2026-11-06");
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 28,
          durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(15);
      }
    }
  );
});


describe("common half glyph uses the existing fraction lexicon without source rewriting", () => {
  it.each(["½", "0.5", "1/2", "half"])("retains the same dose and source for %s", fraction => {
    const source = fraction + " tab PO BID x7d";
    const parsed = parseSig(source);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseRange).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.meta.canonical.clauses[0].rawText).toBe(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const start = "2026-11-02T00:00:00+07:00";
      expect(calculateTotalUnits({ dosage, from: start, orderedAt: start,
        timeZone: "Asia/Bangkok", durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(7);
    }
  });
});


describe("parser state import preserves administration offsets", () => {
  it.each([0, 5, 720])("retains an explicitly supplied %i-minute offset and its execution after reopening", minutes => {
    const dosage: EzDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { timeOfDay: ["08:00:00"],
        boundsDuration: { value: 2, unit: "d", code: "d" } } },
      modifierExtension: [{ url: ADMINISTRATION_OFFSET_EXTENSION_URL,
        valueQuantity: { value: minutes, unit: "min", code: "min" } }]
    };
    const original = cloneStructuredValue(dosage);
    const state = parserStateFromFhir(dosage);
    expect(state.primaryClause.schedule?.administrationOffsetMinutes).toBe(minutes);
    expect(state.primaryClause.schedule?.administrationOffsetMinutes)
      .toBe(canonicalFromFhir(dosage).schedule?.administrationOffsetMinutes);
    const rebuilt = parserStateToFhir(state);
    expect(getAdministrationOffsetMinutes(rebuilt)).toBe(minutes);
    const anchor = "2026-11-02T00:00:00+07:00";
    const expected = ["2026-11-02", "2026-11-03"].map(day =>
      Date.parse(day + "T08:00:00+07:00") + minutes * 60000);
    for (const candidate of [rebuilt, toDosageDetails([rebuilt]), toFhirR5Dosages(toDosageDetails([rebuilt]))]) {
      expect(nextDueDoses(candidate, { orderedAt: anchor, from: anchor,
        timeZone: "Asia/Bangkok", limit: 4 }).map(value => Date.parse(value))).toEqual(expected);
      expect(calculateTotalUnits({ dosage: candidate, orderedAt: anchor, from: anchor,
        timeZone: "Asia/Bangkok", durationValue: 4, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    }
    expect(dosage).toEqual(original);
  });

  it("creates the canonical schedule when only the offset modifier exists", () => {
    const dosage: EzDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      modifierExtension: [{ url: ADMINISTRATION_OFFSET_EXTENSION_URL,
        valueQuantity: { value: 15, code: "min" } }] };
    const state = parserStateFromFhir(dosage);
    expect(state.primaryClause.schedule?.administrationOffsetMinutes).toBe(15);
    expect(getAdministrationOffsetMinutes(parserStateToFhir(state))).toBe(15);
  });

  it("does not manufacture an offset from a missing modifier or an unsupported unit", () => {
    for (const modifierExtension of [undefined, [{ url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { value: 5, code: "mg" } }]]) {
      const dosage: EzDosage = { timing: { repeat: { timeOfDay: ["08:00:00"] } }, modifierExtension };
      expect(parserStateFromFhir(dosage).primaryClause.schedule?.administrationOffsetMinutes).toBeUndefined();
      expect(canonicalFromFhir(dosage).schedule?.administrationOffsetMinutes).toBeUndefined();
    }
  });
});
