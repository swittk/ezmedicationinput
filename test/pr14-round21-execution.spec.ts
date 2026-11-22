/** Independent quantity and timestamp oracles for review 21 execution. */
import { describe, expect, it } from "vitest";
import { normalizeClock } from "../src/execution/calendar";
import { lexInput } from "../src/lexer/lex";
import { parseClauseState } from "../src/parser";
import { createBoundaryPlan } from "../src/regimen/planner";
import { buildRegimenGraph, scopeSequentialPhaseSemantics, anchoredScheduleDurationEnd } from "../src/regimen/regimen";
import { buildCanonicalParallelRegimen, projectParallelRegimen } from "../src/regimen/parallel-course";
import { courseFromAdministrations, clauseForAdministration, courseFromPartialParallel } from "../src/canonical/compile";
import { courseToR5, courseToR6, courseFromR6 } from "../src/adapters/canonical-course";
import { calculateTotalUnits, nextDueDoses, toEzDosages, fromFhir, toFhirR5Dosages, parseSig, projectCanonicalCourse, importCanonicalCourse } from "../src/index";
import type { CanonicalAdministration, CanonicalCourse, CanonicalBoundary } from "../src/canonical/course";
import { EventTiming, FhirDayOfWeek, FhirPeriodUnit as Unit, type FhirDosage, type FhirR6DosageInstruction } from "../src/types";

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
    if (variant !== "missing period") {
      expect(nextDueDoses(row, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: row, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
    } else {
      // Missing cadence fields do not create a contradiction. Bare daily
      // codes are executable; an authored incomplete repeat remains intact.
      expect(nextDueDoses(row, { ...options, limit: 2 })).toEqual([]);
      expect(() => calculateTotalUnits({ ...options, dosage: row, durationValue: 2, durationUnit: Unit.Day }))
        .toThrow(expect.objectContaining({ code: "timing-required" }));
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
      .filter(member => member.target?.text === "right eye" &&
        member.schedule?.recurrence?.frequency === 2 && member.phaseOrigin?.value === 7);
    expect(terminal.length).toBeGreaterThan(0);
    for (const member of terminal) expect(member.schedule?.recurrence?.courseLength).toMatchObject({ value: 1.5, unit: "d" });
    for (const rows of [projected.dosages, (projected.details.step ?? []).flatMap(step => step.component)]) {
      const terminalRows = rows.filter(row => {
        const site = row.site;
        const text = site && "concept" in site ? site.concept?.text : site && "text" in site ? site.text : undefined;
        return text === "right eye" && row.timing?.repeat?.frequency === 2;
      });
      expect(terminalRows.length).toBe(terminal.length);
      for (const row of terminalRows)
        expect(row.timing?.repeat?.boundsDuration).toMatchObject({ value: 1.5, code: "d" });
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
      const native = input === parsed ? parsed.meta.canonical.course! : importCanonicalCourse(input);
      const members = native.stages.flatMap(stage => stage.administrations);
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
    }
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

describe("round 30 execution clinical oracles", () => {
  const versions = ["native", "R6", "persisted R5"] as const;
  const wire = (value: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? value : version === "R6" ? courseToR6(value) :
      JSON.parse(JSON.stringify(courseToR5(value))) as FhirDosage[];
  const course = (member: CanonicalAdministration): CanonicalCourse =>
    ({ kind: "course", stages: [{ administrations: [member] }] });
  const gts = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
  const coded = (code: string, system: string | undefined = gts) => {
    const member = dose();
    member.schedule = { code: { coding: [{ code, ...(system ? { system } : {}) }] } };
    return member;
  };

  it.each(versions)("applies equivalent fractional rolling caps and retains cross-cycle history (%s)", version => {
    for (const period of [{ value: 0.5, unit: "d" }, { value: 12, unit: "h" },
      { value: 0.5, unit: "wk" }, { value: 3.5, unit: "d" }]) {
      const member = dose();
      member.schedule!.recurrence!.clocks = ["08:00:00", "16:00:00"];
      member.schedule!.recurrence!.frequency = 2;
      member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period }];
      const input = wire(course(member), version), original = JSON.stringify(input);
      const second = period.unit === "h" || period.value === 0.5 && period.unit === "d"
        ? "2026-01-02T08:00:00+00:00" : "2026-01-05T08:00:00+00:00";
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual(["2026-01-01T08:00:00+00:00", second]);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(JSON.stringify(input)).toBe(original);
    }
    const member = dose(); member.schedule!.recurrence = { frequency: 1, period: 8, periodUnit: Unit.Hour };
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 0.5, unit: "d" } }];
    const repeated = course(member); repeated.stages[0].end = relative(8, "h");
    repeated.cycleInterval = { value: 8, unit: "h" }; repeated.cycleCount = 5;
    const query = { from: "2026-01-01T08:00:00Z", orderedAt: "2026-01-01T08:00:00Z", timeZone: "UTC" };
    const input = wire(repeated, version);
    expect(nextDueDoses(input, { ...query, limit: 10 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T00:00:00+00:00", "2026-01-02T16:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 40, durationUnit: Unit.Hour }).totalUnits).toBe(3);
  });

  it.each(versions)("completes capped non-PRN loading from the actual off-clock record (%s)", version => {
    const loading = dose(); loading.schedule!.recurrence = { count: 1, frequency: 1, period: 12, periodUnit: Unit.Hour };
    loading.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 12, unit: "h" } }];
    const maintenance = dose(2); maintenance.schedule!.recurrence = {
      frequency: 1, period: 12, periodUnit: Unit.Hour, courseLength: { value: 1, unit: "d" },
    };
    const value: CanonicalCourse = { kind: "course", cycleInterval: { value: 3, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    const query = { orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T10:00:00Z", timeZone: "UTC" };
    const input = wire(value, version), original = JSON.stringify(input);
    const actual = { ...query, priorDoseTimes: ["2026-01-01T09:00:00Z"] };
    expect(nextDueDoses(input, { ...actual, limit: 2 })).toEqual([
      "2026-01-01T21:00:00+00:00", "2026-01-02T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...actual, dosage: input, durationValue: 10.5, durationUnit: Unit.Hour }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ ...actual, dosage: input, durationValue: 12, durationUnit: Unit.Hour }).totalUnits).toBe(2);
    expect(nextDueDoses(input, { ...query, priorDoseTimes: ["2026-01-01T08:00:00Z"], limit: 1 }))
      .toEqual(["2026-01-01T20:00:00+00:00"]);
    expect(nextDueDoses(input, { ...query, priorDoseTimes: ["2025-12-31T19:00:00Z"], limit: 1 }))
      .toEqual(["2026-01-01T20:00:00+00:00"]);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(versions)("skips only the waking window whose exact clock is in a DST gap (%s)", version => {
    const member = dose(); member.schedule!.recurrence = {
      frequency: 1, period: 4, periodUnit: Unit.Hour, anchors: [EventTiming.Wake],
    };
    const input = wire(course(member), version), original = JSON.stringify(input);
    const query = { from: "2026-03-07T00:00:00-05:00", orderedAt: "2026-03-07T00:00:00-05:00",
      timeZone: "America/New_York", eventClock: { WAKE: "02:30", HS: "14:00" } };
    expect(nextDueDoses(input, { ...query, limit: 6 })).toEqual([
      "2026-03-07T02:30:00-05:00", "2026-03-07T06:30:00-05:00", "2026-03-07T10:30:00-05:00",
      "2026-03-09T02:30:00-04:00", "2026-03-09T06:30:00-04:00", "2026-03-09T10:30:00-04:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(6);
    expect(() => nextDueDoses(input, { ...query, limit: 1, eventClock: { WAKE: "14:00", HS: "14:00" } }))
      .toThrow(/WAKE precedes HS/);
    expect(() => nextDueDoses(input, { ...query, limit: 1, eventClock: { WAKE: "14:00:00.5000", HS: "14:00:00.5" } }))
      .toThrow(/WAKE precedes HS/);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(versions)("uses configured QOD clocks for alternate-day due, history and supply (%s)", version => {
    const member = coded("QOD"); member.schedule!.recurrence = { frequency: 1, period: 2, periodUnit: Unit.Day, count: 2 };
    const value = course(member), query = { ...options, frequencyDefaults: { byCode: { QOD: ["07:00"] } } };
    const input = wire(value, version), original = JSON.stringify(input);
    expect(nextDueDoses(input, { ...query, limit: 3 })).toEqual([
      "2026-01-01T07:00:00+00:00", "2026-01-03T07:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 8, durationUnit: Unit.Hour }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...query, from: "2026-01-01T08:00:00Z", limit: 3 })).toEqual([
      "2026-01-03T07:00:00+00:00",
    ]);
    expect(JSON.stringify(input)).toBe(original);
    expect(nextDueDoses(input, { ...options, limit: 1, frequencyDefaults: { byCode: { QOD: ["07:00"] } } }))
      .toEqual(["2026-01-01T07:00:00+00:00"]);
    member.schedule!.recurrence!.clocks = ["10:00:00"];
    expect(nextDueDoses(wire(value, version), { ...query, limit: 1 })).toEqual(["2026-01-01T10:00:00+00:00"]);
    member.schedule!.recurrence!.clocks = undefined; member.schedule!.code = undefined;
    expect(nextDueDoses(wire(value, version), { ...query, limit: 2 })).toEqual([
      "2026-01-01T00:00:00+00:00", "2026-01-03T00:00:00+00:00",
    ]);
  });

  it.each(versions)("executes bare daily Timing codes without changing authored recurrence (%s)", version => {
    const clocks = { QD: ["09:00"], BID: ["08:00", "20:00"], TID: ["08:00", "14:00", "20:00"],
      QID: ["08:00", "12:00", "16:00", "20:00"], AM: ["08:00"], PM: ["20:00"], QOD: ["09:00"] };
    for (const [code, times] of Object.entries(clocks)) {
      const member = coded(code), input = wire(course(member), version), original = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: times.length })).toEqual(
        times.map(time => `2026-01-01T${time}:00+00:00`));
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(times.length);
      expect(JSON.stringify(input)).toBe(original);
      expect(member.schedule!.recurrence).toBeUndefined();
    }
    const bid = wire(course(coded("BID")), version);
    expect(nextDueDoses(bid, { ...options, limit: 2, frequencyDefaults: { byCode: { BID: ["07:00", "19:00"] } } }))
      .toEqual(["2026-01-01T07:00:00+00:00", "2026-01-01T19:00:00+00:00"]);
    expect(nextDueDoses(wire(course(coded("WARD", "https://example.org/timing")), version), { ...options, limit: 1 })).toEqual([]);
  });

  it.each(versions)("checks hourly GTS cadence while accepting equivalent period units (%s)", version => {
    const member = coded("Q4H"); member.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: Unit.Day };
    member.schedule!.code!.coding!.unshift({ system: "https://example.org/timing", code: "BID" });
    const value = course(member), input = wire(value, version), original = JSON.stringify(input);
    expect(() => nextDueDoses(input, { ...options, limit: 2 })).toThrow(/timing code.*repeat/i);
    expect(() => calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
      .toThrow(/timing code.*repeat/i);
    expect(JSON.stringify(input)).toBe(original);
    for (const [period, periodUnit] of [[4, Unit.Hour], [240, Unit.Minute]] as const) {
      member.schedule!.recurrence = { frequency: 1, period, periodUnit };
      const matching = wire(value, version);
      expect(nextDueDoses(matching, { ...options, limit: 3 })).toEqual([
        "2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00", "2026-01-01T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: matching, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(6);
    }
    member.schedule!.recurrence = { frequency: 1, period: 2, periodMax: 4, periodUnit: Unit.Hour };
    const ranged = wire(value, version), rangedSource = JSON.stringify(ranged);
    expect(nextDueDoses(ranged, { ...options, limit: 3 })).toEqual([
      "2026-01-01T00:00:00+00:00", "2026-01-01T02:00:00+00:00", "2026-01-01T04:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: ranged, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(12);
    expect(JSON.stringify(ranged)).toBe(rangedSource);
  });

  it.each(versions)("keeps local timing codes separate from GTS cadence while honoring institution clocks (%s)", version => {
    const member = coded("BID", "https://example.org/timing");
    member.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: Unit.Day };
    const value = course(member), input = wire(value, version), original = JSON.stringify(input);
    const query = { ...options, frequencyDefaults: { byCode: { BID: ["07:00"] } } };
    expect(nextDueDoses(input, { ...query, limit: 2 })).toEqual([
      "2026-01-01T07:00:00+00:00", "2026-01-02T07:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 8, durationUnit: Unit.Hour }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...options, limit: 1 })).toEqual(["2026-01-01T09:00:00+00:00"]);
    expect(JSON.stringify(input)).toBe(original);
    for (const system of [gts, undefined]) {
      member.schedule!.code = { coding: [{ code: "BID", ...(system ? { system } : {}) }] };
      const standard = wire(value, version);
      expect(() => nextDueDoses(standard, { ...query, limit: 1 })).toThrow(/timing code.*repeat/i);
    }
  });

  it.each(versions)("preserves authored clock fractions to millisecond precision (%s)", version => {
    for (const [clock, expected] of [["08:30:00.500", "08:30:00.500"],
      ["08:30:00.9996", "08:30:00.999"], ["23:59:59.999999999", "23:59:59.999"],
      ["08:30:59.123", "08:30:59.123"], ["08:30:00.000000001", "08:30:00"]] as const) {
      for (const event of [false, true]) {
        const member = dose(); member.schedule!.recurrence = { count: 1, frequency: 1, period: 1, periodUnit: Unit.Day,
          ...(event ? { anchors: [EventTiming.Morning] } : { clocks: [clock] }) };
        const input = wire(course(member), version), original = JSON.stringify(input);
        const query = { ...options, ...(event ? { eventClock: { MORN: clock } } : {}) };
        expect(nextDueDoses(input, { ...query, limit: 1 })).toEqual([`2026-01-01T${expected}+00:00`]);
        expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
        expect(JSON.stringify(input)).toBe(original);
      }
    }
  });

  it.each(versions)("keeps a fractional exact clock absent on a DST-gap date (%s)", version => {
    const member = dose(); member.schedule!.recurrence!.clocks = ["02:30:00.500"];
    const input = wire(course(member), version);
    const query = { from: "2026-03-08T00:00:00-05:00", orderedAt: "2026-03-08T00:00:00-05:00", timeZone: "America/New_York" };
    expect(nextDueDoses(input, { ...query, limit: 1 })).toEqual(["2026-03-09T02:30:00.500-04:00"]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
  });

  it.each(versions)("sums zero inactive quantities without choosing their incompatible unit (%s)", version => {
    for (const reverse of [false, true]) {
      const inactive = dose(100); inactive.amounts![0].quantity!.unit = "mg";
      inactive.schedule!.recurrence!.clocks = ["20:00:00"];
      const active = dose(5); active.amounts![0].quantity!.unit = "mL";
      const members = reverse ? [active, inactive] : [inactive, active];
      const value: CanonicalCourse = { kind: "course", stages: [{ administrations: members }] };
      const input = wire(value, version);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 12, durationUnit: Unit.Hour }))
        .toMatchObject({ totalUnits: 5, unit: "mL" });
      active.schedule!.recurrence!.clocks = ["20:00:00"];
      expect(calculateTotalUnits({ ...options, dosage: wire(value, version), durationValue: 12, durationUnit: Unit.Hour }))
        .toMatchObject({ totalUnits: 0, unit: reverse ? "mL" : "mg" });
      inactive.schedule!.recurrence!.clocks = ["09:00:00"]; active.schedule!.recurrence!.clocks = ["09:00:00"];
      expect(() => calculateTotalUnits({ ...options, dosage: wire(value, version), durationValue: 12, durationUnit: Unit.Hour }))
        .toThrow(/Cannot sum medication supply/);
    }
  });
});

describe("round 31 execution clinical oracles", () => {
  const versions = ["native", "R6", "persisted R5"] as const;
  const wire = (value: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? value : version === "R6" ? courseToR6(value) :
      JSON.parse(JSON.stringify(courseToR5(value))) as FhirDosage[];
  const course = (member: CanonicalAdministration): CanonicalCourse =>
    ({ kind: "course", stages: [{ administrations: [member] }] });
  const gts = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";

  it.each(versions)("executes fractional-day singleton cadences as elapsed intervals (%s)", version => {
    for (const [period, periodUnit, times, total] of [
      [0.5, Unit.Day, ["00:00", "12:00"], 2],
      [12, Unit.Hour, ["00:00", "12:00"], 2],
      [0.25, Unit.Day, ["00:00", "06:00", "12:00", "18:00"], 4],
      [6, Unit.Hour, ["00:00", "06:00", "12:00", "18:00"], 4],
    ] as const) {
      const member = dose(); member.schedule!.recurrence = { frequency: 1, period, periodUnit };
      const input = wire(course(member), version), original = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: times.length })).toEqual(
        times.map(time => "2026-01-01T" + time + ":00+00:00"));
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(total);
      expect(JSON.stringify(input)).toBe(original);
    }
    for (const [period, periodUnit] of [[0.5, Unit.Week], [3.5, Unit.Day]] as const) {
      const member = dose(); member.schedule!.recurrence = { frequency: 1, period, periodUnit };
      const input = wire(course(member), version);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
        "2026-01-01T00:00:00+00:00", "2026-01-04T12:00:00+00:00", "2026-01-08T00:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(2);
    }
    const daily = dose(); daily.schedule!.recurrence!.clocks = undefined;
    expect(nextDueDoses(wire(course(daily), version), { ...options, limit: 2 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
    ]);
  });

  it.each(versions)("retains explicit events as the complete supply plan beside timing ranges (%s)", version => {
    for (const ranged of [{ periodMax: 2 }, { frequencyMax: 3 }, { periodMax: 2, frequencyMax: 3 }]) {
      const member = dose(); member.schedule = {
        explicitEvents: ["2026-01-01T09:00:00Z"],
        recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, ...ranged },
      };
      const complete = wire(course(member), version);
      const inputs = version === "native" ? [complete, member] : version === "persisted R5"
        ? [complete, (complete as FhirDosage[])[0]] : [complete];
      for (const input of inputs) {
        const original = JSON.stringify(input);
        expect(nextDueDoses(input, { ...options, limit: 5 })).toEqual(["2026-01-01T09:00:00+00:00"]);
        expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
        expect(JSON.stringify(input)).toBe(original);
      }
      member.schedule.explicitEvents = undefined;
      expect(calculateTotalUnits({ ...options, dosage: wire(course(member), version),
        durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe("frequencyMax" in ranged ? 9 : 3);
    }
  });

  it.each(versions)("uses hourly GTS spacing for a matching unanchored aggregate frequency (%s)", version => {
    for (const [code, frequency, period, periodUnit, hours, total] of [
      ["Q4H", 6, 1, Unit.Day, ["00", "04", "08"], 6],
      ["Q4H", 12, 2, Unit.Day, ["00", "04", "08"], 6],
      ["Q4H", 3, 12, Unit.Hour, ["00", "04", "08"], 6],
      ["Q6H", 4, 1, Unit.Day, ["00", "06", "12"], 4],
    ] as const) {
      const member = dose(); member.schedule = {
        code: { coding: [{ system: gts, code }] }, recurrence: { frequency, period, periodUnit },
      };
      const input = wire(course(member), version), original = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual(
        hours.map(hour => "2026-01-01T" + hour + ":00:00+00:00"));
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(total);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 4, durationUnit: Unit.Hour }).totalUnits).toBe(1);
      expect(JSON.stringify(input)).toBe(original);
    }
    const member = dose(); member.schedule = {
      code: { coding: [{ system: gts, code: "Q4H" }] },
      recurrence: { frequency: 6, period: 1, periodUnit: Unit.Day,
        clocks: ["02:00:00", "06:00:00", "10:00:00", "14:00:00", "18:00:00", "22:00:00"] },
    };
    const authored = wire(course(member), version), original = JSON.stringify(authored);
    expect(nextDueDoses(authored, { ...options, limit: 3 })).toEqual([
      "2026-01-01T02:00:00+00:00", "2026-01-01T06:00:00+00:00", "2026-01-01T10:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: authored, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(6);
    expect(JSON.stringify(authored)).toBe(original);
    member.schedule.explicitEvents = ["2026-01-01T11:00:00Z"];
    member.schedule.recurrence!.clocks = undefined;
    const explicit = wire(course(member), version);
    expect(nextDueDoses(explicit, { ...options, limit: 3 })).toEqual(["2026-01-01T11:00:00+00:00"]);
    expect(calculateTotalUnits({ ...options, dosage: explicit, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
  });

  it.each(versions)("finds the first valid elapsed-interval clock after a DST-gap lookahead (%s)", version => {
    for (const [period, periodUnit] of [[4, Unit.Hour], [240, Unit.Minute]] as const) {
      const member = dose(); member.schedule!.recurrence = { frequency: 1, period, periodUnit, clocks: ["02:30:00"] };
      const input = wire(course(member), version), original = JSON.stringify(input);
      const query = { from: "2026-03-09T00:00:00-04:00", orderedAt: "2026-03-07T03:00:00-05:00", timeZone: "America/New_York" };
      expect(nextDueDoses(input, { ...query, limit: 6 })).toEqual([
        "2026-03-09T02:30:00-04:00", "2026-03-09T06:30:00-04:00", "2026-03-09T10:30:00-04:00",
        "2026-03-09T14:30:00-04:00", "2026-03-09T18:30:00-04:00", "2026-03-09T22:30:00-04:00",
      ]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(6);
      expect(calculateTotalUnits({ ...query, from: "2026-03-08T00:00:00-05:00", dosage: input,
        durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
      // An already-valid origin keeps elapsed cadence across the DST change.
      expect(nextDueDoses(input, { ...query, orderedAt: "2026-03-07T00:00:00-05:00", limit: 2 })).toEqual([
        "2026-03-09T03:30:00-04:00", "2026-03-09T07:30:00-04:00",
      ]);
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it.each(versions)("keeps exact clock fractions through meal offsets and midnight shifts (%s)", version => {
    for (const [clock, event, offsetMinutes, from, expected] of [
      ["17:00:00.111", EventTiming["After Dinner"], 30, origin, "2026-01-01T17:30:00.111+00:00"],
      ["17:00:00.999999999", EventTiming["After Dinner"], 30, origin, "2026-01-01T17:30:00.999+00:00"],
      ["23:45:00.111", EventTiming["After Dinner"], 30, "2026-01-02T00:00:00Z", "2026-01-02T00:15:00.111+00:00"],
      ["00:15:00.111", EventTiming["Before Dinner"], -30, origin, "2026-01-01T23:45:00.111+00:00"],
      ["17:00:00", EventTiming["After Dinner"], 30, origin, "2026-01-01T17:30:00+00:00"],
    ] as const) {
      const member = dose(); member.schedule!.recurrence!.clocks = undefined;
      member.schedule!.recurrence!.anchors = [event];
      const input = wire(course(member), version), original = JSON.stringify(input);
      const query = { ...options, from, eventClock: { CV: clock }, mealOffsets: { [event]: offsetMinutes } };
      expect(nextDueDoses(input, { ...query, limit: 1 })).toEqual([expected]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it.each(versions)("does not measure an indeterminate rate for nonperiod scheduling limits (%s)", version => {
    for (const scope of ["lifetime", "administration", "period"] as const) {
      const member = dose();
      member.amounts = [{ rateRatio: { numerator: { value: 10, unit: "mL", comparator: "<=" },
        denominator: { value: 1, unit: "h", comparator: "<=" } } }];
      member.schedule!.recurrence!.occurrenceDuration = 1;
      member.schedule!.recurrence!.occurrenceDurationUnit = Unit.Hour;
      member.limits = scope === "period"
        ? [{ scope, expression: { language: "text/plain", expression: "prescribed maximum" }, period: { value: 1, unit: "d" } }]
        : [{ scope, amount: { value: 100, unit: "mL" } }];
      const input = wire(course(member), version), original = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual([
        "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
      ]);
      expect(() => calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
        .toThrow(expect.objectContaining({ code: "rate-ratio-bound-unresolved" }));
      expect(JSON.stringify(input)).toBe(original);
      member.limits = [{ scope: "period", amount: { value: 100, unit: "mL" }, period: { value: 1, unit: "d" } }];
      expect(() => nextDueDoses(wire(course(member), version), { ...options, limit: 2 }))
        .toThrow(expect.objectContaining({ code: "rate-ratio-bound-unresolved" }));
    }
  });

  it.each(versions)("executes bare QOD on independently dated alternate days (%s)", version => {
    const member = dose(); member.schedule = { code: { coding: [{ system: gts, code: "QOD" }] } };
    const input = wire(course(member), version), original = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(JSON.stringify(input)).toBe(original);
    expect(member.schedule.recurrence).toBeUndefined();
  });
});


describe("round 32 execution cause-family oracles", () => {
  const ucum = "http://unitsofmeasure.org";
  const forms = (source: FhirR6DosageInstruction) => [
    courseFromR6(source), source,
    JSON.parse(JSON.stringify(toFhirR5Dosages(source))) as FhirDosage[],
  ];
  const daily = { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"] };
  const component = (quantity: { value: number; unit?: string }, timing = { repeat: daily }) =>
    ({ doseAndRate: [{ doseQuantity: quantity }], timing });

  it.each(["code only", "localized display", "scaled denominator"])(
    "uses the same concentration meaning for caps and containers (%s)", variant => {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        ...component({ value: 1, unit: "mL" }, { repeat: { ...daily,
          frequency: 2, timeOfDay: ["08:00:00", "20:00:00"] } }),
        safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 5, unit: "mg" },
          period: { value: 24, code: "h", system: ucum } }] },
      }] }] };
      const context = { strengthRatio: {
        numerator: { value: 5, system: ucum, code: "mg",
          ...(variant === "localized display" ? { unit: "มิลลิกรัม" } : {}) },
        denominator: { value: variant === "scaled denominator" ? 1000 : 1, system: ucum,
          code: variant === "scaled denominator" ? "uL" : "mL",
          ...(variant === "localized display" ? { unit: "มิลลิลิตร" } : {}) },
      }, containerValue: 5, containerUnit: "mg" };
      const original = JSON.stringify({ source, context });
      for (const dosage of forms(source)) {
        expect(calculateTotalUnits({ ...options, dosage, context,
          durationValue: 1, durationUnit: Unit.Day })).toMatchObject({
          totalUnits: 1, unit: "mL", totalContainers: 1,
          totalContainerQuantity: { value: 5, unit: "mg" },
        });
      }
      expect(JSON.stringify({ source, context })).toBe(original);
    });

  it("uses coded concentration endpoints for approximate ingredient mass", () => {
    const source = parseSig("1 drop OD QID").fhirNext;
    const context = { dosageForm: "eye drops", strengthRatio: {
      numerator: { value: 500, code: "ug", system: ucum },
      denominator: { value: 100, code: "mL", system: ucum },
    }, containerValue: 5, containerUnit: "mL" };
    const original = JSON.stringify({ source, context });
    for (const dosage of forms(source)) {
      expect(calculateTotalUnits({ ...options, dosage, context, roundToMultiple: 300,
        durationValue: 1, durationUnit: Unit.Day })).toMatchObject({
        totalUnits: 300, totalApproximateQuantity: { value: 15, unit: "mL" },
        totalApproximateIngredientQuantity: { value: 75, unit: "ug" }, totalContainers: 3,
      });
    }
    expect(JSON.stringify({ source, context })).toBe(original);
  });

  it.each(["absent", "empty timing", "unknown code"])(
    "keeps an absent scalar schedule unknown instead of counting zero (%s)", variant => {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }],
        ...(variant === "absent" ? {} : { timing: variant === "empty timing" ? {} :
          { code: { coding: [{ system: "https://example.org/ward", code: "WARD" }] } } }) };
      const source: FhirR6DosageInstruction = { step: [{ component: [row] }] };
      const original = JSON.stringify(source);
      for (const dosage of [row, ...forms(source)]) {
        expect(() => calculateTotalUnits({ ...options, dosage, durationValue: 1, durationUnit: Unit.Day }))
          .toThrow(expect.objectContaining({ code: "timing-required" }));
      }
      expect(JSON.stringify(source)).toBe(original);
    });

  it("keeps executable zero windows, bare codes and explicit events distinct from missing timing", () => {
    const exact: FhirR6DosageInstruction = { step: [{ component: [component({ value: 1, unit: "mL" })] }] };
    for (const dosage of forms(exact))
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 8, durationUnit: Unit.Hour }))
        .toMatchObject({ totalUnits: 0, unit: "mL" });
    for (const timing of [
      { code: { coding: [{ code: "BID" }] } },
      { event: ["2026-01-01T08:00:00Z", "2026-01-01T20:00:00Z"] },
    ]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }], timing,
      }] }] };
      for (const dosage of forms(source))
        expect(calculateTotalUnits({ ...options, dosage, durationValue: 1, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: 2, unit: "mL" });
    }
  });

  it.each([false, true])("never assigns the measured component's unit to a nonzero unitless amount (reverse %s)", reverse => {
    const rows = [component({ value: 1 }), component({ value: 100, unit: "mg" })];
    if (reverse) rows.reverse();
    const source: FhirR6DosageInstruction = { step: [{ component: rows }] };
    const original = JSON.stringify(source);
    for (const dosage of forms(source))
      expect(() => calculateTotalUnits({ ...options, dosage, durationValue: 1, durationUnit: Unit.Day }))
        .toThrow(expect.objectContaining({ code: "incompatible-dose-units" }));
    expect(JSON.stringify(source)).toBe(original);
  });

  it("sums compatible dimensions while retaining unitless-only quantities and inactive zero members", () => {
    for (const [quantities, expected] of [
      [[{ value: 1 }, { value: 2 }], { totalUnits: 3 }],
      [[{ value: 1, unit: "g" }, { value: 100, unit: "mg" }], { totalUnits: 1.1, unit: "g" }],
      [[{ value: 0 }, { value: 100, unit: "mg" }], { totalUnits: 100, unit: "mg" }],
      [[{ value: 100, unit: "mg" }, { value: 0 }], { totalUnits: 100, unit: "mg" }],
      [[{ value: 0, unit: "mg" }, { value: 2 }], { totalUnits: 2 }],
    ] as const) {
      // A zero contribution is a positive dose whose clock lies outside this query.
      const source: FhirR6DosageInstruction = { step: [{ component: quantities.map(quantity =>
        quantity.value === 0 ? component({ ...quantity, value: 1 },
          { repeat: { ...daily, timeOfDay: ["20:00:00"] } }) : component(quantity)) }] };
      for (const dosage of forms(source)) {
        const result = calculateTotalUnits({ ...options, dosage, durationValue: 12, durationUnit: Unit.Hour });
        expect(result).toMatchObject(expected);
        if (!("unit" in expected)) expect(result.unit).toBeUndefined();
      }
    }
  });

  it.each([[1.5, "h"], [90, "min"], [5400, "s"], [90.5, "min"], [0.5, "s"]] as const)(
    "executes treatment-start +%s %s as an elapsed offset", (value, code) => {
      const offsetMs = value * (code === "h" ? 3600000 : code === "min" ? 60000 : 1000);
      const expected = new Date(Date.parse(origin) + offsetMs).toISOString().replace("Z", "+00:00").replace(".000", "");
      const source: FhirR6DosageInstruction = { step: [{
        start: { contextCode: { coding: [{
          system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
        }] }, offsetDuration: { value, code, system: ucum } },
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { count: 1 } } }],
      }] };
      const original = JSON.stringify(source);
      for (const dosage of forms(source)) {
        expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([expected]);
        expect(calculateTotalUnits({ ...options, dosage, durationValue: 3, durationUnit: Unit.Hour }))
          .toMatchObject({ totalUnits: 1, unit: "tab" });
      }
      expect(JSON.stringify(source)).toBe(original);
    });

  it("keeps conditional opportunities available while the existing supply result explains its assumption", () => {
    const source = parseSig("1 tab daily if SBP > 160").fhirNext;
    const original = JSON.stringify(source);
    for (const dosage of forms(source)) {
      const expected = ["2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00"];
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual(expected);
      expect(nextDueDoses(dosage, { ...options, limit: 2, evaluateCondition: () => true })).toEqual(expected);
      expect(nextDueDoses(dosage, { ...options, limit: 2, evaluateCondition: () => false })).toEqual([]);
      expect(nextDueDoses(dosage, { ...options, limit: 2, evaluateCondition: () => undefined })).toEqual([]);
      const maximum = calculateTotalUnits({ ...options, dosage, durationValue: 2, durationUnit: Unit.Day });
      expect(maximum).toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
      expect(maximum.explanation).toContain("every scheduled clinical condition was assumed true");
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 2, durationUnit: Unit.Day,
        evaluateCondition: () => false }).totalUnits).toBe(0);
    }
    expect(JSON.stringify(source)).toBe(original);
  });

  it.each([
    { name: "empty repeat", repeat: {} },
    { name: "frequency without period", repeat: { frequency: 2 } },
    { name: "frequency with unmeasured period", repeat: { frequency: 2, period: 1 } },
    { name: "multiple uses without cadence", repeat: { count: 2 } },
  ])("keeps $name unknown through scalar and conditional counting", ({ repeat }) => {
    for (const conditional of [false, true]) {
      const source = parseSig(conditional ? "1 tab daily if SBP > 160" : "1 tab daily").fhirNext;
      source.step![0].component[0].timing = { repeat };
      const original = JSON.stringify(source);
      for (const dosage of forms(source))
        expect(() => calculateTotalUnits({ ...options, dosage, durationValue: 1, durationUnit: Unit.Day }))
          .toThrow(expect.objectContaining({ code: "timing-required" }));
      expect(JSON.stringify(source)).toBe(original);
    }
  });

  it("preserves one-time counts and measured infusion supply without recurring cadence", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ rateRatio: { numerator: { value: 50, unit: "mL" },
        denominator: { value: 1, unit: "h", code: "h" } } }],
      timing: { repeat: { count: 1, duration: 2, durationUnit: Unit.Hour } },
    }] }] };
    for (const dosage of forms(source))
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 100, unit: "mL" });
  });
});

