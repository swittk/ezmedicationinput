import { describe, expect, it } from "vitest";
import {
  nextDueDoses, parseSig, toDosageDetails, toFhirR5Dosages,
} from "../src/index";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { formatZonedIso } from "../src/execution/calendar";
import type { FhirDosage } from "../src/types";

describe("rate heads shared with inclusive quantity comparators", () => {
  it.each([
    ["at most", "<="], ["at least", ">="],
    ["at approximately", "~"], ["at no more than", "<="],
    ["at", undefined], ["@", undefined],
  ] as const)("preserves the dimensional rate licensed by '%s'", (lead, comparator) => {
    for (const unit of ["mL/hr", "mL / hr", "mL per hour"]) {
      const input = `IV ${lead} 100 ${unit}`;
      const parsed = parseSig(input);
      const dose = parsed.fhirNext.step[0].component[0].doseAndRate![0];
      expect(dose.rateQuantity, input).toMatchObject({ value: 100, unit: "mL/h" });
      expect(getQuantityComparator(dose.rateQuantity), input).toBe(comparator);
      expect(dose.rateQuantity).not.toHaveProperty("comparator");
      expect(dose.doseQuantity, input).toBeUndefined();
      expect(parsed.input).toBe(input);
      expect(parsed.meta.leftoverText, input).toBeUndefined();
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext))));
      const recovered = reopened.step[0].component[0].doseAndRate![0];
      expect(recovered.rateQuantity, input).toEqual(dose.rateQuantity);
      expect(recovered.doseQuantity, input).toBeUndefined();
    }
  });

  it.each([
    ["IV at most 0.5mg/min", "<="],
    ["IV at least 0.5 mg / min", ">="],
    ["Infuse at most 0.5 mg per minute", "<="],
  ] as const)("keeps amount and per-time units together in %s", (input, comparator) => {
    const dose = parseSig(input).fhirNext.step[0].component[0].doseAndRate![0];
    expect(dose.rateQuantity).toMatchObject({ value: 0.5, unit: "mg/min" });
    expect(getQuantityComparator(dose.rateQuantity)).toBe(comparator);
    expect(dose.doseQuantity).toBeUndefined();
  });

  it("retains scalar comparators and requires a rate head for unmarked rates", () => {
    const scalar = parseSig("Take at most 2 tablets daily").fhirNext.step[0].component[0].doseAndRate![0];
    expect(scalar.doseQuantity).toMatchObject({ value: 2, unit: "tab" });
    expect(getQuantityComparator(scalar.doseQuantity)).toBe("<=");
    expect(scalar.rateQuantity).toBeUndefined();
    const unmarked = parseSig("100 mL/hr");
    for (const amount of unmarked.fhirNext.step[0]?.component[0]?.doseAndRate ?? []) {
      expect(amount.doseQuantity).toBeUndefined();
      expect(amount.rateQuantity).toBeUndefined();
    }
    expect(unmarked.input).toBe("100 mL/hr");
    const qualifiedTablet = parseSig("at most 2 tablets daily").fhirNext.step[0].component[0].doseAndRate![0];
    expect(qualifiedTablet.doseQuantity?.value).toBe(2);
    expect(qualifiedTablet.rateQuantity).toBeUndefined();
  });
});

describe("execution timestamps retain the accepted instant", () => {
  it.each([
    ["2026-11-02T12:00:00.500Z", "UTC", "2026-11-02T12:00:00.500+00:00"],
    ["2026-11-02T12:00:00.001Z", "Asia/Bangkok", "2026-11-02T19:00:00.001+07:00"],
    ["2026-11-02T12:00:00.050Z", "Asia/Kathmandu", "2026-11-02T17:45:00.050+05:45"],
    ["2026-11-01T05:59:59.999Z", "America/New_York", "2026-11-01T01:59:59.999-04:00"],
    ["2026-11-01T06:00:00.001Z", "America/New_York", "2026-11-01T01:00:00.001-05:00"],
  ])("preserves explicit event %s in %s", (instant, timeZone, expected) => {
    const dosage: FhirDosage = {
      timing: { event: [instant] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    };
    const due = nextDueDoses(dosage, { from: instant, orderedAt: instant, timeZone, limit: 1 });
    expect(due).toEqual([expected]);
    expect(Date.parse(due[0])).toBe(Date.parse(instant));
  });

  it("keeps whole-second output stable and formats pre-epoch fractions correctly", () => {
    expect(formatZonedIso(new Date("2026-11-02T12:00:00Z"), "UTC"))
      .toBe("2026-11-02T12:00:00+00:00");
    expect(formatZonedIso(new Date("1969-12-31T23:59:59.500Z"), "UTC"))
      .toBe("1969-12-31T23:59:59.500+00:00");
  });
});
