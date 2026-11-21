import { decodeR5RetainedFields } from "../src/dosage-course";
import { equalStructuredValues, cloneStructuredValue } from "../src/stable-structure";
import { describe, expect, it } from "vitest";
import conditionalDoseProfile from "../fhir/r5/medication-conditional-dose.json";
import renderedInstructionProfile from "../fhir/r5/medication-rendered-instruction.json";
import conditionLogicProfile from "../fhir/r6/medication-r6-condition-logic.json";
import r6SnapshotContract from "../fhir/r6/official-snapshot1-20261113-contract.json";
import {
  parseSig, parseSigAsync, fromFhir, fromFhirDosage, formatSig, formatSigBatch, formatParseBatch,
  importCanonicalCourse,
  nextDueDoses, calculateTotalUnits, getEmaQuantityComparator,
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM,
  toDosageDetails, toFhirR5Dosages, toEzDosages, fromDosageDetails,
  getBodySiteText, evaluateMedicationCondition, setDosageCondition, getDosageCondition,
  type FhirR6DosageInstruction, type FhirDosage, type FhirExtension, type EzDosage, type MedicationCondition,
  EventTiming, FhirPeriodUnit
} from "../src/index";
import {
  canonicalFromFhir, canonicalToFhir, parserStateFromFhir, TIMING_ACTIVITY_WINDOW_EXTENSION_URL, getTimingClocks,
  toFhir as parserStateToFhir, getAdministrationOffsetMinutes, ADMINISTRATION_OFFSET_EXTENSION_URL,
  buildInfusionCarrierMaterialStructureDefinition
} from "../src/fhir";
import { parseMedicationGuard } from "../src/medication-condition";
import {
  setDosageExcludedDates, getDosageExcludedDates, getDosageExcludedWeekdays, getDosageCalendarDayCondition,
  DOSAGE_ALTERNATIVE_CHOICE_URL, getDosageAlternativeChoice,
  setDosageAlternativeChoice, buildDosageAlternativeChoiceStructureDefinition
} from "../src/dosage-course";

