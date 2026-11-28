import type { CanonicalCourse } from "../src/canonical/course";
import { parseAdditionalInstructions } from "../src/advice";
import { BODY_SITE_SPATIAL_RELATION_EXTENSION_URL, parseBodySiteSpatialRelationExtension, buildBodySiteSpatialRelationExtension } from "../src/body-site-spatial";
import { encodeR6SourceMetadata, decodeR6SourceMetadata } from "../src/dosage-course";
import { R6_SCOPED_SAFETY_MODIFIER_URL, retainedSingleStepSafety } from "../src/adapters/canonical-course";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import { decodeR5RetainedFields, encodeR5RetainedFields, DOSAGE_DETAILS_R5_URL, DOSAGE_RENDERED_INSTRUCTION_R5_URL } from "../src/dosage-course";
import { equalStructuredValues, cloneStructuredValue } from "../src/stable-structure";
import { describe, expect, it } from "vitest";
import conditionalDoseProfile from "../fhir/r5/medication-conditional-dose.json";
import renderedInstructionProfile from "../fhir/r5/medication-rendered-instruction.json";
import conditionLogicProfile from "../fhir/r6/medication-r6-condition-logic.json";

import {
  parseSig, parseSigAsync, fromFhir, fromFhirDosage, formatSig, formatSigBatch, formatParseBatch,
  importCanonicalCourse, projectCanonicalCourse, formatCanonicalCourse,
  nextDueDoses, calculateTotalUnits, getEmaQuantityComparator,
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM,
  toDosageDetails, toFhirR5Dosages, toEzDosages, fromDosageDetails,
  getBodySiteText, getBodySiteCode, getBodySiteCodeAsync, buildBodySiteAdministrationTargetCountExtension, evaluateMedicationCondition, setDosageCondition, getDosageCondition,
  type FormatOptions, type FhirR6DoseLimit, type FhirR6Extension, type FhirR6DosageInstruction, type FhirR6Dosage, type FhirDosage, type FhirExtension, type EzDosage, type MedicationCondition,
  EventTiming, FhirPeriodUnit, RouteCode, AdviceRelation, AdviceArgumentRole, AdviceForce, AdvicePolarity, type CanonicalInstructionGraph, parseInstructionActions, realizeInstructionGraph, cloneBodySiteSpatialRelation
} from "../src/index";
import {
  canonicalFromFhir, canonicalToFhir, parserStateFromFhir, BODY_SITE_RESTRICTION_EXTENSION_URL, TIMING_ACTIVITY_WINDOW_EXTENSION_URL, TIMING_CLOCK_WINDOW_EXTENSION_URL, TIMING_DAY_OF_MONTH_EXTENSION_URL, getTimingClocks,
  toFhir as parserStateToFhir, getAdministrationOffsetMinutes, ADMINISTRATION_OFFSET_EXTENSION_URL,
  buildInfusionCarrierMaterialStructureDefinition, TIMING_ADMINISTRATION_DURATION_EXTENSION_URL
} from "../src/fhir";
import { parseMedicationGuard } from "../src/medication-condition";
import { courseToR6 } from "../src/adapters/canonical-course";
import { MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, buildInstructionGraphExtension, parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import {
  setDosageExcludedDates, getDosageExcludedDates, getDosageExcludedWeekdays, getDosageCalendarDayCondition,
  DOSAGE_EXCLUDED_DATES_R5_URL, DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
  DOSAGE_ALTERNATIVE_CHOICE_URL, getDosageAlternativeChoice,
  setDosageAlternativeChoice, buildDosageAlternativeChoiceStructureDefinition, conditionToR6
} from "../src/dosage-course";

import { COURSE_CYCLE_COUNT_EXTENSION_URL } from "../src/dosage-course";
import { getQuantityComparator, quantityForR5, quantityFromR5, simpleQuantityForR5, quantityAnnotationExtensions } from "../src/fhir-quantity-operator";
import { getDoseQuantityUnit } from "../src/maps";
import { getPrimitiveTranslation, mergeTranslationPrimitiveElement } from "../src/fhir-translations";

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
    const original: FhirR6DosageInstruction = {
      renderedInstruction: "Follow the right-eye taper.",
      step: [
        { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Hour },
        { frequency: 4, period: 1, periodUnit: FhirPeriodUnit.Day },
        { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day }
      ].map(repeat => ({ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
        site: { concept: { text: "right eye", coding: [{ system: "http://snomed.info/sct", code: "1290032005" }] } },
        timing: { repeat: { ...repeat, boundsDuration: { value: 1, unit: "wk", code: "wk" } } }
      }] }))
    };
    const imported = fromFhir(JSON.parse(JSON.stringify(original)));
    expect(imported.fhirNext).toEqual(original);
    expect(imported.fhir.map(v => v.sequence)).toEqual([1, 2, 3]);
    expect(imported.count).toBe(3);
    expect(imported.fhir.map(row => row.timing?.repeat)).toEqual([
      expect.objectContaining({ frequency: 1, period: 2, periodUnit: "h" }),
      expect.objectContaining({ frequency: 4, period: 1, periodUnit: "d" }),
      expect.objectContaining({ frequency: 2, period: 1, periodUnit: "d" })
    ]);
    for (const row of imported.fhir) {
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "drop" });
      expect(row.site?.text).toBe("right eye");
      expect(row.timing?.repeat?.boundsDuration).toMatchObject({ value: 1, code: "wk" });
    }
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
    expect(recovered.extension).toEqual(expect.arrayContaining(expected.extension ?? []));
    expect(recovered.extension?.flatMap(extension => extension.extension ?? []))
      .toContainEqual(expect.objectContaining({
        url: unknown.url,
        extension: expect.arrayContaining(unknown.extension!.filter(child => child.url !== "course"))
      }));

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
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))])
      expect(nextDueDoses(dosage, { ...timingFamilyOptions, limit: 2,
        eventClock: { [EventTiming["Before Breakfast"]]: "07:00" } })).toEqual([
        "2026-10-21T07:00:00+07:00", "2026-10-21T08:00:00+07:00"
      ]);
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
    const third: FhirR6Dosage = {
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
    const dosage: FhirR6Dosage = {
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
      expect(en).toContain("No doses from 7 days after each cycle start until 14 days after each cycle start");
      expect(en).not.toContain("after treatment start");
      expect(th).toContain("ทุก 14 วัน");
      expect(th).toContain("จากจุดเริ่มต้นของแต่ละรอบ");
      expect(th).toContain("งดยาตั้งแต่7 วันหลังจุดเริ่มต้นของแต่ละรอบจนถึง14 วันหลังจุดเริ่มต้นของแต่ละรอบ");
      expect(th).not.toContain("หลังเริ่มการรักษา");
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
        let interpretedPauses = 0;
        for (const match of en.matchAll(/No doses from (?:(\d+) days? after )?(treatment start) until (\d+) days? after \2/gu)) {
          interpretedPauses++;
          for (let day = Number(match[1] ?? 0); day < Number(match[3]); day++) stated.push(day + 1);
        }
        expect(en).not.toContain("each cycle start");
        expect(interpretedPauses).toBe(en.match(/No doses\b/gu)?.length ?? 0);
        expect(stated).toEqual(uncovered);
        expect(calculateTotalUnits({
          dosage: input, timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00",
          from: "2026-11-02T00:00:00+07:00", durationValue: 28, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(7 + (left[1] - left[0]) * 0.5 + (right[1] - right[0]) * 0.25);
      }
    }
  });

  it("keeps the leading untreated interval explicit without hiding an active first day", () => {
    const course: FhirR6DosageInstruction = { step: [step(2, 5, 1)] };
    for (const input of variants(course)) {
      const en = formatSig(input, "long", { locale: "en" });
      expect(en).toContain("No doses from treatment start until 2 days after treatment start");
      expect(en.match(/No doses/gu)).toHaveLength(1);
      expect(calculateTotalUnits({ dosage: input, timeZone: "Asia/Bangkok",
        orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00",
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(3);
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
      expect(en).toContain("From 7 days after each cycle start until 21 days after each cycle start");
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
    const cases: Array<{ condition: NonNullable<FhirR6Dosage["condition"]>[number]; expected: string }> = [
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
    expect(text).toContain("From each cycle start until 7 days after each cycle start");
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
  for (const input of [parsed.fhirNext, toDosageDetails(parsed.fhir)]) {
    const phases = formatSig(input, "long", { locale: "en", realizationMode: "normalized" }).split(/\bthen\b/iu);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatch(/Instill 1 drop every 2 hours[\s\S]*in the right eye/iu);
    expect(phases[1]).toMatch(/Instill 1 drop four times daily[\s\S]*in the right eye/iu);
    for (const phase of phases) {
      expect(phase.match(/\bInstill\b/giu)).toHaveLength(1);
      expect(phase).toContain("for 1 week");
      expect(phase).not.toMatch(/\b(?:left|both) eyes?\b|\bbilateral\b/iu);
    }
    const thaiPhases = formatSig(input, "long", { locale: "th", realizationMode: "normalized" }).split("จากนั้น");
    expect(thaiPhases).toHaveLength(2);
    expect(thaiPhases[0]).toMatch(/หยอดตาขวา ครั้งละ 1 หยด ทุก 2 ชั่วโมง/u);
    expect(thaiPhases[1]).toMatch(/หยอดตาขวา ครั้งละ 1 หยด วันละ 4 ครั้ง/u);
    for (const phase of thaiPhases) {
      expect(phase).toContain("เป็นเวลา 1 สัปดาห์");
      expect(phase).not.toMatch(/ตาซ้าย|ทั้งสอง|สองข้าง/u);
    }
    expect(input.renderedInstruction).toBe(source);
  }
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

  it("keeps the six-row independent taper below 12 KB in public R5 outputs", () => {
    const parsed = parseSig(input);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.fhir).toHaveLength(6);
    for (const rows of [parsed.fhir, strict, fromFhir(parsed.fhirNext).fhir]) {
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
  const component = (value = 1): FhirR6Dosage => ({
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
    const before = structuredClone(source);
    const rows = toFhirR5Dosages(source);
    const recovered = toDosageDetails(JSON.parse(JSON.stringify(rows)));
    expect(recovered).toEqual(before);
    expect(toDosageDetails(JSON.parse(JSON.stringify(fromFhir(source).fhir)))).toEqual(before);
    expect(source).toEqual(before);
    let saved = rows;
    for (let count = 0; count < 3; count++) {
      saved = toFhirR5Dosages(toDosageDetails(JSON.parse(JSON.stringify(saved))));
      expect(saved).toEqual(rows);
      expect(JSON.stringify(saved).length).toBe(JSON.stringify(rows).length);
    }
    expect(source).toEqual(before);
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
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["03:15:00", "08:00:00"] } }
      }] }]
    };
    const options = { from: "2026-03-14T02:30:00-04:00", orderedAt: "2026-03-14T02:30:00-04:00",
      timeZone: "America/New_York", limit: 5 };
    const expected = ["2026-03-14T03:15:00-04:00", "2026-03-14T08:00:00-04:00",
      "2027-03-14T08:00:00-04:00", "2028-03-14T03:15:00-04:00", "2028-03-14T08:00:00-04:00"];
    for (const dosage of [course, JSON.parse(JSON.stringify(toFhirR5Dosages(course)))]) {
      expect(nextDueDoses(dosage, options)).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 366, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(3);
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
    const rows = structuredClone(toFhirR5Dosages(original));
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
      const rows = cloneStructuredValue(toFhirR5Dosages(course));
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
        if (unit === "a") {
          const afterGapYear = nextDueDoses(input, {
            ...options, from: "2028-03-14T00:00:00-04:00", limit: 2,
          });
          expect(afterGapYear[0]).toBe("2028-03-14T03:00:00-04:00");
        }
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
      const rows = cloneStructuredValue(toFhirR5Dosages(course));
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
    const beforeR5 = JSON.stringify(r5);
    for (const realizationMode of ["normalized", "roundtrip"] as const)
      for (const api of ["formatSig", "fromFhirDosage"] as const) {
        let calls = 0;
        const options: FormatOptions = { locale, realizationMode, i18n: { formatLong: context => {
          calls++;
          expect(context.clause.dose).toMatchObject({ value: 500, unit: "mL" });
          expect(context.defaultText).toContain(expected);
          expect(context.formatDefault("long")).toBe(context.defaultText);
          expect(context.formatDefault("short")).toContain("50–100 mL/h");
          return "Clinical wording, unchanged!";
        } } };
        const text = api === "formatSig" ? formatSig(r5, "long", options) : fromFhirDosage(r5, options).longText;
        expect(text).toBe("Clinical wording, unchanged!");
        expect(calls).toBe(1);
      }
    expect(JSON.stringify(r5)).toBe(beforeR5);
    expect(toDosageDetails([r5])).toEqual(source);
    const editedSource: FhirR6DosageInstruction = JSON.parse(JSON.stringify(source));
    editedSource.step[0].component[0].text = "Infuse using the written rate plan";
    expect(fromFhir(editedSource, { locale }).items[0].longText).toContain(expected);
    expect(fromFhir(editedSource, { locale }).items[0].longText).toContain("500");
    expect(fromFhir(editedSource, { locale }).fhirNext.step[0].component[0].text)
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
    const sourceBefore = JSON.stringify(sourceSite);
    for (const version of ["2026.11", "2028.05", "2024-legacy"]) {
      const rows: FhirDosage[] = JSON.parse(JSON.stringify(toFhirR5Dosages(sourceSite)));
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
      expect(JSON.stringify(sourceSite)).toBe(sourceBefore);
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
    const originalBefore = JSON.stringify(original);
    const rows: FhirDosage[] = JSON.parse(JSON.stringify(toFhirR5Dosages(original)));
    rows[0].site!.coding![0].version = "site-new";
    rows[0].route!.coding![0].version = "route-new";
    rows[0].method!.coding![0].version = "method-new";
    const out = toDosageDetails(rows).step[0].component[0];
    expect(out.site?.concept?.coding?.[0].version).toBe("site-new");
    expect(out.route?.coding?.[0].version).toBe("route-new");
    expect(out.method?.coding?.[0].version).toBe("method-new");
    expect(out.site?.id).toBe("original-site");
    expect(JSON.stringify(original)).toBe(originalBefore);
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
      const rows = cloneStructuredValue(toFhirR5Dosages(source));
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
      const changed = cloneStructuredValue(toFhirR5Dosages(existing));
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
    const rows = cloneStructuredValue(toFhirR5Dosages(source));
    rows[0].doseAndRate![0].id = "new-dose-id";
    rows[0].doseAndRate![1].id = "new-rate-id";
    const result = toDosageDetails(rows).step[0].component[0].doseAndRate!;
    expect(result[0]).toMatchObject({ id: "new-dose-id", type, doseExpression: expr });
    expect(result[1]).toMatchObject({ id: "new-rate-id", type: typeB, rateExpression: rate });
    // A numeric edit still supersedes an expression regardless of the new ID.
    const edited = cloneStructuredValue(toFhirR5Dosages(source));
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
    const rows = cloneStructuredValue(toFhirR5Dosages(source));
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
      const offsetFormat = new Intl.DateTimeFormat("en-US", {
        timeZone: opts.timeZone, timeZoneName: "longOffset",
      });
      const expected = Array.from({ length: opts.limit }, (_, day) => {
        const civil = new Date(Date.UTC(2026, 11, 14 + day));
        // Noon identifies this civil day's offset independently of execution;
        // the authored 03:00 is after either New York clock transition.
        const offset = offsetFormat.formatToParts(new Date(civil.getTime() + 12 * 3600000))
          .find(part => part.type === "timeZoneName")!.value.replace("GMT", "");
        return civil.toISOString().slice(0, 10) + "T03:00:00" + offset;
      });
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
    const rows = structuredClone(toFhirR5Dosages(course));
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
    // Roundtrip keeps current structured rates beside unverified source wording.
    expect(formatSig(dosage, "long")).toBe(formatSig(dosage, "long", { realizationMode: "normalized" }));
    expect(formatSig(dosage, "long")).toContain(expected);
    const roundtrip = formatSig(dosage, "long", { realizationMode: "roundtrip" });
    expect(roundtrip.split("; original directions:")[0].match(/Rate range: ([^.;]+)(?:[.;]|$)/u)?.[1]).toBe(expected);
    expect(roundtrip).toContain("original directions: Infuse as instructed.");
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
    const editedSaved = JSON.parse(JSON.stringify(saved));
    editedSaved.safety.doseLimit[0].valueQuantity.value = 3;
    const edited = importCanonicalCourse(editedSaved);
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
    let rows: FhirDosage[] = structuredClone(toFhirR5Dosages(input));
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
    expect(input.step![0].component[0].doseAndRate![0].rateQuantity).toEqual({ value: 5, unit: "mL/h" });
  });

  it.each([false, true])("keeps repeating-course dose edits and actual header replacement=%s across three saves", replaceText => {
    const original = "Take 1 tablet daily for 2 days; repeat every 7 days";
    const replacement = "Use 2 tablets according to the updated weekly plan.";
    const input: FhirR6DosageInstruction = { renderedInstruction: original,
      repeatCycle: { value: 7, unit: "d", code: "d" },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          boundsDuration: { value: 2, unit: "d", code: "d" } } } }] }] };
    const before = structuredClone(input);
    let editable = structuredClone(fromDosageDetails(input));
    editable.dosages[0].doseAndRate![0].doseQuantity!.value = 2;
    if (replaceText) editable.course.renderedInstruction = replacement;
    for (let save = 0; save < 3; save++) {
      const rows = toFhirR5Dosages(editable.dosages, editable.course);
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(rows)));
      expect(reopened.step[0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      const preview = formatSig(reopened, "long", { realizationMode: "roundtrip" });
      if (replaceText) expect(reopened.renderedInstruction).toBe(replacement);
      else {
        const retained = reopened.extension?.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)
          ?.extension?.find(item => item.url === "instruction")?.valueString;
        expect([reopened.renderedInstruction, retained]).toContain(original);
      }
      expect(preview).toContain("2 tablets");
      expect(preview).not.toContain("1 tablet");
      editable = fromDosageDetails(reopened);
    }
    expect(input).toEqual(before);
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
    const fixture: FhirR6DosageInstruction = { step: [{ component: [{
      ...dose, timing: { code: { coding: [{
        system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID"
      }] }, repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const source = structuredClone(fixture);
    const before = JSON.stringify(source);
    expect(formatSig(source, "short")).toBe("1 tab 1x/d");
    expect(formatSig(source, "long")).toContain("once daily");
    expect(JSON.stringify(source)).toBe(before);
    const twiceDaily = structuredClone(fixture);
    twiceDaily.step![0].component[0].timing!.repeat!.frequency = 2;
    expect(formatSig(twiceDaily, "short")).toBe("1 tab BID");
    const codeOnlyBid = structuredClone(fixture);
    delete codeOnlyBid.step![0].component[0].timing!.repeat;
    expect(formatSig(codeOnlyBid, "short")).toBe("1 tab BID");
    for (const code of ["QOD", "Q6H", "WK", "MO"]) {
      const repeated = structuredClone(fixture);
      repeated.step![0].component[0].timing!.code!.coding![0].code = code;
      expect(formatSig(repeated, "short")).toBe("1 tab 1x/d");
      const codeOnly = structuredClone(fixture);
      codeOnly.step![0].component[0].timing!.code!.coding![0].code = code;
      delete codeOnly.step![0].component[0].timing!.repeat;
      expect(formatSig(codeOnly, "short")).toBe("1 tab " + code);
    }
  });

  it("keeps the administration condition before the independent limit response", () => {
    const source = structuredClone(parseSig("1 tab only if SBP > 160").fhirNext);
    source.step![0].component[0].safety = {
      doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }],
      ifExceeded: "Call the clinic"
    };
    const before = JSON.stringify(source);
    for (const locale of ["en", "th"]) {
      const text = formatSig(source, "long", { locale, realizationMode: "normalized" });
      const administration = locale === "en" ? "Use 1 tablet only if SBP > 160"
        : "ใช้ครั้งละ 1 เม็ด เฉพาะเมื่อ SBP > 160";
      expect(text.split(";")[0]).toBe(administration);
      expect(text).toContain("Call the clinic");
      expect(text.indexOf(administration)).toBeLessThan(text.indexOf("Call the clinic"));
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


describe("round42 supported course preview boundaries", () => {
  it("uses an inherited English formatter's selected endpoint units and preserves unknown labels", () => {
    const range = {
      low: { value: 90, code: "min", unit: "minutes" },
      high: { value: 2, code: "h", unit: "hours" }
    };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { extension: [{
        url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration", valueRange: range
      }] } },
      doseAndRate: [{ rateQuantity: { value: 20, unit: "mL/hour", code: "mL/h", system: "http://unitsofmeasure.org" } }]
    }] }] };
    const before = JSON.stringify(raw);
    const i18n = { locale: "xx-round42-time", inherit: "en", course: {
      ...ENGLISH_COURSE,
      timeUnit: (unit: string) => unit === "min" || unit === "h" ? "pack-time-" + unit : undefined
    } };
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const text = formatSig(input, "long", { i18n, realizationMode: "normalized" });
      expect(text).toContain("90 pack-time-min to 2 pack-time-h");
      expect(text).not.toContain("90 minutes");
    }
    expect(JSON.stringify(raw)).toBe(before);
    const editedRaw: FhirR6DosageInstruction = JSON.parse(JSON.stringify(raw));
    const editedRange = editedRaw.step[0].component[0].timing!.repeat!.extension![0].valueRange!;
    editedRange.high!.code = "clinic-window"; editedRange.high!.unit = "authored windows";
    expect(formatSig(editedRaw, "long", { i18n, realizationMode: "normalized" }))
      .toContain("90 pack-time-min to 2 authored windows");
  });

  it.each([false, true])("claims onward only when no stage end was authored (%s)", hasEnd => {
    const end = { contextCode: { coding: [{ system: "https://clinic.example/events", code: "follow-up" }] } };
    const raw: FhirR6DosageInstruction = { step: [{
      start: { contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] }, offsetDuration: { value: 1, unit: "d", code: "d" } },
      ...(hasEnd ? { end } : {}),
      component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { timeOfDay: ["08:00:00"] } } }]
    }] };
    const before = JSON.stringify(raw), saved = JSON.parse(JSON.stringify(toFhirR5Dosages(raw)));
    for (const input of [raw, saved]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("1 day after treatment start");
      expect(th).toContain("1 วันหลังเริ่มการรักษา");
      expect(en.includes("onward")).toBe(!hasEnd);
      expect(th.includes("เป็นต้นไป")).toBe(!hasEnd);
      if (hasEnd) {
        expect(en).toContain("Timing requires review");
        expect(th).toContain("ต้องตรวจสอบช่วงเวลา");
        expect(en).toContain("follow-up");
        expect(th).toContain("follow-up");
      }
    }
    if (hasEnd) expect(toDosageDetails(saved).step[0].end).toEqual(end);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("round49 primary administration condition placement", () => {
  const source = "Take 1 tablet BID only if BP >160, otherwise hold";
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const generated = (locale: "en" | "th", mode: "normalized" | "roundtrip", value = 160) =>
    locale === "en"
      ? "Take 1 tablet orally twice daily only if BP > " + value + ". Otherwise hold."
      : (mode === "normalized" ? "รับประทานครั้งละ" : "รับประทาน") +
        " 1 เม็ด วันละ 2 ครั้ง เฉพาะเมื่อ BP > " + value + ". otherwise hold.";

  it.each([
    ["en", "normalized"], ["en", "roundtrip"], ["th", "normalized"], ["th", "roundtrip"],
  ] as const)("binds the typed condition to its primary before independent advice (%s, %s)", (locale, realizationMode) => {
    const parsed = parseSig(source), options = { locale, realizationMode };
    const native = importCanonicalCourse(parsed.fhirNext);
    const short = locale === "en" ? "1 tab PO BID only if BP > 160."
      : "1 เม็ด PO วันละ 2 ครั้ง เฉพาะเมื่อ BP > 160.";
    expect(formatCanonicalCourse(native, "long", options)).toBe(generated(locale, realizationMode));
    expect(formatCanonicalCourse(native, "short", options)).toBe(short);
    const forms = [
      { kind: "fresh", input: parsed.fhir },
      { kind: "r6", input: parsed.fhirNext },
      { kind: "cold", input: copy(toFhirR5Dosages(parsed.fhirNext)) },
    ];
    for (const { kind, input } of forms) {
      const before = copy(input), replay = kind === "fresh" && realizationMode === "roundtrip";
      expect(formatSig(input, "long", options)).toBe(replay ? source : generated(locale, realizationMode));
      expect(formatSig(input, "short", options)).toBe(replay ? source : short);
      expect(input).toEqual(before);
    }
  });

  it.each(["en", "th"] as const)("keeps the current condition value on the primary after a cold R5 edit (%s)", locale => {
    const rows = copy(toFhirR5Dosages(parseSig(source).fhirNext));
    setDosageCondition(rows[0], { kind: "measurement", name: "bp", operation: "gt", value: 180,
      text: "BP >160" });
    const original = copy(rows);
    for (const input of [rows, toDosageDetails(rows)]) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text).toBe(generated(locale, "normalized", 180));
      expect(text).not.toContain("160");
    }
    expect(rows).toEqual(original);
  });

  it.each([
    ["en", "literal"], ["en", "default"], ["th", "literal"], ["th", "default"],
    ["en", "formatDefault"], ["th", "formatDefault"],
  ] as const)("preserves guarded defaults and exact custom formatter wording (%s, %s)", (locale, mode) => {
    const parsed = parseSig(source);
    const native = importCanonicalCourse(parsed.fhirNext);
    const defaults: string[] = [];
    const options: FormatOptions = { locale, realizationMode: "normalized", i18n: {
      inherit: locale,
      formatLong: context => {
        defaults.push(context.defaultText);
        expect(context.formatDefault("long")).toBe(context.defaultText);
        return mode === "literal" ? "Clinic-selected administration." :
          mode === "formatDefault" ? context.formatDefault("long") : context.defaultText;
      },
    } };
    const text = formatCanonicalCourse(native, "long", options);
    const guard = locale === "en" ? "only if BP > 160" : "เฉพาะเมื่อ BP > 160";
    const defaultText = generated(locale, "normalized");
    const expected = mode === "literal" ? "Clinic-selected administration." : defaultText;
    expect(text.split(guard)).toHaveLength(mode === "literal" ? 1 : 2);
    // Custom wording is authoritative; the complete default keeps the condition
    // on the dose before the independent hold.
    if (mode !== "literal") expect(text).toMatch(/Otherwise hold/iu);
    expect(text).toBe(expected);
    expect(defaults).toEqual([defaultText]);
    expect(formatCanonicalCourse(native, "short", options)).toBe(
      locale === "en" ? "1 tab PO BID only if BP > 160." : "1 เม็ด PO วันละ 2 ครั้ง เฉพาะเมื่อ BP > 160.");

    const saved = JSON.stringify([parsed.fhir, parsed.fhirNext, native]);
    for (const input of [parsed.fhir[0], parsed.fhir, parsed.fhirNext, native])
      expect(formatSig(input, "long", options)).toBe(expected);
    expect(fromFhirDosage(parsed.fhir[0], options).longText).toBe(expected);
    expect(fromFhir(parsed.fhirNext, options).longText).toBe(expected);
    expect(fromFhir(parsed.fhirNext, options).items[0].longText).toBe(expected);
    const roundtrip = { ...options, realizationMode: "roundtrip" as const };
    for (const input of [parsed.fhir[0], parsed.fhir])
      expect(formatSig(input, "long", roundtrip)).toBe(source);
    expect(fromFhirDosage(parsed.fhir[0], roundtrip).longText).toBe(source);
    const roundtripExpected = mode === "literal" ? expected : generated(locale, "roundtrip");
    for (const input of [parsed.fhirNext, native])
      expect(formatSig(input, "long", roundtrip)).toBe(roundtripExpected);
    expect(fromFhir(parsed.fhirNext, roundtrip).longText).toBe(roundtripExpected);
    expect(JSON.stringify([parsed.fhir, parsed.fhirNext, native])).toBe(saved);
  });
});


