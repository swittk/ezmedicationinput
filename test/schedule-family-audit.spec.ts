import { describe, expect, it } from "vitest";
import {
  calculateTotalUnits, formatSig, lintSig, nextDueDoses, parseSig, parseSigAsync, suggestSig, toDosageDetails,
  MedicationQuantityCalculationError, importCanonicalCourse,
  toFhirR5Dosages, fromFhir, getDosageExcludedWeekdays,
  EventTiming, FhirDayOfWeek, FhirPeriodUnit, TIMING_OCCURRENCE_CAP_EXTENSION_URL
} from "../src";
import type { CanonicalScheduleExpr, FhirDosage, FhirR6DosageInstruction, FhirR6DosageStep } from "../src";
import { canonicalToFhir, getTimingClocks } from "../src/fhir";
import { courseFromR6, courseToR5, courseToR6 } from "../src/adapters/canonical-course";
import type { CanonicalAdministration, CanonicalCourse } from "../src/canonical/course";
import { parseClauseState } from "../src/parser";
import { createBoundaryPlan } from "../src/regimen/planner";
import { buildRegimenGraph } from "../src/regimen/regimen";
import { recognizeCycles } from "../src/hpsg/rules/timing-rules";
import { DOSAGE_DETAILS_R5_URL, PARALLEL_COMPONENT_PHASE_ORIGIN_URL } from "../src/dosage-course";
import { COURSE_CYCLE_COUNT_EXTENSION_URL, getCourseCycleCount } from "../src/fhir-course-cycle-count";
import { calendarBoundaryDate, makeZonedDate } from "../src/execution/calendar";

const start = "2024-01-01T00:00:00Z";
const due = {
  from: start,
  orderedAt: start,
  timeZone: "UTC",
  limit: 10
} as const;
const supply = {
  from: start,
  orderedAt: start,
  timeZone: "UTC",
  durationValue: 2,
  durationUnit: "d" as FhirPeriodUnit
} as const;

function dailyDose(overrides: Partial<FhirDosage> = {}): FhirDosage {
  return {
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } },
    ...overrides
  };
}

describe("typed calendar and relative timing composition", () => {
  it.each([
    [
      "Take 1 tablet on Mondays Wednesdays and Fridays, and 2 tablets on Saturdays",
      [["mon", "wed", "fri"], ["sat"]]
    ],
    [
      "Take 1 tablet on Tuesdays Thursdays and Sundays, and 2 tablets on Saturdays",
      [["tue", "thu", "sun"], ["sat"]]
    ]
  ] as const)("keeps plural weekday lists out of anatomical site: %s", (source, expectedDays) => {
    const parsed = parseSig(source);
    const directR5 = parsed.items.map(item => item.fhir);
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    const r6 = parsed.fhirNext.step.flatMap(step => step.component);

    for (const rows of [directR5, strictR5, r6]) {
      expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
      expect(rows.map(row => row.site)).toEqual([undefined, undefined]);
      expect(rows.map(row => row.timing?.repeat?.dayOfWeek)).toEqual(expectedDays);
    }
    expect(parsed.input).toBe(source);
  });

  it.each([
    "Take 1 tablet daily except Sunday for 4 weeks",
    "Take 1 tablet every day except on Sundays for 4 weeks"
  ])("composes a weekday exclusion with its following course duration: %s", source => {
    const parsed = parseSig(source);
    const directR5 = parsed.items[0]!.fhir;
    const strictR5 = toFhirR5Dosages(parsed.fhirNext)[0];
    const r6 = parsed.fhirNext.step[0]?.component[0];
    const expectedDays = ["mon", "tue", "wed", "thu", "fri", "sat"];

    expect(directR5.timing?.repeat).toMatchObject({
      boundsDuration: { value: 4, code: "wk" }, dayOfWeek: expectedDays
    });
    expect(getDosageExcludedWeekdays(directR5)).toEqual(["sun"]);
    expect(strictR5?.timing?.repeat).toMatchObject({
      boundsDuration: { value: 4, code: "wk" }, dayOfWeek: expectedDays
    });
    expect(getDosageExcludedWeekdays(strictR5!)).toEqual(["sun"]);
    expect(r6?.timing?.repeat).toMatchObject({
      boundsDuration: { value: 4, code: "wk" }, dayOfWeek: expectedDays
    });
    expect(parsed.input).toBe(source);
  });

  it.each(["more", "additional", "further"])(
    "keeps a post-quantity %s modifier inside the typed course duration",
    modifier => {
      const source = `Take 1 tablet BID for 5 ${modifier} days`;
      const parsed = parseSig(source);
      expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({
        duration: 5, durationUnit: "d"
      });
      expect(parsed.items[0]?.fhir.timing?.repeat?.boundsDuration).toMatchObject({
        value: 5, code: "d"
      });
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.input).toBe(source);
    }
  );

  it.each([
    ["Take 1 tablet after 12 hours", 720, "after 12 hours"],
    ["Take 1 tablet in 12 hours", 720, "in 12 hours"],
    ["Take 1 tablet 12 hours later", 720, "12 hours later"],
    ["Take 1 tablet 1 hour later", 60, "1 hour later"],
    ["Take 1 tablet after twelve hours", 720, "after twelve hours"],
    ["Take 1 tablet in twelve hours", 720, "in twelve hours"],
    ["Take 1 tablet twelve hours later", 720, "twelve hours later"]
  ] as const)("types a relative one-time interval as an administration offset: %s", (
    source, expectedMinutes, evidenceText
  ) => {
    const state = parseClauseState(source);
    expect(state.primaryClause.schedule).toMatchObject({
      administrationOffsetMinutes: expectedMinutes
    });
    expect(state.primaryClause.schedule?.frequency).toBeUndefined();
    expect(state.primaryClause.schedule?.period).toBeUndefined();
    expect(state.primaryClause.schedule?.duration).toBeUndefined();
    expect(state.primaryClause.schedule?.durationUnit).toBeUndefined();
    expect(state.primaryClause.schedule?.evidence?.some(evidence =>
      evidence.rule === "hpsg.lex.schedule.administrationOffset.relativeInterval" &&
      evidence.scheduleFields?.includes("administrationOffsetMinutes") &&
      evidence.spans.some(span => span.text === evidenceText)
    )).toBe(true);
    expect(state.input).toBe(source);
  });

  it("keeps an infusion-local in-duration distinct from an administration offset", () => {
    const source = "1 g IV Q 8h drip in 30 minutes";
    const state = parseClauseState(source);

    expect(state.primaryClause.schedule).toMatchObject({
      period: 8,
      periodUnit: "h",
      administrationDuration: 30,
      administrationDurationUnit: "min"
    });
    expect(state.primaryClause.schedule?.duration).toBeUndefined();
    expect(state.primaryClause.schedule?.administrationOffsetMinutes).toBeUndefined();
    expect(state.primaryClause.schedule?.evidence?.some(evidence =>
      evidence.scheduleFields?.includes("duration") &&
      evidence.spans.some(span => span.text === "30 minutes")
    )).toBe(true);
    expect(parseSig(source).items[0]?.fhir.timing?.repeat).toMatchObject({
      period: 8,
      periodUnit: "h",
      duration: 30,
      durationUnit: "min"
    });
    expect(state.input).toBe(source);
  });
});

describe("schedule/supply audit regressions", () => {
  it("schedules the bilateral suggestion while supply enforces aggregate maxima", () => {
    const bilateral = dailyDose({
      site: { text: "both eyes" },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } }
    });
    expect(nextDueDoses({
      ...bilateral,
      maxDosePerAdministration: { value: 1, unit: "drop" }
    }, { ...due, limit: 2 })).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T20:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      ...supply,
      dosage: { ...bilateral, maxDosePerAdministration: { value: 1, unit: "drop" } }
    })).toMatchObject({
      totalUnits: 8,
      unit: "drop",
      quantityKind: "maximum",
      explanation: expect.stringContaining("unevaluable maximum-dose constraint")
    });

    const periodCapped = {
      ...bilateral,
      maxDosePerPeriod: [{
        numerator: { value: 2, unit: "drop" },
        denominator: { value: 1, unit: "d", code: "d" }
      }]
    };
    expect(nextDueDoses(periodCapped, { ...due, limit: 2 })).toHaveLength(2);
    expect(calculateTotalUnits({ ...supply, dosage: periodCapped }).totalUnits).toBe(4);
  });

  it("does not fabricate prior PRN administrations and honors explicit priorCount", () => {
    const prn = dailyDose({
      asNeeded: true,
      timing: { repeat: { count: 3, frequency: 1, period: 1, periodUnit: "d" } }
    });
    const later = { ...due, from: "2024-01-05T00:00:00Z", limit: 5 };
    expect(nextDueDoses(prn, later)).toHaveLength(3);
    expect(nextDueDoses(prn, { ...later, priorCount: 0 })).toHaveLength(3);
    expect(nextDueDoses(prn, { ...later, priorCount: 2 })).toHaveLength(1);
    expect(nextDueDoses(prn, {
      ...later,
      priorDoseTimes: ["2024-01-02T09:00:00Z", "2024-01-03T09:00:00Z"]
    })).toHaveLength(1);
    const laterSupply = {
      ...supply,
      from: later.from,
      durationValue: 10,
      dosage: prn
    };
    expect(calculateTotalUnits(laterSupply).totalUnits).toBe(3);
    expect(calculateTotalUnits({ ...laterSupply, priorCount: 2 }).totalUnits).toBe(1);
  });

  it("returns maximum PRN opportunities and applies supplied periodic-cap history", () => {
    const parsedOccurrenceCapped = parseSig(
      "take 1 tab q4h prn pain max 3 doses daily"
    );
    const occurrenceCapped = parsedOccurrenceCapped.fhir;
    const firstWindow = { ...due, limit: 3 };
    expect(nextDueDoses(occurrenceCapped, firstWindow)).toEqual([
      "2024-01-01T00:00:00+00:00",
      "2024-01-01T04:00:00+00:00",
      "2024-01-01T08:00:00+00:00"
    ]);

    const midday = { ...firstWindow, from: "2024-01-01T12:00:00Z" };
    for (const representation of [
      parsedOccurrenceCapped,
      occurrenceCapped,
      parsedOccurrenceCapped.fhirNext
    ]) {
      expect(nextDueDoses(representation, midday)).toEqual([
        "2024-01-01T12:00:00+00:00",
        "2024-01-01T16:00:00+00:00",
        "2024-01-01T20:00:00+00:00"
      ]);
    }
    expect(nextDueDoses(occurrenceCapped, { ...midday, priorCount: 0 })).toEqual([
      "2024-01-01T12:00:00+00:00",
      "2024-01-01T16:00:00+00:00",
      "2024-01-01T20:00:00+00:00"
    ]);
    expect(nextDueDoses(occurrenceCapped, {
      ...midday,
      priorDoseTimes: []
    })).toEqual([
      "2024-01-01T12:00:00+00:00",
      "2024-01-01T16:00:00+00:00",
      "2024-01-01T20:00:00+00:00"
    ]);

    // Calendar occurrence caps have an independently safe next bucket.
    expect(nextDueDoses(occurrenceCapped, {
      ...firstWindow,
      from: "2024-01-02T00:00:00Z"
    })).toEqual([
      "2024-01-02T00:00:00+00:00",
      "2024-01-02T04:00:00+00:00",
      "2024-01-02T08:00:00+00:00"
    ]);

    const rollingQuantityCapped = dailyDose({
      asNeeded: true,
      timing: { repeat: { frequency: 1, period: 4, periodUnit: "h" } },
      maxDosePerPeriod: [{
        numerator: { value: 3, unit: "tab" },
        denominator: { value: 1, unit: "d", code: "d" }
      }]
    });
    expect(nextDueDoses(rollingQuantityCapped, firstWindow)).toEqual([
      "2024-01-01T00:00:00+00:00",
      "2024-01-01T04:00:00+00:00",
      "2024-01-01T08:00:00+00:00"
    ]);
    expect(nextDueDoses(rollingQuantityCapped, midday)).toEqual([
      "2024-01-01T12:00:00+00:00",
      "2024-01-01T16:00:00+00:00",
      "2024-01-01T20:00:00+00:00"
    ]);
    expect(nextDueDoses(rollingQuantityCapped, {
      ...firstWindow,
      from: "2024-01-02T00:00:00Z"
    })).toEqual([
      "2024-01-02T00:00:00+00:00",
      "2024-01-02T04:00:00+00:00",
      "2024-01-02T08:00:00+00:00"
    ]);

    const middaySupply = {
      ...supply,
      from: midday.from,
      durationValue: 12,
      durationUnit: "h" as FhirPeriodUnit,
      dosage: occurrenceCapped
    };
    for (const dosage of [
      parsedOccurrenceCapped,
      occurrenceCapped,
      parsedOccurrenceCapped.fhirNext
    ]) {
      expect(calculateTotalUnits({ ...middaySupply, dosage })).toMatchObject({
        totalUnits: 3,
        quantityKind: "maximum",
        explanation: expect.stringMatching(/PRN doses/i)
      });
    }
    expect(calculateTotalUnits({ ...middaySupply, priorDoseTimes: [] }).totalUnits)
      .toBe(3);
    expect(calculateTotalUnits({
      ...middaySupply,
      priorDoseTimes: [
        "2024-01-01T00:00:00Z",
        "2024-01-01T04:00:00Z",
        "2024-01-01T08:00:00Z"
      ]
    }).totalUnits).toBe(0);
  });

  it("only spends occurrence-cap allowances on clinically eligible administrations", () => {
    const parsed = parseSig(
      "take 1 tab q4h prn pain max three doses daily only if BP > 160"
    );
    const filtered = {
      from: "2026-10-22T00:00:00+07:00",
      orderedAt: "2026-10-22T00:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 5,
      priorDoseTimes: [],
      evaluateCondition: (_condition: unknown, at: string) =>
        !at.includes("T00:00:00") && !at.includes("T04:00:00")
    };
    const expected = [
      "2026-10-22T08:00:00+07:00",
      "2026-10-22T12:00:00+07:00",
      "2026-10-22T16:00:00+07:00",
      "2026-10-23T08:00:00+07:00",
      "2026-10-23T12:00:00+07:00"
    ];
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext]) {
      expect(nextDueDoses(dosage, filtered)).toEqual(expected);
      expect(calculateTotalUnits({
        ...filtered, dosage,
        durationValue: 2, durationUnit: "d"
      }).totalUnits).toBe(6);
    }
  });

  it("uses the concrete cadence for scheduling and the upper range for maximum supply", () => {
    const ranged = dailyDose({
      timing: {
        code: { coding: [{ code: "QD" }] },
        repeat: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: "d" }
      }
    });
    expect(nextDueDoses(ranged, { ...due, limit: 3 })).toEqual([
      "2024-01-01T09:00:00+00:00",
      "2024-01-02T09:00:00+00:00",
      "2024-01-03T09:00:00+00:00"
    ]);
    expect(calculateTotalUnits({ ...supply, dosage: ranged })).toMatchObject({
      totalUnits: 4,
      unit: "tab",
      quantityKind: "maximum",
      explanation: expect.stringMatching(/upper bound.*frequency range/i)
    });
  });

  it("keeps one explicit clock while using the daily upper bound for maximum supply", () => {
    const ranged = parseSig("1 tab PO once or twice daily at 08:00");
    expect(ranged.fhir[0].timing?.repeat).toMatchObject({
      frequency: 1,
      frequencyMax: 2,
      period: 1,
      periodUnit: "d",
      timeOfDay: ["08:00:00"]
    });
    expect(nextDueDoses(ranged, { ...due, limit: 3 })).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-02T08:00:00+00:00",
      "2024-01-03T08:00:00+00:00"
    ]);
    expect(calculateTotalUnits({ ...supply, dosage: ranged })).toMatchObject({
      totalUnits: 4,
      unit: "tab",
      quantityKind: "maximum",
      explanation: expect.stringMatching(/upper bound.*frequency range/i)
    });
  });

  it("anchors an unspecified monthly weekday ordinal without losing the weekday", () => {
    const imported = dailyDose({
      timing: { repeat: {
        frequency: 1,
        period: 1,
        periodUnit: "mo",
        dayOfWeek: ["mon"],
        timeOfDay: ["09:00:00"]
      } }
    });
    const cases = [
      parseSig("1 tab PO once monthly on Monday at 09:00"),
      parseSig("รับประทาน 1 เม็ด เดือนละครั้ง วันจันทร์ เวลา 09:00"),
      imported
    ];
    for (const dosage of cases) {
      expect(nextDueDoses(dosage, { ...due, limit: 3 })).toEqual([
        "2024-01-01T09:00:00+00:00",
        "2024-02-05T09:00:00+00:00",
        "2024-03-04T09:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...supply, dosage })).toMatchObject({
        totalUnits: 1, unit: "tab"
      });
    }
  });

  it("applies scalar priorCount independently to concurrent editable components", () => {
    const capped = (site: string): FhirDosage => dailyDose({
      sequence: 1,
      site: { text: site },
      asNeeded: true,
      timing: { repeat: { count: 3, frequency: 1, period: 1, periodUnit: "d" } }
    });
    const concurrent = [capped("left"), capped("right")];
    const course = toDosageDetails(concurrent);
    const later = {
      ...due,
      from: "2024-01-05T00:00:00Z",
      priorCount: 2
    };
    for (const dosage of [concurrent, course]) {
      expect(nextDueDoses(dosage, later)).toEqual([
        "2024-01-05T09:00:00+00:00",
        "2024-01-05T09:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...supply, ...later, dosage })).toMatchObject({
        totalUnits: 2, unit: "tab", quantityKind: "maximum"
      });
    }
  });

  it("returns an anchored best-effort twice-weekly series", () => {
    const ambiguous = dailyDose({
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "wk" } }
    });
    expect(nextDueDoses(ambiguous, { ...due, limit: 4 })).toEqual([
      "2024-01-01T00:00:00+00:00",
      "2024-01-04T00:00:00+00:00",
      "2024-01-08T00:00:00+00:00",
      "2024-01-11T00:00:00+00:00"
    ]);
    expect(calculateTotalUnits({ ...supply, dosage: ambiguous }))
      .toMatchObject({ totalUnits: 1, unit: "tab" });
  });

  it("uses the upper duration range as the best-effort course horizon", () => {
    const ambiguous = dailyDose({
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: "d",
        boundsRange: {
          low: { value: 7, unit: "d" },
          high: { value: 2, unit: "wk" }
        }
      } }
    });
    expect(nextDueDoses(ambiguous, due)).toHaveLength(10);
    expect(nextDueDoses([
      { ...ambiguous, sequence: 1 },
      { ...dailyDose(), sequence: 2 }
    ], due)).toHaveLength(10);
    expect(calculateTotalUnits({ ...supply, dosage: ambiguous, durationValue: 30 }))
      .toMatchObject({ totalUnits: 14, unit: "tab" });

    const equivalent = dailyDose({
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: "d",
        boundsRange: {
          low: { value: 7, unit: "d" },
          high: { value: 1, unit: "wk" }
        }
      } }
    });
    expect(nextDueDoses(equivalent, { ...due, limit: 20 })).toHaveLength(7);
  });

  it("rejects invalid boundsPeriod dates consistently for a dosage and an array", () => {
    const invalid = dailyDose({
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: "d",
        boundsPeriod: { end: "not-a-date" }
      } }
    });
    expect(() => nextDueDoses(invalid, due)).toThrow(/boundsPeriod\.end is invalid/);
    expect(() => nextDueDoses([invalid], due)).toThrow(/boundsPeriod\.end is invalid/);
  });

  it("uses durationMax for maximum infusion supply", () => {
    const infusion: FhirDosage = {
      doseAndRate: [{ rateQuantity: { value: 2, unit: "mL/h" } }],
      timing: { repeat: {
        count: 1,
        duration: 1,
        durationMax: 3,
        durationUnit: "h"
      } }
    };
    expect(calculateTotalUnits({ ...supply, dosage: infusion })).toMatchObject({
      totalUnits: 6,
      unit: "mL",
      quantityKind: "maximum",
      explanation: expect.stringMatching(/infusion-duration range/i)
    });
  });

  it("keeps scanning for sparse quarterly clock schedules", () => {
    const quarterly = dailyDose({
      timing: { repeat: {
        period: 3,
        periodUnit: "mo",
        timeOfDay: ["09:00"]
      } }
    });
    expect(nextDueDoses(quarterly, {
      ...due,
      from: "2024-01-02T00:00:00Z",
      limit: 2
    })).toEqual([
      "2024-04-01T09:00:00+00:00",
      "2024-07-01T09:00:00+00:00"
    ]);
  });

  it("applies count caps to exact events even when orderedAt is absent", () => {
    const exact = dailyDose({
      timing: {
        event: [
          "2024-01-01T09:00:00Z",
          "2024-01-02T09:00:00Z",
          "2024-01-03T09:00:00Z"
        ],
        repeat: { count: 2 }
      }
    });
    expect(nextDueDoses(exact, {
      from: "2024-01-02T00:00:00Z",
      timeZone: "UTC",
      limit: 10
    })).toEqual(["2024-01-02T09:00:00+00:00"]);
    expect(calculateTotalUnits({
      ...supply,
      dosage: exact,
      orderedAt: undefined,
      from: "2024-01-02T00:00:00Z",
      durationValue: 3
    }).totalUnits).toBe(1);
  });

  it("validates single supply horizons and always returns known unit metadata", () => {
    const dosage = dailyDose();
    expect(() => calculateTotalUnits({
      ...supply,
      dosage,
      durationValue: 0
    })).toThrow(/positive number/);
    expect(() => calculateTotalUnits({
      ...supply,
      dosage,
      durationUnit: "fortnight" as FhirPeriodUnit
    })).toThrow(/supported time unit/);
    expect(calculateTotalUnits({ ...supply, dosage })).toMatchObject({
      totalUnits: 2,
      unit: "tab"
    });
  });
});

function projectSchedule(schedule: CanonicalScheduleExpr): FhirDosage {
  return canonicalToFhir({
    kind: "administration",
    rawText: "",
    raw: { start: 0, end: 0, text: "" },
    dose: { value: 1, unit: "tab" },
    schedule,
    leftovers: [],
    evidence: [],
    confidence: 1
  });
}

const clocks = ["08:00:00", "20:00:00"];
const origin = "2024-01-01T00:00:00Z";

describe("regimen clock-frequency normalization", () => {
  it("does not invent a two-dose frequency for two clocks plus an additional bedtime event", () => {
    const schedule: CanonicalScheduleExpr = {
      period: 1, periodUnit: FhirPeriodUnit.Day,
      timeOfDay: ["08:00:00", "14:00:00"],
      when: [EventTiming["Before Sleep"]]
    };
    const dosage = projectSchedule(schedule);
    expect(dosage.timing?.repeat).toMatchObject({
      period: 1, periodUnit: "d",
      when: [EventTiming["Before Sleep"]]
    });
    expect(getTimingClocks(dosage.timing?.repeat)).toEqual(["08:00:00", "14:00:00"]);
    expect(dosage.timing?.repeat?.timeOfDay).toBeUndefined();
    expect(dosage.timing?.repeat?.frequency).toBeUndefined();
    const opportunities = nextDueDoses(dosage, {
      ...due, limit: 3,
      eventClock: { [EventTiming["Before Sleep"]]: "22:00" }
    });
    expect(opportunities.map(time => time.slice(11, 16)))
      .toEqual(["08:00", "14:00", "22:00"]);
    expect(calculateTotalUnits({ ...supply, dosage,
      eventClock: { [EventTiming["Before Sleep"]]: "22:00" }
    }).totalUnits).toBe(6);
  });

  it("continues to infer clock-only frequency while preserving explicit cadence", () => {
    const base: CanonicalScheduleExpr = {
      period: 1, periodUnit: FhirPeriodUnit.Day,
      timeOfDay: ["08:00:00", "14:00:00"]
    };
    expect(projectSchedule(base).timing?.repeat?.frequency).toBe(2);
    expect(projectSchedule({
      ...base, when: [EventTiming["Before Sleep"]], frequency: 4
    }).timing?.repeat?.frequency).toBe(4);
    expect(projectSchedule({
      period: 1, periodUnit: FhirPeriodUnit.Week,
      dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday],
      timeOfDay: base.timeOfDay, when: [EventTiming["Before Sleep"]]
    }).timing?.repeat?.frequency).toBeUndefined();
  });

  const weeklyCases: Array<{
    name: string;
    schedule: CanonicalScheduleExpr;
    durationValue: number;
    expected: string[];
  }> = [
    {
      name: "an unanchored weekly cadence",
      schedule: { period: 1, periodUnit: FhirPeriodUnit.Week, timeOfDay: clocks },
      durationValue: 2,
      expected: [
        "2024-01-01T08:00:00+00:00",
        "2024-01-01T20:00:00+00:00",
        "2024-01-08T08:00:00+00:00",
        "2024-01-08T20:00:00+00:00"
      ]
    },
    {
      name: "an anchored two-week cadence",
      schedule: {
        period: 2,
        periodUnit: FhirPeriodUnit.Week,
        dayOfWeek: [FhirDayOfWeek.Monday],
        timeOfDay: clocks
      },
      durationValue: 4,
      expected: [
        "2024-01-01T08:00:00+00:00",
        "2024-01-01T20:00:00+00:00",
        "2024-01-15T08:00:00+00:00",
        "2024-01-15T20:00:00+00:00"
      ]
    }
  ];

  it.each(weeklyCases)("preserves both clocks and the cadence for $name", ({ schedule, durationValue, expected }) => {
    const dosage = projectSchedule(schedule);

    expect(dosage.timing?.repeat).toMatchObject(schedule);
    expect(dosage.timing?.repeat?.frequency).toBeUndefined();
    expect(nextDueDoses(dosage, {
      from: origin,
      orderedAt: origin,
      timeZone: "UTC",
      limit: 4
    })).toEqual(expected);
    expect(calculateTotalUnits({
      dosage,
      from: origin,
      orderedAt: origin,
      timeZone: "UTC",
      durationValue,
      durationUnit: FhirPeriodUnit.Week
    }).totalUnits).toBe(4);
  });

  it("preserves two monthly clocks without inventing a non-daily frequency", () => {
    const dosage = projectSchedule({
      period: 1,
      periodUnit: FhirPeriodUnit.Month,
      timeOfDay: clocks
    });

    expect(dosage.timing?.repeat).toMatchObject({
      period: 1,
      periodUnit: "mo",
      timeOfDay: clocks
    });
    expect(dosage.timing?.repeat?.frequency).toBeUndefined();
    expect(nextDueDoses(dosage, {
      from: origin,
      orderedAt: origin,
      timeZone: "UTC",
      limit: 4
    })).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T20:00:00+00:00",
      "2024-02-01T08:00:00+00:00",
      "2024-02-01T20:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      dosage,
      from: origin,
      orderedAt: origin,
      timeZone: "UTC",
      durationValue: 2,
      durationUnit: FhirPeriodUnit.Month
    }).totalUnits).toBe(4);
  });

  it("leaves an annual multi-clock cadence explicit", () => {
    const dosage = projectSchedule({
      period: 1,
      periodUnit: FhirPeriodUnit.Year,
      timeOfDay: clocks
    });

    expect(dosage.timing?.repeat).toMatchObject({
      period: 1,
      periodUnit: "a",
      timeOfDay: clocks
    });
    expect(dosage.timing?.repeat?.frequency).toBeUndefined();
  });

  it("derives frequency for a daily-unit cadence while retaining its period", () => {
    const dosage = projectSchedule({
      period: 2,
      periodUnit: FhirPeriodUnit.Day,
      timeOfDay: clocks
    });

    expect(dosage.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 2,
      periodUnit: "d",
      timeOfDay: clocks
    });
    expect(nextDueDoses(dosage, {
      from: origin,
      orderedAt: origin,
      timeZone: "UTC",
      limit: 4
    })).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T20:00:00+00:00",
      "2024-01-03T08:00:00+00:00",
      "2024-01-03T20:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      dosage,
      from: origin,
      orderedAt: origin,
      timeZone: "UTC",
      durationValue: 4,
      durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(4);
  });

  it("derives the executable frequency for an exact week with weekday anchors", () => {
    const dosage = projectSchedule({
      period: 1,
      periodUnit: FhirPeriodUnit.Week,
      dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Thursday],
      timeOfDay: clocks
    });

    expect(dosage.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "wk",
      dayOfWeek: ["mon", "thu"],
      timeOfDay: clocks
    });
    expect(nextDueDoses(dosage, {
      from: origin,
      orderedAt: origin,
      timeZone: "UTC",
      limit: 4
    })).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T20:00:00+00:00",
      "2024-01-04T08:00:00+00:00",
      "2024-01-04T20:00:00+00:00"
    ]);
    expect(calculateTotalUnits({
      dosage,
      from: origin,
      orderedAt: origin,
      timeZone: "UTC",
      durationValue: 1,
      durationUnit: FhirPeriodUnit.Week
    }).totalUnits).toBe(4);
  });

  it("does not overwrite a stated frequency", () => {
    const dosage = projectSchedule({
      frequency: 1,
      period: 1,
      periodUnit: FhirPeriodUnit.Month,
      timeOfDay: clocks
    });

    expect(dosage.timing?.repeat?.frequency).toBe(1);
  });
});

const base = {
  orderedAt: "2026-10-19T08:00:00+07:00",
  from: "2026-10-19T08:00:00+07:00",
  timeZone: "Asia/Bangkok",
  limit: 8
} as const;

const shapes = (source: string) => {
  const parsed = parseSig(source);
  return [
    parsed, parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)
  ];
};

