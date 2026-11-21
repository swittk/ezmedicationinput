/** Independent quantity and timestamp oracles for review 21 execution. */
import { describe, expect, it } from "vitest";
import { parseClauseState } from "../src/parser";
import { createBoundaryPlan } from "../src/regimen/planner";
import { buildRegimenGraph, scopeSequentialPhaseSemantics, anchoredScheduleDurationEnd } from "../src/regimen/regimen";
import { buildCanonicalParallelRegimen, projectParallelRegimen } from "../src/regimen/parallel-course";
import { courseFromAdministrations, clauseForAdministration, courseFromPartialParallel } from "../src/canonical/compile";
import { courseToR5, courseToR6, courseFromR6 } from "../src/adapters/canonical-course";
import { calculateTotalUnits, nextDueDoses, toEzDosages, fromFhir, toFhirR5Dosages, parseSig, projectCanonicalCourse, importCanonicalCourse } from "../src/index";
import type { CanonicalAdministration, CanonicalCourse, CanonicalBoundary } from "../src/canonical/course";
import { EventTiming, FhirPeriodUnit as Unit, type FhirDosage, type FhirR6DosageInstruction } from "../src/types";

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


describe("round23 execution families", () => {
  const origin = "2026-01-01T00:00:00Z";
  const options = { from: origin, orderedAt: origin, timeZone: "UTC" };
  const relative = (value: number, unit = "d") => ({
    anchor: "treatment-start" as const, displacement: { value, unit },
  });
  const dose = (value = 1): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"] } },
  });
  const ranged = (low = 1.5, high = 2, maximum = 3, hours = 48): CanonicalAdministration => ({
    ...dose(), amounts: [{ range: { low: { value: low, unit: "tab" }, high: { value: high, unit: "tab" } } }],
    limits: [{ scope: "period", amount: { value: maximum, unit: "tab" }, period: { value: hours, unit: "h" } }],
  });
  const supply = (dosage: CanonicalAdministration | CanonicalCourse, days: number, extra = {}) =>
    calculateTotalUnits({ ...options, dosage, durationValue: days, durationUnit: Unit.Day, ...extra });

  describe("calendar and clock identity", () => {
    it.each(["d", "wk", "mo", "a"])("keeps a zero-%s boundary at the second fall-back instant", unit => {
      const member = dose(); member.schedule!.recurrence = { count: 1 };
      const course: CanonicalCourse = { kind: "course", stages: [{ start: relative(0, unit), administrations: [member] }] };
      const anchor = "2026-11-01T06:30:00Z";
      const opts = { from: anchor, orderedAt: anchor, timeZone: "America/New_York", limit: 3 };
      expect(nextDueDoses(course, opts)).toEqual(["2026-11-01T01:30:00-05:00"]);
      expect(supply(course, 1, opts).totalUnits).toBe(1);
    });
    it("orders a midnight clock before the previous dinner's shifted clock", () => {
      const member = dose(); member.schedule!.recurrence!.clocks = ["00:15:00"];
      member.schedule!.recurrence!.anchors = [EventTiming["After Dinner"]];
      const opts = { ...options, from: "2026-01-02T00:00:00Z", eventClock: { CV: "23:30" }, mealOffsets: { PCV: 60 } };
      expect(nextDueDoses(member, { ...opts, limit: 1 })).toEqual(["2026-01-02T00:15:00+00:00"]);
      expect(nextDueDoses(member, { ...opts, limit: 4 })).toEqual([
        "2026-01-02T00:15:00+00:00", "2026-01-02T00:30:00+00:00",
        "2026-01-03T00:15:00+00:00", "2026-01-03T00:30:00+00:00",
      ]);
      member.schedule!.recurrence!.occurrenceCap = { max: 1, period: 1, periodUnit: Unit.Day };
      expect(nextDueDoses(member, { ...opts, limit: 2 })).toEqual([
        "2026-01-02T00:15:00+00:00", "2026-01-03T00:15:00+00:00",
      ]);
    });
    it("normalizes an extracted native active-window component like its complete course", () => {
      const wire: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: { frequency: 21, period: 28, periodUnit: Unit.Day,
          startOffset: { value: 2, unit: "d", code: "d" }, endOffset: { value: 5, unit: "d", code: "d" } } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      }] }] };
      const batch = fromFhir(wire), native = batch.items[0].meta.canonical.administration!;
      const anchor = "2026-11-02T00:00:00+07:00";
      const opts = { from: anchor, orderedAt: anchor, timeZone: "Asia/Bangkok", limit: 3 };
      for (const input of [wire, toFhirR5Dosages(wire), batch, native]) {
        expect(nextDueDoses(input, opts)).toEqual([
          "2026-11-04T00:00:00+07:00", "2026-11-05T00:00:00+07:00", "2026-11-06T00:00:00+07:00",
        ]);
        expect(calculateTotalUnits({ dosage: input, ...opts, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(0);
        expect(calculateTotalUnits({ dosage: input, ...opts, durationValue: 28, durationUnit: Unit.Day }).totalUnits).toBe(21);
      }
    });
  });

  describe("quantity dimensions and scoped ceilings", () => {
    it.each(["มิลลิลิตร", undefined])("keeps the coded rate-ratio numerator dimension with display %s", unit => {
      const member = dose();
      member.amounts = [{ rateRatio: { numerator: { value: 10, code: "mL", system: "http://unitsofmeasure.org", unit },
        denominator: { value: 1, code: "h", system: "http://unitsofmeasure.org", unit: "hour" } } }];
      member.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Day,
        clocks: ["08:00:00", "20:00:00"], occurrenceDuration: 1, occurrenceDurationUnit: Unit.Hour };
      member.limits = [{ scope: "period", amount: { value: 10, unit: "mL" }, period: { value: 24, unit: "h" } }];
      expect(nextDueDoses(member, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      ]);
      expect(supply(member, 1).totalUnits).toBe(10);
    });
    it.each(["tablet ", " TABLETS", "tab"])("applies a range maximum expressed as %s", unit => {
      const member = ranged(1, 3); member.limits = [{ scope: "administration", amount: { value: 2, unit } }];
      expect(supply(member, 1).totalUnits).toBe(2);
      member.limits = [{ scope: "lifetime", amount: { value: 2, unit } }];
      expect(supply(member, 3).totalUnits).toBe(2);
    });
    it("retains an incompatible ceiling without treating it as a numeric tablet cap", () => {
      const member = ranged(1, 3); member.limits = [{ scope: "administration", amount: { value: 2, unit: "mL" } }];
      expect(supply(member, 1).totalUnits).toBe(3);
      expect(supply(member, 1).explanation).toContain("could not be applied");
      expect(member.limits[0].amount).toEqual({ value: 2, unit: "mL" });
    });
  });

  describe("joint ranged allocation", () => {
    it("allocates 1.5 plus 1.5 across two authored clocks", () => {
      expect(supply(ranged(), 2).totalUnits).toBe(3);
    });
    it("jointly allocates across daily repeated phases", () => {
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
        stages: [{ start: relative(0), end: relative(1), administrations: [ranged()] }] };
      expect(supply(course, 2).totalUnits).toBe(3);
      expect(supply(course, 4).totalUnits).toBe(6);
    });
    it("maximizes total quantity separately from admitting the most feasible clocks", () => {
      // Consecutive days share a 36-hour cap; day 1 and day 3 do not.
      // Three 1-tablet doses are feasible, but the true maximum is 2 + 0 + 2.
      expect(supply(ranged(1, 2, 2, 36), 3).totalUnits).toBe(4);
    });
    it("keeps the all-slot proof for a longer alternating quantity plan", () => {
      expect(supply(ranged(1, 2, 3, 48), 50).totalUnits).toBe(75);
    });
    it("intersects multiple rolling windows while allocating the timed range", () => {
      const member = ranged();
      member.limits!.push({ scope: "period", amount: { value: 4.5, unit: "tab" }, period: { value: 72, unit: "h" } });
      expect(supply(member, 4).totalUnits).toBe(6);
    });
    it("keeps a finite counted phase completion after joint quantity allocation", () => {
      const member = ranged(); member.schedule!.recurrence!.count = 2;
      const successor = dose(); successor.schedule!.recurrence!.clocks = ["09:00:00"];
      successor.schedule!.recurrence!.count = 1;
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 4, unit: "d" },
        stages: [{ administrations: [member] }, { administrations: [successor] }] };
      expect(supply(course, 2).totalUnits).toBe(4);
    });
    it("enforces strict upper endpoints on timed plans and accepts an interior optimum", () => {
      const member = ranged(1, 2); member.amounts![0].range!.high!.comparator = "<";
      expect(() => supply(member, 1)).toThrow(/no attainable maximum/);
      expect(supply(member, 2).totalUnits).toBe(3);
    });
    it("deduplicates recorded ranged history in repeated chronological supply too", () => {
      const member = ranged(1, 2, 6, 72); member.schedule!.recurrence!.count = 3;
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" },
        stages: [{ start: relative(0), end: relative(7), administrations: [member] }] };
      expect(supply(course, 1, { from: "2026-01-03T00:00:00Z",
        priorDoseTimes: ["2026-01-01T08:00:00Z"] }).totalUnits).toBe(2);
    });
    it("counts an actual administration once while replaying unmatched finite opportunities", () => {
      const member = ranged(1, 2, 6, 72); member.schedule!.recurrence!.count = 3;
      expect(supply(member, 1, { from: "2026-01-03T00:00:00Z", priorDoseTimes: ["2026-01-01T08:00:00Z"] }).totalUnits).toBe(2);
      expect(supply(member, 1, { from: "2026-01-03T00:00:00Z", priorCount: 1,
        priorDoseTimes: ["2026-01-01T08:00:00Z"] }).totalUnits).toBe(2);
      expect(supply(member, 1, { from: "2026-01-03T00:00:00Z", priorCount: 3,
        priorDoseTimes: ["2026-01-01T08:00:00Z"] }).totalUnits).toBe(0);
    });
    it("distinguishes an unattained strict upper supremum from a smaller attainable maximum", () => {
      const member = ranged(1, 2, 3, 24); member.asNeeded = true;
      member.schedule!.recurrence = { occurrenceCap: { max: 1, period: 1, periodUnit: Unit.Day } };
      member.amounts![0].range!.high!.comparator = "<";
      expect(() => supply(member, 1)).toThrow(/no attainable maximum/);
      member.amounts![0].range!.high!.comparator = "<=";
      expect(supply(member, 1).totalUnits).toBe(2);
      member.amounts![0].range!.high!.comparator = "<";
      member.limits![0].amount!.value = 1.5;
      expect(supply(member, 1).totalUnits).toBe(1.5);
      member.limits = [{ scope: "administration", amount: { value: 1.5, unit: "tab" } },
        { scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }];
      expect(supply(member, 1).totalUnits).toBe(1.5);
    });
  });

  describe("untimed capacity inside repeated windows", () => {
    const prn = (): CanonicalAdministration => ({ ...dose(), asNeeded: true,
      schedule: { recurrence: { occurrenceCap: { max: 1, period: 1, periodUnit: Unit.Day } } } });
    it("retains seven daily PRN allowances without creating due times", () => {
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "wk" },
        stages: [{ start: relative(0), end: relative(7), administrations: [prn()] }] };
      expect(supply(course, 7)).toMatchObject({ totalUnits: 7, quantityKind: "maximum" });
      expect(supply(course, 14).totalUnits).toBe(14);
      expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
    });
    it.each([undefined, 1])("allocates untimed ranges jointly across windows with countMax %s", countMax => {
      const member = ranged(); member.asNeeded = true;
      member.schedule!.recurrence = { occurrenceCap: { max: 1, period: 1, periodUnit: Unit.Day } };
      member.schedule!.recurrence!.countMax = countMax;
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
        stages: [{ start: relative(0), end: relative(1), administrations: [member] }] };
      expect(supply(course, 2).totalUnits).toBe(3);
      member.amounts![0].range!.low!.value = 1;
      member.amounts![0].range!.high!.comparator = "<";
      expect(supply(course, 2).totalUnits).toBe(3);
      expect(nextDueDoses(course, { ...options, limit: 2 })).toEqual([]);
    });
    it("keeps each binding two-day count budget while maximizing ranged supply", () => {
      const member = ranged(1.5, 2, 3, 96); member.asNeeded = true;
      member.schedule!.recurrence = { countMax: 1, occurrenceCap: { max: 1, period: 1, periodUnit: Unit.Day } };
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 2, unit: "d" },
        stages: [{ start: relative(0), end: relative(2), administrations: [member] }] };
      const retained = JSON.stringify(course);
      // One dose per source window: 1.5 in days 1–2 and 1.5 in days 3–4.
      expect(supply(course, 4).totalUnits).toBe(3);
      expect(supply(course, 2).totalUnits).toBe(2);
      expect(supply(course, 4, { priorDoseTimes: ["2026-01-01T08:00:00Z"] }).totalUnits).toBe(0);
      expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
      expect(member.schedule?.recurrence?.countMax).toBe(1);
      expect(JSON.stringify(course)).toBe(retained);
    });
    it("combines timed and untimed members in their resolved windows", () => {
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "wk" },
        stages: [{ start: relative(0), end: relative(7), administrations: [prn(), dose(2)] }] };
      expect(supply(course, 7)).toMatchObject({ totalUnits: 21, quantityKind: "maximum" });
      expect(nextDueDoses(course, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      ]);
    });
  });

});