describe("round57 retained range and standalone carrier previews", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each(["upper", "lower", "drops"] as const)("uses the valued ordered-range endpoint: %s", kind => {
    const range = kind === "upper"
      ? { low: { unit: "uL", _value: { id: "unvalued-low" } }, high: { value: 2, unit: "mL" } }
      : kind === "lower"
        ? { low: { value: 2, unit: "mL" }, high: { unit: "uL", _value: { id: "unvalued-high" } } }
        : { low: { value: 1, unit: "drop" }, high: { value: 2, unit: "drop" } };
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text: kind === "drops" ? "both eyes" : "both nostrils" } },
      doseAndRate: [{ type: { text: "ordered" }, doseRange: range }]
    }] }] };
    const before = fresh(source), rows = fresh(toFhirR5Dosages(source));
    for (const input of [source, rows]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      if (kind === "drops") {
        expect(en).toContain("1 to 2 drops (per administration target)");
        expect(th).toContain("แต่ละจุด 1 ถึง 2 หยด");
      } else {
        expect(en).toContain(kind === "upper" ? "up to 2 mL" : "at least 2 mL");
        expect(th).toContain(kind === "upper" ? "ไม่เกิน 2 มิลลิลิตร" : "อย่างน้อย 2 มิลลิลิตร");
        expect(en).not.toMatch(/uL|µL|per administration target/);
        expect(th).not.toContain("แต่ละจุด");
      }
    }
    expect(toDosageDetails(rows).step[0].component[0].doseAndRate?.[0].doseRange).toEqual(range);
    expect(source).toEqual(before);
  });

  it.each([false, true])("reopens a standalone administration-free carrier with cap=%s", capped => {
    const source: FhirR6DosageInstruction = {
      id: "r57-header", renderedInstruction: "Call clinic for dose",
      extension: [{ url: "urn:r57:retained-header", valueBoolean: false }],
      ...(capped ? { safety: { doseLimit: [{ scope: "administration" as const,
        valueQuantity: { value: 5, unit: "mg", comparator: "~" as const } }] } } : {})
    };
    const before = fresh(source), rows = fresh(toFhirR5Dosages(source)), rowBefore = fresh(rows[0]);
    for (const locale of ["en", "th"]) {
      const result = fromFhirDosage(fresh(rows[0]), { locale, realizationMode: "normalized" });
      const expected = !capped ? "Call clinic for dose" : locale === "en"
        ? "Current: Across this course: max per administration: ~5 mg; original directions: Call clinic for dose"
        : "ปัจจุบัน: ตลอดแผนการใช้ยานี้: max per administration: ~5 mg; ข้อความเดิม: Call clinic for dose";
      expect(result.shortText).toBe(expected);
      expect(result.longText).toBe(expected);
      expect(result.meta.canonical.administration).toBeUndefined();
      expect(result.meta.canonical.course?.stages).toEqual([]);
      expect(result.fhir).toEqual(rowBefore);
      expect(toDosageDetails([result.fhir])).toEqual(source);
    }
    expect(rows[0]).toEqual(rowBefore);
    expect(source).toEqual(before);
  });

  it("keeps a standalone administered row limited to its selected component", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [
      { id: "first", doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] },
      { id: "second", doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } }
    ] }] };
    const row = fresh(toFhirR5Dosages(source)[1]);
    const result = fromFhirDosage(row, { locale: "en", realizationMode: "normalized" });
    expect(result.longText).toBe("Use 2 tablets once daily.");
    expect(result.meta.canonical.clauses[0].dose).toMatchObject({ value: 2, unit: "tab" });
    expect(result.meta.canonical.course).toBeUndefined();
  });
});


describe("round58 partial facts and independent timing text", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const inputFor = (dose: FhirR6Dosage): FhirR6DosageInstruction => ({
    id: "round58-root", extension: [{ url: "urn:r58:opaque", valueString: "retain me" }],
    step: [{ component: [dose] }]
  });
  it.each(["upper unit", "lower unit", "matching units"] as const)(
    "preserves independently authored range endpoints with %s", kind => {
      const range = { low: { value: 250, ...(kind !== "upper unit" ? { unit: "mg" } : {}) },
        high: { value: 500, ...(kind !== "lower unit" ? { unit: "mg" } : {}) } };
      const input = inputFor({ doseAndRate: [{ doseRange: range }] }), before = fresh(input);
      const rows = fresh(toFhirR5Dosages(input)), reopened = fresh(toDosageDetails(rows));
      for (const value of [input, rows, reopened]) for (const locale of ["en", "th"]) {
        const options = { locale, realizationMode: "normalized" as const };
        if (kind === "matching units") {
          expect(formatSig(value, "short", options)).toBe(locale === "en" ? "250-500 mg" : "250-500 มก.");
          expect(formatSig(value, "long", options)).toContain(locale === "en" ? "250 to 500 mg" : "250 ถึง 500 มิลลิกรัม");
        } else for (const style of ["short", "long"] as const) {
          const rendered = formatSig(value, style, options);
          expect(rendered).toContain(kind === "upper unit" ? "250 – 500 mg" : "250 mg – 500");
          expect(rendered).not.toContain("250-500 mg");
        }
      }
      expect(reopened.step![0].component[0].doseAndRate?.[0].doseRange).toEqual(range);
      expect(input).toEqual(before);
    });
  it.each(["site only", "structured dose", "structured method"] as const)(
    "retains the appropriate source owner for %s directions", kind => {
      const input = inputFor({ text: "Apply a thin layer",
        site: { concept: { coding: [{ system: "http://snomed.info/sct", code: "66480008", display: "Left forearm" }] } },
        ...(kind === "structured dose" ? { doseAndRate: [{ doseQuantity: { value: 2, unit: "g" } }] } : {}),
        ...(kind === "structured method" ? { method: { text: "Apply" } } : {}) });
      const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
      for (const value of [input, rows, fresh(toDosageDetails(rows))])
        for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
          const rendered = formatSig(value, style, { locale, realizationMode: "normalized" });
          expect(rendered).toContain(locale === "en" ? "left forearm" : "ปลายแขนซ้าย");
          expect(rendered).toContain("Apply a thin layer");
          if (kind === "structured dose") {
            const native = locale === "en"
              ? style === "short" ? "2 g to the left forearm" : "Use 2 g to the left forearm"
              : style === "short" ? "2 g ที่ปลายแขนซ้าย" : "ใช้ครั้งละ 2 g ที่ปลายแขนซ้าย";
            expect(rendered.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: "))
              .toEqual([(locale === "en" ? "Current: " : "ปัจจุบัน: ") + native, "Apply a thin layer"]);
          }
        }
      expect(input).toEqual(before);
      expect(toDosageDetails(rows)).toEqual(input);
    });
  it.each([false, true])("uses only valued endpoints for per-eye scope, mixed units=%s", mixed => {
    const range = { low: mixed ? { value: 1, unit: "mL" } : { id: "retained-low-note" },
      high: { value: 2, unit: "drop", extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" } }] } };
    const input = inputFor({ site: { concept: { text: "both eyes" } },
      doseAndRate: [{ type: { text: "ordered" }, doseRange: range }] });
    const rows = fresh(toFhirR5Dosages(input)), reopened = fresh(toDosageDetails(rows));
    for (const value of [input, rows, reopened])
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const rendered = formatSig(value, style, { locale, realizationMode: "normalized" });
        expect(rendered).toContain("<2 drop");
        const scope = locale === "en" ? "per administration target" : "แต่ละจุด";
        if (mixed) { expect(rendered).toContain("1 mL"); expect(rendered).not.toContain(scope); }
        else expect(rendered).toContain(scope);
      }
    expect(reopened.step![0].component[0].doseAndRate?.[0].doseRange).toEqual(range);
  });
  it.each(["free label", "free label only", "stale abbreviation", "matching abbreviation"] as const)(
    "keeps independent timing text distinct from %s", kind => {
      const timing = { code: { text: kind.startsWith("free") ? "after dialysis" : "BID" },
        ...(kind === "free label only" ? {} : { repeat: {
          frequency: kind === "matching abbreviation" ? 2 : 3, period: 1,
          periodUnit: kind === "matching abbreviation" ? FhirPeriodUnit.Day : FhirPeriodUnit.Week } }) };
      const input = inputFor({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing });
      const rows = fresh(toFhirR5Dosages(input)), reopened = fresh(toDosageDetails(rows));
      for (const value of [input, rows, reopened])
        for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
          const rendered = formatSig(value, style, { locale, realizationMode: "normalized" });
          if (kind.startsWith("free")) expect(rendered.match(/after dialysis/gu)).toHaveLength(1);
          if (kind === "free label" || kind === "stale abbreviation") {
            expect(rendered).toContain(locale === "th" ? "สัปดาห์ละ 3 ครั้ง" : style === "short" ? "3x/1wk" : "3 times weekly");
            expect(rendered).not.toContain("BID");
          }
          if (kind === "matching abbreviation")
            expect(rendered).toContain(locale === "th" ? "วันละ 2 ครั้ง" : style === "short" ? "BID" : "twice daily");
        }
      expect(reopened.step![0].component[0].timing).toEqual(timing);
    });
  it.each([false, true])("classifies a fresh safety-only header with R5 site reference=%s", hasSite => {
    const safety = { doseLimit: [{ scope: "administration" as const, valueQuantity: { value: 2, unit: "drop" } }] };
    const input: EzDosage | FhirR6DosageInstruction = hasSite
      ? { siteReference: { display: "left eye" }, safety } : { safety };
    const before = fresh(input);
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      const rendered = formatSig(input, style, { locale, realizationMode: "normalized" });
      expect(rendered).toContain("max per administration: 2 drop");
      const courseLabel = locale === "en" ? "Across this course" : "ตลอดแผนการใช้ยานี้";
      if (hasSite) {
        expect(rendered).toContain(locale === "en" ? "left eye" : "ตาซ้าย");
        expect(rendered).not.toContain(courseLabel);
      } else expect(rendered).toContain(courseLabel);
    }
    expect(input).toEqual(before);
  });
  it("inherits both next-day clocks without an inferred lifetime count", () => {
    const parsed = parseSig("Take 1 tablet at 8 AM and 8 PM for 3 days, then take 2 tablets the next day at the same times");
    expect(parsed.meta.canonical.clauses[1].schedule?.count).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1].schedule?.timeOfDay).toEqual(["08:00:00", "20:00:00"]);
    const options = { orderedAt: "2026-11-01T00:00:00Z", from: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 9 };
    const expected = [1, 2, 3, 4].flatMap(day =>
      ["08", "20"].map(hour => `2026-11-0${day}T${hour}:00:00+00:00`));
    for (const input of [parsed, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      expect(nextDueDoses(input, options)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 10, unit: "tab", quantityKind: "scheduled" });
    }
  });
  it("retains the one-dose count for a standalone next-day fixed clock", () => {
    const parsed = parseSig("Take 2 tablets the next day at 8 AM");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(1);
    for (const input of [parsed, fresh(parsed.fhir), fresh(parsed.fhirNext)])
      expect(nextDueDoses(input, { orderedAt: "2026-11-01T00:00:00Z",
        from: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 5 }))
        .toEqual(["2026-11-02T08:00:00+00:00"]);
  });
});


describe("round58 standalone R5 timing labels", () => {
  it.each(["after dialysis", "BID"])("keeps the correct independent-label decision for %s", text => {
    const input: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { text }, repeat: { frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Week } } };
    const before = JSON.stringify(input);
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      const rendered = formatSig(input, style, { locale, realizationMode: "normalized" });
      if (text === "after dialysis") expect(rendered.match(/after dialysis/gu)).toHaveLength(1);
      else expect(rendered).not.toContain("BID");
      expect(rendered).toContain(locale === "th" ? "สัปดาห์ละ 3 ครั้ง" : style === "short" ? "3x/1wk" : "3 times weekly");
    }
    expect(JSON.stringify(input)).toBe(before);
  });
});


describe("round58 compact timing-code cadence controls", () => {
  it.each([
    ["Q36H", 12], ["Q36H", 36], ["Q1.5H", 12], ["Q36-48H", 12]
  ] as const)("keeps %s shorthand separate from the current %s-hour cadence", (code, hours) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { text: code }, repeat: { period: hours, periodUnit: FhirPeriodUnit.Hour } } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    const before = JSON.stringify(r6);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const actual = formatSig(input, style, { locale, realizationMode: "normalized" });
        const cadence = locale === "th" ? `ทุก ${hours} ชั่วโมง`
          : style === "short" ? `Q${hours}H` : `every ${hours} hours`;
        expect(actual.split(cadence)).toHaveLength(2);
        if (code !== cadence) expect(actual).not.toContain(code);
      }
    expect(JSON.stringify(r6)).toBe(before);
    expect(toDosageDetails(toFhirR5Dosages(r6)).step![0].component[0].timing?.code?.text).toBe(code);
  });
});


describe("round62 independent timing concept text", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const timingFor = (text: string, frequency = 2) => ({
    code: { text, coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "WK" }] },
    repeat: { frequency, period: 1, periodUnit: FhirPeriodUnit.Week },
  });
  it.each(["after dialysis", "WK"])("retains independent %s beside current weekly cadence", text => {
    const timing = timingFor(text);
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing };
    const input: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    const before = fresh(input);
    const rows = fresh(toFhirR5Dosages(input));
    const reopened = fresh(toDosageDetails(rows));
    for (const [label, value] of [["R5", row], ["R6", input], ["R5 save", rows], ["R6 reopened", reopened]] as const) {
      const native = importCanonicalCourse(value);
      expect(native.stages[0].administrations[0].schedule?.code).toEqual(timing.code);
      expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject(timing.repeat);
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        for (const [api, rendered] of [
          ["direct", formatSig(value, style, { locale, realizationMode: "normalized" })],
          ["native", formatCanonicalCourse(native, style, { locale, realizationMode: "normalized" })],
        ]) {
          expect(rendered).toContain(locale === "th" ? "สัปดาห์ละ 2 ครั้ง" : style === "short" ? "2x/1wk" : "twice weekly");
          if (text === "after dialysis") {
            expect(rendered, `${label}/${api}/${locale}/${style}`).toContain(text);
            expect(rendered.match(/after dialysis/gu)).toHaveLength(1);
          }
          else expect(rendered).not.toContain("WK");
        }
      }
    }
    expect(canonicalToFhir(canonicalFromFhir(row)).timing).toEqual(timing);
    expect(parserStateToFhir(parserStateFromFhir(row)).timing).toEqual(timing);
    expect(rows[0].timing).toEqual(timing);
    expect(reopened.step![0].component[0].timing).toEqual(timing);
    expect(fresh(fromFhir(input).fhirNext).step![0].component[0].timing).toEqual(timing);
    expect(input).toEqual(before);
  });
  it("keeps a matching cadence code beside an independent short-preview label", () => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: timingFor("after dialysis", 1),
    }] }] };
    expect(formatSig(input, "short", { locale: "en", realizationMode: "normalized" }))
      .toBe("1 tab WK after dialysis");
  });
});


it("retains current-R6 approximate Quantity extensions on Timing elements", () => {
  const timing: NonNullable<FhirR6Dosage["timing"]> = {
    extension: [{ url: "urn:test:timing-note", valueQuantity: { value: 2, comparator: "~", unit: "mL" } }],
    modifierExtension: [{ url: "urn:test:timing-modifier", valueQuantity: { value: 4, comparator: "~", unit: "h" } }],
    repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      extension: [{ url: "urn:test:repeat-note", valueQuantity: { value: 3, comparator: "~", unit: "d" } }] },
  };
  const input: FhirR6DosageInstruction = { step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing,
  }] }] };
  const before = structuredClone(input);
  const rows = toFhirR5Dosages(input);
  for (const restored of [fromFhir(input).fhirNext, toDosageDetails(structuredClone(rows))])
    expect(restored.step![0].component[0].timing).toEqual(timing);
  expect(input).toEqual(before);
});


describe("round64 retained interchange annotations", () => {
  const fresh = <T>(value: T): T => cloneStructuredValue(value);
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const dose = (value = 1): FhirR6Dosage => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });

  it.each([undefined, 30])("keeps a qualified scalar duration and its authored upper endpoint %s", maximum => {
    const quantity = simpleQuantityForR5({ id: "qualified-duration", value: 15, comparator: "~",
      unit: "min", code: "min", system: "http://unitsofmeasure.org" })!;
    const marker = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueQuantity: quantity };
    const row: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 20, unit: "mL/h" } }],
      timing: { repeat: { ...daily, ...(maximum !== undefined ? {
        durationMax: maximum, durationUnit: FhirPeriodUnit.Minute,
        _duration: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason",
          valueCode: "unknown" }] },
      } : {}), extension: [marker] } } };
    const before = fresh(row);
    let wire = toDosageDetails([row]);
    for (let save = 0; save < 2; save++) {
      const recurrence = importCanonicalCourse(fresh(wire)).stages[0].administrations[0].schedule!.recurrence!;
      if (maximum !== undefined) {
        expect(recurrence.occurrenceDurationRange?.low).toEqual(quantityFromR5(quantity));
        expect(recurrence.occurrenceDurationRange?.high).toMatchObject({ value: 30, unit: "min", code: "min" });
        expect(recurrence.occurrenceDuration).toBeUndefined();
      } else {
        expect(recurrence.occurrenceDuration).toBe(15);
        expect(recurrence.occurrenceDurationComparator).toBe("~");
        expect(recurrence.occurrenceDurationRange).toBeUndefined();
      }
      wire = toDosageDetails(fresh(toFhirR5Dosages(wire)));
    }
    expect(row).toEqual(before);
  });

  it("preserves an extension-only event beside an authored clock using the existing clock carrier", () => {
    const annotation = { id: "event-note", extension: [{ url: "urn:clinic:event-note", valueString: "retain" }] };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dose(), timing: {
      repeat: { ...daily, timeOfDay: ["08:00:00"], _when: [annotation] },
    } }] }] };
    const before = fresh(input);
    let wire = courseToR6(importCanonicalCourse(input));
    for (let save = 0; save < 2; save++) {
      const row = toFhirR5Dosages(wire)[0], repeat = row.timing!.repeat!;
      expect(repeat.timeOfDay).toBeUndefined();
      expect(repeat._timeOfDay).toBeUndefined();
      expect(repeat._when).toEqual([annotation]);
      expect(getTimingClocks(repeat)).toEqual(["08:00:00"]);
      expect(nextDueDoses([row], { orderedAt: "2026-11-25T00:00:00Z", from: "2026-11-25T00:00:00Z",
        timeZone: "UTC", limit: 2 })).toEqual(["2026-11-25T08:00:00+00:00", "2026-11-26T08:00:00+00:00"]);
      wire = toDosageDetails(fresh([row]));
    }
    expect(input).toEqual(before);
    const ordinary: FhirR6DosageInstruction = { step: [{ component: [{ ...dose(), timing: {
      repeat: { ...daily, timeOfDay: ["08:00:00"] },
    } }] }] };
    expect(toFhirR5Dosages(ordinary)[0].timing!.repeat!.timeOfDay).toEqual(["08:00:00"]);
  });

  it("retains graph relation IDs and unfamiliar children through the existing graph codec", () => {
    const actions = parseInstructionActions("shake well bottle then rinse off with water");
    expect(actions).toHaveLength(2);
    const wire = fresh(buildInstructionGraphExtension({ actions, relations: [{
      kind: AdviceRelation.Before, fromActionIndex: 0, toActionIndex: 1,
    }] })!);
    const relation = wire.extension!.find(value => value.url === "graphRelation")!;
    const annotation = { url: "urn:clinic:relation-provenance", extension: [{ url: "author", valueString: "clinic" }] };
    relation.id = "authored-before";
    relation.extension!.push(annotation);
    const before = fresh(wire);
    let rebuilt = wire;
    for (let save = 0; save < 2; save++) {
      const graph = parseInstructionGraphExtension([fresh(rebuilt)])!;
      expect(graph.relations![0]).toMatchObject({ kind: AdviceRelation.Before, fromActionIndex: 0, toActionIndex: 1 });
      rebuilt = buildInstructionGraphExtension(graph)!;
      const current = rebuilt.extension!.find(value => value.url === "graphRelation")!;
      expect(current.id).toBe("authored-before");
      expect(current.extension).toContainEqual(annotation);
    }
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dose(), extension: [rebuilt] }] }] };
    const reopened = toDosageDetails(fresh(toFhirR5Dosages(input)));
    const graph = reopened.step[0].component[0].extension!.find(value => value.url === rebuilt.url)!;
    expect(graph.extension!.find(value => value.url === "graphRelation")).toMatchObject({
      id: "authored-before", extension: expect.arrayContaining([annotation]),
    });
    expect(wire).toEqual(before);
  });

  it("detaches standard target Coding annotations only in the explicit spatial clone", () => {
    const opaque = { clinic: ["shared opaque value"] };
    const target = { system: "http://snomed.info/sct", code: "123", display: "target",
      _display: { extension: [{ url: "urn:clinic:display", valueString: "authored" }] },
      extension: [{ url: "urn:clinic:coding", valueBoolean: true }], i18n: { th: "ตำแหน่ง" }, opaque };
    const input = { relationText: "around", targetCoding: target };
    const cloned = cloneBodySiteSpatialRelation(input)!;
    const current = cloned.targetCoding as typeof target;
    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
    expect(current).not.toBe(target);
    expect(current._display).not.toBe(target._display);
    expect(current._display.extension).not.toBe(target._display.extension);
    expect(current._display.extension[0]).not.toBe(target._display.extension[0]);
    expect(current.extension).not.toBe(target.extension);
    expect(current.extension[0]).not.toBe(target.extension[0]);
    expect(current.i18n).not.toBe(target.i18n);
    expect(current.opaque).toBe(opaque);
  });

  it("preserves native approximate Quantity extensions on the R6 site wrapper", () => {
    const extension = { url: "urn:clinic:site-area", valueQuantity: { value: 2, comparator: "~" as const, unit: "cm2" } };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dose(),
      site: { id: "application-site", concept: { text: "left arm" }, extension: [extension] },
    }] }] };
    const before = fresh(input);
    const current = courseToR6(importCanonicalCourse(input));
    expect(current.step[0].component[0].site).toEqual(input.step[0].component[0].site);
    expect(toDosageDetails(fresh(toFhirR5Dosages(current))).step[0].component[0].site)
      .toEqual(input.step[0].component[0].site);
    expect(input).toEqual(before);
  });

  it.each(["append annotation", "new annotation", "changed clock"] as const)(
    "keeps an editable pause only when valued induction clocks are unchanged (%s)", edit => {
    const changed = edit === "changed clock";
    const input: FhirR6DosageInstruction = { step: [
      { id: "induction", component: [{ ...dose(), id: "initial",
        timing: { repeat: { ...daily, count: 7,
          ...(edit === "new annotation" ? {} : { timeOfDay: ["09:00:00"] }) } } }] },
      { id: "pause", end: { offsetDuration: { value: 14, unit: "d" } }, component: [] },
      { id: "resume", component: [{ ...dose(2), id: "later", timing: { repeat: daily } }] },
    ] };
    let wire = fresh(courseToR6(importCanonicalCourse(input)));
    const note = { id: "clock-note", extension: [{ url: "urn:clinic:clock-note", valueString: "retain" }] };
    const clocks = edit === "new annotation" ? [null] : [changed ? "10:00:00" : "09:00:00", null];
    const annotations = edit === "new annotation" ? [note] : [null, note];
    wire.step[0].component[0].timing!.repeat!.timeOfDay = clocks;
    wire.step[0].component[0].timing!.repeat!._timeOfDay = annotations;
    for (let save = 0; save < 2; save++) {
      const before = fresh(wire);
      expect(fromDosageDetails(wire).course.step?.map(step => step.id))
        .toEqual(changed ? ["induction", "resume"] : ["induction", "pause", "resume"]);
      expect(wire).toEqual(before);
      const repeat = wire.step[0].component[0].timing!.repeat!;
      expect(repeat.timeOfDay).toEqual(clocks);
      expect(repeat._timeOfDay).toEqual(annotations);
      wire = toDosageDetails(fresh(toFhirR5Dosages(wire)));
    }
  });
});


describe("round68 native condition and count meaning", () => {
  it.each([
    ["eq", true, true], ["eq", false, false],
    ["ne", true, false], ["ne", false, true],
  ] as const)("applies Boolean %s to %s without rewriting source annotations", (operation, valueBoolean, expected) => {
    const condition = { code: { coding: [{ code: "problem-presents" }] },
      details: { text: "fasting" }, operation, valueBoolean,
      extension: [{ url: "https://example.org/condition-note", valueString: "retain" }] };
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], condition: [condition],
    }] }] };
    const before = cloneStructuredValue(source);
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(source))) as FhirDosage[];
    for (const input of [source, saved]) {
      expect(formatSig(input, "long", { locale: "en" }))
        .toContain(expected ? "only if fasting" : "only if not fasting");
      expect(courseToR6(importCanonicalCourse(input)).step?.[0].component?.[0].condition)
        .toEqual([condition]);
    }
    expect(getDosageCondition(saved[0])).toMatchObject({ kind: "state", name: "fasting", expected });
    expect(source).toEqual(before);
  });

  it("retains an unresolved Boolean operation without interpreting it as equality", () => {
    const condition = { code: { coding: [{ code: "problem-presents" }] },
      details: { text: "fasting" }, operation: "gt" as const, valueBoolean: false };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ condition: [condition] }] }] };
    const rows = toFhirR5Dosages(source);
    expect(getDosageCondition(rows[0])).toMatchObject({ kind: "text", text: "fasting" });
    expect(courseToR6(importCanonicalCourse(rows)).step?.[0].component?.[0].condition).toEqual([condition]);
  });

  it.each([2, undefined])("retains both count bounds in Thai long preview (minimum %s)", count => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count, countMax: 3, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    for (const input of [source, JSON.parse(JSON.stringify(toFhirR5Dosages(source)))]) {
      expect(formatSig(input, "long", { locale: "th" })).toContain(count === undefined ? "ไม่เกิน 3 ครั้ง" : "จำนวน 2-3 ครั้ง");
    }
  });
});


describe("round68 current preview fields", () => {
  it.each([1, 2])("honors a fresh cadence of %s without changing the retained instruction", frequency => {
    const text = "1 tablet twice daily; do not crush";
    const row = JSON.parse(JSON.stringify(parseSig(text).fhir[0])) as FhirDosage;
    row.timing!.repeat!.frequency = frequency;
    const before = cloneStructuredValue(row), native = importCanonicalCourse(row);
    const r6 = courseToR6(native);
    for (const input of [row, native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const preview = formatSig(input, "long", { locale: "en", realizationMode: "roundtrip" });
      expect(preview).toMatch(frequency === 1
        ? /^(?:(?:Take|Use) )?1 tablet (?:once )?daily[.;]/i
        : /^(?:(?:Take|Use) )?1 tablet twice daily[.;]/i);
      expect(preview.toLowerCase()).toContain("do not crush");
    }
    expect(row).toEqual(before);
    expect(JSON.stringify(r6)).toContain(text);
  });

  it.each([
    [{ system: "urn:hospital:timing", code: "QID" }, "Per clinic protocol", "Per clinic protocol"],
    [{ system: "urn:hospital:timing", code: "QID" }, "QID", "QID"],
    [{ system: "urn:hospital:timing", code: "QID" }, undefined, "QID"],
    [{ system: "urn:hospital:timing", code: "rx17", display: "At bedtime" }, undefined, "At bedtime"],
  ] as const)("keeps local timing %j as its supplied label", (coding, text, label) => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [coding], ...(text ? { text } : {}) } },
    }] }] };
    const before = cloneStructuredValue(source);
    for (const input of [source, importCanonicalCourse(source), JSON.parse(JSON.stringify(toFhirR5Dosages(source)))]) {
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const preview = formatSig(input, style, { locale, realizationMode: "normalized" });
        expect(preview).toContain(label);
        expect(preview).not.toMatch(/four times daily|วันละ 4 ครั้ง/);
      }
    }
    expect(source).toEqual(before);
  });

  it.each([2, 3, undefined])("keeps the English occurrence bounds with minimum %s", count => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count, countMax: 3, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    const expected = count === undefined ? "for up to 3 doses" : count === 3 ? "for 3 doses" : "for 2 to 3 doses";
    for (const input of [source, JSON.parse(JSON.stringify(toFhirR5Dosages(source)))])
      expect(formatSig(input, "long", { locale: "en" })).toContain(expected);
  });

  it("keeps a separate target count when the rich action realizes its site", () => {
    const text = "Apply 1 g to affected skin gently", frame = parseInstructionActions("Apply 1 g")[0];
    const graph: CanonicalInstructionGraph = { sourceText: text, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: text.length }, actions: [{ ...frame,
        sourceText: text, span: { start: 0, end: text.length }, args: [
          frame.args.find(argument => argument.role === AdviceArgumentRole.Amount)!,
          { role: AdviceArgumentRole.Site, text: "affected skin", normalized: "affected skin", i18n: { th: "ผิวหนังบริเวณที่เป็น" } },
          { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { th: "เบาๆ" } },
        ],
      }] };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      site: { text: "affected skin" }, method: { text: "Apply" },
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      extension: [buildInstructionGraphExtension(graph)!] };
    const original = JSON.parse(JSON.stringify(row));
    const edited: FhirDosage = { ...row, site: { ...row.site,
      extension: [...(row.site?.extension ?? []), buildBodySiteAdministrationTargetCountExtension(3)!] } };
    const native = importCanonicalCourse(edited);
    expect(importCanonicalCourse(row).stages[0].administrations[0].targetCount).toBeUndefined();
    const r6 = courseToR6(native);
    expect(row).toEqual(original);
    for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toContain("รวม 3 จุด");
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("across 3 sites");
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("shows an unmapped site code in both Thai styles without guessing laterality", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      site: { concept: { coding: [{ system: "urn:hospital:site", code: "SITE-OD" }] } },
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    for (const input of [source, JSON.parse(JSON.stringify(toFhirR5Dosages(source)))])
      for (const style of ["short", "long"] as const) {
        const preview = formatSig(input, style, { locale: "th", realizationMode: "normalized" });
        expect(preview).toContain("SITE-OD");
        expect(preview).not.toMatch(/ตาขวา|ตาซ้าย/);
      }
  });
});