describe("round 33 execution history and clock ownership", () => {
  const forms = (source: FhirR6DosageInstruction) => [
    source, JSON.parse(JSON.stringify(toFhirR5Dosages(source))) as FhirDosage[],
    importCanonicalCourse(source),
  ];
  const fixed = (clock: string): FhirR6DosageInstruction => ({ step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 4, periodUnit: Unit.Hour, timeOfDay: [clock] } },
  }] }] });

  it.each(["08.5:30", "08:30.5"])("rejects an impossible civil clock before origin search: %s", clock => {
    // Assert the existing clock boundary first so a regression fails without
    // entering the impossible origin search in this synchronous test.
    expect(() => normalizeClock(clock)).toThrow(/Invalid clock/);
    const source = fixed(clock), before = JSON.stringify(source);
    for (const dosage of forms(source)) {
      expect(() => nextDueDoses(dosage, { ...options, limit: 1 })).toThrow(/Invalid clock/);
      expect(() => calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: Unit.Day }))
        .toThrow(/Invalid clock/);
    }
    expect(importCanonicalCourse(source).stages[0].administrations[0].schedule?.recurrence?.clocks)
      .toEqual([clock]);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("retains fractional seconds and advances across a real spring clock gap", () => {
    for (const dosage of forms(fixed("08:30:00.5"))) {
      expect(nextDueDoses(dosage, { ...options, limit: 2 }).map(Date.parse)).toEqual([
        Date.parse("2026-01-01T08:30:00.500Z"), Date.parse("2026-01-01T12:30:00.500Z"),
      ]);
    }
    const query = { from: "2026-03-08T00:00:00-05:00", orderedAt: "2026-03-08T00:00:00-05:00",
      timeZone: "America/New_York", limit: 2 };
    for (const dosage of forms(fixed("02:30:00")))
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-03-09T02:30:00-04:00", "2026-03-09T06:30:00-04:00",
      ]);
  });

  it.each([false, true])("does not spend conditional replay slots on recorded doses (retained cap %s)", retainedCap => {
    const source = parseSig("1 tab daily if SBP > 160").fhirNext;
    const member = source.step![0].component[0];
    member.timing!.repeat!.count = 2;
    if (retainedCap) member.safety = { doseLimit: [{ scope: "period",
      valueQuantity: { value: 500, unit: "mg" }, period: { value: 1, unit: "d" } }] };
    const before = JSON.stringify(source);
    for (const dosage of forms(source)) {
      const query = { ...options, from: "2026-01-02T00:00:00Z",
        priorDoseTimes: ["2026-01-01T09:00:00Z"], evaluateCondition: () => true, limit: 1 };
      expect(nextDueDoses(dosage, query)).toEqual(["2026-01-02T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(nextDueDoses(dosage, { ...options, limit: 2, evaluateCondition: () => true })).toEqual([
        "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
      ]);
      expect(nextDueDoses(dosage, { ...query, evaluateCondition: () => false })).toEqual([]);
    }
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each([false, true])("preserves the caller receiver for its condition evaluator (%s)", allow => {
    const source = parseSig("1 tab daily if SBP > 160").fhirNext;
    class Evaluation {
      from = origin;
      orderedAt = origin;
      timeZone = "UTC";
      limit = 1;
      durationValue = 1;
      durationUnit = Unit.Day;
      dosage = source;
      allow = allow;
      evaluateCondition() { return this.allow; }
    }
    expect(nextDueDoses(source, new Evaluation())).toEqual(allow ? ["2026-01-01T09:00:00+00:00"] : []);
    expect(calculateTotalUnits(new Evaluation()).totalUnits).toBe(allow ? 1 : 0);
  });

  it.each(["native", "R5", "R6"] as const)("completes uncapped loading from recorded history on the chronological route (%s)", version => {
    const loading = dose();
    loading.schedule!.recurrence = { count: 1, frequency: 1, period: 12, periodUnit: Unit.Hour };
    const maintenance = dose(2);
    maintenance.schedule!.recurrence = { frequency: 1, period: 12, periodUnit: Unit.Hour,
      courseLength: { value: 1, unit: "d" } };
    maintenance.limits = [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 12, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 3, unit: "d" }, cycleCount: 1,
      stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    const dosage = version === "native" ? course : version === "R6" ? courseToR6(course) :
      JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[];
    const before = JSON.stringify(dosage);
    const query = { orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T10:00:00Z", timeZone: "UTC", limit: 2 };
    const recorded = { ...query, priorDoseTimes: ["2026-01-01T09:00:00Z"] };
    expect(nextDueDoses(dosage, recorded)).toEqual([
      "2026-01-01T21:00:00+00:00", "2026-01-02T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage, ...recorded, durationValue: 10.5, durationUnit: Unit.Hour }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ dosage, ...recorded, durationValue: 12, durationUnit: Unit.Hour }).totalUnits).toBe(2);
    expect(nextDueDoses(dosage, query)[0]).toBe("2026-01-01T20:00:00+00:00");
    expect(nextDueDoses(dosage, { ...query, priorDoseTimes: ["2025-12-31T09:00:00Z"] })[0])
      .toBe("2026-01-01T20:00:00+00:00");
    expect(JSON.stringify(dosage)).toBe(before);
  });


  it.each(["native", "R5", "R6"] as const)("keeps recorded loading completion within its phase and cycle (%s)", version => {
    const first = dose(), second = dose(), maintenance = dose(2);
    first.schedule!.recurrence = second.schedule!.recurrence =
      { count: 1, frequency: 1, period: 4, periodUnit: Unit.Hour };
    maintenance.schedule!.recurrence = { frequency: 1, period: 4, periodUnit: Unit.Hour,
      courseLength: { value: 1, unit: "d" } };
    maintenance.limits = [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 4, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 3, unit: "d" }, cycleCount: 2,
      stages: [{ administrations: [first] }, { administrations: [second] }, { administrations: [maintenance] }] };
    const dosage = version === "native" ? course : version === "R6" ? courseToR6(course) :
      JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[];
    const query = { orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-04T16:00:00Z", timeZone: "UTC",
      priorDoseTimes: ["2026-01-01T09:00:00Z", "2026-01-01T14:00:00Z",
        "2026-01-04T10:00:00Z", "2026-01-04T15:00:00Z"], limit: 2 };
    // Cycle two: the first actual dose at 10:00 opens the second phase at
    // 14:00. Its actual dose at 15:00 opens maintenance at 19:00. Earlier-cycle records cannot close either phase.
    expect(nextDueDoses(dosage, query)).toEqual([
      "2026-01-04T19:00:00+00:00", "2026-01-04T23:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Hour }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ dosage, ...query, durationValue: 4, durationUnit: Unit.Hour }).totalUnits).toBe(2);
  });
});

it("round33 supplies half a tablet from a spaced Thai fraction", () => {
  const source = "๑ / ๒ เม็ด วันละครั้ง";
  const fraction = lexInput(source).find(token => token.value === 0.5);
  expect(fraction).toMatchObject({ original: "๑ / ๒", sourceText: "๑ / ๒", sourceStart: 0, sourceEnd: 5 });
  const parsed = parseSig(source, { locale: "th" });
  expect(parsed.input).toBe(source);
  expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 0.5, unit: "tab" });
  for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))])
    expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(3.5);
});

