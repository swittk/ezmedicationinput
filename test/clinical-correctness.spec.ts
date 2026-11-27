import { describe,expect,it } from "vitest";
import type { FhirR6DosageInstruction } from "../src";
import { calculateTotalUnits,DOSAGE_ALTERNATIVE_CHOICE_URL,evaluateMedicationCondition,EventTiming,FhirPeriodUnit,formatParseBatch,formatSig,fromFhir,fromFhirDosage,getDosageAlternativeChoice,getDosageCondition,getDosageExcludedDates,getDosageExcludedWeekdays,importCanonicalCourse,lintSig,nextDueDoses,parseSig as parseBatch,parseInstructionActions,parseStrengthComponents,RouteCode,setDosageAlternativeChoice,setDosageCondition,setDosageExcludedWeekdays,toDosageDetails,toFhirR5Dosages } from "../src";
import { R5_SOURCE_ONLY_MAXIMUM_URL } from "../src/adapters/canonical-course";
import { R6_DRAFT_STEPS_SOURCE_URL,retainDraftSteps } from "../src/adapters/r6-editable-metadata";
import { COURSE_CYCLE_COUNT_EXTENSION_URL,decodeR5RetainedFields,decodeR6SourceMetadata,DOSAGE_DETAILS_R5_URL,DOSAGE_EXCLUDED_DATES_R5_URL,DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,DOSAGE_RECONCILIATION_SOURCE_URL,DOSAGE_RENDERED_INSTRUCTION_R5_URL,encodeR5RetainedFields,encodeR6SourceMetadata,getCourseCycleCount,getDosageSourceTextAgreement,PARALLEL_COMPONENT_PHASE_ORIGIN_URL,readRetainedField,setDosageExcludedDates,toEzDosages,withDosageEditProvenance } from "../src/dosage-course";
import { ADMINISTRATION_OFFSET_EXTENSION_URL,ANCHORED_COURSE_DURATION_EXTENSION_URL,canonicalFromFhir,canonicalToFhir,CYCLE_DAY_ELIGIBILITY_EXTENSION_URL,getTimingClocks,TIMING_ADDITIONAL_CLOCK_EXTENSION_URL } from "../src/fhir";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL,getQuantityComparator,QUANTITY_OPERATOR_SOURCE_URL,quantityForR5,quantityFromR5 } from "../src/fhir-quantity-operator";
import type { CanonicalInstructionGraph,EzDosage,FhirDosage,FhirElement,FhirExtension,FhirR6Dosage,FhirR6DosageCondition,FhirR6DosageInstructionInput,FhirR6DosageStep,FhirR6Quantity,FhirR6Timing,FhirRatio } from "../src/index";
import { AdviceForce,buildBodySiteSpatialRelationExtension,cloneBodySiteSpatialRelation,FhirDayOfWeek,fromDosageDetails,parseBodySiteSpatialRelationExtension,parseInstructionGraphExtension,parseSig as parsePublicSig,projectCanonicalCourse } from "../src/index";
import { buildInstructionGraphExtension,MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "../src/instruction-graph-fhir";
import { parseMedicationGuard } from "../src/medication-condition";
import { createBoundaryPlan } from "../src/regimen/planner";
import type { EzCourseMetadata,FhirR6DoseLimit } from "../src/types";
import { AdviceArgumentRole,AdvicePolarity } from "../src/types";
import { convertQuantityValue } from "../src/utils/units";
import { parseSig,parseSigAsync } from "./helpers/r5-parser";

describe("Thai negated numeric guard comparators", () => {
  it.each([
    ["ไม่น้อยกว่า", "ge", 100, 100, 99],
    ["ไม่มากกว่า", "le", 160, 160, 161],
    ["ไม่สูงกว่า", "le", 160, 160, 161],
    ["ไม่ต่ำกว่า", "ge", 100, 100, 99],
    ["ไม่เกิน", "le", 160, 160, 161]
  ] as const)("keeps a Thai blood-pressure guard %s pointed in the correct direction", (
    comparative, operation, threshold, allowed, disallowed
  ) => {
    const source = `รับประทาน 1 เม็ด ถ้าความดัน${comparative} ${threshold}`;
    const parsed = parseSig(source);
    const condition = getDosageCondition(parsed.fhir);
    expect(condition).toMatchObject({
      kind: "measurement", name: "ความดัน", operation, value: threshold
    });
    expect(evaluateMedicationCondition(condition!, { ความดัน: allowed })).toBe(true);
    expect(evaluateMedicationCondition(condition!, { ความดัน: disallowed })).toBe(false);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});

describe("clinical SIG correctness and boundary promotion", () => {
  it.each([
    ["second", "1 tab at 08:00, 1 tab at 20:00 only if BP > 160", [false, true]],
    ["first", "1 tab at 08:00 only if BP > 160, 1 tab at 20:00", [true, false]]
  ] as const)("keeps the %s clock conditioned instead of merging away a guard", (_label, sig, expected) => {
    const parsed = parseSig(sig);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => Boolean(getDosageCondition(item.fhir)))).toEqual([...expected]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([
      ["08:00:00"], ["20:00:00"]
    ]);
    for (let index = 0; index < 2; index++) {
      const dosage = parsed.items[index].fhir;
      const opts = { from: "2026-10-22T08:00:00+07:00",
        orderedAt: "2026-10-22T08:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 3 };
      const opportunities = nextDueDoses(dosage, opts);
      if (expected[index]) {
        expect(opportunities).toHaveLength(3);
        expect(nextDueDoses(dosage, {
          ...opts, evaluateCondition: () => false
        })).toEqual([]);
        expect(nextDueDoses(dosage, {
          ...opts, evaluateCondition: () => true
        })).toEqual(opportunities);
      } else {
        expect(opportunities.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps equally conditioned clocks separate so each displayed clause matches its timing", () => {
    const parsed = parseSig(
      "1 tab at 08:00 if SBP > 160, 1 tab at 20:00 if SBP > 160"
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([
      ["08:00:00"], ["20:00:00"]
    ]);
    expect(parsed.items.map(item => getDosageCondition(item.fhir))).toEqual([
      expect.objectContaining({ kind: "measurement", name: "sbp", value: 160 }),
      expect.objectContaining({ kind: "measurement", name: "sbp", value: 160 })
    ]);
    expect(parsed.items[0].fhir.text).toContain("08:00");
    expect(parsed.items[1].fhir.text).toContain("20:00");
  });

  it("preserves ordinary fractional tablet doses without cycle syntax", () => {
    const parsed = parseSig("take .5 tab at 08:00");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 0.5, unit: "tab"
    });
    expect(parsed.fhir.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(parsed.fhir.route?.text).toBe("by mouth");
  });

  it("never substitutes a daily maximum for a separately prescribed bare dose", () => {
    const instruction = "take 2 daily maximum 4 tablets per day";
    const parsed = parseSig(instruction);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(parsed.fhir.maxDosePerPeriod?.[0]?.numerator?.value).toBe(4);
    expect(parsed.fhir.maxDosePerPeriod?.[0]?.denominator).toMatchObject({
      value: 1, code: "d"
    });
    expect(parsed.fhir.text).toContain(instruction);
  });

  it("preserves trailing maximum-dose constraints rather than merging them away", () => {
    const parsed = parseSig("1 tab at 08:00, 1 tab at 20:00 max 1 tab/day");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].fhir.maxDosePerPeriod).toBeUndefined();
    expect(parsed.items[1].fhir.maxDosePerPeriod?.[0]?.numerator?.value).toBe(1);
  });


  it.each([
    "1 tab daily except Sundays",
    "กินยา 1 เม็ด ทุกวันยกเว้นวันอาทิตย์"
  ])("excludes Sunday instead of administering on Sunday: %s", instruction => {
    const result = parseSig(instruction);
    expect(result.items).toHaveLength(1);
    expect(result.fhir.timing?.repeat?.dayOfWeek).toEqual([
      "mon", "tue", "wed", "thu", "fri", "sat"
    ]);
    expect(result.meta.leftoverText).toBeUndefined();
    expect(lintSig(instruction).issues).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ["1 tab BID QID", { frequency: 2, period: 1, periodUnit: "d" }, true],
    ["1 tab once daily BID", { frequency: 1, period: 1, periodUnit: "d" }, true],
    ["1 tab q6h q8h", { period: 6, periodUnit: "h" }, true],
    ["1 tab BID q5min", { frequency: 2, period: 1, periodUnit: "d" }, true],
    ["1 tab BID every 8 hours", { frequency: 2, period: 1, periodUnit: "d" }, true],
    ["Apply 1 drop OD BID", { frequency: 2, period: 1, periodUnit: "d" }, false]
  ] as const)("keeps the best supported cadence and source for editable conflicts: %s", (sig, cadence, conflict) => {
    const parsed = parseSig(sig);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir.timing?.repeat).toMatchObject(cadence);
    expect(parsed.input).toBe(sig);
    expect(parsed.fhir.text).toBeTruthy();
    if (conflict) {
      expect(parsed.meta.leftoverText).toBeTruthy();
    }
    if (sig.includes("OD")) expect(parsed.fhir.site?.text).toBe("right eye");
    expect(nextDueDoses(parsed.fhir, {
      from: "2026-10-21T08:00:00+07:00",
      orderedAt: "2026-10-21T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 5
    })).toHaveLength(5);
  });

  it("uses genuine word boundaries for an explicit excluded ISO date", () => {
    const input = "1 tab daily except 2026-10-29";
    const parsed = parseSig(input);
    expect(getDosageExcludedDates(parsed.fhir)).toContain("2026-10-29");
    expect(parsed.warnings.some(warning => warning.includes("unresolved-calendar-exclusion")))
      .toBe(false);
  });

  it("keeps an unknown exception recoverable beside the daily suggestion", () => {
    const result = parseSig("1 tab daily except public holidays");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d"
    });
    expect(result.fhir.text).toBe(result.input);
    expect(result.meta.leftoverText).toContain("except public holidays");
    expect(result.meta.canonical.clauses[0]?.clinicalAdjuncts?.evidence)
      .toContainEqual(expect.objectContaining({
        rule: "hpsg.lex.clinical.calendar-exclusion.unresolved"
      }));
  });

  it("models only-if as a condition rather than a pseudo-PRN", () => {
    const result = parseSig("Take 1 tablet BID only if BP above 160, otherwise hold");
    expect(result.fhir.timing?.repeat?.frequency).toBe(2);
    expect(result.fhir.asNeeded).not.toBe(true);
    expect(getDosageCondition(result.fhir)).toMatchObject({
      kind: "measurement", name: "bp", operation: "gt", value: 160
    });
    expect(result.dosageDetails?.step[0].component[0].condition?.[0]).toMatchObject({
      operation: "gt",
      valueQuantity: { value: 160 }
    });
    expect(result.warnings).toEqual([]);
  });

  it.each(["PRN", "prn", "PrN", "as needed", "AS   NEEDED"])(
    "keeps explicit %s status when an unless guard is present", marker => {
      const input = "Take 1 tab q6h " + marker + " pain unless SBP < 90";
      const parsed = parseSig(input);
      expect(parsed.fhir.asNeeded).toBe(true);
      expect(parsed.fhir.asNeededFor?.[0]?.text?.toLowerCase()).toContain("pain");
      expect(getDosageCondition(parsed.fhir)).toMatchObject({
        kind: "not", condition: { kind: "measurement", name: "sbp", operation: "lt", value: 90 }
      });
      expect(parsed.fhirNext.step[0].component[0].asNeeded).toBe(true);
    }
  );

  it("keeps a prefixed guard separate from its administration and trailing hold", () => {
    const input = "Only if SBP > 100, take 2 tabs as directed, otherwise hold";
    const guard = parseMedicationGuard(input)!;
    expect(guard).toBeDefined();
    expect(input.slice(guard.start, guard.end)).toContain("SBP > 100");
    expect(input.slice(guard.start, guard.end)).not.toContain("as directed");
    expect(input.slice(guard.otherwise!.start, guard.otherwise!.end))
      .toContain("otherwise hold");
    expect(guard.end).toBeLessThan(guard.otherwise!.start);
    expect(guard.condition).toMatchObject({
      kind: "measurement", name: "sbp", operation: "gt", value: 100
    });
    const parsed = parseSig(input);
    const instructionGraph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    const holdAction = instructionGraph?.actions.find(action =>
      action.predicate.lemma === "hold"
    );
    expect(instructionGraph?.sourceText).toBe(input);
    expect(instructionGraph?.sourceText.slice(guard.otherwise!.start, guard.otherwise!.end))
      .toBe(", otherwise hold");
    expect(holdAction).toBeDefined();
    expect(input.slice(holdAction!.span.start, holdAction!.span.end)).toBe("hold");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(parsed.fhir.text).toBe(input);
    expect(parsed.fhir.text).toContain("otherwise hold");
  });

  it.each([
    "Only if SBP > 100, take 2 tabs BID, otherwise hold",
    "  Only if SBP > 100, take 2 tabs BID, otherwise hold"
  ])("recognizes a prefixed condition and hold without consuming its dose: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.items).toHaveLength(1);
    expect(getDosageCondition(parsed.fhir)).toMatchObject({
      kind: "measurement", name: "sbp", operation: "gt", value: 100
    });
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(parsed.warnings.some(warning => warning.startsWith("Unresolved schedule"))).toBe(false);
  });

  it("ends a suffixed guard before a following maximum clause", () => {
    const source = "Take 1 tab q4h prn pain unless SBP < 90, max 4 tabs";
    const parsed = parseSig(source);
    expect(getDosageCondition(parsed.fhir)).toMatchObject({
      kind: "not",
      condition: { kind: "measurement", name: "sbp", operation: "lt", value: 90 }
    });
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir.timing?.repeat?.period).toBe(4);
    expect(parsed.fhir.asNeeded).toBe(true);
    expect(parsed.fhir.text).toBe(source);
  });

  it("handles Thai unless-conditions without fabricating a calendar exclusion", () => {
    const result = parseSig("รับประทาน 1 เม็ด วันละ 2 ครั้ง ยกเว้นกรณีความดันต่ำกว่า 100");
    expect(result.warnings.some(warning => warning.includes("unresolved-calendar-exclusion")))
      .toBe(false);
    expect(getDosageCondition(result.fhir)).toMatchObject({
      kind: "not", condition: { kind: "measurement", operation: "lt", value: 100 }
    });
    expect(result.fhir.timing?.repeat?.frequency).toBe(2);
  });

  it.each(["mcg", "MCG", "µg", "μg"])(
    "emits the UCUM ug code for infusion rate spelling %s", spelling => {
      const parsed = parseSig("Infuse IV at 5 " + spelling + "/min for 1 hour");
      expect(parsed.fhir.doseAndRate?.[0].rateQuantity).toMatchObject({
        value: 5, system: "http://unitsofmeasure.org", code: "ug/min"
      });
    }
  );

  it.each([
    ["ML", "mL/h"], ["ml", "mL/h"], ["L", "L/h"],
    ["MG", "mg/h"], ["mg", "mg/h"], ["MCG", "ug/h"],
    ["G", "g/h"]
  ])("normalizes infusion-rate unit %s as UCUM %s", (spelling, ucum) => {
    const source = "Infuse IV at 100 " + spelling + "/HR for 1 hour";
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.rateQuantity).toMatchObject({
      value: 100, unit: ucum, code: ucum, system: "http://unitsofmeasure.org"
    });
    expect(parsed.fhir.text).toContain(spelling + "/HR");
  });

  it.each(["ML", "ml", "mL"])(
    "normalizes the infused volume %s for dose, ratio and canonical clause", spelling => {
      const source = "Infuse 50 " + spelling + " over 30 MIN IV";
      const parsed = parseSig(source);
      expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
        doseQuantity: { value: 50, unit: "mL", code: "mL" },
        rateRatio: { numerator: { value: 50, unit: "mL", code: "mL" } }
      });
      expect(parsed.meta.canonical.clauses[0].dose?.unit).toBe("mL");
      expect(parsed.fhir.text).toContain(spelling);
    }
  );

  it.each([
    ["dopamine 5 mcg/kg/min IV", "ug/kg/min"],
    ["dopamine 5 mcg/kg/hr IV", "ug/kg/h"],
    ["5 MG/kg/HR IV", "mg/kg/h"],
    ["5 µg/kg/min IV", "ug/kg/min"],
    ["5 UG/kg/MIN IV", "ug/kg/min"],
    ["5 units/kg/h IV", "[iU]/kg/h"]
  ])("represents weight-based %s as a FHIR infusion rate, never a bolus", (sig, unit) => {
    const parsed = parseSig(sig);
    expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
      rateQuantity: { value: 5, unit, code: unit, system: "http://unitsofmeasure.org" }
    });
    expect(parsed.fhir.doseAndRate?.[0].doseQuantity).toBeUndefined();
    expect(parsed.fhir.text).toBe(sig);
    expect(parsed.warnings).toContainEqual(expect.stringContaining("patientWeightKg"));
    expect(parsed.fhirNext.step[0].component[0].doseAndRate?.[0].rateQuantity?.code)
      .toBe(unit);
  });

  it.each([
    ["5 mg/kg/week IV", "mg/kg/wk", "patientWeightKg"],
    ["5 mcg/kg/bolus IV", undefined, "unsupported-weight-based-rate"]
  ] as const)(
    "keeps a weight-rate suffix and recognized route recoverable: %s", (sig, rateUnit, warning) => {
      const parsed = parseSig(sig);
      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
      if (rateUnit) {
        expect(parsed.fhir.doseAndRate?.[0]?.rateQuantity).toMatchObject({
          value: 5, unit: rateUnit, code: rateUnit
        });
      } else {
        expect(parsed.fhir.doseAndRate?.[0]?.rateQuantity).toBeUndefined();
      }
      if (rateUnit) {
        expect(parsed.warnings).toContainEqual(expect.stringContaining(warning));
      }
      expect(parsed.fhir.text).toBe(sig);
      expect(parsed.fhir.route?.text).toBe("intravenous");
      if (!rateUnit) {
        expect(parsed.meta.leftoverText).toBeUndefined();
        expect(parsed.meta.canonical.clauses[0]?.clinicalQuantity).toMatchObject({
          representation: "rate-quantity",
          status: "unsupported",
          reviewReason: warning,
          numerator: { value: 5 }
        });
      }
    }
  );

  it("treats an explicitly timed per-kg infusion as one administration, not an entire-course bound", () => {
    const parsed = parseSig("Infuse dopamine at 5 mcg/kg/min IV for 4 h");
    expect(parsed.fhir.doseAndRate?.[0].rateQuantity?.code).toBe("ug/kg/min");
    expect(parsed.fhir.doseAndRate?.[0].doseQuantity).toBeUndefined();
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      count: 1, duration: 4, durationUnit: "h"
    });
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.warnings).toContainEqual(expect.stringContaining("patientWeightKg"));
  });

  it.each([
    ["Give 500 mL over 2 hours", "h"],
    ["Administer 500 ML over 2 h IV", "h"],
    ["Infuse 500 mL over 2 hr IV", "h"],
    ["Give 500 mL over 30 minutes", "min"]
  ])("interprets fixed-volume %s as a single infusion with explicit rateRatio", (sig, periodUnit) => {
    const parsed = parseSig(sig);
    expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 500, code: "mL" },
      rateRatio: {
        numerator: { value: 500, code: "mL" },
        denominator: { value: periodUnit === "h" ? 2 : 30, code: periodUnit }
      }
    });
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      count: 1, duration: periodUnit === "h" ? 2 : 30, durationUnit: periodUnit
    });
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.warnings.some(warning => warning.startsWith("Unresolved schedule")))
      .toBe(false);
    expect(parsed.fhir.text).toBe(sig);
  });

  it("preserves mg/kg dosing without inventing a fixed-dose milligram amount", () => {
    const result = parseSig("0.5 mg/kg PO BID");
    expect(result.fhir.doseAndRate?.[0].doseQuantity).toMatchObject({
      value: 0.5, unit: "mg/kg", code: "mg/kg"
    });
    expect(result.warnings).toContainEqual(expect.stringContaining("patient weight"));
  });

  it("divides an explicit daily weight-based total without treating dose count as the dose", () => {
    const result = parseSig("10 mg/kg/day divided into 3 doses");
    expect(result.fhir.doseAndRate?.[0].doseQuantity?.value).toBeCloseTo(10 / 3);
    expect(result.fhir.doseAndRate?.[0].doseQuantity?.unit).toBe("mg/kg");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3, period: 1, periodUnit: "d"
    });
    expect(result.meta.leftoverText).toBeUndefined();
    expect(formatSig(result.fhir)).toBe("10 mg/kg/day divided into 3 doses");
  });

  it("keeps an incomplete daily weight-based total available for correction", () => {
    const result = parseSig("10 mg/kg/day");
    expect(result.fhir.text).toBe("10 mg/kg/day");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.meta.canonical.clauses[0]?.clinicalQuantity).toMatchObject({
      representation: "dose",
      status: "incomplete",
      dailyTotal: true
    });
  });

  it("exports a continuous IV rate instead of pretending it is a 2-unit bolus", () => {
    const result = parseSig("Infuse IV at 2 mL/h for 12 hours");
    expect(result.fhir.doseAndRate?.[0]).toMatchObject({
      rateQuantity: { value: 2, unit: "mL/h" }
    });
    expect(result.fhir.doseAndRate?.[0].doseQuantity).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      count: 1, duration: 12, durationUnit: "h"
    });
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("exports infusion dose and time distinctly for a fixed volume over time", () => {
    const result = parseSig("Infuse 50 mL over 30 minutes IV");
    expect(result.fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 50, unit: "mL" },
      rateRatio: {
        numerator: { value: 50, unit: "mL" },
        denominator: { value: 30, unit: "min" }
      }
    });
    expect(result.fhir.timing?.repeat).toMatchObject({
      count: 1, duration: 30, durationUnit: "min"
    });
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("preserves already understood count caps without blocking the schedule", () => {
    const parsed = parseSig("1 tab sl q5min prn chest pain max 3 doses");
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?._count?.extension).toContainEqual({
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ countMax: 3 });
    expect(parsed.warnings.some(warning => warning.startsWith("Unresolved schedule"))).toBe(false);
  });

  it("treats 'up to 3 doses' as a total administration cap without absorbing the PRN reason", () => {
    const parsed = parseSig("1 tab SL q5min PRN chest pain up to 3 doses");
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?._count?.extension).toContainEqual({
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ countMax: 3,
      period: 5,
      periodUnit: "min"
    });
    expect(parsed.meta.canonical.clauses[0]?.prn?.reason?.text).toBe("chest pain");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.warnings.some(warning => warning.startsWith("Unresolved schedule"))).toBe(false);
    const opts = { from: "2026-10-21T08:00:00+07:00", orderedAt: "2026-10-21T08:00:00+07:00", timeZone: "Asia/Bangkok", limit: 10, priorCount: 0 };
    expect(nextDueDoses(parsed.fhir, opts)).toHaveLength(3);
    expect(nextDueDoses(parsed.fhir, { ...opts, priorCount: 2 })).toHaveLength(1);
  });

  it("does not interpret an 'up to DATE' treatment boundary as a dose count", () => {
    const parsed = parseSig("1 tab daily up to 30 Sep 2026");
    expect(parsed.fhir.timing?.repeat?.countMax).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.countMax).toBeUndefined();
  });

  it.each([
    "infuse 100 mL over 30 minutes every 8 hours",
    "infuse IV at 100 mL/h for 30 minutes every 8 hours",
    "infuse dopamine at 5 mcg/kg/min IV for 30 minutes every 8 hours"
  ])("preserves recurring cadence and per-administration duration for infusion form: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      period: 8,
      periodUnit: "h",
      duration: 30,
      durationUnit: "min"
    });
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({
      period: 8,
      periodUnit: "h",
      administrationDuration: 30,
      administrationDurationUnit: "min"
    });
    expect(parsed.warnings.some(warning => warning.startsWith("Unresolved schedule"))).toBe(false);
  });

  it("shares a sole trailing cadence across coordinated site-specific doses", () => {
    const source = "instill 1 drop in left eye and 2 drops in right eye twice daily";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["left eye", "right eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat)).toEqual([
      expect.objectContaining({ frequency: 2, period: 1, periodUnit: "d" }),
      expect.objectContaining({ frequency: 2, period: 1, periodUnit: "d" })
    ]);
  });

  it("keeps both site doses and the best supported local cadence when one component conflicts", () => {
    const parsed = parseSig(
      "instill 1 drop in left eye and 2 drops in right eye twice daily q8h"
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["left eye", "right eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 2]);
    expect(parsed.items[1].fhir.timing?.repeat).toMatchObject({
      frequency: 2, period: 1, periodUnit: "d"
    });
  });

  it.each([
    ["eye drops", RouteCode["Ocular route (qualifier value)"], "drop"],
    ["transdermal patch", RouteCode["Transdermal route"], "patch"]
  ] as const)("lets dosage-form context outrank generic apply for %s", (dosageForm, route, unit) => {
    const parsed = parseSig("apply 1 daily", { context: { dosageForm } });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(route);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit });
    expect(parsed.warnings).toEqual([]);
  });

  it("keeps an explicit route over conflicting dosage-form context and warns", () => {
    const parsed = parseSig("apply 1 PO daily", {
      context: { dosageForm: "eye drops" }
    });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(RouteCode["Oral route"]);
    expect(parsed.warnings).toContainEqual(expect.stringContaining("conflicts with dosage-form context"));
  });

  it.each([
    ["1 tablet sublingually", "tablet", RouteCode["Sublingual route"]],
    ["Insert 1 vaginal tablet", "tablet", RouteCode["Per vagina"]]
  ] as const)("does not flag a generic tablet form as a route conflict: %s", (source, dosageForm, route) => {
    const parsed = parseSig(source, { context: { dosageForm } });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(route);
    expect(parsed.warnings).not.toContainEqual(expect.stringContaining("conflicts with dosage-form context"));
    expect(parsed.input).toBe(source);
  });

  it("still warns when an explicitly sublingual dosage form is prescribed orally", () => {
    const parsed = parseSig("Take 1 tablet PO", { context: { dosageForm: "sublingual tablet" } });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(RouteCode["Oral route"]);
    expect(parsed.warnings).toContainEqual(expect.stringContaining("conflicts with dosage-form context"));
  });

  it("exports daily dose maximum and FHIR R5 PRN without serializing legacy asNeeded", () => {
    const result = parseSig("1 tab q6h prn fever max 4 tablets/day");
    expect(result.fhir.maxDosePerPeriod).toMatchObject([{
      numerator: { value: 4, unit: "tab" },
      denominator: { value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d" }
    }]);
    expect(result.fhir.asNeeded).toBe(true);
    expect(result.fhir.asNeeded).toBe(true);
    const serial = JSON.parse(JSON.stringify(result.fhir));
    expect(serial.asNeeded).toBe(true);
    expect(serial).not.toHaveProperty("asNeededBoolean");
  });

  it.each([
    ["1 tab q6h prn fever max 4 tablets/day", undefined, 4, "tab", "d"],
    ["1 drop OD q4h prn irritation, max 3 drops per week", undefined, 3, "drop", "wk"],
    ["1 cap BID do not exceed 2 capsules per day", undefined, 2, "cap", "d"],
    ["1 puff q4h no more than 6 puffs a day", undefined, 6, "puff", "d"],
    ["1 mL daily max. 7 mL/24hrs", undefined, 7, "mL", "h", 24],
    ["รับประทาน 1 เม็ด วันละ 2 ครั้ง ไม่เกิน วันละ 4 เม็ด", "th", 4, "tab", "d"]
  ] as const)("types a periodic dose maximum before the single FHIR projection: %s",
    (source, locale, amount, unit, periodUnit, period = 1) => {
      const parsed = parseSig(source, locale ? { locale } : undefined);
      expect(parsed.meta.canonical.clauses[0]?.schedule?.maxDosePerPeriod).toEqual([{
        amount, unit, period, periodUnit
      }]);
      expect(parsed.fhir.maxDosePerPeriod).toMatchObject([{
        numerator: { value: amount, unit },
        denominator: {
          value: period, unit: periodUnit,
          system: "http://unitsofmeasure.org", code: periodUnit
        }
      }]);
      const evidence = parsed.meta.canonical.clauses[0]?.evidence.find(item =>
        item.rule === "hpsg.lex.schedule.maximumDosePerPeriod"
      );
      expect(evidence?.spans[0]?.text).toMatch(/(?:max|do not exceed|no more than|ไม่เกิน)/u);
      expect(source).toContain(evidence?.spans[0]?.text);
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.fhir.text).toBe(source);
      expect(parsed.longText).toBe(source);
      expect(lintSig(source, locale ? { locale } : undefined).issues).toEqual([]);
      if (source.includes("OD")) {
        expect(parsed.fhir.site?.text).toBe("right eye");
        expect(parsed.fhir.route?.coding?.[0]?.code).toBe(RouteCode["Ophthalmic route"]);
        expect(parsed.fhir.asNeeded).toBe(true);
      }
    }
  );

  it.each([
    ["1 tab po q4h if pain no more than 4 doses per day", undefined],
    ["Take 1 tablet if pain and at most 4 doses per day", undefined],
    ["รับประทาน 1 เม็ด เมื่อปวด ไม่เกิน 4 ครั้งต่อวัน", "th"]
  ] as const)("retains the bare pain PRN separately from a maximum count: %s", (source, locale) => {
    const parsed = parseSig(source, locale ? { locale } : undefined);
    expect(parsed.fhir.asNeeded).toBe(true);
    expect(parsed.fhir.asNeededFor?.[0]?.coding?.[0]).toMatchObject({
      system: "http://snomed.info/sct", code: "22253000"
    });
    expect(parsed.meta.canonical.clauses[0]?.schedule?.occurrenceCap)
      .toMatchObject({ max: 4, period: 1, periodUnit: "d" });
    expect(getDosageCondition(parsed.fhir)).toBeUndefined();
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 1, unit: "tab"
    });
  });

  it("keeps quantity maxima distinct from occurrence caps and limits PRN supply", () => {
    const quantityCapped = parseSig("2 tabs q4h PRN pain max 4 tablets/day");
    const occurrenceCapped = parseSig("2 tabs q4h PRN pain no more than 4 doses per day");

    expect(quantityCapped.meta.canonical.clauses[0]?.schedule).toMatchObject({
      maxDosePerPeriod: [{ amount: 4, unit: "tab", period: 1, periodUnit: "d" }]
    });
    expect(quantityCapped.meta.canonical.clauses[0]?.schedule?.occurrenceCap)
      .toBeUndefined();
    expect(occurrenceCapped.meta.canonical.clauses[0]?.schedule).toMatchObject({
      occurrenceCap: { max: 4, period: 1, periodUnit: "d" }
    });
    expect(occurrenceCapped.meta.canonical.clauses[0]?.schedule?.maxDosePerPeriod)
      .toBeUndefined();

    expect(calculateTotalUnits({
      dosage: quantityCapped,
      from: "2026-10-23T00:00:00+07:00",
      orderedAt: "2026-10-23T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      durationValue: 7,
      durationUnit: "d"
    })).toMatchObject({ totalUnits: 28, unit: "tab", quantityKind: "maximum" });
  });

  it("keeps phase order and schedules sequential eye-drop taper weeks", () => {
    const input = "1 drop OD q2h x1wk then qid x1wk then bid x1wk";
    const result = parseSig(input);
    expect(result.items.map(item => item.fhir.sequence)).toEqual([1, 2, 3]);
    const details = result.dosageDetails!;
    expect(details.step).toHaveLength(3);
    expect(details.step.map(step => step.component.length)).toEqual([1, 1, 1]);
    const r5 = toFhirR5Dosages(details);
    expect(r5.map(dose => dose.sequence)).toEqual([1, 2, 3]);
    const first = nextDueDoses(result, {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 1
    });
    expect(first).toEqual(["2026-10-19T08:00:00+07:00"]);
    expect(nextDueDoses(details, {
      from: "2026-10-26T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 1
    })).toEqual(["2026-10-26T08:00:00+07:00"]);
    expect(nextDueDoses(r5, {
      from: "2026-11-02T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 1
    })).toEqual(["2026-11-02T08:00:00+07:00"]);
    expect(nextDueDoses(r5, {
      from: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 2
    })).toEqual([
      "2026-10-19T08:00:00+07:00",
      "2026-10-19T10:00:00+07:00"
    ]);
  });

  it("keeps the sync and async constrained parses equivalent", async () => {
    const input = "1 tab daily except Sundays";
    const sync = parseSig(input);
    const asyncResult = await parseSigAsync(input);
    expect(asyncResult.items[0].fhir.timing).toEqual(sync.items[0].fhir.timing);
    expect(asyncResult.items[0].meta.leftoverText).toEqual(sync.items[0].meta.leftoverText);
  });

  it("retains separate ingredients rather than adding combination product strengths", () => {
    expect(parseStrengthComponents("875 mg + 125 mg")).toEqual([
      { strengthQuantity: { value: 875, unit: "mg" } },
      { strengthQuantity: { value: 125, unit: "mg" } }
    ]);
    expect(parseStrengthComponents("400 mg/5mL + 80 mg/5mL")).toEqual([
      { strengthRatio: { numerator: { value: 400, unit: "mg" }, denominator: { value: 5, unit: "mL" } } },
      { strengthRatio: { numerator: { value: 80, unit: "mg" }, denominator: { value: 5, unit: "mL" } } }
    ]);
    expect(parseStrengthComponents("875 mg + unknown")).toBeNull();
  });

  it.each([
    ["1 tab daily except Mondays and Wednesdays", ["tue", "thu", "fri", "sat", "sun"]],
    ["กินยา 1 เม็ด ทุกวันยกเว้นวันจันทร์และวันพุธ", ["tue", "thu", "fri", "sat", "sun"]],
    ["1 tab daily except Saturday, Sunday and Monday", ["tue", "wed", "thu", "fri"]]
  ] as const)("supports coordinated weekday omissions without dropping the recurrence: %s", (text, days) => {
    const result = parseSig(text);
    expect(result.items).toHaveLength(1);
    expect(result.fhir.timing?.repeat?.dayOfWeek).toEqual(days);
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ["1 tab daily except 20/10/2026 and 22/10/2026", ["2026-10-20", "2026-10-22"]],
    ["กินยา 1 เม็ด ทุกวันยกเว้น 20/10/2569 และ 22/10/2569", ["2026-10-20", "2026-10-22"]],
    ["1 tab daily except Mondays, 20/10/2026 and 22/10/2026", ["2026-10-20", "2026-10-22"]]
  ] as const)("handles multiple explicit omission dates without turning them into doses: %s", (text, dates) => {
    const result = parseSig(text, { locale: /[ก-๙]/u.test(text) ? "th" : "en" });
    expect(result.items).toHaveLength(1);
    expect(getDosageExcludedDates(result.fhir)).toEqual(dates);
    expect(result.fhir.timing?.event).toBeUndefined();
    expect(result.fhir.timing?.repeat?.frequency).toBe(1);
    expect(result.meta.leftoverText).toBeUndefined();
    const original = toFhirR5Dosages(result.dosageDetails!);
    expect(getDosageExcludedDates(original[0])).toEqual(dates);
  });

  it("retains original weekday exceptions when formatting R5 Dosage for patients", () => {
    const original = "1 tab daily except Mondays and Wednesdays";
    const parsed = parseSig(original);
    expect(formatSig(parsed.fhir)).toBe(original);
  });

  it("schedules the understood cadence while retaining an unknown exclusion", () => {
    const parsed = parseSig("1 tab daily except public holidays");
    expect(parsed.fhir.text).toBe(parsed.input);
    expect(formatSig(parsed.fhir)).toContain("1 tab");
    expect(parsed.meta.leftoverText).toContain("except public holidays");
    expect(nextDueDoses(parsed, {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 3
    })).toEqual([
      "2026-10-19T09:00:00+07:00",
      "2026-10-20T09:00:00+07:00",
      "2026-10-21T09:00:00+07:00"
    ]);
  });

  it("omits explicit dates from emitted administrations but retains ordinary days", () => {
    const result = parseSig("1 tab daily except 20/10/2026 and 22/10/2026");
    expect(nextDueDoses(result.dosageDetails!, {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 3
    })).toEqual([
      "2026-10-19T09:00:00+07:00",
      "2026-10-21T09:00:00+07:00",
      "2026-10-23T09:00:00+07:00"
    ]);
  });

  it("evaluates only-if and unless conditions per occurrence instead of discarding them", () => {
    const options = {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 2
    };
    const bp = parseSig("take 1 tab BID only if BP >160, otherwise hold");
    expect(nextDueDoses(bp.dosageDetails!, options)).toEqual([
      "2026-10-19T08:00:00+07:00", "2026-10-19T20:00:00+07:00"
    ]);
    expect(nextDueDoses(bp.dosageDetails!, {
      ...options, evaluateCondition: expr => evaluateMedicationCondition(expr, { bp: 160 })
    })).toEqual([]);
    expect(nextDueDoses(bp.dosageDetails!, {
      ...options, evaluateCondition: expr => evaluateMedicationCondition(expr, { bp: 170 })
    })).toEqual(["2026-10-19T08:00:00+07:00", "2026-10-19T20:00:00+07:00"]);
    const dizzy = parseSig("take 1 tab BID unless dizzy or nauseated");
    expect(dizzy.dosageDetails!.step[0].component[0].condition).toHaveLength(1);
    expect(nextDueDoses(dizzy.dosageDetails!, {
      ...options, evaluateCondition: expr =>
        evaluateMedicationCondition(expr, { dizzy: false, nauseated: false })
    })).toHaveLength(2);
    expect(nextDueDoses(dizzy.dosageDetails!, {
      ...options, evaluateCondition: expr =>
        evaluateMedicationCondition(expr, { dizzy: true, nauseated: false })
    })).toEqual([]);
  });

  it("keeps complex AND conditions together, not as R6 OR alternatives", () => {
    const result = parseSig("take 1 tab BID only if BP >160 and HR >=60");
    const condition = getDosageCondition(result.fhir);
    expect(condition).toMatchObject({
      kind: "all", conditions: [
        { kind: "measurement", name: "bp", operation: "gt", value: 160 },
        { kind: "measurement", name: "hr", operation: "ge", value: 60 }
      ]
    });
    expect(result.dosageDetails?.step[0].component[0].condition).toHaveLength(1);
    expect(getDosageCondition(toFhirR5Dosages(result.dosageDetails!)[0])).toEqual(condition);
  });

  it("round trips and schedules retained R6 repeat-cycle metadata", () => {
    const course = parseSig("1 tab daily").dosageDetails!;
    const enriched = { ...course, repeatCycle: { value: 28, unit: "d" } };
    const flattened = toFhirR5Dosages(enriched);
    expect(toDosageDetails(flattened)).toEqual(enriched);
    expect(nextDueDoses(flattened, {
      from: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 2
    })).toEqual([
      "2026-10-19T09:00:00+07:00",
      "2026-10-20T09:00:00+07:00"
    ]);
  });
});

describe("typed medication-guard polarity and measurement-head ellipsis", () => {
  it.each([
    "Take 1 tablet if BG above 180; otherwise skip",
    "Take 1 tablet if BG above 180, otherwise hold",
    "Take 1 tablet if BG above 180"
  ])("keeps a positive administration guard affirmative: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(getDosageCondition(parsed.fhir)).toMatchObject({
      kind: "measurement", name: "bg", operation: "gt", value: 180
    });
    expect(getDosageCondition(toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0]))
      .toEqual(getDosageCondition(parsed.fhir));
  });

  it.each([
    ["Take one tablet only if SBP above 100 and below 160", "sbp", "gt", 100, "lt", 160],
    ["Take 1 tablet if glucose at least 70 and less than 180", "glucose", "ge", 70, "lt", 180]
  ] as const)("shares a typed measurement head across a conditional conjunction: %s",
    (source, name, firstOperation, firstValue, secondOperation, secondValue) => {
      const parsed = parseSig(source);
      expect(getDosageCondition(parsed.fhir)).toMatchObject({
        kind: "all",
        conditions: [
          { kind: "measurement", name, operation: firstOperation, value: firstValue },
          { kind: "measurement", name, operation: secondOperation, value: secondValue }
        ]
      });
      expect(parsed.fhir.asNeeded).not.toBe(true);
    }
  );

  it.each([
    "Take 2 tablets daily if weight above 70kg; otherwise 1 tablet daily",
    "Take 2 tablets daily if weight above 70kg, otherwise take 1 tablet daily"
  ])("keeps a numeric IF guard typed when an explicit alternate dose follows: %s", source => {
    const guard = parseMedicationGuard(source);
    expect(guard?.otherwiseHold).toBe(false);
    expect(guard?.alternative).toBeDefined();
    expect(source.slice(guard!.alternative!.start, guard!.alternative!.end))
      .toMatch(/otherwise|else/iu);
    expect(guard?.condition).toMatchObject({
      kind: "measurement", name: "weight", operation: "gt", value: 70, unit: "kg"
    });
    const parsed = parseSig(source);
    expect(parsed.items.some(item => item.fhir.asNeeded === true)).toBe(false);
    expect(parsed.items.some(item =>
      getDosageCondition(item.fhir)?.kind === "measurement"
    )).toBe(true);
  });

  it.each([
    "Take 1 tab if BG > 180; otherwise hold the dose",
    "Take 1 tab if BG > 180, otherwise skip the dose"
  ])("keeps an object-bearing alternate withholding branch out of the positive IF guard: %s", source => {
    const guard = parseMedicationGuard(source);
    expect(guard?.alternative).toBeDefined();
    expect(source.slice(guard!.alternative!.start, guard!.alternative!.end))
      .toMatch(/otherwise|else/iu);
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value: 1, unit: "tab" });
    expect(getDosageCondition(parsed.fhir)).toMatchObject({
      kind: "measurement", name: "bg", operation: "gt", value: 180
    });
    expect(getDosageCondition(toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0]))
      .toEqual(getDosageCondition(parsed.fhir));
  });

  it("keeps a direct object-bearing HOLD conditional inverse", () => {
    const parsed = parseSig("Take 1 tab daily; hold the dose if BG < 70");
    expect(getDosageCondition(parsed.fhir)).toMatchObject({
      kind: "not",
      condition: { kind: "measurement", name: "bg", operation: "lt", value: 70 }
    });
  });
});

describe("real-world Thai clinical meaning stays independent across source, canonical, R5 and R6", () => {
  type ProjectedClinicalRow = {
    doseAndRate?: Array<{ doseQuantity?: { value?: number; unit?: string } }>;
    timing?: { repeat?: {
      count?: number;
      frequency?: number;
      period?: number;
      periodUnit?: string;
      offset?: number;
      when?: string[];
      boundsDuration?: { value?: number; code?: string; unit?: string };
    } };
    route?: { text?: string };
    method?: { text?: string };
    site?: unknown;
    sequence?: number;
  };

  const dose = (row: ProjectedClinicalRow) => row.doseAndRate?.[0]?.doseQuantity;
  const repeat = (row: ProjectedClinicalRow) => row.timing?.repeat;
  const site = (row: ProjectedClinicalRow) => {
    const value = row.site as { text?: string; concept?: { text?: string } } | undefined;
    return value?.concept?.text ?? value?.text;
  };
  const r6Rows = (parsed: ReturnType<typeof parseSig>) =>
    parsed.fhirNext.step.flatMap(step => step.component);
  const projections = (parsed: ReturnType<typeof parseSig>) => [
    parsed.items.map(item => item.fhir),
    toFhirR5Dosages(parsed.fhirNext),
    r6Rows(parsed)
  ] as const;
  const expectSourceBacked = (source: string, parsed: ReturnType<typeof parseSig>) => {
    expect(parsed.input).toBe(source);
    expect(parsed.items.length).toBeGreaterThan(0);
    for (const item of parsed.items) {
      const clause = item.meta.canonical.clauses[0];
      expect(clause?.rawText).toBeTruthy();
      expect(source).toContain(clause!.rawText);
      expect(clause?.raw.text).toBe(clause?.rawText);
    }
    expect(formatSig(parsed.fhirNext, "long")).toBeTruthy();
    expect(formatSig(parsed.fhirNext, "long", { locale: "th" })).toBeTruthy();
  };

  it.each([
    ["รับประทาน ครึ่งเม็ดตอนเช้า และ 1 เม็ดตอนเย็น", "EVE", "by mouth"],
    ["รับประทาน 1/2 เม็ดตอนเช้า และ 1 เม็ดตอนเย็น", "EVE", "by mouth"],
    ["กินครึ่งเม็ดเช้าและหนึ่งเม็ดเย็น", "EVE", "by mouth"],
    ["กินครึ่งเม็ดเช้า 1 เม็ดเย็น", "EVE", "by mouth"],
    ["กินยา ครึ่งเม็ด ตอนเช้า และหนึ่งเม็ดตอนเย็น", "EVE", "by mouth"],
    ["take half a tablet in the morning and 1 tablet at night", "NIGHT", "by mouth"],
    ["รับประทาน 0.5 เม็ดเช้า 1 เม็ดเย็น", "EVE", "by mouth"],
    ["ครึ่งเม็ดตอนเช้า 1 เม็ดตอนเย็น", "EVE", undefined],
    ["กินยา 1/2 เม็ดเช้า และ 1 เม็ดเย็น", "EVE", "by mouth"]
  ] as const)("keeps half a tablet in the morning distinct from one tablet later: %s",
    (source, later, expectedRoute) => {
      const parsed = parseSig(source);
      expectSourceBacked(source, parsed);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.dose))
        .toEqual([{ value: 0.5, unit: "tab" }, { value: 1, unit: "tab" }]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule?.when))
        .toEqual([["MORN"], [later]]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.route?.text))
        .toEqual([expectedRoute, expectedRoute]);
      for (const rows of projections(parsed)) {
        expect(rows).toHaveLength(2);
        expect(rows.map(row => dose(row))).toMatchObject([
          { value: 0.5, unit: "tab" }, { value: 1, unit: "tab" }
        ]);
        expect(rows.map(row => repeat(row)?.when)).toEqual([["MORN"], [later]]);
        expect(rows.map(row => row.route?.text)).toEqual([expectedRoute, expectedRoute]);
      }
      const strict = toFhirR5Dosages(parsed.fhirNext);
      expect(formatSig(strict, "long")).toMatch(/0\.5[\s\S]*1 tablet/iu);
      expect(formatSig(strict, "long", { locale: "th" }))
        .toMatch(/0\.5[\s\S]*1 เม็ด/u);
    }
  );

  it.each([
    ["หยอดตาทั้งสองข้างครั้งละ 1 หยด วันละสองครั้ง", 2],
    ["หยอดตาทั้งสองข้างครั้งละ 1 หยด วันละ 2 ครั้ง", 2],
    ["หยอดตาทั้งสองข้างครั้งละ 1 หยด วันละ ๒ ครั้ง", 2],
    ["หยอดตาทั้งสองข้าง 1 หยด วันละสองครั้ง", 2],
    ["หยอดตาทั้งสองข้าง 1 หยด วันละ 2 ครั้ง", 2],
    ["หยอดตาทั้งสองข้าง 1 หยด วันละ สอง ครั้ง", 2],
    ["หยอดตาทั้งสองข้าง 1 หยด สองครั้งต่อวัน", 2],
    ["หยอดตาทั้งสองข้าง 1 หยด วันละสามครั้ง", 3],
    ["หยอดตาทั้งสองข้าง 1 หยด วันละ 3 ครั้ง", 3],
    ["หยอดตาทั้งสองข้าง 1 หยด วันละ ๓ ครั้ง", 3],
    ["หยอดตาทั้งสองข้างครั้งละ ๑ หยด วันละ ๓ ครั้ง", 3],
    ["1 drop OU BID", 2]
  ] as const)("uses the supplied Thai numeral as the bilateral-eye daily frequency: %s",
    (source, frequency) => {
      const parsed = parseSig(source);
      expectSourceBacked(source, parsed);
      expect(parsed.items).toHaveLength(1);
      const clause = parsed.items[0].meta.canonical.clauses[0];
      expect(clause?.dose).toEqual({ value: 1, unit: "drop" });
      expect(clause?.site).toMatchObject({
        text: "both eyes", coding: { code: "40638003" }
      });
      expect(clause?.schedule).toMatchObject({ frequency, period: 1, periodUnit: "d" });
      expect(clause?.schedule?.count).toBeUndefined();
      for (const rows of projections(parsed)) {
        expect(rows).toHaveLength(1);
        expect(dose(rows[0])).toMatchObject({ value: 1, unit: "drop" });
        expect(site(rows[0])).toBe("both eyes");
        expect(rows[0].route?.text).toBe("ophthalmic");
        expect(repeat(rows[0])).toMatchObject({ frequency, period: 1, periodUnit: "d" });
        expect(repeat(rows[0])?.count).toBeUndefined();
      }
      const strict = toFhirR5Dosages(parsed.fhirNext);
      expect(formatSig(strict, "long")).toContain("both eyes");
      expect(formatSig(strict, "long", { locale: "th" })).toContain("ตาทั้งสองข้าง");
    }
  );

  it.each([
    ["กินยา 1 เม็ด เช้าเย็นหลังอาหาร 7 วัน", ["PCM", "PCV"]],
    ["กินยา 1 เม็ด เช้า เย็น หลังอาหาร 7 วัน", ["PCM", "PCV"]],
    ["กินยา 1 เม็ด เช้าและเย็นหลังอาหาร 7 วัน", ["PCM", "PCV"]],
    ["กินยา 1 เม็ด วันละ 2 ครั้ง หลังอาหาร 7 วัน", ["PC"]],
    ["รับประทาน 1 เม็ด วันละ 2 ครั้ง หลังอาหาร 7 วัน", ["PC"]],
    ["กินยา 1 เม็ด หลังอาหารเช้าและเย็น 7 วัน", ["PCM", "PCV"]],
    ["กินยา 1 เม็ด เช้าเย็นหลังอาหาร นาน 7 วัน", ["PCM", "PCV"]],
    ["กินยา 1 เม็ด เช้าเย็นหลังอาหาร เป็นเวลา 7 วัน", ["PCM", "PCV"]],
    ["กินยา 1 เม็ด วันละสองครั้ง หลังอาหาร 7 วัน", ["PC"]],
    ["1 tab po BID pc x 7d", ["PC"]]
  ] as const)("keeps seven days as the course and meal relation as two daily opportunities: %s",
    (source, expectedWhen) => {
      const parsed = parseSig(source);
      expectSourceBacked(source, parsed);
      expect(parsed.items).toHaveLength(1);
      const clause = parsed.items[0].meta.canonical.clauses[0];
      expect(clause?.dose).toEqual({ value: 1, unit: "tab" });
      expect(clause?.route?.text).toBe("by mouth");
      expect(clause?.schedule).toMatchObject({
        duration: 7, durationUnit: "d", when: expectedWhen
      });
      expect(clause?.schedule?.offset).toBeUndefined();
      expect(clause?.schedule?.count).toBeUndefined();
      if (expectedWhen.length === 1) {
        expect(clause?.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
      } else if (clause?.schedule?.frequency !== undefined) {
        expect(clause.schedule.frequency).toBe(2);
      }
      for (const rows of projections(parsed)) {
        expect(rows).toHaveLength(1);
        expect(dose(rows[0])).toMatchObject({ value: 1, unit: "tab" });
        expect(rows[0].route?.text).toBe("by mouth");
        expect(repeat(rows[0])?.when).toEqual(expectedWhen);
        expect(repeat(rows[0])?.offset).toBeUndefined();
        expect(repeat(rows[0])?.count).toBeUndefined();
        expect(repeat(rows[0])?.boundsDuration).toMatchObject({ value: 7, code: "d" });
        if (expectedWhen.length === 1) expect(repeat(rows[0])?.frequency).toBe(2);
      }
      const strict = toFhirR5Dosages(parsed.fhirNext);
      expect(formatSig(strict, "long")).toMatch(/after (?:breakfast|meals)/iu);
      expect(formatSig(strict, "long", { locale: "th" })).toContain("หลังอาหาร");
    }
  );

  it.each([
    ["หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน ตาซ้าย 1 หยดวันละ 2 ครั้ง", true],
    ["หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน; ตาซ้าย 1 หยดวันละ 2 ครั้ง", true],
    ["หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน. ตาซ้าย 1 หยดวันละ 2 ครั้ง", true],
    ["หยอดตาขวา 1 หยดวันละ 4 ครั้ง 7 วัน และหยอดตาซ้าย 1 หยดวันละ 2 ครั้ง", true],
    ["หยอดตาขวา 1 หยดวันละ 4 ครั้ง, ตาซ้าย 1 หยดวันละ 2 ครั้ง", false],
    ["หยอดตาขวา 1 หยด วันละ 4 ครั้ง ตาซ้าย 1 หยด วันละ 2 ครั้ง", false],
    ["หยอดตาขวา 1 หยด วันละ 4 ครั้ง 7 วัน; ตาซ้าย 1 หยด วันละ 2 ครั้ง", true],
    ["OD 1 drop QID for 7 days; OS 1 drop BID", true],
    ["Right eye 1 drop QID for 7 days left eye 1 drop BID", true],
    ["OD 1 drop QID x7d OS 1 drop BID", true]
  ] as const)("does not merge independently dosed right- and left-eye instructions: %s",
    (source, rightHasCourse) => {
      const parsed = parseSig(source);
      expectSourceBacked(source, parsed);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.site?.text))
        .toEqual(["right eye", "left eye"]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.dose))
        .toEqual([{ value: 1, unit: "drop" }, { value: 1, unit: "drop" }]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule?.frequency))
        .toEqual([4, 2]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.route?.text))
        .toEqual(["ophthalmic", "ophthalmic"]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule?.count))
        .toEqual([undefined, undefined]);
      expect(parsed.items[0].meta.canonical.clauses[0]?.schedule?.duration)
        .toBe(rightHasCourse ? 7 : undefined);
      expect(parsed.items[1].meta.canonical.clauses[0]?.schedule?.duration).toBeUndefined();
      for (const rows of projections(parsed)) {
        expect(rows).toHaveLength(2);
        const right = rows.find(row => site(row) === "right eye");
        const left = rows.find(row => site(row) === "left eye");
        expect(right).toBeDefined();
        expect(left).toBeDefined();
        expect(dose(right!)).toMatchObject({ value: 1, unit: "drop" });
        expect(dose(left!)).toMatchObject({ value: 1, unit: "drop" });
        expect(repeat(right!)).toMatchObject({ frequency: 4, period: 1, periodUnit: "d" });
        expect(repeat(left!)).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
        expect(repeat(right!)?.count).toBeUndefined();
        expect(repeat(left!)?.count).toBeUndefined();
        expect(repeat(right!)?.boundsDuration?.value).toBe(rightHasCourse ? 7 : undefined);
        expect(repeat(left!)?.boundsDuration).toBeUndefined();
        expect([right!.route?.text, left!.route?.text]).toEqual(["ophthalmic", "ophthalmic"]);
      }
      const strict = toFhirR5Dosages(parsed.fhirNext);
      const defaultDisplay = formatSig(strict, "long");
      expect(defaultDisplay).toContain("right eye");
      expect(defaultDisplay).toContain("left eye");
      const thaiDisplay = formatSig(strict, "long", { locale: "th" });
      expect(thaiDisplay).toContain("ตาขวา");
      expect(thaiDisplay).toContain("ตาซ้าย");
    }
  );

  it("keeps a compact period between complete OD and OS doses without splitting the decimal", () => {
    const source = "OD 0.5 drop BID.OS 1 drop QID";
    const parsed = parseSig(source);
    expectSourceBacked(source, parsed);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.dose))
      .toEqual([{ value: 0.5, unit: "drop" }, { value: 1, unit: "drop" }]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.site?.text))
      .toEqual(["right eye", "left eye"]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule?.frequency))
      .toEqual([2, 4]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.route?.text))
      .toEqual(["ophthalmic", "ophthalmic"]);
    for (const rows of projections(parsed)) {
      expect(rows).toHaveLength(2);
      expect(rows.map(row => dose(row))).toMatchObject([
        { value: 0.5, unit: "drop" }, { value: 1, unit: "drop" }
      ]);
      expect(rows.map(row => site(row))).toEqual(["right eye", "left eye"]);
      expect(rows.map(row => repeat(row)?.frequency)).toEqual([2, 4]);
      expect(rows.map(row => repeat(row)?.count)).toEqual([undefined, undefined]);
      expect(rows.map(row => row.route?.text)).toEqual(["ophthalmic", "ophthalmic"]);
    }
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(formatSig(strict, "long")).toMatch(/right eye[\s\S]*left eye/iu);
    expect(formatSig(strict, "long", { locale: "th" })).toMatch(/ตาขวา[\s\S]*ตาซ้าย/u);
  });

  it.each([
    ["หยอดตาขวา 1 หยด ทุก 2 ชั่วโมง 7 วัน แล้วลดเหลือวันละ 4 ครั้ง อีก 7 วัน", true],
    ["หยอดตาขวา 1 หยดทุก 2 ชั่วโมง 7 วัน แล้วลดเหลือวันละ 4 ครั้ง", false],
    ["หยอดตาขวา 1 หยดทุก 2 ชั่วโมง 7 วัน แล้วลดเหลือวันละ 4 ครั้ง อีก 7 วัน", true],
    ["หยอดตาขวา 1 หยด ทุก 2 ชั่วโมง 7 วัน แล้วลดเหลือวันละ 4 ครั้ง 7 วัน", true],
    ["หยอดตาขวา 1 หยดทุก 2 ชั่วโมง 7 วัน แล้วลดเหลือวันละ 4 ครั้งเป็นเวลา 7 วัน", true],
    ["OD 1 drop q2h x 7d then QID x7d", true],
    ["หยอดตาขวา 1 หยด ทุก 2 ชั่วโมง 7 วัน แล้ววันละ 4 ครั้ง อีก 7 วัน", true],
    ["หยอดตาขวา 1 หยด ทุก 2 ชั่วโมงเป็นเวลา 7 วัน แล้วลดเหลือวันละ 4 ครั้งอีก 7 วัน", true]
  ] as const)("keeps the q2h course and later QID course as two right-eye phases: %s",
    (source, secondHasCourse) => {
      const parsed = parseSig(source);
      expectSourceBacked(source, parsed);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.fhirNext.step).toHaveLength(2);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.dose))
        .toEqual([{ value: 1, unit: "drop" }, { value: 1, unit: "drop" }]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.site?.text))
        .toEqual(["right eye", "right eye"]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.route?.text))
        .toEqual(["ophthalmic", "ophthalmic"]);
      const canonicalSchedules = parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule);
      expect(canonicalSchedules[0]).toMatchObject({
        period: 2, periodUnit: "h", duration: 7, durationUnit: "d"
      });
      expect(canonicalSchedules[0]?.count).toBeUndefined();
      expect(canonicalSchedules[1]).toMatchObject({ frequency: 4, period: 1, periodUnit: "d" });
      expect(canonicalSchedules[1]?.count).toBeUndefined();
      expect(canonicalSchedules[1]?.duration).toBe(secondHasCourse ? 7 : undefined);
      for (const rows of projections(parsed)) {
        expect(rows).toHaveLength(2);
        expect(rows.map(row => dose(row))).toMatchObject([
          { value: 1, unit: "drop" }, { value: 1, unit: "drop" }
        ]);
        expect(rows.map(row => site(row))).toEqual(["right eye", "right eye"]);
        expect(rows.map(row => row.route?.text)).toEqual(["ophthalmic", "ophthalmic"]);
        expect(repeat(rows[0])).toMatchObject({
          period: 2, periodUnit: "h", boundsDuration: { value: 7, code: "d" }
        });
        expect(repeat(rows[0])?.count).toBeUndefined();
        expect(repeat(rows[1])).toMatchObject({ frequency: 4, period: 1, periodUnit: "d" });
        expect(repeat(rows[1])?.count).toBeUndefined();
        expect(repeat(rows[1])?.boundsDuration?.value).toBe(secondHasCourse ? 7 : undefined);
      }
      expect(toFhirR5Dosages(parsed.fhirNext).map(row => row.sequence)).toEqual([1, 2]);
      const strict = toFhirR5Dosages(parsed.fhirNext);
      expect(formatSig(strict, "long")).toMatch(/every 2 hours[\s\S]*four times daily/iu);
      expect(formatSig(strict, "long", { locale: "th" }))
        .toMatch(/ทุก 2 ชั่วโมง[\s\S]*วันละ 4 ครั้ง/u);
    }
  );

  it.each([
    "ทาที่ผื่นวันละ 2 ครั้ง 7 วัน แล้วลดเหลือวันละครั้งอีก 7 วัน",
    "ทาที่ผื่นวันละ 2 ครั้ง 7 วัน แล้วลดเหลือวันละครั้ง อีก 7 วัน",
    "ทาที่ผื่นวันละ 2 ครั้ง 7 วัน แล้วลดเหลือวันละ 1 ครั้ง อีก 7 วัน",
    "ทาที่ผื่นวันละ 2 ครั้งเป็นเวลา 7 วัน แล้วลดเหลือวันละครั้ง อีก 7 วัน",
    "ทาครีมที่ผื่นวันละ 2 ครั้ง 7 วัน แล้ววันละ 1 ครั้งอีก 7 วัน",
    "apply to rash BID for 7 days then QD for 7 days",
    "ทาบริเวณผื่น วันละ 2 ครั้ง นาน 7 วัน จากนั้น วันละ 1 ครั้ง อีก 7 วัน"
  ])("keeps topical BID then QD as two seven-day rash phases: %s", source => {
    const parsed = parseSig(source);
    expectSourceBacked(source, parsed);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.site?.text))
      .toEqual(["rash", "rash"]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.route?.text))
      .toEqual(["topical", "topical"]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule)).toEqual([
      expect.objectContaining({ frequency: 2, period: 1, periodUnit: "d", duration: 7, durationUnit: "d" }),
      expect.objectContaining({ frequency: 1, period: 1, periodUnit: "d", duration: 7, durationUnit: "d" })
    ]);
    for (const rows of projections(parsed)) {
      expect(rows).toHaveLength(2);
      expect(rows.map(row => site(row))).toEqual(["rash", "rash"]);
      expect(rows.map(row => row.route?.text)).toEqual(["topical", "topical"]);
      expect(rows.map(row => repeat(row)?.frequency)).toEqual([2, 1]);
      expect(rows.map(row => repeat(row)?.boundsDuration?.value)).toEqual([7, 7]);
      expect(rows.map(row => repeat(row)?.count)).toEqual([undefined, undefined]);
    }
    expect(toFhirR5Dosages(parsed.fhirNext).map(row => row.sequence)).toEqual([1, 2]);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(formatSig(strict, "long")).toMatch(/twice daily[\s\S]*once daily/iu);
    expect(formatSig(strict, "long", { locale: "th" }))
      .toMatch(/วันละ 2 ครั้ง[\s\S]*วันละ(?: 1)?ครั้ง/u);
  });

  it.each([
    ["รับประทาน 1 เม็ดตอนเช้า และ 2 เม็ดตอนเย็น", "tab", "by mouth", "Take"],
    ["ฉีด 5 ยูนิตใต้ผิวหนังก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น", "U", "subcutaneous", "Inject"]
  ] as const)("inherits an explicit route across a Thai dose-and-daypart conjunction: %s",
    (source, unit, expectedRoute, expectedMethod) => {
    const parsed = parseSig(source);
    expectSourceBacked(source, parsed);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.dose))
      .toEqual([{ value: unit === "tab" ? 1 : 5, unit }, { value: unit === "tab" ? 2 : 8, unit }]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule?.when))
      .toEqual(unit === "tab" ? [["MORN"], ["EVE"]] : [["ACM"], ["ACV"]]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.route?.text))
      .toEqual([expectedRoute, expectedRoute]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.method?.text))
      .toEqual([expectedMethod, expectedMethod]);
    for (const rows of projections(parsed)) {
      expect(rows.map(row => dose(row)?.value)).toEqual(unit === "tab" ? [1, 2] : [5, 8]);
      expect(rows.map(row => repeat(row)?.when))
        .toEqual(unit === "tab" ? [["MORN"], ["EVE"]] : [["ACM"], ["ACV"]]);
      expect(rows.map(row => row.route?.text)).toEqual([expectedRoute, expectedRoute]);
      expect(rows.map(row => row.method?.text)).toEqual([expectedMethod, expectedMethod]);
    }
  });

  it.each([
    ["ฉีดอินซูลิน 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น " +
      "งดอาหารเย็นหากน้ำตาลต่ำกว่า 70", "งดอาหารเย็น"],
    ["ฉีดอินซูลิน 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น " +
      "งดอาหารมื้อเย็นหากน้ำตาลต่ำกว่า 70", "งดอาหารมื้อเย็น"],
    ["ฉีดอินซูลิน 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น " +
      "งดอาหารหากน้ำตาลต่ำกว่า 70", "งดอาหาร"],
    ["ฉีดอินซูลิน 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น " +
      "งดน้ำหากน้ำตาลต่ำกว่า 70", "งดน้ำ"],
    ["Inject 5 units before breakfast and 8 units before dinner; " +
      "avoid dinner if glucose below 70", "avoid dinner"]
  ] as const)("does not turn food or water avoidance into a medication guard: %s",
    (source, avoidanceText) => {
      const parsed = parseSig(source);
      expectSourceBacked(source, parsed);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.dose))
        .toEqual([{ value: 5, unit: "U" }, { value: 8, unit: "U" }]);
      expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule?.when))
        .toEqual([["ACM"], ["ACV"]]);
      expect(parsed.items[1].meta.canonical.clauses[0]?.rawText).toContain(avoidanceText);
      expect(parsed.items[1].meta.canonical.clauses[0]?.instructionGraph?.actions)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            predicate: expect.objectContaining({ semanticClass: "avoidance" })
          })
        ]));
      for (const rows of projections(parsed)) {
        expect(rows).toHaveLength(2);
        expect(rows.map(row => dose(row)?.value)).toEqual([5, 8]);
        expect(rows.map(row => repeat(row)?.when)).toEqual([["ACM"], ["ACV"]]);
        expect(getDosageCondition(rows[0])).toBeUndefined();
        expect(getDosageCondition(rows[1])).toBeUndefined();
      }
    }
  );

  it("binds a Thai dinner-only withholding condition to the before-dinner dose", () => {
    const source = "ฉีดอินซูลิน 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น " +
      "งดมื้อเย็นหากน้ำตาลต่ำกว่า 70";
    const parsed = parseSig(source);
    expectSourceBacked(source, parsed);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.dose))
      .toEqual([{ value: 5, unit: "U" }, { value: 8, unit: "U" }]);
    expect(parsed.items.map(item => item.meta.canonical.clauses[0]?.schedule?.when))
      .toEqual([["ACM"], ["ACV"]]);
    expect(parsed.items[0].meta.canonical.clauses[0]?.clinicalAdjuncts?.condition)
      .toBeUndefined();
    expect(parsed.items[1].meta.canonical.clauses[0]?.clinicalAdjuncts?.condition)
      .toMatchObject({
        kind: "not", condition: {
          kind: "measurement", name: "glucose", operation: "lt", value: 70
        }
      });
    for (const rows of projections(parsed)) {
      expect(rows).toHaveLength(2);
      expect(rows.map(row => dose(row)?.value)).toEqual([5, 8]);
      expect(rows.map(row => repeat(row)?.when)).toEqual([["ACM"], ["ACV"]]);
      expect(getDosageCondition(rows[0])).toBeUndefined();
      expect(getDosageCondition(rows[1])).toMatchObject({
        kind: "not", condition: {
          kind: "measurement", name: "glucose", operation: "lt", value: 70
        }
      });
    }
  });
});

describe("final-cleanup independent clinical oracles", () => {
  it.each([
    {
      source: "ฉีดอินซูลิน 5 ยูนิตใต้ผิวหนังที่หน้าท้องหรือต้นขา " +
        "สลับตำแหน่งทุกครั้ง ห้ามฉีดบริเวณที่ช้ำ",
      site: /abdomen.*thigh/iu,
      prohibition: "ห้ามฉีดบริเวณที่ช้ำ",
      excludedSite: /ช้ำ|bruis/iu,
      rotates: true
    },
    {
      source: "ฉีดอินซูลิน 5 ยูนิตใต้ผิวหนังที่หน้าท้อง ห้ามฉีดบริเวณที่เป็นแผล",
      site: /abdomen/iu,
      prohibition: "ห้ามฉีดบริเวณที่เป็นแผล",
      excludedSite: /แผล|wound/iu,
      rotates: false
    }
  ])("retains the complete negated injection-site exclusion: $prohibition", ({
    source, site, prohibition, excludedSite, rotates
  }) => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 5, unit: "U" });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe("34206005");
    expect(parsed.fhir.site?.text).toMatch(site);
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);

    const actions = parsed.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []);
    expect(actions).toContainEqual(expect.objectContaining({
      polarity: AdvicePolarity.Negate,
      sourceText: prohibition,
      predicate: expect.objectContaining({ lemma: "inject" })
    }));
    expect(actions.some(action => action.predicate.lemma === "rotate")).toBe(rotates);
    expect(parsed.fhir.additionalInstruction).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: prohibition })
    ]));

    for (const rendered of [
      parsed.longText,
      formatSig(parsed.fhirNext, "long", { locale: "en" })
    ]) {
      expect(rendered).toMatch(excludedSite);
    }

    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict[0]?.additionalInstruction).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: prohibition })
    ]));
    const loaded = fromFhir(toDosageDetails(strict));
    expect(loaded.fhir[0]?.additionalInstruction).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: prohibition })
    ]));
  });

  it("keeps both sequential infusion amounts and their own administration durations", () => {
    const source = "Infuse 50 mL over 30 min, then 25 mL over 60 min; " +
      "do not combine as one rate.";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity))
      .toMatchObject([{ value: 50, code: "mL" }, { value: 25, code: "mL" }]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.rateRatio))
      .toMatchObject([
        { numerator: { value: 50, code: "mL" }, denominator: { value: 30, code: "min" } },
        { numerator: { value: 25, code: "mL" }, denominator: { value: 60, code: "min" } }
      ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat)).toMatchObject([
      { count: 1, duration: 30, durationUnit: "min" },
      { count: 1, duration: 60, durationUnit: "min" }
    ]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.boundsDuration))
      .toEqual([undefined, undefined]);
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule)).toMatchObject([
      { count: 1, administrationDuration: 30, administrationDurationUnit: "min" },
      { count: 1, administrationDuration: 60, administrationDurationUnit: "min" }
    ]);
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.duration))
      .toEqual([undefined, undefined]);
    expect(parsed.fhir.additionalInstruction?.some(item =>
      /do not combine as one rate/iu.test(item.text ?? "")
    )).toBe(true);

    const strict = toFhirR5Dosages(parsed.fhirNext);
    const loaded = fromFhir(toDosageDetails(strict));
    for (const rows of [strict, loaded.fhir]) {
      expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([50, 25]);
      expect(rows.map(row => row.doseAndRate?.[0]?.rateRatio?.denominator?.value))
        .toEqual([30, 60]);
      expect(rows.map(row => row.timing?.repeat?.duration)).toEqual([30, 60]);
      expect(rows.map(row => row.timing?.repeat?.durationUnit)).toEqual(["min", "min"]);
      expect(rows.map(row => row.timing?.repeat?.boundsDuration)).toEqual([undefined, undefined]);
    }
  });

  it("keeps a course duration distinct from a single infusion duration", () => {
    const infusion = parseSig("Infuse 50 mL over 30 minutes IV").fhir.timing?.repeat;
    expect(infusion).toMatchObject({ count: 1, duration: 30, durationUnit: "min" });
    expect(infusion?.boundsDuration).toBeUndefined();

    const course = parseSig("Take 1 tablet daily for 7 days").fhir.timing?.repeat;
    expect(course).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      boundsDuration: { value: 7, code: "d" }
    });
    expect(course?.duration).toBeUndefined();
  });

  it("keeps an unknown symptom course as ordered source-backed advice, not an executable end", () => {
    const source = "Take one tablet daily until itching resolves, then stop unless rash returns.";
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d"
    });
    expect(parsed.fhir.timing?.repeat?.boundsPeriod?.end).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(getDosageCondition(parsed.fhir)).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    const advice = parsed.fhir.additionalInstruction?.map(item => item.text ?? "") ?? [];
    expect(advice.some(text => /until itching resolves/iu.test(text))).toBe(true);
    expect(advice.some(text => /stop unless rash returns/iu.test(text))).toBe(true);

    const strict = toFhirR5Dosages(parsed.fhirNext);
    const loaded = fromFhir(toDosageDetails(strict));
    for (const rendered of [
      parsed.longText,
      formatSig(parsed.fhirNext, "long", { locale: "en" }),
      loaded.longText
    ]) {
      const normalized = rendered.toLowerCase();
      expect(normalized).toContain("until itching resolves");
      expect(normalized).toContain("stop unless rash returns");
      expect(normalized.indexOf("until itching resolves"))
        .toBeLessThan(normalized.indexOf("stop unless rash returns"));
      expect(normalized.match(/rash returns/gu)).toHaveLength(1);
    }
  });
});

describe("HPSG count cardinal semantics", () => {
  it.each([
    ["left eye", "1290031003"],
    ["right eye", "1290032005"],
    ["both eyes", "40638003"]
  ])("keeps the exact coded %s site before a typed maximum-count constituent", (site, code) => {
    const parsed = parseSig(`instill 1 drop in ${site} at most three times`);
    expect(parsed.fhir.site).toMatchObject({
      text: site,
      coding: [{ system: "http://snomed.info/sct", code }]
    });
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?._count?.extension).toContainEqual({
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ countMax: 3 });
    expect(parsed.meta.canonical.clauses[0]?.site?.text).toBe(site);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each(["at most", "up to", "max", "maximum"])(
    "preserves the typed %s count cap after a PRN reason without absorbing either constituent",
    lead => {
      const parsed = parseSig(`1 tab q4h prn pain ${lead} three times`);
      expect(parsed.fhir.asNeeded).toBe(true);
      expect(parsed.fhir.asNeededFor?.[0]?.text).toBe("pain");
      expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
      expect(parsed.fhir.timing?.repeat?._count?.extension).toContainEqual({
        url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
      });
      expect(parsed.fhir.timing?.repeat).toMatchObject({ countMax: 3,
        period: 4,
        periodUnit: "h"
      });
      expect(parsed.meta.leftoverText).toBeUndefined();
    }
  );

  it.each([
    "1 tab q6h for 3 doses",
    "1 tab q6h for three doses",
    "1 tab q6h three doses total",
    "1 tab q6h total three doses"
  ])("preserves an exact total count without depending on numeric token values: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      count: 3,
      period: 6,
      periodUnit: "h"
    });
    expect(parsed.meta.canonical.clauses[0]?.schedule?.count).toBe(3);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("preserves spelled maximum and periodic occurrence caps", () => {
    const total = parseSig("1 tab q6h max three doses");
    expect(total.fhir.timing?.repeat?.count).toBeUndefined();
    expect(total.fhir.timing?.repeat?._count?.extension).toContainEqual({
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    });
    expect(total.fhir.timing?.repeat).toMatchObject({ countMax: 3 });
    expect(total.meta.leftoverText).toBeUndefined();

    const daily = parseSig("1 tab q4h prn pain max three doses daily");
    expect(daily.meta.canonical.clauses[0]?.schedule?.occurrenceCap).toEqual({
      max: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(daily.fhir.timing?.repeat?.countMax).toBeUndefined();
  });

  it.each([
    "1 tab q6h for 3-5 doses",
    "1 tab q6h total 3-5 doses"
  ])("keeps the q6h suggestion and recoverable range instead of inventing an exact count: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.timing?.repeat).toMatchObject({ period: 6, periodUnit: "h" });
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.countMax).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.count).toBeUndefined();
    expect(parsed.fhir.text).toContain("3-5 doses");
    expect(parsed.meta.leftoverText).toContain("3-5 doses");
    expect(lintSig(source).issues).toContainEqual(expect.objectContaining({
      message: "Unrecognized text",
      text: expect.stringContaining("3-5 doses")
    }));
    expect(nextDueDoses(parsed, {
      from: "2026-10-22T08:00:00+07:00",
      orderedAt: "2026-10-22T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 3
    })).toEqual([
      "2026-10-22T08:00:00+07:00",
      "2026-10-22T14:00:00+07:00",
      "2026-10-22T20:00:00+07:00"
    ]);
  });

  it("keeps an explicit maximum range recoverable beside the q6h suggestion", () => {
    const parsed = parseSig("1 tab q6h max 3-5 doses");
    expect(parsed.fhir.timing?.repeat).toMatchObject({ period: 6, periodUnit: "h" });
    // The typed cadence is already executable; an unresolved 3–5 maximum
    // remains in the exact clinician source rather than being paraphrased
    // into a falsely precise instruction.
    expect(parsed.fhir.timing?.code?.text).toBe("Q6H");
    expect(parsed.fhir.text).toBe("1 tab q6h max 3-5 doses");
    expect(parsed.meta.leftoverText).toContain("max 3-5 doses");
    expect(nextDueDoses(parsed, {
      from: "2026-10-22T08:00:00+07:00",
      orderedAt: "2026-10-22T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 3
    })).toEqual([
      "2026-10-22T08:00:00+07:00",
      "2026-10-22T14:00:00+07:00",
      "2026-10-22T20:00:00+07:00"
    ]);
  });

  it("uses a spelled cadence-first count as frequency, not total administrations", () => {
    const parsed = parseSig("1 tab daily three times");
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("continues to accept word-valued intervals and ranged durations", () => {
    const interval = parseSig("1 tab every three hours");
    expect(interval.fhir.timing?.repeat).toMatchObject({ period: 3, periodUnit: "h" });

    const duration = parseSig("1 tab daily for 7-14 days");
    expect(duration.fhir.timing?.repeat?.boundsRange).toEqual({
      low: { value: 7, unit: "days", code: "d", system: "http://unitsofmeasure.org" },
      high: { value: 14, unit: "days", code: "d", system: "http://unitsofmeasure.org" }
    });
  });
});

describe("HPSG weekly cadence and exact weekday alternatives", () => {
  it("never rewrites an explicitly prescribed once-weekly frequency to twice-weekly", () => {
    const input = "take 1 tab once weekly on Monday and Thursday at 09:00";
    const result = parseSig(input);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].fhir.timing?.repeat)
      .toMatchObject({ frequency: 1, period: 1, periodUnit: "wk", dayOfWeek: ["mon", "thu"] });
    expect(result.items[0].fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(result.items[0].fhir.text).toContain("Monday and Thursday");
    expect(nextDueDoses(result.fhir, {
      from: "2026-10-22T08:00:00+07:00",
      orderedAt: "2026-10-22T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 3
    })).toEqual([
      "2026-10-22T09:00:00+07:00",
      "2026-10-26T09:00:00+07:00",
      "2026-10-29T09:00:00+07:00"
    ]);
  });

  it("uses exact external weekday anchors without deleting the stated frequency", () => {
    const dosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: "wk" as const,
        dayOfWeek: ["mon", "thu"] as ["mon", "thu"],
        timeOfDay: ["09:00"]
      } }
    };
    const from = "2026-10-22T08:00:00+07:00";
    expect(dosage.timing.repeat).toMatchObject({
      frequency: 1, dayOfWeek: ["mon", "thu"], timeOfDay: ["09:00"]
    });
    expect(nextDueDoses(dosage, {
      from, orderedAt: from, timeZone: "Asia/Bangkok", limit: 3
    })).toEqual([
      "2026-10-22T09:00:00+07:00",
      "2026-10-26T09:00:00+07:00",
      "2026-10-29T09:00:00+07:00"
    ]);
    expect(calculateTotalUnits({
      dosage, from, orderedAt: from, timeZone: "Asia/Bangkok",
      durationValue: 14, durationUnit: "d"
    })).toMatchObject({ totalUnits: 4, unit: "tab" });
  });

  it("retains compatible explicit twice-weekly meaning", () => {
    const p = parseSig("take 1 tab twice weekly on Monday and Thursday");
    expect(p.items[0].fhir.timing?.repeat).toMatchObject({
      frequency: 2, period: 1, periodUnit: "wk", dayOfWeek: ["mon", "thu"]
    });
    expect(p.items[0].fhir.text).toContain("Monday and Thursday");
  });
});


describe("clinical composition usability regressions", () => {
  const scheduleOptions = {
    from: "2026-10-23T08:00:00+07:00", orderedAt: "2026-10-23T08:00:00+07:00",
    timeZone: "Asia/Bangkok", limit: 20
  };

  it.each([
    "Apply cream to rash once nightly for 7 days",
    "Take 1 tablet once nightly for 7 days"
  ])("interprets once per daily event rather than once per course: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d", when: ["NIGHT"],
      boundsDuration: { value: 7, code: "d" }
    });
    expect(parsed.fhir.timing?.repeat?.count).toBeUndefined();
    expect(nextDueDoses(parsed, scheduleOptions)).toHaveLength(7);
  });

  it.each([
    "Take 1 tab PO Monday-Wednesday-Friday at 10 AM",
    "Take 1 tab PO Mon-Wed-Fri at 10 AM"
  ])("keeps a multi-day enumeration distinct from a weekday range: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.timing?.repeat?.dayOfWeek).toEqual(["mon", "wed", "fri"]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const due = nextDueDoses(parsed, { ...scheduleOptions, limit: 4 });
    expect(due.map(value => new Date(value).getUTCDay())).toEqual([5, 1, 3, 5]);
  });
});


describe("administration and procedure event ownership", () => {
  it("keeps an immediate loading dose separate from four subsequent maintenance doses", () => {
    const parsed = parseSig("take 2 tabs now then 1 tab q12h for 4 doses");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 1]);
    const second = parsed.items[1].fhir;
    expect(second.timing?.repeat).toMatchObject({ period: 12, periodUnit: "h", count: 4 });
    expect(second.timing?.repeat?.when ?? []).not.toContain("IMD");
    const due = nextDueDoses(parsed, {
      from: "2026-10-23T08:00:00+07:00", orderedAt: "2026-10-23T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 10
    });
    expect(due).toHaveLength(5);
    expect(due.map(value => (new Date(value).getTime() - new Date(due[0]).getTime()) / 3_600_000))
      .toEqual([0, 12, 24, 36, 48]);
  });

  it("structures both infusion rates as distinct sequential administrations", () => {
    const parsed = parseSig("Infuse 3 mcg/kg/min for 4 hours, then 5 mcg/kg/min");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.rateQuantity))
      .toMatchObject([{ value: 3, code: "ug/kg/min" }, { value: 5, code: "ug/kg/min" }]);
    expect(parsed.items[0].fhir.timing?.repeat).toMatchObject({ duration: 4, durationUnit: "h" });
    expect(parsed.longText).not.toContain("Take then");
  });

  it.each([
    "Rinse mouth after inhaling 2 puffs twice daily",
    "Inhale 2 puffs twice daily then rinse mouth"
  ])("assigns the dose and cadence to inhalation, not rinsing: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "puff" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.fhir.method?.coding?.[0]?.code).toBe("740666001");
    const text = parsed.longText.toLowerCase();
    expect(text.indexOf("inhale")).toBeLessThan(text.indexOf("rinse"));
    expect(text).not.toMatch(/after;|; after|then.*then/);
    expect(parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
      .some(action => action.predicate.lemma.startsWith("rinse"))).toBe(true);
  });

  it("keeps the observation interval on the observation event", () => {
    const parsed = parseSig("Give 10 mL by mouth once and observe for 30 minutes");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 10, unit: "mL" });
    expect(parsed.fhir.timing?.repeat?.count).toBe(1);
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.duration).toBeUndefined();
    const observe = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
      .find(action => action.predicate.lemma === "observe");
    expect(observe?.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Duration, quantity: expect.objectContaining({ value: 30, unit: "min" })
    }));
  });

  it("negates both coordinated actions rather than emitting an affirmative drink command", () => {
    const parsed = parseSig("Do not eat or drink for 30 minutes");
    const actions = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? []);
    const coordinated = actions.filter(action => ["eat", "eat-food", "drink"].includes(action.predicate.lemma));
    expect(coordinated).toHaveLength(2);
    expect(coordinated.every(action => action.polarity === AdvicePolarity.Negate)).toBe(true);
    expect(parsed.longText.toLowerCase()).toContain("do not drink");
    expect(formatSig(parsed.fhir, "long", { locale: "en" }).toLowerCase()).toContain("do not drink");
    expect(parsed.fhir.method?.text?.toLowerCase()).not.toBe("drink");
    const safety = parsed.fhir.additionalInstruction?.map(value => value.text?.toLowerCase()) ?? [];
    expect(safety.some(value => value?.startsWith("do not drink"))).toBe(true);
    expect(safety.every(value => !value?.startsWith("drink"))).toBe(true);
    expect(parsed.meta.canonical.clauses[0]?.additionalInstructions
      ?.find(value => value.frames?.some(frame => frame.predicate.lemma === "drink"))
      ?.i18n?.th).toContain("ห้าม");
  });

  it("retains a spelled-out waiting interval as a structured procedural duration", () => {
    const parsed = parseSig("Wait five minutes between eye drops");
    const action = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
      .find(action => action.predicate.lemma === "wait");
    expect(action?.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Duration, quantity: expect.objectContaining({ value: 5, unit: "min" })
    }));
    expect(parsed.longText.toLowerCase()).toContain("5 minutes");
  });
});


it("preserves a genuinely single administration at bedtime", () => {
  const parsed = parseSig("Take 1 tablet once at bedtime");
  expect(parsed.fhir.timing?.repeat?.count).toBe(1);
  const due = nextDueDoses(parsed, {
    from: "2026-10-23T08:00:00+07:00", orderedAt: "2026-10-23T08:00:00+07:00",
    timeZone: "Asia/Bangkok", limit: 10
  });
  expect(due).toHaveLength(1);
});

it("retains a two-endpoint weekday range rather than treating it as two isolated days", () => {
  const parsed = parseSig("Take 1 tablet Mon-Fri at 10 AM");
  expect(parsed.fhir.timing?.repeat?.dayOfWeek).toEqual(["mon", "tue", "wed", "thu", "fri"]);
});


describe("elliptic target administrations with an explicit waiting interval", () => {
  it.each([
    ["Apply 1 drop right eye at 08:00, wait 5 minutes, then left eye", "08:00", "08:05"],
    ["Instill 2 drops left eye at 08:00, wait 10 minutes, then right eye", "08:00", "08:10"]
  ])("retains both administered targets and their dependency: %s", (source, first, second) => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual(source.includes("2 drops") ? [2, 2] : [1, 1]);
    expect(new Set(parsed.items.map(item => item.fhir.site?.coding?.[0]?.code)).size).toBe(2);
    expect(parsed.longText).not.toContain("Take then");
    const due = nextDueDoses(parsed, {
      from: "2026-10-23T07:00:00+07:00", orderedAt: "2026-10-23T07:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 4
    });
    expect(due.map(value => value.slice(11, 16))).toEqual([first, second, first, second]);
    expect(parsed.longText).toContain(second.replace(/^0/u, "") + " am");
  });

  it("accepts clinically elliptical exact clock and waiting interval without punctuation", () => {
    const parsed = parseSig("Put 1 drop right eye 23:58 wait 5 min then left eye");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 1]);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(nextDueDoses(parsed, {
      from: "2026-10-23T23:00:00+07:00",
      orderedAt: "2026-10-23T23:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 2
    }).map(value => value.slice(0, 16))).toEqual([
      "2026-10-23T23:58", "2026-10-24T00:03"
    ]);
  });

  it("retains a counted pronoun and explicit repeated verb in the dependent eye administration", () => {
    const source = "Put 1 drop in right eye at 23:58, wait 5 minutes, then put one in left eye; do not touch the tip to either eye";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity)).toEqual([
      expect.objectContaining({ value: 1, unit: "drop" }),
      expect.objectContaining({ value: 1, unit: "drop" })
    ]);
    expect(parsed.items.map(item => item.fhir.site?.text)).toEqual(["right eye", "left eye"]);
    expect(nextDueDoses(parsed, {
      from: "2026-10-23T23:00:00+07:00", orderedAt: "2026-10-23T23:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 2
    }).map(value => value.slice(0,16))).toEqual(["2026-10-23T23:58", "2026-10-24T00:03"]);
    expect(parsed.longText.toLowerCase()).toContain("do not touch");
  });

  it("moves the dependent administration across midnight without shifting its predecessor", () => {
    const parsed = parseSig("Apply 1 drop right eye at 23:58, wait 5 minutes, then left eye");
    expect(parsed.items).toHaveLength(2);
    const due = nextDueDoses(parsed, {
      from: "2026-10-23T23:00:00+07:00", orderedAt: "2026-10-23T23:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 2
    });
    expect(due.map(value => value.slice(0, 16))).toEqual(["2026-10-23T23:58", "2026-10-24T00:03"]);
  });
});


describe("course execution agrees across schedule, supply, and FHIR representations", () => {
  const options = {
    from: "2026-10-23T08:00:00+07:00", orderedAt: "2026-10-23T08:00:00+07:00",
    timeZone: "Asia/Bangkok", limit: 10
  };
  it("counts loading and maintenance tablets without moving the course on a later query", () => {
    const parsed = parseSig("take 2 tabs now then 1 tab q12h for 4 doses");
    expect(calculateTotalUnits({
      ...options, dosage: parsed, durationValue: 3, durationUnit: "d"
    })).toMatchObject({ totalUnits: 6, unit: "tab" });
    const from = "2026-10-24T09:00:00+07:00";
    const later = nextDueDoses(parsed, { ...options, from });
    expect(later.map(value => value.slice(0, 16))).toEqual(["2026-10-24T20:00", "2026-10-25T08:00"]);
    expect(calculateTotalUnits({
      ...options, from, dosage: parsed, durationValue: 3, durationUnit: "d"
    })).toMatchObject({ totalUnits: 2, unit: "tab" });
  });
  it("retains dependent eye administrations through native R6 and R5 serialization", () => {
    const parsed = parseSig("Apply 1 drop right eye at 08:00, wait 5 minutes, then left eye");
    const expected = nextDueDoses(parsed, options);
    for (const representation of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(representation, options)).toEqual(expected);
    }
    expect(nextDueDoses(parsed, { ...options, from: "2026-10-23T08:02:00+07:00", limit: 1 })[0])
      .toBe("2026-10-23T08:05:00+07:00");
    expect(calculateTotalUnits({
      ...options, dosage: parsed, durationValue: 1, durationUnit: "d"
    })).toMatchObject({ totalUnits: 2, unit: "drop" });
    expect(calculateTotalUnits({
      ...options, from: "2026-10-23T08:02:00+07:00", dosage: parsed,
      durationValue: 10, durationUnit: "min"
    })).toMatchObject({ totalUnits: 1, unit: "drop" });
  });
});


describe("ordinary clinical vocabulary uses the same typed constructions", () => {
  it.each([
    ["Take one tablet each Monday, Wednesday and Friday", ["mon", "wed", "fri"], undefined],
    ["Take 1 tab each evening; do not crush", undefined, ["EVE"]]
  ])("composes a distributive temporal nominal: %s", (source, days, events) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    if (days) expect(parsed.fhir.timing?.repeat?.dayOfWeek).toEqual(days);
    if (events) expect(parsed.fhir.timing?.repeat?.when).toEqual(events);
  });
  it.each(["Give 0.1 mg/kg orally as a single dose", "Give 0.2 mg/kg orally as one dose"])(
    "attaches explicit single-administration cardinality: %s", source => {
      const parsed = parseSig(source);
      expect(parsed.fhir.timing?.repeat?.count).toBe(1);
      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.unit).toBe("mg/kg");
      expect(parsed.meta.leftoverText).toBeUndefined();
    });
  it("keeps the first-day bounds on the first eye-drop phase", () => {
    const parsed = parseSig("Put 1 drop right eye every hour for first day then every 4 hours");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].fhir.timing?.repeat?.boundsDuration).toMatchObject({ value: 1, code: "d" });
    expect(parsed.items[0].fhir.asNeeded).not.toBe(true);
    expect(parsed.items[1].fhir.timing?.repeat).toMatchObject({ period: 4, periodUnit: "h" });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it("recognizes nebulization as a registered administration head", () => {
    const parsed = parseSig("Nebulize 2.5 mg every 6 hours PRN dyspnea");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2.5, unit: "mg" });
    expect(parsed.fhir.method?.text?.toLowerCase()).toBe("nebulize");
    expect(parsed.fhir.timing?.repeat).toMatchObject({ period: 6, periodUnit: "h" });
    expect(parsed.fhir.asNeeded).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it.each(["Apply 1 g of cream and cover with dressing daily", "Clean wound, apply 1 g thinly and cover with sterile gauze"])(
    "keeps covering material as an action argument: %s", source => {
      const parsed = parseSig(source);
      const cover = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
        .find(a => a.predicate.lemma === "cover");
      expect(cover?.args.some(a => /dressing|gauze/u.test(a.text ?? ""))).toBe(true);
      expect(parsed.meta.leftoverText).toBeUndefined();
      if (source.endsWith("daily")) {
        expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      } else {
        const clause = parsed.meta.canonical.clauses[0];
        const graph = clause.instructionGraph!;
        expect(clause.dose).toMatchObject({ value: 1, unit: "g" });
        expect(clause.schedule).toBeUndefined();
        expect(graph.sourceText).toBe(source);
        expect(graph.actions.map(action => action.predicate.lemma)).toEqual(["clean", "cover"]);
        expect(graph.primaryAdministrationSpan).toEqual({ start: 13, end: 18 });
        // The omitted Apply head separates the two procedural actions.
        expect(graph.relations).toBeUndefined();
        expect(graph.opaqueSpans).toBeUndefined();
        expect(graph.coverage).toMatchObject({ complete: true, opaqueCharacters: 0 });
        const manner = clause.additionalInstructions?.find(instruction =>
          instruction.coding?.code === "420162004");
        expect(manner?.evidence?.flatMap(evidence => evidence.spans)).toEqual([
          { start: 23, end: 29, text: "thinly" }
        ]);
        const selected = parseInstructionActions(source).find(action => action.predicate.lemma === "apply");
        expect(selected?.args.find(arg => arg.role === AdviceArgumentRole.Manner)?.span)
          .toEqual({ start: 23, end: 29 });
        for (const input of [parsed.meta.canonical.course!,
          JSON.parse(JSON.stringify([parsed.fhir])), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
          const before = JSON.stringify(input);
          expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
            .toBe("Clean the wound; then apply 1 g to the wound; then cover with sterile gauze. Apply thinly.");
          expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
            .toBe("ทำความสะอาดแผล จากนั้นทาบางๆ ครั้งละ 1 g บริเวณแผล จากนั้นปิดคลุมด้วยsterile gauze.");
          const administration = importCanonicalCourse(input).stages[0].administrations[0];
          expect(administration.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "g" });
          expect(administration.syntax?.instructionGraph?.sourceText).toBe(source);
          expect(JSON.stringify(input)).toBe(before);
        }
      }
    });
  it("keeps a route adjective inside a quantified dosage-form phrase", () => {
    const parsed = parseSig("Insert one vaginal tablet and lie down for 15 minutes");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.fhir.site?.text).toBe("vagina");
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it("keeps non-anatomical temporal preferences out of site coding", () => {
    const parsed = parseSig("inject 10 units subcutaneously once daily at same time; rotate injection sites");
    expect(parsed.items[0]?.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 10, unit: "U" });
    expect(parsed.items[0]?.fhir.timing?.repeat).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d"
    });
    expect(parsed.items[0]?.fhir.site).toBeUndefined();
    // Clock time is deliberately unspecified; preserve the preference for
    // clinical review rather than fabricate an executable timeOfDay.
    expect((parsed.meta.leftoverText ?? "") + " " + parsed.longText).toContain("same time");
  });
  it("keeps material complements after their licensed relation just once", () => {
    const parsed = parseSig(
      "shake well before each use, measure 5 mL with oral syringe, take by mouth twice daily"
    );
    const measurement = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
      .find(a => a.predicate.lemma === "measure");
    expect(measurement?.args.some(a => a.role === "material" && a.text === "oral syringe")).toBe(true);
    expect(parsed.longText).toContain("with oral syringe");
    expect(parsed.longText).not.toContain("with with");
  });

  it("does not absorb a following procedure into the anatomical site", () => {
    const parsed = parseSig("Place 1 tab under tongue and let dissolve, do not swallow");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.site?.text).not.toMatch(/and|let/u);
    expect(parsed.longText).not.toContain("and let.");
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


describe("clinical rate durations admit shared number-word morphology", () => {
  it.each([
    ["Infuse 500 mL IV over two hours", 500, 2, "h"],
    ["Administer 250 mL over five minutes IV", 250, 5, "min"],
    ["Infuse 100 mL over thirty minutes IV", 100, 30, "min"],
    ["Give 50 mL IV over fifteen minutes", 50, 15, "min"]
  ])("retains the dose AND ratio for a word-numbered carrier duration: %s",
    (source, amount, duration, unit) => {
      const parsed = parseSig(source);
      expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
        doseQuantity: { value: amount, code: "mL" },
        rateRatio: {
          numerator: { value: amount, code: "mL" },
          denominator: { value: duration, code: unit }
        }
      });
      expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
        representation: "dose-with-rate-ratio",
        administrationDuration: { value: duration, unit }
      });
      expect(parsed.meta.leftoverText).toBeUndefined();
    });
  it("keeps active drug quantity separate from the carrier infusion rate", () => {
    const parsed = parseSig("Infuse 20 mg in 500 mL over four hours IV");
    expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 20, unit: "mg" },
      rateRatio: {
        numerator: { value: 500, code: "mL" },
        denominator: { value: 4, code: "h" }
      }
    });
    expect(parsed.meta.canonical.clauses[0].clinicalQuantity).toMatchObject({
      representation: "dose-with-rate-ratio",
      administrationDuration: { value: 4, unit: "h" }
    });
  });
});

describe("clinical temporal prepositions remain compositional", () => {
  it.each([
    ["Infuse 20 mg/kg over 30 minutes IV once", 20, "mg/kg", 30, "min"],
    ["Administer 250 mL IV over 2 hours once", 250, "mL", 2, "h"]
  ])("attaches the duration to administration without an opaque linker: %s",
    (source, value, unit, duration, durationUnit) => {
      const parsed = parseSig(source);
      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value, unit });
      expect(parsed.fhir.timing?.repeat).toMatchObject({
        count: 1, duration, durationUnit
      });
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.fhir.text).toContain(source);
    });
  it("keeps the same spatial preposition locative when it governs a body site", () => {
    const parsed = parseSig("Apply cream over left elbow at bedtime");
    expect(parsed.fhir.site?.text).toMatch(/elbow/u);
    expect(parsed.fhir.timing?.repeat?.when).toContain("HS");
    expect(parsed.fhir.timing?.repeat?.duration).toBeUndefined();
  });
});


describe("qualitative dosage presentations remain structured without invented measurements", () => {
  it.each([
    "Apply thin ribbon of ointment to left eye at bedtime",
    "Apply a thick strip of ointment to left eye nightly",
    "Apply a thin line of ointment to left eye at bedtime",
    "Apply thick film of ointment to left eye nightly"
  ])("keeps the qualitative amount with the ordinary coded site and cadence: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.site?.coding?.[0]?.code).toBeTruthy();
    expect(parsed.fhir.timing?.repeat?.when?.length || parsed.fhir.timing?.repeat?.frequency).toBeTruthy();
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toMatch(/ribbon|strip|line|film/u);
    // An unmeasured qualitative amount belongs in a typed patient direction,
    // not a fabricated Quantity or a second synthetic oral "take" action.
    expect(parsed.fhir.patientInstruction?.toLowerCase()).toMatch(/ribbon|strip|line|film/u);
    expect(parsed.fhir.text).toBeTruthy();
    const strictR5 = toFhirR5Dosages(toDosageDetails([parsed.fhir]));
    expect(formatSig(strictR5, "long", { locale: "en" }).toLowerCase())
      .toMatch(/ribbon|strip|line|film/u);
    expect(formatSig(strictR5, "long", { locale: "th" })).not.toContain("รับประทาน");
  });
});


describe("cessation conditions own their safety action rather than dosing PRN", () => {
  it.each([
    "Apply thin film once daily; stop when control is achieved; wash hands after application.",
    "Take 1 tablet daily; stop when symptoms improve",
    "Take 1 tablet daily, discontinue if adverse effects occur"
  ])("keeps stop/cessation conditions off medication-as-needed timing: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(parsed.fhir.asNeededFor).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.actions.some(action =>
      ["stop", "discontinue"].includes(action.predicate.lemma)
    )).toBe(true);
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    expect(parsed.fhir.text?.toLowerCase()).not.toContain("as needed");
  });
  it("retains genuine dose-local conditional PRN triggers", () => {
    const parsed = parseSig("Take 1 tab if pain");
    expect(parsed.fhir.asNeeded).toBe(true);
    expect(parsed.fhir.asNeededFor?.some(reason => /pain/iu.test(reason.text ?? ""))).toBe(true);
  });
});


describe("prescribed but unspecified adjuncts remain editable", () => {
  it("retains as-directed wording without replacing the executable BID dose", () => {
    const parsed = parseSig("Take 1 tab PO BID as directed");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.fhir.additionalInstruction?.some(value =>
      /as directed/iu.test(value.text ?? "")
    )).toBe(true);
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it("does not mistake 'as needed for pain' for non-executable directions", () => {
    const parsed = parseSig("Take 1 tab BID as needed for pain");
    expect(parsed.fhir.asNeeded).toBe(true);
    expect(parsed.fhir.asNeededFor?.some(value => /pain/iu.test(value.text ?? ""))).toBe(true);
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


describe("procedure-only medication administration realization", () => {
  it.each([
    ["Rinse mouth with 10 mL for 1 minute then spit after meals", "rinse_mouth"],
    ["Swish 10 mL for 1 minute then spit after meals", "swish"]
  ])("keeps the actual dosed procedure as well as later spit action: %s", (source, predicate) => {
    const parsed = parseSig(source);
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    const primary = graph?.actions.find(action => action.predicate.lemma === predicate);
    expect(primary?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Amount, quantity: { value: 10, unit: "mL" } }),
      expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 1, unit: "min" } })
    ]));
    expect(graph?.actions.some(action => action.predicate.lemma === "spit")).toBe(true);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 10, unit: "mL" });
    expect(parsed.longText.toLowerCase()).toMatch(/rinse|swish/u);
    expect(parsed.longText.toLowerCase()).toContain("spit");
    expect(parsed.longText).toMatch(/10\s+mL/u);
    expect(parsed.longText).toContain("1 minute");
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


describe("object and prohibition coordination cannot invent positive drinking commands", () => {
  it("keeps food and beverages as objects of a wait-before action", () => {
    const parsed = parseSig(
      "take 1 tablet on empty stomach with water; wait 30 minutes before food, drink, or other meds"
    );
    const actions = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? []);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(actions.some(a => a.predicate.lemma === "wait" && a.args.some(arg =>
      arg.role === AdviceArgumentRole.Duration && arg.quantity?.value === 30 &&
      arg.quantity.unit === "min"
    ))).toBe(true);
    expect(actions.some(a => a.predicate.lemma === "drink" && a.polarity !== AdvicePolarity.Negate))
      .toBe(false);
    expect(parsed.longText).not.toMatch(/(?:then\s+)?drink\s*[.;]/iu);
    expect(parsed.longText.toLowerCase()).toContain("wait");
    expect(parsed.longText.toLowerCase()).toContain("food");
  });
  it("realizes both food and water prohibitions without a positive directive", () => {
    const parsed = parseSig(
      "measure 10 mL, swish vigorously for 1 minute then spit out; do not swallow; do not eat or drink for 30 minutes"
    );
    const actions = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? []);
    for (const lemma of ["eat-food", "drink"]) {
      expect(actions.some(a => a.predicate.lemma === lemma &&
        a.polarity === AdvicePolarity.Negate &&
        a.args.some(arg => arg.role === AdviceArgumentRole.Duration &&
          arg.quantity?.value === 30 && arg.quantity.unit === "min")
      )).toBe(true);
    }
    expect(parsed.longText.toLowerCase()).toMatch(/do not eat/u);
    expect(parsed.longText.toLowerCase()).toMatch(/do not drink/u);
    expect(parsed.longText).not.toMatch(/(?:then\s+)?drink\s+the medication/iu);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 10, unit: "mL" });
  });
});


describe("unresolved course-end events remain coded without invented dates", () => {
  it.each([
    ["Take 1 tab daily until next appointment", "1287351008"],
    ["Take 1 tab daily until the next appointment", "1287351008"],
    ["Take 1 tab daily until next visit", "1287351008"],
    ["Take 1 tab daily until symptoms improve", "1287353006"]
  ])("composes a coded non-calendar stopping condition: %s", (source, code) => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(parsed.fhir.site).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.boundsPeriod?.end).toBeUndefined();
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(parsed.fhir.additionalInstruction?.some(x => x.coding?.some(c =>
      c.system === "http://snomed.info/sct" && c.code === code
    ))).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const roundtrip = toFhirR5Dosages(toDosageDetails([parsed.fhir]));
    expect(roundtrip[0]?.additionalInstruction?.some(x => x.coding?.some(c => c.code === code)))
      .toBe(true);
  });
  it("does not falsely code an unrecognized worsening condition as improvement", () => {
    const parsed = parseSig("Take 1 tab daily until symptoms worsen");
    expect(parsed.fhir.additionalInstruction?.some(x => x.coding?.some(c =>
      c.code === "1287353006"
    ))).not.toBe(true);
    expect(parsed.fhir.timing?.repeat?.boundsPeriod?.end).toBeUndefined();
  });
  it("keeps a definite end date executable instead of recoding it as a vague appointment", () => {
    const parsed = parseSig("Take 1 tab daily until 2026-11-15", {
      datePolicy: { referenceDate: "2026-10-24" }
    });
    expect(parsed.fhir.timing?.repeat?.boundsPeriod?.end).toBe("2026-11-15");
    expect(parsed.fhir.additionalInstruction?.some(x => x.coding?.some(c =>
      c.code === "1287351008" || c.code === "1287353006"
    ))).not.toBe(true);
  });
});

describe("a whole dosage form is not one dosage form unless counted", () => {
  it.each([
    "Swallow tablets whole, do not chew",
    "Swallow capsules whole",
    "Swallow tablet whole; do not chew",
    "Do not crush or chew extended-release tablets; swallow whole"
  ])("does not invent one tablet/capsule from an adjective: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    expect(parsed.meta.canonical.clauses.every(c => c.dose?.value === undefined)).toBe(true);
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    expect(parsed.fhir.text?.toLowerCase()).not.toMatch(/(?:take|swallow) 1 (?:tablet|capsule)/iu);
  });
  it.each([
    ["Swallow 1 tablet whole; do not chew", 1],
    ["Swallow 2 tablets whole; do not chew", 2],
    ["Take 3 capsules whole", 3]
  ])("an explicit numeral, not 'whole', licenses the administered quantity: %s", (source, value) => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value });
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    expect(parsed.fhir.text).toBeTruthy();
  });
});


describe("boolean clinical guards preserve actual conjunction and disjunction", () => {
  it.each([
    ["Take 1 tab BID ONLY IF SBP > 160 AND HR >= 60", "all"],
    ["Take 1 tab BID if SBP > 160 and HR >= 60", "all"],
    ["Take 1 tab BID if SBP > 160 or HR >= 60", "any"],
    ["Take 1 tab BID only if SBP>160 AND HR>=60", "all"]
  ])("retains the exact clinical truth function through native R6-in-R5: %s",
    (source, kind) => {
      const parsed = parseSig(source);
      const condition = getDosageCondition(parsed.fhir);
      expect(condition).toMatchObject({ kind, conditions: [
        { kind: "measurement", name: "sbp", operation: "gt", value: 160 },
        { kind: "measurement", name: "hr", operation: "ge", value: 60 }
      ] });
      expect(parsed.fhir.asNeeded).not.toBe(true);
      expect(parsed.fhir.timing?.repeat).toMatchObject({
        frequency: 2, period: 1, periodUnit: "d"
      });
      const r5 = toFhirR5Dosages(toDosageDetails([parsed.fhir]));
      expect(getDosageCondition(r5[0])).toEqual(condition);
      expect(parsed.meta.leftoverText).toBeUndefined();
    });
});


describe("dimensional carrier grammar admits generic medication noun heads", () => {
  it.each([
    "Infuse 20 mg drug in 500 mL over four hours IV",
    "Infuse 20 mg medication in 500 mL over 4 hours IV",
    "Infuse 20mg product in 500mL over four hours IV",
    "Infuse 20 mg in 500 mL over four hours IV"
  ])("preserves active-drug 20 mg AND carrier 500mL/4h: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 20, code: "mg" },
      rateRatio: {
        numerator: { value: 500, code: "mL" },
        denominator: { value: 4, code: "h" }
      }
    });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe("47625008");
    expect(parsed.meta.canonical.clauses[0]?.clinicalQuantity).toMatchObject({
      representation: "dose-with-rate-ratio",
      projectedDose: { value: 20, unit: "mg" },
      rateNumerator: { value: 500, unit: "mL" },
      administrationDuration: { value: 4, unit: "h" }
    });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it("does not turn carrier volume into active-drug mass without evidence", () => {
    const parsed = parseSig("Infuse 500 mL over four hours IV");
    expect(parsed.fhir.doseAndRate?.[0]).toMatchObject({
      doseQuantity: { value: 500, code: "mL" },
      rateRatio: { numerator: { value: 500, code: "mL" }, denominator: { value: 4, code: "h" } }
    });
  });
});


describe("source-less FHIR weekday exclusions remain visible in dosage text", () => {
  it("shows the excluded weekday in English/Thai for ordinary, short and maximum-dose displays", () => {
    const dosage = parseSig("Take 1 tablet twice daily").fhir;
    delete dosage.text;
    setDosageExcludedWeekdays(dosage, ["sun"]);

    for (const style of ["short", "long"] as const) {
      expect(formatSig(dosage, style)).toContain("except Sunday");
      expect(formatSig(dosage, style, { locale: "th" })).toContain("ยกเว้นวันอาทิตย์");
    }
    expect(fromFhirDosage(dosage).shortText).toContain("except Sunday");
    expect(fromFhirDosage(dosage).longText).toContain("except Sunday");
    expect(fromFhirDosage(dosage, { locale: "th" }).longText).toContain("ยกเว้นวันอาทิตย์");
    expect(getDosageExcludedWeekdays(dosage)).toEqual(["sun"]);

    // Maximum-dose projection takes a different display branch.
    dosage.maxDosePerAdministration = { value: 1, unit: "tab" };
    expect(formatSig(dosage, "long")).toContain("except Sunday");
    expect(fromFhirDosage(dosage).longText).toContain("except Sunday");
  });

  it("preserves inherited weekday exclusions visibly in concurrent dosing", () => {
    const source = "instill 1 drop in left eye and 2 drops in right eye twice daily except Sunday";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => getDosageExcludedWeekdays(item.fhir))).toEqual([
      ["sun"], ["sun"]
    ]);
    expect(parsed.items[0].meta.canonical.clauses[0].clinicalAdjuncts?.localRanges).toBeUndefined();
    expect(parsed.items[0].longText).toContain("except Sunday");
    expect(parsed.items[0].fhir.text).toContain("except Sunday");
    expect(parsed.items[1].longText).toContain("except Sunday");
  });

  it("keeps exact authored source text instead of adding duplicate exclusions", () => {
    const source = "Take 1 tab twice daily except Sunday";
    const parsed = parseSig(source);
    expect(formatSig(parsed.fhir, "long")).toBe(source);
  });
});

describe("universal weekday exclusion remains a structured contradiction", () => {
  it.each([
    "Take 1 tab daily except all days",
    "Take 1 tab daily except every day",
    "Take 1 tab daily except each day"
  ])("preserves the dose and recurrence while excluding the entire week: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(getDosageExcludedWeekdays(parsed.fhir)).toEqual([
      "mon", "tue", "wed", "thu", "fri", "sat", "sun"
    ]);
    expect(nextDueDoses(parsed, {
      from: "2026-10-24T08:00:00+07:00", orderedAt: "2026-10-24T08:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 5
    })).toEqual([]);
    expect(calculateTotalUnits({
      dosage: parsed,
      from: "2026-10-24T08:00:00+07:00", orderedAt: "2026-10-24T08:00:00+07:00",
      timeZone: "Asia/Bangkok", durationValue: 7, durationUnit: "d"
    })).toMatchObject({ totalUnits: 0, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it("retains an explicit single weekday exception without denying other days", () => {
    const parsed = parseSig("Take 1 tab daily except Sunday");
    expect(getDosageExcludedWeekdays(parsed.fhir)).toEqual(["sun"]);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
  });

  it.each([
    "Take 1 tab daily except Sunday for 4 weeks",
    "Take 1 tab daily except on Sundays for 4 weeks"
  ])("bounds a weekday exclusion before an independent trailing course: %s", source => {
    const parsed = parseSig(source);
    expect(getDosageExcludedWeekdays(parsed.fhir)).toEqual(["sun"]);
    expect(parsed.fhir.timing?.repeat?.boundsDuration)
      .toMatchObject({ value: 4, code: "wk" });
    const strictR5 = toFhirR5Dosages(parsed.fhirNext)[0];
    expect(getDosageExcludedWeekdays(strictR5)).toEqual(["sun"]);
    expect(strictR5.timing?.repeat?.boundsDuration)
      .toMatchObject({ value: 4, code: "wk" });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


describe("disjunctive administration methods are alternatives, not overwritten choices", () => {
  it.each([
    "Inhale 2 puffs or nebulize 2.5 mg",
    "Inhale two puffs or nebulize 2.5 mg"
  ])("preserves both independent dosed administration methods: %s", source => {
    const plan = createBoundaryPlan(source);
    expect(plan.relations).toContainEqual(expect.objectContaining({
      kind: "alternative", connectorKind: "disjunction"
    }));
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([2, 2.5]);
    expect(parsed.items[0]?.fhir.method?.text?.toLowerCase()).toContain("inhale");
    expect(parsed.items[1]?.fhir.method?.text?.toLowerCase()).toContain("nebulize");
    expect(parsed.items.every(item => item.meta.canonical.clauses[0]?.rawText)).toBe(true);
  });
  it("keeps exclusive either/or administration branches editable, rather than silently selecting one", () => {
    const source = "Either inhale two puffs OR nebulize 2.5 mg, not both";
    const parsed = parseSig(source);
    const plan = createBoundaryPlan(source);
    expect(plan.relations).toContainEqual(expect.objectContaining({
      kind: "alternative", connectorKind: "disjunction"
    }));
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([2, 2.5]);
    expect(parsed.items[0]?.fhir.method?.text?.toLowerCase()).toContain("inhale");
    expect(parsed.items[1]?.fhir.method?.text?.toLowerCase()).toContain("nebulize");
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.meta.canonical.clauses.map(c => c.rawText).join(" ")).toContain("not both");
  });
  it("does not manufacture two dosed administrations from a nondose procedure choice", () => {
    const source = "Rinse mouth or wash hands";
    const parsed = parseSig(source);
    expect(parsed.items.every(item =>
      !item.fhir.doseAndRate?.[0]?.doseQuantity?.value
    )).toBe(true);
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
  });
});

describe("typed exactly-one medication alternatives through projection and execution", () => {
  const source = "Take 1 tablet daily or take 2 tablets daily";
  const clock = { from: "2026-10-24T00:00:00+07:00", orderedAt: "2026-10-24T00:00:00+07:00",
    timeZone: "Asia/Bangkok", limit: 3 };

  it("preserves OR through sync, async, lint and strict R5/R6 without concurrent implication", async () => {
    const parsed = parseSig(source);
    const asyncParsed = await parseSigAsync(source);
    const linted = lintSig(source);
    for (const results of [parsed.items, asyncParsed.items, linted.items.map(item => item.result)]) {
      expect(results).toHaveLength(2);
      const choices = results.map(item => getDosageAlternativeChoice(item.fhir));
      expect(choices[0]).toMatchObject({ groupId: "choice-1", branchId: "branch-1", selectionBehavior: "exactly-one" });
      expect(choices[1]).toMatchObject({ groupId: "choice-1", branchId: "branch-2", selectionBehavior: "exactly-one" });
      expect(results.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    }
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.map(getDosageAlternativeChoice)).toEqual(parsed.items.map(item => getDosageAlternativeChoice(item.fhir)));
    const restored = toDosageDetails(strictR5);
    expect(restored.step[0].component.map(getDosageAlternativeChoice)).toEqual(strictR5.map(getDosageAlternativeChoice));
    const en = formatSig(restored, "long", { locale: "en" });
    const th = formatSig(restored, "long", { locale: "th" });
    expect(en).toContain("Choose one:"); expect(en).toMatch(/ or /u);
    expect(th).toContain("เลือกอย่างใดอย่างหนึ่ง"); expect(th).toContain("หรือ");
    expect(formatSig(strictR5, "long", { locale: "en" })).toContain(" or ");
    expect(fromFhir(restored, { locale: "en" }).longText).toContain(" or ");
    expect(parsed.meta.canonical.clauses.map(c => c.rawText).join(" ")).toContain("2 tablets");
  });

  it("offers an explicit branch selection instead of executing/summing both treatments", () => {
    const parsed = parseSig(source);
    expect(() => nextDueDoses(parsed, clock)).toThrow(/alternativeChoices/u);
    expect(() => calculateTotalUnits({ ...clock, dosage: parsed, durationValue: 3, durationUnit: "d" }))
      .toThrow(/alternativeChoices/u);
    for (const [branchId, quantity] of [["branch-1", 3], ["branch-2", 6]] as const) {
      const selected = { ...clock, alternativeChoices: { "choice-1": branchId } };
      expect(nextDueDoses(parsed, selected)).toHaveLength(3);
      expect(calculateTotalUnits({ ...selected, dosage: parsed, durationValue: 3, durationUnit: "d" }))
        .toMatchObject({ totalUnits: quantity, unit: "tab" });
      const strict = toFhirR5Dosages(parsed.fhirNext);
      expect(nextDueDoses(strict, selected)).toEqual(nextDueDoses(parsed, selected));
      expect(calculateTotalUnits({ ...selected, dosage: strict, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(quantity);
    }
    expect(parsed.items).toHaveLength(2);
    expect(parsed.fhirNext.step[0].component).toHaveLength(2);
    expect(parsed.items.every(item => getDosageAlternativeChoice(item.fhir))).toBe(true);
    expect(() => nextDueDoses(parsed, { ...clock, alternativeChoices: { "choice-1": "missing" } }))
      .toThrow(/branch/u);
  });

  it("keeps branch identities after array reordering and never invents choices for conjunctions", () => {
    const parsed = parseSig(source);
    const native = parsed.items.map(item => item.fhir).reverse();
    const opts = { ...clock, alternativeChoices: { "choice-1": "branch-1" } };
    expect(calculateTotalUnits({ ...opts, dosage: native, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(3);
    const together = parseSig("Take 1 tablet at 08:00 and 2 tablets at 20:00");
    expect(together.items.every(item => getDosageAlternativeChoice(item.fhir) === undefined)).toBe(true);
    expect(nextDueDoses(together, clock)).toHaveLength(3);
  });

  it("does not interpret a malformed choice modifier as permission to give every option", () => {
    const parsed = parseSig(source);
    const broken = { ...parsed.items[0].fhir, modifierExtension: [{
      url: DOSAGE_ALTERNATIVE_CHOICE_URL,
      extension: [{ url: "groupId", valueString: "choice-1" }]
    }] };
    expect(() => nextDueDoses(broken, clock)).toThrow(/Edit or clear/u);
    expect(broken.modifierExtension[0].extension[0].valueString).toBe("choice-1");
    setDosageAlternativeChoice(broken, undefined);
    expect(nextDueDoses(broken, clock)).toHaveLength(3);
  });
});

describe("event-relative alternatives retain offset and Boolean scope", () => {
  const clocks = { from: "2026-10-24T06:00:00+07:00", orderedAt: "2026-10-24T06:00:00+07:00",
    timeZone: "Asia/Bangkok", eventClock: { CM: "08:00", CD: "12:00", CV: "18:00" }, limit: 3 };
  it.each([
    "Inject 5 units 15 minutes before meals OR immediately after meals",
    "Inject 5 units 15 minutes before meals or after meals immediately",
    "ฉีด 5 ยูนิต ก่อนอาหาร 15 นาที หรือ หลังอาหารทันที"
  ])("retains before15 OR after0 as two explicit options, never a shared offset: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([5, 5]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when)).toEqual([["AC"], ["PC"]]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.offset)).toEqual([15, 0]);
    expect(parsed.items.map(item => getDosageAlternativeChoice(item.fhir)?.groupId)).toEqual(["choice-1", "choice-1"]);
    const first = { ...clocks, alternativeChoices: { "choice-1": "branch-1" } };
    const second = { ...clocks, alternativeChoices: { "choice-1": "branch-2" } };
    expect(nextDueDoses(parsed, first).map(value => value.slice(11, 16))).toEqual(["07:45", "11:45", "17:45"]);
    expect(nextDueDoses(parsed, second).map(value => value.slice(11, 16))).toEqual(["08:00", "12:00", "18:00"]);
    const strict = toFhirR5Dosages(toDosageDetails(toFhirR5Dosages(parsed.fhirNext)));
    expect(strict.map(item => item.timing?.repeat?.offset)).toEqual([15, 0]);
    expect(formatSig(strict, "long", { locale: "en" })).toContain(" or ");
    expect(formatSig(strict, "long", { locale: "th" })).toContain("หรือ");
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it("keeps independent breakfast and lunch offsets without shifting after lunch to before it", () => {
    const parsed = parseSig("Inject 5 units 15 minutes before breakfast or immediately after lunch");
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when)).toEqual([["ACM"], ["PCD"]]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.offset)).toEqual([15, 0]);
    expect(nextDueDoses(parsed, { ...clocks, limit: 1,
      alternativeChoices: { "choice-1": "branch-2" } })[0]?.slice(11,16)).toBe("12:00");
  });
  it("uses both conjunctive administrations but keeps their offsets local", () => {
    const parsed = parseSig("Inject 5 units 15 minutes before breakfast and immediately after lunch");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.every(item => !getDosageAlternativeChoice(item.fhir))).toBe(true);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when)).toEqual([["ACM"], ["PCD"]]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.offset)).toEqual([15, 0]);
    expect(nextDueDoses(parsed, { ...clocks, limit: 2 }).map(value => value.slice(11,16))).toEqual(["07:45", "12:00"]);
  });
  it("does not reinterpret an independent stat administration as an event-relative offset", () => {
    const parsed = parseSig("Inject 5 units immediately");
    expect(parsed.fhir.timing?.repeat?.when).toContain("IMD");
    expect(parsed.fhir.timing?.repeat?.offset).toBeUndefined();
    expect(parsed.items).toHaveLength(1);
  });
});

describe("counted additional administrations and rolling quantity windows", () => {
  it.each(["four additional doses", "4 more doses", "four further doses"])(
    "keeps occurrence cardinality separate from symptoms and treatment duration: %s", count => {
      const parsed = parseSig(`Take two tablets now, then one tablet every 12 hours for ${count}; max three tablets in a rolling 24 hours`);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 1]);
      expect(parsed.items[0].fhir.timing?.repeat?.when).toContain("IMD");
      expect(parsed.items[1].fhir.timing?.repeat).toMatchObject({ count: 4, period: 12, periodUnit: "h" });
      expect(parsed.items[1].fhir.timing?.repeat?.boundsDuration).toBeUndefined();
      expect(parsed.items[1].fhir.maxDosePerPeriod?.[0]).toMatchObject({
        numerator: { value: 3, unit: "tab" }, denominator: { value: 24, code: "h" }
      });
      expect(parsed.items.every(item => !item.fhir.asNeeded && !item.fhir.site)).toBe(true);
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(calculateTotalUnits({ dosage: parsed,
        from: "2026-10-24T08:00:00+07:00", orderedAt: "2026-10-24T08:00:00+07:00",
        timeZone: "Asia/Bangkok", durationValue: 3, durationUnit: "d"
      })).toMatchObject({ totalUnits: 6, unit: "tab" });
    });
  it("keeps a decimal medication cap while accepting an ordinary explicit window", () => {
    const parsed = parseSig("Take 1 tablet q12h max 0.5 tablets within 12 hours");
    expect(parsed.fhir.maxDosePerPeriod?.[0]).toMatchObject({
      numerator: { value: 0.5, unit: "tab" }, denominator: { value: 12, code: "h" }
    });
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});

describe("registered topical spreading keeps administration site and cadence", () => {
  it("composes a qualitative manner, bilateral target and two event anchors", () => {
    const source = "Spread cream thinly over both elbows morning and evening; avoid broken skin";
    const parsed = parseSig(source);
    expect(parsed.fhir.site?.text?.toLowerCase()).toContain("elbow");
    expect(parsed.fhir.timing?.repeat?.when).toEqual(["MORN", "EVE"]);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    expect(parsed.fhir.additionalInstruction?.some(instruction => instruction.coding?.some(c => c.code === "420162004"))).toBe(true);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toContain("elbow");
    expect(parsed.longText.toLowerCase()).toContain("evening");
    expect(parsed.longText.toLowerCase()).not.toContain("on the morning");
  });
  it("does not convert a prohibition of spreading into a positive administration", () => {
    const parsed = parseSig("Do not spread cream on broken skin");
    expect(parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
      .filter(action => action.predicate.lemma === "spread")
      .every(action => action.polarity === AdvicePolarity.Negate)).toBe(true);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
  });
});

describe("qualitative application manner does not fabricate positive thinness", () => {
  it("preserves a thick-layer instruction without assigning thin-layer coding or a numerical dose", () => {
    const source = "Apply a thick layer of ointment to the rash twice daily";
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    expect(parsed.fhir.additionalInstruction?.some(i => i.coding?.some(c => c.code === "420162004"))).not.toBe(true);
    expect(parsed.fhir.additionalInstruction?.some(i => i.coding?.some(c => c.code === "246703001"))).toBe(true);
    expect(parsed.longText.toLowerCase()).toContain("thick");
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it.each(["Do not spread cream thinly on the skin", "Do not apply a thin layer to the skin"])(
    "does not turn a negative application-manner directive into positive thin-layer coding: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.additionalInstruction?.some(i => i.coding?.some(c => c.code === "420162004"))).not.toBe(true);
    const spread = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? [])
      .filter(action => action.predicate.lemma === "spread" || action.predicate.lemma === "apply");
    expect(spread.length).toBeGreaterThan(0);
    expect(spread.every(action => action.polarity === AdvicePolarity.Negate)).toBe(true);
  });
});

describe("device noun complements do not erase an alternative administration", () => {
  it.each(["inhaler", "metered dose inhaler"])("keeps both quantified branches with a %s complement", device => {
    const source = `Either inhale two puffs from ${device} or nebulize 2.5 mg, not both; rinse mouth after whichever is used`;
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([2, 2.5]);
    expect(parsed.items.map(item => getDosageAlternativeChoice(item.fhir)?.groupId)).toEqual(["choice-1", "choice-1"]);
    expect(parsed.items[0]?.fhir.method?.text?.toLowerCase()).toContain("inhale");
    expect(parsed.items[1]?.fhir.method?.text?.toLowerCase()).toContain("nebulize");
    expect(parsed.longText.toLowerCase()).toContain("inhaler");
    expect(parsed.longText.toLowerCase()).toContain(" or ");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses.some(c => c.instructionGraph?.actions.some(a => a.predicate.lemma === "rinse_mouth"))).toBe(true);
  });
});

describe("mixing complement ownership survives unknown terminology and FHIR", () => {
  it.each(["applesauce", "yogurt", "frozzlebloop"])("keeps the source-backed mixing medium %s visible without inventing a dose", medium => {
    const source = `crush tablet and mix with ${medium}, swallow immediately, do not chew`;
    const parsed = parseSig(source);
    const actions = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? []);
    expect(actions.map(a => a.predicate.lemma)).toEqual(expect.arrayContaining(["crush", "mix", "swallow", "chew"]));
    const mix = actions.find(a => a.predicate.lemma === "mix");
    expect(mix?.args.some(a => a.text === medium &&
      [AdviceArgumentRole.Material, AdviceArgumentRole.Substance, AdviceArgumentRole.Object].indexOf(a.role) >= 0)).toBe(true);
    expect(actions.find(a => a.predicate.lemma === "chew")?.polarity).toBe(AdvicePolarity.Negate);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toContain(medium);
    expect(parsed.longText.toLowerCase()).toContain("swallow");
    const r5 = toFhirR5Dosages(toDosageDetails([parsed.fhir]));
    expect(formatSig(r5, "long", { locale: "en" }).toLowerCase()).toContain(medium);
    expect(formatSig(r5, "long", { locale: "th" }).toLowerCase()).toContain(medium);
    if (medium === "frozzlebloop") {
      expect(mix?.args.find(a => a.text === medium)?.coding).toBeUndefined();
    }
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
  it("keeps a mixing instrument visible without coding it as a known liquid", () => {
    const parsed = parseSig("mix with spoon, then swallow");
    const mix = parsed.meta.canonical.clauses.flatMap(c => c.instructionGraph?.actions ?? []).find(a => a.predicate.lemma === "mix");
    expect(mix?.args.some(a => /spoon/iu.test(a.text))).toBe(true);
    expect(mix?.args.some(a => a.conceptId === "water" || a.conceptId === "clean-water")).toBe(false);
    expect(parsed.longText.toLowerCase()).toContain("spoon");
    expect(parsed.longText.toLowerCase()).toContain("swallow");
  });
});

describe("Boolean condition constituents own their internal coordination boundaries", () => {
  it.each([
    ["Take 1 tab BID only if SBP > 160 and HR >= 60", "all"],
    ["Take 1 tab BID only if SBP > 160 or HR >= 60", "any"]
  ])("does not reparse a typed Boolean connective as two regimens: %s", (source, kind) => {
    const plan = createBoundaryPlan(source, undefined, { trace: true });
    expect(plan.segments).toHaveLength(1);
    expect(plan.metrics.clauseProbes).toBe(0);
    expect(plan.claims.some(claim => claim.kind === "clinical-condition")).toBe(true);
    const parsed = parseSig(source);
    expect(getDosageCondition(parsed.fhir)).toMatchObject({ kind, conditions: [
      { kind: "measurement", name: "sbp", operation: "gt", value: 160 },
      { kind: "measurement", name: "hr", operation: "ge", value: 60 }
    ] });
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(parsed.fhir.asNeeded).not.toBe(true);
  });
  it("does not consume an actual disjunctive administration outside a condition", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 or 2 tablets at 20:00");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.timeOfDay)).toEqual([["08:00:00"], ["20:00:00"]]);
    expect(parsed.items.every(item => getDosageAlternativeChoice(item.fhir)?.groupId === "choice-1")).toBe(true);
  });
});


describe("procedure-local immediacy does not create a medication stat dose", () => {
  it.each([
    "Should not lie down immediately after taking medication",
    "Lie down immediately",
    "Do not drink water immediately after taking medication"
  ])("attaches the adverb to its procedural action, not the regimen: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.timing?.repeat?.when ?? []).not.toContain("IMD");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    expect(parsed.fhir.text).toBeTruthy();
  });
  it("retains an explicitly immediate medication administration", () => {
    const parsed = parseSig("Take 1 tablet immediately");
    expect(parsed.fhir.timing?.repeat?.when).toContain("IMD");
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({value: 1, unit: "tab"});
  });
});

describe("open-ended patient outcome conditions remain typed without invented calendar dates", () => {
  it.each([
    ["Take one tablet daily until itching resolves, then stop unless rash returns", "Until itching resolves"],
    ["Take one tablet daily until the rash resolves", "Until rash resolves"],
    ["Apply cream daily until redness improves", "Until redness improves"]
  ])("retains the independently unknown clinical course end: %s", (source, expected) => {
    const parsed = parseSig(source);
    expect(parsed.fhir.timing?.repeat?.boundsPeriod?.end).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.frequency).toBe(1);
    expect(parsed.fhir.additionalInstruction?.some(item =>
      item.text === expected && !(item.coding?.length)
    )).toBe(true);
    expect(parsed.fhir.site?.text).not.toBe("rash");
    expect(parsed.meta.leftoverText).toBeUndefined();
    const strict = toFhirR5Dosages(toDosageDetails([parsed.fhir]));
    expect(strict[0]?.additionalInstruction?.some(item =>
      item.text === expected && !(item.coding?.length)
    )).toBe(true);
    expect(strict[0]?.timing?.repeat?.boundsPeriod?.end).toBeUndefined();
  });
});

describe("clinical execution adversarial source keeps patient intent and dose identity", () => {
  it("never schedules a second evening insulin injection from a HOLD-only daypart object", () => {
    const source = "Inject 5 units before breakfast and 8 units before dinner; " +
      "hold only the evening dose if glucose below 70.";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([5, 8]);
    expect(parsed.items.map(item => item.fhir.timing?.repeat?.when))
      .toEqual([["ACM"], ["ACV"]]);
    const actual = nextDueDoses(parsed, {
      from: "2026-10-24T06:00:00+07:00",
      orderedAt: "2026-10-24T06:00:00+07:00",
      timeZone: "Asia/Bangkok",
      eventClock: { ACM: "07:30", ACV: "18:30", EVE: "20:00" },
      limit: 4
    });
    expect(actual).toEqual([
      "2026-10-24T07:30:00+07:00",
      "2026-10-24T18:30:00+07:00",
      "2026-10-25T07:30:00+07:00",
      "2026-10-25T18:30:00+07:00"
    ]);
    expect(parsed.items[1].meta.canonical.clauses[0]?.rawText)
      .toContain("hold only the evening dose");
    expect(parsed.items[0].meta.canonical.clauses[0]?.rawText)
      .not.toContain("glucose");
    expect(getDosageCondition(parsed.items[0].fhir)).toBeUndefined();
    expect(getDosageCondition(parsed.items[1].fhir)).toMatchObject({
      kind: "not", condition: {
        kind: "measurement", name: "glucose", operation: "lt", value: 70
      }
    });
    expect(nextDueDoses(parsed.items[1].fhir, {
      from: "2026-10-24T06:00:00+07:00",
      orderedAt: "2026-10-24T06:00:00+07:00",
      timeZone: "Asia/Bangkok", eventClock: { ACV: "18:30" },
      evaluateCondition: () => false, limit: 2
    })).toEqual([]);
    const strict = toFhirR5Dosages(toDosageDetails(parsed.items.map(item => item.fhir)));
    expect(strict.map(row => row.timing?.repeat?.when)).toEqual([["ACM"], ["ACV"]]);
    expect(getDosageCondition(strict[1])).toEqual(getDosageCondition(parsed.items[1].fhir));
  });

  it.each([
    ["hold only the evening dose", "glucose below 70", "lt"],
    ["hold the evening dose", "glucose below 70", "lt"],
    ["hold evening dose", "glucose <70", "lt"],
    ["hold evening dose", "glucose <=70", "le"],
    ["omit evening dose", "glucose below 70", "lt"],
    ["skip evening dose", "glucose below 70", "lt"],
    ["withhold evening dose", "glucose below 70", "lt"]
  ] as const)("composes a typed withholding action as the inverse evening-only guard: %s if %s",
    (verb, measurement, operator) => {
      const parsed = parseSig(
        "Inject 5 units before breakfast and 8 units before dinner; " + verb + " if " + measurement
      );
      expect(parsed.items).toHaveLength(2);
      const [morning, evening] = parsed.items.map(item => item.fhir);
      expect([morning, evening].map(row =>
        row.doseAndRate?.[0]?.doseQuantity?.value
      )).toEqual([5, 8]);
      expect([morning, evening].map(row =>
        row.timing?.repeat?.when
      )).toEqual([["ACM"], ["ACV"]]);
      expect(getDosageCondition(morning)).toBeUndefined();
      const guard = getDosageCondition(evening);
      expect(guard).toMatchObject({
        kind: "not", condition: {
          kind: "measurement", name: "glucose",
          operation: operator, value: 70
        }
      });
      expect(getDosageCondition(
        toFhirR5Dosages(toDosageDetails([morning, evening]))[1]
      )).toEqual(guard);
      const opts = {
        from: "2026-10-24T06:00:00+07:00",
        orderedAt: "2026-10-24T06:00:00+07:00",
        timeZone: "Asia/Bangkok",
        eventClock: { ACV: "18:30" },
        limit: 2
      } as const;
      expect(nextDueDoses(evening, {
        ...opts,
        evaluateCondition: condition =>
          evaluateMedicationCondition(condition, { glucose: 60 })
      })).toEqual([]);
      expect(nextDueDoses(evening, {
        ...opts,
        evaluateCondition: condition =>
          evaluateMedicationCondition(condition, { glucose: 100 })
      })).toHaveLength(2);
    }
  );

  it.each([
    ["Take 1 tablet every morning; hold if fasting blood glucose <70 mg/dL", "fasting blood glucose", "lt", "MORN"],
    ["Give 2 mg IV daily; hold if ANC below 1000", "anc", "lt", undefined],
    ["Take 1 tab BID; omit if blood glucose below 70", "blood glucose", "lt", undefined],
    ["Take 1 tab daily; withhold if glucose below 70", "glucose", "lt", undefined]
  ] as const)("licenses an omitted medication-dose object under HPSG action valence: %s",
    (source, name, operation, daypart) => {
      const parsed = parseSig(source);
      expect(parsed.items).toHaveLength(1);
      const [dosage] = parsed.items.map(item => item.fhir);
      expect(dosage.doseAndRate?.[0]?.doseQuantity?.value).toBeGreaterThan(0);
      if (daypart) expect(dosage.timing?.repeat?.when).toEqual([daypart]);
      const condition = getDosageCondition(dosage);
      expect(condition).toMatchObject({
        kind: "not", condition: {
          kind: "measurement", name, operation
        }
      });
      expect(getDosageCondition(toFhirR5Dosages(toDosageDetails([dosage]))[0]))
        .toEqual(condition);
    }
  );

  it("keeps a physical hold object outside the executable medication guard", () => {
    const parsed = parseSig("Hold your breath if blood pressure below 80");
    expect(parsed.items).toHaveLength(1);
    expect(getDosageCondition(parsed.items[0].fhir)).toBeUndefined();
    expect(parsed.items[0].fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].rawText)
      .toContain("Hold your breath");
  });

  it.each([
    "Take 1 tablet daily; do not withhold the dose if glucose below 70",
    "Take 1 tablet daily; do not hold the dose if glucose below 70",
    "Take 1 tablet daily; keep the dose if glucose below 70",
    "Take 1 tablet daily; hold your breath if pulse below 60",
    "Take 1 tablet daily; hold the inhaler if glucose below 70"
  ])("does not turn negative or physical retention into a medication-withholding guard: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    const row = parsed.items[0].fhir;
    expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(row.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(getDosageCondition(row)).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].rawText).toBe(source);
  });

  it("reuses typed withholding valence for a newly configured action without a surface rule", () => {
    const parsed = parseSig("Take 1 tablet daily; defer if pulse below 55", {
      instructionActionMap: {
        defer: {
          code: "institution-defer-dose",
          semanticClass: "course",
          display: "Defer",
          procedural: true,
          argumentParser: "object-duration",
          realizer: "object-duration",
          argumentParserConfig: { medicationConditionEffect: "withhold" }
        }
      }
    });
    expect(parsed.items).toHaveLength(1);
    const condition = getDosageCondition(parsed.items[0].fhir);
    expect(condition).toMatchObject({
      kind: "not", condition: {
        kind: "measurement", name: "pulse", operation: "lt", value: 55
      }
    });
    expect(getDosageCondition(toFhirR5Dosages(toDosageDetails([parsed.items[0].fhir]))[0]))
      .toEqual(condition);
  });

  it.each([
    ["blood sugar is under 70", "blood sugar", "lt", 70],
    ["pulse is no less than 55", "pulse", "ge", 55],
    ["ANC is no more than 1000", "anc", "le", 1000]
  ] as const)("shares the complete comparison grammar in a conditional withholding action: %s",
    (comparison, name, operation, value) => {
      const parsed = parseSig("Take 1 tablet daily; hold if " + comparison);
      expect(parsed.items).toHaveLength(1);
      const condition = getDosageCondition(parsed.items[0].fhir);
      expect(condition).toMatchObject({
        kind: "not", condition: { kind: "measurement", name, operation, value }
      });
      expect(parsed.items[0].fhir.timing?.repeat)
        .toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    }
  );

  it.each([
    ["not less than", "ge", [false, true, true]],
    ["not below", "ge", [false, true, true]],
    ["not under", "ge", [false, true, true]],
    ["not more than", "le", [true, true, false]],
    ["not greater than", "le", [true, true, false]],
    ["not above", "le", [true, true, false]],
    ["not over", "le", [true, true, false]]
  ] as const)("interprets the full English measurement comparison: SBP %s 100", (wording, operation, expected) => {
    const source = "Take 1 tablet daily only if SBP " + wording + " 100";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(1);
    const condition = getDosageCondition(parsed.items[0].fhir)!;
    expect(condition).toMatchObject({ kind: "measurement", name: "sbp", operation, value: 100 });
    for (const [index, measured] of [90, 100, 110].entries()) {
      expect(evaluateMedicationCondition(condition, { sbp: measured })).toBe(expected[index]);
    }
    const reopened = toFhirR5Dosages(parsed.fhirNext)[0];
    expect(getDosageCondition(reopened)).toEqual(condition);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each(["hold", "omit", "skip", "withhold"])(
    "composes a fronted conditional with the withholding action daughter: %s", verb => {
      const source = "Take 1 tablet daily; if pulse below 55, " + verb + " the dose";
      const parsed = parseSig(source);
      expect(parsed.items).toHaveLength(1);
      const row = parsed.items[0].fhir;
      expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(getDosageCondition(row)).toMatchObject({
        kind: "not", condition: { kind: "measurement", name: "pulse", operation: "lt", value: 55 }
      });
    }
  );

  it.each([
    ["hold only the morning dose", [true, false]],
    ["hold only the evening dose", [false, true]],
    ["withhold both doses", [true, true]],
    ["omit all doses", [true, true]]
  ] as const)("binds the withholding condition to its explicit dosage target: %s", (instruction, guarded) => {
    const source = "Inject 5 units before breakfast and 8 units before dinner; " +
      instruction + " if glucose below 70";
    const parsed = parseSig(source);
    expect(parsed.items).toHaveLength(2);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([5, 8]);
    expect(rows.map(row => row.timing?.repeat?.when)).toEqual([["ACM"], ["ACV"]]);
    expect(rows.map(row => Boolean(getDosageCondition(row)))).toEqual([...guarded]);
    rows.forEach((row, index) => {
      if (guarded[index]) expect(getDosageCondition(row)).toMatchObject({
        kind: "not", condition: { kind: "measurement", name: "glucose", operation: "lt", value: 70 }
      });
    });
    const roundtrip = toFhirR5Dosages(toDosageDetails(rows));
    expect(roundtrip.map(getDosageCondition)).toEqual(rows.map(getDosageCondition));
  });

  it.each([
    ["omit breakfast dose", [true, false]],
    ["skip breakfast dose", [true, false]],
    ["hold breakfast dose", [true, false]],
    ["omit dinner dose", [false, true]],
    ["skip dinner dose", [false, true]]
  ] as const)("binds a meal-named dose slot to its matching insulin administration: %s",
    (instruction, guarded) => {
      const source = "Inject 5 units before breakfast and 8 units before dinner; " +
        instruction + " if glucose below 80";
      const parsed = parseSig(source);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.input).toBe(source);
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.warnings).toEqual([]);
      const rows = parsed.items.map(item => item.fhir);
      expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity))
        .toMatchObject([{ value: 5, unit: "U" }, { value: 8, unit: "U" }]);
      expect(rows.map(row => row.timing?.repeat?.when)).toEqual([["ACM"], ["ACV"]]);
      const conditions = rows.map(getDosageCondition);
      conditions.forEach((condition, index) => {
        if (!guarded[index]) {
          expect(condition).toBeUndefined();
          return;
        }
        expect(condition).toMatchObject({
          kind: "not", condition: {
            kind: "measurement", name: "glucose", operation: "lt", value: 80
          }
        });
      });

      const strictR5 = toFhirR5Dosages(toDosageDetails(rows));
      expect(strictR5.map(getDosageCondition)).toEqual(conditions);
      const r6Components = parsed.fhirNext.step.flatMap(step => step.component);
      expect(r6Components).toHaveLength(2);
      expect(r6Components.map(component => Boolean(component.condition?.length)))
        .toEqual([...guarded]);
      r6Components.forEach((component, index) => {
        if (guarded[index]) expect(component.condition?.[0]?.text).toBe("not (glucose lt 80)");
      });
    }
  );

  it.each([
    "Skip breakfast if glucose below 80",
    "Skip breakfast meal if glucose below 80",
    "Omit salt if glucose below 80",
    "Omit dinner reservation if glucose below 80",
    "Hold your breath if glucose below 80"
  ])("does not license a medication-withholding guard for a non-dose object: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.items.some(item =>
      getDosageCondition(item.fhir)?.kind === "not"
    )).toBe(false);
    expect(parsed.items.flatMap(item =>
      item.meta.canonical.clauses[0]?.clinicalAdjuncts?.evidence ?? []
    ).some(evidence => evidence.rule === "hpsg.cx.medication-withholding-conditional"))
      .toBe(false);
  });

  it("leaves independent PRN and positive administration conditions unchanged", () => {
    const prn = parseSig("Take 1 tablet q6h PRN pain");
    expect(prn.fhir.asNeeded).toBe(true);
    expect(prn.fhir.asNeededFor?.[0]?.text).toMatch(/pain/iu);
    expect(getDosageCondition(prn.fhir)).toBeUndefined();

    const positive = parseSig("Take 1 tablet only if glucose above 80");
    expect(positive.fhir.asNeeded).not.toBe(true);
    expect(getDosageCondition(positive.fhir)).toMatchObject({
      kind: "measurement", name: "glucose", operation: "gt", value: 80
    });
  });

  it("keeps explicit positive-only-if dosing positive instead of reversing it", () => {
    const parsed = parseSig(
      "Inject 5 units before breakfast and 8 units before dinner only if glucose above 70"
    );
    expect(parsed.items).toHaveLength(2);
    expect(getDosageCondition(parsed.items[0].fhir)).toBeUndefined();
    expect(getDosageCondition(parsed.items[1].fhir)).toMatchObject({
      kind: "measurement", name: "glucose", operation: "gt", value: 70
    });
  });

  it("does not silently stop a right-eye q2h taper after 4 doses or lose the subsequent QID stage", () => {
    const source = "หยอดตาขวา 1 หยดทุก 2 ชั่วโมง 7 วัน แล้วลดเหลือวันละ 4 ครั้ง; " +
      "ตาซ้ายหยอด 1 หยดวันละ 2 ครั้ง";
    const parsed = parseSig(source, { locale: "th" });
    expect(parsed.items).toHaveLength(3);
    const [first, second, left] = parsed.items.map(item => item.fhir);
    expect([first.site?.text, second.site?.text, left.site?.text])
      .toEqual(["right eye", "right eye", "left eye"]);
    expect([first, second, left].map(row => row.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 1, 1]);
    expect(first.timing?.repeat).toMatchObject({
      period: 2, periodUnit: "h", boundsDuration: { value: 7, code: "d" }
    });
    expect(first.timing?.repeat?.count).toBeUndefined();
    expect(second.timing?.repeat).toMatchObject({ frequency: 4, period: 1, periodUnit: "d" });
    expect(left.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    const strict = toFhirR5Dosages(toDosageDetails([first, second, left]));
    // Whole-course R5 serializes parallel stages in effective stage order:
    // left-eye BID begins concurrently with OD q2h, while OD QID starts
    // later. Assert site/cadence identity, not incidental array ordering.
    expect(strict.filter(row => row.site?.text === "right eye")
      .map(row => row.timing?.repeat?.frequency)).toEqual([undefined, 4]);
    expect(strict.filter(row => row.site?.text === "left eye")
      .map(row => row.timing?.repeat?.frequency)).toEqual([2]);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("does not reinterpret unanchored cycle DAY ORDINALS as additional medication doses", () => {
    for (const source of [
      "1 tablet on days 1, 8 and 15 of every 28-day cycle",
      "Administer 1 tablet on days 1, 8 and 15 of each 28-day cycle; " +
        "hold on day 8 if neutrophils below threshold."
    ]) {
      const parsed = parseSig(source);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]?.fhir.doseAndRate?.[0]?.doseQuantity)
        .toMatchObject({ value: 1, unit: "tab" });
      expect(parsed.items[0]?.fhir.doseAndRate?.length).toBe(1);
      expect(parsed.items[0]?.fhir.text).toContain("days 1, 8 and 15");
      // Without a supplied cycle anchor these ordinal days are NOT separate
      // executable doses. Preserve the clinically useful original wording.
      expect(parsed.items[0]?.fhir.timing?.repeat?.timeOfDay).toBeUndefined();
      expect(parsed.items[0]?.fhir.additionalInstruction?.some(advice =>
        /days 1, 8 and 15/u.test(advice.text ?? "")
      )).toBe(true);
      expect(parsed.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("Unresolved schedule: cycle")
      ]));
      const issues = lintSig(source).issues;
      expect(issues?.some(issue => issue.message.startsWith("Unresolved schedule: cycle"))).toBe(true);
    }
  });
});


describe("Parkinson movement-disorder dosing near-neighbors", () => {
  it("keeps a fixed daytime regimen and a separate optional bedtime half-dose", () => {
    const source = "Take 1 tablet at 07:00, 11:00, 15:00 and 19:00; take an extra half tablet at bedtime if symptoms worsen.";
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    const dosages = parsed.items.map(item => item.fhir);
    expect(dosages.some(dosage => {
      const quantity = dosage.doseAndRate?.[0]?.doseQuantity;
      return quantity?.value === 1 && quantity.unit === "tab" &&
        ["07:00:00", "11:00:00", "15:00:00", "19:00:00"]
          .every(clock => dosage.timing?.repeat?.timeOfDay?.includes(clock));
    })).toBe(true);
    expect(dosages.some(dosage => {
      const quantity = dosage.doseAndRate?.[0]?.doseQuantity;
      return quantity?.value === 0.5 && quantity.unit === "tab" &&
        dosage.timing?.repeat?.when?.includes("HS") &&
        (dosage.asNeeded === true || Boolean(getDosageCondition(dosage)));
    })).toBe(true);
  });
});


describe("Parkinson week-phase and real administration execution oracles", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const base = {
    timeZone: "Asia/Bangkok",
    orderedAt,
    eventClock: {
      WAKE: "06:30", MORN: "08:00", NOON: "12:00",
      EVE: "18:00", HS: "22:00",
      CM: "08:00", CD: "12:30", CV: "18:30"
    },
    // Institution-configured postmeal delays. Event clocks are meal times,
    // not pre-offset administration times; avoid a false 08:00/12:30 oracle.
    mealOffsets: { PCM: 30, PCD: 30, PCV: 30, PC: 30 }
  };
  const dueTimes = (parsed: ReturnType<typeof parseBatch>, date: string): string[] =>
    nextDueDoses(parsed, {
      ...base, from: date + "T00:00:00+07:00", limit: 16
    }).filter(timestamp => timestamp.slice(0, 10) === date)
      .map(timestamp => timestamp.slice(11, 16));
  const total = (parsed: ReturnType<typeof parseBatch>, days: number): number =>
    calculateTotalUnits({
      ...base, from: orderedAt, dosage: parsed,
      durationValue: days, durationUnit: "d"
    }).totalUnits;

  it.each([
    {
      input: "Take 1 tablet at 07:00, 11:00 and 15:00 for week 1; add a 19:00 dose from week 2.",
      first: ["07:00", "11:00", "15:00"],
      later: ["07:00", "11:00", "15:00", "19:00"],
      total21: 77
    },
    {
      input: "Take 1 tablet upon waking and 1 tablet at bedtime for a week, then add a noon dose.",
      first: ["06:30", "22:00"],
      later: ["06:30", "12:00", "22:00"],
      total21: 56
    },
    {
      input: "Take 1 tablet three times daily at 07:00, 13:00 and 19:00, but add half a tablet at 22:00 only from the second week.",
      first: ["07:00", "13:00", "19:00"],
      later: ["07:00", "13:00", "19:00", "22:00"],
      total21: 70
    }
  ])("only activates added Parkinson doses from the prescribed second week: $input", ({
    input, first, later, total21
  }) => {
    const parsed = parseBatch(input);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.input).toBe(input);
    for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const day = (date: string) => nextDueDoses(regimen, { ...base,
        from: date + "T00:00:00+07:00", limit: 16
      }).filter(timestamp => timestamp.startsWith(date))
        .map(timestamp => timestamp.slice(11, 16));
      expect(day("2026-11-02")).toEqual(first);
      expect(day("2026-11-09")).toEqual(later);
      expect(day("2026-11-16")).toEqual(later);
      const total = calculateTotalUnits({
        dosage: regimen, ...base, from: orderedAt,
        durationValue: 21, durationUnit: "d"
      });
      expect(total.totalUnits).toBe(total21);
    }
  });

  it("executes distinct week 1, week 2 and week 3 dose/clock regimens", () => {
    const parsed = parseBatch("Week 1: take half a tablet at 08:00 and 20:00. Week 2: take 1 tablet at 08:00 and 20:00. Week 3 onwards: take 1 tablet at 08:00, 14:00 and 20:00.");
    expect(parsed.fhirNext.step).toHaveLength(3);
    expect(parsed.fhir.map(item => item.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([0.5, 1, 1]);
    expect(dueTimes(parsed, "2026-11-02")).toEqual(["08:00", "20:00"]);
    expect(dueTimes(parsed, "2026-11-09")).toEqual(["08:00", "20:00"]);
    expect(dueTimes(parsed, "2026-11-16")).toEqual(["08:00", "14:00", "20:00"]);
    expect(total(parsed, 21)).toBe(42);
  });

  it("retains the half-tablet bedtime administration on each ordinary day", () => {
    const parsed = parseBatch("Take 1 tablet after breakfast and lunch, then half a tablet at bedtime.");
    expect(parsed.fhir.some(item => item.doseAndRate?.[0]?.doseQuantity?.value === 0.5 &&
      item.timing?.repeat?.when?.includes("HS"))).toBe(true);
    expect(dueTimes(parsed, "2026-11-02")).toEqual(["08:30", "13:00", "22:00"]);
    expect(dueTimes(parsed, "2026-11-09")).toEqual(["08:30", "13:00", "22:00"]);
    expect(total(parsed, 7)).toBe(17.5);
  });

  it("attaches the smaller afternoon dose to the afternoon clock", () => {
    const parsed = parseBatch("Take 1 tablet 30 minutes before breakfast, half a tablet at 15:00 and 1 tablet at bedtime.");
    expect(parsed.fhir.some(item => item.doseAndRate?.[0]?.doseQuantity?.value === 0.5 &&
      item.timing?.repeat?.timeOfDay?.includes("15:00:00"))).toBe(true);
    expect(dueTimes(parsed, "2026-11-02")).toEqual(["07:30", "15:00", "22:00"]);
    expect(total(parsed, 7)).toBe(17.5);
  });

  it("ends both morning and bedtime courses after their two seven-day phases", () => {
    const parsed = parseBatch("Take half a tablet in the morning and one tablet at bedtime for 7 days, then one tablet in the morning and one tablet at bedtime for 7 days.");
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(dueTimes(parsed, "2026-11-02")).toEqual(["08:00", "22:00"]);
    expect(dueTimes(parsed, "2026-11-09")).toEqual(["08:00", "22:00"]);
    expect(dueTimes(parsed, "2026-11-16")).toEqual([]);
    expect(total(parsed, 21)).toBe(24.5);
  });

  it("keeps a later conditional half-tablet bedtime dose independent of a scheduled waking-hours interval", () => {
    const input = "Take 1 tablet every 4 hours while awake; take an extra half tablet at bedtime only if symptoms persist.";
    const parsed = parseBatch(input);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhir).toHaveLength(2);
    const regular = parsed.fhir.find(row => row.doseAndRate?.[0]?.doseQuantity?.value === 1);
    const extra = parsed.fhir.find(row => row.doseAndRate?.[0]?.doseQuantity?.value === 0.5);
    expect(regular?.timing?.repeat).toMatchObject({ period: 4, periodUnit: "h" });
    expect(regular?.timing?.repeat?.extension).toContainEqual(
      expect.objectContaining({ url: expect.stringContaining("urn:ezmedicationinput:StructureDefinition:medication-timing-event-window") })
    );
    expect(regular?.asNeeded).not.toBe(true);
    expect(regular?.timing?.repeat?.when).toBeUndefined();
    expect(extra?.timing?.repeat?.when).toContain("HS");
    expect(extra?.asNeeded === true || Boolean(getDosageCondition(extra!))).toBe(true);
    const expected = ["06:30", "10:30", "14:30", "18:30", "22:00"];
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const regimen of [parsed.fhirNext, strict]) {
      expect(nextDueDoses(regimen, { ...base, from: orderedAt, limit: 5 })
        .map(timestamp => timestamp.slice(11, 16))).toEqual(expected);
      const total = calculateTotalUnits({
        dosage: regimen, ...base, from: orderedAt,
        durationValue: 7, durationUnit: "d"
      });
      expect(total.totalUnits).toBe(31.5);
      expect(total.quantityKind).toBe("maximum");
    }
    expect(parsed.input).toBe(input);
  });

  it("round-trips a typed waking-hour interval without turning the window into a single WAKE dose", () => {
    const input = "Take 1 tablet every 3 hours while awake.";
    const parsed = parseBatch(input);
    const direct = parsed.fhir[0];
    expect(direct.timing?.repeat?.when).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.eventWindow)
      .toEqual({ start: "WAKE", end: "HS" });
    const windowExtension = direct.timing?.repeat?.extension?.find(part =>
      part.url.endsWith("urn:ezmedicationinput:StructureDefinition:medication-timing-event-window")
    );
    expect(windowExtension?.extension).toEqual([
      { url: "start", valueCode: "WAKE" },
      { url: "end", valueCode: "HS" }
    ]);
    expect(fromFhirDosage(direct).meta.canonical.clauses[0]?.schedule?.eventWindow)
      .toEqual({ start: "WAKE", end: "HS" });
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(fromFhirDosage(strict[0]).meta.canonical.clauses[0]?.schedule?.eventWindow)
      .toEqual({ start: "WAKE", end: "HS" });
    expect(dueTimes(parsed, "2026-11-02"))
      .toEqual(["06:30", "09:30", "12:30", "15:30", "18:30", "21:30"]);
    expect(nextDueDoses(strict, { ...base,
      from: "2026-11-02T00:00:00+07:00", limit: 6
    }).map(ts => ts.slice(11, 16))).toEqual([
      "06:30", "09:30", "12:30", "15:30", "18:30", "21:30"
    ]);
    expect(total(parsed, 7)).toBe(42);
    expect(parsed.input).toBe(input);
  });

  it("keeps a punctual waking-time dose distinct from a recurring waking-hours window", () => {
    const parsed = parseBatch("Take 1 tablet on waking.");
    expect(parsed.fhir[0]?.timing?.repeat?.when).toEqual(["WAKE"]);
    expect(parsed.meta.canonical.clauses[0]?.schedule?.eventWindow).toBeUndefined();
    expect(dueTimes(parsed, "2026-11-02")).toEqual(["06:30"]);
  });

  it("keeps an awake-window eye-drop phase separate from a subsequent unrestricted QID phase", () => {
    const parsed = parseBatch("1 drop od q2h while awake x2d then qid x5d");
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[0]?.component[0]?.timing?.repeat).toMatchObject({
      period: 2, periodUnit: "h"
    });
    expect(parsed.fhirNext.step[0]?.component[0]?.timing?.repeat?.extension)
      .toContainEqual(expect.objectContaining({
        url: expect.stringContaining("urn:ezmedicationinput:StructureDefinition:medication-timing-event-window")
      }));
    expect(parsed.fhirNext.step[1]?.component[0]?.timing?.repeat).toMatchObject({
      frequency: 4, period: 1, periodUnit: "d"
    });
    expect(parsed.fhirNext.step[1]?.component[0]?.timing?.repeat?.extension
      ?.some(item => item.url.endsWith("urn:ezmedicationinput:StructureDefinition:medication-timing-event-window")))
      .not.toBe(true);
    for (const regimen of [parsed.fhirNext, strictR5]) {
      const day = (date: string) => nextDueDoses(regimen, { ...base,
        from: date + "T00:00:00+07:00", limit: 12
      }).filter(time => time.startsWith(date)).map(time => time.slice(11, 16));
      expect(day("2026-11-02")).toEqual([
        "06:30", "08:30", "10:30", "12:30", "14:30", "16:30", "18:30", "20:30"
      ]);
      expect(day("2026-11-04")).toEqual(["08:00", "12:00", "16:00", "20:00"]);
      expect(day("2026-11-09")).toEqual([]);
      expect(calculateTotalUnits({
        dosage: regimen, ...base, from: orderedAt,
        durationValue: 8, durationUnit: "d"
      }).totalUnits).toBe(36);
    }
  });

  it("executes q3h only inside configured waking hours, not overnight", () => {
    const parsed = parseBatch("Take 1 tablet every 3 hours while awake.");
    expect(dueTimes(parsed, "2026-11-02"))
      .toEqual(["06:30", "09:30", "12:30", "15:30", "18:30", "21:30"]);
    expect(total(parsed, 7)).toBe(42);
  });

  it("keeps Thai explicitly labelled weeks distinct without doubling doses", () => {
    const parsed = parseBatch("สัปดาห์ที่ 1 กินครึ่งเม็ดเวลา 07:00 และ 19:00 สัปดาห์ที่ 2 กิน 1 เม็ดเวลา 07:00 และ 19:00");
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhir.map(item => item.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([0.5, 1]);
    expect(dueTimes(parsed, "2026-11-02")).toEqual(["07:00", "19:00"]);
    expect(dueTimes(parsed, "2026-11-09")).toEqual(["07:00", "19:00"]);
    expect(total(parsed, 14)).toBe(21);
  });

  it("interprets Thai thirty minutes as pre-meal offset, not total course", () => {
    const parsed = parseBatch("รับประทาน 1 เม็ดก่อนอาหารเช้า กลางวัน และเย็น 30 นาที");
    expect(parsed.fhir[0]?.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(dueTimes(parsed, "2026-11-02"))
      .toEqual(["07:30", "12:00", "18:00"]);
  });

  it("keeps independently labelled week-one and week-two fixed-clock plans", () => {
    const parsed = parseBatch("Week 1: take 1 tablet at 07:00, 12:00 and 17:00. Week 2: take 1 tablet at 07:00, 11:00, 15:00 and 19:00.");
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(dueTimes(parsed, "2026-11-02")).toEqual(["07:00", "12:00", "17:00"]);
    expect(dueTimes(parsed, "2026-11-09")).toEqual(["07:00", "11:00", "15:00", "19:00"]);
  });

  it("preserves the already correct clear numeric weekly taper", () => {
    const parsed = parseBatch("Take 0.5 tablet once daily for 7 days, then 0.5 tablet twice daily for 7 days, then 1 tablet twice daily.");
    expect(dueTimes(parsed, "2026-11-02")).toHaveLength(1);
    expect(dueTimes(parsed, "2026-11-09")).toHaveLength(2);
    expect(dueTimes(parsed, "2026-11-16")).toHaveLength(2);
    expect(total(parsed, 21)).toBe(24.5);
  });
});

describe("Thai sequential first dose cannot silently disappear", () => {
  it.each([
    "ทาน 2 เม็ด หลังจากนั้นทานอีก 1 เม็ดหลังครั้งแรกอย่างน้อย 1 สัปดาห์",
    "ทาน 2 เม็ด แล้วทานอีก 1 เม็ดหลังครั้งแรก 7 วัน"
  ])("preserves both independently stated quantities without inventing a precise minimum-delay date: %s", source => {
    const parsed = parseBatch(source);
    // The first administered amount must remain executable. The additional
    // after-first dose may be a separately structured dosage when executable,
    // or a typed conditional/relative action awaiting clinician review when
    // only a minimum delay is known. Do not manufacture an exact schedule.
    expect(parsed.fhir[0]?.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.fhir[0]?.timing?.repeat?.boundsDuration).toBeUndefined();
    const typedSecondDose = parsed.fhir.some(row =>
      row.doseAndRate?.[0]?.doseQuantity?.value === 1
    ) || parsed.meta.canonical.clauses.some(clause =>
      clause.instructionGraph?.actions.some(action =>
        action.predicate.lemma === "take" &&
        action.args.some(arg => arg.role === "amount" && arg.quantity?.value === 1)
      )
    );
    expect(typedSecondDose).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(toFhirR5Dosages(parsed.fhirNext)[0]?.doseAndRate?.[0]?.doseQuantity)
      .toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.input).toBe(source);
  });
});


describe("round52 live site and partial-direction previews", () => {
  it.each(["local-first", "preferred-first", "local-only"] as const)(
    "keeps the preferred site and every supplied coding for %s", (order) => {
      const local = { system: "https://example.org/site", code: "SITE-OD", id: "local-coding", version: "2026" };
      const right = { system: "http://snomed.info/sct", code: "1290032005", id: "right-coding", version: "2026" };
      const coding = order === "local-only" ? [local] : order === "local-first" ? [local, right] : [right, local];
      const r6: ReturnType<typeof toDosageDetails> = { step: [{ component: [{
        site: { concept: { coding } }, doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } }
      }] }] };
      const expected = JSON.parse(JSON.stringify(r6));
      const rows = toFhirR5Dosages(r6);
      const cold = JSON.parse(JSON.stringify(rows));
      for (const input of [r6, cold]) {
        const before = JSON.parse(JSON.stringify(input));
        const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(en).toMatch(/(?:^|[^0-9.])1 drop\b/u);
        expect(en).toContain(order === "local-only" ? "SITE-OD" : "right eye");
        if (order === "local-only") {
          expect(en).not.toMatch(/\b(?:right|left|both)\b|\beyes?\b/iu);
          const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
          expect(th).toContain("SITE-OD");
          expect(th).not.toMatch(/ตาขวา|ตาซ้าย|ตาทั้งสอง|ทั้งสองข้าง/u);
        } else {
          expect(en).not.toContain("SITE-OD");
          expect(en).not.toContain("left eye");
          const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
          expect(th).toContain("ตาขวา");
          expect(th).not.toContain("ตาซ้าย");
        }
        expect(input).toEqual(before);
      }
      expect(toDosageDetails(cold).step?.[0].component?.[0].site?.concept?.coding).toEqual(expected.step[0].component[0].site.concept.coding);
      expect(r6).toEqual(expected);
    }
  );

  it.each([false, true])("retains the live skin restriction with omitted label=%s", (omitLabel) => {
    const r6 = JSON.parse(JSON.stringify(parseBatch("Apply 1 g to skin where skin is red daily max 2 g/day").fhirNext)) as ReturnType<typeof toDosageDetails>;
    const site = r6.step![0].component![0].site!.concept!;
    if (omitLabel) delete site.text;
    const expectedSite = JSON.parse(JSON.stringify(site));
    const expected = JSON.parse(JSON.stringify(r6));
    const rows = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [r6, rows]) for (const locale of ["en", "th"] as const) {
      const preview = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(preview).toContain("where skin is red");
      expect(preview).toMatch(locale === "en" ? /^Apply 1 g(?=\s)/u : /^ทาครั้งละ 1 g(?=\s)/u);
      expect(preview).toMatch(/(?:^|;\s*)max per period: 2 g \/ 1 d(?:$|[.;])/u);
    }
    expect(toDosageDetails(rows).step?.[0].component?.[0].site?.concept).toEqual(expectedSite);
    expect(r6).toEqual(expected);
  });

  it.each([false, true])("keeps the condition and authored directions with live dose=%s", (liveDose) => {
    const authored = "Swallow 1 tablet whole";
    const currentDirections = (preview: string, locale: "en" | "th") => {
      const prefix = locale === "en" ? "Current: " : "ปัจจุบัน: ";
      if (!preview.startsWith(prefix)) return preview;
      const parts = preview.slice(prefix.length).split(locale === "en"
        ? "; original directions: " : "; ข้อความเดิม: ");
      expect(parts).toHaveLength(2);
      expect(parts[1]).toBe(authored);
      return parts[0];
    };
    const completeThreshold = /\bSBP > 160(?!\d|\.\d)/u;
    const positiveThreshold = {
      en: /only if SBP > 160(?!\d|\.\d)/u,
      th: /เฉพาะเมื่อ SBP > 160(?!\d|\.\d)/u,
    };
    expect("unless SBP > 160").not.toMatch(positiveThreshold.en);
    expect("เว้นแต่ SBP > 160").not.toMatch(positiveThreshold.th);
    for (const changed of ["SBP > 1600", "SBP > 160.5"])
      expect(changed).not.toMatch(completeThreshold);
    const condition = { kind: "measurement", name: "sbp", operation: "gt", value: 160, text: "SBP > 160" } as const;
    const sourceNote = { url: "urn:round54:B17-source-note", valueString: "retain authored annotation" };
    const row: Parameters<typeof setDosageCondition>[0] = { text: authored, extension: [sourceNote] };
    setDosageCondition(row, condition);
    if (liveDose) row.doseAndRate = [{ doseQuantity: { value: 2, unit: "tab" } }];
    const expected = JSON.parse(JSON.stringify(row));
    const r6 = toDosageDetails([row]);
    const reopened = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [[row], r6, reopened]) {
      const before = JSON.parse(JSON.stringify(input));
      for (const locale of ["en", "th"] as const) for (const mode of ["normalized", "roundtrip"] as const) for (const style of ["short", "long"] as const) {
        const preview = formatSig(input, style, { locale, realizationMode: mode });
        const current = currentDirections(preview, locale);
        expect(current).toMatch(positiveThreshold[locale]);
        if (liveDose) {
          const exactAmount = locale === "en" ? /^(?:(?:Use|Swallow) )?2 (?:tablets|tab)(?: PO| whole)?(?: orally)? only if SBP > 160[.]?$/u
            : /^(?:(?:ใช้ครั้งละ|ใช้|กลืน)\s*)?2 เม็ด(?: PO| ?ทั้งเม็ด)?(?: ทางปาก)? เฉพาะเมื่อ SBP > 160[.]?$/u;
          expect(locale === "en" ? "Use 12 tablets" : "ใช้ครั้งละ 12 เม็ด").not.toMatch(exactAmount);
          expect(locale === "en" ? "Use 1–2 tablets" : "ใช้ครั้งละ 1–2 เม็ด").not.toMatch(exactAmount);
          expect(locale === "en" ? "Use 2 tablets or 3 tablets only if SBP > 160."
            : "ใช้ครั้งละ 2 เม็ด หรือ 3 เม็ด เฉพาะเมื่อ SBP > 160.").not.toMatch(exactAmount);
          expect(current).toMatch(exactAmount);
          expect(current).not.toContain("1 tablet");
          expect(current).not.toContain("1 เม็ด");
        } else {
          expect(preview).toContain(authored);
          if (current !== preview)
            expect(current).not.toMatch(/\d+(?:\.\d+)?\s*(?:tablets?\b|tab\b|เม็ด)/u);
        }
      }
      expect(input).toEqual(before);
    }
    expect(getDosageCondition(reopened[0])).toEqual(condition);
    expect(JSON.stringify(r6)).toContain(authored);
    expect(row).toEqual(expected);
    expect(r6.step?.[0].component?.[0].text).toBe(authored);
    expect(reopened[0].text).toBe(authored);
    expect(r6.step?.[0].component?.[0].extension).toEqual(expect.arrayContaining([sourceNote]));
    expect(reopened[0].extension).toEqual(expect.arrayContaining([sourceNote]));

    if (liveDose) {
      // An independently typed manner remains active beside the updated dose.
      // Conflicting unparsed source text above stays exact as source provenance.
      const typed: Parameters<typeof setDosageCondition>[0] = JSON.parse(JSON.stringify(
        toFhirR5Dosages(parseSig(authored).fhirNext)[0]
      ));
      setDosageCondition(typed, condition);
      typed.doseAndRate = [{ doseQuantity: { value: 2, unit: "tab" } }];
      typed.extension = [...(typed.extension ?? []), structuredClone(sourceNote)];
      const typedExpected = structuredClone(typed);
      const graph = structuredClone(typed.extension.find(extension =>
        extension.url === "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph"));
      expect(graph).toBeDefined();
      const typedR6 = toDosageDetails([typed]);
      const typedReopened = JSON.parse(JSON.stringify(toFhirR5Dosages(typedR6)));
      for (const input of [[typed], typedR6, typedReopened]) {
        const before = structuredClone(input);
        for (const locale of ["en", "th"] as const) for (const mode of ["normalized", "roundtrip"] as const) for (const style of ["short", "long"] as const) {
          const preview = formatSig(input, style, { locale, realizationMode: mode });
          const current = currentDirections(preview, locale);
          expect(current).toMatch(positiveThreshold[locale]);
          const exactAmount = locale === "en" ? /^(?:(?:Use|Swallow) )?2 (?:tablets|tab)(?: PO| whole)?(?: orally)? only if SBP > 160[.]?$/u
            : /^(?:(?:ใช้ครั้งละ|ใช้|กลืน)\s*)?2 เม็ด(?: PO| ?ทั้งเม็ด)?(?: ทางปาก)? เฉพาะเมื่อ SBP > 160[.]?$/u;
          expect(locale === "en" ? "Use 12 tablets" : "ใช้ครั้งละ 12 เม็ด").not.toMatch(exactAmount);
          expect(locale === "en" ? "Use 1–2 tablets" : "ใช้ครั้งละ 1–2 เม็ด").not.toMatch(exactAmount);
          expect(locale === "en" ? "Use 2 tablets or 3 tablets only if SBP > 160."
            : "ใช้ครั้งละ 2 เม็ด หรือ 3 เม็ด เฉพาะเมื่อ SBP > 160.").not.toMatch(exactAmount);
          expect(current).toMatch(exactAmount);
          expect(current).not.toContain("1 tablet");
          expect(current).not.toContain("1 เม็ด");
          if (style === "long") expect(current).toContain(locale === "en" ? "whole" : "ทั้งเม็ด");
        }
        expect(input).toEqual(before);
      }
      expect(typed).toEqual(typedExpected);
      expect(typedR6.step?.[0].component?.[0].extension).toEqual(expect.arrayContaining([graph, sourceNote]));
      const savedSource = typedR6.extension?.find(extension =>
        extension.url === "urn:ezmedicationinput:StructureDefinition:medication-course-reconciliation-source");
      expect(savedSource).toBeDefined();
      const savedComponent = savedSource?.extension?.find(extension =>
        extension.url === "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details")
        ?.extension?.find(extension => extension.url === "component");
      expect(savedComponent?.extension).toContainEqual({ url: "text", valueString: typedExpected.text });
      expect(toDosageDetails(typedReopened).extension).toEqual(expect.arrayContaining([savedSource]));
      expect(typedReopened[0].extension).toEqual(expect.arrayContaining([graph, sourceNote]));
      expect(getDosageCondition(typedReopened[0])).toEqual(condition);
    }
  });
});


describe("round52 source-only and repeated-window preview ownership", () => {
  it("keeps an ordinary text-only R5 direction through the native preview route", () => {
    const row = { text: "Swallow 1 tablet whole", id: "authored-only", extension: [{ url: "https://example.org/annotation", valueString: "keep" }] };
    const before = JSON.parse(JSON.stringify(row));
    const r6 = toDosageDetails([row]);
    const reopened = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [[row], r6, reopened]) for (const locale of ["en", "th"] as const)
      for (const mode of ["normalized", "roundtrip"] as const)
        expect(formatSig(input, "long", { locale, realizationMode: mode })).toContain("Swallow 1 tablet whole");
    expect(row).toEqual(before);
    expect(reopened[0].text).toBe(before.text);
    expect(reopened[0].id).toBe(before.id);
    expect(reopened[0].extension).toEqual(expect.arrayContaining(before.extension));
  });

  it.each(["implicit-followup", "explicit-followup", "implicit-first"] as const)(
    "does not promise an unproved no-dose window for %s", (variant) => {
      const boundary = (value: number) => ({ contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] }, offsetDuration: { value, unit: "d" } });
      const component = () => [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: "d", timeOfDay: ["12:30:00"] } } }];
      const first = variant === "implicit-first";
      const r6: ReturnType<typeof toDosageDetails> = { step: first ? [
        { count: 2, end: boundary(2), component: component() },
        { start: boundary(5), end: boundary(6), component: component() }
      ] : [
        { end: boundary(1), component: component() },
        { count: 2, ...(variant === "explicit-followup" ? { start: boundary(1) } : {}), end: boundary(2), component: component() },
        { start: boundary(4), end: boundary(5), component: component() }
      ] };
      const expected = JSON.parse(JSON.stringify(r6));
      const rows = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
      for (const input of [r6, rows]) {
        const preview = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(preview).toContain("Perform this phase 2 times");
        if (variant === "implicit-followup") expect(preview).not.toContain("No doses");
        else expect(preview).toContain(first
          ? "No doses from 4 days after treatment start until 5 days after treatment start"
          : "No doses from 3 days after treatment start until 4 days after treatment start");
        const context = { orderedAt: "2026-10-30T12:00:00-04:00", from: "2026-10-30T12:00:00-04:00", timeZone: "America/New_York" };
        const expectedDates = ["2026-10-30T12:30:00-04:00", "2026-10-31T12:30:00-04:00", "2026-11-01T12:30:00-05:00"];
        if (variant !== "explicit-followup") expectedDates.push("2026-11-02T12:30:00-05:00");
        expectedDates.push(first ? "2026-11-04T12:30:00-05:00" : "2026-11-03T12:30:00-05:00");
        expect(nextDueDoses(input, { ...context, limit: 12 })).toEqual(expectedDates);
        expect(calculateTotalUnits({ ...context, dosage: input, durationValue: first ? 6 : 5, durationUnit: "d" }).totalUnits)
          .toBe(variant === "explicit-followup" ? 4 : 5);
      }
      expect(toDosageDetails(rows).step?.map(step => ({ count: step.count, start: step.start, end: step.end })))
        .toEqual(expected.step.map((step: NonNullable<typeof r6.step>[number]) => ({ count: step.count, start: step.start, end: step.end })));
      expect(r6).toEqual(expected);
    }
  );
});

describe("round79 current clinical preview ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const boundary = (days: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value: days, unit: "d", code: "d" }
  });
  const component = (value: number) => ({
    doseAndRate: [{ doseQuantity: { value, unit: "mg" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
  });

  it.each([false, true])("keeps the unresolved predecessor before an event end (explicit start=%s)", explicit => {
    const raw: FhirR6DosageInstruction = { step: [
      { component: [{ ...component(1), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, count: 2 } } }] },
      { ...(explicit ? { start: boundary(2) } : {}),
        end: { contextCode: { coding: [{ system: "https://clinic.example/events", code: "follow-up" }] } },
        component: [component(2)] }
    ] };
    const before = fresh(raw);
    for (const input of [fresh(raw), fresh(toFhirR5Dosages(raw))]) {
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        const predecessor = locale === "en" ? "After the previous phase" : "หลังขั้นตอนก่อนหน้า";
        expect(text).toContain("follow-up");
        expect(text.includes(predecessor)).toBe(!explicit);
        if (!explicit) expect(text).toContain(locale === "en"
          ? "After the previous phase; Timing requires review: Until follow-up: Use 2 mg once daily."
          : "หลังขั้นตอนก่อนหน้า; ต้องตรวจสอบช่วงเวลา: จนถึงfollow-up: ใช้ครั้งละ 2 มิลลิกรัม วันละครั้ง.");
        else expect(text).toContain(locale === "en"
          ? "From 2 days after treatment start until follow-up: Use 2 mg once daily."
          : "ตั้งแต่2 วันหลังเริ่มการรักษาจนถึงfollow-up: ใช้ครั้งละ 2 มิลลิกรัม วันละครั้ง.");
      }
    }
    expect(raw).toEqual(before);
  });

  it("keeps the applicable stage cap in each standalone saved row", () => {
    const raw: FhirR6DosageInstruction = { step: [
      { end: boundary(2), safety: { doseLimit: [{ scope: "administration", valueQuantity: { value: 8, unit: "mg" } }] },
        component: [component(5)] },
      { start: boundary(2), component: [component(3)] }
    ] };
    const rows = fresh(toFhirR5Dosages(raw)), before = fresh(rows);
    for (const locale of ["en", "th"] as const) {
      const first = fromFhirDosage(fresh(rows[0]), { locale, realizationMode: "normalized" });
      const second = fromFhirDosage(fresh(rows[1]), { locale, realizationMode: "normalized" });
      for (const text of [first.shortText, first.longText]) {
        expect(text).toContain(locale === "en" ? "Within this stage: " : "ในขั้นตอนนี้: ");
        expect(text).toContain("max per administration: 8 mg");
      }
      for (const text of [second.shortText, second.longText]) expect(text).not.toContain("8 mg");
    }
    expect(rows).toEqual(before);
  });

  it.each([false, true])("displays saved inactive draft bounds without inventing an administration (bounded=%s)", bounded => {
    const saved: FhirR6DosageInstruction = { step: [] };
    retainDraftSteps(saved, [{ index: 0, step: bounded ? { start: boundary(2), end: boundary(5) } : {} }]);
    const before = fresh(saved), rows = fresh(toFhirR5Dosages(saved));
    for (const input of [fresh(saved), rows]) {
      const course = importCanonicalCourse(input);
      expect(course.stages.flatMap(stage => stage.administrations)).toEqual([]);
      for (const locale of ["en", "th"] as const) {
        const options = { locale, realizationMode: "normalized" as const };
        const previews = [formatSig(input, "long", options)];
        if (!Array.isArray(input))
          previews.push(formatParseBatch(fromFhir(input, options), "long", options));
        for (const text of previews) {
          if (bounded) {
            expect(text).toContain(locale === "en" ? "2 days after treatment start" : "2 วันหลังเริ่มการรักษา");
            expect(text).toContain(locale === "en" ? "5 days after treatment start" : "5 วันหลังเริ่มการรักษา");
            expect(text).not.toMatch(/(?:tablet|\bmg\b|เม็ด|รับประทาน)/u);
          } else expect(text).toBe("");
        }
      }
    }
    expect(saved).toEqual(before);
  });

  it.each([EventTiming.Morning, EventTiming["Before Sleep"], undefined] as const)("lets current event timing own a retained BED code (%s)", when => {
    const code = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 5, unit: "mg" } }],
      timing: { code, ...(when ? { repeat: { when: [when] } } : {}) }
    }] }] };
    for (const input of [fresh(raw), fresh(toFhirR5Dosages(raw))]) {
      for (const locale of ["en", "th"] as const) {
        const short = formatSig(input, "short", { locale, realizationMode: "normalized" });
        if (when === EventTiming.Morning) {
          expect(short).not.toContain("BED");
          expect(formatSig(input, "long", { locale, realizationMode: "normalized" }))
            .toContain(locale === "en" ? "morning" : "เช้า");
        } else expect(short).toContain("BED");
      }
    }
    expect(toDosageDetails(fresh(toFhirR5Dosages(raw))).step[0].component[0].timing?.code).toEqual(code);
  });

  it.each([false, true])("retains literal timing beside an independent graph warning (timing=%s)", timed => {
    const source = "Do not crush";
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: parseInstructionActions(source) })!;
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      extension: [marker],
      ...(timed ? { timing: { code: { coding: [{ system: "https://clinic.example/timing", code: "dialysis-after", display: "after dialysis" }] } } } : {})
    }] }] };
    for (const input of [fresh(raw), fresh(toFhirR5Dosages(raw))]) for (const locale of ["en", "th"] as const) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "Do not crush" : "ห้ามบด");
      expect(text.includes("after dialysis")).toBe(timed);
      if (!timed) expect(text).toBe(locale === "en" ? "Do not crush." : "ห้ามบด.");
    }
  });

  it.each(["doseExpression", "rateExpression"] as const)("retains authored dose beside an annotation-only %s", field => {
    const expression = { id: "unavailable-dose", language: "text/fhirpath",
      _expression: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }] } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      text: "Take 5 mg daily", doseAndRate: [{ [field]: expression }],
      ...(field === "rateExpression" ? { timing: { repeat: { duration: 1, durationUnit: FhirPeriodUnit.Hour } } } : {})
    }] }] };
    for (const input of [fresh(raw), fresh(toFhirR5Dosages(raw))]) for (const locale of ["en", "th"] as const)
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" })).toContain("Take 5 mg daily");
    expect(toDosageDetails(fresh(toFhirR5Dosages(raw))).step[0].component[0].doseAndRate?.[0]?.[field]).toEqual(expression);
  });
});


describe("independent coded timing previews", () => {
  const gts = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
  it("keeps free PM evening shorthand out of the standard afternoon coding", () => {
    const source = "Take 1 tablet pm";
    const parsed = parseBatch(source);
    for (const timing of [parsed.fhir[0].timing, parsed.fhirNext.step?.[0]?.component[0].timing,
      parsed.items[0].fhir.timing]) {
      expect(timing?.repeat?.when).toEqual([EventTiming.Evening]);
      expect(timing?.code).toEqual({ text: "PM" });
    }
    expect(parsed.longText).toBe("Take 1 tablet orally in the evening.");
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([
    ["am", { when: [EventTiming.Morning] }, "AM", "in the morning"],
    ["bid", { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day }, "BID", "twice daily"],
    ["in the evening", { when: [EventTiming.Evening] }, undefined, "in the evening"],
    ["in the afternoon", { when: [EventTiming.Afternoon] }, undefined, "in the afternoon"],
  ] as const)("retains the parsed %s timing facts and coding identity", (wording, repeat, code, preview) => {
    const source = `Take 1 tablet ${wording}`;
    const parsed = parseBatch(source);
    for (const timing of [parsed.fhir[0].timing, parsed.fhirNext.step?.[0]?.component[0].timing,
      parsed.items[0].fhir.timing]) {
      expect(timing?.repeat).toEqual(repeat);
      expect(timing?.code).toEqual(code ? { coding: [{ system: gts, code }], text: code } : undefined);
    }
    expect(parsed.longText).toBe(`Take 1 tablet orally ${preview}.`);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([
    ["unknown shorthand", { code: "AFT" }, undefined, "09:00:00", 1],
    ["unknown standard coding", { system: gts, code: "AFT" }, undefined, "09:00:00", 1],
    ["morning preview alias", { code: "QAM" }, undefined, "09:00:00", 1],
    ["evening preview alias", { code: "QPM" }, undefined, "09:00:00", 1],
    ["configured preview alias", { code: "QAM" }, "06:30", "06:30:00", 0],
    ["configured unknown code", { code: "AFT" }, "16:30", "16:30:00", 0],
    ["configured foreign code", { system: "urn:clinic:timing", code: "MORNING" }, "07:45", "07:45:00", 0]
  ] as const)("keeps numeric cadence independent of %s", (_label, coding, configured, clock, morningTotal) => {
    const row = { text: "Use one tablet with the current daily cadence and supplied timing code.",
      extension: [{ url: "urn:clinic:timing-note", valueString: "retain the authored timing coding" }],
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [coding] },
        repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    const options = { from: "2027-01-01T00:00:00Z", orderedAt: "2027-01-01T00:00:00Z",
      timeZone: "UTC", limit: 2,
      ...(configured ? { frequencyDefaults: { byCode: { [coding.code]: [configured] } } } : {}) };
    for (const input of [row, r6, importCanonicalCourse(row)]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, options)).toEqual([
        "2027-01-01T" + clock + "+00:00", "2027-01-02T" + clock + "+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, from: "2027-01-01T08:30:00Z",
        durationValue: 1, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(morningTotal);
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.schedule?.code).toEqual(row.timing.code);
      expect(member.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(member.text).toBe(row.text);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([
    ["AM", "in the morning", "ตอนเช้า"],
    ["PM", "in the afternoon", "ตอนบ่าย"],
    ["BED", "at bedtime", "ก่อนนอน"],
    ["bed", "at bedtime", "ก่อนนอน"],
  ])("retains the event in code-only %s long previews", (value, english, thai) => {
    const code = { coding: [{ code: value, ...(value === value.toUpperCase() ? { system: gts } : {}) }] };
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { code } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    for (const input of [row, r6]) {
      expect(formatSig(input, "long", { locale: "en" })).toBe(`Use 1 tablet ${english}.`);
      expect(formatSig(input, "long", { locale: "th" })).toBe(`ใช้ครั้งละ 1 เม็ด ${thai}.`);
    }
    expect(toFhirR5Dosages(r6)[0].timing?.code).toEqual(code);
    expect(toDosageDetails([row]).step[0].component[0].timing?.code).toEqual(code);
  });

  it.each([
    [{ code: "PM" }, "in the evening", "ตอนเย็น"],
    [{ system: "urn:clinic:timing", code: "PM" }, "PM", "PM"]
  ] as const)("keeps free and foreign PM interpretations separate from standard coding", (coding, english, thai) => {
    const timing = { code: { coding: [coding] } };
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing };
    const r6: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    for (const input of [row, r6]) {
      expect(formatSig(input, "long", { locale: "en" })).toBe(`Use 1 tablet ${english}.`);
      expect(formatSig(input, "long", { locale: "th" })).toBe(`ใช้ครั้งละ 1 เม็ด ${thai}.`);
    }
    expect(toFhirR5Dosages(r6)[0].timing).toEqual(timing);
  });

  it.each([
    [EventTiming.Afternoon, "in the afternoon", "ตอนบ่าย"],
    [EventTiming.Evening, "in the evening", "ตอนเย็น"]
  ] as const)("keeps explicit %s authoritative beside standard PM", (when, english, thai) => {
    const timing = { code: { coding: [{ system: gts, code: "PM" }] }, repeat: { when: [when] } };
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing };
    const r6: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    for (const input of [row, r6]) {
      expect(formatSig(input, "long", { locale: "en" })).toBe(`Use 1 tablet ${english}.`);
      expect(formatSig(input, "long", { locale: "th" })).toBe(`ใช้ครั้งละ 1 เม็ด ${thai}.`);
    }
    expect(toFhirR5Dosages(r6)[0].timing).toEqual(timing);
  });

  it("uses the standard afternoon clock while retaining free PM and configured clock ownership", () => {
    const component = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: gts, code: "PM" }] } } };
    const native: FhirR6DosageInstruction = { step: [{ component: [component] }] };
    const options = { from: "2027-01-01T00:00:00Z", orderedAt: "2027-01-01T00:00:00Z", timeZone: "UTC", limit: 2 };
    for (const source of [component, native]) {
      const before = JSON.stringify(source);
      expect(nextDueDoses(source, options)).toEqual([
        "2027-01-01T15:00:00+00:00", "2027-01-02T15:00:00+00:00"
      ]);
      expect(nextDueDoses(source, { ...options,
        frequencyDefaults: { byCode: { PM: ["16:30"] } } })).toEqual([
        "2027-01-01T16:30:00+00:00", "2027-01-02T16:30:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: source, from: "2027-01-01T14:00:00Z",
        durationValue: 2, durationUnit: FhirPeriodUnit.Hour, orderedAt: options.orderedAt, timeZone: "UTC" }).totalUnits).toBe(1);
      expect(JSON.stringify(source)).toBe(before);
    }
    const free = { doseAndRate: component.doseAndRate, timing: { code: { coding: [{ code: "PM" }] } } };
    expect(nextDueDoses(free, options)).toEqual([
      "2027-01-01T20:00:00+00:00", "2027-01-02T20:00:00+00:00"
    ]);
    for (const coding of [{ code: "AFT" }, { system: gts, code: "AFT" }]) {
      const unrecognized = { doseAndRate: component.doseAndRate, timing: { code: { coding: [coding] } } };
      expect(nextDueDoses(unrecognized, options)).toEqual([]);
    }
    const explicit = { doseAndRate: component.doseAndRate, timing: { ...component.timing,
      repeat: { when: [EventTiming.Evening] } } };
    expect(nextDueDoses(explicit, options)).toEqual([
      "2027-01-01T19:00:00+00:00", "2027-01-02T19:00:00+00:00"
    ]);
  });

  it.each([
    ["bid", "twice daily"], ["tid", "three times daily"], ["qid", "four times daily"],
    ["qd", "once daily"], ["qod", "every other day"], ["wk", "once weekly"], ["mo", "once monthly"],
  ])("renders the recognized systemless %s cadence without changing its spelling", (value, phrase) => {
    const code = { coding: [{ code: value }] };
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { code } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    for (const input of [row, r6])
      expect(formatSig(input, "long", { locale: "en" })).toBe(`Use 1 tablet ${phrase}.`);
    expect(toFhirR5Dosages(r6)[0].timing?.code).toEqual(code);
  });

  it("keeps explicit event and clock previews without duplicating a code anchor", () => {
    const doseAndRate = [{ doseQuantity: { value: 1, unit: "tab" } }];
    const code = { coding: [{ system: gts, code: "AM" }] };
    const event = { doseAndRate, timing: { code, repeat: { when: [EventTiming.Morning] } } };
    const clock = { doseAndRate, timing: { code, repeat: { timeOfDay: ["08:00:00"] } } };
    expect(formatSig(event, "long", { locale: "en" })).toBe("Use 1 tablet in the morning.");
    expect(formatSig(event, "long", { locale: "th" })).toBe("ใช้ครั้งละ 1 เม็ด ตอนเช้า.");
    expect(formatSig(clock, "long", { locale: "en" })).toBe("Use 1 tablet at 8:00 am.");
    expect(formatSig(clock, "long", { locale: "th" })).toBe("ใช้ครั้งละ 1 เม็ด เวลา 08:00.");
  });

  it.each([false, true])("retains compact interval meaning with a frequency-only repeat (complete=%s)", complete => {
    const code = { coding: [{ code: "q4-6h", display: "every 4 to 6 hours" }] };
    const repeat = { frequency: 1, ...(complete ? { period: 4, periodMax: 6, periodUnit: FhirPeriodUnit.Hour } : {}) };
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { code, repeat } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    for (const input of [row, r6]) {
      expect(formatSig(input, "long", { locale: "en" })).toBe(complete
        ? "Use 1 tablet once every 4 to 6 hours." : "Use 1 tablet once q4-6h.");
      expect(formatSig(input, "long", { locale: "th" })).toBe(complete
        ? "ใช้ครั้งละ 1 เม็ด 1 ครั้ง ทุก 4 ถึง 6 ชั่วโมง." : "ใช้ครั้งละ 1 เม็ด 1 ครั้ง q4-6h.");
    }
    expect(toFhirR5Dosages(r6)[0].timing?.code).toEqual(code);
  });
});


describe("independent cadence display ownership", () => {
  const doseAndRate = [{ doseQuantity: { value: 1, unit: "tab" } }];
  it.each([false, true])("renders an existing two-week code without losing its interval (repeat=%s)", complete => {
    const code = { coding: [{ code: "Q2WK" }] };
    const row = { doseAndRate, timing: { code, ...(complete
      ? { repeat: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Week } } : {}) } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    for (const input of [row, raw]) {
      expect(formatSig(input, "long", { locale: "en" })).toBe("Use 1 tablet every 2 weeks.");
      expect(formatSig(input, "long", { locale: "th" })).toBe("ใช้ครั้งละ 1 เม็ด ทุก 2 สัปดาห์.");
    }
    expect(toFhirR5Dosages(raw)[0].timing?.code).toEqual(code);
  });

  it.each([false, true])("prefers a recognized bedtime preview in either coding order (localFirst=%s)", localFirst => {
    const local = { system: "https://clinic.example/timing", code: "BEDTIME" };
    const known = { code: "QHS" };
    const code = { coding: localFirst ? [local, known] : [known, local] };
    const row = { doseAndRate, timing: { code } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    for (const input of [row, raw]) {
      expect(formatSig(input, "long", { locale: "en" })).toBe("Use 1 tablet at bedtime.");
      expect(formatSig(input, "long", { locale: "th" })).toBe("ใช้ครั้งละ 1 เม็ด ก่อนนอน.");
    }
    expect(toFhirR5Dosages(raw)[0].timing?.code).toEqual(code);
    expect(toDosageDetails([row]).step[0].component[0].timing?.code).toEqual(code);
  });

  it.each([{ frequency: 1 }, { frequencyMax: 3 }, { period: 1 }])(
    "retains the authored daily period when the numeric repeat lacks its unit: %j", repeat => {
      const code = { text: "once daily" };
      const row = { doseAndRate, timing: { code, repeat } };
      const raw: FhirR6DosageInstruction = { step: [{ component: [row] }] };
      for (const input of [row, raw]) {
        expect(formatSig(input, "long", { locale: "en" })).toContain("once daily");
        expect(formatSig(input, "long", { locale: "th" })).toContain("once daily");
        expect(formatSig(input, "long", { locale: "th" })).not.toContain("ครั้งเดียว");
        if ("frequencyMax" in repeat) {
          expect(formatSig(input, "long", { locale: "en" }))
            .toBe("Current: Use 1 tablet up to 3 times; original directions: once daily.");
          expect(formatSig(input, "long", { locale: "th" }))
            .toBe("ปัจจุบัน: ใช้ครั้งละ 1 เม็ด ไม่เกิน 3 ครั้ง; ข้อความเดิม: once daily.");
        }
      }
      const projected = toFhirR5Dosages(raw)[0].timing;
      expect(projected?.code).toEqual(code);
      expect(projected?.repeat).toEqual(repeat);
      expect(projected?.repeat?.periodUnit).toBeUndefined();
    });
});



describe("fresh structured quantity and annotation ownership", () => {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const ucum = "http://unitsofmeasure.org";

  it("uses a coded group's established unit to select the tighter compatible maximum", () => {
    const coded = { system: "urn:clinic:dose-unit", code: "tablet" };
    const amounts = [{ ...coded, value: 2, id: "coded-minimum" },
      { ...coded, value: 4, unit: "tablet", id: "unit-owner" },
      { value: 1, unit: "tablet", id: "tightest", _value: { id: "limit-note" } }];
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const limits = order.map(index => ({ scope: "administration" as const, valueQuantity: amounts[index] }));
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { ...coded, value: 1 } }],
        timing: { repeat: daily }, safety: { doseLimit: limits },
      }] }] };
      const before = copy(input), rows = toFhirR5Dosages(input);
      expect(rows[0].maxDosePerAdministration).toEqual(amounts[2]);
      expect(toDosageDetails(copy(rows)).step![0].component[0].safety!.doseLimit).toEqual(limits);
      expect(input).toEqual(before);
    }
    expect(convertQuantityValue(2, { ...coded }, { ...coded })).toBe(2);
    expect(convertQuantityValue(2, { ...coded }, { system: coded.system, code: "other" })).toBeNull();
  });

  it("keeps explicit UCUM identities separate from authored shorthand aliases", () => {
    const enzyme = { system: ucum, code: "U", unit: "enzyme unit" };
    const international = { system: ucum, code: "[iU]", unit: "international unit" };
    expect(convertQuantityValue(2, enzyme, international)).toBeNull();
    expect(convertQuantityValue(2, enzyme, { ...enzyme, unit: "U" })).toBe(2);
    expect(convertQuantityValue(2, { unit: "U" }, international)).toBe(2);
    expect(convertQuantityValue(1, { system: ucum, code: "g" }, { system: ucum, code: "mg" })).toBe(1000);
    expect(convertQuantityValue(1, { system: ucum, code: "l" }, { system: ucum, code: "mL" })).toBe(1000);
    expect(convertQuantityValue(1, { system: ucum, code: "ml" }, { system: ucum, code: "mL" })).toBe(1);
    expect(convertQuantityValue(1, { system: ucum, code: "ML" }, { system: ucum, code: "mL" })).toBeNull();
    expect(convertQuantityValue(1, { system: ucum, code: "5.mL" }, { system: ucum, code: "mL" })).toBe(5);
    const limits = [{ scope: "administration" as const, valueQuantity: { ...enzyme, value: 20 } },
      { scope: "administration" as const, valueQuantity: { ...international, value: 1 } }];
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { ...enzyme, value: 10 } }], safety: { doseLimit: limits },
    }] }] };
    const before = copy(input), rows = toFhirR5Dosages(input);
    expect(rows[0].maxDosePerAdministration).toEqual(limits[0].valueQuantity);
    expect(toDosageDetails(copy(rows)).step![0].component[0].safety!.doseLimit).toEqual(limits);
    expect(input).toEqual(before);
  });

  it.each([
    { code: "ml", value: 100, tighterCode: "L", tighterValue: 0.05 },
    { code: "l", value: 0.1, tighterCode: "mL", tighterValue: 50 },
  ])("compares the UCUM litre symbol $code without folding prefix case", ({ code, value, tighterCode, tighterValue }) => {
    const first = { system: ucum, code, value, id: "larger-volume", _value: { id: "authored-volume" } };
    const tight = { system: ucum, code: tighterCode, value: tighterValue, id: "smaller-volume" };
    for (const quantities of [[first, tight], [tight, first]]) {
      const limits = quantities.map(valueQuantity => ({ scope: "administration" as const, valueQuantity }));
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { system: ucum, code, value: value / 10 } }], safety: { doseLimit: limits },
      }] }] };
      const before = copy(input), rows = toFhirR5Dosages(input);
      expect(rows[0].maxDosePerAdministration).toEqual(tight);
      expect(toDosageDetails(copy(rows)).step![0].component[0].safety!.doseLimit).toEqual(limits);
      expect(input).toEqual(before);
    }
  });

  it.each([undefined, 1])("preserves a two-hour upper administration duration with lower %s", lower => {
    const missing = { id: "lower-duration", extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
    }] };
    const row: FhirDosage = { text: "Infuse up to two hours", doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }],
      timing: { repeat: { ...daily, ...(lower === undefined ? { _duration: missing } : { duration: lower }),
        durationMax: 2, durationUnit: FhirPeriodUnit.Hour } } };
    const before = copy(row), canonical = canonicalFromFhir(row);
    expect(canonical.schedule?.administrationDuration).toBe(lower);
    expect(canonical.schedule?.administrationDurationMax).toBe(2);
    const written = canonicalToFhir(canonical);
    expect(written.timing!.repeat).toMatchObject({ durationMax: 2, durationUnit: FhirPeriodUnit.Hour });
    expect(written.timing!.repeat!.duration).toBe(lower);
    const wire = toDosageDetails([row]);
    for (const current of [toFhirR5Dosages(wire)[0], wire.step![0].component[0]]) {
      expect(current.timing!.repeat).toMatchObject({ durationMax: 2, durationUnit: FhirPeriodUnit.Hour });
      expect(current.timing!.repeat!.duration).toBe(lower);
      if (lower === undefined) expect(current.timing!.repeat!._duration).toEqual(missing);
    }
    expect(row).toEqual(before);
  });

  it("projects quantities nested in an extension primitive companion", () => {
    const quantity: FhirR6Quantity = { value: 1, unit: "tablet", _unit: { id: "unit-note", extension: [{
      id: "annotation", url: "urn:clinic:annotation", valueString: "Authored label",
      _valueString: { id: "label-note", extension: [{ url: "urn:clinic:estimate",
        valueQuantity: { value: 2, unit: "mg", comparator: "~" } }] },
    }] } };
    const before = copy(quantity), projected = quantityForR5(quantity)!;
    const annotation = projected._unit!.extension![0];
    expect(annotation).toMatchObject({ id: "annotation", url: "urn:clinic:annotation", valueString: "Authored label",
      _valueString: { id: "label-note" } });
    const estimate = annotation._valueString!.extension![0].valueQuantity!;
    expect(estimate.comparator).toBeUndefined();
    expect(getQuantityComparator(estimate)).toBe("~");
    expect(quantityFromR5(copy(projected))).toEqual(quantity);
    expect(quantity).toEqual(before);
  });

  it.each([true, false])("preserves method primitive IDs and boolean annotation %s", reviewed => {
    const annotation = { id: "review-marker", url: "urn:clinic:reviewed", valueBoolean: reviewed };
    const method = { text: "Infuse", _text: { id: "method-note", extension: [annotation] } };
    const row: FhirDosage = { text: "Infuse 100 mL daily", method,
      doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }], timing: { repeat: daily } };
    const before = copy(row), native = fromFhirDosage(row), r6 = toDosageDetails([row]);
    for (const current of [native.fhir, r6.step![0].component[0], toFhirR5Dosages(r6)[0]])
      expect(current.method?._text).toEqual(method._text);
    expect(row).toEqual(before);
  });

  it("accepts and retains current repeat and condition primitive annotations without casts", () => {
    const note = { id: "typed-note", extension: [{ url: "urn:clinic:estimate",
      valueQuantity: { value: 2, unit: "mg", comparator: "~" as const } }] };
    const repeat: NonNullable<FhirR6Timing["repeat"]> = { ...daily, count: 2, countMax: 3,
      _countMax: note, duration: 1, durationMax: 2, durationUnit: FhirPeriodUnit.Hour,
      _durationMax: note, _durationUnit: note, periodMax: 2, _periodMax: note, _periodUnit: note };
    const condition: FhirR6DosageCondition = { code: { text: "if needed" }, text: "If needed",
      _text: { id: "condition-text", extension: [{ url: "urn:clinic:reviewed", valueBoolean: false }] } };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ timing: { repeat }, condition: [condition],
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }] };
    const before = copy(input), rows = toFhirR5Dosages(input), restored = toDosageDetails(copy(rows));
    const current = restored.step![0].component[0];
    for (const key of ["_countMax", "_durationMax", "_durationUnit", "_periodMax", "_periodUnit"] as const)
      expect(current.timing!.repeat![key]).toEqual(note);
    expect(current.condition![0]._text).toEqual(condition._text);
    expect(input).toEqual(before);
  });

  it("retains relation, repeated Coding, and argument span wrapper annotations by occurrence", () => {
    const relation = { system: "http://snomed.info/sct", code: "421463005", display: "With - dosing instruction fragment" };
    const coding = { system: "urn:clinic:actions", code: "rinse" };
    const argument: FhirExtension = { url: "argument", extension: [
      { url: "role", valueCode: "object" }, { url: "text", valueString: "mouth" },
      { id: "argument-relation", url: "relationCoding", valueCoding: relation },
      { url: "argumentCoding", valueCoding: coding }, { id: "second-argument-code", url: "argumentCoding", valueCoding: coding },
      { id: "argument-start", url: "spanStart", valueInteger: 6, _valueInteger: { id: "start-note" } },
      { id: "argument-end", url: "spanEnd", valueInteger: 11 },
    ] };
    const action: FhirExtension = { url: "action", extension: [
      { url: "force", valueCode: AdviceForce.Instruction }, { url: "predicateLemma", valueString: "rinse" },
      { url: "sourceText", valueString: "Rinse mouth" },
      { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 11 },
      { id: "action-relation", url: "relationCoding", valueCoding: relation },
      { url: "predicateCoding", valueCoding: coding }, { id: "second-predicate-code", url: "predicateCoding", valueCoding: coding }, argument,
    ] };
    const marker: FhirExtension = { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL,
      extension: [{ url: "sourceText", valueString: "Rinse mouth" }, action] };
    const before = copy(marker), graph = parseInstructionGraphExtension([marker])!;
    expect(graph.actions).toHaveLength(1);
    expect(graph.actions[0].args[0].span).toEqual({ start: 6, end: 11 });
    const output = buildInstructionGraphExtension(graph)!;
    const current = output.extension!.find(field => field.url === "action")!.extension!;
    const currentArgument = current.find(field => field.url === "argument")!.extension!;
    for (const [fields, relationId, codingName, codingId] of [
      [current, "action-relation", "predicateCoding", "second-predicate-code"],
      [currentArgument, "argument-relation", "argumentCoding", "second-argument-code"],
    ] as const) {
      const relations = fields.filter(field => field.url === "relationCoding");
      expect(relations).toHaveLength(1);
      expect(relations[0]).toEqual({ id: relationId, url: "relationCoding", valueCoding: relation });
      const codes = fields.filter(field => field.url === codingName);
      expect(codes).toHaveLength(2);
      expect(codes[0]).toEqual({ url: codingName, valueCoding: coding });
      expect(codes[1]).toEqual({ id: codingId, url: codingName, valueCoding: coding });
    }
    for (const field of argument.extension!.filter(field => field.url === "spanStart" || field.url === "spanEnd"))
      expect(currentArgument).toContainEqual(field);
    expect(marker).toEqual(before);
  });
});



describe("current instruction occurrence projection stability", () => {
  const prefix = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 7 days. ";
  const leftHold = "Skip the drops in the left eye on Mondays";
  const rightHold = "Skip the drops in the right eye on Fridays";
  const drive = "Do not drive";
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  type CurrentWire = FhirDosage[] | FhirR6DosageInstruction;

  function leftR5(rows: FhirDosage[]): FhirDosage {
    const row = rows.find(item => item.site?.coding?.some(coding => coding.code === "1290031003"));
    expect(row).toBeDefined();
    return row!;
  }

  function leftR6(details: FhirR6DosageInstruction): FhirR6Dosage {
    for (const step of details.step ?? []) for (const row of step.component) {
      if (row.site?.concept?.coding?.some(coding => coding.code === "1290031003")) return row;
    }
    throw new Error("Expected the independently dosed left-eye component");
  }

  it.each([
    { warning: "May cause drowsiness", thaiWarning: "อาจทำให้ง่วงซึม" },
    { warning: "Do not drive", thaiWarning: "ห้ามDrive" },
  ])("keeps $warning between independent holds without inventing a temporal sequence", ({ warning, thaiWarning }) => {
    const parsed = parsePublicSig(`${prefix}${leftHold}. ${warning}. ${rightHold}.`);
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      const before = fresh(input);
      for (const locale of ["en", "th"] as const) {
        const output = formatSig(input, "long", { locale, realizationMode: "normalized" }).toLowerCase();
        const left = "the drops in the left eye on monday";
        const middle = (locale === "en" ? warning : thaiWarning).toLowerCase();
        const right = "the drops in the right eye on friday";
        for (const phrase of [left, middle, right]) expect(output.split(phrase)).toHaveLength(2);
        expect(output.indexOf(left)).toBeLessThan(output.indexOf(middle));
        expect(output.indexOf(middle)).toBeLessThan(output.indexOf(right));
        expect(output).not.toMatch(/\bthen\b|จากนั้น/u);
      }
      expect(input).toEqual(before);
    }
  });

  for (const form of ["r5", "r6"] as const) {
    it.each(["element", "display", "userSelected", "i18n"] as const)(`keeps Coding %s annotations separate from clinical instruction identity in fresh ${form}`, variant => {
      const parsed = parsePublicSig("Take 1 tablet daily. Do not drive.");
      let wire: CurrentWire = fresh(form === "r5" ? parsed.fhir : parsed.fhirNext);
      const row = Array.isArray(wire) ? wire[0] : wire.step![0].component[0];
      const baseline = ["en", "th"].map(locale => formatSig(wire, "long", { locale, realizationMode: "normalized" }));
      const baselineProjection = projectCanonicalCourse(importCanonicalCourse(wire));
      const originalRows = [baselineProjection.fhir[0], baselineProjection.fhirNext.step![0].component[0]];
      expect(baseline[0]).toBe("Take 1 tablet orally once daily. Do not drive.");
      expect(row.additionalInstruction).toHaveLength(1);
      const marker = row.additionalInstruction![0].extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
      const action = marker.extension!.find(item => item.url === "action")!;
      const coding = action.extension!.find(item => item.url === "predicateCoding")!.valueCoding!;
      expect(coding.code).toBeDefined();
      const note = { url: "urn:clinic:instruction-code-note", valueString: "retain without changing the instruction" };
      if (variant === "element") {
        coding.id = "authored-driving-code";
        coding._code = { ...coding._code, id: "authored-driving-code-value", extension: [...(coding._code?.extension ?? []), note] };
        coding.extension = [...(coding.extension ?? []), note];
      } else if (variant === "display") coding.display = "Driving warning selected by clinician";
      else if (variant === "userSelected") coding.userSelected = !coding.userSelected;
      else coding.i18n = { ...coding.i18n, en: "Driving warning", th: "คำเตือนเรื่องการขับรถ" };
      const annotatedCoding = fresh(coding);

      for (let cycle = 0; cycle < 3; cycle++) {
        const before = fresh(wire);
        for (const [index, locale] of ["en", "th"].entries())
          expect(formatSig(wire, "long", { locale, realizationMode: "normalized" })).toBe(baseline[index]);
        const projected = projectCanonicalCourse(importCanonicalCourse(wire));
        for (const [index, output] of [projected.fhir[0], projected.fhirNext.step![0].component[0]].entries()) {
          const original = originalRows[index];
          expect(output.additionalInstruction).toHaveLength(1);
          const retained = output.additionalInstruction![0].extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
          const current = retained.extension!.find(item => item.url === "action")!;
          expect(current.extension!.find(item => item.url === "predicateCoding")!.valueCoding).toEqual(annotatedCoding);
          expect(parseInstructionGraphExtension(output.extension)!.sourceText)
            .toBe("Take 1 tablet daily. Do not drive.");
          expect(output.patientInstruction).toBe(original.patientInstruction);
          expect(output.doseAndRate).toEqual(original.doseAndRate);
          expect(output.timing?.repeat).toEqual(original.timing?.repeat);
        }
        expect(wire).toEqual(before);
        wire = fresh(form === "r5" ? projected.fhir : projected.fhirNext);
      }
    });


    it.each(["code", "system", "version"] as const)(`keeps distinct selected Coding %s facts in fresh ${form}`, field => {
      const parsed = parsePublicSig("Take 1 tablet daily. Do not drive.");
      const wire: CurrentWire = fresh(form === "r5" ? parsed.fhir : parsed.fhirNext);
      const row = Array.isArray(wire) ? wire[0] : wire.step![0].component[0];
      const marker = row.additionalInstruction![0].extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
      const selected = marker.extension!.find(item => item.url === "action")!.extension!
        .find(item => item.url === "predicateCoding")!.valueCoding!;
      const graphMarker = row.extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
      const graphCoding = graphMarker.extension!.find(item => item.url === "action")!.extension!
        .find(item => item.url === "predicateCoding")!.valueCoding!;
      if (field === "version") graphCoding.version = "20260101";
      const originalCoding = fresh(graphCoding);
      selected[field] = field === "code" ? "clinic-driving-prohibition"
        : field === "system" ? "urn:clinic:instruction-codes" : "20261101";
      const selectedCoding = fresh(selected), before = fresh(wire);
      expect(formatSig(wire, "long", { locale: "en", realizationMode: "normalized" }).match(/do not drive/giu)).toHaveLength(2);
      const projected = projectCanonicalCourse(importCanonicalCourse(wire));
      for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
        expect(output.additionalInstruction).toHaveLength(2);
        const codings = output.additionalInstruction!.flatMap(instruction =>
          parseInstructionGraphExtension(instruction.extension)?.actions[0].predicate.codings ?? []);
        expect(codings).toContainEqual(selectedCoding);
        expect(codings).toContainEqual(originalCoding);
        expect(output.doseAndRate).toEqual(row.doseAndRate);
        expect(output.timing?.repeat).toEqual(row.timing?.repeat);
        expect(parseInstructionGraphExtension(output.extension)!.sourceText)
          .toBe("Take 1 tablet daily. Do not drive.");
      }
      expect(wire).toEqual(before);
    });
  }

  for (const form of ["r5", "r6"] as const) {
    it.each([
      { name: "ordinary negative warning", instructions: [leftHold, rightHold, drive] },
      { name: "negative warning and independent opaque advice", instructions: [leftHold, rightHold, drive, "Arrange a ride home"] },
    ])(`keeps $name rows stable through repeated current ${form} projections`, ({ instructions }) => {
      const patientInstruction = instructions.join(". ");
      const source = `${prefix}${patientInstruction}.`;
      const parsed = parsePublicSig(source);
      const parsedBefore = fresh(parsed);
      let wire: CurrentWire = fresh(form === "r5" ? parsed.fhir : parsed.fhirNext);
      const original = form === "r5" ? leftR5(parsed.fhir) : leftR6(parsed.fhirNext);
      expect(original.additionalInstruction?.map(row => row.text)).toEqual(instructions);
      expect(original.patientInstruction).toBe(patientInstruction);

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const before = fresh(wire);
        const output = projectCanonicalCourse(importCanonicalCourse(wire));
        expect(wire).toEqual(before);
        for (const row of [leftR5(output.fhir), leftR6(output.fhirNext)]) {
          expect.soft(row.additionalInstruction?.map(instruction => instruction.text)).toEqual(instructions);
          expect.soft(row.additionalInstruction?.filter(instruction => instruction.text === drive)).toHaveLength(1);
          expect(row.patientInstruction).toBe(patientInstruction);
          expect(row._patientInstruction).toEqual(original._patientInstruction);
          expect(row.text).toBe(original.text);
        }
        wire = fresh(form === "r5" ? output.fhir : output.fhirNext);
      }
      expect(parsed).toEqual(parsedBefore);
    });

    it(`keeps identical authored holds and their own annotations separate through current ${form} projections`, () => {
      const instructions = [leftHold, leftHold, drive];
      const patientInstruction = instructions.join(". ");
      const parsed = parsePublicSig(`${prefix}${patientInstruction}.`);
      const parsedBefore = fresh(parsed);
      let wire: CurrentWire = fresh(form === "r5" ? parsed.fhir : parsed.fhirNext);
      const left = Array.isArray(wire) ? leftR5(wire) : leftR6(wire);
      expect(left.additionalInstruction?.map(row => row.text)).toEqual(instructions);
      const occurrences = left.additionalInstruction!.slice(0, 2).map(row => {
        const frame = parseInstructionGraphExtension(row.extension)?.actions[0];
        expect(frame).toBeDefined();
        return { sequenceIndex: frame!.sequenceIndex, span: frame!.span };
      });
      expect(occurrences.map(frame => frame.sequenceIndex)).toEqual([0, 1]);
      expect(occurrences[0].span).not.toEqual(occurrences[1].span);

      // This is fresh current wire input: only the first occurrence owns these
      // annotations. Equal wording must not copy them onto the second hold.
      const rowNote = { url: "urn:clinic:first-hold-note", valueString: "first authored occurrence" };
      const textElement = { id: "first-hold-text", extension: [rowNote] };
      const patientElement = { id: "current-patient-instruction", extension: [
        { url: "urn:clinic:patient-note", valueString: "retain the complete current passage" },
      ] };
      left.additionalInstruction![0].id = "first-authored-hold";
      left.additionalInstruction![0]._text = textElement;
      left.additionalInstruction![0].extension = [...(left.additionalInstruction![0].extension ?? []), rowNote];
      left._patientInstruction = patientElement;

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const before = fresh(wire);
        const output = projectCanonicalCourse(importCanonicalCourse(wire));
        expect(wire).toEqual(before);
        for (const row of [leftR5(output.fhir), leftR6(output.fhirNext)]) {
          expect.soft(row.additionalInstruction?.map(instruction => instruction.text)).toEqual(instructions);
          expect(row.patientInstruction).toBe(patientInstruction);
          expect(row._patientInstruction).toEqual(patientElement);
          expect(row.additionalInstruction!.slice(0, 2).map(instruction => {
            const frame = parseInstructionGraphExtension(instruction.extension)?.actions[0];
            return { sequenceIndex: frame?.sequenceIndex, span: frame?.span };
          })).toEqual(occurrences);
          const [first, second] = row.additionalInstruction!;
          expect(first.id).toBe("first-authored-hold");
          expect(first._text).toEqual(textElement);
          expect(first.extension).toContainEqual(rowNote);
          expect(second.id).toBeUndefined();
          expect(second._text).toBeUndefined();
          expect(second.extension).not.toContainEqual(rowNote);
        }
        wire = fresh(form === "r5" ? output.fhir : output.fhirNext);
      }
      expect(parsed).toEqual(parsedBefore);
    });
  }
});




{

const parseSig = parsePublicSig;


const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });
const expression = (name: string) => ({ language: "text/fhirpath", expression: "%" + name });
const course = (component: Partial<FhirR6Dosage> = {}): FhirR6DosageInstruction => ({
  step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], ...component }] }],
});
const r6Save = (value: FhirR6DosageInstruction): FhirR6DosageInstruction => {
  return projectCanonicalCourse(importCanonicalCourse(persist(value))).fhirNext;
};



describe("round48 interop value ownership and primitive annotations", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });

  it.each([{ phase: 2, cycles: 3 }, { phase: 3, cycles: 4 }])(
    "keeps independently supplied phase $phase and course $cycles counts on legacy rows", ({ phase, cycles }) => {
      // Actual master 7d62823 wire fixture: its unmarked old count still uses
      // the established migration policy until the caller supplies both scopes.
      const rows: FhirDosage[] = [{
        timing: { repeat: { frequency: 1, boundsDuration: { value: 7, unit: "days", system: "http://unitsofmeasure.org", code: "d" }, period: 1, periodUnit: FhirPeriodUnit.Day } },
        text: "Use 1 tablet once daily for 7 days.", sequence: 1,
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" } }],
        modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [
          { url: "rowIndex", valueInteger: 0 }, { url: "sequence", valueInteger: 1 }, { url: "stepCount", valueInteger: 1 },
          { url: "step", extension: [{ url: "count", valueInteger: 3 }] },
          { url: "context", valueString: "72f2f03d1f8289c5" }, { url: "contextRequired", valueBoolean: true },
          { url: "course", extension: [{ url: "repeatCycle", valueQuantity: { value: 14, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }] },
        ] }], extension: [{ url: DOSAGE_RENDERED_INSTRUCTION_R5_URL, extension: [
          { url: "instruction", valueString: "1 tablet daily for 7 days then stop for 7 days, repeat for 3 cycles" },
          { url: "row", extension: [{ url: "projectionFingerprint", valueString: "4346df4e5678f52b" }, { url: "textFingerprint", valueString: "dab22a241c7d0f4f" }] },
        ] }],
      }];
      const edits = { modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: cycles }],
        step: [{ sequence: 1, count: phase }] };
      const before = persist({ rows, edits });
      let wire = toDosageDetails(rows, undefined, edits);
      expect({ rows, edits }).toEqual(before);
      for (let save = 0; save < 3; save++) {
        expect(getCourseCycleCount(wire)).toBe(cycles);
        expect(wire.step![0].count).toBe(phase);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    }
  );

  it.each(["unchanged", "annotation", "row-text", "course-text", "copied-companion", "replacement"] as const)(
    "keeps only currently owned zero-step translations after a %s edit", edit => {
      const translation = (value: number): FhirExtension => ({
        url: "http://hl7.org/fhir/StructureDefinition/translation",
        extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทาน " + value + " เม็ด ทุกวัน" }],
      });
      const author = { url: "urn:test:author", valueString: "original" };
      const primitive = { id: "english-text", extension: [translation(1), author] };
      const source = { renderedInstruction: "Take 1 tablet daily", _renderedInstruction: primitive };
      const rows = persist(toFhirR5Dosages(source));
      const original = persist(rows[0].modifierExtension!.find(item => item.url === DOSAGE_DETAILS_R5_URL)!);
      const edited = edit === "row-text" || edit === "course-text" || edit === "copied-companion" || edit === "replacement";
      if (edit === "row-text" || edit === "replacement") rows[0].text = "Take 2 tablets daily";
      const edits: (EzCourseMetadata & Pick<FhirR6DosageInstruction, "_renderedInstruction">) | undefined =
        edit === "course-text" ? { renderedInstruction: "Take 2 tablets daily" }
        : edit === "copied-companion" ? { renderedInstruction: "Take 2 tablets daily", _renderedInstruction: persist(primitive) }
        : edit === "replacement" ? { _renderedInstruction: { id: "replacement-text", extension: [translation(2), author] } }
        : edit === "annotation" ? { extension: [{ url: "urn:test:course-note", valueString: "unchanged wording" }] }
        : undefined;
      const before = persist({ rows, edits, source });
      let wire = toDosageDetails(rows, undefined, edits);
      expect(persist({ rows, edits, source })).toEqual(before);
      for (let save = 0; save < 3; save++) {
        expect(wire.renderedInstruction).toBe(edited ? "Take 2 tablets daily" : source.renderedInstruction);
        expect(wire._renderedInstruction).toEqual(edit === "replacement" ? edits!._renderedInstruction
          : edited ? { id: primitive.id, extension: [author] } : primitive);
        if (edited) expect(wire.extension?.some(item =>
          item.url === DOSAGE_RECONCILIATION_SOURCE_URL && item.extension?.some(child =>
            JSON.stringify(child) === JSON.stringify(original)))).toBe(true);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    }
  );

  it.each(["_frequency", "_frequencyMax", "_period", "_periodMax", "_periodUnit",
    "_countMax", "_duration", "_durationMax", "_durationUnit", "_dayOfWeek", "_when", "_offset"] as const)(
    "keeps the editable pause after a %s annotation-only edit", field => {
      const repeat = { ...daily, frequencyMax: 1, periodMax: 1, count: 7, countMax: 7,
        duration: 1, durationMax: 1, durationUnit: FhirPeriodUnit.Hour };
      let wire = r6Save({ step: [
        { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat } }] },
        { id: "pause", end: boundary(14), component: [] },
        { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
      ] });
      const annotation = field === "_dayOfWeek" || field === "_when"
        ? [{ id: "cadence-annotation", extension: [{ url: "urn:test:note", valueString: "retain" }] }]
        : { id: "cadence-annotation", extension: [{ url: "urn:test:note", valueString: "retain" }] };
      (wire.step![0].component[0].timing!.repeat! as unknown as Record<string, unknown>)[field] = annotation;
      for (let save = 0; save < 3; save++) {
        const before = persist(wire), view = fromDosageDetails(wire);
        expect(view.course.step?.map(step => step.id)).toEqual(["induction", "pause", "resume"]);
        expect(wire).toEqual(before);
        const current = wire.step![0].component[0].timing!.repeat!;
        if (field === "_when") {
          const { timeOfDay, ...recurrence } = repeat;
          expect(current).toMatchObject(recurrence);
          expect(getTimingClocks(current)).toEqual(timeOfDay);
          if (save > 0) expect(current.timeOfDay).toBeUndefined();
        } else expect(current).toMatchObject(repeat);
        expect((current as unknown as Record<string, unknown>)[field]).toEqual(annotation);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    }
  );

  it.each(["frequency", "period", "semantic-extension", "unknown-companion"] as const)(
    "still retires the old pause on a %s completion edit", edit => {
      const wire = r6Save({ step: [
        { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
          timing: { repeat: { ...daily, count: 7 } } }] },
        { id: "pause", end: boundary(14), component: [] },
        { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
      ] });
      const repeat = wire.step![0].component[0].timing!.repeat!;
      if (edit === "frequency" || edit === "period") repeat[edit] = 2;
      else if (edit === "semantic-extension") repeat.extension = [{ url: "urn:clinic:cadence-policy", valueString: "current" }];
      else (repeat as unknown as Record<string, unknown>)._clinicCadence = { id: "unfamiliar" };
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.step?.map(step => step.id)).toEqual(["induction", "resume"]);
      expect(wire).toEqual(before);
    }
  );

  it.each([8, 9])("keeps metadata-only cycle-day children apart from numerical day %s", day => {
    const marker = { id: "cycle", url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
      { id: "metadata-only", url: "day", extension: [{ url: "urn:test:empty-day-note", valueString: "retained" }] },
      { id: "eighth-day", url: "day", valueInteger: day, _valueInteger: { id: "eight-value" } },
    ] };
    const rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, modifierExtension: [marker] }];
    const before = persist(rows);
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      const saved = persist(toFhirR5Dosages(wire));
      expect(saved[0].modifierExtension?.find(item => item.url === CYCLE_DAY_ELIGIBILITY_EXTENSION_URL)).toEqual(marker);
      wire = toDosageDetails(saved);
    }
    expect(rows).toEqual(before);
  });

  it("accepts and preserves Reference.identifier primitive companions in the public types", () => {
    const source = course({ site: { reference: {
      reference: "BodyStructure/site", identifier: {
        use: "official", _use: { id: "identifier-use" },
        system: "https://clinic.example/sites", _system: { id: "identifier-system" },
        value: "left-arm", _value: { id: "identifier-value", extension: [{ url: "urn:test:source", valueString: "authored" }] },
      },
    } } });
    const before = persist(source);
    let wire = source;
    for (let save = 0; save < 3; save++) {
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(wire.step![0].component[0].site).toEqual(source.step![0].component[0].site);
    }
    expect(source).toEqual(before);
  });
});


describe("round48 source agreement default ownership", () => {
  it.each([true, false])("stores only row overrides of the %s containing default", agreement => {
    const rows: FhirDosage[] = [
      { text: "Take one tablet daily", doseAndRate: [{ doseQuantity: q(1) }] },
      { text: "Take two tablets daily", doseAndRate: [{ doseQuantity: q(2) }] },
    ];
    const before = persist(rows);
    const output = withDosageEditProvenance(rows, "Two independent directions", agreement,
      [{ sourceAgreement: agreement }, { sourceAgreement: !agreement }]);
    const marker = output[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!;
    const baseline = marker.extension!.filter(item => item.url === "row");
    expect(marker.extension).toContainEqual({ url: "sourceAgreement", valueBoolean: agreement });
    expect(baseline[0].extension?.some(item => item.url === "sourceAgreement")).toBe(false);
    expect(baseline[1].extension).toContainEqual({ url: "sourceAgreement", valueBoolean: !agreement });
    expect(output.map(row => getDosageSourceTextAgreement(row))).toEqual([agreement, !agreement]);
    // Older generated rows redundantly repeated this same default. The public
    // importer reads either representation as the exact same course.
    const verbose = persist(output);
    verbose[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!
      .extension!.find(item => item.url === "row")!.extension!
      .push({ url: "sourceAgreement", valueBoolean: agreement });
    expect(toDosageDetails(persist(output))).toEqual(toDosageDetails(verbose));
    const edited = persist(output);
    const stale = agreement ? 1 : 0;
    edited[stale].text = "Current explicit replacement instruction";
    expect(getDosageSourceTextAgreement(edited[stale])).toBe(true);
    expect(getDosageSourceTextAgreement(edited[stale], false)).toBe(false);
    expect(rows).toEqual(before);
  });

  it("retains an annotated prior equal flag as exact source when writing the compact default", () => {
    const rows = withDosageEditProvenance<FhirDosage>([
      { text: "Take one tablet daily", doseAndRate: [{ doseQuantity: q(1) }] },
    ], "Take one tablet daily", false);
    const original = rows[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!;
    const annotated = { id: "external-agreement", url: "sourceAgreement", valueBoolean: false,
      _valueBoolean: { id: "external-primitive", extension: [{ url: "urn:clinic:agreement-note", valueString: "keep exact" }] } };
    original.extension!.find(item => item.url === "row")!.extension!.push(annotated);
    original.extension!.push({ url: "urn:clinic:foreign-baseline", valueString: "keep exact too" });
    const before = persist(rows), source = persist(original);
    const output = withDosageEditProvenance(rows, "Take one tablet daily", false);
    const marker = output[0].extension!.find(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!;
    expect(marker.extension!.find(item => item.url === "row")!.extension!
      .some(item => item.url === "sourceAgreement")).toBe(false);
    expect(output[0].extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [source] });
    expect(getDosageSourceTextAgreement(output[0])).toBe(false);
    expect(rows).toEqual(before);
    const reopened = toDosageDetails(persist(output));
    expect(reopened.step![0].component[0].extension)
      .toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [source] });
  });
});


describe("round49 current interop ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 5 };

  it.each(["unchanged", "dose", "delete", "replace"] as const)(
    "keeps the live modifier list authoritative beside a historical full component (%s)", edit => {
      const policy: FhirExtension & { _valueString: FhirElement } = {
        id: "old-policy", url: "urn:clinic:member-policy", valueString: "current policy",
        _valueString: { extension: [{ url: "urn:clinic:opaque", valueString: "preserve policy annotation" }] } };
      const dates: FhirExtension = { id: "old-dates", url: DOSAGE_EXCLUDED_DATES_R5_URL, extension: [
        { id: "excluded-date", url: "date", valueDate: "2026-01-02" },
      ] };
      const site = { concept: { text: "left eye" }, reference: {
        reference: "BodyStructure/left-eye", identifier: { system: "urn:clinic:eye", value: "left" },
      } };
      const old: FhirR6Dosage = { id: "identified-dose", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: daily }, site, modifierExtension: [policy, dates] };
      const marker: FhirExtension = { id: "historical-full-course", url: DOSAGE_DETAILS_R5_URL, extension: [{
        url: "dosageDetails", extension: [encodeR6SourceMetadata("step", {
          id: "loading", component: [old],
        }, "step")],
      }] };
      const modifiers = edit === "delete" ? [] : edit === "replace"
        ? [{ ...policy, valueString: "replacement policy" }, { ...dates, extension: [{ url: "date", valueDate: "2026-01-03" }] }]
        : [policy, dates];
      const annotation = { id: "live-row-note", url: "urn:clinic:row-note", valueString: "current external annotation" };
      let rows: FhirDosage[] = persist([{ id: old.id, sequence: 1, site: site.concept,
        doseAndRate: [{ doseQuantity: q(edit === "dose" ? 2 : 1) }], timing: { repeat: daily },
        ...(edit === "unchanged" ? {} : { extension: [annotation] }), modifierExtension: [marker, ...modifiers] }]);
      for (let save = 0; save < 3; save++) {
        const before = persist(rows), wire = toDosageDetails(rows), member = wire.step![0].component[0];
        expect(member.modifierExtension ?? []).toEqual(modifiers);
        expect(member.doseAndRate).toEqual([{ doseQuantity: q(edit === "dose" ? 2 : 1) }]);
        expect(member.site).toEqual(site);
        expect(getDosageExcludedDates({ modifierExtension: member.modifierExtension })).toEqual(
          edit === "delete" ? [] : [edit === "replace" ? "2026-01-03" : "2026-01-02"]);
        if (edit !== "unchanged") {
          expect(member.extension).toContainEqual(annotation);
          expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
            item.extension?.some(source => JSON.stringify(source) === JSON.stringify(marker)))).toBe(true);
        }
        expect(rows).toEqual(before);
        rows = persist(toFhirR5Dosages(wire));
      }
    }
  );

  it.each(["unchanged", "dose", "dates", "weekdays", "date-annotation", "weekday-annotation", "date-order", "weekday-order"] as const)(
    "keeps completion ownership after an administration exclusion %s edit", edit => {
      const dates: FhirExtension = { id: "original-dates", url: DOSAGE_EXCLUDED_DATES_R5_URL, extension: [
        { id: "original-date", url: "date", valueDate: "2026-01-03" },
        { url: "urn:clinic:exclusion-note", valueString: "preserve date metadata" },
      ] };
      const weekdays: FhirExtension = { id: "original-weekdays", url: DOSAGE_EXCLUDED_WEEKDAYS_R5_URL, extension: [
        { url: "day", valueCode: "sat", _valueCode: { id: "original-weekday" } },
        { url: "urn:clinic:weekday-note", valueString: "preserve weekday metadata" },
      ] };
      if (edit === "date-order") dates.extension!.push({ url: "date", valueDate: "2026-01-06" });
      if (edit === "weekday-order") weekdays.extension!.push({ url: "day", valueCode: "sun" });
      let wire = toDosageDetails([
        { sequence: 1, id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
          timing: { repeat: { ...daily, count: 2 } }, modifierExtension: [dates], extension: [weekdays] },
        { sequence: 3, id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, count: 2 } } },
      ], undefined, { step: [
        { sequence: 1, id: "induction" },
        { sequence: 2, id: "pause", end: boundary(3),
          extension: [{ id: "pause-note", url: "urn:clinic:pause-note", valueString: "original pause" }] },
        { sequence: 3, id: "resume" },
      ] });
      const draft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const liveStart = persist(wire.step![1].start), member = wire.step![0].component[0];
      if (edit === "dose") member.doseAndRate![0].doseQuantity!.value = 3;
      if (edit === "dates") setDosageExcludedDates(member as FhirDosage, ["2026-01-02", "2026-01-03"]);
      if (edit === "weekdays") setDosageExcludedWeekdays(member as FhirDosage, [FhirDayOfWeek.Friday, FhirDayOfWeek.Saturday]);
      if (edit === "date-annotation") member.modifierExtension!.find(item => item.url === DOSAGE_EXCLUDED_DATES_R5_URL)!.extension![0].id = "current-date-note";
      if (edit === "weekday-annotation") member.extension!.find(item => item.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL)!.extension![0]._valueCode = { id: "current-weekday-note" };
      if (edit === "date-order") member.modifierExtension!.find(item => item.url === DOSAGE_EXCLUDED_DATES_R5_URL)!.extension!.reverse();
      if (edit === "weekday-order") member.extension!.find(item => item.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL)!.extension!.reverse();
      const completionChanged = edit === "dates" || edit === "weekdays";
      for (let save = 0; save < 3; save++) {
        const before = persist(wire), view = fromDosageDetails(wire);
        expect(view.course.step?.map(step => step.id)).toEqual(
          completionChanged ? ["induction", "resume"] : ["induction", "pause", "resume"]);
        if (!completionChanged) expect(view.course.step?.find(step => step.id === "pause")?.extension)
          .toEqual([{ id: "pause-note", url: "urn:clinic:pause-note", valueString: "original pause" }]);
        expect(wire.step![1].start).toEqual(liveStart);
        expect(nextDueDoses(wire, options)).toEqual(completionChanged ? [
          // The initial 1-tablet dose and resumed 2-tablet dose are two
          // distinct administrations at the preserved January 4 clock.
          "2026-01-01T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
          "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
        ] : [
          "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
          "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ dosage: wire, ...options,
          durationValue: 5, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(edit === "dose" ? 10 : 6);
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(edit === "dose" ? 3 : 1);
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        if (completionChanged) expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          item.extension?.some(source => JSON.stringify(source) === JSON.stringify(draft)))).toBe(true);
        expect(JSON.stringify(wire)).toContain("preserve date metadata");
        expect(JSON.stringify(wire)).toContain("preserve weekday metadata");
        if (edit === "date-annotation") expect(wire.step![0].component[0].modifierExtension!
          .find(item => item.url === DOSAGE_EXCLUDED_DATES_R5_URL)!.extension![0].id).toBe("current-date-note");
        if (edit === "weekday-annotation") expect(wire.step![0].component[0].extension!
          .find(item => item.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL)!.extension![0]._valueCode).toEqual({ id: "current-weekday-note" });
      }
    }
  );

  it.each(["distinct-scopes", "distinct-amounts", "amount-edit", "duplicate-values"] as const)(
    "retains only uniquely unchanged anonymous phase limits (%s)", kind => {
      const first: FhirR6DoseLimit = { scope: "administration", valueQuantity: q(2), text: "phase cap" };
      const second: FhirR6DoseLimit = kind === "distinct-scopes"
        ? { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "daily cap" }
        : { ...first, valueQuantity: q(kind === "duplicate-values" ? 2 : 4) };
      let wire = toDosageDetails([{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }],
        undefined, { step: [{ sequence: 1, id: "loading", safety: { doseLimit: [first, second] } }] });
      wire.step!.push({ id: "maintenance", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: daily } }] });
      const annotation = { id: "limit-note", url: "urn:clinic:limit-note", valueString: "current annotation" };
      wire.safety!.doseLimit![0].extension = [annotation];
      wire.safety!.doseLimit![0].valueQuantity!._value = { id: "current-quantity-note" };
      if (kind === "amount-edit") wire.safety!.doseLimit![0].valueQuantity!.value = 3;
      const current = persist(wire.safety!.doseLimit![0]);
      for (let save = 0; save < 3; save++) {
        const before = persist(wire);
        const output = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(output.step![1].safety).toBeUndefined();
        expect(output.step![0].safety?.doseLimit ?? []).toEqual(
          kind === "duplicate-values" ? [] : kind === "amount-edit" ? [second] : [current, second]);
        expect(output.safety?.doseLimit ?? []).toEqual(
          kind === "duplicate-values" ? [current, second] : kind === "amount-edit" ? [current] : []);
        expect(JSON.stringify(output)).toContain("current annotation");
        expect(JSON.stringify(output)).toContain("current-quantity-note");
        expect(wire).toEqual(before);
        wire = output;
      }
    }
  );
});


describe("round50 explicit interchange scope and primitive ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const afterDays = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 6 };
  // Actual pinned-master writer output, including its unversioned count scope.
  const legacyRows: FhirDosage[] = [{"timing": {"repeat": {"frequency": 1, "boundsDuration": {"value": 7, "unit": "days", "system": "http://unitsofmeasure.org", "code": "d"}, "period": 1, "periodUnit": FhirPeriodUnit.Day}}, "text": "Use 1 tablet once daily for 7 days.", "sequence": 1, "doseAndRate": [{"doseQuantity": {"value": 1, "unit": "tab", "system": "http://standardterms.edqm.eu", "code": "15054000"}}], "modifierExtension": [{"url": "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details", "extension": [{"url": "rowIndex", "valueInteger": 0}, {"url": "sequence", "valueInteger": 1}, {"url": "stepCount", "valueInteger": 1}, {"url": "step", "extension": [{"url": "count", "valueInteger": 3}]}, {"url": "context", "valueString": "aacf252a6b0e6e74"}, {"url": "contextRequired", "valueBoolean": true}, {"url": "course", "extension": [{"url": "repeatCycle", "valueQuantity": {"value": 28, "unit": "d", "code": "d", "system": "http://unitsofmeasure.org"}}]}]}], "extension": [{"url": "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction", "extension": [{"url": "instruction", "valueString": "1 tablet daily for 7 days then stop for 21 days, repeat for 3 cycles"}, {"url": "row", "extension": [{"url": "projectionFingerprint", "valueString": "975c16dd2e988203"}, {"url": "textFingerprint", "valueString": "dab22a241c7d0f4f"}]}]}]}];

  it.each([2, 3])("keeps phase count %s when the same public edit clears legacy course modifiers", phase => {
    const rows = persist(legacyRows), edits = { modifierExtension: [], step: [{ sequence: 1, count: phase }] };
    const before = persist({ rows, edits });
    let wire = toDosageDetails(rows, undefined, edits);
    expect({ rows, edits }).toEqual(before);
    for (let save = 0; save < 3; save++) {
      expect(getCourseCycleCount(wire)).toBeUndefined();
      expect(wire.step![0].count).toBe(phase);
      expect(nextDueDoses(wire, { ...options, limit: phase * 7 + 2 })).toEqual([
        ...Array.from({ length: phase * 7 }, (_, index) => "2026-01-" + ("0" + (index + 1)).slice(-2) + "T09:00:00+00:00"),
        "2026-01-29T09:00:00+00:00", "2026-01-30T09:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 28, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: phase * 7, unit: "tab" });
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each(["omitted", "unrelated"] as const)("retains established legacy count migration for %s course metadata", edit => {
    const policy = { url: "urn:clinic:course-policy", valueString: "preserve policy" };
    const edits = { ...(edit === "unrelated" ? { modifierExtension: [policy] } : {}),
      step: [{ sequence: 1, count: 2 }] };
    let wire = toDosageDetails(persist(legacyRows), undefined, edits);
    for (let save = 0; save < 3; save++) {
      expect(getCourseCycleCount(wire)).toBe(2);
      expect(wire.step![0].count).toBeUndefined();
      if (edit === "unrelated") expect(wire.modifierExtension).toContainEqual(policy);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  function inductionPause(withDelay = false): FhirR6DosageInstruction {
    return toDosageDetails([
      { sequence: 1, id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } },
        ...(withDelay ? { modifierExtension: [{ id: "delay-policy", url: ADMINISTRATION_OFFSET_EXTENSION_URL,
          valueQuantity: { value: 0, unit: "min", code: "min",
            extension: [{ url: "urn:clinic:delay-note", valueString: "original delay annotation" }] } }] } : {}) },
      { sequence: 3, id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "induction" },
      { sequence: 2, id: "pause", end: afterDays(2),
        extension: [{ id: "pause-note", url: "urn:clinic:pause-note", valueString: "original pause" }] },
      { sequence: 3, id: "resume" },
    ] });
  }

  it.each(["unchanged", "delay", "dose", "delay-annotation", "zero-delay"] as const)(
    "keeps dependent pause ownership after a public administration %s edit", edit => {
      let wire = inductionPause(edit === "delay-annotation");
      const originalDraft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const liveStart = persist(wire.step![1].start), member = wire.step![0].component[0];
      if (edit === "delay" || edit === "zero-delay") member.modifierExtension = [{
        id: "delay-policy", url: ADMINISTRATION_OFFSET_EXTENSION_URL,
        valueQuantity: { value: edit === "delay" ? 2880 : 0, unit: "min", code: "min",
          extension: [{ url: "urn:clinic:delay-note", valueString: "current delay annotation" }] },
      }];
      if (edit === "dose") member.doseAndRate![0].doseQuantity!.value = 3;
      if (edit === "delay-annotation") member.modifierExtension![0].valueQuantity!.id = "current-delay-note";
      for (let save = 0; save < 3; save++) {
        const before = persist(wire), view = fromDosageDetails(wire);
        expect(view.course.step?.map(step => step.id)).toEqual(edit === "delay"
          ? ["induction", "resume"] : ["induction", "pause", "resume"]);
        expect(wire.step![1].start).toEqual(liveStart);
        expect(nextDueDoses(wire, options)).toEqual(edit === "delay" ? [
          "2026-01-03T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
        ] : ["2026-01-01T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: edit === "dose" ? 7 : 5, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        if (edit === "delay") expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          item.extension?.some(source => JSON.stringify(source) === JSON.stringify(originalDraft)))).toBe(true);
        expect(JSON.stringify(wire)).toContain("original pause");
      }
    });

  it.each([false, true])("keeps a saved trailing draft from acquiring an appended receiver (%s)", appended => {
    let wire = toDosageDetails([
      { sequence: 1, id: "initial", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
    ], undefined, { step: [
      { sequence: 1, id: "induction", end: afterDays(1) },
      { sequence: 2, id: "trailing-draft", end: afterDays(3),
        extension: [{ url: "urn:clinic:draft-note", valueString: "saved trailing draft" }] },
    ] });
    if (appended) wire.step!.push({ id: "maintenance", start: { contextCode: { coding: [{
      system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "previous-phase-next-day",
    }] } }, component: [{ id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(2) }],
      timing: { repeat: { ...daily, count: 2 } } }] });
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.step?.map(step => step.id)).toEqual(appended
        ? ["induction", "maintenance"] : ["induction", "trailing-draft"]);
      expect(nextDueDoses(wire, options)).toEqual(appended ? [
        "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
      ] : ["2026-01-01T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: appended ? 5 : 1, unit: "tab" });
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(JSON.stringify(wire)).toContain("saved trailing draft");
    }
  });

  it.each(["unchanged", "administration", "administration-delete", "valued-period-edit", "valued-period-delete"] as const)(
    "preserves an independent partial period limit after a %s maximum edit", edit => {
      const valued = edit.startsWith("valued");
      const period: FhirR6DoseLimit = { id: "period-cap", scope: "period",
        valueQuantity: { ...(valued ? { value: 4 } : {}), unit: "tab", _value: { id: "numerator-note" },
          extension: [{ url: "urn:clinic:quantity-note", valueString: "retain partial numerator" }] },
        period: { value: 1, unit: "d" } };
      const rows = persist(toFhirR5Dosages(course({ timing: { repeat: daily }, safety: { doseLimit: [
        period, { scope: "administration", valueQuantity: q(4) },
      ] } })));
      if (edit === "administration") rows[0].maxDosePerAdministration!.value = 3;
      if (edit === "administration-delete") delete rows[0].maxDosePerAdministration;
      if (edit === "valued-period-edit") rows[0].maxDosePerPeriod![0].numerator!.value = 2;
      if (edit === "valued-period-delete") delete rows[0].maxDosePerPeriod;
      const before = persist(rows);
      let wire = toDosageDetails(rows);
      expect(rows).toEqual(before);
      for (let save = 0; save < 3; save++) {
        const limits = wire.step![0].component[0].safety?.doseLimit ?? [];
        expect(limits).toHaveLength(edit === "administration-delete" || edit === "valued-period-delete" ? 1 : 2);
        expect(limits.find(limit => limit.scope === "period")).toEqual(edit === "valued-period-delete" ? undefined :
          { ...period, valueQuantity: { ...period.valueQuantity,
            ...(edit === "valued-period-edit" ? { value: 2 } : {}) } });
        expect(limits.find(limit => limit.scope === "administration")?.valueQuantity).toEqual(
          edit === "administration-delete" ? undefined : q(edit === "administration" ? 3 : 4));
        if (!valued) expect(limits.find(limit => limit.scope === "period")?.valueQuantity?.value).toBeUndefined();
        const saved = persist(toFhirR5Dosages(wire));
        if (!valued) expect(saved[0].maxDosePerPeriod?.[0].numerator).toEqual(period.valueQuantity);
        wire = toDosageDetails(saved);
      }
    });

  it.each(["both", "bridge", "core", "null-core"] as const)("keeps independent core and promoted clock annotations separate (%s)", owner => {
    const core = [{ id: "core-note", extension: [{ url: "urn:clinic:core-note", valueString: "independent core annotation" }] }];
    const bridgeNote = { id: "clock-note", extension: [{ url: "urn:clinic:clock-note", valueString: "authored bridge annotation" }] };
    const bridge: FhirExtension = { id: "clock-carrier", url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
      valueTime: "08:00:00", ...(owner !== "core" ? { _valueTime: bridgeNote } : {}) };
    const rows: FhirDosage[] = [{ id: "clock-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      ...(owner !== "bridge" ? { _timeOfDay: core } : {}),
      ...(owner === "null-core" ? { timeOfDay: [null] } : {}), extension: [bridge],
    } } }];
    const before = persist(rows);
    let wire = toDosageDetails(rows);
    expect(rows).toEqual(before);
    for (let save = 0; save < 3; save++) {
      const repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.timeOfDay).toEqual(["08:00:00"]);
      expect(repeat._timeOfDay).toEqual(owner === "core" ? undefined : [bridgeNote]);
      const source = repeat.extension?.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)
        .reduce<NonNullable<typeof repeat.extension>>((items, item) => items.concat(item.extension ?? []), []) ?? [];
      expect(source).toContainEqual(bridge);
      const originalCore = source.find(item => item.url === "_timeOfDay");
      expect(originalCore ? readRetainedField(originalCore) : undefined).toEqual(owner === "bridge" ? undefined : core);
      expect(nextDueDoses(wire, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      ]);
      const snapshot = persist(wire);
      const saved = toFhirR5Dosages(wire);
      expect(wire).toEqual(snapshot);
      wire = toDosageDetails(persist(saved));
    }
  });
});


describe("round51 retained phase boundaries and primitive positions", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z",
    timeZone: "UTC", limit: 40 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + ("0" + day).slice(-2) + "T09:00:00+00:00");

  it.each(["unchanged", "id", "boundary", "start-only", "annotation"] as const)(
    "retains historical phase fields beneath a partial public %s edit", edit => {
      const originalNote = { id: "stage-note", url: "urn:clinic:phase-note",
        valueString: "preserve historical phase annotation" };
      const originalStep: FhirR6DosageStep = { id: "old-maintenance", start: boundary(7), end: boundary(14),
        extension: [originalNote], component: [{ id: "historical-dose", doseAndRate: [{ doseQuantity: q(2) }],
          timing: { repeat: daily } }] };
      const marker: FhirExtension = { id: "historical-full-course", url: DOSAGE_DETAILS_R5_URL, extension: [{
        url: "dosageDetails", extension: [
          encodeR6SourceMetadata("step", { id: "historical-first", component: [] }, "step"),
          encodeR6SourceMetadata("step", originalStep, "step"),
        ],
      }] };
      const compact = toFhirR5Dosages({ step: [{ id: "loading", end: boundary(7), component: [{
        id: "compact-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      }] }] })[0];
      compact.modifierExtension!.find(item => item.url === DOSAGE_DETAILS_R5_URL)!
        .extension!.find(item => item.url === "stepCount")!.valueInteger = 2;
      const rows: EzDosage[] = JSON.parse(JSON.stringify([compact,
        { ...originalStep.component[0], sequence: 2, modifierExtension: [marker] }]));
      const currentNote = { url: "urn:clinic:edited-note", valueString: "current note" };
      const editing: EzCourseMetadata | undefined = edit === "unchanged" ? undefined : { step: [{
        sequence: 2, ...(edit === "id" ? { id: "maintenance" } :
          edit === "boundary" ? { start: boundary(9), end: boundary(16) } :
          edit === "start-only" ? { start: boundary(9) } : { extension: [currentNote] }),
      }] };
      const before = persist({ rows, editing });
      let wire = toDosageDetails(rows, undefined, editing);
      expect(persist({ rows, editing })).toEqual(before);
      const startDay = edit === "boundary" || edit === "start-only" ? 10 : 8;
      const endDay = edit === "boundary" ? 16 : 14;
      const maintenanceDays = Array.from({ length: endDay - startDay + 1 }, (_, index) => startDay + index);
      for (let save = 0; save < 3; save++) {
        const beforeWire = persist(wire), step = wire.step![1];
        expect(step.id).toBe(edit === "id" ? "maintenance" : "old-maintenance");
        expect(step.start).toEqual(boundary(startDay - 1));
        expect(step.end).toEqual(boundary(endDay));
        expect(step.extension).toEqual(edit === "annotation" ? [currentNote] : [originalNote]);
        expect(step.component[0]).toMatchObject({ id: "historical-dose", doseAndRate: [{ doseQuantity: q(2) }] });
        expect(nextDueDoses(wire, options)).toEqual(dates([1, 2, 3, 4, 5, 6, 7, ...maintenanceDays]));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 20, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: edit === "start-only" ? 17 : 21, unit: "tab" });
        const coldRows = persist(toFhirR5Dosages(wire));
        expect(wire).toEqual(beforeWire);
        wire = toDosageDetails(coldRows);
        expect(JSON.stringify(wire)).toContain("preserve historical phase annotation");
      }
    });

  function dependentPause(extra = false, independentStart = false, fixedEnd = false): FhirR6DosageInstruction {
    const pauseSequence = extra ? 4 : 3;
    return toDosageDetails([
      { sequence: 1, id: "a-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
      { sequence: 2, id: "b-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      ...(extra ? [{ sequence: 3, id: "c-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } }] : []),
      { sequence: pauseSequence + 1, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "phase-a", end: boundary(1) },
      { sequence: 2, id: "phase-b", ...(independentStart ? { start: boundary(2) } : {}),
        ...(fixedEnd ? { end: boundary(3) } : {}) },
      ...(extra ? [{ sequence: 3, id: "phase-c" }] : []),
      { sequence: pauseSequence, id: "pause", end: boundary(extra || independentStart || fixedEnd ? 4 : 3),
        extension: [{ id: "saved-pause-note", url: "urn:clinic:pause-note", valueString: "original pause retained" }] },
      { sequence: pauseSequence + 1, id: "maintenance" },
    ] });
  }

  it.each(["unchanged", "earlier-end", "dose", "annotation", "two-implicit", "independent-start", "fixed-end"] as const)(
    "keeps only independently owned pauses after a transitive %s edit", edit => {
      let wire = persist(dependentPause(edit === "two-implicit", edit === "independent-start", edit === "fixed-end"));
      const originalDraft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const currentStart = persist(wire.step![wire.step!.length - 1].start);
      if (edit === "earlier-end" || edit === "two-implicit" || edit === "independent-start" || edit === "fixed-end")
        wire.step![0].end = boundary(2);
      if (edit === "dose") wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 4;
      if (edit === "annotation") wire.step![0].end!.id = "current-boundary-note";
      const retired = edit === "earlier-end" || edit === "two-implicit";
      const phaseIds = ["phase-a", "phase-b", ...(edit === "two-implicit" ? ["phase-c"] : []),
        ...(!retired ? ["pause"] : []), "maintenance"];
      const expectedDays = edit === "two-implicit" ? [1, 2, 3, 4, 5, 6] :
        edit === "earlier-end" ? [1, 2, 3, 4, 5] :
        edit === "independent-start" || edit === "fixed-end" ? [1, 2, 3, 5, 6] : [1, 2, 4, 5];
      const total = edit === "dose" || edit === "two-implicit" ? 12 :
        edit === "earlier-end" || edit === "independent-start" || edit === "fixed-end" ? 10 : 9;
      for (let save = 0; save < 3; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step?.map(step => step.id)).toEqual(phaseIds);
        expect(wire.step![wire.step!.length - 1].start).toEqual(currentStart);
        expect(nextDueDoses(wire, options)).toEqual(dates(expectedDays));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: total, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("original pause retained");
        expect(JSON.stringify(wire)).toContain("saved-pause-note");
        if (retired) expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          item.extension?.some(source => JSON.stringify(source) === JSON.stringify(originalDraft)))).toBe(true);
      }
    });

  function anchoredPause(): FhirR6DosageInstruction {
    return toDosageDetails([
      { sequence: 1, id: "induction-dose", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsPeriod: { start: "2026-01-01T00:00:00Z" } } },
        modifierExtension: [{ id: "duration-policy", url: ANCHORED_COURSE_DURATION_EXTENSION_URL,
          valueQuantity: { id: "authored-length", value: 1, unit: "d", _unit: { id: "length-unit" },
            extension: [{ url: "urn:clinic:duration-note", valueString: "original duration annotation" }] } }] },
      { sequence: 3, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "induction" },
      { sequence: 2, id: "pause", end: boundary(2),
        extension: [{ url: "urn:clinic:pause-note", valueString: "anchored pause retained" }] },
      { sequence: 3, id: "maintenance" },
    ] });
  }

  it.each(["unchanged", "length", "dose", "marker-annotation", "quantity-annotation"] as const)(
    "compares the effective anchored length after a public %s edit", edit => {
      let wire = persist(anchoredPause());
      const originalDraft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const member = wire.step![0].component[0];
      const length = member.modifierExtension!.find(item => item.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)!;
      if (edit === "length") length.valueQuantity!.value = 2;
      if (edit === "dose") member.doseAndRate![0].doseQuantity!.value = 3;
      if (edit === "marker-annotation") length.id = "current-policy-note";
      if (edit === "quantity-annotation") length.valueQuantity!.id = "current-length-note";
      const authoredLength = persist(length);
      for (let save = 0; save < 3; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step?.map(step => step.id)).toEqual(edit === "length"
          ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
        expect(wire.step![0].component[0].modifierExtension!
          .find(item => item.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)).toEqual(authoredLength);
        expect(nextDueDoses(wire, options)).toEqual(dates(edit === "length" ? [1, 2, 3, 4] : [1, 3, 4]));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: edit === "length" ? 6 : edit === "dose" ? 7 : 5, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("anchored pause retained");
        if (edit === "length") expect(wire.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          item.extension?.some(source => JSON.stringify(source) === JSON.stringify(originalDraft)))).toBe(true);
      }
    });

  it.each([
    ["tail", "r5"], ["tail", "r6"], ["head", "r5"], ["head", "r6"],
    ["only", "r5"], ["only", "r6"], ["valued", "r5"], ["valued", "r6"],
  ] as const)("keeps %s weekday primitive positions on %s while scheduling only real weekdays", (position, kind) => {
    const values = position === "tail" ? [FhirDayOfWeek.Monday, null] :
      position === "head" ? [null, FhirDayOfWeek.Monday] : position === "only" ? [null] : [FhirDayOfWeek.Monday];
    const note = { id: "weekday-placeholder", extension: [{
      url: "urn:clinic:weekday-note", valueString: "unvalued calendar annotation",
    }] };
    const annotations = position === "tail" ? [null, note] : position === "head" ? [note, null] :
      position === "only" ? [note] : [{ id: "monday-note" }];
    // JSON is a public external FHIR boundary, including nullable primitive slots.
    const rows: EzDosage[] = JSON.parse(JSON.stringify([{ id: "weekday-dose", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { ...daily, dayOfWeek: values, _dayOfWeek: annotations } } }]));
    const input: EzDosage[] | FhirR6DosageInstruction = kind === "r5" ? rows :
      JSON.parse(JSON.stringify({ step: [{ component: rows }] }));
    const beforeInput = persist(input);
    const native = importCanonicalCourse(input);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.dayOfWeek)
      .toEqual(position === "only" ? [] : [FhirDayOfWeek.Monday]);
    let wire = projectCanonicalCourse(native).fhirNext;
    expect(input).toEqual(beforeInput);
    const query = { ...options, from: "2026-01-04T00:00:00Z", orderedAt: "2026-01-04T00:00:00Z", limit: 2 };
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.dayOfWeek).toEqual(values);
      expect(repeat).toMatchObject({ _dayOfWeek: annotations });
      expect(nextDueDoses(wire, query)).toEqual(dates(position === "only" ? [4, 5] : [5, 12]));
      expect(calculateTotalUnits({ dosage: wire, ...query, durationValue: 7, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: position === "only" ? 7 : 1, unit: "tab" });
      for (const locale of ["en", "th"] as const)
        expect(() => fromFhir(wire, { locale })).not.toThrow();
      const coldRows = persist(toFhirR5Dosages(wire));
      expect(coldRows[0].timing!.repeat!.dayOfWeek).toEqual(values);
      expect(coldRows[0].timing!.repeat!).toMatchObject({ _dayOfWeek: annotations });
      expect(wire).toEqual(before);
      wire = toDosageDetails(coldRows);
    }
  });
});


describe("round52 interop current annotation and boundary ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d" },
  });
  const previousNextDay = { contextCode: { coding: [{
    system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "previous-phase-next-day",
  }] } };
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 8 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + (day < 10 ? "0" + day : String(day)) + "T09:00:00+00:00");
  const translationUrl = "http://hl7.org/fhir/StructureDefinition/translation";
  const translation = (text: string): FhirExtension => ({ url: translationUrl, extension: [
    { url: "lang", valueCode: "th" }, { url: "content", valueString: text },
  ] });

  it.each(["unchanged", "dose", "wording", "replacement", "clear-companion"] as const)(
    "keeps the current populated header and displaced translation after a %s edit", edit => {
      const original = "Take 1 tablet daily", replacement = "Take 2 tablets daily";
      const originalPrimitive = { id: "original-header-primitive", extension: [
        translation("รับประทานครั้งละ 1 เม็ด วันละครั้ง"),
        { url: "urn:clinic:header-note", valueString: "keep this independent annotation" },
      ] };
      const input: FhirR6DosageInstruction = { id: "course-original",
        renderedInstruction: original, _renderedInstruction: originalPrimitive,
        step: [{ id: "daily-phase", component: [{ id: "daily-dose",
          doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] }],
      };
      const editable = persist(fromDosageDetails(input));
      if (edit !== "unchanged") editable.dosages[0].doseAndRate![0].doseQuantity!.value = 2;
      if (edit === "wording" || edit === "replacement" || edit === "clear-companion")
        editable.course.renderedInstruction = replacement;
      const replacementPrimitive = { id: "replacement-header-primitive", extension: [
        translation("รับประทานครั้งละ 2 เม็ด วันละครั้ง"),
        { url: "urn:clinic:current-header-note", valueString: "current independent annotation" },
      ] };
      const header = editable.course as EzCourseMetadata & Pick<FhirR6DosageInstruction, "_renderedInstruction">;
      if (edit === "replacement") header._renderedInstruction = replacementPrimitive;
      if (edit === "clear-companion") header._renderedInstruction = { id: "current-untranslated-primitive" };
      const beforeEdit = persist(editable);
      let rows = toFhirR5Dosages(editable.dosages, editable.course);
      expect(editable).toEqual(beforeEdit);
      for (let save = 0; save < 3; save++) {
        const before = persist(rows), reopened = toDosageDetails(persist(rows));
        expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(edit === "unchanged" ? 1 : 2));
        expect(reopened.renderedInstruction).toBe(edit === "dose" ? undefined : edit === "unchanged" ? original : replacement);
        expect(reopened._renderedInstruction).toEqual(edit === "unchanged" ? originalPrimitive :
          edit === "replacement" ? replacementPrimitive : edit === "clear-companion" ? { id: "current-untranslated-primitive" } :
            { id: originalPrimitive.id, extension: [originalPrimitive.extension[1]] });
        if (edit !== "unchanged") {
          const retained: Array<Partial<EzCourseMetadata> | undefined> = [];
          for (const marker of reopened.extension ?? [])
            if (marker.url === DOSAGE_RECONCILIATION_SOURCE_URL)
              for (const source of marker.extension ?? [])
                if (source.url === DOSAGE_DETAILS_R5_URL) retained.push(decodeR5RetainedFields(source).course);
          expect(retained).toContainEqual(expect.objectContaining({
            renderedInstruction: original, _renderedInstruction: originalPrimitive,
          }));
          expect(formatSig(reopened, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
          expect(formatSig(reopened, "long", { locale: "th", realizationMode: "normalized" })).toContain("2 เม็ด");
        }
        expect(rows).toEqual(before);
        rows = toFhirR5Dosages(reopened);
      }
    });

  function nextDayPause(kind: string): FhirR6DosageInstruction {
    return toDosageDetails([
      { sequence: 1, id: "a-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
      { sequence: 2, id: "b-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { sequence: 4, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, count: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "phase-a", end: boundary(1) },
      { sequence: 2, id: "phase-b", start: kind === "independent-start" ? boundary(2) : previousNextDay,
        ...(kind === "fixed-end" ? { end: boundary(3) } : {}) },
      { sequence: 3, id: "pause", end: boundary(kind === "independent-start" || kind === "fixed-end" ? 4 : 3),
        extension: [{ id: "original-pause-note", url: "urn:clinic:pause-note",
          valueString: "recover complete original next-day pause" }] },
      { sequence: 4, id: "maintenance" },
    ] });
  }

  it.each(["unchanged", "earlier-end", "dose", "annotation", "independent-start", "fixed-end"] as const)(
    "rechecks a previous-phase-next-day completion after a %s edit", edit => {
      let wire = persist(nextDayPause(edit));
      const originalDraft = persist(wire.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!);
      const originalStart = persist(wire.step![1].start);
      if (edit === "earlier-end" || edit === "independent-start" || edit === "fixed-end") wire.step![0].end = boundary(2);
      if (edit === "dose") wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 4;
      if (edit === "annotation") wire.step![0].end!.id = "current-boundary-annotation";
      const retired = edit === "earlier-end";
      const expectedDays = retired ? [1, 2, 3, 4, 5] :
        edit === "independent-start" || edit === "fixed-end" ? [1, 2, 3, 5, 6] : [1, 2, 4, 5];
      const total = retired || edit === "independent-start" || edit === "fixed-end" ? 10 : edit === "dose" ? 12 : 9;
      for (let save = 0; save < 3; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step?.map(step => step.id))
          .toEqual(["phase-a", "phase-b", ...(!retired ? ["pause"] : []), "maintenance"]);
        expect(wire.step![1].start).toEqual(originalStart);
        expect(nextDueDoses(wire, options)).toEqual(dates(expectedDays));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 8, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: total, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        if (retired) expect(wire.extension?.some(marker => marker.url === DOSAGE_RECONCILIATION_SOURCE_URL &&
          marker.extension?.some(source => JSON.stringify(source) === JSON.stringify(originalDraft)))).toBe(true);
        else expect(decodeR6SourceMetadata(
          wire.extension!.find(marker => marker.url === R6_DRAFT_STEPS_SOURCE_URL)!, "drafts")?.drafts)
          .toEqual(decodeR6SourceMetadata(originalDraft, "drafts")?.drafts);
      }
    });

  it.each(["unchanged", "clear", "replace", "unannotated-clear"] as const)(
    "keeps the explicit public graph comparator %s authoritative over annotated carriers", edit => {
      const graph: CanonicalInstructionGraph = { sourceText: "Take at most 2 tablets",
        actions: [{ force: AdviceForce.Instruction, predicate: { lemma: "take" },
          args: [{ role: AdviceArgumentRole.Amount, text: "at most 2 tablets",
            quantity: { value: 2, unit: "tab", comparator: "<=" } }],
          span: { start: 0, end: 22 }, sourceText: "Take at most 2 tablets" }],
      };
      const quantity = (wire: FhirExtension) => wire.extension!.find(item => item.url === "action")!
        .extension!.find(item => item.url === "argument")!.extension!.find(item => item.url === "quantity")!;
      let wire = persist(buildInstructionGraphExtension(graph)!);
      const operator = quantity(wire).extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!;
      if (edit !== "unannotated-clear") {
        operator.id = "authored-operator-carrier";
        Object.assign(operator.valueCoding!, { id: "authored-operator-coding", display: "less than or equal to", userSelected: true,
          _code: { id: "authored-operator-code", extension: [{
            url: "urn:clinic:operator-label", valueString: "original qualifier annotation",
          }] },
        });
      }
      const authoredOperator = persist(operator);
      const independent = { id: "independent-quantity-note", url: "urn:clinic:quantity-note",
        valueString: "keep alongside current exact amount" };
      quantity(wire).extension!.push(independent);
      for (let save = 0; save < 3; save++) {
        const before = persist(wire), parsed = persist(parseInstructionGraphExtension([wire])!);
        if (!save) {
          if (edit === "clear" || edit === "unannotated-clear") delete parsed.actions[0].args[0].quantity!.comparator;
          if (edit === "replace") parsed.actions[0].args[0].quantity!.comparator = ">=";
        }
        const beforeBuild = persist(parsed), next = buildInstructionGraphExtension(parsed)!;
        expect(persist(parsed)).toEqual(beforeBuild);
        const reopened = parseInstructionGraphExtension([persist(next)])!;
        const amount = reopened.actions[0].args[0].quantity!;
        expect(amount.value).toBe(2);
        expect(amount.unit).toBe("tab");
        expect(amount.comparator).toBe(edit === "unchanged" ? "<=" : edit === "replace" ? ">=" : undefined);
        expect(quantity(next).extension).toContainEqual(independent);
        if (edit === "unchanged") expect(quantity(next).extension).toContainEqual(authoredOperator);
        if (edit === "clear") {
          expect(quantity(next).extension?.filter(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)).toEqual([]);
          expect(quantity(next).extension).toContainEqual({ url: QUANTITY_OPERATOR_SOURCE_URL, extension: [authoredOperator] });
        }
        if (edit === "replace") expect(quantity(next).extension).toContainEqual({
          url: QUANTITY_OPERATOR_SOURCE_URL, valueCoding: authoredOperator.valueCoding,
        });
        expect(wire).toEqual(before);
        wire = persist(next);
      }
    });

  it.each([
    ["head", "r5"], ["head", "r6"], ["tail", "r5"], ["tail", "r6"],
    ["only", "r5"], ["only", "r6"], ["valued", "r5"], ["valued", "r6"],
  ] as const)("keeps %s when primitive positions on %s without adding a meal dose", (position, kind) => {
    const annotation = { id: "unvalued-anchor", extension: [{
      url: "urn:clinic:anchor-note", valueString: "preserve the unvalued event annotation",
    }] };
    const values = position === "head" ? [null, EventTiming.Meal] :
      position === "tail" ? [EventTiming.Meal, null] : position === "only" ? [null] : [EventTiming.Meal];
    const repeat = { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, when: values,
      _when: position === "head" ? [annotation, null] : position === "tail" ? [null, annotation] :
        position === "only" ? [annotation] : [{ id: "meal-anchor" }],
    };
    // Complete valid external JSON retains primitive companions absent from
    // the deliberately narrow convenience interface.
    const row = JSON.parse(JSON.stringify({ id: "meal-dose",
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat } })) as FhirDosage;
    let wire: FhirDosage[] | FhirR6DosageInstruction = kind === "r5" ? [row] : { step: [{ component: [row] }] };
    const clocks = { ...options, limit: 4, eventClock: { CM: "08:00", CD: "12:00", CV: "18:00" },
      frequencyDefaults: { byFrequency: { "freq:2/d": ["08:00", "18:00"] } },
    };
    const expected = ["2026-01-01T08:00:00+00:00", "2026-01-01T18:00:00+00:00",
      "2026-01-02T08:00:00+00:00", "2026-01-02T18:00:00+00:00"];
    for (let save = 0; save < 3; save++) {
      const before = persist(wire);
      expect(nextDueDoses(wire, clocks)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: wire, ...clocks, durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 4, unit: "tab" });
      const output = toFhirR5Dosages(wire);
      expect(output[0].timing!.repeat!.when).toEqual(values);
      expect((output[0].timing!.repeat! as typeof repeat)._when).toEqual(repeat._when);
      expect(wire).toEqual(before);
      wire = kind === "r5" ? persist(output) : toDosageDetails(persist(output));
    }
  });

  it("retains every authored relation Coding field in the existing explicit clone", () => {
    const coding = { id: "relation-coding", system: "http://snomed.info/sct", version: "20261101",
      code: "66459002", display: "Around", userSelected: true,
      _code: { id: "relation-code", extension: [{ url: "urn:clinic:relation-code-note",
        valueString: "retain authored coding metadata" }] },
      _version: { id: "relation-version" },
      extension: [{ url: "urn:clinic:relation-note", valueString: "preserve independent relation annotation" }],
    };
    const input = { text: "around the left eye", extension: [buildBodySiteSpatialRelationExtension({
      relationText: "around", relationCoding: coding, targetText: "left eye", sourceText: "around the left eye",
    })!] };
    const before = persist(input);
    const parsed = parseBodySiteSpatialRelationExtension(input)!;
    const cloned = cloneBodySiteSpatialRelation(parsed)!;
    expect(cloned.relationCoding).toEqual(coding);
    expect(cloned.relationCoding).not.toBe(parsed.relationCoding);
    expect(cloned.relationCoding!._code).not.toBe(parsed.relationCoding!._code);
    expect(cloned.relationCoding!.extension).not.toBe(parsed.relationCoding!.extension);
    let saved = buildBodySiteSpatialRelationExtension(cloned)!;
    for (let save = 0; save < 3; save++) {
      const reopened = parseBodySiteSpatialRelationExtension({ extension: [persist(saved)] })!;
      expect(reopened.relationCoding).toEqual(coding);
      saved = buildBodySiteSpatialRelationExtension(cloneBodySiteSpatialRelation(reopened))!;
    }
    cloned.relationCoding!._code!.extension![0].valueString = "changed only on requested clone";
    expect(input).toEqual(before);
  });
  it("preserves extra relation Coding data and detaches FHIR annotations", () => {
    const codings = [
      { code: "66459002" },
      { system: "http://snomed.info/sct", code: "66459002", version: "20261101", display: "Around" },
      { system: undefined, code: "66459002", display: undefined,
        clinicNote: { labels: ["authored", "independent"] },
        _system: { id: "system-note", extension: [{ url: "urn:clinic:source", valueString: "authored" }] },
        _version: { id: "version-note" }, _display: { id: "display-note" },
        _userSelected: { id: "selection-note" }, i18n: { th: "รอบ" } },
      { code: "66459002", version: undefined, extraNote: undefined },
      { id: "relation-annotation-only", _code: { id: "pending-code",
        extension: [{ url: "urn:clinic:code-note", valueString: "retained" }] } },
    ];
    for (const coding of codings) {
      const relation = { relationText: "around", relationCoding: coding, targetText: "left eye",
        targetCoding: { system: "http://snomed.info/sct", code: "129004000",
          display: "Left eye", i18n: { th: "ตาซ้าย" } }, sourceText: "around left eye" };
      const before = persist(relation);
      const originalKeys = Object.keys(coding);
      const cloned = cloneBodySiteSpatialRelation(relation)!;
      expect(cloned.relationCoding).toEqual(coding);
      expect(cloned.relationCoding).not.toBe(coding);
      for (const key of originalKeys) {
        expect(Object.prototype.hasOwnProperty.call(cloned.relationCoding, key)).toBe(true);
      }
      expect(cloned.targetCoding).toEqual(relation.targetCoding);
      expect(cloned.targetCoding).not.toBe(relation.targetCoding);
      expect(cloned.targetCoding!.i18n).not.toBe(relation.targetCoding.i18n);
      cloned.targetCoding!.i18n!.th = "changed only on clone";
      if (coding._system) {
        const copied = cloned.relationCoding as typeof coding;
        expect(copied._system).not.toBe(coding._system);
        expect(copied._system!.extension).not.toBe(coding._system.extension);
        expect(copied._version).not.toBe(coding._version);
        expect(copied._display).not.toBe(coding._display);
        expect(copied._userSelected).not.toBe(coding._userSelected);
        expect(copied.i18n).not.toBe(coding.i18n);
        copied._system!.extension[0].valueString = "clone only";
        copied.i18n!.th = "clone only";
      }
      if (coding._code) {
        expect(cloned.relationCoding!._code).not.toBe(coding._code);
        cloned.relationCoding!._code!.extension![0].valueString = "clone only";
      }
      expect(persist(relation)).toEqual(before);
      expect(Object.keys(coding)).toEqual(originalKeys);
    }
    const target = { code: "129004000", display: undefined, i18n: undefined };
    const clonedTarget = cloneBodySiteSpatialRelation({ relationText: "around", targetCoding: target })!.targetCoding!;
    expect(clonedTarget).toEqual(target);
    expect(Object.prototype.hasOwnProperty.call(clonedTarget, "display")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(clonedTarget, "i18n")).toBe(true);
  });
});


describe("round53 import/data correctness", () => {
  const translationUrl = "http://hl7.org/fhir/StructureDefinition/translation";
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const boundary = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d", code: "d", system: "http://unitsofmeasure.org" },
  });
  const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC" };

  it.each(["compact changed", "compact unchanged", "row-baseline changed", "row-baseline unchanged"])(
    "retires only stale active row translations on fresh %s input", variant => {
      const wording = "Take one tablet daily";
      const opaque = { url: "urn:clinic:row-text-note", valueString: "keep independent annotation" };
      const companion: FhirElement = { id: "row-text-id", extension: [opaque, {
        url: translationUrl, extension: [
          { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานหนึ่งเม็ดทุกวัน" },
        ],
      }] };
      const source: FhirR6DosageInstruction = { renderedInstruction: wording, step: [{ component: [{
        text: wording, _text: companion, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      }] }] };
      const rows = persist(toFhirR5Dosages(source));
      if (variant.startsWith("row-baseline"))
        rows[0].modifierExtension = rows[0].modifierExtension?.filter(item => item.url !== DOSAGE_DETAILS_R5_URL);
      const changed = variant.endsWith(" changed");
      if (changed) rows[0].doseAndRate![0].doseQuantity!.value = 2;
      const before = persist(rows);
      let actual = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const member = actual.step![0].component[0];
        expect(member.doseAndRate![0].doseQuantity!.value).toBe(changed ? 2 : 1);
        expect(member._text).toEqual(changed ? { id: "row-text-id", extension: [opaque] } : companion);
        if (changed) {
          expect(member.text).toBeUndefined();
          const retiredRows: ReturnType<typeof decodeR5RetainedFields>[] = [];
          for (const item of actual.extension ?? []) if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            for (const old of item.extension ?? []) if (old.url === DOSAGE_DETAILS_R5_URL)
              retiredRows.push(decodeR5RetainedFields(old));
          expect(retiredRows).toContainEqual({
            rowIndex: 0, sequence: 1, component: { text: wording, _text: companion },
          });
        }
        actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
      }
      expect(rows).toEqual(before);
    });

  it.each(["anonymous", "identified", "distinct projection", "same reference"])(
    "retains the correct reference owner after a fresh surviving row (%s)", identity => {
      const rightReference = "BodyStructure/right-eye";
      const leftReference = identity === "same reference" ? rightReference : "BodyStructure/left-eye";
      const components = [
        { id: "right", value: 1, reference: rightReference },
        { id: "left", value: identity === "distinct projection" ? 2 : 1, reference: leftReference },
      ];
      const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [
        { url: "dosageDetails", extension: [{ url: "step", extension: components.map(item => ({
          url: "component", extension: [
            ...(identity === "identified" ? [{ url: "id", valueString: item.id }] : []),
            { url: "site", valueCodeableReference: { reference: { reference: item.reference },
              extension: [{ url: "urn:clinic:reference-note", valueString: item.id + " original site" }] } },
            { url: "doseAndRate", extension: [{ url: "doseQuantity", valueQuantity: q(item.value) }] },
          ],
        })) }] },
      ] };
      const rows: FhirDosage[] = [{
        sequence: 1, ...(identity === "identified" ? { id: "left" } : {}),
        doseAndRate: [{ doseQuantity: q(components[1].value) }], modifierExtension: [marker],
      }];
      const before = persist(rows);
      let actual = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        expect(actual.step![0].component).toHaveLength(1);
        const member = actual.step![0].component[0];
        expect(member.doseAndRate![0].doseQuantity!.value).toBe(components[1].value);
        expect(member.site?.reference?.reference).toBe(identity === "anonymous" ? undefined : leftReference);
        if (identity === "anonymous") {
          expect(JSON.stringify(actual.extension)).toContain(rightReference);
          expect(JSON.stringify(actual.extension)).toContain(leftReference);
          expect(JSON.stringify(actual.extension)).toContain("left original site");
        }
        actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
      }
      expect(rows).toEqual(before);
    });

  it.each([0, 1])("previews the submitted phase offsets after %i preceding draft stages", phase => {
    const active: FhirR6Dosage = { id: "active-dose", doseAndRate: [{ doseQuantity: q(2) }],
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, unit: "d", code: "d" }, endOffset: { value: 5, unit: "d", code: "d" },
      } } };
    const source: FhirR6DosageInstruction = { step: [
      ...(phase ? [{ id: "induction", component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] }] : []),
      { id: "active-phase", start: boundary(6), component: [active] },
    ] };
    const rows = persist(toFhirR5Dosages(source));
    const row = rows[phase];
    const before = persist(row);
    const preview = fromFhirDosage(row, { locale: "en", realizationMode: "normalized" });
    expect(preview.longText).toContain("Dosing starts 2 days after the period begins");
    expect(preview.longText).toContain("No doses during the final 5 days of each period");
    const formatted = formatSig(row, "long", { locale: "en", realizationMode: "normalized" });
    expect(formatted).toContain("Dosing starts 2 days after the period begins");
    expect(formatted).toContain("No doses during the final 5 days of each period");
    const native = importCanonicalCourse(persist([row]));
    expect(native.stages.filter(stage => stage.administrations.length)).toHaveLength(1);
    expect(native.stages[phase].administrations[0].amounts?.[0].quantity?.value).toBe(2);
    if (phase) expect(native.stages[0].administrations).toEqual([]);
    expect(row).toEqual(before);
  });

  it.each(["unchanged", "end Element ID", "end displacement"])(
    "keeps only owned editable pauses after a fresh %s change", variant => {
      const saved = toDosageDetails([
        { sequence: 1, id: "induction-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
        { sequence: 3, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } },
      ], undefined, { step: [
        { sequence: 1, id: "induction", end: boundary(1) },
        { sequence: 2, id: "pause", end: boundary(3),
          extension: [{ url: "urn:clinic:pause-note", valueString: "keep authored pause" }] },
        { sequence: 3, id: "maintenance" },
      ] });
      const input = persist(saved);
      if (variant === "end Element ID") input.step![0].end!.id = "current-end-annotation";
      if (variant === "end displacement") input.step![0].end!.offsetDuration!.value = 2;
      const before = persist(input);
      const editable = fromDosageDetails(input);
      expect(editable.course.step!.map(step => step.id)).toEqual(
        variant === "end displacement" ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
      expect(editable.course.step![0].end).toEqual(input.step![0].end);
      const reopened = toDosageDetails(persist(editable.dosages), undefined, persist(editable.course));
      expect(fromDosageDetails(reopened).course.step!.map(step => step.id)).toEqual(
        variant === "end displacement" ? ["induction", "maintenance"] : ["induction", "pause", "maintenance"]);
      expect(JSON.stringify(reopened)).toContain("keep authored pause");
      expect(input).toEqual(before);
    });

  it.each(["exact", "numerator", "lower-bounded numerator"])(
    "does not invent exact ingredient or container totals from %s strength", qualified => {
      const strengthRatio: FhirRatio = {
        numerator: { value: 5, unit: "mg", ...(qualified === "numerator" ? { comparator: "<" as const } :
          qualified === "lower-bounded numerator" ? { comparator: ">=" as const } : {}) },
        denominator: { value: 1, unit: "mL" },
      };
      const before = persist(strengthRatio);
      const drops: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 20, unit: "drop" } }], timing: { repeat: daily } };
      const approximate = calculateTotalUnits({ dosage: drops, ...options, durationValue: 1,
        durationUnit: FhirPeriodUnit.Day, context: { dosageForm: "eye drops", strengthRatio } });
      expect(approximate.totalUnits).toBe(20);
      expect(approximate.totalApproximateQuantity).toMatchObject({ value: 1, unit: "mL" });
      if (qualified === "exact")
        expect(approximate.totalApproximateIngredientQuantity).toMatchObject({ value: 5, unit: "mg" });
      else expect(approximate.totalApproximateIngredientQuantity).toBeUndefined();
      const mass: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 10, unit: "mg" } }], timing: { repeat: daily } };
      const converted = calculateTotalUnits({ dosage: mass, ...options, durationValue: 1,
        durationUnit: FhirPeriodUnit.Day, context: { strengthRatio, containerValue: 1, containerUnit: "mL" } });
      expect(converted).toMatchObject({ totalUnits: 10, unit: "mg" });
      expect(converted.totalContainers).toBe(qualified === "exact" ? 2 : undefined);
      expect(strengthRatio).toEqual(before);
    });
});


describe("round54 import/data fresh interchange", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 20 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + ("0" + day).slice(-2) + "T09:00:00+00:00");
  const historicalMarker = (step: FhirR6DosageStep): FhirExtension => ({
    url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", step, "step")] }],
  });

  it.each(["omitted", "unchanged", "version", "version and amount"] as const)(
    "preserves current condition metadata on a fresh historical row (%s)", variant => {
      const condition: FhirR6DosageCondition = {
        code: { coding: [{ system: "urn:clinic:condition", code: "pain", display: "Pain" }] },
        operation: "eq", valueBoolean: true, text: "If pain persists",
        extension: [{ url: "urn:clinic:condition-note", valueString: "keep condition annotation" }],
      };
      const step: FhirR6DosageStep = { id: "historical-phase", component: [{
        id: "historical-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, condition: [condition],
      }] };
      const rows: EzDosage[] = persist(toFhirR5Dosages({ step: [step] }));
      rows[0].modifierExtension = [
        ...(rows[0].modifierExtension ?? []).filter(item => item.url !== DOSAGE_DETAILS_R5_URL),
        historicalMarker(step),
      ];
      const supplied = persist(condition);
      if (variant.startsWith("version")) supplied.code!.coding![0].version = "2026-review";
      if (variant !== "omitted") rows[0].condition = [supplied];
      if (variant === "version and amount") rows[0].doseAndRate![0].doseQuantity!.value = 2;
      const before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const member = wire.step![0].component[0];
        expect(member.condition).toEqual([variant === "omitted" ? condition : supplied]);
        expect(member.doseAndRate![0].doseQuantity).toEqual(q(variant === "version and amount" ? 2 : 1));
        expect(member.id).toBe("historical-dose");
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  it.each(["unchanged repeated", "earlier repeated", "earlier single", "annotated repeated"] as const)(
    "keeps only owned pauses after an explicit-end phase (%s)", variant => {
      const count = variant === "earlier single" ? 1 : 2;
      const saved = toDosageDetails([
        { sequence: 1, id: "a-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
        { sequence: 2, id: "b-dose", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } },
        { sequence: 4, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
          timing: { repeat: { ...daily, count: 1 } } },
      ], undefined, { step: [
        { sequence: 1, id: "phase-a", end: boundary(2) },
        { sequence: 2, id: "phase-b", end: boundary(4), count },
        { sequence: 3, id: "pause", end: boundary(7),
          extension: [{ id: "pause-note", url: "urn:clinic:pause", valueString: "keep original repeated-phase pause" }] },
        { sequence: 4, id: "maintenance" },
      ] });
      let wire = persist(saved);
      if (variant.startsWith("earlier")) wire.step![0].end = boundary(1);
      if (variant === "annotated repeated") wire.step![0].end!.id = "current-boundary-annotation";
      const liveStart = persist(wire.step![wire.step!.length - 1].start);
      const retired = variant === "earlier repeated";
      const expectedDays = retired ? [1, 2, 3, 4, 5, 6, 7, 8] : count === 1 ? [1, 2, 3, 4, 8] : [1, 2, 3, 4, 5, 6, 8];
      const expectedTotal = retired ? 16 : count === 1 ? 10 : 13;
      for (let save = 0; save < 2; save++) {
        const before = persist(wire);
        const editable = fromDosageDetails(wire);
        expect(editable.course.step!.map(step => step.id)).toEqual(
          ["phase-a", "phase-b", ...(!retired ? ["pause"] : []), "maintenance"]);
        expect(wire.step![wire.step!.length - 1].start).toEqual(liveStart);
        expect(nextDueDoses(wire, options)).toEqual(dates(expectedDays));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 9, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: expectedTotal, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("keep original repeated-phase pause");
      }
    });

  it.each(["amount", "period", "unchanged", "missing live ratio"] as const)(
    "completes only the identified projected partial period cap (%s)", variant => {
      const cap: FhirR6DoseLimit = { id: "daily-max", scope: "period",
        valueQuantity: { ...(variant === "period" ? { value: 4 } : {}), unit: "tab",
          extension: [{ url: "urn:clinic:amount-note", valueString: "keep amount note" }] },
        period: { ...(variant === "period" ? {} : { value: 1 }), unit: "d" },
        text: "Keep the authored daily maximum",
        extension: [{ url: "urn:clinic:cap-note", valueString: "keep cap note" }],
      };
      const source = course({ timing: { repeat: daily }, safety: { doseLimit: [cap],
        extension: [{ url: "urn:clinic:safety-note", valueString: "keep safety policy" }] } });
      const rows = persist(toFhirR5Dosages(source));
      if (variant === "amount") rows[0].maxDosePerPeriod![0].numerator!.value = 4;
      if (variant === "period") rows[0].maxDosePerPeriod![0].denominator!.value = 1;
      if (variant === "missing live ratio") delete rows[0].maxDosePerPeriod;
      const before = persist(rows);
      const expected = variant === "amount" || variant === "period"
        ? { ...cap, valueQuantity: { ...cap.valueQuantity, value: 4 }, period: { ...cap.period, value: 1 } } : cap;
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const safety = wire.step![0].component[0].safety!;
        if (variant === "missing live ratio") {
          expect(safety.doseLimit).toBeUndefined();
          const retainedCaps: FhirR6DoseLimit[] = [];
          for (const envelope of wire.extension ?? []) if (envelope.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            for (const marker of envelope.extension ?? []) if (marker.url === DOSAGE_DETAILS_R5_URL)
              retainedCaps.push(...(decodeR5RetainedFields(marker).component?.safety?.doseLimit ?? []));
          expect(retainedCaps).toContainEqual(cap);
        } else expect(safety.doseLimit).toEqual([expected]);
        expect(safety.extension).toEqual(source.step![0].component[0].safety!.extension);
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(1));
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  it.each(["live reference", "strict retained reference", "historical retained reference", "historical current fields", "concept only", "concept and reference"] as const)(
    "previews the independently supplied eye from a fresh %s", variant => {
      const reference = { reference: "BodyStructure/left-eye", display: "left eye",
        extension: [{ url: "urn:clinic:reference-note", valueString: "keep eye reference" }] };
      const component: FhirR6Dosage = { id: "eye-dose", doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
        site: { reference } };
      let row: EzDosage;
      if (variant === "strict retained reference" || variant.startsWith("historical")) {
        row = persist(toFhirR5Dosages({ step: [{ component: [component] }] })[0]);
        if (variant.startsWith("historical")) row.modifierExtension = [
          ...(row.modifierExtension ?? []).filter(item => item.url !== DOSAGE_DETAILS_R5_URL),
          historicalMarker({ component: [component] }),
        ];
      } else row = { id: "eye-dose", doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
        ...(variant === "concept only" ? {} : { siteReference: reference }),
        ...(variant.startsWith("concept") ? { site: { text: "right eye" } } : {}),
      };
      const currentReference = variant === "historical current fields"
        ? { ...reference, reference: "BodyStructure/right-eye", display: "right eye" } : reference;
      const amount = variant === "historical current fields" ? 2 : 1;
      if (variant === "historical current fields") {
        row.doseAndRate![0].doseQuantity!.value = amount;
        row.siteReference = currentReference;
        row.timing = { repeat: { ...daily, frequency: 2, timeOfDay: ["08:00:00", "20:00:00"] } };
      }
      const before = persist(row);
      const right = variant.startsWith("concept") || variant === "historical current fields";
      const expectedEye = right ? "right eye" : "left eye";
      const otherEye = right ? "left eye" : "right eye";
      for (const mode of [undefined, "normalized"] as const) {
        const preview = fromFhirDosage(persist(row), { locale: "en", realizationMode: mode });
        const formatted = formatSig(persist(row), "long", { locale: "en", realizationMode: mode });
        for (const text of [preview.longText, formatted]) {
          expect(text).toContain(amount === 2 ? "2 drops" : "1 drop");
          expect(text).toContain(expectedEye);
          expect(text).not.toContain(otherEye);
        }
      }
      const native = toDosageDetails(persist([row]));
      const member = native.step![0].component[0];
      expect(member.doseAndRate![0].doseQuantity).toEqual({ value: amount, unit: "drop" });
      if (variant === "historical current fields") expect(member.timing?.repeat).toEqual(row.timing!.repeat);
      if (variant !== "concept only") expect(member.site?.reference).toEqual(currentReference);
      const reopened = toDosageDetails(persist(toFhirR5Dosages(native)));
      expect(reopened.step![0].component[0].site).toEqual(member.site);
      expect(row).toEqual(before);
    });

  it.each(["weekday", "when"] as const)(
    "accepts typed current R6 %s primitive slots while keeping recurrence value-only", kind => {
      const annotation = { id: "metadata-only-slot", extension: [{
        url: "urn:clinic:timing-note", valueString: "keep positional timing annotation",
      }] };
      const timing: FhirR6Timing = { repeat: kind === "weekday"
        ? { ...daily, dayOfWeek: [null, FhirDayOfWeek.Monday], _dayOfWeek: [annotation, null] }
        : { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          when: [EventTiming.Morning, null], _when: [null, annotation] } };
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        id: "typed-timing-dose", doseAndRate: [{ doseQuantity: q(1) }], timing,
      }] }] };
      const before = persist(input);
      const native = importCanonicalCourse(input);
      const recurrence = native.stages[0].administrations[0].schedule!.recurrence!;
      expect(recurrence.dayOfWeek).toEqual(kind === "weekday" ? [FhirDayOfWeek.Monday] : undefined);
      expect(recurrence.anchors).toEqual(kind === "when" ? [EventTiming.Morning] : undefined);
      let wire = projectCanonicalCourse(native).fhirNext;
      for (let save = 0; save < 2; save++) {
        const repeat = wire.step![0].component[0].timing!.repeat!;
        expect(repeat.dayOfWeek).toEqual(timing.repeat!.dayOfWeek);
        expect(repeat.when).toEqual(timing.repeat!.when);
        expect(repeat).toMatchObject(kind === "weekday" ? { _dayOfWeek: [annotation, null] } : { _when: [null, annotation] });
        expect(nextDueDoses(wire, { orderedAt: "2026-01-04T00:00:00Z", from: "2026-01-04T00:00:00Z",
          timeZone: "UTC", limit: 2, eventClock: { MORN: "09:00" } }))
          .toEqual(dates(kind === "weekday" ? [5, 12] : [4, 5]));
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(input).toEqual(before);
    });
});

describe("round55 interop current ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number, anchor = "treatment-start") => ({ contextCode: { coding: [{
    system: anchor === "treatment-start" ? "http://hl7.org/fhir/evidence-variable-event"
      : "urn:ezmedicationinput:CodeSystem:course-phase-event", code: anchor,
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 20 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + ("0" + day).slice(-2) + "T09:00:00+00:00");
  const sourceCaps = (wire: FhirR6DosageInstruction): FhirR6DoseLimit[] => {
    const result: FhirR6DoseLimit[] = [];
    for (const envelope of wire.extension ?? []) if (envelope.url === DOSAGE_RECONCILIATION_SOURCE_URL)
      for (const marker of envelope.extension ?? []) if (marker.url === DOSAGE_DETAILS_R5_URL)
        result.push(...(decodeR5RetainedFields(marker).component?.safety?.doseLimit ?? []));
    return result;
  };

  it.each(["unchanged repeated", "earlier repeated", "earlier single", "annotated repeated"] as const)(
    "reconciles a fixed-end phase after its own fresh start edit (%s)", variant => {
      const count = variant === "earlier single" ? 1 : 2;
      const saved = toDosageDetails([
        { sequence: 1, id: "a-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
        { sequence: 2, id: "b-dose", doseAndRate: [{ doseQuantity: q(2) }],
          timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
        { sequence: 4, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
          timing: { repeat: { ...daily, count: 1 } } },
      ], undefined, { step: [
        { sequence: 1, id: "phase-a", start: boundary(1), end: boundary(3), count },
        { sequence: 2, id: "phase-b" },
        { sequence: 3, id: "pause", end: boundary(7),
          extension: [{ url: "urn:clinic:pause", valueString: "keep the original fixed-end pause" }] },
        { sequence: 4, id: "maintenance" },
      ] });
      let wire = persist(saved);
      if (variant.startsWith("earlier")) wire.step![0].start = boundary(0);
      if (variant === "annotated repeated") wire.step![0].start!.id = "current-start-note";
      const retired = variant === "earlier repeated";
      const expectedDays = retired ? [1, 2, 3, 4, 5, 6, 7, 8]
        : count === 1 ? [1, 2, 3, 4, 8] : [2, 3, 4, 5, 6, 8];
      for (let save = 0; save < 2; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step!.map(step => step.id))
          .toEqual(["phase-a", "phase-b", ...(!retired ? ["pause"] : []), "maintenance"]);
        expect(nextDueDoses(wire, options)).toEqual(dates(expectedDays));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 9, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: retired ? 11 : count === 1 ? 8 : 9, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("keep the original fixed-end pause");
      }
    });

  it.each(["unchanged", "dose edit", "delete amount-missing", "delete period-missing"] as const)(
    "keeps a submitted partial period maximum active only while present (%s)", variant => {
      const cap: FhirR6DoseLimit = { id: "partial-period-cap", scope: "period",
        valueQuantity: { ...(variant === "delete period-missing" ? { value: 4 } : {}), unit: "tab",
          extension: [{ url: "urn:clinic:partial-amount", valueString: "awaiting prescribed amount" }] },
        period: { ...(variant === "delete period-missing" ? {} : { value: 1 }), unit: "d",
          extension: [{ url: "urn:clinic:partial-period", valueString: "keep original period annotation" }] },
        text: "Awaiting the completed daily maximum",
        extension: [{ url: "urn:clinic:partial-limit", valueString: "retain complete authored limit" }],
      };
      const safetyNote = { url: "urn:clinic:safety-owner", valueString: "independent safety annotation" };
      const original = course({ timing: { repeat: daily }, safety: { doseLimit: [cap], extension: [safetyNote] } });
      const rows = persist(toFhirR5Dosages(original));
      if (variant === "dose edit") rows[0].doseAndRate![0].doseQuantity!.value = 2;
      if (variant.startsWith("delete")) delete rows[0].maxDosePerPeriod;
      const before = persist(rows), deleted = variant.startsWith("delete");
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const member = wire.step![0].component[0];
        expect(member.safety?.doseLimit).toEqual(deleted ? undefined : [cap]);
        expect(member.safety?.extension).toEqual([safetyNote]);
        expect(member.doseAndRate![0].doseQuantity).toEqual(q(variant === "dose edit" ? 2 : 1));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: variant === "dose edit" ? 4 : 2, unit: "tab" });
        if (deleted) expect(sourceCaps(wire)).toContainEqual(cap);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(rows).toEqual(before);
    });

  it.each(["plain", "extra child", "marker annotation"] as const)(
    "restores a source-only Ratio without losing enriched marker data (%s)", variant => {
      const ratio: FhirRatio = { id: "pending-window", extension: [
        { url: "urn:clinic:pending-amount-source", valueQuantity: q(4) },
        { url: "urn:clinic:pending-period-source", extension: [{
          id: "pending-period", url: "urn:clinic:period-note", valueString: "period remains unentered",
        }] },
      ] };
      const input = persist(toDosageDetails([{ doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [ratio] }]));
      const marker = input.step![0].component[0].extension!.find(item => item.url === R5_SOURCE_ONLY_MAXIMUM_URL)!;
      if (variant === "extra child") marker.extension!.push({ url: "urn:clinic:unknown-marker-child",
        valueString: "keep the source-only marker annotation" });
      if (variant === "marker annotation") marker.id = "annotated-maximum-marker";
      const before = persist(input), expectedMarker = persist(marker);
      let rows = toFhirR5Dosages(input);
      for (let save = 0; save < 2; save++) {
        expect(rows[0].maxDosePerPeriod).toEqual([ratio]);
        const history: FhirExtension[] = [];
        for (const envelope of rows[0].extension ?? [])
          if (envelope.url === DOSAGE_RECONCILIATION_SOURCE_URL) history.push(...(envelope.extension ?? []));
        if (variant === "plain") expect(history).not.toContainEqual(expectedMarker);
        else expect(history).toContainEqual(expectedMarker);
        const native = toDosageDetails(persist(rows));
        expect(native.step![0].component[0].safety?.doseLimit).toBeUndefined();
        rows = toFhirR5Dosages(persist(native));
      }
      expect(input).toEqual(before);
    });

  it.each(["unchanged", "replacement", "companion only", "wording only"] as const)(
    "applies the submitted instruction companion to a populated historical save (%s)", variant => {
      const oldPrimitive = { id: "historical-instruction", extension: [{
        url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
          { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานครั้งละ 1 เม็ด" },
        ],
      }, { url: "urn:clinic:old-header-note", valueString: "keep original header annotation" }] };
      const currentPrimitive = { id: "current-instruction", extension: [
        { url: "urn:clinic:current-header-note", valueString: "current header annotation" },
      ] };
      const original = { renderedInstruction: "Take 1 tablet daily", _renderedInstruction: oldPrimitive };
      const fields = encodeR5RetainedFields({ course: original }).find(item => item.url === "course")!.extension!;
      const step: FhirR6DosageStep = { component: [{ id: "historical-dose",
        doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }] };
      const rows: EzDosage[] = [{ sequence: 1, id: "historical-dose",
        doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, modifierExtension: [{
        url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
          extension: [...fields, encodeR6SourceMetadata("step", step, "step")] }],
      }] }];
      const edits: EzCourseMetadata & Pick<FhirR6DosageInstruction, "_renderedInstruction"> = {
        ...original, ...(variant === "replacement" || variant === "wording only" ? { renderedInstruction: "Current one-tablet instruction" } : {}),
        ...(variant === "replacement" || variant === "companion only" ? { _renderedInstruction: currentPrimitive } : {}),
      };
      const before = persist({ rows, edits });
      let wire = toDosageDetails(rows, edits.renderedInstruction, edits);
      for (let save = 0; save < 2; save++) {
        expect(wire.renderedInstruction).toBe(edits.renderedInstruction);
        expect(wire._renderedInstruction).toEqual(variant === "replacement" || variant === "companion only"
          ? currentPrimitive : variant === "wording only" ? { id: oldPrimitive.id, extension: [oldPrimitive.extension[1]] } : oldPrimitive);
        expect(wire.step![0].component[0].doseAndRate![0].doseQuantity).toEqual(q(1));
        if (variant !== "unchanged") {
          const saved: Array<Partial<EzCourseMetadata> | undefined> = [];
          for (const envelope of wire.extension ?? []) if (envelope.url === DOSAGE_RECONCILIATION_SOURCE_URL)
            for (const marker of envelope.extension ?? []) if (marker.url === DOSAGE_DETAILS_R5_URL) {
              const historical = marker.extension?.find(item => item.url === "dosageDetails");
              saved.push(decodeR5RetainedFields(historical ? { url: DOSAGE_DETAILS_R5_URL,
                extension: [{ url: "course", extension: historical.extension }] } : marker).course);
            }
          expect(saved).toContainEqual(expect.objectContaining(original));
        }
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect({ rows, edits }).toEqual(before);
    });

  it.each(["treatment-start", "treatment-day-start", "previous-phase-next-day"] as const)(
    "requires a removed predecessor only for a dependent member start (%s)", anchor => {
      const start = boundary(4, anchor);
      const marker = encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start }, "step");
      const original: FhirR6DosageInstruction = { step: [
        { component: [{ id: "removed-dose", doseAndRate: [{ doseQuantity: q(2) }],
          timing: { repeat: { ...daily, count: 1 } } }] },
        { component: [{ id: "survivor", doseAndRate: [{ doseQuantity: q(1) }],
          modifierExtension: [marker], timing: { repeat: { ...daily, count: 2,
            boundsPeriod: { start: "2026-01-05T00:00:00Z" } } } }] },
      ] };
      const rows = persist(toFhirR5Dosages(original)).slice(1);
      const before = persist(rows), dependent = anchor === "previous-phase-next-day";
      let current = rows;
      for (let save = 0; save < 2; save++) {
        const native = importCanonicalCourse(current);
        const member = native.stages[1].administrations[0];
        expect(member.phaseStart?.anchor).toBe(anchor);
        if (dependent) {
          expect(member.missingContexts).toContain("predecessor");
          expect(() => nextDueDoses(current, options)).toThrow(/complete dosage array/i);
        } else {
          expect(member.missingContexts).toBeUndefined();
          expect(native.contextIssue).toBeUndefined();
          expect(nextDueDoses(current, options)).toEqual(dates([5, 6]));
        }
        const wire = toDosageDetails(persist(current));
        expect(wire.step!.find(step => step.component.some(item => item.id === "survivor"))!
          .component[0].modifierExtension).toContainEqual(marker);
        current = persist(toFhirR5Dosages(wire));
      }
      expect(rows).toEqual(before);
    });

  it.each(["weekday", "when"] as const)(
    "accepts typed R5 positional %s metadata without adding clinical values", kind => {
      const annotation = { id: "r5-metadata-slot", extension: [{
        url: "urn:clinic:repeat-note", valueString: "keep R5 primitive positions",
      }] };
      const rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: kind === "weekday"
        ? { ...daily, dayOfWeek: [null, FhirDayOfWeek.Monday], _dayOfWeek: [annotation, null] }
        : { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          when: [null, EventTiming.Morning], _when: [annotation, null] } } }];
      const before = persist(rows);
      let current = rows;
      for (let save = 0; save < 2; save++) {
        const native = importCanonicalCourse(current), recurrence = native.stages[0].administrations[0].schedule!.recurrence!;
        expect(recurrence.dayOfWeek).toEqual(kind === "weekday" ? [FhirDayOfWeek.Monday] : undefined);
        expect(recurrence.anchors).toEqual(kind === "when" ? [EventTiming.Morning] : undefined);
        const wire = toDosageDetails(current);
        expect(wire.step![0].component[0].timing!.repeat).toEqual(rows[0].timing!.repeat);
        const output: FhirDosage[] = toFhirR5Dosages(persist(wire));
        expect(output[0].timing!.repeat).toEqual(rows[0].timing!.repeat);
        expect(output[0].timing!.repeat!._dayOfWeek).toEqual(rows[0].timing!.repeat!._dayOfWeek);
        expect(output[0].timing!.repeat!._when).toEqual(rows[0].timing!.repeat!._when);
        expect(nextDueDoses(output, { orderedAt: "2026-01-04T00:00:00Z", from: "2026-01-04T00:00:00Z",
          timeZone: "UTC", limit: 2, eventClock: { MORN: "09:00" } })).toEqual(dates(kind === "weekday" ? [5, 12] : [4, 5]));
        current = persist(output);
      }
      expect(rows).toEqual(before);
    });
});

describe("round55 maximum-only R5 primitive ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const missingMinimum = { extension: [{
    url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
  }] };
  it.each(["maximum only", "authored companion", "exact", "range"] as const)(
    "retains active count facts and the submitted minimum companion (%s)", variant => {
      const authored = { id: "authored-count-note", extension: [{
        url: "urn:clinic:count-note", valueString: "no minimum was supplied",
      }] };
      const input = course({ timing: { repeat: { ...daily,
        ...(variant === "exact" ? { count: 3 } : variant === "range" ? { count: 2, countMax: 3 } : { countMax: 3 }),
        ...(variant === "authored companion" ? { _count: authored } : {}),
      } } });
      const before = persist(input), count = variant === "exact" ? 3 : variant === "range" ? 2 : undefined;
      let rows = toFhirR5Dosages(input);
      for (let save = 0; save < 2; save++) {
        const repeat = rows[0].timing!.repeat!;
        expect(repeat.count).toBe(count);
        expect(repeat.countMax).toBe(variant === "exact" ? undefined : 3);
        expect(repeat._count).toEqual(variant === "authored companion" ? authored : variant === "maximum only" ? missingMinimum : undefined);
        const native = importCanonicalCourse(persist(rows)).stages[0].administrations[0].schedule!.recurrence!;
        expect(native.count).toBe(count);
        expect(native.countMax).toBe(variant === "exact" ? undefined : 3);
        if (variant === "maximum only" || variant === "authored companion")
          expect(formatSig(rows, "long", { locale: "en", realizationMode: "normalized" })).toContain("up to 3 doses");
        if (variant !== "range") expect(nextDueDoses(rows, { orderedAt: "2026-01-01T00:00:00Z",
          from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 10 }))
          .toEqual(["2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00"]);
        rows = toFhirR5Dosages(persist(toDosageDetails(persist(rows))));
      }
      expect(input).toEqual(before);
    });

  it.each(["Take 1 tablet every 6 hours as needed for pain, up to 3 doses",
    "1 tab sl q5min prn chest pain max 3 doses"])(
    "exports an extension-only minimum without changing the authored ceiling (%s)", text => {
      const parsed = parseSig(text);
      const rows = persist(parsed.fhir), before = persist(rows);
      expect(rows[0].timing!.repeat).toMatchObject({ countMax: 3, _count: missingMinimum });
      expect(rows[0].timing!.repeat!.count).toBeUndefined();
      const native = importCanonicalCourse(rows).stages[0].administrations[0];
      expect(native.schedule!.recurrence!.count).toBeUndefined();
      expect(native.schedule!.recurrence!.countMax).toBe(3);
      expect(native.asNeeded).toBe(true);
      const wire = toDosageDetails(persist(rows));
      const saved = toFhirR5Dosages(persist(wire));
      expect(saved[0].timing!.repeat).toMatchObject({ countMax: 3, _count: missingMinimum });
      expect(saved[0].timing!.repeat!.count).toBeUndefined();
      expect(formatSig(persist(saved), "long", { locale: "en", realizationMode: "normalized" })).toContain("up to 3 doses");
      expect(rows).toEqual(before);
    });
});


describe("round56 interop current ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 20 };
  const dates = (days: number[]) => days.map(day => "2026-01-" + ("0" + day).slice(-2) + "T09:00:00+00:00");
  const historicalMarker = (step: FhirR6DosageStep): FhirExtension => ({
    url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", step, "step")] }],
  });

  const completionInput = (variant: string): FhirR6DosageInstruction => {
    const saved = toDosageDetails([
      { sequence: 1, id: "first-dose", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { sequence: 2, id: "second-dose", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 1, unit: "d" } } } },
      { sequence: 4, id: "maintenance-dose", doseAndRate: [{ doseQuantity: q(3) }],
        timing: { repeat: { ...daily, count: 1 } } },
    ], undefined, { step: [
      { sequence: 1, id: "first-phase" }, { sequence: 2, id: "second-phase" },
      { sequence: 3, id: "pause", end: boundary(3),
        extension: [{ url: "urn:clinic:pause-owner", valueString: "keep the authored pause boundary" }] },
      { sequence: 4, id: "maintenance" },
    ] });
    const input = persist(saved);
    if (variant.includes("owner")) input.step![0].id = "replacement-first-phase";
    if (variant.includes("duration"))
      input.step![0].component[0].timing!.repeat!.boundsDuration!.value = 2;
    return input;
  };

  const actionInput = (variant: string): FhirR6DosageInstruction => {
    const saved = toDosageDetails([{ sequence: 1, id: "dose", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: daily } }], undefined, {
      safety: { id: "course-policy", ifExceeded: "Call the clinic",
        doseLimit: [{ id: "course-cap", scope: "period", valueQuantity: q(8), period: { value: 1, unit: "d" } }],
        extension: [{ url: "urn:clinic:course-policy-note", valueString: "keep the course annotation" }] },
      step: [{ sequence: 1, id: "phase", safety: { id: "phase-policy", ifExceeded: "Hold the next dose",
        doseLimit: [{ id: "phase-cap", scope: "administration", valueQuantity: q(2) }],
        extension: [{ url: "urn:clinic:phase-policy-note", valueString: "keep the retired phase annotation" }] } }],
    });
    const input = persist(saved);
    if (variant !== "unchanged")
      input.safety!.doseLimit = input.safety!.doseLimit!.filter(limit => limit.id !== "phase-cap");
    if (variant === "new action") input.safety!.ifExceeded = "Contact the prescriber now";
    return input;
  };

  const referenceInput = (variant: string) => {
    const reference = { reference: "BodyStructure/left-eye", identifier: {
      type: { coding: [{ system: "urn:clinic:body-identifier", code: "eye",
        extension: [{ url: "urn:clinic:identifier-note", valueString: "original site identifier annotation" }] }] },
      system: "urn:clinic:body-site", value: "left-eye",
    } };
    const step: FhirR6DosageStep = { id: "historical-phase", component: [{
      id: "historical-dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      site: { concept: { text: "left eye" }, reference },
    }] };
    const rows: EzDosage[] = persist(toFhirR5Dosages({ step: [step] }));
    rows[0].modifierExtension = [
      ...(rows[0].modifierExtension ?? []).filter(item => item.url !== DOSAGE_DETAILS_R5_URL), historicalMarker(step),
    ];
    const supplied: NonNullable<EzDosage["siteReference"]> = persist(reference);
    if (variant.startsWith("version")) {
      supplied.identifier!.type!.coding![0].version = "2026-11";
      if (variant === "version and dose") supplied.identifier!.type!.coding![0]._version = { id: "current-version",
        extension: [{ url: "urn:clinic:version-note", valueString: "current identifier coding version" }] };
    }
    if (variant !== "omitted") rows[0].siteReference = variant === "clear" ? undefined : supplied;
    if (variant === "version and dose") rows[0].doseAndRate![0].doseQuantity!.value = 2;
    return { rows, reference, supplied };
  };

  const exclusionInput = (variant: string): EzDosage | FhirR6DosageInstructionInput => ({
    ...(variant === "R6 safety header" ? {} : { excludedDates: ["2026-12-25"] }),
    ...(variant === "date only" ? {} : { safety: { doseLimit: [{
      scope: "administration" as const, valueQuantity: q(2),
    }] } }),
  });

  const partialInput = (variant: string) => {
    const ratio: FhirRatio = { id: "authored-period-limit",
      numerator: { ...(variant === "missing amount" ? {} : { value: 1 }), unit: "tab",
        extension: [{ url: "urn:clinic:amount-note", valueString: "keep authored amount metadata" }] },
      denominator: { ...(variant === "missing period" ? {} : { value: 1 }), unit: "d",
        extension: [{ url: "urn:clinic:period-note", valueString: "keep authored period metadata" }] },
      extension: [{ url: "urn:clinic:ratio-note", valueString: "keep the incomplete Ratio" }],
    };
    const rows: EzDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      ...daily, frequency: 2, timeOfDay: ["08:00:00", "20:00:00"],
    } }, maxDosePerPeriod: [ratio] }];
    return { rows, ratio };
  };

  it.each(["unchanged", "owner", "duration", "owner and duration"] as const)(
    "propagates current completion independently of a prior phase owner (%s)", variant => {
      let wire = completionInput(variant);
      const changed = variant.includes("duration");
      for (let save = 0; save < 2; save++) {
        const before = persist(wire);
        expect(fromDosageDetails(wire).course.step!.map(step => step.id)).toEqual([
          variant.includes("owner") ? "replacement-first-phase" : "first-phase",
          "second-phase", ...(!changed ? ["pause"] : []), "maintenance",
        ]);
        expect(nextDueDoses(wire, options)).toEqual(dates(changed ? [1, 2, 3, 4] : [1, 2, 4]));
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: changed ? 7 : 6, unit: "tab" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
        expect(JSON.stringify(wire)).toContain("keep the authored pause boundary");
      }
    });

  it.each(["unchanged", "retired phase", "new action"] as const)(
    "keeps the course action separate from a removed phase limit (%s)", variant => {
      let wire = actionInput(variant);
      for (let save = 0; save < 2; save++) {
        const before = persist(wire), reopened = fromDosageDetails(wire);
        expect(reopened.course.safety?.ifExceeded)
          .toBe(variant === "new action" ? "Contact the prescriber now" : "Call the clinic");
        expect(reopened.course.safety?.doseLimit?.map(limit => limit.id)).toEqual(["course-cap"]);
        expect(reopened.course.step![0].safety?.doseLimit?.map(limit => limit.id))
          .toEqual(variant === "unchanged" ? ["phase-cap"] : undefined);
        expect(reopened.course.step![0].safety?.ifExceeded)
          .toBe(variant === "unchanged" ? "Hold the next dose" : undefined);
        expect(reopened.course.safety?.extension)
          .toContainEqual({ url: "urn:clinic:course-policy-note", valueString: "keep the course annotation" });
        expect(wire).toEqual(before);
        wire = toDosageDetails(reopened.dosages, undefined, reopened.course);
        expect(wire.safety?.ifExceeded).toBe(variant === "unchanged" ? "Call the clinic\nHold the next dose"
          : variant === "new action" ? "Contact the prescriber now" : "Call the clinic");
        expect(JSON.stringify(wire)).toContain("keep the retired phase annotation");
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    });

  it.each(["omitted", "unchanged", "version", "version and dose", "clear"] as const)(
    "retains the supplied historical site-reference Coding fields (%s)", variant => {
      const { rows, reference, supplied } = referenceInput(variant), before = persist(rows);
      let wire = toDosageDetails(rows);
      for (let save = 0; save < 2; save++) {
        const member = wire.step![0].component[0];
        expect(member.site?.reference).toEqual(variant === "clear" ? undefined : variant === "omitted" ? reference : supplied);
        expect(member.site?.concept).toEqual({ text: "left eye" });
        expect(member.doseAndRate![0].doseQuantity).toEqual(q(variant === "version and dose" ? 2 : 1));
        expect(member.timing?.repeat).toEqual(daily);
        expect(JSON.stringify(wire)).toContain("original site identifier annotation");
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
      expect(persist(rows)).toEqual(before);
      if (variant === "clear") expect(Object.prototype.hasOwnProperty.call(rows[0], "siteReference")).toBe(true);
    });

  it.each(["date only", "date and safety", "R6 safety header"] as const)(
    "distinguishes partial R5 exclusions from a genuine R6 safety header (%s)", variant => {
      const input = exclusionInput(variant), before = persist(input);
      const native = importCanonicalCourse(input);
      for (const style of ["short", "long"] as const) {
        const text = formatSig(input, style, { locale: "en" });
        if (variant === "R6 safety header") {
          expect(text).toBe("Across this course: max per administration: 2 tab");
          expect(native.stages).toEqual([]);
          expect(native.safety?.limits?.[0].amount).toEqual(q(2));
        } else {
          expect(text).toContain("except 2026-12-25");
          expect(native.stages[0].administrations[0].excludedDates).toEqual(["2026-12-25"]);
          if (variant === "date and safety") expect(text).toContain("max per administration: 2 tab");
        }
      }
      expect(input).toEqual(before);
    });

  it.each(["missing amount", "missing period", "complete"] as const)(
    "lifts an authored editable period Ratio without inventing or duplicating a value (%s)", variant => {
      const { rows, ratio } = partialInput(variant), before = persist(rows);
      const lifted = toEzDosages(rows);
      expect(lifted[0].maxDosePerPeriod).toEqual([ratio]);
      expect(lifted[0].safety?.doseLimit).toEqual([{
        id: ratio.id, extension: ratio.extension, scope: "period",
        valueQuantity: ratio.numerator, period: ratio.denominator,
      }]);
      expect(rows).toEqual(before);
      let wire = toDosageDetails(lifted);
      for (let save = 0; save < 2; save++) {
        const exported = toFhirR5Dosages(wire);
        expect(exported[0].maxDosePerPeriod).toEqual([ratio]);
        expect(toEzDosages(persist(exported))[0].safety?.doseLimit).toHaveLength(1);
        expect(calculateTotalUnits({ dosage: wire, ...options, durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: variant === "complete" ? 2 : 4, unit: "tab" });
        wire = toDosageDetails(persist(exported));
      }
    });
});
}
