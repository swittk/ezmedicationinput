import { describe, expect, it } from "vitest";
import { nextDueDoses, calculateTotalUnits, toDosageDetails, toFhirR5Dosages } from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { TIMING_EVENT_WINDOW_EXTENSION_URL } from "../src/fhir";
import {
  EventTiming, FhirDosage, FhirR6DosageDetails, NextDueDoseOptions,
  FhirPeriodUnit, FhirDayOfWeek
} from "../src/types";

const EVENT_CLOCK = {
  [EventTiming.Morning]: "08:00",
  [EventTiming.Noon]: "12:00",
  [EventTiming.Afternoon]: "15:00",
  [EventTiming.Evening]: "18:00",
  [EventTiming.Night]: "22:00",
  [EventTiming["Before Sleep"]]: "22:00",
  [EventTiming.Breakfast]: "08:00",
  [EventTiming.Lunch]: "12:30",
  [EventTiming.Dinner]: "18:30"
};

const MEAL_OFFSETS = {
  [EventTiming["Before Meal"]]: -30,
  [EventTiming["After Meal"]]: 30,
  [EventTiming["After Breakfast"]]: 30,
  [EventTiming["After Lunch"]]: 30,
  [EventTiming["After Dinner"]]: 30
};

const BASE_OPTIONS = {
  timeZone: "UTC",
  eventClock: EVENT_CLOCK,
  mealOffsets: MEAL_OFFSETS
} as const satisfies Pick<NextDueDoseOptions, "timeZone" | "eventClock" | "mealOffsets">;

/**
 * Adds a duration to an ISO timestamp in UTC for deterministic test windows.
 *
 * @param fromIso ISO timestamp baseline.
 * @param value Duration magnitude.
 * @param unit Duration unit.
 * @returns End timestamp in UTC.
 */
function addDurationUtc(fromIso: string, value: number, unit: FhirPeriodUnit): Date {
  const from = new Date(fromIso);
  const next = new Date(from.getTime());
  if (unit === FhirPeriodUnit.Second) next.setUTCSeconds(next.getUTCSeconds() + value);
  else if (unit === FhirPeriodUnit.Minute) next.setUTCMinutes(next.getUTCMinutes() + value);
  else if (unit === FhirPeriodUnit.Hour) next.setUTCHours(next.getUTCHours() + value);
  else if (unit === FhirPeriodUnit.Day) next.setUTCDate(next.getUTCDate() + value);
  else if (unit === FhirPeriodUnit.Week) next.setUTCDate(next.getUTCDate() + value * 7);
  else if (unit === FhirPeriodUnit.Month) next.setUTCMonth(next.getUTCMonth() + value);
  else if (unit === FhirPeriodUnit.Year) next.setUTCFullYear(next.getUTCFullYear() + value);
  return next;
}

/**
 * Uses `nextDueDoses` as a generation oracle to count doses within a finite window.
 *
 * @param dosage Dosage schedule to expand.
 * @param from Inclusive window start.
 * @param durationValue Window size magnitude.
 * @param durationUnit Window size unit.
 * @returns Number of generated doses inside `[from, end)`.
 */
function expectedCountFromGenerator(
  dosage: FhirDosage,
  from: string,
  durationValue: number,
  durationUnit: FhirPeriodUnit
): number {
  const start = new Date(from);
  const end = addDurationUtc(from, durationValue, durationUnit);
  const windowDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
  );
  const limit = Math.min(2000, Math.max(256, windowDays * 24));
  const generated = nextDueDoses(dosage, {
    ...BASE_OPTIONS,
    orderedAt: from,
    from,
    limit
  });
  return generated.filter((iso) => {
    const at = new Date(iso);
    return at >= start && at < end;
  }).length;
}