describe("code-only compact interval previews", () => {
  it.each([
    ["Q36H", "every 36 hours", "ทุก 36 ชั่วโมง"],
    ["Q1.5H", "every 90 minutes", "ทุก 90 นาที"],
    ["Q36-48H", "every 36 to 48 hours", "ทุก 36 ถึง 48 ชั่วโมง"],
  ] as const)("expands %s while preserving the current code-only timing", (code, english, thai) => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ code, extension: [
        { url: "urn:clinic:timing-note", valueString: "Retain the authored shorthand" },
      ] }] } },
    }] }] };
    const original = JSON.parse(JSON.stringify(input));
    const component = input.step![0].component[0];
    const native = importCanonicalCourse(input);
    const projected = projectCanonicalCourse(native);
    for (const dosage of [input, native, JSON.parse(JSON.stringify(projected.fhir)),
      JSON.parse(JSON.stringify(projected.fhirNext))]) {
      const before = JSON.stringify(dosage);
      const current = importCanonicalCourse(dosage);
      const administration = current.stages[0].administrations[0];
      expect(administration.amounts).toHaveLength(1);
      expect(administration.amounts![0].quantity).toEqual({ value: 1, unit: "tab" });
      expect(administration.schedule?.code).toEqual(component.timing!.code);
      expect(administration.schedule?.recurrence?.frequency).toBeUndefined();
      expect(administration.schedule?.recurrence?.period).toBeUndefined();
      expect(administration.schedule?.recurrence?.periodMax).toBeUndefined();
      expect(administration.schedule?.recurrence?.periodUnit).toBeUndefined();
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const cadence = locale === "th" ? thai : style === "short" ? code : english;
        const rendered = formatSig(dosage, style, { locale, realizationMode: "normalized" });
        expect(rendered.split(code)).toHaveLength(2);
        expect(rendered.split(cadence)).toHaveLength(2);
      }
      const saved = projectCanonicalCourse(current);
      for (const row of [saved.fhir[0], saved.fhirNext.step![0].component[0]]) {
        expect(row.doseAndRate).toEqual(component.doseAndRate);
        expect(row.timing).toEqual(component.timing);
      }
      expect(saved.fhirNext.renderedInstruction).toBeUndefined();
      expect(JSON.stringify(dosage)).toBe(before);
    }
    const source = `Take 1 tablet ${code}`;
    const supplied: FhirR6DosageInstruction = { ...input, renderedInstruction: source };
    const suppliedBefore = JSON.stringify(supplied);
    const savedSource = projectCanonicalCourse(importCanonicalCourse(supplied));
    const reopenedSource = toDosageDetails(JSON.parse(JSON.stringify(savedSource.fhir)));
    for (const saved of [savedSource.fhirNext, reopenedSource]) {
      expect(saved.renderedInstruction).toBe(source);
      expect(saved.step![0].component[0].timing).toEqual(component.timing);
      expect(saved.step![0].component[0].doseAndRate).toEqual(component.doseAndRate);
    }
    expect(JSON.stringify(supplied)).toBe(suppliedBefore);
    expect(input).toEqual(original);
  });

  it("keeps the established Q6H wording", () => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ code: "Q6H" }] } },
    }] }] };
    expect(formatSig(input, "long", { locale: "en" })).toContain("every 6 hours");
    expect(formatSig(input, "long", { locale: "th" })).toContain("ทุก 6 ชั่วโมง");
  });
});


describe("independently authored integer phase order", () => {
  const options = { orderedAt: "2027-01-01T00:00:00Z", from: "2027-01-01T00:00:00Z", timeZone: "UTC" };
  it("orders all supplied integer R5 sequences while retaining equal-sequence concurrency", () => {
    for (const sequence of [[0, 1], [-2, 0]]) {
      const rows: FhirDosage[] = sequence.map((value, index) => ({ sequence: value,
        doseAndRate: [{ doseQuantity: { value: index + 1, unit: "tab" } }],
        timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } } }));
      rows.reverse();
      const before = JSON.stringify(rows), converted = toDosageDetails(rows);
      expect(converted.step).toHaveLength(2);
      for (const input of [rows, converted]) {
        expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
          "2027-01-01T09:00:00+00:00", "2027-01-02T09:00:00+00:00"
        ]);
        expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
      }
      expect(JSON.stringify(rows)).toBe(before);
    }
    const equal: FhirDosage[] = [1, 2].map(value => ({ sequence: 0,
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } } }));
    expect(toDosageDetails(equal).step).toHaveLength(1);
    expect(calculateTotalUnits({ dosage: toDosageDetails(equal), ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(3);
  });

});


describe("dated phase start previews", () => {
  const options = { orderedAt: "2027-01-01T00:00:00Z", from: "2027-01-01T00:00:00Z", timeZone: "UTC" };
  it("uses an authored calendar start instead of an inherited later-day heading", () => {
    const boundary = (value: number) => ({ contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
      offsetDuration: { value, unit: "d", code: "d" } });
    for (const dated of [true, false]) {
      const course: FhirR6DosageInstruction = { step: [
        { end: boundary(4), component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
          timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } } }] },
        { end: boundary(6), component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"],
            ...(dated ? { boundsPeriod: { start: "2027-01-03" } } : {}) } } }] }
      ] };
      for (const input of [course, toFhirR5Dosages(course), importCanonicalCourse(course)]) {
        const text = formatSig(input, "long", { locale: "en" });
        if (dated) {
          expect(text).toContain("starting 3 Jan 2027");
          expect(text).not.toContain("From 4 days after treatment start");
          expect(text).not.toContain("until 4 days after treatment start");
          expect(calculateTotalUnits({ dosage: input, ...options, from: "2027-01-03T00:00:00Z",
            durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
        } else expect(text).toContain("From 4 days after treatment start");
      }
    }
  });
});


describe("R6 stage safety in individual previews", () => {
  it("shows the current stage limit and exceeded policy without leaking them to the loading item", () => {
    const component = (value: number) => ({
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    });
    const safety = {
      doseLimit: [{ scope: "administration" as const, valueQuantity: { value: 2, unit: "tab" } }],
      ifExceeded: "Call the clinic"
    };
    const wire: FhirR6DosageInstruction = {
      step: [{ component: [component(3)] }, { component: [component(1)], safety }]
    };
    const imported = fromFhir(wire, { locale: "en" });
    expect(imported.items).toHaveLength(2);
    for (const text of [imported.items[1].shortText, imported.items[1].longText]) {
      expect(text).toContain("max per administration: 2 tab");
      expect(text).toContain("Call the clinic");
    }
    for (const text of [imported.items[0].shortText, imported.items[0].longText]) {
      expect(text).not.toContain("max per administration");
      expect(text).not.toContain("Call the clinic");
    }
    expect(imported.fhirNext.step![1].safety).toEqual(safety);
  });
});


describe("independent authored header and phase limits", () => {
  it.each([false, true])("retains a header warning with matching component text %s", matchingText => {
    const instruction = "Take 1 tablet daily. Do not crush.";
    const source: FhirR6DosageInstruction = { renderedInstruction: instruction, step: [{ component: [{
      ...(matchingText ? { text: instruction } : {}),
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      extension: [{ url: "https://example.test/header-note", valueString: "Keep this annotation" }]
    }] }] };
    for (const input of [source, toFhirR5Dosages(source)]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(/Do not crush/gu)).toHaveLength(1);
        expect(text).toContain(locale === "en" ? "1 tablet once daily" : "1 เม็ด วันละครั้ง");
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(toDosageDetails(toFhirR5Dosages(source)).renderedInstruction).toBe(instruction);
  });

  it.each(["2027-01-03", "2027-01-07"])("retains the first phase upper limit before a %s successor", start => {
    const boundary = (value: number) => ({ contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] }, offsetDuration: { value, unit: "d", code: "d" } });
    const course: FhirR6DosageInstruction = { step: [
      { end: boundary(4), component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } } }] },
      { end: boundary(8), component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["09:00:00"], boundsPeriod: { start } } } }] }
    ] };
    for (const input of [course, toFhirR5Dosages(course), importCanonicalCourse(course)]) {
      const en = formatSig(input, "long", { locale: "en" });
      expect(en).toContain("up to 4 days after treatment start");
      expect(en).toContain("starting " + (start.endsWith("03") ? "3" : "7") + " Jan 2027");
      expect(en).not.toContain("From 4 days after treatment start");
      const th = formatSig(input, "long", { locale: "th" });
      expect(th).toContain("4 วัน");
      const options = { dosage: input, orderedAt: "2027-01-01T00:00:00Z", timeZone: "UTC",
        from: "2027-01-03T00:00:00Z", durationValue: 1, durationUnit: FhirPeriodUnit.Day };
      expect(calculateTotalUnits(options).totalUnits).toBe(start.endsWith("03") ? 1 : 2);
      if (start.endsWith("07")) expect(calculateTotalUnits({ ...options,
        from: "2027-01-05T00:00:00Z", durationValue: 2 }).totalUnits).toBe(0);
    }
  });
});


describe("current FHIR graph annotations and compatible dose ceilings", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const note: FhirExtension = { url: "urn:clinic:annotation", valueString: "retain clinic note" };
  const child = (parent: FhirExtension, url: string) => parent.extension!.find(field => field.url === url)!;

  it.each(["sourceLocale", "primaryAdministrationStart", "primaryAdministrationEnd"])(
    "retains primitive metadata on the graph %s field", fieldName => {
      const sourceText = "Swallow 1 tablet with water";
      const input = buildInstructionGraphExtension({ sourceText, sourceLocale: "en",
        primaryAdministrationSpan: { start: 0, end: sourceText.length },
        actions: parseInstructionActions(sourceText) })!;
      const field = child(input, fieldName);
      const annotation = { id: fieldName + "-value", extension: [note] };
      field.id = fieldName + "-field";
      if (fieldName === "sourceLocale") field._valueCode = annotation;
      else Object.assign(field, { _valueInteger: annotation });
      const before = fresh(input), decoded = parseInstructionGraphExtension([fresh(input)])!;
      expect(decoded.sourceLocale).toBe("en");
      expect(decoded.primaryAdministrationSpan).toEqual({ start: 0, end: sourceText.length });
      expect(child(buildInstructionGraphExtension(decoded)!, fieldName)).toEqual(field);
      expect(input).toEqual(before);
    }
  );

  it.each(["argument", "predicate"] as const)("keeps annotated %s translations with their own locale", owner => {
    const sourceText = "Swallow with water";
    const graph: CanonicalInstructionGraph = { sourceText, sourceLocale: "en", actions: parseInstructionActions(sourceText) };
    const frame = graph.actions[0], argument = frame.args.find(arg => arg.text.toLowerCase().includes("water"))!;
    expect(argument).toBeDefined();
    const translations = owner === "argument" ? { en: "water", th: "น้ำ" } : { en: "swallow", th: "กลืน" };
    if (owner === "argument") argument.i18n = translations;
    else frame.predicate.i18n = translations;
    const input = buildInstructionGraphExtension(graph)!;
    const action = child(input, "action"), node = owner === "argument"
      ? action.extension!.find(field => field.url === "argument" && child(field, "text").valueString === argument.text)!
      : action;
    const name = owner === "argument" ? "translation" : "predicateTranslation";
    const entries = node.extension!.filter(field => field.url === name);
    const thai = entries.find(field => child(field, "locale").valueCode === "th")!;
    thai.id = "thai-translation";
    child(thai, "locale")._valueCode = { id: "thai-locale", extension: [note] };
    child(thai, "text")._valueString = { id: "thai-text", extension: [note] };
    thai.extension!.push({ url: "urn:clinic:translation-note", valueString: "authored in Thai" });
    const before = fresh(input), decoded = parseInstructionGraphExtension([fresh(input)])!;
    expect(owner === "argument" ? decoded.actions[0].args.find(arg => arg.text === argument.text)!.i18n
      : decoded.actions[0].predicate.i18n).toEqual(translations);
    const rebuiltAction = child(buildInstructionGraphExtension(decoded)!, "action");
    const rebuiltNode = owner === "argument"
      ? rebuiltAction.extension!.find(field => field.url === "argument" && child(field, "text").valueString === argument.text)!
      : rebuiltAction;
    expect(rebuiltNode.extension!.filter(field => field.url === name)).toEqual(entries);
    expect(input).toEqual(before);
  });

  it.each([3, undefined])("accepts a native cycle-count primitive companion with value %s", count => {
    const extension: FhirR6Extension = { url: COURSE_CYCLE_COUNT_EXTENSION_URL,
      ...(count === undefined ? {} : { valueInteger: count }),
      _valueInteger: { id: "cycle-count", extension: [{ url: "urn:clinic:estimate",
        valueQuantity: { value: 3, comparator: "~" } }] } };
    const input: FhirR6DosageInstruction = { modifierExtension: [extension], step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count: 2, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = fresh(input);
    expect(toDosageDetails(fresh(toFhirR5Dosages(input))).modifierExtension).toContainEqual(extension);
    expect(input).toEqual(before);
  });

  it.each(["quantity", "range"] as const)("exposes the compatible ceiling for a %s dose in either limit order", kind => {
    const volume = { value: 10, unit: "mL", id: "volume-cap" };
    const mass = { value: 20, comparator: "<" as const, unit: "mg", id: "mass-cap" };
    for (const limits of [[volume, mass], [mass, volume]]) {
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [kind === "quantity" ? { doseQuantity: { value: 5, unit: "mL" } }
          : { doseRange: { low: { value: 5, unit: "mL" }, high: { value: 15, unit: "mL" } } }],
        safety: { doseLimit: limits.map(valueQuantity => ({ scope: "administration", valueQuantity })) }
      }] }] };
      const before = fresh(input), rows = toFhirR5Dosages(input);
      expect(rows[0].maxDosePerAdministration).toEqual(volume);
      expect(toDosageDetails(fresh(rows)).step![0].component[0].safety?.doseLimit)
        .toEqual(input.step![0].component[0].safety!.doseLimit);
      expect(toFhirR5Dosages(toDosageDetails(fresh(rows)))[0].maxDosePerAdministration).toEqual(volume);
      expect(input).toEqual(before);
    }
  });

  it.each(["administration", "lifetime"] as const)("keeps the tightest converted %s ceiling within the dose-compatible group", scope => {
    const sameUnit = { value: 12, unit: "mL", id: "same-unit-cap" };
    const converted = { value: 0.01, unit: "L", id: "tighter-volume-cap" };
    const unrelated = { value: 20, unit: "mg", id: "mass-cap" };
    const orders = [[sameUnit, converted], [converted, sameUnit],
      [sameUnit, converted, unrelated], [sameUnit, unrelated, converted],
      [converted, sameUnit, unrelated], [converted, unrelated, sameUnit],
      [unrelated, sameUnit, converted], [unrelated, converted, sameUnit]];
    for (const quantities of orders) {
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 5, unit: "mL" } }],
        safety: { doseLimit: quantities.map(valueQuantity => ({ scope, valueQuantity })) }
      }] }] };
      const before = fresh(input), rows = toFhirR5Dosages(input);
      expect(scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime).toEqual(converted);
      expect(toDosageDetails(fresh(rows)).step![0].component[0].safety?.doseLimit)
        .toEqual(input.step![0].component[0].safety!.doseLimit);
      expect(input).toEqual(before);
    }
  });

  it.each(["low", "high"] as const)("uses the unit supplied only on the %s dose endpoint for the standard ceiling", endpoint => {
    const volume = { value: 10, unit: "mL" }, mass = { value: 20, unit: "mg" };
    for (const quantities of [[volume, mass], [mass, volume]]) {
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseRange: { low: { value: 5, ...(endpoint === "low" ? { unit: "mL" } : {}) },
          high: { value: 15, ...(endpoint === "high" ? { unit: "mL" } : {}) } } }],
        safety: { doseLimit: quantities.map(valueQuantity => ({ scope: "administration", valueQuantity })) }
      }] }] };
      const before = fresh(input), rows = toFhirR5Dosages(input);
      expect(rows[0].maxDosePerAdministration).toEqual(volume);
      expect(toDosageDetails(fresh(rows)).step![0].component[0].safety?.doseLimit)
        .toEqual(input.step![0].component[0].safety!.doseLimit);
      expect(input).toEqual(before);
    }
  });
});


describe("current weight-normalized maximum compatibility", () => {
  it.each(["administration", "lifetime"] as const)("keeps comparable weight-normalized ceilings in one %s group", scope => {
    const sameUnit = { value: 2, unit: "mg/kg", system: "http://unitsofmeasure.org", code: "mg/kg", id: "milligram-limit" };
    const tighter = { value: 0.001, unit: "g/kg", system: "http://unitsofmeasure.org", code: "g/kg", id: "gram-limit" };
    const absolute = { value: 0.5, unit: "mg", id: "absolute-limit" };
    for (const quantities of [[sameUnit, tighter], [tighter, sameUnit],
      [sameUnit, absolute, tighter], [tighter, absolute, sameUnit]]) {
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 5, unit: "mg/kg", system: "http://unitsofmeasure.org", code: "mg/kg" } }],
        safety: { doseLimit: quantities.map(valueQuantity => ({ scope, valueQuantity })) }
      }] }] };
      const before = JSON.stringify(input), rows = toFhirR5Dosages(input);
      expect(scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime).toEqual(tighter);
      expect(toDosageDetails(JSON.parse(JSON.stringify(rows))).step![0].component[0].safety?.doseLimit)
        .toEqual(input.step![0].component[0].safety!.doseLimit);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("current structured preview qualifiers", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
  const views = (input: FhirR6DosageInstruction) => {
    const r5 = toFhirR5Dosages(input);
    const returned = toDosageDetails(r5);
    return { r5, returned, values: [input, importCanonicalCourse(input), r5, returned] };
  };

  it.each(["dose and interval", "dose and count only", "interval only", "count only", "authored count only"])(
    "qualifies an annotated unknown finite cycle count with %s", variant => {
      const count: FhirR6Extension = { url: COURSE_CYCLE_COUNT_EXTENSION_URL,
        _valueInteger: { id: "unknown-cycle-count", extension: [{
          url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
        }] } };
      const input: FhirR6DosageInstruction = {
        ...(variant.startsWith("dose and ") ? { step: [{ component: [{ ...dose, timing: { repeat: daily },
          ...(variant === "dose and count only" ? { text: "Take 1 tablet daily." } : {})
        }] }] } : {}),
        ...(variant === "authored count only" ? { renderedInstruction: "Follow the treatment plan." }
          : variant === "dose and count only" ? { renderedInstruction: "Take 1 tablet daily." } : {}),
        ...(!variant.endsWith("count only") ? { repeatCycle: { value: 28, unit: "d", code: "d", system: "http://unitsofmeasure.org" } } : {}),
        modifierExtension: [count]
      };
      const before = JSON.stringify(input);
      const { returned, values } = views(input);
      expect(importCanonicalCourse(input).cycleCount).toBeUndefined();
      expect(importCanonicalCourse(input).cycleCountUnresolved).toBe(true);
      expect(returned.modifierExtension).toContainEqual(count);
      if (variant.startsWith("dose and ")) {
        expect(returned.step?.[0].component?.[0].doseAndRate).toEqual(dose.doseAndRate);
        expect(returned.step?.[0].component?.[0].timing?.repeat).toEqual(daily);
      }
      if (input.renderedInstruction) expect(returned.renderedInstruction).toBe(input.renderedInstruction);
      if (variant === "dose and count only") expect(returned.step?.[0].component?.[0].text).toBe(input.renderedInstruction);
      for (const value of values)
        for (const locale of ["en", "th"])
          for (const style of ["short", "long"] as const) {
            const text = formatSig(value, style, { locale, realizationMode: "normalized" });
            expect(text).toContain(locale === "en" ? "Unresolved cycle timing" : "ยังระบุเวลาในรอบไม่ได้");
            expect(text).not.toContain(locale === "en" ? "Repeat this schedule every" : "ทำซ้ำแผนการใช้ยานี้ทุก");
            if (!variant.endsWith("count only")) expect(text).toContain(locale === "en" ? "28 days" : "28 วัน");
            if (variant.startsWith("dose and ")) expect(text).toContain(locale === "en" ? "1 tab" : "1 เม็ด");
            if (input.renderedInstruction) expect(text).toContain(input.renderedInstruction);
          }
      for (const locale of ["en", "th"]) {
        const imported = fromFhir(input, { locale, realizationMode: "normalized" });
        for (const style of ["short", "long"] as const) {
          const qualifier = locale === "en" ? "Unresolved cycle timing" : "ยังระบุเวลาในรอบไม่ได้";
          expect(formatParseBatch(imported, style)).toContain(qualifier);
          if (variant === "authored count only") {
            const item = imported.items[0];
            expect(style === "short" ? item.shortText : item.longText).toContain(qualifier);
            expect(formatParseBatch(imported, style)).toContain(input.renderedInstruction!);
          }
        }
        expect(imported.meta.canonical.course?.cycleCount).toBeUndefined();
        expect(imported.meta.canonical.course?.cycleCountUnresolved).toBe(true);
        expect(imported.fhirNext).toEqual(input);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
  );

  it.each(["oral inhalation", "oral", "coded oral"])("honors the current %s route", variant => {
    const route = { text: variant === "oral" ? "oral" : "oral inhalation",
      ...(variant === "coded oral" ? { coding: [{ system: "http://snomed.info/sct", code: RouteCode["Oral route"] }] } : {}) };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ route,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "puff" } }] }] }] };
    const before = JSON.stringify(input);
    const { returned, values } = views(input);
    expect(returned.step?.[0].component?.[0].route).toEqual(route);
    for (const value of values) {
      const en = formatSig(value, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(value, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("1 puff");
      expect(th).toContain("1 พัฟ");
      if (variant === "oral inhalation") {
        expect(en).toContain("via inhalation");
        expect(th).toMatch(/^สูด/u);
        expect(th).not.toContain("รับประทาน");
      } else {
        expect(en).toContain("orally");
        expect(th).toMatch(/^รับประทาน/u);
      }
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("retains each fresh alternative's authored handling advice beside its current dose", () => {
    const source = "Take 1 tablet daily. Wear gloves when handling.";
    const rows: FhirDosage[] = [
      { sequence: 1, text: source, ...dose, timing: { repeat: daily }, maxDosePerAdministration: { value: 1, unit: "tab" } },
      { sequence: 1, text: "Take 5 mL daily.", doseAndRate: [{ doseQuantity: { value: 5, unit: "mL" } }], timing: { repeat: daily } }
    ];
    rows.forEach((row, index) => setDosageAlternativeChoice(row, {
      groupId: "medication-form", branchId: "form-" + index, selectionBehavior: "exactly-one"
    }));
    const before = JSON.stringify(rows);
    const r6 = toDosageDetails(rows);
    const returned = toFhirR5Dosages(r6);
    expect(returned[0].text).toBe(source);
    expect(returned[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);
    expect(returned[1].doseAndRate?.[0].doseQuantity?.value).toBe(5);
    for (const value of [rows, importCanonicalCourse(rows), r6, returned])
      for (const locale of ["en", "th"]) {
        const text = formatSig(value, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "Choose one:" : "เลือกอย่างใดอย่างหนึ่ง:");
        expect(text).toContain(locale === "en" ? "Use 1 tablet once daily" : "ใช้ครั้งละ 1 เม็ด วันละครั้ง");
        expect(text).toContain(locale === "en" ? "Use 5 mL once daily" : "ใช้ครั้งละ 5 มิลลิลิตร วันละครั้ง");
        expect(text.match(/Wear gloves when handling/gu)).toHaveLength(1);
        const branches = text.split(locale === "en" ? " or " : " หรือ ");
        expect(branches).toHaveLength(2);
        expect(branches[0]).toContain(locale === "en" ? "Use 1 tablet once daily" : "ใช้ครั้งละ 1 เม็ด วันละครั้ง");
        expect(branches[0]).toContain("Wear gloves when handling");
        expect(branches[1]).toContain(locale === "en" ? "Use 5 mL once daily" : "ใช้ครั้งละ 5 มิลลิลิตร วันละครั้ง");
        expect(branches[1]).not.toContain("Wear gloves when handling");
      }
    expect(formatSig(rows[0], "long", { realizationMode: "normalized" })).toContain("Wear gloves when handling");
    const parsed = parseSig("Take 1 tablet daily");
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toBe(parsed.longText);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each(["en", "th"])("keeps a dose's clock window and guard before independent advice in %s", locale => {
    const condition: MedicationCondition = { kind: "measurement", name: "sbp", operation: "gt", value: 160, text: "SBP > 160" };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dose,
      timing: { repeat: { ...daily, extension: [{ url: TIMING_CLOCK_WINDOW_EXTENSION_URL, extension: [
        { url: "start", valueTime: "08:00:00" }, { url: "end", valueTime: "12:00:00" }, { url: "endInclusive", valueBoolean: true }
      ] }] } }, condition: [conditionToR6(condition)], additionalInstruction: [{ text: "Otherwise hold" }]
    }] }] };
    const before = JSON.stringify(input);
    const { returned, values } = views(input);
    const expected = locale === "en"
      ? "Use 1 tablet once daily only between 08:00 and 12:00 each day only if SBP > 160. Otherwise hold."
      : "ใช้ครั้งละ 1 เม็ด วันละครั้ง เฉพาะช่วงเวลา 08:00–12:00 ทุกวัน เฉพาะเมื่อ SBP > 160. Otherwise hold.";
    for (const value of values) {
      expect(formatSig(value, "long", { locale, realizationMode: "normalized" })).toBe(expected);
      let calls = 0;
      expect(formatSig(value, "long", { locale, realizationMode: "normalized", i18n: {
        inherit: locale, formatLong: context => {
          calls++;
          expect(context.clause.schedule?.clockWindow).toMatchObject({ start: "08:00:00", end: "12:00:00" });
          expect(context.clause.clinicalAdjuncts?.condition).toMatchObject(condition);
          expect(context.defaultText).toBe(expected);
          expect(context.formatDefault("long")).toBe(expected);
          expect(context.formatDefault("short")).toContain("160");
          return "Clinic wording exactly.";
        }
      } })).toBe("Clinic wording exactly.");
      expect(calls).toBe(1);
    }
    expect(returned.step?.[0].component?.[0].timing).toEqual(input.step?.[0].component?.[0].timing);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([1, 2])("retains a %s-month interval beside two calendar days", period => {
    const repeat = { period, periodUnit: FhirPeriodUnit.Month,
      extension: [1, 15].map(valuePositiveInt => ({ url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt })) };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dose, timing: { repeat } }] }] };
    const before = JSON.stringify(input);
    const { returned, values } = views(input);
    expect(returned.step?.[0].component?.[0].timing?.repeat).toEqual(repeat);
    for (const value of values)
      for (const locale of ["en", "th"])
        for (const style of ["short", "long"] as const) {
          const text = formatSig(value, style, { locale, realizationMode: "normalized" });
          expect(text).toContain(locale === "en" ? "on days 1 and 15" : "วันที่ 1 และ 15");
          if (period === 1) expect(text).toContain(locale === "en" ? "of each month" : "ของทุกเดือน");
          else {
            expect(text).toContain(locale === "en" ? style === "short" ? "Q2MO" : "every 2 months" : "ทุก 2 เดือน");
            expect(text).not.toContain(locale === "en" ? "of each month" : "ของทุกเดือน");
          }
        }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["upper approximate", "upper exact", "scalar approximate"])(
    "retains the bound and approximation independently for %s duration", variant => {
      const sourceQuantity = { value: 2, unit: "wk", code: "wk", system: "http://unitsofmeasure.org",
        ...(variant.endsWith("approximate") ? { comparator: "~" as const } : {}) };
      const quantity = variant === "scalar approximate" ? sourceQuantity : simpleQuantityForR5(sourceQuantity);
      const repeat = { ...daily, ...(variant.startsWith("upper") ? { boundsRange: { high: quantity } } : { boundsDuration: quantity }) };
      const input: FhirR6DosageInstruction = { step: [{ component: [{ ...dose, timing: { repeat } }] }] };
      const before = JSON.stringify(input);
      const { returned, values } = views(input);
      expect(returned.step?.[0].component?.[0].timing?.repeat).toEqual(repeat);
      for (const value of values)
        for (const locale of ["en", "th"]) {
          const short = formatSig(value, "short", { locale, realizationMode: "normalized" });
          const long = formatSig(value, "long", { locale, realizationMode: "normalized" });
          expect(short).toContain(variant === "upper approximate" ? "x<=~2wk" : variant === "upper exact" ? "x<=2wk" : "x~2wk");
          if (variant.startsWith("upper")) expect(long).toContain(locale === "en" ? "up to" : "ไม่เกิน");
          else expect(long).not.toContain(locale === "en" ? "up to" : "ไม่เกิน");
          if (variant.endsWith("approximate")) expect(long).toContain("~2");
          expect(long).toContain(locale === "en" ? "weeks" : "สัปดาห์");
        }
      expect(JSON.stringify(input)).toBe(before);
    }
  );
});