import { COURSE_CYCLE_COUNT_EXTENSION_URL } from "../src/fhir-course-cycle-count";
import { getQuantityComparator, quantityForR5, quantityFromR5, simpleQuantityForR5 } from "../src/fhir-quantity-operator";

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
    expect(formatSig(imported.fhirNext, "long")).toMatch(/every 2 hours[\s\S]*four times daily[\s\S]*twice daily/iu);
    expect(imported.fhirNext.renderedInstruction).toBe(original.renderedInstruction);
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

  it("retains approximate R6 safety as an active R5 numeric maximum with EMA Coding", () => {
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
    expect(r5[0].maxDosePerAdministration).toMatchObject({
      value: 5, unit: "mg", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM,
          code: "100000000055" }
      }]
    });
    expect(r5[0].maxDosePerAdministration?.comparator).toBeUndefined();
    expect(r5[0].maxDosePerPeriod?.[0]?.numerator.comparator).toBe("ad");
    expect(toDosageDetails(r5)).toEqual(original);
    // The numeric maximum stays live in R5 while its original R6 safety
    // semantics remain retained in the course source.
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
    expect(getTimingClocks(repeat)).toEqual(["08:00:00"]);
    expect(repeat?.timeOfDay).toBeUndefined();
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
      expect(formatSig(input, "long", { locale: "en" })).toContain("From treatment start until 7 days after treatment start");
      expect(formatSig(input, "long", { locale: "en" })).toContain("From 7 days after treatment start until 14 days after treatment start");
      expect(formatSig(input, "long", { locale: "th" })).toContain("ตั้งแต่เริ่มการรักษาจนถึง7 วันหลังเริ่มการรักษา");
      expect(formatSig(input, "long", { locale: "th" })).toContain("ตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา");
    }
    expect(formatSigBatch(toFhirR5Dosages(course), "long", { locale: "en" }))
      .toContain("From 7 days after treatment start until 14 days after treatment start");
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
      expect(en).toContain("No doses from 7 days after treatment start until 14 days after treatment start");
      expect(en).toContain("From 14 days after treatment start until 21 days after treatment start");
      expect(th).toContain("งดยาตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา");
      expect(th).toContain("ตั้งแต่14 วันหลังเริ่มการรักษาจนถึง21 วันหลังเริ่มการรักษา");
    }
    expect(formatSigBatch(toFhirR5Dosages(course), "long", { locale: "en" }))
      .toContain("No doses from 7 days after treatment start until 14 days after treatment start");
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
      .toContain("2 days after dialysis");
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
      expect(en).toContain("from each cycle start");
      expect(en).toContain("No doses from 7 days after treatment start until 14 days after treatment start");
      expect(th).toContain("ทุก 14 วัน");
      expect(th).toContain("จากจุดเริ่มต้นของแต่ละรอบ");
      expect(th).toContain("งดยาตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา");
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
      expect(text).toContain("No doses from 10 days after treatment start until 14 days after treatment start");
      expect(text).not.toContain("No doses from 7 days after treatment start until 14 days after treatment start");
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
        for (const match of en.matchAll(/No doses from (\d+) days? after treatment start until (\d+) days? after treatment start/gu)) {
          for (let day = Number(match[1]); day < Number(match[2]); day++) stated.push(day + 1);
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
      expect(en).toContain("From 7 days after treatment start until 21 days after treatment start");
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
        expect(text).toContain(locale === "th" ? "ตั้งแต่เริ่มการรักษาจนถึง7 วันหลังเริ่มการรักษา" : "From treatment start until 7 days after treatment start");
        expect(text).toContain(locale === "th" ? "ตั้งแต่14 วันหลังเริ่มการรักษาจนถึง21 วันหลังเริ่มการรักษา" : "From 14 days after treatment start until 21 days after treatment start");
        expect(text).toContain(locale === "th" ? "งดยาตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา" : "No doses from 7 days after treatment start until 14 days after treatment start");
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
    expect(text).toContain("From treatment start until 7 days after treatment start");
    // Two seven-day stage iterations fill the entire fourteen-day cycle.
    expect(text).not.toContain("No doses");
    expect(text).toMatch(/14 days/);
    expect(text).toContain("Perform this phase 2 times");
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

it("normalizes editable R5 and R6 course previews while retaining original wording", () => {
  const source = "1 drop OD q2h x1wk then qid x1wk";
  const parsed = parseSig(source);
  const r5 = toFhirR5Dosages(parsed.fhirNext);
  const text = formatSigBatch(r5, "long");
  expect(text).toMatch(/every 2 hours[\s\S]*four times daily/iu);
  expect(text).toContain("right eye");
  expect(formatSig(parsed.fhirNext, "long")).toMatch(/every 2 hours[\s\S]*four times daily/iu);
  expect(parsed.fhirNext.renderedInstruction).toBe(source);
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
    expect(restored.step.map(step => step.component.length)).toEqual([2, 2]);
    expect(importCanonicalCourse(restored).stages.map(stage => stage.administrations.length)).toEqual([0, 2, 2]);
    expect(restored.step[0].start?.offsetDuration?.value).toBe(7);
    expect(restored.step[1].start?.offsetDuration?.code).toBe("mo");
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
    expect(restored.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(restored.step[0].start).toEqual(day(7));
    expect(importCanonicalCourse(restored).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    expect(() => formatSig(restored, "long")).not.toThrow();
    // Strict R6 omits the missing phase, while its source extension reopens
    // the draft and still carries the unresolved shared course context.
    expect(() => fromFhir(restored)).not.toThrow();
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
    const projected = toDosageDetails(remaining);
    expect(projected.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(importCanonicalCourse(projected).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    expect(() => nextDueDoses(remaining, options)).toThrow(/complete dosage array/);
    expect(() => calculateTotalUnits({ ...options, dosage: remaining, durationValue: 14, durationUnit: "d" })).toThrow(/complete dosage array/);
  });

  it("preserves an incomplete R5 phase as an editable draft behind valid R6 steps", () => {
    const source: FhirR6DosageInstruction = { step: [
      { end: day(7), component: [component(2)] },
      { start: day(7), end: day(14), component: [component()] }
    ] };
    const rows = toFhirR5Dosages(source).slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence).toBe(2);
    const incomplete = toDosageDetails(rows);
    expect(incomplete.step).toHaveLength(1);
    expect(incomplete.step[0].component[0]).toMatchObject({ doseAndRate: [{ doseQuantity: { value: 1 } }] });
    expect(incomplete.step[0].start).toEqual(day(7));
    expect(importCanonicalCourse(incomplete).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    expect(() => fromFhir(incomplete)).not.toThrow();
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
    expect(profiles.Timing.constraints).toContainEqual({ path: "Timing.repeat", key: "tim-10",
      severity: "error", expression: "timeOfDay.empty() or when.empty()" });
    const field = (name: keyof typeof profiles, path: string) =>
      profiles[name].elements.find(entry => entry.path === path);
    expect(field("DosageInstruction", "DosageInstruction.step.component")).toMatchObject({
      min: 1, max: "*", types: ["Dosage"]
    });
    expect(field("DosageInstruction", "DosageInstruction.step")).toMatchObject({
      types: ["Element"]
    });
    expect(field("Dosage", "Dosage.doseAndRate")).toMatchObject({ types: ["Element"] });
    expect(field("Timing", "Timing.repeat.startOffset")).toMatchObject({ max: "1", types: ["Quantity"],
      typeProfiles: { Quantity: ["http://hl7.org/fhir/StructureDefinition/SimpleQuantity"] } });
    expect(field("Timing", "Timing.repeat.endOffset")).toMatchObject({ max: "1", types: ["Quantity"],
      typeProfiles: { Quantity: ["http://hl7.org/fhir/StructureDefinition/SimpleQuantity"] } });
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
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[0].component).toHaveLength(1);
    expect(parsed.fhirNext.step[1].component).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component[0].timing?.repeat).toMatchObject({ period: 2, periodUnit: "h" });
    expect(parsed.fhirNext.step[1].component[0].timing?.repeat).toMatchObject({ frequency: 4, period: 1, periodUnit: "d" });
    for (const step of parsed.fhirNext.step) {
      expect(step.component[0].doseAndRate).toEqual([{ doseQuantity: expect.objectContaining({ value: 1, unit: "drop" }) }]);
      expect(step.component[0].site?.concept?.coding).toContainEqual(expect.objectContaining({
        system: "http://snomed.info/sct", code: "1290032005",
      }));
    }
    assertWireKeys(parsed.fhirNext, permitted("DosageInstruction", "DosageInstruction"));
    for (const step of parsed.fhirNext.step) {
      assertWireKeys(step, permitted("DosageInstruction", "DosageInstruction.step"));
      for (const component of step.component) {
        assertWireKeys(component, permitted("Dosage", "Dosage"));
        for (const rate of component.doseAndRate ?? []) {
          assertWireKeys(rate, permitted("Dosage", "Dosage.doseAndRate"));
          expect(["doseQuantity", "doseRange", "doseExpression"].filter(key =>
            Object.prototype.hasOwnProperty.call(rate, key))).toHaveLength(1);
          expect(["rateQuantity", "rateRange", "rateRatio", "rateExpression"].filter(key =>
            Object.prototype.hasOwnProperty.call(rate, key)).length).toBeLessThanOrEqual(1);
        }
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
    expect(adjusted.step[0].component[0].timing?.repeat).toEqual({
      ...course.step[0].component[0].timing!.repeat, frequency: 20,
    });
    expect(adjusted.step[0].component[0].timing?.repeat).toMatchObject({
      period: 28, periodUnit: FhirPeriodUnit.Day,
      startOffset: { value: 2, code: "d" }, endOffset: { value: 5, code: "d" },
    });
  });

  it("keeps scalar qualifiers and CodeableReference metadata through both FHIR projections", () => {
    const course: FhirR6DosageInstruction = {
      step: [{ component: [{
        site: { id: "site-one", extension: [{ url: "https://example.org/site-meta", valueString: "retained" }],
          reference: { identifier: { system: "https://example.org/body", value: "left" },
            display: "original location" } },
        doseAndRate: [{
          doseQuantity: simpleQuantityForR5({ value: 1, comparator: "~", unit: "tab" })!,
          rateQuantity: simpleQuantityForR5({ value: 4, comparator: ">=", unit: "mL/h" })!
        }]
      }] }]
    };
    expect(fromFhir(course).fhirNext).toEqual(course);
    const rows = toFhirR5Dosages(course);
    expect(rows).toHaveLength(1);
    expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({
      value: 1, unit: "tab", extension: [expect.objectContaining({
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008",
          code: "100000000055" }
      })]
    });
    expect(rows[0].doseAndRate?.[0].rateQuantity).toMatchObject({
      value: 4, unit: "mL/h", extension: [expect.objectContaining({
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008",
          code: "100000000053" }
      })]
    });
    expect(JSON.stringify(rows)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(rows)).toContain('"100000000055"');
    expect(formatSig(course, "long", { locale: "en" })).toContain("approximately 1 tablet");
    expect(fromFhir(course, { locale: "en" }).items[0].longText).toContain("approximately 1 tablet");
    expect(formatSig(course, "long", { locale: "en" })).toContain("Rate: >=4 mL/h");
    expect(fromFhir(course, { locale: "th" }).longText).toContain("ประมาณ 1 เม็ด");
    expect(toDosageDetails(rows)).toEqual(course);
    const edited = cloneStructuredValue(rows);
    edited[0].doseAndRate![0].doseQuantity = { value: 2, unit: "tab" };
    const recomposed = toDosageDetails(edited);
    expect(recomposed.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual({ value: 2, unit: "tab" });
    expect(getQuantityComparator(recomposed.step[0].component[0].doseAndRate?.[0].rateQuantity)).toBe(">=");
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
    expect(JSON.stringify(projected)).toContain('"100000000055"');
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
    const unresolvedAmount = unresolved.step[0].component[0].doseAndRate![0];
    expect(unresolvedAmount.doseQuantity).toBeUndefined();
    expect(unresolvedAmount.doseExpression).toBeUndefined();
    expect(unresolvedAmount.extension).toContainEqual({
      url: "urn:ezmedicationinput:r6-unresolved-dose-source", extension: [
        { url: "doseQuantity", valueQuantity: { value: 3, unit: "mg" } },
        { url: "doseExpression", valueExpression: { expression: "%patient.weight*3" } },
      ],
    });
    expect(() => fromFhir(unresolved)).not.toThrow();
    expect(fromFhir(JSON.parse(JSON.stringify(unresolved))).fhirNext.step[0].component[0].doseAndRate![0])
      .toEqual(unresolvedAmount);
    expect(conflicting[0].doseAndRate![0]).toMatchObject({
      doseExpression: { expression: "%patient.weight*3" }, doseQuantity: { value: 3 },
    });
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
    const expected = [
      "2026-11-04T00:00:00+07:00",
      "2026-11-05T00:00:00+07:00",
      "2026-11-06T00:00:00+07:00",
      "2026-11-07T00:00:00+07:00",
      "2026-11-08T00:00:00+07:00",
      "2026-11-09T00:00:00+07:00",
      "2026-11-10T00:00:00+07:00",
      "2026-11-11T00:00:00+07:00",
      "2026-11-12T00:00:00+07:00",
      "2026-11-13T00:00:00+07:00",
      "2026-11-14T00:00:00+07:00",
      "2026-11-15T00:00:00+07:00",
      "2026-11-16T00:00:00+07:00",
      "2026-11-17T00:00:00+07:00",
      "2026-11-18T00:00:00+07:00",
      "2026-11-19T00:00:00+07:00",
      "2026-11-20T00:00:00+07:00",
      "2026-11-21T00:00:00+07:00",
      "2026-11-22T00:00:00+07:00",
      "2026-11-23T00:00:00+07:00",
      "2026-11-24T00:00:00+07:00",
      "2026-12-02T00:00:00+07:00",
    ];
    for (const input of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      const due = nextDueDoses(input, opts);
      expect(due).toEqual(expected);
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
      { doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, comparator: "~", unit: "tab" })! }] },
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
    expect(JSON.stringify(sources[0])).toContain('"100000000055"');
    expect(JSON.stringify(sources[0])).toContain('"rowIndex","valueInteger":0');
    expect(JSON.stringify(sources[0])).not.toContain('"rowIndex","valueInteger":1');

    const withOffset: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const edited = toFhirR5Dosages(withOffset);
    edited[0].timing!.repeat!.period = 30;
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
    expect(formatSig(authored, "long")).toBe(en);
    expect(fromFhir(authored).fhirNext.renderedInstruction).toBe(authored.renderedInstruction);
  });

  it("does not restore approximate quantities over a clinician's new dose/rate expressions", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{
        doseQuantity: simpleQuantityForR5({ value: 1, comparator: "~", unit: "tab" })!,
        rateQuantity: simpleQuantityForR5({ value: 4, comparator: ">=", unit: "mL/h" })!
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
    expect(JSON.stringify(retained)).toContain('"100000000055"');
    expect(JSON.stringify(retained)).toContain('"100000000053"');
    expect(fromFhir(restored).fhirNext).toEqual(restored);
  });

  it("renders R6-only component quantities even when the enclosing course has authored wording", () => {
    const course: FhirR6DosageInstruction = {
      renderedInstruction: "Follow the clinician's written taper.",
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, comparator: "~", unit: "tab" })! }]
      }] }]
    };
    const imported = fromFhir(course);
    expect(imported.longText).toContain("approximately 1 tablet");
    expect(imported.fhirNext.renderedInstruction).toBe(course.renderedInstruction);
    expect(imported.items[0].longText).toContain("approximately 1 tablet");
    expect(imported.items[0].shortText).toMatch(/~1\s*(?:tab|tablet)/u);
    // Component text remains source evidence while current quantity facts own the preview.
    const sourced: FhirR6DosageInstruction = {
      ...course, step: [{ component: [{
        ...course.step[0].component[0], text: "Approximately one tablet as directed."
      }] }]
    };
    expect(fromFhir(sourced).items[0].longText).toContain("approximately 1 tablet");
    expect(fromFhir(sourced).fhirNext.step[0].component[0].text).toBe("Approximately one tablet as directed.");
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

  it("preserves R6 text-only wire input through its usable R5 output", () => {
    // HL7 Snapshot 1 DosageInstruction.step is 0..*: an instruction is
    // meaningful even without a structured administration component.
    const input = { renderedInstruction: "Take as directed" };
    const result = fromFhir(input);
    expect(result.count).toBe(1);
    expect(result.fhir).toHaveLength(1);
    expect(result.fhir[0].text).toBe(input.renderedInstruction);
    expect(result.fhir[0].doseAndRate).toBeUndefined();
    expect(result.fhirNext.step).toBeUndefined();
    expect(result.fhirNext.renderedInstruction).toBe(input.renderedInstruction);
    expect(result.longText).toBe(input.renderedInstruction);
    expect(toDosageDetails(result.fhir)).toEqual(result.fhirNext);
    expect(result.warnings).toEqual([]);
  });

  it("round-trips valid zero-step R6 course-only metadata without inventing an active dose", () => {
    const source: FhirR6DosageInstruction = {
      id: "course-note", renderedInstruction: "Call clinic for dose",
      extension: [{ url: "https://example.org/unknown-course", valueBoolean: false }],
      safety: { doseLimit: [{ scope: "administration",
        valueQuantity: { value: 5, unit: "mg", comparator: "~" } }] }
    };
    const rows = toFhirR5Dosages(source);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(source.renderedInstruction);
    expect(rows[0].doseAndRate).toBeUndefined();
    expect(rows[0].timing).toBeUndefined();
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(source);
    // Ordinary R5 persistence adapters often write empty arrays for
    // absent fields. They must not turn a course-only metadata carrier
    // into a phantom administration stage.
    const normalized = [{
      ...rows[0], doseAndRate: [], additionalInstruction: [],
      sequence: undefined, timing: undefined, asNeeded: undefined,
      safety: undefined, maxDosePerAdministration: undefined
    }];
    expect(toDosageDetails(normalized)).toEqual(source);
    // Once the clinician adds a real dose, it is an actual new stage,
    // not an empty metadata carrier. The former R6 source stays retained.
    const withNewDose = [{
      ...normalized[0], doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }];
    const afterAddingDose = toDosageDetails(withNewDose);
    expect(afterAddingDose.step[0].component[0].doseAndRate?.[0].doseQuantity?.value)
      .toBe(1);
    expect(JSON.stringify(afterAddingDose.extension)).toContain("Call clinic for dose");
    const batch = fromFhir(source);
    expect(batch.fhir).toHaveLength(1);
    expect(toDosageDetails(batch.fhir)).toEqual(source);
    const edited = JSON.parse(JSON.stringify(rows));
    edited[0].text = "Corrected directions";
    const afterEdit = toDosageDetails(edited);
    expect(afterEdit.renderedInstruction).toBe("Corrected directions");
    expect(afterEdit.step).toBeUndefined();
    expect(afterEdit.safety).toEqual(source.safety);
    expect(JSON.stringify(afterEdit.extension)).toContain("Call clinic for dose");
    expect(toFhirR5Dosages({ step: [] })).toEqual([]);
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
    const earlyClock = JSON.parse(JSON.stringify(course)) as FhirR6DosageInstruction;
    const repeat = earlyClock.step![0].component[0].timing!.repeat!;
    repeat.frequency = 2;
    repeat.timeOfDay = ["03:15:00", "08:00:00"];
    // 03:15 is before March's gap-adjusted 03:30 origin, but after April's
    // restored 02:30 origin. Permanent anchor drift would lose April's dose.
    const expectedEarly = [
      "2027-02-14T03:15:00-05:00", "2027-02-14T08:00:00-05:00",
      "2027-03-14T08:00:00-04:00",
      "2027-04-11T03:15:00-04:00", "2027-04-11T08:00:00-04:00",
      "2027-05-09T03:15:00-04:00", "2027-05-09T08:00:00-04:00"
    ];
    for (const input of [earlyClock, toFhirR5Dosages(earlyClock), fromFhir(earlyClock)]) {
      expect(nextDueDoses(input, { ...options, limit: expectedEarly.length })).toEqual(expectedEarly);
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 85, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
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

  it("matches R6-only dose choices by distinct entry identity across removal and reordering", () => {
    for (const identity of ["id", "type"] as const) {
      const entry = (name: string, amount: number) => ({
        ...(identity === "id" ? { id: name } :
          { type: { coding: [{ code: name }] } }),
        doseQuantity: simpleQuantityForR5({ value: amount, unit: "mg", comparator: "~" as const })!
      });
      const course: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [entry("calc", 10), entry("ordered", 5)]
      }] }] };
      const rows = toFhirR5Dosages(course);
      rows[0].doseAndRate!.shift();
      const restored = toDosageDetails(rows);
      expect(restored.step[0].component[0].doseAndRate).toEqual([entry("ordered", 5)]);
      expect(restored.extension?.some(ext =>
        ext.url.includes("medication-course-reconciliation-source"))).toBe(true);
      const reordered = toFhirR5Dosages(course);
      reordered[0].doseAndRate!.reverse();
      reordered[0].doseAndRate![0].doseQuantity = { value: 7, unit: "mg" };
      const edited = toDosageDetails(reordered);
      expect(edited.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(7);
      expect(edited.step[0].component[0].doseAndRate?.[1]).toEqual(entry("calc", 10));
    }
    // The R5 projection carries the numeric amount even without IDs/types.
    // Deletion therefore leaves the surviving 5 mg dose identifiable.
    const anonymous: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [
        { doseQuantity: simpleQuantityForR5({ value: 10, unit: "mg", comparator: "~" })! },
        { doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! }
      ]
    }] }] };
    const anonymousRows = toFhirR5Dosages(anonymous);
    expect(anonymousRows[0].doseAndRate?.map(entry => entry.doseQuantity?.value))
      .toEqual([10, 5]);
    anonymousRows[0].doseAndRate!.shift();
    expect(anonymousRows[0].doseAndRate?.[0].doseQuantity).toMatchObject({
      value: 5, unit: "mg", extension: [{
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008",
          code: "100000000055" }
      }]
    });
    const surviving = toDosageDetails(anonymousRows);
    expect(surviving.step[0].component[0].doseAndRate).toEqual([{
      doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })!
    }]);
    const provenance = surviving.extension?.filter(ext =>
      ext.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(provenance).toHaveLength(1);
    expect(JSON.stringify(provenance[0])).toContain('"value":10');
    expect(JSON.stringify(provenance[0])).toContain('"value":5');
  });

  it("projects every qualified R6 dose/rate as an active R5 number and retains its qualifier", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [
        { doseQuantity: simpleQuantityForR5({ value: 10, comparator: "~", unit: "mg",
          code: "mg", system: "http://unitsofmeasure.org" })! },
        { doseQuantity: simpleQuantityForR5({ value: 5, comparator: "<=", unit: "mg" })! },
        { rateQuantity: simpleQuantityForR5({ value: 4, comparator: ">=", unit: "mL/h" })! },
        { rateQuantity: simpleQuantityForR5({ value: 2.5, comparator: "~", unit: "mL/h" })! }
      ]
    }] }] };
    const rows = toFhirR5Dosages(course);
    expect(rows[0].doseAndRate?.map(entry =>
      entry.doseQuantity?.value ?? entry.rateQuantity?.value)).toEqual([10, 5, 4, 2.5]);
    expect(rows[0].doseAndRate?.map(entry =>
      (entry.doseQuantity ?? entry.rateQuantity)?.extension?.[0]?.valueCoding?.code))
      .toEqual(["100000000055", "100000000052",
        "100000000053", "100000000055"]);
    expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({
      code: "mg", system: "http://unitsofmeasure.org"
    });
    for (const entry of rows[0].doseAndRate ?? [])
      expect(JSON.stringify(entry)).not.toContain('"comparator":');
    expect(JSON.stringify(rows)).toContain('"100000000055"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(course);
    const reordered = toFhirR5Dosages(course);
    reordered[0].doseAndRate!.reverse();
    expect(toDosageDetails(reordered).step[0].component[0].doseAndRate).toEqual(
      [...course.step[0].component[0].doseAndRate!].reverse()
    );
    const edited = toFhirR5Dosages(course);
    edited[0].doseAndRate![0].doseQuantity!.value = 11;
    const corrected = toDosageDetails(edited);
    expect(corrected.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual(simpleQuantityForR5({ value: 11, unit: "mg", code: "mg",
        system: "http://unitsofmeasure.org", comparator: "~" })!);
    expect(getQuantityComparator(corrected.step[0].component[0].doseAndRate?.[1].doseQuantity))
      .toBe("<=");
    expect(getQuantityComparator(corrected.step[0].component[0].doseAndRate?.[2].rateQuantity))
      .toBe(">=");
    expect(getQuantityComparator(corrected.step[0].component[0].doseAndRate?.[3].rateQuantity))
      .toBe("~");
    expect(corrected.extension?.some(ext =>
      ext.url.includes("medication-course-reconciliation-source"))).toBe(true);
  });

  it("keeps the active R5 dose even when equally valued anonymous R6 qualifiers are ambiguous", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [
        { doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! },
        { doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: ">=" })! }
      ]
    }] }] };
    const rows = toFhirR5Dosages(original);
    expect(rows[0].doseAndRate?.map(entry => entry.doseQuantity?.value))
      .toEqual([5, 5]);
    rows[0].doseAndRate!.shift();
    const restored = toDosageDetails(rows);
    // The published EMA operator coding keeps even identically valued
    // anonymous entries distinguishable; no guessed qualifier is needed.
    expect(restored.step[0].component[0].doseAndRate).toEqual([{
      doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: ">=" })!
    }]);
    const provenance = restored.extension?.filter(ext =>
      ext.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(provenance).toHaveLength(1);
    expect(JSON.stringify(provenance)).toContain('"100000000055"');
    expect(JSON.stringify(provenance)).toContain('"100000000053"');
  });

  it("replaces edited step modifiers without stacking old wrappers or deleting other extensions", () => {
    const wrapUrl = "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
    const modifier = (key: string) => ({ url: "https://example.org/step/" + key, valueString: key });
    const retained: FhirR6DosageInstruction = { step: [{
      extension: [
        { url: wrapUrl, extension: [modifier("A")] },
        { url: "https://example.org/independent", valueString: "keep" }
      ],
      component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
    }] };
    const rows = toFhirR5Dosages(retained);
    const course = fromDosageDetails(retained).course;
    course.step![0].modifierExtension = [modifier("B")];
    const edited = toDosageDetails(rows, undefined, course);
    expect(edited.step[0].extension?.filter(ext => ext.url === wrapUrl)).toEqual([
      { url: wrapUrl, extension: [modifier("B")] }
    ]);
    expect(edited.step[0].extension).toContainEqual({
      url: "https://example.org/independent", valueString: "keep"
    });
    expect(fromDosageDetails(edited).course.step![0].modifierExtension).toEqual([modifier("B")]);
    course.step![0].modifierExtension = [];
    const cleared = toDosageDetails(rows, undefined, course);
    expect(cleared.step[0].extension?.some(ext => ext.url === wrapUrl)).toBe(false);
    expect(cleared.step[0].extension).toContainEqual({
      url: "https://example.org/independent", valueString: "keep"
    });
  });

  it("preserves R6 approximate Ratio numerators through valid R5, including independent edits", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{
        rateRatio: {
          numerator: { value: 100, comparator: "~", unit: "mL" },
          denominator: { value: 90, unit: "min" }
        }
      }]
    }] }] };
    const rows = toFhirR5Dosages(course);
    expect(rows[0].doseAndRate?.[0].rateRatio?.numerator).toMatchObject({
      value: 100, unit: "mL", extension: [{
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008",
          code: "100000000055" }
      }]
    });
    expect(JSON.stringify(rows)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(rows)).toContain('"100000000055"');
    expect(JSON.stringify(rows)).not.toContain('"valueRatio"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(course);
    expect(fromFhir(course).items[0].longText).toContain("Rate: ~100 mL / 90 min");

    const changed = toFhirR5Dosages(course);
    changed[0].doseAndRate![0].rateRatio!.numerator!.value = 120;
    const numeric = toDosageDetails(changed);
    expect(numeric.step[0].component[0].doseAndRate?.[0].rateRatio?.numerator).toEqual({
      value: 120, unit: "mL", comparator: "~"
    });
    expect(numeric.extension?.some(ext =>
      ext.url.includes("medication-course-reconciliation-source"))).toBe(true);

    const replaced = toFhirR5Dosages(course);
    replaced[0].doseAndRate![0].rateExpression = { expression: "%patient.weight" };
    const expression = toDosageDetails(replaced);
    expect(expression.step[0].component[0].doseAndRate).toEqual([{
      rateExpression: { expression: "%patient.weight" }
    }]);
    expect(fromFhir(expression).fhirNext).toEqual(expression);
  });

  it("resolves offset active/rest treatment boundaries through a DST gap without changing doses", () => {
    const anchor = "2027-02-21T02:30:00-05:00";
    const opts = { from: anchor, orderedAt: anchor,
      timeZone: "America/New_York", limit: 22 };
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        endOffset: { value: 7, unit: "d", code: "d" },
        timeOfDay: ["08:00:00"]
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    for (const value of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      const times = nextDueDoses(value, opts);
      expect(times[0]).toBe("2027-02-21T08:00:00-05:00");
      expect(times[20]).toBe("2027-03-13T08:00:00-05:00");
      expect(times[21]).toBe("2027-03-21T08:00:00-04:00");
      expect(calculateTotalUnits({ dosage: value, ...opts,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }
  });

  it("keeps monthly and yearly treatment boundaries on the original calendar clock after DST gaps", () => {
    const anchor = "2027-02-14T02:30:00-05:00";
    const relative = (days: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: days, code: "d", unit: "d" }
    });
    const component = {
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const month: FhirR6DosageInstruction = {
      repeatCycle: { value: 1, unit: "mo", code: "mo" },
      step: [{ start: relative(0), end: relative(1), component: [component] }]
    };
    const options = { from: anchor, orderedAt: anchor,
      timeZone: "America/New_York", limit: 3 };
    expect(nextDueDoses(month, options)).toEqual([
      "2027-02-14T08:00:00-05:00",
      "2027-03-14T08:00:00-04:00",
      "2027-04-14T08:00:00-04:00"
    ]);
    expect(calculateTotalUnits({ dosage: month, ...options,
      durationValue: 90, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
  });

  it("retains approximate R6 Duration quantities in step boundaries and safety without leaking R5", () => {
    const relative = {
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: 2, comparator: "~" as const, unit: "d" }
    };
    const course: FhirR6DosageInstruction = {
      safety: { doseLimit: [{
        scope: "period", period: { value: 2, comparator: "~", unit: "d" },
        valueInteger: 4
      }] },
      step: [{
        start: relative,
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
      }]
    };
    const projected = toFhirR5Dosages(course);
    expect(JSON.stringify(projected)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(projected)).toContain('"100000000055"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(projected)))).toEqual(course);
    expect(fromFhir(course).fhirNext).toEqual(course);
    expect(() => nextDueDoses(course, { from: "2027-02-21T08:00:00-05:00",
      orderedAt: "2027-02-21T08:00:00-05:00", timeZone: "America/New_York" }))
      .toThrow(/Unsupported R6 step RelativeTime/);
  });

  it("does not reattach a deleted R6 expression under the old complete-course source marker", () => {
    // Read-only historical marker path: preserve source, but align live entries
    // by their distinct FHIR type rather than stale array position.
    const rate = (type: string, expression: string) => ({
      url: "doseAndRate", extension: [
        { url: "type", valueCodeableConcept: { text: type } },
        { url: "doseExpression", valueExpression: { expression } }
      ]
    });
    const legacyMarker: FhirExtension = {
      url: "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
      extension: [{ url: "dosageDetails", extension: [{
        url: "step", extension: [{ url: "component", extension: [
          rate("calc", "%calc"), rate("ordered", "%ordered")
        ] }]
      }] }]
    };
    const oldRow: EzDosage = {
      sequence: 1,
      doseAndRate: [{ type: { text: "ordered" } }],
      modifierExtension: [legacyMarker]
    };
    const restored = toDosageDetails([oldRow]);
    expect(restored.step[0].component[0].doseAndRate).toEqual([{
      type: { text: "ordered" }, doseExpression: { expression: "%ordered" }
    }]);
    expect(restored.extension?.some(x =>
      x.url.includes("medication-course-reconciliation-source"))).toBe(true);
  });

  it("converts historical retained-course edited step modifiers for existing and new stages", () => {
    const wrap = "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
    const modifier = (name: string) => ({
      url: "https://example.org/step/" + name, valueString: name
    });
    const stepFields: FhirExtension[] = [
      { url: "extension", extension: [{ url: wrap, extension: [modifier("old")] }] },
      { url: "component", extension: [{
        url: "doseAndRate", extension: [{
          url: "doseQuantity", valueQuantity: { value: 1, unit: "tab" }
        }]
      }] }
    ];
    const marker: FhirExtension = {
      url: "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
      extension: [{ url: "dosageDetails", extension: [{
        url: "step", extension: stepFields
      }] }]
    };
    const original: EzDosage = {
      sequence: 1, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      modifierExtension: [marker]
    };
    for (const [rows, edit, expected] of [
      [[original], { sequence: 1, modifierExtension: [modifier("new")] }, 1],
      [[original], { sequence: 1, modifierExtension: [] }, 0],
      [[original, { ...original, sequence: 2 }],
        { sequence: 2, modifierExtension: [modifier("new")] }, 1]
    ] as const) {
      const details = toDosageDetails(rows, undefined, { step: [edit] });
      const target = details.step[edit.sequence - 1];
      expect(target.modifierExtension).toBeUndefined();
      expect(target.extension?.filter(ext => ext.url === wrap).length ?? 0).toBe(expected);
      if (expected) expect(target.extension).toContainEqual({
        url: wrap, extension: [modifier("new")]
      });
      expect(fromFhir(details).fhirNext).toEqual(details);
    }
  });

  it.each([
    ["~5 mg PO QD", "~", "100000000055"],
    ["≈5 mg PO QD", "~", "100000000055"],
    ["about 5 mg PO QD", "~", "100000000055"],
    ["approximately 5 mg PO QD", "~", "100000000055"],
    ["ประมาณ 5 เม็ด PO QD", "~", "100000000055"],
    ["≥5 mg PO QD", ">=", "100000000053"],
    [">=5mg PO QD", ">=", "100000000053"],
    ["at least 5 mg PO QD", ">=", "100000000053"],
    ["อย่างน้อย 5 mg PO QD", ">=", "100000000053"],
    ["≤5 mg PO QD", "<=", "100000000052"],
    ["no more than 5 mg PO QD", "<=", "100000000052"],
    ["ไม่เกิน 5 เม็ด PO QD", "<=", "100000000052"],
    ["<5 mg PO QD", "<", "100000000050"],
    ["less than 5 mg PO QD", "<", "100000000050"],
    [">5 mg PO QD", ">", "100000000051"],
    ["more than 5 mg PO QD", ">", "100000000051"]
  ] as const)("parses %s into matching R5 and R6 SimpleQuantity operators %s", (input, comparator, code) => {
    const parsed = parseSig(input);
    const quantity = parsed.fhir[0].doseAndRate?.[0].doseQuantity;
    expect(quantity?.value).toBe(5);
    expect(quantity?.comparator).toBeUndefined();
    expect(quantity?.extension?.[0]).toMatchObject({
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    });
    expect(getEmaQuantityComparator(quantity)).toBe(comparator);
    const r6Quantity = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
    expect(r6Quantity).not.toHaveProperty("comparator");
    expect(r6Quantity?.extension?.[0]).toMatchObject({
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    });
    expect(getQuantityComparator(r6Quantity)).toBe(comparator);
    expect(parsed.shortText).toContain(comparator + "5");
    expect(fromFhirDosage(parsed.fhir[0]).shortText).toContain(comparator + "5");
    expect(getQuantityComparator(toDosageDetails(toFhirR5Dosages(parsed.fhirNext)).step[0]
      .component[0].doseAndRate?.[0].doseQuantity)).toBe(comparator);
  });

  it("imports independently authored EMA Quantity Operators while retaining unfamiliar ones verbatim", () => {
    const dose = (code: string) => ({
      value: 5, unit: "mg",
      extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
      }]
    });
    const exact = {
      doseAndRate: [{ doseQuantity: dose("100000000055") }]
    };
    const imported = toDosageDetails([exact]);
    expect(imported.step[0].component[0].doseAndRate?.[0].doseQuantity).toEqual(simpleQuantityForR5({
      value: 5, unit: "mg", comparator: "~"
    })!);
    expect(fromFhirDosage(exact).longText).toContain("approximately 5 mg");
    const preserved = toFhirR5Dosages(imported)[0].doseAndRate?.[0].doseQuantity;
    expect(preserved?.extension?.[0]).toEqual(dose("100000000055").extension[0]);
    expect(preserved?.value).toBe(5);

    // Equivalent, average, range and other EMA concepts are NOT "~".
    for (const code of ["100000000054", "100000000056", "200000024024", "unknown"]) {
      const quantity = dose(code);
      expect(getEmaQuantityComparator(quantity)).toBeUndefined();
      const source = { doseAndRate: [{ doseQuantity: quantity }] };
      const next = toDosageDetails([source]);
      expect(next.step[0].component[0].doseAndRate?.[0].doseQuantity).toEqual(quantity);
      expect(toFhirR5Dosages(next)[0].doseAndRate?.[0].doseQuantity).toEqual(quantity);
    }
    expect(parseSig("approximately 3 weeks").fhir[0].doseAndRate?.[0]?.doseQuantity)
      .toBeUndefined();
    expect(parseSig("1 tab PO BID").fhir[0].doseAndRate?.[0]?.doseQuantity?.extension)
      .toBeUndefined();
  });

  it("preserves old local bridge-comparator children while emitting only the standard EMA coding", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! }]
    }] }] };
    const rows = toFhirR5Dosages(course);
    const component = rows[0].modifierExtension?.[0].extension?.find(child =>
      child.url === "component");
    const amount = component?.extension?.find(child => child.url === "doseAndRate")
      ?.extension?.find(child => child.url === "doseQuantity");
    expect(amount?.valueQuantity?.extension?.[0].valueCoding?.code).toBe("100000000055");
    if (!amount) throw new Error("Expected retained R6 quantity");
    amount.valueQuantity = undefined;
    amount.extension = [
      { url: "quantity", valueQuantity: { value: 5, unit: "mg" } },
      { url: "comparator", valueCode: "~" }
    ];
    // Inspect the legacy codec result directly: the live R5 quantity still
    // has its EMA operator and must not mask a broken retained-field decoder.
    const legacy = decodeR5RetainedFields(rows[0].modifierExtension![0]);
    expect(legacy.component?.doseAndRate?.[0].doseQuantity)
      .toMatchObject({ value: 5, unit: "mg", comparator: "~" });
    expect(toDosageDetails(rows).step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual(simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })!);
  });

  it("keeps standard EMA operators active in R5 maximum-dose and period quantities", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [
        { scope: "administration", valueQuantity: {
          value: 5, unit: "mg", comparator: "~"
        } },
        { scope: "lifetime", valueQuantity: {
          value: 50, unit: "mg", comparator: "<="
        } },
        { scope: "period", valueQuantity: {
          value: 15, unit: "mg", comparator: "~"
        }, period: { value: 2, unit: "d", comparator: ">=" } }
      ] }
    }] }] };
    const rows = toFhirR5Dosages(source);
    expect(rows[0].maxDosePerAdministration).toMatchObject({
      value: 5, extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { code: "100000000055" }
      }]
    });
    expect(rows[0].maxDosePerLifetime).toMatchObject({
      value: 50, extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { code: "100000000052" }
      }]
    });
    expect(rows[0].maxDosePerPeriod?.[0]).toMatchObject({
      numerator: { value: 15, extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { code: "100000000055" }
      }] },
      denominator: { value: 2, extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { code: "100000000053" }
      }] }
    });
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(source);
    const changed = toFhirR5Dosages(source);
    changed[0].maxDosePerAdministration!.value = 6;
    expect(toDosageDetails(changed).step[0].component[0].safety?.doseLimit)
      .toContainEqual(expect.objectContaining({
        scope: "administration",
        valueQuantity: expect.objectContaining({ value: 6, comparator: "~" })
      }));
  });

  it("retains R6 approximate boundsDuration as EMA-coded R5 Quantity and a nominal course bound", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00"], boundsDuration: {
          value: 7, code: "d", unit: "d", comparator: "~"
        } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const rows = toFhirR5Dosages(course);
    expect(rows[0].timing?.repeat?.boundsDuration).toMatchObject({
      value: 7, code: "d", unit: "d", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" }
      }]
    });
    expect(rows[0].timing?.repeat?.boundsDuration?.comparator).toBeUndefined();
    expect(toDosageDetails(rows)).toEqual(course);
    const opts = { from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 10 };
    for (const input of [course, rows, fromFhir(course)]) {
      const doses = nextDueDoses(input, opts);
      expect(doses).toHaveLength(7);
      expect(doses[0]).toBe("2026-11-01T08:00:00+07:00");
      expect(doses[6]).toBe("2026-11-07T08:00:00+07:00");
      expect(calculateTotalUnits({
        dosage: input, ...opts, durationValue: 20, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(7);
    }
  });

  it("uses the numeric center of an approximate repeatCycle rather than silently deleting recurrence", () => {
    const relative = (days: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: days, unit: "d", code: "d" }
    });
    const original: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, code: "d", unit: "d", comparator: "~" },
      step: [{ start: relative(0), end: relative(21), component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"] } },
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! }]
      }] }]
    };
    const opts = { from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 25 };
    const rows = toFhirR5Dosages(original);
    expect(toDosageDetails(rows)).toEqual(original);
    for (const input of [original, rows, fromFhir(original)]) {
      const due = nextDueDoses(input, opts);
      expect(due[20]).toBe("2026-11-21T08:00:00+07:00");
      expect(due[21]).toBe("2026-11-29T08:00:00+07:00");
      expect(calculateTotalUnits({
        dosage: input, ...opts, durationValue: 56, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(210);
    }
    // This is an authored nominal value, not a fabricated exact dosage.
    expect(original.repeatCycle?.comparator).toBe("~");
  });

  it("does not silently turn an indeterminate cycle inequality into a one-off course", () => {
    const relative = (days: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: days, unit: "d", code: "d" }
    });
    const original: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, code: "d", unit: "d", comparator: ">=" },
      step: [{ start: relative(0), end: relative(21), component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"] } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }]
    };
    const opts = { from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 25 };
    for (const input of [original, toFhirR5Dosages(original)]) {
      expect(() => nextDueDoses(input, opts)).toThrow(/repeatCycle/);
      expect(() => calculateTotalUnits({
        dosage: input, ...opts, durationValue: 56, durationUnit: FhirPeriodUnit.Day
      })).toThrow(/repeatCycle/);
    }
    expect(toDosageDetails(toFhirR5Dosages(original))).toEqual(original);
  });

  it("continues calculating nominal supply from approximate doses without rejecting or erasing amounts", () => {
    const parsed = parseSig("approximately 5 mg PO QD");
    const opts = { from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", durationValue: 7,
      durationUnit: FhirPeriodUnit.Day };
    for (const input of [parsed, parsed.fhir, parsed.fhirNext]) {
      const result = calculateTotalUnits({ dosage: input, ...opts });
      expect(result.totalUnits).toBe(35);
      expect(result.unit).toBe("mg");
    }
    expect(getQuantityComparator(parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity))
      .toBe("~");
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity?.extension?.[0].valueCoding?.code)
      .toBe("100000000055");
  });

  it("preserves an EMA-qualified infusion dose while canonicalizing its clinical rate structure", () => {
    const approximate = {
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" }
    };
    const source: FhirDosage = { doseAndRate: [{
      doseQuantity: { value: 500, unit: "mL", extension: [approximate] },
      rateRatio: {
        numerator: { value: 500, unit: "mL" },
        denominator: { value: 2, unit: "h" }
      }
    }] };
    const canonical = canonicalFromFhir(source);
    expect(canonical.dose?.comparator).toBe("~");
    const rebuilt = canonicalToFhir(canonical);
    expect(rebuilt.doseAndRate?.[0]?.doseQuantity?.value).toBe(500);
    expect(getEmaQuantityComparator(rebuilt.doseAndRate?.[0]?.doseQuantity)).toBe("~");
    expect(rebuilt.doseAndRate?.[0]?.rateRatio?.numerator?.value).toBe(500);
    expect(rebuilt.doseAndRate?.[0]?.rateRatio?.denominator?.value).toBe(2);
    expect(canonicalToFhir(canonicalFromFhir({
      ...source, doseAndRate: [{ ...source.doseAndRate![0],
        doseQuantity: { value: 500, unit: "mL" } }]
    })).doseAndRate?.[0]?.doseQuantity?.extension).toBeUndefined();
  });

  it("preserves period-maximum numerator and denominator operators through canonical FHIR conversion", () => {
    const coding = (code: string) => [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    }];
    const source: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "mg" } }],
      maxDosePerPeriod: [{
        numerator: { value: 15, unit: "mg", extension: coding("100000000055") },
        denominator: { value: 1, unit: "d", extension: coding("100000000053") }
      }]
    };
    const canonical = canonicalFromFhir(source);
    expect(canonical.schedule?.maxDosePerPeriod).toEqual([{
      amount: 15, unit: "mg", amountComparator: "~",
      period: 1, periodUnit: FhirPeriodUnit.Day, periodComparator: ">="
    }]);
    const rebuilt = canonicalToFhir(canonical);
    const limit = rebuilt.maxDosePerPeriod?.[0];
    expect(limit?.numerator?.value).toBe(15);
    expect(limit?.denominator?.value).toBe(1);
    expect(getEmaQuantityComparator(limit?.numerator)).toBe("~");
    expect(getEmaQuantityComparator(limit?.denominator)).toBe(">=");
  });

  it("inherits an approximate taper dose without turning it exact and clears it on explicit replacement", () => {
    const inherited = parseSig("approximately 5 mg PO BID then QD");
    expect(inherited.fhir).toHaveLength(2);
    for (const dose of inherited.fhir) {
      expect(dose.doseAndRate?.[0]?.doseQuantity?.value).toBe(5);
      expect(getEmaQuantityComparator(dose.doseAndRate?.[0]?.doseQuantity)).toBe("~");
    }
    for (const step of inherited.fhirNext.step) {
      expect(getQuantityComparator(step.component[0].doseAndRate?.[0]?.doseQuantity)).toBe("~");
    }
    const changed = parseSig("approximately 5 mg PO BID then 5 mg PO QD");
    expect(getQuantityComparator(changed.fhirNext.step[0].component[0].doseAndRate?.[0]?.doseQuantity)).toBe("~");
    const replacement = changed.fhirNext.step[1].component[0].doseAndRate?.[0]?.doseQuantity;
    expect(replacement).toMatchObject({ value: 5, unit: "mg" });
    expect(getQuantityComparator(replacement)).toBeUndefined();
    const three = parseSig("5 mg PO BID then approximately 7 mg PO QD then QD");
    expect(three.fhirNext.step.map(step =>
      getQuantityComparator(step.component[0].doseAndRate?.[0]?.doseQuantity))).toEqual([undefined, "~", "~"]);
  });

  it("displays EMA maximum operators, Thai comparators, and per-target doses without claiming exactness", () => {
    const coding = (code: string) => [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    }];
    const source: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 5, unit: "drop",
        extension: coding("100000000055") } }],
      site: { text: "right eye" },
      maxDosePerAdministration: {
        value: 10, unit: "mg", extension: coding("100000000052")
      },
      maxDosePerPeriod: [{
        numerator: { value: 15, unit: "mg", extension: coding("100000000055") },
        denominator: { value: 1, unit: "d", extension: coding("100000000053") }
      }]
    };
    const en = fromFhirDosage(source, { locale: "en" });
    expect(en.longText).toContain("max per administration: <=10 mg");
    expect(en.longText).toContain("max per period: ~15 mg / >=1 d");
    const thai = fromFhirDosage(source, { locale: "th" });
    expect(thai.shortText).toContain("ประมาณ 5 หยด");
    expect(thai.longText).toContain("ประมาณ 5 หยด");
    expect(thai.longText).toContain("max per period: ~15 mg / >=1 d");
    const perNostril = fromFhirDosage({
      doseAndRate: [{ doseQuantity: {
        value: 5, unit: "spray", extension: coding("100000000055")
      } }], site: { text: "each nostril" }
    }, { locale: "th" });
    expect(perNostril.longText).toContain("ประมาณ 5 ครั้ง");
    expect(perNostril.longText).toContain("รูจมูกข้างละ");
    for (const [code, phrase] of [
      ["100000000053", "อย่างน้อย 5 หยด"],
      ["100000000052", "ไม่เกิน 5 หยด"],
      ["100000000050", "น้อยกว่า 5 หยด"],
      ["100000000051", "มากกว่า 5 หยด"]
    ] as const) {
      const dosage = { doseAndRate: [{ doseQuantity: {
        value: 5, unit: "drop", extension: coding(code)
      } }], site: { text: "right eye" } };
      expect(fromFhirDosage(dosage, { locale: "th" }).longText).toContain(phrase);
    }
    const native: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, unit: "tab", comparator: "~" })! }]
    }] }] };
    expect(fromFhir(native).items[0].longText).toContain("approximately 1 tablet");
  });

  it("keeps weekday-filtered weekly supply aligned to dates and R6 period offsets effective", () => {
    const anchor = "2026-11-02T00:00:00+07:00";
    const options = { from: anchor, orderedAt: anchor, timeZone: "Asia/Bangkok",
      limit: 16 };
    const weekday = { timing: { repeat: {
      frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Week,
      dayOfWeek: ["mon", "tue", "thu"] as const,
      timeOfDay: ["08:00:00"]
    } }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const weekly = weekday as FhirDosage;
    const expected = [
      "2026-11-02T08:00:00+07:00",
      "2026-11-03T08:00:00+07:00",
      "2026-11-05T08:00:00+07:00"
    ];
    expect(nextDueDoses(weekly, { ...options, limit: 3 })).toEqual(expected);
    for (const days of [2, 4, 7]) {
      expect(calculateTotalUnits({ dosage: weekly, ...options,
        durationValue: days, durationUnit: FhirPeriodUnit.Day }).totalUnits)
        .toBe(days === 2 ? 2 : 3);
    }
    const offset: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, unit: "d", code: "d" },
        endOffset: { value: 5, unit: "d", code: "d" },
        timeOfDay: ["08:00:00"]
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    for (const input of [offset, toFhirR5Dosages(offset)]) {
      const due = nextDueDoses(input, options);
      expect(due[0]).toBe("2026-11-04T08:00:00+07:00");
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(0);
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }
  });

  it("keeps zero-step course metadata edits active and retains their original source", () => {
    const old: FhirR6DosageInstruction = {
      id: "original", renderedInstruction: "Call for directions",
      extension: [{ url: "https://example.org/old-note", valueString: "retain" }],
      safety: { doseLimit: [{ scope: "administration",
        valueQuantity: { value: 5, unit: "mg" } }] }
    };
    const r5 = toFhirR5Dosages(old);
    const edited = toDosageDetails(r5, undefined, {
      id: "corrected",
      extension: [{ url: "https://example.org/new-note", valueString: "current" }],
      safety: { doseLimit: [{ scope: "administration",
        valueQuantity: { value: 8, unit: "mg" } }] }
    });
    expect(edited.step).toBeUndefined();
    expect(edited.id).toBe("corrected");
    expect(edited.safety?.doseLimit?.[0].valueQuantity?.value).toBe(8);
    expect(edited.extension).toContainEqual({
      url: "https://example.org/new-note", valueString: "current"
    });
    const source = JSON.stringify(edited.extension?.filter(item =>
      item.url.includes("reconciliation-source")));
    expect(source).toContain("old-note");
    expect(source).toContain('"value":5');
    expect(toDosageDetails(toFhirR5Dosages(edited)).safety).toEqual(edited.safety);
    expect(toDosageDetails(r5)).toEqual(old);
    const cleared = toDosageDetails(r5, undefined, { extension: [] });
    expect(cleared.extension?.some(item => item.url === "https://example.org/old-note"))
      .toBe(false);
    expect(JSON.stringify(cleared.extension)).toContain("old-note");
  });

  it("retains an unfamiliar original R6 condition after an R5 predicate replacement", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      condition: [{
        code: { text: "Pressure", extension: [{
          url: "https://example.org/code-detail", valueString: "original-coding"
        }] },
        operation: "gt", valueQuantity: { value: 160 }, text: "above 160",
        extension: [{ url: "https://example.org/condition-detail",
          valueString: "original-condition" }]
      }]
    }] }] };
    const row = toFhirR5Dosages(original)[0];
    setDosageCondition(row, {
      kind: "measurement", name: "Pressure", operation: "lt",
      value: 120, text: "below 120"
    });
    const restored = toDosageDetails([row]);
    expect(restored.step[0].component[0].condition?.[0]).toMatchObject({
      operation: "lt", valueQuantity: { value: 120 }
    });
    expect(JSON.stringify(restored.step[0].component[0].condition))
      .not.toContain("original-condition");
    const source = JSON.stringify(restored.extension?.filter(item =>
      item.url.includes("reconciliation-source")));
    expect(source).toContain("original-condition");
    expect(source).toContain("original-coding");
    expect(JSON.stringify(toDosageDetails(toFhirR5Dosages(restored)).extension))
      .toContain("original-condition");
  });

  it("preserves edited EMA scalar coding and reconciles native general-Quantity operators without duplicates", () => {
    const prior = {
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, id: "rich-ema",
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM,
        code: "100000000055", display: "approximately equal to",
        userSelected: true }
    };
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({
        value: 5, unit: "mg", comparator: "~",
        extension: [prior, { url: "https://example.org/measurement", valueBoolean: false }]
      })! }]
    }] }] };
    const original = toFhirR5Dosages(course);
    expect(getEmaQuantityComparator(original[0].doseAndRate?.[0].doseQuantity)).toBe("~");
    // An external editor supplies the current legal SimpleQuantity coding.
    // The import/projection boundary owns preservation, not the editing UI.
    course.step[0].component[0].doseAndRate![0].doseQuantity = {
      value: 5, unit: "mg", extension: [{
        ...prior, valueCoding: { ...prior.valueCoding, code: "100000000052",
          display: "less than or equal to" }
      }, { url: "https://example.org/measurement", valueBoolean: false }]
    };
    const rows = toFhirR5Dosages(course);
    const quantity = rows[0].doseAndRate?.[0].doseQuantity;
    const comparatorExtensions = quantity?.extension?.filter(item =>
      item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL);
    expect(comparatorExtensions).toHaveLength(1);
    expect(comparatorExtensions?.[0]).toEqual({
      ...prior,
      valueCoding: { ...prior.valueCoding, code: "100000000052",
        display: "less than or equal to" }
    });
    expect(quantity?.extension).toContainEqual({
      url: "https://example.org/measurement", valueBoolean: false
    });
    expect(getEmaQuantityComparator(quantity)).toBe("<=");
    expect(getQuantityComparator(toDosageDetails(rows).step[0].component[0].doseAndRate?.[0].doseQuantity))
      .toBe("<=");
    expect(getEmaQuantityComparator(toFhirR5Dosages(
      toDosageDetails(rows))[0].doseAndRate?.[0].doseQuantity)).toBe("<=");
    // The same Quantity adapter must reconcile enriched comparators inside
    // a Ratio numerator and Timing.boundsDuration, not just doseQuantity.
    const nested: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsDuration: { value: 7, unit: "d", code: "d",
          comparator: "<=", extension: [prior] }
      } },
      doseAndRate: [{ rateRatio: {
        numerator: { value: 100, unit: "mL", comparator: ">=",
          extension: [prior] },
        denominator: { value: 2, unit: "h" }
      } }]
    }] }] };
    const nestedR5 = toFhirR5Dosages(nested);
    const numerator = nestedR5[0].doseAndRate?.[0].rateRatio?.numerator;
    const bounds = nestedR5[0].timing?.repeat?.boundsDuration;
    expect(numerator?.comparator).toBe(">=");
    expect(getEmaQuantityComparator(numerator)).toBeUndefined();
    expect(numerator?.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [prior],
    });
    expect(bounds?.comparator).toBe("<=");
    expect(getEmaQuantityComparator(bounds)).toBeUndefined();
    expect(bounds?.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [prior],
    });
    expect(toDosageDetails(nestedR5).step[0].component[0].doseAndRate?.[0]
      .rateRatio?.numerator?.comparator).toBe(">=");
  });

  it("renders exact R6 rate quantities and ratios in both course and item previews", () => {
    const one = (entry: NonNullable<FhirR6DosageInstruction["step"][number]["component"][number]["doseAndRate"]>[number]) =>
      ({ step: [{ component: [{ doseAndRate: [entry] }] }] }) as FhirR6DosageInstruction;
    const exactRate = one({ rateQuantity: { value: 100, unit: "mL/h" } });
    const mixed = one({ doseQuantity: simpleQuantityForR5({ value: 500, unit: "mL", comparator: "~" })!,
      rateQuantity: { value: 100, unit: "mL/h" } });
    const ratio = one({ rateRatio: {
      numerator: { value: 500, unit: "mL" },
      denominator: { value: 2, unit: "h" }
    } });
    for (const [course, text] of [
      [exactRate, "Rate: 100 mL/h"],
      [mixed, "Rate: 100 mL/h"],
      [ratio, "Rate: 500 mL / 2 h"]
    ] as const) {
      expect(formatSig(course, "long", { locale: "en" })).toContain(text);
      expect(fromFhir(course).items[0].longText).toContain(text);
    }
    expect(formatSig(mixed, "long", { locale: "en" })).toContain("approximately 500 mL");
    expect(formatSig(mixed, "long", { locale: "en" })).not.toContain("undefined");
  });

  it("counts all explicit clocks on both sides of a non-midnight calendar cycle boundary", () => {
    const dosage: EzDosage = {
      timing: { repeat: { frequency: 42, period: 21,
        periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const clockConfig = { byFrequency: {
      "freq:42/per:21d": ["08:00", "20:00"]
    } };
    for (const [anchor, countFirst] of [
      ["2026-11-02T14:00:00Z", 42],
      ["2026-11-02T00:00:00Z", 42]
    ] as const) {
      const opts = { from: anchor, orderedAt: anchor,
        timeZone: "UTC", limit: 100,
        frequencyDefaults: clockConfig };
      const due = nextDueDoses(dosage, opts);
      const cycleEnd = Date.parse(anchor) + 21 * 86_400_000;
      expect(due.filter(value => Date.parse(value) < cycleEnd)).toHaveLength(countFirst);
      expect(calculateTotalUnits({ dosage, ...opts,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
      const shifted = nextDueDoses(dosage, {
        ...opts, from: "2026-11-23T00:00:00Z", limit: 3
      });
      expect(shifted).toContain("2026-11-23T08:00:00+00:00");
      expect(shifted).toContain("2026-11-23T20:00:00+00:00");
    }
  });

  it("keeps native step extensions and modifiers independently editable in retained R5 stages", () => {
    const wrap = "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
    const native = { url: "https://example.org/native-step", valueString: "native" };
    const oldModifier = { url: "https://example.org/old-modifier", valueString: "old" };
    const replacement = { url: "https://example.org/new-modifier", valueString: "new" };
    for (const hasModifier of [false, true]) {
      const originalExtensions: FhirExtension[] = [native, ...(hasModifier
        ? [{ url: wrap, extension: [oldModifier] }] : [])];
      const original: FhirR6DosageInstruction = { step: [{
        id: "original-step", extension: originalExtensions,
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
      }] };
      // Historical storage uses one typed child per retained extension.
      const marker: FhirExtension = {
        url: "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
        extension: [{ url: "dosageDetails", extension: [{ url: "step", extension: [
          { url: "id", valueString: "original-step" },
          ...originalExtensions.map(extension => ({ url: "extension", extension: [extension] })),
          { url: "component", extension: [{ url: "doseAndRate", extension: [{
            url: "doseQuantity", valueQuantity: { value: 1, unit: "tab" }
          }] }] }
        ] }] }]
      };
      const historical: EzDosage[] = [{ sequence: 1,
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], modifierExtension: [marker] }];
      expect(toDosageDetails(historical)).toEqual(original);
      for (const inputRows of [historical, toFhirR5Dosages(original)])
      for (const [edit, keepNative, expectedModifier] of [
        [{ sequence: 1, id: "edited-step" }, true, hasModifier ? oldModifier : undefined],
        [{ sequence: 1, extension: [] }, false, hasModifier ? oldModifier : undefined],
        [{ sequence: 1, modifierExtension: [replacement] }, true, replacement],
        [{ sequence: 1, modifierExtension: [] }, true, undefined],
        [{ sequence: 1, extension: [], modifierExtension: [] }, false, undefined]
      ] as const) {
        const edited = toDosageDetails(inputRows, undefined, { step: [edit] });
        const extensions = edited.step[0].extension ?? [];
        expect(extensions.some(value => value.url === native.url)).toBe(keepNative);
        expect(extensions.find(value => value.url === wrap)?.extension)
          .toEqual(expectedModifier ? [expectedModifier] : undefined);
        expect(edited.step[0].id).toBe("id" in edit ? edit.id : "original-step");
        // Clearing an already absent modifier is a no-op, not a reason
        // to create history. Actual edits retain the original source.
        if (hasModifier || "id" in edit || "extension" in edit || expectedModifier)
          expect(JSON.stringify(edited.extension)).toContain("native-step");
        const reopened = toDosageDetails(toFhirR5Dosages(edited));
        expect(reopened.step[0].extension ?? []).toEqual(extensions);
        expect(fromFhir(edited).fhirNext.step[0]).toEqual(edited.step[0]);
      }
    }
  });

  it("does not make independently qualified carrier rates inherit an equal-valued drug dose", () => {
    const operators = [undefined, "~", "<", "<=", ">", ">=", "ad"] as const;
    for (const doseComparator of operators) for (const rateComparator of operators) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{
        doseQuantity: simpleQuantityForR5({ value: 500, unit: "mL", ...(doseComparator ? { comparator: doseComparator } : {}) })!,
        rateRatio: { numerator: { value: 500, unit: "mL",
          ...(rateComparator ? { comparator: rateComparator } : {}) },
          denominator: { value: 2, unit: "h" } }
      }] }] }] };
      const row = toFhirR5Dosages(source)[0];
      const rebuilt = canonicalToFhir(canonicalFromFhir(row));
      const back = toDosageDetails([rebuilt]).step[0].component[0].doseAndRate![0];
      expect(back.doseQuantity).toMatchObject({ value: 500, unit: "mL" });
      expect(getQuantityComparator(back.doseQuantity)).toBe(doseComparator);
      expect(back.rateRatio?.numerator).toMatchObject({ value: 500, unit: "mL" });
      expect(back.rateRatio?.numerator?.comparator).toBe(rateComparator);
      expect(back.rateRatio?.denominator?.value).toBe(2);
    }
    // Equal labels do not make independently authored unit coding identical.
    const coded: FhirDosage = { doseAndRate: [{
      doseQuantity: { value: 500, unit: "mL", code: "mL", system: "urn:example:active" },
      rateRatio: { numerator: { value: 500, unit: "mL", code: "mL", system: "urn:example:carrier" },
        denominator: { value: 2, unit: "h" } }
    }] };
    const rebuilt = canonicalToFhir(canonicalFromFhir(coded));
    expect(rebuilt.doseAndRate?.[0].doseQuantity?.system).toBe("urn:example:active");
    expect(rebuilt.doseAndRate?.[0].rateRatio?.numerator?.system).toBe("urn:example:carrier");
  });

  it("shows EMA-only and native-edited R6 rate operators in both item and course previews", () => {
    const codes = [["~", "100000000055"], [">=", "100000000053"],
      ["<=", "100000000052"], [">", "100000000051"], ["<", "100000000050"]] as const;
    const qualifier = (code: string) => [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    }];
    for (const [operator, code] of codes) for (const native of [false, true]) {
      const expectedOperator = native ? "<" : operator;
      const amount = { value: 100, unit: "mL/h", extension: qualifier(code),
        ...(native ? { comparator: "<" as const } : {}) };
      for (const [rate, expected] of [
        // A scalar rate is SimpleQuantity in R6: keep its qualifier in EMA.
        [{ rateQuantity: { value: 100, unit: "mL/h", extension: qualifier(code) } }, `${operator}100 mL/h`],
        [{ rateRatio: { numerator: { ...amount, unit: "mL" },
          denominator: { value: 2, unit: "h", extension: qualifier("100000000053") } } },
          `${expectedOperator}100 mL / >=2 h`]
      ] as const) {
        const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [rate] }] }] };
        for (const locale of ["en", "th"]) {
          expect(formatSig(source, "long", { locale })).toContain(expected);
          expect(fromFhir(source, { locale }).items[0].longText).toContain(expected);
        }
        expect(fromFhir(source).fhirNext).toEqual(source);
      }
    }
  });

  it.each([
    ["Take at most one tablet at bedtime", 1, "<=", "doseQuantity"],
    ["Take at least two tablets daily", 2, ">=", "doseQuantity"],
    ["Take approximately half a tablet daily", 0.5, "~", "doseQuantity"],
    ["Take no more than a quarter tablet daily", 0.25, "<=", "doseQuantity"],
    ["Infuse at least two mL/hr", 2, ">=", "rateQuantity"],
    ["approximately two mg/kg/day in two divided doses", 1, "~", "doseQuantity"],
    ["Dissolve at most two tablets in water", 2, "<=", "doseQuantity"],
    ["squeeze at most one cm ribbon cream onto each spot", 1, "<=", "doseQuantity"]
  ] as const)("retains number-word quantity scope for %s", (input, value, comparator, slot) => {
    const parsed = parseSig(input);
    const native = parsed.fhirNext.step[0].component[0].doseAndRate![0][slot];
    expect(native?.value).toBe(value);
    expect(getQuantityComparator(native)).toBe(comparator);
    expect(getQuantityComparator(parsed.fhir[0].doseAndRate?.[0][slot])).toBe(comparator);
    const restored = toDosageDetails(JSON.parse(JSON.stringify(parsed.fhir)));
    expect(getQuantityComparator(restored.step[0].component[0].doseAndRate?.[0][slot])).toBe(comparator);
    expect(parsed.input).toBe(input);
  });

  it("does not turn comparative durations or unknown nouns into number-word doses", () => {
    for (const input of ["approximately one week", "at most one symptom"]) {
      const parsed = parseSig(input);
      expect(parsed.fhir[0]?.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
      expect(parsed.input).toBe(input);
    }
    const ordinary = parseSig("Take one tablet daily").fhir[0].doseAndRate?.[0].doseQuantity;
    expect(ordinary?.value).toBe(1);
    expect(getQuantityComparator(ordinary)).toBeUndefined();
  });

  it("shows source-less dose and rate expressions in individual R6 items without evaluating them", () => {
    for (const choice of ["doseExpression", "rateExpression"] as const) {
      for (const expression of [
        { expression: "%patient.weight * 2", language: "text/fhirpath" },
        { reference: "Library/dosage-rule", description: "Weight-based dose" },
        { description: "Use the authored dosing formula" }
      ]) {
        const source: FhirR6DosageInstruction = {
          renderedInstruction: "Follow the written plan", step: [{ component: [{
            doseAndRate: [{ [choice]: expression }]
          }] }]
        };
        const expected = expression.expression ?? expression.reference ?? expression.description!;
        const imported = fromFhir(source);
        expect(imported.longText).toContain(expected);
        expect(imported.longText).toContain("unevaluated");
        expect(imported.fhirNext.renderedInstruction).toBe(source.renderedInstruction);
        expect(imported.items[0].shortText).toContain(expected);
        expect(imported.items[0].longText).toContain(expected);
        expect(imported.items[0].longText).toContain("unevaluated");
        expect(imported.fhir[0].doseAndRate?.[0].doseQuantity).toBeUndefined();
        expect(imported.fhir[0].doseAndRate?.[0].rateQuantity).toBeUndefined();
        expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
        source.step[0].component[0].text = "Clinician's own component wording";
        expect(fromFhir(source).items[0].longText).toContain(expected);
        expect(fromFhir(source).fhirNext.step[0].component[0].text).toBe("Clinician's own component wording");
      }
    }
  });

  it("aligns integer day/week component caps with repeated calendar cycles across both DST transitions", () => {
    const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    for (const bounds of [
      { boundsDuration: { value: 28, unit: "d", code: "d" } },
      { boundsDuration: { value: 4, unit: "wk", code: "wk" } },
      { boundsRange: { low: { value: 21, unit: "d", code: "d" },
        high: { value: 28, unit: "d", code: "d" } } }
    ]) for (const scenario of [
      { anchor: "2027-02-15T00:00:00-05:00", from: "2027-03-15T00:00:00-04:00",
        clock: "00:30:00", expected: "2027-03-15T00:30:00-04:00" },
      { anchor: "2026-10-05T00:00:00-04:00", from: "2026-11-01T12:00:00-05:00",
        clock: "23:30:00", expected: "2026-11-01T23:30:00-05:00" }
    ]) {
      const source: FhirR6DosageInstruction = {
        repeatCycle: { value: 28, code: "d", unit: "d" },
        step: [{ component: [{ ...dose, timing: { repeat: {
          frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: [scenario.clock], ...bounds
        } } }] }]
      };
      const options = { from: scenario.from, orderedAt: scenario.anchor,
        timeZone: "America/New_York", limit: 35 };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const due = nextDueDoses(input, options);
        expect(due[0]).toBe(scenario.expected);
        expect(new Set(due).size).toBe(due.length);
        expect(calculateTotalUnits({ dosage: input, ...options,
          durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
  });

  it("keeps fractional duration caps and hourly intervals elapsed rather than calendar stepped", () => {
    const anchor = "2027-03-14T00:00:00-05:00";
    for (const quantity of [{ value: 1.5, code: "d" }, { value: 36, code: "h" }]) {
      const dosage: FhirDosage = {
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["12:30:00"], boundsDuration: quantity } }
      };
      // 36 elapsed hours after spring-transition midnight ends at 13:00.
      const options = { orderedAt: anchor, from: "2027-03-15T12:00:00-04:00",
        timeZone: "America/New_York", limit: 3 };
      expect(nextDueDoses(dosage, options)).toEqual(["2027-03-15T12:30:00-04:00"]);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 2, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(1);
    }
    expect(nextDueDoses({ timing: { repeat: {
      frequency: 1, period: 24, periodUnit: FhirPeriodUnit.Hour
    } } }, { from: "2027-03-13T08:00:00-05:00", orderedAt: "2027-03-13T08:00:00-05:00",
      timeZone: "America/New_York", limit: 3 })).toEqual([
        "2027-03-13T08:00:00-05:00", "2027-03-14T09:00:00-04:00", "2027-03-15T09:00:00-04:00"
      ]);
  });

  it("retains EMA time operators without displaying exact course gaps or losing the known duration", () => {
    const coding = (code: string) => [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code } }];
    const relative = (value: number) => ({ contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] }, offsetDuration: { value, unit: "d", code: "d" } });
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 7, unit: "d", code: "d", extension: coding("100000000053") },
      step: [{ end: relative(3), component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }]
    };
    for (const input of [source, toDosageDetails(toFhirR5Dosages(source))]) {
      const text = formatSig(input, "long", { locale: "en" });
      expect(text).toContain(">=7 days");
      expect(text).not.toContain("No doses from 3 days after treatment start until 7 days after treatment start");
      expect(text).not.toContain("every 7 days");
    }
    source.step[0].start = { ...relative(2), offsetDuration: {
      ...relative(2).offsetDuration, extension: coding("100000000055")
    } };
    const text = formatSig(source, "long", { locale: "en" });
    expect(text).toContain("~2 days after treatment start");
    expect(text).not.toContain("From 2 days after treatment start until 3 days after treatment start");
    expect(text).not.toContain("No doses");
    expect(formatSig(source, "long", { locale: "th" })).toContain("~2 วัน");
    expect(fromFhir(source).fhirNext).toEqual(source);
    // The current native edit wins over retained EMA metadata; a nominal
    // approximate repeat remains executable, just as a native ~ quantity.
    source.step[0].start = relative(0);
    source.repeatCycle!.comparator = "~";
    expect(formatSig(source, "long", { locale: "en" })).toContain("~7 days");
    const opts = { from: "2026-11-02T00:00:00+07:00",
      orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok",
      durationValue: 14, durationUnit: FhirPeriodUnit.Day };
    expect(calculateTotalUnits({ dosage: source, ...opts }).totalUnits).toBe(6);
    expect(calculateTotalUnits({ dosage: toFhirR5Dosages(source), ...opts }).totalUnits).toBe(6);
  });

  it("shows known phase repeats with qualified, unknown-unit and exact course intervals", () => {
    const ema = (code: string) => [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code } }];
    for (const cycle of [
      { value: 28, unit: "d", code: "d", comparator: "~" as const },
      { value: 28, unit: "d", code: "d", extension: ema("100000000055") },
      { value: 28, unit: "d", code: "d", extension: ema("100000000053") },
      { value: 28, unit: "d", code: "d" }, { value: 2, unit: "custom-cycle" }
    ]) for (const count of [1, 6, undefined]) {
      const source: FhirR6DosageInstruction = { repeatCycle: cycle, step: [{
        ...(count !== undefined ? { count } : {}),
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
      }] };
      for (const input of [source, toDosageDetails(toFhirR5Dosages(source))]) {
        const en = formatSig(input, "long", { locale: "en" });
        const th = formatSig(input, "long", { locale: "th" });
        if (count !== undefined) {
          expect(en).toContain(`Perform this phase ${count} ${count === 1 ? "time" : "times"}`);
          expect(th).toContain(`ทำซ้ำระยะนี้รวม ${count} ครั้ง`);
        } else {
          expect(en).not.toContain("Perform this phase");
          expect(th).not.toContain("ทำซ้ำระยะนี้");
        }
        const op = getQuantityComparator(cycle);
        if (op) expect(en).toContain(op + "28 days");
      }
      const restored = toDosageDetails(toFhirR5Dosages(source));
      expect(restored.step).toEqual(source.step);
      expect(restored.repeatCycle?.value).toBe(cycle.value);
      expect(restored.repeatCycle?.unit).toBe(cycle.unit);
      // A canonical EMA operator is normalized to the equivalent native
      // R6 comparator, not required to keep its older wire spelling.
      expect(getQuantityComparator(restored.repeatCycle)).toBe(getQuantityComparator(cycle));
      expect(fromFhir(source).fhirNext).toEqual(source);
    }
  });

  it("keeps native and EMA upper duration bounds as upper horizons, not unbounded courses", () => {
    const options = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z",
      timeZone: "UTC", limit: 20 };
    for (const operator of ["<", "<=", "~"] as const) {
      const native = { value: 7, unit: "d", code: "d", comparator: operator };
      const code = operator === "<" ? "100000000050" : operator === "<=" ? "100000000052" : "100000000055";
      const ema = { value: 7, unit: "d", code: "d", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
      }] };
      for (const quantity of [native, ema]) {
        const source: FhirR6DosageInstruction = { step: [{ component: [{
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["08:00:00"], boundsDuration: quantity } }
        }] }] };
        for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
          const due = nextDueDoses(input, options);
          expect(due).toHaveLength(7);
          expect(due[6]).toBe("2026-11-08T08:00:00+00:00");
          expect(calculateTotalUnits({ dosage: input, ...options,
            durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
        }
        expect(getQuantityComparator(toDosageDetails(toFhirR5Dosages(source))
          .step[0].component[0].timing?.repeat?.boundsDuration)).toBe(operator);
      }
    }
    // Lower bounds never imply an upper treatment stop.
    const lower: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsDuration: { value: 7, code: "d", comparator: ">=" } } }
    }] }] };
    expect(calculateTotalUnits({ dosage: lower, ...options,
      durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(14);
  });

  it("retains upper caps through range endpoints and anchored-course modifiers", () => {
    const ema = { value: 7, unit: "d", code: "d", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000052" }
    }] };
    for (const bound of [
      { timing: { repeat: { boundsRange: { high: ema } } } },
      { modifierExtension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration",
        valueQuantity: ema }] },
      { modifierExtension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration",
        valueRange: { high: ema } }] }
    ]) {
      const row: FhirDosage = { ...bound,
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"], ...bound.timing?.repeat } }
      };
      const options = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z",
        timeZone: "UTC", limit: 20 };
      expect(nextDueDoses(row, options)).toHaveLength(7);
      expect(calculateTotalUnits({ dosage: row, ...options,
        durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
    }
  });

  it("continues nominal approximate-limit arithmetic but does not invent a unique inequality window", () => {
    const opts = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z",
      timeZone: "UTC", limit: 4, durationValue: 4, durationUnit: FhirPeriodUnit.Day };
    for (const doseOperator of [undefined, "~"] as const)
    for (const maxOperator of [undefined, "~"] as const)
    for (const periodOperator of [undefined, "~", ">="] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, unit: "tab",
          ...(doseOperator ? { comparator: doseOperator } : {}) })! }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"] } },
        safety: { doseLimit: [{ scope: "period",
          valueQuantity: { value: 1, unit: "tab", ...(maxOperator ? { comparator: maxOperator } : {}) },
          period: { value: 2, unit: "d", code: "d", ...(periodOperator ? { comparator: periodOperator } : {}) }
        }] }
      }] }] };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const total = calculateTotalUnits({ dosage: input, ...opts });
        expect(total.totalUnits).toBe(periodOperator === ">=" ? 4 : 2);
        if (periodOperator === ">=") {
          expect(() => nextDueDoses(input, opts)).toThrow(expect.objectContaining({ code: "unresolved-cap-period" }));
          expect(total.explanation).toContain("could not be applied");
        } else {
          expect(nextDueDoses(input, opts)[1]).toBe("2026-11-04T08:00:00+00:00");
        }
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
    // The existing source is never an excuse to blank a known numeric dose.
    const approximate = parseSig("approximately 5 mg PO QD");
    expect(calculateTotalUnits({ dosage: approximate, ...opts, durationValue: 7 }).totalUnits).toBe(35);
    expect(getQuantityComparator(approximate.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity)).toBe("~");
  });

  it("uses the same nominal and unevaluated-operator policy for lifetime and administration limits", () => {
    const opts = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z",
      timeZone: "UTC", durationValue: 4, durationUnit: FhirPeriodUnit.Day };
    for (const operator of [undefined, "~", ">="] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        safety: { doseLimit: [
          { scope: "administration", valueQuantity: { value: 8, unit: "mg",
            ...(operator ? { comparator: operator } : {}) } },
          { scope: "lifetime", valueQuantity: { value: 15, unit: "mg",
            ...(operator ? { comparator: operator } : {}) } }
        ] }
      }] }] };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const total = calculateTotalUnits({ dosage: input, ...opts });
        expect(total.totalUnits).toBe(operator === ">=" ? 20 : 15);
        if (operator === ">=") expect(total.explanation).toContain("could not be applied");
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
  });

  it.each(["administration", "lifetime", "period"] as const)(
    "retains superseded %s safety limits without restoring their deleted active value", scope => {
      const oldLimit = {
        scope,
        ...(scope === "period" ? { period: { value: 1, unit: "d", code: "d" } } : {}),
        valueQuantity: { value: 5, unit: "mg", comparator: "~" as const },
        extension: [{ url: "https://example.org/retained-limit", valueString: "original" }]
      };
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        safety: { doseLimit: [oldLimit] }
      }] }] };
      const row = toFhirR5Dosages(source)[0];
      expect(toDosageDetails([row])).toEqual(source);
      if (scope === "administration") delete row.maxDosePerAdministration;
      else if (scope === "lifetime") delete row.maxDosePerLifetime;
      else delete row.maxDosePerPeriod;
      const edited = toDosageDetails([row]);
      expect(edited.step[0].component[0].safety?.doseLimit
        ?.some(limit => limit.scope === scope)).not.toBe(true);
      expect(JSON.stringify(edited.extension)).toContain("retained-limit");
      expect(JSON.stringify(edited.extension)).toContain('"value":5');
      const reopened = toDosageDetails(toFhirR5Dosages(edited));
      expect(reopened.step[0].component[0].safety).toEqual(edited.step[0].component[0].safety);
      expect(JSON.stringify(reopened.extension)).toContain("retained-limit");

      // Explicit typed R6 safety replacement is another editing surface for
      // the same field: the new limit must be active; the old is source.
      const override: EzDosage = { ...toFhirR5Dosages(source)[0],
        safety: { doseLimit: [{ ...oldLimit, valueQuantity: {
          value: 8, unit: "mg"
        }, extension: undefined }] } };
      const current = toDosageDetails([override]);
      expect(current.step[0].component[0].safety?.doseLimit?.[0].valueQuantity?.value).toBe(8);
      expect(JSON.stringify(current.extension)).toContain("retained-limit");
    }
  );

  it("preserves non-representable safety siblings when a representable limit is deleted", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: {
        ifExceeded: "stop",
        doseLimit: [
          { scope: "administration", valueQuantity: { value: 5, unit: "mg", comparator: "~" },
            extension: [{ url: "https://example.org/deleted-limit", valueString: "old" }] },
          { scope: "administration", valueExpression: {
            expression: "%patient.weight * 2", language: "text/fhirpath"
          }, extension: [{ url: "https://example.org/expression-limit", valueBoolean: true }] }
        ]
      }
    }] }] };
    const row = toFhirR5Dosages(source)[0];
    delete row.maxDosePerAdministration;
    const edited = toDosageDetails([row]);
    const safety = edited.step[0].component[0].safety;
    expect(safety?.ifExceeded).toBe("stop");
    expect(safety?.doseLimit).toHaveLength(1);
    expect(safety?.doseLimit?.[0].valueExpression?.expression).toBe("%patient.weight * 2");
    expect(JSON.stringify(edited.extension)).toContain("deleted-limit");
    expect(toDosageDetails(toFhirR5Dosages(edited)).step[0].component[0].safety).toEqual(safety);
  });

  it("never transfers unknown safety-limit metadata to a different surviving period", () => {
    const limit = (value: number, days: number, tag: string) => ({
      scope: "period" as const,
      valueQuantity: { value, unit: "mg" },
      period: { value: days, unit: "d", code: "d" },
      extension: [{ url: "https://example.org/limit-" + tag, valueString: tag }]
    });
    const a = limit(5, 1, "A"), b = limit(10, 7, "B");
    const original: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [a, b] }
    }] }] };
    const r5 = toFhirR5Dosages(original);
    expect(r5[0].maxDosePerPeriod).toHaveLength(2);
    const sources = (result: FhirR6DosageInstruction) =>
      JSON.stringify(result.extension?.filter(ext => ext.url.includes("reconciliation-source")));
    const live = (rows: FhirDosage[]) =>
      toDosageDetails(rows).step[0].component[0].safety?.doseLimit ?? [];

    // Deletion: the 10 mg / 7 day limit must retain B, NEVER A.
    const deleted = JSON.parse(JSON.stringify(r5)) as FhirDosage[];
    deleted[0].maxDosePerPeriod!.shift();
    expect(live(deleted)).toEqual([b]);
    const afterDeletion = toDosageDetails(deleted);
    expect(sources(afterDeletion)).toContain("limit-A");
    expect(toDosageDetails(toFhirR5Dosages(afterDeletion))
      .step[0].component[0].safety?.doseLimit).toEqual([b]);

    // Reordering two same-scope limits does not exchange metadata owners.
    const reordered = JSON.parse(JSON.stringify(r5)) as FhirDosage[];
    reordered[0].maxDosePerPeriod!.reverse();
    expect(live(reordered)).toEqual([b, a]);

    // Editing one numeric maximum leaves the other limit's metadata alone.
    const edited = JSON.parse(JSON.stringify(r5)) as FhirDosage[];
    edited[0].maxDosePerPeriod![0].numerator.value = 6;
    expect(live(edited)).toEqual([{ ...a, valueQuantity: {
      value: 6, unit: "mg"
    } }, b]);

    // Two indistinguishable numeric limits: deleting one cannot determine
    // which unfamiliar extension belonged to the survivor. Keep BOTH old
    // meanings in source provenance, not on an arbitrarily chosen live limit.
    const twin: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [a, { ...a, extension: b.extension }] }
    }] }] };
    // R5 Ratio Element metadata now survives projection. An explicitly
    // annotated live B remains B even when its numeric value matches A.
    const identified = toFhirR5Dosages(twin);
    identified[0].maxDosePerPeriod!.shift();
    expect(toDosageDetails(identified).step[0].component[0].safety?.doseLimit?.[0].extension)
      .toEqual(b.extension);
    // A consumer can return only the numeric R5 projection. With those
    // live annotations omitted, the retained twin sources are ambiguous.
    const ambiguous = toFhirR5Dosages(twin);
    for (const ratio of ambiguous[0].maxDosePerPeriod!) delete ratio.extension;
    ambiguous[0].maxDosePerPeriod!.shift();
    const survivor = toDosageDetails(ambiguous);
    const active = survivor.step[0].component[0].safety?.doseLimit?.[0];
    expect(active?.valueQuantity?.value).toBe(5);
    expect(active?.extension).toBeUndefined();
    expect(sources(survivor)).toContain("limit-A");
    expect(sources(survivor)).toContain("limit-B");
  });

  it.each(["<", "<=", "~", ">=", ">"] as const)(
    "keeps %s dose supply bounds consistent through all dosage representations", comparator => {
      const original: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator })! }]
      }] }] };
      const strict = toFhirR5Dosages(original);
      const options = { from: "2026-11-02T00:00:00Z",
        orderedAt: "2026-11-02T00:00:00Z", timeZone: "UTC",
        durationValue: 7, durationUnit: FhirPeriodUnit.Day };
      for (const dosage of [original, strict, strict[0], fromFhir(original)]) {
        if (comparator === ">" || comparator === ">=")
          expect(() => calculateTotalUnits({ dosage, ...options })).toThrow(/lower bound/i);
        else expect(calculateTotalUnits({ dosage, ...options }).totalUnits).toBe(35);
      }
      expect(toDosageDetails(strict)).toEqual(original);
      expect(getQuantityComparator(original.step[0].component[0].doseAndRate?.[0].doseQuantity)).toBe(comparator);
    }
  );

  it("distinguishes finite dose/rate/range estimates from unbounded lower limits", () => {
    const options = { from: "2026-11-02T00:00:00Z",
      orderedAt: "2026-11-02T00:00:00Z", timeZone: "UTC",
      durationValue: 7, durationUnit: FhirPeriodUnit.Day };
    const timing = { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      duration: 2, durationUnit: FhirPeriodUnit.Hour } };
    for (const entry of [
      { rateQuantity: simpleQuantityForR5({ value: 10, unit: "mL/h", comparator: ">=" })! },
      { rateRatio: { numerator: { value: 10, unit: "mL", comparator: "<=" },
        denominator: { value: 1, unit: "h" } } }
    ] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        timing, doseAndRate: [entry]
      }] }] };
      for (const dosage of [source, toFhirR5Dosages(source)]) {
        if ("rateQuantity" in entry)
          expect(() => calculateTotalUnits({ dosage, ...options })).toThrow(/lower bound/i);
        else expect(calculateTotalUnits({ dosage, ...options }).totalUnits).toBe(140);
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
    const ranged: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ doseRange: {
        low: simpleQuantityForR5({ value: 5, unit: "mg", comparator: ">=" })!,
        high: simpleQuantityForR5({ value: 8, unit: "mg", comparator: "<=" })!
      } }]
    }] }] };
    for (const dosage of [ranged, toFhirR5Dosages(ranged)])
      expect(calculateTotalUnits({ dosage, ...options }).totalUnits).toBe(56);
    expect(toDosageDetails(toFhirR5Dosages(ranged))).toEqual(ranged);
  });

  it("executes current-profile EMA active/rest offsets consistently", () => {
    const coding = (code: string) => [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    }];
    const options = { from: "2026-11-02T00:00:00Z",
      orderedAt: "2026-11-02T00:00:00Z", timeZone: "UTC", limit: 30 };
    for (const [code, native, allowed] of [
      ["100000000055", "~", true],
      ["100000000053", ">=", false],
      ["100000000052", "<=", false],
      ["100000000051", ">", false],
      ["100000000050", "<", false]
    ] as const) {
      const startOffset = { value: 2, unit: "d", code: "d", extension: coding(code) };
      for (const offset of [startOffset]) {
        const course: FhirR6DosageInstruction = { step: [{ component: [{
          timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
            startOffset: offset, endOffset: { value: 5, unit: "d", code: "d" } } },
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
        }] }] };
        const r5 = toFhirR5Dosages(course);
        expect(getQuantityComparator(toDosageDetails(r5).step[0]
          .component[0].timing?.repeat?.startOffset)).toBe(native);
        for (const dosage of [course, fromFhir(course), r5, toDosageDetails(r5)]) {
          if (allowed) {
            const due = nextDueDoses(dosage, options);
            expect(due[0]).toBe("2026-11-04T00:00:00+00:00");
            expect(calculateTotalUnits({ dosage, ...options,
              durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
          } else {
            expect(() => nextDueDoses(dosage, options)).toThrow(/offset/);
            expect(() => calculateTotalUnits({ dosage, ...options,
              durationValue: 28, durationUnit: FhirPeriodUnit.Day })).toThrow(/offset/);
          }
        }
      }
    }
  });

  it.each(["~", ">=", "<=", ">", "<"] as const)(
    "keeps permissive offset comparator %s source separate from strict current-profile acceptance", comparator => {
      const startOffset = { value: 2, unit: "d", code: "d", comparator };
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
          startOffset, endOffset: { value: 5, unit: "d", code: "d" } } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      }] }] };
      expect(() => fromFhir(source)).toThrow(/SimpleQuantity/);
      const restored = toDosageDetails(toFhirR5Dosages(source));
      expect(getQuantityComparator(restored.step[0].component[0].timing!.repeat!.startOffset)).toBe(comparator);
    }
  );

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
    expect(fromFhir({ renderedInstruction: "Directions supplied as text only.", step: [] }).fhir[0].text)
      .toBe("Directions supplied as text only.");
  });
});


