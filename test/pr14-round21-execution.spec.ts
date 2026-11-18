/** Independent quantity and timestamp oracles for review 21 execution. */
import { describe, expect, it } from "vitest";
import { calculateTotalUnits, nextDueDoses, toEzDosages } from "../src/index";
import type { CanonicalAdministration, CanonicalCourse } from "../src/canonical/course";
import { EventTiming, FhirPeriodUnit as Unit, type FhirDosage } from "../src/types";

const origin = "2026-01-01T00:00:00Z";
const options = { from: origin, orderedAt: origin, timeZone: "UTC" };
const dose = (value = 1): CanonicalAdministration => ({
  kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
  schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00"] } },
});
const supply = (dosage: CanonicalAdministration | CanonicalCourse, days: number, extra = {}) =>
  calculateTotalUnits({ ...options, dosage, durationValue: days, durationUnit: Unit.Day, ...extra });
const relative = (value: number, unit = "d") => ({
  anchor: "treatment-start" as const, displacement: { value, unit },
});
const capacity = (count = 2): CanonicalAdministration => ({
  ...dose(), asNeeded: true,
  amounts: [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
  schedule: { recurrence: { countMax: count,
    occurrenceCap: { max: 2, period: 1, periodUnit: Unit.Day } } },
  limits: [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }],
});

describe("scoped maximum quantities retain all usable information", () => {
  it.each([false, true])("intersects exact lifetime ceilings regardless of order (%s)", reverse => {
    const input = dose();
    const values = reverse ? [20, 10] : [10, 20];
    input.limits = values.map(value => ({ scope: "lifetime", amount: { value, unit: "tab" } }));
    expect(supply(input, 30).totalUnits).toBe(10);
    expect(supply(input, 30).explanation).not.toContain("could not be applied");
  });
  it.each([false, true])("keeps the known lifetime ceiling beside an incomplete quantity (%s)", reverse => {
    const input = dose();
    input.limits = [{ scope: "lifetime", amount: { value: 10, unit: "tab" } },
      { scope: "lifetime", amount: { unit: "tab" } }];
    if (reverse) input.limits!.reverse();
    expect(supply(input, 14)).toMatchObject({ totalUnits: 10, quantityKind: "maximum" });
    expect(supply(input, 14).explanation).toContain("could not be applied");
    expect(input.limits).toHaveLength(2);
  });
  it("normalizes compatible mass ceilings and leaves incompatible information unresolved", () => {
    const input = dose(500); input.amounts![0].quantity!.unit = "mg";
    input.limits = [{ scope: "lifetime", amount: { value: 2, unit: "g" } },
      { scope: "lifetime", amount: { value: 1500, unit: "mg" } },
      { scope: "lifetime", amount: { value: 1, unit: "mL" } }];
    expect(supply(input, 10).totalUnits).toBe(1500);
    expect(supply(input, 10).explanation).toContain("could not be applied");
    expect(input.limits[2].amount!.unit).toBe("mL");
  });
  it("uses the live supported R5 maximum after lifting", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00", "20:00:00"] } },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" }, denominator: { value: 1, unit: "d" } }] };
    const lifted = toEzDosages([row])[0];
    lifted.maxDosePerPeriod = [{ numerator: { value: 1, unit: "tab" }, denominator: { value: 1, unit: "d" } }];
    expect(nextDueDoses(lifted, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
    ]);
  });
});

