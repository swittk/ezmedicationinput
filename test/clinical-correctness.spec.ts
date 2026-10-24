import { describe, expect, it } from "vitest";
import { AdviceArgumentRole, AdvicePolarity } from "../src/types";
import { calculateTotalUnits, formatSig, lintSig, nextDueDoses, parseStrengthComponents, getDosageCondition, getDosageExcludedDates, getDosageExcludedWeekdays, toDosageDetails, toFhirR5Dosages, evaluateMedicationCondition, RouteCode } from "../src";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";
import { parseMedicationGuard } from "../src/medication-condition";
import { createBoundaryPlan } from "../src/regimen/planner";
import { getDosageAlternativeChoice, setDosageAlternativeChoice, DOSAGE_ALTERNATIVE_CHOICE_URL, fromFhir, fromFhirDosage, parseSig as parseBatch } from "../src";

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
        expect(rows.map(row => dose(row))).toEqual([
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
        expect(dose(rows[0])).toEqual({ value: 1, unit: "drop" });
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
        expect(dose(rows[0])).toEqual({ value: 1, unit: "tab" });
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
        expect(dose(right!)).toEqual({ value: 1, unit: "drop" });
        expect(dose(left!)).toEqual({ value: 1, unit: "drop" });
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
      expect(rows.map(row => dose(row))).toEqual([
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
        expect(rows.map(row => dose(row))).toEqual([
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
        .toEqual([{ value: 5, unit: "U" }, { value: 8, unit: "U" }]);
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
      expect.objectContaining({ url: expect.stringContaining("/medication-timing-event-window") })
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
      part.url.endsWith("/medication-timing-event-window")
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
        url: expect.stringContaining("/medication-timing-event-window")
      }));
    expect(parsed.fhirNext.step[1]?.component[0]?.timing?.repeat).toMatchObject({
      frequency: 4, period: 1, periodUnit: "d"
    });
    expect(parsed.fhirNext.step[1]?.component[0]?.timing?.repeat?.extension
      ?.some(item => item.url.endsWith("/medication-timing-event-window")))
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
