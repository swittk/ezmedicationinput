import { describe, expect, it } from "vitest";
import {
  parseSig, parseSigAsync, suggestSig, nextDueDoses, calculateTotalUnits,
  MedicationQuantityCalculationError,
  toFhirR5Dosages, fromFhir, type FhirPeriodUnit
} from "../src";

const begin = "2026-10-19T08:00:00+07:00";
const base = {
  from: begin,
  orderedAt: begin,
  durationValue: 30,
  durationUnit: "d" as FhirPeriodUnit,
  timeZone: "Asia/Bangkok"
};
const eyeCourse = "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid";
function allFormats(text: string) {
  const parsed = parseSig(text);
  return [parsed, parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)];
}

describe("whole-course numeric supply and API parity", () => {
  it("calculates single-site, sequential and parallel tapers exactly", () => {
    const cases = [
      ["1 drop OD QID x7d", 28],
      ["1 drop OD QID x7d then BID x7d", 42],
      [eyeCourse, 296]
    ] as const;
    for (const [sig, count] of cases) {
      for (const dosage of allFormats(sig)) {
        const total = calculateTotalUnits({ ...base, dosage });
        expect(total.totalUnits).toBe(count);
      }
    }
  });

  it("rounds whole-course supply before counting containers, just like a single dosage", () => {
    const dosage = parseSig("1 tab po daily").fhir[0];
    const options = {
      ...base, roundToMultiple: 14,
      context: { dosageForm: "tablet", containerValue: 10, containerUnit: "tab" }
    };
    const single = calculateTotalUnits({ ...options, dosage });
    const course = calculateTotalUnits({ ...options, dosage: [dosage] });
    expect(single.totalUnits).toBe(42);
    expect(course.totalUnits).toBe(single.totalUnits);
    expect(course.totalContainers).toBe(single.totalContainers);
    expect(course.totalContainerQuantity).toEqual(single.totalContainerQuantity);
  });

  it("keeps fractional package quantity separate from physical containers", () => {
    const dosage = parseSig("apply half bottle once daily").fhir[0];
    const options = {
      ...base, durationValue: 1,
      context: { packageUnit: "bottle", containerValue: 120, containerUnit: "mL" }
    };
    const single = calculateTotalUnits({ ...options, dosage });
    const course = calculateTotalUnits({ ...options, dosage: [dosage] });
    expect(single.totalUnits).toBe(0.5);
    expect(single.totalContainers).toBe(1);
    expect(single.totalContainerQuantity).toEqual({ value: 60, unit: "mL" });
    expect(course.totalUnits).toBe(single.totalUnits);
    expect(course.totalContainers).toBe(single.totalContainers);
    expect(course.totalContainerQuantity).toEqual(single.totalContainerQuantity);
  });

  it("rounds eye-drop volume and ingredient mass before counting bottles", () => {
    const sig = "1 drop OD qid";
    const parsed = parseSig(sig);
    const options = {
      ...base, roundToMultiple: 300,
      context: {
        dosageForm: "eye drops", strength: "500 mcg / 100 mL",
        containerValue: 5, containerUnit: "mL"
      }
    };
    const single = calculateTotalUnits({ ...options, dosage: parsed.fhir[0] });
    expect(single.totalUnits).toBe(300);
    expect(single.totalApproximateQuantity).toMatchObject({ value: 15, unit: "mL" });
    expect(single.totalApproximateIngredientQuantity).toMatchObject({
      value: 75, unit: "mcg"
    });
    expect(single.totalContainers).toBe(3);
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      const result = calculateTotalUnits({ ...options, dosage });
      expect(result.totalUnits).toBe(single.totalUnits);
      expect(result.totalApproximateQuantity).toEqual(single.totalApproximateQuantity);
      expect(result.totalApproximateIngredientQuantity)
        .toEqual(single.totalApproximateIngredientQuantity);
      expect(result.totalContainerQuantity).toEqual(single.totalContainerQuantity);
      expect(result.totalContainers).toBe(single.totalContainers);
    }
  });

  it("rounds a combined parallel course once, including estimated volume", () => {
    const parsed = parseSig("1 drop OD qid; 1 drop OS qid");
    const options = {
      ...base, roundToMultiple: 500,
      context: { dosageForm: "eye drops", containerValue: 5, containerUnit: "mL" }
    };
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      const result = calculateTotalUnits({ ...options, dosage });
      expect(result.totalUnits).toBe(500);
      expect(result.totalApproximateQuantity).toMatchObject({
        value: 25, unit: "mL"
      });
      expect(result.totalContainers).toBe(5);
      expect(result.totalContainerQuantity).toMatchObject({
        value: 25, unit: "mL"
      });
    }
  });

  it("sums 30-day and 45-day site-specific transitions, never multiplying all phases by the full horizon", () => {
    const parsed = parseSig(eyeCourse);
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 45 }).totalUnits)
        .toBe(388);
    }
    const days = nextDueDoses(parsed, {
      from: begin, orderedAt: begin, timeZone: "Asia/Bangkok", limit: 1000
    }).filter(time => Date.parse(time) < Date.parse("2026-11-18T08:00:00+07:00"));
    expect(days).toHaveLength(296);
  });

  it("calculates the true number of bottles from the combined eye course, without per-stage rounding", () => {
    const parsed = parseSig(eyeCourse);
    const context = { dosageForm: "eye drop", containerValue: 5, containerUnit: "mL" };
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      const total = calculateTotalUnits({ ...base, dosage, context });
      expect(total).toMatchObject({
        totalUnits: 296, unit: "drop", totalContainers: 3,
        totalApproximateQuantity: { value: 14.8, unit: "mL" }
      });
    }
  });

  it("calculates exact alternate-day and specific excluded-date supplies", () => {
    for (const [sig, n] of [
      ["1 tab daily except Mondays and Wednesdays", 10],
      ["1 tab daily except 20/10/2026 and 22/10/2026", 12]
    ] as const) {
      for (const dosage of allFormats(sig)) {
        expect(calculateTotalUnits({ ...base, dosage, durationValue: 14 }).totalUnits)
          .toBe(n);
      }
    }
  });

  it("returns an explicit maximum-supply explanation for PRN, rather than a silent approximation", () => {
    for (const dosage of allFormats("2 tabs Q4H PRN pain max 4 tablets/day")) {
      const result = calculateTotalUnits({ ...base, dosage, durationValue: 7 });
      expect(result).toMatchObject({
        totalUnits: 28, unit: "tab", quantityKind: "maximum"
      });
      expect(result.explanation).toMatch(/PRN.*may be used less frequently/);
    }
  });

  it("returns a numerical conditional maximum without measurements and an exact zero when observations reject all doses", () => {
    for (const dosage of allFormats("1 tab PO BID only if BP >160, otherwise hold")) {
      const maximum = calculateTotalUnits({ ...base, dosage, durationValue: 7 });
      expect(maximum).toMatchObject({ totalUnits: 14, quantityKind: "maximum" });
      expect(maximum.explanation).toContain("evaluateCondition");
      const noDoses = calculateTotalUnits({
        ...base, dosage, durationValue: 7, evaluateCondition: () => false
      });
      expect(noDoses.totalUnits).toBe(0);
    }
  });

  it("computes a concrete per-kg administered quantity once patient weight is supplied", () => {
    for (const dosage of allFormats("0.5 mg/kg PO BID")) {
      const result = calculateTotalUnits({
        ...base, dosage, durationValue: 7, patientWeightKg: 65
      });
      expect(result.totalUnits).toBe(455);
      expect(result.unit).toBe("mg");
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 7 }))
        .toMatchObject({ totalUnits: 7, unit: "mg/kg", quantityKind: "scheduled" });
    }
  });

  it("computes infusion volume from rate times infusion duration instead of treating a rate as a dose", () => {
    for (const dosage of allFormats("Infuse IV at 2 mL/h for 12 hours")) {
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 7 }))
        .toMatchObject({ totalUnits: 24, unit: "mL" });
    }
  });

  it("computes recognized per-kg infusion rates using duration and weight, never as a bolus", () => {
    const instruction = "Infuse dopamine at 5 mcg/kg/min IV for 4 hours";
    for (const dosage of allFormats(instruction)) {
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 1 }))
        .toMatchObject({ totalUnits: 1200, unit: "ug/kg", quantityKind: "scheduled" });
      const measured = calculateTotalUnits({
        ...base, dosage, durationValue: 1, patientWeightKg: 70
      });
      expect(measured.totalUnits).toBe(84000);
      expect(measured.unit).toBe("ug");
    }
  });

  it("keeps the schedule visible when a period maximum conflicts, and labels supply as best-effort", () => {
    const valid = parseSig("2 tablets BID").fhir[0];
    const capped = {
      ...valid,
      maxDosePerPeriod: [{
        numerator: { value: 1, unit: "tab" },
        denominator: { value: 1, unit: "d", code: "d" }
      }]
    };
    const opts = { from: begin, orderedAt: begin, timeZone: "Asia/Bangkok", limit: 10 };
    for (const dosage of [capped, [capped]]) {
      expect(nextDueDoses(dosage, opts)).toHaveLength(10);
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 3 }))
        .toMatchObject({ totalUnits: 12, quantityKind: "maximum" });
    }
    const acceptable = {
      ...capped,
      maxDosePerPeriod: [{
        numerator: { value: 2, unit: "tab" },
        denominator: { value: 1, unit: "d", code: "d" }
      }]
    };
    expect(nextDueDoses(acceptable, { ...opts, limit: 3 })).toHaveLength(3);
    expect(calculateTotalUnits({ ...base, dosage: acceptable, durationValue: 3 }).totalUnits)
      .toBe(6);
  });

  it("accepts all four representations after a FHIR R6 JSON import", () => {
    const p = parseSig(eyeCourse);
    const imported = fromFhir(JSON.parse(JSON.stringify(p.fhirNext)));
    expect(calculateTotalUnits({ ...base, dosage: imported }).totalUnits).toBe(296);
    expect(calculateTotalUnits({ ...base, dosage: imported.fhir }).totalUnits).toBe(296);
  });

  it("requires only facts that are mathematically necessary, while keeping resolvable courses usable", () => {
    const weightBased = parseSig("0.5 mg/kg PO BID");
    expect(calculateTotalUnits({ ...base, dosage: weightBased }))
      .toMatchObject({ totalUnits: 30, unit: "mg/kg", quantityKind: "scheduled" });

    const relative = parseSig(eyeCourse);
    const withoutStart = { ...base, dosage: relative };
    delete (withoutStart as Partial<typeof withoutStart>).orderedAt;
    expect(calculateTotalUnits(withoutStart)).toMatchObject({
      totalUnits: 296,
      unit: "drop",
      quantityKind: "scheduled",
      explanation: expect.stringContaining("assumed")
    });

    const overlappingText = parseSig(
      "1 drop OD q2h x4wk then qid; 1 drop OS qid x1mo then bid"
    );
    expect(calculateTotalUnits({ ...base, dosage: overlappingText }).totalUnits).toBeGreaterThan(0);

    const missingPhaseBound = parseSig("1 tab QID then BID");
    expect(calculateTotalUnits({ ...base, dosage: missingPhaseBound })).toMatchObject({
      totalUnits: 120,
      unit: "tab",
      quantityKind: "scheduled",
      explanation: expect.stringContaining("without a stated cutover")
    });
  });

  it("keeps sync, async, suggestions and schedule consumers aligned on the same dosage meaning", async () => {
    const sync = parseSig(eyeCourse);
    const asyncValue = await parseSigAsync(eyeCourse);
    expect(asyncValue.fhir).toEqual(sync.fhir);
    expect(asyncValue.fhirNext).toEqual(sync.fhirNext);
    const suggestions = suggestSig("1 drop od q", { limit: 10 });
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions.slice(0, 5)) {
      expect(typeof suggestion).toBe("string");
      expect(suggestion.length).toBeGreaterThan(0);
    }
    const dueOpts = {
      from: begin, orderedAt: begin, timeZone: "Asia/Bangkok", limit: 12
    };
    const expected = nextDueDoses(sync, dueOpts);
    expect(nextDueDoses(sync.fhir, dueOpts)).toEqual(expected);
    expect(nextDueDoses(sync.fhirNext, dueOpts)).toEqual(expected);
    expect(calculateTotalUnits({ ...base, dosage: asyncValue }).totalUnits)
      .toBe(296);
  });
});