describe("dose scheduling runtime guarantees", () => {
  it("does not report zero supply for an empty regimen", () => {
    expect(() => calculateTotalUnits({
      dosage: [],
      from: base.from,
      orderedAt: base.orderedAt,
      timeZone: base.timeZone,
      durationValue: 1,
      durationUnit: "d"
    })).toThrow(/medication dosage or complete treatment course/i);
  });
  it("does not recursively overflow on calendar exclusions in the flat native result", () => {
    const expected = [
      "2026-10-19T09:00:00+07:00",
      "2026-10-21T09:00:00+07:00",
      "2026-10-23T09:00:00+07:00"
    ];
    for (const input of shapes("1 tab daily except 20/10/2026 and 22/10/2026")) {
      expect(nextDueDoses(input, { ...base, limit: 3 })).toEqual(expected);
    }
  });

  it("enforces normal maximum quantities instead of refusing safely computable prescriptions", () => {
    const expected = [
      "2026-10-19T08:00:00+07:00",
      "2026-10-19T12:00:00+07:00",
      "2026-10-20T08:00:00+07:00",
      "2026-10-20T12:00:00+07:00",
      "2026-10-21T08:00:00+07:00",
      "2026-10-21T12:00:00+07:00"
    ];
    for (const input of shapes("2 tabs Q4H PRN pain max 4 tablets/day")) {
      expect(nextDueDoses(input, { ...base, limit: 6 })).toEqual(expected);
    }
  });

  it("does not reset a 24-hour maximum at midnight", () => {
    const inputs = shapes("2 tabs Q4H PRN pain max 4 tablets/day");
    for (const input of inputs) {
      expect(nextDueDoses(input, {
        ...base, from: "2026-10-19T20:00:00+07:00", limit: 2,
        priorDoseTimes: [
          "2026-10-19T08:00:00+07:00",
          "2026-10-19T12:00:00+07:00"
        ]
      })).toEqual([
        "2026-10-20T08:00:00+07:00",
        "2026-10-20T12:00:00+07:00"
      ]);
    }
  });

  it("excludes non-administered conditional doses before applying quantity maxima", () => {
    const dose = parseSig("2 tabs Q4H PRN pain max 4 tablets/day").fhir[0];
    dose.condition = [{
      code: { text: "Eligible" }, text: "Eligible"
    }];
    expect(nextDueDoses(dose, {
      ...base, limit: 4,
      evaluateCondition: (_condition, at) => !at.includes("T08:00:00")
    })).toEqual([
      "2026-10-19T12:00:00+07:00",
      "2026-10-19T16:00:00+07:00",
      "2026-10-20T12:00:00+07:00",
      "2026-10-20T16:00:00+07:00"
    ]);
  });

  it("applies the same conditions from the strict R5 representation", () => {
    const input = "1 tab PO BID only if BP >160, otherwise hold";
    const parsed = parseSig(input);
    const cases = [
      parsed, parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)
    ];
    for (const value of cases) {
      expect(nextDueDoses(value, {
        ...base, limit: 3, evaluateCondition: () => false
      })).toEqual([]);
      expect(nextDueDoses(value, {
        ...base, limit: 2, evaluateCondition: () => true
      })).toEqual([
        "2026-10-19T08:00:00+07:00",
        "2026-10-19T20:00:00+07:00"
      ]);
    }
  });

  it("allows body-site references and dose expressions to carry actual schedule times", () => {
    const details: FhirR6DosageInstruction = {
      step: [{ component: [{
        site: { reference: { reference: "BodyStructure/example" } },
        doseAndRate: [{
          doseExpression: {
            language: "text/fhirpath",
            expression: "%patient.weight * 0.5"
          }
        }],
        timing: {
          repeat: { frequency: 2, period: 1, periodUnit: "d" }
        }
      }] }]
    };
    const imported = fromFhir(details);
    for (const input of [
      details, imported.fhir, toFhirR5Dosages(details)
    ]) {
      expect(nextDueDoses(input, { ...base, limit: 2 })).toEqual([
        "2026-10-19T08:00:00+07:00",
        "2026-10-19T20:00:00+07:00"
      ]);
    }
  });

  it("schedules a future-dated one-time administration once and agrees with supply", () => {
    const dosage = parseSig("1 tab once").fhir[0];
    dosage.timing!.repeat!.boundsPeriod = { start: "2026-10-25" };
    const options = {
      ...base,
      from: "2026-10-21T08:00:00+07:00",
      orderedAt: "2026-10-21T08:00:00+07:00",
      limit: 4
    };
    const expected = ["2026-10-25T00:00:00+07:00"];
    for (const input of [dosage, [dosage], toFhirR5Dosages({
      step: [{ component: [dosage] }]
    })]) {
      expect(nextDueDoses(input, options)).toEqual(expected);
      expect(nextDueDoses(input, {
        ...options, from: "2026-10-26T08:00:00+07:00"
      })).toEqual([]);
    }
    // Even without orderedAt, the explicit single-dose bound remains the
    // historical anchor, rather than moving whenever the query starts.
    expect(nextDueDoses(dosage, { ...options, orderedAt: undefined }))
      .toEqual(expected);
    expect(nextDueDoses(dosage, {
      ...options, orderedAt: undefined, from: "2026-10-26T08:00:00+07:00"
    })).toEqual([]);
  });

  it("owns recurring on/off cycle semantics before FHIR and preserves both projections", () => {
    const input = "1 tab daily for 7 days then stop for 7 days repeat for 3 cycles";
    const plan = createBoundaryPlan(input);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    expect(states).toHaveLength(1);
    expect(states[0].primaryClause.schedule).toMatchObject({
      duration: 7,
      durationUnit: "d",
      repeatCycle: { value: 14, unit: "d", code: "d" },
      repeatCount: 3
    });
    expect(states[0].primaryClause.schedule?.evidence?.find(evidence =>
      evidence.rule === "hpsg.cx.course.active-rest-repeat")?.scheduleFields
    ).toEqual(["duration", "durationUnit", "repeatCycle", "repeatCount"]);
    expect(states[0].primaryClause.evidence.find(evidence =>
      evidence.rule === "hpsg.cx.course.active-rest-repeat")?.scheduleFields
    ).toEqual(["duration", "durationUnit", "repeatCycle", "repeatCount"]);
    expect(buildRegimenGraph(plan, plan.segments, states)).toMatchObject({
      repeatCycle: { value: 14, unit: "d", code: "d" },
      repeatCount: 3
    });

    const parsed = parseSig(input);
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
      repeatCycle: { value: 14, unit: "d", code: "d" },
      repeatCount: 3
    });
    expect(parsed.fhirNext.repeatCycle).toMatchObject({ value: 14, unit: "d", code: "d" });
    expect(getCourseCycleCount(parsed.fhirNext)).toBe(3);
    expect(parsed.fhirNext.step[0].count).toBeUndefined();
    const flat = JSON.parse(JSON.stringify(parsed.fhir));
    const restoredCourse = toDosageDetails(flat);
    expect(restoredCourse.repeatCycle).toMatchObject({ value: 14, unit: "d", code: "d" });
    expect(getCourseCycleCount(restoredCourse)).toBe(3);
    expect(restoredCourse.step[0].count).toBeUndefined();
    expect(nextDueDoses(flat, { ...base, limit: 10 })).toEqual(
      nextDueDoses(parsed.fhirNext, { ...base, limit: 10 })
    );
    for (const dosage of [flat, parsed.fhirNext]) {
      expect(calculateTotalUnits({ dosage, from: start, orderedAt: start, timeZone: "UTC",
        durationValue: 49, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }

    const unbounded = parseSig("1 tab daily for 7 days then stop for 7 days repeat");
    expect(unbounded.meta.canonical.clauses[0].schedule?.repeatCount).toBeUndefined();
    expect(calculateTotalUnits({
      dosage: unbounded.fhirNext,
      from: start,
      orderedAt: start,
      timeZone: "UTC",
      durationValue: 28,
      durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 14, unit: "tab" });

    const coordinated = parseSig(
      "instill 1 drop in left eye and 2 drops in right eye daily " +
      "for 7 days then stop for 7 days repeat for 3 cycles"
    );
    expect(coordinated.items).toHaveLength(2);
    expect(coordinated.items.map(item => item.meta.canonical.clauses[0].schedule)).toEqual([
      expect.objectContaining({
        duration: 7,
        durationUnit: "d",
        repeatCycle: expect.objectContaining({ value: 14, unit: "d" }),
        repeatCount: 3
      }),
      expect.objectContaining({
        duration: 7,
        durationUnit: "d",
        repeatCycle: expect.objectContaining({ value: 14, unit: "d" }),
        repeatCount: 3
      })
    ]);
    expect(coordinated.items[0].meta.canonical.clauses[0].schedule?.evidence?.some(evidence =>
      evidence.scheduleFields?.includes("repeatCycle") &&
      evidence.scheduleFields.includes("repeatCount")
    )).toBe(true);
  });

  it("keeps anchored Thai cycles typed and malformed cycle source editable", () => {
    const thai = parseSig(
      "รับประทานครั้งละ 1 เม็ด วันละ 1 ครั้ง วันที่ของรอบ 1,8 ทุก 28 วัน เริ่ม 28/9/2569 จำนวน 2 รอบ",
      { locale: "th" }
    );
    expect(thai.meta.canonical.clauses[0].schedule?.calendarEvents?.map(event => event.isoDate))
      .toEqual(["2026-09-28", "2026-10-05", "2026-10-26", "2026-11-02"]);
    expect(thai.fhir[0].timing?.event).toEqual(
      ["2026-09-28", "2026-10-05", "2026-10-26", "2026-11-02"]
    );
    expect(thai.meta.canonical.clauses[0].schedule?.evidence?.find(evidence =>
      evidence.rule === "hpsg.lex.schedule.finiteCycle")?.scheduleFields
    ).toEqual(["calendarEvents"]);

    const unresolved = "take .5 tab at 08:00 on days 0,8 every 28 days starting 28/9/2026 for 2 cycles";
    const partial = parseSig(unresolved);
    expect(partial.input).toBe(unresolved);
    expect(partial.meta.canonical.clauses[0].rawText).toBe(unresolved);
    // Malformed "days 0" remains editable; never force an interpretation
    // at the cost of corrupting ordinary maximum-dose prescriptions.
    expect(partial.fhir[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    // A recognized but invalid cycle is an editable, explicitly unresolved
    // typed instruction, not necessarily a leftover lexical fragment. Most
    // importantly, its day ordinal cannot replace the prescribed drug dose.
    expect(partial.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({
      value: 0.5, unit: "tab"
    });
    expect(partial.fhir[0].additionalInstruction?.some(item =>
      item.text?.includes("days 0,8 every 28 days")
    )).toBe(true);
    expect(partial.fhir[0].timing?.repeat?.period).toBeUndefined();
    expect(partial.warnings?.some(warning =>
      warning.includes("Unresolved schedule") &&
      warning.includes("invalid-cycle-day-range")
    )).toBe(true);
    expect(lintSig(unresolved).issues.some(issue =>
      issue.message.includes("invalid-cycle-day-range")
    )).toBe(true);
    expect(toFhirR5Dosages(toDosageDetails([partial.fhir[0]]))[0]
      .doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
    expect(partial.fhirNext.repeatCycle).toBeUndefined();
    expect(partial.meta.canonical.clauses[0].evidence.some(evidence =>
      evidence.rule === "hpsg.lex.schedule.finiteCycle"
    )).toBe(false);

    const ordinary = "1 tab PO BID";
    const ordinaryPlan = createBoundaryPlan(ordinary);
    const ordinaryStates = ordinaryPlan.segments.map(segment => parseClauseState(segment.text));
    expect(buildRegimenGraph(ordinaryPlan, ordinaryPlan.segments, ordinaryStates).repeatCycle)
      .toBeUndefined();
    expect(parseSig(ordinary).fhirNext.repeatCycle).toBeUndefined();
  });

  it("keeps local or conflicting cycles off the whole-course projection", () => {
    const mixed =
      "1 tab daily for 7 days then stop for 7 days repeat for 3 cycles; 1 puff BID";
    const mixedPlan = createBoundaryPlan(mixed);
    const mixedStates = mixedPlan.segments.map(segment => parseClauseState(segment.text));
    const mixedGraph = buildRegimenGraph(mixedPlan, mixedPlan.segments, mixedStates);
    expect(mixedGraph.phases).toHaveLength(2);
    expect(mixedGraph.phases[0]).toMatchObject({
      members: [0], repeatCycle: { value: 14, unit: "d" }, repeatCount: 3
    });
    expect(mixedGraph.phases[1].members).toEqual([1]);
    expect(mixedGraph.phases[1].repeatCycle).toBeUndefined();
    expect(mixedGraph.phases[1].repeatCount).toBeUndefined();
    expect(mixedGraph.repeatCycle).toBeUndefined();
    const mixedFinal = parseSig(mixed);
    expect(mixedFinal.meta.segments.map(segment => segment.text)).toEqual([
      "1 tab daily for 7 days then stop for 7 days repeat for 3 cycles",
      "1 puff BID"
    ]);
    expect(mixedFinal.meta.canonical.clauses.map(clause => ({
      source: clause.rawText,
      cycle: clause.schedule?.repeatCycle?.value,
      count: clause.schedule?.repeatCount
    }))).toEqual([
      {
        source: "1 tab daily for 7 days then stop for 7 days repeat for 3 cycles",
        cycle: 14,
        count: 3
      },
      { source: "1 puff BID", cycle: undefined, count: undefined }
    ]);
    expect(mixedFinal.fhirNext.repeatCycle).toBeUndefined();
    expect(toDosageDetails(JSON.parse(JSON.stringify(mixedFinal.fhir))).repeatCycle)
      .toBeUndefined();

    const conflicting =
      "1 tab daily for 7 days then stop for 7 days repeat; " +
      "1 tab daily for 5 days then stop for 5 days repeat";
    const conflictPlan = createBoundaryPlan(conflicting);
    const conflictStates = conflictPlan.segments.map(segment => parseClauseState(segment.text));
    const conflictGraph = buildRegimenGraph(conflictPlan, conflictPlan.segments, conflictStates);
    expect(conflictGraph.phases.map(phase => phase.repeatCycle?.value)).toEqual([14, 10]);
    expect(conflictGraph.repeatCycle).toBeUndefined();
    const conflictingFinal = parseSig(conflicting);
    expect(conflictingFinal.meta.canonical.clauses.map(clause => ({
      source: clause.rawText,
      cycle: clause.schedule?.repeatCycle?.value
    }))).toEqual([
      { source: "1 tab daily for 7 days then stop for 7 days repeat", cycle: 14 },
      { source: "1 tab daily for 5 days then stop for 5 days repeat", cycle: 10 }
    ]);
    expect(conflictingFinal.fhirNext.repeatCycle).toBeUndefined();
    expect(toDosageDetails(JSON.parse(JSON.stringify(conflictingFinal.fhir))).repeatCycle)
      .toBeUndefined();
  });

  it("uses calendar-day horizons across daylight-saving transitions", () => {
    const dosage = parseSig("1 tab daily at 08:00").fhir[0];
    expect(calculateTotalUnits({
      dosage,
      from: "2024-03-09T08:00:00-05:00",
      orderedAt: "2024-03-09T08:00:00-05:00",
      timeZone: "America/New_York",
      durationValue: 2,
      durationUnit: "d"
    })).toMatchObject({ totalUnits: 2, unit: "tab" });
  });

  it("keeps ordinary schedule opportunities visible when maxima need extra clinical context", () => {
    const source = parseSig("1 tab PO BID").fhir[0];
    const period = {
      ...source,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      maxDosePerPeriod: [{
        numerator: { value: 20, unit: "mg" },
        denominator: { value: 1, unit: "d" }
      }]
    };
    expect(nextDueDoses(period, base)).toHaveLength(base.limit);
    expect(calculateTotalUnits({
      dosage: period, from: base.from, orderedAt: base.orderedAt,
      timeZone: base.timeZone, durationValue: 3, durationUnit: "d"
    })).toMatchObject({ quantityKind: "maximum", totalUnits: 6 });

    const lifetime = { ...source, maxDosePerLifetime: { value: 4, unit: "tab" } };
    expect(nextDueDoses(lifetime, base)).toHaveLength(base.limit);
    expect(calculateTotalUnits({
      dosage: lifetime, from: base.from, orderedAt: base.orderedAt,
      timeZone: base.timeZone, durationValue: 3, durationUnit: "d"
    })).toMatchObject({ quantityKind: "maximum", totalUnits: 4 });

    const perAdministration = {
      ...source, maxDosePerAdministration: { value: 0.5, unit: "tab" }
    };
    expect(nextDueDoses(perAdministration, base)).toHaveLength(base.limit);
    expect(calculateTotalUnits({
      dosage: perAdministration, from: base.from, orderedAt: base.orderedAt,
      timeZone: base.timeZone, durationValue: 3, durationUnit: "d"
    })).toMatchObject({
      totalUnits: 6,
      unit: "tab",
      quantityKind: "maximum",
      explanation: expect.stringContaining("unevaluable maximum-dose constraint")
    });
  });
});


// Whole-course supply shares the execution-family regression suite.
{
const begin = "2026-10-19T08:00:00+07:00";
const base = {
  from: begin,
  orderedAt: begin,
  durationValue: 30,
  durationUnit: "d" as FhirPeriodUnit,
  timeZone: "Asia/Bangkok"
};
const eyeCourse = "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid";
function allFormats(text: string) {
  const parsed = parseSig(text);
  return [parsed, parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)];
}

describe("whole-course numeric supply and API parity", () => {
  it("calculates single-site, sequential and parallel tapers exactly", () => {
    const cases = [
      ["1 drop OD QID x7d", 28],
      ["1 drop OD QID x7d then BID x7d", 42],
      [eyeCourse, 296]
    ] as const;
    for (const [sig, count] of cases) {
      for (const dosage of allFormats(sig)) {
        const total = calculateTotalUnits({ ...base, dosage });
        expect(total.totalUnits).toBe(count);
      }
    }
  });

  it("rounds whole-course supply before counting containers, just like a single dosage", () => {
    const dosage = parseSig("1 tab po daily").fhir[0];
    const options = {
      ...base, roundToMultiple: 14,
      context: { dosageForm: "tablet", containerValue: 10, containerUnit: "tab" }
    };
    const single = calculateTotalUnits({ ...options, dosage });
    const course = calculateTotalUnits({ ...options, dosage: [dosage] });
    expect(single.totalUnits).toBe(42);
    expect(course.totalUnits).toBe(single.totalUnits);
    expect(course.totalContainers).toBe(single.totalContainers);
    expect(course.totalContainerQuantity).toEqual(single.totalContainerQuantity);
  });

  it("keeps fractional package quantity separate from physical containers", () => {
    const dosage = parseSig("apply half bottle once daily").fhir[0];
    const options = {
      ...base, durationValue: 1,
      context: { packageUnit: "bottle", containerValue: 120, containerUnit: "mL" }
    };
    const single = calculateTotalUnits({ ...options, dosage });
    const course = calculateTotalUnits({ ...options, dosage: [dosage] });
    expect(single.totalUnits).toBe(0.5);
    expect(single.totalContainers).toBe(1);
    expect(single.totalContainerQuantity).toEqual({ value: 60, unit: "mL" });
    expect(course.totalUnits).toBe(single.totalUnits);
    expect(course.totalContainers).toBe(single.totalContainers);
    expect(course.totalContainerQuantity).toEqual(single.totalContainerQuantity);
  });

  it("rounds eye-drop volume and ingredient mass before counting bottles", () => {
    const sig = "1 drop OD qid";
    const parsed = parseSig(sig);
    const options = {
      ...base, roundToMultiple: 300,
      context: {
        dosageForm: "eye drops", strength: "500 mcg / 100 mL",
        containerValue: 5, containerUnit: "mL"
      }
    };
    const single = calculateTotalUnits({ ...options, dosage: parsed.fhir[0] });
    expect(single.totalUnits).toBe(300);
    expect(single.totalApproximateQuantity).toMatchObject({ value: 15, unit: "mL" });
    expect(single.totalApproximateIngredientQuantity).toMatchObject({
      value: 75, unit: "mcg"
    });
    expect(single.totalContainers).toBe(3);
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      const result = calculateTotalUnits({ ...options, dosage });
      expect(result.totalUnits).toBe(single.totalUnits);
      expect(result.totalApproximateQuantity).toEqual(single.totalApproximateQuantity);
      expect(result.totalApproximateIngredientQuantity)
        .toEqual(single.totalApproximateIngredientQuantity);
      expect(result.totalContainerQuantity).toEqual(single.totalContainerQuantity);
      expect(result.totalContainers).toBe(single.totalContainers);
    }
  });

  it("rounds a combined parallel course once, including estimated volume", () => {
    const parsed = parseSig("1 drop OD qid; 1 drop OS qid");
    const options = {
      ...base, roundToMultiple: 500,
      context: { dosageForm: "eye drops", containerValue: 5, containerUnit: "mL" }
    };
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      const result = calculateTotalUnits({ ...options, dosage });
      expect(result.totalUnits).toBe(500);
      expect(result.totalApproximateQuantity).toMatchObject({
        value: 25, unit: "mL"
      });
      expect(result.totalContainers).toBe(5);
      expect(result.totalContainerQuantity).toMatchObject({
        value: 25, unit: "mL"
      });
    }
  });

const parkinsonEventClock = {
  [EventTiming.Wake]: "06:30",
  [EventTiming.Morning]: "08:00",
  [EventTiming["Before Sleep"]]: "22:00",
  [EventTiming.Noon]: "12:00",
  [EventTiming.Breakfast]: "08:00",
  [EventTiming.Lunch]: "12:30",
  [EventTiming.Dinner]: "18:30"
};

const parkinsonDue = {
  orderedAt: "2026-11-02T00:00:00+07:00",
  from: "2026-11-02T00:00:00+07:00",
  timeZone: "Asia/Bangkok",
  eventClock: parkinsonEventClock,
  mealOffsets: {
    [EventTiming["Before Meal"]]: -30,
    [EventTiming["After Meal"]]: 30,
    [EventTiming["After Breakfast"]]: 30,
    [EventTiming["After Lunch"]]: 30,
    [EventTiming["After Dinner"]]: 30
  },
  limit: 64
} as const;

function executableParkinsonRepresentations(source: string) {
  const parsed = parseSig(source);
  return {
    parsed,
    executable: [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)] as const
  };
}

function dueOn(
  dosage: FhirR6DosageInstruction | readonly FhirDosage[],
  localDate: string
): string[] {
  return nextDueDoses(dosage, {
    ...parkinsonDue,
    from: `${localDate}T00:00:00+07:00`
  }).filter(timestamp => timestamp.startsWith(localDate));
}

function totalUnitsOver21Days(
  dosage: FhirR6DosageInstruction | readonly FhirDosage[]
) {
  return calculateTotalUnits({
    dosage,
    from: parkinsonDue.from,
    orderedAt: parkinsonDue.orderedAt,
    timeZone: parkinsonDue.timeZone,
    eventClock: parkinsonDue.eventClock,
    mealOffsets: parkinsonDue.mealOffsets,
    durationValue: 21,
    durationUnit: FhirPeriodUnit.Day
  });
}

describe("Parkinson wake, clock, meal and finite-phase execution", () => {
  it("executes a typed waking-hours interval only inside caller-configured clocks", () => {
    const source = "รับประทาน 1 เม็ดทุก 4 ชั่วโมงเฉพาะเวลาตื่นนอน";
    const { parsed, executable } = executableParkinsonRepresentations(source);
    expect(parsed.fhirNext.step[0]?.component[0]?.timing?.repeat).toMatchObject({
      period: 4,
      periodUnit: "h",
      when: [EventTiming.Wake]
    });

    const expected = [
      "2026-11-02T06:30:00+07:00",
      "2026-11-02T10:30:00+07:00",
      "2026-11-02T14:30:00+07:00",
      "2026-11-02T18:30:00+07:00"
    ];
    for (const dosage of executable) {
      expect(dueOn(dosage, "2026-11-02")).toEqual(expected);
      expect(totalUnitsOver21Days(dosage).totalUnits).toBe(84);
      expect(() => nextDueDoses(dosage, {
        ...parkinsonDue,
        eventClock: { [EventTiming.Wake]: "06:30" },
        limit: 1
      })).toThrow(/waking-hours interval.*WAKE.*HS/i);
      expect(() => calculateTotalUnits({
        dosage,
        from: parkinsonDue.from,
        orderedAt: parkinsonDue.orderedAt,
        timeZone: parkinsonDue.timeZone,
        eventClock: { [EventTiming.Wake]: "06:30" },
        durationValue: 1,
        durationUnit: FhirPeriodUnit.Day
      })).toThrow(/waking-hours interval.*WAKE.*HS/i);
    }

    const unrestricted: FhirDosage = {
      timing: { repeat: { period: 4, periodUnit: "h" } }
    };
    expect(nextDueDoses(unrestricted, {
      ...parkinsonDue,
      limit: 6
    })).toEqual([
      "2026-11-02T00:00:00+07:00",
      "2026-11-02T04:00:00+07:00",
      "2026-11-02T08:00:00+07:00",
      "2026-11-02T12:00:00+07:00",
      "2026-11-02T16:00:00+07:00",
      "2026-11-02T20:00:00+07:00"
    ]);
  });

  it("executes an English while-awake interval from its typed WAKE restriction", () => {
    const { parsed, executable } = executableParkinsonRepresentations(
      "Take 1 tablet every 3 hours while awake."
    );
    const intervalRepeat = parsed.fhirNext.step[0]?.component[0]?.timing?.repeat;
    expect(intervalRepeat).toMatchObject({ period: 3, periodUnit: "h" });
    // A window is not an instantaneous wake-up administration.
    expect(intervalRepeat?.when).toBeUndefined();
    expect(intervalRepeat?.extension).toContainEqual(
      expect.objectContaining({
        url: expect.stringContaining("urn:ezmedicationinput:StructureDefinition:medication-timing-event-window"),
        extension: [
          { url: "start", valueCode: "WAKE" },
          { url: "end", valueCode: "HS" }
        ]
      })
    );
    const expected = ["06:30", "09:30", "12:30", "15:30", "18:30", "21:30"]
      .map(clock => `2026-11-02T${clock}:00+07:00`);
    for (const dosage of executable) {
      expect(dueOn(dosage, "2026-11-02")).toEqual(expected);
      expect(totalUnitsOver21Days(dosage).totalUnits).toBe(126);
    }
  });

  it("executes the waking dose followed by q4h while-awake doses on the same day", () => {
    const { parsed, executable } = executableParkinsonRepresentations(
      "Take 1 tablet on waking, then 1 tablet every 4 hours while awake."
    );
    // A waking dose is the first opportunity in the identical recurring
    // waking-hours series. One typed interval component or equivalent
    // source-coordinated daughters may represent it; never demand duplicate
    // 06:30 administrations merely because the doctor mentioned WAKE twice.
    const components = parsed.fhirNext.step.flatMap(step => step.component);
    expect(components.length).toBeGreaterThan(0);
    expect(components.every(component =>
      component.doseAndRate?.[0]?.doseQuantity?.value === 1)).toBe(true);
    expect(components.some(component =>
      component.timing?.repeat?.period === 4 &&
      component.timing?.repeat?.periodUnit === "h" &&
      component.timing.repeat.extension?.some(extension =>
        extension.url.endsWith("urn:ezmedicationinput:StructureDefinition:medication-timing-event-window"))
    )).toBe(true);
    const expected = [
      "2026-11-02T06:30:00+07:00",
      "2026-11-02T10:30:00+07:00",
      "2026-11-02T14:30:00+07:00",
      "2026-11-02T18:30:00+07:00"
    ];
    for (const dosage of executable) {
      expect(dueOn(dosage, "2026-11-02")).toEqual(expected);
      expect(totalUnitsOver21Days(dosage).totalUnits).toBe(84);
    }
  });

  it("keeps explicit and event clocks together without inventing extra administrations", () => {
    const exact = executableParkinsonRepresentations(
      "Take 1 tablet at 06:00, 10:00, 14:00 and 18:00 every day."
    );
    const mixed = executableParkinsonRepresentations(
      "Take 1 tablet at 07:00, noon, 17:00 and bedtime."
    );
    for (const dosage of exact.executable) {
      expect(dueOn(dosage, "2026-11-02")).toEqual([
        "2026-11-02T06:00:00+07:00",
        "2026-11-02T10:00:00+07:00",
        "2026-11-02T14:00:00+07:00",
        "2026-11-02T18:00:00+07:00"
      ]);
    }
    for (const dosage of mixed.executable) {
      expect(dueOn(dosage, "2026-11-02")).toEqual([
        "2026-11-02T07:00:00+07:00",
        "2026-11-02T12:00:00+07:00",
        "2026-11-02T17:00:00+07:00",
        "2026-11-02T22:00:00+07:00"
      ]);
    }
  });

  it.each([
    "Take 1 tablet 30 minutes before breakfast, lunch and dinner.",
    "รับประทาน 1 เม็ดก่อนอาหารเช้า กลางวัน และเย็น 30 นาที"
  ])("applies the encoded offset to all configured meal clocks: %s", source => {
    const { executable } = executableParkinsonRepresentations(source);
    const expected = [
      "2026-11-02T07:30:00+07:00",
      "2026-11-02T12:00:00+07:00",
      "2026-11-02T18:00:00+07:00"
    ];
    for (const dosage of executable) {
      expect(dueOn(dosage, "2026-11-02")).toEqual(expected);
    }
  });

  it.each([
    {
      source: "Take 1 tablet 30 minutes before breakfast, half a tablet at 15:00 and 1 tablet at bedtime.",
      doses: [1, 0.5, 1], clocks: ["07:30", "15:00", "22:00"], total: 52.5
    },
    {
      source: "Take 1 tablet 30 minutes before meals, plus half a tablet at 22:00.",
      doses: [1, 0.5], clocks: ["07:30", "12:00", "18:00", "22:00"], total: 73.5
    },
    {
      source: "Take 1 tablet after breakfast and lunch, then half a tablet at bedtime.",
      doses: [1, 0.5], clocks: ["08:30", "13:00", "22:00"], total: 52.5
    },
    {
      source: "รับประทาน 1 เม็ดหลังอาหารเช้าและเที่ยง ครึ่งเม็ดก่อนนอน",
      doses: [1, 0.5], clocks: ["08:30", "13:00", "22:00"], total: 52.5
    }
  ])("keeps each mixed dose on its actual daily administration: $source", ({
    source, doses, clocks, total
  }) => {
    const { parsed, executable } = executableParkinsonRepresentations(source);
    expect(parsed.fhirNext.step).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component.map(component =>
      component.doseAndRate?.[0]?.doseQuantity?.value)).toEqual(doses);
    const expected = clocks.map(clock => `2026-11-02T${clock}:00+07:00`);
    for (const dosage of executable) {
      expect(dueOn(dosage, "2026-11-02")).toEqual(expected);
      expect(totalUnitsOver21Days(dosage).totalUnits).toBe(total);
    }
  });

  it("ends every member of a finite parallel phase at the shared phase boundary", () => {
    const source = "Take half a tablet in the morning and one tablet at bedtime for 7 days, " +
      "then one tablet in the morning and one tablet at bedtime for 7 days.";
    const { parsed, executable } = executableParkinsonRepresentations(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[0].component.map(component =>
      component.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([0.5, 1]);
    // Equal morning/bedtime amounts may be represented by one component
    // with two WHEN events instead of duplicating the dosage component.
    const secondPhase = parsed.fhirNext.step[1].component.flatMap(component =>
      (component.timing?.repeat?.when ?? []).map(when => ({
        when, amount: component.doseAndRate?.[0]?.doseQuantity?.value
      }))
    ).sort((left, right) => left.when.localeCompare(right.when));
    expect(secondPhase).toEqual([
      { when: "HS", amount: 1 },
      { when: "MORN", amount: 1 }
    ]);

    for (const dosage of executable) {
      expect(dueOn(dosage, "2026-11-02")).toEqual([
        "2026-11-02T08:00:00+07:00",
        "2026-11-02T22:00:00+07:00"
      ]);
      expect(dueOn(dosage, "2026-11-09")).toEqual([
        "2026-11-09T08:00:00+07:00",
        "2026-11-09T22:00:00+07:00"
      ]);
      expect(dueOn(dosage, "2026-11-16")).toEqual([]);
      expect(totalUnitsOver21Days(dosage).totalUnits).toBe(24.5);
    }
  });

  it.each([
    {
      source: "Take 0.5 tablet once daily for 7 days, then 0.5 tablet twice daily for 7 days, then 1 tablet twice daily.",
      doses: [[0.5], [0.5], [1]],
      total: 24.5,
      days: [["09:00"], ["08:00", "20:00"], ["08:00", "20:00"]]
    },
    {
      source: "Take 0.25 mg at bedtime for 1 week, then 0.5 mg at bedtime for 1 week, then 1 mg at bedtime.",
      doses: [[0.25], [0.5], [1]],
      total: 12.25,
      days: [["22:00"], ["22:00"], ["22:00"]]
    },
    {
      source: "Take 2 tablets three times daily for 7 days, then 1 tablet three times daily for 7 days, then half tablet three times daily for 7 days.",
      doses: [[2], [1], [0.5]],
      total: 73.5,
      days: [["08:00", "14:00", "20:00"], ["08:00", "14:00", "20:00"], ["08:00", "14:00", "20:00"]]
    },
    {
      source: "Take 1 tablet four times daily at 07:00, 11:00, 15:00 and 19:00 for 2 weeks, then take 1 tablet three times daily at 07:00, 13:00 and 19:00.",
      doses: [[1], [1]],
      total: 77,
      days: [["07:00", "11:00", "15:00", "19:00"], ["07:00", "11:00", "15:00", "19:00"], ["07:00", "13:00", "19:00"]]
    }
  ])("preserves finite taper boundaries, timestamps and per-phase dose amounts: $source", ({
    source, doses, total, days
  }) => {
    const { parsed, executable } = executableParkinsonRepresentations(source);
    expect(parsed.fhirNext.step.map(step => step.component.map(component =>
      component.doseAndRate?.[0]?.doseQuantity?.value))).toEqual(doses);
    const dates = ["2026-11-02", "2026-11-09", "2026-11-16"];
    for (const dosage of executable) {
      expect(dates.map(date => dueOn(dosage, date))).toEqual(
        dates.map((date, index) => days[index].map(clock =>
          `${date}T${clock}:00+07:00`))
      );
      expect(totalUnitsOver21Days(dosage).totalUnits).toBe(total);
    }
  });
});

  it("sums 30-day and 45-day site-specific transitions, never multiplying all phases by the full horizon", () => {
    const parsed = parseSig(eyeCourse);
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 45 }).totalUnits)
        .toBe(388);
    }
    const days = nextDueDoses(parsed, {
      from: begin, orderedAt: begin, timeZone: "Asia/Bangkok", limit: 1000
    }).filter(time => Date.parse(time) < Date.parse("2026-11-18T08:00:00+07:00"));
    expect(days).toHaveLength(296);
  });

  it("calculates the true number of bottles from the combined eye course, without per-stage rounding", () => {
    const parsed = parseSig(eyeCourse);
    const context = { dosageForm: "eye drop", containerValue: 5, containerUnit: "mL" };
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      const total = calculateTotalUnits({ ...base, dosage, context });
      expect(total).toMatchObject({
        totalUnits: 296, unit: "drop", totalContainers: 3,
        totalApproximateQuantity: { value: 14.8, unit: "mL" }
      });
    }
  });

  it("calculates exact alternate-day and specific excluded-date supplies", () => {
    for (const [sig, n] of [
      ["1 tab daily except Mondays and Wednesdays", 10],
      ["1 tab daily except 20/10/2026 and 22/10/2026", 12]
    ] as const) {
      for (const dosage of allFormats(sig)) {
        expect(calculateTotalUnits({ ...base, dosage, durationValue: 14 }).totalUnits)
          .toBe(n);
      }
    }
  });

  it("returns an explicit maximum-supply explanation for PRN, rather than a silent approximation", () => {
    for (const dosage of allFormats("2 tabs Q4H PRN pain max 4 tablets/day")) {
      const result = calculateTotalUnits({ ...base, dosage, durationValue: 7 });
      expect(result).toMatchObject({
        totalUnits: 28, unit: "tab", quantityKind: "maximum"
      });
      expect(result.explanation).toMatch(/PRN.*may be used less frequently/);
    }
  });

  it("returns a numerical conditional maximum without measurements and an exact zero when observations reject all doses", () => {
    for (const dosage of allFormats("1 tab PO BID only if BP >160, otherwise hold")) {
      const maximum = calculateTotalUnits({ ...base, dosage, durationValue: 7 });
      expect(maximum).toMatchObject({ totalUnits: 14, quantityKind: "maximum" });
      expect(maximum.explanation).toContain("evaluateCondition");
      const noDoses = calculateTotalUnits({
        ...base, dosage, durationValue: 7, evaluateCondition: () => false
      });
      expect(noDoses.totalUnits).toBe(0);
    }
  });

  it("computes a concrete per-kg administered quantity once patient weight is supplied", () => {
    for (const dosage of allFormats("0.5 mg/kg PO BID")) {
      const result = calculateTotalUnits({
        ...base, dosage, durationValue: 7, patientWeightKg: 65
      });
      expect(result.totalUnits).toBe(455);
      expect(result.unit).toBe("mg");
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 7 }))
        .toMatchObject({ totalUnits: 7, unit: "mg/kg", quantityKind: "scheduled" });
    }
  });

  it("computes infusion volume from rate times infusion duration instead of treating a rate as a dose", () => {
    for (const dosage of allFormats("Infuse IV at 2 mL/h for 12 hours")) {
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 7 }))
        .toMatchObject({ totalUnits: 24, unit: "mL" });
    }
  });

  it("computes recognized per-kg infusion rates using duration and weight, never as a bolus", () => {
    const instruction = "Infuse dopamine at 5 mcg/kg/min IV for 4 hours";
    for (const dosage of allFormats(instruction)) {
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 1 }))
        .toMatchObject({ totalUnits: 1200, unit: "ug/kg", quantityKind: "scheduled" });
      const measured = calculateTotalUnits({
        ...base, dosage, durationValue: 1, patientWeightKg: 70
      });
      expect(measured.totalUnits).toBe(84000);
      expect(measured.unit).toBe("ug");
    }
  });

  it("keeps the schedule visible when a period maximum conflicts, and labels supply as best-effort", () => {
    const valid = parseSig("2 tablets BID").fhir[0];
    const capped = {
      ...valid,
      maxDosePerPeriod: [{
        numerator: { value: 1, unit: "tab" },
        denominator: { value: 1, unit: "d", code: "d" }
      }]
    };
    const opts = { from: begin, orderedAt: begin, timeZone: "Asia/Bangkok", limit: 10 };
    for (const dosage of [capped, [capped]]) {
      expect(nextDueDoses(dosage, opts)).toHaveLength(10);
      expect(calculateTotalUnits({ ...base, dosage, durationValue: 3 }))
        .toMatchObject({ totalUnits: 12, quantityKind: "maximum" });
    }
    const acceptable = {
      ...capped,
      maxDosePerPeriod: [{
        numerator: { value: 2, unit: "tab" },
        denominator: { value: 1, unit: "d", code: "d" }
      }]
    };
    expect(nextDueDoses(acceptable, { ...opts, limit: 3 })).toHaveLength(3);
    expect(calculateTotalUnits({ ...base, dosage: acceptable, durationValue: 3 }).totalUnits)
      .toBe(6);
  });

  it("accepts all four representations after a FHIR R6 JSON import", () => {
    const p = parseSig(eyeCourse);
    const imported = fromFhir(JSON.parse(JSON.stringify(p.fhirNext)));
    expect(calculateTotalUnits({ ...base, dosage: imported }).totalUnits).toBe(296);
    expect(calculateTotalUnits({ ...base, dosage: imported.fhir }).totalUnits).toBe(296);
  });

  it("requires only facts that are mathematically necessary, while keeping resolvable courses usable", () => {
    const weightBased = parseSig("0.5 mg/kg PO BID");
    expect(calculateTotalUnits({ ...base, dosage: weightBased }))
      .toMatchObject({ totalUnits: 30, unit: "mg/kg", quantityKind: "scheduled" });

    const relative = parseSig(eyeCourse);
    const withoutStart = { ...base, dosage: relative };
    delete (withoutStart as Partial<typeof withoutStart>).orderedAt;
    expect(calculateTotalUnits(withoutStart)).toMatchObject({
      totalUnits: 296,
      unit: "drop",
      quantityKind: "scheduled",
      explanation: expect.stringContaining("assumed")
    });

    const overlappingText = parseSig(
      "1 drop OD q2h x4wk then qid; 1 drop OS qid x1mo then bid"
    );
    expect(calculateTotalUnits({ ...base, dosage: overlappingText }).totalUnits).toBeGreaterThan(0);

    const missingPhaseBound = parseSig("1 tab QID then BID");
    expect(calculateTotalUnits({ ...base, dosage: missingPhaseBound })).toMatchObject({
      totalUnits: 120,
      unit: "tab",
      quantityKind: "scheduled",
      explanation: expect.stringContaining("without a stated cutover")
    });
  });

  it("keeps sync, async, suggestions and schedule consumers aligned on the same dosage meaning", async () => {
    const sync = parseSig(eyeCourse);
    const asyncValue = await parseSigAsync(eyeCourse);
    expect(asyncValue.fhir).toEqual(sync.fhir);
    expect(asyncValue.fhirNext).toEqual(sync.fhirNext);
    const suggestions = suggestSig("1 drop od q", { limit: 10 });
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions.slice(0, 5)) {
      expect(typeof suggestion).toBe("string");
      expect(suggestion.length).toBeGreaterThan(0);
    }
    const dueOpts = {
      from: begin, orderedAt: begin, timeZone: "Asia/Bangkok", limit: 12
    };
    const expected = nextDueDoses(sync, dueOpts);
    expect(nextDueDoses(sync.fhir, dueOpts)).toEqual(expected);
    expect(nextDueDoses(sync.fhirNext, dueOpts)).toEqual(expected);
    expect(calculateTotalUnits({ ...base, dosage: asyncValue }).totalUnits)
      .toBe(296);
  });
});

}


