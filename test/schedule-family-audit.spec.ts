import { describe, expect, it } from "vitest";
import {
  calculateTotalUnits, formatSig, lintSig, nextDueDoses, parseSig, parseSigAsync, suggestSig, toDosageDetails,
  MedicationQuantityCalculationError,
  toFhirR5Dosages, fromFhir, getDosageExcludedWeekdays,
  EventTiming, FhirDayOfWeek, FhirPeriodUnit
} from "../src";
import type { CanonicalScheduleExpr, FhirDosage, FhirR6DosageDetails } from "../src";
import { canonicalToFhir } from "../src/fhir";
import { parseClauseState } from "../src/parser";
import { createBoundaryPlan } from "../src/regimen/planner";
import { buildRegimenGraph } from "../src/regimen/regimen";
import { recognizeCycles } from "../src/hpsg/rules/timing-rules";

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
      period: 1, periodUnit: "d", timeOfDay: schedule.timeOfDay,
      when: [EventTiming["Before Sleep"]]
    });
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
    const details: FhirR6DosageDetails = {
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
    expect(parsed.fhirNext).toMatchObject({
      repeatCycle: { value: 14, unit: "d", code: "d" },
      step: [{ count: 3 }]
    });
    const flat = JSON.parse(JSON.stringify(parsed.fhir));
    expect(toDosageDetails(flat)).toMatchObject({
      repeatCycle: { value: 14, unit: "d", code: "d" },
      step: [{ count: 3 }]
    });
    expect(nextDueDoses(flat, { ...base, limit: 10 })).toEqual(
      nextDueDoses(parsed.fhirNext, { ...base, limit: 10 })
    );

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
  dosage: FhirR6DosageDetails | readonly FhirDosage[],
  localDate: string
): string[] {
  return nextDueDoses(dosage, {
    ...parkinsonDue,
    from: `${localDate}T00:00:00+07:00`
  }).filter(timestamp => timestamp.startsWith(localDate));
}

function totalUnitsOver21Days(
  dosage: FhirR6DosageDetails | readonly FhirDosage[]
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
  const dueOn = (regimen: FhirR6DosageDetails | FhirDosage[], date: string) =>
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
  const daily = (regimen: FhirR6DosageDetails | FhirDosage[], date: string) =>
    nextDueDoses(regimen, {
      ...options, from: date + "T00:00:00+07:00", limit: 16
    }).filter(time => time.startsWith(date)).map(time => time.slice(11, 16));
  const perClockDose = (step: FhirR6DosageDetails["step"][number]) =>
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
  const due = (course: FhirR6DosageDetails | FhirDosage[], date: string) =>
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
  const times = (regimen: FhirR6DosageDetails | FhirDosage[], day: string) =>
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
  const clocks = (dosage: FhirR6DosageDetails | FhirDosage[], date: string) => nextDueDoses(dosage, {
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