describe("review 24: phase history, dimensions, and independent supply oracles", () => {
  it("retains mixed-unit parallel duration ranges without a day-one cut", () => {
    const text = "1 drop OD q2h x1d then 1 drop OD QID; 1 drop OS QID x1mo then 1 drop OS BID";
    const plan = createBoundaryPlan(text);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, text);
    const clauses = states.map(state => state.primaryClause);
    clauses[0].schedule!.durationMax = 1;
    clauses[0].schedule!.durationMaxUnit = "wk";
    expect(buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph).kind).toBe("unresolved");
    expect(clauses[0].schedule).toMatchObject({
      period: 2, periodUnit: "h", duration: 1, durationUnit: "d", durationMax: 1, durationMaxUnit: "wk",
    });
    clauses[0].schedule!.durationMaxUnit = "d";
    const exact = buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph);
    expect(exact.kind).toBe("resolved");
    if (exact.kind === "resolved") {
      expect(exact.stages[0].end).toEqual({ value: 1, unit: "d" });
      expect(exact.stages[0].components[0].clause.schedule?.durationMaxUnit).toBeUndefined();
    }
    clauses[0].schedule!.durationIsRange = true;
    clauses[0].schedule!.durationMax = undefined;
    clauses[0].schedule!.durationMaxUnit = undefined;
    expect(buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph).kind).toBe("unresolved");
    expect(clauses[0].schedule).toMatchObject({ duration: 1, durationUnit: "d", durationIsRange: true });
  });
  it.each(["approximate", "range"] as const)("preserves independent origins from a typed %s duration compiler input", kind => {
    // This is the typed clause/compiler boundary, not a claim that the public
    // grammar parses an approximate-duration surface or a native editing API.
    const text = "1 drop OS QID x10d then 1 drop OS BID; 1 drop OD BID x7d then 1 drop OD QID";
    const plan = createBoundaryPlan(text);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, text);
    const clauses = states.map(state => state.primaryClause);
    if (kind === "approximate") clauses[0].schedule!.durationComparator = "~";
    else {
      clauses[0].schedule!.durationMax = 14;
      clauses[0].schedule!.durationMaxUnit = Unit.Day;
      clauses[0].schedule!.durationIsRange = true;
    }
    const parallel = buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph);
    expect(parallel.kind).toBe("unresolved");
    if (parallel.kind !== "unresolved") return;
    const native = courseFromPartialParallel(parallel, plan.segments.map(segment => segment.text), text);
    const projected = projectCanonicalCourse(native);
    for (const [label, course] of [["native", native], ["R6", courseFromR6(projected.fhirNext)],
      ["stored R5", importCanonicalCourse(JSON.parse(JSON.stringify(projected.fhir)))]] as const) {
      const members = course.stages.flatMap(stage => stage.administrations);
      const right = members.filter(a => a.target?.text === "right eye");
      const left = members.filter(a => a.target?.text === "left eye");
      expect(right, label).toHaveLength(2); expect(left, label).toHaveLength(2);
      expect(right[0].schedule?.recurrence?.courseLength?.value, label).toBe(7);
      expect(right[1].phaseOrigin?.value, label).toBe(7);
      expect(right[1].phaseOrigin?.code ?? right[1].phaseOrigin?.unit, label).toBe("d");
      expect(left[1].phaseStart?.anchor, label).toBe("unresolved");
      expect(left[1].phaseOrigin, label).toBeUndefined();
      if (kind === "approximate") {
        const length = left[0].schedule?.recurrence?.courseLength;
        expect(length, label).toMatchObject({ value: 10, comparator: "~" });
        expect(length?.code ?? length?.unit, label).toBe("d");
      } else {
        const range = left[0].schedule?.recurrence?.courseLengthRange;
        expect(range, label).toMatchObject({ low: { value: 10 }, high: { value: 14 } });
        expect(range?.low?.code ?? range?.low?.unit, label).toBe("d");
        expect(range?.high?.code ?? range?.high?.unit, label).toBe("d");
      }
      expect(nextDueDoses(right[1], { ...options, limit: 4 }), label).toEqual([
        "2026-01-08T08:00:00+00:00", "2026-01-08T12:00:00+00:00",
        "2026-01-08T16:00:00+00:00", "2026-01-08T20:00:00+00:00",
      ]);
      expect(() => nextDueDoses(course, options), label).toThrow(/treatment-start offset/);
    }
  });

  const infusionRatio = (n?: "<" | "<=" | ">" | ">=", d?: "<" | "<=" | ">" | ">="): CanonicalAdministration => ({
    ...dose(), amounts: [{ rateRatio: {
      numerator: { value: 10, unit: "mL", comparator: n }, denominator: { value: 1, unit: "h", comparator: d },
    } }],
    schedule: { recurrence: { count: 1, clocks: ["09:00:00"],
      occurrenceDuration: 2, occurrenceDurationUnit: Unit.Hour } },
  });
  it("uses the reciprocal denominator bound for rate-ratio supply", () => {
    expect(supply(infusionRatio(), 1)).toMatchObject({ totalUnits: 20, unit: "mL" });
    expect(supply(infusionRatio(undefined, ">="), 1))
      .toMatchObject({ totalUnits: 20, unit: "mL", quantityKind: "maximum" });
    expect(() => supply(infusionRatio(undefined, "<="), 1)).toThrow(/lower bound/);
  });
  it("combines only determined numerator and denominator bounds", () => {
    expect(supply(infusionRatio("<=", ">="), 1)).toMatchObject({ totalUnits: 20, quantityKind: "maximum" });
    expect(() => supply(infusionRatio(">=", "<="), 1)).toThrow(/lower bound/);
    expect(() => supply(infusionRatio("<=", "<="), 1)).toThrow(/rate ratio.*bound/i);
    expect(() => supply(infusionRatio(">=", ">="), 1)).toThrow(/rate ratio.*bound/i);
  });
  const loadingCourse = (count = 1): CanonicalCourse => {
    const loading = dose(2); loading.schedule!.recurrence!.count = count;
    return { kind: "course", stages: [{ administrations: [loading] }, { administrations: [dose()] }] };
  };
  it.each([undefined, 1])("opens maintenance after recorded loading (priorCount=%s)", priorCount => {
    expect(nextDueDoses(loadingCourse(), { ...options, from: "2026-01-02T00:00:00Z",
      priorCount, priorDoseTimes: ["2026-01-01T09:00:00Z"], limit: 2 })).toEqual([
      "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
  });
  it("uses delayed actual loading completion and keeps no-history cadence", () => {
    expect(nextDueDoses(loadingCourse(), { ...options, from: "2026-01-04T00:00:00Z",
      priorCount: 1, priorDoseTimes: ["2026-01-03T15:00:00Z"], limit: 2 })).toEqual([
      "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
    ]);
    expect(nextDueDoses(loadingCourse(), { ...options, limit: 3 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
  });
  it("finishes the remaining loading dose before maintenance", () => {
    expect(nextDueDoses(loadingCourse(2), { ...options, from: "2026-01-02T00:00:00Z",
      priorCount: 1, priorDoseTimes: ["2026-01-01T09:00:00Z"], limit: 3 })).toEqual([
      "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
    ]);
  });
  it("calculates an upper-duration-only infusion inside a bounded course", () => {
    const infusion: CanonicalAdministration = { ...dose(), amounts: [{ rate: { value: 10, unit: "mL/h" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00"],
        occurrenceDurationMax: 2, occurrenceDurationUnit: Unit.Hour } } };
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: relative(0), end: relative(2), administrations: [infusion] },
    ] };
    expect(supply(course, 2)).toMatchObject({ totalUnits: 40, unit: "mL", quantityKind: "maximum" });
    expect(supply(course, 2).explanation).toContain("upper bound of the infusion-duration range");
    infusion.schedule!.recurrence!.occurrenceDurationMax = undefined;
    expect(() => supply(course, 2)).toThrow(/infusion duration/i);
  });
  it.each([false, true])("counts eligible calendar doses in an explicit stage (later=%s)", later => {
    const member = dose();
    member.schedule!.recurrence!.calendarWindow = { start: "2026-01-01", end: "2026-01-10" };
    member.schedule!.recurrence!.count = 2;
    const course: CanonicalCourse = { kind: "course", stages: [
      ...(later ? [{ start: relative(0), end: relative(1), administrations: [dose(3)] }] : []),
      { start: relative(3), administrations: [member] },
    ] };
    const from = "2026-01-02T00:00:00Z";
    expect(nextDueDoses(course, { ...options, from, limit: 5 })).toEqual([
      "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
    ]);
    expect(supply(course, 8, { from }).totalUnits).toBe(2);
    expect(nextDueDoses(course, { ...options, from: "2026-01-05T00:00:00Z",
      priorDoseTimes: ["2026-01-02T09:00:00Z"], limit: 5 })).toEqual(["2026-01-05T09:00:00+00:00"]);
  });
  it("separates first-stage calendar cadence from explicit eligibility", () => {
    const member = dose();
    member.schedule!.recurrence!.calendarWindow = { start: "2026-01-01", end: "2026-01-10" };
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: relative(3), end: relative(6), administrations: [member] },
    ] };
    expect(nextDueDoses(course, { ...options, limit: 10 })).toEqual([
      "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00", "2026-01-06T09:00:00+00:00",
    ]);
    expect(supply(course, 7).totalUnits).toBe(3);
    course.stages[0].start = undefined;
    expect(nextDueDoses(course, { ...options, limit: 1 })).toEqual(["2026-01-01T09:00:00+00:00"]);
  });
  it("keeps pre-query PRN allowance but consumes recorded administrations", () => {
    const member = dose(); member.asNeeded = true;
    member.schedule!.recurrence!.count = 2;
    member.schedule!.recurrence!.courseLength = { value: 7, unit: "d" };
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 1, unit: "d" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      cycleCount: 1, stages: [{ administrations: [member] }] };
    const late = { from: "2026-01-03T00:00:00Z" };
    expect(nextDueDoses(course, { ...options, ...late, limit: 3 })).toEqual([
      "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
    ]);
    expect(supply(course, 2, late).totalUnits).toBe(2);
    const recorded = { ...late, priorDoseTimes: ["2026-01-02T09:00:00Z"] };
    expect(nextDueDoses(course, { ...options, ...recorded, limit: 3 })).toEqual(["2026-01-03T09:00:00+00:00"]);
    expect(supply(course, 2, recorded).totalUnits).toBe(1);
    const delayedRecorded = { ...late, priorDoseTimes: ["2026-01-01T12:00:00Z"] };
    expect(nextDueDoses(course, { ...options, ...delayedRecorded, limit: 3 }))
      .toEqual(["2026-01-03T09:00:00+00:00"]);
    expect(supply(course, 2, delayedRecorded).totalUnits).toBe(1);
    member.asNeeded = false;
    expect(nextDueDoses(course, { ...options, ...late, limit: 3 })).toEqual([]);
    expect(supply(course, 2, late).totalUnits).toBe(0);
  });
  it("opens maintenance from the recorded completion of a capped PRN loading phase", () => {
    const loading = dose(); loading.asNeeded = true;
    loading.schedule!.recurrence!.count = 1;
    loading.schedule!.recurrence!.courseLength = { value: 7, unit: "d" };
    loading.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 1, unit: "d" } }];
    const maintenance = dose(2);
    maintenance.schedule!.recurrence!.courseLength = { value: 3, unit: "d" };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    const history = { from: "2026-01-02T00:00:00Z", priorDoseTimes: ["2026-01-01T12:00:00Z"] };
    expect(nextDueDoses(course, { ...options, ...history, limit: 2 })).toEqual([
      "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
    expect(supply(course, 2, history).totalUnits).toBe(4);
  });

  it.each([[2, 2], [3, 1]])("rejects conflicting BID and %s per %s days in both APIs", (frequency, period) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID" }] },
        repeat: { frequency, period, periodUnit: Unit.Day } } };
    const currentR6: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: row.doseAndRate, timing: row.timing,
    }] }] };
    for (const input of [row, currentR6]) {
      const original = JSON.stringify(input);
      expect(() => nextDueDoses(input, { ...options, limit: 4 })).toThrow(/timing code.*repeat/i);
      expect(() => calculateTotalUnits({ ...options, dosage: input, durationValue: 2, durationUnit: Unit.Day }))
        .toThrow(/timing code.*repeat/i);
      expect(JSON.stringify(input)).toBe(original);
    }
  });
  it.each(["full", "missing period", "code only"])("preserves compatible/incomplete BID clocks (%s)", variant => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ code: "BID" }] }, ...(variant === "code only" ? {} : {
        repeat: { frequency: 2, ...(variant === "full" ? { period: 1, periodUnit: Unit.Day } : {}) },
      }) } };
    if (variant === "full") {
      expect(nextDueDoses(row, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: row, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
    } else {
      // An incomplete repeat is not contradictory; this change does not invent
      // previously unsupported execution semantics for a code-only instruction.
      expect(() => nextDueDoses(row, { ...options, limit: 2 })).not.toThrow(/timing code.*repeat/i);
      expect(() => calculateTotalUnits({ ...options, dosage: row, durationValue: 2, durationUnit: Unit.Day }))
        .not.toThrow(/timing code.*repeat/i);
    }
  });
  it("subtracts the upper assumed prior ranged amount from the lifetime ceiling", () => {
    const member = dose();
    member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
    member.limits = [{ scope: "lifetime", amount: { value: 6, unit: "tab" } }];
    const before = JSON.stringify(member);
    expect(supply(member, 10).totalUnits).toBe(6);
    expect(supply(member, 10, { priorDoseTimes: ["2025-12-31T09:00:00Z"] }).totalUnits).toBe(4);
    expect(supply(member, 10, { priorDoseTimes: ["2025-12-30T09:00:00Z", "2025-12-31T09:00:00Z"] }).totalUnits).toBe(2);
    expect(JSON.stringify(member)).toBe(before);
  });
});

