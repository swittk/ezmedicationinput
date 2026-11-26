import type { MedicationCondition } from "../src/types";
import { describe, expect, it } from "vitest";
import { parseSig as parsePublicSig, nextDueDoses, calculateTotalUnits, evaluateMedicationCondition, toDosageDetails, toFhirR5Dosages, formatSig, formatParseBatch } from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { TIMING_EVENT_WINDOW_EXTENSION_URL } from "../src/fhir";
import { COURSE_CYCLE_COUNT_EXTENSION_URL, getCourseCycleCount } from "../src/dosage-course";
import {
  EventTiming, FhirDosage, FhirR6DosageInstruction, NextDueDoseOptions,
  FhirPeriodUnit, FhirDayOfWeek
} from "../src/types";
import { normalizeClock } from "../src/execution/calendar";
import { lexInput } from "../src/lexer/lex";
import { parseClauseState } from "../src/parser";
import { createBoundaryPlan } from "../src/regimen/planner";
import { buildRegimenGraph } from "../src/regimen/regimen";
import { scopeSequentialPhaseSemantics } from "../src/regimen/regimen";
import { anchoredScheduleDurationEnd } from "../src/regimen/regimen";
import { buildCanonicalParallelRegimen } from "../src/regimen/parallel-course";
import { projectParallelRegimen } from "../src/regimen/parallel-course";
import { courseFromAdministrations } from "../src/canonical/compile";
import { clauseForAdministration } from "../src/canonical/compile";
import { courseFromPartialParallel } from "../src/canonical/compile";
import { courseToR5 } from "../src/adapters/canonical-course";
import { courseToR6 } from "../src/adapters/canonical-course";
import { courseFromR6 } from "../src/adapters/canonical-course";
import { toEzDosages } from "../src/index";
import { fromFhir } from "../src/index";
import { TIMING_OCCURRENCE_CAP_EXTENSION_URL } from "../src/index";
import { projectCanonicalCourse } from "../src/index";
import { importCanonicalCourse } from "../src/index";
import type { CanonicalAdministration } from "../src/canonical/course";
import type { CanonicalCourse } from "../src/canonical/course";
import type { CanonicalBoundary } from "../src/canonical/course";
import { FhirPeriodUnit as Unit } from "../src/types";
import { describe as round38_execution20_describe } from "vitest";
import { expect as round38_execution20_expect } from "vitest";
import { it as round38_execution20_it } from "vitest";
import { calculateTotalUnits as round38_execution20_calculateTotalUnits } from "../src/index";
import { nextDueDoses as round38_execution20_nextDueDoses } from "../src/index";
import { parseSig as round38_execution20_parseSig } from "../src/index";
import { toFhirR5Dosages as round38_execution20_toFhirR5Dosages } from "../src/index";
import type { CanonicalAdministration as round38_execution20_CanonicalAdministration } from "../src/canonical/course";
import type { CanonicalCourse as round38_execution20_CanonicalCourse } from "../src/canonical/course";
import { FhirPeriodUnit as round38_execution20_FhirPeriodUnit } from "../src/types";
import type { FhirDosage as round38_execution20_FhirDosage } from "../src/types";
import type { FhirR6DosageInstruction as round38_execution20_FhirR6DosageInstruction } from "../src/types";
import { addCalendarDaysAtClock as round38_execution20_addCalendarDaysAtClock } from "../src/execution/calendar";
import { addCalendarMonths as round38_execution20_addCalendarMonths } from "../src/execution/calendar";
import { getTimeParts as round38_execution20_getTimeParts } from "../src/execution/calendar";

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

  it("reports one-time activity capacity without inventing a scheduled dose", () => {
    const parsed = parseSig("insert 1 tab pv once after menstruation ends", {
      context: { dosageForm: "tab" }
    });
    const options = {
      dosage: parsed.fhir,
      from: "2024-01-01T09:00:00Z",
      durationValue: 30,
      durationUnit: FhirPeriodUnit.Day,
      timeZone: "UTC"
    };
    expect(nextDueDoses(parsed.fhir, options)).toEqual([]);
    expect(calculateTotalUnits(options)).toMatchObject({
      totalUnits: 1, quantityKind: "maximum"
    });
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
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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
    const course: FhirR6DosageInstruction = {
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
  const course: FhirR6DosageInstruction = {
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

  it("admits overnight administrations after a midnight order", () => {
    for (const dosage of variants) {
      expect(nextDueDoses(dosage, {
        ...options,
        from: "2026-11-02T00:00:00+07:00",
        limit: 4
      })).toEqual([
        "2026-11-02T01:00:00+07:00",
        "2026-11-02T04:00:00+07:00",
        "2026-11-02T22:00:00+07:00",
        "2026-11-03T01:00:00+07:00"
      ]);
    }
  });

  it("anchors weekday filtering to the waking date rather than post-midnight clock date", () => {
    const mondayCourse: FhirR6DosageInstruction = {
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
      }).totalUnits).toBe(6);
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
  const makeCycle = (start: number, end: number): FhirR6DosageInstruction => ({
    repeatCycle: { value: 14, unit: "d", code: "d" },
    step: [{ start: relative(start), end: relative(end), component: [{
      timing: { repeat: { timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }]
  });
  const on = (dosage: FhirR6DosageInstruction | FhirDosage[], day: string) =>
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
    expect(getCourseCycleCount(parsed.fhirNext)).toBe(3);
    expect(parsed.fhirNext.step[0].count).toBeUndefined();
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
    course.modifierExtension = [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }];
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
      expect(getCourseCycleCount(parsed.fhirNext)).toBe(3);
      expect(parsed.fhirNext.step[0].count).toBeUndefined();
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
    course.modifierExtension = [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: count }];
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
    const delayed: FhirR6DosageInstruction = { step: [{
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
        })).toMatchObject({
          totalUnits: 1, unit: "tab", quantityKind: "maximum",
          explanation: expect.stringContaining("activity trigger")
        });
      }
      expect(parsed.longText.toLowerCase()).toContain(activity);
    }
  );

  it("keeps a one-time unresolved activity as future supply capacity, not a timed event", () => {
    const dosage = parseSig("Insert 1 tablet vaginally once after menstruation ends.").fhir;
    const base = { ...options, from: "2026-11-10T08:00:00+07:00",
      durationValue: 1, durationUnit: FhirPeriodUnit.Day };
    expect(nextDueDoses(dosage, base)).toEqual([]);
    expect(calculateTotalUnits({ ...base, dosage })).toMatchObject({
      totalUnits: 1, quantityKind: "maximum"
    });
    expect(calculateTotalUnits({ ...base, dosage, priorCount: 1 })).toMatchObject({
      totalUnits: 0, quantityKind: "maximum"
    });
    expect(calculateTotalUnits({ ...base, dosage,
      priorDoseTimes: ["2026-11-03T08:00:00+07:00"]
    })).toMatchObject({ totalUnits: 0, quantityKind: "maximum" });
    expect(calculateTotalUnits({ ...base, dosage,
      from: "2026-11-01T08:00:00+07:00"
    })).toMatchObject({ totalUnits: 0, quantityKind: "maximum" });
  });

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


{

const parseSig = parsePublicSig;


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
    const day = unit === Unit.Day ? "2026-01-02" : "2026-01-08";
    const input = dose(); input.schedule = { explicitEvents: [
      day + "T12:00:00.250Z", day + "T12:00:00.500Z",
    ] };
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
      expect(supply(course, 95, { from: "2026-01-01T09:00:00Z", durationUnit: Unit.Hour,
        priorDoseTimes: ["2026-01-01T08:00:00Z"] }).totalUnits).toBe(0);
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
    const currentR6: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: row.doseAndRate, timing: row.timing,
    }] }] };
    for (const input of [row, currentR6]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
  it.each([
    { period: 24, periodUnit: Unit.Hour },
    { period: 1, periodUnit: Unit.Week },
    { frequency: 2, periodUnit: Unit.Hour },
  ])("completes BID by dimensional cadence with partial repeat %j", repeat => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID" }] },
        repeat } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: row.doseAndRate, timing: row.timing }] }] };
    for (const dosage of [row, r6]) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([
    { name: "authored hours", repeat: { period: 2, periodUnit: Unit.Hour } },
    { name: "equivalent minutes", repeat: { period: 120, periodUnit: Unit.Minute } },
    { name: "frequency only", repeat: { frequency: 1 } },
    { name: "period only", repeat: { period: 2 } },
    { name: "unit only", repeat: { periodUnit: Unit.Minute } },
  ])("keeps hourly interval meaning with $name", ({ repeat }) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: {
      code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "Q2H" }] },
      repeat,
    } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: row.doseAndRate, timing: row.timing }] }] };
    for (const dosage of [row, r6]) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, limit: 4 })).toEqual([
        "2026-01-01T00:00:00+00:00", "2026-01-01T02:00:00+00:00",
        "2026-01-01T04:00:00+00:00", "2026-01-01T06:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(24);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each(["foreign", "conflicting"] as const)("retains the existing %s timing code boundary during cadence completion", variant => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: {
      code: { coding: [{ system: variant === "foreign" ? "urn:clinic:timing"
        : "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID" }] },
      repeat: { period: 24, periodUnit: Unit.Hour, ...(variant === "conflicting" ? { frequency: 1 } : {}) },
    } };
    const before = JSON.stringify(row);
    if (variant === "foreign") {
      expect(nextDueDoses(row, { ...options, limit: 2 })).toEqual([
        "2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: row, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(2);
    } else {
      expect(() => nextDueDoses(row, { ...options, limit: 2 })).toThrow(/timing code.*repeat/i);
      expect(() => calculateTotalUnits({ ...options, dosage: row, durationValue: 2, durationUnit: Unit.Day }))
        .toThrow(/timing code.*repeat/i);
    }
    expect(JSON.stringify(row)).toBe(before);
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

  it("uses recorded cycle history once while preserving independent overlapping opportunities", () => {
    const member = dose(); member.schedule!.recurrence!.clocks = ["08:00:00"];
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 48, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    const query = { ...options, from: "2026-01-02T00:00:00Z", limit: 1 };
    for (const input of [course, courseToR5(course), courseToR6(course)]) {
      const recorded = { ...query, priorDoseTimes: ["2026-01-01T08:00:00Z"] };
      expect(nextDueDoses(input, recorded)).toEqual(["2026-01-02T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...recorded, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      const earlierActual = { ...query, priorDoseTimes: ["2026-01-01T07:00:00Z"] };
      expect(nextDueDoses(input, earlierActual)).toEqual(["2026-01-02T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...earlierActual, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
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
      QID: ["08:00", "12:00", "16:00", "20:00"], AM: ["08:00"], PM: ["15:00"], QOD: ["09:00"] };
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

describe("round74 duration terminology ownership", () => {
  it.each([
    [{ value: 60, code: "S", system: "http://unitsofmeasure.org" }, true],
    [{ value: 60, code: "s", system: "urn:clinic:duration" }, true],
    [{ value: 60, code: "s", system: "http://unitsofmeasure.org" }, false],
    [{ value: 60, unit: "SECONDS" }, false],
    [{ value: 10, unit: "hours" }, true]
  ] as const)("preserves the course-length unit identity %j", (quantity, admitted) => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["09:00:00"], boundsDuration: quantity } }
    }] }] };
    const rows = toFhirR5Dosages(source), before = JSON.stringify(source);
    for (const input of [source, rows, courseFromR6(source)]) {
      const unresolved = "system" in quantity && (quantity.system !== "http://unitsofmeasure.org" || quantity.code === "S");
      if (unresolved) {
        expect(() => nextDueDoses(input, { ...options, limit: 1 }))
          .toThrow(expect.objectContaining({ code: "course-duration-unresolved" }));
        expect(() => calculateTotalUnits({ dosage: input, ...options, durationValue: 10, durationUnit: Unit.Hour }))
          .toThrow(expect.objectContaining({ code: "course-duration-unresolved" }));
      } else {
        expect(nextDueDoses(input, { ...options, limit: 1 })).toEqual(admitted ? ["2026-01-01T09:00:00+00:00"] : []);
        expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 10, durationUnit: Unit.Hour }).totalUnits)
          .toBe(admitted ? 1 : 0);
      }
    }
    expect(toDosageDetails(rows).step[0].component[0].timing!.repeat!.boundsDuration).toEqual(quantity);
    expect(JSON.stringify(source)).toBe(before);
  });


  it.each(["none", "count", "end"] as const)("does not ignore an unknown upper course duration beside %s", boundary => {
    const authored = { value: 3, unit: "treatment blocks", system: "urn:clinic:duration", code: "d",
      extension: [{ url: "urn:clinic:duration-note", valueString: "Preserve the prescribed duration" }] };
    const source: FhirR6DosageInstruction = { step: [{
      ...(boundary === "end" ? { end: { contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
      }] }, offsetDuration: { value: 2, unit: "d", system: "http://unitsofmeasure.org", code: "d" } } } : {}),
      component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"],
        ...(boundary === "count" ? { count: 2 } : {}), boundsDuration: authored,
      } } }],
    }] };
    for (const input of [freshExecutionInput(source), courseFromR6(freshExecutionInput(source)),
      freshExecutionInput(toFhirR5Dosages(source))]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("treatment blocks");
      expect(() => nextDueDoses(input, { ...options, limit: 5 }))
        .toThrow(expect.objectContaining({ code: "course-duration-unresolved" }));
      expect(() => calculateTotalUnits({ dosage: input, ...options, durationValue: 5, durationUnit: Unit.Day }))
        .toThrow(expect.objectContaining({ code: "course-duration-unresolved" }));
      expect(projectCanonicalCourse(importCanonicalCourse(input)).fhirNext.step[0].component[0].timing?.repeat?.boundsDuration)
        .toEqual(authored);
      expect(JSON.stringify(input)).toBe(before);
    }
    const known = freshExecutionInput(source);
    known.step![0].component[0].timing!.repeat!.boundsDuration = { ...authored, unit: "days", system: "http://unitsofmeasure.org" };
    const expected = boundary === "none" ? 3 : 2;
    expect(nextDueDoses(known, { ...options, limit: 5 })).toEqual(Array.from({ length: expected },
      (_, day) => "2026-01-0" + (day + 1) + "T09:00:00+00:00"));
    expect(calculateTotalUnits({ dosage: known, ...options, durationValue: 5, durationUnit: Unit.Day }))
      .toMatchObject({ totalUnits: expected, unit: "tab" });
  });

  it.each(["S", "s"])("keeps an unknown coded repeat cycle unresolved (%s)", code => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 60, code,
      system: code === "S" ? "http://unitsofmeasure.org" : "urn:clinic:duration" },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: { count: 1 } } }] }] };
    for (const input of [source, toFhirR5Dosages(source), courseFromR6(source)]) {
      expect(() => nextDueDoses(input, { ...options, limit: 2 })).toThrow(/cycle/i);
      expect(() => calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day })).toThrow(/cycle/i);
    }
  });
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

  it.each(versions)("resolves Vienna authored clocks to the first fold instant (%s)", version => {
    const member = dose();
    member.schedule!.recurrence = { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["02:30:00"] };
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [member] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    const query = { orderedAt: "2026-10-25T00:00:00Z", from: "2026-10-25T00:00:00Z", timeZone: "Europe/Vienna" };
    expect(nextDueDoses(input, { ...query, limit: 2 })).toEqual([
      "2026-10-25T02:30:00+02:00", "2026-10-26T02:30:00+01:00"
    ]);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...query, from: "2026-10-25T01:00:00Z", limit: 1 }))
      .toEqual(["2026-10-26T02:30:00+01:00"]);
    const gap = { orderedAt: "2026-03-29T00:00:00Z", from: "2026-03-29T00:00:00Z", timeZone: "Europe/Vienna" };
    expect(nextDueDoses(input, { ...gap, limit: 1 })).toEqual(["2026-03-30T02:30:00+02:00"]);
    expect(calculateTotalUnits({ dosage: input, ...gap, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(JSON.stringify(input)).toBe(before);
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

  it.each(versions)("combines independent member clock plans across fixed overlapping cycles (%s)", version => {
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
    // Jan 2 is shared by both cycles. A's authored 06:00 and B's inferred
    // 08:00 are independently feasible: each spends only its own 24-hour cap.
    // Their fixed two-day windows do not couple those clock choices.
    expect(calculateTotalUnits({ ...query, dosage: input }).totalUnits).toBe(2);
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
    const excludedCourse = freshExecutionInput(course);
    excludedCourse.stages[0].administrations[0].excludedDates = ["2026-01-03"];
    const excluded = wire(excludedCourse, version);
    expect(nextDueDoses(excluded, { ...options, limit: 4 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: excluded, ...options, durationValue: 5, durationUnit: Unit.Day }).totalUnits).toBe(4);
    // A whole-course repeat uses the same count admission without running
    // supply maximization when the caller only requests administration clocks.
    const repeatedCourse = freshExecutionInput(excludedCourse);
    repeatedCourse.cycleInterval = { value: 7, unit: "d" }; repeatedCourse.cycleCount = 1;
    expect(nextDueDoses(wire(repeatedCourse, version), { ...options, limit: 4 })).toEqual([
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
    const strictCourse = freshExecutionInput(course), strictLoading = strictCourse.stages[0].administrations[0];
    strictLoading.amounts![0].range!.low = { value: 1, unit: "tab", comparator: ">" };
    strictLoading.limits![0].amount!.value = 2;
    const input = wire(strictCourse, version), before = JSON.stringify(input);
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
}


describe("phase-local supplied count ownership", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const forms = (course: CanonicalCourse) => [course, fresh(courseToR5(course)),
    fresh(courseToR6(course)), fresh(toFhirR5Dosages(courseToR6(course)))];
  const infusion = (dated: boolean) => parsePublicSig("Infuse 100 mL over 2 hours" +
    (dated ? " starting 2026-11-22 at 08:00" : "") + ", then infuse 50 mL over 1 hour")
    .meta.canonical.course!;

  it.each([false, true])("preserves single-administration completion with an explicit zero count (%s)", dated => {
    const query = { orderedAt: dated ? "2026-11-22T00:00:00Z" : "2026-11-22T08:00:00Z",
      from: "2026-11-22T08:00:00Z", timeZone: "UTC", priorCount: 0, limit: 4 };
    for (const dosage of forms(infusion(dated))) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-11-22T08:00:00+00:00", "2026-11-22T10:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 150, unit: "mL" });
    }
  });

  it.each([{ dated: false, hour: "09" }, { dated: true, hour: "09" }, { dated: true, hour: "10" }])(
    "does not charge recorded loading use to a future infusion ($dated at $hour)", ({ dated, hour }) => {
    const query = { orderedAt: dated ? "2026-11-22T00:00:00Z" : "2026-11-22T08:00:00Z",
      from: "2026-11-22T" + hour + ":00:00Z", timeZone: "UTC", priorCount: 1,
      priorDoseTimes: ["2026-11-22T08:00:00Z"], limit: 4 };
    for (const dosage of forms(infusion(dated))) {
      expect(nextDueDoses(dosage, query)).toEqual(["2026-11-22T10:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 50, unit: "mL" });
    }
  });

  it.each([false, true])("keeps the future finite course's entire scalar or ranged allowance (%s)", ranged => {
    const note = { url: "urn:clinical:phase-history", valueString: "Retain the authored phase" };
    const amount = (value: number) => ranged
      ? { doseRange: { low: { value, unit: "tab" }, high: { value: value * 2, unit: "tab" } } }
      : { doseQuantity: { value, unit: "tab" } };
    const rows: FhirDosage[] = [1, 2].map(value => ({ sequence: value, extension: [note],
      doseAndRate: [amount(value)], timing: { repeat: { count: 2,
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"] } } }));
    const course = importCanonicalCourse(fresh(rows));
    const query = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-02T00:00:00Z",
      timeZone: "UTC", priorCount: 1, priorDoseTimes: ["2026-01-01T09:00:00Z"], limit: 5 };
    for (const options of [query, { from: query.from, timeZone: "UTC", priorCount: 1, limit: 5 }]) {
      for (const dosage of forms(course)) {
        expect(nextDueDoses(dosage, options)).toEqual([
          "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 4, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: ranged ? 10 : 5, unit: "tab" });
      }
    }
    expect(courseToR5(course)[1].extension).toContainEqual(note);
  });
});


describe("authored immediate start and integer sequence execution", () => {
  it.each([true, false])("uses the authored start for an immediate dose with an earlier order (%s)", explicitOrder => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count: 1, when: [EventTiming.Immediate],
        boundsPeriod: { start: "2026-12-05T08:00:00Z" } } } };
    const options = { from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 3,
      ...(explicitOrder ? { orderedAt: "2026-12-04T00:00:00Z" } : {}) };
    for (const dosage of [row, [row], { step: [{ component: [row] }] }]) {
      expect(nextDueDoses(dosage, options)).toEqual(["2026-12-05T08:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    }
  });

  it("keeps single-row and array supply for an authored zero sequence", () => {
    const row: FhirDosage = { sequence: 0, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"] } } };
    const query = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 1 };
    for (const dosage of [row, [row]]) {
      expect(nextDueDoses(dosage, query)).toEqual(["2026-01-01T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    }
    expect(row.sequence).toBe(0);
  });

  it.each([-2, 0, 1])("orders distinct integer sequences and keeps equal values concurrent (%s)", first => {
    const row = (sequence: number, value: number): FhirDosage => ({ sequence,
      doseAndRate: [{ doseQuantity: { value, unit: "tab" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"] } } });
    const dosage = [row(first + 2, 4), row(first, 1), row(first, 2)];
    const query = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 4 };
    expect(nextDueDoses(dosage, query)).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(7);
    expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(calculateTotalUnits({ dosage, ...query, from: "2026-01-02T00:00:00Z",
      durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(4);
    expect(dosage.map(item => item.sequence)).toEqual([first + 2, first, first]);
  });
});


describe("ordinary recurrence and partial-event supply boundaries", () => {
  const options = { orderedAt: "2027-01-01T00:00:00Z", from: "2027-01-01T00:00:00Z", timeZone: "UTC" };
  const forms = (course: CanonicalCourse) => [course, courseToR5(course), courseToR6(course)];
  const member = (): CanonicalAdministration => ({ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] });

  it("uses BID clocks when only an upper frequency bound is supplied", () => {
    for (const frequency of [undefined, 2]) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: {
        code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID" }] },
        repeat: { ...(frequency === undefined ? {} : { frequency }), frequencyMax: 3, period: 1, periodUnit: Unit.Day }
      } };
      for (const input of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
        expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual([
          "2027-01-01T08:00:00+00:00", "2027-01-01T20:00:00+00:00",
          "2027-01-02T08:00:00+00:00", "2027-01-02T20:00:00+00:00"
        ]);
        // Numerical supply retains the independent authored upper bound.
        expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
      }
    }
  });

  it.each([true, false])("excludes impossible weekdays from a partial event window (clock=%s)", clock => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: {
      event: ["2026-11"], repeat: { dayOfWeek: [FhirDayOfWeek.Monday], ...(clock ? { timeOfDay: ["09:00:00"] } : {}) }
    } };
    for (const input of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      const query = { dosage: input, orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", durationValue: 2, durationUnit: Unit.Hour };
      expect(calculateTotalUnits({ ...query, from: "2026-11-01T08:00:00Z" }).totalUnits).toBe(0);
      expect(() => calculateTotalUnits({ ...query, from: "2026-11-02T08:00:00Z" })).toThrow(/month precision/);
    }
  });

  it("applies a counted cycle phase end to an event-only timing", () => {
    for (const days of [1, 7]) {
      const dose = member(); dose.schedule = { explicitEvents: ["2027-02"] };
      dose.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 1, unit: "d" } }];
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 1,
        stages: [{ end: { anchor: "treatment-start", displacement: { value: days, unit: "d" } }, administrations: [dose] }] };
      for (const input of forms(course)) {
        const query = { dosage: input, orderedAt: "2027-01-28T00:00:00Z", from: "2027-02-01T00:00:00Z",
          timeZone: "UTC", durationValue: 1, durationUnit: Unit.Day };
        if (days === 1) expect(calculateTotalUnits(query).totalUnits).toBe(0);
        else expect(() => calculateTotalUnits(query)).toThrow(/month precision/);
      }
    }
  });

  it("keeps zero as a ranged infusion lower bound with a fixed-duration control", () => {
    for (const variant of ["standard", "typed", "exact"] as const) {
      const dose = member(); dose.amounts = [{ rate: { value: 10, unit: "mL/h" } }];
      dose.schedule = { recurrence: { frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00", "20:00:00"],
        ...(variant === "typed" ? { occurrenceDurationRange: { low: { value: 0, unit: "h" }, high: { value: 2, unit: "h" } } }
          : { occurrenceDuration: variant === "exact" ? 2 : 0, occurrenceDurationUnit: Unit.Hour,
            ...(variant === "standard" ? { occurrenceDurationMax: 2 } : {}) }) } };
      dose.limits = [{ scope: "period", amount: { value: 30, unit: "mL" }, period: { value: 24, unit: "h" } }];
      for (const input of forms({ kind: "course", stages: [{ administrations: [dose] }] }))
        // A 1-hour and a 2-hour infusion attain 30 mL; two fixed 2-hour doses cannot both fit the cap.
        expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
          .toBe(variant === "exact" ? 20 : 30);
    }
  });
});


describe("configured clocks within elapsed frequency periods", () => {
  const options = { orderedAt: "2027-03-13T00:00:00-05:00", from: "2027-03-13T00:00:00-05:00",
    timeZone: "America/New_York", frequencyDefaults: { byFrequency: { "freq:2/per:24h": ["07:00", "18:00"] } } };

  it("uses configured first-cycle positions while retaining a 24-hour elapsed cycle", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 2, period: 24, periodUnit: Unit.Hour } } };
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      expect(nextDueDoses(dosage, { ...options, limit: 4 })).toEqual([
        "2027-03-13T07:00:00-05:00", "2027-03-13T18:00:00-05:00",
        "2027-03-14T08:00:00-04:00", "2027-03-14T19:00:00-04:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...options, from: "2027-03-14T07:30:00-04:00",
        durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(1);
      expect(nextDueDoses(dosage, { ...options, frequencyDefaults: undefined, limit: 2 })).toEqual([
        "2027-03-13T00:00:00-05:00", "2027-03-13T12:00:00-05:00"
      ]);
    }
  });

  it("uses the same configured grid for prior count, remaining due doses and supply", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { count: 3, frequency: 2, period: 24, periodUnit: Unit.Hour } } };
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      const query = { ...options, from: "2027-03-13T13:00:00-05:00" };
      expect(nextDueDoses(dosage, { ...query, limit: 4 })).toEqual([
        "2027-03-13T18:00:00-05:00", "2027-03-14T08:00:00-04:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
    }
  });
});


describe("untimed one-use allowances and supply explanations", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : version === "R5" ? courseToR5(course) : courseToR6(course);
  const options = { orderedAt: "2027-01-01T08:00:00Z", from: "2027-01-01T08:00:00Z", timeZone: "UTC" };

  it.each(versions)("keeps one untimed PRN use available until actual consumption (%s)", version => {
    const member: CanonicalAdministration = { kind: "administration", asNeeded: true,
      amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: { recurrence: { count: 1 } } };
    const input = wire({ kind: "course", stages: [{ administrations: [member] }] }, version);
    const original = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 1 })).toEqual([]);
    const query = { ...options, dosage: input, from: "2027-01-01T12:00:00Z", durationValue: 1, durationUnit: Unit.Day };
    expect(calculateTotalUnits(query)).toMatchObject({ totalUnits: 1, quantityKind: "maximum" });
    expect(calculateTotalUnits({ ...query, priorDoseTimes: ["2027-01-01T09:00:00Z"] }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ ...query, priorCount: 1 }).totalUnits).toBe(0);
    expect(JSON.stringify(input)).toBe(original);
    const scheduled = wire({ kind: "course", stages: [{ administrations: [{ ...member, asNeeded: false }] }] }, version);
    expect(nextDueDoses(scheduled, { ...options, limit: 1 })).toEqual(["2027-01-01T08:00:00+00:00"]);
    expect(calculateTotalUnits({ ...query, dosage: scheduled }).totalUnits).toBe(0);
  });

  it.each(versions)("uses the same supported unit normalization for course comparison and conversion (%s)", version => {
    const member = (value: number, unit: string): CanonicalAdministration => ({ kind: "administration",
      amounts: [{ quantity: { value, unit } }], schedule: { recurrence: { count: 1 } } });
    const input = wire({ kind: "course", stages: [{ administrations: [member(1, "g "), member(500, "mg")] }] }, version);
    const original = JSON.stringify(input);
    const query = { ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day };
    expect(calculateTotalUnits(query)).toMatchObject({ totalUnits: 1.5, unit: "g " });
    expect(JSON.stringify(input)).toBe(original);
    const incompatible = wire({ kind: "course", stages: [{ administrations: [member(1, "g "), member(500, "mL")] }] }, version);
    expect(() => calculateTotalUnits({ ...query, dosage: incompatible }))
      .toThrow(expect.objectContaining({ code: "incompatible-dose-units" }));
  });

  it.each(versions)("qualifies a frequency maximum without claiming the inferred clocks supplied the total (%s)", version => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: { recurrence: {
        frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day, clocks: ["06:00:00"] } } }] }] };
    const input = wire(course, version), original = JSON.stringify(input);
    const query = { dosage: input, orderedAt: "2027-01-01T00:00:00Z", from: "2027-01-01T06:00:00Z",
      timeZone: "UTC", durationValue: 1, durationUnit: Unit.Hour };
    const total = calculateTotalUnits(query);
    expect(total).toMatchObject({ totalUnits: 1, quantityKind: "maximum" });
    expect(total.explanation).toContain("frequency range was evaluated for maximum supply");
    expect(total.explanation).not.toContain("upper bound of the prescribed frequency range was used");
    expect(calculateTotalUnits({ ...query, from: query.orderedAt, durationUnit: Unit.Day }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(original);
  });
});