describe("nextDueDoses", () => {
  it("anchors to explicit meal timings", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          when: [
            EventTiming["After Breakfast"],
            EventTiming["After Lunch"],
            EventTiming["After Dinner"],
            EventTiming["Before Sleep"]
          ]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-01T10:00:00Z",
      limit: 4
    });

    expect(results).toEqual([
      "2024-01-01T13:00:00+00:00",
      "2024-01-01T19:00:00+00:00",
      "2024-01-01T22:00:00+00:00",
      "2024-01-02T08:30:00+00:00"
    ]);
  });

  it("handles q6h interval stepping", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 6,
          periodUnit: FhirPeriodUnit.Hour
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:05:00Z",
      from: "2024-01-01T10:00:00Z",
      limit: 4
    });

    expect(results).toEqual([
      "2024-01-01T15:05:00+00:00",
      "2024-01-01T21:05:00+00:00",
      "2024-01-02T03:05:00+00:00",
      "2024-01-02T09:05:00+00:00"
    ]);
  });

  it("stops generating interval doses once the count limit is met", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 1,
          periodUnit: FhirPeriodUnit.Hour,
          count: 3
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-01T09:00:00Z",
      limit: 10
    });

    expect(results).toEqual([
      "2024-01-01T09:00:00+00:00",
      "2024-01-01T10:00:00+00:00",
      "2024-01-01T11:00:00+00:00"
    ]);
  });

  it("caps future generation at the parsed dosage duration window", () => {
    const parsed = parseSig("1 tab po od for 7 days", { context: { dosageForm: "tab" } });

    const results = nextDueDoses(parsed.fhir, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-05T00:00:00Z",
      limit: 10
    });

    expect(results).toEqual([
      "2024-01-05T09:00:00+00:00",
      "2024-01-06T09:00:00+00:00",
      "2024-01-07T09:00:00+00:00"
    ]);
  });

  it("caps future generation for month-based duration windows", () => {
    const parsed = parseSig("1 tab po monthly for 2 months", {
      context: { dosageForm: "tab" }
    });

    const results = nextDueDoses(parsed.fhir, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-15T00:00:00Z",
      limit: 10
    });

    expect(results).toEqual([
      "2024-02-01T09:00:00+00:00"
    ]);
  });

  it("respects doses consumed before the evaluation window when priorCount is provided", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          count: 5
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-04T09:00:00Z",
      priorCount: 3,
      limit: 5
    });

    expect(results).toEqual([
      "2024-01-04T09:00:00+00:00",
      "2024-01-05T09:00:00+00:00"
    ]);
  });

  it("respects doses consumed before the evaluation window when priorCount is not provided", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          count: 8,
          timeOfDay: ['08:00', '16:00']
        },
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-03T12:00:00Z",
      limit: 5
    });

    expect(results).toEqual([
      "2024-01-03T16:00:00+00:00",
      "2024-01-04T08:00:00+00:00",
      "2024-01-04T16:00:00+00:00",
    ]);
  });

  it("respects doses entirely consumed before the evaluation window when priorCount is not provided", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          count: 8,
          timeOfDay: ['08:00', '16:00']
        },
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-05T12:00:00Z",
      limit: 5
    });

    expect(results).toEqual([]);
  });

  it("uses frequency defaults when no timing anchors exist", () => {
    const dosage: FhirDosage = {
      timing: {
        code: { coding: [{ code: "BID" }] },
        repeat: {
          frequency: 2,
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-01T05:00:00Z",
      limit: 4
    });

    expect(results).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T20:00:00+00:00",
      "2024-01-02T08:00:00+00:00",
      "2024-01-02T20:00:00+00:00"
    ]);
  });

  it("infers default clocks for unsupported daily frequency schedules", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          frequency: 5,
          period: 1,
          periodUnit: FhirPeriodUnit.Day
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-01T05:00:00Z",
      limit: 5
    });

    expect(results).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T11:00:00+00:00",
      "2024-01-01T14:00:00+00:00",
      "2024-01-01T17:00:00+00:00",
      "2024-01-01T20:00:00+00:00"
    ]);
  });

  it("falls back to frequency defaults when when anchors cannot be resolved", () => {
    const dosage: FhirDosage = {
      timing: {
        code: { coding: [{ code: "BID" }] },
        repeat: {
          frequency: 2,
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          when: [EventTiming["After Breakfast"], EventTiming["After Dinner"]]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      timeZone: "utc",
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-01T05:00:00Z",
      limit: 4
    });

    expect(results).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T20:00:00+00:00",
      "2024-01-02T08:00:00+00:00",
      "2024-01-02T20:00:00+00:00"
    ]);
  });

  it("derives prior count from frequency defaults when when anchors cannot be resolved", () => {
    const dosage: FhirDosage = {
      timing: {
        code: { coding: [{ code: "BID" }] },
        repeat: {
          count: 8,
          frequency: 2,
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          when: [EventTiming["After Breakfast"], EventTiming["After Dinner"]]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      timeZone: "utc",
      orderedAt: "2024-01-01T00:00:00Z",
      from: "2024-01-03T12:00:00Z",
      limit: 5
    });

    expect(results).toEqual([
      "2024-01-03T20:00:00+00:00",
      "2024-01-04T08:00:00+00:00",
      "2024-01-04T20:00:00+00:00"
    ]);
  });

  it("expands generic AC tokens using meal offsets", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          when: [EventTiming["Before Meal"]]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T07:00:00Z",
      from: "2024-01-01T07:15:00Z",
      limit: 3
    });

    expect(results).toEqual([
      "2024-01-01T07:30:00+00:00",
      "2024-01-01T12:00:00+00:00",
      "2024-01-01T18:00:00+00:00"
    ]);
  });

  it("applies explicit FHIR event offsets in the direction encoded by when", () => {
    const beforeMeal = parseSig("กินก่อนอาหารครึ่งชั่วโมง", { locale: "th" });
    expect(nextDueDoses(beforeMeal.fhir, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T06:00:00Z",
      from: "2024-01-01T07:00:00Z",
      limit: 3
    })).toEqual([
      "2024-01-01T07:30:00+00:00",
      "2024-01-01T12:00:00+00:00",
      "2024-01-01T18:00:00+00:00"
    ]);

    const afterMeal = parseSig("กินหลังอาหาร 1 ชั่วโมง", { locale: "th" });
    expect(nextDueDoses(afterMeal.fhir, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T06:00:00Z",
      from: "2024-01-01T07:00:00Z",
      limit: 3
    })).toEqual([
      "2024-01-01T09:00:00+00:00",
      "2024-01-01T13:30:00+00:00",
      "2024-01-01T19:30:00+00:00"
    ]);
  });

  it("respects count limits for anchored event timings", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          when: [EventTiming.Breakfast, EventTiming.Dinner],
          count: 2
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T06:00:00Z",
      from: "2024-01-01T07:00:00Z",
      limit: 5
    });

    expect(results).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T18:30:00+00:00"
    ]);
  });

  it("respects weekly intervals and day filters", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 1,
          periodUnit: FhirPeriodUnit.Week,
          dayOfWeek: [FhirDayOfWeek.Monday]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-03T00:00:00Z",
      limit: 3
    });

    expect(results).toEqual([
      "2024-01-08T09:00:00+00:00",
      "2024-01-15T09:00:00+00:00",
      "2024-01-22T09:00:00+00:00"
    ]);
  });

  it("treats bare day-of-week schedules as weekly recurrences", () => {
    const parsed = parseSig("1 tab po every monday", { context: { dosageForm: "tab" } });

    const results = nextDueDoses(parsed.fhir, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-03T00:00:00Z",
      limit: 3
    });

    expect(results).toEqual([
      "2024-01-08T09:00:00+00:00",
      "2024-01-15T09:00:00+00:00",
      "2024-01-22T09:00:00+00:00"
    ]);
  });

  it("emits immediate doses when IMD is present", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          when: [EventTiming.Immediate]
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T11:00:00Z",
      from: "2024-01-01T09:00:00Z"
    });

    expect(results).toEqual(["2024-01-01T11:00:00+00:00"]);
  });

  it("uses from as the baseline when orderedAt is omitted", () => {
    const dosage: FhirDosage = {
      timing: {
        repeat: {
          period: 8,
          periodUnit: FhirPeriodUnit.Hour
        }
      }
    };

    const results = nextDueDoses(dosage, {
      ...BASE_OPTIONS,
      from: "2024-01-01T00:00:00Z",
      limit: 3
    });

    expect(results).toEqual([
      "2024-01-01T00:00:00+00:00",
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T16:00:00+00:00"
    ]);
  });

  it("emits a single anchored due dose for bare one-time schedules", () => {
    const parsed = parseSig("insert 1 tab pv once", { context: { dosageForm: "tab" } });

    const results = nextDueDoses(parsed.fhir, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-01T09:00:00Z",
      limit: 5
    });

    expect(results).toEqual(["2024-01-01T09:00:00+00:00"]);
  });

  it("returns the anchored due date for one-time schedules when instruction text is non-relational", () => {
    const parsed = parseSig("take 1 tab po once, take slowly", {
      context: { dosageForm: "tab" }
    });

    const results = nextDueDoses(parsed.fhir, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-01T09:00:00Z",
      limit: 5
    });

    expect(results).toEqual(["2024-01-01T09:00:00+00:00"]);
  });

  it("does not invent due dates for one-time schedules gated by unresolved relational instructions", () => {
    const parsed = parseSig("insert 1 tab pv once after menstruation ends", {
      context: { dosageForm: "tab" }
    });

    const results = nextDueDoses(parsed.fhir, {
      ...BASE_OPTIONS,
      orderedAt: "2024-01-01T09:00:00Z",
      from: "2024-01-01T09:00:00Z",
      limit: 5
    });

    expect(results).toEqual([]);
  });
});

