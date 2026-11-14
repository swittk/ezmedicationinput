import { equalStructuredValues, cloneStructuredValue } from "../src/stable-structure";
import { describe, expect, it } from "vitest";
import conditionalDoseProfile from "../fhir/r5/medication-conditional-dose.json";
import renderedInstructionProfile from "../fhir/r5/medication-rendered-instruction.json";
import conditionLogicProfile from "../fhir/r6/medication-r6-condition-logic.json";
import r6SnapshotContract from "../fhir/r6/official-snapshot1-20261113-contract.json";
import {
  parseSig, parseSigAsync, fromFhir, formatSig, formatSigBatch, formatParseBatch, nextDueDoses, calculateTotalUnits,
  toDosageDetails, toFhirR5Dosages, toEzDosages, fromDosageDetails,
  getBodySiteText, evaluateMedicationCondition, setDosageCondition, getDosageCondition,
  type FhirR6DosageInstruction, type FhirExtension, type EzDosage, type MedicationCondition,
  EventTiming, FhirPeriodUnit
} from "../src/index";
import {
  canonicalFromFhir, canonicalToFhir, parserStateFromFhir, TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
  toFhir as parserStateToFhir, getAdministrationOffsetMinutes, ADMINISTRATION_OFFSET_EXTENSION_URL,
  buildInfusionCarrierMaterialStructureDefinition
} from "../src/fhir";
import { parseMedicationGuard } from "../src/medication-condition";
import {
  setDosageExcludedDates, getDosageExcludedDates, getDosageExcludedWeekdays, getDosageCalendarDayCondition,
  DOSAGE_ALTERNATIVE_CHOICE_URL, getDosageAlternativeChoice,
  setDosageAlternativeChoice, buildDosageAlternativeChoiceStructureDefinition
} from "../src/dosage-course";

