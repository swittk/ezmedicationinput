/**
 * Caps consume accepted administrations, not opportunities rejected by another
 * constraint. These dates and amounts are independent clinical accounting oracles.
 */
import { describe, expect, it } from "vitest";
import { calculateTotalUnits, nextDueDoses } from "../src/index";
import type { CanonicalAdministration, CanonicalCourse } from "../src/canonical/course";
import { FhirPeriodUnit, type FhirR6DosageInstruction } from "../src/types";

const from = "2026-01-01T00:00:00Z";
const options = { from, orderedAt: from, timeZone: "UTC" };
const day = FhirPeriodUnit.Day;

function tablet(): CanonicalAdministration {
  return {
    kind: "administration",
    amounts: [{ quantity: { value: 1, unit: "tab" } }],
    schedule: { recurrence: {
      frequency: 2, period: 1, periodUnit: day, clocks: ["08:00:00", "20:00:00"],
      occurrenceCap: { max: 1, period: 1, periodUnit: day },
    } },
    limits: [{ scope: "period", amount: { value: 1, unit: "tab" },
      period: { value: 1, unit: "d" } }],
  };
}
function dailyCourse(member: CanonicalAdministration): CanonicalCourse {
  return { kind: "course", cycleInterval: { value: 1, unit: "d" },
    stages: [{ administrations: [member] }] };
}
function supply(dosage: CanonicalAdministration | CanonicalCourse, days: number, extra = {}) {
  return calculateTotalUnits({ ...options, dosage, durationValue: days, durationUnit: day, ...extra });
}

describe("joint cap acceptance", () => {
  const history = { priorDoseTimes: ["2025-12-31T20:00:00Z"] };
  it("does not spend the daily occurrence allowance on a rolling-quantity rejection", () => {
    const member = tablet();
    expect(nextDueDoses(member, { ...options, ...history, limit: 2 }))
      .toEqual(["2026-01-01T20:00:00+00:00", "2026-01-02T20:00:00+00:00"]);
    expect(supply(member, 1, history).totalUnits).toBe(1);
  });
  it.each(["count", "countMax"] as const)("counts accepted %s doses after the same joint caps", (field) => {
    const member = tablet();
    member.schedule!.recurrence![field] = 2;
    expect(nextDueDoses(member, { ...options, ...history, limit: 3 }))
      .toEqual(["2026-01-01T20:00:00+00:00", "2026-01-02T20:00:00+00:00"]);
    expect(supply(member, 3, history).totalUnits).toBe(2);
  });
  it("uses the same atomic acceptance after a condition has allowed the candidate", () => {
    const member = tablet();
    member.predicate = { kind: "text", text: "if pain" };
    expect(nextDueDoses(member, { ...options, ...history, evaluateCondition: () => true, limit: 1 }))
      .toEqual(["2026-01-01T20:00:00+00:00"]);
    expect(supply(member, 1, { ...history, evaluateCondition: () => true }).totalUnits).toBe(1);
  });
});

describe("repeated supply accepted history", () => {
  it("keeps the lifetime maximum across all repeat cycles", () => {
    const member = tablet();
    member.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: day, clocks: ["08:00:00"] } };
    member.limits = [{ scope: "lifetime", amount: { value: 3, unit: "tab" } }];
    const course = dailyCourse(member);
    expect(supply(course, 14).totalUnits).toBe(3);
    expect(supply(course, 14, { priorDoseTimes: ["2025-12-31T08:00:00Z"] }).totalUnits).toBe(2);
  });
  it("carries the accepted frequency maximum rather than its concrete single clock", () => {
    const member = tablet();
    member.schedule = { recurrence: {
      frequency: 1, frequencyMax: 2, period: 1, periodUnit: day, clocks: ["08:00:00"]
    } };
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 2, unit: "d" } }];
    const course = dailyCourse(member);
    expect(supply(course, 2).totalUnits).toBe(2);
    expect(nextDueDoses(course, { ...options, limit: 3 }))
      .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00"]);
  });
});


