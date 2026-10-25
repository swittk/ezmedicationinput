import type { MedicationCondition } from "../src/types";
import { describe, expect, it } from "vitest";
import { parseSig as parsePublicSig, nextDueDoses, calculateTotalUnits, evaluateMedicationCondition, toDosageDetails, toFhirR5Dosages, formatSig } from "../src/index";
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
    expect(res.totalContainers).toBeUndefined();
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
    expect(res.totalContainers).toBeUndefined();
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


describe("repeating R6 course intervals crossing cycle boundaries", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const relative = (value: number) => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] },
    offsetDuration: { value, unit: "d", system: "http://unitsofmeasure.org", code: "d" }
  });
  const makeCycle = (start: number, end: number): FhirR6DosageDetails => ({
    repeatCycle: { value: 14, unit: "d", code: "d" },
    step: [{ start: relative(start), end: relative(end), component: [{
      timing: { repeat: { timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }]
  });
  const on = (dosage: FhirR6DosageDetails | FhirDosage[], day: string) =>
    nextDueDoses(dosage, {
      orderedAt, from: day + "T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 6
    }).filter(ts => ts.startsWith(day));

  it("retains the active prior-cycle dose after a new cycle begins", () => {
    const course = makeCycle(7, 21);
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(on(dosage, "2026-11-02")).toEqual([]);
      for (const day of ["2026-11-09", "2026-11-16", "2026-11-23", "2026-11-29"]) {
        expect(on(dosage, day)).toEqual([day + "T08:00:00+07:00"]);
      }
      expect(calculateTotalUnits({
        dosage, orderedAt, from: orderedAt, timeZone: "Asia/Bangkok",
        durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(21);
    }
  });

  it("retains a genuine seven-day rest in an ordinary 7-on/7-off cycle", () => {
    const course = makeCycle(0, 7);
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(on(dosage, "2026-11-02")).toEqual(["2026-11-02T08:00:00+07:00"]);
      expect(on(dosage, "2026-11-09")).toEqual([]);
      expect(on(dosage, "2026-11-16")).toEqual(["2026-11-16T08:00:00+07:00"]);
      expect(calculateTotalUnits({
        dosage, orderedAt, from: orderedAt, timeZone: "Asia/Bangkok",
        durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(14);
    }
  });
  it("merges overlapping cycles chronologically without deduplicating administrations", () => {
    const course = makeCycle(0, 21);
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(dosage, {
        orderedAt, from: "2026-11-16T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 3
      })).toEqual([
        "2026-11-16T08:00:00+07:00", "2026-11-16T08:00:00+07:00",
        "2026-11-17T08:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(35);
      expect(calculateTotalUnits({ dosage, orderedAt, from: "2026-11-16T00:00:00+07:00",
        timeZone: "Asia/Bangkok", durationValue: 7, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(14);
    }
  });

  it("keeps a finite delayed component even when its onset is after one whole cycle", () => {
    const course = makeCycle(21, 28);
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(dosage, { orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", limit: 1
      })).toEqual(["2026-11-23T08:00:00+07:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 42, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(14);
    }
  });

  it("does not accumulate unbounded daily administrations at each cycle restart", () => {
    const course = makeCycle(0, 7);
    delete course.step[0].end;
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(on(dosage, "2026-11-16")).toEqual(["2026-11-16T08:00:00+07:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(28);
    }
  });

  it("preserves calendar-month offsets rather than treating each month as thirty days", () => {
    const month = (value: number) => ({ ...relative(value),
      offsetDuration: { value, unit: "mo", code: "mo" }
    });
    const course = makeCycle(0, 7);
    course.repeatCycle = { value: 1, unit: "mo", code: "mo" };
    course.step[0].start = month(1);
    course.step[0].end = month(2);
    const monthStart = "2026-11-01T00:00:00+07:00";
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(dosage, { orderedAt: monthStart, from: "2027-01-01T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 1
      })).toEqual(["2027-01-01T08:00:00+07:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt: monthStart, from: monthStart,
        timeZone: "Asia/Bangkok", durationValue: 3, durationUnit: FhirPeriodUnit.Month
      }).totalUnits).toBe(62);
    }
  });

  it("bounds each independent concurrent component within a repeated step", () => {
    const course = makeCycle(0, 7);
    delete course.step[0].end;
    course.step[0].component[0].timing!.repeat!.boundsDuration = {
      value: 21, unit: "d", code: "d"
    };
    course.step[0].component.push({
      timing: { repeat: { timeOfDay: ["20:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 0.5, unit: "tab" } }]
    });
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(on(dosage, "2026-11-16")).toEqual([
        "2026-11-16T08:00:00+07:00", "2026-11-16T08:00:00+07:00",
        "2026-11-16T20:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(49);
    }
  });

  it("stops the already-supported three-cycle instruction after the third course", () => {
    const parsed = parseSig("1 tab daily for 7 days then stop for 7 days repeat for 3 cycles");
    expect(parsed.fhirNext.step[0].count).toBe(3);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { orderedAt, from: "2026-12-14T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 3
      })).toEqual([]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 56, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(21);
    }
  });

  it("keeps the last counted cycle's finite tail but never starts a fourth cycle", () => {
    const course = makeCycle(7, 21);
    course.step[0].count = 3;
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(on(dosage, "2026-12-14")).toEqual(["2026-12-14T08:00:00+07:00"]);
      expect(on(dosage, "2026-12-21")).toEqual([]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 70, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(42);
    }
  });

  it.each([", then stop for 7 days; repeat", "; then stop for 7 days. Repeat", ". Then stop for 7 days, repeat"])(
    "preserves a counted source cycle across normal punctuation: %s", tail => {
      const input = "Take 1 tablet daily for 7 days" + tail + " for 3 cycles.";
      const parsed = parseSig(input);
      expect(parsed.fhirNext.repeatCycle?.value).toBe(14);
      expect(parsed.fhirNext.step[0].count).toBe(3);
      expect(parsed.fhirNext.renderedInstruction).toBe(input);
      for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(nextDueDoses(dosage, { orderedAt, from: "2026-12-14T00:00:00+07:00",
          timeZone: "Asia/Bangkok", limit: 3
        })).toEqual([]);
        expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
          timeZone: "Asia/Bangkok", durationValue: 56, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(21);
      }
    }
  );

  it.each([1, 3])("shows a source-less cycle count of %i in both languages", count => {
    const course = makeCycle(0, 7);
    course.step[0].count = count;
    for (const input of [course, toFhirR5Dosages(course)]) {
      expect(formatSig(input, "long", { locale: "en" }))
        .toContain(count + (count === 1 ? " cycle" : " cycles"));
      expect(formatSig(input, "long", { locale: "th" })).toContain(count + " รอบ");
    }
  });

});

describe("scalar R5 retained-course execution parity", () => {
  const options = {
    timeZone: "Asia/Bangkok",
    orderedAt: "2026-11-02T00:00:00+07:00",
    from: "2026-11-02T00:00:00+07:00"
  };
  const course = parseSig("Take 1 tablet at 08:00 for 7 days then stop for 7 days repeat for 3 cycles").fhirNext;

  it("keeps later active cycles and the final cycle bound when one retained R5 row is supplied", () => {
    const row = toFhirR5Dosages(course)[0];
    for (const dosage of [row, { ...row, text: undefined, patientInstruction: undefined }]) {
      expect(nextDueDoses(dosage, {
        ...options, from: "2026-11-16T00:00:00+07:00", limit: 2
      })).toEqual(["2026-11-16T08:00:00+07:00", "2026-11-17T08:00:00+07:00"]);
      expect(nextDueDoses(dosage, {
        ...options, from: "2026-12-14T00:00:00+07:00", limit: 2
      })).toEqual([]);
    }
  });

  it("counts three active weeks as 21 tablets rather than only the first seven", () => {
    const row = toFhirR5Dosages(course)[0];
    for (const dosage of [course, [row], row, { ...row, text: undefined, patientInstruction: undefined }]) {
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 56, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(21);
    }
  });

  it("preserves a delayed source-less start for a single retained course row", () => {
    const day = (value: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value, unit: "d", code: "d" }
    });
    const delayed: FhirR6DosageDetails = { step: [{
      start: day(14), end: day(21), component: [{
        timing: { repeat: { timeOfDay: ["08:00:00"] } },
        doseAndRate: [{ doseQuantity: { value: 0.5, unit: "tab" } }]
      }]
    }] };
    const row = toFhirR5Dosages(delayed)[0];
    expect(nextDueDoses(row, { ...options, limit: 2 })).toEqual([
      "2026-11-16T08:00:00+07:00", "2026-11-17T08:00:00+07:00"
    ]);
    expect(calculateTotalUnits({
      ...options, dosage: row, durationValue: 28, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(3.5);
  });
});

describe("execution follows typed course semantics rather than narrative reparsing", () => {
  const options = {
    timeZone: "Asia/Bangkok",
    orderedAt: "2026-11-02T00:00:00+07:00",
    from: "2026-11-16T00:00:00+07:00",
    limit: 2
  };
  it.each(["text", "patientInstruction"] as const)("does not invent additional cycles from retained %s", field => {
    const dosage: FhirDosage = {
      [field]: "Take 1 tablet daily for 7 days, then stop for 7 days and repeat.",
      timing: { repeat: {
        timeOfDay: ["08:00:00"], boundsDuration: { value: 7, unit: "d", code: "d" }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    // Narrative survives an edit/import, but cannot recreate absent cycle fields.
    expect(nextDueDoses(dosage, options)).toEqual([]);
    expect(calculateTotalUnits({
      ...options, from: options.orderedAt, dosage,
      durationValue: 56, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(7);
    expect(dosage[field]).toBe("Take 1 tablet daily for 7 days, then stop for 7 days and repeat.");
  });
});

describe("monthly execution does not reparse retained narrative", () => {
  it.each(["text", "patientInstruction"] as const)("keeps the structured monthly anchor when stale %s is present", field => {
    const dosage: FhirDosage = {
      [field]: "Take on the first Monday of each month.",
      timing: { repeat: {
        period: 1, periodUnit: FhirPeriodUnit.Month,
        dayOfWeek: [FhirDayOfWeek.Monday], timeOfDay: ["08:00:00"],
        boundsPeriod: { start: "2026-11-09" }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const options = {
      timeZone: "Asia/Bangkok", orderedAt: "2026-11-09T00:00:00+07:00",
      from: "2026-11-09T00:00:00+07:00", limit: 3
    };
    for (const input of [dosage, toDosageDetails([dosage]), toFhirR5Dosages(toDosageDetails([dosage]))]) {
      expect(nextDueDoses(input, options)).toEqual([
        "2026-11-09T08:00:00+07:00", "2026-12-14T08:00:00+07:00", "2027-01-11T08:00:00+07:00"
      ]);
    }
    expect(dosage[field]).toBe("Take on the first Monday of each month.");
  });
});

describe("one-time activity timing is owned by HPSG, not counseling text", () => {
  const options = {
    timeZone: "Asia/Bangkok",
    orderedAt: "2026-11-02T08:00:00+07:00",
    from: "2026-11-02T08:00:00+07:00", limit: 2
  };
  it.each(["Do not drive after taking.", "Do not lie down after taking."])(
    "does not cancel a one-time administration because of separate advice: %s", advice => {
      const parsed = parseSig("Take 1 tablet once. " + advice);
      for (const dosage of [parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(nextDueDoses(dosage, options)).toEqual(["2026-11-02T08:00:00+07:00"]);
        expect(calculateTotalUnits({ ...options, dosage,
          durationValue: 1, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(1);
      }
      expect(parsed.longText.toLowerCase()).toContain(advice.toLowerCase().replace(/\.$/u, ""));
    }
  );

  it.each(["menstruation ends", "menstruation finishes", "dressing change"])(
    "keeps an administration-owned unresolved activity anchor without relying on source prose: %s", activity => {
      const parsed = parseSig("Insert 1 tablet vaginally once after " + activity + ".");
      expect(parsed.meta.canonical.clauses[0].schedule?.activityTiming).toEqual([
        expect.objectContaining({ relation: "after", activity: expect.objectContaining({ text: activity }) })
      ]);
      const dosage = { ...parsed.fhir, text: undefined, patientInstruction: undefined, additionalInstruction: undefined };
      for (const input of [dosage, toDosageDetails([dosage]), toFhirR5Dosages(toDosageDetails([dosage]))]) {
        expect(nextDueDoses(input, options)).toEqual([]);
        expect(calculateTotalUnits({ ...options, dosage: input,
          durationValue: 1, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(0);
      }
      expect(parsed.longText.toLowerCase()).toContain(activity);
    }
  );

  it.each(["patientInstruction", "additionalInstruction"] as const)(
    "does not let imported %s veto a structured one-time dated dose", field => {
      const advice = "Do not drive after taking.";
      const dosage: FhirDosage = {
        timing: { repeat: { count: 1, boundsPeriod: { start: options.orderedAt } } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        ...(field === "patientInstruction" ? { patientInstruction: advice } : { additionalInstruction: [{ text: advice }] })
      };
      expect(nextDueDoses(dosage, options)).toEqual(["2026-11-02T08:00:00+07:00"]);
      expect(calculateTotalUnits({ ...options, dosage,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(1);
    }
  );
});

describe("Thai one-time event ownership", () => {
  it.each([
    { input: "รับประทาน 1 เม็ด ครั้งเดียวหลังฟอกไต", due: [], activity: true },
    { input: "รับประทาน 1 เม็ด ครั้งเดียว ห้ามขับรถหลังรับประทานยา", due: ["2026-11-02T08:00:00+07:00"], activity: false }
  ])("keeps activity timing distinct from separate counseling: $input", ({ input, due, activity }) => {
    const parsed = parseSig(input, { locale: "th" });
    expect(Boolean(parsed.meta.canonical.clauses[0].schedule?.activityTiming?.length)).toBe(activity);
    for (const dosage of [parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, {
        timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T08:00:00+07:00",
        from: "2026-11-02T08:00:00+07:00", limit: 1
      })).toEqual(due);
    }
    expect(parsed.input).toBe(input);
  });
});


describe("selective withholding targets individual administrations", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  it.each([
    ["Take 1 tablet at 08:00 and 20:00 daily, but hold only the 20:00 dose if blood pressure is below 100 mmHg.", "08:00"],
    ["Take 1 tablet at 08:00 and 20:00 daily, but hold only the 08:00 dose if blood pressure is below 100 mmHg.", "20:00"],
    ["Take 1 tablet at 08:00 and 20:00 daily, but hold the evening dose if blood pressure is below 100 mmHg.", "08:00"],
    ["Take 1 tablet at 08:00 and 20:00 daily. If blood pressure is below 100 mmHg, hold the evening dose only.", "08:00"],
    ["Take 1 tablet at 08:00 and 20:00 daily, but hold 20:00 if blood pressure is below 100 mmHg.", "08:00"],
    ["Take 1 tablet at 08:00 and 20:00 daily, but hold only 20:00 if blood pressure is below 100 mmHg.", "08:00"],
    ["Take 1 tablet at 08:00 and 20:00 daily. Omit PM if blood pressure is below 100 mmHg.", "08:00"]
  ])("does not suppress the unaffected scheduled dose: %s", (input, unaffected) => {
    const parsed = parseSig(input);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (bp: number) => nextDueDoses(dosage, {
        orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 6,
        evaluateCondition: condition => evaluateMedicationCondition(condition, { "blood pressure": bp })
      }).filter(value => value.startsWith("2026-11-02")).map(value => value.slice(11,16));
      expect(on(90)).toEqual([unaffected]);
      expect(on(110)).toEqual(["08:00", "20:00"]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
    expect(parsed.fhirNext.step[0].component).toHaveLength(2);
  });

  it.each([
    "Take 1 tablet at 08:00 and 20:00 every day, except omit the evening dose on Sundays.",
    "Take 1 tablet at 08:00 and 20:00 every day, except omit the 20:00 dose on Sundays.",
    "Take 1 tablet at 08:00 and 20:00 every day. Omit the evening dose every Sunday.",
    "Take 1 tablet at 08:00 and 20:00 every day. On Sundays omit the 20:00 dose.",
    "Take 1 tablet at 08:00 and 20:00 every day; skip 20:00 on Sundays.",
    "Take 1 tablet at 08:00 and 20:00 every day. Do not take the evening tablet on Sundays."
  ])("keeps morning dosing on a day with a selected evening omission: %s", input => {
    const parsed = parseSig(input);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (day: string) => nextDueDoses(dosage, {
        orderedAt, from: day + "T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 6
      }).filter(value => value.startsWith(day)).map(value => value.slice(11,16));
      expect(on("2026-11-08")).toEqual(["08:00"]);
      expect(on("2026-11-09")).toEqual(["08:00", "20:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 7, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(13);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });
  it("retains both slots of an explicit all-dose hold and does not reinterpret a physical hold", () => {
    const all = parseSig("Take 1 tablet at 08:00 and 20:00 daily; hold all doses if blood pressure is below 100 mmHg.");
    const base = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 3 };
    expect(nextDueDoses(all.fhirNext, { ...base, evaluateCondition: condition =>
      evaluateMedicationCondition(condition, { "blood pressure": 90 }) })).toEqual([]);
    const physical = parseSig("Take 1 tablet at 08:00 and 20:00 daily. Hold your breath during inhalation.");
    expect(nextDueDoses(physical.fhirNext, { ...base, evaluateCondition: () => false })
      .filter(value => value.startsWith("2026-11-02")).map(value => value.slice(11,16)))
      .toEqual(["08:00", "20:00"]);
  });

  it("partitions a selected meal-event dose without losing its before-meal relation", () => {
    const source = "Take 1 tablet before breakfast and dinner daily; hold the dinner dose if blood pressure is below 100 mmHg.";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.step[0].component.map(component => component.timing?.repeat?.when))
      .toEqual([["ACM"], ["ACV"]]);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const base = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok",
        eventClock: { CM: "08:00", CV: "18:00" }, limit: 5 };
      const on = (bp: number) => nextDueDoses(dosage, { ...base,
        evaluateCondition: condition => evaluateMedicationCondition(condition, { "blood pressure": bp })
      }).filter(value => value.startsWith("2026-11-02")).map(value => value.slice(11,16));
      // No numeric offset was supplied: preserve the relative event codes
      // while using the configured anchors, rather than inventing 30 minutes.
      expect(on(90)).toEqual(["08:00"]);
      expect(on(110)).toEqual(["08:00", "18:00"]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

});


describe("symptom-conditioned withholding keeps positive PRN distinct", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const evaluate = (present: boolean) => (condition: MedicationCondition): boolean => {
    const visit = (value: MedicationCondition): boolean => value.kind === "not" ? !visit(value.condition) :
      value.kind === "all" ? value.conditions.every(visit) :
      value.kind === "any" ? value.conditions.some(visit) : present;
    return visit(condition);
  };
  it.each([
    "Take 1 tablet at 08:00 daily. If dizzy, hold the morning dose.",
    "Take 1 tablet at 08:00 daily. On days with dizziness, hold the morning dose.",
    "Take 1 tablet at 08:00 daily. If dizzy, omit the morning dose."
  ])("uses the existing typed withholding action to license the conditional predicate: %s", source => {
    const parsed = parsePublicSig(source);
    for (const dosage of [parsed.fhirNext, parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      const options = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 2 };
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: evaluate(true) })).toEqual([]);
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: evaluate(false) })[0])
        .toBe("2026-11-02T08:00:00+07:00");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
  it.each([
    "Take 1 tablet at 08:00 daily. If dizzy, hold your breath.",
    "Take 1 tablet at 08:00 daily. If dizzy, do not hold the morning dose."
  ])("does not invent a medication-withholding guard for a different action sense: %s", source => {
    const parsed = parsePublicSig(source);
    expect(nextDueDoses(parsed.fhirNext, { orderedAt, from: orderedAt,
      timeZone: "Asia/Bangkok", limit: 1, evaluateCondition: evaluate(true) })[0])
      .toBe("2026-11-02T08:00:00+07:00");
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("later counseling never changes an earlier selective withholding guard", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  it.each(["avoid alcohol", "งดสุรา", "ห้ามขับรถหลังรับประทานยา", "do not drive"])(
    "keeps the clinical guard and dose target when adding unrelated counseling: %s", advice => {
      const input = "1 tab PO at 08:00 and 20:00 x14d; HOLD 20:00 dose if SBP <100; " + advice;
      const parsed = parsePublicSig(input);
      for (const dosage of [parsed.fhirNext, parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
        for (const sbp of [90, 130]) {
          const options = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok",
            evaluateCondition: (condition: MedicationCondition) => evaluateMedicationCondition(condition, { sbp }), limit: 4 };
          expect(nextDueDoses(dosage, options).filter(value => value.startsWith("2026-11-02"))
            .map(value => value.slice(11,16))).toEqual(sbp < 100 ? ["08:00"] : ["08:00", "20:00"]);
          expect(calculateTotalUnits({ dosage, ...options, durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits)
            .toBe(sbp < 100 ? 14 : 28);
        }
      }
      expect(parsed.fhirNext.renderedInstruction).toBe(input);
    }
  );
});

describe("elapsed intervals retain a single explicit clock as their phase anchor", () => {
  const start = "2026-11-02T00:00:00+07:00";
  const base = { orderedAt: start, from: start, timeZone: "Asia/Bangkok", limit: 40 };
  it.each([
    ["1 tab PO q48h at 08:00 x14d", 48, "08:00:00", 14, 7],
    ["1 tab PO q12h at 08:00 x7d", 12, "08:00:00", 7, 14],
    ["1 tab PO q8h at 06:00 x7d", 8, "06:00:00", 7, 21]
  ] as const)("does not degrade %s into one dose every day", (input, hours, clock, days, total) => {
    const parsed = parseSig(input);
    const plain: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: hours, periodUnit: FhirPeriodUnit.Hour,
        timeOfDay: [clock], boundsDuration: { value: days, unit: "d", code: "d" } } } };
    const course = toDosageDetails([parsed.fhir]);
    const anchor = new Date("2026-11-02T" + clock + "+07:00").getTime();
    const expected = Array.from({ length: total }, (_, i) => anchor + i * hours * 3600000);
    for (const dosage of [plain, parsed.fhir, course, toFhirR5Dosages(course), toDosageDetails(toFhirR5Dosages(course))]) {
      expect(nextDueDoses(dosage, base).map(Date.parse)).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...base, durationValue: days, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(total);
    }
  });

  it("does not reanchor a 48-hour regimen when querying a later day", () => {
    const dosage = parseSig("1 tab PO q48h at 08:00 x14d").fhir;
    expect(nextDueDoses(dosage, { ...base, from: "2026-11-03T00:00:00+07:00", limit: 2 })).toEqual([
      "2026-11-04T08:00:00+07:00", "2026-11-06T08:00:00+07:00"
    ]);
  });

  it("derives prior count from the interval rather than one occurrence per clock day", () => {
    const dosage: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count: 3, period: 12, periodUnit: FhirPeriodUnit.Hour, timeOfDay: ["08:00:00"] } } };
    const options = { ...base, from: "2026-11-03T00:00:00+07:00" };
    expect(nextDueDoses(dosage, options)).toEqual(["2026-11-03T08:00:00+07:00"]);
    expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
  });

  it("starts a new explicit-clock interval at each finite phase boundary", () => {
    const parsed = parseSig("1 tab PO q12h at 08:00 x7d then 1 tab PO q24h at 08:00 x7d");
    const course = toDosageDetails(parsed.items.map(item => item.fhir));
    for (const dosage of [course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(dosage, { ...base, limit: 2 })).toEqual([
        "2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00"
      ]);
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00", limit: 2 })).toEqual([
        "2026-11-09T08:00:00+07:00", "2026-11-10T08:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }
  });

  it("honors treatment onset and preserves ordinary calendar-day and explicit-list schedules", () => {
    const hourly = parseSig("1 tab PO q12h at 08:00 x7d").fhir;
    expect(nextDueDoses(hourly, { ...base, orderedAt: "2026-11-02T12:00:00+07:00", from: "2026-11-02T12:00:00+07:00", limit: 2 })).toEqual([
      "2026-11-03T08:00:00+07:00", "2026-11-03T20:00:00+07:00"
    ]);
    expect(calculateTotalUnits({ dosage: parseSig("1 tab PO qod at 08:00 x14d").fhir,
      ...base, durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
    expect(calculateTotalUnits({ dosage: parseSig("1 tab PO at 08:00 and 20:00 x7d").fhir,
      ...base, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(14);
  });

  it("keeps hourly elapsed intervals distinct from daily wall-clock lists across DST", () => {
    const options = { timeZone: "America/New_York", orderedAt: "2024-03-09T00:00:00-05:00", from: "2024-03-09T00:00:00-05:00", limit: 4 };
    const hourly = parseSig("1 tab PO q12h at 08:00 x3d").fhir;
    expect(nextDueDoses(hourly, options)).toEqual([
      "2024-03-09T08:00:00-05:00", "2024-03-09T20:00:00-05:00",
      "2024-03-10T09:00:00-04:00", "2024-03-10T21:00:00-04:00"
    ]);
    const clocks = parseSig("1 tab PO at 08:00 and 20:00 x3d").fhir;
    expect(nextDueDoses(clocks, options)).toEqual([
      "2024-03-09T08:00:00-05:00", "2024-03-09T20:00:00-05:00",
      "2024-03-10T08:00:00-04:00", "2024-03-10T20:00:00-04:00"
    ]);
  });
});


describe("registered medication nouns in withholding conditions", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  it.each([
    "1 tab PO at 08:00 x7d; งดยาหาก SBP <90",
    "1 tab PO at 08:00 x7d; ถ้า SBP<90 ให้งดยา",
    "1 tab PO at 08:00 x7d; avoid medication if SBP <90"
  ])("binds a conditional registered avoidance action to the prescribed medication: %s", source => {
    const parsed = parsePublicSig(source);
    for (const dosage of [parsed.fhirNext, parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (sbp: number) => nextDueDoses(dosage, { orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", limit: 2,
        evaluateCondition: condition => evaluateMedicationCondition(condition, { sbp }) });
      expect(on(80)).toEqual([]);
      expect(on(130)[0]).toBe("2026-11-02T08:00:00+07:00");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("retains Thai symptom-condition withholding on the medication object", () => {
    const source = "1 tab PO at 08:00 x7d; ถ้าเวียนศีรษะ ให้งดยา";
    const parsed = parsePublicSig(source);
    const evaluator = (present: boolean) => (condition: MedicationCondition) =>
      condition.kind === "not" ? !present : present;
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const options = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 2 };
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: evaluator(true) })).toEqual([]);
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: evaluator(false) })[0]).toContain("08:00:00");
    }
  });

  it("uses the same contextual-day daughter as an inverse guard under HOLD", () => {
    const source = "1 tab PO at 08:00 x7d; HOLD on dialysis days";
    const parsed = parsePublicSig(source);
    const evaluate = (member: boolean) => (condition: MedicationCondition) => condition.kind === "not" ? !member : member;
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const options = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 2 };
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: evaluate(true) })).toEqual([]);
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: evaluate(false) })[0]).toContain("08:00:00");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each(["avoid food if SBP <90", "hold your breath if SBP <90", "hold your breath on dialysis days"])(
    "does not turn a different procedural object into a medication guard: %s", advice => {
      const parsed = parsePublicSig("1 tab PO at 08:00 x7d; " + advice);
      expect(nextDueDoses(parsed.fhirNext, { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 1,
        evaluateCondition: () => false })[0]).toBe("2026-11-02T08:00:00+07:00");
    }
  );

  it("keeps a second PRN administration's explicit numeric IF separate from its standing dose", () => {
    const source = "1 tab PO at 08:00 x14d; 0.5 tab PO at 20:00 PRN if SBP >160";
    const parsed = parsePublicSig(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) for (const sbp of [130, 170]) {
      const due = nextDueDoses(dosage, { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 4,
        evaluateCondition: condition => evaluateMedicationCondition(condition, { sbp })
      }).filter(value => value.startsWith("2026-11-02")).map(value => value.slice(11,16));
      expect(due).toEqual(sbp > 160 ? ["08:00", "20:00"] : ["08:00"]);
    }
  });
});


describe("conditional counseling keeps the standing medication scheduled", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  it.each([
    "รับประทานก่อนอาหาร หากคลื่นไส้ให้รับประทานพร้อมอาหาร",
    "หากคลื่นไส้ให้แจ้งแพทย์",
    "if nauseated, contact the doctor"
  ])("keeps a conditional advice action out of the standing dose's PRN/timing: %s", advice => {
    const source = "1 tab PO at 07:00,12:00,18:00 x7d; " + advice;
    const parsed = parsePublicSig(source);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].asNeeded).not.toBe(true);
    expect(parsed.fhir[0].asNeededFor).toBeUndefined();
    expect(parsed.fhir[0].timing?.repeat?.when ?? []).not.toContain("C");
    for (const dosage of [parsed.fhirNext, parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 3,
        evaluateCondition: () => false }).map(value => value.slice(11,16)))
        .toEqual(["07:00", "12:00", "18:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("does not let later advice arguments erase a preceding numeric HOLD predicate", () => {
    const source = "1 tab PO qAM; HOLD if SBP <100 mmHg; วัดความดันก่อนกินยา หากเวียนศีรษะให้ติดต่อแพทย์";
    const parsed = parsePublicSig(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const options = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", eventClock: { MORN: "08:00" }, limit: 1 };
      expect(nextDueDoses(dosage, { ...options,
        evaluateCondition: condition => evaluateMedicationCondition(condition, { sbp: 90 }) })).toEqual([]);
      expect(nextDueDoses(dosage, { ...options,
        evaluateCondition: condition => evaluateMedicationCondition(condition, { sbp: 130 }) })[0])
        .toBe("2026-11-02T08:00:00+07:00");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each(["Take 1 tablet if nausea.", "If nausea, take 1 tablet.", "Take 1 tablet PRN nausea."])(
    "keeps a genuinely conditional medication administration PRN: %s", source => {
      expect(parsePublicSig(source).fhir[0].asNeeded).toBe(true);
    }
  );
});
