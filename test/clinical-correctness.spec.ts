import { describe, expect, it } from "vitest";
import { AdviceArgumentRole, AdvicePolarity } from "../src/types";
import { calculateTotalUnits, formatSig, lintSig, nextDueDoses, parseStrengthComponents, getDosageCondition, getDosageExcludedDates, toDosageDetails, toFhirR5Dosages, evaluateMedicationCondition, RouteCode } from "../src";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";
import { parseMedicationGuard } from "../src/medication-condition";

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