describe("accepted-count and lifetime related families", () => {
  it("retains the accepted finite count across a late query and explicit priorCount", () => {
    const member = tablet();
    member.schedule!.recurrence!.count = 2;
    const later = { ...options, from: "2026-01-02T12:00:00Z", limit: 3,
      priorDoseTimes: ["2025-12-31T20:00:00Z"] };
    expect(nextDueDoses(member, later)).toEqual(["2026-01-02T20:00:00+00:00"]);
    expect(nextDueDoses(member, { ...later, priorCount: 1,
      priorDoseTimes: ["2026-01-01T20:00:00Z"] }))
      .toEqual(["2026-01-02T20:00:00+00:00"]);
  });

  it("uses actual PRN history for the remaining total allowance", () => {
    const member = tablet();
    member.asNeeded = true;
    member.schedule!.recurrence!.countMax = 2;
    expect(nextDueDoses(member, { ...options, from: "2026-01-02T00:00:00Z", limit: 3,
      priorDoseTimes: ["2026-01-01T20:00:00Z"] }))
      .toEqual(["2026-01-02T20:00:00+00:00"]);
    expect(nextDueDoses(member, { ...options, from: "2026-01-02T00:00:00Z", limit: 3 }))
      .toEqual(["2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00"]);
  });

  it("applies the same accepted-count rule to an occurrence-only cap", () => {
    const member = tablet();
    member.limits = undefined;
    member.schedule!.recurrence!.count = 2;
    expect(nextDueDoses(member, { ...options, limit: 4 }))
      .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00"]);
  });

  it("does not invent prior lifetime use from historical scheduled opportunities", () => {
    const member = tablet();
    member.schedule!.recurrence!.occurrenceCap = undefined;
    member.limits = [{ scope: "lifetime", amount: { value: 3, unit: "tab" } }];
    const course = dailyCourse(member);
    const late = { from: "2026-01-03T12:00:00Z" };
    expect(supply(course, 7, late).totalUnits).toBe(3);
    const known = supply(course, 7, { ...late,
      priorDoseTimes: ["2026-01-02T20:00:00Z", "2026-01-03T08:00:00Z"] });
    expect(known.totalUnits).toBe(1);
    expect(known.explanation).toContain("supplied prior administrations");
  });

  it("does not subtract generated rolling history twice from the lifetime ceiling", () => {
    const member = tablet();
    member.schedule!.recurrence!.occurrenceCap = undefined;
    member.limits = [
      { scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 2, unit: "d" } },
      { scope: "lifetime", amount: { value: 5, unit: "tab" } },
    ];
    const result = supply(dailyCourse(member), 7);
    expect(result.totalUnits).toBe(5);
    expect(result.explanation).toContain("accepted earlier cycle supply");
    expect(result.explanation).not.toContain("reduced by supplied prior administrations");
    expect(supply(dailyCourse(member), 7, {
      priorDoseTimes: ["2025-12-31T20:00:00Z"] }).totalUnits).toBe(4);
  });

  it("keeps the existing fractional lifetime quantity ceiling and concrete schedule", () => {
    const member = tablet();
    member.amounts![0].quantity!.value = 2;
    member.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: day, clocks: ["08:00:00"] } };
    member.limits = [{ scope: "lifetime", amount: { value: 3, unit: "tab" } }];
    const course = dailyCourse(member);
    expect(supply(member, 14).totalUnits).toBe(3);
    expect(supply(course, 14).totalUnits).toBe(3);
    expect(nextDueDoses(course, { ...options, limit: 5 })).toHaveLength(5);
  });

  it("keeps per-target quantity and known concentration in the lifetime ledger's units", () => {
    const drops = tablet();
    drops.amounts = [{ quantity: { value: 1, unit: "drop" } }];
    drops.targetCount = 2;
    drops.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: day, clocks: ["08:00:00"] } };
    drops.limits = [{ scope: "lifetime", amount: { value: 5, unit: "drop" } }];
    expect(supply(dailyCourse(drops), 14).totalUnits).toBe(5);
    expect(supply(dailyCourse(drops), 14, {
      priorDoseTimes: ["2025-12-31T08:00:00Z"] }).totalUnits).toBe(3);

    const liquid = { ...drops, targetCount: undefined,
      amounts: [{ quantity: { value: 2, unit: "mL" } }],
      limits: [{ scope: "lifetime" as const, amount: { value: 30, unit: "mg" } }] };
    const context = { strengthRatio: {
      numerator: { value: 5, unit: "mg" }, denominator: { value: 1, unit: "mL" }
    } };
    expect(supply(dailyCourse(liquid), 14, { context }).totalUnits).toBe(6);
    expect(supply(dailyCourse(liquid), 14, { context,
      priorDoseTimes: ["2025-12-31T08:00:00Z"] }).totalUnits).toBe(4);
  });

  it("preserves cap-only capacity without creating clocks for lifetime accounting", () => {
    const member = tablet();
    member.schedule = { recurrence: {
      occurrenceCap: { max: 2, period: 1, periodUnit: day },
    } };
    member.limits = [{ scope: "lifetime", amount: { value: 3, unit: "tab" } }];
    const course = dailyCourse(member);
    expect(supply(course, 14).totalUnits).toBe(3);
    expect(supply(course, 14).quantityKind).toBe("maximum");
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
  });

  it("keeps component lifetime limits independent and course-wide safety at its own scope", () => {
    const first = tablet();
    first.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: day, clocks: ["08:00:00"] } };
    first.limits = [{ scope: "lifetime", amount: { value: 2, unit: "tab" } }];
    const second = { ...first, limits: [{ scope: "lifetime" as const, amount: { value: 5, unit: "tab" } }] };
    const course: CanonicalCourse = {
      kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [first, second] }],
      safety: { limits: [{ scope: "lifetime", amount: { value: 100, unit: "tab" } }] },
    };
    const before = JSON.stringify(course);
    const result = supply(course, 14);
    expect(result.totalUnits).toBe(7);
    expect(result.quantityKind).toBe("maximum");
    expect(result.explanation).toContain("retained but not evaluated");
    expect(JSON.stringify(course)).toBe(before);
  });

  it("applies lifetime quantity across repeated components imported from R6 safety", () => {
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 1, unit: "d", code: "d" },
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: day, timeOfDay: ["08:00:00"] } },
        safety: { doseLimit: [{ scope: "lifetime", valueQuantity: { value: 3, unit: "tab" } }] },
      }] }],
    };
    expect(calculateTotalUnits({ ...options, dosage: source,
      durationValue: 14, durationUnit: day }).totalUnits).toBe(3);
  });

  it("keeps maximum range and rate histories consistent with the accepted supply quantity", () => {
    const member = tablet();
    member.schedule = { recurrence: {
      frequency: 1, frequencyMax: 2, period: 1, periodUnit: day, clocks: ["08:00:00"]
    } };
    member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
    member.limits = [
      { scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 2, unit: "d" } },
      { scope: "lifetime", amount: { value: 6, unit: "tab" } },
    ];
    const source = JSON.stringify(member);
    expect(supply(dailyCourse(member), 2).totalUnits).toBe(4);
    expect(supply(dailyCourse(member), 4).totalUnits).toBe(6);
    expect(JSON.stringify(member)).toBe(source);

    const infusion: CanonicalAdministration = { ...member,
      amounts: [{ rate: { value: 10, unit: "mL/h" } }],
      schedule: { recurrence: { ...member.schedule!.recurrence,
        occurrenceDuration: 1, occurrenceDurationUnit: FhirPeriodUnit.Hour } },
      limits: [
        { scope: "period", amount: { value: 20, unit: "mL" }, period: { value: 2, unit: "d" } },
        { scope: "lifetime", amount: { value: 25, unit: "mL" } },
      ],
    };
    expect(supply(dailyCourse(infusion), 2).totalUnits).toBe(20);
    expect(supply(dailyCourse(infusion), 4).totalUnits).toBe(25);
  });
});