describe("calculateTotalUnits", () => {
  const dosageBID: FhirDosage = {
    doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
    timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
  };

  it("counts exact Timing.event doses and respects boundsPeriod.start", () => {
    const exact: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      timing: {
        event: ["2024-01-02", "2024-01-04", "2024-01-10"]
      }
    };
    expect(calculateTotalUnits({
      dosage: exact,
      from: "2024-01-01T00:00:00Z",
      durationValue: 7,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    }).totalUnits).toBe(4);

    const bounded: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: {
        repeat: {
          frequency: 1,
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00"],
          boundsPeriod: { start: "2024-01-03" }
        }
      }
    };
    expect(calculateTotalUnits({
      dosage: bounded,
      from: "2024-01-01T00:00:00Z",
      durationValue: 5,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    }).totalUnits).toBe(3);
  });

  it("calculates total for cream (weight/weight)", () => {
    const res = calculateTotalUnits({
      dosage: dosageBID,
      from: "2024-01-01T08:00:00Z",
      durationValue: 7,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        dosageForm: "cream",
        strength: "1%",
        containerValue: 30,
        containerUnit: "g"
      }
    });
    expect(res.totalUnits).toBe(14);
    expect(res.totalContainers).toBe(1);
  });

  it("calculates total for solution (weight/volume bridge)", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 500, unit: "mg" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 10,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        dosageForm: "oral solution",
        strength: "2%",
        containerValue: 100,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(10000);
    expect(res.totalContainers).toBe(5);
  });

  it("handles composite strengths in context", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 480, unit: "mg" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        strength: "400 mg/5mL + 80 mg/5mL",
        containerValue: 100,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(480);
    expect(res.totalContainers).toBe(1);
  });

  it("handles complex interval stepping (q3d) for 10 days", () => {
    // Doses at: d0, d3, d6, d9 -> 4 doses total
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { period: 3, periodUnit: FhirPeriodUnit.Day } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 10,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    });
    expect(res.totalUnits).toBe(4);
  });

  it("calculates one-time schedules as a single dose instead of a daily course", () => {
    const parsed = parseSig("insert 1 tab pv once", { context: { dosageForm: "tab" } });

    const res = calculateTotalUnits({
      dosage: parsed.fhir,
      from: "2024-01-01T09:00:00Z",
      durationValue: 30,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    });

    expect(res.totalUnits).toBe(1);
  });

  it("does not count one-time schedules gated by unresolved relational instructions", () => {
    const parsed = parseSig("insert 1 tab pv once after menstruation ends", {
      context: { dosageForm: "tab" }
    });

    const res = calculateTotalUnits({
      dosage: parsed.fhir,
      from: "2024-01-01T09:00:00Z",
      durationValue: 30,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    });

    expect(res.totalUnits).toBe(0);
  });

  it("caps count-limited minute intervals for calculateTotalUnits", () => {
    const parsed = parseSig("1 drop ou q15min x 8 doses");

    const res = calculateTotalUnits({
      dosage: parsed.fhir,
      from: "2024-01-01T09:00:00Z",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    });

    expect(res.totalUnits).toBe(16);
  });

  it("multiplies bilateral ophthalmic drop counts per eye", () => {
    const parsed = parseSig("1 drop ou q2h");

    const res = calculateTotalUnits({
      dosage: parsed.fhir,
      from: "2024-01-01T09:00:00Z",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        dosageForm: "eye drops, solution",
        containerValue: 5,
        containerUnit: "mL"
      }
    });

    expect(res.totalUnits).toBe(24);
    expect(res.totalApproximateQuantity?.value).toBe(1.2);
    expect(res.totalApproximateQuantity?.unit).toBe("mL");
    expect(res.totalContainers).toBe(1);
  });

  it("multiplies bilateral nasal sprays per nostril", () => {
    const parsed = parseSig("1 spray each nostril bid", {
      context: { dosageForm: "nasal spray, solution" }
    });

    const res = calculateTotalUnits({
      dosage: parsed.fhir,
      from: "2024-01-01T09:00:00Z",
      durationValue: 7,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: { dosageForm: "nasal spray, solution" }
    });

    expect(parsed.fhir.site?.text).toBe("both nostrils");
    expect(res.totalUnits).toBe(28);
  });

  it("infers administration target count from coded bilateral sites when no site extension is present", () => {
    const res = calculateTotalUnits({
      dosage: {
        doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
        timing: { repeat: { period: 2, periodUnit: FhirPeriodUnit.Hour } },
        site: {
          coding: [
            {
              system: "http://snomed.info/sct",
              code: "40638003",
              display: "Structure of both eyes"
            }
          ]
        }
      },
      from: "2024-01-01T09:00:00Z",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        dosageForm: "eye drops, solution"
      }
    });

    expect(res.totalUnits).toBe(24);
  });

  it("caps count-limited fractional-hour intervals for calculateTotalUnits", () => {
    const parsed = parseSig("1 tab po q0.5h x3 times", { context: { dosageForm: "tab" } });

    const res = calculateTotalUnits({
      dosage: parsed.fhir,
      from: "2024-01-01T09:00:00Z",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    });

    expect(res.totalUnits).toBe(3);
  });

  it("handles complex weekly schedules with dayOfWeek", () => {
    // Mon, Wed, Fri for 2 weeks = 6 doses
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: {
        repeat: {
          period: 1,
          periodUnit: FhirPeriodUnit.Week,
          dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday, FhirDayOfWeek.Friday]
        }
      }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z", // Monday
      durationValue: 2,
      durationUnit: FhirPeriodUnit.Week,
      timeZone: "UTC"
    });
    expect(res.totalUnits).toBe(6);
  });

  it("respects multi-week cadence when dayOfWeek is present", () => {
    // Every 2 weeks on Monday for 8 weeks = 4 doses
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: {
        repeat: {
          period: 2,
          periodUnit: FhirPeriodUnit.Week,
          dayOfWeek: [FhirDayOfWeek.Monday]
        }
      }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z", // Monday
      durationValue: 8,
      durationUnit: FhirPeriodUnit.Week,
      timeZone: "UTC"
    });
    expect(res.totalUnits).toBe(4);
  });

  it("counts bare day-of-week schedules as weekly recurrences", () => {
    const parsed = parseSig("1 tab po every monday", { context: { dosageForm: "tab" } });

    const res = calculateTotalUnits({
      dosage: parsed.fhir,
      from: "2024-01-01T09:00:00Z",
      durationValue: 4,
      durationUnit: FhirPeriodUnit.Week,
      timeZone: "UTC"
    });

    expect(res.totalUnits).toBe(4);
  });

  it("respects hourly intervals constrained by dayOfWeek", () => {
    // q6h on Tuesdays only over 2 weeks:
    // Tue Jan 2 + Tue Jan 9 => 2 days * 4 doses/day = 8 doses
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: {
        repeat: {
          period: 6,
          periodUnit: FhirPeriodUnit.Hour,
          dayOfWeek: [FhirDayOfWeek.Tuesday]
        }
      }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T00:00:00Z",
      durationValue: 2,
      durationUnit: FhirPeriodUnit.Week,
      timeZone: "UTC"
    });
    expect(res.totalUnits).toBe(8);
  });

  it("calculates syrup bottles for non-daily weekly schedules", () => {
    // 10 mL weekly for 10 weeks = 100 mL total; 60 mL bottle => 2 bottles
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 10, unit: "mL" } }],
      timing: { repeat: { period: 1, periodUnit: FhirPeriodUnit.Week } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 10,
      durationUnit: FhirPeriodUnit.Week,
      timeZone: "UTC",
      context: {
        containerValue: 60,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(100);
    expect(res.totalContainers).toBe(2);
  });

  it("handles anchored event timings (Breakfast + Dinner) for 5 days", () => {
    // 2 doses/day * 5 days = 10 doses
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [EventTiming.Breakfast, EventTiming.Dinner] } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T00:00:00Z",
      durationValue: 5,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      eventClock: EVENT_CLOCK
    });
    expect(res.totalUnits).toBe(10);
  });

  it("handles PRN (asNeeded)", () => {
    const dosage: FhirDosage = {
      asNeeded: true,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 4, periodUnit: FhirPeriodUnit.Hour } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T00:00:00Z",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    });
    expect(res.totalUnits).toBe(6); // 24/4 = 6 doses
  });

  it("handles very complex percentage strength with different units", () => {
    // 500mg/dL = 5mg/mL
    // 5mg/mL + 5mg/mL = 10mg/mL
    // Dose 20mg BID for 5 days = 200mg total.
    // 200mg @ 10mg/mL = 20mL.
    // Container 15mL -> 2 containers.
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 20, unit: "mg" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 5,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC",
      context: {
        strength: "500 mg/dL + 5 mg/mL",
        containerValue: 15,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(200);
    expect(res.totalContainers).toBe(2);
  });

  it("matches generated schedules for weird non-daily timing combinations", () => {
    const scenarios: Array<{
      name: string;
      from: string;
      durationValue: number;
      durationUnit: FhirPeriodUnit;
      dosage: FhirDosage;
      doseValue: number;
    }> = [
      {
        name: "q6h",
        from: "2024-01-01T00:00:00Z",
        durationValue: 2,
        durationUnit: FhirPeriodUnit.Day,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { period: 6, periodUnit: FhirPeriodUnit.Hour } }
        }
      },
      {
        name: "q6h Tuesday only",
        from: "2024-01-01T00:00:00Z",
        durationValue: 2,
        durationUnit: FhirPeriodUnit.Week,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: {
            repeat: {
              period: 6,
              periodUnit: FhirPeriodUnit.Hour,
              dayOfWeek: [FhirDayOfWeek.Tuesday]
            }
          }
        }
      },
      {
        name: "q36h",
        from: "2024-01-01T00:00:00Z",
        durationValue: 12,
        durationUnit: FhirPeriodUnit.Day,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { period: 36, periodUnit: FhirPeriodUnit.Hour } }
        }
      },
      {
        name: "q2d monday wednesday friday only",
        from: "2024-01-01T08:00:00Z",
        durationValue: 28,
        durationUnit: FhirPeriodUnit.Day,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: {
            repeat: {
              period: 2,
              periodUnit: FhirPeriodUnit.Day,
              dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday, FhirDayOfWeek.Friday]
            }
          }
        }
      },
      {
        name: "weekly mon wed fri",
        from: "2024-01-01T08:00:00Z",
        durationValue: 3,
        durationUnit: FhirPeriodUnit.Week,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: {
            repeat: {
              period: 1,
              periodUnit: FhirPeriodUnit.Week,
              dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday, FhirDayOfWeek.Friday]
            }
          }
        }
      },
      {
        name: "every 2 weeks monday",
        from: "2024-01-01T08:00:00Z",
        durationValue: 10,
        durationUnit: FhirPeriodUnit.Week,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: {
            repeat: {
              period: 2,
              periodUnit: FhirPeriodUnit.Week,
              dayOfWeek: [FhirDayOfWeek.Monday]
            }
          }
        }
      },
      {
        name: "monthly anchored cadence",
        from: "2024-01-01T08:00:00Z",
        durationValue: 6,
        durationUnit: FhirPeriodUnit.Month,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: {
            repeat: {
              period: 1,
              periodUnit: FhirPeriodUnit.Month
            }
          }
        }
      },
      {
        name: "timeOfDay + day filter",
        from: "2024-01-01T00:00:00Z",
        durationValue: 14,
        durationUnit: FhirPeriodUnit.Day,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: {
            repeat: {
              dayOfWeek: [FhirDayOfWeek.Tuesday, FhirDayOfWeek.Thursday],
              timeOfDay: ["08:00", "20:00"]
            }
          }
        }
      },
      {
        name: "when before meal",
        from: "2024-01-01T00:00:00Z",
        durationValue: 5,
        durationUnit: FhirPeriodUnit.Day,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { when: [EventTiming["Before Meal"]] } }
        }
      },
      {
        name: "when before sleep",
        from: "2024-01-01T00:00:00Z",
        durationValue: 5,
        durationUnit: FhirPeriodUnit.Day,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { when: [EventTiming["Before Sleep"]] } }
        }
      },
      {
        name: "TID with explicit day filter",
        from: "2024-01-01T00:00:00Z",
        durationValue: 10,
        durationUnit: FhirPeriodUnit.Day,
        doseValue: 1,
        dosage: {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: {
            repeat: {
              frequency: 3,
              period: 1,
              periodUnit: FhirPeriodUnit.Day,
              dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday, FhirDayOfWeek.Wednesday]
            }
          }
        }
      }
    ];

    for (const scenario of scenarios) {
      const expectedCount = expectedCountFromGenerator(
        scenario.dosage,
        scenario.from,
        scenario.durationValue,
        scenario.durationUnit
      );
      const actual = calculateTotalUnits({
        dosage: scenario.dosage,
        from: scenario.from,
        durationValue: scenario.durationValue,
        durationUnit: scenario.durationUnit,
        ...BASE_OPTIONS
      });
      expect(actual.totalUnits / scenario.doseValue, scenario.name).toBe(expectedCount);
    }
  });

  it("uses the first matching weekday as a best-effort monthly interpretation when no ordinal is supplied", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Month,
        dayOfWeek: [FhirDayOfWeek.Monday]
      } }
    };
    expect(nextDueDoses(dosage, {
      ...BASE_OPTIONS, from: "2024-01-01T08:00:00Z", orderedAt: "2024-01-01T08:00:00Z",
      limit: 3
    })).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-02-05T08:00:00+00:00",
      "2024-03-04T08:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      dosage, from: "2024-01-01T08:00:00Z",
      durationValue: 2, durationUnit: FhirPeriodUnit.Month, ...BASE_OPTIONS
    }).totalUnits).toBe(2);
  });

  it("calculates liquid containers for monthly cadence with strength conversion", () => {
    // 250 mg monthly x3 months = 750 mg total.
    // Strength 125 mg/5 mL = 25 mg/mL -> total 30 mL.
    // 15 mL bottles => 2 bottles.
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 250, unit: "mg" } }],
      timing: { repeat: { period: 1, periodUnit: FhirPeriodUnit.Month } }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 3,
      durationUnit: FhirPeriodUnit.Month,
      timeZone: "UTC",
      context: {
        strength: "125 mg/5 mL",
        containerValue: 15,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(750);
    expect(res.totalContainers).toBe(2);
  });

  it("calculates liquid containers for filtered biweekly cadence", () => {
    // 10 mL every 2 weeks on Monday for 9 weeks => 5 doses => 50 mL.
    // 30 mL bottle => 2 bottles.
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 10, unit: "mL" } }],
      timing: {
        repeat: {
          period: 2,
          periodUnit: FhirPeriodUnit.Week,
          dayOfWeek: [FhirDayOfWeek.Monday]
        }
      }
    };
    const res = calculateTotalUnits({
      dosage,
      from: "2024-01-01T08:00:00Z",
      durationValue: 9,
      durationUnit: FhirPeriodUnit.Week,
      timeZone: "UTC",
      context: {
        containerValue: 30,
        containerUnit: "mL"
      }
    });
    expect(res.totalUnits).toBe(50);
    expect(res.totalContainers).toBe(2);
  });
});