describe("review family contract: active native comparator owns imported quantities", () => {
  const operators = [
    ["<", "100000000050"], ["<=", "100000000052"],
    [">", "100000000051"], [">=", "100000000053"],
    ["ad", "100000165006"], ["~", "100000000055"]
  ] as const;
  const ema = (code: string): FhirExtension => ({
    url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
    valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
  });

  it.each(operators)("keeps native %s authoritative over every retained EMA operator", (native, expectedCode) => {
    for (const [, retainedCode] of operators) {
      const quantity = { value: 5, unit: "mg", comparator: native,
        extension: [ema(retainedCode), { url: "https://example.org/keep", valueString: "authored" }] };
      expect(getQuantityComparator(quantity)).toBe(native);
      const projected = quantityForR5(quantity)!;
      expect(projected.value).toBe(5);
      expect(getQuantityComparator(projected)).toBe(native);
      expect(projected.comparator).toBe(native === "~" ? undefined : native);
      expect(projected.extension?.filter(x => x.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL))
        .toEqual(native === "~" ? [ema(expectedCode)] : []);
      if (native !== "~" && retainedCode !== expectedCode)
        expect(projected.extension).toContainEqual({
          url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [ema(retainedCode)],
        });
      expect(projected.extension).toContainEqual({ url: "https://example.org/keep", valueString: "authored" });
      expect(quantityFromR5(projected)?.comparator).toBe(native);
      // Conversion is not an in-place mutation of the user's original object.
      expect(quantity.extension[0]).toEqual(ema(retainedCode));
    }
  });

  it.each(operators.filter((row): row is Exclude<typeof operators[number], readonly ["~", "100000000055"]> => row[0] !== "~"))(
    "uses edited native %s in maximum canonicalization, both previews and R6 safety", (comparator) => {
      const row: FhirDosage = {
        doseAndRate: [{ doseQuantity: { value: 1, unit: "mg" } }],
        maxDosePerPeriod: [{
          numerator: { value: 5, unit: "mg", comparator, extension: [ema("100000000055")] },
          denominator: { value: 1, code: "d", unit: "d", extension: [ema("100000000053")] }
        }]
      };
      const canonical = canonicalFromFhir(row);
      expect(canonical.schedule?.maxDosePerPeriod?.[0]).toMatchObject({
        amount: 5, amountComparator: comparator, period: 1, periodComparator: ">="
      });
      expect(parserStateFromFhir(row).primaryClause.schedule?.maxDosePerPeriod?.[0]?.amountComparator)
        .toBe(comparator);
      const rebuilt = canonicalToFhir(canonical);
      expect(rebuilt.maxDosePerPeriod?.[0].numerator?.comparator).toBe(comparator);
      for (const locale of ["en", "th"]) {
        const rendered = fromFhirDosage(row, { locale });
        expect(rendered.longText).toContain(`max per period: ${comparator}5 mg / >=1 d`);
      }
      const course = toDosageDetails([row]);
      expect(course.step[0].component[0].safety?.doseLimit?.[0].valueQuantity?.comparator).toBe(comparator);
      const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(course)));
      expect(getQuantityComparator(saved[0].maxDosePerPeriod[0].numerator)).toBe(comparator);
      expect(toDosageDetails(saved).step[0].component[0].safety?.doseLimit?.[0].valueQuantity?.comparator)
        .toBe(comparator);
    }
  );

  it.each(operators)("retains EMA-only %s across dose, rate, safety and timing roles", (comparator, code) => {
    const quantity = { value: 5, unit: "mg", extension: [ema(code)] };
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: quantity, rateQuantity: { ...quantity, unit: "mg/h" } }],
      maxDosePerAdministration: quantity, maxDosePerLifetime: quantity,
      maxDosePerPeriod: [{ numerator: quantity,
        denominator: { value: 1, unit: "d", code: "d", extension: [ema(code)] } }],
      timing: { repeat: { boundsDuration: { value: 7, unit: "d", code: "d", extension: [ema(code)] } } }
    };
    expect(canonicalFromFhir(row).dose?.comparator).toBe(comparator);
    expect(parserStateFromFhir(row).primaryClause.dose?.comparator).toBe(comparator);
    const component = toDosageDetails([row]).step[0].component[0];
    expect(getQuantityComparator(component.doseAndRate?.[0].doseQuantity)).toBe(comparator);
    expect(getQuantityComparator(component.doseAndRate?.[0].rateQuantity)).toBe(comparator);
    expect(component.timing?.repeat?.boundsDuration?.comparator).toBe(comparator);
    expect(component.safety?.doseLimit).toHaveLength(3);
    for (const scope of ["administration", "period", "lifetime"]) {
      expect(component.safety?.doseLimit?.find(x => x.scope === scope)?.valueQuantity)
        .toMatchObject({ value: 5, unit: "mg", comparator });
    }
    expect(component.safety?.doseLimit?.find(x => x.scope === "period")?.period?.comparator).toBe(comparator);
    const back = toFhirR5Dosages({ step: [{ component: [component] }] })[0];
    expect(back.doseAndRate?.[0].doseQuantity?.value).toBe(5);
    expect(getQuantityComparator(back.doseAndRate?.[0].doseQuantity)).toBe(comparator);
    expect(getQuantityComparator(back.maxDosePerAdministration)).toBe(comparator);
    expect(back.maxDosePerLifetime).toMatchObject({ value: 5, unit: "mg" });
    expect(getQuantityComparator(back.maxDosePerLifetime)).toBe(comparator);
  });
});