describe("compatible anatomical refinements", () => {
  const SNOMED = "http://snomed.info/sct";
  it.each([
    ["117590005", "left ear canal", "ช่องหูซ้าย"],
    ["89644007", "left ear canal", "ช่องหูซ้าย"],
    ["117590005:272741003=7771000", "left ear canal", "ช่องหูซ้าย"],
    ["117590005:272741003=24028007", "right ear", "หูขวา"],
    ["25577004", "right ear", "หูขวา"]
  ])("preserves a current refined label beside code %s", (code, english, thai) => {
    const site = { concept: { text: "left ear canal", coding: [{ system: SNOMED, code }] } };
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      site, doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      extension: [{ url: "https://example.org/fhir/StructureDefinition/site-note", valueString: "retain" }]
    }] }] };
    const before = JSON.stringify(input);
    const r5 = toFhirR5Dosages(input);
    const returned = toDosageDetails(r5);
    expect(returned.step?.[0].component?.[0].site).toEqual(site);
    expect(returned.step?.[0].component?.[0].extension).toEqual(input.step?.[0].component?.[0].extension);
    for (const value of [input, importCanonicalCourse(input), r5, returned])
      for (const style of ["short", "long"] as const) {
        expect(formatSig(value, style, { locale: "en", realizationMode: "normalized" })).toContain(english);
        expect(formatSig(value, style, { locale: "th", realizationMode: "normalized" })).toContain(thai);
      }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("retains paired canal detail beside a broader paired-ear concept", () => {
    const source = "Instill 2 drops into both ear canals twice daily.";
    const site = { id: "ear-target", text: "both ear canals",
      coding: [{ system: SNOMED, code: "34338003" }],
      extension: [{ url: "https://example.org/fhir/StructureDefinition/site-note", valueBoolean: false }]
    };
    const input: FhirR6DosageInstruction = { renderedInstruction: source, step: [{ component: [{
      text: source, site: { concept: site }, doseAndRate: [{ doseQuantity: { value: 2, unit: "drop" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "d", timeOfDay: ["08:00:00", "20:00:00"] } }
    }] }] };
    const before = JSON.stringify(input), rows = toFhirR5Dosages(input);
    const returned = toDosageDetails(JSON.parse(JSON.stringify(rows)));
    expect(rows[0].site).toEqual(site);
    expect(returned.step?.[0].component?.[0].site).toEqual({ concept: site });
    expect(returned.renderedInstruction).toBe(source);
    for (const value of [input, importCanonicalCourse(input), rows, returned]) {
      const saved = JSON.stringify(value), course = importCanonicalCourse(value);
      const members = course.stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(1);
      expect(members[0].target).toEqual(site);
      expect(members[0].targetCount).toBe(2);
      expect(members[0].text).toBe(source);
      expect(members[0].amounts?.[0].quantity).toMatchObject({ value: 2, unit: "drop" });
      expect(calculateTotalUnits({ dosage: value, orderedAt: "2026-12-01T00:00:00Z",
        from: "2026-12-01T00:00:00Z", timeZone: "UTC", durationValue: 1, durationUnit: "d"
      })).toMatchObject({ totalUnits: 8, unit: "drop" });
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const text = formatSig(value, style, { locale, realizationMode: "normalized" });
        const current = text.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
        expect(current).toContain(locale === "en" ? "both ear canals" : "ช่องหูทั้งสองข้าง");
        expect(current).toMatch(locale === "en" ? /\b2 drops?\b/u : /2 หยด/u);
        expect(text).toContain(source);
      }
      expect(JSON.stringify(value)).toBe(saved);
    }
    expect(JSON.stringify(input)).toBe(before);
  });
});


describe("current FHIR primitive and phase annotations", () => {
  const ucum = "http://unitsofmeasure.org";
  const note = { url: "urn:clinic:authored-note", valueString: "Keep this annotation at its current owner." };
  const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } };

  it("accepts and retains the primitive annotation on a current condition operation", () => {
    const condition = { code: { text: "blood glucose" }, operation: "gt" as const,
      _operation: { id: "comparison", extension: [note] },
      valueQuantity: { value: 180, unit: "mg/dL", system: ucum, code: "mg/dL" } };
    const input: FhirR6DosageInstruction = { renderedInstruction: "Take 1 tablet if blood glucose is above 180 mg/dL.",
      step: [{ component: [{ ...dose, condition: [condition] }] }] };
    const before = structuredClone(input);
    const returned = courseToR6(importCanonicalCourse(toFhirR5Dosages(input)));
    expect(returned.step[0].component[0].condition).toContainEqual(condition);
    expect(returned.renderedInstruction).toBe(input.renderedInstruction);
    expect(returned.step[0].component[0].doseAndRate).toEqual(dose.doseAndRate);
    expect(input).toEqual(before);
  });

  it("projects Quantity annotations inside a clinic reference range to strict R5", () => {
    const tolerance = { url: "urn:clinic:tolerance", valueQuantity: {
      value: 0.1, comparator: "~" as const, unit: "mg", system: ucum, code: "mg", extension: [note]
    } };
    const range = { id: "reference-range", extension: [note],
      low: { value: 1, unit: "mg", system: ucum, code: "mg", extension: [tolerance] },
      high: { value: 2, unit: "mg", system: ucum, code: "mg", id: "upper-reference" } };
    const input: FhirR6DosageInstruction = { renderedInstruction: "Take 1 tablet twice daily.", step: [{ component: [{
      ...dose, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", extension: [
        { url: "urn:clinic:reference-range", valueRange: range }
      ] } }]
    }] }] };
    const before = structuredClone(input), rows = toFhirR5Dosages(input);
    const emitted = rows[0].doseAndRate![0].doseQuantity!.extension![0].valueRange!;
    const quantity = emitted.low!.extension![0].valueQuantity!;
    expect(emitted.id).toBe(range.id);
    expect(emitted.extension).toEqual([note]);
    expect(emitted.high).toEqual(range.high);
    expect(emitted.low!.comparator).toBeUndefined();
    expect(quantity.comparator).toBeUndefined();
    expect(getEmaQuantityComparator(quantity)).toBe("~");
    expect(quantity.extension).toContainEqual(note);
    const returned = courseToR6(importCanonicalCourse(rows));
    const restored = returned.step[0].component[0].doseAndRate![0].doseQuantity!.extension![0].valueRange!;
    expect(restored).toMatchObject({ id: range.id, extension: [note], high: range.high,
      low: { value: 1, unit: "mg", system: ucum, code: "mg" } });
    const restoredTolerance = restored.low!.extension![0].valueQuantity!;
    expect(restoredTolerance).toMatchObject({ value: 0.1, unit: "mg", system: ucum, code: "mg" });
    expect(getQuantityComparator(restoredTolerance)).toBe("~");
    expect(restoredTolerance.extension).toContainEqual(note);
    expect(input).toEqual(before);
  });

  it.each(["doseRange", "rateRange", "boundsRange"] as const)(
    "projects current Quantity annotations on a core %s without changing its endpoints", field => {
      const unit = field === "doseRange" ? "mg" : field === "rateRange" ? "mL/h" : "d";
      const tolerance = { url: "urn:clinic:tolerance", valueQuantity: {
        id: "active-tolerance", value: 0.1, comparator: "~" as const, unit, system: ucum, code: unit,
        extension: [note]
      } };
      const range = { id: "current-range", extension: [note, tolerance],
        low: { value: 1, unit, system: ucum, code: unit },
        high: { value: 2, unit, system: ucum, code: unit } };
      const repeat = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
      const component: FhirR6Dosage = field === "boundsRange"
        ? { doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }],
            timing: { repeat: { ...repeat, boundsRange: range } } }
        : { doseAndRate: [{ [field]: range }], timing: { repeat } };
      const source = field === "doseRange" ? "Take 1 to 2 mg daily."
        : field === "rateRange" ? "Infuse at 1 to 2 mL/h daily."
        : "Take 1 tablet daily for 1 to 2 days.";
      const input: FhirR6DosageInstruction = { renderedInstruction: source, step: [{ component: [component] }] };
      const before = structuredClone(input), rows = toFhirR5Dosages(input);
      const readRange = (value: FhirDosage | FhirR6Dosage) => field === "boundsRange"
        ? value.timing?.repeat?.boundsRange : value.doseAndRate?.[0]?.[field];
      const projected = readRange(rows[0])!;
      expect(projected.low).toEqual(range.low);
      expect(projected.high).toEqual(range.high);
      expect(projected.id).toBe(range.id);
      expect(projected.extension).toContainEqual(note);
      const quantity = projected.extension!.find(item => item.url === tolerance.url)!.valueQuantity!;
      expect(quantity).toMatchObject({ id: "active-tolerance", value: 0.1, unit, system: ucum, code: unit });
      expect(quantity.comparator).toBeUndefined();
      expect(getEmaQuantityComparator(quantity)).toBe("~");
      expect(quantity.extension).toContainEqual(note);
      const returned = toDosageDetails(rows);
      const restored = readRange(returned.step[0].component[0])!;
      expect(restored.low).toEqual(range.low);
      expect(restored.high).toEqual(range.high);
      expect(restored.id).toBe(range.id);
      expect(restored.extension).toContainEqual(note);
      const restoredTolerance = restored.extension!.find(item => item.url === tolerance.url)!.valueQuantity!;
      expect(restoredTolerance).toMatchObject({ id: "active-tolerance", value: 0.1, unit, system: ucum, code: unit });
      expect(getQuantityComparator(restoredTolerance)).toBe("~");
      expect(restoredTolerance.extension).toContainEqual(note);
      expect(returned.renderedInstruction).toBe(source);
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const)
        expect(formatSig(rows, style, { locale, realizationMode: "normalized" }))
          .toBe(formatSig(input, style, { locale, realizationMode: "normalized" }));
      expect(input).toEqual(before);
    }
  );

  it.each([false, true])("keeps a phase total active with a core period mirror: %s", mirrored => {
    const total = { id: "phase-total", scope: "dosage" as const,
      valueQuantity: { value: 3, unit: "tab", extension: [note] } };
    const period = { id: "daily-limit", scope: "period" as const,
      valueQuantity: { value: 2, unit: "tab" }, period: { value: 1, unit: "d", code: "d", system: ucum } };
    const limits = mirrored ? [total, period] : [total];
    const marker = encodeR6SourceMetadata(R6_SCOPED_SAFETY_MODIFIER_URL, { step: { doseLimit: limits } }, "safety");
    const input: FhirR6DosageInstruction = { renderedInstruction: "Take 1 tablet twice daily, with a phase total of 3 tablets.",
      safety: { modifierExtension: [marker], ...(mirrored ? { doseLimit: [period] } : {}) },
      step: [{ component: [dose] }] };
    const before = structuredClone(input), returned = courseToR6(importCanonicalCourse(toFhirR5Dosages(input)));
    const active = returned.safety!.modifierExtension!.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL)!;
    const scoped = decodeR6SourceMetadata(active, "safety") as { step: { doseLimit: unknown[] } };
    expect(scoped.step.doseLimit).toEqual(limits);
    expect(returned.safety!.doseLimit ?? []).toEqual(mirrored ? [period] : []);
    expect(returned.renderedInstruction).toBe(input.renderedInstruction);
    const options = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z", timeZone: "UTC",
      durationValue: 3, durationUnit: FhirPeriodUnit.Day };
    // Phase safety is retained and explicitly qualified by the existing supply API.
    for (const current of [input, returned]) expect(calculateTotalUnits({ dosage: current, ...options }))
      .toMatchObject({ totalUnits: 6, unit: "tab", quantityKind: "maximum",
        explanation: expect.stringContaining("retained but not evaluated") });
    expect(input).toEqual(before);
  });

  it("preserves the full supplied spatial target and its translated text", () => {
    const target = { id: "left-eye-target", text: "left eye", extension: [note],
      coding: [
        { system: "http://snomed.info/sct", code: "1290031003", display: "Left eye",
          _display: { id: "left-eye-display", extension: [note] } },
        { system: "urn:clinic:body-site", code: "eye-left", display: "Left eye at this clinic" }
      ], _text: { id: "target-text", extension: [{
        url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
          { url: "lang", valueCode: "th" }, { url: "content", valueString: "ตาซ้าย" }
        ]
      }] } };
    const supplied = { text: "around the left eye", extension: [{
      url: "urn:ezmedicationinput:body-site-spatial-relation", extension: [
        { url: "relationText", valueString: "around" }, { url: "target", valueCodeableConcept: target }
      ]
    }] };
    const before = structuredClone(supplied), relation = parseBodySiteSpatialRelationExtension(supplied)!;
    expect(relation.targetCoding).toMatchObject({ system: "http://snomed.info/sct", code: "1290031003" });
    expect(relation.targetText).toBe("left eye");
    const rebuilt = buildBodySiteSpatialRelationExtension(relation)!;
    expect(rebuilt.extension!.find(item => item.url === "target")!.valueCodeableConcept).toEqual(target);
    const cloned = cloneBodySiteSpatialRelation(relation)!;
    expect(cloned.targetConcept).toEqual(target);
    expect(cloned.targetConcept).not.toBe(relation.targetConcept);
    expect(cloned.targetConcept!.coding![0]).not.toBe(target.coding[0]);
    expect(cloned.targetConcept!.coding![0]._display).not.toBe(target.coding[0]._display);
    expect(cloned.targetConcept!._text).not.toBe(target._text);
    expect(buildBodySiteSpatialRelationExtension(cloned)).toEqual(rebuilt);
    expect(supplied).toEqual(before);
  });

  it.each([undefined, "supplied left eye"])("preserves the spatial target fallback without replacing supplied text: %s", text => {
    const target = { id: "authored-target", ...(text === undefined ? {} : { text }), coding: [
      { system: "http://snomed.info/sct", code: "1290031003" },
      { system: "urn:clinic:body-site", code: "eye-left" }
    ] };
    const supplied = { extension: [{ url: "urn:ezmedicationinput:body-site-spatial-relation", extension: [
      { url: "relationText", valueString: "around" }, { url: "target", valueCodeableConcept: target },
      { url: "targetText", valueString: "authored fallback left eye" }
    ] }] };
    const relation = parseBodySiteSpatialRelationExtension(supplied)!;
    expect(relation.targetText).toBe(text ?? "authored fallback left eye");
    const rebuilt = buildBodySiteSpatialRelationExtension(relation)!;
    expect(rebuilt.extension!.find(item => item.url === "target")!.valueCodeableConcept).toEqual(target);
    expect(parseBodySiteSpatialRelationExtension({ extension: [rebuilt] })!.targetText)
      .toBe(text ?? "authored fallback left eye");
  });

  it("keeps an unknown normalized argument value at its original active field", () => {
    const normalized = { url: "normalized", _valueString: { id: "unknown-normalization", extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    }] } };
    const supplied: FhirExtension = { url: "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
      extension: [{ url: "sourceText", valueString: "Drink water" }, { url: "action", extension: [
        { url: "predicateLemma", valueString: "drink" }, { url: "force", valueCode: "instruction" },
        { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 11 },
        { url: "sourceText", valueString: "Drink water" }, { url: "argument", extension: [
          { url: "role", valueCode: "object" }, { url: "text", valueString: "water" }, normalized
        ] }
      ] }] };
    const before = structuredClone(supplied), graph = parseInstructionGraphExtension([supplied])!;
    expect(graph.actions[0].args[0].text).toBe("water");
    expect(graph.actions[0].args[0].normalized).toBeUndefined();
    const returned = buildInstructionGraphExtension(graph)!;
    const argument = returned.extension!.find(item => item.url === "action")!.extension!.find(item => item.url === "argument")!;
    expect(argument.extension).toContainEqual(normalized);
    expect(argument.extension!.find(item => item.url === "normalized")!.valueString).toBeUndefined();
    expect(argument.extension!.some(item => item.url === "urn:ezmedicationinput:StructureDefinition:medication-course-reconciliation-source")).toBe(false);
    expect(supplied).toEqual(before);
  });
});


describe("current FHIR condition and annotation meaning", () => {
  it.each([["eq", false], ["ne", true]] as const)(
    "uses authored concept text as the Boolean subject (%s)", (operation, expected) => {
    const condition = { code: { text: "nausea", coding: [{
      system: "http://hl7.org/fhir/CodeSystem/dosage-condition-code", code: "problem-presents", display: "Problem Presents"
    }] }, operation, valueBoolean: false, _operation: { id: "condition-operation" },
      extension: [{ url: "urn:test:condition-note", valueString: "retain this condition" }] };
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], condition: [condition]
    }] }] };
    const before = cloneStructuredValue(source);
    const rows = toFhirR5Dosages(source);
    for (const input of [source, rows]) {
      expect(importCanonicalCourse(input).stages[0].administrations[0].predicate)
        .toMatchObject({ kind: "state", name: "nausea", expected });
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain(expected ? "only if nausea" : "only if not nausea");
      expect(courseToR6(importCanonicalCourse(input)).step![0].component[0].condition).toEqual([condition]);
    }
    expect(source).toEqual(before);
  });

  it("retains uninterpreted relation nodes beside a recognized graph edge", () => {
    const afterEnd: FhirExtension = { url: "graphRelation", id: "after-removal-ends", extension: [
      { url: "kindCoding", valueCoding: { system: "http://hl7.org/fhir/action-relationship-type", code: "after-end",
        extension: [{ url: "urn:test:relation-code-note", valueString: "retain" }] } },
      { url: "fromActionIndex", valueInteger: 1, _valueInteger: { id: "from-action" } },
      { url: "toActionIndex", valueInteger: 0 },
      { url: "urn:test:relation-note", valueString: "await completed removal" }
    ] };
    const local: FhirExtension = { url: "graphRelation", id: "local-relation", extension: [
      { url: "kindCoding", valueCoding: { system: "urn:test:clinic-relation", code: "checked-by" } },
      { url: "fromActionIndex", valueInteger: 0 }, { url: "toActionIndex", valueInteger: 1 }
    ] };
    const source: FhirExtension = { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, extension: [
      { url: "sourceText", valueString: "Remove the old patch, then apply the new patch." },
      { url: "action", extension: [{ url: "predicateLemma", valueString: "remove" },
        { url: "force", valueCode: "instruction" }, { url: "sourceText", valueString: "Remove the old patch" },
        { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 20 }] },
      { url: "action", extension: [{ url: "predicateLemma", valueString: "apply" },
        { url: "force", valueCode: "instruction" }, { url: "sourceText", valueString: "apply the new patch" },
        { url: "spanStart", valueInteger: 27 }, { url: "spanEnd", valueInteger: 46 }] },
      { url: "graphRelation", extension: [
        { url: "kindCoding", valueCoding: { system: "http://hl7.org/fhir/action-relationship-type", code: "before" } },
        { url: "fromActionIndex", valueInteger: 0 }, { url: "toActionIndex", valueInteger: 1 }
      ] }, afterEnd, local
    ] };
    const before = cloneStructuredValue(source), graph = parseInstructionGraphExtension([source])!;
    expect(graph.actions).toHaveLength(2);
    expect(graph.relations).toEqual([expect.objectContaining({ kind: AdviceRelation.Before,
      fromActionIndex: 0, toActionIndex: 1 })]);
    expect(graph.sourceExtensions).toEqual([afterEnd, local]);
    const rebuilt = buildInstructionGraphExtension(graph)!;
    expect(rebuilt.extension!.filter(field => field.url === "graphRelation")).toHaveLength(3);
    expect(rebuilt.extension).toEqual(expect.arrayContaining([afterEnd, local]));
    expect(parseInstructionGraphExtension([rebuilt])!.sourceExtensions).toEqual([afterEnd, local]);
    expect(source).toEqual(before);
  });

  it.each(["extension", "primitive"] as const)(
    "converts current Quantity annotations within a Coding (%s)", location => {
    const priming: FhirR6Extension = { url: "urn:test:priming-volume", valueQuantity: {
      value: 5, unit: "mL", system: "http://unitsofmeasure.org", code: "mL", comparator: "~",
      extension: [{ url: "urn:test:volume-note", valueString: "keep" }]
    } };
    const coding = { system: "urn:test:pump-program", code: "maintenance", display: "Maintenance",
      ...(location === "extension" ? { extension: [priming] } : { _display: { id: "program-display", extension: [priming] } }) };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ rateQuantity: {
      value: 25, unit: "mL/h", code: "mL/h", extension: [{ url: "urn:test:pump-program", valueCoding: coding }]
    } }] }] }] };
    const before = cloneStructuredValue(source), rows = toFhirR5Dosages(source);
    const saved = rows[0].doseAndRate![0].rateQuantity!.extension![0].valueCoding!;
    const annotation = (location === "extension" ? saved.extension : saved._display!.extension)![0];
    expect(annotation.valueQuantity).toMatchObject({ value: 5, unit: "mL", code: "mL" });
    expect(annotation.valueQuantity!.comparator).toBeUndefined();
    expect(getEmaQuantityComparator(annotation.valueQuantity)).toBe("~");
    expect(annotation.valueQuantity!.extension).toContainEqual({ url: "urn:test:volume-note", valueString: "keep" });
    const restored = toDosageDetails(rows).step[0].component[0].doseAndRate![0].rateQuantity!.extension![0].valueCoding!;
    expect(restored.system).toBe(coding.system);
    expect(restored.code).toBe(coding.code);
    expect(restored.display).toBe(coding.display);
    const restoredAnnotation = (location === "extension" ? restored.extension : restored._display!.extension)![0];
    expect(restoredAnnotation.valueQuantity).toEqual(priming.valueQuantity);
    expect(source).toEqual(before);
  });

  it("retains a spatial target supplied only through primitive annotations", () => {
    const target = { id: "translated-target", _text: { id: "target-text", extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "บริเวณผื่น" }
      ]
    }] }, extension: [{ url: "urn:test:target-note", valueString: "retain" }] };
    const source = { extension: [{ url: BODY_SITE_SPATIAL_RELATION_EXTENSION_URL,
      extension: [{ url: "target", valueCodeableConcept: target }] }] };
    const before = cloneStructuredValue(source), relation = parseBodySiteSpatialRelationExtension(source)!;
    expect(relation.targetConcept).toEqual(target);
    expect(relation.targetCoding).toBeUndefined();
    expect(relation.targetText).toBeUndefined();
    const rebuilt = buildBodySiteSpatialRelationExtension(relation)!;
    expect(rebuilt.extension!.find(field => field.url === "target")!.valueCodeableConcept).toEqual(target);
    expect(source).toEqual(before);
  });

  it("accepts and retains RelativeTime primitive companions on fresh R6 input", () => {
    const source: FhirR6DosageInstruction = { step: [{ start: {
      contextDefinition: "https://example.org/protocol/induction", _contextDefinition: { id: "protocol-reference" },
      contextPath: "start", _contextPath: { id: "protocol-path" },
      text: "After the induction starts", _text: { id: "relative-time-label", extension: [{
        url: "urn:test:relative-time-note", valueString: "retain"
      }] }
    }, component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }] };
    const before = cloneStructuredValue(source), native = importCanonicalCourse(source);
    expect(courseToR6(native).step![0].start).toEqual(source.step[0].start);
    expect(toDosageDetails(toFhirR5Dosages(source)).step[0].start).toEqual(source.step[0].start);
    expect(source).toEqual(before);
  });
});

describe("fresh typed annotation ownership", () => {
  it("converts active protocol quantities inside a CodeableConcept", () => {
    const threshold: FhirR6Extension = { url: "urn:test:priming-volume", valueQuantity: {
      value: 5, unit: "mL", code: "mL", comparator: "~",
      extension: [{ url: "urn:test:threshold-note", valueString: "retain threshold" }]
    } };
    const concept = { id: "pump-protocol", text: "Local priming protocol", extension: [threshold],
      _text: { id: "protocol-label" }, coding: [{ system: "urn:test:protocol", code: "priming", extension: [threshold] }] };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ rateQuantity: {
      value: 25, unit: "mL/h", code: "mL/h", extension: [{ url: "urn:test:protocol", valueCodeableConcept: concept }]
    } }] }] }] };
    const before = cloneStructuredValue(source), rows = toFhirR5Dosages(source);
    const saved = rows[0].doseAndRate![0].rateQuantity!.extension![0].valueCodeableConcept!;
    expect(saved).toMatchObject({ id: concept.id, text: concept.text, _text: concept._text,
      coding: [{ system: "urn:test:protocol", code: "priming" }] });
    for (const annotation of [saved.extension![0], saved.coding![0].extension![0]]) {
      expect(annotation.valueQuantity).toMatchObject({ value: 5, unit: "mL", code: "mL" });
      expect(annotation.valueQuantity!.comparator).toBeUndefined();
      expect(getEmaQuantityComparator(annotation.valueQuantity)).toBe("~");
      expect(annotation.valueQuantity!.extension).toContainEqual(threshold.valueQuantity!.extension![0]);
    }
    const restored = toDosageDetails(rows).step[0].component[0].doseAndRate![0].rateQuantity!.extension![0].valueCodeableConcept!;
    expect(restored).toEqual(concept);
    expect(source).toEqual(before);
  });

  it("keeps a translated phase action companion with its phase policy", () => {
    const companion = { id: "phase-response", extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "ติดต่อคลินิก" }
      ]
    }] };
    const source: FhirR6DosageInstruction = {
      safety: { doseLimit: [{ scope: "dosage", valueQuantity: { value: 10, unit: "mg" } }] },
      step: [{ safety: { ifExceeded: "Contact the clinic", _ifExceeded: companion },
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "mg" } }] }] }]
    };
    const before = cloneStructuredValue(source);
    const lifted = toDosageDetails(toFhirR5Dosages(source));
    const owned = retainedSingleStepSafety(lifted)!;
    expect(owned.course?.doseLimit).toEqual(source.safety!.doseLimit);
    expect(owned.course?.ifExceeded).toBeUndefined();
    expect(owned.course?._ifExceeded).toBeUndefined();
    expect(owned.step.ifExceeded).toBe("Contact the clinic");
    expect(owned.step._ifExceeded).toEqual(companion);
    const native = importCanonicalCourse(lifted);
    expect(native.safety?.ifExceeded).toBeUndefined();
    expect(native.stages[0].safety?.ifExceeded).toBe("Contact the clinic");
    expect(source).toEqual(before);
  });

  it("retains an annotation-only spatial relation Coding without inventing a code", () => {
    const coding = { id: "uncoded-relation", _code: { extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    }] } };
    const source = { extension: [{ url: BODY_SITE_SPATIAL_RELATION_EXTENSION_URL, extension: [
      { url: "relation", valueCoding: coding }, { url: "relationText", valueString: "around" },
      { url: "target", valueCodeableConcept: { text: "left eye" } },
      { url: "sourceText", valueString: "around the left eye" }
    ] }] };
    const before = cloneStructuredValue(source), relation = parseBodySiteSpatialRelationExtension(source)!;
    expect(relation.relationCoding).toEqual(coding);
    expect(relation.relationCoding?.code).toBeUndefined();
    expect(relation.targetText).toBe("left eye");
    const rebuilt = buildBodySiteSpatialRelationExtension(relation)!;
    expect(rebuilt.extension!.find(field => field.url === "relation")!.valueCoding).toEqual(coding);
    expect(parseBodySiteSpatialRelationExtension({ extension: [rebuilt] })).toEqual(relation);
    expect(source).toEqual(before);
  });

  it("accepts and retains primitive companions on a fresh dose expression", () => {
    const expression = { description: "Weight-based dose", _description: { id: "dose-description" },
      name: "weightDose", _name: { id: "dose-name" }, language: "text/fhirpath", _language: { id: "dose-language" },
      expression: "%patient.weight * 0.5", _expression: { id: "dose-formula" },
      reference: "https://example.org/protocol/dose", _reference: { id: "dose-reference" } };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseExpression: expression }] }] }] };
    const before = cloneStructuredValue(source);
    expect(courseToR6(importCanonicalCourse(source)).step[0].component[0].doseAndRate![0].doseExpression).toEqual(expression);
    expect(toDosageDetails(toFhirR5Dosages(source)).step[0].component[0].doseAndRate![0].doseExpression).toEqual(expression);
    expect(source).toEqual(before);
  });
});