describe("round34 execution boundary regressions", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : version === "R5" ? courseToR5(course) : courseToR6(course);

  it.each(versions)("keeps the second fold instant as the first inferred weekly slot (%s)", version => {
    const member = dose();
    member.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Week };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    const input = wire(course, version), original = JSON.stringify(input);
    const query = { orderedAt: "2026-11-01T06:30:00Z", from: "2026-11-01T06:30:00Z",
      timeZone: "America/New_York" };
    expect(nextDueDoses(input, { ...query, limit: 3 })).toEqual([
      "2026-11-01T01:30:00-05:00", "2026-11-04T01:30:00-05:00", "2026-11-08T01:30:00-05:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Week }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(original);

    // An authored 01:30 still resolves to the first fold, before this order.
    member.schedule!.recurrence!.clocks = ["01:30:00"];
    expect(nextDueDoses(wire(course, version), { ...query, limit: 2 })).toEqual([
      "2026-11-04T01:30:00-05:00", "2026-11-08T01:30:00-05:00",
    ]);
  });

  it.each(versions)("repeats a clamped civil month from the resolved prior exclusive end (%s)", version => {
    const maintenance = dose(2);
    maintenance.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: relative(1, "mo"), end: relative(2, "mo"), count: 2, administrations: [dose()] },
      { administrations: [maintenance] },
    ] };
    const input = wire(course, version), original = JSON.stringify(input);
    const query = { from: "2026-01-31T00:00:00Z", orderedAt: "2026-01-31T00:00:00Z", timeZone: "UTC" };
    // First window: Feb 28 through Mar 30. Second: Mar 31 through Apr 29.
    // Maintenance then supplies two tablets on Apr 30 and May 1.
    const expected = [
      "2026-02-28",
      ...Array.from({ length: 31 }, (_, index) => "2026-03-" + ("0" + (index + 1)).slice(-2)),
      ...Array.from({ length: 30 }, (_, index) => "2026-04-" + ("0" + (index + 1)).slice(-2)),
      "2026-05-01",
    ].map(day => day + "T09:00:00+00:00");
    expect(nextDueDoses(input, { ...query, limit: 80 })).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 91, durationUnit: Unit.Day }).totalUnits).toBe(65);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(versions)("retains clamped one-month spans when the first repeated step starts at treatment (%s)", version => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: relative(0), end: relative(1, "mo"), count: 3, administrations: [dose()] },
    ] };
    const input = wire(course, version), original = JSON.stringify(input);
    const query = { from: "2026-01-31T00:00:00Z", orderedAt: "2026-01-31T00:00:00Z", timeZone: "UTC" };
    // Jan31-Feb28, Feb28-Mar28, Mar28-Apr28: 28 + 28 + 31 days.
    const expected = ["2026-01-31",
      ...Array.from({ length: 28 }, (_, index) => "2026-02-" + ("0" + (index + 1)).slice(-2)),
      ...Array.from({ length: 31 }, (_, index) => "2026-03-" + ("0" + (index + 1)).slice(-2)),
      ...Array.from({ length: 27 }, (_, index) => "2026-04-" + ("0" + (index + 1)).slice(-2)),
    ].map(day => day + "T09:00:00+00:00");
    expect(nextDueDoses(input, { ...query, limit: 100 })).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 91, durationUnit: Unit.Day }).totalUnits).toBe(87);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(versions)("keeps a member's treatment-relative weekly origin through repeated civil windows (%s)", version => {
    const member = dose();
    member.phaseStart = relative(1, "mo");
    member.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: Unit.Week, clocks: ["09:00:00"] };
    const course: CanonicalCourse = { kind: "course", stages: [
      { start: relative(1, "mo"), end: relative(2, "mo"), count: 2, administrations: [member] },
    ] };
    const query = { from: "2026-01-31T00:00:00Z", orderedAt: "2026-01-31T00:00:00Z", timeZone: "UTC" };
    // The member is anchored to Feb 28, so the second step window keeps
    // Saturdays Apr 4/11/18/25 instead of restarting weekly cadence Mar 31.
    const days = ["2026-02-28", "2026-03-07", "2026-03-14", "2026-03-21", "2026-03-28",
      "2026-04-04", "2026-04-11", "2026-04-18", "2026-04-25"];
    for (const cutoff of ["none", "calendar", "phase"] as const) {
      member.schedule!.recurrence!.calendarWindow = cutoff === "calendar" ? { end: "2026-04-13T00:00:00Z" } : undefined;
      member.phaseEnd = cutoff === "phase" ? relative(2, "mo") : undefined;
      const input = wire(course, version), original = JSON.stringify(input);
      const count = cutoff === "phase" ? 5 : cutoff === "calendar" ? 7 : 9;
      const expected = days.slice(0, count).map(day => day + "T09:00:00+00:00");
      expect(nextDueDoses(input, { ...query, limit: 20 })).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 91, durationUnit: Unit.Day }).totalUnits)
        .toBe(count);
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it.each(versions)("returns zero before a future ranged-frequency or ranged-period window (%s)", version => {
    for (const kind of ["frequency", "period"] as const) {
      const member = dose();
      member.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: Unit.Day,
        ...(kind === "frequency" ? { frequencyMax: 2 } : { periodMax: 2 }),
        clocks: ["09:00:00"], calendarWindow: { start: "2026-01-10T00:00:00Z" } };
      const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
      const input = version === "native" ? member : version === "R5" ? courseToR5(course)[0] : courseToR6(course);
      const original = JSON.stringify(input);
      for (const from of ["2026-01-01T00:00:00Z", "2026-01-09T00:00:00Z"])
        expect(calculateTotalUnits({ ...options, dosage: input, from, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
      expect(calculateTotalUnits({ ...options, dosage: input, from: "2026-01-10T00:00:00Z",
        durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(kind === "frequency" ? 2 : 1);
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it.each(versions)("withholds untimed PRN calendar capacity when a supplied evaluator is unknown (%s)", version => {
    const parsed = parseSig("Take 1 tablet as needed up to 2 times daily only on dialysis days.");
    const course = importCanonicalCourse(parsed.fhirNext);
    const input = wire(course, version), original = JSON.stringify(input);
    const query = { ...options, dosage: input, durationValue: 3, durationUnit: Unit.Day };
    expect(calculateTotalUnits(query).totalUnits).toBe(6);
    expect(calculateTotalUnits({ ...query, evaluateCondition: () => true }).totalUnits).toBe(6);
    expect(calculateTotalUnits({ ...query, evaluateCondition: () => undefined }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ ...query, evaluateCondition: () => false }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ ...query, evaluateCondition: (_condition, at) =>
      at.startsWith("2026-01-01") ? true : at.startsWith("2026-01-02") ? undefined : false }).totalUnits).toBe(2);
    expect(nextDueDoses(input, { ...options, limit: 1 })).toEqual([]);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(versions)("cannot combine incompatible member clock plans across overlapping cycles (%s)", version => {
    const first = dose(), second = dose();
    for (const [member, clock, name] of [[first, "06:00:00", "A"], [second, "09:00:00", "B"]] as const) {
      member.schedule!.recurrence = { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
        clocks: [clock], courseLength: { value: 2, unit: "d" } };
      member.predicate = { kind: "state", name, text: name, expected: true };
      member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 24, unit: "h" } }];
    }
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 2,
      stages: [{ administrations: [first, second] }] };
    const input = wire(course, version), original = JSON.stringify(input);
    const query = { ...options, from: "2026-01-02T06:00:00Z", durationValue: 2.5, durationUnit: Unit.Hour,
      evaluateCondition: (condition: import("../src").MedicationCondition, at: string) =>
        condition.kind === "state" && at.includes(condition.name === "A" ? "T06:00:00" : "T08:00:00") };
    // Jan 2 is shared by both cycles. The authored plan admits A at 06:00;
    // the inferred plan admits B at 08:00. Each complete joint plan supplies
    // one tablet; selecting a separate winner per member would wrongly add two.
    expect(calculateTotalUnits({ ...query, dosage: input }).totalUnits).toBe(1);
    expect(JSON.stringify(input)).toBe(original);
  });
});


describe("round35 execution cap and history oracles", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (member: CanonicalAdministration | CanonicalCourse, version: typeof versions[number]) => {
    const course: CanonicalCourse = member.kind === "course" ? member : { kind: "course", stages: [{ administrations: [member] }] };
    return version === "native" ? member : version === "R5"
      ? JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[] : courseToR6(course);
  };
  const ranged = (maximum = 3): CanonicalAdministration => ({
    ...dose(), amounts: [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"] } },
    limits: [{ scope: "period", amount: { value: maximum, unit: "tab" }, period: { value: 48, unit: "h" } }],
  });
  it.each(versions)("proves a partial final rolling-cap partition without subset search (%s)", version => {
    const input = wire(ranged(), version), before = JSON.stringify(input);
    // Each adjacent pair supplies at most three. The final unpaired clock
    // can supply at most two: alternating 2,1,...,2 attains the bound.
    for (const [days, total] of [[50, 75], [51, 77], [52, 78], [53, 80]])
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: days, durationUnit: Unit.Day }).totalUnits)
        .toBe(total);
    // Query starts after the last clock; no empty tail partition receives a cap.
    expect(calculateTotalUnits({ ...options, dosage: input, from: "2026-01-01T09:00:00Z",
      durationValue: 51, durationUnit: Unit.Day }).totalUnits).toBe(77);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("counts delayed recorded administrations once before nominal replay (%s)", version => {
    for (const delayMinutes of [0, 120, -120]) {
      const value = dose(); value.delayMinutes = delayMinutes;
      value.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: Unit.Day,
        clocks: ["08:00:00"], count: 2 };
      value.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 48, unit: "h" } }];
      const input = wire(value, version), before = JSON.stringify(input);
      const clock = delayMinutes === 120 ? "10:00:00" : delayMinutes === -120 ? "06:00:00" : "08:00:00";
      const query = { ...options, from: "2026-01-02T00:00:00Z", priorDoseTimes: ["2026-01-01T" + clock + "Z"], limit: 3 };
      const historyBefore = JSON.stringify(query);
      expect(nextDueDoses(input, query)).toEqual(["2026-01-02T" + clock + "+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(nextDueDoses(input, { ...query, priorDoseTimes: ["2026-01-01T" + clock + "Z", "2026-01-02T" + clock + "Z"],
        from: "2026-01-03T00:00:00Z" })).toEqual([]);
      expect(JSON.stringify(query)).toBe(historyBefore);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("finishes counted ranged loading at its last quantity-admitted event (%s)", version => {
    const loading = ranged(1); loading.schedule!.recurrence!.count = 2;
    const maintenance = dose(2); maintenance.schedule!.recurrence = {
      frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"], count: 2,
    };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    // One tablet at Jan 1 08:00 and Jan 3 08:00 completes loading.
    // Maintenance starts at the next authored 08:00, on Jan 4.
    expect(nextDueDoses(input, { ...options, limit: 8 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
      "2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00",
    ]);
    for (const [days, total] of [[2, 1], [3, 2], [4, 4], [5, 6]])
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: days, durationUnit: Unit.Day }).totalUnits).toBe(total);
    expect(JSON.stringify(input)).toBe(before);
    loading.limits = undefined;
    const uncapped = wire(course, version);
    expect(nextDueDoses(uncapped, { ...options, limit: 8 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: uncapped, ...options, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(8);
  });

  it.each(versions)("shares range-cap history and exclusion admission with counted completion (%s)", version => {
    const loading = ranged(1); loading.schedule!.recurrence!.count = 2;
    const maintenance = dose(2); maintenance.schedule!.recurrence = {
      frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"], count: 1,
    };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    const input = wire(course, version);
    const query = { ...options, from: "2026-01-02T00:00:00Z", priorDoseTimes: ["2026-01-01T08:00:00Z"], limit: 4 };
    // The recorded dose releases exactly at Jan3 08:00. It consumes the
    // loading count once; the new Jan3 dose completes that phase.
    expect(nextDueDoses(input, query)).toEqual(["2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(3);
    loading.excludedDates = ["2026-01-03"];
    const excluded = wire(course, version);
    expect(nextDueDoses(excluded, { ...options, limit: 4 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: excluded, ...options, durationValue: 5, durationUnit: Unit.Day }).totalUnits).toBe(4);
    // A whole-course repeat uses the same count admission without running
    // supply maximization when the caller only requests administration clocks.
    course.cycleInterval = { value: 7, unit: "d" }; course.cycleCount = 1;
    expect(nextDueDoses(wire(course, version), { ...options, limit: 4 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00",
    ]);
  });

  it.each(versions)("retains strict range admission and fractional loading amounts (%s)", version => {
    const loading = ranged(3); loading.amounts![0].range!.low!.value = 1.5;
    loading.schedule!.recurrence!.count = 2;
    const maintenance = dose(2); maintenance.schedule!.recurrence = {
      frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"], count: 1,
    };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    expect(nextDueDoses(wire(course, version), { ...options, limit: 4 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: wire(course, version), ...options, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(5);
    loading.amounts![0].range!.low = { value: 1, unit: "tab", comparator: ">" };
    loading.limits![0].amount!.value = 2;
    const input = wire(course, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(6);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("keeps spaced administration and periodic mass caps in their authored units (%s)", version => {
    const value = dose(); value.amounts = [{ range: {
      low: { value: 500, unit: "mg" }, high: { value: 1500, unit: "mg" },
    } }];
    value.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00", "20:00:00"] };
    value.limits = [
      { scope: "administration", amount: { value: 1, unit: "g " } },
      { scope: "period", amount: { value: 1.5, unit: "g " }, period: { value: 24, unit: "h" } },
    ];
    const input = wire(value, version), before = JSON.stringify(input);
    const result = calculateTotalUnits({ dosage: input, ...options, durationValue: 2, durationUnit: Unit.Day });
    expect(result).toMatchObject({ totalUnits: 3000, unit: "mg" });
    expect(result.explanation).not.toContain("could not be applied");
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("keeps counted delayed points eligible after an immediate predecessor (%s)", version => {
    const immediate = dose(2); immediate.schedule!.recurrence = { anchors: ["IMD"] };
    const delayed = dose(); delayed.schedule!.recurrence = { count: 1 }; delayed.delayMinutes = 720;
    const final = dose(3); final.schedule!.recurrence = { count: 1 }; final.delayMinutes = 60;
    const course: CanonicalCourse = { kind: "course", stages: [
      { administrations: [immediate] }, { administrations: [delayed] }, { administrations: [final] },
    ] };
    const input = wire(course, version), before = JSON.stringify(input);
    const query = { from: "2026-11-21T07:00:00Z", orderedAt: "2026-11-21T08:00:00Z", timeZone: "UTC", limit: 4 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-11-21T08:00:00+00:00", "2026-11-21T20:00:00+00:00", "2026-11-21T21:00:00+00:00",
    ]);
    expect(nextDueDoses(input, { ...query, from: "2026-11-22T00:00:00Z" })).toEqual([]);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(6);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("uses a single dated successor as the effective open-phase cutoff (%s)", version => {
    const loading = dose(); loading.schedule!.recurrence = {
      frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["22:00:00"], calendarWindow: { start: "2026-12-01" },
    };
    const maintenance = dose(2); maintenance.schedule!.recurrence = {
      frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["06:00:00"], calendarWindow: { start: "2026-12-02" },
    };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [loading] }, { administrations: [maintenance] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    const query = { orderedAt: "2026-12-01T12:00:00Z", from: "2026-11-21T08:00:00Z", timeZone: "UTC" };
    expect(nextDueDoses(input, { ...query, limit: 3 })).toEqual([
      "2026-12-01T22:00:00+00:00", "2026-12-02T06:00:00+00:00", "2026-12-03T06:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...query, from: "2026-12-01T00:00:00Z",
      durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(5);
    expect(JSON.stringify(input)).toBe(before);
    expect(loading.schedule!.recurrence!.count).toBeUndefined();
    expect(loading.schedule!.recurrence!.calendarWindow!.end).toBeUndefined();
    // A real earlier endpoint remains the predecessor's endpoint; the
    // explicit successor still starts on its own date after the gap.
    loading.schedule!.recurrence!.calendarWindow!.end = "2026-12-01T22:00:00Z";
    expect(nextDueDoses(wire(course, version), { ...query, limit: 3 })).toEqual([
      "2026-12-01T22:00:00+00:00", "2026-12-02T06:00:00+00:00", "2026-12-03T06:00:00+00:00",
    ]);
  });

  it.each(versions)("intersects compatible spaced mass maxima without changing authored measurements (%s)", version => {
    for (const reverse of [false, true]) {
      const value = dose(500); value.amounts![0].quantity!.unit = "mg";
      value.limits = [{ scope: "lifetime", amount: { value: 1, unit: "g " } },
        { scope: "lifetime", amount: { value: 2000, unit: "mg" } }];
      if (reverse) value.limits.reverse();
      const input = wire(value, version), before = JSON.stringify(input);
      const result = calculateTotalUnits({ dosage: input, ...options, durationValue: 7, durationUnit: Unit.Day });
      expect(result).toMatchObject({ totalUnits: 1000, unit: "mg" });
      expect(result.explanation).not.toContain("could not be applied");
      expect(JSON.stringify(input)).toBe(before);
      const projected = projectCanonicalCourse({ kind: "course", stages: [{ administrations: [value] }] });
      for (const exported of [projected.fhir, projected.fhirNext])
        expect(importCanonicalCourse(exported).stages[0].administrations[0].limits)
          .toEqual(expect.arrayContaining(value.limits!.map(limit => expect.objectContaining(limit))));
    }
  });

  it.each(versions)("repeats an omitted midnight displacement as civil days across the fall-back (%s)", version => {
    const member = dose(); member.schedule!.recurrence!.clocks = ["00:30:00"];
    for (const explicitZero of [false, true]) {
      const course: CanonicalCourse = { kind: "course", stages: [{
        start: { anchor: "treatment-day-start", ...(explicitZero ? { displacement: { value: 0, unit: "d" } } : {}) },
        end: { anchor: "treatment-day-start", displacement: { value: 1, unit: "d" } },
        count: 2, administrations: [member],
      }] };
      const input = wire(course, version), before = JSON.stringify(input);
      const query = { from: "2026-11-01T04:00:00Z", orderedAt: "2026-11-01T04:00:00Z", timeZone: "America/New_York" };
      expect(nextDueDoses(input, { ...query, limit: 5 })).toEqual([
        "2026-11-01T00:30:00-04:00", "2026-11-02T00:30:00-05:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round36 execution admission and actual-clock ownership", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (member: CanonicalAdministration | CanonicalCourse, version: typeof versions[number]) => {
    const course: CanonicalCourse = member.kind === "course" ? member : { kind: "course", stages: [{ administrations: [member] }] };
    return version === "native" ? member : version === "R5"
      ? JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[] : JSON.parse(JSON.stringify(courseToR6(course))) as FhirR6DosageInstruction;
  };
  const periodCap = (value = 100, hours = 24, unit = "tab"): NonNullable<CanonicalAdministration["limits"]> =>
    [{ scope: "period", amount: { value, unit }, period: { value: hours, unit: "h" } }];
  const untimed = () => parseSig("Take 1 tablet as needed at most once daily.")
    .meta!.canonical!.course!.stages[0].administrations[0];

  it.each(versions)("keeps unrecorded untimed PRN capacity after a midday query (%s)", version => {
    for (const ranged of [false, true]) for (const repetition of ["stage", "course"] as const) {
      const member = untimed();
      if (ranged) member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
      member.limits = periodCap(1, 48);
      const course: CanonicalCourse = { kind: "course",
        ...(repetition === "course" ? { cycleInterval: { value: 1, unit: "d" }, cycleCount: 2 } : {}),
        stages: [{ ...(repetition === "stage" ? { count: 2 } : {}),
          start: relative(0), end: relative(1), administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      const query = { ...options, dosage: input, from: "2026-01-01T12:00:00Z", durationValue: 1, durationUnit: Unit.Day };
      expect(calculateTotalUnits(query).totalUnits).toBe(1);
      expect(calculateTotalUnits({ ...query, priorDoseTimes: ["2026-01-01T08:00:00Z"] }).totalUnits).toBe(0);
      expect(nextDueDoses(input, { ...query, limit: 2 })).toEqual([]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("spends a finite PRN allowance only on admitted opportunities (%s)", version => {
    for (const bound of ["count", "countMax"] as const) for (const restriction of ["condition", "date", "weekday"] as const) {
      const member = dose(); member.asNeeded = true; member.schedule!.recurrence![bound] = 2;
      if (restriction === "condition") member.predicate = { kind: "state", name: "pain", text: "pain", expected: true };
      if (restriction === "date") member.excludedDates = ["2026-01-01"];
      if (restriction === "weekday") member.excludedWeekdays = [FhirDayOfWeek.Thursday];
      const input = wire(member, version), before = JSON.stringify(input);
      const query = { ...options, limit: 4, evaluateCondition: (_condition: unknown, at: string) => !at.startsWith("2026-01-01") };
      expect(nextDueDoses(input, query)).toEqual(["2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(nextDueDoses(input, { ...query, priorCount: 1 })).toEqual(["2026-01-02T09:00:00+00:00"]);
      expect(nextDueDoses(input, { ...query, priorCount: 2 })).toEqual([]);
      expect(calculateTotalUnits({ ...query, dosage: input, priorCount: 2, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(0);
      const late = { ...query, from: "2026-01-03T00:00:00Z" };
      expect(nextDueDoses(input, late)).toEqual(["2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00"]);
      expect(nextDueDoses(input, { ...late, priorDoseTimes: ["2026-01-02T10:00:00Z"] }))
        .toEqual(["2026-01-03T09:00:00+00:00"]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("retains a conditional PRN one-shot identity and explicit consumed count (%s)", version => {
    const member = dose(); member.asNeeded = true; member.schedule!.recurrence = { count: 1 };
    member.predicate = { kind: "state", name: "pain", text: "pain", expected: true };
    const input = wire(member, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, evaluateCondition: () => true, limit: 2 }))
      .toEqual(["2026-01-01T00:00:00+00:00"]);
    expect(nextDueDoses(input, { ...options, evaluateCondition: () => false, limit: 2 })).toEqual([]);
    expect(nextDueDoses(input, { ...options, evaluateCondition: () => true, priorCount: 1, limit: 2 })).toEqual([]);
    expect(nextDueDoses(input, { ...options, from: "2026-01-02T00:00:00Z", evaluateCondition: () => true, limit: 2 })).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("charges delayed administrations to their actual civil occurrence buckets (%s)", version => {
    for (const ranged of [false, true]) {
      const member = untimed(); member.asNeeded = false; member.delayMinutes = 120;
      if (ranged) {
        member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
        member.limits = periodCap();
      }
      member.schedule!.recurrence = { ...member.schedule!.recurrence, frequency: 2, period: 1, periodUnit: Unit.Day,
        clocks: ["00:30:00", "22:30:00"] };
      const input = wire(member, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
        "2026-01-01T02:30:00+00:00", "2026-01-02T00:30:00+00:00", "2026-01-03T00:30:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 26, durationUnit: Unit.Hour }).totalUnits)
        .toBe(ranged ? 4 : 2);
      expect(nextDueDoses(input, { ...options, from: "2026-01-01T03:00:00Z",
        priorDoseTimes: ["2026-01-01T02:30:00Z"], limit: 2 })).toEqual([
        "2026-01-02T00:30:00+00:00", "2026-01-03T00:30:00+00:00",
      ]);
      expect(JSON.stringify(input)).toBe(before);
      member.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
      expect(calculateTotalUnits({ ...options, dosage: wire(member, version),
        durationValue: 26, durationUnit: Unit.Hour }).totalUnits).toBe(ranged ? 4 : 2);
      member.schedule!.recurrence!.calendarWindow = { end: "2026-01-01T22:00:00Z" };
      expect(calculateTotalUnits({ ...options, dosage: wire(member, version),
        durationValue: 26, durationUnit: Unit.Hour }).totalUnits).toBe(ranged ? 2 : 1);
      member.schedule!.recurrence!.courseLength = undefined;
      member.schedule!.recurrence!.calendarWindow = undefined;
      member.delayMinutes = 0;
      expect(nextDueDoses(wire(member, version), { ...options, limit: 2 })).toEqual([
        "2026-01-01T00:30:00+00:00", "2026-01-02T00:30:00+00:00",
      ]);
    }
  });

  it.each(versions)("charges the range's bilateral drop amount to its rolling cap (%s)", version => {
    const member = parseSig("Instill 1-2 drops in each eye at 08:00 and 20:00")
      .meta!.canonical!.course!.stages[0].administrations[0];
    member.limits = periodCap(3, 24, "drop");
    const input = wire(member, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(JSON.stringify(input)).toBe(before);
    // One target may admit both minimum amounts within the same cap.
    member.targetCount = 1;
    expect(nextDueDoses(member, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
    // Metric quantities already describe the total and must not multiply by target count.
    member.targetCount = 2;
    member.amounts = [{ range: { low: { value: 1, unit: "mg" }, high: { value: 2, unit: "mg" } } }];
    member.limits = periodCap(3, 24, "mg");
    expect(nextDueDoses(member, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
  });

  it.each(versions)("keeps shifted candidates inside the actual exclusive stage end (%s)", version => {
    for (const delayMinutes of [-120, 0, 120]) {
      const member = dose(); member.delayMinutes = delayMinutes; member.limits = periodCap();
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 1,
        stages: [{ start: relative(0), end: relative(8, "h"), administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 }))
        .toEqual(delayMinutes < 0 ? ["2026-01-01T07:00:00+00:00"] : []);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(delayMinutes < 0 ? 1 : 0);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("charges actual history to a counted phase without moving its authored end (%s)", version => {
    const loading = dose(); loading.schedule!.recurrence!.clocks = ["07:00:00"];
    loading.schedule!.recurrence!.count = 2; loading.limits = periodCap();
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 1,
      stages: [{ start: relative(0), end: relative(4), administrations: [loading] }, { administrations: [dose(2)] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    const query = { ...options, orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-02T00:00:00Z", limit: 3 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-02T07:00:00+00:00", "2026-01-03T07:00:00+00:00", "2026-01-05T09:00:00+00:00",
    ]);
    const recorded = { ...query, priorDoseTimes: ["2026-01-01T10:00:00Z"] };
    expect(nextDueDoses(input, recorded)).toEqual([
      "2026-01-02T07:00:00+00:00", "2026-01-05T09:00:00+00:00", "2026-01-06T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...recorded, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...query, priorDoseTimes: ["2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"] })[0])
      .toBe("2026-01-05T09:00:00+00:00");
    expect(nextDueDoses(input, { ...query, priorDoseTimes: ["2026-01-01T07:00:00Z"] })).toEqual(nextDueDoses(input, query));
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("round37 finite-phase history and eligibility ownership", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : version === "R5"
      ? JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[]
      : JSON.parse(JSON.stringify(courseToR6(course))) as FhirR6DosageInstruction;
  const counted = (count: number): CanonicalAdministration => ({
    ...dose(),
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"], count } },
    limits: [{ scope: "period", amount: { value: 100, unit: "tab" }, period: { value: 24, unit: "h" } }],
  });

  it.each(versions)("uses actual finite-phase history before replay without shifting its end or another cycle (%s)", version => {
    const maintenance = dose(2); maintenance.schedule!.recurrence!.count = 1;
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 2,
      stages: [{ start: relative(0), end: relative(4), administrations: [counted(2)] },
        { administrations: [maintenance] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    const query = { ...options, from: "2026-01-02T00:00:00Z", limit: 8 };
    const remaining = [
      "2026-01-02T08:00:00+00:00", "2026-01-05T09:00:00+00:00",
      "2026-01-08T08:00:00+00:00", "2026-01-09T08:00:00+00:00", "2026-01-12T09:00:00+00:00",
    ];
    for (const priorDoseTimes of [undefined, ["2026-01-01T08:00:00Z"], ["2026-01-01T10:00:00Z"]]) {
      const history = { ...query, priorDoseTimes };
      expect(nextDueDoses(input, history)).toEqual(remaining);
      expect(calculateTotalUnits({ dosage: input, ...history, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(calculateTotalUnits({ dosage: input, ...history, durationValue: 11, durationUnit: Unit.Day }).totalUnits).toBe(7);
    }
    const later = { ...query, from: "2026-01-03T00:00:00Z", priorDoseTimes: ["2026-01-01T10:00:00Z"] };
    expect(nextDueDoses(input, later)).toEqual(["2026-01-03T08:00:00+00:00", ...remaining.slice(1)]);
    expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    const completed = { ...query, priorDoseTimes: ["2026-01-01T10:00:00Z", "2026-01-01T20:00:00Z"] };
    expect(nextDueDoses(input, completed)).toEqual(remaining.slice(1));
    expect(calculateTotalUnits({ dosage: input, ...completed, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    // A record outside this phase does not replace its inferred daily history.
    expect(nextDueDoses(input, { ...query, from: "2026-01-03T00:00:00Z",
      priorDoseTimes: ["2025-12-31T10:00:00Z"] })).toEqual(remaining.slice(1));
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => ["exact", "range", "maximum"].map(quota => [version, quota] as const)))
    ("starts finite count at eligibility while retaining an earlier recurrence origin (%s, %s)", (version, quota) => {
    for (const period of [1, 2]) for (const stageStart of [0, 3]) {
      const member = counted(quota === "range" ? 1 : 2); member.limits = undefined;
      if (quota !== "exact") member.schedule!.recurrence!.countMax = 2;
      if (quota === "maximum") delete member.schedule!.recurrence!.count;
      member.phaseStart = relative(0);
      member.schedule!.recurrence!.period = period;
      member.schedule!.recurrence!.clocks = ["09:00:00"];
      const course: CanonicalCourse = { kind: "course", stages: [{ start: relative(stageStart), administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      const days = stageStart === 0 ? (period === 1 ? [1, 2] : [1, 3])
        : period === 1 ? [4, 5] : [5, 7];
      const expected = days.map(day => "2026-01-0" + day + "T09:00:00+00:00");
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 8, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(nextDueDoses(input, { ...options, from: "2026-01-06T00:00:00Z", limit: 4 }))
        .toEqual(stageStart === 3 && period === 2 ? [expected[1]] : []);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("keeps actual-history ownership within staggered member eligibility (%s)", version => {
    const first = counted(3), second = counted(2);
    first.phaseStart = relative(0);
    second.phaseStart = relative(2);
    second.schedule!.recurrence!.clocks = ["20:00:00"];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 1,
      stages: [{ start: relative(1), end: relative(5), administrations: [first, second] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    for (const hasEligibleActual of [false, true]) {
      // The Jan 1 record is before the stage. Jan 2 belongs only to the first
      // member; the second retains its inferred Jan 3 20:00 administration.
      const priorDoseTimes = ["2026-01-01T10:00:00Z",
        ...(hasEligibleActual ? ["2026-01-02T10:00:00Z"] : [])];
      const query = { ...options, from: "2026-01-04T00:00:00Z", priorDoseTimes, limit: 8 };
      const expected = ["2026-01-04T08:00:00+00:00", "2026-01-04T20:00:00+00:00",
        ...(hasEligibleActual ? ["2026-01-05T08:00:00+00:00"] : [])];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits)
        .toBe(hasEligibleActual ? 3 : 2);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("uses the same remaining finite allowance for ranged due doses and maximum supply (%s)", version => {
    const member = counted(3);
    member.schedule!.recurrence!.frequency = 2;
    member.schedule!.recurrence!.clocks = ["08:00:00", "20:00:00"];
    member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 1,
      stages: [{ start: relative(0), end: relative(4), administrations: [member] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    const expected = ["2026-01-02T08:00:00+00:00", "2026-01-02T20:00:00+00:00"];
    for (const priorDoseTimes of [
      ["2026-01-01T20:00:00Z"],
      ["2026-01-01T10:00:00Z", "2026-01-01T20:00:00Z"],
      ["2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", "2026-01-01T20:00:00Z"],
    ]) {
      const query = { ...options, from: "2026-01-02T00:00:00Z", priorDoseTimes, limit: 4 };
      const remaining = 3 - priorDoseTimes.length;
      expect(nextDueDoses(input, query)).toEqual(expected.slice(0, remaining));
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(remaining * 2);
    }
    // The two remaining uses must also fit the authored rolling quantity
    // ceiling: 2 actual tablets at Jan 1 20:00 leave 1 at Jan 2 08:00, then
    // that old record expires and permits 2 at Jan 2 20:00. Total: 3.
    const cappedMember = { ...member, limits: [{ scope: "period" as const,
      amount: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }] };
    const cappedCourse: CanonicalCourse = { ...course,
      stages: [{ ...course.stages[0], administrations: [cappedMember] }] };
    const cappedInput = wire(cappedCourse, version), cappedBefore = JSON.stringify(cappedInput);
    const cappedQuery = { ...options, from: "2026-01-02T00:00:00Z",
      priorDoseTimes: ["2026-01-01T20:00:00Z"], limit: 4 };
    expect(nextDueDoses(cappedInput, cappedQuery)).toEqual(expected);
    expect(calculateTotalUnits({ dosage: cappedInput, ...cappedQuery, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(JSON.stringify(cappedInput)).toBe(cappedBefore);
    // Without actual history, the two Jan 1 clocks consume two of three uses.
    const inferred = { ...options, from: "2026-01-02T00:00:00Z", limit: 4 };
    expect(nextDueDoses(input, inferred)).toEqual([expected[0]]);
    expect(calculateTotalUnits({ dosage: input, ...inferred, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(before);
  });
});


// Retained regression suite from test/pr14-round20-execution.spec.ts.
/** Independent execution oracles for the complete November 18 review families. */
import { describe as round38_execution20_describe, expect as round38_execution20_expect, it as round38_execution20_it } from "vitest";
import { calculateTotalUnits as round38_execution20_calculateTotalUnits, nextDueDoses as round38_execution20_nextDueDoses, parseSig as round38_execution20_parseSig, toFhirR5Dosages as round38_execution20_toFhirR5Dosages } from "../src/index";
import type { CanonicalAdministration as round38_execution20_CanonicalAdministration, CanonicalCourse as round38_execution20_CanonicalCourse } from "../src/canonical/course";
import { FhirPeriodUnit as round38_execution20_FhirPeriodUnit, type FhirDosage as round38_execution20_FhirDosage, type FhirR6DosageInstruction as round38_execution20_FhirR6DosageInstruction } from "../src/types";
import { addCalendarDaysAtClock as round38_execution20_addCalendarDaysAtClock, addCalendarMonths as round38_execution20_addCalendarMonths, getTimeParts as round38_execution20_getTimeParts } from "../src/execution/calendar";
{
  const describe = round38_execution20_describe;
  const expect = round38_execution20_expect;
  const it = round38_execution20_it;
  const calculateTotalUnits = round38_execution20_calculateTotalUnits;
  const nextDueDoses = round38_execution20_nextDueDoses;
  const parseSig = round38_execution20_parseSig;
  const toFhirR5Dosages = round38_execution20_toFhirR5Dosages;
  type CanonicalAdministration = round38_execution20_CanonicalAdministration;
  type CanonicalCourse = round38_execution20_CanonicalCourse;
  const FhirPeriodUnit = round38_execution20_FhirPeriodUnit;
  type FhirPeriodUnit = round38_execution20_FhirPeriodUnit;
  type FhirDosage = round38_execution20_FhirDosage;
  type FhirR6DosageInstruction = round38_execution20_FhirR6DosageInstruction;
  const addCalendarDaysAtClock = round38_execution20_addCalendarDaysAtClock;
  const addCalendarMonths = round38_execution20_addCalendarMonths;
  const getTimeParts = round38_execution20_getTimeParts;
// BEGIN PRESERVED execution20
/** Independent execution oracles for the complete November 18 review families. */






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

// Consolidated accepted-cap oracles; the lexical block retains their original fixture scope.
{
/**
 * Caps consume accepted administrations, not opportunities rejected by another
 * constraint. These dates and amounts are independent clinical accounting oracles.
 */

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
    expect(nextDueDoses(course, { ...options, limit: 5 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00",
      "2026-01-05T08:00:00+00:00",
    ]);
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
    const withPrior = supply(dailyCourse(member), 4, { priorDoseTimes: ["2025-12-31T08:00:00Z"] });
    expect(withPrior.totalUnits).toBe(4);
    expect(withPrior.explanation).toContain("each recorded prior ranged administration was assumed to use the upper dose bound (2 tab)");
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
    const withRecordedRange = supply(course, 1, { priorDoseTimes: ["2025-12-31T08:00:00Z"] });
    expect(withRecordedRange.totalUnits).toBe(2);
    expect(withRecordedRange.explanation)
      .toContain("each recorded prior ranged administration was assumed to use the upper dose bound (2 tab)");
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
    member.schedule!.recurrence!.countMax = 1;
    expect(supply(course, 1).totalUnits).toBe(2);
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
}

// END PRESERVED execution20
}