describe("round 25 execution boundary and history oracles", () => {
  it.each([1, 2])("replays %s actual PRN loading doses when no nominal clock lies inside its window", count => {
    const loading = dose(); loading.asNeeded = true;
    loading.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: Unit.Day,
      clocks: ["08:00:00"], count, courseLength: { value: 23, unit: "h" } };
    loading.limits = [{ scope: "period", amount: { value: count, unit: "tab" }, period: { value: 1, unit: "d" } }];
    const maintenance = dose(2); maintenance.schedule!.recurrence!.clocks = ["10:00:00"];
    maintenance.schedule!.recurrence!.courseLength = { value: 3, unit: "d" };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    const query = { orderedAt: "2026-01-01T08:30:00Z", from: "2026-01-01T09:15:00Z", timeZone: "UTC", limit: 2 };
    const actual = count === 1 ? ["2026-01-01T09:00:00Z"] :
      ["2026-01-01T09:00:00Z", "2026-01-01T09:05:00Z"];
    expect(nextDueDoses(course, { ...query, priorDoseTimes: actual })).toEqual([
      "2026-01-01T10:00:00+00:00", "2026-01-02T10:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: course, priorDoseTimes: actual,
      durationValue: 4, durationUnit: Unit.Hour }).totalUnits).toBe(2);
    if (count === 2)
      expect(nextDueDoses(course, { ...query, limit: 1, priorDoseTimes: actual.slice(0, 1) }))
        .toEqual(["2026-01-02T10:00:00+00:00"]);
    expect(nextDueDoses(course, { ...query, limit: 1 })).toEqual(["2026-01-02T10:00:00+00:00"]);
    expect(nextDueDoses(course, { ...query, limit: 1, priorDoseTimes: ["2026-01-01T08:00:00Z"] }))
      .toEqual(["2026-01-02T10:00:00+00:00"]);
  });

  const shiftedBedtime = (): CanonicalAdministration => ({
    ...dose(), schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day,
      anchors: [EventTiming["Before Sleep"]], offset: 60 } },
  });
  const bedtime = { eventClock: { [EventTiming["Before Sleep"]]: "00:30" } };
  it("counts a negative-shift administration before a later nominal anchor", () => {
    const member = shiftedBedtime(); member.schedule!.recurrence!.count = 2;
    const query = { orderedAt: "2026-01-01T23:00:00Z", from: "2026-01-02T00:00:00Z", timeZone: "UTC", ...bedtime };
    expect(nextDueDoses(member, { ...query, limit: 5 })).toEqual(["2026-01-02T23:30:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: member, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
  });
  it("includes an in-window administration whose bedtime anchor is beyond the supply end", () => {
    const member = shiftedBedtime();
    const query = { orderedAt: "2026-01-01T23:00:00Z", from: "2026-01-01T23:00:00Z", timeZone: "UTC", ...bedtime };
    expect(nextDueDoses(member, { ...query, limit: 1 })).toEqual(["2026-01-01T23:30:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: member, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(1);
    expect(calculateTotalUnits({ ...query, dosage: member, durationValue: 30, durationUnit: Unit.Minute }).totalUnits).toBe(0);
  });

  it.each([1, 2])("finds ongoing elapsed frequency periods independently of limit %s", limit => {
    const member = dose(); member.schedule!.recurrence = { frequency: 2, period: 24, periodUnit: Unit.Hour };
    const query = { orderedAt: "2025-01-01T00:00:00Z", from: "2026-02-01T00:00:00Z", timeZone: "UTC" };
    expect(nextDueDoses(member, { ...query, limit })).toEqual([
      "2026-02-01T00:00:00+00:00", "2026-02-01T12:00:00+00:00",
    ].slice(0, limit));
  });
  it("keeps calendar period lookup out of the result enumeration budget", () => {
    const member = dose(); member.schedule!.recurrence = { frequency: 2, period: 2, periodUnit: Unit.Day };
    expect(nextDueDoses(member, { orderedAt: "2024-01-01T08:00:00Z", from: "2026-02-01T00:00:00Z",
      timeZone: "UTC", limit: 1 })).toEqual(["2026-02-01T08:00:00+00:00"]);
  });

  it("subtracts recorded in-phase PRN use from supply as well as due opportunities", () => {
    const member = dose(); member.asNeeded = true; member.schedule!.recurrence!.count = 2;
    const late = { from: "2026-01-02T00:00:00Z" };
    const history = { ...late, priorDoseTimes: ["2026-01-01T09:00:00Z"] };
    expect(nextDueDoses(member, { ...options, ...history, limit: 4 })).toEqual(["2026-01-02T09:00:00+00:00"]);
    expect(supply(member, 3, history).totalUnits).toBe(1);
    expect(supply(member, 3, late).totalUnits).toBe(2);
    expect(supply(member, 3, { ...late, priorDoseTimes: ["2025-12-31T09:00:00Z"] }).totalUnits).toBe(2);
    expect(supply(member, 3, { ...history, priorCount: 0 }).totalUnits).toBe(2);
  });

  it.each([false, true])("compares alternative chronological plans by quantity in a common unit (reverse %s)", reverse => {
    const grams = dose(); grams.amounts![0].quantity = { value: 1, unit: "g" };
    grams.schedule!.recurrence = { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
      clocks: ["06:00:00"], courseLength: { value: 2, unit: "d" } };
    grams.limits = [{ scope: "period", amount: { value: 2, unit: "g" }, period: { value: 1, unit: "d" } }];
    const milligrams = dose(); milligrams.amounts![0].quantity = { value: 100, unit: "mg" };
    milligrams.schedule!.recurrence!.clocks = ["06:30:00"];
    milligrams.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: reverse ? [milligrams, grams] : [grams, milligrams] }] };
    expect(calculateTotalUnits({ ...options, from: "2026-01-01T06:00:00Z",
      dosage: course, durationValue: 1, durationUnit: Unit.Hour })).toMatchObject({ totalUnits: 1.1, unit: "g" });
  });

  it("preserves an unlowered fractional terminal duration in all parallel projections", () => {
    const text = "1 drop OD q2h for 7 days then 1 drop OD BID for 1.5 days; 1 drop OS QID for 1 month then 1 drop OS BID";
    const plan = createBoundaryPlan(text);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, text);
    const clauses = states.map(state => state.primaryClause);
    expect(clauses[1].schedule).toMatchObject({ duration: 1.5, durationUnit: "d", frequency: 2 });
    const projected = projectParallelRegimen(buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph),
      plan.segments.map(segment => segment.text), text);
    expect(projected.kind).toBe("resolved");
    if (projected.kind !== "resolved") return;
    const terminal = projected.canonical.stages.flatMap(stage => stage.administrations)
      .filter(member => member.schedule?.recurrence?.frequency === 2 &&
        member.phaseOrigin?.value === 7);
    expect(terminal.length).toBeGreaterThan(0);
    for (const member of terminal) expect(member.schedule?.recurrence?.courseLength).toMatchObject({ value: 1.5, unit: "d" });
    for (const rows of [projected.dosages, (projected.details.step ?? []).flatMap(step => step.component)]) {
      const terminalRows = rows.filter(row => row.timing?.repeat?.frequency === 2 &&
        row.timing?.repeat?.boundsDuration?.value === 1.5);
      expect(terminalRows.length).toBe(terminal.length);
      for (const row of terminalRows) expect(row.timing?.repeat?.boundsDuration?.code).toBe("d");
    }
  });

  it("selects the period-specific institutional frequency mapping without adding generic clocks", () => {
    const member = dose(); member.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Day };
    const config = { frequencyDefaults: { byFrequency: { "freq:2/per:1d": ["07:00", "19:00"] } } };
    expect(nextDueDoses(member, { ...options, ...config, limit: 2 })).toEqual([
      "2026-01-01T07:00:00+00:00", "2026-01-01T19:00:00+00:00",
    ]);
    expect(supply(member, 1, config).totalUnits).toBe(2);
    expect(nextDueDoses(member, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
  });

  it.each(["ordinary", "repeated", "explicit end"] as const)("gives independently delayed members their full authored course (%s)", mode => {
    const early = dose(); early.schedule!.recurrence!.courseLength = { value: 7, unit: "d" };
    const late = dose(2); late.delayMinutes = 2 * 1440;
    late.schedule!.recurrence!.courseLength = { value: 7, unit: "d" };
    if (mode === "repeated") {
      early.limits = [{ scope: "period", amount: { value: 100, unit: "tab" }, period: { value: 1, unit: "d" } }];
      late.limits = early.limits;
    }
    const course = courseFromAdministrations([early, late], "");
    expect(course.stages[0].end).toBeUndefined();
    if (mode === "explicit end") course.stages[0].end = relative(4);
    if (mode === "repeated") {
      course.cycleInterval = { value: 7, unit: "d" }; course.cycleCount = 1;
    }
    const expected = Array.from({ length: mode === "explicit end" ? 4 : 9 }, (_, i) => {
      const at = "2026-01-" + String(i + 1).padStart(2, "0") + "T09:00:00+00:00";
      return [...(i < 7 ? [at] : []), ...(i >= 2 ? [at] : [])];
    }).flat();
    for (const [label, input] of [["canonical", course], ["R5", courseToR5(course)], ["R6", courseToR6(course)]] as const) {
      expect(nextDueDoses(input, { ...options, limit: 20 }), label).toEqual(expected);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 14, durationUnit: Unit.Day }).totalUnits, label).toBe(mode === "explicit end" ? 8 : 21);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 7, durationUnit: Unit.Day }).totalUnits, label).toBe(mode === "explicit end" ? 8 : 17);
    }
  });

  it.each(["lower", "exact", "upper"] as const)("uses only an actual upper course boundary (%s)", kind => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"],
        ...(kind === "exact" ? { boundsDuration: { value: 5, code: "d" } }
          : { boundsRange: { [kind === "lower" ? "low" : "high"]: { value: 5, code: "d" } } }),
      } } };
    const original = JSON.stringify(row);
    expect(calculateTotalUnits({ ...options, dosage: row, durationValue: 7, durationUnit: Unit.Day }).totalUnits)
      .toBe(kind === "lower" ? 7 : 5);
    expect(nextDueDoses(row, { ...options, from: "2026-01-06T00:00:00Z", limit: 1 }))
      .toEqual(kind === "lower" ? ["2026-01-06T09:00:00+00:00"] : []);
    expect(JSON.stringify(row)).toBe(original);
  });
  it.each(["<", "<=", ">", ">="] as const)("refuses due timestamps for an unresolved %s cap period while explaining supply", comparator => {
    const member = dose();
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" },
      period: { value: 2, unit: "d", comparator } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [{ ...member, schedule: { recurrence: {
        ...member.schedule!.recurrence, courseLength: { value: 4, unit: "d" },
      } } }] }] };
    for (const input of [member, course]) {
      const original = JSON.stringify(input);
      // Even if shared caller options also contain a supply horizon, the due
      // API cannot silently return a schedule with an unresolved ceiling.
      const query = { ...options, durationValue: 4, durationUnit: Unit.Day, limit: 4 };
      expect(() => nextDueDoses(input, query))
        .toThrow(expect.objectContaining({ code: "unresolved-cap-period" }));
      expect(supply(input, 4)).toMatchObject({ totalUnits: 4, quantityKind: "maximum",
        explanation: expect.stringContaining("could not be applied") });
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it.each([undefined, "~"] as const)("uses the nominal exact/approximate cap period (%s)", comparator => {
    const member = dose();
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" },
      period: { value: 2, unit: "d", ...(comparator ? { comparator } : {}) } }];
    expect(nextDueDoses(member, { ...options, limit: 2 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
    expect(supply(member, 4).totalUnits).toBe(2);
  });

});