describe("cross-pass preservation and execution family audit", () => {
  const note = (name: string): FhirExtension => ({ url: "https://example.org/" + name, valueString: name });
  const day = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d", code: "d" }
  });
  const ordinary = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
  const courses: Array<[string, FhirR6DosageInstruction]> = [
    ["ordinary exact dose", { step: [{ component: [ordinary] }] }],
    ["zero-step source, unknown metadata and approximate safety", {
      id: "source-only", renderedInstruction: "Call for directions", extension: [note("course")],
      safety: { ifExceeded: "call", doseLimit: [{ scope: "administration", valueQuantity: { value: 5, unit: "mg", comparator: "~" } }] }
    }],
    ["dated phases with site and entry metadata", { id: "phases", extension: [note("course")], step: [
      { id: "early", end: day(7), extension: [note("phase")], component: [{ ...ordinary,
        site: { id: "eye", extension: [note("site")], concept: { text: "left eye" } } }] },
      { id: "late", start: day(7), end: day(14), component: [{ doseAndRate: [{ id: "dose",
        type: { text: "ordered" }, extension: [note("entry")],
        doseQuantity: simpleQuantityForR5({ value: 0.5, unit: "tab", comparator: "~" })! }] }] }
    ] }],
    ["condition with unfamiliar coding metadata", { step: [{ component: [{ ...ordinary, condition: [{
      code: { text: "Pressure", extension: [note("code")] }, operation: "gt",
      valueQuantity: { value: 160 }, text: "above 160", extension: [note("condition")]
    }] }] }] }],
    ["approximate cycle and interlaced active window", { repeatCycle: { value: 28, unit: "d", code: "d", comparator: "~" },
      step: [{ component: [{ ...ordinary, timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, unit: "d", code: "d" }, endOffset: { value: 5, unit: "d", code: "d" }
      } } }] }] }],
    ["approximate duration with regular cadence", { step: [{ component: [{ ...ordinary, timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      boundsDuration: { value: 7, unit: "d", code: "d", comparator: "~" }
    } } }] }] }]
  ];

  it.each(courses)("keeps %s stable through strict R5, imported R5, and repeated saves", (_name, source) => {
    const rows = toFhirR5Dosages(source);
    const recovered = toDosageDetails(JSON.parse(JSON.stringify(rows)));
    expect(recovered).toEqual(source);
    expect(toDosageDetails(JSON.parse(JSON.stringify(fromFhir(source).fhir)))).toEqual(source);
    let saved = rows;
    for (let count = 0; count < 3; count++) {
      saved = toFhirR5Dosages(toDosageDetails(JSON.parse(JSON.stringify(saved))));
      expect(saved).toEqual(rows);
      expect(JSON.stringify(saved).length).toBe(JSON.stringify(rows).length);
    }
  });

  it.each([
    ["UTC", "2026-11-02T00:00:00Z", "2026-11-02T08:00:00+00:00", "2026-11-04T08:00:00+00:00"],
    ["UTC", "2026-11-02T14:00:00Z", "2026-11-02T20:00:00+00:00", "2026-11-05T08:00:00+00:00"],
    ["Asia/Bangkok", "2026-11-02T23:59:00+07:00", "2026-11-03T08:00:00+07:00", "2026-11-05T08:00:00+07:00"],
    ["America/New_York", "2027-03-07T14:00:00-05:00", "2027-03-07T20:00:00-05:00", "2027-03-10T08:00:00-05:00"],
    ["America/New_York", "2026-10-26T14:00:00-04:00", "2026-10-26T20:00:00-04:00", "2026-10-29T08:00:00-04:00"]
  ])("counts full and active/rest calendar families at %s %s", (timeZone, anchor, firstClock, firstActive) => {
    const options = { from: anchor, orderedAt: anchor, timeZone, limit: 44 };
    const clock: FhirDosage = { ...ordinary, timing: { repeat: {
      frequency: 42, period: 21, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00", "20:00:00"]
    } } };
    const clockDates = nextDueDoses(clock, options);
    expect(clockDates[0]).toBe(firstClock);
    expect(new Set(clockDates).size).toBe(clockDates.length);
    expect(calculateTotalUnits({ dosage: clock, ...options, durationValue: 21, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
    const active: FhirR6DosageInstruction = { repeatCycle: { value: 28, code: "d", unit: "d" },
      step: [{ component: [{ ...ordinary, timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "d", unit: "d" }, endOffset: { value: 5, code: "d", unit: "d" }, timeOfDay: ["08:00:00"]
      } } }] }] };
    const due = nextDueDoses(active, options);
    expect(due[0]).toBe(firstActive);
    expect(new Set(due).size).toBe(due.length);
    expect(nextDueDoses(toFhirR5Dosages(active), options)).toEqual(due);
    for (const dosage of [active, toFhirR5Dosages(active)])
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 56, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
  });

  it("keeps yearly course boundaries across a spring gap without turning annual into elapsed days", () => {
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 1, unit: "a", code: "a" },
      step: [{ start: day(0), end: day(1), component: [{ ...ordinary,
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } }
      }] }]
    };
    const options = { from: "2026-03-14T02:30:00-04:00", orderedAt: "2026-03-14T02:30:00-04:00",
      timeZone: "America/New_York", limit: 3 };
    const expected = ["2026-03-14T08:00:00-04:00", "2027-03-14T08:00:00-04:00", "2028-03-14T08:00:00-04:00"];
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(dosage, options)).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 366, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    }
  });
});

