/** Independent execution oracles for the complete November 18 review families. */
import { describe, expect, it } from "vitest";
import { calculateTotalUnits, nextDueDoses, parseSig, toFhirR5Dosages } from "../src/index";
import type { CanonicalAdministration, CanonicalCourse } from "../src/canonical/course";
import { FhirPeriodUnit, type FhirDosage, type FhirR6DosageInstruction } from "../src/types";
import { addCalendarDaysAtClock, addCalendarMonths, getTimeParts } from "../src/execution/calendar";

const from = "2026-01-01T00:00:00Z";
const options = { from, orderedAt: from, timeZone: "UTC" };
const dose = (value = 1): CanonicalAdministration => ({
  kind: "administration",
  amounts: [{ quantity: { value, unit: "tab" } }],
  schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } },
});
const supply = (dosage: CanonicalAdministration | CanonicalCourse, days: number, extra = {}) =>
  calculateTotalUnits({ ...options, dosage, durationValue: days, durationUnit: FhirPeriodUnit.Day, ...extra });
const relative = (value: number, unit = "d") => ({
  anchor: "treatment-start" as const, displacement: { value, unit },
});

describe("day boundaries and exact recurrence precision", () => {
  it("uses the local day when midnight is skipped but the prescribed clock exists", () => {
    const input: CanonicalAdministration = dose();
    input.schedule!.recurrence!.calendarWindow = { start: "2026-09-06", end: "2026-09-06" };
    const config = { from: "2026-09-06T00:00:00-04:00", orderedAt: "2026-09-06T00:00:00-04:00",
      timeZone: "America/Santiago" };
    expect(nextDueDoses(input, { ...config, limit: 3 })).toEqual(["2026-09-06T08:00:00-03:00"]);
    expect(calculateTotalUnits({ ...config, dosage: input, durationValue: 1,
      durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
  });

  it("resolves a date-only event before applying its exact authored clock", () => {
    const input: CanonicalAdministration = dose();
    input.schedule!.explicitEvents = ["2026-09-06"];
    expect(nextDueDoses(input, {
      from: "2026-09-06T00:00:00-04:00", timeZone: "America/Santiago", limit: 3,
    })).toEqual(["2026-09-06T08:00:00-03:00"]);
  });

  it.each([FhirPeriodUnit.Day, FhirPeriodUnit.Month])(
    "retains fractional seconds on civil %s stepping and a query exactly on the next instant", unit => {
      const input: CanonicalAdministration = {
        ...dose(),
        schedule: { recurrence: { frequency: 1, period: 2, periodUnit: unit } },
      };
      const anchor = "2026-01-01T00:00:00.500Z";
      const next = unit === FhirPeriodUnit.Day ? "2026-01-03T00:00:00.500+00:00" : "2026-03-01T00:00:00.500+00:00";
      expect(nextDueDoses(input, { from: anchor, orderedAt: anchor, timeZone: "UTC", limit: 2 }))
        .toEqual(["2026-01-01T00:00:00.500+00:00", next]);
      expect(nextDueDoses(input, { from: next, orderedAt: anchor, timeZone: "UTC", limit: 1 })).toEqual([next]);
    }
  );

  it("keeps a civil fraction through both sides of a DST change", () => {
    const anchor = new Date("2026-03-07T08:00:00.500-05:00");
    const clock = getTimeParts(anchor, "America/New_York");
    expect(addCalendarDaysAtClock(anchor, 2, "America/New_York", clock)!.toISOString())
      .toBe("2026-03-09T12:00:00.500Z");
    expect(addCalendarMonths(anchor, 1, "America/New_York", clock).toISOString())
      .toBe("2026-04-07T12:00:00.500Z");
  });

  it("returns no requested events before requiring a timezone or importing rows", () => {
    const rows: FhirDosage[] = [{ sequence: 1 }, { sequence: 2 }];
    expect(nextDueDoses(rows, { from, limit: 0 })).toEqual([]);
  });
});

describe("quantity accounting retains the meaning of the supplied constraints", () => {
  it("measures a code-only UCUM rate with its supplied infusion duration", () => {
    const input: CanonicalAdministration = {
      ...dose(), amounts: [{ rate: { value: 10, system: "http://unitsofmeasure.org", code: "mL/h" } }],
      schedule: { recurrence: { count: 1, clocks: ["08:00:00"], occurrenceDuration: 1,
        occurrenceDurationUnit: FhirPeriodUnit.Hour } },
    };
    expect(supply(input, 1)).toMatchObject({ totalUnits: 10, unit: "mL" });
    input.limits = [{ scope: "period", amount: { value: 10, unit: "mL" }, period: { value: 24, unit: "h" } }];
    expect(supply(input, 1).totalUnits).toBe(10);
    input.schedule!.recurrence!.occurrenceDuration = 2;
    input.limits![0].amount.value = 30;
    expect(supply(input, 1)).toMatchObject({ totalUnits: 20, unit: "mL" });
  });

  it.each([[10, 20], [20, 10], [10, 20, 30]])(
    "uses the tightest compatible lifetime bound (%s, %s)", (...values) => {
      const input = dose();
      input.limits = values.map(value => ({ scope: "lifetime", amount: { value, unit: "tab" } }));
      const result = supply(input, 30);
      expect(result.totalUnits).toBe(10);
      expect(result.quantityKind).toBe("maximum");
      expect(result.explanation).not.toContain("could not be applied");
    }
  );
  it("still evaluates one lifetime bound", () => {
    const input = dose();
    input.limits = [{ scope: "lifetime", amount: { value: 10, unit: "tab" } }];
    expect(supply(input, 30).totalUnits).toBe(10);
  });
  it.each([">", ">="] as const)("does not report a %s dose as an exact required supply", comparator => {
    const input = dose(500);
    input.amounts![0].quantity = { value: 500, unit: "mL", comparator };
    expect(() => supply(input, 1)).toThrow(/lower bound/);
    expect(nextDueDoses(input, { ...options, limit: 1 })).toEqual(["2026-01-01T08:00:00+00:00"]);
    expect(input.amounts![0].quantity.comparator).toBe(comparator);
  });
  it("continues to measure an approximate nominal dose", () => {
    const input = dose();
    input.amounts![0].quantity!.comparator = "~";
    expect(supply(input, 3).totalUnits).toBe(3);
  });
});

describe("step and cap planning", () => {
  it("repeats a one-day step three times without a course repeat cycle", () => {
    const course: CanonicalCourse = {
      kind: "course", stages: [{
        count: 3, start: relative(0), end: relative(1), administrations: [dose()],
      }],
    };
    expect(nextDueDoses(course, { ...options, limit: 10 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
    ]);
    expect(supply(course, 3).totalUnits).toBe(3);
  });

  it("opens maintenance only after the capped loading dose is actually admitted", () => {
    const load = dose(2);
    load.schedule!.recurrence!.count = 1;
    load.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const maintenance = dose();
    maintenance.schedule!.recurrence!.clocks = ["09:00:00"];
    maintenance.schedule!.recurrence!.courseLength = { value: 10, unit: "d" };
    maintenance.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" },
      stages: [{ administrations: [load] }, { administrations: [maintenance] }] };
    expect(nextDueDoses(course, { ...options, limit: 6 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
      "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
    ]);
    expect(supply(course, 5).totalUnits).toBe(7);
  });

  it.each([false, true])("defers capped loading before opening maintenance (repeated=%s)", repeated => {
    const load = dose(2); load.schedule!.recurrence!.count = 1;
    load.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const maintenance = dose(); maintenance.schedule!.recurrence!.clocks = ["09:00:00"];
    maintenance.schedule!.recurrence!.courseLength = { value: 3, unit: "d" };
    const course: CanonicalCourse = { kind: "course",
      ...(repeated ? { cycleInterval: { value: 7, unit: "d" }, cycleCount: 1 } : {}),
      stages: [{ administrations: [load] }, { administrations: [maintenance] }] };
    // This record is before the loading phase. It blocks Jan 1's rolling cap,
    // but cannot satisfy that phase's one required loading administration.
    const priorDoseTimes = ["2025-12-31T20:00:00Z"];
    expect(nextDueDoses(course, { ...options, priorDoseTimes, limit: 3 })).toEqual([
      "2026-01-02T08:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
  });

  it("retains accepted monthly-cap history that a later clamped cutoff includes again", () => {
    const member = dose();
    member.schedule = { explicitEvents: [
      "2026-02-28T07:30:00Z", "2026-03-30T08:00:00Z", "2026-03-31T07:00:00Z",
    ] };
    member.limits = [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 1, unit: "mo" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "a" },
      stages: [{ administrations: [member] }] };
    // Two cycle instances each contain the March 30 event, so both are
    // legitimate accepted administrations. The February dose re-enters the
    // month window on March 31 at 07:00 and blocks a fourth tablet.
    const actual = calculateTotalUnits({
      dosage: course, from: "2026-02-28T00:00:00Z", orderedAt: "2025-03-01T00:00:00Z",
      timeZone: "UTC", durationValue: 33, durationUnit: FhirPeriodUnit.Day,
    });
    expect(actual.totalUnits).toBe(3);
    for (const [from, expected] of [["2026-02-28", 1], ["2026-03-30", 2], ["2026-03-31", 0]] as const) {
      expect(calculateTotalUnits({ dosage: course, from: from + "T00:00:00Z", orderedAt: "2025-03-01T00:00:00Z",
        timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(expected);
    }
  });
});

describe("range amounts and rolling ceilings share one quantity ledger", () => {
  const ranged = (ceiling: number, hours = 24): CanonicalAdministration => ({
    kind: "administration",
    amounts: [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
    schedule: { recurrence: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
      clocks: ["08:00:00", "20:00:00"] } },
    limits: [{ scope: "period", amount: { value: ceiling, unit: "tab" }, period: { value: hours, unit: "h" } }],
  });
  it.each([[1, 1], [1.5, 1.5], [2, 2], [3, 3], [4, 4]])(
    "measures the feasible maximum under a %s-tablet/day cap", (cap, expected) => {
      const member = ranged(cap), saved = structuredClone(member);
      expect(supply(member, 1)).toMatchObject({ totalUnits: expected, quantityKind: "maximum" });
      expect(member).toEqual(saved);
    }
  );
  it.each([1, 2])("carries admitted amounts through %s-day overlapping/nonoverlapping cycles", length => {
    const member = ranged(3);
    member.schedule!.recurrence!.courseLength = { value: length, unit: "d" };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    expect(supply(course, 3).totalUnits).toBe(9);
    expect(supply(course, 1, { from: "2026-01-02T00:00:00Z" }).totalUnits).toBe(3);
  });
  it("selects a feasible finite per-administration maximum from the same range", () => {
    const member = ranged(4);
    member.limits = [{ scope: "administration", amount: { value: 1, unit: "tab" } }];
    expect(supply(member, 1)).toMatchObject({ totalUnits: 2, quantityKind: "maximum" });
    expect(member.amounts![0].range!.high!.value).toBe(2);
  });
  it("keeps a low-only range unresolved unless a compatible administration maximum supplies its ceiling", () => {
    const member = ranged(4);
    member.amounts![0].range = { low: { value: 1, unit: "tab" } };
    member.limits = undefined;
    expect(() => supply(member, 1)).toThrow(/no finite upper bound/);
    expect(nextDueDoses(member, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
    member.limits = [{ scope: "administration", amount: { value: 2, unit: "tab" } }];
    expect(supply(member, 1)).toMatchObject({ totalUnits: 4, quantityKind: "maximum" });
    expect(member.amounts![0].range!.high).toBeUndefined();
  });
  it("accounts for both targets in the same cap unit", () => {
    const member = ranged(3);
    member.targetCount = 2;
    member.amounts![0].range = { low: { value: 1, unit: "drop" }, high: { value: 2, unit: "drop" } };
    member.limits![0].amount = { value: 3, unit: "drop" };
    expect(supply(member, 1).totalUnits).toBe(3);
  });
  it("normalizes different range endpoint and limit units without editing the source", () => {
    const member = ranged(3);
    member.amounts![0].range = { low: { value: 500, unit: "mg" }, high: { value: 1, unit: "g" } };
    member.limits![0].amount = { value: 1500, unit: "mg" };
    expect(supply(member, 1)).toMatchObject({ totalUnits: 1.5, unit: "g" });
  });
  const capacity = (ceiling: number, hours = 24) => {
    const member = ranged(ceiling, hours);
    member.schedule = { recurrence: { occurrenceCap: { max: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    return member;
  };
  it("allocates three tablets over at most two untimed administrations", () => {
    expect(supply(capacity(3), 1).totalUnits).toBe(3);
  });
  it("does not fit two strictly-greater-than-1.5 doses into a three-tablet ceiling", () => {
    const member = capacity(3);
    member.amounts![0].range!.low = { value: 1.5, unit: "tab", comparator: ">" };
    expect(supply(member, 1).totalUnits).toBe(2);
  });
  it("keeps an administration slot for a second short-window allowance later that day", () => {
    expect(supply(capacity(2, 12), 1).totalUnits).toBe(4);
  });
  it("carries the actual capacity allocation quantity into later cycles", () => {
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [capacity(3, 48)] }] };
    expect(supply(course, 2).totalUnits).toBe(3);
    expect(supply(course, 3).totalUnits).toBe(6);
    expect(supply(course, 1, { from: "2026-01-02T00:00:00Z" }).totalUnits).toBe(0);
  });
});

describe("local step repetitions retain their own phases in every cycle", () => {
  it("repeats a two-day active step within each three-day course cycle", () => {
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 3, unit: "d" },
      stages: [{ count: 2, start: relative(0), end: relative(1), administrations: [dose()] }] };
    expect(nextDueDoses(course, { ...options, limit: 6 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00",
      "2026-01-07T08:00:00+00:00", "2026-01-08T08:00:00+00:00",
    ]);
    expect(supply(course, 9).totalUnits).toBe(6);
  });
  it("shares caps between local finite-count step repetitions and opens the successor after acceptance", () => {
    const member = dose();
    member.schedule!.recurrence!.count = 1;
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 48, unit: "h" } }];
    const next = dose(2);
    next.schedule!.recurrence!.count = 1;
    next.schedule!.recurrence!.clocks = ["09:00:00"];
    const course: CanonicalCourse = { kind: "course", stages: [
      { count: 2, administrations: [member] }, { administrations: [next] },
    ] };
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
    expect(supply(course, 5).totalUnits).toBe(4);
  });
  it("keeps civil one-day repetitions aligned across a shortened DST day", () => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { count: 3, start: relative(0), end: relative(1), administrations: [dose()] },
    ] };
    const config = { from: "2026-03-07T00:00:00-05:00", orderedAt: "2026-03-07T00:00:00-05:00",
      timeZone: "America/New_York", limit: 4 };
    expect(nextDueDoses(course, config)).toEqual([
      "2026-03-07T08:00:00-05:00", "2026-03-08T08:00:00-04:00", "2026-03-09T08:00:00-04:00",
    ]);
    expect(calculateTotalUnits({ ...config, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day })
      .totalUnits).toBe(3);
  });
});

describe("calendar quantity limits retain reversible membership and find the first release", () => {
  const cappedCapacity = (): CanonicalAdministration => ({
    ...dose(),
    schedule: { recurrence: { occurrenceCap: { max: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } },
    limits: [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 1, unit: "mo" } }],
  });
  it("does not skip a March 30 release by searching across the backward March 31 cutoff", () => {
    const result = calculateTotalUnits({
      dosage: cappedCapacity(), from: "2026-03-30T07:00:00Z", orderedAt: "2026-03-30T07:00:00Z",
      timeZone: "UTC", durationValue: 745, durationUnit: FhirPeriodUnit.Hour,
      priorDoseTimes: ["2026-02-28T07:30:00Z"],
    });
    // Available March 30 at07:30, then April30 at07:30; both are before
    // April30 at08:00. Choosing March31 first would incorrectly yield one.
    expect(result.totalUnits).toBe(2);
  });
  it("finds a month-cap release before the source clock falls back", () => {
    expect(calculateTotalUnits({
      dosage: cappedCapacity(), from: "2026-11-01T01:00:00-04:00", orderedAt: "2026-11-01T01:00:00-04:00",
      timeZone: "America/New_York", durationValue: 1.25, durationUnit: FhirPeriodUnit.Hour,
      priorDoseTimes: ["2026-10-01T01:30:00-04:00"],
    }).totalUnits).toBe(1);
  });
  it("finds a release in the target month's shifted gap before its cutoff retreats", () => {
    expect(calculateTotalUnits({
      dosage: cappedCapacity(), from: "2026-04-08T01:45:00-04:00", orderedAt: "2026-04-08T01:45:00-04:00",
      timeZone: "America/New_York", durationValue: 1.5, durationUnit: FhirPeriodUnit.Hour,
      priorDoseTimes: ["2026-03-08T03:30:00-04:00"],
    }).totalUnits).toBe(1);
  });
  it("retains clamped-day history across nonoverlapping daily course cycles", () => {
    const member = dose();
    member.schedule!.recurrence!.frequency = 4;
    member.schedule!.recurrence!.clocks = ["07:00:00", "07:30:00", "08:00:00", "09:00:00"];
    member.predicate = { kind: "text", text: "if pain" };
    member.limits = [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 1, unit: "mo" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    const symptomatic = new Set(["2026-02-28T07:30:00+00:00", "2026-03-30T08:00:00+00:00",
      "2026-03-30T09:00:00+00:00", "2026-03-31T07:00:00+00:00"]);
    expect(calculateTotalUnits({
      dosage: course, from: "2026-02-27T08:00:00Z", orderedAt: "2026-02-27T08:00:00Z",
      timeZone: "UTC", durationValue: 33, durationUnit: FhirPeriodUnit.Day,
      evaluateCondition: (_condition, at) => symptomatic.has(at),
    }).totalUnits).toBe(3);
  });
  it("keeps yearly cap history when February29 clamps back to February28", () => {
    const member = dose();
    member.schedule = { explicitEvents: [
      "2027-02-28T07:30:00Z", "2028-02-28T08:00:00Z", "2028-02-29T07:00:00Z",
    ] };
    member.limits = [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 1, unit: "a" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "a" },
      stages: [{ administrations: [member] }] };
    expect(calculateTotalUnits({
      dosage: course, from: "2027-02-28T00:00:00Z", orderedAt: "2026-03-01T00:00:00Z",
      timeZone: "UTC", durationValue: 368, durationUnit: FhirPeriodUnit.Day,
    }).totalUnits).toBe(3);
    for (const [from, expected] of [["2027-02-28", 1], ["2028-02-28", 2], ["2028-02-29", 0]] as const) {
      expect(calculateTotalUnits({ dosage: course, from: from + "T00:00:00Z", orderedAt: "2026-03-01T00:00:00Z",
        timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(expected);
    }
  });
});


describe("finite whole-course cycles remain distinct from local step repetitions", () => {
  it("runs two local one-day repetitions in each of exactly three complete courses", () => {
    const course: CanonicalCourse = {
      kind: "course", cycleInterval: { value: 3, unit: "d" }, cycleCount: 3,
      stages: [{ count: 2, start: relative(0), end: relative(1), administrations: [dose()] }],
    };
    expect(nextDueDoses(course, { ...options, limit: 12 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00",
      "2026-01-07T08:00:00+00:00", "2026-01-08T08:00:00+00:00",
    ]);
    expect(supply(course, 12).totalUnits).toBe(6);
    expect(nextDueDoses(course, { ...options, from: "2026-01-08T00:00:00Z", limit: 3 }))
      .toEqual(["2026-01-08T08:00:00+00:00"]);
  });

  it("does not seek beyond a finite course when a distant query has no overlapping tail", () => {
    const course: CanonicalCourse = {
      kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 3,
      stages: [{ administrations: [dose()] }],
    };
    expect(nextDueDoses(course, { ...options, from: "2030-01-01T00:00:00Z", limit: 1 })).toEqual([]);
    expect(supply(course, 30).totalUnits).toBe(3);
    expect(supply(course, 2, { from: "2026-01-03T00:00:00Z" }).totalUnits).toBe(1);
  });

  it("retains the final capped cycle's tail and history without creating a fourth cycle", () => {
    const member = dose();
    member.schedule!.recurrence!.courseLength = { value: 3, unit: "d" };
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" },
      period: { value: 24, unit: "h" } }];
    const course: CanonicalCourse = {
      kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 3,
      stages: [{ administrations: [member] }],
    };
    // Three three-day windows start Jan1, Jan2 and Jan3. Their union is
    // Jan1–5; the shared one-tablet daily cap admits five administrations.
    expect(nextDueDoses(course, { ...options, limit: 10 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00",
      "2026-01-05T08:00:00+00:00",
    ]);
    expect(supply(course, 10).totalUnits).toBe(5);
    expect(nextDueDoses(course, { ...options, from: "2026-01-04T00:00:00Z", limit: 10 }))
      .toEqual(["2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00"]);
    expect(supply(course, 10, { from: "2026-01-04T00:00:00Z" }).totalUnits).toBe(2);
    expect(nextDueDoses(course, { ...options, from: "2026-01-06T00:00:00Z", limit: 1 })).toEqual([]);
  });
});