describe("round 26 execution admission and calendar oracles", () => {
  it.each([undefined, true, false])("preserves an R6 PRN indication separately from its flag (%s)", flag => {
    const wire: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      asNeededFor: [{ text: "pain" }], ...(flag === undefined ? {} : { asNeeded: flag }),
    }] }] };
    const before = JSON.stringify(wire);
    const imported = fromFhir(wire, { realizationMode: "normalized", locale: "en" });
    const clause = clauseForAdministration(courseFromR6(wire, true).stages[0].administrations[0]);
    if (flag === false) {
      expect(clause.prn).toBeUndefined();
      expect(imported.longText).not.toMatch(/as needed/i);
    } else {
      expect(clause.prn).toMatchObject({ enabled: true, reasons: [{ text: "pain" }] });
      expect(imported.longText).toMatch(/as needed.*pain/i);
    }
    expect(imported.fhirNext.step![0].component[0].asNeeded).toBe(flag);
    expect(imported.fhirNext.step![0].component[0].asNeededFor).toEqual([{ text: "pain" }]);
    expect(JSON.stringify(wire)).toBe(before);
  });

  it.each([
    [undefined, true, true], [true, false, true], [false, true, false], [undefined, false, false],
  ] as const)("uses reason-only PRN semantics without decoded source context (%s/%s)", (flag, reason, prn) => {
    const wire: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count: 2, frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"] } },
      ...(reason ? { asNeededFor: [{ text: "pain" }] } : {}), ...(flag === undefined ? {} : { asNeeded: flag }),
    }] }] };
    const query = { ...options, from: "2026-01-03T00:00:00Z", limit: 4 };
    const native = courseFromR6(wire);
    expect(native.stages[0].administrations[0].syntax).toBeUndefined();
    for (const input of [wire, native]) {
      expect(nextDueDoses(input, query)).toEqual(prn ? [
        "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
      ] : []);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: prn ? 2 : 0, quantityKind: prn ? "maximum" : "scheduled" });
      if (prn) {
        const history = { ...query, priorDoseTimes: ["2026-01-01T09:00:00Z"] };
        expect(nextDueDoses(input, history)).toEqual(["2026-01-03T09:00:00+00:00"]);
        expect(calculateTotalUnits({ ...history, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
      }
    }
    expect(courseToR6(native).step![0].component[0].asNeeded).toBe(flag);
  });

  it.each([undefined, "~", ">=", "<="] as const)("only derives an exact anchored date for an exact duration (%s)", comparator => {
    const schedule = { boundsStart: "2026-12-01", duration: 7, durationUnit: Unit.Day,
      durationComparator: comparator };
    expect(anchoredScheduleDurationEnd(schedule)).toBe(comparator ? undefined : "2026-12-07");
    expect(schedule).toEqual({ boundsStart: "2026-12-01", duration: 7,
      durationUnit: Unit.Day, durationComparator: comparator });
  });

  it("does not turn a minimum-only or mixed-unit duration range into an exact end", () => {
    const lower = { boundsStart: "2026-12-01", duration: 1, durationUnit: Unit.Week, durationIsRange: true };
    expect(anchoredScheduleDurationEnd(lower)).toBeUndefined();
    expect(anchoredScheduleDurationEnd({ ...lower, durationMax: 1, durationMaxUnit: Unit.Month })).toBeUndefined();
    expect(anchoredScheduleDurationEnd({ ...lower, durationMax: 1, durationMaxUnit: Unit.Week })).toBe("2026-12-07");
  });

  it("uses the absolute member start clock for its civil-day duration cap", () => {
    const member = dose();
    member.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"],
      calendarWindow: { start: "2026-01-01T09:00:00Z" }, courseLength: { value: 1, unit: "d" } };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 2, unit: "d" }, cycleCount: 1,
      stages: [{ start: relative(0), administrations: [member] }] };
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual(["2026-01-02T08:00:00+00:00"]);
    expect(supply(course, 2).totalUnits).toBe(1);
    expect(supply(course, 1).totalUnits).toBe(0);
  });

  it.each(["quantity", "range", "rate", "ratio"] as const)("admits the resolved per-kg %s amount before shared cap accounting", kind => {
    const member = dose();
    member.amounts = kind === "quantity" ? [{ quantity: { value: 1, unit: "mg/kg" } }] :
      kind === "range" ? [{ range: { low: { value: 0.5, unit: "mg/kg" }, high: { value: 1, unit: "mg/kg" } } }] :
      kind === "rate" ? [{ rate: { value: 0.5, unit: "mg/kg/h" } }] :
      [{ rateRatio: { numerator: { value: 1, unit: "mg/kg" }, denominator: { value: 2, unit: "h" } } }];
    member.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    if (kind === "rate" || kind === "ratio") {
      member.schedule!.recurrence!.occurrenceDuration = 2;
      member.schedule!.recurrence!.occurrenceDurationUnit = Unit.Hour;
    }
    member.limits = [{ scope: "period", amount: { value: 100, unit: "mg" }, period: { value: 24, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    const before = JSON.stringify(course);
    // At 70 kg the range is 35–70 mg. The independent maximum is
    // 70 + (35 + 65) + (35 + 65) = 270 mg under each 100 mg/24h cap.
    expect(supply(course, 3, { patientWeightKg: 70 })).toMatchObject({
      totalUnits: kind === "range" ? 270 : 210, unit: "mg",
    });
    expect(supply(course, 3).unit).toBe("mg/kg");
    expect(JSON.stringify(course)).toBe(before);
  });

  it("requires dated history when a count cannot identify its repeated-phase quota", () => {
    const member = dose(); member.asNeeded = true; member.schedule!.recurrence!.count = 2;
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 1, unit: "d" } }];
    const course: CanonicalCourse = { kind: "course", stages: [{ count: 2, administrations: [member] }] };
    const query = { ...options, from: "2026-01-02T00:00:00Z", limit: 4 };
    const original = JSON.stringify(course);
    expect(() => nextDueDoses(course, { ...query, priorCount: 1 })).toThrow(expect.objectContaining({
      code: "repeated-course-history-needs-timestamps",
    }));
    expect(() => supply(course, 4, { ...query, priorCount: 1 })).toThrow(expect.objectContaining({
      code: "repeated-course-history-needs-timestamps",
    }));
    expect(JSON.stringify(course)).toBe(original);
    expect(nextDueDoses(course, { ...query, priorDoseTimes: ["2026-01-01T09:00:00Z"] })).toEqual([
      "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
    ]);
    expect(nextDueDoses(member, { ...query, priorCount: 1 })).toEqual(["2026-01-02T09:00:00+00:00"]);
    expect(nextDueDoses(course, { ...options, priorCount: 0, limit: 2 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
    ]);
  });

  it("preserves declared getter options through capped recursion", () => {
    class Query {
      from = origin; orderedAt = origin; limit = 2;
      get timeZone() { return "UTC"; }
      get eventClock() { return { CV: "18:00" }; }
      get mealOffsets() { return { PCV: 30 }; }
    }
    const member = dose();
    member.schedule!.recurrence = { anchors: [EventTiming["After Dinner"]], frequency: 1, period: 1, periodUnit: Unit.Day };
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 2, unit: "d" } }];
    expect(nextDueDoses(member, new Query())).toEqual([
      "2026-01-01T18:30:00+00:00", "2026-01-03T18:30:00+00:00",
    ]);
    expect(nextDueDoses({ ...member, limits: undefined }, new Query())).toEqual([
      "2026-01-01T18:30:00+00:00", "2026-01-02T18:30:00+00:00",
    ]);
  });

  it("counts PRN history only after the authored calendar start", () => {
    const member = dose(); member.asNeeded = true;
    member.schedule!.recurrence!.count = 1;
    member.schedule!.recurrence!.calendarWindow = { start: "2026-01-03" };
    const query = { ...options, from: "2026-01-03T00:00:00Z", priorDoseTimes: ["2026-01-02T09:00:00Z"] };
    expect(nextDueDoses(member, { ...query, limit: 3 })).toEqual(["2026-01-03T09:00:00+00:00"]);
    expect(supply(member, 2, query).totalUnits).toBe(1);
    expect(nextDueDoses(member, { ...query, from: "2026-01-04T00:00:00Z",
      priorDoseTimes: ["2026-01-03T09:00:00Z"], limit: 3 })).toEqual([]);
  });

  it("finds the monthly allowance before a target skipped-midnight cutoff retreats", () => {
    const member: CanonicalAdministration = { ...dose(),
      schedule: { recurrence: { occurrenceCap: { max: 1, period: 1, periodUnit: Unit.Day } } },
      limits: [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 1, unit: "mo" } }],
    };
    expect(calculateTotalUnits({ dosage: member, from: "2026-10-06T00:10:00-03:00",
      orderedAt: "2026-10-06T00:10:00-03:00", timeZone: "America/Santiago",
      durationValue: 1, durationUnit: Unit.Hour,
      priorDoseTimes: ["2026-09-06T01:20:00-03:00"],
    }).totalUnits).toBe(1);
  });

  it.each([1, 4])("orders distributed shifted-clock administrations before spending limit %s", limit => {
    const member = dose();
    member.schedule!.recurrence = { frequency: 4, period: 2, periodUnit: Unit.Day,
      clocks: ["00:15:00"], anchors: [EventTiming["After Dinner"]] };
    const query = { ...options, from: "2026-01-02T00:00:00Z", eventClock: { CV: "23:30" }, mealOffsets: { PCV: 60 } };
    expect(nextDueDoses(member, { ...query, limit })).toEqual([
      "2026-01-02T00:15:00+00:00", "2026-01-02T00:30:00+00:00",
      "2026-01-03T00:15:00+00:00", "2026-01-03T00:30:00+00:00",
    ].slice(0, limit));
    member.schedule!.recurrence!.occurrenceCap = { max: 1, period: 1, periodUnit: Unit.Day };
    expect(nextDueDoses(member, { ...query, limit: 2 })).toEqual([
      "2026-01-02T00:15:00+00:00", "2026-01-03T00:15:00+00:00",
    ]);
  });
  it("merges negative distributed shifts with later same-day clocks", () => {
    const member = dose(); member.schedule!.recurrence = { frequency: 4, period: 2, periodUnit: Unit.Day,
      clocks: ["23:45:00"], anchors: [EventTiming["Before Sleep"]], offset: 60 };
    expect(nextDueDoses(member, { ...options, from: "2026-01-02T00:00:00Z",
      eventClock: { [EventTiming["Before Sleep"]]: "00:30" }, limit: 4 })).toEqual([
      "2026-01-02T23:30:00+00:00", "2026-01-02T23:45:00+00:00",
      "2026-01-03T23:30:00+00:00", "2026-01-03T23:45:00+00:00",
    ]);
  });
});