describe("adversarial clinical preservation and cycle wall-clock audit", () => {
  const named = (id: string): FhirExtension => ({
    url: "https://example.org/" + id, valueString: id
  });
  const quantityLimit = (
    scope: "administration" | "lifetime" | "period",
    value: number, unit: string, id: string, days?: number
  ) => ({
    scope, id,
    valueQuantity: { value, unit },
    ...(days ? { period: { value: days, unit: "d", code: "d" } } : {}),
    extension: [named(id)]
  });
  const courseWithSafety = (limits: ReturnType<typeof quantityLimit>[]): FhirR6DosageInstruction => ({
    step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { ifExceeded: "stop", doseLimit: limits }
    }] }]
  });
  const activeLimits = (course: FhirR6DosageInstruction) =>
    course.step[0].component[0].safety?.doseLimit ?? [];

  it.each(["administration", "lifetime"] as const)(
    "keeps unprojected %s R6 limits active after every R5 singular and period edit", scope => {
      const hidden = quantityLimit(scope, 5, "mg", "hidden-" + scope);
      const owned = quantityLimit(scope, 0.1, "mg/kg", "owned-" + scope);
      const period = quantityLimit("period", 40, "mg", "daily", 1);
      const original = courseWithSafety([hidden, owned, period]);
      const projection = toFhirR5Dosages(original)[0];
      expect(scope === "administration"
        ? projection.maxDosePerAdministration?.value
        : projection.maxDosePerLifetime?.value).toBe(0.1);
      for (const [label, edit] of [
        ["period edit", (row: FhirDosage) => { row.maxDosePerPeriod![0].numerator.value = 50; }],
        ["scalar edit", (row: FhirDosage) => {
          if (scope === "administration") row.maxDosePerAdministration!.value = 0.2;
          else row.maxDosePerLifetime!.value = 0.2;
        }],
        ["scalar delete", (row: FhirDosage) => {
          if (scope === "administration") delete row.maxDosePerAdministration;
          else delete row.maxDosePerLifetime;
        }],
        ["period delete", (row: FhirDosage) => { delete row.maxDosePerPeriod; }]
      ] as const) {
        const row = JSON.parse(JSON.stringify(projection)) as FhirDosage;
        edit(row);
        const restored = toDosageDetails([row]);
        const limits = activeLimits(restored);
        expect(limits, label).toContainEqual(hidden);
        expect(limits.some(limit => limit.scope === scope &&
          limit.id === owned.id)).toBe(label !== "scalar delete");
        const expectedOwner = label === "scalar edit" ? 0.2 : 0.1;
        if (label !== "scalar delete") expect(limits.find(limit =>
          limit.id === owned.id)?.valueQuantity?.value).toBe(expectedOwner);
        expect(restored.step[0].component[0].safety?.ifExceeded).toBe("stop");
        // Repeated strict export/reopen must not expose the hidden 5-mg
        // limit as a replacement of the surviving weight-based maximum.
        const r5 = toFhirR5Dosages(restored);
        if (label !== "scalar delete") {
          const scalar = scope === "administration"
            ? r5[0].maxDosePerAdministration : r5[0].maxDosePerLifetime;
          expect(scalar?.value).toBe(expectedOwner);
          expect(scalar?.unit).toBe("mg/kg");
        }
        const reopened = toDosageDetails(r5);
        expect(activeLimits(reopened)).toEqual(limits);
        expect(JSON.stringify(reopened).includes(hidden.id)).toBe(true);
      }
    }
  );

  it("never moves a deleted period limit's metadata onto a replacement with another unit/window", () => {
    const a = quantityLimit("period", 5, "mg", "A", 1);
    const b = quantityLimit("period", 10, "mg", "B", 7);
    const original = courseWithSafety([a, b]);
    const rows = toFhirR5Dosages(original);
    rows[0].maxDosePerPeriod!.shift();
    rows[0].maxDosePerPeriod!.push({
      numerator: { value: 5, unit: "mL" },
      denominator: { value: 30, unit: "d", code: "d" }
    });
    const restored = toDosageDetails(rows);
    const limits = activeLimits(restored);
    expect(limits).toHaveLength(2);
    expect(limits[0]).toEqual(b);
    expect(limits[1].valueQuantity).toEqual({ value: 5, unit: "mL" });
    expect(limits[1].id).toBeUndefined();
    expect(limits[1].extension).toBeUndefined();
    expect(JSON.stringify(restored.extension)).toContain("example.org/A");
    expect(activeLimits(toDosageDetails(toFhirR5Dosages(restored)))).toEqual(limits);
  });

  it("keeps zero-step prior instructions as flat bounded provenance, not exponential nested markers", () => {
    let course: FhirR6DosageInstruction = {
      id: "text-only", renderedInstruction: "version 0",
      extension: [named("unknown-clinical-annotation")],
      safety: { doseLimit: [{ scope: "administration",
        valueQuantity: { value: 5, unit: "mg" } }] }, step: []
    };
    const sizes: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const rows = toFhirR5Dosages(course);
      expect(rows).toHaveLength(1);
      expect(rows[0].doseAndRate).toBeUndefined();
      rows[0].text = "version " + i;
      course = toDosageDetails(rows);
      expect(course.step).toBeUndefined();
      expect(course.id).toBe("text-only");
      expect(course.renderedInstruction).toBe("version " + i);
      expect(course.extension).toContainEqual(named("unknown-clinical-annotation"));
      expect(course.safety?.doseLimit?.[0].valueQuantity?.value).toBe(5);
      const originalSources = course.extension?.filter(ext =>
        ext.url.includes("reconciliation-source")) ?? [];
      expect(originalSources).toHaveLength(i);
      const instructions = originalSources.map(source => source.extension?.[0].extension
        ?.find(field => field.url === "dosageDetails")?.extension
        ?.find(field => field.url === "renderedInstruction")?.valueString);
      expect(instructions.slice().sort()).toEqual(Array.from({ length: i }, (_, previous) => "version " + previous).sort());
      expect(new Set(instructions).size).toBe(i);
      // Each previous source is one historical snapshot, with no nested
      // source-history child that would double storage on every save.
      expect(originalSources.every(source => source.extension?.length === 1 &&
        !JSON.stringify(source.extension?.[0]).includes(
          '"url":"urn:ezmedicationinput:StructureDefinition:medication-course-reconciliation-source"'
        ))).toBe(true);
      const next = toFhirR5Dosages(course);
      sizes.push(JSON.stringify(next).length);
      expect(toDosageDetails(next).renderedInstruction).toBe("version " + i);
    }
    expect(sizes[11]).toBeLessThan(sizes[0] * 13);
    expect(sizes[11]).toBeLessThan(18000);
  });

  it.each([
    ["approximately 1 million units PO daily", 1_000_000, "U", "~"],
    ["1 million units PO daily", 1_000_000, "U", undefined],
    ["~1 million units IV once", 1_000_000, "U", "~"],
    [">=2 million IU daily", 2_000_000, "IU", ">="],
    ["approximately 2.4M IU IM once", 2_400_000, "IU", "~"],
    ["~2.4M IU IM once", 2_400_000, "IU", "~"],
    [">=2.4m IU IM once", 2_400_000, "IU", ">="],
    ["1m IU IM once", 1_000_000, "IU", undefined],
    ["approx 2.5 million mg PO once", 2_500_000, "mg", "~"]
  ] as const)("retains numeric million scaling and comparator for %s",
    (text, amount, unit, comparator) => {
      const parsed = parseSig(text);
      const sourceQuantity = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
      expect(sourceQuantity?.value).toBe(amount);
      expect(sourceQuantity?.unit).toBe(unit);
      expect(getQuantityComparator(sourceQuantity)).toBe(comparator);
      const rows = toFhirR5Dosages(parsed.fhirNext);
      expect(rows[0].doseAndRate?.[0].doseQuantity?.value).toBe(amount);
      expect(getQuantityComparator(rows[0].doseAndRate?.[0].doseQuantity)).toBe(comparator);
      expect(toDosageDetails(rows).step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(amount);
      expect(parsed.input).toBe(text);
    });
});

