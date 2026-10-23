import { describe, expect, it } from "vitest";
import {
  calculateTotalUnits, nextDueDoses, parseSig, toDosageDetails,
  toFhirR5Dosages, fromFhir, FhirDayOfWeek, FhirPeriodUnit
} from "../src";
import type { CanonicalScheduleExpr, FhirDosage, FhirR6DosageDetails } from "../src";
import { canonicalToFhir } from "../src/fhir";

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

  it("preserves a recurring on/off cycle through flat FHIR JSON persistence", () => {
    const parsed = parseSig("1 tab daily for 7 days then stop for 7 days repeat");
    const flat = JSON.parse(JSON.stringify(parsed.fhir));
    expect(toDosageDetails(flat).repeatCycle).toMatchObject({
      value: 14, unit: "d", code: "d"
    });
    expect(nextDueDoses(flat, { ...base, limit: 10 })).toEqual(
      nextDueDoses(parsed.fhirNext, { ...base, limit: 10 })
    );
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