describe("round 26 independent track execution", () => {
  it("keeps four-week and one-calendar-month transitions independent", () => {
    const text = "1 drop OD q2h x4wk then qid; 1 drop OS qid x1mo then bid";
    const parsed = parseSig(text);
    const query = { ...options, from: "2026-01-29T00:00:00Z" };
    for (const input of [parsed, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      // Jan29–31: OD4 + OS4 daily; Feb1–2: OD4 + OS2 daily.
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 5, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 36, unit: "drop" });
    }
    const members = parsed.meta.canonical.course!.stages.flatMap(stage => stage.administrations);
    const right = members.find(a => a.target?.text === "right eye" && a.schedule?.recurrence?.frequency === 4)!;
    const left = members.find(a => a.target?.text === "left eye" && a.schedule?.recurrence?.frequency === 2)!;
    expect(right).toBeDefined(); expect(left).toBeDefined();
    expect(nextDueDoses(right, { ...options, limit: 4 })).toEqual([
      "2026-01-29T08:00:00+00:00", "2026-01-29T12:00:00+00:00",
      "2026-01-29T16:00:00+00:00", "2026-01-29T20:00:00+00:00",
    ]);
    expect(nextDueDoses(left, { ...options, limit: 2 })).toEqual([
      "2026-02-01T08:00:00+00:00", "2026-02-01T20:00:00+00:00",
    ]);
    expect(supply(right, 5, query).totalUnits).toBe(20);
    expect(supply(left, 5, query).totalUnits).toBe(4);
  });

  it.each([false, true])("keeps an unresolved member boundary distinct from a malformed numeric origin (calendar bound %s)", calendar => {
    const member: CanonicalAdministration = { ...dose(),
      phaseStart: { anchor: "unresolved", description: "after the left-eye initial course" } };
    if (calendar) member.schedule!.recurrence!.calendarWindow = { start: "2026-01-01" };
    const before = JSON.stringify(member);
    expect(() => nextDueDoses(member, options)).toThrow(/treatment-start offset/);
    expect(() => supply(member, 2)).toThrow(/treatment-start offset/);
    expect(member.phaseOriginIssue).toBeUndefined();
    expect(JSON.stringify(member)).toBe(before);
  });
});