describe("finite use capacity allocates actual feasible quantities", () => {
  it.each([[1, 1, 2], [2, 1, 3], [2, 2, 4], [3, 2, 5], [4, 2, 6]])(
    "%s uses over %s days has maximum %s tablets", (count, days, expected) => {
      expect(supply(capacity(count), days).totalUnits).toBe(expected);
    });
  it("keeps scarce full doses feasible under a second longer rolling ceiling", () => {
    const input = capacity(2);
    input.limits!.push({ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 48, unit: "h" } });
    expect(supply(input, 2).totalUnits).toBe(4);
  });
  it("reserves two scarce uses for unequal future capacity windows", () => {
    const member = capacity(3); // One recorded administration leaves two uses.
    member.limits!.push({ scope: "period", amount: { value: 3.5, unit: "tab" }, period: { value: 48, unit: "h" } });
    // Prior2 expires from the24h cap atJan1 01:00, then the48h cap
    // atJan2 01:00. Quantities1.5 and2 atthose times attain the3.5 cap.
    expect(supply(member, 2, { priorDoseTimes: ["2025-12-31T01:00:00Z"] }).totalUnits).toBe(3.5);
  });
  it("optimizes the remaining dose after a full upper dose", () => {
    const member = capacity(2); member.amounts![0].range!.high!.value = 3;
    member.limits = [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 24, unit: "h" } },
      { scope: "period", amount: { value: 5, unit: "tab" }, period: { value: 48, unit: "h" } }];
    // Three atday0 plus two atday1; the48h maximum proves five is optimal.
    expect(supply(member, 2).totalUnits).toBe(5);
  });
  it.each([true, false])("solves quantities jointly across separate daily slots (explicit count%s)", finite => {
    const member = capacity(2); member.amounts![0].range!.low!.value = 1.5;
    member.schedule!.recurrence!.occurrenceCap!.max = 1;
    if (!finite) member.schedule!.recurrence!.countMax = undefined;
    member.limits![0].period = { value: 48, unit: "h" };
    expect(supply(member, 2).totalUnits).toBe(3); //1.5 on each day.
  });
  it("solves fractional doses jointly under a calendar-month allowance", () => {
    const member = capacity(2); member.amounts![0].range!.low!.value = 1.5;
    member.schedule!.recurrence!.occurrenceCap!.max = 1;
    member.limits![0].period = { value: 1, unit: "mo" };
    expect(supply(member, 2).totalUnits).toBe(3);
  });
  it("retains a feasible strict-low optimum instead of assigning a forbidden endpoint", () => {
    const member = capacity(2); member.amounts![0].range!.low!.comparator = ">";
    expect(supply(member, 1).totalUnits).toBe(3); //1.5+1.5, each strictly greater than one.
  });
  it("handles a repeated calendar release after a cutoff re-enters history", () => {
    const member = capacity(3);
    member.limits = [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 1, unit: "mo" } },
      { scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const query = { ...options, dosage: member, from: "2026-03-30T07:20:00Z", orderedAt: "2026-03-30T07:20:00Z",
      priorDoseTimes: ["2026-02-28T07:30:00Z", "2026-03-30T07:15:00Z"], durationUnit: Unit.Minute };
    expect(calculateTotalUnits({ ...query, durationValue: 1450 }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ ...query, durationValue: 1460 }).totalUnits).toBe(2);
  });
  it("proves an ordinary large full-dose plan without entering bounded search", () => {
    const member = capacity(50); member.schedule!.recurrence!.occurrenceCap!.max = 50;
    member.limits![0].amount!.value = 100;
    expect(supply(member, 1).totalUnits).toBe(100);
  });
  it("reports a supply-only exact-planning bound without altering the source", () => {
    const member = capacity(33); member.schedule!.recurrence!.occurrenceCap!.max = 1;
    member.amounts![0].range!.low!.value = 1.5;
    member.limits![0].amount!.value = 65; member.limits![0].period = { value: 66, unit: "d" };
    const source = JSON.stringify(member);
    expect(() => supply(member, 33)).toThrow(/32-slot or 50,000-state/);
    expect(JSON.stringify(member)).toBe(source);
    expect(nextDueDoses(member, { ...options, limit: 1 })).toEqual([]);
  });
  it("retains untimed capacity in an explicitly one-civil-day phase", () => {
    const member = capacity(2); member.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    expect(supply(course, 2).totalUnits).toBe(6);
  });
  it("does not fit two strict lower doses into one three-tablet window", () => {
    const input = capacity(2); input.amounts![0].range!.low = { value: 1.5, comparator: ">", unit: "tab" };
    expect(supply(input, 1).totalUnits).toBe(2);
    expect(supply(input, 2).totalUnits).toBe(4);
  });
});