describe("adversarial DST calendar-cycle and clockless active-window oracles", () => {
  const relative = (value: number, unit = "d") => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] },
    offsetDuration: { value, unit, code: unit }
  });
  const daily = {
    timing: { repeat: { frequency: 1, period: 1,
      periodUnit: FhirPeriodUnit.Day, timeOfDay: ["03:00:00"] } },
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
  };
  const repeated = (
    amount: number, unit: string
  ): FhirR6DosageInstruction => ({
    repeatCycle: { value: amount, unit, code: unit },
    step: [{ start: relative(0), end: relative(amount, unit),
      component: [daily] }]
  });
  it.each([
    ["28 days", 28, "d", "2027-02-14T02:30:00-05:00", "2027-04-11"],
    ["4 weeks", 4, "wk", "2027-02-14T02:30:00-05:00", "2027-04-11"],
    ["one month", 1, "mo", "2027-02-14T02:30:00-05:00", "2027-04-14"],
    ["one year", 1, "a", "2026-03-14T02:30:00-04:00", "2027-03-14"]
  ] as const)(
    "retains original wall clock through spring gap for %s",
    (_label, count, unit, anchor, boundary) => {
      const source = repeated(count, unit);
      const options = { from: anchor, orderedAt: anchor,
        timeZone: "America/New_York", limit: unit === "a" ? 730 : 90 };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const due = nextDueDoses(input, options);
        expect(due.length).toBeGreaterThan(32);
        expect(new Set(due).size).toBe(due.length);
        expect(due.filter(date => date.startsWith(boundary + "T03:00:00"))).toHaveLength(1);
        for (const date of due) expect(date).toMatch(/T03:00:00[-+]\d\d:\d\d$/);
        if (unit !== "a") expect(calculateTotalUnits({
          dosage: input, ...options,
          durationValue: 84, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(84);
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
  );
  it.each([7, 21, 42])(
    "keeps clockless %i-of-28 active-window events on local calendar dates through fall DST",
    frequency => {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: { frequency, period: 28, periodUnit: FhirPeriodUnit.Day,
          endOffset: { value: 7, unit: "d", code: "d" } } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }] };
      const options = { from: "2026-10-26T00:00:00-04:00",
        orderedAt: "2026-10-26T00:00:00-04:00",
        timeZone: "America/New_York", limit: 65 };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const due = nextDueDoses(input, options);
        const cycleEnd = Date.parse("2026-11-16T00:00:00-05:00");
        const first = due.filter(date => Date.parse(date) < cycleEnd);
        expect(first).toHaveLength(frequency);
        expect(due[first.length]).toBe("2026-11-23T00:00:00-05:00");
        expect(new Set(first).size).toBe(frequency);
        if (frequency === 7) expect(first).toEqual([
          "2026-10-26T00:00:00-04:00", "2026-10-29T00:00:00-04:00",
          "2026-11-01T00:00:00-04:00", "2026-11-04T00:00:00-05:00",
          "2026-11-07T00:00:00-05:00", "2026-11-10T00:00:00-05:00",
          "2026-11-13T00:00:00-05:00",
        ]);
        for (const date of first) {
          expect(Number.isFinite(Date.parse(date))).toBe(true);
          const hour = date.slice(11, 13);
          if (frequency === 21 || frequency === 7) expect(hour).toBe("00");
          else expect(["00", "12"]).toContain(hour);
        }
        expect(calculateTotalUnits({ dosage: input, ...options,
          durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(frequency);
      }
    }
  );
  it("preserves q24h elapsed intervals even as calendar-day dose windows stay wall-clock aligned", () => {
    const from = "2026-10-31T08:00:00-04:00";
    const dosage: FhirDosage = { ...daily,
      timing: { repeat: { frequency: 1, period: 24, periodUnit: FhirPeriodUnit.Hour } }
    };
    const due = nextDueDoses(dosage, {
      from, orderedAt: from, timeZone: "America/New_York", limit: 3
    });
    expect(due).toEqual([
      "2026-10-31T08:00:00-04:00",
      "2026-11-01T07:00:00-05:00",
      "2026-11-02T07:00:00-05:00"
    ]);
  });
});

describe("review 17: course history, imported rate ranges and civil-clock caps", () => {
  const relative = (value: number, unit = "d") => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event",
      code: "treatment-start"
    }] },
    offsetDuration: { value, unit, code: unit }
  });
  const daily = (clock: string, boundsDuration?: { value: number; unit: string; code: string }) => ({
    timing: { repeat: { frequency: 1, period: 1,
      periodUnit: FhirPeriodUnit.Day, timeOfDay: [clock],
      ...(boundsDuration ? { boundsDuration } : {}) } },
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
  });

  it("preserves prior flat text-only source when course.extension is explicitly replaced", () => {
    let course: FhirR6DosageInstruction = {
      renderedInstruction: "Version A",
      extension: [{ url: "https://example.org/old-annotation", valueString: "old" }],
      safety: { doseLimit: [{ scope: "administration",
        valueQuantity: { value: 5, unit: "mg" } }] },
      step: []
    };
    const texts = ["Version A"];
    let firstSize = 0;
    for (let index = 1; index <= 10; index++) {
      const rows = toFhirR5Dosages(course);
      rows[0].text = "Version " + index;
      const annotation = index === 2
        ? { extension: [{ url: "https://example.org/new-annotation", valueString: "new" }] }
        : undefined;
      course = toDosageDetails(JSON.parse(JSON.stringify(rows)), undefined, annotation);
      expect(course.step).toBeUndefined();
      expect(course.renderedInstruction).toBe("Version " + index);
      expect(course.safety?.doseLimit?.[0].valueQuantity?.value).toBe(5);
      const sources = course.extension?.filter(ext => ext.url.includes("reconciliation-source")) ?? [];
      expect(sources).toHaveLength(index);
      const rawHistory = JSON.stringify(sources);
      for (const text of texts) expect(rawHistory).toContain(text);
      expect(rawHistory).toContain("old-annotation");
      if (index >= 2) expect(course.extension).toContainEqual({
        url: "https://example.org/new-annotation", valueString: "new"
      });
      const reopened = toDosageDetails(toFhirR5Dosages(course));
      expect(reopened.renderedInstruction).toBe(course.renderedInstruction);
      expect(reopened.extension).toEqual(course.extension);
      const bytes = JSON.stringify(toFhirR5Dosages(course)).length;
      if (!firstSize) firstSize = bytes;
      if (index === 10) expect(bytes).toBeLessThan(firstSize * 11);
      texts.push(course.renderedInstruction!);
    }
  });

  it.each([
    ["en", "Rate range: 50–100 mL/h"],
    ["th", "ช่วงอัตราการให้ยา: 50–100 mL/h"]
  ] as const)("renders source-less %s R6 rateRange in whole course and individual item", (locale, expected) => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 500, unit: "mL" },
        rateRange: { low: { value: 50, unit: "mL/h" },
          high: { value: 100, unit: "mL/h" } } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const parsed = fromFhir(source, { locale });
    expect(parsed.longText).toContain(expected);
    expect(parsed.items[0].longText).toContain(expected);
    expect(parsed.longText).toContain("500");
    expect(parsed.fhirNext).toEqual(source);
    const r5 = toFhirR5Dosages(source)[0];
    expect(formatSig(r5, "long", { locale })).toContain(expected);
    expect(fromFhirDosage(r5, { locale }).longText).toContain(expected);
    expect(toDosageDetails([r5])).toEqual(source);
    source.step[0].component[0].text = "Infuse using the written rate plan";
    expect(fromFhir(source, { locale }).items[0].longText).toContain(expected);
    expect(fromFhir(source, { locale }).items[0].longText).toContain("500");
    expect(fromFhir(source, { locale }).fhirNext.step[0].component[0].text)
      .toBe("Infuse using the written rate plan");
  });

  it("renders one-sided imported rateRange bounds without inventing an exact rate", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 500, unit: "mL" },
        rateRange: { high: { value: 100, unit: "mL/h" } } }]
    }] }] };
    const output = fromFhir(source);
    expect(output.items[0].longText).toContain("Rate range: <=100 mL/h");
    expect(output.items[0].longText).not.toContain("Rate: 100");
    expect(output.fhirNext).toEqual(source);
  });

  it.each([
    ["28 d", 28, "d", "2027-02-14T02:30:00-05:00", "2027-04-11"],
    ["4 wk", 4, "wk", "2027-02-14T02:30:00-05:00", "2027-04-11"],
    ["1 mo", 1, "mo", "2027-02-14T02:30:00-05:00", "2027-04-14"]
  ] as const)("inherits original logical clock for native component %s duration caps",
    (label, n, unit, anchor, boundary) => {
      const component = daily("03:00:00", { value: n, unit, code: unit });
      const source: FhirR6DosageInstruction = {
        repeatCycle: { value: n, unit, code: unit },
        step: [{ component: [component] }]
      };
      const opts = { orderedAt: anchor, from: anchor,
        timeZone: "America/New_York", limit: 95 };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const dates = nextDueDoses(input, opts);
        expect(dates.filter(x => x.startsWith(boundary + "T03:00:00"))).toHaveLength(1);
        expect(new Set(dates).size).toBe(dates.length);
        expect(calculateTotalUnits({ dosage: input, ...opts,
          durationValue: 84, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(84);
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
  );

  it("keeps original-clock ownership for component boundsRange and source-retained duration", () => {
    const original = "2027-02-14T02:30:00-05:00";
    for (const bounds of [
      { boundsRange: { high: { value: 28, unit: "d", code: "d" } } },
      { boundsDuration: { value: 28, unit: "d", code: "d" } }
    ]) {
      const source: FhirR6DosageInstruction = {
        repeatCycle: { value: 28, unit: "d", code: "d" },
        step: [{ component: [{ timing: { repeat: {
          frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["03:00:00"], ...bounds
        } }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }]
      };
      for (const dosage of [source, toFhirR5Dosages(source)]) {
        const opts = { from: original, orderedAt: original,
          timeZone: "America/New_York", limit: 86 };
        const dates = nextDueDoses(dosage, opts);
        expect(dates.filter(x => x.startsWith("2027-04-11T03:00:00"))).toHaveLength(1);
        expect(calculateTotalUnits({ dosage, ...opts,
          durationValue: 84, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(84);
      }
    }
  });

  it("keeps a calendar week at the original civil time, unlike an elapsed 168-hour interval", () => {
    const from = "2026-10-26T00:00:00-04:00";
    const opts = { from, orderedAt: from,
      timeZone: "America/New_York", limit: 5 };
    const make = (period: number, periodUnit: FhirPeriodUnit) => ({
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period, periodUnit } }
    });
    const calendar = [
      "2026-10-26T00:00:00-04:00",
      "2026-11-02T00:00:00-05:00",
      "2026-11-09T00:00:00-05:00",
      "2026-11-16T00:00:00-05:00",
      "2026-11-23T00:00:00-05:00"
    ];
    const elapsed = [
      "2026-10-26T00:00:00-04:00",
      "2026-11-01T23:00:00-05:00",
      "2026-11-08T23:00:00-05:00",
      "2026-11-15T23:00:00-05:00",
      "2026-11-22T23:00:00-05:00"
    ];
    for (const dosage of [
      make(7, FhirPeriodUnit.Day),
      make(1, FhirPeriodUnit.Week)
    ]) {
      expect(nextDueDoses(dosage, opts)).toEqual(calendar);
      expect(calculateTotalUnits({ dosage, ...opts,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
    }
    const q168h = make(168, FhirPeriodUnit.Hour);
    expect(nextDueDoses(q168h, opts)).toEqual(elapsed);
    expect(calculateTotalUnits({ dosage: q168h, ...opts,
      durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(5);
  });

  it("does not apply parent civil-clock to a new stage begun by elapsed +3h", () => {
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, unit: "d", code: "d" },
      step: [{ start: relative(3, "h"),
        component: [daily("04:00:00", { value: 28, unit: "d", code: "d" })] }]
    };
    const from = "2027-02-14T02:30:00-05:00";
    for (const dosage of [source, toFhirR5Dosages(source), fromFhir(source)]) {
      const opts = { from, orderedAt: from, timeZone: "America/New_York", limit: 90 };
      const dates = nextDueDoses(dosage, opts);
      expect(dates).toContain("2027-03-14T04:00:00-04:00");
      expect(dates.filter(x => x.startsWith("2027-04-11T04:00:00"))).toHaveLength(1);
      expect(new Set(dates).size).toBe(dates.length);
      expect(calculateTotalUnits({ dosage, ...opts,
        durationValue: 84, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(83);
    }
  });
});


describe("review 18: empty stages, course header provenance, and inherited civil clocks", () => {
  it("preserves explicitly added incomplete stages without fabricating medication administrations", () => {
    const source: FhirR6DosageInstruction = {
      id: "text-course", renderedInstruction: "Use as directed", step: []
    };
    const oldRows = toFhirR5Dosages(source);
    const oldMarker = JSON.stringify(oldRows[0].modifierExtension);
    const edited = toDosageDetails(oldRows, undefined, { step: [{
      sequence: 1, id: "future-stage",
      start: { offsetDuration: { value: 2, unit: "d" } }
    }] });
    expect(edited.step).toBeUndefined();
    const editableStages = importCanonicalCourse(edited).stages;
    expect(editableStages).toHaveLength(1);
    expect(editableStages[0].administrations).toEqual([]);
    expect(editableStages[0].start?.displacement?.value).toBe(2);
    expect(editableStages[0].provenance?.id).toBe("future-stage");
    expect(edited.renderedInstruction).toBe(source.renderedInstruction);
    expect(JSON.stringify(edited.extension)).toContain("dosageDetails");
    expect(oldMarker).toContain("dosageDetails");

    const carrier = toFhirR5Dosages(edited);
    expect(carrier).toHaveLength(1);
    expect(carrier[0].doseAndRate).toBeUndefined();
    expect(carrier[0].timing).toBeUndefined();
    const reopened = toDosageDetails(JSON.parse(JSON.stringify(carrier)));
    expect(reopened.step).toBeUndefined();
    expect(importCanonicalCourse(reopened).stages[0].start?.displacement?.value).toBe(2);
    expect(importCanonicalCourse(reopened).stages[0].provenance?.id).toBe("future-stage");
    expect(reopened.renderedInstruction).toBe(source.renderedInstruction);
    const again = toDosageDetails(toFhirR5Dosages(reopened));
    expect(again.step).toBeUndefined();
    expect(importCanonicalCourse(again).stages[0].provenance?.id).toBe("future-stage");

    // Stage-only data also needs a carrier even with no whole-course text.
    const stageOnly: FhirR6DosageInstruction = { step: [{
      id: "pending", component: [],
      end: { offsetDuration: { value: 3, unit: "d" } }
    }] };
    const stageRows = toFhirR5Dosages(stageOnly);
    expect(stageRows).toHaveLength(1);
    expect(stageRows[0].doseAndRate).toBeUndefined();
    const stageOutput = toDosageDetails(stageRows);
    expect(stageOutput.step).toBeUndefined();
    const stageDraft = importCanonicalCourse(stageOutput).stages[0];
    expect(stageDraft.administrations).toEqual([]);
    expect(stageDraft.provenance?.id).toBe("pending");
    expect(stageDraft.end?.displacement?.value).toBe(3);
  });

  it("keeps superseded course-level safety metadata when a compact header is replaced", () => {
    const oldExtension: FhirExtension = {
      url: "https://example.org/old-course-safety", valueString: "old"
    };
    const original: FhirR6DosageInstruction = {
      id: "course-header",
      safety: { extension: [oldExtension],
        doseLimit: [{ scope: "administration", valueQuantity: { value: 5, unit: "mg" } }] },
      step: [{ component: [{ doseAndRate: [{
        doseQuantity: { value: 1, unit: "tab" }
      }] }] }]
    };
    const rows = toFhirR5Dosages(original);
    expect(toDosageDetails(rows)).toEqual(original);
    const replace = (amount: number, label: string) => ({
      safety: { extension: [{
        url: "https://example.org/" + label, valueString: label
      }], doseLimit: [{
        scope: "administration" as const, valueQuantity: { value: amount, unit: "mg" }
      }] }
    });
    const first = toDosageDetails(rows, undefined, replace(8, "new-course-safety"));
    expect(first.safety?.doseLimit?.[0].valueQuantity?.value).toBe(8);
    expect(first.safety?.extension?.[0].url).toContain("new-course-safety");
    expect(first.safety?.extension?.some(item => item.url === oldExtension.url)).toBe(false);
    expect(JSON.stringify(first.extension)).toContain(oldExtension.url);
    expect(first.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);

    const reopened = toDosageDetails(toFhirR5Dosages(first));
    expect(reopened.safety).toEqual(first.safety);
    expect(JSON.stringify(reopened.extension)).toContain(oldExtension.url);
    const again = toDosageDetails(toFhirR5Dosages(reopened), undefined,
      replace(10, "latest-course-safety"));
    expect(again.safety?.doseLimit?.[0].valueQuantity?.value).toBe(10);
    expect(JSON.stringify(again.extension)).toContain("old-course-safety");
    expect(JSON.stringify(again.extension)).toContain("new-course-safety");
    const final = toDosageDetails(toFhirR5Dosages(again));
    expect(final.safety).toEqual(again.safety);
    expect(final.extension).toEqual(again.extension);
  });

  it("keeps successive course-header safety edits flat across annotation replacement", () => {
    const note = (label: string): FhirExtension => ({
      url: "https://example.org/" + label, valueString: label
    });
    let current: FhirR6DosageInstruction = {
      id: "header",
      extension: [note("initial-annotation")],
      safety: { extension: [note("original-safety")],
        doseLimit: [{ scope: "administration",
          valueQuantity: { value: 5, unit: "mg" } }] },
      step: [{ component: [{ doseAndRate: [{
        doseQuantity: { value: 1, unit: "tab" }
      }] }] }]
    };
    const sizes: number[] = [];
    for (let index = 1; index <= 10; index++) {
      const edited = {
        ...(index === 2 ? { extension: [note("replacement-annotation")] } : {}),
        safety: { extension: [note("safety-" + index)],
          doseLimit: [{ scope: "administration" as const,
            valueQuantity: { value: index + 5, unit: "mg" } }] }
      };
      current = toDosageDetails(toFhirR5Dosages(current), undefined, edited);
      const raw = JSON.stringify(current);
      expect(current.safety?.doseLimit?.[0].valueQuantity?.value).toBe(index + 5);
      expect(raw).toContain("original-safety");
      expect(raw).toContain("initial-annotation");
      if (index >= 2) expect(current.extension).toContainEqual(
        note("replacement-annotation"));
      const sources = current.extension?.filter(extension =>
        extension.url.includes("reconciliation-source")) ?? [];
      expect(sources).toHaveLength(index);
      const rows = toFhirR5Dosages(current);
      sizes.push(JSON.stringify(rows).length);
      expect(toDosageDetails(rows).safety).toEqual(current.safety);
      expect(toDosageDetails(rows).extension).toEqual(current.extension);
    }
    expect(sizes[9]).toBeLessThan(sizes[0] * 10);
  });

  it("inherits the previous stage's clock across implicit successors in repeated courses", () => {
    const relative = {
      contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event",
        code: "treatment-start" }] },
      offsetDuration: { value: 3, unit: "h", code: "h" }
    };
    const component = {
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["04:00:00"], boundsDuration: { value: 1, unit: "d", code: "d" }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const steps = [
      { start: relative, component: [component] },
      { component: [component] }
    ];
    for (const source of [
      { step: steps },
      { repeatCycle: { value: 7, unit: "d", code: "d" }, step: steps }
    ] as FhirR6DosageInstruction[]) for (const dosage of [
      source, toFhirR5Dosages(source), fromFhir(source)
    ]) {
      const options = { from: "2026-11-02T02:30:00Z",
        orderedAt: "2026-11-02T02:30:00Z", timeZone: "UTC", limit: 10 };
      const dates = nextDueDoses(dosage, options);
      expect(dates.slice(0, 2)).toEqual([
        "2026-11-03T04:00:00+00:00",
        "2026-11-04T04:00:00+00:00"
      ]);
      if (source.repeatCycle) expect(dates.slice(2, 4)).toEqual([
        "2026-11-10T04:00:00+00:00",
        "2026-11-11T04:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits)
        .toBe(source.repeatCycle ? 4 : 2);
    }
  });

  it("retains the predecessor stage's civil clock across DST rather than adopting a gap-shifted hour", () => {
    const relative = { contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] }, offsetDuration: { value: 3, unit: "h", code: "h" } };
    const component = { timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      timeOfDay: ["04:00:00"], boundsDuration: { value: 1, unit: "d", code: "d" }
    } }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, unit: "d", code: "d" },
      step: [{ start: relative, component: [component] }, { component: [component] }]
    };
    const options = { from: "2027-03-13T02:30:00-05:00",
      orderedAt: "2027-03-13T02:30:00-05:00",
      timeZone: "America/New_York", limit: 12 };
    for (const dosage of [source, toFhirR5Dosages(source), fromFhir(source)]) {
      const due = nextDueDoses(dosage, options);
      expect(due).toContain("2027-03-14T04:00:00-04:00");
      expect(due).toContain("2027-03-15T04:00:00-04:00");
      expect(due).toContain("2027-04-11T04:00:00-04:00");
      expect(due).toContain("2027-04-12T04:00:00-04:00");
      expect(new Set(due).size).toBe(due.length);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 56,
        durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
    }
  });
});


describe("review 19: live site coding and elapsed repeat-cycle clock ownership", () => {
  const sourceSite: FhirR6DosageInstruction = { step: [{ component: [{
    site: {
      id: "original-site",
      extension: [{ url: "https://example.org/site-wrapper", valueString: "source" }],
      concept: { text: "right eye", coding: [{
        system: "http://snomed.info/sct", code: "right-eye",
        display: "Right eye", version: "2024-legacy"
      }] },
      reference: { reference: "BodyStructure/OD", display: "Right eye" }
    },
    doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }]
  }] }] };

  it("preserves validator-added Coding.version while restoring the R6 site wrapper and reference", () => {
    for (const version of ["2026.11", "2028.05", "2024-legacy"]) {
      const rows = toFhirR5Dosages(sourceSite);
      rows[0].site!.coding![0].version = version;
      const before = JSON.stringify(rows);
      const restored = toDosageDetails(rows);
      const site = restored.step[0].component[0].site!;
      expect(site.id).toBe("original-site");
      expect(site.extension).toEqual(sourceSite.step[0].component[0].site!.extension);
      expect(site.reference).toEqual(sourceSite.step[0].component[0].site!.reference);
      expect(site.concept?.coding?.[0].version).toBe(version);
      expect(site.concept?.text).toBe("right eye");
      expect(JSON.stringify(rows)).toBe(before);
      const reopened = toDosageDetails(toFhirR5Dosages(restored));
      expect(reopened.step[0].component[0].site).toEqual(site);
      expect(reopened.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);
    }
  });

  it("keeps unrelated route and method coding versions when a site wrapper is restored", () => {
    const original: FhirR6DosageInstruction = {
      step: [{ component: [{
        ...sourceSite.step[0].component[0],
        route: { coding: [{ system: "https://example.org/route", code: "ocular" }] },
        method: { coding: [{ system: "https://example.org/method", code: "instill" }] }
      }] }]
    };
    const rows = toFhirR5Dosages(original);
    rows[0].site!.coding![0].version = "site-new";
    rows[0].route!.coding![0].version = "route-new";
    rows[0].method!.coding![0].version = "method-new";
    const out = toDosageDetails(rows).step[0].component[0];
    expect(out.site?.concept?.coding?.[0].version).toBe("site-new");
    expect(out.route?.coding?.[0].version).toBe("route-new");
    expect(out.method?.coding?.[0].version).toBe("method-new");
    expect(out.site?.id).toBe("original-site");
    expect(toDosageDetails(toFhirR5Dosages({ step: [{ component: [out] }] }))
      .step[0].component[0]).toEqual(out);
  });

  const elapsedCourse: FhirR6DosageInstruction = {
    repeatCycle: { value: 24, unit: "h", code: "h" },
    step: [{ component: [{
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["03:00:00"], boundsDuration: { value: 1, unit: "d", code: "d" }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }]
  };

  it("gives each elapsed 24-hour cycle a new actual wall clock across spring DST", () => {
    const options = {
      orderedAt: "2027-03-13T02:30:00-05:00",
      from: "2027-03-13T02:30:00-05:00",
      timeZone: "America/New_York", limit: 7
    };
    const expected = [
      "2027-03-13T03:00:00-05:00",
      "2027-03-14T03:00:00-04:00",
      "2027-03-15T03:00:00-04:00",
      "2027-03-16T03:00:00-04:00",
      "2027-03-17T03:00:00-04:00",
      "2027-03-18T03:00:00-04:00",
      "2027-03-19T03:00:00-04:00"
    ];
    for (const dosage of [
      elapsedCourse, toFhirR5Dosages(elapsedCourse), fromFhir(elapsedCourse)
    ]) {
      expect(nextDueDoses(dosage, options)).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 3, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(3);
    }
  });

  it("retains source local clock for calendar cycles while elapsed cycles step from the new instant", () => {
    const source: FhirR6DosageInstruction = {
      ...elapsedCourse,
      repeatCycle: { value: 1, unit: "d", code: "d" }
    };
    const start = "2027-03-13T02:30:00-05:00";
    const options = { from: start, orderedAt: start,
      timeZone: "America/New_York", limit: 12 };
    for (const dosage of [source, toFhirR5Dosages(source)]) {
      const dates = nextDueDoses(dosage, options);
      expect(dates.filter(date => date.startsWith("2027-03-15T03:00:00"))).toHaveLength(1);
      expect(new Set(dates).size).toBe(dates.length);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
    }
  });
});

describe("review 20: typed expression identity and normalized calendar equivalence", () => {
  const type = { coding: [{
    system: "http://snomed.info/sct", code: "12345", display: "Dose kind"
  }] };
  const expr = { language: "text/fhirpath", expression: "%patient.weight * 2" };

  it.each(["doseExpression", "rateExpression"] as const)(
    "preserves type-only %s when a clinician assigns its first Element.id",
    choice => {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ type, [choice]: expr }]
      }] }] };
      const rows = toFhirR5Dosages(source);
      expect(rows[0].doseAndRate?.[0][choice]).toBeUndefined();
      rows[0].doseAndRate![0].id = "new-clinician-entry";
      const output = toDosageDetails(rows);
      expect(output.step[0].component[0].doseAndRate?.[0]).toMatchObject({
        id: "new-clinician-entry", type, [choice]: expr
      });
      expect(toDosageDetails(toFhirR5Dosages(output)).step).toEqual(output.step);
      // The inverse edit (changing an existing ID) is NOT a legitimate type
      // identity match; a different id may represent a different entry.
      const existing: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ id: "original-entry", type, [choice]: expr }]
      }] }] };
      const changed = toFhirR5Dosages(existing);
      changed[0].doseAndRate![0].id = "different-entry";
      expect(toDosageDetails(changed).step[0].component[0].doseAndRate?.[0][choice])
        .toBeUndefined();
    }
  );

  it("keeps distinct expression identities in a typed multiple-entry component", () => {
    const typeB = { coding: [{
      system: "http://snomed.info/sct", code: "67890", display: "Rate kind"
    }] };
    const rate = { language: "text/fhirpath", expression: "%patient.weight / 2" };
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ type, doseExpression: expr },
        { type: typeB, rateExpression: rate }]
    }] }] };
    const rows = toFhirR5Dosages(source);
    rows[0].doseAndRate![0].id = "new-dose-id";
    rows[0].doseAndRate![1].id = "new-rate-id";
    const result = toDosageDetails(rows).step[0].component[0].doseAndRate!;
    expect(result[0]).toMatchObject({ id: "new-dose-id", type, doseExpression: expr });
    expect(result[1]).toMatchObject({ id: "new-rate-id", type: typeB, rateExpression: rate });
    // A numeric edit still supersedes an expression regardless of the new ID.
    const edited = toFhirR5Dosages(source);
    edited[0].doseAndRate![0].id = "new-dose-id";
    edited[0].doseAndRate![0].doseQuantity = { value: 7, unit: "mg" };
    expect(toDosageDetails(edited).step[0].component[0].doseAndRate?.[0])
      .toMatchObject({ id: "new-dose-id", doseQuantity: { value: 7, unit: "mg" } });
    expect(toDosageDetails(edited).step[0].component[0].doseAndRate?.[0].doseExpression)
      .toBeUndefined();
  });

  it("does not guess an identity for duplicate-type source expressions after a new ID", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [
        { type, doseExpression: { language: "text/fhirpath", expression: "%patient.weight * 2" } },
        { type, doseExpression: { language: "text/fhirpath", expression: "%patient.weight * 3" } }
      ]
    }] }] };
    const rows = toFhirR5Dosages(source);
    rows[0].doseAndRate![0].id = "new-entry";
    const reconciled = toDosageDetails(rows);
    const active = reconciled.step[0].component[0].doseAndRate!;
    expect(active[0].id).toBe("new-entry");
    // Two indistinguishable old types provide no unique identity. An
    // unknown expression must not be arbitrarily assigned to a new ID.
    expect(active[0].doseExpression).toBeUndefined();
    expect(active[1].doseExpression?.expression).toBe("%patient.weight * 3");
    expect(JSON.stringify(reconciled.extension)).toContain("%patient.weight * 2");
    expect(toDosageDetails(toFhirR5Dosages(reconciled)).step).toEqual(reconciled.step);
  });

  it.each([
    [0.25, "a", 3, "mo"],
    [0.5, "a", 6, "mo"]
  ] as const)(
    "normalizes calendar %s %s to %s %s for cycle clock ownership",
    (value, unit, equivalent, unitB) => {
      const original: FhirR6DosageInstruction = { repeatCycle: { value, unit, code: unit },
        step: [{ component: [{
          timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["03:00:00"], boundsDuration: {
              value: equivalent, unit: unitB, code: unitB
            } } },
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
        }] }] };
      const alternate: FhirR6DosageInstruction = {
        ...original, repeatCycle: { value: equivalent, unit: unitB, code: unitB }
      };
      const opts = { from: "2026-12-14T02:30:00-05:00",
        orderedAt: "2026-12-14T02:30:00-05:00", timeZone: "America/New_York",
        limit: 400 };
      const expected = nextDueDoses(alternate, opts);
      const amount = calculateTotalUnits({ dosage: alternate, ...opts,
        durationValue: 390, durationUnit: FhirPeriodUnit.Day }).totalUnits;
      // One tablet at 03:00 on each civil day, with no rest gap.
      expect(amount).toBe(390);
      for (const source of [original, alternate]) {
        for (const dosage of [source, toFhirR5Dosages(source), fromFhir(source)]) {
          const actual = nextDueDoses(dosage, opts);
          expect(actual).toEqual(expected);
          expect(new Set(actual).size).toBe(actual.length);
          expect(calculateTotalUnits({ dosage, ...opts,
            durationValue: 390, durationUnit: FhirPeriodUnit.Day }).totalUnits)
            .toBe(390);
        }
        expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
      }
      if (equivalent === 3) {
        expect(expected.filter(time =>
          time.startsWith("2027-06-14T03:00:00"))).toHaveLength(1);
      }
    }
  );
});