describe("standard and typed infusion-duration successor uncertainty", () => {
  it.each(["native", "R5", "R6"] as const)("uses one completion rule while preserving determinate windows (%s)", version => {
    for (const variant of ["standard", "typed", "exact"] as const) {
      const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ kind: "administration",
        amounts: [{ rate: { value: 10, unit: "mL/h" } }], schedule: { recurrence: { count: 1, clocks: ["09:00:00"],
          ...(variant === "typed" ? { occurrenceDurationRange: { low: { value: 1, unit: "h" }, high: { value: 2, unit: "h" } } }
            : { occurrenceDuration: 1, occurrenceDurationUnit: Unit.Hour,
              ...(variant === "standard" ? { occurrenceDurationMax: 2 } : {}) }) } } }] },
        { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 100, unit: "mL" } }],
          schedule: { recurrence: { count: 1, clocks: ["10:30:00"] } } }] }] };
      const input = version === "native" ? course : version === "R5" ? courseToR5(course) : courseToR6(course);
      const original = JSON.stringify(input);
      const query = { dosage: input, orderedAt: "2027-01-01T00:00:00Z", from: "2027-01-01T09:00:00Z",
        timeZone: "UTC", durationValue: 3, durationUnit: Unit.Hour };
      expect(calculateTotalUnits({ ...query, durationValue: 1.5 }).totalUnits).toBe(variant === "exact" ? 10 : 20);
      if (variant === "exact") {
        expect(calculateTotalUnits(query).totalUnits).toBe(110);
        expect(nextDueDoses(input, { ...query, limit: 2 })).toEqual([
          "2027-01-01T09:00:00+00:00", "2027-01-01T10:30:00+00:00"
        ]);
      } else expect(() => calculateTotalUnits(query)).toThrow(expect.objectContaining({ code: "course-duration-unresolved" }));
      expect(JSON.stringify(input)).toBe(original);
    }
  });
});