describe("mixed event and fixed-clock quantities remain distinct across R5/R6", () => {
  it("executes and counts a before-meal whole dose plus an independently measured bedtime half dose", () => {
    const dosages: FhirDosage[] = [
      {
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { when: [EventTiming["Before Meal"]] } }
      },
      {
        doseAndRate: [{ doseQuantity: { value: 0.5, unit: "tab" } }],
        timing: { repeat: { timeOfDay: ["22:00:00"] } }
      }
    ];
    const course = toDosageDetails(dosages);
    const representations = [dosages, course, toFhirR5Dosages(course)];
    const opts = {
      timeZone: "Asia/Bangkok",
      from: "2026-11-02T00:00:00+07:00",
      orderedAt: "2026-11-02T00:00:00+07:00",
      eventClock: {
        [EventTiming.Breakfast]: "08:00",
        [EventTiming.Lunch]: "12:30",
        [EventTiming.Dinner]: "18:30"
      },
      mealOffsets: { [EventTiming["Before Meal"]]: -30 }
    };
    for (const regimen of representations) {
      expect(nextDueDoses(regimen, { ...opts, limit: 4 })).toEqual([
        "2026-11-02T07:30:00+07:00",
        "2026-11-02T12:00:00+07:00",
        "2026-11-02T18:00:00+07:00",
        "2026-11-02T22:00:00+07:00"
      ]);
      expect(calculateTotalUnits({
        dosage: regimen, ...opts,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(73.5);
    }
  });
});


describe("typed step addition without changing the baseline administrations", () => {
  it("executes an explicit week-two added dose with the baseline continued, in R6 and strict R5", () => {
    const relativeDay = (day: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event",
        code: "treatment-start", display: "Start of Treatment"
      }] },
      offsetDuration: { value: day, unit: "d", system: "http://unitsofmeasure.org", code: "d" }
    });
    const component = (value: number, clocks: string[]) => ({
      timing: { repeat: { timeOfDay: clocks.map(clock => clock + ":00") } },
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }]
    });
    const course: FhirR6DosageDetails = {
      step: [
        {
          end: relativeDay(7),
          component: [component(1, ["08:00", "20:00"])]
        },
        {
          start: relativeDay(7), end: relativeDay(14),
          component: [
            component(1, ["08:00", "20:00"]),
            component(0.5, ["14:00"])
          ]
        }
      ]
    };
    const representations = [
      course,
      toFhirR5Dosages(course),
      toDosageDetails(toFhirR5Dosages(course))
    ];
    const orderedAt = "2026-11-02T00:00:00+07:00";
    for (const dosage of representations) {
      const dueOn = (date: string) => nextDueDoses(dosage, {
        timeZone: "Asia/Bangkok", orderedAt,
        from: date + "T00:00:00+07:00", limit: 12
      }).filter(value => value.startsWith(date)).map(value => value.slice(11, 16));
      expect(dueOn("2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(dueOn("2026-11-09")).toEqual(["08:00", "14:00", "20:00"]);
      expect(dueOn("2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({
        dosage, timeZone: "Asia/Bangkok",
        from: orderedAt, orderedAt,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(31.5);
    }
  });
});