describe("November 16 current R6 review: canonical duration qualifier ownership", () => {
  it.each(["~", ">=", "<="] as const)("keeps %s boundsDuration through canonical and parser-state R5 projection", comparator => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { boundsDuration: { value: 7, unit: "d", code: "d", comparator } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const r5 = toFhirR5Dosages(source)[0];
    for (const rebuilt of [
      canonicalToFhir(canonicalFromFhir(r5)),
      parserStateToFhir(parserStateFromFhir(r5))
    ]) {
      expect(rebuilt.timing?.repeat?.boundsDuration?.value).toBe(7);
      expect(getQuantityComparator(rebuilt.timing?.repeat?.boundsDuration)).toBe(comparator);
    }
    expect(canonicalFromFhir(r5).schedule?.duration).toBe(7);
  });

  it("keeps qualified course duration alongside absolute boundsPeriod", () => {
    const source: FhirDosage = {
      timing: { repeat: { boundsPeriod: { start: "2026-11-02" } } },
      modifierExtension: [{
        url: "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration",
        valueQuantity: quantityForR5({ value: 7, unit: "d", code: "d", comparator: "~" })
      }]
    };
    for (const rebuilt of [
      canonicalToFhir(canonicalFromFhir(source)),
      parserStateToFhir(parserStateFromFhir(source))
    ]) {
      expect(rebuilt.timing?.repeat?.boundsPeriod?.start).toBe("2026-11-02");
      const retained = rebuilt.modifierExtension?.find(x =>
        x.url.endsWith("medication-anchored-course-duration"))?.valueQuantity;
      expect(retained?.value).toBe(7);
      expect(getQuantityComparator(retained)).toBe("~");
    }
  });

  it("retains independently qualified low/high ranged bounds, including anchored boundsPeriod", () => {
    const input: FhirDosage = { timing: { repeat: { boundsRange: {
      low: { value: 3, unit: "d", code: "d", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000053" }
      }] },
      high: { value: 7, unit: "d", code: "d", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000052" }
      }] }
    } } } };
    const anchored: FhirDosage = {
      timing: { repeat: { boundsPeriod: { start: "2026-11-02" } } },
      modifierExtension: [{
        url: "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration",
        valueRange: input.timing!.repeat!.boundsRange
      }]
    };
    for (const source of [input, anchored]) {
      const before = JSON.stringify(source);
      for (const restored of [canonicalToFhir(canonicalFromFhir(source)), parserStateToFhir(parserStateFromFhir(source))]) {
        const range = source === input ? restored.timing?.repeat?.boundsRange
          : restored.modifierExtension?.find(x => x.url.endsWith("medication-anchored-course-duration"))?.valueRange;
        expect(getQuantityComparator(range?.low)).toBe(">=");
        expect(getQuantityComparator(range?.high)).toBe("<=");
        expect(range?.low?.value).toBe(3);
        expect(range?.high?.value).toBe(7);
        if (source === anchored) expect(restored.timing?.repeat?.boundsPeriod?.start).toBe("2026-11-02");
      }
      expect(JSON.stringify(source)).toBe(before);
    }
  });
});


describe("November 16 current R6 review: partial rate ratio display", () => {
  it.each([
    [{ numerator: { value: 100, unit: "mL" }, denominator: { unit: "h" } },
      "Rate: 100 mL / unspecified h", "อัตราการให้ยา: 100 mL / ไม่ระบุค่า h"],
    [{ numerator: { value: 100, comparator: "~" as const, unit: "mL" },
       denominator: simpleQuantityForR5({ value: 2, comparator: ">=" as const, unit: "h" })! },
      "Rate: ~100 mL / >=2 h", "อัตราการให้ยา: ~100 mL / >=2 h"],
    [{ numerator: { unit: "mL" }, denominator: { value: 2, unit: "h" } },
      "Rate: unspecified mL / 2 h", "อัตราการให้ยา: ไม่ระบุค่า mL / 2 h"]
  ])("shows known rate numerator/denominator without inventing partial values", (ratio, english, thai) => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ rateRatio: ratio }]
    }] }] };
    for (const [locale, expected] of [["en", english], ["th", thai]] as const) {
      expect(formatSig(course, "long", { locale })).toContain(expected);
      expect(fromFhir(course, { locale }).items[0].longText).toContain(expected);
    }
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
  });
});


describe("November 16 PR #13: SimpleQuantity offset and duration display families", () => {
  const emaApprox = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
    valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" } };

  it("keeps EMA-qualified R6 SimpleQuantity offsets valid through strict R5 persistence and reimport", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 0.25, code: "d", unit: "d", extension: [emaApprox] },
        endOffset: { value: 0.1, code: "d", unit: "d", extension: [emaApprox] }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const unchanged = JSON.stringify(course);
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(course))) as FhirDosage[];
    const rebuilt = toDosageDetails(saved);
    const offsets = rebuilt.step[0].component[0].timing?.repeat;
    expect(offsets?.startOffset).toEqual(course.step[0].component[0].timing?.repeat?.startOffset);
    expect(offsets?.endOffset).toEqual(course.step[0].component[0].timing?.repeat?.endOffset);
    expect(offsets?.startOffset).not.toHaveProperty("comparator");
    expect(offsets?.endOffset).not.toHaveProperty("comparator");
    expect(fromFhir(rebuilt).fhirNext).toEqual(course);
    expect(JSON.stringify(course)).toBe(unchanged);
  });

  it.each([">=", "~", "<="] as const)("renders %s course duration honestly in short and long EN/TH formats", comparator => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsDuration: { value: 7, code: "d", unit: "d", comparator } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const row = toFhirR5Dosages(course)[0];
    for (const locale of ["en", "th"]) {
      const short = formatSig(row, "short", { locale });
      const long = formatSig(row, "long", { locale });
      expect(short).toContain(`x${comparator}7d`);
      expect(long).toContain(`${comparator}7`);
    }
    expect(getQuantityComparator(canonicalToFhir(canonicalFromFhir(row))
      .timing?.repeat?.boundsDuration)).toBe(comparator);
  });

  it("renders independent low/high boundsRange comparators in both language outputs", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { boundsRange: {
        low: simpleQuantityForR5({ value: 3, unit: "d", code: "d", comparator: ">=" })!,
        high: simpleQuantityForR5({ value: 7, unit: "d", code: "d", comparator: "<=" })!
      } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const row = toFhirR5Dosages(course)[0];
    for (const locale of ["en", "th"]) {
      expect(formatSig(row, "short", { locale })).toContain("x>=3-<=7d");
      const long = formatSig(row, "long", { locale });
      expect(long).toContain(">=3");
      expect(long).toContain("<=7");
    }
  });
});


describe("November 16 next review: partial R6 amounts and undefined R5 modifiers", () => {
  it("removes a present-but-undefined rate modifier when projecting editable R5 to R6", () => {
    const row: FhirDosage = { doseAndRate: [{
      doseQuantity: { value: 1, unit: "tab" },
      modifierExtension: undefined
    }] };
    const course = toDosageDetails([row]);
    expect(course.step[0].component[0].doseAndRate?.[0]).not.toHaveProperty("modifierExtension");
    expect(fromFhir(course).fhirNext).toEqual(course);
    expect(row.doseAndRate?.[0]).toHaveProperty("modifierExtension");
  });

  it.each(["en", "th"] as const)("shows a known rate unit without inventing its value in %s", locale => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ rateQuantity: { unit: "mL/h" } }]
    }] }] };
    const text = locale === "th" ? "อัตราการให้ยา: ไม่ระบุค่า mL/h"
      : "Rate: unspecified mL/h";
    expect(formatSig(course, "long", { locale })).toContain(text);
    expect(fromFhir(course, { locale }).items[0].longText).toContain(text);
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
  });
});