describe("civil boundaries retain the intended instant", () => {
  it("retains milliseconds at a zero-day treatment start", () => {
    const member = dose(); member.schedule = { recurrence: { count: 1 } };
    const course: CanonicalCourse = { kind: "course", stages: [{ start: relative(0), administrations: [member] }] };
    const at = "2026-01-01T08:00:00.500Z";
    expect(nextDueDoses(course, { from: at, orderedAt: at, timeZone: "UTC", limit: 1 }))
      .toEqual(["2026-01-01T08:00:00.500+00:00"]);
  });
  it("repeats an implicit first-day start by civil days across spring DST", () => {
    const member = dose(); member.schedule!.recurrence!.clocks = ["08:30:00"];
    const course: CanonicalCourse = { kind: "course", stages: [{
      count: 3, end: relative(1), administrations: [member],
    }] };
    const config = { from: "2026-03-07T09:00:00-05:00", orderedAt: "2026-03-07T09:00:00-05:00",
      timeZone: "America/New_York" };
    expect(nextDueDoses(course, { ...config, limit: 4 })).toEqual([
      "2026-03-08T08:30:00-04:00", "2026-03-09T08:30:00-04:00", "2026-03-10T08:30:00-04:00",
    ]);
    expect(calculateTotalUnits({ ...config, dosage: course, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(3);
  });
  it("uses the first midnight of a folded date-only start", () => {
    const input = dose(); input.schedule = { explicitEvents: ["2021-10-28T21:30:00Z"],
      recurrence: { calendarWindow: { start: "2021-10-29", end: "2021-10-29" } } };
    expect(nextDueDoses(input, { from: "2021-10-28T21:00:00Z", timeZone: "Asia/Amman", limit: 1 }))
      .toEqual(["2021-10-29T00:30:00+03:00"]);
  });
  it.each([Unit.Day, Unit.Week])("preserves fractional seconds in a civil %s supply horizon", unit => {
    const input = dose(); input.schedule = { explicitEvents: [unit === Unit.Day
      ? "2026-01-02T12:00:00.250Z" : "2026-01-08T12:00:00.250Z"] };
    expect(calculateTotalUnits({ ...options, dosage: input, from: "2026-01-01T12:00:00.500Z",
      durationValue: 1, durationUnit: unit }).totalUnits).toBe(1);
  });
});

describe("overlapping cycles use one chronological admission stream", () => {
  it("compares authored clocks with the inferred upper-frequency plan in a short query", () => {
    const member = dose(); member.schedule!.recurrence = { frequency: 1, frequencyMax: 2,
      period: 1, periodUnit: Unit.Day, clocks: ["06:00:00"], courseLength: { value: 2, unit: "d" } };
    member.limits = [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    const query = { ...options, from: "2026-01-02T06:00:00Z", limit: 2 };
    expect(nextDueDoses(course, query)).toEqual(["2026-01-02T06:00:00+00:00", "2026-01-02T06:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: course, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(2);
  });
  it("fills the shared ranged ceiling over full days and still compares a short authored window", () => {
    const member = dose();
    member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
    member.schedule!.recurrence = { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
      clocks: ["09:00:00"], courseLength: { value: 2, unit: "d" } };
    member.limits = [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 1, unit: "d" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    expect(supply(course, 2).totalUnits).toBe(8);
    expect(calculateTotalUnits({ ...options, dosage: course, from: "2026-01-02T09:00:00Z",
      durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(4);
  });
  it("does not use a retained inapplicable cap to discard a larger authored plan", () => {
    const member = dose();
    member.amounts = [{ range: { low: { value: 2, unit: "tab" }, high: { value: 3, unit: "tab" } } }];
    member.schedule!.recurrence = { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
      clocks: ["06:00:00", "09:00:00"], courseLength: { value: 2, unit: "d" } };
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 1, unit: "d" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    expect(calculateTotalUnits({ ...options, dosage: course, from: "2026-01-01T05:00:00Z",
      durationValue: 5, durationUnit: Unit.Hour }).totalUnits).toBe(6);
  });
  it("detects elapsed-phase overlap first introduced by a later shortened civil cycle", () => {
    const member = dose(); member.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Day,
      clocks: ["00:00:00", "00:30:00"], courseLength: { value: 24, unit: "h" } };
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 2, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    const query = { from: "2026-03-09T00:00:00-04:00", orderedAt: "2026-03-06T00:00:00-05:00",
      timeZone: "America/New_York", limit: 2 };
    expect(nextDueDoses(course, query)).toEqual(["2026-03-09T00:00:00-04:00", "2026-03-09T00:00:00-04:00"]);
    expect(calculateTotalUnits({ ...query, dosage: course, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(2);
  });
});

describe("historical and shifted anchors use the same recurrence as scheduling", () => {
  it("consumes all waking-hour interval events before a late finite-count query", () => {
    const member = dose(); member.schedule!.recurrence = { count: 4, frequency: 1,
      period: 4, periodUnit: Unit.Hour, anchors: [EventTiming.Wake] };
    const query = { ...options, from: "2026-01-01T17:00:00Z", eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 5 };
    expect(nextDueDoses(member, query)).toEqual(["2026-01-02T08:00:00+00:00"]);
    expect(nextDueDoses(member, { ...query, priorCount: 2 })).toEqual([
      "2026-01-02T08:00:00+00:00", "2026-01-02T12:00:00+00:00",
    ]);
    expect(supply(member, 1, query).totalUnits).toBe(1);
  });
  it("includes a previous dinner's positive offset after midnight", () => {
    const member = dose(); member.schedule!.recurrence!.anchors = [EventTiming["After Dinner"]];
    member.schedule!.recurrence!.clocks = undefined;
    const query = { ...options, from: "2026-01-02T00:00:00Z", eventClock: { CV: "23:45" }, mealOffsets: { PCV: 30 }, limit: 1 };
    expect(nextDueDoses(member, query)).toEqual(["2026-01-02T00:15:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: member, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(1);
    member.schedule!.recurrence!.count = 2;
    expect(nextDueDoses(member, { ...query, from: "2026-01-03T00:00:00Z", limit: 2 }))
      .toEqual(["2026-01-03T00:15:00+00:00"]);
  });
  it.each([1, 2])("counts a recorded historical administration once with cap %s", ceiling => {
    const member = dose(); member.schedule!.recurrence!.count = 2;
    member.limits = [{ scope: "period", amount: { value: ceiling, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const query = { ...options, from: "2026-01-02T00:00:00Z", priorDoseTimes: ["2026-01-01T09:00:00Z"], limit: 3 };
    expect(nextDueDoses(member, query)).toEqual(["2026-01-02T09:00:00+00:00"]);
    expect(nextDueDoses(member, { ...query, priorCount: 2 })).toEqual([]);
  });
});

describe("supply context applies to actual admission", () => {
  it("uses concentration when enforcing a mass maximum on a volume dose", () => {
    const member = dose(5); member.amounts![0].quantity!.unit = "mL";
    member.schedule!.recurrence = { frequency: 1, period: 6, periodUnit: Unit.Hour };
    member.limits = [{ scope: "period", amount: { value: 200, unit: "mg" }, period: { value: 24, unit: "h" } }];
    expect(supply(member, 1, { context: { strengthRatio: {
      numerator: { value: 100, unit: "mg" }, denominator: { value: 5, unit: "mL" },
    } } }).totalUnits).toBe(10);
    expect(supply(member, 1).totalUnits).toBe(20);
    expect(supply(member, 1).explanation).toContain("could not be applied");
  });
  it("reads declared calculation options through instance getters", () => {
    class Options {
      dosage = dose(); from = origin; orderedAt = origin; durationValue = 1; durationUnit = Unit.Day;
      zone = "UTC"; get timeZone() { return this.zone; }
    }
    expect(calculateTotalUnits(new Options()).totalUnits).toBe(1);
  });
});
