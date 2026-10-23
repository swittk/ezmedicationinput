import { describe, expect, it } from "vitest";
import { parseSig, nextDueDoses, calculateTotalUnits, toFhirR5Dosages, fromFhir } from "../src";
import type { FhirR6DosageDetails } from "../src";

const base = {
  orderedAt: "2026-10-19T08:00:00+07:00",
  from: "2026-10-19T08:00:00+07:00",
  timeZone: "Asia/Bangkok",
  limit: 8
} as const;

const shapes = (source: string) => {
  const parsed = parseSig(source);
  return [
    parsed, parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)
  ];
};

describe("dose scheduling runtime guarantees", () => {
  it("does not report zero supply for an empty regimen", () => {
    expect(() => calculateTotalUnits({
      dosage: [],
      from: base.from,
      orderedAt: base.orderedAt,
      timeZone: base.timeZone,
      durationValue: 1,
      durationUnit: "d"
    })).toThrow(/medication dosage or complete treatment course/i);
  });
  it("does not recursively overflow on calendar exclusions in the flat native result", () => {
    const expected = [
      "2026-10-19T09:00:00+07:00",
      "2026-10-21T09:00:00+07:00",
      "2026-10-23T09:00:00+07:00"
    ];
    for (const input of shapes("1 tab daily except 20/10/2026 and 22/10/2026")) {
      expect(nextDueDoses(input, { ...base, limit: 3 })).toEqual(expected);
    }
  });

  it("enforces normal maximum quantities instead of refusing safely computable prescriptions", () => {
    const expected = [
      "2026-10-19T08:00:00+07:00",
      "2026-10-19T12:00:00+07:00",
      "2026-10-20T08:00:00+07:00",
      "2026-10-20T12:00:00+07:00",
      "2026-10-21T08:00:00+07:00",
      "2026-10-21T12:00:00+07:00"
    ];
    for (const input of shapes("2 tabs Q4H PRN pain max 4 tablets/day")) {
      expect(nextDueDoses(input, { ...base, limit: 6 })).toEqual(expected);
    }
  });

  it("does not reset a 24-hour maximum at midnight", () => {
    const inputs = shapes("2 tabs Q4H PRN pain max 4 tablets/day");
    for (const input of inputs) {
      expect(nextDueDoses(input, {
        ...base, from: "2026-10-19T20:00:00+07:00", limit: 2,
        priorDoseTimes: [
          "2026-10-19T08:00:00+07:00",
          "2026-10-19T12:00:00+07:00"
        ]
      })).toEqual([
        "2026-10-20T08:00:00+07:00",
        "2026-10-20T12:00:00+07:00"
      ]);
    }
  });

  it("excludes non-administered conditional doses before applying quantity maxima", () => {
    const dose = parseSig("2 tabs Q4H PRN pain max 4 tablets/day").fhir[0];
    dose.condition = [{
      code: { text: "Eligible" }, text: "Eligible"
    }];
    expect(nextDueDoses(dose, {
      ...base, limit: 4,
      evaluateCondition: (_condition, at) => !at.includes("T08:00:00")
    })).toEqual([
      "2026-10-19T12:00:00+07:00",
      "2026-10-19T16:00:00+07:00",
      "2026-10-20T12:00:00+07:00",
      "2026-10-20T16:00:00+07:00"
    ]);
  });

  it("applies the same conditions from the strict R5 representation", () => {
    const input = "1 tab PO BID only if BP >160, otherwise hold";
    const parsed = parseSig(input);
    const cases = [
      parsed, parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)
    ];
    for (const value of cases) {
      expect(nextDueDoses(value, {
        ...base, limit: 3, evaluateCondition: () => false
      })).toEqual([]);
      expect(nextDueDoses(value, {
        ...base, limit: 2, evaluateCondition: () => true
      })).toEqual([
        "2026-10-19T08:00:00+07:00",
        "2026-10-19T20:00:00+07:00"
      ]);
    }
  });

  it("allows body-site references and dose expressions to carry actual schedule times", () => {
    const details: FhirR6DosageDetails = {
      step: [{ component: [{
        site: { reference: { reference: "BodyStructure/example" } },
        doseAndRate: [{
          doseExpression: {
            language: "text/fhirpath",
            expression: "%patient.weight * 0.5"
          }
        }],
        timing: {
          repeat: { frequency: 2, period: 1, periodUnit: "d" }
        }
      }] }]
    };
    const imported = fromFhir(details);
    for (const input of [
      details, imported.fhir, toFhirR5Dosages(details)
    ]) {
      expect(nextDueDoses(input, { ...base, limit: 2 })).toEqual([
        "2026-10-19T08:00:00+07:00",
        "2026-10-19T20:00:00+07:00"
      ]);
    }
  });

  it("schedules a future-dated one-time administration once and agrees with supply", () => {
    const dosage = parseSig("1 tab once").fhir[0];
    dosage.timing!.repeat!.boundsPeriod = { start: "2026-10-25" };
    const options = {
      ...base,
      from: "2026-10-21T08:00:00+07:00",
      orderedAt: "2026-10-21T08:00:00+07:00",
      limit: 4
    };
    const expected = ["2026-10-25T00:00:00+07:00"];
    for (const input of [dosage, [dosage], toFhirR5Dosages({
      step: [{ component: [dosage] }]
    })]) {
      expect(nextDueDoses(input, options)).toEqual(expected);
      expect(nextDueDoses(input, {
        ...options, from: "2026-10-26T08:00:00+07:00"
      })).toEqual([]);
    }
    // Even without orderedAt, the explicit single-dose bound remains the
    // historical anchor, rather than moving whenever the query starts.
    expect(nextDueDoses(dosage, { ...options, orderedAt: undefined }))
      .toEqual(expected);
    expect(nextDueDoses(dosage, {
      ...options, orderedAt: undefined, from: "2026-10-26T08:00:00+07:00"
    })).toEqual([]);
  });

  it("uses calendar-day horizons across daylight-saving transitions", () => {
    const dosage = parseSig("1 tab daily at 08:00").fhir[0];
    expect(calculateTotalUnits({
      dosage,
      from: "2024-03-09T08:00:00-05:00",
      orderedAt: "2024-03-09T08:00:00-05:00",
      timeZone: "America/New_York",
      durationValue: 2,
      durationUnit: "d"
    })).toMatchObject({ totalUnits: 2, unit: "tab" });
  });

  it("keeps ordinary schedule opportunities visible when maxima need extra clinical context", () => {
    const source = parseSig("1 tab PO BID").fhir[0];
    const period = {
      ...source,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      maxDosePerPeriod: [{
        numerator: { value: 20, unit: "mg" },
        denominator: { value: 1, unit: "d" }
      }]
    };
    expect(nextDueDoses(period, base)).toHaveLength(base.limit);
    expect(calculateTotalUnits({
      dosage: period, from: base.from, orderedAt: base.orderedAt,
      timeZone: base.timeZone, durationValue: 3, durationUnit: "d"
    })).toMatchObject({ quantityKind: "maximum", totalUnits: 6 });

    const lifetime = { ...source, maxDosePerLifetime: { value: 4, unit: "tab" } };
    expect(nextDueDoses(lifetime, base)).toHaveLength(base.limit);
    expect(calculateTotalUnits({
      dosage: lifetime, from: base.from, orderedAt: base.orderedAt,
      timeZone: base.timeZone, durationValue: 3, durationUnit: "d"
    })).toMatchObject({ quantityKind: "maximum", totalUnits: 4 });

    const perAdministration = {
      ...source, maxDosePerAdministration: { value: 0.5, unit: "tab" }
    };
    expect(nextDueDoses(perAdministration, base)).toHaveLength(base.limit);
    expect(calculateTotalUnits({
      dosage: perAdministration, from: base.from, orderedAt: base.orderedAt,
      timeZone: base.timeZone, durationValue: 3, durationUnit: "d"
    })).toMatchObject({
      totalUnits: 6,
      unit: "tab",
      quantityKind: "maximum",
      explanation: expect.stringContaining("unevaluable maximum-dose constraint")
    });
  });
});