describe("review 2026-11-16 19h: explicit empty-stage carrier indices", () => {
  const textOnly: FhirR6DosageInstruction = {
    renderedInstruction: "Original course heading", step: [{ id: "first", component: [] }]
  };
  it("never inserts phantom stages for an out-of-order explicit course.step", () => {
    const saved = toFhirR5Dosages(textOnly);
    const rebuilt = toDosageDetails(saved, undefined, {
      step: [{ sequence: 3, id: "new-stage" }]
    });
    expect(rebuilt.step).toBeUndefined();
    expect(importCanonicalCourse(rebuilt).stages).toHaveLength(1);
    expect(importCanonicalCourse(rebuilt).stages[0].provenance?.id).toBe("first");
    expect(JSON.stringify(rebuilt.extension)).toContain("new-stage");
    expect(JSON.stringify(rebuilt.extension)).toContain("3");
  });
  it("keeps extreme out-of-range indices as inert source without allocating stages", () => {
    const saved = toFhirR5Dosages(textOnly);
    for (const sequence of [1_000_000_000, 1e21]) {
      const rebuilt = toDosageDetails(saved, undefined, {
        step: [{ sequence, id: "unassignable" }]
      });
      expect(rebuilt.step).toBeUndefined();
      expect(importCanonicalCourse(rebuilt).stages).toHaveLength(1);
      expect(importCanonicalCourse(rebuilt).stages[0].provenance?.id).toBe("first");
      expect(JSON.stringify(rebuilt.extension)).toContain("unassignable");
    }
  });
  it("does not synthesize compact R5 stages from an extreme stepCount hint", () => {
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 7, unit: "d", code: "d" },
      step: [{ component: [{ doseAndRate: [{
        doseQuantity: { value: 1, unit: "tab" }
      }] }] }]
    };
    const rows = toFhirR5Dosages(course);
    const row = rows[0].modifierExtension?.find(ext =>
      ext.extension?.some(child => child.url === "stepCount"));
    expect(row).toBeDefined();
    const count = row!.extension!.find(child => child.url === "stepCount")!;
    count.valueInteger = 1_000_000_000;
    const restored = toDosageDetails(rows);
    expect(restored.step).toHaveLength(1);
    expect(restored.step[0].component).toHaveLength(1);
    expect(restored.repeatCycle?.value).toBe(7);
  });

  it("allows an adjacent second stage without inventing gaps", () => {
    const rebuilt = toDosageDetails(toFhirR5Dosages(textOnly), undefined, {
      step: [{ sequence: 2, id: "second" }]
    });
    expect(rebuilt.step).toBeUndefined();
    expect(importCanonicalCourse(rebuilt).stages.map(stage => stage.provenance?.id)).toEqual(["first", "second"]);
  });
});

describe("review 2026-11-16 19h: rateRange surface provenance", () => {
  it.each([
    [{ low: { value: 50, unit: "mL/h", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000051" }
    }] } }, ">50 mL/h"],
    [{ high: { value: 20, unit: "mL/h", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" }
    }] } }, "<20 mL/h"],
    [{ low: { value: 40, unit: "mL/h" } }, ">=40 mL/h"],
    [{ high: { value: 60, unit: "mL/h" } }, "<=60 mL/h"]
  ] as const)("renders one-sided rateRanges with exactly one qualifier", (range, expected) => {
    const dosage: FhirDosage = {
      text: "Infuse as instructed.",
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" },
        rateRange: range }]
    };
    // The edited preview is built from structured fields, not the text property.
    const imported = fromFhirDosage(dosage, { locale: "en" });
    for (const text of [imported.shortText, imported.longText])
      expect(text.match(/Rate range: ([^.;]+)(?:[.;]|$)/u)?.[1]).toBe(expected);
    expect(imported.fhir).toEqual(dosage);
    // An explicit format request may deliberately return the authored source.
    expect(formatSig(dosage, "long")).toBe("Infuse as instructed.");
  });
});


describe("persisted edit fingerprint compatibility",()=>{
  it("streams the exact existing editable-row view without cloning a dosage tree",async()=>{
    const {dosageProjectionFingerprint,compactProjectionFingerprint,DOSAGE_DETAILS_R5_URL,
      DOSAGE_RENDERED_INSTRUCTION_R5_URL}=await import("../src/dosage-course");
    const keys=new Set(["sequence","stepCount","step","component","context","contextRequired","course","emptyStep","missingContext"]);
    const input=toFhirR5Dosages({step:[{component:[{
      timing:{repeat:{frequency:1,period:1,periodUnit:FhirPeriodUnit.Day}},
      doseAndRate:[{doseQuantity:simpleQuantityForR5({value:1,unit:"tab",comparator:"~"})!}]
    }]},{component:[{doseAndRate:[{doseQuantity:{value:2,unit:"tab"}}]}]}]});
    // Frozen from the actual d0c8ba1 writer (2026-11-20), before this change.
    const previousWriterFingerprints = ["42206e072188d125", "e5eaba93dceebb1b"];
    for(const [index,row] of input.entries()){
      expect(dosageProjectionFingerprint(row)).toBe(previousWriterFingerprints[index]);
      // Independent old encoding oracle: semantically active local fields are
      // hashed; original text and saved comparison fingerprints are excluded.
      const {text:_text,extension,modifierExtension,...clinical}=row;
      const keptExtensions=extension?.filter(e=>e.url!==DOSAGE_RENDERED_INSTRUCTION_R5_URL);
      const keptModifiers=[];
      for(const marker of modifierExtension??[]){
        if(marker.url!==DOSAGE_DETAILS_R5_URL){keptModifiers.push(marker);continue;}
        if(marker.extension?.some(e=>e.url==="rowIndex"))
          keptModifiers.push({...marker,extension:marker.extension.filter(e=>keys.has(e.url))});
      }
      const oldView={...clinical,...(keptExtensions?.length?{extension:keptExtensions}:{}),
        ...(keptModifiers.length?{modifierExtension:keptModifiers}:{})};
      expect(dosageProjectionFingerprint(row)).toBe(compactProjectionFingerprint(oldView));
    }
  });
});


describe("November 17 review: historical retained rateRatio bridge", () => {
  it("reads previous R5 valueRatio child without recreating another external version", async () => {
    const { decodeCourseDetails } = await import("../src/dosage-course");
    const ratio = { numerator: { value: 120, unit: "mL" }, denominator: { value: 2, unit: "h" } };
    const encoded = {
      url: "urn:test:old-course",
      extension: [
        {
          url: "step",
          extension: [
            {
              url: "component",
              extension: [
                {
                  url: "doseAndRate",
                  extension: [{ url: "rateRatio", valueRatio: ratio }],
                },
              ],
            },
          ],
        },
      ],
    };
    const rebuilt = decodeCourseDetails(encoded);
    expect(rebuilt?.step[0].component[0].doseAndRate?.[0].rateRatio).toEqual(ratio);
  });
});


describe("review 26 scoped safety and cycle controls", () => {
  it.each(["~", "<="] as const)("reopens an unchanged annotated %s sole-step safety at its stage", comparator => {
    const source: FhirR6DosageInstruction = { step: [{
      safety: { doseLimit: [{ scope: "administration", valueQuantity: {
        value: 2, unit: "tab", comparator,
        _comparator: { id: "authored-qualifier", extension: [{ url: "urn:test:qualifier", valueString: "authored" }] }
      } }] },
      component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
    }] };
    const normalized = toDosageDetails([{ sequence: 1, doseAndRate: source.step![0].component[0].doseAndRate }],
      undefined, { step: [{ sequence: 1, safety: source.step![0].safety }] });
    expect(normalized.step![0].safety).toBeUndefined();
    const saved = JSON.parse(JSON.stringify(normalized));
    const restored = importCanonicalCourse(saved);
    expect(restored.safety?.limits).toBeUndefined();
    expect(restored.stages[0].safety?.limits?.[0].amount)
      .toMatchObject({ value: 2, unit: "tab", comparator });
    expect(fromFhir(saved).fhirNext.safety?.doseLimit?.[0].valueQuantity?._comparator)
      .toEqual(source.step![0].safety!.doseLimit![0].valueQuantity!._comparator);
    saved.safety.doseLimit[0].valueQuantity.value = 3;
    const edited = importCanonicalCourse(saved);
    expect(edited.stages[0].safety?.limits).toBeUndefined();
    expect(edited.safety?.limits?.[0].amount?.value).toBe(3);
  });

  it("does not attach a superseded comparator annotation to an edited EMA operator", () => {
    const wire = simpleQuantityForR5({ value: 2, unit: "tab", comparator: "~", _comparator: { id: "approximate" } })!;
    wire.extension!.find(x => x.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!.valueCoding!.code = "100000000052";
    const restored = quantityFromR5(wire)!;
    expect(restored.comparator).toBe("<=");
    expect(restored._comparator).toBeUndefined();
    expect(JSON.stringify(restored.extension)).toContain("approximate");
  });

  it("round29 shows the whole-course count beside its interval independently of the local step count", () => {
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 3, unit: "d", code: "d" },
      modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 4 }],
      step: [{ count: 2, component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }]
    };
    for (const input of [source, toDosageDetails(toFhirR5Dosages(source))]) {
      expect(formatSig(input, "long", { locale: "en" })).toContain("Repeat this schedule every 3 days for 4 cycles");
      expect(formatSig(input, "long", { locale: "en" })).toContain("Perform this phase 2 times");
      expect(formatSig(input, "long", { locale: "th" })).toContain("ทำซ้ำระยะนี้รวม 2 ครั้ง");
      expect(formatSig(input, "long", { locale: "th" })).toContain("จำนวน 4 รอบ");
      expect(input.step![0].count).toBe(2);
    }
  });
});

describe("review 27 external editing and batch course semantics", () => {
  it("keeps a standalone whole-course count in both batch styles", () => {
    const batch = fromFhir({
      modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }],
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }]
    });
    expect(batch.fhirNext.step).toHaveLength(1);
    expect(batch.fhirNext.repeatCycle).toBeUndefined();
    expect(batch.meta.canonical.course?.cycleCount).toBe(3);
    expect(batch.longText).toContain("3 cycles");
    expect(formatParseBatch(batch, "long", " | ")).toBe(batch.longText);
    expect(formatParseBatch(batch, "short", " | ")).toBe(batch.shortText);
    const ordinary = parseSig("1 tablet morning and 2 tablets evening");
    expect(formatParseBatch(ordinary, "long", " | "))
      .toBe(ordinary.items.map(item => item.longText).join(" | "));
  });

  it.each(["rate", "first-id", "both"] as const)("keeps an anonymous dose expression active after %s R5 edits across three saves", edit => {
    const expression = { id: "dose-calculation", language: "text/fhirpath", expression: "%patient.weight * 2",
      extension: [{ url: "urn:test:calculation", valueString: "retain" }] };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{
      doseExpression: expression, rateQuantity: { value: 5, unit: "mL/h" }
    }] }] }] };
    let rows = toFhirR5Dosages(input);
    if (edit !== "first-id") rows[0].doseAndRate![0].rateQuantity!.value = 10;
    if (edit !== "rate") rows[0].doseAndRate![0].id = "new-slot-id";
    for (let save = 0; save < 3; save++) {
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(rows)));
      expect(reopened.step[0].component[0].doseAndRate).toHaveLength(1);
      expect(reopened.step[0].component[0].doseAndRate![0]).toMatchObject({
        doseExpression: expression, rateQuantity: { value: edit === "first-id" ? 5 : 10, unit: "mL/h" },
        ...(edit !== "rate" ? { id: "new-slot-id" } : {})
      });
      rows = toFhirR5Dosages(reopened);
    }
  });

  it.each([false, true])("keeps repeating-course dose edits and actual header replacement=%s across three saves", replaceText => {
    const original = "Take 1 tablet daily for 2 days; repeat every 7 days";
    const replacement = "Use 2 tablets according to the updated weekly plan.";
    const input: FhirR6DosageInstruction = { renderedInstruction: original,
      repeatCycle: { value: 7, unit: "d", code: "d" },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          boundsDuration: { value: 2, unit: "d", code: "d" } } } }] }] };
    let editable = fromDosageDetails(input);
    editable.dosages[0].doseAndRate![0].doseQuantity!.value = 2;
    if (replaceText) editable.course.renderedInstruction = replacement;
    for (let save = 0; save < 3; save++) {
      const rows = toFhirR5Dosages(editable.dosages, editable.course);
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(rows)));
      expect(reopened.step[0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      const preview = formatSig(reopened, "long", { realizationMode: "roundtrip" });
      if (replaceText) expect(reopened.renderedInstruction).toBe(replacement);
      expect(preview).toContain("2 tablets");
      expect(preview).not.toContain("1 tablet");
      editable = fromDosageDetails(reopened);
    }
  });

  it.each(["period", "administration", "lifetime"] as const)("owns independent lifted and retained %s safety quantities", scope => {
    const quantity = { value: 4, unit: "tab", id: "original-maximum",
      extension: [{ url: "urn:test:maximum-note", valueString: "keep" }] };
    const raw: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      ...(scope === "period" ? { maxDosePerPeriod: [{ numerator: quantity, denominator: { value: 1, unit: "d" } }] }
        : scope === "administration" ? { maxDosePerAdministration: quantity } : { maxDosePerLifetime: quantity }) };
    for (const edit of ["safety", "r5", "both"] as const) {
      const row = structuredClone(toEzDosages([raw])[0]);
      const lifted = row.safety!.doseLimit![0].valueQuantity!;
      const maximum = scope === "period" ? row.maxDosePerPeriod![0].numerator!
        : scope === "administration" ? row.maxDosePerAdministration! : row.maxDosePerLifetime!;
      if (edit !== "r5") lifted.value = 3;
      if (edit !== "safety") maximum.value = 2;
      const marker = row.extension!.find(e => e.url.endsWith("r5-lifted-safety-source"))!;
      expect(decodeR5RetainedFields(marker).component?.safety?.doseLimit?.[0].valueQuantity?.value).toBe(4);
      const actual = toDosageDetails([row]).step[0].component[0].safety!.doseLimit![0];
      expect(actual.valueQuantity).toMatchObject({ value: edit === "r5" ? 2 : 3,
        unit: "tab", id: "original-maximum", extension: quantity.extension });
    }
  });
});


describe("round 28 phase-window and offset previews", () => {
  const relativeDay = (value: number) => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] },
    offsetDuration: { value, code: "d", unit: "d" }
  });
  const tablet = (value: number) => ({
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
    doseAndRate: [{ doseQuantity: { value, unit: "tab" } }]
  });
  const views = (course: FhirR6DosageInstruction) => [course, toDosageDetails(toFhirR5Dosages(course))];
  const options = { orderedAt: "2026-11-21T12:00:00+07:00", from: "2026-11-21T12:00:00+07:00",
    timeZone: "Asia/Bangkok", limit: 6 };

  it("shows the inherited origin of an unbounded successor and leaves original wire fields intact", () => {
    const course: FhirR6DosageInstruction = { step: [
      { end: relativeDay(2), component: [tablet(1)] },
      { component: [tablet(2)] }
    ] };
    for (const input of views(course)) {
      const original = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en" }))
        .toContain("From 2 days after treatment start onward: Use 2 tablets");
      expect(formatSig(input, "long", { locale: "th" }))
        .toContain("ตั้งแต่2 วันหลังเริ่มการรักษาเป็นต้นไป");
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 5,
        durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(8);
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it("names an implicit successor when its absolute origin is unknown", () => {
    const course: FhirR6DosageInstruction = { step: [
      { component: [tablet(1)] }, { component: [tablet(2)] }
    ] };
    for (const input of views(course)) {
      expect(formatSig(input, "long", { locale: "en" })).toContain("After the previous phase: Use 2 tablets");
      expect(formatSig(input, "long", { locale: "th" })).toContain("หลังขั้นตอนก่อนหน้า");
      expect(formatSig(input, "long", { locale: "en" })).not.toContain("From day");
    }
  });

  it("retains the noon-relative gap without withholding the third calendar morning", () => {
    const course: FhirR6DosageInstruction = { step: [
      { end: relativeDay(2), component: [tablet(1)] },
      { start: relativeDay(4), end: relativeDay(6), component: [tablet(2)] }
    ] };
    for (const input of views(course)) {
      const en = formatSig(input, "long", { locale: "en" });
      expect(en).toContain("From treatment start until 2 days after treatment start");
      expect(en).toContain("No doses from 2 days after treatment start until 4 days after treatment start");
      expect(en).not.toMatch(/No doses on days|Days 1–2/);
      expect(formatSig(input, "long", { locale: "th" }))
        .toContain("งดยาตั้งแต่2 วันหลังเริ่มการรักษาจนถึง4 วันหลังเริ่มการรักษา");
      expect(nextDueDoses(input, options)).toEqual([
        "2026-11-22T08:00:00+07:00", "2026-11-23T08:00:00+07:00",
        "2026-11-26T08:00:00+07:00", "2026-11-27T08:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 7,
        durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(6);
    }
  });

  it.each([1, undefined])("keeps only the authoritative offset cadence when frequency is %s", frequency => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { code: { text: "BID" }, repeat: { frequency, period: 1, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "h", unit: "h" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const original = JSON.stringify(course);
    const en = formatSig(course, "long", { locale: "en" });
    const th = formatSig(course, "long", { locale: "th" });
    if (frequency !== undefined) {
      expect(en).toContain("1 administration per 1 day");
      expect(en).not.toMatch(/twice daily|BID/);
      expect(th).toContain("ให้ยา 1 ครั้งต่อช่วง 1 วัน");
      expect(th).not.toContain("วันละ 2 ครั้ง");
    } else {
      expect(en).toContain("twice daily");
      expect(th).toContain("วันละ 2 ครั้ง");
    }
    expect(course.step[0].component[0].timing?.code?.text).toBe("BID");
    expect(JSON.stringify(course)).toBe(original);
  });

  it.each(["at most", "at least", "approximately"])("keeps %s infusion duration in both locales and styles", qualifier => {
    const batch = parseSig("Infuse 500 mL over " + qualifier + " 2 hours");
    const operator = qualifier === "at most" ? "<=" : qualifier === "at least" ? ">=" : "~";
    for (const input of [batch.fhirNext, ...batch.fhir]) {
      for (const locale of ["en", "th"]) {
        const short = formatSig(input, "short", { locale, realizationMode: "normalized" });
        expect(short).toContain(operator + "2h");
        const long = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(long).toContain(locale === "th"
          ? (qualifier === "at most" ? "ไม่เกิน " : qualifier === "at least" ? "อย่างน้อย " : "ประมาณ ") + "2"
          : (qualifier === "at most" ? "at most " : qualifier === "at least" ? "at least " : "approximately ") + "2");
      }
    }
  });
});


describe("round29 typed course display scope", () => {
  const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };

  it("short and long previews both follow the live recurrence while preserving source timing", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      ...dose, timing: { code: { coding: [{
        system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID"
      }] }, repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = JSON.stringify(source);
    expect(formatSig(source, "short")).toBe("1 tab 1x/d");
    expect(formatSig(source, "long")).toContain("once daily");
    expect(JSON.stringify(source)).toBe(before);
    source.step![0].component[0].timing!.repeat!.frequency = 2;
    expect(formatSig(source, "short")).toBe("1 tab BID");
    delete source.step![0].component[0].timing!.repeat;
    expect(formatSig(source, "short")).toBe("1 tab BID");
    for (const code of ["QOD", "Q6H", "WK", "MO"]) {
      source.step![0].component[0].timing!.code!.coding![0].code = code;
      source.step![0].component[0].timing!.repeat = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
      expect(formatSig(source, "short")).toBe("1 tab 1x/d");
      delete source.step![0].component[0].timing!.repeat;
      expect(formatSig(source, "short")).toBe("1 tab " + code);
    }
  });

  it("keeps the administration condition before the independent limit response", () => {
    const source = parseSig("1 tab only if SBP > 160").fhirNext;
    source.step![0].component[0].safety = {
      doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }],
      ifExceeded: "Call the clinic"
    };
    const before = JSON.stringify(source);
    for (const locale of ["en", "th"]) {
      const text = formatSig(source, "long", { locale, realizationMode: "normalized" });
      expect(text).toMatch(/(?:1|one|หนึ่ง)\s*(?:tablet|เม็ด)/u);
      expect(text).toMatch(/>\s*160\b/u);
      expect(text).toContain("Call the clinic");
      expect(text.indexOf("160")).toBeLessThan(text.indexOf("Call the clinic"));
    }
    expect(JSON.stringify(source)).toBe(before);
  });

  it("does not extrapolate a successor date from repeated bounds with different origins", () => {
    const source: FhirR6DosageInstruction = { step: [{
      count: 2,
      start: { contextCode: { coding: [{ system: "urn:ezmedicationinput:CodeSystem:course-phase-event",
        code: "treatment-day-start" }] }, offsetDuration: { value: 1, unit: "d", code: "d" } },
      end: { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event",
        code: "treatment-start" }] }, offsetDuration: { value: 2, unit: "d", code: "d" } },
      component: [dose]
    }, { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] }] }] };
    const before = JSON.stringify(source);
    const en = formatSig(source, "long", { locale: "en", realizationMode: "normalized" });
    expect(en).toContain("Perform this phase 2 times");
    expect(en).toMatch(/After the previous phase: .*2 tablets/u);
    expect(en).not.toContain("3 days after treatment start onward");
    expect(JSON.stringify(source)).toBe(before);
  });
});