describe("current display ownership beside independent FHIR metadata", () => {
  it("retains nasal septum specificity beside a broader nose coding", () => {
    const row: FhirDosage = { text: "Apply 1 g to the nasal septum.",
      doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      site: { text: "nasal septum", coding: [{ system: "http://snomed.info/sct", code: "181195007" }] },
      extension: [{ url: "urn:clinic:site-note", valueString: "Retain site detail" }] };
    const before = JSON.stringify(row), native = importCanonicalCourse(row), r6 = toDosageDetails([row]);
    expect(native.stages[0].administrations[0].target).toMatchObject({ text: "nasal septum" });
    for (const value of [row, native, r6]) for (const style of ["short", "long"] as const) {
      expect(formatSig(value, style, { locale: "en", realizationMode: "normalized" })).toContain("nasal septum");
      expect(formatSig(value, style, { locale: "th", realizationMode: "normalized" })).toContain("ผนังกั้นจมูก");
    }
    const returned = toFhirR5Dosages(r6)[0];
    expect(returned.site).toEqual(row.site);
    expect(returned.doseAndRate).toEqual(row.doseAndRate);
    expect(returned.text).toBe(row.text);
    expect(returned.extension).toContainEqual(row.extension![0]);
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([false, true])("retains an advice display on equivalent Codings (first display=%s)", firstDisplay => {
    const coding = [{ system: "urn:clinic:advice", code: "do-not-crush", ...(firstDisplay ? { display: "Do not crush" } : {}) },
      { system: "urn:clinic:alternate-advice", code: "no-crush", display: "Do not crush" }];
    const component: FhirR6Dosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      additionalInstruction: [{ coding }], extension: [{ url: "urn:clinic:advice-note", valueString: "Keep both Codings" }] };
    const input: FhirR6DosageInstruction = { step: [{ component: [component] }] };
    const before = JSON.stringify(input), native = importCanonicalCourse(input), rows = toFhirR5Dosages(input);
    expect(native.stages[0].administrations[0].additionalInstructions?.[0].coding).toEqual(coding);
    for (const value of [input, native, rows]) {
      const text = formatSig(value, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain("1 tablet");
      expect(text.match(/Do not crush/gu)).toHaveLength(1);
    }
    expect(rows[0].additionalInstruction?.[0].coding).toEqual(coding);
    expect(toDosageDetails(rows).step[0].component[0].additionalInstruction).toEqual(component.additionalInstruction);
    expect(toDosageDetails(rows).step[0].component[0].extension).toEqual(component.extension);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["advice", "graph"] as const)("keeps a standalone clock window beside independent %s", channel => {
    const warning = parseInstructionActions("Do not crush")[0];
    const repeat = { extension: [{ url: TIMING_CLOCK_WINDOW_EXTENSION_URL, extension: [
      { url: "start", valueTime: "08:00:00" }, { url: "end", valueTime: "20:00:00" },
      { url: "endInclusive", valueBoolean: true }
    ] }] };
    const advice = channel === "advice" ? { additionalInstruction: [{ text: "Do not crush" }] }
      : { extension: [buildInstructionGraphExtension({ sourceText: "Do not crush", sourceLocale: "en", actions: [warning] })!] };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ timing: { repeat }, ...advice }] }] };
    const before = JSON.stringify(input), native = importCanonicalCourse(input), rows = toFhirR5Dosages(input);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.clockWindow)
      .toMatchObject({ start: "08:00:00", end: "20:00:00" });
    expect(native.stages[0].administrations[0].amounts).toBeUndefined();
    for (const value of [input, native, rows]) for (const locale of ["en", "th"]) {
      const text = formatSig(value, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain("08:00"); expect(text).toContain("20:00");
      expect(text).toContain(locale === "en" ? "only between" : "เฉพาะช่วงเวลา");
      expect(text.match(locale === "en" ? /Do not crush/gu : /ห้ามบด/gu)).toHaveLength(1);
      const adviceOnly: FhirR6DosageInstruction = { step: [{ component: [advice] }] };
      expect(formatSig(adviceOnly, "long", { locale, realizationMode: "normalized" }))
        .toBe(locale === "en" ? "Do not crush." : "ห้ามบด.");
    }
    expect(toDosageDetails(rows).step[0].component[0].timing?.repeat).toEqual(repeat);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([undefined, 3])("shows the once-only cycle interval independently of a %s-day authored bound", boundDays => {
    const interval = { value: 28, unit: "d", code: "d", system: "http://unitsofmeasure.org" };
    const boundsDuration = boundDays === undefined ? undefined : { value: boundDays, unit: "d", code: "d" };
    const input: FhirR6DosageInstruction = { repeatCycle: interval,
      modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 1 }], step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, ...(boundsDuration ? { boundsDuration } : {}) } }
      }] }] };
    const before = JSON.stringify(input), native = importCanonicalCourse(input), rows = toFhirR5Dosages(input);
    expect(native.cycleCount).toBe(1); expect(native.cycleInterval).toMatchObject(interval);
    for (const value of [input, native, rows]) {
      const en = formatSig(value, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(value, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("1 tablet once daily");
      expect(en).toContain("1 cycle total (cycle interval: 28 days)");
      expect(en).not.toContain("Repeat this schedule");
      expect(th).toContain("รวม 1 รอบ"); expect(th).toContain("ระยะรอบการใช้ยา: 28 วัน");
      if (boundDays) { expect(en).toContain("for 3 days"); expect(th).toContain("3 วัน"); }
    }
    const returned = toDosageDetails(rows);
    expect(returned.repeatCycle).toEqual(interval);
    expect(returned.step[0].component[0].timing?.repeat?.boundsDuration).toEqual(boundsDuration);
    expect(JSON.stringify(input)).toBe(before);
  });
});


describe("current medication calendar exclusions precede independent advice", () => {
  it.each(["weekday", "date", "sparse graph", "source only"] as const)("keeps the %s restriction on the current dose across native and FHIR previews", kind => {
    const authoredDose = kind === "source only" ? "Swallow 1 tablet whole." : undefined;
    const warning = kind !== "date" ? "On Mondays, do not take the morning dose."
      : "On 2026-11-30, do not take the morning dose.";
    const calendar: FhirExtension = kind !== "date"
      ? { url: DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, extension: [{ url: "day", valueCode: "mon" }] }
      : { url: DOSAGE_EXCLUDED_DATES_R5_URL, extension: [{ url: "date", valueDate: "2026-11-30" }] };
    const prefix = kind === "sparse graph" ? "Take 1 tablet. " : "";
    const graph: CanonicalInstructionGraph = {
      sourceText: prefix + warning, sourceLocale: "en", primaryOwnership: {},
      actions: [{ force: AdviceForce.Warning, polarity: AdvicePolarity.Negate,
        predicate: { lemma: "take", display: "Take", semanticClass: "administration" },
        args: [
          { role: AdviceArgumentRole.Object, text: "the morning dose", normalized: "the morning dose", i18n: { th: "ยาเช้า" } },
          { role: AdviceArgumentRole.Time, relation: AdviceRelation.On,
            text: kind === "date" ? "2026-11-30" : "Mondays",
            i18n: { th: kind === "date" ? "2026-11-30" : "วันจันทร์" } }
        ], span: { start: prefix.length, end: prefix.length + warning.length - 1 },
        sourceText: warning.slice(0, -1)
      }]
    };
    if (kind === "sparse graph") {
      graph.actions.unshift({ force: AdviceForce.Instruction, polarity: AdvicePolarity.Affirm,
        predicate: { lemma: "take", display: "Take", semanticClass: "administration" },
        args: [{ role: AdviceArgumentRole.Amount, text: "1 tablet", quantity: { value: 1, unit: "tab" } }],
        span: { start: 0, end: 13 }, sourceText: "Take 1 tablet"
      });
      graph.primaryAdministrationSpan = { start: 0, end: 13 };
      graph.primaryOwnership = { administrationActionIndex: 0, dose: { actionIndex: 0, argumentIndex: 0 } };
    }
    const graphExtension = buildInstructionGraphExtension(graph)!;
    const unknown: FhirExtension = { url: "https://example.org/review-note", valueString: "Retain supplied note" };
    const row: FhirDosage = {
      ...(authoredDose ? { text: authoredDose } : { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }),
      ...(kind !== "sparse graph" && !authoredDose ? { timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } } } : {}),
      additionalInstruction: [{ text: warning }],
      extension: kind !== "date" ? [calendar, unknown, graphExtension] : [unknown, graphExtension],
      ...(kind === "date" ? { modifierExtension: [calendar] } : {})
    };
    const condition: MedicationCondition = { kind: "measurement", name: "sbp", operation: "gt", value: 160, text: "SBP > 160" };
    if (kind === "date") setDosageCondition(row, condition);
    const member: FhirR6Dosage = {
      ...(authoredDose ? { text: authoredDose } : { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }),
      ...(kind !== "sparse graph" && !authoredDose ? { timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } } } : {}),
      additionalInstruction: [{ text: warning }],
      extension: kind !== "date" ? [calendar, unknown, graphExtension] : [unknown, graphExtension],
      ...(kind === "date" ? { modifierExtension: [calendar] } : {}),
      ...(kind === "date" ? { condition: [conditionToR6(condition)] } : {})
    };
    const r6: FhirR6DosageInstruction = { step: [{ component: [member] }] };
    const before = JSON.stringify([row, r6]);
    const native = importCanonicalCourse(r6);
    const administration = native.stages[0].administrations[0];
    if (authoredDose) expect(administration.amounts?.[0]?.quantity).toBeUndefined();
    else expect(administration.amounts?.[0]?.quantity).toMatchObject({ value: 1, unit: "tab" });
    expect(administration.schedule?.recurrence?.clocks).toEqual(kind === "sparse graph" || authoredDose ? undefined : ["08:00:00"]);
    expect(kind !== "date" ? administration.excludedWeekdays : administration.excludedDates)
      .toEqual([kind !== "date" ? "mon" : "2026-11-30"]);
    for (const locale of ["en", "th"] as const) {
      const qualifier = kind !== "date"
        ? locale === "en" ? "except Monday" : "ยกเว้นวันจันทร์"
        : locale === "en" ? "except 2026-11-30" : "ยกเว้นวันที่ 2026-11-30";
      const renderers = [
        (options: FormatOptions) => formatCanonicalCourse(native, "long", options),
        (options: FormatOptions) => formatSig(row, "long", options),
        (options: FormatOptions) => formatSig(r6, "long", options)
      ];
      for (const render of renderers) {
        const options: FormatOptions = { locale, realizationMode: "normalized" };
        const text = render(options);
        expect(text).toContain(qualifier);
        const warningStart = locale === "en" ? warning : "ห้าม";
        expect(text).toContain(warningStart);
        if (locale === "th") expect(text.slice(text.indexOf(warningStart))).toContain(kind === "date" ? "2026-11-30" : "วันจันทร์");
        expect(text.indexOf(qualifier)).toBeLessThan(text.indexOf(warningStart));
        expect(text.slice(text.indexOf(warningStart))).not.toContain(qualifier);
        expect(text).toContain(authoredDose ? "Swallow 1 tablet whole" : locale === "en" ? "1 tablet" : "1 เม็ด");
        if (kind === "date") {
          const guardStart = text.indexOf("SBP > 160");
          expect(guardStart).toBeGreaterThanOrEqual(0);
          expect(guardStart).toBeLessThan(text.indexOf(warningStart));
        }
        if (kind === "sparse graph") {
          const roundtrip = render({ ...options, realizationMode: "roundtrip" });
          expect(roundtrip).toContain(qualifier);
          expect(roundtrip).toContain(warningStart);
          expect(roundtrip.indexOf(qualifier)).toBeLessThan(roundtrip.indexOf(warningStart));
        }
        let calls = 0;
        expect(render({ ...options, i18n: { locale, formatLong(context) {
          calls++;
          expect(context.defaultText).toBe(text);
          expect(context.formatDefault("long")).toBe(text);
          expect(context.clause.clinicalAdjuncts?.excludedWeekdays ?? context.clause.clinicalAdjuncts?.excludedDates)
            .toEqual([kind !== "date" ? "mon" : "2026-11-30"]);
          return "Clinic wording remains exact.";
        } } })).toBe("Clinic wording remains exact.");
        expect(calls).toBe(1);
      }
    }
    for (const output of [toDosageDetails([row]), fromFhir(r6).fhirNext]) {
      const preserved = output.step[0].component[0];
      if (authoredDose) {
        expect(preserved.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
        expect(preserved.text).toBe(authoredDose);
      } else expect(preserved.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(preserved.extension).toEqual(expect.arrayContaining([unknown]));
      expect(kind !== "date" ? preserved.extension : preserved.modifierExtension)
        .toEqual(expect.arrayContaining([calendar]));
      expect(preserved.additionalInstruction).toEqual([{ text: warning }]);
      expect(parseInstructionGraphExtension(preserved.extension)?.sourceText).toBe(prefix + warning);
    }
    expect(JSON.stringify([row, r6])).toBe(before);
  });
});

it("retains a calendar restriction beside a method-only current prescription", () => {
  const row: FhirDosage = { method: { text: "Use shampoo" },
    extension: [{ url: DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, extension: [{ url: "day", valueCode: "mon" }] }] };
  const r6: FhirR6DosageInstruction = { step: [{ component: [{ method: { text: "Use shampoo" },
    extension: [{ url: DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, extension: [{ url: "day", valueCode: "mon" }] }] }] }] };
  const before = JSON.stringify([row, r6]);
  const native = importCanonicalCourse(r6);
  const administration = native.stages[0].administrations[0];
  expect(administration.amounts).toBeUndefined();
  expect(administration.schedule).toBeUndefined();
  expect(administration.excludedWeekdays).toEqual(["mon"]);
  for (const locale of ["en", "th"] as const) {
    const options: FormatOptions = { locale, realizationMode: "normalized" };
    const qualifier = locale === "en" ? "except Monday" : "ยกเว้นวันจันทร์";
    for (const text of [formatCanonicalCourse(native, "long", options),
      formatSig(row, "long", options), formatSig(r6, "long", options)]) {
      expect(text).toContain(qualifier);
      if (locale === "en") expect(text).toContain("Use shampoo");
    }
  }
  expect(JSON.stringify([row, r6])).toBe(before);
});

describe("complete relation-led advice ownership", () => {
  it.each([
    "On Mondays, do not take the morning dose.",
    "Before dressing, do not apply the medication."
  ])("retains the complete authored warning without inventing an implicit administration: %s", warning => {
    const parsed = parseAdditionalInstructions(warning, { start: 0, end: warning.length },
      { defaultPredicate: "take", allowFreeTextFallback: true });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].frames).toEqual([]);
    expect(parsed[0].text).toBe(warning.slice(0, -1));
    const unknown = { url: "urn:clinic:advice-review", valueString: "Preserve authored warning" };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      additionalInstruction: [{ text: warning }], extension: [unknown] };
    const r6: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      additionalInstruction: [{ text: warning }], extension: [unknown]
    }] }] };
    const before = JSON.stringify([row, r6]), native = importCanonicalCourse(r6);
    expect(native.stages[0].administrations[0].additionalInstructions?.[0].text).toBe(warning);
    for (const value of [row, r6, native]) for (const locale of ["en", "th"] as const) {
      const output = formatSig(value, "long", { locale, realizationMode: "normalized" });
      expect(output).toContain(warning.slice(0, -1));
      expect(output.match(/do not/gu)).toHaveLength(1);
      expect(output).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
    }
    const returned = toFhirR5Dosages(r6)[0];
    expect(returned.additionalInstruction).toEqual(row.additionalInstruction);
    expect(returned.doseAndRate).toEqual(row.doseAndRate);
    expect(returned.extension).toContainEqual(unknown);
    expect(toDosageDetails([row]).step[0].component[0].additionalInstruction).toEqual(row.additionalInstruction);
    expect(JSON.stringify([row, r6])).toBe(before);
  });
});

describe("current topical method and independent dressing directions", () => {
  it("retains a registered thin application method in fresh R5 and R6 Thai directions", () => {
    const source = "Apply a thin layer to affected area twice daily; do not cover with an occlusive dressing.";
    const note = { url: "https://example.org/topical-plan", valueString: "retain current plan" };
    const method = { coding: [{ system: "http://snomed.info/sct", code: "420162004", display: "To be spread thinly" }] };
    const row: FhirDosage = {
      id: "thin-method", text: source, method,
      route: { coding: [{ system: "http://snomed.info/sct", code: "6064005" }] },
      site: { text: "affected area" },
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
      additionalInstruction: [{ text: "Do not cover with an occlusive dressing." }], extension: [note]
    };
    const native: FhirR6DosageInstruction = { step: [{ component: [{ ...structuredClone(row), site: { concept: { text: "affected area" } } }] }] };
    const generic: FhirDosage = { ...structuredClone(row), method: { ...structuredClone(method), text: "Apply" } };
    const before = structuredClone({ row, native, generic });
    for (const { input, r6 } of [{ input: row, r6: toDosageDetails([row]) }, { input: native, r6: native },
      { input: generic, r6: toDosageDetails([generic]) }]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(english.split("; original directions:")[0]).toContain("Apply thinly");
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      const current = thai.split("; ข้อความเดิม:")[0];
      expect(current).toContain("บางๆ");
      expect(current).toContain("วันละ 2 ครั้ง");
      expect(current).toContain("บริเวณที่มีอาการ");
      expect(thai).toContain(source);
      const reopened = toFhirR5Dosages(r6)[0];
      expect(reopened.method).toMatchObject(method);
      expect(reopened.timing?.repeat).toMatchObject(row.timing!.repeat!);
      expect(reopened.extension).toContainEqual(note);
      expect(reopened.doseAndRate ?? []).toHaveLength(0);
    }
    const translated: FhirDosage = { ...structuredClone(row), method: { ...structuredClone(method), text: "Apply thinly",
      _text: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "ทาบางเฉพาะบริเวณ" }
      ] }] }
    } };
    const overridden = formatSig(translated, "long", { locale: "th", realizationMode: "normalized" }).split("; ข้อความเดิม:")[0];
    expect(overridden).toContain("ทาบางเฉพาะบริเวณ");
    expect(overridden).not.toContain("บางๆ");
    const custom: FormatOptions = { realizationMode: "normalized", instructionActionMap: { apply: {
      code: "clinic-apply", semanticClass: "administration", display: "Apply by clinic plan", i18n: { th: "ทาตามแผนคลินิก" },
      administrationMethod: { system: "http://snomed.info/sct", code: "420162004", display: "To be spread thinly" }
    } } };
    expect(formatSig(generic, "long", { ...custom, locale: "en" }).split("; original directions:")[0]).toContain("Apply by clinic plan");
    expect(formatSig(generic, "long", { ...custom, locale: "th" }).split("; ข้อความเดิม:")[0]).toContain("ทาตามแผนคลินิก");
    const slow: FhirDosage = { method: structuredClone(generic.method), route: structuredClone(row.route),
      doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      additionalInstruction: [{ coding: [{ system: "http://snomed.info/sct", code: "419443000", display: "Slowly" }] }] };
    const slowBefore = structuredClone(slow);
    for (const input of [slow, toDosageDetails([slow])]) {
      const en = formatSig(input, "long", { ...custom, locale: "en" });
      const th = formatSig(input, "long", { ...custom, locale: "th" });
      expect(en).toContain("Apply by clinic plan 1 g");
      expect(en).toContain("Apply by clinic plan slowly"); expect(en).not.toContain("Apply thinly");
      expect(th).toContain("ทาตามแผนคลินิกช้าๆ"); expect(th).not.toContain("ทาบางๆ");
    }
    expect(formatSig({ method: slow.method }, "short", { ...custom, locale: "en" })).toBe("Apply by clinic plan");
    expect(slow).toEqual(slowBefore);
    expect({ row, native, generic }).toEqual(before);
  });
});

describe("independent route labels and bedtime event anchors", () => {
  it("distinguishes supplied nasal and oral inhalation labels without changing the wire route", () => {
    for (const text of ["Nasal inhalation", "Oral inhalation"]) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "puff" } }], route: { text },
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
      const input: FhirR6DosageInstruction = { step: [{ component: structuredClone([row]) }] };
      const before = structuredClone({ row, input });
      for (const value of [row, input]) {
        const thai = formatSig(value, "long", { locale: "th", realizationMode: "normalized" });
        expect(thai).toContain(text === "Nasal inhalation" ? "จมูก" : "สูด");
        if (text === "Oral inhalation") expect(thai).not.toContain("จมูก");
        expect(thai).toContain("1 พัฟ"); expect(thai).toContain("วันละครั้ง");
      }
      expect(toFhirR5Dosages(input)[0].route).toEqual({ text });
      expect(toDosageDetails([row]).step![0].component[0].route).toEqual({ text });
      expect({ row, input }).toEqual(before);
    }
  });

  it("keeps the BED anchor when an upper-only period consumes the short cadence slot", () => {
    const code = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code, repeat: { periodMax: 1, periodUnit: FhirPeriodUnit.Day } } };
    const before = structuredClone(row);
    for (const input of [row, toDosageDetails([row])]) {
      expect(formatSig(input, "short", { locale: "en", realizationMode: "normalized" })).toBe("1 tab every up to 1 day HS");
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("at bedtime");
    }
    const exact: FhirDosage = { doseAndRate: structuredClone(row.doseAndRate), timing: { code, repeat: { period: 1, periodUnit: FhirPeriodUnit.Day } } };
    expect(formatSig(exact, "short", { locale: "en", realizationMode: "normalized" })).toBe("1 tab BED");
    expect(row).toEqual(before);
  });
});


describe("current cadence and authored dose condition ownership", () => {
  it("qualifies current daily directions before independent advice while retaining the authored dose", () => {
    const source = "Swallow 1 tablet whole";
    const predicate: MedicationCondition = { kind: "measurement", name: "sbp", operation: "gt", value: 160, text: "SBP > 160" };
    const repeat = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
    const note = { url: "https://example.org/guard-review", valueString: "Retain current directions" };
    const row: FhirDosage = { text: source, timing: { repeat }, patientInstruction: "Otherwise hold.", extension: [note] };
    setDosageCondition(row, predicate);
    const r6: FhirR6DosageInstruction = { step: [{ component: [{ text: source, timing: { repeat },
      condition: [conditionToR6(predicate)], patientInstruction: "Otherwise hold.", extension: [note] }] }] };
    const before = structuredClone({ row, r6 });
    for (const input of [row, r6]) for (const locale of ["en", "th"] as const) {
      const output = formatSig(input, "long", { locale, realizationMode: "normalized" });
      const [current, original] = output.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
      expect(current).toContain(locale === "en" ? "once daily only if SBP > 160" : "วันละครั้ง เฉพาะเมื่อ SBP > 160");
      expect(current).toContain("Otherwise hold");
      expect(current).not.toMatch(/Otherwise hold\.? (?:only if|เฉพาะเมื่อ)/u);
      expect(original).toContain(source); expect(original).toContain("SBP > 160");
      let calls = 0;
      const custom = formatSig(input, "long", { locale, realizationMode: "normalized", i18n: {
        inherit: locale, formatLong: context => {
          calls++; expect(context.defaultText).toBe(output); return "Clinic directions";
        }
      } });
      expect(custom).toBe("Clinic directions"); expect(calls).toBe(1);
    }
    const returned = toFhirR5Dosages(r6)[0];
    expect(returned.text).toBe(source); expect(returned.extension).toContainEqual(note);
    expect(getDosageCondition(returned)).toMatchObject(predicate);
    expect(returned.doseAndRate ?? []).toHaveLength(0);
    expect({ row, r6 }).toEqual(before);
  });
});


describe("conditional warning ownership on fresh projections", () => {
  it.each(["If dizzy", "If systolic BP is below 90"])(
    "keeps the complete %s warning without an unconditional generated daughter",
    condition => {
      const warning = condition + ", do not take the 1-tablet morning dose";
      const source = "Take 1 tablet at 08:00 and 20:00 for 4 doses. " + warning + ".";
      const parsed = parseSig(source);
      const native = parsed.meta.canonical!.course!;
      const rows: FhirDosage[] = JSON.parse(JSON.stringify(parsed.fhir));
      const r6: FhirR6DosageInstruction = JSON.parse(JSON.stringify(parsed.fhirNext));
      const before = structuredClone({ native, rows, r6 });
      for (const input of [native, rows, r6]) {
        const course = importCanonicalCourse(input);
        const members = course.stages.flatMap(stage => stage.administrations);
        expect(members).toHaveLength(2);
        expect(members.map(member => member.schedule?.recurrence?.clocks?.[0]).sort())
          .toEqual(["08:00:00", "20:00:00"]);
        for (const member of members) {
          expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
          expect(member.schedule?.recurrence?.sharedCount?.count).toBe(4);
          expect(member.schedule?.recurrence?.count).toBeUndefined();
          expect(member.additionalInstructions?.map(instruction => instruction.text)).toEqual([warning]);
          expect(member.syntax?.additionalInstructions?.map(instruction => instruction.text)).toEqual([warning]);
          const graph = member.syntax?.instructionGraph;
          expect(graph?.actions).toHaveLength(1);
          expect(graph?.actions[0].polarity).toBe(AdvicePolarity.Negate);
          expect(graph?.relations).toMatchObject([{ kind: AdviceRelation.If, toActionIndex: 0 }]);
        }
        const morning = members.find(member => member.schedule?.recurrence?.clocks?.[0] === "08:00:00")!;
        const evening = members.find(member => member.schedule?.recurrence?.clocks?.[0] === "20:00:00")!;
        expect(morning.predicate?.kind).toBe("not");
        expect(evening.predicate).toBeUndefined();
        const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        expect(en.split(warning)).toHaveLength(3);
        expect(en).not.toContain("Do not take the 1 tablet morning dose");
        expect(en).toContain("1 tablet orally at 8:00 am unless");
        expect(en).toContain("1 tablet orally at 8:00 pm");
        expect(th.match(/ห้ามรับประทาน/gu)).toHaveLength(2);
        expect(th).not.toContain("ห้ามรับประทาน the 1 tablet morning dose");
        expect(th).toContain("1 เม็ด เวลา 08:00");
        expect(th).toContain("1 เม็ด เวลา 20:00");
        expect(th).toContain(condition === "If dizzy" ? "ถ้าเวียนศีรษะห้ามรับประทาน" :
          "If systolic BP is below 90ห้ามรับประทาน");
      }
      for (const clause of parsed.meta.canonical!.clauses!) {
        expect(canonicalToFhir(clause).additionalInstruction?.map(instruction => instruction.text))
          .toEqual([warning]);
      }
      expect(parsed.input).toBe(source);
      expect(r6.renderedInstruction).toBe(source);
      expect({ native, rows, r6 }).toEqual(before);
    }
  );

  it("retains independently supplied annotated advice beside a conditional graph warning", () => {
    const warning = "If dizzy, do not take the 1-tablet morning dose";
    const actionStart = warning.indexOf("do not");
    const note = { url: "urn:clinic:warning-note", valueString: "Independently supplied" };
    const graph: CanonicalInstructionGraph = {
      sourceText: warning, sourceLocale: "en", primaryOwnership: {},
      actions: [{ force: AdviceForce.Warning, polarity: AdvicePolarity.Negate,
        predicate: { lemma: "take", display: "Take", semanticClass: "administration" },
        args: [{ role: AdviceArgumentRole.Object, text: "the 1-tablet morning dose",
          normalized: "the 1-tablet morning dose", i18n: { th: "ยาเช้า 1 เม็ด" } }],
        span: { start: actionStart, end: warning.length }, sourceText: warning.slice(actionStart)
      }],
      relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: "If dizzy,",
        span: { start: 0, end: "If dizzy,".length }, sourceExtensions: [note] }]
    };
    const additionalInstruction = [
      { text: warning },
      { id: "separate-prohibition", text: "Do not take the 1 tablet morning dose",
        _text: { id: "supplied-label", extension: [note] }, extension: [note] }
    ];
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
      additionalInstruction,
      extension: [note, buildInstructionGraphExtension(graph)!]
    };
    const r6: FhirR6DosageInstruction = { step: [{ component: [structuredClone(row)] }] };
    const before = structuredClone({ row, r6 });
    for (const input of [row, r6, importCanonicalCourse(r6)]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toContain("Do not take the 1 tablet morning dose.");
      expect(en).toContain(warning);
      const course = importCanonicalCourse(input);
      expect(course.stages[0].administrations[0].additionalInstructions).toEqual(additionalInstruction);
    }
    const returned = toFhirR5Dosages(r6)[0];
    expect(returned.additionalInstruction).toEqual(additionalInstruction);
    expect(returned.extension).toContainEqual(note);
    expect(parseInstructionGraphExtension(returned.extension)?.relations?.[0].sourceExtensions).toEqual([note]);
    expect(toDosageDetails([row]).step[0].component[0].additionalInstruction).toEqual(additionalInstruction);
    expect({ row, r6 }).toEqual(before);
  });
});