describe("punctuation and typed treatment-phase sequencing", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const clocks = {
    timeZone: "Asia/Bangkok",
    orderedAt,
    eventClock: {
      [EventTiming.Breakfast]: "08:00",
      [EventTiming.Lunch]: "12:30",
      [EventTiming.Dinner]: "18:30"
    },
    mealOffsets: {
      [EventTiming["Before Breakfast"]]: -30,
      [EventTiming["Before Lunch"]]: -30,
      [EventTiming["Before Dinner"]]: -30
    }
  };
  const dueOn = (regimen: FhirR6DosageInstruction | FhirDosage[], date: string) =>
    nextDueDoses(regimen, {
      ...clocks, from: date + "T00:00:00+07:00", limit: 20
    }).filter(value => value.startsWith(date)).map(value => value.slice(11, 16));

  it.each([
    [", then take", "comma"],
    ["; then take", "semicolon"],
    [". Then take", "period"]
  ] as const)("keeps sequential clock regimens distinct across %s", (separator) => {
    const source = "Take 1 tablet at 08:00, 13:00, and 19:00 for 7 days" +
      separator + " 1 tablet at 08:00 and 19:00 for 7 days.";
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    const plan = createBoundaryPlan(source, undefined, { trace: true });
    expect(plan.relations.some(link => link.kind === "sequence")).toBe(true);
    for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual(["08:00", "13:00", "19:00"]);
      expect(dueOn(regimen, "2026-11-09")).toEqual(["08:00", "19:00"]);
      expect(dueOn(regimen, "2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({
        dosage: regimen, ...clocks, from: orderedAt,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(35);
    }
  });

  it.each([
    [", then take", "comma"],
    ["; then take", "semicolon"],
    [". Then take", "period"]
  ] as const)("keeps premeal-to-with-meals phases distinct across %s", separator => {
    const source = "Take 1 tablet 30 minutes before breakfast, lunch, and dinner for 7 days" +
      separator + " 1 tablet at breakfast, lunch, and dinner for 7 days.";
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(dueOn(regimen, "2026-11-02")).toEqual(["07:30", "12:00", "18:00"]);
      expect(dueOn(regimen, "2026-11-09")).toEqual(["08:00", "12:30", "18:30"]);
      expect(dueOn(regimen, "2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({
        dosage: regimen, ...clocks, from: orderedAt,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(42);
    }
  });
});


describe("source-targeted clock adjustment within a finite staged regimen", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const options = { orderedAt, timeZone: "Asia/Bangkok" };
  const daily = (regimen: FhirR6DosageInstruction | FhirDosage[], date: string) =>
    nextDueDoses(regimen, {
      ...options, from: date + "T00:00:00+07:00", limit: 16
    }).filter(time => time.startsWith(date)).map(time => time.slice(11, 16));
  const perClockDose = (step: FhirR6DosageStep) =>
    step.component.flatMap(item =>
      (item.timing?.repeat?.timeOfDay ?? []).map(clock => ({
        time: clock.slice(0, 5), amount: item.doseAndRate?.[0]?.doseQuantity?.value
      }))).sort((a, b) => a.time.localeCompare(b.time));

  it.each([
    "increase only the 20:00 dose to 2 tablets",
    "increase the 20:00 dose to 2 tablets"
  ])("keeps the unchanged morning dose when specifically changing one clock: %s", adjustment => {
    const source = "Take 1 tablet at 08:00 and 20:00 for 7 days, then " +
      adjustment + " for 7 days.";
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(perClockDose(parsed.fhirNext.step[0])).toEqual([
      { time: "08:00", amount: 1 }, { time: "20:00", amount: 1 }
    ]);
    expect(perClockDose(parsed.fhirNext.step[1])).toEqual([
      { time: "08:00", amount: 1 }, { time: "20:00", amount: 2 }
    ]);
    for (const form of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(daily(form, "2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(daily(form, "2026-11-09")).toEqual(["08:00", "20:00"]);
      expect(daily(form, "2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({
        dosage: form, ...options, from: orderedAt,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(35);
    }
  });

  it("does not duplicate the old clock list when the entire regimen is explicitly replaced", () => {
    const parsed = parseSig(
      "Take 1 tablet at 08:00 and 20:00 for 7 days, then increase to 2 tablets at 08:00 and 20:00 for 7 days."
    );
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(perClockDose(parsed.fhirNext.step[1])).toEqual([
      { time: "08:00", amount: 2 }, { time: "20:00", amount: 2 }
    ]);
    expect(calculateTotalUnits({
      dosage: parsed.fhirNext, ...options, from: orderedAt,
      durationValue: 21, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(42);
  });

  it("does not invent an unchanged dose when the next phase has no typed targeted adjustment", () => {
    const parsed = parseSig(
      "Take 1 tablet at 08:00 and 20:00 for 7 days, then take 2 tablets at 20:00 for 7 days."
    );
    expect(perClockDose(parsed.fhirNext.step[1])).toEqual([
      { time: "20:00", amount: 2 }
    ]);
  });
});


describe("source-backed finite pause before medication resumption", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const options = { orderedAt, timeZone: "Asia/Bangkok" };
  const due = (course: FhirR6DosageInstruction | FhirDosage[], date: string) =>
    nextDueDoses(course, { ...options,
      from: date + "T00:00:00+07:00", limit: 14
    }).filter(time => time.startsWith(date)).map(time => time.slice(11, 16));

  it("preserves a typed seven-day medication pause before a separately dosed resumption", () => {
    const source = "Take 1 tablet at 08:00 and 20:00 for 7 days, then stop for 7 days, then resume 1 tablet at 08:00 and 20:00 for 7 days.";
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[1].start?.offsetDuration)
      .toMatchObject({ value: 14, code: "d" });
    for (const course of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(due(course, "2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(due(course, "2026-11-09")).toEqual([]);
      expect(due(course, "2026-11-16")).toEqual(["08:00", "20:00"]);
      expect(due(course, "2026-11-23")).toEqual([]);
      expect(calculateTotalUnits({
        dosage: course, ...options, from: orderedAt,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(28);
    }
  });

  it("does not add a phantom pause to ordinary consecutive finite phases", () => {
    const source = "Take 1 tablet at 08:00 and 20:00 for 7 days, then take 1 tablet at 08:00 and 20:00 for 7 days.";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(due(parsed.fhirNext, "2026-11-09")).toEqual(["08:00", "20:00"]);
    expect(due(parsed.fhirNext, "2026-11-16")).toEqual([]);
  });
});


describe("real-world lexical phase transition variants", () => {
  it.each([
    "Take 1 tablet at 08:00 daily for the next week then take 2 tablets at 08:00 daily",
    "Take 1 tablet at 08:00 daily for the next week, then take 2 tablets at 08:00 daily",
    "Take 1 tablet at 08:00 daily for next week then take 2 tablets at 08:00 daily"
  ])("keeps for-next-week duration intact before a separate subsequent phase: %s", input => {
    const result = parseSig(input);
    expect(result.meta.segments).toHaveLength(2);
    expect(result.meta.segments[0].text).toContain("next week");
    expect(result.fhir).toHaveLength(2);
    expect(result.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(result.fhir[0].timing?.repeat).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d",
      boundsDuration: { value: 1, code: "wk" }
    });
    expect(result.fhir[1].doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
    expect(result.fhir[1].timing?.repeat).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d"
    });
    expect(result.fhirNext.step).toHaveLength(2);
    for (const dosage of [result.fhirNext, toFhirR5Dosages(result.fhirNext)]) {
      expect(calculateTotalUnits({
        dosage,
        orderedAt: "2026-11-02T00:00:00+07:00",
        from: "2026-11-02T00:00:00+07:00",
        timeZone: "Asia/Bangkok",
        durationValue: 14,
        durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(21);
    }
    expect(result.fhirNext.renderedInstruction).toBe(input);
  });

  it.each([
    ["Take 1 tablet daily for the following week", 1, "wk"],
    ["Take 1 tablet daily for the next month", 1, "mo"],
    ["Take 1 tablet daily for the next 2 weeks", 2, "wk"]
  ])("preserves a source-backed following-course duration: %s", (input, value, unit) => {
    const result = parseSig(input);
    expect(result.fhir).toHaveLength(1);
    expect(result.fhir[0].timing?.repeat?.boundsDuration).toMatchObject({
      value, code: unit
    });
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.fhirNext.renderedInstruction).toBe(input);
  });

  it("still interprets a bare next-week header as the subsequent phase", () => {
    const input = "Take 1 tablet at 08:00 for 7 days; next week take 2 tablets at 08:00 daily.";
    const result = parseSig(input);
    expect(result.fhirNext.step).toHaveLength(2);
    expect(result.fhir[0].timing?.repeat?.boundsDuration?.value).toBe(7);
    expect(result.fhir[1].doseAndRate?.[0]?.doseQuantity?.value).toBe(2);
  });


  const start = "2026-11-02T00:00:00+07:00";
  const sourceEnglish = "Take 1 tablet at 08:00 and 20:00 for 7 days";
  const sourceThai = "กิน 1 เม็ด เวลา 08:00 และ 20:00 เป็นเวลา 7 วัน";
  const nextEnglish = "take 1 tablet at 08:00 for 7 days.";
  const nextThai = "กิน 1 เม็ด เวลา 08:00 อีก 7 วัน";
  const sources = [
    ["English afterwards", sourceEnglish + "; afterwards " + nextEnglish],
    ["English thereafter", sourceEnglish + "; thereafter " + nextEnglish],
    ["English next week", sourceEnglish + "; next week " + nextEnglish],
    ["English from week 2", sourceEnglish + "; from week 2 " + nextEnglish],
    ["Thai ต่อด้วย", sourceThai + " ต่อด้วย " + nextThai],
    ["Thai สัปดาห์ถัดไป", sourceThai + " สัปดาห์ถัดไป " + nextThai],
    ["Thai ในสัปดาห์ที่ 2", sourceThai + " ในสัปดาห์ที่ 2 " + nextThai]
  ] as const;
  const times = (regimen: FhirR6DosageInstruction | FhirDosage[], day: string) =>
    nextDueDoses(regimen, {
      timeZone: "Asia/Bangkok", orderedAt: start,
      from: day + "T00:00:00+07:00", limit: 14
    }).filter(value => value.startsWith(day)).map(value => value.slice(11, 16));
  it.each(sources)("keeps a finite two-week phase transition for %s", (_name, source) => {
    const result = parseSig(source);
    expect(result.input).toBe(source);
    expect(result.fhirNext.step).toHaveLength(2);
    for (const regimen of [result.fhirNext, toFhirR5Dosages(result.fhirNext)]) {
      expect(times(regimen, "2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(times(regimen, "2026-11-09")).toEqual(["08:00"]);
      expect(times(regimen, "2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({
        dosage: regimen, orderedAt: start, from: start,
        timeZone: "Asia/Bangkok", durationValue: 21, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(21);
    }
  });
  it.each([
    "Take 1 tablet at 08:00; from week 2 take 1 tablet at 20:00.",
    "กิน 1 เม็ดเวลา 08:00 ในสัปดาห์ที่ 2 กิน 1 เม็ดเวลา 20:00"
  ])("does not execute an explicit second-week administration in week one: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(times(regimen, "2026-11-02")).toEqual(["08:00"]);
      expect(times(regimen, "2026-11-09")).toEqual(["20:00"]);
      expect(times(regimen, "2026-11-16")).toEqual(["20:00"]);
      expect(calculateTotalUnits({
        dosage: regimen, orderedAt: start, from: start,
        timeZone: "Asia/Bangkok", durationValue: 21, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(21);
    }
  });

  it.each([
    ["English afterwards", "Take 1 tablet at 08:00; afterwards take 1 tablet at 20:00 every day.", ["08:00", "20:00"]],
    ["English thereafter", "Take 1 tablet at 08:00; thereafter take 1 tablet at 20:00 every day.", ["08:00", "20:00"]],
    ["Thai ต่อด้วย", "กิน 1 เม็ดตอนเช้า ต่อด้วย กิน 1 เม็ดก่อนนอนทุกวัน", ["08:00", "22:00"]]
  ] as const)("keeps a same-day %s instruction simultaneous without a licensed finite phase", (_name, source, expected) => {
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.step).toHaveLength(1);
    const eventClock = {
      [EventTiming.Morning]: "08:00",
      [EventTiming["Before Sleep"]]: "22:00"
    };
    for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      for (const date of ["2026-11-02", "2026-11-09"]) {
        expect(nextDueDoses(regimen, {
          orderedAt: start, from: date + "T00:00:00+07:00",
          timeZone: "Asia/Bangkok", eventClock, limit: 10
        }).filter(ts => ts.startsWith(date)).map(ts => ts.slice(11, 16)))
          .toEqual(expected);
      }
      expect(calculateTotalUnits({
        dosage: regimen, orderedAt: start, from: start,
        timeZone: "Asia/Bangkok", eventClock,
        durationValue: 14, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(28);
    }
  });

  it("does not invent a phase transition for an independently delimited prescription", () => {
    const source = sourceEnglish + "; " + nextEnglish;
    const result = parseSig(source);
    expect(result.fhirNext.step).toHaveLength(1);
    expect(times(result.fhirNext, "2026-11-02")).toEqual(["08:00", "08:00", "20:00"]);
    expect(times(result.fhirNext, "2026-11-09")).toEqual([]);
  });
});


describe("fronted week-two additive administration keeps its predecessor schedule", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  it.each([
    "Take 1 tablet at 08:00 and 20:00 daily. From week 2 add half a tablet at 14:00 daily.",
    "Take 1 tablet at 08:00 and 20:00 daily; from week 2 add half a tablet at 14:00 daily."
  ])("begins the additive half-dose at week two, not during week one: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    for (const regimen of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const timestamps = (date: string) => nextDueDoses(regimen, {
        orderedAt, from: date + "T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 12
      }).filter(ts => ts.startsWith(date)).map(ts => ts.slice(11, 16));
      expect(timestamps("2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(timestamps("2026-11-09")).toEqual(["08:00", "14:00", "20:00"]);
      expect(timestamps("2026-11-16")).toEqual(["08:00", "14:00", "20:00"]);
      expect(calculateTotalUnits({
        dosage: regimen, orderedAt, from: orderedAt,
        timeZone: "Asia/Bangkok", durationValue: 14,
        durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(31.5);
    }
    expect(parsed.meta.canonical.clauses.some(clause =>
      clause.evidence.some(item => item.rule.includes("phase") || item.rule.includes("treatment")) ||
      clause.schedule?.treatmentStartOffsetDays !== undefined
    )).toBe(true);
  });
});

describe("Thai additive and clock-target phase adjustments", () => {
  const base = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00" };
  const clocks = (dosage: FhirR6DosageInstruction | FhirDosage[], date: string) => nextDueDoses(dosage, {
    ...base, from: date + "T00:00:00+07:00", limit: 12
  }).filter(value => value.startsWith(date)).map(value => value.slice(11, 16));

  it.each(["หลังจากนั้น", "จากนั้น"])("keeps unchanged baseline doses when %s เพิ่มอีก introduces an additional dose", lead => {
    const source = `รับประทาน 1 เม็ด เวลา 08:00 และ 20:00 วันละ 2 ครั้ง 7 วัน ${lead}เพิ่มอีกครึ่งเม็ด เวลา 14:00 ตั้งแต่สัปดาห์ที่ 2`;
    const parsed = parseSig(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(clocks(dosage, "2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(clocks(dosage, "2026-11-09")).toEqual(["08:00", "14:00", "20:00"]);
      expect(clocks(dosage, "2026-11-16")).toEqual(["08:00", "14:00", "20:00"]);
      expect(calculateTotalUnits({ dosage, ...base, from: base.orderedAt,
        durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(31.5);
    }
    expect(parsed.input).toBe(source);
  });

  it.each(["เฉพาะเวลา", "เวลา"])("changes only the named clock for ลด%s while retaining morning medication", target => {
    const source = `รับประทาน 1 เม็ด เวลา 08:00 และ 20:00 เป็นเวลา 7 วัน จากนั้นลด${target} 20:00 เหลือครึ่งเม็ด เป็นเวลา 7 วัน`;
    const parsed = parseSig(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(clocks(dosage, "2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(clocks(dosage, "2026-11-09")).toEqual(["08:00", "20:00"]);
      expect(clocks(dosage, "2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...base, from: base.orderedAt,
        durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(24.5);
    }
  });

  it("keeps explicit twice-daily clocks consistent after a one-clock dose reduction", () => {
    const source = "รับประทาน 1 เม็ด เวลา 08:00 และ 20:00 วันละ 2 ครั้ง เป็นเวลา 7 วัน จากนั้นลดเฉพาะเวลา 20:00 เหลือครึ่งเม็ด เป็นเวลา 7 วัน";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.step[0].component[0].timing?.code?.coding?.map(coding => coding.code)).toContain("BID");
    const changed = parsed.fhirNext.step[1].component;
    expect(changed.map(component => [component.doseAndRate?.[0]?.doseQuantity?.value,
      component.timing?.repeat?.timeOfDay])).toEqual(expect.arrayContaining([
      [1, ["08:00:00"]], [0.5, ["20:00:00"]],
    ]));
    const morning = changed.find(component => component.timing?.repeat?.timeOfDay?.includes("08:00:00"));
    expect(morning?.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    for (const component of changed) {
      const repeat = component.timing?.repeat;
      // A sole daily clock can omit redundant numeric fields; supplied
      // cadence must still describe one daily administration, never BID.
      expect(repeat?.frequency ?? 1).toBe(1);
      expect(repeat?.period ?? 1).toBe(1);
      expect(repeat?.periodUnit ?? "d").toBe("d");
      expect(component.timing?.code?.coding?.map(coding => coding.code) ?? []).not.toContain("BID");
    }
    const strictR5 = toFhirR5Dosages(parsed.fhirNext);
    expect(strictR5.filter(row => row.sequence === 2).map(row =>
      [row.doseAndRate?.[0]?.doseQuantity?.value, row.timing?.repeat?.timeOfDay])).toEqual([
      [1, ["08:00:00"]], [0.5, ["20:00:00"]],
    ]);
    for (const dosage of [parsed.fhirNext, strictR5]) {
      expect(clocks(dosage, "2026-11-02")).toEqual(["08:00", "20:00"]);
      expect(clocks(dosage, "2026-11-09")).toEqual(["08:00", "20:00"]);
      expect(clocks(dosage, "2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...base, from: base.orderedAt,
        durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(24.5);
    }
  });

  it("retains a continued seven-day duration after a Thai clock-target reduction", () => {
    const source = "รับประทาน 1 เม็ด เวลา 08:00 และ 20:00 เป็นเวลา 7 วัน จากนั้นลดเฉพาะเวลา 20:00 เหลือครึ่งเม็ดต่ออีก 7 วัน";
    const parsed = parseSig(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(clocks(dosage, "2026-11-09")).toEqual(["08:00", "20:00"]);
      expect(clocks(dosage, "2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...base, from: base.orderedAt,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(24.5);
    }
  });

  it("distinguishes เพิ่มเป็น replacement and negated เพิ่มอีก from affirmative ADD", () => {
    expect(parseClauseState("เพิ่มเป็น 2 เม็ด เวลา 20:00").primaryClause.regimenAdjustment).toBe("replace");
    expect(parseClauseState("เพิ่มอีกครึ่งเม็ด เวลา 14:00").primaryClause.regimenAdjustment).toBe("add");
    expect(parseClauseState("ห้ามเพิ่มอีกครึ่งเม็ด เวลา 14:00").primaryClause.regimenAdjustment).not.toBe("add");
  });
  it.each([
    ["รับประทาน 1 เม็ด วันละครั้งต่ออีก 7 วัน", 7, "d"],
    ["รับประทาน 1 เม็ด วันละครั้ง ต่อ 1 สัปดาห์", 1, "wk"]
  ])("uses a continuation-duration complement without a spurious attachment action: %s", (source, value, unit) => {
    const parsed = parseSig(source);
    expect(parsed.fhir[0].timing?.repeat?.boundsDuration).toMatchObject({ value, code: unit });
    expect(parsed.longText).not.toContain("Attach");
    expect(parsed.input).toBe(source);
  });

  it("keeps physical and negated attachment durations out of medication-course timing", () => {
    const physical = parseSig("Apply 1 patch daily; attach the tubing for 7 days.");
    expect(physical.fhir[0].timing?.repeat?.boundsDuration).toBeUndefined();
    expect(physical.longText).toContain("Attach the tubing for 7 days");
    const negated = parseSig("ห้ามต่ออีก 7 วัน");
    expect(negated.fhir[0].timing?.repeat?.boundsDuration).toBeUndefined();
    expect(negated.input).toBe("ห้ามต่ออีก 7 วัน");
  });

});

describe("partial dose changes select existing meal/daypart administrations", () => {
  const options = {
    timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00",
    eventClock: {
      [EventTiming.Breakfast]: "08:00", [EventTiming.Dinner]: "18:30",
      [EventTiming.Morning]: "08:00", [EventTiming.Evening]: "18:30"
    },
    mealOffsets: { [EventTiming["Before Breakfast"]]: -30, [EventTiming["Before Dinner"]]: -30 }
  };
  it.each([
    ["Take 1 tablet before breakfast and dinner for 7 days, then reduce only the dinner dose to half a tablet for 7 days.", ["07:30", "18:00"]],
    ["Take 1 tablet before breakfast and dinner for 7 days, then reduce only dinner dose to half a tablet for 7 days.", ["07:30", "18:00"]],
    ["Take 1 tablet twice daily before breakfast and dinner for 7 days, then reduce only the dinner dose to half a tablet for 7 days.", ["07:30", "18:00"]],
    ["Take 1 tablet 20 minutes before breakfast and dinner for 7 days, then reduce the dinner dose to half a tablet for 7 days.", ["07:40", "18:10"]],
    ["รับประทาน 1 เม็ด วันละ 2 ครั้ง ก่อนอาหารเช้าและเย็น เป็นเวลา 7 วัน จากนั้นลดเฉพาะมื้อเย็นเหลือครึ่งเม็ดต่ออีก 7 วัน", ["07:30", "18:00"]],
    ["รับประทาน 1 เม็ด ก่อนอาหารเช้าและเย็น เป็นเวลา 7 วัน จากนั้นลดเฉพาะมื้อเย็นเหลือครึ่งเม็ดต่ออีก 7 วัน", ["07:30", "18:00"]],
    ["รับประทาน 1 เม็ด เช้าและเย็น เป็นเวลา 7 วัน จากนั้นลดเฉพาะมื้อเย็นเหลือครึ่งเม็ดต่ออีก 7 วัน", ["08:00", "18:30"]]
  ])("keeps the unaffected dose and original meal relation: %s", (source, expected) => {
    const parsed = parseSig(source as string);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const times = (day: string) => nextDueDoses(dosage, { ...options,
        from: day + "T00:00:00+07:00", limit: 8
      }).filter(at => at.startsWith(day)).map(at => at.slice(11, 16));
      expect(times("2026-11-02")).toEqual(expected);
      expect(times("2026-11-09")).toEqual(expected);
      expect(times("2026-11-16")).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...options, from: options.orderedAt,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(24.5);
    }
  });

  it("does not retain a morning dose for an explicit whole-regimen replacement", () => {
    const parsed = parseSig("Take 1 tablet before breakfast and dinner for 7 days, then take half a tablet before dinner for 7 days.");
    expect(nextDueDoses(parsed.fhirNext, { ...options, from: "2026-11-09T00:00:00+07:00", limit: 1 }))
      .toEqual(["2026-11-09T18:00:00+07:00"]);
    expect(calculateTotalUnits({ dosage: parsed.fhirNext, ...options, from: options.orderedAt,
      durationValue: 21, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(17.5);
  });
});

describe("explicit daily clock windows constrain an interval rather than becoming two doses", () => {
  it.each([
    "Take 1 tablet every 3 hours from 07:00 to 19:00 for 7 days.",
    "Take 1 tablet every 3 hours between 07:00 and 19:00 for 7 days.",
    "Take 1 tablet every 3 hours while awake from 07:00 to 19:00 for 7 days.",
    "Take 1 tablet every 3 hours from 07:00 until 19:00 for 7 days.",
    "รับประทาน 1 เม็ด ทุก 3 ชั่วโมง ตั้งแต่เวลา 07:00 ถึง 19:00 เป็นเวลา 7 วัน",
    "รับประทาน 1 เม็ด ทุก 3 ชั่วโมง ระหว่าง 07:00 และ 19:00 เป็นเวลา 7 วัน"
  ])("executes all interval occurrences within %s", source => {
    const parsed = parseSig(source);
    const sourceLess = { ...parsed.fhir[0], text: undefined, patientInstruction: undefined };
    expect(formatSig(sourceLess, "long", { locale: "en" })).toContain("only between 07:00 and 19:00");
    expect(formatSig(sourceLess, "long", { locale: "th" })).toContain("07:00–19:00");
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext), sourceLess]) {
      const options = { timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00" };
      expect(nextDueDoses(dosage, { ...options, limit: 6 })).toEqual([
        "2026-11-02T07:00:00+07:00", "2026-11-02T10:00:00+07:00", "2026-11-02T13:00:00+07:00",
        "2026-11-02T16:00:00+07:00", "2026-11-02T19:00:00+07:00", "2026-11-03T07:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(35);
    }
  });

  it("does not reinterpret a true two-clock list as an interval window", () => {
    const parsed = parseSig("Take 1 tablet at 07:00 and 19:00 for 7 days.");
    expect(calculateTotalUnits({ dosage: parsed.fhirNext, timeZone: "Asia/Bangkok", orderedAt: "2026-11-02T00:00:00+07:00",
      from: "2026-11-02T00:00:00+07:00", durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(14);
  });
  it("does not restart interval phase from a mid-window query", () => {
    const parsed = parseSig("Take 1 tablet every 3 hours from 07:00 to 19:00 for 7 days.");
    expect(nextDueDoses(parsed.fhirNext, {
      orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T12:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 4
    })).toEqual(["2026-11-02T13:00:00+07:00", "2026-11-02T16:00:00+07:00",
      "2026-11-02T19:00:00+07:00", "2026-11-03T07:00:00+07:00"]);
  });

  it("retains the previous-day clock origin across a midnight-spanning interval window", () => {
    const parsed = parseSig("Take 1 tablet every 3 hours from 22:00 to 07:00 for 7 days.");
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, {
        orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-03T02:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 4
      })).toEqual(["2026-11-03T04:00:00+07:00", "2026-11-03T07:00:00+07:00",
        "2026-11-03T22:00:00+07:00", "2026-11-04T01:00:00+07:00"]);
    }
  });

});

describe("typed activity-day complement ownership", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const options = {
    orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 2
  };
  /** Test oracle: callers decide activity membership; Boolean nodes retain their typed polarity. */
  function onActivityDay(
    condition: import("../src").MedicationCondition, active: boolean
  ): boolean | undefined {
    if (condition.kind === "text") return active;
    if (condition.kind === "not") {
      const value = onActivityDay(condition.condition, active);
      return value === undefined ? undefined : !value;
    }
    if (condition.kind === "all") return condition.conditions.every(part => onActivityDay(part, active));
    if (condition.kind === "any") return condition.conditions.some(part => onActivityDay(part, active));
    return undefined;
  }

  it.each([
    ["Take 1 tablet at 08:00 on dialysis days and half a tablet at 08:00 on other days.", 1, 0.5],
    ["Take 1 tablet at 08:00 on non-dialysis days and half a tablet at 08:00 on other days.", 0.5, 1],
    ["Take 1 tablet at 08:00 on dialysis days and half a tablet at 08:00 on the remaining days.", 1, 0.5],
    ["รับประทานครั้งละ 1 เม็ด เวลา 08:00 ในวันที่ฟอกไต และครึ่งเม็ดเวลา 08:00 ในวันอื่น", 1, 0.5]
  ] as const)("keeps other-day doses mutually exclusive with their typed activity antecedent: %s", (input, activeDose, inactiveDose) => {
    const parsed = parseSig(input);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext), toDosageDetails(toFhirR5Dosages(parsed.fhirNext))]) {
      for (const [active, expectedDose] of [[true, activeDose], [false, inactiveDose]] as const) {
        const evaluateCondition = (condition: import("../src").MedicationCondition, at: string) =>
          onActivityDay(condition, Number(at.slice(8, 10)) % 2 === 0 ? active : !active);
        expect(nextDueDoses(dosage, { ...options, evaluateCondition })).toEqual([
          "2026-11-02T08:00:00+07:00", "2026-11-03T08:00:00+07:00"
        ]);
        expect(calculateTotalUnits({ dosage, ...options, evaluateCondition,
          durationValue: 1, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(expectedDose);
      }
    }
    expect(parsed.input).toBe(input);
  });

  it("keeps ordinary weekday complements and every-other-day cadence independent", () => {
    const weekday = parseSig("Take 1 tablet at 08:00 on Monday Wednesday Friday and half a tablet at 08:00 on other days.");
    expect(weekday.fhir[1].timing?.repeat?.dayOfWeek).toEqual(["tue", "thu", "sat", "sun"]);
    const interval = parseSig("Take 1 tablet at 08:00 on dialysis days and half a tablet at 20:00 every other day.");
    expect(interval.fhir[1].timing?.repeat).toMatchObject({ period: 2, periodUnit: "d" });
    expect(interval.meta.canonical?.clauses[1].clinicalAdjuncts?.condition).toBeUndefined();
  });

  it("does not negate an arbitrary clinical guard as a calendar-day antecedent", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 if blood pressure is above 160; take half a tablet at 08:00 on other days.");
    expect(parsed.meta.canonical?.clauses[1].clinicalAdjuncts?.condition).toBeUndefined();
    expect(parsed.meta.canonical?.clauses[1].schedule?.timingReference).toBe("previous-weekday-complement");
  });
});

describe("shared course bound across parallel administration targets", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const base = { orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 24 };
  it.each([
    ["Instill 1 drop in right eye at 08:00, 12:00 and 20:00 and 1 drop in left eye at 08:00 and 20:00 for 7 days.", 35],
    ["Apply 1 g to the left arm at 08:00 and 1 g to the right arm at 20:00 for 7 days.", 14]
  ] as const)("applies the source trailing course to both complete parallel targets: %s", (input, total) => {
    const parsed = parseSig(input);
    expect(parsed.fhir).toHaveLength(2);
    expect(parsed.fhir.map(dose => dose.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext), toDosageDetails(toFhirR5Dosages(parsed.fhirNext))]) {
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00" })).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(total);
    }
  });

  it("preserves separately specified course lengths on the two targets", () => {
    const parsed = parseSig("Instill 1 drop in right eye at 08:00, 12:00 and 20:00 for 7 days and 1 drop in left eye at 08:00 and 20:00 for 3 days.");
    expect(parsed.fhir.map(dose => dose.timing?.repeat?.boundsDuration?.value)).toEqual([7, 3]);
    expect(calculateTotalUnits({ dosage: parsed.fhirNext, ...base, durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(27);
  });

  it("does not share a right-local duration across independently headed sentences", () => {
    const parsed = parseSig("Instill 1 drop in right eye at 08:00, 12:00 and 20:00. Instill 1 drop in left eye at 08:00 and 20:00 for 7 days.");
    expect(parsed.fhir.map(dose => dose.timing?.repeat?.boundsDuration?.value)).toEqual([undefined, 7]);
    const onDayEight = nextDueDoses(parsed.fhirNext, { ...base, from: "2026-11-09T00:00:00+07:00" })
      .filter(time => time.startsWith("2026-11-09")).map(time => time.slice(11, 16));
    expect(onDayEight).toEqual(["08:00", "12:00", "20:00"]);
  });
});

describe("Thai duration lead remains part of the shared course constituent", () => {
  const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 4 };
  it.each([
    "รับประทาน 1 เม็ด เวลา 08:00 และ 0.5 เม็ด เวลา 20:00 นาน 7 วัน",
    "รับประทาน 1 เม็ด เวลา 08:00 และ 0.5 เม็ด เวลา 20:00 เป็นเวลา 7 วัน"
  ])("retains the duration head and bounds every coordinated dose: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.fhir.map(dose => dose.timing?.repeat?.boundsDuration?.value)).toEqual([7, 7]);
    expect(parsed.meta.canonical?.clauses.every(clause => !clause.leftovers?.length)).toBe(true);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext), toDosageDetails(toFhirR5Dosages(parsed.fhirNext))]) {
      expect(nextDueDoses(dosage, { ...base, from: "2026-11-09T00:00:00+07:00" })).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(10.5);
    }
    expect(parsed.input).toBe(input);
  });

  it("does not replace explicit different local durations with the trailing duration", () => {
    const parsed = parseSig("รับประทาน 1 เม็ด เวลา 08:00 นาน 3 วัน และ 0.5 เม็ด เวลา 20:00 นาน 7 วัน");
    expect(parsed.fhir.map(dose => dose.timing?.repeat?.boundsDuration?.value)).toEqual([3, 7]);
    expect(calculateTotalUnits({ dosage: parsed.fhirNext, ...base, durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(6.5);
  });

  it("lets a procedural action own its duration rather than making a medication course", () => {
    const parsed = parseSig("กลั้วปาก 10 มล. นาน 1 นาที แล้วบ้วนทิ้ง");
    const clause = parsed.meta.canonical!.clauses[0];
    expect(clause.schedule?.duration).toBeUndefined();
    expect(clause.instructionGraph?.actions[0].args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "duration", quantity: { value: 1, unit: "min" } })
    ]));
  });
});


describe("cycle-day constituents own their complete temporal phrase", () => {
  it.each([
    ["1 cap PV HS on cycle days 16-25 for 3 cycles", "on cycle days 16-25 for 3 cycles", 16, 25],
    ["1 cap PV HS days 16-25 of menstrual cycle", "days 16-25 of menstrual cycle", 16, 25],
    ["1 cap PV HS on cycle days 16-25 of every 28-day cycle", "on cycle days 16-25 of every 28-day cycle", 16, 25],
    ["1 cap PV HS x10d starting on cycle day 16", "starting on cycle day 16", 16, 16]
  ] as const)("keeps day ordinals and cycle heads out of the dose and body site: %s", (source, temporal, first, last) => {
    const cycles = recognizeCycles(source);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].kind).toBe("calendar-days");
    expect(cycles[0].sourceText).toBe(temporal);
    expect(cycles[0].start).toBe(source.indexOf(temporal));
    expect(cycles[0].days).toEqual(Array.from({ length: last - first + 1 }, (_, i) => first + i));
    expect(cycles[0].error).toBeDefined();
    const parsed = parseSig(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "cap" });
    expect(parsed.meta.canonical.clauses[0].dose?.range).toBeUndefined();
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      const rows = Array.isArray(dosage) ? dosage : dosage.step.flatMap(step => step.component);
      expect(rows).toHaveLength(1);
      expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "cap" });
      expect(rows[0].doseAndRate?.[0].doseRange).toBeUndefined();
      const site = Array.isArray(dosage) ? dosage[0].site : dosage.step[0].component[0].site?.concept;
      expect(site?.coding?.[0]?.code).toBe("76784001");
      expect(formatSig(rows[0], "long", { locale: "en" })).not.toContain("into the cycle");
    }
  });

  it("retains a fully anchored finite calendar cycle with the same independent vaginal dose", () => {
    const source = "1 cap PV HS on days 16-25 of every 28-day cycle starting 2026-11-01 for 3 cycles";
    const parsed = parseSig(source);
    const orderedAt = "2026-11-01T00:00:00Z";
    for (const dosage of [parsed.fhirNext, parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, orderedAt, from: orderedAt, timeZone: "UTC",
        durationValue: 84, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(30);
    }
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);
    expect(parsed.fhir[0].site?.coding?.[0]?.code).toBe("76784001");
  });
});


describe("Thai daypart punctuation composes one shared meal relation", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const options = {
    orderedAt, from: orderedAt, timeZone: "Asia/Bangkok", limit: 30,
    eventClock: {
      [EventTiming.Breakfast]: "08:00", [EventTiming.Lunch]: "12:30",
      [EventTiming.Dinner]: "18:30"
    },
    mealOffsets: {
      [EventTiming["After Breakfast"]]: 30, [EventTiming["After Lunch"]]: 30,
      [EventTiming["After Dinner"]]: 30
    }
  };
  it.each([
    "รับประทาน 1 เม็ด เช้า-เย็น หลังอาหาร x7d",
    "รับประทาน 1 เม็ด เช้า/เย็น หลังอาหาร x7d",
    "รับประทาน 1 เม็ด หลังอาหาร เช้า-เย็น x7d",
    "รับประทาน 1 เม็ด วันละ 2 ครั้ง เช้า-เย็น หลังอาหาร x7d",
    "รับประทาน 1 เม็ด เช้า เย็น หลังอาหาร x7d",
    "รับประทาน 1 เม็ด เช้าและเย็น หลังอาหาร x7d",
    "รับประทาน 1 เม็ด หลังอาหารเช้าและเย็น x7d"
  ])("keeps both prescribed meal occasions without adding lunch: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      const rows = Array.isArray(dosage) ? dosage : toFhirR5Dosages(dosage);
      expect(rows).toHaveLength(1);
      expect(rows[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(rows[0].timing?.repeat?.when).toEqual([
        EventTiming["After Breakfast"], EventTiming["After Dinner"]
      ]);
      const dates = nextDueDoses(dosage, options);
      expect(dates).toHaveLength(14);
      expect(dates.filter(at => at.startsWith("2026-11-02")).map(at => at.slice(11, 16)))
        .toEqual(["08:30", "19:00"]);
      expect(dates[dates.length - 1]).toBe("2026-11-08T19:00:00+07:00");
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(14);
    }
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("preserves the independent numeric meal-dash dose construction", () => {
    const source = "1-0-1 PO PC x7d";
    const parsed = parseSig(source, { context: { dosageForm: "tablet" }, enableMealDashSyntax: true });
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, options)).toHaveLength(14);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(14);
    }
  });
});


describe("November 16 PR #13: elapsed parallel component origin owns its calendar cap", () => {
  it.each([
    ["normal day", "2026-11-02T02:30:00-05:00", "2026-11-03T04:00:00-05:00"],
    ["spring DST gap", "2027-03-13T02:30:00-05:00", "2027-03-14T04:00:00-04:00"]
  ])("%s includes a next-day 04:00 dose after the +3h phase and before its 1d cap", (_, orderedAt, expected) => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
        valueQuantity: { value: 3, unit: "h", code: "h" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["04:00:00"],
        boundsDuration: { value: 1, unit: "d", code: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const options = { from: orderedAt, orderedAt, timeZone: "America/New_York",
      limit: 10, durationValue: 3, durationUnit: FhirPeriodUnit.Day };
    const r5 = JSON.parse(JSON.stringify(toFhirR5Dosages(course))) as FhirDosage[];
    expect(toDosageDetails(r5)).toEqual(course);
    for (const data of [course, r5, r5[0], fromFhir(course)]) {
      expect(nextDueDoses(data, options)).toEqual([expected]);
      expect(calculateTotalUnits({ dosage: data, ...options }).totalUnits).toBe(1);
    }
  });

  it("keeps distinct concurrent component caps and repeated-cycle origins independent", () => {
    const marker = { modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
      valueQuantity: { value: 3, unit: "h", code: "h" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["04:00:00"], boundsDuration: { value: 1, unit: "d", code: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const independent = {
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["06:00:00"], boundsDuration: { value: 3, unit: "d", code: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const concurrent: FhirR6DosageInstruction = {
      step: [{ component: [marker, independent] }]
    };
    const repeating: FhirR6DosageInstruction = {
      repeatCycle: { value: 2, code: "d", unit: "d" },
      step: [{ component: [marker] }]
    };
    const opts = { orderedAt: "2026-11-02T02:30:00-05:00",
      from: "2026-11-02T02:30:00-05:00", timeZone: "America/New_York",
      limit: 10, durationValue: 6, durationUnit: FhirPeriodUnit.Day };
    for (const datum of [concurrent, toFhirR5Dosages(concurrent)]) {
      expect(nextDueDoses(datum, opts)).toEqual([
        "2026-11-02T06:00:00-05:00", "2026-11-03T04:00:00-05:00",
        "2026-11-03T06:00:00-05:00", "2026-11-04T06:00:00-05:00"
      ]);
      expect(calculateTotalUnits({ dosage: datum, ...opts }).totalUnits).toBe(4);
    }
    for (const datum of [repeating, toFhirR5Dosages(repeating)]) {
      expect(nextDueDoses(datum, { ...opts, limit: 3 })).toEqual([
        "2026-11-03T04:00:00-05:00", "2026-11-05T04:00:00-05:00",
        "2026-11-07T04:00:00-05:00"
      ]);
      expect(calculateTotalUnits({ dosage: datum, ...opts }).totalUnits).toBe(3);
    }
  });

  it("does not shift a component without an explicit phase-origin marker", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["04:00:00"], boundsDuration: { value: 1, unit: "d", code: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const options = { from: "2026-11-02T02:30:00-05:00",
      orderedAt: "2026-11-02T02:30:00-05:00", timeZone: "America/New_York",
      limit: 10, durationValue: 3, durationUnit: FhirPeriodUnit.Day };
    expect(nextDueDoses(course, options)).toEqual(["2026-11-02T04:00:00-05:00"]);
    expect(calculateTotalUnits({ dosage: course, ...options }).totalUnits).toBe(1);
  });
});


describe("November 16 finite-count parallel loading stage", () => {
  const marker = "urn:ezmedicationinput:StructureDefinition:medication-parallel-component-phase-origin";
  it("transitions to the maintenance stage after the finite +3h loading dose", () => {
    const course: FhirR6DosageInstruction = { step: [
      { component: [{
        modifierExtension: [{ url: marker, valueQuantity: { value: 3, unit: "h", code: "h" } }],
        timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["04:00:00"] } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] },
      { component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["20:00:00"], boundsDuration: { value: 2, unit: "d", code: "d" } } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }
    ] };
    const opts = { orderedAt: "2026-11-02T02:30:00-05:00",
      from: "2026-11-02T02:30:00-05:00", timeZone: "America/New_York",
      limit: 10, durationValue: 3, durationUnit: FhirPeriodUnit.Day };
    const expected = [
      "2026-11-03T04:00:00-05:00",
      "2026-11-03T20:00:00-05:00",
      "2026-11-04T20:00:00-05:00"
    ];
    for (const data of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      expect(nextDueDoses(data, opts)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: data, ...opts }).totalUnits).toBe(3);
    }
  });
});


describe("November 16 finite-stage transition preserves point, exclusivity and own clock", () => {
  const marker = "urn:ezmedicationinput:StructureDefinition:medication-parallel-component-phase-origin";
  const loading = {
    modifierExtension: [{ url: marker, valueQuantity: { value: 8, code: "h", unit: "h" } }],
    timing: { repeat: { count: 1, frequency: 1, period: 1,
      periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
  };
  const orderedAt = "2026-11-02T00:00:00-05:00";
  const opts = { orderedAt, from: orderedAt, timeZone: "America/New_York",
    limit: 3, durationValue: 7, durationUnit: FhirPeriodUnit.Day };

  it("carries a counted 08:00 completion clock into the implicit 1d 07:00 maintenance cap", () => {
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 7, unit: "d", code: "d" },
      step: [
        { component: [loading] },
        { component: [{
          timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["07:00:00"], boundsDuration: { value: 1, unit: "d", code: "d" } } },
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
        }] }
      ]
    };
    const expected = [
      "2026-11-02T08:00:00-05:00",
      "2026-11-03T07:00:00-05:00",
      "2026-11-09T08:00:00-05:00"
    ];
    for (const dosage of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      expect(nextDueDoses(dosage, opts)).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...opts }).totalUnits).toBe(2);
    }
  });

  it("derives the 8h successor cadence from the actual dose point rather than point + 1ms", () => {
    const course: FhirR6DosageInstruction = { step: [
      { component: [loading] },
      { component: [{
        timing: { repeat: { count: 3, frequency: 1, period: 8, periodUnit: FhirPeriodUnit.Hour } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }
    ] };
    const expected = [
      "2026-11-02T08:00:00-05:00",
      "2026-11-02T16:00:00-05:00",
      "2026-11-03T00:00:00-05:00",
      "2026-11-03T08:00:00-05:00"
    ];
    const o = { ...opts, limit: 5, durationValue: 2 };
    for (const dosage of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      expect(nextDueDoses(dosage, o)).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...o }).totalUnits).toBe(4);
    }
  });

  it("clips a same-clock implicit successor without changing its 08:00 logical origin", () => {
    const course: FhirR6DosageInstruction = { step: [
      { component: [loading] },
      { component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"], boundsDuration: { value: 2, unit: "d", code: "d" } } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }
    ] };
    const due = nextDueDoses(course, { ...opts, limit: 5 });
    expect(due).toEqual(["2026-11-02T08:00:00-05:00", "2026-11-03T08:00:00-05:00"]);
    expect(calculateTotalUnits({ dosage: course, ...opts }).totalUnits).toBe(2);
  });
});


describe("count-vs-calendar predecessor clock ownership across DST", () => {
  const anchor = "2027-03-13T00:00:00-05:00";
  const start = { from: anchor, orderedAt: anchor, timeZone: "America/New_York",
    limit: 3, durationValue: 7, durationUnit: FhirPeriodUnit.Day };
  const one = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
  it("a final 08:00 count carries 08:00 across spring DST; a later query does not move the course", () => {
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 7, code: "d", unit: "d" },
      step: [
        { component: [{
          ...one, modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
            valueQuantity: { value: 8, code: "h", unit: "h" } }],
          timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["08:00:00"] } }
        }] },
        { component: [{
          ...one, timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["07:00:00"], boundsDuration: { value: 1, code: "d", unit: "d" } } }
        }] }
      ]
    };
    for (const input of [course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(input, start)).toEqual([
        "2027-03-13T08:00:00-05:00",
        "2027-03-14T07:00:00-04:00",
        "2027-03-20T08:00:00-04:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...start }).totalUnits).toBe(2);
      expect(nextDueDoses(input, { ...start, from: "2027-03-14T00:00:00-05:00",
        limit: 1 })).toEqual(["2027-03-14T07:00:00-04:00"]);
    }
  });

  it("excludes Sunday 08:30 after a Saturday 08:00 one-civil-day boundary", () => {
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 7, code: "d", unit: "d" },
      step: [
        { component: [{ ...one, timing: { repeat: {
          count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"],
        } } }] },
        { component: [{ ...one, timing: { repeat: {
          frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:30:00"], boundsDuration: { value: 1, code: "d", unit: "d" },
        } } }] },
      ],
    };
    for (const input of [course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(input, { ...start, limit: 4 })).toEqual([
        "2027-03-13T08:00:00-05:00", "2027-03-13T08:30:00-05:00",
        "2027-03-20T08:00:00-04:00", "2027-03-20T08:30:00-04:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...start }).totalUnits).toBe(2);
    }
  });

  it("a calendar-duration boundary retains its prescribed clock without a counted predecessor", () => {
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 7, code: "d", unit: "d" },
      step: [
        { component: [{
          ...one, timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["08:00:00"], boundsDuration: { value: 1, code: "d", unit: "d" } } }
        }] },
        { component: [{
          ...one, timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["08:30:00"], boundsDuration: { value: 1, code: "d", unit: "d" } } }
        }] }
      ]
    };
    expect(nextDueDoses(course, start)).toEqual([
      "2027-03-13T08:00:00-05:00",
      "2027-03-14T08:30:00-04:00",
      "2027-03-20T08:00:00-04:00"
    ]);
    expect(calculateTotalUnits({ dosage: course, ...start }).totalUnits).toBe(2);
  });
});


describe("review 2026-11-16 19h: count belongs to eligible successor administrations", () => {
  const orderedAt = "2026-11-02T00:00:00-05:00";
  const marker = PARALLEL_COMPONENT_PHASE_ORIGIN_URL;
  const course: FhirR6DosageInstruction = {
    step: [
      { component: [{
        modifierExtension: [{ url: marker, valueQuantity: { value: 8, code: "h", unit: "h" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          count: 1, timeOfDay: ["08:00:00"] } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] },
      { component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          count: 2, timeOfDay: ["08:00:00"] } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] },
      { component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          boundsDuration: { value: 1, unit: "d", code: "d" },
          timeOfDay: ["20:00:00"] } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }
    ]
  };
  const opts = { from: orderedAt, orderedAt, timeZone: "America/New_York",
    limit: 10, durationValue: 4, durationUnit: FhirPeriodUnit.Day };
  const expected = [
    "2026-11-02T08:00:00-05:00",
    "2026-11-03T08:00:00-05:00",
    "2026-11-04T08:00:00-05:00",
    "2026-11-04T20:00:00-05:00"
  ];
  it("counts the two maintenance administrations, not the excluded loading dose", () => {
    for (const input of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      expect(nextDueDoses(input, opts)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...opts }).totalUnits).toBe(4);
    }
  });
  it("a later from query only subtracts genuinely administered eligible doses", () => {
    const later = { ...opts, from: "2026-11-04T00:00:00-05:00" };
    for (const input of [course, toFhirR5Dosages(course)]) {
      expect(nextDueDoses(input, later)).toEqual(expected.slice(2));
      expect(calculateTotalUnits({ dosage: input, ...later }).totalUnits).toBe(2);
    }
  });
});


describe("November 17 review: point precision on valid timezone offsets", () => {
  it("keeps the UTC offset whole-minute when the source instant has 500 milliseconds", async () => {
    const { getOffset, formatZonedIso } = await import("../src/execution/calendar");
    for (const [instant, zone, expected, suffix] of [
      ["2026-11-02T12:00:00.500Z", "UTC", 0, "+00:00"],
      ["2026-11-02T12:00:00.500Z", "Asia/Bangkok", 420, "+07:00"],
      ["2026-11-02T12:00:00.500Z", "America/New_York", -300, "-05:00"],
      ["1969-12-31T23:59:59.500Z", "UTC", 0, "+00:00"],
    ] as const) {
      const time = new Date(instant);
      expect(getOffset(time, zone)).toBe(expected);
      const display = formatZonedIso(time, zone);
      expect(display.endsWith(suffix)).toBe(true);
      expect(Date.parse(display)).toBe(time.getTime());
      expect(display).not.toContain(".008333");
    }
  });
});

describe("November 17 CodeRabbit scheduling root-family oracles", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00"; // Monday
  const base = { from: orderedAt, orderedAt, timeZone: "Asia/Bangkok", limit: 12 };
  const oneTablet = [{ quantity: { value: 1, unit: "tab" } }];
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } as const;

  it("a counted BID course never counts an extra same-day clock toward supply", () => {
    const dose = {
      kind: "administration" as const,
      amounts: oneTablet,
      schedule: {
        recurrence: {
          frequency: 2,
          period: 1,
          periodUnit: FhirPeriodUnit.Day,
          clocks: ["08:00:00", "20:00:00"],
          count: 3,
        },
      },
    };
    const expected = ["2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00", "2026-11-03T08:00:00+07:00"];
    expect(nextDueDoses(dose, base)).toEqual(expected);
    expect(
      calculateTotalUnits({ ...base, dosage: dose, durationValue: 2, durationUnit: FhirPeriodUnit.Day })
        .totalUnits
    ).toBe(3);
  });

  it("exclusion weekdays do not consume an exact 3-administration count, including a later query", () => {
    const dose = {
      kind: "administration" as const,
      amounts: oneTablet,
      excludedWeekdays: ["tue" as const],
      schedule: { recurrence: { ...daily, count: 3 } },
    };
    const expected = ["2026-11-02T08:00:00+07:00", "2026-11-04T08:00:00+07:00", "2026-11-05T08:00:00+07:00"];
    expect(nextDueDoses(dose, base)).toEqual(expected);
    expect(nextDueDoses(dose, { ...base, from: "2026-11-04T00:00:00+07:00" })).toEqual(expected.slice(1));
    // When the clinician/application supplied an exact prior-count history,
    // that history is authoritative; it must not be consumed twice.
    expect(nextDueDoses(dose, { ...base, from: "2026-11-05T00:00:00+07:00" })).toEqual(expected.slice(2));
    expect(nextDueDoses(dose, { ...base, from: "2026-11-05T00:00:00+07:00", priorCount: 2 })).toEqual(
      expected.slice(2)
    );
    expect(nextDueDoses(dose, { ...base, from: "2026-11-05T00:00:00+07:00", priorCount: 1 })).toEqual([
      "2026-11-05T08:00:00+07:00", "2026-11-06T08:00:00+07:00",
    ]);
    expect(
      calculateTotalUnits({ ...base, dosage: dose, durationValue: 4, durationUnit: FhirPeriodUnit.Day })
        .totalUnits
    ).toBe(3);
    expect(
      calculateTotalUnits({
        ...base,
        dosage: dose,
        from: "2026-11-04T00:00:00+07:00",
        durationValue: 2,
        durationUnit: FhirPeriodUnit.Day,
      }).totalUnits
    ).toBe(2);
  });

  it("uses prescribed Mon/Tue/Thu membership in a partial weekly supply window", () => {
    const dose = {
      kind: "administration" as const,
      amounts: oneTablet,
      schedule: {
        recurrence: {
          frequency: 3,
          period: 1,
          periodUnit: FhirPeriodUnit.Week,
          dayOfWeek: ["mon" as const, "tue" as const, "thu" as const],
        },
      },
    };
    expect(nextDueDoses(dose, base).slice(0, 3)).toEqual([
      "2026-11-02T00:00:00+07:00",
      "2026-11-03T00:00:00+07:00",
      "2026-11-05T00:00:00+07:00",
    ]);
    expect(
      calculateTotalUnits({ ...base, dosage: dose, durationValue: 2, durationUnit: FhirPeriodUnit.Day })
        .totalUnits
    ).toBe(2);
  });

  it("long-running q4h and civil-daily dosing reach a late query with limit 1", () => {
    const old = "2026-01-01T00:00:00+07:00";
    const july = "2026-07-01T01:00:00+07:00";
    for (const recurrence of [
      { frequency: 1, period: 4, periodUnit: FhirPeriodUnit.Hour },
      { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day },
    ]) {
      const dose = { kind: "administration" as const, amounts: oneTablet, schedule: { recurrence } };
      // The unqualified daily regimen uses the established institution
      // morning default (09:00), whereas q4h is anchored exactly at midnight.
      const expected = recurrence.periodUnit === FhirPeriodUnit.Day
        ? "2026-07-01T09:00:00+07:00" : "2026-07-01T04:00:00+07:00";
      expect(nextDueDoses(dose, { orderedAt: old, from: july, timeZone: "Asia/Bangkok", limit: 1 })).toEqual([
        expected,
      ]);
    }
  });

  it("a daily repeated course queried 22 months later is not bounded by the output limit", () => {
    const old = "2025-01-01T00:00:00+07:00";
    const from = "2026-11-02T00:00:00+07:00";
    const course = {
      kind: "course" as const,
      cycleInterval: { value: 1, unit: "d" },
      stages: [
        {
          administrations: [
            { kind: "administration" as const, amounts: oneTablet, schedule: { recurrence: { ...daily } } },
          ],
        },
      ],
    };
    expect(nextDueDoses(course, { orderedAt: old, from, timeZone: "Asia/Bangkok", limit: 1 })).toEqual([
      "2026-11-02T08:00:00+07:00",
    ]);
  });

  it("a one-tablet daily cycle carries the one-tablet/2d rolling cap across cycles", () => {
    const course = {
      kind: "course" as const,
      cycleInterval: { value: 1, unit: "d" },
      stages: [
        {
          administrations: [
            {
              kind: "administration" as const,
              amounts: oneTablet,
              schedule: { recurrence: { ...daily } },
              limits: [
                {
                  scope: "period" as const,
                  amount: { value: 1, unit: "tab" },
                  period: { value: 2, unit: "d" },
                },
              ],
            },
          ],
        },
      ],
    };
    const expected = Array.from(
      { length: 7 },
      (_, i) => "2026-11-" + String(2 + 2 * i).padStart(2, "0") + "T08:00:00+07:00"
    );
    expect(nextDueDoses(course, { ...base, limit: 7 })).toEqual(expected);
    expect(
      calculateTotalUnits({ ...base, dosage: course, durationValue: 14, durationUnit: FhirPeriodUnit.Day })
        .totalUnits
    ).toBe(7);
  });
});

