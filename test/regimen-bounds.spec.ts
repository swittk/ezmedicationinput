import { describe, expect, it } from "vitest";
import {
  calculateTotalUnits,
  FhirDayOfWeek,
  FhirPeriodUnit,
  nextDueDoses
} from "../src";
import { canonicalToFhir } from "../src/fhir";
import type { CanonicalScheduleExpr, FhirDosage } from "../src";

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
