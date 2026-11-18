import { describe, expect, it } from "vitest";
import { formatSig, nextDueDoses, calculateTotalUnits } from "../src/index";
import { courseFromR6, courseToR5, courseToR6 } from "../src/adapters/canonical-course";
import { clauseForAdministration, courseFromAdministrations } from "../src/canonical/compile";
import { FhirPeriodUnit, type FhirR6DosageInstruction } from "../src/types";
import type { CanonicalAdministration, CanonicalCourse, CanonicalScheduleInput } from "../src/canonical/course";

const asCourse = (input: CanonicalScheduleInput): CanonicalCourse => {
  if ("kind" in input) return input.kind === "course"
    ? input : { kind: "course", stages: [{ administrations: [input] }] };
  return { kind: "course", stages: [{ administrations: [...input] }] };
};
const member = (input: CanonicalScheduleInput) => asCourse(input).stages[0].administrations[0];

describe("compiled clinical facts and source units survive projection", () => {

  it("keeps seven days of dosing after a shared two-day stage delay", () => {
    const dose = (value: number): CanonicalAdministration => ({ kind: "administration",
      delayMinutes: 2 * 1440, amounts: [{ quantity: { value, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        courseLength: { value: 7, unit: "d" } } } });
    const after = courseFromAdministrations([dose(1), dose(2)], "");
    expect(after.stages[0].start!.displacement).toMatchObject({ value: 2, unit: "d" });
    expect(after.stages[0].end).toBeUndefined();
    const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z",
      timeZone: "UTC", durationValue: 14, durationUnit: FhirPeriodUnit.Day };
    for (const input of [after, courseToR6(after), courseToR5(after)]) {
      const supply = "kind" in input
        ? calculateTotalUnits({ ...options, dosage: input })
        : calculateTotalUnits({ ...options, dosage: input });
      expect(supply.totalUnits).toBe(21);
      const due = nextDueDoses(input, { ...options, limit: 20 });
      expect(due).toHaveLength(14);
      expect(due[0]).toContain("2026-01-03");
      expect(due[13]).toContain("2026-01-09");
    }
  });

  it("retains the derived unshifted stage end and avoids one for a qualified duration", () => {
    const dose = (): CanonicalAdministration => ({ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        courseLength: { value: 7, unit: "d" } } } });
    const first = dose(), second = dose();
    expect(courseFromAdministrations([first, second], "").stages[0].end!.displacement).toMatchObject({ value: 7, unit: "d" });
    first.schedule!.recurrence!.courseLength!.comparator = "~";
    second.schedule!.recurrence!.courseLength!.comparator = "~";
    expect(courseFromAdministrations([first, second], "").stages[0].end).toBeUndefined();
  });

  it.each([
    [{ value: 500, system: "http://unitsofmeasure.org", code: "mg" }, "mg", "500 mg"],
    [{ value: 2, system: "http://standardterms.edqm.eu", code: "15054000" }, "tab", "2 tablets"],
    [{ value: 1, system: "urn:test:units", code: "custom-unit" }, "custom-unit", "custom-unit"],
  ] as const)("retains a code-only scalar dose unit in generated wording", (quantity, expectedUnit, wording) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: quantity }] }] }] };
    const course = courseFromR6(raw, true);
    expect(clauseForAdministration(member(course)).dose!.unit).toBe(expectedUnit);
    expect(formatSig(course, "long", { locale: "en" })).toContain(wording);
    expect(courseToR6(course).step[0].component[0].doseAndRate![0].doseQuantity).toEqual(quantity);
  });

  it.each(["coded", "authored"] as const)("preserves independent %s units on a mixed-unit dose range", kind => {
    const range = kind === "coded" ? {
      low: { value: 500, system: "http://unitsofmeasure.org", code: "mg" },
      high: { value: 1, system: "http://unitsofmeasure.org", code: "g" },
    } : { low: { value: 500, unit: "mg" }, high: { value: 1, unit: "g" } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange: range }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    const course = courseFromR6(raw, true);
    const rendered = formatSig(course, "long", { locale: "en" });
    expect(rendered).toContain("500 mg – 1 g");
    expect(rendered).not.toMatch(/500[–-]1 mg/);
    expect(rendered).toContain("once daily");
    expect(courseToR6(course).step[0].component[0].doseAndRate![0].doseRange).toEqual(range);
  });

  it("retains independent endpoint comparators without duplicating the range across stages", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [{ range: {
        low: { value: 500, unit: "mg", comparator: ">=" },
        high: { value: 1000, unit: "mg", comparator: "<=" },
      } }], schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }, { administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 250, unit: "mg" } }],
    }] }] };
    const rendered = formatSig(course, "long", { locale: "en" });
    expect(rendered).toContain(">=500–<=1000 mg");
    expect(rendered.split(">=500–<=1000 mg")).toHaveLength(2);
    expect(rendered).not.toMatch(/(?<!>=)500[–-]1000 mg/);
    expect(member(course).amounts![0].range!.high!.comparator).toBe("<=");
  });

});