describe("typed graph warnings without synthesized wire advice", () => {
  it("preserves a supplied conditional graph without projecting its bare action as independent advice", () => {
    const warning = "If dizzy, do not take the morning dose";
    const start = warning.indexOf("do not");
    const note = { url: "urn:clinic:condition-note", valueString: "Preserve conditional ownership" };
    const graph: CanonicalInstructionGraph = {
      sourceText: warning, sourceLocale: "en", primaryOwnership: {},
      actions: [{ force: AdviceForce.Warning, polarity: AdvicePolarity.Negate,
        predicate: { lemma: "take", display: "Take", semanticClass: "administration" },
        args: [{ role: AdviceArgumentRole.Object, text: "the morning dose",
          normalized: "the morning dose", i18n: { th: "ยาเช้า" } }],
        span: { start, end: warning.length }, sourceText: warning.slice(start)
      }],
      relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: "If dizzy,",
        span: { start: 0, end: "If dizzy,".length }, sourceExtensions: [note] }]
    };
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      extension: [note, buildInstructionGraphExtension(graph)!]
    };
    const r6: FhirR6DosageInstruction = { step: [{ component: [structuredClone(row)] }] };
    const before = structuredClone({ row, r6 });
    const native = importCanonicalCourse(r6);
    for (const input of [row, r6, native]) {
      const course = importCanonicalCourse(input);
      expect(course.stages[0].administrations[0].additionalInstructions).toBeUndefined();
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain(warning);
      expect(en.match(/do not take/giu)).toHaveLength(1);
      expect(en).toContain("1 tablet");
      expect(th).toContain("ถ้าเวียนศีรษะห้ามรับประทานยาเช้า");
      expect(th.match(/ห้ามรับประทาน/gu)).toHaveLength(1);
      expect(th).toContain("1 เม็ด");
    }
    const projected = [
      toFhirR5Dosages(r6)[0],
      toDosageDetails([row]).step[0].component[0],
      courseToR6(native).step[0].component[0]
    ];
    for (const output of projected) expect(output.extension).toContainEqual(note);
    for (const output of [canonicalToFhir(canonicalFromFhir(row)), ...projected]) {
      expect(output.additionalInstruction).toBeUndefined();
      expect(output.doseAndRate).toMatchObject(row.doseAndRate!);
      const retained = parseInstructionGraphExtension(output.extension);
      expect(retained?.sourceText).toBe(warning);
      expect(retained?.actions[0].polarity).toBe(AdvicePolarity.Negate);
      expect(retained?.relations?.[0]).toMatchObject({
        kind: AdviceRelation.If, toActionIndex: 0, sourceExtensions: [note]
      });
    }
    expect({ row, r6 }).toEqual(before);
  });
});


describe("current FHIR header and annotation ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([false, true])("preserves an explicitly unknown native course count (unknown=%s)", unknown => {
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 28, unit: "d" },
      cycleCountUnresolved: unknown ? true : undefined, stages: [{
        end: { anchor: "treatment-start", displacement: { value: 7, unit: "d" } },
        administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
          schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } } }],
      }] };
    const before = fresh(course), projected = projectCanonicalCourse(course);
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 2 };
    for (const input of [course, fresh(projected.fhir), fresh(projected.fhirNext)]) {
      const imported = importCanonicalCourse(input);
      expect(imported.cycleCount).toBeUndefined();
      expect(imported.cycleCountUnresolved).toBe(unknown ? true : undefined);
      if (unknown) {
        expect(() => nextDueDoses(input, query)).toThrow(expect.objectContaining({ code: "course-cycle-count-unresolved" }));
        expect(() => calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: "d" }))
          .toThrow(expect.objectContaining({ code: "course-cycle-count-unresolved" }));
      } else {
        expect(nextDueDoses(input, query)).toEqual(["2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(3);
      }
    }
    const count = projected.fhirNext.modifierExtension?.find(item => item.url === COURSE_CYCLE_COUNT_EXTENSION_URL);
    if (unknown) expect(count?._valueInteger?.extension).toContainEqual({
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
    });
    else expect(count).toBeUndefined();
    expect(course).toEqual(before);
  });

  it.each(["extension", "primitive", "container"] as const)("projects a calibration Quantity inside a CodeableReference (%s)", location => {
    const calibration: FhirR6Extension = { url: "urn:clinic:calibration", valueQuantity: {
      value: 5, unit: "mL", system: "http://unitsofmeasure.org", code: "mL", comparator: "~",
      extension: [{ url: "urn:clinic:calibration-note", valueString: "retain" }],
    } };
    const concept = { id: "pump-kind", text: "Infusion pump", coding: [{ system: "urn:clinic:devices", code: "pump" }],
      ...(location === "extension" ? { extension: [calibration] } :
        location === "primitive" ? { _text: { id: "pump-label", extension: [calibration] } } : {}) };
    const device = { id: "device-owner", concept,
      reference: { reference: "Device/pump-1", display: "Clinic pump", identifier: { system: "urn:clinic:device-id", value: "pump-1" } },
      extension: [{ url: "urn:clinic:device-note", valueString: "keep original device metadata" },
        ...(location === "container" ? [calibration] : [])],
    };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: {
      value: 1, unit: "mL", system: "http://unitsofmeasure.org", code: "mL",
      extension: [{ url: "urn:clinic:device", valueCodeableReference: device }],
    } }] }] }] };
    const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
    const projected = rows[0].doseAndRate![0].doseQuantity!.extension![0].valueCodeableReference!;
    const annotation = location === "container" ? projected.extension![1] :
      (location === "extension" ? projected.concept!.extension : projected.concept!._text!.extension)![0];
    expect(annotation.valueQuantity!.comparator).toBeUndefined();
    expect(getEmaQuantityComparator(annotation.valueQuantity)).toBe("~");
    expect(annotation.valueQuantity).toMatchObject({ value: 5, unit: "mL", code: "mL" });
    expect(projected.reference).toEqual(device.reference);
    expect(projected.extension![0]).toEqual(device.extension[0]);
    expect(projected.extension).toHaveLength(device.extension.length);
    expect(projected.id).toBe(device.id);
    const returned = toDosageDetails(rows).step[0].component[0].doseAndRate![0].doseQuantity!.extension![0].valueCodeableReference;
    expect(returned).toEqual(device);
    expect(input).toEqual(before);
  });

  it("retains primitive annotations on a current period dose limit", () => {
    const limit: FhirR6DoseLimit = { scope: "period", _scope: { id: "period-scope" },
      valueQuantity: { value: 2, unit: "tab" }, period: { value: 1, unit: "d", code: "d" },
      text: "Daily maximum", _text: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "ขนาดยาสูงสุดต่อวัน" },
      ] }] },
    };
    const input: FhirR6DosageInstruction = { safety: { doseLimit: [limit] }, step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
    }] }] };
    const before = fresh(input);
    expect(courseToR6(importCanonicalCourse(input)).safety?.doseLimit?.[0]).toEqual(limit);
    expect(toDosageDetails(fresh(toFhirR5Dosages(input))).safety?.doseLimit?.[0]).toEqual(limit);
    expect(input).toEqual(before);
  });
});


describe("fresh coded measurement and spatial target identity", () => {
  it("retains an exact code-only SBP threshold through native and both wire consumers", () => {
    const condition = { id: "sbp-threshold", code: { coding: [
      { system: "urn:ezmedicationinput:CodeSystem:medication-condition", code: "measurement" },
      { system: "http://loinc.org", code: "8480-6", _code: { id: "sbp-code" } }
    ] }, operation: "gt" as const, _operation: { id: "comparison" },
      valueQuantity: { value: 160, unit: "mmHg", code: "mm[Hg]", system: "http://unitsofmeasure.org" },
      extension: [{ url: "urn:clinic:condition-note", valueString: "retain calibration" }] };
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"],
        boundsDuration: { value: 2, unit: "d", code: "d", system: "http://unitsofmeasure.org" } } },
      condition: [condition]
    }] }] };
    const before = JSON.stringify(input), rows = toFhirR5Dosages(input);
    const restored = toDosageDetails(JSON.parse(JSON.stringify(rows)));
    expect(restored.step[0].component[0].condition).toEqual([condition]);
    for (const value of [input, importCanonicalCourse(input), JSON.parse(JSON.stringify(rows)), restored]) {
      const member = importCanonicalCourse(value).stages[0].administrations[0];
      expect(member.predicate).toMatchObject({ kind: "measurement", name: "sbp", operation: "gt", value: 160, unit: "mmHg" });
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(evaluateMedicationCondition(member.predicate!, { sbp: 170 })).toBe(true);
      expect(evaluateMedicationCondition(member.predicate!, { sbp: 160 })).toBe(false);
      const options = { from: "2026-11-27T08:00:00Z", orderedAt: "2026-11-27T08:00:00Z", timeZone: "UTC", limit: 2 };
      expect(nextDueDoses(value, { ...options, evaluateCondition: predicate => evaluateMedicationCondition(predicate, { sbp: 170 }) }))
        .toEqual(["2026-11-27T08:00:00+00:00", "2026-11-28T08:00:00+00:00"]);
      expect(nextDueDoses(value, { ...options, evaluateCondition: predicate => evaluateMedicationCondition(predicate, { sbp: 160 }) })).toEqual([]);
      const preview = formatSig(value, "long", { locale: "en", realizationMode: "normalized" });
      expect(preview).toContain("160");
      expect(preview).toContain("mmHg");
      expect(preview).not.toContain("Unresolved condition");
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps authored measurement labels and unresolved foreign measurement codes", () => {
    for (const [coding, text, expected] of [
      [{ system: "http://loinc.org", code: "8480-6" }, "clinic systolic reading", "clinic systolic reading"],
      [{ system: "urn:clinic:measurement", code: "8480-6" }, undefined, undefined]
    ] as const) {
      const condition = { code: { coding: [coding], ...(text ? { text } : {}) }, operation: "gt" as const,
        valueQuantity: { value: 160, unit: "mmHg" } };
      const input: FhirR6DosageInstruction = { step: [{ component: [{ condition: [condition] }] }] };
      const before = JSON.stringify(input);
      const predicate = importCanonicalCourse(input).stages[0].administrations[0].predicate;
      expect(predicate).toMatchObject(expected ? { kind: "measurement", name: expected, value: 160 }
        : { kind: "text", text: "Unresolved condition" });
      expect(toDosageDetails(toFhirR5Dosages(input)).step[0].component[0].condition).toEqual([condition]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("retains an R6 site Element spatial relation without inventing a target concept", () => {
    const target = { id: "right-eye-target", coding: [
      { system: "urn:clinic:site", code: "eye-right", _code: { id: "local-code" } },
      { system: "http://snomed.info/sct", code: "1290032005", _code: { id: "anatomical-code" } }
    ] };
    const spatial = { id: "spatial-relation", url: BODY_SITE_SPATIAL_RELATION_EXTENSION_URL, extension: [
      { url: "relationText", valueString: "around" }, { url: "target", valueCodeableConcept: target },
      { url: "urn:clinic:relation-note", valueString: "retain relation annotation" }
    ] };
    const site = { id: "current-site", reference: { reference: "BodyStructure/right-eye", id: "site-reference" },
      extension: [spatial, { url: "urn:clinic:site-note", valueString: "retain site annotation" }] };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ site,
      method: { text: "Apply", coding: [{ system: "http://snomed.info/sct", code: "738991002" }] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }]
    }] }] };
    const before = JSON.stringify(input), native = importCanonicalCourse(input);
    const member = native.stages[0].administrations[0];
    expect(member.target).toBeUndefined();
    expect(member.siteReference).toEqual(site.reference);
    expect(member.siteSpatialRelation).toMatchObject({ relationText: "around", targetConcept: target,
      targetCoding: { system: "http://snomed.info/sct", code: "1290032005" } });
    expect(courseToR6(native).step[0].component[0].site).toEqual(site);
    const rows = toFhirR5Dosages(input);
    expect(rows[0].site?.text).toBeUndefined();
    expect(rows[0].site?.coding).toBeUndefined();
    expect(rows[0].site?.extension?.filter(field => field.url === BODY_SITE_SPATIAL_RELATION_EXTENSION_URL)).toEqual([spatial]);
    const restored = toDosageDetails(JSON.parse(JSON.stringify(rows)));
    expect(restored.step[0].component[0].site).toEqual(site);
    for (const value of [input, native, JSON.parse(JSON.stringify(rows)), restored]) {
      const current = importCanonicalCourse(value).stages[0].administrations[0];
      expect(current.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "g" });
      expect(current.siteSpatialRelation?.targetConcept).toEqual(target);
      expect(formatSig(value, "long", { locale: "en", realizationMode: "normalized" })).toContain("around the right eye");
      expect(formatSig(value, "long", { locale: "th", realizationMode: "normalized" })).toContain("รอบตาขวา");
      const projected = courseToR6(importCanonicalCourse(value)).step[0].component[0].site!;
      expect(projected.extension?.filter(field => field.url === BODY_SITE_SPATIAL_RELATION_EXTENSION_URL)).toEqual([spatial]);
      expect(projected.concept).toBeUndefined();
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([undefined, "authored target"])("retains a nested coded anatomical target and its authored text: %s", text => {
    const target = { id: "spatial-target", ...(text ? { text } : {}), coding: [
      { system: "urn:clinic:site", code: "eye-right", _code: { id: "local-site-code" } },
      { system: "http://snomed.info/sct", code: "1290032005", extension: [{ url: "urn:clinic:site-note", valueString: "retain site" }] }
    ] };
    const site = { extension: [{ url: BODY_SITE_SPATIAL_RELATION_EXTENSION_URL, extension: [
      { url: "relationText", valueString: "around" }, { url: "target", valueCodeableConcept: target }
    ] }] };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ site: { concept: site }, method: { text: "Apply", coding: [
      { system: "http://snomed.info/sct", code: "738991002" }
    ] }, doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }] }] }] };
    const before = JSON.stringify(input);
    const relation = parseBodySiteSpatialRelationExtension(site)!;
    expect(relation.targetCoding).toMatchObject({ system: "http://snomed.info/sct", code: "1290032005" });
    expect(relation.targetText).toBe(text);
    expect(buildBodySiteSpatialRelationExtension(relation)!.extension!.find(child => child.url === "target")!.valueCodeableConcept).toEqual(target);
    const rows = toFhirR5Dosages(input), restored = toDosageDetails(JSON.parse(JSON.stringify(rows)));
    expect(restored.step[0].component[0].site?.concept).toEqual(site);
    for (const value of [input, importCanonicalCourse(input), JSON.parse(JSON.stringify(rows)), restored]) {
      const en = formatSig(value, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toContain(text ? "around the authored target" : "around the right eye");
      if (!text) expect(formatSig(value, "long", { locale: "th", realizationMode: "normalized" })).toContain("รอบตาขวา");
    }
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("independent FHIR annotations and timing constraints", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  it("projects a retained stage Quantity annotation through the R5 operator codec", () => {
    const annotation: FhirR6Extension = { url: "urn:clinic:stage-preparation", valueQuantity: {
      value: 30, unit: "minutes", code: "min", system: "http://unitsofmeasure.org", comparator: "~",
      _value: { id: "preparation-length" },
      extension: [{ url: "urn:clinic:preparation-note", valueString: "Retain the estimate" }],
    } };
    const input: FhirR6DosageInstruction = { step: [{ extension: [annotation], component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
    const pending = [...(rows[0].extension ?? []), ...(rows[0].modifierExtension ?? [])], retained: FhirExtension[] = [];
    while (pending.length) {
      const field = pending.pop()!;
      if (field.url === annotation.url) retained.push(field);
      for (const child of field.extension ?? []) pending.push(child);
    }
    expect(retained.length).toBeGreaterThan(0);
    for (const field of retained) {
      expect(field.valueQuantity?.comparator).toBeUndefined();
      expect(getEmaQuantityComparator(field.valueQuantity)).toBe("~");
      expect(field.valueQuantity?._value).toEqual(annotation.valueQuantity!._value);
    }
    expect(toDosageDetails(rows).step[0].extension).toEqual(before.step[0].extension);
    expect(projectCanonicalCourse(importCanonicalCourse(fresh(input))).fhirNext.step[0].extension)
      .toEqual(before.step[0].extension);
    expect(input).toEqual(before);
  });

  it.each(["absent", "annotated"] as const)("keeps a typed graph Amount with %s display text", display => {
    const text: FhirExtension = { url: "text", _valueString: { id: "unknown-amount-label",
      extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] } };
    const argument: FhirExtension = { url: "argument", id: "dispensed-amount", extension: [
      { url: "role", valueCode: AdviceArgumentRole.Amount },
      ...(display === "annotated" ? [text] : []),
      { url: "quantity", extension: [
        { url: "value", valueDecimal: 2 }, { url: "unit", valueString: "tab" },
      ] },
      { url: "urn:clinic:argument-note", valueString: "Independently supplied quantity" },
    ] };
    const marker: FhirExtension = { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, extension: [
      { url: "sourceText", valueString: "Take the prescribed amount" }, { url: "sourceLocale", valueCode: "en" },
      { url: "action", extension: [
        { url: "force", valueCode: AdviceForce.Instruction },
        { url: "predicateLemma", valueString: "take" },
        { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 26 },
        { url: "sourceText", valueString: "Take the prescribed amount" }, argument,
      ] },
    ] };
    const before = fresh(marker), graph = parseInstructionGraphExtension([marker])!;
    expect(graph.actions).toHaveLength(1);
    expect(graph.actions[0].args).toHaveLength(1);
    expect(graph.actions[0].args[0].quantity).toMatchObject({ value: 2, unit: "tab" });
    const rebuilt = fresh(buildInstructionGraphExtension(graph)!);
    const output = rebuilt.extension!.find(field => field.url === "action")!.extension!
      .find(field => field.url === "argument")!;
    expect(output.id).toBe(argument.id);
    expect(output.extension!.find(field => field.url === "quantity")).toEqual(argument.extension![display === "annotated" ? 2 : 1]);
    expect(output.extension!.find(field => field.url === "text")).toEqual(display === "annotated" ? text : undefined);
    expect(output.extension).toContainEqual(argument.extension![argument.extension!.length - 1]);
    expect(parseInstructionGraphExtension([rebuilt])!.actions[0].args[0].quantity).toMatchObject({ value: 2, unit: "tab" });
    expect(marker).toEqual(before);
  });

  it.each(["calendar", "duration", "combined", "combined-range"] as const)("writes one core bounds choice for a %s native schedule", variant => {
    const calendar = { start: "2027-07-05", end: "2027-07-20", id: "course-calendar" };
    const duration = { value: 5, unit: "d", code: "d", system: "http://unitsofmeasure.org",
      extension: [{ url: "urn:clinic:duration-note", valueString: "Five treatment days" }] };
    const range = { low: { ...duration, value: 3 }, high: duration };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["09:00:00"],
        ...(variant !== "duration" ? { calendarWindow: calendar } : {}),
        ...(variant === "combined-range" ? { courseLengthRange: range } :
          variant !== "calendar" ? { courseLength: duration } : {}),
      } },
    }] }] };
    const before = fresh(course), projected = projectCanonicalCourse(course);
    for (const row of [projected.fhir[0], projected.fhirNext.step[0].component[0]]) {
      const repeat = row.timing!.repeat!;
      expect([repeat.boundsDuration, repeat.boundsRange, repeat.boundsPeriod].filter(value => value !== undefined)).toHaveLength(1);
      if (variant !== "duration") expect(repeat.boundsPeriod).toEqual(calendar);
      else expect(repeat.boundsDuration).toMatchObject(duration);
    }
    if (variant === "combined-range") {
      for (const input of [fresh(projected.fhir), fresh(projected.fhirNext)]) {
        const administration = importCanonicalCourse(input).stages[0].administrations[0];
        expect(administration.schedule?.recurrence?.calendarWindow).toEqual(calendar);
        expect(administration.schedule?.recurrence?.courseLengthRange).toEqual(range);
      }
    }
    if (variant === "combined") {
      const query = { orderedAt: "2027-07-01T00:00:00Z", from: "2027-07-01T00:00:00Z", timeZone: "UTC", limit: 10 };
      for (const input of [course, fresh(projected.fhir), fresh(projected.fhirNext)]) {
        expect(nextDueDoses(input, query)).toEqual([
          "2027-07-05T09:00:00+00:00", "2027-07-06T09:00:00+00:00", "2027-07-07T09:00:00+00:00",
          "2027-07-08T09:00:00+00:00", "2027-07-09T09:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 20, durationUnit: "d" }).totalUnits).toBe(5);
        const administration = importCanonicalCourse(input).stages[0].administrations[0];
        expect(administration.schedule?.recurrence?.calendarWindow).toEqual(calendar);
        expect(administration.schedule?.recurrence?.courseLength ?? administration.anchoredLength?.quantity).toMatchObject(duration);
      }
    }
    expect(course).toEqual(before);
  });
});

describe("review51 current single-row and locale defaults", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  it("keeps a complete repeat cycle in the single-row R5 preview", () => {
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, code: "d", unit: "d" },
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          boundsDuration: { value: 7, code: "d", unit: "d" } } }
      }] }]
    };
    const rows = fresh(toFhirR5Dosages(source));
    expect(rows).toHaveLength(1);
    for (const locale of ["en", "th"]) {
      const before = fresh(rows);
      for (const style of ["short", "long"] as const)
        expect(formatSig(rows[0], style, { locale })).toBe(formatSig(rows, style, { locale }));
      const long = formatSig(rows, "long", { locale });
      expect(long).toContain(locale === "en" ? "every 28 days" : "28 วัน");
      expect(fromFhirDosage(rows[0], { locale }).longText).toBe(long);
      expect(rows).toEqual(before);
    }
    const ordinary = fresh(toFhirR5Dosages({ step: source.step }))[0];
    expect(formatSig(ordinary, "long")).toBe("Use 1 tablet once daily for 7 days.");
  });

  it("uses the exact monthly cadence when equal bounds accompany selected month days", () => {
    const make = (periodMax?: number): FhirDosage => ({
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }],
      timing: { repeat: { period: 1, periodMax, periodUnit: FhirPeriodUnit.Month, extension: [
        { url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: 1 },
        { url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: 15 }
      ] } }
    });
    for (const locale of ["en", "th"]) {
      const exact = make(), equal = make(1), ranged = make(2);
      for (const input of [equal, fresh([equal]), fresh(toDosageDetails([equal]))]) {
        const before = fresh(input), text = formatSig(input, "long", { locale });
        expect(text).toBe(formatSig(exact, "long", { locale }));
        expect(text).toContain(locale === "en" ? "days 1 and 15 of each month" : "วันที่ 1 และ 15 ของทุกเดือน");
        expect(input).toEqual(before);
      }
      expect(formatSig(ranged, "long", { locale }))
        .not.toContain(locale === "en" ? "of each month" : "ของทุกเดือน");
    }
  });

  it.each([
    { name: "spanless detailed source", sourceText: "where the skin directly beneath the dressing is intact",
      predicateText: "skin is intact", predicateStart: undefined },
    { name: "complete ranged predicate", sourceText: "where the skin directly beneath the dressing is intact",
      predicateText: "the skin directly beneath the dressing is intact", predicateStart: 6 },
    { name: "partial final-word predicate", sourceText: "where the skin is intact and dry",
      predicateText: "dry", predicateStart: 29 },
    { name: "partial predicate and independent dressing qualifier", sourceText: "where the skin feels warm and the dressing has lifted",
      predicateText: "the skin feels warm", predicateStart: undefined },
    { name: "leading independent context", sourceText: "where the dressing has lifted and the skin feels warm",
      predicateText: "the skin feels warm" },
    { name: "exact raw predicate", sourceText: "where the skin feels warm", predicateText: "the skin feels warm" }
  ])("retains an untranslated raw site restriction's complete authored source: $name", ({ sourceText, predicateText, predicateStart }) => {
    const note: FhirExtension = { url: "urn:clinic:restriction-note", valueString: "Independent annotation" };
    const restriction: FhirExtension = { id: "selected-restriction", url: BODY_SITE_RESTRICTION_EXTENSION_URL, extension: [
      { url: "relation", valueCode: "where" }, { url: "sourceText", valueString: sourceText },
      { url: "predicateText", valueString: predicateText }, { url: "predicateForm", valueCode: "raw" },
      ...(predicateStart !== undefined ? [
        { url: "sourceStart", valueInteger: 0 }, { url: "sourceEnd", valueInteger: sourceText.length },
        { url: "predicateStart", valueInteger: predicateStart }, { url: "predicateEnd", valueInteger: sourceText.length }
      ] : []), note
    ] };
    const row: FhirDosage = {
      method: { text: "Apply" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      site: { text: "skin", extension: [restriction] }
    };
    if (predicateStart !== undefined) expect(sourceText.slice(predicateStart)).toBe(predicateText);
    for (const input of [importCanonicalCourse([row]), fresh(row), fresh([row]), fresh(toDosageDetails([row]))]) {
      const before = fresh(input);
      for (const style of ["short", "long"] as const)
        expect(formatSig(input, style, { locale: "en", realizationMode: "normalized" }).split(sourceText)).toHaveLength(2);
      expect(formatSig(input, "long", { locale: "th" })).toContain("(" + sourceText + ")");
      const wire = projectCanonicalCourse(importCanonicalCourse(input)).fhir[0];
      expect(wire.site!.extension).toContainEqual(restriction);
      expect(input).toEqual(before);
    }
    const noSource = fresh(row);
    noSource.site!.extension![0].extension = restriction.extension!.filter(field => field.url !== "sourceText");
    expect(formatSig(noSource, "long", { locale: "th" })).toContain("(where " + predicateText + ")");
  });

  it.each([
    { realizationMode: "roundtrip" as const, sitePlacement: undefined, expected: "หยอด 1 หยด ที่ตาขวา.", placement: "trailing" },
    { realizationMode: "roundtrip" as const, sitePlacement: "natural" as const, expected: "หยอดตาขวา 1 หยด.", placement: "natural" },
    { realizationMode: "normalized" as const, sitePlacement: undefined, expected: "หยอดตาขวา ครั้งละ 1 หยด.", placement: "natural" },
    { realizationMode: "normalized" as const, sitePlacement: "trailing" as const, expected: "หยอดครั้งละ 1 หยด ที่ตาขวา.", placement: "trailing" }
  ])("shares the resolved Thai site placement with its callback: $realizationMode/$placement", test => {
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      method: { text: "Instill" },
      route: { coding: [{ system: "http://snomed.info/sct", code: "54485002" }] },
      site: { text: "right eye", coding: [{ system: "http://snomed.info/sct", code: "18944008" }] }
    };
    for (const input of [fresh(row), fresh([row]), fresh(toDosageDetails([row]))]) {
      let calls = 0;
      const before = fresh(input);
      expect(formatSig(input, "long", { locale: "th", realizationMode: test.realizationMode,
        sitePlacement: test.sitePlacement, i18n: { inherit: "th", formatLong: context => {
          calls++;
          expect(context.sitePlacement).toBe(test.placement);
          expect(context.defaultText).toBe(test.expected);
          expect(context.formatDefault("long")).toBe(test.expected);
          return context.defaultText;
        } } })).toBe(test.expected);
      expect(calls).toBe(1);
      expect(input).toEqual(before);
    }
  });
});