describe("repeated maximum-capacity history", () => {
  it("carries two-day rolling capacity across daily cycles without generating due times", () => {
    const member = tablet();
    member.schedule = { recurrence: { occurrenceCap: { max: 2, period: 1, periodUnit: day } } };
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 2, unit: "d" } }];
    const course = dailyCourse(member);
    expect(supply(course, 2).totalUnits).toBe(2);
    expect(supply(course, 4).totalUnits).toBe(4);
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
  });

  it("retains ranged capacity and a count maximum while sharing the rolling allowance", () => {
    const member = tablet();
    member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
    member.schedule = { recurrence: {
      occurrenceCap: { max: 2, period: 1, periodUnit: day }, countMax: 3,
    } };
    member.limits = [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 2, unit: "d" } }];
    const course = dailyCourse(member);
    expect(supply(course, 2).totalUnits).toBe(4);
    expect(supply(course, 4).totalUnits).toBe(8);
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
  });

  it("carries the same maximum plan into a later rolling-cap query", () => {
    const member = tablet();
    member.schedule = { recurrence: {
      frequency: 1, frequencyMax: 2, period: 1, periodUnit: day, clocks: ["08:00:00"]
    } };
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 2, unit: "d" } }];
    expect(supply(dailyCourse(member), 1, { from: "2026-01-02T00:00:00Z" }).totalUnits).toBe(0);
    expect(supply(dailyCourse(member), 1, { from: "2026-01-03T00:00:00Z" }).totalUnits).toBe(2);
  });
});