describe("November 17 repeated-course caps remain bounded and anchored", () => {
  const course = {
    kind: "course" as const,
    cycleInterval: { value: 1, unit: "d" },
    stages: [
      {
        administrations: [
          {
            kind: "administration" as const,
            amounts: [{ quantity: { value: 1, unit: "tab" } }],
            schedule: {
              recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] },
            },
            limits: [
              {
                scope: "period" as const,
                amount: { value: 1, unit: "tab" },
                period: { value: 2, unit: "d" },
              },
            ],
          },
        ],
      },
    ],
  };
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const base = { orderedAt, timeZone: "Asia/Bangkok" };
  it("a later supply window excludes earlier administrations but uses them as rolling-cap history", () => {
    const from = "2026-11-12T00:00:00+07:00";
    const next = nextDueDoses(course, { ...base, from, limit: 5 });
    expect(next).toEqual([12, 14, 16, 18, 20].map((day) => "2026-11-" + String(day) + "T08:00:00+07:00"));
    const supply = calculateTotalUnits({
      ...base,
      from,
      dosage: course,
      durationValue: 10,
      durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply.totalUnits).toBe(5);
    // A query BETWEEN admissible two-day administrations catches any
    // accidental cap reset at the requested from time, unlike the
    // November 12 query aligned to the first administration.
    const between="2026-11-13T00:00:00+07:00";
    expect(nextDueDoses(course,{...base,from:between,limit:1}))
      .toEqual(["2026-11-14T08:00:00+07:00"]);
    expect(calculateTotalUnits({...base,from:between,dosage:course,
      durationValue:1,durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(0);
  });
  it("a 60-day course retains exactly 30 administrations without retaining stale historical limits", () => {
    const next = nextDueDoses(course, { ...base, from: orderedAt, limit: 30 });
    expect(next).toEqual(Array.from({ length: 30 }, (_, index) =>
      new Date(Date.UTC(2026, 10, 2 + index * 2)).toISOString().slice(0, 10) + "T08:00:00+07:00"));
    const supply = calculateTotalUnits({
      ...base,
      from: orderedAt,
      dosage: course,
      durationValue: 60,
      durationUnit: FhirPeriodUnit.Day,
    });
    expect(supply.totalUnits).toBe(30);
  });
});


describe("PR14 new review: conditional one-time count ownership", () => {
  const one={kind:"administration" as const,amounts:[{quantity:{value:1,unit:"tab"}}],
    schedule:{recurrence:{count:1}},predicate:{kind:"state" as const,name:"symptoms",expected:true,text:"symptoms"}};
  const options={from:"2026-11-02T00:00:00+07:00",
    orderedAt:"2026-11-02T00:00:00+07:00",timeZone:"Asia/Bangkok",limit:3};
  it("retains the single administration when its condition is true",()=>{
    expect(nextDueDoses(one,{...options,evaluateCondition:()=>true}))
      .toEqual(["2026-11-02T00:00:00+07:00"]);
    expect(calculateTotalUnits({...options,dosage:one,durationValue:1,durationUnit:FhirPeriodUnit.Day,
      evaluateCondition:()=>true}).totalUnits).toBe(1);
  });
  it("does not invent a second event when its original condition is false",()=>{
    expect(nextDueDoses(one,{...options,
      evaluateCondition:(_condition,at)=>Date.parse(at)>Date.parse(options.orderedAt)})).toEqual([]);
  });
  it("keeps the authored event at treatment start, not at a later query",()=>{
    expect(nextDueDoses(one,{...options,from:"2026-11-03T00:00:00+07:00",
      evaluateCondition:()=>true})).toEqual([]);
  });
});


describe("PR14 new review: overlapping repeated-course chronological rolling allowance", () => {
  const anchor="2026-01-01T00:00:00Z";
  const member={kind:"administration" as const,
    amounts:[{quantity:{value:1,unit:"tab"}}],
    schedule:{recurrence:{
      frequency:1,period:3,periodUnit:FhirPeriodUnit.Day,
      clocks:["00:00:00"],courseLength:{value:4,unit:"d"}
    }},
    limits:[{scope:"period" as const,amount:{value:1,unit:"tab"},
      period:{value:2,unit:"d"}}]
  };
  const course={kind:"course" as const,cycleInterval:{value:1,unit:"d"},
    stages:[{administrations:[member]}]};
  const opts={orderedAt:anchor,from:anchor,timeZone:"UTC"};
  it("commits Jan 3 before Jan 4 even though Jan 4 belongs to the earlier cycle",()=>{
    const due=nextDueDoses(course,{...opts,limit:6});
    expect(due).toEqual(["01","03","05","07","09","11"].map(day =>
      "2026-01-"+day+"T00:00:00+00:00"));
    expect(due).not.toContain("2026-01-04T00:00:00+00:00");
    expect(calculateTotalUnits({...opts,dosage:course,durationValue:6,
      durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(3);
  });
  it("retains the first cycle's day-three tail when the intervening cycle is capped", () => {
    const tail = { ...member, limits: [{ scope: "period" as const,
      amount: { value: 1, unit: "tab" }, period: { value: 3, unit: "d" } }] };
    const overlapping = { ...course, cycleInterval: { value: 2, unit: "d" },
      stages: [{ administrations: [tail] }] };
    expect(nextDueDoses(overlapping, { ...opts, limit: 3 })).toEqual([
      "2026-01-01T00:00:00+00:00", "2026-01-04T00:00:00+00:00", "2026-01-07T00:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...opts, dosage: overlapping,
      durationValue: 4, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
  });
  it("keeps prior overlapped history across an arbitrary mid-window query",()=>{
    const from="2026-01-04T00:00:00Z";
    expect(nextDueDoses(course,{...opts,from,limit:2}))
      .toEqual(["2026-01-05T00:00:00+00:00","2026-01-07T00:00:00+00:00"]);
    expect(calculateTotalUnits({...opts,from,dosage:course,durationValue:2,
      durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(1);
  });
  it("keeps an authored count of 3 after rolling-cap exclusions, within a six-day stage",()=>{
    // One finite step, with three ACTUAL administrations. A
    // synthetic Jan 3 phase completion from the raw count must not
    // suppress its third eligible Jan 5 administration.
    const stageMember={...member,schedule:{recurrence:{
      frequency:1,period:1,periodUnit:FhirPeriodUnit.Day,
      clocks:["00:00:00"],courseLength:{value:6,unit:"d"},count:3
    }}};
    const single={...course,cycleInterval:undefined,stages:[{count:1,start:{anchor:"treatment-start" as const,
      displacement:{value:0,unit:"d"}},administrations:[stageMember]}]};
    expect(nextDueDoses(single,{...opts,limit:4}))
      .toEqual(["01","03","05"].map(day=>"2026-01-"+day+"T00:00:00+00:00"));
    expect(calculateTotalUnits({...opts,dosage:single,durationValue:6,
      durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(3);
  });
  it("defers each step repetition's exact count until three ACTUAL capped administrations are accepted",()=>{
    const dose={...member,schedule:{recurrence:{
      frequency:1,period:1,periodUnit:FhirPeriodUnit.Day,
      clocks:["00:00:00"],courseLength:{value:10,unit:"d"},count:3
    }}};
    const twice={...course,cycleInterval:undefined,stages:[{count:2,administrations:[dose]}]};
    // The first step repetition owns Jan 1/3/5. Its final accepted dose
    // opens the next repetition, whose Jan 6 opportunity is capped;
    // its three accepted administrations are Jan 7/9/11.
    const expected=["01","03","05","07","09","11"]
      .map(day=>"2026-01-"+day+"T00:00:00+00:00");
    expect(nextDueDoses(twice,{...opts,limit:7})).toEqual(expected);
    expect(calculateTotalUnits({...opts,dosage:twice,durationValue:12,
      durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(6);
  });
  it("does not reset allowance or count a dose for the in-between day",()=>{
    const from="2026-01-02T00:00:00Z";
    expect(nextDueDoses(course,{...opts,from,limit:1}))
      .toEqual(["2026-01-03T00:00:00+00:00"]);
    expect(calculateTotalUnits({...opts,from,dosage:course,durationValue:1,
      durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(0);
  });
});

describe("round 24 continuation course-window ownership", () => {
  it("copies a supported duration range into the unaffected meal administration", () => {
    const source = "Take 1 tablet twice daily before breakfast and dinner for 7 days, then reduce only the dinner dose to half a tablet for 1-7 days.";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.step).toHaveLength(2);
    for (const rows of [
      parsed.fhirNext.step[1].component,
      toFhirR5Dosages(parsed.fhirNext).filter(row => row.sequence === 2),
    ]) {
      expect(rows).toHaveLength(2);
      expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value).sort()).toEqual([0.5, 1]);
      for (const row of rows) {
        expect(row.timing?.repeat?.boundsRange).toMatchObject({
          low: { value: 1, code: "d" }, high: { value: 7, code: "d" },
        });
        expect(row.timing?.repeat?.boundsDuration).toBeUndefined();
        expect(row.timing?.repeat?.when).toEqual([
          row.doseAndRate?.[0]?.doseQuantity?.value === 1 ? EventTiming["Before Breakfast"] : EventTiming["Before Dinner"],
        ]);
      }
    }
    expect(parsed.input).toBe(source);
  });

  it("replaces the donor's supported duration range with an exact continuation", () => {
    const source = "Take 1 tablet twice daily before breakfast and dinner for 7-14 days, then reduce only the dinner dose to half a tablet for 3 days.";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
      duration: 7, durationMax: 14, durationUnit: "d",
    });
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[0].component[0].timing?.repeat?.boundsRange)
      .toMatchObject({ low: { value: 7, code: "d" }, high: { value: 14, code: "d" } });
    for (const rows of [
      parsed.fhirNext.step[1].component,
      toFhirR5Dosages(parsed.fhirNext).filter(row => row.sequence === 2),
    ]) {
      expect(rows).toHaveLength(2);
      expect(rows.map(row => ({
        when: row.timing?.repeat?.when, dose: row.doseAndRate?.[0]?.doseQuantity?.value,
      }))).toEqual(expect.arrayContaining([
        { when: [EventTiming["Before Breakfast"]], dose: 1 },
        { when: [EventTiming["Before Dinner"]], dose: 0.5 },
      ]));
      for (const row of rows) {
        expect(row.timing?.repeat?.boundsDuration).toMatchObject({ value: 3, code: "d" });
        expect(row.timing?.repeat?.boundsDuration?.comparator).toBeUndefined();
        expect(row.timing?.repeat?.boundsRange).toBeUndefined();
      }
    }
    expect(parsed.input).toBe(source);
  });
});

describe("PR14 round 29 execution semantics", () => {
  const orderedAt = "2027-01-01T00:00:00Z";
  const options = { from: orderedAt, orderedAt, timeZone: "UTC", limit: 10 };
  const supplyOptions = { ...options, durationValue: 4, durationUnit: FhirPeriodUnit.Day };
  const representations = (course: FhirR6DosageInstruction) =>
    [courseFromR6(course), course, JSON.parse(JSON.stringify(toFhirR5Dosages(course))) as FhirDosage[]];

  it("resolves code-only per-target quantities for supply and rolling caps", () => {
    const site = parseSig("1 drop OU daily").fhirNext.step[0].component[0].site;
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      site, timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, system: "http://standardterms.edqm.eu", code: "15022000" } }],
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 2, unit: "drop" },
        period: { value: 24, unit: "h", code: "h" } }] }
    }] }] };
    const original = JSON.stringify(course);
    expect(courseFromR6(course).stages[0].administrations[0].targetCount).toBe(2);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, { ...options, limit: 3 })).toEqual([
        "2027-01-01T08:00:00+00:00", "2027-01-02T08:00:00+00:00", "2027-01-03T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    }
    expect(JSON.stringify(course)).toBe(original);
    const uncapped = JSON.parse(original) as FhirR6DosageInstruction;
    delete uncapped.step[0].component[0].safety;
    uncapped.step[0].component[0].timing = { repeat: { count: 1 } };
    for (const dosage of representations(uncapped))
      expect(calculateTotalUnits({ dosage, ...supplyOptions }).totalUnits).toBe(2);

    const metric = JSON.parse(JSON.stringify(uncapped)) as FhirR6DosageInstruction;
    metric.step[0].component[0].doseAndRate = [{
      doseQuantity: { value: 1, system: "http://unitsofmeasure.org", code: "mL" }
    }];
    for (const dosage of representations(metric))
      expect(calculateTotalUnits({ dosage, ...supplyOptions }).totalUnits).toBe(1);
  });

  it("keeps concrete coded cadence separate from the maximum-frequency supply plan", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QD" }] },
        repeat: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["09:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 2, unit: "tab" },
        period: { value: 24, unit: "h", code: "h" } }] },
    }] }] };
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([
        "2027-01-01T09:00:00+00:00", "2027-01-02T09:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1,
        durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: 2, quantityKind: "maximum" });
    }
    expect(JSON.stringify(course)).toBe(original);
  });

  it("keeps a coded period range intact while measuring its shortest permitted period", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { code: { coding: [{ code: "QOD" }] },
        repeat: { frequency: 1, period: 1, periodMax: 2, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["09:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 2, unit: "tab" },
        period: { value: 24, code: "h" } }] },
    }] }] };
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      const native = "kind" in dosage ? dosage : importCanonicalCourse(dosage);
      expect(native.stages[0].administrations[0].schedule).toMatchObject({
        code: { coding: [expect.objectContaining({ code: "QOD" })] },
        recurrence: { period: 1, periodMax: 2 },
      });
      if (Array.isArray(dosage)) expect(dosage[0].timing).toMatchObject({
        code: { coding: [expect.objectContaining({ code: "QOD" })] }, repeat: { period: 1, periodMax: 2 },
      });
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([
        "2027-01-01T09:00:00+00:00", "2027-01-02T09:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...supplyOptions })).toMatchObject({
        totalUnits: 4, quantityKind: "maximum",
      });
    }
    expect(JSON.stringify(course)).toBe(original);
  });

  it.each([false, true])("finds the recognized timing code independent of coding order: %s", knownFirst => {
    const codings = [{ system: "urn:hospital:timing", code: "ALTERNATE" },
      { system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QOD" }];
    if (knownFirst) codings.reverse();
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { code: { coding: codings }, repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    }] }] };
    for (const dosage of representations(course)) {
      expect(() => nextDueDoses(dosage, options)).toThrowError(
        expect.objectContaining({ code: "timing-code-repeat-conflict" }));
      expect(() => calculateTotalUnits({ dosage, ...supplyOptions })).toThrowError(
        expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    }
    const matching = structuredClone(course);
    matching.step[0].component[0].timing!.repeat!.period = 2;
    for (const dosage of representations(matching)) {
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([
        "2027-01-01T09:00:00+00:00", "2027-01-03T09:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...supplyOptions }).totalUnits).toBe(2);
    }
  });

  it("uses a recognized later coding for configured clocks before frequency defaults", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { code: { coding: [{ system: "urn:hospital:timing", code: "WARD" }, { code: "QID" }] },
        repeat: { frequency: 4, period: 1, periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    }] }] };
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, { ...options, limit: 4, config: {
        frequencyDefaults: { byCode: { QID: ["05:00", "10:00", "15:00", "20:00"] },
          byFrequency: { "freq:4/d": ["06:00", "11:00", "16:00", "21:00"] } }
      } })).toEqual(["2027-01-01T05:00:00+00:00", "2027-01-01T10:00:00+00:00",
        "2027-01-01T15:00:00+00:00", "2027-01-01T20:00:00+00:00"]);
    }
  });

  it("preserves code-only institution defaults without assigning them a clinical cadence", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { code: { coding: [{ system: "urn:hospital:timing", code: "WARD" }] },
        repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    }] }] };
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, { ...options, limit: 1, config: {
        frequencyDefaults: { byCode: { WARD: ["07:00"] }, byFrequency: { "freq:1/d": ["10:00"] } }
      } })).toEqual(["2027-01-01T07:00:00+00:00"]);
    }
  });

  it.each([false, true])("countMax only limits PRN admissions and cannot complete its stage: capped %s", capped => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      asNeeded: true,
      timing: { repeat: { countMax: 2, frequency: 1, period: 1,
        periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      ...(capped ? { safety: { doseLimit: [{ scope: "period" as const,
        valueQuantity: { value: 1, unit: "tab" }, period: { value: 24, code: "h" } }] } } : {}),
    }] }, { component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["12:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 10, unit: "tab" } }],
    }] }] };
    if (capped) course.repeatCycle = { value: 7, unit: "d", code: "d" };
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, { ...options, limit: 3 })).toEqual([
        "2027-01-01T09:00:00+00:00", "2027-01-02T09:00:00+00:00",
        ...(capped ? ["2027-01-08T09:00:00+00:00"] : []),
      ]);
      expect(calculateTotalUnits({ dosage, ...supplyOptions }).totalUnits).toBe(2);
    }
    expect(JSON.stringify(course)).toBe(original);
    const exact = JSON.parse(original) as FhirR6DosageInstruction;
    exact.step[0].component[0].timing!.repeat!.count = 2;
    delete exact.step[0].component[0].timing!.repeat!.countMax;
    for (const dosage of representations(exact)) {
      expect(nextDueDoses(dosage, { ...options, limit: 3 })).toEqual([
        "2027-01-01T09:00:00+00:00", "2027-01-02T09:00:00+00:00",
        "2027-01-02T12:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...supplyOptions }).totalUnits).toBe(32);
    }
    const bounded = JSON.parse(original) as FhirR6DosageInstruction;
    bounded.step[0].component[0].timing!.repeat!.boundsDuration = { value: 2, code: "d" };
    for (const dosage of representations(bounded)) {
      expect(nextDueDoses(dosage, { ...options, limit: 3 })).toEqual([
        "2027-01-01T09:00:00+00:00", "2027-01-02T09:00:00+00:00",
        "2027-01-03T12:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...supplyOptions }).totalUnits).toBe(22);
    }
  });

  it("spring DST civil day excludes Sunday 06:00 after the +3h origin", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      modifierExtension: [{ url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
        valueQuantity: { value: 3, unit: "h", code: "h" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["06:00:00"], boundsDuration: { value: 1, unit: "d", code: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const opts = { from: "2027-03-13T02:30:00-05:00", orderedAt: "2027-03-13T02:30:00-05:00",
      timeZone: "America/New_York", limit: 10, durationValue: 3, durationUnit: FhirPeriodUnit.Day };
    const rows = JSON.parse(JSON.stringify(toFhirR5Dosages(course))) as FhirDosage[];
    for (const dosage of [courseFromR6(course), course, rows, rows[0], fromFhir(course)]) {
      expect(nextDueDoses(dosage, opts)).toEqual(["2027-03-13T06:00:00-05:00"]);
      expect(calculateTotalUnits({ dosage, ...opts }).totalUnits).toBe(1);
    }
  });
});

describe("round 33 complete timing-code evidence", () => {
  const query = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 2 };
  const gts = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
  it.each([false, true])("rejects every recognized conflicting code independent of order (%s)", reverse => {
    const coding = [{ system: gts, code: "BID" }, { system: gts, code: "QID" }];
    if (reverse) coding.reverse();
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding }, repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    const before = JSON.stringify(source);
    for (const dosage of [source, toFhirR5Dosages(source), importCanonicalCourse(source)]) {
      expect(() => nextDueDoses(dosage, query)).toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
      expect(() => calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    }
    expect(JSON.stringify(source)).toBe(before);
  });
  it("keeps compatible local translations and integer cadence intersections executable", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "urn:hospital:timing", code: "QID" }, { system: gts, code: "BID" }] },
        repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    expect(nextDueDoses(row, query)).toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: row, ...query, durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    const q4h = structuredClone(row);
    q4h.timing = { code: { coding: [{ system: gts, code: "Q4H" }] },
      repeat: { frequency: 1, period: 4, periodMax: 7, periodUnit: FhirPeriodUnit.Hour } };
    expect(nextDueDoses(q4h, query)).toEqual(["2026-01-01T00:00:00+00:00", "2026-01-01T04:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: q4h, ...query, durationValue: 8, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(2);
  });
});