describe("typed waking-hours baseline and independent optional bedtime administration", () => {
  it("keeps a separate optional bedtime half-tablet out of the waking-hour base condition", () => {
    const course: FhirR6DosageDetails = {
      step: [{ component: [
        {
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: {
            period: 4, periodUnit: FhirPeriodUnit.Hour,
            extension: [{
              url: TIMING_EVENT_WINDOW_EXTENSION_URL,
              extension: [
                { url: "start", valueCode: EventTiming.Wake },
                { url: "end", valueCode: EventTiming["Before Sleep"] }
              ]
            }]
          } }
        },
        {
          doseAndRate: [{ doseQuantity: { value: 0.5, unit: "tab" } }],
          timing: { repeat: { when: [EventTiming["Before Sleep"]] } },
          asNeeded: true,
          asNeededFor: [{ text: "symptoms persist" }]
        }
      ] }]
    };
    const start = "2026-11-02T00:00:00+07:00";
    for (const dosage of [
      course,
      toFhirR5Dosages(course),
      toDosageDetails(toFhirR5Dosages(course))
    ]) {
      expect(nextDueDoses(dosage, {
        orderedAt: start, from: start, timeZone: "Asia/Bangkok",
        eventClock: {
          [EventTiming.Wake]: "06:30",
          [EventTiming["Before Sleep"]]: "22:00"
        },
        limit: 5
      })).toEqual([
        "2026-11-02T06:30:00+07:00",
        "2026-11-02T10:30:00+07:00",
        "2026-11-02T14:30:00+07:00",
        "2026-11-02T18:30:00+07:00",
        "2026-11-02T22:00:00+07:00"
      ]);
      expect(calculateTotalUnits({
        dosage, orderedAt: start, from: start,
        timeZone: "Asia/Bangkok",
        eventClock: {
          [EventTiming.Wake]: "06:30",
          [EventTiming["Before Sleep"]]: "22:00"
        },
        durationValue: 7,
        durationUnit: FhirPeriodUnit.Day
      })).toMatchObject({
        totalUnits: 31.5, unit: "tab", quantityKind: "maximum"
      });
    }
  });
});