describe("EZMED extended R5 dosage and R6 projection", () => {
  it.each(["QHS", "QAM", "QPM", "BLD"] as const)(
    "retains local %s identity in FHIR Timing.code.text and both import paths", abbreviation => {
      const source = `Take 1 tablet PO ${abbreviation}`;
      const parsed = parseSig(source);
      const row = parsed.fhir[0];
      expect(parsed.meta.canonical.clauses[0].schedule?.timingCode).toBe(abbreviation);
      expect(row.timing?.code?.text).toBe(abbreviation);
      expect(row.timing?.code?.coding).toBeUndefined();
      expect(canonicalFromFhir(row).schedule?.timingCode).toBe(abbreviation);
      expect(parserStateFromFhir(row).primaryClause.schedule?.timingCode).toBe(abbreviation);
      const strict = toFhirR5Dosages(parsed.fhirNext)[0];
      expect(canonicalFromFhir(strict).schedule?.timingCode).toBe(abbreviation);
      expect(canonicalToFhir(canonicalFromFhir(strict)).timing?.code?.text).toBe(abbreviation);
      expect(row.timing?.repeat).toEqual(strict.timing?.repeat);
    }
  );
  it("does not reinterpret arbitrary FHIR Timing.code.text as an abbreviation", () => {
    const row = parseSig("Take 1 tab PO QAM").fhir[0];
    row.timing!.code = { text: "after my morning workout" };
    expect(canonicalFromFhir(row).schedule?.timingCode).toBeUndefined();
    expect(parserStateFromFhir(row).primaryClause.schedule?.timingCode).toBeUndefined();
  });

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

  it("preserves unknown local metadata and reconciles conflicting phase copies without copying components", () => {
    const expected = parseSig("1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid").fhirNext;
    const r5 = toFhirR5Dosages(expected);
    const marker = (index: number) => r5[index].modifierExtension!.find(ext => ext.url.includes("course-details"))!;
    marker(0).extension!.push({ url: "externalAudit", valueBoolean: false });
    const unknown = cloneStructuredValue(marker(0));
    const recovered = toDosageDetails(r5);
    expect(recovered.renderedInstruction).toBe(expected.renderedInstruction);
    expect(recovered.step).toEqual(expected.step);
    expect(recovered.extension?.some(extension =>
      extension.extension?.some(child => equalStructuredValues(child, unknown)))).toBe(true);

    const phase = marker(1).extension!.find(child => child.url === "step")!;
    const end = phase.extension!.find(child => child.url === "end")!;
    end.extension!.find(child => child.url === "offsetDuration")!.valueQuantity!.value = 8;
    const reconciled = toDosageDetails(r5);
    expect(reconciled.step[0].end).toEqual(expected.step[0].end);
    expect(reconciled.step.flatMap(step => step.component).map(row => row.doseAndRate))
      .toEqual(expected.step.flatMap(step => step.component).map(row => row.doseAndRate));
    expect(reconciled.extension).toContainEqual(expect.objectContaining({
      url: expect.stringContaining("medication-course-reconciliation-warning"),
      valueString: expect.stringContaining("phase metadata differs")
    }));
    const sources = reconciled.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(sources.every(extension => extension.extension?.length && extension.valueString === undefined)).toBe(true);
  });

  it("keeps optional real R6 semantics on normal EZMED dosages", () => {
    const course: FhirR6DosageInstruction = {
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
    const original: FhirR6DosageInstruction = {
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
  const original: FhirR6DosageInstruction = {
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
      ?.extension?.find(extension => extension.url === "component");
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
    const original: FhirR6DosageInstruction = {
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
      extension.url.endsWith("medication-rendered-instruction"));
    expect(historic?.extension).toContainEqual({
      url: "instruction", valueString: original.renderedInstruction
    });
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
    const formula: FhirR6DosageInstruction = {
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
      url: "urn:ezmedicationinput:StructureDefinition:medication-timing-activity-window",
      extension: [
        { url: "relation", valueCode: relation },
        { url: "activity", valueCodeableConcept: { text: "meal" } },
        { url: "offset", valueQuantity: {
          value: minutes, unit: "minutes",
          system: "http://unitsofmeasure.org", code: "min"
        } }
      ]
    });
    const original: FhirR6DosageInstruction = {
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
  const original: FhirR6DosageInstruction = {
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
  const original: FhirR6DosageInstruction = {
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
  function alternativeCourse(language: "en" | "th" = "en"): FhirR6DosageInstruction {
    const result: FhirR6DosageInstruction = {
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
    const third: FhirR6DosageInstruction["step"][number]["component"][number] = {
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
    const original: FhirR6DosageInstruction = {
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
    const input: FhirR6DosageInstruction = {
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
    const dosage: FhirR6DosageInstruction["step"][number]["component"][number] = {
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: "d", timeOfDay: [time] } }
    };
    setDosageAlternativeChoice(dosage, { groupId, branchId, selectionBehavior: "exactly-one" });
    return dosage;
  };

  it("executes every component of one selected branch, not one component nor every alternative", () => {
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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
  it("preserves independently authored active and carrier display labels for a self-carried infusion", () => {
    const parsed = parseSig("Infuse 500 mL IV over 2 hours");
    const row = cloneStructuredValue(parsed.fhir[0]);
    const rate = row.doseAndRate?.[0]?.rateRatio;
    expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      unit: "mL", system: "http://unitsofmeasure.org", code: "mL"
    });
    expect(rate?.numerator).toMatchObject({
      unit: "mL", system: "http://unitsofmeasure.org", code: "mL"
    });
    rate!.numerator!.unit = "milliliter";
    const imported = canonicalFromFhir(row);
    expect(imported.clinicalQuantity).toMatchObject({
      projectedDose: { value: 500, unit: "mL" },
      numerator: { value: 500, unit: "milliliter" },
      rateNumerator: { value: 500, unit: "milliliter" }
    });
    expect(imported.clinicalQuantity?.carrierMaterial).toBeUndefined();
    const recreated = canonicalToFhir(imported).doseAndRate?.[0];
    expect(recreated?.doseQuantity).toMatchObject({ unit: "mL", code: "mL" });
    expect(recreated?.rateRatio?.numerator).toMatchObject({
      value: 500, unit: "milliliter", system: "http://unitsofmeasure.org", code: "mL"
    });
  });

  it("preserves authored FHIR UCUM labels independently of their comparison codes", () => {
    const input = "Infuse 20 mcg drug in 100 mL diluent over 1 hour IV";
    const parsed = parseSig(input);
    const dosage = cloneStructuredValue(parsed.fhir[0]);
    const measured = dosage.doseAndRate?.[0];
    expect(measured?.doseQuantity?.code).toBe("ug");
    expect(measured?.rateRatio?.numerator?.code).toBe("mL");
    expect(dosage.extension?.some(item =>
      item.url.endsWith("medication-infusion-carrier-material"))).toBe(true);

    // Distinct authored display labels can represent the same UCUM measurement.
    measured!.doseQuantity!.unit = "mcg";
    measured!.rateRatio!.numerator!.unit = "milliliter";
    const imported = canonicalFromFhir(dosage);
    expect(imported.dose?.unit).toBe("mcg");
    expect(imported.clinicalQuantity).toMatchObject({
      projectedDose: { value: 20, unit: "mcg" },
      numerator: { value: 100, unit: "milliliter" },
      rateNumerator: { value: 100, unit: "milliliter" },
      carrierMaterial: { text: "diluent" }
    });
    const exported = canonicalToFhir(imported);
    expect(exported.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 20, unit: "mcg", code: "ug", system: "http://unitsofmeasure.org"
    });
    expect(exported.doseAndRate?.[0]?.rateRatio?.numerator).toMatchObject({
      value: 100, unit: "milliliter", code: "mL", system: "http://unitsofmeasure.org"
    });
    const twice = canonicalToFhir(canonicalFromFhir(exported));
    expect(twice.doseAndRate?.[0]).toEqual(exported.doseAndRate?.[0]);
  });

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
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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
  const variants = (course: FhirR6DosageInstruction) => [
    course, toDosageDetails(toFhirR5Dosages(course)), toFhirR5Dosages(course)
  ];

  it("renders the repeat period and medication-free tail of a recurring course in both locales", () => {
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = { step: reordered ? [stages[1], stages[2], stages[0]] : stages };
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
    const course: FhirR6DosageInstruction = { step: [step(0, 10, 1), step(0, 7, 0.5), step(14, 21, 0.5)] };
    for (const input of variants(course)) {
      const text = formatSig(input, "long", { locale: "en" });
      expect(text).toContain("No doses on days 11–14");
      expect(text).not.toContain("No doses on days 8–14");
    }
  });

  it("does not invent a pause when a concurrent component has no finite end", () => {
    const course: FhirR6DosageInstruction = {
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
      const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = { step: [
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
    const courses: FhirR6DosageInstruction[] = [
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
    const cases: Array<{ condition: NonNullable<FhirR6DosageInstruction["step"][number]["component"][number]["condition"]>[number]; expected: string }> = [
      { condition: { code: { coding: [{ code: "problem-presents" }] },
        details: { text: "fasting" }, valueBoolean: false }, expected: "only if not fasting" },
      { condition: { code: { text: "systolic BP" }, operation: "gt",
        valueQuantity: { value: 100, unit: "mmHg" } }, expected: "only if systolic BP > 100 mmHg" }
    ];
    for (const { condition, expected } of cases) {
      const course: FhirR6DosageInstruction = { step: [{ component: [{
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
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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


describe("compact row-local R5 course persistence", () => {
  const input = "1 drop OD q2h x7d then qid; 1 drop OS qid x1mo then bid";

  it("keeps the six-row independent taper below 12 KB in both public R5 outputs", () => {
    const parsed = parseSig(input);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.fhir).toHaveLength(6);
    for (const rows of [parsed.fhir, strict]) {
      expect(Buffer.byteLength(JSON.stringify(rows), "utf8")).toBeLessThan(12_000);
      expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(parsed.fhirNext);
    }
  });

  it("grows linearly with independent stage metadata instead of copying the course per row", () => {
    const course = (count: number): FhirR6DosageInstruction => ({ step: Array.from({ length: count }, (_, index) => ({
      start: { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
        offsetDuration: { value: index, unit: "d", code: "d" } },
      component: [{ timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
    })) });
    const small = Buffer.byteLength(JSON.stringify(toFhirR5Dosages(course(4))));
    const large = Buffer.byteLength(JSON.stringify(toFhirR5Dosages(course(40))));
    expect(large).toBeLessThan(small * 11);
  });
});

describe("compact course metadata ownership and editing", () => {
  const input = "1 drop OD q2h x7d then qid; 1 drop OS qid x1mo then bid";
  const options = { timeZone: "Asia/Bangkok", orderedAt: "2026-10-19T08:00:00+07:00",
    from: "2026-10-19T08:00:00+07:00", limit: 4 };
  const day = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d", code: "d" }
  });
  const component = (value = 1): FhirR6DosageInstruction["step"][number]["component"][number] => ({
    doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: "d", timeOfDay: ["08:00:00"] } }
  });

  it("retains later independent phases after deleting every row of the first phase", () => {
    const source = parseSig(input).fhirNext;
    const remaining = toFhirR5Dosages(source).slice(2);
    const restored = toDosageDetails(remaining);
    expect(restored.step.map(step => step.component.length)).toEqual([0, 2, 2]);
    expect(restored.step[1].start?.offsetDuration?.value).toBe(7);
    expect(restored.step[2].start?.offsetDuration?.code).toBe("mo");
    expect(nextDueDoses(remaining, options)).toEqual([
      "2026-10-26T08:00:00+07:00", "2026-10-26T08:00:00+07:00",
      "2026-10-26T12:00:00+07:00", "2026-10-26T12:00:00+07:00"
    ]);
    expect(calculateTotalUnits({ ...options, dosage: remaining, durationValue: 30, durationUnit: "d" }).totalUnits).toBe(184);
  });

  it("keeps a scalar later phase at its own treatment-relative start", () => {
    const row = toFhirR5Dosages(parseSig(input).fhirNext)[2];
    expect(nextDueDoses(row, options)).toEqual([
      "2026-10-26T08:00:00+07:00", "2026-10-26T12:00:00+07:00",
      "2026-10-26T16:00:00+07:00", "2026-10-26T20:00:00+07:00"
    ]);
    expect(calculateTotalUnits({ ...options, dosage: row, durationValue: 30, durationUnit: "d" }).totalUnits).toBe(92);
  });

  it("retains valid wording and independent component identities when rows are reordered", () => {
    const source = parseSig(input);
    const rows = toFhirR5Dosages(source.fhirNext).reverse();
    const restored = toDosageDetails(rows);
    expect(restored.renderedInstruction).toBe(input);
    expect(restored.step[0].component.map(row => row.site?.concept?.text)).toEqual(["left eye", "right eye"]);
    expect(restored.step.flatMap(step => step.component).every(row => !!row.text)).toBe(true);
    expect(nextDueDoses(rows, options)).toEqual(nextDueDoses(source.fhirNext, options));
    expect(calculateTotalUnits({ ...options, dosage: rows, durationValue: 30, durationUnit: "d" }).totalUnits).toBe(296);
  });

  it("stores course-wide metadata once and requires its owner for numeric execution", () => {
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 14, unit: "d", code: "d" },
      step: [
        { start: day(0), end: day(3), component: [component()] },
        { start: day(7), end: day(10), component: [component(2)] }
      ]
    };
    const rows = toFhirR5Dosages(source);
    const headers = rows.flatMap(row => row.modifierExtension ?? [])
      .flatMap(extension => extension.extension ?? []).filter(child => child.url === "course");
    expect(headers).toHaveLength(1);
    expect(toDosageDetails(rows)).toEqual(source);
    expect(calculateTotalUnits({ ...options, dosage: rows, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(18);
    const surviving = rows.slice(1);
    const supplied = toDosageDetails(surviving, undefined, fromDosageDetails(source).course);
    expect(calculateTotalUnits({ ...options, dosage: supplied, durationValue: 28, durationUnit: "d" }).totalUnits).toBe(12);
    const restored = toDosageDetails(surviving);
    expect(restored.step[1].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(restored.step[1].start).toEqual(day(7));
    expect(() => formatSig(restored, "long")).not.toThrow();
    // A partially deleted R5 draft keeps the missing phase editable, but
    // cannot masquerade as a valid current R6 DosageInstruction.
    expect(() => fromFhir(restored)).toThrow(/step\[0\].*component/);
    for (const dosage of [surviving, restored, toFhirR5Dosages(restored)]) {
      expect(() => nextDueDoses(dosage, options)).toThrow(/complete dosage array/);
      expect(() => calculateTotalUnits({ ...options, dosage, durationValue: 28, durationUnit: "d" })).toThrow(/complete dosage array/);
    }
    expect(rows[1].doseAndRate?.[0].doseQuantity?.value).toBe(2);
  });

  it("does not turn the loss of non-modifier course annotations into an execution block", () => {
    const source: FhirR6DosageInstruction = {
      id: "external-course",
      extension: [{ url: "urn:example:author", valueString: "source author" }],
      step: [
        { start: day(0), end: day(3), component: [component()] },
        { start: day(7), end: day(10), component: [component(2)] }
      ]
    };
    const rows = toFhirR5Dosages(source);
    expect(toDosageDetails(rows)).toEqual(source);
    expect(calculateTotalUnits({ ...options, dosage: rows.slice(1), durationValue: 14, durationUnit: "d" }).totalUnits).toBe(6);
  });

  it("requires a removed predecessor only when the surviving phase has no independent start", () => {
    const source: FhirR6DosageInstruction = { step: [
      { id: "initial", component: [{ ...component(), timing: { repeat: {
        frequency: 1, period: 1, periodUnit: "d", boundsDuration: { value: 7, unit: "d" }
      } } }] },
      { id: "continuation", component: [component(2)] }
    ] };
    const remaining = toFhirR5Dosages(source).slice(1);
    expect(toDosageDetails(remaining).step[1].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(() => nextDueDoses(remaining, options)).toThrow(/complete dosage array/);
    expect(() => calculateTotalUnits({ ...options, dosage: remaining, durationValue: 14, durationUnit: "d" })).toThrow(/complete dosage array/);
  });

  it("preserves an incomplete R5 phase as an editable draft without accepting it as current R6", () => {
    const source: FhirR6DosageInstruction = { step: [
      { end: day(7), component: [component(2)] },
      { start: day(7), end: day(14), component: [component()] }
    ] };
    const rows = toFhirR5Dosages(source).slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence).toBe(2);
    const incomplete = toDosageDetails(rows);
    expect(incomplete.step[0].component).toEqual([]);
    expect(incomplete.step[1].component[0]).toMatchObject({ doseAndRate: [{ doseQuantity: { value: 1 } }] });
    expect(() => fromFhir(incomplete)).toThrow(/step\[0\].*component/);
    expect(calculateTotalUnits({ ...options, dosage: rows, durationValue: 21, durationUnit: "d" }).totalUnits).toBe(7);
  });

  it("keeps native extended-R5 fields authoritative after JSON persistence and removal", () => {
    const source: FhirR6DosageInstruction = { step: [{ end: day(7), component: [{
      ...component(), site: { reference: { reference: "BodyStructure/example" } },
      condition: [{ code: { text: "Only if tolerated" }, text: "Only if tolerated" }],
      doseAndRate: [{ doseExpression: { language: "text/fhirpath", expression: "%patient.weight * 0.5" } }]
    }] }] };
    const rows: EzDosage[] = JSON.parse(JSON.stringify(fromDosageDetails(source).dosages));
    delete rows[0].siteReference;
    rows[0].condition = [];
    rows[0].doseAndRate = [{ doseQuantity: { value: 2, unit: "mg" } }];
    const restored = toDosageDetails(JSON.parse(JSON.stringify(rows)));
    const dose = restored.step[0].component[0];
    expect(dose.site?.reference).toBeUndefined();
    expect(dose.condition).toBeUndefined();
    expect(dose.doseAndRate).toEqual([{ doseQuantity: { value: 2, unit: "mg" } }]);
    expect(toDosageDetails(toFhirR5Dosages(restored)).step).toEqual(restored.step);
  });

  it("keeps repeated save/reopen payloads stable without creating nested course history", () => {
    let rows = toFhirR5Dosages(parseSig(input).fhirNext);
    const bytes = Buffer.byteLength(JSON.stringify(rows));
    for (let cycle = 0; cycle < 10; cycle++) {
      rows = toFhirR5Dosages(toDosageDetails(JSON.parse(JSON.stringify(rows))));
      expect(Buffer.byteLength(JSON.stringify(rows))).toBe(bytes);
      expect(rows).toHaveLength(6);
    }
  });
});

describe("compact shared metadata conflict preservation", () => {
  it("retains both conflicting shared owners and does not choose a cycle silently", () => {
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 14, unit: "d" },
      step: [{ component: [
        { timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] },
        { timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } }, doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] }
      ] }]
    };
    const rows = toFhirR5Dosages(source);
    const marker = (index: number) => rows[index].modifierExtension!.find(extension => extension.url.endsWith("medication-r6-course-details"))!;
    const other = cloneStructuredValue(marker(0).extension!.find(child => child.url === "course")!);
    other.extension!.find(child => child.url === "repeatCycle")!.valueQuantity!.value = 21;
    marker(1).extension!.push(other);
    const restored = toDosageDetails(rows);
    expect(restored.step[0].component.map(component => component.doseAndRate?.[0].doseQuantity?.value)).toEqual([1, 2]);
    expect(restored.extension?.filter(extension => extension.url.endsWith("medication-course-reconciliation-source")).length).toBeGreaterThanOrEqual(2);
    expect(() => nextDueDoses(restored, { from: "2026-10-19T08:00:00+07:00", timeZone: "Asia/Bangkok" }))
      .toThrow(/complete dosage array/);
  });

  it("preserves unfamiliar course markers beside recognized row-local metadata", () => {
    const rows = toFhirR5Dosages(parseSig("1 drop OD q2h x7d then qid; 1 drop OS qid x1mo then bid").fhirNext);
    const unknown: FhirExtension = {
      url: rows[0].modifierExtension!.find(extension => extension.url.endsWith("medication-r6-course-details"))!.url,
      extension: [{ url: "externalCourseLink", valueString: "source-only" }]
    };
    rows[1].modifierExtension!.push(unknown);
    const restored = toDosageDetails(rows);
    expect(restored.extension?.some(extension => extension.extension?.some(value => equalStructuredValues(value, unknown)))).toBe(true);
    expect(restored.step[1].start?.offsetDuration?.value).toBe(7);
    expect(toDosageDetails(toFhirR5Dosages(restored)).extension).toEqual(restored.extension);
  });
});


describe("conflicting executable phase metadata", () => {
  const input = "1 drop OD q2h x7d then qid; 1 drop OS qid x1mo then bid";
  const orderedAt = "2026-10-19T08:00:00+07:00";
  const options = { from: "2026-10-26T08:00:00+07:00", orderedAt, timeZone: "Asia/Bangkok", limit: 20 };
  const phase = (row: EzDosage) => row.modifierExtension!
    .find(extension => extension.url.endsWith("medication-r6-course-details"))!
    .extension!.find(child => child.url === "step")!;
  const start = (row: EzDosage) => phase(row).extension!.find(child => child.url === "start")!
    .extension!.find(child => child.url === "offsetDuration")!.valueQuantity!;

  it.each([
    ["primary", 2], ["primary", 3], ["strict", 2], ["strict", 3]
  ] as const)("blocks conflicting starts in %s row %i through edit and save paths", (projection, rowIndex) => {
    const parsed = parseSig(input);
    const rows = cloneStructuredValue(projection === "primary" ? parsed.fhir : toFhirR5Dosages(parsed.fhirNext));
    expect(nextDueDoses(rows, options).filter(value => value.startsWith("2026-10-26"))).toHaveLength(8);
    start(rows[rowIndex]).value = 8;
    const edited = cloneStructuredValue(rows);
    const restored = toDosageDetails(rows);
    const sources = restored.extension?.filter(extension => extension.url.endsWith("medication-course-reconciliation-source")) ?? [];
    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(() => formatSig(restored, "long", { locale: "th" })).not.toThrow();
    const assertConflict = (course: FhirR6DosageInstruction) => {
      expect(() => nextDueDoses(course, options)).toThrow(/conflicting course phase metadata/i);
      expect(() => calculateTotalUnits({ ...options, from: orderedAt, dosage: course, durationValue: 30, durationUnit: "d" }))
        .toThrow(/conflicting course phase metadata/i);
    };
    expect(() => nextDueDoses(rows, options)).toThrow(/conflicting course phase metadata/i);
    expect(() => calculateTotalUnits({ ...options, from: orderedAt, dosage: rows, durationValue: 30, durationUnit: "d" }))
      .toThrow(/conflicting course phase metadata/i);
    assertConflict(restored);
    assertConflict(toDosageDetails([...rows].reverse()));
    const imported = fromFhir(restored);
    assertConflict(toDosageDetails(imported.fhir, undefined, imported.course));
    let saved = restored;
    for (let cycle = 0; cycle < 3; cycle++) {
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
      assertConflict(saved);
    }
    expect(rows).toEqual(edited);
    // The conflict belongs to phase 2; unaffected rows remain executable on their own.
    const persisted = toFhirR5Dosages(restored);
    expect(() => nextDueDoses(persisted[0], { ...options, from: orderedAt, limit: 2 })).not.toThrow();
    const withoutConflictingPhase = persisted.filter(row => row.sequence !== 2);
    expect(calculateTotalUnits({ ...options, from: orderedAt, dosage: withoutConflictingPhase, durationValue: 30, durationUnit: "d" }).totalUnits).toBe(112);
    // Correcting the disagreeing live row restores the original executable course.
    start(rows[rowIndex]).value = 7;
    expect(nextDueDoses(rows, options).filter(value => value.startsWith("2026-10-26"))).toHaveLength(8);
    expect(calculateTotalUnits({ ...options, from: orderedAt, dosage: rows, durationValue: 30, durationUnit: "d" }).totalUnits).toBe(296);
  });


  it.each([
    ["primary", 2], ["primary", 3], ["strict", 2], ["strict", 3]
  ] as const)("resolves an explicitly corrected saved conflict in %s row %i", (projection, rowIndex) => {
    const parsed = parseSig(input);
    const rows = cloneStructuredValue(projection === "primary" ? parsed.fhir : toFhirR5Dosages(parsed.fhirNext));
    start(rows[rowIndex]).value = 8;
    // A confirmation cannot make currently disagreeing rows executable.
    const stillConflicting = toDosageDetails(rows, undefined, undefined, { resolvedPhaseSequences: [2] });
    expect(() => nextDueDoses(stillConflicting, options)).toThrow(/conflicting course phase metadata/i);

    // Begin with the SAVED conflict, whose historical marker must survive plain reopening.
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(toDosageDetails(rows)))) as EzDosage[];
    const note = { url: "https://example.org/reconciliation-note", valueString: "retain clinician note" };
    saved[2].extension = [...(saved[2].extension ?? []), note];
    for (const row of saved) if (row.sequence === 2) start(row).value = 7;
    expect(() => nextDueDoses(saved, options)).toThrow(/conflicting course phase metadata/i);
    const before = cloneStructuredValue(saved);
    let resolved = toDosageDetails(saved, undefined, undefined, { resolvedPhaseSequences: [2] });
    expect(saved).toEqual(before);
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(nextDueDoses(resolved, options).filter(value => value.startsWith("2026-10-26"))).toHaveLength(8);
      expect(calculateTotalUnits({
        ...options, from: orderedAt, dosage: resolved, durationValue: 30, durationUnit: "d"
      }).totalUnits).toBe(296);
      expect(resolved.extension?.filter(extension => extension.url.endsWith("medication-course-reconciliation-source")).length)
        .toBeGreaterThanOrEqual(2);
      const projected = toFhirR5Dosages(resolved);
      expect(projected[2].extension).toContainEqual(note);
      resolved = toDosageDetails(JSON.parse(JSON.stringify(projected)));
    }
    const imported = fromFhir(resolved);
    expect(calculateTotalUnits({
      ...options, from: orderedAt, dosage: toDosageDetails(imported.fhir, undefined, imported.course),
      durationValue: 30, durationUnit: "d"
    }).totalUnits).toBe(296);
  });

  it("does not confirm another phase or erase unrelated missing course context", () => {
    const rows = toFhirR5Dosages(parseSig(input).fhirNext);
    start(rows[2]).value = 8;
    const saved = toFhirR5Dosages(toDosageDetails(rows));
    for (const row of saved) if (row.sequence === 2) start(row).value = 7;
    expect(() => nextDueDoses(
      toDosageDetails(saved, undefined, undefined, { resolvedPhaseSequences: [1] }), options
    )).toThrow(/conflicting course phase metadata/i);
    saved[2].modifierExtension!.find(extension => extension.url.endsWith("medication-r6-course-details"))!
      .extension!.push({ url: "missingContext", valueString: "unresolved-shared-owner" });
    const resolved = toDosageDetails(saved, undefined, undefined, { resolvedPhaseSequences: [2] });
    expect(() => nextDueDoses(resolved, options)).toThrow(/complete dosage array/i);
    expect(JSON.stringify(resolved)).toContain("unresolved-shared-owner");
  });

  it("keeps ID and non-modifier annotation disagreements numerically executable", () => {
    const rows = toFhirR5Dosages(parseSig(input).fhirNext);
    phase(rows[2]).extension!.push({ url: "id", valueString: "edited-phase-label" }, {
      url: "extension", extension: [{ url: "https://example.org/phase-note", valueString: "reviewed" }]
    });
    const restored = toDosageDetails(rows);
    expect(restored.step[1].id).toBe("edited-phase-label");
    expect(restored.step[1].extension).toContainEqual({ url: "https://example.org/phase-note", valueString: "reviewed" });
    expect(nextDueDoses(restored, options).filter(value => value.startsWith("2026-10-26"))).toHaveLength(8);
    expect(calculateTotalUnits({ ...options, from: orderedAt, dosage: restored, durationValue: 30, durationUnit: "d" }).totalUnits).toBe(296);
  });
});


describe("FHIR clinical adjunct import", () => {
  it.each([
    "1 tab PO BID; HOLD if SBP <100",
    "1 tab PO QD except Sundays",
    "1 tab PO QD only on dialysis days"
  ])("retains conditions without source text: %s", input => {
    const parsed = parseSig(input);
    for (const original of [...parsed.fhir, ...toFhirR5Dosages(parsed.fhirNext)]) {
      const row = { ...original, text: undefined };
      setDosageExcludedDates(row, ["2026-11-03"]);
      const clause = canonicalFromFhir(row);
      const state = parserStateFromFhir(row);
      expect(clause.clinicalAdjuncts).toBeDefined();
      for (const reopened of [canonicalToFhir(clause), parserStateToFhir(state)]) {
        expect(getDosageCondition(reopened)).toEqual(getDosageCondition(row));
        expect(getDosageExcludedDates(reopened)).toEqual(getDosageExcludedDates(row));
        expect(getDosageExcludedWeekdays(reopened)).toEqual(getDosageExcludedWeekdays(row));
        expect(getDosageCalendarDayCondition(reopened)).toEqual(getDosageCalendarDayCondition(row));
      }
    }
  });

  it("does not restore a cleared native condition from the R5 bridge", () => {
    const row = parseSig("1 tab PO QD; HOLD if SBP <100").fhir[0];
    const edited = { ...row, condition: [] };
    expect(getDosageCondition(edited)).toBeUndefined();
    expect(canonicalFromFhir(edited).clinicalAdjuncts?.condition).toBeUndefined();
    expect(parserStateFromFhir(edited).primaryClause.clinicalAdjuncts?.condition).toBeUndefined();
  });
});


describe("nested SNOMED finding sites", () => {
  it.each([
    ["right big toe", "78883009:272741003=24028007", "right great toe"],
    ["left fifth toe", "39915008:272741003=7771000", "left fifth toe"]
  ])("retains the nested site expression for %s", (site, siteExpression, display) => {
    const expression = "22253000:363698007=(" + siteExpression + ")";
    const parsed = parseSig("1 tab PO PRN pain in " + site);
    expect(parsed.fhir[0].asNeededFor?.[0].coding?.[0]?.code).toBe(expression);
    expect(getBodySiteText(expression)).toBe(display);
    const plain = { ...parsed.fhir[0], text: undefined,
      asNeededFor: [{ coding: [{ system: "http://snomed.info/sct", code: expression }] }] };
    const imported = canonicalFromFhir(plain);
    expect(imported.prn?.reason?.text).toContain(display);
    expect(canonicalToFhir(imported).asNeededFor?.[0].coding?.[0]?.code).toBe(expression);
    expect(getBodySiteText(expression, { postcoordination: false })).toBeUndefined();
  });
});


it("imports a finding whose explicit site expression has a topographical modifier", () => {
  const expression = "22253000:363698007=(69536005:106233006=261183002)";
  expect(getBodySiteText(expression)).toBe("top of head");
  const row = { asNeededFor: [{ coding: [{ system: "http://snomed.info/sct", code: expression }] }] };
  const clause = canonicalFromFhir(row);
  expect(clause.prn?.reason?.text).toContain("top of head");
  expect(canonicalToFhir(clause).asNeededFor?.[0].coding?.[0]?.code).toBe(expression);
});


describe("standard dosage quantity coding", () => {
  it("codes physical quantities and EDQM presentation counts through R5/R6 without changing the dose", () => {
    const examples = [
      ["tab", "15054000"], ["cap", "15012000"], ["drop", "15022000"],
      ["puff", "15061000"], ["actuation", "15001000"], ["patch", "15036000"],
      ["suppository", "15051000"], ["sachet", "15045000"], ["vial", "15060000"],
      ["pen", "15037000"], ["cartridge", "15013000"], ["blister", "15007000"],
      ["bottle", "15009000"], ["ampule", "15002000"], ["syringe", "15052000"],
      ["applicatorful", "15004000"], ["swab", "15062000"]
    ];
    for (const [unit, code] of examples) {
      const clause = canonicalFromFhir({ doseAndRate: [{ doseQuantity: { value: 2, unit } }] });
      const row = canonicalToFhir(clause);
      const reopened = toFhirR5Dosages(toDosageDetails([row]))[0];
      for (const output of [row, reopened]) {
        expect(output.doseAndRate?.[0]?.doseQuantity).toEqual({
          value: 2, unit, system: "http://standardterms.edqm.eu", code
        });
      }
    }
    for (const [sig, unit, code] of [
      ["5 mcg PO QD", "mcg", "ug"], ["5 mL PO BID", "mL", "mL"],
      ["400 IU PO QD", "IU", "[iU]"], ["1 tsp PO BID", "tsp", "5.mL"]
    ]) {
      const parsed = parseSig(sig);
      for (const row of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
        expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({
          unit, system: "http://unitsofmeasure.org", code
        });
      }
    }
  });

  it("uses official EMA presentation identifiers for units absent from EDQM", () => {
    for (const [unit, code] of [
      ["spray", "200000016451"], ["dose", "200000016427"],
      ["packet", "200000016428"], ["wafer", "200000016444"],
      ["pellet", "200000016446"], ["canister", "200000022801"],
      ["ring", "200000022816"], ["troche", "200000022841"]
    ]) {
      const row = canonicalToFhir(canonicalFromFhir({
        doseAndRate: [{ doseQuantity: { value: 2, unit } }]
      }));
      const coded = row.doseAndRate?.[0]?.doseQuantity;
      expect(coded).toMatchObject({
        value: 2, unit, system: "http://spor.ema.europa.eu/v1/lists/200000000014", code
      });
      expect(toFhirR5Dosages(toDosageDetails([row]))[0].doseAndRate?.[0]?.doseQuantity)
        .toEqual(coded);
    }
  });

  it("retains the authored dose while coding exact NCIt and SNOMED presentation units", () => {
    for (const [unit, system, code] of [
      ["FTU", "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl", "C71321"],
      ["capful", "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl", "C102405"],
      ["pump", "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl", "C111984"],
      ["nebule", "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl", "C71204"],
      ["ovule", "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl", "C149756"],
      ["dropperful", "http://snomed.info/sct", "421954001"],
      ["scoop", "http://snomed.info/sct", "415505006"],
      ["pea-sized amount", "http://snomed.info/sct", "769392001"],
      ["enema", "http://snomed.info/sct", "1382282001"]
    ]) {
      const dosage = canonicalToFhir(canonicalFromFhir({
        doseAndRate: [{ doseQuantity: { value: 2, unit } }]
      }));
      const retained = toFhirR5Dosages(toDosageDetails([dosage]))[0];
      for (const row of [dosage, retained]) {
        expect(row.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit, system, code });
      }
    }
  });

  it("codes both range bounds and caps but leaves product-specific amounts unlabelled as UCUM", () => {
    const parsed = parseSig("1-2 tab PO q6h prn pain max 8 tab/day");
    const row = parsed.fhir[0];
    for (const amount of [row.doseAndRate?.[0]?.doseRange?.low, row.doseAndRate?.[0]?.doseRange?.high]) {
      expect(amount).toMatchObject({ system: "http://standardterms.edqm.eu", code: "15054000" });
    }
    expect(row.doseAndRate?.[0]?.doseRange?.high?.value).toBe(2);
    const local = canonicalToFhir(canonicalFromFhir({ doseAndRate: [{ doseQuantity: { value: 1, unit: "FTU" } }] }));
    expect(local.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 1, unit: "FTU",
      system: "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl",
      code: "C71321"
    });
  });
});


describe("retain coded condition identity while enriching exact observations", () => {
  it("preserves medication condition codes, adds LOINC for SBP, and keeps source on R5/R6 round-trips", () => {
    const parsed = parseSig("1 tab PO QD if SBP > 160");
    const condition = parsed.fhirNext.step[0].component[0].condition?.[0]!;
    expect(condition.code.coding).toEqual([
      expect.objectContaining({
        system: "urn:ezmedicationinput:CodeSystem:medication-condition",
        code: "measurement", display: "sbp"
      }),
      expect.objectContaining({ system: "http://loinc.org", code: "8480-6" })
    ]);
    const reloaded = toDosageDetails(toFhirR5Dosages(parsed.fhirNext));
    expect(reloaded.step[0].component[0].condition?.[0].code.coding)
      .toEqual(condition.code.coding);
    const general = parseSig("1 tab PO QD unless BP <90");
    const expression = general.fhirNext.step[0].component[0].condition?.[0];
    expect(expression?.code.coding).toContainEqual(expect.objectContaining({
      system: "urn:ezmedicationinput:CodeSystem:medication-condition", code: "expression"
    }));
    expect(getDosageCondition(toFhirR5Dosages(general.fhirNext)[0]))
      .toMatchObject({ kind: "not", condition: { kind: "measurement", name: "bp" } });
  });
});

describe("current FHIR R6 DosageInstruction boundary (2026-11-13 Snapshot 1)", () => {
  it("matches the pinned HL7 element hierarchy and emitted R6 wire fieldsets", () => {
    const profiles = r6SnapshotContract.profiles;
    expect(r6SnapshotContract.target).toBe("FHIR R6 6.0.0-snapshot1");
    const field = (name: keyof typeof profiles, path: string) =>
      profiles[name].elements.find(entry => entry.path === path);
    expect(field("DosageInstruction", "DosageInstruction.step.component")).toMatchObject({
      min: 1, max: "*", types: ["Dosage"]
    });
    expect(field("DosageInstruction", "DosageInstruction.step")).toMatchObject({
      types: ["Element"]
    });
    expect(field("Dosage", "Dosage.doseAndRate")).toMatchObject({ types: ["Element"] });
    expect(field("Timing", "Timing.repeat.startOffset")).toMatchObject({ max: "1", types: ["Quantity"] });
    expect(field("Timing", "Timing.repeat.endOffset")).toMatchObject({ max: "1", types: ["Quantity"] });
    expect(field("Dosage", "Dosage.sequence")).toBeUndefined();

    const permitted = (name: keyof typeof profiles, parent: string) =>
      new Set(profiles[name].elements
        .filter(entry => entry.path.startsWith(parent + ".") &&
          !entry.path.slice(parent.length + 1).includes("."))
        .flatMap(entry => {
          const fieldName = entry.path.slice(parent.length + 1);
          return fieldName.endsWith("[x]")
            ? entry.types.map(type => fieldName.slice(0, -3) + type)
            : [fieldName];
        }));
    const assertWireKeys = (value: object, keys: Set<string>) => {
      for (const key of Object.keys(value)) {
        expect(keys.has(key), `R6 wire field ${key} is absent from the pinned profile`).toBe(true);
      }
    };
    const parsed = parseSig("1 drop OD q2h for 1 week then qid for 1 month");
    assertWireKeys(parsed.fhirNext, permitted("DosageInstruction", "DosageInstruction"));
    for (const step of parsed.fhirNext.step) {
      assertWireKeys(step, permitted("DosageInstruction", "DosageInstruction.step"));
      for (const component of step.component) {
        assertWireKeys(component, permitted("Dosage", "Dosage"));
        for (const rate of component.doseAndRate ?? [])
          assertWireKeys(rate, permitted("Dosage", "Dosage.doseAndRate"));
        if (component.timing?.repeat)
          assertWireKeys(component.timing.repeat, permitted("Timing", "Timing.repeat"));
      }
    }
  });

  it("uses one DosageInstruction with concurrent components and no obsolete step/backbone fields", () => {
    const parsed = parseSig("2 tabs morning, 1 tab evening for 1 week, then 2 tabs morning for 1 month");
    const course = parsed.fhirNext;
    expect(course.step.map(step => step.component.length)).toEqual([2, 1]);
    for (const step of course.step) {
      expect(step).not.toHaveProperty("modifierExtension");
      for (const component of step.component) {
        expect(component).not.toHaveProperty("sequence");
        for (const entry of component.doseAndRate ?? []) expect(entry).not.toHaveProperty("modifierExtension");
      }
    }
    expect(fromFhir(JSON.parse(JSON.stringify(course))).fhirNext).toEqual(course);
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
  });

  it("imports R6-only period offsets and retains them through editable R5 without emitting R6 fields on R5", () => {
    const course: FhirR6DosageInstruction = {
      renderedInstruction: "One tablet daily starting day 3, for 21 days in each 28-day cycle.",
      repeatCycle: { value: 28, unit: "d", code: "d" },
      step: [{ component: [{
        timing: { repeat: {
          frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
          startOffset: { value: 2, unit: "d", code: "d" },
          endOffset: { value: 5, unit: "d", code: "d" }
        } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }]
    };
    expect(fromFhir(course).fhirNext).toEqual(course);
    const rows = toFhirR5Dosages(course);
    expect(rows).toHaveLength(1);
    expect(rows[0].timing?.repeat).not.toHaveProperty("startOffset");
    expect(rows[0].timing?.repeat).not.toHaveProperty("endOffset");
    const retained = JSON.stringify(rows[0].modifierExtension);
    expect(retained).toContain('"timingOffsets"');
    expect(retained).not.toContain('"valueTiming"');
    expect(retained).not.toContain('"startOffset":{"value"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(course);
    const edited = JSON.parse(JSON.stringify(rows)) as EzDosage[];
    edited[0].timing!.repeat!.frequency = 20;
    const adjusted = toDosageDetails(edited);
    expect(adjusted.step[0].component[0].timing?.repeat).not.toHaveProperty("startOffset");
    expect(adjusted.step[0].component[0].timing?.repeat).not.toHaveProperty("endOffset");
  });

  it("keeps R6 Quantity comparators and CodeableReference metadata without leaking them into R5", () => {
    const course: FhirR6DosageInstruction = {
      step: [{ component: [{
        site: { id: "site-one", extension: [{ url: "https://example.org/site-meta", valueString: "retained" }],
          reference: { identifier: { system: "https://example.org/body", value: "left" },
            display: "original location" } },
        doseAndRate: [{
          doseQuantity: { value: 1, comparator: "~", unit: "tab" },
          rateQuantity: { value: 4, comparator: ">=", unit: "mL/h" }
        }]
      }] }]
    };
    expect(fromFhir(course).fhirNext).toEqual(course);
    const rows = toFhirR5Dosages(course);
    expect(rows).toHaveLength(1);
    expect(rows[0].doseAndRate?.[0].doseQuantity).toBeUndefined();
    expect(rows[0].doseAndRate?.[0].rateQuantity).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(rows)).toContain('"valueCode":"~"');
    expect(formatSig(course, "long", { locale: "en" })).toContain("Dose: ~1 tab");
    expect(fromFhir(course, { locale: "en" }).items[0].longText).toContain("Dose: ~1 tab");
    expect(formatSig(course, "long", { locale: "en" })).toContain("Rate: >=4 mL/h");
    expect(fromFhir(course, { locale: "th" }).longText).toContain("~1 tab");
    expect(toDosageDetails(rows)).toEqual(course);
    const edited = cloneStructuredValue(rows);
    edited[0].doseAndRate![0].doseQuantity = { value: 2, unit: "tab" };
    const recomposed = toDosageDetails(edited);
    expect(recomposed.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual({ value: 2, unit: "tab" });
    expect(recomposed.step[0].component[0].doseAndRate?.[0].rateQuantity?.comparator).toBe(">=");
  });

  it("retains concept-only R6 site metadata independently of any cycle trigger", () => {
    const course: FhirR6DosageInstruction = {
      step: [{ component: [{
        site: { id: "site-concept", concept: { text: "left eye" },
          extension: [{ url: "https://example.org/site-provenance", valueString: "reviewed" }] },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }]
      }] }]
    };
    // Only site id/extension licenses compact R5 metadata in this first case.
    const siteOnly = toFhirR5Dosages(course);
    expect(siteOnly[0].site?.text).toBe("left eye");
    expect(siteOnly[0].modifierExtension?.length).toBeGreaterThan(0);
    expect(toDosageDetails(JSON.parse(JSON.stringify(siteOnly)))).toEqual(course);

    // Independently, R6's approximate cycle remains a typed R5 extension.
    const withCycle: FhirR6DosageInstruction = {
      ...course, repeatCycle: { value: 28, comparator: "~", code: "d", unit: "d" }
    };
    const projected = toFhirR5Dosages(withCycle);
    expect(JSON.stringify(projected)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(projected)).toContain('"valueCode":"~"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(projected)))).toEqual(withCycle);
  });

  it("supersedes unchanged imported expressions when the clinician adds numeric dose and rate choices", () => {
    const imported: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{
        doseExpression: { language: "text/fhirpath", expression: "%patient.weight*2" },
        rateExpression: { language: "text/fhirpath", expression: "4*%patient.weight" }
      }]
    }] }] };
    const rows = fromFhir(imported).fhir;
    rows[0].doseAndRate![0].doseQuantity = { value: 2, unit: "mg" };
    rows[0].doseAndRate![0].rateQuantity = { value: 4, unit: "mL/h" };
    const corrected = toDosageDetails(rows);
    expect(corrected.step[0].component[0].doseAndRate).toEqual([{
      doseQuantity: { value: 2, unit: "mg" },
      rateQuantity: { value: 4, unit: "mL/h" }
    }]);
    expect(fromFhir(corrected).fhirNext).toEqual(corrected);
    expect(corrected.extension).toContainEqual(expect.objectContaining({
      valueString: expect.stringContaining("superseded by edited R5 dose fields")
    }));

    // A different clinician-edited expression is not the old retained one.
    // Keep both authored choices available for manual correction, rather than
    // silently choosing between contradictory edits.
    const conflicting = fromFhir(imported).fhir;
    conflicting[0].doseAndRate![0].doseExpression = { expression: "%patient.weight*3" };
    conflicting[0].doseAndRate![0].doseQuantity = { value: 3, unit: "mg" };
    const unresolved = toDosageDetails(conflicting);
    expect(unresolved.step[0].component[0].doseAndRate?.[0]).toMatchObject({
      doseExpression: { expression: "%patient.weight*3" }, doseQuantity: { value: 3 }
    });
    expect(() => fromFhir(unresolved)).toThrow(/multiple dose\[x\]/);
  });

  it("executes R6 21-in-28 active-window offsets without administering during the rest days", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "d", unit: "d" },
        endOffset: { value: 5, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const anchor = "2026-11-02T00:00:00+07:00";
    const opts = { from: anchor, orderedAt: anchor, timeZone: "Asia/Bangkok", limit: 22 };
    const first = "2026-11-04T00:00:00+07:00";
    const last = "2026-11-24T00:00:00+07:00";
    const next = "2026-12-02T00:00:00+07:00";
    for (const input of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      const due = nextDueDoses(input, opts);
      expect(due).toHaveLength(22);
      expect(due[0]).toBe(first);
      expect(due[20]).toBe(last);
      expect(due[21]).toBe(next);
      expect(calculateTotalUnits({ dosage: input, ...opts,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
      expect(calculateTotalUnits({ dosage: input, ...opts,
        durationValue: 56, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
    }
    expect(fromFhir(course).fhirNext).toEqual(course);
    // Multiple interlaced tracks need their own proven shared scheduling
    // semantics, not a guessed single phase or silently ignored offsets.
    const multi: FhirR6DosageInstruction = { step: [{ component: [
      course.step[0].component[0], { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }
    ] }] };
    expect(fromFhir(multi).fhirNext).toEqual(multi);
    expect(() => nextDueDoses(multi, opts)).toThrow(/Interlaced R6 offsets/);
    expect(() => calculateTotalUnits({ dosage: multi, ...opts,
      durationValue: 28, durationUnit: FhirPeriodUnit.Day })).toThrow(/Interlaced R6 offsets/);
  });

  it("imports current R6 offset timing with incomplete tim-11/tim-12 as an editable warning", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        count: 6, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 8, unit: "d", code: "d" }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const imported = fromFhir(course);
    expect(imported.fhirNext).toEqual(course);
    expect(imported.fhir).toHaveLength(1);
    expect(imported.warnings).toEqual([expect.stringContaining("tim-11/tim-12")]);
    expect(imported.longText).toContain("Dosing starts 8 days");
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
    const execution = { from: "2026-11-02T00:00:00+07:00",
      orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 5 };
    expect(() => nextDueDoses(imported, execution)).toThrow(/R6 period offsets need/);
    expect(() => calculateTotalUnits({ dosage: course, ...execution,
      durationValue: 28, durationUnit: FhirPeriodUnit.Day })).toThrow(/R6 period offsets need/);
    // Actual invalid SimpleQuantity values still fail the current-R6 type gate.
    const malformed: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 3, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, comparator: ">" } as never } }
    }] }] };
    expect(() => fromFhir(malformed)).toThrow(/SimpleQuantity/);
  });

  it("keeps superseded R6 source provenance on the edited row, without global warning scans", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [
      { doseAndRate: [{ doseQuantity: { value: 1, comparator: "~", unit: "tab" } }] },
      { doseAndRate: [{ doseQuantity: { value: 3, unit: "tab" } }] }
    ] }] };
    const rows = toFhirR5Dosages(course);
    rows[0].doseAndRate![0].doseQuantity = { value: 2, unit: "tab" };
    const restored = toDosageDetails(rows);
    expect(restored.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual({ value: 2, unit: "tab" });
    expect(restored.step[0].component[1]).toEqual(course.step[0].component[1]);
    const sources = restored.extension?.filter(entry =>
      entry.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(sources).toHaveLength(1);
    expect(JSON.stringify(sources[0])).toContain('"valueCode":"~"');
    expect(JSON.stringify(sources[0])).toContain('"rowIndex","valueInteger":0');
    expect(JSON.stringify(sources[0])).not.toContain('"rowIndex","valueInteger":1');

    const withOffset: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const edited = toFhirR5Dosages(withOffset);
    edited[0].timing!.repeat!.frequency = 20;
    const changed = toDosageDetails(edited);
    expect(changed.step[0].component[0].timing?.repeat?.startOffset).toBeUndefined();
    const offsetSources = changed.extension?.filter(entry =>
      entry.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(offsetSources).toHaveLength(1);
    expect(JSON.stringify(offsetSources[0])).toContain('"startOffset"');
    expect(JSON.stringify(offsetSources[0])).toContain('"value":2');
    expect(changed.extension).toContainEqual(expect.objectContaining({
      valueString: expect.stringContaining("original R6 values remain available")
    }));
  });

  it("shows source-less R6 active-window offsets in EN/TH instead of false whole-period cadence", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, unit: "d", code: "d" },
        endOffset: { value: 5, unit: "d", code: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const en = formatSig(course, "long", { locale: "en" });
    expect(en).toContain("21 administrations per 28 days");
    expect(en).toContain("Dosing starts 2 days after");
    expect(en).toContain("No doses during the final 5 days");
    expect(en).not.toContain("1 tablet every 28 days");
    const th = formatSig(course, "long", { locale: "th" });
    expect(th).toContain("ให้ยา 21 ครั้งต่อช่วง 28 วัน");
    expect(th).toContain("เริ่มให้ยาหลังเริ่มรอบ 2 วัน");
    expect(th).toContain("งดยาในช่วง 5 วันสุดท้าย");
    expect(fromFhir(course, { locale: "en" }).items[0].longText).toBe(en);
    expect(fromFhir(course, { locale: "th" }).items[0].longText).toBe(th);
    const authored = { ...course, renderedInstruction: "Take as directed by prescriber." };
    expect(formatSig(authored, "long")).toBe(authored.renderedInstruction);
  });

  it("does not restore approximate quantities over a clinician's new dose/rate expressions", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{
        doseQuantity: { value: 1, comparator: "~", unit: "tab" },
        rateQuantity: { value: 4, comparator: ">=", unit: "mL/h" }
      }]
    }] }] };
    const edited = toFhirR5Dosages(course);
    edited[0].doseAndRate![0].doseExpression = {
      language: "text/fhirpath", expression: "%patient.weight"
    };
    edited[0].doseAndRate![0].rateExpression = {
      language: "text/fhirpath", expression: "%patient.weight / 2"
    };
    const restored = toDosageDetails(edited);
    expect(restored.step[0].component[0].doseAndRate).toEqual([{
      doseExpression: { language: "text/fhirpath", expression: "%patient.weight" },
      rateExpression: { language: "text/fhirpath", expression: "%patient.weight / 2" }
    }]);
    const retained = restored.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(retained).toHaveLength(1);
    expect(JSON.stringify(retained)).toContain('"valueCode":"~"');
    expect(JSON.stringify(retained)).toContain('"comparator":">="');
    expect(fromFhir(restored).fhirNext).toEqual(restored);
  });

  it("renders R6-only component quantities even when the enclosing course has authored wording", () => {
    const course: FhirR6DosageInstruction = {
      renderedInstruction: "Follow the clinician's written taper.",
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, comparator: "~", unit: "tab" } }]
      }] }]
    };
    const imported = fromFhir(course);
    expect(imported.longText).toBe(course.renderedInstruction);
    expect(imported.items[0].longText).toContain("~1 tab");
    expect(imported.items[0].shortText).toContain("~1 tab");
    // A component's own source is authoritative for its individual editor row.
    const sourced: FhirR6DosageInstruction = {
      ...course, step: [{ component: [{
        ...course.step[0].component[0], text: "Approximately one tablet as directed."
      }] }]
    };
    expect(fromFhir(sourced).items[0].longText).toBe("Approximately one tablet as directed.");
  });

  it("executes offset-trimmed weekly R6 schedules on the authored weekdays, not distributed intervening days", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Week,
        dayOfWeek: ["mon", "wed", "fri"],
        endOffset: { value: 2, unit: "d", code: "d" }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const from = "2026-11-02T08:00:00+07:00";
    const options = { from, orderedAt: from, timeZone: "Asia/Bangkok", limit: 6 };
    const expected = [
      "2026-11-02T08:00:00+07:00",
      "2026-11-04T08:00:00+07:00",
      "2026-11-06T08:00:00+07:00",
      "2026-11-09T08:00:00+07:00",
      "2026-11-11T08:00:00+07:00",
      "2026-11-13T08:00:00+07:00"
    ];
    for (const value of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      expect(nextDueDoses(value, options)).toEqual(expected);
      expect(calculateTotalUnits({
        dosage: value, ...options, durationValue: 14, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(6);
    }
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
  });

  it("accepts current R6 text-only wire input without a step array", () => {
    // HL7 Snapshot 1 DosageInstruction.step has cardinality 0..*.
    const input = { renderedInstruction: "Take as directed" };
    const result = fromFhir(input);
    expect(result.count).toBe(0);
    expect(result.fhir).toEqual([]);
    expect(result.fhirNext.step).toEqual([]);
    expect(result.fhirNext.renderedInstruction).toBe(input.renderedInstruction);
    expect(result.longText).toBe(input.renderedInstruction);
    expect(result.warnings).toEqual([]);
  });

  it("retains the original concept-only site wrapper when an R5 site is corrected", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      site: {
        id: "source-left", concept: { text: "left eye" },
        extension: [{ url: "https://example.org/site-source", valueString: "original" }]
      },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }]
    }] }] };
    const rows = toFhirR5Dosages(source);
    rows[0].site = { text: "right eye" };
    const rebuilt = toDosageDetails(rows);
    expect(rebuilt.step[0].component[0].site?.concept?.text).toBe("right eye");
    const retained = rebuilt.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(retained).toHaveLength(1);
    expect(JSON.stringify(retained)).toContain("source-left");
    expect(JSON.stringify(retained)).toContain("left eye");
    expect(JSON.stringify(retained)).toContain("site-source");
    expect(fromFhir(rebuilt).fhirNext.step[0].component[0].site?.concept?.text).toBe("right eye");
  });

  it("honors explicitly authored twice-daily clocks for 42 doses/21 days in R5 and offset R6", () => {
    const base = "2026-11-02T00:00:00+07:00";
    const options = { from: base, orderedAt: base, timeZone: "Asia/Bangkok", limit: 44 };
    const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const repeat = {
      frequency: 42, period: 21, periodUnit: FhirPeriodUnit.Day,
      timeOfDay: ["08:00:00", "20:00:00"]
    };
    const expectedFirst = [
      "2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00",
      "2026-11-03T08:00:00+07:00", "2026-11-03T20:00:00+07:00"
    ];
    const standalone: EzDosage = { ...dose, timing: { repeat } };
    expect(nextDueDoses(standalone, options).slice(0, 4)).toEqual(expectedFirst);

    const offsetCourse: FhirR6DosageInstruction = { step: [{ component: [{
      ...dose, timing: { repeat: {
        ...repeat, period: 28, endOffset: { value: 7, unit: "d", code: "d" }
      } }
    }] }] };
    for (const value of [offsetCourse, toFhirR5Dosages(offsetCourse), fromFhir(offsetCourse)]) {
      const due = nextDueDoses(value, options);
      expect(due.slice(0, 4)).toEqual(expectedFirst);
      expect(due[40]).toBe("2026-11-22T08:00:00+07:00");
      expect(due[41]).toBe("2026-11-22T20:00:00+07:00");
      expect(due.slice(42, 44)).toEqual([
        "2026-11-30T08:00:00+07:00", "2026-11-30T20:00:00+07:00"
      ]);
      expect(calculateTotalUnits({
        dosage: value, ...options, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(42);
    }
  });

  it("keeps R6 active-window offsets when an R5 clinician adds a clock without changing the period", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "d", unit: "d" },
        endOffset: { value: 5, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const rows = toFhirR5Dosages(course);
    rows[0].timing!.repeat!.timeOfDay = ["08:00:00"];
    const restored = toDosageDetails(rows);
    expect(restored.step[0].component[0].timing?.repeat).toEqual({
      ...course.step[0].component[0].timing!.repeat,
      timeOfDay: ["08:00:00"]
    });
    expect(restored.extension?.some(value =>
      value.url.includes("medication-course-reconciliation-warning"))).not.toBe(true);
    // Editing the cadence itself is different: stale offsets must not
    // silently become executable under a new period.
    rows[0].timing!.repeat!.period = 21;
    const changedPeriod = toDosageDetails(rows);
    expect(changedPeriod.step[0].component[0].timing?.repeat?.startOffset).toBeUndefined();
    expect(changedPeriod.extension?.some(value =>
      value.url.includes("medication-course-reconciliation-source"))).toBe(true);
  });

  it("displays native R6 offset frequency and period maxima as ranges, not exact counts", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, frequencyMax: 42,
        period: 28, periodMax: 30, periodUnit: FhirPeriodUnit.Day,
        endOffset: { value: 7, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const en = formatSig(course, "long", { locale: "en" });
    const th = formatSig(course, "long", { locale: "th" });
    expect(en).toContain("21–42 administrations per 28–30 days");
    expect(en).toContain("No doses during the final 7 days");
    expect(en).not.toContain("21 administrations per 28 days");
    expect(th).toContain("21–42 ครั้งต่อช่วง 28–30 วัน");
    expect(fromFhir(course, { locale: "en" }).items[0].longText).toContain("21–42");
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
  });

  it("keeps authored 08:00/20:00 wall clocks through New York fall DST and later calendar cycles", () => {
    const from = "2026-10-26T00:00:00-04:00";
    const options = { from, orderedAt: from, timeZone: "America/New_York", limit: 56 };
    const component: EzDosage = {
      timing: { repeat: {
        frequency: 42, period: 21, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"]
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const regular = nextDueDoses(component, options);
    expect(regular.slice(0, 2)).toEqual([
      "2026-10-26T08:00:00-04:00", "2026-10-26T20:00:00-04:00"
    ]);
    expect(regular.slice(12, 14)).toEqual([
      "2026-11-01T08:00:00-05:00", "2026-11-01T20:00:00-05:00"
    ]);
    expect(regular.slice(40, 44)).toEqual([
      "2026-11-15T08:00:00-05:00", "2026-11-15T20:00:00-05:00",
      "2026-11-16T08:00:00-05:00", "2026-11-16T20:00:00-05:00"
    ]);
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      ...component,
      timing: { repeat: { ...component.timing!.repeat!,
        period: 28, endOffset: { value: 7, unit: "d", code: "d" }
      } }
    }] }] };
    for (const input of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      const due = nextDueDoses(input, options);
      expect(due.slice(12, 14)).toEqual([
        "2026-11-01T08:00:00-05:00", "2026-11-01T20:00:00-05:00"
      ]);
      expect(due.slice(40, 44)).toEqual([
        "2026-11-15T08:00:00-05:00", "2026-11-15T20:00:00-05:00",
        "2026-11-23T08:00:00-05:00", "2026-11-23T20:00:00-05:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
    }
  });

  it("keeps R6 day-cycle administration and supply after a New York spring-forward gap", () => {
    // The 28-day calendar boundary on Mar 14 2027 is a nonexistent 02:30.
    // A calendar course must not stop; later cycles retain their original
    // 02:30 anchor rather than drift to 03:30 indefinitely.
    const start = "2027-02-14T02:30:00-05:00";
    const relative = (days: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event",
        code: "treatment-start"
      }] },
      offsetDuration: { value: days, unit: "d", code: "d",
        system: "http://unitsofmeasure.org" }
    });
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, unit: "d", code: "d" },
      step: [{
        start: relative(0), end: relative(1),
        component: [{
          timing: { repeat: { frequency: 1, period: 1,
            periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
        }]
      }]
    };
    const options = { from: start, orderedAt: start,
      timeZone: "America/New_York", limit: 4 };
    const expected = [
      "2027-02-14T08:00:00-05:00",
      "2027-03-14T08:00:00-04:00",
      "2027-04-11T08:00:00-04:00",
      "2027-05-09T08:00:00-04:00"
    ];
    for (const input of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      expect(nextDueDoses(input, options)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 85, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
    }
  });

  it("keeps calendar cycles past midnight DST gaps and distinguishes elapsed q24h", () => {
    // Santiago advances from 00:00 straight to 01:00 on Sep 6, 2026.
    const anchor = "2026-08-09T00:00:00-04:00";
    const options = { from: anchor, orderedAt: anchor,
      timeZone: "America/Santiago", limit: 58 };
    const dosage: EzDosage = {
      timing: { repeat: { frequency: 28, period: 28,
        periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const due = nextDueDoses(dosage, options);
    expect(due).toHaveLength(58);
    expect(due[27]).toBe("2026-09-05T08:00:00-04:00");
    expect(due[28]).toBe("2026-09-06T08:00:00-03:00");
    expect(due[56]).toBe("2026-10-04T08:00:00-03:00");

    // FHIR timeOfDay is a wall-clock instruction. By contrast, every 24
    // elapsed hours is an interval whose local time shifts after spring DST.
    const newYork = { from: "2026-03-07T08:00:00-05:00",
      orderedAt: "2026-03-07T08:00:00-05:00",
      timeZone: "America/New_York", limit: 3 };
    expect(nextDueDoses({
      timing: { repeat: { frequency: 1, period: 24,
        periodUnit: FhirPeriodUnit.Hour } }
    }, newYork)).toEqual([
      "2026-03-07T08:00:00-05:00",
      "2026-03-08T09:00:00-04:00",
      "2026-03-09T09:00:00-04:00"
    ]);
    expect(nextDueDoses({
      timing: { repeat: { frequency: 1, period: 1,
        periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } }
    }, newYork)).toEqual([
      "2026-03-07T08:00:00-05:00",
      "2026-03-08T08:00:00-04:00",
      "2026-03-09T08:00:00-04:00"
    ]);
  });

  it("imports only the current R6 shape and enforces the published Element and choice constraints", () => {
    const base = parseSig("1 tab PO qd").fhirNext;
    const invalid = [
      { ...base, resourceType: "DosageDetails" },
      { ...base, step: [{ component: [] }] },
      { ...base, step: [{ ...base.step[0], modifierExtension: [] }] },
      { ...base, step: [{ component: [{ ...base.step[0].component[0], sequence: 1 }] }] },
      { ...base, step: [{ component: [{ ...base.step[0].component[0], doseAndRate: [{ doseQuantity: { value: 1 }, doseExpression: { expression: "1" } }] }] }] },
      { ...base, step: [{ component: base.step[0].component, safety: { ifExceeded: "stop" } }] }
    ];
    for (const example of invalid) {
      expect(() => fromFhir(example as FhirR6DosageInstruction)).toThrow(/FHIR R6 DosageInstruction/);
    }
    expect(fromFhir({ renderedInstruction: "Directions supplied as text only.", step: [] }).count).toBe(0);
  });
});
