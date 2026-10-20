import { describe, expect, it } from "vitest";
import { formatSig, lintSig, nextDueDoses, parseStrengthComponents, getDosageCondition, getDosageExcludedDates, toDosageDetails, toFhirR5Dosages, evaluateMedicationCondition } from "../src";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";

describe("clinical SIG correctness and boundary promotion", () => {
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

  it("rejects an unknown exception rather than silently scheduling daily administration", () => {
    const result = parseSig("1 tab daily except public holidays");
    expect(result.fhir.timing).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.stringContaining("unresolved-calendar-exclusion"));
    expect(result.fhir.text).toContain("except public holidays");
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

  it("refuses a daily weight-based total with no per-dose schedule", () => {
    const result = parseSig("10 mg/kg/day");
    expect(result.fhir.doseAndRate).toBeUndefined();
    expect(result.fhir.timing).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.stringContaining("incomplete-weight-based-dose"));
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
    expect(() => nextDueDoses(r5, {
      from: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok"
    })).toThrow("orderedAt");
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

  it("refuses to schedule and preserves the original text when an exclusion is unknown", () => {
    const parsed = parseSig("1 tab daily except public holidays");
    expect(formatSig(parsed.fhir)).toBe(parsed.input);
    expect(() => nextDueDoses(parsed, {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok"
    })).toThrow("unresolved");
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
    expect(() => nextDueDoses(bp.dosageDetails!, options)).toThrow("evaluateCondition");
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

  it("round trips advanced R6-only metadata in R5 without falsely scheduling it", () => {
    const course = parseSig("1 tab daily").dosageDetails!;
    const enriched = { ...course, repeatCycle: { value: 28, unit: "d" } };
    const flattened = toFhirR5Dosages(enriched);
    expect(toDosageDetails(flattened)).toEqual(enriched);
    expect(() => nextDueDoses(flattened, {
      from: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok"
    })).toThrow("R6-aware scheduler");
  });
});
