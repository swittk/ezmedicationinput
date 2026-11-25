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
import { calculateTotalUnits, nextDueDoses, toEzDosages, fromFhir, toFhirR5Dosages, toDosageDetails, TIMING_OCCURRENCE_CAP_EXTENSION_URL, parseSig, formatSig, projectCanonicalCourse, importCanonicalCourse } from "../src/index";
import type { CanonicalAdministration, CanonicalCourse, CanonicalBoundary } from "../src/canonical/course";
import { EventTiming, FhirDayOfWeek, FhirPeriodUnit as Unit, type FhirDosage, type FhirR6DosageInstruction } from "../src/types";

const freshExecutionInput = <T>(value: T): T => JSON.parse(JSON.stringify(value));

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
    const edited = { ...lifted,
      maxDosePerPeriod: [{ numerator: { value: 1, unit: "tab" }, denominator: { value: 1, unit: "d" } }] };
    expect(nextDueDoses(edited, { ...options, limit: 2 })).toEqual([
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
    expect(nextDueDoses(course, { ...query, limit: 3 })).toEqual([
      "2026-03-09T00:00:00-04:00", "2026-03-09T00:00:00-04:00", "2026-03-10T00:00:00-04:00"
    ]);
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
    const counted = { ...member, schedule: { ...member.schedule,
      recurrence: { ...member.schedule!.recurrence, count: 2 } } };
    expect(nextDueDoses(counted, { ...query, from: "2026-01-03T00:00:00Z", limit: 2 }))
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
      const capped: CanonicalAdministration = JSON.parse(JSON.stringify(member));
      capped.schedule!.recurrence!.occurrenceCap = { max: 1, period: 1, periodUnit: Unit.Day };
      expect(nextDueDoses(capped, { ...opts, limit: 2 })).toEqual([
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
      const lifetime = freshExecutionInput(member);
      lifetime.limits = [{ scope: "lifetime", amount: { value: 2, unit } }];
      expect(supply(lifetime, 3).totalUnits).toBe(2);
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
      const member = ranged();
      member.schedule!.recurrence = { frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00", "20:00:00"] };
      expect(nextDueDoses(member, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"
      ]);
      expect(supply(member, 1).totalUnits).toBe(3);
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
      const inclusive: CanonicalAdministration = JSON.parse(JSON.stringify(member));
      inclusive.amounts![0].range!.high!.comparator = "<=";
      expect(supply(inclusive, 1).totalUnits).toBe(2);
      const periodLimited: CanonicalAdministration = JSON.parse(JSON.stringify(member));
      periodLimited.limits![0].amount!.value = 1.5;
      expect(supply(periodLimited, 1).totalUnits).toBe(1.5);
      const administrationLimited: CanonicalAdministration = JSON.parse(JSON.stringify(member));
      administrationLimited.limits = [{ scope: "administration", amount: { value: 1.5, unit: "tab" } },
        { scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }];
      expect(supply(administrationLimited, 1).totalUnits).toBe(1.5);
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
      const bounded: CanonicalCourse = JSON.parse(JSON.stringify(course));
      const boundedMember = bounded.stages[0].administrations[0];
      boundedMember.amounts![0].range!.low!.value = 1;
      boundedMember.amounts![0].range!.high!.comparator = "<";
      expect(supply(bounded, 2).totalUnits).toBe(3);
      expect(nextDueDoses(bounded, { ...options, limit: 2 })).toEqual([]);
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
      expect(exact.stages[0].components[0].clause.schedule).toMatchObject({
        duration: 1, durationUnit: "d", durationMax: 1, durationMaxUnit: "d"
      });
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
      const members = course.stages.reduce<CanonicalAdministration[]>((all, stage) => all.concat(stage.administrations), []);
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
    const incomplete: CanonicalCourse = JSON.parse(JSON.stringify(course));
    incomplete.stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationMax = undefined;
    expect(() => supply(incomplete, 2)).toThrow(/infusion duration/i);
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
    const withoutStageStart = { ...course, stages: [{ ...course.stages[0], start: undefined }] };
    expect(nextDueDoses(withoutStageStart, { ...options, limit: 1 })).toEqual(["2026-01-01T09:00:00+00:00"]);
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
    const scheduled: CanonicalCourse = { ...course, stages: [{ ...course.stages[0],
      administrations: [{ ...member, asNeeded: false }],
    }] };
    expect(nextDueDoses(scheduled, { ...options, ...late, limit: 3 })).toEqual([]);
    expect(supply(scheduled, 2, late).totalUnits).toBe(0);
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
    const terminal = projected.canonical.stages.reduce<CanonicalAdministration[]>((all, stage) => all.concat(stage.administrations), [])
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
    const capped = freshExecutionInput(member);
    capped.schedule!.recurrence!.occurrenceCap = { max: 1, period: 1, periodUnit: Unit.Day };
    expect(nextDueDoses(capped, { ...query, limit: 2 })).toEqual([
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
      const members = native.stages.reduce<CanonicalAdministration[]>((all, stage) => all.concat(stage.administrations), []);
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
    const dense = dose();
    dense.schedule!.recurrence = { frequency: 42, period: 21, periodUnit: Unit.Day };
    expect(nextDueDoses(dense, query)).toEqual([
      "2026-01-01T08:00:00.500+00:00", "2026-01-01T20:00:00.500+00:00",
      "2026-01-02T08:00:00.500+00:00", "2026-01-02T20:00:00.500+00:00",
    ]);
    expect(calculateTotalUnits({ ...query, dosage: dense, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
    // A fractional civil unit uses elapsed distribution. Twelve hours
    // divided by seven produces 6171428 ms and 12342857 ms offsets after flooring.
    const fractional = dose();
    fractional.schedule!.recurrence = { frequency: 7, period: 0.5, periodUnit: Unit.Day };
    expect(nextDueDoses(fractional, { ...query, limit: 3 })).toEqual([
      "2026-01-01T08:00:00.500+00:00", "2026-01-01T09:42:51.928+00:00",
      "2026-01-01T11:25:43.357+00:00",
    ]);
    const clocked = dose();
    clocked.schedule!.recurrence = { frequency: 2, period: 2, periodUnit: Unit.Day, clocks: ["08:00:00"] };
    expect(nextDueDoses(clocked, { ...query, limit: 2 })).toEqual([
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
    const incompatible: CanonicalCourse = { ...course, stages: [{ ...course.stages[0],
      administrations: [course.stages[0].administrations[0], infusion("mg", "mg")],
    }] };
    expect(() => supply(incompatible, 1)).toThrow(expect.objectContaining({ code: "incompatible-dose-units" }));
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
    const extendedCourse = freshExecutionInput(course);
    const extended = extendedCourse.stages[0].administrations[0];
    extended.schedule!.recurrence!.courseLength = { value: 2, unit: "d" };
    extended.limits![0].amount!.value = 3;
    expect(nextDueDoses(extendedCourse, { ...query, limit: 2, priorDoseTimes: ["2026-01-01T08:00:00Z"] }))
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
    const diagnostics = [
      /requires a treatment-start offset/,
      /range endpoints must resolve to the same treatment-start offset/,
      expect.objectContaining({ code: "phase-boundary-displacement-conflict" }),
    ];
    for (let index = 0; index < invalid.length; index++) {
      const value = course(); value.stages[1].start = invalid[index];
      const original = JSON.stringify(value);
      expect(() => nextDueDoses(value, { ...options, limit: 10 })).toThrow(diagnostics[index]);
      expect(() => supply(value, 10)).toThrow(diagnostics[index]);
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
    const conflictingCourse: CanonicalCourse = JSON.parse(JSON.stringify(course));
    conflictingCourse.stages[0].administrations[0].schedule!.recurrence!.period = 1;
    const conflicting = wire(conflictingCourse, version), source = JSON.stringify(conflicting);
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
      const variant: CanonicalCourse = JSON.parse(JSON.stringify(course));
      variant.stages[0].administrations[0].phaseOrigin = origin;
      const input = wire(variant, version), source = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual(["2026-01-03T06:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(JSON.stringify(input)).toBe(source);
    }
    const unshifted: CanonicalCourse = JSON.parse(JSON.stringify(course));
    unshifted.stages[0].administrations[0].phaseOrigin = undefined;
    expect(nextDueDoses(wire(unshifted, version), query)).toEqual(["2026-01-02T06:00:00+00:00"]);
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
    const scheduledCourse: CanonicalCourse = JSON.parse(JSON.stringify(course));
    scheduledCourse.stages[0].administrations[0].asNeeded = false;
    const scheduled = wire(scheduledCourse, version);
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
      const variant: CanonicalCourse = JSON.parse(JSON.stringify(course));
      variant.safety = location === "course" ? shared : undefined;
      variant.stages[0].safety = location === "stage" ? shared : undefined;
      const input = wire(variant, version), source = JSON.stringify(input);
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
      const variant = freshExecutionInput(course);
      variant.safety = shared ? { limits: [{ scope: "period", amount: { value: 2, unit: "tab" },
        period: { value: 24, unit: "h" } }] } : undefined;
      const input = wire(variant, version), source = JSON.stringify(input);
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
    const anchored = freshExecutionInput(course);
    anchored.stages[0].administrations[0].phaseStart!.anchor = "treatment-start";
    expect(nextDueDoses(wire(anchored, version), query)).toEqual(["2026-03-09T06:00:00-04:00"]);
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
    const clockCourse = freshExecutionInput(value);
    clockCourse.stages[0].administrations[0].schedule!.recurrence!.clocks = ["10:00:00"];
    expect(nextDueDoses(wire(clockCourse, version), { ...query, limit: 1 })).toEqual(["2026-01-01T10:00:00+00:00"]);
    const uncodedCourse = freshExecutionInput(value);
    uncodedCourse.stages[0].administrations[0].schedule!.code = undefined;
    expect(nextDueDoses(wire(uncodedCourse, version), { ...query, limit: 2 })).toEqual([
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
      const matchingCourse = freshExecutionInput(value);
      matchingCourse.stages[0].administrations[0].schedule!.recurrence = { frequency: 1, period, periodUnit };
      const matching = wire(matchingCourse, version);
      expect(nextDueDoses(matching, { ...options, limit: 3 })).toEqual([
        "2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00", "2026-01-01T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: matching, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(6);
    }
    const rangedCourse = freshExecutionInput(value);
    rangedCourse.stages[0].administrations[0].schedule!.recurrence = { frequency: 1, period: 2, periodMax: 4, periodUnit: Unit.Hour };
    const ranged = wire(rangedCourse, version), rangedSource = JSON.stringify(ranged);
    // Q4H is a concrete cadence inside the authored 2–4 hour range.
    // Maximum supply still uses the independent range ceiling.
    expect(nextDueDoses(ranged, { ...options, limit: 3 })).toEqual([
      "2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00", "2026-01-01T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: ranged, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(12);
    expect(JSON.stringify(ranged)).toBe(rangedSource);
    const uncodedCourse = freshExecutionInput(rangedCourse);
    delete uncodedCourse.stages[0].administrations[0].schedule!.code;
    const uncoded = wire(uncodedCourse, version), uncodedSource = JSON.stringify(uncoded);
    expect(nextDueDoses(uncoded, { ...options, limit: 3 })).toEqual([
      "2026-01-01T00:00:00+00:00", "2026-01-01T02:00:00+00:00", "2026-01-01T04:00:00+00:00",
    ]);
    expect(JSON.stringify(uncoded)).toBe(uncodedSource);
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
      const standardCourse = freshExecutionInput(value);
      standardCourse.stages[0].administrations[0].schedule!.code = { coding: [{ code: "BID", ...(system ? { system } : {}) }] };
      const standard = wire(standardCourse, version);
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
      const allInactive = freshExecutionInput(value);
      for (const member of allInactive.stages[0].administrations) member.schedule!.recurrence!.clocks = ["20:00:00"];
      expect(calculateTotalUnits({ ...options, dosage: wire(allInactive, version), durationValue: 12, durationUnit: Unit.Hour }))
        .toMatchObject({ totalUnits: 0, unit: reverse ? "mL" : "mg" });
      const allActive = freshExecutionInput(value);
      for (const member of allActive.stages[0].administrations) member.schedule!.recurrence!.clocks = ["09:00:00"];
      expect(() => calculateTotalUnits({ ...options, dosage: wire(allActive, version), durationValue: 12, durationUnit: Unit.Hour }))
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
      const source = structuredClone(parseSig(conditional ? "1 tab daily if SBP > 160" : "1 tab daily").fhirNext);
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
    const source = structuredClone(parseSig("1 tab daily if SBP > 160").fhirNext);
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
    const authored = freshExecutionInput(course);
    authored.stages[0].administrations[0].schedule!.recurrence!.clocks = ["01:30:00"];
    expect(nextDueDoses(wire(authored, version), { ...query, limit: 2 })).toEqual([
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
      const variant: CanonicalCourse = JSON.parse(JSON.stringify(course));
      const limited = variant.stages[0].administrations[0];
      limited.schedule!.recurrence!.calendarWindow = cutoff === "calendar" ? { end: "2026-04-13T00:00:00Z" } : undefined;
      limited.phaseEnd = cutoff === "phase" ? relative(2, "mo") : undefined;
      const input = wire(variant, version), original = JSON.stringify(input);
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
    const uncappedCourse = freshExecutionInput(course);
    uncappedCourse.stages[0].administrations[0].limits = undefined;
    const uncapped = wire(uncappedCourse, version);
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
    loading.schedule!.recurrence!.calendarWindow!.end = "2026-12-01T21:00:00Z";
    const earlier = wire(course, version), earlierBefore = JSON.stringify(earlier);
    expect(nextDueDoses(earlier, { ...query, limit: 3 })).toEqual([
      "2026-12-02T06:00:00+00:00", "2026-12-03T06:00:00+00:00", "2026-12-04T06:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: earlier, ...query, from: "2026-12-01T00:00:00Z",
      durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(4);
    expect(JSON.stringify(earlier)).toBe(earlierBefore);
  });

  it.each(versions)("intersects compatible spaced mass maxima without changing authored measurements (%s)", version => {
    for (const reverse of [false, true]) {
      const value = dose(500); value.amounts![0].quantity!.unit = "mg";
      value.limits = [{ scope: "lifetime", amount: { value: 1, unit: "g " } },
        { scope: "lifetime", amount: { value: 2000, unit: "mg" } }];
      if (reverse) value.limits.reverse();
      const authored = JSON.stringify(value);
      const authoredLimits = JSON.parse(JSON.stringify(value.limits)) as NonNullable<CanonicalAdministration["limits"]>;
      const input = wire(value, version), before = JSON.stringify(input);
      expect(JSON.stringify(value)).toBe(authored);
      const result = calculateTotalUnits({ dosage: input, ...options, durationValue: 7, durationUnit: Unit.Day });
      expect(result).toMatchObject({ totalUnits: 1000, unit: "mg" });
      expect(result.explanation).not.toContain("could not be applied");
      expect(JSON.stringify(input)).toBe(before);
      const projected = projectCanonicalCourse({ kind: "course", stages: [{ administrations: [value] }] });
      for (const exported of [projected.fhir, projected.fhirNext])
        expect(importCanonicalCourse(exported).stages[0].administrations[0].limits)
          .toEqual(expect.arrayContaining(authoredLimits.map(limit => expect.objectContaining(limit))));
      expect(JSON.stringify(value)).toBe(authored);
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
  const untimed = (): CanonicalAdministration => JSON.parse(JSON.stringify(
    parseSig("Take 1 tablet as needed at most once daily.").meta!.canonical!.course!.stages[0].administrations[0]));

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
    const member = structuredClone(parseSig("Instill 1-2 drops in each eye at 08:00 and 20:00")
      .meta!.canonical!.course!.stages[0].administrations[0]);
    member.limits = periodCap(3, 24, "drop");
    const input = wire(member, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(JSON.stringify(input)).toBe(before);
    // One target may admit both minimum amounts within the same cap.
    const singleTarget = { ...member, targetCount: 1 };
    expect(nextDueDoses(singleTarget, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
    // Metric quantities already describe the total and must not multiply by target count.
    const metric: CanonicalAdministration = { ...member, targetCount: 2,
      amounts: [{ range: { low: { value: 1, unit: "mg" }, high: { value: 2, unit: "mg" } } }],
      limits: periodCap(3, 24, "mg") };
    expect(nextDueDoses(metric, { ...options, limit: 2 })).toEqual([
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
    const capped = freshExecutionInput(input);
    capped.limits = [{ scope: "period", amount: { value: 10, unit: "mL" }, period: { value: 24, unit: "h" } }];
    expect(supply(capped, 1).totalUnits).toBe(10);
    const extended = freshExecutionInput(capped);
    extended.schedule!.recurrence!.occurrenceDuration = 2;
    extended.limits![0].amount.value = 30;
    expect(supply(extended, 1)).toMatchObject({ totalUnits: 20, unit: "mL" });
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
      "2026-02-28T07:30:00Z", "2026-03-30T08:00:00Z", "2026-03-30T09:00:00Z", "2026-03-31T07:00:00Z",
    ] };
    member.limits = [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 1, unit: "mo" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "a" },
      stages: [{ administrations: [member] }] };
    // Two independently authored March 30 events share this member's cap.
    // The February dose re-enters the month window on March 31 at 07:00
    // and blocks a fourth tablet.
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
      "2027-02-28T07:30:00Z", "2028-02-28T08:00:00Z", "2028-02-28T09:00:00Z", "2028-02-29T07:00:00Z",
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
    const oneUse = freshExecutionInput(course);
    oneUse.stages[0].administrations[0].schedule!.recurrence!.countMax = 1;
    expect(supply(oneUse, 1).totalUnits).toBe(2);
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


describe("round44 supported temporal precision", () => {
  const contextCode = { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] };
  const at = (value: number, unit: string) => ({ contextCode, offsetDuration: { value, unit } });
  const between = (low: number, lowUnit: string, high: number, highUnit: string) => ({
    contextCode, offsetRange: { low: { value: low, unit: lowUnit }, high: { value: high, unit: highUnit } }
  });
  const forms = (raw: FhirR6DosageInstruction) => [
    raw, importCanonicalCourse(raw), JSON.parse(JSON.stringify(toFhirR5Dosages(raw))) as FhirDosage[]
  ];

  it.each([
    ["scalar civil", at(0, "d"), at(1, "d"), [8, 9, 10]],
    ["range start", between(0, "d", 0, "d"), at(1, "d"), [8, 9, 10]],
    ["range end", at(0, "d"), between(1, "d", 1, "d"), [8, 9, 10]],
    ["both ranges", between(0, "d", 0, "wk"), between(1, "d", 1, "d"), [8, 9, 10]],
    ["equivalent week endpoints", at(0, "d"), between(1, "wk", 7, "d"), Array.from({ length: 21 }, (_, i) => i + 8)],
    ["scalar elapsed", at(0, "h"), at(23, "h"), [8, 9]],
    ["range elapsed", between(0, "h", 0, "h"), between(23, "h", 23, "h"), [8, 9]]
  ] as const)("keeps local repetition on the authored span: %s", (_name, start, end, days) => {
    const raw: FhirR6DosageInstruction = { step: [{ count: 3, start, end, component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:30:00"] } }
    }] }] };
    const query = { orderedAt: "2026-03-07T09:00:00-05:00", from: "2026-03-07T09:00:00-05:00",
      timeZone: "America/New_York", limit: 24 };
    // A civil day keeps its 09:00 boundary after the 23-hour spring day.
    // Three genuinely 23-hour windows end before the March10 dose instead.
    for (const dosage of forms(raw)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(days.map(day =>
        "2026-03-" + String(day).padStart(2, "0") + "T08:30:00-04:00"));
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 22, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: days.length, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(courseToR6(courseFromR6(raw)).step![0]).toMatchObject({ start, end });
  });

  it.each(["unknown", "known empty", "known active"])("distinguishes ranged supply with %s timing", state => {
    const row: FhirDosage = {
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
      timing: { repeat: state === "unknown" ? {} : {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"]
      } },
      maxDosePerPeriod: [{ numerator: { value: 3, unit: "tab" }, denominator: { value: 24, unit: "h" } }]
    };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: row.doseAndRate, timing: row.timing,
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }] }
    }] }] };
    const query = { ...options, ...(state === "known empty" ? { from: "2026-01-01T09:00:00Z" } : {}),
      durationValue: state === "known empty" ? 1 : 24, durationUnit: Unit.Hour };
    for (const dosage of [row, ...forms(raw)]) {
      const before = JSON.stringify(dosage);
      if (state === "unknown")
        expect(() => calculateTotalUnits({ dosage, ...query })).toThrow(expect.objectContaining({ code: "timing-required" }));
      else expect(calculateTotalUnits({ dosage, ...query }).totalUnits).toBe(state === "known empty" ? 0 : 2);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([
    ["mixed", ["2026", "2026-11", "2026-11-20T08:00:00Z"], "2026-11-01T00:00:00Z", ["2026-11-20T08:00:00+00:00"], 1, undefined],
    ["mixed late", ["2026", "2026-11", "2026-11-20T08:00:00Z"], "2026-11-10T00:00:00Z", ["2026-11-20T08:00:00+00:00"], 1, undefined],
    ["known past", ["2026-11", "2026-11-20T08:00:00Z"], "2026-11-21T00:00:00Z", [], 0, undefined],
    ["complete only", ["2026-11-20T08:00:00Z"], "2026-11-01T00:00:00Z", ["2026-11-20T08:00:00+00:00"], 1, undefined],
    ["partial only", ["2026", "2026-11"], "2026-11-01T00:00:00Z", [], undefined, undefined],
    ["partial exhausted", ["2026", "2026-11"], "2026-11-01T00:00:00Z", [], 0, 1]
  ] as const)("retains partial event precision without spending an exact count: %s", (_name, event, from, expected, total, priorCount) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { event: [...event], repeat: { count: 1 } }
    }] }] };
    const query = { from, orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 3,
      ...(priorCount === undefined ? {} : { priorCount }) };
    for (const dosage of forms(raw)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(expected);
      const calculate = () => calculateTotalUnits({ dosage, ...query, durationValue: 30, durationUnit: Unit.Day });
      if (total === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
      else expect(calculate().totalUnits).toBe(total);
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(courseToR6(courseFromR6(raw)).step![0].component[0].timing?.event).toEqual(event);
    const persisted = JSON.parse(JSON.stringify(toFhirR5Dosages(raw))) as FhirDosage[];
    expect(toDosageDetails(persisted).step![0].component[0].timing?.event).toEqual(event);
  });
});


describe("round45 finite history and ranged occurrence bounds", () => {
  const oncePerDay = { url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
    { url: "max", valueInteger: 1 },
    { url: "period", valueQuantity: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }
  ] };
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };
  const rangedDose = { doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } };
  const periodCap = (maximum: number) => [{ numerator: { value: maximum, unit: "tab" }, denominator: { value: 24, unit: "h" } }];

  it.each([
    ["daily allowance", true, origin, undefined, 56],
    ["both clocks", false, origin, undefined, 112],
    ["partial first and last days", true, "2026-01-01T12:00:00Z", undefined, 58],
    ["recorded first-day allowance", true, "2026-01-01T12:00:00Z", "2026-01-01T08:00:00Z", 56]
  ] as const)("proves an attainable ranged maximum from %s", (_name, occurrence, from, record, expected) => {
    const row: FhirDosage = { asNeeded: true, doseAndRate: [rangedDose],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00", "20:00:00"],
        ...(occurrence ? { extension: [oncePerDay] } : {}) } }, maxDosePerPeriod: periodCap(4) };
    // Two tablets at the first free clock of each civil bucket attain this
    // bound. A noon-to-noon horizon touches 29 buckets; its actual first-day
    // dose spends that day's allowance, leaving 28 buckets for new supply.
    for (const dosage of forms(row)) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...options, from, durationValue: 28, durationUnit: Unit.Day,
        ...(record ? { priorDoseTimes: [record] } : {}) })).toMatchObject({ totalUnits: expected, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([["2026-01-02T00:00:00Z", 4], ["2026-01-10T00:00:00Z", 0]] as const)(
    "bounds future ranged supply by the finite allowance remaining at %s", (from, expected) => {
    const row: FhirDosage = { doseAndRate: [rangedDose], timing: { repeat: { count: 3, frequency: 1,
      period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"], extension: [oncePerDay] } }, maxDosePerPeriod: periodCap(4) };
    for (const dosage of forms(row)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, from, limit: 5 })).toEqual(expected ? [
        "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00"
      ] : []);
      expect(calculateTotalUnits({ dosage, ...options, from, durationValue: 28, durationUnit: Unit.Day }).totalUnits).toBe(expected);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  describe.each([false, true])("actual finite-count ownership with ranged dose %s", ranged => {
    it.each(["shifted", "on-time", "none", "pre-order", "late-tight"])("retains eligible remaining doses with %s history", history => {
      const row: FhirDosage = { doseAndRate: [ranged ? rangedDose : { doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { count: 3, frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"] } },
        maxDosePerPeriod: periodCap((ranged ? 2 : 1) * (history === "late-tight" ? 1 : 2)) };
      const priorDoseTimes = history === "none" ? undefined : [history === "pre-order" ? "2025-12-31T09:00:00Z"
        : history === "on-time" ? "2026-01-01T08:00:00Z" : history === "late-tight" ? "2026-01-01T23:00:00Z"
          : "2026-01-01T09:00:00Z"];
      const query = { ...options, from: "2026-01-02T00:00:00Z", priorDoseTimes, limit: 5 };
      // One eligible recorded dose leaves two. Its actual 23:00 timestamp
      // blocks the next 08:00 under a one-dose rolling ceiling, but consumes
      // no extra lifetime slot. With no eligible record, replay January 1.
      const days = history === "late-tight" ? [3, 4] : [2, 3];
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(days.map(day => `2026-01-0${day}T08:00:00+00:00`));
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(ranged ? 4 : 2);
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });
  });
});


describe("round46 supported execution boundaries", () => {
  const ucum = "http://unitsofmeasure.org";
  const annotated = {
    id: "round46-administration",
    extension: [{ url: "urn:test:round46:source", valueString: "retained" }],
  };
  const amount = (value = 1) => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });
  const r5Forms = (rows: FhirDosage | FhirDosage[]) => {
    const r6 = toDosageDetails(Array.isArray(rows) ? rows : [rows]);
    return [rows, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };
  const r6Forms = (raw: FhirR6DosageInstruction) => {
    const rows = toFhirR5Dosages(raw);
    return [raw, rows, JSON.parse(JSON.stringify(rows)) as FhirDosage[]];
  };

  it.each(["immediate", "ordinary clock", "later authored start"] as const)(
    "keeps the established successor boundary for %s", variant => {
      const loading: FhirDosage = { ...amount(), sequence: 1, timing: { repeat: {
        count: 1, frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"]
      } } };
      const successor: FhirDosage = { ...annotated, ...amount(2), sequence: 2, timing: { repeat:
        variant === "ordinary clock"
          ? { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"] }
          : { when: [EventTiming.Immediate], ...(variant === "later authored start"
            ? { boundsPeriod: { start: "2026-01-02T12:00:00Z" } } : {}) }
      } };
      const expected = variant === "immediate"
        ? ["2026-01-01T08:00:00+00:00", "2026-01-01T08:00:00+00:00"]
        : variant === "later authored start"
        ? ["2026-01-01T08:00:00+00:00", "2026-01-02T12:00:00+00:00"]
        : ["2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
          "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"];
      for (const dosage of r5Forms([loading, successor])) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, { ...options, limit: 4 })).toEqual(expected);
        expect(calculateTotalUnits({ dosage, ...options,
          durationValue: variant === "later authored start" ? 3 : 1, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: variant === "ordinary clock" ? 1 : 3, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each(["explicit one", "explicit zero", "nominal history", "actual history", "before eligibility", "alternate days"] as const)(
    "spends finite allowance once with %s", variant => {
      const alternate = variant === "alternate days";
      const raw: FhirR6DosageInstruction = { step: [{
        start: { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event",
          code: "treatment-start" }] }, offsetDuration: { value: 3, unit: "d", system: ucum, code: "d" } },
        component: [{ ...annotated, ...amount(), timing: { repeat: {
          countMax: 3, frequency: 1, period: alternate ? 2 : 1, periodUnit: Unit.Day,
          timeOfDay: ["09:00:00"], boundsPeriod: { start: origin }
        } } }]
      }] };
      const query = { ...options, limit: 8,
        from: alternate ? "2026-01-06T00:00:00Z"
          : variant === "before eligibility" ? "2026-01-02T00:00:00Z" : "2026-01-05T00:00:00Z",
        priorCount: variant === "explicit one" || alternate ? 1
          : variant === "explicit zero" || variant === "before eligibility" ? 0 : undefined,
        priorDoseTimes: variant === "actual history" ? ["2026-01-04T09:00:00Z"] : undefined,
      };
      const days = alternate ? [7, 9] : variant === "before eligibility" ? [4, 5, 6]
        : variant === "explicit zero" ? [5, 6, 7] : [5, 6];
      for (const dosage of r6Forms(raw)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query))
          .toEqual(days.map(day => "2026-01-0" + day + "T09:00:00+00:00"));
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 7, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: days.length, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each(["Q4H range", "Q4H exact", "BID range"] as const)(
    "retains the admitted coded cadence for %s", variant => {
      const daily = variant === "BID range";
      const ranged = variant !== "Q4H exact";
      const row: FhirDosage = { ...annotated, ...amount(), timing: {
        code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation",
          code: daily ? "BID" : "Q4H" }] },
        repeat: { frequency: daily ? 1 : ranged ? 4 : 6,
          ...(ranged ? { frequencyMax: daily ? 3 : 8 } : {}),
          period: 1, periodUnit: Unit.Day,
          boundsDuration: { value: 1, unit: "d", code: "d", system: ucum } }
      } };
      const query = { ...options, from: "2026-01-01T01:00:00Z",
        orderedAt: "2026-01-01T01:00:00Z", limit: 12 };
      const clocks = daily ? ["08:00:00", "20:00:00"]
        : ["01:00:00", "05:00:00", "09:00:00", "13:00:00", "17:00:00", "21:00:00"];
      for (const dosage of r5Forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(clocks.map(clock => "2026-01-01T" + clock + "+00:00"));
        // The explicit range still owns the existing maximum-supply endpoint.
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
          .toBe(daily ? 3 : ranged ? 8 : 6);
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each(["missing", "known", "local", "independent end", "qualified known"] as const)(
    "retains authored duration presence before dependent completion (%s)", variant => {
      const duration = variant === "known" || variant === "qualified known"
        ? { value: 2, unit: "hours", system: ucum, code: "h", id: "authored-duration",
          ...(variant === "qualified known" ? { comparator: ">=" as const } : {}) }
        : { value: 3, unit: "half-hour blocks", system: "urn:clinic:duration-units",
          code: "half-hour-block", id: "authored-duration" };
      const marker = { url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
        valueQuantity: duration };
      const raw: FhirR6DosageInstruction = { step: [{
        ...(variant === "independent end" ? { end: {
          contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event",
            code: "treatment-start" }] },
          offsetDuration: { value: 2, unit: "d", code: "d", system: ucum }
        } } : {}),
        component: [{ ...annotated, timing: { repeat: { count: 1, timeOfDay: ["23:30:00"],
          ...(variant === "missing" ? {} : { extension: [marker] }) } },
          doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }] }]
      }, {
        start: { contextCode: { coding: [{ system: "urn:ezmedicationinput:CodeSystem:course-phase-event",
          code: "previous-phase-next-day" }] } },
        component: [{ timing: { repeat: { frequency: 1, period: 1,
          periodUnit: Unit.Day, timeOfDay: ["08:00:00"] } },
          doseAndRate: [{ doseQuantity: { value: 20, unit: "mL" } }] }]
      }] };
      const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z",
        timeZone: "UTC", limit: 4 };
      const unresolved = variant === "local" || variant === "qualified known";
      const days = unresolved ? [] : variant === "missing" ? [2, 3, 4] : [3, 4, 5];
      for (const dosage of r6Forms(raw)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(["2026-12-01T23:30:00+00:00",
          ...days.map(day => "2026-12-0" + day + "T08:00:00+00:00")]);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 4, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: unresolved ? 100 : variant === "missing" ? 160 : 140, unit: "mL" });
        const projected = projectCanonicalCourse(importCanonicalCourse(dosage));
        if (variant === "local" || variant === "independent end") {
          for (const repeat of [projected.fhir[0].timing!.repeat!,
            projected.fhirNext.step![0].component[0].timing!.repeat!]) {
            expect(repeat.extension).toContainEqual(marker);
            expect(repeat.duration).toBeUndefined();
            expect(repeat.durationUnit).toBeUndefined();
          }
        }
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });
});


describe("round47 calendar quantity and month-day ownership", () => {
  const ucum = "http://unitsofmeasure.org";
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };

  it.each(["monthly delayed", "monthly undisplaced", "elapsed thirty days", "yearly delayed"] as const)(
    "admits the actual administration under %s limits", variant => {
      const yearly = variant === "yearly delayed", elapsed = variant === "elapsed thirty days";
      const delayed = variant !== "monthly undisplaced";
      const from = yearly ? "2025-03-01T00:00:00Z" : "2026-03-31T00:00:00Z";
      const orderedAt = yearly ? "2024-01-01T00:00:00Z" : "2026-01-01T00:00:00Z";
      const end = yearly ? "2025-03-01T02:00:00Z" : "2026-03-31T02:00:00Z";
      const row: FhirDosage = {
        id: "r47-delayed-dose",
        extension: [{ url: "urn:test:r47:authored", valueString: "retain" }],
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        ...(delayed ? { modifierExtension: [{
          url: "urn:ezmedicationinput:StructureDefinition:medication-administration-offset",
          valueQuantity: { value: 120, unit: "min", code: "min", system: ucum }
        }] } : {}),
        timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
          timeOfDay: [delayed ? "23:00:00" : "01:00:00"], boundsPeriod: { start: orderedAt, end } } },
        maxDosePerPeriod: [{ numerator: { value: 1, unit: "tab" }, denominator: {
          value: elapsed ? 30 : 1, unit: elapsed ? "d" : yearly ? "a" : "mo",
          code: elapsed ? "d" : yearly ? "a" : "mo", system: ucum
        } }]
      };
      const query = { from, orderedAt, timeZone: "UTC", limit: 2,
        priorDoseTimes: [yearly ? "2024-03-01T00:30:00Z" : "2026-03-01T00:30:00Z"] };
      // At March31 01:00 the monthly cutoff is February28 01:00,
      // so March1 00:30 still consumes the allowance. The 30-day cutoff
      // is March1 01:00 instead. Across the leap year, the actual yearly
      // cutoff is March1 01:00; shifting to February28 changes that date.
      const accepted = elapsed || yearly;
      const expected = accepted ? [yearly ? "2025-03-01T01:00:00+00:00" : "2026-03-31T01:00:00+00:00"] : [];
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(expected);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Hour }))
          .toMatchObject({ totalUnits: accepted ? 1 : 0, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each(["fifteenth", "every two months", "aligned fifteenth", "order-day clamp"] as const)(
    "uses the prescribed date within eligible months (%s)", variant => {
      const explicit = variant !== "order-day clamp";
      const period = variant === "every two months" ? 2 : 1;
      const from = variant === "aligned fifteenth" ? "2026-01-15T00:00:00Z"
        : explicit ? "2026-01-01T00:00:00Z" : "2026-01-31T00:00:00Z";
      const row: FhirDosage = { id: "r47-month-day",
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period, periodUnit: Unit.Month,
          timeOfDay: ["09:00:00"], ...(explicit ? { extension: [{
            url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt: 15
          }] } : {}) } }
      };
      const dates = variant === "every two months"
        ? ["2026-01-15", "2026-03-15", "2026-05-15"]
        : explicit ? ["2026-01-15", "2026-02-15", "2026-03-15"]
        : ["2026-01-31", "2026-02-28", "2026-03-31"];
      const query = { from, orderedAt: from, timeZone: "UTC", limit: 3 };
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(dates.map(date => date + "T09:00:00+00:00"));
        expect(calculateTotalUnits({ dosage, ...query,
          durationValue: period === 2 ? 5 : 3, durationUnit: Unit.Month }))
          .toMatchObject({ totalUnits: 3, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });
});


describe("round48 inferred slots and unresolved events", () => {
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };
  const quantity = { doseQuantity: { value: 1, unit: "tab" } };

  it.each([
    [1.5, Unit.Day, 36, "2026-01-03T06:00:00Z", [
      "2026-01-01T00:00:00", "2026-01-01T18:00:00", "2026-01-02T12:00:00",
      "2026-01-03T06:00:00", "2026-01-04T00:00:00", "2026-01-04T18:00:00"
    ]],
    [0.5, Unit.Week, 84, "2026-01-06T06:00:00Z", [
      "2026-01-01T00:00:00", "2026-01-02T18:00:00", "2026-01-04T12:00:00",
      "2026-01-06T06:00:00", "2026-01-08T00:00:00", "2026-01-09T18:00:00"
    ]]
  ] as const)("distributes two doses in %s %s using elapsed slots", (period, periodUnit, hours, from, dates) => {
    for (const repeat of [{ frequency: 2, period, periodUnit },
      { frequency: 2, period: hours, periodUnit: Unit.Hour }]) {
      const row: FhirDosage = { doseAndRate: [quantity], timing: { repeat } };
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, { ...options, limit: 6 }))
          .toEqual(dates.map(date => date + "+00:00"));
        expect(calculateTotalUnits({ dosage, ...options, from,
          durationValue: 1, durationUnit: Unit.Hour })).toMatchObject({ totalUnits: 1, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    }
  });

  it.each(["coded", "explicit interval"] as const)(
    "seeks %s history without spending the final occurrence", variant => {
      const row: FhirDosage = { doseAndRate: [quantity], timing: {
        ...(variant === "coded" ? { code: { coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "Q4H"
        }] } } : {}),
        repeat: { frequency: variant === "coded" ? 6 : 1,
          period: variant === "coded" ? 1 : 4,
          periodUnit: variant === "coded" ? Unit.Day : Unit.Hour, count: 1080 }
      } };
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        for (const [from, expected] of [
          ["2026-06-30T00:00:00Z", "2026-06-30T00:00:00+00:00"],
          ["2026-06-30T02:00:00Z", "2026-06-30T04:00:00+00:00"]
        ]) {
          const query = { ...options, from, priorCount: 1079, limit: 2 };
          expect(nextDueDoses(dosage, query)).toEqual([expected]);
          expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
            .toMatchObject({ totalUnits: 1, unit: "tab" });
          expect(nextDueDoses(dosage, { ...query, priorCount: 1080 })).toEqual([]);
          expect(calculateTotalUnits({ dosage, ...query, priorCount: 1080,
            durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
        }
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each([
    ["history remaining", 2, undefined, false, undefined],
    ["explicit remaining", 2, 1, false, undefined],
    ["history exhausted", 1, undefined, false, 0],
    ["explicit exhausted", 2, 2, false, 0],
    ["known future", 2, undefined, true, 1],
    ["uncapped remaining", undefined, undefined, false, undefined]
  ] as const)("keeps partial events unresolved after exact filtering (%s)", (_name, count, priorCount, future, total) => {
    const event = ["2026-11", "2026-11-20T08:00:00Z",
      ...(future ? ["2026-11-22T08:00:00Z"] : [])];
    const row: FhirDosage = { id: "round48-partial-event", doseAndRate: [quantity],
      timing: { event, ...(count === undefined ? {} : { repeat: { count } }) } };
    const query = { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z",
      timeZone: "UTC", limit: 3, ...(priorCount === undefined ? {} : { priorCount }) };
    for (const dosage of forms(row)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(future ? ["2026-11-22T08:00:00+00:00"] : []);
      const calculate = () => calculateTotalUnits({ dosage, ...query,
        durationValue: 2, durationUnit: Unit.Day });
      if (total === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
      else expect(calculate()).toMatchObject({ totalUnits: total, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(toDosageDetails([row]).step![0].component[0].timing?.event).toEqual(event);
  });
});

describe("round49 partial-event supply windows and external inputs", () => {
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };

  it.each([
    ["past month", "2026-11", "2026-12-01T00:00:00Z", 2, Unit.Day, "UTC", 0],
    ["overlapping month", "2026-11", "2026-11-21T00:00:00Z", 2, Unit.Day, "UTC", undefined],
    ["future month", "2026-12", "2026-11-21T00:00:00Z", 2, Unit.Day, "UTC", 0],
    ["past year", "2026", "2027-01-01T00:00:00Z", 2, Unit.Day, "UTC", 0],
    ["overlapping year", "2026", "2026-12-01T00:00:00Z", 2, Unit.Day, "UTC", undefined],
    ["future year", "2027", "2026-12-01T00:00:00Z", 2, Unit.Day, "UTC", 0],
    ["exclusive month boundary", "2026-12", "2026-11-30T00:00:00Z", 1, Unit.Day, "UTC", 0],
    ["crossed month boundary", "2026-12", "2026-11-30T12:00:00Z", 1, Unit.Day, "UTC", undefined],
    ["past local month", "2026-11", "2026-11-30T17:00:00Z", 2, Unit.Day, "Asia/Bangkok", 0],
    ["overlapping local month", "2026-11", "2026-11-30T16:00:00Z", 1, Unit.Hour, "Asia/Bangkok", undefined],
    ["order at month end", "2026-11", "2026-11-30T00:00:00Z", 2, Unit.Day, "UTC", 0, "2026-12-01T00:00:00Z"],
    ["order inside month", "2026-11", "2026-11-30T00:00:00Z", 2, Unit.Day, "UTC", undefined, "2026-11-30T12:00:00Z"],
    ["order after query", "2026-11", "2026-11-30T00:00:00Z", 2, Unit.Day, "UTC", 0, "2026-12-03T00:00:00Z"]
  ] as const)("distinguishes a disjoint %s from unknown administration time",
    (_name, partial, from, durationValue, durationUnit, timeZone, total, orderedAt?: string) => {
      const event = [partial, "2026-11-20T08:00:00Z"];
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { event } };
      const query = { from, orderedAt: orderedAt ?? origin, timeZone,
        durationValue, durationUnit, limit: 3 };
      for (const dosage of forms(row)) {
        const saved = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual([]);
        const calculate = () => calculateTotalUnits({ dosage, ...query });
        if (total === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
        else expect(calculate()).toMatchObject({ totalUnits: total, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(saved);
      }
      expect(toDosageDetails([row]).step![0].component[0].timing?.event).toEqual(event);
    });

  it("imports current external R6 edits while retaining the original parsed batch", () => {
    const batch = parseSig("Take 1 tablet daily at 08:00");
    const original = JSON.stringify(batch);
    const query = { from: "2026-11-23T00:00:00Z", orderedAt: "2026-11-23T00:00:00Z",
      timeZone: "UTC", limit: 1, durationValue: 1, durationUnit: Unit.Day };
    for (const [clock, quantity] of [["10:00:00", 2], ["11:00:00", 3]] as const) {
      const external = JSON.parse(JSON.stringify(batch.fhirNext)) as FhirR6DosageInstruction;
      const component = external.step![0].component[0];
      component.timing!.repeat!.timeOfDay = [clock];
      component.doseAndRate![0].doseQuantity!.value = quantity;
      const saved = JSON.stringify(external);
      for (const dosage of [external, fromFhir(external)]) {
        expect(nextDueDoses(dosage, query)).toEqual(["2026-11-23T" + clock + "+00:00"]);
        expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: quantity, unit: "tab" });
      }
      expect(JSON.stringify(external)).toBe(saved);
    }
    expect(nextDueDoses(batch, query)).toEqual(["2026-11-23T08:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: batch, ...query })).toMatchObject({ totalUnits: 1, unit: "tab" });
    expect(JSON.stringify(batch)).toBe(original);
  });
});


describe("round53 supported execution and grammar regressions", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const forms = (course: CanonicalCourse) => [course, persist(courseToR5(course)), persist(courseToR6(course))];

  it.each([
    [2, Unit.Day, ["2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-05T08:00:00+00:00"], 3, 2],
    [1, Unit.Week, ["2026-01-01T08:00:00+00:00", "2026-01-08T08:00:00+00:00", "2026-01-15T08:00:00+00:00"], 14, 2],
  ] as const)("opens clock windows only on eligible calendar dates (%s %s)", (period, periodUnit, expected, days, units) => {
    const parsed = parseSig(`Take 1 tablet every ${period} ${periodUnit === Unit.Week ? "week" : "days"} between 08:00 and 10:00`);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual(expected);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: days, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: units, unit: "tab" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("restarts a subday interval in each daily clock window", () => {
    const parsed = parseSig("Take 1 tablet every 2 hours between 08:00 and 10:00");
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00",
        "2026-01-02T08:00:00+00:00", "2026-01-02T10:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
    }
  });

  it.each([
    [120, 82, 5, "2026-01-04T10:00:00Z", "2026-01-04T11:00:00+00:00", "2026-01-05T11:00:00+00:00", false],
    [-120, 80, 6, "2026-01-04T08:00:00Z", "2026-01-05T07:00:00+00:00", "2026-01-06T07:00:00+00:00", false],
    [120, 82, 5, "2026-01-04T10:00:00Z", "2026-01-04T11:00:00+00:00", "2026-01-05T11:00:00+00:00", true],
    [-120, 80, 6, "2026-01-04T08:00:00Z", "2026-01-05T07:00:00+00:00", "2026-01-06T07:00:00+00:00", true],
  ] as const)("counts eligible delayed doses on the same grid as scheduling (%s minutes, start %s, end %s, %s, %s, %s, cap %s)",
    (delayMinutes, startHours, endDays, from, first, second, civilCap) => {
      const member = dose();
      member.delayMinutes = delayMinutes;
      member.phaseStart = relative(0);
      member.schedule!.recurrence!.count = 2;
      if (civilCap) member.schedule!.recurrence!.occurrenceCap = { max: 1, period: 1, periodUnit: Unit.Day };
      const course: CanonicalCourse = { kind: "course", stages: [{ start: relative(startHours, "h"),
        end: relative(endDays), administrations: [member] }] };
      const query = { ...options, from, limit: 4 };
      for (const input of forms(course)) {
        const before = JSON.stringify(input);
        expect(nextDueDoses(input, query)).toEqual([first, second]);
        expect(calculateTotalUnits({ ...query, dosage: input, durationValue: endDays * 24 - startHours, durationUnit: Unit.Hour }))
          .toMatchObject({ totalUnits: 2, unit: "tab" });
        expect(JSON.stringify(input)).toBe(before);
      }
    });

  it.each([
    ["2026-12", EventTiming["Before Sleep"], { HS: "00:30" }, "2026-11-30T23:00:00Z", undefined],
    ["2026-11", EventTiming["After Dinner"], { CV: "23:30" }, "2026-12-01T00:00:00Z", undefined],
    ["2027", EventTiming["Before Sleep"], { HS: "00:30" }, "2026-12-31T23:00:00Z", undefined],
    ["2026-12", EventTiming["Before Sleep"], { HS: "00:30" }, "2026-11-29T23:00:00Z", 0],
    ["2026-11", EventTiming["After Dinner"], { CV: "23:30" }, "2026-12-02T00:00:00Z", 0],
  ] as const)("keeps shifted partial events unresolved only when their possible dates overlap (%s %s %j %s)",
    (event, when, eventClock, from, units) => {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { event: [event], repeat: { when: [when], offset: 60 } },
        extension: [{ url: "urn:round53:partial-source", valueString: "authored partial date" }] };
      const r6 = toDosageDetails([row]);
      const query = { ...options, from, eventClock, limit: 2, durationValue: 1, durationUnit: Unit.Hour };
      for (const input of [row, persist(r6), persist(toFhirR5Dosages(r6))]) {
        const before = JSON.stringify(input);
        expect(nextDueDoses(input, query)).toEqual([]);
        const calculate = () => calculateTotalUnits({ ...query, dosage: input });
        if (units === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
        else expect(calculate()).toMatchObject({ totalUnits: 0, unit: "tab" });
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(r6.step![0].component[0].timing?.event).toEqual([event]);
      expect(toFhirR5Dosages(r6)[0].extension).toContainEqual(row.extension![0]);
    });

  it.each([
    ["2026-12-01", EventTiming["Before Sleep"], { HS: "00:30" }, "2026-11-30T23:00:00Z", "2026-11-30T23:30:00+00:00"],
    ["2026-11-30", EventTiming["After Dinner"], { CV: "23:30" }, "2026-12-01T00:00:00Z", "2026-12-01T00:30:00+00:00"],
  ] as const)("retains exact shifted date occurrences (%s)", (event, when, eventClock, from, expected) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { event: [event], repeat: { when: [when], offset: 60 } } };
    const query = { ...options, from, eventClock, limit: 2, durationValue: 1, durationUnit: Unit.Hour };
    expect(nextDueDoses(row, query)).toEqual([expected]);
    expect(calculateTotalUnits({ ...query, dosage: row })).toMatchObject({ totalUnits: 1, unit: "tab" });
  });

  it("returns an empty schedule for an empty dosage list without a time zone", () => {
    expect(nextDueDoses([], { from: origin })).toEqual([]);
    expect(() => nextDueDoses({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day } } }, { from: origin })).toThrow(/timeZone/);
  });

  it.each([
    ["30", "60", false], ["30", "30", true],
    ["at least 30", "at least 60", false], ["at least 30", "at least 30", true],
    ["at most 30", "at most 60", false], ["at most 30", "at most 30", true],
  ] as const)("resolves same-time references only when predecessor offsets agree (%s and %s)", (left, right, shared) => {
    const source = `Take 1 tablet ${left} minutes before breakfast and 2 tablets ${right} minutes before breakfast for 2 days then take 3 tablets at the same time`;
    const parsed = parseSig(source);
    const clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(3);
    const schedule = clauses[2].schedule;
    expect(clauses[2].dose).toMatchObject({ value: 3, unit: "tab" });
    if (shared) {
      expect(schedule?.timingReference).toBeUndefined();
      expect(schedule?.when).toEqual([EventTiming["Before Breakfast"]]);
      const field = left.startsWith("at least") ? "offsetMin" : left.startsWith("at most") ? "offsetMax" : "offset";
      expect(schedule?.[field]).toBe(30);
      expect(parsed.fhir[2].additionalInstruction).toBeUndefined();
      expect(parsed.fhirNext.step![1].component[0].additionalInstruction).toBeUndefined();
    } else {
      expect(schedule?.timingReference).toBe("previous");
      expect(schedule?.when).toBeUndefined();
      expect(schedule?.timeOfDay).toBeUndefined();
      expect(schedule?.offset).toBeUndefined();
      expect(schedule?.offsetMin).toBeUndefined();
      expect(schedule?.offsetMax).toBeUndefined();
      expect(clauses[2].additionalInstructions?.some(item => item.text === "at the same time")).toBe(true);
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });

  it("keeps a successor waking interval independent of the predecessor clock", () => {
    const source = "Take 1 tablet daily at 09:00 for 2 days then take 2 tablets every 4 hours while awake";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({
      period: 4, periodUnit: Unit.Hour, eventWindow: { start: "WAKE", end: "HS" } });
    expect(parsed.meta.canonical.clauses[1].schedule?.timeOfDay).toBeUndefined();
    const query = { ...options, from: "2026-01-03T00:00:00Z", eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 3 };
    for (const input of [parsed, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-03T08:00:00+00:00", "2026-01-03T12:00:00+00:00", "2026-01-03T16:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 6, unit: "tab" });
    }
  });

  it.each(["16:00", "09:00"])("qualifies an authored morning clock without adding an administration (%s second clock)", second => {
    const source = `Take 1 tablet every morning at 08:00 and ${second}`;
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toEqual(["08:00:00", second + ":00"]);
    const query = { ...options, eventClock: { MORN: "07:00" }, limit: 4 };
    for (const input of [parsed, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T08:00:00+00:00", `2026-01-01T${second}:00+00:00`,
        "2026-01-02T08:00:00+00:00", `2026-01-02T${second}:00+00:00`,
      ]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhir[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00", second + ":00"]);
    expect(parsed.fhirNext.step![0].component[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00", second + ":00"]);
  });

  it.each(["8am", "8 AM", "8pm", "8 PM"])("already preserves a qualified successor dose before a compact or spaced clock (%s)", clock => {
    const parsed = parseSig(`Take 1 tablet daily for 2 days then about 2 at ${clock}`);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab", comparator: "~" });
    const expectedClock = clock.toLowerCase().includes("pm") ? "20:00:00" : "08:00:00";
    for (const row of [parsed.fhir[1], parsed.fhirNext.step![1].component[0], toFhirR5Dosages(parsed.fhirNext)[1]]) {
      expect(row.timing?.repeat?.timeOfDay).toEqual([expectedClock]);
      expect(row.doseAndRate![0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
      expect(row.doseAndRate![0].doseQuantity?.extension).toContainEqual({
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008", code: "100000000055" },
      });
    }
  });
});

describe("round 54 supported execution boundaries", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const start = "2026-11-02T00:00:00Z";
  const query = { from: start, orderedAt: start, timeZone: "UTC", limit: 6 };
  const wireForms = (rows: FhirDosage[]) => {
    const r6 = toDosageDetails(persist(rows));
    return [persist(rows), persist(r6), persist(toFhirR5Dosages(r6))];
  };
  const quantity = () => [{ doseQuantity: { value: 1, unit: "tab" } }];
  const lead = (minutes: number) => [{
    url: "urn:ezmedicationinput:StructureDefinition:medication-administration-offset",
    valueQuantity: { value: minutes, unit: "min", code: "min", system: "http://unitsofmeasure.org" },
  }];

  it.each([-120, 0, 120])("compares partial month events in nominal time for a %s minute displacement", minutes => {
    const row: FhirDosage = {
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
      timing: { event: ["2026-11"] }, modifierExtension: lead(minutes),
      maxDosePerPeriod: [{ numerator: { value: 3, unit: "tab" },
        denominator: { value: 1, unit: "mo", code: "mo", system: "http://unitsofmeasure.org" } }],
      extension: [{ url: "urn:round54:partial-month-source", valueString: "retain unknown source" }],
    };
    for (const input of wireForms([row])) {
      const before = JSON.stringify(input);
      const local = { ...query, from: "2026-11-30T22:30:00Z" };
      expect(nextDueDoses(input, local)).toEqual([]);
      const calculate = () => calculateTotalUnits({ ...local, dosage: input, durationValue: 1, durationUnit: Unit.Hour });
      if (minutes === -120) expect(calculate()).toMatchObject({ totalUnits: 0, unit: "tab" });
      else expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([false, true])("filters inferred elapsed slots before spending count (%s weekdays)", filtered => {
    const row: FhirDosage = { doseAndRate: quantity(), timing: { repeat: {
      frequency: 2, period: 24, periodUnit: Unit.Hour,
      ...(filtered ? { dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Thursday] } : {}),
    } } };
    for (const input of wireForms([row])) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...query, limit: 4 })).toEqual(filtered ? [
        "2026-11-02T00:00:00+00:00", "2026-11-02T12:00:00+00:00",
        "2026-11-05T00:00:00+00:00", "2026-11-05T12:00:00+00:00",
      ] : [
        "2026-11-02T00:00:00+00:00", "2026-11-02T12:00:00+00:00",
        "2026-11-03T00:00:00+00:00", "2026-11-03T12:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 4, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: filtered ? 4 : 8, unit: "tab" });
      expect(calculateTotalUnits({ ...query, from: "2026-11-03T00:00:00Z", dosage: input,
        durationValue: 1, durationUnit: Unit.Day })).toMatchObject({ totalUnits: filtered ? 0 : 2, unit: "tab" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("does not spend a counted weekday allowance on excluded inferred slots", () => {
    const row: FhirDosage = { doseAndRate: quantity(), timing: { repeat: {
      count: 4, frequency: 2, period: 24, periodUnit: Unit.Hour,
      dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Thursday],
    } } };
    for (const input of wireForms([row])) {
      const local = { ...query, from: "2026-11-05T00:00:00Z" };
      expect(nextDueDoses(input, local)).toEqual(["2026-11-05T00:00:00+00:00", "2026-11-05T12:00:00+00:00"]);
      expect(calculateTotalUnits({ ...local, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 2, unit: "tab" });
    }
  });

  it.each([-120, 0, 120])("keeps an inferred maximum supply slot inside its actual query (%s minute displacement)", minutes => {
    const row: FhirDosage = { doseAndRate: quantity(), modifierExtension: lead(minutes),
      timing: { repeat: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["09:00:00"], extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
          { url: "max", valueInteger: 2 }, { url: "period", valueQuantity: { value: 1, unit: "d",
            code: "d", system: "http://unitsofmeasure.org" } },
        ] }] } } };
    const from = minutes === -120 ? "2026-11-02T17:30:00Z" : minutes === 0
      ? "2026-11-02T19:30:00Z" : "2026-11-02T21:30:00Z";
    for (const input of wireForms([row])) {
      const before = JSON.stringify(input);
      expect(calculateTotalUnits({ ...query, from, dosage: input, durationValue: 1, durationUnit: Unit.Hour }))
        .toMatchObject({ totalUnits: 1, unit: "tab", quantityKind: "maximum" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["clock", "event", "none"] as const)("retains the first successor opportunity for a %s window", kind => {
    const extension = kind === "clock" ? [{
      url: "urn:ezmedicationinput:StructureDefinition:medication-timing-clock-window",
      extension: [{ url: "start", valueTime: "08:00:00" }, { url: "end", valueTime: "20:00:00" },
        { url: "endInclusive", valueBoolean: false }],
    }] : kind === "event" ? [{
      url: "urn:ezmedicationinput:StructureDefinition:medication-timing-event-window",
      extension: [{ url: "start", valueCode: "WAKE" }, { url: "end", valueCode: "HS" }],
    }] : undefined;
    const rows: FhirDosage[] = [
      { sequence: 1, doseAndRate: quantity(), timing: { repeat: { count: 1, timeOfDay: ["07:00:00"] } } },
      { sequence: 2, doseAndRate: quantity(), timing: { repeat: { period: 4, periodUnit: Unit.Hour, extension } } },
    ];
    for (const input of wireForms(rows)) {
      const before = JSON.stringify(input);
      const local = { ...query, eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 4 };
      expect(nextDueDoses(input, local)).toEqual(kind === "none" ? [
        "2026-11-02T07:00:00+00:00", "2026-11-02T11:00:00+00:00",
        "2026-11-02T15:00:00+00:00", "2026-11-02T19:00:00+00:00",
      ] : [
        "2026-11-02T07:00:00+00:00", "2026-11-02T08:00:00+00:00",
        "2026-11-02T12:00:00+00:00", "2026-11-02T16:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...local, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: kind === "none" ? 5 : 4, unit: "tab" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["as needed for pain", "", "once as needed for pain"])("does not invent a PRN predecessor count before NEXT (%s)", modifier => {
    const source = `Take 1 tablet at 22:00 ${modifier}, then 2 tablets the next morning`;
    const parsed = parseSig(source);
    const explicit = modifier.startsWith("once"), prn = modifier.includes("needed");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(prn && !explicit ? undefined : 1);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.meta.canonical.clauses[1].schedule?.when).toEqual([EventTiming.Morning]);
    if (prn && !explicit) {
      expect(parsed.meta.canonical.clauses[0].evidence.some(e => e.rule === "hpsg.regimen.single-clock-before-next-day")).toBe(false);
      expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).not.toBe("previous-phase-next-day");
    }
    for (const input of [parsed, ...wireForms(parsed.fhir)]) {
      const before = JSON.stringify(input);
      if (!prn || explicit) expect(nextDueDoses(input, query)).toEqual([
        "2026-11-02T22:00:00+00:00", "2026-11-03T08:00:00+00:00",
      ]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["at most once", "once"])("keeps an authored count ceiling separate from exact completion (%s)", count => {
    const source = `1 drop OD daily ${count} then 2 drops OD daily; 1 drop OS daily`;
    const parsed = parseSig(source);
    const maximum = count === "at most once";
    const schedule = parsed.meta.canonical.clauses[0].schedule!;
    expect(schedule.count).toBe(maximum ? undefined : 1);
    expect(schedule.countMax).toBe(maximum ? 1 : undefined);
    const successor = parsed.meta.canonical.course!.stages[0].administrations.find(a => a.sourceMember === 1)!;
    if (maximum) {
      expect(successor.phasePredecessors).toBeUndefined();
      expect(successor.phaseStart).toEqual({ anchor: "unresolved" });
    } else expect(successor.phasePredecessors).toEqual([0]);
    for (const rows of [parsed.fhir, toFhirR5Dosages(persist(parsed.fhirNext))]) {
      expect(rows[0].timing?.repeat?.count).toBe(maximum ? undefined : 1);
      expect(rows[0].timing?.repeat?.countMax).toBe(maximum ? 1 : undefined);
    }
  });

  it("retains explicit equal FHIR count endpoints as definite completion", () => {
    const rows: FhirDosage[] = [
      { sequence: 1, doseAndRate: quantity(), timing: { repeat: { count: 1, countMax: 1, timeOfDay: ["07:00:00"] } } },
      { sequence: 2, doseAndRate: quantity(), timing: { repeat: { period: 4, periodUnit: Unit.Hour } } },
    ];
    for (const input of wireForms(rows)) expect(nextDueDoses(input, { ...query, limit: 2 }))
      .toEqual(["2026-11-02T07:00:00+00:00", "2026-11-02T11:00:00+00:00"]);
  });

  it("already gives a dated same-track successor its established calendar start", () => {
    const source = "1 drop OD on 2026-11-02 then 2 drops OD daily; 1 drop OS daily";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].schedule?.calendarEvents?.map(event => event.isoDate)).toEqual(["2026-11-02"]);
    expect(parsed.meta.canonical.clauses[1].schedule?.boundsStart).toBe("2026-11-03");
    const successor = parsed.meta.canonical.course!.stages[0].administrations.find(a => a.sourceMember === 1)!;
    expect(successor.phaseStart).toBeUndefined();
    expect(successor.schedule?.recurrence?.calendarWindow?.start).toBe("2026-11-03");
    for (const input of [parsed, ...wireForms(parsed.fhir)]) expect(nextDueDoses(input, { ...query, limit: 4 }))
      .toEqual(["2026-11-02T00:00:00+00:00", "2026-11-02T09:00:00+00:00",
        "2026-11-03T09:00:00+00:00", "2026-11-03T09:00:00+00:00"]);
  });

  it("retains the authored calendar end separately from a resolved parallel execution cut", () => {
    const source = "1 drop OD QID x7d then 1 drop OD BID; " +
      "1 drop OS QID from 2026-10-25 for 7 days until 2026-11-15 then 1 drop OS BID from 2026-11-16";
    const parsed = parseSig(source);
    const members = parsed.meta.canonical.course!.stages.reduce<CanonicalAdministration[]>((all, stage) => all.concat(stage.administrations), [])
      .filter(member => member.sourceMember === 2);
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(member.syntax?.schedule?.boundsEnd).toBe("2026-11-15");
      expect(member.schedule?.recurrence?.calendarWindow).toEqual({ start: "2026-10-25", end: "2026-10-31" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.meta.canonical.clauses[2].schedule).toMatchObject({ boundsEnd: "2026-11-15", duration: 7, durationUnit: "d" });
  });
});



describe("round55 execution preserves authored calendar and terminology meaning", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const wire = (source: FhirR6DosageInstruction, version: "r5" | "r6") =>
    version === "r6" ? persist(source) : persist(toFhirR5Dosages(source));
  const quantity = (value = 1) => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });
  const note = { url: "urn:clinic:round55-execution-note", valueString: "retain independently authored details" };
  const eventWindow = { url: "urn:ezmedicationinput:StructureDefinition:medication-timing-event-window",
    extension: [{ url: "start", valueCode: "WAKE" }, { url: "end", valueCode: "HS" }] };
  const monthDay = { url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt: 15 };
  const marker = "urn:ezmedicationinput:StructureDefinition:timing-administration-duration";
  const componentOf = (input: FhirR6DosageInstruction | FhirDosage[]) =>
    toDosageDetails(toFhirR5Dosages(input)).step![0].component[0];

  it.each(["r5", "r6"] as const)("retains BID after a metadata-only Coding (%s)", version => {
    const coding = [
      { id: "local-annotation", extension: [note] },
      { system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID", _code: { id: "coded-cadence" } },
    ];
    for (const entries of [coding, [coding[1], coding[0]]]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(), timing: { code: { coding: entries } } }] }] };
      const input = wire(source, version), before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Use 1 tablet twice daily.");
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(componentOf(input).timing?.code?.coding).toEqual(entries);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("keeps the explicit waking window for equivalent elapsed cadences (%s)", version => {
    for (const [period, periodUnit] of [[0.5, Unit.Day], [12, Unit.Hour], [1 / 14, Unit.Week]] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
        timing: { repeat: { period, periodUnit, extension: [eventWindow, note] } } }] }] };
      const input = wire(source, version), before = JSON.stringify(input);
      const query = { ...options, eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 3 };
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 1, unit: "tab" });
      expect(componentOf(input).timing?.repeat).toMatchObject({ period, periodUnit, extension: [eventWindow, note] });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("keeps punctual WAKE, explicit windows, and unwindowed calendar controls distinct (%s)", version => {
    const punctual: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, when: [EventTiming.Wake], extension: [note] } } }] }] };
    const calendar: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
      timing: { repeat: { period: 1, periodUnit: Unit.Day, extension: [eventWindow, note] } } }] }] };
    const unwindowed: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
      timing: { repeat: { period: 1, periodUnit: Unit.Day, extension: [note] } } }] }] };
    const query = { ...options, eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 2 };
    expect(nextDueDoses(wire(punctual, version), query)).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
    ]);
    expect(nextDueDoses(wire(calendar, version), query)).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
    ]);
    expect(nextDueDoses(wire(unwindowed, version), query)).toEqual([
      "2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00",
    ]);
  });

  it.each(["r5", "r6"] as const)("uses the origin clock for a clockless month-day and counts earlier opportunities (%s)", version => {
    for (const period of [1, 2]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
        timing: { repeat: { count: 3, frequency: 1, period, periodUnit: Unit.Month, extension: [monthDay, note] } } }] }] };
      const input = wire(source, version), before = JSON.stringify(input);
      const query = { from: "2026-01-01T10:15:00Z", orderedAt: "2026-01-01T10:15:00Z", timeZone: "UTC", limit: 3 };
      const dates = period === 1 ? ["2026-01-15", "2026-02-15", "2026-03-15"] : ["2026-01-15", "2026-03-15", "2026-05-15"];
      expect(nextDueDoses(input, query)).toEqual(dates.map(day => day + "T10:15:00+00:00"));
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 6, durationUnit: Unit.Month }).totalUnits).toBe(3);
      const later = { ...query, from: "2026-02-01T00:00:00Z" };
      expect(nextDueDoses(input, later)).toEqual(dates.slice(1).map(day => day + "T10:15:00+00:00"));
      expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 5, durationUnit: Unit.Month }).totalUnits).toBe(2);
      expect(componentOf(input).timing?.repeat).toMatchObject({ count: 3, period, periodUnit: Unit.Month, extension: [monthDay, note] });
      expect(componentOf(input).timing?.repeat?.timeOfDay).toBeUndefined();
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("retains authored month-day clocks and unselected month-end clamping (%s)", version => {
    const source = (selected: boolean): FhirR6DosageInstruction => ({ step: [{ component: [{ ...quantity(),
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Month,
        ...(selected ? { timeOfDay: ["08:00:00"], extension: [monthDay, note] } : { extension: [note] }) } } }] }] });
    const query = { from: "2026-01-31T10:15:00Z", orderedAt: "2026-01-31T10:15:00Z", timeZone: "UTC", limit: 3 };
    expect(nextDueDoses(wire(source(false), version), query)).toEqual([
      "2026-01-31T10:15:00+00:00", "2026-02-28T10:15:00+00:00", "2026-03-28T10:15:00+00:00",
    ]);
    expect(nextDueDoses(wire(source(true), version), query)).toEqual([
      "2026-02-15T08:00:00+00:00", "2026-03-15T08:00:00+00:00", "2026-04-15T08:00:00+00:00",
    ]);
  });

  it.each(["r5", "r6"] as const)("validates the selected branch against the complete submitted course (%s)", version => {
    const choice = { url: "urn:ezmedicationinput:StructureDefinition:medication-alternative-choice", extension: [
      { url: "groupId", valueString: "regimen" }, { url: "branchId", valueString: "B" },
      { url: "selectionBehavior", valueCode: "exactly-one" },
    ] };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(2), modifierExtension: [choice],
      extension: [note], timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"] } } }] }] };
    const input = wire(source, version), before = JSON.stringify(input);
    const selectedA = { ...options, alternativeChoices: { regimen: "A" } };
    expect(() => nextDueDoses(input, { ...selectedA, limit: 2 }))
      .toThrow(expect.objectContaining({ code: "unknown-alternative-branch" }));
    expect(() => calculateTotalUnits({ dosage: input, ...selectedA, durationValue: 1, durationUnit: Unit.Day }))
      .toThrow(expect.objectContaining({ code: "unknown-alternative-branch" }));
    const selectedB = { ...options, alternativeChoices: { regimen: "B" }, limit: 2 };
    expect(nextDueDoses(input, selectedB)).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...selectedB, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
    const standalone = persist(toFhirR5Dosages(source)[0]);
    expect(nextDueDoses(standalone, selectedA)).toEqual([]);
    expect(calculateTotalUnits({ dosage: standalone, ...selectedA, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(componentOf(input).modifierExtension).toEqual([choice]);
    expect(componentOf(input).extension).toContainEqual(note);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("retains explicit successor events while keeping an unanchored interval floor (%s)", version => {
    for (const explicit of [true, false]) {
      const source: FhirR6DosageInstruction = { step: [
        { component: [{ ...quantity(), timing: { event: ["2026-01-01T08:00:00Z"] }, extension: [note] }] },
        { component: [{ ...quantity(2), timing: {
          ...(explicit ? { event: ["2026-01-01T07:00:00Z", "2026-01-01T09:00:00Z", "2026-01-01T13:00:00Z"] } : {}),
          repeat: { period: 4, periodUnit: Unit.Hour } } }] },
      ] };
      const input = wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(explicit ? [
        "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00", "2026-01-01T13:00:00+00:00",
      ] : [
        "2026-01-01T08:00:00+00:00", "2026-01-01T12:00:00+00:00", "2026-01-01T16:00:00+00:00", "2026-01-01T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(explicit ? 5 : 7);
      const restored = toDosageDetails(toFhirR5Dosages(input));
      expect(restored.step![1].component[0].timing?.event).toEqual(source.step![1].component[0].timing?.event);
      expect(restored.step![0].component[0].extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("does not reinterpret explicit UCUM conductance as a duration (%s)", version => {
    for (const variant of ["S", "s", "s{infusion}", "systemless S", "uncoded SECONDS"]) {
      const seconds = variant !== "S";
      const endpoint = { value: 60, ...(variant === "uncoded SECONDS" ? { unit: "SECONDS" }
        : { unit: seconds ? "seconds" : "siemens", code: variant === "systemless S" ? "S" : variant,
          ...(variant === "systemless S" ? {} : { system: "http://unitsofmeasure.org" }) }),
        _value: { id: "authored-duration-value" }, extension: [note] };
      const range = { id: "authored-duration-range", low: { ...endpoint }, high: { ...endpoint } };
      const source: FhirR6DosageInstruction = { step: [
        { component: [{ ...quantity(), timing: { repeat: { count: 1, extension: [{ url: marker, valueRange: range }] } } }] },
        { component: [{ ...quantity(2), timing: { repeat: { count: 1 } } }] },
      ] };
      const input = wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual(seconds ? [
        "2026-01-01T00:00:00+00:00", "2026-01-01T00:01:00+00:00",
      ] : ["2026-01-01T00:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(seconds ? 3 : 1);
      expect(componentOf(input).timing?.repeat?.extension?.find(value => value.url === marker)?.valueRange).toEqual(range);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["08:00", "at 08:00", "8 AM"])("keeps the authored %s clock inside a relative ending", clock => {
    const ending = "until the next morning " + clock;
    const source = "Take 1 tablet every 6 hours " + ending;
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ timingCode: "Q6H", period: 6, periodUnit: Unit.Hour });
    expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].additionalInstructions).toContainEqual({ text: ending });
    for (const input of [persist(parsed.fhirNext), persist(toFhirR5Dosages(parsed.fhirNext))]) {
      const component = componentOf(input);
      expect(component.timing?.repeat?.timeOfDay).toBeUndefined();
      expect(component.additionalInstruction).toContainEqual({ text: ending });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });


  it.each([1.5, 2])("preserves a terminal two-day pause after an authored %s-day course", duration => {
    const source = `1 tab PO at 08:00 and 20:00 for ${duration} days, then HOLD for 2 days, then 2 tabs PO at 08:00 and 20:00 for 2 days`;
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ duration, durationUnit: Unit.Day });
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.treatmentPause?.durationDays).toBe(2);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBe(duration + 2);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    for (const version of ["r5", "r6"] as const) {
      const input = wire(parsed.fhirNext, version), saved = JSON.stringify(input);
      if (duration === 1.5) {
        // This existing representation cannot combine an elapsed fractional
        // phase with a later civil-day pause. Do not round or silently omit it.
        expect(() => nextDueDoses(input, { ...options, limit: 12 }))
          .toThrow("Unsupported R6 step RelativeTime: requires a treatment-start offset");
        expect(() => calculateTotalUnits({ dosage: input, ...options, durationValue: 6, durationUnit: Unit.Day }))
          .toThrow("Unsupported R6 step RelativeTime: requires a treatment-start offset");
      } else {
        expect(nextDueDoses(input, { ...options, limit: 12 })).toEqual([
          "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
          "2026-01-02T08:00:00+00:00", "2026-01-02T20:00:00+00:00",
          "2026-01-05T08:00:00+00:00", "2026-01-05T20:00:00+00:00",
          "2026-01-06T08:00:00+00:00", "2026-01-06T20:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(12);
      }
      const restored = toDosageDetails(toFhirR5Dosages(input));
      expect(restored.renderedInstruction).toBe(source);
      expect(restored.step![0].component[0].timing?.repeat?.boundsDuration).toMatchObject({ value: duration, unit: "days", code: "d", system: "http://unitsofmeasure.org" });
      expect(JSON.stringify(input)).toBe(saved);
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


describe("round56 execution respects retained public facts", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const note = { url: "urn:clinic:round56-execution-note", valueString: "keep independently authored data" };
  const quantity = (value = 1) => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });
  const r6Wire = (source: FhirR6DosageInstruction, version: "r5" | "r6") =>
    version === "r6" ? persist(source) : persist(toFhirR5Dosages(source));
  const r5Wire = (source: FhirDosage, version: "r5" | "r6") =>
    version === "r5" ? persist(source) : persist(toDosageDetails([persist(source)]));
  const reopened = (input: FhirDosage | FhirDosage[] | FhirR6DosageInstruction) =>
    toDosageDetails(persist(toFhirR5Dosages(Array.isArray(input) ? input : "step" in input
      ? input as FhirR6DosageInstruction : [input as FhirDosage])));
  const offset = (minutes: number) => ({
    url: "urn:ezmedicationinput:StructureDefinition:medication-administration-offset",
    valueQuantity: { value: minutes, unit: "min", code: "min", system: "http://unitsofmeasure.org" },
  });

  it.each(["r5", "r6"] as const)("prefers recognized BID beside a coded local translation (%s)", version => {
    const entries = [{ system: "urn:clinic:cadence", code: "TWICE", display: "clinic twice daily", extension: [note] },
      { system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID", _code: { id: "authored-cadence" } }];
    for (const coding of [entries, [entries[1], entries[0]]]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(), timing: { code: { coding } }, extension: [note] }] }] };
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe("Use 1 tablet twice daily.");
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(reopened(input).step![0].component[0].timing?.code?.coding).toEqual(coding);
      expect(reopened(input).step![0].component[0].extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    }
    const local: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(), timing: { code: {
      coding: [entries[0]], text: "Clinic schedule remains authored" } } }] }] };
    const input = r6Wire(local, version), before = JSON.stringify(input);
    expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).not.toContain("twice daily");
    expect(reopened(input).step![0].component[0].timing?.code).toEqual(local.step![0].component[0].timing!.code);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("includes every matching date in month and year period ends (%s)", version => {
    for (const zone of ["UTC", "America/New_York"]) for (const end of ["2026-11", "2026"]) {
      const last = end === "2026-11" ? "2026-11-30" : "2026-12-31";
      const next = end === "2026-11" ? "2026-12-01" : "2027-01-01";
      const suffix = zone === "UTC" ? "+00:00" : "-05:00";
      const row: FhirDosage = { ...quantity(), timing: { repeat: {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"],
        boundsPeriod: { end, _end: { id: "authored-end-precision" }, extension: [note] },
      } }, extension: [note] };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      const query = { from: last + "T00:00:00" + suffix, orderedAt: "2026-11-01T00:00:00" + suffix, timeZone: zone, limit: 2 };
      expect(nextDueDoses(input, query)).toEqual([last + "T09:00:00" + suffix]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(nextDueDoses(input, { ...query, from: next + "T00:00:00" + suffix })).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...query, from: next + "T00:00:00" + suffix,
        durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod).toEqual(row.timing!.repeat!.boundsPeriod);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("keeps inclusive full-date and exact-timestamp end controls (%s)", version => {
    for (const end of ["2026-11-30", "2026-11-30T09:00:00Z", "2026-11-30T08:59:59.999Z"]) {
      const row: FhirDosage = { ...quantity(), timing: { repeat: { frequency: 1, period: 1,
        periodUnit: Unit.Day, timeOfDay: ["09:00:00"], boundsPeriod: { end } } }, extension: [note] };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      const query = { from: "2026-11-30T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 2 };
      const expected = end.endsWith("08:59:59.999Z") ? [] : ["2026-11-30T09:00:00+00:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(expected.length);
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod?.end).toBe(end);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("gives an absolute event one weekly-cycle owner with and without a cap (%s)", version => {
    for (const capped of [false, true]) {
      const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
        step: [{ component: [{ ...quantity(), timing: { event: ["2026-01-10T09:00:00Z"] }, extension: [note],
          ...(capped ? { safety: { doseLimit: [{ scope: "period" as const, valueQuantity: { value: 10, unit: "tab" },
            period: { value: 1, code: "d", unit: "d", system: "http://unitsofmeasure.org" } }] } } : {}) }] }] };
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(["2026-01-10T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(nextDueDoses(input, { ...options, from: "2026-01-11T00:00:00Z", limit: 2 })).toEqual([]);
      const saved = reopened(input);
      expect(saved.repeatCycle).toEqual(source.repeatCycle);
      expect(saved.step![0].component[0].timing?.event).toEqual(["2026-01-10T09:00:00Z"]);
      expect(saved.step![0].component[0].extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("retains an absolute event after the final finite cycle's nominal end (%s)", version => {
    for (const cycles of [1, 2]) for (const capped of [false, true]) {
      const event = cycles === 1 ? "2026-01-10T09:00:00Z" : "2026-01-17T09:00:00Z";
      const count = { url: "urn:ezmedicationinput:StructureDefinition:medication-course-cycle-count", valueInteger: cycles };
      const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
        modifierExtension: [count], step: [{ component: [{ ...quantity(), timing: { event: [event] }, extension: [note],
          ...(capped ? { safety: { doseLimit: [{ scope: "period" as const, valueQuantity: { value: 10, unit: "tab" },
            period: { value: 1, code: "d", unit: "d", system: "http://unitsofmeasure.org" } }] } } : {}) }] }] };
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([event.replace("Z", "+00:00")]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 21, durationUnit: Unit.Day }).totalUnits).toBe(1);
      const saved = reopened(input);
      expect(saved.modifierExtension).toContainEqual(count);
      expect(saved.step![0].component[0].timing?.event).toEqual([event]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("does not complete an earlier-cycle predecessor from a later absolute event (%s)", version => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" }, step: [
      { component: [{ ...quantity(), timing: { event: ["2026-01-10T09:00:00Z"] }, extension: [note] }] },
      { component: [{ ...quantity(2), timing: { event: ["2026-01-11T09:00:00Z"] }, extension: [note] }] },
    ] };
    const input = r6Wire(source, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(["2026-01-10T09:00:00+00:00", "2026-01-11T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(reopened(input).step!.map(step => step.component[0].timing?.event)).toEqual([
      ["2026-01-10T09:00:00Z"], ["2026-01-11T09:00:00Z"],
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("retains two independent administrations at the same absolute event (%s)", version => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
      step: [{ component: [1, 2].map(value => ({ ...quantity(value), timing: { event: ["2026-01-10T09:00:00Z"] }, extension: [note] })) }] };
    const input = r6Wire(source, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(["2026-01-10T09:00:00+00:00", "2026-01-10T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(reopened(input).step![0].component.map(component => component.doseAndRate?.[0].doseQuantity?.value)).toEqual([1, 2]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("keeps independently prescribed relative-cycle doses at the same instant (%s)", version => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
      step: [{ component: [{ ...quantity(), timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["09:00:00"], boundsDuration: { value: 10, unit: "d", code: "d", system: "http://unitsofmeasure.org" } } }, extension: [note] }] }] };
    const input = r6Wire(source, version), before = JSON.stringify(input);
    const expected = Array.from({ length: 14 }, (_, index) => "2026-01-" + String(index + 1).padStart(2, "0") + "T09:00:00+00:00");
    expected.push("2026-01-08T09:00:00+00:00", "2026-01-09T09:00:00+00:00", "2026-01-10T09:00:00+00:00");
    expected.sort();
    expect(nextDueDoses(input, { ...options, limit: 17 })).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(17);
    expect(reopened(input).step![0].component[0].timing?.repeat?.boundsDuration).toEqual(source.step![0].component[0].timing!.repeat!.boundsDuration);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([3, 12])("resolves a standalone choice before its %s-hour phase origin", hours => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ ...dose(2),
      choice: { groupId: "regimen", branchId: "B", selectionBehavior: "exactly-one" }, phaseOrigin: { value: hours, unit: "h" } }] }] };
    const row = persist(courseToR5(course)[0]), before = JSON.stringify(row);
    const selectedA = { ...options, alternativeChoices: { regimen: "A" }, limit: 1 };
    const selectedB = { ...options, alternativeChoices: { regimen: "B" }, limit: 1 };
    expect(nextDueDoses(row, selectedA)).toEqual([]);
    expect(calculateTotalUnits({ dosage: row, ...selectedA, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(nextDueDoses(row, selectedB)).toEqual([hours === 3 ? "2026-01-01T09:00:00+00:00" : "2026-01-02T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: row, ...selectedB, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(hours === 3 ? 2 : 0);
    for (const complete of [persist(courseToR5(course)), persist(courseToR6(course))]) {
      expect(() => nextDueDoses(complete, selectedA)).toThrow(expect.objectContaining({ code: "unknown-alternative-branch" }));
      expect(() => calculateTotalUnits({ dosage: complete, ...selectedA, durationValue: 1, durationUnit: Unit.Day }))
        .toThrow(expect.objectContaining({ code: "unknown-alternative-branch" }));
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("uses a measured drop endpoint for the complete two-eye maximum (%s)", version => {
    for (const kind of ["absent", "annotation", "measured"] as const) {
      const high = kind === "absent" ? undefined : { id: "authored-upper", extension: [note],
        ...(kind === "measured" ? { value: 3, unit: "drop" } : {}) };
      const range = { low: { value: 1, unit: "drop", _value: { id: "authored-low" } }, ...(high ? { high } : {}) };
      const source: FhirR6DosageInstruction = { step: [{ component: [{ site: { concept: { text: "both eyes" } },
        doseAndRate: [{ doseRange: range }], timing: { repeat: { count: 1 } },
        safety: { doseLimit: [{ scope: "administration", valueQuantity: { value: 4, unit: "drop" } }] }, extension: [note] }] }] };
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual(["2026-01-01T00:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 4, unit: "drop", quantityKind: "maximum" });
      const saved = reopened(input).step![0].component[0];
      expect(saved.site?.concept?.text).toBe("both eyes");
      expect(saved.doseAndRate?.[0].doseRange).toEqual(range);
      expect(saved.extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("counts displaced admissions under occurrence and calendar quantity ceilings (%s)", version => {
    for (const cap of ["occurrence", "month", "year", "none"]) for (const minutes of [-60, 0, 60]) {
      const row: FhirDosage = { ...quantity(), timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["00:30:00"], boundsPeriod: { start: "2026-01-02T00:00:00Z" },
        ...(cap === "occurrence" ? { extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
          { url: "max", valueInteger: 1 }, { url: "period", valueQuantity: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org" } },
        ] }] } : {}) } }, modifierExtension: [offset(minutes)], extension: [note],
        ...(["month", "year"].includes(cap) ? { maxDosePerPeriod: [{ numerator: { value: 10, unit: "tab" },
          denominator: { value: 1, code: cap === "month" ? "mo" : "a", unit: cap === "month" ? "mo" : "a", system: "http://unitsofmeasure.org" } }] } : {}) };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      const from = minutes < 0 ? "2026-01-01T23:00:00Z" : minutes === 0 ? "2026-01-02T00:00:00Z" : "2026-01-02T01:00:00Z";
      const due = minutes < 0 ? "2026-01-01T23:30:00+00:00" : minutes === 0 ? "2026-01-02T00:30:00+00:00" : "2026-01-02T01:30:00+00:00";
      const query = { ...options, from, limit: 1 };
      expect(nextDueDoses(input, query)).toEqual([due]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(1);
      expect(reopened(input).step![0].component[0].modifierExtension).toContainEqual(offset(minutes));
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod?.start).toBe("2026-01-02T00:00:00Z");
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("spends an exhausted non-PRN count from actual bounded records without inventing partial dates (%s)", version => {
    const row: FhirDosage = { ...quantity(), timing: { event: ["2026-11"], _event: [{ id: "month-precision" }], repeat: { count: 2 } }, extension: [note] };
    const input = r5Wire(row, version), before = JSON.stringify(input);
    const query = { from: "2026-11-03T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 2 };
    const records = ["2026-11-01T09:00:00Z", "2026-11-02T09:00:00Z"];
    expect(nextDueDoses(input, { ...query, priorDoseTimes: records })).toEqual([]);
    expect(calculateTotalUnits({ dosage: input, ...query, priorDoseTimes: records, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ dosage: input, ...query, priorCount: 2, priorDoseTimes: records,
      durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    for (const partial of [{ priorDoseTimes: records.slice(0, 1) }, { priorCount: 1, priorDoseTimes: records },
      { priorDoseTimes: ["2026-10-31T09:00:00Z", "2026-11-04T09:00:00Z"] }])
      expect(() => calculateTotalUnits({ dosage: input, ...query, ...partial, durationValue: 1, durationUnit: Unit.Day }))
        .toThrow(expect.objectContaining({ code: "timing-required" }));
    const saved = reopened(input).step![0].component[0];
    expect(saved.timing?.event).toEqual(["2026-11"]);
    expect(saved.timing?._event).toEqual([{ id: "month-precision" }]);
    expect(saved.timing?.repeat?.count).toBe(2);
    expect(saved.extension).toContainEqual(note);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("keeps ordinary inferred history and explicit priorCount precedence (%s)", version => {
    const row: FhirDosage = { ...quantity(), timing: { repeat: { count: 3, frequency: 1, period: 1,
      periodUnit: Unit.Day, timeOfDay: ["09:00:00"] } }, extension: [note] };
    const input = r5Wire(row, version), before = JSON.stringify(input);
    const query = { from: "2026-11-03T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 3,
      priorDoseTimes: ["2026-11-01T09:00:00Z"] };
    expect(nextDueDoses(input, query)).toEqual(["2026-11-03T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...query, priorCount: 1 })).toEqual(["2026-11-03T09:00:00+00:00", "2026-11-04T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...query, priorCount: 1, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(before);
  });
});


describe("round57 typed timing and civil boundaries", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const versions = ["r5", "r6"] as const;
  const note = { url: "urn:clinic:round57-execution-note", valueString: "keep authored data" };
  const quantity = (value = 1) => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });
  const r5Wire = (row: FhirDosage, version: typeof versions[number]) =>
    version === "r5" ? persist([row]) : persist(toDosageDetails([row]));
  const r6Wire = (instruction: FhirR6DosageInstruction, version: typeof versions[number]) =>
    version === "r6" ? persist(instruction) : persist(toFhirR5Dosages(instruction));
  const reopened = (input: FhirDosage[] | FhirR6DosageInstruction) =>
    persist(toDosageDetails(persist(toFhirR5Dosages(input))));

  it.each(versions)("keeps a unitless delayed approximate dose beside its inherited unit (%s)", version => {
    for (const explicitUnit of ["", " tablets"]) {
      const text = "Take 1 tablet once, then about 2" + explicitUnit + " in 6 hours";
      const parsed = parseSig(text);
      expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab", comparator: "~" });
      expect(parsed.meta.canonical.clauses[1].schedule?.administrationOffsetMinutes).toBe(360);
      const input = r6Wire(parsed.fhirNext, version), before = JSON.stringify(input);
      expect(importCanonicalCourse(input).stages[1].administrations[0].amounts![0].quantity)
        .toMatchObject({ value: 2, unit: "tab", comparator: "~" });
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
        "2026-01-01T00:00:00+00:00", "2026-01-01T06:00:00+00:00",
      ]);
      expect(reopened(input).renderedInstruction).toBe(text);
      expect(JSON.stringify(input)).toBe(before);
    }
    const unknown = parseSig("Take 1 tablet once, then about 2 in 6 cups");
    expect(unknown.meta.canonical.clauses.every(clause => clause.schedule?.administrationOffsetMinutes === undefined)).toBe(true);
    expect(JSON.stringify(unknown.fhirNext)).toContain("about 2 in 6 cups");
  });

  it.each(versions)("keeps comparative meridiem phrases as clocks without inventing a dose (%s)", version => {
    for (const [text, clock] of [["Take around 2 pm", "14:00:00"], ["Take approximately 2 am", "02:00:00"]]) {
      const parsed = parseSig(text);
      expect(parsed.meta.canonical.clauses[0].dose?.value).toBeUndefined();
      expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toEqual([clock]);
      const input = r6Wire(parsed.fhirNext, version), before = JSON.stringify(input);
      const rows = toFhirR5Dosages(input);
      expect(rows[0].doseAndRate?.[0].doseQuantity?.value).toBeUndefined();
      expect(rows[0].timing?.repeat?.timeOfDay).toEqual([clock]);
      expect(reopened(input).renderedInstruction).toBe(text);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("keeps a qualified amount separate from an actual around-site phrase (%s)", version => {
    const approximate = parseSig("Take around 2 tablets daily");
    expect(approximate.meta.canonical.clauses[0].dose).toMatchObject({ value: 2, unit: "tab", comparator: "~" });
    expect(approximate.meta.canonical.clauses[0].site).toBeUndefined();
    const input = r6Wire(approximate.fhirNext, version), before = JSON.stringify(input);
    expect(importCanonicalCourse(input).stages[0].administrations[0].amounts![0].quantity)
      .toMatchObject({ value: 2, unit: "tab", comparator: "~" });
    const spatialInput = r6Wire(parseSig("Apply 1 g around the left eye daily").fhirNext, version);
    expect(formatSig(spatialInput, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/around.*left eye/u);
    expect(toFhirR5Dosages(spatialInput)[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "g" });
    expect(reopened(input).renderedInstruction).toBe("Take around 2 tablets daily");
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("retains a next-morning deadline without turning it into an onset (%s)", version => {
    const text = "Take 1 tablet once by the next morning";
    const deadline = parseSig(text), onset = parseSig("Take 1 tablet once the next morning");
    expect(deadline.meta.canonical.clauses[0].schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(deadline.meta.canonical.clauses[0].schedule?.phaseStartReference).toBeUndefined();
    expect(deadline.meta.canonical.clauses[0].schedule?.when ?? []).not.toContain(EventTiming.Morning);
    expect(deadline.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(onset.meta.canonical.clauses[0].schedule).toMatchObject({
      count: 1, treatmentStartOffsetDays: 1, phaseStartReference: "treatment-day-start", when: [EventTiming.Morning],
    });
    const input = r6Wire(deadline.fhirNext, version), before = JSON.stringify(input);
    expect(reopened(input).renderedInstruction).toBe(text);
    expect(JSON.stringify(reopened(input))).toContain("by the next morning");
    const savedDeadline = reopened(input);
    const savedMember = importCanonicalCourse(savedDeadline).stages[0].administrations[0];
    expect(savedMember.phaseStart).toBeUndefined();
    expect(savedMember.phaseOrigin).toBeUndefined();
    expect(savedMember.phaseEnd).toMatchObject({ anchor: "unresolved", description: "by the next morning" });
    expect(savedMember.schedule!.recurrence!.anchors ?? []).not.toContain(EventTiming.Morning);
    expect(savedDeadline.step![0].component[0].timing?.repeat).toMatchObject({ count: 1 });
    expect(formatSig(savedDeadline, "long", { locale: "en", realizationMode: "normalized" })).toContain("by the next morning");
    const savedBefore = JSON.stringify(savedDeadline);
    expect(() => nextDueDoses(savedDeadline, { ...options, limit: 2 }))
      .toThrow(/Unsupported R6 step RelativeTime: requires a treatment-start offset/u);
    expect(JSON.stringify(savedDeadline)).toBe(savedBefore);
    const positive = r6Wire(onset.fhirNext, version);
    expect(nextDueDoses(positive, { ...options, limit: 2 })).toEqual(["2026-01-02T08:00:00+00:00"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  const midnightGaps = [
    { zone: "America/Havana", end: "2012-04", after: "2012-05-01", last: "2012-04-30", offset: "-04:00", order: "2012-04-01T12:00:00-04:00" },
    { zone: "Asia/Amman", end: "2011-04", after: "2011-05-01", last: "2011-04-30", offset: "+03:00", order: "2011-04-01T12:00:00+03:00" },
    { zone: "America/Danmarkshavn", end: "1996", after: "1997-01-01", last: "1996-12-31", offset: "+00:00", order: "1996-01-01T12:00:00Z" },
  ];
  it.each(versions.flatMap(version => midnightGaps.map(gap => ({ version, ...gap }))))(
    "closes $end at the next local midnight independently of its opening gap ($zone/$version)", data => {
      const boundsPeriod = { end: data.end, _end: { id: "authored-end" }, extension: [note] };
      const row: FhirDosage = { ...quantity(), extension: [note], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["00:30:00"], boundsPeriod,
      } } };
      const input = r5Wire(row, data.version), before = JSON.stringify(input);
      const after = { from: data.after + "T00:00:00" + data.offset, orderedAt: data.order, timeZone: data.zone, limit: 1 };
      expect(nextDueDoses(input, after)).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...after, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(0);
      const inside = { ...after, from: data.last + "T00:00:00" + data.offset };
      expect(nextDueDoses(input, inside)).toEqual([data.last + "T00:30:00" + data.offset]);
      expect(calculateTotalUnits({ dosage: input, ...inside, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(1);
      const saved = reopened(input).step![0].component[0];
      expect(saved.timing?.repeat?.boundsPeriod).toEqual(boundsPeriod);
      expect(saved.extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("keeps inclusive full-date and exact-timestamp end behavior (%s)", version => {
    for (const end of ["2026-01-01", "2026-01-01T09:00:00Z"]) {
      const row: FhirDosage = { ...quantity(), timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["09:00:00"], boundsPeriod: { end } } } };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual(["2026-01-01T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod?.end).toBe(end);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions.flatMap(version => [
    { version, zone: "Asia/Bangkok", offset: "+07:00" }, { version, zone: "America/New_York", offset: "-05:00" },
    { version, zone: "UTC", offset: "+00:00" },
  ]))("starts month and year precision at local midnight ($zone/$version)", data => {
    for (const [start, day] of [["2026-11", "2026-11-01"], ["2026", "2026-01-01"]]) {
      const boundsPeriod = { start, _start: { id: "authored-start" }, extension: [note] };
      const row: FhirDosage = { ...quantity(), extension: [note], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["02:00:00"], boundsPeriod,
      } } };
      // November's first day is still daylight time at midnight in New York.
      const dayOffset = data.zone === "America/New_York" && start === "2026-11" ? "-04:00" : data.offset;
      const precedingDay = start === "2026-11" ? "2026-10-31" : "2025-12-31";
      const query = { from: precedingDay + "T00:00:00" + dayOffset, orderedAt: precedingDay + "T00:00:00" + dayOffset, timeZone: data.zone, limit: 1 };
      const input = r5Wire(row, data.version), before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual([day + "T02:00:00" + data.offset]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod).toEqual(boundsPeriod);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions.flatMap(version => [1, 2].map(period => ({ version, period }))))(
    "uses both explicit month days for an aggregate cadence of $period months ($version)", ({ version, period }) => {
      const selected = [1, 15].map(valuePositiveInt => ({
        url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt,
      }));
      const row: FhirDosage = { ...quantity(), extension: [note], timing: { repeat: {
        frequency: 2, period, periodUnit: Unit.Month, count: 4, extension: [...selected, note],
      } } };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      const query = { ...options, from: "2026-01-01T09:00:00Z", orderedAt: "2026-01-01T09:00:00Z", limit: 5 };
      const nextMonth = period === 1 ? "02" : "03";
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T09:00:00+00:00", "2026-01-15T09:00:00+00:00",
        "2026-" + nextMonth + "-01T09:00:00+00:00", "2026-" + nextMonth + "-15T09:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: period, durationUnit: Unit.Month }).totalUnits).toBe(2);
      const middle = { ...query, from: "2026-01-15T00:00:00Z", limit: 1 };
      expect(nextDueDoses(input, middle)).toEqual(["2026-01-15T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...middle, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(reopened(input).step![0].component[0].timing?.repeat?.extension).toEqual([...selected, note]);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("retains ordinary aggregate distribution when no month day is authored (%s)", version => {
    const row: FhirDosage = { ...quantity(), timing: { repeat: { frequency: 2, period: 1, periodUnit: Unit.Month } }, extension: [note] };
    const input = r5Wire(row, version), before = JSON.stringify(input);
    const query = { ...options, from: "2026-01-01T09:00:00Z", orderedAt: "2026-01-01T09:00:00Z", limit: 4 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-16T09:00:00+00:00",
      "2026-02-01T09:00:00+00:00", "2026-02-15T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Month }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(before);
  });

  const cycleCases = [
    { name: "one event per cycle", events: ["2026-01-02T09:00:00Z", "2026-01-09T09:00:00Z"], expected: [
      "2026-01-02T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-09T09:00:00+00:00", "2026-01-09T09:00:00+00:00",
    ], total: 6 },
    { name: "no earlier owned event", events: ["2026-01-09T09:00:00Z"], expected: [
      "2026-01-09T09:00:00+00:00", "2026-01-09T09:00:00+00:00",
    ], total: 3 },
    { name: "final finite tail", events: ["2026-01-02T09:00:00Z", "2026-01-16T09:00:00Z"], expected: [
      "2026-01-02T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-16T09:00:00+00:00", "2026-01-16T09:00:00+00:00",
    ], total: 6 },
  ];
  const cycleInstruction = (events: string[]): FhirR6DosageInstruction => ({
    repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
    modifierExtension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-course-cycle-count", valueInteger: 2 }],
    step: [{ component: [{ ...quantity(), extension: [note], timing: { event: events } }] },
      { component: [{ ...quantity(2), extension: [note], timing: { repeat: { count: 1, when: [EventTiming.Immediate] } } }] }],
  });
  it.each(versions.flatMap(version => cycleCases.map(data => ({ version, ...data }))))(
    "completes explicit events within the owning cycle: $name ($version)", data => {
      const input = r6Wire(cycleInstruction(data.events), data.version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 8 })).toEqual(data.expected);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 21, durationUnit: Unit.Day }).totalUnits).toBe(data.total);
      const saved = reopened(input);
      expect(saved.step![0].component[0].timing?.event).toEqual(data.events);
      expect(saved.step![0].component[0].extension).toContainEqual(note);
      expect(saved.step![1].component[0].doseAndRate![0].doseQuantity?.value).toBe(2);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("does not borrow a future partial event to block a completed earlier cycle (%s)", version => {
    const input = r6Wire(cycleInstruction(["2026-01-02T09:00:00Z", "2026-02"]), version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual([
      "2026-01-02T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(reopened(input).step![0].component[0].timing?.event).toEqual(["2026-01-02T09:00:00Z", "2026-02"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("keeps the predecessor-end floor when a dependent track gains only an end bound (%s)", version => {
    for (const bounded of [false, true]) {
      const source = persist(parseSig("1 drop OD daily at 08:00 for 3 doses, then 2 drops OD daily at 08:00; 1 drop OS BID").fhirNext);
      const rows = source.step![0].component;
      delete rows[0].timing!.repeat!.count;
      rows[0].timing!.repeat!.boundsPeriod = { end: "2026-01-01" };
      if (bounded) rows[1].timing!.repeat!.boundsPeriod = { end: "2026-01-03" };
      for (const row of rows) row.extension = [...(row.extension ?? []), note];
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00", "2026-01-02T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
      const after = { ...options, from: "2026-01-04T00:00:00Z" };
      expect(calculateTotalUnits({ dosage: input, ...after, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(bounded ? 2 : 4);
      const saved = reopened(input).step![0].component;
      expect(saved[0].timing?.repeat?.boundsPeriod).toEqual({ end: "2026-01-01" });
      expect(saved[1].timing?.repeat?.boundsPeriod).toEqual(bounded ? { end: "2026-01-03" } : undefined);
      expect(saved.every(row => row.extension?.some(entry => entry.url === note.url && entry.valueString === note.valueString))).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});

describe("round58 execution phase ownership and local clocks", () => {
  const versions = ["native", "r5", "r6"] as const;
  const persist = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : version === "r5" ? persist(courseToR5(course)) : persist(courseToR6(course));
  const note = { url: "urn:clinic:round58-execution-note", valueString: "retain the independent source annotation" };
  const freshWire = (course: CanonicalCourse, version: typeof versions[number]) => {
    const input = wire(course, version);
    if (version !== "native") {
      const rows = Array.isArray(input) ? input : (input as FhirR6DosageInstruction).step!.flatMap(step => step.component);
      rows[0].extension = [...(rows[0].extension ?? []), note];
    }
    return input;
  };
  const allMembers = (input: Parameters<typeof importCanonicalCourse>[0]) =>
    importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
  const save = (input: ReturnType<typeof wire>) => persist(toDosageDetails(persist(
    Array.isArray(input) ? input : "kind" in input ? courseToR5(input) : toFhirR5Dosages(input)
  )));
  const immediateOptions = { from: "2026-01-01T12:00:00Z", orderedAt: "2026-01-01T12:00:00Z",
    timeZone: "UTC", eventClock: { NIGHT: "22:00" }, limit: 12 };

  it.each(versions)("keeps a recurring nightly phase after its immediate administration (%s)", version => {
    const text = "Take 1 tablet now and nightly for 3 days then take 2 tablets nightly for 2 days";
    const parsed = parseSig(text);
    const input = freshWire(parsed.meta.canonical.course!, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, immediateOptions)).toEqual([
      "2026-01-01T12:00:00+00:00", "2026-01-01T22:00:00+00:00", "2026-01-02T22:00:00+00:00",
      "2026-01-03T22:00:00+00:00", "2026-01-04T22:00:00+00:00", "2026-01-05T22:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(8);
    expect(allMembers(input)[0].schedule!.recurrence).toMatchObject({
      anchors: [EventTiming.Immediate, EventTiming.Night],
      courseLength: { value: 3, ...(version === "native" ? { unit: "d" } : { unit: "days", code: "d" }) },
    });
    const reopened = save(input);
    expect(allMembers(reopened)[0].schedule!.recurrence!.anchors).toEqual([EventTiming.Immediate, EventTiming.Night]);
    if (version !== "native") expect(reopened.step![0].component[0].extension).toContainEqual(note);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("does not infer one completion from an immediate anchor beside an explicit clock (%s)", version => {
    const first = dose();
    first.schedule!.recurrence = { anchors: [EventTiming.Immediate], clocks: ["22:00:00"],
      courseLength: { value: 3, unit: "d" } };
    const second = dose(2);
    second.schedule!.recurrence = { anchors: [EventTiming.Night], courseLength: { value: 2, unit: "d" } };
    const input = freshWire({ kind: "course", stages: [{ administrations: [first] }, { administrations: [second] }] }, version);
    const before = JSON.stringify(input);
    expect(nextDueDoses(input, immediateOptions)).toEqual([
      "2026-01-01T12:00:00+00:00", "2026-01-01T22:00:00+00:00", "2026-01-02T22:00:00+00:00",
      "2026-01-03T22:00:00+00:00", "2026-01-04T22:00:00+00:00", "2026-01-05T22:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(8);
    expect(allMembers(save(input))[0].schedule!.recurrence!.clocks).toEqual(["22:00:00"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("retains immediate-only and explicitly counted phase completion (%s)", version => {
    const immediate = freshWire(parseSig("Take 1 tablet now then take 2 tablets nightly for 2 days").meta.canonical.course!, version);
    expect(nextDueDoses(immediate, immediateOptions)).toEqual([
      "2026-01-01T12:00:00+00:00", "2026-01-01T22:00:00+00:00", "2026-01-02T22:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: immediate, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(5);
    const first = dose();
    first.schedule!.recurrence = { count: 2, anchors: [EventTiming.Immediate, EventTiming.Night],
      courseLength: { value: 3, unit: "d" } };
    const second = dose(2);
    second.schedule!.recurrence = { clocks: ["09:00:00"], courseLength: { value: 2, unit: "d" } };
    const counted = freshWire({ kind: "course", stages: [{ administrations: [first] }, { administrations: [second] }] }, version);
    const before = JSON.stringify(counted);
    expect(nextDueDoses(counted, immediateOptions)).toEqual([
      "2026-01-01T12:00:00+00:00", "2026-01-01T22:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: counted, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(6);
    expect(allMembers(save(counted))[0].schedule!.recurrence!.count).toBe(2);
    expect(JSON.stringify(counted)).toBe(before);
  });

  const parallelAt = (onset: number) => {
    // Existing typed compiler input: parse fresh clauses, then construct a new
    // independent elapsed-onset value before its first compiler submission.
    const text = "1 drop OD QID for 28 days then 1 drop OD BID for 7 days; 1 drop OS QID for 28 days";
    const plan = createBoundaryPlan(text), states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, text);
    const clauses = persist(states.map(state => state.primaryClause));
    clauses[1].schedule!.treatmentStartOffsetDays = onset;
    const parallel = buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph);
    const projected = projectParallelRegimen(parallel, plan.segments.map(segment => segment.text), text);
    const course = projected.kind === "resolved" ? projected.canonical
      : parallel.kind === "unresolved" ? courseFromPartialParallel(parallel, plan.segments.map(segment => segment.text), text)
        : undefined;
    if (!course) throw new Error("Expected the independent typed parallel tracks");
    return { parallel, course };
  };
  it("retains both phases as partial when same-track onsets cannot establish a forward replacement", () => {
    const { parallel, course } = parallelAt(0);
    expect(parallel.kind).toBe("unresolved");
    const rows = course.stages.flatMap(stage => stage.administrations);
    expect(rows.filter(member => member.target?.text === "right eye").map(member => ({
      frequency: member.schedule?.recurrence?.frequency,
      duration: member.schedule?.recurrence?.courseLength?.value,
    }))).toEqual([{ frequency: 4, duration: 28 }, { frequency: 2, duration: 7 }]);
    expect(courseToR6(course).step!.flatMap(step => step.component).filter(component =>
      component.site?.concept?.text === "right eye")).toHaveLength(2);
  });

  it.each(versions.flatMap(version => [14, 35].map(onset => ({ version, onset }))))(
    "retains the same-track successor at day $onset with the other eye independent ($version)", ({ version, onset }) => {
      const { parallel, course } = parallelAt(onset);
      if (onset === 14) expect(parallel.kind).toBe("resolved");
      const input = freshWire(course, version), before = JSON.stringify(input);
      const query = { ...options, from: "2026-01-15T00:00:00Z", limit: 6 };
      if (onset === 14) expect(nextDueDoses(input, query)).toEqual([
        "2026-01-15T08:00:00+00:00", "2026-01-15T08:00:00+00:00", "2026-01-15T12:00:00+00:00",
        "2026-01-15T16:00:00+00:00", "2026-01-15T20:00:00+00:00", "2026-01-15T20:00:00+00:00",
      ]);
      else expect(nextDueDoses(input, { ...query, from: "2026-01-29T00:00:00Z", limit: 2 })).toEqual([
        "2026-02-05T08:00:00+00:00", "2026-02-05T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 42, durationUnit: Unit.Day }).totalUnits)
        .toBe(onset === 14 ? 182 : 238);
      if (onset === 35)
        expect(calculateTotalUnits({ dosage: input, ...options, from: "2026-01-29T00:00:00Z",
          durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(0);
      const members = allMembers(save(input));
      const old = members.find(member => member.target?.text === "right eye" && member.schedule?.recurrence?.frequency === 4);
      const successor = members.find(member => member.target?.text === "right eye" && member.schedule?.recurrence?.frequency === 2);
      expect(old?.schedule?.recurrence?.courseLength).toMatchObject({ value: 28, code: "d" });
      expect(successor?.schedule?.recurrence?.courseLength).toMatchObject({ value: 7, code: "d" });
      expect(successor?.phaseOrigin).toMatchObject({ value: onset, unit: "d" });
      expect(JSON.stringify(input)).toBe(before);
    });

  const clockCases = ["calendar-end", "elapsed-origin", "elapsed-end", "day-start"] as const;
  it.each(versions.flatMap(version => clockCases.map(kind => ({ version, kind }))))(
    "uses the logical or elapsed phase clock across a spring gap ($kind/$version)", ({ version, kind }) => {
      const first = dose(); first.schedule!.recurrence!.clocks = ["12:00:00"];
      first.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
      const second = dose(2); second.schedule!.recurrence = {
        frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["01:00:00", "03:00:00"], courseLength: { value: 1, unit: "d" },
      };
      const course: CanonicalCourse = { kind: "course", stages: [
        { ...(kind === "elapsed-origin" ? { start: relative(2, "h") }
          : { end: kind === "day-start" ? { anchor: "treatment-day-start" as const, displacement: { value: 1, unit: "d" } }
            : relative(kind === "elapsed-end" ? 24 : 1, kind === "elapsed-end" ? "h" : "d") }),
          administrations: [first] },
        { administrations: [second] },
      ] };
      const anchor = kind === "elapsed-origin" ? "2026-03-07T00:30:00-05:00" : "2026-03-07T02:30:00-05:00";
      const query = { from: anchor, orderedAt: anchor, timeZone: "America/New_York", limit: 12 };
      const input = freshWire(course, version), before = JSON.stringify(input);
      const expected = kind === "day-start" ? [
        "2026-03-07T12:00:00-05:00", "2026-03-08T01:00:00-05:00", "2026-03-08T03:00:00-04:00",
      ] : kind === "elapsed-end" ? [
        "2026-03-07T12:00:00-05:00", "2026-03-09T01:00:00-04:00", "2026-03-09T03:00:00-04:00",
      ] : ["2026-03-07T12:00:00-05:00", "2026-03-09T01:00:00-04:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits)
        .toBe(kind === "day-start" || kind === "elapsed-end" ? 5 : 3);
      expect(nextDueDoses(save(input), query)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => ["clock", "meal-offset"].map(anchor => ({ version, anchor }))))(
    "inherits cadence without another phase's anchor inside a local event window ($anchor/$version)", ({ version, anchor }) => {
      const timing = anchor === "clock" ? "daily at 16:00" : "daily 30 minutes before breakfast";
      const text = `Take 1 tablet ${timing} for 2 days then take 2 tablets from day 4 while awake`;
      const parsed = parseSig(text), schedule = parsed.meta.canonical.clauses[1].schedule!;
      expect(schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: Unit.Day,
        treatmentStartOffsetDays: 3, eventWindow: { start: "WAKE", end: "HS" } });
      expect(schedule.timeOfDay).toBeUndefined(); expect(schedule.when).toBeUndefined();
      expect(schedule.offset).toBeUndefined(); expect(schedule.offsetMin).toBeUndefined(); expect(schedule.offsetMax).toBeUndefined();
      const input = freshWire(parsed.meta.canonical.course!, version), before = JSON.stringify(input);
      const query = { ...options, from: "2026-01-04T00:00:00Z", eventClock: { WAKE: "08:00", HS: "20:00", CM: "09:30" }, limit: 1 };
      expect(nextDueDoses(input, query)).toEqual(["2026-01-04T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      const reopened = allMembers(save(input))[1].schedule!.recurrence!;
      expect(reopened.eventWindow).toEqual({ start: "WAKE", end: "HS" });
      expect(reopened.clocks).toBeUndefined(); expect(reopened.anchors).toBeUndefined(); expect(reopened.offset).toBeUndefined();
      const noLocalWindow = parseSig(`Take 1 tablet ${timing} for 2 days then take 2 tablets from day 4`);
      const inherited = noLocalWindow.meta.canonical.clauses[1].schedule!;
      if (anchor === "clock") expect(inherited.timeOfDay).toEqual(["16:00:00"]);
      else expect(inherited).toMatchObject({ when: [EventTiming["Before Breakfast"]], offset: 30 });
      expect(JSON.stringify(input)).toBe(before);
    });

  it("reports unavailable Intl wall-clock parts instead of returning a wrong-zone dose", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"] } }, extension: [note] };
    const before = JSON.stringify(row), descriptor = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "formatToParts")!;
    Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", { ...descriptor, value: undefined });
    try {
      expect(() => nextDueDoses([row], { from: "2044-02-06T00:00:00Z", orderedAt: "2044-02-06T00:00:00Z",
        timeZone: "Asia/Bangkok", limit: 1 })).toThrow(/Intl.DateTimeFormat.*formatToParts/u);
      expect(() => calculateTotalUnits({ dosage: [row], from: "2044-02-07T00:00:00Z", orderedAt: "2044-02-07T00:00:00Z",
        timeZone: "Asia/Bangkok", durationValue: 1, durationUnit: Unit.Day })).toThrow(/Intl.DateTimeFormat.*formatToParts/u);
    } finally {
      Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", descriptor);
    }
    expect(nextDueDoses([row], { from: "2044-02-08T00:00:00Z", orderedAt: "2044-02-08T00:00:00Z",
      timeZone: "Asia/Bangkok", limit: 1 })).toEqual(["2044-02-08T08:00:00+07:00"]);
    expect(JSON.stringify(row)).toBe(before);
  });

  const intervalDue = [
    "2026-01-01T12:00:00+00:00", "2026-01-01T20:00:00+00:00",
    "2026-01-02T04:00:00+00:00", "2026-01-02T12:00:00+00:00", "2026-01-02T20:00:00+00:00",
    "2026-01-03T04:00:00+00:00", "2026-01-03T12:00:00+00:00", "2026-01-03T20:00:00+00:00",
    "2026-01-04T04:00:00+00:00",
  ];
  it.each(versions)("executes an immediate start on the existing eight-hour cadence without double counting (%s)", version => {
    const input = freshWire(parseSig("Take 1 tablet now and every 8 hours for 3 days").meta.canonical.course!, version);
    const before = JSON.stringify(input);
    expect(nextDueDoses(input, immediateOptions)).toEqual(intervalDue);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 72, durationUnit: Unit.Hour }).totalUnits).toBe(9);
    const later = { ...immediateOptions, from: "2026-01-02T00:00:00Z" };
    expect(nextDueDoses(input, later)).toEqual(intervalDue.slice(2));
    expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 48, durationUnit: Unit.Hour }).totalUnits).toBe(6);
    expect(allMembers(input)[0].schedule!.recurrence).toMatchObject({
      anchors: [EventTiming.Immediate], period: 8, periodUnit: Unit.Hour,
    });
    const reopened = save(input);
    expect(nextDueDoses(reopened, immediateOptions)).toEqual(intervalDue);
    expect(calculateTotalUnits({ dosage: reopened, ...later, durationValue: 48, durationUnit: Unit.Hour }).totalUnits).toBe(6);
    if (version !== "native") expect(reopened.step![0].component[0].extension).toContainEqual(note);
    const ordinary = freshWire(parseSig("Take 1 tablet every 8 hours for 3 days").meta.canonical.course!, version);
    expect(nextDueDoses(ordinary, immediateOptions)).toEqual(intervalDue);
    expect(calculateTotalUnits({ dosage: ordinary, ...immediateOptions, durationValue: 72, durationUnit: Unit.Hour }).totalUnits).toBe(9);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("counts prior interval administrations before a bounded immediate cadence (%s)", version => {
    const first = dose();
    first.schedule!.recurrence = { anchors: [EventTiming.Immediate], period: 8, periodUnit: Unit.Hour,
      count: 4, courseLength: { value: 3, unit: "d" } };
    const input = freshWire({ kind: "course", stages: [{ administrations: [first] }] }, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, immediateOptions)).toEqual(intervalDue.slice(0, 4));
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 72, durationUnit: Unit.Hour }).totalUnits).toBe(4);
    const later = { ...immediateOptions, from: "2026-01-02T00:00:00Z" };
    expect(nextDueDoses(input, later)).toEqual(intervalDue.slice(2, 4));
    expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 48, durationUnit: Unit.Hour }).totalUnits).toBe(2);
    const exhausted = { ...immediateOptions, from: "2026-01-02T13:00:00Z" };
    expect(nextDueDoses(input, exhausted)).toEqual([]);
    expect(calculateTotalUnits({ dosage: input, ...exhausted, durationValue: 48, durationUnit: Unit.Hour }).totalUnits).toBe(0);
    const reopened = save(input);
    expect(allMembers(reopened)[0].schedule!.recurrence!.count).toBe(4);
    expect(nextDueDoses(reopened, later)).toEqual(intervalDue.slice(2, 4));
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("retains the authored following phase after an immediate interval course (%s)", version => {
    const text = "Take 1 tablet now and every 8 hours for 3 days then take 2 tablets daily for 2 days";
    const input = freshWire(parseSig(text).meta.canonical.course!, version), before = JSON.stringify(input);
    const expected = [...intervalDue, "2026-01-05T09:00:00+00:00", "2026-01-06T09:00:00+00:00"];
    expect(nextDueDoses(input, immediateOptions)).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 72, durationUnit: Unit.Hour }).totalUnits).toBe(9);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(13);
    expect(nextDueDoses(save(input), immediateOptions)).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => ["start", "predecessor-end"].map(kind => ({ version, kind }))))(
    "uses an explicit treatment calendar boundary after an elapsed predecessor ($kind/$version)", ({ version, kind }) => {
      const first = dose(); first.schedule!.recurrence!.clocks = ["12:00:00"];
      first.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
      const second = dose(2); second.schedule!.recurrence = {
        frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["01:00:00", "03:00:00"], courseLength: { value: 1, unit: "d" },
      };
      const course: CanonicalCourse = { kind: "course", stages: [
        { start: relative(2, "h"), ...(kind === "predecessor-end" ? { end: relative(2) } : {}), administrations: [first] },
        { ...(kind === "start" ? { start: relative(2) } : {}), administrations: [second] },
      ] };
      const query = { from: "2026-03-07T02:30:00-05:00", orderedAt: "2026-03-07T02:30:00-05:00",
        timeZone: "America/New_York", limit: 12 };
      const expected = ["2026-03-07T12:00:00-05:00", "2026-03-09T03:00:00-04:00", "2026-03-10T01:00:00-04:00"];
      const input = freshWire(course, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(5);
      const reopened = save(input);
      expect(nextDueDoses(reopened, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: reopened, ...query, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(5);
      if (version !== "native") expect(reopened.step![0].component[0].extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    });
});


describe("round59 execution clinic clocks and predecessor ownership", () => {
  const versions = ["native", "r5", "r6"] as const;
  const persist = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const gts = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
  const note = { url: "urn:clinic:round59-execution-note", valueString: "retain independent source data" };
  const wardRows = (frequency = 2): FhirDosage[] => [{
    extension: [note],
    timing: { code: { coding: [
      { system: "urn:clinic:timing", code: "WARD", version: "clinic-1" },
      { system: gts, code: "BID" },
    ] }, repeat: { frequency, period: 1, periodUnit: Unit.Day } },
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
  }];
  const wardInput = (version: typeof versions[number], frequency = 2) => {
    const rows = wardRows(frequency);
    return version === "r5" ? rows : version === "r6" ? persist(toDosageDetails(rows)) : importCanonicalCourse(rows);
  };
  const member = (value = 1): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00"] } },
  });
  const qodCourse = (frequency: number, bounded = false): CanonicalCourse => ({
    kind: "course", stages: [{
      ...(bounded ? { end: { anchor: "treatment-day-start" as const, displacement: { value: 28, unit: "d" } } } : {}),
      administrations: [{
        ...member(), schedule: { code: { coding: [{ system: gts, code: "QOD" }] },
          recurrence: { frequency, period: frequency * 2, periodUnit: Unit.Day } },
      }],
    }],
  });
  const predecessorCourse = (kind: "duration" | "point" | "global"): CanonicalCourse => {
    const global = member(); global.schedule!.recurrence = { count: 1, clocks: ["08:00:00"] };
    const loading = member();
    loading.sourceMember = 0; loading.phasePredecessors = []; loading.phaseOrigin = { value: 9, unit: "h" };
    loading.schedule!.recurrence = kind === "point" ? { count: 1, clocks: ["09:00:00"] }
      : { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00"], courseLength: { value: 2, unit: "h" } };
    const next = member(2); next.schedule!.recurrence = { frequency: 1, period: 4, periodUnit: Unit.Hour, count: 2 };
    if (kind !== "global") { next.sourceMember = 1; next.phasePredecessors = [0]; }
    return { kind: "course", stages: [{ administrations: [global] },
      { administrations: kind === "global" ? [next] : [loading, next] }] };
  };
  const weekdayCourse = (explicit = false): CanonicalCourse => ({
    kind: "course", stages: [{ administrations: [{ ...member(), schedule: { recurrence: {
      dayOfWeek: [FhirDayOfWeek.Monday], frequency: 1, period: 1, periodUnit: Unit.Week, count: 2,
      ...(explicit ? { clocks: ["09:00:00"] } : {}),
    } } }] }],
  });
  const wire = (course: CanonicalCourse, version: typeof versions[number]) => {
    if (version === "native") return course;
    const input = persist(version === "r5" ? courseToR5(course) : courseToR6(course));
    const rows = Array.isArray(input) ? input : input.step!.flatMap(step => step.component);
    rows[0].extension = [...(rows[0].extension ?? []), note];
    return input;
  };
  const save = (input: Parameters<typeof importCanonicalCourse>[0]) => persist(toDosageDetails(
    persist(toFhirR5Dosages(input))
  ));
  const query = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 4 };
  const qodQuery = { ...query, from: "2026-01-01T12:00:00Z", orderedAt: "2026-01-01T12:00:00Z",
    limit: 16, frequencyDefaults: { byCode: { QOD: ["09:00"] } } };
  const qodDue = [
    "2026-01-03T09:00:00+00:00", "2026-01-05T09:00:00+00:00", "2026-01-07T09:00:00+00:00",
    "2026-01-09T09:00:00+00:00", "2026-01-11T09:00:00+00:00", "2026-01-13T09:00:00+00:00",
    "2026-01-15T09:00:00+00:00", "2026-01-17T09:00:00+00:00", "2026-01-19T09:00:00+00:00",
    "2026-01-21T09:00:00+00:00", "2026-01-23T09:00:00+00:00", "2026-01-25T09:00:00+00:00",
    "2026-01-27T09:00:00+00:00", "2026-01-29T09:00:00+00:00", "2026-01-31T09:00:00+00:00",
    "2026-02-02T09:00:00+00:00",
  ];

  it.each(versions)("uses compatible local clinic clocks while the standard coding owns cadence (%s)", version => {
    const input = wardInput(version), before = JSON.stringify(input);
    const local = { ...query, limit: 2, frequencyDefaults: { byCode: { WARD: ["07:00", "19:00"] } } };
    expect(nextDueDoses(input, local)).toEqual(["2026-01-01T07:00:00+00:00", "2026-01-01T19:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...local, durationValue: 7.5, durationUnit: Unit.Hour }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...local, frequencyDefaults: { byCode: {
      WARD: ["07:00", "19:00"], BID: ["07:30", "19:30"],
    } } })).toEqual(["2026-01-01T07:30:00+00:00", "2026-01-01T19:30:00+00:00"]);
    for (const frequencyDefaults of [{}, { byCode: { WARD: ["07:00"] } }])
      expect(nextDueDoses(input, { ...query, limit: 2, frequencyDefaults }))
        .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"]);
    const reopened = save(input);
    expect(importCanonicalCourse(reopened).stages[0].administrations[0].schedule!.code!.coding)
      .toEqual(wardRows()[0].timing!.code!.coding);
    expect(nextDueDoses(reopened, local)).toEqual(["2026-01-01T07:00:00+00:00", "2026-01-01T19:00:00+00:00"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("retains the existing explicit cadence conflict beside a local clock mapping (%s)", version => {
    const input = wardInput(version, 3), before = JSON.stringify(input);
    const live = { ...query, limit: 3, frequencyDefaults: { byCode: { WARD: ["07:00", "19:00"] } } };
    expect(() => nextDueDoses(input, live)).toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    expect(() => calculateTotalUnits({ dosage: input, ...live, durationValue: 1, durationUnit: Unit.Day }))
      .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    const current = importCanonicalCourse(save(input)).stages[0].administrations[0].schedule!;
    expect(current.recurrence).toMatchObject({ frequency: 3, period: 1, periodUnit: Unit.Day });
    expect(current.code!.coding).toEqual(wardRows()[0].timing!.code!.coding);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => [7, 14].map(frequency => ({ version, frequency }))))(
    "keeps every later alternate-day clinic slot in an aggregate QOD repeat ($frequency/$version)", ({ version, frequency }) => {
      const input = wire(qodCourse(frequency), version), before = JSON.stringify(input);
      expect(nextDueDoses(input, qodQuery)).toEqual(qodDue);
      const later = { ...qodQuery, from: "2026-01-15T00:00:00Z" };
      expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(7);
      expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 10, durationUnit: Unit.Hour }).totalUnits).toBe(1);
      expect(nextDueDoses(wire(qodCourse(1), version), qodQuery)).toEqual(qodDue);
      const reopened = save(input), recurrence = importCanonicalCourse(reopened).stages[0].administrations[0].schedule!.recurrence!;
      expect(recurrence).toMatchObject({ frequency, period: frequency * 2, periodUnit: Unit.Day });
      expect(nextDueDoses(reopened, qodQuery)).toEqual(qodDue);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("retains the exclusive course end and post-order lower bound for aggregate QOD (%s)", version => {
    const input = wire(qodCourse(7, true), version), before = JSON.stringify(input);
    expect(nextDueDoses(input, qodQuery)).toEqual(qodDue.slice(0, 13));
    expect(calculateTotalUnits({ dosage: input, ...qodQuery, durationValue: 40, durationUnit: Unit.Day }).totalUnits).toBe(13);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => (["duration", "point", "global"] as const).map(kind => ({ version, kind }))))(
    "uses the owned predecessor boundary before the global point ($kind/$version)", ({ version, kind }) => {
      const input = wire(predecessorCourse(kind), version), before = JSON.stringify(input);
      const expected = kind === "duration"
        ? ["2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00", "2026-01-01T11:00:00+00:00", "2026-01-01T15:00:00+00:00"]
        : kind === "point"
          ? ["2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00", "2026-01-01T13:00:00+00:00", "2026-01-01T17:00:00+00:00"]
          : ["2026-01-01T08:00:00+00:00", "2026-01-01T12:00:00+00:00", "2026-01-01T16:00:00+00:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      const from = kind === "duration" ? "2026-01-01T11:00:00Z" : kind === "point" ? "2026-01-01T13:00:00Z" : "2026-01-01T12:00:00Z";
      expect(calculateTotalUnits({ dosage: input, ...query, from, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(2);
      expect(nextDueDoses(save(input), query)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("keeps order milliseconds through clockless weekday schedule, supply and historical counting (%s)", version => {
    const input = wire(weekdayCourse(), version), before = JSON.stringify(input);
    const order = { ...query, from: "2026-01-05T09:00:00.500Z", orderedAt: "2026-01-05T09:00:00.500Z" };
    const expected = ["2026-01-05T09:00:00.500+00:00", "2026-01-12T09:00:00.500+00:00"];
    expect(nextDueDoses(input, order)).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...order, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    const later = { ...order, from: "2026-01-12T09:00:00.500Z" };
    expect(nextDueDoses(input, later)).toEqual(expected.slice(1));
    expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...later, priorDoseTimes: [expected[0]] })).toEqual(expected.slice(1));
    expect(nextDueDoses(input, { ...order, from: "2026-01-19T09:00:00.500Z" })).toEqual([]);
    const whole = { ...order, from: "2026-01-05T09:00:00Z", orderedAt: "2026-01-05T09:00:00Z" };
    expect(nextDueDoses(wire(weekdayCourse(), version), whole)).toEqual([
      "2026-01-05T09:00:00+00:00", "2026-01-12T09:00:00+00:00",
    ]);
    expect(nextDueDoses(wire(weekdayCourse(true), version), order)).toEqual([
      "2026-01-12T09:00:00+00:00", "2026-01-19T09:00:00+00:00",
    ]);
    expect(nextDueDoses(save(input), order)).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });
});


describe("round60 supported execution and quantity boundaries", () => {
  const versions = ["native", "R5", "R6"] as const;
  const persist = freshExecutionInput;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) => version === "native" ? course
    : persist(version === "R5" ? courseToR5(course) : courseToR6(course));
  const reopen = (input: ReturnType<typeof wire>) => persist(toDosageDetails(persist(courseToR5(importCanonicalCourse(input)))));
  const query = { ...options, limit: 4 };
  const delayed = (bounded: boolean) => courseFromAdministrations([{
    ...dose(), delayMinutes: 120,
    schedule: { recurrence: { frequency: 1, period: 6, periodUnit: Unit.Hour,
      ...(bounded ? { calendarWindow: { end: "2026-01-02T00:00:00Z" } } : {}) } },
  }], "One tablet every six hours beginning after two hours");
  // These extension-backed facts start as fresh wire submissions. Native
  // compilation is not an editing API for inventing absent wire annotations.
  const monthly = (clocks: string[], selected = true): CanonicalCourse => courseFromR6({ step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: clocks.length * 2, period: 1, periodUnit: Unit.Month, timeOfDay: clocks,
      ...(selected ? { extension: [1, 15].map(valuePositiveInt => ({
        url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt,
      })) } : {}) } },
  }] }] });
  const upper = (clocks: boolean): CanonicalCourse => courseFromR6({ step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequencyMax: 2, period: 1, periodUnit: Unit.Day,
      extension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-timing-frequency-min", valueInteger: 0 }],
      ...(clocks ? { timeOfDay: ["09:00:00"] } : {}) } },
  }] }] });
  const durationCourse = (kind: "equal elapsed" | "unequal elapsed" | "civil day"): CanonicalCourse => courseFromR6({
    step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }],
      timing: { repeat: { count: 1, timeOfDay: ["08:00:00"], extension: [{
        url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration", valueRange: {
          low: { value: kind === "civil day" ? 1 : 0.5, unit: "d" },
          high: { value: kind === "civil day" ? 24 : kind === "unequal elapsed" ? 13 : 12, unit: "h" },
        },
      }] } } }] }, { component: [{ doseAndRate: [{ doseQuantity: { value: 50, unit: "mL" } }],
      timing: { repeat: { count: 1, timeOfDay: ["22:00:00"] } } }] }],
  });
  const ratioCourse = (code: string): CanonicalCourse => ({ kind: "course", stages: [{ administrations: [{
    kind: "administration", amounts: [{ rateRatio: { numerator: { value: 100, unit: "mL" },
      denominator: { value: 60, unit: "infusion minutes", system: "http://unitsofmeasure.org", code } } }],
    schedule: { recurrence: { count: 1, clocks: ["08:00:00"], occurrenceDuration: 1, occurrenceDurationUnit: Unit.Hour } },
  }] }] });

  it.each(versions.flatMap(version => [false, true].map(bounded => ({ version, bounded }))))(
    "keeps the elapsed delay on the bounded and unbounded q6h grid ($bounded/$version)", ({ version, bounded }) => {
      const input = wire(delayed(bounded), version), before = JSON.stringify(input);
      const expected = ["2026-01-01T02:00:00+00:00", "2026-01-01T08:00:00+00:00",
        "2026-01-01T14:00:00+00:00", "2026-01-01T20:00:00+00:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(4);
      expect(nextDueDoses(reopen(input), query)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => [1, 2].map(clocks => ({ version, clocks }))))(
    "uses the authored first and fifteenth before monthly clock distribution ($clocks/$version)", ({ version, clocks }) => {
      const times = clocks === 1 ? ["09:00:00"] : ["09:00:00", "17:00:00"];
      const input = wire(monthly(times), version), before = JSON.stringify(input);
      const expected = ["2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15"]
        .flatMap(day => times.map(time => day + "T" + time + "+00:00"));
      expect(nextDueDoses(input, { ...query, limit: expected.length })).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Month }).totalUnits).toBe(2 * clocks);
      expect(nextDueDoses(reopen(input), { ...query, limit: expected.length })).toEqual(expected);
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence)
        .toMatchObject({ frequency: clocks * 2, period: 1, periodUnit: Unit.Month, monthDays: [1, 15], clocks: times });
      expect(nextDueDoses(wire(monthly(["09:00:00"], false), version), { ...query, limit: 2 }))
        .toEqual(["2026-01-01T09:00:00+00:00", "2026-01-16T09:00:00+00:00"]);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => [false, true].map(clocks => ({ version, clocks }))))(
    "counts the executable upper recurrence while retaining its zero minimum ($clocks/$version)", ({ version, clocks }) => {
      const input = wire(upper(clocks), version), before = JSON.stringify(input);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence)
        .toMatchObject({ frequency: 0, frequencyMax: 2, period: 1, periodUnit: Unit.Day });
      expect(calculateTotalUnits({ dosage: reopen(input), ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => (["equal elapsed", "unequal elapsed", "civil day"] as const).map(kind => ({ version, kind }))))(
    "resolves only equivalent elapsed infusion endpoints without rewriting their units ($kind/$version)", ({ version, kind }) => {
      const course = durationCourse(kind), input = wire(course, version), before = JSON.stringify(input);
      const expected = kind === "equal elapsed"
        ? ["2026-01-01T08:00:00+00:00", "2026-01-01T22:00:00+00:00"] : ["2026-01-01T08:00:00+00:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(kind === "equal elapsed" ? 150 : 100);
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange)
        .toMatchObject(course.stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange!);
      expect(nextDueDoses(reopen(input), query)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => ["min", "min{infusion}", "furlong"].map(code => ({ version, code }))))(
    "measures a recognized annotated time denominator and preserves unknown units ($code/$version)", ({ version, code }) => {
      const input = wire(ratioCourse(code), version), before = JSON.stringify(input);
      const calculate = (dosage: typeof input) => calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day });
      if (code === "furlong") expect(() => calculate(input)).toThrow(expect.objectContaining({ code: "rate-units-unresolved" }));
      else expect(calculate(input)).toMatchObject({ totalUnits: 100, unit: "mL" });
      const saved = reopen(input);
      expect(importCanonicalCourse(saved).stages[0].administrations[0].amounts![0].rateRatio!.denominator)
        .toMatchObject({ value: 60, unit: "infusion minutes", system: "http://unitsofmeasure.org", code });
      if (code !== "furlong") expect(calculate(saved)).toMatchObject({ totalUnits: 100, unit: "mL" });
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("completes a bare stat predecessor on its own parallel eye track (%s)", version => {
    const parsed = parseSig("1 drop OD stat then 2 drops OD daily at 10:00; 1 drop OS BID");
    const course = parsed.meta.canonical.course!, members = course.stages[0].administrations;
    expect(members[1].phasePredecessors).toEqual([members[0].sourceMember]);
    expect(members[1].phaseStart).toBeUndefined();
    const input = wire(course, version), before = JSON.stringify(input);
    const expected = ["2026-01-01T00:00:00+00:00", "2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00",
      "2026-01-01T20:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-02T10:00:00+00:00"];
    expect(nextDueDoses(input, { ...query, limit: 6 })).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(9);
    expect(nextDueDoses(reopen(input), { ...query, limit: 6 })).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => ["", "once "].map(once => ({ version, once }))))(
    "places the next morning after the single predecessor's actual day ($once/$version)", ({ version, once }) => {
      const source = "Take 1 tablet " + once + "at 22:00 and take 2 tablets the next morning";
      expect(createBoundaryPlan(source).relations).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "regimen.sequence" })]));
      const input = wire(parseSig(source).meta.canonical.course!, version), before = JSON.stringify(input);
      const lateOrder = { from: "2026-12-01T23:00:00Z", orderedAt: "2026-12-01T23:00:00Z", timeZone: "UTC",
        eventClock: { MORN: "08:00" }, limit: 3 };
      const expected = ["2026-12-02T22:00:00+00:00", "2026-12-03T08:00:00+00:00"];
      expect(nextDueDoses(input, lateOrder)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...lateOrder, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(3);
      expect(nextDueDoses(reopen(input), lateOrder)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it("keeps a daily predecessor outside the single-point next-morning construction", () => {
    const plan = createBoundaryPlan("Take 1 tablet daily at 22:00 and take 2 tablets the next morning");
    expect(plan.relations.some(relation => relation.rule === "regimen.sequence")).toBe(false);
  });
});


describe("round61 equivalent civil infusion endpoints", () => {
  const versions = ["native", "R5", "R6"] as const;
  const variants = [
    { name: "week/day", low: { value: 1, unit: "wk" }, high: { value: 7, unit: "d" }, exact: true },
    { name: "day/week", low: { value: 7, unit: "d" }, high: { value: 1, unit: "wk" }, exact: true },
    { name: "week/week", low: { value: 1, unit: "wk" }, high: { value: 1, unit: "wk" }, exact: true },
    { name: "day/day", low: { value: 7, unit: "d" }, high: { value: 7, unit: "d" }, exact: true },
    { name: "unequal civil bounds", low: { value: 1, unit: "wk" }, high: { value: 8, unit: "d" }, exact: false },
    { name: "civil day/elapsed hours", low: { value: 1, unit: "d" }, high: { value: 24, unit: "h" }, exact: false },
    { name: "civil week/elapsed hours", low: { value: 1, unit: "wk" }, high: { value: 168, unit: "h" }, exact: false },
  ];
  const query = {
    orderedAt: "2026-03-01T00:00:00-05:00", from: "2026-03-01T00:00:00-05:00",
    timeZone: "America/New_York", limit: 2,
  };
  for (const version of versions) for (const variant of variants) {
    it("preserves authored endpoints and resolves only equal civil intervals across DST (" + variant.name + "/" + version + ")", () => {
      const range = {
        low: { ...variant.low, id: "authored-lower-duration", extension: [
          { url: "urn:clinic:duration-note", valueString: "Keep this lower endpoint" },
        ] },
        high: { ...variant.high, id: "authored-upper-duration", extension: [
          { url: "urn:clinic:duration-note", valueString: "Keep this upper endpoint" },
        ] },
      };
      const course = courseFromR6({
        step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }],
          timing: { repeat: { count: 1, timeOfDay: ["08:00:00"], extension: [{
            url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
            valueRange: range,
          }] } },
        }] }, { component: [{ doseAndRate: [{ doseQuantity: { value: 50, unit: "mL" } }],
          timing: { repeat: { count: 1, timeOfDay: ["22:00:00"] } },
        }] }],
      });
      const input = version === "native" ? course
        : freshExecutionInput(version === "R5" ? courseToR5(course) : courseToR6(course));
      const before = JSON.stringify(input);
      const expected = variant.exact
        ? ["2026-03-01T08:00:00-05:00", "2026-03-08T22:00:00-04:00"]
        : ["2026-03-01T08:00:00-05:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 8, durationUnit: Unit.Day }).totalUnits)
        .toBe(variant.exact ? 150 : 100);
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange)
        .toEqual(range);
      const saved = freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));
      expect(nextDueDoses(saved, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: saved, ...query, durationValue: 8, durationUnit: Unit.Day }).totalUnits)
        .toBe(variant.exact ? 150 : 100);
      expect(importCanonicalCourse(saved).stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange)
        .toEqual(range);
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});

describe("round61 zero-minimum compatible timing codes", () => {
  const versions = ["native", "R5", "R6"] as const;
  const ranges = [
    { minimum: 0, maximum: 2 },
    { minimum: 1, maximum: 2 },
    { minimum: 0, maximum: 1 },
  ];
  const query = { ...options, limit: 2 };
  for (const version of versions) {
    for (const { minimum, maximum } of ranges) {
      it("executes BID only inside the authored frequency range (" + minimum + "-" + maximum + "/" + version + ")", () => {
        const code = { coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID",
        }] };
        const course = courseFromR6({ step: [{ component: [{
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { code, repeat: { frequencyMax: maximum, period: 1, periodUnit: Unit.Day,
            ...(minimum === 0 ? { extension: [{
              url: "urn:ezmedicationinput:StructureDefinition:medication-timing-frequency-min", valueInteger: 0,
            }] } : { frequency: minimum }),
          } },
        }] }] });
        const input = version === "native" ? course
          : freshExecutionInput(version === "R5" ? courseToR5(course) : courseToR6(course));
        const before = JSON.stringify(input);
        const saved = freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));
        for (const dosage of [input, saved]) {
          if (maximum === 1) {
            expect(() => nextDueDoses(dosage, query))
              .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
            expect(() => calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
              .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
          } else {
            expect(nextDueDoses(dosage, query))
              .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"]);
            expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
              .toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
          }
          expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule)
            .toMatchObject({ code, recurrence: {
              frequency: minimum, frequencyMax: maximum, period: 1, periodUnit: Unit.Day,
            } });
        }
        expect(JSON.stringify(input)).toBe(before);
      });
    }
  }
});

describe("round61 PRN history, bare hourly codes and immediate supply", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (member: CanonicalAdministration, version: typeof versions[number]) => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    return version === "native" ? course
      : freshExecutionInput(version === "R5" ? courseToR5(course) : courseToR6(course));
  };
  const reopen = (input: ReturnType<typeof wire>) =>
    freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));
  const start = "2026-01-03T00:00:00Z";
  const query = { orderedAt: start, from: start, timeZone: "UTC" };

  const untimed = (calendar = false) => courseFromR6({ step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], asNeeded: true,
    timing: { repeat: { countMax: 2, ...(calendar ? { boundsPeriod: { start: "2026-01-03" } } : {}),
      extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
        { url: "max", valueInteger: 1 },
        { url: "period", valueQuantity: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org" } },
      ] }],
    } },
  }] }] }).stages[0].administrations[0];

  for (const version of versions) {
    it("counts only current-order records against untimed PRN allowance (" + version + ")", () => {
      for (const calendar of [false, true]) {
        const member = untimed(calendar);
        const input = wire(member, version);
        const local = { ...query, orderedAt: calendar ? origin : start };
        for (const dosage of [input, reopen(input)]) {
          const calculate = (extra = {}) => calculateTotalUnits({
            dosage, ...local, durationValue: 2, durationUnit: Unit.Day, ...extra,
          }).totalUnits;
          expect(calculate()).toBe(2);
          expect(calculate({ priorDoseTimes: ["2026-01-02T12:00:00Z"] })).toBe(2);
          expect(calculate({ priorDoseTimes: ["2026-01-02T12:00:00Z"], priorCount: 1 })).toBe(1);
          expect(calculate({ priorDoseTimes: ["2026-01-02T12:00:00Z"], priorCount: 0 })).toBe(2);
          expect(calculate({ from: "2026-01-04T00:00:00Z",
            priorDoseTimes: ["2026-01-02T12:00:00Z", "2026-01-03T09:00:00Z"] })).toBe(1);
        }
      }
    });

    it("retains pre-order history for rolling PRN limits (" + version + ")", () => {
      const member: CanonicalAdministration = {
        ...untimed(),
        limits: [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 24, unit: "h" } }],
      };
      const input = wire(member, version);
      for (const dosage of [input, reopen(input)]) {
        const supply = { dosage, ...query, durationValue: 12, durationUnit: Unit.Hour };
        expect(calculateTotalUnits(supply).totalUnits).toBe(1);
        expect(calculateTotalUnits({ ...supply, priorDoseTimes: ["2026-01-02T20:00:00Z"] }).totalUnits).toBe(0);
      }
    });

    for (const variant of ["bare", "explicit events", "local code"] as const) {
      it("executes only recognized bare hourly cadence with event ownership (" + variant + "/" + version + ")", () => {
        const code = { coding: [{ code: "Q4H",
          ...(variant === "local code" ? { system: "urn:clinic:local-timing" } : {}),
        }] };
        const events = ["2026-01-03T03:00:00Z", "2026-01-03T13:00:00Z"];
        const input = wire({ ...dose(), schedule: { code,
          ...(variant === "explicit events" ? { explicitEvents: events } : {}),
        } }, version);
        for (const dosage of [input, reopen(input)]) {
          if (variant === "local code") {
            expect(nextDueDoses(dosage, { ...query, limit: 6 })).toEqual([]);
            expect(() => calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
              .toThrow(expect.objectContaining({ code: "timing-required" }));
          } else {
            const clocks = variant === "bare" ? ["00", "04", "08", "12", "16", "20"] : ["03", "13"];
            expect(nextDueDoses(dosage, { ...query, limit: 6 }))
              .toEqual(clocks.map(hour => "2026-01-03T" + hour + ":00:00+00:00"));
            expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
              .toBe(clocks.length);
          }
          expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule)
            .toMatchObject({ code, ...(variant === "explicit events" ? { explicitEvents: events } : {}) });
        }
      });
    }

    for (const variant of ["coincident", "distinct", "counted"] as const) {
      it("counts immediate and inferred administrations once (" + variant + "/" + version + ")", () => {
        const member = { ...dose(), schedule: { recurrence: {
          anchors: [EventTiming.Immediate], frequency: 2,
          period: variant === "distinct" ? 1 : 24, periodUnit: variant === "distinct" ? Unit.Day : Unit.Hour,
          ...(variant === "counted" ? { count: 2 } : {}),
        } } };
        const input = wire(member, version);
        const stamp = "2026-01-03T" + (variant === "coincident" ? "08" : "07") + ":00:00Z";
        const local = { orderedAt: stamp, from: stamp, timeZone: "UTC" };
        const clocks = variant === "coincident" ? ["08", "20"] : variant === "distinct" ? ["07", "08", "20"] : ["07", "19"];
        for (const dosage of [input, reopen(input)]) {
          expect(nextDueDoses(dosage, { ...local, limit: clocks.length }))
            .toEqual(clocks.map(hour => "2026-01-03T" + hour + ":00:00+00:00"));
          expect(calculateTotalUnits({ dosage, ...local, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
            .toBe(clocks.length);
        }
      });
    }
  }
});

describe("round61 distinct-target typed NEXT ownership", () => {
  const query = { orderedAt: "2026-12-01T23:00:00Z", from: "2026-12-01T23:00:00Z", timeZone: "UTC", limit: 2 };
  for (const version of ["native", "R5", "R6"] as const) {
    for (const next of [true, false]) {
      it("preserves an explicit next-day sequence across eye targets (" + next + "/" + version + ")", () => {
        const parsed = parseSig("Instill 1 drop in the right eye at 22:00 and instill 2 drops in the left eye at 06:00" +
          (next ? " the next morning" : ""));
        const input = version === "native" ? parsed.meta!.canonical!.course!
          : freshExecutionInput(version === "R5" ? parsed.fhir : parsed.fhirNext);
        const saved = freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));
        for (const dosage of [input, saved]) {
          const members = importCanonicalCourse(dosage).stages.flatMap(stage => stage.administrations);
          expect(members.map(member => ({
            eye: member.target?.text, amount: { value: member.amounts?.[0].quantity?.value, unit: member.amounts?.[0].quantity?.unit },
            clocks: member.schedule?.recurrence?.clocks,
          }))).toEqual([
            { eye: "right eye", amount: { value: 1, unit: "drop" }, clocks: ["22:00:00"] },
            { eye: "left eye", amount: { value: 2, unit: "drop" }, clocks: ["06:00:00"] },
          ]);
          expect(nextDueDoses(dosage, query)).toEqual(next
            ? ["2026-12-02T22:00:00+00:00", "2026-12-03T06:00:00+00:00"]
            : ["2026-12-02T06:00:00+00:00", "2026-12-02T22:00:00+00:00"]);
          if (next)
            expect(calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(3);
        }
      });
    }
  }
});

describe("round62 coded cadence with independent constraints", () => {
  const versions = ["native", "R5", "R6"] as const;
  const note = { url: "urn:clinic:timing-note", valueString: "Keep the prescribed timing" };
  const query = { ...options, limit: 5 };
  const wire = (source: FhirR6DosageInstruction, version: typeof versions[number]) => {
    const course = courseFromR6(source);
    return version === "native" ? course
      : freshExecutionInput(version === "R5" ? courseToR5(course) : source);
  };
  const reopen = (input: ReturnType<typeof wire>) =>
    freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));

  for (const version of versions) {
    for (const kind of ["count", "maximum", "window", "BID", "event", "local"] as const) {
      it("retains independent constraints on a coded cadence (" + kind + "/" + version + ")", () => {
        const repeat = {
          ...(kind === "window" ? { boundsPeriod: { start: "2026-01-01T08:00:00Z", end: "2026-01-01T17:00:00Z" } }
            : kind === "maximum" ? { countMax: 3 } : { count: kind === "event" ? 1 : 3 }),
          extension: [note],
        };
        const code = { coding: [{
          system: kind === "local" ? "urn:clinic:local-timing" : "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation",
          code: kind === "BID" ? "BID" : "Q4H",
        }] };
        const input = wire({ step: [{ component: [{
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { code, repeat, ...(kind === "event" ? { event: ["2026-01-01T13:00:00Z"] } : {}) },
        }] }] }, version);
        const expected = kind === "window"
          ? ["2026-01-01T08:00:00+00:00", "2026-01-01T12:00:00+00:00", "2026-01-01T16:00:00+00:00"]
          : kind === "BID"
          ? ["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00", "2026-01-02T08:00:00+00:00"]
          : kind === "event" ? ["2026-01-01T13:00:00+00:00"]
          : ["2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00", "2026-01-01T08:00:00+00:00"];
        for (const dosage of [input, reopen(input)]) {
          const before = JSON.stringify(dosage);
          if (kind === "local") {
            expect(nextDueDoses(dosage, query)).toEqual([]);
            expect(() => calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Day }))
              .toThrow(expect.objectContaining({ code: "timing-required" }));
          } else {
            expect(nextDueDoses(dosage, query)).toEqual(expected);
            expect(calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Day }))
              .toMatchObject({ totalUnits: kind === "event" ? 1 : 3, unit: "tab",
                ...(kind === "maximum" ? { quantityKind: "maximum" } : {}),
              });
          }
          const timing = courseToR5(importCanonicalCourse(dosage))[0].timing!;
          expect(timing.code).toEqual(code);
          expect(timing.repeat).toMatchObject(repeat);
          expect(timing.repeat?.frequency).toBeUndefined();
          expect(timing.repeat?.period).toBeUndefined();
          expect(JSON.stringify(dosage)).toBe(before);
        }
      });
    }

    it("opens a successor only after the counted coded loading course (" + version + ")", () => {
      const input = wire({ step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { code: { coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "Q4H",
        }] }, repeat: { count: 3 } },
      }] }, { component: [{
        doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
        timing: { repeat: { count: 1, timeOfDay: ["10:00:00"] } },
      }] }] }, version);
      for (const dosage of [input, reopen(input)]) {
        expect(nextDueDoses(dosage, query)).toEqual([
          "2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00",
          "2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(5);
        const later = { ...query, from: "2026-01-01T05:00:00Z" };
        expect(nextDueDoses(dosage, later))
          .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage, ...later, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
      }
    });
  }
});


describe("round62 review execution and phase boundaries", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : freshExecutionInput(version === "R5" ? courseToR5(course) : courseToR6(course));
  const reopen = (input: ReturnType<typeof wire>) =>
    freshExecutionInput(toDosageDetails(freshExecutionInput(courseToR5(importCanonicalCourse(input)))));

  for (const version of versions) {
    for (const next of [false, true]) {
      it("keeps a paused NEXT origin separate from a treatment-day adjustment (" + next + "/" + version + ")", () => {
        const source = "Take 1 tablet daily at 09:00 for 5 days, then HOLD for 2 days, then take 2 tablets " +
          (next ? "the next morning " : "") + "daily at 09:00, then increase to 3 tablets daily at 09:00 from day 10";
        const parsed = parseSig(source);
        expect(parsed.meta.canonical.clauses.map(clause => clause.dose)).toEqual([
          { value: 1, unit: "tab" }, { value: 2, unit: "tab" }, { value: 3, unit: "tab" },
        ]);
        const middle = parsed.meta.canonical.clauses[1].schedule!;
        expect(middle.treatmentStartOffsetDays).toBe(next ? 2 : 7);
        expect(middle.phaseStartReference).toBe(next ? "previous-phase-next-day" : undefined);
        expect(middle.duration).toBe(next ? undefined : 2);
        const input = wire(parsed.meta.canonical.course!, version), before = JSON.stringify(input);
        const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 10 };
        const expected = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12].map(day =>
          "2026-12-" + String(day).padStart(2, "0") + "T09:00:00+00:00");
        for (const dosage of [input, reopen(input)]) {
          expect(importCanonicalCourse(dosage).stages.map(stage => stage.administrations.map(member => ({
            amount: member.amounts?.[0].quantity?.value, frequency: member.schedule?.recurrence?.frequency,
            clocks: member.schedule?.recurrence?.clocks,
          })))).toEqual([1, 2, 3].map(amount => [{ amount, frequency: 1, clocks: ["09:00:00"] }]));
          expect(nextDueDoses(dosage, query)).toEqual(expected);
          expect(calculateTotalUnits({ dosage, ...query, durationValue: 12, durationUnit: Unit.Day }).totalUnits).toBe(18);
          expect(calculateTotalUnits({ dosage, ...query, from: "2026-12-10T00:00:00Z",
            durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
        }
        expect(JSON.stringify(input)).toBe(before);
      });
    }

    it("compares clockless frequency defaults through the chronological caps (" + version + ")", () => {
      const member: CanonicalAdministration = { ...dose(),
        schedule: { recurrence: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
          courseLength: { value: 2, unit: "d" } } },
        limits: [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 24, unit: "h" } }],
      };
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
        stages: [{ administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      for (const dosage of [input, reopen(input)]) {
        expect(calculateTotalUnits({ dosage, ...options, from: "2026-01-01T08:30:00Z",
          durationValue: 1, durationUnit: Unit.Hour })).toMatchObject({ totalUnits: 1, unit: "tab" });
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
        expect(calculateTotalUnits({ dosage, ...options, from: "2026-01-02T00:00:00Z",
          durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(4);
        expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule?.recurrence)
          .toMatchObject({ frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day });
      }
      expect(JSON.stringify(input)).toBe(before);
    });

    for (const kind of ["selected", "same-day fence", "unanchored"] as const) {
      it("lets the monthly selector own the successor date (" + kind + "/" + version + ")", () => {
        const selected = kind !== "unanchored", firstDay = kind === "same-day fence" ? "15" : "10";
        const source: FhirR6DosageInstruction = { step: [
          { component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: { repeat: { count: 1, timeOfDay: ["09:00:00"] } } }] },
          { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
            timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Month,
              ...(selected ? { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth",
                valuePositiveInt: 15 }] } : {}) } } }] },
        ] };
        const input = wire(courseFromR6(source), version), before = JSON.stringify(input);
        const query = { orderedAt: "2026-01-" + firstDay + "T00:00:00Z",
          from: "2026-01-" + firstDay + "T00:00:00Z", timeZone: "UTC", limit: 3 };
        const expected = ["2026-01-" + firstDay + "T09:00:00+00:00",
          ...(kind === "selected" ? ["2026-01-15T09:00:00+00:00", "2026-02-15T09:00:00+00:00"]
            : kind === "same-day fence" ? ["2026-02-15T09:00:00+00:00", "2026-03-15T09:00:00+00:00"]
            : ["2026-02-10T09:00:00+00:00", "2026-03-10T09:00:00+00:00"])];
        for (const dosage of [input, reopen(input)]) {
          expect(nextDueDoses(dosage, query)).toEqual(expected);
          expect(calculateTotalUnits({ dosage, ...query, from: "2026-01-15T00:00:00Z",
            durationValue: 1, durationUnit: Unit.Day }).totalUnits)
            .toBe(kind === "selected" ? 2 : kind === "same-day fence" ? 1 : 0);
          const members = importCanonicalCourse(dosage).stages.map(stage => stage.administrations[0]);
          expect(members.map(member => member.amounts?.[0].quantity?.value)).toEqual([1, 2]);
          expect(members[1].schedule?.recurrence?.monthDays).toEqual(selected ? [15] : undefined);
        }
        expect(JSON.stringify(input)).toBe(before);
      });
    }

    it("renders bounded and unresolved member ends without indefinite continuation (" + version + ")", () => {
      for (const anchor of ["treatment-start", "treatment-day-start"] as const) {
        const start: CanonicalBoundary = { anchor, displacement: { value: 1, unit: "d" } };
        const end: CanonicalBoundary = { anchor, displacement: { value: 3, unit: "d" } };
        const course = (ending: CanonicalBoundary | undefined): CanonicalCourse => ({
          kind: "course", stages: [{ administrations: [{ ...dose(), phaseStart: start, phaseEnd: ending }] }],
        });
        const input = wire(course(end), version), before = JSON.stringify(input);
        const originEn = anchor === "treatment-start" ? "treatment start" : "the start of the first treatment day";
        const originTh = anchor === "treatment-start" ? "เริ่มการรักษา" : "ต้นวันแรกของการรักษา";
        for (const dosage of [input, reopen(input)]) {
          expect(formatSig(dosage, "long", { locale: "en" })).toBe(
            "From 1 day after " + originEn + " until 3 days after " + originEn +
            ": Use 1 tablet once daily at 9:00 am.");
          expect(formatSig(dosage, "long", { locale: "th" })).toBe(
            "ตั้งแต่1 วันหลัง" + originTh + "จนถึง3 วันหลัง" + originTh +
            ": ใช้ครั้งละ 1 เม็ด วันละครั้ง เวลา 09:00.");
          expect(nextDueDoses(dosage, { ...options, limit: 4 })).toEqual([
            "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
          ]);
          expect(calculateTotalUnits({ dosage, ...options, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(2);
        }
        expect(JSON.stringify(input)).toBe(before);
        const open = wire(course(undefined), version);
        expect(formatSig(open, "long", { locale: "en" })).toContain(" onward");
        expect(formatSig(open, "long", { locale: "th" })).toContain("เป็นต้นไป");
        const unresolved = wire(course({ anchor: "unresolved", description: "pending clinical review" }), version);
        for (const dosage of [unresolved, reopen(unresolved)]) {
          const en = formatSig(dosage, "long", { locale: "en" });
          const th = formatSig(dosage, "long", { locale: "th" });
          expect(en).not.toContain("onward");
          expect(en).toContain("End timing requires review: pending clinical review");
          expect(en).toContain("Use 1 tablet once daily at 9:00 am.");
          expect(th).not.toContain("เป็นต้นไป");
          expect(th).toContain("ต้องตรวจสอบเวลาสิ้นสุด: pending clinical review");
          expect(importCanonicalCourse(dosage).stages[0].administrations[0].phaseEnd?.description)
            .toBe("pending clinical review");
        }
      }
    });

    it("qualifies the civil-day successor after an equal ranged predecessor end (" + version + ")", () => {
      const course: CanonicalCourse = { kind: "course", stages: [
        { end: { anchor: "treatment-day-start", displacementRange: {
          low: { value: 3, unit: "d" }, high: { value: 3, unit: "d" },
        } }, administrations: [dose()] },
        { end: { anchor: "treatment-day-start", displacement: { value: 7, unit: "d" } },
          administrations: [dose(2)] },
      ] };
      const input = wire(course, version), before = JSON.stringify(input);
      for (const dosage of [input, reopen(input)]) {
        expect(formatSig(dosage, "long", { locale: "en" })).toContain(
          "After the previous phase; Through day 7: Use 2 tablets once daily at 9:00 am.");
        expect(formatSig(dosage, "long", { locale: "th" })).toContain(
          "หลังขั้นตอนก่อนหน้า; ถึงวันที่ 7: ใช้ครั้งละ 2 เม็ด วันละครั้ง เวลา 09:00.");
        expect(nextDueDoses(dosage, { ...options, limit: 8 })).toEqual(
          [1, 2, 3, 4, 5, 6, 7].map(day => "2026-01-0" + day + "T09:00:00+00:00"));
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(11);
        expect(importCanonicalCourse(dosage).stages.map(stage => stage.administrations[0].amounts?.[0].quantity?.value))
          .toEqual([1, 2]);
      }
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});