describe("round38: authored boundaries, elapsed clocks, and recorded occurrence ownership", () => {
  const origin = "2024-01-01T00:00:00Z";
  const opts = { orderedAt: origin, from: origin, timeZone: "UTC", limit: 4 };
  const representations = (course: FhirR6DosageInstruction) => [
    courseFromR6(course), course, JSON.parse(JSON.stringify(toFhirR5Dosages(course)))
  ];

  it.each([
    [0.5, FhirPeriodUnit.Day], [1 / 14, FhirPeriodUnit.Week], [12, FhirPeriodUnit.Hour]
  ] as const)("anchors elapsed %s %s at the authored clock without erasing spacing", (period, periodUnit) => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 1, period, periodUnit, timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, opts)).toEqual([
        "2024-01-01T08:00:00+00:00", "2024-01-01T20:00:00+00:00",
        "2024-01-02T08:00:00+00:00", "2024-01-02T20:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...opts, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(2);
    }
    expect(JSON.stringify(course)).toBe(original);
  });

  it.each([FhirPeriodUnit.Day, FhirPeriodUnit.Week])("keeps whole %s clocks on their civil cadence", periodUnit => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit, timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const nextDay = periodUnit === FhirPeriodUnit.Day ? "14" : "20";
    const before = JSON.stringify(course);
    const spring = { orderedAt: "2027-03-13T00:00:00-05:00", from: "2027-03-13T00:00:00-05:00",
      timeZone: "America/New_York", limit: 2 };
    for (const dosage of representations(course)) expect(nextDueDoses(dosage, spring)).toEqual([
      "2027-03-13T08:00:00-05:00", "2027-03-" + nextDay + "T08:00:00-04:00"
    ]);
    expect(JSON.stringify(course)).toBe(before);
  });

  it.each([undefined, "<=" as const, "<" as const])("distinguishes an open uncapped range maximum: %s", comparator => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { count: 1, timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" },
        high: { value: 2, unit: "tab", ...(comparator ? { comparator } : {}) } } }]
    }] }] };
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, opts)).toEqual(["2024-01-01T08:00:00+00:00"]);
      const calculate = () => calculateTotalUnits({ ...opts, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day });
      if (comparator === "<") expect(calculate).toThrowError(expect.objectContaining({
        code: "ranged-capacity-open-maximum"
      }));
      else expect(calculate().totalUnits).toBe(2);
      expect(calculateTotalUnits({ ...opts, from: "2024-01-02T00:00:00Z", dosage,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(0);
    }
    expect(JSON.stringify(course)).toBe(original);
  });

  it.each(["administration", "lifetime"] as const)("uses a smaller closed %s ceiling inside an open range", scope => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { count: 1, timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab", comparator: "<" } } }],
      safety: { doseLimit: [{ scope, valueQuantity: { value: 1.5, unit: "tab" } }] }
    }] }] };
    for (const dosage of representations(course)) expect(calculateTotalUnits({
      ...opts, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(1.5);
  });

  it.each(["08:00:00", "20:00:00"])("reserves the recorded %s use for its full civil bucket", actualClock => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, count: 2,
        timeOfDay: ["08:00:00", "20:00:00"],
        extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
          { url: "max", valueInteger: 1 }, { url: "period", valueQuantity: { value: 1, code: "d" } }
        ] }] } },
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 4, unit: "tab" },
        period: { value: 24, code: "h" } }] }
    }] }] };
    const later = { ...opts, from: "2024-01-02T00:00:00Z", priorDoseTimes: ["2024-01-01T" + actualClock + "Z"] };
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, later)).toEqual(["2024-01-02T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...later, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
      const sameDay = { ...later, from: "2024-01-01T12:00:00Z", priorCount: 1, limit: 1 };
      expect(nextDueDoses(dosage, sameDay)).toEqual(["2024-01-02T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...sameDay, dosage,
        durationValue: 12, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(0);
      const withoutRecordedTime = { ...sameDay, priorDoseTimes: undefined };
      expect(nextDueDoses(dosage, withoutRecordedTime)).toEqual(["2024-01-01T20:00:00+00:00"]);
      expect(calculateTotalUnits({ ...withoutRecordedTime, dosage,
        durationValue: 12, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(2);
      expect(nextDueDoses(dosage, opts)).toEqual([
        "2024-01-01T08:00:00+00:00", "2024-01-02T08:00:00+00:00"
      ]);
    }
    expect(JSON.stringify(course)).toBe(original);
  });

  it("fences a bare BID component before enumerating a known daily cycle", () => {
    const course: FhirR6DosageInstruction = { repeatCycle: { value: 1, code: "d" }, step: [{
      end: { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
        offsetDuration: { value: 1, code: "d" } },
      component: [
        { timing: { code: { coding: [{ code: "BID" }] } }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] },
        { timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["10:00:00"] } },
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 1, unit: "tab" },
            period: { value: 1, code: "d" } }] } }
      ]
    }] };
    const configured = { ...opts, limit: 6, frequencyDefaults: { byCode: { BID: ["07:00", "19:00"] } } };
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, configured)).toEqual([
        "2024-01-01T07:00:00+00:00", "2024-01-01T10:00:00+00:00", "2024-01-01T19:00:00+00:00",
        "2024-01-02T07:00:00+00:00", "2024-01-02T10:00:00+00:00", "2024-01-02T19:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...configured, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(84);
    }
    expect(JSON.stringify(course)).toBe(original);
    const conditionalCourse = structuredClone(course);
    conditionalCourse.step[0].component[0].condition = [{ code: { coding: [{
      system: "urn:ezmedicationinput:CodeSystem:medication-condition", code: "measurement"
    }], text: "blood glucose" }, operation: "gt", valueQuantity: { value: 180, unit: "mg/dL" } }];
    for (const dosage of representations(conditionalCourse)) {
      const evaluated: string[] = [];
      const times = nextDueDoses(dosage, { ...configured, limit: 84,
        evaluateCondition: (_condition, stamp) => { evaluated.push(stamp); return true; } });
      expect(times).toHaveLength(84);
      expect(times.slice(-3)).toEqual(["2024-01-28T07:00:00+00:00",
        "2024-01-28T10:00:00+00:00", "2024-01-28T19:00:00+00:00"]);
      // Four weeks of BID contributes 56 conditional opportunities. The
      // daily fence must reach the scalar scheduler before condition evaluation.
      expect(evaluated).toHaveLength(56);
      expect(new Set(evaluated).size).toBe(56);
    }
  });

  it.each([false, true])("ignores an inactive incompatible component in bottle and ingredient estimates: reversed %s", reversed => {
    const drop: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } } };
    const mg: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "mg" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["20:00:00"] } } };
    const dosage = reversed ? [mg, drop] : [drop, mg];
    const context = { dosageForm: "eye drops", strength: "500 mcg / 100 mL", containerValue: 5, containerUnit: "mL" };
    expect(calculateTotalUnits({ ...opts, dosage, durationValue: 12, durationUnit: FhirPeriodUnit.Hour, context }))
      .toMatchObject({ totalUnits: 1, unit: "drop", totalContainers: 1,
        totalApproximateQuantity: { value: 0.05, unit: "mL" },
        totalApproximateIngredientQuantity: { value: 0.25, unit: "mcg" } });
    expect(() => calculateTotalUnits({ ...opts, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day, context }))
      .toThrowError(expect.objectContaining({ code: "incompatible-dose-units" }));
  });

  it.each(["2 tablets from day 5", "from day 5 2 tablets"])("retains an onset-only coordinated dose with its own phase: %s", continuation => {
    const source = "Take 1 tablet daily for 4 days and " + continuation;
    const parsed = parseSig(source);
    const stages = parsed.meta.canonical.course!.stages;
    expect(stages).toHaveLength(2);
    expect(stages.map(stage => stage.administrations[0].amounts?.[0].quantity?.value)).toEqual([1, 2]);
    expect(stages[0].administrations[0].schedule?.recurrence?.courseLength).toMatchObject({ value: 4, unit: "d" });
    expect(stages[1].start).toMatchObject({ anchor: "treatment-day-start", displacement: { value: 4, unit: "d" } });
    expect(stages[1].administrations[0].schedule?.recurrence?.courseLength).toBeUndefined();
    expect(stages[1].administrations[0].schedule?.recurrence)
      .toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, { ...opts, limit: 1 })).toEqual(["2024-01-01T09:00:00+00:00"]);
      expect(calculateTotalUnits({ ...opts, dosage, durationValue: 4, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(4);
      const dayFive = { ...opts, from: "2024-01-05T00:00:00Z", limit: 1 };
      expect(nextDueDoses(dosage, dayFive)).toEqual(["2024-01-05T09:00:00+00:00"]);
      expect(calculateTotalUnits({ ...dayFive, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(2);
    }
  });

  it.each(["2", "2 tablets"])("retains the order of a backward clock THEN continuation: %s", dose => {
    const backwards = parseSig("Take 1 tablet at 22:00 then " + dose + " at 06:00");
    expect(backwards.meta.canonical.course!.stages.map(stage =>
      stage.administrations.map(member => [member.amounts?.[0].quantity?.value, member.amounts?.[0].quantity?.unit])))
      .toEqual([[[1, "tab"]], [[2, "tab"]]]);
    for (const dosage of [backwards, backwards.fhirNext, JSON.parse(JSON.stringify(backwards.fhir))])
      expect(nextDueDoses(dosage, { ...opts, limit: 2 })).toEqual([
        "2024-01-01T22:00:00+00:00", "2024-01-02T06:00:00+00:00"
      ]);
    const forwards = parseSig("Take 1 tablet at 08:00 then " + dose + " at 18:00");
    expect(forwards.meta.canonical.course!.stages).toHaveLength(1);
    expect(forwards.meta.canonical.course!.stages[0].administrations).toHaveLength(2);
    expect(nextDueDoses(forwards, { ...opts, limit: 2 })).toEqual([
      "2024-01-01T08:00:00+00:00", "2024-01-01T18:00:00+00:00"
    ]);
  });

  it.each([["00:00:00", 6], ["09:00:00", 5], ["23:00:00", 3]] as const)(
    "closes coordinated predecessors at the civil successor boundary after a %s order", (clock, total) => {
    const parsed = parseSig("Take 1 tablet at 08:00 and 2 tablets at 22:00, then take 3 tablets at 06:00 the next morning");
    const orderedAt = "2026-11-21T" + clock + "Z", end = Date.parse("2026-11-23T00:00:00Z");
    const clinical = { orderedAt, from: orderedAt, timeZone: "UTC", limit: 6 };
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      const expected = [
        ...(clock === "00:00:00" ? ["2026-11-21T08:00:00+00:00"] : []),
        ...(clock !== "23:00:00" ? ["2026-11-21T22:00:00+00:00"] : []),
        "2026-11-22T06:00:00+00:00"
      ];
      expect(nextDueDoses(dosage, clinical).filter(stamp => Date.parse(stamp) < end)).toEqual(expected);
      expect(calculateTotalUnits({ ...clinical, dosage,
        durationValue: (end - Date.parse(orderedAt)) / 3600000, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(total);
    }
  });
});


describe("round38: independent infusion-duration endpoints", () => {
  const durationUrl = "urn:ezmedicationinput:StructureDefinition:timing-administration-duration";
  const options = { from: "2024-01-01T00:00:00Z", orderedAt: "2024-01-01T00:00:00Z", timeZone: "UTC",
    durationValue: 1, durationUnit: FhirPeriodUnit.Day, limit: 2 };
  const low = { value: 90, unit: "minutes", code: "min", system: "http://unitsofmeasure.org" };
  const high = { value: 2, unit: "hours", code: "h", system: "http://unitsofmeasure.org" };
  type DurationEndpoint = { value: number; unit: string; code?: string; system?: string; comparator?: "<" | ">" };
  function infusion(range: { low?: DurationEndpoint; high?: DurationEndpoint }): FhirR6DosageInstruction {
    return { step: [{ component: [{
      timing: { repeat: { count: 1, timeOfDay: ["08:00:00"],
        extension: [{ url: durationUrl, valueRange: {
          ...(range.low ? { low: { ...range.low } } : {}),
          ...(range.high ? { high: { ...range.high } } : {})
        } }] } },
      doseAndRate: [{ rateQuantity: { value: 20, unit: "mL/hour", code: "mL/h", system: "http://unitsofmeasure.org" } }]
    }] }] };
  }
  const representations = (course: FhirR6DosageInstruction) => [
    courseFromR6(course), course, JSON.parse(JSON.stringify(toFhirR5Dosages(course)))
  ];
  it.each([false, true])("computes 40 mL maximum from the authored 2 h endpoint: upper only %s", upperOnly => {
    const course = infusion({ ...(upperOnly ? {} : { low }), high });
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, options)).toEqual(["2024-01-01T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...options, dosage })).toMatchObject({ totalUnits: 40, unit: "mL", quantityKind: "maximum" });
    }
    expect(JSON.stringify(course)).toBe(original);
  });
  it.each([
    ["both", { value: 90, unit: "minutes" }, { value: 2, unit: "hours" }],
    ["lower", { value: 90, unit: "minutes" }, high],
    ["upper", low, { value: 2, unit: "hours" }],
    ["trimmed labels", { value: 90, unit: " MINUTES " }, { value: 2, unit: " Hours " }]
  ] as const)("interprets uncoded %s duration endpoints without rewriting them", (_label, lower, upper) => {
    const range = { low: lower, high: upper };
    const course = infusion(range);
    expect(courseFromR6(course).stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange)
      .toEqual(range);
    for (const dosage of representations(course)) {
      const original = JSON.stringify(dosage);
      expect(calculateTotalUnits({ ...options, dosage }))
        .toMatchObject({ totalUnits: 40, unit: "mL", quantityKind: "maximum" });
      expect(JSON.stringify(dosage)).toBe(original);
    }
  });
  it.each(["low", "high"] as const)("keeps an authored uncoded %s-only endpoint open", endpoint => {
    const course = infusion(endpoint === "low"
      ? { low: { value: 90, unit: "minutes" } }
      : { high: { value: 2, unit: "hours" } });
    for (const dosage of representations(course)) {
      if (endpoint === "low")
        expect(() => calculateTotalUnits({ ...options, dosage }))
          .toThrowError(expect.objectContaining({ code: "dose-amount-lower-bound" }));
      else
        expect(calculateTotalUnits({ ...options, dosage }))
          .toMatchObject({ totalUnits: 40, unit: "mL", quantityKind: "maximum" });
    }
  });
  it.each([
    ["low", false], ["high", false], ["low", true], ["high", true]
  ] as const)("does not discard an uninterpretable %s endpoint: coded %s", (endpoint, coded) => {
    const range: { low: DurationEndpoint; high: DurationEndpoint } = { low: { ...low }, high: { ...high } };
    range[endpoint] = { ...range[endpoint],
      code: coded ? "unrecognized-time-unit" : undefined,
      unit: coded ? range[endpoint].unit : "sessions"
    };
    const course = infusion(range);
    course.step[0].component[0].safety = { doseLimit: [{ scope: "administration",
      valueQuantity: { value: 35, unit: "mL" } }] };
    for (const dosage of representations(course)) {
      const original = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, options)).toEqual(["2024-01-01T08:00:00+00:00"]);
      expect(() => calculateTotalUnits({ ...options, dosage }))
        .toThrowError(expect.objectContaining({ code: "rate-units-unresolved" }));
      expect(JSON.stringify(dosage)).toBe(original);
    }
  });
  it("does not treat a lower-only infusion duration as exact 90 minutes", () => {
    const course = infusion({ low });
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, options)).toEqual(["2024-01-01T08:00:00+00:00"]);
      expect(() => calculateTotalUnits({ ...options, dosage }))
        .toThrowError(expect.objectContaining({ code: "dose-amount-lower-bound" }));
    }
  });
  it("keeps a strict duration endpoint open while admitting a smaller closed quantity maximum", () => {
    const course = infusion({ low, high: { ...high, comparator: "<" } });
    for (const dosage of representations(course))
      expect(() => calculateTotalUnits({ ...options, dosage }))
        .toThrowError(expect.objectContaining({ code: "ranged-capacity-open-maximum" }));
    const cappedCourse = structuredClone(course);
    cappedCourse.step[0].component[0].safety = { doseLimit: [{ scope: "administration",
      valueQuantity: { value: 35, unit: "mL" } }] };
    for (const dosage of representations(cappedCourse))
      expect(calculateTotalUnits({ ...options, dosage }).totalUnits).toBe(35);
  });
  it.each([
    [false, false], [true, false], [false, true], [true, true]
  ] as const)("applies rolling volume limits to ranged infusion durations: strict minimum %s, uncoded lower %s", (strict, uncoded) => {
    const course = infusion({ low: uncoded ? { value: 90, unit: "minutes" } : low, high });
    const component = course.step[0].component[0];
    component.timing!.repeat!.count = undefined;
    component.timing!.repeat!.frequency = 3;
    component.timing!.repeat!.period = 1;
    component.timing!.repeat!.periodUnit = FhirPeriodUnit.Day;
    component.timing!.repeat!.timeOfDay = ["08:00:00", "12:00:00", "16:00:00"];
    if (strict) component.timing!.repeat!.extension![0].valueRange!.low!.comparator = ">";
    component.safety = { doseLimit: [{ scope: "period", valueQuantity: { value: 60, unit: "mL" },
      period: { value: 24, code: "h" } }] };
    const original = JSON.stringify(course);
    for (const dosage of representations(course)) {
      expect(nextDueDoses(dosage, { ...options, limit: 3 })).toEqual(strict ? [
        "2024-01-01T08:00:00+00:00", "2024-01-02T08:00:00+00:00", "2024-01-03T08:00:00+00:00"
      ] : [
        "2024-01-01T08:00:00+00:00", "2024-01-01T12:00:00+00:00", "2024-01-02T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...options, dosage }).totalUnits).toBe(strict ? 40 : 60);
    }
    expect(JSON.stringify(course)).toBe(original);
  });

  it.each([false, true])("uses uncoded time aliases for exact completion: equal endpoints %s", equal => {
    const course = infusion({ low: { value: equal ? 120 : 90, unit: "minutes" },
      high: { value: 2, unit: "hours" } });
    course.step.push({ component: [{ timing: { repeat: { count: 1, timeOfDay: ["11:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 10, unit: "mL" } }] }] });
    for (const dosage of representations(course))
      expect(nextDueDoses(dosage, options)).toEqual([
        "2024-01-01T08:00:00+00:00", ...(equal ? ["2024-01-01T11:00:00+00:00"] : [])
      ]);
  });
  it.each([false, true])("only an exact duration completes the predecessor: equal endpoints %s", equal => {
    const course = infusion({ low: equal ? { ...low, value: 120 } : low, high });
    course.step.push({ component: [{ timing: { repeat: { count: 1, timeOfDay: ["11:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 10, unit: "mL" } }] }] });
    for (const dosage of representations(course))
      expect(nextDueDoses(dosage, options)).toEqual([
        "2024-01-01T08:00:00+00:00", ...(equal ? ["2024-01-01T11:00:00+00:00"] : [])
      ]);
  });
});

it.each(["12 h", "12h", "24 h"])("round38: typed maximum owns its spaced slash denominator %s", period => {
  const parsed = parseSig("Take 1 mg daily, max 10 mg / " + period);
  expect(parsed.items).toHaveLength(1);
  expect(parsed.meta.canonical.course!.stages[0].administrations[0].limits)
    .toEqual([{ scope: "period", amount: { value: 10, unit: "mg" },
      period: { value: period.startsWith("24") ? 24 : 12, unit: "h" } }]);
  expect(parseSig("Take 1 tablet daily / 2 tablets nightly").items).toHaveLength(2);
});

it.each([5, 6, 8, 10])("round38: supported day %s parallel successor is retained even with a short authored course", day => {
  const source = "1 drop OD QID x7d then from day " + day +
    " 2 drops OD BID x1d; 3 drops OS QID x1mo then 3 drops OS BID";
  const parsed = parseSig(source);
  const right = parsed.fhir.filter(row => row.site?.text === "right eye");
  expect(right.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 2]);
  const date = String(20 + day);
  const from = "2026-11-" + date + "T00:00:00Z";
  const options = { orderedAt: "2026-11-21T00:00:00Z", from, timeZone: "UTC", limit: 4 };
  expect(nextDueDoses(JSON.parse(JSON.stringify(right)), options)).toEqual([
    "2026-11-" + date + "T08:00:00+00:00", "2026-11-" + date + "T20:00:00+00:00"
  ]);
  expect(calculateTotalUnits({ ...options, dosage: right, durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
  if (day === 10) {
    const gap = { ...options, from: "2026-11-28T00:00:00Z", limit: 1 };
    expect(nextDueDoses(right, gap)).toEqual(["2026-11-30T08:00:00+00:00"]);
    expect(calculateTotalUnits({ ...gap, dosage: right, durationValue: 2, durationUnit: FhirPeriodUnit.Day })
      .totalUnits).toBe(0);
  }
});


describe("round39: calendar gaps, treatment eligibility, and authored count completion", () => {
  const origin = "2024-01-01T00:00:00Z";
  const options = { from: origin, orderedAt: origin, timeZone: "UTC", limit: 4 };
  const representations = (course: FhirR6DosageInstruction) => [
    courseFromR6(course), course, JSON.parse(JSON.stringify(toFhirR5Dosages(course)))
  ];
  const clocked = (clock = "09:00:00"): FhirR6DosageInstruction => ({ step: [{ component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: [clock] } }
  }] }] });

  it("advances a missing civil boundary across midnight without shifting an exact dose clock", () => {
    // Current Nuuk data skips 23:30 across midnight; older ICU data keeps
    // that clock at -02. Read the host data independently of these helpers.
    const boundaryClock = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Nuuk",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date("2026-03-29T01:30:00Z"));
    expect(["00:30", "23:30"]).toContain(boundaryClock);
    const hasMidnightGap = boundaryClock === "00:30";
    expect(calendarBoundaryDate("America/Nuuk", 2026, 3, 28, 23, 30, 0)?.toISOString())
      .toBe("2026-03-29T01:30:00.000Z");
    expect(makeZonedDate("America/Nuuk", 2026, 3, 28, 23, 30, 0)?.toISOString() ?? null)
      .toBe(hasMidnightGap ? null : "2026-03-29T01:30:00.000Z");
    const course = clocked("00:15:00"), original = JSON.stringify(course);
    const start = "2026-03-27T23:30:00-02:00";
    for (const dosage of representations(course))
      expect(calculateTotalUnits({ dosage, from: start, orderedAt: start, timeZone: "America/Nuuk",
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: hasMidnightGap ? 2 : 1, unit: "tab" });
    // This query is on March 28 under both the old and current offsets.
    for (const dosage of representations(clocked("23:30:00")))
      expect(nextDueDoses(dosage, { from: "2026-03-28T03:00:00Z", timeZone: "America/Nuuk", limit: 1 }))
        .toEqual([hasMidnightGap ? "2026-03-29T23:30:00-01:00" : "2026-03-28T23:30:00-02:00"]);
    expect(JSON.stringify(course)).toBe(original);
  });

  it("keeps ordinary DST gap boundaries and invalid calendar inputs distinct", () => {
    expect(calendarBoundaryDate("America/New_York", 2026, 3, 8, 2, 30, 0)?.toISOString())
      .toBe("2026-03-08T07:30:00.000Z");
    expect(calendarBoundaryDate("America/Nuuk", 2026, 2, 30, 23, 30, 0)).toBeNull();
    expect(calendarBoundaryDate("America/Nuuk", 2026, 3, 28, 24, 30, 0)).toBeNull();
  });

  it.each([false, true])("counts historical administrations only inside their treatment window: explicit events %s", explicit => {
    const source = clocked();
    const timing = source.step[0].component[0].timing!;
    timing.repeat!.count = 1;
    timing.repeat!.boundsPeriod = { start: "2024-01-02" };
    if (explicit) timing.event = ["2024-01-01T09:00:00Z", "2024-01-02T09:00:00Z", "2024-01-03T09:00:00Z"];
    const original = JSON.stringify(source);
    const scalar = JSON.parse(JSON.stringify(source.step[0].component[0])) as FhirDosage;
    for (const dosage of [scalar, [scalar], ...representations(source)]) {
      for (const orderedAt of [undefined, origin]) {
        const query = { from: "2024-01-02T00:00:00Z", orderedAt, timeZone: "UTC", limit: 1 };
        expect(nextDueDoses(dosage, query)).toEqual(["2024-01-02T09:00:00+00:00"]);
        expect(calculateTotalUnits({ ...query, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day })
          .totalUnits).toBe(1);
        const later = { ...query, from: "2024-01-03T00:00:00Z" };
        expect(nextDueDoses(dosage, later)).toEqual([]);
        expect(calculateTotalUnits({ ...later, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day })
          .totalUnits).toBe(0);
      }
      const laterOrder = { from: "2024-01-02T00:00:00Z", orderedAt: "2024-01-02T12:00:00Z", timeZone: "UTC", limit: 1 };
      expect(nextDueDoses(dosage, laterOrder)).toEqual(["2024-01-03T09:00:00+00:00"]);
      expect(calculateTotalUnits({ ...laterOrder, dosage, durationValue: 2, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(1);
    }
    expect(JSON.stringify(source)).toBe(original);
  });

  it("keeps unfiltered clock supply inside the treatment order", () => {
    const source = clocked(), original = JSON.stringify(source);
    const query = { ...options, orderedAt: "2024-01-02T00:00:00Z", limit: 1 };
    const scalar = JSON.parse(JSON.stringify(source.step[0].component[0])) as FhirDosage;
    for (const dosage of [scalar, [scalar], ...representations(source)]) {
      expect(nextDueDoses(dosage, query)).toEqual(["2024-01-02T09:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(0);
      expect(calculateTotalUnits({ ...query, dosage, from: query.orderedAt,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
    }
    expect(JSON.stringify(source)).toBe(original);
  });

  it.each([false, true])("uses an upper count for supply without inventing loading completion: capped %s", capped => {
    const source = clocked("08:00:00");
    source.repeatCycle = { value: 7, code: "d" };
    const loading = source.step[0].component[0];
    loading.timing!.repeat!.count = 1;
    loading.timing!.repeat!.countMax = 2;
    if (capped) loading.safety = { doseLimit: [{ scope: "period", valueQuantity: { value: 1, unit: "tab" },
      period: { value: 24, code: "h" } }] };
    source.step.push({ component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["12:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 10, unit: "tab" } }]
    }] });
    const original = JSON.stringify(source);
    for (const dosage of representations(source)) {
      expect(nextDueDoses(dosage, options)).toEqual([
        "2024-01-01T08:00:00+00:00", "2024-01-02T08:00:00+00:00",
        "2024-01-08T08:00:00+00:00", "2024-01-09T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 7, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(2);
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 14, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(4);
    }
    expect(JSON.stringify(source)).toBe(original);
    const exact = structuredClone(source);
    const exactLoading = exact.step[0].component[0];
    exactLoading.timing!.repeat!.count = 2;
    delete exactLoading.timing!.repeat!.countMax;
    for (const dosage of representations(exact)) {
      expect(nextDueDoses(dosage, { ...options, limit: 3 })).toEqual([
        "2024-01-01T08:00:00+00:00", "2024-01-02T08:00:00+00:00", "2024-01-02T12:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 7, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(62);
    }
  });

  it.each([
    "from day 2 take 2 tablets the next morning",
    "take 2 tablets the next morning from day 2",
    "take 2 tablets from day 2 next morning"
  ])("retains an authored successor onset after a dated predecessor: %s", successor => {
    const parsed = parseSig("Take 1 tablet daily until November 25, 2026, then " + successor);
    const schedule = parsed.meta.canonical.clauses[1].schedule!;
    expect(schedule).toMatchObject({ treatmentStartOffsetDays: 1, phaseStartReference: "treatment-day-start" });
    expect(schedule.boundsStart).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].schedule?.boundsEnd).toBe("2026-11-25");
    const orderedAt = "2026-11-25T00:00:00Z", from = "2026-11-26T00:00:00Z";
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      const course = importCanonicalCourse(dosage);
      expect(course.stages[1].start).toMatchObject({
        anchor: "treatment-day-start", displacement: { value: 1, unit: "d" }
      });
      expect(nextDueDoses(dosage, { orderedAt, from, timeZone: "UTC", limit: 1 }))
        .toEqual(["2026-11-26T08:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, orderedAt, from, timeZone: "UTC",
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    }
    const derived = parseSig("Take 1 tablet daily until November 25, 2026, then take 2 tablets the next morning");
    expect(derived.meta.canonical.clauses[1].schedule).toMatchObject({ boundsStart: "2026-11-26" });
    expect(derived.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBeUndefined();
  });
});


it("round39: keeps civil and elapsed member origins distinct through public projections", () => {
  const parsed = parseSig("1 drop OD QID for 3 days then stop for 1 day then " +
    "2 drops OD at 08:00 from day 5 and 1 drop OD at 22:00; 3 drops OS daily");
  const cold = JSON.parse(JSON.stringify(parsed.fhir));
  const query = { from: "2026-11-25T00:00:00Z", orderedAt: "2026-11-21T12:00:00Z",
    timeZone: "UTC", limit: 3 };
  for (const dosage of [parsed.meta.canonical.course!, parsed.fhirNext, cold, toDosageDetails(cold)]) {
    const members = importCanonicalCourse(dosage).stages[0].administrations;
    expect(members[1].phaseStart).toMatchObject({
      anchor: "treatment-day-start", displacement: { value: 4, unit: "d" }
    });
    expect(members[1].phaseOrigin).toBeUndefined();
    expect(members[2].phaseOrigin).toMatchObject({ value: 4, unit: "d" });
    expect(members[2].phaseStart).toBeUndefined();
    expect(nextDueDoses(dosage, query)).toEqual([
      "2026-11-25T08:00:00+00:00", "2026-11-25T09:00:00+00:00", "2026-11-25T22:00:00+00:00"
    ]);
    expect(calculateTotalUnits({ ...query, dosage, durationValue: 12, durationUnit: FhirPeriodUnit.Hour })
      .totalUnits).toBe(5);
    expect(nextDueDoses(dosage, { ...query, orderedAt: "2026-11-21T23:00:00Z" })).toEqual([
      "2026-11-25T08:00:00+00:00", "2026-11-25T09:00:00+00:00", "2026-11-26T08:00:00+00:00"
    ]);
    const en = formatSig(dosage, "long", { locale: "en" });
    expect(en).toContain("From day 5 onward: Instill 2 drops at 8:00 am");
    expect(en).toContain("From 4 days after treatment start onward: Instill 1 drop at 10:00 pm");
    const th = formatSig(dosage, "long", { locale: "th" });
    expect(th).toContain("ตั้งแต่วันที่ 5 เป็นต้นไป: หยอดตาขวา ครั้งละ 2 หยด เวลา 08:00");
    expect(th).toContain("ตั้งแต่4 วันหลังเริ่มการรักษาเป็นต้นไป: หยอดตาขวา ครั้งละ 1 หยด เวลา 22:00");
  }
});


it.each(["twice daily", "at 08:00 and 20:00"])(
  "round39: an onset-only successor keeps its complete predecessor cadence: %s", cadence => {
    const parsed = parseSig("Take 1 tablet " + cadence + " for 4 days and 2 tablets from day 5");
    const query = { from: "2024-01-05T00:00:00Z", orderedAt: "2024-01-01T00:00:00Z",
      timeZone: "UTC", limit: 2 };
    expect(parsed.meta.canonical.course!.stages[1].administrations[0].schedule?.recurrence?.courseLength)
      .toBeUndefined();
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2024-01-05T08:00:00+00:00", "2024-01-05T20:00:00+00:00"
      ]);
      const day9 = { ...query, from: "2024-01-09T00:00:00Z" };
      expect(nextDueDoses(dosage, day9)).toEqual([
        "2024-01-09T08:00:00+00:00", "2024-01-09T20:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...day9, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(4);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(4);
    }
  }
);

it("round39: still rejects an explicitly inverted phase window", () => {
  const at = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
  }] }, offsetDuration: { value, code: "d" } });
  const source: FhirR6DosageInstruction = { step: [{ start: at(2), end: at(1), component: [{
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } }
  }] }] };
  const options = { from: "2024-01-01T00:00:00Z", timeZone: "UTC", limit: 1 };
  for (const dosage of [courseFromR6(source), source, JSON.parse(JSON.stringify(toFhirR5Dosages(source)))]) {
    expect(() => nextDueDoses(dosage, options))
      .toThrowError(expect.objectContaining({ code: "invalid-stage-order" }));
    expect(() => calculateTotalUnits({ ...options, dosage, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
      .toThrowError(expect.objectContaining({ code: "invalid-stage-order" }));
  }
});

describe("round40: inherited selectors and finite-use history", () => {
  const origin = "2026-01-01T00:00:00Z";
  const opts = { orderedAt: origin, from: origin, timeZone: "UTC", limit: 4 };
  const representations = (course: FhirR6DosageInstruction) => [
    courseFromR6(course), course, JSON.parse(JSON.stringify(toFhirR5Dosages(course)))
  ];
  const clocked = (clock = "09:00:00"): FhirDosage => ({
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: [clock] } }
  });

  it.each([
    ["on the first Monday of each month", ["2026-02-02", "2026-03-02", "2026-04-06", "2026-05-04"], { weekdayOrdinal: 1 }],
    ["on days 1 and 15 of each month", ["2026-02-01", "2026-02-15", "2026-03-01", "2026-03-15"], { dayOfMonth: [1, 15] }]
  ])("inherits the full calendar selector in an onset-only dose continuation: %s", (selection, dates, selector) => {
    const parsed = parseSig("Take 1 tablet at 09:00 " + selection + ", then from week 5 take 2 tablets",
      { datePolicy: { referenceDate: "2026-01-01" } });
    const before = JSON.stringify(parsed);
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({
      ...selector as object, treatmentStartOffsetDays: 28, timeOfDay: ["09:00:00"]
    });
    expect(parsed.meta.canonical.clauses[1].schedule?.boundsStart).toBeUndefined();
    const expected = (dates as string[]).map(date => date + "T09:00:00+00:00");
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, { ...opts, from: "2026-02-01T00:00:00Z" })).toEqual(expected);
      expect(calculateTotalUnits({ ...opts, from: "2026-02-01T00:00:00Z", dosage,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits)
        .toBe(selection === "on the first Monday of each month" ? 2 : 4);
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ["2026-01-02T12:00:00Z", "2026-01-01", 2],
    ["2026-01-02T08:00:00Z", "2026-01-01", 1],
    ["2026-01-02T08:00:00Z", "2026-01-03", 2]
  ] as const)("counts actual finite-use history only after both calendar and order origins: %s / %s", (orderedAt, calendarStart, remaining) => {
    const scalar = clocked();
    Object.assign(scalar.timing!.repeat!, { count: 2, boundsPeriod: { start: calendarStart } });
    scalar.maxDosePerPeriod = [{ numerator: { value: 1, unit: "tab" },
      denominator: { value: 24, unit: "h", code: "h", system: "http://unitsofmeasure.org" } }];
    const source = toDosageDetails([scalar]), before = JSON.stringify(source);
    const query = { ...opts, orderedAt, from: "2026-01-03T00:00:00Z",
      priorDoseTimes: ["2026-01-02T09:00:00Z"] };
    for (const dosage of [scalar, [scalar], ...representations(source)]) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-01-03T09:00:00+00:00", ...(remaining === 2 ? ["2026-01-04T09:00:00+00:00"] : [])
      ]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 3, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(remaining);
    }
    expect(JSON.stringify(source)).toBe(before);
  });

});

describe("round50: explicit event quota and interval query ownership", () => {
  const quantity = { doseQuantity: { value: 1, unit: "tab" } };
  const origin = "2026-01-01T00:00:00Z";
  const explicitForms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, [row], r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[],
      importCanonicalCourse(r6)];
  };

  it.each([
    ["remaining month", ["2026-11-20T08:00:00Z", "2026-12"], 2,
      "2026-11-01T00:00:00Z", 61, undefined, undefined, ["2026-11-20T08:00:00+00:00"]],
    ["remaining year", ["2026", "2026-11-20T08:00:00Z"], 2,
      "2026-11-01T00:00:00Z", 61, undefined, undefined, ["2026-11-20T08:00:00+00:00"]],
    ["uncapped remaining month", ["2026-11-20T08:00:00Z", "2026-12"], undefined,
      "2026-11-01T00:00:00Z", 61, undefined, undefined, ["2026-11-20T08:00:00+00:00"]],
    ["exact event fills count", ["2026-11-20T08:00:00Z", "2026-12"], 1,
      "2026-11-01T00:00:00Z", 61, undefined, 1, ["2026-11-20T08:00:00+00:00"]],
    ["partial month outside query", ["2026-11-20T08:00:00Z", "2026-12"], 2,
      "2026-11-01T00:00:00Z", 30, undefined, 1, ["2026-11-20T08:00:00+00:00"]],
    ["exact future fills remaining history", ["2026-11", "2026-11-20T08:00:00Z", "2026-11-22T08:00:00Z"], 2,
      "2026-11-21T00:00:00Z", 2, undefined, 1, ["2026-11-22T08:00:00+00:00"]],
    ["explicit count exhausted", ["2026-11-20T08:00:00Z", "2026-12"], 2,
      "2026-11-01T00:00:00Z", 61, 2, 0, []],
  ] as const)("retains exact candidates without hiding an unresolved supply slot: %s",
    (_name, events, count, from, durationValue, priorCount, totalUnits, expectedDue) => {
      const row: FhirDosage = {
        id: "round50-explicit-events",
        extension: [{ url: "urn:round50:note", valueString: "retain event precision" }],
        doseAndRate: [quantity],
        timing: { event: [...events], ...(count === undefined ? {} : { repeat: { count } }) }
      };
      const query = { orderedAt: origin, from, timeZone: "UTC", limit: 3,
        ...(priorCount === undefined ? {} : { priorCount }) };
      for (const dosage of explicitForms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(expectedDue);
        const calculate = () => calculateTotalUnits({ dosage, ...query,
          durationValue, durationUnit: FhirPeriodUnit.Day });
        if (totalUnits === undefined) expect(calculate).toThrowError(
          expect.objectContaining({ code: "timing-required" }));
        else expect(calculate()).toMatchObject({ totalUnits, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
      expect(toDosageDetails([row]).step![0].component[0].timing?.event).toEqual(events);
    });

  it.each([
    [0.5, FhirPeriodUnit.Week], [3.5, FhirPeriodUnit.Day], [84, FhirPeriodUnit.Hour]
  ] as const)("keeps a weekday-filtered %s %s interval on the same elapsed grid", (period, periodUnit) => {
    const row: FhirDosage = { doseAndRate: [quantity], timing: { repeat: {
      frequency: 1, period, periodUnit, dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Thursday]
    } } };
    const query = { orderedAt: origin, from: "2026-01-05T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const dosage of explicitForms(row)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-01-08T00:00:00+00:00", "2026-01-15T00:00:00+00:00", "2026-01-22T00:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...query,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(0);
      expect(calculateTotalUnits({ dosage, ...query, from: "2026-01-08T00:00:00Z",
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(toDosageDetails([row]).step![0].component[0].timing?.repeat).toMatchObject({ period, periodUnit });
  });

  it("retains whole-week selected weekday positions", () => {
    const row: FhirDosage = { doseAndRate: [quantity], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Week,
      dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Thursday]
    } } };
    const query = { orderedAt: origin, from: "2026-01-05T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const dosage of explicitForms(row)) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-01-05T00:00:00+00:00", "2026-01-08T00:00:00+00:00", "2026-01-12T00:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...query,
        durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
    }
  });

  const ranged: FhirDosage = {
    doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
    timing: { event: ["2026-11"], repeat: { count: 2 } },
    maxDosePerPeriod: [{ numerator: { value: 3, unit: "tab" },
      denominator: { value: 24, unit: "h", code: "h", system: "http://unitsofmeasure.org" } }]
  };

  it.each([1, 2])("distinguishes a remaining ranged slot from an exhausted quota: priorCount %s", priorCount => {
    const query = { orderedAt: origin, from: "2026-11-01T00:00:00Z", timeZone: "UTC", priorCount };
    for (const dosage of explicitForms(ranged)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual([]);
      const calculate = () => calculateTotalUnits({ dosage, ...query,
        durationValue: 30, durationUnit: FhirPeriodUnit.Day });
      if (priorCount === 2) expect(calculate()).toMatchObject({ totalUnits: 0, unit: "tab" });
      else expect(calculate).toThrowError(expect.objectContaining({ code: "timing-required" }));
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("exhausts ranged quota from recorded uses before checking unknown event dates", () => {
    const query = { orderedAt: origin, from: "2026-11-03T00:00:00Z", timeZone: "UTC",
      priorDoseTimes: ["2026-11-01T08:00:00Z", "2026-11-02T08:00:00Z"] };
    for (const dosage of explicitForms(ranged)) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...query,
        durationValue: 2, durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: 0, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("retains the scalar exhausted-count zero control", () => {
    const row: FhirDosage = { ...ranged, doseAndRate: [quantity] };
    for (const dosage of explicitForms(row)) expect(calculateTotalUnits({
      dosage, orderedAt: origin, from: "2026-11-01T00:00:00Z", timeZone: "UTC", priorCount: 2,
      durationValue: 30, durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 0, unit: "tab" });
  });


  it.each([
    ["unfilled quota", undefined, undefined],
    ["one remaining accepted dose", 1, 2],
    ["exhausted quota", 2, 0],
  ] as const)("retains the range acceptor's quota when explicit events are partial: %s",
    (_name, priorCount, totalUnits) => {
      const row: FhirDosage = { ...ranged,
        timing: { event: ["2026-11-20T08:00:00Z", "2026-12"], repeat: { count: 2 } } };
      for (const dosage of explicitForms(row)) {
        const before = JSON.stringify(dosage);
        const query = { orderedAt: origin, from: "2026-11-01T00:00:00Z", timeZone: "UTC", priorCount };
        expect(nextDueDoses(dosage, { ...query, limit: 2 })).toEqual(
          priorCount === 2 ? [] : ["2026-11-20T08:00:00+00:00"]);
        const calculate = () => calculateTotalUnits({ dosage, ...query,
          durationValue: 61, durationUnit: FhirPeriodUnit.Day });
        if (totalUnits === undefined) expect(calculate).toThrowError(
          expect.objectContaining({ code: "timing-required" }));
        else expect(calculate()).toMatchObject({ totalUnits, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });


  it.each([undefined, 1, 2])("keeps filtered scalar quota ownership with a partial event: priorCount %s", priorCount => {
    const row: FhirDosage = { ...ranged, doseAndRate: [quantity],
      timing: { event: ["2026-11-20T08:00:00Z", "2026-12"], repeat: { count: 2 } } };
    const query = { orderedAt: origin, from: "2026-11-01T00:00:00Z", timeZone: "UTC", priorCount, limit: 2 };
    for (const dosage of explicitForms(row)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(priorCount === 2 ? [] : ["2026-11-20T08:00:00+00:00"]);
      const calculate = () => calculateTotalUnits({ dosage, ...query,
        durationValue: 61, durationUnit: FhirPeriodUnit.Day });
      if (priorCount === undefined) expect(calculate).toThrowError(expect.objectContaining({ code: "timing-required" }));
      else expect(calculate()).toMatchObject({ totalUnits: priorCount === 1 ? 1 : 0, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("keeps ranged history replay's partial date outside the actual supply query", () => {
    const row: FhirDosage = { ...ranged,
      timing: { event: ["2026-11-20T08:00:00Z", "2026-11"], repeat: { count: 2 } } };
    for (const dosage of explicitForms(row)) expect(calculateTotalUnits({
      dosage, orderedAt: origin, from: "2026-12-01T00:00:00Z", timeZone: "UTC",
      durationValue: 2, durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 0, unit: "tab" });
  });

  it("retains two exact ranged doses that fill the count beside a partial event", () => {
    const row: FhirDosage = { ...ranged, timing: {
      event: ["2026-11-20T08:00:00Z", "2026-12-20T08:00:00Z", "2026-12"], repeat: { count: 2 }
    } };
    for (const dosage of explicitForms(row)) expect(calculateTotalUnits({
      dosage, orderedAt: origin, from: "2026-11-01T00:00:00Z", timeZone: "UTC",
      durationValue: 61, durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 4, unit: "tab" });
  });

  it.each([
    ["unresolved second event", 2, undefined, undefined],
    ["unbounded event list", undefined, undefined, undefined],
    ["exact event fills count", 1, undefined, 1],
    ["caller count exhausted", 2, 2, 0],
  ] as const)("does not truncate a partial event through explicit stage completion: %s",
    (_name, count, priorCount, totalUnits) => {
      const course: FhirR6DosageInstruction = { step: [{
        start: { contextCode: { coding: [{
          system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
        }] }, offsetDuration: { value: 0, code: "d" } },
        component: [{ doseAndRate: [quantity], timing: {
          event: ["2026-11-20T08:00:00Z", "2026-12"],
          ...(count === undefined ? {} : { repeat: { count } })
        } }]
      }] };
      const query = { orderedAt: origin, from: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 2, priorCount };
      for (const dosage of [course, importCanonicalCourse(course),
        JSON.parse(JSON.stringify(toFhirR5Dosages(course))) as FhirDosage[]]) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(priorCount === 2 ? [] : ["2026-11-20T08:00:00+00:00"]);
        const calculate = () => calculateTotalUnits({ dosage, ...query,
          durationValue: 61, durationUnit: FhirPeriodUnit.Day });
        if (totalUnits === undefined) expect(calculate).toThrowError(
          expect.objectContaining({ code: "timing-required" }));
        else expect(calculate()).toMatchObject({ totalUnits, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each([
    ["past month", "2026-11", undefined, "2026-12-01T00:00:00Z", 0],
    ["counted past month", "2026-11", 2, "2026-12-01T00:00:00Z", 0],
    ["counted past year", "2025", 2, "2026-12-01T00:00:00Z", 0],
    ["future month", "2027-01", undefined, "2026-12-01T00:00:00Z", 0],
    ["overlapping month", "2026-11", undefined, "2026-11-01T00:00:00Z", undefined],
    ["counted overlapping month", "2026-11", 2, "2026-11-01T00:00:00Z", undefined],
    ["exact event", "2026-12-02T08:00:00Z", undefined, "2026-12-01T00:00:00Z", 1],
  ] as const)("limits a course timing diagnostic to the actual supply window: %s",
    (_name, event, count, from, totalUnits) => {
      const course: FhirR6DosageInstruction = { step: [{
        start: { contextCode: { coding: [{
          system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
        }] }, offsetDuration: { value: 0, code: "d" } },
        component: [{ doseAndRate: [quantity],
          timing: { event: [event], ...(count === undefined ? {} : { repeat: { count } }) } }]
      }] };
      const query = { orderedAt: "2025-01-01T00:00:00Z", from, timeZone: "UTC", limit: 2 };
      for (const dosage of [course, importCanonicalCourse(course),
        JSON.parse(JSON.stringify(toFhirR5Dosages(course))) as FhirDosage[]]) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(totalUnits === 1 ? ["2026-12-02T08:00:00+00:00"] : []);
        const calculate = () => calculateTotalUnits({ dosage, ...query,
          durationValue: 2, durationUnit: FhirPeriodUnit.Day });
        if (totalUnits === undefined) expect(calculate).toThrowError(
          expect.objectContaining({ code: "timing-required" }));
        else expect(calculate()).toMatchObject({ totalUnits, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
      expect(toDosageDetails(toFhirR5Dosages(course)).step![0].component[0].timing?.event).toEqual([event]);
    });
});

describe("round51 repeated-window ownership and elapsed history", () => {
  const contextCode = { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] };
  const amount = () => ({ doseQuantity: { value: 1, unit: "tab" } });
  const representations = (source: FhirR6DosageInstruction) => [
    source, JSON.parse(JSON.stringify(toFhirR5Dosages(source))) as FhirDosage[], importCanonicalCourse(source),
  ];

  it.each(["elapsed boundary", "civil boundary", "member duration"] as const)(
    "keeps the repeated window owned by its %s", owner => {
      const source: FhirR6DosageInstruction = { step: [{
        count: 3,
        ...(owner === "member duration" ? {} : { end: { contextCode,
          offsetDuration: owner === "elapsed boundary" ? { value: 23, unit: "h" } : { value: 1, unit: "d" } } }),
        component: [{ doseAndRate: [amount()], timing: { repeat: {
          frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:30:00"],
          ...(owner === "civil boundary" ? {} : { boundsDuration: { value: 1, unit: "d" } }),
        } } }],
      }] };
      const original = JSON.stringify(source);
      const query = { orderedAt: "2026-03-07T09:00:00-05:00", from: "2026-03-07T09:00:00-05:00",
        timeZone: "America/New_York", limit: 5, durationValue: 4, durationUnit: FhirPeriodUnit.Day };
      // The explicit 23h windows end Mar8 09:00, Mar9 08:00 and Mar10 07:00.
      // A civil-day boundary or member-owned duration instead ends Mar10 09:00.
      const expected = ["2026-03-08T08:30:00-04:00", "2026-03-09T08:30:00-04:00",
        ...(owner === "elapsed boundary" ? [] : ["2026-03-10T08:30:00-04:00"])];
      for (const dosage of representations(source)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(expected);
        expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({
          totalUnits: owner === "elapsed boundary" ? 2 : 3, unit: "tab",
        });
        expect(JSON.stringify(dosage)).toBe(before);
      }
      expect(JSON.stringify(source)).toBe(original);
    });

  it.each([[0.25, FhirPeriodUnit.Day], [1 / 28, FhirPeriodUnit.Week], [6, FhirPeriodUnit.Hour]] as const)(
    "seeks the remaining occurrence after long %s %s history", (period, periodUnit) => {
      const row: FhirDosage = { doseAndRate: [amount()], timing: { repeat: {
        count: 1093, frequency: 1, period, periodUnit,
      } } };
      const original = JSON.stringify(row);
      const query = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-10-01T00:00:00Z",
        timeZone: "UTC", limit: 2, priorCount: 1092, durationValue: 6, durationUnit: FhirPeriodUnit.Hour };
      // 273 days give 1092 six-hour slots before the query; one authored use remains.
      for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse(row)]) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(["2026-10-01T00:00:00+00:00"]);
        expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: 1, unit: "tab" });
        // Twelve hours also contains 06:00, which the one remaining count must exclude.
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 12 })).toMatchObject({ totalUnits: 1, unit: "tab" });
        expect(nextDueDoses(dosage, { ...query, priorCount: 1093 })).toEqual([]);
        expect(calculateTotalUnits({ dosage, ...query, priorCount: 1093 }).totalUnits).toBe(0);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 12, priorCount: 1093 }).totalUnits).toBe(0);
        expect(JSON.stringify(dosage)).toBe(before);
      }
      expect(JSON.stringify(row)).toBe(original);
    });

  it("retains uncapped elapsed supply after a long fractional-day history", () => {
    const row: FhirDosage = { doseAndRate: [amount()], timing: {
      repeat: { frequency: 1, period: 0.25, periodUnit: FhirPeriodUnit.Day },
    } };
    const original = JSON.stringify(row);
    const query = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-10-01T00:00:00Z",
      timeZone: "UTC", limit: 1, durationValue: 6, durationUnit: FhirPeriodUnit.Hour };
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse(row)]) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(["2026-10-01T00:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: 1, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(JSON.stringify(row)).toBe(original);
  });

  it.each([[1, FhirPeriodUnit.Day], [1 / 7, FhirPeriodUnit.Week]] as const)(
    "keeps normalized whole-civil %s %s clocks through a long history and fall DST", (period, periodUnit) => {
      const row: FhirDosage = { doseAndRate: [amount()], timing: { repeat: {
        frequency: 1, period, periodUnit, timeOfDay: ["08:00:00"],
      } } };
      const original = JSON.stringify(row);
      const query = { orderedAt: "2023-01-01T08:00:00-05:00", from: "2026-10-31T00:00:00-04:00",
        timeZone: "America/New_York", limit: 3, durationValue: 3, durationUnit: FhirPeriodUnit.Day };
      for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse(row)]) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual([
          "2026-10-31T08:00:00-04:00", "2026-11-01T08:00:00-05:00", "2026-11-02T08:00:00-05:00",
        ]);
        expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: 3, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
      expect(JSON.stringify(row)).toBe(original);
    });
});

describe("round52 explicit-event admission and configured clock ownership", () => {
  const contextCode = { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] };
  const amount = () => ({ doseQuantity: { value: 1, unit: "tab" } });
  const boundary = (value: number) => ({ contextCode, offsetDuration: { value, unit: "d" } });
  const forms = (source: FhirR6DosageInstruction) => [
    source, JSON.parse(JSON.stringify(toFhirR5Dosages(source))) as FhirDosage[], importCanonicalCourse(source),
  ];
  const january = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
    timeZone: "UTC", limit: 1, durationValue: 1, durationUnit: FhirPeriodUnit.Day };

  it.each([
    ["one exact dose fills count", 1, "2026-01", 1],
    ["a second slot remains", 2, "2026-01", undefined],
    ["unbounded event list", undefined, "2026-01", undefined],
    ["partial month outside the window", 2, "2026-02", 1],
  ] as const)("checks chronological partial events after admission: %s", (_name, count, partial, totalUnits) => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 2, unit: "d" }, step: [{
      end: boundary(1), component: [{
        doseAndRate: [amount()],
        timing: { event: ["2026-01-01T09:00:00Z", partial], repeat: {
          count, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        } },
        safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 2, unit: "tab" },
          period: { value: 24, unit: "h", code: "h", system: "http://unitsofmeasure.org" } }] },
      }],
    }] };
    for (const dosage of forms(source)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, january)).toEqual(["2026-01-01T09:00:00+00:00"]);
      const calculate = () => calculateTotalUnits({ dosage, ...january });
      if (totalUnits === undefined) expect(calculate).toThrowError(expect.objectContaining({ code: "timing-required" }));
      else expect(calculate()).toMatchObject({ totalUnits, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("lets actual history exhaust a chronological count before partial-date uncertainty", () => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 2, unit: "d" }, step: [{
      end: boundary(1), component: [{
        doseAndRate: [amount()],
        timing: { event: ["2026-01-01T09:00:00Z", "2026-01"], repeat: {
          count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        } },
        safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 2, unit: "tab" },
          period: { value: 24, unit: "h", code: "h", system: "http://unitsofmeasure.org" } }] },
      }],
    }] };
    const query = { ...january, from: "2026-01-01T12:00:00Z", priorDoseTimes: ["2026-01-01T09:00:00Z"],
      durationValue: 12, durationUnit: FhirPeriodUnit.Hour };
    for (const dosage of forms(source)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual([]);
      expect(calculateTotalUnits({ dosage, ...query }).totalUnits).toBe(0);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });


  it("checks chronological uncertainty only within the actual supply horizon", () => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 60, unit: "d" }, step: [{
      end: boundary(45), component: [{
        doseAndRate: [amount()],
        timing: { event: ["2026-01-01T09:00:00Z", "2026-02"], repeat: {
          count: 2, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        } },
        safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 2, unit: "tab" },
          period: { value: 24, unit: "h", code: "h", system: "http://unitsofmeasure.org" } }] },
      }],
    }] };
    for (const dosage of forms(source)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, january)).toEqual(["2026-01-01T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...january })).toMatchObject({ totalUnits: 1, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([
    ["selected plan leaves a third slot", 3, "2026-01", undefined],
    ["selected plan fills both slots", 2, "2026-01", 4],
    ["no unresolved event", 3, undefined, 4],
    ["unresolved month outside the query", 3, "2026-02", 4],
  ] as const)("uses selected ranged counts for uncertainty: %s", (_name, count, partial, totalUnits) => {
    const row: FhirDosage = {
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
      timing: { repeat: { count }, event: [
        "2026-01-01T08:00:00Z", "2026-01-02T08:00:00Z", "2026-01-03T08:00:00Z", ...(partial ? [partial] : []),
      ] },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" },
        denominator: { value: 36, unit: "h", code: "h", system: "http://unitsofmeasure.org" } }],
    };
    const query = { ...january, limit: 3, durationValue: 5 };
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse(row)]) {
      const before = JSON.stringify(dosage);
      // Scheduling can admit one tablet on each exact day. Maximizing supply
      // instead chooses two tablets on Jan1/3, leaving a third count unresolved.
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
        ...(count === 3 ? ["2026-01-03T08:00:00+00:00"] : []),
      ]);
      const calculate = () => calculateTotalUnits({ dosage, ...query });
      if (totalUnits === undefined) expect(calculate).toThrowError(expect.objectContaining({ code: "timing-required" }));
      else expect(calculate()).toMatchObject({ totalUnits, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each(["09:00", "09:00:00.125"])("retains configured frequency-clock precision: %s", clock => {
    const row: FhirDosage = { doseAndRate: [amount()], timing: { repeat: {
      frequency: 2, period: 2, periodUnit: FhirPeriodUnit.Day,
    } } };
    const fraction = clock.includes(".125") ? ".125" : "";
    const query = { orderedAt: "2026-01-01T00:00:00.500Z", from: "2026-01-01T00:00:00Z",
      timeZone: "UTC", limit: 2, frequencyDefaults: { byFrequency: { "freq:2/per:2d": [clock] } },
      durationValue: 32400.25, durationUnit: FhirPeriodUnit.Second };
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse(row)]) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-01-01T09:00:00" + fraction + "+00:00", "2026-01-02T09:00:00" + fraction + "+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: 1, unit: "tab" });
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 32400.062 }))
        .toMatchObject({ totalUnits: clock === "09:00" ? 1 : 0, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("retains built-in and clockless fractions while an authored clock keeps its own fraction", () => {
    const query = { orderedAt: "2026-01-01T00:00:00.500Z", from: "2026-01-01T00:00:00Z",
      timeZone: "UTC", limit: 2, durationValue: 32400.25, durationUnit: FhirPeriodUnit.Second };
    for (const [frequency, period, clocks, expected] of [
      [2, 2, undefined, ["2026-01-01T08:00:00.500+00:00", "2026-01-02T20:00:00.500+00:00"]],
      [42, 21, undefined, ["2026-01-01T00:00:00.500+00:00", "2026-01-01T12:00:00.500+00:00"]],
      [2, 2, ["09:00:00.125"], ["2026-01-01T09:00:00.125+00:00", "2026-01-02T09:00:00.125+00:00"]],
    ] as const) {
      const row: FhirDosage = { doseAndRate: [amount()], timing: { repeat: {
        frequency, period, periodUnit: FhirPeriodUnit.Day, ...(clocks ? { timeOfDay: [...clocks] } : {}),
      } } };
      for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse(row)]) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(expected);
        expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: 1, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    }
  });

  it.each([false, true])("retains repeated-stage elapsed versus authored civil span across fall DST: explicit start %s", explicitStart => {
    const component = () => ({ doseAndRate: [amount()], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["12:30:00"],
    } } });
    const source: FhirR6DosageInstruction = { step: [
      { end: boundary(1), component: [component()] },
      { ...(explicitStart ? { start: boundary(1) } : {}), end: boundary(2), count: 2, component: [component()] },
      { start: boundary(4), end: boundary(5), component: [component()] },
    ] };
    const query = { orderedAt: "2026-10-30T12:00:00-04:00", from: "2026-10-30T12:00:00-04:00",
      timeZone: "America/New_York", limit: 10, durationValue: 5, durationUnit: FhirPeriodUnit.Day };
    for (const dosage of forms(source)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-10-30T12:30:00-04:00", "2026-10-31T12:30:00-04:00", "2026-11-01T12:30:00-05:00",
        ...(!explicitStart ? ["2026-11-02T12:30:00-05:00"] : []), "2026-11-03T12:30:00-05:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: explicitStart ? 4 : 5, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });
});