describe("round 26 relative boundary precision", () => {
  it.each(["member", "step start", "step end"] as const)("requires an exact resolved instant for a %s boundary", role => {
    const configured = (boundary: CanonicalBoundary): CanonicalAdministration | CanonicalCourse =>
      role === "member" ? { ...dose(), phaseStart: boundary } : {
        kind: "course", stages: [{ administrations: [dose()],
          ...(role === "step start" ? { start: boundary } : { end: boundary }) }],
      };
    for (const range of [
      { low: { value: 7, unit: "d" }, high: { value: 10, unit: "d" } },
      { low: { value: 7, unit: "d" } }, { high: { value: 10, unit: "d" } },
    ]) {
      const input = configured({ anchor: "treatment-start", displacementRange: range });
      const before = JSON.stringify(input);
      expect(() => nextDueDoses(input, options)).toThrow(/RelativeTime.*range.*treatment-start offset/);
      expect(() => supply(input, 14)).toThrow(/RelativeTime.*range.*treatment-start offset/);
      expect(JSON.stringify(input)).toBe(before);
    }
    for (const boundary of [
      { anchor: "treatment-start", displacement: { value: 7, unit: "d" } },
      { anchor: "treatment-start", displacementRange: { low: { value: 7, unit: "d" }, high: { value: 7, unit: "d" } } },
      { anchor: "treatment-start", displacementRange: { low: { value: 1, unit: "wk" }, high: { value: 7, unit: "d" } } },
    ] satisfies CanonicalBoundary[]) {
      const input = configured(boundary);
      expect(nextDueDoses(input, { ...options,
        from: role === "step end" ? "2026-01-07T00:00:00Z" : origin, limit: 2 })).toEqual(
          role === "step end" ? ["2026-01-07T09:00:00+00:00"] : [
            "2026-01-08T09:00:00+00:00", "2026-01-09T09:00:00+00:00",
          ]);
      expect(supply(input, 10).totalUnits).toBe(role === "step end" ? 7 : 3);
    }
  });

  it("compares calendar endpoints at the actual anchor instead of averaging months", () => {
    const member: CanonicalAdministration = { ...dose(), phaseStart: { anchor: "treatment-start",
      displacementRange: { low: { value: 1, unit: "mo" }, high: { value: 28, unit: "d" } } } };
    const february = { ...options, orderedAt: "2026-02-01T00:00:00Z", from: "2026-02-01T00:00:00Z" };
    expect(nextDueDoses(member, { ...february, limit: 1 })).toEqual(["2026-03-01T09:00:00+00:00"]);
    expect(calculateTotalUnits({ ...february, dosage: member, durationValue: 29, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(() => nextDueDoses(member, options)).toThrow(/RelativeTime.*range.*treatment-start offset/);
    expect(() => supply(member, 35)).toThrow(/RelativeTime.*range.*treatment-start offset/);
  });
});

describe("round27 execution identity and measurement oracles", () => {
  it("retains inferred civil-frequency milliseconds before period fences", () => {
    const member = dose();
    member.schedule = { recurrence: { frequency: 2, period: 2, periodUnit: Unit.Day } };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    const anchor = "2026-01-01T08:00:00.500Z";
    const query = { from: anchor, orderedAt: anchor, timeZone: "UTC", limit: 4 };
    for (const input of [course, courseToR5(course), courseToR6(course)]) {
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T08:00:00.500+00:00", "2026-01-02T20:00:00.500+00:00",
        "2026-01-03T08:00:00.500+00:00", "2026-01-04T20:00:00.500+00:00",
      ]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(2);
    }
    // No institution clock list exists for 42/21d: the source-clock
    // distributor must retain the same fraction on both daily slots.
    member.schedule!.recurrence = { frequency: 42, period: 21, periodUnit: Unit.Day };
    expect(nextDueDoses(member, query)).toEqual([
      "2026-01-01T08:00:00.500+00:00", "2026-01-01T20:00:00.500+00:00",
      "2026-01-02T08:00:00.500+00:00", "2026-01-02T20:00:00.500+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: member, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
    // A fractional civil unit uses elapsed distribution. Twelve hours
    // divided by seven produces 6171428 ms and 12342857 ms offsets after flooring.
    member.schedule!.recurrence = { frequency: 7, period: 0.5, periodUnit: Unit.Day };
    expect(nextDueDoses(member, { ...query, limit: 3 })).toEqual([
      "2026-01-01T08:00:00.500+00:00", "2026-01-01T09:42:51.928+00:00",
      "2026-01-01T11:25:43.357+00:00",
    ]);
    member.schedule!.recurrence = { frequency: 2, period: 2, periodUnit: Unit.Day, clocks: ["08:00:00"] };
    expect(nextDueDoses(member, { ...query, limit: 2 })).toEqual([
      "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
    ]);
  });

  it.each(["ratio", "quantity"] as const)("sums recognized coded %s units while preserving localized labels", kind => {
    const infusion = (label: string, code = "mL"): CanonicalAdministration => {
      const quantity = { value: 10, unit: label, code, system: "http://unitsofmeasure.org" };
      return { kind: "administration",
        amounts: [kind === "quantity" ? { quantity } :
          { rateRatio: { numerator: quantity, denominator: { value: 1, unit: "h", code: "h" } } }],
        schedule: { recurrence: { count: 1, occurrenceDuration: 1, occurrenceDurationUnit: Unit.Hour } } };
    };
    const course: CanonicalCourse = { kind: "course", stages: [{
      administrations: [infusion("มิลลิลิตร"), infusion("mL")],
    }] };
    for (const input of [course, courseToR5(course), courseToR6(course)]) {
      const original = JSON.stringify(input);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 20, unit: "mL" });
      expect(JSON.stringify(input)).toBe(original);
    }
    course.stages[0].administrations[1] = infusion("mg", "mg");
    expect(() => supply(course, 1)).toThrow(expect.objectContaining({ code: "incompatible-dose-units" }));
  });

  it("matches actual history before replay admission without losing unmatched nominal doses", () => {
    const member = dose(); member.schedule!.recurrence!.clocks = ["08:00:00"];
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 48, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    const query = { ...options, from: "2026-01-02T00:00:00Z", limit: 1 };
    for (const input of [course, courseToR5(course), courseToR6(course)]) {
      const recorded = { ...query, priorDoseTimes: ["2026-01-01T08:00:00Z"] };
      expect(nextDueDoses(input, recorded)).toEqual(["2026-01-02T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...recorded, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      const unmatched = { ...query, priorDoseTimes: ["2026-01-01T07:00:00Z"] };
      expect(nextDueDoses(input, unmatched)).toEqual(["2026-01-03T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...unmatched, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    }
    member.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    member.limits[0].amount!.value = 3;
    expect(nextDueDoses(course, { ...query, limit: 2, priorDoseTimes: ["2026-01-01T08:00:00Z"] }))
      .toEqual(["2026-01-02T08:00:00+00:00", "2026-01-02T08:00:00+00:00"]);
  });

  it.each([1, 2])("leaves unspent actual PRN records available to the next finite repetition (count=%s)", count => {
    const member = dose(); member.asNeeded = true;
    member.schedule!.recurrence!.count = count;
    member.schedule!.recurrence!.courseLength = { value: 7, unit: "d" };
    member.schedule!.recurrence!.occurrenceCap = { max: count, period: 1, periodUnit: Unit.Day };
    const course: CanonicalCourse = { kind: "course", stages: [{ count: 2, administrations: [member] }] };
    const query = { ...options, from: "2026-01-03T00:00:00Z", limit: 3,
      priorDoseTimes: ["2026-01-01T09:00:00Z", "2026-01-02T09:00:00Z"]
        .flatMap(at => Array<string>(count).fill(at)) };
    for (const input of [course, courseToR5(course), courseToR6(course)]) {
      expect(nextDueDoses(input, query)).toEqual([]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(0);
    }
  });

  it.each([[false, 100, 250], [true, 100, 250], [false, 80, 210], [true, 80, 210]] as const)(
    "intersects the resolved weighted range with its administration maximum (lower-only=%s, period maximum=%s)", (lowerOnly, periodMaximum, totalUnits) => {
    const member = dose();
    member.amounts = [{ range: { low: { value: 0.5, unit: "mg/kg" },
      ...(!lowerOnly ? { high: { value: 1, unit: "mg/kg" } } : {}) } }];
    member.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    member.limits = [
      { scope: "period", amount: { value: periodMaximum, unit: "mg" }, period: { value: 24, unit: "h" } },
      { scope: "administration", amount: { value: 50, unit: "mg" } },
    ];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    for (const input of [course, courseToR5(course), courseToR6(course)]) {
      const original = JSON.stringify(input);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 3, durationUnit: Unit.Day,
        patientWeightKg: 70 })).toMatchObject({ totalUnits, unit: "mg" });
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it.each([false, true])("qualifies chronological supply with retained course safety and keeps member explanations (PRN=%s)", prn => {
    const member = dose(); member.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      safety: { limits: [{ scope: "lifetime", amount: { value: 1, unit: "tab" } }] },
      stages: [{ administrations: [member] }] };
    member.asNeeded = prn;
    for (const input of [course, courseToR5(course), courseToR6(course)]) {
      const result = calculateTotalUnits({ ...options, dosage: input, durationValue: 3, durationUnit: Unit.Day });
      expect(result).toMatchObject({ totalUnits: 5, quantityKind: "maximum" });
      expect(result.explanation).toContain("retained but not evaluated");
      if (prn) expect(result.explanation).toContain("PRN doses may be used less frequently than the available opportunities");
    }
  });
});

describe("previous-phase next-day execution", () => {
  const versions = ["native", "R5", "R6"] as const;
  const boundary: CanonicalBoundary = { anchor: "previous-phase-next-day" };
  const course = (): CanonicalCourse => {
    const loading = dose(); loading.schedule!.recurrence!.count = 5;
    const maintenance = dose();
    maintenance.schedule!.recurrence!.clocks = ["15:00:00"];
    maintenance.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    return { kind: "course", cycleInterval: { value: 14, unit: "d" }, cycleCount: 1, stages: [
      { administrations: [loading] },
      { start: boundary, administrations: [maintenance] },
    ] };
  };
  const wire = (value: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? value : version === "R5" ? courseToR5(value) : courseToR6(value);

  it.each(versions)("starts the day after five completed morning doses (%s)", version => {
    const input = wire(course(), version), original = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 10 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
      "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
      "2026-01-06T15:00:00+00:00", "2026-01-07T15:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 8, durationUnit: Unit.Day }).totalUnits).toBe(7);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(versions)("uses completed doses and a midnight duration clock after an evening order (%s)", version => {
    const input = wire(course(), version);
    const query = { from: "2026-01-01T18:00:00Z", orderedAt: "2026-01-01T18:00:00Z", timeZone: "UTC", limit: 10 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
      "2026-01-05T09:00:00+00:00", "2026-01-06T09:00:00+00:00",
      "2026-01-07T15:00:00+00:00", "2026-01-08T15:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 8, durationUnit: Unit.Day }).totalUnits).toBe(7);
  });

  it.each(versions)("keeps the original successor window during a late query (%s)", version => {
    const input = wire(course(), version);
    const query = { ...options, from: "2026-01-07T12:00:00Z", limit: 4 };
    expect(nextDueDoses(input, query)).toEqual(["2026-01-07T15:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
  });

  it.each(versions)("uses the next civil date and midnight cap across spring DST (%s)", version => {
    const value = course();
    value.stages[1].administrations[0].schedule!.recurrence!.clocks = ["07:00:00"];
    const input = wire(value, version);
    const query = { orderedAt: "2027-03-09T08:00:00-05:00", from: "2027-03-13T12:00:00-05:00",
      timeZone: "America/New_York", limit: 4 };
    expect(nextDueDoses(input, query)).toEqual([
      "2027-03-14T07:00:00-04:00", "2027-03-15T07:00:00-04:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
  });

  it.each(versions)("does not add an empty day after an exclusive midnight duration end (%s)", version => {
    const value = course();
    const repeat = value.stages[0].administrations[0].schedule!.recurrence!;
    repeat.count = undefined;
    repeat.courseLength = { value: 5, unit: "d" };
    const input = wire(value, version);
    const query = { ...options, from: "2026-01-06T00:00:00Z", limit: 4 };
    expect(nextDueDoses(input, query)).toEqual(["2026-01-06T15:00:00+00:00", "2026-01-07T15:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
  });

  it.each(versions)("waits for shared cap admission before opening the next day (%s)", version => {
    const value = course();
    value.stages[0].administrations[0].limits = [
      { scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 48, unit: "h" } },
    ];
    const input = wire(value, version);
    const query = { ...options, from: "2026-01-09T12:00:00Z", limit: 4 };
    expect(nextDueDoses(input, query)).toEqual(["2026-01-10T15:00:00+00:00", "2026-01-11T15:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
  });

  it.each(versions)("resolves supplied displacement and exact range from the new midnight (%s)", version => {
    const offsets: CanonicalBoundary[] = [
      { ...boundary, displacement: { value: 18, unit: "h" } },
      { ...boundary, displacementRange: { low: { value: 1, unit: "d" }, high: { value: 24, unit: "h" } } },
    ];
    for (const offset of offsets) {
      const value = course(); value.stages[1].start = offset;
      const input = wire(value, version), original = JSON.stringify(input);
      const query = { ...options, from: "2026-01-06T00:00:00Z", limit: 4 };
      expect(nextDueDoses(input, query)).toEqual(["2026-01-07T15:00:00+00:00", "2026-01-08T15:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it.each(versions)("requires a completed predecessor for a first-stage boundary (%s)", version => {
    const value = course();
    value.stages = [value.stages[1]];
    const input = wire(value, version), original = JSON.stringify(input);
    expect(() => nextDueDoses(input, { ...options, limit: 2 }))
      .toThrow(expect.objectContaining({ code: "previous-phase-required" }));
    expect(() => calculateTotalUnits({ ...options, dosage: input, durationValue: 3, durationUnit: Unit.Day }))
      .toThrow(expect.objectContaining({ code: "previous-phase-required" }));
    expect(JSON.stringify(input)).toBe(original);
  });

  it("retains unsupported offsets without silently dropping their qualifiers or range", () => {
    const invalid: CanonicalBoundary[] = [
      { ...boundary, displacement: { value: 1, unit: "d", comparator: ">=" } },
      { ...boundary, displacementRange: { low: { value: 1, unit: "d" }, high: { value: 2, unit: "d" } } },
      { ...boundary, displacement: { value: 1, unit: "d" },
        displacementRange: { low: { value: 1, unit: "d" }, high: { value: 1, unit: "d" } } },
    ];
    for (const start of invalid) {
      const value = course(); value.stages[1].start = start;
      const original = JSON.stringify(value);
      expect(() => nextDueDoses(value, { ...options, limit: 10 })).toThrow();
      expect(() => supply(value, 10)).toThrow();
      expect(JSON.stringify(value)).toBe(original);
    }
  });

  it("does not use a dependent successor to invent an open predecessor completion", () => {
    const value = course(); value.stages[0].administrations[0].schedule!.recurrence!.count = undefined;
    expect(nextDueDoses(value, { ...options, limit: 3 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
    expect(supply(value, 3).totalUnits).toBe(3);
  });
});

describe("member previous-phase next-day context", () => {
  const versions = ["native", "R5", "R6"] as const;
  const course = (): CanonicalCourse => {
    const loading = dose(); loading.schedule!.recurrence!.count = 5;
    const nextDay = dose(2);
    nextDay.phaseStart = { anchor: "previous-phase-next-day" };
    nextDay.schedule!.recurrence!.clocks = ["06:00:00"];
    const dayTen = dose(3);
    dayTen.phaseOrigin = { value: 9, unit: "d" };
    dayTen.schedule!.recurrence!.clocks = ["15:00:00"];
    return { kind: "course", stages: [
      { administrations: [loading] }, { administrations: [nextDay, dayTen] },
    ] };
  };
  const wire = (value: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? value : version === "R5" ? courseToR5(value) : courseToR6(value);

  it.each(versions)("preserves independent next-day and day10 member timelines and amounts (%s)", version => {
    const input = wire(course(), version), original = JSON.stringify(input);
    const query = { ...options, from: "2026-01-06T00:00:00Z", limit: 8 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-06T06:00:00+00:00", "2026-01-07T06:00:00+00:00", "2026-01-08T06:00:00+00:00",
      "2026-01-09T06:00:00+00:00", "2026-01-10T06:00:00+00:00", "2026-01-10T15:00:00+00:00",
      "2026-01-11T06:00:00+00:00", "2026-01-11T15:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(18);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 11, durationUnit: Unit.Day }).totalUnits).toBe(23);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(versions)("does not treat a later member clock as same-day eligibility (%s)", version => {
    const value = course();
    value.stages[1].administrations[0].schedule!.recurrence!.clocks = ["15:00:00"];
    const input = wire(value, version);
    const query = { ...options, from: "2026-01-05T12:00:00Z", limit: 2 };
    expect(nextDueDoses(input, query)).toEqual(["2026-01-06T15:00:00+00:00", "2026-01-07T15:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
  });

  it.each(versions)("gives a next-day member its midnight duration clock after an evening order (%s)", version => {
    const value = course();
    value.stages[1].administrations[0].schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    const input = wire(value, version);
    const query = { orderedAt: "2026-01-01T18:00:00Z", from: "2026-01-07T00:00:00Z", timeZone: "UTC", limit: 3 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-07T06:00:00+00:00", "2026-01-08T06:00:00+00:00", "2026-01-11T15:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(4);
  });

  it.each(versions)("threads accepted capped completion into the member boundary (%s)", version => {
    const value = course(); value.cycleInterval = { value: 14, unit: "d" }; value.cycleCount = 1;
    value.stages[0].administrations[0].limits = [
      { scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 48, unit: "h" } },
    ];
    const input = wire(value, version);
    const query = { ...options, from: "2026-01-09T12:00:00Z", limit: 3 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-10T06:00:00+00:00", "2026-01-10T15:00:00+00:00", "2026-01-11T06:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(7);
  });

  it.each(versions)("keeps the member's supplied offset relative to its completed predecessor (%s)", version => {
    const value = course();
    value.stages[1].administrations[0].phaseStart!.displacement = { value: 1, unit: "d" };
    const input = wire(value, version), original = JSON.stringify(input);
    const query = { ...options, from: "2026-01-06T00:00:00Z", limit: 2 };
    expect(nextDueDoses(input, query)).toEqual(["2026-01-07T06:00:00+00:00", "2026-01-08T06:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(versions)("does not invent predecessor context for a first-stage member (%s)", version => {
    const value = course(); value.stages = [value.stages[1]];
    const input = wire(value, version), original = JSON.stringify(input);
    expect(() => nextDueDoses(input, { ...options, limit: 2 }))
      .toThrow(expect.objectContaining({ code: "previous-phase-required" }));
    expect(() => calculateTotalUnits({ ...options, dosage: input, durationValue: 3, durationUnit: Unit.Day }))
      .toThrow(expect.objectContaining({ code: "previous-phase-required" }));
    expect(JSON.stringify(input)).toBe(original);
  });
});

describe("round28 execution ownership", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : version === "R5" ? courseToR5(course) : courseToR6(course);

  it.each(versions)("keeps QOD on alternate days and rejects contradictory daily recurrence (%s)", version => {
    const member = dose();
    member.schedule = { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QOD" }] },
      recurrence: { frequency: 1, period: 2, periodUnit: Unit.Day, clocks: ["09:00:00"] } };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    const matching = wire(course, version);
    expect(nextDueDoses(matching, { ...options, limit: 3 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: matching, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(3);
    member.schedule!.recurrence!.period = 1;
    const conflicting = wire(course, version), source = JSON.stringify(conflicting);
    expect(() => nextDueDoses(conflicting, { ...options, limit: 3 }))
      .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    expect(() => calculateTotalUnits({ ...options, dosage: conflicting, durationValue: 2, durationUnit: Unit.Day }))
      .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    expect(JSON.stringify(conflicting)).toBe(source);
  });

  it.each(versions)("uses the member's treatment-relative civil clock after an elapsed stage start (%s)", version => {
    const member = dose();
    member.phaseOrigin = { value: 1, unit: "d" };
    member.schedule!.recurrence!.clocks = ["06:00:00"];
    member.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "wk" }, cycleCount: 1,
      stages: [{ start: relative(20, "h"), administrations: [member] }] };
    const query = { orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z", timeZone: "UTC", limit: 4 };
    for (const origin of [{ value: 1, unit: "d" }, { value: 24, unit: "h" }]) {
      member.phaseOrigin = origin;
      const input = wire(course, version), source = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual(["2026-01-03T06:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(JSON.stringify(input)).toBe(source);
    }
    member.phaseOrigin = undefined;
    expect(nextDueDoses(wire(course, version), query)).toEqual(["2026-01-02T06:00:00+00:00"]);
  });

  it.each(versions)("uses actual history, not past PRN opportunities, for disjoint-cycle caps (%s)", version => {
    const member = dose(); member.asNeeded = true;
    member.schedule!.recurrence!.clocks = ["08:00:00"];
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 48, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    const query = { ...options, from: "2026-01-02T00:00:00Z", limit: 2 };
    const input = wire(course, version), source = JSON.stringify(input);
    expect(nextDueDoses(input, query)).toEqual(["2026-01-02T08:00:00+00:00", "2026-01-04T08:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    const recorded = { ...query, priorDoseTimes: ["2026-01-01T08:00:00Z"] };
    expect(nextDueDoses(input, recorded)).toEqual(["2026-01-03T08:00:00+00:00", "2026-01-05T08:00:00+00:00"]);
    expect(calculateTotalUnits({ ...recorded, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(JSON.stringify(input)).toBe(source);
    member.asNeeded = false;
    const scheduled = wire(course, version);
    expect(nextDueDoses(scheduled, query)).toEqual(["2026-01-03T08:00:00+00:00", "2026-01-05T08:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: scheduled, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
  });

  it.each(versions)("repeats the resolved two-day window of a predecessor-relative step (%s)", version => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { end: relative(2), administrations: [dose()] },
      { start: { anchor: "previous-phase-next-day", displacement: { value: 0, unit: "d" } },
        end: relative(4), count: 2, administrations: [dose(2)] },
    ] };
    const input = wire(course, version), source = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 12 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
      "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00",
      "2026-01-05T09:00:00+00:00", "2026-01-06T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 9, durationUnit: Unit.Day }).totalUnits).toBe(10);
    expect(JSON.stringify(input)).toBe(source);
  });

  it.each(versions)("completes an implicit single immediate dose only after cap admission (%s)", version => {
    const loading = dose(); loading.schedule = { recurrence: { anchors: [EventTiming.Immediate] } };
    loading.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 48, unit: "h" } }];
    const maintenance = dose(2); maintenance.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 3, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    const query = { orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z", timeZone: "UTC", limit: 4 };
    const input = wire(course, version), source = JSON.stringify(input);
    expect(nextDueDoses(input, query)).toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
    const blocked = { ...query, priorDoseTimes: ["2025-12-31T08:00:00Z"] };
    expect(nextDueDoses(input, blocked)).toEqual([]);
    expect(calculateTotalUnits({ ...blocked, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    const recorded = { ...query, from: "2026-01-01T08:30:00Z", priorDoseTimes: ["2026-01-01T08:00:00Z"] };
    expect(nextDueDoses(input, recorded)).toEqual(["2026-01-01T09:00:00+00:00"]);
    expect(calculateTotalUnits({ ...recorded, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(source);
  });

  it.each(versions)("uses coded physical units for container estimates (%s)", version => {
    const member = dose(); member.schedule!.recurrence!.count = 1;
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    for (const [value, code, containers] of [[200, "mg", undefined], [200, "mL", 2], [0.2, "L", 2]] as const) {
      member.amounts = [{ quantity: { value, system: "http://unitsofmeasure.org", code } }];
      const inputs = version === "native" ? [course, member] :
        version === "R5" ? [courseToR5(course), courseToR5(course)[0]] : [courseToR6(course)];
      for (const input of inputs) {
        const source = JSON.stringify(input);
        const result = calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day,
          context: { containerValue: 120, containerUnit: "mL" } });
        expect(result.totalUnits).toBe(value);
        expect(result.unit).toBe(code);
        expect(result.totalContainers).toBe(containers);
        expect(JSON.stringify(input)).toBe(source);
      }
    }
  });

  it.each(versions)("combines independent member clock maxima but retains shared-cap joint plans (%s)", version => {
    const first = dose(), second = dose();
    for (const [member, clock, condition] of [[first, "06:00:00", "A"], [second, "09:00:00", "B"]] as const) {
      member.schedule!.recurrence = { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
        clocks: [clock], courseLength: { value: 2, unit: "d" } };
      member.predicate = { kind: "state", name: condition, expected: true };
      member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 24, unit: "h" } }];
    }
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [first, second] }] };
    const query = { ...options, from: "2026-01-01T06:00:00Z", durationValue: 2.5, durationUnit: Unit.Hour,
      evaluateCondition: (condition: import("../src").MedicationCondition, at: string) =>
        condition.kind === "state" && at.includes(condition.name === "A" ? "T06:00:00" : "T08:00:00") };
    expect(calculateTotalUnits({ ...query, dosage: wire(course, version) }).totalUnits).toBe(2);
    for (const location of ["course", "stage"] as const) {
      const shared = { limits: [{ scope: "period" as const, amount: { value: 1, unit: "tab" }, period: { value: 24, unit: "h" } }] };
      course.safety = location === "course" ? shared : undefined;
      course.stages[0].safety = location === "stage" ? shared : undefined;
      const input = wire(course, version), source = JSON.stringify(input);
      expect(calculateTotalUnits({ ...query, dosage: input }).totalUnits).toBe(1);
      expect(JSON.stringify(input)).toBe(source);
    }
  });

  it.each(versions)("retains a joint repeated-course maximum with overlapping per-member caps (%s)", version => {
    const first = dose(), second = dose();
    for (const [member, clock, name] of [[first, "06:00:00", "A"], [second, "07:00:00", "B"]] as const) {
      member.schedule!.recurrence = { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
        clocks: [clock], courseLength: { value: 2, unit: "d" } };
      member.predicate = { kind: "state", name, expected: true };
      member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 24, unit: "h" } }];
    }
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 2,
      stages: [{ administrations: [first, second] }] };
    const query = { ...options, from: "2026-01-01T06:00:00Z", durationValue: 2, durationUnit: Unit.Day,
      evaluateCondition: (condition: import("../src").MedicationCondition, at: string) =>
        condition.kind === "state" && at.includes(condition.name === "A" ? "T06:00:00" : "T07:00:00") };
    for (const shared of [false, true]) {
      course.safety = shared ? { limits: [{ scope: "period", amount: { value: 2, unit: "tab" },
        period: { value: 24, unit: "h" } }] } : undefined;
      const input = wire(course, version), source = JSON.stringify(input);
      // Each member contributes Jan1 and Jan2 once; the overlapping Jan2 cycle
      // cannot spend either member's 24-hour allowance a second time.
      expect(calculateTotalUnits({ ...query, dosage: input }).totalUnits).toBe(4);
      expect(JSON.stringify(input)).toBe(source);
    }
  });

  it.each(versions)("opens a next-day member from its own finite track beside an unbounded track (%s)", version => {
    const first = dose(), next = dose(2), independent = dose();
    first.sourceMember = 0; first.phasePredecessors = [];
    first.schedule!.recurrence!.count = 5;
    next.sourceMember = 1; next.phasePredecessors = [0];
    next.phaseStart = { anchor: "previous-phase-next-day" };
    next.schedule!.recurrence!.clocks = ["06:00:00"];
    next.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    independent.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Day,
      clocks: ["08:00:00", "20:00:00"] };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [first, next, independent] }] };
    const input = wire(course, version), source = JSON.stringify(input);
    const query = { ...options, from: "2026-01-05T00:00:00Z", limit: 10 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-05T08:00:00+00:00", "2026-01-05T09:00:00+00:00", "2026-01-05T20:00:00+00:00",
      "2026-01-06T06:00:00+00:00", "2026-01-06T08:00:00+00:00", "2026-01-06T20:00:00+00:00",
      "2026-01-07T06:00:00+00:00", "2026-01-07T08:00:00+00:00", "2026-01-07T20:00:00+00:00",
      "2026-01-08T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(13);
    expect(JSON.stringify(input)).toBe(source);
  });

  it.each(versions)("wakes a same-track successor after accepted capped doses without waiting for an unbounded member (%s)", version => {
    const first = dose(), next = dose(2), independent = dose();
    first.sourceMember = 0; first.phasePredecessors = [];
    first.schedule!.recurrence!.count = 2;
    first.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 48, unit: "h" } }];
    next.sourceMember = 1; next.phasePredecessors = [0];
    next.phaseStart = { anchor: "previous-phase-next-day" };
    next.schedule!.recurrence!.clocks = ["06:00:00"];
    next.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    independent.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Day,
      clocks: ["08:00:00", "20:00:00"] };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 10, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [first, next, independent] }] };
    const input = wire(course, version), source = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, from: "2026-01-04T00:00:00Z", limit: 6 })).toEqual([
      "2026-01-04T06:00:00+00:00", "2026-01-04T08:00:00+00:00", "2026-01-04T20:00:00+00:00",
      "2026-01-05T06:00:00+00:00", "2026-01-05T08:00:00+00:00", "2026-01-05T20:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 5, durationUnit: Unit.Day }).totalUnits).toBe(16);
    expect(JSON.stringify(input)).toBe(source);
  });

  it.each(versions)("joins its own accepted predecessors before resuming the later global stage (%s)", version => {
    const first = dose(), second = dose(), next = dose(2), independent = dose(), final = dose(3);
    for (const [member, id, hours] of [[first, 0, 48], [second, 1, 72]] as const) {
      member.sourceMember = id; member.phasePredecessors = [];
      member.schedule!.recurrence!.count = 2;
      member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: hours, unit: "h" } }];
    }
    next.sourceMember = 2; next.phasePredecessors = [0, 1];
    next.phaseStart = { anchor: "previous-phase-next-day" };
    next.schedule!.recurrence!.clocks = ["06:00:00"];
    next.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
    independent.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Day,
      clocks: ["08:00:00", "20:00:00"], courseLength: { value: 4, unit: "d" } };
    final.schedule!.recurrence!.count = 1;
    final.schedule!.recurrence!.clocks = ["07:00:00"];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 10, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [next, second, independent, first] }, { administrations: [final] }] };
    const input = wire(course, version), source = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, from: "2026-01-05T00:00:00Z", limit: 4 })).toEqual([
      "2026-01-05T06:00:00+00:00", "2026-01-06T07:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(17);
    expect(JSON.stringify(input)).toBe(source);
  });

  it.each(versions)("keeps a civil-day start distinct from the treatment clock over DST (%s)", version => {
    const member = dose();
    member.phaseStart = { anchor: "treatment-day-start", displacement: { value: 1, unit: "d" } };
    member.schedule!.recurrence!.clocks = ["06:00:00"];
    member.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    const query = { orderedAt: "2026-03-07T15:00:00Z", from: "2026-03-07T15:00:00Z",
      timeZone: "America/New_York", limit: 2 };
    const input = wire(course, version), source = JSON.stringify(input);
    expect(nextDueDoses(input, query)).toEqual(["2026-03-08T06:00:00-04:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(JSON.stringify(input)).toBe(source);
    member.phaseStart.anchor = "treatment-start";
    expect(nextDueDoses(wire(course, version), query)).toEqual(["2026-03-09T06:00:00-04:00"]);
  });

  it.each(versions)("retains a known infusion dose without inventing an exact qualified-duration completion (%s)", version => {
    for (const qualifier of ["at most", "at least"]) {
      const parsed = parseSig("Infuse 500 mL over " + qualifier + " 2 hours");
      const first = parsed.meta.canonical.course!.stages[0].administrations[0];
      const next = dose(100);
      next.amounts![0].quantity!.unit = "mL";
      next.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
      const course: CanonicalCourse = { kind: "course", stages: [
        { administrations: [first] }, { administrations: [next] },
      ] };
      const query = { orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z", timeZone: "UTC", limit: 4 };
      const input = wire(course, version), source = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual(["2026-01-01T08:00:00+00:00"]);
      const total = calculateTotalUnits({ ...query, dosage: input, durationValue: 2, durationUnit: Unit.Day });
      expect(total.totalUnits).toBe(500);
      expect(total.unit).toBe("mL");
      expect(JSON.stringify(input)).toBe(source);
    }
  });

  it("carries the duration's upper or lower bound through rate-derived supply", () => {
    const member = dose();
    member.amounts = [{ rate: { value: 50, system: "http://unitsofmeasure.org", code: "mL/h" } }];
    member.schedule = { recurrence: { count: 1, occurrenceDuration: 2, occurrenceDurationUnit: Unit.Hour,
      occurrenceDurationComparator: "<=" } };
    expect(supply(member, 1)).toMatchObject({ totalUnits: 100, unit: "mL", quantityKind: "maximum" });
    member.schedule.recurrence!.occurrenceDurationComparator = ">=";
    const source = JSON.stringify(member);
    expect(() => supply(member, 1)).toThrow(expect.objectContaining({ code: "dose-amount-lower-bound" }));
    expect(JSON.stringify(member)).toBe(source);
    member.schedule.recurrence!.occurrenceDurationComparator = undefined;
    const exact = supply(member, 1);
    expect(exact).toMatchObject({ totalUnits: 100, unit: "mL" });
    expect(exact.quantityKind).not.toBe("maximum");
  });
});