describe("current FHIR datatype and annotation preservation", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };

  it("retains an opaque Period extension in both wire representations", () => {
    const annotation: FhirR6Extension = { url: "urn:clinic:review-window", valuePeriod: {
      id: "review-window", start: "2027-07-05", end: "2027-07-20",
      _start: { id: "opening-date", extension: [{ url: "urn:clinic:opening-note", valueString: "Keep the authored date" }] },
      extension: [{ url: "urn:clinic:period-note", valueString: "Clinical review window" }],
    } };
    const r5: FhirExtension = { url: annotation.url, valuePeriod: {
      id: "r5-window", start: "2027-07-05", _start: { id: "r5-opening" },
    } };
    for (const extension of [annotation, r5]) {
      const input: FhirR6DosageInstruction = { step: [{ component: [{ extension: [extension],
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: daily },
      }] }] };
      const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
      expect(rows[0].extension).toContainEqual(extension);
      expect(toDosageDetails(rows).step[0].component[0].extension).toContainEqual(extension);
      expect(input).toEqual(before);
    }
  });

  it("keeps an incomplete period maximum beside independently supplied safety advice", () => {
    const ratio = { id: "partial-period", numerator: { value: 10, unit: "mg", _value: { id: "maximum-dose" } },
      denominator: { unit: "d", code: "d", system: "http://unitsofmeasure.org",
        extension: [{ url: "urn:clinic:unknown-period", valueString: "Period magnitude not supplied" }] },
      extension: [{ url: "urn:clinic:cap-note", valueString: "Retain both endpoints" }],
    };
    const input: EzDosage[] = [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "mg" } }],
      timing: { repeat: daily }, maxDosePerPeriod: [ratio], safety: { ifExceeded: "Contact the prescriber" },
    }];
    const before = fresh(input), native = importCanonicalCourse(fresh(input));
    expect(native.stages[0].administrations[0].limits).toHaveLength(1);
    expect(native.stages[0].administrations[0].limits![0]).toMatchObject({
      scope: "period", amount: ratio.numerator, period: ratio.denominator,
    });
    const output = projectCanonicalCourse(native);
    expect(output.fhir[0].maxDosePerPeriod).toEqual([ratio]);
    const safety = output.fhirNext.step[0].component[0].safety!;
    expect(safety.ifExceeded).toBe("Contact the prescriber");
    expect(safety.doseLimit).toEqual([{ id: ratio.id, scope: "period", valueQuantity: ratio.numerator,
      period: ratio.denominator, extension: ratio.extension }]);
    expect(safety.doseLimit![0].period?.value).toBeUndefined();
    expect(calculateTotalUnits({ dosage: native, durationValue: 3, durationUnit: "d",
      orderedAt: "2027-07-05T00:00:00Z", from: "2027-07-05T00:00:00Z", timeZone: "UTC" }).totalUnits).toBe(3);
    expect(input).toEqual(before);
  });

  it("keeps an unchanged qualified duration with a local unit active and non-executable", () => {
    const quantity = { value: 2, unit: "observation blocks", code: "observation-block", system: "urn:clinic:units",
      comparator: "~" as const, _value: { id: "duration-magnitude" },
      extension: [{ url: "urn:clinic:duration-note", valueString: "No fixed elapsed length" }],
    };
    const marker: FhirExtension = { id: "local-duration", url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      valueQuantity: quantityForR5(quantity) };
    const input: FhirDosage[] = [{ doseAndRate: [{ rateRatio: { numerator: { value: 10, unit: "mg" },
      denominator: { value: 1, unit: "h", code: "h", system: "http://unitsofmeasure.org" } } }],
      timing: { repeat: { ...daily, extension: [marker] } },
    }];
    const before = fresh(input), native = importCanonicalCourse(fresh(input));
    expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject({
      occurrenceDuration: 2, occurrenceDurationComparator: "~",
    });
    expect(native.stages[0].administrations[0].schedule?.recurrence?.occurrenceDurationUnit).toBeUndefined();
    const output = projectCanonicalCourse(native);
    const r5Marker = output.fhir[0].timing!.repeat!.extension!.find(field => field.url === marker.url)!;
    expect(r5Marker).toEqual(marker);
    const r6Marker = output.fhirNext.step[0].component[0].timing!.repeat!.extension!.find(field => field.url === marker.url)!;
    expect(r6Marker.id).toBe(marker.id);
    expect(quantityFromR5(r6Marker.valueQuantity)).toEqual(quantity);
    expect(importCanonicalCourse(fresh(output.fhirNext)).stages[0].administrations[0]
      .schedule?.recurrence?.occurrenceDurationUnit).toBeUndefined();
    for (const dosage of [native, fresh(output.fhir), fresh(output.fhirNext)])
      expect(() => calculateTotalUnits({ dosage, durationValue: 1, durationUnit: "d",
        orderedAt: "2027-07-05T00:00:00Z", from: "2027-07-05T00:00:00Z", timeZone: "UTC" }))
        .toThrow(expect.objectContaining({ code: "infusion-duration-required" }));
    expect(input).toEqual(before);
  });

  it.each(["valueString", "valueMarkdown"] as const)("reads and updates a %s translation without changing its datatype", choice => {
    const companion = choice === "valueMarkdown" ? "_valueMarkdown" : "_valueString";
    const primitive = { id: "method-label", extension: [{ id: "thai-label",
      url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" },
        { url: "content", [choice]: "วิธีเฉพาะ", [companion]: { id: "authored-content" },
          extension: [{ url: "urn:clinic:translation-note", valueString: "Reviewed wording" }] },
      ],
    }] };
    const before = fresh(primitive);
    expect(getPrimitiveTranslation(primitive, "th")).toBe("วิธีเฉพาะ");
    const source: FhirR6DosageInstruction = { step: [{ component: [{ method: { coding: [
      { system: "urn:clinic:method", code: "special", display: "Special method", _display: primitive },
    ] }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }] };
    expect(formatCanonicalCourse(importCanonicalCourse(source), "long", { locale: "th" })).toContain("วิธีเฉพาะ");
    const updated = mergeTranslationPrimitiveElement(primitive, { th: "วิธีที่ทบทวนแล้ว" })!;
    expect(updated.extension![0].extension![1]).toEqual({ ...before.extension[0].extension[1],
      [choice]: "วิธีที่ทบทวนแล้ว" });
    expect(getPrimitiveTranslation(updated, "th")).toBe("วิธีที่ทบทวนแล้ว");
    expect(primitive).toEqual(before);
  });

  it.each([undefined, "degrees Celsius"])("retains a coded measurement unit with authored label %s", unit => {
    const condition = { code: { coding: [{ system: "http://loinc.org", code: "8310-5" }] }, operation: "ge" as const,
      valueQuantity: { value: 38, system: "http://unitsofmeasure.org", code: "Cel", ...(unit ? { unit } : {}),
        extension: [{ url: "urn:clinic:threshold-note", valueString: "Measured temperature" }] },
    };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ condition: [condition],
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    }] }] };
    const before = fresh(source), native = importCanonicalCourse(fresh(source)), rows = fresh(toFhirR5Dosages(source));
    for (const predicate of [native.stages[0].administrations[0].predicate, getDosageCondition(rows[0])])
      expect(predicate).toMatchObject({ kind: "measurement", operation: "ge", value: 38, unit: unit ?? "Cel" });
    expect(toDosageDetails(rows).step[0].component[0].condition).toEqual([condition]);
    expect(source).toEqual(before);
  });

  it("routes graph Coding quantity annotations through the existing R5 operator codec", () => {
    const note: FhirR6Extension = { url: "urn:clinic:estimate", valueQuantity: { value: 2, unit: "g", comparator: "~",
      _value: { id: "estimated-weight" }, extension: [{ url: "urn:clinic:estimate-note", valueString: "Keep estimate" }],
    } };
    const coding = { system: "urn:clinic:site", code: "hands", display: "Hands", extension: [note],
      _code: { id: "site-code", extension: [note] }, _display: { id: "site-display", extension: [note] } };
    const marker: FhirR6Extension = { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, extension: [
      { url: "sourceText", valueString: "Wash hands" }, { url: "sourceLocale", valueCode: "en" },
      { url: "action", extension: [{ url: "force", valueCode: AdviceForce.Instruction },
        { url: "predicateLemma", valueString: "wash" }, { url: "spanStart", valueInteger: 0 },
        { url: "spanEnd", valueInteger: 10 }, { url: "sourceText", valueString: "Wash hands" },
        { url: "argument", extension: [{ url: "role", valueCode: AdviceArgumentRole.Site },
          { url: "text", valueString: "hands" }, { url: "coding", valueCoding: coding }] },
      ] },
    ] };
    const before = fresh(marker), graph = parseInstructionGraphExtension([marker])!;
    const saved = fresh(buildInstructionGraphExtension(graph)!);
    const output = saved.extension!.find(field => field.url === "action")!.extension!
      .find(field => field.url === "argument")!.extension!.find(field => field.url === "coding")!.valueCoding!;
    for (const annotation of [output.extension![0], output._code!.extension![0], output._display!.extension![0]]) {
      expect(annotation.valueQuantity?.comparator).toBeUndefined();
      expect(getEmaQuantityComparator(annotation.valueQuantity)).toBe("~");
      expect(annotation.valueQuantity?._value).toEqual(note.valueQuantity!._value);
      expect(annotation.valueQuantity?.extension).toContainEqual(note.valueQuantity!.extension![0]);
    }
    expect(output._code?.id).toBe("site-code");
    expect(output._display?.id).toBe("site-display");
    const argumentFields = saved.extension!.find(field => field.url === "action")!.extension!
      .find(field => field.url === "argument")!.extension!;
    expect(argumentFields.filter(field => field.url === "sourceCoding")).toEqual([]);
    const restored = parseInstructionGraphExtension([saved])!.actions[0].args[0].coding!;
    expect(getEmaQuantityComparator(restored.extension![0].valueQuantity)).toBe("~");
    expect(marker).toEqual(before);
  });
});


describe("combined native duration origins", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const query = { orderedAt: "2027-07-01T00:00:00Z", from: "2027-07-01T00:00:00Z", timeZone: "UTC", limit: 10 };
  for (const shape of ["quantity", "range", "independent-range"] as const)
    for (const anchored of [false, true])
      it.each([false, true])(`preserves ${shape} at its ${anchored ? "calendar" : "member"} origin (later member %s)`, shifted => {
        const quantity = { value: 5, unit: "d", code: "d", system: "http://unitsofmeasure.org" };
        const range = { low: { value: shape === "independent-range" ? 48 : 3,
          unit: shape === "independent-range" ? "h" : "d", code: shape === "independent-range" ? "h" : "d",
          system: "http://unitsofmeasure.org" }, high: quantity };
        const length = shape === "quantity" ? { quantity } : { range };
        const calendar = { start: "2027-07-05", end: "2027-07-20", id: "course-calendar" };
        const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
          kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
          ...(shifted ? { phaseStart: { anchor: "treatment-day-start", displacement: { value: 6, code: "d", unit: "d" } } } : {}),
          ...(anchored ? { anchoredLength: length } : {}),
          schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["09:00:00"],
            calendarWindow: calendar, ...(!anchored ? shape === "quantity" ? { courseLength: quantity } : { courseLengthRange: range } : {}),
          } },
        }] }] };
        const before = fresh(course), output = projectCanonicalCourse(course);
        const days = shifted ? anchored ? [7, 8, 9] : [7, 8, 9, 10, 11] : [5, 6, 7, 8, 9];
        const expected = days.map(day => `2027-07-${String(day).padStart(2, "0")}T09:00:00+00:00`);
        for (const input of [course, fresh(output.fhir), fresh(output.fhirNext)]) {
          expect(nextDueDoses(input, query)).toEqual(expected);
          expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 20, durationUnit: "d" }).totalUnits).toBe(days.length);
          const member = importCanonicalCourse(input).stages[0].administrations[0];
          expect(member.schedule?.recurrence?.calendarWindow).toEqual(calendar);
          if (anchored) expect(member.anchoredLength).toMatchObject(length);
          else {
            expect(member.anchoredLength).toBeUndefined();
            expect(shape === "quantity" ? member.schedule?.recurrence?.courseLength : member.schedule?.recurrence?.courseLengthRange)
              .toEqual(shape === "quantity" ? quantity : range);
          }
        }
        for (const row of [output.fhir[0], output.fhirNext.step[0].component[0]]) {
          const repeat = row.timing!.repeat!;
          expect([repeat.boundsDuration, repeat.boundsRange, repeat.boundsPeriod].filter(value => value !== undefined)).toHaveLength(1);
          expect(repeat.boundsPeriod).toEqual(calendar);
        }
        expect(course).toEqual(before);
      });
});


it("retains fresh external annotations on a member-relative duration alongside calendar bounds", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const durationUrl = "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration";
  const source: FhirR6DosageInstruction = { step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"],
      boundsPeriod: { start: "2027-07-05", end: "2027-07-20" } } },
    modifierExtension: [{ url: durationUrl, id: "duration-owner", extension: [
      { url: "courseLength", id: "member-length", valueQuantity: { value: 5, unit: "d", code: "d",
        system: "http://unitsofmeasure.org", _value: { id: "duration-value" },
        extension: [{ url: "urn:clinic:duration-note", valueString: "Member treatment duration" }] } },
      { url: "urn:clinic:window-note", valueString: "Retain the independent calendar window" },
    ] }],
  }] }] };
  const before = fresh(source), rows = fresh(toFhirR5Dosages(source)), reopened = toDosageDetails(rows);
  for (const row of [rows[0], reopened.step[0].component[0]])
    expect(row.modifierExtension!.find(field => field.url === durationUrl)).toEqual(source.step[0].component[0].modifierExtension![0]);
  for (const input of [source, rows, reopened]) {
    const member = importCanonicalCourse(input).stages[0].administrations[0];
    expect(member.anchoredLength).toBeUndefined();
    expect(member.schedule?.recurrence?.courseLength).toMatchObject({ value: 5, code: "d" });
  }
  expect(source).toEqual(before);
});


describe("coded timing offset carriers", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const url = "urn:ezmedicationinput:StructureDefinition:medication-timing-offset-exact";
  const query = { orderedAt: "2026-01-04T23:00:00Z", from: "2026-01-04T23:00:00Z", timeZone: "UTC",
    eventClock: { HS: "00:30" }, limit: 1 };

  it.each([[60, "2026-01-04T23:30:00+00:00"], [0, "2026-01-05T00:30:00+00:00"]] as const)
    ("keeps an authored %i-minute extension offset beside BED", (offset, expected) => {
      const marker: FhirExtension = { url, id: "authored-lead", valueInteger: offset,
        _valueInteger: { id: "lead-value" } };
      const source: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] },
          repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, extension: [marker] } } };
      const before = fresh(source), output = projectCanonicalCourse(importCanonicalCourse(fresh(source)));
      for (const row of [output.fhir[0], output.fhirNext.step[0].component[0],
        toFhirR5Dosages(fresh(output.fhirNext))[0]]) {
        expect(row.timing!.repeat!.offset).toBeUndefined();
        expect(row.timing!.repeat!.when).toBeUndefined();
        expect(row.timing!.repeat!.extension).toContainEqual(marker);
        expect(nextDueDoses(row, query)).toEqual([expected]);
        expect(importCanonicalCourse(row).stages[0].administrations[0].schedule?.recurrence?.offset).toBe(offset);
      }
      expect(source).toEqual(before);
    });

  it("writes a native code-derived offset through the existing exact carrier", () => {
    const native: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: {
        code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] },
        recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, offset: 60 },
      },
    }] }] };
    const before = fresh(native), output = projectCanonicalCourse(native);
    for (const row of [output.fhir[0], output.fhirNext.step[0].component[0]]) {
      expect(row.timing!.repeat!.offset).toBeUndefined();
      expect(row.timing!.repeat!.extension).toContainEqual({ url, valueInteger: 60 });
      expect(nextDueDoses(row, query)).toEqual(["2026-01-04T23:30:00+00:00"]);
    }
    expect(native).toEqual(before);
  });

  it("keeps an explicit event's authored core offset and annotations", () => {
    const source: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [EventTiming["Before Sleep"]], offset: 60, _offset: { id: "core-lead" } } } };
    const before = fresh(source), output = projectCanonicalCourse(importCanonicalCourse(source));
    for (const row of [output.fhir[0], output.fhirNext.step[0].component[0]]) {
      expect(row.timing!.repeat).toMatchObject(source.timing!.repeat!);
      expect(row.timing!.repeat!.extension?.some(field => field.url === url)).toBeFalsy();
      expect(nextDueDoses(row, query)).toEqual(["2026-01-04T23:30:00+00:00"]);
    }
    expect(source).toEqual(before);
  });
});


describe("review814 primary quantity and precise clock-window previews", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  it("keeps the labelled ordered dose with its guard before independent hold advice", () => {
    const note = { url: "urn:clinic:ordered-dose-note", valueString: "retain" };
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      method: { text: "Take" }, route: { text: "orally" },
      doseAndRate: [{ type: { coding: [{ code: "ordered" }] }, doseQuantity: { value: 1, unit: "tab" }, extension: [note] }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      condition: [conditionToR6({ kind: "measurement", name: "SBP", operation: "gt", value: 160 })],
      additionalInstruction: [{ text: "Otherwise hold." }]
    }] }] };
    const before = JSON.stringify(input);
    const course = importCanonicalCourse(input);
    const expected = {
      en: "Take the medication orally once daily; Dose (ordered): 1 tablet only if SBP > 160. Otherwise hold.",
      th: "รับประทานทางปาก วันละครั้ง; ขนาดยา (ordered): ครั้งละ 1 เม็ด เฉพาะเมื่อ SBP > 160. Otherwise hold."
    };
    for (const view of [course, fresh(toFhirR5Dosages(input)), fresh(input)]) {
      for (const locale of ["en", "th"] as const)
        expect(formatSig(view, "long", { locale, realizationMode: "normalized" })).toBe(expected[locale]);
      const row = projectCanonicalCourse(importCanonicalCourse(view)).fhir[0];
      expect(row.doseAndRate![0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(row.doseAndRate![0].extension).toContainEqual(note);
      expect(row.additionalInstruction![0].text).toBe("Otherwise hold.");
      expect(getDosageCondition(row)).toMatchObject({ kind: "measurement", name: "SBP", operation: "gt", value: 160 });
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps a current labelled amount guarded when no compact head or cadence exists", () => {
    const source = "Take 1 tablet.";
    const predicate: MedicationCondition = { kind: "measurement", name: "SBP", operation: "gt", value: 160, text: "SBP > 160" };
    const note = { url: "urn:clinic:ordered-dose-note", valueString: "retain" };
    const row: FhirDosage = { text: source,
      doseAndRate: [{ type: { coding: [{ code: "ordered" }] }, doseQuantity: { value: 1, unit: "tab" }, extension: [note] }],
      additionalInstruction: [{ text: "Otherwise hold." }]
    };
    setDosageCondition(row, predicate);
    const before = JSON.stringify(row), course = importCanonicalCourse([row]);
    const expected = {
      en: "Current: Use; Dose (ordered): 1 tablet only if SBP > 160. Otherwise hold; original directions: Take 1 tablet.",
      th: "ปัจจุบัน: ใช้; ขนาดยา (ordered): ครั้งละ 1 เม็ด เฉพาะเมื่อ SBP > 160. Otherwise hold; ข้อความเดิม: Take 1 tablet."
    };
    for (const view of [course, fresh([row]), fresh(projectCanonicalCourse(course).fhirNext)]) {
      const snapshot = JSON.stringify(view);
      for (const locale of ["en", "th"] as const)
        expect(formatSig(view, "long", { locale, realizationMode: "normalized" })).toBe(expected[locale]);
      const retained = importCanonicalCourse(view).stages[0].administrations[0];
      expect(retained.predicate).toEqual(predicate);
      expect(retained.text).toBe(source);
      expect(retained.amounts?.[0]).toMatchObject({ role: { coding: [{ code: "ordered" }] }, quantity: { value: 1, unit: "tab" } });
      const projected = projectCanonicalCourse(importCanonicalCourse(view)).fhir[0];
      expect(projected.doseAndRate![0].extension).toContainEqual(note);
      expect(projected.additionalInstruction).toEqual(row.additionalInstruction);
      expect(JSON.stringify(view)).toBe(snapshot);
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([false, true])("retains nonzero seconds at both clock-window bounds, inclusive=%s", inclusive => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: { recurrence: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        clockWindow: { start: "08:00:30", end: "20:00:45", endInclusive: inclusive }
      } }
    }] }] };
    const r6 = courseToR6(course), before = JSON.stringify(course);
    for (const view of [course, fresh(toFhirR5Dosages(r6)), fresh(r6)]) {
      const saved = importCanonicalCourse(view).stages[0].administrations[0].schedule!.recurrence!.clockWindow;
      expect(saved).toEqual({ start: "08:00:30", end: "20:00:45", endInclusive: inclusive });
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(view, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "between 08:00:30 and 20:00:45" : "08:00:30–20:00:45");
        if (!inclusive) expect(text).toContain(locale === "en" ? "end excluded" : "ไม่รวมเวลาสิ้นสุด");
      }
    }
    expect(JSON.stringify(course)).toBe(before);
  });
});


describe("current coded identity and typed FHIR annotation boundaries", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const query = { orderedAt: "2027-01-01T08:00:00Z", from: "2027-01-01T08:00:00Z", timeZone: "UTC", limit: 2 };

  it.each([undefined, "Systolic blood pressure"])("keeps the observation key for a LOINC-first condition with display %s", display => {
    const condition = { code: { coding: [{ system: "http://loinc.org", code: "8480-6", ...(display ? { display } : {}) }] },
      operation: "gt" as const, valueQuantity: { value: 160, unit: "mmHg" } };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ condition: [condition],
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: daily }
    }] }] };
    const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
    for (const value of [importCanonicalCourse(input), rows, fresh(toDosageDetails(rows))]) {
      const predicate = importCanonicalCourse(value).stages[0].administrations[0].predicate!;
      expect(predicate).toMatchObject({ kind: "measurement", name: "sbp", text: display ?? "sbp", value: 160 });
      expect(evaluateMedicationCondition(predicate, { sbp: 170 })).toBe(true);
      expect(evaluateMedicationCondition(predicate, { sbp: 160 })).toBe(false);
      expect(nextDueDoses(value, { ...query, evaluateCondition: p => evaluateMedicationCondition(p, { sbp: 170 }) }))
        .toEqual(["2027-01-01T08:00:00+00:00", "2027-01-02T08:00:00+00:00"]);
      expect(courseToR6(importCanonicalCourse(value)).step[0].component[0].condition).toEqual([condition]);
    }
    expect(input).toEqual(before);
  });

  it.each([false, true])("retains independently authored site markers at both locations (same content %s)", same => {
    const marker = (id: string): FhirR6Extension => ({ id, url: BODY_SITE_SPATIAL_RELATION_EXTENSION_URL,
      extension: [{ url: "relationText", valueString: "around" },
        { url: "target", valueCodeableConcept: { text: "right eye" } },
        { url: "urn:clinic:spatial-note", valueString: "Keep authored location" }] });
    const wrapper = marker("wrapper-marker"), concept = marker(same ? "wrapper-marker" : "concept-marker");
    const site = { id: "authored-site", extension: [wrapper], concept: { text: "skin", extension: [concept] } };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ site,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }]
    }] }] };
    const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
    expect(rows[0].site?.extension).toEqual([concept]);
    expect(toDosageDetails(rows).step[0].component[0].site).toEqual(site);
    expect(courseToR6(importCanonicalCourse(rows)).step[0].component[0].site).toEqual(site);
    expect(input).toEqual(before);
  });

  it.each(["valueString", "valueCode", "annotation only"] as const)("retains a compact safety primitive companion from %s", spelling => {
    const companion = { id: "response-label", extension: [{ url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
      { url: "lang", valueCode: "th" }, { url: "content", valueString: "ติดต่อคลินิก" }
    ] }] };
    const field = spelling === "valueCode" ? "valueCode" : "valueString";
    const action: FhirExtension = { url: "ifExceeded", ...(spelling === "annotation only" ? {} : { [field]: "Call the clinic" }),
      [`_${field}`]: companion };
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [
      { url: "rowIndex", valueInteger: 0 }, { url: "sequence", valueInteger: 1 },
      { url: "stepCount", valueInteger: 1 }, { url: "context", valueString: "aa9cbe44f9ef2bf2" },
      { url: "contextRequired", valueBoolean: true }, { url: "countScope", valueCode: "step" },
      { url: "course", extension: [{ url: "safety", extension: [action] }] }
    ] };
    const input: FhirDosage[] = [{ sequence: 1, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: daily }, modifierExtension: [marker] }];
    const before = fresh(input), retained = decodeR5RetainedFields(marker);
    expect(retained.course?.safety?._ifExceeded).toEqual(companion);
    expect(retained.course?.safety?.ifExceeded).toBe(spelling === "annotation only" ? undefined : "Call the clinic");
    const rebuilt = encodeR5RetainedFields(retained);
    const safety = rebuilt.find(child => child.url === "course")!.extension!.find(child => child.url === "safety")!;
    expect(safety.extension!.find(child => child.url === "ifExceeded")).toEqual({ url: "ifExceeded",
      ...(spelling === "annotation only" ? {} : { valueString: "Call the clinic" }), _valueString: companion });
    const native = importCanonicalCourse(fresh(input));
    expect(courseToR6(native).safety?._ifExceeded).toEqual(companion);
    expect(toDosageDetails(fresh(projectCanonicalCourse(native).fhir)).safety?._ifExceeded).toEqual(companion);
    expect(input).toEqual(before);
  });

  it.each([3, 2])( "evaluates a strict administration ceiling of %s against a fixed two-tablet dose", ceiling => {
    const input: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      timing: { repeat: daily }, maxDosePerAdministration: { value: ceiling, unit: "tab", comparator: "<" }
    }];
    const before = fresh(input), native = importCanonicalCourse(input), projected = projectCanonicalCourse(native);
    for (const value of [native, fresh(projected.fhir), fresh(projected.fhirNext)]) {
      const result = calculateTotalUnits({ dosage: value, ...query, durationValue: 2, durationUnit: "d" });
      expect(result.totalUnits).toBe(4);
      if (ceiling === 3) expect(result.explanation ?? "").not.toContain("unevaluable maximum-dose");
      else expect(result.explanation).toContain("unevaluable maximum-dose");
      expect(importCanonicalCourse(value).stages[0].administrations[0].amounts?.[0].quantity?.value).toBe(2);
    }
    expect(input).toEqual(before);
  });

  it.each(["Reference", "CodeableReference"] as const)("bridges quantity annotations inside a %s", shape => {
    const estimate: FhirR6Extension = { url: "urn:clinic:reference-estimate", valueQuantity: { value: 2, unit: "g", comparator: "~",
      _value: { id: "estimated-value" }, extension: [{ url: "urn:clinic:annotation", valueString: "retain" }] } };
    const reference = { id: "authored-reference", reference: "BodyStructure/skin", extension: [estimate],
      _display: { id: "reference-display", extension: [estimate] } };
    const annotation: FhirR6Extension = { url: "urn:clinic:target", ...(shape === "Reference"
      ? { valueReference: reference } : { valueCodeableReference: { id: "target-wrapper", reference } }) };
    const before = fresh(annotation), encoded = quantityAnnotationExtensions([annotation], "r5")[0];
    const wireReference = shape === "Reference" ? encoded.valueReference! : encoded.valueCodeableReference!.reference!;
    for (const item of [wireReference.extension![0], wireReference._display!.extension![0]]) {
      expect(item.valueQuantity?.comparator).toBeUndefined();
      expect(getEmaQuantityComparator(item.valueQuantity)).toBe("~");
      expect(item.valueQuantity?._value).toEqual({ id: "estimated-value" });
    }
    expect(quantityAnnotationExtensions([fresh(encoded)], "r6")[0]).toEqual(annotation);
    const input: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: {
      value: 1, unit: "tab", extension: [annotation]
    } }] }] }] };
    const rows = fresh(toFhirR5Dosages(input));
    expect(rows[0].doseAndRate![0].doseQuantity!.extension).toEqual([encoded]);
    expect(toDosageDetails(rows).step[0].component[0].doseAndRate![0].doseQuantity!.extension).toEqual([annotation]);
    expect(annotation).toEqual(before);
  });

  it.each([["U{lipase}", "U"], ["mg{drug}", "mg"]])( "keeps case-sensitive UCUM identity for %s", (code, expected) => {
    const quantity = { value: 10, system: "http://unitsofmeasure.org", code };
    const condition = { code: { text: "lipase" }, operation: "gt" as const, valueQuantity: quantity };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ condition: [condition],
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const before = fresh(input);
    expect(getDoseQuantityUnit(quantity, false)).toBe(expected);
    for (const value of [importCanonicalCourse(input), fresh(toFhirR5Dosages(input)), fresh(input)]) {
      expect(importCanonicalCourse(value).stages[0].administrations[0].predicate)
        .toMatchObject({ kind: "measurement", name: "lipase", unit: expected });
      expect(courseToR6(importCanonicalCourse(value)).step[0].component[0].condition).toEqual([condition]);
    }
    expect(input).toEqual(before);
  });
});


it("keeps dose-limit primitive companions in safety and legal metadata on the R5 Ratio", () => {
  const limit: FhirR6DoseLimit = { id: "period-limit", scope: "period", _scope: { id: "period-scope" },
    text: "Daily maximum", _text: { id: "maximum-label" },
    extension: [{ url: "urn:clinic:limit-note", valueString: "Retain legal Ratio metadata" }],
    valueQuantity: { value: 2, unit: "tab", _value: { id: "cap-magnitude" } },
    period: { value: 1, unit: "d", code: "d" } };
  const input: FhirR6DosageInstruction = { step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], safety: { doseLimit: [limit] }
  }] }] };
  const before = JSON.stringify(input), rows = JSON.parse(JSON.stringify(toFhirR5Dosages(input))) as FhirDosage[];
  expect(rows[0].maxDosePerPeriod![0]).toEqual({ id: limit.id, extension: limit.extension,
    numerator: limit.valueQuantity, denominator: limit.period });
  expect(toDosageDetails(rows).step[0].component[0].safety?.doseLimit).toEqual([limit]);
  expect(JSON.stringify(input)).toBe(before);
});