describe("round63: recorded caps, combined ceilings and finite calendar successors", () => {
  const versions = (row: FhirDosage) => [row, toDosageDetails([row]), importCanonicalCourse(row)];
  const from = "2026-01-01T08:00:00Z";

  it.each([false, true])("fills the 28-day clocked range with recorded history=%s", recorded => {
    const row: FhirDosage = {
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
      maxDosePerPeriod: [{ numerator: { value: 4, unit: "tab" }, denominator: { value: 24, unit: "h" } }],
    };
    for (const dosage of versions(row)) {
      const total = calculateTotalUnits({ dosage, from, orderedAt: from, timeZone: "UTC",
        durationValue: 28, durationUnit: FhirPeriodUnit.Day,
        ...(recorded ? { priorDoseTimes: ["2026-01-01T07:00:00Z"] } : {}) });
      expect(total).toMatchObject({ totalUnits: recorded ? 110 : 112, unit: "tab" });
    }
  });

  it.each([false, true])("rounds two lifetime-capped members only within their combined allowance; uncapped=%s", uncapped => {
    const rows: FhirDosage[] = ["08:00:00", "20:00:00"].map((clock, index) => ({
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: [clock] } },
      ...(!uncapped || index === 0 ? { maxDosePerLifetime: { value: 3, unit: "tab" } } : {}),
    }));
    for (const dosage of [rows, toDosageDetails(rows), importCanonicalCourse(rows)])
      expect(calculateTotalUnits({ dosage, from, orderedAt: from, timeZone: "UTC",
        durationValue: 7, durationUnit: FhirPeriodUnit.Day, roundToMultiple: 5 }))
        .toMatchObject({ totalUnits: uncapped ? 10 : 6, unit: "tab" });
  });

  it.each([
    ["repeated", false, false, false, 6],
    ["mixed units", true, false, false, 6],
    ["recorded", false, true, false, 4],
    ["future uncapped member", false, false, true, 6],
  ] as const)("counts each contributing lifetime allowance once: %s", (_label, mixed, recorded, future, expected) => {
    const source: FhirR6DosageInstruction = { step: [{ count: 3,
      component: ["08:00:00", "20:00:00"].map((clock, index) => ({
        doseAndRate: [{ doseQuantity: { value: mixed && index === 1 ? 1000 : 1, unit: mixed ? index === 1 ? "mg" : "g" : "tab" } }],
        safety: { doseLimit: [{ scope: "lifetime" as const, valueQuantity: {
          value: mixed && index === 1 ? 3000 : 3, unit: mixed ? index === 1 ? "mg" : "g" : "tab" } }] },
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: [clock], boundsDuration: { value: 2, unit: "d" } } },
      })) }] };
    if (future) source.step!.push({ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsPeriod: { start: "2026-02-01" } } } }] });
    for (const dosage of [source, importCanonicalCourse(source), JSON.parse(JSON.stringify(toFhirR5Dosages(source)))])
      expect(calculateTotalUnits({ dosage, from, orderedAt: from, timeZone: "UTC",
        durationValue: 7, durationUnit: FhirPeriodUnit.Day, roundToMultiple: 5,
        ...(recorded ? { priorDoseTimes: ["2025-12-31T08:00:00Z"] } : {}) }))
        .toMatchObject({ totalUnits: expected, unit: mixed ? "g" : "tab" });
  });

  it.each([
    ["one fixed stage", false, true, false, "once", 4, 4],
    ["uncapped fixed repetition", false, false, false, "repeated", 4, 5],
    ["capped fixed repetition", false, true, false, "repeated", 4, 4],
    ["mixed-unit fixed repetition", true, true, false, "repeated", 4, 4],
    ["fixed course cycles", false, true, false, "cycles", 4, 4],
    ["selected uncapped member", false, false, true, "repeated", 1, 5],
    ["independent capped members", false, true, false, "independent", 4, 4],
    ["independent uncapped member", false, false, false, "independent", 4, 5],
    ["uncapped coupled alternative", false, false, false, "phased", 3, 3],
    ["capped coupled alternative", false, true, false, "phased", 3, 3],
    ["mixed-unit coupled alternative", true, true, false, "phased", 3, 3],
  ] as const)("keeps independent clock maxima and selected rounding ceilings: %s", (_label, mixed, capped, upperWins, mode, unrounded, rounded) => {
    const unit = mixed ? "g" : "tab", otherUnit = mixed ? "mg" : "tab", otherAmount = mixed ? 1000 : 1;
    const source: FhirR6DosageInstruction = { step: [{ count: mode === "repeated" ? 2 : undefined,
      end: { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
        offsetDuration: { value: mode === "independent" ? 2 : 1, unit: "d" } },
      component: [
        { doseAndRate: [{ doseQuantity: { value: 3, unit } }],
          timing: { repeat: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: [upperWins ? "20:00:00" : "14:00:00"] } },
          safety: { doseLimit: [
            { scope: "lifetime", valueQuantity: { value: 3, unit } },
            { scope: "period", valueQuantity: { value: 3, unit }, period: { value: 24, unit: "h" } },
          ] } },
        { doseAndRate: [{ doseQuantity: { value: otherAmount, unit: otherUnit } }],
          timing: { repeat: { frequency: 1, frequencyMax: 3, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["20:00:00"] } },
          safety: { doseLimit: [
            { scope: "period", valueQuantity: { value: 100 * otherAmount, unit: otherUnit }, period: { value: 24, unit: "h" } },
            ...(capped ? [{ scope: "lifetime" as const, valueQuantity: { value: otherAmount, unit: otherUnit } }] : []),
          ] } },
      ] }] };
    if (mode === "phased") {
      // B starts only after A's one administration: A at 14:00 and B's
      // unchanged 14:00 clock cannot coexist. The whole-plan maximum is 3.
      const components = source.step![0].component!;
      components[0].timing!.repeat!.count = 1;
      components[1].timing!.repeat!.frequencyMax = undefined;
      components[1].timing!.repeat!.timeOfDay = ["14:00:00"];
      source.step = components.map(component => ({ component: [component] }));
    }
    if (mode === "independent" || mode === "phased" || mode === "cycles") {
      source.repeatCycle = { value: 1, unit: "d" };
      source.modifierExtension = [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: mode === "cycles" ? 2 : 1 }];
    }
    // Fixed parallel windows can combine A's authored 14:00 dose of 3 with
    // B's inferred 14:00 dose of 1. In the capped cases, their summed
    // lifetime allowances prove 4 optimal.
    const query = { from: "2026-01-01T13:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC",
      durationValue: 2, durationUnit: FhirPeriodUnit.Hour };
    const outputUnit = mixed && mode === "repeated" ? "mg" : unit;
    const scale = outputUnit === "mg" ? 1000 : 1;
    for (const dosage of [source, importCanonicalCourse(source), JSON.parse(JSON.stringify(toFhirR5Dosages(source)))]) {
      expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: unrounded * scale, unit: outputUnit });
      expect(calculateTotalUnits({ dosage, ...query, roundToMultiple: 5 * scale }))
        .toMatchObject({ totalUnits: rounded * scale, unit: outputUnit });
    }
  });

  it.each([1, 2])("finds a clocked annual recurrence with result limit %s", limit => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Year, timeOfDay: ["09:00:00"] } } };
    for (const dosage of versions(row))
      expect(nextDueDoses(dosage, { from: "2028-01-01T10:00:00Z",
        orderedAt: "2028-01-01T09:00:00Z", timeZone: "UTC", limit }))
        .toEqual(["2029-01-01T09:00:00+00:00", "2030-01-01T09:00:00+00:00"].slice(0, limit));
  });

  it("keeps an anchored 12-hour loading phase as the predecessor of the right-eye taper", () => {
    const parsed = parseSig("1 drop OD q2h starting 5 December 2026 for 12 hours then 2 drops OD QID; 1 drop OS BID");
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      const course = importCanonicalCourse(dosage);
      const members = course.stages.flatMap(stage => stage.administrations);
      expect(members.map(member => [member.amounts?.[0]?.quantity?.value,
        member.amounts?.[0]?.quantity?.unit, member.target?.coding?.[0]?.code])).toEqual([
          [1, "drop", "1290032005"], [2, "drop", "1290032005"], [1, "drop", "1290031003"],
        ]);
      expect(members[1].phasePredecessors).toEqual([0]);
      expect(members[1].phaseStart?.anchor).not.toBe("unresolved");
      const query = { from: "2026-12-05T00:00:00Z", orderedAt: "2026-12-05T00:00:00Z",
        timeZone: "UTC", limit: 20 };
      expect(nextDueDoses(dosage, query).filter(stamp => stamp.startsWith("2026-12-05"))).toEqual(
        ["00", "02", "04", "06", "08", "08", "10", "12", "16", "20", "20"]
          .map(hour => "2026-12-05T" + hour + ":00:00+00:00"));

      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 14, unit: "drop" });
    }
  });
});