describe("finite waking and bedtime phase followed by an added noon administration", () => {
  it("executes a second-week noon event without dropping the original waking and bedtime doses", () => {
    const relativeDay = (day: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: day, unit: "d" }
    });
    const oneTablet = (event: EventTiming) => ({
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [event] } }
    });
    const course: FhirR6DosageDetails = {
      step: [
        {
          end: relativeDay(7),
          component: [
            oneTablet(EventTiming.Wake),
            oneTablet(EventTiming["Before Sleep"])
          ]
        },
        {
          start: relativeDay(7),
          component: [
            oneTablet(EventTiming.Wake),
            oneTablet(EventTiming.Noon),
            oneTablet(EventTiming["Before Sleep"])
          ]
        }
      ]
    };
    const start = "2026-11-02T00:00:00+07:00";
    for (const dosage of [
      course,
      toFhirR5Dosages(course),
      toDosageDetails(toFhirR5Dosages(course))
    ]) {
      const times = (date: string) => nextDueDoses(dosage, {
        orderedAt: start,
        from: date + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok",
        eventClock: {
          [EventTiming.Wake]: "06:30",
          [EventTiming.Noon]: "12:00",
          [EventTiming["Before Sleep"]]: "22:00"
        },
        limit: 12
      }).filter(time => time.startsWith(date)).map(time => time.slice(11, 16));
      expect(times("2026-11-02")).toEqual(["06:30", "22:00"]);
      expect(times("2026-11-09")).toEqual(["06:30", "12:00", "22:00"]);
      expect(calculateTotalUnits({
        dosage, from: start, orderedAt: start,
        timeZone: "Asia/Bangkok",
        eventClock: {
          [EventTiming.Wake]: "06:30",
          [EventTiming.Noon]: "12:00",
          [EventTiming["Before Sleep"]]: "22:00"
        },
        durationValue: 14,
        durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(35);
    }
  });
});