it.each(["Reference", "CodeableReference"] as const)("preserves typed Identifier annotations within a %s", shape => {
  type Reference = NonNullable<FhirR6Extension["valueReference"]>;
  const estimate: FhirR6Extension = { url: "urn:clinic:identifier-estimate", valueQuantity: {
    value: 2, unit: "cm2", comparator: "~", _value: { id: "estimated-area" }
  } };
  const primitive = { id: "authored-primitive", extension: [estimate] };
  const reference: Reference = { id: "anatomical-reference", reference: "BodyStructure/skin", identifier: {
    id: "local-identifier", system: "urn:clinic:body-structure", value: "skin-1", use: "usual",
    extension: [estimate], _use: primitive, _system: primitive, _value: primitive,
    type: { text: "Local body site", extension: [estimate], _text: primitive, coding: [{
      system: "urn:clinic:identifier-kind", code: "site", extension: [estimate], _code: primitive, _display: primitive
    }] },
    period: { start: "2027-01-01", end: "2028-01-01", extension: [estimate], _start: primitive, _end: primitive },
    assigner: { reference: "Organization/clinic", extension: [estimate], _reference: primitive, _display: primitive }
  } };
  const annotation: FhirR6Extension = { url: "urn:clinic:anatomical-source", ...(shape === "Reference"
    ? { valueReference: reference } : { valueCodeableReference: { reference } }) };
  const input: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: {
    value: 1, unit: "g", extension: [annotation]
  } }] }] }] };
  const before = JSON.stringify(input), rows = toFhirR5Dosages(input);
  const wireAnnotation = rows[0].doseAndRate![0].doseQuantity!.extension![0];
  const wireReference = (shape === "Reference" ? wireAnnotation.valueReference : wireAnnotation.valueCodeableReference!.reference)!;
  const identifier = wireReference.identifier!;
  const annotations = [identifier.extension![0], identifier._use!.extension![0], identifier._system!.extension![0],
    identifier._value!.extension![0], identifier.type!.extension![0], identifier.type!._text!.extension![0],
    identifier.type!.coding![0].extension![0], identifier.type!.coding![0]._code!.extension![0],
    identifier.type!.coding![0]._display!.extension![0], identifier.period!.extension![0],
    identifier.period!._start!.extension![0], identifier.period!._end!.extension![0],
    identifier.assigner!.extension![0], identifier.assigner!._reference!.extension![0], identifier.assigner!._display!.extension![0]];
  expect(annotations).toHaveLength(15);
  for (const current of annotations) {
    expect(current.valueQuantity?.comparator).toBeUndefined();
    expect(getEmaQuantityComparator(current.valueQuantity)).toBe("~");
    expect(current.valueQuantity).toMatchObject({ value: 2, unit: "cm2", _value: { id: "estimated-area" } });
  }
  const restored = toDosageDetails(JSON.parse(JSON.stringify(rows)));
  expect(restored.step[0].component[0].doseAndRate![0].doseQuantity!.extension).toEqual([annotation]);
  expect(toFhirR5Dosages(JSON.parse(JSON.stringify(restored)))).toEqual(rows);
  expect(JSON.stringify(input)).toBe(before);
});

describe("unchanged condition bridge cycles", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([false, true])("keeps an unchanged coded measurement stable with unit=%s", hasUnit => {
    const condition = {
      id: "current-pressure-condition",
      code: { coding: [
        { system: "urn:clinic:observation", code: "pressure", display: "Blood pressure reading" },
        { system: "http://loinc.org", code: "8480-6", display: "Systolic blood pressure" }
      ] },
      operation: "gt" as const,
      valueQuantity: { value: 160, ...(hasUnit ? { unit: "mmHg" } : {}) },
      extension: [{ url: "urn:clinic:condition-note", valueString: "Use the recorded measurement" }]
    };
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      condition: [condition], doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } }
    }] }] };
    const before = fresh(input), first = fresh(toFhirR5Dosages(input));
    let rows = first;
    for (let cycle = 0; cycle < 3; cycle++) {
      const restored = toDosageDetails(fresh(rows));
      const predicate = importCanonicalCourse(restored).stages[0].administrations[0].predicate!;
      expect(predicate).toMatchObject({
        kind: "measurement", name: "sbp", operation: "gt", value: 160, text: "Blood pressure reading"
      });
      expect("unit" in predicate ? predicate.unit : undefined).toBe(hasUnit ? "mmHg" : undefined);
      expect(evaluateMedicationCondition(predicate, { sbp: 170 })).toBe(true);
      expect(evaluateMedicationCondition(predicate, { sbp: 160 })).toBe(false);
      expect(restored.step[0].component[0].condition).toEqual([condition]);
      expect(restored.extension?.filter(item => item.url.endsWith("medication-course-reconciliation-source")) ?? []).toEqual([]);
      const next = fresh(toFhirR5Dosages(restored));
      expect(next).toEqual(first);
      rows = next;
    }
    expect(input).toEqual(before);
  });
});


describe("review d41 current primary and event offset previews", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([1, 2])("keeps %s labelled amounts before an independent warning within a bounded week", count => {
    const graph: CanonicalInstructionGraph = { sourceText: "Do not crush", sourceLocale: "en",
      actions: parseInstructionActions("Do not crush") };
    const note: FhirExtension = { url: "urn:clinic:current-note", valueString: "retain" };
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [
        { type: { coding: [{ code: "ordered" }] }, doseQuantity: { value: 1, unit: "tab" } },
        { type: { coding: [{ code: "calculated" }] }, doseQuantity: { value: 2, unit: "tab" } }
      ],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Week,
        endOffset: { value: 1, unit: "d" } } },
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 4, unit: "tab" }, period: { value: 1, unit: "d" } }] },
      extension: [buildInstructionGraphExtension(graph)!, note]
    }] }] };
    source.step[0].component[0].doseAndRate = source.step[0].component[0].doseAndRate!.slice(0, count);
    const before = fresh(source), native = importCanonicalCourse(source), projected = projectCanonicalCourse(native);
    for (const input of [native, fresh(projected.fhir), fresh(projected.fhirNext)]) {
      const original = fresh(input);
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        const ordered = locale === "en" ? "Dose (ordered): 1 tablet" : "ขนาดยา (ordered): ครั้งละ 1 เม็ด";
        const calculated = locale === "en" ? "Dose (calculated): 2 tablets" : "ขนาดยา (calculated): ครั้งละ 2 เม็ด";
        const warning = locale === "en" ? "Do not crush" : "ห้ามบด";
        expect(text).toContain(ordered);
        if (count === 2) expect(text).toContain(calculated);
        else expect(text).not.toContain(calculated);
        expect(text.split(warning)).toHaveLength(2);
        expect(text.indexOf(ordered)).toBeLessThan(text.indexOf(warning));
        if (count === 2) expect(text.indexOf(calculated)).toBeLessThan(text.indexOf(warning));
        expect(text).toContain("4 tab / 1 d");
        expect(text).toContain(locale === "en" ? "1 administration per 1 week" : "ให้ยา 1 ครั้งต่อช่วง 1 สัปดาห์");
        expect(text).toContain(locale === "en" ? "No doses during the final 1 day" : "งดยาในช่วง 1 วันสุดท้าย");
      }
      const current = importCanonicalCourse(input), row = projectCanonicalCourse(current).fhirNext.step[0].component[0];
      expect(row.doseAndRate).toEqual(source.step[0].component[0].doseAndRate);
      expect(row.timing?.repeat).toMatchObject(source.step[0].component[0].timing!.repeat!);
      expect(row.safety?.doseLimit).toEqual(source.step[0].component[0].safety!.doseLimit);
      expect(row.extension).toContainEqual(note);
      expect(input).toEqual(original);
    }
    expect(source).toEqual(before);
  });

  it("keeps both event-offset bounds in a code-only BED short preview", () => {
    const source: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: {
        code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] },
        recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, offsetMin: 15, offsetMax: 30 }
      }
    }] }] };
    const before = fresh(source), projected = projectCanonicalCourse(source);
    for (const input of [source, fresh(projected.fhir), fresh(projected.fhirNext)]) {
      const original = fresh(input);
      expect(formatSig(input, "short", { locale: "en", realizationMode: "normalized" })).toContain("15–30 minutes at bedtime");
      expect(formatSig(input, "short", { locale: "th", realizationMode: "normalized" })).toContain("ก่อนนอน 15–30 นาที");
      const current = importCanonicalCourse(input).stages[0].administrations[0];
      expect(current.schedule?.recurrence).toMatchObject({ offsetMin: 15, offsetMax: 30 });
      expect(current.schedule?.recurrence?.anchors).toBeUndefined();
      expect(current.schedule?.code).toEqual(source.stages[0].administrations[0].schedule!.code);
      const output = projectCanonicalCourse(importCanonicalCourse(input));
      expect(output.fhir[0].timing?.repeat?.when).toBeUndefined();
      expect(output.fhirNext.step[0].component[0].timing?.repeat?.when).toBeUndefined();
      expect(input).toEqual(original);
    }
    expect(source).toEqual(before);
  });
});


describe("current FHIR annotation and coding ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([["89644007", "left ear canal", "ช่องหูซ้าย"], ["25577004", "right ear canal", "ช่องหูขวา"]])(
    "combines an unqualified canal with compatible coded side %s", (code, english, thai) => {
      const site = { concept: { text: "ear canal", coding: [{ system: "http://snomed.info/sct", code }],
        extension: [{ url: "urn:clinic:site-detail", valueString: "retain" }] } };
      const input: FhirR6DosageInstruction = { step: [{ component: [{ site,
        doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }] }] }] };
      const before = fresh(input), native = importCanonicalCourse(input), projected = projectCanonicalCourse(native);
      for (const value of [native, fresh(projected.fhir), fresh(projected.fhirNext)]) {
        expect(formatSig(value, "long", { locale: "en", realizationMode: "normalized" })).toContain(english);
        expect(formatSig(value, "long", { locale: "th", realizationMode: "normalized" })).toContain(thai);
        expect(courseToR6(importCanonicalCourse(value)).step[0].component[0].site).toEqual(site);
      }
      expect(input).toEqual(before);
    }
  );

  it.each([undefined, 1])("retains a compact period maximum and its unit with minimum %s", period => {
    const clause = canonicalFromFhir({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] });
    clause.schedule = { period, periodMax: 3, periodUnit: FhirPeriodUnit.Day };
    const before = fresh(clause), row = canonicalToFhir(clause);
    expect(row.timing?.repeat).toMatchObject({ periodMax: 3, periodUnit: FhirPeriodUnit.Day });
    expect(row.timing?.repeat?.period).toBe(period);
    expect(canonicalFromFhir(fresh(row)).schedule).toMatchObject({ periodMax: 3, periodUnit: FhirPeriodUnit.Day });
    expect(clause).toEqual(before);
  });

  it("converts nested Quantity operators inside direct Period annotations", () => {
    const estimate: FhirR6Extension = { url: "urn:clinic:period-estimate", valueQuantity: {
      value: 2, unit: "cm2", comparator: "~", _value: { id: "estimated-area" }
    } };
    const period = { id: "authored-period", start: "2027-01-01", end: "2028-01-01", extension: [estimate],
      _start: { id: "start-note", extension: [estimate] }, _end: { id: "end-note", extension: [estimate] } };
    const annotation: FhirR6Extension = { url: "urn:clinic:observed-period", valuePeriod: period };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: {
      value: 1, unit: "g", _value: { id: "dose-primitive", extension: [annotation] }
    } }] }] }] };
    const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
    const current = rows[0].doseAndRate![0].doseQuantity!._value!.extension![0].valuePeriod!;
    expect(current).toMatchObject({ id: period.id, start: period.start, end: period.end });
    for (const item of [current.extension![0], current._start!.extension![0], current._end!.extension![0]]) {
      expect(item.valueQuantity?.comparator).toBeUndefined();
      expect(getEmaQuantityComparator(item.valueQuantity)).toBe("~");
      expect(item.valueQuantity?._value).toEqual({ id: "estimated-area" });
    }
    expect(toDosageDetails(rows).step[0].component[0].doseAndRate![0].doseQuantity!._value)
      .toEqual(input.step[0].component[0].doseAndRate![0].doseQuantity!._value);
    const plain: FhirR6Extension = { url: "urn:clinic:plain-period", valuePeriod: { start: period.start, end: period.end } };
    expect(quantityAnnotationExtensions([plain], "r5")[0]).toBe(plain);
    expect(input).toEqual(before);
  });

  it.each([undefined, "123456789"])("finds a recognized route after an unrecognized Coding %s", code => {
    const route = { coding: [
      { id: "route-source", system: "http://snomed.info/sct", code, _code: { id: "unavailable-code" } },
      { system: "http://snomed.info/sct", code: "78421000", display: "Intramuscular route" }
    ] };
    const input: FhirDosage = { route, doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }] };
    const before = fresh(input);
    expect(canonicalFromFhir(input).route?.code).toBe(RouteCode["Intramuscular route"]);
    expect(parserStateFromFhir(input).primaryClause.route?.code).toBe(RouteCode["Intramuscular route"]);
    expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("intramuscular");
    const native = importCanonicalCourse(input), projected = projectCanonicalCourse(native);
    expect(projected.fhir[0].route).toEqual(route);
    expect(projected.fhirNext.step[0].component[0].route).toEqual(route);
    expect(input).toEqual(before);
  });
});


it("applies an annotated UCUM drop ceiling to maximum planned supply", () => {
  const ucum = "http://unitsofmeasure.org";
  const dose = { value: 1, system: ucum, code: "[drp]", _code: { id: "authored-dose-unit" } };
  const maximum = { numerator: { value: 1, system: ucum, code: "[drp]{ophthalmic}", _code: { id: "authored-cap-unit" } },
    denominator: { value: 24, unit: "h", system: ucum, code: "h" } };
  const input: FhirDosage = { asNeeded: true, doseAndRate: [{ doseQuantity: dose }],
    timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00", "20:00:00"] } },
    maxDosePerPeriod: [maximum] };
  const before = JSON.stringify(input), native = importCanonicalCourse(input), projected = projectCanonicalCourse(native);
  for (const value of [native, JSON.parse(JSON.stringify(projected.fhir)), JSON.parse(JSON.stringify(projected.fhirNext))]) {
    const total = calculateTotalUnits({ dosage: value, from: "2026-01-01T00:00:00Z", timeZone: "UTC",
      durationValue: 1, durationUnit: FhirPeriodUnit.Day });
    expect(total.totalUnits).toBe(1);
    expect(total.quantityKind).toBe("maximum");
    const row = projectCanonicalCourse(importCanonicalCourse(value)).fhir[0];
    expect(row.doseAndRate![0].doseQuantity).toEqual(dose);
    expect(row.maxDosePerPeriod).toEqual([maximum]);
  }
  expect(JSON.stringify(input)).toBe(before);
});


describe("current appointment and ordered-dose previews", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([
    ["until the next appointment at noon", "ตอนเที่ยง"],
    ["until the next appointment at 8 AM", "เวลา 08:00"],
    ["until 8 AM the next appointment", "เวลา 08:00"],
    ["until the next appointment", "นัดครั้งถัดไป"]
  ])("localizes the typed ending without creating recurring clocks: %s", (ending, thaiTime) => {
    const source = "Take 1 tablet daily " + ending, parsed = parseSig(source);
    const instruction = parsed.meta.canonical.clauses[0].additionalInstructions![0];
    expect(instruction.coding?.code).toBe("1287351008");
    expect(instruction.text).toBe(ending === "until the next appointment" ? "Until next appointment" : ending);
    expect(instruction.evidence?.[0].spans?.[0].text).toBe(ending);
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      const before = fresh(input), member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(member.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(member.schedule?.recurrence?.clocks).toBeUndefined();
      expect(member.schedule?.recurrence?.calendarWindow).toBeUndefined();
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain(thaiTime);
      expect(thai).not.toMatch(/\bnoon\b|\bAM\b/);
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(english.toLowerCase()).toContain(ending === "until the next appointment" ? "until next appointment" : ending.toLowerCase());
      expect(input).toEqual(before);
    }
  });

  it.each([true, false])("keeps an ordered shampoo amount without other compact body fields: %s", hasDose => {
    const method = { text: "Shampoo", coding: [{ system: "http://snomed.info/sct", code: "420606003", display: "Shampoo" }] };
    const amount = { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/dose-rate-type", code: "ordered" }] },
      doseQuantity: { value: 5, unit: "mL" } };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ method,
      ...(hasDose ? { doseAndRate: [amount] } : {})
    }] }] };
    const before = fresh(source), native = importCanonicalCourse(source), projection = projectCanonicalCourse(native);
    for (const input of [native, fresh(projection.fhir), fresh(projection.fhirNext)]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(english).toContain("Shampoo");
      expect(thai).toContain("สระผม");
      if (hasDose) {
        expect(english).toContain("5 mL");
        expect(thai).toContain("5 มิลลิลิตร");
      } else {
        expect(english).toBe("Shampoo.");
        expect(thai).not.toContain("5");
      }
      const current = courseToR6(importCanonicalCourse(input)).step[0].component[0];
      expect(current.method).toEqual(method);
      expect(current.doseAndRate).toEqual(hasDose ? [amount] : undefined);
    }
    expect(source).toEqual(before);
  });
});


describe("current prohibition and recurring Time ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const views = (graph: CanonicalInstructionGraph) => {
    const wire: FhirR6DosageInstruction = { step: [{ component: [{ extension: [buildInstructionGraphExtension(graph)!] }] }] };
    const native = importCanonicalCourse(wire), projected = projectCanonicalCourse(native);
    return [native, fresh(projected.fhir), fresh(projected.fhirNext)];
  };
  it.each([false, true])("keeps inherited Time separate from a prohibition target with Site=%s", hasSite => {
    const source = hasSite ? "Do not apply patch on left arm at bedtime" : "Do not take the tablet at bedtime";
    const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en", actions: [{
      force: AdviceForce.Instruction, polarity: AdvicePolarity.Negate, relation: AdviceRelation.On,
      predicate: { lemma: hasSite ? "apply" : "take", semanticClass: "administration" },
      args: [
        { role: AdviceArgumentRole.Object, text: hasSite ? "patch" : "the tablet", i18n: { th: hasSite ? "แผ่นยา" : "ยาเม็ด" } },
        ...(hasSite ? [{ role: AdviceArgumentRole.Site, text: "left arm", relation: AdviceRelation.On, i18n: { th: "แขนซ้าย" } }] : []),
        { role: AdviceArgumentRole.Time, text: "bedtime", normalized: "HS" }
      ], sourceText: source, span: { start: 0, end: source.length }
    }] };
    const before = fresh(graph);
    const texts = [
      [realizeInstructionGraph(graph, "en")!, realizeInstructionGraph(graph, "th")!],
      ...views(graph).map(input => [formatSig(input, "long", { locale: "en", realizationMode: "normalized" }),
        formatSig(input, "long", { locale: "th", realizationMode: "normalized" })])
    ];
    for (const [english, thai] of texts) {
      expect(english).toContain(hasSite ? "apply patch on left arm" : "take the tablet");
      expect(english).toContain("at bedtime");
      expect(english).not.toContain("on the tablet");
      expect(thai).toContain(hasSite ? "บนแขนซ้าย" : "ยาเม็ด");
      expect(thai).toContain("ก่อนนอน");
      expect(thai).not.toContain("บนยาเม็ด");
    }
    expect(graph).toEqual(before);
  });

  it.each(["Monday", "Mondays"])("retains inherited On and the selected weekday number: %s", weekday => {
    const source = "Withhold medication on " + weekday;
    const graph: CanonicalInstructionGraph = { sourceText: source, sourceLocale: "en", actions: [{
      force: AdviceForce.Instruction, relation: AdviceRelation.On,
      predicate: { lemma: "withhold-administration", semanticClass: "administration" },
      args: [{ role: AdviceArgumentRole.Object, text: "medication", i18n: { th: "ยา" } },
        { role: AdviceArgumentRole.Time, text: weekday, normalized: "Monday" }],
      sourceText: source, span: { start: 0, end: source.length }
    }] };
    const before = fresh(graph), texts = [realizeInstructionGraph(graph, "en")!,
      ...views(graph).map(input => formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))];
    for (const text of texts) {
      expect(text).toContain("on " + weekday);
      if (weekday === "Monday") expect(text).not.toContain("Mondays");
    }
    expect(graph).toEqual(before);
  });
});

describe("current annotated unit ceiling identity", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const ucum = "http://unitsofmeasure.org";

  it.each(["administration", "lifetime"] as const)(
    "keeps the tighter annotated body-surface %s ceiling when an absolute limit intervenes", scope => {
      const loose = { id: "body-surface-loose", value: 200, unit: "mg/m2", system: ucum, code: "mg/m2",
        _value: { id: "authored-loose-limit" } };
      const tight = { id: "body-surface-tight", value: 150, unit: "mg per square metre",
        system: ucum, code: "mg{active}/m2",
        extension: [{ url: "urn:clinic:quantity-note", valueString: "Keep the supplied quantity" }] };
      const absolute = { id: "absolute-limit", value: 400, unit: "mg", system: ucum, code: "mg",
        _code: { id: "authored-absolute-unit" } };
      const orders = [[loose, tight], [tight, loose], [loose, absolute, tight],
        [tight, absolute, loose], [absolute, loose, tight], [absolute, tight, loose]];
      for (const quantities of orders) {
        const input: FhirR6DosageInstruction = {
          renderedInstruction: "Administer 100 mg/m2 with the supplied body-surface and absolute limits.",
          step: [{ component: [{
            doseAndRate: [{ doseQuantity: { value: 100, unit: "mg/m2", system: ucum, code: "mg/m2" } }],
            safety: { doseLimit: quantities.map(valueQuantity => ({ scope, valueQuantity })) }
          }] }]
        };
        const before = fresh(input), native = importCanonicalCourse(input), projected = projectCanonicalCourse(native);
        for (const value of [native, fresh(projected.fhir), fresh(projected.fhirNext)]) {
          const current = projectCanonicalCourse(importCanonicalCourse(value));
          const row = current.fhir[0];
          expect(scope === "administration" ? row.maxDosePerAdministration : row.maxDosePerLifetime).toEqual(tight);
          expect(current.fhirNext.step[0].component[0].safety?.doseLimit).toEqual(input.step[0].component[0].safety!.doseLimit);
          expect(current.fhirNext.step[0].component[0].doseAndRate).toEqual(input.step[0].component[0].doseAndRate);
          expect(current.fhirNext.renderedInstruction).toBe(input.renderedInstruction);
        }
        expect(input).toEqual(before);
      }
    }
  );

  it.each([
    ["foreign coding", { system: ucum, code: "mg/m2" }, { system: "urn:clinic:unit", code: "mg/m2" }],
    ["UCUM case", { system: ucum, code: "mU" }, { system: ucum, code: "MU" }],
    ["annotation-only counts", { system: ucum, code: "{puff}" }, { system: ucum, code: "{dose}" }]
  ] as const)("keeps distinct %s limits in their own coded group", (_label, doseUnit, otherUnit) => {
    const compatible = { value: 3, ...doseUnit, id: "compatible-limit" };
    const independent = { value: 1, ...otherUnit, id: "independent-limit" };
    for (const quantities of [[compatible, independent], [independent, compatible]]) {
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 2, ...doseUnit } }],
        safety: { doseLimit: quantities.map(valueQuantity => ({ scope: "administration", valueQuantity })) }
      }] }] };
      const before = fresh(input), rows = toFhirR5Dosages(input);
      expect(rows[0].maxDosePerAdministration).toEqual(compatible);
      expect(toDosageDetails(fresh(rows)).step[0].component[0].safety?.doseLimit)
        .toEqual(input.step[0].component[0].safety!.doseLimit);
      expect(input).toEqual(before);
    }
  });
});


describe("current coded laterality with registered anatomical refinements", () => {
  it.each([
    { name: "right eyelid", siteText: "eyelid", base: "80243003", side: "24028007",
      source: "Apply 1 g to the right eyelid daily.", method: "Apply", unit: "g", inputForm: "r5",
      en: ["right", "eyelid"], th: ["ขวา", "เปลือกตา"] },
    { name: "right lower eyelid", siteText: "lower eyelid", base: "80243003", side: "24028007",
      source: "Apply 1 g to the right lower eyelid daily.", method: "Apply", unit: "g", inputForm: "r6",
      en: ["right", "lower eyelid"], th: ["ขวา", "เปลือกตา", "ส่วนล่าง"] },
    { name: "left lower eyelid alias", siteText: "lower lid", base: "80243003", side: "7771000",
      source: "Apply 1 g to the left lower lid daily.", method: "Apply", unit: "g", inputForm: "r5",
      en: ["left", "lower eyelid"], th: ["ซ้าย", "เปลือกตา", "ส่วนล่าง"] },
    { name: "left ear canal", siteText: "ear canal", base: "117590005", side: "7771000",
      source: "Instill 1 drop into the left ear canal daily.", method: "Instill", unit: "drop", inputForm: "r6",
      en: ["left", "ear canal"], th: ["ซ้าย", "ช่องหู"] }
  ] as const)("preserves the complete current target and annotations for $name", fixture => {
    const note = (name: string): FhirExtension => ({ url: `urn:clinic:${name}`, valueString: `retain ${name}` });
    const site: NonNullable<FhirDosage["site"]> = {
      id: "selected-site", text: fixture.siteText,
      _text: { extension: [note("site-text")] },
      coding: [{ system: "http://snomed.info/sct", code: `${fixture.base}:272741003=${fixture.side}`,
        version: "20250131", extension: [note("site-coding")] }],
      extension: [note("site")]
    };
    const row: FhirDosage = {
      id: "current-dosage", text: fixture.source, method: { text: fixture.method }, site,
      doseAndRate: [{ doseQuantity: { value: 1, unit: fixture.unit } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } },
      extension: [note("dosage")]
    };
    const r6: FhirR6DosageInstruction = {
      renderedInstruction: fixture.source,
      step: [{ component: [{ ...row, site: { concept: site } }] }]
    };
    const input = fixture.inputForm === "r5" ? [row] : r6;
    const inputBefore = JSON.parse(JSON.stringify(input));
    const native = importCanonicalCourse(input);
    const projected = projectCanonicalCourse(native);
    const views = [native, JSON.parse(JSON.stringify(projected.fhir)), JSON.parse(JSON.stringify(projected.fhirNext))];
    for (const view of views) {
      const before = JSON.parse(JSON.stringify(view));
      const course = importCanonicalCourse(view);
      expect(course.stages).toHaveLength(1);
      expect(course.stages[0].administrations).toHaveLength(1);
      const member = course.stages[0].administrations[0];
      expect(member.target).toEqual(site);
      expect(member.amounts).toHaveLength(1);
      expect(member.amounts[0].quantity).toMatchObject({ value: 1, unit: fixture.unit });
      expect(member.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      for (const locale of ["en", "th"] as const) {
        for (const style of ["short", "long"] as const) {
          const preview = formatSig(view, style, { locale, realizationMode: "normalized" });
          // The selected target must carry its side and finer part itself;
          // a separate original-directions annotation is not that target.
          const selected = preview.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
          for (const term of fixture[locale]) expect(selected).toContain(term);
        }
      }
      const output = projectCanonicalCourse(course);
      expect(output.fhir?.[0].site).toEqual(site);
      expect(output.fhirNext?.step?.[0].component?.[0].site).toEqual({ concept: site });
      expect(output.fhir?.[0].text).toBe(fixture.source);
      expect(output.fhirNext?.step?.[0].component?.[0].text).toBe(fixture.source);
      expect(output.fhir?.[0].extension?.filter(extension => extension.url.startsWith("urn:clinic:")))
        .toEqual(row.extension);
      expect(output.fhirNext?.step?.[0].component?.[0].extension?.filter(extension => extension.url.startsWith("urn:clinic:")))
        .toEqual(row.extension);
      expect(view).toEqual(before);
    }
    expect(input).toEqual(inputBefore);
  });

  it("keeps registered finer anatomy uncoded when realizing its constituent parts", async () => {
    for (const text of ["lower eyelid", "lower lid", "right lower eyelid", "left lower eyelid",
      "inside lower eyelid", "inside right lower eyelid"]) {
      expect(getBodySiteCode(text)).toBeUndefined();
      expect(await getBodySiteCodeAsync(text)).toBeUndefined();
    }
  });
});