describe("round65 execution admissions and phase records", () => {
  it.each([120, -120])("applies delayed exclusions at actual administration time (%s minutes)", delayMinutes => {
    for (const excluded of ["date", "weekday", "none"] as const) {
      const native = structuredClone(importCanonicalCourse(dailyDose({
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: [delayMinutes > 0 ? "23:00:00" : "01:00:00"] } }
      })));
      const member = native.stages[0].administrations[0];
      member.delayMinutes = delayMinutes;
      const date = delayMinutes > 0 ? "2026-01-02" : "2026-01-01";
      if (excluded === "date") member.excludedDates = [date];
      if (excluded === "weekday") member.excludedWeekdays = [delayMinutes > 0 ? "fri" : "thu"];
      const from = date + (delayMinutes > 0 ? "T00:00:00Z" : "T22:00:00Z");
      const expected = date + (delayMinutes > 0 ? "T01:00:00+00:00" : "T23:00:00+00:00");
      const r6 = courseToR6(native);
      for (const dosage of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
        const options = { orderedAt: "2026-01-01T00:00:00Z", from, timeZone: "UTC", limit: 1 };
        const due = nextDueDoses(dosage, options);
        const resumed = delayMinutes > 0 ? "2026-01-03T01:00:00+00:00" : "2026-01-02T23:00:00+00:00";
        expect(due).toEqual([excluded === "none" ? expected : resumed]);
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 2, durationUnit: FhirPeriodUnit.Hour }))
          .toMatchObject({ totalUnits: excluded === "none" ? 1 : 0, unit: "tab" });
      }
    }
  });

  it.each([
    [undefined, "08"],
    ["2026-01-02T09:00:00Z", "08"],
    ["2026-01-02T00:00:00Z", "08"],
    ["2026-01-01T09:00:00Z", "09"],
  ] as const)("uses only records inside the loading phase for its completion: %s", (record, hour) => {
    const one = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const source: FhirR6DosageInstruction = { step: [
      { component: [{ ...one, timing: { repeat: { count: 1, frequency: 1, period: 1,
          periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"],
          boundsDuration: { value: 1, unit: "d" } } } }] },
      { component: [{ ...one, timing: { repeat: { frequency: 1, period: 24, periodUnit: FhirPeriodUnit.Hour } } }] },
    ] };
    for (const dosage of [source, importCanonicalCourse(source), JSON.parse(JSON.stringify(toFhirR5Dosages(source)))]) {
      const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-03T00:00:00Z",
        timeZone: "UTC", limit: 1, priorDoseTimes: record ? [record] : undefined };
      expect(nextDueDoses(dosage, options)).toEqual(["2026-01-03T" + hour + ":00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...options, from: "2026-01-03T08:00:00Z",
        durationValue: 1, durationUnit: FhirPeriodUnit.Hour }))
        .toMatchObject({ totalUnits: hour === "08" ? 1 : 0, unit: "tab" });
    }
  });
});

describe("round65 explicit dated track transitions", () => {
  it("keeps the authored dated taper before a relative stage-start clock", () => {
    const parsed = parseSig("Instill 1 drop OD QID for 2 days, then instill 2 drops OD on 2026-12-05 at 08:00; instill 1 drop OS BID");
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      const members = importCanonicalCourse(dosage).stages.flatMap(stage => stage.administrations);
      expect(members.find(member => member.amounts?.[0]?.quantity?.value === 2)?.target?.coding?.[0]?.code)
        .toBe("1290032005");
      const options = { orderedAt: "2026-12-03T12:00:00Z", from: "2026-12-05T00:00:00Z",
        timeZone: "UTC", limit: 5 };
      expect(nextDueDoses(dosage, options).filter(stamp => stamp.startsWith("2026-12-05")))
        .toEqual(["2026-12-05T08:00:00+00:00", "2026-12-05T08:00:00+00:00", "2026-12-05T20:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 4, unit: "drop" });
    }
  });

  it("executes a count-only successor once after a dated point completion", () => {
    const r6 = parseSig("1 drop OD on 2026-12-05 at 08:00, then 2 drops OD once").fhirNext;
    for (const dosage of [r6, importCanonicalCourse(r6), JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-05T00:00:00Z",
        timeZone: "UTC", limit: 4 };
      expect(nextDueDoses(dosage, options))
        .toEqual(["2026-12-05T08:00:00+00:00", "2026-12-05T08:00:00.001+00:00"]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 3, unit: "drop" });
      expect(nextDueDoses(dosage, { ...options, from: "2026-12-06T00:00:00Z" })).toEqual([]);
    }
  });

  it("links a count-only successor to its finite explicit dated predecessor", () => {
    const parsed = parseSig("1 drop OD on 2026-12-05 at 08:00, then 2 drops OD once; 1 drop OS BID");
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      const members = importCanonicalCourse(dosage).stages.flatMap(stage => stage.administrations);
      expect(members[1].phasePredecessors).toEqual([0]);
      expect(members[1].target?.coding?.[0]?.code).toBe("1290032005");
      expect(members[1].amounts?.[0]?.quantity).toMatchObject({ value: 2, unit: "drop" });
      const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-05T00:00:00Z",
        timeZone: "UTC", limit: 6 };
      expect(nextDueDoses(dosage, options).filter(stamp => stamp.startsWith("2026-12-05"))).toEqual([
        "2026-12-05T08:00:00+00:00", "2026-12-05T08:00:00+00:00",
        "2026-12-05T08:00:00.001+00:00", "2026-12-05T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 5, unit: "drop" });
    }
  });
});


describe("round65 dated terminal treatment pauses", () => {
  it.each([
    "Starting 2026-12-01, take 1 tablet daily for 7 days, then stop for 2 days, then take 2 tablets daily",
    "Take 1 tablet daily starting 2026-12-01 for 7 days, then stop for 2 days, then take 2 tablets daily"
  ])("resumes from the authored course end: %s", source => {
    const r6 = parseSig(source).fhirNext;
    expect(r6.step.flatMap(step => step.component).map(member => member.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 2]);
    expect(r6.step[1].component[0].timing?.repeat?.boundsPeriod?.start).toBe("2026-12-10");
    const expected = [1, 2, 3, 4, 5, 6, 7, 10, 11]
      .map(day => `2026-12-${String(day).padStart(2, "0")}T09:00:00+00:00`);
    for (const dosage of [r6, importCanonicalCourse(r6), JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      for (const orderedAt of ["2026-11-28T00:00:00Z", "2026-12-01T00:00:00Z"]) {
        expect(nextDueDoses(dosage, { orderedAt, from: "2026-11-28T00:00:00Z", timeZone: "UTC", limit: 9 }))
          .toEqual(expected);
        expect(calculateTotalUnits({ dosage, orderedAt, from: "2026-12-08T00:00:00Z",
          timeZone: "UTC", durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: 0 });
        expect(calculateTotalUnits({ dosage, orderedAt, from: "2026-12-10T00:00:00Z",
          timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
          .toMatchObject({ totalUnits: 2, unit: "tab" });
      }
    }
  });
});


describe("round65 dated pauses before an unclocked successor", () => {
  it.each([
    ["Starting 2026-12-01, take 1 tablet daily for 7 days", false],
    ["Starting 2026-12-01, take 1 tablet daily for 7 days", true],
    ["Take 1 tablet daily starting 2026-12-01 for 7 days", false],
    ["Take 1 tablet daily starting 2026-12-01 for 7 days", true],
  ] as const)("keeps the pause without adding recurrence: %s (PRN %s)", (first, prn) => {
    const parsed = parseSig(first + ", then stop for 2 days, then take 2 tablets" +
      (prn ? " as needed for pain" : ""));
    const schedule = parsed.meta.canonical.clauses[1].schedule;
    expect(schedule?.boundsStart).toBe("2026-12-10");
    expect(schedule?.frequency).toBeUndefined();
    expect(schedule?.period).toBeUndefined();
    expect(schedule?.count).toBeUndefined();
    const r6 = parsed.fhirNext;
    for (const dosage of [r6, importCanonicalCourse(r6), JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const current = importCanonicalCourse(dosage).stages[1].administrations[0];
      expect(current.schedule?.recurrence?.calendarWindow?.start).toBe("2026-12-10");
      expect(current.schedule?.recurrence?.frequency).toBeUndefined();
      expect(Boolean(current.asNeeded)).toBe(prn);
      for (const orderedAt of ["2026-11-28T00:00:00Z", "2026-12-01T00:00:00Z"]) {
        const options = { orderedAt, from: "2026-12-08T00:00:00Z", timeZone: "UTC" };
        expect(nextDueDoses(dosage, { ...options, limit: 3 })).toEqual([]);
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(0);
        expect(() => calculateTotalUnits({ dosage, ...options, from: "2026-12-10T00:00:00Z",
          durationValue: 1, durationUnit: FhirPeriodUnit.Day })).toThrow(expect.objectContaining({ code: "timing-required" }));
      }
    }
  });
});



describe("round66 actual member boundaries", () => {
  it.each([
    [120, "23:00:00", ["2026-12-02T01:00:00+00:00", "2026-12-03T01:00:00+00:00", "2026-12-03T02:00:00+00:00"]],
    [-120, "01:00:00", ["2026-11-30T23:00:00+00:00", "2026-12-01T23:00:00+00:00", "2026-12-02T22:00:00+00:00"]],
  ] as const)("preserves displaced calendar doses before an ordinary successor (%s)", (delay, clock, expected) => {
    const source: FhirR6DosageInstruction = { step: [
      { component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: [clock],
        boundsPeriod: { start: "2026-12-01", end: "2026-12-02" },
      } } }] },
      { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }], timing: { repeat: { count: 1 } } }] },
    ] };
    const native = JSON.parse(JSON.stringify(importCanonicalCourse(source))) as ReturnType<typeof importCanonicalCourse>;
    native.stages[0].administrations[0].delayMinutes = delay;
    const r6 = courseToR6(native);
    const options = { orderedAt: "2026-11-30T00:00:00Z", from: "2026-11-30T00:00:00Z", timeZone: "UTC", limit: 5 };
    expect(nextDueDoses(native.stages[0].administrations[0], options)).toEqual(expected.slice(0, 2));
    for (const dosage of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(nextDueDoses(dosage, options)).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 4, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 4, unit: "tab" });
    }
    expect(r6.step[0].component[0].timing?.repeat?.boundsPeriod)
      .toEqual({ start: "2026-12-01", end: "2026-12-02" });
  });

  it.each([
    [120, "01:00:00", "03:00:00", ["2026-12-01T01:00:00+00:00", "2026-12-02T01:00:00+00:00", "2026-12-03T01:00:00+00:00", "2026-12-03T05:00:00+00:00", "2026-12-04T05:00:00+00:00"], 7],
    [-120, "23:00:00", "01:00:00", ["2026-12-01T23:00:00+00:00", "2026-12-02T23:00:00+00:00", "2026-12-03T23:00:00+00:00"], 5],
  ] as const)("ends an open predecessor at the dated successor's actual onset (%s)", (delay, firstClock, nextClock, expected, units) => {
    const source: FhirR6DosageInstruction = { step: [
      { component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: [firstClock],
      } } }] },
      { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: [nextClock], count: 2,
        boundsPeriod: { start: "2026-12-03" },
      } } }] },
    ] };
    const native = JSON.parse(JSON.stringify(importCanonicalCourse(source))) as ReturnType<typeof importCanonicalCourse>;
    native.stages[1].administrations[0].delayMinutes = delay;
    const r6 = courseToR6(native);
    const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 8 };
    for (const dosage of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(nextDueDoses(dosage, options)).toEqual(expected);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: units, unit: "tab" });
    }
    expect(native.stages[0].administrations[0].schedule?.recurrence?.calendarWindow?.end).toBeUndefined();
  });

  it("counts displaced administrations and records from the actual member start", () => {
    const source: FhirR6DosageInstruction = { step: [
      { component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["01:00:00"], count: 2,
        boundsPeriod: { start: "2026-12-01" },
      } } }] },
      { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }], timing: { repeat: { count: 1 } } }] },
    ] };
    const native = JSON.parse(JSON.stringify(importCanonicalCourse(source))) as ReturnType<typeof importCanonicalCourse>;
    native.stages[0].administrations[0].delayMinutes = -120;
    const r6 = courseToR6(native);
    const options = { orderedAt: "2026-11-30T00:00:00Z", from: "2026-11-30T00:00:00Z", timeZone: "UTC", limit: 5 };
    for (const dosage of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(nextDueDoses(dosage, options)).toEqual([
        "2026-11-30T23:00:00+00:00", "2026-12-01T23:00:00+00:00", "2026-12-01T23:00:00.001+00:00",
      ]);
      const recorded = { ...options, from: "2026-12-01T00:00:00Z", priorDoseTimes: ["2026-11-30T23:00:00Z"] };
      expect(nextDueDoses(dosage, recorded)).toEqual([
        "2026-12-01T23:00:00+00:00", "2026-12-01T23:00:00.001+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...recorded, durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 3, unit: "tab" });
    }
  });

  it("resolves a civil month before applying the member displacement", () => {
    const source: FhirR6DosageInstruction = { step: [
      { component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["23:00:00"],
        boundsDuration: { value: 1, unit: "mo" },
      } } }] },
      { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }], timing: { repeat: { count: 1 } } }] },
    ] };
    const native = JSON.parse(JSON.stringify(importCanonicalCourse(source))) as ReturnType<typeof importCanonicalCourse>;
    native.stages[0].administrations[0].delayMinutes = 120;
    const r6 = courseToR6(native);
    const options = { orderedAt: "2026-01-30T23:00:00Z", from: "2026-01-30T23:00:00Z", timeZone: "UTC", limit: 40 };
    const predecessor = ["2026-01-31T01:00:00+00:00", ...Array.from({ length: 28 }, (_, index) =>
      `2026-02-${String(index + 1).padStart(2, "0")}T01:00:00+00:00`)];
    expect(nextDueDoses(native.stages[0].administrations[0], options)).toEqual(predecessor);
    for (const dosage of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(nextDueDoses(dosage, options)).toEqual([...predecessor, "2026-03-01T01:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 32, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 31, unit: "tab" });
    }
  });
});