describe("waking-hours overnight shifts", () => {
  const course: FhirR6DosageDetails = {
    step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        period: 3, periodUnit: FhirPeriodUnit.Hour,
        extension: [{
          url: TIMING_EVENT_WINDOW_EXTENSION_URL,
          extension: [
            { url: "start", valueCode: EventTiming.Wake },
            { url: "end", valueCode: EventTiming["Before Sleep"] }
          ]
        }]
      } }
    }] }]
  };
  const variants = [
    course, toFhirR5Dosages(course), toDosageDetails(toFhirR5Dosages(course))
  ];
  const options = {
    timeZone: "Asia/Bangkok" as const,
    orderedAt: "2026-11-02T00:00:00+07:00",
    eventClock: {
      [EventTiming.Wake]: "22:00",
      [EventTiming["Before Sleep"]]: "07:00"
    }
  };

  it("continues the previous wake-day window after midnight without daytime administrations", () => {
    for (const dosage of variants) {
      expect(nextDueDoses(dosage, {
        ...options,
        from: "2026-11-03T00:00:00+07:00",
        limit: 5
      })).toEqual([
        "2026-11-03T01:00:00+07:00",
        "2026-11-03T04:00:00+07:00",
        "2026-11-03T22:00:00+07:00",
        "2026-11-04T01:00:00+07:00",
        "2026-11-04T04:00:00+07:00"
      ]);
    }
  });

  it("does not manufacture prior-day administrations when a course begins at midnight", () => {
    for (const dosage of variants) {
      expect(nextDueDoses(dosage, {
        ...options,
        from: "2026-11-02T00:00:00+07:00",
        limit: 4
      })).toEqual([
        "2026-11-02T22:00:00+07:00",
        "2026-11-03T01:00:00+07:00",
        "2026-11-03T04:00:00+07:00",
        "2026-11-03T22:00:00+07:00"
      ]);
    }
  });

  it("anchors weekday filtering to the waking date rather than post-midnight clock date", () => {
    const mondayCourse: FhirR6DosageDetails = {
      step: [{ component: [{
        ...course.step[0].component[0],
        timing: { repeat: {
          ...course.step[0].component[0].timing?.repeat,
          dayOfWeek: [FhirDayOfWeek.Monday]
        } }
      }] }]
    };
    for (const dosage of [mondayCourse, toFhirR5Dosages(mondayCourse)]) {
      expect(nextDueDoses(dosage, {
        ...options,
        from: "2026-11-03T00:00:00+07:00",
        limit: 3
      })).toEqual([
        "2026-11-03T01:00:00+07:00",
        "2026-11-03T04:00:00+07:00",
        "2026-11-09T22:00:00+07:00"
      ]);
    }
  });

  it("preserves ordinary daytime windows and rejects identical wake/sleep clocks", () => {
    for (const dosage of variants) {
      expect(nextDueDoses(dosage, {
        ...options,
        from: "2026-11-02T00:00:00+07:00",
        limit: 3,
        eventClock: {
          [EventTiming.Wake]: "06:30",
          [EventTiming["Before Sleep"]]: "22:00"
        }
      })).toEqual([
        "2026-11-02T06:30:00+07:00",
        "2026-11-02T09:30:00+07:00",
        "2026-11-02T12:30:00+07:00"
      ]);
      expect(() => nextDueDoses(dosage, {
        ...options,
        from: "2026-11-02T00:00:00+07:00",
        limit: 1,
        eventClock: {
          [EventTiming.Wake]: "22:00",
          [EventTiming["Before Sleep"]]: "22:00"
        }
      })).toThrow("WAKE precedes HS");
    }
  });

  it("counts overnight administrations only within the requested finite treatment window", () => {
    for (const dosage of variants) {
      expect(calculateTotalUnits({
        dosage,
        ...options,
        from: "2026-11-02T00:00:00+07:00",
        durationValue: 2,
        durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(4);
    }
  });
});
