import { describe, expect, it } from "vitest";
import { AdviceArgumentRole, AdvicePolarity } from "../src/types";
import { calculateTotalUnits, formatSig, lintSig, nextDueDoses, parseStrengthComponents, getDosageCondition, getDosageExcludedDates, getDosageExcludedWeekdays, toDosageDetails, toFhirR5Dosages, evaluateMedicationCondition, RouteCode } from "../src";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";
import { parseMedicationGuard } from "../src/medication-condition";
import { createBoundaryPlan } from "../src/regimen/planner";
import { getDosageAlternativeChoice, setDosageAlternativeChoice, DOSAGE_ALTERNATIVE_CHOICE_URL, fromFhir } from "../src";

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
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
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
    expect(parsed.fhir.timing?.repeat).toMatchObject({ count: 1, countMax: 3 });
    expect(parsed.warnings.some(warning => warning.startsWith("Unresolved schedule"))).toBe(false);
  });

  it("treats 'up to 3 doses' as a total administration cap without absorbing the PRN reason", () => {
    const parsed = parseSig("1 tab SL q5min PRN chest pain up to 3 doses");
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      count: 1,
      countMax: 3,
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

  it("exports daily dose maximum and FHIR R5 PRN without serializing legacy asNeeded", () => {
    const result = parseSig("1 tab q6h prn fever max 4 tablets/day");
    expect(result.fhir.maxDosePerPeriod).toEqual([{
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
    ["1 mL daily max. 7 mL/24hrs", undefined, 7, "mL", "d"],
    ["รับประทาน 1 เม็ด วันละ 2 ครั้ง ไม่เกิน วันละ 4 เม็ด", "th", 4, "tab", "d"]
  ] as const)("types a periodic dose maximum before the single FHIR projection: %s",
    (source, locale, amount, unit, periodUnit) => {
      const parsed = parseSig(source, locale ? { locale } : undefined);
      expect(parsed.meta.canonical.clauses[0]?.schedule?.maxDosePerPeriod).toEqual([{
        amount, unit, period: 1, periodUnit
      }]);
      expect(parsed.fhir.maxDosePerPeriod).toEqual([{
        numerator: { value: amount, unit },
        denominator: {
          value: 1, unit: periodUnit,
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
    expect(parsed.fhir.timing?.repeat).toMatchObject({ count: 1, countMax: 3 });
    expect(parsed.meta.canonical.clauses[0]?.site?.text).toBe(site);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each(["at most", "up to", "max", "maximum"])(
    "preserves the typed %s count cap after a PRN reason without absorbing either constituent",
    lead => {
      const parsed = parseSig(`1 tab q4h prn pain ${lead} three times`);
      expect(parsed.fhir.asNeeded).toBe(true);
      expect(parsed.fhir.asNeededFor?.[0]?.text).toBe("pain");
      expect(parsed.fhir.timing?.repeat).toMatchObject({
        count: 1,
        countMax: 3,
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
    expect(total.fhir.timing?.repeat).toMatchObject({ count: 1, countMax: 3 });
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