describe("round66 reviewed execution families", () => {
  const versions = (row: FhirDosage) => {
    const native = importCanonicalCourse(row), r6 = courseToR6(native);
    return [row, native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))];
  };

  it("requires the retained predecessor of a freshly saved standalone dosage", () => {
    const parsed = parseSig("1 drop OD stat then 2 drops OD daily at 10:00; 1 drop OS BID");
    const row: FhirDosage = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)[1]));
    row.modifierExtension = row.modifierExtension?.filter(item => item.url !== DOSAGE_DETAILS_R5_URL);
    const member = importCanonicalCourse(row).stages[0].administrations[0];
    expect(member.phasePredecessors).toEqual([0]);
    expect(member.phaseStart).toBeUndefined();
    const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 2 };
    for (const dosage of [row, member]) {
      const before = JSON.stringify(dosage);
      expect(() => nextDueDoses(dosage, options)).toThrow(/predecessor is missing/);
      expect(() => calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toThrow(/predecessor is missing/);
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(nextDueDoses(parsed, { ...options, limit: 4 })).toEqual([
      "2026-01-01T00:00:00+00:00", "2026-01-01T08:00:00+00:00",
      "2026-01-01T10:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
  });

  it.each([[2 / 7, FhirPeriodUnit.Week, 13], [2, FhirPeriodUnit.Day, 13],
    [1, FhirPeriodUnit.Week, 6]] as const)("keeps the selected weekday on its %s %s grid", (period, periodUnit, firstDay) => {
    const row = dailyDose({ timing: { repeat: { frequency: 1, period, periodUnit,
      dayOfWeek: [FhirDayOfWeek.Tuesday] } } });
    const options = { orderedAt: "2026-01-01T09:00:00Z", from: "2026-01-06T00:00:00Z", timeZone: "UTC", limit: 1 };
    for (const dosage of versions(row)) {
      expect(nextDueDoses(dosage, options)).toEqual([`2026-01-${String(firstDay).padStart(2, "0")}T09:00:00+00:00`]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits)
        .toBe(firstDay === 6 ? 1 : 0);
    }
  });

  it.each([["", 4], [" for 2 days", 3]] as const)("ends a mixed calendar phase while retaining member duration: %s", (duration, priorTotal) => {
    const parsed = parseSig("1 drop OD daily at 08:00" + duration + " and 1 drop OD daily at 20:00 starting 2026-12-01, then 2 drops OD daily starting 2026-12-05; 1 drop OS BID");
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 3 };
      expect(nextDueDoses(dosage, options)).toEqual([
        "2026-12-05T08:00:00+00:00", "2026-12-05T09:00:00+00:00", "2026-12-05T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 4, unit: "drop" });
      expect(calculateTotalUnits({ dosage, ...options, from: "2026-12-04T00:00:00Z",
        durationValue: 1, durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: priorTotal, unit: "drop" });
    }
  });

  it.each(["", " through 2026-12-20"])("keeps a terminal pause before an end-bounded successor: %s", end => {
    const parsed = parseSig("Take 1 tablet daily starting 2026-12-01 for 7 days, stop for 2 days, then take 2 tablets daily at 08:00" + end);
    const bounds = parsed.fhirNext.step[1].component[0].timing?.repeat?.boundsPeriod;
    expect(bounds?.start).toBe("2026-12-10");
    expect(bounds?.end).toBe(end ? "2026-12-20" : undefined);
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-08T00:00:00Z", timeZone: "UTC", limit: 2 };
      expect(nextDueDoses(dosage, options)).toEqual(["2026-12-10T08:00:00+00:00", "2026-12-11T08:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(0);
      if (end) expect(nextDueDoses(dosage, { ...options, from: "2026-12-21T00:00:00Z" })).toEqual([]);
    }
  });

  it.each([undefined, "12:30"])("keeps noon alongside fixed clocks (override %s)", noon => {
    const row = parseSig("Take half a tablet at 07:00, noon and 19:00 for 7 days").fhir[0];
    expect(row.timing?.repeat?.when).toEqual([EventTiming.Noon]);
    expect(row.timing?.repeat?.timeOfDay).toBeUndefined();
    expect(getTimingClocks(row.timing?.repeat)).toEqual(["07:00:00", "19:00:00"]);
    const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC",
      eventClock: noon ? { NOON: noon } : undefined, limit: 3 };
    for (const dosage of versions(row)) {
      expect(nextDueDoses(dosage, options)).toEqual(["2026-01-01T07:00:00+00:00",
        `2026-01-01T${noon ?? "12:00"}:00+00:00`, "2026-01-01T19:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 1.5, unit: "tab" });
    }
  });

  it.each([true, false])("preserves supply classification when weight is absent (PRN %s)", prn => {
    const row = dailyDose({ asNeeded: prn,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "mg/kg" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["09:00:00"] } } });
    for (const dosage of versions(row)) {
      const result = calculateTotalUnits({ dosage, orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
        timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day });
      expect(result).toMatchObject({ totalUnits: 1, unit: "mg/kg", quantityKind: prn ? "maximum" : "scheduled" });
      if (prn) {
        expect(result.explanation).toContain("patientWeightKg");
        expect(result.explanation).toMatch(/as.needed|PRN/i);
      }
    }
  });
});


describe("round67 weight-resolved dose maxima", () => {
  const quantity = (value: number, unit = "mg/kg") => ({ value, unit,
    system: "http://unitsofmeasure.org", code: unit });
  const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
    timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day };
  const formats = (row: FhirDosage) => {
    const native = importCanonicalCourse(row), r6 = courseToR6(native);
    return [row, native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))];
  };
  it.each(["period", "administration", "lifetime"] as const)(
    "resolves the %s maximum in the same weight dimension as its dose range", scope => {
      const cap = scope === "administration" ? 1.5 : 3;
      const row: FhirDosage = { asNeeded: true,
        doseAndRate: [{ doseRange: { low: quantity(1), high: quantity(2) } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["09:00:00", "21:00:00"] } },
        ...(scope === "period" ? { maxDosePerPeriod: [{ numerator: quantity(cap), denominator: quantity(1, "d") }] }
          : scope === "administration" ? { maxDosePerAdministration: quantity(cap) }
          : { maxDosePerLifetime: quantity(cap) }) };
      for (const dosage of formats(row)) {
        const before = JSON.stringify(dosage);
        expect(calculateTotalUnits({ dosage, ...options })).toMatchObject({ totalUnits: 3, unit: "mg/kg", quantityKind: "maximum" });
        const resolved = calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 });
        expect(resolved).toMatchObject({ totalUnits: 210, unit: "mg", quantityKind: "maximum" });
        expect(resolved.explanation).not.toContain("unevaluable maximum-dose");
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it("uses a weight-resolved administration maximum to close an open dose range", () => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: { low: quantity(1) } }],
      timing: { repeat: { count: 1, timeOfDay: ["09:00:00"] } }, maxDosePerAdministration: quantity(2) };
    for (const dosage of formats(row))
      expect(calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 }))
        .toMatchObject({ totalUnits: 140, unit: "mg", quantityKind: "maximum" });
  });

  it("applies the same patient weight to a relative maximum beside an absolute dose", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: quantity(100, "mg") }],
      timing: { repeat: { frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerPeriod: [{ numerator: quantity(3), denominator: quantity(1, "d") }] };
    for (const dosage of formats(row))
      expect(calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 }))
        .toMatchObject({ totalUnits: 200, unit: "mg" });
  });

  it("retains weighted period caps while a counted phase completes before its successor", () => {
    const first = importCanonicalCourse({ asNeeded: true,
      doseAndRate: [{ doseRange: { low: quantity(1), high: quantity(2) } }],
      timing: { repeat: { count: 2, frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["09:00:00", "21:00:00"] } },
      maxDosePerPeriod: [{ numerator: quantity(3), denominator: quantity(1, "d") }],
    }).stages[0];
    const second = importCanonicalCourse({ doseAndRate: [{ doseQuantity: quantity(5, "mg") }],
      timing: { repeat: { count: 1, timeOfDay: ["09:00:00"] } } }).stages[0];
    const native = { kind: "course" as const, stages: [first, second] }, r6 = courseToR6(native);
    for (const dosage of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 2, patientWeightKg: 70 }))
        .toMatchObject({ totalUnits: 215, unit: "mg", quantityKind: "maximum" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("keeps the counted predecessor open for doses deferred by its weighted daily maximum", () => {
    const first = importCanonicalCourse({ doseAndRate: [{ doseQuantity: quantity(100, "mg") }],
      timing: { repeat: { count: 3, frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "14:00:00", "20:00:00"] } },
      maxDosePerPeriod: [{ numerator: quantity(3), denominator: quantity(1, "d") }],
    }).stages[0];
    const second = importCanonicalCourse({ doseAndRate: [{ doseQuantity: quantity(5, "mg") }],
      timing: { repeat: { count: 1, timeOfDay: ["09:00:00"] } } }).stages[0];
    const native = { kind: "course" as const, stages: [first, second] }, r6 = courseToR6(native);
    for (const dosage of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 2, patientWeightKg: 70 }))
        .toMatchObject({ totalUnits: 305, unit: "mg" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each(["coded rate", "unit rate", "ratio"] as const)(
    "keeps the infusion duration maximum after resolving a weighted %s", kind => {
      const infusion: FhirDosage = {
        doseAndRate: [kind === "ratio" ? { rateRatio: {
          numerator: { ...quantity(1), unit: "มิลลิกรัมต่อกิโลกรัม" }, denominator: quantity(2, "h") }
        } : { rateQuantity: kind === "coded rate"
          ? { ...quantity(0.5, "mg/kg/h"), unit: "มิลลิกรัมต่อกิโลกรัมต่อชั่วโมง" }
          : { value: 0.5, unit: "mg/kg/h", system: "urn:test:rate-display", code: "local-rate" } }],
        timing: { repeat: { count: 1, timeOfDay: ["08:00:00"], duration: 1, durationMax: 2,
          durationUnit: FhirPeriodUnit.Hour } },
      };
      const companion = { doseAndRate: [{ doseQuantity: quantity(0.1) }],
        timing: { repeat: { count: 1, timeOfDay: ["09:00:00"] } } };
      const native = { kind: "course" as const, stages: [{ administrations: [
        importCanonicalCourse(infusion).stages[0].administrations[0],
        importCanonicalCourse(companion).stages[0].administrations[0],
      ] }] }, r6 = courseToR6(native);
      for (const dosage of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
        const before = JSON.stringify(dosage);
        expect(calculateTotalUnits({ dosage, ...options }))
          .toMatchObject({ totalUnits: 1.1, unit: "mg/kg", quantityKind: "maximum" });
        expect(calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 }))
          .toMatchObject({ totalUnits: 77, unit: "mg", quantityKind: "maximum" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

});


describe("round67 reviewed execution boundaries", () => {
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z",
    timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day, limit: 4 };
  const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
  const views = (source: FhirR6DosageInstruction) => [
    courseFromR6(structuredClone(source)), structuredClone(source),
    JSON.parse(JSON.stringify(toFhirR5Dosages(source))),
  ];

  it("keeps free-text timing beside an executable upper supply frequency", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...dose,
      timing: { code: { text: "after dialysis" }, repeat: { frequencyMax: 2, period: 1,
        periodUnit: FhirPeriodUnit.Day, extension: [{
          url: "urn:ezmedicationinput:StructureDefinition:medication-timing-frequency-min", valueInteger: 0,
        }] } },
    }] }] };
    for (const dosage of views(source)) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...options }))
        .toMatchObject({ totalUnits: 2, unit: "tab", quantityKind: "maximum" });
      expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule)
        .toMatchObject({ code: { text: "after dialysis" }, recurrence: { frequency: 0, frequencyMax: 2 } });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([false, true])("finds the next two-year selector after its first eligible month (clocks=%s)", clocks => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...dose,
      timing: { repeat: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Year,
        ...(clocks ? { timeOfDay: ["09:00:00"] } : {}),
        extension: [{ url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt: 15 }],
      } },
    }] }] };
    const query = { ...options, orderedAt: "2026-01-01T09:00:00Z", from: "2026-02-01T00:00:00Z", limit: 1 };
    for (const dosage of views(source)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(["2028-01-15T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: FhirPeriodUnit.Year }))
        .toMatchObject({ totalUnits: 1, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([[2 / 7, FhirPeriodUnit.Week], [2, FhirPeriodUnit.Day]] as const)(
    "uses the same weekday-filtered two-day cadence for %s %s", (period, periodUnit) => {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...dose,
        timing: { repeat: { frequency: 1, period, periodUnit, dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday],
          timeOfDay: ["09:00:00"] } },
      }] }] };
      const query = { ...options, orderedAt: "2026-01-05T00:00:00Z", from: "2026-01-05T00:00:00Z", limit: 6 };
      const expected = ["2026-01-05", "2026-01-13", "2026-01-19", "2026-01-27", "2026-02-02", "2026-02-10"]
        .map(day => day + "T09:00:00+00:00");
      for (const dosage of views(source)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(expected);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 28 })).toMatchObject({ totalUnits: 4, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each([false, true])("closes only the predecessor's track for a mixed-dated successor (dated first=%s)", datedFirst => {
    const successor = datedFirst
      ? "instill 2 drops OD on 2026-12-05 at 08:00 and 1 drop OD at 20:00"
      : "instill 1 drop OD at 20:00 and 2 drops OD on 2026-12-05 at 08:00";
    const parsed = parseSig("Instill 1 drop OD QID, then " + successor + "; instill 1 drop OS BID");
    const native = parsed.meta.canonical.course!;
    const old = native.stages[0].administrations.find(member => member.schedule?.recurrence?.frequency === 4)!;
    expect(old.schedule?.recurrence?.calendarWindow?.end).toBe("2026-12-04");
    const left = native.stages[0].administrations.find(member => member.schedule?.recurrence?.frequency === 2)!;
    expect(left.schedule?.recurrence).toMatchObject({ frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day });
    expect(left.schedule?.recurrence?.calendarWindow).toBeUndefined();
    for (const dosage of [structuredClone(native), ...views(parsed.fhirNext)]) {
      const before = JSON.stringify(dosage);
      const query = { ...options, orderedAt: "2026-12-01T00:00:00Z" };
      for (const [day, totalUnits] of [["04", 6], ["05", 5], ["06", 3]] as const)
        expect(calculateTotalUnits({ dosage, ...query, from: "2026-12-" + day + "T00:00:00Z" }))
          .toMatchObject({ totalUnits, unit: "drop" });
      expect(nextDueDoses(dosage, { ...query, from: "2026-12-06T00:00:00Z", limit: 3 }))
        .toEqual(["2026-12-06T08:00:00+00:00", "2026-12-06T20:00:00+00:00", "2026-12-06T20:00:00+00:00"]);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([undefined, { count: 3 }, { frequency: 1, frequencyMax: 4, period: 1, periodUnit: FhirPeriodUnit.Day }])(
    "refuses conflicting standard cadences independently of coding order (%j)", repeat => {
      for (const codes of [["BID", "QID"], ["QID", "BID"]]) {
        const source: FhirR6DosageInstruction = { step: [{ component: [{ ...dose, timing: {
          code: { text: "authored schedule", coding: codes.map(code => ({
            system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code, display: "authored " + code,
          })) }, ...(repeat ? { repeat } : {}),
        } }] }] };
        for (const dosage of views(source)) {
          const before = JSON.stringify(dosage);
          expect(() => nextDueDoses(dosage, options)).toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
          expect(() => calculateTotalUnits({ dosage, ...options })).toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
          expect(JSON.stringify(dosage)).toBe(before);
        }
      }
    });

  it("keeps equivalent standard numeric cadences compatible", () => {
    for (const codes of [["BID", "Q12H"], ["Q12H", "BID"]]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...dose, timing: {
        code: { coding: codes.map(code => ({ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code })) },
        repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day },
      } }] }] };
      for (const dosage of views(source)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, options)).toHaveLength(4);
        expect(calculateTotalUnits({ dosage, ...options })).toMatchObject({ totalUnits: 2, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    }
  });
});

describe("round69 review calendar, allowance, and next-day ownership", () => {
  const options = {
    orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
    timeZone: "UTC", limit: 10
  };
  const member = (): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["09:00:00"] } }
  });
  const forms = (course: CanonicalCourse) => [
    structuredClone(course),
    JSON.parse(JSON.stringify(courseToR6(course))) as FhirR6DosageInstruction,
    JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[]
  ];

  it("uses month days with weekday filters while preserving an authored ordinal", () => {
    for (const [monthDays, weekdayOrdinal, expected, total] of [
      [[15], undefined, "2026-01-15T09:00:00+00:00", 1],
      [[15], 3, "2026-01-15T09:00:00+00:00", 1],
      [[17], undefined, "2026-02-17T09:00:00+00:00", 0],
      [[8], undefined, "2026-01-08T09:00:00+00:00", 1],
      [[8], 3, undefined, 0],
      [undefined, undefined, "2026-01-01T09:00:00+00:00", 5]
    ] as const) {
      const dose = member();
      dose.schedule!.recurrence = {
        period: 1, periodUnit: FhirPeriodUnit.Month, clocks: ["09:00:00"],
        dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday, FhirDayOfWeek.Wednesday,
          FhirDayOfWeek.Thursday, FhirDayOfWeek.Friday],
        monthDays: monthDays ? [...monthDays] : undefined, weekdayOrdinal
      };
      for (const dosage of forms({ kind: "course", stages: [{ administrations: [dose] }] })) {
        const before = JSON.stringify(dosage);
        expect(importCanonicalCourse(dosage).stages[0].administrations[0].schedule?.recurrence?.weekdayOrdinal)
          .toBe(weekdayOrdinal);
        expect(nextDueDoses(dosage, { ...options, limit: 1 })).toEqual(expected ? [expected] : []);
        expect(calculateTotalUnits({
          ...options, dosage, durationValue: 18, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(total);
        expect(JSON.stringify(dosage)).toBe(before);
      }
    }
  });

  it("spends supplied history on the sole PRN allowance in a single cycle", () => {
    const dose = member();
    dose.asNeeded = true;
    dose.schedule!.recurrence!.countMax = 2;
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" },
      cycleCount: 1, stages: [{ administrations: [dose] }] };
    for (const dosage of forms(course)) {
      const before = JSON.stringify(dosage);
      for (const priorCount of [undefined, 1, 2]) {
        const query = { ...options, from: "2026-01-02T00:00:00Z", priorCount };
        const expected = ["2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00"].slice(0, 2 - (priorCount ?? 0));
        expect(nextDueDoses(dosage, query)).toEqual(expected);
        expect(calculateTotalUnits({
          ...query, dosage, durationValue: 5, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(expected.length);
      }
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("spends an explicit event count after civil-cap admission and retains a true single instant", () => {
    const dose = member();
    dose.schedule = {
      explicitEvents: ["2026-01-01T10:00:00Z", "2026-01-02T10:00:00Z"],
      recurrence: { count: 1, occurrenceCap: { max: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    };
    const query = { ...options, orderedAt: "2026-01-01T09:00:00Z", from: "2026-01-01T09:00:00Z",
      priorDoseTimes: ["2026-01-01T08:00:00Z"] };
    for (const events of [true, false]) {
      const source = structuredClone(dose);
      if (!events) delete source.schedule!.explicitEvents;
      for (const dosage of forms({ kind: "course", stages: [{ administrations: [source] }] })) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(events ? ["2026-01-02T10:00:00+00:00"] : []);
        expect(calculateTotalUnits({
          ...query, dosage, durationValue: 2, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(events ? 1 : 0);
        expect(JSON.stringify(dosage)).toBe(before);
      }
    }
  });

  it.each([true, false])("keeps explicit next-day onset open while plain NEXT remains finite: %s", starting => {
    const parsed = parseSig("Take 1 tablet at 08:00 and 20:00 " + (starting ? "starting " : "") + "the next day");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(starting ? undefined : 2);
    const expected = ["2026-01-02", "2026-01-03"].flatMap(day =>
      ["08:00", "20:00"].map(clock => day + "T" + clock + ":00+00:00"));
    for (const dosage of forms(parsed.meta.canonical.course!)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, limit: 4 })).toEqual(starting ? expected : expected.slice(0, 2));
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 5, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(starting ? 8 : 2);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("keeps a next-day infusion's one-day bound after inherited clock resolution", () => {
    const parsed = parseSig(
      "Infuse 100 mL over 30 minutes at 08:00 and 20:00 for 3 days, then infuse 50 mL over 15 minutes the next day at the same times"
    );
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({
      duration: 1, durationUnit: "d", administrationDuration: 15, administrationDurationUnit: "min"
    });
    const expected = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"].flatMap(day =>
      ["08:00", "20:00"].map(clock => day + "T" + clock + ":00+00:00"));
    for (const dosage of forms(parsed.meta.canonical.course!)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, options)).toEqual(expected);
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 5, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(700);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each(["at 08:00 on Mondays", "every 2 days at 08:00"])(
    "keeps NEXT dependent on an unbounded independently recurring predecessor: %s", cadence => {
      const parsed = parseSig("Take 1 tablet " + cadence + ", then 2 tablets at 06:00 the next morning");
      expect(parsed.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
      expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).toBe("previous-phase-next-day");
      expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBeUndefined();
      for (const dosage of forms(parsed.meta.canonical.course!)) {
        const before = JSON.stringify(dosage);
        const query = { ...options, orderedAt: "2026-12-04T00:00:00Z", from: "2026-12-04T00:00:00Z" };
        const dates = cadence.includes("Mondays")
          ? ["2026-12-07", "2026-12-14", "2026-12-21"]
          : ["2026-12-04", "2026-12-06", "2026-12-08"];
        expect(nextDueDoses(dosage, { ...query, limit: 3 })).toEqual(
          dates.map(day => day + "T08:00:00+00:00"));
        expect(calculateTotalUnits({ ...query, dosage, durationValue: 5, durationUnit: FhirPeriodUnit.Day }).totalUnits)
          .toBe(cadence.includes("Mondays") ? 1 : 3);
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });
});


describe("round72 reviewed calendar windows and rounding ownership", () => {
  const member = (): CanonicalAdministration => ({ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }] });
  const forms = (course: CanonicalCourse) => [
    structuredClone(course),
    JSON.parse(JSON.stringify(courseToR6(course))) as FhirR6DosageInstruction,
    JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[]
  ];

  it.each([true, false])("keeps the calendar cadence inside its resolved waking window: event window %s", eventWindow => {
    const dose = member();
    dose.schedule = { recurrence: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Day,
      ...(eventWindow ? { eventWindow: { start: EventTiming.Wake, end: EventTiming["Before Sleep"] } }
        : { clockWindow: { start: "08:00:00", end: "22:00:00", endInclusive: false } })
    } };
    const options = { orderedAt: "2026-12-01T12:00:00Z", from: "2026-12-01T12:00:00Z",
      timeZone: "UTC", eventClock: { WAKE: "08:00", HS: "22:00" }, limit: 3 };
    for (const dosage of forms({ kind: "course", stages: [{ administrations: [dose] }] })) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, options)).toEqual([
        "2026-12-03T08:00:00+00:00", "2026-12-05T08:00:00+00:00", "2026-12-07T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 5, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 2, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday])("counts only actual supply contributors in a repeated-course rounding ceiling: %s", weekday => {
    const capped = member(), uncapped = member();
    capped.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } };
    capped.limits = [
      { scope: "lifetime", amount: { value: 3, unit: "tab" } },
      { scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }
    ];
    uncapped.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      dayOfWeek: [weekday], clocks: ["09:00:00"] } };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 3,
      stages: [{ administrations: [capped, uncapped] }] };
    for (const dosage of forms(course)) {
      const before = JSON.stringify(dosage);
      const result = calculateTotalUnits({ dosage, orderedAt: "2026-11-30T00:00:00Z", from: "2026-12-01T00:00:00Z",
        timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day, roundToMultiple: 5 });
      expect(result).toMatchObject({ totalUnits: weekday === FhirDayOfWeek.Monday ? 3 : 5, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });
});


describe("round77 weight quantity unit ownership", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const note = { url: "urn:clinic:quantity-note", valueString: "Preserve the authored quantity" };
  const quantity = (value: number, unit: string, local = true) => ({
    value, unit, system: local ? "urn:clinic:medication-units" : "http://unitsofmeasure.org",
    code: local ? "weight-dose" : unit, extension: [note],
  });
  const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
    timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day };
  const daily = { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
    timeOfDay: ["08:00:00", "20:00:00"] };
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([fresh(row)]);
    return [fresh(row), importCanonicalCourse(fresh(row)), fresh(r6), fresh(toFhirR5Dosages(fresh(r6)))];
  };

  it.each([
    ["quantity", 140], ["range", 280], ["ratio", 140], ["rate", 140], ["maximum", 100],
  ] as const)("resolves the authored weight unit beside an opaque local %s code", (kind, expected) => {
    const row: FhirDosage = {
      doseAndRate: [kind === "range" ? { doseRange: {
        low: quantity(1, "mg/kg"), high: quantity(2, "mg/kg"),
      } } : kind === "ratio" ? { rateRatio: {
        numerator: quantity(1, "mg/kg"), denominator: quantity(2, "h", false),
      } } : kind === "rate" ? { rateQuantity: quantity(0.5, "mg/kg/h") }
        : { doseQuantity: kind === "maximum" ? quantity(100, "mg", false) : quantity(1, "mg/kg") }],
      timing: { repeat: { ...daily, ...(kind === "ratio" || kind === "rate"
        ? { duration: 2, durationUnit: FhirPeriodUnit.Hour } : {}) } },
      ...(kind === "maximum" ? { maxDosePerPeriod: [{
        numerator: quantity(1.5, "mg/kg"), denominator: quantity(1, "d", false),
      }] } : {}),
    };
    for (const dosage of forms(row)) {
      const before = fresh(dosage);
      expect(calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 }))
        .toMatchObject({ totalUnits: expected, unit: "mg" });
      if (kind !== "maximum") expect(calculateTotalUnits({ dosage, ...options }))
        .toMatchObject({ totalUnits: kind === "range" ? 4 : 2, unit: "mg/kg" });
      expect(dosage).toEqual(before);
    }
    const saved = toFhirR5Dosages(fresh(toDosageDetails([fresh(row)])))[0];
    expect(saved.doseAndRate).toEqual(row.doseAndRate);
    expect(saved.maxDosePerPeriod).toEqual(row.maxDosePerPeriod);
  });


  it.each(["urn:clinic:medication-units", "http://standardterms.edqm.eu",
    "http://spor.ema.europa.eu/v1/lists/200000000014"])(
    "does not give an opaque code-only quantity a weight dimension: %s", system => {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: {
        value: 1, system, code: "mg/kg", extension: [note],
      } }], timing: { repeat: daily } };
      for (const dosage of forms(row)) {
        const before = fresh(dosage);
        expect(calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 }))
          .toMatchObject({ totalUnits: 2, unit: "mg/kg" });
        expect(dosage).toEqual(before);
      }
      expect(toFhirR5Dosages(fresh(toDosageDetails([fresh(row)])))[0].doseAndRate).toEqual(row.doseAndRate);
    });


  it("keeps a code-only foreign infusion dimension unresolved", () => {
    const row: FhirDosage = { doseAndRate: [{ rateQuantity: {
      value: 0.5, system: "urn:clinic:medication-units", code: "mg/kg/h", extension: [note],
    } }], timing: { repeat: { ...daily, duration: 2, durationUnit: FhirPeriodUnit.Hour } } };
    for (const dosage of forms(row)) {
      const before = fresh(dosage);
      expect(() => calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 }))
        .toThrow(expect.objectContaining({ code: "rate-units-unresolved" }));
      expect(dosage).toEqual(before);
    }
    expect(toFhirR5Dosages(fresh(toDosageDetails([fresh(row)])))[0].doseAndRate).toEqual(row.doseAndRate);
  });

  it.each(["quantity", "rate"] as const)("retains a UCUM compound %s outside the simple unit lexicon", kind => {
    const row: FhirDosage = { doseAndRate: [kind === "quantity" ? { doseQuantity: {
      ...quantity(1, "millimoles per kilogram", false), code: "mmol/kg",
    } } : { rateQuantity: {
      ...quantity(0.5, "millimoles per kilogram per hour", false), code: "mmol/kg/h",
    } }], timing: { repeat: { ...daily, ...(kind === "rate"
      ? { duration: 2, durationUnit: FhirPeriodUnit.Hour } : {}) } } };
    for (const dosage of forms(row)) {
      const before = fresh(dosage);
      expect(calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 }))
        .toMatchObject({ totalUnits: 140, unit: "mmol" });
      expect(dosage).toEqual(before);
    }
    expect(toFhirR5Dosages(fresh(toDosageDetails([fresh(row)])))[0].doseAndRate).toEqual(row.doseAndRate);
  });

  it.each(["mg", "clinic units"])("does not interpret a foreign weight-shaped code over the authored %s unit", unit => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: {
      ...quantity(1, unit), code: "mg/kg",
    } }], timing: { repeat: daily } };
    for (const dosage of forms(row)) {
      const before = fresh(dosage);
      expect(calculateTotalUnits({ dosage, ...options, patientWeightKg: 70 }))
        .toMatchObject({ totalUnits: 2, unit });
      expect(dosage).toEqual(before);
    }
    expect(toFhirR5Dosages(fresh(toDosageDetails([fresh(row)])))[0].doseAndRate).toEqual(row.doseAndRate);
  });
});