describe("shared current cadence, phase and quantity owners", () => {
  const origin = "2026-01-01T00:00:00Z";
  const query = { orderedAt: origin, from: origin, timeZone: "UTC", limit: 3 };
  const ucum = "http://unitsofmeasure.org";
  const gts = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
  const member = (recurrence: NonNullable<CanonicalAdministration["schedule"]>["recurrence"]): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }], schedule: { recurrence },
  });
  const course = (administration: CanonicalAdministration): CanonicalCourse => ({
    kind: "course", stages: [{ administrations: [administration] }],
  });
  const views = (native: CanonicalCourse) => {
    const wire = projectCanonicalCourse(native);
    return [native, wire.fhir, wire.fhirNext];
  };
  const supply = (dosage: Parameters<typeof nextDueDoses>[0], extra = {}) => calculateTotalUnits({
    dosage, ...query, durationValue: 1, durationUnit: Unit.Day, ...extra,
  });

  it("keeps the elapsed hourly code inside a period range at its authored clock", () => {
    const administration = member({ frequency: 1, period: 4, periodMax: 7,
      periodUnit: Unit.Hour, clocks: ["08:00:00"] });
    administration.schedule!.code = { coding: [{ system: gts, code: "Q4H" }] };
    for (const input of views(course(administration))) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T12:00:00+00:00", "2026-01-01T16:00:00+00:00",
      ]);
      expect(supply(input).totalUnits).toBe(4);
      expect(JSON.stringify(input)).toBe(before);
    }
    const daily = member({ frequency: 1, frequencyMax: 3, period: 1, periodUnit: Unit.Day });
    daily.schedule!.code = { coding: [{ system: gts, code: "BID" }] };
    expect(nextDueDoses(daily, { ...query, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
  });

  it("previews a compatible aggregate hourly code with its elapsed spacing", () => {
    const administration = member({ frequency: 6, period: 1, periodUnit: Unit.Day });
    administration.schedule!.code = { coding: [{ system: gts, code: "Q4H" }] };
    for (const input of views(course(administration))) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "short", { locale: "en", realizationMode: "normalized" })).toContain("Q4H");
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("every 4 hours");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toContain("ทุก 4 ชั่วโมง");
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00", "2026-01-01T08:00:00+00:00",
      ]);
      expect(JSON.stringify(input)).toBe(before);
    }
    const positioned = member({ frequency: 6, period: 1, periodUnit: Unit.Day,
      clocks: ["08:00:00", "10:00:00", "12:00:00", "14:00:00", "16:00:00", "18:00:00"] });
    positioned.schedule!.code = administration.schedule!.code;
    expect(nextDueDoses(positioned, query)).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00", "2026-01-01T12:00:00+00:00",
    ]);
    expect(formatSig(positioned, "long", { locale: "en" })).not.toContain("every 4 hours");
  });

  it("clips an elapsed undated predecessor without reordering authored starts", () => {
    const first = member({ frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00", "20:00:00"] });
    first.amounts![0].quantity!.unit = "drop";
    const next = member({ frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["18:00:00"],
      calendarWindow: { start: "2026-12-05" } });
    next.amounts![0].quantity = { value: 2, unit: "drop" };
    const native: CanonicalCourse = { kind: "course", stages: [
      { administrations: [first] }, { administrations: [next] },
    ] };
    for (const input of views(native)) {
      const before = JSON.stringify(input);
      const early = { from: "2026-12-05T07:00:00Z", timeZone: "UTC", limit: 2 };
      expect(nextDueDoses(input, early)).toEqual(["2026-12-05T08:00:00+00:00", "2026-12-05T18:00:00+00:00"]);
      const late = { from: "2026-12-05T19:00:00Z", timeZone: "UTC", limit: 2 };
      expect(nextDueDoses(input, late)).toEqual(["2026-12-06T18:00:00+00:00", "2026-12-07T18:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...late, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(JSON.stringify(input)).toBe(before);
    }
    const late = { from: "2026-12-05T19:00:00Z", timeZone: "UTC", limit: 1 };
    const repeated = { ...native, stages: [{ ...native.stages[0], count: 2 }, native.stages[1]] };
    expect(nextDueDoses(repeated, late)).toEqual(["2026-12-06T18:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: repeated, ...late, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
    expect(nextDueDoses(course(first), late)).toEqual(["2026-12-05T20:00:00+00:00"]);
    const authored: CanonicalCourse = { ...native, stages: [
      { ...native.stages[0], start: { anchor: "treatment-start", displacement: { value: 1, unit: "d" } } },
      native.stages[1],
    ] };
    expect(() => nextDueDoses(authored, { ...query, orderedAt: "2026-12-05T00:00:00Z" }))
      .toThrow(expect.objectContaining({ code: "invalid-stage-order" }));
  });

  const endOnlyCourse = (): FhirR6DosageInstruction => ({
    renderedInstruction: "Take 1 tablet at 08:00 through 4 December 2026",
    extension: [{ url: "https://example.org/current-order-note", valueString: "Retain current source" }],
    step: [{ id: "ending-phase", component: [{ id: "daily-tablet",
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"],
        boundsPeriod: { end: "2026-12-04T23:59:59Z", _end: { id: "authored-end" } } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", extension: [
        { url: "https://example.org/quantity-note", valueString: "Retain tablet annotation" },
      ] } }],
    }] }],
  });

  it("retains an end-only daily dose before expiry and returns no remaining scalar supply after it", () => {
    const source = endOnlyCourse(), original = JSON.stringify(source);
    const native = importCanonicalCourse(source), projected = projectCanonicalCourse(native);
    expect(projected.fhirNext.renderedInstruction).toBe(source.renderedInstruction);
    expect(projected.fhirNext.extension).toEqual(expect.arrayContaining(source.extension!));
    const returned = projected.fhirNext.step![0].component![0];
    expect(returned.timing?.repeat?.boundsPeriod).toEqual(source.step![0].component![0].timing!.repeat!.boundsPeriod);
    expect(returned.doseAndRate?.[0].doseQuantity?.extension)
      .toEqual(source.step![0].component![0].doseAndRate![0].doseQuantity!.extension);
    for (const input of [native, projected.fhir[0], source]) {
      const before = JSON.stringify(input);
      const early = { from: "2026-12-04T07:00:00Z", timeZone: "UTC", limit: 3 };
      expect(nextDueDoses(input, early)).toEqual(["2026-12-04T08:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...early, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      const late = { from: "2026-12-05T07:00:00Z", timeZone: "UTC", limit: 3 };
      expect(nextDueDoses(input, late)).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...late, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(source)).toBe(original);
  });

  it("keeps an expired end-only phase empty before a dated replacement without inventing its start", () => {
    const source = endOnlyCourse();
    source.renderedInstruction += "; then take 2 tablets daily at 08:00 from 5 December 2026";
    source.step!.push({ id: "dated-replacement", component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"],
        boundsPeriod: { start: "2026-12-05T00:00:00Z" } } },
      doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
    }] });
    const original = JSON.stringify(source), native = importCanonicalCourse(source);
    for (const input of [native, projectCanonicalCourse(native).fhir, source]) {
      const before = JSON.stringify(input);
      const early = { from: "2026-12-04T07:00:00Z", timeZone: "UTC", limit: 3 };
      expect(nextDueDoses(input, early)).toEqual([
        "2026-12-04T08:00:00+00:00", "2026-12-05T08:00:00+00:00", "2026-12-06T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...early, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      const late = { from: "2026-12-05T07:00:00Z", timeZone: "UTC", limit: 3 };
      expect(nextDueDoses(input, late)).toEqual([
        "2026-12-05T08:00:00+00:00", "2026-12-06T08:00:00+00:00", "2026-12-07T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...late, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(source)).toBe(original);
  });

  it("keeps an unknown step count active instead of assuming one repetition", () => {
    const first = member({ frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"] });
    const next = member({ frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"] });
    next.amounts![0].quantity!.value = 2;
    const ordinary: CanonicalCourse = { kind: "course", stages: [
      { administrations: [first], end: { anchor: "treatment-start", displacement: { value: 1, unit: "d" } } },
      { administrations: [next] },
    ] };
    const unknown: FhirR6DosageInstruction = projectCanonicalCourse(ordinary).fhirNext;
    unknown.step![0]._count = { id: "phase-repetitions", extension: [
      { url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" },
      { url: "https://example.org/current-count-note", valueString: "retain annotation" },
    ] };
    const native = importCanonicalCourse(unknown);
    expect(native.stages[0].countUnresolved).toBe(true);
    const projected = projectCanonicalCourse(native);
    expect(projected.fhirNext.step![0]._count).toEqual(unknown.step![0]._count);
    for (const input of [native, projected.fhir, unknown]) {
      const before = JSON.stringify(input);
      expect(() => nextDueDoses(input, query)).toThrow(expect.objectContaining({ code: "step-repeat-unresolved" }));
      expect(() => supply(input, { durationValue: 3 })).toThrow(expect.objectContaining({ code: "step-repeat-unresolved" }));
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("Phase repetition count is unspecified");
      expect(JSON.stringify(input)).toBe(before);
    }
    const single: FhirR6DosageInstruction = { step: [{ ...unknown.step![0], end: undefined }] };
    const batch = fromFhir(single, { locale: "en", realizationMode: "normalized" });
    expect(formatParseBatch(batch, "long")).toContain("Phase repetition count is unspecified");
    expect(formatSig(toFhirR5Dosages(single)[0], "long", { locale: "en", realizationMode: "normalized" }))
      .toContain("Phase repetition count is unspecified");
    expect(supply(ordinary, { durationValue: 3 }).totalUnits).toBe(5);
    const twice = { ...ordinary, stages: [{ ...ordinary.stages[0], count: 2 }, ordinary.stages[1]] };
    expect(supply(twice, { durationValue: 3 }).totalUnits).toBe(4);
  });

  it("deduplicates a loading instant shared by inferred historical cadence", () => {
    const administration = member({ anchors: [EventTiming.Immediate], frequency: 2,
      period: 48, periodUnit: Unit.Hour, count: 2 });
    for (const input of views(course(administration))) {
      const before = JSON.stringify(input);
      const options = { ...query, from: "2026-01-02T00:00:00Z" };
      expect(nextDueDoses(input, options)).toEqual(["2026-01-02T00:00:00+00:00"]);
      expect(supply(input, options).totalUnits).toBe(1);
      expect(JSON.stringify(input)).toBe(before);
    }
    // A configured first recurrence at 08:00 is distinct from the 00:00 loading instant.
    expect(nextDueDoses(administration, { ...query, from: "2026-01-01T01:00:00Z", config: {
      frequencyDefaults: { byFrequency: { "freq:2/per:48h": ["08:00:00", "20:00:00"] } },
    } })).toEqual(["2026-01-01T08:00:00+00:00"]);
  });

  it("keeps a variable daily count inside its explicit clock window", () => {
    const administration = member({ frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
      clockWindow: { start: "08:00:00", end: "10:00:00" } });
    for (const input of views(course(administration))) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00", "2026-01-02T08:00:00+00:00",
      ]);
      expect(supply(input).totalUnits).toBe(2);
      expect(supply(input, { from: "2026-01-01T19:30:00Z", durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(0);
      expect(JSON.stringify(input)).toBe(before);
    }
    const once = member({ frequency: 1, period: 1, periodUnit: Unit.Day,
      clockWindow: { start: "08:00:00", end: "10:00:00" } });
    expect(nextDueDoses(once, { ...query, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
    ]);
  });

  it("compares annotations on compound unit components without changing source units", () => {
    const administration = member({ frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00", "20:00:00"] });
    administration.amounts = [{ range: {
      low: { value: 1, unit: "mg{drug}/kg", code: "mg{drug}/kg", system: ucum },
      high: { value: 2, unit: "mg/kg", code: "mg/kg", system: ucum },
    } }];
    administration.limits = [{ scope: "period", amount: { value: 3, unit: "mg/kg", code: "mg/kg", system: ucum },
      period: { value: 24, unit: "h" } }];
    expect(supply(administration)).toMatchObject({ totalUnits: 3, unit: "mg/kg", quantityKind: "maximum" });
    // Wire Range endpoints use one authored code; the cap keeps its distinct
    // unannotated code. Native mixed endpoints remain checked above.
    const wireMember: CanonicalAdministration = { ...administration, amounts: [{ range: {
      low: administration.amounts[0].range!.low,
      high: { ...administration.amounts[0].range!.low, value: 2 },
    } }] };
    for (const input of views(course(wireMember))) {
      const before = JSON.stringify(input);
      expect(supply(input)).toMatchObject({ totalUnits: 3, unit: "mg{drug}/kg", quantityKind: "maximum" });
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(administration.amounts[0].range!.low!.code).toBe("mg{drug}/kg");
  });

  it("omits a global cycle pause when an absolute event can lead its nominal cycle", () => {
    const source = (delayMinutes: number): CanonicalCourse => ({ kind: "course", cycleInterval: { value: 28, unit: "d" },
      stages: [{ end: { anchor: "treatment-start", displacement: { value: 27, unit: "d" } },
        administrations: [{ ...member(undefined), delayMinutes,
          schedule: { explicitEvents: ["2026-01-29T00:30:00Z"] } }] }],
    });
    for (const input of views(source(-60))) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...query, from: "2026-01-28T00:00:00Z", limit: 1 }))
        .toEqual(["2026-01-28T23:30:00+00:00"]);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).not.toMatch(/no (?:dose|medication)/i);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(formatSig(source(0), "long", { locale: "en", realizationMode: "normalized" })).toMatch(/no (?:dose|medication)/i);
  });
});
